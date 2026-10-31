/**
 * The `everval` verifier: an Everval collection graded against an attempt.
 *
 * Everval has no command that scores a directory. One check is a short
 * recipe. Import the collection once and cache its id by the spec file's
 * hash. Fetch the collection hash. Write a submission bundle holding the
 * attempt's output. Run `everval import-results`, which grades in place and
 * prints the experiment as JSON. A low score still exits 0, so the JSON
 * decides the verdict, never the exit code.
 *
 * The output the scenario is graded on is one of two things. With
 * `spec.output`, a command run in the working directory prints it as JSON.
 * Without, the output is the attempt's changed files as {path: content}.
 *
 * Everval's workspace is `<root>/.ceo/everval`, set through EVERVAL_DATA_DIR,
 * so runs here never mix with the person's own experiments.
 *
 * A trial that errored, or an experiment that failed, is an `error`: the
 * check could not run. Only a graded trial that did not pass is a `fail`.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { ceoDir } from "./paths.js";
import type { VerifierSpec } from "./types.js";
import { registerVerifier, runCommand, type VerifyContext, type VerifyResult } from "./verify.js";

type EvervalSpec = Extract<VerifierSpec, { kind: "everval" }>;

const FILE_LIMIT_BYTES = 200 * 1024;
const FILE_LIMIT_COUNT = 200;
const QUICK_TIMEOUT_SEC = 120;
const GRADE_TIMEOUT_SEC = 900;
const OUTPUT_TIMEOUT_SEC = 300;

export function evervalBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.CEO_EVERVAL_BIN?.trim() || "everval";
}

export type EvervalStatus = {
  installed: boolean;
  version: string | null;
  bin: string;
  /** What to do next, when the binary is missing. */
  fix: string | null;
};

/** Whether Everval is installed here, and which version. `--version` does not load the app. */
export function evervalStatus(): EvervalStatus {
  const bin = evervalBin();
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
    return { installed: true, version: out.trim().split("\n")[0] || null, bin, fix: null };
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    return { installed: false, version: null, bin, fix: missing ? "Install Everval: npm install -g everval" : "Run `everval --version` to see why it fails." };
  }
}

// -- running the binary -------------------------------------------------------

type Exec = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

function evervalEnv(root: string): NodeJS.ProcessEnv {
  const dir = path.join(ceoDir(root), "everval");
  mkdirSync(dir, { recursive: true });
  return { ...process.env, EVERVAL_DATA_DIR: dir, NO_COLOR: "1" };
}

function exec(args: string[], root: string, cwd: string, timeoutSec: number): Promise<Exec> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(evervalBin(), args, { cwd, env: evervalEnv(root), stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: e instanceof Error ? e.message : String(e), timedOut: false });
      return;
    }
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSec * 1000);
    child.on("error", (e) => {
      clearTimeout(timer);
      const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
      resolve({ code: null, stdout, stderr: missing ? `${evervalBin()} is not installed.` : e.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** The first JSON object in a text, since a CLI may print a line before it. */
function parseJson(text: string): Record<string, unknown> | null {
  const t = text.trim();
  for (const candidate of [t, t.slice(Math.max(0, t.indexOf("{")))]) {
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function lastLine(text: string): string {
  return text.trim().split("\n").slice(-1)[0]?.slice(0, 200) ?? "";
}

// -- the collection id cache --------------------------------------------------

type Cache = { collections: Record<string, { id: string; file: string; at: number }> };

function cachePath(root: string): string {
  return path.join(ceoDir(root), "everval.json");
}

function readCache(root: string): Cache {
  try {
    const raw = JSON.parse(readFileSync(cachePath(root), "utf8")) as Cache;
    if (raw && typeof raw.collections === "object") return raw;
  } catch {
    // no cache yet
  }
  return { collections: {} };
}

function writeCache(root: string, cache: Cache): void {
  mkdirSync(ceoDir(root), { recursive: true });
  writeFileSync(cachePath(root), `${JSON.stringify(cache, null, 2)}\n`);
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Scenario ids found in any of the given objects, under `scenarios` or `tasks`. */
function scenarioIds(...docs: Array<Record<string, unknown> | null>): string[] {
  for (const doc of docs) {
    if (!doc) continue;
    for (const key of ["scenarios", "tasks"]) {
      const list = doc[key];
      if (!Array.isArray(list)) continue;
      const ids = list
        .map((s) => (s && typeof s === "object" ? ((s as Record<string, unknown>).scenario_id ?? (s as Record<string, unknown>).id) : null))
        .filter((id): id is string => typeof id === "string");
      if (ids.length > 0) return ids;
    }
  }
  return [];
}

type Collection = { id: string; hash: string; scenarios: string[]; imported: boolean };

async function resolveCollection(spec: EvervalSpec, ctx: VerifyContext): Promise<Collection | string> {
  const file = path.resolve(ctx.root, spec.collection);
  if (!existsSync(file)) return `The collection file ${spec.collection} does not exist.`;
  const bytes = readFileSync(file);
  const key = sha256(bytes);
  let fileDoc: Record<string, unknown> | null = null;
  try {
    fileDoc = parseJson(bytes.toString("utf8"));
  } catch {
    fileDoc = null;
  }

  for (const attempt of [0, 1]) {
    const cache = readCache(ctx.root);
    let id = attempt === 0 ? cache.collections[key]?.id : undefined;
    let importDoc: Record<string, unknown> | null = null;
    let imported = false;
    if (!id) {
      const r = await exec(["collections", "import", file], ctx.root, ctx.root, QUICK_TIMEOUT_SEC);
      if (r.code !== 0) return `everval collections import failed: ${lastLine(r.stderr || r.stdout)}`;
      importDoc = parseJson(r.stdout);
      id = typeof importDoc?.id === "string" ? importDoc.id : undefined;
      if (!id) return "everval collections import printed no collection id.";
      cache.collections[key] = { id, file: spec.collection, at: Date.now() };
      writeCache(ctx.root, cache);
      imported = true;
    }

    const dir = mkdtempSync(path.join(tmpdir(), "ceo-everval-"));
    try {
      const out = path.join(dir, "tasks.json");
      const r = await exec(["collections", "tasks", id, "--output", out], ctx.root, ctx.root, QUICK_TIMEOUT_SEC);
      const doc = r.code === 0 && existsSync(out) ? parseJson(readFileSync(out, "utf8")) : null;
      const hash = typeof doc?.collection_hash === "string" ? doc.collection_hash : null;
      if (!hash) {
        // A cached id can outlive Everval's workspace. Import once more before giving up.
        if (attempt === 0 && !imported) continue;
        return `everval collections tasks failed for ${id}: ${lastLine(r.stderr || r.stdout) || "no collection_hash in the output."}`;
      }
      return { id, hash, scenarios: scenarioIds(doc, importDoc, fileDoc), imported };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return "everval collections tasks failed.";
}

// -- the output a scenario is graded on ---------------------------------------

function gitOut(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

/** The attempt's changed files against its base, read as {path: content}. */
export function changedFiles(workdir: string, base?: string | null): { files: Record<string, string>; skipped: string[] } {
  const names = new Set<string>();
  for (const n of gitOut(["diff", "--name-only", "--relative", base || "HEAD"], workdir).split("\n")) if (n) names.add(n);
  for (const n of gitOut(["ls-files", "--others", "--exclude-standard"], workdir).split("\n")) if (n) names.add(n);
  const files: Record<string, string> = {};
  const skipped: string[] = [];
  for (const name of [...names].sort()) {
    if (name.startsWith(".ceo/")) continue;
    const abs = path.join(workdir, name);
    let size = 0;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    if (size > FILE_LIMIT_BYTES || Object.keys(files).length >= FILE_LIMIT_COUNT) {
      skipped.push(name);
      continue;
    }
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) {
      skipped.push(name);
      continue;
    }
    files[name] = buf.toString("utf8");
  }
  return { files, skipped };
}

async function gatherOutput(spec: EvervalSpec, ctx: VerifyContext): Promise<{ output: Record<string, unknown>; skipped: string[] } | string> {
  if (spec.output) {
    const r = await runCommand(spec.output, ctx.workdir, OUTPUT_TIMEOUT_SEC);
    if (r.timedOut) return `The output command ran past ${OUTPUT_TIMEOUT_SEC}s.`;
    if (r.code !== 0) return `The output command exited ${r.code}: ${lastLine(r.output)}`;
    const doc = parseJson(r.output);
    if (!doc) return "The output command did not print a JSON object.";
    return { output: doc, skipped: [] };
  }
  try {
    const { files, skipped } = changedFiles(ctx.workdir, ctx.base);
    return { output: files, skipped };
  } catch (e) {
    return `Could not read the changed files: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
  }
}

// -- the verifier -------------------------------------------------------------

type Trial = {
  status?: string;
  score?: number | null;
  passed?: boolean;
  error?: string | null;
  scenario_id?: string;
  checks?: Array<{ name?: string; passed?: boolean; message?: string | null }>;
};

const fail = (detail: string, evidence: Record<string, unknown> = {}): VerifyResult => ({ status: "error", score: null, detail, evidence });

registerVerifier("everval", {
  describe: (spec) => (spec.kind === "everval" ? `everval: ${path.basename(spec.collection)}${spec.scenario ? `#${spec.scenario}` : ""}` : "everval"),
  run: async (spec, ctx) => {
    if (spec.kind !== "everval") throw new Error("not an everval check");
    const status = evervalStatus();
    if (!status.installed) return fail(`${status.bin} is not installed. ${status.fix ?? ""}`.trim(), { bin: status.bin });

    const collection = await resolveCollection(spec, ctx);
    if (typeof collection === "string") return fail(collection);

    let scenario = spec.scenario;
    if (!scenario) {
      if (collection.scenarios.length === 1) scenario = collection.scenarios[0];
      else if (collection.scenarios.length === 0) return fail(`Could not tell which scenario of ${spec.collection} to grade. Name one: everval:${spec.collection}#<scenario>.`);
      else return fail(`${spec.collection} has ${collection.scenarios.length} scenarios: ${collection.scenarios.join(", ")}. Name one: everval:${spec.collection}#<scenario>.`);
    }

    const gathered = await gatherOutput(spec, ctx);
    if (typeof gathered === "string") return fail(gathered, { collectionId: collection.id, collectionHash: collection.hash });

    const bundle = {
      name: ctx.attemptId ? `ceo ${ctx.attemptId}` : `ceo ${new Date().toISOString()}`,
      system_name: [ctx.agent, ctx.provider].filter(Boolean).join(" on ") || "ceo",
      collection_id: collection.id,
      collection_hash: collection.hash,
      provenance: { ceo_task: ctx.taskId ?? ctx.task ?? "none", ceo_attempt: ctx.attemptId ?? "none" },
      submissions: {
        [scenario]: { output: gathered.output, cost_usd: null, input_tokens: null, output_tokens: null, duration_ms: null, trace: [], provenance: {} },
      },
    };
    const dir = mkdtempSync(path.join(tmpdir(), "ceo-everval-"));
    let run: Exec;
    try {
      const file = path.join(dir, "bundle.json");
      writeFileSync(file, JSON.stringify(bundle));
      run = await exec(["import-results", file], ctx.root, ctx.root, GRADE_TIMEOUT_SEC);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const base = { collectionId: collection.id, collectionHash: collection.hash, scenario };
    if (run.timedOut) return fail(`everval import-results ran past ${GRADE_TIMEOUT_SEC}s.`, base);
    const exp = parseJson(run.stdout);
    if (!exp) return fail(`everval import-results printed no experiment: ${lastLine(run.stderr || run.stdout)}`, base);

    const evidence: Record<string, unknown> = {
      ...base,
      experimentId: exp.id ?? null,
      snapshotHash: exp.snapshot_hash ?? null,
      experimentStatus: exp.status ?? null,
      ...(gathered.skipped.length > 0 ? { skippedFiles: gathered.skipped.slice(0, 20) } : {}),
    };
    const trials = Array.isArray(exp.trials) ? (exp.trials as Trial[]) : [];
    const trial = trials.find((t) => t.scenario_id === scenario) ?? trials[0];
    if (exp.status === "failed") return fail(`Everval experiment ${String(exp.id ?? "unknown")} failed.`, evidence);
    if (!trial) return fail("Everval returned no trial for the scenario.", evidence);
    if (trial.status === "error") return fail(`Everval could not grade ${scenario}: ${trial.error ?? "the trial errored."}`, evidence);

    const score = typeof trial.score === "number" ? trial.score : null;
    const failing = (trial.checks ?? []).filter((c) => c.passed === false).map((c) => ({ name: c.name ?? "check", message: c.message ?? "" }));
    evidence.failingChecks = failing.slice(0, 10);
    if (trial.passed) return { status: "pass", score: score ?? 1, detail: `Everval graded ${scenario}: passed${score !== null ? ` at ${score.toFixed(2)}` : ""}.`, evidence };
    const why = failing
      .slice(0, 3)
      .map((c) => (c.message ? `${c.name}: ${c.message}` : c.name))
      .join("; ");
    return { status: "fail", score: score ?? 0, detail: `Everval graded ${scenario}: ${score !== null ? score.toFixed(2) : "no score"}.${why ? ` Failed ${why}.` : ""}`, evidence };
  },
});
