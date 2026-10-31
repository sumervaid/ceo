/**
 * The TUI's data layer.
 *
 * The dashboard reads `.ceo/` straight through the core modules rather
 * than talking to the MCP server. Two reasons. The server is a stdio process
 * owned by Claude Code and may not be running when someone opens the
 * dashboard. A reader also has no business holding a write channel open. Every
 * function here is read-only.
 *
 * The one wrinkle: `readRoster()` regenerates `roster.json` from the ledger
 * when the cache is missing or corrupt. That is the core's own self-heal. It
 * only ever rewrites a derived cache from the authoritative ledger, and it is
 * idempotent: the second read finds a valid file and writes nothing. It is
 * also the reason every refresh is gated on a stat signature below: without
 * that, the heal would fire the watcher, which would re-read, forever.
 */

import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { useCallback, useEffect, useRef, useState } from "react";

import { messages as readMessages, type OrgMessage } from "../core/collab.js";
import { danglingDelegations, recentDelegations } from "../core/delegation.js";
import { isGitRepo, unmergedCommits, worktreeStatus } from "../core/git.js";
import { readLedger, rollup, verify } from "../core/ledger.js";
import { current as currentMission, missionStatus, type MissionCheckStatus } from "../core/mission.js";
import {
  auditsDir,
  orgExists,
  ceoDir,
  ledgerPath,
  rosterPath,
} from "../core/paths.js";
import { readRoster } from "../core/roster.js";
import { allowanceOf, conversation, type Allowance, type Conversation } from "../core/chat.js";
import { listTasks, type Task } from "../core/tasks.js";
import type {
  AgentRecord,
  LedgerEntry,
  LedgerVerifyResult,
  Mission,
  Roster,
  SpendRollup,
} from "../core/types.js";
import { startOfToday } from "./format.js";

/** How many delegations to keep in memory for the activity feed. */
const DELEGATION_LIMIT = 200;

/** Collapse a burst of writes into one re-read. A delegation writes twice. */
const DEBOUNCE_MS = 150;

/** Backstop for watcher gaps: editors that replace inodes, network mounts. */
const POLL_MS = 2000;

export type Delegation = ReturnType<typeof recentDelegations>[number];

/** One finding lifted back out of a rendered audit report. */
export type AuditFindingLine = {
  category: string;
  agent: string | null;
  summary: string;
};

export type AuditSummary = {
  ts: number;
  seq: number;
  reportPath: string | null;
  /** False when the ledger points at a report file that is no longer there. */
  reportPresent: boolean;
  findingCount: number;
  categories: string[];
  windowStartSeq: number | null;
  windowEndSeq: number | null;
  /** Parsed back from the markdown, newest audit only. */
  findings: AuditFindingLine[];
};

export type OrgState = {
  /** False when there is no `.ceo/ledger.jsonl` in this project. */
  exists: boolean;
  roster: Roster | null;
  /**
   * The org's current objective, replayed from the ledger's mission_set
   * events. Null when nobody has set one. The dashboard says that out loud
   * rather than hiding it. An org with no objective is a pool of contractors,
   * and every agent's compiled prompt is missing a section.
   */
  mission: Mission | null;
  /** The mission's checks with the latest result of each. Empty when the mission has none. */
  missionChecks: MissionCheckStatus[];
  delegations: Delegation[];
  /** Notes agents and the person have posted, newest first. */
  messages: OrgMessage[];
  /** The work queue, replayed from task_add / task_update events. */
  tasks: Task[];
  rollup: SpendRollup | null;
  audits: AuditSummary[];
  verifyResult: LedgerVerifyResult | null;
  /** Delegations that started and never reported back. */
  dangling: number;
  ledgerLength: number;
  /** The chief of staff's current conversation, or null when the org has no chief. */
  chat: Conversation | null;
  /** The chief's allowance, or null when the org has no chief. */
  allowance: Allowance | null;
  /** Set when reading state threw, so the UI can say so instead of blanking. */
  error: string | null;
  loadedAt: number;
};

function emptyState(exists: boolean, error: string | null = null): OrgState {
  return {
    exists,
    roster: null,
    mission: null,
    missionChecks: [],
    delegations: [],
    messages: [],
    tasks: [],
    rollup: null,
    audits: [],
    verifyResult: null,
    dangling: 0,
    ledgerLength: 0,
    chat: null,
    allowance: null,
    error,
    loadedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Audits
// ---------------------------------------------------------------------------

/**
 * Recover findings from a rendered audit report.
 *
 * The ledger stores only a count and the categories touched. The prose lives
 * in the markdown. Rather than duplicate that text into the ledger, the panel
 * reads the file back. The shape it parses is the one `writeAudit` emits:
 *
 *   ## <category>
 *   ### <agent or "(org-wide)">
 *   <blank>
 *   <summary paragraph>
 *
 * Anything it does not recognise is skipped, so a hand-edited report degrades
 * to fewer lines rather than to garbage.
 */
function parseAuditReport(reportPath: string): AuditFindingLine[] {
  let raw: string;
  try {
    raw = readFileSync(reportPath, "utf8");
  } catch {
    return [];
  }

  const findings: AuditFindingLine[] = [];
  let category = "";
  let agent: string | null = null;
  let awaitingSummary = false;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ") && !trimmed.startsWith("### ")) {
      category = trimmed.slice(3).trim();
      awaitingSummary = false;
      continue;
    }
    if (trimmed.startsWith("### ")) {
      const who = trimmed.slice(4).trim();
      agent = who === "(org-wide)" ? null : who;
      awaitingSummary = true;
      continue;
    }
    if (!awaitingSummary || !trimmed) continue;
    if (trimmed.startsWith("**Recommendation:**") || trimmed.startsWith("#")) {
      awaitingSummary = false;
      continue;
    }
    findings.push({ category, agent, summary: trimmed });
    awaitingSummary = false;
  }

  return findings;
}

/**
 * Audit history, newest first. Only the newest report is opened from disk.
 * That is the only one the panel shows lines from, and audits accumulate.
 */
function readAudits(entries: LedgerEntry[]): AuditSummary[] {
  const audits: AuditSummary[] = [];

  for (const e of entries) {
    if (e.type !== "audit") continue;
    const reportPath =
      typeof e.data.reportPath === "string" ? e.data.reportPath : null;
    audits.push({
      ts: e.ts,
      seq: e.seq,
      reportPath,
      reportPresent: reportPath ? existsSync(reportPath) : false,
      findingCount: Number(e.data.findingCount ?? 0),
      categories: Array.isArray(e.data.categories)
        ? (e.data.categories as unknown[]).map(String)
        : [],
      windowStartSeq:
        typeof e.data.windowStartSeq === "number" ? e.data.windowStartSeq : null,
      windowEndSeq:
        typeof e.data.windowEndSeq === "number" ? e.data.windowEndSeq : null,
      findings: [],
    });
  }

  audits.reverse();
  const latest = audits[0];
  if (latest?.reportPath && latest.reportPresent) {
    latest.findings = parseAuditReport(latest.reportPath);
  }
  return audits;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * One consistent read of everything the dashboard shows.
 *
 * Each core call re-reads `ledger.jsonl` itself, so a refresh touches the
 * file several times. At org scale, hundreds of lines rather than millions,
 * that costs less than the machinery to avoid it. It also keeps this module
 * free of duplicated projection logic that the ledger would then have to be
 * trusted to match.
 */
export function readOrgState(cwd?: string): OrgState {
  if (!orgExists(cwd)) return emptyState(false);
  try {
    const entries = readLedger(cwd);
    const roster = readRoster(cwd);
    const chief = roster.agents.find((a) => a.chief) ?? null;
    return {
      exists: true,
      roster,
      mission: currentMission(cwd),
      missionChecks: missionStatus(cwd),
      delegations: recentDelegations(DELEGATION_LIMIT, cwd),
      messages: readMessages(cwd, 50),
      tasks: listTasks(cwd),
      rollup: rollup(startOfToday(), cwd),
      audits: readAudits(entries),
      verifyResult: verify(cwd),
      dangling: danglingDelegations(cwd).length,
      ledgerLength: entries.length,
      chat: chief ? conversation(chief.name, cwd, entries) : null,
      allowance: chief ? allowanceOf(chief, cwd, entries) : null,
      error: null,
      loadedAt: Date.now(),
    };
  } catch (e) {
    return emptyState(true, e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

export type WorktreeInfo = {
  isolated: boolean;
  branch: string | null;
  path: string | null;
  /** Uncommitted paths in the agent's worktree. */
  changed: string[];
  /** Commits on the agent's branch not yet on the base branch. */
  unmerged: string[];
  error: string | null;
};

/**
 * Git state for one agent. Shells out, so it is called on demand when the
 * detail view opens rather than on every dashboard refresh.
 */
export function readWorktreeInfo(agent: AgentRecord, cwd?: string): WorktreeInfo {
  const base: WorktreeInfo = {
    isolated: agent.isolated,
    branch: agent.branch,
    path: agent.worktreePath,
    changed: [],
    unmerged: [],
    error: null,
  };
  if (!agent.isolated) return base;
  if (!isGitRepo(cwd)) {
    return { ...base, error: "Not a git repository, so no worktree exists." };
  }
  try {
    return {
      ...base,
      changed: worktreeStatus(agent.name, cwd),
      unmerged: unmergedCommits(agent.name, cwd),
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

/**
 * Cheap fingerprint of the state files. Compared before every re-read so a
 * watcher event that reflects no actual change costs one `stat` instead of a
 * full parse plus a React re-render.
 */
function signature(cwd?: string): string {
  const parts: string[] = [];
  for (const p of [ledgerPath(cwd), rosterPath(cwd), auditsDir(cwd)]) {
    try {
      const s = statSync(p);
      parts.push(`${s.size}:${s.mtimeMs}`);
    } catch {
      parts.push("-");
    }
  }
  return parts.join("|");
}

/**
 * Live view of the org.
 *
 * Watches `.ceo/` and re-reads on change, debounced. Watchers are attached
 * to `ledger.jsonl` and `roster.json` directly and to the directory that holds
 * them. The file watchers catch appends. The directory watcher catches
 * creation and the rename-into-place that a whole-file rewrite performs, which
 * leaves a file watcher pointed at a dead inode.
 */
export function useOrgState(cwd?: string): OrgState & { refresh: () => void } {
  const [state, setState] = useState<OrgState>(() => readOrgState(cwd));
  const sigRef = useRef<string>(signature(cwd));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(
    (force: boolean) => {
      const sig = signature(cwd);
      if (!force && sig === sigRef.current) return;
      sigRef.current = sig;
      setState(readOrgState(cwd));
      // A read can itself rewrite the roster cache, as the file header
      // explains, so re-sample afterwards. Otherwise that write looks like a
      // fresh change.
      sigRef.current = signature(cwd);
    },
    [cwd],
  );

  // Switching workspace must not wait for the next poll: the screen would
  // show the previous org under the new name for up to two seconds.
  const cwdRef = useRef(cwd);
  useEffect(() => {
    if (cwdRef.current === cwd) return;
    cwdRef.current = cwd;
    reload(true);
  }, [cwd, reload]);

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      reload(false);
    }, DEBOUNCE_MS);
  }, [reload]);

  useEffect(() => {
    let watchers: FSWatcher[] = [];

    const attach = () => {
      if (watchers.length > 0) return;
      const dir = ceoDir(cwd);
      if (!existsSync(dir)) return;
      for (const target of [dir, ledgerPath(cwd), rosterPath(cwd)]) {
        if (!existsSync(target)) continue;
        try {
          const w = watch(target, () => schedule());
          // A dropped watcher, from a deleted directory or exhausted handles,
          // must not take the process down. The poll below covers the gap.
          w.on("error", () => {
            try {
              w.close();
            } catch {
              /* already closed */
            }
            watchers = watchers.filter((x) => x !== w);
          });
          watchers.push(w);
        } catch {
          /* unwatchable target. The poll still covers it */
        }
      }
    };

    attach();
    const poll = setInterval(() => {
      // Re-attaching here is what picks up an org created after launch.
      attach();
      reload(false);
    }, POLL_MS);

    return () => {
      clearInterval(poll);
      if (timerRef.current) clearTimeout(timerRef.current);
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* already closed */
        }
      }
      watchers = [];
    };
  }, [cwd, schedule, reload]);

  const refresh = useCallback(() => reload(true), [reload]);

  return { ...state, refresh };
}
