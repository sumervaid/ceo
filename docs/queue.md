# The queue

<p align="center">
  <img src="queue.gif" alt="A delegation streams and settles with the cost, two more tasks are queued, and auto-dispatch runs both" width="860">
</p>

A task is a unit of work that exists before any run and survives a run that
failed. A task is a ledger object, not a file: `task_add` creates the task.
`task_update` changes the task. `listTasks()` replays both.

## States

A queued task becomes running on `enter`, `R` or `A`. A running task becomes
done, failed or cancelled. `u` requeues a settled task.

Stored status is one of `queued`, `running`, `done`, `failed`, `cancelled`.
**`blocked` is derived, never stored.** A task shows as blocked when the task
is unassigned, when the assignee is not in the org, or when the assignee is
at the budget cap. Raising the budget, hiring the agent or assigning the task
unblocks the task. The task record is untouched. The reason is shown beside
the task.

## Linking to the run

When a task runs, `delegate_start` is written. The task moves to `running`
with that delegation's id. When the run settles, the task moves to `done`,
`failed` or `cancelled`. The cost is read from the `delegate_end` entry
whenever the queue is drawn. The cost is never copied onto the task. The
queue and the ledger therefore cannot disagree about what a piece of work
cost.

## Priority

`!` high, normal, `.` low, on the command line. The form has a field. The
dispatcher takes the highest priority first, oldest first within a priority.

## The dispatcher

`R` runs one pass over the active workspace: every agent with no run in
flight picks up the first queued task. One run per agent at a time. A second
start for the same agent is refused.

`A` turns on a loop, every 1.5 seconds, across every registered workspace.
Auto-dispatch is off by default and shown in inverse yellow in the status bar
when on, because auto-dispatch is the one mode in which money moves without a
keystroke per dollar. Budgets still gate every start. The most auto-dispatch
can spend is the sum of the caps.

## From the command line

```sh
ceo task add coder ! add the changelog     # high priority, assigned to coder
ceo task add - write the release notes     # unassigned: blocked until assigned
ceo task ls
ceo task 82b413 assign reader
ceo task 82b413 done | cancel | queue
```

## Why a ledger object

Because a queue that lives in a JSON file beside the ledger is a second
source of truth. The two drift. A task in the ledger has a seq, a hash
and a history: the agent or person that queued the task, when the task was
reassigned, which run did the task, what that run cost. The auditor can read
the queue with the same tools the auditor uses for the rest of the ledger.
