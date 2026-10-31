/**
 * Attempts: one task, several tries, one winner kept on the evidence.
 *
 * A task with verifiers, or with more than one sample, runs as attempts.
 * Each attempt is the assignee on one arm, in a worktree of its own on a
 * branch of its own: `ceo/<agent>--<attempt>`. The attempts run at the same
 * time. When every attempt has ended, each finished one is verified. The
 * winner is the passing attempt with the best score, the cheaper one on a
 * tie. One dissent is kept beside it: the best attempt from another arm,
 * pass or fail, so a second opinion survives the decision.
 *
 *   attempt_start  taskId, attemptId, arm, agent, branch, worktree, base, mode
 *   attempt_end    taskId, attemptId, delegationId, outcome, costUsd
 *   verify         one per check per attempt, written by verify.ts
 *   promote        taskId, attemptId, branch, arm, score, dissent
 *
 * A task reaches done only through a promote, which only a passing attempt
 * earns. A task where nothing passed fails, with every attempt's verdict in
 * the ledger. A task whose attempts were all refused by a provider limit
 * goes back to the queue.
 *
 * Two hook lists let other modules join without this file knowing them.
 * `attemptGates` can refuse to start attempts: the outcome budget does.
 * `promoteHooks` run after a promote: evidence-gated merges do.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { append, readLedger } from "./ledger.js";
import { commitAgentWork, hasCommits, isGitRepo, provisionWorktree, teardownWorktree } from "./git.js";
import { projectRoot } from "./paths.js";
import { findAgent } from "./roster.js";
import { chooseArms, taskKind, type ArmChoice } from "./router.js";
import { runDelegation, workdirFor, type RunEvent, type RunHandle, type RunResult } from "./runner.js";
import { findTask, updateTask, type Task } from "./tasks.js";
import { armKey, armLabel, type Arm, type LedgerEntry } from "./types.js";
import { combine, verifyAll, type Verdict } from "./verify.js";

export type AttemptOutcome = "done" | "failed" | "cancelled" | "rate_limited";

export type Attempt = {
  id: string;
  taskId: string;
  agent: string;
  arm: Arm;
  mode: ArmChoice["mode"];
  branch: string | null;
  worktree: string;
  base: string | null;
  delegationId: string | null;
  outcome: AttemptOutcome | null;
  costUsd: number;
  verdict: { pass: boolean; score: number; errored: boolean } | null;
  startedAt: number;
  endedAt: number | null;
};

export type Promotion = {
  taskId: string;
  attempt: Attempt;
  dissent: Attempt | null;
  verdict: Verdict;
};

/** Refuse to start attempts with a reason, or return null to allow. */
export type AttemptGate = (task: Task, n: number, cwd: string) => string | null;
export const attemptGates: AttemptGate[] = [];

/** Run after a task's winner is promoted. Errors are recorded, never thrown. */
export type PromoteHook = (p: Promotion, cwd: string) => Promise<void> | void;
export const promoteHooks: PromoteHook[] = [];

function shortId(): string {
  return randomBytes(3).toString("hex");
}

function headOf(root: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** The worktree name for an attempt: the agent, two hyphens, the attempt. */
export function attemptName(agent: string, attemptId: string): string {
  return `${agent}--${attemptId}`;
}

/** Every attempt of a task, read back from the ledger. */
export function attemptsFor(taskId: string, cwd?: string, entries: LedgerEntry[] = readLedger(cwd)): Attempt[] {
  const byId = new Map<string, Attempt>();
  const verifies = new Map<string, Array<{ required: boolean; weight: number; status: string; score: number | null }>>();
  for (const e of entries) {
    if (e.data.taskId !== taskId) continue;
    if (e.type === "attempt_start") {
      const id = String(e.data.attemptId);
      byId.set(id, {
        id,
        taskId,
        agent: String(e.data.agent ?? e.agent ?? ""),
        arm: e.data.arm as Arm,
        mode: (e.data.mode as ArmChoice["mode"]) ?? "pick",
        branch: typeof e.data.branch === "string" ? e.data.branch : null,
        worktree: String(e.data.worktree ?? ""),
        base: typeof e.data.base === "string" ? e.data.base : null,
        delegationId: null,
        outcome: null,
        costUsd: 0,
        verdict: null,
        startedAt: e.ts,
        endedAt: null,
      });
    } else if (e.type === "attempt_end") {
      const a = byId.get(String(e.data.attemptId));
      if (!a) continue;
      a.delegationId = typeof e.data.delegationId === "string" ? e.data.delegationId : null;
      a.outcome = e.data.outcome as AttemptOutcome;
      a.costUsd = Number(e.data.costUsd ?? 0);
      a.endedAt = e.ts;
    } else if (e.type === "verify" && typeof e.data.attemptId === "string") {
      const v = e.data.verifier as { required?: boolean; weight?: number } | undefined;
      const list = verifies.get(e.data.attemptId) ?? [];
      list.push({ required: v?.required !== false, weight: v?.weight ?? 1, status: String(e.data.status), score: typeof e.data.score === "number" ? e.data.score : null });
      verifies.set(e.data.attemptId, list);
    }
  }
  for (const [id, list] of verifies) {
    const a = byId.get(id);
    if (!a) continue;
    const v = combine(list.map((r) => ({ spec: { kind: "command", run: "", required: r.required, weight: r.weight }, result: { status: r.status as "pass" | "fail" | "error", score: r.score, detail: "", evidence: {} } })));
    a.verdict = { pass: v.pass, score: v.score, errored: v.errored };
  }
  return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** The promotion of a task, if one happened. */
export function promotionOf(taskId: string, cwd?: string): LedgerEntry | null {
  return readLedger(cwd).filter((e) => e.type === "promote" && e.data.taskId === taskId).pop() ?? null;
}

/** Whether a task runs as attempts rather than as one plain run. */
export function usesAttempts(task: Pick<Task, "verifiers" | "samples">): boolean {
  return task.verifiers.length > 0 || task.samples > 1;
}

export type TaskRun = {
  taskId: string;
  attempts: Array<{ id: string; arm: Arm; handle: RunHandle }>;
  /** Resolves when every attempt has ended and the task has settled. */
  finished: Promise<{ status: Task["status"]; winner: Attempt | null; attempts: Attempt[]; note: string }>;
  cancel: () => void;
};

/**
 * Run a task as attempts. Starts every attempt now and returns at once.
 * `onEvent` receives each attempt's run events, tagged with the attempt.
 */
export function runTask(
  taskId: string,
  opts: {
    cwd?: string;
    samples?: number;
    random?: () => number;
    onStart?: (attempt: { id: string; arm: Arm; agent: string; workdir: string; mode: ArmChoice["mode"] }) => void;
    onEvent?: (attemptId: string, e: RunEvent) => void;
    onEnd?: (attemptId: string, result: RunResult) => void;
  } = {},
): TaskRun {
  const cwd = opts.cwd;
  const root = projectRoot(cwd);
  const fail = (note: string): TaskRun => ({
    taskId,
    attempts: [],
    finished: Promise.resolve({ status: "failed" as const, winner: null, attempts: [], note }),
    cancel: () => {},
  });

  const task = findTask(taskId, cwd);
  if (!task) return fail(`No task with id ${taskId}.`);
  if (!task.assignee) return fail("The task has no assignee.");
  const agent = findAgent(task.assignee, cwd);
  if (!agent) return fail(`No agent named "${task.assignee}" in the org.`);

  let n = Math.max(1, Math.floor(opts.samples ?? task.samples));
  const isolated = isGitRepo(root) && hasCommits(root);
  if (!isolated && n > 1) n = 1;
  for (const gate of attemptGates) {
    const reason = gate(task, n, root);
    if (reason) return fail(reason);
  }

  const choices = chooseArms({ title: task.title, kind: task.kind, arms: task.arms, provider: task.provider }, agent, n, { root, random: opts.random });
  const base = isolated ? headOf(root) : null;
  const kind = task.kind ?? taskKind(task.title);
  if (!task.kind) {
    try {
      updateTask(taskId, { kind }, cwd);
    } catch {
      /* the kind is a hint for the router */
    }
  }

  const started: TaskRun["attempts"] = [];
  const results = new Map<string, RunResult>();
  let cancelled = false;

  try {
    updateTask(taskId, { status: "running", note: n > 1 ? `${n} attempts across ${new Set(choices.map((c) => c.arm.provider)).size} providers` : null }, cwd);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  for (const choice of choices) {
    const id = shortId();
    let workdir = workdirFor(agent, cwd);
    let branch: string | null = null;
    if (isolated) {
      try {
        const wt = provisionWorktree(attemptName(agent.name, id), cwd);
        workdir = wt.worktreePath;
        branch = wt.branch;
      } catch (e) {
        append("attempt_start", agent.name, { taskId, attemptId: id, agent: agent.name, arm: choice.arm, mode: choice.mode, why: choice.why, branch: null, worktree: "", base, kind }, cwd);
        append("attempt_end", agent.name, { taskId, attemptId: id, delegationId: null, outcome: "failed", costUsd: 0, error: e instanceof Error ? e.message : String(e) }, cwd);
        continue;
      }
    }
    append("attempt_start", agent.name, { taskId, attemptId: id, agent: agent.name, arm: choice.arm, mode: choice.mode, why: choice.why, branch, worktree: workdir, base, kind }, cwd);
    opts.onStart?.({ id, arm: choice.arm, agent: agent.name, workdir, mode: choice.mode });
    const handle = runDelegation(agent.name, task.title, {
      cwd,
      taskId,
      attempt: { id, arm: choice.arm, workdir },
      ...(task.sandbox ? { sandbox: task.sandbox } : {}),
      onEvent: (e) => opts.onEvent?.(id, e),
    });
    started.push({ id, arm: choice.arm, handle });
    handle.finished.then((r) => {
      results.set(id, r);
      const outcome: AttemptOutcome = r.ok ? "done" : r.error === "cancelled" ? "cancelled" : r.rateLimit ? "rate_limited" : "failed";
      append("attempt_end", agent.name, { taskId, attemptId: id, delegationId: r.delegationId, outcome, costUsd: r.costUsd, ...(r.ok ? {} : { error: (r.error ?? "").slice(0, 300) }) }, cwd);
      opts.onEnd?.(id, r);
    });
  }

  const finished = (async () => {
    await Promise.all(started.map((s) => s.handle.finished));
    // attempt_end entries are appended in the `then` above, which ran first.
    const attempts = attemptsFor(taskId, cwd);
    const mine = attempts.filter((a) => started.some((s) => s.id === a.id) || a.outcome === "failed");

    if (cancelled || (mine.length > 0 && mine.every((a) => a.outcome === "cancelled"))) {
      safeUpdate(taskId, { status: "cancelled", note: "attempts cancelled" }, cwd);
      return { status: "cancelled" as const, winner: null, attempts: mine, note: "cancelled" };
    }
    if (mine.length > 0 && mine.every((a) => a.outcome === "rate_limited")) {
      safeUpdate(taskId, { status: "queued", note: "every attempt hit a provider limit; back in the queue" }, cwd);
      return { status: "queued" as const, winner: null, attempts: mine, note: "rate limited" };
    }

    const finishedOk = mine.filter((a) => a.outcome === "done");
    if (finishedOk.length === 0) {
      const note = `No attempt finished: ${mine.map((a) => `${armLabel(a.arm)} ${a.outcome}`).join(", ") || "none started"}.`;
      safeUpdate(taskId, { status: "failed", note }, cwd);
      return { status: "failed" as const, winner: null, attempts: mine, note };
    }

    safeUpdate(taskId, { status: "verifying", note: task.verifiers.length > 0 ? `verifying ${finishedOk.length} attempt${finishedOk.length === 1 ? "" : "s"}` : null }, cwd);

    const verdicts = new Map<string, Verdict>();
    for (const a of finishedOk) {
      const r = results.get(a.id);
      const verdict =
        task.verifiers.length > 0
          ? await verifyAll(task.verifiers, {
              root,
              workdir: a.worktree || root,
              base: a.base,
              taskId,
              attemptId: a.id,
              delegationId: a.delegationId,
              agent: a.agent,
              task: task.title,
              provider: a.arm.provider,
              scope: "task",
            })
          : combine([]);
      // A task without verifiers passes on a finished run, as it always has.
      verdicts.set(a.id, task.verifiers.length > 0 ? verdict : { ...verdict, pass: true, score: 1 });
      void r;
    }

    const ranked = finishedOk
      .map((a) => ({ a, v: verdicts.get(a.id)! }))
      .sort((x, y) => Number(y.v.pass) - Number(x.v.pass) || y.v.score - x.v.score || x.a.costUsd - y.a.costUsd);
    const best = ranked[0];
    const after = attemptsFor(taskId, cwd).filter((a) => mine.some((m) => m.id === a.id));

    if (!best || !best.v.pass) {
      const errored = ranked.some((r) => r.v.errored);
      const note = `No attempt passed${errored ? ", and a check could not run" : ""}: ${ranked.map((r) => `${armLabel(r.a.arm)} ${r.v.score.toFixed(2)}`).join(", ")}.`;
      safeUpdate(taskId, { status: "failed", note }, cwd);
      cleanup(after, ranked[0]?.a.id ?? null, null, agent.name, cwd);
      return { status: "failed" as const, winner: null, attempts: after, note };
    }

    const winner = best.a;
    const dissentRow = ranked.find((r) => r.a.id !== winner.id && armKey(r.a.arm) !== armKey(winner.arm)) ?? ranked.find((r) => r.a.id !== winner.id) ?? null;
    if (winner.branch) {
      try {
        commitAgentWork(attemptName(agent.name, winner.id), task.title, { ledgerSeq: readLedger(cwd).length, costUsd: winner.costUsd }, cwd);
      } catch {
        /* nothing to commit, or the commit failed; the branch still holds the worktree */
      }
    }
    append("promote", agent.name, {
      taskId,
      attemptId: winner.id,
      branch: winner.branch,
      arm: winner.arm,
      score: best.v.score,
      costUsd: winner.costUsd,
      attempts: ranked.length,
      dissent: dissentRow ? { attemptId: dissentRow.a.id, branch: dissentRow.a.branch, arm: dissentRow.a.arm, pass: dissentRow.v.pass, score: dissentRow.v.score } : null,
    }, cwd);
    const note = `won by ${armLabel(winner.arm)}, score ${best.v.score.toFixed(2)}${ranked.length > 1 ? ` of ${ranked.length} attempts` : ""}${winner.branch ? ` on ${winner.branch}` : ""}`;
    safeUpdate(taskId, { status: "done", note }, cwd);
    cleanup(after, winner.id, dissentRow?.a.id ?? null, agent.name, cwd);

    const promoted = attemptsFor(taskId, cwd).find((a) => a.id === winner.id) ?? winner;
    const dissent = dissentRow ? attemptsFor(taskId, cwd).find((a) => a.id === dissentRow.a.id) ?? null : null;
    for (const hook of promoteHooks) {
      try {
        await hook({ taskId, attempt: promoted, dissent, verdict: best.v }, root);
      } catch (e) {
        append("note", agent.name, { kind: "promote_hook_failed", taskId, detail: e instanceof Error ? e.message : String(e) }, cwd);
      }
    }
    return { status: "done" as const, winner: promoted, attempts: attemptsFor(taskId, cwd), note };
  })();

  return {
    taskId,
    attempts: started,
    finished,
    cancel: () => {
      cancelled = true;
      for (const s of started) s.handle.cancel();
    },
  };
}

function safeUpdate(taskId: string, changes: Parameters<typeof updateTask>[1], cwd?: string): void {
  try {
    updateTask(taskId, changes, cwd);
  } catch {
    /* the attempts and verdicts are in the ledger either way */
  }
}

/** Remove the worktrees of attempts that lost. The winner's and the dissent's stay. Branches stay. */
function cleanup(attempts: Attempt[], keep: string | null, dissent: string | null, agent: string, cwd?: string): void {
  for (const a of attempts) {
    if (!a.branch || a.id === keep || a.id === dissent) continue;
    try {
      teardownWorktree(attemptName(agent, a.id), {}, cwd);
    } catch {
      /* a worktree left behind costs disk, not correctness */
    }
  }
}
