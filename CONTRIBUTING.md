# Contributing

## The one rule

Read `ARCHITECTURE.md` before touching `src/core/`. That document lists five
invariants about the ledger. Breaking an invariant does not fail a test. The
break silently corrupts the record the whole tool exists to keep. If a change
needs to bend an invariant, open an issue first. Say which invariant and why.

## Testing never calls a model

Every agent run bills the account signed in to `claude`, `codex` or `agy`.
Nothing in development needs a real run:

- `tools/stub-claude`, `tools/stub-codex` and `tools/stub-gemini` speak each
  CLI's line protocol. `CEO_CLAUDE_BIN`, `CEO_CODEX_BIN` and `CEO_GEMINI_BIN`
  point the runner at the stubs. The runner, the ledger, denials, estimates
  and cancellation all run for free. `STUB_NO_RESULT=1` never settles. That
  path covers cancel and estimate. `STUB_DENY` emits a denial.
- `tools/stub-org.mjs` lets any stub call the real org server from a
  `STUB_SCRIPT`. Notes, handoffs and hires then run end to end.
- `tools/stub-gh` stands in for the `gh` CLI through `CEO_GH_BIN`.
- `CODEX_HOME=/tmp/somewhere` keeps the codex default-model lookup and
  `codex login status` off the real codex config.
- `tools/keydrive.py` drives the standalone Ink dashboard under a real pty,
  draining output continuously. A harness that does not drain starves the
  event loop and produces coalesced input that looks exactly like a key bug.
- `CEO_HOME=/tmp/somewhere` keeps the workspace registry off the real one.
- `claude plugin validate .` checks the optional companion plugin's manifest.

Set `CEO_REQUIRE_STUBS=1` in any test that starts a run. Pass
`env: process.env` to an MCP stdio transport. The SDK filters the
environment by default. A filtered environment drops the stub variables.
The real CLI then runs.

When a real run is genuinely needed for verification, say so in the PR. Use
the cheapest prompt possible.

## Layout

```
src/core/     stable API, no UI; the ledger, roster, tasks, autonomy, providers, runner
src/mcp/      the MCP server the companion plugin's slash commands call
src/tui/      the Ink dashboard
src/bridge.ts `ceo json` and `ceo op`: the machine interface, for scripts and CI
hooks/        the companion plugin's read-only shell hooks
commands/     slash commands, markdown prompts that parse prose rather than flags
agents/       the CEO-Auditor and CEO-Postmortem subagent definitions
tools/        the CLI stubs, the pty harness and the demo fixture
docs/         the wiki; a user-facing change updates the matching page
```

A provider-specific flag or output shape belongs in `src/core/providers.ts`
and nowhere else. The runner knows no CLI by name.

Four things write to `.ceo/`: the MCP servers, the dashboard's `actions.ts`
and `runs.ts`, `src/bridge.ts`, and the `ceo` CLI. All four go through core
functions that call `ledger.append()`. That call takes the lock. No other
code writes there.

## Style

Code reads like the surrounding code. Comments explain why, at the density
the file already has. Terminal output is terse: one line where one line does,
no banners. Money under a cent prints with four decimals. A run that spent
money never prints `$0.00`.

## Before a PR

```
pnpm build && pnpm typecheck && pnpm test
claude plugin validate .
```

A user-facing change updates `docs/` and `CHANGELOG.md` in the same PR.

Describe what was verified and how. "Drove the dashboard under the pty harness, 80x24
and 120x40" is a verification. "Should work" is not.

## Releasing

```
# bump version in package.json and .claude-plugin/plugin.json and marketplace.json; add the CHANGELOG entry
git commit -am "0.4.0" && git tag v0.4.0 && git push && git push --tags
```

`.github/workflows/release.yml` checks the tag matches `package.json`, runs
`prepublishOnly`, which builds, typechecks and runs the specs, and publishes `ceo-tui` with the
`NPM_TOKEN` secret. `npm pack --dry-run` shows what ships: `dist/`, the
stubs, the companion plugin files, the README, CHANGELOG and LICENSE.
