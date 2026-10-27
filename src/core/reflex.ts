/**
 * Reflex, as CEO sees it: installed or not, scanned or not, and the command
 * that would scan.
 *
 * Reflex, which is reflex-skills on npm and the `reflex` command, finds the
 * workflows a person keeps repeating across Claude Code, Codex and Cursor
 * sessions. CEO reads its store to propose a team, in history.ts and
 * suggest.ts. When the store is empty, it offers to run the scan rather than
 * printing the command and hoping. The scan is Reflex's own: it reads transcripts, redacts them,
 * and writes only under ~/.reflex. `--yes` consents to the read up front,
 * because the person pressing the key has just asked for exactly that.
 *
 * The loop this closes: claude and codex agents leave transcripts in the
 * same places Reflex reads.
 * So the org's own runs become Reflex history, Reflex finds what the org
 * keeps doing, and the next `p` proposes a seat for it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export type ReflexStatus = {
  binary: string;
  installed: boolean;
  version: string | null;
  /** Reflex's data folder: $REFLEX_HOME or ~/.reflex. */
  home: string;
  /** True when a store exists, meaning Reflex has scanned at least once. */
  scanned: boolean;
  /** When the store was last written. */
  scannedAt: number | null;
  /** One line for a checklist. */
  summary: string;
  /** What to do next, when something is missing. */
  fix: string | null;
};

export function reflexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.REFLEX_HOME?.trim() || path.join(homedir(), ".reflex");
}

export function reflexBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.CEO_REFLEX_BIN?.trim() || "reflex";
}

/** `reflex scan`, consenting up front, over a window long enough to find repeats. */
export function reflexScanCommand(days = 30, env: NodeJS.ProcessEnv = process.env): string[] {
  return [reflexBinary(env), "scan", "--days", String(days), "--yes"];
}

let memo: ReflexStatus | null = null;

export function resetReflexStatus(): void {
  memo = null;
}

export function reflexStatus(env: NodeJS.ProcessEnv = process.env): ReflexStatus {
  if (memo) return memo;
  const binary = reflexBinary(env);
  const home = reflexHome(env);
  let version: string | null = null;
  try {
    const out = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"], env });
    version = out.trim().split("\n").filter(Boolean).pop() ?? "installed";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") version = "installed";
  }
  const installed = version !== null;
  const db = path.join(home, "reflex.db");
  let scannedAt: number | null = null;
  try {
    scannedAt = statSync(db).mtimeMs;
  } catch {
    /* no store */
  }
  const scanned = existsSync(db);

  let summary: string;
  let fix: string | null = null;
  if (!installed) {
    summary = "reflex: not installed. Optional, but it is what makes the suggested team evidence-based";
    fix = "npm i -g reflex-skills";
  } else if (!scanned) {
    summary = `reflex ${version}: installed, not scanned yet`;
    fix = `${reflexScanCommand(30, env).join(" ")}    or press s on the suggested team`;
  } else {
    const age = scannedAt ? Math.round((Date.now() - scannedAt) / 86_400_000) : null;
    summary = `reflex ${version}: scanned${age !== null ? ` ${age === 0 ? "today" : `${age}d ago`}` : ""} · ${home}`;
    if (age !== null && age > 14) fix = `${reflexScanCommand(30, env).join(" ")}    since the scan is ${age} days old`;
  }
  memo = { binary, installed, version, home, scanned, scannedAt, summary, fix };
  return memo;
}
