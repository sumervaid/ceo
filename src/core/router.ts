/**
 * The router: which arms a task's attempts run on.
 *
 * An arm is a provider, a model, and optionally extra skills and docket
 * items. A task that names its arms gets exactly those. Otherwise the
 * router runs a bandit per kind of work. Each arm has a record of passes
 * and fails on that kind, read from the org's own ledger and, at half
 * weight, from Reflex's store. Thompson sampling draws one plausible pass
 * rate per arm from that record, and the best draws run. Arms with little
 * evidence draw widely, so untried arms still get a turn.
 *
 * `chooseArms` is the one entry point the dispatcher calls. `routerTable`
 * and `recommend` show the evidence and the choice without running anything.
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";

import { reflexDbPath } from "./history.js";
import { readLedger } from "./ledger.js";
import { providerFor } from "./providers.js";
import { providerReadiness } from "./setup.js";
import { readySkills, type Skill } from "./skills.js";
import { armKey, armLabel, PROVIDERS, type AgentRecord, type Arm, type LedgerEntry, type Provider } from "./types.js";
import { combine } from "./verify.js";

export const TASK_KINDS = ["review", "ci", "debug", "feature", "edit", "research", "explore"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

const KIND_WORDS: Array<[TaskKind, RegExp]> = [
  ["review", /\b(review|audit|check the diff|look over|critique)\b/i],
  ["ci", /\b(ci|pipeline|build is red|workflow|flaky|lint)\b/i],
  ["debug", /\b(bug|fix|broken|crash|error|fail(s|ing)?|regression|debug)\b/i],
  ["research", /\b(research|investigate|compare|evaluate|survey|find out|benchmark)\b/i],
  ["explore", /\b(map|explore|understand|where is|how does|trace|callers)\b/i],
  ["edit", /\b(rename|refactor|update|bump|tweak|edit|clean ?up|docs?)\b/i],
  ["feature", /\b(add|implement|build|create|support|new)\b/i],
];

/** A task's kind from its words. The first rule that matches wins. */
export function taskKind(title: string): TaskKind {
  for (const [kind, re] of KIND_WORDS) if (re.test(title)) return kind;
  return "feature";
}

export type ArmChoice = {
  arm: Arm;
  /** named: the task named it. pick: the router's best draw. explore: tried to learn or to diversify. */
  mode: "named" | "pick" | "explore";
  why: string;
};

export type RouterContext = {
  root: string;
  ready?: (p: Provider) => boolean;
  random?: () => number;
  /** The skills a variant arm may carry. Default: every ready skill on the machine. */
  skills?: Skill[];
};

function readyNow(p: Provider): boolean {
  if (process.env.CEO_SKIP_SETUP_CHECK) return true;
  try {
    return providerReadiness(p).ready;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Random draws
// ---------------------------------------------------------------------------

function normal(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** A Gamma(shape, 1) draw by Marsaglia and Tsang. */
export function sampleGamma(shape: number, random: () => number): number {
  if (shape < 1) return sampleGamma(shape + 1, random) * Math.pow(Math.max(random(), 1e-12), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(random);
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = Math.max(random(), 1e-12);
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

/** A Beta(a, b) draw from two Gamma draws. */
export function sampleBeta(a: number, b: number, random: () => number): number {
  const x = sampleGamma(a, random);
  const y = sampleGamma(b, random);
  return x + y > 0 ? x / (x + y) : 0.5;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** One Reflex observation counts for this much of a CEO observation. */
export const REFLEX_WEIGHT = 0.5;
/** An arm starts from this share of the evidence for the other arms on the same provider. */
const BORROW = 0.25;
/** Draws closer than this are a tie, and the cheaper arm wins the tie. */
const TIE = 0.02;

type Tally = {
  kind: TaskKind;
  arm: Arm;
  ceoN: number;
  ceoPass: number;
  ceoCost: number;
  reflexN: number;
  reflexPass: number;
};

type Evidence = Map<string, Tally>;

function tallyFor(ev: Evidence, kind: TaskKind, arm: Arm): Tally {
  const key = `${kind}\u0000${armKey(arm)}`;
  let t = ev.get(key);
  if (!t) {
    t = { kind, arm, ceoN: 0, ceoPass: 0, ceoCost: 0, reflexN: 0, reflexPass: 0 };
    ev.set(key, t);
  }
  return t;
}

function isKind(k: unknown): k is TaskKind {
  return typeof k === "string" && (TASK_KINDS as readonly string[]).includes(k);
}

/**
 * Finished attempts from one pass over the ledger. A pass is a passing
 * verdict. An attempt with no verifiers passes when the run finished.
 * Cancelled attempts, provider limits and checks that could not run say
 * nothing about the arm and are left out.
 */
function ledgerEvidence(entries: LedgerEntry[], ev: Evidence): void {
  const starts = new Map<string, { kind: TaskKind; arm: Arm }>();
  const verifies = new Map<string, Array<{ required: boolean; weight: number; status: string; score: number | null }>>();
  const ends: Array<{ id: string; outcome: string; cost: number }> = [];
  for (const e of entries) {
    const id = typeof e.data.attemptId === "string" ? e.data.attemptId : null;
    if (!id) continue;
    if (e.type === "attempt_start") {
      const arm = e.data.arm as Arm | undefined;
      if (isKind(e.data.kind) && arm && typeof arm.provider === "string" && typeof arm.model === "string") starts.set(id, { kind: e.data.kind, arm });
    } else if (e.type === "attempt_end") {
      ends.push({ id, outcome: String(e.data.outcome), cost: Number(e.data.costUsd ?? 0) || 0 });
    } else if (e.type === "verify") {
      const v = e.data.verifier as { required?: boolean; weight?: number } | undefined;
      const list = verifies.get(id) ?? [];
      list.push({ required: v?.required !== false, weight: v?.weight ?? 1, status: String(e.data.status), score: typeof e.data.score === "number" ? e.data.score : null });
      verifies.set(id, list);
    }
  }
  for (const end of ends) {
    const start = starts.get(end.id);
    if (!start || (end.outcome !== "done" && end.outcome !== "failed")) continue;
    let pass = end.outcome === "done";
    const checks = verifies.get(end.id);
    if (checks && end.outcome === "done") {
      const v = combine(checks.map((r) => ({ spec: { kind: "command", run: "", required: r.required, weight: r.weight }, result: { status: r.status as "pass" | "fail" | "error", score: r.score, detail: "", evidence: {} } })));
      if (v.errored && !v.pass) continue;
      pass = v.pass;
    }
    const t = tallyFor(ev, start.kind, start.arm);
    t.ceoN += 1;
    if (pass) t.ceoPass += 1;
    t.ceoCost += end.cost;
  }
}

type SqliteDb = { prepare: (s: string) => { all: () => unknown[] }; close: () => void };

/** Rows from a read-only query, or [] on any failure. The file is never written. */
function reflexRows(file: string, sql: string): Array<Record<string, unknown>> {
  try {
    const emit = process.emitWarning;
    let mod: { DatabaseSync: new (p: string, o: { readOnly: boolean }) => SqliteDb } | null = null;
    process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
      if (/SQLite/i.test(typeof w === "string" ? w : w.message)) return;
      (emit as (...a: unknown[]) => void).call(process, w, ...rest);
    }) as typeof process.emitWarning;
    try {
      mod = createRequire(import.meta.url)("node:sqlite");
    } catch {
      mod = null;
    } finally {
      process.emitWarning = emit;
    }
    if (mod) {
      const db = new mod.DatabaseSync(file, { readOnly: true });
      try {
        return db.prepare(sql).all() as Array<Record<string, unknown>>;
      } finally {
        db.close();
      }
    }
    const r = spawnSync("sqlite3", ["-readonly", "-json", file, sql], { encoding: "utf8", timeout: 10000 });
    if (r.status !== 0 || !r.stdout.trim()) return [];
    return JSON.parse(r.stdout) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

function parseJson(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "string") return null;
  try {
    const x = JSON.parse(v);
    return x && typeof x === "object" ? (x as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const REFLEX_PROVIDER: Record<string, Provider> = { "claude-code": "claude", claude: "claude", codex: "codex", gemini: "gemini" };

/** Reflex names a model more loosely than a provider does. Match by prefix, else keep the name. */
function modelFor(provider: Provider, model: string): string {
  let known: string[] = [];
  try {
    known = providerFor(provider).models();
  } catch {
    known = [];
  }
  if (known.includes(model)) return model;
  return known.find((m) => model.startsWith(m) || m.startsWith(model)) ?? model;
}

type ReflexRow = { kind: TaskKind; arm: Arm; pass: boolean };

function reflexObservations(file: string): ReflexRow[] {
  const out: ReflexRow[] = [];
  const add = (source: unknown, model: unknown, kind: unknown, pass: unknown): void => {
    const provider = typeof source === "string" ? REFLEX_PROVIDER[source] : undefined;
    if (!provider || typeof model !== "string" || !model || !isKind(kind) || typeof pass !== "boolean") return;
    out.push({ kind, arm: { provider, model: modelFor(provider, model) }, pass });
  };
  for (const row of reflexRows(file, "select run_json from route_runs")) {
    const r = parseJson(row.run_json);
    if (r && (r.outcome === "done" || r.outcome === "not-done")) add(r.source, r.model, r.kind, r.outcome === "done");
  }
  for (const row of reflexRows(file, "select result_json from bench_results")) {
    const r = parseJson(row.result_json);
    if (r) add(r.source, r.model, r.kind, r.pass);
  }
  for (const row of reflexRows(file, "select trace_json from traces")) {
    const t = parseJson(row.trace_json);
    const verified = (t?.outcome as { verified?: unknown } | undefined)?.verified;
    if (!t || typeof verified !== "boolean") continue;
    const usage = t.usageByModel;
    if (!usage || typeof usage !== "object") continue;
    // The model that did the most work in the session.
    let model: string | null = null;
    let most = -1;
    for (const [m, u] of Object.entries(usage as Record<string, unknown>)) {
      const size = u && typeof u === "object" ? Object.values(u as Record<string, unknown>).reduce<number>((a, x) => a + (typeof x === "number" ? x : 0), 0) : typeof u === "number" ? u : 0;
      if (size > most) {
        most = size;
        model = m;
      }
    }
    const first = (t.requests as Array<{ text?: unknown }> | undefined)?.[0]?.text;
    const text = typeof first === "string" ? first : Array.isArray(t.intents) ? t.intents.filter((x) => typeof x === "string").join(" ") : "";
    if (text) add(t.source, model, taskKind(text), verified);
  }
  return out;
}

let reflexMemo: { file: string; mtime: number; at: number; rows: ReflexRow[] } | null = null;
const REFLEX_TTL_MS = 60_000;

/** Drop the memoized Reflex read. For tests. */
export function resetRouterCache(): void {
  reflexMemo = null;
}

function reflexPrior(): ReflexRow[] {
  try {
    const file = reflexDbPath();
    if (!existsSync(file)) return [];
    const mtime = statSync(file).mtimeMs;
    const now = Date.now();
    if (reflexMemo && reflexMemo.file === file && reflexMemo.mtime === mtime && now - reflexMemo.at < REFLEX_TTL_MS) return reflexMemo.rows;
    const rows = reflexObservations(file);
    reflexMemo = { file, mtime, at: now, rows };
    return rows;
  } catch {
    return [];
  }
}

function gather(root: string): Evidence {
  const ev: Evidence = new Map();
  try {
    ledgerEvidence(readLedger(root), ev);
  } catch {
    /* no ledger yet */
  }
  for (const r of reflexPrior()) {
    const t = tallyFor(ev, r.kind, r.arm);
    t.reflexN += 1;
    if (r.pass) t.reflexPass += 1;
  }
  return ev;
}

type Stats = { n: number; pass: number; wN: number; wPass: number; cost: number | null; source: "ceo" | "reflex" | "both" | "none" };

function statsOf(ev: Evidence, kind: TaskKind, arm: Arm): Stats {
  const key = armKey(arm);
  const t = ev.get(`${kind}\u0000${key}`);
  let wN = t ? t.ceoN + REFLEX_WEIGHT * t.reflexN : 0;
  let wPass = t ? t.ceoPass + REFLEX_WEIGHT * t.reflexPass : 0;
  // A model with no record leans on how the provider's other arms did, and a skill variant leans on the plain arm.
  for (const o of ev.values()) {
    if (o.kind !== kind || o.arm.provider !== arm.provider || armKey(o.arm) === key) continue;
    wN += BORROW * (o.ceoN + REFLEX_WEIGHT * o.reflexN);
    wPass += BORROW * (o.ceoPass + REFLEX_WEIGHT * o.reflexPass);
  }
  const n = t ? t.ceoN + t.reflexN : 0;
  return {
    n,
    pass: t ? t.ceoPass + t.reflexPass : 0,
    wN,
    wPass,
    cost: t && t.ceoN > 0 ? t.ceoCost / t.ceoN : null,
    source: !t || n === 0 ? "none" : t.ceoN > 0 && t.reflexN > 0 ? "both" : t.ceoN > 0 ? "ceo" : "reflex",
  };
}

export type RouterRow = {
  kind: TaskKind;
  arm: Arm;
  label: string;
  observations: number;
  passes: number;
  /** Passes over observations, with a Reflex observation counted at half. */
  passRate: number;
  /** Mean cost of a CEO attempt, or null when the ledger has none. */
  meanCostUsd: number | null;
  /** CEO spend on this arm divided by its passes, or null with no pass. */
  costPerVerified: number | null;
  source: "ceo" | "reflex" | "both";
};

/** What the router knows: one row per arm with evidence, per kind of work. */
export function routerTable(cwd?: string, kind?: TaskKind | string): RouterRow[] {
  const ev = gather(cwd ?? process.cwd());
  const rows: RouterRow[] = [];
  for (const t of ev.values()) {
    if (kind && t.kind !== kind) continue;
    const s = statsOf(ev, t.kind, t.arm);
    if (s.n === 0 || s.source === "none") continue;
    const own = t.ceoN + REFLEX_WEIGHT * t.reflexN;
    rows.push({
      kind: t.kind,
      arm: t.arm,
      label: armLabel(t.arm),
      observations: s.n,
      passes: s.pass,
      passRate: own > 0 ? (t.ceoPass + REFLEX_WEIGHT * t.reflexPass) / own : 0,
      meanCostUsd: s.cost,
      costPerVerified: t.ceoPass > 0 ? t.ceoCost / t.ceoPass : null,
      source: s.source,
    });
  }
  return rows.sort((a, b) => TASK_KINDS.indexOf(a.kind) - TASK_KINDS.indexOf(b.kind) || b.passRate - a.passRate || b.observations - a.observations || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------

const STOP = new Set(["with", "that", "this", "from", "into", "have", "when", "then", "than", "them", "what", "which", "will", "should", "make", "does", "need", "task"]);

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
}

/** At most two ready skills whose name or description share words with the task. */
function matchingSkills(title: string, skills: Skill[]): Skill[] {
  const task = words(title);
  if (task.size === 0) return [];
  return skills
    .map((s) => {
      const named = [...words(s.name.replace(/[-_]/g, " "))].filter((w) => task.has(w)).length;
      const described = [...words(s.description)].filter((w) => task.has(w)).length;
      return { s, score: named * 2 + described, ok: named >= 1 || described >= 2 };
    })
    .filter((x) => x.ok)
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
    .slice(0, 2)
    .map((x) => x.s);
}

function phrase(s: Stats, kind: TaskKind): string {
  if (s.n === 0) return `untried on ${kind}`;
  const passed = Number.isInteger(s.pass) ? s.pass : Math.round(s.pass * 10) / 10;
  return `${passed} of ${s.n} passed on ${kind}`;
}

type Candidate = { arm: Arm; s: Stats; theta: number };

/** Best draw first. A draw within the tie band of the best goes to the cheaper arm. */
function rankByDraw(cands: Candidate[]): Candidate[] {
  const left = [...cands].sort((a, b) => b.theta - a.theta);
  const out: Candidate[] = [];
  while (left.length > 0) {
    const top = left[0].theta;
    const band = left.filter((c) => top - c.theta <= TIE && c.s.cost !== null);
    let at = 0;
    if (band.length > 1 && left[0].s.cost !== null) {
      const cheapest = band.reduce((a, b) => (b.s.cost! < a.s.cost! ? b : a));
      at = left.indexOf(cheapest);
    }
    out.push(left.splice(at, 1)[0]);
  }
  return out;
}

function pickArms(kind: TaskKind, title: string, own: Arm | null, n: number, ctx: RouterContext): ArmChoice[] {
  const random = ctx.random ?? Math.random;
  const ready = ctx.ready ?? readyNow;
  const ev = gather(ctx.root);

  const arms = new Map<string, Arm>();
  const add = (a: Arm): void => {
    if (!arms.has(armKey(a))) arms.set(armKey(a), a);
  };
  if (own) add(own);
  for (const p of PROVIDERS) {
    if (!ready(p)) continue;
    for (const model of providerFor(p).models()) add({ provider: p, model });
  }
  const skillFor = new Map<string, string>();
  if (own && title) {
    let pool: Skill[] = [];
    try {
      pool = ctx.skills ?? readySkills(ctx.root);
    } catch {
      pool = [];
    }
    for (const sk of matchingSkills(title, pool.filter((s) => s.status === "ready"))) {
      const variant: Arm = { provider: own.provider, model: own.model, skills: [sk.name] };
      add(variant);
      skillFor.set(armKey(variant), sk.name);
    }
  }

  const cands: Candidate[] = [...arms.values()].map((arm) => {
    const s = statsOf(ev, kind, arm);
    return { arm, s, theta: sampleBeta(1 + s.wPass, 1 + Math.max(0, s.wN - s.wPass), random) };
  });
  const ranked = rankByDraw(cands);
  const note = new Map<string, string>();
  const chosen: Candidate[] = [];
  const taken = new Set<string>();
  const take = (c: Candidate, why?: string): void => {
    chosen.push(c);
    taken.add(armKey(c.arm));
    if (why) note.set(armKey(c.arm), why);
  };

  // Cover as many ready providers as the attempts allow: the best draw on
  // each, in draw order. Three attempts with three providers ready run one
  // on each, so every task compares providers.
  const providers = new Set(cands.map((c) => c.arm.provider));
  const cover = Math.min(n, providers.size);
  const covered = new Set<Provider>();
  for (const c of ranked) {
    if (covered.size >= cover) break;
    if (covered.has(c.arm.provider)) continue;
    covered.add(c.arm.provider);
    take(c, chosen.length > 0 ? "the best draw on another provider" : undefined);
  }

  // One slot to learn, once every provider is covered: the least observed arm left.
  if (n > chosen.length && n >= 3) {
    const rest = cands.filter((c) => !taken.has(armKey(c.arm)));
    if (rest.length > 0) {
      const fewest = Math.min(...rest.map((c) => c.s.n));
      const tied = rest.filter((c) => c.s.n === fewest);
      take(tied[Math.min(tied.length - 1, Math.floor(random() * tied.length))], "the least tried arm");
    }
  }

  // The rest by draw.
  for (const c of ranked) {
    if (chosen.length >= n) break;
    if (!taken.has(armKey(c.arm))) take(c);
  }

  return Array.from({ length: n }, (_, i) => {
    const c = chosen[i % chosen.length];
    const key = armKey(c.arm);
    const repeat = i >= chosen.length;
    const parts = [phrase(c.s, kind)];
    if (skillFor.has(key)) parts.push(`with skill ${skillFor.get(key)}`);
    if (note.has(key)) parts.push(note.get(key)!);
    if (repeat) parts.push("a repeat for a second sample");
    return { arm: c.arm, mode: i === 0 ? ("pick" as const) : ("explore" as const), why: parts.join(", ") };
  });
}

/**
 * The arms for `n` attempts of a task. Named arms come first and repeat
 * when `n` is larger. Otherwise Thompson sampling over every ready
 * provider's models, the agent's own arm and a few skill variants.
 */
export function chooseArms(
  task: { title: string; kind?: string | null; arms?: Arm[]; provider?: Provider | null },
  agent: AgentRecord,
  n: number,
  ctx: RouterContext,
): ArmChoice[] {
  const count = Math.max(1, Math.floor(n));
  if (task.arms && task.arms.length > 0) {
    return Array.from({ length: count }, (_, i) => ({ arm: task.arms![i % task.arms!.length], mode: "named" as const, why: "named on the task" }));
  }
  const own: Arm = task.provider && task.provider !== agent.provider ? { provider: task.provider, model: providerFor(task.provider).defaultModel() } : { provider: agent.provider, model: agent.model };
  const kind = isKind(task.kind) ? task.kind : taskKind(task.title);
  return pickArms(kind, task.title, own, count, ctx);
}

/** The arms the router would choose for a kind of work, with no agent in mind. */
export function recommend(kind: TaskKind | string, cwd: string | undefined, n: number, opts: { ready?: (p: Provider) => boolean; random?: () => number } = {}): ArmChoice[] {
  const k: TaskKind = isKind(kind) ? kind : "feature";
  const root = cwd ?? process.cwd();
  return pickArms(k, "", null, Math.max(1, Math.floor(n)), { root, ready: opts.ready, random: opts.random });
}

function money(n: number | null): string {
  if (n === null) return "-";
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** The table as aligned text, one line per arm. */
export function renderRouterTable(rows: RouterRow[]): string {
  if (rows.length === 0) return "No evidence yet. Every arm is untried, so the router explores.";
  const head = ["kind", "arm", "passed", "rate", "mean cost", "per verified", "from"];
  const body = rows.map((r) => [r.kind, r.label, `${Math.round(r.passes * 10) / 10} of ${r.observations}`, `${Math.round(r.passRate * 100)}%`, money(r.meanCostUsd), money(r.costPerVerified), r.source]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(head), ...body.map(line)].join("\n");
}

/** The choices as lines of text: the arm, the mode and the reason. */
export function renderChoices(choices: ArmChoice[]): string {
  return choices.map((c, i) => `${i + 1}. ${armLabel(c.arm)}  ${c.mode}  ${c.why}`).join("\n");
}
