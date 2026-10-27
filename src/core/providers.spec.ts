/**
 * Provider specs, pure: how autonomy becomes a CLI control on each, and how
 * each CLI's stdout becomes run events and cost. No processes are spawned.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { claude, codex, codexSandboxFor, gemini, geminiModeFor, inferProvider, newParseState, nextProvider, providerFor, tomlString } from "./providers.js";
import { estimateCostUsd } from "./pricing.js";

const PLAN = { task: "-list the callers", systemPrompt: 'You are "r".\n\n## Your job\n\nRead.', model: "m", agentTools: [] as string[] };

test("claude: the allowlist narrows with the level and is passed as --allowed-tools", () => {
  const observe = claude.plan({ ...PLAN, autonomy: "observe" });
  const execute = claude.plan({ ...PLAN, autonomy: "execute" });
  assert.deepEqual(observe.enforcement, ["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
  assert.ok(execute.enforcement.includes("Write"));
  assert.ok(!observe.enforcement.includes("Write"));
  const i = observe.args.indexOf("--allowed-tools");
  assert.deepEqual(observe.args.slice(i + 1, i + 6), observe.enforcement);
  assert.equal(observe.stdin, null);
});

test("codex: read-only below execute, workspace-write at and above, approvals never, task on stdin", () => {
  assert.equal(codexSandboxFor("observe"), "read-only");
  assert.equal(codexSandboxFor("propose"), "read-only");
  assert.equal(codexSandboxFor("execute"), "workspace-write");
  assert.equal(codexSandboxFor("autonomous"), "workspace-write");

  const plan = codex.plan({ ...PLAN, autonomy: "propose" });
  assert.equal(plan.args[0], "exec");
  assert.ok(plan.args.includes("--json"));
  assert.equal(plan.args[plan.args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(plan.args.includes('approval_policy="never"'));
  // The task rides on stdin, so a task beginning with "-" is never a flag.
  assert.equal(plan.args[plan.args.length - 1], "-");
  assert.equal(plan.stdin, PLAN.task);
  assert.deepEqual(plan.enforcement, ["sandbox read-only", "approvals never"]);

  // The compiled prompt rides in as developer_instructions, TOML-encoded.
  const dev = plan.args.find((a) => a.startsWith("developer_instructions="))!;
  assert.equal(dev, `developer_instructions=${tomlString(PLAN.systemPrompt)}`);
  assert.equal(JSON.parse(dev.slice("developer_instructions=".length)), PLAN.systemPrompt);
});

test("codex: items become tool and text events, a sandboxed command becomes a denial, usage settles tokens", () => {
  const st = newParseState();
  const ev = (o: unknown) => codex.parse(o as Record<string, unknown>, st);

  assert.deepEqual(ev({ type: "thread.started", thread_id: "t" }), []);
  const started = ev({ type: "item.started", item: { id: "i1", type: "command_execution", command: "bash -lc 'ls'" } });
  assert.equal(started[0].type, "tool");
  // The same item completing does not announce the command twice.
  const done = ev({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "bash -lc 'ls'", aggregated_output: "a\n", exit_code: 0, status: "completed" } });
  assert.deepEqual(done, []);

  const denied = ev({ type: "item.completed", item: { id: "i2", type: "command_execution", command: "bash -lc 'rm x'", aggregated_output: "Command denied by sandbox: rm", exit_code: 1, status: "failed" } });
  assert.equal(denied.find((e) => e.type === "denied")?.type, "denied");
  assert.equal(st.denials.length, 1);

  ev({ type: "item.completed", item: { id: "m", type: "agent_message", text: "Found 3 callers." } });
  assert.equal(st.text, "Found 3 callers.");

  assert.deepEqual(ev({ type: "turn.completed", usage: { input_tokens: 3000, cached_input_tokens: 600, output_tokens: 150 } }), []);
  assert.equal(st.settledInput, 3000);
  assert.equal(st.settledOutput, 150);
  assert.equal(st.streamedCachedInput, 600);
  // codex never reports dollars: the cost must be computed, and marked.
  assert.equal(st.settledCostUsd, null);
});

test("claude: result settles cost and surfaces denials; streamed usage is kept for a run that never settles", () => {
  const st = newParseState();
  const ev = (o: unknown) => claude.parse(o as Record<string, unknown>, st);
  ev({ type: "assistant", message: { usage: { input_tokens: 1000, output_tokens: 50 }, content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Read", input: { file_path: "/a" } }] } });
  assert.equal(st.streamedInput, 1000);
  assert.equal(st.settledCostUsd, null);
  const out = ev({ type: "result", total_cost_usd: 0.0123, usage: { input_tokens: 1000, output_tokens: 50 }, result: "done", permission_denials: [{ tool_name: "Write" }] });
  assert.equal(st.settledCostUsd, 0.0123);
  assert.deepEqual(st.denials, ["Write"]);
  assert.ok(out.some((e) => e.type === "denied"));
});

test("pricing: cached input is a tenth of the input rate; unknown gpt models fall back to gpt-5 rates", () => {
  const full = estimateCostUsd("gpt-5-codex", 1_000_000, 0);
  const cached = estimateCostUsd("gpt-5-codex", 1_000_000, 0, 1_000_000);
  assert.equal(full, 1.25);
  assert.equal(cached, 0.125);
  assert.equal(estimateCostUsd("gpt-6-astra", 1_000_000, 0), 1.25);
  assert.equal(estimateCostUsd("claude-sonnet-5-20261001", 1_000_000, 0), 3);
});

test("provider lookup: rosters without a provider are read from the model", () => {
  assert.equal(inferProvider("gpt-5-codex"), "codex");
  assert.equal(inferProvider("claude-sonnet-5"), "claude");
  assert.equal(inferProvider(undefined), "claude");
  assert.equal(providerFor("codex").id, "codex");
  assert.equal(providerFor("nonsense").id, "claude");
});

test("gemini: plan mode below execute, accept-edits at and above, the brief rides ahead of the task, never skip-permissions", () => {
  assert.equal(geminiModeFor("observe"), "plan");
  assert.equal(geminiModeFor("propose"), "plan");
  assert.equal(geminiModeFor("execute"), "accept-edits");
  assert.equal(geminiModeFor("autonomous"), "accept-edits");

  const plan = gemini.plan({ ...PLAN, model: "gemini", autonomy: "observe" });
  assert.equal(plan.args[0], "-p");
  assert.ok(plan.args[1].startsWith(PLAN.systemPrompt), "the compiled prompt leads");
  assert.ok(plan.args[1].endsWith(PLAN.task), "the task follows");
  assert.equal(plan.args[plan.args.indexOf("--output-format") + 1], "stream-json");
  assert.equal(plan.args[plan.args.indexOf("--mode") + 1], "plan");
  assert.ok(!plan.args.includes("--model"), "the bare word gemini means the CLI's own default model");
  assert.ok(!plan.args.includes("--dangerously-skip-permissions"));
  assert.deepEqual(plan.enforcement, ["mode plan"]);

  const exec = gemini.plan({ ...PLAN, model: "gemini-2.5-pro", autonomy: "execute" });
  assert.equal(exec.args[exec.args.indexOf("--model") + 1], "gemini-2.5-pro");
  assert.deepEqual(exec.enforcement, ["mode accept-edits", "commands need approval"]);
});

test("gemini: steps become tool and text events, a refused tool becomes a denial, the result settles tokens without dollars", () => {
  const st = newParseState();
  const ev = (o: unknown) => gemini.parse(o as Record<string, unknown>, st);

  assert.deepEqual(ev({ event: "init", cwd: "/x", tools: [], permission_mode: "plan" }), []);
  const started = ev({ event: "step_update", step: { step_id: "s1", step_type: "tool", state: "ACTIVE", tool_info: { name: "read_file", parameters: { path: "src/a.ts" } } } });
  assert.equal(started[0].type, "tool");
  assert.deepEqual(ev({ event: "step_update", step: { step_id: "s1", step_type: "tool", state: "DONE", tool_info: { name: "read_file", parameters: { path: "src/a.ts" }, output: "ok" } } }), []);

  const denied = ev({ event: "step_update", step: { step_id: "s2", step_type: "tool", state: "DONE", tool_info: { name: "run_command", parameters: { command: "rm x" }, error: { code: "PERMISSION_DENIED", message: "permission denied: requires approval" } } } });
  assert.ok(denied.some((e) => e.type === "denied"));
  assert.equal(st.denials.length, 1);

  ev({ event: "step_update", step: { step_type: "agent_response", state: "DONE", text_delta: "Found it." } });
  assert.equal(st.text, "Found it.");

  ev({ event: "result", result: { status: "SUCCESS", response: "Found it. Done.", usage: { input_tokens: 2000, output_tokens: 100, thinking_tokens: 40, cache_read_tokens: 500 } } });
  assert.equal(st.settledInput, 2500);
  assert.equal(st.settledOutput, 140);
  assert.equal(st.streamedCachedInput, 500);
  assert.equal(st.settledCostUsd, null);
  assert.equal(st.text, "Found it. Done.");

  const st2 = newParseState();
  gemini.parse({ event: "result", result: { status: "ERROR", error: "authentication failed or timed out", usage: {} } }, st2);
  assert.match(st2.error ?? "", /authentication/);
});

test("provider cycle and inference cover gemini", () => {
  assert.equal(nextProvider("claude"), "codex");
  assert.equal(nextProvider("codex"), "gemini");
  assert.equal(nextProvider("gemini"), "claude");
  assert.equal(inferProvider("gemini-2.5-flash"), "gemini");
  assert.equal(providerFor("gemini").headless, "agy -p");
  assert.equal(estimateCostUsd("gemini-2.5-flash", 1_000_000, 0), 0.3);
  assert.equal(estimateCostUsd("gemini", 1_000_000, 0), 1.25);
});
