---
description: Remove an agent from the org.
argument-hint: 'name, and optionally why'
---

Arguments: $ARGUMENTS

Plain English, not flags:

    /fire scout
    /fire scout - kept drifting off its brief
    /fire builder, work is merged, delete the branch too

Pull out:

- **name**: the first bare token.
- **reason**: any prose after it. Strip a leading dash, comma, or colon.
  Omit when they gave none.
- **deleteBranch**: true only when they explicitly say delete the branch,
  drop the branch, or remove the worktree. Default false. Keeping the branch
  after firing is the safe choice, since unmerged work would otherwise be
  unrecoverable.

Before firing, call `ceo_unmerged` for that agent. If it has unmerged
commits, say so in one line with the count, and ask whether to merge first
or fire anyway. Do not fire on this pass. Losing unreviewed agent work
silently is the one mistake here that cannot be undone.

If it has no unmerged work, call `ceo_fire` and print the result verbatim.
