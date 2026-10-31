/**
 * Alerts: telling the developer when the org needs a look.
 *
 * Seven events can alert: a run finished, a run failed, a run was refused
 * at its budget, an agent reached past its level, the chief of staff
 * replied while the chat was closed, the queue ran dry, and a provider hit
 * a rate or usage limit. Four channels carry
 * them: the terminal bell, a desktop notification, a Slack incoming
 * webhook, and any webhook that takes JSON.
 *
 * The settings live in `~/.ceo/alerts.json`, one file per person, because
 * alerts are about where the person is, not about the repository. `ceo
 * alerts` and the integrations screen change them. The defaults are the
 * bell and the desktop, for failures, refusals and denials, plus the
 * chief's replies and an empty queue. Finished runs are off by default:
 * a busy org finishes a run every minute.
 *
 * A channel that fails never takes the dashboard with it. The result of
 * each send is returned, so `ceo alerts test` can say which channel works.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { ceoHome } from "./workspaces.js";

export type AlertKind = "done" | "failed" | "budget" | "denied" | "chief" | "queue" | "limit";

export const ALERT_KINDS: AlertKind[] = ["done", "failed", "budget", "denied", "chief", "queue", "limit"];

export const ALERT_LABEL: Record<AlertKind, string> = {
  done: "a run finished",
  failed: "a run failed",
  budget: "a run was refused at its budget",
  denied: "an agent reached past its level",
  chief: "the chief of staff replied",
  queue: "the queue ran dry",
  limit: "a provider hit a rate or usage limit",
};

export type AlertConfig = {
  bell: boolean;
  desktop: boolean;
  /** A Slack incoming-webhook URL, or null. */
  slack: string | null;
  /** Any URL that takes a JSON POST, or null. */
  webhook: string | null;
  events: Record<AlertKind, boolean>;
};

export const DEFAULT_ALERTS: AlertConfig = {
  bell: true,
  desktop: true,
  slack: null,
  webhook: null,
  events: { done: false, failed: true, budget: true, denied: true, chief: true, queue: true, limit: true },
};

export type Alert = {
  kind: AlertKind;
  /** One line: "coder failed". */
  title: string;
  /** The detail: the task, the cost, the error. */
  body: string;
  workspace: string;
};

export function alertsPath(): string {
  return path.join(ceoHome(), "alerts.json");
}

export function readAlerts(): AlertConfig {
  try {
    const raw = JSON.parse(readFileSync(alertsPath(), "utf8")) as Partial<AlertConfig>;
    return { ...DEFAULT_ALERTS, ...raw, events: { ...DEFAULT_ALERTS.events, ...(raw.events ?? {}) } };
  } catch {
    return { ...DEFAULT_ALERTS, events: { ...DEFAULT_ALERTS.events } };
  }
}

export function writeAlerts(change: Partial<Omit<AlertConfig, "events">> & { events?: Partial<Record<AlertKind, boolean>> }): AlertConfig {
  const now = readAlerts();
  const next: AlertConfig = { ...now, ...change, events: { ...now.events, ...(change.events ?? {}) } };
  if (next.slack && !/^https:\/\//.test(next.slack)) throw new Error("A Slack webhook is an https URL, from Slack's Incoming Webhooks app.");
  if (next.webhook && !/^https?:\/\//.test(next.webhook)) throw new Error("A webhook is an http or https URL.");
  const dir = path.dirname(alertsPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // The file holds webhook URLs, which are secrets. Owner-only.
  writeFileSync(alertsPath(), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  chmodSync(alertsPath(), 0o600);
  return next;
}

/** One line per channel, for the integrations screen and `ceo alerts`. */
export function describeChannels(c: AlertConfig): string {
  return [
    `bell ${c.bell ? "on" : "off"}`,
    `desktop ${c.desktop ? "on" : "off"}`,
    `Slack ${c.slack ? "on" : "not set"}`,
    `webhook ${c.webhook ? "on" : "not set"}`,
  ].join(" · ");
}

export type SendResult = { channel: "bell" | "desktop" | "slack" | "webhook"; ok: boolean; detail: string };

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/** A desktop notification: osascript on macOS, notify-send elsewhere. CEO_NOTIFY_BIN overrides. */
async function desktop(title: string, body: string): Promise<boolean> {
  const custom = process.env.CEO_NOTIFY_BIN?.trim();
  if (custom) return run(custom, [title, body]);
  if (process.platform === "darwin") {
    const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    return run("osascript", ["-e", `display notification ${q(body.slice(0, 200))} with title ${q(title)} subtitle "CEO"`]);
  }
  return run("notify-send", ["--app-name=CEO", title, body.slice(0, 200)]);
}

async function post(url: string, payload: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Send one alert on every channel that is on, when its event is on.
 * `bell` rings the terminal; the dashboard passes its own writer.
 */
export async function sendAlert(
  a: Alert,
  opts: { config?: AlertConfig; bell?: () => void; force?: boolean } = {},
): Promise<SendResult[]> {
  const c = opts.config ?? readAlerts();
  if (!opts.force && !c.events[a.kind]) return [];
  const results: SendResult[] = [];
  const where = path.basename(a.workspace);
  if (c.bell) {
    try {
      (opts.bell ?? (() => process.stdout.write("\u0007")))();
      results.push({ channel: "bell", ok: true, detail: "rang" });
    } catch {
      results.push({ channel: "bell", ok: false, detail: "no terminal" });
    }
  }
  if (c.desktop) {
    const ok = await desktop(`${a.title} · ${where}`, a.body);
    results.push({ channel: "desktop", ok, detail: ok ? "shown" : "the notifier refused" });
  }
  if (c.slack) {
    const ok = await post(c.slack, { text: `*${a.title}* · ${where}\n${a.body}` });
    results.push({ channel: "slack", ok, detail: ok ? "posted" : "Slack refused the webhook" });
  }
  if (c.webhook) {
    const ok = await post(c.webhook, { source: "ceo", ...a, workspaceName: where, at: new Date().toISOString() });
    results.push({ channel: "webhook", ok, detail: ok ? "posted" : "the webhook refused" });
  }
  return results;
}
