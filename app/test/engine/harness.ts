import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { EngineEvent, Method, ParamsOf, ResultOf } from "../../src/shared/api";
import { createEngine } from "../../src/engine/engine";

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tools");

export function fixtureRepo(dir: string, name = "orbit"): string {
  const repo = path.join(dir, name);
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "README.md"), "# Orbit\n");
  writeFileSync(path.join(repo, "src", "retry.ts"), "export const retry = 1;\n");
  const g = (...a: string[]): void => void execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g("init", "-b", "main");
  g("add", "-A");
  g("-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-m", "first");
  g("config", "user.name", "Test");
  g("config", "user.email", "t@t");
  return realpathSync(repo);
}

export function harness(env: Record<string, string> = {}): {
  dir: string;
  events: EngineEvent[];
  call<M extends Method>(m: M, p: ParamsOf<M>): Promise<Awaited<ResultOf<M>>>;
  until(test: () => boolean | Promise<boolean>, ms?: number): Promise<void>;
  close(): void;
} {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ceo-engine-")));
  Object.assign(process.env, {
    CEO_HOME: path.join(dir, "home"),
    CODEX_HOME: path.join(dir, "codex"),
    CEO_REQUIRE_STUBS: "1",
    CEO_CLAUDE_BIN: path.join(TOOLS, "stub-claude"),
    CEO_CODEX_BIN: path.join(TOOLS, "stub-codex"),
    CEO_GEMINI_BIN: path.join(TOOLS, "stub-gemini"),
    CEO_GH_BIN: path.join(TOOLS, "stub-gh"),
    CEO_COLLAB_ENTRY: path.resolve(TOOLS, "../dist/mcp/collab-index.js"),
    STUB_DELAY_MS: "5",
    STUB_TURNS: "2",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@t",
    ...env,
  });
  const events: EngineEvent[] = [];
  const { handlers, dispose } = createEngine((e) => events.push(e));
  return {
    dir,
    events,
    call: async (m, p) => (await (handlers[m] as (x: unknown) => unknown)(p)) as never,
    until: async (test, ms = 15000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await test()) return;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error("timed out");
    },
    close: dispose,
  };
}
