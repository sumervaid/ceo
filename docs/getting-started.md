# Getting started

Ten minutes from nothing to an org with a run in the ledger. Every step is
reversible. Nothing runs until step 4. There is no cost before that.

## 1. Install

```sh
npm install -g ceo-tui        # installs the `ceo` command
brew install tmux             # optional; keeps agents running after the terminal closes
```

From source:

```sh
git clone https://github.com/sumervaid/ceo && cd ceo
pnpm install && pnpm build && ./install.sh
```

## 2. Set up the accounts

Agents run as `claude -p`, `codex exec` or `agy -p` under the logins
already on the machine. CEO stores no model-provider credential. The
checklist covers every provider:

```sh
ceo setup
```

```
✓ claude  ready
    installed  yes, 2.1.302 (Claude Code)
    signed in  yes
    billing: dev@example.com's Claude subscription

✗ codex  not ready
    installed  yes, codex-cli 0.162.1
    signed in  no
    codex billing: not signed in
    next: codex login    for a ChatGPT plan, or `codex login --with-api-key` for a metered account

✗ gemini  not ready
    installed  no, agy not found
    signed in  -
    gemini: the Antigravity CLI (agy) is not installed
    next: curl -fsSL https://antigravity.google/cli/install.sh | bash    or set CEO_GEMINI_BIN to the binary

Agents can run on: claude. Every run bills the account named above.
```

`ceo setup claude`, `ceo setup codex` or `ceo setup gemini` runs that
login and re-checks. One
ready provider is enough to start. See [Setup and accounts](setup.md).

## 3. Open the dashboard and start an org

```sh
cd ~/code/some-project
ceo
```

With tmux installed this starts a session named `ceo` and attaches the
terminal to that session. `ceo ui` runs the dashboard in the current
terminal instead. Press `n` to create the org here. That writes
`.ceo/ledger.jsonl` with one entry and nothing else.

An org does not need a git repository. `.ceo/` lands in the current directory,
or at the repo root when there is one. Git matters only for isolated agents.
Each isolated agent gets a dedicated worktree.

## 4. Hire

Three ways.

**A company, in one keystroke.** Creating the org with `n` opens the
company picker. `enter` hires the software team: a chief of staff, a scout
on claude, an implementer on codex, a reviewer on gemini and a tester on
codex. `w` first chooses who gets a git worktree. `+` opens the picker
later. See [companies](companies.md).

**`p` proposes a team.** CEO reads the repository's manifest, test runner and
CI, the session history in this directory, and Reflex's repeated workflows
when Reflex has scanned. CEO proposes seats with the evidence for each.
`enter` on a seat opens the hire form filled in. `H` hires every seat. See
[The suggested team](suggest.md).

**`h` hires by hand.** The form asks for:

| Field | Meaning |
| --- | --- |
| name | A slug. Becomes the branch suffix for isolated agents. Typing a preset's name fills the form from the preset. |
| role | The brief: the whole instruction the agent will ever get. ↑↓ cycles presets. |
| collab | How the agent fits with the others. Optional. |
| provider | `claude`, `codex` or `gemini`. Space cycles. The billing line underneath says which account. |
| model | ↑↓ cycles the provider's known models, or type any id. |
| budget | A hard cap in USD. A delegation past the cap is refused before any money is spent. `0` means uncapped. |
| autonomy | observe · propose · execute · autonomous. The line underneath says how the level is enforced on this provider. |
| isolated | Work on a dedicated branch in a dedicated worktree. Needs git with a commit. `i` on the roster adds one later. |

Start with a `scout` at `observe` and a budget of $1. A scout at that level
cannot write at all. The first run shows whether the setup works.

## 5. Give the agent work

- `t` queues a task for the selected agent. `enter` on a queued task runs that task.
- `d` delegates ad hoc: queue and run in one step.
- `R` runs one dispatcher pass: every idle agent picks up the next queued task.
- `A` turns on auto-dispatch across every registered workspace. The status bar
  shows `AUTO` in inverse yellow while auto-dispatch is on, because auto-dispatch
  is the one mode that spends money without a keystroke per dollar.

The run pane shows the process live. The `grants` line is what the child
process was started with. Tool calls are dim. Denials are red. The cost
settles on the last line. A cancelled run, by `c` or `esc`, still cost what
the run spent. The pane says so.

## 6. Read the ledger

```sh
ceo snapshot            # the org as text
tail -3 .ceo/ledger.jsonl
```

Every hire, task, run and dollar is there, hash-chained. Commit
`.ceo/ledger.jsonl`, `.ceo/roster.json`, `.ceo/audits/` and
`.ceo/context/`. Gitignore `.ceo/worktrees/`, `.ceo/outputs/`,
`.ceo/runs/` and `.ceo/chief/`.

## Next

- [Keys](keys.md) for everything the dashboard can do.
- [Autonomy](autonomy.md) before raising any agent past `execute`.
- [Money](money.md) before the first real afternoon of runs.
