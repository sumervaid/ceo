# Autonomy

What an agent may do without a human in the loop. Four levels, each a
control applied by the child process. Lowering an agent's level removes the
agent's ability to act. The level does not ask the agent to behave.

| Level | May | claude: `--allowed-tools` | codex: `--sandbox` | gemini: `--mode` | Merge |
| --- | --- | --- | --- | --- | --- |
| `observe` | read and report | Read, Grep, Glob, WebFetch, WebSearch | read-only | plan | no |
| `propose` | read, run commands, draft a change as a diff | + Bash | read-only | plan | no |
| `execute` | write files on the agent's own branch, then a human merges | + Write, Edit, NotebookEdit | workspace-write | accept-edits | no |
| `autonomous` | write and land the agent's own work | same as execute | workspace-write | accept-edits | yes |

## Reading the table

`propose` includes Bash on claude because proposing a real change often
means running the tests to know the change is sound. The absence of write
tools is what makes the level meaningful: the agent can prove a diff would
pass and still cannot apply the diff.

On codex the two read-only levels collapse to one sandbox, because codex
cannot grant "run commands but do not write" more finely than a read-only
filesystem. The compiled prompt still differs: an `observe` agent is told to
describe the intended change and stop. A `propose` agent is told to produce
the exact diff. The sandbox stops the write either way.

`autonomous` differs from `execute` only in merge rights. CEO holds merge
rights, not the process. The sandbox and allowlist are the same. What changes
is that no human reviews before the branch lands. The prompt says so: the bar
for "finished" is higher.

On gemini the two read-only levels share `--mode plan`, the Antigravity
CLI's read-only mode. The two writing levels share `--mode accept-edits`,
which approves file edits. Shell commands still need an approval that no
human can give in headless mode. Those commands are refused and show as
denials. Commands an org wants allowed go in the CLI's own
`permissions.allow` rules.

## Choosing a level

Start one level lower than seems necessary. An `observe` scout costs cents.
The first run shows whether the brief produces useful work. `y` on the
roster raises the level. The key cycles the level. Each press writes an
`autonomy_set` event. The ledger then records what the agent was permitted
to do at every point in the agent's history.

Give `execute` to agents that also get `isolated`. A non-isolated `execute`
agent writes in the shared working tree. The hire form says so in plain
words.

Give `autonomous` rarely, and never by default. The core defaults to
`execute` for exactly this reason: unattended merge rights by omission is the
one mistake the defaults must not make.

## What a denial looks like

An agent reaching past the permitted level is the most important thing the
run pane can show. The attempt appears in red as the attempt happens. A
banner counts the attempts. The ledger gets a `permission_denied` note naming
the provider, the level and the tools tried:

```json
{"type":"note","agent":"reader","data":{"kind":"permission_denied","provider":"claude","tools":["Write"],"autonomy":"observe","delegationId":"3f9a1c"}}
```

A denial is not an error. The run completes. The cost settles. The task is
done or failed on the task's own merits. The denial is a fact about the
brief: the agent thought the task needed a tool the level forbids. The
fault lies in the brief or in the level. The auditor reads these notes to say which.

## The prompt's part

Every compiled prompt ends with a "What you may do" section stating the level
in words, and then the guardrails. Instructions nearest the end of a prompt
carry the most weight. The wording is there so the agent plans within the
permitted limits. The wording is not what holds the line. A permission
enforced only by asking is a bug. `ARCHITECTURE.md` lists that rule as the fourth
of five invariants.
