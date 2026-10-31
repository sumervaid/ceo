/**
 * Verification: the checks that decide whether work was done.
 *
 * A task can carry verifiers. A mission can carry checks. Each one is a
 * `VerifierSpec`, run against a working directory: an attempt's worktree,
 * or the project root for a mission. Every result lands in the ledger as a
 * `verify` event, with the status, the score and the evidence behind it.
 * The ledger is then the one place that says what passed.
 *
 *   command   a shell command; exit 0 passes. Offline, free, the common case.
 *   everval   an Everval collection graded against the attempt's output.
 *   judge     agents at observe on other providers read the work and vote.
 *
 * Kinds register an implementation here. `command` lives in this file.
 * `everval` and `judge` live in their own modules and register on import.
 *
 * Three statuses. `pass` and `fail` are verdicts. `error` means the check
 * could not run: a missing binary, a timeout, a verifier with no tests.
 * An error is never read as a pass, and never as a fail of the work.
 */

import { spawn } from "node:child_process";

import { append, readLedger } from "./ledger.js";
import type { LedgerEntry, VerifierSpec, VerifyStatus } from "./types.js";

export type VerifyContext = {
  /** The project root: where `.ceo/` lives. */
  root: string;
  /** Where the check runs: the attempt's worktree, or the root. */
  workdir: string;
  /** The branch or commit the attempt started from, for diffs. */
  base?: string | null;
  taskId?: string | null;
  attemptId?: string | null;
  delegationId?: string | null;
  /** The agent whose work this is. */
  agent?: string | null;
  /** What the task asked for, for judges and Everval submissions. */
  task?: string | null;
  /** The attempt's provider, so judges can be drawn from others. */
  provider?: string | null;
  /** "task" for an attempt, "mission" for the mission's checks. */
  scope?: "task" | "mission";
};

export type VerifyResult = {
  status: VerifyStatus;
  /** 0 to 1, or null when the check gives no score. */
  score: number | null;
  /** One or two lines a person can read. */
  detail: string;
  /** What the verdict rests on: exit codes, an Everval experiment id, the judges' votes. */
  evidence: Record<string, unknown>;
  /** What running the check cost, when it called a model. */
  costUsd?: number;
};

export type VerifierImpl = {
  /** "npm test", "everval: orbit-retry", "2 judges". */
  describe: (spec: VerifierSpec) => string;
  run: (spec: VerifierSpec, ctx: VerifyContext) => Promise<VerifyResult>;
};

const registry = new Map<VerifierSpec["kind"], VerifierImpl>();

/** Add or replace the implementation for a kind. */
export function registerVerifier(kind: VerifierSpec["kind"], impl: VerifierImpl): void {
  registry.set(kind, impl);
}

export function verifierName(spec: VerifierSpec): string {
  if (spec.name) return spec.name;
  return registry.get(spec.kind)?.describe(spec) ?? spec.kind;
}

/** Run one check. Never throws: a check that cannot run is an `error`. */
export async function runVerifier(spec: VerifierSpec, ctx: VerifyContext): Promise<VerifyResult> {
  const impl = registry.get(spec.kind);
  if (!impl) return { status: "error", score: null, detail: `No verifier for kind "${spec.kind}" is installed.`, evidence: {} };
  try {
    return await impl.run(spec, ctx);
  } catch (e) {
    return { status: "error", score: null, detail: e instanceof Error ? e.message : String(e), evidence: {} };
  }
}

/** Write one result to the ledger. */
export function recordVerify(spec: VerifierSpec, ctx: VerifyContext, result: VerifyResult): LedgerEntry {
  return append(
    "verify",
    ctx.agent ?? null,
    {
      scope: ctx.scope ?? "task",
      taskId: ctx.taskId ?? null,
      attemptId: ctx.attemptId ?? null,
      delegationId: ctx.delegationId ?? null,
      verifier: { kind: spec.kind, name: verifierName(spec), required: spec.required !== false, weight: spec.weight ?? 1 },
      status: result.status,
      score: result.score,
      detail: result.detail.slice(0, 600),
      evidence: result.evidence,
      ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    },
    ctx.root,
  );
}

export type Verdict = {
  /** Every required check passed, and none errored. */
  pass: boolean;
  /** At least one required check could not run. */
  errored: boolean;
  /** The weighted mean of the scores, a pass counting 1 and a fail 0 when a check gives none. */
  score: number;
  results: Array<{ spec: VerifierSpec; result: VerifyResult }>;
};

/** Combine results into one verdict. */
export function combine(results: Array<{ spec: VerifierSpec; result: VerifyResult }>): Verdict {
  let weight = 0;
  let total = 0;
  let pass = true;
  let errored = false;
  for (const { spec, result } of results) {
    const required = spec.required !== false;
    if (required && result.status !== "pass") pass = false;
    if (required && result.status === "error") errored = true;
    if (result.status === "error") continue;
    const w = spec.weight ?? 1;
    weight += w;
    total += w * (result.score ?? (result.status === "pass" ? 1 : 0));
  }
  return { pass: results.length > 0 && pass, errored, score: weight > 0 ? total / weight : 0, results };
}

/**
 * Run every check in order, record each, and combine. Deterministic checks
 * run first, judges last: a judge is a model call, and a failed test makes
 * the vote moot.
 */
export async function verifyAll(specs: VerifierSpec[], ctx: VerifyContext, opts: { record?: boolean } = {}): Promise<Verdict> {
  const order = [...specs].sort((a, b) => Number(a.kind === "judge") - Number(b.kind === "judge"));
  const results: Array<{ spec: VerifierSpec; result: VerifyResult }> = [];
  for (const spec of order) {
    const deterministicFailed = results.some((r) => r.spec.kind !== "judge" && r.spec.required !== false && r.result.status === "fail");
    if (spec.kind === "judge" && deterministicFailed) {
      const skipped: VerifyResult = { status: "fail", score: 0, detail: "Not judged: a required check already failed.", evidence: { skipped: true } };
      results.push({ spec, result: skipped });
      if (opts.record !== false) recordVerify(spec, ctx, skipped);
      continue;
    }
    const result = await runVerifier(spec, ctx);
    results.push({ spec, result });
    if (opts.record !== false) recordVerify(spec, ctx, result);
  }
  return combine(results);
}

/** Every verify event for a task, oldest first. */
export function verifyEvents(cwd: string, filter: { taskId?: string; attemptId?: string; scope?: "task" | "mission" } = {}): LedgerEntry[] {
  return readLedger(cwd).filter(
    (e) =>
      e.type === "verify" &&
      (filter.taskId === undefined || e.data.taskId === filter.taskId) &&
      (filter.attemptId === undefined || e.data.attemptId === filter.attemptId) &&
      (filter.scope === undefined || e.data.scope === filter.scope),
  );
}

// -- command ----------------------------------------------------------------

const COMMAND_TIMEOUT_SEC = 600;

/** Run a shell command in a directory. Resolves with the exit code and the tail of the output. */
export function runCommand(cmd: string, cwd: string, timeoutSec: number, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; output: string; timedOut: boolean; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let timedOut = false;
    let child;
    try {
      child = spawn("sh", ["-c", cmd], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, output: e instanceof Error ? e.message : String(e), timedOut: false, ms: 0 });
      return;
    }
    const keep = (c: Buffer) => {
      output += c.toString();
      if (output.length > 20000) output = output.slice(-20000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSec * 1000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, output: e.message, timedOut, ms: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut, ms: Date.now() - started });
    });
  });
}

function tail(text: string, lines: number): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

registerVerifier("command", {
  describe: (spec) => (spec.kind === "command" ? spec.run : "command"),
  run: async (spec, ctx) => {
    if (spec.kind !== "command") throw new Error("not a command check");
    const r = await runCommand(spec.run, ctx.workdir, spec.timeoutSec ?? COMMAND_TIMEOUT_SEC);
    const evidence = { exitCode: r.code, ms: r.ms, timedOut: r.timedOut, output: tail(r.output, 30) };
    if (r.timedOut) return { status: "error", score: null, detail: `${spec.run} ran past ${spec.timeoutSec ?? COMMAND_TIMEOUT_SEC}s.`, evidence };
    if (r.code === null) return { status: "error", score: null, detail: `${spec.run} could not start: ${tail(r.output, 1)}`, evidence };
    if (r.code === 0) return { status: "pass", score: 1, detail: `${spec.run} passed in ${(r.ms / 1000).toFixed(1)}s.`, evidence };
    return { status: "fail", score: 0, detail: `${spec.run} exited ${r.code}: ${tail(r.output, 2).replace(/\s+/g, " ").slice(0, 200)}`, evidence };
  },
});

/** Parse "npm test", "everval:spec.json" or "judge:the fix is minimal" into a spec. */
export function parseVerifier(text: string): VerifierSpec {
  const t = text.trim();
  const m = /^(everval|judge|command):\s*(.+)$/i.exec(t);
  if (!m) return { kind: "command", run: t };
  const kind = m[1].toLowerCase();
  if (kind === "everval") {
    const [collection, scenario] = m[2].split("#");
    return { kind: "everval", collection: collection.trim(), ...(scenario ? { scenario: scenario.trim() } : {}) };
  }
  if (kind === "judge") return { kind: "judge", rubric: m[2].trim() };
  return { kind: "command", run: m[2].trim() };
}
