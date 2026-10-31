/**
 * Judges: agents that read finished work and cast votes.
 *
 * A judge check is a vote, not a test. Each judge runs at observe level.
 * The process cannot write. The run starts in the attempt's worktree.
 * The prompt carries the task, the rubric and the diff from the base.
 *
 * Judges come from providers other than the attempt's. Two models from one
 * family share blind spots. A second family is the cheaper way to find
 * the gaps. When one provider is ready, the same provider judges.
 *
 * Agreement decides. Every judge must say pass for the check to pass. One
 * fail fails the check. A vote that cannot be read blocks agreement. The
 * check then gives an error, never a pass. Each vote is recorded as evidence.
 *
 * One judge agent per provider, `judge-<provider>`, is hired on first use.
 * Later checks reuse the agent. The agent stays pinned to observe. A roster
 * entry of that name at a higher level is refused. The observe level is the
 * control that keeps a judge from writing.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import { runDelegation } from "./runner.js";
import { findAgent, hire } from "./roster.js";
import { providerReadiness } from "./setup.js";
import { providerFor } from "./providers.js";
import { PROVIDERS, type Provider, type VerifierSpec } from "./types.js";
import { registerVerifier, type VerifyContext, type VerifyResult } from "./verify.js";

const DIFF_LIMIT = 40000;
const NEW_FILE_LIMIT = 4000;
const NEW_FILES_SHOWN = 20;
const DEFAULT_JUDGES = 2;

export type JudgeVote = {
  provider: Provider;
  model: string;
  agent: string;
  verdict: "pass" | "fail" | null;
  reason: string;
  delegationId: string | null;
  costUsd: number;
  /** Why no verdict came back. Absent when one did. */
  error?: string;
};

export function judgeAgentName(provider: Provider): string {
  return `judge-${provider}`;
}

const JUDGE_BRIEF =
  "Judge finished work against a rubric. Read the task, the rubric and the diff. Check the diff against each point of the rubric. Give a verdict of pass only when the rubric is met. Give fail when any point is missed. Never edit anything.";

function providerIsReady(p: Provider): boolean {
  return Boolean(process.env.CEO_SKIP_SETUP_CHECK) || providerReadiness(p).ready;
}

/** The providers that judge, in order. Other providers first, the attempt's own only as the fallback. */
export function judgeProviders(spec: Extract<VerifierSpec, { kind: "judge" }>, attemptProvider: string | null | undefined): Provider[] {
  const ready = (spec.providers ?? PROVIDERS).filter(providerIsReady);
  const others = ready.filter((p) => p !== attemptProvider);
  return others.length > 0 ? others : ready;
}

/** The judge agent for a provider. Hired once, then reused. */
export function ensureJudge(provider: Provider, cwd: string) {
  const name = judgeAgentName(provider);
  const found = findAgent(name, cwd);
  if (found) return found;
  return hire({ name, role: JUDGE_BRIEF, provider, autonomy: "observe", isolated: false, budgetUsd: 5 }, cwd);
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

/** The change under judgment: tracked changes from the base, then the new files. Cut at 40k characters. */
export function diffFor(workdir: string, base: string | null | undefined): string {
  let text = "";
  try {
    text = git(["diff", base || "HEAD"], workdir);
    const fresh = git(["ls-files", "--others", "--exclude-standard"], workdir).split("\n").filter(Boolean);
    for (const file of fresh.slice(0, NEW_FILES_SHOWN)) {
      let body = "";
      try {
        body = readFileSync(path.join(workdir, file), "utf8").slice(0, NEW_FILE_LIMIT);
      } catch {
        body = "[unreadable]";
      }
      text += `\nnew file: ${file}\n${body}\n`;
    }
    if (fresh.length > NEW_FILES_SHOWN) text += `\n${fresh.length - NEW_FILES_SHOWN} more new files not shown.\n`;
  } catch {
    return "No git diff is available for this directory.";
  }
  if (!text.trim()) return "The diff is empty.";
  return text.length > DIFF_LIMIT ? `${text.slice(0, DIFF_LIMIT)}\n[diff cut at ${DIFF_LIMIT} characters]` : text;
}

export function judgePrompt(task: string, rubric: string, diff: string): string {
  return [
    "Judge the work below against the rubric.",
    "",
    `Task: ${task}`,
    "",
    `Rubric: ${rubric}`,
    "",
    "Diff:",
    diff,
    "",
    "Reply with a short assessment. End with exactly two lines.",
    "The first line is VERDICT: pass or VERDICT: fail.",
    "The second line is REASON: one sentence.",
  ].join("\n");
}

/** The last VERDICT line wins. A missing verdict is null. */
export function parseVerdict(text: string): { verdict: "pass" | "fail" | null; reason: string } {
  let verdict: "pass" | "fail" | null = null;
  for (const m of text.matchAll(/^[\s*_`>-]*VERDICT:\s*(pass|fail)\b/gim)) verdict = m[1].toLowerCase() as "pass" | "fail";
  let reason = "";
  for (const m of text.matchAll(/^[\s*_`>-]*REASON:\s*(.+)$/gim)) reason = m[1].trim();
  return { verdict, reason: reason.slice(0, 300) };
}

async function vote(provider: Provider, index: number, spec: Extract<VerifierSpec, { kind: "judge" }>, ctx: VerifyContext): Promise<JudgeVote> {
  const agentName = judgeAgentName(provider);
  const model = providerFor(provider).defaultModel();
  const base: JudgeVote = { provider, model, agent: agentName, verdict: null, reason: "", delegationId: null, costUsd: 0 };
  let agent;
  try {
    agent = ensureJudge(provider, ctx.root);
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
  if (agent.autonomy !== "observe") return { ...base, error: `${agentName} is at ${agent.autonomy}. A judge runs at observe.` };

  const title = ctx.task?.trim() || "the task";
  const prompt = judgePrompt(title, spec.rubric, diffFor(ctx.workdir, ctx.base));
  const handle = runDelegation(agentName, `Judge: ${title}`.slice(0, 200), {
    cwd: ctx.root,
    taskId: ctx.taskId ?? undefined,
    attempt: { id: `j${index}${randomBytes(2).toString("hex")}`, arm: { provider, model }, workdir: ctx.workdir },
    via: "judge",
    prompt,
  });
  const r = await handle.finished;
  const parsed = r.ok ? parseVerdict(r.text) : { verdict: null, reason: "" };
  return {
    ...base,
    verdict: parsed.verdict,
    reason: parsed.reason,
    delegationId: r.delegationId,
    costUsd: r.costUsd,
    ...(parsed.verdict ? {} : { error: r.ok ? "The reply had no VERDICT line." : r.error ?? "The run failed." }),
  };
}

/** Combine votes. Agreement passes, one fail fails, an unread vote without a fail is an error. */
export function tally(votes: JudgeVote[]): VerifyResult {
  const costUsd = votes.reduce((n, v) => n + v.costUsd, 0);
  const passes = votes.filter((v) => v.verdict === "pass").length;
  const fails = votes.filter((v) => v.verdict === "fail").length;
  const unread = votes.length - passes - fails;
  const evidence = { judges: votes, agreement: fails === 0 && unread === 0 && passes > 0 };
  const list = votes.map((v) => `${v.provider} ${v.verdict ?? "no verdict"}`).join(", ");
  if (passes + fails === 0) return { status: "error", score: null, detail: `No judge gave a verdict: ${list}.`, evidence, costUsd };
  const score = passes / votes.length;
  if (fails > 0) return { status: "fail", score, detail: `${fails} of ${votes.length} judges failed the work: ${list}.`, evidence, costUsd };
  if (unread > 0) return { status: "error", score, detail: `${unread} of ${votes.length} judges gave no verdict: ${list}.`, evidence, costUsd };
  return { status: "pass", score, detail: `${passes} of ${votes.length} judges passed the work: ${list}.`, evidence, costUsd };
}

registerVerifier("judge", {
  describe: (spec) => (spec.kind === "judge" ? `${spec.judges ?? DEFAULT_JUDGES} judges: ${spec.rubric.slice(0, 40)}` : "judge"),
  run: async (spec, ctx) => {
    if (spec.kind !== "judge") throw new Error("not a judge check");
    const providers = judgeProviders(spec, ctx.provider);
    if (providers.length === 0) return { status: "error", score: null, detail: "No provider is ready to judge.", evidence: { judges: [] } };
    const n = Math.max(1, Math.floor(spec.judges ?? DEFAULT_JUDGES));
    const chosen = Array.from({ length: n }, (_, i) => providers[i % providers.length]);
    // Hiring is a ledger write each. Sequential keeps the roster file safe.
    for (const p of new Set(chosen)) {
      try {
        ensureJudge(p, ctx.root);
      } catch {
        /* the vote reports the failure */
      }
    }
    const votes = await Promise.all(chosen.map((p, i) => vote(p, i, spec, ctx)));
    return tally(votes);
  },
});
