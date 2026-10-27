/**
 * Static text rendering of the org view.
 *
 * The Ink TUI needs raw-mode control of the terminal, which it cannot get
 * inside a Claude Code session. So `/snapshot` renders this instead: the same
 * information, as plain text, safe to print into a chat transcript. The
 * interactive dashboard opens alongside in a split or a new window when
 * the environment allows it.
 *
 * Deliberately narrow at 72 columns, so it survives being quoted, wrapped,
 * or pasted into a message without turning into noise.
 */

import { readOrgState, readWorktreeInfo } from "./data.js";
import { autonomyLevel, compactUsd, costUsd, budgetRatio, meter, wrap } from "./format.js";
import type { OrgState } from "./data.js";
import { describeConfig } from "../core/compile.js";
import { nextStep } from "../core/nextstep.js";
import { taskCounts } from "../core/tasks.js";
import type { Mission } from "../core/types.js";

const WIDTH = 72;

function ago(ms: number | null): string {
  if (!ms) return "never";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function rule(label?: string): string {
  if (!label) return "─".repeat(WIDTH);
  const head = `── ${label} `;
  return head + "─".repeat(Math.max(0, WIDTH - head.length));
}

/** Free text, wrapped to the page under a fixed indent. */
function pushWrapped(out: string[], text: string, indent: string): void {
  for (const line of wrap(text, WIDTH - indent.length, 200)) {
    out.push(indent + line);
  }
}

/** One bullet, with the continuation hanging under the text, not the dot. */
function pushBullet(out: string[], text: string, indent: string): void {
  const lines = wrap(text, WIDTH - indent.length - 2, 200);
  lines.forEach((line, i) => out.push(indent + (i === 0 ? "· " : "  ") + line));
}

/**
 * The org's objective, above everything else.
 *
 * It leads because it is the thing every other line is in service of: a
 * roster and a spend total mean nothing without knowing what the org was
 * pointed at. When there is no mission, that absence is itself the news.
 * Every agent's compiled prompt is missing the section that tells it what
 * the work is for. Each one is inferring the objective on its own, and
 * they will not all infer the same one.
 *
 * A brand-new org with nobody hired is exempt: there is no team yet to
 * misalign, and /hire is the step that matters there.
 */
function missionBlock(mission: Mission | null, hasAgents: boolean): string[] {
  const out: string[] = [];
  const objective = mission?.objective?.trim() ?? "";

  if (!objective) {
    if (!hasAgents) return out;
    out.push(rule("Mission"));
    out.push("  Not set. Each agent is guessing the objective.  /mission");
    out.push("");
    return out;
  }

  out.push(rule("Mission"));
  pushWrapped(out, objective, "  ");

  const criteria = (mission?.successCriteria ?? []).filter((c) => c.trim());
  if (criteria.length > 0) {
    out.push("");
    out.push("  Done when:");
    for (const c of criteria) pushBullet(out, c.trim(), "    ");
  }

  const rails = (mission?.orgGuardrails ?? []).filter((g) => g.trim());
  if (rails.length > 0) {
    out.push("");
    out.push("  Org rules:");
    for (const g of rails) pushBullet(out, g.trim(), "    ");
  }

  out.push("");
  return out;
}

/**
 * Render the whole org as text. Returns null when no org exists, so the
 * caller can distinguish "empty org" from "no org here" and say the right
 * thing.
 */
export function renderSnapshot(cwd?: string): string | null {
  let state: OrgState;
  try {
    state = readOrgState(cwd);
  } catch {
    return null;
  }
  if (!state.exists) return null;

  const out: string[] = [];

  // Integrity first. A broken chain invalidates every number below it, so
  // it leads rather than sitting in a footer where it could be skimmed past.
  if (state.verifyResult && !state.verifyResult.ok) {
    out.push(rule("LEDGER CHAIN BROKEN"));
    out.push(`  ${state.verifyResult.reason ?? "chain verification failed"}`);
    out.push(`  Spend figures below cannot be trusted until this is resolved.`);
    out.push(`  Restore .ceo/ledger.jsonl from git history.`);
    out.push("");
  }

  const agents = state.roster?.agents ?? [];

  // ---- Mission -------------------------------------------------------
  out.push(...missionBlock(state.mission, agents.length > 0));

  // A brand-new org has nothing in any section, and printing three empty
  // tables says less than one honest sentence. Short-circuit to the state
  // plus the one action that matters.
  if (agents.length === 0 && (state.delegations?.length ?? 0) === 0) {
    out.push(rule("Org"));
    out.push("  Empty. No agents hired yet.");
    out.push("");
    out.push(rule());
    out.push("  next: /hire");
    out.push(
      "     Run it with no arguments and it will read this repo and",
    );
    out.push("     propose a starting team.");
    return out.join("\n");
  }

  // ---- Roster -------------------------------------------------------
  out.push(rule("Org"));
  if (agents.length === 0) {
    out.push("  No agents hired yet.  /hire");
  } else {
    for (const a of agents) {
      const ratio = budgetRatio(a.spentUsd, a.budgetUsd);
      const m = meter(ratio, 10);
      const spend = `${compactUsd(a.spentUsd)}/${compactUsd(a.budgetUsd)}`;

      // What an agent is permitted to do belongs next to its name, because
      // it changes what every other line about that agent means. An agent
      // that cannot write is not a slower implementer, it is a different
      // job. So the two read-only levels get their own glyph and are named
      // as read-only. Otherwise the level is one word inside the config
      // string that a reader has to know the meaning of.
      const level = autonomyLevel(a.autonomy);
      const readOnly = level === "observe" || level === "propose";
      const head = `  ${readOnly ? "○" : "●"} ${a.name.padEnd(14)} `;
      const config = `${readOnly ? "read-only · " : ""}${describeConfig(a)}`;
      const configLines = wrap(config, WIDTH - head.length, 3);
      out.push(head + (configLines[0] ?? ""));
      for (const extra of configLines.slice(1)) {
        out.push(" ".repeat(head.length) + extra);
      }

      const indent = "      ";
      out.push(`${indent}${spend.padEnd(14)} ${m.filled}${m.empty}  ${a.provider ?? "claude"} ${a.model}`);
      // Wrap the brief so a long role does not blow past the width.
      pushWrapped(out, a.role, indent);

      if (a.isolated) {
        if (!a.branch) {
          // Hired isolated but never provisioned. Not cosmetic: delegation
          // only commits when a worktree exists, so this agent's file
          // changes would land nowhere and vanish without a word.
          out.push(indent + "isolated, but no worktree yet. Work will not commit.");
        } else {
          const wt = readWorktreeInfo(a, cwd);
          const bits: string[] = [`branch ${a.branch}`];
          if (wt.unmerged.length > 0) bits.push(`${wt.unmerged.length} unmerged`);
          if (wt.changed.length > 0) bits.push(`${wt.changed.length} uncommitted`);
          out.push(indent + bits.join(" · "));
        }
      }
      out.push("");
    }
  }

  // ---- Queue ----------------------------------------------------------
  // Only when there is one. An org that works purely through /delegate has
  // no queue, and an empty section would be a nag.
  const tasks = state.tasks ?? [];
  if (tasks.length > 0) {
    const c = taskCounts(tasks);
    const head: string[] = [];
    if (c.running > 0) head.push(`${c.running} running`);
    if (c.queued > 0) head.push(`${c.queued} queued`);
    if (c.blocked > 0) head.push(`${c.blocked} blocked`);
    out.push(rule(`Queue${head.length > 0 ? ` · ${head.join(" · ")}` : ""}`));
    for (const t of tasks.slice(0, 8)) {
      const mark =
        t.status === "running" ? "⋯" : t.status === "queued" ? "▸" : t.status === "blocked" ? "⊘"
        : t.status === "done" ? "✓" : t.status === "failed" ? "✗" : "⨯";
      const who = (t.assignee ?? "nobody").padEnd(12);
      const tail = t.blockedReason ? ` · ${t.blockedReason}` : t.costUsd !== null ? ` · ${costUsd(t.costUsd)}` : "";
      const title = t.title.replace(/\s+/g, " ").slice(0, Math.max(10, WIDTH - 22 - tail.length));
      out.push(`  ${mark} ${t.id} ${who} ${title}${tail}`);
    }
    if (tasks.length > 8) out.push(`  +${tasks.length - 8} more`);
    out.push("");
  }

  // ---- Recent activity ----------------------------------------------
  const dels = state.delegations ?? [];
  out.push(rule("Recent"));
  if (dels.length === 0) {
    out.push("  Nothing delegated yet.");
    out.push("  /delegate <agent> <task>");
  } else {
    for (const d of dels.slice(0, 8)) {
      const mark = d.complete ? "✓" : "⋯";
      const cost = d.complete ? costUsd(d.costUsd) : "running";
      const task = d.task.replace(/\s+/g, " ").slice(0, 38);
      out.push(
        `  ${mark} ${(d.agent ?? "?").padEnd(12)} ${cost.padEnd(9)} ${task}`,
      );
    }
    const dangling = dels.filter((d) => !d.complete).length;
    if (dangling > 0) {
      out.push("");
      out.push(
        `  ${dangling} delegation${dangling === 1 ? "" : "s"} started but never reported back.`,
      );
      out.push(`  Usually means an agent was interrupted mid-task.`);
    }
  }
  out.push("");

  // ---- Audit ---------------------------------------------------------
  out.push(rule("Audit"));
  const audit = state.audits?.[0];
  if (!audit) {
    out.push("  Never audited.  /audit");
  } else {
    out.push(
      `  ${ago(audit.ts)} · ${audit.findings.length} finding${audit.findings.length === 1 ? "" : "s"}`,
    );
    for (const f of audit.findings.slice(0, 4)) {
      out.push(`  · ${f.category}: ${f.summary.slice(0, WIDTH - 16)}`);
    }
  }
  out.push("");

  // ---- Totals --------------------------------------------------------
  const total = state.rollup?.totalUsd ?? 0;
  const count = state.rollup?.delegationCount ?? 0;
  out.push(rule());
  out.push(
    `  ${agents.length} agent${agents.length === 1 ? "" : "s"} · ${compactUsd(total)} today · ${count} delegation${count === 1 ? "" : "s"}`,
  );

  // ---- What to do next ------------------------------------------------
  // One concrete action, not a menu. Someone reading this should never have
  // to work out what the tool wants from them.
  const step = nextStep(state);
  out.push("");
  const marker = step.urgency === "critical" ? "!!" : step.urgency === "blocked" ? "!" : "•";
  out.push(`  ${marker} ${step.line}`);
  if (step.because) pushWrapped(out, step.because, "     ");

  return out.join("\n");
}
