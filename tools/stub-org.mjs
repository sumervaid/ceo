// Shared by the three stub CLIs: find the org MCP server a run was given,
// talk to it over stdio, and play a script of org calls during the run.
//
// STUB_SCRIPT names a JSON file of entries:
//   { "agent": "coder", "match": "retry", "on": "first", "after": 2,
//     "calls": [{ "tool": "org_post", "args": { "to": "reviewer", "text": "..." } }],
//     "say": "optional text the agent says after the calls" }
// An entry with "steps": ["line", ...] and "done": "line" gives the agent
// words for each step and for the end, in place of the stub's filler.
// "agent" may hold * as a wildcard, so "fixer-*" covers a whole swarm.
// An entry runs when the run's agent and prompt match, at step `after` of a
// first run or of a resumed one (`on`: "first", the default, or "resume").
// The calls reach the real server, so every note is a real ledger event.

import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import * as path from "node:path";

/** The org server's command, args and agent name, from however the provider passes it. */
export function orgServer(provider, args) {
  let cfg = null;
  try {
    if (provider === "claude") {
      const i = args.indexOf("--mcp-config");
      if (i >= 0) cfg = Object.values(JSON.parse(args[i + 1]).mcpServers ?? {})[0] ?? null;
    } else if (provider === "codex") {
      const value = (key) => {
        const hit = args.find((a, i) => args[i - 1] === "-c" && a.startsWith(`mcp_servers.org.${key}=`));
        return hit ? JSON.parse(hit.slice(hit.indexOf("=") + 1)) : null;
      };
      const command = value("command");
      if (command) cfg = { command, args: value("args") ?? [] };
    } else {
      const file = path.join(process.cwd(), ".agents", "mcp_config.json");
      if (existsSync(file)) cfg = JSON.parse(readFileSync(file, "utf8")).mcpServers?.org ?? null;
    }
  } catch {
    cfg = null;
  }
  if (!cfg) return null;
  const a = cfg.args ?? [];
  const at = a.indexOf("--agent");
  return { command: cfg.command, args: a, agent: at >= 0 ? a[at + 1] : null };
}

/** A minimal MCP client: initialize, then tools/call, one JSON-RPC message per line. */
export async function connect(cfg) {
  const child = spawn(cfg.command, cfg.args ?? [], { stdio: ["pipe", "pipe", "ignore"], env: process.env });
  let buf = "";
  let id = 0;
  const pending = new Map();
  child.stdout.on("data", (c) => {
    buf += c;
    let n;
    while ((n = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, n).trim();
      buf = buf.slice(n + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined && pending.has(m.id)) {
          pending.get(m.id)(m);
          pending.delete(m.id);
        }
      } catch {
        /* not a protocol line */
      }
    }
  });
  const request = (method, params) =>
    new Promise((res) => {
      const me = ++id;
      pending.set(me, res);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: me, method, params }) + "\n");
    });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stub", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return {
    call: async (name, a) => {
      const r = await request("tools/call", { name, arguments: a });
      return (r.result?.content ?? []).map((c) => c.text).join("\n") || r.error?.message || "";
    },
    close: () => child.kill(),
  };
}

/**
 * The script for this run. `atStep(i)` plays the entries due at step i and
 * reports each call and line through the provider's own emitters.
 */
/** An entry's agent: an exact name, or a pattern with * for any run of characters. */
function agentMatches(pattern, name) {
  if (!name) return false;
  if (!pattern.includes("*")) return pattern === name;
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(name);
}

export function script({ provider, args, prompt, resumed, onCall, onSay }) {
  const file = process.env.STUB_SCRIPT;
  if (!file) return { atStep: async () => {}, close: () => {}, line: () => null, done: null };
  const server = orgServer(provider, args);
  let entries = [];
  try {
    const said = String(prompt ?? "").toLowerCase();
    entries = JSON.parse(readFileSync(file, "utf8")).filter(
      (e) =>
        (!e.agent || agentMatches(e.agent, server?.agent)) &&
        (!e.match || said.includes(String(e.match).toLowerCase())) &&
        (e.on ?? "first") === (resumed ? "resume" : "first"),
    );
  } catch {
    entries = [];
  }
  let client = null;
  const voice = entries.find((e) => Array.isArray(e.steps) || e.done);
  return {
    line: (i) => voice?.steps?.[i - 1] ?? null,
    done: voice?.done ?? null,
    atStep: async (i) => {
      for (const e of entries.filter((x) => (x.after ?? 1) === i)) {
        for (const c of e.calls ?? []) {
          if (!server) break;
          client ??= await connect(server);
          const result = await client.call(c.tool, c.args ?? {});
          onCall(c.tool, c.args ?? {}, result);
        }
        if (e.say) onSay(e.say);
      }
    },
    close: () => client?.close(),
  };
}
