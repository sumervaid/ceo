/**
 * Cost estimation from token counts.
 *
 * A `claude -p` run reports a settled `total_cost_usd` in its final message,
 * and that figure is always preferred: it accounts for caching, tiering and
 * whatever else billing does. This table is used in two cases:
 *
 *   - a claude run that ended before reporting one, because it was cancelled or crashed.
 *   - every codex run, because `codex exec` reports tokens and never dollars.
 *   - every gemini run, because `agy` reports tokens and never dollars.
 *
 * Each consumed tokens and was billed, so recording zero would quietly
 * understate what the org spent. A ledger that understates spend is
 * worse than no ledger because it is trusted. Every figure produced here is
 * marked as an estimate at the call site and recorded as such in the ledger.
 *
 * Rates are list prices per million tokens and will drift. When they do, the
 * error is bounded and visible rather than silent. Cached input is billed at
 * a tenth of the input rate.
 */

type Rate = { input: number; output: number; cached?: number };

const RATES: Record<string, Rate> = {
  // Anthropic
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-opus-4-6": { input: 15, output: 75 },
  "claude-opus-4-5": { input: 15, output: 75 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  // OpenAI, as run by codex
  "gpt-5-codex": { input: 1.25, output: 10 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5.2": { input: 1.75, output: 14 },
  "gpt-5.1": { input: 1.25, output: 10 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "o3": { input: 2, output: 8 },
  // Google, as run by the Antigravity CLI. "gemini" alone is the CLI's own
  // default model, priced at the pro rate until the slug is known.
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini": { input: 1.25, output: 10 },
};

/** Longest matching prefix, so dated model ids resolve to their family. */
function rateFor(model: string): Rate {
  if (RATES[model]) return RATES[model];
  const key = Object.keys(RATES)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (key) return RATES[key];
  // Unknown model: assume the vendor's mid-tier rather than zero. An estimate
  // that is wrong by a factor is still more honest than a confident $0.00.
  if (/^(gpt|o\d|codex)/i.test(model)) return { input: 1.25, output: 10 };
  return { input: 3, output: 15 };
}

/** True when the table has a row for this model or its family. */
export function isKnownModel(model: string): boolean {
  return Object.keys(RATES).some((k) => model === k || model.startsWith(k));
}

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number {
  const r = rateFor(model);
  const cached = r.cached ?? r.input / 10;
  const fresh = Math.max(0, inputTokens - cachedInputTokens);
  return (fresh * r.input + cachedInputTokens * cached + outputTokens * r.output) / 1_000_000;
}
