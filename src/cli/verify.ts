/**
 * `ceo verify` and the mission's checks on the command line.
 *
 *   ceo verify <spec> [--in <dir>]   run one check now
 *   ceo mission                      the objective, and the checks when there are any
 *   ceo mission checks               list the checks with the last result of each
 *   ceo mission checks add <spec>    add a check
 *   ceo mission check                run every check; exit 1 unless the mission is met
 *
 * A spec is the text `parseVerifier` reads: `npm test`, `everval:evals/retry.json#flaky`,
 * `judge:the fix is minimal`.
 */

import * as path from "node:path";

import { addCheck, checkMission, current, missionStatus, type CheckState } from "../core/mission.js";
import { orgExists, projectRoot } from "../core/paths.js";
import { parseVerifier, recordVerify, runVerifier, verifierName } from "../core/verifiers.js";

const MARK: Record<CheckState, string> = { pass: "✓", fail: "✗", error: "!", unknown: "·" };

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

/** Run one check now and print the result. Exit 1 unless it passes. */
export async function verifyCmd(args: string[], cwd: string): Promise<void> {
  let dir: string | undefined;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--in") dir = args[++i];
    else words.push(args[i]);
  }
  const text = words.join(" ").trim();
  if (!text) {
    err("Usage: ceo verify <spec> [--in <dir>]. A spec is a command, everval:<file>#<scenario> or judge:<rubric>.");
    process.exitCode = 1;
    return;
  }
  if (dir !== undefined && !dir) {
    err("--in needs a directory.");
    process.exitCode = 1;
    return;
  }
  const spec = parseVerifier(text);
  const root = projectRoot(cwd);
  const ctx = { root, workdir: path.resolve(cwd, dir ?? "."), scope: "task" as const };
  const result = await runVerifier(spec, ctx);
  if (orgExists(cwd)) recordVerify(spec, ctx, result);
  out(`${MARK[result.status]} ${verifierName(spec)}  ${result.status}${result.score !== null ? `  ${result.score.toFixed(2)}` : ""}`);
  out(`  ${result.detail}`);
  if (!orgExists(cwd)) out("  No org here, so the result is not in a ledger.");
  if (result.status !== "pass") process.exitCode = 1;
}

/** `ceo mission`, `ceo mission checks [add <spec>]` and `ceo mission check`. */
export async function missionCheckCmd(args: string[], cwd: string): Promise<void> {
  if (!orgExists(cwd)) {
    err("No org in this project. Run `ceo` and press n to start one.");
    process.exitCode = 1;
    return;
  }
  const [verb = "", ...rest] = args;
  switch (verb) {
    case "":
    case "show": {
      const m = current(cwd);
      if (!m) {
        out("No mission yet. Set one from the dashboard with M.");
        return;
      }
      out(m.objective);
      if (m.successCriteria.length > 0) out(`done when: ${m.successCriteria.join(" · ")}`);
      listChecks(cwd);
      return;
    }
    case "checks": {
      if (rest[0] === "add") {
        const text = rest.slice(1).join(" ").trim();
        if (!text) {
          err('Usage: ceo mission checks add "<spec>"');
          process.exitCode = 1;
          return;
        }
        try {
          const spec = parseVerifier(text);
          addCheck(spec, cwd);
          out(`Added: ${verifierName(spec)}`);
        } catch (e) {
          err(e instanceof Error ? e.message : String(e));
          process.exitCode = 1;
        }
        return;
      }
      listChecks(cwd);
      return;
    }
    case "check": {
      const m = current(cwd);
      if (!m) {
        err("No mission yet. Set one from the dashboard with M.");
        process.exitCode = 1;
        return;
      }
      if (!m.checks || m.checks.length === 0) {
        err('The mission has no checks. Add one: ceo mission checks add "<spec>"');
        process.exitCode = 1;
        return;
      }
      const verdict = await checkMission(cwd);
      for (const { spec, result } of verdict.results) {
        out(`${MARK[result.status]} ${verifierName(spec)}  ${result.detail}`);
      }
      if (verdict.pass) out("Mission met.");
      else out(verdict.errored ? "Mission not met. A check could not run." : "Mission not met.");
      if (!verdict.pass) process.exitCode = 1;
      return;
    }
    default:
      err(`Unknown: ceo mission ${verb}. Try \`ceo mission checks\` or \`ceo mission check\`.`);
      process.exitCode = 1;
  }
}

function listChecks(cwd: string): void {
  const rows = missionStatus(cwd);
  if (rows.length === 0) {
    out('No checks. Add one: ceo mission checks add "<spec>"');
    return;
  }
  for (const r of rows) {
    out(`${MARK[r.state]} ${r.name}  ${r.state}${r.detail ? `  ${r.detail.replace(/\s+/g, " ").slice(0, 80)}` : ""}`);
  }
}
