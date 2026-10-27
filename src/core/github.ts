/**
 * GitHub, through the `gh` CLI the developer is already signed in to.
 *
 * CEO holds no GitHub token. Every call is a `gh` subprocess run in the
 * repository, so the account, the host and the permissions are whatever
 * `gh auth status` says. Setup is `gh auth login`, once, and `ceo setup
 * github` runs it.
 *
 * Three things come from GitHub: whether `gh` is ready, open issues to give
 * agents as context or as tasks, and a pull request for an agent's branch
 * with the ledger's account of who did the work, on which provider, at
 * what cost.
 */

import { spawnSync } from "node:child_process";

import { append, readLedger } from "./ledger.js";
import { projectRoot } from "./paths.js";
import { findAgent } from "./roster.js";

export function ghBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.CEO_GH_BIN?.trim() || "gh";
}

function gh(args: string[], root: string, input?: string): { ok: boolean; out: string; err: string; missing: boolean } {
  const r = spawnSync(ghBinary(), args, { cwd: root, encoding: "utf8", input, timeout: 30000, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } });
  const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), missing };
}

export type GithubStatus = {
  installed: boolean;
  signedIn: boolean;
  account: string | null;
  /** owner/name of the repository here, or null outside one. */
  repo: string | null;
  /** What to do next, when something is missing. */
  fix: string | null;
};

const memo = new Map<string, { at: number; value: GithubStatus }>();

export function resetGithubStatus(): void {
  memo.clear();
}

export function githubStatus(cwd?: string): GithubStatus {
  const root = projectRoot(cwd);
  const hit = memo.get(root);
  if (hit && Date.now() - hit.at < 30000) return hit.value;
  let value: GithubStatus;
  const version = gh(["--version"], root);
  if (version.missing) {
    value = { installed: false, signedIn: false, account: null, repo: null, fix: "Install the GitHub CLI: brew install gh" };
  } else {
    const auth = gh(["auth", "status", "--hostname", "github.com"], root);
    const text = `${auth.out}\n${auth.err}`;
    const account = /account\s+(\S+)/.exec(text)?.[1] ?? /as\s+(\S+)/.exec(text)?.[1] ?? null;
    const signedIn = auth.ok;
    const repo = signedIn ? gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], root) : null;
    value = {
      installed: true,
      signedIn,
      account: signedIn ? account : null,
      repo: repo?.ok && repo.out ? repo.out : null,
      fix: signedIn ? (repo?.ok ? null : "This directory has no GitHub remote. Issues and pull requests need one.") : "Sign in: gh auth login, or ceo setup github",
    };
  }
  memo.set(root, { at: Date.now(), value });
  return value;
}

export type Issue = {
  number: number;
  title: string;
  labels: string[];
  assignees: string[];
  url: string;
  updatedAt: string;
};

export function listIssues(cwd?: string, opts: { limit?: number; label?: string } = {}): Issue[] {
  const root = projectRoot(cwd);
  const args = ["issue", "list", "--state", "open", "--limit", String(opts.limit ?? 30), "--json", "number,title,labels,assignees,url,updatedAt"];
  if (opts.label) args.push("--label", opts.label);
  const r = gh(args, root);
  if (!r.ok) throw new Error(r.missing ? "The GitHub CLI is not installed: brew install gh" : r.err || "gh issue list failed.");
  const rows = JSON.parse(r.out || "[]") as Array<Record<string, unknown>>;
  return rows.map((i) => ({
    number: Number(i.number),
    title: String(i.title ?? ""),
    labels: ((i.labels as Array<{ name: string }>) ?? []).map((l) => l.name),
    assignees: ((i.assignees as Array<{ login: string }>) ?? []).map((a) => a.login),
    url: String(i.url ?? ""),
    updatedAt: String(i.updatedAt ?? ""),
  }));
}

/** An issue or a pull request as text an agent can read: title, body, comments. */
export function readThread(kind: "issue" | "pr", n: number, cwd?: string): { title: string; text: string; url: string } {
  const root = projectRoot(cwd);
  const fields = kind === "issue" ? "number,title,body,comments,labels,url,state" : "number,title,body,comments,url,state,files,headRefName";
  const r = gh([kind, "view", String(n), "--json", fields], root);
  if (!r.ok) throw new Error(r.missing ? "The GitHub CLI is not installed: brew install gh" : r.err || `gh ${kind} view ${n} failed.`);
  const d = JSON.parse(r.out) as Record<string, unknown>;
  const label = kind === "issue" ? "Issue" : "Pull request";
  const lines = [`${label} #${d.number}: ${d.title}`, `State: ${String(d.state ?? "").toLowerCase()} · ${d.url}`];
  const labels = (d.labels as Array<{ name: string }> | undefined)?.map((l) => l.name) ?? [];
  if (labels.length > 0) lines.push(`Labels: ${labels.join(", ")}`);
  const files = (d.files as Array<{ path: string }> | undefined)?.map((f) => f.path) ?? [];
  if (files.length > 0) lines.push(`Files: ${files.join(", ")}`);
  lines.push("", String(d.body ?? "").trim() || "No description.");
  const comments = (d.comments as Array<{ author?: { login?: string }; body?: string }> | undefined) ?? [];
  for (const c of comments.slice(-10)) lines.push("", `Comment by ${c.author?.login ?? "someone"}:`, String(c.body ?? "").trim());
  if (kind === "pr") {
    const diff = gh(["pr", "diff", String(n)], root);
    if (diff.ok && diff.out) lines.push("", "Diff:", diff.out.slice(0, 20000));
  }
  return { title: `#${d.number} ${String(d.title ?? "")}`, text: lines.join("\n"), url: String(d.url ?? "") };
}

/** The pull request body: what the ledger says about the agent's work on this branch. */
export function provenanceBody(agent: string, cwd?: string): string {
  const entries = readLedger(cwd).filter((e) => e.agent === agent);
  const starts = new Map(entries.filter((e) => e.type === "delegate_start").map((e) => [String(e.data.id ?? ""), e]));
  const runs = entries.filter((e) => e.type === "delegate_end").map((e) => {
    const s = starts.get(String(e.data.id ?? ""));
    const cost = Number(e.data.costUsd ?? 0) || 0;
    return { task: String(s?.data.task ?? "").replace(/\s+/g, " ").slice(0, 100), provider: String(s?.data.provider ?? ""), model: String(s?.data.model ?? ""), cost, est: e.data.costIsEstimate === true };
  });
  const total = runs.reduce((n, r) => n + r.cost, 0);
  const a = findAgent(agent, cwd);
  const lines = [
    `Work by **${agent}**${a ? `, ${a.autonomy}, on ${a.provider} ${a.model}` : ""}, opened from [CEO](https://github.com/sumervaid/ceo).`,
    "",
    `${runs.length} run${runs.length === 1 ? "" : "s"}, $${total.toFixed(4)} in total. Every commit on the branch carries a trailer with the ledger entry and the cost.`,
    "",
    "| Task | Provider | Model | Cost |",
    "| --- | --- | --- | --- |",
    ...runs.slice(-20).map((r) => `| ${r.task.replace(/\|/g, "/")} | ${r.provider} | ${r.model} | $${r.cost.toFixed(4)}${r.est ? " est." : ""} |`),
  ];
  return lines.join("\n");
}

/**
 * Push the agent's branch and open a pull request into the base branch.
 * Returns the pull request's URL. A note of kind `pr` records it.
 */
export function openPullRequest(agent: string, cwd: string | undefined, opts: { base: string; title?: string }): string {
  const root = projectRoot(cwd);
  const a = findAgent(agent, cwd);
  if (!a) throw new Error(`No agent named "${agent}" in the org.`);
  if (!a.branch) throw new Error(`${agent} has no branch. i on the roster gives ${agent} a worktree and a branch.`);
  const push = spawnSync("git", ["push", "-u", "origin", a.branch], { cwd: root, encoding: "utf8", timeout: 60000 });
  if (push.status !== 0) throw new Error(`git push failed: ${(push.stderr || push.stdout || "").trim().split("\n").pop()}`);
  const title = opts.title ?? `${agent}: ${lastTask(agent, cwd) ?? "work from CEO"}`;
  const r = gh(["pr", "create", "--head", a.branch, "--base", opts.base, "--title", title.slice(0, 120), "--body-file", "-"], root, provenanceBody(agent, cwd));
  if (!r.ok) {
    const existing = /https:\/\/\S+\/pull\/\d+/.exec(`${r.out}\n${r.err}`)?.[0];
    if (existing) return existing;
    throw new Error(r.err || "gh pr create failed.");
  }
  const url = /https:\/\/\S+/.exec(r.out)?.[0] ?? r.out;
  append("note", agent, { kind: "pr", branch: a.branch, base: opts.base, url }, cwd);
  return url;
}

function lastTask(agent: string, cwd?: string): string | null {
  const starts = readLedger(cwd).filter((e) => e.type === "delegate_start" && e.agent === agent);
  const t = starts[starts.length - 1]?.data.task;
  return typeof t === "string" ? t.replace(/\s+/g, " ").slice(0, 80) : null;
}
