/**
 * The engine: everything the app does, with no window attached. It runs in a
 * process of its own, because the core's git and ledger calls block.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import * as path from "node:path";

import "../../../src/core/evidence";
import { append, initLedger, readLedger, verify as verifyLedger } from "../../../src/core/ledger";
import { orgExists } from "../../../src/core/paths";
import { fire, findAgent, hire, readRoster, setBudget as coreSetBudget } from "../../../src/core/roster";
import { providerFor } from "../../../src/core/providers";
import { runDelegation, type RunEvent, type RunHandle, type RunResult } from "../../../src/core/runner";
import { allReadiness, resetReadiness } from "../../../src/core/setup";
import { provisionWorktree, teardownWorktree, mergeAgentBranch } from "../../../src/core/git";
import { addWorkspace, ceoHome, listWorkspaces, removeWorkspace } from "../../../src/core/workspaces";
import { ghBinary, provenanceBody, listIssues, readThread } from "../../../src/core/github";
import { verifyAll, parseVerifier } from "../../../src/core/verify";
import { routerTable, taskKind } from "../../../src/core/router";

import type {
  ChatAttachment, ChatItem, ChatTab, CheckRun, ChecksReport, DiffResult, EngineEvent, GitSummary, Insights, LicenseState, LineComment, ListItem,
  Method, Mode, NewWorkspace, ParamsOf, PlanDraft, PlannedTask, Project, ProjectConfig, Provider, PullRequest, Race, Readiness, RecordEntry,
  ResultOf, ReviewNote, ScriptKind, ScriptState, Settings, Snapshot, SpendReport, Workspace,
} from "../shared/api";
import { PROVIDERS } from "../shared/api";
import * as G from "./gitops";
import { decideNext } from "./decide";
import { licenseState } from "./license";
import { pickName } from "./names";

export type Handlers = { [M in Method]: (p: ParamsOf<M>) => ResultOf<M> | Promise<ResultOf<M>> };

const DEFAULT_CONFIG: ProjectConfig = { setup: "", run: "", archive: "", check: "", copy: [".env", ".env.local"], instructions: "", baseBranch: "" };
const DEFAULT_SETTINGS: Settings = {
  theme: "system", sound: true, notifications: true, defaultProvider: "claude", defaultModels: {}, defaultBudgetUsd: 25, teamNotes: true, editor: "", onboarded: false,
};
const EMPTY_GIT: GitSummary = { added: 0, removed: 0, files: 0, ahead: 0, behind: 0, dirty: false, conflicts: [] };
const LABEL: Record<Provider, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
const ROLE = "Software engineer working on one task in an isolated git worktree. Reads the code first, makes a complete and reviewable change, runs the project's tests, and reports what changed.";
const LOG_LIMIT = 256 * 1024;
const LOCAL_EXCLUDES = [".ceo/", ".context/", ".agents/mcp_config.json"];

type Stored = Omit<Workspace, "activity" | "runningTabs" | "queued" | "git" | "spentUsd" | "scripts"> & {
  wipCommit?: string | null;
  sessionProviders?: Record<string, Provider>;
  lastGit?: GitSummary;
  unread?: boolean;
};
type Live = { handle: RunHandle; assistantId: string | null; assistantText: string; startedAt: number };
type QueueEntry = { text: string; attachments: ChatAttachment[] };
type ScriptRun = { child: ChildProcess | null; log: string; code: number | null; url: string | null; running: boolean };
type Term = { id: string; pty: { write(d: string): void; resize(c: number, r: number): void; kill(): void; onData(cb: (d: string) => void): void; onExit(cb: (e: { exitCode: number }) => void): void }; backlog: string };

function atomicWrite(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
const uid = (): string => randomBytes(5).toString("hex");
const projectIdOf = (p: string): string => createHash("sha1").update(p).digest("hex").slice(0, 10);

export function createEngine(emit: (e: EngineEvent) => void): { handlers: Handlers; dispose: () => void } {
  const projects = new Map<string, Project>();
  const stored = new Map<string, Stored>();
  const races = new Map<string, Race>();
  const live = new Map<string, Live>(); // `${workspace}:${tab}`
  const queues = new Map<string, QueueEntry[]>();
  const scripts = new Map<string, ScriptRun>(); // `${workspace}:${kind}`
  const terms = new Map<string, Term>();
  const gitCache = new Map<string, GitSummary>();
  const prCheckedAt = new Map<string, number>();
  let snapshotTimer: NodeJS.Timeout | null = null;
  let disposed = false;

  const home = (): string => path.join(ceoHome(), "app");
  const settingsFile = (): string => path.join(home(), "settings.json");
  const licenseFile = (): string => path.join(home(), "license.json");
  const appDir = (root: string): string => path.join(root, ".ceo", "app");
  const wsFile = (root: string): string => path.join(appDir(root), "workspaces.json");
  const raceFile = (root: string): string => path.join(appDir(root), "races.json");
  const configFile = (root: string): string => path.join(appDir(root), "project.json");
  const chatFile = (root: string, slug: string, tab: string): string => path.join(appDir(root), "chat", slug, `${tab}.jsonl`);

  let settings: Settings = { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(settingsFile(), {}) };

  function licenseRecord(): { key: string | null; firstRunAt: number } {
    const rec = readJson<{ key?: string | null; firstRunAt?: number }>(licenseFile(), {});
    if (!rec.firstRunAt) {
      const fresh = { key: rec.key ?? null, firstRunAt: Date.now() };
      atomicWrite(licenseFile(), JSON.stringify(fresh));
      return fresh;
    }
    return { key: rec.key ?? null, firstRunAt: rec.firstRunAt };
  }
  const license = (): LicenseState => licenseState(licenseRecord());

  // -- projects ------------------------------------------------------------

  async function loadProject(p: string, name: string): Promise<Project> {
    const isGit = await G.isRepo(p);
    const hasCommits = isGit && (await G.hasHead(p));
    const config: ProjectConfig = { ...DEFAULT_CONFIG, ...readJson<Partial<ProjectConfig>>(configFile(p), {}) };
    const project: Project = {
      id: projectIdOf(p), path: p, name, isGit, hasCommits,
      baseRef: hasCommits ? await G.defaultBase(p, config.baseBranch) : "HEAD",
      hasRemote: isGit && (await G.hasOrigin(p)),
      config,
    };
    projects.set(project.id, project);
    for (const s of readJson<Stored[]>(wsFile(p), [])) {
      if (stored.has(s.id)) continue;
      // A run cannot survive the app closing. A worktree in the middle of setup is ready enough to use.
      stored.set(s.id, { ...s, status: s.status === "creating" || s.status === "setup" ? "ready" : s.status });
      if (s.lastGit) gitCache.set(s.id, s.lastGit);
    }
    for (const r of readJson<Race[]>(raceFile(p), [])) races.set(r.id, r);
    return project;
  }

  function persist(root: string): void {
    const projectId = projectIdOf(root);
    const list = [...stored.values()].filter((s) => s.projectId === projectId).map((s) => ({ ...s, lastGit: gitCache.get(s.id) ?? EMPTY_GIT }));
    atomicWrite(wsFile(root), JSON.stringify(list, null, 1));
    atomicWrite(raceFile(root), JSON.stringify([...races.values()].filter((r) => r.projectId === projectId), null, 1));
  }

  function project(id: string): Project {
    const p = projects.get(id);
    if (!p) throw new Error("That project is not open.");
    return p;
  }
  function ws(id: string): Stored {
    const s = stored.get(id);
    if (!s) throw new Error("That workspace no longer exists.");
    return s;
  }
  const rootOf = (s: Stored): string => project(s.projectId).path;
  const save = (s: Stored): void => {
    s.updatedAt = Date.now();
    persist(rootOf(s));
    pushSnapshot();
  };

  function view(s: Stored): Workspace {
    const running = [...live.keys()].filter((k) => k.startsWith(`${s.id}:`)).map((k) => k.slice(s.id.length + 1));
    const queued = [...queues.entries()].filter(([k]) => k.startsWith(`${s.id}:`)).reduce((n, [, q]) => n + q.length, 0);
    const p = projects.get(s.projectId);
    const agent = p && s.status !== "creating" ? safeAgent(s.slug, p.path) : null;
    const { wipCommit: _w, sessionProviders: _sp, lastGit: _lg, unread, ...rest } = s;
    void _w; void _sp; void _lg;
    return {
      ...rest,
      git: gitCache.get(s.id) ?? EMPTY_GIT,
      spentUsd: agent?.spentUsd ?? 0,
      budgetUsd: agent?.budgetUsd ?? s.budgetUsd,
      runningTabs: running,
      queued,
      activity: running.length > 0 ? "running" : queued > 0 ? "queued" : s.status === "failed" ? "error" : unread ? "unread" : "idle",
      scripts: {
        run: !!scripts.get(`${s.id}:run`)?.running,
        setup: !!scripts.get(`${s.id}:setup`)?.running,
        archive: !!scripts.get(`${s.id}:archive`)?.running,
        check: !!scripts.get(`${s.id}:check`)?.running,
      },
    };
  }
  function safeAgent(slug: string, root: string): ReturnType<typeof findAgent> {
    try {
      return findAgent(slug, root);
    } catch {
      return null;
    }
  }

  function snapshot(): Snapshot {
    return {
      projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)),
      workspaces: [...stored.values()].sort((a, b) => b.createdAt - a.createdAt).map(view),
      races: [...races.values()].sort((a, b) => b.createdAt - a.createdAt),
    };
  }
  function pushSnapshot(): void {
    if (snapshotTimer || disposed) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      if (!disposed) emit({ type: "snapshot", snapshot: snapshot() });
    }, 60);
  }

  async function refreshGit(s: Stored): Promise<void> {
    if (s.status === "archived" || s.status === "creating" || !existsSync(s.worktree)) return;
    const next = await G.summary(s.worktree, s.baseRef);
    const prev = gitCache.get(s.id);
    gitCache.set(s.id, next);
    if (JSON.stringify(prev) !== JSON.stringify(next)) pushSnapshot();
  }

  // -- creating workspaces -------------------------------------------------

  function nextPort(): number {
    const used = new Set([...stored.values()].map((s) => s.port));
    let p = 41000;
    while (used.has(p)) p += 10;
    return p;
  }

  function checkActiveLimit(extra = 1): void {
    const limit = license().limits.activeWorkspaces;
    if (limit === null) return;
    const active = [...stored.values()].filter((s) => s.status !== "archived").length;
    if (active + extra > limit) throw new Error(`The free plan holds ${limit} active workspaces. Archive one, or upgrade to Pro for no limit.`);
  }

  function ensureOrg(root: string): void {
    if (!orgExists(root) || readLedgerSafe(root).length === 0) initLedger(root);
    G.excludeLocal(root, LOCAL_EXCLUDES);
    mkdirSync(appDir(root), { recursive: true });
  }
  function readLedgerSafe(root: string): ReturnType<typeof readLedger> {
    try {
      return readLedger(root);
    } catch {
      return [];
    }
  }

  function takenNames(root: string): Set<string> {
    const taken = new Set<string>();
    for (const s of stored.values()) taken.add(s.slug);
    try {
      for (const a of readRoster(root).agents) taken.add(a.name);
    } catch {
      /* no org yet */
    }
    return taken;
  }

  async function createWorkspace(input: NewWorkspace, opts: { raceId?: string | null; skipLimit?: boolean } = {}): Promise<Workspace> {
    if (!opts.skipLimit) checkActiveLimit();
    const p = project(input.projectId);
    if (!p.isGit || !p.hasCommits) throw new Error("A workspace needs a git repository with a first commit.");
    ensureOrg(p.path);
    let slug = pickName(takenNames(p.path));
    while ((await G.git(["show-ref", "--verify", "--quiet", `refs/heads/ceo/${slug}`], p.path)).ok) {
      slug = pickName(new Set([...takenNames(p.path), slug]));
    }
    const tab: ChatTab = { id: uid(), title: "Chat", provider: input.provider, model: input.model, mode: input.mode, sessionId: null };
    const s: Stored = {
      id: `${p.id}-${slug}`, projectId: p.id, slug,
      title: input.title.trim() || slug,
      branch: `ceo/${slug}`, baseRef: p.baseRef, pushRef: null,
      worktree: path.join(p.path, ".ceo", "worktrees", slug),
      status: "creating", statusDetail: "Creating the worktree", port: nextPort(),
      createdAt: Date.now(), updatedAt: Date.now(), archivedAt: null, mergedAt: null,
      raceId: opts.raceId ?? null,
      budgetUsd: input.budgetUsd ?? settings.defaultBudgetUsd,
      tabs: [tab], todos: [], comments: [], viewed: {}, pr: null, checkResult: null,
      sessionProviders: {},
    };
    stored.set(s.id, s);
    pushSnapshot();
    void provision(s, p, input);
    return view(s);
  }

  async function provision(s: Stored, p: Project, input: NewWorkspace): Promise<void> {
    let firstPrompt = input.prompt?.trim() ?? "";
    try {
      if (p.hasRemote) await G.git(["fetch", "origin", "--prune"], p.path, { timeout: 20000 });
      let startPoint = p.baseRef;
      const start = input.start;
      if (start.kind === "branch") {
        startPoint = start.ref;
        s.pushRef = start.ref.replace(/^origin\//, "");
      } else if (start.kind === "pr") {
        const fetched = await G.git(["fetch", "origin", `pull/${start.number}/head`], p.path, { timeout: 30000 });
        if (!fetched.ok) throw new Error(`Could not fetch pull request ${start.number}: ${fetched.stderr.trim()}`);
        startPoint = "FETCH_HEAD";
        const meta = await G.run(ghBinary(), ["pr", "view", String(start.number), "--json", "headRefName,title,body"], p.path);
        if (meta.ok) {
          const m = JSON.parse(meta.stdout) as { headRefName?: string; title?: string };
          s.pushRef = m.headRefName ?? null;
          if (m.title && s.title === s.slug) s.title = m.title;
        }
      } else if (start.kind === "issue") {
        try {
          const t = readThread("issue", start.number, p.path);
          if (s.title === s.slug) s.title = t.title;
          firstPrompt = [firstPrompt, `Work on GitHub issue #${start.number}: ${t.title}`, t.text].filter(Boolean).join("\n\n");
        } catch (e) {
          throw new Error(`Could not read issue ${start.number}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const made = await G.git(["branch", s.branch, startPoint], p.path);
      if (!made.ok) throw new Error(`Could not create the branch: ${made.stderr.trim()}`);
      const instructions = p.config.instructions.trim();
      hire(
        {
          name: s.slug, role: instructions ? `${ROLE}\n\nProject guidance:\n${instructions}` : ROLE,
          provider: input.provider, model: input.model, isolated: true, budgetUsd: s.budgetUsd, autonomy: "execute",
        },
        p.path,
      );
      mkdirSync(path.join(s.worktree, ".context"), { recursive: true });
      for (const f of p.config.copy) {
        const clean = f.trim();
        if (!clean || clean.includes("..") || path.isAbsolute(clean)) continue;
        const from = path.join(p.path, clean);
        if (existsSync(from) && statSync(from).isFile()) {
          mkdirSync(path.dirname(path.join(s.worktree, clean)), { recursive: true });
          copyFileSync(from, path.join(s.worktree, clean));
        }
      }
      await refreshGit(s);
      if (p.config.setup.trim()) {
        s.status = "setup";
        s.statusDetail = "Running the setup script";
        save(s);
        const code = await startScript(s, "setup", p.config.setup);
        if (code !== 0) {
          s.status = "ready";
          s.statusDetail = `Setup script exited with ${code}`;
          emit({ type: "notify", title: `${s.title}: setup failed`, body: `The setup script exited with ${code}.`, workspaceId: s.id, level: "failed", sound: settings.sound });
        } else {
          s.statusDetail = null;
        }
      } else {
        s.statusDetail = null;
      }
      s.status = "ready";
      save(s);
      if (firstPrompt) send(s.id, s.tabs[0]!.id, firstPrompt, []);
      else drainAll(s);
    } catch (e) {
      s.status = "failed";
      s.statusDetail = e instanceof Error ? e.message : String(e);
      save(s);
      emit({ type: "notify", title: `${s.title}: could not start`, body: s.statusDetail, workspaceId: s.id, level: "failed", sound: settings.sound });
      settleRace(s.raceId);
    }
  }

  // -- chat ----------------------------------------------------------------

  function appendItem(s: Stored, tabId: string, item: ChatItem): void {
    const file = chatFile(rootOf(s), s.slug, tabId);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(item)}\n`);
    emit({ type: "chat", workspaceId: s.id, tabId, item });
  }

  function history(s: Stored, tabId: string): ChatItem[] {
    const file = chatFile(rootOf(s), s.slug, tabId);
    const items: ChatItem[] = [];
    if (existsSync(file)) {
      for (const l of readFileSync(file, "utf8").split("\n")) {
        if (!l.trim()) continue;
        try {
          items.push(JSON.parse(l) as ChatItem);
        } catch {
          /* a line cut short by a crash loses that line alone */
        }
      }
    }
    const open = live.get(`${s.id}:${tabId}`);
    if (open?.assistantId) items.push({ id: open.assistantId, ts: Date.now(), kind: "assistant", text: open.assistantText });
    return items;
  }

  function promptFor(s: Stored, tab: ChatTab, text: string, attachments: ChatAttachment[], handoff: boolean): string {
    const parts: string[] = [];
    if (!tab.sessionId && !handoff) {
      parts.push(`Workspace notes: branch ${s.branch}. The base is ${s.baseRef}. Port ${s.port} is reserved for this workspace. Private notes can go in .context, which is never committed.`);
    }
    if (handoff) {
      const tail = history(s, tab.id).filter((i) => i.kind === "user" || i.kind === "assistant").slice(-8);
      if (tail.length) {
        parts.push("This conversation began with another agent. The work so far is on this branch. The recent exchange:");
        parts.push(tail.map((i) => (i.kind === "user" ? `Person: ${i.text}` : i.kind === "assistant" ? `Agent: ${i.text.slice(0, 1200)}` : "")).join("\n\n"));
      }
    }
    if (tab.mode === "plan") {
      parts.push("Plan mode. Read the code. Write a concrete step-by-step plan for this request. Change no files. End by asking for approval.");
    }
    parts.push(text);
    const comments = attachments.filter((a) => a.kind === "comment");
    if (comments.length) {
      parts.push("Review comments on the current diff. Address each one:");
      for (const a of comments) {
        const c = a.comment;
        parts.push(`${c.path}:${c.startLine === c.endLine ? c.startLine : `${c.startLine}-${c.endLine}`}\n\`\`\`\n${c.excerpt}\n\`\`\`\n${c.text}`);
      }
    }
    for (const a of attachments) {
      if (a.kind === "file") parts.push(`Relevant file: ${a.path}`);
      if (a.kind === "text") parts.push(`${a.label}:\n\`\`\`\n${a.text}\n\`\`\``);
    }
    return parts.join("\n\n");
  }

  function send(id: string, tabId: string, text: string, attachments: ChatAttachment[]): void {
    const s = ws(id);
    const tab = s.tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error("That chat tab is closed.");
    if (s.status === "archived") throw new Error("Restore this workspace to keep working in it.");
    const clean = text.trim();
    if (!clean && attachments.length === 0) return;
    const key = `${id}:${tabId}`;
    if (live.has(key) || s.status === "creating" || s.status === "setup") {
      const q = queues.get(key) ?? [];
      q.push({ text: clean, attachments });
      queues.set(key, q);
      pushSnapshot();
      return;
    }
    start(s, tab, clean, attachments);
  }

  function start(s: Stored, tab: ChatTab, text: string, attachments: ChatAttachment[]): void {
    const key = `${s.id}:${tab.id}`;
    const root = rootOf(s);
    const display = text || "Please address the attached comments.";
    const providers = (s.sessionProviders ??= {});
    const handoff = !!tab.sessionId && providers[tab.id] !== tab.provider;
    const resume = tab.sessionId && !handoff ? tab.sessionId : null;
    const prompt = promptFor(s, tab, display, attachments, handoff);

    appendItem(s, tab.id, { id: uid(), ts: Date.now(), kind: "user", text: display, attachments, mode: tab.mode });
    if (tab.title === "Chat") tab.title = display.split("\n")[0]!.slice(0, 32);
    const sent = attachments.filter((a) => a.kind === "comment").map((a) => (a.kind === "comment" ? a.comment.id : ""));
    if (sent.length) for (const c of s.comments) if (sent.includes(c.id)) c.sentAt = Date.now();

    const state: Live = { handle: { cancel: () => {}, finished: Promise.resolve({} as RunResult) }, assistantId: null, assistantText: "", startedAt: Date.now() };
    live.set(key, state);
    const flush = (): void => {
      if (state.assistantId && state.assistantText.trim()) {
        const file = chatFile(root, s.slug, tab.id);
        appendFileSync(file, `${JSON.stringify({ id: state.assistantId, ts: Date.now(), kind: "assistant", text: state.assistantText })}\n`);
      }
      state.assistantId = null;
      state.assistantText = "";
    };
    let lastRefresh = 0;
    const onEvent = (e: RunEvent): void => {
      if (e.type === "text") {
        if (!state.assistantId) {
          state.assistantId = uid();
          emit({ type: "chat", workspaceId: s.id, tabId: tab.id, item: { id: state.assistantId, ts: Date.now(), kind: "assistant", text: "" } });
        }
        state.assistantText += e.text;
        emit({ type: "chat-delta", workspaceId: s.id, tabId: tab.id, itemId: state.assistantId, text: e.text });
      } else if (e.type === "tool") {
        flush();
        appendItem(s, tab.id, { id: uid(), ts: Date.now(), kind: "tool", name: e.name, summary: e.summary });
        if (Date.now() - lastRefresh > 2000) {
          lastRefresh = Date.now();
          void refreshGit(s);
        }
      } else if (e.type === "denied") {
        flush();
        appendItem(s, tab.id, { id: uid(), ts: Date.now(), kind: "denied", tool: e.tool });
      } else if (e.type === "turn") {
        flush();
        appendItem(s, tab.id, { id: uid(), ts: Date.now(), kind: "system", text: `Next turn: ${e.reason}.` });
      }
    };

    const label = display.split("\n")[0]!.trim();
    process.env.CEO_NO_COLLAB = settings.teamNotes ? "" : "1";
    state.handle = runDelegation(s.slug, label.length >= 3 ? label : `Message: ${label}`, {
      cwd: root,
      prompt,
      via: "app",
      provider: tab.provider,
      model: tab.model,
      level: tab.mode === "plan" ? "observe" : null,
      resumeSessionId: resume,
      onEvent,
    });
    save(s);
    state.handle.finished.then((r) => {
      flush();
      live.delete(key);
      if (r.sessionId) {
        tab.sessionId = r.sessionId;
        providers[tab.id] = tab.provider;
      }
      const cancelled = r.error === "cancelled";
      appendItem(s, tab.id, {
        id: uid(), ts: Date.now(), kind: "result", ok: r.ok, provider: tab.provider, model: tab.model,
        costUsd: r.costUsd, estimate: r.costIsEstimate, durationMs: r.durationMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens,
        error: r.error, cancelled, retryAt: r.rateLimit?.retryAt ?? null,
      });
      s.unread = true;
      const next = queues.get(key)?.shift();
      void refreshGit(s).then(() => pushSnapshot());
      if (next) {
        save(s);
        start(s, tab, next.text, next.attachments);
        return;
      }
      save(s);
      // A race reports once, when it settles.
      if (!cancelled && !s.raceId) {
        emit({
          type: "notify",
          title: r.ok ? `${s.title} is ready for review` : `${s.title} needs a look`,
          body: r.ok ? `${tab.provider} finished in ${Math.round(r.durationMs / 1000)}s.` : (r.error ?? "The run failed."),
          workspaceId: s.id, level: r.ok ? "done" : "failed", sound: settings.sound,
        });
      }
      noteRaceRun(s, tab, r);
    });
  }

  function drainAll(s: Stored): void {
    for (const tab of s.tabs) {
      const key = `${s.id}:${tab.id}`;
      const next = queues.get(key)?.shift();
      if (next && !live.has(key)) start(s, tab, next.text, next.attachments);
    }
  }

  // -- scripts -------------------------------------------------------------

  function scriptEnv(s: Stored): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, CEO_PORT: String(s.port), PORT: String(s.port), CEO_WORKSPACE: s.slug, CEO_BRANCH: s.branch, CEO_ROOT: rootOf(s) };
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
  }

  function startScript(s: Stored, kind: ScriptKind, command: string): Promise<number> {
    const key = `${s.id}:${kind}`;
    stopScriptRun(key);
    const run: ScriptRun = { child: null, log: "", code: null, url: null, running: true };
    scripts.set(key, run);
    const shell = process.env.SHELL || "/bin/zsh";
    return new Promise((resolve) => {
      const child = spawn(shell, ["-lc", command], { cwd: s.worktree, env: scriptEnv(s), detached: true, stdio: ["ignore", "pipe", "pipe"] });
      run.child = child;
      emit({ type: "script-state", workspaceId: s.id, kind, running: true, code: null, url: null });
      pushSnapshot();
      const onData = (b: Buffer): void => {
        const data = b.toString("utf8");
        run.log = (run.log + data).slice(-LOG_LIMIT);
        if (!run.url) {
          const m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s"'`<>)]*/.exec(data.replace(/\x1b\[[0-9;]*m/g, ""));
          if (m) {
            run.url = m[0].replace("0.0.0.0", "localhost");
            emit({ type: "script-state", workspaceId: s.id, kind, running: true, code: null, url: run.url });
          }
        }
        emit({ type: "script", workspaceId: s.id, kind, data });
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      const done = (code: number): void => {
        if (!run.running) return;
        run.running = false;
        run.code = code;
        run.child = null;
        emit({ type: "script-state", workspaceId: s.id, kind, running: false, code, url: run.url });
        pushSnapshot();
        resolve(code);
      };
      child.on("error", (e) => {
        onData(Buffer.from(`${e.message}\n`));
        done(127);
      });
      child.on("close", (code) => done(code ?? 1));
    });
  }

  function stopScriptRun(key: string): void {
    const run = scripts.get(key);
    if (run?.child?.pid) {
      try {
        process.kill(-run.child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }

  // -- pull requests -------------------------------------------------------

  type PrView = PullRequest & { rollup: Array<Record<string, unknown>> };

  async function ghStatus(root: string): Promise<{ ok: boolean; reason: string | null }> {
    const v = await G.run(ghBinary(), ["auth", "status"], root, { timeout: 8000 });
    if (v.ok) return { ok: true, reason: null };
    if (/ENOENT|not found/i.test(v.stderr)) return { ok: false, reason: "The GitHub CLI is not installed. brew install gh" };
    return { ok: false, reason: "The GitHub CLI is not signed in. gh auth login" };
  }

  async function prFor(s: Stored): Promise<PrView | null> {
    const target = s.pr?.number ? String(s.pr.number) : (s.pushRef ?? s.branch);
    const r = await G.run(ghBinary(), ["pr", "view", target, "--json", "number,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup"], s.worktree, { timeout: 15000 });
    if (!r.ok) return null;
    try {
      const j = JSON.parse(r.stdout) as Record<string, unknown>;
      if (typeof j.number !== "number" || typeof j.state !== "string") return null;
      return {
        number: j.number, url: String(j.url ?? ""), state: j.state as PullRequest["state"], isDraft: !!j.isDraft,
        mergeable: String(j.mergeable ?? ""), reviewDecision: String(j.reviewDecision ?? ""),
        rollup: Array.isArray(j.statusCheckRollup) ? (j.statusCheckRollup as Array<Record<string, unknown>>) : [],
      };
    } catch {
      return null;
    }
  }

  function toRuns(rollup: Array<Record<string, unknown>>): CheckRun[] {
    return rollup.map((c) => {
      const conclusion = String(c.conclusion ?? c.state ?? "").toUpperCase();
      const status = String(c.status ?? "").toUpperCase();
      const state: CheckRun["state"] =
        status && status !== "COMPLETED" ? "running"
        : ["SUCCESS", "NEUTRAL"].includes(conclusion) ? "pass"
        : ["SKIPPED", "CANCELLED", "STALE"].includes(conclusion) ? "skipped"
        : conclusion === "PENDING" || conclusion === "EXPECTED" ? "running"
        : "fail";
      return { name: String(c.name ?? c.context ?? "check"), state, url: typeof c.detailsUrl === "string" ? c.detailsUrl : typeof c.targetUrl === "string" ? c.targetUrl : null, detail: c.workflowName ? String(c.workflowName) : null };
    });
  }

  async function reviewsFor(s: Stored, number: number): Promise<ReviewNote[]> {
    const out: ReviewNote[] = [];
    const inline = await G.run(ghBinary(), ["api", `repos/{owner}/{repo}/pulls/${number}/comments`], s.worktree, { timeout: 15000 });
    if (inline.ok) {
      try {
        for (const c of JSON.parse(inline.stdout) as Array<Record<string, unknown>>) {
          out.push({ id: String(c.id), author: String((c.user as { login?: string } | undefined)?.login ?? "reviewer"), body: String(c.body ?? ""), path: typeof c.path === "string" ? c.path : null, line: typeof c.line === "number" ? c.line : null, url: typeof c.html_url === "string" ? c.html_url : null });
        }
      } catch {
        /* no readable comments */
      }
    }
    const reviews = await G.run(ghBinary(), ["pr", "view", String(number), "--json", "reviews"], s.worktree, { timeout: 15000 });
    if (reviews.ok) {
      try {
        const j = JSON.parse(reviews.stdout) as { reviews?: Array<Record<string, unknown>> };
        for (const r of j.reviews ?? []) {
          if (String(r.body ?? "").trim()) out.push({ id: String(r.id), author: String((r.author as { login?: string } | undefined)?.login ?? "reviewer"), body: String(r.body), path: null, line: null, url: null });
        }
      } catch {
        /* no readable reviews */
      }
    }
    return out;
  }

  async function checks(id: string): Promise<ChecksReport> {
    const s = ws(id);
    const p = project(s.projectId);
    await refreshGit(s);
    const git = gitCache.get(id) ?? EMPTY_GIT;
    let gh = { ok: false, reason: p.hasRemote ? null : "This project has no remote." as string | null };
    let runs: CheckRun[] = [];
    let reviews: ReviewNote[] = [];
    if (p.hasRemote && s.status !== "archived") {
      gh = await ghStatus(s.worktree);
      if (gh.ok) {
        const pr = await prFor(s);
        if (pr) {
          const { rollup, ...plain } = pr;
          s.pr = plain;
          if (plain.state === "MERGED" && !s.mergedAt) s.mergedAt = Date.now();
          runs = toRuns(rollup);
          reviews = await reviewsFor(s, pr.number);
          save(s);
        }
      }
    }
    const running = [...live.keys()].some((k) => k.startsWith(`${id}:`));
    const d = decideNext({ running, hasRemote: p.hasRemote, ghReady: gh.ok, git, pr: s.pr, runs, reviews, merged: !!s.mergedAt });
    return { ghReady: gh.ok, ghReason: gh.reason, git, pr: s.pr, runs, reviews, next: d.next, nextLabel: d.label, nextDetail: d.detail };
  }

  async function pushBranch(s: Stored): Promise<void> {
    const ref = s.pushRef ? `${s.branch}:${s.pushRef}` : s.branch;
    const r = await G.git(["push", "-u", "origin", ref], s.worktree, { timeout: 120000 });
    if (!r.ok) throw new Error(`git push failed: ${r.stderr.trim().split("\n").pop() ?? ""}`);
  }

  async function commitIfDirty(s: Stored, message: string): Promise<void> {
    const status = await G.git(["status", "--porcelain"], s.worktree);
    if (!status.stdout.trim()) return;
    const add = await G.git(["add", "-A"], s.worktree);
    if (!add.ok) throw new Error(add.stderr.trim());
    const c = await G.git(["commit", "-m", message], s.worktree);
    if (!c.ok) throw new Error(`git commit failed: ${(c.stderr || c.stdout).trim().split("\n").pop() ?? ""}`);
  }

  // -- race ----------------------------------------------------------------

  async function startRace(p: ParamsOf<"startRace">): Promise<Race> {
    if (!license().limits.race) throw new Error("Race is part of Pro. Start a trial or add a license in Settings.");
    if (p.arms.length < 2) throw new Error("A race needs at least two agents.");
    const prompt = p.prompt.trim();
    if (!prompt) throw new Error("A race needs a task.");
    checkActiveLimit(p.arms.length);
    const proj = project(p.projectId);
    const race: Race = {
      id: uid(), projectId: p.projectId, title: p.title.trim() || prompt.split("\n")[0]!.slice(0, 60), prompt,
      check: p.check.trim(), createdAt: Date.now(), settledAt: null, winnerId: null, kept: false, note: null, entries: [],
    };
    races.set(race.id, race);
    const kind = taskKind(prompt);
    for (const arm of p.arms) {
      const w = await createWorkspace(
        { projectId: p.projectId, title: `${race.title} · ${LABEL[arm.provider]}`, start: { kind: "base" }, prompt, provider: arm.provider, model: arm.model, mode: "build", budgetUsd: p.budgetUsd },
        { raceId: race.id, skipLimit: true },
      );
      race.entries.push({ workspaceId: w.id, provider: arm.provider, model: arm.model, state: "running", detail: "Working", costUsd: 0, durationMs: 0, added: 0, removed: 0 });
      ensureOrg(proj.path);
      append("attempt_start", w.slug, { taskId: race.id, attemptId: w.slug, agent: w.slug, arm: { provider: arm.provider, model: arm.model }, mode: "race", why: "race", branch: `ceo/${w.slug}`, worktree: w.worktree, base: proj.baseRef, kind }, proj.path);
    }
    persist(proj.path);
    pushSnapshot();
    return race;
  }

  function noteRaceRun(s: Stored, tab: ChatTab, r: RunResult): void {
    if (!s.raceId) return;
    const race = races.get(s.raceId);
    const entry = race?.entries.find((e) => e.workspaceId === s.id);
    if (!race || !entry || race.settledAt) return;
    entry.costUsd += r.costUsd;
    entry.durationMs += r.durationMs;
    const outcome = r.ok ? "done" : r.error === "cancelled" ? "cancelled" : r.rateLimit ? "rate_limited" : "failed";
    append("attempt_end", s.slug, { taskId: race.id, attemptId: s.slug, delegationId: r.delegationId, outcome, costUsd: r.costUsd, ...(r.ok ? {} : { error: (r.error ?? "").slice(0, 300) }) }, rootOf(s));
    entry.state = r.ok ? "checking" : r.error === "cancelled" ? "cancelled" : "failed";
    entry.detail = r.ok ? "Finished" : (r.error ?? "Failed");
    void tab;
    settleRace(race.id);
  }

  async function runRaceChecks(race: Race): Promise<void> {
    const proj = project(race.projectId);
    for (const entry of race.entries.filter((e) => e.state === "checking")) {
      const s = stored.get(entry.workspaceId);
      if (!s) continue;
      await refreshGit(s);
      const g = gitCache.get(s.id) ?? EMPTY_GIT;
      entry.added = g.added;
      entry.removed = g.removed;
      if (!race.check) {
        entry.state = "no-check";
        entry.detail = "No check set";
        continue;
      }
      entry.detail = "Running the check";
      pushSnapshot();
      const v = await verifyAll([parseVerifier(race.check)], { root: proj.path, workdir: s.worktree, base: s.baseRef, taskId: race.id, attemptId: s.slug, agent: s.slug, task: race.prompt, provider: entry.provider, scope: "task" });
      entry.state = v.pass ? "passed" : "failed";
      entry.detail = v.pass ? "Check passed" : `Check failed. ${v.results?.[0]?.result?.detail ?? ""}`.trim().replace(/:\s*$/, ".");
      s.checkResult = { pass: v.pass, detail: entry.detail, at: Date.now() };
    }
    const passing = race.entries.filter((e) => e.state === "passed").sort((a, b) => a.costUsd - b.costUsd || a.added + a.removed - (b.added + b.removed) || a.durationMs - b.durationMs);
    race.winnerId = passing[0]?.workspaceId ?? null;
    race.settledAt = Date.now();
    if (race.winnerId) {
      const w = stored.get(race.winnerId)!;
      const entry = race.entries.find((e) => e.workspaceId === race.winnerId)!;
      race.note = passing.length > 1 ? `${LABEL[entry.provider]} wins. ${passing.length} agents passed the check, and this one cost the least.` : `${LABEL[entry.provider]} wins. Only this agent passed the check.`;
      append("promote", w.slug, { taskId: race.id, attemptId: w.slug, branch: w.branch, arm: { provider: entry.provider, model: entry.model }, score: 1, costUsd: entry.costUsd, attempts: race.entries.length, dissent: null }, proj.path);
    } else {
      race.note = race.check ? "No agent passed the check." : "Finished. Compare the diffs and keep one.";
    }
    persist(proj.path);
    pushSnapshot();
    emit({ type: "notify", title: `Race settled: ${race.title}`, body: race.note, workspaceId: race.winnerId, level: race.winnerId ? "done" : "info", sound: settings.sound });
  }

  const settling = new Set<string>();
  function settleRace(raceId: string | null): void {
    if (!raceId) return;
    const race = races.get(raceId);
    if (!race || race.settledAt || settling.has(raceId)) return;
    for (const e of race.entries) {
      const s = stored.get(e.workspaceId);
      if (s?.status === "failed" && e.state === "running") {
        e.state = "failed";
        e.detail = s.statusDetail ?? "Could not start";
      }
    }
    if (race.entries.some((e) => e.state === "running")) {
      pushSnapshot();
      return;
    }
    settling.add(raceId);
    void runRaceChecks(race).finally(() => settling.delete(raceId));
  }

  // -- planner -------------------------------------------------------------

  async function draftPlan(p: ParamsOf<"draftPlan">): Promise<PlanDraft> {
    if (!license().limits.planner) throw new Error("Plan is part of Pro. Start a trial or add a license in Settings.");
    const proj = project(p.projectId);
    if (!p.goal.trim()) throw new Error("Write a goal first.");
    ensureOrg(proj.path);
    const name = "planner";
    if (!safeAgent(name, proj.path)) {
      hire({ name, role: "Technical lead who reads a repository and splits a goal into independent pieces of work, each small enough for one reviewable change.", provider: p.provider, autonomy: "observe", budgetUsd: settings.defaultBudgetUsd }, proj.path);
    }
    const prompt = [
      "Read this repository, then split the goal below into independent tasks. Each task must be mergeable on its own and must not depend on another task's unmerged work.",
      'Reply with JSON alone, in this shape: {"rationale":"one sentence","tasks":[{"title":"short imperative title","prompt":"complete instructions for an engineer who has not seen the goal","provider":"claude"}]}.',
      "Use at most 6 tasks. Fewer is better.",
      `Goal: ${p.goal.trim()}`,
    ].join("\n\n");
    const handle = runDelegation(name, `Plan: ${p.goal.trim().slice(0, 80)}`, { cwd: proj.path, prompt, provider: p.provider, via: "plan" });
    const r = await handle.finished;
    if (!r.ok) throw new Error(r.error ?? "The planner failed.");
    const start = r.text.indexOf("{");
    const end = r.text.lastIndexOf("}");
    if (start < 0 || end < start) throw new Error("The planner did not return a plan. Try again, or rephrase the goal.");
    let parsed: { rationale?: unknown; tasks?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(r.text.slice(start, end + 1));
    } catch {
      throw new Error("The planner returned a plan that could not be read. Try again.");
    }
    const tasks: PlannedTask[] = (parsed.tasks ?? []).slice(0, 6).map((t) => ({
      title: String(t.title ?? "").slice(0, 80),
      prompt: String(t.prompt ?? t.title ?? ""),
      provider: PROVIDERS.includes(t.provider as Provider) ? (t.provider as Provider) : p.provider,
      selected: true,
    })).filter((t) => t.title && t.prompt);
    if (tasks.length === 0) throw new Error("The planner returned no tasks.");
    return { tasks, rationale: String(parsed.rationale ?? ""), costUsd: r.costUsd };
  }

  // -- reports -------------------------------------------------------------

  function spend(p: ParamsOf<"spend">): SpendReport {
    const since = Date.now() - p.days * 86400000;
    const list = p.projectId ? [project(p.projectId)] : [...projects.values()];
    const day = new Map<string, number>();
    const prov = new Map<string, { c: number; n: number; est: boolean }>();
    const wsMap = new Map<string, { label: string; c: number; n: number; est: boolean }>();
    const recent: SpendReport["recent"] = [];
    let total = 0;
    let estimated = 0;
    let runs = 0;
    let chainOk = true;
    let entriesN = 0;
    let chainDetail = "";
    for (const proj of list) {
      if (!existsSync(path.join(proj.path, ".ceo", "ledger.jsonl"))) continue;
      const v = verifyLedger(proj.path);
      entriesN += readLedger(proj.path).length;
      if (!v.ok) {
        chainOk = false;
        chainDetail = `${proj.name}: the hash chain breaks at entry ${v.brokenAtSeq ?? "unknown"}. ${v.reason ?? ""}`.trim();
      }
      const starts = new Map<string, Record<string, unknown>>();
      for (const e of readLedger(proj.path)) {
        if (e.type === "delegate_start") starts.set(String(e.data.id), e.data);
        if (e.type !== "delegate_end" || e.ts < since) continue;
        const st = starts.get(String(e.data.id)) ?? {};
        const cost = Number(e.data.costUsd ?? 0) || 0;
        const est = !!e.data.costIsEstimate;
        const provider = String(st.provider ?? "unknown");
        const slug = e.agent ?? "unknown";
        const stWs = [...stored.values()].find((x) => x.projectId === proj.id && x.slug === slug);
        total += cost;
        if (est) estimated += cost;
        runs += 1;
        const d = new Date(e.ts).toISOString().slice(0, 10);
        day.set(d, (day.get(d) ?? 0) + cost);
        const pr = prov.get(provider) ?? { c: 0, n: 0, est: false };
        pr.c += cost; pr.n += 1; pr.est ||= est;
        prov.set(provider, pr);
        const k = `${proj.id}:${slug}`;
        const w = wsMap.get(k) ?? { label: stWs?.title ?? slug, c: 0, n: 0, est: false };
        w.c += cost; w.n += 1; w.est ||= est;
        wsMap.set(k, w);
        recent.push({ id: String(e.data.id), ts: e.ts, workspace: stWs?.title ?? slug, task: String(st.task ?? ""), provider, model: String(st.model ?? ""), costUsd: cost, estimate: est, outcome: String(e.data.outcome ?? "done"), durationMs: Number(e.data.durationMs ?? 0) });
      }
    }
    const days: Array<{ day: string; costUsd: number }> = [];
    for (let i = p.days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      days.push({ day: d, costUsd: day.get(d) ?? 0 });
    }
    const rows = <T extends { c: number; n: number; est: boolean }>(m: Map<string, T>, label: (k: string, v: T) => string) =>
      [...m.entries()].map(([k, v]) => ({ key: k, label: label(k, v), costUsd: v.c, runs: v.n, estimate: v.est })).sort((a, b) => b.costUsd - a.costUsd);
    return {
      totalUsd: total, estimatedUsd: estimated, runs, byDay: days,
      byProvider: rows(prov, (k) => k), byWorkspace: rows(wsMap, (_k, v) => v.label),
      ledger: { ok: chainOk, entries: entriesN, detail: chainOk ? `${entriesN} entries. The hash chain is intact.` : chainDetail },
      recent: recent.sort((a, b) => b.ts - a.ts).slice(0, 100),
    };
  }

  function insights(p: ParamsOf<"insights">): Insights {
    if (!license().limits.insights) throw new Error("Insights is part of Pro. Start a trial or add a license in Settings.");
    const list = p.projectId ? [project(p.projectId)] : [...projects.values()];
    const rows: Insights["rows"] = [];
    for (const proj of list) {
      if (!existsSync(path.join(proj.path, ".ceo", "ledger.jsonl"))) continue;
      for (const r of routerTable(proj.path)) {
        rows.push({ kind: r.kind, provider: r.arm.provider, model: r.arm.model, runs: r.observations, passes: r.passes, passRate: r.passRate, costPerPass: r.costPerVerified, source: r.source });
      }
    }
    const all = [...races.values()].filter((r) => !p.projectId || r.projectId === p.projectId);
    return { rows: rows.sort((a, b) => a.kind.localeCompare(b.kind) || b.passRate - a.passRate), races: all.length, decided: all.filter((r) => r.winnerId).length };
  }

  function readiness(refresh = false): Readiness[] {
    if (refresh) resetReadiness();
    return allReadiness().map((r) => {
      const spec = providerFor(r.provider);
      return {
        provider: r.provider, binary: r.binary, installed: r.installed, version: r.version, signedIn: r.signedIn, ready: r.ready,
        metered: r.billing.mode === "api_key", account: r.billing.account ?? r.billing.summary, fix: r.fix, fixCommand: (r.fix[0] ?? "").split(/\s{2,}/)[0] ?? "",
        models: spec.models(), defaultModel: spec.defaultModel(), isStub: /stub-/.test(r.binary),
      };
    });
  }

  /** One workspace's slice of the ledger, in words. */
  function recordOf(s: Stored): { entries: RecordEntry[]; ok: boolean; detail: string } {
    const root = rootOf(s);
    const check = verifyLedger(root);
    const entries: RecordEntry[] = [];
    const clip = (v: unknown, n = 140): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
    const list = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : clip(v));
    for (const e of readLedger(root)) {
      const d = e.data;
      const mine = e.agent === s.slug || d.from === s.slug || d.to === s.slug;
      if (!mine) continue;
      let title = e.type.replace(/_/g, " ");
      let detail = "";
      let costUsd: number | null = null;
      if (e.type === "hire") { title = "Workspace agent created"; detail = `${clip(d.provider)} · ${clip(d.model)} · ${clip(d.autonomy)} · budget $${Number(d.budgetUsd ?? 0).toFixed(2)}`; }
      else if (e.type === "worktree_provision") { title = "Worktree created"; detail = clip(d.branch); }
      else if (e.type === "delegate_start") { title = `Run started: ${clip(d.task, 70)}`; detail = `${clip(d.provider)} · ${clip(d.model)} · allowed: ${list(d.enforcement)}`.slice(0, 220); }
      else if (e.type === "delegate_end") { title = `Run ${clip(d.outcome || "finished")}`; costUsd = Number(d.costUsd ?? 0); detail = `${Number(d.inputTokens ?? 0) + Number(d.outputTokens ?? 0)} tokens · ${Math.round(Number(d.durationMs ?? 0) / 1000)}s${d.costIsEstimate ? " · cost estimated" : ""}`; }
      else if (e.type === "worktree_commit") { title = `Commit ${clip(d.sha).slice(0, 7)}`; detail = list(d.files); }
      else if (e.type === "worktree_merge") { title = d.ok ? "Merged" : "Merge failed"; detail = clip(d.branch); }
      else if (e.type === "verify") { title = `Check ${clip(d.status)}`; detail = clip(d.detail); }
      else if (e.type === "budget_set") { title = "Budget changed"; detail = `$${Number(d.budgetUsd ?? 0).toFixed(2)}`; }
      else if (e.type === "note") { title = d.kind ? `Note: ${clip(d.kind).replace(/_/g, " ")}` : "Note"; detail = clip(d.detail ?? d.text ?? d.url ?? ""); }
      entries.push({ seq: e.seq, ts: e.ts, type: e.type, title, detail, costUsd, hash: e.hash.slice(0, 10) });
    }
    return { entries: entries.reverse(), ok: check.ok, detail: check.ok ? `${check.entriesChecked} entries in this project. The hash chain is intact.` : `The hash chain breaks at entry ${check.brokenAtSeq ?? "unknown"}. ${check.reason ?? ""}`.trim() };
  }

  // -- terminals -----------------------------------------------------------

  function terminalFor(id: string, cwd: string, env: NodeJS.ProcessEnv, cols: number, rows: number): Term {
    const open = terms.get(id);
    if (open) return open;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePty = require("node-pty") as { spawn: (f: string, a: string[], o: Record<string, unknown>) => Term["pty"] };
    const shell = process.env.SHELL || "/bin/zsh";
    const pty = nodePty.spawn(shell, ["-l"], { name: "xterm-256color", cols, rows, cwd, env });
    const term: Term = { id, pty, backlog: "" };
    terms.set(id, term);
    pty.onData((d) => {
      term.backlog = (term.backlog + d).slice(-200000);
      emit({ type: "terminal", id, data: d });
    });
    pty.onExit((e) => {
      terms.delete(id);
      emit({ type: "terminal-exit", id, code: e.exitCode });
    });
    return term;
  }

  // -- the surface ---------------------------------------------------------

  const handlers: Handlers = {
    snapshot,
    readiness: (p) => readiness(!!p?.refresh),
    settings: () => settings,
    saveSettings: (p) => {
      settings = { ...settings, ...p };
      atomicWrite(settingsFile(), JSON.stringify(settings, null, 2));
      return settings;
    },
    license,
    activateLicense: ({ key }) => {
      const rec = licenseRecord();
      const next = licenseState({ key, firstRunAt: rec.firstRunAt });
      if (next.plan !== "pro") throw new Error(next.error ?? "That license key is not valid.");
      atomicWrite(licenseFile(), JSON.stringify({ ...rec, key: key.trim() }));
      emit({ type: "license", license: next });
      return next;
    },
    deactivateLicense: () => {
      const rec = licenseRecord();
      atomicWrite(licenseFile(), JSON.stringify({ ...rec, key: null }));
      const next = license();
      emit({ type: "license", license: next });
      return next;
    },
    addProject: async ({ path: input }) => {
      const given = path.resolve(input);
      if (!existsSync(given) || !statSync(given).isDirectory()) throw new Error("That folder does not exist.");
      const top = await G.git(["rev-parse", "--show-toplevel"], given);
      const root = top.ok ? realpathSync(top.stdout.trim()) : realpathSync(given);
      const added = addWorkspace(root);
      const p = await loadProject(added.path, added.name);
      pushSnapshot();
      return p;
    },
    cloneProject: async ({ url, into }) => {
      const clean = url.trim();
      if (!/^(https:\/\/|ssh:\/\/|git@)[^\s]+$/.test(clean)) throw new Error("Use an https or ssh repository URL.");
      const name = clean.replace(/\.git$/, "").split(/[/:]/).pop() || "repo";
      if (!/^[\w.-]+$/.test(name) || name.startsWith(".")) throw new Error("That repository name cannot be a folder name.");
      const target = path.join(path.resolve(into), name);
      if (existsSync(target)) throw new Error(`${target} already exists.`);
      const r = await G.git(["clone", "--", clean, target], path.resolve(into), { timeout: 600000 });
      if (!r.ok) throw new Error(r.stderr.trim().split("\n").pop() ?? "git clone failed.");
      return handlers.addProject({ path: target });
    },
    createFirstCommit: async ({ projectId }) => {
      const p = project(projectId);
      if (!p.isGit) {
        const i = await G.git(["init"], p.path);
        if (!i.ok) throw new Error(i.stderr.trim());
      }
      const c = await G.git(["-c", "user.name=CEO", "-c", "user.email=ceo@localhost", "commit", "--allow-empty", "-m", "Initial commit"], p.path);
      if (!c.ok) throw new Error(c.stderr.trim());
      const next = await loadProject(p.path, p.name);
      pushSnapshot();
      return next;
    },
    removeProject: ({ projectId }) => {
      const p = project(projectId);
      if ([...stored.values()].some((s) => s.projectId === projectId && [...live.keys()].some((k) => k.startsWith(`${s.id}:`)))) {
        throw new Error("Stop the running agents in this project first.");
      }
      for (const [id, s] of stored) if (s.projectId === projectId) { stored.delete(id); gitCache.delete(id); }
      for (const [id, r] of races) if (r.projectId === projectId) races.delete(id);
      projects.delete(projectId);
      removeWorkspace(p.path);
      pushSnapshot();
    },
    saveProjectConfig: async ({ projectId, config }) => {
      const p = project(projectId);
      const next = { ...p.config, ...config };
      mkdirSync(appDir(p.path), { recursive: true });
      G.excludeLocal(p.path, LOCAL_EXCLUDES);
      atomicWrite(configFile(p.path), JSON.stringify(next, null, 2));
      const out = await loadProject(p.path, p.name);
      pushSnapshot();
      return out;
    },
    branches: async ({ projectId }) => {
      const p = project(projectId);
      const r = await G.git(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)\x1f%(committerdate:relative)\x1f%(subject)", "refs/heads", "refs/remotes/origin"], p.path);
      const used = new Set([...stored.values()].filter((s) => s.projectId === projectId && s.status !== "archived").map((s) => s.branch));
      const out: ListItem[] = [];
      for (const l of r.stdout.split("\n").filter(Boolean).slice(0, 200)) {
        const [ref, when, subject] = l.split("\x1f");
        if (!ref || used.has(ref) || ref === "origin/HEAD" || ref.startsWith("ceo/") || ref === "origin") continue;
        out.push({ value: ref, title: ref, detail: `${when} · ${subject}` });
      }
      return out;
    },
    pullRequests: async ({ projectId }) => {
      const p = project(projectId);
      const r = await G.run(ghBinary(), ["pr", "list", "--limit", "50", "--json", "number,title,headRefName,author"], p.path, { timeout: 15000 });
      if (!r.ok) throw new Error(r.stderr.trim() || "Pull requests need the GitHub CLI, signed in.");
      return (JSON.parse(r.stdout) as Array<{ number: number; title: string; headRefName: string; author?: { login?: string } }>).map((x) => ({ value: String(x.number), title: `#${x.number} ${x.title}`, detail: `${x.headRefName} · ${x.author?.login ?? ""}` }));
    },
    issues: ({ projectId }) => listIssues(project(projectId).path, { limit: 50 }).map((i) => ({ value: String(i.number), title: `#${i.number} ${i.title}`, detail: i.labels.join(", ") })),
    createWorkspace: (p) => createWorkspace(p),
    renameWorkspace: ({ id, title }) => {
      const s = ws(id);
      if (title.trim()) s.title = title.trim().slice(0, 120);
      save(s);
    },
    archiveWorkspace: async ({ id }) => {
      const s = ws(id);
      if (s.status === "archived") return;
      for (const [k, l] of [...live]) if (k.startsWith(`${id}:`)) { queues.delete(k); l.handle.cancel(); }
      for (const kind of ["run", "setup", "check"] as ScriptKind[]) stopScriptRun(`${id}:${kind}`);
      const term = terms.get(id);
      if (term) { term.pty.kill(); terms.delete(id); }
      const p = project(s.projectId);
      if (existsSync(s.worktree)) {
        if (p.config.archive.trim()) await startScript(s, "archive", p.config.archive).catch(() => 1);
        const before = await G.git(["rev-parse", "HEAD"], s.worktree);
        const status = await G.git(["status", "--porcelain"], s.worktree);
        if (status.stdout.trim()) {
          await commitIfDirty(s, `ceo(${s.slug}): work in progress at archive`);
          s.wipCommit = before.stdout.trim();
        }
        teardownWorktree(s.slug, {}, p.path);
      }
      s.status = "archived";
      s.archivedAt = Date.now();
      save(s);
    },
    restoreWorkspace: async ({ id }) => {
      const s = ws(id);
      if (s.status !== "archived") return;
      checkActiveLimit();
      const p = project(s.projectId);
      provisionWorktree(s.slug, p.path);
      if (s.wipCommit) {
        await G.git(["reset", "--soft", s.wipCommit], s.worktree);
        await G.git(["reset"], s.worktree);
        s.wipCommit = null;
      }
      s.status = "ready";
      s.archivedAt = null;
      await refreshGit(s);
      save(s);
    },
    deleteWorkspace: ({ id }) => {
      const s = ws(id);
      if ([...live.keys()].some((k) => k.startsWith(`${id}:`))) throw new Error("Stop the running agent first.");
      const p = project(s.projectId);
      try {
        teardownWorktree(s.slug, { deleteBranch: true }, p.path);
        if (safeAgent(s.slug, p.path)) fire(s.slug, "workspace deleted", p.path);
      } catch {
        /* the record goes either way */
      }
      rmSync(path.join(appDir(p.path), "chat", s.slug), { recursive: true, force: true });
      stored.delete(id);
      gitCache.delete(id);
      persist(p.path);
      pushSnapshot();
    },
    setBudget: ({ id, budgetUsd }) => {
      const s = ws(id);
      if (!(budgetUsd > 0)) throw new Error("A budget must be above zero.");
      coreSetBudget(s.slug, budgetUsd, rootOf(s));
      s.budgetUsd = budgetUsd;
      save(s);
    },
    markRead: ({ id }) => {
      const s = stored.get(id);
      if (s?.unread) {
        s.unread = false;
        persist(rootOf(s));
        pushSnapshot();
      }
    },
    chatHistory: ({ id, tabId }) => history(ws(id), tabId),
    newTab: ({ id, provider, model, mode }) => {
      const s = ws(id);
      const tab: ChatTab = { id: uid(), title: "Chat", provider, model, mode, sessionId: null };
      s.tabs.push(tab);
      save(s);
      return tab;
    },
    closeTab: ({ id, tabId }) => {
      const s = ws(id);
      if (live.has(`${id}:${tabId}`)) throw new Error("Stop this agent first.");
      if (s.tabs.length <= 1) throw new Error("A workspace keeps at least one chat.");
      s.tabs = s.tabs.filter((t) => t.id !== tabId);
      queues.delete(`${id}:${tabId}`);
      save(s);
    },
    updateTab: ({ id, tabId, provider, model, mode, title }) => {
      const s = ws(id);
      const t = s.tabs.find((x) => x.id === tabId);
      if (!t) return;
      if (provider) t.provider = provider;
      if (model) t.model = model;
      if (mode) t.mode = mode as Mode;
      if (title?.trim()) t.title = title.trim().slice(0, 60);
      save(s);
    },
    send: ({ id, tabId, text, attachments }) => send(id, tabId, text, attachments),
    stop: ({ id, tabId }) => {
      queues.delete(`${id}:${tabId}`);
      live.get(`${id}:${tabId}`)?.handle.cancel();
      pushSnapshot();
    },
    diff: async ({ id, commit }): Promise<DiffResult> => {
      const s = ws(id);
      if (!existsSync(s.worktree)) return { files: [], commits: [], truncated: false };
      return G.diff(s.worktree, s.baseRef, commit);
    },
    markViewed: ({ id, path: p, hash }) => {
      const s = ws(id);
      if (hash) s.viewed[p] = hash;
      else delete s.viewed[p];
      save(s);
    },
    discardFile: async ({ id, path: rel }) => {
      const s = ws(id);
      if ([...live.keys()].some((k) => k.startsWith(`${id}:`))) throw new Error("Stop the running agent first.");
      const full = G.safePath(s.worktree, rel, realpathSync);
      const inBase = await G.git(["cat-file", "-e", `${s.baseRef}:${rel}`], s.worktree);
      if (inBase.ok) {
        const r = await G.git(["checkout", s.baseRef, "--", rel], s.worktree);
        if (!r.ok) throw new Error(r.stderr.trim());
      } else {
        await G.git(["rm", "--cached", "-f", "--ignore-unmatch", "--", rel], s.worktree);
        rmSync(full, { force: true });
      }
      await refreshGit(s);
      pushSnapshot();
    },
    addComment: ({ id, path: p, startLine, endLine, side, text, excerpt }) => {
      const s = ws(id);
      const c: LineComment = { id: uid(), path: p, startLine, endLine, side, text: text.trim(), excerpt: excerpt.slice(0, 4000), createdAt: Date.now(), sentAt: null };
      s.comments.push(c);
      save(s);
      return c;
    },
    deleteComment: ({ id, commentId }) => {
      const s = ws(id);
      s.comments = s.comments.filter((c) => c.id !== commentId);
      save(s);
    },
    files: async ({ id }) => {
      const s = ws(id);
      return existsSync(s.worktree) ? G.listFiles(s.worktree, s.baseRef) : [];
    },
    readFile: ({ id, path: rel }) => {
      const s = ws(id);
      const full = G.safePath(s.worktree, rel, realpathSync);
      if (!existsSync(full) || !statSync(full).isFile()) throw new Error("That file does not exist.");
      if (statSync(full).size > 2 * 1024 * 1024) return { text: null, binary: false, tooLarge: true };
      const buf = readFileSync(full);
      if (buf.subarray(0, 8000).includes(0)) return { text: null, binary: true, tooLarge: false };
      return { text: buf.toString("utf8"), binary: false, tooLarge: false };
    },
    searchFiles: async ({ id, query }) => G.grep(ws(id).worktree, query),
    checks: ({ id }) => checks(id),
    failureLog: async ({ id, name }) => {
      const s = ws(id);
      const pr = await prFor(s);
      const c = pr ? toRuns(pr.rollup).find((r) => r.name === name) : null;
      const runId = c?.url ? /runs\/(\d+)/.exec(c.url)?.[1] : null;
      if (!runId) return `Check "${name}" failed. No log is available from here.`;
      const r = await G.run(ghBinary(), ["run", "view", runId, "--log-failed"], s.worktree, { timeout: 45000 });
      return (r.stdout || r.stderr || `Check "${name}" failed.`).slice(-12000);
    },
    draftPr: async ({ id }) => {
      const s = ws(id);
      const log = await G.commits(s.worktree, s.baseRef);
      const summary = log.slice(0, 20).map((c) => `- ${c.subject.replace(/^ceo\([^)]*\):\s*/, "")}`).join("\n");
      let provenance = "";
      try {
        provenance = provenanceBody(s.slug, rootOf(s));
      } catch {
        provenance = "";
      }
      return { title: s.title.slice(0, 120), body: [summary && `## Changes\n${summary}`, provenance].filter(Boolean).join("\n\n"), base: s.baseRef.replace(/^origin\//, "") };
    },
    createPr: async ({ id, title, body, draft }) => {
      const s = ws(id);
      if (!title.trim()) throw new Error("A pull request needs a title.");
      await commitIfDirty(s, title.trim());
      await pushBranch(s);
      const head = s.pushRef ?? s.branch;
      const args = ["pr", "create", "--head", head, "--base", s.baseRef.replace(/^origin\//, ""), "--title", title.trim().slice(0, 200), "--body-file", "-"];
      if (draft) args.push("--draft");
      const r = await G.run(ghBinary(), args, s.worktree, { input: body, timeout: 60000 });
      const url = /https:\/\/\S+\/pull\/\d+/.exec(`${r.stdout}\n${r.stderr}`)?.[0];
      if (!url) throw new Error(r.stderr.trim() || "gh pr create failed.");
      const number = Number(/(\d+)$/.exec(url)?.[1]);
      const pr: PullRequest = { number, url, state: "OPEN", isDraft: draft, mergeable: "UNKNOWN", reviewDecision: "" };
      s.pr = pr;
      append("note", s.slug, { kind: "pr", branch: s.branch, base: s.baseRef, url }, rootOf(s));
      save(s);
      return pr;
    },
    mergePr: async ({ id, method }) => {
      const s = ws(id);
      if (!s.pr) throw new Error("This workspace has no pull request.");
      const r = await G.run(ghBinary(), ["pr", "merge", String(s.pr.number), `--${method}`], s.worktree, { timeout: 60000 });
      if (!r.ok) throw new Error(r.stderr.trim().split("\n").pop() ?? "gh pr merge failed.");
      s.pr.state = "MERGED";
      s.mergedAt = Date.now();
      append("note", s.slug, { kind: "pr_merged", url: s.pr.url, method }, rootOf(s));
      save(s);
    },
    mergeLocal: async ({ id }) => {
      const s = ws(id);
      const p = project(s.projectId);
      if ([...live.keys()].some((k) => k.startsWith(`${id}:`))) throw new Error("Stop the running agent first.");
      const base = s.baseRef.replace(/^origin\//, "");
      const cur = (await G.git(["branch", "--show-current"], p.path)).stdout.trim();
      if (cur !== base) throw new Error(`The main checkout is on ${cur || "a detached HEAD"}. Switch it to ${base} to merge here.`);
      await commitIfDirty(s, s.title);
      const r = mergeAgentBranch(s.slug, {}, p.path);
      if (!r.ok) {
        await G.git(["merge", "--abort"], p.path);
        if (r.conflicts.length === 0) throw new Error(r.error);
        return { conflicts: r.conflicts };
      }
      s.mergedAt = Date.now();
      await refreshGit(s);
      save(s);
      return { conflicts: [] };
    },
    updateFromBase: async ({ id }) => {
      const s = ws(id);
      const p = project(s.projectId);
      if (p.hasRemote) await G.git(["fetch", "origin"], p.path, { timeout: 30000 });
      await commitIfDirty(s, `ceo(${s.slug}): save work before updating from the base`);
      const r = await G.git(["merge", "--no-edit", s.baseRef], s.worktree, { timeout: 60000 });
      if (!r.ok) {
        const u = await G.git(["diff", "--name-only", "--diff-filter=U"], s.worktree);
        await refreshGit(s);
        pushSnapshot();
        const conflicts = u.stdout.split("\n").filter(Boolean);
        if (conflicts.length === 0) throw new Error(r.stderr.trim() || "The merge failed.");
        return { conflicts };
      }
      await refreshGit(s);
      pushSnapshot();
      return { conflicts: [] };
    },
    commit: async ({ id, message }) => {
      const s = ws(id);
      if (!message.trim()) throw new Error("A commit needs a message.");
      await commitIfDirty(s, message.trim());
      await refreshGit(s);
      pushSnapshot();
    },
    setTodos: ({ id, todos }) => {
      const s = ws(id);
      s.todos = todos;
      save(s);
    },
    scriptState: ({ id, kind }): ScriptState => {
      const r = scripts.get(`${id}:${kind}`);
      return r ? { running: r.running, code: r.code, url: r.url, log: r.log } : { running: false, code: null, url: null, log: "" };
    },
    runScript: ({ id, kind }) => {
      const s = ws(id);
      const p = project(s.projectId);
      const cmd = kind === "run" ? p.config.run : kind === "setup" ? p.config.setup : kind === "check" ? p.config.check : p.config.archive;
      if (!cmd.trim()) throw new Error(`This project has no ${kind} script. Add one in the project's settings.`);
      void startScript(s, kind, cmd).then((code) => {
        if (kind === "check") {
          s.checkResult = { pass: code === 0, detail: code === 0 ? "Check passed" : `Check exited with ${code}`, at: Date.now() };
          save(s);
        }
      });
    },
    stopScript: ({ id, kind }) => stopScriptRun(`${id}:${kind}`),
    terminalOpen: ({ id, cols, rows }) => {
      if (id.startsWith("login:")) {
        const provider = id.slice(6) as Provider;
        if (!PROVIDERS.includes(provider)) throw new Error("Unknown provider.");
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const t = terminalFor(id, process.env.HOME || "/", env, cols, rows);
        return { terminalId: t.id, backlog: t.backlog };
      }
      const s = ws(id);
      if (!existsSync(s.worktree)) throw new Error("This workspace has no worktree right now.");
      const t = terminalFor(id, s.worktree, scriptEnv(s), cols, rows);
      return { terminalId: t.id, backlog: t.backlog };
    },
    terminalInput: ({ terminalId, data }) => terms.get(terminalId)?.pty.write(data),
    terminalResize: ({ terminalId, cols, rows }) => terms.get(terminalId)?.pty.resize(Math.max(cols, 2), Math.max(rows, 2)),
    terminalClose: ({ terminalId }) => {
      terms.get(terminalId)?.pty.kill();
      terms.delete(terminalId);
    },
    startRace,
    rerunRaceChecks: ({ raceId }) => {
      const race = races.get(raceId);
      if (!race) throw new Error("That race no longer exists.");
      for (const e of race.entries) if (e.state === "passed" || e.state === "failed" || e.state === "no-check") e.state = "checking";
      race.settledAt = null;
      race.winnerId = null;
      settleRace(raceId);
    },
    keepWinner: async ({ raceId, workspaceId }) => {
      const race = races.get(raceId);
      if (!race) throw new Error("That race no longer exists.");
      race.winnerId = workspaceId;
      race.kept = true;
      for (const e of race.entries) {
        if (e.workspaceId !== workspaceId && stored.get(e.workspaceId)?.status !== "archived") await handlers.archiveWorkspace({ id: e.workspaceId });
      }
      persist(project(race.projectId).path);
      pushSnapshot();
    },
    draftPlan,
    launchPlan: async ({ projectId, tasks, model }) => {
      const chosen = tasks.filter((t) => t.selected);
      checkActiveLimit(chosen.length);
      const out: Workspace[] = [];
      for (const t of chosen) {
        out.push(await createWorkspace({ projectId, title: t.title, start: { kind: "base" }, prompt: t.prompt, provider: t.provider, model: model[t.provider] ?? providerFor(t.provider).defaultModel(), mode: "build" }, { skipLimit: true }));
      }
      return out;
    },
    spend,
    insights,
    record: ({ id }) => recordOf(ws(id)),
    exportLedger: ({ projectId, to }) => {
      if (!license().limits.exportData) throw new Error("Export is part of Pro.");
      const p = project(projectId);
      const target = path.resolve(to);
      if (!target.endsWith(".jsonl")) throw new Error("Export to a .jsonl file.");
      copyFileSync(path.join(p.path, ".ceo", "ledger.jsonl"), target);
      return { path: target, entries: readLedger(p.path).length };
    },
  };

  // Periodic refresh: changes made outside the app show up on their own.
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    void (async () => {
      for (const s of stored.values()) {
        const busy = [...live.keys()].some((k) => k.startsWith(`${s.id}:`));
        if (busy || tick % 3 === 0) await refreshGit(s);
        if (s.pr && s.pr.state === "OPEN" && Date.now() - (prCheckedAt.get(s.id) ?? 0) > 60000) {
          prCheckedAt.set(s.id, Date.now());
          const pr = await prFor(s);
          if (pr) {
            const { rollup: _r, ...plain } = pr;
            void _r;
            if (JSON.stringify(plain) !== JSON.stringify(s.pr)) {
              s.pr = plain;
              if (plain.state === "MERGED") s.mergedAt = Date.now();
              save(s);
            }
          }
        }
      }
    })();
  }, 4000);
  timer.unref?.();

  const ready = (async () => {
    for (const w of listWorkspaces()) {
      if (existsSync(w.path)) await loadProject(w.path, w.name).catch(() => null);
    }
    // What the last session left unfinished. A run cannot outlive the app.
    for (const s of stored.values()) {
      if (s.status !== "archived" && !existsSync(s.worktree)) {
        s.status = "failed";
        s.statusDetail = "The worktree is gone. Delete this workspace, or restore its branch by hand.";
      }
      await refreshGit(s);
    }
    for (const r of races.values()) {
      if (r.settledAt) continue;
      for (const e of r.entries) {
        if (e.state === "running" || e.state === "checking") {
          e.state = "cancelled";
          e.detail = "The app closed during this run";
        }
      }
      r.settledAt = Date.now();
      r.note = "The app closed before this race finished. Compare the work, or run the check again.";
      persist(project(r.projectId).path);
    }
    pushSnapshot();
  })();
  const originalSnapshot = handlers.snapshot;
  handlers.snapshot = async () => {
    await ready;
    return originalSnapshot(undefined);
  };

  return {
    handlers,
    dispose: () => {
      disposed = true;
      clearInterval(timer);
      if (snapshotTimer) clearTimeout(snapshotTimer);
      for (const l of live.values()) l.handle.cancel();
      for (const k of scripts.keys()) stopScriptRun(k);
      for (const t of terms.values()) t.pty.kill();
    },
  };
}

