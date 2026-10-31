# CEO documentation

CEO runs agents on Claude, Codex and Gemini as one team from one terminal.
The agents work with each other across the provider line. A
tamper-evident ledger records every exchange. These pages are the long form.
The [README](../README.md) is the short one.

## Start here

| Page | Read when |
| --- | --- |
| [Getting started](getting-started.md) | The goal is an org running within ten minutes. |
| [Setup and accounts](setup.md) | `ceo setup` says a provider is not ready. Also for the question of which account a run bills. |
| [The suggested team](suggest.md) | `p` proposed a team. The question is where the proposal came from. |
| [Companies](companies.md) | A whole team should exist in ten seconds, with or without worktrees. |
| [The docket](docket.md) | Each agent should get its own files, issues, model cards, notes and skills. |
| [Integrations](integrations.md) | GitHub issues and pull requests, Hugging Face cards, alerts. |
| [Chat](chat.md) | A sentence to the chief of staff should become a staffed team. |
| [Collaboration](collaboration.md) | Agents should read each other's traces, pass notes mid-task, ask and answer, hand work off. |
| [The constellation](sky.md) | The org should read as a sky: the chief of staff a black hole, every agent a star, every note a comet. |
| [Swarms and limits](swarms.md) | Many copies of one agent should work at once. Also for what a provider limit does to a run. |
| [Verification](verification.md) | A task should count as done only when a check passes. Also for the mission's checks and for Everval. |
| [The router](router.md) | Staffing should follow which provider and model won this kind of work. |
| [Sandboxes](sandboxes.md) | A run should happen in a container that is discarded when the process exits. |
| [Keys](keys.md) | Every key in the dashboard, by panel. |
| [Command line](cli.md) | Every `ceo` subcommand, with examples. |

## Concepts

| Page | Explains |
| --- | --- |
| [Concepts](concepts.md) | Org, agent, provider, autonomy, delegation, task, workspace, ledger, turn, note, trace: the eleven words. |
| [Providers](providers.md) | How a run happens on claude, codex and gemini. What each provider can and cannot promise. |
| [Autonomy](autonomy.md) | The four levels, what each enforces on each provider, and how to pick one. |
| [The queue](queue.md) | Tasks as ledger objects, derived blocking, the dispatcher. |
| [The ledger](ledger.md) | Every event type with the fields of each, the hash chain, what `verify()` catches. |
| [Money](money.md) | Settled cost, estimates, budgets as hard caps, what sub-cent spend looks like. |
| [Judges and gates](gates.md) | Judges that vote, the merge rule, approval requests, the auto-merge setting. |
| [Outcomes](outcomes.md) | Verified results as the budget unit, dollars per verified outcome, how workspaces share dispatch slots. |

## Working on CEO

| Page | Explains |
| --- | --- |
| [Testing](testing.md) | How to verify every part for $0: the stubs, the specs, the pty harness. |
| [Architecture](../ARCHITECTURE.md) | Modules, the five invariants, provider facts, known limits. |
| [Design](DESIGN.md) | The four decisions that shape everything else. |
| [Troubleshooting](troubleshooting.md) | The error on screen and the meaning of each. |
| [FAQ](faq.md) | Questions that come up. |
| [Compared to](comparison.md) | Conductor, Crystal, Vibe Kanban, herdr, and the reason CEO exists beside those tools. |
| [Contributing](../CONTRIBUTING.md) | The one rule, and how to send a change. |
