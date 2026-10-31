/**
 * The constellation view: the org as a sky, live.
 *
 * `drawSky` in `../sky.ts` draws a frame. This component owns everything
 * that moves: the clock, the disk's spin, each star's eased position, and
 * which notes are comets in flight. A new agent is born at the horizon and
 * drifts out to its orbit. An agent that starts work spirals in. A note
 * seen for the first time flies from sender to receiver over three
 * seconds. Notes already on the board when the view opens stay lines.
 *
 * ← and → move between stars. Enter opens the selected agent. The rest of
 * the keys belong to the dashboard: esc or O closes, L switches to the
 * cards, C opens the chat.
 */

import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";

import type { OrgMessage } from "../../core/collab.js";
import { cooldowns, waitLabel } from "../../core/limits.js";
import type { Task } from "../../core/tasks.js";
import { PROVIDERS, type AgentRecord, type Provider } from "../../core/types.js";
import { clock, fit, shortModel } from "../format.js";
import type { RunState } from "../runs.js";
import {
  drawSky,
  ease,
  geometry,
  KIND_RGB,
  orbitTargets,
  paint,
  PROVIDER_RGB,
  rowToAnsi,
  truecolorSupported,
  YOU_RGB,
  type Rgb,
  type SkyComet,
  type SkyEdge,
  type SkyRipple,
  type SkyStar,
  type StarStatus,
} from "../sky.js";
import { exchanges, type Exchange } from "./LiveBoard.js";

export type SkyProps = {
  workspaceName: string;
  agents: AgentRecord[];
  runs: RunState[];
  messages: OrgMessage[];
  tasks: Task[];
  flash: { text: string; tone: "ok" | "error" } | null;
  width: number;
  height: number;
  onOpen: (agent: string) => void;
};

const FRAME_MS = 70;
const COMET_MS = 3200;
const RIPPLE_MS = 2600;
const DIM: Rgb = [110, 118, 129];
const TEXT: Rgb = [230, 237, 243];
const ACCENT: Rgb = [255, 166, 87];

function statusOf(run: RunState | undefined, now: number): StarStatus {
  if (!run) return "idle";
  if (run.status === "running") return "running";
  if (run.status === "waiting") return "waiting";
  const age = now - (run.finishedAt ?? now);
  if (run.status === "failed" && age < 5 * 60_000) return "failed";
  if (run.status === "done" && age < 2 * 60_000) return "done";
  return "idle";
}

function exchangeKey(e: Exchange): string {
  return `${e.ts}\u0000${e.from}\u0000${e.to}\u0000${e.kind}`;
}

/**
 * An agent running a task as attempts shows as one star per attempt, named
 * for the agent and the arm: `fixer·codex·9f`. An attempt that settled more
 * than two minutes ago leaves the sky.
 */
function withAttemptStars(agents: AgentRecord[], runs: RunState[], now: number): { agents: AgentRecord[]; runs: RunState[] } {
  const extra: AgentRecord[] = [];
  const mapped: RunState[] = [];
  for (const r of runs) {
    if (!r.attemptId) {
      mapped.push(r);
      continue;
    }
    if (r.finishedAt && now - r.finishedAt > 2 * 60_000) continue;
    const base = agents.find((a) => a.name === r.agent);
    if (!base) continue;
    const provider = r.provider ?? base.provider;
    const name = `${r.agent}·${provider}·${r.attemptId.slice(0, 2)}`;
    if (!extra.some((x) => x.name === name)) extra.push({ ...base, name, provider, chief: false });
    mapped.push({ ...r, agent: name });
  }
  return { agents: [...agents, ...extra], runs: mapped };
}

export function Sky(props: SkyProps) {
  const { width: W, height: H } = props;
  const { agents, runs } = withAttemptStars(props.agents, props.runs, Date.now());
  const canvasH = Math.max(8, H - 3);
  const truecolor = useMemo(() => truecolorSupported(), []);

  // The clock. Only this view animates, and only while it is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), FRAME_MS);
    return () => clearInterval(t);
  }, []);

  const last = useRef(now);
  const swirl = useRef(0);
  const positions = useRef(new Map<string, { r: number; a: number }>());
  const seen = useRef<Map<string, number> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const latest = new Map<string, RunState>();
  for (const r of runs) latest.set(r.agent, r);
  const chief = agents.find((a) => a.chief) ?? null;
  const crew = agents.filter((a) => !a.chief);
  const running = crew.filter((a) => latest.get(a.name)?.status === "running").length;
  const waiting = crew.filter((a) => latest.get(a.name)?.status === "waiting").length;
  const chiefActive = chief ? latest.get(chief.name)?.status === "running" : false;

  // Time since the last frame drives the spin and the easing, so a slow
  // frame moves things further rather than slowing the sky down.
  const dt = Math.min(250, Math.max(0, now - last.current));
  last.current = now;
  swirl.current += (dt / 1000) * Math.min(2.4, 0.45 + 0.22 * running + (chiefActive ? 0.6 : 0));

  const g = geometry(W, canvasH);
  const orbitAgents = crew.map((a) => {
    const run = latest.get(a.name);
    return { name: a.name, status: statusOf(run, now), since: run?.startedAt ?? 0 };
  });
  const { targets, labelled } = orbitTargets(g, orbitAgents, now);
  const k = 1 - Math.exp(-dt / 380);
  const pos = positions.current;
  for (const a of crew) {
    const target = targets.get(a.name);
    if (!target) continue;
    // A new agent is born at the horizon and drifts out to its orbit.
    const cur = pos.get(a.name) ?? { r: g.rh, a: target.a - 0.8 };
    pos.set(a.name, ease(cur, target, k));
  }
  for (const name of [...pos.keys()]) if (!crew.some((a) => a.name === name)) pos.delete(name);

  const where = (name: string): { x: number; y: number } | null => {
    if (name === "you") return { x: g.cx, y: 0 };
    if (chief && name === chief.name) return { x: g.cx, y: g.cy };
    const p = pos.get(name);
    if (!p) return null;
    return { x: g.cx + Math.cos(p.a) * p.r * g.ax, y: g.cy + Math.sin(p.a) * p.r };
  };
  const providerOf = new Map<string, Provider>(agents.map((a) => [a.name, a.provider]));
  const colorOf = (name: string): Rgb => (name === "you" ? YOU_RGB : PROVIDER_RGB[providerOf.get(name) ?? "claude"]);

  // Exchanges become lines, comets and ripples. The first time the view
  // sees the board, everything on it is history: lines, not comets.
  const all = exchanges(props.messages, props.tasks);
  if (seen.current === null) {
    seen.current = new Map(all.map((e) => [exchangeKey(e), 0]));
  }
  const firstSeen = seen.current;
  const comets: SkyComet[] = [];
  const ripples: SkyRipple[] = [];
  const pairs = new Map<string, { a: string; b: string; count: number; lastTs: number; from: string }>();
  for (const e of all) {
    const key = exchangeKey(e);
    if (!firstSeen.has(key)) firstSeen.set(key, now);
    const born = firstSeen.get(key) ?? 0;
    const age = now - born;
    if (e.to === "everyone") {
      const at = where(e.from);
      if (at && born > 0 && age < RIPPLE_MS) ripples.push({ x: at.x, y: at.y, p: age / RIPPLE_MS, color: colorOf(e.from) });
      continue;
    }
    const a = where(e.from);
    const b = where(e.to);
    if (!a || !b) continue;
    if (born > 0 && age < COMET_MS) {
      const trail = e.kind === "ask" ? KIND_RGB.ask : e.kind === "reply" ? KIND_RGB.reply : colorOf(e.from);
      comets.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, p: age / COMET_MS, head: colorOf(e.from), trail });
    }
    if (e.from === "you" || e.to === "you") continue;
    const [p, q] = [e.from, e.to].sort();
    const pk = `${p}\u0000${q}`;
    const pair = pairs.get(pk) ?? { a: p, b: q, count: 0, lastTs: 0, from: e.from };
    pair.count++;
    if (born >= pair.lastTs) {
      pair.lastTs = born;
      pair.from = e.from;
    }
    pairs.set(pk, pair);
  }
  const edges: SkyEdge[] = [];
  for (const pair of pairs.values()) {
    const a = where(pair.a);
    const b = where(pair.b);
    if (!a || !b) continue;
    const recent = pair.lastTs > 0 && now - pair.lastTs < 15_000;
    const mid: Rgb = colorOf(pair.from);
    edges.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: mid, strength: recent ? 1 : Math.min(0.8, 0.25 + pair.count * 0.12) });
  }

  const stars: SkyStar[] = [];
  for (const a of crew) {
    const at = where(a.name);
    if (!at) continue;
    const run = latest.get(a.name);
    const provider = run?.status === "running" && run.provider ? run.provider : a.provider;
    stars.push({ name: a.name, provider, status: statusOf(run, now), x: at.x, y: at.y });
  }

  // Selection follows the stars around the sky, clockwise from the top.
  const order = [...stars].sort((s1, s2) => Math.atan2(s1.y - g.cy, (s1.x - g.cx) / g.ax) - Math.atan2(s2.y - g.cy, (s2.x - g.cx) / g.ax));
  const names = order.map((s) => s.name);
  const current = selected && names.includes(selected) ? selected : null;
  useInput((input, key) => {
    if (names.length === 0) return;
    const i = current ? names.indexOf(current) : -1;
    if (key.rightArrow || key.downArrow || input === "\t" || input === "l" || input === "j") {
      setSelected(names[(i + 1) % names.length]);
    } else if (key.leftArrow || key.upArrow || input === "h" || input === "k") {
      setSelected(names[(i - 1 + names.length * 2) % names.length]);
    } else if (key.return && current) {
      props.onOpen(current);
    }
  });

  const cells = drawSky({
    width: W,
    height: canvasH,
    t: now,
    swirl: swirl.current,
    stars,
    edges,
    comets,
    ripples,
    labelled,
    selected: current,
    centerLabel: chief?.name ?? null,
    centerActive: Boolean(chiefActive),
  });

  // The header: what is out there, and which providers are waiting out a limit.
  const counts = PROVIDERS.map((p) => ({ p, n: crew.filter((a) => a.provider === p).length })).filter((c) => c.n > 0);
  const limited = PROVIDERS.flatMap((p) => {
    const c = cooldowns.get(p);
    return c && c.until > now ? [`${p} back in ${waitLabel(c.until, now)}`] : [];
  });
  const leftParts = [
    paint("✦ Constellation", ACCENT, { bold: true, truecolor }),
    paint(` · ${props.workspaceName} · ${crew.length} agent${crew.length === 1 ? "" : "s"} · `, DIM, { truecolor }),
    paint(`${running} working`, running > 0 ? [227, 179, 65] : DIM, { bold: running > 0, truecolor }),
    waiting > 0 ? paint(` · ${waiting} waiting on a limit`, [227, 179, 65], { truecolor }) : "",
    limited.length > 0 ? paint(` · ${limited.join(" · ")}`, [227, 179, 65], { truecolor }) : "",
  ];
  const leftPlain = `✦ Constellation · ${props.workspaceName} · ${crew.length} agent${crew.length === 1 ? "" : "s"} · ${running} working${waiting > 0 ? ` · ${waiting} waiting on a limit` : ""}${limited.length > 0 ? ` · ${limited.join(" · ")}` : ""}`;
  const right = counts.map((c) => `● ${c.p} ${c.n}`).join("  ");
  const rightPainted = counts.map((c) => paint(`● ${c.p} ${c.n}`, PROVIDER_RGB[c.p], { truecolor })).join("  ");
  const gap = W - leftPlain.length - right.length - 2;
  const header = gap >= 1 ? ` ${leftParts.join("")}${" ".repeat(gap)}${rightPainted} ` : ` ${leftParts.join("")}`;

  // The info line: the selected star, or the latest exchange.
  let info = "";
  if (current) {
    const a = agents.find((x) => x.name === current);
    const run = latest.get(current);
    const status = statusOf(run, now);
    const doing =
      status === "running" && run
        ? `working · turn ${run.turns} · ${Math.floor((now - run.startedAt) / 1000)}s · ${run.task}`
        : status === "waiting" && run?.retryAt
          ? `waiting on a ${run.provider ?? a?.provider} limit · back in ${waitLabel(run.retryAt, now)} · ${run.task}`
          : run
            ? `${status} · ${run.task}`
            : `idle · ${a?.role.split("\n")[0] ?? ""}`;
    info =
      paint(` ${current}`, a ? PROVIDER_RGB[a.provider] : TEXT, { bold: true, truecolor }) +
      paint(` · ${a?.provider ?? ""} ${a ? shortModel(a.model) : ""} · ${fit(doing, Math.max(10, W - current.length - 30)).trimEnd()}`, DIM, { truecolor });
  } else {
    const e = all[all.length - 1];
    info = e
      ? paint(` ${clock(e.ts)}  `, DIM, { truecolor }) +
        paint(e.from, colorOf(e.from), { bold: true, truecolor }) +
        paint(" › ", DIM, { truecolor }) +
        paint(e.to, e.to === "everyone" ? TEXT : colorOf(e.to), { bold: true, truecolor }) +
        paint(`  ${e.kind}  ${fit(e.text.replace(/\s+/g, " "), Math.max(10, W - e.from.length - e.to.length - 26)).trimEnd()}`, DIM, { truecolor })
      : paint(" No exchanges yet. Notes between agents fly here as comets.", DIM, { truecolor });
  }

  // Only errors take the footer. A success message written for the
  // dashboard would hide the sky's own keys.
  const footer = props.flash?.tone === "error"
    ? paint(` ${fit(props.flash.text, W - 2)}`, [248, 81, 73], { truecolor })
    : [
        paint(" ← →", ACCENT, { truecolor }),
        paint(" a star  ", DIM, { truecolor }),
        paint("enter", ACCENT, { truecolor }),
        paint(" opens it  ", DIM, { truecolor }),
        paint("L", ACCENT, { truecolor }),
        paint(" cards  ", DIM, { truecolor }),
        paint("C", ACCENT, { truecolor }),
        paint(" chat  ", DIM, { truecolor }),
        paint("esc", ACCENT, { truecolor }),
        paint(" dashboard", DIM, { truecolor }),
        paint("     ✦ working  ◌ waiting  ✧ done  ✕ failed  • idle  ● a note in flight", DIM, { truecolor }),
      ].join("");

  return (
    <Box flexDirection="column" width={W}>
      <Text wrap="truncate">{header}</Text>
      {cells.map((row, i) => (
        <Text key={i} wrap="truncate">
          {rowToAnsi(row, truecolor)}
        </Text>
      ))}
      <Text wrap="truncate">{info}</Text>
      <Text wrap="truncate">{footer}</Text>
    </Box>
  );
}

export default Sky;
