/**
 * The strip across the top of the dashboard: what the org is trying to do.
 *
 * It sits above the roster because the roster answers "who is on the payroll"
 * and this answers "what are they for". The second question is the one a
 * dashboard about work should lead with. It is also the only part of the
 * screen that is not about an individual agent. The objective and the org
 * guardrails are compiled into *every* agent's prompt, so a change here is a
 * change to the whole org at once.
 *
 * The objective is fitted to one line rather than wrapped. This is a strip,
 * not a document. The full text is a keystroke away in the editor. A
 * mission long enough to need three lines would push the roster off a short
 * terminal to say something the first clause already said.
 *
 * An empty mission is stated, not hidden. Agents hired into an org with no
 * objective get a compiled prompt with the mission section missing. That is
 * a real difference in how they behave, and not the sort of thing to leave
 * the user to infer from a blank panel.
 */

import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { Mission } from "../../core/types.js";
import { fit, sinceHuman, wrap } from "../format.js";

export type MissionPanelProps = {
  mission: Mission | null;
  /** Full dashboard width. The border and padding are subtracted here. */
  width: number;
  /**
   * Lines available *under* the objective. Zero is normal on a short
   * terminal: the objective is the part that always survives.
   */
  bodyLines: number;
};

export function MissionPanel({ mission, width, bodyLines }: MissionPanelProps) {
  const inner = Math.max(10, width - 4);
  const LABEL = "Mission ";

  if (!mission || !mission.objective.trim()) {
    return (
      <Frame width={width}>
        <Text>
          <Text bold color="cyan">{"Mission  "}</Text>
          <Text dimColor>{fit("none yet · M to write one", Math.max(4, inner - 9))}</Text>
        </Text>
      </Frame>
    );
  }

  const body: Array<{ text: string; color?: string }> = [];
  const bodyWidth = Math.max(4, inner - 2);

  // Success criteria are the operative half of a mission, since an objective
  // with no test for "done" is a mood. So they get whatever room exists first.
  // They run together on one line rather than one line each: at three or four
  // criteria the label would be the widest thing on the panel, repeated.
  const criteria = mission.successCriteria;
  const meta = metaLine(mission);
  if (criteria.length > 0) {
    // Hold a line back for the meta only when there is more than one to give.
    const reserved = bodyLines > 1 ? 1 : 0;
    for (const line of wrap(
      `done when: ${criteria.join(" · ")}`,
      bodyWidth,
      Math.max(0, bodyLines - reserved),
    )) {
      body.push({ text: line });
    }
  }

  if (body.length < bodyLines) body.push(meta);

  return (
    <Frame width={width}>
      <Box>
        <Text bold color="cyan">
          {LABEL}
        </Text>
        <Text>{fit(mission.objective, Math.max(1, inner - LABEL.length))}</Text>
      </Box>
      {body.map((line, i) => (
        <Text key={i} color={line.color} dimColor={!line.color}>
          {`  ${fit(line.text, inner - 2)}`}
        </Text>
      ))}
    </Frame>
  );
}

/**
 * The last line of the panel. Org guardrails are counted rather than listed.
 * They are inherited by every agent, so at dashboard level the number is the
 * fact. The text of each one belongs on the agent it constrains, which is
 * where the detail view puts it. The count is coloured because a rule nobody
 * remembers agreeing to is exactly the kind of thing that gets blamed on the
 * model later.
 */
function metaLine(mission: Mission): { text: string; color?: string } {
  const age = `set ${sinceHuman(mission.setAt)} ago · M to edit`;
  const n = mission.orgGuardrails.length;
  if (n === 0) return { text: age };
  return {
    text: `${n} org guardrail${n === 1 ? "" : "s"} inherited by every agent · ${age}`,
    color: "yellow",
  };
}

/** Same border treatment as the roster and activity panels below it. */
function Frame({ width, children }: { width: number; children: ReactNode }) {
  return (
    <Box
      width={width}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      flexDirection="column"
    >
      {children}
    </Box>
  );
}

export default MissionPanel;
