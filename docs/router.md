# The router

The router decides which provider and model run a task. A task that names its
arms gets exactly those. Every other task is staffed from evidence.

## Arms

An arm is a provider and a model. An arm may also carry skills or docket items.
`codex gpt-5` is one arm. The same model with the `fix-flaky-test` skill is a
different arm, because the skill may change the result.

The router keeps a separate record per kind of work. The kinds are `review`,
`ci`, `debug`, `feature`, `edit`, `research` and `explore`. A task has a kind
when a person set the kind. Otherwise the kind comes from the words in the title.

## Evidence

Each finished attempt is one observation. The ledger holds the observations.

- The attempt passed when every required check passed.
- An attempt with no checks passed when the run finished.
- An attempt that failed counts as a fail.
- A cancelled attempt, a provider limit and a check that could not run say
  nothing about the arm. These are left out.

The cost of each attempt is read from the same events. The table shows the mean
cost of an attempt and the cost of each verified pass.

## Thompson sampling

For every candidate arm, the router draws one number between 0 and 1 from a Beta
distribution built from the arm's record. An arm with 8 passes in 8 attempts
draws near 0.9 almost every time. An arm with no record draws anywhere between 0
and 1. The arm with the best draw runs.

The effect is that strong arms win most of the time. Arms with thin records still
win now and then, and each win adds to the record. No exploration rate is set.
The shape of the record sets how much exploring happens.

The candidates are every ready provider with each of its models, the assignee's
own arm, and up to two skill variants of that arm. A skill variant is added when
a ready skill shares words with the task title.

An arm leans a little on the other arms of the same provider. A quarter of that
evidence is added to the arm's own record. A new model from a provider that
keeps failing starts low. A new model from a provider that keeps passing starts
high.

### Choosing several arms

A task with `samples` above one runs several attempts, each on its own arm.

- The best draw is the pick. The others are marked explore.
- Two ready providers always produce two providers in the set.
- With three or more attempts, one slot goes to the arm with the fewest
  observations on that kind.
- Draws within 0.02 of each other count as a tie. The cheaper arm wins the tie.

## The Reflex prior

When Reflex has scanned, the router also reads `~/.reflex/reflex.db`, or the
database under `REFLEX_HOME`. The database is opened read-only. A missing file or
a different schema leaves the router on the ledger alone.

Three tables are read.

- `route_runs` rows with an outcome of `done` or `not-done`.
- `bench_results` rows with a kind and a pass flag.
- `traces` rows with a verified flag. The kind comes from the first request, and
  the model is the one with the most usage.

Reflex's `claude-code` source maps to the `claude` provider. Reflex's `codex`
source maps to `codex`. One Reflex observation counts for half of a ledger
observation. The read is cached for 60 seconds.

## org_router

The chief of staff has an `org_router` tool. The input is a `kind`, a `task`
title or nothing. The output is the evidence table for the kind and the three arms
the router would pick next. Staffing follows this evidence. With no input the tool
returns the table for every kind.

## ceo router

```
ceo router              the evidence table for every kind
ceo router debug        the table for one kind
ceo router pick "Fix the crash in login" -n 3
```

The table has one row per arm. The columns are the kind, the arm, passes out of
attempts, the pass rate, the mean cost, the cost per verified pass and the source.
The source is `ceo`, `reflex` or `both`. The pass rate counts a Reflex observation
at half weight. The passes and attempts columns are plain counts.

`ceo router pick` prints the arms the router would choose for a title, each with
a mode and a reason such as `7 of 9 passed on debug` or `untried on review`. Each
run draws fresh numbers, so repeated runs can differ while the evidence is thin.
