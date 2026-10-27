# Compared to

Tools that also run coding agents in parallel, and what CEO does that those
tools do not. Each of these tools is good at the job each was built for. The
comparison is about the job.

| | Runs agents in worktrees | Boards tasks | Agents on Claude, Codex and Gemini on one team, talking to each other | Permission levels enforced by the process | Tamper-evident record of cost and permissions | Budget caps that refuse a run |
| --- | --- | --- | --- | --- | --- | --- |
| **Conductor** (conductor.build) | yes, Claude Code | yes | no | no | no | no |
| **Crystal** | yes, Claude Code | yes | no | no | no | no |
| **Vibe Kanban** | yes | yes, as a kanban | several | no | no | no |
| **herdr** | tmux for agents, with a workspace sidebar and state detection | no | yes | no | no | no |
| **CEO** | yes, per agent, with provenance trailers on commits | as a ledger-backed queue with derived blocking | yes: notes between turns, live traces, questions that wait, handoffs, across all three | yes: allowlist on claude, sandbox on codex, read-only mode on gemini | yes: hash-chained ledger of every run, dollar, note and permission | yes, per agent, before any money is spent |

## What the difference buys

Conductor, Crystal and Vibe Kanban are built around watching agents work:
good diffs, good boards, good session switching. herdr is the tmux layer
for the same thing. None of the four keep a record that can be handed to
another person, saying what each agent cost, what the agent was permitted to
do when the agent produced a given commit, and whether the agent ever reached
past that. CEO's whole design is that record. The ledger is the authority.
Autonomy is a control applied by the child process. Budgets are gates.
Sub-cent spend is printed rather than rounded away.

The cost of that stance is that CEO is an executive's console, not a
developer's cockpit. CEO does not show diffs inline. CEO does not let a
person type into an agent's session. The run pane is a stream of what the
agent did rather than a conversation. Agents are hired, briefed, bounded and
audited. Doing the work by hand is what the other tools are for.

## Also related

- **Reflex**, by the same author, finds the workflows a person repeats across
  agent sessions and turns those workflows into skills. CEO reads Reflex's
  store to propose a team.
- **CEO-Bench**, from Princeton, is a benchmark of simulated companies, not a
  tool.
