/**
 * Add a task to the queue, or edit one that is there.
 *
 * Five fields: what, who, how urgent, the checks that decide it, and how
 * many attempts to run. Checks are separated by semicolons: a shell
 * command such as `npm test`, `everval:<file>#<scenario>`, or
 * `judge:<rubric>`. A task with checks is done only when an attempt passes
 * them. The first three fields work as before. The assignee is chosen with ↑↓ the
 * way the delegate form picks an agent, and "nobody yet" is a real option.
 * A task you know needs doing but have not decided who should do it is a
 * blocked task. Blocked is a state the queue is designed to show, not an
 * error the form should refuse.
 *
 * Unlike the delegate form this spends nothing on enter. It appends a
 * `task_add` or a `task_update` to the ledger, and the queue picks it up.
 * Running is a separate, deliberate keystroke on the queue, or the
 * dispatcher when auto is on.
 */

import { Box, Text, useInput } from "ink";
import { useState } from "react";

import { TASK_PRIORITIES, type Task, type TaskPriority } from "../../core/tasks.js";
import type { AgentRecord, VerifierSpec } from "../../core/types.js";
import { parseVerifier, verifierName } from "../../core/verify.js";
import { autonomyColor, autonomyLevel, autonomyShort, compactBudget, compactUsd, fit } from "../format.js";
import { isEscape, isReturn, isTab } from "../keys.js";
import Modal, { Field } from "./Modal.js";
import TextField from "./TextField.js";

const LABEL_WIDTH = 9;
const MIN_TITLE = 3;

export type TaskFormValues = {
  title: string;
  assignee: string | null;
  priority: TaskPriority;
  verifiers: VerifierSpec[];
  samples: number;
};

const SAMPLE_CHOICES = [1, 2, 3, 4, 5, 6, 8];

export type TaskFormProps = {
  agents: AgentRecord[];
  /** Existing task to edit, or null for a new one. */
  task: Task | null;
  /** Assignee to start on for a new task, usually the roster selection. */
  initialAssignee: string | null;
  width: number;
  onSubmit: (values: TaskFormValues) => void;
  onCancel: () => void;
};

type FieldName = "title" | "assignee" | "priority" | "checks" | "samples";
const ORDER: FieldName[] = ["title", "assignee", "priority", "checks", "samples"];

export function TaskForm({ agents, task, initialAssignee, width, onSubmit, onCancel }: TaskFormProps) {
  const [title, setTitle] = useState(task?.title ?? "");
  // Index 0 is "nobody yet". Agents follow.
  const names = [null, ...agents.map((a) => a.name)];
  const startName = task ? task.assignee : initialAssignee;
  const [who, setWho] = useState(Math.max(0, names.indexOf(startName)));
  const [prio, setPrio] = useState<number>(
    Math.max(0, TASK_PRIORITIES.indexOf(task?.priority ?? "normal")),
  );
  const [field, setField] = useState<FieldName>("title");
  const [checks, setChecks] = useState((task?.verifiers ?? []).map((v) => (v.kind === "command" ? v.run : v.kind === "everval" ? `everval:${v.collection}${v.scenario ? `#${v.scenario}` : ""}` : `judge:${v.rubric}`)).join("; "));
  const [sampleIndex, setSampleIndex] = useState(Math.max(0, SAMPLE_CHOICES.indexOf(task?.samples ?? 1)));
  const verifiers = checks.split(";").map((c) => c.trim()).filter(Boolean).map(parseVerifier);
  const samples = SAMPLE_CHOICES[sampleIndex];

  const inner = Math.max(24, width - 4);
  const tooShort = title.trim().length < MIN_TITLE;
  const canSubmit = !tooShort;

  const move = (delta: number) => {
    const i = ORDER.indexOf(field);
    setField(ORDER[(i + delta + ORDER.length) % ORDER.length]);
  };

  useInput((input, key) => {
    if (isEscape(input, key)) {
      onCancel();
      return;
    }
    if (isReturn(input, key)) {
      if (canSubmit) {
        onSubmit({
          title: title.trim(),
          assignee: names[who] ?? null,
          priority: TASK_PRIORITIES[prio],
          verifiers,
          samples,
        });
      }
      return;
    }
    if (isTab(input, key)) {
      move(key.shift ? -1 : 1);
      return;
    }
    // ↑↓ cycle the value of a choice field, and move between fields when
    // the caret is in the text field where they have nothing to cycle.
    if (key.upArrow || key.downArrow) {
      const d = key.upArrow ? -1 : 1;
      if (field === "assignee") setWho((i) => (i + d + names.length) % names.length);
      else if (field === "priority")
        setPrio((i) => (i + d + TASK_PRIORITIES.length) % TASK_PRIORITIES.length);
      else if (field === "samples") setSampleIndex((i) => (i + d + SAMPLE_CHOICES.length) % SAMPLE_CHOICES.length);
      else move(d);
    }
  });

  const assignee = names[who] ? agents.find((a) => a.name === names[who]) ?? null : null;

  return (
    <Modal
      title={task ? `Edit task ${task.id}` : "Add a task to the queue"}
      footer={
        canSubmit
          ? "tab field · ↑↓ choose · enter save · esc cancel"
          : "tab field · ↑↓ choose · esc cancel · enter is disabled until there is a title"
      }
      width={width}
    >
      <Field label="task" labelWidth={LABEL_WIDTH} focused={field === "title"}>
        <TextField
          value={title}
          onChange={setTitle}
          placeholder="what to do, and what done looks like"
          focused={field === "title"}
          width={Math.max(12, inner - LABEL_WIDTH - 3)}
        />
      </Field>

      <Field label="assignee" labelWidth={LABEL_WIDTH} focused={field === "assignee"}>
        {assignee ? (
          <Box>
            <Text bold={field === "assignee"}>{assignee.name}</Text>
            <Text color={autonomyColor(autonomyLevel(assignee.autonomy))}>
              {`  ${autonomyShort(assignee.autonomy)}`}
            </Text>
            <Text dimColor>
              {`  ${compactUsd(assignee.spentUsd)}/${compactBudget(assignee.budgetUsd)}`}
            </Text>
          </Box>
        ) : (
          <Text color="yellow" bold={field === "assignee"}>
            nobody yet. The task will sit blocked until someone is assigned
          </Text>
        )}
      </Field>

      <Field label="priority" labelWidth={LABEL_WIDTH} focused={field === "priority"}>
        <Box>
          {TASK_PRIORITIES.map((p, i) => (
            <Text
              key={p}
              inverse={i === prio}
              bold={i === prio}
              color={p === "high" ? "red" : p === "low" ? "gray" : undefined}
            >
              {` ${p} `}
            </Text>
          ))}
        </Box>
      </Field>

      <Field label="checks" labelWidth={LABEL_WIDTH} focused={field === "checks"}>
        <TextField
          value={checks}
          onChange={setChecks}
          placeholder="npm test; judge: the change is minimal  · optional"
          focused={field === "checks"}
          width={Math.max(12, inner - LABEL_WIDTH - 3)}
        />
      </Field>

      <Field label="attempts" labelWidth={LABEL_WIDTH} focused={field === "samples"}>
        <Box>
          {SAMPLE_CHOICES.map((n, i) => (
            <Text key={n} inverse={i === sampleIndex} bold={i === sampleIndex}>
              {` ${n} `}
            </Text>
          ))}
          <Text dimColor>{samples > 1 ? `  across the router's arms, one worktree each` : "  one run"}</Text>
        </Box>
      </Field>

      {verifiers.length > 0 ? (
        <Text dimColor>{fit(`Done only on a pass of: ${verifiers.map(verifierName).join(" · ")}`, inner)}</Text>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          {fit(
            tooShort
              ? "A title is required."
              : task
                ? "Saving appends a task_update to the ledger. Nothing runs."
                : "Saving queues the task. Enter on the task starts the run. Auto-dispatch starts queued tasks too.",
            inner,
          )}
        </Text>
      </Box>
    </Modal>
  );
}

export default TaskForm;
