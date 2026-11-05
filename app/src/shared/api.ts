/** The contract between the window and the engine. Everything crosses as JSON. */

export type Provider = "claude" | "codex" | "gemini";
export const PROVIDERS: Provider[] = ["claude", "codex", "gemini"];
export type Mode = "build" | "plan";

export type ProjectConfig = {
  setup: string;
  run: string;
  archive: string;
  /** The command that says whether a workspace's work is right. Race uses it to pick a winner. */
  check: string;
  /** Files outside git to copy into a new workspace, such as .env. */
  copy: string[];
  /** Guidance every agent in this project receives. */
  instructions: string;
  baseBranch: string;
};

export type Project = {
  id: string;
  path: string;
  name: string;
  isGit: boolean;
  hasCommits: boolean;
  baseRef: string;
  hasRemote: boolean;
  config: ProjectConfig;
};

export type ChatTab = {
  id: string;
  title: string;
  provider: Provider;
  model: string;
  mode: Mode;
  sessionId: string | null;
};

export type LineComment = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  side: "old" | "new";
  text: string;
  excerpt: string;
  createdAt: number;
  sentAt: number | null;
};

export type Todo = { id: string; text: string; done: boolean };

export type WorkspaceStatus = "creating" | "setup" | "ready" | "failed" | "archiving" | "archived";
export type Activity = "idle" | "running" | "queued" | "unread" | "error";

export type GitSummary = {
  added: number;
  removed: number;
  files: number;
  ahead: number;
  behind: number;
  dirty: boolean;
  conflicts: string[];
};

export type PullRequest = {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string;
};

export type Workspace = {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  branch: string;
  baseRef: string;
  pushRef: string | null;
  worktree: string;
  status: WorkspaceStatus;
  statusDetail: string | null;
  port: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  mergedAt: number | null;
  raceId: string | null;
  budgetUsd: number;
  spentUsd: number;
  tabs: ChatTab[];
  todos: Todo[];
  comments: LineComment[];
  viewed: Record<string, string>;
  pr: PullRequest | null;
  git: GitSummary;
  activity: Activity;
  runningTabs: string[];
  queued: number;
  scripts: { run: boolean; setup: boolean; archive: boolean; check: boolean };
  checkResult: { pass: boolean; detail: string; at: number } | null;
};

export type ChatAttachment =
  | { kind: "comment"; comment: LineComment }
  | { kind: "file"; path: string }
  | { kind: "text"; label: string; text: string };

export type ChatItem =
  | { id: string; ts: number; kind: "user"; text: string; attachments: ChatAttachment[]; mode: Mode }
  | { id: string; ts: number; kind: "assistant"; text: string }
  | { id: string; ts: number; kind: "tool"; name: string; summary: string }
  | { id: string; ts: number; kind: "denied"; tool: string }
  | { id: string; ts: number; kind: "system"; text: string }
  | {
      id: string;
      ts: number;
      kind: "result";
      ok: boolean;
      provider: Provider;
      model: string;
      costUsd: number;
      estimate: boolean;
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      error: string | null;
      cancelled: boolean;
      retryAt: number | null;
    };

export type DiffLine = { t: "ctx" | "add" | "del"; o: number | null; n: number | null; s: string };
export type DiffHunk = { header: string; lines: DiffLine[] };
export type DiffFile = {
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  added: number;
  removed: number;
  binary: boolean;
  tooLarge: boolean;
  hash: string;
  hunks: DiffHunk[];
};
export type Commit = { sha: string; short: string; subject: string; author: string; ts: number };
export type DiffResult = { files: DiffFile[]; commits: Commit[]; truncated: boolean };

export type FileEntry = { path: string; changed: boolean };
export type SearchHit = { path: string; line: number; text: string };

export type CheckRun = {
  name: string;
  state: "pass" | "fail" | "running" | "skipped";
  url: string | null;
  detail: string | null;
};
export type ReviewNote = { id: string; author: string; body: string; path: string | null; line: number | null; url: string | null };
export type NextAction = "wait" | "resolve-conflicts" | "update" | "create-pr" | "fix-checks" | "respond" | "merge" | "merge-local" | "archive" | "start";
export type ChecksReport = {
  ghReady: boolean;
  ghReason: string | null;
  git: GitSummary;
  pr: PullRequest | null;
  runs: CheckRun[];
  reviews: ReviewNote[];
  next: NextAction;
  nextLabel: string;
  nextDetail: string;
};

export type Readiness = {
  provider: Provider;
  binary: string;
  installed: boolean;
  version: string | null;
  signedIn: boolean;
  ready: boolean;
  metered: boolean;
  account: string;
  fix: string[];
  /** The one command that gets this provider going, with no commentary. */
  fixCommand: string;
  models: string[];
  defaultModel: string;
  isStub: boolean;
};

export type Plan = "free" | "trial" | "pro";
export type LicenseState = {
  plan: Plan;
  email: string | null;
  expiresAt: number | null;
  trialEndsAt: number | null;
  trialDaysLeft: number;
  limits: { activeWorkspaces: number | null; race: boolean; planner: boolean; insights: boolean; exportData: boolean };
  checkoutUrl: string;
  error: string | null;
};

export type Settings = {
  theme: "system" | "light" | "dark";
  sound: boolean;
  notifications: boolean;
  defaultProvider: Provider;
  defaultModels: Partial<Record<Provider, string>>;
  defaultBudgetUsd: number;
  teamNotes: boolean;
  editor: string;
  onboarded: boolean;
};

export type RaceEntry = {
  workspaceId: string;
  provider: Provider;
  model: string;
  state: "running" | "checking" | "passed" | "failed" | "no-check" | "cancelled";
  /** Whether the agent's run itself finished. A run that failed has nothing for the check to judge. */
  runOk: boolean;
  detail: string;
  costUsd: number;
  durationMs: number;
  added: number;
  removed: number;
};
export type Race = {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  check: string;
  createdAt: number;
  settledAt: number | null;
  winnerId: string | null;
  kept: boolean;
  note: string | null;
  entries: RaceEntry[];
};

export type PlannedTask = { title: string; prompt: string; provider: Provider; selected: boolean };
export type PlanDraft = { tasks: PlannedTask[]; rationale: string; costUsd: number };

export type SpendRow = { key: string; label: string; costUsd: number; runs: number; estimate: boolean };
export type SpendReport = {
  totalUsd: number;
  estimatedUsd: number;
  runs: number;
  byDay: Array<{ day: string; costUsd: number }>;
  byProvider: SpendRow[];
  byWorkspace: SpendRow[];
  ledger: { ok: boolean; entries: number; detail: string };
  recent: Array<{ id: string; ts: number; workspace: string; task: string; provider: string; model: string; costUsd: number; estimate: boolean; outcome: string; durationMs: number }>;
};

export type InsightRow = { kind: string; provider: string; model: string; runs: number; passes: number; passRate: number; costPerPass: number | null; source: string };
export type Insights = { rows: InsightRow[]; races: number; decided: number };

export type RecordEntry = { seq: number; ts: number; type: string; title: string; detail: string; costUsd: number | null; hash: string };

export type ListItem = { value: string; title: string; detail: string };

export type Snapshot = { projects: Project[]; workspaces: Workspace[]; races: Race[] };

export type NewWorkspace = {
  projectId: string;
  title: string;
  start: { kind: "base" } | { kind: "branch"; ref: string } | { kind: "pr"; number: number } | { kind: "issue"; number: number };
  prompt?: string;
  provider: Provider;
  model: string;
  mode: Mode;
  budgetUsd?: number;
};

export type EngineEvent =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "chat"; workspaceId: string; tabId: string; item: ChatItem }
  | { type: "chat-delta"; workspaceId: string; tabId: string; itemId: string; text: string }
  | { type: "terminal"; id: string; data: string }
  | { type: "terminal-exit"; id: string; code: number }
  | { type: "script"; workspaceId: string; kind: ScriptKind; data: string }
  | { type: "script-state"; workspaceId: string; kind: ScriptKind; running: boolean; code: number | null; url: string | null }
  | { type: "notify"; title: string; body: string; workspaceId: string | null; level: "done" | "failed" | "info"; sound: boolean }
  | { type: "license"; license: LicenseState };

export type ScriptKind = "setup" | "run" | "archive" | "check";
export type ScriptState = { running: boolean; code: number | null; url: string | null; log: string };

/** Every call the window can make. The engine checks each one. */
export type Api = {
  snapshot(): Snapshot;
  readiness(p: { refresh?: boolean }): Readiness[];
  settings(): Settings;
  saveSettings(p: Partial<Settings>): Settings;
  license(): LicenseState;
  activateLicense(p: { key: string }): LicenseState;
  deactivateLicense(): LicenseState;
  addProject(p: { path: string }): Project;
  cloneProject(p: { url: string; into: string }): Project;
  createFirstCommit(p: { projectId: string }): Project;
  removeProject(p: { projectId: string }): void;
  saveProjectConfig(p: { projectId: string; config: Partial<ProjectConfig> }): Project;
  branches(p: { projectId: string }): ListItem[];
  pullRequests(p: { projectId: string }): ListItem[];
  issues(p: { projectId: string }): ListItem[];
  createWorkspace(p: NewWorkspace): Workspace;
  renameWorkspace(p: { id: string; title: string }): void;
  archiveWorkspace(p: { id: string }): void;
  /** Brings back an archived workspace, or rebuilds the worktree of one that lost it. */
  restoreWorkspace(p: { id: string }): void;
  deleteWorkspace(p: { id: string }): void;
  setBudget(p: { id: string; budgetUsd: number }): void;
  markRead(p: { id: string }): void;
  chatHistory(p: { id: string; tabId: string }): ChatItem[];
  newTab(p: { id: string; provider: Provider; model: string; mode: Mode }): ChatTab;
  closeTab(p: { id: string; tabId: string }): void;
  updateTab(p: { id: string; tabId: string; provider?: Provider; model?: string; mode?: Mode; title?: string }): void;
  send(p: { id: string; tabId: string; text: string; attachments: ChatAttachment[] }): void;
  stop(p: { id: string; tabId: string }): void;
  diff(p: { id: string; commit?: string | null }): DiffResult;
  markViewed(p: { id: string; path: string; hash: string | null }): void;
  discardFile(p: { id: string; path: string; oldPath?: string | null }): void;
  addComment(p: { id: string; path: string; startLine: number; endLine: number; side: "old" | "new"; text: string; excerpt: string }): LineComment;
  deleteComment(p: { id: string; commentId: string }): void;
  files(p: { id: string }): FileEntry[];
  /** Saves a dropped or pasted file under .context, which git never sees. */
  attachFile(p: { id: string; name: string; base64: string }): { path: string };
  readFile(p: { id: string; path: string }): { text: string | null; binary: boolean; tooLarge: boolean };
  searchFiles(p: { id: string; query: string }): SearchHit[];
  checks(p: { id: string }): ChecksReport;
  pushChanges(p: { id: string }): void;
  failureLog(p: { id: string; name: string }): string;
  draftPr(p: { id: string }): { title: string; body: string; base: string };
  createPr(p: { id: string; title: string; body: string; draft: boolean }): PullRequest;
  mergePr(p: { id: string; method: "squash" | "merge" | "rebase" }): void;
  mergeLocal(p: { id: string }): { conflicts: string[] };
  updateFromBase(p: { id: string }): { conflicts: string[] };
  commit(p: { id: string; message: string }): void;
  setTodos(p: { id: string; todos: Todo[] }): void;
  scriptState(p: { id: string; kind: ScriptKind }): ScriptState;
  runScript(p: { id: string; kind: ScriptKind }): void;
  stopScript(p: { id: string; kind: ScriptKind }): void;
  terminalOpen(p: { id: string; cols: number; rows: number }): { terminalId: string; backlog: string };
  terminalInput(p: { terminalId: string; data: string }): void;
  terminalResize(p: { terminalId: string; cols: number; rows: number }): void;
  terminalClose(p: { terminalId: string }): void;
  startRace(p: { projectId: string; title: string; prompt: string; check: string; arms: Array<{ provider: Provider; model: string }>; budgetUsd?: number }): Race;
  rerunRaceChecks(p: { raceId: string }): void;
  keepWinner(p: { raceId: string; workspaceId: string }): void;
  draftPlan(p: { projectId: string; goal: string; provider: Provider }): PlanDraft;
  launchPlan(p: { projectId: string; tasks: PlannedTask[]; model: Partial<Record<Provider, string>> }): Workspace[];
  spend(p: { projectId: string | null; days: number }): SpendReport;
  insights(p: { projectId: string | null }): Insights;
  exportLedger(p: { projectId: string; to: string }): { path: string; entries: number };
  record(p: { id: string }): { entries: RecordEntry[]; ok: boolean; detail: string };
};

export type Method = keyof Api;
export type ParamsOf<M extends Method> = Parameters<Api[M]> extends [infer P] ? P : undefined;
export type ResultOf<M extends Method> = ReturnType<Api[M]>;

/** Calls the window process answers itself, because they need the desktop. */
export type DesktopApi = {
  pickFolder(): Promise<string | null>;
  pickSavePath(name: string): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  openPath(path: string, app?: string): Promise<string>;
  copy(text: string): Promise<void>;
  setBadge(count: number): Promise<void>;
  notify(title: string, body: string, workspaceId: string | null): Promise<void>;
  version(): Promise<string>;
  checkForUpdates(): Promise<{ state: string; detail: string }>;
  revealLogs(): Promise<void>;
};

export type Bridge = {
  call<M extends Method>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>;
  on(cb: (e: EngineEvent) => void): () => void;
  onOpen(cb: (workspaceId: string) => void): () => void;
  onMenu(cb: (action: string) => void): () => void;
  desktop: DesktopApi;
  platform: string;
};
