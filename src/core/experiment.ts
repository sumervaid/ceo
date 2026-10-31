/**
 * Experiments: CEO as an instrument.
 *
 * A spec names conditions, team sizes, seeds and tasks. Every combination
 * is a cell. Each cell runs in a fresh root with a ledger of its own, so
 * no cell sees another. The ledger is the cell's raw data. The export
 * flattens every ledger into two tables, one row per attempt and one row
 * per cell, for analysis anywhere.
 *
 * Two backends run a cell.
 *
 *   sim   attempts drawn from a model with known parameters. Free, fast,
 *         and the way to check that an analysis recovers a planted effect.
 *   ceo   the real path: a git repo per cell, an agent, a task with
 *         checks, runTask. Stubs on PATH make the run free. Real CLIs make
 *         the run cost money, and need --live and a budget.
 *
 * Cells run seed by seed. An experiment stopped early by its budget, a
 * provider limit or a keypress leaves whole replicates behind. A second
 * run skips every finished cell and carries on.
 *
 * Two notes bracket each cell's ledger:
 *
 *   experiment_cell    cell, experiment, backend, condition, mode, size, seed, task
 *   experiment_result  cell, solved, winner, holdout
 *
 * `holdout` maps attempt ids to the result of the held-out checks. The
 * visible checks pick the winner. The held-out checks score the pick.
 * Selection on the grader then cannot pass for skill.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { attemptName, attemptsFor, runTask } from "./attempts.js";
import { teardownWorktree } from "./git.js";
import { append, initLedger } from "./ledger.js";
import { forgetProjectRoots, projectRoot } from "./paths.js";
import { providerFor } from "./providers.js";
import { hire } from "./roster.js";
import { recordSimCell, simParams, simulateCell, type SimArm, type SimParams, type SimParamsInput } from "./sim.js";
import { addTask } from "./tasks.js";
import { PROVIDERS, type Arm, type LedgerEntry, type Provider, type VerifierSpec } from "./types.js";
import { parseVerifier, verifyAll } from "./verify.js";

export type Backend = "sim" | "ceo";
export type ConditionMode = "independent" | "team";

export type Condition = {
  name: string;
  /** independent: attempts that never see each other. team: attempts that work together. */
  mode: ConditionMode;
  /** Run every attempt on one provider's arms. Null for every arm in turn. */
  provider: Provider | null;
};

export type ExperimentTask = {
  id: string;
  /** What the agent is asked to do. The task title. */
  prompt: string;
  /** Checks that pick the winner. */
  verify: VerifierSpec[];
  /** Checks that score the winner, unseen by selection. */
  holdout: VerifierSpec[];
  /** A directory copied into each cell's repo. Absolute once parsed. */
  fixture: string | null;
  /** Sim only: difficulty on the logit scale. */
  difficulty?: number;
};

export type ExperimentSpec = {
  name: string;
  backend: Backend;
  sizes: number[];
  seeds: number;
  conditions: Condition[];
  tasks: ExperimentTask[];
  /** ceo only: the arms attempts rotate through. */
  arms: Arm[];
  /** ceo only: the agent each cell hires. */
  agent: { provider: Provider; model: string | null; role: string };
  /** Stop starting cells once this much is spent. Null for no cap. Required for --live. */
  budgetUsd: number | null;
  sim: SimParams;
  /** The root seed. Every draw in a sim cell derives from it. */
  seed: number;
};

export type Cell = {
  id: string;
  condition: Condition;
  size: number;
  seed: number;
  task: ExperimentTask;
  taskIndex: number;
};

const SLUG = /^[a-z0-9][a-z0-9_-]*$/i;
const DEFAULT_ROLE = "Solve the task in this repository with the smallest change that makes the checks pass.";

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} must be an object.`);
  return v as Record<string, unknown>;
}

function checks(v: unknown, what: string): VerifierSpec[] {
  if (v === undefined || v === null) return [];
  const list = typeof v === "string" ? [v] : v;
  if (!Array.isArray(list)) throw new Error(`${what} must be a list of checks.`);
  return list.map((c, i) => {
    if (typeof c === "string") return parseVerifier(c);
    const o = asObject(c, `${what}[${i}]`);
    if (o.kind !== "command" && o.kind !== "everval" && o.kind !== "judge") throw new Error(`${what}[${i}] needs kind command, everval or judge.`);
    return o as VerifierSpec;
  });
}

function provider(v: unknown, what: string): Provider {
  if (!PROVIDERS.includes(v as Provider)) throw new Error(`${what} must be one of ${PROVIDERS.join(", ")}.`);
  return v as Provider;
}

/**
 * Read a spec, fill in defaults and check every field. Relative fixture
 * paths resolve against `dir`, the spec file's directory. Throws with the
 * field at fault.
 */
export function parseSpec(raw: unknown, dir: string = process.cwd()): ExperimentSpec {
  const o = asObject(raw, "The spec");
  const name = String(o.name ?? "");
  if (!SLUG.test(name)) throw new Error("name must be letters, digits, hyphens and underscores.");
  const backend = (o.backend ?? "sim") as Backend;
  if (backend !== "sim" && backend !== "ceo") throw new Error("backend must be sim or ceo.");

  const sizesRaw = o.sizes ?? [1, 2, 4, 8];
  if (!Array.isArray(sizesRaw) || sizesRaw.length === 0) throw new Error("sizes must be a list of team sizes.");
  const sizes = [...new Set(sizesRaw.map(Number))].sort((a, b) => a - b);
  if (sizes.some((n) => !Number.isInteger(n) || n < 1 || n > 1000)) throw new Error("sizes must be whole numbers from 1 to 1000.");

  const seeds = Number(o.seeds ?? 3);
  if (!Number.isInteger(seeds) || seeds < 1) throw new Error("seeds must be a whole number of 1 or more.");
  const seed = Number(o.seed ?? 1);
  if (!Number.isInteger(seed)) throw new Error("seed must be a whole number.");

  const condRaw = o.conditions ?? [{ name: "independent", mode: "independent" }];
  if (!Array.isArray(condRaw) || condRaw.length === 0) throw new Error("conditions must be a list.");
  const conditions: Condition[] = condRaw.map((c, i) => {
    const co = asObject(c, `conditions[${i}]`);
    const cname = String(co.name ?? co.mode ?? "");
    if (!SLUG.test(cname)) throw new Error(`conditions[${i}].name must be a slug.`);
    const mode = (co.mode ?? "independent") as ConditionMode;
    if (mode !== "independent" && mode !== "team") throw new Error(`conditions[${i}].mode must be independent or team.`);
    if (backend === "ceo" && mode === "team") throw new Error(`conditions[${i}]: the ceo backend runs independent conditions. Team conditions run on the sim backend for now.`);
    return { name: cname, mode, provider: co.provider === undefined || co.provider === null ? null : provider(co.provider, `conditions[${i}].provider`) };
  });
  if (new Set(conditions.map((c) => c.name)).size !== conditions.length) throw new Error("condition names must be distinct.");

  if (!Array.isArray(o.tasks) || o.tasks.length === 0) throw new Error("tasks must be a list with at least one task.");
  const tasks: ExperimentTask[] = o.tasks.map((t, i) => {
    const to = asObject(t, `tasks[${i}]`);
    const id = String(to.id ?? "");
    if (!SLUG.test(id)) throw new Error(`tasks[${i}].id must be a slug.`);
    const prompt = String(to.prompt ?? (backend === "sim" ? `task ${id}` : "")).trim();
    if (prompt.length < 3) throw new Error(`tasks[${i}].prompt needs at least 3 characters.`);
    const fixture = typeof to.fixture === "string" ? path.resolve(dir, to.fixture) : null;
    if (backend === "ceo" && fixture && !existsSync(fixture)) throw new Error(`tasks[${i}].fixture: no directory at ${fixture}.`);
    const verify = checks(to.verify, `tasks[${i}].verify`);
    if (backend === "ceo" && verify.length === 0) throw new Error(`tasks[${i}].verify: the ceo backend needs at least one check to pick a winner.`);
    return {
      id,
      prompt,
      verify,
      holdout: checks(to.holdout, `tasks[${i}].holdout`),
      fixture,
      ...(typeof to.difficulty === "number" ? { difficulty: to.difficulty } : {}),
    };
  });
  if (new Set(tasks.map((t) => t.id)).size !== tasks.length) throw new Error("task ids must be distinct.");

  const agentRaw = o.agent === undefined ? {} : asObject(o.agent, "agent");
  const agentProvider = agentRaw.provider === undefined ? "claude" : provider(agentRaw.provider, "agent.provider");
  const agent = {
    provider: agentProvider,
    model: typeof agentRaw.model === "string" ? agentRaw.model : null,
    role: typeof agentRaw.role === "string" && agentRaw.role.trim().length >= 10 ? agentRaw.role.trim() : DEFAULT_ROLE,
  };

  const armsRaw = o.arms;
  const arms: Arm[] =
    armsRaw === undefined
      ? [{ provider: agent.provider, model: agent.model ?? providerFor(agent.provider).defaultModel() }]
      : (Array.isArray(armsRaw) ? armsRaw : []).map((a, i) => {
          const ao = asObject(a, `arms[${i}]`);
          const p = provider(ao.provider, `arms[${i}].provider`);
          return { provider: p, model: typeof ao.model === "string" ? ao.model : providerFor(p).defaultModel() };
        });
  if (arms.length === 0) throw new Error("arms must list at least one arm.");

  const budgetUsd = o.budgetUsd === undefined || o.budgetUsd === null ? null : Number(o.budgetUsd);
  if (budgetUsd !== null && !(budgetUsd > 0)) throw new Error("budgetUsd must be above 0.");

  const sim = simParams((o.sim ?? {}) as SimParamsInput);
  for (const c of conditions) {
    if (!c.provider) continue;
    const pool = backend === "sim" ? sim.arms : arms;
    if (!pool.some((a) => a.provider === c.provider)) throw new Error(`condition ${c.name} runs on ${c.provider}, and no arm is on ${c.provider}.`);
  }

  return { name, backend, sizes, seeds, conditions, tasks, arms, agent, budgetUsd, sim, seed };
}

/** Read and parse a spec file. */
export function readSpec(file: string): ExperimentSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseSpec(raw, path.dirname(path.resolve(file)));
}

export function cellId(c: Pick<Cell, "condition" | "size" | "seed" | "task">): string {
  return `${c.condition.name}.n${c.size}.s${c.seed}.${c.task.id}`;
}

/** Every cell, seed by seed, so a run cut short leaves whole replicates. */
export function cellsOf(spec: ExperimentSpec): Cell[] {
  const out: Cell[] = [];
  for (let seed = 0; seed < spec.seeds; seed++) {
    for (const size of spec.sizes) {
      spec.tasks.forEach((task, taskIndex) => {
        for (const condition of spec.conditions) {
          const c = { condition, size, seed, task, taskIndex };
          out.push({ id: cellId(c), ...c });
        }
      });
    }
  }
  return out;
}

/** Where an experiment's cells and tables live. Inside `.ceo/`, so a project's tree stays clean. */
export function experimentDir(spec: Pick<ExperimentSpec, "name">, cwd: string, out?: string | null): string {
  return out ? path.resolve(cwd, out) : path.join(projectRoot(cwd), ".ceo", "experiments", spec.name);
}

/** The arms a condition draws from. */
function armPool<T extends Arm>(arms: T[], condition: Condition): T[] {
  return condition.provider ? arms.filter((a) => a.provider === condition.provider) : arms;
}

/** The arms of a ceo cell, rotated the way the sim rotates them. */
export function ceoArms(spec: ExperimentSpec, cell: Cell): Arm[] {
  const pool = armPool(spec.arms, cell.condition);
  const offset = (cell.seed + cell.taskIndex) % pool.length;
  return pool.map((_, i) => pool[(offset + i) % pool.length]);
}

export type Plan = { cells: number; attempts: number; perCondition: Record<string, number>; binaries: Array<{ provider: Provider; binary: string; stub: boolean }> };

/** What a run would do, before anything runs. */
export function planOf(spec: ExperimentSpec): Plan {
  const cells = cellsOf(spec);
  const perCondition: Record<string, number> = {};
  for (const c of cells) perCondition[c.condition.name] = (perCondition[c.condition.name] ?? 0) + c.size;
  const used = new Set<Provider>(spec.backend === "ceo" ? spec.arms.map((a) => a.provider) : []);
  if (spec.backend === "ceo") used.add(spec.agent.provider);
  const binaries = [...used].map((p) => {
    const binary = providerFor(p).binary();
    return { provider: p, binary, stub: /(^|\/)stub-[^/]*$/.test(binary) };
  });
  return { cells: cells.length, attempts: cells.reduce((s, c) => s + c.size, 0), perCondition, binaries };
}

export function renderPlan(spec: ExperimentSpec, plan: Plan = planOf(spec)): string {
  const lines = [
    `${spec.name} · ${spec.backend} backend`,
    `  ${spec.conditions.length} condition${spec.conditions.length === 1 ? "" : "s"} × ${spec.sizes.length} size${spec.sizes.length === 1 ? "" : "s"} × ${spec.seeds} seed${spec.seeds === 1 ? "" : "s"} × ${spec.tasks.length} task${spec.tasks.length === 1 ? "" : "s"} = ${plan.cells} cells, ${plan.attempts} attempts`,
    `  sizes ${spec.sizes.join(", ")}`,
    ...spec.conditions.map((c) => `  ${c.name.padEnd(16)} ${c.mode}${c.provider ? ` on ${c.provider}` : ""} · ${plan.perCondition[c.name] ?? 0} attempts`),
  ];
  if (spec.backend === "ceo") {
    for (const b of plan.binaries) lines.push(`  ${b.provider.padEnd(8)} ${b.binary}${b.stub ? " · stub, free" : " · real, costs money"}`);
    lines.push(`  budget ${spec.budgetUsd === null ? "none" : `$${spec.budgetUsd.toFixed(2)}`}`);
  }
  return lines.join("\n");
}

// -- running ------------------------------------------------------------------

function ledgerFile(dir: string): string {
  return path.join(dir, ".ceo", "ledger.jsonl");
}

function readEntries(dir: string): LedgerEntry[] {
  const f = ledgerFile(dir);
  if (!existsSync(f)) return [];
  const out: LedgerEntry[] = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerEntry);
    } catch {
      /* a torn last line from a killed run; the cell reads as unfinished */
    }
  }
  return out;
}

function noteOf(entries: LedgerEntry[], kind: string): LedgerEntry | undefined {
  return entries.find((e) => e.type === "note" && e.data.kind === kind);
}

function cellCost(entries: LedgerEntry[]): number {
  return entries.filter((e) => e.type === "attempt_end").reduce((s, e) => s + Number(e.data.costUsd ?? 0), 0);
}

/** The design of a spec: everything that changes what a cell means. A budget does not. */
function design(spec: ExperimentSpec): string {
  const { budgetUsd: _budget, ...rest } = spec;
  return JSON.stringify(rest);
}

export type CellOutcome = { cell: Cell; status: "ran" | "skipped" | "deferred"; costUsd: number; solved: boolean | null };

export type RunSummary = {
  dir: string;
  total: number;
  ran: number;
  skipped: number;
  spentUsd: number;
  /** Why the run stopped before the last cell, when it did. */
  stopped: string | null;
};

/**
 * Run every unfinished cell. Resolves when the last cell settles, the
 * budget runs out, a provider limit is hit, or `signal` aborts.
 */
export async function runExperiment(
  spec: ExperimentSpec,
  opts: { dir: string; live?: boolean; fresh?: boolean; signal?: AbortSignal; onCell?: (o: CellOutcome, index: number, total: number) => void },
): Promise<RunSummary> {
  const dir = path.resolve(opts.dir);
  const cellsDir = path.join(dir, "cells");
  const specFile = path.join(dir, "spec.json");

  if (spec.backend === "ceo") {
    const real = planOf(spec).binaries.filter((b) => !b.stub);
    if (real.length > 0 && !opts.live) {
      throw new Error(`These would run real agents and spend money: ${real.map((b) => `${b.provider} at ${b.binary}`).join(", ")}. Set CEO_CLAUDE_BIN, CEO_CODEX_BIN and CEO_GEMINI_BIN to the stubs in tools/, or pass --live with budgetUsd in the spec.`);
    }
    if (real.length > 0 && spec.budgetUsd === null) throw new Error("--live needs budgetUsd in the spec.");
  }

  if (opts.fresh) rmSync(cellsDir, { recursive: true, force: true });
  if (existsSync(specFile) && existsSync(cellsDir) && readdirSync(cellsDir).length > 0) {
    let prior: ExperimentSpec | null = null;
    try {
      prior = JSON.parse(readFileSync(specFile, "utf8")) as ExperimentSpec;
    } catch {
      prior = null;
    }
    if (prior && design(prior) !== design(spec)) throw new Error(`The spec changed since cells ran in ${dir}. Pass --fresh to start over, or name the experiment differently.`);
  }
  mkdirSync(cellsDir, { recursive: true });
  writeFileSync(specFile, JSON.stringify(spec, null, 2) + "\n", "utf8");

  // A cell's root is the cell's own directory. Git must not climb out of
  // it to a repo above, or a sim cell would write into that repo's .ceo.
  const prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = [realpathSync(cellsDir), prevCeiling].filter(Boolean).join(path.delimiter);
  forgetProjectRoots();

  const cells = cellsOf(spec);
  const summary: RunSummary = { dir, total: cells.length, ran: 0, skipped: 0, spentUsd: 0, stopped: null };
  try {
    for (const [i, cell] of cells.entries()) {
      const cdir = path.join(cellsDir, cell.id);
      const prior = readEntries(cdir);
      if (noteOf(prior, "experiment_result")) {
        const cost = cellCost(prior);
        summary.spentUsd += cost;
        summary.skipped++;
        opts.onCell?.({ cell, status: "skipped", costUsd: cost, solved: noteOf(prior, "experiment_result")!.data.solved === true }, i, cells.length);
        continue;
      }
      if (opts.signal?.aborted) {
        summary.stopped = "stopped by request";
        break;
      }
      if (spec.budgetUsd !== null && summary.spentUsd >= spec.budgetUsd) {
        summary.stopped = `budget of $${spec.budgetUsd.toFixed(2)} spent`;
        break;
      }
      const o = spec.backend === "sim" ? runSimCell(spec, cell, cdir) : await runCeoCell(spec, cell, cdir, spec.budgetUsd === null ? null : spec.budgetUsd - summary.spentUsd);
      summary.spentUsd += o.costUsd;
      opts.onCell?.(o, i, cells.length);
      if (o.status === "deferred") {
        summary.stopped = "a provider limit was hit; run again later to carry on";
        break;
      }
      summary.ran++;
    }
  } finally {
    if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
    forgetProjectRoots();
  }
  return summary;
}

function cellNote(spec: ExperimentSpec, cell: Cell): Record<string, unknown> {
  return {
    cell: cell.id,
    experiment: spec.name,
    backend: spec.backend,
    condition: cell.condition.name,
    mode: cell.condition.mode,
    provider: cell.condition.provider,
    size: cell.size,
    seed: cell.seed,
    task: cell.task.id,
  };
}

/** Make a clean directory and confirm CEO resolves it as its own root. */
function freshRoot(dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

function assertOwnRoot(dir: string): string {
  forgetProjectRoots();
  const root = projectRoot(dir);
  if (realpathSync(root) !== realpathSync(dir)) throw new Error(`Cell ${dir} resolves to ${root}. Refusing to write outside the cell.`);
  return root;
}

/** The simulator's input for a cell. */
export function simInput(spec: ExperimentSpec, cell: Cell) {
  return {
    params: spec.sim,
    base: spec.seed,
    arms: armPool<SimArm>(spec.sim.arms, cell.condition),
    size: cell.size,
    seed: cell.seed,
    taskIndex: cell.taskIndex,
    taskId: cell.task.id,
    ...(cell.task.difficulty !== undefined ? { difficulty: cell.task.difficulty } : {}),
    team: cell.condition.mode === "team",
  };
}

/** A sim cell writes its ledger straight into its own directory. No git, no root lookup. */
export function runSimCell(spec: ExperimentSpec, cell: Cell, dir: string): CellOutcome {
  freshRoot(dir);
  const sim = simulateCell(simInput(spec, cell));
  recordSimCell(dir, { taskId: cell.task.id, title: cell.task.prompt, size: cell.size, cellNote: cellNote(spec, cell) }, sim);
  return { cell, status: "ran", costUsd: sim.attempts.reduce((s, a) => s + a.costUsd, 0), solved: sim.winner !== null };
}

const FIXTURE_IDENTITY = { GIT_AUTHOR_NAME: "ceo experiment", GIT_AUTHOR_EMAIL: "experiment@ceo.local", GIT_COMMITTER_NAME: "ceo experiment", GIT_COMMITTER_EMAIL: "experiment@ceo.local" };

export async function runCeoCell(spec: ExperimentSpec, cell: Cell, dir: string, remainingUsd: number | null): Promise<CellOutcome> {
  const made = freshRoot(dir);
  if (cell.task.fixture) {
    cpSync(cell.task.fixture, made, { recursive: true, filter: (src) => !/(^|\/)\.(git|ceo)(\/|$)/.test(path.relative(cell.task.fixture!, src)) });
  }
  const ignore = path.join(made, ".gitignore");
  writeFileSync(ignore, (existsSync(ignore) ? readFileSync(ignore, "utf8") : "") + ".ceo/\n", "utf8");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: made, stdio: "ignore", env: { ...process.env, ...FIXTURE_IDENTITY } });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "fixture");
  const root = assertOwnRoot(made);

  initLedger(root);
  append("note", null, { kind: "experiment_cell", ...cellNote(spec, cell) }, root);
  hire({ name: "solver", role: spec.agent.role, provider: spec.agent.provider, ...(spec.agent.model ? { model: spec.agent.model } : {}), budgetUsd: remainingUsd ?? 1000, autonomy: "execute" }, root);
  const task = addTask({ title: cell.task.prompt, assignee: "solver", samples: cell.size, arms: ceoArms(spec, cell), verifiers: cell.task.verify }, root);

  const out = await runTask(task.id, { cwd: root, samples: cell.size }).finished;
  const attempts = attemptsFor(task.id, root);
  const costUsd = attempts.reduce((s, a) => s + a.costUsd, 0);

  if (out.status === "queued") {
    append("note", null, { kind: "experiment_deferred", cell: cell.id, reason: out.note }, root);
    return { cell, status: "deferred", costUsd, solved: null };
  }

  const holdout: Record<string, boolean> = {};
  const w = out.winner;
  if (w && cell.task.holdout.length > 0) {
    const workdir = w.worktree && existsSync(w.worktree) ? w.worktree : root;
    const v = await verifyAll(cell.task.holdout, { root, workdir, base: w.base, taskId: task.id, attemptId: w.id, agent: w.agent, task: cell.task.prompt, provider: w.arm.provider, scope: "task" }, { record: false });
    holdout[w.id] = v.pass;
  }
  for (const a of attempts) {
    if (!a.branch) continue;
    try {
      teardownWorktree(attemptName("solver", a.id), {}, root);
    } catch {
      /* a worktree left behind costs disk, not correctness */
    }
  }
  append("note", null, { kind: "experiment_result", cell: cell.id, solved: out.status === "done", winner: w?.id ?? null, holdout, status: out.status, detail: out.note.slice(0, 300) }, root);
  return { cell, status: "ran", costUsd, solved: out.status === "done" };
}

// -- export -------------------------------------------------------------------

export type AttemptRow = {
  experiment: string;
  backend: string;
  cell: string;
  condition: string;
  mode: string;
  size: number;
  seed: number;
  task: string;
  attempt: string;
  provider: string;
  model: string;
  start_min: number;
  end_min: number | null;
  cost_usd: number;
  outcome: string;
  pass: 0 | 1;
  conflict: 0 | 1;
  promoted: 0 | 1;
  holdout_pass: 0 | 1 | null;
};

export type CellRow = {
  experiment: string;
  backend: string;
  cell: string;
  condition: string;
  mode: string;
  size: number;
  seed: number;
  task: string;
  solved: 0 | 1;
  attempts: number;
  passing: number;
  minutes_to_first: number | null;
  minutes_to_settle: number | null;
  cost_usd: number;
  holdout_pass: 0 | 1 | null;
};

const r4 = (x: number) => Math.round(x * 10000) / 10000;

/** One finished cell as rows. Null for a cell that has not finished. */
export function readCell(dir: string): { cell: CellRow; attempts: AttemptRow[] } | null {
  const entries = readEntries(dir);
  const meta = noteOf(entries, "experiment_cell");
  const result = noteOf(entries, "experiment_result");
  const added = entries.find((e) => e.type === "task_add");
  if (!meta || !result || !added) return null;
  const m = meta.data;
  const taskId = String(added.data.id);
  const hasChecks = Array.isArray(added.data.verifiers) && added.data.verifiers.length > 0;
  const t0 = added.ts;
  const promoted = entries.filter((e) => e.type === "promote" && e.data.taskId === taskId).pop()?.data.attemptId ?? null;
  const conflicts = new Set(entries.filter((e) => e.type === "verify" && (e.data.evidence as Record<string, unknown> | undefined)?.conflict === true).map((e) => String(e.data.attemptId)));
  const holdout = (result.data.holdout ?? {}) as Record<string, boolean>;
  const common = {
    experiment: String(m.experiment),
    backend: String(m.backend),
    cell: String(m.cell),
    condition: String(m.condition),
    mode: String(m.mode),
    size: Number(m.size),
    seed: Number(m.seed),
    task: String(m.task),
  };
  const attempts: AttemptRow[] = attemptsFor(taskId, undefined, entries).map((a) => ({
    ...common,
    attempt: a.id,
    provider: a.arm.provider,
    model: a.arm.model,
    start_min: r4((a.startedAt - t0) / 60000),
    end_min: a.endedAt === null ? null : r4((a.endedAt - t0) / 60000),
    cost_usd: r4(a.costUsd),
    outcome: a.outcome ?? "",
    pass: (a.verdict ? a.verdict.pass : !hasChecks && a.outcome === "done") ? 1 : 0,
    conflict: conflicts.has(a.id) ? 1 : 0,
    promoted: a.id === promoted ? 1 : 0,
    holdout_pass: a.id in holdout ? (holdout[a.id] ? 1 : 0) : null,
  }));
  const passing = attempts.filter((a) => a.pass === 1);
  const ends = attempts.map((a) => a.end_min).filter((x): x is number => x !== null);
  const winner = attempts.find((a) => a.promoted === 1);
  return {
    cell: {
      ...common,
      solved: result.data.solved === true ? 1 : 0,
      attempts: attempts.length,
      passing: passing.length,
      minutes_to_first: passing.length > 0 ? Math.min(...passing.map((a) => a.end_min ?? Infinity)) : null,
      minutes_to_settle: ends.length > 0 ? Math.max(...ends) : null,
      cost_usd: r4(attempts.reduce((s, a) => s + a.cost_usd, 0)),
      holdout_pass: winner ? winner.holdout_pass : null,
    },
    attempts,
  };
}

/** Every finished cell of an experiment, as rows. */
export function exportExperiment(dir: string): { cells: CellRow[]; attempts: AttemptRow[] } {
  const cellsDir = path.join(dir, "cells");
  const cells: CellRow[] = [];
  const attempts: AttemptRow[] = [];
  if (!existsSync(cellsDir)) return { cells, attempts };
  for (const name of readdirSync(cellsDir).sort()) {
    const got = readCell(path.join(cellsDir, name));
    if (!got) continue;
    cells.push(got.cell);
    attempts.push(...got.attempts);
  }
  return { cells, attempts };
}

/** Rows as CSV. Empty values for null. */
export function toCsv<T extends Record<string, unknown>>(rows: T[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

/** Write cells.csv and attempts.csv next to the cells. */
export function writeExport(dir: string): { cells: string; attempts: string; rows: { cells: number; attempts: number } } {
  const data = exportExperiment(dir);
  const cells = path.join(dir, "cells.csv");
  const attempts = path.join(dir, "attempts.csv");
  writeFileSync(cells, toCsv(data.cells), "utf8");
  writeFileSync(attempts, toCsv(data.attempts), "utf8");
  return { cells, attempts, rows: { cells: data.cells.length, attempts: data.attempts.length } };
}
