/**
 * Delegation runs the dashboard owns.
 *
 * `actions.ts` holds every write that finishes inside one keystroke. This is
 * the other kind: a write that takes minutes, streams while it happens, and
 * can be cancelled halfway. It is separate for that reason alone: a hire is
 * a function call, a delegation is a process.
 *
 * Everything to do with money, permissions, worktrees, and the ledger belongs
 * to `core/runner.ts` and is not repeated here. `runDelegation` has already
 * written `delegate_start` before it returns, has already applied the autonomy
 * allowlist as `--allowed-tools`, and will write `delegate_end` however the
 * process ends. This module does one job: turn the event stream into something
 * a component can render, and keep the handles so a run can be killed.
 *
 * Two consequences of that division are worth stating out loud, because the UI
 * has to tell the truth about both:
 *
 *   A cancelled run still cost money. `cancel()` kills the process. It does
 *   not un-spend what the tokens already consumed. The runner closes the
 *   ledger entry with the settled cost. That is why the final numbers here
 *   come from `handle.finished` rather than from the `done` event. A
 *   cancelled run never emits `done`, but it does have a cost.
 *
 *   A denial is not an error. An agent reaching for a tool its level forbids
 *   completes normally. The attempt shows up in `permission_denials`. It is
 *   kept as its own line kind so the pane can put it in red rather than
 *   letting it scroll past as ordinary output.
 */

import "../core/evidence.js";
import { runTask, type TaskRun } from "../core/attempts.js";
import { armLabel } from "../core/types.js";
import { useCallback, useEffect, useRef, useState } from "react";

import { runDelegation, type RunEvent, type RunHandle, type RunResult } from "../core/runner.js";
import type { Provider } from "../core/types.js";

/**
 * Event lines kept per run. A long agent turn can emit thousands. The pane
 * shows the tail, so the head is dropped rather than held forever. The full
 * output is on disk in `.ceo/outputs/<id>.md` either way.
 */
const MAX_LINES = 400;

export type RunLineKind = "text" | "tool" | "denied";

/** One thing the agent did, in the order it did it. */
export type RunLine = { kind: RunLineKind; text: string };

/** `waiting`: a provider limit refused the run, and the task is back in the queue until `retryAt`. */
export type RunStatus = "running" | "done" | "failed" | "cancelled" | "waiting";

/** Map key for a run: one run per agent per workspace. */
export function runKey(workspace: string, agent: string): string {
  return `${workspace}\u0000${agent}`;
}

export type RunState = {
  /** Git root of the workspace the run belongs to. */
  workspace: string;
  agent: string;
  /** Queue task this run is executing, when it came from the queue. */
  taskId: string | null;
  task: string;
  /** Which CLI the run went through, once started. */
  provider: Provider | null;
  model: string | null;
  /** What the process enforces: the allowlist for claude or the sandbox for codex. */
  tools: string[];
  /** Worktree for an isolated agent, the project root otherwise. */
  workdir: string | null;
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus;
  lines: RunLine[];
  /** True once lines have been dropped off the top of the buffer. */
  truncated: boolean;
  /** Tools the agent attempted that its autonomy level forbade. */
  denials: string[];
  costUsd: number;
  /** True when the figure was computed from tokens at list prices. That is every codex run and any cancelled claude run. */
  costIsEstimate: boolean;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error: string | null;
  /** Set when cancel() is called, which is before the process actually dies. */
  cancelRequested: boolean;
  /** Turns so far: one, plus one per delivery of teammates' notes. */
  turns: number;
  /** When a waiting run's provider is expected back. */
  retryAt: number | null;
  /** Set when the run is one attempt of a sampled task. */
  attemptId: string | null;
  /** The attempt's arm, as a label: "codex gpt-5". */
  arm: string | null;
};

/** Whether a start or cancel was accepted, and what to put on the flash line. */
export type RunOutcome = { ok: boolean; message: string };

/** What a chat message needs from a run beyond a task: see `core/chat.ts`. */
export type StartOptions = {
  /** Resume this CLI session rather than opening a new one. */
  resumeSessionId?: string | null;
  /** What the process receives, when it differs from the recorded task. */
  prompt?: string;
  /** Recorded on the start entry, such as "chat". */
  via?: string;
  /** Called once the run has settled and the ledger has its end entry. */
  onFinished?: (result: RunResult) => void;
};

function blank(
  workspace: string,
  agent: string,
  task: string,
  taskId: string | null,
  startedAt: number,
): RunState {
  return {
    workspace,
    agent,
    taskId,
    task,
    provider: null,
    model: null,
    tools: [],
    workdir: null,
    startedAt,
    finishedAt: null,
    status: "running",
    lines: [],
    truncated: false,
    denials: [],
    costUsd: 0,
    costIsEstimate: false,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    error: null,
    cancelRequested: false,
    turns: 1,
    retryAt: null,
    attemptId: null,
    arm: null,
  };
}

/**
 * Append, merging consecutive text into one line.
 *
 * The runner emits one `text` event per assistant content block, and a single
 * paragraph frequently arrives as several. Pushing each as its own line would
 * put a hard break wherever the model happened to pause.
 */
function appendLine(run: RunState, line: RunLine): RunState {
  const lines = run.lines.slice();
  const last = lines[lines.length - 1];
  if (line.kind === "text" && last && last.kind === "text") {
    lines[lines.length - 1] = { kind: "text", text: last.text + line.text };
  } else {
    lines.push(line);
  }
  let truncated = run.truncated;
  if (lines.length > MAX_LINES) {
    lines.splice(0, lines.length - MAX_LINES);
    truncated = true;
  }
  return { ...run, lines, truncated };
}

/** Fold one runner event into the run's state. Pure, so it is testable. */
export function reduceRun(run: RunState, e: RunEvent): RunState {
  switch (e.type) {
    case "started":
      return { ...run, task: e.task, provider: e.provider, model: e.model, tools: e.tools, workdir: e.cwd, status: "running" };
    case "text":
      return appendLine(run, { kind: "text", text: e.text });
    case "tool":
      return appendLine(run, { kind: "tool", text: e.summary });
    case "denied":
      return {
        ...appendLine(run, { kind: "denied", text: e.tool }),
        denials: [...run.denials, e.tool],
      };
    case "turn":
      // A follow-up turn: the session resumed with what teammates posted.
      return { ...appendLine(run, { kind: "tool", text: `turn ${e.n}: ${e.reason}` }), turns: e.n };
    case "done":
      return {
        ...run,
        status: "done",
        turns: e.turns,
        costUsd: e.costUsd,
        costIsEstimate: e.costIsEstimate,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        durationMs: e.durationMs,
        finishedAt: Date.now(),
      };
    case "failed":
      return {
        ...run,
        status: run.cancelRequested ? "cancelled" : e.retryAt ? "waiting" : "failed",
        retryAt: e.retryAt ?? null,
        error: e.error,
        finishedAt: Date.now(),
        durationMs: run.durationMs || Date.now() - run.startedAt,
      };
  }
}

export type Runs = {
  /**
   * Keyed by `runKey(workspace, agent)`, which is also what makes a second
   * run for the same agent in the same org refusable.
   */
  runs: Map<string, RunState>;
  start: (workspace: string, agent: string, task: string, taskId?: string | null, opts?: StartOptions) => RunOutcome;
  cancel: (workspace: string, agent: string) => RunOutcome;
  /** Drop a settled run from the pane. Refuses while it is still running. */
  dismiss: (workspace: string, agent: string) => void;
  /**
   * Run a task as attempts, one run per arm, verified when every attempt
   * ends. Each attempt shows as its own run, keyed by agent and attempt.
   */
  startTask: (workspace: string, taskId: string, onDone?: (status: string, note: string) => void) => RunOutcome;
};

/**
 * Run delegations and keep their live state, across every workspace the
 * dashboard has open.
 *
 * `onSettled` fires when a run finishes, however it finished. It is where the
 * dashboard re-reads `.ceo/`: the ledger and the roster both moved, and the
 * spend figure on screen is stale until it does. It receives the workspace so
 * the caller can refresh the right org.
 */
/** A run that settled, for alerts. */
export type FinishedRun = { workspace: string; agent: string; task: string; taskId: string | null; result: RunResult };

export function useRuns(onSettled: (workspace: string) => void, onFinished?: (run: FinishedRun) => void): Runs {
  const [runs, setRuns] = useState<Map<string, RunState>>(() => new Map());

  // Handles are not state: nothing renders from them. A cancel issued from a
  // keypress must reach the process that is running now rather than
  // whichever one the last render closed over.
  const handles = useRef<Map<string, RunHandle>>(new Map());

  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  }, [onSettled]);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  const update = useCallback((key: string, fn: (r: RunState) => RunState) => {
    setRuns((prev) => {
      const current = prev.get(key);
      if (!current) return prev;
      const next = new Map(prev);
      next.set(key, fn(current));
      return next;
    });
  }, []);

  // Killing the children on unmount is the difference between quitting the
  // dashboard and leaving orphaned `claude` processes billing in the
  // background. The ledger entry may be left dangling, which is the honest
  // record of a run that was cut off, and what the auditor looks for.
  useEffect(() => {
    const live = handles.current;
    return () => {
      for (const handle of live.values()) handle.cancel();
      live.clear();
    };
  }, []);

  const start = useCallback(
    (workspace: string, agent: string, task: string, taskId: string | null = null, opts: StartOptions = {}): RunOutcome => {
      const key = runKey(workspace, agent);
      if (handles.current.has(key)) {
        return {
          ok: false,
          message: `${agent} is already running. One run per agent. Wait for it, or press c to cancel it.`,
        };
      }

      setRuns((prev) => {
        const next = new Map(prev);
        next.set(key, blank(workspace, agent, task, taskId, Date.now()));
        return next;
      });

      // `runDelegation` emits synchronously before it returns, either
      // `started` or `failed` when the budget gate refuses. So the placeholder
      // above has to be queued first for those events to land anywhere.
      const handle = runDelegation(agent, task, {
        cwd: workspace,
        taskId: taskId ?? undefined,
        resumeSessionId: opts.resumeSessionId ?? null,
        prompt: opts.prompt,
        via: opts.via,
        onEvent: (e) => update(key, (run) => reduceRun(run, e)),
      });
      handles.current.set(key, handle);

      handle.finished
        .then((result) => {
          try {
            opts.onFinished?.(result);
          } catch {
            /* a caller's follow-up must not mark a settled run as failed */
          }
          try {
            finishedRef.current?.({ workspace, agent, task, taskId, result });
          } catch {
            /* an alert that fails must not mark a settled run as failed */
          }
          // The settled numbers, not the ones from the `done` event: a
          // cancelled or failed run never emits `done` but still has a cost.
          // Reporting zero for it would understate what was spent.
          update(key, (run) => ({
            ...run,
            status: run.cancelRequested ? "cancelled" : result.ok ? "done" : result.rateLimit ? "waiting" : "failed",
            retryAt: result.rateLimit?.retryAt ?? null,
            costUsd: result.costUsd,
            costIsEstimate: result.costIsEstimate,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            durationMs: result.durationMs,
            denials: result.denials.length > 0 ? result.denials : run.denials,
            error: result.ok ? null : result.error,
            finishedAt: Date.now(),
          }));
        })
        .catch((e: unknown) => {
          // Only reachable if closing the ledger entry itself threw, which
          // means the run happened and the record of it may not have.
          update(key, (run) => ({
            ...run,
            status: "failed",
            error: `run finished but bookkeeping failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
            finishedAt: Date.now(),
          }));
        })
        .finally(() => {
          handles.current.delete(key);
          settled.current(workspace);
        });

      return { ok: true, message: `${agent} started.` };
    },
    [update],
  );

  const cancel = useCallback(
    (workspace: string, agent: string): RunOutcome => {
      const key = runKey(workspace, agent);
      const handle = handles.current.get(key);
      if (!handle) return { ok: false, message: `${agent} is not running.` };
      update(key, (run) => ({ ...run, cancelRequested: true }));
      handle.cancel();
      return {
        ok: false,
        message: `Cancelling ${agent}. What it already spent is real, and the delegation stays in the ledger.`,
      };
    },
    [update],
  );

  const dismiss = useCallback((workspace: string, agent: string) => {
    const key = runKey(workspace, agent);
    if (handles.current.has(key)) return;
    setRuns((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const taskRuns = useRef<Map<string, TaskRun>>(new Map());

  const startTask = useCallback(
    (workspace: string, taskId: string, onDone?: (status: string, note: string) => void): RunOutcome => {
      const tkey = `${workspace}\u0000${taskId}`;
      if (taskRuns.current.has(tkey)) return { ok: false, message: `Task ${taskId} is already running.` };
      const keyOf = (agent: string, attemptId: string) => runKey(workspace, `${agent}#${attemptId}`);
      const agentOf = new Map<string, string>();
      const run = runTask(taskId, {
        cwd: workspace,
        onStart: (a) => {
          agentOf.set(a.id, a.agent);
          const key = keyOf(a.agent, a.id);
          setRuns((prev) => {
            const next = new Map(prev);
            next.set(key, { ...blank(workspace, a.agent, "", taskId, Date.now()), attemptId: a.id, arm: armLabel(a.arm) });
            return next;
          });
        },
        onEvent: (id, e) => {
          const agent = agentOf.get(id);
          if (agent) update(keyOf(agent, id), (r) => reduceRun(r, e));
        },
        onEnd: (id, result) => {
          const agent = agentOf.get(id);
          if (!agent) return;
          update(keyOf(agent, id), (r) => ({
            ...r,
            status: r.cancelRequested ? "cancelled" : result.ok ? "done" : result.rateLimit ? "waiting" : "failed",
            retryAt: result.rateLimit?.retryAt ?? null,
            costUsd: result.costUsd,
            costIsEstimate: result.costIsEstimate,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            durationMs: result.durationMs,
            error: result.ok ? null : result.error,
            finishedAt: Date.now(),
          }));
        },
      });
      if (run.attempts.length === 0) {
        void run.finished.then((out) => onDone?.(out.status, out.note));
        settled.current(workspace);
        return { ok: false, message: "No attempt could start. The task says why." };
      }
      taskRuns.current.set(tkey, run);
      for (const a of run.attempts) handles.current.set(keyOf(agentOf.get(a.id) ?? "", a.id), a.handle);
      void run.finished
        .then((out) => onDone?.(out.status, out.note))
        .finally(() => {
          taskRuns.current.delete(tkey);
          for (const a of run.attempts) handles.current.delete(keyOf(agentOf.get(a.id) ?? "", a.id));
          settled.current(workspace);
        });
      return { ok: true, message: `${run.attempts.length} attempt${run.attempts.length === 1 ? "" : "s"} started.` };
    },
    [update],
  );

  return { runs, start, cancel, dismiss, startTask };
}
