/**
 * Queue semantics against a real ledger in a temp directory. No git, no
 * claude: `.ceo/` resolves to the cwd when it is not a repo.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { initLedger, readLedger, verify } from "./ledger.js";
import { hire, setBudget } from "./roster.js";
import { addTask, listTasks, nextQueuedFor, taskCounts, updateTask } from "./tasks.js";

function freshOrg(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ceo-tasks-"));
  initLedger(dir);
  hire({ name: "worker", role: "does the work that is queued", budgetUsd: 1 }, dir);
  return dir;
}

test("a task is queued, runs, settles, and the chain stays intact", () => {
  const dir = freshOrg();
  try {
    const t = addTask({ title: "write the changelog", assignee: "worker" }, dir);
    assert.equal(t.status, "queued");
    assert.equal(nextQueuedFor("worker", dir)?.id, t.id);

    updateTask(t.id, { status: "running", delegationId: "abc123" }, dir);
    assert.equal(listTasks(dir)[0].status, "running");
    assert.equal(nextQueuedFor("worker", dir), null);

    updateTask(t.id, { status: "done" }, dir);
    assert.equal(listTasks(dir)[0].status, "done");
    assert.equal(listTasks(dir)[0].delegationId, "abc123");

    assert.equal(verify(dir).ok, true);
    const types = readLedger(dir).map((e) => e.type);
    assert.deepEqual(types.slice(-3), ["task_add", "task_update", "task_update"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blocked is derived, never stored", () => {
  const dir = freshOrg();
  try {
    const unassigned = addTask({ title: "nobody owns this yet" }, dir);
    assert.equal(unassigned.status, "blocked");
    assert.equal(unassigned.blockedReason, "unassigned");

    const owned = addTask({ title: "worker owns this", assignee: "worker" }, dir);
    assert.equal(owned.status, "queued");

    // Cap the agent at zero spend headroom: a $0 budget means uncapped, so
    // set a tiny positive budget and record spend against it via the ledger.
    setBudget("worker", 0.0001, dir);
    // No delegations yet, so spend is 0 < 0.0001: still queued.
    assert.equal(listTasks(dir).find((t) => t.id === owned.id)?.status, "queued");

    // Assigning the blocked one unblocks it without a status write.
    updateTask(unassigned.id, { assignee: "worker" }, dir);
    const after = listTasks(dir).find((t) => t.id === unassigned.id)!;
    assert.equal(after.status, "queued");
    const stored = readLedger(dir).filter((e) => e.type === "task_update");
    assert.equal(stored.length, 1);
    assert.equal("status" in stored[0].data, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("illegal transitions are refused with the reason", () => {
  const dir = freshOrg();
  try {
    const t = addTask({ title: "one thing", assignee: "worker" }, dir);
    assert.throws(() => updateTask(t.id, { status: "failed" }, dir), /queued task cannot become failed/);
    updateTask(t.id, { status: "cancelled" }, dir);
    assert.throws(() => updateTask(t.id, { status: "done" }, dir), /cancelled task cannot become done/);
    updateTask(t.id, { status: "queued" }, dir);
    assert.equal(listTasks(dir)[0].status, "queued");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordering: running, then queued by priority and age, then settled newest first", () => {
  const dir = freshOrg();
  try {
    const low = addTask({ title: "low priority", assignee: "worker", priority: "low" }, dir);
    const high = addTask({ title: "high priority", assignee: "worker", priority: "high" }, dir);
    const normal = addTask({ title: "normal priority", assignee: "worker" }, dir);
    const done = addTask({ title: "already done", assignee: "worker" }, dir);
    updateTask(done.id, { status: "done" }, dir);
    const running = addTask({ title: "in flight", assignee: "worker" }, dir);
    updateTask(running.id, { status: "running" }, dir);

    const ids = listTasks(dir).map((t) => t.id);
    assert.deepEqual(ids, [running.id, high.id, normal.id, low.id, done.id]);

    const counts = taskCounts(listTasks(dir));
    assert.equal(counts.running, 1);
    assert.equal(counts.queued, 3);
    assert.equal(counts.done, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assigning to an unknown agent is refused", () => {
  const dir = freshOrg();
  try {
    assert.throws(() => addTask({ title: "for a ghost", assignee: "ghost" }, dir), /No agent named "ghost"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
