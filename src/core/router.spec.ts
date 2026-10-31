/**
 * The router: a bandit over arms per kind of work. Every run is synthetic
 * ledger evidence and a seeded random source.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { append, initLedger } from "./ledger.js";
import { providerFor } from "./providers.js";
import { chooseArms, recommend, resetRouterCache, routerTable, sampleBeta, taskKind } from "./router.js";
import type { AgentRecord, Arm, Provider } from "./types.js";

process.env.CEO_REQUIRE_STUBS = "1";
const EMPTY_REFLEX = mkdtempSync(path.join(tmpdir(), "ceo-reflex-none-"));
process.env.REFLEX_HOME = EMPTY_REFLEX;

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

function org(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ceo-router-"));
  initLedger(dir);
  return dir;
}

const agent = { name: "fixer", provider: "claude", model: providerFor("claude").defaultModel() } as AgentRecord;
const bothReady = (p: Provider): boolean => p !== "gemini";
const allReady = (): boolean => true;

let ids = 0;
/** One finished attempt in the ledger. `verdict` null writes no verify event. */
function attempt(dir: string, arm: Arm, kind: string, o: { outcome?: string; verdict?: "pass" | "fail" | null; cost?: number } = {}): void {
  const attemptId = `a${++ids}`;
  const taskId = `t${ids}`;
  append("attempt_start", "fixer", { taskId, attemptId, agent: "fixer", arm, mode: "pick", kind }, dir);
  append("attempt_end", "fixer", { taskId, attemptId, delegationId: null, outcome: o.outcome ?? "done", costUsd: o.cost ?? 0.1 }, dir);
  if (o.verdict) append("verify", "fixer", { taskId, attemptId, verifier: { kind: "command", required: true, weight: 1 }, status: o.verdict, score: o.verdict === "pass" ? 1 : 0 }, dir);
}

const codexArm: Arm = { provider: "codex", model: providerFor("codex").defaultModel() };
const claudeArm: Arm = { provider: "claude", model: providerFor("claude").defaultModel() };

test("the Beta sampler has the right mean", () => {
  const rnd = mulberry32(7);
  for (const [a, b] of [[3, 2], [1, 1], [9, 1], [0.5, 0.5]] as const) {
    let sum = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const x = sampleBeta(a, b, rnd);
      assert.ok(x >= 0 && x <= 1);
      sum += x;
    }
    assert.ok(Math.abs(sum / N - a / (a + b)) < 0.01, `Beta(${a}, ${b}) mean ${sum / N}`);
  }
});

test("the router follows ledger evidence, and a table shows it", () => {
  const dir = org();
  try {
    for (let i = 0; i < 8; i++) attempt(dir, codexArm, "debug", { verdict: "pass", cost: 0.1 });
    attempt(dir, claudeArm, "debug", { verdict: "pass", cost: 0.1 });
    for (let i = 0; i < 7; i++) attempt(dir, claudeArm, "debug", { verdict: "fail", cost: 0.1 });
    // Cancelled attempts and limits say nothing about an arm.
    attempt(dir, claudeArm, "debug", { outcome: "cancelled" });
    attempt(dir, claudeArm, "debug", { outcome: "rate_limited" });

    const task = { title: "Fix the crash in the retry loop" };
    assert.equal(taskKind(task.title), "debug");
    let codex = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const [pick] = chooseArms(task, agent, 1, { root: dir, ready: bothReady, random: mulberry32(seed), skills: [] });
      assert.equal(pick.mode, "pick");
      if (pick.arm.provider === "codex") codex += 1;
    }
    assert.ok(codex >= 180, `codex picked ${codex} of 200`);

    const rows = routerTable(dir, "debug");
    const c = rows.find((r) => r.label === `codex ${codexArm.model}`)!;
    const l = rows.find((r) => r.label === `claude ${claudeArm.model}`)!;
    assert.equal(c.observations, 8);
    assert.equal(c.passes, 8);
    assert.equal(c.passRate, 1);
    assert.equal(c.source, "ceo");
    assert.ok(Math.abs(c.meanCostUsd! - 0.1) < 1e-9);
    assert.ok(Math.abs(c.costPerVerified! - 0.1) < 1e-9);
    assert.equal(l.observations, 8);
    assert.equal(l.passes, 1);
    assert.ok(Math.abs(l.costPerVerified! - 0.8) < 1e-9);
    assert.equal(rows[0].label, c.label);
    assert.equal(routerTable(dir, "review").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an attempt without verifiers passes when the run finished, and fails when it did not", () => {
  const dir = org();
  try {
    attempt(dir, codexArm, "edit", { verdict: null });
    attempt(dir, codexArm, "edit", { outcome: "failed", verdict: null });
    const [row] = routerTable(dir, "edit");
    assert.equal(row.observations, 2);
    assert.equal(row.passes, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("n of three covers all three ready providers, and a fourth attempt is the least tried arm", () => {
  const dir = org();
  try {
    for (let i = 0; i < 8; i++) attempt(dir, codexArm, "debug", { verdict: "pass" });
    for (let i = 0; i < 7; i++) attempt(dir, claudeArm, "debug", { verdict: "fail" });
    for (let seed = 1; seed <= 50; seed++) {
      const out = chooseArms({ title: "Fix the crash" }, agent, 3, { root: dir, ready: allReady, random: mulberry32(seed), skills: [] });
      assert.equal(out.length, 3);
      assert.equal(new Set(out.map((c) => c.arm.provider)).size, 3);
      assert.equal(out[0].mode, "pick");
      assert.equal(out[1].mode, "explore");
      const four = chooseArms({ title: "Fix the crash" }, agent, 4, { root: dir, ready: allReady, random: mulberry32(seed), skills: [] });
      assert.equal(new Set(four.map((c) => JSON.stringify(c.arm))).size, 4);
      assert.match(four[3].why, /least tried/);
    }
    const two = chooseArms({ title: "Fix the crash" }, agent, 2, { root: dir, ready: bothReady, random: mulberry32(3), skills: [] });
    assert.equal(new Set(two.map((c) => c.arm.provider)).size, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("named arms win and repeat, and a skill variant can join the pool", () => {
  const dir = org();
  try {
    const named: Arm[] = [{ provider: "gemini", model: "m1" }, { provider: "codex", model: "m2" }];
    const out = chooseArms({ title: "Fix it", arms: named }, agent, 3, { root: dir });
    assert.deepEqual(out.map((c) => c.arm), [named[0], named[1], named[0]]);
    assert.ok(out.every((c) => c.mode === "named"));

    const skills = [
      { name: "fix-flaky-test", description: "Fix a flaky test by pinning the clock", source: "repo" as const, path: "/x", status: "ready" as const, confidence: null },
      { name: "write-poem", description: "Write a poem", source: "repo" as const, path: "/y", status: "ready" as const, confidence: null },
    ];
    let withSkill = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const picks = chooseArms({ title: "Fix the flaky test" }, agent, 3, { root: dir, ready: allReady, random: mulberry32(seed), skills });
      for (const p of picks) {
        if (p.arm.skills) {
          withSkill += 1;
          assert.deepEqual(p.arm.skills, ["fix-flaky-test"]);
          assert.equal(p.arm.provider, "claude");
        }
      }
    }
    assert.ok(withSkill > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a draw within the tie band goes to the cheaper arm", () => {
  const dir = org();
  try {
    // Equal records, so the draws differ only by chance. The cheap arm should win far more than half.
    const cheap: Arm = { provider: "codex", model: providerFor("codex").defaultModel() };
    const dear: Arm = { provider: "claude", model: providerFor("claude").defaultModel() };
    for (let i = 0; i < 40; i++) {
      attempt(dir, cheap, "ci", { verdict: "pass", cost: 0.01 });
      attempt(dir, dear, "ci", { verdict: "pass", cost: 2 });
    }
    let cheapWins = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const [p] = chooseArms({ title: "Fix the flaky pipeline", kind: "ci" }, agent, 1, { root: dir, ready: bothReady, random: mulberry32(seed), skills: [] });
      if (p.arm.provider === "codex") cheapWins += 1;
    }
    assert.ok(cheapWins > 120, `cheap won ${cheapWins}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Reflex prior counts at half weight and joins the ledger", async (t) => {
  let DatabaseSync: new (p: string) => { exec: (s: string) => void; prepare: (s: string) => { run: (...a: unknown[]) => void }; close: () => void };
  try {
    ({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite"));
  } catch {
    t.skip("node:sqlite is not available");
    return;
  }
  const home = mkdtempSync(path.join(tmpdir(), "ceo-reflex-"));
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(path.join(home, "reflex.db"));
  db.exec("create table route_runs (id integer primary key, run_json text); create table bench_results (id integer primary key, result_json text); create table traces (id integer primary key, trace_json text)");
  const run = db.prepare("insert into route_runs (run_json) values (?)");
  for (let i = 0; i < 2; i++) run.run(JSON.stringify({ at: 1, source: "codex", model: codexArm.model, kind: "debug", mode: "pick", randomized: false, outcome: "done" }));
  run.run(JSON.stringify({ at: 1, source: "codex", model: codexArm.model, kind: "debug", mode: "pick", randomized: false }));
  db.prepare("insert into bench_results (result_json) values (?)").run(JSON.stringify({ source: "claude-code", model: `${claudeArm.model}-20260101`, kind: "review", pass: true }));
  db.prepare("insert into traces (trace_json) values (?)").run(JSON.stringify({ source: "claude-code", usageByModel: { [claudeArm.model]: { input: 10, output: 5 } }, outcome: { verified: false }, requests: [{ text: "fix the crash in login" }] }));
  db.close();

  const dir = org();
  const before = process.env.REFLEX_HOME;
  process.env.REFLEX_HOME = home;
  resetRouterCache();
  try {
    attempt(dir, codexArm, "debug", { verdict: "pass" });
    attempt(dir, codexArm, "debug", { verdict: "fail" });
    const rows = routerTable(dir);
    const c = rows.find((r) => r.kind === "debug" && r.arm.provider === "codex")!;
    assert.equal(c.source, "both");
    assert.equal(c.observations, 4);
    assert.equal(c.passes, 3);
    assert.ok(Math.abs(c.passRate - 2 / 3) < 1e-9, `rate ${c.passRate}`);
    const bench = rows.find((r) => r.kind === "review")!;
    assert.equal(bench.source, "reflex");
    assert.equal(bench.arm.model, claudeArm.model);
    assert.equal(bench.passRate, 1);
    const trace = rows.find((r) => r.kind === "debug" && r.arm.provider === "claude")!;
    assert.equal(trace.passes, 0);
    assert.equal(trace.source, "reflex");
    assert.equal(recommend("debug", dir, 2, { ready: bothReady, random: mulberry32(1) }).length, 2);
  } finally {
    process.env.REFLEX_HOME = before;
    resetRouterCache();
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a missing or unreadable Reflex store changes nothing", () => {
  const dir = org();
  const before = process.env.REFLEX_HOME;
  try {
    process.env.REFLEX_HOME = path.join(EMPTY_REFLEX, "nowhere");
    resetRouterCache();
    attempt(dir, codexArm, "debug", { verdict: "pass" });
    assert.equal(routerTable(dir)[0].source, "ceo");
    const [pick] = recommend("debug", dir, 1, { ready: allReady, random: mulberry32(2) });
    assert.equal(pick.mode, "pick");
  } finally {
    process.env.REFLEX_HOME = before;
    resetRouterCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
