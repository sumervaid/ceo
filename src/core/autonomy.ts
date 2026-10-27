/**
 * Autonomy as an enforced boundary.
 *
 * The temptation with a feature like this is to write "you are in observe
 * mode, do not edit files" into the prompt and call it a permission system.
 * It is not one. A model that is having a bad day, or that has been argued
 * into it by something in its context, will edit the file anyway. Prompt
 * text is a request. A tool allowlist is a control.
 *
 * So each level maps to three concrete things:
 *
 *   tools      the allowlist actually passed to the Agent tool
 *   canMerge   whether this agent's branch may land without a human
 *   prompt     the wording that explains the constraint to the agent
 *
 * The prompt text still matters. An agent that knows it cannot write will
 * produce a useful proposal instead of a failed edit. But it is the
 * belt, not the trousers.
 */

import type { AutonomyLevel } from "./types.js";

export type AutonomyPolicy = {
  level: AutonomyLevel;
  /** One-line description for menus and the dashboard. */
  label: string;
  /**
   * Tools this level permits. The delegation path intersects this with the
   * agent's own `tools` allowlist, so an agent can be narrower than its
   * level permits but never wider.
   */
  tools: string[];
  /** May this agent's branch be merged without a human reviewing it? */
  canMerge: boolean;
  /** May this agent write files at all? */
  canWrite: boolean;
  /** Compiled into the system prompt. */
  prompt: string;
};

const READ_TOOLS = ["Read", "Grep", "Glob", "WebFetch", "WebSearch"];
const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"];
const EXEC_TOOLS = ["Bash"];

export const AUTONOMY: Record<AutonomyLevel, AutonomyPolicy> = {
  observe: {
    level: "observe",
    label: "read and report only",
    tools: READ_TOOLS,
    canMerge: false,
    canWrite: false,
    prompt:
      "You have read access only. You cannot write files or run commands. When the task would require changing something, describe precisely what you would change and why, and stop there.",
  },

  propose: {
    level: "propose",
    label: "draft changes, do not apply them",
    // Bash is included because proposing a real change often requires
    // running tests or a build to know the change is sound. The absence of
    // write tools is what makes this level meaningful.
    tools: [...READ_TOOLS, ...EXEC_TOOLS],
    canMerge: false,
    canWrite: false,
    prompt:
      "You may read and run commands, but you cannot write files. Produce the exact change you would make, as a diff or as explicit before/after content, and explain the reasoning. Do not attempt to apply it.",
  },

  execute: {
    level: "execute",
    label: "write in own worktree, human merges",
    tools: [...READ_TOOLS, ...EXEC_TOOLS, ...WRITE_TOOLS],
    canMerge: false,
    canWrite: true,
    prompt:
      "You may read, run commands, and write files. Your changes land on your own branch and a human reviews them before they reach the main branch, so prefer a complete, reviewable change over a partial one. Do not merge anything yourself.",
  },

  autonomous: {
    level: "autonomous",
    label: "write and merge unattended",
    tools: [...READ_TOOLS, ...EXEC_TOOLS, ...WRITE_TOOLS],
    canMerge: true,
    canWrite: true,
    prompt:
      "You may read, run commands, write files, and land your own work. Nobody is reviewing before it merges, so the bar for what you consider finished is higher than usual: verify your change actually works before you call it done, and if you are uncertain, stop and say so rather than merging on a guess.",
  },
};

export function policyFor(level: AutonomyLevel): AutonomyPolicy {
  return AUTONOMY[level] ?? AUTONOMY.execute;
}

/**
 * The tool allowlist for a delegation: what the level permits, narrowed by
 * whatever the agent was hired with. An empty agent allowlist means "no
 * additional narrowing", not "no tools".
 */
export function effectiveTools(
  level: AutonomyLevel,
  agentTools: string[],
): string[] {
  const allowed = policyFor(level).tools;
  if (!agentTools || agentTools.length === 0) return allowed;
  return allowed.filter((t) => agentTools.includes(t));
}

/**
 * Whether an agent at this level should have been able to produce the file
 * changes we are about to commit. Used by the delegation path to catch a
 * write that should not have been possible. That is a signal the allowlist
 * was not applied, which is worth surfacing loudly rather than committing
 * quietly.
 */
export function writeWasPermitted(level: AutonomyLevel): boolean {
  return policyFor(level).canWrite;
}
