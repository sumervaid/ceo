# Judges and gates

Evidence decides which actions land. Judges supply one kind of evidence.
Gates read the evidence and decide.

## Judges

A judge check is a vote. The spec names a rubric.

```json
{ "kind": "judge", "rubric": "The change is minimal and the tests still cover the retry path.", "judges": 2 }
```

Each judge is an agent run at observe level. The process cannot write. The
run starts in the attempt's worktree. The prompt carries the task, the
rubric and the diff from the base, cut at 40,000 characters. New files are
appended to the diff. The judge ends the reply with two lines.

```
VERDICT: pass
REASON: The change touches one function.
```

The last `VERDICT` line wins. A reply without one is an error vote.

Judges come from providers other than the attempt's provider. Two models
from one family share blind spots. A second family finds more such gaps. Only
ready providers judge. When one provider is ready, that provider judges.
The spec can name providers with `providers`.

CEO hires one agent per provider on first use. The names are `judge-claude`,
`judge-codex` and `judge-gemini`. The agents sit at observe with a short
brief. Later checks reuse the agents. A roster entry with that name at a higher
level is refused, because the observe level is the control.

### Agreement

| Votes | Check status | Score |
| --- | --- | --- |
| every judge says pass | pass | 1 |
| any judge says fail | fail | the fraction of pass votes |
| no fail, one or more unread votes | error | the fraction of pass votes |
| no vote could be read | error | none |

An error never counts as a pass. An error never counts as a fail of the
work. The check records each judge's provider, model, verdict, reason,
delegation id and cost. The check cost is the sum.

Judges run after the deterministic checks. A failed required check skips the
judges, because the vote is moot.

## Action classes

An action has a class. The class decides how the gate treats the action.

| Class | Effect | Gate |
| --- | --- | --- |
| `merge` | land the winner's branch in the base branch | evidence rule, then the org setting |
| `push` | send commits to a remote | always a request |
| `pr` | open a pull request | always a request |
| `publish` | release a package or a page | always a request |
| `send` | send a message to a person | always a request |
| `pay` | move money | always a request |

The outward classes are irreversible. Evidence never skips the request. The
request shows the evidence for the person to weigh.

Gates are keyed on the action and the evidence. The seat of the agent plays
no part. The autonomy level stays a process control. The level still bounds
what the agent's process can read, run and write. Gates decide which actions
land. An agent at `autonomous` gets no shortcut past a gate.

## The merge rule

A merge lands without a request when four conditions hold.

1. The promoted attempt's verdict passed.
2. At least one deterministic check passed on the attempt. A `command` check
   or an `everval` check counts.
3. Every judge check on the attempt passed, when any exist.
4. The org setting allows auto-merge.

Any other case becomes an approval request. A task without verifiers has no
deterministic check. The merge becomes a request. A merge that conflicts
is aborted and filed as a request with the conflict named.

An automatic merge writes a note of kind `auto_merge` to the ledger. The
note carries the evidence.

### The org setting

Auto-merge is off by default. The setting lives in the ledger as a note of
kind `gates` with `{ "autoMerge": true }`. The latest note wins.

```
ceo approvals auto-merge on
ceo approvals auto-merge off
```

## Approvals

A request is a ledger event of type `approval_request`. The payload holds an
id, the action, the task and attempt, the branch, a summary and the evidence.

```json
{
  "id": "ap-3fa9c1",
  "action": "merge",
  "taskId": "t-12",
  "attemptId": "a41c9e",
  "branch": "ceo/fixer--a41c9e",
  "summary": "Merge ceo/fixer--a41c9e for Fix the flaky retry test.",
  "evidence": {
    "verdict": { "pass": true, "score": 1 },
    "checks": [
      { "name": "test -f WIN", "kind": "command", "status": "pass" },
      { "name": "2 judges: The change is minimal.", "kind": "judge", "status": "pass" }
    ],
    "judges": [{ "provider": "codex", "verdict": "pass", "reason": "One function changed." }]
  }
}
```

A decision is an `approval_decide` event with the id, the decision
`approved` or `denied`, the decider `you` and an optional result.

Approving a merge runs the merge. The result of the merge goes on the
decision. The `worktree_merge` event is written as for any merge. A merge
that conflicts leaves the conflict in the tree for resolution by hand.

Approving any other class records the decision. CEO has no executor for
push, pr, publish, send or pay yet. The result says so, and nothing is sent.

## CLI

```
ceo approvals                     list pending requests with evidence
ceo approvals approve <id>        approve one
ceo approvals deny <id>           deny one
ceo approvals auto-merge on|off   set the org setting
```

## Dashboard

`V` opens the approvals list. The selected request opens to show the
verdict, each check and each judge's vote.

| Key | Action |
| --- | --- |
| `↑` `↓` or `j` `k` | select a request |
| `a` | approve |
| `x` | deny |
| `esc` | close |

The status bar shows the count of waiting requests.

## Wiring

Importing `src/core/gates.ts` registers the judge verifier and the promote
hook. The hook runs after every promotion. A process that runs tasks as
attempts imports the module once at start.
