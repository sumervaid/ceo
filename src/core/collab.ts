/**
 * How agents work with each other.
 *
 * A run is one headless process with one task. Left alone, agents are
 * contractors who never meet: the mission is in every prompt, but nothing
 * carries one agent's findings to the next, and an agent that spots work
 * for a colleague can only mention it in its report and hope.
 *
 * This module is the collaboration surface, and it is built on the ledger
 * rather than beside it. Three things an agent can do, each a ledger event
 * with an author:
 *
 *   post      a note to one teammate or to everyone (a `note` of kind
 *             `message`). Notes addressed to an agent reach it in the
 *             "From the org" section of its next prompt.
 *   hand off  queue a task for a teammate (`task_add` with `requestedBy`).
 *             The task runs when a human or the dispatcher starts it, under
 *             the teammate's own budget and level. Nothing runs by itself.
 *   read      the roster, the mission, and teammates' latest outputs.
 *
 * What an agent still cannot do, by omission: change a budget, change a
 * level, close a cost record, mark a task done, or start a run. Those stay
 * with the person and the dispatcher, which is what keeps the accounting
 * honest: an agent can ask for work, not pay for it.
 *
 * The surface reaches the agent two ways. The prompt carries the notes and
 * outputs that arrived since its last run, so even a provider with no tool
 * access sees them. The `org` MCP server (src/mcp/collab.ts) gives the run
 * the tools to post, hand off and read, scoped to the agent that is running.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

import { ceoDir } from "./paths.js";

import { recentDelegations } from "./delegation.js";
import { append, readLedger } from "./ledger.js";
import { readRoster } from "./roster.js";
import { addTask, type Task, type TaskPriority } from "./tasks.js";

/** Who a note may come from besides an agent: the person at the dashboard. */
export const YOU = "you";

export type OrgMessage = {
  seq: number;
  ts: number;
  from: string;
  /** An agent name, or "*" for everyone. */
  to: string;
  text: string;
  /** The run that posted it, when an agent did. */
  delegationId: string | null;
  /** Set when the note is a question that expects a reply. */
  askId: string | null;
  /** The ask this note answers, when the author said so. */
  inReplyTo: string | null;
};

export type TeammateOutput = {
  agent: string;
  delegationId: string;
  task: string;
  ts: number;
  costUsd: number;
  /** The output's body, truncated. */
  excerpt: string;
  truncated: boolean;
};

export type OrgContext = {
  /** Notes addressed to this agent or to everyone, newest first, since its last run plus a few older. */
  messages: OrgMessage[];
  /** Each teammate's latest completed output, newest first. */
  outputs: TeammateOutput[];
  /** When this agent last started a run, or null. */
  lastRunAt: number | null;
};

const MAX_TEXT = 2000;

function validParty(name: string, cwd?: string): void {
  if (name === "*" || name === YOU) return;
  if (!readRoster(cwd).agents.some((a) => a.name === name)) {
    throw new Error(`No agent named "${name}" in the org. Address a teammate by name, or "*" for everyone.`);
  }
}

/** Post a note. `from` is an agent or "you"; `to` is an agent or "*". */
export function postMessage(
  input: { from: string; to: string; text: string; delegationId?: string | null; askId?: string | null; inReplyTo?: string | null },
  cwd?: string,
): OrgMessage {
  const text = input.text.replace(/\s+$/, "").trim();
  if (text.length < 2) throw new Error("A note needs some text.");
  if (text.length > MAX_TEXT) throw new Error(`A note is at most ${MAX_TEXT} characters; put the long version in your report.`);
  const from = input.from.trim();
  const to = input.to.trim() || "*";
  validParty(from, cwd);
  validParty(to, cwd);
  if (to === YOU) throw new Error('Address a teammate by name, or "*" for everyone; the person reads the board directly.');
  const entry = append(
    "note",
    from === YOU ? null : from,
    {
      kind: "message",
      from,
      to,
      text,
      delegationId: input.delegationId ?? null,
      askId: input.askId ?? null,
      inReplyTo: input.inReplyTo ?? null,
    },
    cwd,
  );
  return toMessage(entry);
}

function toMessage(e: { seq: number; ts: number; data: Record<string, unknown> }): OrgMessage {
  return {
    seq: e.seq,
    ts: e.ts,
    from: String(e.data.from ?? "?"),
    to: String(e.data.to ?? "*"),
    text: String(e.data.text ?? ""),
    delegationId: typeof e.data.delegationId === "string" ? e.data.delegationId : null,
    askId: typeof e.data.askId === "string" ? e.data.askId : null,
    inReplyTo: typeof e.data.inReplyTo === "string" ? e.data.inReplyTo : null,
  };
}

/** The board: every note, newest first. */
export function messages(cwd?: string, limit = 50): OrgMessage[] {
  return readLedger(cwd)
    .filter((e) => e.type === "note" && e.data.kind === "message")
    .map(toMessage)
    .reverse()
    .slice(0, limit);
}

/** Notes for one agent: addressed to it or to everyone, not its own, newest first. */
export function messagesFor(agent: string, cwd?: string, limit = 50): OrgMessage[] {
  return messages(cwd, 1000)
    .filter((m) => m.from !== agent && (m.to === agent || m.to === "*"))
    .slice(0, limit);
}

/**
 * Queue work for a teammate. The task is the teammate's: it runs under their
 * budget and level when a person or the dispatcher starts it. `requestedBy`
 * is recorded so the queue and the auditor can say who asked.
 */
export function handoff(
  input: { from: string; to: string; title: string; priority?: TaskPriority },
  cwd?: string,
): Task {
  validParty(input.from, cwd);
  if (input.to === "*" || input.to === YOU) throw new Error("A handoff goes to one named teammate.");
  return addTask({ title: input.title, assignee: input.to, priority: input.priority, requestedBy: input.from }, cwd);
}

/** The body of an archived output, without the header the archive prepends. */
export function readOutput(outputPath: string, maxChars = 12000): { text: string; truncated: boolean } {
  if (!existsSync(outputPath)) return { text: "", truncated: false };
  const raw = readFileSync(outputPath, "utf8");
  const i = raw.indexOf("## Output\n\n");
  const body = (i >= 0 ? raw.slice(i + "## Output\n\n".length) : raw).trim();
  if (body.length <= maxChars) return { text: body, truncated: false };
  return { text: body.slice(0, maxChars).trimEnd() + "…", truncated: true };
}

/**
 * Each teammate's latest completed output, newest first. One per teammate:
 * a prompt that carried every past run would be mostly history.
 */
export function teammateOutputs(
  agent: string,
  cwd?: string,
  opts: { perAgent?: number; maxChars?: number; limit?: number } = {},
): TeammateOutput[] {
  const perAgent = opts.perAgent ?? 1;
  const maxChars = opts.maxChars ?? 700;
  const seen = new Map<string, number>();
  const out: TeammateOutput[] = [];
  for (const d of recentDelegations(100, cwd)) {
    if (!d.complete || !d.agent || d.agent === agent || !d.outputPath) continue;
    const n = seen.get(d.agent) ?? 0;
    if (n >= perAgent) continue;
    seen.set(d.agent, n + 1);
    const body = readOutput(d.outputPath, maxChars);
    if (!body.text) continue;
    out.push({
      agent: d.agent,
      delegationId: d.id,
      task: d.task,
      ts: d.ts,
      costUsd: d.costUsd,
      excerpt: body.text,
      truncated: body.truncated,
    });
    if (out.length >= (opts.limit ?? 4)) break;
  }
  return out;
}

/** When this agent last started a run, from the ledger. */
export function lastRunAt(agent: string, cwd?: string): number | null {
  let last: number | null = null;
  for (const e of readLedger(cwd)) {
    if (e.type === "delegate_start" && e.agent === agent) last = e.ts;
  }
  return last;
}

/**
 * What goes into an agent's prompt from the rest of the org: notes since
 * its last run (plus up to three older ones, so a first run is not blank),
 * and each teammate's latest output.
 */
export function orgContext(agent: string, cwd?: string): OrgContext {
  const since = lastRunAt(agent, cwd);
  const all = messagesFor(agent, cwd, 100);
  const fresh = since === null ? all : all.filter((m) => m.ts > since);
  const older = all.filter((m) => !fresh.includes(m)).slice(0, 3);
  return {
    messages: [...fresh.slice(0, 8), ...older],
    outputs: teammateOutputs(agent, cwd),
    lastRunAt: since,
  };
}

/** One line per message for the board and the activity feed. */
export function describeMessage(m: OrgMessage): string {
  return `${m.from} to ${m.to === "*" ? "everyone" : m.to}: ${m.text}`;
}

// ---------------------------------------------------------------------------
// Live: notes that arrive during a run, questions that wait for an answer,
// and traces teammates can read while a run is still going
// ---------------------------------------------------------------------------

/**
 * Notes for this agent posted after a point in time, newest last, so the
 * runner can hand them to the agent as its next turn. Its own notes and
 * notes it has already seen (seq at or below the watermark) are left out.
 */
export function pendingNotesFor(agent: string, afterSeq: number, cwd?: string): OrgMessage[] {
  return messages(cwd, 1000)
    .filter((m) => m.seq > afterSeq && m.from !== agent && (m.to === agent || m.to === "*"))
    .sort((a, b) => a.seq - b.seq);
}

/** The reply to an ask, when one has been posted: by id, or any note from the asked agent to the asker after it. */
export function replyTo(ask: OrgMessage, cwd?: string): OrgMessage | null {
  const all = messages(cwd, 1000);
  return (
    all.find((m) => m.inReplyTo === ask.askId) ??
    all.find((m) => m.seq > ask.seq && m.from === ask.to && m.to === ask.from) ??
    null
  );
}

/** Where a run's live trace is written: one JSON line per event. */
export function runsDir(cwd?: string): string {
  return path.join(ceoDir(cwd), "runs");
}

export function tracePath(delegationId: string, cwd?: string): string {
  return path.join(runsDir(cwd), `${delegationId}.jsonl`);
}

/** Append one event to a run's trace. Never throws: a trace is a courtesy, the ledger is the record. */
export function traceAppend(delegationId: string, event: Record<string, unknown>, cwd?: string): void {
  try {
    mkdirSync(runsDir(cwd), { recursive: true });
    appendFileSync(tracePath(delegationId, cwd), JSON.stringify({ ts: Date.now(), ...event }) + "\n");
  } catch {
    /* a full disk or a read-only tree must not stop the run */
  }
}

export type LiveRun = {
  delegationId: string;
  agent: string;
  task: string;
  provider: string;
  startedAt: number;
  turn: number;
  /** False once the trace's last line says the run ended. */
  live: boolean;
  /** The last few things the agent said or did, oldest first. */
  tail: string[];
};

function readTrace(file: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((x): x is Record<string, unknown> => x !== null);
  } catch {
    return [];
  }
}

function traceLine(e: Record<string, unknown>): string | null {
  switch (e.type) {
    case "text":
      return String(e.text ?? "").trim() || null;
    case "tool":
      return `> ${String(e.summary ?? e.name ?? "tool")}`;
    case "denied":
      return `DENIED ${String(e.tool ?? "")}`;
    case "turn":
      return `[turn ${String(e.n ?? "?")}: ${String(e.reason ?? "")}]`;
    case "end":
      return `[ended: ${String(e.status ?? "")}]`;
    default:
      return null;
  }
}

/**
 * Runs with a trace on disk, newest first. A run is live until its trace
 * ends with an `end` line; a trace untouched for ten minutes with no end
 * line is a crash and is reported as not live.
 */
export function liveRuns(cwd?: string, opts: { tail?: number; includeEnded?: boolean } = {}): LiveRun[] {
  const dir = runsDir(cwd);
  if (!existsSync(dir)) return [];
  const tail = opts.tail ?? 6;
  const out: LiveRun[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    const events = readTrace(file);
    const meta = events.find((e) => e.type === "meta");
    if (!meta) continue;
    const last = events[events.length - 1];
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      /* gone */
    }
    const ended = last?.type === "end";
    const stale = Date.now() - mtime > 10 * 60_000;
    const live = !ended && !stale;
    if (!live && !opts.includeEnded) continue;
    const turns = events.filter((e) => e.type === "turn").length;
    const lines = events.map(traceLine).filter((l): l is string => l !== null);
    out.push({
      delegationId: name.replace(/\.jsonl$/, ""),
      agent: String(meta.agent ?? "?"),
      task: String(meta.task ?? ""),
      provider: String(meta.provider ?? ""),
      startedAt: Number(meta.ts ?? mtime) || mtime,
      turn: 1 + turns,
      live,
      tail: lines.slice(-tail),
    });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/** The trace of one agent's live run, or its latest, as lines. */
export function traceFor(agent: string, cwd?: string, lines = 40): { run: LiveRun; lines: string[] } | null {
  const run = liveRuns(cwd, { tail: lines, includeEnded: true }).find((r) => r.agent === agent);
  return run ? { run, lines: run.tail } : null;
}
