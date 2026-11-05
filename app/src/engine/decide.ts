/** What a workspace most needs next. One recommendation, so the primary button is never a guess. */
import type { CheckRun, GitSummary, NextAction, PullRequest, ReviewNote } from "../shared/api";

export function decideNext(input: {
  running: boolean;
  hasRemote: boolean;
  ghReady: boolean;
  git: GitSummary;
  pr: PullRequest | null;
  runs: CheckRun[];
  reviews: ReviewNote[];
  merged: boolean;
}): { next: NextAction; label: string; detail: string } {
  const { git, pr, runs, reviews } = input;
  if (input.merged || pr?.state === "MERGED") return { next: "archive", label: "Archive", detail: "This work is merged." };
  if (input.running) return { next: "wait", label: "Working", detail: "An agent is running." };
  if (git.conflicts.length > 0) {
    return { next: "resolve-conflicts", label: "Resolve conflicts", detail: `${git.conflicts.length} file${git.conflicts.length === 1 ? "" : "s"} conflict with the base branch.` };
  }
  if (git.files === 0 && git.ahead === 0) return { next: "start", label: "Start", detail: "No changes yet." };
  if (pr && pr.state === "OPEN") {
    const failing = runs.filter((r) => r.state === "fail");
    if (failing.length > 0) return { next: "fix-checks", label: "Fix checks", detail: `${failing.length} check${failing.length === 1 ? "" : "s"} failing.` };
    if (reviews.length > 0 && pr.reviewDecision !== "APPROVED") return { next: "respond", label: "Respond to review", detail: `${reviews.length} review comment${reviews.length === 1 ? "" : "s"}.` };
    if (runs.some((r) => r.state === "running")) return { next: "wait", label: "Checks running", detail: "CI has not finished." };
    if (git.dirty) return { next: "update", label: "Push changes", detail: "Local changes are not on the pull request." };
    return { next: "merge", label: "Merge", detail: pr.reviewDecision === "APPROVED" ? "Approved. Checks are green." : "Checks are green." };
  }
  if (input.hasRemote && input.ghReady) return { next: "create-pr", label: "Create PR", detail: `${git.files} file${git.files === 1 ? "" : "s"} changed.` };
  return { next: "merge-local", label: "Merge", detail: "Merge into the base branch on this machine." };
}
