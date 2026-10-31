/**
 * Runs an agent by spawning a headless agent CLI: `claude -p`, `codex exec`
 * or `agy -p`.
 *
 * CEO never runs inside any of them. It invokes them itself, which is what
 * lets the dashboard run agents from a tmux session, from cron, or from CI,
 * and what lets one org mix providers, with every agent ledgered the same
 * way whichever CLI runs it.
 *
 * A delegation is a sequence of turns on one CLI session. The first turn is
 * the task. A follow-up turn happens when teammates posted notes or asked
 * questions while the agent worked: the session is resumed and the notes
 * are the next prompt, so the agent hears the org between turns the way a
 * person reads messages between meetings. The ledger closes once, with the
 * cost of every turn.
 *
 * Three things make this worth doing rather than shelling out naively:
 *
 *   Autonomy becomes enforcement. The level is applied by the child process,
 *   with `--allowed-tools` for claude, `--sandbox` for codex and `--mode`
 *   for gemini. An observe agent does not merely promise not to write. It
 *   cannot. Anything it tried anyway comes back as a denial, which is an
 *   audit signal you cannot get from prompt wording.
 *
 *   Cost is measured where it can be and estimated where it cannot, and the
 *   ledger says which. claude reports a settled total. codex and gemini
 *   report tokens only, so their runs are costed from list prices and
 *   recorded as estimates. A run that spent money never settles at $0.
 *
 *   Isolation is real. The process runs with cwd set to the agent's
 *   worktree, so parallel agents genuinely cannot see each other's edits.
 *
 * Every event of every turn is also appended to `.ceo/runs/<id>.jsonl`, the
 * run's live trace, which is what teammates read with org_running and
 * org_trace while the run is still going.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { orgContext, pendingNotesFor, traceAppend, type OrgMessage } from "./collab.js";
import { ORG_SERVER_NAME, orgToolsFor } from "../mcp/collab.js";
import { compileAgentPrompt } from "./compile.js";
import { effectiveTools, policyFor } from "./autonomy.js";
import { begin, end } from "./delegation.js";
import { current as currentMission } from "./mission.js";
import { findAgent } from "./roster.js";
import { append, lastEntry } from "./ledger.js";
import { estimateCostUsd } from "./pricing.js";
import { chiefDir, projectRoot } from "./paths.js";
import { staffingFor } from "./chat.js";
import { contextFor, type ResolvedContext } from "./context.js";
import { cooldowns, detectRateLimit, noteRateLimit } from "./limits.js";
import { newParseState, providerFor, type CollabServer, type ParseState, type ProviderSpec, type RunPlan } from "./providers.js";
import { notReadyReason } from "./setup.js";
import {
  describeSandboxSpawnError,
  sandboxFor,
  sandboxHooks,
  sandboxInfo,
  sandboxReadiness,
  sandboxStubViolation,
  wrapPlan,
  type SandboxKind,
} from "./sandbox.js";
import { findTask, updateTask } from "./tasks.js";
import type { AgentRecord, Arm, Provider } from "./types.js";

export type RunEvent =
  | {
      type: "started";
      agent: string;
      task: string;
      provider: Provider;
      model: string;
      /** What the process enforces: the allowlist for claude, the sandbox for codex, the mode for gemini. */
      tools: string[];
      cwd: string;
    }
  /** Assistant text as it streams. */
  | { type: "text"; text: string }
  /** A tool or command the agent invoked, for the activity feed. */
  | { type: "tool"; name: string; summary: string }
  /** The agent tried something its autonomy level forbids. */
  | { type: "denied"; tool: string }
  /** A follow-up turn began: the session was resumed with what teammates posted. */
  | { type: "turn"; n: number; reason: string }
  | { type: "done"; costUsd: number; costIsEstimate: boolean; inputTokens: number; outputTokens: number; durationMs: number; text: string; turns: number }
  /** `retryAt` is set when a provider limit refused the run. The task went back to the queue. */
  | { type: "failed"; error: string; retryAt?: number };

export type RunHandle = {
  /** Kill the underlying process and stop any further turns. */
  cancel: () => void;
  /** Resolves when the run finishes, one way or another. */
  finished: Promise<RunResult>;
};

export type RunResult = {
  ok: boolean;
  text: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** Tools or commands the agent attempted that its autonomy level forbade. */
  denials: string[];
  error: string | null;
  /**
   * True when costUsd was derived from token counts at list prices rather
   * than reported settled by the process: every codex and gemini run, and a
   * claude run that was cancelled or crashed. The money was still spent. The
   * figure is just less exact.
   */
  costIsEstimate: boolean;
  /** How many turns the session ran: one, plus one per delivery of teammates' notes. */
  turns: number;
  /** The delegation the run was recorded as, or null when nothing was written. */
  delegationId: string | null;
  /** The CLI session, so a later run can resume the conversation. */
  sessionId: string | null;
  /** Set when a provider's rate or usage limit refused the run. The task went back to the queue. */
  rateLimit?: { provider: Provider; retryAt: number; reason: string } | null;
};

const COLLAB_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp", "collab-index.js");

/** Follow-up turns a run may take before it stops listening to the board. */
export function maxFollowUps(): number {
  const n = Number(process.env.CEO_MAX_TURNS);
  return Number.isFinite(n) && n >= 0 ? n : 6;
}

/**
 * The org MCP server for one run, or null when the run cannot have it.
 * CEO_NO_COLLAB turns the surface off. On gemini the server is declared by
 * a file in the workspace rather than a flag, so it is only written into
 * an isolated agent's worktree; a shared tree is the person's, not CEO's.
 * `depth` is how many asks deep this run is: an asked agent's run gets 1
 * and may not ask onward, which is what keeps two agents from paying each
 * other to think in a loop.
 */
export function collabServerFor(
  agent: AgentRecord,
  root: string,
  delegationId: string | null,
  depth = 0,
): CollabServer | null {
  if (process.env.CEO_NO_COLLAB?.trim()) return null;
  // A chief on gemini runs in a directory of its own under `.ceo/`, where
  // the server's config file is CEO's to write. See workdirFor.
  if (agent.provider === "gemini" && !(agent.isolated && agent.worktreePath) && !agent.chief) return null;
  return {
    name: ORG_SERVER_NAME,
    command: process.execPath,
    args: [
      COLLAB_ENTRY,
      "--agent", agent.name,
      "--root", root,
      "--depth", String(depth),
      ...(delegationId ? ["--delegation", delegationId] : []),
    ],
    tools: orgToolsFor(agent),
  };
}

/** Where an agent's process should run. */
export function workdirFor(agent: AgentRecord, cwd?: string): string {
  if (agent.isolated && agent.worktreePath) return agent.worktreePath;
  if (agent.chief && agent.provider === "gemini") return chiefDir(agent.name, cwd);
  return projectRoot(cwd);
}

/**
 * The level the agent's own process is started at. The chief of staff's
 * process is read-only whatever the chief's level, because the chief's
 * level governs staffing, not editing. See `core/chat.ts`.
 */
export function processLevelFor(agent: AgentRecord): AgentRecord["autonomy"] {
  return agent.chief ? "observe" : agent.autonomy;
}

function failedResult(error: string, durationMs = 0): RunResult {
  return {
    ok: false, text: "", costUsd: 0, inputTokens: 0, outputTokens: 0,
    durationMs, denials: [], error, costIsEstimate: false, turns: 0,
    delegationId: null, sessionId: null,
  };
}

function immediate(result: RunResult): RunHandle {
  return { cancel: () => {}, finished: Promise.resolve(result) };
}

/** A missing binary is the likeliest first failure. Say what to install. */
function describeSpawnError(spec: ProviderSpec, binary: string, e: NodeJS.ErrnoException): string {
  if (e.code === "ENOENT") {
    const install =
      spec.id === "codex"
        ? "npm i -g @openai/codex"
        : spec.id === "gemini"
          ? "curl -fsSL https://antigravity.google/cli/install.sh | bash"
          : "npm i -g @anthropic-ai/claude-code";
    return `${binary} is not installed or not on PATH. Install with ${install}, or set CEO_${spec.id.toUpperCase()}_BIN.`;
  }
  return `Could not start ${binary}: ${e.message}`;
}

/** The prompt of a follow-up turn: what arrived, and what to do about it. */
export function followUpPrompt(notes: OrgMessage[]): string {
  const lines = notes.map((m) => {
    const who = m.to === "*" ? `${m.from} (to everyone)` : m.from;
    return m.askId ? `- ${who} asks (ask ${m.askId}): ${m.text}` : `- ${who}: ${m.text}`;
  });
  return [
    "While you were working, teammates posted:",
    ...lines,
    "",
    "Continue the task with this in mind. Answer any question with org_post to its author, giving the ask id. If nothing changes, say so in one line and finish.",
  ].join("\n");
}

type TurnOutcome = {
  state: ParseState;
  code: number | null;
  stderr: string;
  spawnError: string | null;
  cancelled: boolean;
};

/** One process: spawn, stream, settle. The caller owns the ledger. */
function runTurn(
  plan: RunPlan,
  workdir: string,
  spec: ProviderSpec,
  onEvent: (e: RunEvent) => void,
  register: (proc: ChildProcess | null) => void,
  /** Words for a launcher that cannot start. Defaults to the provider's install hint. */
  describe: (binary: string, e: NodeJS.ErrnoException) => string = (binary, e) => describeSpawnError(spec, binary, e),
): Promise<TurnOutcome> {
  return new Promise<TurnOutcome>((resolve) => {
    const st = newParseState();
    let proc: ChildProcess;
    try {
      proc = spawn(plan.binary, plan.args, {
        cwd: workdir,
        stdio: [plan.stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ state: st, code: null, stderr: "", spawnError: describe(plan.binary, e as NodeJS.ErrnoException), cancelled: false });
      return;
    }
    register(proc);

    if (plan.stdin !== null && proc.stdin) {
      proc.stdin.on("error", () => {
        /* the child exited before reading. Its exit code tells the story */
      });
      proc.stdin.end(plan.stdin);
    }

    let stdout = "";
    let stderr = "";
    let spawnError: string | null = null;
    let cancelled = false;

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      let idx: number;
      while ((idx = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, idx).trim();
        stdout = stdout.slice(idx + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        for (const ev of spec.parse(msg, st)) onEvent(ev);
      }
    });
    proc.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("error", (e: NodeJS.ErrnoException) => {
      spawnError = describe(plan.binary, e);
    });
    proc.once("exit", (_code, signal) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") cancelled = true;
    });
    proc.on("close", (code) => {
      register(null);
      resolve({ state: st, code, stderr, spawnError, cancelled });
    });
  });
}

/**
 * Run one delegation. Writes `delegate_start` immediately and
 * `delegate_end` when the last turn settles, so an interrupted run leaves
 * the dangling entry the auditor looks for.
 */
export function runDelegation(
  agentName: string,
  task: string,
  opts: {
    cwd?: string;
    onEvent?: (e: RunEvent) => void;
    /** Extra CLI args, mostly for testing. Appended after the provider's own. */
    extraArgs?: string[];
    /**
     * Queue task this run is for. The task is marked running with the
     * delegation id when the run starts and settled with the run's outcome,
     * so the queue and the ledger's delegation pair always agree about which
     * run belonged to which piece of work.
     */
    taskId?: string;
    /** The delegation that asked for this one through org_ask, when one did. */
    parentDelegationId?: string | null;
    /** How many asks deep this run is. An asked agent's run is 1 and may not ask onward. */
    depth?: number;
    /**
     * Resume this CLI session for the first turn instead of opening a new
     * one. The chat uses it so a conversation is one session.
     */
    resumeSessionId?: string | null;
    /**
     * What the process receives, when it differs from the task the ledger
     * records. The chat records the operator's words and sends them with
     * what changed in the org since the last reply.
     */
    prompt?: string;
    /** Recorded on the start entry: where the run came from, such as "chat". */
    via?: string;
    /**
     * Run on this provider instead of the agent's own, for this run only.
     * A queue task that names a provider applies it without this option.
     */
    provider?: Provider | null;
    /**
     * One attempt of a sampled task: run on this arm, in this worktree. The
     * attempt orchestrator owns the task's status, so the run leaves the
     * task alone. See `attempts.ts`.
     */
    attempt?: { id: string; arm: Arm; workdir: string } | null;
    /**
     * Where the process runs, for this run only. Without it CEO_SANDBOX
     * decides, and local is the default. See `sandbox.ts`.
     */
    sandbox?: SandboxKind | null;
  } = {},
): RunHandle {
  const cwd = opts.cwd;
  const depth = opts.depth ?? 0;
  const userEmit = opts.onEvent ?? (() => {});

  /** Best-effort task bookkeeping: a task update must never break a run. */
  const settleTask = (
    status: "running" | "done" | "failed" | "cancelled" | "queued",
    extra: { delegationId?: string; note?: string | null } = {},
  ) => {
    if (!opts.taskId || opts.attempt) return;
    try {
      updateTask(opts.taskId, { status, ...extra }, cwd);
    } catch {
      /* the run is the record, the task is a pointer to it */
    }
  };

  const found = findAgent(agentName, cwd);
  if (!found) {
    const error = `No agent named "${agentName}" in the org.`;
    userEmit({ type: "failed", error });
    return immediate(failedResult(error));
  }

  // A task may name the provider it runs on: "use gemini for the review".
  // The run takes that provider and its default model. The agent's own
  // setting is untouched, so the next task runs where the agent usually does.
  let override: Provider | null = opts.provider ?? null;
  if (!override && opts.taskId) {
    try {
      override = findTask(opts.taskId, cwd)?.provider ?? null;
    } catch {
      override = null;
    }
  }
  const arm = opts.attempt?.arm ?? null;
  const agent: AgentRecord = arm
    ? { ...found, provider: arm.provider, model: arm.model }
    : override && override !== found.provider
      ? { ...found, provider: override, model: providerFor(override).defaultModel() }
      : found;

  const spec = providerFor(agent.provider);

  // A guard for test environments: with CEO_REQUIRE_STUBS set, only a
  // binary named stub-* may run. A test that reaches a real CLI spends
  // real money, and the first such test is one too many.
  if (process.env.CEO_REQUIRE_STUBS?.trim() && !/stub-/.test(spec.binary())) {
    const error = `CEO_REQUIRE_STUBS is set and ${spec.id} would run ${spec.binary()}; refusing.`;
    userEmit({ type: "failed", error });
    return immediate(failedResult(error));
  }

  const sandbox = sandboxFor(opts);
  const stubViolation = sandboxStubViolation(sandbox);
  if (stubViolation) {
    userEmit({ type: "failed", error: stubViolation });
    return immediate(failedResult(stubViolation));
  }

  // Readiness before anything is written. A provider that is not installed
  // or not signed in cannot run. Opening a delegation for it would leave a
  // start/end pair that spent nothing and taught nothing. The reason names
  // the fix. CEO_SKIP_SETUP_CHECK exists for hosts that sign in some other
  // way the check cannot see.
  if (!process.env.CEO_SKIP_SETUP_CHECK) {
    const reason = notReadyReason(spec.id);
    if (reason) {
      userEmit({ type: "failed", error: reason });
      settleTask("failed", { note: reason });
      return immediate(failedResult(reason));
    }
  }

  // A sandbox that cannot start fails here, before a ledger entry exists.
  if (sandbox !== "local" && !process.env.CEO_SKIP_SETUP_CHECK) {
    const ready = sandboxReadiness(sandbox);
    if (!ready.ready) {
      const reason = `${sandbox} sandbox is not ready: ${ready.reason}`;
      userEmit({ type: "failed", error: reason });
      settleTask("failed", { note: reason });
      return immediate(failedResult(reason));
    }
  }

  const root = projectRoot(cwd);
  const workdir = opts.attempt?.workdir ?? workdirFor(agent, cwd);
  const mission = currentMission(cwd);

  // The org's side of the prompt: notes for this agent and teammates'
  // latest outputs, plus the org tools when this run gets them.
  // A sandboxed process cannot reach the host ledger, so it gets no org tools.
  const collabFor = (delegationId: string | null): CollabServer | null =>
    sandbox === "local" ? collabServerFor(agent, root, delegationId, depth) : null;
  const collabPossible = collabFor(null) !== null;
  const context = orgContext(agentName, cwd);
  // The docket, read now: files from the agent's own worktree, the rest
  // from the snapshots taken when each item was added.
  let docket: ResolvedContext[] = [];
  try {
    docket = contextFor(agentName, cwd, workdir, arm ? { ids: arm.context, skills: arm.skills } : {});
  } catch {
    docket = [];
  }
  const compiled = compileAgentPrompt(agent, mission, { ...context, tools: collabPossible, docket });
  const level = processLevelFor(agent);
  const firstPrompt = opts.prompt?.trim() ? opts.prompt : task;
  const planFor = (delegationId: string | null): RunPlan =>
    opts.resumeSessionId
      ? spec.resumePlan({
          sessionId: opts.resumeSessionId,
          prompt: firstPrompt,
          model: agent.model,
          autonomy: level,
          agentTools: agent.tools,
          collab: collabFor(delegationId),
        })
      : spec.plan({
          task: firstPrompt,
          systemPrompt: compiled.text,
          model: agent.model,
          autonomy: level,
          agentTools: agent.tools,
          collab: collabFor(delegationId),
        });

  // begin() runs the budget gate and throws when the agent is capped out.
  // The provider, model and enforcement go on the start entry so an audit
  // can ask what this run was permitted to do without replaying the roster.
  let handle;
  try {
    handle = begin(agentName, task, cwd, {
      provider: spec.id,
      model: agent.model,
      ...(agent.provider !== found.provider ? { providerOverride: true, usualProvider: found.provider } : {}),
      enforcement: planFor(null).enforcement,
      workdir,
      ...(opts.parentDelegationId ? { parent: opts.parentDelegationId } : {}),
      ...(depth > 0 ? { depth } : {}),
      ...(opts.via ? { via: opts.via } : {}),
      ...(docket.length > 0 ? { context: docket.map((d) => d.id) } : {}),
      ...(opts.resumeSessionId ? { resumed: opts.resumeSessionId } : {}),
      ...(opts.attempt ? { attemptId: opts.attempt.id, arm: opts.attempt.arm } : {}),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      ...(sandboxInfo(sandbox) ? { sandbox: sandboxInfo(sandbox) } : {}),
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    userEmit({ type: "failed", error });
    return immediate(failedResult(error));
  }

  settleTask("running", { delegationId: handle.id });

  // Every event goes to the caller and to the run's trace on disk.
  const emit = (e: RunEvent) => {
    traceAppend(handle.id, e as unknown as Record<string, unknown>, cwd);
    userEmit(e);
  };
  traceAppend(handle.id, {
    type: "meta",
    agent: agentName,
    task,
    provider: spec.id,
    model: agent.model,
    taskId: opts.taskId ?? null,
    attemptId: opts.attempt?.id ?? null,
    arm: opts.attempt?.arm ?? null,
    parent: opts.parentDelegationId ?? null,
    depth,
    ...(sandboxInfo(sandbox) ? { sandbox: sandboxInfo(sandbox) } : {}),
  }, cwd);

  // The final plan carries the delegation id, so notes the run posts name it.
  const plan = planFor(handle.id);
  const collab = collabFor(handle.id);
  if (!existsSync(workdir)) {
    try {
      mkdirSync(workdir, { recursive: true });
    } catch {
      /* the spawn reports a missing directory better than this could */
    }
  }
  if (collab && spec.id === "gemini") {
    // The Antigravity CLI reads MCP servers from the workspace, not a flag.
    try {
      const dir = path.join(workdir, ".agents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "mcp_config.json"),
        JSON.stringify({ mcpServers: { [collab.name]: { command: collab.command, args: collab.args } } }, null, 2) + "\n",
      );
    } catch {
      /* the run still works without the org tools; the prompt said they might be there */
    }
  }

  const started = Date.now();
  // Notes at or below this seq were already in the first prompt's context.
  let seenSeq = lastEntry(cwd)?.seq ?? 0;

  emit({
    type: "started",
    agent: agentName,
    task,
    provider: spec.id,
    model: agent.model,
    tools: plan.enforcement,
    cwd: workdir,
  });

  const sandboxCtx = { kind: sandbox, workdir, provider: spec.id, runId: handle.id, env: process.env };
  const hooks = sandboxHooks(sandboxCtx);
  const launch = (p: RunPlan): RunPlan => wrapPlan(p, sandboxCtx);

  let current: ChildProcess | null = null;
  let cancelRequested = false;
  const register = (p: ChildProcess | null) => {
    current = p;
    if (p && cancelRequested) p.kill("SIGTERM");
  };

  const finished = (async (): Promise<RunResult> => {
    const texts: string[] = [];
    const denials: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInput = 0;
    let settledCost: number | null = null;
    let sawUsage = false;
    let sessionId: string | null = opts.resumeSessionId ?? null;
    let turns = 0;
    let error: string | null = null;

    let nextPlan: RunPlan = { ...plan, args: [...plan.args, ...(opts.extraArgs ?? [])] };
    let reason = "the task";

    // The ssh sandbox copies the worktree out once, before the first turn.
    const setupError = await hooks.before();
    if (setupError) error = setupError;

    for (; !setupError;) {
      turns++;
      if (turns > 1) emit({ type: "turn", n: turns, reason });
      let streamed = "";
      const t = await runTurn(
        launch(nextPlan),
        workdir,
        spec,
        (e) => {
          if (e.type === "text") streamed += e.text;
          emit(e);
        },
        register,
        sandbox === "local" ? undefined : (binary, e) => describeSandboxSpawnError(sandbox, binary, e),
      );
      const st = t.state;
      if (st.sessionId) sessionId = st.sessionId;
      // claude's final result replaces the streamed text; the trace keeps
      // the final answer too, so a teammate reading it sees the conclusion.
      if (st.text.trim() && st.text.trim() !== streamed.trim()) traceAppend(handle.id, { type: "text", text: st.text }, cwd);
      if (st.text.trim()) texts.push(st.text);
      denials.push(...st.denials);
      inputTokens += st.settledInput ?? st.streamedInput;
      outputTokens += st.settledOutput ?? st.streamedOutput;
      cachedInput += st.streamedCachedInput;
      sawUsage ||= st.sawUsage;
      // claude's total_cost_usd is the session's running total, so the last
      // turn's figure is the whole run's. codex and gemini never report one.
      if (st.settledCostUsd !== null) settledCost = st.settledCostUsd;

      const cancelled = t.cancelled || cancelRequested;
      const ok = t.code === 0 && !cancelled && !t.spawnError && !st.error;
      if (!ok) {
        error = cancelled
          ? "cancelled"
          : t.spawnError
            ? t.spawnError
            : st.error
              ? st.error
              : `${nextPlan.binary} exited ${t.code}${t.stderr.trim() ? `: ${t.stderr.trim().slice(0, 300)}` : ""}`;
        break;
      }

      // Anything to deliver? Notes posted since the last prompt, by others,
      // for this agent or for everyone. Each delivery is one more turn, up
      // to the cap, and never past the agent's budget.
      const notes = pendingNotesFor(agentName, seenSeq, cwd);
      if (notes.length === 0 || !sessionId || turns > maxFollowUps() || !collabPossible) break;
      const spentSoFar = settledCost ?? estimateCostUsd(agent.model, inputTokens, outputTokens, cachedInput);
      const live = findAgent(agentName, cwd);
      if (live && !live.chief && live.budgetUsd > 0 && live.spentUsd + spentSoFar >= live.budgetUsd) {
        emit({ type: "text", text: `[${notes.length} note${notes.length === 1 ? "" : "s"} left undelivered: budget reached]\n` });
        break;
      }
      seenSeq = notes[notes.length - 1].seq;
      reason = `${notes.length} note${notes.length === 1 ? "" : "s"} from ${[...new Set(notes.map((m) => m.from))].join(", ")}`;
      nextPlan = spec.resumePlan({
        sessionId,
        prompt: followUpPrompt(notes),
        model: agent.model,
        autonomy: level,
        agentTools: agent.tools,
        collab,
      });
      nextPlan = { ...nextPlan, args: [...nextPlan.args, ...(opts.extraArgs ?? [])] };
    }

    // The copy back and the remote cleanup run whatever the turns did.
    const teardownError = await hooks.after();
    if (teardownError && !error) error = teardownError;

    const durationMs = Date.now() - started;
    let costUsd = settledCost ?? 0;
    let costIsEstimate = false;
    if (costUsd === 0 && (sawUsage || inputTokens + outputTokens > 0)) {
      costUsd = estimateCostUsd(agent.model, inputTokens, outputTokens, cachedInput);
      costIsEstimate = costUsd > 0;
    }
    const text = texts.join("\n\n");
    const ok = error === null;
    return { ok, text, costUsd, inputTokens, outputTokens, durationMs, denials, error, costIsEstimate, turns, delegationId: handle.id, sessionId };
  })().then((result) => {
    // A provider limit is not a failure of the work. The task goes back to
    // the queue, and the provider waits until the limit is expected to lift.
    const limit = !result.ok && result.error !== "cancelled" ? detectRateLimit(result.error) : null;
    if (limit) {
      const retryAt = noteRateLimit(cooldowns, spec.id, limit);
      result = { ...result, rateLimit: { provider: spec.id, retryAt, reason: limit.reason } };
    }
    const outcome = result.ok ? "done" : result.error === "cancelled" ? "cancelled" : result.rateLimit ? "rate_limited" : "failed";

    // Close the ledger entry whatever happened. A cancelled or failed run
    // still cost money, and recording zero would understate the org's spend.
    end(
      handle,
      result.ok ? result.text : `[${result.error}]\n\n${result.text}`,
      {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        costIsEstimate: result.costIsEstimate,
        costBasis: result.costIsEstimate ? spec.estimateBasis : "settled",
        turns: result.turns,
        sessionId: result.sessionId,
        outcome,
      },
      cwd,
    );
    traceAppend(handle.id, { type: "end", status: result.ok ? "done" : result.error === "cancelled" ? "cancelled" : "failed", costUsd: result.costUsd, turns: result.turns }, cwd);

    // A provider that never reports dollars produces an estimate every run.
    // That fact is on the delegate_end entry itself, as costBasis. The note is
    // for the exceptional case, a provider that should have settled and did
    // not. That way the auditor sees the crash, not a note per codex run.
    if (result.costIsEstimate && spec.reportsCost) {
      append("note", agentName, {
        kind: "cost_estimated",
        delegationId: handle.id,
        costUsd: result.costUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        model: agent.model,
        detail:
          "Run ended before reporting a settled cost, because it was cancelled or crashed. Cost estimated from streamed token counts at list prices.",
      }, cwd);
    }

    if (result.denials.length > 0) {
      append("note", agentName, {
        kind: "permission_denied",
        provider: spec.id,
        tools: result.denials,
        autonomy: level,
        delegationId: handle.id,
        detail: `Agent attempted ${result.denials.length} action(s) its ${level} level forbids. Enforced by ${spec.enforcementLabel(level, agent.tools)}.`,
      }, cwd);
    }

    if (result.rateLimit) {
      append("note", agentName, {
        kind: "rate_limited",
        provider: spec.id,
        delegationId: handle.id,
        retryAt: result.rateLimit.retryAt,
        detail: result.rateLimit.reason,
      }, cwd);
    }

    settleTask(
      result.ok ? "done" : result.error === "cancelled" ? "cancelled" : result.rateLimit ? "queued" : "failed",
      { note: result.ok ? null : result.rateLimit ? `${spec.id} limit: back in the queue until ${new Date(result.rateLimit.retryAt).toLocaleTimeString()}` : result.error },
    );

    if (result.ok) {
      userEmit({
        type: "done",
        costUsd: result.costUsd,
        costIsEstimate: result.costIsEstimate,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
        text: result.text,
        turns: result.turns,
      });
    } else {
      userEmit({ type: "failed", error: result.error ?? "unknown failure", ...(result.rateLimit ? { retryAt: result.rateLimit.retryAt } : {}) });
    }
    return result;
  });

  return {
    cancel: () => {
      cancelRequested = true;
      current?.kill("SIGTERM");
      hooks.cancel();
    },
    finished,
  };
}

/** Human-readable summary of what an agent is permitted to do right now. */
export function describeRunPolicy(agent: AgentRecord): string {
  const policy = policyFor(agent.autonomy);
  const spec = providerFor(agent.provider);
  const label = agent.chief ? `chief of staff, ${staffingFor(agent.autonomy).label}` : policy.label;
  const level = processLevelFor(agent);
  return `${policy.level}, ${label} · ${spec.label}: ${spec.enforcementLabel(level, agent.tools)}`;
}

/** The enforcement list a run of this agent would start with, for forms. */
export function enforcementFor(agent: AgentRecord): string[] {
  const spec = providerFor(agent.provider);
  const level = processLevelFor(agent);
  if (spec.id === "claude") return effectiveTools(level, agent.tools);
  return spec.plan({ task: "x", systemPrompt: "", model: agent.model, autonomy: level, agentTools: agent.tools }).enforcement;
}
