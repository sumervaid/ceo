/**
 * Experiments: specs, cells, resume, export, the analysis, and the ceo
 * backend on stubs. No real agent runs.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { analyze, bootstrap, renderReport } from "./analysis.js";
import { cellsOf, exportExperiment, parseSpec, planOf, readCell, runExperiment, toCsv, writeExport } from "./experiment.js";

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
process.env.GIT_AUTHOR_NAME = "test";
process.env.GIT_AUTHOR_EMAIL = "test@example.com";
process.env.GIT_COMMITTER_NAME = "test";
process.env.GIT_COMMITTER_EMAIL = "test@example.com";

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "ceo-exp-"));
}

const simSpec = (over: Record<string, unknown> = {}) =>
  parseSpec({
    name: "t",
    backend: "sim",
    sizes: [1, 2, 4],
    seeds: 2,
    conditions: [{ name: "independent", mode: "independent" }, { name: "team", mode: "team" }],
    tasks: [{ id: "a" }, { id: "b" }, { id: "c" }],
    ...over,
  });

test("parseSpec fills defaults and refuses what cannot run", () => {
  const s = parseSpec({ name: "x", tasks: [{ id: "one" }] });
  assert.equal(s.backend, "sim");
  assert.deepEqual(s.sizes, [1, 2, 4, 8]);
  assert.equal(s.seeds, 3);
  assert.equal(s.conditions[0].mode, "independent");
  assert.deepEqual(parseSpec({ name: "x", sizes: [4, 1, 4, 2], tasks: [{ id: "one" }] }).sizes, [1, 2, 4]);

  assert.throws(() => parseSpec({ name: "bad name", tasks: [{ id: "a" }] }), /name/);
  assert.throws(() => parseSpec({ name: "x", tasks: [] }), /tasks/);
  assert.throws(() => parseSpec({ name: "x", tasks: [{ id: "a" }, { id: "a" }] }), /distinct/);
  assert.throws(() => parseSpec({ name: "x", sizes: [0], tasks: [{ id: "a" }] }), /sizes/);
  assert.throws(() => parseSpec({ name: "x", backend: "ceo", conditions: [{ name: "t", mode: "team" }], tasks: [{ id: "a", prompt: "do it", verify: ["true"] }] }), /sim backend/);
  assert.throws(() => parseSpec({ name: "x", backend: "ceo", tasks: [{ id: "a", prompt: "do it" }] }), /at least one check/);
  assert.throws(() => parseSpec({ name: "x", conditions: [{ name: "c", provider: "codex" }], sim: { arms: [{ provider: "claude", model: "m", ability: 0, costUsd: 1, minutes: 1 }] }, tasks: [{ id: "a" }] }), /no arm is on codex/);
});

test("cells run seed by seed, so a run cut short leaves whole replicates", () => {
  const spec = simSpec();
  const cells = cellsOf(spec);
  assert.equal(cells.length, 2 * 3 * 3 * 2);
  const firstSeed1 = cells.findIndex((c) => c.seed === 1);
  assert.equal(firstSeed1, cells.length / 2);
  assert.equal(new Set(cells.map((c) => c.id)).size, cells.length);
  assert.equal(cells[0].id, "independent.n1.s0.a");
  assert.equal(planOf(spec).attempts, 2 * 3 * 2 * (1 + 2 + 4));
});

test("a sim experiment runs, resumes, refuses a changed design, and exports one row per attempt", async () => {
  const dir = scratch();
  try {
    const spec = simSpec();
    const first = await runExperiment(spec, { dir });
    assert.equal(first.ran, 36);
    assert.equal(first.stopped, null);
    assert.ok(first.spentUsd > 0);

    const again = await runExperiment(spec, { dir });
    assert.equal(again.ran, 0);
    assert.equal(again.skipped, 36);
    assert.ok(Math.abs(again.spentUsd - first.spentUsd) < 0.01);

    await assert.rejects(runExperiment(simSpec({ seeds: 3 }), { dir }), /spec changed/);
    const fresh = await runExperiment(simSpec({ seeds: 3 }), { dir, fresh: true });
    assert.equal(fresh.ran, 54);

    const data = exportExperiment(dir);
    assert.equal(data.cells.length, 54);
    assert.equal(data.attempts.length, 3 * 3 * 2 * (1 + 2 + 4));
    const out = writeExport(dir);
    const header = readFileSync(out.attempts, "utf8").split("\n")[0];
    assert.match(header, /^experiment,backend,cell,condition,mode,size,seed,task,attempt,provider,model,/);
    for (const c of data.cells) assert.equal(c.solved, c.passing > 0 ? 1 : 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a budget stops the run before the next cell", async () => {
  const dir = scratch();
  try {
    const out = await runExperiment(simSpec({ budgetUsd: 1 }), { dir });
    assert.match(out.stopped ?? "", /budget/);
    assert.ok(out.ran > 0 && out.ran < 36);
    assert.ok(out.spentUsd >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sim cell inside another repo writes only inside the cell", async () => {
  const outer = scratch();
  try {
    mkdirSync(path.join(outer, ".git"));
    const dir = path.join(outer, "exp");
    await runExperiment(simSpec({ seeds: 1, sizes: [1] }), { dir });
    assert.equal(existsSync(path.join(outer, ".ceo")), false);
    assert.ok(existsSync(path.join(dir, "cells", "independent.n1.s0.a", ".ceo", "ledger.jsonl")));
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("the analysis recovers a planted coordination effect and finds none where none was planted", async () => {
  const run = async (team: Record<string, number>) => {
    const dir = scratch();
    try {
      const spec = simSpec({ sizes: [1, 4], seeds: 120, tasks: ["a", "b", "c", "d", "e"].map((id) => ({ id })), sim: { runCorrelation: 0.3, team } });
      await runExperiment(spec, { dir });
      const data = exportExperiment(dir);
      return analyze(data.cells, data.attempts, spec);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const none = await run({ synergy: 0, conflictRate: 0, overheadMinutes: 0, messageUsd: 0 });
  const teamNone = none.conditions.find((c) => c.name === "team")!;
  for (const s of teamNone.sizes) assert.equal(s.coordination?.mean, 0, "common draws make a null team identical");

  const planted = await run({ synergy: 0.4, conflictRate: 0, overheadMinutes: 0, messageUsd: 0 });
  const team = planted.conditions.find((c) => c.name === "team")!;
  const four = team.sizes.find((s) => s.size === 4)!;
  assert.ok(four.coordination!.lo! > 0, "the interval excludes zero");
  assert.ok(four.coordination!.lo! <= four.truthCoordination! && four.truthCoordination! <= four.coordination!.hi!, "the interval covers the truth");
  const ind = planted.conditions.find((c) => c.name === "independent")!;
  for (const s of ind.sizes) assert.ok(Math.abs(s.observed.mean - s.truth!) < 0.06, `size ${s.size}: ${s.observed.mean} vs ${s.truth}`);
  // Within-run correlation shows as observed below the sampling prediction.
  assert.ok(ind.sizes.find((s) => s.size === 4)!.gap! < 0);

  const text = renderReport(planted);
  assert.match(text, /Solved, by team size/);
  assert.match(text, /vs independent/);
  assert.match(text, /planted · runCorrelation 0.3/);
});

test("the bend is the step where gain per doubling falls most", () => {
  const rows = [1, 2, 4, 8].flatMap((size, i) =>
    ["a", "b"].flatMap((task) =>
      Array.from({ length: 10 }, (_, seed) => ({
        experiment: "x", backend: "sim", cell: `c.n${size}.s${seed}.${task}`, condition: "c", mode: "independent", size, seed, task,
        solved: (seed < [2, 6, 8, 9][i] ? 1 : 0) as 0 | 1, attempts: size, passing: 0, minutes_to_first: null, minutes_to_settle: null, cost_usd: size, holdout_pass: null,
      })),
    ),
  );
  const a = analyze(rows, []);
  const c = a.conditions[0];
  assert.deepEqual(c.steps.map((s) => Math.round(s.gain * 100)), [40, 20, 10]);
  assert.equal(c.bend?.step.from, 2);
  assert.equal(c.bend?.step.to, 4);
});

test("bootstrap over one task gives the mean and no interval", () => {
  const one = bootstrap(new Map([["a", [1, 0, 1, 1]]]));
  assert.equal(one.mean, 0.75);
  assert.equal(one.lo, null);
  const two = bootstrap(new Map([["a", [1, 1]], ["b", [0, 0]]]));
  assert.equal(two.mean, 0.5);
  assert.ok(two.lo! <= 0.5 && two.hi! >= 0.5);
});

test("toCsv quotes what needs quoting and leaves nulls empty", () => {
  assert.equal(toCsv([{ a: 1, b: "x,y", c: null, d: 'say "hi"' }]), 'a,b,c,d\n1,"x,y",,"say ""hi"""\n');
  assert.equal(toCsv([]), "");
});

test("the ceo backend runs real attempts on stubs, scores the winner on held-out checks, and leaves no worktrees", async () => {
  const work = scratch();
  try {
    const fixture = path.join(work, "fixture");
    mkdirSync(fixture);
    writeFileSync(path.join(fixture, "README.md"), "# fixture\n");
    const specFile = path.join(work, "spec.json");
    writeFileSync(
      specFile,
      JSON.stringify({
        name: "stubbed",
        backend: "ceo",
        sizes: [1, 2],
        seeds: 1,
        arms: [{ provider: "claude", model: "claude-sonnet-5" }, { provider: "codex", model: "gpt-5" }],
        tasks: [{ id: "win", prompt: "Write the WIN file.", fixture: "fixture", verify: ["test -f WIN"], holdout: ["grep -q fixed WIN"] }],
      }),
    );
    // Only codex writes the file, so only a codex attempt can pass.
    process.env.STUB_WRITE_FILE = "WIN";
    const spec = parseSpec(JSON.parse(readFileSync(specFile, "utf8")), work);
    const dir = path.join(work, "out");
    const out = await runExperiment(spec, { dir });
    assert.equal(out.ran, 2, out.stopped ?? "");

    const solo = readCell(path.join(dir, "cells", "independent.n1.s0.win"))!;
    assert.equal(solo.attempts.length, 1);
    assert.equal(solo.attempts[0].provider, "claude");
    assert.equal(solo.cell.solved, 0);

    const pair = readCell(path.join(dir, "cells", "independent.n2.s0.win"))!;
    assert.deepEqual(pair.attempts.map((a) => a.provider).sort(), ["claude", "codex"]);
    assert.equal(pair.cell.solved, 1);
    assert.equal(pair.cell.holdout_pass, 1);
    const winner = pair.attempts.find((a) => a.promoted === 1)!;
    assert.equal(winner.provider, "codex");
    assert.equal(existsSync(path.join(dir, "cells", "independent.n2.s0.win", ".ceo", "worktrees", `solver--${winner.attempt}`)), false);
  } finally {
    delete process.env.STUB_WRITE_FILE;
    rmSync(work, { recursive: true, force: true });
  }
});

test("the ceo backend refuses real binaries without --live and a budget", async () => {
  const dir = scratch();
  const prev = process.env.CEO_CODEX_BIN;
  try {
    process.env.CEO_CODEX_BIN = "codex";
    const spec = parseSpec({ name: "real", backend: "ceo", arms: [{ provider: "codex", model: "gpt-5" }], agent: { provider: "codex" }, tasks: [{ id: "a", prompt: "do the thing", verify: ["true"] }] });
    await assert.rejects(runExperiment(spec, { dir }), /real agents and spend money/);
    await assert.rejects(runExperiment(spec, { dir, live: true }), /budgetUsd/);
    assert.equal(existsSync(path.join(dir, "cells")), false);
  } finally {
    process.env.CEO_CODEX_BIN = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
