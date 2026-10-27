/**
 * Give an agent a task.
 *
 * Two inputs, who and what, and then a block of text that exists for one
 * reason. It answers "what is about to be allowed to happen" before it happens
 * rather than after. Autonomy is an enforced tool allowlist, so an `observe`
 * agent asked to fix a bug will come back with a description of the fix and no
 * edit. The moment to learn that is while the cursor is still in the task
 * field. The permitted-tools line is read straight out of `effectiveTools`,
 * the same call `runDelegation` passes to `--allowed-tools`. So what this
 * screen promises and what the process enforces cannot drift apart.
 *
 * The budget line is here for the same reason. `begin()` refuses a delegation
 * from a capped-out agent by throwing, which the pane would render as a red
 * failure a second after enter. Saying so on the form, with submit disabled,
 * costs one line and saves a round trip through a failure that was knowable.
 *
 * The agent list is arrow keys rather than tab-and-cycle because a roster can
 * be long. It also leaves every printable key for the task field. That field
 * is always focused, since it is the only one you type into.
 */

import { Box, Text, useInput } from "ink";
import { useState } from "react";

import { policyFor } from "../../core/autonomy.js";
import { providerFor } from "../../core/providers.js";
import { enforcementFor } from "../../core/runner.js";
import type { AgentRecord } from "../../core/types.js";
import {
  autonomyColor,
  autonomyLevel,
  autonomyShort,
  budgetLevel,
  compactBudget,
  compactUsd,
  fit,
  levelColor,
  usdExact,
  wrap,
} from "../format.js";
import { isEscape, isReturn } from "../keys.js";
import Modal from "./Modal.js";
import TextField from "./TextField.js";

/** Rows of roster the picker shows before it scrolls. */
const PICKER_ROWS = 6;

/** `begin()` refuses anything shorter, so the form says so first. */
const MIN_TASK_CHARS = 3;

const BRANCH_MARK = "⎇";

export type DelegateFormProps = {
  agents: AgentRecord[];
  /** Agents with a run already in flight. A second one is refused. */
  running: Set<string>;
  /** Row to open on, usually whatever the roster had selected. */
  initialAgent: string | null;
  width: number;
  onSubmit: (agent: string, task: string) => void;
  onCancel: () => void;
};

export function DelegateForm({
  agents,
  running,
  initialAgent,
  width,
  onSubmit,
  onCancel,
}: DelegateFormProps) {
  const initialIndex = Math.max(
    0,
    agents.findIndex((a) => a.name === initialAgent),
  );
  const [index, setIndex] = useState(initialIndex);
  const [task, setTask] = useState("");

  const inner = Math.max(24, width - 4);
  const selected = agents[Math.min(index, agents.length - 1)] ?? null;

  const level = selected ? autonomyLevel(selected.autonomy) : "execute";
  const policy = policyFor(level);
  const grants = selected ? enforcementFor(selected) : [];
  const spec = providerFor(selected?.provider);

  const capped = Boolean(
    selected && selected.budgetUsd > 0 && selected.spentUsd >= selected.budgetUsd,
  );
  const busy = Boolean(selected && running.has(selected.name));
  const tooShort = task.trim().length < MIN_TASK_CHARS;

  // One reason at a time, worst first. Two red lines about the same disabled
  // key is one more than anybody reads.
  const blocked: string | null = !selected
    ? "No agents in the org. Press esc, then h to hire one."
    : busy
      ? `${selected.name} is already running a task. One run per agent. Cancel that one first, or pick someone else.`
      : capped
        ? `${selected.name} has spent ${usdExact(selected.spentUsd)} of its ${compactBudget(
            selected.budgetUsd,
          )} budget. Raise it with b, or pick another agent. A delegation would be refused.`
        : null;

  const canSubmit = Boolean(selected) && !busy && !capped && !tooShort;

  useInput((input, key) => {
    if (isEscape(input, key)) {
      onCancel();
      return;
    }
    if (isReturn(input, key)) {
      if (canSubmit && selected) onSubmit(selected.name, task.trim());
      return;
    }
    if (key.upArrow) {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIndex((i) => Math.min(agents.length - 1, i + 1));
    }
  });

  // Keep the highlighted row on screen without letting the list jump around.
  const overflowing = agents.length > PICKER_ROWS;
  const visible = overflowing ? PICKER_ROWS - 1 : PICKER_ROWS;
  const start = Math.max(
    0,
    Math.min(index - Math.floor(visible / 2), agents.length - visible),
  );
  const rows = agents.slice(start, start + visible);
  const hidden = agents.length - rows.length;

  const nameWidth = Math.min(
    16,
    Math.max(6, ...agents.map((a) => a.name.length)),
  );
  const spendWidth = Math.min(
    16,
    Math.max(8, ...agents.map((a) => spendLabel(a).length)),
  );

  return (
    <Modal
      title="Delegate a task"
      footer={
        canSubmit
          ? "↑↓ agent · enter run · esc cancel"
          : "↑↓ agent · esc cancel · enter is disabled until the notes above are clear"
      }
      width={width}
    >
      {agents.length === 0 ? (
        <Text color="yellow">
          {fit("Nobody to delegate to. Press esc, then h to hire an agent.", inner)}
        </Text>
      ) : (
        <Box flexDirection="column">
          {rows.map((agent, i) => (
            <PickerRow
              key={agent.name}
              agent={agent}
              selected={start + i === index}
              running={running.has(agent.name)}
              nameWidth={nameWidth}
              spendWidth={spendWidth}
              width={inner}
            />
          ))}
          {hidden > 0 ? <Text dimColor>{`   +${hidden} more`}</Text> : null}
        </Box>
      )}

      {selected ? (
        <Box marginTop={1} flexDirection="column">
          {/* The whole point of autonomy levels: what this agent will and
              will not be able to do, before it is asked to do anything. */}
          <Box>
            <Text color={autonomyColor(level)} bold>
              {level}
            </Text>
            <Text dimColor>
              {`: ${fit(policy.label, Math.max(4, inner - level.length - 3))}`}
            </Text>
          </Box>
          {wrap(
            `will be started on ${spec.label} with: ${grants.length > 0 ? grants.join(", ") : "no tools at all"}`,
            inner,
            3,
          ).map((line, i) => (
            <Text key={i} color={autonomyColor(level)}>
              {line}
            </Text>
          ))}
          <Text dimColor>
            {fit(
              `${policy.canWrite ? "can write files" : "cannot write files"} · ${
                policy.canMerge ? "can merge unattended" : "cannot merge unattended"
              } · ${
                selected.isolated
                  ? `${BRANCH_MARK} runs in its own worktree`
                  : "runs in the working tree"
              }`,
              inner,
            )}
          </Text>

          <Box marginTop={1}>
            <Text dimColor>{"budget  "}</Text>
            <Text color={levelColor(budgetLevel(selected.spentUsd, selected.budgetUsd))}>
              {`${usdExact(selected.spentUsd)} of ${compactBudget(selected.budgetUsd)}`}
            </Text>
            <Text dimColor>
              {selected.budgetUsd > 0
                ? `  ${compactUsd(Math.max(0, selected.budgetUsd - selected.spentUsd))} left`
                : "  uncapped"}
            </Text>
          </Box>
        </Box>
      ) : null}

      {blocked ? (
        <Box marginTop={1} flexDirection="column">
          {wrap(blocked, inner, 3).map((line, i) => (
            <Text key={i} color="red" bold={i === 0}>
              {line}
            </Text>
          ))}
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text bold color="cyan">
          {"❯ task  "}
        </Text>
        <TextField
          value={task}
          onChange={setTask}
          placeholder="what to do, and what done looks like"
          focused
          width={Math.max(12, inner - 8)}
        />
      </Box>
      <Box paddingLeft={8}>
        <Text dimColor>
          {fit(
            tooShort
              ? "A task is required before this can run."
              : canSubmit
                ? "Enter starts the run. The run spends real money."
                : "enter will not start anything while the note above stands.",
            Math.max(8, inner - 8),
          )}
        </Text>
      </Box>
    </Modal>
  );
}

/**
 * One roster line inside the picker.
 *
 * `○` and `●` split the roster by the only distinction that changes what a
 * delegation means: whether the agent can write. The same glyphs carry the
 * same meaning in the text snapshot.
 */
/** "$0.29/$5": spend against cap, the same shape the roster column uses. */
function spendLabel(agent: AgentRecord): string {
  return `${compactUsd(agent.spentUsd)}/${compactBudget(agent.budgetUsd)}`;
}

function PickerRow({
  agent,
  selected,
  running,
  nameWidth,
  spendWidth,
  width,
}: {
  agent: AgentRecord;
  selected: boolean;
  running: boolean;
  nameWidth: number;
  spendWidth: number;
  width: number;
}) {
  const level = autonomyLevel(agent.autonomy);
  const readOnly = level === "observe" || level === "propose";
  const head = `${selected ? "❯ " : "  "}`;
  const tail = ` ${autonomyShort(level)} ${agent.isolated ? BRANCH_MARK : " "} ${spendLabel(
    agent,
  ).padEnd(spendWidth)}`;

  return (
    <Box>
      <Text bold={selected} color={selected ? "cyan" : undefined}>
        {head}
      </Text>
      <Text color={autonomyColor(level)}>{`${readOnly ? "○" : "●"} `}</Text>
      <Text bold={selected}>{agent.name.slice(0, nameWidth).padEnd(nameWidth)}</Text>
      <Text color={autonomyColor(level)}>{tail}</Text>
      {running ? (
        <Text color="yellow" bold>
          {"   running now"}
        </Text>
      ) : (
        <Text dimColor>
          {`   ${fit(
            policyFor(level).label,
            Math.max(0, width - head.length - 2 - nameWidth - tail.length - 3),
          )}`}
        </Text>
      )}
    </Box>
  );
}

export default DelegateForm;
