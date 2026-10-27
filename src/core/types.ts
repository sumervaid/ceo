/**
 * Shared types for the CEO plugin.
 *
 * Three state files live under `.ceo/` in the user's project root:
 *
 *   roster.json    the org: who is hired, their role brief, model, budget
 *   ledger.jsonl   append-only hash-chained record of every event
 *   audits/*.md    audit reports written by the CEO-Auditor subagent
 *
 * The ledger is the source of truth for accounting and provenance. The
 * roster is a projection: it can be rebuilt by replaying the ledger. If
 * the two ever disagree, the ledger wins.
 */

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

/**
 * Which headless agent CLI runs this agent.
 *
 *   claude   `claude -p`. Autonomy is enforced as `--allowed-tools`.
 *   codex    `codex exec`. Autonomy is enforced as the sandbox mode,
 *            read-only or workspace-write, with approvals off.
 *   gemini   `agy -p`, the Antigravity CLI. Autonomy is enforced as the
 *            mode, plan or accept-edits.
 *
 * Every control is applied by the child process, not by prompt wording.
 * See providers.ts for the exact mapping and what each one can and cannot
 * promise.
 */
export type Provider = "claude" | "codex" | "gemini";

export const PROVIDERS: Provider[] = ["claude", "codex", "gemini"];

export type AgentRecord = {
  /** Stable slug. Unique within an org. Used as the branch suffix. */
  name: string;
  /** Free-text role brief. Becomes the subagent's system prompt. */
  role: string;
  /** Which CLI runs this agent. Absent in rosters written before 0.3, and read as claude. */
  provider: Provider;
  /** Model slug passed to the provider's CLI. */
  model: string;
  /** Tool allowlist for this agent. Empty array means inherit defaults. */
  tools: string[];
  /** Hard spend cap in USD. Delegations refuse once spent >= budget. */
  budgetUsd: number;
  /** Running total, recomputed from the ledger on every read. */
  spentUsd: number;
  /** Delegation count, recomputed from the ledger. */
  delegations: number;
  /** ms epoch */
  hiredAt: number;
  /** ms epoch, null until first delegation completes */
  lastActiveAt: number | null;
  /**
   * Git isolation. When true, this agent gets its own worktree at
   * .ceo/worktrees/<name> on branch ceo/<name>, and every delegation
   * that mutates files is committed there. When false the agent works in
   * the main tree like any other subagent.
   */
  isolated: boolean;
  /** Set once a worktree has been provisioned. */
  branch: string | null;
  worktreePath: string | null;

  /**
   * Full system-prompt override. When set, it REPLACES the compiled prompt
   * entirely: role, guardrails, collaboration, autonomy and mission. The
   * escape hatch for someone who wants to write the agent from scratch and
   * accepts responsibility for everything the compilation would have added.
   */
  systemPrompt: string;

  /**
   * Hard constraints, one per line. Compiled into the prompt as things the
   * agent MUST NOT do. Kept structured rather than folded into the role
   * brief so they can be shown separately, audited, and inherited from
   * org-level defaults.
   */
  guardrails: string[];

  /**
   * How this agent works with the rest of the org: who it defers to, what
   * it hands off, when it should stop and ask. Separate from `role` because
   * role answers "what is your job" and this answers "how do you fit".
   */
  collaboration: string;

  /** See AutonomyLevel. Governs what the agent is permitted to do unasked. */
  autonomy: AutonomyLevel;

  /**
   * The chief of staff: the agent the chat talks to. At most one per org.
   * The chief's own process always runs read-only. The chief's level
   * decides what the chief may do to the org: queue work, hire, start runs,
   * fire. See `core/chat.ts`.
   */
  chief?: boolean;
};

/**
 * What an agent may do without a human in the loop.
 *
 * This is a real permission boundary, not a label. Each level maps to a
 * concrete tool allowlist and merge policy in autonomy.ts, so lowering an
 * agent's autonomy actually removes its ability to act rather than merely
 * asking it nicely in the prompt. Prompt text alone is not a control.
 */
export type AutonomyLevel =
  /** Read and report only. No file writes, no commands with side effects. */
  | "observe"
  /** May draft changes and describe them, but not apply them. */
  | "propose"
  /** May write files in its own worktree. A human merges. */
  | "execute"
  /** May write and merge to the base branch unattended. */
  | "autonomous";

export const AUTONOMY_LEVELS: AutonomyLevel[] = [
  "observe",
  "propose",
  "execute",
  "autonomous",
];

export type Roster = {
  version: 1;
  /** ms epoch of org creation */
  createdAt: number;
  agents: AgentRecord[];
};

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type LedgerEventType =
  | "org_init"
  | "hire"
  | "fire"
  | "delegate_start"
  | "delegate_end"
  | "budget_set"
  | "worktree_provision"
  | "worktree_commit"
  | "worktree_merge"
  | "audit"
  | "postmortem"
  | "note"
  | "mission_set"
  | "autonomy_set"
  | "guardrail_set"
  | "agent_config"
  | "task_add"
  | "task_update"
  | "context_add"
  | "context_update"
  | "context_remove"
  | "context_assign"
  | "context_unassign";

/** Fields common to every ledger entry, before hashing. */
export type LedgerEntryBase = {
  /** Monotonic index, starts at 0 for org_init. */
  seq: number;
  /** ms epoch */
  ts: number;
  type: LedgerEventType;
  /** Agent name when the event concerns one agent, else null. */
  agent: string | null;
  /** Free-form payload. Shape depends on `type`. */
  data: Record<string, unknown>;
  /** sha256 of the previous entry's `hash`. Genesis uses 64 zeroes. */
  prevHash: string;
};

/** A ledger entry as persisted: base fields plus its own hash. */
export type LedgerEntry = LedgerEntryBase & {
  /** sha256 over the canonical JSON of the base fields. */
  hash: string;
};

export const GENESIS_PREV_HASH = "0".repeat(64);

// ---------------------------------------------------------------------------
// Mission
// ---------------------------------------------------------------------------

/**
 * The org's shared objective. Every agent sees it in its compiled prompt,
 * which is what makes a set of independently-hired agents into a team
 * rather than a pool of unrelated contractors.
 *
 * Org-level guardrails live here too and are inherited by every agent, so a
 * rule that applies to everyone, such as "never touch production
 * credentials", is stated once rather than copied into each brief and
 * forgotten in one.
 */
export type Mission = {
  /** What the org is trying to achieve. Free text. */
  objective: string;
  /** How the org knows it is done. */
  successCriteria: string[];
  /** Guardrails applied to every agent, on top of their own. */
  orgGuardrails: string[];
  /** ms epoch of the last change. */
  setAt: number;
};

// ---------------------------------------------------------------------------
// Cost accounting
// ---------------------------------------------------------------------------

export type DelegationCost = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  /**
   * True when costUsd was computed from token counts at list prices rather
   * than reported settled by the process. Always true for codex, which
   * reports tokens and never dollars. True for a claude run that died before
   * its `result` message. Recorded on the delegate_end entry.
   */
  costIsEstimate?: boolean;
  /** Where the figure came from: "settled", "anthropic-list-price", "openai-list-price", "google-list-price". */
  costBasis?: string;
  /** Turns the session ran: one for the task, plus one per delivery of teammates' notes. */
  turns?: number;
  /** The CLI session the run used, so a later run can resume the conversation. */
  sessionId?: string | null;
  /** How the run ended. Absent on entries written before 0.4, which read as done. */
  outcome?: "done" | "failed" | "cancelled";
};

export type SpendRollup = {
  totalUsd: number;
  byAgent: Record<string, number>;
  delegationCount: number;
  windowStart: number;
  windowEnd: number;
};

// ---------------------------------------------------------------------------
// Ledger integrity
// ---------------------------------------------------------------------------

export type LedgerVerifyResult = {
  ok: boolean;
  entriesChecked: number;
  /** Index of the first bad entry, or null when the chain is intact. */
  brokenAtSeq: number | null;
  reason: string | null;
};

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type AuditFindingCategory =
  | "drift"
  | "redundancy"
  | "cost"
  | "coordination";

export type AuditFinding = {
  category: AuditFindingCategory;
  agent: string | null;
  summary: string;
  recommendation: string | null;
};

export type AuditReport = {
  ts: number;
  windowStartSeq: number;
  windowEndSeq: number;
  findings: AuditFinding[];
  reportPath: string;
};
