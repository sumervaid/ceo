/**
 * Append-only, hash-chained ledger.
 *
 * Every state change in an org appends one line to `.ceo/ledger.jsonl`,
 * whether a hire, a fire, a delegation, an audit or a git commit. Each entry carries the hash
 * of the previous entry, so any edit or deletion in the middle of the file
 * breaks the chain and `verify()` reports exactly where.
 *
 * Why bother: the ledger doubles as the cost-accounting record and the
 * provenance record. If an agent produced a claim that ended up in a
 * deliverable, the ledger is what lets you trace which agent, on which
 * prompt, at what cost, against which commit. Tamper-evidence keeps that
 * chain trustworthy when the file is shared across a team via git.
 *
 * Concurrency: `append()` holds an exclusive file lock, from lock.ts, across
 * read-tail-then-write. This is required, not belt-and-braces. Appends are
 * individually atomic under O_APPEND, so lines never interleave. But two
 * unsynchronized writers can each read the same tail, each derive the same
 * `prevHash`, and each append, forking the chain. `verify()` would catch
 * the fork, but a ledger that needs repairing is not one you can trust.
 * The lock is what allows both a Claude Code session and the dashboard to
 * write to the same org safely.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  GENESIS_PREV_HASH,
  type LedgerEntry,
  type LedgerEntryBase,
  type LedgerEventType,
  type LedgerVerifyResult,
  type SpendRollup,
} from "./types.js";
import { ensureCeoDirs, ledgerPath } from "./paths.js";
import { withLedgerLock } from "./lock.js";

/**
 * Canonical JSON: object keys sorted recursively, no whitespace. Two
 * structurally identical objects always serialize to the same string, so
 * the hash is stable regardless of key insertion order.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/** sha256 over the canonical form of the entry's base fields. */
export function hashEntry(base: LedgerEntryBase): string {
  return createHash("sha256").update(canonicalize(base), "utf8").digest("hex");
}

/** Read every entry. Returns [] when no ledger exists yet. */
export function readLedger(cwd?: string): LedgerEntry[] {
  const p = ledgerPath(cwd);
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, "utf8");
  const out: LedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as LedgerEntry);
    } catch {
      // A malformed line is itself a chain break. verify() will surface it
      // with position. Skip here so callers still get the readable prefix.
    }
  }
  return out;
}

/** The last entry, or null on an empty/absent ledger. */
export function lastEntry(cwd?: string): LedgerEntry | null {
  const entries = readLedger(cwd);
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

/**
 * Append one event. Computes seq and prevHash from the current tail, so
 * callers never manage chain bookkeeping themselves.
 */
export function append(
  type: LedgerEventType,
  agent: string | null,
  data: Record<string, unknown>,
  cwd?: string,
): LedgerEntry {
  ensureCeoDirs(cwd);
  // Read-tail-then-append has to be atomic across processes. Without the
  // lock, the dashboard and a Claude Code session can each read the same
  // tail, each derive prevHash from it, and each append, forking the chain.
  return withLedgerLock(() => {
    const tail = lastEntry(cwd);
    const base: LedgerEntryBase = {
      seq: tail ? tail.seq + 1 : 0,
      ts: Date.now(),
      type,
      agent,
      data,
      prevHash: tail ? tail.hash : GENESIS_PREV_HASH,
    };
    const entry: LedgerEntry = { ...base, hash: hashEntry(base) };
    appendFileSync(ledgerPath(cwd), JSON.stringify(entry) + "\n", "utf8");
    return entry;
  }, cwd);
}

/**
 * Walk the chain and confirm every link. Checks three invariants per
 * entry: seq is contiguous, prevHash matches the predecessor's hash, and
 * the stored hash matches a recomputation over the base fields.
 */
export function verify(cwd?: string): LedgerVerifyResult {
  const entries = readLedger(cwd);
  if (entries.length === 0) {
    return { ok: true, entriesChecked: 0, brokenAtSeq: null, reason: null };
  }

  let expectedPrev = GENESIS_PREV_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];

    if (e.seq !== i) {
      return {
        ok: false,
        entriesChecked: i,
        brokenAtSeq: e.seq,
        reason: `seq out of order: expected ${i}, found ${e.seq}. An entry was likely deleted or reordered.`,
      };
    }

    if (e.prevHash !== expectedPrev) {
      return {
        ok: false,
        entriesChecked: i,
        brokenAtSeq: e.seq,
        reason: `prevHash mismatch at seq ${e.seq}: entry claims ${e.prevHash.slice(0, 12)}…, chain expects ${expectedPrev.slice(0, 12)}…`,
      };
    }

    const { hash, ...base } = e;
    const recomputed = hashEntry(base as LedgerEntryBase);
    if (recomputed !== hash) {
      return {
        ok: false,
        entriesChecked: i,
        brokenAtSeq: e.seq,
        reason: `content hash mismatch at seq ${e.seq}: entry was edited after it was written.`,
      };
    }

    expectedPrev = e.hash;
  }

  return {
    ok: true,
    entriesChecked: entries.length,
    brokenAtSeq: null,
    reason: null,
  };
}

/** Entries in [sinceMs, now]. Pass 0 for the whole ledger. */
export function entriesSince(sinceMs: number, cwd?: string): LedgerEntry[] {
  return readLedger(cwd).filter((e) => e.ts >= sinceMs);
}

/** The last N entries, oldest first. */
export function tail(n: number, cwd?: string): LedgerEntry[] {
  const all = readLedger(cwd);
  return all.slice(Math.max(0, all.length - n));
}

/**
 * Sum delegation costs over a time window. Reads only `delegate_end`
 * events, which carry the settled cost. `delegate_start` has no cost yet.
 */
export function rollup(sinceMs: number, cwd?: string): SpendRollup {
  const now = Date.now();
  const events = entriesSince(sinceMs, cwd).filter(
    (e) => e.type === "delegate_end",
  );
  const byAgent: Record<string, number> = {};
  let totalUsd = 0;
  for (const e of events) {
    const cost = Number(e.data.costUsd ?? 0);
    if (!Number.isFinite(cost)) continue;
    totalUsd += cost;
    const name = e.agent ?? "(unattributed)";
    byAgent[name] = (byAgent[name] ?? 0) + cost;
  }
  return {
    totalUsd,
    byAgent,
    delegationCount: events.length,
    windowStart: sinceMs,
    windowEnd: now,
  };
}

/**
 * Initialize a fresh ledger with a genesis entry. Refuses if one exists,
 * so an accidental re-init cannot orphan history.
 */
export function initLedger(cwd?: string): LedgerEntry {
  ensureCeoDirs(cwd);
  const p = ledgerPath(cwd);
  if (existsSync(p) && readFileSync(p, "utf8").trim().length > 0) {
    throw new Error(
      `Org already initialized at ${p}. Delete .ceo/ to start over, or use the existing org.`,
    );
  }
  writeFileSync(p, "", "utf8");
  return append("org_init", null, { ceoVersion: 1 }, cwd);
}
