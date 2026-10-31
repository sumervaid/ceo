/**
 * Attempts and verification: several tries at one task, a winner kept on
 * the evidence. Every run is a stub; every check is a shell command.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { attemptName, attemptsFor, promoteHooks, runTask, usesAttempts } from "./attempts.js";
import { worktreePathFor } from "./git.js";
import { initLedger, readLedger, verify } from "./ledger.js";
import { hire } from "./roster.js";
import { armKey } from "./types.js";
import { chooseArms, taskKind } from "./router.js";
import { addTask, findTask, updateTask } from "./tasks.js";
import { combine, parseVerifier, registerVerifier, verifyAll } from "./verify.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.resolve(HERE, "..", "..", "tools");
process.env.CEO_CLAUDE_BIN = path.join(TOOLS, "stub-claude");
process.env.CEO_CODEX_BIN = path.join(TOOLS, "stub-codex");
process.env.CEO_GEMINI_BIN = path.join(TOOLS, "stub-gemini");
process.env.CLAUDE_CODE_OAUTH_TOKEN = "stub-token";
process.env.STUB_CODEX_LOGIN = "chatgpt";
process.env.STUB_GEMINI_LOGIN = "ok";
process.env.STUB_DELAY_MS = "10";
process.env.STUB_TURNS = "1";
process.env.CEO_REQUIRE_STUBS = "1";
process.env.CEO_NO_COLLAB = "1";

/** A seeded random source, so the router's draws repeat. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ceo-attempts-"));
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "# test\n");
  writeFileSync(path.join(dir, ".gitignore"), ".ceo/\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  initLedger(dir);
  hire({ name: "fixer", role: "Fix what the queue asks for, with the smallest change.", provider: "claude", budgetUsd: 5, autonomy: "execute" }, dir);
  return dir;
}

test("a task with verifiers runs one attempt per arm, verifies each, and promotes the passing one with a dissent", async () => {
  const dir = repo();
  try {
    const task = addTask({ title: "Fix the flaky retry test", assignee: "fixer", samples: 3, arms: [{ provider: "claude", model: "claude-sonnet-5" }, { provider: "codex", model: "gpt-5" }, { provider: "gemini", model: "gemini-3-pro" }], verifiers: [{ kind: "command", run: "test -f WIN" }] }, dir);
    assert.equal(usesAttempts(task), true);
    const run = runTask(task.id, {
      cwd: dir,
      // The codex attempt is the one that does the work.
      onStart: (a) => {
        if (a.arm.provider === "codex") writeFileSync(path.join(a.workdir, "WIN"), "fixed\n");
      },
    });
    assert.equal(run.attempts.length, 3);
    const out = await run.finished;
    assert.equal(out.status, "done", out.note);
    assert.equal(out.winner?.arm.provider, "codex");
    assert.match(findTask(task.id, dir)!.note ?? "", /won by codex/);

    const attempts = attemptsFor(task.id, dir);
    assert.equal(attempts.length, 3);
    assert.deepEqual(new Set(attempts.map((a) => a.arm.provider)), new Set(["claude", "codex", "gemini"]));
    assert.equal(attempts.filter((a) => a.verdict?.pass).length, 1);

    const entries = readLedger(dir);
    const promote = entries.find((e) => e.type === "promote")!;
    assert.equal(promote.data.attemptId, out.winner!.id);
    assert.ok(promote.data.dissent, "a dissent is kept");
    assert.equal(entries.filter((e) => e.type === "verify").length, 3);
    // The winner's and the dissent's worktrees stay; the third is removed.
    const dissentId = (promote.data.dissent as { attemptId: string }).attemptId;
    const loser = attempts.find((a) => a.id !== out.winner!.id && a.id !== dissentId)!;
    assert.equal(existsSync(worktreePathFor(attemptName("fixer", out.winner!.id), dir)), true);
    assert.equal(existsSync(worktreePathFor(attemptName("fixer", loser.id), dir)), false);
    // The winner's work is committed on its branch.
    const log = execFileSync("git", ["log", "--oneline", `ceo/${attemptName("fixer", out.winner!.id)}`], { cwd: dir, encoding: "utf8" });
    assert.match(log, /Fix the flaky retry test/);
    assert.equal(verify(dir).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a task where no attempt passes fails with every verdict in the ledger, and promote hooks never run", async () => {
  const dir = repo();
  let hooked = 0;
  const hook = () => {
    hooked++;
  };
  promoteHooks.push(hook);
  try {
    const task = addTask({ title: "Make the build green", assignee: "fixer", samples: 2, verifiers: [{ kind: "command", run: "exit 3" }] }, dir);
    const out = await runTask(task.id, { cwd: dir }).finished;
    assert.equal(out.status, "failed");
    assert.match(out.note, /No attempt passed/);
    assert.equal(findTask(task.id, dir)!.status, "failed");
    assert.equal(readLedger(dir).filter((e) => e.type === "verify" && e.data.status === "fail").length, 2);
    assert.equal(readLedger(dir).some((e) => e.type === "promote"), false);
    assert.equal(hooked, 0);
  } finally {
    promoteHooks.splice(promoteHooks.indexOf(hook), 1);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("judges run after deterministic checks and are skipped when a required check already failed", async () => {
  let judged = 0;
  registerVerifier("judge", { describe: () => "judge", run: async () => (judged++, { status: "pass", score: 1, detail: "agreed", evidence: {} }) });
  const dir = repo();
  try {
    const failing = await verifyAll([{ kind: "judge", rubric: "minimal" }, { kind: "command", run: "false" }], { root: dir, workdir: dir }, { record: false });
    assert.equal(failing.pass, false);
    assert.equal(judged, 0);
    const passing = await verifyAll([{ kind: "judge", rubric: "minimal" }, { kind: "command", run: "true" }], { root: dir, workdir: dir }, { record: false });
    assert.equal(passing.pass, true);
    assert.equal(judged, 1);
    const errored = combine([{ spec: { kind: "command", run: "x" }, result: { status: "error", score: null, detail: "", evidence: {} } }]);
    assert.equal(errored.pass, false);
    assert.equal(errored.errored, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifiers parse from short text, tasks get a kind, and named arms are honoured", () => {
  assert.deepEqual(parseVerifier("npm test"), { kind: "command", run: "npm test" });
  assert.deepEqual(parseVerifier("everval: evals/retry.json#flaky"), { kind: "everval", collection: "evals/retry.json", scenario: "flaky" });
  assert.deepEqual(parseVerifier("judge: the change is minimal"), { kind: "judge", rubric: "the change is minimal" });
  assert.equal(taskKind("Review the retry diff"), "review");
  assert.equal(taskKind("Fix the crash on startup"), "debug");
  assert.equal(taskKind("Add a --json flag"), "feature");
  const agent = { name: "a", provider: "claude", model: "claude-sonnet-5" } as never;
  const named = chooseArms({ title: "x", arms: [{ provider: "gemini", model: "gemini-3-pro" }] }, agent, 2, { root: "/", ready: () => true });
  assert.deepEqual(named.map((c) => c.mode), ["named", "named"]);
  const spread = chooseArms({ title: "x" }, agent, 3, { root: "/", ready: () => true, random: mulberry32(1) });
  assert.equal(new Set(spread.map((c) => armKey(c.arm))).size, 3);
  assert.ok(new Set(spread.map((c) => c.arm.provider)).size >= 2);
});

test("a task with checks cannot be settled by hand", () => {
  const dir = repo();
  try {
    const task = addTask({ title: "Fix the retry test", assignee: "fixer", verifiers: [{ kind: "command", run: "true" }] }, dir);
    assert.throws(() => updateTask(task.id, { status: "done" }, dir), /done only when an attempt passes them/);
    const plain = addTask({ title: "Write the release notes", assignee: "fixer" }, dir);
    assert.equal(updateTask(plain.id, { status: "done" }, dir).status, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
