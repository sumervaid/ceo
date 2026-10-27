# The suggested team

<p align="center">
  <img src="suggest.gif" alt="The suggested team: a seat from a Reflex workflow with the evidence behind the seat, opened in the hire form" width="860">
</p>

The trigger is `p` in the dashboard or `ceo suggest` on the command line.
CEO proposes a team for this directory
with the evidence for every seat. Nothing is hired until a person confirms.
No model is called to make the proposal. The proposal is a deterministic
function of local files. The same repository and history always propose the
same team. Every line can be traced to the evidence that produced the line.

## Where seats come from

Three kinds of evidence, in the order of trust.

### 1. Reflex workflows

[Reflex](https://github.com/sumervaid/reflex-tui) scans Claude Code, Codex
and Cursor transcripts on the machine, redacts the transcripts, and finds
repeated workflows: the same kind of task in three or more independent
sessions, with the steps that worked and the corrections people kept giving.
CEO reads Reflex's store at `~/.reflex/reflex.db`, read-only, and turns each
repeated workflow into a seat:

| Reflex has | The seat gets |
| --- | --- |
| the request terms and description | a brief that opens "Handle requests about …" |
| consensus steps with ≥ 50% support | the steps, numbered, in the brief, with example commands |
| corrections (avoid / prefer) | guardrails: "Do not …", "Prefer …" |
| steps that modify files | `execute`, isolated, otherwise `propose` |
| median token mix per run | a cap of about three runs, never above $25 |
| confidence, instances, verified rate | the evidence lines |

Workflows seen in this repository come first. When the repository has none,
strong workflows from elsewhere are offered and labelled as such. Strong means
confidence ≥ 70%, usually verified, from a named repository. `--everywhere`
lifts the filter.

When Reflex has not scanned, the panel says so. `s` runs the scan right
there. That is `reflex scan --days 30 --yes`, Reflex's own command, reading and
redacting locally and writing only under `~/.reflex`. The panel shows the
scan's progress and re-reads the proposal when the scan finishes. `s` is also
a rescan when the store is older than the org's recent runs. From the command
line, `ceo suggest --scan` does the same first. `ceo setup` lists Reflex as an
optional row with the scan age.

```sh
npm i -g reflex-skills       # once; then s in the panel, or ceo suggest --scan
```

**The loop.** Agents on claude and codex run as `claude -p` and `codex
exec` sessions. Those sessions leave transcripts where Reflex reads. The
org's own runs become Reflex history. Reflex does not read gemini
transcripts yet. Reflex finds what the org keeps doing. The next `p` proposes
a seat for that workflow, with the steps that worked and the corrections
that were needed. An org that has run for a week proposes the org's own next
hire.

### 2. Session history

Which models have run in this directory, how often those sessions ended with
a passing check, what a session here tends to cost, and what people asked
for. Read from Reflex's traces when Reflex has traces, and directly from
`$CODEX_HOME/sessions` rollouts and `~/.claude/projects/<dir>` transcripts
otherwise, over the last 60 days, bounded. The direct readers are shallow on
purpose: first requests, model, tokens, counts. Reflex does the analysis.
CEO reads the result.

The most-used model wins. The provider follows the model, unless another
model has three or more sessions here and a clearly better verified rate. In
that case the evidence line says so. The usual cost of a session here sets
the budgets.

### 3. The repository

Manifest, test runner, lint, build, CI, docs, commit count. These decide
which standard roles earn a seat. The repo's own commands go into those
briefs, such as "tests run with `pnpm test`":

| Seat | When |
| --- | --- |
| scout | always. Everything else works better against an accurate map |
| implementer | there is a manifest (package.json, pyproject, Cargo.toml, go.mod) |
| tester | there is a test command or directory |
| reviewer | CI is configured, or ten or more commits |
| documenter | there are docs and a manifest |

## Reading a seat

```
fix-flaky-test               codex gpt-5-codex · execute · isolated · $4 cap
    Handle requests about retry, flaky, test.
    · Reflex: repeated in 4 independent sessions across 2 repositories, including this one; confidence 80% …
    · 75% of those sessions ended with a passing check
    · median 12 tool calls and ~$1.10 per run on gpt-5-codex
    · 2 guardrails from corrections people gave in those sessions
    · gpt-5-codex: used in 3 of 4 sessions here; a session here costs about $1.10 at list price
    · autonomy execute: the workflow changes files, so the agent works on a branch for a human to merge
    guardrails: Do not adjust the test to pass / Prefer pnpm over npm
```

Every line is checkable: the Reflex workflow by `reflex show
fix-flaky-test`, the sessions by `reflex sessions`, the cost by the pricing
table, the repo facts by looking.

## Hiring from the panel

- `enter` on a seat opens the hire form with every field filled: name,
  brief, collaboration, provider, model, budget, autonomy, isolated, and the
  guardrails attached. Read the brief, change what needs changing, hire.
- `H` hires every seat as proposed. Names already in the org are suffixed.
- `ceo suggest --hire` does the same from the command line and creates the
  org if there is none.
- In the hire form, ↑↓ on the role field cycles the suggested seats before
  the built-in templates. Typing a seat's name fills the form from the seat.

## What the panel is not

Not a model's opinion of the codebase. The Claude Code companion's `/hire`
with no arguments does that: the command reads the repo in a session and
proposes a team in prose. `p` is the other thing, the evidence-first proposal
from what already happened here. The proposal costs nothing to look at.
