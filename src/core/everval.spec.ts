/**
 * The everval verifier and the mission's checks. Everval is the stub; every
 * other check is a shell command.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { missionCheckCmd, verifyCmd } from "../cli/verify.js";
import { changedFiles, evervalStatus } from "./everval.js";
import { initLedger, readLedger } from "./ledger.js";
import { addCheck, checkMission, missionStatus, setMission } from "./mission.js";
import { parseVerifier, runVerifier, type VerifyContext } from "./verifiers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.resolve(HERE, "..", "..", "tools", "stub-everval");
process.env.CEO_EVERVAL_BIN = STUB;
process.env.CEO_REQUIRE_STUBS = "1";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function repo(): { dir: string; base: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "ceo-everval-spec-"));
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV });
  g("init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "# test\n");
  writeFileSync(path.join(dir, ".gitignore"), ".ceo/\n");
  mkdirSync(path.join(dir, "evals"));
  writeFileSync(
    path.join(dir, "evals", "fix.json"),
    JSON.stringify({
      schema_version: 1,
      id: "fix-col",
      name: "Fix",
      domain: "coding",
      scenarios: [{ id: "retry", name: "Retry", domain: "coding", instruction: "Fix it.", inputs: {}, expected: {}, checks: [{ id: "t", name: "tests", kind: "repository_tests", path: "", expected: null, weight: 1, required: true, tolerance: 0 }] }],
    }),
  );
  writeFileSync(
    path.join(dir, "evals", "answer.json"),
    JSON.stringify({
      schema_version: 1,
      id: "answer-col",
      name: "Answer",
      domain: "documents",
      scenarios: [
        { id: "has-fixed", name: "Has FIXED", domain: "documents", instruction: "Answer.", inputs: {}, expected: {}, checks: [{ id: "c", name: "mentions the fix", kind: "contains", path: "answer", expected: "FIXED", weight: 1, required: true, tolerance: 0 }] },
        { id: "has-nope", name: "Has NOPE", domain: "documents", instruction: "Answer.", inputs: {}, expected: {}, checks: [{ id: "c", name: "mentions nope", kind: "contains", path: "answer", expected: "NOPE", weight: 1, required: true, tolerance: 0 }] },
      ],
    }),
  );
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  initLedger(dir);
  return { dir, base: g("rev-parse", "HEAD").trim() };
}

function ctxFor(dir: string, base: string, extra: Partial<VerifyContext> = {}): VerifyContext {
  return { root: dir, workdir: dir, base, taskId: "T1", attemptId: "A1", agent: "fixer", provider: "claude", ...extra };
}

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("everval status reads the version, and a missing binary is not installed", async () => {
  const s = evervalStatus();
  assert.equal(s.installed, true);
  assert.match(s.version ?? "", /^\d+\.\d+\.\d+$/);
  await withEnv({ CEO_EVERVAL_BIN: "/nonexistent/everval" }, async () => {
    const m = evervalStatus();
    assert.equal(m.installed, false);
    assert.match(m.fix ?? "", /Install Everval/);
  });
});

test("an everval check passes, fails or errors on the attempt's changed files", async () => {
  const { dir, base } = repo();
  try {
    const spec = { kind: "everval" as const, collection: "evals/fix.json" };
    // Nothing changed: the scenario is graded and fails.
    const none = await runVerifier(spec, ctxFor(dir, base));
    assert.equal(none.status, "fail", none.detail);
    assert.equal(none.score, 0);
    assert.match(none.detail, /retry/);
    assert.equal((none.evidence.failingChecks as Array<{ name: string }>)[0].name, "tests");

    // A changed file with the fix: pass, with the evidence of the experiment.
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "retry.js"), "// FIXED\n");
    const pass = await runVerifier(spec, ctxFor(dir, base));
    assert.equal(pass.status, "pass", pass.detail);
    assert.equal(pass.score, 1);
    assert.match(String(pass.evidence.experimentId), /^exp-/);
    assert.ok(pass.evidence.snapshotHash);
    assert.equal(pass.evidence.collectionId, "fix-col");
    assert.match(String(pass.evidence.collectionHash), /^[0-9a-f]{64}$/);

    // The grader errored: the check could not run, which is never a fail.
    const errored = await withEnv({ STUB_EVERVAL_ERROR: "1" }, () => runVerifier(spec, ctxFor(dir, base)));
    assert.equal(errored.status, "error");
    assert.match(errored.detail, /stub: the grader failed/);

    // No binary: an error too.
    const missing = await withEnv({ CEO_EVERVAL_BIN: "/nonexistent/everval" }, () => runVerifier(spec, ctxFor(dir, base)));
    assert.equal(missing.status, "error");
    assert.match(missing.detail, /not installed/);

    // A collection file that is not there.
    const nofile = await runVerifier({ kind: "everval", collection: "evals/none.json" }, ctxFor(dir, base));
    assert.equal(nofile.status, "error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an output command supplies the graded object, and the scenario must be named when several exist", async () => {
  const { dir, base } = repo();
  try {
    const out = `echo '{"answer":"the FIXED value"}'`;
    const ambiguous = await runVerifier({ kind: "everval", collection: "evals/answer.json", output: out }, ctxFor(dir, base));
    assert.equal(ambiguous.status, "error");
    assert.match(ambiguous.detail, /has-fixed, has-nope/);

    const pass = await runVerifier({ kind: "everval", collection: "evals/answer.json", scenario: "has-fixed", output: out }, ctxFor(dir, base));
    assert.equal(pass.status, "pass", pass.detail);
    const fail = await runVerifier({ kind: "everval", collection: "evals/answer.json", scenario: "has-nope", output: out }, ctxFor(dir, base));
    assert.equal(fail.status, "fail");
    assert.match(fail.detail, /contains failed at answer/);

    const notJson = await runVerifier({ kind: "everval", collection: "evals/answer.json", scenario: "has-fixed", output: "echo nope" }, ctxFor(dir, base));
    assert.equal(notJson.status, "error");
    const exits = await runVerifier({ kind: "everval", collection: "evals/answer.json", scenario: "has-fixed", output: "exit 3" }, ctxFor(dir, base));
    assert.equal(exits.status, "error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the collection id is cached by the spec file's hash, and Everval runs in the project's own data dir", async () => {
  const { dir, base } = repo();
  const log = path.join(dir, "calls.log");
  try {
    const spec = { kind: "everval" as const, collection: "evals/fix.json" };
    writeFileSync(path.join(dir, "a.txt"), "FIXED\n");
    await withEnv({ STUB_EVERVAL_LOG: log }, async () => {
      assert.equal((await runVerifier(spec, ctxFor(dir, base))).status, "pass");
      assert.equal((await runVerifier(spec, ctxFor(dir, base))).status, "pass");
      const imports = () => readFileSync(log, "utf8").split("\n").filter((l) => l === "collections import").length;
      assert.equal(imports(), 1, "the second check skips the import");
      assert.equal(readFileSync(log, "utf8").split("\n").filter((l) => l === "import-results").length, 2);
      const cache = JSON.parse(readFileSync(path.join(dir, ".ceo", "everval.json"), "utf8")) as { collections: Record<string, { id: string }> };
      assert.deepEqual(Object.values(cache.collections).map((c) => c.id), ["fix-col"]);
      assert.equal(existsSync(path.join(dir, ".ceo", "everval", "stub-collections", "fix-col.json")), true);

      // A changed spec file is a new collection hash, so it imports again.
      const file = path.join(dir, "evals", "fix.json");
      writeFileSync(file, readFileSync(file, "utf8").replace('"name":"Fix"', '"name":"Fix two"'));
      assert.equal((await runVerifier(spec, ctxFor(dir, base))).status, "pass");
      assert.equal(imports(), 2);

      // A cached id that Everval no longer knows is imported again, once.
      rmSync(path.join(dir, ".ceo", "everval"), { recursive: true, force: true });
      assert.equal((await runVerifier(spec, ctxFor(dir, base))).status, "pass");
      assert.equal(imports(), 3);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("changed files skip binaries, large files and CEO's own state", () => {
  const { dir, base } = repo();
  try {
    writeFileSync(path.join(dir, "README.md"), "# changed\n");
    writeFileSync(path.join(dir, "new.txt"), "new\n");
    writeFileSync(path.join(dir, "blob.bin"), Buffer.from([1, 0, 2, 0]));
    writeFileSync(path.join(dir, "big.txt"), "x".repeat(210 * 1024));
    const { files, skipped } = changedFiles(dir, base);
    assert.deepEqual(Object.keys(files).sort(), ["README.md", "new.txt"]);
    assert.deepEqual(skipped.sort(), ["big.txt", "blob.bin"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mission checks are set, run and read back as a status per check", async () => {
  const { dir } = repo();
  try {
    assert.throws(() => addCheck({ kind: "command", run: "true" }, dir), /No mission set/);
    setMission({ objective: "Ship the retry fix without flakes", successCriteria: ["tests pass"] }, dir);
    addCheck({ kind: "command", run: "test -f README.md" }, dir);
    addCheck({ kind: "command", run: "test -f MISSING" }, dir);
    addCheck({ kind: "command", run: "test -f MISSING" }, dir);
    // The checks carry through a later edit of the objective.
    const m = setMission({ objective: "Ship the retry fix with no flakes at all" }, dir);
    assert.equal(m.checks?.length, 2);
    assert.deepEqual(missionStatus(dir).map((c) => c.state), ["unknown", "unknown"]);

    const verdict = await checkMission(dir);
    assert.equal(verdict.pass, false);
    assert.equal(verdict.errored, false);
    assert.deepEqual(missionStatus(dir).map((c) => c.state), ["pass", "fail"]);
    const verifies = readLedger(dir).filter((e) => e.type === "verify");
    assert.equal(verifies.length, 2);
    assert.ok(verifies.every((e) => e.data.scope === "mission"));

    writeFileSync(path.join(dir, "MISSING"), "now here\n");
    const met = await checkMission(dir);
    assert.equal(met.pass, true);
    assert.deepEqual(missionStatus(dir).map((c) => c.state), ["pass", "pass"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function capture(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((s: string) => ((stdout += s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => ((stderr += s), true)) as typeof process.stderr.write;
  process.exitCode = undefined;
  try {
    await fn();
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { stdout, stderr, exitCode };
}

test("ceo verify runs one check and records a task-scope event with no task", async () => {
  const { dir } = repo();
  try {
    assert.deepEqual(parseVerifier("everval:evals/fix.json#retry"), { kind: "everval", collection: "evals/fix.json", scenario: "retry" });
    const ok = await capture(() => verifyCmd(["test", "-f", "README.md"], dir));
    assert.match(ok.stdout, /✓ test -f README\.md {2}pass/);
    assert.equal(ok.exitCode, 0);
    const bad = await capture(() => verifyCmd(["test -f MISSING", "--in", dir], dir));
    assert.match(bad.stdout, /✗ /);
    assert.equal(bad.exitCode, 1);
    const usage = await capture(() => verifyCmd([], dir));
    assert.match(usage.stderr, /Usage/);

    const verifies = readLedger(dir).filter((e) => e.type === "verify");
    assert.equal(verifies.length, 2);
    assert.ok(verifies.every((e) => e.data.scope === "task" && e.data.taskId === null));

    writeFileSync(path.join(dir, "a.txt"), "FIXED\n");
    const ev = await capture(() => verifyCmd(["everval:evals/fix.json#retry"], dir));
    assert.match(ev.stdout, /✓ everval: fix\.json#retry {2}pass/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ceo mission checks lists, adds and runs", async () => {
  const { dir } = repo();
  try {
    const none = await capture(() => missionCheckCmd(["checks"], dir));
    assert.match(none.stdout, /No checks/);
    setMission({ objective: "Ship the retry fix without flakes" }, dir);
    const noChecks = await capture(() => missionCheckCmd(["check"], dir));
    assert.equal(noChecks.exitCode, 1);
    await capture(() => missionCheckCmd(["checks", "add", "test -f README.md"], dir));
    await capture(() => missionCheckCmd(["checks", "add", "test -f MISSING"], dir));
    const list = await capture(() => missionCheckCmd(["checks"], dir));
    assert.match(list.stdout, /· test -f README\.md {2}unknown/);
    const run = await capture(() => missionCheckCmd(["check"], dir));
    assert.match(run.stdout, /✓ test -f README\.md/);
    assert.match(run.stdout, /✗ test -f MISSING/);
    assert.match(run.stdout, /Mission not met\./);
    assert.equal(run.exitCode, 1);
    writeFileSync(path.join(dir, "MISSING"), "x\n");
    const met = await capture(() => missionCheckCmd(["check"], dir));
    assert.match(met.stdout, /Mission met\./);
    assert.equal(met.exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
