# FAQ

**Does CEO run inside Claude Code?** No. CEO is a standalone terminal program that
runs `claude -p`, `codex exec` and `agy -p` as child processes. An earlier version had
an in-session pane. The pane was removed in 0.3.0. The slash commands and MCP
tools remain as an optional companion for Claude Code users wanting to talk
to the org from there.

**Are claude, codex and gemini all required?** One is enough. `ceo setup` says
which are ready. An org can mix providers agent by agent.

**Why does gemini run through `agy` and not `gemini`?** Google moved the
individual tier to the Antigravity CLI in 2026. Gemini CLI now refuses a
personal Google login with an "ineligible tier" error. `agy -p` has the
headless mode, the streaming JSON and the read-only mode CEO needs.

**Is a git repository required?** No. An org lives in a directory. Git is
needed for one feature only: `isolated` agents. Those agents' worktrees and
branches are git objects.

**Which account does a run bill?** The account each CLI is signed in as. CEO
stores no model-provider credential. `ceo billing` prints the account of
every provider. A metered API key is a yellow warning on the checklist and
the hire form.

**Why does a codex or gemini run say `est.`?** Codex and the Antigravity CLI
report tokens, not dollars. CEO prices the tokens at list price with cached
input at a tenth. CEO marks the figure as an estimate. On a ChatGPT plan or
a Google account the real marginal cost is $0. The figure is what budgets
gate on. The figure also makes providers comparable.

**Why can't an `observe` agent run a command on claude, but can on codex?**
claude enforces a per-tool allowlist. `observe` has no Bash. codex
enforces a filesystem sandbox, which cannot distinguish "run" from "write"
more finely than read-only. The sandbox stops any write. Gemini runs
`observe` in plan mode, the CLI's read-only mode. Every one of the three is
a control applied by the process, not prompt wording.

**Can an agent change a budget or close a cost record, including the agent's own?**
No. The MCP tools that write cost or budgets are blocked for agents at every
level. The runner writes cost from the process's own report.

**What happens when the dashboard is killed mid-run?** The child processes
are killed with the dashboard. The `delegate_start` entries of those runs stay
without an end: dangling delegations, which the status bar counts and the
auditor reports. With tmux, `ctrl-b d` detaches instead. The runs continue.

**Can two dashboards share an org?** Yes, safely. Every write takes a file
lock. A run started by one dashboard is visible to the other only as a
running task and, if cut off, a dangling start. Runs are process state.

**Can agents talk to each other?** Yes, through the org. A note posted to
a running agent reaches the agent at the next turn. `org_ask` puts a question
to a teammate and waits for the answer. `org_running` and `org_trace` show
what others are doing as the work happens. `org_handoff` queues work for a
teammate. Every exchange is a ledger event with an author and a cost. What
agents cannot do is interrupt a turn in progress, share a context window, or
spend each other's money. See [collaboration](collaboration.md).

**Where does the suggested team come from?** Reflex's repeated workflows for
this repo, the session history in this directory, and the repository's
own files. No model is called. See [The suggested team](suggest.md).

**Is the ledger tamper-proof?** Tamper-evident. `verify()` detects any
edited, deleted or reordered entry and names the seq. The chain cannot stop
a person with write access from rewriting the whole file. That is why the
ledger belongs in git.

**How is CEO uninstalled?** `npm rm -g ceo-tui`. Alternatively, remove the symlinks
`install.sh` made. Each org's `.ceo/` directory stays until deleted by
hand. The registry is `~/.ceo/workspaces.json`.
