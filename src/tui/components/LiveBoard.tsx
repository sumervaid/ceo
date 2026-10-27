/**
 * The live view: the org at work, one column per provider.
 *
 * Every agent is a card in its provider's column: what it is doing now,
 * the tool it last used, the last thing it said. Under the columns runs the
 * exchanges strip: every note, question, answer and handoff between agents,
 * oldest at the top, each name in its provider's colour. A note from a
 * codex agent to a gemini agent reads green to blue on one line. That line
 * is the cross-provider collaboration, made visible.
 *
 * Nothing here writes. The cards read the dashboard's own runs. The strip
 * reads the board and the queue from the ledger.
 */

import { Box, Text } from "ink";

import type { OrgMessage } from "../../core/collab.js";
import type { Task } from "../../core/tasks.js";
import { PROVIDERS, type AgentRecord, type Provider } from "../../core/types.js";
import { activityFor, clipRow, type Row } from "../chat.js";
import { clock, costUsd, fit, providerColor, shortModel } from "../format.js";
import type { RunState } from "../runs.js";

export type LiveBoardProps = {
  workspaceName: string;
  agents: AgentRecord[];
  /** The dashboard's runs in this workspace, oldest first. */
  runs: RunState[];
  /** The board, newest first. */
  messages: OrgMessage[];
  tasks: Task[];
  flash: { text: string; tone: "ok" | "error" } | null;
  width: number;
  height: number;
  now: number;
  spinner: string;
};

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

function width(row: Row): number {
  return row.reduce((n, s) => n + s.text.length, 0);
}

/** Left and right parts on one line, the right part flush to the edge. */
function spread(left: Row, right: Row, w: number): Row {
  const l = clipRow(left, Math.max(0, w - width(right) - 1));
  return [...l, { text: " ".repeat(Math.max(1, w - width(l) - width(right))) }, ...right];
}

/** The last line an agent wrote, for the card's quote. */
function lastWords(run: RunState): string {
  for (let i = run.lines.length - 1; i >= 0; i--) {
    const l = run.lines[i];
    if (l.kind !== "text") continue;
    const line = l.text.split("\n").map((x) => x.trim()).filter(Boolean).pop();
    if (line) return line;
  }
  return "";
}

/** The last tool an agent used, said as an activity. */
function lastAction(run: RunState): string {
  for (let i = run.lines.length - 1; i >= 0; i--) {
    const l = run.lines[i];
    if (l.kind === "tool") {
      const org = /(^|\b)(mcp__org__|org\.)?(org_[a-z_]+)/.exec(l.text);
      if (org) {
        const target = l.text.split(" ").slice(1).join(" ");
        return `${activityFor(org[3])}${target ? ` ${target}` : ""}`;
      }
      return l.text;
    }
    if (l.kind === "denied") return `refused: ${l.text}`;
  }
  return "";
}

function card(agent: AgentRecord, run: RunState | undefined, w: number, now: number, spinner: string): Row[] {
  const on = run?.status === "running" && run.provider ? run.provider : agent.provider;
  const color = providerColor(on);
  const mark: Row = [
    { text: agent.chief ? "◆ " : "● ", color, bold: true },
    { text: agent.name, bold: true },
  ];
  let status: Row;
  if (run?.status === "running") {
    const secs = Math.max(0, Math.floor((now - run.startedAt) / 1000));
    status = [{ text: `${spinner} `, color: "yellow", bold: true }, { text: `turn ${run.turns} · ${secs}s`, color: "yellow" }];
  } else if (run?.status === "done") {
    status = [{ text: "✓ ", color: "green" }, { text: `${costUsd(run.costUsd)}${run.costIsEstimate ? " est." : ""}`, dim: true }];
  } else if (run?.status === "failed") {
    status = [{ text: "✗ failed", color: "red" }];
  } else if (run?.status === "cancelled") {
    status = [{ text: "cancelled", dim: true }];
  } else {
    status = [{ text: `idle · ${costUsd(agent.spentUsd)}`, dim: true }];
  }
  const rows: Row[] = [spread(mark, status, w)];
  if (run) {
    const away = on !== agent.provider ? ` · usually ${agent.provider}` : "";
    rows.push([{ text: `  ${fit(`${run.task}${away}`, w - 2)}`, dim: true }]);
    const action = lastAction(run);
    const words = lastWords(run);
    rows.push(action ? [{ text: "  › ", dim: true }, { text: fit(action, w - 4), dim: true }] : []);
    rows.push(words ? [{ text: `  "${fit(words, w - 4).trimEnd()}"` }] : []);
  } else {
    rows.push([{ text: `  ${fit(`${shortModel(agent.model)} · ${agent.autonomy}`, w - 2)}`, dim: true }]);
  }
  return rows.map((r) => clipRow(r, w));
}

type Exchange = { ts: number; from: string; to: string; text: string; kind: "note" | "ask" | "reply" | "handoff" | "delegate" };

const KIND_COLOR: Record<Exchange["kind"], string | undefined> = {
  note: undefined,
  ask: "yellow",
  reply: "green",
  handoff: "cyan",
  delegate: "cyan",
};

function exchanges(messages: OrgMessage[], tasks: Task[]): Exchange[] {
  const out: Exchange[] = [];
  for (const m of messages) {
    out.push({
      ts: m.ts,
      from: m.from,
      to: m.to === "*" ? "everyone" : m.to,
      text: m.text,
      kind: m.askId ? "ask" : m.inReplyTo ? "reply" : "note",
    });
  }
  for (const t of tasks) {
    if (!t.requestedBy || !t.assignee) continue;
    out.push({ ts: t.createdAt, from: t.requestedBy, to: t.assignee, text: t.title, kind: t.autoStart ? "delegate" : "handoff" });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export function LiveBoard(props: LiveBoardProps) {
  const { agents, runs, width: W, height: H, now, spinner } = props;
  const inner = W - 4;

  const latest = new Map<string, RunState>();
  for (const r of runs) latest.set(r.agent, r);
  const running = runs.filter((r) => r.status === "running").length;

  const provider = new Map<string, Provider>(agents.map((a) => [a.name, a.provider]));
  const partyColor = (name: string): string => (name === "you" ? "magenta" : name === "everyone" ? "white" : providerColor(provider.get(name)));

  const all = exchanges(props.messages, props.tasks);
  const exHeight = Math.min(12, Math.max(6, Math.floor(H * 0.3)));
  const exRows = exHeight - 3;
  const mainHeight = Math.max(8, H - exHeight - 1);
  const bodyRows = mainHeight - 5;

  const gap = 3;
  const colWidth = Math.floor((inner - gap * (PROVIDERS.length - 1)) / PROVIDERS.length);

  // A run on another provider than the agent's own, "use gemini for this",
  // puts the card in that provider's column while the run is live.
  const columnOf = (a: AgentRecord): Provider => {
    const run = latest.get(a.name);
    return run?.status === "running" && run.provider ? run.provider : a.provider;
  };
  const columns = PROVIDERS.map((p) => {
    const members = agents.filter((a) => columnOf(a) === p).sort((a, b) => Number(Boolean(b.chief)) - Number(Boolean(a.chief)));
    const rows: Row[] = [];
    for (const a of members) {
      const c = card(a, latest.get(a.name), colWidth, now, spinner);
      if (rows.length + c.length > bodyRows) {
        rows.push([{ text: `+${members.length - members.indexOf(a)} more`, dim: true }]);
        break;
      }
      rows.push(...c, []);
    }
    if (members.length === 0) {
      rows.push([{ text: `nobody on ${p} yet`, dim: true }], [{ text: "v on the roster moves an agent here", dim: true }]);
    }
    return { p, members, rows };
  });

  const header = spread(
    [
      { text: "Live", color: "cyan", bold: true },
      { text: ` · ${props.workspaceName} · `, dim: true },
      { text: `${running} running`, color: running > 0 ? "yellow" : undefined, dim: running === 0 },
      { text: ` · ${all.length} exchange${all.length === 1 ? "" : "s"}`, dim: true },
    ],
    PROVIDERS.flatMap((p, i): Row => [
      ...(i > 0 ? [{ text: "  " }] : []),
      { text: "● ", color: providerColor(p) },
      { text: p, color: providerColor(p) },
    ]),
    inner,
  );

  const exShown = all.slice(-exRows);
  const nameWidth = Math.min(14, Math.max(4, ...exShown.flatMap((e) => [e.from.length, e.to.length])));

  return (
    <Box flexDirection="column" width={W}>
      <Box width={W} height={mainHeight} borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <RowView row={header} width={inner} />
        <Text> </Text>
        <Box>
          {columns.map((c, i) => (
            <Box key={c.p} width={colWidth + (i < columns.length - 1 ? gap : 0)} flexDirection="column">
              <RowView
                row={[
                  { text: c.p, color: providerColor(c.p), bold: true },
                  { text: `  ${c.members.length} agent${c.members.length === 1 ? "" : "s"}`, dim: true },
                ]}
                width={colWidth}
              />
              <Text color={providerColor(c.p)}>{"━".repeat(colWidth)}</Text>
              {c.rows.slice(0, bodyRows).map((row, j) => (
                <RowView key={j} row={row} width={colWidth} />
              ))}
            </Box>
          ))}
        </Box>
      </Box>

      <Box width={W} height={exHeight} borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
        <RowView
          row={spread(
            [{ text: "Exchanges", color: "cyan", bold: true }, { text: "  between agents, in provider colours", dim: true }],
            [{ text: "note · ", dim: true }, { text: "ask", color: "yellow" }, { text: " · ", dim: true }, { text: "reply", color: "green" }, { text: " · ", dim: true }, { text: "handoff", color: "cyan" }],
            inner,
          )}
          width={inner}
        />
        {exShown.length === 0 ? (
          <Text dimColor>No exchanges yet. Notes, questions and handoffs between agents appear here as they happen.</Text>
        ) : (
          exShown.map((e, i) => (
            <RowView
              key={i}
              row={[
                { text: `${clock(e.ts)}  `, dim: true },
                { text: e.from.padStart(nameWidth), color: partyColor(e.from), bold: true },
                { text: " › ", dim: true },
                { text: e.to.padEnd(nameWidth), color: partyColor(e.to), bold: true },
                { text: `  ${e.kind.padEnd(10)}`, color: KIND_COLOR[e.kind], dim: e.kind === "note" },
                { text: e.text.replace(/\s+/g, " ") },
              ]}
              width={inner}
            />
          ))
        )}
      </Box>

      {props.flash ? (
        <Text color={props.flash.tone === "error" ? "red" : "green"}>{fit(props.flash.text, W)}</Text>
      ) : (
        <RowView
          row={[
            { text: " esc", color: "cyan" },
            { text: " dashboard  ", dim: true },
            { text: "C", color: "cyan" },
            { text: " chat with the chief  ", dim: true },
            { text: "L", color: "cyan" },
            { text: " closes", dim: true },
          ]}
          width={W}
        />
      )}
    </Box>
  );
}

export default LiveBoard;
