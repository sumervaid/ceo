# tools

Verification at $0. Nothing here calls a model vendor, GitHub or the
Hugging Face Hub.

## Stub CLIs

Each stub speaks the real CLI's protocol. The runner cannot tell the
difference. `CEO_REQUIRE_STUBS=1` makes the runner refuse anything else.

- `stub-claude`: a fake `claude` that speaks the stream-json line protocol.
  `CEO_CLAUDE_BIN` points at the stub. Env: `STUB_TURNS`, default 3.
  `STUB_DELAY_MS`, default 300. `STUB_NO_RESULT=1` never settles, for cancel
  paths. `STUB_DENY=Write` emits a permission denial. `STUB_EXIT` sets the
  exit code. `STUB_CHAT` plays a chief of staff from a script.
- `stub-codex`: a fake `codex` that speaks the `codex exec --json` JSONL
  protocol. The stub emits token usage, never a dollar figure.
  `CEO_CODEX_BIN` points at the stub. The stub refuses to start without the
  flags CEO must pass, `exec --json --sandbox …` and
  `-c approval_policy="never"`. A regression in the plan therefore fails
  loudly. `STUB_DENY=1` denies the last command in the sandbox.
- `stub-gemini`: a fake `agy` that speaks the `agy -p --output-format
  stream-json` protocol. `CEO_GEMINI_BIN` points at the stub. The stub
  answers `--version` and `models` for the setup check.
  `STUB_GEMINI_LOGIN=none` signs the stub out.
- `stub-docker`: a fake `docker` for the sandbox. It answers `version`,
  `image inspect` and `rm -f`. For `run` it refuses a call without `--rm` or
  a `-v <host>:/work` mount, then runs the inner command on this machine in
  the mounted host directory. The names `claude`, `codex` and `agy` map to
  the stub CLIs. `CEO_DOCKER_BIN` points at the stub. `STUB_DOCKER_LOG`
  appends one JSON line per call. `STUB_DOCKER_DOWN=1` fails `version`.
  `STUB_DOCKER_NO_IMAGE=1` fails `image inspect`.
- `stub-org.mjs`: shared by the three stubs. `STUB_SCRIPT` names a JSON file
  of org calls. A stub plays those calls against the real org server during
  a run. Every note, handoff and hire is then a real ledger event.
- `stub-gh`: a fake `gh` with a small set of issues and a pull request flow.
  `CEO_GH_BIN` points at the stub. `STUB_GH_LOGIN=none` signs the stub out.
  `STUB_GH_LOG` records each pull request body.
- `stub-everval`: a fake `everval` that imports JSON collections, hands out
  a collection hash and grades a submission bundle. `CEO_EVERVAL_BIN` points
  at the stub. The stub fails without `EVERVAL_DATA_DIR`. `STUB_EVERVAL_ERROR=1`
  returns errored trials. `STUB_EVERVAL_LOG` records each call. The grading
  rules are in the stub's header.

## Driving the dashboard

`keydrive.py` drives the dashboard under a real pty and drains output
continuously:

```
python3 tools/keydrive.py "<tab>R<wait:2><snap>" /path/to/repo [rows] [cols]
```

Tokens: `<tab> <stab> <enter> <esc> <up> <down> <left> <right> <ctrl-n>
<ctrl-p> <ctrl-l> <pgup> <pgdn> <line:TEXT> <wait:N> <snap> <sh:command>`.
Set `CEO_HOME` to a throwaway directory first.

## Recordings

`demo/fixture.sh` builds the world the README's GIFs are recorded in: a
small repo, past sessions, a Reflex store, a local Hugging Face hub and the
stubs. Everything lands under `/tmp/ceo-demo`. Each `demo/*.tape` is one
GIF, recorded with VHS. `pnpm demo:all` records every one.

## Specs

`pnpm test` runs every `*.spec.ts` under `src/`. `runner.spec.ts` runs the
runner end to end against the stubs through a real ledger in a temp dir.
