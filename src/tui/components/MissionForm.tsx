/**
 * The mission editor.
 *
 * This is the highest-leverage write the dashboard can perform: the objective
 * and the org guardrails are compiled into every agent's system prompt. A
 * change here reaches the whole org on its next delegation rather than one
 * agent. The form says so, because a field that quietly rewrites eight agents
 * should not look like a field that renames one.
 *
 * Criteria and guardrails are lists entered as one line each, split on `;`.
 * A multi-line editor inside a terminal dialog needs its own cursor model,
 * its own scroll, and its own set of keys that do not collide with tab and
 * enter. A separator costs one line of explanation and nothing else. The
 * split happens here and the trimming happens in the core, which drops empty
 * entries, so a trailing `;` is harmless.
 *
 * Existing values are pre-filled. The core's `setMission` carries forward the
 * previous criteria when the field is omitted. This form always sends all
 * three fields, so what is on screen is exactly what will be stored. Editing
 * the objective cannot silently be a way to keep criteria you did not read.
 */

import { Box, Text, useInput } from "ink";
import { useState, type ReactNode } from "react";

import type { Mission } from "../../core/types.js";
import { isEscape, isReturn, isTab } from "../keys.js";
import { fit, wrap } from "../format.js";
import Modal, { Field } from "./Modal.js";
import TextField from "./TextField.js";

const LABEL_WIDTH = 10;
const NOTE_INDENT = LABEL_WIDTH + 3;

/** The core's own floor, restated only as a live hint. It gates, not this. */
const MIN_OBJECTIVE = 10;

const LIST_SEPARATOR = ";";

const FIELDS = ["objective", "criteria", "guardrails"] as const;
type FormField = (typeof FIELDS)[number];

export type MissionFormProps = {
  mission: Mission | null;
  /** Agents currently in the org, so the blast radius is stated in numbers. */
  agentCount: number;
  width: number;
  onSubmit: (values: {
    objective: string;
    successCriteria: string[];
    orgGuardrails: string[];
  }) => void;
  onCancel: () => void;
};

/** "a; b ; ; c" becomes ["a", "b", "c"] */
function splitList(s: string): string[] {
  return s
    .split(LIST_SEPARATOR)
    .map((x) => x.trim())
    .filter(Boolean);
}

function joinList(items: string[]): string {
  return items.join(`${LIST_SEPARATOR} `);
}

export function MissionForm({
  mission,
  agentCount,
  width,
  onSubmit,
  onCancel,
}: MissionFormProps) {
  const [field, setField] = useState<FormField>("objective");
  const [objective, setObjective] = useState(mission?.objective ?? "");
  const [criteria, setCriteria] = useState(joinList(mission?.successCriteria ?? []));
  const [guardrails, setGuardrails] = useState(joinList(mission?.orgGuardrails ?? []));

  const move = (delta: number) => {
    const i = FIELDS.indexOf(field);
    setField(FIELDS[(i + delta + FIELDS.length) % FIELDS.length]);
  };

  useInput((input, key) => {
    if (isEscape(input, key)) {
      onCancel();
      return;
    }
    if (isTab(input, key)) {
      move(key.shift ? -1 : 1);
      return;
    }
    if (isReturn(input, key)) {
      onSubmit({
        objective: objective.trim(),
        successCriteria: splitList(criteria),
        orgGuardrails: splitList(guardrails),
      });
    }
  });

  const inner = Math.max(24, width - 4);
  const fieldWidth = Math.max(12, inner - LABEL_WIDTH - 4);
  const noteWidth = Math.max(20, inner - NOTE_INDENT);

  const criteriaCount = splitList(criteria).length;
  const railCount = splitList(guardrails).length;
  const short = objective.trim().length > 0 && objective.trim().length < MIN_OBJECTIVE;

  return (
    <Modal
      title={mission ? "Edit the mission" : "Set the mission"}
      footer="tab / shift-tab field · enter save · esc cancel"
      width={width}
    >
      <Field label="objective" labelWidth={LABEL_WIDTH} focused={field === "objective"}>
        <TextField
          value={objective}
          onChange={setObjective}
          placeholder="what this org is trying to achieve"
          focused={field === "objective"}
          width={fieldWidth}
        />
      </Field>
      <Note>
        {short ? (
          <Text color="red">
            {fit(
              `Too short. The core wants at least ${MIN_OBJECTIVE} characters.`,
              noteWidth,
            )}
          </Text>
        ) : (
          wrap(
            `Every agent sees this. A vague objective produces vague work across all ${agentCount} of them at once.`,
            noteWidth,
            2,
          ).map((line, i) => (
            <Text key={i} dimColor>
              {line}
            </Text>
          ))
        )}
      </Note>

      <Box marginTop={1} />
      <Field label="done when" labelWidth={LABEL_WIDTH} focused={field === "criteria"}>
        <TextField
          value={criteria}
          onChange={setCriteria}
          placeholder="tests green; docs updated"
          focused={field === "criteria"}
          width={fieldWidth}
        />
      </Field>
      <Note>
        <Text dimColor>
          {fit(
            `separate with "${LIST_SEPARATOR}" · ${criteriaCount} criteri${
              criteriaCount === 1 ? "on" : "a"
            }`,
            noteWidth,
          )}
        </Text>
      </Note>

      <Box marginTop={1} />
      <Field label="guardrails" labelWidth={LABEL_WIDTH} focused={field === "guardrails"}>
        <TextField
          value={guardrails}
          onChange={setGuardrails}
          placeholder="never touch production credentials"
          focused={field === "guardrails"}
          width={fieldWidth}
        />
      </Field>
      <Note>
        <Text dimColor>
          {fit(
            `separate with "${LIST_SEPARATOR}" · ${railCount} rule${
              railCount === 1 ? "" : "s"
            }, added to every agent's own`,
            noteWidth,
          )}
        </Text>
      </Note>
    </Modal>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <Box paddingLeft={NOTE_INDENT} flexDirection="column">
      {children}
    </Box>
  );
}

export default MissionForm;
