---
description: Show the org: autonomy, spend against budget, model, branch, role.
argument-hint: ''
---

Call the `ceo_roster` MCP tool and print its output verbatim. It is already
a formatted table. Do not reflow it, re-align it, or convert it to markdown.

The table carries each agent's autonomy level. If the output does not show
one per agent, add a single line underneath in the form `agent: level,
agent: level`. Take each level from the `autonomy:<level>` section that
`ceo_compiled_prompt` reports for that agent. Do not expand it into a second
table, and do not gloss what the levels mean here. `/autonomy` with no
arguments is where that belongs.

Then call `ceo_status` and print that line underneath.

If the org is empty, `ceo_roster` says so in one line. Print that and stop.
If either tool errors because no org exists, print the error verbatim. The
error names the fix.

No headings, no commentary on who looks expensive or who looks
over-permissioned. The table is the answer.
