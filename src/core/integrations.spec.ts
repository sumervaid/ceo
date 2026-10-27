/**
 * The docket, GitHub, Hugging Face, skills and alerts, end to end with no
 * network and no account: a stub `gh`, a Hub read from a directory, a stub
 * Reflex, a local HTTP server standing in for Slack, and a stub notifier.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { readAlerts, sendAlert, writeAlerts } from "./alerts.js";
import { ensureChief } from "./chat.js";
import { addContext, classify, contextFor, giveContext, listContext, refreshContext, removeContext, takeContext, tokenLabel } from "./context.js";
import { compileAgentPrompt } from "./compile.js";
import { githubStatus, listIssues, openPullRequest, provenanceBody, resetGithubStatus } from "./github.js";
import { hfCard, hfPaper, hfStatus, parseHfSource, resetHfStatus } from "./huggingface.js";
import { initLedger, readLedger, verify } from "./ledger.js";
import { forgetProjectRoots } from "./paths.js";
import { findAgent, hire } from "./roster.js";
import { runDelegation } from "./runner.js";
import { approveWorkflow, readySkills } from "./skills.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.resolve(HERE, "..", "..", "tools");
const COLLAB_ENTRY = path.resolve(HERE, "..", "mcp", "collab-index.js");
const SCRATCH = mkdtempSync(path.join(tmpdir(), "ceo-integrations-"));

process.env.CEO_CLAUDE_BIN = path.join(TOOLS, "stub-claude");
process.env.CEO_CODEX_BIN = path.join(TOOLS, "stub-codex");
process.env.CEO_GEMINI_BIN = path.join(TOOLS, "stub-gemini");
process.env.CEO_GH_BIN = path.join(TOOLS, "stub-gh");
process.env.CLAUDE_CODE_OAUTH_TOKEN = "stub-token";
process.env.STUB_CODEX_LOGIN = "chatgpt";
process.env.STUB_GEMINI_LOGIN = "ok";
process.env.STUB_DELAY_MS = "10";
process.env.CEO_REQUIRE_STUBS = "1";
process.env.CEO_HOME = path.join(SCRATCH, "home");
process.env.HF_HOME = path.join(SCRATCH, "hf-home");
delete process.env.HF_TOKEN;
delete process.env.HUGGING_FACE_HUB_TOKEN;
process.env.REFLEX_HOME = path.join(SCRATCH, "reflex");
process.env.CLAUDE_CONFIG_DIR = path.join(SCRATCH, "claude");
process.env.CODEX_HOME = path.join(SCRATCH, "codex");

// A Hub in a directory: one model, one dataset, one paper.
const HUB = path.join(SCRATCH, "hub");
function write(file: string, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}
write(path.join(HUB, "api", "models", "acme", "tiny-retry.json"), JSON.stringify({ id: "acme/tiny-retry", pipeline_tag: "text-generation", library_name: "transformers", downloads: 12345, likes: 7, tags: ["retry", "en"] }));
write(path.join(HUB, "acme", "tiny-retry", "raw", "main", "README.md"), "---\nlicense: mit\n---\n# tiny-retry\n\nA small model that writes retry loops.\n");
write(path.join(HUB, "api", "datasets", "acme", "flaky-runs.json"), JSON.stringify({ id: "acme/flaky-runs", downloads: 10, tags: ["ci"] }));
write(path.join(HUB, "datasets", "acme", "flaky-runs", "raw", "main", "README.md"), "# flaky-runs\n\nTen thousand CI runs, labelled flaky or not.\n");
write(path.join(HUB, "api", "papers", "2401.00001.json"), JSON.stringify({ id: "2401.00001", title: "Backoff that Works", summary: "We show that resetting backoff early causes tail failures.", authors: [{ name: "A. Author" }, { name: "B. Author" }] }));
process.env.CEO_HF_ENDPOINT = pathToFileURL(HUB).href;

// Skills: one from Reflex, one installed for Claude Code, and a stub Reflex that approves.
write(path.join(process.env.REFLEX_HOME, "skills", "fix-flaky-test", "SKILL.md"), "---\nname: fix-flaky-test\ndescription: Make a flaky test pass reliably\n---\n\n## When to use\n\nA test fails some runs and passes others.\n\n## Workflow\n\n1. Run the test ten times.\n2. Find the shared state.\n");
write(path.join(process.env.CLAUDE_CONFIG_DIR, "skills", "write-changelog", "SKILL.md"), "---\nname: write-changelog\ndescription: Add a changelog entry\n---\n\n## Workflow\n\n1. Read the diff.\n");
const REFLEX_STUB = path.join(SCRATCH, "stub-reflex");
write(REFLEX_STUB, `#!/bin/sh\nif [ "$1" = "approve" ]; then mkdir -p "$REFLEX_HOME/skills/$2"; printf -- "---\\nname: $2\\ndescription: approved by the stub\\n---\\n\\n## Workflow\\n\\n1. Do it.\\n" > "$REFLEX_HOME/skills/$2/SKILL.md"; exit 0; fi\n[ "$1" = "--version" ] && echo 0.3.1\nexit 0\n`);
chmodSync(REFLEX_STUB, 0o755);
process.env.CEO_REFLEX_BIN = REFLEX_STUB;

function repo(): string {
  const dir = mkdtempSync(path.join(SCRATCH, "org-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  write(path.join(dir, "src", "retry.ts"), "export function retry() {\n  let attempts = 0;\n}\n");
  write(path.join(dir, "src", "client.ts"), "export const client = 1;\n");
  write(path.join(dir, "README.md"), "# orbit\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  forgetProjectRoots();
  initLedger(dir);
  hire({ name: "coder", role: "Implement what the queue asks for.", provider: "codex", budgetUsd: 2, isolated: true }, dir);
  hire({ name: "reviewer", role: "Read diffs and flag correctness bugs.", provider: "gemini", budgetUsd: 2, autonomy: "propose" }, dir);
  return dir;
}

test("one input line is read as the right kind of context", () => {
  const dir = repo();
  assert.deepEqual(classify("src/retry.ts", dir), { kind: "file", source: "src/retry.ts" });
  assert.deepEqual(classify("src", dir), { kind: "folder", source: "src" });
  assert.deepEqual(classify("#42", dir), { kind: "issue", source: "#42" });
  assert.deepEqual(classify("https://github.com/acme/orbit/pull/12", dir), { kind: "pr", source: "#12" });
  assert.deepEqual(classify("hf:acme/tiny-retry", dir), { kind: "model", source: "acme/tiny-retry" });
  assert.deepEqual(classify("https://huggingface.co/datasets/acme/flaky-runs", dir), { kind: "dataset", source: "acme/flaky-runs" });
  assert.deepEqual(classify("paper:2401.00001", dir), { kind: "paper", source: "2401.00001" });
  assert.deepEqual(classify("https://example.com/spec", dir), { kind: "url", source: "https://example.com/spec" });
  assert.deepEqual(classify("skill:fix-flaky-test", dir), { kind: "skill", source: "fix-flaky-test" });
  assert.equal(classify("Prefer pnpm over npm.", dir).kind, "note");
  assert.deepEqual(parseHfSource("hf:spaces/acme/demo"), { kind: "space", id: "acme/demo" });
});

test("the docket gives each agent its own context: files read fresh from the agent's branch, the rest from snapshots", async () => {
  const dir = repo();
  const file = await addContext("src/retry.ts", dir, { agents: ["coder"] });
  const note = await addContext("Prefer pnpm over npm. Never adjust a test to pass.", dir, { agents: ["coder", "reviewer"] });
  assert.equal(file.snapshot, null);
  assert.ok(note.snapshot?.startsWith(".ceo/context/"));
  assert.deepEqual(listContext(dir).find((i) => i.id === note.id)?.agents.sort(), ["coder", "reviewer"]);

  // The coder's worktree has a different retry.ts: the coder reads that one.
  const coder = findAgent("coder", dir)!;
  writeFileSync(path.join(coder.worktreePath!, "src", "retry.ts"), "export function retry() {\n  // on the branch\n}\n");
  const forCoder = contextFor("coder", dir, coder.worktreePath!);
  assert.match(forCoder.find((c) => c.id === file.id)!.text, /on the branch/);
  assert.equal(contextFor("reviewer", dir).length, 1);

  takeContext(note.id, "reviewer", dir);
  assert.equal(contextFor("reviewer", dir).length, 0);
  giveContext(note.id, "reviewer", dir);
  assert.equal(contextFor("reviewer", dir).length, 1);

  // Limits: an item is cut, and the prompt says so.
  process.env.CEO_CONTEXT_ITEM_MAX = "20";
  const cut = contextFor("coder", dir, coder.worktreePath!);
  delete process.env.CEO_CONTEXT_ITEM_MAX;
  assert.ok(cut.every((c) => c.text.length <= 20));
  assert.ok(cut.some((c) => c.truncated));

  const prompt = compileAgentPrompt(coder, null, { messages: [], outputs: [], tools: false, docket: forCoder });
  assert.match(prompt.text, /## Context from the docket/);
  assert.match(prompt.text, /### src\/retry\.ts\nfile · src\/retry\.ts/);
  assert.match(prompt.text, /Prefer pnpm over npm/);

  removeContext(note.id, dir);
  assert.equal(listContext(dir).length, 1);
  assert.equal(verify(dir).ok, true);
});

test("a run records the docket it was given, and the prompt carries skills in their own section", async () => {
  const dir = repo();
  const skill = await addContext("skill:fix-flaky-test", dir, { agents: ["coder"] });
  await addContext("README.md", dir, { agents: ["coder"] });
  assert.equal(skill.kind, "skill");
  const r = await runDelegation("coder", "Make the retry test reliable.", { cwd: dir }).finished;
  assert.equal(r.ok, true, r.error ?? "");
  const start = readLedger(dir).filter((e) => e.type === "delegate_start").pop()!;
  assert.equal((start.data.context as string[]).length, 2);

  const items = contextFor("coder", dir);
  const prompt = compileAgentPrompt(findAgent("coder", dir)!, null, { messages: [], outputs: [], tools: false, docket: items });
  assert.match(prompt.text, /## Your skills[\s\S]*### fix-flaky-test[\s\S]*Run the test ten times/);
  assert.ok(prompt.sections.includes("skills:1"));
  assert.ok(prompt.sections.includes("docket:1"));
});

test("skills come from Reflex and the CLIs' folders, and a waiting workflow is approved through Reflex", async () => {
  const dir = repo();
  const ready = readySkills(dir);
  assert.deepEqual(ready.map((s) => `${s.name}:${s.source}`).sort(), ["fix-flaky-test:reflex", "write-changelog:claude"]);
  const approved = approveWorkflow("map-callers", dir);
  assert.equal(approved.source, "reflex");
  assert.match(approved.description, /approved by the stub/);
  const it = await addContext("skill:map-callers", dir, { agents: ["reviewer"] });
  assert.equal(it.title, "map-callers");
});

test("GitHub through gh: status, issues as context, and a pull request with the ledger's account", async () => {
  const dir = repo();
  resetGithubStatus();
  const s = githubStatus(dir);
  assert.equal(s.signedIn, true);
  assert.equal(s.account, "demo-dev");
  assert.equal(s.repo, "acme/orbit");
  assert.equal(listIssues(dir)[0].number, 42);

  const issue = await addContext("#42", dir, { agents: ["coder"] });
  assert.equal(issue.kind, "issue");
  assert.match(issue.title, /#42 fetchWithRetry resets the backoff/);
  const text = contextFor("coder", dir).find((c) => c.id === issue.id)!.text;
  assert.match(text, /Comment by maria/);

  process.env.STUB_GH_LOGIN = "none";
  resetGithubStatus();
  assert.equal(githubStatus(dir).signedIn, false);
  assert.match(githubStatus(dir).fix ?? "", /gh auth login/);
  delete process.env.STUB_GH_LOGIN;
  resetGithubStatus();

  // A pull request: the branch is pushed to a real (bare, local) remote.
  const remote = mkdtempSync(path.join(SCRATCH, "remote-"));
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  await runDelegation("coder", "Fix the backoff reset.", { cwd: dir }).finished;
  const log = path.join(SCRATCH, "prs.jsonl");
  process.env.STUB_GH_LOG = log;
  const url = openPullRequest("coder", dir, { base: "main" });
  delete process.env.STUB_GH_LOG;
  assert.equal(url, "https://github.com/acme/orbit/pull/7");
  const pr = JSON.parse(readFileSync(log, "utf8").trim());
  assert.equal(pr.head, "ceo/coder");
  assert.match(pr.body, /\| Fix the backoff reset\. \| codex \| gpt-5-codex \|/);
  assert.match(provenanceBody("coder", dir), /1 run, \$/);
  assert.ok(execFileSync("git", ["branch", "--list"], { cwd: remote, encoding: "utf8" }).includes("ceo/coder"));
  assert.equal(readLedger(dir).filter((e) => e.type === "note" && e.data.kind === "pr").length, 1);
});

test("Hugging Face cards and papers, with no token and no network", async () => {
  const dir = repo();
  resetHfStatus();
  assert.equal((await hfStatus()).token, false);
  const card = await hfCard("model", "acme/tiny-retry");
  assert.match(card.text, /pipeline text-generation · library transformers · 12,345 downloads · 7 likes/);
  assert.match(card.text, /A small model that writes retry loops/);
  assert.doesNotMatch(card.text, /license: mit/);
  assert.match((await hfPaper("2401.00001")).text, /Authors: A\. Author, B\. Author[\s\S]*resetting backoff early/);

  const model = await addContext("hf:acme/tiny-retry", dir, { agents: ["reviewer"] });
  const data = await addContext("hf:datasets/acme/flaky-runs", dir);
  const paper = await addContext("paper:2401.00001", dir, { agents: ["reviewer"] });
  assert.deepEqual([model.kind, data.kind, paper.kind], ["model", "dataset", "paper"]);
  assert.match(tokenLabel(model.chars), /^\d/);
  await assert.rejects(addContext("hf:acme/missing", dir), /Not found on the Hub/);

  write(path.join(HUB, "acme", "tiny-retry", "raw", "main", "README.md"), "# tiny-retry\n\nVersion two.\n");
  await refreshContext(model.id, dir);
  assert.match(contextFor("reviewer", dir).find((c) => c.id === model.id)!.text, /Version two/);
});

test("alerts: settings per person, events gate, and each channel reports what happened", async () => {
  const c = readAlerts();
  assert.equal(c.bell, true);
  assert.equal(c.events.done, false);
  assert.throws(() => writeAlerts({ slack: "http://not-https" }), /https URL/);

  const got: Array<{ url: string; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      got.push({ url: req.url ?? "", body });
      res.writeHead(req.url === "/fail" ? 500 : 200).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const notifyLog = path.join(SCRATCH, "notify.log");
  const notifier = path.join(SCRATCH, "stub-notify");
  write(notifier, `#!/bin/sh\necho "$1|$2" >> "${notifyLog}"\n`);
  chmodSync(notifier, 0o755);
  process.env.CEO_NOTIFY_BIN = notifier;
  try {
    writeAlerts({ webhook: `http://127.0.0.1:${port}/hook`, desktop: true });
    let rang = 0;
    const alert = { kind: "failed" as const, title: "coder failed", body: "codex exited 1", workspace: "/tmp/orbit" };
    const res = await sendAlert(alert, { bell: () => rang++ });
    assert.deepEqual(res.map((r) => `${r.channel}:${r.ok}`), ["bell:true", "desktop:true", "webhook:true"]);
    assert.equal(rang, 1);
    assert.match(readFileSync(notifyLog, "utf8"), /coder failed · orbit\|codex exited 1/);
    assert.equal(JSON.parse(got[0].body).kind, "failed");

    // A finished run is off by default, unless forced, as a test is.
    assert.deepEqual(await sendAlert({ ...alert, kind: "done" }, { bell: () => rang++ }), []);
    assert.equal((await sendAlert({ ...alert, kind: "done" }, { bell: () => rang++, force: true })).length, 3);

    writeAlerts({ webhook: `http://127.0.0.1:${port}/fail` });
    const failed = await sendAlert(alert, { bell: () => {} });
    assert.equal(failed.find((r) => r.channel === "webhook")?.ok, false);
  } finally {
    delete process.env.CEO_NOTIFY_BIN;
    server.close();
  }
});

test("the chief adds context from a chat and gives it to agents through the org server", async () => {
  const dir = repo();
  const chief = ensureChief(dir).agent;
  const client = new Client({ name: "test", version: "0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [COLLAB_ENTRY, "--agent", chief.name, "--root", dir], env: process.env as Record<string, string> }));
    const text = (r: unknown) => String(((r as { content?: Array<{ text: string }> }).content ?? [])[0]?.text ?? "");
    assert.match(text(await client.callTool({ name: "org_docket", arguments: {} })), /The docket is empty/);
    assert.match(text(await client.callTool({ name: "org_context", arguments: { source: "#42", agents: ["coder", "reviewer"] } })), /#42 fetchWithRetry .* Held by coder, reviewer\./);
    assert.match(text(await client.callTool({ name: "org_give", arguments: { item: "#42", agent: "reviewer", take: true } })), /reviewer no longer holds #42/);
    assert.match(text(await client.callTool({ name: "org_docket", arguments: {} })), /held by coder/);
  } finally {
    await client.close().catch(() => {});
  }
});

test.after(() => rmSync(SCRATCH, { recursive: true, force: true }));
