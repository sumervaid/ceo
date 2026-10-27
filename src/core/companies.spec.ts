/**
 * Companies against real ledgers in temp directories, one of them a git
 * repository with a commit so worktrees can be provisioned. No agent runs.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { COMPANIES, describeHire, findCompany, hireCompany, landingProvider, planCompany } from "./companies.js";
import { initLedger, readLedger, verify } from "./ledger.js";
import { forgetProjectRoots } from "./paths.js";
import { findAgent, findChief, hire, readRoster } from "./roster.js";
import { isolateAgent } from "../tui/actions.js";
import type { Provider } from "./types.js";

process.env.CEO_SKIP_SETUP_CHECK = "1";

function repo(commit = true): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ceo-company-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  if (commit) {
    writeFileSync(path.join(dir, "README.md"), "orbit\n");
    git("add", ".");
    git("commit", "-q", "-m", "first");
  }
  forgetProjectRoots();
  initLedger(dir);
  return dir;
}

test("every company mixes providers, names each seat once and gives each a real brief", () => {
  for (const c of COMPANIES) {
    const names = c.seats.map((s) => s.name);
    assert.equal(new Set(names).size, names.length, c.id);
    assert.ok(new Set(c.seats.map((s) => s.provider)).size >= 2, `${c.id} uses one provider`);
    for (const s of c.seats) {
      assert.ok(s.brief.length >= 40, `${c.id}/${s.name} brief`);
      assert.notEqual(s.autonomy, "autonomous", `${c.id}/${s.name} unattended merge`);
    }
  }
  assert.equal(findCompany("Software team")?.id, "software");
  assert.equal(findCompany("nope"), undefined);
});

test("a seat moves to the next ready provider when its own is not ready, and says so", () => {
  const onlyClaude = (p: Provider) => p === "claude";
  assert.equal(landingProvider("gemini", onlyClaude), "claude");
  assert.equal(landingProvider("codex", (p) => p === "gemini"), "gemini");
  assert.equal(landingProvider("codex", () => false), "codex");

  const dir = repo();
  try {
    const plan = planCompany(findCompany("software")!, dir, { ready: onlyClaude });
    assert.deepEqual(plan.providers, ["claude"]);
    const reviewer = plan.seats.find((s) => s.name === "reviewer")!;
    assert.equal(reviewer.provider, "claude");
    assert.equal(reviewer.movedFrom, "gemini");
    assert.equal(reviewer.model, "claude-sonnet-5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktrees: writers by default in a repository with a commit, none outside one, and the plan says why", () => {
  const dir = repo();
  const bare = mkdtempSync(path.join(tmpdir(), "ceo-company-plain-"));
  const empty = repo(false);
  try {
    initLedger(bare);
    const software = findCompany("software")!;

    const writers = planCompany(software, dir);
    assert.equal(writers.worktrees, "writers");
    assert.deepEqual(writers.seats.filter((s) => s.isolated).map((s) => s.name), ["implementer", "tester"]);
    assert.equal(writers.worktreeNote, null);

    const all = planCompany(software, dir, { worktrees: "all" });
    assert.ok(all.seats.every((s) => s.isolated));
    const none = planCompany(software, dir, { worktrees: "none" });
    assert.ok(none.seats.every((s) => !s.isolated));

    const outside = planCompany(software, bare, { worktrees: "all" });
    assert.equal(outside.worktrees, "none");
    assert.match(outside.worktreeNote ?? "", /not a git repository/);
    assert.match(planCompany(software, empty).worktreeNote ?? "", /no commits yet/);

    assert.equal(writers.totalCapUsd, 2 + 5 + 2 + 3);
    assert.equal(writers.chief.hire, true);
  } finally {
    for (const d of [dir, bare, empty]) rmSync(d, { recursive: true, force: true });
  }
});

test("hiring a company hires every seat and one chief, provisions the writers' worktrees, and a second hire keeps who is there", () => {
  const dir = repo();
  try {
    const plan = planCompany(findCompany("software")!, dir);
    const result = hireCompany(plan, dir);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.hired.sort(), ["chief", "implementer", "reviewer", "scout", "tester"]);
    assert.equal(findChief(dir)?.name, "chief");
    assert.equal(findAgent("implementer", dir)?.branch, "ceo/implementer");
    assert.equal(findAgent("implementer", dir)?.provider, "codex");
    assert.equal(findAgent("reviewer", dir)?.provider, "gemini");
    assert.equal(findAgent("scout", dir)?.isolated, false);
    assert.match(describeHire(result, plan), /^5 agents on claude, codex and gemini$/);

    const note = readLedger(dir).find((e) => e.type === "note" && e.data.kind === "company")!;
    assert.equal(note.data.template, "software");
    assert.equal(note.data.worktrees, "writers");

    const again = planCompany(findCompany("full")!, dir);
    assert.equal(again.chief.hire, false);
    const second = hireCompany(again, dir);
    assert.deepEqual(second.hired, ["documenter"]);
    assert.deepEqual(second.skipped.sort(), ["implementer", "reviewer", "scout", "tester"]);
    assert.equal(readRoster(dir).agents.filter((a) => a.chief).length, 1);
    assert.equal(describeHire(hireCompany(planCompany(findCompany("full")!, dir), dir), again), "nobody new");
    assert.equal(verify(dir).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("i gives an existing agent a worktree, once, and explains when git cannot", () => {
  const dir = repo();
  const empty = repo(false);
  try {
    hire({ name: "scout", role: "Survey the codebase and answer questions about it." }, dir);
    const first = isolateAgent("scout", dir);
    assert.equal(first.ok, true);
    assert.match(first.message, /now works on branch ceo\/scout/);
    assert.equal(findAgent("scout", dir)?.branch, "ceo/scout");
    assert.match(isolateAgent("scout", dir).message, /already works on branch ceo\/scout/);

    hire({ name: "scout", role: "Survey the codebase and answer questions about it." }, empty);
    const refused = isolateAgent("scout", empty);
    assert.equal(refused.ok, false);
    assert.match(refused.message, /first commit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});
