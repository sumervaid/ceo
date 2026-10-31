/**
 * Outcomes: statistics read from the ledger, the budget gate, and the
 * allocation of dispatch slots. Events are written directly with `append`.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { attemptGates } from "./attempts.js";
import { append, initLedger } from "./ledger.js";
import { allocation, dispatchOrder, outcomeBudget, outcomeRefusal, outcomeStats, setOutcomeBudget } from "./outcomes.js";
import { hire } from "./roster.js";
import { addTask, updateTask } from "./tasks.js";

process.env.CEO_REQUIRE_STUBS = "1";

const CLAUDE = { provider: "claude", model: "sonnet" };
const CODEX = { provider: "codex", model: "gpt-5" };

function org(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ceo-outcomes-"));
  initLedger(dir);
  hire({ name: "fixer", role: "Fix what the queue asks for, with the smallest change.", provider: "claude", budgetUsd: 5, autonomy: "execute" }, dir);
  return dir;
}

/** One attempt on one task: start, end, and optionally a promotion. */
function attempt(dir: string, taskId: string, id: string, arm: typeof CLAUDE, costUsd: number, opts: { outcome?: string; promote?: boolean } = {}): void {
  append("attempt_start", "fixer", { taskId, attemptId: id, agent: "fixer", arm, mode: "pick", branch: null, worktree: "", base: null }, dir);
  append("attempt_end", "fixer", { taskId, attemptId: id, delegationId: null, outcome: opts.outcome ?? "done", costUsd }, dir);
  if (opts.promote) append("promote", "fixer", { taskId, attemptId: id, branch: null, arm, score: 1, costUsd, attempts: 1, dissent: null }, dir);
}

test("stats count attempts, promotions and spend, and split them by arm and agent", () => {
  const dir = org();
  const a = addTask({ title: "Fix the retry test", assignee: "fixer", samples: 2 }, dir);
  attempt(dir, a.id, "a1", CLAUDE, 0.4, { promote: true });
  attempt(dir, a.id, "a2", CODEX, 0.2);
  updateTask(a.id, { status: "done" }, dir);
  const b = addTask({ title: "Tidy the docs", assignee: "fixer", samples: 2 }, dir);
  attempt(dir, b.id, "b1", CODEX, 0.1, { outcome: "failed" });
  updateTask(b.id, { status: "running" }, dir);
  updateTask(b.id, { status: "failed" }, dir);

  const s = outcomeStats(dir);
  assert.equal(s.attempts, 3);
  assert.equal(s.finished, 2);
  assert.equal(s.verified, 1);
  assert.equal(s.failedTasks, 1);
  assert.ok(Math.abs(s.spentUsd - 0.7) < 1e-9);
  assert.ok(Math.abs(s.usdPerVerified! - 0.7) < 1e-9);
  assert.equal(s.passRate, 0.5);
  const codex = s.byArm.find((r) => r.label === "codex gpt-5")!;
  assert.deepEqual([codex.attempts, codex.verified], [2, 0]);
  assert.equal(s.byArm.find((r) => r.label === "claude sonnet")!.verified, 1);
  assert.equal(s.byAgent.length, 1);
  assert.equal(s.byAgent[0].label, "fixer");
  assert.ok(Math.abs(s.byAgent[0].usd - s.spentUsd) < 1e-9);
});

test("a plain task counts as one attempt and as done but unverified", () => {
  const dir = org();
  const plain = addTask({ title: "Rename the flag", assignee: "fixer" }, dir);
  updateTask(plain.id, { status: "done" }, dir);
  append("delegate_start", "fixer", { id: "d1", task: "Rename the flag", provider: "claude", model: "sonnet", taskId: plain.id }, dir);
  append("delegate_end", "fixer", { id: "d1", costUsd: 0.3, outcome: "done" }, dir);

  const s = outcomeStats(dir);
  assert.equal(s.attempts, 1);
  assert.equal(s.finished, 1);
  assert.equal(s.verified, 0);
  assert.equal(s.unverified, 1);
  assert.ok(Math.abs(s.spentUsd - 0.3) < 1e-9);
  assert.equal(s.usdPerVerified, null);
});

test("delegations inside attempts are not counted twice, and no verified outcome leaves dollars per verified null", () => {
  const dir = org();
  const t = addTask({ title: "Fix the flaky test", assignee: "fixer", samples: 2 }, dir);
  append("delegate_start", "fixer", { id: "d1", task: "Fix the flaky test", provider: "claude", model: "sonnet", taskId: t.id, attemptId: "x1" }, dir);
  append("delegate_end", "fixer", { id: "d1", costUsd: 0.5 }, dir);
  attempt(dir, t.id, "x1", CLAUDE, 0.5, { outcome: "failed" });
  const s = outcomeStats(dir);
  assert.ok(Math.abs(s.spentUsd - 0.5) < 1e-9);
  assert.equal(s.usdPerVerified, null);
  assert.equal(outcomeStats(dir, Date.now() + 60_000).attempts, 0);
});

test("the gate refuses over the attempts cap and after the verified target", () => {
  const dir = org();
  assert.equal(attemptGates.some((g) => g({} as never, 1, dir) === null), true);
  assert.equal(outcomeRefusal(dir, 3), null);

  setOutcomeBudget({ attempts: 3 }, dir);
  assert.deepEqual(outcomeBudget(dir), { attempts: 3, verified: null, period: "all" });
  const t = addTask({ title: "Fix the retry test", assignee: "fixer", samples: 2 }, dir);
  attempt(dir, t.id, "g1", CLAUDE, 0.1);
  attempt(dir, t.id, "g2", CODEX, 0.1);
  assert.equal(outcomeRefusal(dir, 1), null);
  const over = outcomeRefusal(dir, 2);
  assert.match(over ?? "", /allows 3 attempts\. 2 have started and 2 more/);
  assert.ok(attemptGates.some((g) => g({} as never, 2, dir) === over), "the registered gate gives the same reason");

  setOutcomeBudget({ verified: 1 }, dir);
  assert.equal(outcomeRefusal(dir, 1), null);
  append("promote", "fixer", { taskId: t.id, attemptId: "g1", branch: null, arm: CLAUDE, score: 1, costUsd: 0.1, attempts: 2, dissent: null }, dir);
  assert.match(outcomeRefusal(dir, 1) ?? "", /target of 1 verified outcomes is met with 1 verified/);

  setOutcomeBudget({ attempts: null, verified: null }, dir);
  assert.equal(outcomeRefusal(dir, 5), null);
});

test("dispatchOrder gives the cheaper workspace more slots and an unproven one a share", () => {
  const rows = [
    { path: "/pricey", usdPerVerified: 4 },
    { path: "/cheap", usdPerVerified: 1 },
    { path: "/new", usdPerVerified: null },
  ];
  const plan = dispatchOrder(rows, 12);
  const slots = new Map(plan.map((p) => [p.path, p.slots]));
  assert.equal(plan[0].path, "/cheap");
  assert.equal([...slots.values()].reduce((a, b) => a + b, 0), 12);
  assert.ok(slots.get("/cheap")! > slots.get("/pricey")!);
  assert.ok(slots.get("/new")! >= 1);

  const unlimited = dispatchOrder(rows, null);
  assert.deepEqual(unlimited.map((p) => p.path), ["/cheap", "/new", "/pricey"]);
  assert.ok(unlimited.every((p) => p.slots === Infinity));

  const tight = dispatchOrder(rows, 2);
  assert.deepEqual(tight.map((p) => p.slots), [1, 1, 0]);
  assert.deepEqual(dispatchOrder([], 4), []);

  const shares = allocation(rows.map((r) => ({ path: r.path, stats: { usdPerVerified: r.usdPerVerified } })));
  assert.ok(Math.abs(shares.reduce((n, s) => n + s.share, 0) - 1) < 1e-9);
  assert.ok(shares.every((s) => s.share > 0));
  assert.equal(shares[0].path, "/cheap");
});
