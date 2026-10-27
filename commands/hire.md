---
description: Hire an agent. With no arguments, proposes a team for this repo.
argument-hint: 'nothing, or a name and what they do'
---

Arguments: $ARGUMENTS

## When there are no arguments

Do not ask "what would you like to name your agent?". That is the blank page
this command exists to remove.

Instead, look at the repo and propose a starting team. Spend no more than a
few tool calls on this:

- Read the root listing, and `package.json` / `pyproject.toml` / `Cargo.toml`
  / `go.mod` if present, to learn the language and framework.
- Check whether a test suite exists and how it runs.
- Skim `git log --oneline -15` to see what kind of work actually happens here.
- Call `ceo_roster` so you do not propose someone already hired.

Then propose **three or four** agents, no more. For each one give:

- the name
- one line on what it does and why it fits *this* repo specifically
- the exact command to hire it

Ground every proposal in something you actually observed. "This repo has a
Vitest suite and 40% of recent commits touch tests, so a tester earns its
place" is useful. "Every team needs a tester" is filler and should not appear.

Draw on these starter roles, adapting the brief to what you found. They are
jobs, not personalities:

- **scout**: Survey the codebase and answer questions about how it is
  structured. Read widely before answering. Cite file paths and line numbers
  for every claim. When unsure, say so rather than guessing.
- **reviewer**: Read diffs and flag correctness bugs. Prioritise logic
  errors, unhandled edge cases, and broken assumptions over style. Give the
  file, the line, and a concrete failure scenario. Do not comment on
  formatting.
- **implementer**: Implement changes described in the task. Match the
  surrounding code's conventions. Make the smallest change that fully solves
  the problem. Do not refactor adjacent code unless asked.
- **tester**: Write and run tests for the described behaviour. Cover failure
  cases, not just the happy path. Run the suite and report actual output. If
  a test fails, report the failure rather than adjusting the test to pass.
- **researcher**: Research questions using web search. Cite a source URL for
  every factual claim. Distinguish what you verified from what you inferred.
- **documenter**: Write and update docs to match what the code actually
  does. Read the implementation before describing it. Prefer short concrete
  examples. Do not document intentions the code does not implement.

Suggest isolation for agents that write files: implementer, tester, and
documenter. Do not suggest it for read-only ones. Isolation means the agent
gets its own git worktree and branch. Explain isolation in one clause the
first time it appears: their changes land on a branch instead of your working
tree. Propose `observe` for the ones that only read, which are scout,
reviewer, and researcher. Leave the rest on the default.

End by offering to hire all of them in one go. Hire nothing until they say so.

## When there are arguments

Read them as plain English, not flags. All of these work:

    /hire scout who surveys the codebase and reports structure, read-only
    /hire builder to implement changes, isolated, $10 budget
    /hire analyst - runs numbers on research output, use opus
    /hire tester                      (a bare starter-role name)

Pull out:

- **name**: the first bare token, lowercased and slugified if needed. If you
  slugified it, say which slug you used.
- **role**: everything describing the job. Strip filler such as "who",
  "that", and "to", and any leading dash or colon. Rewrite into a clean
  imperative brief in second person. Keep their meaning. Add no duties they
  did not ask for. If they gave only a bare starter-role name from the list
  above, use that role's brief and say you did.
- **budgetUsd**: any dollar figure or a number that reads like money. Omit
  for the $5 default.
- **isolated**: true on isolated, own branch, own worktree, sandboxed,
  separate tree. Omit otherwise.
- **model**: only when named. Map a bare family name to its slug.
- **autonomy**: read-only, look but don't touch, and report only become
  `observe`. Propose only, draft, suggest, and no writes become `propose`.
  Can write and own branch become `execute`. Can merge on its own,
  unattended, and ships without me become `autonomous`. Omit when they said
  nothing. The default is `execute`, which keeps you in the merge path.
  Never infer `autonomous` from an enthusiastic brief. That one is only ever
  explicit.

A read-only role and a write level contradict each other. If they ask for a
reviewer that can merge on its own, hire it and say which of the two you
took as the real intent, in one line.

If the name is there but the job is genuinely unclear, ask for the job in one
line and stop. Do not invent a brief. A vague brief is the main cause of bad
agent output, and inventing one hides that cause from the person who could
fix it.

If the brief is under about 15 words, still hire, then note in one line that
thin briefs usually produce thin output and can be tightened by firing and
re-hiring.

Call `ceo_hire` once per agent. Print each result verbatim. It already
reports model, budget, and branch. On error print the error verbatim. It
names the fix.

Then one line per agent on what it may actually do, in plain terms, not the
level name:

- observe: reads and reports, cannot write files or run commands
- propose: reads and runs commands, hands back a diff you apply
- execute: writes in its own worktree, you merge
- autonomous: writes and merges to the base branch unattended

Change it later with `/autonomy <agent> <level>`.
