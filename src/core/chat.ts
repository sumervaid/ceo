/**
 * The chat: a conversation with the org's chief of staff.
 *
 * The chief is an agent like any other. It has a name, a brief, a budget,
 * a level and a provider, and every message the operator sends is a run
 * under the chief's own cap. Two things set the chief apart.
 *
 *   The chief's own process is read-only on every provider. The chief reads
 *   the repository and the org. The chief never writes code. The team does.
 *
 *   The chief's level governs what the chief may do to the org, enforced by
 *   the org MCP server rather than by prompt wording. At observe the chief
 *   answers questions. At propose the chief queues work for the operator to
 *   start. At execute the chief hires, sets budgets and gives work that
 *   starts when the reply ends. At autonomous the chief may also fire an
 *   agent the chief hired. No level lets the chief change a level, or hire
 *   above execute.
 *
 *   The chief has no cap of its own. Each reply answers a message the
 *   operator typed, and the ledger records what each reply cost. The
 *   chief's budget field is instead an allowance: the money the chief may
 *   give other agents as budgets. A hire or a raise draws from it. A cut
 *   returns what the chief had given. The operator sets the allowance with
 *   `b` on the chief.
 *
 * Nothing here keeps state of its own. A conversation is read back from the
 * ledger: the chief's runs since the last `chat_new` note, each with the
 * operator's message as the task and the reply as the output, plus every
 * hire, task, note and fire the chief made while each run was open. So the
 * chat survives a restart, `ceo trace chief` replays it, and an audit sees
 * every staffing decision with the message that prompted it.
 *
 * A message resumes the CLI session of the previous reply when the provider
 * has not changed since. When it has, say after `v` moved the chief from
 * claude to codex, the new provider starts a fresh session and the prompt
 * carries a recap of the exchange so far. The conversation continues across
 * the provider line, which is the point of having one.
 */

import { readFileSync } from "node:fs";

import { append, readLedger } from "./ledger.js";
import { findChief, hire, readRoster } from "./roster.js";
import { providerReadiness } from "./setup.js";
import { listTasks, type Task } from "./tasks.js";
import { PROVIDERS, type AgentRecord, type AutonomyLevel, type LedgerEntry, type Provider } from "./types.js";

/** The name a new chief of staff gets when nobody has taken it. */
export const CHIEF_NAME = "chief";

/** The allowance a new chief of staff starts with: the money the chief may give other agents. */
export const CHIEF_ALLOWANCE_USD = 25;

export const CHIEF_BRIEF = [
  "Turn what the operator asks for into work the org does.",
  "Answer questions about the org from the roster, the board, the outputs and the live traces.",
  "When something needs doing, staff it. Give each piece to the teammate best placed for it, or hire one when nobody fits.",
  "Any role runs on any provider: claude, codex or gemini. Pick by the work and by what is ready, not by habit.",
  "Give every task a definition of done.",
  "Keep replies short: what was done, who is on it, the most it can cost, and what the operator should decide.",
].join(" ");

export const CHIEF_COLLABORATION = [
  "Prefer teammates already in the org, and say why when hiring instead.",
  "Never do the work yourself. Your own process is read-only, and the team is the point.",
  "Check org_running before giving work to a teammate who may be busy.",
].join(" ");

/** What the chief of staff may do to the org at a level. */
export type StaffingPolicy = {
  level: AutonomyLevel;
  /** Queue work for a teammate, started later by the operator. */
  queue: boolean;
  /** Hire, and set other agents' budgets, from the allowance, at levels up to execute. */
  hire: boolean;
  /** Give work that starts when the reply ends. */
  start: boolean;
  /** Fire an idle agent the chief hired. */
  fire: boolean;
  /** One line for the chat header. */
  label: string;
};

const STAFFING: Record<AutonomyLevel, StaffingPolicy> = {
  observe: { level: "observe", queue: false, hire: false, start: false, fire: false, label: "answers questions" },
  propose: { level: "propose", queue: true, hire: false, start: false, fire: false, label: "queues work for the operator" },
  execute: { level: "execute", queue: true, hire: true, start: true, fire: false, label: "hires, budgets and starts work" },
  autonomous: { level: "autonomous", queue: true, hire: true, start: true, fire: true, label: "hires, budgets, starts work and fires" },
};

export function staffingFor(level: AutonomyLevel): StaffingPolicy {
  return STAFFING[level] ?? STAFFING.execute;
}

/**
 * How many agents the chief may hire in one reply. No limit by default: the
 * allowance already bounds what the chief can spend on hires.
 * `CEO_CHIEF_MAX_HIRES` sets a limit.
 */
export function chiefMaxHiresPerReply(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CEO_CHIEF_MAX_HIRES?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : Infinity;
}

/** The level a hire by the chief may have at most: execute, and never above the chief's own. */
export function maxHireLevel(chiefLevel: AutonomyLevel): AutonomyLevel {
  return chiefLevel === "autonomous" ? "execute" : chiefLevel;
}

/**
 * The paragraph that replaces the autonomy section in the chief's prompt.
 * The server enforces every sentence of it. The prompt only tells the chief
 * where the walls are so the chief does not walk into them.
 */
export function staffingPrompt(level: AutonomyLevel, env: NodeJS.ProcessEnv = process.env): string {
  const p = staffingFor(level);
  const lines = [
    "Your own process is read-only. You can read the repository and the org. You cannot write files or run commands that change anything.",
  ];
  if (!p.queue) {
    lines.push("At observe, you answer questions about the org. You cannot queue work, hire, start runs or fire.");
  } else if (!p.hire) {
    lines.push("At propose, you may queue work with org_handoff. The operator starts it. You cannot hire, start runs or fire.");
  } else {
    lines.push(
      Number.isFinite(chiefMaxHiresPerReply(env))
        ? `You may hire with org_hire, at most ${chiefMaxHiresPerReply(env)} per reply, at levels up to ${maxHireLevel(level)}.`
        : `You may hire with org_hire, as many as the work needs, at levels up to ${maxHireLevel(level)}. org_hire with a count hires a swarm of identical agents in one call.`,
      "Budgets come from your allowance, the money the operator lets you give other agents. A hire's budget draws from it. org_budget raises or cuts any agent's budget, and a cut returns what you had given. org_roster shows what is left.",
      "You may give work with org_delegate. The work starts when your reply ends, under the assignee's own budget and level.",
      "When the operator names a provider for a piece of work, use it: org_delegate takes a provider and runs that task there, and org_hire hires on it.",
      "org_handoff queues work that waits for the operator instead.",
      "Staffing follows the router's evidence. org_router shows which arm wins for a kind of work.",
    );
    lines.push(
      p.fire
        ? "You may fire an idle agent you hired yourself with org_fire."
        : "You cannot fire anyone.",
    );
  }
  lines.push("Your own replies have no cap. No level lets you change a level, or settle a cost.");
  return lines.join(" ");
}

/** The first ready provider, in the order claude, codex, gemini. Claude when none is ready. */
export function preferredProvider(): Provider {
  for (const p of PROVIDERS) {
    try {
      if (providerReadiness(p).ready) return p;
    } catch {
      /* an unreadable provider is not a ready one */
    }
  }
  return "claude";
}

/**
 * The chief of staff, hired with the defaults when the org has none yet.
 * The name is `chief` unless an ordinary agent already holds it.
 */
export function ensureChief(cwd?: string, opts: { provider?: Provider } = {}): { agent: AgentRecord; hired: boolean } {
  const sitting = findChief(cwd);
  if (sitting) return { agent: sitting, hired: false };
  const taken = new Set(readRoster(cwd).agents.map((a) => a.name));
  let name = CHIEF_NAME;
  for (let i = 2; taken.has(name); i++) name = i === 2 ? "chief-of-staff" : `chief-${i}`;
  const agent = hire(
    {
      name,
      role: CHIEF_BRIEF,
      collaboration: CHIEF_COLLABORATION,
      provider: opts.provider ?? preferredProvider(),
      budgetUsd: CHIEF_ALLOWANCE_USD,
      autonomy: "execute",
      isolated: false,
      chief: true,
    },
    cwd,
  );
  return { agent, hired: true };
}

/** Start a new conversation. The next message opens a fresh session with no recap. */
export function newConversation(chief: string, cwd?: string): void {
  append("note", chief, { kind: "chat_new", chief }, cwd);
}

/** Something the chief did to the org during a reply, read from the ledger. */
export type ChatAction = {
  seq: number;
  ts: number;
  kind: "hire" | "delegate" | "handoff" | "fire" | "post" | "ask" | "budget";
  /** The teammate the action concerns. */
  agent: string;
  /** What to show beside it: a task title, a note, a hire's terms. */
  text: string;
  /** For a delegate or handoff, the task it created. */
  taskId: string | null;
  /** For a hire, the provider the new agent runs on. */
  provider: Provider | null;
};

export type ChatTurn = {
  /** The delegation id of the chief's run. */
  id: string;
  ts: number;
  /** What the operator wrote. */
  message: string;
  /** The chief's answer, or the error when the run failed. */
  reply: string;
  status: "running" | "done" | "failed" | "cancelled";
  provider: Provider | null;
  model: string | null;
  costUsd: number;
  costIsEstimate: boolean;
  /** The CLI session, for resuming. */
  sessionId: string | null;
  actions: ChatAction[];
  startSeq: number;
  endSeq: number | null;
};

export type Conversation = {
  chief: string;
  /** Seq of the `chat_new` note that opened it, or 0 for the org's first. */
  startSeq: number;
  turns: ChatTurn[];
  /** What the chief's replies cost. */
  chiefCostUsd: number;
  /** What the runs the chief started or queued cost, so far. */
  teamCostUsd: number;
  /** Runs of teammates that came out of this conversation. */
  teamRuns: number;
};

/** The body of an archived output, below its header. */
function outputBody(outputPath: unknown, maxChars = 20000): string {
  if (typeof outputPath !== "string" || !outputPath) return "";
  try {
    const raw = readFileSync(outputPath, "utf8");
    const i = raw.indexOf("\n## Output\n");
    const body = (i >= 0 ? raw.slice(i + "\n## Output\n".length) : raw).replace(/^\n+/, "").trimEnd();
    return body.length > maxChars ? body.slice(0, maxChars) : body;
  } catch {
    return "";
  }
}

function actionFor(e: LedgerEntry, chief: string): ChatAction | null {
  const base = { seq: e.seq, ts: e.ts, taskId: null, provider: null };
  if (e.type === "hire" && e.data.by === chief && e.agent) {
    const budget = Number(e.data.budgetUsd ?? 0);
    const model = String(e.data.model ?? "");
    // A model named after its provider says nothing the provider column did not.
    const terms = [model && model !== e.data.provider ? model : null, String(e.data.autonomy ?? "execute"), `$${Number.isInteger(budget) ? budget : budget.toFixed(2)} budget`];
    return {
      ...base,
      kind: "hire",
      agent: e.agent,
      text: terms.filter(Boolean).join(" · "),
      provider: (e.data.provider as Provider) ?? null,
    };
  }
  if (e.type === "task_add" && e.data.requestedBy === chief) {
    return {
      ...base,
      kind: e.data.autoStart === true ? "delegate" : "handoff",
      agent: typeof e.data.assignee === "string" ? e.data.assignee : "unassigned",
      text: String(e.data.title ?? ""),
      taskId: typeof e.data.id === "string" ? e.data.id : null,
      provider: (e.data.provider as Provider) ?? null,
    };
  }
  if (e.type === "budget_set" && e.data.by === chief && e.agent) {
    const now = Number(e.data.budgetUsd ?? 0);
    const was = Number(e.data.previousUsd ?? 0);
    const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
    return { ...base, kind: "budget", agent: e.agent, text: `budget ${usd(now)}, was ${usd(was)}` };
  }
  if (e.type === "fire" && e.data.by === chief && e.agent) {
    return { ...base, kind: "fire", agent: e.agent, text: String(e.data.reason ?? "") };
  }
  if (e.type === "note" && e.data.kind === "message" && e.data.from === chief) {
    return {
      ...base,
      kind: e.data.askId ? "ask" : "post",
      agent: String(e.data.to ?? "*"),
      text: String(e.data.text ?? ""),
    };
  }
  return null;
}

/**
 * The current conversation with the chief, read back from the ledger.
 * `entries` lets a caller that already holds the ledger skip a re-read.
 */
export function conversation(chief: string, cwd?: string, entries: LedgerEntry[] = readLedger(cwd)): Conversation {
  let startSeq = 0;
  for (const e of entries) {
    if (e.type === "note" && e.data.kind === "chat_new" && e.data.chief === chief) startSeq = e.seq;
  }

  const turns: ChatTurn[] = [];
  const open = new Map<string, ChatTurn>();
  const costById = new Map<string, number>();
  const chiefTaskIds = new Set<string>();

  for (const e of entries) {
    if (e.type === "delegate_end") costById.set(String(e.data.id ?? ""), Number(e.data.costUsd ?? 0) || 0);
    if (e.seq <= startSeq) continue;

    if (e.type === "delegate_start" && e.agent === chief) {
      const turn: ChatTurn = {
        id: String(e.data.id ?? ""),
        ts: e.ts,
        message: String(e.data.task ?? ""),
        reply: "",
        status: "running",
        provider: (e.data.provider as Provider) ?? null,
        model: typeof e.data.model === "string" ? e.data.model : null,
        costUsd: 0,
        costIsEstimate: false,
        sessionId: null,
        actions: [],
        startSeq: e.seq,
        endSeq: null,
      };
      turns.push(turn);
      open.set(turn.id, turn);
      continue;
    }
    if (e.type === "delegate_end" && e.agent === chief) {
      const turn = open.get(String(e.data.id ?? ""));
      if (!turn) continue;
      open.delete(turn.id);
      const outcome = e.data.outcome;
      turn.status = outcome === "failed" || outcome === "cancelled" ? outcome : "done";
      turn.reply = outputBody(e.data.outputPath);
      turn.costUsd = Number(e.data.costUsd ?? 0) || 0;
      turn.costIsEstimate = e.data.costIsEstimate === true;
      turn.sessionId = typeof e.data.sessionId === "string" ? e.data.sessionId : null;
      turn.endSeq = e.seq;
      continue;
    }

    const action = actionFor(e, chief);
    if (!action) continue;
    if (action.taskId) chiefTaskIds.add(action.taskId);
    // An action belongs to the chief's run that was open when it was written.
    // The org server writes while the run is live, so that is the reply that
    // made it. One left outside any run is shown on the latest one.
    const owner = [...open.values()].pop() ?? turns[turns.length - 1];
    if (owner) owner.actions.push(action);
  }

  let teamCostUsd = 0;
  let teamRuns = 0;
  if (chiefTaskIds.size > 0) {
    for (const t of listTasks(cwd)) {
      if (!chiefTaskIds.has(t.id) || !t.delegationId) continue;
      teamRuns++;
      teamCostUsd += costById.get(t.delegationId) ?? 0;
    }
  }

  return {
    chief,
    startSeq,
    turns,
    chiefCostUsd: turns.reduce((n, t) => n + t.costUsd, 0),
    teamCostUsd,
    teamRuns,
  };
}

/**
 * The session the next message should resume, or null for a fresh one.
 * Only a session opened by the provider the chief runs on now can resume.
 */
export function resumableSession(conv: Conversation, chief: AgentRecord): string | null {
  for (let i = conv.turns.length - 1; i >= 0; i--) {
    const t = conv.turns[i];
    if (t.status === "running") continue;
    // A failed reply may have failed because the session could not be
    // resumed. Resuming it again would fail the same way, so the next
    // message starts fresh and carries the recap instead.
    if (t.status !== "done" || !t.sessionId) return null;
    return t.provider === chief.provider ? t.sessionId : null;
  }
  return null;
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/**
 * What happened in the org since the chief's last reply: runs that finished
 * and notes addressed to the chief. A resumed session keeps the system
 * prompt from its first turn, so without this the chief would not know the
 * work it handed out had come back.
 */
export function sinceLastReply(conv: Conversation, cwd?: string, entries: LedgerEntry[] = readLedger(cwd)): string[] {
  const last = [...conv.turns].reverse().find((t) => t.endSeq !== null);
  if (!last || last.endSeq === null) return [];
  const after = last.endSeq;
  const starts = new Map<string, LedgerEntry>();
  const lines: string[] = [];
  for (const e of entries) {
    if (e.type === "delegate_start") starts.set(String(e.data.id ?? ""), e);
    if (e.seq <= after) continue;
    if (e.type === "delegate_end" && e.agent && e.agent !== conv.chief) {
      const start = starts.get(String(e.data.id ?? ""));
      const failed = e.data.outcome === "failed" || e.data.outcome === "cancelled";
      const body = clip(outputBody(e.data.outputPath, 2000), 400);
      const cost = Number(e.data.costUsd ?? 0) || 0;
      lines.push(
        `- ${e.agent} ${failed ? String(e.data.outcome) : "finished"} "${clip(String(start?.data.task ?? ""), 80)}" for $${cost.toFixed(cost < 0.01 ? 4 : 2)}${body ? `: ${body}` : ""}`,
      );
    } else if (e.type === "note" && e.data.kind === "message" && e.data.from !== conv.chief && (e.data.to === conv.chief || e.data.to === "*")) {
      lines.push(`- ${String(e.data.from)} posted: ${clip(String(e.data.text ?? ""), 300)}`);
    }
  }
  return lines.slice(-12);
}

/**
 * The prompt for one message. The ledger records the operator's words as
 * the task. The process receives this: the words, what changed in the org
 * since the last reply, and, when the session could not be resumed, a
 * recap of the exchange so far.
 */
export function chatPrompt(message: string, conv: Conversation, chief: AgentRecord, cwd?: string): string {
  const resuming = resumableSession(conv, chief) !== null;
  const done = conv.turns.filter((t) => t.status !== "running");
  const parts: string[] = [];

  if (!resuming && done.length > 0) {
    const from = [...new Set(done.map((t) => t.provider).filter(Boolean))].join(" and ");
    parts.push(
      `This conversation began earlier${from && from !== chief.provider ? ` on ${from}` : ""}. The exchange so far, oldest first:`,
      "",
      ...done.slice(-8).flatMap((t) => [`Operator: ${clip(t.message, 600)}`, `You: ${clip(t.reply || `[${t.status}]`, 900)}`, ""]),
    );
  }

  const since = sinceLastReply(conv, cwd);
  if (since.length > 0) parts.push("Since your last reply:", ...since, "");

  if (parts.length === 0) return message;
  parts.push("The operator says:", "", message);
  return parts.join("\n");
}

/**
 * Tasks the chief delegated during one reply that are still queued: the
 * work the dashboard starts when the reply ends.
 */
export function startableAfter(conv: Conversation, delegationId: string, cwd?: string): Task[] {
  const turn = conv.turns.find((t) => t.id === delegationId);
  if (!turn) return [];
  const ids = new Set(turn.actions.filter((a) => a.kind === "delegate" && a.taskId).map((a) => a.taskId as string));
  if (ids.size === 0) return [];
  return listTasks(cwd).filter((t) => ids.has(t.id) && t.status === "queued" && t.assignee);
}

/** The chief's allowance: what the operator lets the chief give, and what is left. */
export type Allowance = {
  totalUsd: number;
  /** What the chief's grants add up to across the agents in the org now. */
  givenUsd: number;
  leftUsd: number;
  /** Each agent's share that came from the chief. */
  given: Map<string, number>;
};

/**
 * Replay the ledger for the chief's grants. Each agent has a base, the
 * budget the operator gave, and a current budget. The chief's share of an
 * agent is the part of the current budget above the base. An agent the
 * chief hired has a base of zero. A cut by the chief shrinks the share and
 * so returns money to the allowance. A fired agent's share returns whole.
 */
export function allowanceOf(chief: AgentRecord, cwd?: string, entries: LedgerEntry[] = readLedger(cwd)): Allowance {
  const base = new Map<string, number>();
  const current = new Map<string, number>();
  for (const e of entries) {
    if (!e.agent || e.agent === chief.name) continue;
    if (e.type === "hire") {
      const b = Number(e.data.budgetUsd ?? 0) || 0;
      current.set(e.agent, b);
      base.set(e.agent, e.data.by === chief.name ? 0 : b);
    } else if (e.type === "budget_set") {
      const b = Number(e.data.budgetUsd ?? 0) || 0;
      current.set(e.agent, b);
      if (e.data.by !== chief.name) base.set(e.agent, b);
    } else if (e.type === "fire") {
      current.delete(e.agent);
      base.delete(e.agent);
    }
  }
  const given = new Map<string, number>();
  let givenUsd = 0;
  for (const [agent, b] of current) {
    const share = Math.max(0, b - (base.get(agent) ?? 0));
    if (share > 0) {
      given.set(agent, share);
      givenUsd += share;
    }
  }
  const totalUsd = Math.max(0, chief.budgetUsd);
  return { totalUsd, givenUsd, leftUsd: Math.max(0, totalUsd - givenUsd), given };
}

/** "$9 of $25 left to give" */
export function describeAllowance(a: Allowance): string {
  const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
  return `${usd(a.leftUsd)} of ${usd(a.totalUsd)} left to give`;
}
