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
import { projectRoot } from "./paths.js";
import type { Mission, VerifierSpec, VerifyStatus } from "./types.js";
import { verifierName, verifyAll, verifyEvents, type Verdict } from "./verifiers.js";

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
      ...(Array.isArray(e.data.checks) && e.data.checks.length > 0
        ? { checks: e.data.checks as VerifierSpec[] }
        : {}),
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
    checks?: VerifierSpec[];
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
  const checks = input.checks ?? previous?.checks ?? [];
  const mission: Mission = {
    objective,
    successCriteria: (input.successCriteria ?? previous?.successCriteria ?? [])
      .map((s) => s.trim())
      .filter(Boolean),
    orgGuardrails: (input.orgGuardrails ?? previous?.orgGuardrails ?? [])
      .map((s) => s.trim())
      .filter(Boolean),
    ...(checks.length > 0 ? { checks } : {}),
    setAt: Date.now(),
  };

  append(
    "mission_set",
    null,
    {
      objective: mission.objective,
      successCriteria: mission.successCriteria,
      orgGuardrails: mission.orgGuardrails,
      checks: mission.checks ?? [],
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

/** Replace the mission's checks. The objective and the rest carry forward. */
export function setChecks(checks: VerifierSpec[], cwd?: string): Mission {
  const m = current(cwd);
  if (!m) {
    throw new Error("No mission set yet. Set one first. Checks hang off the mission, since the mission is met when every check passes.");
  }
  return setMission({ objective: m.objective, checks }, cwd);
}

/** Add one machine-checkable criterion to the mission. */
export function addCheck(spec: VerifierSpec, cwd?: string): Mission {
  const m = current(cwd);
  if (!m) {
    throw new Error("No mission set yet. Set one first. Checks hang off the mission, since the mission is met when every check passes.");
  }
  const name = verifierName(spec);
  if ((m.checks ?? []).some((c) => verifierName(c) === name)) return m;
  return setChecks([...(m.checks ?? []), spec], cwd);
}

/** Run every mission check against the project root and record each result. */
export async function checkMission(cwd?: string): Promise<Verdict> {
  const root = projectRoot(cwd);
  const m = current(cwd);
  const checks = m?.checks ?? [];
  if (checks.length === 0) {
    return { pass: false, errored: false, score: 0, results: [] };
  }
  return verifyAll(checks, { root, workdir: root, scope: "mission" });
}

export type CheckState = VerifyStatus | "unknown";

export type MissionCheckStatus = {
  spec: VerifierSpec;
  name: string;
  state: CheckState;
  score: number | null;
  detail: string | null;
  /** ms epoch of the last run, or null. */
  at: number | null;
};

/** Each mission check with the result of its latest mission-scope run. */
export function missionStatus(cwd?: string): MissionCheckStatus[] {
  const checks = current(cwd)?.checks ?? [];
  if (checks.length === 0) return [];
  const latest = new Map<string, { status: VerifyStatus; score: number | null; detail: string; at: number }>();
  for (const e of verifyEvents(cwd ?? process.cwd(), { scope: "mission" })) {
    const v = e.data.verifier as { name?: string } | undefined;
    if (!v?.name) continue;
    latest.set(v.name, {
      status: e.data.status as VerifyStatus,
      score: typeof e.data.score === "number" ? e.data.score : null,
      detail: String(e.data.detail ?? ""),
      at: e.ts,
    });
  }
  return checks.map((spec) => {
    const name = verifierName(spec);
    const hit = latest.get(name);
    return {
      spec,
      name,
      state: hit?.status ?? "unknown",
      score: hit?.score ?? null,
      detail: hit?.detail ?? null,
      at: hit?.at ?? null,
    };
  });
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
