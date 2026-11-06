/**
 * The org: the chief of staff, the team, the task queue, approvals, the
 * mission and the docket. Every agent here runs headless. The engine owns the
 * processes. The core owns money, permissions, worktrees and the ledger.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

import "../../../src/core/evidence";
import { attemptsFor, promoteHooks, promotionOf, runTask, usesAttempts, type PromoteHook, type TaskRun } from "../../../src/core/attempts";
import { policyFor } from "../../../src/core/autonomy";
import {
  allowanceOf, chatPrompt, conversation, ensureChief, newConversation, resumableSession, staffingFor, startableAfter,
} from "../../../src/core/chat";
import { postMessage, messages as readMessages } from "../../../src/core/collab";
import { COMPANIES, describeHire, findCompany, hireCompany as coreHireCompany, planCompany } from "../../../src/core/companies";
import { compileAgentPrompt } from "../../../src/core/compile";
import {
  addContext, giveContext, listContext, loadOf, refreshContext, removeContext, takeContext, tokenLabel, KIND_LABEL, type ContextItem,
} from "../../../src/core/context";
import { recentDelegations } from "../../../src/core/delegation";
import { decideApproval, evidenceFor, gateSettings, evidenceLines, mergeGate, pendingApprovals, requestApproval, setAutoMerge } from "../../../src/core/gates";
import { cooldowns, coolingDown } from "../../../src/core/limits";
import { branchNameFor, currentBranch, hasCommits, isGitRepo, mergeAgentBranch, provisionWorktree, unmergedCommits } from "../../../src/core/git";
import { githubStatus } from "../../../src/core/github";
import { hfStatus } from "../../../src/core/huggingface";
import { readLedger, rollup, verify } from "../../../src/core/ledger";
import { checkMission as coreCheckMission, current as currentMission, missionStatus, setMission as coreSetMission } from "../../../src/core/mission";
import { ROLE_TEMPLATES } from "../../../src/core/nextstep";
import { ledgerPath, orgExists } from "../../../src/core/paths";
import { providerFor } from "../../../src/core/providers";
import { budgetCheck, findAgent, findChief, fire, hire, readRoster, reconfigure, setAutonomy, setBudget } from "../../../src/core/roster";
import { recommend, taskKind } from "../../../src/core/router";
import { runDelegation, type RunEvent, type RunHandle, type RunResult } from "../../../src/core/runner";
import { sandboxReadiness } from "../../../src/core/sandbox";
import { skillCatalog } from "../../../src/core/skills";
import { suggestTeam as coreSuggestTeam } from "../../../src/core/suggest";
import { addTask as coreAddTask, findTask, listTasks, staleRunningTasks, updateTask, type Task as CoreTask } from "../../../src/core/tasks";
import { armLabel, type AgentRecord, type VerifierSpec } from "../../../src/core/types";
import { parseVerifier, verifierName } from "../../../src/core/verify";

import type {
  Agent, AgentChange, AgentDetail, Approval, Chief, Company, CompanyPreview, DocketItem, EngineEvent, Integrations, LicenseState, Mission,
  NewAgent, NewTask, Org, OrgRun, OrgSummary, Project, Provider, RoleTemplate, RunLine, RunVia, Settings, Suggestion, Task, TaskPriority,
} from "../shared/api";

export type OrgHost = {
  emit(e: EngineEvent): void;
  project(id: string): Project;
  projects(): Project[];
  ensureOrg(root: string): void;
  settings(): Settings;
  license(): LicenseState;
  /** Agent name to workspace id, for the agents behind workspaces. */
  workspaceAgents(projectId: string): Map<string, string>;
  /** Whether a workspace chat is running this agent now. */
  workspaceBusy(projectId: string, agent: string): boolean;
  pushSnapshot(): void;
};

const MAX_LINES = 400;
const KEEP_SETTLED = 30;
const LEVEL_LABEL: Record<string, string> = {
  observe: "reads and reports",
  propose: "drafts changes for review",
  execute: "edits and runs commands",
  autonomous: "edits, runs and merges",
};

type Live = OrgRun & { handle: RunHandle | null; cancelRequested: boolean };

const uid = (): string => Math.random().toString(36).slice(2, 10);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createOrg(host: OrgHost) {
  const runs = new Map<string, Live>();
  const taskRuns = new Map<string, TaskRun>(); // `${projectId}:${taskId}`
  const summaries = new Map<string, OrgSummary>();
  const ledgerStamp = new Map<string, string>();
  let disposed = false;
  /** Tasks someone asked to start now while the agent was busy. Each starts when its agent is free. */
  const startWhenFree = new Map<string, Set<string>>();
  const waitFor = (projectId: string, taskId: string): void => {
    const set = startWhenFree.get(projectId) ?? new Set<string>();
    set.add(taskId);
    startWhenFree.set(projectId, set);
  };
  function startWaiting(projectId: string): void {
    const set = startWhenFree.get(projectId);
    if (!set?.size) return;
    const root = rootOf(projectId);
    const taken = new Set<string>();
    for (const id of [...set]) {
      const t = findTask(id, root);
      if (!t || t.status !== "queued" || !t.assignee) {
        set.delete(id);
        continue;
      }
      if (taken.has(t.assignee) || busy(projectId, t.assignee) || cooling(root, t)) continue;
      taken.add(t.assignee);
      try {
        startTask(projectId, t, "delegate");
        set.delete(id);
      } catch {
        /* the next settle tries again */
      }
    }
  }
  /** Set the moment quitting starts. Nothing new starts after it. */
  let closing = false;

  const rootOf = (projectId: string): string => host.project(projectId).path;

  // -- runs ----------------------------------------------------------------

  function publicRun(r: Live): OrgRun {
    const { handle: _h, cancelRequested: _c, ...rest } = r;
    void _h; void _c;
    return { ...rest, lines: rest.lines.slice() };
  }
  const emitRun = (r: Live): void => host.emit({ type: "org-run", run: publicRun(r) });

  function addLine(r: Live, line: RunLine): void {
    const last = r.lines[r.lines.length - 1];
    if (line.kind === "text" && last?.kind === "text") last.text += line.text;
    else r.lines.push({ ...line });
    if (r.lines.length > MAX_LINES) r.lines.splice(0, r.lines.length - MAX_LINES);
    host.emit({ type: "org-line", projectId: r.projectId, key: r.key, line });
  }

  function onEvent(r: Live, e: RunEvent): void {
    if (e.type === "started") {
      r.provider = e.provider;
      r.model = e.model;
      r.workdir = e.cwd;
      emitRun(r);
    } else if (e.type === "text") addLine(r, { kind: "text", text: e.text });
    else if (e.type === "tool") addLine(r, { kind: "tool", text: e.summary ? `${e.name} ${e.summary}` : e.name });
    else if (e.type === "denied") addLine(r, { kind: "denied", text: e.tool });
    else if (e.type === "turn") addLine(r, { kind: "turn", text: e.reason });
    else if (e.type === "failed") addLine(r, { kind: "error", text: e.error });
  }

  function prune(projectId: string): void {
    const settled = [...runs.values()].filter((r) => r.projectId === projectId && r.status !== "running").sort((a, b) => b.startedAt - a.startedAt);
    for (const r of settled.slice(KEEP_SETTLED)) runs.delete(r.key);
  }

  function blank(projectId: string, agent: string, task: string, via: RunVia, extra: Partial<OrgRun> = {}): Live {
    return {
      key: `${projectId}:${agent}:${uid()}`, projectId, agent, task, taskId: null, attemptId: null, arm: null, via, status: "running",
      provider: null, model: null, workdir: null, startedAt: Date.now(), finishedAt: null, costUsd: 0, estimate: false, error: null,
      denials: [], retryAt: null, delegationId: null, lines: [], handle: null, cancelRequested: false, ...extra,
    };
  }

  function applyResult(r: Live, res: RunResult): void {
    r.status = r.cancelRequested || res.error === "cancelled" ? "cancelled" : res.ok ? "done" : res.rateLimit ? "waiting" : "failed";
    r.retryAt = res.rateLimit?.retryAt ?? null;
    r.costUsd = res.costUsd;
    r.estimate = res.costIsEstimate;
    r.error = res.ok ? null : res.error;
    r.denials = res.denials;
    r.delegationId = res.delegationId;
    r.finishedAt = Date.now();
  }

  const failure = (e: unknown, startedAt: number): RunResult => ({
    ok: false, text: "", costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: Date.now() - startedAt, denials: [], error: message(e),
    costIsEstimate: false, turns: 0, delegationId: null, sessionId: null,
  });

  /** Whether an agent has work in flight anywhere in the app. */
  function busy(projectId: string, agent: string): boolean {
    for (const r of runs.values()) if (r.projectId === projectId && r.agent === agent && r.status === "running") return true;
    return host.workspaceBusy(projectId, agent);
  }

  function startRun(
    projectId: string,
    agent: string,
    task: string,
    opts: { taskId?: string | null; prompt?: string; resume?: string | null; via: RunVia; ledgerVia?: string; sandbox?: CoreTask["sandbox"]; onFinished?: (r: RunResult) => void },
  ): OrgRun {
    const root = rootOf(projectId);
    if (closing) throw new Error("The app is closing.");
    refuseWorkspaceAgent(projectId, agent, "Talk to");
    if (busy(projectId, agent)) throw new Error(`${agent} is already working. One run per agent at a time.`);
    const found = findAgent(agent, root);
    if (!found) throw new Error(`No agent named "${agent}" on this team.`);
    const r = blank(projectId, agent, task, opts.via, { taskId: opts.taskId ?? null, provider: found.provider, model: found.model });
    // runDelegation reports synchronously before it returns. The run has to be in the map first.
    runs.set(r.key, r);
    emitRun(r);
    process.env.CEO_NO_COLLAB = host.settings().teamNotes ? "" : "1";
    try {
      r.handle = runDelegation(agent, task, {
        cwd: root,
        taskId: opts.taskId ?? undefined,
        resumeSessionId: opts.resume ?? null,
        prompt: opts.prompt,
        via: opts.ledgerVia,
        ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
        onEvent: (e) => onEvent(r, e),
      });
    } catch (e) {
      applyResult(r, failure(e, r.startedAt));
      emitRun(r);
      throw e;
    }
    r.handle.finished
      .then((res) => res, (e: unknown) => failure(e, r.startedAt))
      .then((res) => {
        applyResult(r, res);
        emitRun(r);
        try {
          opts.onFinished?.(res);
        } catch {
          /* a follow-up that fails must not mark a settled run as failed */
        }
        if (!(opts.via === "chief" && !opts.taskId)) notifyRun(r);
        afterSettle(projectId, r.retryAt);
      });
    return publicRun(r);
  }

  function notifyRun(r: Live): void {
    if (r.status === "cancelled" || disposed) return;
    const ok = r.status === "done";
    host.emit({
      type: "notify",
      title: ok ? `${r.agent} finished` : r.status === "waiting" ? `${r.agent} hit a provider limit` : `${r.agent} needs a look`,
      body: ok ? r.task.slice(0, 120) : (r.error ?? "The run failed.").slice(0, 160),
      workspaceId: null, level: ok ? "done" : "failed", sound: host.settings().sound,
    });
  }

  /** Run a queued task: as verified attempts when it has checks or samples, else as one run. */
  function startTask(projectId: string, given: CoreTask, via: RunVia): void {
    let task = given;
    const root = rootOf(projectId);
    const assignee = task.assignee;
    if (!assignee) throw new Error("Give the task to someone first.");
    if (task.status !== "queued") throw new Error(`The task is ${task.status}. Requeue it to run it again.`);
    if (closing) throw new Error("The app is closing.");
    refuseWorkspaceAgent(projectId, assignee, "Talk to");
    // A single checked attempt runs where the assignee runs, whoever wrote the task.
    if (usesAttempts(task) && task.samples <= 1 && task.arms.length === 0) {
      const arms = pinnedArms(root, assignee, task.provider, 1);
      if (arms) {
        updateTask(task.id, { arms }, root);
        task = findTask(task.id, root) ?? task;
      }
    }
    if (!usesAttempts(task)) {
      startRun(projectId, assignee, task.title, { taskId: task.id, via, sandbox: task.sandbox });
      return;
    }
    const tkey = `${projectId}:${task.id}`;
    if (taskRuns.has(tkey)) throw new Error("That task is already running.");
    if (task.samples > 1 && !host.license().limits.attempts) throw new Error("Several attempts per task are part of Pro. Set samples to 1, or upgrade.");
    if (busy(projectId, assignee)) throw new Error(`${assignee} is already working. One run per agent at a time.`);
    const byAttempt = new Map<string, Live>();
    process.env.CEO_NO_COLLAB = host.settings().teamNotes ? "" : "1";
    const run = runTask(task.id, {
      cwd: root,
      onStart: (a) => {
        const r = blank(projectId, a.agent, task.title, via, { taskId: task.id, attemptId: a.id, arm: armLabel(a.arm), provider: a.arm.provider, model: a.arm.model, workdir: a.workdir });
        byAttempt.set(a.id, r);
        runs.set(r.key, r);
        emitRun(r);
      },
      onEvent: (id, e) => {
        const r = byAttempt.get(id);
        if (r) onEvent(r, e);
      },
      onEnd: (id, res) => {
        const r = byAttempt.get(id);
        if (!r) return;
        applyResult(r, res);
        emitRun(r);
      },
    });
    if (run.attempts.length === 0) {
      void run.finished.then((out) => {
        try {
          if (findTask(task.id, root)?.status === "queued") updateTask(task.id, { status: "failed", note: out.note }, root);
        } catch {
          /* the note is on the result either way */
        }
        touch(projectId);
      });
      throw new Error("No attempt could start. The task says why.");
    }
    taskRuns.set(tkey, run);
    for (const a of run.attempts) {
      const r = byAttempt.get(a.id);
      if (r) r.handle = a.handle;
    }
    void run.finished
      .then((out) => {
        host.emit({
          type: "notify",
          title: out.status === "done" ? `Task passed: ${task.title.slice(0, 60)}` : `Task ${out.status}: ${task.title.slice(0, 60)}`,
          body: out.note.slice(0, 160), workspaceId: null, level: out.status === "done" ? "done" : "failed", sound: host.settings().sound,
        });
      })
      .catch(() => null)
      .finally(() => {
        taskRuns.delete(tkey);
        afterSettle(projectId);
      });
  }

  /** After any run ends: the chief's waiting work, then the queue if auto-dispatch is on. */
  function afterSettle(projectId: string, retryAt: number | null = null): void {
    if (disposed) return;
    prune(projectId);
    touch(projectId);
    const resume = (): void => {
      if (disposed || closing) return;
      try {
        startWaiting(projectId);
        startChiefWork(projectId);
        if (host.project(projectId).config.autoDispatch) dispatch(projectId);
      } catch {
        /* the project closed */
      }
    };
    setTimeout(resume, 0);
    // A provider limit lifts later. One retry then, instead of a retry on every settle.
    if (retryAt && retryAt > Date.now()) setTimeout(resume, Math.min(retryAt - Date.now() + 1000, 6 * 3600000)).unref?.();
  }

  // -- the chief of staff --------------------------------------------------

  function chiefRun(projectId: string): Live | null {
    for (const r of runs.values()) if (r.projectId === projectId && r.via === "chief" && r.status === "running" && !r.taskId) return r;
    return null;
  }

  /** The provider a queued task would run on is waiting out a usage limit. */
  function cooling(root: string, t: CoreTask): boolean {
    const provider = t.arms[0]?.provider ?? t.provider ?? findAgent(t.assignee ?? "", root)?.provider;
    return !!provider && coolingDown(cooldowns, provider);
  }

  /** Start work the chief gave to agents that were busy when the reply ended. */
  function startChiefWork(projectId: string): number {
    const root = rootOf(projectId);
    if (!orgExists(root)) return 0;
    const chief = findChief(root);
    if (!chief || !staffingFor(chief.autonomy).start || chiefRun(projectId)) return 0;
    let started = 0;
    const taken = new Set<string>();
    for (const t of listTasks(root)) {
      if (!t.autoStart || t.requestedBy !== chief.name || t.status !== "queued" || !t.assignee || taken.has(t.assignee)) continue;
      if (busy(projectId, t.assignee) || cooling(root, t) || host.workspaceAgents(projectId).has(t.assignee)) continue;
      taken.add(t.assignee);
      try {
        startTask(projectId, t, "chief");
        started++;
      } catch {
        /* the next settle tries again */
      }
    }
    return started;
  }

  function afterChiefReply(projectId: string, chiefName: string, res: RunResult): void {
    const root = rootOf(projectId);
    if (!res.delegationId) return;
    const chief = findAgent(chiefName, root);
    if (!chief || !staffingFor(chief.autonomy).start) return;
    const taken = new Set<string>();
    for (const t of startableAfter(conversation(chiefName, root), res.delegationId, root)) {
      const who = t.assignee as string;
      if (taken.has(who) || busy(projectId, who) || cooling(root, t) || host.workspaceAgents(projectId).has(who)) continue;
      taken.add(who);
      try {
        startTask(projectId, t, "chief");
      } catch {
        /* left queued. The next settle starts it */
      }
    }
  }

  function chiefView(projectId: string, root: string, entries: ReturnType<typeof readLedger>): Chief | null {
    const c = findChief(root);
    if (!c) return null;
    const conv = conversation(c.name, root, entries);
    const a = allowanceOf(c, root, entries);
    const staffing = staffingFor(c.autonomy);
    return {
      name: c.name, provider: c.provider, model: c.model, level: c.autonomy, levelLabel: staffing.label,
      may: { queue: staffing.queue, hire: staffing.hire, start: staffing.start, fire: staffing.fire },
      allowance: { totalUsd: a.totalUsd, givenUsd: a.givenUsd, leftUsd: a.leftUsd },
      turns: conv.turns.slice(-60).map((t) => ({
        id: t.id, ts: t.ts, message: t.message, reply: t.reply, status: t.status, provider: t.provider, model: t.model, costUsd: t.costUsd,
        estimate: t.costIsEstimate,
        actions: t.actions.map((x) => ({ kind: x.kind, agent: x.agent, text: x.text, taskId: x.taskId, provider: x.provider })),
      })),
      chiefCostUsd: conv.chiefCostUsd, teamCostUsd: conv.teamCostUsd, teamRuns: conv.teamRuns,
      replying: chiefRun(projectId)?.key ?? null,
    };
  }

  // -- reading the org -----------------------------------------------------

  function agentView(projectId: string, a: AgentRecord, tasks: CoreTask[], load: Map<string, number>, wsAgents: Map<string, string>): Agent {
    const live = [...runs.values()].filter((r) => r.projectId === projectId && r.agent === a.name).sort((x, y) => y.startedAt - x.startedAt);
    const running = live.find((r) => r.status === "running");
    const inWorkspace = host.workspaceBusy(projectId, a.name);
    const over = a.budgetUsd > 0 && a.spentUsd >= a.budgetUsd;
    return {
      name: a.name, role: a.role, provider: a.provider, model: a.model, level: a.autonomy,
      levelLabel: LEVEL_LABEL[a.autonomy] ?? policyFor(a.autonomy).label, tools: a.tools,
      budgetUsd: a.budgetUsd, spentUsd: a.spentUsd, runs: a.delegations, hiredAt: a.hiredAt, lastActiveAt: a.lastActiveAt,
      isolated: a.isolated, branch: a.branch, chief: !!a.chief, workspaceId: wsAgents.get(a.name) ?? null,
      guardrails: a.guardrails ?? [], collaboration: a.collaboration ?? "",
      state: running || inWorkspace ? "running" : over ? "over-budget" : live[0]?.status === "waiting" ? "waiting" : "idle",
      doing: running?.task ?? (inWorkspace ? "Working in its workspace" : null),
      queued: tasks.filter((t) => t.assignee === a.name && t.status === "queued").length,
      docket: load.get(a.name) ?? 0,
    };
  }

  function taskView(t: CoreTask, root: string, entries: ReturnType<typeof readLedger>): Task {
    let attempts: Task["attempts"] = [];
    if (usesAttempts(t)) {
      const promoted = promotionOf(t.id, root);
      const winner = promoted ? String(promoted.data.attemptId ?? "") : null;
      attempts = attemptsFor(t.id, root, entries).map((a) => ({
        id: a.id, agent: a.agent, arm: armLabel(a.arm), branch: a.branch, outcome: a.outcome, pass: a.verdict ? a.verdict.pass : null,
        score: a.verdict ? a.verdict.score : null, costUsd: a.costUsd, promoted: a.id === winner, startedAt: a.startedAt, endedAt: a.endedAt,
      }));
    }
    return {
      id: t.id, title: t.title, assignee: t.assignee, priority: t.priority, status: t.status, blockedReason: t.blockedReason, createdAt: t.createdAt,
      updatedAt: t.updatedAt, costUsd: t.costUsd, note: t.note, requestedBy: t.requestedBy, autoStart: t.autoStart, provider: t.provider,
      checks: t.verifiers.map((v) => verifierName(v)), samples: t.samples, kind: t.kind, sandbox: t.sandbox, attempts,
    };
  }

  function docketView(it: ContextItem): DocketItem {
    const group = it.kind === "skill" ? "Skills" : it.kind === "file" || it.kind === "folder" ? "Files" : it.kind === "issue" || it.kind === "pr" ? "GitHub"
      : it.kind === "model" || it.kind === "dataset" || it.kind === "space" || it.kind === "paper" ? "Hugging Face" : it.kind === "url" ? "Web" : "Notes";
    return { id: it.id, kind: KIND_LABEL[it.kind] ?? it.kind, group, title: it.title, source: it.source, tokens: tokenLabel(it.chars), agents: it.agents, addedAt: it.addedAt, addedBy: it.addedBy };
  }

  function missionView(root: string): Mission | null {
    const m = currentMission(root);
    if (!m) return null;
    return {
      objective: m.objective, criteria: m.successCriteria, guardrails: m.orgGuardrails, setAt: m.setAt,
      checks: missionStatus(root).map((c) => ({ name: c.name, spec: specText(c.spec), state: c.state, detail: c.detail, at: c.at })),
    };
  }

  function org(projectId: string): Org {
    const p = host.project(projectId);
    const root = p.path;
    const runList = [...runs.values()].filter((r) => r.projectId === projectId).sort((a, b) => b.startedAt - a.startedAt).map(publicRun);
    const empty: Org = {
      projectId, exists: false, agents: [], chief: null, tasks: [], approvals: [], autoMerge: false, notes: [], mission: null, docket: [], runs: runList,
      ledger: { ok: true, entries: 0, detail: "" }, spentTodayUsd: 0, error: null,
    };
    if (!p.isGit || !orgExists(root)) return empty;
    try {
      const entries = readLedger(root);
      const roster = readRoster(root);
      const tasks = listTasks(root);
      const docket = listContext(root, entries);
      const load = loadOf(docket, roster.agents.map((a) => a.name));
      const wsAgents = host.workspaceAgents(projectId);
      const check = verify(root);
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      return {
        projectId, exists: true,
        agents: roster.agents.map((a) => agentView(projectId, a, tasks, load, wsAgents)),
        chief: chiefView(projectId, root, entries),
        tasks: tasks.map((t) => taskView(t, root, entries)),
        approvals: pendingApprovals(root).map((a): Approval => ({
          id: a.id, action: a.action, agent: a.agent, taskId: a.taskId, branch: a.branch, summary: a.summary, ts: a.ts,
          evidence: evidenceLines(a.evidence), pass: a.evidence.verdict ? a.evidence.verdict.pass : null,
        })),
        autoMerge: gateSettings(root).autoMerge,
        notes: readMessages(root, 60).map((m) => ({ seq: m.seq, ts: m.ts, from: m.from, to: m.to, text: m.text, ask: !!m.askId })),
        mission: missionView(root),
        docket: docket.map(docketView),
        runs: runList,
        ledger: { ok: check.ok, entries: entries.length, detail: check.ok ? `${entries.length} entries. The hash chain is intact.` : `The chain breaks at entry ${check.brokenAtSeq ?? "?"}. ${check.reason ?? ""}`.trim() },
        spentTodayUsd: rollup(start.getTime(), root).totalUsd ?? 0,
        error: null,
      };
    } catch (e) {
      return { ...empty, exists: true, error: message(e) };
    }
  }

  function summarize(projectId: string): OrgSummary {
    const none: OrgSummary = { agents: 0, running: 0, approvals: 0, queued: 0, hasChief: false, replying: false };
    let root: string;
    try {
      root = rootOf(projectId);
    } catch {
      return none;
    }
    const running = [...runs.values()].filter((r) => r.projectId === projectId && r.status === "running").length;
    if (!orgExists(root)) return { ...none, running };
    try {
      const ws = host.workspaceAgents(projectId);
      const roster = readRoster(root).agents;
      return {
        agents: roster.filter((a) => !a.chief && !ws.has(a.name)).length,
        running,
        approvals: pendingApprovals(root).length,
        queued: listTasks(root).filter((t) => t.status === "queued").length,
        hasChief: roster.some((a) => a.chief),
        replying: !!chiefRun(projectId),
      };
    } catch {
      return { ...none, running };
    }
  }

  /** Something in this org changed. The sidebar counts and any open org page catch up. */
  function touch(projectId: string): void {
    if (disposed) return;
    try {
      summaries.set(projectId, summarize(projectId));
      ledgerStamp.set(projectId, stamp(projectId));
    } catch {
      /* the project closed */
    }
    host.emit({ type: "org", projectId });
    host.pushSnapshot();
  }

  function stamp(projectId: string): string {
    try {
      const st = statSync(ledgerPath(rootOf(projectId)));
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return "none";
    }
  }

  /** The org server writes the ledger from its own process when the chief hires or delegates. This notices. */
  function poll(): void {
    for (const p of host.projects()) {
      if (!p.isGit) continue;
      const now = stamp(p.id);
      if (ledgerStamp.get(p.id) !== now) touch(p.id);
    }
  }

  // -- team ----------------------------------------------------------------

  function teamCount(projectId: string): number {
    const ws = host.workspaceAgents(projectId);
    return readRoster(rootOf(projectId)).agents.filter((a) => !ws.has(a.name)).length;
  }
  function checkTeamLimit(projectId: string, extra: number): void {
    const limit = host.license().limits.teamAgents;
    if (limit === null) return;
    if (teamCount(projectId) + extra > limit) throw new Error(`The free plan holds ${limit} team agents per project. Fire one, or upgrade to Pro for no limit.`);
  }
  function refuseWorkspaceAgent(projectId: string, name: string, verb: string): void {
    if (host.workspaceAgents(projectId).has(name)) throw new Error(`${name} belongs to a workspace. ${verb} it from that workspace.`);
  }

  /**
   * Why a merge into the main checkout must wait, or null. Edits the person has not committed would mix into the merge.
   * An agent working in the main folder would have files change under it. CEO's own record in .ceo is not the person's work.
   */
  function mergeBlocker(root: string): string | null {
    const st = execFileSync("git", ["status", "--porcelain", "--untracked-files=no", "--", ".", ":(exclude).ceo"], { cwd: root, encoding: "utf8" }).trim();
    if (st) return `The checkout at ${root} has uncommitted changes. Commit or stash them first, so the merge lands on a clean tree.`;
    const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], { cwd: root, encoding: "utf8" }).trim();
    if (existsSync(path.resolve(root, gitDir, "MERGE_HEAD"))) return "A merge is already in progress in the main checkout. Finish or abort it first.";
    const project = host.projects().find((p) => p.path === root);
    if (project) {
      for (const r of runs.values()) {
        if (r.projectId !== project.id || r.status !== "running" || (r.via === "chief" && !r.taskId)) continue;
        const a = findAgent(r.agent, root);
        if (a && !a.isolated && !r.attemptId) return `${r.agent} is working in the main folder. Merge once that run ends.`;
      }
    }
    return null;
  }
  function cleanCheckout(root: string): void {
    const why = mergeBlocker(root);
    if (why) throw new Error(why);
  }

  /** Auto-merge goes through the same checks as a person's merge. When one fails, the merge waits in Approvals. */
  const guardedMergeGate: PromoteHook = async (p, cwd) => {
    const root = cwd;
    let why: string | null = null;
    try {
      why = gateSettings(root).autoMerge && p.attempt.branch ? mergeBlocker(root) : null;
    } catch (e) {
      why = message(e);
    }
    if (!why) return mergeGate(p, cwd);
    if (pendingApprovals(root).some((r) => r.attemptId === p.attempt.id)) return;
    const title = findTask(p.taskId, root)?.title ?? p.taskId;
    requestApproval("merge", {
      taskId: p.taskId, attemptId: p.attempt.id, agent: p.attempt.agent, branch: p.attempt.branch,
      summary: `Merge ${p.attempt.branch} for ${title}. Auto-merge waited: ${why}`,
      evidence: evidenceFor(p.taskId, p.attempt.id, root, { pass: p.verdict.pass, score: p.verdict.score }),
    }, root);
  };
  {
    const i = promoteHooks.indexOf(mergeGate);
    if (i >= 0) promoteHooks.splice(i, 1, guardedMergeGate);
    else promoteHooks.push(guardedMergeGate);
  }
  function abortMerge(root: string): void {
    try {
      execFileSync("git", ["merge", "--abort"], { cwd: root, stdio: "ignore" });
    } catch {
      /* nothing was in progress */
    }
  }

  function agentDetail(projectId: string, name: string): AgentDetail {
    const root = rootOf(projectId);
    const a = findAgent(name, root);
    if (!a) throw new Error(`No agent named "${name}" on this team.`);
    const entries = readLedger(root);
    const tasks = listTasks(root);
    const docket = listContext(root, entries);
    const load = loadOf(docket, [a.name]);
    const ends = new Map(entries.filter((e) => e.type === "delegate_end").map((e) => [String(e.data.id ?? ""), e]));
    const starts = new Map(entries.filter((e) => e.type === "delegate_start").map((e) => [String(e.data.id ?? ""), e]));
    const rows = recentDelegations(400, root).filter((d) => d.agent === name).slice(0, 40).map((d) => {
      const end = ends.get(d.id);
      const st = starts.get(d.id);
      let output: string | null = null;
      if (d.outputPath && existsSync(d.outputPath)) {
        const raw = readFileSync(d.outputPath, "utf8");
        const i = raw.indexOf("\n## Output\n");
        output = (i >= 0 ? raw.slice(i + 11) : raw).trim().slice(0, 6000);
      }
      return {
        id: d.id, ts: d.ts, task: d.task, ok: end ? end.data.ok !== false && !end.data.error : null, costUsd: d.costUsd,
        estimate: end?.data.costBasis === "estimate" || end?.data.costIsEstimate === true, durationMs: d.durationMs,
        provider: String(st?.data.provider ?? a.provider), model: String(st?.data.model ?? a.model),
        denials: Array.isArray(end?.data.denials) ? (end!.data.denials as unknown[]).length : 0, output,
      };
    });
    let unmerged: string[] = [];
    try {
      if (a.branch && isGitRepo(root)) unmerged = unmergedCommits(a.name, root);
    } catch {
      unmerged = [];
    }
    return {
      agent: agentView(projectId, a, tasks, load, host.workspaceAgents(projectId)),
      prompt: compileAgentPrompt(a, currentMission(root)).text,
      runs: rows, unmerged, worktree: a.worktreePath,
      docket: docket.filter((it) => it.agents.includes(a.name)).map(docketView),
    };
  }

  function hireAgent(input: NewAgent): Agent {
    const p = host.project(input.projectId);
    if (!p.isGit) throw new Error("A team needs a git repository.");
    host.ensureOrg(p.path);
    checkTeamLimit(input.projectId, 1);
    const name = input.name.trim().toLowerCase();
    if (host.workspaceAgents(input.projectId).has(name)) throw new Error(`A workspace already uses the name ${name}.`);
    if (input.isolated && !hasCommits(p.path)) throw new Error("A branch of its own needs a first commit. Make one, or hire without a branch.");
    const isolated = input.isolated;
    const a = hire(
      {
        name, role: input.role.trim(), provider: input.provider, model: input.model || undefined, budgetUsd: input.budgetUsd, isolated,
        autonomy: input.level, guardrails: input.guardrails.map((g) => g.trim()).filter(Boolean), collaboration: input.collaboration.trim() || undefined,
      },
      p.path,
    );
    if (isolated) {
      try {
        provisionWorktree(a.name, p.path);
      } catch (e) {
        touch(input.projectId);
        throw new Error(`Hired ${a.name}, but the branch could not be made: ${message(e)}`);
      }
    }
    touch(input.projectId);
    return agentOf(input.projectId, a.name);
  }

  function agentOf(projectId: string, name: string): Agent {
    const root = rootOf(projectId);
    const a = findAgent(name, root);
    if (!a) throw new Error(`No agent named "${name}" on this team.`);
    const tasks = listTasks(root);
    return agentView(projectId, a, tasks, loadOf(listContext(root), [a.name]), host.workspaceAgents(projectId));
  }

  function updateAgent(projectId: string, name: string, change: AgentChange): Agent {
    const root = rootOf(projectId);
    const a = findAgent(name, root);
    if (!a) throw new Error(`No agent named "${name}" on this team.`);
    if (busy(projectId, name) && (change.provider || change.model)) throw new Error(`${name} is working. Change the provider once the run ends.`);
    const cfg: Parameters<typeof reconfigure>[1] = {};
    if (change.role !== undefined && change.role.trim() !== a.role) {
      if (change.role.trim().length < 10) throw new Error("A role brief needs at least 10 characters.");
      cfg.role = change.role.trim();
    }
    if (change.provider && change.provider !== a.provider) {
      cfg.provider = change.provider;
      const spec = providerFor(change.provider);
      cfg.model = change.model && spec.models().includes(change.model) ? change.model : spec.models().includes(a.model) ? a.model : spec.defaultModel();
    } else if (change.model && change.model !== a.model) cfg.model = change.model;
    if (change.guardrails) cfg.guardrails = change.guardrails.map((g) => g.trim()).filter(Boolean);
    if (change.collaboration !== undefined && change.collaboration !== a.collaboration) cfg.collaboration = change.collaboration.trim();
    if (Object.keys(cfg).length) reconfigure(name, cfg, root);
    if (change.level && change.level !== a.autonomy) setAutonomy(name, change.level, root);
    if (change.budgetUsd !== undefined && change.budgetUsd !== a.budgetUsd) {
      if (!(change.budgetUsd >= 0)) throw new Error("A budget is a number of dollars, zero or more.");
      setBudget(name, change.budgetUsd, root);
    }
    touch(projectId);
    return agentOf(projectId, name);
  }

  // -- tasks ---------------------------------------------------------------

  function addTask(input: NewTask): Task {
    const p = host.project(input.projectId);
    host.ensureOrg(p.path);
    const verifiers: VerifierSpec[] = (input.checks ?? []).map((c) => c.trim()).filter(Boolean).map((c) => parseVerifier(c));
    const samples = Math.max(1, Math.floor(input.samples ?? 1));
    if (samples > 1 && !host.license().limits.attempts) throw new Error("Several attempts per task are part of Pro.");
    const t = coreAddTask(
      {
        title: input.title, assignee: input.assignee, priority: input.priority ?? "normal", provider: input.provider ?? null, verifiers, samples, sandbox: input.sandbox ?? null,
        arms: pinnedArms(p.path, input.assignee, input.provider ?? null, samples),
      },
      p.path,
    );
    if (input.run && input.assignee && busy(input.projectId, input.assignee)) waitFor(input.projectId, t.id);
    else if (input.run && input.assignee) {
      try {
        startTask(input.projectId, t, "delegate");
      } catch (e) {
        touch(input.projectId);
        throw new Error(`Queued. It could not start yet: ${message(e)}`);
      }
    }
    touch(input.projectId);
    const entries = readLedger(p.path);
    return taskView(findTask(t.id, p.path) ?? t, p.path, entries);
  }

  /**
   * One attempt runs where the person put it: the assignee's provider and model, or the provider named on the task.
   * The router only picks arms when several attempts compare them. Otherwise a task for a Claude agent could
   * land on a metered key nobody chose.
   */
  function pinnedArms(root: string, assignee: string | null, provider: Provider | null, samples: number): Array<{ provider: Provider; model: string }> | undefined {
    if (samples > 1 || !assignee) return undefined;
    const a = findAgent(assignee, root);
    if (!a) return undefined;
    if (provider && provider !== a.provider) return [{ provider, model: providerFor(provider).defaultModel() }];
    return [{ provider: a.provider, model: a.model }];
  }

  /**
   * A task still marked running whose run already ended was cut off by a closed app.
   * A run in flight elsewhere, such as the terminal dashboard, has no end yet and is left alone.
   */
  function reconcile(root: string): void {
    try {
      if (!orgExists(root)) return;
      for (const t of staleRunningTasks(root)) updateTask(t.id, { status: "failed", note: "The run ended without settling the task. Run it again." }, root);
      // Nothing runs in this process yet. A task with no open run anywhere was cut off.
      const entries = readLedger(root);
      const ended = new Set(entries.filter((e) => e.type === "delegate_end").map((e) => String(e.data.id ?? "")));
      const open = new Set(entries.filter((e) => e.type === "delegate_start" && !ended.has(String(e.data.id ?? ""))).map((e) => String(e.data.taskId ?? "")));
      for (const t of listTasks(root)) {
        if ((t.status === "running" || t.status === "verifying") && !open.has(t.id)) updateTask(t.id, { status: "failed", note: "The app closed before this task settled. Run it again." }, root);
      }
    } catch {
      /* best effort */
    }
  }

  /** Every idle agent with queued work starts its next task. */
  function dispatch(projectId: string): number {
    const root = rootOf(projectId);
    if (!orgExists(root)) return 0;
    const order: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };
    const queued = listTasks(root).filter((t) => t.status === "queued" && t.assignee).sort((a, b) => order[a.priority] - order[b.priority] || a.createdAt - b.createdAt);
    const taken = new Set<string>();
    let started = 0;
    for (const t of queued) {
      const who = t.assignee!;
      if (taken.has(who) || busy(projectId, who) || cooling(root, t) || host.workspaceAgents(projectId).has(who)) continue;
      const a = findAgent(who, root);
      if (!a || budgetCheck(who, root)) continue;
      taken.add(who);
      try {
        startTask(projectId, t, "dispatch");
        started++;
      } catch {
        /* stays queued */
      }
    }
    return started;
  }

  // -- the surface ---------------------------------------------------------

  const timer = setInterval(() => {
    if (!disposed) poll();
  }, 2000);
  timer.unref?.();

  return {
    busy,
    /** Team runs in flight for a project, the chief's included. */
    running(projectId: string): number {
      return [...runs.values()].filter((r) => r.projectId === projectId && r.status === "running").length;
    },
    /** Whether a team run, not a workspace chat, has this agent. */
    teamBusy(projectId: string, agent: string): boolean {
      for (const r of runs.values()) if (r.projectId === projectId && r.agent === agent && r.status === "running") return true;
      return false;
    },
    summaries(): Record<string, OrgSummary> {
      const out: Record<string, OrgSummary> = {};
      for (const p of host.projects()) {
        if (!summaries.has(p.id)) {
          reconcile(p.path);
          summaries.set(p.id, summarize(p.id));
        }
        out[p.id] = summaries.get(p.id)!;
      }
      return out;
    },
    touch,
    handlers: {
      org: ({ projectId }: { projectId: string }) => org(projectId),
      agentDetail: ({ projectId, name }: { projectId: string; name: string }) => agentDetail(projectId, name),
      roleTemplates: (): RoleTemplate[] =>
        ROLE_TEMPLATES.map((t) => ({ name: t.name, role: t.brief, level: t.suggestIsolated ? "execute" : "observe", budgetUsd: 5, isolated: t.suggestIsolated })),
      hireAgent: (p: NewAgent) => hireAgent(p),
      updateAgent: ({ projectId, name, change }: { projectId: string; name: string; change: AgentChange }) => updateAgent(projectId, name, change),
      isolateAgent: ({ projectId, name }: { projectId: string; name: string }) => {
        const root = rootOf(projectId);
        const a = findAgent(name, root);
        if (!a) throw new Error(`No agent named "${name}" on this team.`);
        if (!a.branch) {
          if (!hasCommits(root)) throw new Error("A branch needs a first commit to start from.");
          provisionWorktree(name, root);
        }
        touch(projectId);
        return agentOf(projectId, name);
      },
      fireAgent: ({ projectId, name, reason }: { projectId: string; name: string; reason: string | null }) => {
        refuseWorkspaceAgent(projectId, name, "Delete");
        if (busy(projectId, name)) throw new Error(`${name} is working. Stop the run first.`);
        fire(name, reason, rootOf(projectId));
        touch(projectId);
      },
      mergeAgent: ({ projectId, name }: { projectId: string; name: string }) => {
        refuseWorkspaceAgent(projectId, name, "Merge");
        const root = rootOf(projectId);
        if (busy(projectId, name)) throw new Error(`${name} is working. Merge once the run ends.`);
        cleanCheckout(root);
        const r = mergeAgentBranch(name, {}, root);
        touch(projectId);
        if (r.ok) return { ok: true, message: `Merged ${branchNameFor(name)} into ${currentBranch(root) ?? "the checkout"}.`, conflicts: [] };
        abortMerge(root);
        return {
          ok: false, conflicts: r.conflicts,
          message: r.conflicts.length ? `The branch conflicts in ${r.conflicts.join(", ")}. The merge was undone. Ask ${name} to update from the base, then merge again.` : `The merge failed: ${r.error.slice(0, 200)}`,
        };
      },
      delegate: ({ projectId, agent, task }: { projectId: string; agent: string; task: string }) => {
        const root = rootOf(projectId);
        host.ensureOrg(root);
        refuseWorkspaceAgent(projectId, agent, "Talk to");
        const t = coreAddTask({ title: task, assignee: agent }, root);
        // A busy agent picks it up later. Queued is the answer, not an error.
        if (busy(projectId, agent)) {
          waitFor(projectId, t.id);
          touch(projectId);
          return null;
        }
        try {
          startTask(projectId, t, "delegate");
        } catch (e) {
          touch(projectId);
          throw new Error(`Queued for ${agent}. ${message(e)}`);
        }
        touch(projectId);
        return [...runs.values()].filter((r) => r.taskId === t.id).map(publicRun)[0] ?? null;
      },
      broadcast: ({ projectId, task, agents }: { projectId: string; task: string; agents: string[] }) => {
        const root = rootOf(projectId);
        const ws = host.workspaceAgents(projectId);
        const names = agents.length ? agents : readRoster(root).agents.filter((a) => !a.chief && !ws.has(a.name)).map((a) => a.name);
        if (!names.length) throw new Error("Hire someone first.");
        const started: string[] = [];
        const queued: string[] = [];
        for (const name of names) {
          const t = coreAddTask({ title: task, assignee: name }, root);
          if (busy(projectId, name)) {
            waitFor(projectId, t.id);
            queued.push(name);
            continue;
          }
          try {
            startTask(projectId, t, "broadcast");
            started.push(name);
          } catch {
            queued.push(name);
          }
        }
        touch(projectId);
        return { started, queued };
      },
      cancelRun: ({ projectId, key }: { projectId: string; key: string }) => {
        const r = runs.get(key);
        if (!r || r.projectId !== projectId || r.status !== "running") return;
        r.cancelRequested = true;
        r.handle?.cancel();
      },
      dismissRun: ({ projectId, key }: { projectId: string; key: string }) => {
        const r = runs.get(key);
        if (r && r.projectId === projectId && r.status !== "running") runs.delete(key);
        touch(projectId);
      },
      addTask: (p: NewTask) => addTask(p),
      editTask: ({ projectId, id, title, assignee, priority }: { projectId: string; id: string; title?: string; assignee?: string | null; priority?: TaskPriority }) => {
        const root = rootOf(projectId);
        const before = findTask(id, root);
        // A pinned arm follows the assignee. The router's choices for several attempts stay.
        const arms = assignee !== undefined && before && before.samples <= 1 && before.arms.length <= 1 ? pinnedArms(root, assignee, before.provider, 1) : undefined;
        updateTask(id, { ...(title !== undefined ? { title } : {}), ...(assignee !== undefined ? { assignee } : {}), ...(priority ? { priority } : {}), ...(arms ? { arms } : {}) }, root);
        touch(projectId);
        return taskView(findTask(id, root)!, root, readLedger(root));
      },
      runTask: ({ projectId, id }: { projectId: string; id: string }) => {
        const t = findTask(id, rootOf(projectId));
        if (!t) throw new Error("That task is gone.");
        startTask(projectId, t, "delegate");
        touch(projectId);
      },
      cancelTask: ({ projectId, id }: { projectId: string; id: string }) => {
        const root = rootOf(projectId);
        const live = [...runs.values()].filter((r) => r.projectId === projectId && r.taskId === id && r.status === "running");
        const tr = taskRuns.get(`${projectId}:${id}`);
        if (tr) tr.cancel();
        for (const r of live) {
          r.cancelRequested = true;
          r.handle?.cancel();
        }
        if (!live.length && !tr) {
          const t = findTask(id, root);
          if (t && t.status !== "done" && t.status !== "cancelled") updateTask(id, { status: "cancelled" }, root);
        }
        touch(projectId);
      },
      requeueTask: ({ projectId, id }: { projectId: string; id: string }) => {
        updateTask(id, { status: "queued" }, rootOf(projectId));
        touch(projectId);
      },
      dispatch: ({ projectId }: { projectId: string }) => {
        const started = dispatch(projectId);
        touch(projectId);
        return { started };
      },
      routeTask: ({ projectId, title }: { projectId: string; title: string }) =>
        recommend(taskKind(title), rootOf(projectId), 3).map((c) => ({ provider: c.arm.provider, model: c.arm.model, why: c.why })),
      hireChief: ({ projectId, provider }: { projectId: string; provider?: Provider }) => {
        if (!host.license().limits.chief) throw new Error("The chief of staff is part of Pro.");
        const root = rootOf(projectId);
        host.ensureOrg(root);
        ensureChief(root, { provider });
        touch(projectId);
        return chiefView(projectId, root, readLedger(root))!;
      },
      chiefSend: ({ projectId, text }: { projectId: string; text: string }) => {
        if (!host.license().limits.chief) throw new Error("The chief of staff is part of Pro.");
        const root = rootOf(projectId);
        const clean = text.trim();
        if (!clean) return;
        host.ensureOrg(root);
        const { agent: c } = ensureChief(root);
        if (chiefRun(projectId)) throw new Error(`${c.name} is still replying. Send once the reply ends.`);
        const over = budgetCheck(c.name, root);
        if (over) throw new Error(over);
        const conv = conversation(c.name, root);
        startRun(projectId, c.name, clean, {
          via: "chief", ledgerVia: "chat", resume: resumableSession(conv, c), prompt: chatPrompt(clean, conv, c, root),
          onFinished: (res) => afterChiefReply(projectId, c.name, res),
        });
        touch(projectId);
      },
      chiefStop: ({ projectId }: { projectId: string }) => {
        const r = chiefRun(projectId);
        if (!r) return;
        r.cancelRequested = true;
        r.handle?.cancel();
      },
      chiefNew: ({ projectId }: { projectId: string }) => {
        const root = rootOf(projectId);
        const c = findChief(root);
        if (!c) return;
        if (chiefRun(projectId)) throw new Error("Wait for the reply to end.");
        newConversation(c.name, root);
        touch(projectId);
      },
      chiefSet: ({ projectId, provider, model, level, allowanceUsd }: { projectId: string; provider?: Provider; model?: string; level?: import("../shared/api").Level; allowanceUsd?: number }) => {
        const root = rootOf(projectId);
        const c = findChief(root);
        if (!c) throw new Error("There is no chief of staff yet.");
        if ((provider || model) && chiefRun(projectId)) throw new Error("Switch once the reply ends.");
        updateAgent(projectId, c.name, { provider, model, level, budgetUsd: allowanceUsd });
        return chiefView(projectId, root, readLedger(root))!;
      },
      decide: ({ projectId, id, approve }: { projectId: string; id: string; approve: boolean }) => {
        const root = rootOf(projectId);
        const req = pendingApprovals(root).find((a) => a.id === id);
        if (!req) throw new Error("That request was already decided.");
        if (approve && req.action === "merge") cleanCheckout(root);
        const r = decideApproval(id, approve, root);
        if (approve && req.action === "merge" && !r.ok) {
          abortMerge(root);
          // The work still deserves a decision. A fresh request keeps it reachable.
          const why = r.conflicts?.length ? `The last try conflicted in ${r.conflicts.join(", ")}.` : "The last try failed.";
          requestApproval("merge", { taskId: req.taskId, attemptId: req.attemptId, agent: req.agent, branch: req.branch, summary: `${req.summary.replace(/ The last try (conflicted|failed)[^]*$/, "")} ${why}`, evidence: req.evidence }, root);
          r.message = r.conflicts?.length
            ? `The branch conflicts in ${r.conflicts.join(", ")}. The merge was undone and the request is back in Approvals. Bring the checkout up to date, or run the task again.`
            : `${r.message} The request is back in Approvals.`;
        }
        touch(projectId);
        return { ok: r.ok, message: r.message };
      },
      setAutoMerge: ({ projectId, on }: { projectId: string; on: boolean }) => {
        const root = rootOf(projectId);
        host.ensureOrg(root);
        setAutoMerge(on, root);
        touch(projectId);
      },
      setMission: ({ projectId, objective, criteria, guardrails, checks }: { projectId: string; objective: string; criteria: string[]; guardrails: string[]; checks: string[] }) => {
        const root = rootOf(projectId);
        host.ensureOrg(root);
        coreSetMission(
          {
            objective, successCriteria: criteria.map((c) => c.trim()).filter(Boolean), orgGuardrails: guardrails.map((g) => g.trim()).filter(Boolean),
            checks: checks.map((c) => c.trim()).filter(Boolean).map((c) => parseVerifier(c)),
          },
          root,
        );
        touch(projectId);
        return missionView(root)!;
      },
      checkMission: async ({ projectId }: { projectId: string }) => {
        const root = rootOf(projectId);
        if (!currentMission(root)) throw new Error("Set a mission first.");
        await coreCheckMission(root);
        touch(projectId);
        return missionView(root)!;
      },
      postNote: ({ projectId, to, text }: { projectId: string; to: string; text: string }) => {
        const root = rootOf(projectId);
        host.ensureOrg(root);
        postMessage({ from: "you", to: to || "*", text }, root);
        touch(projectId);
      },
      addDocket: async ({ projectId, input, agents }: { projectId: string; input: string; agents: string[] }) => {
        const root = rootOf(projectId);
        host.ensureOrg(root);
        const it = await addContext(input, root, { agents });
        touch(projectId);
        return docketView(it);
      },
      removeDocket: ({ projectId, id }: { projectId: string; id: string }) => {
        removeContext(id, rootOf(projectId));
        touch(projectId);
      },
      shareDocket: ({ projectId, id, agent, give }: { projectId: string; id: string; agent: string; give: boolean }) => {
        if (give) giveContext(id, agent, rootOf(projectId), "you");
        else takeContext(id, agent, rootOf(projectId), "you");
        touch(projectId);
      },
      refreshDocket: async ({ projectId, id }: { projectId: string; id: string }) => {
        const it = await refreshContext(id, rootOf(projectId));
        touch(projectId);
        return docketView(it);
      },
      companies: (): Company[] => COMPANIES.map((c) => ({ id: c.id, title: c.title, tagline: c.tagline, seats: c.seats.length })),
      previewCompany: ({ projectId, id, scale }: { projectId: string; id: string; scale: number }): CompanyPreview => {
        const t = findCompany(id);
        if (!t) throw new Error("No such company template.");
        const plan = planCompany(t, rootOf(projectId), { scale: Math.max(1, Math.min(10, Math.floor(scale))) });
        return {
          id: t.id, title: t.title, totalCapUsd: plan.totalCapUsd, chief: plan.chief, note: plan.worktreeNote,
          seats: plan.seats.map((s) => ({ name: s.name, brief: s.brief, provider: s.provider, model: s.model, level: s.autonomy, budgetUsd: s.budgetUsd, isolated: s.isolated, movedFrom: s.movedFrom, skip: s.skip })),
        };
      },
      hireCompany: ({ projectId, id, scale }: { projectId: string; id: string; scale: number }) => {
        if (!host.license().limits.companies) throw new Error("Hiring a whole company at once is part of Pro.");
        const t = findCompany(id);
        if (!t) throw new Error("No such company template.");
        const root = rootOf(projectId);
        host.ensureOrg(root);
        const plan = planCompany(t, root, { scale: Math.max(1, Math.min(10, Math.floor(scale))) });
        const limit = host.license().limits.teamAgents;
        if (limit !== null) checkTeamLimit(projectId, plan.seats.filter((s) => !s.skip).length);
        const result = coreHireCompany(plan, root);
        touch(projectId);
        const failed = result.failed.length ? ` ${result.failed.length} could not be hired: ${result.failed.join("; ")}` : "";
        return { hired: result.hired, message: `Hired ${describeHire(result, plan)}.${failed}` };
      },
      suggestTeam: async ({ projectId }: { projectId: string }): Promise<Suggestion> => {
        const root = rootOf(projectId);
        const prop = await coreSuggestTeam(root, {});
        return {
          summary: prop.summary,
          agents: prop.team.map((s) => ({ name: s.name, role: s.role, provider: s.provider, model: s.model, budgetUsd: s.budgetUsd, isolated: s.isolated, level: s.autonomy, why: s.evidence.slice(0, 2).join(" ") })),
        };
      },
      integrations: async ({ projectId }: { projectId: string }): Promise<Integrations> => {
        const root = rootOf(projectId);
        const gh = githubStatus(root);
        const hf = await hfStatus().catch(() => null);
        const skills = await skillCatalog(root).catch(() => []);
        return {
          github: { ready: gh.installed && gh.signedIn, detail: gh.installed ? (gh.signedIn ? `Signed in${gh.account ? ` as ${gh.account}` : ""}${gh.repo ? `. Repository ${gh.repo}` : ""}.` : (gh.fix ?? "Not signed in.")) : (gh.fix ?? "The gh command is not installed.") },
          huggingface: { ready: !!hf?.token, detail: hf ? (hf.token ? `Token found${hf.account ? ` for ${hf.account}` : ""}.` : "No token. Public models, datasets and papers still work.") : "Could not reach Hugging Face." },
          skills: skills.map((s) => ({ name: s.name, source: s.source, description: s.description, ready: s.status === "ready" })),
          sandboxes: (["docker", "ssh"] as const).map((kind) => {
            const r = sandboxReadiness(kind);
            return { kind, ready: r.ready, detail: r.reason };
          }),
        };
      },
      verifyLedger: ({ projectId }: { projectId: string }) => {
        const root = rootOf(projectId);
        if (!orgExists(root)) return { ok: true, entries: 0, detail: "No record yet." };
        const check = verify(root);
        return { ok: check.ok, entries: check.entriesChecked, detail: check.ok ? `${check.entriesChecked} entries. The hash chain is intact.` : `The chain breaks at entry ${check.brokenAtSeq ?? "?"}. ${check.reason ?? ""}`.trim() };
      },
    },
    dispose: async (): Promise<void> => {
      closing = true;
      clearInterval(timer);
      const i = promoteHooks.indexOf(guardedMergeGate);
      if (i >= 0) promoteHooks.splice(i, 1, mergeGate);
      const live = [...runs.values()].filter((r) => r.status === "running" && r.handle);
      for (const tr of taskRuns.values()) tr.cancel();
      for (const r of live) r.handle!.cancel();
      await Promise.race([Promise.all(live.map((r) => r.handle!.finished.catch(() => null))), new Promise((res) => setTimeout(res, 2500))]);
      disposed = true;
    },
  };
}

function specText(spec: VerifierSpec): string {
  return verifierName(spec);
}
