/**
 * Delegation feed, newest at the bottom.
 *
 * Reads like a log because that is how it is used: you glance at it while
 * something is running and want the last line to be the thing that just
 * happened. `recentDelegations` hands back newest-first, so the tail is
 * sliced before the list is reversed for display.
 *
 * An unfinished delegation shows a "⋯" instead of a cost. That is not a
 * cosmetic state. A start with no end is an agent that was cut off, and it
 * is the signal the auditor keys on.
 */

import { Box, Text } from "ink";
import type { OrgMessage } from "../../core/collab.js";
import type { Delegation } from "../data.js";
import { clamp, clock, costUsd, fit, secs } from "../format.js";

export type ActivityProps = {
  /** Newest first, as `recentDelegations` returns them. */
  delegations: Delegation[];
  /** Notes on the board, newest first. Shown in the feed where they happened. */
  messages?: OrgMessage[];
  /** Inner content width, borders and padding already subtracted. */
  width: number;
  /** Rows available for entries. */
  height: number;
};

type Entry = { kind: "run"; ts: number; d: Delegation } | { kind: "note"; ts: number; m: OrgMessage };

export function Activity({ delegations, messages = [], width, height }: ActivityProps) {
  if (delegations.length === 0 && messages.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Nothing delegated yet.</Text>
        <Text dimColor>Press d to give an agent a task.</Text>
      </Box>
    );
  }

  const visible = Math.max(1, height);
  const entries: Entry[] = [
    ...delegations.map((d): Entry => ({ kind: "run", ts: d.ts, d })),
    ...messages.map((m): Entry => ({ kind: "note", ts: m.ts, m })),
  ]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, visible)
    .reverse();

  const nameWidth = clamp(
    Math.max(...entries.map((e) => (e.kind === "run" ? e.d.agent ?? "?" : e.m.from).length)),
    4,
    14,
  );

  return (
    <Box flexDirection="column">
      {entries.map((e) =>
        e.kind === "run" ? (
          <Row key={`${e.d.id}-${e.d.ts}`} delegation={e.d} nameWidth={nameWidth} width={width} />
        ) : (
          <NoteRow key={`m-${e.m.seq}`} message={e.m} nameWidth={nameWidth} width={width} />
        ),
      )}
    </Box>
  );
}

/** A note on the board: who, to whom, what. Cyan so it reads as talk, not work. */
function NoteRow({ message: m, nameWidth, width }: { message: OrgMessage; nameWidth: number; width: number }) {
  const time = `${clock(m.ts)} `;
  const name = `${m.from.slice(0, nameWidth).padEnd(nameWidth)} `;
  const mark = "✉ ";
  const to = `${m.to === "*" ? "all" : m.to} `;
  // The envelope is double-width in most terminals; `.length` says one.
  const used = time.length + name.length + mark.length + 1 + to.length;
  return (
    <Box>
      <Text dimColor>{time}</Text>
      <Text>{name}</Text>
      <Text color="cyan">{mark}</Text>
      <Text color="cyan">{to}</Text>
      {width - used > 3 ? <Text dimColor>{fit(m.text.replace(/\s+/g, " "), width - used)}</Text> : null}
    </Box>
  );
}

function Row({
  delegation: d,
  nameWidth,
  width,
}: {
  delegation: Delegation;
  nameWidth: number;
  width: number;
}) {
  const time = `${clock(d.ts)} `;
  const name = `${(d.agent ?? "?").slice(0, nameWidth).padEnd(nameWidth)} `;
  const mark = d.complete ? "✓ " : "⋯ ";
  const cost = d.complete ? costUsd(d.costUsd).padEnd(8) : "running ";

  const used = time.length + name.length + mark.length + cost.length;
  const taskWidth = width - used;

  return (
    <Box>
      <Text dimColor>{time}</Text>
      <Text>{name}</Text>
      <Text color={d.complete ? "green" : "yellow"}>{mark}</Text>
      <Text color={d.complete ? undefined : "yellow"} dimColor={!d.complete}>
        {cost}
      </Text>
      {taskWidth > 3 ? (
        <Text dimColor>
          {fit(d.complete ? `${d.task} · ${secs(d.durationMs)}` : d.task, taskWidth)}
        </Text>
      ) : null}
    </Box>
  );
}

export default Activity;
