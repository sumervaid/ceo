---
description: Show or set the org's mission: objective, success criteria, guardrails.
argument-hint: 'nothing, or what the org is trying to achieve'
---

Arguments: $ARGUMENTS

## When there are no arguments

Call `ceo_mission_get` and print its output verbatim.

If there is no mission, do not print an empty template. Say, in two lines,
that every agent's prompt is compiled with the mission at the top. Without
one, each agent works from its own brief alone and nothing points them at
the same target. Then ask for one sentence on what the org is trying to
achieve, and stop.

## When there are arguments

Plain English, not flags:

    /mission ship the billing migration with zero downtime. done when no
    customer errors and rollback is tested. never touch prod credentials.

Split on sentences and sort each into one of three buckets:

- **orgGuardrails**: prohibitions. Triggered by never, don't, do not, must
  not, no one may, under no circumstances, avoid. Keep the prohibition
  wording. Drop a leading "and" or "also".
- **successCriteria**: completion conditions. Triggered by done when,
  finished when, success is, ships when, until, with zero, so long as.
  Rewrite each as something that can be checked, not hoped for: "rollback
  tested against staging", not "rollback works well".
- **objective**: everything left, joined back into prose. The target, not
  the constraints on reaching it.

In the example above: objective is the billing migration with zero
downtime. Success criteria are no customer errors and a tested rollback.
The guardrail is prod credentials.

Call `ceo_mission_set` with all three. Setting a mission replaces the
objective and criteria wholesale. Carry forward anything they did not
mention only when they are clearly amending rather than restating. If that
is ambiguous, ask in one line and stop.

Print the result verbatim, then one line: this reaches every agent on its
next delegation, not the ones already running.
