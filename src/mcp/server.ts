/**
 * The CEO MCP server.
 *
 * This is the only writer to `.ceo/`. Slash commands, hooks, subagents and
 * the TUI all read the ledger directly, but every mutation routes through a
 * tool call here: hire, fire, budget change, delegation, note, audit, merge.
 * One writer is what keeps the hash chain linear when three things fire
 * in the same session.
 *
 * Conventions in this file:
 *   - Handlers return a plain string. `guard()` turns it into a tool result
 *     and turns any thrown Error into a one-line error message, never a stack.
 *   - Output is terse. One line where one line does.
 *   - Nothing passes an explicit `cwd`; the core resolves the git root from
 *     the process working directory, which is the project the server was
 *     launched in.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import * as ledger from "../core/ledger.js";
import * as roster from "../core/roster.js";
import * as git from "../core/git.js";
import * as delegation from "../core/delegation.js";
import * as mission from "../core/mission.js";
import * as tasks from "../core/tasks.js";
import { listWorkspaces, registryPath } from "../core/workspaces.js";
import { effectiveTools, policyFor } from "../core/autonomy.js";
import { compileAgentPrompt, describeConfig } from "../core/compile.js";
import { orgExists, ceoDir, projectRoot } from "../core/paths.js";
import type { AgentRecord, AuditFinding, AutonomyLevel, DelegationCost } from "../core/types.js";
import type { DelegationHandle } from "../core/delegation.js";
import { writeAudit } from "./audit.js";
import {
  fmtTs,
  secs,
  shortModel,
  sinceHuman,
  startOfToday,
  summarizeEntry,
  table,
  trunc,
  usd,
  usdExact,
} from "./format.js";

// ---------------------------------------------------------------------------
// Result plumbing
// ---------------------------------------------------------------------------

function text(s: string): CallToolResult {
  return { content: [{ type: "text", text: s }] };
}

/** Error message without the stack, without the "Error: " prefix. */
function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Wrap a handler so a thrown Error becomes a clean tool error. Core functions
 * throw messages that already name the fix, such as "Raise the budget with
 * /budget …", so the message is passed through verbatim rather than decorated.
 */
function guard<A>(
  fn: (args: A) => string | Promise<string>,
): (args: A) => Promise<CallToolResult> {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return text(await fn(args));
    } catch (e) {
      return { content: [{ type: "text", text: message(e) }], isError: true };
    }
  };
}

/** Every tool but `ceo_init` needs an org to exist first. */
function requireOrg(): void {
  if (!orgExists()) {
    throw new Error(
      `No org in this project: ${ceoDir()} has no ledger. Run ceo_init first.`,
    );
  }
}

/** True when .gitignore already covers the worktrees directory. */
function worktreesIgnored(): boolean {
  const gi = path.join(projectRoot(), ".gitignore");
  if (!existsSync(gi)) return false;
  return readFileSync(gi, "utf8").includes(".ceo/worktrees");
}

function requireAgent(name: string) {
  const agent = roster.findAgent(name);
  if (!agent) {
    throw new Error(
      `No agent named "${name}" in the org. Check ceo_roster, or hire it with ceo_hire.`,
    );
  }
  return agent;
}

/**
 * Things about an agent's configuration that are true, easy to miss, and
 * expensive to discover later: a prompt override that silently drops the
 * mission and guardrails, an allowlist its autonomy level leaves empty,
 * unattended merge rights. Reported after hire and after reconfigure so the
 * surprise happens now rather than mid-delegation.
 */
function configWarnings(agent: AgentRecord): string[] {
  const out: string[] = [];

  if (agent.systemPrompt.trim()) {
    out.push(
      "systemPrompt override: mission, collaboration, autonomy wording and guardrails are NOT in this agent's prompt. Check ceo_compiled_prompt.",
    );
  } else if (!mission.current()) {
    out.push("No mission set: this agent compiles without an org objective. Set one with ceo_mission_set.");
  }

  // Autonomy still governs the tools even under a prompt override, so this
  // check runs either way.
  const tools = effectiveTools(agent.autonomy, agent.tools);
  if (tools.length === 0 && agent.tools.length > 0) {
    out.push(
      `Effective tools are empty: none of [${agent.tools.join(", ")}] is permitted at ${agent.autonomy}. Widen the allowlist or raise autonomy.`,
    );
  }

  if (policyFor(agent.autonomy).canMerge) {
    out.push("autonomous: may merge to the base branch with nobody reviewing.");
  }
  return out;
}

function bulletList(items: string[]): string {
  return items.map((s) => `  - ${s}`).join("\n");
}

/** Multi-line rendering of a mission, shared by get and set. */
function renderMission(m: {
  objective: string;
  successCriteria: string[];
  orgGuardrails: string[];
  setAt: number;
}): string {
  const lines = [`Objective: ${m.objective}`];
  if (m.successCriteria.length > 0) {
    lines.push("Done when:", bulletList(m.successCriteria));
  }
  if (m.orgGuardrails.length > 0) {
    lines.push(
      `Org guardrails, inherited by every agent:`,
      bulletList(m.orgGuardrails),
    );
  }
  lines.push(`Set ${sinceHuman(m.setAt)} ago.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

const NO_ARGS = {};

const agentName = z
  .string()
  .min(2)
  .max(40)
  .describe("Agent slug, lowercase alphanumeric with hyphens.");

const autonomyLevel = z
  .enum(["observe", "propose", "execute", "autonomous"])
  .describe(
    "observe = read only · propose = read and run, no writes · execute = writes on own branch, human merges · autonomous = writes and merges unattended. Enforced as a tool allowlist, not just prompt wording.",
  );

const systemPromptField = z
  .string()
  .describe(
    "Full prompt override. REPLACES the compiled prompt: mission, collaboration, autonomy wording and guardrails are all dropped.",
  );

const guardrailsField = z
  .array(z.string())
  .describe("Hard constraints, one per entry. Merged with the org guardrails.");

const collaborationField = z
  .string()
  .describe("How this agent fits with the others: who it defers to, what it hands off.");

const hireShape = {
  name: agentName,
  role: z
    .string()
    .min(10)
    .describe("Role brief, at least 10 characters. Becomes the system prompt."),
  provider: z
    .enum(["claude", "codex"])
    .optional()
    .describe("Which headless CLI runs this agent. claude runs `claude -p` with autonomy as a tool allowlist. codex runs `codex exec` with autonomy as a sandbox. Default claude, or inferred from a gpt-* model."),
  model: z.string().min(1).optional().describe("Model slug. Default: the provider's default, claude-sonnet-5 or gpt-5-codex."),
  tools: z
    .array(z.string())
    .optional()
    .describe("Tool allowlist. Omit or [] to inherit defaults."),
  budgetUsd: z.number().min(0).optional().describe("Hard spend cap. Default 5."),
  isolated: z
    .boolean()
    .optional()
    .describe("Give the agent its own git worktree on ceo/<name>."),
  systemPrompt: systemPromptField.optional(),
  guardrails: guardrailsField.optional(),
  collaboration: collaborationField.optional(),
  autonomy: autonomyLevel.optional().describe("Default execute."),
};

const missionSetShape = {
  objective: z
    .string()
    .min(10)
    .describe("What the org is trying to achieve. Every agent sees this."),
  successCriteria: z
    .array(z.string())
    .optional()
    .describe("How the org knows it is done. Omit to keep the current list."),
  orgGuardrails: z
    .array(z.string())
    .optional()
    .describe("Guardrails inherited by every agent. Omit to keep the current list."),
};

const guardrailShape = {
  rule: z.string().min(1).describe("One org-wide constraint, added to the existing set."),
};

const setAutonomyShape = { name: agentName, autonomy: autonomyLevel };

const reconfigureShape = {
  name: agentName,
  role: z.string().min(10).optional().describe("New role brief."),
  provider: z.enum(["claude", "codex"]).optional(),
  model: z.string().min(1).optional(),
  systemPrompt: systemPromptField.optional().describe(
    'Full prompt override. Pass "" to drop the override and go back to the compiled prompt.',
  ),
  guardrails: guardrailsField.optional().describe("Replaces the agent's guardrails wholesale."),
  collaboration: collaborationField.optional(),
  autonomy: autonomyLevel.optional(),
};

const nameOnlyShape = { name: agentName };

const fireShape = {
  name: agentName,
  reason: z.string().optional(),
  deleteBranch: z
    .boolean()
    .optional()
    .describe("Also delete ceo/<name>. Default false: the branch is kept."),
};

const budgetShape = {
  name: agentName,
  budgetUsd: z.number().min(0).describe("New hard cap in USD."),
};

const taskIdField = z
  .string()
  .min(1)
  .describe("Queue task this delegation is for. The task follows the run: running on begin, done or failed on end.");

const delegateBeginShape = {
  agent: agentName,
  task: z.string().min(3).describe("What the agent is being asked to do."),
  taskId: taskIdField.optional(),
};

const handleShape = z.object({
  id: z.string().min(1),
  agent: z.string().min(1),
  task: z.string().min(1),
  startedAt: z.number(),
  startSeq: z.number().int().min(0),
});

const delegateEndShape = {
  handle: handleShape.describe("The handle returned by ceo_delegate_begin."),
  output: z.string().describe("The agent's output, archived verbatim."),
  inputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0).default(0),
  costUsd: z.number().min(0).describe("Settled cost of this delegation."),
  durationMs: z.number().min(0).default(0),
  taskId: taskIdField.optional(),
  ok: z
    .boolean()
    .default(true)
    .describe("False when the agent failed the task, so the queue records failed rather than done."),
};

const taskPriority = z.enum(["high", "normal", "low"]).default("normal");

const taskAddShape = {
  title: z.string().min(3).describe("What to do, and what done looks like."),
  assignee: agentName.optional().describe("Omit to leave the task unassigned, which sits blocked."),
  priority: taskPriority,
};

const taskUpdateShape = {
  id: z.string().min(1),
  status: z
    .enum(["queued", "running", "done", "failed", "cancelled"])
    .optional()
    .describe("Blocked is derived, never set. Illegal transitions are refused."),
  assignee: agentName.nullable().optional().describe("null clears the assignee."),
  title: z.string().min(3).optional(),
  priority: z.enum(["high", "normal", "low"]).optional(),
  note: z.string().nullable().optional(),
};

const noteShape = {
  text: z.string().min(1),
  agent: agentName.optional().describe("Attach the note to one agent."),
};

const findingShape = z.object({
  category: z.enum(["drift", "redundancy", "cost", "coordination"]),
  agent: z.string().nullable().optional().describe("null for org-wide findings."),
  summary: z.string().min(1),
  recommendation: z.string().nullable().optional(),
});

const auditShape = {
  findings: z.array(findingShape).describe("May be empty: a clean audit is a result."),
  windowStartSeq: z.number().int().min(0),
  windowEndSeq: z.number().int().min(0),
};

const tailShape = { n: z.number().int().min(1).max(500).default(20) };
const rollupShape = { sinceHours: z.number().min(0).default(24) };
const recentShape = { n: z.number().int().min(1).max(200).default(10) };
const mergeShape = {
  agent: agentName,
  noFastForward: z
    .boolean()
    .optional()
    .describe("Default true: merges are recorded with a merge commit."),
};
const agentOnlyShape = { agent: agentName };

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "ceo", version: "0.1.0" },
    {
      instructions:
        "CEO manages a team of agents. This server is the only writer to " +
        ".ceo/. Route every mutation through these tools rather than " +
        "editing the ledger or roster directly.",
    },
  );

  // -- state / read -------------------------------------------------------

  server.registerTool(
    "ceo_init",
    {
      title: "Initialize org",
      description:
        "Create .ceo/ with a genesis ledger entry. Refuses if an org already exists.",
      inputSchema: NO_ARGS,
    },
    guard(() => {
      const entry = ledger.initLedger();
      const lines = [`Org initialized at ${ceoDir()}, seq ${entry.seq}.`];
      // Worktrees are nested git repos: committing them poisons a clone. Flag
      // it once, here, rather than editing the user's .gitignore for them.
      if (git.isGitRepo() && !worktreesIgnored()) {
        lines.push("Add .ceo/worktrees/ and .ceo/outputs/ to .gitignore.");
      }
      return lines.join("\n");
    }),
  );

  server.registerTool(
    "ceo_status",
    {
      title: "Org status",
      description:
        "One line: agent count, today's spend, dangling delegations, hours since last audit.",
      inputSchema: NO_ARGS,
    },
    guard(() => {
      requireOrg();
      const agents = roster.readRoster().agents;
      const today = ledger.rollup(startOfToday());
      const dangling = delegation.danglingDelegations();
      const audits = ledger.readLedger().filter((e) => e.type === "audit");
      const lastAudit = audits.length > 0 ? audits[audits.length - 1].ts : null;

      return [
        `${agents.length} agent${agents.length === 1 ? "" : "s"}`,
        `${usdExact(today.totalUsd)} today, ${today.delegationCount} delegation${
          today.delegationCount === 1 ? "" : "s"
        }`,
        `${dangling.length} dangling`,
        lastAudit === null ? "never audited" : `audited ${sinceHuman(lastAudit)} ago`,
      ].join(" · ");
    }),
  );

  server.registerTool(
    "ceo_roster",
    {
      title: "Roster",
      description:
        "The org: autonomy, config summary, spend against budget, model, branch, role brief.",
      inputSchema: NO_ARGS,
    },
    guard(() => {
      requireOrg();
      const agents = roster.readRoster().agents;
      if (agents.length === 0) {
        return "Empty org. Hire someone with ceo_hire.";
      }
      const rows: string[][] = [
        ["AGENT", "MODEL", "AUTONOMY", "SPENT/BUDGET", "DELEGS", "BRANCH", "CONFIG", "ROLE"],
        ...agents.map((a) => [
          a.name,
          shortModel(a.model),
          a.autonomy,
          `${usdExact(a.spentUsd)}/${usd(a.budgetUsd)}`,
          String(a.delegations),
          a.branch ?? "-",
          describeConfig(a),
          trunc(a.role, 36),
        ]),
      ];

      const lines = [table(rows)];

      // A custom systemPrompt means the agent is not running the configuration
      // shown in the CONFIG column: no mission, no guardrails, no autonomy
      // wording. Worth saying out loud rather than leaving to be discovered.
      const overridden = agents.filter((a) => a.systemPrompt.trim());
      if (overridden.length > 0) {
        lines.push(
          `${overridden.map((a) => a.name).join(", ")} ${
            overridden.length === 1 ? "runs" : "run"
          } a custom systemPrompt, so the compiled prompt is bypassed. Inspect with ceo_compiled_prompt.`,
        );
      }
      if (!mission.current()) {
        lines.push("No mission set: agents compile without an org objective. See ceo_mission_set.");
      }
      return lines.join("\n");
    }),
  );

  server.registerTool(
    "ceo_ledger_tail",
    {
      title: "Ledger tail",
      description: "The last n ledger entries, oldest first.",
      inputSchema: tailShape,
    },
    guard((a: { n: number }) => {
      requireOrg();
      const entries = ledger.tail(a.n);
      if (entries.length === 0) return "Ledger is empty.";
      return table(
        entries.map((e) => [
          String(e.seq),
          fmtTs(e.ts),
          e.type,
          e.agent ?? "-",
          summarizeEntry(e),
        ]),
      );
    }),
  );

  server.registerTool(
    "ceo_ledger_verify",
    {
      title: "Verify ledger",
      description: "Walk the hash chain and report the first break, if any.",
      inputSchema: NO_ARGS,
    },
    guard(() => {
      requireOrg();
      const r = ledger.verify();
      if (r.ok) {
        return `Chain intact: ${r.entriesChecked} entr${
          r.entriesChecked === 1 ? "y" : "ies"
        } verified.`;
      }
      return `Chain BROKEN at seq ${r.brokenAtSeq} after ${r.entriesChecked} good entries: ${r.reason}`;
    }),
  );

  server.registerTool(
    "ceo_rollup",
    {
      title: "Spend rollup",
      description: "Total and per-agent spend over the last sinceHours hours.",
      inputSchema: rollupShape,
    },
    guard((a: { sinceHours: number }) => {
      requireOrg();
      const since = a.sinceHours > 0 ? Date.now() - a.sinceHours * 3_600_000 : 0;
      const r = ledger.rollup(since);
      const window = a.sinceHours > 0 ? `last ${a.sinceHours}h` : "all time";
      const head = `${usdExact(r.totalUsd)} over ${r.delegationCount} delegation${
        r.delegationCount === 1 ? "" : "s"
      } · ${window}`;

      const byAgent = Object.entries(r.byAgent).sort((x, y) => y[1] - x[1]);
      if (byAgent.length === 0) return head;
      return [head, table(byAgent.map(([name, amt]) => [name, usdExact(amt)]))].join("\n");
    }),
  );

  server.registerTool(
    "ceo_recent_delegations",
    {
      title: "Recent delegations",
      description: "The last n delegations, newest first. Incomplete ones are marked.",
      inputSchema: recentShape,
    },
    guard((a: { n: number }) => {
      requireOrg();
      const rows = delegation.recentDelegations(a.n);
      if (rows.length === 0) return "No delegations yet.";
      return table([
        ["ID", "WHEN", "AGENT", "COST", "TIME", "STATUS", "TASK"],
        ...rows.map((d) => [
          d.id,
          fmtTs(d.ts),
          d.agent ?? "-",
          usdExact(d.costUsd),
          secs(d.durationMs),
          d.complete ? "done" : "DANGLING",
          trunc(d.task, 44),
        ]),
      ]);
    }),
  );

  // -- mutations ----------------------------------------------------------

  server.registerTool(
    "ceo_hire",
    {
      title: "Hire agent",
      description:
        "Add an agent to the org: role brief, model, budget, guardrails, collaboration brief and autonomy level. With isolated=true also provisions a git worktree on ceo/<name>.",
      inputSchema: hireShape,
    },
    guard(
      (a: {
        name: string;
        role: string;
        provider?: "claude" | "codex";
        model?: string;
        tools?: string[];
        budgetUsd?: number;
        isolated?: boolean;
        systemPrompt?: string;
        guardrails?: string[];
        collaboration?: string;
        autonomy?: AutonomyLevel;
      }) => {
        requireOrg();

        // Refuse before writing anything: hiring an isolated agent into a
        // non-repo would leave a roster entry that can never be provisioned.
        if (a.isolated && !git.isGitRepo()) {
          throw new Error(
            "Isolated agents need a git repository. Run `git init` first, or hire without isolated.",
          );
        }

        const record = roster.hire({
          name: a.name,
          role: a.role,
          provider: a.provider,
          model: a.model,
          tools: a.tools,
          budgetUsd: a.budgetUsd,
          isolated: a.isolated,
          systemPrompt: a.systemPrompt,
          guardrails: a.guardrails,
          collaboration: a.collaboration,
          autonomy: a.autonomy,
        });

        const head = `Hired ${record.name}: ${record.provider} ${shortModel(record.model)}, ${usd(
          record.budgetUsd,
        )} budget, ${record.autonomy}`;

        const lines: string[] = [];
        if (!a.isolated) {
          lines.push(`${head}, shared tree`);
        } else {
          try {
            const wt = git.provisionWorktree(record.name);
            lines.push(`${head}, isolated on ${wt.branch}`, wt.worktreePath);
          } catch (e) {
            // The hire is already in the ledger and must not be silently
            // reported as isolated when it is not.
            lines.push(`${head}, shared tree. Worktree failed: ${message(e)}`);
          }
        }

        lines.push(...configWarnings(record));
        return lines.join("\n");
      },
    ),
  );

  server.registerTool(
    "ceo_fire",
    {
      title: "Fire agent",
      description:
        "Remove an agent from the org. Tears down its worktree and keeps the branch unless deleteBranch.",
      inputSchema: fireShape,
    },
    guard((a: { name: string; reason?: string; deleteBranch?: boolean }) => {
      requireOrg();
      const agent = requireAgent(a.name);
      const hadWorktree = agent.isolated || Boolean(agent.worktreePath);
      const unmerged = hadWorktree ? git.unmergedCommits(a.name) : [];

      roster.fire(a.name, a.reason ?? null);

      const parts = [`Fired ${a.name}`];
      if (hadWorktree) {
        git.teardownWorktree(a.name, { deleteBranch: a.deleteBranch === true });
        parts.push(
          a.deleteBranch === true
            ? `Worktree removed, ${git.branchNameFor(a.name)} deleted`
            : `Worktree removed, ${git.branchNameFor(a.name)} kept`,
        );
        if (unmerged.length > 0 && a.deleteBranch !== true) {
          parts.push(
            `${unmerged.length} unmerged commit${
              unmerged.length === 1 ? "" : "s"
            } still on the branch`,
          );
        }
      }
      return `${parts.join(". ")}.`;
    }),
  );

  server.registerTool(
    "ceo_set_budget",
    {
      title: "Set budget",
      description: "Change an agent's hard spend cap.",
      inputSchema: budgetShape,
    },
    guard((a: { name: string; budgetUsd: number }) => {
      requireOrg();
      const before = requireAgent(a.name);
      roster.setBudget(a.name, a.budgetUsd);
      return `${a.name} budget ${usd(before.budgetUsd)} to ${usd(
        a.budgetUsd,
      )}, spent ${usdExact(before.spentUsd)}.`;
    }),
  );

  server.registerTool(
    "ceo_delegate_begin",
    {
      title: "Begin delegation",
      description:
        "Run the budget gate and open a delegation. Returns the handle as JSON on the last line. Pass it back to ceo_delegate_end.",
      inputSchema: delegateBeginShape,
    },
    guard((a: { agent: string; task: string; taskId?: string }) => {
      requireOrg();
      requireAgent(a.agent);
      if (a.taskId) {
        const t = tasks.findTask(a.taskId);
        if (!t) throw new Error(`No task with id ${a.taskId}. ceo_tasks lists the queue.`);
        if (t.status !== "queued") {
          throw new Error(
            `Task ${t.id} is ${t.status}${t.blockedReason ? `, ${t.blockedReason}` : ""}. Only a queued task can be run.`,
          );
        }
      }
      const handle = delegation.begin(a.agent, a.task);
      if (a.taskId) {
        tasks.updateTask(a.taskId, { status: "running", delegationId: handle.id });
      }
      return `Open ${handle.id} for ${handle.agent} at seq ${handle.startSeq}${
        a.taskId ? ` · task ${a.taskId} running` : ""
      }.\n${JSON.stringify(handle)}`;
    }),
  );

  server.registerTool(
    "ceo_delegate_end",
    {
      title: "End delegation",
      description:
        "Archive the output, record settled cost, and commit the agent's worktree when isolated.",
      inputSchema: delegateEndShape,
    },
    guard(
      (a: {
        handle: DelegationHandle;
        output: string;
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
        durationMs: number;
        taskId?: string;
        ok?: boolean;
      }) => {
        requireOrg();
        const cost: DelegationCost = {
          inputTokens: a.inputTokens,
          outputTokens: a.outputTokens,
          costUsd: a.costUsd,
          durationMs: a.durationMs,
        };
        const result = delegation.end(a.handle, a.output, cost);

        const lines = [
          `${[
            `Closed ${result.handle.id}`,
            result.handle.agent,
            usdExact(cost.costUsd),
            secs(cost.durationMs),
          ].join(" · ")} · saved to ${result.outputPath}`,
        ];

        if (result.commit) {
          lines.push(
            `Committed ${result.commit.sha.slice(0, 7)}, ${result.commit.files.length} file${
              result.commit.files.length === 1 ? "" : "s"
            }, on ${git.branchNameFor(result.handle.agent)}.`,
          );
        }

        if (a.taskId) {
          // Best effort: the delegation is the record, the task points at it.
          try {
            const t = tasks.updateTask(a.taskId, {
              status: a.ok === false ? "failed" : "done",
              note: a.ok === false ? "agent reported failure" : null,
            });
            lines.push(`Task ${t.id} ${t.status}.`);
          } catch (e) {
            lines.push(`Task ${a.taskId} not updated: ${message(e)}`);
          }
        }

        // Surfaced now rather than at the next delegate_begin refusal.
        const gate = roster.budgetCheck(result.handle.agent);
        if (gate) lines.push(`Budget exhausted: ${gate}`);

        return lines.join("\n");
      },
    ),
  );

  server.registerTool(
    "ceo_note",
    {
      title: "Add note",
      description: "Append a note to the ledger, optionally attached to one agent.",
      inputSchema: noteShape,
    },
    guard((a: { text: string; agent?: string }) => {
      requireOrg();
      if (a.agent) requireAgent(a.agent);
      const entry = ledger.append("note", a.agent ?? null, { text: a.text });
      return `Noted at seq ${entry.seq}${a.agent ? ` for ${a.agent}` : ""}.`;
    }),
  );

  server.registerTool(
    "ceo_write_audit",
    {
      title: "Write audit report",
      description:
        "Write .ceo/audits/<ts>.md from a findings array and append an audit ledger entry.",
      inputSchema: auditShape,
    },
    guard(
      (a: {
        findings: Array<{
          category: AuditFinding["category"];
          agent?: string | null;
          summary: string;
          recommendation?: string | null;
        }>;
        windowStartSeq: number;
        windowEndSeq: number;
      }) => {
        requireOrg();
        const findings: AuditFinding[] = a.findings.map((f) => ({
          category: f.category,
          agent: f.agent ?? null,
          summary: f.summary,
          recommendation: f.recommendation ?? null,
        }));

        const report = writeAudit({
          findings,
          windowStartSeq: a.windowStartSeq,
          windowEndSeq: a.windowEndSeq,
        });

        return `Audit written: ${report.reportPath}, ${findings.length} finding${
          findings.length === 1 ? "" : "s"
        }, seq ${a.windowStartSeq}–${a.windowEndSeq}.`;
      },
    ),
  );

  // -- mission ------------------------------------------------------------

  server.registerTool(
    "ceo_mission_get",
    {
      title: "Get mission",
      description:
        "The org's current objective, success criteria and org-wide guardrails. Every agent inherits these.",
      inputSchema: NO_ARGS,
    },
    guard(() => {
      requireOrg();
      const m = mission.current();
      if (!m) return "No mission set. Set one with ceo_mission_set.";
      return renderMission(m);
    }),
  );

  server.registerTool(
    "ceo_mission_set",
    {
      title: "Set mission",
      description:
        "Set the org objective. Recorded in the ledger, so what the org was pointed at when any past work ran stays recoverable. Omitted successCriteria or orgGuardrails keep their current values.",
      inputSchema: missionSetShape,
    },
    guard(
      (a: { objective: string; successCriteria?: string[]; orgGuardrails?: string[] }) => {
        requireOrg();
        const previous = mission.current();
        const m = mission.setMission({
          objective: a.objective,
          successCriteria: a.successCriteria,
          orgGuardrails: a.orgGuardrails,
        });

        const agents = roster.readRoster().agents;
        const overridden = agents.filter((x) => x.systemPrompt.trim()).length;

        const lines = [
          previous ? `Mission updated: ${trunc(m.objective, 72)}` : `Mission set: ${trunc(m.objective, 72)}`,
          `${m.successCriteria.length} success criteri${
            m.successCriteria.length === 1 ? "on" : "a"
          } · ${m.orgGuardrails.length} org guardrail${
            m.orgGuardrails.length === 1 ? "" : "s"
          } · applies to ${agents.length} agent${agents.length === 1 ? "" : "s"}`,
        ];
        if (overridden > 0) {
          lines.push(
            `${overridden} agent${
              overridden === 1 ? " runs" : "s run"
            } a custom systemPrompt and will not see it.`,
          );
        }
        return lines.join("\n");
      },
    ),
  );

  server.registerTool(
    "ceo_org_guardrail_add",
    {
      title: "Add org guardrail",
      description:
        "Add one constraint that every agent inherits, without rewriting the objective. Duplicates are ignored.",
      inputSchema: guardrailShape,
    },
    guard((a: { rule: string }) => {
      requireOrg();
      const before = mission.current();
      const m = mission.addOrgGuardrail(a.rule);
      if (before && before.orgGuardrails.length === m.orgGuardrails.length) {
        return `Already an org guardrail: ${trunc(a.rule, 72)}`;
      }
      return `Org guardrail added, ${m.orgGuardrails.length} total: ${trunc(a.rule, 72)}`;
    }),
  );

  server.registerTool(
    "ceo_mission_history",
    {
      title: "Mission history",
      description: "Every mission_set event, oldest first: when the org's objective changed.",
      inputSchema: NO_ARGS,
    },
    guard(() => {
      requireOrg();
      const rows = mission.history();
      if (rows.length === 0) return "No mission has ever been set.";
      return table([
        ["SEQ", "WHEN", "OBJECTIVE"],
        ...rows.map((h) => [String(h.seq), fmtTs(h.ts), trunc(h.objective, 64)]),
      ]);
    }),
  );

  // -- agent configuration ------------------------------------------------

  server.registerTool(
    "ceo_set_autonomy",
    {
      title: "Set autonomy",
      description:
        "Change what an agent may do unasked. This is an enforced boundary: the level maps to a real tool allowlist, not just prompt wording.",
      inputSchema: setAutonomyShape,
    },
    guard((a: { name: string; autonomy: AutonomyLevel }) => {
      requireOrg();
      const before = requireAgent(a.name);
      if (before.autonomy === a.autonomy) {
        return `${a.name} is already ${a.autonomy}: ${policyFor(a.autonomy).label}.`;
      }
      const after = roster.setAutonomy(a.name, a.autonomy);
      const policy = policyFor(after.autonomy);
      return [
        `${a.name} autonomy ${before.autonomy} to ${after.autonomy}: ${policy.label}.`,
        `Tools: ${effectiveTools(after.autonomy, after.tools).join(", ") || "none"}`,
        ...configWarnings(after),
      ].join("\n");
    }),
  );

  server.registerTool(
    "ceo_reconfigure",
    {
      title: "Reconfigure agent",
      description:
        "Change an agent's role, model, systemPrompt, guardrails, collaboration brief or autonomy. Appended as an agent_config event, so the old configuration stays in the ledger.",
      inputSchema: reconfigureShape,
    },
    guard(
      (a: {
        name: string;
        role?: string;
        provider?: "claude" | "codex";
        model?: string;
        systemPrompt?: string;
        guardrails?: string[];
        collaboration?: string;
        autonomy?: AutonomyLevel;
      }) => {
        requireOrg();
        const before = requireAgent(a.name);

        const changes: Partial<
          Pick<
            AgentRecord,
            "role" | "provider" | "model" | "systemPrompt" | "guardrails" | "collaboration" | "autonomy"
          >
        > = {};
        const diffs: string[] = [];

        if (a.provider !== undefined && a.provider !== before.provider) {
          changes.provider = a.provider;
          diffs.push(`provider ${before.provider} to ${a.provider}`);
        }

        if (a.role !== undefined && a.role.trim() !== before.role) {
          changes.role = a.role.trim();
          diffs.push(`role: ${trunc(changes.role, 56)}`);
        }
        if (a.model !== undefined && a.model !== before.model) {
          changes.model = a.model;
          diffs.push(`model ${shortModel(before.model)} to ${shortModel(a.model)}`);
        }
        if (a.systemPrompt !== undefined && a.systemPrompt.trim() !== before.systemPrompt) {
          changes.systemPrompt = a.systemPrompt.trim();
          diffs.push(
            changes.systemPrompt
              ? `systemPrompt set, ${changes.systemPrompt.length} chars, compilation bypassed`
              : "systemPrompt cleared, back to the compiled prompt",
          );
        }
        if (a.guardrails !== undefined) {
          const rails = a.guardrails.map((g) => g.trim()).filter(Boolean);
          if (rails.join("\n") !== before.guardrails.join("\n")) {
            changes.guardrails = rails;
            diffs.push(`guardrails ${before.guardrails.length} to ${rails.length}`);
          }
        }
        if (a.collaboration !== undefined && a.collaboration.trim() !== before.collaboration) {
          changes.collaboration = a.collaboration.trim();
          diffs.push(
            changes.collaboration ? "collaboration brief updated" : "collaboration brief cleared",
          );
        }
        if (a.autonomy !== undefined && a.autonomy !== before.autonomy) {
          changes.autonomy = a.autonomy;
          diffs.push(`autonomy ${before.autonomy} to ${a.autonomy}`);
        }

        if (diffs.length === 0) {
          return `Nothing to change on ${a.name}. Pass a field that differs from the current configuration: role, model, systemPrompt, guardrails, collaboration, autonomy.`;
        }

        const after = roster.reconfigure(a.name, changes);
        return [
          `${a.name}: ${diffs.join(" · ")}`,
          describeConfig(after),
          ...configWarnings(after),
        ].join("\n");
      },
    ),
  );

  server.registerTool(
    "ceo_compiled_prompt",
    {
      title: "Compiled prompt",
      description:
        "The FULL system prompt an agent will actually run under, plus which sections went into it and whether a systemPrompt override replaced the compilation. Read this before trusting an agent with work.",
      inputSchema: nameOnlyShape,
    },
    guard((a: { name: string }) => {
      requireOrg();
      const agent = requireAgent(a.name);
      const m = mission.current();
      const compiled = compileAgentPrompt(agent, m);

      const head = [
        `${agent.name} · ${shortModel(agent.model)} · ${agent.autonomy}, ${
          policyFor(agent.autonomy).label
        }`,
        `Sections: ${compiled.sections.join(", ")}`,
      ];

      if (compiled.overridden) {
        head.push(
          "OVERRIDDEN: systemPrompt replaced the compilation. The mission, collaboration brief, autonomy wording and every guardrail below are absent from this prompt:",
          bulletList(
            [
              m?.objective ? "mission objective" : null,
              m && m.orgGuardrails.length > 0
                ? `${m.orgGuardrails.length} org guardrail${m.orgGuardrails.length === 1 ? "" : "s"}`
                : null,
              agent.guardrails.length > 0
                ? `${agent.guardrails.length} agent guardrail${
                    agent.guardrails.length === 1 ? "" : "s"
                  }`
                : null,
              agent.collaboration.trim() ? "collaboration brief" : null,
              `autonomy wording for ${agent.autonomy}`,
            ].filter((s): s is string => s !== null),
          ),
          "The tool allowlist is still enforced, see ceo_effective_tools. Only the wording is gone.",
        );
      } else {
        // What is missing is as informative as what is present: an agent with
        // no mission section is running without the org's objective.
        const omitted: string[] = [];
        if (!compiled.sections.includes("mission")) {
          omitted.push("mission, since no org mission is set");
        }
        if (!compiled.sections.includes("collaboration")) {
          omitted.push("collaboration, since this agent has no brief");
        }
        if (!compiled.sections.some((s) => s.startsWith("guardrails:"))) {
          omitted.push("guardrails, since none are on the agent or the org");
        }
        head.push(
          "Compiled from configuration, no systemPrompt override.",
          omitted.length > 0 ? `Omitted: ${omitted.join(" · ")}` : "Every section present.",
        );
      }

      return [
        ...head,
        `--- prompt, ${compiled.text.length} chars ---`,
        compiled.text,
      ].join("\n");
    }),
  );

  server.registerTool(
    "ceo_effective_tools",
    {
      title: "Effective tools",
      description:
        "The tool allowlist this agent will actually receive, and how it was arrived at: the autonomy level's permitted set, narrowed by the agent's own allowlist.",
      inputSchema: nameOnlyShape,
    },
    guard((a: { name: string }) => {
      requireOrg();
      const agent = requireAgent(a.name);
      const policy = policyFor(agent.autonomy);
      const tools = effectiveTools(agent.autonomy, agent.tools);

      const lines = [
        `${agent.name} · ${agent.autonomy}, ${policy.label}`,
        `Level permits: ${policy.tools.join(", ")}`,
        agent.tools.length === 0
          ? "Agent allowlist: none set, so the level's set passes through unnarrowed."
          : `Agent allowlist: ${agent.tools.join(", ")}, intersected with the level's set.`,
        `Effective: ${tools.join(", ") || "none"}`,
        `Writes: ${policy.canWrite ? "permitted" : "blocked"} · merges unattended: ${
          policy.canMerge ? "permitted" : "blocked, a human merges"
        }`,
      ];

      if (tools.length === 0) {
        lines.push(
          agent.tools.length > 0
            ? `Nothing in [${agent.tools.join(", ")}] is permitted at ${agent.autonomy}: this agent can do nothing. Widen the allowlist with ceo_reconfigure, or raise autonomy.`
            : `No tools at ${agent.autonomy}.`,
        );
      } else {
        const denied = agent.tools.filter((t) => !tools.includes(t));
        if (denied.length > 0) {
          lines.push(
            `Denied by autonomy: ${denied.join(", ")}. In the agent's allowlist but not permitted at ${agent.autonomy}.`,
          );
        }
      }
      return lines.join("\n");
    }),
  );

  // -- git ----------------------------------------------------------------

  server.registerTool(
    "ceo_worktree_status",
    {
      title: "Worktree status",
      description: "Files changed in an agent's worktree.",
      inputSchema: agentOnlyShape,
    },
    guard((a: { agent: string }) => {
      requireOrg();
      const agent = requireAgent(a.agent);
      if (!agent.isolated || !agent.worktreePath) {
        return `${a.agent} has no worktree because it is not isolated.`;
      }
      const files = git.worktreeStatus(a.agent);
      if (files.length === 0) return `${a.agent} worktree clean on ${agent.branch}.`;
      return [
        `${files.length} file${files.length === 1 ? "" : "s"} changed in ${agent.branch}:`,
        ...files.map((f) => `  ${f}`),
      ].join("\n");
    }),
  );

  server.registerTool(
    "ceo_merge",
    {
      title: "Merge agent branch",
      description:
        "Merge ceo/<agent> into the current branch. Conflicts are reported, not thrown.",
      inputSchema: mergeShape,
    },
    guard((a: { agent: string; noFastForward?: boolean }) => {
      requireOrg();
      requireAgent(a.agent);
      const base = git.currentBranch() ?? "HEAD";
      const r = git.mergeAgentBranch(a.agent, { noFastForward: a.noFastForward });

      if (r.ok) {
        return `Merged ${git.branchNameFor(a.agent)} into ${base} at ${r.sha.slice(0, 7)}.`;
      }
      if (r.conflicts.length > 0) {
        return [
          `Conflict merging ${git.branchNameFor(a.agent)} into ${base}. ${
            r.conflicts.length
          } file${r.conflicts.length === 1 ? "" : "s"}:`,
          ...r.conflicts.map((f) => `  ${f}`),
          "Resolve, then commit. `git merge --abort` backs out.",
        ].join("\n");
      }
      return `Merge of ${git.branchNameFor(a.agent)} into ${base} failed: ${trunc(r.error, 200)}`;
    }),
  );

  server.registerTool(
    "ceo_unmerged",
    {
      title: "Unmerged commits",
      description: "Commits on ceo/<agent> that are not on the current branch.",
      inputSchema: agentOnlyShape,
    },
    guard((a: { agent: string }) => {
      requireOrg();
      requireAgent(a.agent);
      const commits = git.unmergedCommits(a.agent);
      const branch = git.branchNameFor(a.agent);
      if (commits.length === 0) return `Nothing unmerged on ${branch}.`;
      return [
        `${commits.length} unmerged commit${commits.length === 1 ? "" : "s"} on ${branch}:`,
        ...commits.map((c) => `  ${c}`),
      ].join("\n");
    }),
  );

  // -------------------------------------------------------------------------
  // Queue
  // -------------------------------------------------------------------------

  server.registerTool(
    "ceo_tasks",
    {
      title: "List tasks",
      description:
        "The work queue: running, then queued by priority, then blocked with the reason, then settled. Blocked is derived from the roster, never stored.",
      inputSchema: NO_ARGS,
    },
    guard(() => {
      requireOrg();
      const list = tasks.listTasks();
      if (list.length === 0) return "Queue is empty. ceo_task_add queues work. /delegate runs it now.";
      const c = tasks.taskCounts(list);
      const head = `${c.running} running · ${c.queued} queued · ${c.blocked} blocked · ${c.done} done · ${c.failed} failed · ${c.cancelled} cancelled`;
      const rows = list.map((t) => [
        t.id,
        t.status,
        t.assignee ?? "-",
        t.priority,
        trunc(t.title, 48),
        t.blockedReason ? `blocked: ${t.blockedReason}` : t.costUsd !== null ? usdExact(t.costUsd) : "",
      ]);
      return `${head}\n${table(rows)}`;
    }),
  );

  server.registerTool(
    "ceo_task_add",
    {
      title: "Add task",
      description:
        "Queue a task. Spends nothing: it is a task_add in the ledger. Run it with /delegate, passing taskId, or from the dashboard.",
      inputSchema: taskAddShape,
    },
    guard((a: { title: string; assignee?: string; priority: "high" | "normal" | "low" }) => {
      requireOrg();
      if (a.assignee) requireAgent(a.assignee);
      const t = tasks.addTask({ title: a.title, assignee: a.assignee ?? null, priority: a.priority });
      return t.status === "blocked"
        ? `Queued ${t.id} at ${t.priority} priority, blocked: ${t.blockedReason}.`
        : `Queued ${t.id} at ${t.priority} priority for ${t.assignee}.`;
    }),
  );

  server.registerTool(
    "ceo_task_update",
    {
      title: "Update task",
      description:
        "Change a task's status, assignee, title, priority or note. Appends a task_update. The history stays in the ledger.",
      inputSchema: taskUpdateShape,
    },
    guard(
      (a: {
        id: string;
        status?: tasks.TaskStoredStatus;
        assignee?: string | null;
        title?: string;
        priority?: tasks.TaskPriority;
        note?: string | null;
      }) => {
        requireOrg();
        if (a.assignee) requireAgent(a.assignee);
        const { id, ...changes } = a;
        const t = tasks.updateTask(id, changes);
        return `${t.id} · ${t.status}${t.blockedReason ? `, ${t.blockedReason}` : ""} · ${
          t.assignee ?? "unassigned"
        } · ${t.priority} · ${trunc(t.title, 60)}`;
      },
    ),
  );

  // -------------------------------------------------------------------------
  // Workspaces
  // -------------------------------------------------------------------------

  server.registerTool(
    "ceo_workspaces",
    {
      title: "List workspaces",
      description:
        "Every repo registered in ~/.ceo/workspaces.json, the list the dashboard's sidebar shows. Read-only. `ceo workspace add` registers one.",
      inputSchema: NO_ARGS,
    },
    guard(() => {
      const all = listWorkspaces();
      if (all.length === 0) return `No workspaces registered in ${registryPath()}.`;
      const here = projectRoot();
      return table(
        all.map((w) => [w.path === here ? "*" : " ", w.name, w.path, orgExists(w.path) ? "" : "no org yet"]),
      );
    }),
  );

  return server;
}
