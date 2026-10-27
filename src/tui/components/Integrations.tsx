/**
 * Integrations: GitHub, Hugging Face, alerts and Reflex skills, on one page.
 *
 * Each card says in one line whether the integration works here and as
 * whom, then the keys that act on it. Nothing here holds a credential.
 * GitHub is the `gh` login, Hugging Face is the Hub's own token or none,
 * alerts are settings in `~/.ceo/alerts.json`, and Reflex is its own store.
 *
 * The pickers this page opens, open issues and the skill catalogue, are in
 * this file too. Each one lists, and enter hands the choice back.
 */

import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";

import { ALERT_KINDS, ALERT_LABEL, type AlertConfig, type AlertKind } from "../../core/alerts.js";
import type { GithubStatus, Issue } from "../../core/github.js";
import type { HfStatus } from "../../core/huggingface.js";
import type { Skill } from "../../core/skills.js";
import type { ReflexStatus } from "../../core/reflex.js";
import { isEscape, isReturn, printablePart } from "../keys.js";
import { clipRow, type Row } from "../chat.js";
import { clamp, fit } from "../format.js";
import Modal from "./Modal.js";

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

const ok = (yes: boolean): Row[number] => (yes ? { text: "✓ ", color: "green", bold: true } : { text: "✗ ", color: "yellow", bold: true });
const key = (k: string, v: string): Row => [{ text: k, color: "cyan" }, { text: ` ${v}   `, dim: true }];

export type IntegrationsProps = {
  width: number;
  github: GithubStatus;
  hf: HfStatus | null;
  alerts: AlertConfig;
  reflex: ReflexStatus;
  skills: { ready: number; pending: number } | null;
  openIssues: number | null;
  onIssues: () => void;
  onGithubLogin: () => void;
  onAlerts: (change: Partial<Pick<AlertConfig, "bell" | "desktop" | "slack" | "webhook">> & { events?: Partial<Record<AlertKind, boolean>> }) => void;
  onTestAlert: () => void;
  onSkills: () => void;
  onClose: () => void;
};

export function Integrations(p: IntegrationsProps) {
  const inner = Math.max(20, p.width - 4);
  const [editing, setEditing] = useState<"slack" | "webhook" | null>(null);
  const draft = useRef("");
  const [, redraw] = useState(0);

  useInput((input, k) => {
    if (editing) {
      if (isEscape(input, k)) return setEditing(null);
      if (k.backspace || k.delete) {
        draft.current = draft.current.slice(0, -1);
        return redraw((n) => n + 1);
      }
      const typed = printablePart(input);
      if (typed) {
        draft.current += typed;
        redraw((n) => n + 1);
      }
      if (isReturn(input, k)) {
        const v = draft.current.trim();
        p.onAlerts(editing === "slack" ? { slack: v || null } : { webhook: v || null });
        setEditing(null);
      }
      return;
    }
    if (isEscape(input, k) || input === "q") return p.onClose();
    if (input === "g") return p.onIssues();
    if (input === "l") return p.onGithubLogin();
    if (input === "b") return p.onAlerts({ bell: !p.alerts.bell });
    if (input === "d") return p.onAlerts({ desktop: !p.alerts.desktop });
    if (input === "s" || input === "w") {
      draft.current = (input === "s" ? p.alerts.slack : p.alerts.webhook) ?? "";
      return setEditing(input === "s" ? "slack" : "webhook");
    }
    if (input === "t") return p.onTestAlert();
    if (input === "k") return p.onSkills();
    if (/^[1-6]$/.test(input)) {
      const kind = ALERT_KINDS[Number(input) - 1];
      return p.onAlerts({ events: { [kind]: !p.alerts.events[kind] } });
    }
  });

  const gh = p.github;
  const ghLine: Row = !gh.installed
    ? [ok(false), { text: "the GitHub CLI is not installed. brew install gh", color: "yellow" }]
    : !gh.signedIn
      ? [ok(false), { text: "gh is not signed in. l signs in with gh auth login", color: "yellow" }]
      : [ok(true), { text: `signed in as ${gh.account ?? "you"}` }, { text: gh.repo ? ` · ${gh.repo}` : " · no GitHub remote here", dim: !gh.repo }, { text: p.openIssues !== null ? ` · ${p.openIssues} open issue${p.openIssues === 1 ? "" : "s"}` : "", dim: true }];

  const hfLine: Row = !p.hf
    ? [{ text: "checking…", dim: true }]
    : p.hf.token
      ? [ok(true), { text: `token${p.hf.account ? ` for ${p.hf.account}` : ""}` }, { text: " · private repos and public ones", dim: true }]
      : [ok(true), { text: "public models, datasets, Spaces and papers" }, { text: " · hf auth login adds private repos", dim: true }];

  const a = p.alerts;
  const chan = (label: string, on: boolean, extra = ""): Row => [{ text: label, bold: on }, { text: on ? ` on${extra}` : " off", color: on ? "green" : undefined, dim: !on }, { text: "   " }];
  const alertsLine: Row = [...chan("bell", a.bell), ...chan("desktop", a.desktop), ...chan("Slack", Boolean(a.slack)), ...chan("webhook", Boolean(a.webhook))];
  const events: Row = ALERT_KINDS.flatMap((kd, i): Row => [{ text: `${i + 1} `, color: "cyan" }, { text: a.events[kd] ? "● " : "○ ", color: a.events[kd] ? "green" : undefined, dim: !a.events[kd] }, { text: `${kd}   `, dim: !a.events[kd] }]);

  const rx = p.reflex;
  const rxLine: Row = !rx.installed
    ? [ok(false), { text: "Reflex is not installed. npm install -g reflex-skills", color: "yellow" }]
    : [ok(true), { text: `Reflex ${rx.version ?? ""}`.trim() }, { text: p.skills ? ` · ${p.skills.ready} skill${p.skills.ready === 1 ? "" : "s"} ready · ${p.skills.pending} workflow${p.skills.pending === 1 ? "" : "s"} waiting` : " · reading skills…", dim: true }];

  const card = (title: string, line: Row, keys: Row, extra?: Row[]) => (
    <Box flexDirection="column" marginBottom={1}>
      <RowView row={[{ text: title, color: "cyan", bold: true }]} width={inner} />
      <RowView row={[{ text: "  " }, ...line]} width={inner} />
      {(extra ?? []).map((r, i) => (
        <RowView key={i} row={[{ text: "  " }, ...r]} width={inner} />
      ))}
      <RowView row={[{ text: "  " }, ...keys]} width={inner} />
    </Box>
  );

  return (
    <Modal title="Integrations" footer={editing ? "enter saves · empty clears · esc cancels" : "esc close"} width={p.width}>
      {card("GitHub", ghLine, [...key("g", "open issues, as context or tasks"), ...key("P", "on the roster opens a pull request"), ...(gh.installed && !gh.signedIn ? key("l", "sign in") : [])])}
      {card("Hugging Face", hfLine, [{ text: "add ", dim: true }, { text: "hf:org/model", color: "yellow" }, { text: ", ", dim: true }, { text: "hf:datasets/org/name", color: "yellow" }, { text: " or ", dim: true }, { text: "paper:2401.12345", color: "yellow" }, { text: " in the docket, D", dim: true }])}
      {card(
        "Alerts",
        alertsLine,
        [...key("b", "bell"), ...key("d", "desktop"), ...key("s", "Slack webhook"), ...key("w", "webhook"), ...key("t", "send a test")],
        [events, [{ text: ALERT_KINDS.map((kd) => `${kd}: ${ALERT_LABEL[kd]}`).slice(0, 3).join(" · "), dim: true }], [{ text: ALERT_KINDS.map((kd) => `${kd}: ${ALERT_LABEL[kd]}`).slice(3).join(" · "), dim: true }]],
      )}
      {card("Reflex skills", rxLine, [...key("k", "the skill catalogue; the docket gives a skill to an agent")])}
      {editing ? (
        <Box flexDirection="column">
          <RowView row={[{ text: editing === "slack" ? "Slack incoming-webhook URL" : "Webhook URL", color: "cyan", bold: true }]} width={inner} />
          <RowView row={[{ text: "❯ ", color: "cyan", bold: true }, { text: fit(draft.current, inner - 4).trimEnd() }, { text: " ", inverse: true }]} width={inner} />
        </Box>
      ) : null}
    </Modal>
  );
}

export type IssuePickerProps = {
  width: number;
  issues: Issue[] | null;
  error: string | null;
  /** Who enter and t act for. */
  agent: string | null;
  onContext: (issue: Issue) => void;
  onTask: (issue: Issue) => void;
  onChief: (issue: Issue) => void;
  onClose: () => void;
};

export function IssuePicker(p: IssuePickerProps) {
  const inner = Math.max(20, p.width - 4);
  const [i, setI] = useState(0);
  const list = p.issues ?? [];
  const at = clamp(i, 0, Math.max(0, list.length - 1));
  useInput((input, k) => {
    if (isEscape(input, k) || input === "q") return p.onClose();
    if (k.upArrow || input === "k") return setI((v) => Math.max(0, v - 1));
    if (k.downArrow || input === "j") return setI((v) => Math.min(list.length - 1, v + 1));
    const it = list[at];
    if (!it) return;
    if (isReturn(input, k)) return p.onContext(it);
    if (input === "t") return p.onTask(it);
    if (input === "c") return p.onChief(it);
  });
  const who = p.agent ?? "the selected agent";
  return (
    <Modal title={`Open issues${list.length > 0 ? ` · ${list.length}` : ""}`} footer={`↑↓ pick · enter gives the issue to ${who} as context · t queues it as a task for ${who} · c hands it to the chief · esc close`} width={p.width}>
      {p.error ? (
        <Text color="red">{fit(p.error, inner)}</Text>
      ) : p.issues === null ? (
        <Text dimColor>reading issues with gh…</Text>
      ) : list.length === 0 ? (
        <Text dimColor>No open issues.</Text>
      ) : (
        list.slice(Math.max(0, at - 12), Math.max(0, at - 12) + 16).map((it) => {
          const sel = it === list[at];
          return (
            <RowView
              key={it.number}
              row={[
                { text: sel ? "❯ " : "  ", color: "cyan", bold: true },
                { text: `#${it.number}`.padEnd(6), color: "green" },
                { text: fit(it.title, Math.max(10, inner - 40)), bold: sel },
                { text: it.labels.length > 0 ? `  ${it.labels.slice(0, 3).join(", ")}` : "", color: "yellow" },
                { text: it.assignees.length > 0 ? `  @${it.assignees[0]}` : "", dim: true },
              ]}
              width={inner}
            />
          );
        })
      )}
    </Modal>
  );
}

export type SkillPickerProps = {
  width: number;
  skills: Skill[] | null;
  agent: string | null;
  onPick: (skill: Skill) => void;
  onClose: () => void;
};

const SOURCE_LABEL: Record<Skill["source"], string> = { reflex: "Reflex", repo: "this repo", claude: "Claude Code", codex: "Codex", cursor: "Cursor" };

export function SkillPicker(p: SkillPickerProps) {
  const inner = Math.max(20, p.width - 4);
  const [i, setI] = useState(0);
  const list = p.skills ?? [];
  const at = clamp(i, 0, Math.max(0, list.length - 1));
  useInput((input, k) => {
    if (isEscape(input, k) || input === "q") return p.onClose();
    if (k.upArrow || input === "k") return setI((v) => Math.max(0, v - 1));
    if (k.downArrow || input === "j") return setI((v) => Math.min(list.length - 1, v + 1));
    if (isReturn(input, k) && list[at]) return p.onPick(list[at]);
  });
  const nameW = clamp(Math.max(...list.map((s) => s.name.length), 8), 8, 28);
  const sel = list[at];
  return (
    <Modal title={`Skills${list.length > 0 ? ` · ${list.length}` : ""}`} footer={`↑↓ pick · enter gives the skill to ${p.agent ?? "the agent under the cursor"}; a waiting workflow is approved with Reflex first · esc close`} width={p.width}>
      {p.skills === null ? (
        <Text dimColor>reading Reflex and the CLIs' skill folders…</Text>
      ) : list.length === 0 ? (
        <Box flexDirection="column">
          <Text dimColor>No skills yet.</Text>
          <Text dimColor>Reflex finds workflows repeated across sessions: reflex scan, then reflex suggest.</Text>
        </Box>
      ) : (
        <>
          {list.slice(Math.max(0, at - 10), Math.max(0, at - 10) + 14).map((s) => (
            <RowView
              key={`${s.source}:${s.name}`}
              row={[
                { text: s === sel ? "❯ " : "  ", color: "cyan", bold: true },
                { text: s.name.padEnd(nameW + 2), bold: s === sel },
                s.status === "pending"
                  ? { text: `waiting · ${Math.round((s.confidence ?? 0) * 100)}%`.padEnd(16), color: "yellow" }
                  : { text: SOURCE_LABEL[s.source].padEnd(16), color: s.source === "reflex" ? "magenta" : "cyan" },
                { text: fit(s.description, Math.max(10, inner - nameW - 20)), dim: true },
              ]}
              width={inner}
            />
          ))}
        </>
      )}
    </Modal>
  );
}

export type PrDialogProps = {
  width: number;
  agent: string;
  branch: string;
  base: string;
  repo: string | null;
  runs: number;
  costUsd: number;
  onConfirm: () => void;
  onClose: () => void;
};

export function PrDialog(p: PrDialogProps) {
  const inner = Math.max(20, p.width - 4);
  useInput((input, k) => {
    if (isEscape(input, k) || input === "q") return p.onClose();
    if (isReturn(input, k)) return p.onConfirm();
  });
  return (
    <Modal title={`Pull request for ${p.agent}`} footer="enter pushes the branch and opens the pull request · esc cancel" width={p.width}>
      <RowView row={[{ text: "from     ", dim: true }, { text: p.branch, color: "cyan" }, { text: "  into  ", dim: true }, { text: p.base, color: "green" }, { text: p.repo ? `  on ${p.repo}` : "", dim: true }]} width={inner} />
      <RowView row={[{ text: "work     ", dim: true }, { text: `${p.runs} run${p.runs === 1 ? "" : "s"}, $${p.costUsd.toFixed(4)}` }]} width={inner} />
      <RowView row={[{ text: "body     ", dim: true }, { text: "each run's task, provider, model and cost, from the ledger", dim: true }]} width={inner} />
    </Modal>
  );
}
