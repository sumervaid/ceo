/**
 * What the user should do next, derived from org state.
 *
 * Every surface that shows the org ends with one concrete next action,
 * whether the snapshot, the dashboard footer or the session-start banner. Not a menu
 * of options, not a list of available commands: the single thing that most
 * likely moves the org forward from exactly where it is.
 *
 * The ordering encodes a priority. Integrity problems outrank unfinished
 * work, which outranks unreviewed work, which outranks new work. Someone
 * whose ledger chain is broken should not be told to hire another agent.
 */

import type { OrgState } from "../tui/data.js";

export type NextStep = {
  /** One line, imperative, naming the exact command. */
  line: string;
  /** Why this and not something else. Shown only where there is room. */
  because: string | null;
  urgency: "critical" | "blocked" | "normal";
};

export function nextStep(state: OrgState): NextStep {
  // 1. Integrity. Every number in the org is downstream of the ledger, so a
  //    broken chain makes all other advice premature.
  if (state.verifyResult && !state.verifyResult.ok) {
    return {
      line: "Restore .ceo/ledger.jsonl from git history, then /ledger verify",
      because:
        "The hash chain is broken, so spend figures and provenance cannot be trusted until it is repaired.",
      urgency: "critical",
    };
  }

  // 2. Interrupted work. A dangling delegation means an agent was dispatched
  //    and never reported back, so its cost is unrecorded and its output is
  //    lost. Worth resolving before anything new is started.
  if (state.dangling > 0) {
    return {
      line: `/audit: ${state.dangling} delegation${state.dangling === 1 ? "" : "s"} started but never finished`,
      because:
        "An interrupted delegation leaves cost unrecorded. The auditor will name which agent and when.",
      urgency: "blocked",
    };
  }

  const agents = state.roster?.agents ?? [];

  // 3. Empty org. The blank page. `/hire` with no arguments proposes a
  //    starting team. Nobody has to invent one.
  if (agents.length === 0) {
    return {
      line: "/hire: no agents yet",
      because:
        "Run /hire with no arguments and it will propose a starting team based on what is in this repo.",
      urgency: "normal",
    };
  }

  // 4. Over-budget agents cannot take work, so they are a silent blocker.
  const stuck = agents.filter(
    (a) => a.budgetUsd > 0 && a.spentUsd >= a.budgetUsd,
  );
  if (stuck.length > 0) {
    const names = stuck.map((a) => a.name).join(", ");
    return {
      line: `/budget ${stuck[0].name} <amount>: ${names} ${stuck.length === 1 ? "is" : "are"} at the cap`,
      because: "An agent at its cap refuses every delegation until it is raised.",
      urgency: "blocked",
    };
  }

  // 4b. Queued work nobody is running, or blocked work nobody can. Sits
  //     under the cap check because a capped agent is the commonest cause
  //     of a blocked task and the fix is the same line.
  const tasks = state.tasks ?? [];
  const blocked = tasks.filter((t) => t.status === "blocked");
  const unassigned = blocked.filter((t) => !t.assignee);
  if (unassigned.length > 0) {
    return {
      line: `/task assign ${unassigned[0].id} <agent>: ${unassigned.length} task${
        unassigned.length === 1 ? " has" : "s have"
      } no assignee`,
      because: "An unassigned task never runs. It sits in the queue as blocked until someone owns it.",
      urgency: "blocked",
    };
  }
  const queued = tasks.filter((t) => t.status === "queued");
  const running = tasks.filter((t) => t.status === "running");
  if (queued.length > 0 && running.length === 0) {
    return {
      line: `ceo: ${queued.length} task${queued.length === 1 ? " is" : "s are"} queued and nothing is running`,
      because: "Press R on the dashboard to dispatch, or A to let idle agents pick work up as it arrives.",
      urgency: "normal",
    };
  }

  // 5. Agents but no mission. Not a blocker, since work still runs, but it
  //    sits directly under the blockers because it is the cheapest large
  //    mistake in the org. Every agent sees the mission in its compiled
  //    prompt, so an org without one has each agent guessing at the
  //    objective separately. Their guesses are wrong in different directions.
  if (!state.mission?.objective?.trim()) {
    return {
      line: "/mission: no shared objective",
      because:
        "Every agent sees the mission in its compiled prompt, so agents working without one are each guessing at the objective separately.",
      urgency: "normal",
    };
  }

  // 6. Unmerged work sitting on agent branches. Easy to forget it is there,
  //    and firing an agent with unmerged commits loses it.
  const isolated = agents.filter((a) => a.isolated);
  if (isolated.length > 0 && state.delegations.length > 0) {
    const withWork = isolated.filter((a) =>
      state.delegations.some((d) => d.agent === a.name && d.complete),
    );
    if (withWork.length > 0) {
      return {
        line: `/merge ${withWork[0].name}: review and land its work`,
        because:
          "Work on an agent branch is invisible to the base branch until merged.",
        urgency: "normal",
      };
    }
  }

  // 7. Hired but never used.
  const idle = agents.filter((a) => a.delegations === 0);
  if (idle.length === agents.length) {
    return {
      line: `/delegate ${agents[0].name} <task>`,
      because: "Every agent is hired but idle.",
      urgency: "normal",
    };
  }

  // 8. Working org that has never been audited. Drift and bad cross-agent
  //    references compound quietly, so the first audit is worth running early.
  if (state.audits.length === 0 && state.delegations.length >= 3) {
    return {
      line: "/audit: never audited",
      because:
        "The auditor catches drift from role briefs and agents citing each other's work inaccurately.",
      urgency: "normal",
    };
  }

  // 9. Steady state.
  return {
    line: `/delegate <agent> <task>`,
    because: null,
    urgency: "normal",
  };
}

/**
 * Starter role briefs, keyed by job rather than by personality.
 *
 * These are jobs an agent can hold on a software project, not character
 * types. The brief is the whole product of hiring, so each one is written
 * the way a good brief reads: second person, imperative, specific about the
 * deliverable, explicit about what NOT to do.
 */
export type RoleTemplate = {
  name: string;
  brief: string;
  /** When this role earns its place on a team. */
  when: string;
  suggestIsolated: boolean;
};

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    name: "scout",
    brief:
      "Survey the codebase and answer questions about how it is structured. Read widely before answering. Cite file paths and line numbers for every claim. When you are unsure, say so rather than guessing.",
    when: "Almost always first. Everything else works better against an accurate map.",
    suggestIsolated: false,
  },
  {
    name: "reviewer",
    brief:
      "Read diffs and flag correctness bugs. Prioritise logic errors, unhandled edge cases, and broken assumptions over style. For each finding give the file, the line, and a concrete failure scenario. Do not comment on formatting.",
    when: "Any repo where changes land regularly.",
    suggestIsolated: false,
  },
  {
    name: "implementer",
    brief:
      "Implement changes described in the task. Match the surrounding code's conventions. Make the smallest change that fully solves the problem. Do not refactor adjacent code unless the task asks for it.",
    when: "When you want agents writing code, not just reading it.",
    suggestIsolated: true,
  },
  {
    name: "tester",
    brief:
      "Write and run tests for the behaviour described. Cover the failure cases, not just the happy path. Run the suite and report actual output. If a test fails, report the failure rather than adjusting the test to pass.",
    when: "Any repo with a test suite worth keeping green.",
    suggestIsolated: true,
  },
  {
    name: "researcher",
    brief:
      "Research questions using web search and report findings. Cite a source URL for every factual claim. Distinguish what you verified from what you inferred. Report uncertainty explicitly rather than smoothing it over.",
    when: "When decisions depend on facts outside the repo.",
    suggestIsolated: false,
  },
  {
    name: "documenter",
    brief:
      "Write and update documentation to match what the code actually does. Read the implementation before describing it. Prefer short concrete examples over prose. Do not document intentions the code does not implement.",
    when: "When the README has drifted from reality.",
    suggestIsolated: true,
  },
];

export function findRoleTemplate(name: string): RoleTemplate | undefined {
  return ROLE_TEMPLATES.find((r) => r.name === name);
}
