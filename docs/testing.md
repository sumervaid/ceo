# Testing

Nothing in this repository needs a real agent run. Every run bills the
signed-in account. The repo is built so that development, CI and manual
checks all cost $0.

## The stubs

Three stubs stand in for the agent CLIs. `tools/stub-claude` speaks the
stream-json protocol `claude -p` emits. `tools/stub-codex` speaks the JSONL
protocol `codex exec --json` emits. `tools/stub-gemini` speaks the
stream-json protocol `agy -p` emits. Point the runner at the stubs:

```sh
export CEO_CLAUDE_BIN=$PWD/tools/stub-claude CEO_CODEX_BIN=$PWD/tools/stub-codex CEO_GEMINI_BIN=$PWD/tools/stub-gemini
export CEO_HOME=/tmp/ceo-home CODEX_HOME=/tmp/codex-home       # keep the real registry and codex config separate
export CLAUDE_CODE_OAUTH_TOKEN=stub STUB_CODEX_LOGIN=chatgpt STUB_GEMINI_LOGIN=ok    # the setup gate sees all three as signed in
```

All three answer `--version` and the login check. `stub-codex` refuses to start
unless the flags CEO must pass, `exec --json --sandbox …` and
`-c approval_policy="never"`, are present. A regression in the plan fails
loudly.

| Variable | Effect |
| --- | --- |
| `STUB_TURNS` | assistant turns / command items (3) |
| `STUB_DELAY_MS` | per turn (300) |
| `STUB_NO_RESULT=1` | never settle, which exercises cancel and the estimate path |
| `STUB_DENY=Write` (claude) / `STUB_DENY=1` (codex) | one denial |
| `STUB_EXIT` | exit code |
| `STUB_CODEX_LOGIN` | `chatgpt` (default), `apikey`, `none` |
| `STUB_GEMINI_LOGIN` | `ok` (default), `none` |
| `STUB_CHAT` (claude) | a JSON script that plays a chief of staff, below |
| `STUB_SCRIPT` (all three) | a JSON script of org calls and lines during a run, in `tools/stub-org.mjs` |

`tools/stub-gh` answers every GitHub call CEO makes: the auth check, the
repo name, issue lists and views, pull request views and diffs, and `pr
create`. `CEO_GH_BIN` points at it. `STUB_GH_LOGIN=none` signs it out.
`STUB_GH_LOG` records each pull request with its body.
`CEO_HF_ENDPOINT=file://<dir>` reads the Hub's API paths from a directory.
`CEO_NOTIFY_BIN` replaces the desktop notifier. `CEO_REFLEX_BIN` replaces
Reflex. `integrations.spec.ts` uses all four, plus a local HTTP server in
place of Slack, and pushes a pull request's branch to a bare local remote.

`STUB_CHAT` names a file of entries such as
`{ "match": "review", "calls": [{ "tool": "org_hire", "args": {} }], "reply": "text" }`.
The first entry whose `match` appears in the operator's words runs. The
stub reads `--mcp-config`, starts the real org server over stdio, and
calls each tool in turn. The hires and tasks in a chat spec or a recording
are therefore real ledger events, made by the same server a real run uses.

`CEO_REQUIRE_STUBS=1` makes the runner refuse any binary not named
`stub-*`. Every spec and CI set that variable. The MCP SDK's stdio transport
passes a filtered environment to the servers the transport starts. A
filtered environment drops the `CEO_*_BIN` overrides. A test that starts a
server must pass `env: process.env` to the transport. The guard stays on as
the second line of defence.

## The specs

```sh
pnpm build && pnpm typecheck && pnpm test
```

`src/core/*.spec.ts` and `src/tui/smooth.spec.ts`, run by `node --test`
against real ledgers in temp directories:

| Spec | Covers |
| --- | --- |
| `tasks.spec.ts` | queue states, derived blocking, cost joined from the ledger |
| `workspaces.spec.ts` | the registry |
| `providers.spec.ts` | each provider's plan and parser, pricing, provider inference |
| `runner.spec.ts` | all three providers end to end through the stubs: cost basis, denials, cancel, missing binary, follow-up turns |
| `setup.spec.ts` | readiness: installed, signed in, metered, not installed |
| `suggest.spec.ts` | the history readers against fixture transcripts and a fixture Reflex store, and the proposal |
| `collab.spec.ts` | notes, handoffs, the from-the-org prompt, the `org` MCP server end to end over stdio, `org_ask` starting a child run, the depth guard, traces |
| `chat.spec.ts` | the chief of staff: hiring and rebuild, the read-only process, each staffing tool against level, cap and limit, a resumed session, the recap across providers, a scripted message that hires and delegates through the real server, the transcript rows |
| `roster.spec.ts` | moving an agent to another provider keeps the rest |
| `integrations.spec.ts` | the docket, GitHub through a stub gh, the Hub from a directory, skills and approval through Reflex, alerts to a local server, the chief's docket tools |
| `smooth.spec.ts` | Ink frames rewritten as overwrites in place inside synchronized output |
| `companies.spec.ts` | every company mixes providers, the fallback to a ready provider, the worktree modes and why one is impossible, hiring a company into a git repository, keeping existing seats, `i` on an existing agent |

## The dashboard

The TUI cannot be verified by reading the code. Drive the dashboard under a
real pty:

```sh
python3 tools/keydrive.py "<wait:2>h<wait:1>coder<tab>Implement what is queued.<tab><tab> <tab><tab><enter><wait:2><snap>" /tmp/fx 44 140
```

Tokens: `<tab> <stab> <enter> <esc> <up> <down> <left> <right> <ctrl-n>
<ctrl-p> <ctrl-l> <pgup> <pgdn> <wait:N> <snap>`. `<line:TEXT>` writes the
text and a newline in a single chunk, the way a paste arrives. The harness drains output continuously while sending keys. A harness
that does not drain starves the event loop and produces coalesced input that
looks like a key bug. The harness treats Ink's full-screen clear as a frame
boundary. A snapshot is one frame, not two merged. Use a throwaway fixture
directory with a dedicated org, never a repo with a real `.ceo/`.

## A real run, on request

The cheapest real check: a `scout` at `observe` with a $0.10 cap, asked to
"list the top-level directories and stop". On any provider the run costs a
fraction of a cent. The ledger shows the settled figure on claude. Codex
and gemini runs show an estimate. The task ends `done`. `ceo snapshot`
shows one line of history. One run is enough.

## CI

`.github/workflows/ci.yml` builds, typechecks, packs, runs the specs, then
drives the CLI through all three provider stubs. The smoke test covers
`ceo setup`, init, three hires with one per provider, the enforcement each
compile names, a delegation begin and end, a refused duplicate end, a
queued task, `ceo billing`, `ceo suggest` and a setup with no provider
ready. A second job validates the optional Claude Code companion plugin.

## The GIFs

Every GIF in the README is recorded, not captured, with
[VHS](https://github.com/charmbracelet/vhs). `tools/demo/fixture.sh` builds
a throwaway home with a small repository, synthetic codex and Claude Code
sessions, a Reflex store with one repeated workflow, and all three CLIs
stubbed. Nothing in a recording bills any account.

| GIF | Tape | Fixture | Shows |
| --- | --- | --- | --- |
| `hero.gif` | `hero.tape` | none | an empty directory, a company, a typed request, the live view |
| `company.gif` | `company.tape` | none | the company picker and the worktree choice |
| `chat.gif` | `chat.tape` | `chat` | the chief of staff hiring and delegating from a typed request |
| `live.gif` | `live.tape` | `team` | agents on three providers trading notes and a review |
| `suggest.gif` | `suggest.tape` | none | a seat from a Reflex workflow, with the evidence |
| `queue.gif` | `queue.tape` | none | delegate, queue, auto-dispatch, settled costs |
| `setup.gif` | `setup.tape` | none | `ceo setup` and `ceo company` |
| `collab.gif` | `collab.tape` | `org` | a note from the shell landing in a running agent |
| `docket.gif` | `docket.tape` | `team` | context and skills given agent by agent |
| `integrations.gif` | `integrations.tape` | `team` | GitHub, Hugging Face, alerts, an issue to the chief, a pull request |

```sh
brew install vhs
pnpm demo:all          # every GIF
pnpm demo:live         # a single GIF
```

The chief in the chat and live recordings is the claude stub reading a
`STUB_CHAT` script. The agents in the live recording follow a
`STUB_SCRIPT` script through `tools/stub-org.mjs`: each stub finds the org
server the run was given, then posts notes at set steps. The notes and the
hires are therefore real ledger events, made by the server a real run
uses. The tapes use `eval` rather than `source <(…)`, because macOS ships
bash 3.2, where sourcing a process substitution reads nothing.
