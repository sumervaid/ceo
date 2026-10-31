# The ledger

`.ceo/ledger.jsonl`: one JSON object per line, append-only, hash-chained.
The authority for everything CEO reports. `roster.json` is a cache of the
ledger. Tasks have no cache at all.

## An entry

```json
{"seq":12,"ts":1760650000000,"type":"delegate_end","agent":"coder",
 "data":{"id":"3f9a1c","startSeq":11,"outputPath":".ceo/outputs/3f9a1c.md",
         "inputTokens":3000,"outputTokens":150,"costUsd":0.0046,
         "costIsEstimate":true,"costBasis":"openai-list-price",
         "durationMs":2400,"outputChars":812},
 "prevHash":"9c1e…","hash":"4b77…"}
```

| Field | Meaning |
| --- | --- |
| `seq` | Contiguous from 0 (`org_init`). |
| `ts` | Milliseconds since the epoch. |
| `type` | One of the event types below. |
| `agent` | The agent concerned, or `null`. |
| `data` | The payload. Shape depends on `type`. |
| `prevHash` | The previous entry's `hash`. Genesis uses 64 zeroes. |
| `hash` | sha256 over the canonical JSON of the other fields. |

## Event types

| Type | Written by | `data` |
| --- | --- | --- |
| `org_init` | `n`, `ceo op init` | `{}` |
| `hire` | hire | `role, provider, model, tools, budgetUsd, isolated, systemPrompt, guardrails, collaboration, autonomy` |
| `fire` | fire | `reason` |
| `agent_config` | reconfigure | the changed fields only |
| `autonomy_set` | `y`, `/autonomy` | `autonomy, previous` |
| `budget_set` | `b`, `/budget` | `budgetUsd, previousUsd` |
| `mission_set` | `M`, `/mission`, `ceo mission checks add` | `objective, successCriteria, orgGuardrails, checks, previousObjective` |
| `guardrail_set` | `/guardrail` | the org guardrail added |
| `task_add` | `t`, `d`, `ceo task add`, an agent's `org_handoff`, the chief's `org_delegate` | `id, title, assignee, priority, requestedBy`; `autoStart, provider, verifiers, samples, arms, kind, sandbox` when set |
| `task_update` | runs, attempts, `e`, `x`, `u`, `ceo task <id> …` | `id` plus the changed fields (`status, assignee, priority, title, delegationId, note, verifiers, samples, arms, kind`) |
| `delegate_start` | the runner, before spawning | `id, task, provider, model, enforcement, workdir`; `parent, depth` when an `org_ask` started the run; `taskId` for a task's run; `attemptId, arm` for an attempt; `sandbox` when a container or a host runs the process |
| `delegate_end` | the runner, when the last turn settles | `id, startSeq, outputPath, inputTokens, outputTokens, costUsd, costIsEstimate, costBasis, turns, durationMs, outputChars` |
| `worktree_provision` | hiring an isolated agent | `branch, worktreePath` |
| `worktree_commit` | an isolated agent's run that changed files | `sha, files, message, ledgerSeq, costUsd` |
| `worktree_merge` | `m`, an approved merge, an automatic merge | `branch, sha, ok` or `branch, ok: false, conflicts, error` |
| `audit` | the CEO-Auditor | `reportPath, findingCount, categories, windowStartSeq, windowEndSeq` |
| `postmortem` | the CEO-Postmortem | `reportPath` and a summary |
| `context_add` | `n` on the docket, `ceo docket add`, the chief's `org_context` | `id, kind, title, source, snapshot, chars, by` |
| `context_update` | `r` on the docket, `ceo docket refresh` | `id, title, chars` |
| `context_remove` | `x` on the docket, `ceo docket rm` | `id` |
| `context_assign` | `space` on the docket, `ceo docket give`, the chief's `org_give` | `id`, plus `by` when the chief gave the item |
| `context_unassign` | `space` on the docket, `ceo docket take`, the chief's `org_give` | `id`, plus `by` when the chief took the item back |
| `attempt_start` | the attempt runner, before each attempt's run | `taskId, attemptId, agent, arm, mode, why, branch, worktree, base, kind` |
| `attempt_end` | the attempt runner, when an attempt's run settles | `taskId, attemptId, delegationId, outcome, costUsd`; `error` when the run did not finish |
| `verify` | a check, run by an attempt, `ceo verify` or `ceo mission check` | `scope, taskId, attemptId, delegationId, verifier, status, score, detail, evidence`; `costUsd` when the check called a model |
| `promote` | the attempt runner, for the winning attempt | `taskId, attemptId, branch, arm, score, costUsd, attempts, dissent` |
| `approval_request` | the merge gate, for an action that needs a person | `id, action, taskId, attemptId, branch, summary, evidence` |
| `approval_decide` | `V`, `ceo approvals approve` and `deny` | `id, decision, by`; `result` on an approval |
| `note` | the runner, `/note` | `kind` plus fields; kinds below |

### Note kinds

| `kind` | When | Fields |
| --- | --- | --- |
| `permission_denied` | an agent reached past the permitted level | `provider, tools, autonomy, delegationId, detail` |
| `cost_estimated` | a claude run ended before reporting a settled cost | `delegationId, costUsd, inputTokens, outputTokens, model, detail` |
| `message` | an agent's `org_post` or `org_ask`, or `ceo post` | `from, to, text, delegationId`; `askId` on a question, `inReplyTo` on the answer |
| `gates` | `ceo approvals auto-merge on` or `off` | `autoMerge, by` |
| `auto_merge` | a merge that cleared the evidence rule and landed alone | `taskId, attemptId, branch, sha, reason, evidence` |
| `outcome_budget` | `ceo outcomes budget` | `attempts, verified, period` |
| `promote_hook_failed` | a hook after a promotion raised an error | `taskId, detail` |
| (none) | `/note` free text | `text` |

Codex and gemini runs are always estimates. Each carries that fact on the
`delegate_end` entry, in `costBasis`. Those runs therefore get no note each. The note is for
the exceptional case: a provider that should have settled and did not.

### Evidence events

A task that runs as attempts leaves a trail. See [the queue](queue.md) and
[verification](verification.md).

| Event | Field | Values |
| --- | --- | --- |
| `attempt_start` | `arm` | `{provider, model}`, with `skills` and `context` when the arm carries any |
| | `mode` | `named` when the task named the arm. `pick` for the router's best draw. `explore` for an arm tried to learn or to diversify. |
| | `why` | The reason the router gave for the arm |
| | `base` | The commit the attempt started from, for diffs. Null outside a git repository. |
| `attempt_end` | `outcome` | `done`, `failed`, `cancelled` or `rate_limited` |
| `verify` | `scope` | `task` for an attempt or a single `ceo verify`. `mission` for a mission check. |
| | `verifier` | `{kind, name, required, weight}`. The kind is `command`, `everval` or `judge`. |
| | `status` | `pass`, `fail` or `error`. An error means the check could not run. |
| | `score` | 0 to 1, or null when the check gives no score |
| | `evidence` | What the verdict rests on: an exit code, an Everval experiment id, each judge's vote |
| `promote` | `attempts` | How many attempts reached the decision |
| | `dissent` | The best attempt from another arm, as `{attemptId, branch, arm, pass, score}`, or null |
| `approval_request` | `action` | `merge`, `push`, `pr`, `publish`, `send` or `pay` |
| | `evidence` | The verdict, each check's status and each judge's vote at the time of the request |
| `approval_decide` | `decision` | `approved` or `denied` |
| | `by` | `you` |
| | `result` | For an approval: whether CEO executed the action, the merge sha, the conflicts or the error |

A request with no decision is pending. Pending requests are read by replay,
as tasks are.

## The chain

`verify()` walks the file and checks three things: `seq` is contiguous,
each `prevHash` equals the previous `hash`, and each `hash` recomputes from
the entry's canonical JSON with recursively sorted keys. The check stops at
the first failure and names the seq. The dashboard puts a red banner over
everything until the chain verifies again. `ceo snapshot` leads with the
chain status.

The chain detects an edited, deleted or reordered entry. The chain does not
stop a person with write access from rewriting the whole file. That is why
the ledger belongs in git: commit `.ceo/ledger.jsonl`, `.ceo/roster.json`,
`.ceo/audits/` and `.ceo/context/`. Gitignore `.ceo/worktrees/`,
`.ceo/outputs/`, `.ceo/runs/` and `.ceo/chief/`.

## Two rules

**Never mutate an entry.** Append a correcting one. A `note` with what was
wrong and a new entry with what is right leaves the history legible.

**Every write takes the lock.** `append()` holds a file lock for the read of
the tail, the hash, and the write. Two unsynchronised writers could each
read the same tail, derive the same `prevHash`, and fork the chain. The
dashboard, the runner, `ceo op` and the MCP server all write through
`append()`, which is why the four can share an org safely.

## Reading the ledger

```sh
ceo snapshot                     # the org as text, chain status first
tail -5 .ceo/ledger.jsonl | jq
ceo json | jq .verify            # {"ok":true,"brokenAtSeq":null,"reason":null}
jq -r 'select(.type=="delegate_end") | [.agent, .data.costUsd, .data.costBasis] | @tsv' .ceo/ledger.jsonl
```

Rebuilding the roster from the ledger is `readRoster()` with the cache
deleted. The rebuild happens automatically when `roster.json` is missing or
unreadable.
