import type { Provider } from "../shared/api";

export const PROVIDER_LABEL: Record<Provider, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini" };

export function money(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.01) return "<$0.01";
  if (v < 100) return `$${v.toFixed(2)}`;
  return `$${Math.round(v).toLocaleString()}`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function shortBase(ref: string): string {
  return ref.replace(/^origin\//, "");
}

export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function modelLabel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-/g, " ");
}

const MOD = window.ceo?.platform === "darwin" ? "⌘" : "Ctrl+";
export const mod = (k: string): string => `${MOD}${k}`;
export const SHIFT = window.ceo?.platform === "darwin" ? "⇧" : "Shift+";
