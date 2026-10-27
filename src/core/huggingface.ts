/**
 * Hugging Face, over the Hub's public HTTP API.
 *
 * Public models, datasets, Spaces and papers need no setup at all. A token,
 * from HF_TOKEN or the one `hf auth login` saved, adds private repos. CEO
 * never stores a token of its own.
 *
 * What comes back is text an agent can read: a model card with its
 * pipeline, tags and README; a dataset card; a Space's README; a paper's
 * title, authors and abstract. The docket snapshots it, so an agent reads
 * what the developer saw.
 *
 * CEO_HF_ENDPOINT points the client somewhere else. A `file://` endpoint
 * reads the same paths from a directory, which is how the specs and the
 * demo run without the network.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type HfKind = "model" | "dataset" | "space";

export function hfEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CEO_HF_ENDPOINT?.trim() || "https://huggingface.co").replace(/\/+$/, "");
}

/** The developer's token, wherever the Hub's own tools keep it. */
export function hfToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const direct = env.HF_TOKEN?.trim() || env.HUGGING_FACE_HUB_TOKEN?.trim();
  if (direct) return direct;
  const home = env.HF_HOME?.trim() || path.join(homedir(), ".cache", "huggingface");
  try {
    const t = readFileSync(path.join(home, "token"), "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

async function get(urlPath: string, as: "json" | "text"): Promise<unknown> {
  const base = hfEndpoint();
  if (base.startsWith("file://")) {
    const dir = fileURLToPath(base);
    const file = path.join(dir, ...urlPath.split("/").filter(Boolean));
    const found = existsSync(file) ? file : existsSync(`${file}.json`) ? `${file}.json` : null;
    if (!found) throw new Error(`Not found on the Hub: ${urlPath}`);
    const body = readFileSync(found, "utf8");
    return as === "json" ? JSON.parse(body) : body;
  }
  const token = hfToken();
  const res = await fetch(`${base}${urlPath}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (res.status === 404) throw new Error(`Not found on the Hub: ${urlPath}`);
  if (res.status === 401 || res.status === 403) throw new Error(`The Hub refused ${urlPath}. A private repo needs a token: hf auth login, or HF_TOKEN.`);
  if (!res.ok) throw new Error(`The Hub answered ${res.status} for ${urlPath}.`);
  return as === "json" ? res.json() : res.text();
}

export type HfStatus = { token: boolean; account: string | null; endpoint: string };

let statusMemo: { at: number; value: HfStatus } | null = null;

/** Whether a token is present, and whose. Public content works either way. */
export async function hfStatus(): Promise<HfStatus> {
  if (statusMemo && Date.now() - statusMemo.at < 60000) return statusMemo.value;
  const token = hfToken();
  let account: string | null = null;
  if (token) {
    try {
      const who = (await get("/api/whoami-v2", "json")) as { name?: string };
      account = who.name ?? null;
    } catch {
      account = null;
    }
  }
  const value = { token: Boolean(token), account, endpoint: hfEndpoint() };
  statusMemo = { at: Date.now(), value };
  return value;
}

export function resetHfStatus(): void {
  statusMemo = null;
}

const PREFIX: Record<HfKind, string> = { model: "", dataset: "datasets/", space: "spaces/" };

/** A model, dataset or Space as text: what it is, then its README. */
export async function hfCard(kind: HfKind, id: string): Promise<{ title: string; text: string; url: string }> {
  const info = (await get(`/api/${kind}s/${id}`, "json")) as Record<string, unknown>;
  let readme = "";
  try {
    readme = String(await get(`/${PREFIX[kind]}${id}/raw/main/README.md`, "text"));
  } catch {
    readme = "";
  }
  const url = `https://huggingface.co/${PREFIX[kind]}${id}`;
  const lines = [`Hugging Face ${kind}: ${id}`, url];
  const facts: string[] = [];
  if (info.pipeline_tag) facts.push(`pipeline ${info.pipeline_tag}`);
  if (info.library_name) facts.push(`library ${info.library_name}`);
  if (typeof info.downloads === "number") facts.push(`${info.downloads.toLocaleString("en-US")} downloads`);
  if (typeof info.likes === "number") facts.push(`${info.likes} likes`);
  if (info.sdk) facts.push(`sdk ${info.sdk}`);
  if (facts.length > 0) lines.push(facts.join(" · "));
  const tags = Array.isArray(info.tags) ? (info.tags as string[]).slice(0, 20) : [];
  if (tags.length > 0) lines.push(`Tags: ${tags.join(", ")}`);
  lines.push("", readme.replace(/^---[\s\S]*?\n---\n/, "").trim() || "The repo has no README.");
  return { title: `${id}${kind === "model" ? "" : ` · ${kind}`}`, text: lines.join("\n"), url };
}

/** A paper on the Hub, by arXiv id: title, authors, abstract. */
export async function hfPaper(id: string): Promise<{ title: string; text: string; url: string }> {
  const p = (await get(`/api/papers/${id}`, "json")) as Record<string, unknown>;
  const authors = Array.isArray(p.authors) ? (p.authors as Array<{ name?: string }>).map((a) => a.name).filter(Boolean) : [];
  const url = `https://huggingface.co/papers/${id}`;
  const title = String(p.title ?? id);
  return {
    title: `${title} · paper`,
    text: [`Paper ${id}: ${title}`, url, authors.length > 0 ? `Authors: ${authors.slice(0, 12).join(", ")}` : "", "", String(p.summary ?? "").trim()].filter((l, i) => i !== 2 || l).join("\n"),
    url,
  };
}

/** Read `hf:org/name`, `hf:datasets/org/name`, a huggingface.co URL, or `paper:2401.12345`. */
export function parseHfSource(input: string): { kind: HfKind | "paper"; id: string } | null {
  const s = input.trim();
  const paper = /^(?:paper:|https?:\/\/(?:www\.)?huggingface\.co\/papers\/)(\d{4}\.\d{4,5})/.exec(s);
  if (paper) return { kind: "paper", id: paper[1] };
  const m = /^(?:hf:|https?:\/\/(?:www\.)?huggingface\.co\/)(?:(datasets|spaces)\/)?([\w.-]+\/[\w.-]+)\/?$/.exec(s);
  if (!m) return null;
  return { kind: m[1] === "datasets" ? "dataset" : m[1] === "spaces" ? "space" : "model", id: m[2] };
}
