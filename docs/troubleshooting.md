# Troubleshooting

The message on screen, and the meaning of each.

## Setup

**`✗ claude  not ready · installed no, claude not found`** Claude Code is
not on PATH. `npm i -g @anthropic-ai/claude-code` installs Claude Code. Alternatively, set `CEO_CLAUDE_BIN`
to the binary.

**`✗ codex  not ready · signed in no`** Run `codex login` for ChatGPT, or
`codex login --with-api-key`. `ceo setup codex` runs the login and
re-checks.

**`✗ gemini  not ready · installed no, agy not found`** The Antigravity
CLI is not on PATH. `curl -fsSL https://antigravity.google/cli/install.sh |
bash` installs the CLI. Setting `CEO_GEMINI_BIN` to the binary also works.

**`✗ gemini  not ready · signed in no`** The Antigravity CLI is installed
without a sign-in. Run `agy` once in a terminal. The browser sign-in
finishes the setup. A headless run cannot open the browser. `ceo setup
gemini` re-checks.

**`IneligibleTierError` from Gemini CLI.** Google moved the individual tier
from Gemini CLI to the Antigravity CLI. CEO runs gemini agents through
`agy`. Gemini CLI is not needed.

**`! codex is signed in with an API key, so codex agents bill a metered OpenAI account`**
Not an error. The line says which account a run bills. `codex login` with
ChatGPT moves billing to the plan.

**The dashboard opens on the setup screen every time.** No provider is
ready. Fix one. `r` re-checks without restarting.

**`claude is not signed in` but `claude` works in the terminal.** CEO reads
`~/.claude.json` for the account. If the login lives elsewhere, export
`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. Alternatively, set
`CEO_SKIP_SETUP_CHECK=1`.

## Hiring

**`Agent names must be lowercase alphanumeric with hyphens, 2 to 40 characters`**
The name becomes a git branch suffix. `coder-2`, not `Coder 2`.

**`Role brief must be at least 10 characters`** The brief is the whole
instruction the agent gets. The core refuses a brief that cannot say what
the deliverable is.

**`enter blocked (codex not ready)`** The hire form refuses a provider that
cannot run. Switch provider with space. Alternatively, sign in and press `S` then `r`.

**`Isolated agents need a git repository`** `isolated` means a git worktree.
`git init` first. Alternatively, hire without `isolated`.

## Running

**`<agent> has spent $x of its $y budget`** The cap. `b` raises the cap. The
queue unblocks without further action.

**`<agent> is already running`** One run per agent at a time. Wait, or `c`.

**`<task> is blocked: unassigned`** Assign the task with `e`, or with `ceo task <id>
assign <agent>`.

**A run shows `✗ failed · claude exited 1: …`** The process's stderr is in
the message. Common causes: a model id the CLI does not know, visible in the
roster's model column, or a CLI that needs a newer version.

**`codex is not installed: codex is not on PATH.`** From the runner's
readiness gate. The message names the install command. No ledger entry was
written. The same gate covers claude and gemini.

**Red `DENIED` lines in the run pane.** The agent reached past the permitted
autonomy level. The process refused. Not an error: the level is working as
designed. The fault lies in a brief that asks for an action the level forbids, or in a level
too low for the job. `y` raises the level, knowingly.

**`$0.0046 est.`** The figure is computed from tokens at list price. Every
codex run and every gemini run is an estimate. A claude run is an estimate
only after a cancel or a crash before settling.
See [Money](money.md).

## The ledger

**`LEDGER CHAIN BROKEN AT SEQ n`** An entry was edited, deleted or
reordered. Every figure past that point is unproven. Restore
`.ceo/ledger.jsonl` from git. `verify()` names the first bad seq.

**`n dangling`** Delegations that started and never ended, because the dashboard was
killed mid-run or a process was lost. The ledger is honest about the gap.
The auditor reports the gap. Nothing to fix by hand.

**Spend on the roster does not match the invoice.** The roster shows list
price for codex and gemini. Claude runs show the settled cost. A
subscription, a ChatGPT plan or a Google account bills differently. The figure is for budgets and comparison, not for the invoice.

## The dashboard

**Nothing happens on a keypress.** A dialog is open with the keyboard, or
focus is on another panel. `tab` moves focus. `esc` closes dialogs.

**The pane looks garbled after a resize.** `r` redraws. Under 80 columns the
status bar drops the legend first and the spend last.

**`tmux is not installed, so the dashboard runs in the foreground`** The
dashboard works. Runs just do not survive closing the terminal. `brew install tmux`.

**`ceo open` printed `Could not open a second pane here`** No tmux and no
known terminal to open. Run `ceo ui` in another terminal.

## Suggestions

**`Reflex has not scanned on this machine`** `npm i -g reflex-skills &&
reflex scan --days 30`, then `p` again. The proposal still works from the
repository and the local transcripts without Reflex.

**The proposal picks a model no longer in use.** The proposal picks the
most-used model in this directory's recent sessions. Change the model on the
form. Or shorten the window with `ceo suggest --days 14`.
