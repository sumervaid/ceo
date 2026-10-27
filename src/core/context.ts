/**
 * The docket: the context a developer gives agents, item by item.
 *
 * An item is a file or a folder in the repository, a GitHub issue or pull
 * request, a Hugging Face model, dataset, Space or paper, a web page, a
 * skill, or a note typed in. Each item is given to some agents and not to
 * others. A run starts with the items its agent holds, in a "Context from
 * the docket" section of the prompt, and its skills in a "Your skills"
 * section.
 *
 * Files and folders are read when the run starts, from the agent's own
 * worktree when the agent has one, so an agent reads its branch rather
 * than a copy from last week. Everything fetched from elsewhere is
 * snapshotted into `.ceo/context/<id>.md` when it is added, and `r`
 * refreshes it. A run therefore reads what the developer saw, and an audit
 * can open the same file later.
 *
 * The ledger is the authority, as everywhere: `context_add`,
 * `context_update`, `context_remove`, `context_assign` and
 * `context_unassign`. Each `delegate_start` records the items its run was
 * given.
 *
 * Sizes are counted in characters and shown as tokens, at four characters
 * a token. One item is cut at CEO_CONTEXT_ITEM_MAX characters, 24,000 by
 * default. One agent's whole docket is cut at CEO_CONTEXT_MAX, 96,000, and
 * the prompt says what was cut.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { readThread } from "./github.js";
import { hfCard, hfPaper, parseHfSource } from "./huggingface.js";
import { append, readLedger } from "./ledger.js";
import { ceoDir, projectRoot } from "./paths.js";
import { readRoster } from "./roster.js";
import { findSkill, skillBody } from "./skills.js";
import type { LedgerEntry } from "./types.js";

export type ContextKind = "file" | "folder" | "issue" | "pr" | "model" | "dataset" | "space" | "paper" | "url" | "skill" | "note";

export const KIND_LABEL: Record<ContextKind, string> = {
  file: "Files",
  folder: "Files",
  issue: "GitHub",
  pr: "GitHub",
  model: "Hugging Face",
  dataset: "Hugging Face",
  space: "Hugging Face",
  paper: "Hugging Face",
  url: "Web",
  skill: "Skills",
  note: "Notes",
};

/** The order the docket's groups are drawn in. */
export const GROUPS = ["Skills", "Files", "GitHub", "Hugging Face", "Web", "Notes"] as const;

export type ContextItem = {
  id: string;
  kind: ContextKind;
  title: string;
  /** What the item was added from: a path, a URL, "#42", "org/name", a skill name. */
  source: string;
  /** The snapshot under `.ceo/context/`, for anything not read fresh. */
  snapshot: string | null;
  /** Size when last measured, in characters. */
  chars: number;
  addedAt: number;
  addedBy: string;
  /** Agents holding the item. */
  agents: string[];
  seq: number;
};

export function itemMaxChars(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CEO_CONTEXT_ITEM_MAX);
  return Number.isFinite(n) && n > 0 ? n : 24000;
}

export function agentMaxChars(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CEO_CONTEXT_MAX);
  return Number.isFinite(n) && n > 0 ? n : 96000;
}

/** Tokens, roughly: four characters each. */
export function tokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** "1.2k" */
export function tokenLabel(chars: number): string {
  const t = tokens(chars);
  return t >= 1000 ? `${(t / 1000).toFixed(t >= 10000 ? 0 : 1)}k` : String(t);
}

export function contextDir(cwd?: string): string {
  return path.join(ceoDir(cwd), "context");
}

/** Every item in the docket, with who holds it, replayed from the ledger. */
export function listContext(cwd?: string, entries: LedgerEntry[] = readLedger(cwd)): ContextItem[] {
  const items = new Map<string, ContextItem>();
  for (const e of entries) {
    const id = String(e.data.id ?? "");
    if (e.type === "context_add") {
      items.set(id, {
        id,
        kind: e.data.kind as ContextKind,
        title: String(e.data.title ?? ""),
        source: String(e.data.source ?? ""),
        snapshot: typeof e.data.snapshot === "string" ? e.data.snapshot : null,
        chars: Number(e.data.chars ?? 0) || 0,
        addedAt: e.ts,
        addedBy: String(e.data.by ?? "you"),
        agents: [],
        seq: e.seq,
      });
    } else if (e.type === "context_update") {
      const it = items.get(id);
      if (!it) continue;
      if (typeof e.data.title === "string") it.title = e.data.title;
      if (typeof e.data.chars === "number") it.chars = e.data.chars;
    } else if (e.type === "context_remove") {
      items.delete(id);
    } else if (e.type === "context_assign" && e.agent) {
      const it = items.get(id);
      if (it && !it.agents.includes(e.agent)) it.agents.push(e.agent);
    } else if (e.type === "context_unassign" && e.agent) {
      const it = items.get(id);
      if (it) it.agents = it.agents.filter((a) => a !== e.agent);
    } else if (e.type === "fire" && e.agent) {
      for (const it of items.values()) it.agents = it.agents.filter((a) => a !== e.agent);
    }
  }
  return [...items.values()].sort((a, b) => GROUPS.indexOf(KIND_LABEL[a.kind] as (typeof GROUPS)[number]) - GROUPS.indexOf(KIND_LABEL[b.kind] as (typeof GROUPS)[number]) || a.seq - b.seq);
}

export function findContext(idOrTitle: string, cwd?: string): ContextItem | null {
  const key = idOrTitle.trim().toLowerCase();
  const all = listContext(cwd);
  return all.find((i) => i.id === key) ?? all.find((i) => i.source.toLowerCase() === key) ?? all.find((i) => i.title.toLowerCase() === key) ?? all.find((i) => i.title.toLowerCase().includes(key)) ?? null;
}

const TEXT_EXT = /\.(md|mdx|txt|ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|sql|css|scss|html|vue|svelte|ini|cfg|env\.example|gitignore|dockerfile)$/i;
const SKIP_DIR = new Set(["node_modules", ".git", ".ceo", "dist", "build", ".next", "coverage", "__pycache__", ".venv", "venv"]);

/** The text files under a folder, bounded, in a stable order. */
function folderFiles(dir: string, limit = 60): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (out.length >= limit) return;
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (out.length >= limit) return;
      const p = path.join(d, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIR.has(n) && !n.startsWith(".")) walk(p);
      } else if (TEXT_EXT.test(n) || n === "Dockerfile" || n === "Makefile") {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out;
}

/** Read a file or folder item as text, relative to `base`. */
function readLocal(kind: "file" | "folder", source: string, base: string): string {
  const full = path.resolve(base, source);
  if (kind === "file") return readFileSync(full, "utf8");
  return folderFiles(full)
    .map((f) => `--- ${path.relative(base, f)} ---\n${readFileSync(f, "utf8")}`)
    .join("\n\n");
}

/** Strip a web page down to its text. */
function pageText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const text = html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
  return { title, text };
}

/** What an input line names, before anything is fetched. */
export function classify(input: string, cwd?: string): { kind: ContextKind; source: string } {
  const s = input.trim();
  const root = projectRoot(cwd);
  if (/^skill:/i.test(s)) return { kind: "skill", source: s.slice(6).trim() };
  const issue = /^(?:issue\s*)?#(\d+)$/i.exec(s) ?? /github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/.exec(s);
  if (issue) return { kind: "issue", source: `#${issue[1]}` };
  const pr = /^pr\s*#?(\d+)$/i.exec(s) ?? /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(s);
  if (pr) return { kind: "pr", source: `#${pr[1]}` };
  const hf = parseHfSource(s);
  if (hf) return { kind: hf.kind, source: hf.id };
  if (/^https?:\/\//i.test(s)) return { kind: "url", source: s };
  const local = path.resolve(root, s);
  if (s.length < 400 && !s.includes("\n") && existsSync(local)) {
    return { kind: statSync(local).isDirectory() ? "folder" : "file", source: path.relative(root, local) || "." };
  }
  return { kind: "note", source: s };
}

function shortId(): string {
  return randomBytes(3).toString("hex");
}

function snapshotTo(id: string, text: string, cwd?: string): string {
  const dir = contextDir(cwd);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.md`);
  writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
  return path.relative(projectRoot(cwd), file);
}

/** Fetch an item's current text and title. Files and folders read the main tree. */
async function fetchItem(kind: ContextKind, source: string, cwd?: string): Promise<{ title: string; text: string }> {
  const root = projectRoot(cwd);
  switch (kind) {
    case "file":
    case "folder":
      return { title: source, text: readLocal(kind, source, root) };
    case "issue":
    case "pr": {
      const t = readThread(kind, Number(source.slice(1)), cwd);
      return { title: t.title, text: t.text };
    }
    case "model":
    case "dataset":
    case "space":
      return hfCard(kind, source);
    case "paper":
      return hfPaper(source);
    case "url": {
      const res = await fetch(source, { redirect: "follow" });
      if (!res.ok) throw new Error(`${source} answered ${res.status}.`);
      const body = await res.text();
      const isHtml = /html/i.test(res.headers.get("content-type") ?? "") || /^\s*</.test(body);
      const page = isHtml ? pageText(body) : { title: "", text: body };
      return { title: page.title || source.replace(/^https?:\/\//, "").slice(0, 60), text: `${source}\n\n${page.text}`.slice(0, 200000) };
    }
    case "skill": {
      const skill = findSkill(source, cwd);
      if (!skill) throw new Error(`No skill named "${source}". The docket's skill list shows what Reflex and the CLIs have.`);
      return { title: skill.name, text: skillBody(skill) };
    }
    case "note": {
      const first = source.split("\n")[0].trim();
      return { title: first.length > 60 ? `${first.slice(0, 59)}…` : first, text: source };
    }
  }
}

/**
 * Add one item to the docket from an input line, and give it to the agents
 * named. Returns the item. A source already in the docket is reused, with
 * the agents added.
 */
export async function addContext(input: string, cwd?: string, opts: { by?: string; agents?: string[] } = {}): Promise<ContextItem> {
  const { kind, source } = classify(input, cwd);
  if (!source) throw new Error("Give the docket something: a file, a folder, an issue like #42, hf:org/model, a URL, skill:name, or a note.");
  const existing = listContext(cwd).find((i) => i.kind === kind && i.source === source);
  if (existing) {
    for (const a of opts.agents ?? []) giveContext(existing.id, a, cwd, opts.by);
    return listContext(cwd).find((i) => i.id === existing.id)!;
  }
  const { title, text } = await fetchItem(kind, source, cwd);
  const id = shortId();
  const fresh = kind === "file" || kind === "folder";
  const snapshot = fresh ? null : snapshotTo(id, text, cwd);
  append("context_add", null, { id, kind, title, source, snapshot, chars: text.length, by: opts.by ?? "you" }, cwd);
  for (const a of opts.agents ?? []) giveContext(id, a, cwd, opts.by);
  return listContext(cwd).find((i) => i.id === id)!;
}

/** Fetch an item again: a new snapshot, a new size. */
export async function refreshContext(id: string, cwd?: string): Promise<ContextItem> {
  const it = listContext(cwd).find((i) => i.id === id);
  if (!it) throw new Error(`No docket item ${id}.`);
  const { title, text } = await fetchItem(it.kind, it.source, cwd);
  if (it.snapshot) writeFileSync(path.join(projectRoot(cwd), it.snapshot), text.endsWith("\n") ? text : `${text}\n`);
  append("context_update", null, { id, title, chars: text.length }, cwd);
  return listContext(cwd).find((i) => i.id === id)!;
}

export function removeContext(id: string, cwd?: string): void {
  if (!listContext(cwd).some((i) => i.id === id)) throw new Error(`No docket item ${id}.`);
  append("context_remove", null, { id }, cwd);
}

export function giveContext(id: string, agent: string, cwd?: string, by?: string): void {
  const it = listContext(cwd).find((i) => i.id === id);
  if (!it) throw new Error(`No docket item ${id}.`);
  if (!readRoster(cwd).agents.some((a) => a.name === agent)) throw new Error(`No agent named "${agent}" in the org.`);
  if (it.agents.includes(agent)) return;
  append("context_assign", agent, { id, ...(by ? { by } : {}) }, cwd);
}

export function takeContext(id: string, agent: string, cwd?: string, by?: string): void {
  const it = listContext(cwd).find((i) => i.id === id);
  if (!it || !it.agents.includes(agent)) return;
  append("context_unassign", agent, { id, ...(by ? { by } : {}) }, cwd);
}

/** The text of one item now: fresh for files, the snapshot otherwise. */
export function itemText(it: ContextItem, cwd?: string, base?: string): string {
  try {
    if (it.kind === "file" || it.kind === "folder") {
      const from = base && existsSync(path.resolve(base, it.source)) ? base : projectRoot(cwd);
      return readLocal(it.kind, it.source, from);
    }
    if (it.snapshot) return readFileSync(path.join(projectRoot(cwd), it.snapshot), "utf8");
  } catch (e) {
    return `[could not read ${it.source}: ${e instanceof Error ? e.message : String(e)}]`;
  }
  return "";
}

export type ResolvedContext = {
  id: string;
  kind: ContextKind;
  title: string;
  source: string;
  text: string;
  /** The item was cut to fit. */
  truncated: boolean;
};

/**
 * The docket of one agent, ready for a prompt: each item's text, cut to
 * the item limit, and the whole cut to the agent limit. Skills come back in
 * the same list, marked by kind, for the prompt's own section.
 */
export function contextFor(agent: string, cwd?: string, workdir?: string): ResolvedContext[] {
  const perItem = itemMaxChars();
  let left = agentMaxChars();
  const out: ResolvedContext[] = [];
  for (const it of listContext(cwd).filter((i) => i.agents.includes(agent))) {
    const full = itemText(it, cwd, workdir);
    let text = full.length > perItem ? full.slice(0, perItem) : full;
    if (text.length > left) text = text.slice(0, Math.max(0, left));
    left -= text.length;
    out.push({ id: it.id, kind: it.kind, title: it.title, source: it.source, text, truncated: text.length < full.length });
    if (left <= 0) break;
  }
  return out;
}

/** Characters each agent would receive, for the docket's totals row. */
export function loadOf(items: ContextItem[], agents: string[]): Map<string, number> {
  const load = new Map<string, number>(agents.map((a) => [a, 0]));
  for (const it of items) for (const a of it.agents) load.set(a, (load.get(a) ?? 0) + Math.min(it.chars, itemMaxChars()));
  return load;
}
