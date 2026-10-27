/**
 * Audit report writer.
 *
 * The CEO-Auditor subagent reads the ledger and hands back a findings
 * array. This module is the only thing that turns those findings into a
 * durable artifact: a markdown report under `.ceo/audits/` plus one
 * `audit` ledger entry pointing at it. Keeping the write here means the
 * report and the ledger row are produced together and cannot drift.
 */

import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { append } from "../core/ledger.js";
import { auditsDir, ensureCeoDirs } from "../core/paths.js";
import type { AuditFinding, AuditReport } from "../core/types.js";

const CATEGORY_ORDER: AuditFinding["category"][] = [
  "drift",
  "redundancy",
  "cost",
  "coordination",
];

/** Colons are legal on APFS but hostile elsewhere, so the stamp uses dashes. */
function stampFor(ts: number): string {
  return new Date(ts).toISOString().replace(/:/g, "-");
}

function renderReport(
  ts: number,
  windowStartSeq: number,
  windowEndSeq: number,
  findings: AuditFinding[],
): string {
  const counts = CATEGORY_ORDER.map(
    (c) => [c, findings.filter((f) => f.category === c).length] as const,
  ).filter(([, n]) => n > 0);

  const lines: string[] = [
    `# CEO audit ${new Date(ts).toISOString()}`,
    "",
    `- Ledger window: seq ${windowStartSeq}–${windowEndSeq}`,
    `- Findings: ${findings.length}`,
  ];

  if (counts.length > 0) {
    lines.push(`- By category: ${counts.map(([c, n]) => `${c} ${n}`).join(", ")}`);
  }
  lines.push("");

  if (findings.length === 0) {
    lines.push("No findings. The org is behaving.", "");
    return lines.join("\n");
  }

  // Grouped by category so a reader can triage cost separately from drift.
  for (const category of CATEGORY_ORDER) {
    const inCat = findings.filter((f) => f.category === category);
    if (inCat.length === 0) continue;
    lines.push(`## ${category}`, "");
    for (const f of inCat) {
      lines.push(`### ${f.agent ?? "(org-wide)"}`, "", f.summary.trim(), "");
      if (f.recommendation && f.recommendation.trim()) {
        lines.push(`**Recommendation:** ${f.recommendation.trim()}`, "");
      }
    }
  }

  return lines.join("\n");
}

/**
 * Write the report and append the matching `audit` ledger entry.
 *
 * The file is written before the ledger row so a crash between the two
 * leaves an orphan report, which is harmless, rather than a ledger row
 * pointing at a file that does not exist, which is a broken provenance link.
 */
export function writeAudit(
  input: {
    findings: AuditFinding[];
    windowStartSeq: number;
    windowEndSeq: number;
  },
  cwd?: string,
): AuditReport {
  const { findings, windowStartSeq, windowEndSeq } = input;

  if (!Number.isInteger(windowStartSeq) || windowStartSeq < 0) {
    throw new Error("windowStartSeq must be a non-negative integer ledger seq.");
  }
  if (!Number.isInteger(windowEndSeq) || windowEndSeq < windowStartSeq) {
    throw new Error(
      `windowEndSeq must be an integer >= windowStartSeq, got ${windowEndSeq} and ${windowStartSeq}.`,
    );
  }

  ensureCeoDirs(cwd);
  const ts = Date.now();
  const reportPath = path.join(auditsDir(cwd), `${stampFor(ts)}.md`);
  writeFileSync(
    reportPath,
    renderReport(ts, windowStartSeq, windowEndSeq, findings),
    "utf8",
  );

  append(
    "audit",
    null,
    {
      reportPath,
      windowStartSeq,
      windowEndSeq,
      findingCount: findings.length,
      categories: CATEGORY_ORDER.filter((c) =>
        findings.some((f) => f.category === c),
      ),
      agents: [...new Set(findings.map((f) => f.agent).filter(Boolean))],
    },
    cwd,
  );

  return { ts, windowStartSeq, windowEndSeq, findings, reportPath };
}
