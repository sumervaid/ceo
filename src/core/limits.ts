/**
 * Limits: how many agents run at once, and what happens when a provider
 * says stop.
 *
 * CEO puts no ceiling on the size of an org or on how many agents run at
 * the same time. The ceilings that exist belong to the providers and to the
 * machine. A Claude or ChatGPT plan has a usage window shared by every
 * session on the account. An API key has requests and tokens per minute.
 * Each agent is a process with an MCP server beside it, a few hundred
 * megabytes of memory together.
 *
 * `CEO_MAX_RUNNING` sets a ceiling for the dispatcher when one is wanted.
 * Unset, the dispatcher starts every queued task that has an idle agent.
 *
 * A run refused for a rate or usage limit is not a failure of the work.
 * The runner puts the task back in the queue and records a `rate_limited`
 * note with the time the provider is expected back. The dispatcher holds
 * that provider's tasks until then. A limit with a stated reset time waits
 * for that time. A limit without one backs off: one minute, then two, then
 * four, up to thirty.
 */

import type { Provider } from "./types.js";

/** The dispatcher's ceiling on runs at once, or null for none. */
export function maxRunning(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.CEO_MAX_RUNNING?.trim();
  if (!raw || raw === "0" || /^(none|unlimited|off)$/i.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

const LIMIT_PATTERN =
  /usage limit|rate[ _-]?limit|too many requests|\b429\b|quota (exceeded|exhausted|reached)|exceeded (your|the) quota|resource[_ ]exhausted|limit reached|overloaded_error|\boverloaded\b/i;

const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

export type RateLimit = {
  /** When the provider said it would accept work again, or null when it did not say. */
  resetAt: number | null;
  /** The provider's own words, trimmed. */
  reason: string;
};

/** The next wall-clock time with this hour and minute, today or tomorrow. */
function nextClock(hour: number, minute: number, now: number): number {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * Read an error for a rate or usage limit. Returns null for any other
 * error. Only the run's error is read, never the agent's prose: an agent
 * writing about rate limits is not being limited.
 */
export function detectRateLimit(error: string | null | undefined, now: number = Date.now()): RateLimit | null {
  if (!error || !LIMIT_PATTERN.test(error)) return null;
  const reason = error.replace(/\s+/g, " ").trim().slice(0, 200);

  // "Claude AI usage limit reached|1761930000": an epoch in seconds.
  const epoch = /\|(\d{10})\b/.exec(error);
  if (epoch) return { resetAt: Number(epoch[1]) * 1000, reason: reason.replace(/\|\d{10}\b/, "") };

  // "try again in 20s", "retry after 5 minutes", "in 2 hours".
  const rel = /(?:try again|retry|resets?|available)\D{0,12}?(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\b/i.exec(error);
  if (rel) {
    const n = Number(rel[1]);
    const u = rel[2].toLowerCase();
    const ms = u === "ms" ? n : u.startsWith("h") ? n * 3_600_000 : u.startsWith("m") ? n * 60_000 : n * 1000;
    return { resetAt: now + ms, reason };
  }

  // "resets 3pm", "resets at 15:30", "reset at 9:05 am".
  const clockAt = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(error);
  if (clockAt) {
    let hour = Number(clockAt[1]);
    const minute = Number(clockAt[2] ?? 0);
    const half = clockAt[3]?.toLowerCase();
    if (half === "pm" && hour < 12) hour += 12;
    if (half === "am" && hour === 12) hour = 0;
    if (hour <= 23 && minute <= 59) return { resetAt: nextClock(hour, minute, now), reason };
  }

  return { resetAt: null, reason };
}

/**
 * When a provider is expected back. A stated reset wins. Otherwise the
 * wait doubles with each limit in a row, from one minute to thirty.
 */
export function cooldownUntil(limit: RateLimit, hitsInARow: number, now: number = Date.now()): number {
  if (limit.resetAt && limit.resetAt > now) return limit.resetAt;
  const n = Math.max(1, hitsInARow);
  return now + Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (n - 1));
}

/** Providers waiting out a limit, keyed by provider, with the time each is expected back. */
export type Cooldowns = Map<Provider, { until: number; hits: number; reason: string }>;

/**
 * The cooldowns for this process. The dashboard is one process, so every
 * workspace it dispatches shares one view of which providers are waiting.
 * A provider's limit belongs to the account, not to a repository.
 */
export const cooldowns: Cooldowns = new Map();

/** Record a limit. Returns the time the provider is expected back. */
export function noteRateLimit(c: Cooldowns, provider: Provider, limit: RateLimit, now: number = Date.now()): number {
  const prev = c.get(provider);
  const hits = prev && now - prev.until < MAX_BACKOFF_MS ? prev.hits + 1 : 1;
  const until = cooldownUntil(limit, hits, now);
  c.set(provider, { until, hits, reason: limit.reason });
  return until;
}

/** Whether a provider is still waiting out a limit. */
export function coolingDown(c: Cooldowns, provider: Provider, now: number = Date.now()): boolean {
  const entry = c.get(provider);
  return Boolean(entry && entry.until > now);
}

/** "2m", "45s", "1h 5m": the time left, short. */
export function waitLabel(until: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((until - now) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
