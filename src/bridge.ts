/**
 * The machine interface, for scripts and CI.
 *
 * A caller that cannot import the core can still run a process. This module
 * is the whole surface such a caller needs: one read (`ceo json`) that
 * returns everything a dashboard needs in a single object, and one write
 * (`ceo op <verb> <json>`) that performs exactly one mutation through the
 * core and reports back as JSON.
 *
 * Every write here goes through `ledger.append()` and its lock. The
 * invariants therefore hold while a script, the dashboard and the MCP
 * server are all alive at once.
 *
 * Output discipline: stdout carries one JSON object and nothing else. Every
 * failure is `{ ok: false, error }` with exit code 0, because the caller is a
 * program and a thrown stack is noise to it. A non-zero exit means this
 * module itself crashed, which is a bug.
 */

import { effectiveTools, policyFor } from "./core/autonomy.js";
import { authStatus } from "./core/auth.js";
import { compileAgentPrompt } from "./core/compile.js";
import { begin, end, type DelegationHandle } from "./core/delegation.js";
import { initLedger, append, readLedger } from "./core/ledger.js";
import { current as currentMission, setMission } from "./core/mission.js";
import { nextStep } from "./core/nextstep.js";
import { orgExists, projectRoot } from "./core/paths.js";
import { estimateCostUsd } from "./core/pricing.js";
import { fire, hire, reconfigure, setAutonomy, setBudget, findAgent } from "./core/roster.js";
import { providerFor } from "./core/providers.js";
import { enforcementFor, workdirFor } from "./core/runner.js";
import { handoff, postMessage, YOU } from "./core/collab.js";
import {
  addTask,
  updateTask,
  type TaskPriority,
  type TaskStoredStatus,
} from "./core/tasks.js";
import { PROVIDERS, type AutonomyLevel, type Provider } from "./core/types.js";
import {
  addWorkspace,
  ensureCurrentWorkspace,
  listWorkspaces,
  removeWorkspace,
  touchWorkspace,
} from "./core/workspaces.js";
import { readOrgState } from "./tui/data.js";
import { readWorkspaceSummary } from "./tui/workspaces.js";

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Everything the pane draws, in one object. Shapes are the core's own types
 * serialised, plus the few derived fields a drawing needs and should not
 * recompute: effective tools, the policy label, the next step.
 */
export function snapshotJson(cwd: string): Record<string, unknown> {
  const root = projectRoot(cwd);
  const ws = ensureCurrentWorkspace(root);
  const workspaces = listWorkspaces().map((w) => readWorkspaceSummary(w));
  const state = readOrgState(root);
  const auth = authStatus();

  const agents = (state.roster?.agents ?? []).map((a) => ({
    ...a,
    effectiveTools: effectiveTools(a.autonomy, a.tools),
    policyLabel: policyFor(a.autonomy).label,
    canWrite: policyFor(a.autonomy).canWrite,
    canMerge: policyFor(a.autonomy).canMerge,
    workdir: workdirFor(a, root),
  }));

  return {
    ok: true,
    root,
    workspaceName: ws?.name ?? root.split("/").pop() ?? "org",
    exists: state.exists,
    error: state.error,
    agents,
    mission: state.mission,
    tasks: state.tasks,
    delegations: state.delegations.slice(0, 50),
    rollup: state.rollup,
    audits: state.audits.slice(0, 5).map((a) => ({
      ...a,
      findings: a.findings.slice(0, 6),
    })),
    verify: state.verifyResult,
    dangling: state.dangling,
    ledgerLength: state.ledgerLength,
    nextStep: state.exists ? nextStep(state) : null,
    billing: { mode: auth.mode, summary: auth.summary, warning: auth.warning },
    workspaces,
    loadedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

type Op = Record<string, unknown>;

function str(o: Op, k: string): string {
  const v = o[k];
  if (typeof v !== "string") throw new Error(`"${k}" must be a string.`);
  return v;
}
function optStr(o: Op, k: string): string | undefined {
  const v = o[k];
  return typeof v === "string" ? v : undefined;
}
function optNum(o: Op, k: string): number | undefined {
  const v = o[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function optBool(o: Op, k: string): boolean | undefined {
  const v = o[k];
  return typeof v === "boolean" ? v : undefined;
}

const LEVELS: AutonomyLevel[] = ["observe", "propose", "execute", "autonomous"];
const PRIORITIES: TaskPriority[] = ["high", "normal", "low"];
const STATUSES: TaskStoredStatus[] = ["queued", "running", "done", "failed", "cancelled"];

/**
 * Perform one mutation. Every branch returns a plain object, and the CLI
 * prints it. `root` is the workspace the mutation applies to. The caller
 * passes the root explicitly. A script may act on a repo other than the cwd.
 */
export function performOp(verb: string, args: Op, root: string): Record<string, unknown> {
  switch (verb) {
    case "init": {
      const entry = initLedger(root);
      addWorkspace(root);
      return { ok: true, message: `Org created at ${projectRoot(root)}/.ceo, ledger seq ${entry.seq}.` };
    }

    case "hire": {
      const name = str(args, "name");
      const autonomy = optStr(args, "autonomy") as AutonomyLevel | undefined;
      if (autonomy && !LEVELS.includes(autonomy)) throw new Error(`Unknown autonomy "${autonomy}".`);
      const provider = optStr(args, "provider") as Provider | undefined;
      if (provider && !PROVIDERS.includes(provider)) throw new Error(`Unknown provider "${provider}". Use claude or codex.`);
      const record = hire(
        {
          name,
          role: str(args, "role"),
          provider,
          model: optStr(args, "model"),
          budgetUsd: optNum(args, "budgetUsd"),
          isolated: optBool(args, "isolated"),
          autonomy,
          collaboration: optStr(args, "collaboration"),
          guardrails: Array.isArray(args.guardrails) ? (args.guardrails as string[]) : undefined,
        },
        root,
      );
      const policy = policyFor(record.autonomy);
      return {
        ok: true,
        message: `Hired ${record.name} on ${record.provider} ${record.model} at ${record.autonomy}: ${policy.label}${
          record.isolated ? ` · branch ${record.branch}` : ""
        }.`,
        agent: record,
      };
    }

    case "reconfigure": {
      const name = str(args, "name");
      const changes: Record<string, unknown> = {};
      for (const k of ["role", "provider", "model", "systemPrompt", "collaboration", "autonomy"] as const) {
        const v = optStr(args, k);
        if (v !== undefined) changes[k] = v;
      }
      if (Array.isArray(args.guardrails)) changes.guardrails = args.guardrails;
      if (changes.provider && !PROVIDERS.includes(changes.provider as Provider)) throw new Error(`Unknown provider "${changes.provider}" (claude, codex or gemini).`);
      if (changes.provider && !changes.model) {
        const spec = providerFor(changes.provider as Provider);
        const current = findAgent(name, root);
        if (!current || !spec.models().includes(current.model)) changes.model = spec.defaultModel();
      }
      const after = reconfigure(name, changes, root);
      return { ok: true, message: `${name}: ${Object.keys(changes).join(", ")} updated. Now ${after.provider} ${after.model} at ${after.autonomy}.`, agent: after };
    }

    case "post": {
      const m = postMessage({ from: optStr(args, "from") ?? YOU, to: str(args, "to"), text: str(args, "text") }, root);
      return { ok: true, message: `Posted to ${m.to === "*" ? "everyone" : m.to}.`, seq: m.seq };
    }

    case "handoff": {
      const t = handoff({ from: str(args, "from"), to: str(args, "to"), title: str(args, "title"), priority: optStr(args, "priority") as TaskPriority | undefined }, root);
      return { ok: true, message: `Queued ${t.id} for ${t.assignee}, requested by ${t.requestedBy}.`, task: t };
    }

    case "fire": {
      const name = str(args, "name");
      fire(name, optStr(args, "reason") ?? "fired from the pane", root);
      return { ok: true, message: `Fired ${name}.` };
    }

    case "budget": {
      const name = str(args, "name");
      const budgetUsd = optNum(args, "budgetUsd");
      if (budgetUsd === undefined) throw new Error('"budgetUsd" must be a number.');
      setBudget(name, budgetUsd, root);
      return {
        ok: true,
        message: budgetUsd > 0 ? `${name} budget set to $${budgetUsd}.` : `${name} is now uncapped.`,
      };
    }

    case "autonomy": {
      const name = str(args, "name");
      const level = str(args, "autonomy") as AutonomyLevel;
      if (!LEVELS.includes(level)) throw new Error(`Unknown autonomy "${level}".`);
      const agent = setAutonomy(name, level, root);
      const tools = effectiveTools(agent.autonomy, agent.tools);
      return {
        ok: true,
        message: `${name} is now ${level}: can ${policyFor(level).label}. Tools: ${tools.join(", ") || "none"}.`,
        tools,
      };
    }

    case "mission": {
      const mission = setMission(
        {
          objective: str(args, "objective"),
          successCriteria: Array.isArray(args.successCriteria)
            ? (args.successCriteria as string[])
            : undefined,
          orgGuardrails: Array.isArray(args.orgGuardrails)
            ? (args.orgGuardrails as string[])
            : undefined,
        },
        root,
      );
      return {
        ok: true,
        message: `Mission set · ${mission.successCriteria.length} criteria · ${mission.orgGuardrails.length} org guardrails.`,
      };
    }

    case "task_add": {
      const priority = (optStr(args, "priority") ?? "normal") as TaskPriority;
      if (!PRIORITIES.includes(priority)) throw new Error(`Unknown priority "${priority}".`);
      const t = addTask(
        { title: str(args, "title"), assignee: optStr(args, "assignee") ?? null, priority },
        root,
      );
      return {
        ok: true,
        message:
          t.status === "blocked"
            ? `Queued ${t.id}, blocked: ${t.blockedReason}.`
            : `Queued ${t.id} for ${t.assignee}.`,
        task: t,
      };
    }

    case "task_update": {
      const id = str(args, "id");
      const status = optStr(args, "status") as TaskStoredStatus | undefined;
      if (status && !STATUSES.includes(status)) throw new Error(`Unknown status "${status}".`);
      const t = updateTask(
        id,
        {
          status,
          assignee: "assignee" in args ? (optStr(args, "assignee") ?? null) : undefined,
          title: optStr(args, "title"),
          priority: optStr(args, "priority") as TaskPriority | undefined,
          note: "note" in args ? (optStr(args, "note") ?? null) : undefined,
        },
        root,
      );
      return { ok: true, message: `Task ${t.id} is now ${t.status}.`, task: t };
    }

    case "workspace_add": {
      const w = addWorkspace(str(args, "path"), optStr(args, "name"));
      return { ok: true, message: `Registered ${w.name} at ${w.path}`, workspace: w };
    }

    case "workspace_remove": {
      const p = str(args, "path");
      const removed = removeWorkspace(p);
      return removed
        ? { ok: true, message: `Forgot ${p}. Its .ceo/ is untouched.` }
        : { ok: false, error: `Not a registered workspace: ${p}` };
    }

    case "workspace_touch": {
      touchWorkspace(str(args, "path"));
      return { ok: true };
    }

    /** The system prompt an agent runs under, for registering it as a subagent type. */
    case "compile": {
      const agent = findAgent(str(args, "agent"), root);
      if (!agent) throw new Error(`No agent named "${args.agent}" in the org.`);
      const compiled = compileAgentPrompt(agent, currentMission(root));
      return {
        ok: true,
        prompt: compiled.text,
        overridden: compiled.overridden,
        sections: compiled.sections,
        tools: effectiveTools(agent.autonomy, agent.tools),
        enforcement: enforcementFor(agent),
        provider: agent.provider,
        model: agent.model,
      };
    }

    /**
     * Open a delegation for a run an external caller is about to start.
     * Returns what the spawn needs: the compiled prompt, the enforced tool
     * list, the model, and the directory. The caller starts the process with
     * exactly these tools. The allowlist is then enforced by the process.
     * That is invariant 4.
     */
    case "delegate_begin": {
      const agentName = str(args, "agent");
      const task = str(args, "task");
      const taskId = optStr(args, "taskId");
      const agent = findAgent(agentName, root);
      if (!agent) throw new Error(`No agent named "${agentName}" in the org.`);
      const handle = begin(agentName, task, root, {
        provider: agent.provider,
        model: agent.model,
        enforcement: enforcementFor(agent),
        workdir: workdirFor(agent, root),
      });
      if (taskId) {
        try {
          updateTask(taskId, { status: "running", delegationId: handle.id }, root);
        } catch {
          /* the delegation is the record */
        }
      }
      const compiled = compileAgentPrompt(agent, currentMission(root));
      return {
        ok: true,
        handle,
        prompt: compiled.text,
        overridden: compiled.overridden,
        tools: effectiveTools(agent.autonomy, agent.tools),
        enforcement: enforcementFor(agent),
        provider: agent.provider,
        model: agent.model,
        workdir: workdirFor(agent, root),
        autonomy: agent.autonomy,
      };
    }

    /**
     * Close a delegation from a subagent's `turn.complete`. Claude Code reports
     * token counts and the model but not a settled dollar figure, so the cost
     * is estimated from the table and marked as such, and a `cost_estimated`
     * note is appended. That is the same path the standalone runner takes for
     * a run that dies before settling. Never zero for a run that spent, which
     * is invariant 5.
     */
    case "delegate_end": {
      const handle = args.handle as DelegationHandle;
      if (!handle || typeof handle.id !== "string") throw new Error('"handle" is required.');
      // A second close for one delegation would count its cost twice. The
      // standalone runner cannot do this. An externally driven op can, so
      // the guard lives here rather than in the core's stable API.
      const alreadyClosed = readLedger(root).some(
        (e) => e.type === "delegate_end" && e.data.id === handle.id,
      );
      if (alreadyClosed) {
        return { ok: false, error: `Delegation ${handle.id} is already closed.`, duplicate: true };
      }
      const inputTokens = optNum(args, "inputTokens") ?? 0;
      const outputTokens = optNum(args, "outputTokens") ?? 0;
      const model = optStr(args, "model") ?? findAgent(handle.agent, root)?.model ?? "claude-sonnet-5";
      let costUsd = optNum(args, "costUsd") ?? 0;
      let costIsEstimate = optBool(args, "costIsEstimate") ?? false;
      if (costUsd === 0 && inputTokens + outputTokens > 0) {
        costUsd = estimateCostUsd(model, inputTokens, outputTokens);
        costIsEstimate = costUsd > 0;
      }
      const ok = optBool(args, "ok") ?? true;
      const output = optStr(args, "output") ?? "";
      const durationMs = optNum(args, "durationMs") ?? 0;
      const result = end(
        handle,
        ok ? output : `[${optStr(args, "error") ?? "failed"}]\n\n${output}`,
        { inputTokens, outputTokens, costUsd, durationMs },
        root,
      );
      if (costIsEstimate) {
        append(
          "note",
          handle.agent,
          {
            kind: "cost_estimated",
            delegationId: handle.id,
            costUsd,
            inputTokens,
            outputTokens,
            model,
            detail:
              "Run closed with token counts but no settled cost. Cost estimated from list prices.",
          },
          root,
        );
      }
      const denials = Array.isArray(args.denials) ? (args.denials as string[]) : [];
      if (denials.length > 0) {
        append(
          "note",
          handle.agent,
          {
            kind: "permission_denied",
            tools: denials,
            delegationId: handle.id,
            detail: `Agent attempted ${denials.length} tool call(s) its autonomy level forbids.`,
          },
          root,
        );
      }
      const taskId = optStr(args, "taskId");
      if (taskId) {
        try {
          updateTask(
            taskId,
            { status: ok ? "done" : "failed", note: ok ? null : optStr(args, "error") ?? "failed" },
            root,
          );
        } catch {
          /* best effort */
        }
      }
      return {
        ok: true,
        message: `Closed ${handle.id} · ${handle.agent} · $${costUsd.toFixed(4)}${
          costIsEstimate ? " est." : ""
        } · ${(durationMs / 1000).toFixed(1)}s`,
        outputPath: result.outputPath,
        costUsd,
        costIsEstimate,
        commit: result.commit,
      };
    }

    case "note": {
      const entry = append(
        "note",
        optStr(args, "agent") ?? null,
        { kind: optStr(args, "kind") ?? "note", text: str(args, "text") },
        root,
      );
      return { ok: true, message: `Note recorded at seq ${entry.seq}.` };
    }

    default:
      throw new Error(`Unknown op "${verb}".`);
  }
}

/** Entry point for `ceo op`. Parses, performs, prints one JSON line. */
export function runOp(argv: string[], cwd: string): string {
  const [verb, rawArgs, rawRoot] = argv;
  if (!verb) return JSON.stringify({ ok: false, error: "Usage: ceo op <verb> <json> [root]" });
  let args: Op = {};
  if (rawArgs) {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object") args = parsed as Op;
    } catch (e) {
      return JSON.stringify({ ok: false, error: `Bad JSON: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  const root = projectRoot(rawRoot || cwd);
  if (verb !== "init" && verb !== "workspace_add" && verb !== "workspace_remove" && verb !== "workspace_touch" && !orgExists(root)) {
    return JSON.stringify({ ok: false, error: `No org at ${root}. Run op "init" first.`, needsInit: true });
  }
  try {
    return JSON.stringify(performOp(verb, args, root));
  } catch (e) {
    return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
