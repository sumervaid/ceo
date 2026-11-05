import { expect, test } from "@playwright/test";
import { launch, makeRepo } from "./app";

test("launches into onboarding with no project", async () => {
  const { app, page, dir } = await launch();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.getByTestId("onboarding")).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: "test-results/shots/01-onboarding.png" });
  expect(errors).toEqual([]);
  makeRepo(dir);
  await app.close();
});
