/** Git for the window: asynchronous, so a large repo never stalls a click. */
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync } from "node:fs";
import * as path from "node:path";

import type { Commit, DiffFile, DiffHunk, DiffLine, DiffResult, GitSummary, FileEntry, SearchHit } from "../shared/api";

export type Out = { ok: boolean; stdout: string; stderr: string; code: number };

export function run(cmd: string, args: string[], cwd: string, opts: { timeout?: number; input?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}): Promise<Out> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd, timeout: opts.timeout ?? 30000, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, env: opts.env ?? process.env, encoding: "utf8" },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
        resolve({ ok: !err, stdout: stdout ?? "", stderr: (stderr || (err && !stdout ? err.message : "")) ?? "", code });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Optional locks stay off, so a background read never holds index.lock against an agent's commit. */
export const git = (args: string[], cwd: string, opts: Parameters<typeof run>[3] = {}): Promise<Out> =>
  run("git", ["-c", "core.quotepath=off", ...args], cwd, { ...opts, env: { ...(opts.env ?? process.env), GIT_OPTIONAL_LOCKS: "0" } });

const EMPTY: GitSummary = { added: 0, removed: 0, files: 0, ahead: 0, behind: 0, dirty: false, conflicts: [] };

export async function isRepo(dir: string): Promise<boolean> {
  return (await git(["rev-parse", "--is-inside-work-tree"], dir)).ok;
}

export async function hasHead(dir: string): Promise<boolean> {
  return (await git(["rev-parse", "--verify", "--quiet", "HEAD"], dir)).ok;
}

export async function hasOrigin(dir: string): Promise<boolean> {
  return (await git(["remote", "get-url", "origin"], dir)).ok;
}

/** The ref new work starts from: the remote's default branch when there is one. */
export async function defaultBase(dir: string, chosen = ""): Promise<string> {
  const remote = await hasOrigin(dir);
  if (chosen) {
    if (remote && (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${chosen}`], dir)).ok) return `origin/${chosen}`;
    return chosen;
  }
  if (remote) {
    const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir);
    if (head.ok && head.stdout.trim()) return head.stdout.trim();
    for (const b of ["main", "master"]) {
      if ((await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`], dir)).ok) return `origin/${b}`;
    }
  }
  for (const b of ["main", "master"]) {
    if ((await git(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], dir)).ok) return b;
  }
  const cur = await git(["branch", "--show-current"], dir);
  return cur.stdout.trim() || "HEAD";
}

/** Paths CEO writes into a worktree that never belong in a commit. Local to the clone, no tracked file changes. */
export function excludeLocal(root: string, lines: string[]): void {
  try {
    // A linked worktree or a submodule has a .git file, not a folder. Git knows where its exclude file lives.
    const raw = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const file = path.resolve(root, raw);
    mkdirSync(path.dirname(file), { recursive: true });
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    const missing = lines.filter((l) => !current.split("\n").includes(l));
    if (missing.length) appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  } catch {
    /* an unignored note file is a nuisance, not a failure */
  }
}

async function untracked(worktree: string): Promise<string[]> {
  const r = await git(["ls-files", "--others", "--exclude-standard", "-z"], worktree);
  return r.ok ? r.stdout.split("\0").filter(Boolean) : [];
}

function countLines(file: string): number {
  try {
    if (statSync(file).size > 4 * 1024 * 1024) return 0;
    const buf = readFileSync(file);
    if (buf.includes(0)) return 0;
    const s = buf.toString("utf8");
    if (!s) return 0;
    return s.split("\n").length - (s.endsWith("\n") ? 1 : 0);
  } catch {
    return 0;
  }
}

export async function summary(worktree: string, base: string): Promise<GitSummary> {
  if (!existsSync(worktree)) return EMPTY;
  const num = await git(["diff", "--merge-base", base, "--numstat", "-z", "-M"], worktree);
  if (!num.ok) {
    const fallback = await git(["diff", base, "--numstat", "-z", "-M"], worktree);
    if (!fallback.ok) return EMPTY;
    num.stdout = fallback.stdout;
  }
  let added = 0;
  let removed = 0;
  let files = 0;
  const parts = num.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i]!);
    if (!m) continue;
    files += 1;
    if (m[1] !== "-") added += Number(m[1]);
    if (m[2] !== "-") removed += Number(m[2]);
    if (m[3] === "") i += 2; // A rename carries two more fields.
  }
  const fresh = await untracked(worktree);
  files += fresh.length;
  for (const f of fresh) added += countLines(path.join(worktree, f));

  const counts = await git(["rev-list", "--left-right", "--count", `${base}...HEAD`], worktree);
  const [behind, ahead] = counts.ok ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
  const status = await git(["status", "--porcelain"], worktree);
  const merging = await unmerged(worktree);
  const conflicts = [...new Set([...merging, ...(await conflictsWith(worktree, base))])];
  return { added, removed, files, ahead: ahead ?? 0, behind: behind ?? 0, dirty: status.ok && status.stdout.trim().length > 0, conflicts };
}

/** Files with unresolved conflicts right now, from a merge in progress. */
export async function unmerged(worktree: string): Promise<string[]> {
  const r = await git(["diff", "--name-only", "--diff-filter=U"], worktree);
  return r.ok ? r.stdout.split("\n").filter(Boolean) : [];
}

/** Commits on this branch that its remote branch does not have. A branch never pushed counts all of its own. */
export async function unpushed(worktree: string, remoteBranch: string, base: string): Promise<number> {
  const known = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${remoteBranch}`], worktree);
  const range = known.ok ? `origin/${remoteBranch}..HEAD` : `${base}..HEAD`;
  const r = await git(["rev-list", "--count", range], worktree);
  return r.ok ? Number(r.stdout.trim()) || 0 : 0;
}

/** Files that would conflict if the branch merged with the base now. Nothing on disk changes. */
export async function conflictsWith(worktree: string, base: string): Promise<string[]> {
  const r = await git(["merge-tree", "--write-tree", "--name-only", "--no-messages", base, "HEAD"], worktree);
  if (r.ok) return [];
  if (r.code !== 1) return [];
  return r.stdout.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
}

const MAX_FILE_LINES = 4000;
const MAX_FILES = 400;

export function parsePatch(text: string): DiffFile[] {
  const out: DiffFile[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (!lines[i]!.startsWith("diff --git ")) {
      i += 1;
      continue;
    }
    const start = i;
    i += 1;
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let status: DiffFile["status"] = "modified";
    let binary = false;
    while (i < lines.length && !lines[i]!.startsWith("@@") && !lines[i]!.startsWith("diff --git ")) {
      const l = lines[i]!;
      if (l.startsWith("new file")) status = "added";
      else if (l.startsWith("deleted file")) status = "deleted";
      else if (l.startsWith("rename from ")) renameFrom = unquote(l.slice(12));
      else if (l.startsWith("rename to ")) renameTo = unquote(l.slice(10));
      else if (l.startsWith("--- ")) oldPath = l === "--- /dev/null" ? null : stripPrefix(l.slice(4));
      else if (l.startsWith("+++ ")) newPath = l === "+++ /dev/null" ? null : stripPrefix(l.slice(4));
      else if (l.startsWith("Binary files ") || l.startsWith("GIT binary patch")) binary = true;
      i += 1;
    }
    if (renameFrom) status = "renamed";
    if (!newPath && !oldPath) {
      const m = /^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/.exec(lines[start]!);
      newPath = renameTo ?? (m?.[2] ? unquote(m[2]) : "");
      oldPath = renameFrom ?? (m?.[1] ? unquote(m[1]) : null);
    }
    const hunks: DiffHunk[] = [];
    let added = 0;
    let removed = 0;
    let total = 0;
    while (i < lines.length && !lines[i]!.startsWith("diff --git ")) {
      const header = lines[i]!;
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
      if (!m) {
        i += 1;
        continue;
      }
      let o = Number(m[1]);
      let n = Number(m[2]);
      i += 1;
      const body: DiffLine[] = [];
      while (i < lines.length && !lines[i]!.startsWith("@@") && !lines[i]!.startsWith("diff --git ")) {
        const l = lines[i]!;
        if (l.startsWith("+")) {
          body.push({ t: "add", o: null, n: n++, s: l.slice(1) });
          added += 1;
        } else if (l.startsWith("-")) {
          body.push({ t: "del", o: o++, n: null, s: l.slice(1) });
          removed += 1;
        } else if (l.startsWith(" ")) {
          body.push({ t: "ctx", o: o++, n: n++, s: l.slice(1) });
        }
        i += 1;
      }
      total += body.length;
      hunks.push({ header, lines: body });
    }
    const raw = lines.slice(start, i).join("\n");
    const tooLarge = total > MAX_FILE_LINES;
    out.push({
      path: newPath ?? oldPath ?? "",
      oldPath: status === "renamed" ? renameFrom : null,
      status,
      added,
      removed,
      binary,
      tooLarge,
      hash: createHash("sha1").update(raw).digest("hex").slice(0, 16),
      hunks: tooLarge ? [] : hunks,
    });
  }
  return out;
}

function stripPrefix(p: string): string {
  const clean = unquote(p.replace(/\t.*$/, ""));
  return clean.startsWith("a/") || clean.startsWith("b/") ? clean.slice(2) : clean;
}

/** Git puts unusual names in double quotes with C escapes. */
export function unquote(p: string): string {
  if (!(p.startsWith('"') && p.endsWith('"'))) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      bytes.push(...Buffer.from(body[i]!, "utf8"));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else {
      bytes.push(simple[body[i + 1]!] ?? body.charCodeAt(i + 1));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

export async function commits(worktree: string, base: string): Promise<Commit[]> {
  const r = await git(["log", `${base}..HEAD`, "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct", "-n", "200"], worktree);
  if (!r.ok) return [];
  return r.stdout.split("\n").filter(Boolean).map((l) => {
    const [sha, short, subject, author, ts] = l.split("\x1f");
    return { sha: sha!, short: short!, subject: subject!, author: author!, ts: Number(ts) * 1000 };
  });
}

export async function diff(worktree: string, base: string, commit?: string | null): Promise<DiffResult> {
  const log = await commits(worktree, base);
  // Fixed prefixes, whatever diff.noprefix or diff.mnemonicPrefix say in this person's config.
  const flags = ["--no-color", "--no-ext-diff", "-M", "-U3", "--src-prefix=a/", "--dst-prefix=b/"];
  if (commit) {
    if (!log.some((c) => c.sha === commit)) throw new Error("That commit is not on this workspace's branch.");
    const r = await git(["show", ...flags, "--format=", commit], worktree);
    if (!r.ok) throw new Error(`git show failed: ${r.stderr.trim().split("\n").pop() ?? ""}`);
    return { files: parsePatch(r.stdout), commits: log, truncated: false };
  }
  let r = await git(["diff", ...flags, "--merge-base", base], worktree);
  if (!r.ok) r = await git(["diff", ...flags, base], worktree);
  // An empty list reads as no changes, and someone could delete real work on the strength of that.
  if (!r.ok) throw new Error(`Could not read the changes: ${r.stderr.trim().split("\n").pop() ?? "git diff failed"}`);
  const files = parsePatch(r.stdout);
  for (const f of await untracked(worktree)) {
    const full = await git(["diff", "--no-color", "--no-index", "--src-prefix=a/", "--dst-prefix=b/", "--", "/dev/null", f], worktree);
    const parsed = parsePatch(full.stdout)[0];
    if (parsed) files.push({ ...parsed, path: f, status: "added" });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files: files.slice(0, MAX_FILES), commits: log, truncated: files.length > MAX_FILES };
}

export async function listFiles(worktree: string, base: string): Promise<FileEntry[]> {
  const tracked = await git(["ls-files", "-z"], worktree);
  const extra = await untracked(worktree);
  const changed = new Set<string>(extra);
  const d = await git(["diff", "--merge-base", base, "--name-only", "-z"], worktree);
  if (d.ok) for (const f of d.stdout.split("\0")) if (f) changed.add(f);
  const all = new Set<string>([...tracked.stdout.split("\0").filter(Boolean), ...extra]);
  return [...all].sort().slice(0, 50000).map((p) => ({ path: p, changed: changed.has(p) }));
}

export async function grep(worktree: string, query: string): Promise<SearchHit[]> {
  if (!query.trim()) return [];
  const r = await git(["grep", "-n", "-I", "-i", "--untracked", "--full-name", "-F", "-e", query, "--", "."], worktree, { timeout: 15000 });
  return r.stdout.split("\n").filter(Boolean).slice(0, 300).map((l) => {
    const m = /^(.*?):(\d+):(.*)$/.exec(l);
    return m ? { path: m[1]!, line: Number(m[2]), text: m[3]!.slice(0, 240) } : { path: l, line: 0, text: "" };
  });
}

/** A path from the window, held inside the worktree. Symlinks that leave the worktree are refused too. */
export function safePath(worktree: string, rel: string, real: (p: string) => string): string {
  const full = path.resolve(worktree, rel);
  const root = path.resolve(worktree);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("That path is outside the workspace.");
  if (existsSync(full)) {
    const r = real(full);
    const rr = real(root);
    if (r !== rr && !r.startsWith(rr + path.sep)) throw new Error("That path is outside the workspace.");
  }
  return full;
}
