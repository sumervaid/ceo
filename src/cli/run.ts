/**
 * `ceo run <task>`: run a queued task now, headless, as attempts when the
 * task asks for them, and print the verdict.
 *
 *   ceo run ab12cd                 the task's own samples and verifiers
 *   ceo run ab12cd --samples 3     three attempts across the router's arms
 *
 * The exit code is 0 when the task reached done, 1 otherwise.
 */

import "../core/evidence.js";
import { attemptsFor, runTask, usesAttempts } from "../core/attempts.js";
import { runDelegation } from "../core/runner.js";
import { findTask } from "../core/tasks.js";
import { armLabel } from "../core/types.js";

export async function runCmd(args: string[], cwd: string): Promise<void> {
  const id = args.find((a) => !a.startsWith("--"));
  const sIdx = args.indexOf("--samples");
  const samples = sIdx >= 0 ? Number(args[sIdx + 1]) : undefined;
  const fail = (m: string) => {
    process.stderr.write(`${m}\n`);
    process.exitCode = 1;
  };
  if (!id) return fail("Usage: ceo run <task id> [--samples n]");
  const task = findTask(id, cwd);
  if (!task) return fail(`No task with id ${id}.`);
  if (!task.assignee) return fail(`Task ${id} has no assignee. ceo task ${id} assign <agent> first.`);

  if (!usesAttempts(task) && !(samples && samples > 1)) {
    process.stdout.write(`Running ${task.id} on ${task.assignee}: ${task.title}\n`);
    const r = await runDelegation(task.assignee, task.title, { cwd, taskId: task.id }).finished;
    process.stdout.write(r.ok ? `Done for $${r.costUsd.toFixed(4)}${r.costIsEstimate ? " est." : ""}.\n` : `Failed: ${r.error}\n`);
    if (!r.ok) process.exitCode = 1;
    return;
  }

  const run = runTask(task.id, {
    cwd,
    ...(samples ? { samples } : {}),
    onStart: (a) => process.stdout.write(`  attempt ${a.id}  ${armLabel(a.arm).padEnd(28)} ${a.mode}\n`),
    onEnd: (attemptId, r) => process.stdout.write(`  attempt ${attemptId}  ${r.ok ? "finished" : r.rateLimit ? "limited" : "failed"} · $${r.costUsd.toFixed(4)}\n`),
  });
  process.stdout.write(`Running ${task.id} as ${run.attempts.length} attempt${run.attempts.length === 1 ? "" : "s"}: ${task.title}\n`);
  const out = await run.finished;
  for (const a of attemptsFor(task.id, cwd)) {
    const v = a.verdict ? `${a.verdict.pass ? "✓" : "✗"} ${a.verdict.score.toFixed(2)}` : a.outcome ?? "·";
    process.stdout.write(`  ${a.id === out.winner?.id ? "★" : " "} ${a.id}  ${armLabel(a.arm).padEnd(28)} ${v}\n`);
  }
  process.stdout.write(`${out.status}: ${out.note}\n`);
  if (out.status !== "done") process.exitCode = 1;
}
