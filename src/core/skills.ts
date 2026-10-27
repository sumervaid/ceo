/**
 * Skills: procedures an agent follows when the task fits.
 *
 * A skill is a SKILL.md file: frontmatter with a name and a description,
 * then when to use it, the workflow, constraints and how to know it is
 * done. Reflex writes them from workflows a developer kept repeating, to
 * `~/.reflex/skills/<name>/SKILL.md`. Claude Code, Codex and Cursor keep
 * installed ones in their own folders, and a repository may carry its own
 * in `.claude/skills/`.
 *
 * CEO reads all of those as one catalogue. The docket gives a skill to an
 * agent, and the agent's prompt then carries the skill in full. That works
 * the same on every provider, and it is per agent: the scout gets the
 * mapping skill, the fixer gets the fix-flaky-test skill. A skill a CLI
 * loads from its own folder still loads for every run of that CLI.
 *
 * A workflow Reflex found but nobody approved yet is in the catalogue too,
 * marked pending. Picking one runs `reflex approve <name> --yes`, which
 * writes the SKILL.md, and the skill is then the same as any other.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

import { readReflex } from "./history.js";
import { reflexBinary, reflexHome } from "./reflex.js";
import { projectRoot } from "./paths.js";

export type SkillSource = "reflex" | "claude" | "codex" | "cursor" | "repo";

export type Skill = {
  name: string;
  description: string;
  source: SkillSource;
  /** The SKILL.md, or null for a pending workflow. */
  path: string | null;
  status: "ready" | "pending";
  /** For a pending workflow: how sure Reflex is, 0 to 1. */
  confidence: number | null;
};

function frontmatter(text: string): { name: string | null; description: string } {
  if (!text.startsWith("---")) return { name: null, description: "" };
  const end = text.indexOf("\n---", 3);
  const head = end > 0 ? text.slice(3, end) : "";
  const name = /^name:\s*(.+)$/m.exec(head)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? null;
  const description = /^description:\s*(.+)$/m.exec(head)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  return { name, description };
}

/** Where each source keeps skills, in the order a duplicate name is resolved. */
export function skillDirs(cwd?: string, env: NodeJS.ProcessEnv = process.env): Array<{ source: SkillSource; dir: string }> {
  const home = homedir();
  return [
    { source: "reflex", dir: path.join(reflexHome(env), "skills") },
    { source: "repo", dir: path.join(projectRoot(cwd), ".claude", "skills") },
    { source: "claude", dir: path.join(env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude"), "skills") },
    { source: "codex", dir: path.join(env.CODEX_HOME?.trim() || path.join(home, ".codex"), "skills") },
    { source: "cursor", dir: path.join(home, ".cursor", "skills") },
  ];
}

/** Every SKILL.md on the machine and in the repo, one per name. */
export function readySkills(cwd?: string, env: NodeJS.ProcessEnv = process.env): Skill[] {
  const seen = new Map<string, Skill>();
  for (const { source, dir } of skillDirs(cwd, env)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names.sort()) {
      const file = path.join(dir, n, "SKILL.md");
      if (!existsSync(file)) continue;
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const fm = frontmatter(text);
      const name = fm.name ?? n;
      if (seen.has(name)) continue;
      seen.set(name, { name, description: fm.description, source, path: file, status: "ready", confidence: null });
    }
  }
  return [...seen.values()];
}

/** The catalogue: ready skills, then Reflex workflows still waiting for approval. */
export async function skillCatalog(cwd?: string, env: NodeJS.ProcessEnv = process.env): Promise<Skill[]> {
  const ready = readySkills(cwd, env);
  const names = new Set(ready.map((s) => s.name));
  let pending: Skill[] = [];
  try {
    const r = await readReflex(projectRoot(cwd), env);
    pending = (r.workflows ?? [])
      .filter((w) => w.status === "pending" && !names.has(w.slug))
      .map((w) => ({ name: w.slug, description: w.description || w.title, source: "reflex" as const, path: null, status: "pending" as const, confidence: w.confidence }));
  } catch {
    pending = [];
  }
  return [...ready, ...pending];
}

export function findSkill(name: string, cwd?: string): Skill | null {
  return readySkills(cwd).find((s) => s.name === name) ?? null;
}

/** The skill's text for a prompt: the SKILL.md without its frontmatter. */
export function skillBody(skill: Skill): string {
  if (!skill.path) return "";
  const text = readFileSync(skill.path, "utf8");
  const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
  return (end > 0 ? text.slice(end + 4) : text).trim();
}

/** Turn a pending Reflex workflow into a skill with `reflex approve <name> --yes`. */
export function approveWorkflow(name: string, cwd?: string): Skill {
  const r = spawnSync(reflexBinary(), ["approve", name, "--yes"], { cwd: projectRoot(cwd), encoding: "utf8", timeout: 60000 });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new Error("Reflex is not installed: npm install -g reflex-skills");
  if (r.status !== 0) throw new Error(`reflex approve ${name} failed: ${(r.stderr || r.stdout || "").trim().split("\n").pop()}`);
  const skill = findSkill(name, cwd);
  if (!skill) throw new Error(`reflex approve ${name} ran, but no SKILL.md for ${name} appeared.`);
  return skill;
}
