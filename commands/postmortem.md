---
description: Post-mortem a delegation or an agent's run: what went wrong and why.
argument-hint: '[agent | delegation-id]'
---

Arguments: $ARGUMENTS. An agent name, a delegation id, or empty for the most
recent delegation.

1. Call `ceo_recent_delegations` with `n: 20` to resolve the subject. If the
   argument matches no agent and no id, say so in one line and stop.
2. Call `ceo_ledger_tail` with `n: 100` for surrounding context, and
   `ceo_worktree_status` if the subject agent is isolated.
3. Spawn the `ceo-postmortem` subagent with the Agent tool. Give it the
   subject, which is the agent name and/or delegation id, the delegation
   rows, and the archived output paths under `.ceo/outputs/`. Tell it to
   read those outputs itself and to answer: what was asked, what came back,
   where they diverged, what it cost, and the one change that would have
   prevented it.

Print its report as it comes back. Then call `ceo_note` with a one-sentence
summary of the conclusion, `agent` set to the subject when it is an agent, so
the finding lands in the ledger. Print the note's seq line verbatim.

Blame the brief and the setup, not the agent. Do not fire anyone.
