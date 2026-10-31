/**
 * Judges and gates. Every run is a stub; every check is a shell command
 * or a stub vote.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { runTask } from "./attempts.js";
import { decideApproval, evidenceFor, gate, gateSettings, pendingApprovals, proposeAction, setAutoMerge, type Evidence } from "./gates.js";
import { initLedger, readLedger, verify } from "./ledger.js";
import { findAgent, hire } from "./roster.js";
import { addTask } from "./tasks.js";
import { runVerifier } from "./verify.js";

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
process.env.GIT_AUTHOR_NAME = "t";
process.env.GIT_AUTHOR_EMAIL = "t@t";
process.env.GIT_COMMITTER_NAME = "t";
process.env.GIT_COMMITTER_EMAIL = "t@t";

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ceo-gates-"));
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "# test\n");
  writeFileSync(path.join(dir, ".gitignore"), ".ceo/\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  initLedger(dir);
  hire({ name: "fixer", role: "Fix what the queue asks for, with the smallest change.", provider: "claude", budgetUsd: 5, autonomy: "execute" }, dir);
  return dir;
}

function mainLog(dir: string): string {
  return execFileSync("git", ["log", "--oneline", "main"], { cwd: dir, encoding: "utf8" });
}

const judgeSpec = { kind: "judge", rubric: "The change is minimal." } as const;
const ctxFor = (dir: string) => ({ root: dir, workdir: dir, base: "HEAD", provider: "claude", task: "Fix the retry test" });

function clearVerdicts(): void {
  for (const k of ["STUB_VERDICT", "STUB_VERDICT_CODEX", "STUB_VERDICT_GEMINI", "STUB_VERDICT_CLAUDE"]) delete process.env[k];
}

test("two judges on two other providers pass only in agreement, fail on one fail, and error without a verdict", async () => {
  const dir = repo();
  try {
    clearVerdicts();
    process.env.STUB_VERDICT = "pass";
    const pass = await runVerifier(judgeSpec, ctxFor(dir));
    assert.equal(pass.status, "pass", pass.detail);
    assert.equal(pass.score, 1);
    const votes = (pass.evidence as { judges: Array<{ provider: string; verdict: string; delegationId: string | null }>; agreement: boolean }).judges;
    assert.deepEqual(new Set(votes.map((v) => v.provider)), new Set(["codex", "gemini"]));
    assert.equal((pass.evidence as { agreement: boolean }).agreement, true);
    assert.ok(votes.every((v) => v.verdict === "pass" && v.delegationId));
    assert.ok((pass.costUsd ?? 0) > 0);
    // One judge agent per provider, hired once, pinned to observe.
    assert.equal(findAgent("judge-codex", dir)?.autonomy, "observe");
    assert.equal(findAgent("judge-gemini", dir)?.autonomy, "observe");
    assert.equal(findAgent("judge-claude", dir), null);
    const starts = readLedger(dir).filter((e) => e.type === "delegate_start" && e.data.via === "judge");
    assert.equal(starts.length, 2);

    process.env.STUB_VERDICT_CODEX = "fail";
    const fail = await runVerifier(judgeSpec, ctxFor(dir));
    assert.equal(fail.status, "fail", fail.detail);
    assert.equal(fail.score, 0.5);
    assert.equal((fail.evidence as { agreement: boolean }).agreement, false);

    clearVerdicts();
    const none = await runVerifier(judgeSpec, ctxFor(dir));
    assert.equal(none.status, "error", none.detail);
    assert.equal(none.score, null);
    assert.equal(findAgent("judge-codex", dir)?.autonomy, "observe");
    assert.equal(verify(dir).ok, true);
  } finally {
    clearVerdicts();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a judge falls back to the attempt's own provider when no other is ready", async () => {
  const dir = repo();
  try {
    clearVerdicts();
    process.env.STUB_VERDICT = "pass";
    const r = await runVerifier({ kind: "judge", rubric: "minimal", judges: 1, providers: ["claude"] }, ctxFor(dir));
    assert.equal(r.status, "pass", r.detail);
    const votes = (r.evidence as { judges: Array<{ provider: string }> }).judges;
    assert.deepEqual(votes.map((v) => v.provider), ["claude"]);
  } finally {
    clearVerdicts();
    rmSync(dir, { recursive: true, force: true });
  }
});

const passing: Evidence = {
  verdict: { pass: true, score: 1 },
  checks: [
    { name: "test -f WIN", kind: "command", status: "pass" },
    { name: "2 judges", kind: "judge", status: "pass" },
  ],
  judges: [],
};

test("the merge rule needs a pass, a deterministic check, agreeing judges and the org setting", () => {
  const on = { autoMerge: true };
  assert.equal(gate("merge", passing, on).allow, true);
  assert.equal(gate("merge", passing, { autoMerge: false }).allow, false);
  assert.equal(gate("merge", { ...passing, verdict: { pass: false, score: 0.4 } }, on).allow, false);
  assert.equal(gate("merge", { ...passing, checks: [{ name: "2 judges", kind: "judge", status: "pass" }] }, on).allow, false);
  assert.equal(gate("merge", { ...passing, checks: [...passing.checks, { name: "3 judges", kind: "judge", status: "fail" }] }, on).allow, false);
  assert.equal(gate("merge", { verdict: { pass: true, score: 1 }, checks: [{ name: "x", kind: "command", status: "pass" }], judges: [] }, on).allow, true);
  for (const action of ["push", "pr", "publish", "send", "pay"] as const) assert.equal(gate(action, passing, on).allow, false, action);
});

test("with auto-merge on, a promotion with a passing command check and agreeing judges lands in main", async () => {
  const dir = repo();
  try {
    clearVerdicts();
    process.env.STUB_VERDICT = "pass";
    assert.equal(gateSettings(dir).autoMerge, false);
    setAutoMerge(true, dir);
    assert.equal(gateSettings(dir).autoMerge, true);
    const task = addTask({ title: "Fix the flaky retry test", assignee: "fixer", verifiers: [{ kind: "command", run: "test -f WIN" }, { kind: "judge", rubric: "The change is minimal." }] }, dir);
    const out = await runTask(task.id, {
      cwd: dir,
      onStart: (a) => writeFileSync(path.join(a.workdir, "WIN"), "fixed\n"),
    }).finished;
    assert.equal(out.status, "done", out.note);
    assert.match(mainLog(dir), /Fix the flaky retry test/);
    assert.equal(execFileSync("git", ["show", "main:WIN"], { cwd: dir, encoding: "utf8" }), "fixed\n");
    assert.equal(pendingApprovals(dir).length, 0);
    const note = readLedger(dir).find((e) => e.type === "note" && e.data.kind === "auto_merge")!;
    assert.ok(note, "an auto_merge note is recorded");
    const ev = note.data.evidence as Evidence;
    assert.equal(ev.checks.filter((c) => c.status === "pass").length, 2);
    assert.equal(ev.judges.length, 2);
    assert.equal(verify(dir).ok, true);
  } finally {
    clearVerdicts();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with auto-merge off, a promotion files a request with its evidence and approving it merges", async () => {
  const dir = repo();
  try {
    clearVerdicts();
    process.env.STUB_VERDICT = "pass";
    const task = addTask({ title: "Fix the flaky retry test", assignee: "fixer", verifiers: [{ kind: "command", run: "test -f WIN" }, { kind: "judge", rubric: "The change is minimal." }] }, dir);
    const out = await runTask(task.id, {
      cwd: dir,
      onStart: (a) => writeFileSync(path.join(a.workdir, "WIN"), "fixed\n"),
    }).finished;
    assert.equal(out.status, "done", out.note);
    assert.doesNotMatch(mainLog(dir), /Fix the flaky retry test/);
    const pending = pendingApprovals(dir);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].action, "merge");
    assert.equal(pending[0].attemptId, out.winner!.id);
    assert.equal(pending[0].evidence.verdict?.pass, true);
    assert.deepEqual(pending[0].evidence.checks.map((c) => `${c.kind}:${c.status}`).sort(), ["command:pass", "judge:pass"]);
    assert.equal(pending[0].evidence.judges.length, 2);

    const r = decideApproval(pending[0].id, true, dir);
    assert.equal(r.ok, true, r.message);
    assert.match(mainLog(dir), /Fix the flaky retry test/);
    assert.equal(pendingApprovals(dir).length, 0);
    const decided = readLedger(dir).find((e) => e.type === "approval_decide")!;
    assert.equal(decided.data.decision, "approved");
    assert.equal(decided.data.by, "you");
    assert.equal((decided.data.result as { ok: boolean }).ok, true);
    assert.ok(readLedger(dir).some((e) => e.type === "worktree_merge" && e.data.ok === true));
    assert.equal(decideApproval(pending[0].id, true, dir).ok, false, "a decided request cannot be decided twice");
    assert.equal(verify(dir).ok, true);
  } finally {
    clearVerdicts();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an outward action is always a request, whatever the evidence, and approving records the decision only", () => {
  const dir = repo();
  try {
    setAutoMerge(true, dir);
    const out = proposeAction("push", { agent: "fixer", branch: "ceo/fixer", summary: "Push ceo/fixer to origin.", evidence: passing }, dir);
    assert.equal(out.status, "requested");
    const [req] = pendingApprovals(dir);
    assert.equal(req.action, "push");
    assert.equal(req.evidence.checks.length, 2);
    const r = decideApproval(req.id, true, dir);
    assert.equal(r.ok, true);
    assert.match(r.message, /no executor/);
    assert.equal(pendingApprovals(dir).length, 0);

    proposeAction("pay", { summary: "Pay the invoice.", evidence: passing }, dir);
    const [pay] = pendingApprovals(dir);
    assert.equal(decideApproval(pay.id, false, dir).ok, true);
    assert.equal(readLedger(dir).filter((e) => e.type === "approval_decide").pop()!.data.decision, "denied");
    assert.equal(evidenceFor(null, null, dir).checks.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
