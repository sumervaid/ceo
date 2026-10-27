# Changelog

## 0.4.0 (2026-10-27)

Claude, Codex and Gemini agents on one team, working with each other
through the org. Notes, live traces, questions and handoffs cross the
provider line. One ledger records every exchange with the model behind
each one.

### Added
- **Gemini agents**, through the Antigravity CLI. An agent hired on
  `gemini` runs as `agy -p --output-format stream-json`. Below `execute`
  the mode is `plan`. At `execute` and above the mode is `accept-edits`. A
  tool the CLI will not approve in headless mode is a denial. Tokens are
  costed at list price and marked as estimates. `ceo setup` and the hire
  form name the account a gemini run bills. `tools/stub-gemini` covers
  gemini for $0.
- **Switch an agent's provider.** `v` on the roster, `ceo agent <name>
  provider <p>` and the `reconfigure` op move an agent between claude,
  codex and gemini. The brief, budget, level, branch and history stay. The
  model becomes the new provider's default unless the current model
  already fits. A role is never bound to a vendor.
- **The collaboration surface.** Every run gets a "From the org" prompt
  section. The section holds notes addressed to the agent and the latest
  outputs of teammates. Every run also gets an `org` MCP server scoped to
  the agent, with ten tools: `org_roster`, `org_mission`, `org_outputs`,
  `org_read_output`, `org_board`, `org_post`, `org_handoff`,
  `org_running`, `org_trace` and `org_ask`. Notes are ledger notes of kind
  `message`. Handoffs are tasks with `requestedBy`. No tool an agent can
  call changes a budget, a level or a cost. `ceo board`, `ceo post`.
- **Live collaboration.** A run is a sequence of turns on one CLI session.
  A note posted while an agent works arrives as a follow-up turn through
  `claude --resume`, `codex exec resume` or `agy --conversation`. Every
  run streams events to `.ceo/runs/<id>.jsonl`. `org_running` and
  `org_trace` read those traces live. `org_ask` puts a question to a
  teammate and waits for the answer. An idle teammate gets a run one level
  deep, with the parent recorded. `ceo runs`, `ceo trace`. `delegate_end`
  records `turns`.
- **The live view.** `L` shows a column per provider. Each agent gets a
  card with the task, the turn, the last tool and the last line. An
  exchanges strip lists every note, question, answer and handoff between
  agents in provider colours.
- **Chat with the chief of staff.** `C` on the dashboard, or `ceo chat`,
  opens a conversation with the org's chief of staff. The first visit hires
  the chief. Each message is a run of the chief, resumed on the same CLI
  session. The chief's replies have no cap. The chief's budget field is an
  allowance, $25 by default, which the chief gives to other agents.
  The chief's own process is read-only on every provider. The chief's
  level decides what the chief may do to the org: answer, queue, hire and
  start, or also fire. Hires come at most three per reply, at `execute` or
  below. `ctrl-p` moves the chief to another provider. The next message
  then carries a recap. The transcript draws every hire and delegation
  from the ledger with a live status.
- **Eight tools only the chief holds.** `org_providers`, `org_hire`,
  `org_budget`, `org_delegate` and `org_fire` staff the org. `org_docket`,
  `org_context` and `org_give` work the docket. The org server checks the
  chief's level, the allowance and the per-reply limit on every call.
- **Named providers.** A request to the chief can say which provider does
  which part. `org_delegate` records the provider on the task. The run
  uses that provider. The agent keeps the usual setting for the next task.
  The chat, the queue and the live view show where each task runs.
- **Companies.** A whole team in one keystroke. `n` on a new directory
  creates the org and opens the company picker. `+` opens the picker any
  time. `ceo company <id>` hires from the terminal. Six companies ship:
  software team, bug squad, review desk, docs studio, research lab and full
  company. Each mixes providers and comes with a chief of staff. A seat on
  a provider that is not ready moves to a ready one. The picker says so.
- **Worktrees on demand.** `w` in the company picker gives a worktree to
  every writer, to every agent or to nobody. `i` on the roster gives any
  agent a worktree and a branch later. Both say why when git cannot: no
  repository, or no first commit.
- **The docket.** `D` opens a grid of every piece of context in the org
  against every agent. Items are files, folders, GitHub issues and pull
  requests, Hugging Face models, datasets, Spaces and papers, web pages,
  skills and notes. One input line detects the kind. Each run's prompt
  carries the agent's items in "Context from the docket" and the agent's
  skills in "Your skills". Files are read fresh from the agent's branch.
  Everything else is snapshotted in `.ceo/context/`. `ceo docket`, `ceo
  skills`.
- **Skills from Reflex.** The catalogue reads `~/.reflex/skills`, the skill
  folders of Claude Code, Codex and Cursor, and the repo's own. Picking a
  waiting Reflex workflow approves the workflow through `reflex approve`.
- **GitHub.** Through `gh`, with `ceo setup github` for the login. Issues
  become context, tasks or a message to the chief. `P` and `ceo pr` push an
  agent's branch and open a pull request. The body is the ledger's account
  of each run.
- **Hugging Face.** Public cards and papers need no setup. Private repos
  use the Hub's own token. `ceo hf`.
- **Alerts.** Failed runs, budget refusals, denials, the chief's replies,
  an empty queue and, optionally, finished runs. Channels are the bell, the
  desktop, Slack and any webhook. `I` and `ceo alerts` set them. `ceo
  alerts test` reports each channel.
- **Integrations screen.** `I` shows GitHub, Hugging Face, alerts and Reflex
  on one page, with the keys for each.
- **A GIF for every feature.** The README opens on `hero.gif`. Nine more
  show one feature each: `company.gif`, `chat.gif`, `live.gif`,
  `collab.gif`, `docket.gif`, `integrations.gif`, `suggest.gif`,
  `queue.gif` and `setup.gif`. `pnpm demo:all` records every GIF against a
  $0 fixture. `tools/stub-org.mjs` lets each stub post notes through the
  real org server from a `STUB_SCRIPT`.
- **`ceo --version`.**
- **New ledger fields.** `hire` gains `chief` and `by`. `fire` and
  `budget_set` gain `by`. `task_add` gains `autoStart` and `provider`.
  `delegate_start` gains `via`, `resumed` and `context`. `delegate_end`
  gains `sessionId` and `outcome`. The docket adds `context_add`,
  `context_update`, `context_remove`, `context_assign` and
  `context_unassign`.

### Fixed
- **No more flicker.** Ink cleared the whole terminal before every
  full-height frame. Every screen is now drawn one row short of the
  terminal. Ink also erased each frame before writing the next.
  `src/tui/smooth.ts` rewrites each frame as an overwrite in place, inside
  synchronized output.
- Hiring six seats blocked the dashboard for ten seconds. The project root
  is now remembered per directory.
- After hiring one suggested seat, `p` offered the seat again. Seats
  already in the org now leave the proposal.
- The queue cursor follows the task, not the row, when a run settles and the
  list reorders.
- Indented file lists in the agent detail view had lost the indent.
- The estimate marker could be missing from a run's settled line for one frame.
- The SQLite experimental warning no longer prints over the dashboard.

### Changed
- Panel titles carry an accent and a count. The mission and audit strips
  carry a name. Paths in the run pane and the no-org screen are relative
  or tilde-shortened. Placeholders read as words, not dashes.
- The README opens with a wordmark and the hero recording.

## 0.3.0 (2026-10-16)

CEO is now one thing: a terminal dashboard that runs headless agents directly.

### Providers
- **Codex agents.** An agent is hired on `claude` or `codex`. Codex agents run
  as `codex exec --json` with the compiled prompt as developer instructions,
  the task on stdin, and approvals off. Autonomy is enforced as the sandbox:
  `read-only` below `execute`, `workspace-write` at and above execute. A command
  the sandbox refuses is a denial, red in the run pane and a
  `permission_denied` note in the ledger, exactly as a claude allowlist denial.
- **Model per agent**, chosen at hire: cycle the provider's known models or
  type any id. The codex default follows `~/.codex/config.toml`.
- **Cost basis on every delegation.** `delegate_end` now records
  `costIsEstimate` and `costBasis`, one of `settled`, `anthropic-list-price`
  or `openai-list-price`. Codex reports tokens, never dollars. Every codex
  run is costed from list prices with cached input at a tenth and marked as an
  estimate. The run pane says `est.`. The `cost_estimated` note is reserved
  for a provider that should have settled and did not, such as a cancelled or
  crashed claude run.
- `delegate_start` records the provider, model, enforcement and workdir. An
  audit can then ask what a run was permitted to do without replaying the roster.
- `ceo billing` reports both accounts. Codex signed in with an API key is a
  metered account and says so on the hire form.
- Sub-cent spend renders with four decimals everywhere, including the roster
  and the status bar.

### Setup gate
- `ceo setup` checks each provider is installed and signed in and names the
  billing account. `ceo setup claude|codex` runs the login and re-checks.
  The dashboard opens on a setup screen when no provider is ready. `S` shows
  the screen any time. The hire form refuses a provider that is not ready.
  The runner refuses to start an agent on such a provider before any ledger
  entry is written.

### Suggested team
- `p` in the dashboard and `ceo suggest` propose a team with evidence for
  each seat. The evidence is Reflex's repeated workflows for this repository,
  with steps as the brief, corrections as guardrails and token mix as the cap.
  The evidence is also the models and costs of this directory's sessions, read
  from Reflex's store or directly from codex rollouts and Claude Code
  transcripts, and the roles the repository earns. Deterministic: no model is
  called. Enter opens the hire form filled in. `H` or `--hire` hires all. The
  hire form takes the seats as presets.
- `s` on the panel runs `reflex scan` and re-reads the proposal. `ceo suggest
  --scan` does the same first. `ceo setup` lists Reflex with the scan age.

### Packaging
- Packaged as `ceo-tui` for npm. `npm i -g ceo-tui` installs `ceo`. Release
  workflow on `v*` tags. Issue and PR templates, SECURITY.md, CODE_OF_CONDUCT.md.
- `docs/`: the wiki. Getting started, setup, concepts, providers, autonomy,
  queue, ledger with every event type, money, keys, cli, suggest, testing,
  troubleshooting, FAQ, comparison.

### Removed
- The Claude Code mod: the `/ceo` pane, `ceo:<name>` subagent types, the band and the
  `ceo:org` prompt section. CEO no longer runs inside Claude Code. The slash
  commands and MCP tools remain as an optional companion plugin that writes to
  the same ledger.

### Testing
- `tools/stub-codex` speaks the exec JSONL protocol and refuses to start
  unless the flags CEO must pass are present. `CEO_CLAUDE_BIN` and
  `CEO_CODEX_BIN` point the runner at the stubs. `runner.spec.ts` runs both
  providers end to end through a real ledger for $0.

## 0.2.0 (2026-10-16)

- `/ceo` pane inside Claude Code, `ceo:<name>` subagent types, `ceo json` /
  `ceo op` machine interface. The mod was removed in 0.3.0. The interface stays.
- Workspace registry at `~/.ceo/workspaces.json`, and a dashboard sidebar across repos.
- Tasks as ledger objects, `task_add` and `task_update`. Blocked is derived.
- Dispatcher: one pass or auto, across every workspace.
- `ceo` attaches to a persistent tmux session. `ceo shell` opens worktree windows.
- 29 MCP tools, 16 slash commands, marketplace manifest, MIT license, CI.

## 0.1.0 (2026-09-04)
- Core: hash-chained ledger, roster as cache, autonomy as tool allowlists,
  per-agent worktrees with provenance trailers, runner over `claude -p`,
  cost estimation for runs that never settle.
- Ink dashboard, MCP server, slash commands, CEO-Auditor and CEO-Postmortem.
