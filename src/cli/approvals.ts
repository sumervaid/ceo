/**
 * `ceo approvals`: the requests that wait for a decision.
 *
 *   ceo approvals                    list pending requests with evidence
 *   ceo approvals approve <id>       approve one; a merge runs now
 *   ceo approvals deny <id>          deny one
 *   ceo approvals auto-merge on|off  let a merge that clears the evidence rule land alone
 *
 * Without an argument, the auto-merge setting is shown above the list.
 */

import { decideApproval, evidenceLines, gateSettings, pendingApprovals, setAutoMerge } from "../core/gates.js";

function fail(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

export function approvalsCmd(args: string[], cwd: string): void {
  const [verb = "ls", ...rest] = args;
  switch (verb) {
    case "ls":
    case "list": {
      const pending = pendingApprovals(cwd);
      process.stdout.write(`Auto-merge is ${gateSettings(cwd).autoMerge ? "on" : "off"}.\n`);
      if (pending.length === 0) {
        process.stdout.write("No approvals are waiting.\n");
        return;
      }
      for (const a of pending) {
        process.stdout.write(`\n${a.id}  ${a.action}  ${a.summary}\n`);
        for (const line of evidenceLines(a.evidence)) process.stdout.write(`    ${line}\n`);
      }
      process.stdout.write("\nceo approvals approve <id> or ceo approvals deny <id>\n");
      return;
    }
    case "approve":
    case "deny": {
      const id = rest[0];
      if (!id) return fail(`Usage: ceo approvals ${verb} <id>`);
      const r = decideApproval(id, verb === "approve", cwd);
      if (!r.ok) return fail(r.message);
      process.stdout.write(`${r.message}\n`);
      return;
    }
    case "auto-merge": {
      const v = rest[0]?.toLowerCase();
      if (v !== "on" && v !== "off") return fail("Usage: ceo approvals auto-merge on|off");
      setAutoMerge(v === "on", cwd);
      process.stdout.write(`Auto-merge is ${v}.\n`);
      return;
    }
    default:
      return fail("Usage: ceo approvals [ls | approve <id> | deny <id> | auto-merge on|off]");
  }
}
