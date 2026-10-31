/**
 * Approvals: the actions waiting on a decision.
 *
 * Each row is one request. The selected row opens to show the evidence the
 * request rests on: the verdict, each check and each judge's vote. The
 * decision is a single key. Approving a merge runs the merge. Approving an
 * outward action records the decision, because CEO has no executor for
 * those yet, and the result line says so.
 */

import { Box, Text, useInput } from "ink";
import { useState } from "react";

import { decideApproval, evidenceLines, gateSettings, pendingApprovals, type Approval } from "../../core/gates.js";
import { isEscape } from "../keys.js";
import { clamp, fit } from "../format.js";
import Modal from "./Modal.js";

const MAX_ROWS = 6;

export type ApprovalsProps = {
  cwd: string;
  width: number;
  /** The outcome of a decision, for the flash line. */
  onReport: (result: { ok: boolean; message: string }) => void;
  onClose: () => void;
};

function lineColor(line: string): "green" | "red" | "yellow" | undefined {
  if (/: pass$|^verdict pass|^judge \S+ pass/.test(line)) return "green";
  if (/: (fail|error)$|^verdict fail|^judge \S+ fail/.test(line)) return "red";
  if (/no verdict|no checks/.test(line)) return "yellow";
  return undefined;
}

export function Approvals({ cwd, width, onReport, onClose }: ApprovalsProps) {
  const [items, setItems] = useState<Approval[]>(() => safePending(cwd));
  const [index, setIndex] = useState(0);
  const inner = Math.max(24, width - 4);
  const at = clamp(index, 0, Math.max(0, items.length - 1));
  const current = items[at] ?? null;

  const decide = (approved: boolean) => {
    if (!current) return;
    onReport(decideApproval(current.id, approved, cwd));
    const next = safePending(cwd);
    setItems(next);
    setIndex((i) => clamp(i, 0, Math.max(0, next.length - 1)));
  };

  useInput((input, key) => {
    if (isEscape(input, key)) return onClose();
    if (key.upArrow || input === "k") return setIndex((i) => Math.max(0, i - 1));
    if (key.downArrow || input === "j") return setIndex((i) => Math.min(items.length - 1, i + 1));
    if (input === "a") return decide(true);
    if (input === "x") return decide(false);
  });

  const start = clamp(at - Math.floor(MAX_ROWS / 2), 0, Math.max(0, items.length - MAX_ROWS));
  const shown = items.slice(start, start + MAX_ROWS);
  const autoMerge = gateSettings(cwd).autoMerge;

  return (
    <Modal
      title={`Approvals · ${items.length} waiting`}
      footer="↑↓ select · a approve · x deny · esc close"
      width={width}
      color="yellow"
    >
      <Text dimColor>{fit(`Auto-merge is ${autoMerge ? "on" : "off"}. Outward actions always wait here.`, inner)}</Text>
      {items.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No approvals are waiting.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {shown.map((a, i) => {
            const selected = start + i === at;
            return (
              <Box key={a.id} flexDirection="column">
                <Text color={selected ? "cyan" : undefined} bold={selected} dimColor={!selected}>
                  {`${selected ? "❯" : " "} ${fit(`${a.id}  ${a.action}  ${a.summary}`, inner - 2)}`}
                </Text>
                {selected
                  ? evidenceLines(a.evidence).map((line, n) => (
                      <Text key={n} color={lineColor(line)} dimColor={!lineColor(line)}>
                        {`    ${fit(line, inner - 4)}`}
                      </Text>
                    ))
                  : null}
              </Box>
            );
          })}
          {items.length > MAX_ROWS ? <Text dimColor>{`  ${items.length} requests, ${MAX_ROWS} shown`}</Text> : null}
        </Box>
      )}
    </Modal>
  );
}

function safePending(cwd: string): Approval[] {
  try {
    return pendingApprovals(cwd);
  } catch {
    return [];
  }
}

export default Approvals;
