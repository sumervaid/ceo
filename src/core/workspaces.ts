/**
 * The workspace registry: which repos this user runs orgs in.
 *
 * Every org lives in its own repo under `.ceo/`, and that stays true: the
 * ledger for a project is committed with the project. What is missing without
 * this file is the list. A person running four orgs across four repos has no
 * single place that knows about all four. So the dashboard was one repo at a
 * time, and switching meant quitting.
 *
 * The registry is deliberately a thin thing. It is a per-user file at
 * `~/.ceo/workspaces.json` holding paths and display names, nothing else. No
 * spend, no roster, no agent state: all of that is read from each workspace's
 * own ledger on demand, so the registry can never disagree with the ledger
 * about anything that matters. It is a cache of *where to look*, not of what
 * is there.
 *
 * Paths are stored as git roots, the same resolution `.ceo/` uses, so adding
 * a repo from a subdirectory and from its top registers one workspace.
 *
 * Writes go through a temp file and a rename, so a crash mid-write leaves the
 * previous file intact rather than a truncated one. There is no lock: the
 * registry is edited by a human keystroke at a time, and the worst case of a
 * race is a lost add that the next open puts straight back.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { orgExists, projectRoot } from "./paths.js";

export type Workspace = {
  /** Absolute git root, or plain directory when not a repo. Unique. */
  path: string;
  /** Display name. Defaults to the directory's basename, deduplicated. */
  name: string;
  /** ms epoch */
  addedAt: number;
  /** ms epoch of the last time the dashboard focused it. */
  lastOpenedAt: number | null;
};

export type WorkspaceRegistry = {
  version: 1;
  workspaces: Workspace[];
};

/**
 * `CEO_HOME` overrides the per-user directory. It exists so tests and a pty
 * harness can point the dashboard at a throwaway registry instead of the
 * real one, and so a shared machine can keep one registry per account.
 */
export function ceoHome(): string {
  return process.env.CEO_HOME?.trim() || path.join(homedir(), ".ceo");
}

export function registryPath(): string {
  return path.join(ceoHome(), "workspaces.json");
}

function empty(): WorkspaceRegistry {
  return { version: 1, workspaces: [] };
}

/** Read the registry. A missing or unreadable file reads as empty. */
export function readRegistry(): WorkspaceRegistry {
  const p = registryPath();
  if (!existsSync(p)) return empty();
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<WorkspaceRegistry>;
    if (!Array.isArray(parsed.workspaces)) return empty();
    return {
      version: 1,
      workspaces: parsed.workspaces
        .filter((w): w is Workspace => Boolean(w && typeof w.path === "string"))
        .map((w) => ({
          path: w.path,
          name: typeof w.name === "string" && w.name ? w.name : path.basename(w.path),
          addedAt: Number(w.addedAt) || 0,
          lastOpenedAt: typeof w.lastOpenedAt === "number" ? w.lastOpenedAt : null,
        })),
    };
  } catch {
    return empty();
  }
}

function persist(reg: WorkspaceRegistry): void {
  const p = registryPath();
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n", "utf8");
  renameSync(tmp, p);
}

/** Resolve whatever the user typed to the path the registry keys on. */
export function resolveWorkspacePath(input: string): string {
  const expanded = input.startsWith("~") ? path.join(homedir(), input.slice(1)) : input;
  return projectRoot(path.resolve(expanded));
}

/**
 * Registered workspaces, most recently opened first, then by name. A
 * registry that has never been touched by the dashboard therefore lists
 * alphabetically, which is at least predictable.
 */
export function listWorkspaces(): Workspace[] {
  return [...readRegistry().workspaces].sort((a, b) => {
    const ao = a.lastOpenedAt ?? 0;
    const bo = b.lastOpenedAt ?? 0;
    if (ao !== bo) return bo - ao;
    return a.name.localeCompare(b.name);
  });
}

export function findWorkspace(p: string): Workspace | null {
  const key = resolveWorkspacePath(p);
  return readRegistry().workspaces.find((w) => w.path === key) ?? null;
}

/** A name nobody else in the registry has, so two `api` repos stay apart. */
function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Register a directory. Idempotent: adding a path that is already there
 * returns the existing record untouched, so the dashboard can call this on
 * every open without churning the file.
 *
 * Refuses a path that does not exist. It does *not* require an org to be
 * there yet, since the dashboard can create one. But a typo should fail here,
 * not as a blank sidebar entry.
 */
export function addWorkspace(input: string, name?: string): Workspace {
  const p = resolveWorkspacePath(input);
  let st;
  try {
    st = statSync(p);
  } catch {
    throw new Error(`No such directory: ${p}`);
  }
  if (!st.isDirectory()) throw new Error(`Not a directory: ${p}`);

  const reg = readRegistry();
  const existing = reg.workspaces.find((w) => w.path === p);
  if (existing) return existing;

  const taken = new Set(reg.workspaces.map((w) => w.name));
  const ws: Workspace = {
    path: p,
    name: uniqueName((name?.trim() || path.basename(p)).slice(0, 40), taken),
    addedAt: Date.now(),
    lastOpenedAt: null,
  };
  reg.workspaces.push(ws);
  persist(reg);
  return ws;
}

/** Forget a workspace. The repo and its `.ceo/` are not touched. */
export function removeWorkspace(input: string): boolean {
  const p = resolveWorkspacePath(input);
  const reg = readRegistry();
  const before = reg.workspaces.length;
  reg.workspaces = reg.workspaces.filter((w) => w.path !== p && w.name !== input);
  if (reg.workspaces.length === before) return false;
  persist(reg);
  return true;
}

/** Record that the dashboard focused this workspace, for the sort order. */
export function touchWorkspace(p: string): void {
  const reg = readRegistry();
  const ws = reg.workspaces.find((w) => w.path === p);
  if (!ws) return;
  ws.lastOpenedAt = Date.now();
  persist(reg);
}

export function renameWorkspace(p: string, name: string): Workspace {
  const key = resolveWorkspacePath(p);
  const reg = readRegistry();
  const ws = reg.workspaces.find((w) => w.path === key);
  if (!ws) throw new Error(`Not a registered workspace: ${key}`);
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) throw new Error("A workspace needs a name.");
  const taken = new Set(reg.workspaces.filter((w) => w !== ws).map((w) => w.name));
  ws.name = uniqueName(trimmed, taken);
  persist(reg);
  return ws;
}

/**
 * The workspace for a cwd, registering it when it is a repo with an org and
 * nobody has added it yet. This is what makes `ceo` opened in a new project
 * show up in the sidebar of every later dashboard without a separate step.
 * A directory with no org is not auto-registered: a registry full of every
 * folder the dashboard was ever launched in is noise, not a workspace list.
 */
export function ensureCurrentWorkspace(cwd: string = process.cwd()): Workspace | null {
  const root = projectRoot(cwd);
  const existing = findWorkspace(root);
  if (existing) return existing;
  if (!orgExists(root)) return null;
  return addWorkspace(root);
}
