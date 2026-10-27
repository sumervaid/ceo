/**
 * Delegation lifecycle.
 *
 * CEO does not spawn subagents itself. Claude Code's Agent tool does
 * that. What CEO owns is the bookkeeping around it:
 *
 *   1. `begin()` runs the budget gate and writes `delegate_start`.
 *   2. Claude Code spawns the subagent and gets a result.
 *   3. `end()` archives the output, writes `delegate_end` with settled
 *      cost, and, for isolated agents, commits the worktree.
 *
 * Splitting start from end means an interrupted delegation leaves a
 * dangling `delegate_start` in the ledger, which is exactly the signal the
 * auditor needs to report "this agent was cut off mid-task".
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { append, readLedger } from "./ledger.js";
import { budgetCheck, findAgent } from "./roster.js";
import { commitAgentWork, worktreeStatus } from "./git.js";
import { outputsDir } from "./paths.js";
import type { DelegationCost, LedgerEntry } from "./types.js";

export type DelegationHandle = {
  /** Short id used for the output filename and cross-referencing. */
  id: string;
  agent: string;
  task: string;
  startedAt: number;
  startSeq: number;
};

export type DelegationResult = {
  handle: DelegationHandle;
  outputPath: string;
  cost: DelegationCost;
  commit: { sha: string; files: string[] } | null;
};

function shortId(): string {
  return randomBytes(3).toString("hex");
}

/**
 * Open a delegation. Throws when the agent is unknown or over budget, so
 * the caller never dispatches work that cannot be paid for.
 */
export function begin(
  agent: string,
  task: string,
  cwd?: string,
  /**
   * Recorded on the start entry beside the task: the provider, model and
   * enforcement the run is about to be started with. Optional because the
   * MCP path opens delegations it does not run itself.
   */
  meta: Record<string, unknown> = {},
): DelegationHandle {
  const gate = budgetCheck(agent, cwd);
  if (gate) throw new Error(gate);
  // A chat message may be one word. A delegated task may not.
  if (!task || task.trim().length < (meta.via === "chat" ? 1 : 3)) {
    throw new Error("Delegation task text is required.");
  }

  const id = shortId();
  const entry = append("delegate_start", agent, { ...meta, id, task: task.trim() }, cwd);

  return {
    id,
    agent,
    task: task.trim(),
    startedAt: entry.ts,
    startSeq: entry.seq,
  };
}

/**
 * Close a delegation: archive the output, record settled cost, and commit
 * the agent's worktree when it is isolated and dirty.
 */
export function end(
  handle: DelegationHandle,
  output: string,
  cost: DelegationCost,
  cwd?: string,
): DelegationResult {
  const dir = outputsDir(cwd);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const outputPath = path.join(dir, `${handle.id}.md`);
  const header = [
    `# Delegation ${handle.id}`,
    "",
    `- Agent: ${handle.agent}`,
    `- Started: ${new Date(handle.startedAt).toISOString()}`,
    `- Ended: ${new Date().toISOString()}`,
    `- Duration: ${(cost.durationMs / 1000).toFixed(1)}s`,
    `- Cost: $${cost.costUsd.toFixed(6)}${cost.costIsEstimate ? ` · estimate, ${cost.costBasis ?? "list price"}` : ""}`,
    `- Tokens: ${cost.inputTokens} in / ${cost.outputTokens} out`,
    "",
    "## Task",
    "",
    handle.task,
    "",
    "## Output",
    "",
  ].join("\n");
  writeFileSync(outputPath, header + output + "\n", "utf8");

  const endEntry = append("delegate_end", handle.agent, {
    id: handle.id,
    startSeq: handle.startSeq,
    outputPath,
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    costUsd: cost.costUsd,
    costIsEstimate: cost.costIsEstimate ?? false,
    costBasis: cost.costBasis ?? (cost.costIsEstimate ? "list-price" : "settled"),
    turns: cost.turns ?? 1,
    ...(cost.sessionId ? { sessionId: cost.sessionId } : {}),
    ...(cost.outcome ? { outcome: cost.outcome } : {}),
    durationMs: cost.durationMs,
    outputChars: output.length,
  }, cwd);

  // Isolated agents get their file changes committed to their own branch
  // with the ledger seq baked into the trailer.
  let commit: { sha: string; files: string[] } | null = null;
  const record = findAgent(handle.agent, cwd);
  if (record?.isolated && record.worktreePath) {
    const dirty = worktreeStatus(handle.agent, cwd);
    if (dirty.length > 0) {
      commit = commitAgentWork(
        handle.agent,
        `ceo(${handle.agent}): ${handle.task.slice(0, 60)}`,
        { ledgerSeq: endEntry.seq, costUsd: cost.costUsd },
        cwd,
      );
    }
  }

  return { handle, outputPath, cost, commit };
}

/**
 * `delegate_start` entries with no matching `delegate_end`. These are
 * interrupted delegations: the agent was dispatched but never reported
 * back. Surfaced by the auditor and by /roster.
 */
export function danglingDelegations(cwd?: string): LedgerEntry[] {
  const entries = readLedger(cwd);
  const ended = new Set<string>();
  for (const e of entries) {
    if (e.type === "delegate_end") ended.add(String(e.data.id ?? ""));
  }
  return entries.filter(
    (e) => e.type === "delegate_start" && !ended.has(String(e.data.id ?? "")),
  );
}

/** Paired start/end records for the last N delegations, newest first. */
export function recentDelegations(
  n: number,
  cwd?: string,
): Array<{
  id: string;
  agent: string | null;
  task: string;
  costUsd: number;
  durationMs: number;
  ts: number;
  outputPath: string | null;
  complete: boolean;
}> {
  const entries = readLedger(cwd);
  const starts = new Map<string, LedgerEntry>();
  for (const e of entries) {
    if (e.type === "delegate_start") starts.set(String(e.data.id ?? ""), e);
  }

  const rows: ReturnType<typeof recentDelegations> = [];
  for (const e of entries) {
    if (e.type !== "delegate_end") continue;
    const id = String(e.data.id ?? "");
    const start = starts.get(id);
    rows.push({
      id,
      agent: e.agent,
      task: String(start?.data.task ?? "(task text missing)"),
      costUsd: Number(e.data.costUsd ?? 0),
      durationMs: Number(e.data.durationMs ?? 0),
      ts: e.ts,
      outputPath: (e.data.outputPath as string | null) ?? null,
      complete: true,
    });
    starts.delete(id);
  }

  // Whatever remains in `starts` never completed.
  for (const [id, s] of starts) {
    rows.push({
      id,
      agent: s.agent,
      task: String(s.data.task ?? ""),
      costUsd: 0,
      durationMs: 0,
      ts: s.ts,
      outputPath: null,
      complete: false,
    });
  }

  rows.sort((a, b) => b.ts - a.ts);
  return rows.slice(0, n);
}
