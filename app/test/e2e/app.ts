import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const APP = path.resolve(__dirname, "../..");
const TOOLS = path.resolve(APP, "../tools");

export type Launch = { app: ElectronApplication; page: Page; dir: string; repo: string; home: string };

export function makeRepo(dir: string, name = "orbit"): string {
  const repo = path.join(dir, name);
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "README.md"), "# Orbit\n\nA small retry library.\n");
  writeFileSync(path.join(repo, "src/retry.ts"), `export async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {\n  let last: unknown;\n  for (let i = 0; i < attempts; i++) {\n    try {\n      return await fn();\n    } catch (e) {\n      last = e;\n    }\n  }\n  throw last;\n}\n`);
  const g = (...a: string[]): void => void execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g("init", "-b", "main");
  g("config", "user.name", "Demo");
  g("config", "user.email", "demo@example.com");
  g("add", "-A");
  g("commit", "-m", "first");
  return realpathSync(repo);
}

export async function launch(env: Record<string, string> = {}, reuse?: { dir: string; home: string }): Promise<Launch> {
  const dir = reuse?.dir ?? realpathSync(mkdtempSync(path.join(os.tmpdir(), "ceo-e2e-")));
  const home = reuse?.home ?? path.join(dir, "home");
  const repo = path.join(dir, "orbit");
  // CEO_E2E_EXEC runs the same flows against a packaged build.
  const packaged = process.env.CEO_E2E_EXEC;
  const app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [...(packaged ? [] : [APP]), `--user-data-dir=${path.join(dir, "userdata")}`],
    env: {
      ...process.env as Record<string, string>,
      CEO_E2E: "1",
      // Off screen and never focused. CEO_E2E_SHOW=1 shows the window when watching a run.
      ...(process.env.CEO_E2E_SHOW ? {} : { CEO_E2E_HIDDEN: "1" }),
      CEO_HOME: home,
      CODEX_HOME: path.join(dir, "codex"),
      CEO_REQUIRE_STUBS: "1",
      CEO_CLAUDE_BIN: path.join(TOOLS, "stub-claude"),
      CEO_CODEX_BIN: path.join(TOOLS, "stub-codex"),
      CEO_GEMINI_BIN: path.join(TOOLS, "stub-gemini"),
      CEO_GH_BIN: path.join(TOOLS, "stub-gh"),
      STUB_DELAY_MS: "40",
      STUB_TURNS: "2",
      GIT_AUTHOR_NAME: "Demo", GIT_AUTHOR_EMAIL: "demo@example.com", GIT_COMMITTER_NAME: "Demo", GIT_COMMITTER_EMAIL: "demo@example.com",
      ...env,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page, dir, repo, home };
}
