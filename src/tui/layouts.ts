/**
 * Constellation layouts: six ways to arrange the same sky.
 *
 *   orbit      working agents on the inner rings, idle ones outside
 *   providers  one wedge of the sky per provider
 *   teams      each swarm or team gathered into its own cluster
 *   web        agents that trade notes pull together; loners drift out
 *   spend      the heaviest spenders fall closest to the hole
 *   spiral     the org's history on two arms, the first hires innermost
 *
 * `auto` picks one from the shape of the org: a swarm reads best as
 * teams, a busy exchange as a web, a large mixed team as providers, and
 * anything else as orbit. A layout only returns targets. The component
 * eases every star toward its target, so a switch is an animation.
 *
 * Each layout also returns guides: faint rings, wedge edges, arm paths
 * and labels drawn under the stars, so the arrangement explains itself.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import type { Provider } from "../core/types.js";
import { ceoHome } from "../core/workspaces.js";
import { orbitTargets, PROVIDER_RGB, rings, scale, type Geometry, type Rgb, type StarStatus } from "./sky.js";

export type LayoutId = "orbit" | "providers" | "teams" | "web" | "spend" | "spiral";
export type LayoutChoice = LayoutId | "auto";

export const LAYOUTS: Array<{ id: LayoutId; key: string; glyph: string; name: string; about: string }> = [
  { id: "orbit", key: "1", glyph: "◎", name: "orbit", about: "Working agents circle close. Idle agents drift outside." },
  { id: "providers", key: "2", glyph: "◑", name: "providers", about: "One wedge of the sky per provider." },
  { id: "teams", key: "3", glyph: "⁂", name: "teams", about: "Each swarm and team gathers into a cluster." },
  { id: "web", key: "4", glyph: "✳", name: "web", about: "Agents that trade notes pull together. Loners drift out." },
  { id: "spend", key: "5", glyph: "◈", name: "spend", about: "The heaviest spenders fall closest to the hole." },
  { id: "spiral", key: "6", glyph: "❋", name: "spiral", about: "The org's history on two arms. The first hires sit innermost." },
];

export type LayoutAgent = {
  name: string;
  status: StarStatus;
  provider: Provider;
  /** When the agent last started or settled. */
  since: number;
  /** Hire order: 0 for the first hire. */
  seq: number;
  spendUsd: number;
  /** The team or swarm: `fixer` for fixer-07. */
  group: string;
};

export type LayoutEdge = { a: string; b: string; weight: number };

export type Polar = { r: number; a: number };

export type Guides = {
  rings: Array<{ r: number; color: Rgb }>;
  lines: Array<{ x1: number; y1: number; x2: number; y2: number; color: Rgb }>;
  path: Array<{ x: number; y: number; color: Rgb }>;
  labels: Array<{ x: number; y: number; text: string; color: Rgb }>;
};

export type LayoutResult = { targets: Map<string, Polar>; labelled: boolean; guides: Guides };

export type LayoutInput = {
  g: Geometry;
  agents: LayoutAgent[];
  edges: LayoutEdge[];
  /** Agents with a line to the chief, by weight. */
  chiefLinks: Map<string, number>;
  t: number;
  /** Where each star is now. The web layout continues from here. */
  current: Map<string, Polar>;
};

const STATUS_ORDER: Record<StarStatus, number> = { running: 0, waiting: 1, failed: 2, done: 3, idle: 4 };
const GUIDE: Rgb = [48, 54, 61];
const GOLD: Rgb = [210, 153, 34];
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

function emptyGuides(): Guides {
  return { rings: [], lines: [], path: [], labels: [] };
}

function hashName(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** The team of an agent: the name without a swarm number or an attempt suffix. */
export function groupOf(name: string): string {
  const base = name.split("·")[0];
  return base.replace(/-\d+$/, "") || base;
}

/** Row-unit cartesian to polar, and to cell coordinates. */
function polar(x: number, y: number): Polar {
  return { r: Math.hypot(x, y), a: Math.atan2(y, x) };
}

function cell(g: Geometry, p: Polar): { x: number; y: number } {
  return { x: g.cx + Math.cos(p.a) * p.r * g.ax, y: g.cy + Math.sin(p.a) * p.r };
}

/** Whether names fit beside every star, given the room the layout leaves. */
function fits(g: Geometry, agents: LayoutAgent[], share = 1): boolean {
  const longest = Math.max(4, ...agents.map((a) => a.name.length));
  const capacity = rings(g, agents.length, Math.min(18, longest + 4)).reduce((n, r) => n + r.capacity, 0);
  return capacity * share >= agents.length;
}

// -- the six layouts ----------------------------------------------------------

function orbitLayout(input: LayoutInput): LayoutResult {
  const { targets, labelled } = orbitTargets(input.g, input.agents, input.t);
  const guides = emptyGuides();
  const used = new Set([...targets.values()].map((p) => p.r.toFixed(2)));
  for (const r of used) guides.rings.push({ r: Number(r), color: GUIDE });
  return { targets, labelled, guides };
}

function providersLayout(input: LayoutInput): LayoutResult {
  const { g, agents, t } = input;
  const guides = emptyGuides();
  const targets = new Map<string, Polar>();
  const present = (["claude", "codex", "gemini"] as Provider[]).filter((p) => agents.some((a) => a.provider === p));
  if (present.length === 0) return { targets, labelled: true, guides };
  const counts = present.map((p) => agents.filter((a) => a.provider === p).length);
  const total = counts.reduce((n, c) => n + c, 0);
  // Each wedge gets a share of the sky by its head count, never less than a sixth.
  const shares = counts.map((c) => Math.max(1 / 6, c / total));
  const norm = shares.reduce((n, s) => n + s, 0);
  let start = -Math.PI / 2 + t * 0.00002;
  const longest = Math.max(4, ...agents.map((a) => a.name.length));
  const spacing = Math.min(18, longest + 4);
  let labelled = true;
  present.forEach((p, i) => {
    const span = (shares[i] / norm) * Math.PI * 2;
    const members = agents.filter((a) => a.provider === p).sort((x, y) => STATUS_ORDER[x.status] - STATUS_ORDER[y.status] || x.seq - y.seq);
    // Fill the wedge ring by ring, inner first, leaving a margin at each edge.
    let k = 0;
    const margin = Math.min(0.18, span * 0.12);
    for (let r = g.rIn; k < members.length; r += 2.4) {
      const last = r + 2.4 > g.rOut + 0.01;
      const arc = (span - 2 * margin) * r * (g.ax + 1) * 0.5;
      let cap = Math.max(1, Math.floor(arc / spacing));
      if (last) {
        if (members.length - k > cap) labelled = false;
        cap = members.length - k;
      }
      const row = members.slice(k, k + cap);
      row.forEach((m, j) => targets.set(m.name, { r: Math.min(r, g.rOut), a: start + margin + ((j + 0.5) / row.length) * (span - 2 * margin) }));
      k += row.length;
      if (last) break;
    }
    // The wedge's edge, and its name at the rim.
    const edgeIn = cell(g, { r: g.rd + 0.6, a: start });
    const edgeOut = cell(g, { r: g.rOut + 0.8, a: start });
    guides.lines.push({ x1: edgeIn.x, y1: edgeIn.y, x2: edgeOut.x, y2: edgeOut.y, color: scale(PROVIDER_RGB[p], 0.35) });
    const mid = cell(g, { r: g.rOut + 1.6, a: start + span / 2 });
    guides.labels.push({ x: mid.x, y: mid.y, text: `${p} · ${counts[i]}`, color: scale(PROVIDER_RGB[p], 0.85) });
    start += span;
  });
  return { targets, labelled, guides };
}

function teamsLayout(input: LayoutInput): LayoutResult {
  const { g, agents, t } = input;
  const guides = emptyGuides();
  const targets = new Map<string, Polar>();
  const groups = new Map<string, LayoutAgent[]>();
  for (const a of agents) groups.set(a.group, [...(groups.get(a.group) ?? []), a]);
  const list = [...groups.entries()].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]));
  if (list.length === 0) return { targets, labelled: true, guides };
  const band = g.rOut - g.rIn;
  const ringR = list.length === 1 ? g.rIn + band * 0.45 : (g.rIn + g.rOut) / 2;
  const weights = list.map(([, m]) => Math.sqrt(m.length) + 0.6);
  const totalW = weights.reduce((n, w) => n + w, 0);
  let angle = -Math.PI / 2 + t * 0.00003;
  list.forEach(([name, members], i) => {
    const span = (weights[i] / totalW) * Math.PI * 2;
    const centerA = angle + span / 2;
    angle += span;
    const cX = Math.cos(centerA) * ringR;
    const cY = Math.sin(centerA) * ringR;
    // A cluster's radius in rows: room for its members, never past the band.
    const radius = Math.min(band * 0.55, 0.8 + 0.85 * Math.sqrt(members.length));
    const sorted = [...members].sort((x, y) => STATUS_ORDER[x.status] - STATUS_ORDER[y.status] || x.seq - y.seq);
    sorted.forEach((m, k) => {
      // A sunflower: even spacing in a disk, working members at the heart.
      const rr = members.length === 1 ? 0 : radius * Math.sqrt((k + 0.5) / members.length);
      const phi = k * GOLDEN + hashName(name) * Math.PI * 2;
      targets.set(m.name, polar(cX + (Math.cos(phi) * rr * 2) / g.ax, cY + Math.sin(phi) * rr));
    });
    if (members.length < 2) return;
    const at = cell(g, polar(cX, cY + radius + 0.9));
    const working = members.filter((m) => m.status === "running").length;
    guides.labels.push({ x: at.x, y: at.y, text: `${name}${members.length > 1 ? ` ×${members.length}` : ""}${working > 0 ? ` · ${working} working` : ""}`, color: [139, 148, 158] });
  });
  return { targets, labelled: fits(g, agents, 0.55), guides };
}

function webLayout(input: LayoutInput): LayoutResult {
  const { g, agents, edges, chiefLinks, current } = input;
  const mid = (g.rIn + g.rOut) / 2;
  // Work in row units, with columns scaled so distances read evenly on screen.
  const k = g.ax / 2;
  const pos = new Map<string, { x: number; y: number }>();
  for (const a of agents) {
    const p = current.get(a.name) ?? { r: mid, a: hashName(a.name) * Math.PI * 2 };
    pos.set(a.name, { x: Math.cos(p.a) * p.r * k, y: Math.sin(p.a) * p.r });
  }
  const linked = new Map<string, number>();
  for (const e of edges) {
    linked.set(e.a, (linked.get(e.a) ?? 0) + e.weight);
    linked.set(e.b, (linked.get(e.b) ?? 0) + e.weight);
  }
  const names = agents.map((a) => a.name);
  for (let step = 0; step < 4; step++) {
    const force = new Map<string, { x: number; y: number }>(names.map((n) => [n, { x: 0, y: 0 }]));
    // Every pair pushes apart.
    for (let i = 0; i < names.length; i++) {
      const p = pos.get(names[i])!;
      for (let j = i + 1; j < names.length; j++) {
        const q = pos.get(names[j])!;
        let dx = p.x - q.x;
        let dy = p.y - q.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = hashName(names[i]) - 0.5;
          dy = hashName(names[j]) - 0.5;
          d2 = 0.25;
        }
        const f = Math.min(2, 9 / d2);
        const d = Math.sqrt(d2);
        force.get(names[i])!.x += (dx / d) * f;
        force.get(names[i])!.y += (dy / d) * f;
        force.get(names[j])!.x -= (dx / d) * f;
        force.get(names[j])!.y -= (dy / d) * f;
      }
    }
    // Lines pull together, harder for pairs that trade more notes.
    for (const e of edges) {
      const p = pos.get(e.a);
      const q = pos.get(e.b);
      if (!p || !q) continue;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d = Math.max(0.1, Math.hypot(dx, dy));
      const f = 0.18 * (d - 4.5) * Math.min(2, Math.log2(1 + e.weight));
      force.get(e.a)!.x += (dx / d) * f;
      force.get(e.a)!.y += (dy / d) * f;
      force.get(e.b)!.x -= (dx / d) * f;
      force.get(e.b)!.y -= (dy / d) * f;
    }
    // Radial pull: close to the hole for the chief's links, the rim for loners.
    for (const n of names) {
      const p = pos.get(n)!;
      const r = Math.max(0.1, Math.hypot(p.x / k, p.y));
      const want = chiefLinks.has(n) ? g.rIn + 0.5 : linked.has(n) ? mid : g.rOut;
      const f = 0.12 * (want - r);
      force.get(n)!.x += ((p.x / k) / r) * f * k;
      force.get(n)!.y += (p.y / r) * f;
    }
    for (const n of names) {
      const p = pos.get(n)!;
      const f = force.get(n)!;
      const len = Math.hypot(f.x, f.y);
      const cap = len > 1.2 ? 1.2 / len : 1;
      p.x += f.x * 0.35 * cap;
      p.y += f.y * 0.35 * cap;
      // Stay between the disk and the rim.
      const r = Math.hypot(p.x / k, p.y);
      const clamped = Math.max(g.rIn, Math.min(g.rOut, r));
      if (r > 0 && clamped !== r) {
        p.x *= clamped / r;
        p.y *= clamped / r;
      }
    }
  }
  const targets = new Map<string, Polar>();
  for (const n of names) {
    const p = pos.get(n)!;
    targets.set(n, polar(p.x / k, p.y));
  }
  return { targets, labelled: fits(g, agents, 0.7), guides: emptyGuides() };
}

function spendLayout(input: LayoutInput): LayoutResult {
  const { g, agents, t } = input;
  const guides = emptyGuides();
  const targets = new Map<string, Polar>();
  const max = Math.max(0, ...agents.map((a) => a.spendUsd));
  const ranked = [...agents].sort((x, y) => y.spendUsd - x.spendUsd || x.seq - y.seq);
  const radiusFor = (usd: number) => (max > 0 ? g.rIn + Math.pow(1 - usd / max, 0.6) * (g.rOut - g.rIn) : g.rOut);
  ranked.forEach((a, i) => targets.set(a.name, { r: radiusFor(a.spendUsd), a: i * GOLDEN + t * 0.00003 }));
  if (max > 0) {
    // Two rings of equal spend, labelled on opposite sides so the labels never meet.
    [max, max / 4].forEach((level, i) => {
      const r = radiusFor(level);
      guides.rings.push({ r, color: scale(GOLD, 0.28) });
      const at = cell(g, { r, a: i === 0 ? 0 : Math.PI });
      guides.labels.push({ x: at.x + (i === 0 ? 3 : -3), y: at.y, text: level >= 0.1 ? `$${level.toFixed(2)}` : `$${level.toFixed(3)}`, color: scale(GOLD, 0.85) });
    });
  }
  return { targets, labelled: fits(g, agents, 0.7), guides };
}

function spiralLayout(input: LayoutInput): LayoutResult {
  const { g, agents, t } = input;
  const guides = emptyGuides();
  const targets = new Map<string, Polar>();
  const ordered = [...agents].sort((x, y) => x.seq - y.seq || x.name.localeCompare(y.name));
  const turn = t * 0.00004;
  const at = (r: number, arm: number): number => turn + arm * Math.PI + 4.6 * Math.log(r / g.rIn);
  const perArm = Math.ceil(ordered.length / 2);
  ordered.forEach((a, i) => {
    const arm = i % 2;
    const step = Math.floor(i / 2);
    const r = g.rIn + (g.rOut - g.rIn) * (perArm <= 1 ? 0 : step / (perArm - 1));
    targets.set(a.name, { r, a: at(r, arm) });
  });
  for (let arm = 0; arm < 2; arm++) {
    for (let r = g.rIn - 0.6; r <= g.rOut + 0.6; r += 0.35) guides.path.push({ ...cell(g, { r, a: at(r, arm) }), color: GUIDE });
  }
  return { targets, labelled: fits(g, agents, 0.6), guides };
}

export function layout(id: LayoutId, input: LayoutInput): LayoutResult {
  switch (id) {
    case "orbit":
      return orbitLayout(input);
    case "providers":
      return providersLayout(input);
    case "teams":
      return teamsLayout(input);
    case "web":
      return webLayout(input);
    case "spend":
      return spendLayout(input);
    case "spiral":
      return spiralLayout(input);
  }
}

/**
 * The layout `auto` shows. A swarm reads best as teams. Notes flying
 * between agents read best as a web. A large team on several providers
 * reads best as providers. Anything else is an orbit.
 */
export function autoLayout(agents: LayoutAgent[], recentExchanges: number): LayoutId {
  const groups = new Map<string, number>();
  for (const a of agents) groups.set(a.group, (groups.get(a.group) ?? 0) + 1);
  const biggest = Math.max(0, ...groups.values());
  if (agents.length >= 6 && biggest >= 4) return "teams";
  if (recentExchanges >= 3) return "web";
  if (agents.length >= 9 && new Set(agents.map((a) => a.provider)).size >= 2) return "providers";
  return "orbit";
}

/** The next or previous choice in the bar: auto, then the six layouts. */
export function cycleLayout(choice: LayoutChoice, dir: 1 | -1): LayoutChoice {
  const order: LayoutChoice[] = ["auto", ...LAYOUTS.map((l) => l.id)];
  const i = order.indexOf(choice);
  return order[(i + dir + order.length) % order.length];
}


const PREFS = (): string => path.join(ceoHome(), "sky.json");

/** The layout last chosen, remembered across sessions. Auto when none was. CEO_SKY_LAYOUT wins. */
export function readSkyLayout(): LayoutChoice {
  const env = process.env.CEO_SKY_LAYOUT?.trim();
  if (env === "auto" || LAYOUTS.some((l) => l.id === env)) return env as LayoutChoice;
  try {
    const v = JSON.parse(readFileSync(PREFS(), "utf8")).layout;
    return v === "auto" || LAYOUTS.some((l) => l.id === v) ? v : "auto";
  } catch {
    return "auto";
  }
}

export function writeSkyLayout(choice: LayoutChoice): void {
  try {
    const dir = path.dirname(PREFS());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(PREFS(), JSON.stringify({ layout: choice }) + "\n");
  } catch {
    /* a preference that cannot be saved is chosen again next time */
  }
}
