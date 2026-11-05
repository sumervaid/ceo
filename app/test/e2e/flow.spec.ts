import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { launch, makeRepo } from "./app";

const DEMO = path.resolve(__dirname, "../fake/stub-demo-claude");
const shot = async (page: Page, name: string): Promise<void> => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `test-results/shots/${name}.png` });
};
const add = (page: Page, p: string) => page.evaluate((x) => (window as unknown as { ceo: { call: (m: string, p: unknown) => Promise<unknown> } }).ceo.call("addProject", { path: x }), p);
const press = (page: Page, combo: string) => page.keyboard.press(combo);

test("the whole loop: create, chat, review, comment, terminal, run, merge, archive", async () => {
  const l = await launch({ CEO_CLAUDE_BIN: DEMO });
  const { app, page } = l;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.getByTestId("onboarding")).toBeVisible({ timeout: 20000 });
  const repo = makeRepo(l.dir);
  await add(page, repo);
  await page.reload();

  // Home, empty
  await expect(page.getByTestId("home-new")).toBeVisible({ timeout: 15000 });
  await shot(page, "02-home-empty");

  // New workspace
  await page.getByTestId("home-new").click();
  await expect(page.getByTestId("new-workspace-dialog")).toBeVisible();
  await page.getByTestId("new-prompt").fill("Add exponential backoff with jitter to the retry helper");
  await shot(page, "03-new-workspace");
  await page.getByTestId("create-workspace").click();

  // Chat runs and a diff appears
  await expect(page.getByTestId("transcript")).toContainText("Added exponential backoff", { timeout: 20000 });
  await expect(page.getByTestId("changes")).toContainText("retry.test.ts", { timeout: 15000 });
  await shot(page, "04-workspace");
  expect(existsSync(path.join(repo, ".ceo/ledger.jsonl"))).toBe(true);
  expect(execFileSync("git", ["log", "--oneline", "main"], { cwd: repo, encoding: "utf8" }).trim().split("\n")).toHaveLength(1);

  // Review with an inline comment
  await page.getByTestId("open-review").click();
  await expect(page.getByTestId("review")).toBeVisible();
  await expect(page.getByTestId("diff-src/retry.ts")).toBeVisible();
  await shot(page, "05-review");
  await page.getByTestId("layout-split").click();
  await shot(page, "06-review-split");
  await page.locator('[aria-label="Unified"]').click();
  const row = page.getByTestId("diff-src/retry.ts").locator(".dl.dl-add").nth(2);
  await row.hover();
  await row.locator("button").click();
  await page.getByTestId("comment-input").fill("Rename this to initialDelayMs. Please rename everywhere.");
  await shot(page, "07-comment");
  await page.getByTestId("comment-save").click();
  await expect(page.getByTestId("line-comment")).toBeVisible();
  await page.getByTestId("viewed-README.md").click();
  await expect(page.getByTestId("send-comments")).toContainText("Send 1 comment");
  await page.getByTestId("send-comments").click();

  // The comment lands in the composer, then goes to the agent
  await expect(page.getByTestId("composer")).toContainText("retry.ts:");
  await page.getByTestId("composer-input").fill("Rename as commented");
  await shot(page, "08-comment-attached");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("transcript")).toContainText("Renamed `baseDelayMs`".replace(/`/g, ""), { timeout: 20000 });
  // Each finished run is committed to the workspace's branch, with the ledger seq in the trailer.
  await expect.poll(() => execFileSync("git", ["-C", repo, "show", "ceo/vega:src/retry.ts"], { encoding: "utf8" }), { timeout: 10000 }).toContain("initialDelayMs");

  // Plan mode, then approve
  await page.getByTestId("new-tab").click();
  await expect(page.locator(".tab")).toHaveCount(2);
  await expect(page.locator(".tab-on")).toContainText("Chat");
  await page.getByTestId("mode-plan").click();
  await expect(page.getByTestId("composer")).toHaveClass(/composer-plan/);
  await page.getByTestId("composer-input").fill("Plan a circuit breaker");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("approve-plan")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("transcript")).toContainText("Approve this plan");
  await shot(page, "09-plan");
  const planDiff = execFileSync("git", ["-C", repo, "log", "--oneline", "ceo/vega"], { encoding: "utf8" });
  expect(planDiff).not.toContain("Plan a circuit breaker");

  // @ mention
  await page.getByTestId("composer-input").fill("look at @retr");
  await expect(page.locator(".mention")).toContainText("src/retry.ts");
  await shot(page, "10-mention");
  await press(page, "Enter");
  await expect(page.getByTestId("composer")).toContainText("src/retry.ts");
  await page.getByTestId("composer-input").fill("");

  // Checks
  await page.getByTestId("insp-checks").click();
  await expect(page.getByTestId("next-action")).toContainText("Merge", { timeout: 15000 });
  await shot(page, "11-checks");

  // Files
  await page.getByTestId("insp-files").click();
  await page.getByText("README.md").first().click();
  await shot(page, "12-files");

  // Terminal really runs in the worktree
  await page.getByTestId("insp-terminal").click();
  await expect(page.getByTestId("terminal")).toBeVisible();
  await page.waitForTimeout(1200);
  await page.getByTestId("terminal").click();
  await page.keyboard.type("echo port-is-$CEO_PORT && git branch --show-current\n");
  await expect(page.getByTestId("terminal")).toContainText("port-is-41000", { timeout: 10000 });
  await expect(page.getByTestId("terminal")).toContainText("ceo/vega");
  await shot(page, "13-terminal");

  // Run script from project settings
  await page.getByTestId("insp-run").click();
  await page.getByRole("button", { name: "Project settings" }).click();
  await page.getByTestId("config-run").fill('echo "ready on http://localhost:$CEO_PORT"; sleep 20');
  await shot(page, "14-project-settings");
  await page.getByTestId("save-project").click();
  await expect(page.getByTestId("project-dialog")).toBeHidden();
  await page.getByTestId("run-script").click();
  await expect(page.getByTestId("script-log")).toContainText("ready on http://localhost:41000", { timeout: 8000 });
  await shot(page, "15-run");
  await page.getByRole("button", { name: "Stop", exact: true }).first().click();

  // Palette
  await page.evaluate(() => document.body.focus());
  await page.getByTestId("ws-menu").click();
  await press(page, "Escape");
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.items.find((i) => i.label === "View")!.submenu!.items.find((i) => i.label === "Command Palette")!.click(); });
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.getByTestId("palette-input").fill("spend");
  await shot(page, "16-palette");
  await press(page, "Enter");
  await expect(page.getByTestId("ledger-status")).toContainText("Intact", { timeout: 8000 });
  await shot(page, "17-spend");

  // The record shows this workspace's slice of the ledger
  await page.getByTestId("ws-vega").click();
  await page.getByTestId("insp-record").click();
  await expect(page.getByTestId("record")).toContainText("hash chain is intact");
  await expect(page.getByTestId("record")).toContainText("Run started: Plan a circuit breaker");
  await shot(page, "17b-record");

  // Back to the workspace, merge into main for real
  await page.getByTestId("insp-checks").click();
  await page.getByTestId("next-action-btn").click();
  await page.getByTestId("confirm").click();
  await expect(page.getByTestId("next-action")).toContainText("Archive", { timeout: 15000 });
  expect(readFileSync(path.join(repo, "src/retry.ts"), "utf8")).toContain("initialDelayMs");

  // Archive and restore, chat intact
  await page.getByTestId("next-action-btn").click();
  await expect(page.getByTestId("restore")).toBeVisible({ timeout: 10000 });
  await page.getByLabel(/^History/).click();
  await expect(page.getByTestId("history-vega")).toBeVisible();
  await shot(page, "18-history");
  await page.getByTestId("history-vega").getByRole("button", { name: "Restore" }).click();
  await expect(page.getByTestId("transcript")).toBeVisible({ timeout: 10000 });

  expect(errors).toEqual([]);
  await app.close();
});

test("race, plan, insights, light theme, and the license path", async () => {
  const l = await launch({ CEO_CLAUDE_BIN: DEMO, STUB_WRITE_FILE: "WIN", STUB_CHAT: "1", CEO_GEMINI_BIN: path.resolve(__dirname, "../../../tools/stub-gemini") });
  const { app, page } = l;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.getByTestId("onboarding")).toBeVisible({ timeout: 20000 });
  const repo = makeRepo(l.dir);
  await add(page, repo);
  await page.reload();
  await expect(page.getByTestId("home-new")).toBeVisible({ timeout: 15000 });

  // Race: codex alone writes WIN, so the check picks codex
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.items.find((i) => i.label === "File")!.submenu!.items.find((i) => i.label === "New Race")!.click(); });
  await expect(page.getByTestId("race-dialog")).toBeVisible();
  await page.getByTestId("race-prompt").fill("Fix the flaky retry test");
  await page.getByTestId("race-check").fill("test -f WIN");
  await shot(page, "20-race-dialog");
  await page.getByTestId("start-race").click();
  await expect(page.getByTestId("race-banner")).toBeVisible();
  await shot(page, "21-race-running");
  await expect(page.getByTestId("race-banner")).toContainText("Codex wins", { timeout: 30000 });
  await shot(page, "22-race-won");
  await page.getByTestId("keep-codex").click();
  await page.getByTestId("confirm").click();
  await expect(page.getByTestId("transcript")).toBeVisible({ timeout: 10000 });

  // Insights shows the result
  await page.getByLabel("Insights").click();
  await expect(page.locator(".insight").first()).toBeVisible({ timeout: 8000 });
  await shot(page, "23-insights");

  // Plan: a goal becomes workspaces
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.items.find((i) => i.label === "File")!.submenu!.items.find((i) => i.label === "Plan from a Goal")!.click(); });
  await page.getByTestId("plan-goal").fill("Add rate limiting to the public API");
  await page.getByTestId("draft-plan").click();
  await expect(page.getByTestId("plan-task")).toHaveCount(3, { timeout: 15000 });
  await shot(page, "24-plan-draft");
  await page.getByTestId("launch-plan").click();
  await expect(page.locator(".wsrow")).toHaveCount(4, { timeout: 15000 });
  await page.waitForTimeout(2500);
  await page.getByText("CEO", { exact: true }).first().click();
  await shot(page, "25-home-busy");

  // Light theme
  await page.getByLabel("Settings").click();
  await page.getByTestId("theme-light").click();
  await shot(page, "26-settings-light");
  await page.getByTestId("settings-providers").click();
  await shot(page, "27-settings-providers");
  await page.locator('[aria-label="Close"]').click();
  await page.getByTestId("ws-rigel").click();
  await shot(page, "28-workspace-light");
  await page.getByLabel("Settings").click();
  await page.getByTestId("theme-dark").click();
  await page.locator('[aria-label="Close"]').click();

  // License: a bad key is refused, a signed key activates
  await page.getByLabel("Settings").click();
  await page.getByTestId("settings-license").click();
  await shot(page, "29-license-trial");
  await page.getByTestId("license-key").fill("CEO1.bad.bad");
  await page.getByTestId("activate").click();
  await expect(page.getByTestId("toast").last()).toContainText(/not valid|could not/);
  const key = execFileSync("node", ["tools/license.mjs", "issue", "buyer@example.com"], { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" }).trim();
  await page.getByTestId("license-key").fill(key);
  await page.getByTestId("activate").click();
  await expect(page.getByText("Licensed to buyer@example.com")).toBeVisible();
  await shot(page, "30-license-pro");
  await page.locator('[aria-label="Close"]').click();
  await expect(page.getByTestId("plan-chip")).toHaveCount(0);

  expect(errors).toEqual([]);
  await app.close();
});

test("with no agent installed, onboarding offers the install command in a real terminal", async () => {
  const l = await launch({ CEO_CLAUDE_BIN: "/nonexistent/stub-claude", CEO_CODEX_BIN: "/nonexistent/stub-codex", CEO_GEMINI_BIN: "/nonexistent/stub-gemini" });
  const { page, app } = l;
  await expect(page.getByTestId("provider-claude")).toContainText("Not installed", { timeout: 20000 });
  await shot(page, "32-onboarding-none");
  await page.getByTestId("provider-claude").getByRole("button", { name: "Install" }).click();
  await expect(page.getByTestId("terminal")).toContainText("npm i -g @anthropic-ai/claude-code", { timeout: 10000 });
  await shot(page, "33-onboarding-terminal");
  await app.close();
});

test("after the trial, the free plan holds 3 workspaces and sends Pro features to the upgrade sheet", async () => {
  const l = await launch({ CEO_CLAUDE_BIN: DEMO });
  const { page, app } = l;
  await expect(page.getByTestId("onboarding")).toBeVisible({ timeout: 20000 });
  const repo = makeRepo(l.dir);
  await app.close();
  mkdirSync(path.join(l.home, "app"), { recursive: true });
  writeFileSync(path.join(l.home, "app/license.json"), JSON.stringify({ key: null, firstRunAt: Date.now() - 40 * 86400000 }));
  const again = await launch({ CEO_CLAUDE_BIN: DEMO }, { dir: l.dir, home: l.home });
  await expect(again.page.getByTestId("onboarding")).toBeVisible({ timeout: 20000 });
  await add(again.page, repo);
  await again.page.reload();
  await expect(again.page.getByTestId("plan-chip")).toContainText("Free plan", { timeout: 15000 });
  for (let i = 0; i < 3; i++) {
    await again.page.getByTestId("new-workspace").click();
    await again.page.getByTestId("create-workspace").click();
    await expect(again.page.locator(".wsrow")).toHaveCount(i + 1, { timeout: 10000 });
  }
  await again.page.getByTestId("new-workspace").click();
  await again.page.getByTestId("create-workspace").click();
  await expect(again.page.getByTestId("upgrade-dialog")).toContainText("free plan holds 3", { timeout: 8000 });
  await shot(again.page, "31-upgrade");
  await again.app.close();
});
