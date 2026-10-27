---
description: Delegate a task to one agent in the org, ledgered start to finish.
argument-hint: '<agent> <task text...>'
---

Arguments: $ARGUMENTS. The first bare token is the agent. The rest is the task.

Run all five steps. Never skip step 5, even if the agent fails.

1. Call `ceo_roster` to confirm the agent exists and read its model. If it
   is not listed, say so in one line and stop.
2. Call `ceo_compiled_prompt` for the agent to get the prompt it runs
   under, and `ceo_effective_tools` to get its allowlist. Use both exactly
   as returned. Do not edit the prompt, append to it, or add a tool the
   allowlist omits. The allowlist is what makes the agent's autonomy level
   a boundary at runtime rather than a suggestion in prose.
3. Call `ceo_delegate_begin` with `agent` and `task`. It runs the budget
   gate. If it refuses, print the refusal verbatim and stop, spawning
   nothing. Keep the handle JSON from its last line. Note the wall-clock
   start time. When this delegation is running a queue task from `/task
   run`, pass its `taskId` here and again in step 5, so the queue moves
   with the run.
4. Spawn the agent with the Agent tool. Prompt = the compiled prompt
   verbatim as a preamble, a blank line, then the task text. Restrict the
   spawn to the tools `ceo_effective_tools` returned. Use the agent's
   configured model if the Agent tool takes a model parameter. If it does
   not, say so in one line afterwards rather than silently using another
   model.
5. Call `ceo_delegate_end` with the saved `handle`, the subagent's full
   output as `output`, its real `inputTokens`/`outputTokens`/`costUsd` from
   the usage the Agent tool reports, and measured `durationMs`. If the
   runtime does not surface usage, estimate from the transcript and pass
   the estimate. Then call `ceo_note` recording that this delegation's cost
   was estimated.

If the Agent tool cannot be restricted to a tool list in this runtime, stop
before spawning and say so. An agent at `observe` or `propose` spawned with
full tools is not the agent that was configured, and the ledger would
record work that was never permitted.

If `ceo_compiled_prompt` reports the prompt as overridden, spawn it anyway.
It is the configured prompt. Note in one line afterwards that this agent
runs a hand-written prompt, so the mission and the org guardrails were not
in what it read. `/prompt <agent>` shows the whole thing.

Print the agent's output, then the `ceo_delegate_end` line verbatim: id,
cost, time, output path, any commit, any budget warning. Nothing else.
