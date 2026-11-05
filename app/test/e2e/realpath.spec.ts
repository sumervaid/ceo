import { expect, test } from "@playwright/test";
import { _electron as electron } from "@playwright/test";
import { mkdtempSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// A Finder launch starts with almost no PATH. The app has to find the CLIs through the login shell.
// This only asks each CLI for --version and its login status. CEO_REQUIRE_STUBS refuses any run.
test("launched with the bare PATH Finder gives, the app still finds the CLIs on the login shell's PATH", async () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ceo-path-")));
  const env: Record<string, string> = { HOME: process.env.HOME!, SHELL: process.env.SHELL ?? "/bin/zsh", PATH: "/usr/bin:/bin", CEO_E2E: "1", CEO_HOME: path.join(dir, "home"), CEO_REQUIRE_STUBS: "1" };
  const packaged = process.env.CEO_E2E_EXEC;
  const app = await electron.launch({ ...(packaged ? { executablePath: packaged } : {}), args: [...(packaged ? [] : [path.resolve(__dirname, "../..")]), `--user-data-dir=${path.join(dir, "ud")}`], env });
  const page = await app.firstWindow();
  await expect(page.getByTestId("onboarding")).toBeVisible({ timeout: 30000 });
  const r = (await page.evaluate(() => (window as unknown as { ceo: { call: (m: string, p: unknown) => Promise<unknown> } }).ceo.call("readiness", {}))) as Array<{ provider: string; installed: boolean; ready: boolean; metered: boolean; version: string | null; binary: string; account: string; isStub: boolean }>;
  console.log(JSON.stringify(r.map((x) => ({ p: x.provider, installed: x.installed, ready: x.ready, metered: x.metered, version: x.version, stub: x.isStub }))));
  expect(r.find((x) => x.provider === "claude")!.installed).toBe(true);
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/shots/34-real-providers.png" });
  await app.close();
});
