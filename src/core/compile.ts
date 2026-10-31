/**
 * Compiles an agent's configuration into the system prompt it runs under.
 *
 * Order is deliberate and worth stating, because it is the difference
 * between an agent that behaves and one that drifts:
 *
 *   1. identity      who you are
 *   2. mission       what the org is trying to achieve
 *   3. role          your job within that
 *   4. collaboration how you fit with the others
 *   5. autonomy      what you may actually do
 *   6. guardrails    what you must not do, last so it is nearest the task
 *
 * Guardrails go last on purpose. Instructions closest to the end of a
 * prompt carry the most weight. A constraint that gets ignored is worse
 * than no constraint, because it looks like a control while behaving like
 * a suggestion.
 *
 * Org guardrails and agent guardrails are merged rather than one
 * overriding the other. An org rule is a floor, not a default: an agent
 * cannot be hired out of a rule that applies to everyone.
 */

import { policyFor } from "./autonomy.js";
import { staffingPrompt } from "./chat.js";
import type { ResolvedContext } from "./context.js";
import type { AgentRecord, Mission } from "./types.js";

export type CompiledPrompt = {
  text: string;
  /** True when systemPrompt overrode everything below identity. */
  overridden: boolean;
  /** What went in, for display in the UI and for the auditor. */
  sections: string[];
};

function bullets(lines: string[]): string {
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `- ${l.replace(/^[-*]\s*/, "")}`)
    .join("\n");
}

/**
 * What the rest of the org has to say to this agent before it starts: notes
 * addressed to it, teammates' latest outputs, and whether the org tools are
 * on this run. Optional, because the MCP server and the bridge compile
 * prompts to show them, not to run them.
 */
export type PromptContext = {
  messages: Array<{ from: string; to: string; text: string }>;
  outputs: Array<{ agent: string; task: string; excerpt: string; truncated: boolean }>;
  /** True when the run has the `org` MCP tools. */
  tools: boolean;
  /** The agent's docket: context items and skills the developer gave this agent. */
  docket?: ResolvedContext[];
};

export function compileAgentPrompt(
  agent: AgentRecord,
  mission: Mission | null,
  context?: PromptContext,
): CompiledPrompt {
  // Full override. Still records that it happened, so the dashboard can
  // show that this agent is not running the compiled configuration and the
  // auditor can weigh drift findings accordingly.
  if (agent.systemPrompt && agent.systemPrompt.trim()) {
    return {
      text: agent.systemPrompt.trim(),
      overridden: true,
      sections: ["systemPrompt (override)"],
    };
  }

  const parts: string[] = [];
  const sections: string[] = [];

  parts.push(
    agent.chief
      ? `You are "${agent.name}", the chief of staff of a small org of AI agents. The operator talks to you in a chat. Each message is one reply from you.`
      : `You are "${agent.name}", one agent in a small org working a shared objective.`,
  );
  sections.push(agent.chief ? "identity:chief" : "identity");

  if (mission?.objective?.trim()) {
    const missionBlock = [`## The org's objective`, "", mission.objective.trim()];
    if (mission.successCriteria.length > 0) {
      missionBlock.push("", "This is done when:", bullets(mission.successCriteria));
    }
    parts.push(missionBlock.join("\n"));
    sections.push("mission");
  }

  if (agent.role?.trim()) {
    parts.push([`## Your job`, "", agent.role.trim()].join("\n"));
    sections.push("role");
  }

  if (agent.collaboration?.trim()) {
    parts.push(
      [`## Working with the rest of the org`, "", agent.collaboration.trim()].join("\n"),
    );
    sections.push("collaboration");
  }

  // The docket: what the developer chose to give this agent. Skills get a
  // section of their own, because they are procedures, not reference.
  const skills = (context?.docket ?? []).filter((d) => d.kind === "skill");
  const refs = (context?.docket ?? []).filter((d) => d.kind !== "skill");
  if (skills.length > 0) {
    const block = [`## Your skills`, "", "Follow a skill's workflow when the task fits when to use it. A skill's constraints bind like guardrails."];
    for (const s of skills) block.push("", `### ${s.title}`, "", s.text.trim() + (s.truncated ? "\n\n[cut to fit; the full skill is in the docket]" : ""));
    parts.push(block.join("\n"));
    sections.push(`skills:${skills.length}`);
  }
  if (refs.length > 0) {
    const block = [`## Context from the docket`, "", "The operator gave you these. Read them before you start, and cite them by title."];
    for (const r of refs) {
      block.push("", `### ${r.title}`, `${r.kind} · ${r.source}`, "", r.text.trim() + (r.truncated ? "\n\n[cut to fit the docket's limit]" : ""));
    }
    parts.push(block.join("\n"));
    sections.push(`docket:${refs.length}`);
  }

  // From the org: what teammates said and did since this agent last ran.
  // It sits before the autonomy section so the agent reads it as context,
  // not as instruction; the level and the guardrails still come last.
  if (context && (context.messages.length > 0 || context.outputs.length > 0)) {
    const block: string[] = [`## From the org`];
    if (context.messages.length > 0) {
      block.push("", "Notes from teammates, newest first:");
      for (const m of context.messages) {
        block.push(`- ${m.from}${m.to === "*" ? " (to everyone)" : ""}: ${m.text}`);
      }
    }
    if (context.outputs.length > 0) {
      block.push("", "Latest from teammates:");
      for (const o of context.outputs) {
        block.push("", `### ${o.agent}, on "${o.task}"`, "", o.excerpt + (o.truncated ? "\n[truncated; the full output is in the org's archive]" : ""));
      }
    }
    parts.push(block.join("\n"));
    sections.push(`org-context:${context.messages.length}+${context.outputs.length}`);
  }

  if (context?.tools && agent.chief) {
    parts.push(
      [
        `## Running the org`,
        "",
        "You have the org tools. org_roster lists the team with each agent's provider, level and budget left. org_providers says which of claude, codex and gemini are ready to run and which models each offers. org_running shows who is working right now, and org_trace follows one teammate live. org_outputs, org_read_output and org_board are the record of what the team did and said. org_hire adds an agent with a name, a brief, a provider, a budget and a level. org_budget sets any teammate's budget. Both draw on your allowance, and org_roster shows what is left. org_delegate gives a teammate work that starts when your reply ends, on the provider the operator named for it when there is one. org_handoff queues work that waits for the operator. org_docket lists the context the operator keeps, org_context adds an item from a path, an issue, a Hugging Face repo, a URL, a skill or a note, and org_give gives an item to a teammate or takes it away. org_ask puts a question to a teammate and waits for the answer. org_post leaves a note. org_fire removes an idle agent you hired. Work that can be checked should be: give org_delegate a verify list, such as a test command, and the task is done only when an attempt passes it. Give samples to run several attempts at once across providers and keep the winner. org_router shows which provider and model have won this kind of work before, so staff from that evidence. Say in your reply who you hired, who has what on which provider, and what budget each has.",
      ].join("\n"),
    );
    sections.push("org-tools:chief");
  } else if (context?.tools) {
    parts.push(
      [
        `## Working with the org`,
        "",
        "You have the org tools. org_roster lists your teammates and what each may do; org_mission is the shared objective; org_outputs and org_read_output are their archived results. org_running shows who is working right now and org_trace shows what a teammate is doing as it happens. org_post leaves a note for a teammate or for everyone; a note to a teammate who is running reaches them at their next turn, and notes to you arrive the same way, as a new turn that starts with what was posted. org_ask puts a question to one teammate and waits for the answer; answer a question put to you with org_post to its author, giving the ask id. org_handoff queues a task for a teammate, which a person or the dispatcher starts later under that teammate's own budget. Use a handoff for work that is theirs, not to avoid your own. You cannot start runs, change budgets or levels, or settle anyone's cost, including your own. Mention every note, question and handoff in your final report.",
      ].join("\n"),
    );
    sections.push("org-tools");
  }

  const policy = policyFor(agent.autonomy);
  parts.push([`## What you may do`, "", agent.chief ? staffingPrompt(agent.autonomy) : policy.prompt].join("\n"));
  sections.push(agent.chief ? `staffing:${policy.level}` : `autonomy:${policy.level}`);

  // Merged, org first, deduplicated case-insensitively so an agent
  // restating an org rule does not produce it twice.
  const seen = new Set<string>();
  const rails: string[] = [];
  for (const r of [...(mission?.orgGuardrails ?? []), ...(agent.guardrails ?? [])]) {
    const key = r.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rails.push(r.trim());
  }
  if (rails.length > 0) {
    parts.push(
      [
        `## Hard constraints`,
        "",
        "These are not preferences. If a task appears to require breaking one, stop and say so instead.",
        "",
        bullets(rails),
      ].join("\n"),
    );
    sections.push(`guardrails:${rails.length}`);
  }

  return { text: parts.join("\n\n"), overridden: false, sections };
}

/**
 * Short human-readable summary of an agent's configuration, for the
 * dashboard and for `/roster`. Deliberately compact: the full prompt is
 * available on demand, and this is the at-a-glance version.
 */
export function describeConfig(agent: AgentRecord): string {
  const bits: string[] = [policyFor(agent.autonomy).level];
  if (agent.systemPrompt?.trim()) bits.push("custom prompt");
  if (agent.guardrails?.length) bits.push(`${agent.guardrails.length} guardrails`);
  if (agent.collaboration?.trim()) bits.push("collab brief");
  if (agent.isolated) bits.push("isolated");
  return bits.join(" · ");
}
