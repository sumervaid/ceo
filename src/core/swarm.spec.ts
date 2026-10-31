/**
 * Swarms and limits: many agents at once, and what happens when a provider
 * says stop. Every run here is a stub.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { ensureChief, chiefMaxHiresPerReply } from "./chat.js";
import { COMPANIES, planCompany } from "./companies.js";
import { cooldowns, coolingDown, cooldownUntil, detectRateLimit, maxRunning, noteRateLimit, type Cooldowns } from "./limits.js";
import { initLedger, readLedger, verify } from "./ledger.js";
import { hire, readRoster } from "./roster.js";
import { runDelegation } from "./runner.js";
import { describeSpread, hireSwarm, spreadProviders, swarmNames } from "./swarm.js";
import { addTask, findTask } from "./tasks.js";
import { geometry, orbitTargets, drawSky, rowToText, rowToAnsi, cometPoint } from "../tui/sky.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLLAB_ENTRY = path.resolve(HERE, "..", "mcp", "collab-index.js");
const TOOLS = path.resolve(HERE, "..", "..", "tools");

process.env.CEO_CLAUDE_BIN = path.join(TOOLS, "stub-claude");
process.env.CEO_CODEX_BIN = path.join(TOOLS, "stub-codex");
process.env.CEO_GEMINI_BIN = path.join(TOOLS, "stub-gemini");
process.env.CLAUDE_CODE_OAUTH_TOKEN = "stub-token";
process.env.STUB_CODEX_LOGIN = "chatgpt";
process.env.STUB_GEMINI_LOGIN = "ok";
process.env.STUB_DELAY_MS = "15";
process.env.CEO_REQUIRE_STUBS = "1";

function org(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ceo-swarm-"));
  initLedger(dir);
  return dir;
}

const text = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join("\n");

test("swarm names count up past names already taken, and providers are dealt round-robin", () => {
  assert.deepEqual(swarmNames("fixer", 1, new Set()), ["fixer"]);
  assert.deepEqual(swarmNames("fixer", 3, new Set(["fixer-02"])), ["fixer-01", "fixer-03", "fixer-04"]);
  assert.equal(swarmNames("w", 120, new Set())[119], "w-120");
  const dealt = spreadProviders(7, ["claude", "codex", "gemini"]);
  assert.deepEqual(dealt, ["claude", "codex", "gemini", "claude", "codex", "gemini", "claude"]);
  assert.equal(describeSpread(dealt), "3 claude · 2 codex · 2 gemini");
});

test("a swarm hires every member as an ordinary agent, and the ledger records the swarm", () => {
  const dir = org();
  try {
    const r = hireSwarm({ name: "fixer", count: 30, brief: "Fix one flaky test and prove it with twenty runs.", providers: ["claude", "codex", "gemini"], budgetUsd: 1 }, dir);
    assert.equal(r.hired.length, 30);
    assert.equal(r.failed.length, 0);
    const roster = readRoster(dir).agents;
    assert.equal(roster.length, 30);
    assert.equal(roster.filter((a) => a.provider === "gemini").length, 10);
    assert.match(roster[0].role, /One of 30 in the fixer swarm/);
    const note = readLedger(dir).find((e) => e.type === "note" && e.data.kind === "swarm")!;
    assert.equal((note.data.hired as string[]).length, 30);
    assert.equal(verify(dir).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the chief hires a swarm in one call with no per-reply limit, and the allowance covers every budget", async () => {
  const dir = org();
  const chief = ensureChief(dir).agent;
  assert.equal(chiefMaxHiresPerReply({}), Infinity);
  const client = new Client({ name: "test", version: "0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [COLLAB_ENTRY, "--agent", chief.name, "--root", dir, "--delegation", "d00d"], env: process.env as Record<string, string> }));
    const swarm = await client.callTool({ name: "org_hire", arguments: { name: "fixer", count: 12, providers: ["claude", "codex", "gemini"], brief: "Fix one flaky test in orbit.", provider: "claude", budgetUsd: 1.5 } });
    assert.equal(swarm.isError, undefined, text(swarm));
    assert.match(text(swarm), /Hired a swarm of 12: fixer-01, fixer-02, fixer-03 … fixer-12\. 4 claude · 4 codex · 4 gemini/);
    assert.match(text(swarm), /Allowance: \$7 of \$25 left to give/);
    assert.equal(readLedger(dir).filter((e) => e.type === "hire" && e.data.by === chief.name).length, 12);

    const tooMany = await client.callTool({ name: "org_hire", arguments: { name: "more", count: 10, brief: "Ten more members than the allowance holds.", provider: "codex", budgetUsd: 1 } });
    assert.equal(tooMany.isError, true);
    assert.match(text(tooMany), /10 budgets of \$1, \$10 in all, are more than your allowance has left/);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a company scales: each seat becomes a swarm dealt across the ready providers", () => {
  const dir = org();
  try {
    const plan = planCompany(COMPANIES[0], dir, { scale: 4, ready: () => true });
    assert.equal(plan.scale, 4);
    assert.equal(plan.seats.length, COMPANIES[0].seats.length * 4);
    const group = plan.seats.filter((s) => s.group === COMPANIES[0].seats[0].name);
    assert.equal(group.length, 4);
    assert.equal(new Set(group.map((s) => s.provider)).size, 3);
    assert.equal(new Set(plan.seats.map((s) => s.name)).size, plan.seats.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rate and usage limits are read from the error, with the reset time when the provider gives one", () => {
  const now = new Date(2026, 9, 31, 13, 0, 0).getTime();
  assert.equal(detectRateLimit("TypeError: undefined is not a function", now), null);
  assert.equal(detectRateLimit(null, now), null);
  assert.equal(detectRateLimit("Claude AI usage limit reached|1793430000", now)?.resetAt, 1793430000 * 1000);
  assert.equal(detectRateLimit("429 Too Many Requests: try again in 20s", now)?.resetAt, now + 20_000);
  assert.equal(detectRateLimit("You've hit your usage limit. Resets 3pm.", now)?.resetAt, new Date(2026, 9, 31, 15, 0, 0).getTime());
  assert.equal(detectRateLimit("RESOURCE_EXHAUSTED: quota exceeded for this project", now)?.resetAt, null);

  // No reset time: one minute, then two, then four.
  const c: Cooldowns = new Map();
  const limit = { resetAt: null, reason: "rate limit" };
  assert.equal(noteRateLimit(c, "codex", limit, now), now + 60_000);
  assert.equal(noteRateLimit(c, "codex", limit, now + 60_000), now + 60_000 + 120_000);
  assert.equal(coolingDown(c, "codex", now + 61_000), true);
  assert.equal(coolingDown(c, "claude", now), false);
  assert.equal(cooldownUntil({ resetAt: now + 5000, reason: "" }, 9, now), now + 5000);

  assert.equal(maxRunning({}), null);
  assert.equal(maxRunning({ CEO_MAX_RUNNING: "unlimited" }), null);
  assert.equal(maxRunning({ CEO_MAX_RUNNING: "8" }), 8);
});

test("a run refused by a usage limit puts its task back in the queue and pauses the provider", async () => {
  const dir = org();
  const before = process.env.STUB_ERROR;
  try {
    hire({ name: "coder", role: "Implement what the queue asks for.", provider: "claude", budgetUsd: 2 }, dir);
    const task = addTask({ title: "Fix the retry test", assignee: "coder" }, dir);
    process.env.STUB_ERROR = "Claude AI usage limit reached|4102444800";
    const result = await runDelegation("coder", task.title, { cwd: dir, taskId: task.id }).finished;
    assert.equal(result.ok, false);
    assert.equal(result.rateLimit?.provider, "claude");
    assert.equal(result.rateLimit?.retryAt, 4102444800 * 1000);
    assert.equal(findTask(task.id, dir)?.status, "queued");
    assert.equal(coolingDown(cooldowns, "claude"), true);
    const entries = readLedger(dir);
    assert.equal(entries.find((e) => e.type === "delegate_end")?.data.outcome, "rate_limited");
    assert.equal(entries.find((e) => e.type === "note" && e.data.kind === "rate_limited")?.data.provider, "claude");
    assert.equal(verify(dir).ok, true);
  } finally {
    if (before === undefined) delete process.env.STUB_ERROR;
    else process.env.STUB_ERROR = before;
    cooldowns.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the sky puts working agents on the inner rings, drops names when crowded, and draws the chief in the horizon", () => {
  const g = geometry(140, 38);
  assert.ok(g.rh < g.rd && g.rd < g.rIn && g.rIn <= g.rOut);
  const few = [
    { name: "idle-one", status: "idle" as const, since: 0 },
    { name: "worker", status: "running" as const, since: 1 },
  ];
  const { targets, labelled } = orbitTargets(g, few, 0);
  assert.equal(labelled, true);
  assert.ok(targets.get("worker")!.r <= targets.get("idle-one")!.r);

  const crowd = Array.from({ length: 400 }, (_, i) => ({ name: `agent-${i}`, status: "idle" as const, since: i }));
  const big = orbitTargets(g, crowd, 0);
  assert.equal(big.labelled, false);
  assert.equal(big.targets.size, 400);

  const cells = drawSky({ width: 140, height: 38, t: 1000, swirl: 1, stars: [{ name: "worker", provider: "codex", status: "running", x: 20, y: 10 }], edges: [], comets: [], ripples: [], labelled: true, selected: null, centerLabel: "chief", centerActive: false });
  assert.equal(cells.length, 38);
  assert.ok(cells.every((r) => r.length === 140));
  const textRows = cells.map(rowToText);
  assert.ok(textRows.some((r) => r.includes("◆ chief")));
  assert.ok(textRows.some((r) => r.includes("worker")));
  assert.ok(textRows.some((r) => /[⠁-⣿]/.test(r)), "the disk is drawn in braille");
  assert.match(rowToAnsi(cells[10], true), /\x1b\[38;2;/);
  assert.match(rowToAnsi(cells[10], false), /\x1b\[38;5;/);

  const mid = cometPoint({ x1: 10, y1: 5, x2: 130, y2: 5 }, g, 0.5);
  assert.ok(mid.y > 5, "a comet bends toward the hole");
});
