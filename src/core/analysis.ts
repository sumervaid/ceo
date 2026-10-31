/**
 * Analysis: what an experiment's cells say about team size.
 *
 * A raw curve of solved rate against team size says little. More
 * attempts solve more tasks with no teamwork at all. The useful question
 * is how much of the curve is sampling and how much is the team. The
 * report splits it in three.
 *
 *   naive      1 - (1 - p)^N with one pooled single-attempt rate p. The
 *              curve if every task were alike and every try independent.
 *   sampling   the same with each task's own rate for each arm, from the
 *              pooled independent attempts, for the arms each cell ran.
 *              Easy tasks fall to one try. Hard tasks fall to none. The
 *              gap to naive is task heterogeneity.
 *   observed   what the cells did.
 *
 * For an independent condition, observed minus sampling is within-run
 * correlation: attempts in one run failing together beyond what the task
 * and the arm explain. For a team condition, observed minus the matching
 * independent condition is coordination. The two conditions share their
 * random draws cell by cell in the simulator, so that difference is
 * paired.
 *
 * Intervals are percentile intervals from a bootstrap over tasks. Tasks
 * are the unit that varies most, and the unit a reader would generalise
 * over.
 *
 * The per-arm estimate uses the unbiased pass@k form: the chance that m
 * tries drawn from n, of which c passed, include a pass.
 */

import { cellsOf, simInput, type AttemptRow, type CellRow, type ExperimentSpec } from "./experiment.js";
import { expectedSolve, mulberry32, seedOf } from "./sim.js";

/** The chance that k tries drawn without replacement from n, with c passes among them, include a pass. */
export function passAtK(n: number, c: number, k: number): number {
  if (k <= 0 || n <= 0) return 0;
  if (c <= 0) return 0;
  if (k > n) return 1 - (1 - c / n) ** k;
  if (n - c < k) return 1;
  let none = 1;
  for (let i = n - c + 1; i <= n; i++) none *= 1 - k / i;
  return 1 - none;
}

export type Interval = { mean: number; lo: number | null; hi: number | null; n: number };

export type SizeStats = {
  size: number;
  cells: number;
  observed: Interval;
  naive: number | null;
  sampling: number | null;
  /** Observed minus sampling. */
  gap: number | null;
  /** Observed minus the matching independent condition, paired cell by cell. Team conditions only. */
  coordination: Interval | null;
  /** Sim only: the solved rate the model implies for these cells. The answer the analysis should land near. */
  truth: number | null;
  /** Sim only: the coordination the model implies. */
  truthCoordination: number | null;
  /** The number of independent tries at the pooled rate that would match the observed rate. */
  effectiveN: number | null;
  costPerCell: number;
  costPerSolved: number | null;
  minutesToFirst: number | null;
  /** The share of cells whose pick passed the held-out checks. Null without held-out checks. */
  hidden: number | null;
};

export type Step = {
  from: number;
  to: number;
  gain: number;
  perDoubling: number;
  sampling: number | null;
  coordination: number | null;
  rest: number | null;
};

export type ConditionStats = {
  name: string;
  mode: string;
  reference: string | null;
  pooledRate: number | null;
  sizes: SizeStats[];
  steps: Step[];
  /** The step after which gain per doubling fell the most. Null with fewer than three sizes. */
  bend: { step: Step; before: Step } | null;
};

export type Analysis = {
  experiment: string;
  backend: string;
  cells: number;
  attempts: number;
  tasks: number;
  seeds: number;
  conditions: ConditionStats[];
  planted: Record<string, number> | null;
};

const armKey = (a: Pick<AttemptRow, "provider" | "model">) => `${a.provider}|${a.model}`;

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** A mean over items grouped by task, with a bootstrap over tasks. */
export function bootstrap(byTask: Map<string, number[]>, reps = 1000, seed = 1): Interval {
  const tasks = [...byTask.keys()];
  const all = tasks.flatMap((t) => byTask.get(t)!);
  const out: Interval = { mean: mean(all), lo: null, hi: null, n: all.length };
  if (tasks.length < 2) return out;
  const random = mulberry32(seedOf("bootstrap", seed));
  const stats: number[] = [];
  for (let r = 0; r < reps; r++) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < tasks.length; i++) {
      const xs = byTask.get(tasks[Math.floor(random() * tasks.length)])!;
      for (const x of xs) sum += x;
      count += xs.length;
    }
    stats.push(count ? sum / count : 0);
  }
  stats.sort((a, b) => a - b);
  out.lo = stats[Math.floor(0.025 * (reps - 1))];
  out.hi = stats[Math.ceil(0.975 * (reps - 1))];
  return out;
}

function group<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}

/** Analyse an experiment's rows. The spec, when given, supplies the planted parameters of a sim. */
export function analyze(cells: CellRow[], attempts: AttemptRow[], spec?: ExperimentSpec | null): Analysis {
  const modeOf = new Map(cells.map((c) => [c.cell, c.mode]));
  const sizeOf = new Map(cells.map((c) => [c.cell, c.size]));
  // The pool for single-attempt rates: every independent attempt, and every
  // attempt that ran alone. A team of one has no peers to work with.
  const pool = attempts.filter((a) => a.outcome !== "cancelled" && (modeOf.get(a.cell) === "independent" || sizeOf.get(a.cell) === 1));
  const tally = new Map<string, { n: number; c: number }>();
  for (const a of pool) {
    const k = `${a.task}#${armKey(a)}`;
    const t = tally.get(k) ?? { n: 0, c: 0 };
    t.n++;
    t.c += a.pass;
    tally.set(k, t);
  }
  const attemptsByCell = group(attempts, (a) => a.cell);

  /** The sampling prediction for one cell: the chance its arms include a pass if every try were independent. */
  const predict = (cell: CellRow): number | null => {
    const mine = attemptsByCell.get(cell.cell) ?? [];
    if (mine.length === 0) return null;
    let none = 1;
    for (const [k, list] of group(mine, armKey)) {
      const t = tally.get(`${cell.task}#${k}`);
      if (!t || t.n === 0) return null;
      none *= 1 - passAtK(t.n, t.c, list.length);
    }
    return 1 - none;
  };

  // For a sim, the exact solved rate of every cell under the planted model.
  const truth = new Map<string, number>();
  if (spec && spec.backend === "sim") {
    for (const c of cellsOf(spec)) truth.set(c.id, expectedSolve(simInput(spec, c)));
  }

  const conditionNames = [...new Set(cells.map((c) => c.condition))];
  const specConditions = spec?.conditions ?? [];
  const order = [...specConditions.map((c) => c.name).filter((n) => conditionNames.includes(n)), ...conditionNames.filter((n) => !specConditions.some((c) => c.name === n))];

  const byCondition = group(cells, (c) => c.condition);
  const providerOf = (name: string) => specConditions.find((c) => c.name === name)?.provider ?? null;

  const conditions: ConditionStats[] = order.map((name) => {
    const mine = byCondition.get(name) ?? [];
    const mode = mine[0]?.mode ?? "independent";
    const reference = mode === "team" ? order.find((o) => o !== name && byCondition.get(o)?.[0]?.mode === "independent" && providerOf(o) === providerOf(name)) ?? null : null;
    const refCells = new Map((reference ? byCondition.get(reference) ?? [] : []).map((c) => [`${c.size}|${c.seed}|${c.task}`, c]));

    const arms = new Set((attempts.filter((a) => a.condition === name)).map(armKey));
    const poolMine = pool.filter((a) => arms.has(armKey(a)));
    const pooledRate = poolMine.length > 0 ? mean(poolMine.map((a) => a.pass)) : null;

    const sizes: SizeStats[] = [...group(mine, (c) => String(c.size)).entries()]
      .map(([, list]) => {
        const size = list[0].size;
        const observed = bootstrap(new Map([...group(list, (c) => c.task)].map(([t, cs]) => [t, cs.map((c) => c.solved as number)])), 1000, size);
        const preds = list.map(predict);
        const known = preds.filter((p): p is number => p !== null);
        const sampling = known.length === list.length ? mean(known) : null;
        const naive = pooledRate === null ? null : 1 - (1 - pooledRate) ** size;
        let coordination: Interval | null = null;
        const truths = list.map((c) => truth.get(c.cell)).filter((x): x is number => x !== undefined);
        let truthCoordination: number | null = null;
        if (reference) {
          const pairs = list.map((c) => [truth.get(c.cell), truth.get(refCells.get(`${c.size}|${c.seed}|${c.task}`)?.cell ?? "")]).filter((p): p is [number, number] => p[0] !== undefined && p[1] !== undefined);
          if (pairs.length > 0) truthCoordination = mean(pairs.map(([t, r]) => t - r));
          const diffs = new Map<string, number[]>();
          for (const c of list) {
            const r = refCells.get(`${c.size}|${c.seed}|${c.task}`);
            if (!r) continue;
            const d = diffs.get(c.task) ?? [];
            d.push(c.solved - r.solved);
            diffs.set(c.task, d);
          }
          if (diffs.size > 0) coordination = bootstrap(diffs, 1000, size + 7);
        }
        const solved = list.filter((c) => c.solved === 1);
        const cost = list.reduce((s, c) => s + c.cost_usd, 0);
        const withHoldout = list.filter((c) => c.solved === 0 || c.holdout_pass !== null);
        const anyHoldout = list.some((c) => c.holdout_pass !== null);
        const effectiveN = pooledRate && pooledRate > 0 && pooledRate < 1 && observed.mean < 1 ? Math.log(1 - observed.mean) / Math.log(1 - pooledRate) : null;
        return {
          size,
          cells: list.length,
          observed,
          naive,
          sampling,
          gap: sampling === null ? null : observed.mean - sampling,
          coordination,
          truth: truths.length === list.length ? mean(truths) : null,
          truthCoordination,
          effectiveN,
          costPerCell: cost / list.length,
          costPerSolved: solved.length > 0 ? cost / solved.length : null,
          minutesToFirst: median(solved.map((c) => c.minutes_to_first).filter((x): x is number => x !== null)),
          hidden: anyHoldout ? mean(withHoldout.map((c) => (c.holdout_pass === 1 ? 1 : 0))) : null,
        };
      })
      .sort((a, b) => a.size - b.size);

    const steps: Step[] = [];
    for (let i = 1; i < sizes.length; i++) {
      const a = sizes[i - 1];
      const b = sizes[i];
      const gain = b.observed.mean - a.observed.mean;
      const sampling = a.sampling !== null && b.sampling !== null ? b.sampling - a.sampling : null;
      const coordination = a.coordination && b.coordination ? b.coordination.mean - a.coordination.mean : null;
      steps.push({
        from: a.size,
        to: b.size,
        gain,
        perDoubling: gain / Math.log2(b.size / a.size),
        sampling,
        coordination,
        rest: sampling === null ? null : gain - sampling - (coordination ?? 0),
      });
    }
    let bend: ConditionStats["bend"] = null;
    for (let i = 1; i < steps.length; i++) {
      const fall = steps[i - 1].perDoubling - steps[i].perDoubling;
      if (fall > 0 && (!bend || fall > bend.before.perDoubling - bend.step.perDoubling)) bend = { step: steps[i], before: steps[i - 1] };
    }
    return { name, mode, reference, pooledRate, sizes, steps, bend };
  });

  const planted =
    spec && spec.backend === "sim"
      ? {
          runCorrelation: spec.sim.runCorrelation,
          armTaskSpread: spec.sim.armTaskSpread,
          taskSpread: spec.sim.taskSpread,
          synergy: spec.sim.team.synergy,
          conflictRate: spec.sim.team.conflictRate,
          overfit: spec.sim.overfit,
        }
      : null;

  return {
    experiment: cells[0]?.experiment ?? spec?.name ?? "",
    backend: cells[0]?.backend ?? spec?.backend ?? "",
    cells: cells.length,
    attempts: attempts.length,
    tasks: new Set(cells.map((c) => c.task)).size,
    seeds: new Set(cells.map((c) => c.seed)).size,
    conditions,
    planted,
  };
}

// -- the report ---------------------------------------------------------------

const pct = (x: number | null, signed = false) => (x === null ? "·" : `${signed && x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
const pts = (x: number | null) => (x === null ? "·" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} pts`);
const ci = (i: Interval, signed = false) => (i.lo === null || i.hi === null ? pct(i.mean, signed) : `${pct(i.mean, signed)} [${pct(i.lo, signed)}, ${pct(i.hi, signed)}]`);
const money = (x: number | null) => (x === null ? "·" : `$${x < 1 ? x.toFixed(3) : x.toFixed(2)}`);

function table(head: string[], rows: string[][]): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => "  " + r.map((c, i) => (i === 0 ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join("   ").trimEnd();
  return [line(head), ...rows.map(line)];
}

export function renderReport(a: Analysis): string {
  if (a.cells === 0) return "No finished cells yet.";
  const out: string[] = [];
  out.push(`${a.experiment} · ${a.backend} backend · ${a.tasks} task${a.tasks === 1 ? "" : "s"} × ${a.seeds} seed${a.seeds === 1 ? "" : "s"} · ${a.cells} cells · ${a.attempts} attempts`);
  if (a.planted) out.push(`planted · ${Object.entries(a.planted).map(([k, v]) => `${k} ${v}`).join(" · ")}`);

  const sizes = [...new Set(a.conditions.flatMap((c) => c.sizes.map((s) => s.size)))].sort((x, y) => x - y);
  const at = (c: ConditionStats, n: number) => c.sizes.find((s) => s.size === n) ?? null;

  out.push("", "Solved, by team size. Brackets are 95% intervals over tasks.");
  out.push(...table(["size", ...a.conditions.map((c) => c.name)], sizes.map((n) => [String(n), ...a.conditions.map((c) => (at(c, n) ? ci(at(c, n)!.observed) : "·"))])));

  for (const c of a.conditions) {
    out.push("", `${c.name}${c.name === c.mode ? "" : ` · ${c.mode}`}${c.pooledRate !== null ? ` · one try solves ${pct(c.pooledRate)}` : ""}`);
    const withTruth = c.sizes.some((s) => s.truth !== null);
    const head = ["size", "naive", "sampling", "observed", ...(withTruth ? ["model"] : []), c.mode === "team" ? "gap" : "correlation", "effective tries"];
    if (c.mode === "team") head.push(`vs ${c.reference ?? "no reference"}`, ...(withTruth ? ["model"] : []));
    out.push(
      ...table(
        head,
        c.sizes.map((s) => {
          const row = [String(s.size), pct(s.naive), pct(s.sampling), pct(s.observed.mean), ...(withTruth ? [pct(s.truth)] : []), pts(s.gap), s.effectiveN === null ? "·" : s.effectiveN.toFixed(1)];
          if (c.mode === "team") row.push(s.coordination ? ci(s.coordination, true) : "·", ...(withTruth ? [pct(s.truthCoordination, true)] : []));
          return row;
        }),
      ),
    );
  }

  out.push("", "Cost and time");
  const costRows: string[][] = [];
  for (const c of a.conditions) for (const s of c.sizes) costRows.push([String(s.size), c.name, money(s.costPerCell), money(s.costPerSolved), s.minutesToFirst === null ? "·" : s.minutesToFirst.toFixed(1), pct(s.hidden)]);
  out.push(...table(["size", "condition", "per cell", "per solved", "minutes to first", "held-out pass"], costRows));

  out.push("", "Where the curve bends");
  for (const c of a.conditions) {
    if (!c.bend) {
      out.push(`  ${c.name}: ${c.sizes.length < 3 ? "needs three sizes or more" : "gain per doubling never falls"}.`);
      continue;
    }
    const { step, before } = c.bend;
    out.push(`  ${c.name}: gain per doubling falls from ${pts(before.perDoubling)} for ${before.from} to ${before.to}, to ${pts(step.perDoubling)} for ${step.from} to ${step.to}.`);
    const parts = [`Sampling alone predicts ${pts(step.sampling)}.`];
    if (step.coordination !== null) parts.push(`Coordination moves ${pts(step.coordination)}.`);
    if (step.rest !== null) parts.push(`Within-run correlation and noise ${pts(step.rest)}.`);
    out.push(`    From ${step.from} to ${step.to} the curve gained ${pts(step.gain)}. ${parts.join(" ")}`);
  }

  out.push(
    "",
    "naive: one pooled rate, every task alike, every try independent.",
    "sampling: each task's own rate for each arm the cell ran, every try independent.",
    "correlation: observed minus sampling. Below zero, attempts in one run fail together.",
    "effective tries: independent tries at the pooled rate that would match the observed rate.",
    ...(a.planted ? ["model: the exact rate the planted parameters imply. Observed should sit near it, inside the interval."] : []),
  );
  return out.join("\n");
}
