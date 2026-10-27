/**
 * The org's shared objective.
 *
 * Stored in the ledger rather than in a settings file, for the same reason
 * spend is: it changes, and the change matters. When an agent's output
 * looks wrong six weeks later, "what was the org actually pointed at when
 * this ran" is a question the ledger can answer and a config file cannot.
 *
 * `current()` replays mission_set events, so the mission at any point in
 * history is recoverable by replaying to that seq.
 */

import { append, readLedger } from "./ledger.js";
import type { Mission } from "./types.js";

export function current(cwd?: string): Mission | null {
  let mission: Mission | null = null;
  for (const e of readLedger(cwd)) {
    if (e.type !== "mission_set") continue;
    mission = {
      objective: String(e.data.objective ?? ""),
      successCriteria: Array.isArray(e.data.successCriteria)
        ? (e.data.successCriteria as string[])
        : [],
      orgGuardrails: Array.isArray(e.data.orgGuardrails)
        ? (e.data.orgGuardrails as string[])
        : [],
      setAt: e.ts,
    };
  }
  return mission;
}

export function setMission(
  input: {
    objective: string;
    successCriteria?: string[];
    orgGuardrails?: string[];
  },
  cwd?: string,
): Mission {
  const objective = input.objective.trim();
  if (objective.length < 10) {
    throw new Error(
      "A mission needs at least a sentence. Every agent sees this, so a vague objective produces vague work across the whole org at once.",
    );
  }

  const previous = current(cwd);
  const mission: Mission = {
    objective,
    successCriteria: (input.successCriteria ?? previous?.successCriteria ?? [])
      .map((s) => s.trim())
      .filter(Boolean),
    orgGuardrails: (input.orgGuardrails ?? previous?.orgGuardrails ?? [])
      .map((s) => s.trim())
      .filter(Boolean),
    setAt: Date.now(),
  };

  append(
    "mission_set",
    null,
    {
      objective: mission.objective,
      successCriteria: mission.successCriteria,
      orgGuardrails: mission.orgGuardrails,
      previousObjective: previous?.objective ?? null,
    },
    cwd,
  );

  return mission;
}

/** Add one org-wide guardrail without rewriting the objective. */
export function addOrgGuardrail(rule: string, cwd?: string): Mission {
  const m = current(cwd);
  if (!m) {
    throw new Error(
      "No mission set yet. Run /mission first. Org guardrails hang off the mission so every agent inherits them.",
    );
  }
  const trimmed = rule.trim();
  if (!trimmed) throw new Error("A guardrail needs text.");
  if (m.orgGuardrails.some((g) => g.toLowerCase() === trimmed.toLowerCase())) {
    return m;
  }
  return setMission(
    {
      objective: m.objective,
      successCriteria: m.successCriteria,
      orgGuardrails: [...m.orgGuardrails, trimmed],
    },
    cwd,
  );
}

/** Full history of mission changes, for the audit trail. */
export function history(
  cwd?: string,
): Array<{ ts: number; objective: string; seq: number }> {
  return readLedger(cwd)
    .filter((e) => e.type === "mission_set")
    .map((e) => ({
      ts: e.ts,
      seq: e.seq,
      objective: String(e.data.objective ?? ""),
    }));
}
