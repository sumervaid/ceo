# Design

Four decisions that shape everything else.

## The ledger is the authority; roster.json is a cache

`.ceo/ledger.jsonl` is an append-only log of every event: hires, fires,
budget changes, delegation starts and ends, worktree provisions and commits and
merges, audits, notes. `roster.json` holds none of that. `roster.json` is a
projection, written at mutation time so a reader does not have to replay the
log for the common case.

Every derived field is recomputed from the ledger on every read and
overlaid on the cached record: `spentUsd`, `delegations`, `lastActiveAt`,
`budgetUsd`, `branch`, `worktreePath`. So a stale cache cannot cause a wrong decision.
Delete `roster.json`. `rebuild()` reconstructs the file by replay. When the two
disagree, the ledger wins by construction. The cache has nothing to be right
about.

This is what makes the budget gate trustworthy. Spend is not a counter that a
writer increments and could forget. Spend is a sum over `delegate_end` entries,
recomputed at gate time. There is no path where an agent overspends because a
write was lost.

The corollary is a hard rule: never mutate an entry. A correction is a new
entry. Rewriting an entry breaks the chain for every entry after that one. The
chain is the only thing making the shared, committed ledger worth trusting.

## Every write takes the lock

The dashboard, the slash commands, hooks and subagents all read `.ceo/`
directly. Reads are cheap. A read cannot corrupt the ledger. Every write
goes through `append()` in core. Five writers exist: the MCP server, the
dashboard, the runner, the `ceo` command line and `ceo op`. All five call
the same core functions.

The reason is the chain. `append()` reads the current tail to compute `seq`
and `prevHash`, then appends. Two processes doing that concurrently would
both read the same tail. Both would write an entry with the same seq and
the same `prevHash`. That is a fork. `verify()` catches a fork only after
the fact. No clean repair exists. Renumbering requires rehashing everything
downstream. O_APPEND stops lines from interleaving. O_APPEND does not stop
the fork.

`append()` therefore holds an exclusive file lock around the read of the
tail and the write. The lock file is opened with `wx`, which is atomic. The
lock records the pid and the hostname. A lock older than ten seconds is
treated as abandoned and broken. A crashed process cannot wedge the org.
A command that appends to the ledger file directly is a bug, not a
shortcut.

Core also holds the refusals. `requireOrg`, `requireAgent` and the budget
gate live there. Every surface refuses the same way, with the same message
naming the command that fixes the refusal.

## Delegation is split into begin and end

`begin()` runs the budget gate and writes `delegate_start`. The runner then
spawns the agent's CLI: `claude -p`, `codex exec` or `agy -p`. `end()`
archives the output to `.ceo/outputs/<id>.md`. `end()` writes
`delegate_end` with the cost. An isolated agent's worktree is committed at
the same point.

A single `delegate()` call could not do this. Cost is not known until the
process exits. The gate has to run before the process starts. An operation
that spans "before the start" and "after the exit" has to be two calls. The
same split serves the Claude Code plugin, where the session's own Agent
tool does the work between the two calls.

The split also buys the failure signal. An interrupted delegation leaves a
`delegate_start` with no matching `delegate_end`: a dangling entry.
`danglingDelegations()` finds dangling entries by id. The dashboard counts
the entries. The auditor reports each as "this agent was cut off mid-task". With
one atomic call, an interrupted delegation would leave nothing at all: the
most interesting failure mode would be the failure the record could not see.

Cost is written only on `delegate_end`, which is why `rollup()` reads that
event type alone. A started-but-unfinished delegation contributes nothing to
spend, correctly, since nothing settled.

## One worktree per isolated agent

An agent hired `--isolated` gets a git worktree at
`.ceo/worktrees/<name>` on `ceo/<name>`. Three agents can then edit the
same file at once without clobbering each other, because the three are editing
three checkouts. Branch-switching in a shared tree would not work. The agents
run concurrently. A branch is per-tree state.

Worktrees also make review possible. Work arrives as commits on a named branch
that can be diffed, reverted, or dropped wholesale. Nothing an isolated agent
does touches the main working tree until a merge, `m` on the dashboard. A merge that conflicts
reports a file list rather than half-applying.

The commit trailers `CEO-Agent`, `CEO-Ledger-Seq` and `CEO-Cost-Usd`
exist so provenance survives outside CEO. `CEO-Ledger-Seq` is the join
key back to the full record: task text, archived output, token counts,
duration. A reader of `git log` a year from now, with no `.ceo/`
present, can still see which agent wrote a line and what the line cost.

Not every agent needs this. Agents that only read, or that write in a lane
no other agent touches, are cheaper without a worktree. `isolated` defaults to
false.
