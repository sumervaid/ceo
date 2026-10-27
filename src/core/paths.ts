/**
 * Path resolution for the `.ceo/` state directory.
 *
 * CEO state always lives at the git repository root, not the current
 * working directory, so that `/delegate` from a subdirectory writes to the
 * same ledger as `/delegate` from the top. Falls back to CWD when the
 * project is not a git repo.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";

/**
 * Resolving the root means spawning git, and every path helper below calls
 * this. One hire used to spawn git a few dozen times, and a six-seat hire
 * blocked the dashboard for ten seconds. The answer for a directory does not
 * change while a process runs, so it is remembered briefly. A `git init`
 * underneath is the one exception, and a few seconds of staleness there is
 * harmless.
 */
const ROOT_TTL_MS = 5000;
const rootCache = new Map<string, { root: string; at: number }>();

/** Absolute path to the repo root, or CWD when not in a git repo. */
export function projectRoot(cwd: string = process.cwd()): string {
  const key = path.resolve(cwd);
  const hit = rootCache.get(key);
  if (hit && Date.now() - hit.at < ROOT_TTL_MS) return hit.root;
  let root: string;
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    root = out.trim();
  } catch {
    root = key;
  }
  rootCache.set(key, { root, at: Date.now() });
  return root;
}

/** Forget remembered roots, for tests that create repos under a dir they already asked about. */
export function forgetProjectRoots(): void {
  rootCache.clear();
}

export function ceoDir(cwd?: string): string {
  return path.join(projectRoot(cwd), ".ceo");
}

export function rosterPath(cwd?: string): string {
  return path.join(ceoDir(cwd), "roster.json");
}

export function ledgerPath(cwd?: string): string {
  return path.join(ceoDir(cwd), "ledger.jsonl");
}

export function auditsDir(cwd?: string): string {
  return path.join(ceoDir(cwd), "audits");
}

export function outputsDir(cwd?: string): string {
  return path.join(ceoDir(cwd), "outputs");
}

export function worktreesDir(cwd?: string): string {
  return path.join(ceoDir(cwd), "worktrees");
}

/**
 * Where a chief of staff on gemini runs. The Antigravity CLI reads MCP
 * servers from a file in the workspace, and the person's tree is not CEO's
 * to write into, so the chief gets a directory of its own inside `.ceo/`.
 */
export function chiefDir(name: string, cwd?: string): string {
  return path.join(ceoDir(cwd), "chief", name);
}

/** Create the `.ceo/` tree if absent. Idempotent. */
export function ensureCeoDirs(cwd?: string): void {
  for (const d of [ceoDir(cwd), auditsDir(cwd), outputsDir(cwd)]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

/** True when an org has been initialized in this project. */
export function orgExists(cwd?: string): boolean {
  return existsSync(ledgerPath(cwd));
}
