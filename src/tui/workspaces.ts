/**
 * The sidebar's data: every registered workspace and a one-line summary of
 * each, kept live.
 *
 * The full `readOrgState` is the right read for the workspace on screen and
 * the wrong one for the other nine in the sidebar. It resolves the git root
 * with a shell-out per call, and there are a dozen calls in it. Multiplied by
 * every workspace every two seconds that is a dashboard that spends its time
 * forking git. So the summary here reads one file per workspace directly and
 * re-parses it only when its size or mtime moved. The registry already stores
 * the root, so nothing needs resolving.
 *
 * The summary is deliberately a subset of what the main view shows, derived
 * by the same rules: the ledger is the authority, spend comes from
 * delegate_end only, and a dangling start is an interrupted run. It is what
 * you need to decide which workspace to look at, not a second dashboard.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { useCallback, useEffect, useRef, useState } from "react";

import { GENESIS_PREV_HASH, type LedgerEntry } from "../core/types.js";
import { replayTaskEvents } from "../core/tasks.js";
import { listWorkspaces, registryPath, type Workspace } from "../core/workspaces.js";
import { startOfToday } from "./format.js";

const POLL_MS = 2000;

export type WorkspaceSummary = Workspace & {
  /** False when the directory has no `.ceo/ledger.jsonl`. */
  hasOrg: boolean;
  /** False when the directory itself is gone. */
  present: boolean;
  agents: number;
  spendTodayUsd: number;
  /** delegate_start entries with no delegate_end. */
  dangling: number;
  /** Queue tasks not yet settled: queued or would-be blocked. */
  waiting: number;
  /** Structural chain check only: contiguous seq and linked prevHash. */
  chainOk: boolean;
  /** ms epoch of the last ledger entry, for "active 3m ago". */
  lastEventAt: number | null;
};

function readEntries(ledger: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const line of readFileSync(ledger, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as LedgerEntry);
    } catch {
      /* verify() on the main view reports the position */
    }
  }
  return out;
}

/** One workspace's summary, read straight off its ledger file. */
export function readWorkspaceSummary(ws: Workspace): WorkspaceSummary {
  const base: WorkspaceSummary = {
    ...ws,
    hasOrg: false,
    present: existsSync(ws.path),
    agents: 0,
    spendTodayUsd: 0,
    dangling: 0,
    waiting: 0,
    chainOk: true,
    lastEventAt: null,
  };
  const ledger = path.join(ws.path, ".ceo", "ledger.jsonl");
  if (!base.present || !existsSync(ledger)) return base;

  let entries: LedgerEntry[];
  try {
    entries = readEntries(ledger);
  } catch {
    return base;
  }
  base.hasOrg = true;

  const since = startOfToday();
  const agents = new Set<string>();
  const started = new Set<string>();
  const ended = new Set<string>();
  let expectedPrev = GENESIS_PREV_HASH;

  entries.forEach((e, i) => {
    if (e.seq !== i || e.prevHash !== expectedPrev) base.chainOk = false;
    expectedPrev = e.hash;
    base.lastEventAt = Math.max(base.lastEventAt ?? 0, e.ts);
    if (e.type === "hire" && e.agent) agents.add(e.agent);
    else if (e.type === "fire" && e.agent) agents.delete(e.agent);
    else if (e.type === "delegate_start") started.add(String(e.data.id ?? ""));
    else if (e.type === "delegate_end") {
      ended.add(String(e.data.id ?? ""));
      const cost = Number(e.data.costUsd ?? 0);
      if (e.ts >= since && Number.isFinite(cost)) base.spendTodayUsd += cost;
    }
  });

  base.agents = agents.size;
  for (const id of started) if (!ended.has(id)) base.dangling++;
  for (const t of replayTaskEvents(entries).values()) {
    if (t.status === "queued") base.waiting++;
  }
  return base;
}

function sig(p: string): string {
  try {
    const s = statSync(p);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "-";
  }
}

/**
 * Registered workspaces with live summaries. Polled rather than watched:
 * the files are spread across the filesystem, one watcher per workspace is
 * a handle budget, and two seconds is fast enough for a sidebar.
 */
export function useWorkspaces(): { workspaces: WorkspaceSummary[]; refresh: () => void } {
  const [summaries, setSummaries] = useState<WorkspaceSummary[]>(() =>
    listWorkspaces().map(readWorkspaceSummary),
  );
  // Per-workspace ledger signature, plus the registry's own.
  const sigs = useRef<Map<string, string>>(new Map());
  const registrySig = useRef<string>(sig(registryPath()));

  const reload = useCallback((force: boolean) => {
    const regSig = sig(registryPath());
    const registryMoved = regSig !== registrySig.current;
    registrySig.current = regSig;

    const list = listWorkspaces();
    let changed = force || registryMoved;
    const nextSigs = new Map<string, string>();
    for (const ws of list) {
      const s = sig(path.join(ws.path, ".ceo", "ledger.jsonl"));
      nextSigs.set(ws.path, s);
      if (sigs.current.get(ws.path) !== s) changed = true;
    }
    if (nextSigs.size !== sigs.current.size) changed = true;
    sigs.current = nextSigs;
    if (!changed) return;

    // Midnight rolls the "today" window, so a forced refresh re-reads all.
    setSummaries(list.map(readWorkspaceSummary));
  }, []);

  useEffect(() => {
    const t = setInterval(() => reload(false), POLL_MS);
    return () => clearInterval(t);
  }, [reload]);

  const refresh = useCallback(() => reload(true), [reload]);
  return { workspaces: summaries, refresh };
}
