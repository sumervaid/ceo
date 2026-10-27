---
description: Set an agent's spend cap.
argument-hint: 'agent and an amount'
---

Arguments: $ARGUMENTS

Plain English:

    /budget scout 10
    /budget scout $10
    /budget give scout another 5
    /budget raise builder to 20

Pull out:

- **name**: the agent.
- **budgetUsd**: the new cap as a number. When they say "another N" or
  "add N", first call `ceo_roster` to read the current cap and add to it.
  When they say "to N" or give a bare figure, that is the new absolute cap.

If either is missing, ask in one line and stop.

Call `ceo_set_budget` and print the result verbatim.

Note that the cap is checked against spend already recorded in the ledger.
Lowering a cap below what an agent has already spent does not claw anything
back. It only refuses that agent's next delegation.
