/**
 * tmux as the dashboard's host.
 *
 * A dashboard that dies when its terminal closes is a viewer. What makes it
 * an orchestrator is that the agents it started keep running when you shut
 * the laptop lid, switch machines over ssh, or close the tab by accident.
 * And you can get back to exactly where they are. tmux already solves
 * that: a session server outlives every client that attaches to it.
 *
 * So `ceo` with no arguments starts, or reattaches to, one tmux session,
 * named `ceo`, whose first window is the dashboard. Delegations the dashboard
 * spawns are children of that process and therefore of the tmux server, not
 * of whatever terminal the user happened to be looking at. Detach and the
 * runs continue. Reattach and the run pane is where you left it.
 *
 * The other thing tmux gives is a way to *go somewhere*. An agent's worktree
 * is a directory, and the natural thing to do with a directory is open a
 * shell in it. `openWindow` does that as a named tmux window inside the same
 * session, so the shell you dropped into `ceo/refactorer` last week is still
 * there, still named, next to the dashboard.
 *
 * Nothing here is required. Without tmux on PATH the dashboard runs in the
 * foreground like any other TUI, and every function below says so rather
 * than failing mysteriously.
 */

import { execFileSync, spawnSync } from "node:child_process";

/** Session name. One per user. Workspaces are windows and panes within it. */
export const SESSION = "ceo";

/** Window name for the dashboard, so `select-window -t ceo:dashboard` works. */
export const DASHBOARD_WINDOW = "dashboard";

export type TmuxResult = { ok: true; detail: string } | { ok: false; error: string };

let cachedHasTmux: boolean | null = null;

/** tmux on PATH and runnable. Cached: the answer does not change mid-process. */
export function hasTmux(): boolean {
  if (cachedHasTmux !== null) return cachedHasTmux;
  const r = spawnSync("tmux", ["-V"], { stdio: "ignore" });
  cachedHasTmux = r.status === 0;
  return cachedHasTmux;
}

/** True when this process is already running inside a tmux client. */
export function inTmux(): boolean {
  return Boolean(process.env.TMUX);
}

function tmux(args: string[]): TmuxResult {
  try {
    const out = execFileSync("tmux", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, detail: out.trim() };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const stderr =
      typeof err.stderr === "string"
        ? err.stderr
        : err.stderr?.toString() ?? err.message ?? String(e);
    return { ok: false, error: stderr.trim() || "tmux failed" };
  }
}

export function sessionExists(name: string = SESSION): boolean {
  if (!hasTmux()) return false;
  return tmux(["has-session", "-t", `=${name}`]).ok;
}

/** Name of the session this process is attached to, when inside tmux. */
export function currentSession(): string | null {
  if (!inTmux()) return null;
  const r = tmux(["display-message", "-p", "#S"]);
  return r.ok && r.detail ? r.detail : null;
}

/** Quote for `tmux new-session … "<shell command>"`, which runs via sh. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Create the `ceo` session with the dashboard as its first window, unless it
 * already exists. Returns whether it was created. The session is started
 * detached so the caller decides how to get the user into it: attach from a
 * bare terminal, switch-client from inside another session.
 */
export function ensureSession(opts: {
  name?: string;
  cwd: string;
  command: string;
}): TmuxResult & { created?: boolean } {
  const name = opts.name ?? SESSION;
  if (!hasTmux()) return { ok: false, error: "tmux is not installed or not on PATH." };
  if (sessionExists(name)) return { ok: true, detail: `session ${name} already running`, created: false };
  const r = tmux([
    "new-session",
    "-d",
    "-s",
    name,
    "-n",
    DASHBOARD_WINDOW,
    "-c",
    opts.cwd,
    opts.command,
  ]);
  if (!r.ok) return r;
  // Keep the dashboard's pane title stable so it is findable.
  tmux(["set-option", "-t", `=${name}`, "-q", "status-left", `[${name}] `]);
  return { ok: true, detail: `started session ${name}`, created: true };
}

/**
 * Put the user in front of the session. From inside tmux that is a
 * switch-client. From a bare terminal it is an attach, which blocks until
 * they detach. The attach inherits stdio, so this function returns only when
 * the user leaves the session.
 */
export function attach(name: string = SESSION): TmuxResult {
  if (!hasTmux()) return { ok: false, error: "tmux is not installed or not on PATH." };
  if (inTmux()) {
    return tmux(["switch-client", "-t", `=${name}`]);
  }
  const r = spawnSync("tmux", ["attach-session", "-t", `=${name}`], { stdio: "inherit" });
  if (r.status === 0) return { ok: true, detail: `detached from ${name}` };
  return { ok: false, error: `tmux attach exited ${r.status ?? "?"}` };
}

/**
 * A window in the session for one place: an agent's worktree, a workspace
 * root. Idempotent on the name. If the window is already there, it is
 * selected rather than duplicated, because the shell the user was in is the
 * one they want back.
 *
 * Target session order: the one this process is inside, else `ceo` if it is
 * running, else nothing. A window needs a session, and starting one just to
 * hold a shell would surprise more than it helps.
 */
export function openWindow(opts: {
  name: string;
  cwd: string;
  /** Shell command. Defaults to the user's login shell. */
  command?: string;
  /** Switch to the new window. Default true. */
  focus?: boolean;
}): TmuxResult {
  if (!hasTmux()) return { ok: false, error: "tmux is not installed, so there is nowhere to open a window." };
  const session = currentSession() ?? (sessionExists() ? SESSION : null);
  if (!session) {
    return {
      ok: false,
      error: `No tmux session to open a window in. Start one with \`ceo\`, which creates the ${SESSION} session.`,
    };
  }
  // tmux window names cannot contain ':' or '.' without confusing targets.
  const name = opts.name.replace(/[:.]/g, "-").slice(0, 40);

  const existing = tmux(["list-windows", "-t", `=${session}`, "-F", "#{window_name}"]);
  if (existing.ok && existing.detail.split("\n").includes(name)) {
    const sel = tmux(["select-window", "-t", `=${session}:${name}`]);
    return sel.ok ? { ok: true, detail: `switched to window ${name}` } : sel;
  }

  const args = ["new-window", "-t", `=${session}`, "-n", name, "-c", opts.cwd];
  if (opts.focus === false) args.push("-d");
  if (opts.command) args.push(opts.command);
  const r = tmux(args);
  return r.ok ? { ok: true, detail: `opened window ${name} in ${opts.cwd}` } : r;
}

/** Split the current window beside the caller. Used by `ceo open`. */
export function splitBeside(opts: { cwd: string; command: string; percent?: number }): TmuxResult {
  if (!inTmux()) return { ok: false, error: "Not inside tmux." };
  return tmux([
    "split-window",
    "-h",
    "-l",
    `${opts.percent ?? 45}%`,
    "-c",
    opts.cwd,
    opts.command,
  ]);
}

/** Windows in the `ceo` session, for the dashboard's workspace view. */
export function listWindows(name: string = SESSION): Array<{ index: number; name: string; active: boolean; path: string }> {
  if (!sessionExists(name)) return [];
  const r = tmux([
    "list-windows",
    "-t",
    `=${name}`,
    "-F",
    "#{window_index}\t#{window_name}\t#{window_active}\t#{pane_current_path}",
  ]);
  if (!r.ok || !r.detail) return [];
  return r.detail.split("\n").map((line) => {
    const [index, wname, active, p] = line.split("\t");
    return { index: Number(index), name: wname ?? "", active: active === "1", path: p ?? "" };
  });
}

/** One-line description of the hosting situation, for `ceo status`. */
export function describeHost(): string {
  if (!hasTmux()) return "tmux: not installed, so the dashboard runs in the foreground only";
  if (inTmux()) return `tmux: inside session ${currentSession() ?? "?"}`;
  if (sessionExists()) return `tmux: session ${SESSION} is running, and ceo attaches to it`;
  return `tmux: available, ceo will start session ${SESSION}`;
}
