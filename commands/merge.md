---
description: Merge an isolated agent's branch back into the current branch.
argument-hint: 'agent name'
---

Arguments: $ARGUMENTS

The first bare token is the agent. Anything else is intent:

    /merge builder
    /merge builder, fast forward is fine

Set **noFastForward** false only when they explicitly allow a fast-forward.
Default is a merge commit, which keeps the agent's work visible as a
distinct unit in history rather than flattening it into the base branch.

First call `ceo_unmerged` for the agent and print the commit count in one
line, so they see what is about to land.

Then call `ceo_merge`.

On success print the resulting sha in one line.

On conflict, print the conflicted file list verbatim and stop. Do not
attempt to resolve conflicts yourself. The agent's intent and the base
branch's intent both need a human read. Tell them the branch name so they
can resolve it directly.

If the agent has no branch, print the error verbatim. It explains that only
agents hired with isolation get one.
