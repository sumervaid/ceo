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
| `mission_set` | `M`, `/mission` | `objective, successCriteria, orgGuardrails` |
| `guardrail_set` | `/guardrail` | the org guardrail added |
| `task_add` | `t`, `d`, `ceo task add`, an agent's `org_handoff` | `id, title, assignee, priority, requestedBy` |
| `task_update` | runs, `e`, `x`, `u`, `ceo task <id> …` | `id` plus the changed fields (`status, assignee, priority, title, delegationId, note`) |
| `delegate_start` | the runner, before spawning | `id, task, provider, model, enforcement, workdir`; `parent, depth` when an `org_ask` started the run |
| `delegate_end` | the runner, when the last turn settles | `id, startSeq, outputPath, inputTokens, outputTokens, costUsd, costIsEstimate, costBasis, turns, durationMs, outputChars` |
| `worktree_provision` | hiring an isolated agent | `branch, worktreePath` |
| `worktree_commit` | an isolated agent's run that changed files | `sha, files, message, ledgerSeq, costUsd` |
| `worktree_merge` | `m` | `branch, sha, ok` or `branch, ok: false, conflicts, error` |
| `audit` | the CEO-Auditor | `reportPath, findingCount, categories, windowStartSeq, windowEndSeq` |
| `postmortem` | the CEO-Postmortem | `reportPath` and a summary |
| `context_add` | `n` on the docket, `ceo docket add`, the chief's `org_context` | `id, kind, title, source, snapshot, chars, by` |
| `context_update` | `r` on the docket, `ceo docket refresh` | `id, title, chars` |
| `context_remove` | `x` on the docket, `ceo docket rm` | `id` |
| `context_assign` | `space` on the docket, `ceo docket give`, the chief's `org_give` | `id`, plus `by` when the chief gave the item |
| `context_unassign` | `space` on the docket, `ceo docket take`, the chief's `org_give` | `id`, plus `by` when the chief took the item back |
| `note` | the runner, `/note` | `kind` plus fields; kinds below |

### Note kinds

| `kind` | When | Fields |
| --- | --- | --- |
| `permission_denied` | an agent reached past the permitted level | `provider, tools, autonomy, delegationId, detail` |
| `cost_estimated` | a claude run ended before reporting a settled cost | `delegationId, costUsd, inputTokens, outputTokens, model, detail` |
| `message` | an agent's `org_post` or `org_ask`, or `ceo post` | `from, to, text, delegationId`; `askId` on a question, `inReplyTo` on the answer |
| (none) | `/note` free text | `text` |

Codex and gemini runs are always estimates. Each carries that fact on the
`delegate_end` entry, in `costBasis`. Those runs therefore get no note each. The note is for
the exceptional case: a provider that should have settled and did not.

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
