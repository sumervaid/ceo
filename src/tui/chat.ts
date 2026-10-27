/**
 * The chat's transcript, as rows of coloured segments.
 *
 * Kept apart from the component so the layout is a pure function of the
 * conversation, the queue and the live run, and so a spec can check what a
 * reply looks like without a terminal. The component only scrolls the rows
 * and draws them.
 *
 * A reply reads top down in the order things happened. The staffing comes
 * first: who was hired, on which provider, who got what, and where that
 * work stands now. The chief's words come after, then what the reply cost.
 * A hire or a delegation is a ledger event, not a sentence in the reply, so
 * it is drawn from the ledger and cannot be misreported by the model.
 */

import type { ChatAction, ChatTurn, Conversation } from "../core/chat.js";
import type { Task } from "../core/tasks.js";
import type { AgentRecord, Provider } from "../core/types.js";
import type { RunState } from "./runs.js";
import { costUsd, fit, providerColor, shortModel } from "./format.js";

export type Seg = {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
  inverse?: boolean;
};

export type Row = Seg[];

/** Cells a row occupies. Every glyph used here is one cell wide. */
export function rowWidth(row: Row): number {
  return row.reduce((n, s) => n + s.text.length, 0);
}

/** Cut a row to `width` cells, ellipsizing the segment that crosses the edge. */
export function clipRow(row: Row, width: number): Row {
  const out: Row = [];
  let used = 0;
  for (const s of row) {
    if (used >= width) break;
    const room = width - used;
    if (s.text.length <= room) {
      out.push(s);
      used += s.text.length;
    } else {
      out.push({ ...s, text: room <= 1 ? "…" : `${s.text.slice(0, room - 1)}…` });
      used = width;
    }
  }
  return out;
}

/** Light markdown for a terminal: bullets kept, emphasis markers and headings dropped. */
function clean(line: string): string {
  return line
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\s*[-*]\s+/, "• ");
}

/** Wrap text that may hold several paragraphs. Blank lines survive, once. */
export function paragraphs(text: string, width: number): string[] {
  const w = Math.max(8, width);
  const out: string[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = clean(raw.trimEnd());
    if (!line.trim()) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    const bullet = line.startsWith("• ");
    const words = (bullet ? line.slice(2) : line).split(/\s+/).filter(Boolean);
    const cont = bullet ? "  " : "";
    let cur = bullet ? "• " : "";
    let hasWord = false;
    for (const word of words) {
      const candidate = hasWord ? `${cur} ${word}` : `${cur}${word}`;
      if (candidate.length <= w) {
        cur = candidate;
        hasWord = true;
        continue;
      }
      if (hasWord) {
        out.push(cur);
        cur = cont;
      }
      // A word wider than the column is split, never dropped.
      let rest = word;
      while (cur.length + rest.length > w) {
        const room = Math.max(1, w - cur.length);
        out.push(cur + rest.slice(0, room));
        rest = rest.slice(room);
        cur = cont;
      }
      cur += rest;
      hasWord = true;
    }
    if (hasWord) out.push(cur);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/** What a tool call means, for the line under a reply that is still running. */
export function activityFor(tool: string): string {
  const name = tool.replace(/^(mcp__org__|org\.)/, "").split(" ")[0];
  const known: Record<string, string> = {
    org_roster: "reading the roster",
    org_providers: "checking which providers are ready",
    org_running: "checking who is busy",
    org_trace: "reading a teammate's trace",
    org_outputs: "reading the team's results",
    org_read_output: "reading a result",
    org_board: "reading the board",
    org_mission: "reading the mission",
    org_hire: "hiring",
    org_delegate: "giving out work",
    org_handoff: "queueing work",
    org_ask: "asking a teammate",
    org_post: "posting a note",
    org_fire: "firing",
  };
  return known[name] ?? `using ${name}`;
}

function statusOf(action: ChatAction, tasks: Map<string, Task>, running: Set<string>, spinner: string): Seg[] {
  const t = action.taskId ? tasks.get(action.taskId) : undefined;
  if (!t) return [{ text: "queued", dim: true }];
  switch (t.status) {
    case "running":
      return [{ text: `${spinner} running`, color: "cyan" }];
    case "queued":
      if (action.kind === "handoff") return [{ text: "waits for you", color: "yellow" }];
      return [{ text: running.has(t.assignee ?? "") ? "next in line" : "starting", dim: true }];
    case "blocked":
      return [{ text: "blocked", color: "yellow" }];
    case "done":
      return [{ text: "✓ ", color: "green" }, { text: costUsd(t.costUsd ?? 0), dim: true }];
    case "failed":
      return [{ text: "✗ failed", color: "red" }];
    case "cancelled":
      return [{ text: "cancelled", dim: true }];
  }
}

function actionRow(
  action: ChatAction,
  width: number,
  tasks: Map<string, Task>,
  running: Set<string>,
  spinner: string,
  nameWidth: number,
  providerOf: (agent: string) => Provider | undefined,
): Row {
  switch (action.kind) {
    case "hire":
      return clipRow(
        [
          { text: "+ ", color: "green", bold: true },
          { text: "hired ", dim: true },
          { text: action.agent, bold: true },
          { text: " on ", dim: true },
          { text: action.provider ?? "?", color: providerColor(action.provider ?? undefined) },
          { text: ` · ${action.text}`, dim: true },
        ],
        width,
      );
    case "delegate":
    case "handoff": {
      const status = statusOf(action, tasks, running, spinner);
      const statusWidth = rowWidth(status);
      // Every delegation says where it runs. A provider the operator named
      // for this task is bold, so "use gemini for this" can be seen to stick.
      const runsOn = action.provider ?? providerOf(action.agent);
      const head: Row = [
        { text: action.kind === "delegate" ? "▸ " : "◦ ", color: action.kind === "delegate" ? "cyan" : "yellow", bold: true },
        { text: action.agent.padEnd(nameWidth), bold: true },
        { text: " " },
        { text: (runsOn ?? "").padEnd(7), color: providerColor(runsOn), bold: Boolean(action.provider) },
        { text: " " },
      ];
      const room = Math.max(4, width - rowWidth(head) - statusWidth - 2);
      return clipRow([...head, { text: fit(action.text, room) }, { text: "  " }, ...status], width);
    }
    case "budget":
      return clipRow(
        [
          { text: "$ ", color: "yellow", bold: true },
          { text: action.agent, bold: true },
          { text: ` ${action.text}`, dim: true },
        ],
        width,
      );
    case "fire":
      return clipRow(
        [
          { text: "× ", color: "red", bold: true },
          { text: "fired ", dim: true },
          { text: action.agent, bold: true },
          ...(action.text ? [{ text: `: ${action.text}`, dim: true }] : []),
        ],
        width,
      );
    case "ask":
    case "post":
      return clipRow(
        [
          { text: action.kind === "ask" ? "? " : "› ", color: action.kind === "ask" ? "yellow" : undefined, dim: action.kind === "post" },
          { text: action.kind === "ask" ? "asked " : "note to ", dim: true },
          { text: action.agent === "*" ? "everyone" : action.agent, bold: true },
          { text: `: ${action.text.replace(/\s+/g, " ")}`, dim: true },
        ],
        width,
      );
  }
}

export type TranscriptInput = {
  conv: Conversation | null;
  chief: AgentRecord;
  /** The org, so each delegation can show the provider it runs on. */
  agents?: AgentRecord[];
  tasks: Task[];
  /** The chief's run in this workspace, live or just settled. */
  live: RunState | null;
  /** Agents with a run in flight. */
  running: Set<string>;
  width: number;
  now: number;
  spinner: string;
};

/** A label padded to the column, keeping its leading space, which `fit` would trim. */
function padLabel(s: string, width: number): string {
  return s.length >= width ? `${s.slice(0, width - 1)} ` : s.padEnd(width);
}

/** The label column: wide enough for "you" and the chief's name. */
export function labelWidth(chief: AgentRecord): number {
  return Math.min(16, Math.max(7, chief.name.length + 3));
}

function liveText(live: RunState): string {
  return live.lines.filter((l) => l.kind === "text").map((l) => l.text).join("");
}

function lastTool(live: RunState): string | null {
  for (let i = live.lines.length - 1; i >= 0; i--) {
    const l = live.lines[i];
    if (l.kind === "tool") return l.text;
    if (l.kind === "text" && l.text.trim()) return null;
  }
  return null;
}

/** Every row of the conversation, oldest first. */
export function transcriptRows(input: TranscriptInput): Row[] {
  const { conv, chief, width, spinner } = input;
  const L = labelWidth(chief);
  const body = Math.max(10, width - L);
  const pad = " ".repeat(L);
  const tasks = new Map(input.tasks.map((t) => [t.id, t]));
  const rows: Row[] = [];

  const turns = conv?.turns ?? [];
  turns.forEach((turn: ChatTurn, i) => {
    if (i > 0) rows.push([]);

    paragraphs(turn.message, body).forEach((line, j) => {
      rows.push([j === 0 ? { text: padLabel(" you", L), color: "magenta", bold: true } : { text: pad }, { text: line }]);
    });
    rows.push([]);

    const provider: Provider | undefined = turn.provider ?? undefined;
    const lines: Row[] = [];
    const nameWidth = Math.min(16, Math.max(0, ...turn.actions.filter((a) => a.kind === "delegate" || a.kind === "handoff").map((a) => a.agent.length)));
    const providerOf = (name: string) => input.agents?.find((x) => x.name === name)?.provider;
    for (const a of turn.actions) lines.push(actionRow(a, body, tasks, input.running, spinner, nameWidth, providerOf));
    if (turn.actions.length > 0) lines.push([]);

    const isLive = turn.status === "running" && input.live && input.live.status === "running";
    const text = isLive ? liveText(input.live!) : turn.reply;
    if (turn.status === "failed" || turn.status === "cancelled") {
      const reason = text.split("\n").find((l) => l.trim()) ?? turn.status;
      for (const line of paragraphs(reason.replace(/^\[|\]$/g, ""), body - 2)) lines.push([{ text: "✗ ", color: "red" }, { text: line, color: "red" }]);
    } else {
      for (const line of paragraphs(text, body)) lines.push([{ text: line }]);
    }

    if (turn.status === "running") {
      const elapsed = Math.max(0, Math.floor((input.now - (input.live?.startedAt ?? turn.ts)) / 1000));
      const tool = input.live ? lastTool(input.live) : null;
      lines.push([
        { text: `${spinner} `, color: providerColor(provider) },
        { text: `${tool ? activityFor(tool) : text ? "writing" : "thinking"} · ${elapsed}s`, dim: true },
      ]);
    } else {
      const est = turn.costIsEstimate ? " est." : "";
      lines.push([{ text: `${costUsd(turn.costUsd)}${est} · ${turn.provider ?? "?"} ${shortModel(turn.model ?? "")}`.trimEnd(), dim: true }]);
    }

    lines.forEach((row, j) => {
      const label: Seg = j === 0 ? { text: padLabel(` ${chief.name}`, L), color: providerColor(provider ?? chief.provider), bold: true } : { text: pad };
      rows.push(clipRow([label, ...row], width));
    });
  });

  return rows;
}
