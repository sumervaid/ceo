/**
 * Sandboxes against the stubs. tools/stub-docker stands in for docker: it
 * checks the flags a run needs, records them, and runs the inner command on
 * this machine. No container starts and no model is called.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { initLedger, readLedger, verify } from "./ledger.js";
import { hire } from "./roster.js";
import { runDelegation, type RunEvent } from "./runner.js";
import { tracePath } from "./collab.js";
import {
  containerName,
  sandboxFor,
  sandboxHooks,
  sandboxReadiness,
  wrapPlan,
  type SandboxContext,
} from "./sandbox.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.resolve(HERE, "..", "..", "tools");
const STUB_DOCKER = path.join(TOOLS, "stub-docker");

process.env.CEO_CLAUDE_BIN = path.join(TOOLS, "stub-claude");
process.env.CEO_CODEX_BIN = path.join(TOOLS, "stub-codex");
process.env.CEO_GEMINI_BIN = path.join(TOOLS, "stub-gemini");
process.env.STUB_DELAY_MS = "20";
process.env.CEO_REQUIRE_STUBS = "1";
process.env.CLAUDE_CODE_OAUTH_TOKEN = "stub-token";
process.env.STUB_CODEX_LOGIN = "chatgpt";
process.env.STUB_GEMINI_LOGIN = "ok";
process.env.CODEX_HOME = mkdtempSync(path.join(tmpdir(), "ceo-codex-home-"));

function tmp(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function freshOrg(): string {
  const dir = tmp("ceo-sandbox-");
  initLedger(dir);
  hire({ name: "coder", role: "Implement what the queue asks for.", budgetUsd: 1, autonomy: "execute" }, dir);
  return dir;
}

/** Run a body with environment variables set, then restore them. */
async function withEnv(vars: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function readLog(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function until(test: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return test();
}

test("sandboxFor prefers the run option, then CEO_SANDBOX, and falls back to local", () => {
  assert.equal(sandboxFor({}, {}), "local");
  assert.equal(sandboxFor({}, { CEO_SANDBOX: "docker" }), "docker");
  assert.equal(sandboxFor({ sandbox: "ssh" }, { CEO_SANDBOX: "docker" }), "ssh");
  assert.equal(sandboxFor({}, { CEO_SANDBOX: "podman" }), "local");
  assert.equal(sandboxFor({ sandbox: null }, { CEO_SANDBOX: "DOCKER" }), "docker");
});

test("wrapPlan for docker mounts the worktree, removes the container, and passes only allowlisted auth", () => {
  const home = tmp("ceo-home-");
  mkdirSync(path.join(home, ".claude"));
  writeFileSync(path.join(home, ".claude.json"), "{}");
  const workdir = tmp("ceo-work-");
  try {
    const ctx: SandboxContext = {
      kind: "docker",
      workdir,
      provider: "claude",
      runId: "abc123",
      env: {
        HOME: home,
        ANTHROPIC_API_KEY: "sk-test",
        UNRELATED_SECRET: "nope",
        CEO_SANDBOX_IMAGE: "ceo-agent:test",
        CEO_SANDBOX_NETWORK: "none",
      },
    };
    const plan = { binary: "claude", args: ["-p", "do the thing", "--model", "m"], stdin: null, enforcement: ["Read"], env: { EXTRA: "1" } };
    const wrapped = wrapPlan(plan, ctx);

    assert.equal(wrapped.binary, "docker");
    assert.equal(wrapped.stdin, null);
    assert.deepEqual(wrapped.args, [
      "run", "--rm", "-i",
      "--name", "ceo-abc123",
      "--network", "none",
      "-v", `${workdir}:/work`,
      "-w", "/work",
      "-e", "EXTRA=1",
      "-e", "ANTHROPIC_API_KEY=sk-test",
      "-v", `${path.join(home, ".claude")}:/root/.claude:ro`,
      "-v", `${path.join(home, ".claude.json")}:/root/.claude.json:ro`,
      "ceo-agent:test",
      "claude",
      "-p", "do the thing", "--model", "m",
    ]);
    assert.ok(!wrapped.args.some((a) => a.includes("UNRELATED_SECRET")));

    const codex = wrapPlan({ ...plan, binary: "codex", stdin: "task" }, { ...ctx, provider: "codex", env: { ...ctx.env, CODEX_HOME: home } });
    assert.equal(codex.stdin, "task");
    assert.ok(codex.args.includes(`${home}:/root/.codex:ro`));
    assert.equal(codex.args[codex.args.indexOf("ceo-agent:test") + 1], "codex");

    const gemini = wrapPlan(plan, { ...ctx, provider: "gemini", env: { ...ctx.env, CEO_SANDBOX_GEMINI_BIN: "agy-custom" } });
    assert.equal(gemini.args[gemini.args.indexOf("ceo-agent:test") + 1], "agy-custom");
    assert.ok(!gemini.args.some((a) => a.endsWith(":ro")), "no auth directory exists for gemini here");

    assert.equal(wrapPlan(plan, { ...ctx, kind: "local" }), plan);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("wrapPlan for ssh runs one quoted command in the remote directory", () => {
  const wrapped = wrapPlan(
    { binary: "claude", args: ["-p", "it's a task"], stdin: null, enforcement: [] },
    { kind: "ssh", workdir: "/tmp/w", provider: "claude", runId: "r1", env: { CEO_SANDBOX_HOST: "ci@box", CEO_SANDBOX_REMOTE_DIR: "/scratch" } },
  );
  assert.equal(wrapped.binary, "ssh");
  assert.deepEqual(wrapped.args.slice(0, 2), ["ci@box", "--"]);
  assert.equal(wrapped.args[2], `cd '/scratch/ceo-r1' && 'claude' '-p' 'it'\\''s a task'`);
});

test("the ssh hooks sync out, sync back, and remove the remote copy", async () => {
  const bin = tmp("ceo-bin-");
  const workdir = tmp("ceo-work-");
  const log = path.join(bin, "calls.log");
  try {
    for (const name of ["stub-ssh", "stub-rsync"]) {
      writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\n`);
      chmodSync(path.join(bin, name), 0o755);
    }
    const ctx: SandboxContext = {
      kind: "ssh",
      workdir,
      provider: "claude",
      runId: "r2",
      env: { CEO_SANDBOX_HOST: "ci@box", CEO_SSH_BIN: path.join(bin, "stub-ssh"), CEO_RSYNC_BIN: path.join(bin, "stub-rsync") },
    };
    const hooks = sandboxHooks(ctx);
    assert.equal(await hooks.before(), null);
    assert.equal(await hooks.after(), null);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(calls, [
      "stub-ssh ci@box -- mkdir -p '/tmp/ceo-r2'",
      `stub-rsync -a --delete ${workdir}/ ci@box:/tmp/ceo-r2/`,
      `stub-rsync -a --delete ci@box:/tmp/ceo-r2/ ${workdir}/`,
      "stub-ssh ci@box -- rm -rf '/tmp/ceo-r2'",
    ]);
    assert.match((await sandboxHooks({ ...ctx, env: {} }).before()) ?? "", /CEO_SANDBOX_HOST is not set/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("readiness checks the daemon and the image", async () => {
  const env = { CEO_DOCKER_BIN: STUB_DOCKER, CEO_SANDBOX_IMAGE: "ceo-agent:test" };
  assert.equal(sandboxReadiness("local").ready, true);
  assert.equal(sandboxReadiness("docker", env).ready, true);
  const noImage = sandboxReadiness("docker", { ...env, STUB_DOCKER_NO_IMAGE: "1" });
  assert.equal(noImage.ready, false);
  assert.match(noImage.reason, /ceo-agent:test is not present/);
  const down = sandboxReadiness("docker", { ...env, STUB_DOCKER_DOWN: "1" });
  assert.equal(down.ready, false);
  assert.match(down.reason, /docker is not available/);
  assert.equal(sandboxReadiness("ssh", {}).ready, false);
  assert.equal(sandboxReadiness("ssh", { CEO_SANDBOX_HOST: "ci@box" }).ready, true);
});

test("a run in the docker sandbox completes, is recorded, and gets no org tools", async () => {
  const dir = freshOrg();
  const logFile = path.join(dir, "docker.log");
  try {
    await withEnv(
      { CEO_SANDBOX: "docker", CEO_DOCKER_BIN: STUB_DOCKER, CEO_SANDBOX_IMAGE: "ceo-test:1", STUB_DOCKER_LOG: logFile },
      async () => {
        const events: RunEvent[] = [];
        const result = await runDelegation("coder", "add the changelog", { cwd: dir, onEvent: (e) => events.push(e) }).finished;
        assert.equal(result.ok, true, result.error ?? "");
        assert.match(result.text, /Done: add the changelog/);

        const started = events.find((e) => e.type === "started");
        assert.ok(started && started.type === "started");
        assert.ok(!started.tools.some((t) => t.startsWith("org tools")), "no org tools in the enforcement list");

        const entries = readLedger(dir);
        const start = entries.find((e) => e.type === "delegate_start")!;
        assert.deepEqual(start.data.sandbox, { kind: "docker", image: "ceo-test:1" });
        assert.ok(!(start.data.enforcement as string[]).some((t) => t.startsWith("org tools")));
        const id = String(start.data.id);

        const meta = readFileSync(tracePath(id, dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === "meta");
        assert.deepEqual(meta.sandbox, { kind: "docker", image: "ceo-test:1" });

        const records = readLog(logFile);
        const run = records.find((r) => r.cmd === "run")!;
        assert.ok(run, "docker run was called");
        assert.equal(run.rm, true);
        assert.equal(run.name, containerName(id));
        assert.equal(run.image, "ceo-test:1");
        assert.ok((run.mounts as string[]).includes(`${started.cwd}:/work`));
        assert.equal(run.workdir, "/work");
        const command = run.command as string[];
        assert.equal(command[0], "claude");
        assert.ok(!command.includes("--mcp-config"), "no org MCP server was passed");
        assert.ok(!command.some((a) => a.includes("mcp__org__")), "no org tool was allowed");
        const prompt = command[command.indexOf("--append-system-prompt") + 1];
        assert.ok(!/org_post|org_roster/.test(prompt), "the compiled prompt does not promise org tools");
        assert.equal(verify(dir).ok, true);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a local run records no sandbox", async () => {
  const dir = freshOrg();
  try {
    await withEnv({ CEO_SANDBOX: undefined }, async () => {
      const result = await runDelegation("coder", "add the changelog", { cwd: dir }).finished;
      assert.equal(result.ok, true, result.error ?? "");
      const start = readLedger(dir).find((e) => e.type === "delegate_start")!;
      assert.ok(!("sandbox" in start.data));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelling a docker run removes the container", async () => {
  const dir = freshOrg();
  const logFile = path.join(dir, "docker.log");
  try {
    await withEnv(
      { CEO_DOCKER_BIN: STUB_DOCKER, STUB_DOCKER_LOG: logFile, STUB_DELAY_MS: "800" },
      async () => {
        let begun: () => void = () => {};
        const started = new Promise<void>((r) => (begun = r));
        const handle = runDelegation("coder", "a long task", {
          cwd: dir,
          sandbox: "docker",
          onEvent: (e) => {
            if (e.type === "text") begun();
          },
        });
        // The first text event means the stub's process is running.
        await Promise.race([started, new Promise((r) => setTimeout(r, 4000))]);
        handle.cancel();
        const result = await handle.finished;
        assert.equal(result.error, "cancelled");
        const id = result.delegationId!;
        assert.ok(await until(() => readLog(logFile).some((r) => r.cmd === "rm")), "docker rm was called");
        const rm = readLog(logFile).find((r) => r.cmd === "rm")!;
        assert.equal(rm.force, true);
        assert.equal(rm.name, containerName(id));
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sandbox that is not ready refuses before the ledger is touched", async () => {
  const dir = freshOrg();
  try {
    await withEnv(
      { CEO_DOCKER_BIN: STUB_DOCKER, STUB_DOCKER_NO_IMAGE: "1" },
      async () => {
        const result = await runDelegation("coder", "add the changelog", { cwd: dir, sandbox: "docker" }).finished;
        assert.equal(result.ok, false);
        assert.match(result.error ?? "", /docker sandbox is not ready/);
        assert.ok(!readLedger(dir).some((e) => e.type === "delegate_start"));
      },
    );
    await withEnv({ CEO_DOCKER_BIN: "docker" }, async () => {
      const result = await runDelegation("coder", "add the changelog", { cwd: dir, sandbox: "docker" }).finished;
      assert.match(result.error ?? "", /CEO_REQUIRE_STUBS is set and the docker sandbox would run docker/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
