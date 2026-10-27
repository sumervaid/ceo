/**
 * Add, remove and jump between workspaces.
 *
 * The sidebar is the fast path: `[` and `]` cycle, and that is what you do
 * ninety times a day. This dialog is for the other ten: registering a repo
 * that is not in the list yet, dropping one you have stopped working in,
 * and seeing the full path behind a name that the sidebar had to truncate.
 *
 * Removing forgets the path. It does not touch the repo's `.ceo/`, and the
 * dialog says so on the line that does it, because "remove" next to a
 * ledger is a word that deserves a caveat.
 */

import { Box, Text, useInput } from "ink";
import { useState } from "react";

import { clamp, compactUsd, fit } from "../format.js";
import { isEscape, isReturn } from "../keys.js";
import type { WorkspaceSummary } from "../workspaces.js";
import Modal from "./Modal.js";
import TextField from "./TextField.js";

const ROWS = 8;

export type WorkspaceManagerProps = {
  workspaces: WorkspaceSummary[];
  activePath: string;
  width: number;
  onOpen: (path: string) => void;
  onAdd: (path: string) => { ok: boolean; message: string };
  onRemove: (path: string) => { ok: boolean; message: string };
  onClose: () => void;
};

export function WorkspaceManager({
  workspaces,
  activePath,
  width,
  onOpen,
  onAdd,
  onRemove,
  onClose,
}: WorkspaceManagerProps) {
  const [index, setIndex] = useState(Math.max(0, workspaces.findIndex((w) => w.path === activePath)));
  const [adding, setAdding] = useState(workspaces.length === 0);
  const [pathText, setPathText] = useState("");
  const [note, setNote] = useState<{ text: string; tone: "ok" | "error" } | null>(null);

  const inner = Math.max(24, width - 4);
  const selected = workspaces[clamp(index, 0, Math.max(0, workspaces.length - 1))] ?? null;

  useInput((input, key) => {
    if (adding) {
      if (isEscape(input, key)) {
        if (workspaces.length === 0) onClose();
        else setAdding(false);
        return;
      }
      if (isReturn(input, key)) {
        const p = pathText.trim();
        if (!p) return;
        const r = onAdd(p);
        setNote({ text: r.message, tone: r.ok ? "ok" : "error" });
        if (r.ok) {
          setPathText("");
          setAdding(false);
        }
      }
      return;
    }

    if (isEscape(input, key) || input === "q") {
      onClose();
      return;
    }
    if (isReturn(input, key) && selected) {
      onOpen(selected.path);
      return;
    }
    if (key.upArrow || input === "k") {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setIndex((i) => Math.min(workspaces.length - 1, i + 1));
      return;
    }
    if (input === "a") {
      setAdding(true);
      setNote(null);
      return;
    }
    if (input === "x" && selected) {
      const r = onRemove(selected.path);
      setNote({ text: r.message, tone: r.ok ? "ok" : "error" });
      setIndex((i) => Math.max(0, Math.min(i, workspaces.length - 2)));
    }
  });

  const overflowing = workspaces.length > ROWS;
  const visible = overflowing ? ROWS - 1 : ROWS;
  const start = clamp(index - Math.floor(visible / 2), 0, Math.max(0, workspaces.length - visible));
  const rows = workspaces.slice(start, start + visible);
  const hidden = workspaces.length - rows.length;
  const nameWidth = clamp(Math.max(4, ...workspaces.map((w) => w.name.length)), 4, 20);

  return (
    <Modal
      title="Workspaces"
      footer={
        adding
          ? "enter register · esc back"
          : "↑↓ select · enter open · a add · x remove · esc close"
      }
      width={width}
    >
      {rows.map((ws, i) => {
        const sel = start + i === index;
        const active = ws.path === activePath;
        const stats = ws.hasOrg
          ? `${ws.agents} agent${ws.agents === 1 ? "" : "s"} · ${compactUsd(ws.spendTodayUsd)} today${
              ws.waiting > 0 ? ` · ${ws.waiting} waiting` : ""
            }${ws.dangling > 0 ? ` · ${ws.dangling} dangling` : ""}${ws.chainOk ? "" : " · CHAIN BROKEN"}`
          : ws.present
            ? "no org yet"
            : "directory missing";
        return (
          <Box key={ws.path} flexDirection="column">
            <Box>
              <Text bold={sel} color={sel ? "cyan" : undefined}>{sel ? "❯ " : "  "}</Text>
              <Text bold={sel} inverse={sel}>
                {ws.name.slice(0, nameWidth).padEnd(nameWidth)}
              </Text>
              <Text color={active ? "cyan" : undefined} dimColor={!active}>
                {`  ${fit(stats, Math.max(4, inner - nameWidth - 4))}`}
              </Text>
            </Box>
            {sel ? <Text dimColor>{`    ${fit(ws.path, inner - 4)}`}</Text> : null}
          </Box>
        );
      })}
      {hidden > 0 ? <Text dimColor>{`  +${hidden} more`}</Text> : null}
      {workspaces.length === 0 && !adding ? (
        <Text dimColor>No workspaces registered.</Text>
      ) : null}

      {adding ? (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text bold color="cyan">{"❯ path  "}</Text>
            <TextField
              value={pathText}
              onChange={setPathText}
              placeholder="~/code/some-repo"
              focused
              width={Math.max(12, inner - 8)}
            />
          </Box>
          <Text dimColor>
            {fit("Any directory. A repo without an org can be initialised from the dashboard.", inner)}
          </Text>
        </Box>
      ) : selected ? (
        <Box marginTop={1}>
          <Text dimColor>
            {fit("x forgets the path only; the repo and its .ceo/ are left alone.", inner)}
          </Text>
        </Box>
      ) : null}

      {note ? (
        <Box marginTop={1}>
          <Text color={note.tone === "error" ? "red" : "green"}>{fit(note.text, inner)}</Text>
        </Box>
      ) : null}
    </Modal>
  );
}

export default WorkspaceManager;
