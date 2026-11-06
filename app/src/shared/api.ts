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
  /** Idle team agents pick up their next queued task without being asked. */
  autoDispatch: boolean;
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
  limits: { activeWorkspaces: number | null; race: boolean; planner: boolean; insights: boolean; exportData: boolean; teamAgents: number | null; chief: boolean; companies: boolean; attempts: boolean };
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

export type Snapshot = { projects: Project[]; workspaces: Workspace[]; races: Race[]; org: Record<string, OrgSummary> };

// -- the org: chief of staff, team, tasks, approvals --------------------------

export type Level = "observe" | "propose" | "execute" | "autonomous";
export const LEVELS: Level[] = ["observe", "propose", "execute", "autonomous"];
export type Sandbox = "local" | "docker" | "ssh";

/** One line of what a headless agent did, in order. */
export type RunLine = { kind: "text" | "tool" | "denied" | "turn" | "error"; text: string };
export type RunVia = "delegate" | "chief" | "task" | "broadcast" | "dispatch";
export type RunStatus = "running" | "done" | "failed" | "cancelled" | "waiting";
export type OrgRun = {
  key: string;
  projectId: string;
  agent: string;
  task: string;
  taskId: string | null;
  attemptId: string | null;
  arm: string | null;
  via: RunVia;
  status: RunStatus;
  provider: Provider | null;
  model: string | null;
  workdir: string | null;
  startedAt: number;
  finishedAt: number | null;
  costUsd: number;
  estimate: boolean;
  error: string | null;
  denials: string[];
  retryAt: number | null;
  delegationId: string | null;
  lines: RunLine[];
};

export type Agent = {
  name: string;
  role: string;
  provider: Provider;
  model: string;
  level: Level;
  /** What the level lets the agent do, in a few words. */
  levelLabel: string;
  tools: string[];
  budgetUsd: number;
  spentUsd: number;
  runs: number;
  hiredAt: number;
  lastActiveAt: number | null;
  isolated: boolean;
  branch: string | null;
  chief: boolean;
  /** Set for the agent behind a workspace, whose work happens in that workspace's chat. */
  workspaceId: string | null;
  guardrails: string[];
  collaboration: string;
  state: "idle" | "running" | "waiting" | "over-budget";
  /** The task on screen while it runs. */
  doing: string | null;
  queued: number;
  docket: number;
};

export type Attempt = {
  id: string;
  agent: string;
  arm: string;
  branch: string | null;
  outcome: string | null;
  pass: boolean | null;
  score: number | null;
  costUsd: number;
  promoted: boolean;
  startedAt: number;
  endedAt: number | null;
};
export type TaskState = "queued" | "running" | "verifying" | "done" | "failed" | "cancelled" | "blocked";
export type TaskPriority = "high" | "normal" | "low";
export type Task = {
  id: string;
  title: string;
  assignee: string | null;
  priority: TaskPriority;
  status: TaskState;
  blockedReason: string | null;
  createdAt: number;
  updatedAt: number;
  costUsd: number | null;
  note: string | null;
  requestedBy: string | null;
  autoStart: boolean;
  provider: Provider | null;
  checks: string[];
  samples: number;
  kind: string | null;
  sandbox: Sandbox | null;
  attempts: Attempt[];
};
export type NewTask = {
  projectId: string;
  title: string;
  assignee: string | null;
  priority?: TaskPriority;
  provider?: Provider | null;
  /** One check per line: a shell command, `judge: <rubric>` or `everval: <collection>`. */
  checks?: string[];
  samples?: number;
  sandbox?: Sandbox | null;
  /** Start it now rather than leave it queued. */
  run?: boolean;
};

export type ChiefAction = { kind: "hire" | "delegate" | "handoff" | "fire" | "post" | "ask" | "budget"; agent: string; text: string; taskId: string | null; provider: Provider | null };
export type ChiefTurn = {
  id: string;
  ts: number;
  message: string;
  reply: string;
  status: "running" | "done" | "failed" | "cancelled";
  provider: Provider | null;
  model: string | null;
  costUsd: number;
  estimate: boolean;
  actions: ChiefAction[];
};
export type Chief = {
  name: string;
  provider: Provider;
  model: string;
  level: Level;
  /** What the chief may do to the team at this level, in words. */
  levelLabel: string;
  may: { queue: boolean; hire: boolean; start: boolean; fire: boolean };
  allowance: { totalUsd: number; givenUsd: number; leftUsd: number };
  turns: ChiefTurn[];
  chiefCostUsd: number;
  teamCostUsd: number;
  teamRuns: number;
  /** The run behind the reply being written now. */
  replying: string | null;
};

export type Approval = {
  id: string;
  action: string;
  agent: string | null;
  taskId: string | null;
  branch: string | null;
  summary: string;
  ts: number;
  evidence: string[];
  pass: boolean | null;
};
export type TeamNote = { seq: number; ts: number; from: string; to: string; text: string; ask: boolean };
export type MissionCheck = { name: string; spec: string; state: string; detail: string | null; at: number | null };
export type Mission = { objective: string; criteria: string[]; guardrails: string[]; checks: MissionCheck[]; setAt: number };
export type DocketItem = { id: string; kind: string; group: string; title: string; source: string; tokens: string; agents: string[]; addedAt: number; addedBy: string };

export type Org = {
  projectId: string;
  exists: boolean;
  agents: Agent[];
  chief: Chief | null;
  tasks: Task[];
  approvals: Approval[];
  autoMerge: boolean;
  notes: TeamNote[];
  mission: Mission | null;
  docket: DocketItem[];
  runs: OrgRun[];
  ledger: { ok: boolean; entries: number; detail: string };
  spentTodayUsd: number;
  error: string | null;
};
export type OrgSummary = { agents: number; running: number; approvals: number; queued: number; hasChief: boolean; replying: boolean };

export type NewAgent = {
  projectId: string;
  name: string;
  role: string;
  provider: Provider;
  model: string;
  level: Level;
  budgetUsd: number;
  isolated: boolean;
  guardrails: string[];
  collaboration: string;
};
export type AgentChange = { role?: string; provider?: Provider; model?: string; level?: Level; budgetUsd?: number; guardrails?: string[]; collaboration?: string };
export type AgentDetail = {
  agent: Agent;
  prompt: string;
  runs: Array<{ id: string; ts: number; task: string; ok: boolean | null; costUsd: number; estimate: boolean; durationMs: number; provider: string; model: string; denials: number; output: string | null }>;
  unmerged: string[];
  worktree: string | null;
  docket: DocketItem[];
};
export type RoleTemplate = { name: string; role: string; level: Level; budgetUsd: number; isolated: boolean };
export type CompanySeat = { name: string; brief: string; provider: Provider; model: string; level: Level; budgetUsd: number; isolated: boolean; movedFrom: Provider | null; skip: string | null };
export type Company = { id: string; title: string; tagline: string; seats: number };
export type CompanyPreview = { id: string; title: string; seats: CompanySeat[]; totalCapUsd: number; chief: { hire: boolean; name: string; provider: Provider }; note: string | null };
export type SuggestedAgent = { name: string; role: string; provider: Provider; model: string; budgetUsd: number; isolated: boolean; level: Level; why: string };
export type Suggestion = { agents: SuggestedAgent[]; summary: string[] };
export type Integrations = {
  github: { ready: boolean; detail: string };
  huggingface: { ready: boolean; detail: string };
  skills: Array<{ name: string; source: string; description: string; ready: boolean }>;
  sandboxes: Array<{ kind: Sandbox; ready: boolean; detail: string }>;
};

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
  | { type: "license"; license: LicenseState }
  | { type: "org"; projectId: string }
  | { type: "org-run"; run: OrgRun }
  | { type: "org-line"; projectId: string; key: string; line: RunLine };

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

  org(p: { projectId: string }): Org;
  agentDetail(p: { projectId: string; name: string }): AgentDetail;
  roleTemplates(): RoleTemplate[];
  hireAgent(p: NewAgent): Agent;
  updateAgent(p: { projectId: string; name: string; change: AgentChange }): Agent;
  isolateAgent(p: { projectId: string; name: string }): Agent;
  fireAgent(p: { projectId: string; name: string; reason: string | null }): void;
  mergeAgent(p: { projectId: string; name: string }): { ok: boolean; message: string; conflicts: string[] };
  delegate(p: { projectId: string; agent: string; task: string }): OrgRun | null;
  broadcast(p: { projectId: string; task: string; agents: string[] }): { started: string[]; queued: string[] };
  cancelRun(p: { projectId: string; key: string }): void;
  dismissRun(p: { projectId: string; key: string }): void;
  addTask(p: NewTask): Task;
  editTask(p: { projectId: string; id: string; title?: string; assignee?: string | null; priority?: TaskPriority }): Task;
  runTask(p: { projectId: string; id: string }): void;
  cancelTask(p: { projectId: string; id: string }): void;
  requeueTask(p: { projectId: string; id: string }): void;
  dispatch(p: { projectId: string }): { started: number };
  routeTask(p: { projectId: string; title: string }): Array<{ provider: Provider; model: string; why: string }>;
  hireChief(p: { projectId: string; provider?: Provider }): Chief;
  chiefSend(p: { projectId: string; text: string }): void;
  chiefStop(p: { projectId: string }): void;
  chiefNew(p: { projectId: string }): void;
  chiefSet(p: { projectId: string; provider?: Provider; model?: string; level?: Level; allowanceUsd?: number }): Chief;
  decide(p: { projectId: string; id: string; approve: boolean }): { ok: boolean; message: string };
  setAutoMerge(p: { projectId: string; on: boolean }): void;
  setMission(p: { projectId: string; objective: string; criteria: string[]; guardrails: string[]; checks: string[] }): Mission;
  checkMission(p: { projectId: string }): Mission;
  postNote(p: { projectId: string; to: string; text: string }): void;
  addDocket(p: { projectId: string; input: string; agents: string[] }): DocketItem;
  removeDocket(p: { projectId: string; id: string }): void;
  shareDocket(p: { projectId: string; id: string; agent: string; give: boolean }): void;
  refreshDocket(p: { projectId: string; id: string }): DocketItem;
  companies(): Company[];
  previewCompany(p: { projectId: string; id: string; scale: number }): CompanyPreview;
  hireCompany(p: { projectId: string; id: string; scale: number }): { hired: string[]; message: string };
  suggestTeam(p: { projectId: string }): Suggestion;
  integrations(p: { projectId: string }): Integrations;
  verifyLedger(p: { projectId: string }): { ok: boolean; entries: number; detail: string };
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
