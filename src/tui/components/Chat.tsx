/**
 * The chat: a conversation with the org's chief of staff.
 *
 * The screen has three parts. The conversation fills the left, read from
 * the ledger, with the reply in progress streaming at the bottom. The team
 * sits on the right with every agent's provider and a spinner while one
 * runs, so a hire or a delegation shows up there as it happens. The input
 * runs along the bottom.
 *
 * Keys stay out of the way of typing. Every printable key goes into the
 * message. Enter sends it. The arrows scroll. The few commands are control
 * keys, which a sentence never contains, and esc goes back to the
 * dashboard with the draft kept.
 *
 * The draft is held in a ref and edited by one input handler, rather than
 * by a controlled text field. A controlled field computes each keystroke
 * from the value of the last render. Typing fast, or pasting a line that
 * ends in a newline, then sends a message a render behind what was typed.
 *
 * Nothing here writes. Sending, switching the chief's provider or level,
 * and starting a new conversation are callbacks into the dashboard, which
 * owns the runs and the ledger writes.
 */

import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";

import { describeAllowance, staffingFor, type Allowance, type Conversation } from "../../core/chat.js";
import type { Readiness } from "../../core/setup.js";
import type { Task } from "../../core/tasks.js";
import type { AgentRecord } from "../../core/types.js";
import { isEscape, isReturn, printablePart } from "../keys.js";
import { clipRow, transcriptRows, type Row } from "../chat.js";
import { autonomyColor, clamp, compactBudget, costUsd, fit, providerColor, shortModel } from "../format.js";
import type { RunState } from "../runs.js";

export type ChatProps = {
  chief: AgentRecord;
  conv: Conversation | null;
  /** What the chief may still give other agents. */
  allowance: Allowance | null;
  agents: AgentRecord[];
  tasks: Task[];
  /** The chief's run in this workspace, live or just settled. */
  live: RunState | null;
  running: Set<string>;
  readiness: Readiness[];
  /** What was typed before the chat was last closed. */
  initialDraft: string;
  /** Keeps the draft for the next time the chat opens. */
  onDraft: (next: string) => void;
  /** The last mutation's result, shown in place of the key legend. */
  flash: { text: string; tone: "ok" | "error" } | null;
  width: number;
  height: number;
  now: number;
  spinner: string;
  /** Send a message. Returns false when it was refused, so the draft stays. */
  onSend: (text: string) => boolean;
  onClose: () => void;
  onNew: () => void;
  onCycleProvider: () => void;
  onCycleLevel: () => void;
};

const EXAMPLES = [
  "Who is on the team, and what is each one doing?",
  "Fix the flaky retry test on codex, and have gemini review the fix.",
  "Hire a scout on claude with a $3 budget to map the payments module.",
];

function RowView({ row, width }: { row: Row; width: number }) {
  const segs = clipRow(row, width);
  if (segs.length === 0) return <Text> </Text>;
  return (
    <Text wrap="truncate">
      {segs.map((s, i) => (
        <Text key={i} color={s.color} dimColor={s.dim} bold={s.bold}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

/** What an empty conversation shows: who the chief is, and three things to try. */
function welcomeRows(chief: AgentRecord, width: number): Row[] {
  const policy = staffingFor(chief.autonomy);
  const rows: Row[] = [
    [],
    [
      { text: "  ◆ ", color: providerColor(chief.provider), bold: true },
      { text: chief.name, bold: true },
      { text: ", chief of staff", dim: true },
    ],
    [],
    [
      { text: "  Runs on ", dim: true },
      { text: chief.provider, color: providerColor(chief.provider) },
      { text: ` ${shortModel(chief.model)}`, dim: true },
      { text: ". At ", dim: true },
      { text: chief.autonomy, color: autonomyColor(chief.autonomy) },
      { text: ` the chief ${policy.label}.`, dim: true },
    ],
    [{ text: "  Say what needs doing, and which provider should do which part.", dim: true }],
    [{ text: "  The chief hires, sets budgets from an allowance, and hands out the work.", dim: true }],
    [{ text: "  The chief's own replies have no cap. Every hire, task and dollar lands in the ledger.", dim: true }],
    [],
    [{ text: "  Try", bold: true }],
    ...EXAMPLES.map((e): Row => [{ text: "    " }, { text: e, color: "white" }]),
  ];
  return rows.map((r) => clipRow(r, width));
}

export function Chat(props: ChatProps) {
  const { chief, conv, width, height, now, spinner, live } = props;

  // Rows scrolled up from the bottom. Zero follows the stream.
  const [scroll, setScroll] = useState(0);
  const turnCount = conv?.turns.length ?? 0;
  const lastTurns = useRef(turnCount);
  useEffect(() => {
    if (turnCount !== lastTurns.current) {
      lastTurns.current = turnCount;
      setScroll(0);
    }
  }, [turnCount]);

  const replying = Boolean(live && live.status === "running");

  const draft = useRef(props.initialDraft);
  const caret = useRef(props.initialDraft.length);
  const [, redraw] = useState(0);
  const edit = (value: string, at: number) => {
    draft.current = value;
    caret.current = clamp(at, 0, value.length);
    redraw((n) => n + 1);
    props.onDraft(value);
  };

  // Layout: the team column earns its width on a wide terminal only.
  const teamWidth = width >= 96 ? clamp(Math.floor(width * 0.27), 28, 38) : 0;
  const chatWidth = width - teamWidth;
  const inner = chatWidth - 4;
  const mainHeight = Math.max(8, height - 4);
  const bodyHeight = Math.max(3, mainHeight - 4);

  const rows = useMemo(
    () =>
      turnCount === 0
        ? welcomeRows(chief, inner)
        : transcriptRows({ conv, chief, agents: props.agents, tasks: props.tasks, live, running: props.running, width: inner, now, spinner }),
    [turnCount, conv, chief, props.agents, props.tasks, live, props.running, inner, now, spinner],
  );

  const maxScroll = Math.max(0, rows.length - bodyHeight);
  const offset = Math.min(scroll, maxScroll);
  const end = rows.length - offset;
  const shown = rows.slice(Math.max(0, end - bodyHeight), end);
  const above = Math.max(0, end - bodyHeight);

  useInput((input, key) => {
    if (isEscape(input, key)) {
      props.onClose();
      return;
    }
    if (key.ctrl && input === "n") {
      props.onNew();
      return;
    }
    if (key.ctrl && input === "p") {
      props.onCycleProvider();
      return;
    }
    if (key.ctrl && input === "l") {
      props.onCycleLevel();
      return;
    }
    if (key.upArrow) {
      setScroll((s) => Math.min(maxScroll, s + 1));
      return;
    }
    if (key.downArrow) {
      setScroll((s) => Math.max(0, s - 1));
      return;
    }
    if (key.pageUp) {
      setScroll((s) => Math.min(maxScroll, s + bodyHeight - 1));
      return;
    }
    if (key.pageDown) {
      setScroll((s) => Math.max(0, s - bodyHeight + 1));
      return;
    }
    if (key.leftArrow) {
      caret.current = Math.max(0, caret.current - 1);
      redraw((n) => n + 1);
      return;
    }
    if (key.rightArrow) {
      caret.current = Math.min(draft.current.length, caret.current + 1);
      redraw((n) => n + 1);
      return;
    }
    const value = draft.current;
    const at = Math.min(caret.current, value.length);
    if (key.backspace || key.delete) {
      if (at > 0) edit(value.slice(0, at - 1) + value.slice(at), at - 1);
      return;
    }
    if (key.ctrl) {
      if (input === "a") caret.current = 0;
      else if (input === "e") caret.current = value.length;
      else if (input === "u") return edit(value.slice(at), 0);
      else if (input === "k") return edit(value.slice(0, at), at);
      else if (input === "w") {
        const head = value.slice(0, at).replace(/\S+\s*$/, "");
        return edit(head + value.slice(at), head.length);
      }
      redraw((n) => n + 1);
      return;
    }

    // Printable text first, then a newline in the same chunk sends it. A
    // paste of one line with its newline arrives as a single chunk.
    const typed = printablePart(input);
    let next = value;
    if (typed) {
      next = value.slice(0, at) + typed + value.slice(at);
      edit(next, at + typed.length);
    }
    if (isReturn(input, key)) {
      const text = next.trim();
      if (text && props.onSend(text)) edit("", 0);
    }
  });

  // Header: who the chief is and what the chief may do, then what it spent.
  const policy = staffingFor(chief.autonomy);
  const spend = props.allowance ? describeAllowance(props.allowance) : `${costUsd(chief.spentUsd)} spent`;
  const headLeft: Row = [
    { text: "◆ ", color: providerColor(chief.provider), bold: true },
    { text: chief.name, bold: true },
    { text: "  " },
    { text: chief.provider, color: providerColor(chief.provider) },
    { text: ` ${shortModel(chief.model)}`, dim: true },
    { text: "  ·  ", dim: true },
    { text: chief.autonomy, color: autonomyColor(chief.autonomy) },
    { text: `, ${policy.label}`, dim: true },
  ];
  const headClipped = clipRow(headLeft, Math.max(0, inner - spend.length - 1));
  const headRow: Row = [...headClipped, { text: " ".repeat(Math.max(1, inner - rowLen(headClipped) - spend.length)) }, { text: spend, dim: true }];
  const ruleLabel = above > 0 ? `── ${above} more above · ↑ scrolls ` : "";
  const rule = ruleLabel + "─".repeat(Math.max(0, inner - ruleLabel.length));

  const frame = providerColor(chief.provider);

  return (
    <Box flexDirection="column" width={width}>
      <Box height={mainHeight}>
        <Box
          width={chatWidth}
          height={mainHeight}
          borderStyle="round"
          borderColor={frame}
          paddingX={1}
          flexDirection="column"
        >
          <RowView row={headRow} width={inner} />
          <Text dimColor>{rule.slice(0, inner)}</Text>
          <Box flexDirection="column" height={bodyHeight}>
            {shown.map((row, i) => (
              <RowView key={i} row={row} width={inner} />
            ))}
          </Box>
        </Box>

        {teamWidth > 0 ? (
          <TeamPanel {...props} width={teamWidth} height={mainHeight} />
        ) : null}
      </Box>

      <Box borderStyle="round" borderColor={replying ? "gray" : "cyan"} paddingX={1} width={width}>
        <Text color={replying ? "gray" : "cyan"} bold>
          {"❯ "}
        </Text>
        <DraftLine
          value={draft.current}
          caret={caret.current}
          width={width - 7}
          placeholder={replying ? `${chief.name} is replying. Keep typing; enter sends once the reply ends.` : "Ask the chief of staff, or say what needs doing"}
        />
      </Box>

      {props.flash ? (
        <Text color={props.flash.tone === "error" ? "red" : "green"}>{fit(props.flash.text, width)}</Text>
      ) : (
        <Legend width={width} />
      )}
    </Box>
  );
}

/** The draft with its caret, scrolled so the caret stays in view. */
function DraftLine({ value, caret, width, placeholder }: { value: string; caret: number; width: number; placeholder: string }) {
  const inner = Math.max(4, width);
  if (value.length === 0) {
    return (
      <Text>
        <Text inverse> </Text>
        <Text dimColor>{fit(placeholder, inner - 1)}</Text>
      </Text>
    );
  }
  const at = Math.min(caret, value.length);
  const start = at >= inner ? at - inner + 1 : 0;
  const view = value.slice(start, start + inner).padEnd(inner);
  const c = at - start;
  return (
    <Text>
      <Text>{view.slice(0, c)}</Text>
      <Text inverse>{view.slice(c, c + 1)}</Text>
      <Text>{view.slice(c + 1)}</Text>
    </Text>
  );
}

function rowLen(row: Row): number {
  return row.reduce((n, s) => n + s.text.length, 0);
}

function Legend({ width }: { width: number }) {
  const items: Array<[string, string]> = [
    ["enter", "send"],
    ["↑↓", "scroll"],
    ["ctrl-n", "new conversation"],
    ["ctrl-p", "provider"],
    ["ctrl-l", "level"],
    ["esc", "dashboard"],
  ];
  const out: Row = [];
  for (const [k, v] of items) {
    const piece = `${out.length > 0 ? "  " : " "}${k} ${v}`;
    if (rowLen(out) + piece.length > width) break;
    out.push({ text: `${out.length > 0 ? "  " : " "}` }, { text: k, color: "cyan" }, { text: ` ${v}`, dim: true });
  }
  return <RowView row={out} width={width} />;
}

function TeamPanel(props: ChatProps & { width: number; height: number }) {
  const { agents, chief, conv, running, spinner, width, height, readiness } = props;
  const inner = width - 4;
  const ordered = [chief, ...agents.filter((a) => a.name !== chief.name)];
  const nameWidth = clamp(Math.max(...ordered.map((a) => a.name.length)), 6, 14);

  const rows: Row[] = [];
  rows.push([{ text: `Team · ${agents.length}`, color: "cyan", bold: true }]);
  const room = Math.max(1, height - 2 - 1 - 9);
  for (const a of ordered.slice(0, room)) {
    const busy = running.has(a.name);
    rows.push([
      { text: a.chief ? "◆ " : "● ", color: providerColor(a.provider) },
      { text: a.name.slice(0, nameWidth).padEnd(nameWidth + 1), bold: a.chief },
      { text: a.provider.padEnd(7), color: providerColor(a.provider) },
      busy ? { text: `${spinner} `, color: "yellow", bold: true } : { text: "  " },
      { text: costUsd(a.spentUsd), dim: true },
    ]);
  }
  if (ordered.length > room) rows.push([{ text: `  +${ordered.length - room} more`, dim: true }]);

  rows.push([]);
  rows.push([{ text: "This conversation", color: "cyan", bold: true }]);
  const replies = conv?.turns.length ?? 0;
  rows.push([
    { text: "replies  ".padEnd(9), dim: true },
    { text: costUsd(conv?.chiefCostUsd ?? 0) },
    { text: ` · ${replies}`, dim: true },
  ]);
  rows.push([
    { text: "team".padEnd(9), dim: true },
    { text: costUsd(conv?.teamCostUsd ?? 0) },
    { text: ` · ${conv?.teamRuns ?? 0} run${conv?.teamRuns === 1 ? "" : "s"}`, dim: true },
  ]);

  if (props.allowance) {
    rows.push([]);
    rows.push([{ text: "Allowance", color: "cyan", bold: true }]);
    const whole = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
    rows.push([{ text: "given    ", dim: true }, { text: whole(props.allowance.givenUsd) }, { text: ` of ${whole(props.allowance.totalUsd)}`, dim: true }]);
    rows.push([{ text: "left     ", dim: true }, { text: whole(props.allowance.leftUsd), color: props.allowance.leftUsd > 0 ? "green" : "yellow" }]);
    rows.push([{ text: "b on the chief sets it", dim: true }]);
  }

  rows.push([]);
  rows.push([{ text: "Providers", color: "cyan", bold: true }]);
  for (const r of readiness) {
    rows.push([
      { text: r.provider.padEnd(8), color: providerColor(r.provider) },
      r.ready ? { text: "ready", color: "green" } : { text: "not ready", color: "yellow" },
    ]);
  }

  return (
    <Box width={width} height={height} borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
      {rows.slice(0, height - 2).map((row, i) => (
        <RowView key={i} row={row} width={inner} />
      ))}
    </Box>
  );
}

export default Chat;
