---
description: Show recent ledger entries, or verify the hash chain.
argument-hint: 'nothing, a count, or "verify"'
---

Arguments: $ARGUMENTS

Plain English, not flags. All of these work:

    /ledger                 last 20 entries
    /ledger 50              last 50
    /ledger verify          check the hash chain
    /ledger last 10 and verify
    /ledger is it intact?   → treat as verify

Decide two things:

- **count**: any bare number is how many entries to show. Default 20.
- **verify**: true when they say verify, check, intact, tampered, valid,
  integrity, or ask a question about whether the chain is sound.

When showing entries, call `ceo_ledger_tail` with the count and print its
table verbatim.

When verifying, call `ceo_ledger_verify`. On a clean chain print one line:
the entry count and that the chain is intact. On a broken chain print the
reason verbatim and do not soften it. A broken chain means an entry was
edited, deleted, or reordered after it was written, and the accounting can
no longer be trusted. Say which seq broke and that the fix is to restore
`.ceo/ledger.jsonl` from git history.

When they ask for both, verify first, then show the entries.
