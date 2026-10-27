/**
 * The chat with the chief of staff, against a real ledger in a temp
 * directory. The chief's runs go through the stub CLIs, and a scripted stub
 * calls the real org MCP server over stdio, so the path from a message to
 * a hire is the one a real run takes. No model is called.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  allowanceOf,
  chatPrompt,
  CHIEF_NAME,
  conversation,
  ensureChief,
  newConversation,
  resumableSession,
  sinceLastReply,
  startableAfter,
  staffingPrompt,
} from "./chat.js";
import { compileAgentPrompt } from "./compile.js";
import { initLedger, readLedger, verify } from "./ledger.js";
import { rosterPath } from "./paths.js";
import { budgetCheck, findAgent, findChief, fire, hire, readRoster, reconfigure, setAutonomy, setBudget } from "./roster.js";
import { describeRunPolicy, enforcementFor, runDelegation } from "./runner.js";
import { addTask, listTasks } from "./tasks.js";
import { paragraphs, transcriptRows, rowWidth } from "../tui/chat.js";

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
// A test must never reach a real agent CLI.
process.env.CEO_REQUIRE_STUBS = "1";

function org(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ceo-chat-"));
  initLedger(dir);
  hire({ name: "coder", role: "Implement what the queue asks for.", provider: "codex", budgetUsd: 2, autonomy: "execute" }, dir);
  return dir;
}

function text(r: unknown): string {
  return String(((r as { content?: Array<{ text: string }> }).content ?? [])[0]?.text ?? "");
}

async function chiefClient(dir: string, chief: string, delegation: string, env: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [COLLAB_ENTRY, "--agent", chief, "--root", dir, "--delegation", delegation],
    env: { ...(process.env as Record<string, string>), ...env },
  });
  await client.connect(transport);
  return client;
}

test("the chief of staff is hired once, flagged in the ledger, and survives a roster rebuild", () => {
  const dir = org();
  try {
    const first = ensureChief(dir);
    assert.equal(first.hired, true);
    assert.equal(first.agent.name, CHIEF_NAME);
    assert.equal(first.agent.chief, true);
    assert.equal(first.agent.provider, "claude");
    assert.equal(first.agent.autonomy, "execute");

    const again = ensureChief(dir);
    assert.equal(again.hired, false);
    assert.equal(readRoster(dir).agents.filter((a) => a.chief).length, 1);
    assert.throws(() => hire({ name: "deputy", role: "A second chief of staff.", chief: true }, dir), /already has a chief of staff: chief/);

    unlinkSync(rosterPath(dir));
    assert.equal(findChief(dir)?.name, CHIEF_NAME);
    assert.equal(verify(dir).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a chief is named around an agent already called chief", () => {
  const dir = org();
  try {
    hire({ name: "chief", role: "An ordinary agent that took the name first." }, dir);
    const { agent } = ensureChief(dir);
    assert.equal(agent.name, "chief-of-staff");
    assert.equal(findAgent("chief", dir)?.chief, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the chief's process is read-only at any level, and the prompt states what the level lets it do to the org", () => {
  const dir = org();
  try {
    const chief = ensureChief(dir).agent;
    assert.deepEqual(enforcementFor(chief), ["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
    assert.match(describeRunPolicy(chief), /chief of staff, hires, budgets and starts work/);

    const compiled = compileAgentPrompt(chief, null, { messages: [], outputs: [], tools: true });
    assert.match(compiled.text, /the chief of staff of a small org/);
    assert.match(compiled.text, /## Running the org/);
    assert.match(compiled.text, /org_hire adds an agent/);
    assert.match(compiled.text, /at most 3 per reply, at levels up to execute/);
    assert.match(compiled.text, /Budgets come from your allowance/);
    assert.match(compiled.text, /When the operator names a provider for a piece of work, use it/);
    assert.match(compiled.text, /Your own replies have no cap/);
    assert.ok(compiled.sections.includes("staffing:execute"));

    assert.match(staffingPrompt("observe"), /At observe, you answer questions/);
    assert.match(staffingPrompt("propose"), /queue work with org_handoff\. The operator starts it/);
    assert.match(staffingPrompt("autonomous"), /fire an idle agent you hired yourself/);

    const ordinary = compileAgentPrompt(findAgent("coder", dir)!, null, { messages: [], outputs: [], tools: true });
    assert.doesNotMatch(ordinary.text, /Running the org/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only the chief's server has the staffing tools, and each one holds to the chief's level, allowance and limit", async () => {
  const dir = org();
  const chief = ensureChief(dir).agent;
  const client = await chiefClient(dir, chief.name, "c0ffee", { CEO_CHIEF_MAX_HIRES: "2" });
  const plain = new Client({ name: "test", version: "0" });
  try {
    await plain.connect(new StdioClientTransport({ command: process.execPath, args: [COLLAB_ENTRY, "--agent", "coder", "--root", dir], env: process.env as Record<string, string> }));
    const plainTools = (await plain.listTools()).tools.map((t) => t.name);
    assert.ok(!plainTools.includes("org_hire"));

    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ["org_providers", "org_hire", "org_budget", "org_delegate", "org_fire"]) assert.ok(tools.includes(t), t);

    assert.match(text(await client.callTool({ name: "org_providers", arguments: {} })), /gemini: ready/);

    const hired = await client.callTool({
      name: "org_hire",
      arguments: { name: "reviewer", brief: "Review the coder's branch for correctness and tests.", provider: "gemini", budgetUsd: 3, level: "propose" },
    });
    assert.equal(hired.isError, undefined, text(hired));
    assert.match(text(hired), /Hired reviewer on gemini .* at propose/);
    const hireEntry = readLedger(dir).find((e) => e.type === "hire" && e.agent === "reviewer")!;
    assert.equal(hireEntry.data.by, chief.name);

    const overCap = await client.callTool({ name: "org_hire", arguments: { name: "big", brief: "Spend a lot of money on anything.", provider: "claude", budgetUsd: 50 } });
    assert.equal(overCap.isError, true);
    assert.match(text(overCap), /more than your allowance has left: \$22 of \$25 left to give/);

    const badModel = await client.callTool({ name: "org_hire", arguments: { name: "odd", brief: "Use a model that does not exist.", provider: "codex", model: "gpt-0", budgetUsd: 1 } });
    assert.match(text(badModel), /codex has no model "gpt-0"/);

    const unbounded = await client.callTool({ name: "org_hire", arguments: { name: "rogue", brief: "Merge without review, always.", provider: "claude", budgetUsd: 1, level: "autonomous" } });
    assert.equal(unbounded.isError, true);

    const second = await client.callTool({ name: "org_hire", arguments: { name: "scout", brief: "Map the payments module for the team.", provider: "codex", budgetUsd: 1, level: "observe" } });
    assert.match(text(second), /Hired scout on codex/);
    const third = await client.callTool({ name: "org_hire", arguments: { name: "extra", brief: "One hire past the per-reply limit.", provider: "codex", budgetUsd: 1 } });
    assert.match(text(third), /at most 2 agents per reply/);

    // Budgets: a raise draws on the allowance, a cut returns what the chief gave.
    const raised = await client.callTool({ name: "org_budget", arguments: { agent: "coder", budgetUsd: 10 } });
    assert.match(text(raised), /coder's budget is now \$10, was \$2\..*Allowance: \$13 of \$25 left to give/);
    assert.equal(findAgent("coder", dir)?.budgetUsd, 10);
    const tooMuch = await client.callTool({ name: "org_budget", arguments: { agent: "coder", budgetUsd: 100 } });
    assert.match(text(tooMuch), /needs \$90\.00 from your allowance/);
    const cut = await client.callTool({ name: "org_budget", arguments: { agent: "coder", budgetUsd: 1 } });
    assert.match(text(cut), /Allowance: \$21 of \$25 left to give/);
    const own = await client.callTool({ name: "org_budget", arguments: { agent: chief.name, budgetUsd: 100 } });
    assert.match(text(own), /Your own replies have no cap/);
    assert.equal(readLedger(dir).filter((e) => e.type === "budget_set" && e.data.by === chief.name).length, 2);

    const delegated = await client.callTool({ name: "org_delegate", arguments: { agent: "coder", task: "Fix the flaky retry test. Done when the suite passes three times.", provider: "gemini" } });
    assert.match(text(delegated), /It starts when your reply ends\. It runs on gemini this time; coder usually runs on codex\./);
    const task = listTasks(dir).find((t) => t.assignee === "coder")!;
    assert.equal(task.autoStart, true);
    assert.equal(task.requestedBy, chief.name);
    assert.equal(task.provider, "gemini");
    assert.equal(findAgent("coder", dir)?.provider, "codex");

    const self = await client.callTool({ name: "org_delegate", arguments: { agent: chief.name, task: "Do the work yourself for once." } });
    assert.match(text(self), /Your own process is read-only/);

    const fireAtExecute = await client.callTool({ name: "org_fire", arguments: { agent: "reviewer", reason: "not needed" } });
    assert.match(text(fireAtExecute), /At execute, the chief of staff cannot fire/);
    setAutonomy(chief.name, "autonomous", dir);
    const fireCoder = await client.callTool({ name: "org_fire", arguments: { agent: "coder", reason: "not needed" } });
    assert.match(text(fireCoder), /was not hired by the chief of staff/);
    const fired = await client.callTool({ name: "org_fire", arguments: { agent: "reviewer", reason: "the review is done" } });
    assert.match(text(fired), /Fired reviewer/);
    assert.equal(readLedger(dir).find((e) => e.type === "fire" && e.agent === "reviewer")!.data.by, chief.name);

    setAutonomy(chief.name, "propose", dir);
    const hireAtPropose = await client.callTool({ name: "org_hire", arguments: { name: "late", brief: "A hire the level forbids now.", provider: "codex", budgetUsd: 1 } });
    assert.match(text(hireAtPropose), /At propose, the chief of staff cannot hire/);
    const delegateAtPropose = await client.callTool({ name: "org_delegate", arguments: { agent: "coder", task: "Something that should wait." } });
    assert.match(text(delegateAtPropose), /Queue it with org_handoff/);
    setAutonomy(chief.name, "observe", dir);
    const handoffAtObserve = await client.callTool({ name: "org_handoff", arguments: { agent: "coder", title: "Something to queue" } });
    assert.match(text(handoffAtObserve), /At observe, the chief of staff answers questions/);

    assert.equal(verify(dir).ok, true);
  } finally {
    await client.close().catch(() => {});
    await plain.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a conversation is read back from the ledger, the second message resumes the first session, and a new conversation starts clean", async () => {
  const dir = org();
  try {
    const chief = ensureChief(dir).agent;
    const first = await runDelegation(chief.name, "Who is on the team?", { cwd: dir, via: "chat" }).finished;
    assert.equal(first.ok, true, first.error ?? "");
    assert.ok(first.sessionId);

    let conv = conversation(chief.name, dir);
    assert.equal(conv.turns.length, 1);
    assert.equal(conv.turns[0].message, "Who is on the team?");
    assert.match(conv.turns[0].reply, /Done: Who is on the team/);
    assert.equal(conv.turns[0].status, "done");
    assert.equal(conv.turns[0].sessionId, first.sessionId);

    const resume = resumableSession(conv, findChief(dir)!);
    assert.equal(resume, first.sessionId);
    const second = await runDelegation(chief.name, "ok", { cwd: dir, via: "chat", resumeSessionId: resume, prompt: chatPrompt("ok", conv, chief, dir) }).finished;
    assert.equal(second.ok, true, second.error ?? "");
    assert.equal(second.sessionId, first.sessionId);
    const start = readLedger(dir).filter((e) => e.type === "delegate_start" && e.agent === chief.name).pop()!;
    assert.equal(start.data.resumed, first.sessionId);
    assert.equal(start.data.via, "chat");

    conv = conversation(chief.name, dir);
    assert.equal(conv.turns.length, 2);
    assert.ok(conv.chiefCostUsd > 0);

    newConversation(chief.name, dir);
    conv = conversation(chief.name, dir);
    assert.equal(conv.turns.length, 0);
    assert.equal(resumableSession(conv, findChief(dir)!), null);
    assert.equal(chatPrompt("hello again", conv, chief, dir), "hello again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("moving the chief to another provider carries the conversation over as a recap, and finished work reaches the next prompt", async () => {
  const dir = org();
  try {
    const chief = ensureChief(dir).agent;
    await runDelegation(chief.name, "Plan the retry fix.", { cwd: dir, via: "chat" }).finished;
    const coderRun = await runDelegation("coder", "Fix the flaky retry test.", { cwd: dir }).finished;
    assert.equal(coderRun.ok, true, coderRun.error ?? "");

    const moved = reconfigure(chief.name, { provider: "codex", model: "gpt-5-codex" }, dir);
    const conv = conversation(chief.name, dir);
    assert.equal(resumableSession(conv, moved), null);
    assert.ok(sinceLastReply(conv, dir).some((l) => /coder finished "Fix the flaky retry test\."/.test(l)));

    const prompt = chatPrompt("How did it go?", conv, moved, dir);
    assert.match(prompt, /This conversation began earlier on claude/);
    assert.match(prompt, /Operator: Plan the retry fix\./);
    assert.match(prompt, /Since your last reply:/);
    assert.match(prompt, /The operator says:\n\nHow did it go\?$/);

    const onCodex = await runDelegation(chief.name, "How did it go?", { cwd: dir, via: "chat", prompt }).finished;
    assert.equal(onCodex.ok, true, onCodex.error ?? "");
    const turns = conversation(chief.name, dir).turns;
    assert.deepEqual(turns.map((t) => t.provider), ["claude", "codex"]);
    assert.equal(turns[0].message, "Plan the retry fix.");
    assert.equal(turns[1].message, "How did it go?");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a message becomes a team: the chief hires on another provider and delegates through the real org server", async () => {
  const dir = org();
  const script = path.join(dir, "chat.json");
  writeFileSync(
    script,
    JSON.stringify([
      {
        match: "review",
        calls: [
          { tool: "org_hire", args: { name: "reviewer", brief: "Review the coder's branch for correctness and tests.", provider: "gemini", budgetUsd: 2, level: "propose" } },
          { tool: "org_delegate", args: { agent: "coder", task: "Fix the flaky retry test. Done when the suite passes three times." } },
          { tool: "org_delegate", args: { agent: "reviewer", task: "Review the retry fix on coder's branch." } },
        ],
        reply: "Coder has the fix on codex. Reviewer is hired on gemini to check it.\n\n- Most it can cost: $4.",
      },
    ]),
  );
  process.env.STUB_CHAT = script;
  try {
    const chief = ensureChief(dir).agent;
    const r = await runDelegation(chief.name, "Fix the retry test and get it reviewed", { cwd: dir, via: "chat" }).finished;
    assert.equal(r.ok, true, r.error ?? "");

    const hireEntry = readLedger(dir).find((e) => e.type === "hire" && e.agent === "reviewer");
    assert.ok(hireEntry, "the stub's org_hire reached the ledger");
    assert.equal(hireEntry!.data.by, chief.name);
    assert.equal(findAgent("reviewer", dir)?.provider, "gemini");

    const conv = conversation(chief.name, dir);
    const turn = conv.turns[0];
    assert.deepEqual(turn.actions.map((a) => `${a.kind}:${a.agent}`), ["hire:reviewer", "delegate:coder", "delegate:reviewer"]);
    assert.match(turn.reply, /Reviewer is hired on gemini/);

    const startable = startableAfter(conv, r.delegationId!, dir).map((t) => t.assignee).sort();
    assert.deepEqual(startable, ["coder", "reviewer"]);

    const rows = transcriptRows({ conv, chief, tasks: listTasks(dir), live: null, running: new Set(), width: 72, now: Date.now(), spinner: "⠋" });
    const flat = rows.map((row) => row.map((s) => s.text).join(""));
    assert.ok(rows.every((row) => rowWidth(row) <= 72));
    assert.ok(flat.some((l) => /^ you +Fix the retry test and get it reviewed/.test(l)));
    assert.ok(flat.some((l) => /\+ hired reviewer on gemini · propose · \$2 budget/.test(l)));
    assert.ok(flat.some((l) => /▸ coder +Fix the flaky retry test/.test(l)));
    assert.ok(flat.some((l) => /• Most it can cost: \$4\./.test(l)));
    assert.ok(flat.some((l) => /\$0\.0061 · claude/.test(l)));
    assert.equal(verify(dir).ok, true);
  } finally {
    delete process.env.STUB_CHAT;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replies wrap as paragraphs with hanging bullets, and a reply in progress says what the chief is doing", () => {
  const lines = paragraphs("**Plan.** Three steps:\n\n- hire a reviewer on gemini for the branch\n- supercalifragilisticexpialidocious", 24);
  assert.deepEqual(lines, ["Plan. Three steps:", "", "• hire a reviewer on", "  gemini for the branch", "• supercalifragilisticex", "  pialidocious"]);

  const chief = { name: "chief", provider: "claude", model: "claude-sonnet-5", chief: true } as unknown as Parameters<typeof transcriptRows>[0]["chief"];
  const now = Date.now();
  const conv = {
    chief: "chief", startSeq: 0, chiefCostUsd: 0, teamCostUsd: 0, teamRuns: 0,
    turns: [{ id: "a1", ts: now - 3000, message: "staff the fix", reply: "", status: "running" as const, provider: "claude" as const, model: "claude-sonnet-5", costUsd: 0, costIsEstimate: false, sessionId: null, actions: [], startSeq: 5, endSeq: null }],
  };
  const live = { status: "running", startedAt: now - 3000, lines: [{ kind: "tool", text: "mcp__org__org_hire" }] } as unknown as Parameters<typeof transcriptRows>[0]["live"];
  const flat = transcriptRows({ conv, chief, tasks: [], live, running: new Set(["chief"]), width: 60, now, spinner: "⠋" }).map((r) => r.map((x) => x.text).join(""));
  assert.ok(flat.some((l) => /^ chief +⠋ hiring · 3s$/.test(l.trimEnd())), flat.join("\n"));
});

test("a stub on any provider plays a script through the real org server, and the notes cross providers in the ledger", async () => {
  const dir = org();
  const script = path.join(dir, "team.json");
  writeFileSync(
    script,
    JSON.stringify([
      { agent: "coder", after: 1, calls: [{ tool: "org_post", args: { to: "scout", text: "Moved the reset. Ready for a look." } }], steps: ["Reading retry.ts."] },
      { agent: "scout", after: 1, calls: [{ tool: "org_post", args: { to: "coder", text: "Two callers: client.ts and sync.ts." } }] },
    ]),
  );
  process.env.STUB_SCRIPT = script;
  try {
    hire({ name: "scout", role: "Survey the codebase and answer questions about it.", provider: "claude", budgetUsd: 1, autonomy: "observe" }, dir);
    const [coder, scout] = await Promise.all([
      runDelegation("coder", "Fix the retry test.", { cwd: dir }).finished,
      runDelegation("scout", "Map the callers.", { cwd: dir }).finished,
    ]);
    assert.equal(coder.ok, true, coder.error ?? "");
    assert.equal(scout.ok, true, scout.error ?? "");
    const notes = readLedger(dir).filter((e) => e.type === "note" && e.data.kind === "message");
    const pairs = notes.map((e) => `${e.data.from}>${e.data.to}`).sort();
    assert.deepEqual(pairs, ["coder>scout", "scout>coder"]);
    assert.equal(findAgent("coder", dir)?.provider, "codex");
    assert.equal(findAgent("scout", dir)?.provider, "claude");
    assert.match(coder.text, /Reading retry\.ts\./);
  } finally {
    delete process.env.STUB_SCRIPT;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the chief's replies have no cap; the allowance counts only what the chief gave, and a firing returns it", async () => {
  const dir = org();
  try {
    const chief = ensureChief(dir).agent;
    assert.equal(chief.budgetUsd, 25);
    // Spend past any cap the chief might have had: the chief still runs.
    setBudget(chief.name, 0.001, dir);
    await runDelegation(chief.name, "First reply.", { cwd: dir, via: "chat" }).finished;
    const again = await runDelegation(chief.name, "Second reply.", { cwd: dir, via: "chat" }).finished;
    assert.equal(again.ok, true, again.error ?? "");
    assert.equal(budgetCheck(chief.name, dir), null);

    setBudget(chief.name, 20, dir);
    hire({ name: "fixer", role: "Fix what the chief hands over.", budgetUsd: 4, by: chief.name }, dir);
    setBudget("coder", 5, dir, chief.name);
    let pool = allowanceOf(findChief(dir)!, dir);
    assert.equal(pool.givenUsd, 4 + 3);
    assert.equal(pool.leftUsd, 13);
    // The operator raising coder resets the base; the chief's share goes.
    setBudget("coder", 8, dir);
    pool = allowanceOf(findChief(dir)!, dir);
    assert.equal(pool.givenUsd, 4);
    fire("fixer", "done", dir);
    assert.equal(allowanceOf(findChief(dir)!, dir).givenUsd, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a task that names a provider runs there, and the agent keeps its own", async () => {
  const dir = org();
  try {
    const t = addTask({ title: "Review the retry fix on gemini.", assignee: "coder", provider: "gemini" }, dir);
    const r = await runDelegation("coder", t.title, { cwd: dir, taskId: t.id }).finished;
    assert.equal(r.ok, true, r.error ?? "");
    const start = readLedger(dir).filter((e) => e.type === "delegate_start" && e.agent === "coder").pop()!;
    assert.equal(start.data.provider, "gemini");
    assert.equal(start.data.model, "gemini");
    assert.equal(start.data.usualProvider, "codex");
    assert.equal(findAgent("coder", dir)?.provider, "codex");
    assert.match(r.text, /plan mode|Done/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
