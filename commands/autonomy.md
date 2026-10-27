---
description: Show or change what an agent is allowed to do without you.
argument-hint: 'nothing, or an agent and a level'
---

Arguments: $ARGUMENTS

## When there are no arguments

Call `ceo_roster` and print one row per agent: name and autonomy level.
Underneath, print the four levels and what each actually permits:

    observe      Read, Grep, Glob, WebFetch, WebSearch. No writes, no Bash.
    propose      the above plus Bash. Still no file writes.
    execute      the above plus Write, Edit, NotebookEdit, on its own
                 branch. You merge.
    autonomous   the same tools, and it may merge to the base branch
                 unattended.

One closing line: these are tool allowlists passed to the agent at spawn,
not instructions it can talk itself out of.

## When there are arguments

    /autonomy reviewer observe
    /autonomy let implementer merge on its own
    /autonomy scout should look but not touch

Pull out:

- **agent**: the token that matches a roster name. If none matches, say
  which names exist in one line and stop.
- **autonomy**: map their words. Read-only, look but don't touch, watch,
  and report only become `observe`. Propose, draft, suggest, diff only, and
  no writes become `propose`. Can write, own branch, and normal become
  `execute`. Merge on its own, unattended, ship without me, and full
  autonomy become `autonomous`.

If the level is genuinely unclear, ask in one line and stop. Do not guess
downward or upward. Both directions are wrong in a way that matters.

Call `ceo_set_autonomy`. Confirm in one line in terms of what the agent can
now do, not the label: "reviewer can read and grep but cannot write files
or run commands, so a change it wants comes back as a description" beats
"reviewer is now observe".

When the new level is `autonomous`, add one line: nothing reviews its work
before it lands on the base branch.

The change applies to the next delegation. An agent hired with a narrower
tools list stays narrow. The level is a ceiling, not a grant.
