/**
 * Land an agent's branch, or explain why it did not land.
 *
 * Two states in one component: the confirm before the merge, and the
 * conflict report after a failed one. The report lists the files and stops
 * there. Nothing in this dashboard is qualified to pick a side in a merge
 * conflict. An automatic abort would throw away a merge someone may want
 * to finish by hand in the shell they already have open. So the conflicted
 * state is left exactly as git left it, and the dialog says so.
 */

import { Box, Text, useInput } from "ink";
import { isTab, isReturn, isEscape } from "../keys.js";

import { branchNameFor } from "../../core/git.js";
import type { AgentRecord } from "../../core/types.js";
import { fit, wrap } from "../format.js";
import Modal from "./Modal.js";

const MAX_SHOWN = 8;

export type MergeDialogProps = {
  agent: AgentRecord;
  unmerged: string[];
  base: string;
  width: number;
  onConfirm: () => void;
  onCancel: () => void;
};

export function MergeDialog({
  agent,
  unmerged,
  base,
  width,
  onConfirm,
  onCancel,
}: MergeDialogProps) {
  useInput((input, key) => {
    if (isEscape(input, key)) {
      onCancel();
      return;
    }
    if (key.return) onConfirm();
  });

  const inner = Math.max(24, width - 4);
  const branch = branchNameFor(agent.name);

  return (
    <Modal
      title={`Merge ${branch} into ${base}?`}
      footer="enter merge · esc cancel"
      width={width}
    >
      {unmerged.length === 0 ? (
        <Text dimColor>
          {fit(
            `${branch} has nothing that ${base} does not already have. Merging will be a no-op.`,
            inner,
          )}
        </Text>
      ) : (
        <Box flexDirection="column">
          <Text>
            {fit(
              `${unmerged.length} commit${unmerged.length === 1 ? "" : "s"} to land, with --no-ff so the merge is visible in history:`,
              inner,
            )}
          </Text>
          {unmerged.slice(0, MAX_SHOWN).map((line) => (
            <Text key={line} dimColor>
              {`  ${fit(line, inner - 2)}`}
            </Text>
          ))}
          {unmerged.length > MAX_SHOWN ? (
            <Text dimColor>{`  +${unmerged.length - MAX_SHOWN} more`}</Text>
          ) : null}
        </Box>
      )}
    </Modal>
  );
}

export type ConflictReportProps = {
  agentName: string;
  conflicts: string[];
  error: string;
  width: number;
  onClose: () => void;
};

export function ConflictReport({
  agentName,
  conflicts,
  error,
  width,
  onClose,
}: ConflictReportProps) {
  useInput((input, key) => {
    if (isEscape(input, key) || key.return) onClose();
  });

  const inner = Math.max(24, width - 4);

  return (
    <Modal
      title={`Merge of ${branchNameFor(agentName)} stopped`}
      footer="esc close"
      width={width}
      color="red"
    >
      {conflicts.length > 0 ? (
        <Box flexDirection="column">
          <Text color="red" bold>
            {fit(
              `${conflicts.length} conflicted file${conflicts.length === 1 ? "" : "s"}:`,
              inner,
            )}
          </Text>
          {conflicts.slice(0, MAX_SHOWN).map((f) => (
            <Text key={f}>{`  ${fit(f, inner - 2)}`}</Text>
          ))}
          {conflicts.length > MAX_SHOWN ? (
            <Text dimColor>{`  +${conflicts.length - MAX_SHOWN} more`}</Text>
          ) : null}
          <Box marginTop={1} flexDirection="column">
            {wrap(
              "The working tree stays mid-merge, exactly as git left the tree. Resolve the conflicts in a shell, then commit. git merge --abort undoes the merge.",
              inner,
              3,
            ).map((line, i) => (
              <Text key={i} dimColor>
                {line}
              </Text>
            ))}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {wrap(error, inner, 6).map((line, i) => (
            <Text key={i} color="red">
              {line}
            </Text>
          ))}
        </Box>
      )}
    </Modal>
  );
}

export default MergeDialog;
