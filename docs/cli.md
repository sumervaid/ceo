# Command line

`ceo` with no arguments is the dashboard. Everything else is a subcommand
that prints and exits. The subcommands therefore compose with shell scripts
and cron.

```
ceo                    attach to the dashboard (tmux session `ceo`), or run it here
ceo ui                 the dashboard in this terminal, no tmux
ceo chat               the dashboard in this terminal, opened on the chat with the chief of staff
ceo sky                the dashboard in this terminal, opened on the constellation
ceo company [id]       hire a whole company; no id lists them; --worktrees writers|all|none, --size n
ceo swarm <name> <n>   hire n copies of one agent across providers; --brief, --providers, --budget, --level, --task
ceo docket [add|give|take|rm|refresh]   the context each agent is given
ceo skills [give <name> <agent>]        skills from Reflex and the CLIs' folders
ceo github             the gh account, the repo and its open issues
ceo pr <agent> [--base b]   push the agent's branch and open a pull request
ceo hf <org/model|datasets/org/name|paper:id>   a Hub card, as an agent reads it
ceo alerts [bell|desktop on|off] [slack|webhook <url>|off] [<event> on|off] [test]   events: done failed budget denied chief queue limit
ceo open               the dashboard beside the current session: a tmux split, else a new window
ceo setup [provider]   are claude, codex and gemini installed and signed in; `ceo setup codex` runs the login; `ceo setup github` runs gh auth login; `ceo setup hf` explains Hugging Face
ceo suggest            propose a team; --hire hires it, --json, --everywhere, --days N
ceo task …             the queue; --verify, --samples, --arm and --sandbox on `add`
ceo run <task> [--samples n]   run a task now as attempts, verify each, keep the winner
ceo verify <check> [--in <dir>]   run one check now
ceo mission [checks [add <check>]|check]   the mission, the mission's checks, a run of every check
ceo approvals [approve|deny <id>|auto-merge on|off]   the requests that wait for a decision
ceo router [kind]      what the router knows; `ceo router pick "<title>" [-n 3]` for the arms the router would choose
ceo outcomes [--all] [budget …]   verified results and dollars per verified result
ceo sandbox [test]     where runs execute and whether the sandbox can start
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

## `ceo company`

```sh
ceo company                        # the companies
ceo company software               # hire one
ceo company software --size 4      # each seat becomes four agents
ceo company full --worktrees none --size 2
```

`--size` takes a whole number from 1 to 50. Each seat becomes that many
agents, named `<seat>-01`, `<seat>-02` and so on, dealt across every ready
provider. See [companies](companies.md) and [swarms](swarms.md).

## `ceo swarm`

```sh
ceo swarm fixer 12
ceo swarm fixer 12 --providers claude,codex --budget 1.5 --level execute
ceo swarm fixer 12 --brief "Fix one flaky test." --task "Pick a flaky test and fix it."
```

| Flag | Default | Sets |
| --- | --- | --- |
| `--brief` | A general fixer brief | What each member does |
| `--providers` | Every ready provider | The providers to deal across, round-robin |
| `--budget` | 2 | Each member's budget in dollars |
| `--level` | `execute` | `observe`, `propose`, `execute` or `autonomous` |
| `--task` | None | A task queued for every member |

The members are `<name>-01`, `<name>-02` and so on. The count has no limit.
See [swarms and limits](swarms.md).

## `ceo sky`

```sh
ceo sky                # the dashboard, opened on the constellation
ceo sky --layout web   # opened on one layout: auto, orbit, providers, teams, web, spend or spiral
ceo constellation      # the same
```

See [the constellation](sky.md).

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
ceo task add coder "Fix the flaky retry test" --verify "npm test" --samples 3
ceo task add coder "Fix the crash in login" --arm claude --arm codex:gpt-5 --verify "npm test"
ceo task <id> done | cancel | queue | assign <agent>
```

| Flag | Repeats | Sets |
| --- | --- | --- |
| `--verify "<check>"` | Yes | A check that decides the task. A command, `everval:<file>#<scenario>` or `judge:<rubric>`. See [verification](verification.md). |
| `--samples n` | No | How many attempts run at once. Default 1. |
| `--arm provider[:model]` | Yes | An arm to try. Without a model, the provider's default model. Without any arm, the router chooses. |
| `--sandbox kind` | No | `local`, `docker` or `ssh`. See [sandboxes](sandboxes.md). |

A task with a check, or with more than one attempt, runs as attempts. Each
attempt runs on one arm, in a separate worktree. The task reaches done
only when an attempt passes every required check. Naming `n` arms sets the
attempts to at least `n`. See [the queue](queue.md).

## `ceo run`

```sh
ceo run 82b413                 # the task's own attempts and checks
ceo run 82b413 --samples 3     # three attempts across the router's arms
```

`ceo run` starts the task now, headless. A task with no check and one
attempt runs once, as before. Every other task runs as attempts. The command
prints each attempt with the arm, the verdict of each and a star beside the
winner. The exit code is 0 for a task that reached done. Any other result
exits 1. The task needs an assignee.

## `ceo verify`

```sh
ceo verify "npm test"
ceo verify "everval:evals/retry.json#flaky" --in .ceo/worktrees/fixer--a1b2
ceo verify "judge:the fix is minimal"
```

`ceo verify` runs one check. The command prints the status, the score and a
line of detail. `--in` names the directory to check. The default is the current
directory. The result lands in the ledger as a `verify` event when an org
exists. The exit code is 1 unless the check passes. See
[verification](verification.md).

## `ceo mission`

```sh
ceo mission                              # the objective, the criteria and the checks
ceo mission checks                       # each check with the result of the last run
ceo mission checks add "npm test"        # add a check
ceo mission check                        # run every check
```

`ceo mission check` writes one `verify` event per check, with scope
`mission`. The exit code is 1 unless the mission is met. A check that could
not run counts as not met. The dashboard edits the objective with `M`. See
[verification](verification.md#mission-checks).

## `ceo approvals`

```sh
ceo approvals                    # the setting, then each pending request with the evidence
ceo approvals approve ap-3fa9c1  # approve one; a merge runs now
ceo approvals deny ap-3fa9c1
ceo approvals auto-merge on      # let a merge that clears the evidence rule land alone
ceo approvals auto-merge off     # the default
```

See [judges and gates](gates.md).

## `ceo router`

```sh
ceo router                                   # the evidence table for every kind
ceo router debug                             # one kind
ceo router pick "Fix the crash in login" -n 3
```

The kinds are `review`, `ci`, `debug`, `feature`, `edit`, `research` and
`explore`. `-n` takes a whole number from 1 to 12. Default 3. See
[the router](router.md).

## `ceo outcomes`

```sh
ceo outcomes                     # this workspace: overall, by arm, by agent
ceo outcomes --all               # every registered workspace, with the allocation share
ceo outcomes budget              # print the outcome budget
ceo outcomes budget --attempts 20 --verified 5 --period day
ceo outcomes budget --verified none
```

`--attempts` and `--verified` take a whole number or `none`. `--period` takes
`all` or `day`. A flag left out keeps the current value. See
[outcomes](outcomes.md).

## `ceo sandbox`

```sh
ceo sandbox                      # the kind, the image or host, and whether the sandbox can start
ceo sandbox test                 # run `true` inside the sandbox and report the exit code
CEO_SANDBOX=docker ceo sandbox
```

The exit code is 1 when the configured sandbox is not ready. See
[sandboxes](sandboxes.md).

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
| `CEO_MAX_RUNNING` | A ceiling on runs at once across the dashboard. Default none. `0`, `none`, `unlimited` and `off` mean none. See [swarms and limits](swarms.md). |
| `CEO_CHIEF_MAX_HIRES` | A ceiling on hires per reply of the chief of staff. Default none. See [chat](chat.md). |
| `CODEX_HOME` | Where codex's `config.toml` and `sessions/` are. Default `~/.codex`. |
| `CLAUDE_CONFIG_DIR` | Where Claude Code's `projects/` transcripts are, for `suggest`. Default `~/.claude`. |
| `REFLEX_HOME` | Where Reflex's `reflex.db` is, for `suggest`. Default `~/.reflex`. |
| `CEO_REFLEX_BIN` | The `reflex` binary, when not on PATH. |
| `CEO_EVERVAL_BIN` | The `everval` binary, when not on PATH. Point at `tools/stub-everval` for $0 checks. See [verification](verification.md). |
| `CEO_SANDBOX` | Where runs execute: `local`, `docker` or `ssh`. Default `local`. See [sandboxes](sandboxes.md). |
| `CEO_SANDBOX_IMAGE` | The image a docker sandbox starts. Default `ceo-agent:latest`. |
| `CEO_DOCKER_BIN` | The `docker` binary, when not on PATH. Point at `tools/stub-docker` for $0 runs. |
| `CEO_SKY_LAYOUT` | The layout the constellation opens on: `auto`, `orbit`, `providers`, `teams`, `web`, `spend` or `spiral`. Wins over the remembered choice. |
| `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` | Read, never written. These variables decide what `setup` and `billing` report. |
