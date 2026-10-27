/**
 * Team suggestions from fixtures: a repository with a manifest and tests, a
 * codex rollout and a Claude Code transcript for it, and a Reflex store
 * with one repeated workflow naming the repo. Every input is a temp file. No
 * real history is read, because CODEX_HOME, CLAUDE_CONFIG_DIR and REFLEX_HOME
 * point at the fixtures.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { claudeProjectFolder, readClaudeHistory, readCodexHistory, readReflex } from "./history.js";
import { resetReflexStatus } from "./reflex.js";
import { pickModel, recentTerms, repoSignals, suggestTeam } from "./suggest.js";

function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), "ceo-suggest-"));
  const root = path.join(base, "api");
  mkdirSync(path.join(root, "test"), { recursive: true });
  mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "api", scripts: { test: "node --test", build: "tsc" } }));
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "");
  writeFileSync(path.join(root, "README.md"), "# api\n");

  // codex: one rollout for this repo, one for another.
  const codexHome = path.join(base, "codex");
  const day = path.join(codexHome, "sessions", "2026", "10", "20");
  mkdirSync(day, { recursive: true });
  const rollout = (cwd: string, model: string, ask: string) =>
    [
      { timestamp: "2026-10-20T10:00:00Z", type: "session_meta", payload: { id: "s-" + path.basename(cwd), timestamp: "2026-10-20T10:00:00Z", cwd } },
      { type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model } } },
      { type: "event_msg", payload: { type: "user_message", message: ask } },
      { type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "{}" } },
      { type: "event_msg", payload: { type: "patch_apply_end", call_id: "c1" } },
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 50000, cached_input_tokens: 40000, output_tokens: 2000 } } } },
    ]
      .map((o) => JSON.stringify(o))
      .join("\n") + "\n";
  writeFileSync(path.join(day, "rollout-2026-10-20T10-00-00-aaaa.jsonl"), rollout(root, "gpt-5-codex", "fix the flaky retry test in client.ts"));
  writeFileSync(path.join(day, "rollout-2026-10-20T11-00-00-bbbb.jsonl"), rollout(path.join(base, "other"), "gpt-5", "unrelated"));

  // claude code: one transcript for this repo.
  const claudeCfg = path.join(base, "claude");
  const proj = path.join(claudeCfg, "projects", claudeProjectFolder(root));
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    path.join(proj, "11111111.jsonl"),
    [
      { type: "user", timestamp: "2026-10-21T09:00:00Z", message: { role: "user", content: "add retry backoff to client.ts and a test" } },
      { type: "assistant", message: { id: "m1", model: "claude-sonnet-5", usage: { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 20000, cache_creation_input_tokens: 500 }, content: [{ type: "tool_use", name: "Edit", input: {} }] } },
      { type: "assistant", message: { id: "m1", model: "claude-sonnet-5", usage: { input_tokens: 1000, output_tokens: 300 }, content: [{ type: "text", text: "done" }] } },
      { type: "user", timestamp: "2026-10-21T09:05:00Z", message: { role: "user", content: "<task-notification>harness</task-notification>" } },
    ]
      .map((o) => JSON.stringify(o))
      .join("\n") + "\n",
  );

  // reflex: a store with one workflow that names this repo, one that does not.
  const reflexHome = path.join(base, "reflex");
  mkdirSync(reflexHome, { recursive: true });
  const db = path.join(reflexHome, "reflex.db");
  const workflow = (slug: string, repos: string[], steps: Array<[string, string]>) =>
    JSON.stringify({
      slug,
      title: `Repeated workflow: ${slug}`,
      description: "Repeated workflow involving tests.",
      whenToUse: "Use for requests similar to: retry, flaky, test.",
      confidence: 0.8,
      instances: 4,
      repositories: repos,
      sources: { codex: 3, "claude-code": 1 },
      steps: steps.map(([kind, instruction]) => ({ kind, label: kind, instruction, support: 1, examples: [] })),
      topTerms: ["retry", "flaky", "test"],
      verifiedRate: 0.75,
      cost: { runs: 4, runsWithTokens: 4, medianTokens: 100000, usage: { input: 20000, output: 4000, cacheRead: 300000, cacheWrite: 1000 }, medianToolCalls: 12 },
      constraints: { avoid: ["adjust the test to pass"], prefer: ["pnpm over npm"] },
    });
  const sql = [
    "CREATE TABLE scans (id INTEGER PRIMARY KEY, started_at TEXT, days INTEGER, mode TEXT, sources_json TEXT, files INTEGER, sessions INTEGER, partial INTEGER, unreadable INTEGER, skipped_records INTEGER);",
    "INSERT INTO scans VALUES (1, '2026-10-22T08:00:00Z', 30, 'full', '[]', 2, 2, 0, 0, 0);",
    "CREATE TABLE suggestions (slug TEXT PRIMARY KEY, status TEXT, rank INTEGER, scan_id INTEGER, data_json TEXT, updated_at TEXT);",
    `INSERT INTO suggestions VALUES ('fix-flaky-test', 'pending', 1, 1, '${workflow("fix-flaky-test", ["api", "web"], [["inspect-code", "Read the failing test."], ["modify-tests", "Fix the root cause of the flake."], ["run-tests", "Run the suite."]]).replace(/'/g, "''")}', '2026-10-22');`,
    `INSERT INTO suggestions VALUES ('review-pr', 'pending', 2, 1, '${workflow("review-pr", ["web"], [["inspect-diff", "Read the diff."]]).replace(/'/g, "''")}', '2026-10-22');`,
    "CREATE TABLE traces (row_id INTEGER PRIMARY KEY, path TEXT, session_id TEXT, source TEXT, ended_at TEXT, context_hash TEXT, trace_json TEXT);",
    `INSERT INTO traces VALUES (1, 'p', 'codex:s-api', 'codex', NULL, NULL, '${JSON.stringify({ sessionId: "codex:s-api", source: "codex", projectName: "api", projectHash: "nomatch", usage: { input: 10000, output: 2000, cacheRead: 40000, cacheWrite: 0 }, usageByModel: { "gpt-5-codex": { input: 10000, output: 2000, cacheRead: 40000, cacheWrite: 0 } }, outcome: { verified: true }, toolCalls: 9, excerpt: "fix the flaky retry test" })}');`,
  ].join("\n");
  execFileSync("sqlite3", [db], { input: sql });

  const env = { ...process.env, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeCfg, REFLEX_HOME: reflexHome };
  return { base, root, env };
}

test("the direct readers see only this directory's sessions, with model, tokens and requests", () => {
  const { base, root, env } = fixture();
  try {
    const codex = readCodexHistory(root, { env });
    assert.equal(codex.length, 1);
    assert.equal(codex[0].model, "gpt-5-codex");
    assert.deepEqual(codex[0].requests, ["fix the flaky retry test in client.ts"]);
    assert.equal(codex[0].tokens.cacheRead, 40000);
    assert.equal(codex[0].tokens.input, 10000);
    assert.equal(codex[0].edits, 1);
    assert.ok(codex[0].costUsd > 0);

    const claude = readClaudeHistory(root, { env });
    assert.equal(claude.length, 1);
    assert.equal(claude[0].model, "claude-sonnet-5");
    // Usage counted once per message id. The harness notification is not a request.
    assert.equal(claude[0].tokens.output, 300);
    assert.deepEqual(claude[0].requests, ["add retry backoff to client.ts and a test"]);
    assert.equal(claude[0].edits, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("Reflex workflows are read with steps, cost and constraints; the repo's own are marked local", async () => {
  const { base, root, env } = fixture();
  try {
    const r = await readReflex(root, env);
    assert.equal(r.available, true);
    assert.equal(r.scannedAt, "2026-10-22T08:00:00Z");
    assert.equal(r.workflows.length, 2);
    const local = r.workflows.find((w) => w.slug === "fix-flaky-test")!;
    assert.equal(local.local, true);
    assert.equal(r.workflows.find((w) => w.slug === "review-pr")!.local, false);
    assert.equal(local.steps.length, 3);
    assert.deepEqual(local.constraints.avoid, ["adjust the test to pass"]);
    assert.equal(local.cost?.runs, 4);
    // The trace matched by project name, since its hash is for another cwd.
    assert.equal(r.sessions.length, 1);
    assert.equal(r.sessions[0].verified, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a team is proposed: the local Reflex workflow as a seat, then the roles the repo earns, on the model used here", async () => {
  const { base, root, env } = fixture();
  try {
    const p = await suggestTeam(root, { env, taken: ["scout"] });
    const names = p.team.map((s) => s.name);
    assert.equal(names[0], "fix-flaky-test");
    assert.ok(!names.includes("scout") && !names.includes("scout-2"), "a seat already in the org leaves the proposal");
    assert.ok(names.includes("implementer") && names.includes("tester") && names.includes("reviewer"));
    assert.ok(!names.includes("review-pr"), "workflows from other repos are left out when the repo has its own");

    const wf = p.team[0];
    assert.equal(wf.source, "reflex");
    assert.equal(wf.autonomy, "execute", "a workflow that modifies files runs at execute");
    assert.equal(wf.isolated, true);
    assert.match(wf.role, /1\. Read the failing test\./);
    assert.deepEqual(wf.guardrails, ["Do not adjust the test to pass", "Prefer pnpm over npm"]);
    assert.ok(wf.budgetUsd >= 1);
    assert.ok(wf.evidence.some((e) => /4 independent sessions/.test(e)));

    // gpt-5-codex has two sessions here, one direct and one via Reflex, de-duplicated to one.
    // claude-sonnet-5 has one. The most used wins and the provider follows it.
    const tester = p.team.find((s) => s.name === "tester")!;
    assert.match(tester.role, /tests run with `pnpm test`/);
    assert.ok(["gpt-5-codex", "claude-sonnet-5"].includes(tester.model));
    assert.equal(tester.provider, tester.model.startsWith("gpt") ? "codex" : "claude");
    assert.ok(p.summary.some((l) => /Reflex: 2 repeated workflows, 1 in this repo/.test(l)));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("without Reflex or history the repo alone still earns a team, and says the model is a default", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "ceo-suggest-bare-"));
  try {
    writeFileSync(path.join(base, "Cargo.toml"), "[package]\nname='x'\n");
    const env = { ...process.env, CODEX_HOME: path.join(base, "nocodex"), CLAUDE_CONFIG_DIR: path.join(base, "noclaude"), REFLEX_HOME: path.join(base, "noreflex"), CEO_REFLEX_BIN: "/nonexistent/reflex" };
    resetReflexStatus();
    const p = await suggestTeam(base, { env });
    assert.deepEqual(p.team.map((s) => s.name), ["scout", "implementer", "tester"]);
    assert.match(p.team[1].role, /tests run with `cargo test`/);
    assert.ok(p.team[0].evidence.some((e) => /default model/.test(e)));
    assert.match(p.summary[0], /Reflex is not installed/);
    resetReflexStatus();
    assert.equal(repoSignals(base).languages[0], "rust");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("pickModel prefers a clearly better-verified model with enough sessions, and recentTerms drops stopwords", () => {
  const s = (model: string, verified: boolean | null) => ({
    source: "codex" as const, id: Math.random().toString(), startedAt: null, model, requests: ["fix the flaky retry test"], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, toolCalls: 1, edits: 0, verified, costUsd: 1,
  });
  const pick = pickModel([s("gpt-5", false), s("gpt-5", false), s("gpt-5", true), s("gpt-5", false), s("claude-opus-4-7", true), s("claude-opus-4-7", true), s("claude-opus-4-7", true)]);
  assert.equal(pick?.model, "claude-opus-4-7");
  assert.match(pick!.evidence, /verified 100%/);
  assert.deepEqual(recentTerms([s("x", null), s("x", null)]), ["flaky", "retry", "test"]);
});
