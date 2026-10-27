/**
 * The org, one agent per line.
 *
 * A roster line has to answer four questions at a glance: is this agent
 * healthy, what is it costing, what is it allowed to do, and is its work
 * landing somewhere other than the main tree. Health is the leading dot, cost
 * is the spend column and its meter, permission is the three-letter autonomy
 * code, isolation is the branch marker.
 *
 * Autonomy outranks the meter in the drop order below. The meter is a second
 * rendering of a number already printed beside it. The autonomy code is the
 * only place on this screen that says whether an agent can write files at
 * all. That is not something a narrow terminal should silently hide.
 *
 * A spinner appears in its own column while an agent has a delegation in
 * flight. The column is reserved on every row for as long as anything is
 * running. A busy agent's line thus stays aligned with the rest of the org
 * instead of shifting two cells to the right of it.
 *
 * Columns are assembled at known widths and dropped from the right as the
 * panel narrows. A 40-column pane shows name and spend, an 80-column pane
 * shows everything, and nothing wraps in between.
 */

import { Box, Text } from "ink";
import type { AgentRecord } from "../../core/types.js";
import {
  autonomyColor,
  autonomyLevel,
  autonomyShort,
  budgetLevel,
  budgetRatio,
  clamp,
  compactBudget,
  compactUsd,
  levelColor,
  meter,
  providerColor,
  shortModel,
} from "../format.js";

const METER_WIDTH = 6;
const BRANCH_MARK = "⎇";

export type RosterProps = {
  agents: AgentRecord[];
  /** Index of the highlighted row. */
  selected: number;
  /** Inner content width, borders and padding already subtracted. */
  width: number;
  /** Rows available for agents. */
  height: number;
  /** Agents with a delegation in flight right now. */
  running?: Set<string>;
  /** Current spinner glyph, shared with the run pane so they turn together. */
  spinner?: string;
};

/** A row's cells, in render order. Each is dropped as a unit when it overflows. */
type Cell = { text: string; color?: string; dim?: boolean; bold?: boolean };

export function Roster({
  agents,
  selected,
  width,
  height,
  running,
  spinner = "⠋",
}: RosterProps) {
  if (agents.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>
          <Text color="cyan" bold>+</Text>
          <Text> start a company: a whole team in one keystroke</Text>
        </Text>
        <Text dimColor>p a suggested team from history · h hire one by hand</Text>
      </Box>
    );
  }

  // Keep the selection in view without jumping: centre it, then clamp so the
  // list never scrolls past either end. When the org overflows, one row is
  // given back to the "+N more" counter so the panel still fits its box.
  const overflowing = agents.length > Math.max(1, height);
  const visible = Math.max(1, overflowing ? height - 1 : height);
  const start = clamp(
    selected - Math.floor(visible / 2),
    0,
    Math.max(0, agents.length - visible),
  );
  const rows = agents.slice(start, start + visible);
  const hidden = agents.length - rows.length;

  // Columns are sized to the org, not to a guess: a roster of short names
  // leaves room for the model. One long name does not push every other
  // row's meter off the panel.
  const nameWidth = clamp(Math.max(...agents.map((a) => a.name.length)), 6, 16);
  const spendWidth = clamp(
    Math.max(...agents.map((a) => spendLabel(a).length)),
    8,
    16,
  );

  // The column only exists while something is running, and then it exists on
  // every row. Giving it only to the busy agent would shift that one line's
  // name and spend out of alignment with the rest of the org.
  const anyRunning = Boolean(running && running.size > 0);

  return (
    <Box flexDirection="column">
      {rows.map((agent, i) => (
        <AgentRow
          key={agent.name}
          agent={agent}
          selected={start + i === selected}
          nameWidth={nameWidth}
          spendWidth={spendWidth}
          width={width}
          runMark={
            anyRunning ? (running?.has(agent.name) ? `${spinner} ` : "  ") : null
          }
        />
      ))}
      {hidden > 0 ? <Text dimColor>{`  +${hidden} more`}</Text> : null}
    </Box>
  );
}

/** "$0.29/$5": spend against cap, at column width. */
function spendLabel(agent: AgentRecord): string {
  // The chief's replies are uncapped; the chief's budget field is an allowance.
  return `${compactUsd(agent.spentUsd)}/${compactBudget(capOf(agent))}`;
}

/** The cap an agent's runs are held to. Zero, uncapped, for the chief of staff. */
function capOf(agent: AgentRecord): number {
  return agent.chief ? 0 : agent.budgetUsd;
}

function AgentRow({
  agent,
  selected,
  nameWidth,
  spendWidth,
  width,
  runMark,
}: {
  agent: AgentRecord;
  selected: boolean;
  nameWidth: number;
  spendWidth: number;
  width: number;
  /** Spinner, blank spacer, or null when nothing in the org is running. */
  runMark: string | null;
}) {
  const level = budgetLevel(agent.spentUsd, capOf(agent));
  const color = levelColor(level);
  const ratio = budgetRatio(agent.spentUsd, capOf(agent));
  const bar = meter(ratio, METER_WIDTH);

  const level_ = autonomyLevel(agent.autonomy);

  // Priority order, left to right. Each group is atomic. The meter is two
  // differently-coloured runs, but half a meter reads as a full one, so it
  // fits or it goes. Everything from the first group that does not fit
  // onward is dropped, which puts the mandatory columns first: health, name,
  // spend, autonomy, then the meter, then isolation, then the model.
  // A run in flight goes second, ahead of everything except the selection
  // marker and the health dot. It is the only column that changes on its own,
  // and it is what tells you the spend beside it is about to move.
  const groups: Cell[][] = [
    [{ text: selected ? "❯ " : "  ", bold: true }],
    // The chief of staff is marked with a diamond, the same mark the chat uses.
    [{ text: agent.chief ? "◆ " : "● ", color }],
    ...(runMark ? [[{ text: runMark, color: "yellow", bold: true }]] : []),
    [{ text: agent.name.slice(0, nameWidth).padEnd(nameWidth + 1), bold: selected }],
    [{ text: spendLabel(agent).padEnd(spendWidth + 1), color }],
    [
      {
        text: `${autonomyShort(agent.autonomy)} `,
        color: autonomyColor(agent.autonomy),
        // Unattended merge rights are the one level worth a second glance.
        bold: level_ === "autonomous",
      },
    ],
    [
      { text: bar.filled, color },
      { text: `${bar.empty} `, dim: true },
    ],
    [agent.isolated ? { text: `${BRANCH_MARK} `, color: "cyan" } : { text: "  " }],
    // Provider before model: two orgs' worth of model ids look alike, and
    // which CLI a run goes through decides how its autonomy is enforced.
    [{ text: `${agent.provider ?? "claude"} `, color: providerColor(agent.provider) }],
    [{ text: shortModel(agent.model), dim: true }],
  ];

  const kept: Cell[] = [];
  let used = 0;
  for (const group of groups) {
    const w = group.reduce((n, c) => n + c.text.length, 0);
    if (used + w > width) break;
    kept.push(...group);
    used += w;
  }

  // Pad to the full width so the selection highlight covers the whole row
  // rather than stopping at the last glyph.
  const tail = " ".repeat(Math.max(0, width - used));

  return (
    <Box>
      {kept.map((cell, i) => (
        <Text
          key={i}
          color={cell.color}
          dimColor={cell.dim}
          bold={cell.bold}
          inverse={selected}
        >
          {cell.text}
        </Text>
      ))}
      {tail ? <Text inverse={selected}>{tail}</Text> : null}
    </Box>
  );
}

export default Roster;
