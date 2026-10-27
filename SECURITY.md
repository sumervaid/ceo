# Security

CEO runs agents on the operator's machine with the operator's logins. This
page covers what CEO can and cannot do, what leaves the machine, and how to
report a finding.

## Supported versions

Security fixes land on the latest minor release. Older releases get no
backports.

| Version | Supported |
|---|---|
| 0.4.x | Yes |
| Below 0.4 | No |

## Credentials

- **No model-provider credential.** CEO never stores an API key for Claude,
  Codex or Gemini. CEO spawns `claude`, `codex` and `agy`. Each CLI uses the
  account signed in to that CLI. `ceo setup` and `ceo billing` name that
  account.
- **The Hugging Face token is read, not stored.** CEO reads `HF_TOKEN`, or
  the token file that `hf auth login` writes. CEO never writes the token
  anywhere.
- **GitHub access goes through `gh`.** CEO runs the `gh` CLI. The token stays
  in the store `gh` manages.
- **Alert webhooks are secrets.** `~/.ceo/alerts.json` holds the Slack and
  webhook URLs. The file is written with mode 0600.

## What CEO can and cannot do

- **Autonomy is enforced by the child process.** An `observe` agent on claude
  has no Write tool, enforced by `--allowed-tools`. On codex the agent has a
  read-only sandbox, `--sandbox read-only` with approvals never. On gemini an
  `observe` or `propose` agent runs in `--mode plan`, the CLI's read-only
  mode. An `execute` or `autonomous` agent on gemini runs in `--mode
  accept-edits`. CEO does not rely on the prompt to keep an agent in the
  permitted lane. Prompt text explains the level. The flag enforces the
  level.
- **Isolated agents write only in the worktree.** The process cwd is the
  worktree. On codex the sandbox is scoped to the worktree. A non-isolated
  `execute` agent writes in the operator's working tree. The hire form says
  so.
- **The ledger is tamper-evident, not tamper-proof.** `verify()` detects an
  edited, deleted or reordered entry and names the seq. The check cannot stop
  a person with write access to `.ceo/` from rewriting the whole chain.
  Committing the ledger lets git hold the history.
- **An agent cannot close a cost record.** The `ceo_delegate_end` MCP tool is
  blocked for agents at every level. A run's cost is written by the runner
  from the process's own report.
- **History readers are read-only.** `ceo suggest` opens Reflex's store
  read-only and reads transcript files. The command writes nothing outside
  `.ceo/`.

## What leaves the machine

- **The agent CLIs' traffic.** Each CLI sends the compiled prompt, the task
  text and the files the agent reads under the agent's permissions to the
  CLI's vendor.
- **The Hugging Face Hub API.** Docket items for models, datasets, Spaces and
  papers are fetched from the Hub. The token goes along when one is set.
- **Docket URLs.** A URL added to the docket is fetched once, when added or
  refreshed.
- **GitHub, through `gh`.** Issue reads, branch pushes and pull requests.
- **Alerts.** A Slack or webhook alert is an HTTPS POST to the configured
  URL. The bell and the desktop notification stay local.

CEO sends nothing else. No telemetry. No update check.

## Reporting

Open a private security advisory at
https://github.com/sumervaid/ceo/security/advisories/new. Email to
sumer@stanford.edu also works. A report says what was found and how to
reproduce the finding. A report also says whether the finding can make the
ledger understate spend or let an agent act above the permitted level. Those
two are treated as the most serious.
