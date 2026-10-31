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
| `V` | Approvals: merges and outward actions waiting on a decision, with the evidence behind each. The status bar shows the count waiting. See [judges and gates](gates.md). | `approval_decide` |
| `L` | The live view: a column per provider, a card per agent, and the exchanges between agents. `C` there opens the chat. `O` switches to the constellation. `esc` returns. | none |
| `O` | The constellation: the chief of staff a black hole, every agent a star, every note a comet. `←` `→` select a star, `enter` opens the agent, `0` to `6` and `[` `]` choose a layout, `L` switches to the cards, `C` opens the chat, `esc` returns. See [the constellation](sky.md). | none |
| `+` | Start a company: the picker of ready-made teams. `enter` hires one and opens the chat. On a directory with no org, `n` opens the same picker. | `hire` per seat, `note` |
| `i` | Give the selected agent a git worktree and branch `ceo/<name>`. Needs a repository with a commit. | `worktree_provision` |
| `m` | Merge the selected agent's branch into the base branch. Conflicts are listed, not resolved. | `worktree_merge` |
| `M` | Edit the org's mission: objective, success criteria, org-wide guardrails. | `mission_set` |
| `S` | Setup: are claude, codex and gemini installed and signed in. `c`, `x` and `g` open a login. `r` re-checks. | nothing |
| `a` | Where audits run. The CEO-Auditor needs the Claude Code companion. | nothing |

## Work

| Key | Does | Writes |
| --- | --- | --- |
| `t` | Queue a task for the selected agent. The form has fields for checks and attempts. | `task_add` |
| `e` | Edit the selected task: title, assignee, priority, checks, attempts. | `task_update` |
| `x` | Cancel the selected task. | `task_update` |
| `u` | Requeue a settled task. | `task_update` |
| `enter` (queue) | Run the selected queued task. A task with checks or several attempts runs as attempts. | `delegate_start`, then `delegate_end`; `attempt_start`, `attempt_end`, `verify` and `promote` for attempts |
| `d` | Delegate now: queue a task and run the task in one step. **Spends money.** | `task_add`, `delegate_start`, `delegate_end` |
| `R` | Dispatch: every idle agent in this workspace picks up the next queued task. | per task |
| `A` | Auto-dispatch on/off, across every registered workspace. Inverse yellow in the status bar while on. | per task |
| `c` | Cancel the run on screen. What the run spent is recorded. | `delegate_end` (estimate) |
| `n` `N` | Next / previous run in the run pane, when several are in flight. | nothing |
| `o` | A tmux window with a shell in the selected agent's worktree, or the repo root. | nothing |

## In the task form

| Key | Does |
| --- | --- |
| `tab` / `shift-tab` | Next / previous field: task, assignee, priority, checks, attempts. |
| `↑` `↓` (assignee, priority) | Cycle the value. |
| text (checks) | Checks separated by `;`. A command, `everval:<file>#<scenario>` or `judge:<rubric>`. Empty means no check. |
| `↑` `↓` (attempts) | Cycle 1, 2, 3, 4, 5, 6 or 8. More than 1 runs the attempts across the router's arms, one worktree each. |
| `enter` | Save. Blocked until the task has a title. |
| `esc` | Cancel. |

A queue row shows `×n` for the attempts and `⚖n` for the checks. A task that
won shows the winning arm. See [verification](verification.md) and
[the queue](queue.md).

## In the approvals list

| Key | Does |
| --- | --- |
| `↑` `↓` / `j` `k` | Select a request. The verdict, each check and each judge's vote show below the request. |
| `a` | Approve. A merge runs now. |
| `x` | Deny. |
| `esc` | Close. |

See [judges and gates](gates.md).

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
| `←` `→` | Team size: 1 to 5, then 8, 10, 12, 16, 20, 25, 30, 40, 50. Each seat becomes that many agents. |
| `w` | Cycle worktrees: each writer, every agent, nobody. |
| `enter` | Hire the company and open the chat. |
| `esc` | Close. On a new org, leaves the org empty. |

See [companies](companies.md).

## In the constellation

| Key | Does |
| --- | --- |
| `←` `→` | Select the next or the previous star, clockwise from the top. |
| `enter` | Open the selected agent's detail view. |
| `L` | Switch to the cards in the live view. |
| `C` | Open the chat with the chief of staff. |
| `esc` `O` | Back to the dashboard. |

See [the constellation](sky.md).

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
