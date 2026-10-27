---
description: Add a hard constraint, org-wide or for one agent.
argument-hint: 'nothing, a rule, or "<agent>: rule"'
---

Arguments: $ARGUMENTS

## When there are no arguments

List what is in force. Call `ceo_mission_get` for the org rules, then
`ceo_roster` for the agent names, then `ceo_compiled_prompt` per agent and
read its hard-constraints section.

Print the org rules first under one heading, then one block per agent.
Mark any agent rule that also appears in the org list as inherited. The
point of the listing is seeing which rules an agent owns and which it
cannot be configured out of.

If no rules exist anywhere, say so in one line and stop.

## When there are arguments

    /guardrail never touch prod credentials          → org-wide
    /guardrail reviewer: do not comment on style      → reviewer only
    /guardrail for tester, never edit a test to pass  → tester only

It is agent-scoped when a roster name appears before a colon, after "for",
or as the subject of the sentence, such as "reviewer should never...".
Otherwise it is org-wide. Check the name against `ceo_roster`. An unmatched
token is part of the rule, not an agent, and scoping a rule to a typo
silently applies it to nobody.

Strip the scope prefix and keep the rest as written, in the imperative and
still phrased as a prohibition. Do not soften "never" into "avoid". One
rule per call. Split a sentence that carries two.

Call `ceo_add_guardrail` with the rule, plus `agent` when it is scoped.

Print the result verbatim, then one line of consequence:

- org-wide: every agent inherits this on its next delegation, including
  ones hired later, and no agent can be configured out of it.
- agent-scoped: only that agent sees it. The others are unchanged.

Guardrails compile last, nearest the task, which is where an instruction
carries the most weight. That is worth one line if they seem unsure
whether a rule will hold. Say it once, not on every add.
