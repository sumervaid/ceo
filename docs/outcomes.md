# Outcomes, not dollars

The ledger records every dollar. A dollar is a poor unit for deciding where
work goes next. An org that spent $3 and landed four verified results is in
better shape than one that spent $1 and landed none. Outcomes make that
difference visible.

The budget of a company is therefore attempts and verified outcomes.
Dollars stay as a column beside them. Agent budgets still cap dollars. Both
limits apply at the same time.

## What counts

| Figure | Meaning |
| --- | --- |
| attempts | Attempts started, plus plain tasks that ran once |
| finished | Attempts that ended done, plus plain tasks that reached done |
| verified | Promotions. A task with checks reaches done only through one |
| unverified | Plain tasks that reached done with no verifier to say so |
| failed tasks | Tasks that settled failed |
| spent | Attempt costs, plus the cost of delegations outside any attempt |
| $/verified | Spent divided by verified. Empty while nothing is verified |
| pass rate | Verified divided by verified plus failed tasks |

A plain task is a task that never ran as attempts. A plain task that fails
counts as an attempt, because the run happened and cost money.

Every figure is read from the ledger in one pass. Nothing is stored beside
the ledger, so nothing can disagree with it. A run that spent money never
counts as free. An attempt with no `attempt_end` entry takes the settled
cost of the delegation that ran it.

## The outcome budget

Each workspace carries one budget, stored as a ledger note of kind
`outcome_budget`. The latest note wins.

| Field | Effect |
| --- | --- |
| `attempts` | Caps the attempts started in the period |
| `verified` | A target. Once reached, new attempts are refused |
| `period` | `all` counts the whole ledger. `day` counts since local midnight |

The check runs as an attempt gate. A refused task fails with a sentence that
names the numbers, for example `The budget allows 3 attempts. 2 have started
and 2 more would pass the cap.` The gate is registered when the outcomes
module loads. Auto-dispatch also skips a workspace the budget refuses.

```
ceo outcomes budget --attempts 20 --verified 5 --period day
ceo outcomes budget --verified none
ceo outcomes budget
```

## Allocation

Several workspaces compete for the same dispatch slots. Each workspace
gets a weight equal to the inverse of dollars per verified outcome. The
cheaper workspace gets proportionally more slots.

A workspace with no verified outcome yet has no cost to measure. That
workspace takes the median weight of the proven ones. Exploration continues
and an unproven workspace is never starved.

| Workspace | $/verified | Weight | Share |
| --- | --- | --- | --- |
| api | $1.00 | 1.00 | 53% |
| docs | $4.00 | 0.25 | 13% |
| new | none | 0.63 | 33% |

The order of dispatch follows the share, highest first. Slots exist as a
finite number only when `CEO_MAX_RUNNING` is set. The free slots, which are
the cap minus the runs in flight, divide by share. Each workspace with waiting
work gets one slot first while slots remain. Without the cap, the order still
applies and no limit does.

A cost under one cent counts as one cent, so a free run does not take every
slot.

## In the dashboard

The status bar shows `N verified · $X/verified` for the active workspace
once that workspace has any attempts. The segment is dropped with the queue
segment when the line is narrow.

The sidebar adds `$X/v` after the spend of each workspace that has a
verified outcome. The column is the first to go when the sidebar narrows.

## On the command line

```
ceo outcomes          this workspace: overall, by arm, by agent
ceo outcomes --all    every registered workspace, with its allocation share
ceo outcomes budget   print or set the outcome budget
```

The by-arm table groups attempts by provider, model, skills and context. The
by-agent table groups the same attempts by the agent that ran them. Both show
attempts, verified outcomes, dollars and dollars per verified outcome. The
rows of each table sum to the overall spend.
