---
description: Run the CEO-Auditor over recent delegations.
argument-hint: 'nothing, or a window like "last 50" or "today"'
---

Arguments: $ARGUMENTS

Plain English, not flags:

    /audit                  default window, last 20 delegations
    /audit last 50
    /audit today
    /audit the last few hours

Work out the window:

- a bare number means that many recent entries
- "today" means entries since local midnight
- "last N hours" means that many hours back
- nothing means the last 20 entries

Spawn the `ceo-auditor` subagent with the window in its prompt. It reads
the ledger, the roster, and the archived outputs, then writes its findings
via `ceo_write_audit`.

Print its summary verbatim. Do not editorialize on top of it, and do not
soften a finding. The auditor is deliberately blunt so that drift and bad
cross-references surface early. Re-wording that costs the signal.

If it reports zero findings, say so in one line. Zero findings is a real
result, not a failed audit.
