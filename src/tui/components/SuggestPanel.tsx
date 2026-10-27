/**
 * The proposed team, with the evidence for the selected seat.
 *
 * Every seat shows the same line the roster will: provider, model, level,
 * cap. The right-hand block is the reason it is proposed, in checkable
 * sentences: which Reflex workflow, how many sessions, what a run costs
 * here. A proposal nobody can check is a guess with a confident face.
 *
 * Enter opens the hire form with the seat filled in, because a suggestion
 * is a draft, not a decision: the person reads the brief, changes the
 * budget, and hires. `H` hires every seat as proposed, for the case where
 * the proposal is obviously right and the form would be eight times the
 * same keystrokes.
 */

import { Box, Text, useInput } from "ink";
import { useState } from "react";

import type { ReflexStatus } from "../../core/reflex.js";
import type { TeamProposal, TeamSuggestion } from "../../core/suggest.js";
import { isEscape, isReturn } from "../keys.js";
import { autonomyColor, clamp, fit, providerColor, wrap } from "../format.js";
import Modal from "./Modal.js";

export type SuggestPanelProps = {
  proposal: TeamProposal | null;
  error: string | null;
  reflex: ReflexStatus;
  /** A `reflex scan` in flight: its elapsed seconds and last output line. */
  scan: { running: boolean; startedAt: number; lastLine: string; error: string | null } | null;
  onScan: () => void;
  width: number;
  onHireOne: (seat: TeamSuggestion) => void;
  onHireAll: (seats: TeamSuggestion[]) => void;
  onClose: () => void;
};

export function SuggestPanel({ proposal, error, reflex, scan, onScan, width, onHireOne, onHireAll, onClose }: SuggestPanelProps) {
  const [index, setIndex] = useState(0);
  const team = proposal?.team ?? [];
  const selected = team[clamp(index, 0, Math.max(0, team.length - 1))] ?? null;
  const inner = Math.max(30, width - 4);

  useInput((input, key) => {
    if (isEscape(input, key) || input === "q") {
      onClose();
      return;
    }
    if (input === "s" && reflex.installed && !scan?.running) {
      onScan();
      return;
    }
    if (!proposal) return;
    if (key.upArrow || input === "k") setIndex((i) => clamp(i - 1, 0, team.length - 1));
    if (key.downArrow || input === "j") setIndex((i) => clamp(i + 1, 0, team.length - 1));
    if (isReturn(input, key) && selected) onHireOne(selected);
    if (input === "H" && team.length > 0) onHireAll(team);
  });

  if (error) {
    return (
      <Modal title="Suggested team" footer="esc close" width={width}>
        {wrap(error, inner, 4).map((line, i) => (
          <Text key={i} color="red">
            {line}
          </Text>
        ))}
      </Modal>
    );
  }
  if (!proposal) {
    return (
      <Modal title="Suggested team" footer="esc close" width={width}>
        <Text dimColor>reading Reflex, codex and Claude Code history for this directory…</Text>
      </Modal>
    );
  }

  const nameWidth = clamp(Math.max(...team.map((s) => s.name.length), 6), 6, 28);
  // The scan key is offered whenever Reflex is there: a fresh scan picks up
  // the org's own runs since the last one, which is the loop this closes.
  const scanKey = !reflex.installed ? "" : scan?.running ? " · scanning…" : reflex.scanned ? " · s rescan with Reflex" : " · s scan with Reflex";

  return (
    <Modal
      title="Suggested team"
      footer={`↑↓ seat · enter edit and hire · H hire all as proposed${scanKey} · esc close`}
      width={width}
    >
      {proposal.summary.flatMap((line, i) =>
        wrap(line, inner, 2).map((l, j) => (
          <Text key={`${i}-${j}`} dimColor>
            {l}
          </Text>
        )),
      )}
      {scan?.running ? (
        <Text color="yellow">
          {fit(`reflex scan running ${Math.max(0, Math.round((Date.now() - scan.startedAt) / 1000))}s${scan.lastLine ? ` · ${scan.lastLine}` : ""}`, inner)}
        </Text>
      ) : scan?.error ? (
        <Text color="red">{fit(`reflex scan failed: ${scan.error}`, inner)}</Text>
      ) : null}
      {!reflex.installed ? (
        <Text dimColor>{fit("Reflex adds evidence from repeated workflows: npm i -g reflex-skills", inner)}</Text>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        {team.length === 0 ? (
          <Text dimColor>Nothing to suggest here yet. Press h to hire by hand.</Text>
        ) : (
          team.map((s, i) => {
            const sel = s === selected;
            return (
              <Box key={s.name}>
                <Text inverse={sel} bold={sel}>{`${sel ? "❯ " : "  "}${s.name.padEnd(nameWidth)} `}</Text>
                <Text inverse={sel} color={providerColor(s.provider)}>{`${s.provider} `}</Text>
                <Text inverse={sel} dimColor>{`${s.model} `}</Text>
                <Text inverse={sel} color={autonomyColor(s.autonomy)}>{`${s.autonomy} `}</Text>
                <Text inverse={sel} dimColor>{fit(`$${s.budgetUsd}${s.isolated ? " ⎇" : ""}${s.source === "reflex" ? " · reflex" : ""}`, Math.max(4, inner - nameWidth - s.model.length - 24))}</Text>
                {i === 0 ? null : null}
              </Box>
            );
          })
        )}
      </Box>

      {selected ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold>{fit(selected.name, inner)}</Text>
          {wrap(selected.role.split("\n")[0], inner, 3).map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
          {selected.role.includes("\n") ? <Text dimColor>{fit("(full workflow steps in the brief; enter to read and edit)", inner)}</Text> : null}
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Why</Text>
            {selected.evidence.flatMap((e, i) =>
              wrap(`· ${e}`, inner, 3).map((line, j) => (
                <Text key={`${i}-${j}`} dimColor>
                  {line}
                </Text>
              )),
            )}
            {selected.guardrails.length > 0 ? (
              <Text color="yellow">{fit(`guardrails: ${selected.guardrails.join(" / ")}`, inner)}</Text>
            ) : null}
          </Box>
        </Box>
      ) : null}
    </Modal>
  );
}

export default SuggestPanel;
