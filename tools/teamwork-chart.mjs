#!/usr/bin/env node
// Draws docs/teamwork.svg from `ceo experiment report <dir> --json`.
// The report needs one independent and one team condition on the same sizes.
//   node tools/teamwork-chart.mjs report.json > docs/teamwork.svg
import { readFileSync } from "node:fs";

const r = JSON.parse(readFileSync(process.argv[2] ?? 0, "utf8"));
const ind = r.conditions.find((c) => c.mode === "independent");
const team = r.conditions.find((c) => c.mode === "team");
if (!ind || !team) throw new Error("The report needs an independent and a team condition.");

const W = 960, H = 440;
const L = 86, R = 640, T = 92, B = 372;
const sizes = ind.sizes.map((s) => s.size);
const lx = (n) => L + ((Math.log2(n) - Math.log2(sizes[0])) / (Math.log2(sizes.at(-1)) - Math.log2(sizes[0]))) * (R - L);
const ly = (p) => B - p * (B - T);
const pts = (rows, f) => rows.map((s) => [lx(s.size), ly(f(s))]);
const path = (p) => p.map(([x, y], i) => `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
const band = (lo, hi) => `${path(hi)} ${lo.slice().reverse().map(([x, y]) => `L ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")} Z`;
const pct = (p) => `${(p * 100).toFixed(0)}%`;
const pts1 = (p) => `${p >= 0 ? "+" : "−"}${Math.abs(p * 100).toFixed(1)} pts`;

const naive = pts(ind.sizes, (s) => s.naive);
const sampling = pts(ind.sizes, (s) => s.sampling);
const indObs = pts(ind.sizes, (s) => s.observed.mean);
const teamObs = pts(team.sizes, (s) => s.observed.mean);

const gain = (s) => s.coordination?.mean ?? -1;
const peak = team.sizes.reduce((a, s) => (gain(s) > gain(a) ? s : a));
const last = ind.sizes.at(-1);
const lastTeam = team.sizes.at(-1);
const lost = last.observed.mean - last.sampling;
const p = r.planted ?? {};

const C = { bg0: "#0d1117", bg1: "#11161d", grid: "#21262d", axis: "#8b949e", text: "#c9d1d9", dim: "#8b949e",
  naive: "#6e7681", sampling: "#8b949e", ind: "#58a6ff", team: "#3fb950", lost: "#f85149" };
const mono = `font-family="Menlo, SFMono-Regular, Consolas, 'Liberation Mono', 'DejaVu Sans Mono', monospace"`;

const out = [];
out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tasks solved by team size on the simulator. Independent tries fall short of the sampling prediction. A team adds ${pts1(gain(peak))} at ${peak.size} agents.">`);
out.push(`<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.bg0}"/><stop offset="1" stop-color="${C.bg1}"/></linearGradient></defs>`);
out.push(`<rect width="${W}" height="${H}" rx="18" fill="url(#bg)"/>`);
out.push(`<g ${mono}>`);
out.push(`<text x="${L - 50}" y="44" font-size="18" fill="${C.text}">Solved, by team size</text>`);
out.push(`<text x="${L - 50}" y="68" font-size="12" fill="${C.dim}">simulator · ${r.tasks} tasks × ${r.seeds} seeds · planted synergy ${p.synergy ?? "?"} · run correlation ${p.runCorrelation ?? "?"}</text>`);

for (let q = 0; q <= 1.0001; q += 0.25) {
  out.push(`<line x1="${L}" x2="${R}" y1="${ly(q)}" y2="${ly(q)}" stroke="${C.grid}"/>`);
  out.push(`<text x="${L - 10}" y="${ly(q) + 4}" font-size="11" fill="${C.axis}" text-anchor="end">${pct(q)}</text>`);
}
for (const n of sizes) {
  out.push(`<line x1="${lx(n)}" x2="${lx(n)}" y1="${B}" y2="${B + 5}" stroke="${C.axis}"/>`);
  out.push(`<text x="${lx(n)}" y="${B + 20}" font-size="11" fill="${C.axis}" text-anchor="middle">${n}</text>`);
}
out.push(`<text x="${(L + R) / 2}" y="${B + 42}" font-size="12" fill="${C.dim}" text-anchor="middle">agents on one task</text>`);

out.push(`<path d="${band(indObs, sampling)}" fill="${C.lost}" opacity="0.16"/>`);
out.push(`<path d="${band(indObs, teamObs)}" fill="${C.team}" opacity="0.42"/>`);
out.push(`<path d="${path(naive)}" fill="none" stroke="${C.naive}" stroke-width="2" stroke-dasharray="6 5"/>`);
out.push(`<path d="${path(sampling)}" fill="none" stroke="${C.sampling}" stroke-width="2"/>`);
out.push(`<path d="${path(indObs)}" fill="none" stroke="${C.ind}" stroke-width="2.5"/>`);
out.push(`<path d="${path(teamObs)}" fill="none" stroke="${C.team}" stroke-width="2.5"/>`);
for (const [rows, col] of [[ind.sizes, C.ind], [team.sizes, C.team]]) {
  for (const s of rows) if (s.truth != null) out.push(`<circle cx="${lx(s.size)}" cy="${ly(s.truth)}" r="4.5" fill="none" stroke="${col}" stroke-width="1.5"/>`);
  for (const s of rows) out.push(`<circle cx="${lx(s.size)}" cy="${ly(s.observed.mean)}" r="2.5" fill="${col}"/>`);
}

const kx = 672;
let ky = 112;
const key = (draw, label, value) => {
  out.push(draw(kx, ky));
  out.push(`<text x="${kx + 34}" y="${ky + 4}" font-size="12" fill="${C.text}">${label}</text>`);
  if (value) out.push(`<text x="${W - 30}" y="${ky + 4}" font-size="12" fill="${C.dim}" text-anchor="end">${value}</text>`);
  ky += 26;
};
const line = (col, dash = "") => (x, y) => `<line x1="${x}" x2="${x + 24}" y1="${y}" y2="${y}" stroke="${col}" stroke-width="2.5" ${dash}/>`;
const swatch = (col, op) => (x, y) => `<rect x="${x}" y="${y - 7}" width="24" height="14" fill="${col}" opacity="${op}"/>`;
out.push(`<text x="${kx}" y="${ky - 22}" font-size="11" fill="${C.dim}">at ${last.size} agents</text>`);
key(line(C.naive, `stroke-dasharray="6 5"`), "naive", pct(last.naive));
key(line(C.sampling), "sampling", pct(last.sampling));
key(line(C.team), "team", pct(lastTeam.observed.mean));
key(line(C.ind), "independent", pct(last.observed.mean));
key((x, y) => `<circle cx="${x + 12}" cy="${y}" r="4.5" fill="none" stroke="${C.text}" stroke-width="1.5"/>`, "model truth", "");
ky += 10;
key(swatch(C.lost, 0.35), "correlated failures", pts1(lost));
key(swatch(C.team, 0.6), "teamwork, peak", `${pts1(gain(peak))} at ${peak.size}`);
ky += 10;
const note = ["naive: one rate, tries independent.", "sampling: each task's own rate.", "The simulator plants the answer.", "The analysis has to find it."];
for (const n of note) { out.push(`<text x="${kx}" y="${ky}" font-size="11" fill="${C.dim}">${n}</text>`); ky += 17; }
out.push(`</g></svg>`);
process.stdout.write(out.join("\n") + "\n");
