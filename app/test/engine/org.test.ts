import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Org } from "../../src/shared/api";
import { harness, fixtureRepo } from "./harness";

let h: ReturnType<typeof harness>;
let repo: string;
let projectId: string;
const claude = "claude-sonnet-4-5";

function boot(env: Record<string, string> = {}): Promise<void> {
  h = harness(env);
  repo = fixtureRepo(h.dir);
  return h.call("addProject", { path: repo }).then((p) => {
    projectId = p.id;
  });
}
afterEach(() => h.close());

const org = (): Promise<Org> => h.call("org", { projectId });
async function settled(): Promise<Org> {
  await h.until(async () => (await org()).runs.every((r) => r.status !== "running"));
  return org();
}
async function hire(name: string, extra: Partial<Parameters<typeof h.call<"hireAgent">>[1]> = {}) {
  return h.call("hireAgent", {
    projectId, name, role: "Engineer who fixes one thing at a time and reports what changed.", provider: "claude", model: claude,
    level: "execute", budgetUsd: 5, isolated: true, guardrails: [], collaboration: "", ...extra,
  });
}
const git = (...a: string[]): string => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();

describe("team", () => {
  beforeEach(() => boot());

  it("hires an agent on its own branch, edits it and fires it", async () => {
    const a = await hire("reviewer", { level: "observe", isolated: false });
    expect(a.level).toBe("observe");
    expect(a.branch).toBeNull();
    const b = await hire("builder");
    expect(b.branch).toBe("ceo/builder");
    expect(existsSync(path.join(repo, ".ceo/worktrees/builder"))).toBe(true);

    const moved = await h.call("updateAgent", { projectId, name: "reviewer", change: { provider: "codex", budgetUsd: 9, level: "propose" } });
    expect(moved.provider).toBe("codex");
    expect(moved.model).not.toBe(claude);
    expect(moved.budgetUsd).toBe(9);
    expect(moved.level).toBe("propose");

    await h.call("fireAgent", { projectId, name: "reviewer", reason: "done" });
    const o = await org();
    expect(o.agents.map((x) => x.name)).toEqual(["builder"]);
    expect((await h.call("snapshot", undefined)).org[projectId]!.agents).toBe(1);
  });

  it("delegates a task, streams the run and records it", async () => {
    await hire("builder");
    const run = await h.call("delegate", { projectId, agent: "builder", task: "Tidy the retry helper" });
    expect(run?.status).toBe("running");
    expect(await h.call("delegate", { projectId, agent: "builder", task: "Second job at once" })).toBeNull();
    await h.until(async () => (await org()).tasks.every((t) => t.status === "done"), 20000);
    const o = await settled();
    const done = o.runs.find((r) => r.task === "Tidy the retry helper")!;
    expect(done.status).toBe("done");
    expect(done.lines.some((l) => l.kind === "text")).toBe(true);
    expect(h.events.some((e) => e.type === "org-line")).toBe(true);
    expect(o.tasks.find((t) => t.title === "Tidy the retry helper")!.status).toBe("done");
    // The second delegation waited for the agent, then ran on its own.
    expect(o.tasks.find((t) => t.title === "Second job at once")!.status).toBe("done");
    expect((await h.call("dispatch", { projectId })).started).toBe(0);
    const detail = await h.call("agentDetail", { projectId, name: "builder" });
    expect(detail.runs.length).toBe(2);
    expect(detail.prompt).toContain("Engineer");
  });

  it("cancels a run, and the spend stays on the record", async () => {
    h.close();
    await boot({ STUB_DELAY_MS: "400", STUB_TURNS: "6" });
    await hire("slow");
    const run = (await h.call("delegate", { projectId, agent: "slow", task: "Take your time" }))!;
    await h.call("cancelRun", { projectId, key: run.key });
    const o = await settled();
    expect(o.runs[0]!.status).toBe("cancelled");
    expect(o.tasks[0]!.status).toBe("cancelled");
  });

  it("runs a task in a container when the task asks for one", async () => {
    h.close();
    await boot({ CEO_DOCKER_BIN: path.resolve(__dirname, "../../../tools/stub-docker") });
    await hire("boxed", { isolated: false });
    await h.call("addTask", { projectId, title: "Run inside the box", assignee: "boxed", sandbox: "docker", run: true });
    const o = await settled();
    expect(o.runs[0]!.status).toBe("done");
    expect(o.tasks[0]!.sandbox).toBe("docker");
    const start = readFileSync(path.join(repo, ".ceo/ledger.jsonl"), "utf8").split("\n").find((l) => l.includes('"delegate_start"'))!;
    expect(start).toContain("docker");
  });

  it("broadcasts to every team agent", async () => {
    await hire("one", { isolated: false });
    await hire("two", { isolated: false });
    const r = await h.call("broadcast", { projectId, task: "Report what you see", agents: [] });
    expect(r.started.sort()).toEqual(["one", "two"]);
    const o = await settled();
    expect(o.runs.filter((x) => x.via === "broadcast").length).toBe(2);
  });

  it("runs a task with a check as an attempt and asks before merging", async () => {
    h.close();
    await boot({ STUB_WRITE_FILE_CLAUDE: "NOTES.md" });
    await hire("builder");
    const t = await h.call("addTask", { projectId, title: "Make the check pass", assignee: "builder", checks: ["true"], run: true });
    expect(t.checks).toEqual(["true"]);
    await h.until(async () => {
      const x = (await org()).tasks.find((y) => y.id === t.id)!;
      return x.status === "done" || x.status === "failed";
    }, 30000);
    const o = await org();
    const task = o.tasks.find((y) => y.id === t.id)!;
    expect(task.status).toBe("done");
    expect(task.attempts.length).toBe(1);
    expect(task.attempts[0]!.pass).toBe(true);
    // Auto-merge is off, so the promotion waits for a person.
    expect(o.approvals.length).toBe(1);
    expect(o.approvals[0]!.action).toBe("merge");
    // A dirty checkout is refused before anything merges.
    writeFileSync(path.join(repo, "README.md"), "# changed\n");
    await expect(h.call("decide", { projectId, id: o.approvals[0]!.id, approve: true })).rejects.toThrow(/uncommitted/);
    git("checkout", "README.md");
    const r = await h.call("decide", { projectId, id: o.approvals[0]!.id, approve: true });
    expect(r.ok).toBe(true);
    expect(git("log", "-1", "--format=%s", "main")).toContain("ceo: merge work from agent");
    expect(git("show", "main:NOTES.md")).toBe("fixed");
    expect((await org()).approvals.length).toBe(0);
  });

  it("keeps the mission, the docket and notes", async () => {
    await hire("builder", { isolated: false });
    const m = await h.call("setMission", { projectId, objective: "Ship a retry helper that never loops forever.", criteria: ["Tests pass"], guardrails: ["Never push to main"], checks: ["true"] });
    expect(m.checks[0]!.name).toBe("true");
    const checked = await h.call("checkMission", { projectId });
    expect(checked.checks[0]!.state).toBe("pass");
    const item = await h.call("addDocket", { projectId, input: "README.md", agents: ["builder"] });
    expect(item.agents).toEqual(["builder"]);
    await h.call("shareDocket", { projectId, id: item.id, agent: "builder", give: false });
    expect((await org()).docket[0]!.agents).toEqual([]);
    await h.call("postNote", { projectId, to: "builder", text: "Keep it small." });
    const o = await org();
    expect(o.notes[0]!.text).toBe("Keep it small.");
    expect(o.mission!.guardrails).toEqual(["Never push to main"]);
    expect(o.ledger.ok).toBe(true);
  });

  it("hires a company from a template", async () => {
    const list = await h.call("companies", undefined);
    expect(list.length).toBeGreaterThan(1);
    const preview = await h.call("previewCompany", { projectId, id: list[0]!.id, scale: 1 });
    expect(preview.seats.length).toBeGreaterThan(1);
    const r = await h.call("hireCompany", { projectId, id: list[0]!.id, scale: 1 });
    expect(r.hired.length).toBeGreaterThan(1);
    const o = await org();
    expect(o.chief).not.toBeNull();
    expect(o.agents.length).toBe(r.hired.length);
  });

  it("refuses to fire or delegate around a workspace's own agent", async () => {
    const w = await h.call("createWorkspace", { projectId, title: "x", start: { kind: "base" }, provider: "claude", model: claude, mode: "build" });
    await h.until(async () => (await h.call("snapshot", undefined)).workspaces[0]!.status === "ready");
    await expect(h.call("fireAgent", { projectId, name: w.slug, reason: null })).rejects.toThrow(/belongs to a workspace/);
    const o = await org();
    expect(o.agents.find((a) => a.name === w.slug)!.workspaceId).toBe(w.id);
    expect((await h.call("snapshot", undefined)).org[projectId]!.agents).toBe(0);
  });
});

describe("chief of staff", () => {
  it("hires and delegates through the org server, then the work starts on its own", async () => {
    const script = path.join(process.env.TMPDIR ?? "/tmp", `chief-${process.pid}.json`);
    writeFileSync(script, JSON.stringify([
      {
        match: "fix the retry",
        calls: [
          { tool: "org_hire", args: { name: "fixer", brief: "Fixes the retry helper and adds a test for it.", provider: "claude", budgetUsd: 2, level: "execute" } },
          { tool: "org_delegate", args: { agent: "fixer", task: "Fix the retry helper so it stops after three tries." } },
        ],
        reply: "Hired fixer and gave it the retry fix. At most $2.",
      },
    ]));
    await boot({ STUB_CHAT: script });
    await h.call("hireChief", { projectId });
    await h.call("chiefSend", { projectId, text: "Please fix the retry helper" });
    await expect(h.call("chiefSend", { projectId, text: "again" })).rejects.toThrow(/still replying/);
    await h.until(async () => {
      const o = await org();
      return !!o.chief && !o.chief.replying && o.tasks.some((t) => t.status === "done");
    }, 30000);
    const o = await settled();
    const turn = o.chief!.turns.at(-1)!;
    expect(turn.reply).toContain("Hired fixer");
    expect(turn.actions.map((a) => a.kind)).toEqual(["hire", "delegate"]);
    expect(o.agents.map((a) => a.name)).toContain("fixer");
    expect(o.runs.some((r) => r.agent === "fixer" && r.via === "chief" && r.status === "done")).toBe(true);
    expect(o.chief!.allowance.givenUsd).toBe(2);

    // A lower level stops the chief from starting work.
    const c = await h.call("chiefSet", { projectId, level: "observe" });
    expect(c.may.start).toBe(false);
    await h.call("chiefNew", { projectId });
    expect((await org()).chief!.turns.length).toBe(0);
  });
});

describe("review regressions", () => {
  it("keeps team runs off a workspace's own agent", async () => {
    await boot();
    const w = await h.call("createWorkspace", { projectId, title: "x", start: { kind: "base" }, provider: "claude", model: claude, mode: "build" });
    await h.until(async () => (await h.call("snapshot", undefined)).workspaces[0]!.status === "ready");
    await expect(h.call("delegate", { projectId, agent: w.slug, task: "Work in that folder" })).rejects.toThrow(/belongs to a workspace/);
    const t = await h.call("addTask", { projectId, title: "Queued for the workspace agent", assignee: w.slug });
    await expect(h.call("runTask", { projectId, id: t.id })).rejects.toThrow(/belongs to a workspace/);
    expect((await h.call("dispatch", { projectId })).started).toBe(0);
  });

  it("queues work for a busy agent without an error, then starts it when the agent is free", async () => {
    await boot({ STUB_DELAY_MS: "150" });
    await hire("solo", { isolated: false });
    expect(await h.call("delegate", { projectId, agent: "solo", task: "First job" })).not.toBeNull();
    expect(await h.call("delegate", { projectId, agent: "solo", task: "Second job" })).toBeNull();
    await h.until(async () => (await org()).tasks.every((t) => t.status === "done"), 20000);
    expect((await org()).tasks.length).toBe(2);
  });

  it("pins a checked task written elsewhere to the assignee's provider", async () => {
    await boot();
    await hire("builder");
    const core = await import("../../../src/core/tasks");
    for (let i = 0; i < 4; i++) {
      const t = core.addTask({ title: `Checked task ${i} from the chief`, assignee: "builder", verifiers: [{ kind: "command", run: "true" } as never] }, repo);
      await h.call("runTask", { projectId, id: t.id });
      await h.until(async () => (await org()).tasks.find((x) => x.id === t.id)!.status === "done", 20000);
    }
    const arms = (await org()).tasks.flatMap((t) => t.attempts.map((a) => a.arm));
    expect(arms.length).toBe(4);
    expect(arms.every((a) => a.startsWith("claude"))).toBe(true);
  });

  it("cancels a task left running by a closed app", async () => {
    await boot();
    await hire("ghost", { isolated: false });
    const t = await h.call("addTask", { projectId, title: "Cut off midway", assignee: "ghost" });
    const core = await import("../../../src/core/tasks");
    core.updateTask(t.id, { status: "running" }, repo);
    await h.call("cancelTask", { projectId, id: t.id });
    expect((await org()).tasks[0]!.status).toBe("cancelled");
  });

  it("auto-merge waits in Approvals when the checkout is dirty", async () => {
    await boot({ STUB_WRITE_FILE_CLAUDE: "NOTES.md" });
    await hire("builder");
    await h.call("setAutoMerge", { projectId, on: true });
    writeFileSync(path.join(repo, "README.md"), "# edited by a person\n");
    const t = await h.call("addTask", { projectId, title: "Merge on its own", assignee: "builder", checks: ["true"], run: true });
    await h.until(async () => (await org()).tasks.find((x) => x.id === t.id)!.status === "done", 20000);
    const o = await org();
    expect(o.approvals.length).toBe(1);
    expect(o.approvals[0]!.summary).toContain("Auto-merge waited");
    expect(git("log", "-1", "--format=%s", "main")).toBe("first");
    expect(readFileSync(path.join(repo, "README.md"), "utf8")).toBe("# edited by a person\n");
  });

  it("a conflicted approval is undone and asked again; CEO's own files do not count as dirty", async () => {
    await boot({ STUB_WRITE_FILE_CLAUDE: "NOTES.md" });
    await hire("builder");
    // A repo that tracks the roster, as the core suggests. Every run rewrites it.
    git("add", "-f", ".ceo/roster.json");
    git("commit", "-m", "track roster");
    const t = await h.call("addTask", { projectId, title: "Write notes", assignee: "builder", checks: ["true"], run: true });
    await h.until(async () => (await org()).approvals.length === 1, 20000);
    // Main moves on and touches the same file.
    writeFileSync(path.join(repo, "NOTES.md"), "different\n");
    git("add", "NOTES.md");
    git("commit", "-m", "notes on main");
    const first = (await org()).approvals[0]!;
    const r = await h.call("decide", { projectId, id: first.id, approve: true });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/conflicts/);
    expect(existsSync(path.join(repo, ".git/MERGE_HEAD"))).toBe(false);
    const again = (await org()).approvals;
    expect(again.length).toBe(1);
    expect(again[0]!.id).not.toBe(first.id);
    expect(again[0]!.taskId).toBe(t.id);
  });

  it("does not restart a task on every settle while a provider limit holds", async () => {
    await boot({ STUB_ERROR: "Claude AI usage limit reached. Try again in 5 minutes." });
    await hire("limited", { isolated: false });
    await h.call("saveProjectConfig", { projectId, config: { autoDispatch: true } });
    await h.call("delegate", { projectId, agent: "limited", task: "Hit the limit" });
    await settled();
    await new Promise((r) => setTimeout(r, 1500));
    const starts = readFileSync(path.join(repo, ".ceo/ledger.jsonl"), "utf8").split("\n").filter((l) => l.includes('"delegate_start"')).length;
    expect(starts).toBe(1);
    expect((await org()).tasks[0]!.status).toBe("queued");
    const limits = await import("../../../src/core/limits");
    limits.cooldowns.clear();
  });

  it("refuses a branch of its own before the first commit", async () => {
    await boot();
    const empty = path.join(h.dir, "empty");
    execFileSync("git", ["init", empty], { stdio: "ignore" });
    const p = await h.call("addProject", { path: empty });
    await expect(h.call("hireAgent", { projectId: p.id, name: "early", role: "Engineer who fixes one thing at a time.", provider: "claude", model: claude, level: "execute", budgetUsd: 5, isolated: true, guardrails: [], collaboration: "" })).rejects.toThrow(/first commit/);
  });
});

describe("free plan", () => {
  it("holds three team agents and no chief", async () => {
    await boot();
    const file = path.join(process.env.CEO_HOME!, "app", "license.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ key: null, firstRunAt: Date.now() - 30 * 86400000 }));
    await hire("aa", { isolated: false });
    await hire("bb", { isolated: false });
    await hire("cc", { isolated: false });
    await expect(hire("dd", { isolated: false })).rejects.toThrow(/free plan/);
    await expect(h.call("hireChief", { projectId })).rejects.toThrow(/Pro/);
    await expect(h.call("addTask", { projectId, title: "Try twice", assignee: "aa", samples: 2 })).rejects.toThrow(/Pro/);
  });
});
