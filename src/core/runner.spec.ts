/**
 * The runner against the stubs, end to end through a real ledger in a temp
 * directory. No model is called: `CEO_CLAUDE_BIN` and `CEO_CODEX_BIN` point at
 * tools/stub-claude and tools/stub-codex, which speak each CLI's line protocol
 * and bill nobody.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { readLedger, verify } from "./ledger.js";
import { initLedger } from "./ledger.js";
import { hire, findAgent } from "./roster.js";
import { runDelegation, type RunEvent } from "./runner.js";
import { resetReadiness } from "./setup.js";
import { liveRuns, postMessage, tracePath } from "./collab.js";
import { existsSync, readFileSync } from "node:fs";
import { addTask, listTasks } from "./tasks.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.resolve(HERE, "..", "..", "tools");

process.env.CEO_CLAUDE_BIN = path.join(TOOLS, "stub-claude");
process.env.CEO_CODEX_BIN = path.join(TOOLS, "stub-codex");
process.env.CEO_GEMINI_BIN = path.join(TOOLS, "stub-gemini");
process.env.STUB_DELAY_MS = "20";
// Belt and braces: a test must never reach a real agent CLI.
process.env.CEO_REQUIRE_STUBS = "1";
// The runner refuses a provider that is not signed in. The codex stub reports
// a ChatGPT login. For claude the token variable stands in for a login.
process.env.CLAUDE_CODE_OAUTH_TOKEN = "stub-token";
process.env.STUB_CODEX_LOGIN = "chatgpt";
process.env.STUB_GEMINI_LOGIN = "ok";
// The codex default model is read from $CODEX_HOME/config.toml. Point it at
// nothing so the test does not depend on this machine's codex config.
process.env.CODEX_HOME = mkdtempSync(path.join(tmpdir(), "ceo-codex-home-"));

function freshOrg(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ceo-runner-"));
  initLedger(dir);
  return dir;
}

test("a codex agent runs under the sandbox, is costed from tokens as an estimate, and the task settles", async () => {
  const dir = freshOrg();
  try {
    hire({ name: "coder", role: "Implement what the queue asks for.", provider: "codex", budgetUsd: 1, autonomy: "execute" }, dir);
    assert.equal(findAgent("coder", dir)?.model, "gpt-5-codex");
    const task = addTask({ title: "add the changelog", assignee: "coder" }, dir);

    const events: RunEvent[] = [];
    const handle = runDelegation("coder", task.title, { cwd: dir, taskId: task.id, onEvent: (e) => events.push(e) });
    const result = await handle.finished;

    assert.equal(result.ok, true, result.error ?? "");
    assert.equal(result.costIsEstimate, true);
    assert.ok(result.costUsd > 0, "a run that spent tokens never settles at $0");
    assert.equal(result.inputTokens, 3000);
    assert.equal(result.outputTokens, 150);
    assert.match(result.text, /Done: add the changelog/);

    const started = events.find((e) => e.type === "started");
    assert.ok(started && started.type === "started");
    assert.equal(started.provider, "codex");
    assert.deepEqual(started.tools, ["sandbox workspace-write", "approvals never", "org tools (10)"]);
    assert.ok(events.some((e) => e.type === "tool"), "command items reach the pane as tool lines");

    const entries = readLedger(dir);
    const start = entries.find((e) => e.type === "delegate_start")!;
    assert.equal(start.data.provider, "codex");
    assert.deepEqual(start.data.enforcement, ["sandbox workspace-write", "approvals never", "org tools (10)"]);
    const endE = entries.find((e) => e.type === "delegate_end")!;
    assert.equal(endE.data.costIsEstimate, true);
    assert.equal(endE.data.costBasis, "openai-list-price");
    assert.ok(Number(endE.data.costUsd) > 0);
    // No crash note for a provider that never reports dollars: the basis is on the entry.
    assert.ok(!entries.some((e) => e.type === "note" && e.data.kind === "cost_estimated"));

    assert.equal(listTasks(dir)[0].status, "done");
    assert.equal(findAgent("coder", dir)?.spentUsd, Number(endE.data.costUsd));
    assert.equal(verify(dir).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sandboxed command on codex is a denial: red in the pane, a note in the ledger, the run still completes", async () => {
  const dir = freshOrg();
  try {
    hire({ name: "reader", role: "Read and report, nothing else.", provider: "codex", budgetUsd: 1, autonomy: "observe" }, dir);
    const events: RunEvent[] = [];
    process.env.STUB_DENY = "1";
    let result;
    try {
      result = await runDelegation("reader", "list the callers", { cwd: dir, onEvent: (e) => events.push(e) }).finished;
    } finally {
      delete process.env.STUB_DENY;
    }
    assert.equal(result.ok, true);
    assert.equal(result.denials.length, 1);
    assert.match(result.denials[0], /^shell: /);
    assert.ok(events.some((e) => e.type === "denied"));
    const started = events.find((e) => e.type === "started");
    assert.ok(started && started.type === "started" && started.tools[0] === "sandbox read-only");
    const note = readLedger(dir).find((e) => e.type === "note" && e.data.kind === "permission_denied")!;
    assert.equal(note.data.provider, "codex");
    assert.equal(note.data.autonomy, "observe");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a claude agent settles at the cost the process reported, not an estimate", async () => {
  const dir = freshOrg();
  try {
    hire({ name: "reader", role: "Read the codebase and report on it.", budgetUsd: 1, autonomy: "observe" }, dir);
    const events: RunEvent[] = [];
    const result = await runDelegation("reader", "map the callers", { cwd: dir, onEvent: (e) => events.push(e) }).finished;
    assert.equal(result.ok, true, result.error ?? "");
    assert.equal(result.costUsd, 0.0123);
    assert.equal(result.costIsEstimate, false);
    const started = events.find((e) => e.type === "started");
    assert.ok(started && started.type === "started");
    assert.equal(started.provider, "claude");
    assert.deepEqual(started.tools, ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "org tools (10)"]);
    const endE = readLedger(dir).find((e) => e.type === "delegate_end")!;
    assert.equal(endE.data.costBasis, "settled");
    assert.equal(endE.data.costIsEstimate, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cancelled run closes the ledger with an estimate and a cost_estimated note; the task is cancelled", async () => {
  const dir = freshOrg();
  try {
    hire({ name: "reader", role: "Read the codebase and report on it.", budgetUsd: 1 }, dir);
    const task = addTask({ title: "slow one", assignee: "reader" }, dir);
    process.env.STUB_NO_RESULT = "1";
    let result;
    try {
      // Cancel once tokens have streamed. A fixed delay can land before the
      // stub's first reply on a loaded machine, and a run cancelled before
      // any tokens rightly costs nothing.
      let streamed!: () => void;
      const firstTokens = new Promise<void>((r) => (streamed = r));
      const handle = runDelegation("reader", task.title, {
        cwd: dir,
        taskId: task.id,
        onEvent: (e) => {
          if (e.type === "text") streamed();
        },
      });
      await firstTokens;
      handle.cancel();
      result = await handle.finished;
    } finally {
      delete process.env.STUB_NO_RESULT;
    }
    assert.equal(result.ok, false);
    assert.equal(result.error, "cancelled");
    assert.ok(result.costUsd > 0);
    assert.equal(result.costIsEstimate, true);
    const entries = readLedger(dir);
    assert.ok(entries.some((e) => e.type === "note" && e.data.kind === "cost_estimated"));
    assert.equal(listTasks(dir)[0].status, "cancelled");
    assert.equal(verify(dir).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing binary is refused with an install hint before any ledger entry is written", async () => {
  const dir = freshOrg();
  const saved = process.env.CEO_CODEX_BIN;
  process.env.CEO_CODEX_BIN = "/nonexistent/codex-binary";
  // A path that does not exist cannot reach a real CLI; let the readiness
  // check, not the stubs-only guard, be what refuses it.
  const guard = process.env.CEO_REQUIRE_STUBS;
  delete process.env.CEO_REQUIRE_STUBS;
  try {
    hire({ name: "coder", role: "Implement what the queue asks for.", provider: "codex", budgetUsd: 1 }, dir);
    resetReadiness();
    const result = await runDelegation("coder", "do a thing", { cwd: dir }).finished;
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /not installed/);
    assert.match(result.error ?? "", /npm i -g @openai\/codex/);
    // Refused before anything was written: no delegation for a run that could never start.
    const types = readLedger(dir).map((e) => e.type);
    assert.ok(!types.includes("delegate_start"));
  } finally {
    process.env.CEO_CODEX_BIN = saved;
    if (guard !== undefined) process.env.CEO_REQUIRE_STUBS = guard;
    resetReadiness();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a gemini agent runs in plan mode through agy, is costed from tokens as an estimate, and a refused tool is a denial", async () => {
  const dir = freshOrg();
  try {
    hire({ name: "analyst", role: "Read the code and report what it does.", provider: "gemini", budgetUsd: 1, autonomy: "observe" }, dir);
    assert.equal(findAgent("analyst", dir)?.model, "gemini");
    const events: RunEvent[] = [];
    process.env.STUB_DENY = "1";
    let result;
    try {
      result = await runDelegation("analyst", "explain the retry logic", { cwd: dir, onEvent: (e) => events.push(e) }).finished;
    } finally {
      delete process.env.STUB_DENY;
    }
    assert.equal(result.ok, true, result.error ?? "");
    assert.equal(result.costIsEstimate, true);
    assert.ok(result.costUsd > 0);
    assert.equal(result.inputTokens, 3600, "input plus cached input");
    assert.equal(result.outputTokens, 210, "output plus thinking");
    assert.match(result.text, /Done: explain the retry logic/);
    assert.equal(result.denials.length, 1);
    assert.match(result.denials[0], /^run_command: /);

    const started = events.find((e) => e.type === "started");
    assert.ok(started && started.type === "started");
    assert.equal(started.provider, "gemini");
    assert.deepEqual(started.tools, ["mode plan"]);

    const entries = readLedger(dir);
    const endE = entries.find((e) => e.type === "delegate_end")!;
    assert.equal(endE.data.costBasis, "google-list-price");
    const note = entries.find((e) => e.type === "note" && e.data.kind === "permission_denied")!;
    assert.equal(note.data.provider, "gemini");
    assert.equal(verify(dir).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a note posted while an agent works is delivered as a follow-up turn on the same session, and the trace records it", async () => {
  const dir = freshOrg();
  const savedDelay = process.env.STUB_DELAY_MS;
  process.env.STUB_DELAY_MS = "80";
  try {
    hire({ name: "scout", role: "Survey the codebase and answer questions.", budgetUsd: 1, autonomy: "observe" }, dir);
    hire({ name: "coder", role: "Implement what the queue asks for.", budgetUsd: 2, autonomy: "execute" }, dir);
    const events: RunEvent[] = [];
    const handle = runDelegation("coder", "add retries to client.ts", { cwd: dir, onEvent: (e) => events.push(e) });
    // Mid first turn: a teammate posts. The stub takes ~320 ms for its turn.
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(liveRuns(dir).filter((r) => r.live).length, 1, "the run is visible as live from its trace");
    postMessage({ from: "scout", to: "coder", text: "the flaky path is retry.ts, not client.ts" }, dir);
    const result = await handle.finished;

    assert.equal(result.ok, true, result.error ?? "");
    assert.equal(result.turns, 2);
    assert.ok(events.some((e) => e.type === "turn" && e.n === 2 && /scout/.test(e.reason)));
    // The stub echoes the head of each prompt, so the follow-up's opening shows in the text.
    assert.match(result.text, /While you were working/);
    const endE = readLedger(dir).find((e) => e.type === "delegate_end")!;
    assert.equal(endE.data.turns, 2);
    assert.ok(Number(endE.data.costUsd) > 0);

    const startE = readLedger(dir).find((e) => e.type === "delegate_start")!;
    const trace = readFileSync(tracePath(String(startE.data.id), dir), "utf8");
    assert.match(trace, /"type":"meta"/);
    assert.match(trace, /"type":"turn"/);
    assert.match(trace, /"type":"end"/);
    assert.equal(liveRuns(dir).filter((r) => r.live).length, 0, "ended runs are not live");
    assert.ok(existsSync(tracePath(String(startE.data.id), dir)));
  } finally {
    process.env.STUB_DELAY_MS = savedDelay;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run with no notes stays one turn, and CEO_NO_COLLAB keeps the org tools out", async () => {
  const dir = freshOrg();
  process.env.CEO_NO_COLLAB = "1";
  try {
    hire({ name: "reader", role: "Read the codebase and report on it.", budgetUsd: 1, autonomy: "observe" }, dir);
    const events: RunEvent[] = [];
    const result = await runDelegation("reader", "map the callers", { cwd: dir, onEvent: (e) => events.push(e) }).finished;
    assert.equal(result.turns, 1);
    const started = events.find((e) => e.type === "started");
    assert.ok(started && started.type === "started" && !started.tools.some((t) => t.startsWith("org tools")));
  } finally {
    delete process.env.CEO_NO_COLLAB;
    rmSync(dir, { recursive: true, force: true });
  }
});
