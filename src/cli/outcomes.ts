/**
 * `ceo outcomes`: what a workspace's compute bought, in verified results.
 *
 *   ceo outcomes                      stats for this workspace: overall, by arm, by agent
 *   ceo outcomes --all                every registered workspace with its allocation share
 *   ceo outcomes budget               print the outcome budget
 *   ceo outcomes budget --attempts N|none --verified N|none --period all|day
 */

import { orgExists } from "../core/paths.js";
import { allocation, outcomeBudget, outcomeStats, setOutcomeBudget, type OutcomePeriod, type OutcomeRow, type OutcomeStats } from "../core/outcomes.js";
import { listWorkspaces } from "../core/workspaces.js";
import { compactUsd } from "../tui/format.js";

function fail(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function money(n: number | null): string {
  return n === null ? "-" : compactUsd(n);
}

function percent(n: number | null): string {
  return n === null ? "-" : `${Math.round(n * 100)}%`;
}

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join("  ").trimEnd());
}

function breakdown(title: string, rows: OutcomeRow[]): string[] {
  if (rows.length === 0) return [];
  const head = [title, "attempts", "verified", "spent", "$/verified"];
  const body = rows.map((r) => [r.label, String(r.attempts), String(r.verified), money(r.usd), money(r.verified > 0 ? r.usd / r.verified : null)]);
  return ["", ...table([head, ...body])];
}

export function renderOutcomes(s: OutcomeStats): string[] {
  const lines = [
    `${s.verified} verified from ${s.attempts} attempts, ${money(s.spentUsd)} spent, ${money(s.usdPerVerified)} per verified outcome`,
    `${s.finished} finished · ${s.failedTasks} failed tasks · ${s.unverified} done without a verifier · pass rate ${percent(s.passRate)}`,
  ];
  return [...lines, ...breakdown("arm", s.byArm), ...breakdown("agent", s.byAgent)];
}

function describeBudget(cwd: string): string {
  const b = outcomeBudget(cwd);
  const per = b.period === "day" ? "per day" : "for all time";
  return `attempts ${b.attempts ?? "no cap"} · verified target ${b.verified ?? "none"} · ${per}`;
}

/** The new value for a flag: the current one when the flag is absent, null for none. */
function capFor(value: string | undefined, flag: string, current: number | null): number | null {
  if (value === undefined) return current;
  if (/^(none|off)$/i.test(value)) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} takes a whole number or none.`);
  return n;
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] ?? "" : undefined;
}

export function outcomesCmd(args: string[], cwd: string): void {
  const [verb, ...rest] = args;

  if (verb === "budget") {
    if (!orgExists(cwd)) return fail("No org in this project. Run `ceo` and press n to start one.");
    const attempts = flagValue(rest, "--attempts");
    const verified = flagValue(rest, "--verified");
    const period = flagValue(rest, "--period");
    if (attempts === undefined && verified === undefined && period === undefined) {
      process.stdout.write(`${describeBudget(cwd)}\n`);
      return;
    }
    try {
      if (period !== undefined && period !== "all" && period !== "day") throw new Error("--period takes all or day.");
      const current = outcomeBudget(cwd);
      setOutcomeBudget(
        {
          attempts: capFor(attempts, "--attempts", current.attempts),
          verified: capFor(verified, "--verified", current.verified),
          period: (period as OutcomePeriod | undefined) ?? current.period,
        },
        cwd,
      );
      process.stdout.write(`Outcome budget set: ${describeBudget(cwd)}\n`);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    return;
  }

  if (verb === "--all" || verb === "all") {
    const spaces = listWorkspaces().filter((w) => orgExists(w.path));
    if (spaces.length === 0) return fail("No workspaces with an org are registered. `ceo workspace add <path>`");
    const rows = spaces.map((w) => ({ path: w.path, name: w.name, stats: outcomeStats(w.path) }));
    const shares = new Map(allocation(rows).map((a) => [a.path, a.share]));
    const head = ["workspace", "attempts", "verified", "spent", "$/verified", "share"];
    const body = rows
      .map((r) => ({ r, share: shares.get(r.path) ?? 0 }))
      .sort((a, b) => b.share - a.share)
      .map(({ r, share }) => [r.name, String(r.stats.attempts), String(r.stats.verified), money(r.stats.spentUsd), money(r.stats.usdPerVerified), percent(share)]);
    process.stdout.write(`${table([head, ...body]).join("\n")}\n`);
    return;
  }

  if (verb !== undefined) return fail("Usage: ceo outcomes [--all] | budget [--attempts N|none] [--verified N|none] [--period all|day]");
  if (!orgExists(cwd)) return fail("No org in this project. Run `ceo` and press n to start one.");
  process.stdout.write(`${renderOutcomes(outcomeStats(cwd)).join("\n")}\n`);
}
