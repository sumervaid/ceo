/**
 * The docket: every piece of context in the org, and who holds which.
 *
 * A grid. Context runs down the side, grouped as skills, files, GitHub,
 * Hugging Face, web and notes, each with its size in tokens. Agents run
 * across the top in their providers' colours. A filled dot is an item an
 * agent holds. The cursor is a cell: up and down pick the item, left and
 * right pick the agent, space gives or takes. The row at the bottom totals
 * what each agent will read, against the limit.
 *
 * `n` opens one input line that reads what it is given: a path, a folder,
 * #42, hf:org/model, paper:2401.12345, a URL, skill:name, or a note. The
 * line says what it read before enter adds it. The new item goes to the
 * agent under the cursor.
 *
 * Nothing here fetches or writes. Adding, refreshing and assigning are
 * callbacks into the dashboard, which reports each result.
 */

import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";

import { agentMaxChars, classify, GROUPS, KIND_LABEL, loadOf, tokenLabel, type ContextItem, type ContextKind } from "../../core/context.js";
import type { AgentRecord } from "../../core/types.js";
import { isEscape, isReturn, printablePart } from "../keys.js";
import { clipRow, type Row } from "../chat.js";
import { clamp, fit, providerColor } from "../format.js";

export type DocketProps = {
  workspaceName: string;
  cwd: string;
  items: ContextItem[];
  agents: AgentRecord[];
  /** The text of an item now, for the preview. */
  textOf: (item: ContextItem) => string;
  /** Something is being fetched, with what. */
  busy: string | null;
  flash: { text: string; tone: "ok" | "error" } | null;
  width: number;
  height: number;
  onToggle: (item: ContextItem, agent: string) => void;
  onAll: (item: ContextItem, give: boolean) => void;
  onAdd: (input: string, agent: string | null) => void;
  onRemove: (item: ContextItem) => void;
  onRefresh: (item: ContextItem) => void;
  onSkills: (agent: string | null) => void;
  onIssues: (agent: string | null) => void;
  onClose: () => void;
  /**
   * Where the cursor was, by item id and agent name. Pickers replace the
   * docket while they are open, and the cursor comes back to the same cell.
   */
  cursor: { item: string | null; agent: string | null };
  onCursor: (c: { item: string | null; agent: string | null }) => void;
};

const KIND_WORD: Record<ContextKind, string> = {
  file: "a file in the repo",
  folder: "a folder in the repo",
  issue: "a GitHub issue",
  pr: "a GitHub pull request",
  model: "a Hugging Face model",
  dataset: "a Hugging Face dataset",
  space: "a Hugging Face Space",
  paper: "a paper on Hugging Face",
  url: "a web page",
  skill: "a skill",
  note: "a note",
};

function RowView({ row, width }: { row: Row; width: number }) {
  const segs = clipRow(row, width);
  if (segs.length === 0) return <Text> </Text>;
  return (
    <Text wrap="truncate">
      {segs.map((s, i) => (
        <Text key={i} color={s.color} dimColor={s.dim} bold={s.bold} inverse={s.inverse}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

type Line = { kind: "group"; label: string } | { kind: "item"; item: ContextItem };

/** Centre text in a cell, so a column's name, dots and totals line up. */
function centre(text: string, w: number): string {
  const t = text.length > w ? text.slice(0, w) : text;
  const left = Math.floor((w - t.length) / 2);
  return " ".repeat(left) + t + " ".repeat(w - t.length - left);
}

export function Docket(props: DocketProps) {
  const { items, agents, width: W, height: H } = props;
  const inner = W - 4;

  // Lines: a header per group that has items, then its items.
  const lines = useMemo<Line[]>(() => {
    const out: Line[] = [];
    for (const g of GROUPS) {
      const inGroup = items.filter((i) => KIND_LABEL[i.kind] === g);
      if (inGroup.length === 0) continue;
      out.push({ kind: "group", label: g });
      for (const it of inGroup) out.push({ kind: "item", item: it });
    }
    return out;
  }, [items]);
  const itemLines = lines.map((l, i) => (l.kind === "item" ? i : -1)).filter((i) => i >= 0);

  const [row, setRow] = useState(() => {
    const at = itemLines.findIndex((li) => (lines[li] as { item: ContextItem }).item.id === props.cursor.item);
    return at >= 0 ? at : 0;
  });
  const [col, setCol] = useState(() => Math.max(0, agents.findIndex((a) => a.name === props.cursor.agent)));
  const [mode, setMode] = useState<"grid" | "add">("grid");
  const [preview, setPreview] = useState(true);
  const draft = useRef("");
  const [, redraw] = useState(0);

  // Keep the cursor on a real item as the docket changes under it.
  const lastCount = useRef(items.length);
  useEffect(() => {
    if (items.length > lastCount.current) {
      // A new item: put the cursor on it.
      const newest = [...items].sort((a, b) => b.seq - a.seq)[0];
      const at = itemLines.findIndex((li) => (lines[li] as { item: ContextItem }).item.id === newest?.id);
      if (at >= 0) setRow(at);
    }
    lastCount.current = items.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);
  const r = clamp(row, 0, Math.max(0, itemLines.length - 1));
  const c = clamp(col, 0, Math.max(0, agents.length - 1));
  const current = itemLines.length > 0 ? (lines[itemLines[r]] as { item: ContextItem }).item : null;
  const agent = agents[c]?.name ?? null;
  const report = props.onCursor;
  useEffect(() => {
    report({ item: current?.id ?? null, agent });
  }, [current?.id, agent, report]);

  useInput((input, key) => {
    if (mode === "add") {
      if (isEscape(input, key)) {
        draft.current = "";
        setMode("grid");
        return;
      }
      if (key.backspace || key.delete) {
        draft.current = draft.current.slice(0, -1);
        redraw((n) => n + 1);
        return;
      }
      if (key.ctrl && input === "u") {
        draft.current = "";
        redraw((n) => n + 1);
        return;
      }
      const typed = printablePart(input);
      if (typed) {
        draft.current += typed;
        redraw((n) => n + 1);
      }
      if (isReturn(input, key) && draft.current.trim()) {
        props.onAdd(draft.current.trim(), agent);
        draft.current = "";
        setMode("grid");
      }
      return;
    }
    if (isEscape(input, key) || input === "q") return props.onClose();
    if (key.upArrow || input === "k") return setRow((v) => Math.max(0, clamp(v, 0, itemLines.length - 1) - 1));
    if (key.downArrow || input === "j") return setRow((v) => Math.min(itemLines.length - 1, v + 1));
    if (key.leftArrow || input === "h") return setCol((v) => Math.max(0, clamp(v, 0, agents.length - 1) - 1));
    if (key.rightArrow || input === "l") return setCol((v) => Math.min(agents.length - 1, v + 1));
    if (input === "n" || input === "+") {
      draft.current = "";
      return setMode("add");
    }
    if (input === "s") return props.onSkills(agent);
    if (input === "g") return props.onIssues(agent);
    if (input === "p") return setPreview((v) => !v);
    if (!current) return;
    if (input === " " && agent) return props.onToggle(current, agent);
    if (input === "a") return props.onAll(current, true);
    if (input === "A") return props.onAll(current, false);
    if (input === "x") return props.onRemove(current);
    if (input === "r") return props.onRefresh(current);
  });

  // Columns: the label, the size, then one per agent.
  const sizeW = 6;
  const cellW = clamp(Math.max(...agents.map((a) => a.name.length), 4) + 2, 6, 14);
  const labelW = clamp(inner - sizeW - cellW * agents.length - 2, 24, 56);
  const fitAgents = Math.max(1, Math.floor((inner - labelW - sizeW - 2) / cellW));
  const first = clamp(c - fitAgents + 1, 0, Math.max(0, agents.length - fitAgents));
  const shown = agents.slice(first, first + fitAgents);

  const load = loadOf(items, agents.map((a) => a.name));
  const limit = agentMaxChars();

  // Height: header, column names, rule, grid, rule, totals, preview or input, legend.
  const previewH = mode === "add" ? 4 : preview && current ? clamp(Math.floor((H - 4) * 0.3), 4, 10) : 0;
  const gridH = Math.max(3, H - 2 - 3 - 2 - previewH - 2);
  const cursorLine = itemLines[r] ?? 0;
  const top = clamp(cursorLine - Math.floor(gridH / 2), 0, Math.max(0, lines.length - gridH));
  const visible = lines.slice(top, top + gridH);

  const header: Row = [
    { text: "Docket", color: "cyan", bold: true },
    { text: ` · ${props.workspaceName} · ${items.length} item${items.length === 1 ? "" : "s"} · ${agents.length} agents`, dim: true },
  ];
  const legendRight: Row = [
    { text: "● ", color: "cyan" },
    { text: "claude  ", color: "cyan" },
    { text: "● ", color: "green" },
    { text: "codex  ", color: "green" },
    { text: "● ", color: "blueBright" },
    { text: "gemini", color: "blueBright" },
  ];
  const headerWidth = header.reduce((n, s) => n + s.text.length, 0);
  const headRow: Row = [...header, { text: " ".repeat(Math.max(1, inner - headerWidth - 30)) }, ...legendRight];

  const colHead: Row = [
    { text: fit("context", labelW), dim: true },
    { text: "tokens".padStart(sizeW - 1) + " ", dim: true },
    ...shown.map((a, i): Row[number] => ({
      text: centre(`${a.chief ? "◆" : ""}${a.name}`, cellW),
      color: providerColor(a.provider),
      bold: first + i === c,
    })),
  ];

  const gridRows: Row[] = visible.map((l, vi) => {
    if (l.kind === "group") {
      return [{ text: `${l.label} `, color: "cyan", bold: true }, { text: "─".repeat(Math.max(0, labelW + sizeW - l.label.length - 1)), dim: true }];
    }
    const it = l.item;
    const selected = top + vi === cursorLine;
    const title = fit(it.title, labelW - 2);
    const cells: Row = shown.map((a, i) => {
      const has = it.agents.includes(a.name);
      const here = selected && first + i === c;
      const mark = has ? "●" : "·";
      return {
        text: centre(here ? `[${mark}]` : mark, cellW),
        color: has ? providerColor(a.provider) : undefined,
        dim: !has && !here,
        bold: has || here,
      };
    });
    return [
      { text: selected ? "❯ " : "  ", color: "cyan", bold: true },
      { text: title, bold: selected, inverse: selected },
      { text: tokenLabel(it.chars).padStart(sizeW - 1) + " ", dim: true },
      ...cells,
    ];
  });

  const totals: Row = [
    { text: fit("each agent reads", labelW), dim: true },
    { text: "".padStart(sizeW) },
    ...shown.map((a): Row[number] => {
      const chars = load.get(a.name) ?? 0;
      const ratio = Math.min(1, chars / limit);
      const over = chars > limit;
      return { text: centre(`${tokenLabel(chars)}${over ? "!" : ""}`, cellW), color: over ? "red" : ratio > 0.7 ? "yellow" : undefined, dim: chars === 0 };
    }),
  ];
  const meters: Row = [
    { text: fit(`limit ${tokenLabel(limit)} tokens each`, labelW), dim: true },
    { text: "".padStart(sizeW) },
    ...shown.map((a): Row[number] => {
      const ratio = Math.min(1, (load.get(a.name) ?? 0) / limit);
      const w = Math.max(3, cellW - 4);
      const f = Math.round(ratio * w);
      return { text: centre(`${"█".repeat(f)}${"░".repeat(w - f)}`, cellW), color: providerColor(a.provider) };
    }),
  ];

  // The bottom pane: the input line, or the selected item's preview.
  let bottom: Row[] = [];
  if (mode === "add") {
    const d = draft.current;
    const read = d.trim() ? classify(d.trim(), props.cwd) : null;
    bottom = [
      [{ text: "Add context ", color: "cyan", bold: true }, { text: "a path, a folder, #42, pr #12, hf:org/model, paper:2401.12345, a URL, skill:name, or a note", dim: true }],
      [{ text: "❯ ", color: "cyan", bold: true }, { text: d }, { text: " ", inverse: true }],
      read
        ? [{ text: "reads as ", dim: true }, { text: KIND_WORD[read.kind], color: "yellow" }, { text: agent ? ` · enter adds it and gives it to ${agent} · esc cancels` : " · enter adds it · esc cancels", dim: true }]
        : [{ text: "esc cancels", dim: true }],
    ];
  } else if (previewH > 0 && current) {
    const text = props.textOf(current).replace(/\r/g, "");
    const body = text.split("\n").map((l) => l.replace(/\t/g, "  ")).filter((l, i, all) => l.trim() || (i > 0 && all[i - 1].trim()));
    bottom = [
      [
        { text: current.title, bold: true },
        { text: `  ${KIND_WORD[current.kind]} · ${current.source} · ${tokenLabel(current.chars)} tokens · held by `, dim: true },
        { text: current.agents.length > 0 ? current.agents.join(", ") : "nobody", color: current.agents.length > 0 ? "green" : "yellow" },
      ],
      ...body.slice(0, previewH - 1).map((l): Row => [{ text: l, dim: true }]),
    ];
  }

  const empty = items.length === 0;

  return (
    <Box flexDirection="column" width={W}>
      <Box width={W} height={H - 1} borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <RowView row={headRow} width={inner} />
        <Text> </Text>
        <RowView row={colHead} width={inner} />
        <Text dimColor>{"─".repeat(inner)}</Text>
        <Box flexDirection="column" height={gridH}>
          {empty ? (
            <>
              <Text> </Text>
              <Text>  The docket is empty.</Text>
              <Text dimColor>  Context given here reaches an agent at the start of every run, in its own prompt.</Text>
              <Text dimColor>  n adds a file, a folder, an issue, a Hugging Face card, a page or a note.</Text>
              <Text dimColor>  s adds a skill from Reflex. g adds an open GitHub issue.</Text>
            </>
          ) : (
            gridRows.map((row, i) => <RowView key={i} row={row} width={inner} />)
          )}
        </Box>
        <Text dimColor>{"─".repeat(inner)}</Text>
        <RowView row={totals} width={inner} />
        <RowView row={meters} width={inner} />
        {bottom.length > 0 ? (
          <Box flexDirection="column" marginTop={0}>
            {bottom.map((row, i) => (
              <RowView key={i} row={row} width={inner} />
            ))}
          </Box>
        ) : null}
      </Box>
      {props.flash ? (
        <Text color={props.flash.tone === "error" ? "red" : "green"}>{fit(props.flash.text, W)}</Text>
      ) : props.busy ? (
        <Text color="yellow">{fit(` ${props.busy}`, W)}</Text>
      ) : (
        <RowView
          row={[
            ["↑↓", "item"],
            ["←→", "agent"],
            ["space", "give or take"],
            ["a A", "all, none"],
            ["n", "add"],
            ["s", "skills"],
            ["g", "issues"],
            ["r", "refresh"],
            ["x", "remove"],
            ["p", "preview"],
            ["esc", "back"],
          ].flatMap(([k, v], i): Row => [{ text: `${i === 0 ? " " : "  "}${k}`, color: "cyan" }, { text: ` ${v}`, dim: true }])}
          width={W}
        />
      )}
    </Box>
  );
}

export default Docket;
