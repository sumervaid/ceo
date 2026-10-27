/**
 * The `org` MCP server: the collaboration surface a running agent sees.
 *
 * CEO starts one of these for every run, told which agent is running and
 * which org it belongs to. Every tool is scoped to that agent: a note it
 * posts is signed by it, a handoff it queues names it as the requester, and
 * nothing here can touch a budget, a level, a cost record or a task's
 * status. The agent can ask for work and read what others did. It cannot
 * pay for anything, including itself.
 *
 * The tools are deliberately few and named for what they do in the org,
 * so a brief can say "post a note to the reviewer" and the model finds
 * org_post without a tour.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { randomBytes } from "node:crypto";

import { describeMessage, handoff, liveRuns, messages, postMessage, readOutput, replyTo, teammateOutputs, traceFor } from "../core/collab.js";
import { runDelegation } from "../core/runner.js";
import { recentDelegations } from "../core/delegation.js";
import { current as currentMission } from "../core/mission.js";
import { fire, hire, readRoster, setBudget } from "../core/roster.js";
import { policyFor } from "../core/autonomy.js";
import { addTask, TASK_PRIORITIES, type TaskPriority } from "../core/tasks.js";
import { allowanceOf, chiefMaxHiresPerReply, describeAllowance, maxHireLevel, staffingFor } from "../core/chat.js";
import { readLedger } from "../core/ledger.js";
import { addContext, findContext, giveContext, listContext, takeContext, tokenLabel } from "../core/context.js";
import { hasCommits, isGitRepo } from "../core/git.js";
import { providerFor } from "../core/providers.js";
import { notReadyReason, providerReadiness } from "../core/setup.js";
import { AUTONOMY_LEVELS, PROVIDERS, type AgentRecord, type AutonomyLevel, type Provider } from "../core/types.js";

export const ORG_SERVER_NAME = "org";

/** The tool names, for providers that allowlist tools by name. */
export const ORG_TOOLS = [
  "org_roster",
  "org_mission",
  "org_outputs",
  "org_read_output",
  "org_board",
  "org_post",
  "org_handoff",
  "org_running",
  "org_trace",
  "org_ask",
] as const;

/**
 * The tools only the chief of staff gets. Each one is checked against the
 * chief's level at call time, read from the roster, so lowering the chief's
 * level takes effect on the very next tool call.
 */
export const CHIEF_TOOLS = ["org_providers", "org_hire", "org_budget", "org_delegate", "org_fire", "org_docket", "org_context", "org_give"] as const;

/** The tools a run of this agent gets, for providers that allowlist by name. */
export function orgToolsFor(agent: Pick<AgentRecord, "chief">): string[] {
  return agent.chief ? [...ORG_TOOLS, ...CHIEF_TOOLS] : [...ORG_TOOLS];
}

function rank(level: AutonomyLevel): number {
  return AUTONOMY_LEVELS.indexOf(level);
}

/** How long org_ask waits for a running teammate's answer by default. */
const ASK_WAIT_DEFAULT_S = 180;
const ASK_WAIT_MAX_S = 600;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function text(s: string): CallToolResult {
  return { content: [{ type: "text", text: s }] };
}

function guard<A>(fn: (args: A) => string | Promise<string>): (args: A) => Promise<CallToolResult> {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return text(await fn(args));
    } catch (e) {
      return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
    }
  };
}

function usd(n: number): string {
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function createCollabServer(opts: { agent: string; root: string; delegationId?: string | null; depth?: number }): McpServer {
  const { agent, root } = opts;
  const depth = opts.depth ?? 0;
  const server = new McpServer({ name: `ceo-${ORG_SERVER_NAME}`, version: "0.3.0" });
  const me = (): AgentRecord | null => readRoster(root).agents.find((a) => a.name === agent) ?? null;
  const isChief = Boolean(me()?.chief);

  server.registerTool(
    "org_roster",
    {
      title: "The org's roster",
      description: "Your teammates: name, role, provider, autonomy level and budget left. You are listed too.",
      inputSchema: {},
    },
    guard(() => {
      const lines = readRoster(root).agents.map((a) => {
        const left = a.budgetUsd > 0 ? `${usd(Math.max(0, a.budgetUsd - a.spentUsd))} left` : "uncapped";
        const me = a.name === agent ? " (you)" : "";
        return `${a.name}${me}: ${a.provider} ${a.model} · ${a.autonomy}, ${policyFor(a.autonomy).label} · ${left}\n  ${a.role.replace(/\s+/g, " ").slice(0, 200)}`;
      });
      const self = readRoster(root).agents.find((a) => a.name === agent);
      if (self?.chief) lines.push("", `Your allowance: ${describeAllowance(allowanceOf(self, root))}. Your own replies have no cap.`);
      return lines.length > 0 ? lines.join("\n") : "The org has no agents.";
    }),
  );

  server.registerTool(
    "org_mission",
    {
      title: "The org's mission",
      description: "The shared objective, how the org knows it is done, and the rules that apply to everyone.",
      inputSchema: {},
    },
    guard(() => {
      const m = currentMission(root);
      if (!m?.objective?.trim()) return "No mission has been set.";
      const out = [m.objective.trim()];
      if (m.successCriteria.length > 0) out.push("", "Done when:", ...m.successCriteria.map((c) => `- ${c}`));
      if (m.orgGuardrails.length > 0) out.push("", "Org rules:", ...m.orgGuardrails.map((g) => `- ${g}`));
      return out.join("\n");
    }),
  );

  server.registerTool(
    "org_outputs",
    {
      title: "Teammates' recent outputs",
      description: "Recent completed runs by your teammates, newest first, with an excerpt of each. Use org_read_output with an id for the full text.",
      inputSchema: {
        agent: z.string().optional().describe("Only this teammate's runs."),
        limit: z.number().int().min(1).max(20).optional().describe("Default 5."),
      },
    },
    guard((a: { agent?: string; limit?: number }) => {
      const rows = teammateOutputs(agent, root, { perAgent: a.agent ? 20 : 2, maxChars: 400, limit: a.limit ?? 5 }).filter(
        (o) => !a.agent || o.agent === a.agent,
      );
      if (rows.length === 0) return "No completed runs by teammates yet.";
      return rows
        .map((o) => `[${o.delegationId}] ${o.agent} · ${new Date(o.ts).toISOString()} · ${usd(o.costUsd)}\n  task: ${o.task}\n  ${o.excerpt.replace(/\n+/g, " ").slice(0, 400)}${o.truncated ? "…" : ""}`)
        .join("\n\n");
    }),
  );

  server.registerTool(
    "org_read_output",
    {
      title: "Read one output",
      description: "The full archived output of a run, by the id org_outputs shows.",
      inputSchema: { id: z.string().min(3).describe("The run id, as shown by org_outputs.") },
    },
    guard((a: { id: string }) => {
      const d = recentDelegations(500, root).find((x) => x.id === a.id && x.complete);
      if (!d || !d.outputPath) throw new Error(`No completed run with id ${a.id}.`);
      const body = readOutput(d.outputPath, 12000);
      return `${d.agent} on "${d.task}" (${usd(d.costUsd)}):\n\n${body.text}${body.truncated ? "\n\n[truncated at 12,000 characters]" : ""}`;
    }),
  );

  server.registerTool(
    "org_board",
    {
      title: "The board",
      description: "Notes teammates and the person have posted, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe("Default 20.") },
    },
    guard((a: { limit?: number }) => {
      const rows = messages(root, a.limit ?? 20);
      if (rows.length === 0) return "The board is empty.";
      return rows.map((m) => `${new Date(m.ts).toISOString()} ${describeMessage(m)}`).join("\n");
    }),
  );

  server.registerTool(
    "org_post",
    {
      title: "Post a note",
      description: 'Leave a note for one teammate (by name) or for everyone ("*"). It reaches them at the start of their next run. Keep it short; put the long version in your report.',
      inputSchema: {
        to: z.string().min(1).describe('A teammate\'s name, or "*" for everyone.'),
        text: z.string().min(2).max(2000),
        inReplyTo: z.string().optional().describe("The ask id, when this note answers a question put to you."),
      },
    },
    guard((a: { to: string; text: string; inReplyTo?: string }) => {
      const m = postMessage({ from: agent, to: a.to, text: a.text, delegationId: opts.delegationId ?? null, inReplyTo: a.inReplyTo ?? null }, root);
      const running = liveRuns(root).some((r) => r.agent === m.to && r.live);
      return `Posted to ${m.to === "*" ? "everyone" : m.to} (seq ${m.seq}).${running ? ` ${m.to} is running now and will see it at their next turn.` : ""}`;
    }),
  );

  server.registerTool(
    "org_running",
    {
      title: "Who is working right now",
      description: "Runs in progress across the org, with each one's task, turn and last few lines. Use org_trace for more of one.",
      inputSchema: {},
    },
    guard(() => {
      const runs = liveRuns(root, { tail: 3 }).filter((r) => r.live);
      if (runs.length === 0) return "Nobody else is running right now.";
      return runs
        .map((r) => `${r.agent}${r.agent === agent ? " (you)" : ""} · ${r.provider} · turn ${r.turn} · since ${new Date(r.startedAt).toISOString()}\n  task: ${r.task}\n${r.tail.map((l) => `  ${l}`).join("\n")}`)
        .join("\n\n");
    }),
  );

  server.registerTool(
    "org_trace",
    {
      title: "What a teammate is doing",
      description: "The live trace of a teammate's current run, or their latest if none is running: what they said and which tools they used, newest last.",
      inputSchema: {
        agent: z.string().min(1).describe("The teammate's name."),
        lines: z.number().int().min(5).max(200).optional().describe("Default 40."),
      },
    },
    guard((a: { agent: string; lines?: number }) => {
      const t = traceFor(a.agent, root, a.lines ?? 40);
      if (!t) return `No run by ${a.agent} has left a trace yet.`;
      const head = `${t.run.agent} · ${t.run.live ? "running" : "finished"} · turn ${t.run.turn} · task: ${t.run.task}`;
      return [head, ...t.lines].join("\n");
    }),
  );

  server.registerTool(
    "org_ask",
    {
      title: "Ask a teammate and wait",
      description:
        "Put a question to one teammate and wait for the answer. If they are running, the question reaches them at their next turn and this waits for their reply. If they are idle, a run is started for them to answer, under their own budget and level. Returns the answer, or says the question is on the board when none came in time.",
      inputSchema: {
        agent: z.string().min(1).describe("The teammate's name."),
        question: z.string().min(3).max(2000),
        waitSeconds: z.number().int().min(5).max(ASK_WAIT_MAX_S).optional().describe(`How long to wait for a running teammate. Default ${ASK_WAIT_DEFAULT_S}.`),
      },
    },
    guard(async (a: { agent: string; question: string; waitSeconds?: number }) => {
      if (depth > 0) {
        throw new Error("You were asked a question by a teammate; answer it with org_post rather than asking onward. One level of asking keeps the org from paying itself to think in circles.");
      }
      if (a.agent === agent) throw new Error("Ask a teammate, not yourself.");
      const askId = randomBytes(3).toString("hex");
      const ask = postMessage({ from: agent, to: a.agent, text: a.question, delegationId: opts.delegationId ?? null, askId }, root);

      const running = liveRuns(root).find((r) => r.agent === a.agent && r.live);
      if (running) {
        const deadline = Date.now() + (a.waitSeconds ?? ASK_WAIT_DEFAULT_S) * 1000;
        while (Date.now() < deadline) {
          const reply = replyTo(ask, root);
          if (reply) return `${a.agent} replied: ${reply.text}`;
          await sleep(2000);
        }
        return `${a.agent} is running and has not replied yet. The question (ask ${askId}) is on the board; they see it at their next turn and their answer will reach you at yours.`;
      }

      // Idle: a run of their own, under their budget and level, one level
      // deep so it cannot ask onward. Its cost is theirs, recorded as such.
      const result = await runDelegation(a.agent, `${agent} asks (ask ${askId}): ${a.question}\n\nAnswer directly and briefly. You may use your tools to find out.`, {
        cwd: root,
        parentDelegationId: opts.delegationId ?? null,
        depth: 1,
      }).finished;
      if (!result.ok) throw new Error(`${a.agent} could not answer: ${result.error ?? "the run failed"}`);
      const answer = result.text.trim() || replyTo(ask, root)?.text || "(no text came back)";
      return `${a.agent} replied: ${answer}`;
    }),
  );

  server.registerTool(
    "org_handoff",
    {
      title: "Hand work to a teammate",
      description:
        "Queue a task for a teammate. It runs when a person or the dispatcher starts it, under that teammate's own budget and autonomy level. You are recorded as the requester. For work that is theirs, not to avoid your own.",
      inputSchema: {
        agent: z.string().min(1).describe("The teammate's name."),
        title: z.string().min(3).max(300).describe("What to do, and what done looks like."),
        priority: z.enum(["high", "normal", "low"]).optional(),
      },
    },
    guard((a: { agent: string; title: string; priority?: string }) => {
      if (isChief && !staffingFor(me()?.autonomy ?? "observe").queue) {
        throw new Error("At observe, the chief of staff answers questions and cannot queue work. The operator can raise the chief's level with y.");
      }
      const priority = TASK_PRIORITIES.includes(a.priority as TaskPriority) ? (a.priority as TaskPriority) : undefined;
      const t = handoff({ from: agent, to: a.agent, title: a.title, priority }, root);
      return `Queued ${t.id} for ${t.assignee}${t.status === "blocked" ? `, currently blocked: ${t.blockedReason}` : ""}. It runs when a person or the dispatcher starts it.`;
    }),
  );

  if (isChief) registerChiefTools(server, { agent, root, delegationId: opts.delegationId ?? null, me });

  return server;
}

/**
 * The chief of staff's tools: what lets a chat message become a team. Every
 * refusal says what would make the call succeed, so the model can recover
 * inside the same reply instead of giving up.
 */
function registerChiefTools(
  server: McpServer,
  ctx: { agent: string; root: string; delegationId: string | null; me: () => AgentRecord | null },
): void {
  const { agent, root } = ctx;
  const levelNow = (): AutonomyLevel => ctx.me()?.autonomy ?? "observe";

  server.registerTool(
    "org_providers",
    {
      title: "Which providers can run",
      description: "Each of claude, codex and gemini: whether it is ready to run, its models, how many agents run on it, and how its cost is measured.",
      inputSchema: {},
    },
    guard(() => {
      const agents = readRoster(root).agents;
      return PROVIDERS.map((p) => {
        const spec = providerFor(p);
        let state = "ready";
        try {
          const r = providerReadiness(p);
          if (!r.ready) state = `not ready: ${r.fix[0] ?? "not installed or not signed in"}`;
        } catch (e) {
          state = `not ready: ${e instanceof Error ? e.message : String(e)}`;
        }
        if (process.env.CEO_SKIP_SETUP_CHECK) state = "ready, setup check skipped";
        const on = agents.filter((a) => a.provider === p).length;
        return `${p}: ${state}\n  models: ${spec.models().join(", ")}. Default ${spec.defaultModel()}.\n  ${on} agent${on === 1 ? "" : "s"} on it. ${spec.reportsCost ? "Reports a settled cost per run." : "Reports tokens. CEO costs each run at list price, marked as an estimate."}`;
      }).join("\n");
    }),
  );

  server.registerTool(
    "org_hire",
    {
      title: "Hire an agent",
      description:
        "Add an agent to the org: a name, a brief, a provider, a budget and a level. Any brief runs on any provider; pick the one the operator named, or one org_providers says is ready. The budget comes from your allowance. Say in your reply who you hired and why.",
      inputSchema: {
        name: z.string().min(2).max(40).describe("Lowercase letters, digits and hyphens, such as reviewer or flaky-test-fixer."),
        brief: z.string().min(10).max(2000).describe("What the agent does and what done looks like."),
        provider: z.enum(["claude", "codex", "gemini"]),
        model: z.string().optional().describe("One of the provider's models from org_providers. Default: the provider's default."),
        budgetUsd: z.number().positive().describe("The agent's budget in dollars, drawn from your allowance."),
        level: z.enum(["observe", "propose", "execute"]).optional().describe("observe reads and reports, propose drafts changes, execute writes on its own branch. Default execute."),
        isolated: z.boolean().optional().describe("Give the agent its own git worktree and branch. Default: true at execute in a git repository with a commit."),
        guardrails: z.array(z.string().min(3).max(300)).max(10).optional().describe("Hard constraints, one per item."),
      },
    },
    guard((a: { name: string; brief: string; provider: Provider; model?: string; budgetUsd: number; level?: AutonomyLevel; isolated?: boolean; guardrails?: string[] }) => {
      const chiefLevel = levelNow();
      const policy = staffingFor(chiefLevel);
      if (!policy.hire) {
        throw new Error(`At ${chiefLevel}, the chief of staff cannot hire. ${policy.queue ? "Queue the work with org_handoff and say who should be hired." : "Say who should be hired, and the operator decides."}`);
      }
      const level: AutonomyLevel = a.level ?? "execute";
      const ceiling = maxHireLevel(chiefLevel);
      if (rank(level) > rank(ceiling)) throw new Error(`A hire by the chief of staff is at most ${ceiling}. Hire at ${ceiling} or below.`);
      const self = ctx.me();
      const pool = self ? allowanceOf(self, root) : null;
      if (pool && a.budgetUsd > pool.leftUsd + 1e-9) {
        throw new Error(`A $${a.budgetUsd} budget is more than your allowance has left: ${describeAllowance(pool)}. Hire with a smaller budget, cut another agent's with org_budget, or ask the operator to raise the allowance with b on you.`);
      }

      const max = chiefMaxHiresPerReply();
      if (ctx.delegationId) {
        const entries = readLedger(root);
        const start = entries.find((e) => e.type === "delegate_start" && e.data.id === ctx.delegationId);
        const since = start?.seq ?? 0;
        const hires = entries.filter((e) => e.type === "hire" && e.seq > since && e.data.by === agent).length;
        if (hires >= max) throw new Error(`The chief of staff may hire at most ${max} agents per reply. Give the work to someone already hired, or say who else is needed.`);
      }

      if (!process.env.CEO_SKIP_SETUP_CHECK) {
        const reason = notReadyReason(a.provider);
        if (reason) throw new Error(`${a.provider} is not ready to run: ${reason} Pick a provider org_providers lists as ready.`);
      }
      const spec = providerFor(a.provider);
      const model = a.model?.trim() || spec.defaultModel();
      if (!spec.models().includes(model)) throw new Error(`${a.provider} has no model "${model}". Its models: ${spec.models().join(", ")}.`);

      const isolated = a.isolated ?? (level === "execute" && isGitRepo(root) && hasCommits(root));
      const hired = hire(
        {
          name: a.name.trim(),
          role: a.brief,
          provider: a.provider,
          model,
          budgetUsd: Math.round(a.budgetUsd * 100) / 100,
          autonomy: level,
          isolated,
          guardrails: a.guardrails ?? [],
          by: agent,
        },
        root,
      );
      const where = hired.branch ? `on branch ${hired.branch}` : "in the main tree";
      const after = ctx.me();
      const left = after ? ` Allowance: ${describeAllowance(allowanceOf(after, root))}.` : "";
      return `Hired ${hired.name} on ${hired.provider} ${hired.model} at ${hired.autonomy}, ${policyFor(hired.autonomy).label}, with a $${hired.budgetUsd} budget, ${where}.${left}`;
    }),
  );

  server.registerTool(
    "org_docket",
    {
      title: "The docket",
      description: "Every context item the operator keeps for the org: files, GitHub issues, Hugging Face cards, pages, skills and notes, with each item's size and which teammates hold it.",
      inputSchema: {},
    },
    guard(() => {
      const items = listContext(root);
      if (items.length === 0) return "The docket is empty. org_context adds an item.";
      return items
        .map((i) => `[${i.id}] ${i.title} · ${i.kind} · ${tokenLabel(i.chars)} tokens\n  from ${i.source} · held by ${i.agents.length > 0 ? i.agents.join(", ") : "nobody"}`)
        .join("\n");
    }),
  );

  server.registerTool(
    "org_context",
    {
      title: "Add context and give it",
      description:
        "Add an item to the docket and give it to teammates. The source is a repo path, a folder, an issue like #42, pr #12, hf:org/model, hf:datasets/org/name, paper:2401.12345, a URL, skill:name, or a short note. Teammates read it at the start of their next run.",
      inputSchema: {
        source: z.string().min(2).max(4000),
        agents: z.array(z.string()).max(12).optional().describe("Teammates to give it to."),
      },
    },
    guard(async (a: { source: string; agents?: string[] }) => {
      if (!staffingFor(levelNow()).queue) throw new Error("At observe, the chief of staff answers questions and cannot change the docket.");
      const item = await addContext(a.source, root, { by: agent, agents: a.agents ?? [] });
      return `${item.title} is in the docket as ${item.id}, ${item.kind}, ${tokenLabel(item.chars)} tokens. Held by ${item.agents.length > 0 ? item.agents.join(", ") : "nobody yet"}.`;
    }),
  );

  server.registerTool(
    "org_give",
    {
      title: "Give or take context",
      description: "Give a docket item to a teammate, or take it away. The item is an id from org_docket, or its title.",
      inputSchema: {
        item: z.string().min(1),
        agent: z.string().min(1),
        take: z.boolean().optional().describe("Take the item away instead."),
      },
    },
    guard((a: { item: string; agent: string; take?: boolean }) => {
      if (!staffingFor(levelNow()).queue) throw new Error("At observe, the chief of staff answers questions and cannot change the docket.");
      const it = findContext(a.item, root);
      if (!it) throw new Error(`No docket item matches "${a.item}". org_docket lists them.`);
      if (a.take) takeContext(it.id, a.agent, root, agent);
      else giveContext(it.id, a.agent, root, agent);
      return `${a.agent} ${a.take ? "no longer holds" : "now holds"} ${it.title}.`;
    }),
  );

  server.registerTool(
    "org_budget",
    {
      title: "Set an agent's budget",
      description:
        "Set a teammate's budget, from your allowance. A raise draws the difference from the allowance; a cut returns what you had given. Use it so each piece of work has the money it needs.",
      inputSchema: {
        agent: z.string().min(1).describe("The teammate's name."),
        budgetUsd: z.number().min(0).describe("The new budget in dollars."),
      },
    },
    guard((a: { agent: string; budgetUsd: number }) => {
      const chiefLevel = levelNow();
      if (!staffingFor(chiefLevel).hire) throw new Error(`At ${chiefLevel}, the chief of staff cannot set budgets. Say what each agent needs, and the operator decides.`);
      if (a.agent === agent) throw new Error("Your own replies have no cap, so you have no budget to set. The operator sets your allowance.");
      const self = ctx.me();
      const target = readRoster(root).agents.find((x) => x.name === a.agent);
      if (!self || !target) throw new Error(`No agent named "${a.agent}" in the org.`);
      const usd = Math.round(a.budgetUsd * 100) / 100;
      const pool = allowanceOf(self, root);
      const had = pool.given.get(a.agent) ?? 0;
      // The share the chief would hold after the change, against the base the operator set.
      const base = target.budgetUsd - had;
      const after = Math.max(0, usd - base);
      if (after - had > pool.leftUsd + 1e-9) {
        throw new Error(`Raising ${a.agent} to $${usd} needs $${(after - had).toFixed(2)} from your allowance, which has ${describeAllowance(pool)}. Ask for less, cut another agent, or ask the operator to raise the allowance with b on you.`);
      }
      setBudget(a.agent, usd, root, agent);
      const now = ctx.me();
      return `${a.agent}'s budget is now $${usd}, was $${target.budgetUsd}. ${a.agent} has spent $${target.spentUsd.toFixed(2)}. Allowance: ${now ? describeAllowance(allowanceOf(now, root)) : "unknown"}.`;
    }),
  );

  server.registerTool(
    "org_delegate",
    {
      title: "Give a teammate work",
      description:
        "Give a teammate a task that starts when your reply ends, under the teammate's own budget and level. Write the task as what to do and what done looks like. If the teammate is busy, the task starts when the current run ends.",
      inputSchema: {
        agent: z.string().min(1).describe("The teammate's name."),
        task: z.string().min(5).max(2000).describe("What to do, and what done looks like."),
        priority: z.enum(["high", "normal", "low"]).optional(),
        provider: z.enum(["claude", "codex", "gemini"]).optional().describe("Run this task on this provider, when the operator named one. The teammate's own setting stays."),
      },
    },
    guard((a: { agent: string; task: string; priority?: TaskPriority; provider?: Provider }) => {
      const chiefLevel = levelNow();
      const policy = staffingFor(chiefLevel);
      if (!policy.start) {
        throw new Error(
          policy.queue
            ? `At ${chiefLevel}, the chief of staff cannot start work. Queue it with org_handoff; the operator starts it.`
            : `At ${chiefLevel}, the chief of staff cannot give work. Say who should do it, and the operator decides.`,
        );
      }
      if (a.agent === agent) throw new Error("Give the work to a teammate. Your own process is read-only.");
      const target = readRoster(root).agents.find((x) => x.name === a.agent);
      if (!target) throw new Error(`No agent named "${a.agent}" in the org. Hire one with org_hire first.`);
      if (a.provider && !process.env.CEO_SKIP_SETUP_CHECK) {
        const reason = notReadyReason(a.provider);
        if (reason) throw new Error(`${a.provider} is not ready to run: ${reason} Pick a provider org_providers lists as ready, or tell the operator.`);
      }
      const provider = a.provider && a.provider !== target.provider ? a.provider : null;
      const t = addTask({ title: a.task, assignee: a.agent, priority: a.priority, requestedBy: agent, autoStart: true, provider }, root);
      const on = provider ? ` It runs on ${provider} this time; ${a.agent} usually runs on ${target.provider}.` : "";
      if (t.status === "blocked") return `Queued ${t.id} for ${a.agent}, but it is blocked: ${t.blockedReason}. The operator has to unblock it.`;
      const busy = liveRuns(root).some((r) => r.agent === a.agent && r.live);
      return busy
        ? `Queued ${t.id} for ${a.agent}. ${a.agent} is running now, so the task starts when that run ends.${on}`
        : `Queued ${t.id} for ${a.agent}. It starts when your reply ends.${on}`;
    }),
  );

  server.registerTool(
    "org_fire",
    {
      title: "Fire an agent you hired",
      description: "Remove an idle agent the chief of staff hired. The agent's history stays in the ledger. Only at autonomous.",
      inputSchema: {
        agent: z.string().min(1).describe("The agent's name."),
        reason: z.string().min(3).max(300),
      },
    },
    guard((a: { agent: string; reason: string }) => {
      const chiefLevel = levelNow();
      if (!staffingFor(chiefLevel).fire) throw new Error(`At ${chiefLevel}, the chief of staff cannot fire. Say who should go, and the operator decides.`);
      if (a.agent === agent) throw new Error("The chief of staff cannot fire itself.");
      const hires = readLedger(root).filter((e) => e.type === "hire" && e.agent === a.agent);
      const last = hires[hires.length - 1];
      if (!last) throw new Error(`No agent named "${a.agent}" in the org.`);
      if (last.data.by !== agent) throw new Error(`${a.agent} was not hired by the chief of staff, so only the operator can fire ${a.agent}.`);
      if (liveRuns(root).some((r) => r.agent === a.agent && r.live)) throw new Error(`${a.agent} is running. Wait for the run to end.`);
      fire(a.agent, a.reason, root, agent);
      return `Fired ${a.agent}: ${a.reason}`;
    }),
  );
}
