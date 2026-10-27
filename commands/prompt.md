---
description: Print the exact system prompt an agent runs under.
argument-hint: 'agent name'
---

Arguments: $ARGUMENTS. The first bare token is the agent.

If no agent is named, call `ceo_roster`, list the names in one line, and
stop.

Call `ceo_compiled_prompt` for that agent. Print the prompt text in full,
inside a fenced block, exactly as returned. Do not truncate it, reflow it,
summarise it, or comment on its wording. This command exists so someone can
read precisely what the model reads before a delegation. An edited copy is
worse than nothing.

Underneath the block, one line listing the sections that went in, in order,
as the tool reports them: identity, mission, role, collaboration,
autonomy:<level>, guardrails:<n>. A section that is absent is absent
because that field is empty. Say which one in the same line if they ask
why something is missing.

## When the prompt is overridden

If the tool reports the prompt as overridden, print this **above** the
fenced block, not after it:

    Override: this agent runs a hand-written systemPrompt. The mission,
    its collaboration brief, its autonomy wording, and every guardrail,
    org-wide ones included, are NOT in this prompt.

Then say the two things that follow, in one line each:

- Org guardrails are meant to be a floor no agent can be configured out
  of. An override is the one way through it, so what is written below is
  the whole of what this agent is told.
- The autonomy tool allowlist still applies. Overriding the prompt removes
  the wording, not the permission boundary.

The fix is to clear the agent's `systemPrompt`, which puts it back on the
compiled configuration. Offer that. Do not do it unasked.

This is the same text `/delegate` sends as the preamble, so if an agent is
behaving oddly, read this before rewriting its role brief.
