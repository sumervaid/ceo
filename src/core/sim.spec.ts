/**
 * The simulator: deterministic, paired across conditions, and a ledger a
 * real run could have written.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { passAtK } from "./analysis.js";
import { attemptsFor } from "./attempts.js";
import { readLedger, verify } from "./ledger.js";
import { DEFAULT_SIM, expectedSolve, phi, phiInv, recordSimCell, simParams, simulateCell, soloRate } from "./sim.js";

const base = { base: 7, arms: DEFAULT_SIM.arms, seed: 3, taskIndex: 1, taskId: "t1" };

test("phi and phiInv invert each other", () => {
  for (const p of [0.001, 0.02, 0.2, 0.5, 0.8, 0.98, 0.999]) assert.ok(Math.abs(phi(phiInv(p)) - p) < 1e-6, String(p));
  assert.ok(Math.abs(phi(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(phi(1.959964) - 0.975) < 1e-6);
});

test("passAtK is the unbiased draw-without-replacement estimate", () => {
  assert.equal(passAtK(10, 0, 3), 0);
  assert.equal(passAtK(10, 10, 1), 1);
  assert.equal(passAtK(4, 1, 2), 0.5);
  assert.equal(passAtK(4, 3, 2), 1);
  assert.ok(Math.abs(passAtK(10, 3, 1) - 0.3) < 1e-12);
  // More tries than the pool holds falls back to independent draws at the pooled rate.
  assert.ok(Math.abs(passAtK(2, 1, 3) - (1 - 0.5 ** 3)) < 1e-12);
});

test("a cell is the same every time, and differs by seed", () => {
  const params = simParams();
  const a = simulateCell({ ...base, params, size: 8, team: false });
  const b = simulateCell({ ...base, params, size: 8, team: false });
  assert.deepEqual(a, b);
  const c = simulateCell({ ...base, params, size: 8, seed: 4, team: false });
  assert.notDeepEqual(a.attempts.map((x) => x.endMin), c.attempts.map((x) => x.endMin));
});

test("a team with no synergy, no conflicts and no overhead is the independent cell, draw for draw", () => {
  const params = simParams({ team: { synergy: 0, conflictRate: 0, overheadMinutes: 0, messageUsd: 0 } });
  for (const size of [1, 2, 5, 16]) {
    const ind = simulateCell({ ...base, params, size, team: false });
    const team = simulateCell({ ...base, params, size, team: true });
    assert.deepEqual(team, ind, `size ${size}`);
  }
});

test("synergy raises every attempt's chance, conflicts undo passes, overhead costs minutes and dollars", () => {
  const params = simParams({ team: { synergy: 0.5, conflictRate: 0.5, overheadMinutes: 1, messageUsd: 0.1 } });
  const ind = simulateCell({ ...base, params, size: 8, team: false });
  const team = simulateCell({ ...base, params, size: 8, team: true });
  for (let i = 0; i < 8; i++) {
    assert.ok(team.attempts[i].p > ind.attempts[i].p);
    assert.ok(Math.abs(team.attempts[i].endMin - ind.attempts[i].endMin - 7) < 1e-9);
    assert.ok(Math.abs(team.attempts[i].costUsd - ind.attempts[i].costUsd - 0.7) < 1e-9);
    if (team.attempts[i].conflict) assert.equal(team.attempts[i].pass, false);
  }
});

test("a running cap queues attempts behind the ones running", () => {
  const params = simParams({ maxRunning: 2 });
  const cell = simulateCell({ ...base, params, size: 6, team: false });
  assert.equal(cell.attempts.filter((a) => a.startMin === 0).length, 2);
  for (const a of cell.attempts) {
    const running = cell.attempts.filter((b) => b.startMin <= a.startMin + 1e-9 && b.endMin > a.startMin + 1e-9);
    assert.ok(running.length <= 2);
  }
});

test("with no within-run correlation, the model's solve rate is one minus the product of misses", () => {
  const params = simParams({ runCorrelation: 0 });
  const arms = DEFAULT_SIM.arms;
  // The arms rotate from offset (seed + task) % 3 = 1: codex, gemini, claude, codex.
  const order = [arms[1], arms[2], arms[0], arms[1]];
  const exact = 1 - order.reduce((none, arm) => none * (1 - soloRate(params, 7, "t1", arm)), 1);
  assert.ok(Math.abs(expectedSolve({ ...base, params, size: 4, team: false }) - exact) < 1e-6);
  // Correlation within a run lowers the chance that one of several tries lands.
  const correlated = expectedSolve({ ...base, params: simParams({ runCorrelation: 0.6 }), size: 4, team: false });
  assert.ok(correlated < exact);
});

test("a recorded cell is a valid chain that attempts and tasks read back", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ceo-sim-"));
  try {
    const params = simParams({ arms: [{ provider: "codex", model: "gpt-5", ability: 4, costUsd: 0.1, minutes: 2 }] });
    const cell = simulateCell({ ...base, arms: params.arms, params, size: 3, team: false });
    recordSimCell(dir, { taskId: "t1", title: "task t1", size: 3, cellNote: { cell: "x.n3.s0.t1" } }, cell);
    assert.deepEqual(verify(dir).ok, true);
    const attempts = attemptsFor("t1", dir);
    assert.equal(attempts.length, 3);
    assert.equal(attempts.filter((a) => a.verdict?.pass).length, cell.attempts.filter((a) => a.pass).length);
    const entries = readLedger(dir);
    assert.ok(entries.every((e, i) => i === 0 || e.ts >= entries[i - 1].ts), "events go in time order");
    assert.equal(entries.filter((e) => e.type === "promote").length, cell.winner === null ? 0 : 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("simParams refuses values outside their range", () => {
  assert.throws(() => simParams({ runCorrelation: 1 }), /runCorrelation/);
  assert.throws(() => simParams({ arms: [] }), /arms/);
  assert.throws(() => simParams({ team: { conflictRate: -0.1 } }), /conflictRate/);
  assert.throws(() => simParams({ maxRunning: 0 }), /maxRunning/);
});
