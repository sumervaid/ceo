# Architecture

How CEO is put together, the rules the code keeps, and what each agent CLI
does on the wire. Read this before changing `src/core/`.

## What CEO is

A terminal dashboard for running teams of headless AI agents across every
repo on a machine. Agents are hired with role briefs, each with a provider
and model. The org gets a mission. Each agent has a permitted level. Work
is queued. The dispatcher hands the work out. The dashboard spawns the agents
directly, as `claude -p`, `codex exec` or `agy -p`. Every task, delegation,
dollar and commit lands in a hash-chained ledger per repo.

One product, one optional companion:

- **`ceo`**: the dashboard. A persistent tmux session named `ceo`. The first
  window of that session is the Ink app. Agents are children of that session.
  The agents therefore survive the terminal closing. Needs node and whichever
  agent CLIs the org hires on. Does not need Claude Code.
- **Claude Code plugin**, optional: slash commands and MCP tools that
  write to the same ledger under the same lock, loaded from
  `~/.claude/skills/ceo`, a symlink to this repo.

Install both from a clone with `./install.sh`. The script symlinks rather
than copies. `pnpm build` is the only step after editing.

## Layout

```
src/core/        no UI, no I/O beyond .ceo/, ~/.ceo/, git, tmux, the agent CLIs
  types.ts       AgentRecord (with provider), Mission, AutonomyLevel, LedgerEntry
  paths.ts       resolves .ceo/ to the GIT ROOT, not cwd
  lock.ts        cross-process file lock for ledger appends
  ledger.ts      append-only, hash-chained, tamper-evident
  roster.ts      hire/fire/reconfigure; a CACHE over the ledger
  mission.ts     org objective + org-wide guardrails
  tasks.ts       the work queue: task_add / task_update, blocked DERIVED
  autonomy.ts    observe|propose|execute|autonomous -> tool allowlists
  providers.ts   claude, codex and gemini: plan the process, parse the
                 stdout, name what the level enforces on each
  compile.ts     config -> the system prompt an agent actually runs
  git.ts         per-agent worktrees, provenance trailers, merge
  delegation.ts  begin/end lifecycle, output archiving
  runner.ts      spawns the provider's CLI as turns, resumes the session for notes,
                 streams to the pane and to .ceo/runs/, writes the ledger
  collab.ts      notes, handoffs, asks, teammates' outputs, live traces
  chat.ts        the chief of staff: defaults, staffing per level, the
                 conversation read back from the ledger, the prompt per message
  companies.ts   ready-made teams: plan with provider fallback and worktree
                 mode, then hire every seat and the chief in one step
  context.ts     the docket: items as context_* ledger events, snapshots in
                 .ceo/context, per-agent resolution for the prompt
  skills.ts      the skill catalogue: Reflex, the CLIs' folders, the repo;
                 approval of waiting workflows through reflex approve
  github.ts      gh as a subprocess: status, issues, threads, pull requests
  huggingface.ts the Hub's HTTP API: cards, papers, token discovery
  alerts.ts      ~/.ceo/alerts.json and the four channels
  pricing.ts     list prices per vendor; every run without a settled
                 figure is costed here and marked
  auth.ts        which account a run bills to, per provider
  setup.ts       readiness per provider: installed, signed in; gates the runner
  history.ts     read-only readers: Reflex's sqlite store, codex rollouts,
                 Claude Code project transcripts (bounded, shallow)
  suggest.ts     a proposed team from Reflex workflows, session history and
                 the repo; deterministic, no model call
  nextstep.ts    "what should I do next", + role templates
  workspaces.ts  ~/.ceo/workspaces.json: the list of repos, nothing else
  tmux.ts        session/window/split helpers; every function degrades

src/bridge.ts    `ceo json` + `ceo op`: the machine interface, for scripts and CI
src/mcp/         MCP server (29 tools) for the companion plugin; collab.ts is
                 the `org` server every run gets (10 tools, nothing that pays),
                 plus 8 staffing and docket tools on the chief of staff's
                 server only
src/tui/         Ink dashboard
  workspaces.ts  per-repo summaries read straight off each ledger file
  runs.ts        live runs keyed by (workspace, agent)
  smooth.ts      rewrites Ink's erase-then-write frames as overwrites in
                 place, so a terminal never paints an erased screen
  chat.ts        the chat transcript as rows of coloured segments, pure
                 LiveBoard.tsx draws the live view from runs, the board and the queue
  components/    Sidebar, Roster, Queue, RunPane, HireForm, TaskForm, Chat, …
src/cli.ts       the `ceo` binary (setup, suggest, task, workspace, json, op, …)
docs/            the wiki: one page per concept, keys, cli, ledger reference
hooks/           the companion plugin's classic shell hooks (jq, read-only)
commands/        16 slash commands (markdown prompts, parse prose not flags)
agents/          ceo-auditor, ceo-postmortem subagent definitions
tools/           stub-claude, stub-codex, stub-gemini, stub-org.mjs (scripted org
                 calls for any stub), keydrive.py, demo/ (one tape per GIF)
```

## Five invariants

1. **The ledger is the authority. `roster.json` is a cache.** Every read
   overlays ledger-derived state: spend, worktrees, budgets, autonomy. If
   the two disagree, the ledger wins. `rebuild()` reconstructs the roster
   by replaying. Tasks have no cache at all: `listTasks()` is a replay.

2. **Never mutate a ledger entry.** Append a correcting one. `verify()`
   checks contiguous seq, `prevHash` linkage, and a hash recomputation over
   canonicalised JSON. Editing any entry mid-file is detected with the exact
   seq.

3. **`append()` holds a file lock.** Required, not belt-and-braces. Two
   unsynchronised writers can each read the same tail, derive the same
   `prevHash`, and fork the chain. Verified with 6 concurrent processes.
   The dashboard and a Claude Code session write to the same org safely
   because of this.

4. **Autonomy is a control applied by the child process, not prompt
   wording.** On claude, `effectiveTools()` becomes `--allowed-tools`. An
   observe agent has no Write tool. On codex, the level becomes `--sandbox
   read-only|workspace-write` with `approval_policy="never"`. An observe
   agent cannot write the filesystem. The compiled prompt also *explains*
   the level to the agent, which is the belt, not the trousers. A permission
   enforced by asking nicely is a bug.

5. **Never record $0 for a run that spent money.** `runner.ts` costs any
   run without a settled figure from the token counts at list prices and
   records `costIsEstimate` + `costBasis` on `delegate_end`. For codex that
   is every run, because codex reports tokens, never dollars. For claude that
   is a run that died before the `result` message. Such a run additionally
   gets a `cost_estimated` note. A ledger that understates spend is worse than
   none, because the ledger is trusted. The dashboard follows suit: sub-cent
   spend renders as `$0.0046`, never `$0.00`, in every column.

Two smaller rules fall out of these. The per-repo `.ceo/` is written
only through core functions that take the lock: the MCP server, the
dashboard's `actions.ts` / `runs.ts`, and `src/bridge.ts`.
`~/.ceo/workspaces.json` holds paths and names only, never a fact the
ledger knows. The registry can therefore never disagree with the ledger.

## Providers

`providers.ts` is the only file that knows a CLI's flags or output. The
facts below were established against each binary.

**codex (0.162.1).** `codex exec --json` emits JSONL: `thread.started`,
`turn.started`, `item.started|updated|completed` with `item.type` in
`command_execution` (`command`, `aggregated_output`, `exit_code`, `status`),
`agent_message` (`text`), `reasoning`, `file_change` (`changes[].path`),
`mcp_tool_call`, `web_search`, `todo_list`, `error`. Then `turn.completed`
with `usage: {input_tokens, cached_input_tokens, output_tokens}`, or
`turn.failed`. There is no dollar figure anywhere. The compiled prompt goes
in as `-c developer_instructions=<TOML string>`. JSON.stringify output is a
valid TOML basic string. The task is passed as `-` and written to stdin.
A task beginning with `-` is therefore never a flag. `--skip-git-repo-check`
lets codex run in a worktree. Approvals must be `never`: no human is at the
keyboard. A sandboxed command comes back as a `command_execution` with output that
contains "denied by sandbox" or the OS's EPERM/EROFS text. That is the
denial signal. The signal is a heuristic. `~/.codex/config.toml` `model` is
read as the codex default. The hire form then offers what codex would use by
default. `CODEX_HOME` moves that file. `codex login status` says "Logged in
using ChatGPT" or "Logged in using an API key". The call is memoised per
process because the call is a subprocess.

**claude.** `claude -p … --output-format stream-json --verbose`: `system`,
`assistant` turns with `message.usage` and `content[]` (`text`,
`tool_use`), then `result` with `total_cost_usd`, `usage`, `result`,
`permission_denials[].tool_name`. The settled figure is authoritative.

**gemini (Antigravity CLI 1.4.7).** Google moved the individual tier from
Gemini CLI to `agy`. Gemini CLI answers a personal login with
IneligibleTierError. `agy -p <prompt> --output-format stream-json` emits
`{"event":"init"}`, `{"event":"step_update","step":{step_id, step_type:
tool|agent_response|user_input|checkpoint, state: ACTIVE|DONE, text_delta,
usage, tool_info:{name, parameters, output, error}}}` and
`{"event":"result","result":{status, response, error, duration_seconds,
num_turns, usage:{input_tokens, output_tokens, thinking_tokens,
cache_read_tokens, total_tokens}}}`. The `result` shape was confirmed
against the binary. The step shape is from the docs. The parser reads
fields from `step` or the top level. `--mode plan` is read-only.
`--mode accept-edits` approves edits and soft-denies commands in headless
mode. `--dangerously-skip-permissions` is never passed. No system-prompt
flag: the brief leads the prompt. Sign-in is interactive only. The token
lives in the keyring. Readiness therefore runs `agy models`. `--sandbox`
only with CEO_GEMINI_SANDBOX.

**All three** read `CEO_CLAUDE_BIN` / `CEO_CODEX_BIN` / `CEO_GEMINI_BIN` as
the binary, which is how the stubs are substituted without touching PATH.

## Setup gate

`src/core/setup.ts` answers three questions per provider. Installed means
`<binary> --version` runs. Signed in means `authStatus().mode !== "unknown"`
for claude. That reads `~/.claude.json` or `CLAUDE_CODE_OAUTH_TOKEN` /
`ANTHROPIC_API_KEY`. For codex, signed in means `codex login status` reports
a login. The third answer is the billing line. The answers are memoised.
`ceo setup <provider>` and the setup screen's `r` reset the answers. There are three
consumers. `ceo setup` is one. The dashboard is the second. The dashboard
opens on the setup screen when no provider is ready. `S` shows the screen any
time. `c`/`x` open a tmux window running the login. The runner is the third.
The runner refuses an unready provider *before* `begin()`. No delegation is
written for a run that could never start. `CEO_SKIP_SETUP_CHECK=1` bypasses
the runner's gate for hosts that sign in some way the check cannot see. The
stubs answer `--version` and `login status`, with
`STUB_CODEX_LOGIN=chatgpt|apikey|none` choosing the codex answer. The specs
export `CLAUDE_CODE_OAUTH_TOKEN` so the claude stub counts as signed in.

## Suggestions and history

`history.ts` reads three places, all read-only. Reflex's `~/.reflex/reflex.db`,
relocatable with `REFLEX_HOME`, is read through `node:sqlite` when the node
build has that module, else the `sqlite3` CLI. Two tables matter.
`suggestions.data_json` holds slug, steps with support, cost with a token mix,
constraints avoid/prefer, repositories and verifiedRate. `traces.trace_json`
holds projectName, projectHash = sha256(cwd)[:12], usageByModel and
outcome.verified. Codex rollouts live under `$CODEX_HOME/sessions`. The
first line's `session_meta.cwd` rejects cheaply. The reader takes `event_msg`
user_message / token_count / thread_settings_applied and `response_item`
calls. Claude Code transcripts live at
`~/.claude/projects/<cwd with / as ->/*.jsonl`, relocatable with
`CLAUDE_CONFIG_DIR`. Usage is counted once per `message.id`. Sidechain and
meta records are skipped. Harness-injected `<…>` messages are not requests.

`suggest.ts` turns that into seats: local Reflex workflows first, then the
standard roles the repo earns. When there are no local workflows, at most two
strong ones from elsewhere are used, labelled. Model/provider come from the
most-used model here unless another model has ≥3 sessions and a ≥20-point
better verified rate. Caps are ~3 runs at the observed cost, never above
`SUGGESTED_CAP_USD`, which is 25. The proposal is deterministic. Every seat
carries evidence lines. `p` in the dashboard,
`ceo suggest [--hire|--json|--everywhere|--days N]` on the command line. The
hire form takes seats as presets: ↑↓ on role, or type the name.

## Collaboration

`src/core/collab.ts` is the surface. `postMessage` writes a `note` of kind
`message`, from an agent or from "you", to an agent or to "*". `handoff`
calls `addTask` with `requestedBy`. `teammateOutputs` returns each
teammate's latest completed output, with the body read from
`.ceo/outputs`. `orgContext` gathers the notes since the agent's last
`delegate_start`, three older notes, and those outputs.
`compileAgentPrompt(agent, mission, context)` renders that context as "From
the org" before the autonomy section. The function adds "Working with the
org" when the tools are on. `src/mcp/collab.ts` is the `org` MCP server,
started as `collab-index.js --agent --root --depth [--delegation]`, ten
tools, nothing that pays. The runner starts the server per run. claude gets
`--mcp-config` with `--strict-mcp-config` and the tool names in the
allowlist. codex gets `-c mcp_servers.org.command` and `.args`. gemini
gets `.agents/mcp_config.json` written into an isolated worktree only.
`CEO_NO_COLLAB` turns the surface off. `collab.spec.ts` covers the server
end to end with the SDK's stdio client.

**Live.** `runner.ts` runs a delegation as turns. After a turn ends,
`pendingNotesFor` reads the notes posted since the last prompt, using a
seq watermark. Those notes become the next prompt through `spec.resumePlan`:
`claude --resume <session_id>`, `codex exec resume <thread_id> … -`, or
`agy --conversation <id>`. The id is captured into
`ParseState.sessionId` from the stream. Two caps apply: `CEO_MAX_TURNS`,
default 6, and the agent's budget. Cost across turns differs by vendor.
claude's `total_cost_usd` is the session's running total. The last turn
wins. codex and gemini usage is summed per turn. `traceAppend` writes
every event to `.ceo/runs/<id>.jsonl`, `meta` first and `end` last.
`liveRuns` and `traceFor` read those files. `org_running`,
`org_trace`, `ceo runs` and `ceo trace` show the traces. `org_ask` posts a
note with an `askId`. When the teammate is live, `org_ask` waits for
`replyTo`. When not, `org_ask` starts a child `runDelegation` with
`parentDelegationId` and `depth: 1`. A depth-1 server refuses `org_ask`.
One assumption waits for a real run: that each CLI's resume keeps the first
turn's system prompt and MCP servers. codex needs the mcp `-c` overrides
restated. `resumePlan` restates those overrides.

## The chat

`core/chat.ts` owns the chief of staff. The chief is an ordinary agent
with `chief: true` on the hire event, at most one per org. `ensureChief`
hires one with the defaults on the first `C`. The runner starts the
chief's process at `observe` whatever the chief's level, through
`processLevelFor`. The level instead selects a `StaffingPolicy`, which
`compile.ts` renders as the chief's "What you may do" section. The org
server enforces the same policy on each call to `org_hire`,
`org_delegate`, `org_fire` and `org_handoff`, reading the level from the
roster at call time.

A message is `runDelegation(chief, message, { via: "chat", prompt,
resumeSessionId })`. The ledger records the message as the task. The
process receives `chatPrompt`: the message, a "Since your last reply"
digest of finished runs and notes, and a recap when the session cannot
resume. A session resumes only when the last reply ended `done` on the
provider the chief runs on now. `conversation()` rebuilds the exchange
from the chief's runs since the last `chat_new` note, with each hire,
task, fire and note the chief wrote attached to the run open at the time.

`App.tsx` starts delegated work. When a reply ends, `afterChiefReply`
starts every task from `startableAfter`. When any run settles,
`startChiefWork` starts queued `autoStart` tasks whose assignee is idle,
unless the chief is mid-reply. The chat view keeps the draft in a ref with
one input handler. A controlled field would send a message a render
behind the keystrokes, which a fast typist or a pasted line hits.

`tools/stub-claude` plays a chief from a `STUB_CHAT` script. The stub
starts the real org server from `--mcp-config` and calls the tools over
stdio, so `chat.spec.ts` and `docs/chat.gif` exercise the real path.

Money in the chat: `budgetCheck` returns null for the chief, and the
runner's follow-up check skips the chief, so the chief's replies are never
capped. The chief's `budgetUsd` is the allowance. `allowanceOf` replays the
ledger: per agent a base, the budget the operator gave, and a current
budget. The chief's share is current above base. `hire` and `budget_set`
carry `by`. A task's `provider` overrides the assignee's provider for that
run inside `runDelegation`, recorded on `delegate_start` with
`usualProvider`.

## The queue

A task is a ledger object, written as `task_add` and `task_update`. Stored status is
queued / running / done / failed / cancelled. **`blocked` is derived at read
time**: unassigned, assignee not in the org, assignee at the cap. A
budget raise therefore unblocks every task due to unblock, without touching
any task.

A task links to the run by `delegationId`. Cost is *joined* from
`delegate_end`, never copied onto the task. `runDelegation({taskId})` moves
the task to running on begin and to done/failed/cancelled on settle. The
MCP `ceo_delegate_begin`/`_end` and `ceo op delegate_begin`/`_end` do the
same when given `taskId`.

The dispatcher lives in `App.tsx`. `R` runs one pass over the active
workspace. `A` turns on a 1.5s loop over **every registered workspace**,
starting the first queued task for each idle agent. Auto is off by default
and shown inverse-yellow in the status bar when on, because auto-dispatch
spends money without a keystroke per dollar.

## Billing

CEO holds no model credentials. CEO shells out to `claude`, `codex` and
`agy`. Runs bill exactly as those CLIs bill: normally a Claude
subscription, a ChatGPT plan and a Google account. `ceo billing` reports
each and warns when `ANTHROPIC_API_KEY` or an API-key codex login would
redirect a provider to a metered account.
The hire form shows the chosen provider's line before the hire.

**Testing costs real money.** Point `CEO_CLAUDE_BIN` at `tools/stub-claude`
and `CEO_CODEX_BIN` at `tools/stub-codex`. The claude stub emits `system`, N
`assistant` turns and a `result` with `total_cost_usd`. The codex stub emits
the exec JSONL above and refuses to start unless `exec --json --sandbox`
and `-c approval_policy="never"` are present. A regression in the plan
fails loudly. Both honour `STUB_NO_RESULT`, `STUB_DENY`, `STUB_EXIT`,
`STUB_TURNS`, `STUB_DELAY_MS`. `src/core/runner.spec.ts` runs both end to
end through a real ledger, for $0.00.

**Testing the TUI.** Drive the TUI under a real pty with `tools/keydrive.py`, a
harness that drains output *continuously* while sending keys. A harness that
does not drain starves the event loop and produces coalesced input that looks
like a tab bug. The harness treats Ink's full-screen clear, `ESC[2J`, as a
frame boundary. Set `CEO_HOME` and `CODEX_HOME` to throwaway directories so
the real registry and the real codex config are never touched. Never run
`ceo open` from a test outside tmux on macOS: the command's last-resort
fallback opens a real Terminal window. Never test against a repo with a real
`.ceo`.

## Open question: governance tools for agents

An agent hired to "manage the budget of other agents" got five denials on
the `ceo_*` MCP tools. Four were read-only: `ceo_status`, `ceo_roster`,
`ceo_rollup`, `ceo_ledger_tail`. One was `ceo_delegate_end`, which must
stay blocked at every level, because an agent with write access to the cost
record can understate the cost. The likely fix is a per-agent opt-in for the
read-only subset only. `ceo_task_update` belongs on the blocked side too.

## Known limits

- The gemini step event shape follows the published docs. The parser is
  lenient about nesting, so a change in shape degrades to fewer live
  events rather than a failed run.
- Codex denial detection is textual, as described under Providers. A sandbox refusal
  with output not matching the pattern completes as an ordinary failed
  command. The sandbox still held. Only the red line is missed.
- Codex collapses `observe` and `propose` to the same read-only sandbox.
  The difference between the two on codex is prompt wording only.
- Codex cost is always a list-price estimate with cached input at a tenth.
  On a ChatGPT plan the real marginal cost is $0. The ledger records what
  the tokens would have cost, which is the figure budgets gate on.
- Unknown `gpt-*` models, such as `gpt-6-astra`, are priced at gpt-5
  rates until `pricing.ts` learns those models.
- Audits still require Claude Code, through `/audit`. The dashboard cannot spawn
  the auditor subagent. Could be ported to `runner.ts` as a claude run.
- A run started by one dashboard is invisible to a second dashboard on the
  same org except as a "running" task or a dangling start.
- `recentTerms` is a stopword-filtered word count over first requests. The
  count is a hint in a brief, not an analysis. Reflex's intent terms are
  better when present.

## Roadmap

1. **The auditor as a run.** Port the auditor to `runner.ts` as a run at
   observe. Audits then work without Claude Code and queue like any task.
2. **Read-only governance opt-in** for agents, as described above.
3. **Codex network access** as a hire option,
   `sandbox_workspace_write.network_access=true`, recorded in the
   enforcement list.
4. **Task dependencies**: `after: <id>`. The dispatcher holds a task until
   the predecessor is done.
5. **Interactive attach**: a key that opens the agent's CLI interactively in
   the agent's worktree with the compiled prompt, in a tmux window, with a
   ledger note that the session's cost is unmetered.
