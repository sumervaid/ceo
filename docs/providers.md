# Providers

An agent runs on `claude`, `codex` or `gemini`, chosen at hire and changeable
later. Inside the org the choice changes nothing else. An agent reads a
teammate's output. An agent posts a note that lands in another teammate's
next turn. The ledger records each exchange with the model that ran the
exchange, whatever the two providers are. The provider decides how a run
happens, not which teammates an agent can work with, and not what the agent
is for. A role is a brief. The provider is a setting.
`v` on the roster, `ceo agent <name> provider <p>` or the MCP
`ceo_reconfigure` tool moves an agent. The brief, budget, level, branch
and history come with the agent.
All three are headless processes CEO spawns directly. CEO never runs inside
any of the three. `src/core/providers.ts` is the only file that knows any CLI's
flags or output. That is a rule, not a habit.

## Side by side

| | **claude** | **codex** |
| --- | --- | --- |
| Process | `claude -p <task> --output-format stream-json --verbose` | `codex exec --json -`, task on stdin |
| Prompt | the compiled brief as `--append-system-prompt` | the compiled brief as `-c developer_instructions=…` |
| Model | `--model` | `--model` |
| Autonomy | `--allowed-tools <list>`: a tool allowlist | `--sandbox read-only\|workspace-write` with `-c approval_policy="never"` |
| Working directory | the agent's worktree, or the project root | the same, with `--skip-git-repo-check` so a worktree is fine |
| Output parsed | `assistant` turns (text, tool_use, usage) then `result` | `item.*` (command_execution, agent_message, file_change, …) then `turn.completed` |
| Cost | `total_cost_usd` from the process: settled | tokens only (`input`, `cached_input`, `output`): costed from list prices, marked `est.` |
| Denials | `permission_denials[]` in the result | a `command_execution` the sandbox refused |
| Bills | the Claude Code login | the `codex login`: a ChatGPT plan, or a metered API key |

## What each one can promise

**claude** enforces a per-tool allowlist. An `observe` agent has no `Write`,
`Edit` or `Bash` tool at all. If the model reaches for such a tool, the claude
process refuses the call and reports the attempt in `permission_denials`. That
attempt is recorded in the ledger as a `permission_denied` note and shown in
red in the run pane. That red line is the clearest signal there is that a
level is doing work.

**codex** enforces a filesystem sandbox. There is no per-tool allowlist.
`observe` and `propose` both map to `read-only`: the model can run commands.
Nothing the model runs can write the filesystem or reach the network.
`execute` and `autonomous` map to `workspace-write`, scoped to the working
directory. Approvals are off because no human is at the keyboard of a
headless run. A command the sandbox refuses fails. The failure comes back as
a `command_execution` item with output naming the sandbox. CEO reads that as
a denial. The read is textual. A refusal phrased differently completes as an
ordinary failed command. The sandbox still held. Only the red line is missed.

No provider is asked nicely. The compiled prompt also explains the level
to the agent. An agent aware of the write ban produces a useful proposal
instead of a failed edit. That is the belt. The flag is the trousers.

## Cost

claude reports a settled dollar figure in the final message. That figure
is always preferred. codex reports tokens and never dollars. So every codex
run is costed from list prices with cached input at a tenth of the input
rate. The run is recorded with `costIsEstimate: true` and `costBasis:
"openai-list-price"`. The pane shows the run as `est.`. On a ChatGPT plan the
marginal cost of a codex run is $0. The ledger still records what the tokens
would have cost, because that is the figure budgets gate on. That figure also
makes two providers comparable. Gemini runs follow the same rule with basis
`"google-list-price"`.

Unknown models are priced at the vendor's mid tier rather than at zero. An
unknown `gpt-*` model gets gpt-5 rates. An unknown `gemini-*` model gets
gemini-2.5-pro rates. Anything else gets sonnet rates. `pricing.ts` is the table. A wrong rate is a bounded
and visible error. A missing rate is a silent understatement.

## Models

The hire form cycles the provider's known models or accepts any id. Codex's
default follows `model = "…"` in `~/.codex/config.toml`, or under `$CODEX_HOME`.
What CEO offers first is therefore what `codex` would use by default.

## Choosing

Use the provider that is already signed in and familiar. When several are
ready, claude has the finest-grained permission story: an observe agent that
truly cannot run a command. Codex fits when a read-only sandbox is enough.
Gemini fits the same way through plan mode. A second provider on a team
brings a different model's second opinion. The suggested team, `p`, picks
the model this directory's sessions have mostly used. The provider follows
the model.

## Adding one

A provider is an object with `plan`, `parse`, `enforcementLabel`, `binary`,
`models` and two cost flags. Nothing else in CEO knows the CLI. See the
header of `src/core/providers.ts`. Give the new provider a stub under `tools/`
that speaks the provider's protocol. The runner spec can then run the provider
for $0.

## gemini, through the Antigravity CLI

Google moved the individual Gemini tier from Gemini CLI to the Antigravity
CLI, `agy`, in 2026. CEO runs agents on gemini through that CLI:

| | **gemini** |
| --- | --- |
| Process | `agy -p <brief and task> --output-format stream-json --mode plan\|accept-edits` |
| Prompt | there is no system-prompt flag. The compiled brief rides ahead of the task in the prompt |
| Model | `--model <slug>`; the bare word `gemini` means the CLI's own default. `agy models` lists slugs once signed in |
| Autonomy | `--mode plan` is the CLI's read-only mode, used for observe and propose. `--mode accept-edits` approves file edits for execute and autonomous. Shell commands still need approval. In headless mode a tool with no approver is soft-denied. CEO never passes `--dangerously-skip-permissions` |
| Commands an org wants allowed | `permissions.allow` rules in `~/.gemini/antigravity-cli/settings.json`, the CLI's own mechanism |
| Sandbox | `--sandbox` when `CEO_GEMINI_SANDBOX` is set; off by default because the sandbox depends on the machine |
| Output parsed | `init`, then `step_update` events with `step_type` of `tool` or `agent_response`, then `result` with `usage` |
| Cost | tokens only: input plus cache reads, output plus thinking, costed from list prices and marked `est.`, basis `google-list-price` |
| Bills | the signed-in Google account through `agy`, or a metered Gemini key when the CLI's settings select the key |

Sign in once by running `agy` in a terminal. The browser opens. Headless
runs cannot open the browser. That is why `ceo setup` says "not signed in"
until the sign-in has happened. The readiness check asks the CLI for the
model list, since the CLI keeps the token in the OS keyring and has no status
command.

The parser reads the event fields from the step or from the top level. A
change in the CLI's step shape therefore shows fewer live events rather than
a failed run. The stub under `tools/stub-gemini` speaks the same protocol.
The runner spec covers gemini for $0. Parse problems on a newer `agy` belong
in an issue with the CLI's version.
