# Companies

A company is a whole team hired in one keystroke. Each company is a set of
seats on mixed providers, plus a chief of staff to talk to. From an empty
directory, `ceo` then `n` then `enter` hires five agents on claude, codex
and gemini and opens the chat. The whole path takes under ten seconds.

<p align="center">
  <img src="company.gif" alt="The company picker: six teams, each seat with provider, level, budget and worktree; w cycles worktrees; enter hires" width="900">
</p>

## Starting one

| Where | Key |
| --- | --- |
| A directory with no org | `n` creates the org and opens the picker |
| The dashboard | `+` opens the picker |
| The terminal | `ceo company <id>` hires one, `ceo company` lists the companies |

The picker shows every company and, below the list, exactly what `enter`
would hire: each seat with the seat's provider, model, level, budget and
worktree, then the total of the budgets. `↑` `↓` or the digits `1` to `6` pick a
company. `w` cycles the worktree choice. `enter` hires the company and
opens the chat with the chief of staff. Nothing runs until work is given.

## The companies

| Id | Company | Seats | Budgets |
| --- | --- | --- | --- |
| `software` | Software team | scout on claude, implementer on codex, reviewer on gemini, tester on codex | $12 |
| `bugs` | Bug squad | triager on claude, fixer on codex, tester on gemini | $9 |
| `review` | Review desk | correctness on claude, security on codex, tests on gemini | $6 |
| `docs` | Docs studio | reader on gemini, writer on claude, editor on codex | $6 |
| `research` | Research lab | researcher on claude, analyst on gemini, checker on codex | $7 |
| `full` | Full company | the software team plus a documenter on claude | $14 |

Every company also hires a chief of staff, unless the org already has
one. The chief's replies have no cap. The chief brings a $25 allowance to
give other agents as budgets. The figures above are the seats' budgets
alone. See [chat](chat.md).

The providers are starting points, not part of the roles. A seat whose
provider is not ready moves to the next ready provider, and the picker
marks the move in yellow. `v` on the roster moves any agent later.

No seat is hired at `autonomous`. Readers sit at `observe` or `propose`.
Writers sit at `execute`, where a human merges every branch.

## Worktrees

A worktree gives an agent a private checkout on branch `ceo/<name>`.
The agent's changes land there instead of the main tree. `m` merges the
branch. Commits carry provenance trailers naming the agent, the run and the
cost.

The picker sets worktrees for the whole company with `w`:

| Choice | Who gets a worktree |
| --- | --- |
| writers | Every agent that writes files. The default in a repository with a commit. |
| all | Every agent, readers included |
| none | Nobody. Everyone works in the main tree. |

A worktree needs a git repository with at least one commit. Without one,
the picker says so, and everyone works in the main tree.

Worktrees also come one agent at a time:

- `i` on the roster gives the selected agent a worktree and a branch from
  the next run on.
- The hire form's `isolated` field does the same at hire time.
- `org_hire` gives a hire by the chief of staff a worktree by default at
  `execute` in a repository.

Taking a worktree away is a merge or a discard first. That decision belongs
to the merge dialog, so `i` only ever adds one.

## From the terminal

```
ceo company
ceo company software
ceo company review --worktrees none
ceo company full --worktrees all
```

`ceo company <id>` creates the org when the directory has none, hires the
company, and prints each seat with the seat's provider, level, budget and branch. A
seat already in the org is kept and named in the summary.

## In the ledger

Each seat is an ordinary `hire` event. One `note` of kind `company` records
the company, the worktree choice, and who was hired, kept or refused.
