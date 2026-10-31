/**
 * Start a company: a whole team in one keystroke.
 *
 * The list on top is the companies. The block below is exactly what enter
 * would hire: every seat with the provider it lands on, its level, its cap
 * and whether it gets a worktree, then the total of the caps. Nothing is
 * hidden behind a second screen, so the decision takes one look.
 *
 * `w` cycles the worktree choice for the whole company. ← and → set the
 * team size: at ×8 every seat becomes eight agents, dealt across the ready
 * providers. Enter hires every
 * seat and the chief of staff, then the dashboard opens the chat, because
 * the next useful thing is a sentence to the chief.
 */

import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";

import { COMPANIES, MAX_SCALE, planCompany, WORKTREE_LABEL, WORKTREE_MODES, type CompanyPlan, type WorktreeMode } from "../../core/companies.js";
import { describeSpread } from "../../core/swarm.js";
import { CHIEF_ALLOWANCE_USD } from "../../core/chat.js";
import { isEscape, isReturn } from "../keys.js";
import { autonomyColor, clamp, compactBudget, fit, providerColor, shortModel } from "../format.js";
import { clipRow, type Row } from "../chat.js";
import { providerFor } from "../../core/providers.js";
import type { Provider } from "../../core/types.js";
import Modal from "./Modal.js";

export type CompanyPickerProps = {
  cwd: string;
  width: number;
  onHire: (plan: CompanyPlan) => void;
  onClose: () => void;
};

function RowView({ row, width }: { row: Row; width: number }) {
  const segs = clipRow(row, width);
  if (segs.length === 0) return <Text> </Text>;
  return (
    <Text wrap="truncate">
      {segs.map((s, i) => (
        <Text key={i} color={s.color} dimColor={s.dim} bold={s.bold}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

function providerSpan(providers: string[]): Row {
  const out: Row = [];
  providers.forEach((p, i) => {
    if (i > 0) out.push({ text: " ", dim: true });
    out.push({ text: p, color: providerColor(p as never) });
  });
  return out;
}

/** The next team size: one step at a time up to five, then larger steps. */
function nextSize(s: number, dir: 1 | -1): number {
  const steps = [1, 2, 3, 4, 5, 8, 10, 12, 16, 20, 25, 30, 40, 50];
  if (dir > 0) return steps.find((n) => n > s) ?? s;
  return [...steps].reverse().find((n) => n < s) ?? 1;
}

export function CompanyPicker({ cwd, width, onHire, onClose }: CompanyPickerProps) {
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<WorktreeMode | null>(null);
  const [scale, setScale] = useState(1);
  const inner = Math.max(20, width - 4);

  // One plan per company, read once per worktree choice. A plan reads the
  // roster and the providers' readiness, which is cheap and does not change
  // while the picker is open.
  const plans = useMemo(
    () => COMPANIES.map((c) => planCompany(c, cwd, { ...(mode ? { worktrees: mode } : {}), scale })),
    [cwd, mode, scale],
  );
  const plan = plans[index];
  const effective = plan.worktrees;

  useInput((input, key) => {
    if (isEscape(input, key)) {
      onClose();
      return;
    }
    if (key.upArrow || input === "k") {
      setIndex((i) => (i - 1 + COMPANIES.length) % COMPANIES.length);
      return;
    }
    if (key.downArrow || input === "j") {
      setIndex((i) => (i + 1) % COMPANIES.length);
      return;
    }
    if (/^[1-9]$/.test(input) && Number(input) <= COMPANIES.length) {
      setIndex(Number(input) - 1);
      return;
    }
    if (key.rightArrow || input === "l" || input === "=") {
      setScale((s) => Math.min(MAX_SCALE, nextSize(s, 1)));
      return;
    }
    if (key.leftArrow || input === "h" || input === "-") {
      setScale((s) => Math.max(1, nextSize(s, -1)));
      return;
    }
    if (input === "w") {
      const at = WORKTREE_MODES.indexOf(mode ?? effective);
      setMode(WORKTREE_MODES[(at + 1) % WORKTREE_MODES.length]);
      return;
    }
    if (isReturn(input, key)) onHire(plan);
  });

  const titleWidth = clamp(Math.max(...COMPANIES.map((c) => c.title.length)), 12, 20);
  const nameWidth = clamp(Math.max(...plan.seats.map((s) => s.name.length), plan.chief.name.length), 6, 14);

  const list: Row[] = plans.map((p, i) => {
    const hires = p.seats.filter((s) => !s.skip).length + (p.chief.hire ? 1 : 0);
    const selected = i === index;
    return [
      { text: selected ? "❯ " : "  ", color: "cyan", bold: true },
      { text: `${i + 1} `, dim: true },
      { text: p.template.title.padEnd(titleWidth + 2), bold: selected },
      { text: `${String(hires).padStart(2)} agents  `, dim: !selected },
      ...providerSpan(p.providers),
      { text: `  ${compactBudget(p.totalCapUsd)} in budgets`, dim: true },
    ];
  });

  const seatRow = (name: string, provider: string, model: string, level: string, cap: number, extra: Row, mark: string, skip: string | null): Row => {
    if (skip) return [{ text: `  ${mark} `, dim: true }, { text: name.padEnd(nameWidth + 1), dim: true }, { text: skip, dim: true }];
    return [
      { text: `  ${mark} `, color: providerColor(provider as never), bold: mark === "◆" },
      { text: name.padEnd(nameWidth + 1), bold: mark === "◆" },
      { text: provider.padEnd(7), color: providerColor(provider as never) },
      { text: shortModel(model).padEnd(14), dim: true },
      { text: level.padEnd(11), color: autonomyColor(level as never) },
      { text: compactBudget(cap).padEnd(5) },
      ...extra,
    ];
  };

  const seats: Row[] = [];
  const groupWidth = clamp(Math.max(...plan.seats.map((s) => s.group.length)) + 4, 8, 18);
  if (plan.chief.hire) {
    seats.push(seatRow(plan.chief.name, plan.chief.provider, providerFor(plan.chief.provider as Provider).defaultModel(), "execute", 0, [{ text: `chief of staff · no cap · ${compactBudget(CHIEF_ALLOWANCE_USD)} to give out`, dim: true }], "◆", null));
  }
  if (plan.scale === 1) {
    for (const s of plan.seats) {
      const extra: Row = [];
      if (s.isolated) extra.push({ text: "⎇ worktree", color: "cyan" });
      if (s.movedFrom) extra.push({ text: `${s.isolated ? "  " : ""}${s.movedFrom} not ready`, color: "yellow" });
      seats.push(seatRow(s.name, s.provider, s.model, s.autonomy, s.budgetUsd, extra, "●", s.skip));
    }
  } else {
    // A scaled company reads one row per seat: the swarm, its spread, its level.
    for (const group of [...new Set(plan.seats.map((s) => s.group))]) {
      const members = plan.seats.filter((s) => s.group === group);
      const first = members[0];
      const spread = describeSpread(members.map((m) => m.provider));
      seats.push([
        { text: "  ✦ ", color: providerColor(first.provider), bold: true },
        { text: `${group} ×${members.length}`.padEnd(groupWidth), bold: true },
        { text: first.autonomy.padEnd(11), color: autonomyColor(first.autonomy) },
        { text: `${compactBudget(first.budgetUsd)} each`.padEnd(11) },
        { text: spread, dim: true },
        ...(first.isolated ? [{ text: "  ⎇ worktrees", color: "cyan" }] : []),
      ]);
    }
  }
  const hires = plan.seats.filter((s) => !s.skip).length + (plan.chief.hire ? 1 : 0);

  const sizeLine: Row = [
    { text: "team size  ", dim: true },
    { text: `×${plan.scale}`, bold: true, color: plan.scale > 1 ? "magenta" : undefined },
    { text: `  ${hires} agents · ← → changes`, dim: true },
  ];

  const worktreeLine: Row = [
    { text: "worktrees  ", dim: true },
    { text: WORKTREE_LABEL[effective], color: effective === "none" ? undefined : "cyan" },
    ...(plan.worktreeNote ? [{ text: `  ${plan.worktreeNote}`, color: "yellow" }] : [{ text: "  w changes", dim: true }]),
  ];

  return (
    <Modal title="Start a company" footer="↑↓ or 1-6 pick · ← → team size · w worktrees · enter hire and open the chat · esc close" width={width}>
      {list.map((row, i) => (
        <RowView key={i} row={row} width={inner} />
      ))}
      <Text> </Text>
      <RowView row={[{ text: plan.template.title, bold: true }, { text: `  ${plan.template.tagline}`, dim: true }]} width={inner} />
      <Text dimColor>{fit("─".repeat(inner), inner)}</Text>
      {seats.map((row, i) => (
        <RowView key={i} row={row} width={inner} />
      ))}
      <Text> </Text>
      <RowView row={sizeLine} width={inner} />
      <RowView row={worktreeLine} width={inner} />
      <RowView
        row={[
          { text: "budgets    ", dim: true },
          { text: compactBudget(plan.totalCapUsd), bold: true },
          { text: " across the team. Nothing runs until work is given.", dim: true },
        ]}
        width={inner}
      />
    </Modal>
  );
}

export default CompanyPicker;
