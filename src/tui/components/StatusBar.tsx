/**
 * The bottom line: org size, today's spend, the queue, and keys.
 *
 * Spend is shown twice when there is more than one workspace: this org's
 * figure, then the total across every registered one. The second number is
 * the one a person running four orgs actually wants to know at the end of
 * the day. No other line on the screen adds it up.
 *
 * The outcome segment, `N verified · $X/verified`, shows once the workspace
 * has any attempts. Dollars per verified outcome is the figure the allocation
 * of dispatch slots reads, so the bar shows the same number.
 *
 * A running delegation gets its own segment because it is the one state the
 * rest of the line cannot show. An agent dispatched and not yet reported
 * back has no cost attributed to it, so it is invisible in the other numbers.
 * AUTO is inverse yellow when the dispatcher is on, because it is the one
 * mode in which money moves without a keystroke.
 *
 * The line budgets its own width rather than setting a width on the container.
 * A flex row that overflows gets its children *shrunk* by yoga, which chops
 * words out of the middle of labels. Deciding here what to drop keeps every
 * segment that survives intact.
 */

import { Box, Text } from "ink";
import { compactUsd } from "../format.js";

export type StatusBarProps = {
  agentCount: number;
  spendTodayUsd: number;
  /** Sum of today's spend across every registered workspace. */
  spendEverywhereUsd: number;
  workspaceCount: number;
  delegationsToday: number;
  /** Runs in flight in this dashboard, every workspace. */
  running: number;
  /** Delegations started but never ended, this org. */
  dangling: number;
  queued: number;
  blocked: number;
  autoDispatch: boolean;
  /** Verified outcomes and dollars per verified in this workspace. Null hides the segment. */
  outcome?: { verified: number; usdPerVerified: number | null } | null;
  /** Requests waiting for a decision. */
  approvals?: number;
  focus: "sidebar" | "roster" | "queue";
  width: number;
};

/**
 * The legend, in display order, each entry paired with how readily it is
 * given up. Segments are dropped whole and one at a time, worst rank first,
 * until the line fits.
 *
 * The ranking is about recoverability, not importance. ↑↓ and enter are
 * discovered by pressing them and `r` by waiting two seconds, so they go
 * first. The mutating keys go late because nothing on screen suggests them.
 * `d`, `t`, `R` and `A` go latest of those: they are the keys that make the
 * org do anything at all. `?` and `q` are last. A user who cannot read
 * anything else can still get help or get out.
 */
const LEGEND: Array<{ text: string; drop: number; only?: "roster" | "queue" }> = [
  { text: "tab panel", drop: 2 },
  { text: "[ ] workspace", drop: 5 },
  { text: "enter run", drop: 1, only: "queue" },
  { text: "enter detail", drop: 1, only: "roster" },
  { text: "t task", drop: 11 },
  { text: "d delegate", drop: 12 },
  { text: "R dispatch", drop: 13 },
  { text: "A auto", drop: 14 },
  { text: "e edit · x cancel · u requeue", drop: 7, only: "queue" },
  { text: "+ company", drop: 14.5 },
  { text: "L live", drop: 14.2 },
  { text: "O sky", drop: 14.15 },
  { text: "D docket", drop: 14.1 },
  { text: "I integrations", drop: 12.5 },
  { text: "V approvals", drop: 12.4 },
  { text: "C chat", drop: 13.5 },
  { text: "h hire", drop: 8 },
  { text: "p suggest", drop: 7.5 },
  { text: "f fire", drop: 4, only: "roster" },
  { text: "b budget", drop: 6 },
  { text: "y autonomy", drop: 9, only: "roster" },
  { text: "v provider", drop: 8.5, only: "roster" },
  { text: "i worktree", drop: 8.2, only: "roster" },
  { text: "P pull request", drop: 8.1, only: "roster" },
  { text: "m merge", drop: 3, only: "roster" },
  { text: "M mission", drop: 10 },
  { text: "o shell", drop: 0 },
  { text: "S setup", drop: 2.5 },
  { text: "? help", drop: 15 },
  { text: "q quit", drop: 16 },
];

/** Render the surviving segments back into display order. */
function legendFor(available: number, focus: StatusBarProps["focus"]): string {
  const applicable = LEGEND.filter((s) => !s.only || s.only === focus || (focus === "sidebar" && s.only === "roster"));
  const kept = new Set(applicable.map((s) => s.text));
  const byDrop = [...applicable].sort((a, b) => a.drop - b.drop);

  const render = () =>
    applicable
      .filter((s) => kept.has(s.text))
      .map((s) => ` · ${s.text}`)
      .join("");

  for (const segment of byDrop) {
    if (render().length <= available) break;
    kept.delete(segment.text);
  }

  const line = render();
  return line.length <= available ? line : "";
}

/** The diamond is double-width in some terminals, but `.length` reports one. */
const EMOJI_SLACK = 1;

export function StatusBar({
  agentCount,
  spendTodayUsd,
  spendEverywhereUsd,
  workspaceCount,
  delegationsToday,
  running,
  dangling,
  queued,
  blocked,
  autoDispatch,
  outcome,
  approvals = 0,
  focus,
  width,
}: StatusBarProps) {
  const agents = `${agentCount} agent${agentCount === 1 ? "" : "s"}`;
  const dels = `${delegationsToday} delegation${delegationsToday === 1 ? "" : "s"}`;
  const everywhere =
    workspaceCount > 1 ? ` (${compactUsd(spendEverywhereUsd)} all ${workspaceCount})` : "";
  const stats = `◆ ${agents} · ${compactUsd(spendTodayUsd)} today${everywhere} · ${dels}`;

  const queueBits: string[] = [];
  if (running > 0) queueBits.push(`${running} running`);
  if (queued > 0) queueBits.push(`${queued} queued`);
  if (blocked > 0) queueBits.push(`${blocked} blocked`);
  if (dangling > 0) queueBits.push(`${dangling} dangling`);
  const queue = queueBits.length > 0 ? ` · ${queueBits.join(" · ")}` : "";
  const waiting = approvals > 0 ? ` · ${approvals} to approve` : "";
  const auto = autoDispatch ? " AUTO " : "";
  const outcomeText = outcome
    ? ` · ${outcome.verified} verified${outcome.usdPerVerified !== null ? ` · ${compactUsd(outcome.usdPerVerified)}/verified` : ""}`
    : "";

  const used = stats.length + EMOJI_SLACK + auto.length;
  // The outcome segment and the approvals count sit beside the spend and are dropped with the queue.
  const withQueue = used + queue.length + outcomeText.length + waiting.length;

  const legend = legendFor(width - withQueue, focus);

  // Under extreme narrowness the key legend wins: a user who cannot read the
  // spend can still get out.
  const showQueue = withQueue + legend.length <= width;

  return (
    <Box>
      <Text>{stats}</Text>
      {outcomeText && showQueue ? <Text color="green">{outcomeText}</Text> : null}
      {queue && showQueue ? (
        <Text color={dangling > 0 || blocked > 0 ? "red" : "yellow"}>{queue}</Text>
      ) : null}
      {waiting && showQueue ? <Text color="yellow">{waiting}</Text> : null}
      {auto ? (
        <Text color="yellow" inverse bold>
          {auto}
        </Text>
      ) : null}
      {legend ? <Text dimColor>{legend}</Text> : null}
    </Box>
  );
}

export default StatusBar;
