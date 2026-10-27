# Command line

`ceo` with no arguments is the dashboard. Everything else is a subcommand
that prints and exits. The subcommands therefore compose with shell scripts
and cron.

```
ceo                    attach to the dashboard (tmux session `ceo`), or run it here
ceo ui                 the dashboard in this terminal, no tmux
ceo chat               the dashboard in this terminal, opened on the chat with the chief of staff
ceo company [id]       hire a whole company; no id lists them; --worktrees writers|all|none
ceo docket [add|give|take|rm|refresh]   the context each agent is given
ceo skills [give <name> <agent>]        skills from Reflex and the CLIs' folders
ceo github             the gh account, the repo and its open issues
ceo pr <agent> [--base b]   push the agent's branch and open a pull request
ceo hf <org/model|datasets/org/name|paper:id>   a Hub card, as an agent reads it
ceo alerts [bell|desktop on|off] [slack|webhook <url>|off] [<event> on|off] [test]
ceo open               the dashboard beside the current session: a tmux split, else a new window
ceo setup [provider]   are claude, codex and gemini installed and signed in; `ceo setup codex` runs the login; `ceo setup github` runs gh auth login; `ceo setup hf` explains Hugging Face
ceo suggest            propose a team; --hire hires it, --json, --everywhere, --days N
ceo task …             the queue
ceo agent <name> provider <p> [model]   move an agent to another provider; everything else stays
ceo board [n]          notes posted by agents and the operator
ceo runs               who is working right now, from the live traces
ceo trace <agent>      what an agent is doing, or did last, line by line
ceo post <agent|*> <text>   leave a note for an agent, or everyone
ceo workspace …        the registry of directories the sidebar shows
ceo shell [agent]      a tmux window in the repo root, or an agent's worktree
ceo snapshot           the org as text
ceo status             one line
ceo billing            which accounts claude, codex and gemini runs bill to
ceo json [root]        the org as one JSON object
ceo op <verb> <json>   one mutation through the core, reported as JSON
ceo help
ceo --version          the installed version
```

## `ceo setup`

```sh
ceo setup              # checklist; exit 1 when no provider is ready
ceo setup claude       # runs `claude` for the login, then the checklist
ceo setup codex        # runs `codex login`, then the checklist
ceo setup gemini       # runs `agy` for the Google sign-in, then the checklist
```

## `ceo suggest`

```sh
ceo suggest                        # the proposal with evidence, as text
ceo suggest --json                 # for scripts
ceo suggest --hire                 # hire every seat as proposed; creates the org if needed
ceo suggest --everywhere           # include Reflex workflows seen only in other repos
ceo suggest --days 14              # history window (default 60)
ceo suggest --scan                 # run `reflex scan --days 30 --yes` first, in this terminal
```

See [The suggested team](suggest.md) for where seats come from.

## `ceo task`

```sh
ceo task ls
ceo task add <agent|-> [!|.] <title…>     # ! high, . low; - leaves it unassigned
ceo task <id> done | cancel | queue | assign <agent>
```

## `ceo workspace`

```sh
ceo workspace ls
ceo workspace add <path> [name]
ceo workspace rm <path|name>               # the registry only; .ceo/ is untouched
```

The registry is `~/.ceo/workspaces.json`, or `$CEO_HOME/workspaces.json` when
that variable is set. Running `ceo` in a directory registers that directory.

## `ceo json` and `ceo op`

The machine interface. `ceo json` prints the whole org as one object:
agents with effective permissions, mission, tasks, recent delegations,
today's rollup, audits, chain verification, the workspace list. `ceo op`
performs one mutation and prints the result. Every write goes through the
same core functions and lock the dashboard uses.

```sh
ceo op init '{}'
ceo op hire '{"name":"coder","role":"Implement what the queue asks for.","provider":"codex","autonomy":"execute","budgetUsd":2}'
ceo op budget '{"name":"coder","budgetUsd":5}'
ceo op autonomy '{"name":"coder","autonomy":"propose"}'
ceo op mission '{"objective":"Ship v2 with zero regressions","successCriteria":["tests green"]}'
ceo op task_add '{"title":"write the changelog","assignee":"coder","priority":"high"}'
ceo op compile '{"agent":"coder"}'          # the prompt and enforcement a run would start with
ceo op fire '{"name":"coder","reason":"done"}'
```

Verbs: `init hire fire budget autonomy mission task_add task_update
workspace_add workspace_remove workspace_touch compile delegate_begin
delegate_end note`. `delegate_begin` / `delegate_end` exist for a caller
that spawns the process directly. A second `delegate_end` for one delegation
is refused rather than double-counted.

## Environment

| Variable | Effect |
| --- | --- |
| `CEO_HOME` | Where `workspaces.json` lives. Default `~/.ceo`. |
| `CEO_CLAUDE_BIN`, `CEO_CODEX_BIN`, `CEO_GEMINI_BIN` | The binaries to spawn. Default `claude`, `codex`, `agy` on PATH. Point at `tools/stub-*` for $0 runs. |
| `CEO_GEMINI_SANDBOX` | Set to pass `--sandbox` to the Antigravity CLI on gemini runs. |
| `CEO_SKIP_SETUP_CHECK` | Skip the runner's readiness gate, for hosts that sign in some other way. |
| `CEO_NO_COLLAB` | Run agents without the `org` tools and the from-the-org prompt section. |
| `CEO_MAX_TURNS` | Follow-up turns a run may take to receive notes. Default 6. |
| `CODEX_HOME` | Where codex's `config.toml` and `sessions/` are. Default `~/.codex`. |
| `CLAUDE_CONFIG_DIR` | Where Claude Code's `projects/` transcripts are, for `suggest`. Default `~/.claude`. |
| `REFLEX_HOME` | Where Reflex's `reflex.db` is, for `suggest`. Default `~/.reflex`. |
| `CEO_REFLEX_BIN` | The `reflex` binary, when not on PATH. |
| `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` | Read, never written. These variables decide what `setup` and `billing` report. |
