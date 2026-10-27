/**
 * The roster: who is in the org right now.
 *
 * `roster.json` is a convenience cache, not the source of truth. Spend and
 * delegation counts are always recomputed from the ledger on read, so the
 * two cannot silently drift. If roster.json is deleted, `rebuild()`
 * reconstructs it by replaying the ledger.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { append, readLedger } from "./ledger.js";
import { provisionWorktree } from "./git.js";
import { ensureCeoDirs, rosterPath } from "./paths.js";
import { inferProvider, providerFor } from "./providers.js";
import type { AgentRecord, AutonomyLevel, Provider, Roster } from "./types.js";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/** Agent names become git branch suffixes, so keep them slug-safe. */
export function validateName(name: string): string | null {
  if (!NAME_RE.test(name)) {
    return "Agent names must be lowercase alphanumeric with hyphens, 2 to 40 characters, and cannot start or end with a hyphen.";
  }
  return null;
}

function emptyRoster(): Roster {
  return { version: 1, createdAt: Date.now(), agents: [] };
}

/** Read the cached roster, then overlay live spend from the ledger. */
export function readRoster(cwd?: string): Roster {
  const p = rosterPath(cwd);
  let roster: Roster;
  if (!existsSync(p)) {
    roster = rebuild(cwd);
  } else {
    try {
      roster = JSON.parse(readFileSync(p, "utf8")) as Roster;
    } catch {
      roster = rebuild(cwd);
    }
  }
  return withLedgerState(roster, cwd);
}

/**
 * Overlay every ledger-derived field onto the cached roster.
 *
 * roster.json is a cache written at mutation time. The ledger is the
 * authority. Anything the ledger knows that the cache might have missed
 * gets recomputed here on every read: spend accrued since the last write,
 * a worktree provisioned by another process, a budget raised in a
 * different session. Without this, callers can act on a stale record.
 */
function withLedgerState(roster: Roster, cwd?: string): Roster {
  const spend: Record<string, number> = {};
  const counts: Record<string, number> = {};
  const lastActive: Record<string, number> = {};
  const worktrees: Record<string, { branch: string; worktreePath: string }> = {};
  const budgets: Record<string, number> = {};

  for (const e of readLedger(cwd)) {
    if (!e.agent) continue;
    if (e.type === "delegate_end") {
      const cost = Number(e.data.costUsd ?? 0);
      if (Number.isFinite(cost)) {
        spend[e.agent] = (spend[e.agent] ?? 0) + cost;
      }
      counts[e.agent] = (counts[e.agent] ?? 0) + 1;
      lastActive[e.agent] = Math.max(lastActive[e.agent] ?? 0, e.ts);
    } else if (e.type === "worktree_provision") {
      worktrees[e.agent] = {
        branch: String(e.data.branch ?? `ceo/${e.agent}`),
        worktreePath: String(e.data.worktreePath ?? ""),
      };
    } else if (e.type === "budget_set") {
      const b = Number(e.data.budgetUsd);
      if (Number.isFinite(b)) budgets[e.agent] = b;
    }
  }

  return {
    ...roster,
    agents: roster.agents.map((a) => {
      const wt = worktrees[a.name];
      return {
        ...a,
        provider: a.provider ?? inferProvider(a.model),
        spentUsd: spend[a.name] ?? 0,
        delegations: counts[a.name] ?? 0,
        lastActiveAt: lastActive[a.name] ?? null,
        budgetUsd: budgets[a.name] ?? a.budgetUsd,
        isolated: a.isolated || Boolean(wt),
        branch: wt?.branch ?? a.branch,
        worktreePath: wt?.worktreePath ?? a.worktreePath,
      };
    }),
  };
}

function persist(roster: Roster, cwd?: string): void {
  ensureCeoDirs(cwd);
  writeFileSync(rosterPath(cwd), JSON.stringify(roster, null, 2) + "\n", "utf8");
}

/**
 * Replay the ledger to reconstruct the roster from scratch. Used when
 * roster.json is missing or corrupt, and as the authority when the two
 * disagree.
 */
export function rebuild(cwd?: string): Roster {
  const roster = emptyRoster();
  for (const e of readLedger(cwd)) {
    if (e.type === "org_init") {
      roster.createdAt = e.ts;
    } else if (e.type === "hire" && e.agent) {
      const d = e.data as Partial<AgentRecord>;
      roster.agents = roster.agents.filter((a) => a.name !== e.agent);
      const model = String(d.model ?? "claude-sonnet-5");
      roster.agents.push({
        name: e.agent,
        role: String(d.role ?? ""),
        // Hires written before providers existed carry only a model.
        provider: (d.provider as Provider | undefined) ?? inferProvider(model),
        model,
        tools: Array.isArray(d.tools) ? (d.tools as string[]) : [],
        budgetUsd: Number(d.budgetUsd ?? 5),
        spentUsd: 0,
        delegations: 0,
        hiredAt: e.ts,
        lastActiveAt: null,
        isolated: Boolean(d.isolated ?? false),
        branch: (d.branch as string | null) ?? null,
        worktreePath: (d.worktreePath as string | null) ?? null,
        systemPrompt: String(d.systemPrompt ?? ""),
        guardrails: Array.isArray(d.guardrails) ? (d.guardrails as string[]) : [],
        collaboration: String(d.collaboration ?? ""),
        autonomy: (d.autonomy as AutonomyLevel) ?? "execute",
        ...(d.chief ? { chief: true } : {}),
      });
    } else if (e.type === "fire" && e.agent) {
      roster.agents = roster.agents.filter((a) => a.name !== e.agent);
    } else if (e.type === "budget_set" && e.agent) {
      const a = roster.agents.find((x) => x.name === e.agent);
      if (a) a.budgetUsd = Number(e.data.budgetUsd ?? a.budgetUsd);
    } else if (e.type === "agent_config" && e.agent) {
      const a = roster.agents.find((x) => x.name === e.agent);
      if (a) {
        const d = e.data as Partial<AgentRecord>;
        if (d.role !== undefined) a.role = String(d.role);
        if (d.model !== undefined) a.model = String(d.model);
        if (d.provider !== undefined) a.provider = d.provider as Provider;
        if (d.systemPrompt !== undefined) a.systemPrompt = String(d.systemPrompt);
        if (d.collaboration !== undefined) a.collaboration = String(d.collaboration);
        if (Array.isArray(d.guardrails)) a.guardrails = d.guardrails as string[];
        if (d.autonomy !== undefined) a.autonomy = d.autonomy as AutonomyLevel;
      }
    } else if (e.type === "autonomy_set" && e.agent) {
      const a = roster.agents.find((x) => x.name === e.agent);
      if (a) a.autonomy = (e.data.autonomy as AutonomyLevel) ?? a.autonomy;
    } else if (e.type === "worktree_provision" && e.agent) {
      const a = roster.agents.find((x) => x.name === e.agent);
      if (a) {
        a.isolated = true;
        a.branch = String(e.data.branch ?? `ceo/${e.agent}`);
        a.worktreePath = String(e.data.worktreePath ?? "");
      }
    }
  }
  persist(roster, cwd);
  return roster;
}

export function findAgent(name: string, cwd?: string): AgentRecord | null {
  return readRoster(cwd).agents.find((a) => a.name === name) ?? null;
}

/** The org's chief of staff, or null when none has been hired. */
export function findChief(cwd?: string): AgentRecord | null {
  return readRoster(cwd).agents.find((a) => a.chief) ?? null;
}

/** Add an agent. Writes the ledger entry first, then the cache. */
export function hire(
  input: {
    name: string;
    role: string;
    /** Defaults to the provider the model belongs to, else claude. */
    provider?: Provider;
    /** Defaults to the provider's default model. */
    model?: string;
    tools?: string[];
    budgetUsd?: number;
    isolated?: boolean;
    systemPrompt?: string;
    guardrails?: string[];
    collaboration?: string;
    autonomy?: AutonomyLevel;
    /** Hire the chief of staff. Refused when the org already has one. */
    chief?: boolean;
    /** The agent that made the hire, when an agent did. Recorded on the hire event. */
    by?: string | null;
  },
  cwd?: string,
): AgentRecord {
  const nameErr = validateName(input.name);
  if (nameErr) throw new Error(nameErr);
  if (!input.role || input.role.trim().length < 10) {
    throw new Error(
      "Role brief must be at least 10 characters. A vague brief is the most common cause of poor agent output.",
    );
  }
  if (findAgent(input.name, cwd)) {
    throw new Error(
      `Agent "${input.name}" is already in the org. Fire it first, or pick another name.`,
    );
  }

  if (input.chief) {
    const sitting = readRoster(cwd).agents.find((a) => a.chief);
    if (sitting) throw new Error(`The org already has a chief of staff: ${sitting.name}.`);
  }

  const provider: Provider = input.provider ?? inferProvider(input.model);
  const record: AgentRecord = {
    name: input.name,
    role: input.role.trim(),
    provider,
    model: input.model ?? providerFor(provider).defaultModel(),
    tools: input.tools ?? [],
    budgetUsd: input.budgetUsd ?? 5,
    spentUsd: 0,
    delegations: 0,
    hiredAt: Date.now(),
    lastActiveAt: null,
    isolated: input.isolated ?? false,
    branch: null,
    worktreePath: null,
    systemPrompt: input.systemPrompt?.trim() ?? "",
    guardrails: (input.guardrails ?? []).map((g) => g.trim()).filter(Boolean),
    collaboration: input.collaboration?.trim() ?? "",
    // execute is the default because it is the level most people actually
    // want and the one that still keeps a human in the merge path. Defaulting
    // to autonomous would hand out unattended merge rights by omission.
    autonomy: input.autonomy ?? "execute",
    ...(input.chief ? { chief: true } : {}),
  };

  append("hire", record.name, {
    role: record.role,
    provider: record.provider,
    model: record.model,
    tools: record.tools,
    budgetUsd: record.budgetUsd,
    isolated: record.isolated,
    systemPrompt: record.systemPrompt,
    guardrails: record.guardrails,
    collaboration: record.collaboration,
    autonomy: record.autonomy,
    ...(record.chief ? { chief: true } : {}),
    ...(input.by ? { by: input.by } : {}),
  }, cwd);

  const roster = readRoster(cwd);
  roster.agents.push(record);
  persist(roster, cwd);

  // Provision here rather than leaving it to the caller. An agent marked
  // isolated but without a worktree is a silently broken state: delegation
  // only commits when a worktree exists, so that agent's file changes land
  // nowhere and disappear without an error. Making hire() responsible means
  // `isolated` always means the same thing everywhere.
  if (record.isolated) {
    try {
      const { branch, worktreePath } = provisionWorktree(record.name, cwd);
      record.branch = branch;
      record.worktreePath = worktreePath;
    } catch (e) {
      // Roll back to a coherent state rather than leave a half-isolated
      // agent behind. The hire event stays in the ledger because it did
      // happen, but the agent leaves the roster so it never shows a lie.
      fire(
        record.name,
        `isolation failed: ${e instanceof Error ? e.message : String(e)}`,
        cwd,
      );
      throw e;
    }
  }

  return record;
}

export function fire(name: string, reason: string | null, cwd?: string, by?: string | null): void {
  const agent = findAgent(name, cwd);
  if (!agent) throw new Error(`No agent named "${name}" in the org.`);
  append("fire", name, { reason: reason ?? null, ...(by ? { by } : {}) }, cwd);
  const roster = readRoster(cwd);
  roster.agents = roster.agents.filter((a) => a.name !== name);
  persist(roster, cwd);
}

export function setBudget(name: string, budgetUsd: number, cwd?: string, by?: string | null): void {
  const agent = findAgent(name, cwd);
  if (!agent) throw new Error(`No agent named "${name}" in the org.`);
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) {
    throw new Error("Budget must be a non-negative number.");
  }
  append("budget_set", name, { budgetUsd, previousUsd: agent.budgetUsd, ...(by ? { by } : {}) }, cwd);
  const roster = readRoster(cwd);
  const a = roster.agents.find((x) => x.name === name);
  if (a) a.budgetUsd = budgetUsd;
  persist(roster, cwd);
}

/**
 * Budget gate. Called before a delegation is dispatched. Returns a reason
 * string when the delegation should be refused, or null when it may run.
 */
export function budgetCheck(name: string, cwd?: string): string | null {
  const agent = findAgent(name, cwd);
  if (!agent) return `No agent named "${name}" in the org.`;
  // The chief of staff's replies have no cap. Each one answers a message the
  // operator typed. The chief's budget field is the allowance the chief gives
  // other agents, not a limit on the chief. See core/chat.ts.
  if (agent.chief) return null;
  if (agent.budgetUsd > 0 && agent.spentUsd >= agent.budgetUsd) {
    return `Agent "${name}" has spent $${agent.spentUsd.toFixed(4)} of its $${agent.budgetUsd.toFixed(2)} budget. Raise the budget with /budget ${name} <amount> or fire it.`;
  }
  return null;
}

/** Mark the roster cache stale-safe after external ledger edits. */
export function refresh(cwd?: string): Roster {
  return rebuild(cwd);
}

/**
 * Change an agent's configuration after hiring. Appends an `agent_config`
 * event rather than rewriting the hire event, so the ledger keeps the
 * history of what the agent was configured as at any point. That is what
 * lets an audit six weeks later ask "what was this agent permitted to do
 * when it produced that."
 */
export function reconfigure(
  name: string,
  changes: Partial<
    Pick<
      AgentRecord,
      "role" | "provider" | "model" | "systemPrompt" | "guardrails" | "collaboration" | "autonomy"
    >
  >,
  cwd?: string,
): AgentRecord {
  const agent = findAgent(name, cwd);
  if (!agent) throw new Error(`No agent named "${name}" in the org.`);
  if (Object.keys(changes).length === 0) return agent;

  append("agent_config", name, changes as Record<string, unknown>, cwd);

  const roster = readRoster(cwd);
  const a = roster.agents.find((x) => x.name === name);
  if (a) Object.assign(a, changes);
  persist(roster, cwd);
  return findAgent(name, cwd)!;
}

/** Set an agent's autonomy level, recorded as its own event for auditing. */
export function setAutonomy(
  name: string,
  autonomy: AutonomyLevel,
  cwd?: string,
): AgentRecord {
  const agent = findAgent(name, cwd);
  if (!agent) throw new Error(`No agent named "${name}" in the org.`);
  append("autonomy_set", name, { autonomy, previous: agent.autonomy }, cwd);
  const roster = readRoster(cwd);
  const a = roster.agents.find((x) => x.name === name);
  if (a) a.autonomy = autonomy;
  persist(roster, cwd);
  return findAgent(name, cwd)!;
}
