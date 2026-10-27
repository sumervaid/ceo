/**
 * A proposed team for this repository, with the evidence for each seat.
 *
 * Three kinds of evidence, in order of how much they are trusted:
 *
 *   Reflex workflows   a task people keep doing here, found by Reflex across
 *                      three or more independent sessions, with the steps
 *                      that worked and the corrections they kept giving.
 *                      Each becomes an agent whose brief is that workflow.
 *
 *   Session history    which models have been used in this repo, how much a
 *                      session here tends to cost, what people asked for.
 *                      Sets the model, provider and budget of every seat.
 *
 *   The repository     manifest, test runner, CI, docs. Decides which of the
 *                      standard roles earn a seat: scout, reviewer, implementer,
 *                      tester, documenter. Adds the repo's own commands to
 *                      their briefs.
 *
 * Nothing here is a model call. A suggestion is a deterministic function of
 * local files, so the same repo and history always propose the same team.
 * Every line of a suggestion can be traced to the evidence that produced
 * it. The person edits and hires. `suggestTeam` never writes.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { ROLE_TEMPLATES } from "./nextstep.js";
import { estimateCostUsd } from "./pricing.js";
import { inferProvider } from "./providers.js";
import { validateName } from "./roster.js";
import { allSessions, readHistory, type History, type HistorySession, type ReflexWorkflow } from "./history.js";
import type { AutonomyLevel, Provider } from "./types.js";

export type TeamSuggestion = {
  name: string;
  role: string;
  collaboration: string;
  guardrails: string[];
  provider: Provider;
  model: string;
  autonomy: AutonomyLevel;
  budgetUsd: number;
  isolated: boolean;
  /** Where this seat came from. */
  source: "reflex" | "repo";
  /** Why, one line each, in the words a person can check. */
  evidence: string[];
  /** 0..1, a ranking signal. Reflex's confidence for workflows, fixed for repo roles. */
  confidence: number;
};

export type TeamProposal = {
  root: string;
  team: TeamSuggestion[];
  /** What was read, for the panel's header. */
  summary: string[];
  history: History;
};

// ---------------------------------------------------------------------------
// Repository signals
// ---------------------------------------------------------------------------

type RepoSignals = {
  name: string;
  manifest: string | null;
  testCommand: string | null;
  buildCommand: string | null;
  lintCommand: string | null;
  hasCi: boolean;
  hasDocs: boolean;
  hasTests: boolean;
  commits: number;
  languages: string[];
};

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function commitCount(root: string): number {
  try {
    return Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim()) || 0;
  } catch {
    return 0;
  }
}

export function repoSignals(root: string): RepoSignals {
  const has = (p: string) => existsSync(path.join(root, p));
  const sig: RepoSignals = {
    name: path.basename(root),
    manifest: null,
    testCommand: null,
    buildCommand: null,
    lintCommand: null,
    hasCi: has(".github/workflows") || has(".gitlab-ci.yml") || has(".circleci"),
    hasDocs: has("docs") || has("README.md"),
    hasTests: has("test") || has("tests") || has("__tests__") || has("spec"),
    commits: commitCount(root),
    languages: [],
  };

  const pkg = has("package.json") ? readJson(path.join(root, "package.json")) : null;
  if (pkg) {
    sig.manifest = "package.json";
    sig.languages.push("typescript/javascript");
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") ? "bun" : "npm";
    const run = (s: string) => (pm === "npm" ? `npm run ${s}` : `${pm} ${s}`);
    if (scripts.test) sig.testCommand = pm === "npm" ? "npm test" : `${pm} test`;
    if (scripts.build) sig.buildCommand = run("build");
    if (scripts.lint) sig.lintCommand = run("lint");
    if (scripts.typecheck && !sig.buildCommand) sig.buildCommand = run("typecheck");
    if (scripts.test) sig.hasTests = true;
  }
  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    sig.manifest = sig.manifest ?? (has("pyproject.toml") ? "pyproject.toml" : "requirements.txt");
    sig.languages.push("python");
    if (has("pytest.ini") || has("conftest.py") || has("tests")) {
      sig.testCommand = sig.testCommand ?? "pytest";
      sig.hasTests = true;
    }
  }
  if (has("Cargo.toml")) {
    sig.manifest = sig.manifest ?? "Cargo.toml";
    sig.languages.push("rust");
    sig.testCommand = sig.testCommand ?? "cargo test";
    sig.buildCommand = sig.buildCommand ?? "cargo build";
  }
  if (has("go.mod")) {
    sig.manifest = sig.manifest ?? "go.mod";
    sig.languages.push("go");
    sig.testCommand = sig.testCommand ?? "go test ./...";
    sig.buildCommand = sig.buildCommand ?? "go build ./...";
  }
  if (has("Makefile")) {
    try {
      const mk = readFileSync(path.join(root, "Makefile"), "utf8");
      if (/^test:/m.test(mk)) sig.testCommand = sig.testCommand ?? "make test";
      if (/^build:/m.test(mk)) sig.buildCommand = sig.buildCommand ?? "make build";
    } catch {
      /* no Makefile after all */
    }
  }
  if (!sig.manifest) {
    // A directory of notes or data still has a shape worth a scout.
    try {
      const n = readdirSync(root).filter((f) => !f.startsWith(".")).length;
      if (n === 0) sig.hasDocs = false;
    } catch {
      /* unreadable */
    }
  }
  return sig;
}

// ---------------------------------------------------------------------------
// Model, provider and budget from history
// ---------------------------------------------------------------------------

type ModelPick = {
  model: string;
  provider: Provider;
  sessions: number;
  verifiedRate: number | null;
  medianCostUsd: number;
  evidence: string;
};

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The model this repo's sessions have mostly run on, with how often those
 * sessions ended verified and what one tends to cost at list price. The
 * most-used model wins unless another has at least three sessions and a
 * clearly better verified rate, in which case the evidence line says so.
 */
export function pickModel(sessions: HistorySession[]): ModelPick | null {
  const byModel = new Map<string, HistorySession[]>();
  for (const s of sessions) {
    if (!s.model) continue;
    byModel.set(s.model, [...(byModel.get(s.model) ?? []), s]);
  }
  if (byModel.size === 0) return null;
  const rows = [...byModel.entries()].map(([model, ss]) => {
    const known = ss.filter((s) => s.verified !== null);
    const verifiedRate = known.length > 0 ? known.filter((s) => s.verified).length / known.length : null;
    return { model, sessions: ss.length, verifiedRate, medianCostUsd: median(ss.map((s) => s.costUsd)) };
  });
  rows.sort((a, b) => b.sessions - a.sessions);
  let pick = rows[0];
  let why = `used in ${pick.sessions} of ${sessions.length} sessions here`;
  const better = rows.find(
    (r) => r !== pick && r.sessions >= 3 && r.verifiedRate !== null && pick.verifiedRate !== null && r.verifiedRate >= pick.verifiedRate + 0.2,
  );
  if (better) {
    why = `${better.sessions} sessions here ended verified ${Math.round(better.verifiedRate! * 100)}% of the time, against ${Math.round(pick.verifiedRate! * 100)}% for ${pick.model}`;
    pick = better;
  }
  if (pick.verifiedRate !== null && !better) why += `, verified ${Math.round(pick.verifiedRate * 100)}%`;
  return {
    model: pick.model,
    provider: inferProvider(pick.model),
    sessions: pick.sessions,
    verifiedRate: pick.verifiedRate,
    medianCostUsd: pick.medianCostUsd,
    evidence: `${pick.model}: ${why}. A session here costs about $${pick.medianCostUsd.toFixed(2)} at list price`,
  };
}

/**
 * A cap that covers a few runs at this repo's usual cost, rounded to a round
 * number and never above SUGGESTED_CAP_USD. A suggestion is a starting point.
 * A default cap in the hundreds would make the first hire a gamble. The
 * evidence line beside it says what a run really costs, so the person can
 * raise it knowingly.
 */
export const SUGGESTED_CAP_USD = 25;

function budgetFor(perRunUsd: number, runs = 3, floor = 1): number {
  const raw = Math.min(SUGGESTED_CAP_USD, Math.max(floor, perRunUsd * runs));
  if (raw <= 2) return Math.ceil(raw);
  if (raw <= 10) return Math.ceil(raw);
  return Math.ceil(raw / 5) * 5;
}

// ---------------------------------------------------------------------------
// Reflex workflows as seats
// ---------------------------------------------------------------------------

const WRITE_KINDS = /^(modify-|commit|push|submit)/;

function slugify(s: string): string {
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return validateName(slug) ? "workflow" : slug;
}

function workflowSeat(w: ReflexWorkflow, pick: ModelPick | null): TeamSuggestion {
  const writes = w.steps.some((s) => WRITE_KINDS.test(s.kind));
  const autonomy: AutonomyLevel = writes ? "execute" : "propose";
  const steps = w.steps
    .filter((s) => s.support >= 0.5)
    .map((s, i) => `${i + 1}. ${s.instruction}${s.examples.length > 0 ? ` (e.g. ${s.examples.slice(0, 2).join(", ")})` : ""}`);
  const terms = w.topTerms.slice(0, 6).join(", ");
  const role = [
    `${w.whenToUse.replace(/^Use for requests similar to:?/i, "Handle requests about")}.`.replace(/\.\.$/, "."),
    steps.length > 0 ? `This is the workflow that has worked here. Follow it in order and report the result of each step:\n${steps.join("\n")}` : w.description,
    writes
      ? "Make the smallest change that fully addresses the root cause, run the project's checks, and report actual output. If a check fails, report it rather than adjusting the check."
      : "Report findings with file paths and the exact commands you ran. Do not apply changes.",
  ].join("\n\n");

  const guardrails = [
    ...w.constraints.avoid.map((a) => (/^(do not|don't|never)/i.test(a) ? a : `Do not ${a}`)),
    ...w.constraints.prefer.map((p) => (/^(always|prefer)/i.test(p) ? p : `Prefer ${p}`)),
  ].slice(0, 5);

  // Cost per run from the workflow's own token mix at the chosen model's
  // list price. That is what a budget has to cover.
  // The repo's usual model when history says so. Otherwise the provider the
  // workflow was observed on, since a codex-only workflow was done on codex.
  const codexOnly = Object.keys(w.sources).includes("codex") && !Object.keys(w.sources).includes("claude-code");
  const model = pick?.model ?? (codexOnly ? "gpt-5-codex" : "claude-sonnet-5");
  const provider = inferProvider(model);
  let perRun = pick?.medianCostUsd ?? 0;
  if (w.cost && w.cost.runs > 0) {
    const u = w.cost.usage;
    perRun = estimateCostUsd(model, (u.input + u.cacheWrite + u.cacheRead) / w.cost.runs, u.output / w.cost.runs, u.cacheRead / w.cost.runs);
  }

  const evidence = [
    `Reflex: repeated in ${w.instances} independent sessions across ${w.repositories.length} repositor${w.repositories.length === 1 ? "y" : "ies"}${w.local ? ", including this repository" : ""}. Confidence ${Math.round(w.confidence * 100)}%, a ranking signal, not a probability`,
  ];
  if (w.verifiedRate !== null) evidence.push(`${Math.round(w.verifiedRate * 100)}% of those sessions ended with a passing check`);
  if (w.cost) evidence.push(`median ${w.cost.medianToolCalls} tool calls and ~$${perRun.toFixed(2)} per run on ${model}${perRun * 3 > SUGGESTED_CAP_USD ? `. The suggested cap is held at $${SUGGESTED_CAP_USD}, raise the cap if that is intended` : ""}`);
  if (guardrails.length > 0) evidence.push(`${guardrails.length} guardrail${guardrails.length === 1 ? "" : "s"} from corrections people gave in those sessions`);
  if (pick) evidence.push(pick.evidence);
  evidence.push(`autonomy ${autonomy}: the workflow ${writes ? "changes files, so the agent works on a branch for a human to merge" : "only reads and runs commands"}`);

  return {
    name: slugify(w.slug),
    role,
    collaboration: `Hand anything outside this workflow back with a one-line note rather than improvising. If a step's command is missing or fails in an unfamiliar way, stop and say exactly what you saw.`,
    guardrails,
    provider,
    model,
    autonomy,
    budgetUsd: budgetFor(perRun),
    isolated: writes,
    source: "reflex",
    evidence,
    confidence: w.confidence,
  };
}

// ---------------------------------------------------------------------------
// Standard roles as seats
// ---------------------------------------------------------------------------

function repoSeat(
  templateName: string,
  sig: RepoSignals,
  pick: ModelPick | null,
  recentTerms: string[],
  extra: { why: string; autonomy: AutonomyLevel; isolated: boolean; brief?: string },
): TeamSuggestion {
  const t = ROLE_TEMPLATES.find((r) => r.name === templateName)!;
  const lines = [extra.brief ?? t.brief];
  const cmds: string[] = [];
  if (sig.testCommand) cmds.push(`tests run with \`${sig.testCommand}\``);
  if (sig.buildCommand) cmds.push(`the build is \`${sig.buildCommand}\``);
  if (sig.lintCommand) cmds.push(`lint with \`${sig.lintCommand}\``);
  if (cmds.length > 0 && templateName !== "researcher") lines.push(`In this repository ${cmds.join(", ")}.`);
  if (recentTerms.length > 0 && (templateName === "scout" || templateName === "implementer")) {
    lines.push(`Recent work here has been about: ${recentTerms.join(", ")}.`);
  }
  const model = pick?.model ?? "claude-sonnet-5";
  const perRun = pick?.medianCostUsd ?? 0.5;
  const evidence = [extra.why];
  if (pick) evidence.push(pick.evidence);
  else evidence.push("no session history found here, so the default model. Change it on the form");
  return {
    name: t.name,
    role: lines.join(" "),
    collaboration: templateName === "scout" ? "Everyone else works from your map. Answer precisely and name what you did not read." : "Defer to the scout's map of the codebase. Hand off anything outside your brief with a one-line note.",
    guardrails: [],
    provider: inferProvider(model),
    model,
    autonomy: extra.autonomy,
    budgetUsd: budgetFor(perRun, extra.autonomy === "observe" ? 2 : 3),
    isolated: extra.isolated,
    source: "repo",
    evidence,
    confidence: 0.5,
  };
}

const STOP = new Set(
  "the a an and or of to in on for with from by at as is are was were be been it its this that these those i we you they he she my our your their me us them do does did done can could should would will just like want need make made get got into out up down over under about how what when where which who why not no yes please let lets also then than there here very more most some any all each every both few many much such own same so too only once ever never now new old use using used run running file files code repo project".split(
    " ",
  ),
);

/** The words people keep using in their first requests here, for a brief. */
export function recentTerms(sessions: HistorySession[], n = 6): string[] {
  const freq = new Map<string, number>();
  for (const s of sessions) {
    const seen = new Set<string>();
    for (const r of s.requests) {
      for (const w of r.toLowerCase().replace(/[`'"<>]/g, " ").split(/[^a-z0-9-]+/)) {
        if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w) || seen.has(w)) continue;
        seen.add(w);
        freq.set(w, (freq.get(w) ?? 0) + 1);
      }
    }
  }
  return [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

// ---------------------------------------------------------------------------
// The proposal
// ---------------------------------------------------------------------------

export type SuggestOptions = {
  days?: number;
  /** Include Reflex workflows seen in other repositories too. Default: only this repo's, unless it has none. */
  everywhere?: boolean;
  /** Names already in the org, which suggestions avoid. */
  taken?: string[];
  env?: NodeJS.ProcessEnv;
};

export async function suggestTeam(root: string, opts: SuggestOptions = {}): Promise<TeamProposal> {
  const history = await readHistory(root, { days: opts.days ?? 60, env: opts.env });
  const sessions = allSessions(history);
  const sig = repoSignals(root);
  const pick = pickModel(sessions);
  const terms = recentTerms(sessions);
  const taken = new Set(opts.taken ?? []);

  const team: TeamSuggestion[] = [];

  // Reflex workflows first: they are the only evidence of what this repo
  // actually keeps needing, as opposed to what repositories usually need.
  // A workflow from elsewhere is offered only when it is strong: confident,
  // usually verified, and seen in a named repository rather than a redacted
  // home directory. `everywhere` lifts the filter.
  const local = history.reflex.workflows.filter((w) => w.local && w.status !== "rejected");
  const strong = (w: ReflexWorkflow) =>
    w.confidence >= 0.7 && (w.verifiedRate === null || w.verifiedRate >= 0.5) && w.repositories.some((r) => !/^<.*>$/.test(r));
  const pool = opts.everywhere
    ? history.reflex.workflows
    : local.length > 0
      ? local
      : history.reflex.workflows.filter(strong).slice(0, 2);
  for (const w of pool.slice(0, 4)) {
    const seat = workflowSeat(w, pick);
    if (!w.local) seat.evidence.unshift(`seen in other repositories: ${w.repositories.slice(0, 3).join(", ")}${w.repositories.length > 3 ? ", …" : ""}. Not yet in this one`);
    team.push(seat);
  }

  // Standard roles the repository earns.
  team.push(
    repoSeat("scout", sig, pick, terms, {
      why: "every org starts with a map. Everything else works better against an accurate one",
      autonomy: "observe",
      isolated: false,
    }),
  );
  if (sig.manifest) {
    team.push(
      repoSeat("implementer", sig, pick, terms, {
        why: `${sig.manifest} marks this as a ${sig.languages.join("/") || "code"} project with changes to make`,
        autonomy: "execute",
        isolated: true,
      }),
    );
  }
  if (sig.hasTests || sig.testCommand) {
    team.push(
      repoSeat("tester", sig, pick, terms, {
        why: sig.testCommand ? `there is a test suite (\`${sig.testCommand}\`) worth keeping green` : "there is a test directory worth keeping green",
        autonomy: "execute",
        isolated: true,
      }),
    );
  }
  if (sig.commits >= 10 || sig.hasCi) {
    team.push(
      repoSeat("reviewer", sig, pick, terms, {
        why: sig.hasCi ? "CI is configured, so changes land through a pipeline worth a second pair of eyes" : `${sig.commits} commits: changes land here regularly`,
        autonomy: "observe",
        isolated: false,
      }),
    );
  }
  if (sig.hasDocs && sig.manifest) {
    team.push(
      repoSeat("documenter", sig, pick, terms, {
        why: "there are docs to keep true to the code",
        autonomy: "execute",
        isolated: true,
      }),
    );
  }

  // A seat whose name is already in the org has been hired: it leaves the
  // proposal rather than coming back with a suffix, so hiring one seat and
  // pressing p again shows what is left. Suffixes are only for two seats
  // that collide with each other.
  const remaining = team.filter((seat) => !taken.has(seat.name));
  team.length = 0;
  team.push(...remaining);
  const used = new Set<string>();
  for (const seat of team) {
    let name = seat.name;
    let i = 2;
    while (used.has(name)) name = `${seat.name}-${i++}`;
    seat.name = name;
    used.add(name);
  }

  const summary: string[] = [];
  const r = history.reflex;
  if (r.available) {
    summary.push(`Reflex: ${r.workflows.length} repeated workflow${r.workflows.length === 1 ? "" : "s"}, ${local.length} in this repo, ${r.sessions.length} session${r.sessions.length === 1 ? "" : "s"} here, scanned ${r.scannedAt ? r.scannedAt.slice(0, 10) : "?"}`);
  } else {
    summary.push(r.note ?? "Reflex: not available");
  }
  summary.push(`transcripts: ${history.claude.length} Claude Code, ${history.codex.length} codex session${history.codex.length === 1 ? "" : "s"} in this directory over the last ${opts.days ?? 60} days`);
  summary.push(`repo: ${sig.manifest ?? "no manifest"}${sig.testCommand ? ` · tests: ${sig.testCommand}` : ""}${sig.hasCi ? " · CI" : ""} · ${sig.commits} commits`);
  if (pick) summary.push(`model: ${pick.evidence}`);
  if (terms.length > 0) summary.push(`recent requests about: ${terms.join(", ")}`);

  return { root, team, summary, history };
}

/** The proposal as text, for `ceo suggest`. */
export function renderProposal(p: TeamProposal, width = 78): string[] {
  const out: string[] = [];
  out.push(`Suggested team for ${path.basename(p.root)}`);
  out.push("");
  for (const line of p.summary) out.push(`  ${line}`);
  out.push("");
  for (const s of p.team) {
    out.push(`${s.name.padEnd(28)} ${s.provider} ${s.model} · ${s.autonomy}${s.isolated ? " · isolated" : ""} · $${s.budgetUsd} cap`);
    for (const line of wrapText(s.role.split("\n")[0], width - 4)) out.push(`    ${line}`);
    for (const e of s.evidence) for (const line of wrapText(`· ${e}`, width - 4)) out.push(`    ${line}`);
    if (s.guardrails.length > 0) out.push(`    guardrails: ${s.guardrails.join(" / ")}`);
    out.push("");
  }
  out.push(`Hire all: ceo suggest --hire   ·   edit one first: open the dashboard, press p`);
  return out;
}

function wrapText(s: string, width: number): string[] {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}
