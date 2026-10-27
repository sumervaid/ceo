---
description: Print the org as text and open the standalone dashboard beside the session.
argument-hint: 'nothing, or "here" to print inline without opening a window'
---

Arguments: $ARGUMENTS

Let `CEO_BIN` be `${CLAUDE_PLUGIN_ROOT}/dist/cli.js`, invoked as
`node "$CEO_BIN" <subcommand>`.

**Step 1: make sure an org exists.**

Call the `ceo_status` MCP tool. If it errors because no org exists in this
project, call `ceo_init`, print its output verbatim, and continue. If it
errors for any other reason, print that error verbatim and stop.

**Step 2: print the org view.**

Run `node "$CEO_BIN" snapshot` with Bash and print its output verbatim
inside a fenced code block. This is the org view: roster with spend against
budget, isolated agents and their branch state, recent delegations, audit
status, totals, and a suggested next action. It always works, so it is what
the user sees first.

**Step 2b: when the org is empty, do not stop at an empty table.**

If the snapshot shows no agents hired, an empty org view is useless on its
own. Immediately do what `/hire` with no arguments does. Look at the repo:
root listing, manifest file, test setup, `git log --oneline -15`. Propose
three or four agents that fit *this* repo, each with a name, one line on why
it fits, and the exact hire command. Ground every proposal in something you
actually observed rather than in what teams generally have. Then offer to
hire them. Hire nothing until they say so.

**Step 3: open the live dashboard, unless they said not to.**

Skip this step if the arguments contain "here", "inline", "no window", or
"snapshot". Otherwise run `node "$CEO_BIN" open` with Bash.

That command puts the dashboard beside the session. Inside tmux it splits
the window, attaching to the persistent `ceo` session if one is running.
Outside tmux but with tmux installed, it starts the `ceo` session detached.
It then reports that the bare `ceo` command attaches to it. With no tmux it
opens a new terminal window on macOS. The dashboard cannot render in this
session directly. It needs raw-mode control of the terminal, and Claude Code
already holds it. Opening it beside the session is the point anyway. You
drive the org from here and watch it update over there.

The dashboard shows every registered workspace in a sidebar, so if the user
runs orgs in several repos, this one appears alongside them.

Print whatever that command reports in one line. If it says it could not
open a pane, pass the fallback command through verbatim rather than
rewording it. It is the exact line the user needs to run.

**Output discipline.**

The snapshot block, then one line about the dashboard. No headings, no
preamble, no summary of what the numbers mean. The user can read a table.

If `ceo_init` suggested adding `.ceo/worktrees/` and `.ceo/outputs/` to
`.gitignore`, pass that line through and let them decide. Do not edit
`.gitignore` yourself.
