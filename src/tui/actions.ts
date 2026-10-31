/**
 * Every write the dashboard can perform, in one place.
 *
 * The rest of the TUI reads `.ceo/` through data.ts and never writes. These
 * functions are the exception. They are collected here so that everything a
 * keypress can change in the org is one list. You can read it in one screen
 * instead of hunting through the components.
 *
 * Each one returns a result instead of throwing. A dashboard that crashes on
 * a duplicate agent name is worse than one that says "already in the org" on
 * its bottom line. The core throws for perfectly ordinary user mistakes.
 * Serialization is not this module's problem: `ledger.append` takes the lock
 * itself, so a hire here and a hire from an MCP tool call cannot interleave.
 */

import type { VerifierSpec } from "../core/types.js";
import { effectiveTools, policyFor } from "../core/autonomy.js";
import {
  branchNameFor,
  currentBranch,
  hasCommits,
  isGitRepo,
  mergeAgentBranch,
  provisionWorktree,
  unmergedCommits,
} from "../core/git.js";
import { setMission } from "../core/mission.js";
import { projectRoot } from "../core/paths.js";
import { findAgent, fire, hire, reconfigure, setAutonomy, setBudget } from "../core/roster.js";
import { providerFor } from "../core/providers.js";
import { providerReadiness } from "../core/setup.js";
import { workdirFor } from "../core/runner.js";
import { addTask, updateTask, type TaskPriority, type TaskStoredStatus } from "../core/tasks.js";
import { openWindow } from "../core/tmux.js";
import type { AgentRecord, AutonomyLevel, Provider } from "../core/types.js";
import { addWorkspace, removeWorkspace } from "../core/workspaces.js";

export type MutationResult =
  | { ok: true; message: string }
  /**
   * `partial` means the org changed anyway. A caller holding a form open for
   * correction has to know the difference. Retrying a partial hire fails on
   * the duplicate name instead of fixing the thing that actually broke.
   */
  | { ok: false; message: string; partial?: boolean };

export type MergeOutcome =
  | { ok: true; message: string }
  | { ok: false; message: string; conflicts: string[] };

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type HireInput = {
  name: string;
  role: string;
  /** Omitted means claude, the core's default. */
  provider?: Provider;
  /** Omitted means the provider's default model. */
  model?: string;
  budgetUsd: number;
  isolated: boolean;
  /**
   * Omitted means the core's own default of `execute`, which is deliberately
   * not repeated here: two defaults for one field is how they drift apart.
   */
  autonomy?: AutonomyLevel;
  collaboration?: string;
  guardrails?: string[];
};

/**
 * Hire, then provision the worktree when the agent is isolated.
 *
 * The two steps are reported separately on purpose. `hire()` can write its
 * ledger entry and then `provisionWorktree()` can fail, say with no git repo
 * or a branch name already taken by something else. That leaves a real agent
 * that has no branch yet. Telling the user "hired, but the worktree failed
 * because X" is both true and actionable. Claiming the whole thing failed
 * would not be.
 */
export function hireAgent(input: HireInput, cwd?: string): MutationResult {
  try {
    hire(
      {
        name: input.name,
        role: input.role,
        provider: input.provider,
        model: input.model,
        budgetUsd: input.budgetUsd,
        isolated: input.isolated,
        autonomy: input.autonomy,
        collaboration: input.collaboration,
        guardrails: input.guardrails,
      },
      cwd,
    );
  } catch (e) {
    return { ok: false, message: reason(e) };
  }

  // The level is named back because it is a permission boundary, not a
  // preference, and the roster row abbreviates it to three letters.
  const level = input.autonomy ?? "execute";
  const on = input.provider && input.provider !== "claude" ? ` on ${input.provider}` : "";
  const at = `${on} at ${level}: ${policyFor(level).label}`.trim();

  if (!input.isolated) {
    return { ok: true, message: `Hired ${input.name} in the main tree, ${at}.` };
  }

  try {
    const { branch } = provisionWorktree(input.name, cwd);
    return { ok: true, message: `Hired ${input.name} on branch ${branch}, ${at}.` };
  } catch (e) {
    return {
      ok: false,
      partial: true,
      message: `Hired ${input.name}, but its worktree failed: ${reason(e)}`,
    };
  }
}

export function fireAgent(
  name: string,
  why: string | null,
  cwd?: string,
): MutationResult {
  try {
    fire(name, why, cwd);
    return { ok: true, message: `Fired ${name}.` };
  } catch (e) {
    return { ok: false, message: reason(e) };
  }
}

export function setAgentBudget(
  name: string,
  budgetUsd: number,
  cwd?: string,
): MutationResult {
  try {
    setBudget(name, budgetUsd, cwd);
    return {
      ok: true,
      message:
        budgetUsd > 0
          ? `${name} budget set to $${budgetUsd}.`
          : `${name} is now uncapped.`,
    };
  } catch (e) {
    return { ok: false, message: reason(e) };
  }
}

/**
 * Change what an agent is permitted to do without a human in the loop.
 *
 * The message says what the agent can now *do* rather than echoing the level
 * back. "propose" only means something to someone who already knows the four
 * levels. The whole point of the key is to be usable by someone who does not.
 * The tool list is included for the same reason: this is an enforced
 * allowlist, not prompt wording. Seeing Write disappear from it is the
 * clearest possible statement of that.
 */
/**
 * Move an agent to another provider. The brief, budget, level, branch and
 * history stay; the model becomes the new provider's default unless the
 * current one already belongs to it. An unready provider is allowed, so an
 * org can be set up before every login exists, but the flash says so.
 */
export function setAgentProvider(name: string, provider: Provider, cwd?: string): MutationResult {
  try {
    const spec = providerFor(provider);
    const current = reconfigure(name, {}, cwd);
    const keepModel = spec.models().includes(current.model);
    const after = reconfigure(name, { provider, model: keepModel ? current.model : spec.defaultModel() }, cwd);
    const ready = providerReadiness(provider).ready;
    return {
      ok: true,
      message: `${name} now runs on ${after.provider} as ${after.model}. Brief, budget and history unchanged.${ready ? "" : ` ${provider} is not ready yet; press S.`}`,
    };
  } catch (e) {
    return { ok: false, message: reason(e) };
  }
}

/**
 * Give an agent a worktree and a branch of its own, after hiring. From the
 * next run on, the agent's changes land on `ceo/<name>` instead of the main
 * tree. Isolation is one-way here: taking it back means merging or
 * discarding the branch first, which is a decision for the merge dialog.
 */
export function isolateAgent(name: string, cwd?: string): MutationResult {
  try {
    const agent = findAgent(name, cwd);
    if (!agent) return { ok: false, message: `No agent named "${name}" in the org.` };
    if (agent.isolated && agent.branch) return { ok: true, message: `${name} already works on branch ${agent.branch}.` };
    if (!isGitRepo(cwd)) return { ok: false, message: "Worktrees need a git repository. Run git init and make a first commit." };
    if (!hasCommits(cwd)) return { ok: false, message: "Worktrees need a first commit to branch from. Commit once, then press i again." };
    const { branch } = provisionWorktree(name, cwd);
    return { ok: true, message: `${name} now works on branch ${branch}, in .ceo/worktrees/${name}. m merges the branch.` };
  } catch (e) {
    return { ok: false, message: reason(e) };
  }
}

export function setAgentAutonomy(
  name: string,
  autonomy: AutonomyLevel,
  cwd?: string,
): MutationResult {
  try {
    const agent = setAutonomy(name, autonomy, cwd);
    const policy = policyFor(agent.autonomy);
    const tools = effectiveTools(agent.autonomy, agent.tools);
    return {
      ok: true,
      message: `${name} is now ${policy.level}: can ${policy.label}. Tools: ${
        tools.length > 0 ? tools.join(", ") : "none"
      }.`,
    };
  } catch (e) {
    return { ok: false, message: reason(e) };
  }
}

/**
 * Set the org's objective, success criteria, and org-wide guardrails.
 *
 * Every agent's compiled prompt is rebuilt from this on its next delegation,
 * so this is the one dashboard write that changes every agent at once. The
 * core refuses an objective under ten characters. That refusal is passed
 * through verbatim rather than pre-empted, so there is one rule and not two.
 */
export function saveMission(
  input: {
    objective: string;
    successCriteria: string[];
    orgGuardrails: string[];
  },
  cwd?: string,
): MutationResult {
  try {
    const mission = setMission(input, cwd);
    const criteria = mission.successCriteria.length;
    const rails = mission.orgGuardrails.length;
    return {
      ok: true,
      message: `Mission set · ${criteria} success criteri${
        criteria === 1 ? "on" : "a"
      } · ${rails} org guardrail${rails === 1 ? "" : "s"} now inherited by every agent.`,
    };
  } catch (e) {
    return { ok: false, message: reason(e) };
  }
}

/**
 * Merge an agent's branch into whatever the base repo is on.
 *
 * Conflicts come back as a file list and nothing else happens to them. The
 * dashboard has no business picking a side in a merge conflict. An automatic
 * `--abort` would throw away a merge the user may want to finish by hand in
 * the terminal they already have open.
 */
export function mergeAgent(name: string, cwd?: string): MergeOutcome {
  try {
    const result = mergeAgentBranch(name, {}, cwd);
    if (result.ok) {
      return {
        ok: true,
        message: `Merged ${branchNameFor(name)} into ${
          currentBranch(cwd) ?? "the base branch"
        } (${result.sha.slice(0, 7)}).`,
      };
    }
    return {
      ok: false,
      conflicts: result.conflicts,
      message:
        result.conflicts.length > 0
          ? `${branchNameFor(name)} conflicts in ${result.conflicts.length} file${
              result.conflicts.length === 1 ? "" : "s"
            }.`
          : `Merge of ${branchNameFor(name)} failed: ${result.error}`,
    };
  } catch (e) {
    return { ok: false, conflicts: [], message: reason(e) };
  }
}

/** Commits on an agent's branch that the base branch does not have. */
export function readUnmerged(name: string, cwd?: string): string[] {
  try {
    if (!isGitRepo(cwd)) return [];
    return unmergedCommits(name, cwd);
  } catch {
    return [];
  }
}

/** Branch the merge would land on, for dialogs that name the destination. */
export function baseBranch(cwd?: string): string {
  try {
    return currentBranch(cwd) ?? "the base branch";
  } catch {
    return "the base branch";
  }
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/**
 * Queue a task. Spends nothing: it is a `task_add` in the ledger. The run
 * is a separate keystroke, or the dispatcher when auto is on.
 */
export function addQueueTask(
  input: { title: string; assignee: string | null; priority: TaskPriority; verifiers?: VerifierSpec[]; samples?: number },
  cwd?: string,
): MutationResult & { id?: string } {
  try {
    const t = addTask(input, cwd);
    return {
      ok: true,
      id: t.id,
      message: t.assignee
        ? `Queued ${t.id} for ${t.assignee}${t.status === "blocked" ? `, blocked: ${t.blockedReason}` : ""}.`
        : `Queued ${t.id} unassigned. It is blocked until someone is assigned with e.`,
    };
  } catch (e) {
    return { ok: false, message: reason(e) };
  }
}

export function editQueueTask(
  id: string,
  changes: { title?: string; assignee?: string | null; priority?: TaskPriority; verifiers?: VerifierSpec[]; samples?: number },
  cwd?: string,
): MutationResult {
  try {
    const t = updateTask(id, changes, cwd);
    return { ok: true, message: `Task ${t.id} updated: ${t.assignee ?? "unassigned"} · ${t.priority} · ${t.status}.` };
  } catch (e) {
    return { ok: false, message: reason(e) };
  }
}

export function setQueueTaskStatus(
  id: string,
  status: TaskStoredStatus,
  note: string | null = null,
  cwd?: string,
): MutationResult {
  try {
    const t = updateTask(id, { status, note }, cwd);
    return { ok: true, message: `Task ${t.id} is now ${t.status}.` };
  } catch (e) {
    return { ok: false, message: reason(e) };
  }
}

// ---------------------------------------------------------------------------
// Workspaces and tmux
// ---------------------------------------------------------------------------

export function registerWorkspace(p: string): MutationResult & { path?: string } {
  try {
    const w = addWorkspace(p);
    return { ok: true, path: w.path, message: `Registered ${w.name} at ${w.path}` };
  } catch (e) {
    return { ok: false, message: reason(e) };
  }
}

export function forgetWorkspace(p: string): MutationResult {
  return removeWorkspace(p)
    ? { ok: true, message: `Forgot ${p}. Its .ceo/ is untouched.` }
    : { ok: false, message: `Not a registered workspace: ${p}` };
}

/**
 * A tmux window with a shell in a directory. For an agent, that is the
 * worktree it runs in, the place to look at what it actually changed. For
 * anything else it is the workspace root.
 */
export function openShellWindow(opts: {
  workspaceName: string;
  agent?: AgentRecord | null;
  cwd: string;
}): MutationResult {
  const dir = opts.agent ? workdirFor(opts.agent, opts.cwd) : projectRoot(opts.cwd);
  const name = opts.agent ? `${opts.workspaceName}/${opts.agent.name}` : opts.workspaceName;
  const r = openWindow({ name, cwd: dir });
  return r.ok ? { ok: true, message: r.detail } : { ok: false, message: r.error };
}
