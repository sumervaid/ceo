/**
 * Constellation layouts: every preset places every agent inside the sky,
 * and each one arranges by what it says it does.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { autoLayout, cycleLayout, groupOf, layout, LAYOUTS, readSkyLayout, writeSkyLayout, type LayoutAgent, type Polar } from "./layouts.js";
import { geometry } from "./sky.js";

const g = geometry(140, 36);
const PROVS = ["claude", "codex", "gemini"] as const;

function crew(): LayoutAgent[] {
  const names = [...Array.from({ length: 12 }, (_, i) => `fixer-${String(i + 1).padStart(2, "0")}`), "scout", "tester", "reviewer", "implementer"];
  return names.map((name, i) => ({ name, status: i < 5 ? "running" : "idle", provider: PROVS[i % 3], since: i, seq: i, spendUsd: i === 13 ? 9 : i * 0.1, group: groupOf(name) }));
}

const input = (agents: LayoutAgent[], extra: Partial<Parameters<typeof layout>[1]> = {}) => ({ g, agents, edges: [], chiefLinks: new Map<string, number>(), t: 0, current: new Map<string, Polar>(), ...extra });
const dist = (p: Polar, q: Polar) => Math.hypot(Math.cos(p.a) * p.r - Math.cos(q.a) * q.r, Math.sin(p.a) * p.r - Math.sin(q.a) * q.r);

test("every layout places every agent between the disk and the rim", () => {
  const agents = crew();
  for (const l of LAYOUTS) {
    const out = layout(l.id, input(agents));
    assert.equal(out.targets.size, agents.length, l.id);
    for (const p of out.targets.values()) {
      assert.ok(Number.isFinite(p.r) && Number.isFinite(p.a), l.id);
      assert.ok(p.r >= g.rd && p.r <= g.rOut + 0.01, `${l.id} r=${p.r}`);
    }
  }
});

test("providers gives each provider its own wedge, with its name at the rim", () => {
  const out = layout("providers", input(crew()));
  const wedge = (p: (typeof PROVS)[number]) => crew().filter((a) => a.provider === p).map((a) => out.targets.get(a.name)!.a);
  const spans = PROVS.map((p) => ({ min: Math.min(...wedge(p)), max: Math.max(...wedge(p)) })).sort((x, y) => x.min - y.min);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i].min > spans[i - 1].max, "wedges do not overlap");
  assert.equal(out.guides.labels.length, 3);
  assert.match(out.guides.labels.map((l) => l.text).join(" "), /claude · 6/);
});

test("teams gathers a swarm into one cluster and labels it", () => {
  const out = layout("teams", input(crew()));
  const fixers = crew().filter((a) => a.group === "fixer").map((a) => out.targets.get(a.name)!);
  const spread = Math.max(...fixers.flatMap((p) => fixers.map((q) => dist(p, q))));
  const toScout = dist(fixers[0], out.targets.get("scout")!);
  assert.ok(spread < toScout + 1, "the swarm sits closer together than to another team");
  assert.ok(out.guides.labels.some((l) => /fixer ×12 · 5 working/.test(l.text)));
  assert.equal(groupOf("fixer·codex·9f"), "fixer");
});

test("web pulls agents that trade notes together and sends loners to the rim", () => {
  const agents = crew();
  let current = new Map<string, Polar>();
  let out = layout("web", input(agents, { current }));
  for (let i = 0; i < 60; i++) {
    current = out.targets;
    out = layout("web", input(agents, { current, edges: [{ a: "scout", b: "reviewer", weight: 6 }] }));
  }
  const pair = dist(out.targets.get("scout")!, out.targets.get("reviewer")!);
  const loner = out.targets.get("tester")!;
  assert.ok(pair < dist(out.targets.get("scout")!, loner), "the pair is closer than a loner");
  assert.ok(loner.r > g.rOut - 1.5, "a loner drifts to the rim");
});

test("spend puts the heaviest spender closest, and spiral follows hire order", () => {
  const spend = layout("spend", input(crew()));
  assert.equal(Math.min(...[...spend.targets.values()].map((p) => p.r)), spend.targets.get("tester")!.r);
  assert.ok(spend.guides.labels.some((l) => l.text === "$9.00"));
  const spiral = layout("spiral", input(crew()));
  assert.ok(spiral.targets.get("fixer-01")!.r < spiral.targets.get("implementer")!.r);
  assert.ok(spiral.guides.path.length > 20);
});

test("auto reads the org: a swarm is teams, a busy exchange is a web, a big mixed team is providers", () => {
  assert.equal(autoLayout(crew(), 0), "teams");
  const small = crew().filter((a) => a.group !== "fixer");
  assert.equal(autoLayout(small, 5), "web");
  assert.equal(autoLayout(small, 0), "orbit");
  const mixed = Array.from({ length: 10 }, (_, i) => ({ ...crew()[0], name: `a${i}`, group: `a${i}`, provider: PROVS[i % 3] }));
  assert.equal(autoLayout(mixed, 0), "providers");
  assert.equal(cycleLayout("auto", 1), "orbit");
  assert.equal(cycleLayout("auto", -1), "spiral");
});

test("the chosen layout is remembered, and CEO_SKY_LAYOUT wins", () => {
  const home = mkdtempSync(path.join(tmpdir(), "ceo-sky-"));
  const before = { home: process.env.CEO_HOME, env: process.env.CEO_SKY_LAYOUT };
  process.env.CEO_HOME = home;
  delete process.env.CEO_SKY_LAYOUT;
  try {
    assert.equal(readSkyLayout(), "auto");
    writeSkyLayout("web");
    assert.equal(readSkyLayout(), "web");
    process.env.CEO_SKY_LAYOUT = "spiral";
    assert.equal(readSkyLayout(), "spiral");
  } finally {
    if (before.home === undefined) delete process.env.CEO_HOME;
    else process.env.CEO_HOME = before.home;
    if (before.env === undefined) delete process.env.CEO_SKY_LAYOUT;
    else process.env.CEO_SKY_LAYOUT = before.env;
    rmSync(home, { recursive: true, force: true });
  }
});
