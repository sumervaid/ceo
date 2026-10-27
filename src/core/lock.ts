/**
 * Cross-process advisory lock for ledger writes.
 *
 * The original design said "the MCP server is the only writer", which made
 * the hash chain safe by construction. That constraint is what kept the
 * dashboard read-only. Once you can hire from the dashboard there are two
 * writers. Two writers can each read the same tail entry, each compute
 * `prevHash` from it, and each append, forking the chain. `verify()` would
 * catch the fork afterwards, but a ledger you have to repair is not one you
 * can trust.
 *
 * So: take an exclusive lock around read-tail-then-append. `wx` open flags
 * are atomic on every platform we care about, which is all this needs.
 *
 * The lock records pid and hostname so a stale lock can be distinguished
 * from a live one. Stale locks are broken automatically after a timeout.
 * The alternative is a crashed process wedging the org forever. That is
 * worse than the small risk of breaking a lock held by something that
 * hung for over ten seconds.
 */

import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import * as path from "node:path";
import { ceoDir, ensureCeoDirs } from "./paths.js";

/** A lock older than this is treated as abandoned. */
const STALE_MS = 10_000;
/** Give up acquiring after this long and throw. */
const ACQUIRE_TIMEOUT_MS = 5_000;
const RETRY_MS = 25;

function lockPath(cwd?: string): string {
  return path.join(ceoDir(cwd), "ledger.lock");
}

type LockInfo = { pid: number; host: string; ts: number };

function readLock(p: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as LockInfo;
  } catch {
    // Unreadable or half-written lock file. Treat as stale rather than
    // wedging: a corrupt lock should not be permanent.
    return null;
  }
}

/** True when the holder is this machine and the process is gone. */
function holderIsDead(info: LockInfo): boolean {
  if (info.host !== hostname()) return false; // can't tell, so assume alive
  try {
    // Signal 0 tests existence without delivering anything.
    process.kill(info.pid, 0);
    return false;
  } catch {
    return true;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` holding the ledger lock. Releases on both success and throw, so
 * an exception inside a write cannot strand the lock.
 */
export function withLedgerLock<T>(fn: () => T, cwd?: string): T {
  ensureCeoDirs(cwd);
  const p = lockPath(cwd);
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  let acquired = false;

  while (!acquired) {
    try {
      // `wx` fails if the path exists. That failure is the lock.
      const fd = openSync(p, "wx");
      const info: LockInfo = { pid: process.pid, host: hostname(), ts: Date.now() };
      writeSync(fd, JSON.stringify(info));
      closeSync(fd);
      acquired = true;
    } catch {
      const info = readLock(p);
      const expired = !info || Date.now() - info.ts > STALE_MS || holderIsDead(info);
      if (expired) {
        // Break it and retry immediately. Racing breakers are fine: whoever
        // wins the next `wx` open holds the lock, the loser retries.
        try {
          rmSync(p, { force: true });
        } catch {
          /* another process broke it first */
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Could not acquire the ledger lock at ${p} after ${ACQUIRE_TIMEOUT_MS}ms. ` +
            `It is held by pid ${info.pid} on ${info.host}. If that process is gone, delete the file.`,
        );
      }
      sleepSync(RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    try {
      // Only remove a lock we still own, so we cannot delete a lock that
      // someone else took after ours was broken as stale.
      const info = readLock(p);
      if (!info || (info.pid === process.pid && info.host === hostname())) {
        rmSync(p, { force: true });
      }
    } catch {
      /* best effort */
    }
  }
}

/** True when a lock file is present and its holder still looks alive. */
export function isLocked(cwd?: string): boolean {
  const p = lockPath(cwd);
  if (!existsSync(p)) return false;
  const info = readLock(p);
  if (!info) return false;
  if (Date.now() - info.ts > STALE_MS) return false;
  return !holderIsDead(info);
}
