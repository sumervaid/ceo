# Money

CEO's reason to exist is a trustworthy record of what each agent cost. Four
rules protect that record.

## 1. Spend is recomputed, never counted

An agent's `spentUsd` is the sum of the agent's `delegate_end` costs, computed from
the ledger on every read. There is no counter to forget to increment and no
path where a lost write lets an agent overspend. The budget gate reads the
same sum.

## 2. Budgets are hard caps

A delegation to an agent at or past the agent's cap is refused before any
money is spent, whichever surface asked: the queue, `d`, auto-dispatch, `ceo
op`, the MCP tools. `0` means uncapped. `b` raises a cap and writes a
`budget_set` event. The queue unblocks without further action.

Caps are per agent. The most an org can spend is the sum of the caps. The
suggested team, `p`, proposes caps of a few runs at this repo's usual cost,
never above $25. The proposal says what a run really costs beside each cap.

## 3. Never $0 for a run that spent

| Case | What is recorded |
| --- | --- |
| claude run completes | the process's own `total_cost_usd`: settled, `costBasis: "settled"` |
| claude run cancelled or crashed before the result | the tokens that streamed, at list price. `costIsEstimate: true`, basis `anthropic-list-price`, plus a `cost_estimated` note |
| any codex run | the tokens the process reported, at list price with cached input at a tenth. `costIsEstimate: true`, basis `openai-list-price` |
| any gemini run | the tokens the process reported, at list price with cached input at a tenth. `costIsEstimate: true`, basis `google-list-price` |

The run pane says `est.` beside an estimated figure. A cancelled run's pane
says the money is spent and not refunded. Sub-cent spend prints with four
decimals everywhere, as in `$0.0046`, never as `$0.00`. A roster that
reads zero beside an agent that just spent half a cent is the understatement
the ledger exists to prevent.

## 4. Whose account

CEO stores no model-provider credential. `ceo setup` and `ceo billing` say
which account each provider draws on. A metered API key from Anthropic,
OpenAI or Google is a warning in yellow on the checklist and on the hire
form. A subscription and a per-token account feel the same until the
invoice.

On a subscription, a ChatGPT plan or a Google account the marginal dollar
cost of a run is zero. The ledger figure is what the tokens would have cost
at list price. That is still the right figure to gate on. List price is the
only figure that compares runs across providers. Plans also have limits
that list price tracks.

## Reading the numbers

- Roster: `$spent/$cap` per agent with a meter, red when over.
- Status bar: today's spend for this org and, with several workspaces, the
  total across all workspaces.
- Run pane: the settled line, with tokens in and out.
- `ceo json | jq .rollup`: today's total and per-agent breakdown.
- `jq 'select(.type=="delegate_end")' .ceo/ledger.jsonl`: every run.

## When a figure looks wrong

A figure that overstates is a pricing-table drift. Fix the rate in
`pricing.ts`. The estimate error was bounded and visible. A figure that
understates is treated as the most serious kind of bug. Open an issue with
the ledger tail.
