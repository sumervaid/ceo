import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { launch, makeRepo } from "./app";

const shot = async (page: Page, name: string): Promise<void> => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `test-results/shots/${name}.png` });
};
const add = (page: Page, p: string) => page.evaluate((x) => (window as unknown as { ceo: { call: (m: string, p: unknown) => Promise<unknown> } }).ceo.call("addProject", { path: x }), p);

test("the team: chief of staff hires and delegates, work streams live, a checked task asks to merge", async () => {
  const scriptDir = path.join(process.env.TMPDIR ?? "/tmp");
  const script = path.join(scriptDir, `e2e-chief-${process.pid}.json`);
  writeFileSync(script, JSON.stringify([
    {
      match: "tests for the retry",
      calls: [
        { tool: "org_hire", args: { name: "tester", brief: "Writes focused unit tests for one module and reports coverage.", provider: "claude", budgetUsd: 3, level: "execute" } },
        { tool: "org_hire", args: { name: "reviewer", brief: "Reviews each change for correctness and missing cases.", provider: "codex", budgetUsd: 2, level: "observe", isolated: false } },
        { tool: "org_delegate", args: { agent: "tester", task: "Add unit tests for retry: success, retries, and the final throw." } },
      ],
      reply: "Hired **tester** on Claude and **reviewer** on Codex.\n\ntester is writing the retry tests now. The most this can cost is $5.",
    },
  ]));
  const l = await launch({ STUB_CHAT: script, STUB_DELAY_MS: "60" });
  const { app, page } = l;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.getByTestId("onboarding")).toBeVisible({ timeout: 20000 });
  const repo = makeRepo(l.dir);
  await add(page, repo);
  await page.reload();
  await expect(page.getByTestId("team-orbit")).toBeVisible({ timeout: 15000 });

  // The team row opens the chief of staff's introduction.
  await page.getByTestId("team-orbit").click();
  await page.getByTestId("org-tab-chief").click();
  await expect(page.getByTestId("chief-hero")).toBeVisible();
  await shot(page, "20-chief-hero");
  await page.getByTestId("hire-chief").click();
  await expect(page.getByTestId("chief-input")).toBeVisible({ timeout: 10000 });
  await shot(page, "21-chief-empty");

  // One message staffs the work. The delegated task starts when the reply ends.
  await page.getByTestId("chief-input").fill("Please add tests for the retry helper");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("chief-transcript")).toContainText("tester is writing the retry tests", { timeout: 20000 });
  await expect(page.getByTestId("chief-action-hire")).toHaveCount(2);
  await expect(page.getByTestId("chief-input")).toHaveValue("");
  await expect(page.getByTestId("chief-action-delegate")).toBeVisible();
  await shot(page, "22-chief-reply");

  // The work streams on the Live tab.
  await page.getByTestId("org-tab-live").click();
  await expect(page.getByTestId("run-tester")).toBeVisible({ timeout: 15000 });
  await shot(page, "23-live");
  await expect(page.getByTestId("run-tester")).toContainText("Done", { timeout: 20000 });

  // The team, with the agents the chief hired.
  await page.getByTestId("org-tab-team").click();
  await expect(page.getByTestId("agent-tester")).toBeVisible();
  await expect(page.getByTestId("agent-reviewer")).toBeVisible();
  await shot(page, "24-team");
  await page.getByTestId("agent-tester").click();
  await expect(page.getByTestId("agent-drawer")).toContainText("Add unit tests for retry", { timeout: 10000 });
  await shot(page, "25-agent-drawer");

  // Hire by hand.
  await page.getByTestId("org-hire").click();
  await expect(page.getByTestId("hire-dialog")).toBeVisible();
  await page.getByTestId("agent-name").fill("docs");
  await page.getByTestId("agent-role").fill("Keeps the README accurate. Writes short, plain sections.");
  await shot(page, "26-hire");
  await page.getByTestId("hire-submit").click();
  await expect(page.getByTestId("agent-docs")).toBeVisible({ timeout: 10000 });

  // A task with a check runs as a verified attempt, then asks before merging.
  await page.getByTestId("org-tab-tasks").click();
  await page.getByTestId("org-new-task").click();
  await page.getByTestId("task-title").fill("Document the retry options in the README");
  await page.getByTestId("task-assignee").locator("button").first().click();
  await page.getByRole("menuitem", { name: /docs/ }).click();
  await page.getByTestId("task-checks").fill("true");
  await shot(page, "27-new-task");
  await page.getByTestId("task-start").click();
  await page.getByTestId("org-tab-approvals").click();
  await expect(page.getByTestId("approve")).toBeVisible({ timeout: 30000 });
  await shot(page, "28-approval");
  await page.getByTestId("approve").click();
  await expect(page.getByTestId("approve")).toHaveCount(0, { timeout: 10000 });
  expect(readFileSync(path.join(repo, ".ceo/ledger.jsonl"), "utf8")).toContain('"decision":"approved"');

  await page.getByTestId("org-tab-tasks").click();
  await expect(page.locator(".column").nth(2)).toContainText("Document the retry options");
  await shot(page, "29-tasks");

  // The map draws the team around the chief.
  await page.getByTestId("org-tab-map").click();
  await expect(page.getByTestId("map-tester")).toBeVisible();
  await shot(page, "30-map");

  // Mission and docket.
  await page.getByTestId("org-tab-mission").click();
  await page.getByTestId("mission-objective").fill("Ship a retry helper that never loops forever and is fully tested.");
  await page.getByTestId("mission-save").click();
  await page.getByTestId("org-tab-docket").click();
  await page.getByTestId("docket-input").fill("README.md");
  await page.keyboard.press("Enter");
  await expect(page.locator(".dock")).toHaveCount(1, { timeout: 10000 });
  await shot(page, "31-docket");

  // The palette and the Team menu reach the team.
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.items.find((i) => i.label === "View")!.submenu!.items.find((i) => i.label === "Command Palette")!.click(); });
  await page.getByTestId("palette-input").fill("chief");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("chief-transcript")).toBeVisible();
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.items.find((i) => i.label === "Team")!.submenu!.items.find((i) => i.label === "Hire an Agent")!.click(); });
  await expect(page.getByTestId("hire-dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  // Dark theme.
  await page.evaluate(() => (window as unknown as { ceo: { call: (m: string, p: unknown) => Promise<unknown> } }).ceo.call("saveSettings", { theme: "dark" }));
  await page.reload();
  await expect(page.getByTestId("org-page")).toBeVisible({ timeout: 15000 });
  await page.getByTestId("org-tab-chief").click();
  await shot(page, "32-chief-dark");
  await page.getByTestId("org-tab-team").click();
  await shot(page, "33-team-dark");

  expect(errors).toEqual([]);
  await app.close();
});
