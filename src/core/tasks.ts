/**
 * Tasks: the org's work queue, as ledger objects.
 *
 * A delegation is an event: it starts, it ends, it cost something. A task is
 * the thing you wanted done, which exists before anyone is running it and
 * survives a run that failed. Without tasks the dashboard could show what the
 * org *did* but not what it is *for* right now. There was no queue, no
 * "blocked", no way to line up six things and hand them out as agents came
 * free.
 *
 * Tasks live in the ledger like everything else, as two event types:
 *
 *   task_add     id, title, assignee, priority
 *   task_update  id plus whichever of status / assignee / delegationId /
 *                note changed
 *
 * `listTasks()` replays them. There is no tasks.json cache because the list
 * is small and the replay is the same cost as the roster's.
 *
 * Stored status is one of queued / running / done / failed / cancelled.
 * `blocked` is never stored. It is derived at read time from the roster,
 * when the assignee is over budget or not in the org. Whether a task can
 * run is a fact about the org right now, not about the task. Storing it
 * would mean a budget raise had to go and edit every task it unblocked.
 *
 * A task links to its run through `delegationId`, the same id the
 * delegate_start / delegate_end pair carry. Cost is not copied onto the
 * task. The delegate_end entry is the record of what was spent, and a
 * second copy is a second thing that can disagree with it.
 */

import { randomBytes } from "node:crypto";
import { append, readLedger } from "./ledger.js";
import { readRoster } from "./roster.js";
import { isSandboxKind, type SandboxKind } from "./sandbox.js";
import { PROVIDERS, type Arm, type LedgerEntry, type Provider, type VerifierSpec } from "./types.js";

/** `verifying`: every attempt has ended and the verifiers are deciding. */
export type TaskStoredStatus = "queued" | "running" | "verifying" | "done" | "failed" | "cancelled";

/** Stored status, plus the derived `blocked`. */
export type TaskStatus = TaskStoredStatus | "blocked";

export type TaskPriority = "high" | "normal" | "low";

export const TASK_PRIORITIES: TaskPriority[] = ["high", "normal", "low"];

export type Task = {
  id: string;
  title: string;
  /** Agent name, or null for an unassigned task, which is blocked. */
  assignee: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  /** Why it is blocked, when it is. */
  blockedReason: string | null;
  createdAt: number;
  updatedAt: number;
  /** The delegation running this task, or the one that ran it. */
  delegationId: string | null;
  /** Settled cost of the linked delegation, looked up from delegate_end. */
  costUsd: number | null;
  /** Free text from the last update: an error, a hand-written outcome. */
  note: string | null;
  /** The agent that handed this task off, or null when a person queued it. */
  requestedBy: string | null;
  /**
   * Set when the chief of staff delegated the task from the chat. The
   * dashboard starts such a task when the chief's reply ends, which is the
   * operator's message acting as the authorization.
   */
  autoStart: boolean;
  /**
   * The provider this task runs on, when it differs from the assignee's own.
   * "Use gemini for the review" sets it. The agent stays where it is. Null
   * runs the task on the assignee's provider.
   */
  provider: Provider | null;
  /**
   * The checks that decide the task. A task with verifiers reaches done only
   * when an attempt passes them. A task without any is done when its run is.
   */
  verifiers: VerifierSpec[];
  /** How many attempts the dispatcher runs, each on its own arm and worktree. Default 1. */
  samples: number;
  /** Arms to try, when the operator named them. Empty lets the router choose. */
  arms: Arm[];
  /** What kind of work this is, for the router: review, ci, debug, feature, edit, research or explore. */
  kind: string | null;
  /** Where the task's runs execute: a container or a remote host. Null runs them on this machine. */
  sandbox: SandboxKind | null;
  /** Seq of the task_add entry, for cross-referencing. */
  seq: number;
};

function shortId(): string {
  return randomBytes(3).toString("hex");
}

type StoredTask = Omit<Task, "status" | "blockedReason" | "costUsd"> & {
  status: TaskStoredStatus;
};

export type { StoredTask };

/**
 * Replay every task event. No roster overlay, so `blocked` is never derived
 * here. That is `listTasks`. Exported for readers that already hold the
 * entries and only need counts, like the workspace sidebar.
 */
export function replayTaskEvents(entries: LedgerEntry[]): Map<string, StoredTask> {
  const tasks = new Map<string, StoredTask>();
  for (const e of entries) {
    if (e.type === "task_add") {
      const id = String(e.data.id ?? "");
      if (!id) continue;
      tasks.set(id, {
        id,
        title: String(e.data.title ?? ""),
        assignee: typeof e.data.assignee === "string" ? e.data.assignee : null,
        priority: TASK_PRIORITIES.includes(e.data.priority as TaskPriority)
          ? (e.data.priority as TaskPriority)
          : "normal",
        status: "queued",
        createdAt: e.ts,
        updatedAt: e.ts,
        delegationId: null,
        note: null,
        requestedBy: typeof e.data.requestedBy === "string" ? e.data.requestedBy : null,
        autoStart: e.data.autoStart === true,
        provider: PROVIDERS.includes(e.data.provider as Provider) ? (e.data.provider as Provider) : null,
        verifiers: Array.isArray(e.data.verifiers) ? (e.data.verifiers as VerifierSpec[]) : [],
        samples: Math.max(1, Math.floor(Number(e.data.samples ?? 1)) || 1),
        arms: Array.isArray(e.data.arms) ? (e.data.arms as Arm[]) : [],
        kind: typeof e.data.kind === "string" ? e.data.kind : null,
        sandbox: isSandboxKind(e.data.sandbox) && e.data.sandbox !== "local" ? e.data.sandbox : null,
        seq: e.seq,
      });
    } else if (e.type === "task_update") {
      const id = String(e.data.id ?? "");
      const t = tasks.get(id);
      if (!t) continue;
      if (typeof e.data.status === "string") t.status = e.data.status as TaskStoredStatus;
      if ("assignee" in e.data) {
        t.assignee = typeof e.data.assignee === "string" ? e.data.assignee : null;
      }
      if (typeof e.data.title === "string") t.title = e.data.title;
      if (TASK_PRIORITIES.includes(e.data.priority as TaskPriority)) {
        t.priority = e.data.priority as TaskPriority;
      }
      if (typeof e.data.delegationId === "string") t.delegationId = e.data.delegationId;
      if ("note" in e.data) t.note = typeof e.data.note === "string" ? e.data.note : null;
      if (Array.isArray(e.data.verifiers)) t.verifiers = e.data.verifiers as VerifierSpec[];
      if (e.data.samples !== undefined) t.samples = Math.max(1, Math.floor(Number(e.data.samples)) || 1);
      if (Array.isArray(e.data.arms)) t.arms = e.data.arms as Arm[];
      if (typeof e.data.kind === "string") t.kind = e.data.kind;
      t.updatedAt = e.ts;
    }
  }
  return tasks;
}

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

/**
 * Every task, with `blocked` derived and cost joined from the ledger.
 *
 * Order: running first, then queued/blocked by priority then age, then the
 * settled ones newest first. That is the order a queue is read in: what is
 * happening, what is next, what just finished.
 */
export function listTasks(cwd?: string): Task[] {
  const entries = readLedger(cwd);
  const stored = replayTaskEvents(entries);
  if (stored.size === 0) return [];

  const costs = new Map<string, number>();
  for (const e of entries) {
    if (e.type === "delegate_end") {
      const c = Number(e.data.costUsd ?? 0);
      if (Number.isFinite(c)) costs.set(String(e.data.id ?? ""), c);
    }
  }

  const agents = new Map(readRoster(cwd).agents.map((a) => [a.name, a]));

  const out: Task[] = [];
  for (const t of stored.values()) {
    let status: TaskStatus = t.status;
    let blockedReason: string | null = null;
    if (t.status === "queued") {
      if (!t.assignee) {
        status = "blocked";
        blockedReason = "unassigned";
      } else {
        const a = agents.get(t.assignee);
        if (!a) {
          status = "blocked";
          blockedReason = `${t.assignee} is not in the org`;
        } else if (a.budgetUsd > 0 && a.spentUsd >= a.budgetUsd) {
          status = "blocked";
          blockedReason = `${t.assignee} is at its budget cap`;
        }
      }
    }
    out.push({
      ...t,
      status,
      blockedReason,
      costUsd: t.delegationId ? costs.get(t.delegationId) ?? null : null,
    });
  }

  const rank = (s: TaskStatus) =>
    s === "running" || s === "verifying" ? 0 : s === "queued" ? 1 : s === "blocked" ? 2 : 3;
  out.sort((a, b) => {
    const r = rank(a.status) - rank(b.status);
    if (r !== 0) return r;
    if (rank(a.status) < 3) {
      const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (p !== 0) return p;
      return a.createdAt - b.createdAt;
    }
    return b.updatedAt - a.updatedAt;
  });
  return out;
}

export function findTask(id: string, cwd?: string): Task | null {
  return listTasks(cwd).find((t) => t.id === id) ?? null;
}

/** The task a delegation is running, if any. */
export function taskForDelegation(delegationId: string, cwd?: string): Task | null {
  return listTasks(cwd).find((t) => t.delegationId === delegationId) ?? null;
}

export function addTask(
  input: {
    title: string;
    assignee?: string | null;
    priority?: TaskPriority;
    requestedBy?: string | null;
    autoStart?: boolean;
    provider?: Provider | null;
    verifiers?: VerifierSpec[];
    samples?: number;
    arms?: Arm[];
    kind?: string | null;
    sandbox?: SandboxKind | null;
  },
  cwd?: string,
): Task {
  const title = input.title.replace(/\s+/g, " ").trim();
  if (title.length < 3) throw new Error("A task needs a title of at least 3 characters.");
  const assignee = input.assignee?.trim() || null;
  if (assignee && !readRoster(cwd).agents.some((a) => a.name === assignee)) {
    throw new Error(`No agent named "${assignee}" in the org. Leave it unassigned, or hire first.`);
  }
  const id = shortId();
  append(
    "task_add",
    assignee,
    {
      id,
      title,
      assignee,
      priority: input.priority ?? "normal",
      requestedBy: input.requestedBy ?? null,
      ...(input.autoStart ? { autoStart: true } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.verifiers && input.verifiers.length > 0 ? { verifiers: input.verifiers } : {}),
      ...(input.samples && input.samples > 1 ? { samples: Math.floor(input.samples) } : {}),
      ...(input.arms && input.arms.length > 0 ? { arms: input.arms } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.sandbox && input.sandbox !== "local" ? { sandbox: input.sandbox } : {}),
    },
    cwd,
  );
  return findTask(id, cwd)!;
}

/** Transitions that make sense. Anything else is refused with the reason. */
const ALLOWED: Record<TaskStoredStatus, TaskStoredStatus[]> = {
  queued: ["running", "cancelled", "done"],
  running: ["done", "failed", "cancelled", "queued", "verifying"],
  verifying: ["done", "failed", "queued", "cancelled"],
  done: ["queued"],
  failed: ["queued", "cancelled"],
  cancelled: ["queued"],
};

export function updateTask(
  id: string,
  changes: {
    status?: TaskStoredStatus;
    assignee?: string | null;
    title?: string;
    priority?: TaskPriority;
    delegationId?: string;
    note?: string | null;
    verifiers?: VerifierSpec[];
    samples?: number;
    arms?: Arm[];
    kind?: string | null;
  },
  cwd?: string,
): Task {
  const t = findTask(id, cwd);
  if (!t) throw new Error(`No task with id ${id}.`);

  const data: Record<string, unknown> = { id };
  const stored: TaskStoredStatus = t.status === "blocked" ? "queued" : t.status;

  if (changes.status && changes.status !== stored) {
    if (!ALLOWED[stored].includes(changes.status)) {
      throw new Error(`A ${stored} task cannot become ${changes.status}.`);
    }
    // A task decided by checks is done only through a promote, which only a
    // passing attempt earns. Nobody settles it by hand.
    if (changes.status === "done" && t.verifiers.length > 0) {
      const promoted = readLedger(cwd).some((e) => e.type === "promote" && e.data.taskId === id);
      if (!promoted) throw new Error(`Task ${id} has checks, so it is done only when an attempt passes them. ceo run ${id} runs it.`);
    }
    data.status = changes.status;
  }
  if (changes.assignee !== undefined) {
    const a = changes.assignee?.trim() || null;
    if (a && !readRoster(cwd).agents.some((x) => x.name === a)) {
      throw new Error(`No agent named "${a}" in the org.`);
    }
    data.assignee = a;
  }
  if (changes.title !== undefined) {
    const title = changes.title.replace(/\s+/g, " ").trim();
    if (title.length < 3) throw new Error("A task needs a title of at least 3 characters.");
    data.title = title;
  }
  if (changes.priority) data.priority = changes.priority;
  if (changes.delegationId) data.delegationId = changes.delegationId;
  if (changes.note !== undefined) data.note = changes.note;
  if (changes.verifiers !== undefined) data.verifiers = changes.verifiers;
  if (changes.samples !== undefined) data.samples = Math.max(1, Math.floor(changes.samples));
  if (changes.arms !== undefined) data.arms = changes.arms;
  if (changes.kind !== undefined && changes.kind !== null) data.kind = changes.kind;

  if (Object.keys(data).length === 1) return t;
  const agent = (data.assignee as string | null | undefined) ?? t.assignee;
  append("task_update", agent, data, cwd);
  return findTask(id, cwd)!;
}

/**
 * The next thing an idle agent should pick up: the highest-priority, oldest
 * queued task assigned to it. Blocked tasks are never returned. That is the
 * whole point of deriving the state.
 */
export function nextQueuedFor(agent: string, cwd?: string): Task | null {
  return listTasks(cwd).find((t) => t.status === "queued" && t.assignee === agent) ?? null;
}

/** Counts by status, for status bars. */
export function taskCounts(tasks: Task[]): Record<TaskStatus, number> {
  const c: Record<TaskStatus, number> = {
    queued: 0, running: 0, verifying: 0, blocked: 0, done: 0, failed: 0, cancelled: 0,
  };
  for (const t of tasks) c[t.status]++;
  return c;
}

/** Ids of tasks that are `running` but whose delegation has already ended. */
export function staleRunningTasks(cwd?: string): Task[] {
  const entries = readLedger(cwd);
  const ended = new Set(
    entries.filter((e) => e.type === "delegate_end").map((e) => String(e.data.id ?? "")),
  );
  return listTasks(cwd).filter(
    (t) => t.status === "running" && t.delegationId !== null && ended.has(t.delegationId),
  );
}
