/**
 * A delegation while it is happening.
 *
 * The activity feed answers "what has this org done". This answers the
 * narrower and more urgent question of what is happening right now, which the
 * feed structurally cannot. A running delegation has no cost, no duration and
 * no output until it ends. In the feed it is one line reading "running" for
 * however many minutes it takes.
 *
 * Four things get priority over the agent's prose, because all four are
 * invisible in it:
 *
 *   The granted tool list, on its own line at the top. What an agent said it
 *   did and what it was able to do are different claims, and only one of them
 *   is enforced.
 *
 *   Denials, in red and repeated in a banner. An agent reaching past its
 *   autonomy level is the most important thing that can appear on this
 *   screen. It is the one event that says the level is doing work. It
 *   would otherwise be a line in `permission_denials` nobody ever reads.
 *
 *   Elapsed time, ticking. A run with nothing on screen for ninety seconds is
 *   either thinking or wedged, and a clock is the difference.
 *
 *   The settled cost, on finish. Including for a cancelled run, which spent
 *   real money and is in the ledger exactly like one that ran to completion.
 *
 * Tool calls stay dim and one line each. They are context for the prose, not
 * the point of the screen, and a run that greps forty files should not push
 * its own conclusion off the top.
 */

import { Box, Text } from "ink";

import type { RunLine, RunLineKind, RunState } from "../runs.js";
import { fit, secs, shortModel, shortPath, usdExact, wrap } from "../format.js";

/** Braille spinner. Rotates off the shared tick so every pane agrees. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerFrame(now: number): string {
  return SPINNER[Math.floor(now / 120) % SPINNER.length];
}

export type RunPaneProps = {
  /** Every live and settled run, oldest first. */
  runs: RunState[];
  /** Which one the body is showing. */
  focused: RunState;
  /** Inner content width, borders and padding already subtracted. */
  width: number;
  /** Rows available. */
  height: number;
  /** Shared clock, so elapsed time and the spinner move together. */
  now: number;
};

export function RunPane({ runs, focused, width, height, now }: RunPaneProps) {
  const denied = focused.denials.length > 0;
  const multiple = runs.length > 1;

  // Top down: the optional run switcher, the status block, the task, the
  // granted tools, an optional denial banner, then the body, then the keys.
  // The status block is not always one line. A cancelled run explains where
  // its money went, and a failed one prints its error. A height budget that
  // assumed one line would have yoga shrink the body's rows out from under
  // the output instead.
  const note =
    focused.status === "failed"
      ? wrap(focused.error?.trim() || "no reason reported", width, 2)
      : focused.status === "cancelled"
        ? wrap(cancelNote(focused), width, 2)
        : [];
  const chrome = 1 + note.length + 2 + (multiple ? 1 : 0) + (denied ? 1 : 0) + 1;
  const bodyHeight = Math.max(1, height - chrome);

  const lines = flatten(focused.lines, width);
  // Scrolled to the bottom: a stream is read at its tail.
  const shown = lines.slice(Math.max(0, lines.length - bodyHeight));
  // The marker takes the top visible row, so it counts itself among what it
  // is reporting as hidden. `truncated` means the buffer also dropped lines
  // it can no longer count, hence the "+".
  const hiddenAbove = lines.length - shown.length + 1;
  const overflowLabel =
    lines.length > shown.length || focused.truncated
      ? `↑ ${hiddenAbove}${focused.truncated ? "+" : ""} earlier lines · full output in .ceo/outputs`
      : null;

  return (
    <Box flexDirection="column">
      {multiple ? <Switcher runs={runs} focused={focused} width={width} now={now} /> : null}

      <StatusLine run={focused} width={width} now={now} note={note} />

      <Text dimColor>{fit(`task  ${focused.task}`, width)}</Text>
      {/* What the process was actually started with: the allowlist for a
          claude run, the sandbox for a codex run. What an agent said it did
          and what it was able to do are different claims. */}
      <Text dimColor>
        {fit(
          `${focused.provider ? `${focused.provider} ${shortModel(focused.model ?? "")} · ` : ""}grants ${
            focused.tools.length > 0 ? focused.tools.join(", ") : "(starting…)"
          }`,
          width,
        )}
      </Text>

      {denied ? (
        <Text backgroundColor="red" color="white" bold>
          {fit(
            ` ${focused.denials.length} TOOL CALL${
              focused.denials.length === 1 ? "" : "S"
            } BLOCKED BY AUTONOMY: ${focused.denials.join(", ")}`,
            width,
          )}
        </Text>
      ) : null}

      <Box flexDirection="column" height={bodyHeight}>
        {shown.length === 0 ? (
          <Text dimColor>
            {focused.status === "running" ? "waiting for the agent's first reply…" : "(no output)"}
          </Text>
        ) : (
          shown.map((line, i) => (
            <Text
              key={i}
              color={line.kind === "denied" ? "red" : undefined}
              bold={line.kind === "denied"}
              dimColor={line.kind === "tool" || (i === 0 && overflowLabel !== null)}
            >
              {/* The first visible line doubles as the overflow marker, so the
                  pane never silently loses its head. */}
              {i === 0 && overflowLabel !== null
                ? fit(overflowLabel, width)
                : fit(line.text, width)}
            </Text>
          ))
        )}
      </Box>

      <Text dimColor>{fit(footerFor(focused, multiple), width)}</Text>
    </Box>
  );
}

function footerFor(run: RunState, multiple: boolean): string {
  const switcher = multiple ? " · n next run" : "";
  if (run.status === "running") {
    return `esc / c cancel. A cancelled run still cost what it spent${switcher}`;
  }
  return `esc dismiss · d delegate again${switcher}`;
}

/**
 * What state this run is in, and what it cost.
 *
 * A cancelled run is deliberately not styled as a failure. It did work, it
 * spent money, and `.ceo/outputs/` has whatever it produced before the process
 * died. Treating it as an error would suggest none of that happened.
 *
 * The cost it settled at is a separate question from what it actually spent,
 * and `cancelNote` is where that distinction is made rather than papered over.
 */
function StatusLine({
  run,
  width,
  now,
  note,
}: {
  run: RunState;
  width: number;
  now: number;
  /** Wrapped already, so the height budget above and this agree exactly. */
  note: string[];
}) {
  if (run.status === "running") {
    const elapsed = Math.max(0, now - run.startedAt);
    const mark = run.cancelRequested ? "⨯" : spinnerFrame(now);
    const state = `${run.cancelRequested ? "cancelling" : "running"} ${secs(elapsed)}${run.turns > 1 ? ` · turn ${run.turns}` : ""}`;
    // `fit` trims, so any separating space has to sit outside the call or it
    // is eaten and the two segments run together.
    const room = width - (mark.length + 1 + run.agent.length + 1) - state.length - 2;
    return (
      <Box>
        <Text color="yellow" bold>{`${mark} ${run.agent} `}</Text>
        <Text color="yellow">{state}</Text>
        {run.workdir && room > 12 ? (
          <Text dimColor>{`  ${fit(`in ${shortPath(run.workdir, run.workspace)}`, room)}`}</Text>
        ) : null}
      </Box>
    );
  }

  const cost = `${usdExact(run.costUsd)}${run.costIsEstimate ? " est." : ""} · ${secs(run.durationMs)} · ${run.inputTokens.toLocaleString()} in / ${run.outputTokens.toLocaleString()} out${run.turns > 1 ? ` · ${run.turns} turns` : ""}`;

  if (run.status === "done") {
    return (
      <Box>
        <Text color="green" bold>{`✓ ${run.agent} `}</Text>
        <Text color="green">{fit(cost, Math.max(0, width - run.agent.length - 3))}</Text>
      </Box>
    );
  }

  if (run.status === "cancelled") {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="yellow" bold>{`⨯ ${run.agent} `}</Text>
          <Text color="yellow">
            {fit(`cancelled · ${cost}`, Math.max(0, width - run.agent.length - 3))}
          </Text>
        </Box>
        {note.map((line, i) => (
          <Text key={i} dimColor>
            {line}
          </Text>
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="red" bold>{`✗ ${run.agent} `}</Text>
        <Text color="red">{fit(`failed · ${cost}`, Math.max(0, width - run.agent.length - 3))}</Text>
      </Box>
      {note.map((line, i) => (
        <Text key={i} color="red">
          {line}
        </Text>
      ))}
    </Box>
  );
}

/**
 * What cancelling actually did to the accounting.
 *
 * `total_cost_usd` only arrives in the process's final result message, and a
 * killed process never sends one. So a cancelled run usually settles at zero
 * in the ledger even though its tokens were consumed and billed. That gap is
 * said out loud here. Rendering a bare "$0.00" and moving on would teach
 * exactly the wrong lesson, which is that cancelling early is free.
 */
function cancelNote(run: RunState): string {
  if (run.costUsd > 0) {
    return `${usdExact(run.costUsd)} settled into the ledger. Cancelling did not refund it.`;
  }
  return "Killed before the process reported a settled cost. The ledger records an estimate from the tokens it had already streamed, marked as an estimate.";
}

/** Which runs are in flight, and which one the body belongs to. */
function Switcher({
  runs,
  focused,
  width,
  now,
}: {
  runs: RunState[];
  focused: RunState;
  width: number;
  now: number;
}) {
  // Chips are dropped rather than shrunk: half an agent's name in an inverse
  // block reads as a different agent.
  const head = `${runs.length} runs  `;
  const chips: Array<{ run: RunState; width: number }> = [];
  let used = head.length;
  for (const run of runs) {
    const w = Math.min(20, run.agent.length + 4);
    if (used + w + 5 > width) break;
    chips.push({ run, width: w });
    used += w;
  }
  const hidden = runs.length - chips.length;

  return (
    <Box>
      <Text dimColor>{head}</Text>
      {chips.map(({ run, width: w }) => (
        <Text
          key={run.agent}
          bold={run.agent === focused.agent}
          inverse={run.agent === focused.agent}
          color={colorFor(run)}
        >
          {fit(` ${markFor(run, now)} ${run.agent} `, w)}
        </Text>
      ))}
      {hidden > 0 ? <Text dimColor>{` +${hidden}`}</Text> : null}
    </Box>
  );
}

function markFor(run: RunState, now: number): string {
  if (run.status === "running") return run.cancelRequested ? "⨯" : spinnerFrame(now);
  if (run.status === "done") return "✓";
  if (run.status === "cancelled") return "⨯";
  return "✗";
}

function colorFor(run: RunState): string {
  if (run.status === "running") return "yellow";
  if (run.status === "done") return "green";
  if (run.status === "cancelled") return "yellow";
  return "red";
}

/**
 * Event lines to display rows.
 *
 * Assistant text arrives as prose with its own newlines and no regard for the
 * width of a pane, so it is split on its breaks and then wrapped. Tool calls
 * and denials get a marker column and hang under it, so a wrapped tool line
 * cannot be mistaken for the agent saying something.
 */
function flatten(lines: RunLine[], width: number): Array<{ kind: RunLineKind; text: string }> {
  const out: Array<{ kind: RunLineKind; text: string }> = [];

  for (const line of lines) {
    const prefix = line.kind === "tool" ? "› " : line.kind === "denied" ? "DENIED " : "";
    const body =
      line.kind === "denied"
        ? `${line.text}: refused, this agent's autonomy level does not grant it`
        : line.text;

    for (const paragraph of body.split("\n")) {
      if (!paragraph.trim()) {
        out.push({ kind: line.kind, text: "" });
        continue;
      }
      const room = Math.max(8, width - prefix.length);
      const wrapped = wrap(paragraph, room, 200);
      wrapped.forEach((text, i) => {
        out.push({
          kind: line.kind,
          text: (i === 0 ? prefix : " ".repeat(prefix.length)) + text,
        });
      });
    }
  }

  return out;
}

export default RunPane;
