/**
 * Gates: which actions land, decided on evidence.
 *
 * An action is a class, from `autonomy.ts`: merge, push, pr, publish, send,
 * pay. A gate reads the action and the evidence behind the action. The seat
 * of the agent that did the work plays no part. The agent's autonomy level
 * still bounds what the process can do. Gates decide what lands.
 *
 *   merge     lands automatically when the evidence clears the rule and
 *             the org setting allows auto-merge. Otherwise an approval request.
 *   others    push, pr, publish, send and pay always become requests.
 *             The evidence is shown in the request and never skips one.
 *
 * The merge rule has three parts. The promoted attempt passed. At least one
 * deterministic check passed on the attempt, a command or an Everval grade.
 * Every judge check on the attempt passed. The org setting is off by default.
 *
 *   note kind "gates"      the org setting, {autoMerge}. The latest wins.
 *   note kind "auto_merge" an automatic merge, with the evidence behind the merge.
 *   approval_request       id, action, taskId, attemptId, branch, summary, evidence
 *   approval_decide        id, decision, by, result
 *
 * Approving a merge runs the merge. CEO has no executor for the outward
 * classes yet. Approving one records the decision and nothing more.
 *
 * Importing this module registers the promote hook and the judge verifier.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { attemptName, promoteHooks, type Promotion } from "./attempts.js";
import { ACTIONS, type ActionClass } from "./autonomy.js";
import { mergeAgentBranch } from "./git.js";
import "./judge.js";
import { append, readLedger } from "./ledger.js";
import { projectRoot } from "./paths.js";
import { findTask } from "./tasks.js";
import type { LedgerEntry } from "./types.js";

export const YOU = "you";

export type CheckEvidence = { name: string; kind: string; status: string };

export type JudgeEvidence = {
  provider: string;
  model: string;
  verdict: string | null;
  reason: string;
  delegationId: string | null;
  costUsd: number;
};

export type Evidence = {
  verdict: { pass: boolean; score: number } | null;
  checks: CheckEvidence[];
  judges: JudgeEvidence[];
};

export type GateSettings = { autoMerge: boolean };

export type GateDecision = { allow: boolean; reason: string };

export type Approval = {
  id: string;
  action: ActionClass;
  taskId: string | null;
  attemptId: string | null;
  agent: string | null;
  branch: string | null;
  summary: string;
  evidence: Evidence;
  ts: number;
};

// -- settings ---------------------------------------------------------------

/** The org's gate settings. Auto-merge stays off until a person sets auto-merge on. */
export function gateSettings(cwd?: string): GateSettings {
  const last = readLedger(cwd)
    .filter((e) => e.type === "note" && e.data.kind === "gates")
    .pop();
  return { autoMerge: last?.data.autoMerge === true };
}

export function setAutoMerge(on: boolean, cwd?: string): GateSettings {
  append("note", null, { kind: "gates", autoMerge: on, by: YOU }, cwd);
  return { autoMerge: on };
}

// -- evidence ---------------------------------------------------------------

/** What the ledger holds about one attempt: each check's status and each judge's vote. */
export function evidenceFor(taskId: string | null, attemptId: string | null, cwd?: string, verdict: Evidence["verdict"] = null): Evidence {
  const checks: CheckEvidence[] = [];
  const judges: JudgeEvidence[] = [];
  if (taskId && attemptId) {
    // Later events for the same check replace earlier ones.
    const latest = new Map<string, LedgerEntry>();
    const verifies = readLedger(cwd).filter((e) => e.type === "verify" && e.data.taskId === taskId && e.data.attemptId === attemptId);
    for (const e of verifies) {
      const v = e.data.verifier as { kind?: string; name?: string } | undefined;
      latest.set(`${v?.kind}:${v?.name}`, e);
    }
    for (const e of latest.values()) {
      const v = e.data.verifier as { kind?: string; name?: string } | undefined;
      checks.push({ name: String(v?.name ?? v?.kind ?? "check"), kind: String(v?.kind ?? "command"), status: String(e.data.status) });
      if (v?.kind === "judge") {
        const votes = (e.data.evidence as { judges?: JudgeEvidence[] } | undefined)?.judges ?? [];
        for (const j of votes) {
          judges.push({
            provider: String(j.provider),
            model: String(j.model),
            verdict: j.verdict ?? null,
            reason: String(j.reason ?? ""),
            delegationId: j.delegationId ?? null,
            costUsd: Number(j.costUsd ?? 0),
          });
        }
      }
    }
  }
  return { verdict, checks, judges };
}

/** A few lines a person can read: the verdict, each check, each judge. */
export function evidenceLines(ev: Evidence): string[] {
  const lines: string[] = [];
  lines.push(ev.verdict ? `verdict ${ev.verdict.pass ? "pass" : "fail"}, score ${ev.verdict.score.toFixed(2)}` : "no verdict on record");
  if (ev.checks.length === 0) lines.push("no checks ran");
  for (const c of ev.checks) lines.push(`${c.kind} ${c.name}: ${c.status}`);
  for (const j of ev.judges) lines.push(`judge ${j.provider} ${j.verdict ?? "no verdict"}${j.reason ? `: ${j.reason}` : ""}`);
  return lines;
}

// -- the rules --------------------------------------------------------------

/** Decide one action on the evidence for the action. */
export function gate(action: ActionClass, evidence: Evidence, settings: GateSettings): GateDecision {
  if (ACTIONS[action].gate === "always") return { allow: false, reason: `${action} is outward facing and always needs approval.` };
  if (!settings.autoMerge) return { allow: false, reason: "Auto-merge is off." };
  if (!evidence.verdict?.pass) return { allow: false, reason: "The attempt did not pass." };
  const deterministic = evidence.checks.filter((c) => (c.kind === "command" || c.kind === "everval") && c.status === "pass");
  if (deterministic.length === 0) return { allow: false, reason: "No deterministic check passed." };
  const judged = evidence.checks.filter((c) => c.kind === "judge");
  if (judged.some((c) => c.status !== "pass")) return { allow: false, reason: "A judge check did not pass." };
  return { allow: true, reason: `${deterministic.length} deterministic check${deterministic.length === 1 ? "" : "s"} passed${judged.length > 0 ? " and every judge agreed" : ""}.` };
}

// -- requests and decisions -------------------------------------------------

function toApproval(e: LedgerEntry): Approval {
  const d = e.data;
  return {
    id: String(d.id),
    action: d.action as ActionClass,
    taskId: typeof d.taskId === "string" ? d.taskId : null,
    attemptId: typeof d.attemptId === "string" ? d.attemptId : null,
    agent: e.agent,
    branch: typeof d.branch === "string" ? d.branch : null,
    summary: String(d.summary ?? ""),
    evidence: (d.evidence as Evidence) ?? { verdict: null, checks: [], judges: [] },
    ts: e.ts,
  };
}

/** Requests with no decision yet, oldest first. */
export function pendingApprovals(cwd?: string): Approval[] {
  const entries = readLedger(cwd);
  const decided = new Set(entries.filter((e) => e.type === "approval_decide").map((e) => String(e.data.id)));
  return entries.filter((e) => e.type === "approval_request" && !decided.has(String(e.data.id))).map(toApproval);
}

export type ActionInput = {
  taskId?: string | null;
  attemptId?: string | null;
  agent?: string | null;
  branch?: string | null;
  summary: string;
  evidence: Evidence;
};

export function requestApproval(action: ActionClass, input: ActionInput, cwd?: string): Approval {
  const id = `ap-${randomBytes(3).toString("hex")}`;
  const entry = append(
    "approval_request",
    input.agent ?? null,
    { id, action, taskId: input.taskId ?? null, attemptId: input.attemptId ?? null, branch: input.branch ?? null, summary: input.summary, evidence: input.evidence },
    cwd,
  );
  return toApproval(entry);
}

/** Leave the work tree clean after a merge that conflicted. */
function abortMerge(cwd?: string): void {
  try {
    execFileSync("git", ["merge", "--abort"], { cwd: projectRoot(cwd), stdio: "ignore" });
  } catch {
    /* no merge was in progress */
  }
}

export type ActionOutcome =
  | { status: "executed"; sha: string; reason: string }
  | { status: "requested"; approval: Approval; reason: string };

/**
 * Put an action through the gate. A merge that clears the rule lands now.
 * Everything else becomes an approval request. A merge that conflicts is
 * aborted. The request then carries the failure in the summary.
 */
export function proposeAction(action: ActionClass, input: ActionInput, cwd?: string): ActionOutcome {
  const decision = gate(action, input.evidence, gateSettings(cwd));
  if (decision.allow && action === "merge" && input.agent && input.attemptId) {
    try {
      const r = mergeAgentBranch(attemptName(input.agent, input.attemptId), {}, cwd);
      if (r.ok) {
        append("note", input.agent, { kind: "auto_merge", taskId: input.taskId ?? null, attemptId: input.attemptId, branch: input.branch ?? null, sha: r.sha, reason: decision.reason, evidence: input.evidence }, cwd);
        return { status: "executed", sha: r.sha, reason: decision.reason };
      }
      abortMerge(cwd);
      const reason = r.conflicts.length > 0 ? `Auto-merge conflicted in ${r.conflicts.join(", ")}.` : `Auto-merge failed: ${r.error.slice(0, 120)}`;
      return { status: "requested", approval: requestApproval(action, { ...input, summary: `${input.summary} ${reason}` }, cwd), reason };
    } catch (e) {
      const reason = `Auto-merge failed: ${e instanceof Error ? e.message : String(e)}`;
      return { status: "requested", approval: requestApproval(action, { ...input, summary: `${input.summary} ${reason}` }, cwd), reason };
    }
  }
  return { status: "requested", approval: requestApproval(action, input, cwd), reason: decision.reason };
}

export type DecideResult = { ok: boolean; message: string; sha?: string; conflicts?: string[] };

/**
 * Record the person's decision. Approving a merge runs the merge. The result
 * goes on the decision. Approving any other class records the decision only.
 */
export function decideApproval(id: string, approved: boolean, cwd?: string): DecideResult {
  const req = pendingApprovals(cwd).find((a) => a.id === id);
  if (!req) return { ok: false, message: `No pending approval with id ${id}.` };

  if (!approved) {
    append("approval_decide", req.agent, { id, decision: "denied", by: YOU }, cwd);
    return { ok: true, message: `Denied ${req.action} ${id}.` };
  }

  if (req.action !== "merge") {
    const note = `CEO has no executor for ${req.action} yet. The decision is recorded and nothing was sent.`;
    append("approval_decide", req.agent, { id, decision: "approved", by: YOU, result: { executed: false, note } }, cwd);
    return { ok: true, message: `Approved ${req.action} ${id}. ${note}` };
  }

  if (!req.agent || !req.attemptId) {
    const error = "The request names no agent and attempt to merge.";
    append("approval_decide", req.agent, { id, decision: "approved", by: YOU, result: { executed: false, ok: false, error } }, cwd);
    return { ok: false, message: error };
  }
  try {
    const r = mergeAgentBranch(attemptName(req.agent, req.attemptId), {}, cwd);
    if (r.ok) {
      append("approval_decide", req.agent, { id, decision: "approved", by: YOU, result: { executed: true, ok: true, sha: r.sha } }, cwd);
      return { ok: true, message: `Approved and merged ${req.branch ?? "the branch"} (${r.sha.slice(0, 7)}).`, sha: r.sha };
    }
    append("approval_decide", req.agent, { id, decision: "approved", by: YOU, result: { executed: true, ok: false, conflicts: r.conflicts, error: r.error.slice(0, 300) } }, cwd);
    const message = r.conflicts.length > 0 ? `Approved. The merge conflicts in ${r.conflicts.join(", ")}. Resolve by hand.` : `Approved. The merge failed: ${r.error.slice(0, 120)}`;
    return { ok: false, message, conflicts: r.conflicts };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    append("approval_decide", req.agent, { id, decision: "approved", by: YOU, result: { executed: true, ok: false, error } }, cwd);
    return { ok: false, message: `Approved. The merge failed: ${error}` };
  }
}

// -- the promote hook -------------------------------------------------------

/** Every promotion goes through the merge gate. */
export async function mergeGate(p: Promotion, cwd: string): Promise<void> {
  const a = p.attempt;
  // Without a branch the work is in the shared tree. There is nothing to merge.
  if (!a.branch) return;
  if (pendingApprovals(cwd).some((r) => r.attemptId === a.id)) return;
  const evidence = evidenceFor(p.taskId, a.id, cwd, { pass: p.verdict.pass, score: p.verdict.score });
  const title = findTask(p.taskId, cwd)?.title ?? p.taskId;
  proposeAction("merge", { taskId: p.taskId, attemptId: a.id, agent: a.agent, branch: a.branch, summary: `Merge ${a.branch} for ${title}.`, evidence }, cwd);
}

if (!promoteHooks.includes(mergeGate)) promoteHooks.push(mergeGate);
