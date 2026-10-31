/**
 * The work queue: what the org is supposed to be doing, in the order it will
 * do it.
 *
 * This replaces the activity feed as the dashboard's top-right panel. The
 * feed answered "what happened". The queue answers "what is happening, what
 * is next, and what cannot start". The third of those is the one that
 * matters. A blocked task is money not being spent on a thing you asked
 * for, and nothing else on the screen says so.
 *
 * Rows are grouped by the ledger's own ordering from `listTasks`: running,
 * then queued by priority, then blocked, then the settled ones newest first.
 * A blocked row carries its reason inline rather than a glyph you would have
 * to look up, because the reason is the action: "at its budget cap" means
 * press b, and "unassigned" means press e.
 *
 *   ⠋ 3f1a  refactorer  drop the legacy retry wrapper
 *   ▸ 8c02  researcher  !map every caller of parse()
 *   ⊘ b7e0  nobody      write the changelog · unassigned
 *   ✓ 14d9  refactorer  add retries to client       $0.06
 *   ✗ a0c3  researcher  summarise the RFC           $0.01
 */

import { Box, Text } from "ink";
import type { Task, TaskStatus } from "../../core/tasks.js";
import { clamp, costUsd, fit } from "../format.js";

export type QueueProps = {
  tasks: Task[];
  selected: number;
  width: number;
  height: number;
  focused: boolean;
  spinner: string;
};

export function statusGlyph(status: TaskStatus, spinner: string): { glyph: string; color: string } {
  switch (status) {
    case "running":
      return { glyph: spinner, color: "yellow" };
    case "verifying":
      return { glyph: "⚖", color: "magenta" };
    case "queued":
      return { glyph: "▸", color: "cyan" };
    case "blocked":
      return { glyph: "⊘", color: "red" };
    case "done":
      return { glyph: "✓", color: "green" };
    case "failed":
      return { glyph: "✗", color: "red" };
    case "cancelled":
      return { glyph: "⨯", color: "yellow" };
  }
}

export function Queue({ tasks, selected, width, height, focused, spinner }: QueueProps) {
  if (tasks.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{fit("Nothing queued.", width)}</Text>
        <Text dimColor>{fit("t adds a task · d delegates one now", width)}</Text>
      </Box>
    );
  }

  const overflowing = tasks.length > Math.max(1, height);
  const visible = Math.max(1, overflowing ? height - 1 : height);
  const start = clamp(
    selected - Math.floor(visible / 2),
    0,
    Math.max(0, tasks.length - visible),
  );
  const rows = tasks.slice(start, start + visible);
  const hidden = tasks.length - rows.length;

  const nameWidth = clamp(
    Math.max(...tasks.map((t) => (t.assignee ?? "nobody").length)),
    3,
    12,
  );

  return (
    <Box flexDirection="column">
      {rows.map((task, i) => (
        <Row
          key={task.id}
          task={task}
          selected={start + i === selected}
          focused={focused}
          nameWidth={nameWidth}
          width={width}
          spinner={spinner}
        />
      ))}
      {hidden > 0 ? <Text dimColor>{`  +${hidden} more`}</Text> : null}
    </Box>
  );
}

function Row({
  task,
  selected,
  focused,
  nameWidth,
  width,
  spinner,
}: {
  task: Task;
  selected: boolean;
  focused: boolean;
  nameWidth: number;
  width: number;
  spinner: string;
}) {
  const { glyph, color } = statusGlyph(task.status, spinner);
  const inverse = selected && focused;
  const settled = task.status === "done" || task.status === "failed" || task.status === "cancelled";

  const head = selected ? "❯ " : "  ";
  const mark = `${glyph} `;
  const who = `${(task.assignee ?? "nobody").slice(0, nameWidth).padEnd(nameWidth)} `;
  const prio = task.priority === "high" ? "!" : task.priority === "low" ? "." : " ";
  // A task decided by evidence says so: ×3 attempts, ⚖ two checks, and
  // the winning arm once one is promoted.
  const evidence = `${task.samples > 1 ? ` ×${task.samples}` : ""}${task.verifiers.length > 0 ? ` ⚖${task.verifiers.length}` : ""}`;
  const won = task.status === "done" && task.note?.startsWith("won by ") ? ` · ${task.note.slice(4).split(",")[0]}` : "";
  const tailText =
    evidence + won + (task.status === "blocked" && task.blockedReason
      ? ` · ${task.blockedReason}`
      : task.costUsd !== null
        ? ` ${costUsd(task.costUsd)}`
        : task.requestedBy
          ? ` · from ${task.requestedBy}${task.provider ? ` · on ${task.provider}` : ""}`
          : task.provider
            ? ` · on ${task.provider}`
            : "");

  const fixed = head.length + mark.length + who.length + 1;
  const room = Math.max(4, width - fixed);
  // One cell for the priority glyph, then the tail, then whatever is left.
  const titleRoom = Math.max(4, room - tailText.length - prio.length);
  const title = fit(task.title, Math.min(titleRoom, task.title.length + 1));
  const line = `${prio}${title}${tailText}`;
  const body = fit(line, room);

  return (
    <Box>
      <Text bold color={selected ? "cyan" : undefined} inverse={inverse}>
        {head}
      </Text>
      <Text color={color} bold={task.status === "blocked"} inverse={inverse}>
        {mark}
      </Text>
      <Text dimColor={settled} inverse={inverse}>
        {who}
      </Text>
      <Text
        dimColor={settled}
        color={task.status === "blocked" ? "red" : undefined}
        inverse={inverse}
      >
        {body}
      </Text>
    </Box>
  );
}

export default Queue;
