# Keys

Every key in the dashboard. `?` shows the same list inside the dashboard.
While a dialog is open, only the dialog's own keys apply. `esc` closes the
dialog.

## Moving around

| Key | Does |
| --- | --- |
| `tab` | Move focus: workspaces, then roster, then queue. |
| `↑` `↓` / `j` `k` | Select in the focused panel. |
| `[` `]` | Previous / next workspace. |
| `w` | Manage workspaces: add a directory, remove one. |
| `W` | Pin the sidebar open even with one workspace. |
| `enter` | Roster: open the agent's detail view. Queue: run the selected task. |
| `esc` | Cancel a live run, dismiss a finished one, close what is open, back out of the detail view. |
| `r` | Refresh now. The dashboard also watches `.ceo/` and polls every 2 s. |
| `?` | Keys. |
| `q` | Quit. Armed twice when runs are in flight. `ctrl-b d` detaches tmux and keeps the runs alive. |

## The org

| Key | Does | Writes |
| --- | --- | --- |
| `n` | Start an org in this directory. Shown when there is none. | `org_init` |
| `p` | Suggested team: Reflex workflows, session history and the repo. `enter` edits and hires one, `H` hires all. | `hire` per seat |
| `h` | Hire by hand. ↑↓ on the role field cycles presets, including the suggested seats. | `hire` |
| `f` | Fire the selected agent. Offers to delete the agent's branch. | `fire` |
| `b` | Set the selected agent's budget cap. On the chief of staff, set the allowance the chief may give out. | `budget_set` |
| `y` | Cycle the selected agent's autonomy: observe, propose, execute, autonomous, in that order. | `autonomy_set` |
| `v` | Switch the selected agent's provider: claude, codex, gemini. The brief, budget, level and history stay. The model becomes the provider's default unless the current model already fits. | `agent_config` |
| `C` | Open the chat with the chief of staff. The first time, hires a chief with the defaults. | `hire` |
| `D` | The docket: give each agent files, issues, Hugging Face cards, pages, notes and skills. See [the docket](docket.md). | `context_*` |
| `I` | Integrations: GitHub, Hugging Face, alerts and Reflex skills. See [integrations](integrations.md). | none |
| `P` | Push the selected agent's branch and open a pull request with the ledger's account. | `note` of kind `pr` |
| `L` | The live view: a column per provider, a card per agent, and the exchanges between agents. `C` there opens the chat. `esc` returns. | none |
| `+` | Start a company: the picker of ready-made teams. `enter` hires one and opens the chat. On a directory with no org, `n` opens the same picker. | `hire` per seat, `note` |
| `i` | Give the selected agent a git worktree and branch `ceo/<name>`. Needs a repository with a commit. | `worktree_provision` |
| `m` | Merge the selected agent's branch into the base branch. Conflicts are listed, not resolved. | `worktree_merge` |
| `M` | Edit the org's mission: objective, success criteria, org-wide guardrails. | `mission_set` |
| `S` | Setup: are claude, codex and gemini installed and signed in. `c`, `x` and `g` open a login. `r` re-checks. | nothing |
| `a` | Where audits run. The CEO-Auditor needs the Claude Code companion. | nothing |

## Work

| Key | Does | Writes |
| --- | --- | --- |
| `t` | Queue a task for the selected agent. | `task_add` |
| `e` | Edit the selected task: title, assignee, priority. | `task_update` |
| `x` | Cancel the selected task. | `task_update` |
| `u` | Requeue a settled task. | `task_update` |
| `enter` (queue) | Run the selected queued task. | `delegate_start`, then `delegate_end` |
| `d` | Delegate now: queue a task and run the task in one step. **Spends money.** | `task_add`, `delegate_start`, `delegate_end` |
| `R` | Dispatch: every idle agent in this workspace picks up the next queued task. | per task |
| `A` | Auto-dispatch on/off, across every registered workspace. Inverse yellow in the status bar while on. | per task |
| `c` | Cancel the run on screen. What the run spent is recorded. | `delegate_end` (estimate) |
| `n` `N` | Next / previous run in the run pane, when several are in flight. | nothing |
| `o` | A tmux window with a shell in the selected agent's worktree, or the repo root. | nothing |

## In the hire form

| Key | Does |
| --- | --- |
| `tab` / `shift-tab` | Next / previous field. |
| `↑` `↓` (role) | Cycle presets: suggested seats first, then scout · reviewer · implementer · tester · researcher · documenter. |
| `space` `←` `→` (provider) | Cycle claude, codex and gemini. |
| `↑` `↓` (model) | Cycle the provider's known models, or type any id. |
| `space` (autonomy) | Cycle the level. |
| `space` (isolated) | Toggle. |
| `enter` | Hire. Blocked, with the reason in red, when the provider is not ready. |
| `esc` | Cancel. |

## In the company picker

| Key | Does |
| --- | --- |
| `↑` `↓` `1`–`6` | Pick a company. The seats below update. |
| `w` | Cycle worktrees: each writer, every agent, nobody. |
| `enter` | Hire the company and open the chat. |
| `esc` | Close. On a new org, leaves the org empty. |

See [companies](companies.md).

## In the chat

| Key | Does |
| --- | --- |
| `enter` | Send the message. Refused while the chief is replying. The draft stays. |
| `↑` `↓` `pgup` `pgdn` | Scroll the conversation. |
| `ctrl-n` | A new conversation. The next message opens a fresh session. |
| `ctrl-p` | Move the chief to the next provider. The next message carries a recap. |
| `ctrl-l` | Cycle the chief's level, which decides what the chief may do to the org. |
| `esc` | Back to the dashboard, with the draft kept. |

See [chat](chat.md).

## In the suggest panel

| Key | Does |
| --- | --- |
| `↑` `↓` | Select a seat. The evidence for the seat is shown below. |
| `enter` | Open the hire form filled from the seat, to edit and hire. |
| `H` | Hire every seat as proposed. |
| `s` | Run `reflex scan`, or rescan, and re-read the proposal when the scan finishes. |
| `esc` | Close. |
