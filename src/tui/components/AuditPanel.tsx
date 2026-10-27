/**
 * Last audit: when it ran, what it found, and the top findings.
 *
 * The ledger row carries the count. The prose lives in the report markdown,
 * which the data layer parses back. When the report file is gone the panel
 * says so rather than showing an audit with mysteriously zero findings. A
 * missing report is a broken provenance link, not a clean bill of health.
 */

import { Box, Text } from "ink";
import type { AuditSummary } from "../data.js";
import { fit, sinceHuman } from "../format.js";

export type AuditPanelProps = {
  /** Newest first. */
  audits: AuditSummary[];
  /** Inner content width, borders and padding already subtracted. */
  width: number;
  /** Finding lines to show under the summary. */
  maxFindings: number;
};

export function AuditPanel({ audits, width, maxFindings }: AuditPanelProps) {
  const latest = audits[0];

  if (!latest) {
    return (
      <Text>
        <Text bold color="cyan">{"Audit  "}</Text>
        <Text dimColor>{fit("none yet · a to see how to run one", Math.max(4, width - 7))}</Text>
      </Text>
    );
  }

  const clean = latest.findingCount === 0;
  const noun = latest.findingCount === 1 ? "finding" : "findings";
  const shown = latest.findings.slice(0, Math.max(0, maxFindings));

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>Last: </Text>
        <Text>{sinceHuman(latest.ts)} ago</Text>
        <Text dimColor> · </Text>
        <Text color={clean ? "green" : "yellow"}>
          {latest.findingCount} {noun}
        </Text>
        {audits.length > 1 ? (
          <Text dimColor>{` · ${audits.length} audits on record`}</Text>
        ) : null}
      </Box>

      {!latest.reportPresent && latest.reportPath ? (
        <Text color="red">
          {fit(`Report missing on disk: ${latest.reportPath}`, width)}
        </Text>
      ) : null}

      {clean ? (
        <Text dimColor>{fit("No findings. The org is behaving.", width)}</Text>
      ) : null}

      {shown.map((f, i) => {
        const who = f.agent ?? "org-wide";
        const lead = `${f.category} · ${who}: `;
        return (
          <Box key={i}>
            <Text color="yellow">{`${f.category} · `}</Text>
            <Text>{`${who}: `}</Text>
            <Text dimColor>{fit(f.summary, Math.max(0, width - lead.length))}</Text>
          </Box>
        );
      })}

      {!clean && latest.findingCount > shown.length ? (
        <Text dimColor>
          {fit(
            `+${latest.findingCount - shown.length} more in ${latest.reportPath ?? "the report"}`,
            width,
          )}
        </Text>
      ) : null}
    </Box>
  );
}

export default AuditPanel;
