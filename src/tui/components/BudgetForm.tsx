/**
 * Raise or lower one agent's cap.
 *
 * Shows what has already been spent, because the number that matters when
 * setting a cap is not the old cap. It is how much of it is gone. An agent
 * at $4.90 of $5 needs a different number than one at $0.10 of $5, and the
 * old cap alone does not distinguish them.
 */

import { Box, Text, useInput } from "ink";
import { isTab, isReturn, isEscape } from "../keys.js";
import { useState } from "react";

import type { AgentRecord } from "../../core/types.js";
import { compactBudget, fit, usdExact, wrap } from "../format.js";
import Modal, { Field } from "./Modal.js";
import TextField from "./TextField.js";

export type BudgetFormProps = {
  agent: AgentRecord;
  width: number;
  onSubmit: (budgetUsd: number) => void;
  onCancel: () => void;
};

function isBudgetText(s: string): boolean {
  return /^\d*\.?\d*$/.test(s);
}

export function BudgetForm({ agent, width, onSubmit, onCancel }: BudgetFormProps) {
  const [value, setValue] = useState(
    Number.isInteger(agent.budgetUsd) ? String(agent.budgetUsd) : agent.budgetUsd.toFixed(2),
  );

  useInput((input, key) => {
    if (isEscape(input, key)) {
      onCancel();
      return;
    }
    if (isReturn(input, key)) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || value.trim() === "") return;
      onSubmit(parsed);
    }
  });

  const inner = Math.max(24, width - 4);
  const parsed = Number(value);
  const wouldRefuse =
    !agent.chief && Number.isFinite(parsed) && parsed > 0 && agent.spentUsd >= parsed;

  return (
    <Modal
      title={agent.chief ? `Allowance for ${agent.name}, chief of staff` : `Budget for ${agent.name}`}
      footer="enter set · esc cancel"
      width={width}
    >
      <Box>
        <Text dimColor>
          {fit(
            agent.chief
              ? `The money ${agent.name} may give other agents as budgets. The replies themselves have no cap: ${usdExact(agent.spentUsd)} so far.`
              : `spent ${usdExact(agent.spentUsd)} of ${compactBudget(agent.budgetUsd)} across ${agent.delegations} delegation${agent.delegations === 1 ? "" : "s"}`,
            inner,
          )}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Field label={agent.chief ? "allow" : "budget"} labelWidth={7} focused>
          <TextField
            value={value}
            onChange={(v) => {
              if (isBudgetText(v)) setValue(v);
            }}
            placeholder="5"
            focused
            width={12}
            filter={(ch) => /[0-9.]/.test(ch)}
          />
          <Text dimColor>{agent.chief ? "  USD the chief may give out" : "  USD · 0 means uncapped"}</Text>
        </Field>
      </Box>

      {wouldRefuse ? (
        <Box marginTop={1} flexDirection="column">
          {wrap(
            `${agent.name} has already spent ${usdExact(agent.spentUsd)}, so a cap of ${compactBudget(parsed)} refuses every delegation until it is raised again.`,
            inner,
            2,
          ).map((line, i) => (
            <Text key={i} color="yellow">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
    </Modal>
  );
}

export default BudgetForm;
