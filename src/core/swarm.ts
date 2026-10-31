/**
 * Swarms: many copies of one agent, hired in one step.
 *
 * A swarm is a name, a count, a brief and the providers to spread across.
 * The agents are named `<name>-01`, `<name>-02` and so on, skipping any
 * name already in the org. Providers are dealt round-robin, so a swarm of
 * nine on claude, codex and gemini is three of each. Every member is an
 * ordinary agent with its own budget, level, branch and ledger history.
 *
 * Nothing caps the count. The budgets cap the spend. A provider's rate or
 * usage limit pauses that provider's runs until the limit lifts, see
 * `limits.ts`.
 */

import { append } from "./ledger.js";
import { providerFor } from "./providers.js";
import { hire, readRoster } from "./roster.js";
import type { AgentRecord, AutonomyLevel, Provider } from "./types.js";

/** Names for `count` members of a swarm called `base`, skipping names in `taken`. */
export function swarmNames(base: string, count: number, taken: Set<string>): string[] {
  if (count <= 0) return [];
  if (count === 1 && !taken.has(base)) return [base];
  const width = Math.max(2, String(count).length);
  const out: string[] = [];
  for (let i = 1; out.length < count; i++) {
    const name = `${base}-${String(i).padStart(width, "0")}`;
    if (!taken.has(name)) out.push(name);
  }
  return out;
}

/** Deal `count` seats across providers, round-robin, in the order given. */
export function spreadProviders(count: number, providers: Provider[]): Provider[] {
  const list = providers.length > 0 ? providers : (["claude"] as Provider[]);
  return Array.from({ length: count }, (_, i) => list[i % list.length]);
}

/** "3 claude · 3 codex · 2 gemini". */
export function describeSpread(providers: Provider[]): string {
  const counts = new Map<Provider, number>();
  for (const p of providers) counts.set(p, (counts.get(p) ?? 0) + 1);
  return [...counts.entries()].map(([p, n]) => `${n} ${p}`).join(" · ");
}

export type SwarmInput = {
  name: string;
  count: number;
  brief: string;
  providers: Provider[];
  /** Each member's budget. */
  budgetUsd: number;
  autonomy?: AutonomyLevel;
  isolated?: boolean;
  guardrails?: string[];
  /** The agent that hired the swarm, when an agent did. */
  by?: string | null;
};

export type SwarmResult = { hired: AgentRecord[]; failed: string[] };

/** Hire every member. A member that cannot be hired is reported and the rest go ahead. */
export function hireSwarm(input: SwarmInput, cwd?: string): SwarmResult {
  const count = Math.max(1, Math.floor(input.count));
  const taken = new Set(readRoster(cwd).agents.map((a) => a.name));
  const names = swarmNames(input.name, count, taken);
  const providers = spreadProviders(count, input.providers);
  const hired: AgentRecord[] = [];
  const failed: string[] = [];
  names.forEach((name, i) => {
    const provider = providers[i];
    try {
      hired.push(
        hire(
          {
            name,
            role: count > 1 ? `${input.brief}\n\nOne of ${count} in the ${input.name} swarm. Claim work on the board before starting, so two members never do the same piece.` : input.brief,
            provider,
            model: providerFor(provider).defaultModel(),
            budgetUsd: input.budgetUsd,
            autonomy: input.autonomy ?? "execute",
            isolated: input.isolated,
            guardrails: input.guardrails ?? [],
            by: input.by ?? null,
          },
          cwd,
        ),
      );
    } catch (e) {
      failed.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  append("note", input.by ?? null, {
    kind: "swarm",
    name: input.name,
    count,
    hired: hired.map((a) => a.name),
    failed,
  }, cwd);
  return { hired, failed };
}
