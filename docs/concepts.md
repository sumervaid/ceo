# Concepts

Eleven words, each with one meaning.

**Org.** Everything CEO knows about one directory: the directory's agents,
mission, tasks and ledger, all under `.ceo/`. One org per directory, or per
repo root when there is one. The dashboard shows one org at a time and lists
the others in the sidebar.

**Agent.** A named seat with a role brief, a provider, a model, a budget and
an autonomy level. An agent is not a process. An agent exists in the roster
between runs. Each run is a fresh process started with the agent's
compiled prompt and permissions. The process is `claude -p`, `codex exec`
or `agy -p`. Hiring writes a `hire` event. Firing writes `fire`. The
roster file is a cache of those events.

**Provider.** Which headless CLI runs the agent: `claude`, `codex` or
`gemini`. The gemini provider runs the Antigravity CLI, `agy`. The
provider decides how autonomy is enforced and how cost is reported. See
[Providers](providers.md).

**Autonomy.** What the agent may do without a human: `observe`, `propose`,
`execute`, `autonomous`. A level is a control applied by the child process,
never prompt wording alone. Claude gets a tool allowlist. Codex gets a
sandbox. Gemini gets a permission mode.
See [Autonomy](autonomy.md).

**Delegation.** One run of one agent on one task. `delegate_start` is written
before the process spawns, `delegate_end` when the run settles, with cost. A start
without an end is a dangling delegation: the run was cut off. The auditor
looks for exactly that.

**Task.** A unit of queued work: title, assignee, priority. A task exists
before any run and survives a run that failed. A task links to the
delegation by id. The task takes the cost from the ledger, never a copy. See
[The queue](queue.md).

**Workspace.** A directory registered in `~/.ceo/workspaces.json` so the
dashboard can show the directory in the sidebar. The registry holds paths and names
only. Everything else is in each org's own ledger.

**Ledger.** `.ceo/ledger.jsonl`: an append-only, hash-chained record of every
event in the org. The authority for spend, budgets, permissions and
provenance. See [The ledger](ledger.md).

**Turn.** One process of a delegation. The first turn is the task. A
follow-up turn resumes the same CLI session with the notes teammates
posted since. A delegation closes once, with every turn's cost.

**Note.** A short message from an agent or from the person at the keyboard,
to one agent or to the whole org, kept in the ledger. Notes reach a running agent
at the next turn. Notes reach an idle agent at the start of the agent's next
run. A note with an ask id is a question that waits for the answer.

**Trace.** `.ceo/runs/<id>.jsonl`: every event of a run as each event happens.
What `org_running`, `org_trace`, `ceo runs` and `ceo trace` read. See
[Collaboration](collaboration.md).

## How the pieces fit

```
workspace ─┬─ org (.ceo/)
           │    ├─ mission            what the org is for; shown to every agent
           │    ├─ agents             role · provider · model · budget · autonomy
           │    ├─ tasks              queued, then running, then done | failed | cancelled
           │    ├─ ledger.jsonl       every event, hash-chained: runs, notes, handoffs
           │    └─ runs/<id>.jsonl    live traces
           │
           └─ runs (process state)    one CLI session per delegation, resumed per turn
```

A run reads the org, meaning the compiled prompt, permissions and budget gate.
The run writes the ledger: start, end, notes. The dashboard reads both. The
dashboard writes only through the same core functions, under the same lock,
that the runner uses.
