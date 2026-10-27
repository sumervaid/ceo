/**
 * Git provisioning for isolated agents.
 *
 * An agent hired with `--isolated` gets its own git worktree at
 * `.ceo/worktrees/<name>` on branch `ceo/<name>`. Everything that
 * agent writes lands there instead of the main tree, so three agents can
 * edit the same file in parallel without clobbering each other. When the
 * work is good, `merge()` brings the branch back to the base.
 *
 * Every commit an agent makes carries provenance trailers:
 *
 *   CEO-Agent: researcher
 *   CEO-Ledger-Seq: 42
 *   CEO-Cost-Usd: 0.0812
 *
 * so `git log` alone answers "which agent wrote this line, under which
 * delegation, at what cost" without needing the ledger. The ledger is
 * still the authority. The trailers are a convenience for code review.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import * as path from "node:path";
import { append } from "./ledger.js";
import { projectRoot, worktreesDir } from "./paths.js";

export type GitResult = { ok: true; stdout: string } | { ok: false; error: string };

function git(args: string[], cwd: string): GitResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const stderr =
      typeof err.stderr === "string"
        ? err.stderr
        : err.stderr?.toString() ?? err.message ?? String(e);
    return { ok: false, error: stderr.trim() };
  }
}

export function isGitRepo(cwd?: string): boolean {
  const root = projectRoot(cwd);
  return git(["rev-parse", "--git-dir"], root).ok;
}

/** True when the repository has a first commit. A worktree needs one to branch from. */
export function hasCommits(cwd?: string): boolean {
  return git(["rev-parse", "--verify", "--quiet", "HEAD"], projectRoot(cwd)).ok;
}

/** Branch name the base repo is currently on. */
export function currentBranch(cwd?: string): string | null {
  const r = git(["rev-parse", "--abbrev-ref", "HEAD"], projectRoot(cwd));
  return r.ok ? r.stdout : null;
}

export function branchNameFor(agent: string): string {
  return `ceo/${agent}`;
}

export function worktreePathFor(agent: string, cwd?: string): string {
  return path.join(worktreesDir(cwd), agent);
}

/**
 * Create a worktree + branch for an agent. Idempotent: if the worktree
 * already exists and is healthy, returns it rather than failing.
 */
export function provisionWorktree(
  agent: string,
  cwd?: string,
): { branch: string; worktreePath: string } {
  const root = projectRoot(cwd);
  if (!isGitRepo(root)) {
    throw new Error(
      "Isolated agents need a git repository. Run `git init` first, or hire without --isolated.",
    );
  }

  const branch = branchNameFor(agent);
  const wt = worktreePathFor(agent, cwd);

  if (existsSync(wt)) {
    const check = git(["rev-parse", "--git-dir"], wt);
    if (check.ok) return { branch, worktreePath: wt };
    // Stale directory that is not a worktree: clear it and re-provision.
    rmSync(wt, { recursive: true, force: true });
  }

  // Clear registrations whose directories no longer exist. This happens
  // whenever someone deletes .ceo/ to reset, or clones a repo where
  // .ceo/worktrees/ was gitignored. git still lists the worktree in
  // .git/worktrees/ and refuses to re-add the same path without a prune.
  git(["worktree", "prune"], root);

  mkdirSync(worktreesDir(cwd), { recursive: true });

  // Reuse the branch when it already exists, otherwise create it off HEAD.
  const branchExists = git(
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    root,
  ).ok;

  const addArgs = branchExists
    ? ["worktree", "add", wt, branch]
    : ["worktree", "add", "-b", branch, wt];

  const r = git(addArgs, root);
  if (!r.ok) {
    throw new Error(`Could not create worktree for "${agent}": ${r.error}`);
  }

  append("worktree_provision", agent, { branch, worktreePath: wt }, cwd);
  return { branch, worktreePath: wt };
}

/** Remove an agent's worktree and optionally delete its branch. */
export function teardownWorktree(
  agent: string,
  opts: { deleteBranch?: boolean } = {},
  cwd?: string,
): void {
  const root = projectRoot(cwd);
  const wt = worktreePathFor(agent, cwd);
  if (existsSync(wt)) {
    const r = git(["worktree", "remove", "--force", wt], root);
    if (!r.ok) rmSync(wt, { recursive: true, force: true });
  }
  git(["worktree", "prune"], root);
  if (opts.deleteBranch) {
    git(["branch", "-D", branchNameFor(agent)], root);
  }
}

/** Files changed in an agent's worktree, staged or not. */
export function worktreeStatus(agent: string, cwd?: string): string[] {
  const wt = worktreePathFor(agent, cwd);
  if (!existsSync(wt)) return [];
  const r = git(["status", "--porcelain"], wt);
  if (!r.ok || !r.stdout) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

/**
 * Commit everything in an agent's worktree with provenance trailers.
 * Returns null when there was nothing to commit.
 */
export function commitAgentWork(
  agent: string,
  message: string,
  provenance: { ledgerSeq: number; costUsd: number },
  cwd?: string,
): { sha: string; files: string[] } | null {
  const wt = worktreePathFor(agent, cwd);
  if (!existsSync(wt)) {
    throw new Error(`Agent "${agent}" has no worktree. Provision one first.`);
  }

  const files = worktreeStatus(agent, cwd);
  if (files.length === 0) return null;

  const addRes = git(["add", "-A"], wt);
  if (!addRes.ok) throw new Error(`git add failed in ${wt}: ${addRes.error}`);

  const body = [
    message.trim(),
    "",
    `CEO-Agent: ${agent}`,
    `CEO-Ledger-Seq: ${provenance.ledgerSeq}`,
    `CEO-Cost-Usd: ${provenance.costUsd.toFixed(6)}`,
  ].join("\n");

  const commitRes = git(["commit", "-m", body], wt);
  if (!commitRes.ok) throw new Error(`git commit failed: ${commitRes.error}`);

  const shaRes = git(["rev-parse", "HEAD"], wt);
  const sha = shaRes.ok ? shaRes.stdout : "unknown";

  append("worktree_commit", agent, {
    sha,
    files,
    message: message.trim(),
    ledgerSeq: provenance.ledgerSeq,
    costUsd: provenance.costUsd,
  }, cwd);

  return { sha, files };
}

/**
 * Merge an agent's branch into the current base branch. Returns a
 * structured conflict report rather than throwing, so the caller can show
 * the user which files need attention.
 */
export function mergeAgentBranch(
  agent: string,
  opts: { noFastForward?: boolean } = {},
  cwd?: string,
): { ok: true; sha: string } | { ok: false; conflicts: string[]; error: string } {
  const root = projectRoot(cwd);
  const branch = branchNameFor(agent);

  // Precondition, not a merge outcome. An agent that was never isolated has
  // no branch, so there is nothing to merge and nothing worth recording.
  // Throwing here keeps `worktree_merge` entries meaningful. Every one in
  // the ledger describes a merge that was actually attempted against a real
  // branch. That is what makes the audit trail trustworthy.
  if (!git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root).ok) {
    throw new Error(
      `Agent "${agent}" has no branch to merge. Only agents hired with isolation get one. Check /roster, or hire with --isolated.`,
    );
  }

  const args = ["merge"];
  if (opts.noFastForward !== false) args.push("--no-ff");
  args.push("-m", `ceo: merge work from agent "${agent}"`, branch);

  const r = git(args, root);
  if (r.ok) {
    const shaRes = git(["rev-parse", "HEAD"], root);
    const sha = shaRes.ok ? shaRes.stdout : "unknown";
    append("worktree_merge", agent, { branch, sha, ok: true }, cwd);
    return { ok: true, sha };
  }

  const conflictRes = git(["diff", "--name-only", "--diff-filter=U"], root);
  const conflicts = conflictRes.ok && conflictRes.stdout
    ? conflictRes.stdout.split("\n").filter(Boolean)
    : [];

  append("worktree_merge", agent, {
    branch,
    ok: false,
    conflicts,
    error: r.error,
  }, cwd);

  return { ok: false, conflicts, error: r.error };
}

/** Commits on an agent's branch that are not yet on the base branch. */
export function unmergedCommits(agent: string, cwd?: string): string[] {
  const root = projectRoot(cwd);
  const branch = branchNameFor(agent);
  const base = currentBranch(root) ?? "HEAD";
  const r = git(["log", "--oneline", `${base}..${branch}`], root);
  if (!r.ok || !r.stdout) return [];
  return r.stdout.split("\n").filter(Boolean);
}

/**
 * Suggested .gitignore lines. Worktrees and archived outputs are local
 * artifacts. Roster and ledger are the shareable record and should be
 * committed so a team sees the same org and the same accounting.
 */
export const GITIGNORE_SUGGESTION = [
  "# CEO: local artifacts, not shared",
  ".ceo/worktrees/",
  ".ceo/outputs/",
  ".ceo/runs/",
  ".ceo/chief/",
  "",
  "# CEO: roster.json and ledger.jsonl are intentionally committed.",
  "# They are the shared record of who is in the org and what was spent.",
].join("\n");
