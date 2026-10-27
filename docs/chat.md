# Chat

The chat is a conversation with the org's chief of staff. A message such
as "get the flaky test fixed and reviewed" becomes a team at work. The
chief picks a teammate for each piece, hires one on any provider when
nobody fits, and gives out the work. The work starts when the reply ends.
Every hire, task and dollar lands in the ledger beside the message that
asked for the work.

<p align="center">
  <img src="chat.gif" alt="One message to the chief of staff: a reviewer is hired on gemini, the fix goes to the coder on codex, both runs start when the reply ends" width="900">
</p>

## Opening the chat

Press `C` on the dashboard, or run `ceo chat`. The first time, CEO hires a
chief of staff with these defaults:

| Field | Default |
| --- | --- |
| Name | `chief`, or `chief-of-staff` when an agent already holds `chief` |
| Provider | The first ready one, in the order claude, codex, gemini |
| Budget | None. The chief's replies have no cap. |
| Allowance | $25: the money the chief may give other agents as budgets |
| Level | `execute`: the chief hires and starts work |
| Brief | Turn requests into staffed work, give every task a definition of done, keep replies short |

The chief appears on the roster with a diamond. Budget, level and provider
change the same way as for any agent: `b`, `y` and `v` on the roster.

## What a message does

A message is a run of the chief. The first message opens a CLI session.
Each later message resumes that session, so the conversation is a single
session on the provider's side. The ledger records the operator's words as
the run's task and the reply as the run's output.

During the reply, the chief works through the org tools. The chat draws
each staffing action from the ledger, above the reply text:

```
chief  + hired reviewer on gemini · propose · $2 budget
       $ coder budget $6, was $4
       ▸ coder    codex   Make the flaky retry test pass ten times in a row.  ⠙ running
       ▸ reviewer gemini  Review the retry fix on coder's branch.             ⠙ running

       The fix is on codex and the review on gemini, as asked.
       $0.0089 · claude sonnet-5
```

| Mark | Meaning |
| --- | --- |
| `+` | A hire by the chief, with provider, model, level and budget |
| `$` | A budget the chief set, with the figure before |
| `▸` | Work given with `org_delegate`, with the provider the task runs on. A provider the operator named is bold. The status beside the task is live. |
| `◦` | Work queued with `org_handoff`. The task waits for the operator. |
| `×` | An agent the chief fired |
| `›` `?` | A note or a question the chief posted |

A hire or a delegation is a ledger event, not a sentence in the reply. The
model cannot misreport one.

## When the work starts

The dashboard starts each delegated task when the reply ends. The
operator's message is the authorization for that spend. A task for an
agent that is already running waits. The task starts when that agent's
current run settles. A blocked task stays blocked, with the reason in the
queue.

## What the chief may do

The chief's own process is read-only on every provider. The chief reads
the repository and the org, never writes code. The chief's level decides
what the chief may do to the org. The org server enforces each rule at
call time, against the level on the roster at that moment.

| Level | The chief may |
| --- | --- |
| `observe` | Answer questions about the org. Nothing else. |
| `propose` | Queue work with `org_handoff`. The operator starts the task. |
| `execute` | Hire, and give work that starts when the reply ends |
| `autonomous` | All of the above, and fire an idle agent the chief hired |

Limits that hold at every level:

- Every budget the chief gives comes from the allowance. A hire's budget and a raise draw on the allowance. A cut returns what the chief had given.
- The chief hires at most 3 agents per reply. `CEO_CHIEF_MAX_HIRES` changes the figure.
- A hire is at `execute` or below, and never above the chief's own level.
- The provider of a hire must be ready. `org_providers` tells the chief which ones are.
- No level lets the chief change a level, or settle a cost.
- The chief fires only agents the chief hired, and only while idle.

Every refusal names what would succeed, so the chief can recover inside
the same reply. A hire too big for the allowance, for example, comes back
naming what is left and the three ways forward: a smaller budget, a cut
elsewhere, or a raise of the allowance by the operator.

## The tools only the chief has

| Tool | Does |
| --- | --- |
| `org_providers` | Which of claude, codex and gemini are ready, the models of each, how many agents run on each |
| `org_hire` | Hire with a name, brief, provider, model, budget, level, worktree and guardrails |
| `org_budget` | Set any teammate's budget, from the allowance |
| `org_delegate` | Give a teammate work that starts when the reply ends, on a named provider when there is one |
| `org_fire` | Fire an idle agent the chief hired, with a reason |
| `org_docket` | Every docket item, with the size of each and the teammates who hold each |
| `org_context` | Add a file, folder, issue, pull request, Hub card, paper, page, skill or note to the docket, then give the item to teammates |
| `org_give` | Give a docket item to a teammate, or take the item back |

The chief also has every tool on the [collaboration](collaboration.md)
page: the roster, the board, outputs, live traces, notes, questions and
handoffs.

## Naming providers

A request can say which provider does which part: "put the fix on codex and
the review on gemini", or "claude maps the callers". The chief passes the
provider with each piece of work. `org_delegate` records the provider on
the task, and the run uses that provider and the provider's default model. The
agent's own setting stays, so the next task runs where the agent usually
does. The chat shows the provider beside every delegation, bold when the
operator named the provider. The queue says "on gemini". The live view puts the card
in that provider's column while the run is live. A new hire takes the
named provider directly.

## Switching the chief's provider

`ctrl-p` in the chat, or `v` on the roster, moves the chief to the next
provider. A CLI session cannot cross providers. The next message therefore
opens a fresh session, and the prompt carries a recap of the exchange so
far. The conversation continues across the provider line. The transcript
shows which provider wrote each reply.

## What reaches the chief between messages

A resumed session keeps the system prompt from the first message. Each
later message therefore carries a short "Since your last reply" section:
runs that finished since, with an excerpt and the cost of each, and notes
addressed to the chief. The chief learns that delegated work came back
without being asked.

## Keys

| Key | Does |
| --- | --- |
| `enter` | Send. Refused while the chief is replying. The draft stays. |
| `↑` `↓` `pgup` `pgdn` | Scroll the conversation |
| `←` `→` `ctrl-a` `ctrl-e` | Move in the draft |
| `ctrl-u` `ctrl-k` `ctrl-w` | Delete to the start, to the end, the word before the caret |
| `ctrl-n` | A new conversation. The next message opens a fresh session with no recap. |
| `ctrl-p` | Move the chief to the next provider |
| `ctrl-l` | Cycle the chief's level |
| `esc` | Back to the dashboard. The draft is kept. |
| `ctrl-c` | Quit |

## Money

The chief's replies have no cap. Each one answers a message the operator
typed, and the ledger records each reply's cost like any other run.
The chief's budget field is an allowance instead: the money the chief may
give other agents. `b` on the chief sets the allowance.

The chief's share of an agent's budget is the part above what the operator
gave that agent. An agent the chief hired is the chief's in full. A raise
by the chief grows the share. A cut shrinks the share and returns money to
the allowance. A budget the operator sets resets the base, so the share
goes back to zero. A fired agent returns the whole share.
The team column shows the allowance given and left, and two figures for the
conversation. "replies" is what
the chief's runs cost. "team" is what the work the chief gave out has
cost so far, across every agent. The roster shows each agent's spend
against that agent's own cap.

## In the ledger

| Event | Written when |
| --- | --- |
| `hire` with `chief: true` | The chief of staff is hired |
| `delegate_start` with `via: "chat"` | A message is sent. `resumed` names the session, when resumed. |
| `delegate_end` with `sessionId` and `outcome` | The reply ends |
| `hire` with `by: <chief>` | The chief hires |
| `task_add` with `requestedBy` and `autoStart: true` | The chief delegates |
| `fire` with `by: <chief>` | The chief fires |
| `note` of kind `chat_new` | A new conversation starts |

`ceo trace chief` replays the latest reply. The conversation itself is
the chief's runs since the last `chat_new` note, read back from the
ledger. The chat therefore survives a restart of the dashboard.
