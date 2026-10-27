/**
 * The collaboration surface, against a real ledger in a temp directory, and
 * the `org` MCP server end to end over stdio with the SDK client. No model
 * is called; the agent's side is played by the test.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { handoff, messages, messagesFor, orgContext, postMessage, teammateOutputs, YOU } from "./collab.js";
import { compileAgentPrompt } from "./compile.js";
import { begin, end } from "./delegation.js";
import { initLedger, readLedger, verify } from "./ledger.js";
import { findAgent, hire } from "./roster.js";
import { listTasks } from "./tasks.js";
import { claude, codex } from "./providers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLLAB_ENTRY = path.resolve(HERE, "..", "mcp", "collab-index.js");
const TOOLS = path.resolve(HERE, "..", "..", "tools");

// org_ask on an idle teammate starts a real run, through the stubs.
process.env.CEO_CLAUDE_BIN = path.join(TOOLS, "stub-claude");
process.env.CEO_CODEX_BIN = path.join(TOOLS, "stub-codex");
process.env.CEO_GEMINI_BIN = path.join(TOOLS, "stub-gemini");
process.env.CLAUDE_CODE_OAUTH_TOKEN = "stub-token";
process.env.STUB_CODEX_LOGIN = "chatgpt";
process.env.STUB_DELAY_MS = "20";
// Belt and braces: a test must never reach a real agent CLI.
process.env.CEO_REQUIRE_STUBS = "1";

function org(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ceo-collab-"));
  initLedger(dir);
  hire({ name: "scout", role: "Survey the codebase and answer questions about it.", budgetUsd: 1, autonomy: "observe" }, dir);
  hire({ name: "coder", role: "Implement what the queue asks for.", budgetUsd: 2, autonomy: "execute" }, dir);
  return dir;
}

test("notes are ledger events with an author; an agent sees notes for it or for everyone, not its own", () => {
  const dir = org();
  try {
    postMessage({ from: "scout", to: "coder", text: "parse() has three callers; the retry one is the flaky path." }, dir);
    postMessage({ from: YOU, to: "*", text: "Ship by Friday." }, dir);
    postMessage({ from: "coder", to: "scout", text: "thanks" }, dir);
    assert.throws(() => postMessage({ from: "scout", to: "nobody", text: "hi there" }, dir), /No agent named "nobody"/);
    assert.throws(() => postMessage({ from: "scout", to: YOU, text: "hi there" }, dir), /reads the board directly/);

    const forCoder = messagesFor("coder", dir).map((m) => m.from);
    assert.deepEqual(forCoder, [YOU, "scout"]);
    const forScout = messagesFor("scout", dir).map((m) => m.from);
    assert.deepEqual(forScout, ["coder", YOU]);
    assert.equal(messages(dir).length, 3);
    const note = readLedger(dir).filter((e) => e.type === "note" && e.data.kind === "message")[0];
    assert.equal(note.agent, "scout");
    assert.equal(verify(dir).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a handoff queues a task for the teammate with the requester recorded, never for everyone", () => {
  const dir = org();
  try {
    const t = handoff({ from: "scout", to: "coder", title: "fix the flaky retry path in client.ts", priority: "high" }, dir);
    assert.equal(t.assignee, "coder");
    assert.equal(t.requestedBy, "scout");
    assert.equal(t.priority, "high");
    assert.equal(listTasks(dir)[0].requestedBy, "scout");
    assert.throws(() => handoff({ from: "scout", to: "*", title: "everyone do this" }, dir), /one named teammate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("teammates' latest outputs and notes reach the next prompt as a From the org section", () => {
  const dir = org();
  try {
    const h = begin("scout", "map the callers", dir);
    end(h, "parse() is called from client.ts:41, retry.ts:12 and cli.ts:88.", { inputTokens: 10, outputTokens: 5, costUsd: 0.001, durationMs: 100 }, dir);
    postMessage({ from: "scout", to: "coder", text: "start with retry.ts" }, dir);

    const outs = teammateOutputs("coder", dir);
    assert.equal(outs.length, 1);
    assert.equal(outs[0].agent, "scout");
    assert.match(outs[0].excerpt, /client\.ts:41/);
    assert.equal(teammateOutputs("scout", dir).length, 0, "an agent's own output is not a teammate's");

    const ctx = orgContext("coder", dir);
    assert.equal(ctx.messages.length, 1);
    assert.equal(ctx.lastRunAt, null);
    const prompt = compileAgentPrompt(findAgent("coder", dir)!, null, { ...ctx, tools: true }).text;
    assert.match(prompt, /## From the org/);
    assert.match(prompt, /- scout: start with retry\.ts/);
    assert.match(prompt, /### scout, on "map the callers"/);
    assert.match(prompt, /## Working with the org/);
    assert.match(prompt, /org_handoff/);
    // Order: the org's context before the level, the level before the rails.
    assert.ok(prompt.indexOf("## From the org") < prompt.indexOf("## What you may do"));

    // Only notes since the agent's last run count as new; older ones are capped.
    const h2 = begin("coder", "do a thing", dir);
    end(h2, "done", { inputTokens: 1, outputTokens: 1, costUsd: 0.0001, durationMs: 10 }, dir);
    postMessage({ from: "scout", to: "coder", text: "and then cli.ts" }, dir);
    const ctx2 = orgContext("coder", dir);
    assert.equal(ctx2.messages[0].text, "and then cli.ts");
    assert.ok(ctx2.lastRunAt !== null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the providers wire the org server in: an allowlist and --mcp-config on claude, config overrides on codex", () => {
  const collab = { name: "org", command: "/usr/bin/node", args: ["/x/collab-index.js", "--agent", "scout", "--root", "/r"], tools: ["org_post", "org_handoff"] as const };
  const c = claude.plan({ task: "t", systemPrompt: "s", model: "m", autonomy: "observe", agentTools: [], collab });
  assert.ok(c.args.includes("mcp__org__org_post") && c.args.includes("mcp__org__org_handoff"));
  const cfg = JSON.parse(c.args[c.args.indexOf("--mcp-config") + 1]);
  assert.equal(cfg.mcpServers.org.command, "/usr/bin/node");
  assert.ok(c.args.includes("--strict-mcp-config"));
  assert.ok(c.enforcement.includes("org tools (2)"));

  const x = codex.plan({ task: "t", systemPrompt: "s", model: "m", autonomy: "observe", agentTools: [], collab });
  assert.ok(x.args.some((a) => a === 'mcp_servers.org.command="/usr/bin/node"'));
  assert.ok(x.args.some((a) => a.startsWith("mcp_servers.org.args=[") && a.includes('"--agent", "scout"')));
  assert.ok(x.enforcement.includes("org tools (2)"));

  const none = claude.plan({ task: "t", systemPrompt: "s", model: "m", autonomy: "observe", agentTools: [] });
  assert.ok(!none.args.includes("--mcp-config"));
});

test("the org MCP server: scoped to the agent, posts and hands off through the ledger, exposes nothing that pays", async () => {
  const dir = org();
  const client = new Client({ name: "test", version: "0" });
  try {
    const transport = new StdioClientTransport({ command: process.execPath, args: [COLLAB_ENTRY, "--agent", "scout", "--root", dir, "--delegation", "abc123"], env: process.env as Record<string, string> });
    await client.connect(transport);

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["org_ask", "org_board", "org_handoff", "org_mission", "org_outputs", "org_post", "org_read_output", "org_roster", "org_running", "org_trace"]);

    const roster = await client.callTool({ name: "org_roster", arguments: {} });
    assert.match(String((roster.content as Array<{ text: string }>)[0].text), /scout \(you\)/);

    const posted = await client.callTool({ name: "org_post", arguments: { to: "coder", text: "retry.ts first" } });
    assert.match(String((posted.content as Array<{ text: string }>)[0].text), /Posted to coder/);
    const m = messages(dir)[0];
    assert.equal(m.from, "scout");
    assert.equal(m.delegationId, "abc123");

    const handed = await client.callTool({ name: "org_handoff", arguments: { agent: "coder", title: "fix the flaky retry path", priority: "high" } });
    assert.match(String((handed.content as Array<{ text: string }>)[0].text), /Queued .* for coder/);
    assert.equal(listTasks(dir)[0].requestedBy, "scout");

    const bad = await client.callTool({ name: "org_handoff", arguments: { agent: "nobody", title: "anything at all" } });
    assert.equal(bad.isError, true);

    assert.equal(verify(dir).ok, true);
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("org_ask on an idle teammate starts a run for them one level deep, returns the answer, and records the parent", async () => {
  const dir = org();
  const client = new Client({ name: "test", version: "0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [COLLAB_ENTRY, "--agent", "coder", "--root", dir, "--delegation", "parent1"], env: process.env as Record<string, string> }));
    const r = await client.callTool({ name: "org_ask", arguments: { agent: "scout", question: "where is parse() called from?" } });
    const textOut = String((r.content as Array<{ text: string }>)[0].text);
    assert.equal(r.isError ?? false, false, textOut);
    assert.match(textOut, /^scout replied: /);
    assert.match(textOut, /Done: coder asks/);

    const entries = readLedger(dir);
    const ask = entries.find((e) => e.type === "note" && e.data.kind === "message" && e.data.askId)!;
    assert.equal(ask.data.from, "coder");
    const child = entries.find((e) => e.type === "delegate_start" && e.agent === "scout")!;
    assert.equal(child.data.parent, "parent1");
    assert.equal(child.data.depth, 1);
    assert.ok(entries.some((e) => e.type === "delegate_end" && e.agent === "scout"), "the child's cost is the scout's");

    const self = await client.callTool({ name: "org_ask", arguments: { agent: "coder", question: "what about me?" } });
    assert.equal(self.isError, true);
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an asked agent's server refuses to ask onward, and org_running / org_trace read the traces", async () => {
  const dir = org();
  const client = new Client({ name: "test", version: "0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [COLLAB_ENTRY, "--agent", "scout", "--root", dir, "--depth", "1"], env: process.env as Record<string, string> }));
    const r = await client.callTool({ name: "org_ask", arguments: { agent: "coder", question: "and you?" } });
    assert.equal(r.isError, true);
    assert.match(String((r.content as Array<{ text: string }>)[0].text), /answer it with org_post/);

    const nobody = await client.callTool({ name: "org_running", arguments: {} });
    assert.match(String((nobody.content as Array<{ text: string }>)[0].text), /Nobody else is running/);

    // A finished run leaves a trace org_trace can read.
    const { runDelegation } = await import("./runner.js");
    await runDelegation("coder", "add retries", { cwd: dir }).finished;
    const t = await client.callTool({ name: "org_trace", arguments: { agent: "coder" } });
    const out = String((t.content as Array<{ text: string }>)[0].text);
    assert.match(out, /coder · finished · turn 1/);
    assert.match(out, /Done: add retries/);
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
