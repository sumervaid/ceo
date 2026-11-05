import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Workspace } from "../../src/shared/api";
import { harness, fixtureRepo } from "./harness";

let h: ReturnType<typeof harness>;
let repo: string;
let projectId: string;
const claude = "claude-sonnet-4-5";

beforeEach(async () => {
  h = harness();
  repo = fixtureRepo(h.dir);
  projectId = (await h.call("addProject", { path: repo })).id;
});
afterEach(() => h.close());

async function wsOf(id: string): Promise<Workspace> {
  return (await h.call("snapshot", undefined)).workspaces.find((w) => w.id === id)!;
}
async function ready(id: string): Promise<Workspace> {
  await h.until(async () => (await wsOf(id)).status === "ready");
  return wsOf(id);
}
async function create(prompt?: string): Promise<Workspace> {
  const w = await h.call("createWorkspace", { projectId, title: "Fix retry", start: { kind: "base" }, provider: "claude", model: claude, mode: "build", prompt });
  return ready(w.id);
}
async function idle(id: string): Promise<Workspace> {
  await h.until(async () => { const w = await wsOf(id); return w.runningTabs.length === 0 && w.queued === 0; });
  return wsOf(id);
}

describe("projects", () => {
  it("finds the base branch and does not touch tracked files", async () => {
    const snap = await h.call("snapshot", undefined);
    expect(snap.projects[0]!.baseRef).toBe("main");
    await create();
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })).toBe("");
    expect(readFileSync(path.join(repo, ".git/info/exclude"), "utf8")).toContain(".ceo/");
  });

  it("refuses a clone URL that could run a command", async () => {
    await expect(h.call("cloneProject", { url: "ext::sh -c touch /tmp/x", into: h.dir })).rejects.toThrow(/https or ssh/);
    await expect(h.call("cloneProject", { url: "--upload-pack=x", into: h.dir })).rejects.toThrow(/https or ssh/);
  });

  it("makes a first commit for an empty repository", async () => {
    const empty = path.join(h.dir, "empty");
    execFileSync("git", ["init", empty], { stdio: "ignore" });
    const p = await h.call("addProject", { path: empty });
    expect(p.hasCommits).toBe(false);
    await expect(h.call("createWorkspace", { projectId: p.id, title: "x", start: { kind: "base" }, provider: "claude", model: claude, mode: "build" })).rejects.toThrow(/first commit/);
    expect((await h.call("createFirstCommit", { projectId: p.id })).hasCommits).toBe(true);
  });
});

describe("workspaces", () => {
  it("creates an isolated worktree on its own branch, with a reserved port", async () => {
    const w = await create();
    expect(w.branch).toBe(`ceo/${w.slug}`);
    expect(existsSync(path.join(w.worktree, "README.md"))).toBe(true);
    expect(execFileSync("git", ["branch", "--show-current"], { cwd: w.worktree, encoding: "utf8" }).trim()).toBe(w.branch);
    const b = await create();
    expect(b.port).not.toBe(w.port);
    expect(b.slug).not.toBe(w.slug);
  });

  it("copies .env, runs setup with the port, then starts the queued message", async () => {
    writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
    execFileSync("git", ["-C", repo, "status"], { stdio: "ignore" });
    await h.call("saveProjectConfig", { projectId, config: { setup: 'echo "port=$CEO_PORT" > .context/setup.txt' } });
    const w = await h.call("createWorkspace", { projectId, title: "s", start: { kind: "base" }, provider: "claude", model: claude, mode: "build", prompt: "do the thing" });
    await ready(w.id);
    await idle(w.id);
    const after = await wsOf(w.id);
    expect(readFileSync(path.join(after.worktree, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(readFileSync(path.join(after.worktree, ".context/setup.txt"), "utf8")).toContain(`port=${after.port}`);
    const items = await h.call("chatHistory", { id: w.id, tabId: after.tabs[0]!.id });
    expect(items.some((i) => i.kind === "result" && i.ok)).toBe(true);
    // .env is not ignored in this repo, so it shows in the diff as new. .context never does.
    const d = await h.call("diff", { id: w.id });
    expect(d.files.map((f) => f.path)).not.toContain(".context/setup.txt");
  });

  it("archives with uncommitted work and restores it, uncommitted", async () => {
    const w = await create();
    writeFileSync(path.join(w.worktree, "draft.txt"), "unfinished\n");
    await h.call("archiveWorkspace", { id: w.id });
    expect((await wsOf(w.id)).status).toBe("archived");
    expect(existsSync(w.worktree)).toBe(false);
    await expect(h.call("send", { id: w.id, tabId: w.tabs[0]!.id, text: "hello", attachments: [] })).rejects.toThrow(/Restore/);
    await h.call("restoreWorkspace", { id: w.id });
    expect(readFileSync(path.join(w.worktree, "draft.txt"), "utf8")).toBe("unfinished\n");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: w.worktree, encoding: "utf8" })).toContain("draft.txt");
  });

  it("deletes the branch and the record", async () => {
    const w = await create();
    await h.call("deleteWorkspace", { id: w.id });
    expect((await h.call("snapshot", undefined)).workspaces).toHaveLength(0);
    expect(execFileSync("git", ["branch"], { cwd: repo, encoding: "utf8" })).not.toContain(w.branch);
  });

  it("survives a restart with chat and workspace intact", async () => {
    const w = await create("first message");
    await idle(w.id);
    h.close();
    const home = process.env.CEO_HOME!;
    const again = harness({ CEO_HOME: home });
    try {
      const snap = await again.call("snapshot", undefined);
      const same = snap.workspaces.find((x) => x.id === w.id)!;
      expect(same.title).toBe("Fix retry");
      const items = await again.call("chatHistory", { id: w.id, tabId: same.tabs[0]!.id });
      expect(items.filter((i) => i.kind === "user")).toHaveLength(1);
    } finally {
      again.close();
    }
  });
});

describe("chat", () => {
  it("records each run with cost, resumes the session and queues a second message", async () => {
    const w = await create();
    const tab = w.tabs[0]!.id;
    await h.call("send", { id: w.id, tabId: tab, text: "one", attachments: [] });
    await h.call("send", { id: w.id, tabId: tab, text: "two", attachments: [] });
    const busy = await wsOf(w.id);
    expect(busy.runningTabs).toEqual([tab]);
    expect(busy.queued).toBe(1);
    const done = await idle(w.id);
    const items = await h.call("chatHistory", { id: w.id, tabId: tab });
    expect(items.filter((i) => i.kind === "user").map((i) => (i.kind === "user" ? i.text : ""))).toEqual(["one", "two"]);
    expect(items.filter((i) => i.kind === "result")).toHaveLength(2);
    expect(done.spentUsd).toBeGreaterThan(0);
    expect(done.activity).toBe("unread");
    await h.call("markRead", { id: w.id });
    expect((await wsOf(w.id)).activity).toBe("idle");
    expect(done.tabs[0]!.sessionId).toBeTruthy();
    expect(done.tabs[0]!.title).toBe("one");
    expect(h.events.some((e) => e.type === "notify" && e.level === "done")).toBe(true);
  });

  it("stops a running agent and records the cancel", async () => {
    process.env.STUB_NO_RESULT = "1";
    try {
      const w = await create();
      const tab = w.tabs[0]!.id;
      await h.call("send", { id: w.id, tabId: tab, text: "long job", attachments: [] });
      await h.until(async () => (await h.call("chatHistory", { id: w.id, tabId: tab })).some((i) => i.kind === "tool"));
      await h.call("stop", { id: w.id, tabId: tab });
      await idle(w.id);
      const items = await h.call("chatHistory", { id: w.id, tabId: tab });
      const r = items.find((i) => i.kind === "result");
      expect(r && r.kind === "result" && r.cancelled).toBe(true);
    } finally {
      delete process.env.STUB_NO_RESULT;
    }
  });

  it("runs plan mode read-only, whatever the agent's level", async () => {
    const w = await create();
    const tab = w.tabs[0]!.id;
    await h.call("updateTab", { id: w.id, tabId: tab, mode: "plan" });
    await h.call("send", { id: w.id, tabId: tab, text: "plan this", attachments: [] });
    await idle(w.id);
    const led = readFileSync(path.join(repo, ".ceo/ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const start = led.filter((e) => e.type === "delegate_start").pop();
    expect(JSON.stringify(start.data.enforcement)).not.toMatch(/Write|Edit/);
  });

  it("hands off across providers without resuming the other CLI's session", async () => {
    const w = await create();
    const tab = w.tabs[0]!.id;
    await h.call("send", { id: w.id, tabId: tab, text: "first", attachments: [] });
    await idle(w.id);
    await h.call("updateTab", { id: w.id, tabId: tab, provider: "codex", model: "gpt-5-codex" });
    await h.call("send", { id: w.id, tabId: tab, text: "second", attachments: [] });
    await idle(w.id);
    const items = await h.call("chatHistory", { id: w.id, tabId: tab });
    const results = items.filter((i) => i.kind === "result");
    expect(results[1] && results[1].kind === "result" && results[1].provider).toBe("codex");
    expect(results[1] && results[1].kind === "result" && results[1].ok).toBe(true);
    const led = readFileSync(path.join(repo, ".ceo/ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const starts = led.filter((e) => e.type === "delegate_start");
    expect(starts[1].data.provider).toBe("codex");
    expect(starts[1].data.resumed).toBeUndefined();
  });

  it("refuses a run past the budget", async () => {
    const w = await create();
    const tab = w.tabs[0]!.id;
    await h.call("setBudget", { id: w.id, budgetUsd: 0.0001 });
    await h.call("send", { id: w.id, tabId: tab, text: "first", attachments: [] });
    await idle(w.id);
    await h.call("send", { id: w.id, tabId: tab, text: "second", attachments: [] });
    await idle(w.id);
    const items = await h.call("chatHistory", { id: w.id, tabId: tab });
    const last = items.filter((i) => i.kind === "result").pop();
    expect(last && last.kind === "result" && last.ok).toBe(false);
    expect(last && last.kind === "result" && last.error).toMatch(/budget/i);
  });

  it("marks comments as sent when they go to the agent", async () => {
    const w = await create();
    const c = await h.call("addComment", { id: w.id, path: "src/retry.ts", startLine: 1, endLine: 1, side: "new", text: "Rename this", excerpt: "export const retry = 1;" });
    await h.call("send", { id: w.id, tabId: w.tabs[0]!.id, text: "", attachments: [{ kind: "comment", comment: c }] });
    expect((await wsOf(w.id)).comments[0]!.sentAt).toBeTruthy();
    await idle(w.id);
  });
});

describe("review", () => {
  it("shows committed, modified, untracked and renamed files, and marks viewed", async () => {
    const w = await create();
    appendFileSync(path.join(w.worktree, "src/retry.ts"), "export const more = 2;\n");
    writeFileSync(path.join(w.worktree, "new file.txt"), "a\nb\n");
    const d = await h.call("diff", { id: w.id });
    expect(d.files.map((f) => f.path)).toEqual(["new file.txt", "src/retry.ts"]);
    const added = d.files[0]!;
    expect(added.status).toBe("added");
    expect(added.added).toBe(2);
    const mod = d.files[1]!;
    expect(mod.hunks[0]!.lines.find((l) => l.t === "add")!.n).toBe(2);
    await h.call("markViewed", { id: w.id, path: mod.path, hash: mod.hash });
    expect((await wsOf(w.id)).viewed[mod.path]).toBe(mod.hash);
    await h.until(async () => (await wsOf(w.id)).git.files === 2);
    const git = (await wsOf(w.id)).git;
    expect(git.added).toBe(3);
    expect(git.dirty).toBe(true);
    execFileSync("git", ["add", "-A"], { cwd: w.worktree });
    execFileSync("git", ["commit", "-m", "work"], { cwd: w.worktree, stdio: "ignore" });
    execFileSync("git", ["mv", "README.md", "DOCS.md"], { cwd: w.worktree });
    const e = await h.call("diff", { id: w.id });
    expect(e.commits).toHaveLength(1);
    expect(e.files.find((f) => f.path === "DOCS.md")!.status).toBe("renamed");
    const one = await h.call("diff", { id: w.id, commit: e.commits[0]!.sha });
    expect(one.files.map((f) => f.path)).toEqual(["new file.txt", "src/retry.ts"]);
    await expect(h.call("diff", { id: w.id, commit: "deadbeef" })).rejects.toThrow(/not on this/);
  });

  it("discards one file back to the base", async () => {
    const w = await create();
    appendFileSync(path.join(w.worktree, "src/retry.ts"), "junk\n");
    writeFileSync(path.join(w.worktree, "stray.txt"), "x\n");
    await h.call("discardFile", { id: w.id, path: "src/retry.ts" });
    await h.call("discardFile", { id: w.id, path: "stray.txt" });
    expect((await h.call("diff", { id: w.id })).files).toHaveLength(0);
    expect(existsSync(path.join(w.worktree, "stray.txt"))).toBe(false);
  });

  it("never reads or deletes outside the worktree", async () => {
    const w = await create();
    await expect(h.call("readFile", { id: w.id, path: "../../../README.md" })).rejects.toThrow(/outside/);
    await expect(h.call("discardFile", { id: w.id, path: "../../../README.md" })).rejects.toThrow(/outside/);
    execFileSync("ln", ["-s", "/etc/hosts", "link"], { cwd: w.worktree });
    await expect(h.call("readFile", { id: w.id, path: "link" })).rejects.toThrow(/outside/);
  });

  it("detects a conflict with the base, then updates from a clean base", async () => {
    const w = await create();
    writeFileSync(path.join(w.worktree, "README.md"), "# Mine\n");
    execFileSync("git", ["commit", "-am", "mine"], { cwd: w.worktree, stdio: "ignore" });
    writeFileSync(path.join(repo, "README.md"), "# Theirs\n");
    execFileSync("git", ["commit", "-am", "theirs"], { cwd: repo, stdio: "ignore" });
    const report = await h.call("checks", { id: w.id });
    expect(report.git.conflicts).toEqual(["README.md"]);
    expect(report.next).toBe("resolve-conflicts");
    const u = await h.call("updateFromBase", { id: w.id });
    expect(u.conflicts).toEqual(["README.md"]);
    execFileSync("git", ["merge", "--abort"], { cwd: w.worktree });
  });

  it("merges locally into the base, and says when the checkout is elsewhere", async () => {
    const w = await create();
    writeFileSync(path.join(w.worktree, "feature.txt"), "ok\n");
    execFileSync("git", ["checkout", "-q", "-b", "other"], { cwd: repo });
    await expect(h.call("mergeLocal", { id: w.id })).rejects.toThrow(/Switch it to main/);
    execFileSync("git", ["checkout", "-q", "main"], { cwd: repo });
    expect((await h.call("mergeLocal", { id: w.id })).conflicts).toEqual([]);
    expect(existsSync(path.join(repo, "feature.txt"))).toBe(true);
    expect((await wsOf(w.id)).mergedAt).toBeTruthy();
  });
});

describe("scripts", () => {
  it("runs, streams, finds the URL and stops the whole process group", async () => {
    await h.call("saveProjectConfig", { projectId, config: { run: 'echo "listening on http://localhost:$CEO_PORT/app"; sleep 30' } });
    const w = await create();
    await h.call("runScript", { id: w.id, kind: "run" });
    await h.until(async () => (await h.call("scriptState", { id: w.id, kind: "run" })).url !== null);
    expect((await h.call("scriptState", { id: w.id, kind: "run" })).url).toBe(`http://localhost:${w.port}/app`);
    await h.call("stopScript", { id: w.id, kind: "run" });
    await h.until(async () => !(await h.call("scriptState", { id: w.id, kind: "run" })).running);
  });

  it("explains a missing script", async () => {
    const w = await create();
    await expect(h.call("runScript", { id: w.id, kind: "run" })).rejects.toThrow(/no run script/);
  });
});

describe("race", () => {
  it("runs every agent, a real check picks the winner, and keeping it archives the rest", async () => {
    process.env.STUB_WRITE_FILE = "WIN";
    try {
      const race = await h.call("startRace", {
        projectId, title: "Fix it", prompt: "fix the bug", check: "test -f WIN",
        arms: [{ provider: "claude", model: claude }, { provider: "codex", model: "gpt-5-codex" }, { provider: "gemini", model: "gemini" }],
      });
      expect(race.entries).toHaveLength(3);
      await h.until(async () => (await h.call("snapshot", undefined)).races[0]!.settledAt !== null, 25000);
      const done = (await h.call("snapshot", undefined)).races[0]!;
      const winner = done.entries.find((e) => e.workspaceId === done.winnerId)!;
      expect(winner.provider).toBe("codex");
      expect(done.entries.filter((e) => e.state === "failed")).toHaveLength(2);
      const led = readFileSync(path.join(repo, ".ceo/ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(led.some((e) => e.type === "promote")).toBe(true);
      const insights = await h.call("insights", { projectId });
      const ours = insights.rows.filter((r) => r.source !== "reflex");
      expect(ours.find((r) => r.provider === "codex")!.passes).toBe(1);
      expect(ours.find((r) => r.provider === "claude")!.passes).toBe(0);
      await h.call("keepWinner", { raceId: done.id, workspaceId: winner.workspaceId });
      const after = (await h.call("snapshot", undefined)).workspaces;
      expect(after.filter((w) => w.status === "archived")).toHaveLength(2);
      expect(after.find((w) => w.id === winner.workspaceId)!.status).toBe("ready");
    } finally {
      delete process.env.STUB_WRITE_FILE;
    }
  });
});

describe("spend", () => {
  it("adds up cost by provider, workspace and day, and reports a broken ledger", async () => {
    const w = await create("first");
    await idle(w.id);
    const s = await h.call("spend", { projectId, days: 7 });
    expect(s.runs).toBe(1);
    expect(s.totalUsd).toBeCloseTo(0.0123);
    expect(s.byProvider[0]!.label).toBe("claude");
    expect(s.byWorkspace[0]!.label).toBe("Fix retry");
    expect(s.byDay).toHaveLength(7);
    expect(s.ledger.ok).toBe(true);
    const file = path.join(repo, ".ceo/ledger.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").replace('"costUsd":0.0123', '"costUsd":0.0001'));
    const t = await h.call("spend", { projectId, days: 7 });
    expect(t.ledger.ok).toBe(false);
    expect(t.ledger.detail).toMatch(/breaks at entry/);
  });
});

describe("pull requests", () => {
  it("drafts from the commits and opens through gh", async () => {
    const remote = path.join(h.dir, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo, stdio: "ignore" });
    const p = await h.call("addProject", { path: repo });
    expect(p.hasRemote).toBe(true);
    expect(p.baseRef).toBe("origin/main");
    const w = await h.call("createWorkspace", { projectId, title: "Add feature", start: { kind: "base" }, provider: "claude", model: claude, mode: "build" });
    const r = await ready(w.id);
    writeFileSync(path.join(r.worktree, "f.txt"), "x\n");
    await h.call("commit", { id: w.id, message: "Add f" });
    const draft = await h.call("draftPr", { id: w.id });
    expect(draft.title).toBe("Add feature");
    expect(draft.body).toContain("Add f");
    expect(draft.base).toBe("main");
    const report = await h.call("checks", { id: w.id });
    expect(report.next).toBe("create-pr");
    const pr = await h.call("createPr", { id: w.id, title: draft.title, body: draft.body, draft: false });
    expect(pr.url).toContain("/pull/7");
    expect(execFileSync("git", ["ls-remote", remote], { encoding: "utf8" })).toContain(r.branch);
  });
});
