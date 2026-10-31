/**
 * Outcomes: the unit of a budget is a verified result, with dollars kept as a column.
 *
 * The ledger already records every attempt, every check and every promotion.
 * This module reads those events in one pass and answers the question a
 * company asks: how much compute bought one verified outcome. The answer
 * decides where the next dispatch slot goes.
 *
 *   attempts        started attempts, plus plain tasks that ran once
 *   finished        attempts that ended done, plus plain tasks that reached done
 *   verified        promotions
 *   unverified      plain tasks that reached done with no verifier to say so
 *   failedTasks     tasks that settled failed
 *   spentUsd        attempt costs plus the cost of delegations outside any attempt
 *   usdPerVerified  spentUsd over verified, null while nothing is verified
 *   passRate        verified over verified plus failed tasks, null while both are zero
 *
 * The per-workspace outcome budget is a ledger note of kind `outcome_budget`.
 * The latest one wins. `attempts` caps the attempts started in the period.
 * `verified` is a target. Once the target is met, new attempts are refused.
 * Dollars stay a column here. Agent budgets still cap dollars.
 *
 * Importing this module registers the attempt gate. A process that starts
 * attempts imports the module first.
 */

import { attemptGates } from "./attempts.js";
import { append, readLedger } from "./ledger.js";
import { replayTaskEvents } from "./tasks.js";
import { armLabel, type Arm, type LedgerEntry } from "./types.js";

export type OutcomeRow = { label: string; attempts: number; verified: number; usd: number };

export type OutcomeStats = {
  attempts: number;
  finished: number;
  verified: number;
  unverified: number;
  failedTasks: number;
  spentUsd: number;
  usdPerVerified: number | null;
  passRate: number | null;
  byArm: OutcomeRow[];
  byAgent: OutcomeRow[];
};

export type OutcomePeriod = "all" | "day";

export type OutcomeBudget = {
  /** Cap on attempts started in the period. Null is no cap. */
  attempts: number | null;
  /** Target of verified outcomes in the period. Null is no target. */
  verified: number | null;
  period: OutcomePeriod;
};

/** Midnight local time today, in ms epoch. */
function startOfDay(now: number = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function cost(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function armOf(data: Record<string, unknown>): string {
  const arm = data.arm as Arm | undefined;
  if (arm && typeof arm.provider === "string") return armLabel(arm);
  const provider = typeof data.provider === "string" ? data.provider : "";
  const model = typeof data.model === "string" ? data.model : "";
  return [provider, model].filter(Boolean).join(" ") || "plain";
}

function rowOf(rows: Map<string, OutcomeRow>, label: string): OutcomeRow {
  let r = rows.get(label);
  if (!r) {
    r = { label, attempts: 0, verified: 0, usd: 0 };
    rows.set(label, r);
  }
  return r;
}

function sorted(rows: Map<string, OutcomeRow>): OutcomeRow[] {
  return [...rows.values()].sort((a, b) => b.attempts - a.attempts || b.usd - a.usd || a.label.localeCompare(b.label));
}

/** Outcome statistics from entries already in hand, for readers that hold the ledger. */
export function outcomeStatsFromEntries(entries: LedgerEntry[], since = 0): OutcomeStats {
  const attemptTasks = new Set<string>();
  const attempts = new Map<string, { agent: string; arm: string; ts: number; ended: boolean; done: boolean; costUsd: number }>();
  const delegations = new Map<string, { agent: string; attemptId: string | null; label: string; ts: number }>();
  const delegationCost = new Map<string, number>();
  const attemptDelegationCost = new Map<string, number>();
  const promotes: LedgerEntry[] = [];

  for (const e of entries) {
    if (e.type === "attempt_start") {
      const id = String(e.data.attemptId ?? "");
      attemptTasks.add(String(e.data.taskId ?? ""));
      attempts.set(id, { agent: String(e.data.agent ?? e.agent ?? ""), arm: armOf(e.data), ts: e.ts, ended: false, done: false, costUsd: 0 });
    } else if (e.type === "attempt_end") {
      const a = attempts.get(String(e.data.attemptId ?? ""));
      if (!a) continue;
      a.ended = true;
      a.done = e.data.outcome === "done";
      a.costUsd = cost(e.data.costUsd);
    } else if (e.type === "delegate_start") {
      const attemptId = typeof e.data.attemptId === "string" ? e.data.attemptId : null;
      delegations.set(String(e.data.id ?? ""), { agent: e.agent ?? "", attemptId, label: armOf(e.data), ts: e.ts });
    } else if (e.type === "delegate_end") {
      delegationCost.set(String(e.data.id ?? ""), cost(e.data.costUsd));
    } else if (e.type === "promote" && typeof e.data.taskId === "string" && e.ts >= since) {
      promotes.push(e);
    }
  }
  // A run that spent money is never recorded as free: an attempt with no
  // attempt_end, or a zero there, takes the settled cost of the run itself.
  for (const [id, d] of delegations) {
    if (d.attemptId && delegationCost.has(id)) attemptDelegationCost.set(d.attemptId, delegationCost.get(id)!);
  }

  const byArm = new Map<string, OutcomeRow>();
  const byAgent = new Map<string, OutcomeRow>();
  const s: OutcomeStats = { attempts: 0, finished: 0, verified: 0, unverified: 0, failedTasks: 0, spentUsd: 0, usdPerVerified: null, passRate: null, byArm: [], byAgent: [] };

  const count = (arm: string, agent: string, field: "attempts" | "verified") => {
    rowOf(byArm, arm)[field]++;
    rowOf(byAgent, agent)[field]++;
  };
  const spend = (arm: string, agent: string, usd: number) => {
    rowOf(byArm, arm).usd += usd;
    rowOf(byAgent, agent).usd += usd;
    s.spentUsd += usd;
  };

  for (const [id, a] of attempts) {
    if (a.ts < since) continue;
    s.attempts++;
    if (a.done) s.finished++;
    count(a.arm, a.agent, "attempts");
    spend(a.arm, a.agent, Math.max(a.costUsd, attemptDelegationCost.get(id) ?? 0));
  }

  for (const [id, d] of delegations) {
    if (d.attemptId || d.ts < since || !delegationCost.has(id)) continue;
    spend(d.label, d.agent, delegationCost.get(id)!);
  }

  for (const p of promotes) {
    s.verified++;
    const attempt = attempts.get(String(p.data.attemptId ?? ""));
    count(armOf(p.data), p.agent ?? attempt?.agent ?? "", "verified");
  }

  for (const t of replayTaskEvents(entries).values()) {
    if (t.updatedAt < since) continue;
    if (t.status === "failed") s.failedTasks++;
    if (attemptTasks.has(t.id)) continue;
    if (t.status !== "done" && t.status !== "failed") continue;
    const start = t.delegationId ? delegations.get(t.delegationId) : undefined;
    const arm = start?.label ?? "plain";
    const agent = t.assignee ?? "unassigned";
    s.attempts++;
    count(arm, agent, "attempts");
    if (t.status !== "done") continue;
    s.finished++;
    // A task with checks reaches done only through a promote, counted above.
    s.unverified++;
  }

  s.usdPerVerified = s.verified > 0 ? s.spentUsd / s.verified : null;
  s.passRate = s.verified + s.failedTasks > 0 ? s.verified / (s.verified + s.failedTasks) : null;
  s.byArm = sorted(byArm);
  s.byAgent = sorted(byAgent);
  return s;
}

/** Outcome statistics for a workspace, from `since` ms epoch onward. */
export function outcomeStats(cwd?: string, since = 0): OutcomeStats {
  return outcomeStatsFromEntries(readLedger(cwd), since);
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

function wholeOrNull(value: unknown): number | null {
  const n = Number(value);
  return value !== null && value !== undefined && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** The latest outcome budget of a workspace, or the open one when none was set. */
export function outcomeBudget(cwd?: string): OutcomeBudget {
  let b: OutcomeBudget = { attempts: null, verified: null, period: "all" };
  for (const e of readLedger(cwd)) {
    if (e.type !== "note" || e.data.kind !== "outcome_budget") continue;
    b = { attempts: wholeOrNull(e.data.attempts), verified: wholeOrNull(e.data.verified), period: e.data.period === "day" ? "day" : "all" };
  }
  return b;
}

/** Record a budget. Fields left out read as no cap and the whole period. */
export function setOutcomeBudget(b: { attempts?: number | null; verified?: number | null; period?: OutcomePeriod }, cwd?: string): OutcomeBudget {
  const next: OutcomeBudget = { attempts: wholeOrNull(b.attempts), verified: wholeOrNull(b.verified), period: b.period === "day" ? "day" : "all" };
  append("note", null, { kind: "outcome_budget", ...next }, cwd);
  return next;
}

/** Why `n` more attempts may not start in this workspace, or null when they may. */
export function outcomeRefusal(cwd: string | undefined, n = 1): string | null {
  const b = outcomeBudget(cwd);
  if (b.attempts === null && b.verified === null) return null;
  const stats = outcomeStats(cwd, b.period === "day" ? startOfDay() : 0);
  const per = b.period === "day" ? " per day" : "";
  if (b.verified !== null && stats.verified >= b.verified) {
    return `The target of ${b.verified} verified outcomes${per} is met with ${stats.verified} verified. No new attempts start.`;
  }
  if (b.attempts !== null && stats.attempts + n > b.attempts) {
    return `The budget allows ${b.attempts} attempts${per}. ${stats.attempts} have started and ${n} more would pass the cap.`;
  }
  return null;
}

attemptGates.push((_task, n, cwd) => outcomeRefusal(cwd, n));

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

export type AllocationRow = { path: string; usdPerVerified: number | null };

/** The cheapest cost per verified outcome counted as real, so a free run does not take every slot. */
const COST_FLOOR = 0.01;

/**
 * A share per row. Weight is the inverse of dollars per verified outcome.
 * A row with nothing verified yet takes the median weight, which keeps an
 * unproven workspace exploring. Shares sum to one, in input order.
 */
function shares(rows: AllocationRow[]): number[] {
  const known = rows.filter((r) => r.usdPerVerified !== null).map((r) => 1 / Math.max(COST_FLOOR, r.usdPerVerified!)).sort((a, b) => a - b);
  const mid = Math.floor(known.length / 2);
  const median = known.length === 0 ? 1 : known.length % 2 ? known[mid] : (known[mid - 1] + known[mid]) / 2;
  const weights = rows.map((r) => (r.usdPerVerified === null ? median : 1 / Math.max(COST_FLOOR, r.usdPerVerified)));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (total > 0 ? w / total : 1 / rows.length));
}

/** Workspaces ordered by share, highest first. Ties keep input order. */
export function allocation(workspaces: Array<{ path: string; stats: Pick<OutcomeStats, "usdPerVerified"> }>): Array<{ path: string; share: number }> {
  const rows = workspaces.map((w) => ({ path: w.path, usdPerVerified: w.stats.usdPerVerified }));
  const s = shares(rows);
  return rows.map((r, i) => ({ path: r.path, share: s[i], i })).sort((a, b) => b.share - a.share || a.i - b.i).map(({ path, share }) => ({ path, share }));
}

/**
 * Dispatch slots per workspace, cheapest per verified outcome first.
 * A null `totalSlots` means no ceiling, so every row gets Infinity and only
 * the order applies. With a finite total, each row gets one slot while the
 * total allows, and the rest follow the shares by largest remainder.
 */
export function dispatchOrder(rows: AllocationRow[], totalSlots: number | null): Array<{ path: string; slots: number }> {
  const k = rows.length;
  if (k === 0) return [];
  const s = shares(rows);
  const order = rows.map((r, i) => ({ path: r.path, share: s[i], i })).sort((a, b) => b.share - a.share || a.i - b.i);
  if (totalSlots === null || !Number.isFinite(totalSlots)) return order.map((o) => ({ path: o.path, slots: Infinity }));

  const total = Math.max(0, Math.floor(totalSlots));
  const slots = new Map<number, number>(order.map((o) => [o.i, 0]));
  if (total <= k) {
    for (const o of order.slice(0, total)) slots.set(o.i, 1);
  } else {
    const rest = total - k;
    const quotas = order.map((o) => ({ o, quota: o.share * rest }));
    let given = 0;
    for (const q of quotas) {
      const whole = Math.floor(q.quota);
      slots.set(q.o.i, 1 + whole);
      given += whole;
    }
    const byRemainder = [...quotas].sort((a, b) => (b.quota % 1) - (a.quota % 1) || a.o.i - b.o.i);
    for (const q of byRemainder.slice(0, rest - given)) slots.set(q.o.i, slots.get(q.o.i)! + 1);
  }
  return order.map((o) => ({ path: o.path, slots: slots.get(o.i)! }));
}

/**
 * The dispatch plan for one tick: workspaces the budget still allows,
 * ordered and sized by cost per verified outcome. A workspace whose ledger
 * cannot be read joins as unproven.
 */
export function dispatchPlan(paths: string[], available: number | null): Array<{ path: string; slots: number }> {
  const rows: AllocationRow[] = [];
  for (const path of paths) {
    try {
      if (outcomeRefusal(path)) continue;
      rows.push({ path, usdPerVerified: outcomeStats(path).usdPerVerified });
    } catch {
      rows.push({ path, usdPerVerified: null });
    }
  }
  return dispatchOrder(rows, available);
}
