# Setup and accounts

<p align="center">
  <img src="setup.gif" alt="ceo setup names the account each provider bills; ceo company lists the six companies" width="760">
</p>

A headless run has no human at the keyboard. If the CLI is missing, the
process fails to spawn. If no account is signed in, the CLI prints a login
prompt to a pipe and exits. CEO checks both before any run.

## The check

```sh
ceo setup                 # the checklist
ceo setup claude          # runs `claude` for a sign-in, then re-checks
ceo setup codex           # runs `codex login`, then re-checks
ceo setup gemini          # runs `agy` for the Google sign-in, then re-checks
ceo setup github          # runs `gh auth login`
ceo setup hf              # how to sign in to Hugging Face for private repos
```

Per provider, three facts:

| | How CEO decides |
| --- | --- |
| installed | `<binary> --version` runs. `CEO_CLAUDE_BIN`, `CEO_CODEX_BIN` and `CEO_GEMINI_BIN` name the binary when the binary is not on PATH. |
| signed in | claude: `~/.claude.json` has an account, or `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is set. codex: `codex login status` reports a login. gemini: `agy models` lists models rather than asking for a sign-in. |
| billing | claude: the account in `~/.claude.json`, or a metered account when `ANTHROPIC_API_KEY` is set. codex: ChatGPT plan, or a metered API account. gemini: the Google account, or a metered key when `GEMINI_API_KEY` is set and selected in the CLI's settings. |

The same check gates three things:

- The dashboard opens on the setup screen when no provider is ready. `S`
  shows the screen any time. `c`, `x` and `g` open a tmux window running
  the login for claude, codex and gemini. `r` re-checks.
- The hire form refuses a provider that is not ready. The line under the
  provider field says why, in red. Enter is blocked until the provider
  changes or the login completes.
- The runner refuses to start an agent on an unready provider before any
  ledger entry is written. A run that could never start leaves no trace.

## Reflex, optional

The checklist ends with a row for [Reflex](https://github.com/sumervaid/reflex-tui):
installed or not, scanned or not, how old the scan is. Reflex never gates a
run. The row is there because the suggested team, `p`, is only as good as the
readable history. A scan older than the org's recent runs misses what the org
has been doing. `s` on the suggested team runs the scan.

## Whose money

| Provider | Signed in with | Bills |
| --- | --- | --- |
| claude | Claude Code login | the signed-in Claude subscription, and extra usage if enabled |
| claude | `ANTHROPIC_API_KEY` in the environment | a metered Anthropic API account |
| codex | `codex login` with ChatGPT | the signed-in ChatGPT plan |
| codex | `codex login --with-api-key`, or `OPENAI_API_KEY` | a metered OpenAI API account, per token |
| gemini | `agy`, Google sign-in in the browser | the signed-in Google account's Antigravity quota |
| gemini | `GEMINI_API_KEY` with `modelProvider: gemini` in the CLI's settings | a metered Google AI key, per token |

A metered account is a warning in yellow on the checklist and on the hire
form, not a block. `ceo billing` prints the same with more words.

## Headless hosts

- `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`, counts as a Claude
  login and needs no browser.
- `CEO_SKIP_SETUP_CHECK=1` bypasses the runner's gate for a host that signs
  in some way the check cannot see. The hire form and the setup screen still
  report the visible state.

## What CEO never does

Sign an account in. Every login is the vendor's own flow. CEO launches the
flow and reads the result. CEO stores no model-provider credential.

The integrations work the same way. GitHub runs through the `gh` login.
Hugging Face reads the token that `hf auth login` saved, or `HF_TOKEN`.
Slack and webhook URLs for alerts live in `~/.ceo/alerts.json`.
