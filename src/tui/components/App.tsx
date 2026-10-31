/**
 * Dashboard shell: layout, key handling, and the subscriptions to every
 * workspace's `.ceo/`.
 *
 * Everything below this component is presentational except the dialogs, and
 * even they only collect input. Every write goes through `../actions.js`,
 * which is the whole list of things a keypress here can change about an org.
 * App owns what is genuinely the UI's own: which workspace is on screen,
 * which panel has focus, which row is selected in it, what is open on top of
 * the dashboard, and the two transient lines at the bottom.
 *
 * Three panels can hold focus: the workspace sidebar, the roster, and the
 * queue. Tab moves between them. The mutating keys, hire, fire, budget, merge
 * and autonomy, act on the roster's selected agent whatever has focus. They
 * have no meaning for a task or a workspace. Taking them away when the cursor
 * is one panel over would be a rule to memorise for no gain.
 *
 * The one structural rule: while a dialog is open, App's own key handler
 * returns immediately. `useInput` fires in every mounted component, so
 * without that, typing "q" into the hire form's name field would quit the
 * app mid-sentence. The handler stays *registered* rather than deactivated
 * so raw mode is never handed back and re-taken between two frames.
 *
 * Delegation is the exception to "every write goes through actions.ts". A hire
 * finishes inside the keystroke that asked for it. A delegation spawns a
 * process, streams for minutes, and can be killed halfway. So its state lives
 * in `../runs.js` and the run pane renders it. Runs are held across every
 * workspace, so switching the sidebar never loses one.
 *
 * The chat is the other way in. `C` opens a conversation with the org's
 * chief of staff, hiring one with the defaults when the org has none. Each
 * message is a run of the chief, resumed on the same CLI session, and the
 * work the chief delegates during a reply is started here when the reply
 * ends. The operator's message is the authorization for that spend. Work
 * given to a busy agent starts when that agent's current run settles.
 *
 * The dispatcher is the piece that makes this an orchestrator rather than a
 * viewer. With auto on, any agent in any registered workspace that is idle
 * and has a queued task picks it up. It is off by default, and the status bar
 * says so when it is on. It is the one thing on this screen that spends
 * money without a keystroke per dollar.
 */

import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isTab, isReturn, isEscape } from "../keys.js";
import { initLedger } from "../../core/ledger.js";
import { orgExists, projectRoot } from "../../core/paths.js";
import { findTask, listTasks, type Task } from "../../core/tasks.js";
import { usesAttempts } from "../../core/attempts.js";
import { syncReflexSkills } from "../../core/loop.js";
import type { AgentRecord, AutonomyLevel, Provider } from "../../core/types.js";
import { ensureCurrentWorkspace, touchWorkspace } from "../../core/workspaces.js";
import { allReadiness, anyReady, loginCommand, resetReadiness, type Readiness } from "../../core/setup.js";
import { suggestTeam, type TeamProposal, type TeamSuggestion } from "../../core/suggest.js";
import { reflexScanCommand, reflexStatus, resetReflexStatus } from "../../core/reflex.js";
import { nextProvider } from "../../core/providers.js";
import {
  chatPrompt,
  conversation,
  ensureChief,
  newConversation,
  resumableSession,
  staffingFor,
  startableAfter,
} from "../../core/chat.js";
import { budgetCheck, findAgent, findChief } from "../../core/roster.js";
import { describeHire, hireCompany, type CompanyPlan } from "../../core/companies.js";
import { addContext, giveContext, itemText, listContext, refreshContext, removeContext, takeContext, tokenLabel, type ContextItem } from "../../core/context.js";
import { githubStatus, listIssues, openPullRequest, resetGithubStatus, type Issue } from "../../core/github.js";
import { hfStatus, type HfStatus } from "../../core/huggingface.js";
import { readAlerts, sendAlert, writeAlerts, type Alert, type AlertConfig } from "../../core/alerts.js";
import { approveWorkflow, skillCatalog, type Skill } from "../../core/skills.js";
import { addTask } from "../../core/tasks.js";
import { readLedger } from "../../core/ledger.js";
import { notReadyReason } from "../../core/setup.js";
import type { RunResult } from "../../core/runner.js";
import { spawn } from "node:child_process";
import { openWindow } from "../../core/tmux.js";
import {
  addQueueTask,
  baseBranch,
  editQueueTask,
  fireAgent,
  forgetWorkspace,
  hireAgent,
  mergeAgent,
  openShellWindow,
  readUnmerged,
  registerWorkspace,
  saveMission,
  isolateAgent,
  setAgentAutonomy,
  setAgentProvider,
  setAgentBudget,
  setQueueTaskStatus,
} from "../actions.js";
import { useOrgState } from "../data.js";
import { runKey, useRuns, type FinishedRun, type RunState } from "../runs.js";
import { useWorkspaces } from "../workspaces.js";
import { clamp, clock, compactBudget, fit, nextAutonomy, tilde, usdExact, wrap } from "../format.js";
import { cooldowns, coolingDown, maxRunning } from "../../core/limits.js";
import { dispatchPlan } from "../../core/outcomes.js";
import Activity from "./Activity.js";
import AgentDetail from "./AgentDetail.js";
import AuditPanel from "./AuditPanel.js";
import BudgetForm from "./BudgetForm.js";
import Chat from "./Chat.js";
import CompanyPicker from "./CompanyPicker.js";
import LiveBoard from "./LiveBoard.js";
import Sky from "./Sky.js";
import Docket from "./Docket.js";
import { Integrations, IssuePicker, PrDialog, SkillPicker } from "./Integrations.js";
import DelegateForm from "./DelegateForm.js";
import FireDialog, { type FireChoice } from "./FireDialog.js";
import Approvals from "./Approvals.js";
import { pendingApprovals } from "../../core/gates.js";
import HelpOverlay from "./HelpOverlay.js";
import HireForm, { TEMPLATE_PRESETS, type HirePreset } from "./HireForm.js";
import MergeDialog, { ConflictReport } from "./MergeDialog.js";
import MissionForm from "./MissionForm.js";
import MissionPanel from "./MissionPanel.js";
import Queue from "./Queue.js";
import Roster from "./Roster.js";
import RunPane, { spinnerFrame } from "./RunPane.js";
import Sidebar from "./Sidebar.js";
import SetupScreen from "./SetupScreen.js";
import StatusBar from "./StatusBar.js";
import SuggestPanel from "./SuggestPanel.js";
import TaskForm from "./TaskForm.js";
import WorkspaceManager from "./WorkspaceManager.js";

/** Hints clear themselves. A dashboard should not accumulate chrome. */
const HINT_MS = 6000;

/** Mutation results are shorter-lived: the roster below already shows them. */
const FLASH_MS = 4000;

/** Past this, a dialog is stretched rather than readable. */
const MAX_MODAL_WIDTH = 100;

/** How often the elapsed clock and the spinner advance while a run is live. */
const TICK_MS = 120;

/** How often the dispatcher looks for idle agents with queued work. */
const DISPATCH_MS = 1500;

const AUDIT_HINT = "Audits run in Claude Code: /audit.";

/**
 * What is open on top of the dashboard.
 *
 * Agents are held by name, not by record: the watcher can replace the roster
 * underneath an open dialog. A stale copy of an agent would show a budget
 * that has already moved.
 */
type Modal =
  | { kind: "hire"; preset?: HirePreset | null }
  | { kind: "suggest" }
  | { kind: "company" }
  | { kind: "integrations" }
  | { kind: "issues"; agent: string | null }
  | { kind: "skills"; agent: string | null }
  | { kind: "pr"; agent: string }
  | { kind: "delegate" }
  | { kind: "task"; task: Task | null }
  | { kind: "workspaces" }
  | { kind: "budget"; agent: string }
  | { kind: "fire"; agent: string; unmerged: string[]; base: string }
  | { kind: "merge"; agent: string; unmerged: string[]; base: string }
  | { kind: "conflicts"; agent: string; conflicts: string[]; error: string }
  | { kind: "mission" }
  | { kind: "approvals" }
  | { kind: "setup" }
  | { kind: "help" };

type Flash = { text: string; tone: "ok" | "error" };

type Focus = "sidebar" | "roster" | "queue";

/** Terminal dimensions, kept live across resizes. */
function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });

  useEffect(() => {
    if (!stdout) return;
    const onResize = () =>
      setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", onResize);
    onResize();
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}

export function App({ initialView }: { initialView?: "chat" | "sky" } = {}) {
  const { exit } = useApp();
  const { columns, rows: terminalRows } = useTerminalSize();
  // Every screen is drawn one row short of the terminal. Ink clears the whole
  // terminal before any frame as tall as the terminal, and the spinner ticks
  // eight times a second, so a full-height frame blinks on every tick. One row
  // short, Ink rewrites the frame in place: no blink, and no stale rows left
  // behind when a shorter screen replaces a taller one.
  const rows = Math.max(10, terminalRows - 1);

  // The workspace on screen. Starts as the cwd's git root, registered if it
  // has an org. Opening `ceo` in a new project thus puts it in the sidebar of
  // every dashboard after this one.
  const [activePath, setActivePath] = useState<string>(() => {
    const ws = ensureCurrentWorkspace();
    return ws?.path ?? projectRoot();
  });
  const { workspaces, refresh: refreshWorkspaces } = useWorkspaces();
  const activeWorkspace = workspaces.find((w) => w.path === activePath) ?? null;
  const workspaceName = activeWorkspace?.name ?? projectRoot(activePath).split("/").pop() ?? "org";

  const state = useOrgState(activePath);
  const refresh = state.refresh;

  const agents = state.roster?.agents ?? [];
  const tasks = state.tasks;
  // Read when the ledger changes, not on every frame.
  const approvalsWaiting = useMemo(() => {
    try {
      return pendingApprovals(activePath).length;
    } catch {
      return 0;
    }
  }, [activePath, state.ledgerLength]);
  const [selected, setSelected] = useState(0);
  const [selectedTask, setSelectedTask] = useState(0);
  const [focus, setFocus] = useState<Focus>("roster");
  const [sidebarPinned, setSidebarPinned] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  // Provider readiness is a pair of subprocess calls, so it is read once at
  // launch and again only when the setup screen asks. The dashboard opens on
  // the setup screen when nothing can run: hiring an agent that can never
  // start is the first mistake this screen exists to prevent.
  const [readiness, setReadiness] = useState<Readiness[]>(() => allReadiness());
  const [modal, setModal] = useState<Modal | null>(() => (anyReady() ? null : { kind: "setup" }));
  const recheckReadiness = () => {
    resetReadiness();
    setReadiness(allReadiness());
  };

  // The suggested team is read when the panel opens, once per workspace.
  // It reads history files and Reflex's store, which is cheap but not free.
  // The answer does not change while the dashboard is open.
  // Keyed by workspace and roster, so hiring a seat and pressing p again
  // re-reads with that seat gone rather than offering it twice.
  const proposalKey = `${activePath}\u0000${agents.map((a) => a.name).join(",")}`;
  const [proposal, setProposal] = useState<{ root: string; value: TeamProposal | null; error: string | null }>({ root: "", value: null, error: null });
  useEffect(() => {
    if (modal?.kind !== "suggest" || proposal.root === proposalKey) return;
    let cancelled = false;
    setProposal({ root: proposalKey, value: null, error: null });
    suggestTeam(activePath, { taken: agents.map((a) => a.name) })
      .then((p) => {
        if (!cancelled) setProposal({ root: proposalKey, value: p, error: null });
      })
      .catch((e: unknown) => {
        if (!cancelled) setProposal({ root: proposalKey, value: null, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal?.kind, proposalKey]);

  // `s` on the suggest panel runs Reflex's own scan. Its stdout is read line
  // by line for the status row. When it exits the proposal is re-read, so the
  // seats reflect whatever the scan just found. One scan at a time.
  const [scan, setScan] = useState<{ running: boolean; startedAt: number; lastLine: string; error: string | null } | null>(null);
  const [reflex, setReflex] = useState(() => reflexStatus());
  const runReflexScan = () => {
    if (scan?.running) return;
    const [bin, ...args] = reflexScanCommand(30);
    const startedAt = Date.now();
    setScan({ running: true, startedAt, lastLine: "", error: null });
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      setScan({ running: false, startedAt, lastLine: "", error: e instanceof Error ? e.message : String(e) });
      return;
    }
    let stderr = "";
    const onLine = (chunk: Buffer) => {
      const line = chunk.toString().split("\n").map((l) => l.trim()).filter((l) => l && !/ExperimentalWarning|trace-warnings/.test(l)).pop();
      if (line) setScan((s) => (s ? { ...s, lastLine: line.slice(0, 80) } : s));
    };
    child.stdout?.on("data", onLine);
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
      onLine(c);
    });
    child.on("error", (e) => setScan({ running: false, startedAt, lastLine: "", error: e.message }));
    child.on("close", (code) => {
      resetReflexStatus();
      setReflex(reflexStatus());
      setScan({ running: false, startedAt, lastLine: "", error: code === 0 ? null : `exit ${code}${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}` });
      // Force the proposal effect to re-read for the active workspace.
      setProposal({ root: "", value: null, error: null });
    });
  };

  const seatToPreset = (s: TeamSuggestion): HirePreset => ({
    name: s.name,
    brief: s.role,
    collaboration: s.collaboration,
    provider: s.provider,
    model: s.model,
    budgetUsd: s.budgetUsd,
    autonomy: s.autonomy,
    isolated: s.isolated,
    guardrails: s.guardrails,
    tag: s.source === "reflex" ? "reflex" : "suggested",
  });
  const hirePresets: HirePreset[] =
    proposal.root === proposalKey && proposal.value
      ? [...proposal.value.team.map(seatToPreset), ...TEMPLATE_PRESETS.filter((t) => !proposal.value!.team.some((s) => s.name === t.name))]
      : TEMPLATE_PRESETS;
  const [hint, setHint] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [autoDispatch, setAutoDispatch] = useState(false);

  // Delegations in flight across every workspace, and which one the pane is
  // showing. The settle callback re-reads the org that moved: a finished run
  // has just changed the spend rollup and the queue, and neither updates
  // until `.ceo/` is re-read.
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  // The run hook is created below with this callback, so the callback reaches
  // the hook's own start and run map through refs filled in after it.
  const startRunRef = useRef<ReturnType<typeof useRuns>["start"] | null>(null);
  const runsRef = useRef<Map<string, RunState>>(new Map());
  const onSettled = useCallback(
    (workspace: string) => {
      if (workspace === activePathRef.current) refresh();
      refreshWorkspaces();
      // Work the chief gave to a busy agent starts when that agent is free.
      setTimeout(() => startChiefWork(workspace), 0);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refresh, refreshWorkspaces],
  );
  // Alerts read the latest dashboard state through a ref: the run hook keeps
  // the callback it was created with.
  const alertRef = useRef<(run: FinishedRun) => void>(() => {});
  const { runs, start: startPlainRun, cancel: cancelRun, dismiss: dismissRun, startTask } = useRuns(onSettled, (run) => alertRef.current(run));

  /** Whether an agent has a run in flight: its own, or one of its attempts. */
  const agentBusy = (workspace: string, agent: string): boolean =>
    [...runsRef.current.values()].some((r) => r.workspace === workspace && r.agent === agent && r.status === "running");

  /**
   * Start work. A queued task with verifiers or several samples runs as
   * attempts, one per arm, and reaches done only through a passing verdict.
   * Anything else is one plain run, as before.
   */
  const startRun: typeof startPlainRun = (workspace, agent, task, taskId = null, opts = {}) => {
    if (taskId && !opts.prompt) {
      let queued: Task | null = null;
      try {
        queued = findTask(taskId, workspace);
      } catch {
        queued = null;
      }
      if (queued && usesAttempts(queued)) {
        return startTask(workspace, taskId, (status, note) => {
          setFlash({ text: `${taskId} ${status}: ${note}`, tone: status === "done" ? "ok" : "error" });
        });
      }
    }
    return startPlainRun(workspace, agent, task, taskId, opts);
  };
  startRunRef.current = startRun;
  runsRef.current = runs;

  /**
   * Start every queued task the chief delegated whose assignee is idle. Runs
   * after any run settles. Skipped while the chief is mid-reply: work given
   * during a reply starts when the reply ends, in `afterChiefReply`.
   */
  function startChiefWork(workspace: string): void {
    const start = startRunRef.current;
    if (!start) return;
    let chief;
    let queue: Task[];
    try {
      chief = findChief(workspace);
      if (!chief || !staffingFor(chief.autonomy).start) return;
      queue = listTasks(workspace);
    } catch {
      return;
    }
    if (runsRef.current.get(runKey(workspace, chief.name))?.status === "running") return;
    const taken = new Set<string>();
    for (const t of queue) {
      if (!t.autoStart || t.requestedBy !== chief.name || t.status !== "queued" || !t.assignee || taken.has(t.assignee)) continue;
      if (agentBusy(workspace, t.assignee)) continue;
      taken.add(t.assignee);
      start(workspace, t.assignee, t.title, t.id);
    }
  }

  /** When a reply ends, start the work the chief delegated during it. */
  function afterChiefReply(workspace: string, chiefName: string, result: RunResult): void {
    const start = startRunRef.current;
    if (!start || !result.delegationId) return;
    let tasks: Task[];
    try {
      const chief = findAgent(chiefName, workspace);
      if (!chief || !staffingFor(chief.autonomy).start) return;
      tasks = startableAfter(conversation(chiefName, workspace), result.delegationId, workspace);
    } catch {
      return;
    }
    const started: string[] = [];
    const waiting: string[] = [];
    const taken = new Set<string>();
    for (const t of tasks) {
      const who = t.assignee as string;
      if (taken.has(who)) {
        waiting.push(who);
        continue;
      }
      const outcome = start(workspace, who, t.title, t.id);
      taken.add(who);
      (outcome.ok ? started : waiting).push(who);
    }
    if (started.length + waiting.length > 0) {
      const bits: string[] = [];
      if (started.length > 0) bits.push(`${chiefName} started ${[...new Set(started)].join(", ")}. esc, then L, shows them at work.`);
      if (waiting.length > 0) {
        const names = [...new Set(waiting)];
        bits.push(`${names.join(", ")} ${names.length === 1 ? "is" : "are"} busy, so that work starts when the current run ends.`);
      }
      setFlash({ text: bits.join(" "), tone: "ok" });
    }
    if (workspace === activePathRef.current) refresh();
    refreshWorkspaces();
  }
  const [focusedRun, setFocusedRun] = useState<string | null>(null);

  // Guard on quitting with work in flight. Armed by the first `q`, disarmed by
  // literally any other key, so it cannot linger and swallow a later quit.
  const [quitArmed, setQuitArmed] = useState(false);

  // The docket, and what is being fetched into it.
  const [docketOpen, setDocketOpen] = useState(false);
  const docketCursor = useRef<{ item: string | null; agent: string | null }>({ item: null, agent: null });
  const onDocketCursor = useCallback((c: { item: string | null; agent: string | null }) => {
    docketCursor.current = c;
  }, []);
  const [busy, setBusy] = useState<string | null>(null);
  const docketItems: ContextItem[] = (() => {
    try {
      return state.exists ? listContext(activePath) : [];
    } catch {
      return [];
    }
  })();
  // Previews read files, so each one is read once per size.
  const previewCache = useRef(new Map<string, string>());
  const textOf = (it: ContextItem): string => {
    const k = `${it.id}:${it.chars}:${it.agents.length}`;
    const hit = previewCache.current.get(k);
    if (hit !== undefined) return hit;
    const t = itemText(it, activePath).slice(0, 4000);
    previewCache.current.set(k, t);
    return t;
  };

  // Integrations: read when the screen opens.
  const [alerts, setAlerts] = useState<AlertConfig>(() => readAlerts());
  const [hf, setHf] = useState<HfStatus | null>(null);
  const [issues, setIssues] = useState<{ list: Issue[] | null; error: string | null }>({ list: null, error: null });
  const [skills, setSkills] = useState<Skill[] | null>(null);

  // The chat. The draft lives here so leaving the chat keeps what was typed.
  const [chatOpen, setChatOpen] = useState(initialView === "chat");
  // Alerts ask whether the chat is open when a reply lands.
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;
  // The live view: every agent by provider, and the exchanges between them.
  const [liveOpen, setLiveOpen] = useState(false);
  // The constellation: the same org drawn as a sky.
  const [skyOpen, setSkyOpen] = useState(initialView === "sky");
  const [chatDraft, setChatDraft] = useState("");

  // Runs for the workspace on screen, oldest first: the pane's switcher reads
  // left to right in the order the runs were started.
  const allRuns: RunState[] = [...runs.values()];
  const runList = allRuns
    .filter((r) => r.workspace === activePath)
    .sort((a, b) => a.startedAt - b.startedAt);
  const activeRunsEverywhere = allRuns.filter((r) => r.status === "running");
  const activeRuns = runList.filter((r) => r.status === "running");
  const runningNames = new Set(activeRuns.map((r) => r.agent));
  const runningPerWorkspace = new Map<string, number>();
  for (const r of activeRunsEverywhere) {
    runningPerWorkspace.set(r.workspace, (runningPerWorkspace.get(r.workspace) ?? 0) + 1);
  }
  const focused: RunState | null =
    (focusedRun ? runs.get(focusedRun) : null) ?? runList[runList.length - 1] ?? null;
  const focusedInView = focused && focused.workspace === activePath ? focused : runList[runList.length - 1] ?? null;

  // The sidebar earns its columns when there is more than one place to be,
  // or when pinned. On a single-workspace machine it stays out of the way.
  const sidebarVisible = sidebarPinned || workspaces.length > 1;

  // One clock for the elapsed counters and every spinner on screen, running
  // only while something is actually running. A dashboard watching an idle org
  // should not be re-rendering eight times a second.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (activeRunsEverywhere.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, [activeRunsEverywhere.length]);

  // Skills Reflex approved since the last look join the docket, where the
  // router can offer each one as an arm. Once per workspace per session.
  const syncedSkills = useRef(new Set<string>());
  useEffect(() => {
    if (!state.exists || syncedSkills.current.has(activePath)) return;
    syncedSkills.current.add(activePath);
    void syncReflexSkills(activePath)
      .then((added) => {
        if (added.length === 0) return;
        refresh();
        setFlash({ text: `Reflex skills joined the docket: ${added.join(", ")}. D shows them.`, tone: "ok" });
      })
      .catch(() => {});
  }, [activePath, state.exists]);

  // The roster and queue can shrink underneath the selection when something
  // is fired or settled in another window.
  useEffect(() => {
    if (selected > agents.length - 1) setSelected(Math.max(0, agents.length - 1));
  }, [agents.length, selected]);
  useEffect(() => {
    if (selectedTask > tasks.length - 1) setSelectedTask(Math.max(0, tasks.length - 1));
  }, [tasks.length, selectedTask]);

  // The selection follows the task, not the row. When a run settles and the
  // queue reorders, the cursor stays on the task it was on.
  const selectedTaskIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = selectedTaskIdRef.current;
    if (!id) return;
    const i = tasks.findIndex((t) => t.id === id);
    if (i >= 0 && i !== selectedTask) setSelectedTask(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);
  useEffect(() => {
    selectedTaskIdRef.current = tasks[selectedTask]?.id ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTask]);

  useEffect(() => {
    if (agents.length === 0 && detailOpen) setDetailOpen(false);
  }, [agents.length, detailOpen]);

  useEffect(() => {
    if (!sidebarVisible && focus === "sidebar") setFocus("roster");
  }, [sidebarVisible, focus]);

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(null), HINT_MS);
    return () => clearTimeout(t);
  }, [hint]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);

  const selectedAgent: AgentRecord | null = agents[selected] ?? null;
  const selectedTaskRow: Task | null = tasks[selectedTask] ?? null;

  // An agent named by an open dialog can be fired from another window. Close
  // rather than render a dialog about someone who is no longer in the org.
  useEffect(() => {
    if (!modal || !("agent" in modal)) return;
    if (modal.kind === "conflicts") return;
    if (!agents.some((a) => a.name === modal.agent)) setModal(null);
  }, [agents, modal]);

  const report = (result: { ok: boolean; message: string }) => {
    setFlash({ text: result.message, tone: result.ok ? "ok" : "error" });
    // The watcher would catch this within a debounce anyway. Refreshing here
    // makes the roster move on the same frame as the message that explains it.
    refresh();
    refreshWorkspaces();
  };

  // -- workspaces ---------------------------------------------------------

  const switchWorkspace = (p: string) => {
    if (p === activePath) return;
    setActivePath(p);
    touchWorkspace(p);
    setSelected(0);
    setSelectedTask(0);
    setDetailOpen(false);
    setFocusedRun(null);
  };

  const cycleWorkspace = (delta: number) => {
    if (workspaces.length === 0) return;
    const i = workspaces.findIndex((w) => w.path === activePath);
    const next = workspaces[(Math.max(0, i) + delta + workspaces.length) % workspaces.length];
    if (next) switchWorkspace(next.path);
  };

  // -- actions ------------------------------------------------------------

  const openBudget = (agent: AgentRecord) => setModal({ kind: "budget", agent: agent.name });

  const openFire = (agent: AgentRecord) =>
    setModal({
      kind: "fire",
      agent: agent.name,
      unmerged: agent.isolated ? readUnmerged(agent.name, activePath) : [],
      base: baseBranch(activePath),
    });

  const openMerge = (agent: AgentRecord) => {
    if (!agent.isolated) {
      setFlash({
        text: `${agent.name} works in the main tree, so it has no branch to merge. Hire with isolation to get one.`,
        tone: "error",
      });
      return;
    }
    setModal({
      kind: "merge",
      agent: agent.name,
      unmerged: readUnmerged(agent.name, activePath),
      base: baseBranch(activePath),
    });
  };

  /**
   * Move the selected agent one step around the cycle: observe, then propose,
   * then execute, then autonomous, then back to observe. A cycle rather than
   * a menu because there are four of them in a fixed order and the flash line
   * says what the new one means.
   */
  const cycleAutonomy = (agent: AgentRecord) => {
    const next: AutonomyLevel = nextAutonomy(agent.autonomy);
    report(setAgentAutonomy(agent.name, next, activePath));
  };

  /**
   * Run a queued task. `startRun` re-checks the budget and the one-run-per-
   * agent rule. The queue's copy of the roster can be a refresh out of date,
   * and `begin()` is the only thing that actually decides.
   */
  const runTask = (task: Task, workspace: string = activePath): boolean => {
    if (task.status !== "queued" || !task.assignee) {
      setFlash({
        text:
          task.status === "blocked"
            ? `${task.id} is blocked: ${task.blockedReason}.`
            : `${task.id} is ${task.status}; only a queued task can run. u requeues a settled one.`,
        tone: "error",
      });
      return false;
    }
    const outcome = startRun(workspace, task.assignee, task.title, task.id);
    if (outcome.ok) {
      if (workspace === activePath) setFocusedRun(runKey(workspace, task.assignee));
      setFlash({ text: `${task.assignee} started: ${task.title}`, tone: "ok" });
      refresh();
      refreshWorkspaces();
      return true;
    }
    setFlash({ text: outcome.message, tone: "error" });
    return false;
  };

  /**
   * Delegate now: the free-form form queues a task and runs it in one go,
   * so ad-hoc work lands in the queue's history beside the planned kind.
   */
  const doDelegate = (agentName: string, taskText: string) => {
    setModal(null);
    const added = addQueueTask({ title: taskText, assignee: agentName, priority: "normal" }, activePath);
    if (!added.ok || !added.id) {
      setFlash({ text: added.message, tone: "error" });
      return;
    }
    const outcome = startRun(activePath, agentName, taskText, added.id);
    if (outcome.ok) {
      setFocusedRun(runKey(activePath, agentName));
      setFlash({ text: `${agentName} started: ${taskText}`, tone: "ok" });
      // `delegate_start` is already on disk, so show it on this frame.
      refresh();
      refreshWorkspaces();
      return;
    }
    setFlash({ text: outcome.message, tone: "error" });
    refresh();
  };

  /**
   * One pass of the dispatcher over one workspace: every agent with no run
   * in flight picks up its first queued task. Returns how many started.
   * Reads the queue fresh from the ledger rather than from React state so a
   * task added a moment ago from another window is not missed.
   */
  const dispatchOnce = (workspace: string, limit = Infinity): number => {
    let started = 0;
    let queue: Task[];
    try {
      queue = listTasks(workspace);
    } catch {
      return 0;
    }
    const taken = new Set<string>();
    // No ceiling unless CEO_MAX_RUNNING sets one. A provider waiting out a
    // rate or usage limit keeps its tasks queued until the limit lifts.
    const cap = maxRunning();
    let runningNow = [...runsRef.current.values()].filter((r) => r.status === "running").length;
    for (const t of queue) {
      if (cap !== null && runningNow >= cap) break;
      if (started >= limit) break;
      if (t.status !== "queued" || !t.assignee || taken.has(t.assignee)) continue;
      if (agentBusy(workspace, t.assignee)) continue;
      const provider = t.provider ?? findAgent(t.assignee, workspace)?.provider;
      if (provider && coolingDown(cooldowns, provider)) continue;
      const outcome = startRun(workspace, t.assignee, t.title, t.id);
      taken.add(t.assignee);
      if (outcome.ok) {
        started++;
        runningNow++;
      }
    }
    return started;
  };

  const doDispatch = () => {
    const n = dispatchOnce(activePath);
    refresh();
    refreshWorkspaces();
    if (n === 0) {
      const waiting = tasks.filter((t) => t.status === "queued").length;
      setFlash({
        text:
          waiting === 0
            ? "Nothing queued that can run. t adds a task; blocked ones say why."
            : "Every agent with queued work is already running. Cancel one or wait.",
        tone: "error",
      });
      return;
    }
    setFlash({ text: `Dispatched ${n} task${n === 1 ? "" : "s"}.`, tone: "ok" });
  };

  // Auto-dispatch: every workspace with waiting work gets a pass, on a
  // timer rather than on every render so a burst of ledger writes does not
  // become a burst of process spawns.
  const dispatchRef = useRef(dispatchOnce);
  dispatchRef.current = dispatchOnce;
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  useEffect(() => {
    if (!autoDispatch) return;
    const tick = () => {
      let started = 0;
      // Cheaper per verified outcome goes first and gets more of the slots.
      const cap = maxRunning();
      const live = [...runsRef.current.values()].filter((r) => r.status === "running").length;
      const waiting = workspacesRef.current.filter((ws) => ws.hasOrg && ws.waiting > 0).map((ws) => ws.path);
      for (const { path, slots } of dispatchPlan(waiting, cap === null ? null : Math.max(0, cap - live))) {
        started += dispatchRef.current(path, slots);
      }
      if (started > 0) {
        refresh();
        refreshWorkspaces();
      }
    };
    tick();
    const t = setInterval(tick, DISPATCH_MS);
    return () => clearInterval(t);
  }, [autoDispatch, refresh, refreshWorkspaces]);

  /**
   * Kill the process. Deliberately not phrased as "stopped": the tokens it
   * already burned are billed, the ledger keeps the delegation, and saying
   * otherwise would make cancelling look free.
   */
  const doCancel = (run: RunState) => {
    const outcome = cancelRun(run.workspace, run.agent);
    setFlash({ text: outcome.message, tone: "error" });
  };

  /**
   * Hire a whole company, then open the chat: the next useful thing after a
   * team exists is a sentence to the chief of staff.
   */
  const doHireCompany = (plan: CompanyPlan) => {
    setModal(null);
    let result;
    try {
      result = hireCompany(plan, activePath);
    } catch (e) {
      setFlash({ text: e instanceof Error ? e.message : String(e), tone: "error" });
      return;
    }
    refresh();
    refreshWorkspaces();
    const secs = (result.ms / 1000).toFixed(1);
    const bits = [`Hired the ${plan.template.title.toLowerCase()}: ${describeHire(result, plan)}, in ${secs}s.`];
    if (result.skipped.length > 0) bits.push(`Kept ${result.skipped.join(", ")}, already in the org.`);
    if (result.failed.length > 0) bits.push(`Not hired: ${result.failed.join("; ")}.`);
    if (result.chief) bits.push(`Tell ${result.chief} what to build.`);
    setFlash({ text: bits.join(" "), tone: result.failed.length > 0 ? "error" : "ok" });
    if (result.chief) setChatOpen(true);
  };

  const doHire = (values: {
    name: string;
    role: string;
    provider: Provider;
    model: string;
    budgetUsd: number;
    isolated: boolean;
    autonomy: AutonomyLevel;
    collaboration: string;
    guardrails: string[];
  }) => {
    const result = hireAgent(values, activePath);
    // A rejected hire wrote nothing, so the form stays up with what was typed
    // still in it. A partial one did change the org and must not be retried.
    if (result.ok || result.partial) setModal(null);
    report(result);
  };

  /**
   * Merge, and on conflict swap the dialog for the file list. Returns the
   * message on success so a caller that does something afterwards can say
   * both things on one line instead of overwriting the first with the second.
   */
  const doMerge = (name: string): string | null => {
    const result = mergeAgent(name, activePath);
    if (!result.ok) {
      setModal({
        kind: "conflicts",
        agent: name,
        conflicts: result.conflicts,
        error: result.message,
      });
      report({ ok: false, message: result.message });
      return null;
    }
    setModal(null);
    report(result);
    return result.message;
  };

  const doFire = (name: string, choice: FireChoice) => {
    if (choice === "cancel") {
      setModal(null);
      return;
    }

    let merged = "";
    if (choice === "merge-then-fire") {
      const message = doMerge(name);
      // A conflicted merge leaves the dialog on the conflict report and the
      // agent in the org. Firing anyway is available, but it has to be chosen.
      if (message === null) return;
      merged = `${message} `;
    }

    setModal(null);
    const result = fireAgent(name, "fired from the dashboard", activePath);
    report({ ok: result.ok, message: merged + result.message });
  };

  const doOpenShell = () => {
    const agent =
      focus === "queue"
        ? agents.find((a) => a.name === selectedTaskRow?.assignee) ?? null
        : focus === "roster"
          ? selectedAgent
          : null;
    report(openShellWindow({ workspaceName, agent, cwd: activePath }));
  };

  // -- chat ---------------------------------------------------------------

  const chief: AgentRecord | null = agents.find((a) => a.chief) ?? null;

  const openChat = () => {
    try {
      const { agent, hired } = ensureChief(activePath);
      if (hired) {
        setFlash({
          text: `Hired ${agent.name} as chief of staff on ${agent.provider} at ${agent.autonomy}. The chief's replies have no cap, and ${compactBudget(agent.budgetUsd)} is the allowance to give other agents.`,
          tone: "ok",
        });
        refresh();
        refreshWorkspaces();
      }
      setChatOpen(true);
    } catch (e) {
      setFlash({ text: e instanceof Error ? e.message : String(e), tone: "error" });
    }
  };

  const sendChat = (text: string): boolean => {
    const c = findChief(activePath);
    if (!c) {
      setFlash({ text: "The org has no chief of staff. Press C on the dashboard to hire one.", tone: "error" });
      return false;
    }
    const live = runs.get(runKey(activePath, c.name));
    if (live?.status === "running") {
      setFlash({ text: `${c.name} is still replying. Enter sends once the reply ends.`, tone: "error" });
      return false;
    }
    // Refusals that would leave no ledger entry are caught here, so the
    // message stays in the input with the reason under it.
    const blocked = (!process.env.CEO_SKIP_SETUP_CHECK && notReadyReason(c.provider)) || budgetCheck(c.name, activePath);
    if (blocked) {
      setFlash({ text: blocked, tone: "error" });
      return false;
    }
    const conv = conversation(c.name, activePath);
    const workspace = activePath;
    const outcome = startRun(workspace, c.name, text, null, {
      resumeSessionId: resumableSession(conv, c),
      prompt: chatPrompt(text, conv, c, workspace),
      via: "chat",
      onFinished: (result) => afterChiefReply(workspace, c.name, result),
    });
    if (!outcome.ok) {
      setFlash({ text: outcome.message, tone: "error" });
      return false;
    }
    refresh();
    return true;
  };

  // `ceo chat` lands here with the chat asked for. Hire the chief on the way
  // in, the same as pressing C, once there is an org to hire into.
  const openedChat = useRef(false);
  useEffect(() => {
    if (openedChat.current || initialView !== "chat" || !state.exists) return;
    openedChat.current = true;
    openChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.exists]);

  const chiefReplying = Boolean(chief && runs.get(runKey(activePath, chief.name))?.status === "running");

  const cycleChiefProvider = () => {
    if (!chief) return;
    if (chiefReplying) {
      setFlash({ text: `${chief.name} is replying. Switch the provider once the reply ends.`, tone: "error" });
      return;
    }
    const next = nextProvider(chief.provider);
    const r = setAgentProvider(chief.name, next, activePath);
    const moved = findAgent(chief.name, activePath);
    const carried = (state.chat?.turns.length ?? 0) > 0 ? " The next message carries the conversation over." : "";
    report(r.ok ? { ok: true, message: `${chief.name} now runs on ${next}${moved ? ` ${moved.model}` : ""}.${carried}` } : r);
  };

  const cycleChiefLevel = () => {
    if (!chief) return;
    const next = nextAutonomy(chief.autonomy);
    const r = setAgentAutonomy(chief.name, next, activePath);
    report(r.ok ? { ok: true, message: `${chief.name} is now at ${next}: the chief ${staffingFor(next).label}.` } : r);
  };

  const startNewConversation = () => {
    if (!chief) return;
    if (chiefReplying) {
      setFlash({ text: `${chief.name} is replying. Start a new conversation once the reply ends.`, tone: "error" });
      return;
    }
    try {
      newConversation(chief.name, activePath);
      report({ ok: true, message: "New conversation. The next message opens a fresh session." });
    } catch (e) {
      setFlash({ text: e instanceof Error ? e.message : String(e), tone: "error" });
    }
  };

  // -- docket and integrations ----------------------------------------------

  const docketAdd = (input: string, agent: string | null) => {
    setBusy(`adding ${input.length > 50 ? `${input.slice(0, 49)}…` : input}`);
    addContext(input, activePath, { agents: agent ? [agent] : [] })
      .then((it) => setFlash({ text: `${it.title} is in the docket, ${tokenLabel(it.chars)} tokens${agent ? `, given to ${agent}` : ""}.`, tone: "ok" }))
      .catch((e: unknown) => setFlash({ text: e instanceof Error ? e.message : String(e), tone: "error" }))
      .finally(() => {
        setBusy(null);
        refresh();
      });
  };

  const docketToggle = (it: ContextItem, agent: string) => {
    try {
      if (it.agents.includes(agent)) takeContext(it.id, agent, activePath);
      else giveContext(it.id, agent, activePath);
      refresh();
    } catch (e) {
      setFlash({ text: e instanceof Error ? e.message : String(e), tone: "error" });
    }
  };

  const docketAll = (it: ContextItem, give: boolean) => {
    for (const a of agents) {
      if (give) giveContext(it.id, a.name, activePath);
      else takeContext(it.id, a.name, activePath);
    }
    const t = it.title.replace(/[.\s]+$/, "");
    setFlash({ text: give ? `Every agent now holds ${t}.` : `Nobody holds ${t} now.`, tone: "ok" });
    refresh();
  };

  const docketRefresh = (it: ContextItem) => {
    setBusy(`refreshing ${it.title}`);
    refreshContext(it.id, activePath)
      .then((n) => setFlash({ text: `${n.title} refreshed, ${tokenLabel(n.chars)} tokens.`, tone: "ok" }))
      .catch((e: unknown) => setFlash({ text: e instanceof Error ? e.message : String(e), tone: "error" }))
      .finally(() => {
        setBusy(null);
        refresh();
      });
  };

  const openSkills = (agent: string | null) => {
    setSkills(null);
    setModal({ kind: "skills", agent });
    skillCatalog(activePath).then(setSkills).catch(() => setSkills([]));
  };

  const pickSkill = (skill: Skill, agent: string | null) => {
    setModal(null);
    try {
      if (skill.status === "pending") approveWorkflow(skill.name, activePath);
    } catch (e) {
      setFlash({ text: e instanceof Error ? e.message : String(e), tone: "error" });
      return;
    }
    docketAdd(`skill:${skill.name}`, agent);
  };

  const openIssues = (agent: string | null) => {
    setIssues({ list: null, error: null });
    setModal({ kind: "issues", agent });
    // gh is a subprocess: let the "reading" frame draw first.
    setTimeout(() => {
      try {
        setIssues({ list: listIssues(activePath, { limit: 50 }), error: null });
      } catch (e) {
        setIssues({ list: [], error: e instanceof Error ? e.message : String(e) });
      }
    }, 30);
  };

  const openIntegrations = () => {
    resetGithubStatus();
    setAlerts(readAlerts());
    setModal({ kind: "integrations" });
    hfStatus().then(setHf).catch(() => setHf({ token: false, account: null, endpoint: "" }));
    skillCatalog(activePath).then(setSkills).catch(() => setSkills([]));
    setTimeout(() => {
      try {
        if (githubStatus(activePath).repo) setIssues({ list: listIssues(activePath, { limit: 100 }), error: null });
      } catch {
        /* the card says what is missing */
      }
    }, 30);
  };

  const ringBell = () => process.stdout.write("\u0007");

  /** Decide which alert, if any, a settled run raises, and send it. */
  alertRef.current = (run: FinishedRun) => {
    const r = run.result;
    const where = run.workspace;
    const first = (s: string) => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
    const isChief = agents.some((a) => a.name === run.agent && a.chief) || findChief(where)?.name === run.agent;
    const out: Alert[] = [];
    if (r.ok) {
      if (isChief && !chatOpenRef.current) out.push({ kind: "chief", title: `${run.agent} replied`, body: first(r.text).slice(0, 180), workspace: where });
      else if (!isChief) out.push({ kind: "done", title: `${run.agent} finished`, body: `${run.task.slice(0, 120)} · $${r.costUsd.toFixed(4)}${r.costIsEstimate ? " est." : ""}`, workspace: where });
    } else if (r.rateLimit) {
      const lim = r.rateLimit;
      out.push({ kind: "limit", title: `${lim.provider} hit a limit`, body: `${run.agent}'s task is back in the queue until ${clock(lim.retryAt)}. ${lim.reason}`.slice(0, 220), workspace: where });
      // The task runs again when the limit lifts, with or without auto-dispatch.
      const wait = Math.max(1000, lim.retryAt - Date.now() + 1000);
      setTimeout(() => {
        if (dispatchRef.current(where) > 0) {
          refresh();
          refreshWorkspaces();
        }
      }, Math.min(wait, 2 ** 31 - 1));
    } else if (r.error && r.error !== "cancelled") {
      out.push({ kind: /budget/i.test(r.error) ? "budget" : "failed", title: /budget/i.test(r.error) ? `${run.agent} is at its budget` : `${run.agent} failed`, body: first(r.error).slice(0, 180), workspace: where });
    }
    if (r.denials.length > 0) out.push({ kind: "denied", title: `${run.agent} reached past its level`, body: r.denials.slice(0, 3).join(", "), workspace: where });
    if (run.taskId) {
      try {
        const queue = listTasks(where);
        const othersRunning = [...runsRef.current.values()].some((x) => x.workspace === where && x.status === "running" && x.agent !== run.agent);
        if (!othersRunning && !queue.some((t) => t.status === "queued" || t.status === "running")) {
          out.push({ kind: "queue", title: "The queue is empty", body: `Every task in ${where.split("/").pop()} has settled.`, workspace: where });
        }
      } catch {
        /* the queue is read again next time */
      }
    }
    for (const a of out) void sendAlert(a, { bell: ringBell });
  };

  const cycleFocus = (delta: number) => {
    const order: Focus[] = sidebarVisible ? ["sidebar", "roster", "queue"] : ["roster", "queue"];
    const i = order.indexOf(focus);
    setFocus(order[(Math.max(0, i) + delta + order.length) % order.length]);
  };

  // -- keys ---------------------------------------------------------------

  useInput((input, key) => {
    // Dialogs own the keyboard while they are open, including "q".
    if (modal) return;
    // So does the chat, where every printable key is part of a message.
    // ctrl-c still quits from anywhere.
    if (chatOpen && chief) {
      if (key.ctrl && input === "c") exit();
      return;
    }
    if (docketOpen) {
      if (key.ctrl && input === "c") exit();
      return;
    }
    if (skyOpen) {
      if (key.ctrl && input === "c") exit();
      else if (isEscape(input, key) || input === "O" || input === "q") setSkyOpen(false);
      else if (input === "L") {
        setSkyOpen(false);
        setLiveOpen(true);
      } else if (input === "C") {
        setSkyOpen(false);
        openChat();
      }
      return;
    }
    if (liveOpen) {
      if (key.ctrl && input === "c") exit();
      else if (isEscape(input, key) || input === "L" || input === "q") setLiveOpen(false);
      else if (input === "O") {
        setLiveOpen(false);
        setSkyOpen(true);
      } else if (input === "C") {
        setLiveOpen(false);
        openChat();
      }
      return;
    }

    // No org yet: create one, switch away, or leave. Handling this first keeps
    // every other binding from firing against a roster that does not exist.
    if (!state.exists) {
      if (input === "q" || (key.ctrl && input === "c")) {
        exit();
        return;
      }
      if (input === "n") {
        try {
          initLedger(activePath);
          registerWorkspace(activePath);
          refresh();
          refreshWorkspaces();
          setFlash({ text: `Org created in ${workspaceName}/.ceo. Pick a company, or esc for an empty org.`, tone: "ok" });
          setModal({ kind: "company" });
        } catch (e) {
          setFlash({ text: e instanceof Error ? e.message : String(e), tone: "error" });
        }
        return;
      }
      if (input === "w") {
        setModal({ kind: "workspaces" });
        return;
      }
      if (input === "]") cycleWorkspace(1);
      if (input === "[") cycleWorkspace(-1);
      return;
    }

    // Anything that is not another "q" stands the quit guard down again.
    if (input !== "q" && quitArmed) setQuitArmed(false);

    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    if (input === "q") {
      // Quitting kills the child processes, which leaves the delegations
      // open in the ledger. That is recoverable and honest, but it should not
      // happen by reflex on a key pressed to close a screen.
      if (activeRunsEverywhere.length > 0 && !quitArmed) {
        setQuitArmed(true);
        setFlash({
          text: `${activeRunsEverywhere.length} delegation${
            activeRunsEverywhere.length === 1 ? " is" : "s are"
          } still running. Press q again to quit anyway. The agents are killed, whatever they have spent is already real, and the ledger keeps them as unfinished. Detaching tmux with ctrl-b d keeps them running.`,
          tone: "error",
        });
        return;
      }
      exit();
      return;
    }
    if (input === "r") {
      refresh();
      refreshWorkspaces();
      setHint("Refreshed.");
      return;
    }
    if (input === "a") {
      setHint(AUDIT_HINT);
      return;
    }
    if (input === "S") {
      setModal({ kind: "setup" });
      return;
    }
    if (input === "C") {
      openChat();
      return;
    }
    if (input === "+") {
      setModal({ kind: "company" });
      return;
    }
    if (input === "L") {
      setLiveOpen(true);
      return;
    }
    if (input === "O") {
      setSkyOpen(true);
      return;
    }
    if (input === "D") {
      setDocketOpen(true);
      return;
    }
    if (input === "I") {
      openIntegrations();
      return;
    }
    if (input === "V") {
      setModal({ kind: "approvals" });
      return;
    }
    if (input === "P" && selectedAgent) {
      if (!selectedAgent.branch) {
        setFlash({ text: `${selectedAgent.name} has no branch. i gives ${selectedAgent.name} a worktree and a branch first.`, tone: "error" });
        return;
      }
      setModal({ kind: "pr", agent: selectedAgent.name });
      return;
    }
    if (input === "?") {
      setModal({ kind: "help" });
      return;
    }

    // Workspaces.
    if (input === "]") {
      cycleWorkspace(1);
      return;
    }
    if (input === "[") {
      cycleWorkspace(-1);
      return;
    }
    if (input === "w") {
      setModal({ kind: "workspaces" });
      return;
    }
    if (input === "W") {
      setSidebarPinned((p) => !p);
      return;
    }
    if (isTab(input, key)) {
      cycleFocus(key.shift ? -1 : 1);
      return;
    }

    // Queue.
    if (input === "t") {
      setModal({ kind: "task", task: null });
      return;
    }
    if (input === "e" && focus === "queue" && selectedTaskRow) {
      if (selectedTaskRow.status === "running") {
        setFlash({ text: `${selectedTaskRow.id} is running; edit it once it settles.`, tone: "error" });
        return;
      }
      setModal({ kind: "task", task: selectedTaskRow });
      return;
    }
    if (input === "x" && focus === "queue" && selectedTaskRow) {
      const t = selectedTaskRow;
      if (t.status === "running") {
        const live = t.assignee ? runs.get(runKey(activePath, t.assignee)) : null;
        if (live && live.status === "running") doCancel(live);
        else report(setQueueTaskStatus(t.id, "cancelled", "cancelled from the queue; its run was not in this dashboard", activePath));
        return;
      }
      if (t.status === "queued" || t.status === "blocked") {
        report(setQueueTaskStatus(t.id, "cancelled", null, activePath));
        return;
      }
      setFlash({ text: `${t.id} is already ${t.status}.`, tone: "error" });
      return;
    }
    if (input === "u" && focus === "queue" && selectedTaskRow) {
      const t = selectedTaskRow;
      if (t.status === "done" || t.status === "failed" || t.status === "cancelled") {
        report(setQueueTaskStatus(t.id, "queued", null, activePath));
      } else {
        setFlash({ text: `${t.id} is ${t.status}; only a settled task can be requeued.`, tone: "error" });
      }
      return;
    }
    if (input === "R") {
      doDispatch();
      return;
    }
    if (input === "A") {
      setAutoDispatch((on) => {
        setFlash({
          text: on
            ? "Auto-dispatch off. Queued tasks wait for enter or R."
            : "Auto-dispatch ON across every workspace: idle agents pick up queued tasks and spend money without a keystroke each. A again to stop.",
          tone: on ? "ok" : "error",
        });
        return !on;
      });
      return;
    }

    // Delegation and runs.
    if (input === "d") {
      if (agents.length === 0) {
        setFlash({ text: "Nobody to delegate to yet. Press h to hire an agent.", tone: "error" });
        return;
      }
      setModal({ kind: "delegate" });
      return;
    }
    if (input === "c" && focusedInView && focusedInView.status === "running") {
      doCancel(focusedInView);
      return;
    }
    if ((input === "n" || input === "N") && runList.length > 1 && focusedInView) {
      const i = runList.findIndex((r) => runKey(r.workspace, r.agent) === runKey(focusedInView.workspace, focusedInView.agent));
      const next = runList[(i + (input === "N" ? -1 : 1) + runList.length) % runList.length];
      setFocusedRun(runKey(next.workspace, next.agent));
      return;
    }
    if (input === "o") {
      doOpenShell();
      return;
    }

    // Roster mutations act on the selected agent whatever has focus.
    if (input === "h") {
      setModal({ kind: "hire", preset: null });
      return;
    }
    if (input === "p") {
      setModal({ kind: "suggest" });
      return;
    }
    if (input === "f" && selectedAgent) {
      openFire(selectedAgent);
      return;
    }
    if (input === "b" && selectedAgent) {
      openBudget(selectedAgent);
      return;
    }
    // Shift-M before lowercase m: m merges a branch, and M edits the org's objective.
    if (input === "M") {
      setModal({ kind: "mission" });
      return;
    }
    if (input === "m" && selectedAgent) {
      openMerge(selectedAgent);
      return;
    }
    if (input === "y" && selectedAgent) {
      cycleAutonomy(selectedAgent);
      return;
    }
    if (input === "i" && selectedAgent) {
      report(isolateAgent(selectedAgent.name, activePath));
      return;
    }
    // The provider is a setting on the agent, not a property of the role.
    if (input === "v" && selectedAgent) {
      report(setAgentProvider(selectedAgent.name, nextProvider(selectedAgent.provider), activePath));
      return;
    }

    // esc means "get me out of the most immediate thing". While a run is on
    // screen that is the run: cancel it if it is live, or clear it if it is
    // finished so the activity feed comes back.
    if (isEscape(input, key)) {
      if (detailOpen) {
        setDetailOpen(false);
        return;
      }
      if (focusedInView) {
        if (focusedInView.status === "running") {
          doCancel(focusedInView);
        } else {
          dismissRun(focusedInView.workspace, focusedInView.agent);
          setFocusedRun(null);
        }
        return;
      }
      return;
    }

    // Navigation within the focused panel.
    const up = key.upArrow || input === "k";
    const down = key.downArrow || input === "j";
    if (up || down) {
      const d = up ? -1 : 1;
      if (focus === "sidebar") cycleWorkspace(d);
      else if (focus === "queue") setSelectedTask((s) => clamp(s + d, 0, Math.max(0, tasks.length - 1)));
      else setSelected((s) => clamp(s + d, 0, Math.max(0, agents.length - 1)));
      return;
    }
    if (isReturn(input, key)) {
      if (focus === "queue" && selectedTaskRow) {
        const t = selectedTaskRow;
        if (t.status === "running" && t.assignee) {
          const key_ = runKey(activePath, t.assignee);
          if (runs.has(key_)) setFocusedRun(key_);
          else setFlash({ text: `${t.id} is running outside this dashboard (delegation ${t.delegationId ?? "?"}).`, tone: "error" });
          return;
        }
        runTask(t);
        return;
      }
      if (focus === "sidebar") {
        setFocus("roster");
        return;
      }
      if (agents.length > 0) setDetailOpen(true);
    }
  });

  // -- render -------------------------------------------------------------

  const width = Math.max(40, columns);
  const modalWidth = Math.min(width, MAX_MODAL_WIDTH);

  // A core error can run past one line, and truncating "role brief must be at
  // least..." to its first half helps nobody. On the dashboard the extra line
  // comes out of the panel row rather than off the bottom of the screen.
  const flashLines = flash ? wrap(flash.text, width, 2) : [];
  const flashBlock = flash ? (
    <Box flexDirection="column">
      {flashLines.map((line, i) => (
        <Text key={i} color={flash.tone === "error" ? "red" : "green"}>
          {line}
        </Text>
      ))}
    </Box>
  ) : null;

  function renderDialog() {
    if (!modal) return null;
    const agent =
      "agent" in modal ? agents.find((a) => a.name === modal.agent) ?? null : null;

    if (modal.kind === "workspaces") {
      return (
        <WorkspaceManager
          workspaces={workspaces}
          activePath={activePath}
          width={modalWidth}
          onOpen={(p) => {
            setModal(null);
            switchWorkspace(p);
          }}
          onAdd={(p) => {
            const r = registerWorkspace(p);
            refreshWorkspaces();
            if (r.ok && r.path) switchWorkspace(r.path);
            return r;
          }}
          onRemove={(p) => {
            const r = forgetWorkspace(p);
            refreshWorkspaces();
            return r;
          }}
          onClose={() => setModal(null)}
        />
      );
    }
    if (modal.kind === "hire") {
      return (
        <HireForm
          width={modalWidth}
          readiness={readiness}
          existingNames={agents.map((a) => a.name)}
          presets={hirePresets}
          initial={modal.preset ?? null}
          onSubmit={doHire}
          onCancel={() => setModal(null)}
        />
      );
    }
    if (modal.kind === "integrations") {
      return (
        <Integrations
          width={modalWidth}
          github={githubStatus(activePath)}
          hf={hf}
          alerts={alerts}
          reflex={reflex}
          skills={skills ? { ready: skills.filter((s) => s.status === "ready").length, pending: skills.filter((s) => s.status === "pending").length } : null}
          openIssues={issues.list ? issues.list.length : null}
          onIssues={() => openIssues(selectedAgent?.name ?? null)}
          onGithubLogin={() => {
            const r = openWindow({ name: "gh login", cwd: activePath, command: "gh auth login" });
            setFlash({ text: r.ok ? "Opened a tmux window running gh auth login. Sign in there, then press I again." : "No tmux window available: run gh auth login in another terminal, then press I again.", tone: "ok" });
          }}
          onAlerts={(change) => {
            try {
              setAlerts(writeAlerts(change));
            } catch (e) {
              setFlash({ text: e instanceof Error ? e.message : String(e), tone: "error" });
            }
          }}
          onTestAlert={() => {
            void sendAlert({ kind: "done", title: "CEO test alert", body: "Alerts from this org reach this channel.", workspace: activePath }, { force: true, bell: ringBell }).then((res) =>
              setFlash({
                text: res.length === 0 ? "Every channel is off. b turns the bell on." : res.map((x) => `${x.channel} ${x.ok ? x.detail : `failed: ${x.detail}`}`).join(" · "),
                tone: res.every((x) => x.ok) ? "ok" : "error",
              }),
            );
          }}
          onSkills={() => openSkills(selectedAgent?.name ?? null)}
          onClose={() => setModal(null)}
        />
      );
    }
    if (modal.kind === "issues") {
      const forAgent = modal.agent ?? selectedAgent?.name ?? null;
      return (
        <IssuePicker
          width={modalWidth}
          issues={issues.list}
          error={issues.error}
          agent={forAgent}
          onContext={(it) => {
            setModal(null);
            docketAdd(`#${it.number}`, forAgent);
          }}
          onTask={(it) => {
            setModal(null);
            if (!forAgent) {
              setFlash({ text: "Select an agent on the roster first.", tone: "error" });
              return;
            }
            try {
              const t = addTask({ title: `#${it.number} ${it.title}`, assignee: forAgent }, activePath);
              setFlash({ text: `Queued ${t.id} for ${forAgent}: #${it.number}. The issue is going into ${forAgent}'s docket.`, tone: "ok" });
              docketAdd(`#${it.number}`, forAgent);
            } catch (e) {
              setFlash({ text: e instanceof Error ? e.message : String(e), tone: "error" });
            }
          }}
          onChief={(it) => {
            setModal(null);
            try {
              const { agent } = ensureChief(activePath);
              docketAdd(`#${it.number}`, agent.name);
              setChatDraft(`Handle issue #${it.number}, ${it.title}. Pick who does what.`);
              setDocketOpen(false);
              setChatOpen(true);
            } catch (e) {
              setFlash({ text: e instanceof Error ? e.message : String(e), tone: "error" });
            }
          }}
          onClose={() => setModal(null)}
        />
      );
    }
    if (modal.kind === "skills") {
      return <SkillPicker width={modalWidth} skills={skills} agent={modal.agent} onPick={(s) => pickSkill(s, modal.agent)} onClose={() => setModal(null)} />;
    }
    if (modal.kind === "pr") {
      const a = agents.find((x) => x.name === modal.agent);
      const ends = readLedger(activePath).filter((e) => e.type === "delegate_end" && e.agent === modal.agent);
      return (
        <PrDialog
          width={modalWidth}
          agent={modal.agent}
          branch={a?.branch ?? `ceo/${modal.agent}`}
          base={baseBranch(activePath)}
          repo={githubStatus(activePath).repo}
          runs={ends.length}
          costUsd={ends.reduce((n, e) => n + (Number(e.data.costUsd ?? 0) || 0), 0)}
          onConfirm={() => {
            setModal(null);
            try {
              const url = openPullRequest(modal.agent, activePath, { base: baseBranch(activePath) });
              report({ ok: true, message: `Pull request for ${modal.agent}: ${url}` });
            } catch (e) {
              setFlash({ text: e instanceof Error ? e.message : String(e), tone: "error" });
            }
          }}
          onClose={() => setModal(null)}
        />
      );
    }
    if (modal.kind === "company") {
      return (
        <CompanyPicker
          cwd={activePath}
          width={modalWidth}
          onClose={() => setModal(null)}
          onHire={(plan) => doHireCompany(plan)}
        />
      );
    }
    if (modal.kind === "suggest") {
      return (
        <SuggestPanel
          proposal={proposal.root === proposalKey ? proposal.value : null}
          error={proposal.root === proposalKey ? proposal.error : null}
          reflex={reflex}
          scan={scan}
          onScan={runReflexScan}
          width={modalWidth}
          onHireOne={(seat) => setModal({ kind: "hire", preset: seatToPreset(seat) })}
          onHireAll={(seats) => {
            setModal(null);
            let hired = 0;
            const failed: string[] = [];
            for (const seat of seats) {
              const r = hireAgent(
                {
                  name: seat.name,
                  role: seat.role,
                  provider: seat.provider,
                  model: seat.model,
                  budgetUsd: seat.budgetUsd,
                  isolated: seat.isolated,
                  autonomy: seat.autonomy,
                  collaboration: seat.collaboration,
                  guardrails: seat.guardrails,
                },
                activePath,
              );
              if (r.ok || r.partial) hired++;
              else failed.push(`${seat.name}: ${r.message}`);
            }
            refresh();
            setFlash({
              text: failed.length === 0 ? `Hired ${hired} agents as proposed.` : `Hired ${hired}; ${failed.join("; ")}`,
              tone: failed.length === 0 ? "ok" : "error",
            });
          }}
          onClose={() => setModal(null)}
        />
      );
    }
    if (modal.kind === "delegate") {
      return (
        <DelegateForm
          agents={agents}
          running={runningNames}
          initialAgent={selectedAgent?.name ?? null}
          width={modalWidth}
          onSubmit={doDelegate}
          onCancel={() => setModal(null)}
        />
      );
    }
    if (modal.kind === "task") {
      const editing = modal.task;
      return (
        <TaskForm
          agents={agents}
          task={editing}
          initialAssignee={selectedAgent?.name ?? null}
          width={modalWidth}
          onSubmit={(values) => {
            const result = editing
              ? editQueueTask(editing.id, values, activePath)
              : addQueueTask(values, activePath);
            if (result.ok) {
              setModal(null);
              setFocus("queue");
            }
            report(result);
          }}
          onCancel={() => setModal(null)}
        />
      );
    }
    if (modal.kind === "mission") {
      return (
        <MissionForm
          mission={state.mission}
          agentCount={agents.length}
          width={modalWidth}
          onSubmit={(values) => {
            const result = saveMission(values, activePath);
            // A refused mission, say an objective too short, keeps the form up
            // with the text still in it, the same contract the hire form has.
            if (result.ok) setModal(null);
            report(result);
          }}
          onCancel={() => setModal(null)}
        />
      );
    }
    if (modal.kind === "approvals") {
      return <Approvals cwd={activePath} width={modalWidth} onReport={report} onClose={() => setModal(null)} />;
    }
    if (modal.kind === "help") {
      return <HelpOverlay width={modalWidth} onClose={() => setModal(null)} />;
    }
    if (modal.kind === "setup") {
      return (
        <SetupScreen
          readiness={readiness}
          width={modalWidth}
          onLogin={(provider) => {
            const cmd = loginCommand(provider);
            const r = openWindow({ name: `${provider} login`, cwd: activePath, command: cmd });
            return r.ok
              ? `Opened a tmux window running \`${cmd}\`. Sign in there, come back, press r.`
              : `No tmux window available: run \`${cmd}\` in another terminal, then press r.`;
          }}
          onRecheck={recheckReadiness}
          onClose={() => setModal(null)}
        />
      );
    }
    if (modal.kind === "conflicts") {
      return (
        <ConflictReport
          agentName={modal.agent}
          conflicts={modal.conflicts}
          error={modal.error}
          width={modalWidth}
          onClose={() => setModal(null)}
        />
      );
    }
    if (agent && modal.kind === "budget") {
      return (
        <BudgetForm
          agent={agent}
          width={modalWidth}
          onSubmit={(usd) => {
            setModal(null);
            const r = setAgentBudget(agent.name, usd, activePath);
            report(agent.chief && r.ok ? { ok: true, message: `${agent.name} may now give other agents $${usd} in budgets. The chief's own replies stay uncapped.` } : r);
          }}
          onCancel={() => setModal(null)}
        />
      );
    }
    if (agent && modal.kind === "fire") {
      return (
        <FireDialog
          agent={agent}
          unmerged={modal.unmerged}
          base={modal.base}
          width={modalWidth}
          onChoose={(choice) => doFire(agent.name, choice)}
        />
      );
    }
    if (agent && modal.kind === "merge") {
      return (
        <MergeDialog
          agent={agent}
          unmerged={modal.unmerged}
          base={modal.base}
          width={modalWidth}
          onConfirm={() => doMerge(agent.name)}
          onCancel={() => setModal(null)}
        />
      );
    }
    return null;
  }

  // Dialogs replace the screen rather than float over it: ink has no z-axis.
  // A dashboard rendered behind a dialog it is not accepting keys for would
  // look live when it is not. The flash still rides underneath. A rejected
  // hire keeps its form open, and the reason it was rejected has to be on the
  // same screen as the field that needs fixing.
  // A dialog is drawn at the same height as every other screen, so the
  // switch from the dashboard rewrites every row and leaves nothing stale.
  const dialog = renderDialog();
  if (dialog) {
    return (
      <Box flexDirection="column" height={Math.max(10, rows)}>
        {dialog}
        {flashBlock}
      </Box>
    );
  }

  // No org here yet. Offer to make one rather than sending the user
  // somewhere else: the dashboard can create an org perfectly well on its
  // own. With other workspaces registered, `[` and `]` go to them.
  if (!state.exists) {
    return (
      <Box flexDirection="column" padding={1} height={Math.max(10, rows)}>
        <Text bold>{`No org in ${workspaceName} yet.`}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{tilde(projectRoot(activePath))}</Text>
          <Text> </Text>
          <Text>
            <Text color="green">n</Text>
            <Text dimColor> start an org here, then pick a company: a whole team in one keystroke</Text>
          </Text>
          {workspaces.length > 1 ? (
            <Text>
              <Text color="green">[ ]</Text>
              <Text dimColor> other workspaces</Text>
            </Text>
          ) : null}
          <Text>
            <Text color="green">w</Text>
            <Text dimColor> manage workspaces</Text>
          </Text>
          <Text>
            <Text color="green">q</Text>
            <Text dimColor> quit</Text>
          </Text>
        </Box>
        {flash ? (
          <Box marginTop={1}>
            <Text color={flash.tone === "error" ? "red" : "green"}>{flash.text}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  const broken = state.verifyResult && !state.verifyResult.ok;

  if (docketOpen && !chatOpen) {
    return (
      <Box flexDirection="column">
        {broken ? <BrokenChainBanner state={state} width={width} /> : null}
        <Docket
          workspaceName={workspaceName}
          cwd={activePath}
          items={docketItems}
          agents={agents}
          textOf={textOf}
          busy={busy}
          flash={flash}
          width={width}
          height={rows - (broken ? 2 : 0)}
          onToggle={docketToggle}
          onAll={docketAll}
          onAdd={docketAdd}
          onRemove={(it) => {
            try {
              removeContext(it.id, activePath);
              setFlash({ text: `${it.title} is out of the docket. Agents that held it no longer receive it.`, tone: "ok" });
              refresh();
            } catch (e) {
              setFlash({ text: e instanceof Error ? e.message : String(e), tone: "error" });
            }
          }}
          onRefresh={docketRefresh}
          onSkills={openSkills}
          onIssues={openIssues}
          onClose={() => setDocketOpen(false)}
          cursor={docketCursor.current}
          onCursor={onDocketCursor}
        />
      </Box>
    );
  }

  if (skyOpen && !chatOpen) {
    return (
      <Box flexDirection="column">
        {broken ? <BrokenChainBanner state={state} width={width} /> : null}
        <Sky
          workspaceName={workspaceName}
          agents={agents}
          runs={runList}
          messages={state.messages}
          tasks={tasks}
          flash={flash}
          width={width}
          height={rows - (broken ? 2 : 0)}
          onOpen={(name) => {
            const i = agents.findIndex((a) => a.name === name);
            if (i < 0) return;
            setSkyOpen(false);
            setFocus("roster");
            setSelected(i);
            setDetailOpen(true);
          }}
        />
      </Box>
    );
  }

  if (liveOpen && !chatOpen) {
    return (
      <Box flexDirection="column">
        {broken ? <BrokenChainBanner state={state} width={width} /> : null}
        <LiveBoard
          workspaceName={workspaceName}
          agents={agents}
          runs={runList}
          messages={state.messages}
          tasks={tasks}
          flash={flash}
          width={width}
          height={rows - (broken ? 2 : 0)}
          now={now}
          spinner={spinnerFrame(now)}
        />
      </Box>
    );
  }

  if (chatOpen && chief) {
    return (
      <Box flexDirection="column">
        {broken ? <BrokenChainBanner state={state} width={width} /> : null}
        <Chat
          chief={chief}
          conv={state.chat}
          allowance={state.allowance}
          agents={agents}
          tasks={tasks}
          live={runs.get(runKey(activePath, chief.name)) ?? null}
          running={runningNames}
          readiness={readiness}
          initialDraft={chatDraft}
          onDraft={setChatDraft}
          flash={flash}
          width={width}
          height={rows - (broken ? 2 : 0)}
          now={now}
          spinner={spinnerFrame(now)}
          onSend={sendChat}
          onClose={() => setChatOpen(false)}
          onNew={startNewConversation}
          onCycleProvider={cycleChiefProvider}
          onCycleLevel={cycleChiefLevel}
        />
      </Box>
    );
  }

  if (detailOpen && agents[selected]) {
    return (
      <Box flexDirection="column">
        {broken ? <BrokenChainBanner state={state} width={width} /> : null}
        <AgentDetail
          agent={agents[selected]}
          delegations={state.delegations}
          mission={state.mission}
          cwd={activePath}
          width={width}
          height={rows - (broken ? 2 : 0)}
        />
      </Box>
    );
  }

  // Height budget, top down: banner, an optional hint line, the status bar
  // or flash. The main block absorbs what is left, and inside it the right
  // column stacks the mission strip, the roster+queue row, the run/activity
  // row, and the audit strip.
  const chrome = (broken ? 2 : 0) + (hint ? 1 : 0) + Math.max(1, flashLines.length);
  const mainHeight = Math.max(12, rows - chrome);

  const findingLines = Math.min(2, state.audits[0]?.findings.length ?? 0);
  const auditContent = 1 + findingLines + (state.audits[0]?.reportPresent === false ? 1 : 0);
  const auditBoxHeight = auditContent + 2;

  const missionSpare = mainHeight - auditBoxHeight - 14;
  const checkLine = state.missionChecks.length > 0 ? 1 : 0;
  const missionBodyLines = state.mission
    ? clamp(missionSpare, 0, Math.min(2 + checkLine, state.mission.successCriteria.length + 1 + checkLine))
    : 0;
  const missionBoxHeight = 1 + missionBodyLines + 2;

  const stackHeight = Math.max(10, mainHeight - missionBoxHeight - auditBoxHeight);
  // The top row, who and what, gets a bit under half. The run pane needs
  // the rest because streamed output is the thing that scrolls.
  const topBoxHeight = clamp(Math.floor(stackHeight * 0.45), 5, Math.max(5, stackHeight - 5));
  const bottomBoxHeight = stackHeight - topBoxHeight;

  const sidebarWidth = sidebarVisible ? clamp(Math.floor(width * 0.2), 22, 34) : 0;
  const rightWidth = width - sidebarWidth;
  const rosterWidth = clamp(Math.floor(rightWidth * 0.5), 30, 60);
  const queueWidth = rightWidth - rosterWidth;

  const spinner = spinnerFrame(now);
  const frameColor = (panel: Focus) => (focus === panel ? "cyan" : broken ? "red" : "gray");

  return (
    <Box flexDirection="column" width={width}>
      {broken ? <BrokenChainBanner state={state} width={width} /> : null}

      <Box height={mainHeight}>
        {sidebarVisible ? (
          <Box
            width={sidebarWidth}
            height={mainHeight}
            borderStyle="round"
            borderColor={frameColor("sidebar")}
            paddingX={1}
            flexDirection="column"
          >
            <Text bold>{fit(`Workspaces (${workspaces.length})`, sidebarWidth - 4)}</Text>
            <Sidebar
              workspaces={workspaces}
              activePath={activePath}
              running={runningPerWorkspace}
              width={sidebarWidth - 4}
              height={mainHeight - 3}
              focused={focus === "sidebar"}
              spinner={spinner}
            />
          </Box>
        ) : null}

        <Box width={rightWidth} flexDirection="column">
          {/* The work first, then the people doing it. */}
          <MissionPanel mission={state.mission} checks={state.missionChecks} width={rightWidth} bodyLines={missionBodyLines} />

          <Box height={topBoxHeight}>
            <Box
              width={rosterWidth}
              borderStyle="round"
              borderColor={frameColor("roster")}
              paddingX={1}
              flexDirection="column"
            >
              <Text bold color="cyan">{fit(`Roster · ${workspaceName} · ${agents.length}`, rosterWidth - 4)}</Text>
              <Roster
                agents={agents}
                selected={selected}
                width={rosterWidth - 4}
                height={topBoxHeight - 3}
                running={runningNames}
                spinner={spinner}
              />
            </Box>

            <Box
              width={queueWidth}
              borderStyle="round"
              borderColor={frameColor("queue")}
              paddingX={1}
              flexDirection="column"
            >
              <Text bold color="cyan">
                {fit(
                  `Queue${queueLabel(tasks)}${autoDispatch ? " · AUTO" : ""}`,
                  queueWidth - 4,
                )}
              </Text>
              <Queue
                tasks={tasks}
                selected={selectedTask}
                width={queueWidth - 4}
                height={topBoxHeight - 3}
                focused={focus === "queue"}
                spinner={spinner}
              />
            </Box>
          </Box>

          {/* The run pane takes the activity feed's place while there is a run
              to show. The feed is a record of what already happened. Its newest
              row for a live delegation says "running" and nothing else. esc
              puts it back. */}
          <Box
            height={bottomBoxHeight}
            width={rightWidth}
            borderStyle="round"
            borderColor={focusedInView && focusedInView.denials.length > 0 ? "red" : "gray"}
            paddingX={1}
            flexDirection="column"
          >
            {focusedInView ? (
              <>
                <Text bold color="cyan">
                  {fit(runList.length > 1 ? `Runs (${runList.length})` : "Run", rightWidth - 4)}
                </Text>
                <RunPane
                  runs={runList}
                  focused={focusedInView}
                  width={rightWidth - 4}
                  height={bottomBoxHeight - 3}
                  now={now}
                />
              </>
            ) : (
              <>
                <Text bold color="cyan">{fit("Activity", rightWidth - 4)}</Text>
                <Activity
                  delegations={state.delegations}
                  messages={state.messages}
                  width={rightWidth - 4}
                  height={bottomBoxHeight - 3}
                />
              </>
            )}
          </Box>

          <Box
            width={rightWidth}
            height={auditBoxHeight}
            borderStyle="round"
            borderColor="gray"
            paddingX={1}
            flexDirection="column"
          >
            <AuditPanel audits={state.audits} width={rightWidth - 4} maxFindings={findingLines} />
          </Box>
        </Box>
      </Box>

      {state.error ? (
        <Text color="red">{fit(`Could not read .ceo/: ${state.error}`, width)}</Text>
      ) : null}

      {hint ? <Text color="yellow">{fit(hint, width)}</Text> : null}

      {/* The result of the last mutation takes the status bar's line for a
          few seconds, then the bar comes back. */}
      {flashBlock ?? (
        <StatusBar
          agentCount={agents.length}
          spendTodayUsd={state.rollup?.totalUsd ?? 0}
          spendEverywhereUsd={workspaces.reduce((n, w) => n + w.spendTodayUsd, 0)}
          workspaceCount={workspaces.length}
          delegationsToday={state.rollup?.delegationCount ?? 0}
          running={activeRunsEverywhere.length}
          dangling={Math.max(0, state.dangling - activeRuns.length)}
          queued={tasks.filter((t) => t.status === "queued").length}
          blocked={tasks.filter((t) => t.status === "blocked").length}
          autoDispatch={autoDispatch}
          outcome={activeWorkspace && activeWorkspace.attempts > 0 ? { verified: activeWorkspace.verified, usdPerVerified: activeWorkspace.usdPerVerified } : null}
          approvals={approvalsWaiting}
          focus={focus}
          width={width}
        />
      )}
    </Box>
  );
}

/** " · 2 running · 3 queued · 1 blocked", or "" for an empty queue. */
function queueLabel(tasks: Task[]): string {
  const running = tasks.filter((t) => t.status === "running").length;
  const queued = tasks.filter((t) => t.status === "queued").length;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  const bits: string[] = [];
  if (running > 0) bits.push(`${running} running`);
  if (queued > 0) bits.push(`${queued} queued`);
  if (blocked > 0) bits.push(`${blocked} blocked`);
  return bits.length > 0 ? ` · ${bits.join(" · ")}` : "";
}

/**
 * A broken hash chain means the ledger was edited, truncated, or forked by a
 * second writer. Every dollar figure and every provenance claim downstream of
 * that point is unproven. So this takes the top of the screen in inverse red
 * and stays there until the chain verifies again.
 */
function BrokenChainBanner({
  state,
  width,
}: {
  state: ReturnType<typeof useOrgState>;
  width: number;
}) {
  const v = state.verifyResult;
  const at = v?.brokenAtSeq ?? "?";
  const spend = usdExact(state.rollup?.totalUsd ?? 0);
  return (
    <Box flexDirection="column" width={width}>
      <Text backgroundColor="red" color="white" bold>
        {`  ${fit(
          `LEDGER CHAIN BROKEN AT SEQ ${at}. Accounting past this point is unproven, ${spend} today`,
          width - 2,
        )}`}
      </Text>
      <Text backgroundColor="red" color="white">
        {`  ${fit(v?.reason ?? "verify() reported a break with no reason.", width - 2)}`}
      </Text>
    </Box>
  );
}

export default App;
