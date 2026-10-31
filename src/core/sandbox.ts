/**
 * Where an agent's process runs: on this machine, in a container, or on a
 * remote machine.
 *
 * The runner builds one RunPlan per turn. A sandbox does not change what
 * the plan means. A sandbox changes where the plan executes. `wrapPlan`
 * turns the plan into a launcher command that starts the original command
 * inside the sandbox. Stdout and stderr stream back unchanged. Stdin passes
 * through. The trace reads the same as for a local run.
 *
 *   local    the process runs here. Nothing is wrapped.
 *   docker   `docker run --rm` starts a container per run, with the
 *            worktree mounted at /work. The container is discarded when the
 *            process exits. The image must contain the agent CLIs.
 *   ssh      experimental. The worktree is synced to a temporary directory
 *            on a remote host with rsync, the command runs there over ssh,
 *            the directory is synced back, then the remote copy is removed.
 *
 * Autonomy is still enforced by the child process. The sandbox adds a
 * boundary around that process. The flags stay.
 *
 * The org MCP server runs on the host and reads the host ledger. A
 * sandboxed process cannot reach the host ledger. A sandboxed run therefore
 * gets no org tools. The runner leaves the tools out of the compiled prompt
 * as well.
 *
 * Settings, all environment variables:
 *
 *   CEO_SANDBOX                 local by default, docker or ssh
 *   CEO_SANDBOX_IMAGE           docker image, default ceo-agent:latest
 *   CEO_SANDBOX_NETWORK         docker network, default bridge
 *   CEO_DOCKER_BIN              docker binary, default docker
 *   CEO_SANDBOX_<PROVIDER>_BIN  the CLI's name inside the sandbox, such as
 *                               CEO_SANDBOX_CLAUDE_BIN. Defaults to the
 *                               plain name: claude, codex or agy.
 *   CEO_SANDBOX_HOST            ssh destination, such as ci@build-box
 *   CEO_SANDBOX_REMOTE_DIR      parent of the remote directory, default /tmp
 *   CEO_SSH_BIN                 ssh binary, default ssh
 *   CEO_RSYNC_BIN               rsync binary, default rsync
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

import type { RunPlan } from "./providers.js";
import type { Provider } from "./types.js";

export type SandboxKind = "local" | "docker" | "ssh";

export const SANDBOX_KINDS: readonly SandboxKind[] = ["local", "docker", "ssh"];

export function isSandboxKind(v: unknown): v is SandboxKind {
  return typeof v === "string" && (SANDBOX_KINDS as readonly string[]).includes(v);
}

/** A plan that may carry extra environment for the sandboxed process. */
export type SandboxPlan = RunPlan & { env?: Record<string, string> };

export type SandboxContext = {
  kind: SandboxKind;
  /** The host directory the process works in. */
  workdir: string;
  provider: Provider;
  /** The delegation id. Names the container and the remote directory. */
  runId: string;
  env: NodeJS.ProcessEnv;
  /** The command to run inside the sandbox instead of the provider's CLI. For `ceo sandbox test`. */
  command?: string;
};

/**
 * Variables forwarded into a container when set on the host. Credentials
 * and endpoints only. Nothing else of the host's environment crosses.
 */
export const AUTH_ENV_ALLOWLIST: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
];

const PLAIN_NAME: Record<Provider, string> = { claude: "claude", codex: "codex", gemini: "agy" };

function setting(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const v = env[name];
  return v && v.trim() ? v.trim() : fallback;
}

/**
 * The sandbox for a run. The per-run option wins. Otherwise CEO_SANDBOX
 * decides. An unknown value means local rather than a surprise.
 */
export function sandboxFor(opts: { sandbox?: SandboxKind | null } = {}, env: NodeJS.ProcessEnv = process.env): SandboxKind {
  if (isSandboxKind(opts.sandbox)) return opts.sandbox;
  const v = env.CEO_SANDBOX?.trim().toLowerCase();
  return isSandboxKind(v) ? v : "local";
}

export function dockerBinary(env: NodeJS.ProcessEnv = process.env): string {
  return setting(env, "CEO_DOCKER_BIN", "docker");
}

export function sandboxImage(env: NodeJS.ProcessEnv = process.env): string {
  return setting(env, "CEO_SANDBOX_IMAGE", "ceo-agent:latest");
}

function sshBinary(env: NodeJS.ProcessEnv): string {
  return setting(env, "CEO_SSH_BIN", "ssh");
}

function rsyncBinary(env: NodeJS.ProcessEnv): string {
  return setting(env, "CEO_RSYNC_BIN", "rsync");
}

function sandboxHost(env: NodeJS.ProcessEnv): string {
  return setting(env, "CEO_SANDBOX_HOST", "");
}

/** What the ledger records about a sandboxed run. Null for a local run. */
export function sandboxInfo(kind: SandboxKind, env: NodeJS.ProcessEnv = process.env): { kind: SandboxKind; image?: string; host?: string } | null {
  if (kind === "docker") return { kind, image: sandboxImage(env) };
  if (kind === "ssh") return { kind, host: sandboxHost(env) };
  return null;
}

/** The container name for a run, safe for docker's name rules. */
export function containerName(runId: string): string {
  return `ceo-${runId.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
}

/** The remote directory for a run. */
export function remoteDirFor(runId: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = setting(env, "CEO_SANDBOX_REMOTE_DIR", "/tmp").replace(/\/+$/, "") || "/tmp";
  return `${base}/${containerName(runId)}`;
}

/** The CLI's name inside the sandbox. */
export function innerBinary(provider: Provider, env: NodeJS.ProcessEnv = process.env): string {
  return setting(env, `CEO_SANDBOX_${provider.toUpperCase()}_BIN`, PLAIN_NAME[provider]);
}

/** One argument, quoted for a POSIX shell. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The auth and config directories a provider's CLI reads, as host path and
 * container path pairs. Only paths that exist are returned.
 */
export function authMounts(provider: Provider, env: NodeJS.ProcessEnv = process.env): Array<{ host: string; container: string }> {
  const home = env.HOME?.trim() || homedir();
  const candidates: Array<{ host: string; container: string }> =
    provider === "claude"
      ? [
          { host: path.join(home, ".claude"), container: "/root/.claude" },
          { host: path.join(home, ".claude.json"), container: "/root/.claude.json" },
        ]
      : provider === "codex"
        ? [{ host: env.CODEX_HOME?.trim() || path.join(home, ".codex"), container: "/root/.codex" }]
        : [{ host: path.join(home, ".gemini"), container: "/root/.gemini" }];
  return candidates.filter((m) => existsSync(m.host));
}

/**
 * The plan, rewritten to run inside the sandbox. A local plan comes back
 * unchanged.
 */
export function wrapPlan(plan: SandboxPlan, ctx: SandboxContext): RunPlan {
  if (ctx.kind === "local") return plan;
  const inner = ctx.command ?? innerBinary(ctx.provider, ctx.env);
  const workdir = path.resolve(ctx.workdir);

  if (ctx.kind === "docker") {
    const env: string[] = [];
    for (const [k, v] of Object.entries(plan.env ?? {})) env.push("-e", `${k}=${v}`);
    for (const k of AUTH_ENV_ALLOWLIST) {
      const v = ctx.env[k];
      if (v !== undefined && v !== "" && !(plan.env && k in plan.env)) env.push("-e", `${k}=${v}`);
    }
    const mounts = authMounts(ctx.provider, ctx.env).flatMap((m) => ["-v", `${m.host}:${m.container}:ro`]);
    return {
      ...plan,
      binary: dockerBinary(ctx.env),
      args: [
        "run", "--rm", "-i",
        "--name", containerName(ctx.runId),
        "--network", setting(ctx.env, "CEO_SANDBOX_NETWORK", "bridge"),
        "-v", `${workdir}:/work`,
        "-w", "/work",
        ...env,
        ...mounts,
        sandboxImage(ctx.env),
        inner,
        ...plan.args,
      ],
    };
  }

  // ssh. One remote command string, so every argument is quoted. Only the
  // plan's own environment is sent. A secret in a remote command line is
  // visible to other users of that machine. The remote host keeps the
  // sign-in instead.
  const remoteEnv = Object.entries(plan.env ?? {}).map(([k, v]) => `${k}=${shellQuote(v)}`);
  const command = [
    `cd ${shellQuote(remoteDirFor(ctx.runId, ctx.env))}`,
    "&&",
    ...(remoteEnv.length > 0 ? ["env", ...remoteEnv] : []),
    shellQuote(inner),
    ...plan.args.map(shellQuote),
  ].join(" ");
  return { ...plan, binary: sshBinary(ctx.env), args: [sandboxHost(ctx.env), "--", command] };
}

// ---------------------------------------------------------------------------
// Hooks the runner calls around a run
// ---------------------------------------------------------------------------

export type SandboxHooks = {
  /** Before the first turn. Resolves to an error sentence, or null. */
  before: () => Promise<string | null>;
  /** After the last turn, whatever happened. Resolves to an error sentence, or null. */
  after: () => Promise<string | null>;
  /** Best-effort removal of the sandbox, for a cancelled run. */
  cancel: () => void;
};

function runCommand(bin: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    try {
      const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
      p.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
      p.on("error", (e) => resolve({ code: null, stderr: e.message }));
      p.on("close", (code) => resolve({ code, stderr }));
    } catch (e) {
      resolve({ code: null, stderr: e instanceof Error ? e.message : String(e) });
    }
  });
}

/**
 * Hooks for one run. Docker needs no sync, only a cleanup on cancel. The
 * ssh hooks copy the worktree out before the first turn and back after the
 * last, then delete the remote copy. The copy back uses --delete. The
 * worktree ends up matching the remote directory exactly.
 */
export function sandboxHooks(ctx: SandboxContext): SandboxHooks {
  const none: SandboxHooks = { before: async () => null, after: async () => null, cancel: () => {} };
  if (ctx.kind === "local") return none;

  if (ctx.kind === "docker") {
    return {
      ...none,
      cancel: () => {
        // Best effort. A container that already exited is not an error.
        try {
          const p = spawn(dockerBinary(ctx.env), ["rm", "-f", containerName(ctx.runId)], { stdio: "ignore", detached: true });
          p.on("error", () => {});
          p.unref();
        } catch {
          /* --rm removes the container when the process ends */
        }
      },
    };
  }

  const host = sandboxHost(ctx.env);
  const remote = remoteDirFor(ctx.runId, ctx.env);
  const local = `${path.resolve(ctx.workdir)}/`;
  const ssh = sshBinary(ctx.env);
  const rsync = rsyncBinary(ctx.env);
  let pushed = false;
  return {
    before: async () => {
      if (!host) return "CEO_SANDBOX_HOST is not set.";
      const mk = await runCommand(ssh, [host, "--", `mkdir -p ${shellQuote(remote)}`]);
      if (mk.code !== 0) return `ssh sandbox: could not create ${remote} on ${host}: ${mk.stderr.trim().slice(0, 200)}`;
      const push = await runCommand(rsync, ["-a", "--delete", local, `${host}:${remote}/`]);
      if (push.code !== 0) return `ssh sandbox: rsync to ${host} failed: ${push.stderr.trim().slice(0, 200)}`;
      pushed = true;
      return null;
    },
    after: async () => {
      if (!host || !pushed) return null;
      const pull = await runCommand(rsync, ["-a", "--delete", `${host}:${remote}/`, local]);
      // The remote copy is removed even when the copy back failed.
      await runCommand(ssh, [host, "--", `rm -rf ${shellQuote(remote)}`]);
      return pull.code === 0 ? null : `ssh sandbox: rsync back from ${host} failed: ${pull.stderr.trim().slice(0, 200)}`;
    },
    cancel: () => {},
  };
}

/** The sentence for a launcher that could not start. */
export function describeSandboxSpawnError(kind: SandboxKind, binary: string, e: NodeJS.ErrnoException): string {
  if (e.code === "ENOENT") {
    const fix = kind === "docker" ? "Install docker or set CEO_DOCKER_BIN." : "Install ssh or set CEO_SSH_BIN.";
    return `${kind} sandbox: ${binary} is not installed or not on PATH. ${fix}`;
  }
  return `${kind} sandbox: could not start ${binary}: ${e.message}`;
}

/**
 * With CEO_REQUIRE_STUBS set, a sandbox launcher must be a stub too. Null
 * when the run may proceed.
 */
export function sandboxStubViolation(kind: SandboxKind, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env.CEO_REQUIRE_STUBS?.trim() || kind === "local") return null;
  const bins = kind === "docker" ? [dockerBinary(env)] : [sshBinary(env), rsyncBinary(env)];
  const bad = bins.find((b) => !/stub-/.test(b));
  return bad ? `CEO_REQUIRE_STUBS is set and the ${kind} sandbox would run ${bad}; refusing.` : null;
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export type SandboxReadiness = { ready: boolean; reason: string };

function exitsZero(bin: string, args: string[], env: NodeJS.ProcessEnv): boolean {
  try {
    execFileSync(bin, args, { stdio: "ignore", timeout: 15000, env: { ...process.env, ...env } });
    return true;
  } catch {
    return false;
  }
}

/** Whether a sandbox can start a run. `reason` says what is missing, or what was found. */
export function sandboxReadiness(kind: SandboxKind, env: NodeJS.ProcessEnv = process.env): SandboxReadiness {
  if (kind === "local") return { ready: true, reason: "runs on this machine" };
  if (kind === "docker") {
    const bin = dockerBinary(env);
    const image = sandboxImage(env);
    if (!exitsZero(bin, ["version"], env)) {
      return { ready: false, reason: `docker is not available: \`${bin} version\` failed. Start the daemon or set CEO_DOCKER_BIN.` };
    }
    if (!exitsZero(bin, ["image", "inspect", image], env)) {
      return { ready: false, reason: `image ${image} is not present. Build it, or set CEO_SANDBOX_IMAGE. See docs/sandboxes.md.` };
    }
    return { ready: true, reason: `docker is up and ${image} is present` };
  }
  const host = sandboxHost(env);
  if (!host) return { ready: false, reason: "CEO_SANDBOX_HOST is not set." };
  return { ready: true, reason: `ssh host ${host} is configured, not probed` };
}
