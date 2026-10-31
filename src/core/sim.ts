/**
 * The simulated backend: attempts drawn from a model with known parameters.
 *
 * A real run answers a question at a price. A simulated run answers the
 * same question for nothing, with the answer known in advance. The second
 * property matters more. The analysis runs on a simulated experiment with
 * planted effects and has to recover them. An analysis that misses a
 * planted effect cannot be trusted with a real one.
 *
 * The model, for cell c, task j, arm k and attempt i:
 *
 *   p(j,k)  = logistic(ability(k) - difficulty(j) + u(j,k))
 *   z(i)    = sqrt(rho) * v(c) + sqrt(1 - rho) * e(i)
 *   pass(i) = Phi(z(i)) < p'(j,k)
 *
 * u(j,k) is fixed per task and arm. Some arms are better at some tasks,
 * which is what makes mixing providers pay. v(c) is shared by every
 * attempt in one run. Runs go well or badly as a whole, and rho sets how
 * much. On its own an attempt passes with probability p.
 *
 * A team changes three things. p' adds a synergy term on the logit scale,
 * growing with log2 of the team size. A pass can be undone by a conflict
 * with a peer. Every attempt pays for coordination in minutes and dollars.
 * The independent condition has none of these.
 *
 * Random numbers are common across conditions. Cell (size, seed, task)
 * draws the same v and e in every condition, so a difference between two
 * conditions is the effect of the condition, not the luck of the draw.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { chainEntries } from "./ledger.js";
import type { Arm, LedgerEventType } from "./types.js";

export type SimArm = Arm & {
  /** Skill on the logit scale. 0 solves a task of difficulty 0 half the time. */
  ability: number;
  /** Mean dollars per attempt. */
  costUsd: number;
  /** Median minutes per attempt. */
  minutes: number;
};

export type SimTeam = {
  /** Logit added per doubling of team size. */
  synergy: number;
  /** The chance, per peer, that a pass is undone by a conflict. */
  conflictRate: number;
  /** Minutes added to each attempt per peer. */
  overheadMinutes: number;
  /** Dollars added to each attempt per peer. */
  messageUsd: number;
};

export type SimParams = {
  arms: SimArm[];
  /** Mean task difficulty on the logit scale, for tasks that give none. */
  taskMean: number;
  /** Spread of task difficulty. */
  taskSpread: number;
  /** How much an arm's skill moves from task to task. */
  armTaskSpread: number;
  /** Correlation between attempts in one run. */
  runCorrelation: number;
  /** The chance that a pass on the visible checks fails the held-out ones. */
  overfit: number;
  /** Attempts running at once. Null for no cap. */
  maxRunning: number | null;
  team: SimTeam;
};

export const DEFAULT_SIM: SimParams = {
  arms: [
    { provider: "claude", model: "claude-sonnet-5", ability: 0.3, costUsd: 0.4, minutes: 6 },
    { provider: "codex", model: "gpt-5-codex", ability: 0.1, costUsd: 0.3, minutes: 8 },
    { provider: "gemini", model: "gemini", ability: -0.2, costUsd: 0.2, minutes: 5 },
  ],
  taskMean: 1.5,
  taskSpread: 1.2,
  armTaskSpread: 1.0,
  runCorrelation: 0.3,
  overfit: 0.1,
  maxRunning: null,
  team: { synergy: 0.15, conflictRate: 0.02, overheadMinutes: 0.5, messageUsd: 0.02 },
};

export type SimParamsInput = Partial<Omit<SimParams, "team">> & { team?: Partial<SimTeam> };

/** Fill in defaults and check ranges. Throws with the field at fault. */
export function simParams(input: SimParamsInput = {}): SimParams {
  const p: SimParams = { ...DEFAULT_SIM, ...input, team: { ...DEFAULT_SIM.team, ...(input.team ?? {}) } };
  if (!Array.isArray(p.arms) || p.arms.length === 0) throw new Error("sim.arms needs at least one arm.");
  const unit = (v: number, name: string) => {
    if (!(v >= 0 && v < 1)) throw new Error(`${name} must be at least 0 and below 1.`);
  };
  unit(p.runCorrelation, "sim.runCorrelation");
  unit(p.overfit, "sim.overfit");
  unit(p.team.conflictRate, "sim.team.conflictRate");
  for (const [k, v] of Object.entries({ taskSpread: p.taskSpread, armTaskSpread: p.armTaskSpread, overheadMinutes: p.team.overheadMinutes, messageUsd: p.team.messageUsd })) {
    if (!(v >= 0)) throw new Error(`sim.${k} must be 0 or more.`);
  }
  for (const a of p.arms) {
    if (!(a.costUsd >= 0) || !(a.minutes > 0)) throw new Error(`sim arm ${a.provider} ${a.model} needs costUsd of 0 or more and minutes above 0.`);
  }
  if (p.maxRunning !== null && !(Number.isInteger(p.maxRunning) && p.maxRunning > 0)) throw new Error("sim.maxRunning must be a whole number above 0, or null.");
  return p;
}

// -- random numbers -----------------------------------------------------------

/** A small seeded generator. Same seed, same stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit seed from any list of parts. FNV-1a. */
export function seedOf(...parts: Array<string | number>): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join("\u0000")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** One standard normal draw. Box-Muller. */
export function gauss(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** The standard normal CDF. Abramowitz and Stegun 7.1.26, error below 2e-7. */
export function phi(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

export const logistic = (x: number): number => 1 / (1 + Math.exp(-x));
export const logit = (p: number): number => Math.log(p / (1 - p));

// -- the model ----------------------------------------------------------------

/** A task's difficulty: the one given, else a fixed draw for the task. */
export function taskDifficulty(params: SimParams, base: number, taskId: string, given?: number): number {
  if (typeof given === "number") return given;
  return params.taskMean + params.taskSpread * gauss(mulberry32(seedOf(base, "task", taskId)));
}

/** How far an arm sits above or below its usual skill on one task. Fixed per task and arm. */
export function armTaskShift(params: SimParams, base: number, taskId: string, arm: Arm): number {
  return params.armTaskSpread * gauss(mulberry32(seedOf(base, "arm", taskId, arm.provider, arm.model)));
}

/** The chance one attempt by an arm passes a task, alone. */
export function soloRate(params: SimParams, base: number, taskId: string, arm: SimArm, difficulty?: number): number {
  return logistic(arm.ability - taskDifficulty(params, base, taskId, difficulty) + armTaskShift(params, base, taskId, arm));
}

/** The arms of a cell, in order. The rotation moves with seed and task so every arm leads equally often. */
export function armsForCell(arms: SimArm[], size: number, seed: number, taskIndex: number): SimArm[] {
  const offset = (seed + taskIndex) % arms.length;
  return Array.from({ length: size }, (_, i) => arms[(offset + i) % arms.length]);
}

export type SimAttempt = {
  index: number;
  arm: SimArm;
  /** The chance this attempt passed, given the arm, the task and the team. */
  p: number;
  /** Passed the visible checks, and no conflict undid the pass. */
  pass: boolean;
  /** Passed the visible checks and then lost the pass to a conflict. */
  conflict: boolean;
  /** Passed the held-out checks. Only a pass can. */
  holdoutPass: boolean;
  startMin: number;
  endMin: number;
  costUsd: number;
};

export type SimCell = {
  attempts: SimAttempt[];
  /** The index of the promoted attempt, or null. */
  winner: number | null;
};

/** Simulate one cell. Pure: same input, same output. */
export function simulateCell(input: {
  params: SimParams;
  base: number;
  arms: SimArm[];
  size: number;
  seed: number;
  taskIndex: number;
  taskId: string;
  difficulty?: number;
  team: boolean;
}): SimCell {
  const { params, base, size, seed, taskId, team } = input;
  const random = mulberry32(seedOf(base, "cell", size, seed, taskId));
  const rho = params.runCorrelation;
  const v = gauss(random);
  const peers = size - 1;
  const arms = armsForCell(input.arms, size, seed, input.taskIndex);
  const slots: number[] = params.maxRunning ? Array.from({ length: Math.min(params.maxRunning, size) }, () => 0) : [];

  const attempts: SimAttempt[] = arms.map((arm, index) => {
    // Every draw happens in every condition, in the same order.
    const e = gauss(random);
    const dNoise = gauss(random);
    const cNoise = gauss(random);
    const uHoldout = random();
    const uConflict = random();

    const solo = soloRate(params, base, taskId, arm, input.difficulty);
    const p = team && size > 1 ? logistic(logit(solo) + params.team.synergy * Math.log2(size)) : solo;
    const z = Math.sqrt(rho) * v + Math.sqrt(1 - rho) * e;
    const visible = phi(z) < p;
    const conflict = team && visible && peers > 0 && uConflict < 1 - (1 - params.team.conflictRate) ** peers;
    const pass = visible && !conflict;

    const minutes = arm.minutes * Math.exp(0.5 * dNoise) + (team ? params.team.overheadMinutes * peers : 0);
    let startMin = 0;
    if (slots.length > 0) {
      const free = slots.indexOf(Math.min(...slots));
      startMin = slots[free];
      slots[free] = startMin + minutes;
    }
    // exp(0.3 n) has mean exp(0.045). Dividing it out keeps costUsd the mean.
    const costUsd = arm.costUsd * Math.exp(0.3 * cNoise - 0.045) + (team ? params.team.messageUsd * peers : 0);
    return { index, arm, p, pass, conflict, holdoutPass: pass && uHoldout >= params.overfit, startMin, endMin: startMin + minutes, costUsd };
  });

  // The rule runTask uses: a pass first, then the cheaper.
  const winner = attempts.filter((a) => a.pass).sort((a, b) => a.costUsd - b.costUsd)[0]?.index ?? null;
  return { attempts, winner };
}

// -- what the model expects ---------------------------------------------------

/**
 * The exact chance a cell is solved under the model, averaged over the
 * run's shared draw v. Given v, attempts are independent:
 *
 *   P(pass | v) = Phi((PhiInv(p') - sqrt(rho) v) / sqrt(1 - rho)) * (1 - conflict)
 *
 * The integral over v is a sum on a fine grid. The report sets this
 * beside the observed rate, so a reader sees whether the analysis lands
 * on the truth it was given.
 */
export function expectedSolve(input: { params: SimParams; base: number; arms: SimArm[]; size: number; seed: number; taskIndex: number; taskId: string; difficulty?: number; team: boolean }): number {
  const { params, base, size, team } = input;
  const rho = params.runCorrelation;
  const peers = size - 1;
  const keep = team && peers > 0 ? (1 - params.team.conflictRate) ** peers : 1;
  const thresholds = armsForCell(input.arms, size, input.seed, input.taskIndex).map((arm) => {
    const solo = soloRate(params, base, input.taskId, arm, input.difficulty);
    const p = team && size > 1 ? logistic(logit(solo) + params.team.synergy * Math.log2(size)) : solo;
    return phiInv(p);
  });
  const steps = 240;
  const lo = -6;
  const h = 12 / steps;
  let total = 0;
  let weight = 0;
  for (let s = 0; s <= steps; s++) {
    const v = lo + s * h;
    const w = Math.exp(-0.5 * v * v) * (s === 0 || s === steps ? 0.5 : 1);
    let none = 1;
    for (const t of thresholds) {
      const pv = rho > 0 ? phi((t - Math.sqrt(rho) * v) / Math.sqrt(1 - rho)) : phi(t);
      none *= 1 - pv * keep;
    }
    total += w * (1 - none);
    weight += w;
  }
  return total / weight;
}

/** The inverse of the standard normal CDF. Acklam's rational approximation, refined by one Newton step. */
export function phiInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let x: number;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pl) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const e = phi(x) - p;
  return x - e * Math.sqrt(2 * Math.PI) * Math.exp(0.5 * x * x);
}

// -- the ledger ---------------------------------------------------------------

/** The simulated clock starts here: 2026-01-01T00:00:00Z. Fixed, so a simulated ledger is the same on every machine. */
export const SIM_EPOCH = Date.UTC(2026, 0, 1);

const MINUTE = 60_000;

/**
 * Write a simulated cell as a ledger, in the shape a real run leaves, at
 * `<dir>/.ceo/ledger.jsonl`. Events carry simulated timestamps and go in
 * time order. The export then reads a simulated cell and a real one the
 * same way. The chain is built in memory and written once.
 */
export function recordSimCell(
  dir: string,
  input: { taskId: string; title: string; size: number; cellNote: Record<string, unknown> },
  cell: SimCell,
): void {
  const t0 = SIM_EPOCH;
  const agent = "solver";
  const settle = t0 + Math.max(0, ...cell.attempts.map((a) => a.endMin)) * MINUTE;
  const id = (i: number) => `s${String(i).padStart(3, "0")}`;
  type Ev = { type: LedgerEventType; agent: string | null; data: Record<string, unknown>; ts: number };
  const head: Ev[] = [
    { type: "org_init", agent: null, data: { ceoVersion: 1, backend: "sim" }, ts: t0 },
    { type: "note", agent: null, data: { kind: "experiment_cell", ...input.cellNote }, ts: t0 },
    { type: "task_add", agent, data: { id: input.taskId, title: input.title, assignee: agent, priority: "normal", requestedBy: null, verifiers: [{ kind: "command", run: "visible checks" }], ...(input.size > 1 ? { samples: input.size } : {}) }, ts: t0 },
    { type: "task_update", agent, data: { id: input.taskId, status: "running", note: null }, ts: t0 },
  ];

  const timed: Array<Ev & { order: number }> = [];
  for (const a of cell.attempts) {
    const start = t0 + a.startMin * MINUTE;
    const end = t0 + a.endMin * MINUTE;
    timed.push({ type: "attempt_start", agent, data: { taskId: input.taskId, attemptId: id(a.index), agent, arm: { provider: a.arm.provider, model: a.arm.model }, mode: "named", why: "named on the task", branch: null, worktree: "", base: null, kind: null }, ts: start, order: 0 });
    timed.push({ type: "attempt_end", agent, data: { taskId: input.taskId, attemptId: id(a.index), delegationId: null, outcome: "done", costUsd: round(a.costUsd, 6) }, ts: end, order: 1 });
  }
  timed.sort((x, y) => x.ts - y.ts || x.order - y.order);

  // Checks run once every attempt has ended, as in runTask.
  const tail: Ev[] = cell.attempts.map((a) => ({
    type: "verify",
    agent,
    data: {
      scope: "task",
      taskId: input.taskId,
      attemptId: id(a.index),
      delegationId: null,
      verifier: { kind: "command", name: "visible checks", required: true, weight: 1 },
      status: a.pass ? "pass" : "fail",
      score: a.pass ? 1 : 0,
      detail: a.pass ? "visible checks passed" : a.conflict ? "passed, then undone by a conflict with a peer" : "visible checks failed",
      evidence: { sim: true, p: round(a.p, 4), ...(a.conflict ? { conflict: true } : {}) },
    },
    ts: settle,
  }));
  if (cell.winner !== null) {
    const w = cell.attempts[cell.winner];
    tail.push({ type: "promote", agent, data: { taskId: input.taskId, attemptId: id(w.index), branch: null, arm: { provider: w.arm.provider, model: w.arm.model }, score: 1, costUsd: round(w.costUsd, 6), attempts: cell.attempts.length, dissent: null }, ts: settle });
    tail.push({ type: "task_update", agent, data: { id: input.taskId, status: "done", note: `won by ${w.arm.provider} ${w.arm.model}` }, ts: settle });
  } else {
    tail.push({ type: "task_update", agent, data: { id: input.taskId, status: "failed", note: "No attempt passed." }, ts: settle });
  }
  tail.push({
    type: "note",
    agent: null,
    data: {
      kind: "experiment_result",
      cell: input.cellNote.cell,
      solved: cell.winner !== null,
      winner: cell.winner !== null ? id(cell.winner) : null,
      holdout: Object.fromEntries(cell.attempts.filter((a) => a.pass).map((a) => [id(a.index), a.holdoutPass])),
    },
    ts: settle,
  });

  const entries = chainEntries([...head, ...timed.map(({ order: _order, ...ev }) => ev), ...tail]);
  mkdirSync(path.join(dir, ".ceo"), { recursive: true });
  writeFileSync(path.join(dir, ".ceo", "ledger.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

function round(x: number, places: number): number {
  const f = 10 ** places;
  return Math.round(x * f) / f;
}
