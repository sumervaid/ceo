/**
 * What has already happened in this repository, read from local agent
 * history. Three sources, all read-only, none leaving the machine:
 *
 *   Reflex     ~/.reflex/reflex.db, or under $REFLEX_HOME. Reflex scans
 *              Claude Code, Codex and Cursor transcripts, redacts them, and
 *              finds workflows repeated across sessions. Its `suggestions`
 *              table holds those workflows with consensus steps, cost and
 *              the corrections people kept giving. Its `traces` table holds
 *              one row per session with the project, model mix and token usage.
 *              When Reflex has scanned, it is the best evidence there is.
 *
 *   codex      $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl, read
 *              directly. Lines are `{timestamp, type, payload}`. The first is
 *              `session_meta` with the cwd, so a file for another project
 *              costs one line to reject.
 *
 *   claude     ~/.claude/projects/<cwd with / as ->/<session>.jsonl, read
 *              directly. `user` and `assistant` records. Usage is counted
 *              once per API message id, as Claude Code repeats it per block.
 *
 * The direct readers are deliberately shallow: first requests, the models
 * used, token totals, how many commands and edits. Reflex does the real
 * analysis: de-duplication, clustering, step consensus. CEO does not
 * reimplement it, it reads the result. Everything is bounded: a time window,
 * a file cap, a line cap per file. Opening the panel on a machine with a
 * year of history costs well under a second.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

import { estimateCostUsd } from "./pricing.js";
import { reflexStatus } from "./reflex.js";

export type HistorySource = "claude-code" | "codex";

/** One past session in this project, as much as the shallow readers see. */
export type HistorySession = {
  source: HistorySource;
  id: string;
  startedAt: number | null;
  model: string | null;
  /** The first few things the person asked, truncated. Redacted by Reflex when it is the source. */
  requests: string[];
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Shell commands and tool calls, together. */
  toolCalls: number;
  /** File writes, edits and patches. */
  edits: number;
  /** Reflex's outcome signal when it has one: a check passed after the change. */
  verified: boolean | null;
  /** List-price cost of the session's tokens. */
  costUsd: number;
};

export type ReflexStep = { kind: string; label: string; instruction: string; support: number; examples: string[] };

/** A workflow Reflex found repeated across sessions. */
export type ReflexWorkflow = {
  slug: string;
  title: string;
  description: string;
  whenToUse: string;
  status: "pending" | "approved" | "rejected";
  confidence: number;
  instances: number;
  repositories: string[];
  /** True when one of the repositories is this one. */
  local: boolean;
  sources: Record<string, number>;
  steps: ReflexStep[];
  topTerms: string[];
  verifiedRate: number | null;
  medianMinutes: number | null;
  cost: { runs: number; medianTokens: number; medianToolCalls: number; usage: HistorySession["tokens"] } | null;
  /** Corrections people gave in these sessions: things to avoid, things to prefer. */
  constraints: { avoid: string[]; prefer: string[] };
};

export type History = {
  root: string;
  reflex: {
    available: boolean;
    path: string;
    scannedAt: string | null;
    /** Why it is unavailable, when it is. */
    note: string | null;
    workflows: ReflexWorkflow[];
    sessions: HistorySession[];
  };
  codex: HistorySession[];
  claude: HistorySession[];
};

export type HistoryOptions = {
  /** Only sessions modified within this many days. */
  days?: number;
  /** Per source. */
  maxFiles?: number;
  /** Per file. */
  maxLines?: number;
  env?: NodeJS.ProcessEnv;
};

const DEFAULTS = { days: 60, maxFiles: 150, maxLines: 4000 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortHash(value: string, length = 12): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function head(s: string, n = 160): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

function zeroTokens(): HistorySession["tokens"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function cost(model: string | null, t: HistorySession["tokens"]): number {
  // Cache writes bill at 1.25x input on Anthropic. They are folded into
  // input here, which overstates slightly rather than dropping it.
  return estimateCostUsd(model ?? "claude-sonnet-5", t.input + t.cacheWrite + t.cacheRead, t.output, t.cacheRead);
}

/** Lines of a JSONL file, capped, parsed leniently. */
function readJsonl(file: string, maxLines: number): Array<Record<string, unknown>> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  let start = 0;
  while (start < raw.length && out.length < maxLines) {
    let end = raw.indexOf("\n", start);
    if (end < 0) end = raw.length;
    const line = raw.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* a torn line */
    }
  }
  return out;
}

/** Harness-injected text is not something the person asked for. */
function isHumanRequest(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith("<")) return false; // <task-notification>, <system-reminder>, <command-…>
  if (/^(This session is being continued|Caveat: The messages below)/.test(t)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Reflex
// ---------------------------------------------------------------------------

export function reflexDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.REFLEX_HOME?.trim() || path.join(homedir(), ".reflex");
  return path.join(home, "reflex.db");
}

/**
 * Rows from a read-only query. `node:sqlite` when this node has it, which
 * means 22.5 or later, else the `sqlite3` CLI, which macOS ships. Either way
 * the file is opened read-only. CEO never writes Reflex's store.
 */
/**
 * node:sqlite is marked experimental, and node prints a warning to stderr
 * the first time it loads. In the dashboard that lands on top of the pane.
 * The warning is about API stability, which the one query here can live with.
 * Only that warning is swallowed. Everything else still reaches stderr.
 */
let warningFiltered = false;
function filterSqliteWarning(): void {
  if (warningFiltered) return;
  warningFiltered = true;
  const previous = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (w: Error) => {
    if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return;
    for (const l of previous) (l as (w: Error) => void)(w);
    if (previous.length === 0) process.stderr.write(`${w.name}: ${w.message}\n`);
  });
}

async function sqliteRows(file: string, sql: string): Promise<Array<Record<string, unknown>>> {
  filterSqliteWarning();
  try {
    const mod = (await import("node:sqlite")) as { DatabaseSync: new (p: string, o: { readOnly: boolean }) => { prepare: (s: string) => { all: () => unknown[] }; close: () => void } };
    const db = new mod.DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare(sql).all() as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ERR_UNKNOWN_BUILTIN_MODULE" && !/Cannot find module|not supported/i.test(String(e))) {
      throw e;
    }
  }
  const out = execFileSync("sqlite3", ["-readonly", "-json", file, sql], { encoding: "utf8", timeout: 10000 });
  return out.trim() ? (JSON.parse(out) as Array<Record<string, unknown>>) : [];
}

function parseWorkflow(row: Record<string, unknown>, repoName: string): ReflexWorkflow | null {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(String(row.data_json)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const repositories = Array.isArray(d.repositories) ? (d.repositories as unknown[]).map(String) : [];
  const steps = Array.isArray(d.steps)
    ? (d.steps as Array<Record<string, unknown>>).map((s) => ({
        kind: String(s.kind ?? ""),
        label: String(s.label ?? ""),
        instruction: String(s.instruction ?? ""),
        support: Number(s.support ?? 0) || 0,
        examples: Array.isArray(s.examples) ? (s.examples as unknown[]).map(String) : [],
      }))
    : [];
  const c = d.cost as Record<string, unknown> | undefined;
  const cu = (c?.usage ?? {}) as Record<string, number>;
  const cons = (d.constraints ?? {}) as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    Array.isArray(v)
      ? (v as unknown[]).map((x) => (typeof x === "string" ? x : String((x as Record<string, unknown>).text ?? (x as Record<string, unknown>).rule ?? ""))).filter(Boolean)
      : [];
  return {
    slug: String(d.slug ?? row.slug),
    title: String(d.title ?? ""),
    description: String(d.description ?? ""),
    whenToUse: String(d.whenToUse ?? ""),
    status: (String(row.status) as ReflexWorkflow["status"]) ?? "pending",
    confidence: Number(d.confidence ?? 0) || 0,
    instances: Number(d.instances ?? 0) || 0,
    repositories,
    local: repositories.includes(repoName),
    sources: (d.sources ?? {}) as Record<string, number>,
    steps,
    topTerms: Array.isArray(d.topTerms) ? (d.topTerms as unknown[]).map(String) : [],
    verifiedRate: typeof d.verifiedRate === "number" ? d.verifiedRate : null,
    medianMinutes: typeof d.medianMinutes === "number" ? d.medianMinutes : null,
    cost: c
      ? {
          runs: Number(c.runs ?? 0) || 0,
          medianTokens: Number(c.medianTokens ?? 0) || 0,
          medianToolCalls: Number(c.medianToolCalls ?? 0) || 0,
          usage: { input: cu.input ?? 0, output: cu.output ?? 0, cacheRead: cu.cacheRead ?? 0, cacheWrite: cu.cacheWrite ?? 0 },
        }
      : null,
    constraints: { avoid: list(cons.avoid), prefer: list(cons.prefer) },
  };
}

function parseTrace(row: Record<string, unknown>, root: string, repoName: string): HistorySession | null {
  let t: Record<string, unknown>;
  try {
    t = JSON.parse(String(row.trace_json)) as Record<string, unknown>;
  } catch {
    return null;
  }
  // Reflex keys a session by the hash of its cwd and the basename of it. A
  // session started in a subdirectory hashes differently, so the name is the
  // second chance. A redacted name such as "<user>" never matches a repo.
  const hash = String(t.projectHash ?? "");
  const name = String(t.projectName ?? "");
  if (hash !== shortHash(root) && hash !== shortHash(real(root)) && name !== repoName) return null;

  const byModel = (t.usageByModel ?? {}) as Record<string, Record<string, number>>;
  const model = Object.entries(byModel).sort((a, b) => (b[1].output ?? 0) - (a[1].output ?? 0))[0]?.[0] ?? null;
  const u = (t.usage ?? {}) as Record<string, number>;
  const tokens = { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 };
  const outcome = (t.outcome ?? {}) as Record<string, unknown>;
  const started = t.startedAt ? Date.parse(String(t.startedAt)) : NaN;
  return {
    source: String(t.source) === "codex" ? "codex" : "claude-code",
    id: String(t.sessionId ?? ""),
    startedAt: Number.isFinite(started) ? started : null,
    model,
    requests: t.excerpt ? [head(String(t.excerpt))] : [],
    tokens,
    toolCalls: Number(t.toolCalls ?? 0) || 0,
    edits: (outcome.modified as boolean) ? 1 : 0,
    verified: typeof outcome.verified === "boolean" ? outcome.verified : null,
    costUsd: cost(model, tokens),
  };
}

export async function readReflex(root: string, env: NodeJS.ProcessEnv = process.env): Promise<History["reflex"]> {
  const file = reflexDbPath(env);
  const repoName = path.basename(root);
  const empty = { available: false, path: file, scannedAt: null, note: null as string | null, workflows: [], sessions: [] };
  if (!existsSync(file)) {
    const st = reflexStatus(env);
    return {
      ...empty,
      note: st.installed
        ? "Reflex is installed but has not scanned yet. Press s to scan now (reflex scan --days 30 --yes)."
        : "Reflex is not installed (npm i -g reflex-skills). The proposal is from this directory's transcripts and the repository alone.",
    };
  }
  try {
    const scans = await sqliteRows(file, "select started_at from scans order by id desc limit 1");
    const sugg = await sqliteRows(file, "select slug, status, data_json from suggestions where status <> 'rejected' order by rank");
    const traces = await sqliteRows(file, "select trace_json from traces");
    const workflows = sugg.map((r) => parseWorkflow(r, repoName)).filter((w): w is ReflexWorkflow => w !== null);
    const sessions = traces.map((r) => parseTrace(r, root, repoName)).filter((s): s is HistorySession => s !== null);
    return {
      available: true,
      path: file,
      scannedAt: scans[0]?.started_at ? String(scans[0].started_at) : null,
      note: null,
      workflows,
      sessions,
    };
  } catch (e) {
    return { ...empty, note: `Could not read Reflex's store: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---------------------------------------------------------------------------
// codex rollouts
// ---------------------------------------------------------------------------

function codexSessionsDir(env: NodeJS.ProcessEnv): string {
  const home = env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  return path.join(home, "sessions");
}

/** rollout-*.jsonl under sessions/YYYY/MM/DD, newest first, within the window. */
function codexRolloutFiles(dir: string, days: number, maxFiles: number): string[] {
  if (!existsSync(dir)) return [];
  const since = Date.now() - days * 86_400_000;
  const files: Array<{ file: string; mtime: number }> = [];
  const walk = (d: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = path.join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (st.isFile() && name.startsWith("rollout-") && name.endsWith(".jsonl") && st.mtimeMs >= since) {
        files.push({ file: p, mtime: st.mtimeMs });
      }
    }
  };
  walk(dir, 0);
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, maxFiles).map((f) => f.file);
}

/** Resolve symlinks when the path exists, else leave it. On macOS, /tmp resolves to /private/tmp. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function under(root: string, cwd: string): boolean {
  if (!cwd) return false;
  const r = real(root);
  const c = real(cwd);
  return c === r || c.startsWith(r + path.sep);
}

export function readCodexHistory(root: string, opts: HistoryOptions = {}): HistorySession[] {
  const o = { ...DEFAULTS, ...opts };
  const env = o.env ?? process.env;
  const out: HistorySession[] = [];
  for (const file of codexRolloutFiles(codexSessionsDir(env), o.days, o.maxFiles)) {
    // The first line says whose session this is. Reject cheaply.
    const first = readJsonl(file, 1)[0];
    const meta = (first?.payload ?? {}) as Record<string, unknown>;
    if (first?.type !== "session_meta" || !under(root, String(meta.cwd ?? ""))) continue;

    const s: HistorySession = {
      source: "codex",
      id: String(meta.id ?? path.basename(file)),
      startedAt: meta.timestamp ? Date.parse(String(meta.timestamp)) || null : null,
      model: null,
      requests: [],
      tokens: zeroTokens(),
      toolCalls: 0,
      edits: 0,
      verified: null,
      costUsd: 0,
    };
    for (const line of readJsonl(file, o.maxLines)) {
      const p = (line.payload ?? {}) as Record<string, unknown>;
      const type = String(line.type ?? "");
      if (type === "event_msg") {
        const kind = String(p.type ?? "");
        if (kind === "user_message" && s.requests.length < 3 && isHumanRequest(String(p.message ?? ""))) {
          s.requests.push(head(String(p.message)));
        } else if (kind === "token_count") {
          const u = ((p.info as Record<string, unknown> | undefined)?.total_token_usage ?? {}) as Record<string, number>;
          // Cumulative: the last one wins. input_tokens includes cached.
          const cached = u.cached_input_tokens ?? 0;
          s.tokens = { input: (u.input_tokens ?? 0) - cached, output: u.output_tokens ?? 0, cacheRead: cached, cacheWrite: 0 };
        } else if (kind === "thread_settings_applied") {
          const m = (p.thread_settings as Record<string, unknown> | undefined)?.model;
          if (typeof m === "string") s.model = m;
        } else if (kind === "patch_apply_end") {
          s.edits++;
        }
      } else if (type === "turn_context") {
        if (typeof p.model === "string" && !s.model) s.model = p.model;
      } else if (type === "response_item") {
        const kind = String(p.type ?? "");
        if (kind === "function_call" || kind === "local_shell_call" || kind === "custom_tool_call") s.toolCalls++;
      }
    }
    s.costUsd = cost(s.model, s.tokens);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// claude code project transcripts
// ---------------------------------------------------------------------------

export function claudeProjectsDir(env: NodeJS.ProcessEnv): string {
  const cfg = env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), ".claude");
  return path.join(cfg, "projects");
}

/** Claude Code names a project folder after its cwd with every "/" as "-". */
export function claudeProjectFolder(root: string): string {
  return path.resolve(root).replace(/\//g, "-");
}

export function readClaudeHistory(root: string, opts: HistoryOptions = {}): HistorySession[] {
  const o = { ...DEFAULTS, ...opts };
  const env = o.env ?? process.env;
  const dir = path.join(claudeProjectsDir(env), claudeProjectFolder(root));
  if (!existsSync(dir)) return [];
  const since = Date.now() - o.days * 86_400_000;
  let files: Array<{ file: string; mtime: number }> = [];
  try {
    files = readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => ({ file: path.join(dir, n), mtime: statSync(path.join(dir, n)).mtimeMs }))
      .filter((f) => f.mtime >= since);
  } catch {
    return [];
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const out: HistorySession[] = [];
  for (const { file } of files.slice(0, o.maxFiles)) {
    const s: HistorySession = {
      source: "claude-code",
      id: path.basename(file, ".jsonl"),
      startedAt: null,
      model: null,
      requests: [],
      tokens: zeroTokens(),
      toolCalls: 0,
      edits: 0,
      verified: null,
      costUsd: 0,
    };
    const seenMessages = new Set<string>();
    const modelCount = new Map<string, number>();
    for (const line of readJsonl(file, o.maxLines)) {
      const type = String(line.type ?? "");
      const msg = (line.message ?? {}) as Record<string, unknown>;
      if (type === "user") {
        if (line.isMeta || line.isSidechain) continue;
        if (!s.startedAt && line.timestamp) s.startedAt = Date.parse(String(line.timestamp)) || null;
        const content = msg.content;
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? (content as Array<Record<string, unknown>>)
                  .filter((b) => b.type === "text")
                  .map((b) => String(b.text ?? ""))
                  .join(" ")
              : "";
        if (s.requests.length < 3 && isHumanRequest(text)) s.requests.push(head(text));
      } else if (type === "assistant") {
        if (line.isSidechain) continue;
        const id = String(msg.id ?? "");
        const usage = (msg.usage ?? {}) as Record<string, number>;
        if (id && !seenMessages.has(id)) {
          seenMessages.add(id);
          s.tokens.input += usage.input_tokens ?? 0;
          s.tokens.output += usage.output_tokens ?? 0;
          s.tokens.cacheRead += usage.cache_read_input_tokens ?? 0;
          s.tokens.cacheWrite += usage.cache_creation_input_tokens ?? 0;
          if (typeof msg.model === "string") modelCount.set(msg.model, (modelCount.get(msg.model) ?? 0) + 1);
        }
        const content = Array.isArray(msg.content) ? (msg.content as Array<Record<string, unknown>>) : [];
        for (const b of content) {
          if (b.type !== "tool_use") continue;
          s.toolCalls++;
          if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(String(b.name ?? ""))) s.edits++;
        }
      }
    }
    s.model = [...modelCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    s.costUsd = cost(s.model, s.tokens);
    if (s.requests.length === 0 && s.toolCalls === 0) continue; // a title-only stub
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// All together
// ---------------------------------------------------------------------------

export async function readHistory(root: string, opts: HistoryOptions = {}): Promise<History> {
  const env = opts.env ?? process.env;
  const [reflex, codex, claude] = await Promise.all([
    readReflex(root, env),
    Promise.resolve(readCodexHistory(root, opts)),
    Promise.resolve(readClaudeHistory(root, opts)),
  ]);
  return { root, reflex, codex, claude };
}

/**
 * Every session the readers found, de-duplicated by id across Reflex and the
 * direct readers. Reflex's ids are `${source}:${nativeId}`.
 */
export function allSessions(h: History): HistorySession[] {
  const seen = new Set<string>();
  const out: HistorySession[] = [];
  for (const s of [...h.reflex.sessions, ...h.codex, ...h.claude]) {
    const key = s.id.includes(":") ? s.id.split(":").slice(1).join(":") : s.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
