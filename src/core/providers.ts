/**
 * The three headless agent CLIs an agent can run on, and how autonomy is
 * enforced on each.
 *
 * A provider answers four questions for the runner, which otherwise knows
 * nothing about any CLI:
 *
 *   plan     the binary, its arguments, and what to feed it on stdin
 *   parse    how one line of its stdout becomes run events and cost
 *   enforce  what the autonomy level turns into: the control, in words
 *   bill     which account a run will draw on
 *
 * The enforcement differs in kind, and the dashboard says so rather than
 * flattening it to one word:
 *
 *   claude   `--allowed-tools` is a tool allowlist applied by the claude
 *            process. An observe agent has no Write tool. Attempts outside
 *            the list come back in `permission_denials`.
 *
 *   codex    `--sandbox` is an OS-level sandbox applied to every command the
 *            model runs, with approvals off so nothing can be waved through.
 *            read-only means the filesystem cannot be written and the network
 *            is closed. workspace-write opens the working tree. Codex has no
 *            per-tool allowlist, so observe and propose both map to read-only
 *            and the prompt wording is what separates "report" from "draft a
 *            change". The sandbox stops the write either way. A denied
 *            command surfaces as a failed command_execution item whose output
 *            names the sandbox. That is the denial signal here.
 *
 *   gemini   `--mode plan` is the CLI's read-only mode, for observe and
 *            propose. `--mode accept-edits` approves file edits for execute
 *            and autonomous. Commands nobody can approve are soft-denied.
 *
 * No provider is asked nicely. Every control is applied by the child
 * process regardless of what the model decides to do.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

import { effectiveTools, policyFor } from "./autonomy.js";
import type { AutonomyLevel, Provider } from "./types.js";

export type { Provider } from "./types.js";
export { PROVIDERS } from "./types.js";

// ---------------------------------------------------------------------------
// Events a provider's stdout produces
// ---------------------------------------------------------------------------

/** What the parser hands back for the run pane. A subset of the runner's RunEvent. */
export type ParseEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; summary: string }
  | { type: "denied"; tool: string };

/**
 * Running totals the parser maintains across lines. The runner reads these
 * when the process closes to settle the ledger entry.
 */
export type ParseState = {
  /** The agent's prose, accumulated. */
  text: string;
  /** Dollar figure the process itself reported, when it does. */
  settledCostUsd: number | null;
  /** Token totals the process itself reported, when it does. */
  settledInput: number | null;
  settledOutput: number | null;
  /** Token totals summed from streamed turns, for a run that never settles. */
  streamedInput: number;
  streamedOutput: number;
  streamedCachedInput: number;
  sawUsage: boolean;
  denials: string[];
  /** An error the process reported in-band, such as turn.failed or error items. */
  error: string | null;
  /** Provider-specific scratch: codex item ids already announced, etc. */
  seen: Set<string>;
  /** The CLI's own session id, so a follow-up turn can resume it. */
  sessionId: string | null;
};

export function newParseState(): ParseState {
  return {
    text: "",
    settledCostUsd: null,
    settledInput: null,
    settledOutput: null,
    streamedInput: 0,
    streamedOutput: 0,
    streamedCachedInput: 0,
    sawUsage: false,
    denials: [],
    error: null,
    seen: new Set(),
    sessionId: null,
  };
}

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

/**
 * The `org` MCP server for one run: how to start it. Each provider wires it
 * in its own way; the tool names are what an allowlist needs.
 */
export type CollabServer = {
  name: string;
  command: string;
  args: string[];
  /** Tool names the server exposes, without any provider prefix. */
  tools: readonly string[];
};

export type RunPlan = {
  binary: string;
  args: string[];
  /** Written to the child's stdin, then closed. Null leaves stdin ignored. */
  stdin: string | null;
  /**
   * What is enforced on this run, one item per line of the pane's `grants`
   * row. For claude this is the tool allowlist. For codex it names the
   * sandbox mode and the approval policy. Recorded on `delegate_start`.
   */
  enforcement: string[];
};

export type ProviderSpec = {
  id: Provider;
  /** Short label for rows: "claude", "codex", "gemini". */
  label: string;
  /** The command a run is, in three words: "claude -p", "codex exec", "agy -p". */
  headless: string;
  /** The binary the runner spawns. `CEO_<ID>_BIN` overrides it, for stubs. */
  binary: () => string;
  /** Models the hire form cycles through. The first is the default. */
  models: () => string[];
  defaultModel: () => string;
  /** Whether the process reports a settled dollar figure of its own. */
  reportsCost: boolean;
  /** Basis recorded on delegate_end when the cost is computed, not reported. */
  estimateBasis: string;
  plan: (input: {
    task: string;
    systemPrompt: string;
    model: string;
    autonomy: AutonomyLevel;
    agentTools: string[];
    /** The org MCP server, when this run gets the collaboration tools. */
    collab?: CollabServer | null;
  }) => RunPlan;
  /**
   * A follow-up turn: resume the session the first turn opened and send one
   * more prompt. The same output format, the same enforcement; the CLI
   * carries the conversation.
   */
  resumePlan: (input: {
    sessionId: string;
    prompt: string;
    model: string;
    autonomy: AutonomyLevel;
    agentTools: string[];
    collab?: CollabServer | null;
  }) => RunPlan;
  /** Fold one parsed stdout line into `state` and return events for the pane. */
  parse: (msg: Record<string, unknown>, state: ParseState) => ParseEvent[];
  /** One line for the dashboard: how this level is enforced on this provider. */
  enforcementLabel: (autonomy: AutonomyLevel, agentTools: string[]) => string;
};

function envBinary(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

function summarizeInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return name;
  const o = input as Record<string, unknown>;
  // The org tools name a teammate, which is the useful part of the line.
  const first = o.file_path ?? o.path ?? o.pattern ?? o.command ?? o.url ?? o.prompt ?? o.query ?? o.to ?? o.agent;
  if (typeof first === "string") {
    return `${name} ${first.length > 60 ? first.slice(0, 57) + "…" : first}`;
  }
  return name;
}

function head(s: string, n = 60): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

const CLAUDE_MODELS = ["claude-sonnet-5", "claude-opus-4-7", "claude-haiku-4-5"];

export const claude: ProviderSpec = {
  id: "claude",
  label: "claude",
  headless: "claude -p",
  binary: () => envBinary("CEO_CLAUDE_BIN", "claude"),
  models: () => CLAUDE_MODELS,
  defaultModel: () => CLAUDE_MODELS[0],
  reportsCost: true,
  estimateBasis: "anthropic-list-price",

  plan({ task, systemPrompt, model, autonomy, agentTools, collab }) {
    const tools = effectiveTools(autonomy, agentTools);
    // The org tools ride in as one MCP server, named in the allowlist by
    // their full names. --strict-mcp-config keeps the person's own MCP
    // servers out of an agent's run: an agent gets the org, not the desk.
    const orgTools = collab ? collab.tools.map((t) => `mcp__${collab.name}__${t}`) : [];
    const mcp = collab ? JSON.stringify({ mcpServers: { [collab.name]: { command: collab.command, args: collab.args } } }) : null;
    return {
      binary: claude.binary(),
      args: [
        "-p", task,
        "--append-system-prompt", systemPrompt,
        "--allowed-tools", ...tools, ...orgTools,
        "--model", model,
        "--output-format", "stream-json",
        "--verbose",
        ...(mcp ? ["--mcp-config", mcp, "--strict-mcp-config"] : []),
      ],
      stdin: null,
      enforcement: [...tools, ...(collab ? [`org tools (${collab.tools.length})`] : [])],
    };
  },

  resumePlan({ sessionId, prompt, model, autonomy, agentTools, collab }) {
    const first = claude.plan({ task: prompt, systemPrompt: "", model, autonomy, agentTools, collab });
    // The system prompt is already in the session; only the allowlist, the
    // model and the org server need restating.
    const args = first.args.filter((a, i, all) => !(a === "--append-system-prompt" || all[i - 1] === "--append-system-prompt"));
    return { ...first, args: [...args, "--resume", sessionId] };
  },
  parse(msg, st) {
    if (typeof msg.session_id === "string" && msg.session_id) st.sessionId = msg.session_id;
    const out: ParseEvent[] = [];
    if (msg.type === "assistant") {
      // Per-turn usage as it streams. The final `result` carries the
      // authoritative total, but a cancelled run never produces one, and its
      // tokens were billed regardless.
      const usage = (msg.message as { usage?: Record<string, number> } | undefined)?.usage;
      if (usage) {
        st.streamedInput += Number(usage.input_tokens ?? 0) || 0;
        st.streamedOutput += Number(usage.output_tokens ?? 0) || 0;
        st.streamedCachedInput += Number(usage.cache_read_input_tokens ?? 0) || 0;
        st.sawUsage = true;
      }
      const content = (msg.message as { content?: unknown[] } | undefined)?.content ?? [];
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string") {
          st.text += block.text;
          out.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          const name = String(block.name ?? "tool");
          out.push({ type: "tool", name, summary: summarizeInput(name, block.input) });
        }
      }
    } else if (msg.type === "result") {
      st.settledCostUsd = Number(msg.total_cost_usd ?? 0) || 0;
      const usage = (msg.usage ?? {}) as Record<string, number>;
      st.settledInput = Number(usage.input_tokens ?? 0) || 0;
      st.settledOutput = Number(usage.output_tokens ?? 0) || 0;
      if (typeof msg.result === "string" && msg.result.trim()) st.text = msg.result;
      if (msg.is_error === true && typeof msg.result === "string") st.error = msg.result;
      // Attempts the allowlist blocked. Recorded rather than ignored: an
      // agent reaching for a tool its level forbids is exactly the drift an
      // audit should surface, and it is invisible otherwise.
      const pd = msg.permission_denials;
      if (Array.isArray(pd)) {
        for (const d of pd as Array<Record<string, unknown>>) {
          const name = String(d.tool_name ?? d.tool ?? "unknown");
          st.denials.push(name);
          out.push({ type: "denied", tool: name });
        }
      }
    }
    return out;
  },

  enforcementLabel(autonomy, agentTools) {
    return `--allowed-tools ${effectiveTools(autonomy, agentTools).join(", ")}`;
  },
};

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

const CODEX_MODELS = ["gpt-5-codex", "gpt-5", "gpt-5-mini"];

/** `model = "..."` from ~/.codex/config.toml, so the hire form offers what codex itself defaults to. */
export function codexConfiguredModel(): string | null {
  const home = process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  try {
    const toml = readFileSync(path.join(home, "config.toml"), "utf8");
    const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(toml);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export type CodexSandbox = "read-only" | "workspace-write";

/**
 * Autonomy to sandbox. The two read-only levels collapse: codex cannot grant
 * "run commands but do not write" any more finely than a read-only
 * filesystem, which is the stronger of the two anyway. `autonomous` gets the
 * same sandbox as `execute`. The difference between them is merge rights,
 * which CEO holds, not the process.
 */
export function codexSandboxFor(autonomy: AutonomyLevel): CodexSandbox {
  return policyFor(autonomy).canWrite ? "workspace-write" : "read-only";
}

/**
 * A TOML basic string. JSON's escapes are a subset of TOML's except for
 * `\/`, which JSON.stringify never emits, so this is exact.
 */
export function tomlString(s: string): string {
  return JSON.stringify(s);
}

const SANDBOX_DENIAL = /denied by sandbox|operation not permitted|read-only file system|permission denied/i;

export const codex: ProviderSpec = {
  id: "codex",
  label: "codex",
  headless: "codex exec",
  binary: () => envBinary("CEO_CODEX_BIN", "codex"),
  models: () => {
    const configured = codexConfiguredModel();
    return configured && !CODEX_MODELS.includes(configured)
      ? [configured, ...CODEX_MODELS]
      : CODEX_MODELS;
  },
  defaultModel: () => codex.models()[0],
  reportsCost: false,
  estimateBasis: "openai-list-price",

  plan({ task, systemPrompt, model, autonomy, collab }) {
    const sandbox = codexSandboxFor(autonomy);
    // The org server goes in through codex's own config overrides, one
    // dotted key per field, each value a TOML literal.
    const mcp = collab
      ? [
          "-c", `mcp_servers.${collab.name}.command=${tomlString(collab.command)}`,
          "-c", `mcp_servers.${collab.name}.args=[${collab.args.map(tomlString).join(", ")}]`,
        ]
      : [];
    return {
      binary: codex.binary(),
      args: [
        "exec",
        "--json",
        "--color", "never",
        "--skip-git-repo-check",
        "--model", model,
        "--sandbox", sandbox,
        ...mcp,
        // Never ask: there is nobody at the keyboard of a headless run, and
        // a prompt that waited for one would hang the dispatcher.
        "-c", 'approval_policy="never"',
        // The compiled prompt rides in as developer instructions, the
        // nearest thing codex has to --append-system-prompt.
        "-c", `developer_instructions=${tomlString(systemPrompt)}`,
        // Read the task from stdin so a task beginning with "-" is never
        // mistaken for a flag.
        "-",
      ],
      stdin: task,
      enforcement: [`sandbox ${sandbox}`, "approvals never", ...(collab ? [`org tools (${collab.tools.length})`] : [])],
    };
  },

  resumePlan({ sessionId, prompt, model, autonomy, agentTools, collab }) {
    const first = codex.plan({ task: prompt, systemPrompt: "", model, autonomy, agentTools, collab });
    // `codex exec resume <id> … -` keeps every flag of a fresh exec; the
    // developer instructions are already on the thread.
    const rest = first.args
      .slice(1)
      .filter((a, i, all) => !(a.startsWith("developer_instructions=") || (a === "-c" && String(all[i + 1]).startsWith("developer_instructions="))));
    const dash = rest.pop();
    return { ...first, args: ["exec", "resume", sessionId, ...rest, dash ?? "-"] };
  },
  parse(msg, st) {
    const out: ParseEvent[] = [];
    if (msg.type === "thread.started" && typeof msg.thread_id === "string") st.sessionId = msg.thread_id;
    const type = String(msg.type ?? "");

    if (type === "item.started" || type === "item.updated" || type === "item.completed") {
      const item = (msg.item ?? {}) as Record<string, unknown>;
      const id = String(item.id ?? "");
      const kind = String(item.type ?? "");

      if (kind === "command_execution") {
        const command = String(item.command ?? "");
        if (id && !st.seen.has(id)) {
          st.seen.add(id);
          out.push({ type: "tool", name: "shell", summary: `shell ${head(command)}` });
        }
        if (type === "item.completed") {
          const output = String(item.aggregated_output ?? "");
          const status = String(item.status ?? "");
          if (status === "declined" || SANDBOX_DENIAL.test(output)) {
            const tool = `shell: ${head(command, 40)}`;
            st.denials.push(tool);
            out.push({ type: "denied", tool });
          }
        }
        return out;
      }

      if (type !== "item.completed") return out;

      if (kind === "agent_message") {
        const text = String(item.text ?? "");
        if (text) {
          // Each item is a whole message, not a streamed fragment, so it
          // ends its line. Otherwise consecutive messages run together.
          st.text += (st.text ? "\n" : "") + text;
          out.push({ type: "text", text: text.endsWith("\n") ? text : `${text}\n` });
        }
      } else if (kind === "file_change") {
        const changes = Array.isArray(item.changes) ? (item.changes as Array<Record<string, unknown>>) : [];
        const paths = changes.map((c) => String(c.path ?? "")).filter(Boolean);
        out.push({ type: "tool", name: "edit", summary: `edit ${head(paths.join(", ") || "(files)")}` });
      } else if (kind === "mcp_tool_call") {
        const name = `${item.server ?? "mcp"}.${item.tool ?? "tool"}`;
        out.push({ type: "tool", name, summary: summarizeInput(name, item.arguments) });
      } else if (kind === "web_search") {
        out.push({ type: "tool", name: "web_search", summary: `search ${head(String(item.query ?? ""))}` });
      } else if (kind === "error") {
        const message = String(item.message ?? "error");
        if (SANDBOX_DENIAL.test(message)) {
          const tool = `write: ${head(message, 40)}`;
          st.denials.push(tool);
          out.push({ type: "denied", tool });
        } else {
          st.error = message;
          out.push({ type: "text", text: `[error] ${message}` });
        }
      }
      return out;
    }

    if (type === "turn.completed") {
      const usage = (msg.usage ?? {}) as Record<string, number>;
      st.streamedInput += Number(usage.input_tokens ?? 0) || 0;
      st.streamedCachedInput += Number(usage.cached_input_tokens ?? 0) || 0;
      st.streamedOutput += Number(usage.output_tokens ?? 0) || 0;
      st.sawUsage = true;
      // codex reports tokens, never dollars: settledInput/Output are set so
      // the runner treats the totals as final. settledCostUsd stays null so
      // the figure is computed and marked as an estimate.
      st.settledInput = st.streamedInput;
      st.settledOutput = st.streamedOutput;
      return out;
    }

    if (type === "turn.failed" || type === "error") {
      const err = (msg.error ?? msg) as Record<string, unknown>;
      st.error = String(err.message ?? "codex reported a failure");
      out.push({ type: "text", text: `[error] ${st.error}` });
    }
    return out;
  },

  enforcementLabel(autonomy) {
    return `--sandbox ${codexSandboxFor(autonomy)}, approvals never`;
  },
};

// ---------------------------------------------------------------------------
// gemini, through the Antigravity CLI
// ---------------------------------------------------------------------------

/**
 * Gemini agents run through `agy`, the Antigravity CLI, which replaced the
 * individual tier of Gemini CLI in 2026. Headless mode is `agy -p` with
 * `--output-format stream-json`, which emits one `init` event, a
 * `step_update` per step, and a final `result` with token usage.
 *
 * What the level becomes here:
 *
 *   observe, propose   `--mode plan`: the CLI's read-only mode.
 *   execute, autonomous `--mode accept-edits`: file edits are approved;
 *                      shell commands still need approval, and in headless
 *                      mode a tool nobody can approve is soft-denied, which
 *                      is the denial signal CEO reads. Commands an org
 *                      wants allowed go in the CLI's own `permissions.allow`
 *                      rules; CEO does not pass `--dangerously-skip-permissions`.
 *
 * `--sandbox` adds the CLI's terminal sandbox when CEO_GEMINI_SANDBOX is set;
 * it is not on by default because it depends on what the machine can run.
 *
 * There is no system-prompt flag, so the compiled brief rides ahead of the
 * task in the prompt itself. The CLI picks its own default model when the
 * agent's model is the bare word "gemini"; `agy models` lists the slugs.
 *
 * Built from the CLI's documentation and its own `--help`, with the one
 * real event shape confirmed being `result`. The stub under tools/ speaks
 * the same protocol so the runner spec covers it for $0.
 */

const GEMINI_DEFAULT = "gemini";
const GEMINI_MODELS = [GEMINI_DEFAULT, "gemini-2.5-pro", "gemini-2.5-flash"];

export type GeminiMode = "plan" | "accept-edits";

export function geminiModeFor(autonomy: AutonomyLevel): GeminiMode {
  return policyFor(autonomy).canWrite ? "accept-edits" : "plan";
}

const GEMINI_DENIAL = /denied|permission|not allowed|requires approval|not permitted|rejected/i;

function geminiStep(msg: Record<string, unknown>): Record<string, unknown> {
  const inner = msg.step;
  return inner && typeof inner === "object" ? (inner as Record<string, unknown>) : msg;
}

export const gemini: ProviderSpec = {
  id: "gemini",
  label: "gemini",
  headless: "agy -p",
  binary: () => envBinary("CEO_GEMINI_BIN", "agy"),
  models: () => GEMINI_MODELS,
  defaultModel: () => GEMINI_DEFAULT,
  reportsCost: false,
  estimateBasis: "google-list-price",

  plan({ task, systemPrompt, model, autonomy, collab }) {
    const mode = geminiModeFor(autonomy);
    const sandbox = Boolean(process.env.CEO_GEMINI_SANDBOX?.trim());
    const prompt = systemPrompt.trim() ? `${systemPrompt.trim()}\n\n---\n\nThe task:\n\n${task}` : task;
    return {
      binary: gemini.binary(),
      args: [
        "-p", prompt,
        "--output-format", "stream-json",
        "--mode", mode,
        "--disable-slash-commands",
        ...(model && model !== GEMINI_DEFAULT ? ["--model", model] : []),
        ...(sandbox ? ["--sandbox"] : []),
      ],
      stdin: null,
      enforcement: [
        `mode ${mode}`,
        ...(mode === "accept-edits" ? ["commands need approval"] : []),
        ...(sandbox ? ["sandbox"] : []),
        ...(collab ? [`org tools (${collab.tools.length})`] : []),
      ],
    };
  },

  resumePlan({ sessionId, prompt, model, autonomy, agentTools, collab }) {
    const first = gemini.plan({ task: prompt, systemPrompt: "", model, autonomy, agentTools, collab });
    return { ...first, args: [...first.args, "--conversation", sessionId] };
  },
  parse(msg, st) {
    const out: ParseEvent[] = [];
    if (typeof (msg.result as Record<string, unknown> | undefined)?.conversation_id === "string") st.sessionId = String((msg.result as Record<string, unknown>).conversation_id);
    const event = String(msg.event ?? msg.type ?? "");

    if (event === "step_update") {
      const step = geminiStep(msg);
      const kind = String(step.step_type ?? "");
      const state = String(step.state ?? "");
      if (kind === "agent_response") {
        const delta = typeof step.text_delta === "string" ? step.text_delta : "";
        if (delta) {
          st.text += delta;
          out.push({ type: "text", text: delta });
        }
      } else if (kind === "tool") {
        const info = (step.tool_info ?? {}) as Record<string, unknown>;
        const name = String(info.name ?? "tool");
        const id = String(step.step_id ?? step.id ?? "");
        const key = id ? `${id}` : `${name}:${JSON.stringify(info.parameters ?? "")}`;
        if (!st.seen.has(key)) {
          st.seen.add(key);
          out.push({ type: "tool", name, summary: summarizeInput(name, info.parameters) });
        }
        if (state === "DONE" && info.error) {
          const err = info.error as Record<string, unknown> | string;
          const text = typeof err === "string" ? err : String(err.message ?? err.code ?? JSON.stringify(err));
          if (GEMINI_DENIAL.test(text)) {
            const tool = `${name}: ${head(text, 40)}`;
            st.denials.push(tool);
            out.push({ type: "denied", tool });
          }
        }
      }
      const usage = step.usage as Record<string, number> | undefined;
      if (usage && state === "DONE") st.sawUsage = true;
      return out;
    }

    if (event === "result") {
      const r = (msg.result ?? msg) as Record<string, unknown>;
      const usage = (r.usage ?? {}) as Record<string, number>;
      const cached = Number(usage.cache_read_tokens ?? 0) || 0;
      st.streamedInput = (Number(usage.input_tokens ?? 0) || 0) + cached;
      st.streamedCachedInput = cached;
      st.streamedOutput = (Number(usage.output_tokens ?? 0) || 0) + (Number(usage.thinking_tokens ?? 0) || 0);
      st.sawUsage = true;
      // Tokens only, never dollars: settled totals, cost computed and marked.
      st.settledInput = st.streamedInput;
      st.settledOutput = st.streamedOutput;
      if (typeof r.response === "string" && r.response.trim()) st.text = r.response;
      if (String(r.status ?? "").toUpperCase() === "ERROR") st.error = String(r.error ?? "the CLI reported an error");
      return out;
    }

    return out;
  },

  enforcementLabel(autonomy) {
    const mode = geminiModeFor(autonomy);
    return mode === "plan" ? "--mode plan, read-only" : "--mode accept-edits, commands need approval";
  },
};

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

const SPECS: Record<Provider, ProviderSpec> = { claude, codex, gemini };

export function providerFor(id: Provider | string | undefined): ProviderSpec {
  return (id && SPECS[id as Provider]) || claude;
}

/** Rosters written before providers existed carry only a model; read it. */
export function inferProvider(model: string | undefined): Provider {
  if (model && /^(gpt|o\d|codex)/i.test(model)) return "codex";
  if (model && /^gemini/i.test(model)) return "gemini";
  return "claude";
}

/** The hire form's space key: claude, then codex, then gemini, then back. */
export function nextProvider(p: Provider): Provider {
  const order: Provider[] = ["claude", "codex", "gemini"];
  return order[(order.indexOf(p) + 1) % order.length];
}
