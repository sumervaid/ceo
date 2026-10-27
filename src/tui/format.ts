/**
 * Display helpers for the TUI.
 *
 * Money and duration formatting is deliberately *not* reimplemented here.
 * It is re-exported from the MCP surface's formatter, so a dollar reads the
 * same whether it came back from a tool call or off the dashboard. That
 * module is pure and imports only types, so pulling it in does not drag the
 * MCP SDK into the TUI process.
 *
 * What is local to this file is the stuff a terminal grid needs and a
 * one-line tool response does not: fixed-width fitting, meters, and the
 * green/yellow/red health scale every panel colours itself by.
 */

import { homedir } from "node:os";

import { AUTONOMY_LEVELS, type AutonomyLevel, type Provider } from "../core/types.js";

export {
  secs,
  shortModel,
  sinceHuman,
  startOfToday,
  trunc,
  usd,
  usdExact,
} from "../mcp/format.js";

// ---------------------------------------------------------------------------
// Autonomy
// ---------------------------------------------------------------------------

/**
 * Three-letter codes, because the roster row has about four cells to spare.
 * The alternative is dropping the model column on every terminal under a
 * hundred columns. The detail view spells the level out in full, so the
 * abbreviation never has to stand alone as the only statement of it.
 */
const AUTONOMY_SHORT: Record<AutonomyLevel, string> = {
  observe: "obs",
  propose: "pro",
  execute: "exe",
  autonomous: "aut",
};

/**
 * Rosters written before autonomy existed have no such field, and a cached
 * roster.json is read straight off disk. Everything here therefore treats an
 * unknown level as `execute`, the way `policyFor` does, rather than
 * rendering "undefined" into a column about permissions.
 */
export function autonomyLevel(level: AutonomyLevel | undefined): AutonomyLevel {
  return level && AUTONOMY_LEVELS.includes(level) ? level : "execute";
}

export function autonomyShort(level: AutonomyLevel | undefined): string {
  return AUTONOMY_SHORT[autonomyLevel(level)];
}

/**
 * The split that matters is whether the agent can write at all, so the two
 * read-only levels share one colour and the two writing levels share another.
 * Green/yellow/red are deliberately not used: on this dashboard they mean
 * budget health. An agent in the green would then read as safe when what
 * was actually being said is that it can merge to main unattended.
 */
export function autonomyColor(level: AutonomyLevel | undefined): "blue" | "magenta" {
  const l = autonomyLevel(level);
  return l === "observe" || l === "propose" ? "blue" : "magenta";
}

/** Cycle order, wrapping. `autonomous` returns to `observe`. */
export function nextAutonomy(level: AutonomyLevel | undefined): AutonomyLevel {
  const i = AUTONOMY_LEVELS.indexOf(autonomyLevel(level));
  return AUTONOMY_LEVELS[(i + 1) % AUTONOMY_LEVELS.length];
}

/**
 * Money at the width a column can spare. A budget of $5 prints as "$5", a
 * spend of $0.34 keeps its cents, and a runaway $142.77 drops them. The
 * digit that matters at that magnitude is the hundreds, not the pennies.
 */
export function compactUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  // Under a cent, show the fraction. A roster that reads "$0.00" beside an
  // agent that just spent half a cent is the understatement the ledger
  // exists to prevent. Codex runs at list price are often this small.
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  if (n >= 100) return `$${Math.round(n)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * A settled cost at column width. Differs from `compactUsd` in one case: a
 * figure under a cent prints with four decimals instead of rounding to
 * "$0.00". A cancelled run that burned three tenths of a cent spent money,
 * and a column that says zero about it teaches that cancelling is free.
 */
export function costUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return compactUsd(n);
}

/** Budgets are usually round numbers, so "$5" beats "$5.00" in a column. */
export function compactBudget(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  if (n <= 0) return "∞";
  return Number.isInteger(n) ? `$${n}` : compactUsd(n);
}

/** Wall-clock "14:02:18". The activity feed is read against the session. */
export function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** "Mar 14 09:12" for detail views, where absolute time is worth the width. */
export function stamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Health scale
// ---------------------------------------------------------------------------

export type Level = "ok" | "warn" | "over";

/**
 * Where an agent sits against its cap. `warn` at 70% is early enough to
 * raise the budget before a delegation gets refused mid-task. A budget of 0
 * means uncapped, as `budgetCheck` defines it, which is never a warning.
 */
export function budgetLevel(spentUsd: number, budgetUsd: number): Level {
  if (!(budgetUsd > 0)) return "ok";
  const ratio = spentUsd / budgetUsd;
  if (ratio >= 1) return "over";
  if (ratio >= 0.7) return "warn";
  return "ok";
}

export function levelColor(level: Level): "green" | "yellow" | "red" {
  return level === "over" ? "red" : level === "warn" ? "yellow" : "green";
}

/** 0..1, clamped. Uncapped budgets report 0 so the meter reads empty. */
export function budgetRatio(spentUsd: number, budgetUsd: number): number {
  if (!(budgetUsd > 0)) return 0;
  return Math.max(0, Math.min(1, spentUsd / budgetUsd));
}

/** Filled/empty halves of a meter, kept separate so they can be coloured. */
export function meter(ratio: number, width: number): { filled: string; empty: string } {
  const w = Math.max(0, width);
  const f = Math.max(0, Math.min(w, Math.round(ratio * w)));
  return { filled: "█".repeat(f), empty: "░".repeat(w - f) };
}

// ---------------------------------------------------------------------------
// Width
// ---------------------------------------------------------------------------

/** Collapse to one line, then pad or ellipsize to exactly `width` cells. */
export function fit(s: string, width: number): string {
  if (width <= 0) return "";
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length === width) return flat;
  if (flat.length < width) return flat.padEnd(width);
  return width === 1 ? "…" : `${flat.slice(0, width - 1)}…`;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Wrap on word boundaries. Used for role briefs, which are free text and the
 * one place in the UI where a paragraph is the right shape.
 */
export function wrap(s: string, width: number, maxLines: number): string[] {
  if (width <= 0 || maxLines <= 0) return [];
  const words = s.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word.length <= width ? word : word.slice(0, width - 1) + "…";
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length > maxLines) lines.length = maxLines;
  // Signal truncation on the last visible line rather than silently cutting.
  const consumed = lines.join(" ").length;
  if (consumed < s.replace(/\s+/g, " ").trim().length && lines.length > 0) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.length + 1 <= width ? `${last}…` : fit(`${last}…`, width);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** "~/code/orbit" for a path under the home directory. */
export function tilde(p: string): string {
  const home = homedir();
  return p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

/**
 * A path relative to the workspace when it is inside it, else with "~".
 * A run pane that prints forty characters of /private/tmp before the part
 * that matters is spending its width on the wrong thing.
 */
export function shortPath(p: string, base?: string | null): string {
  if (base && (p === base || p.startsWith(base + "/"))) return p === base ? "." : p.slice(base.length + 1);
  return tilde(p);
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** One colour per provider, the same in every panel: cyan, green, blue. */
export function providerColor(p: Provider | undefined): "cyan" | "green" | "blueBright" {
  if (p === "codex") return "green";
  if (p === "gemini") return "blueBright";
  return "cyan";
}
