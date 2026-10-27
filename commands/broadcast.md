---
description: Send the same task to every agent in the org, in parallel.
argument-hint: '<task text...>'
---

Task: $ARGUMENTS

1. Call `ceo_roster`. Collect every agent's name, model, and role brief. If
   the org is empty, say so in one line and stop.
2. Call `ceo_delegate_begin` once per agent. Any agent the budget gate
   refuses is dropped from this broadcast. Keep its refusal line for the
   report and spawn nothing for it. Save each handle JSON.
3. Spawn every remaining agent with the Agent tool **in a single block so they
   run in parallel**. Each prompt = that agent's role brief verbatim, a blank
   line, then the task text. Use each agent's configured model.
4. As results come back, call `ceo_delegate_end` once per agent with its own
   saved handle, its output, and its real token counts, cost, and duration. Do
   this for every agent that was begun, including ones that errored. An
   unclosed delegation dangles in the ledger. For a failed agent, pass the
   error text as `output` and the cost actually incurred.

Report one line per agent as `name · cost · time · one-clause summary`. Then
print the refusal lines for any agent that was skipped. Then print the total
from `ceo_rollup` with `sinceHours: 1`. Full outputs only if asked. They are
archived under `.ceo/outputs/`.
