# Verification

A verifier is a check that decides whether work was done. A task carries
verifiers. A mission carries checks. Every result is a `verify` event in the
ledger, with the status, the score and the evidence behind the verdict.

Three statuses exist. `pass` and `fail` are verdicts on the work. `error`
means the check could not run: a missing binary, a timeout, a collection that
does not load. An error is never read as a pass. An error is never read as a
fail of the work either.

## Verifiers

A verifier is written as short text. `ceo verify` and `ceo mission checks
add` read the same text.

| Text | Kind |
| --- | --- |
| `npm test` | command |
| `everval:evals/retry.json#flaky` | everval |
| `judge:the fix is minimal` | judge |

### Command

A command runs in the working directory. Exit code 0 passes. Any other exit
code fails. A command that cannot start, or that runs past its timeout, is an
error. The timeout is 600 seconds unless `timeoutSec` is set.

### Everval

An everval verifier grades an Everval collection against the work. The
collection is a JSON or YAML file in the project. The text after `#` names
the scenario. A collection with one scenario needs no name. A collection with
several scenarios and no name is an error that lists the scenarios.

Each check runs this recipe.

1. `everval collections import <file>` loads the collection. The collection
   id is cached in `.ceo/everval.json`, keyed by the file's sha256. A second
   check on the same file skips the import. An edited file imports again.
2. `everval collections tasks <id> --output <file>` yields the collection
   hash.
3. A submission bundle holds the output for the scenario. `everval
   import-results <bundle>` grades the bundle in place and prints the
   experiment as JSON.

The experiment decides the verdict. A low score exits 0, so the exit code is
never read. A trial that passed is `pass`. A trial that was graded and did not
pass is `fail`, and the score is the trial's score. A trial with status
`error`, or an experiment with status `failed`, is `error`.

The evidence in the ledger holds the experiment id, the snapshot hash, the
collection id and hash, and the failing checks with their messages.

#### The graded output

By default the output is the work's changed files, read as `{path: content}`.
For an attempt, the changes are measured against the commit the attempt
started from. Untracked files count. Binary files and files over 200 KB are
skipped. At most 200 files are read. Coding collections grade this object in
Docker.

A spec can name a command instead. The command runs in the working directory
and prints a JSON object on stdout. That object is the output. Checks in the
collection read the object by dotted path.

#### Where Everval keeps its data

Calls set `EVERVAL_DATA_DIR` to `<project>/.ceo/everval`. Runs from CEO never
mix with experiments made by hand.

#### Binary and test double

The binary is `everval`, or the path in `CEO_EVERVAL_BIN`. `tools/stub-everval`
is a local stand-in for tests. The header of the stub states the grading
rules.

## Mission checks

A mission can carry checks: the success criteria as commands a machine can
run. The mission is met when every required check passes.

```sh
ceo mission checks add "npm test"
ceo mission checks add "everval:evals/retry.json#flaky"
ceo mission checks            # each check with the result of its last run
ceo mission check             # run every check; exit 1 unless the mission is met
```

Checks are stored in the `mission_set` event, so the checks at any point in
history can be replayed. Setting a new objective keeps the checks.

Each run writes `verify` events with scope `mission`. The status of a check is
its latest event. A check never run shows as unknown. The mission panel in the
dashboard shows one mark per check.

| Mark | Meaning |
| --- | --- |
| ✓ | passed |
| ✗ | failed |
| ! | could not run |
| · | not run yet |

## One check, now

```sh
ceo verify "npm test"
ceo verify "everval:evals/retry.json#flaky" --in .ceo/worktrees/fixer--a1b2
```

`ceo verify` runs one check and prints the result. The default directory is
the current one. `--in` names another, such as an attempt's worktree. The
result is recorded with scope `task` and no task. The exit code is 1 unless
the check passes.

## Judges

Judges are agents at observe on other providers that vote.
