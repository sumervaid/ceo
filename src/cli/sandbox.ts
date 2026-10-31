/**
 * `ceo sandbox`: which sandbox runs use, and whether the sandbox can start.
 *
 *   ceo sandbox        the configured kind, the image or host, and readiness
 *   ceo sandbox test   run `true` inside the sandbox and report the exit code
 */

import { spawn } from "node:child_process";

import {
  describeSandboxSpawnError,
  sandboxFor,
  sandboxHooks,
  sandboxInfo,
  sandboxReadiness,
  wrapPlan,
} from "../core/sandbox.js";

export function sandboxCmd(args: string[], cwd: string): void {
  const kind = sandboxFor();
  const info = sandboxInfo(kind);
  const ready = sandboxReadiness(kind);

  if (args[0] === "test") {
    void testSandbox(kind, cwd, ready.ready ? null : ready.reason);
    return;
  }

  const lines = [
    `sandbox   ${kind}${kind === "ssh" ? " (experimental)" : ""}`,
    ...(info?.image ? [`image     ${info.image}`] : []),
    ...(kind === "ssh" ? [`host      ${info?.host || "not set"}`] : []),
    `ready     ${ready.ready ? "yes" : "no"}, ${ready.reason}`,
    "",
    kind === "local"
      ? "Set CEO_SANDBOX=docker to run each agent in a container. See docs/sandboxes.md."
      : "Runs in a sandbox get no org tools. See docs/sandboxes.md.",
    "",
  ];
  process.stdout.write(lines.join("\n"));
  if (!ready.ready) process.exitCode = 1;
}

async function testSandbox(kind: ReturnType<typeof sandboxFor>, cwd: string, notReady: string | null): Promise<void> {
  if (notReady) {
    process.stderr.write(`The ${kind} sandbox is not ready: ${notReady}\n`);
    process.exitCode = 1;
    return;
  }
  const ctx = { kind, workdir: cwd, provider: "claude" as const, runId: `test-${Date.now().toString(36)}`, env: process.env, command: "true" };
  const plan = wrapPlan({ binary: "true", args: [], stdin: null, enforcement: [] }, ctx);
  const hooks = sandboxHooks(ctx);
  const setup = await hooks.before();
  if (setup) {
    process.stderr.write(`${setup}\n`);
    process.exitCode = 1;
    return;
  }
  const code = await new Promise<number | null>((resolve) => {
    const p = spawn(plan.binary, plan.args, { cwd, stdio: "inherit" });
    p.on("error", (e: NodeJS.ErrnoException) => {
      process.stderr.write(`${describeSandboxSpawnError(kind, plan.binary, e)}\n`);
      resolve(null);
    });
    p.on("close", resolve);
  });
  const teardown = await hooks.after();
  if (teardown) process.stderr.write(`${teardown}\n`);
  process.stdout.write(`true exited ${code === null ? "without starting" : code} in the ${kind} sandbox.\n`);
  if (code !== 0 || teardown) process.exitCode = 1;
}
