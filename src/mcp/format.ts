/**
 * Formatting helpers for MCP tool output.
 *
 * Everything here exists to keep tool responses terse. This server's output
 * lands in a terminal next to real work, so one line beats a paragraph and a
 * padded column beats a bulleted list. Nothing in here touches state.
 */

import type { LedgerEntry } from "../core/types.js";

/** Round money: budgets and totals, where cents are the unit that matters. */
export function usd(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}

/**
 * Exact money: delegation costs and accrued spend. A single call often costs
 * a few tenths of a cent, and rounding those to $0.00 hides the thing the
 * budget gate is counting.
 */
export function usdExact(n: number): string {
  if (!Number.isFinite(n)) return "$0.0000";
  return `$${n.toFixed(4)}`;
}

/** Seconds with one decimal: "12.3s", "0.4s". */
export function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Model slug for display. Roster stores "claude-sonnet-5". The terminal only
 * needs "sonnet-5". Anything not prefixed passes through untouched.
 */
export function shortModel(model: string): string {
  return model.startsWith("claude-") ? model.slice("claude-".length) : model;
}

/** "5h", "0.4h", "3d". Used for audit recency and last-active. */
export function sinceHuman(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "never";
  const h = (Date.now() - ms) / 3_600_000;
  if (h < 0.1) return "<0.1h";
  if (h < 1) return `${h.toFixed(1)}h`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/** Local "MM-DD HH:MM": enough to order events during a working session. */
export function fmtTs(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Single-line, length-capped. Newlines become spaces so tables stay flat. */
export function trunc(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, Math.max(0, n - 1))}…`;
}

/** ms epoch of local midnight today. */
export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Left-aligned fixed-width columns. Rows are ragged-tolerant: a short row is
 * padded, and the final column is never padded so lines have no trailing space.
 */
export function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const cols = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    widths[c] = Math.max(...rows.map((r) => (r[c] ?? "").length));
  }
  return rows
    .map((r) =>
      Array.from({ length: cols }, (_, c) => r[c] ?? "")
        .map((cell, c) => (c === cols - 1 ? cell : cell.padEnd(widths[c])))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/**
 * One-line gloss of a ledger entry's payload, chosen per event type. The
 * ledger tail is for scanning, so each line answers "what happened" without
 * dumping the JSON.
 */
export function summarizeEntry(e: LedgerEntry): string {
  const d = e.data;
  switch (e.type) {
    case "org_init":
      return "org created";
    case "hire":
      return `${shortModel(String(d.model ?? "?"))} ${usd(Number(d.budgetUsd ?? 0))}${
        d.isolated ? " isolated" : ""
      }`;
    case "fire":
      return d.reason ? trunc(String(d.reason), 48) : "no reason given";
    case "delegate_start":
      return `${String(d.id ?? "?")} ${trunc(String(d.task ?? ""), 48)}`;
    case "delegate_end":
      return `${String(d.id ?? "?")} ${usdExact(Number(d.costUsd ?? 0))} ${secs(
        Number(d.durationMs ?? 0),
      )}`;
    case "budget_set":
      return `${usd(Number(d.previousUsd ?? 0))} to ${usd(Number(d.budgetUsd ?? 0))}`;
    case "worktree_provision":
      return String(d.branch ?? "");
    case "worktree_commit": {
      const files = Array.isArray(d.files) ? d.files.length : 0;
      return `${String(d.sha ?? "").slice(0, 7)} ${files} file${files === 1 ? "" : "s"}`;
    }
    case "worktree_merge": {
      if (d.ok) return `merged ${String(d.sha ?? "").slice(0, 7)}`;
      const conflicts = Array.isArray(d.conflicts) ? d.conflicts.length : 0;
      return `conflict in ${conflicts} file${conflicts === 1 ? "" : "s"}`;
    }
    case "audit": {
      const n = Number(d.findingCount ?? 0);
      return `${n} finding${n === 1 ? "" : "s"}`;
    }
    case "postmortem":
      return trunc(String(d.summary ?? ""), 48);
    case "note":
      return trunc(String(d.text ?? ""), 56);
    case "mission_set": {
      const objective = trunc(String(d.objective ?? ""), 48);
      return d.previousObjective ? `revised: ${objective}` : objective;
    }
    case "autonomy_set":
      return `${String(d.previous ?? "?")} to ${String(d.autonomy ?? "?")}`;
    case "agent_config": {
      // The payload is whatever changed, so name the fields rather than
      // guessing which one mattered.
      const fields = Object.keys(d);
      return fields.length > 0 ? fields.join(", ") : "no change";
    }
    case "guardrail_set":
      return trunc(String(d.rule ?? d.text ?? ""), 56);
    default:
      return "";
  }
}
