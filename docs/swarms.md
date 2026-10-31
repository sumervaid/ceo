# Swarms and limits

A swarm is many copies of one agent, hired in one step. Each member is an
ordinary agent with a budget, a level, a branch and a ledger history. The
swarm has no special state. Nothing in CEO caps the count of agents or the
count running at once. The ceilings belong to the providers and to the
machine.

## Three ways to hire a swarm

| Way | How |
| --- | --- |
| Company size | `+` opens the company picker. `←` `→` set the team size. Each seat becomes that many agents. `ceo company <id> --size 8` does the same. |
| The command | `ceo swarm <name> <n>` hires `n` copies of one agent. |
| The chief of staff | A sentence such as "hire twelve fixers across claude, codex and gemini" becomes one `org_hire` call with `count` and `providers`. |

### Company size

The picker offers sizes of 1 to 5, then 8, 10, 12, 16, 20, 25, 30, 40 and
50. At size 8, the software team's four seats become thirty-two agents.
Each seat's agents are named `<seat>-01`, `<seat>-02` and so on. The
agents are dealt across every ready provider, starting with the seat's own.
The picker shows the total of agents and of budgets before `enter` hires.

```sh
ceo company software --size 4
```

`--size` stops at 50 per seat.

### `ceo swarm`

```sh
ceo swarm fixer 12
ceo swarm fixer 12 --providers claude,codex --budget 1.5
ceo swarm fixer 12 --brief "Fix one flaky test and report how it was checked." --task "Pick a flaky test and fix it."
```

| Flag | Default | Sets |
| --- | --- | --- |
| `--brief` | A general fixer brief | What each member does |
| `--providers` | Every ready provider | The providers to deal across |
| `--budget` | 2 | Each member's budget in dollars |
| `--level` | `execute` | `observe`, `propose`, `execute` or `autonomous` |
| `--task` | None | A task queued for every member |

Members at `execute` or above get a worktree when the directory is a
repository with a commit. `R` in the dashboard dispatches the queued tasks.
`A` keeps dispatching.

### The chief of staff

`org_hire` takes `count` and `providers`. The count runs from 1 to 1000. The
chief deals the members across the providers named. With none named, the
chief uses the single provider of the call. Every budget comes from the chief's allowance.
A swarm of twelve at $2 draws $24. A swarm too big for the allowance is
refused with the figure left. The chief has no limit per reply by default.
`CEO_CHIEF_MAX_HIRES` sets one. See [chat](chat.md).

## Naming and dealing

Members are named `<name>-01`, `<name>-02` and so on. The number is padded
to two digits, or more for a count above 99. A name already in the org is
skipped. A swarm of one keeps the bare name.

Providers are dealt round-robin in the order given. A swarm of nine on
claude, codex and gemini is three of each. A swarm of ten is four, three and
three. Every member's brief ends with a line that asks the member to claim
work on the board before starting. The line keeps two members off one piece.

A member that cannot be hired is reported. The rest go ahead. One `note`
of kind `swarm` in the ledger records the name, the count, who was hired and
who failed.

## What actually limits a swarm

Neither `claude -p` nor `codex exec` limits how many processes run at once.
CEO adds no limit either. Three ceilings exist.

| Ceiling | Who sets it | What it looks like |
| --- | --- | --- |
| The plan's usage window | The provider. A Claude subscription and a ChatGPT subscription each have a rolling usage window and a weekly cap. Every session on the account draws on the same window. | Runs are refused with a usage limit message until the window resets. |
| API-key rate limits | The provider. A metered key has requests and tokens per minute. | Runs are refused with a rate limit or a 429. The refusals clear within a minute or so. |
| Machine memory | The machine. Each agent is a node process plus an MCP server. Together the two take a few hundred megabytes. | Swapping, then killed processes. |

More agents on one subscription draw on one window. The window empties
sooner with more agents working. A budget in CEO caps dollars. A budget
does not cap the window. See [money](money.md).

## How CEO handles a limit

A provider limit is not a failure of the work. A run refused for a rate or
usage limit is handled in five steps.

1. The runner reads the run's error for a limit. The agent's own prose is
   never read.
2. The task goes back to the queue. The task's status is `queued`. The
   `delegate_end` entry records the outcome `rate_limited`. A `note` of kind
   `rate_limited` records the provider and the time `retryAt`.
3. The provider cools down. A stated reset time is honoured: an epoch, a
   wait such as "try again in 20s", or a clock time such as "resets 3pm".
   A limit with no stated time backs off for 1, 2, 4 minutes and so on, up
   to 30.
4. The dispatcher holds every task for that provider until the cooldown
   ends. Tasks for other providers keep running.
5. The dashboard re-dispatches when the limit lifts. No key is needed.

The run shows the status `waiting` while the limit holds. In the
[constellation](sky.md) the star becomes `◌`. The header names the provider
and the time left.

The cooldown lives in the dashboard process. A restart of the dashboard
clears the cooldown. The next refusal sets the cooldown again. A run
refused for a limit still records what the run spent. The record is the
usual one, settled or estimated. See [money](money.md).

### The limit alert

The `limit` event raises an alert when a provider hits a limit. The event is
on by default. Digit `7` on the integrations screen turns the event on and
off. `ceo alerts limit off` does the same from the terminal. See
[integrations](integrations.md#alerts).

### `CEO_MAX_RUNNING`

By default the dispatcher starts every queued task that has an idle agent.
`CEO_MAX_RUNNING=8` sets a ceiling of eight runs at once. Tasks beyond the
ceiling wait in the queue. `0`, `none`, `unlimited` and `off` mean no
ceiling.

The ceiling suits a machine with little memory. The ceiling also suits a
plan with a small window. A smaller ceiling spreads the same spend over a
longer time.

```sh
CEO_MAX_RUNNING=8 ceo
```

## In the ledger

| Event | Written when |
| --- | --- |
| `hire` | Each member is hired |
| `note` of kind `swarm` | A swarm is hired, with the names hired and failed |
| `delegate_end` with `outcome: "rate_limited"` | A provider limit refused a run |
| `note` of kind `rate_limited` | The provider, the delegation and `retryAt` |
