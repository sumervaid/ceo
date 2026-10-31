/**
 * The constellation: the org drawn as a sky.
 *
 * The chief of staff is a black hole at the centre. An accretion disk
 * swirls around the horizon, faster as more agents work. Every other agent
 * is a star in orbit, in its provider's colour. A working agent spirals in
 * toward the disk and twinkles. An idle agent drifts on an outer ring.
 * Agents that have traded notes are joined by faint constellation lines.
 * A note in flight is a comet that bends around the hole on its way. A
 * note to everyone is a ripple from the sender.
 *
 * This module is pure. `geometry` and `orbitTargets` place things, and
 * `drawSky` turns a scene into a grid of cells. `rowToAnsi` and
 * `rowToText` turn a row of cells into what the terminal prints, or into
 * plain text for a test. The component in `components/Sky.tsx` owns time,
 * easing and input.
 */

import type { Provider } from "../core/types.js";

export type Rgb = [number, number, number];

export type StarStatus = "running" | "waiting" | "failed" | "done" | "idle";

/** GitHub dark's palette, so the sky matches the rest of the dashboard. */
export const PROVIDER_RGB: Record<Provider, Rgb> = {
  claude: [57, 197, 207],
  codex: [63, 185, 80],
  gemini: [121, 192, 255],
};
export const YOU_RGB: Rgb = [219, 97, 162];
const ASK_RGB: Rgb = [227, 179, 65];
const REPLY_RGB: Rgb = [86, 211, 100];
const FAIL_RGB: Rgb = [248, 81, 73];
const WAIT_RGB: Rgb = [227, 179, 65];
const RING_RGB: Rgb = [255, 241, 210];
const LABEL_RGB: Rgb = [139, 148, 158];

/** Hot near the horizon, violet at the rim. */
const DISK: Rgb[] = [
  [255, 250, 240],
  [255, 223, 182],
  [255, 166, 87],
  [247, 129, 102],
  [219, 97, 162],
  [137, 87, 229],
  [72, 52, 128],
];

export function scale(c: Rgb, k: number): Rgb {
  return [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)];
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

function diskColor(u: number): Rgb {
  const x = Math.max(0, Math.min(0.9999, u)) * (DISK.length - 1);
  const i = Math.floor(x);
  return mix(DISK[i], DISK[i + 1], x - i);
}

/** A stable pseudo-random number in [0, 1) for a pair of integers. */
function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function hashName(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

// -- geometry ---------------------------------------------------------------

/**
 * Distances are in rows. A cell is about twice as tall as wide, so a
 * column counts as a fraction of a row. `ax` is how many columns make one
 * row: two draws a circle. A wide terminal stretches the sky further, up
 * to three, which reads as a disk seen at a tilt.
 */
export type Geometry = {
  width: number;
  height: number;
  ax: number;
  cx: number;
  cy: number;
  /** The outermost orbit. */
  R: number;
  /** The event horizon. */
  rh: number;
  /** The outer edge of the accretion disk. */
  rd: number;
  /** The innermost and outermost orbits for stars. */
  rIn: number;
  rOut: number;
};

export function geometry(width: number, height: number): Geometry {
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const R = Math.max(3, Math.min(width / 4, height / 2) - 0.6);
  const ax = Math.max(2, Math.min(3, (width / 2 - 3) / R));
  const rh = Math.max(1.4, R * 0.14);
  const rd = Math.max(rh + 1.5, R * 0.5);
  const rIn = rd + 1.6;
  const rOut = Math.max(rIn, R);
  return { width, height, ax, cx, cy, R, rh, rd, rIn, rOut };
}

/** Polar to cell coordinates. */
export function toCell(g: Geometry, r: number, a: number): { x: number; y: number } {
  return { x: g.cx + Math.cos(a) * r * g.ax, y: g.cy + Math.sin(a) * r };
}

export type OrbitAgent = {
  name: string;
  status: StarStatus;
  /** When the agent last started or settled, for ordering. */
  since: number;
};

/** The orbits: radii and how many stars each holds. */
export function rings(g: Geometry, count: number, spacing: number): Array<{ r: number; capacity: number }> {
  const gap = 2.4;
  const out: Array<{ r: number; capacity: number }> = [];
  for (let r = g.rIn; r <= g.rOut + 0.01; r += gap) {
    // The perimeter of an ellipse with semi-axes ax·r and r, in cells.
    const a = g.ax * r;
    const perimeter = Math.PI * (3 * (a + r) - Math.sqrt((3 * a + r) * (a + 3 * r)));
    out.push({ r, capacity: Math.max(1, Math.floor(perimeter / spacing)) });
  }
  if (out.length === 0) out.push({ r: g.rIn, capacity: Math.max(1, count) });
  return out;
}

const STATUS_ORDER: Record<StarStatus, number> = { running: 0, waiting: 1, failed: 2, done: 3, idle: 4 };

/** How fast a ring turns, in radians per second. Inner rings turn faster. */
export function ringSpeed(g: Geometry, r: number): number {
  return 0.11 * Math.pow(g.rIn / Math.max(r, 0.1), 1.5);
}

/**
 * Where every agent should be at time `t`: working agents on the inner
 * rings, idle ones outside. Each ring turns at its own speed. The spacing
 * leaves room for names when the sky can hold them, and drops to bare
 * stars when it cannot, so a thousand agents still fit.
 */
export function orbitTargets(g: Geometry, agents: OrbitAgent[], t: number): { targets: Map<string, { r: number; a: number }>; labelled: boolean } {
  const sorted = [...agents].sort((x, y) => STATUS_ORDER[x.status] - STATUS_ORDER[y.status] || x.since - y.since || x.name.localeCompare(y.name));
  const longest = Math.max(4, ...agents.map((a) => a.name.length));
  let spacing = Math.min(18, longest + 4);
  let rs = rings(g, sorted.length, spacing);
  let labelled = true;
  if (rs.reduce((n, r) => n + r.capacity, 0) < sorted.length) {
    labelled = false;
    spacing = 3;
    rs = rings(g, sorted.length, spacing);
  }
  const total = rs.reduce((n, r) => n + r.capacity, 0);
  // More agents than the rings hold: the last ring takes the rest.
  if (total < sorted.length) rs[rs.length - 1].capacity += sorted.length - total;

  const targets = new Map<string, { r: number; a: number }>();
  let i = 0;
  for (const ring of rs) {
    const members = sorted.slice(i, i + ring.capacity);
    i += members.length;
    if (members.length === 0) break;
    const turn = ringSpeed(g, ring.r) * (t / 1000);
    const offset = hashName(String(ring.r.toFixed(1))) * Math.PI * 2;
    members.forEach((m, j) => {
      targets.set(m.name, { r: ring.r, a: offset + turn + (j / members.length) * Math.PI * 2 });
    });
  }
  return { targets, labelled };
}

/** Ease one position toward its target. The angle takes the short way round. */
export function ease(cur: { r: number; a: number }, target: { r: number; a: number }, k: number): { r: number; a: number } {
  let da = (target.a - cur.a) % (Math.PI * 2);
  if (da > Math.PI) da -= Math.PI * 2;
  if (da < -Math.PI) da += Math.PI * 2;
  return { r: cur.r + (target.r - cur.r) * k, a: cur.a + da * k };
}

// -- the scene --------------------------------------------------------------

export type SkyStar = {
  name: string;
  provider: Provider;
  status: StarStatus;
  x: number;
  y: number;
};

export type SkyComet = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Progress, 0 at the sender and 1 at the receiver. */
  p: number;
  head: Rgb;
  trail: Rgb;
};

export type SkyRipple = { x: number; y: number; p: number; color: Rgb };

export type SkyEdge = { x1: number; y1: number; x2: number; y2: number; color: Rgb; strength: number };

export type SkyScene = {
  width: number;
  height: number;
  /** Milliseconds, for every animation. */
  t: number;
  /** The disk's angle, which the component advances faster as more agents work. */
  swirl: number;
  stars: SkyStar[];
  edges: SkyEdge[];
  comets: SkyComet[];
  ripples: SkyRipple[];
  /** Draw names beside the stars. Off when the sky is crowded. */
  labelled: boolean;
  selected: string | null;
  /** The name written inside the horizon: the chief's. */
  centerLabel: string | null;
  /** True while the chief is replying: the horizon's ring brightens. */
  centerActive: boolean;
};

export type Cell = {
  ch: string;
  fg: Rgb | null;
  bold: boolean;
  inverse: boolean;
  /** Braille dots set in this cell, one bit per dot. */
  dots: number;
  dotFg: Rgb | null;
  /** Which layer last coloured the dots; a higher layer wins. */
  dotLayer: number;
};

// Braille dot bits by sub-cell position: column 0 or 1, row 0 to 3.
const DOT = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
];

const RUN_FRAMES = ["✦", "✶", "✷", "✸", "✷", "✶"];

class Grid {
  cells: Cell[][];
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.cells = Array.from({ length: h }, () =>
      Array.from({ length: w }, (): Cell => ({ ch: "", fg: null, bold: false, inverse: false, dots: 0, dotFg: null, dotLayer: -1 })),
    );
  }
  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }
  /** Set a braille dot at sub-cell coordinates: 2 per column, 4 per row. */
  dot(sx: number, sy: number, color: Rgb, layer: number): void {
    const x = Math.floor(sx / 2);
    const y = Math.floor(sy / 4);
    if (!this.inside(x, y)) return;
    const c = this.cells[y][x];
    if (c.ch) return;
    c.dots |= DOT[((sx % 2) + 2) % 2][((sy % 4) + 4) % 4];
    if (layer >= c.dotLayer) {
      c.dotFg = color;
      c.dotLayer = layer;
    }
  }
  put(x: number, y: number, ch: string, fg: Rgb | null, bold = false, inverse = false): void {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (!this.inside(xi, yi)) return;
    this.cells[yi][xi] = { ch, fg, bold, inverse, dots: 0, dotFg: null, dotLayer: -1 };
  }
  free(x: number, y: number, len: number): boolean {
    if (y < 0 || y >= this.h || x < 0 || x + len > this.w) return false;
    for (let i = 0; i < len; i++) if (this.cells[y][x + i].ch) return false;
    return true;
  }
  clear(x: number, y: number): void {
    if (this.inside(x, y)) this.cells[y][x] = { ch: " ", fg: null, bold: false, inverse: false, dots: 0, dotFg: null, dotLayer: -1 };
  }
}

/** A line of dots between two cell positions, every other dot for a dotted look. */
function dottedLine(grid: Grid, x1: number, y1: number, x2: number, y2: number, color: Rgb, layer: number, every = 2): void {
  const sx1 = Math.round(x1 * 2 + 1);
  const sy1 = Math.round(y1 * 4 + 2);
  const sx2 = Math.round(x2 * 2 + 1);
  const sy2 = Math.round(y2 * 4 + 2);
  const n = Math.max(Math.abs(sx2 - sx1), Math.abs(sy2 - sy1));
  for (let i = 0; i <= n; i += every) {
    const k = n === 0 ? 0 : i / n;
    grid.dot(Math.round(sx1 + (sx2 - sx1) * k), Math.round(sy1 + (sy2 - sy1) * k), color, layer);
  }
}

/** A point on a comet's path: a curve pulled toward the hole, as if the hole bent it. */
export function cometPoint(c: { x1: number; y1: number; x2: number; y2: number }, g: Geometry, p: number): { x: number; y: number } {
  const mx = (c.x1 + c.x2) / 2;
  const my = (c.y1 + c.y2) / 2;
  const qx = mx + (g.cx - mx) * 0.45;
  const qy = my + (g.cy - my) * 0.45;
  const u = 1 - p;
  return { x: u * u * c.x1 + 2 * u * p * qx + p * p * c.x2, y: u * u * c.y1 + 2 * u * p * qy + p * p * c.y2 };
}

/** Draw the scene. Layers, back to front: stars far away, the disk, lines, comets, stars, names. */
export function drawSky(scene: SkyScene): Cell[][] {
  const { width: W, height: H, t } = scene;
  const g = geometry(W, H);
  const grid = new Grid(W, H);

  // Distant stars, each twinkling on its own phase.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const h = hash2(x, y);
      if (h > 0.013) continue;
      const r = Math.hypot((x - g.cx) / g.ax, y - g.cy);
      if (r < g.rd + 0.5) continue;
      const tw = 0.28 + 0.22 * Math.sin(t / 700 + h * 4000);
      grid.put(x, y, h < 0.004 ? "∙" : "·", scale([201, 209, 217], tw));
    }
  }

  // The accretion disk: two spiral arms turning faster near the horizon.
  const sx0 = Math.max(0, Math.floor((g.cx - g.rd * g.ax - 1) * 2));
  const sx1 = Math.min(W * 2 - 1, Math.ceil((g.cx + g.rd * g.ax + 1) * 2));
  const sy0 = Math.max(0, Math.floor((g.cy - g.rd - 1) * 4));
  const sy1 = Math.min(H * 4 - 1, Math.ceil((g.cy + g.rd + 1) * 4));
  for (let sy = sy0; sy <= sy1; sy++) {
    for (let sx = sx0; sx <= sx1; sx++) {
      const px = (sx + 0.5) / 2;
      const py = (sy + 0.5) / 4;
      const dx = (px - g.cx - 0.5) / g.ax;
      const dy = py - g.cy - 0.5;
      const r = Math.hypot(dx, dy);
      if (r > g.rd || r < g.rh) continue;
      const theta = Math.atan2(dy, dx);
      const u = (r - g.rh) / (g.rd - g.rh);
      const spin = scene.swirl * Math.pow(g.rh / r, 1.5);
      const arm = (1 + Math.cos(2 * (theta - spin) - 3.4 * Math.log(r / g.rh))) / 2;
      const density = Math.pow(1 - u, 0.75) * (0.22 + 0.78 * Math.pow(arm, 1.6)) + 0.6 * Math.pow(1 - u, 4);
      // Noise rather than a regular dither, so the disk sparkles instead of striping.
      if (density <= hash2(sx, sy) * 0.92 + 0.04) continue;
      grid.dot(sx, sy, scale(diskColor(u), 0.72 + 0.28 * Math.min(1, density)), 1);
    }
  }

  // The photon ring, bright around the horizon, brighter while the chief replies.
  const ringColor = scale(RING_RGB, scene.centerActive ? 1 : 0.8);
  const steps = Math.ceil(g.rh * 2 * Math.PI * 6);
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const p = toCell(g, g.rh, a);
    grid.dot(Math.round(p.x * 2 + 1), Math.round(p.y * 4 + 2), ringColor, 6);
  }
  // The horizon itself is empty.
  for (let y = Math.floor(g.cy - g.rh); y <= Math.ceil(g.cy + g.rh); y++) {
    for (let x = Math.floor(g.cx - g.rh * g.ax); x <= Math.ceil(g.cx + g.rh * g.ax); x++) {
      if (Math.hypot((x - g.cx) / g.ax, y - g.cy) < g.rh - 0.6) grid.clear(x, y);
    }
  }

  // Constellation lines between agents that have traded notes.
  for (const e of scene.edges) {
    dottedLine(grid, e.x1, e.y1, e.x2, e.y2, scale(e.color, 0.22 + 0.4 * Math.min(1, e.strength)), 2, e.strength > 0.7 ? 2 : 3);
  }

  // Ripples: a note to everyone spreads from the sender.
  for (const rp of scene.ripples) {
    const rr = 1 + rp.p * g.R * 0.7;
    const fade = scale(rp.color, Math.max(0.15, 1 - rp.p));
    const n = Math.ceil(rr * 2 * Math.PI * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      grid.dot(Math.round((rp.x + Math.cos(a) * rr * g.ax) * 2 + 1), Math.round((rp.y + Math.sin(a) * rr) * 4 + 2), fade, 3);
    }
  }

  // Comet trails.
  for (const c of scene.comets) {
    for (let k = 14; k >= 1; k--) {
      const p = c.p - k * 0.022;
      if (p < 0) continue;
      const pt = cometPoint(c, g, p);
      const fade = 1 - k / 15;
      grid.dot(Math.round(pt.x * 2 + 1), Math.round(pt.y * 4 + 2), scale(c.trail, 0.25 + 0.75 * fade), 4);
      if (k % 2 === 0) grid.dot(Math.round(pt.x * 2 + 2), Math.round(pt.y * 4 + 2), scale(c.trail, 0.2 + 0.5 * fade), 4);
    }
  }

  // The chief's name inside the horizon.
  if (scene.centerLabel && g.rh * 2 >= 2.5) {
    const label = `◆ ${scene.centerLabel}`.slice(0, Math.max(1, Math.floor(g.rh * 4 - 2)));
    const lx = Math.round(g.cx - label.length / 2 + 0.5);
    const ly = Math.round(g.cy);
    [...label].forEach((ch, i) => grid.put(lx + i, ly, ch, ch === "◆" ? ringColor : [230, 237, 243], true));
  }

  // Stars.
  for (const s of scene.stars) {
    const base = PROVIDER_RGB[s.provider];
    const x = Math.round(s.x);
    const y = Math.round(s.y);
    const phase = hashName(s.name);
    if (s.status === "running") {
      const pulse = 0.5 + 0.5 * Math.sin(t / 260 + phase * 6.283);
      const frame = RUN_FRAMES[Math.floor(t / 140 + phase * 12) % RUN_FRAMES.length];
      grid.put(x, y, frame, mix(base, [255, 255, 255], 0.25 * pulse), true);
    } else if (s.status === "waiting") {
      grid.put(x, y, "◌", WAIT_RGB, true);
    } else if (s.status === "failed") {
      grid.put(x, y, "✕", FAIL_RGB, true);
    } else if (s.status === "done") {
      grid.put(x, y, "✧", base, true);
    } else {
      grid.put(x, y, "•", scale(base, 0.62));
    }
  }

  // Comet heads ride above the stars they pass.
  for (const c of scene.comets) {
    const pt = cometPoint(c, g, c.p);
    // A comet that reaches the hole vanishes behind the horizon.
    if (Math.hypot((pt.x - g.cx) / g.ax, pt.y - g.cy) < g.rh + 0.3) continue;
    grid.put(pt.x, pt.y, c.p > 0.92 ? "✺" : "●", c.head, true);
  }

  // Names: the selected star first, then the working ones, then the rest,
  // each wherever there is room.
  const order = [...scene.stars].sort((a, b) => Number(b.name === scene.selected) - Number(a.name === scene.selected) || STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  for (const s of order) {
    const selected = s.name === scene.selected;
    if (!scene.labelled && !selected && s.status !== "running") continue;
    const label = selected ? ` ${s.name} ` : s.name;
    const x = Math.round(s.x);
    const y = Math.round(s.y);
    const right = x + 2;
    const left = x - 1 - label.length;
    const at = grid.free(right, y, label.length) ? right : grid.free(left, y, label.length) ? left : null;
    if (at === null) continue;
    const color = selected ? PROVIDER_RGB[s.provider] : s.status === "running" ? mix(PROVIDER_RGB[s.provider], [230, 237, 243], 0.35) : LABEL_RGB;
    [...label].forEach((ch, i) => grid.put(at + i, y, ch, color, selected || s.status === "running", selected));
  }

  return grid.cells;
}

// -- output -----------------------------------------------------------------

const BRAILLE = 0x2800;

function cellChar(c: Cell): string {
  if (c.ch) return c.ch;
  if (c.dots) return String.fromCharCode(BRAILLE + c.dots);
  return " ";
}

function cellColor(c: Cell): Rgb | null {
  return c.ch ? c.fg : c.dots ? c.dotFg : null;
}

/** The nearest xterm-256 colour, for terminals without 24-bit colour. */
function to256(c: Rgb): number {
  const [r, g, b] = c;
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 23);
  }
  const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.round((v - 35) / 40));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/** Whether to write 24-bit colour. Terminal.app is the common terminal that cannot show it. */
export function truecolorSupported(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CEO_TRUECOLOR === "0") return false;
  if (env.CEO_TRUECOLOR === "1") return true;
  if (/truecolor|24bit/i.test(env.COLORTERM ?? "")) return true;
  return env.TERM_PROGRAM !== "Apple_Terminal";
}

/** One row as the terminal prints it, with colour codes merged across runs of one style. */
export function rowToAnsi(row: Cell[], truecolor = true): string {
  let out = "";
  let style = "";
  for (const c of row) {
    const color = cellColor(c);
    const next = color
      ? `${c.ch && c.bold ? "\x1b[1m" : ""}${c.ch && c.inverse ? "\x1b[7m" : ""}${truecolor ? `\x1b[38;2;${color[0]};${color[1]};${color[2]}m` : `\x1b[38;5;${to256(color)}m`}`
      : "";
    if (next !== style) {
      out += "\x1b[0m" + next;
      style = next;
    }
    out += cellChar(c);
  }
  return out + "\x1b[0m";
}

/** One row as plain text, for tests. */
export function rowToText(row: Cell[]): string {
  return row.map(cellChar).join("");
}

/** Colour a short run of text the way the sky does, for the header and footer. */
export function paint(text: string, color: Rgb | null, opts: { bold?: boolean; truecolor?: boolean } = {}): string {
  if (!color) return text;
  const tc = opts.truecolor ?? true;
  const code = tc ? `\x1b[38;2;${color[0]};${color[1]};${color[2]}m` : `\x1b[38;5;${to256(color)}m`;
  return `${opts.bold ? "\x1b[1m" : ""}${code}${text}\x1b[0m`;
}

export const KIND_RGB = { ask: ASK_RGB, reply: REPLY_RGB };
