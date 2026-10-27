/**
 * The workspace sidebar: every org this user runs, one line each.
 *
 * The dashboard used to be one repo at a time, which meant the answer to
 * "is anything running anywhere" was to quit and open it somewhere else.
 * This column is that answer. Each row is a registered workspace with the
 * three things that decide whether to look at it: is something running,
 * is something waiting, is something wrong.
 *
 * Row anatomy:
 *
 *   ❯ ● api            ⠋2 ·3  $1.20
 *     ○ docs                  $0.00
 *     ! infra         ⚠1      $0.42
 *
 * The leading dot is the org's health: green is fine, yellow is work
 * waiting, red is a broken chain or a dangling run. The spinner and count
 * are runs in flight in *this* dashboard. The ·N is the queue depth. The
 * money is today's spend from that workspace's own ledger. Nothing here is a
 * second source of truth: it is all read off each repo's `.ceo/` by
 * `workspaces.ts`.
 *
 * Selection is the workspace the main view shows. The column is narrow on
 * purpose: it is a switcher, not a dashboard. It drops columns from the
 * right when the terminal is tight, keeping the name and the health dot.
 */

import { Box, Text } from "ink";
import { clamp, compactUsd, fit } from "../format.js";
import type { WorkspaceSummary } from "../workspaces.js";

export type SidebarProps = {
  workspaces: WorkspaceSummary[];
  /** Path of the workspace on screen. */
  activePath: string;
  /** Runs in flight per workspace path, from this dashboard. */
  running: Map<string, number>;
  /** Inner content width, borders and padding already subtracted. */
  width: number;
  height: number;
  /** Whether keys go to this column right now. */
  focused: boolean;
  spinner: string;
};

export function Sidebar({
  workspaces,
  activePath,
  running,
  width,
  height,
  focused,
  spinner,
}: SidebarProps) {
  if (workspaces.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{fit("No workspaces yet.", width)}</Text>
        <Text dimColor>{fit("w to add one.", width)}</Text>
      </Box>
    );
  }

  const selected = Math.max(0, workspaces.findIndex((w) => w.path === activePath));
  const overflowing = workspaces.length > Math.max(1, height);
  const visible = Math.max(1, overflowing ? height - 1 : height);
  const start = clamp(
    selected - Math.floor(visible / 2),
    0,
    Math.max(0, workspaces.length - visible),
  );
  const rows = workspaces.slice(start, start + visible);
  const hidden = workspaces.length - rows.length;

  const nameWidth = clamp(Math.max(...workspaces.map((w) => w.name.length)), 4, 18);

  return (
    <Box flexDirection="column">
      {rows.map((ws, i) => (
        <Row
          key={ws.path}
          ws={ws}
          selected={start + i === selected}
          focused={focused}
          runs={running.get(ws.path) ?? 0}
          nameWidth={nameWidth}
          width={width}
          spinner={spinner}
        />
      ))}
      {hidden > 0 ? <Text dimColor>{`  +${hidden} more`}</Text> : null}
    </Box>
  );
}

type Cell = { text: string; color?: string; dim?: boolean; bold?: boolean };

/**
 * A delegation with a start and no end is "dangling" in the ledger, but
 * while this dashboard is the process running it, it is simply in flight.
 * Only the remainder, the starts nobody here owns, is the interrupted kind.
 */
function stuckCount(ws: WorkspaceSummary, runs: number): number {
  return Math.max(0, ws.dangling - runs);
}

function healthOf(ws: WorkspaceSummary, runs: number): { glyph: string; color: string } {
  if (!ws.present) return { glyph: "✗", color: "red" };
  if (!ws.hasOrg) return { glyph: "○", color: "gray" };
  if (!ws.chainOk) return { glyph: "!", color: "red" };
  if (stuckCount(ws, runs) > 0) return { glyph: "!", color: "red" };
  if (ws.waiting > 0) return { glyph: "●", color: "yellow" };
  return { glyph: "●", color: "green" };
}

function Row({
  ws,
  selected,
  focused,
  runs,
  nameWidth,
  width,
  spinner,
}: {
  ws: WorkspaceSummary;
  selected: boolean;
  focused: boolean;
  runs: number;
  nameWidth: number;
  width: number;
  spinner: string;
}) {
  const health = healthOf(ws, runs);
  const stuck = stuckCount(ws, runs);
  const inverse = selected && focused;

  // Left to right, dropped from the right as the column narrows. The name
  // and the health dot are the floor: a sidebar that cannot show which repo
  // a row is has nothing to say.
  const groups: Cell[][] = [
    [{ text: selected ? "❯ " : "  ", bold: true, color: selected ? "cyan" : undefined }],
    [{ text: `${health.glyph} `, color: health.color }],
    [{ text: ws.name.slice(0, nameWidth).padEnd(nameWidth + 1), bold: selected }],
    [
      runs > 0
        ? { text: `${spinner}${runs} `, color: "yellow", bold: true }
        : { text: "   ", dim: true },
    ],
    [
      ws.waiting > 0
        ? { text: `·${ws.waiting} `.padEnd(4), color: "yellow" }
        : { text: "    ", dim: true },
    ],
    [
      stuck > 0
        ? { text: `⚠${stuck} `, color: "red" }
        : { text: "   ", dim: true },
    ],
    [{ text: ws.hasOrg ? compactUsd(ws.spendTodayUsd) : "no org", dim: !ws.hasOrg, color: ws.hasOrg ? undefined : "gray" }],
  ];

  const kept: Cell[] = [];
  let used = 0;
  for (const group of groups) {
    const w = group.reduce((n, c) => n + c.text.length, 0);
    if (used + w > width) break;
    kept.push(...group);
    used += w;
  }
  const tail = " ".repeat(Math.max(0, width - used));

  return (
    <Box>
      {kept.map((cell, i) => (
        <Text
          key={i}
          color={cell.color}
          dimColor={cell.dim}
          bold={cell.bold}
          inverse={inverse}
        >
          {cell.text}
        </Text>
      ))}
      {tail ? <Text inverse={inverse}>{tail}</Text> : null}
    </Box>
  );
}

export default Sidebar;
