/**
 * The one key on this dashboard that can lose work.
 *
 * Firing is a ledger append and a roster removal. It does not touch git. But
 * an agent with commits on its branch and no agent left to own them is work
 * nobody will find again. So the dialog counts those commits before it asks
 * anything, names them, and puts "merge first" at the top of the list with
 * the cursor already on it. The safe option is the default. The destructive
 * one has to be chosen.
 *
 * When the branch has nothing on it, all of that disappears and the dialog
 * is a plain confirm. Ceremony proportional to what is at stake.
 */

import { Box, Text, useInput } from "ink";
import { isTab, isReturn, isEscape } from "../keys.js";
import { useState } from "react";

import { branchNameFor } from "../../core/git.js";
import type { AgentRecord } from "../../core/types.js";
import { compactUsd, fit, wrap } from "../format.js";
import Modal from "./Modal.js";

const MAX_SHOWN_COMMITS = 5;

export type FireChoice = "merge-then-fire" | "fire" | "cancel";

export type FireDialogProps = {
  agent: AgentRecord;
  /** Commits on the agent's branch the base branch does not have. */
  unmerged: string[];
  /** Branch a merge would land on. */
  base: string;
  width: number;
  onChoose: (choice: FireChoice) => void;
};

export function FireDialog({
  agent,
  unmerged,
  base,
  width,
  onChoose,
}: FireDialogProps) {
  const atRisk = unmerged.length > 0;
  const choices: { key: FireChoice; label: string; color?: string }[] = atRisk
    ? [
        {
          key: "merge-then-fire",
          label: `Merge ${branchNameFor(agent.name)} into ${base}, then fire`,
        },
        { key: "fire", label: "Fire anyway and leave the branch behind", color: "red" },
        { key: "cancel", label: "Cancel" },
      ]
    : [
        { key: "fire", label: `Fire ${agent.name}`, color: "red" },
        { key: "cancel", label: "Cancel" },
      ];

  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    if (isEscape(input, key)) {
      onChoose("cancel");
      return;
    }
    if (key.upArrow || input === "k") {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setIndex((i) => Math.min(choices.length - 1, i + 1));
      return;
    }
    if (input === "m" && atRisk) {
      onChoose("merge-then-fire");
      return;
    }
    if (input === "f") {
      onChoose("fire");
      return;
    }
    if (isReturn(input, key)) {
      onChoose(choices[index].key);
    }
  });

  const inner = Math.max(24, width - 4);

  return (
    <Modal
      title={`Fire ${agent.name}?`}
      footer="↑↓ choose · enter confirm · esc cancel"
      width={width}
      color={atRisk ? "red" : "yellow"}
    >
      <Text dimColor>
        {fit(
          `${agent.delegations} delegation${agent.delegations === 1 ? "" : "s"} · ${compactUsd(agent.spentUsd)} spent · ${agent.isolated ? branchNameFor(agent.name) : "main tree"}`,
          inner,
        )}
      </Text>

      {atRisk ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red" bold>
            {fit(
              `${unmerged.length} commit${unmerged.length === 1 ? "" : "s"} on ${branchNameFor(agent.name)} ${unmerged.length === 1 ? "is" : "are"} not on ${base}.`,
              inner,
            )}
          </Text>
          {wrap(
            "Firing loses that work from the org: the agent leaves the roster and nothing in CEO points at the branch again.",
            inner,
            2,
          ).map((line, i) => (
            <Text key={i} color="red">
              {line}
            </Text>
          ))}
          {unmerged.slice(0, MAX_SHOWN_COMMITS).map((line) => (
            // `fit` collapses leading whitespace, so the indent goes outside it.
            <Text key={line} dimColor>
              {`  ${fit(line, inner - 2)}`}
            </Text>
          ))}
          {unmerged.length > MAX_SHOWN_COMMITS ? (
            <Text dimColor>{`  +${unmerged.length - MAX_SHOWN_COMMITS} more`}</Text>
          ) : null}
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        {choices.map((choice, i) => (
          <Text
            key={choice.key}
            color={i === index ? choice.color ?? "cyan" : undefined}
            bold={i === index}
            dimColor={i !== index}
          >
            {`${i === index ? "❯" : " "} ${fit(choice.label, inner - 2)}`}
          </Text>
        ))}
      </Box>
    </Modal>
  );
}

export default FireDialog;
