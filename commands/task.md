---
description: Add, list, assign, run, or settle tasks in the org's work queue.
argument-hint: 'nothing (list) · add [agent] <title> · assign <id> <agent> · run <id> · done|cancel|requeue <id>'
---

Arguments: $ARGUMENTS

The queue is the org's work list, kept in the ledger as `task_add` and
`task_update` events. A task is the thing you wanted done. A delegation is
one attempt at it. The two are linked by the delegation id, so a task's cost
is read from its `delegate_end` entry rather than copied.

Parse the first bare word of the arguments as the verb. With no arguments,
the verb is `list`.

**list**: call `ceo_tasks` and print its output verbatim in a fenced code
block. Nothing else. If it says the queue is empty, add one line: `/task add
<agent> <title>`.

**add**: the next word is the assignee if it names an agent in `ceo_roster`.
Otherwise the task is unassigned and everything after `add` is the title.
A leading `!` on the title means high priority. A leading `.` means low.
Call `ceo_task_add` with `title`, `assignee` and `priority`. Omit `assignee`
when unassigned. Print its one-line result. An unassigned task is blocked
until someone owns it. Say so only if the tool did not already.

**assign**: `ceo_task_update` with `id` and `assignee`.

**run**: the task must be queued. Fetch it from `ceo_tasks`. If it is
blocked, print the reason verbatim and stop. Otherwise run the `/delegate`
procedure for its assignee with the task title as the task text. Pass
`taskId` to both `ceo_delegate_begin` and `ceo_delegate_end`, so the queue
moves to running and then to done or failed on its own. Do not call
`ceo_task_update` for status yourself in this path.

**done / cancel / requeue**: `ceo_task_update` with `id` and `status` set to
`done`, `cancelled`, or `queued`. The tool refuses some moves, such as a
cancelled task becoming done. Print refusals verbatim.

Print tool output as returned. No headings, no preamble. The dashboard,
started with `ceo`, shows the same queue live. It can dispatch the queue
with `R` or run it unattended with `A`.
