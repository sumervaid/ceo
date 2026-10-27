# CEO hooks and status line

Four shell scripts give the org a presence in the session without
anyone having to type a command. They are a banner when the session opens, a
breadcrumb when a subagent is spawned outside `/delegate`, a nudge toward
`/audit` when delegations pile up, and a persistent status-line segment.

Everything here is **read-only against `.ceo/`** with one deliberate
exception, `hook-events.jsonl`, described below. Hooks never write the ledger
or the roster. Every ledger write takes the lock, per the invariants in
`ARCHITECTURE.md`. A hook that
appended to `ledger.jsonl` would compute its `prevHash` from a tail the
server may already have moved past. That would fork the chain that the whole
tamper-evidence story rests on.

## Requirements

- POSIX `sh`, tested under both bash-as-sh and dash
- `jq` on `PATH`, 1.6 or newer

No node, no build step. The scripts read `.ceo/ledger.jsonl` directly,
so they work whether or not `dist/` has been built.

**Every script exits 0 and prints nothing when anything is off**: no org
in the project, no `jq`, an unreadable ledger, malformed JSON, a failed
parse. A hook is not a place to be right at the cost of being disruptive.

## The scripts

### `session-start.sh`: SessionStart

Prints a one-line summary of the org:

```
CEO: 3 agents · $2.14 spent · last audit 3h ago
```

- **agents**: hires minus fires, replayed from the ledger. The ledger is
  the authority. `roster.json` is only a cache. The banner therefore never
  reports a stale headcount.
- **spent**: sum of `costUsd` across every `delegate_end`, all time.
  Settled cost only, since a `delegate_start` has no cost yet.
- **last audit**: age of the most recent `audit` entry, or `never
  audited`.

A second line appears only when something needs attention:

```
   ⚠ 2 dangling delegations · ledger chain broken at seq 9. Run /audit
```

- **dangling delegations**: a `delegate_start` with no matching
  `delegate_end`. An agent was dispatched and never reported back.
- **ledger chain broken at seq N**: see the caveat below.
- **unreadable ledger lines**: lines that are not parseable JSON, which
  is itself a form of chain damage, usually a truncated write.

Nothing prints when the project has no org.

#### What "broken chain" means here

The hook's chain check is **structural**, not cryptographic: contiguous
`seq`, a genesis `prevHash` of 64 zeroes, and each entry's `prevHash`
matching its predecessor's `hash`. That catches deletion, reordering and
truncation: the damage a stray editor or a bad merge actually causes.

It does **not** recompute sha256 over entry bodies, so an in-place edit of
an entry's `data` will pass this check. Doing it properly means
reproducing core's canonical JSON exactly: recursively sorted keys, its
number formatting. A jq reimplementation that is subtly different is
worse than no check at all. It would report breakage in an intact ledger.

`/audit` calls `verify()` from `src/core/ledger.ts`, which does the full
cryptographic walk. The banner's job is to point you there, not to be it.

### `post-tool-use.sh`: PostToolUse

When the session spawns a subagent through the Agent tool **directly**
rather than through `/delegate`, nothing reaches the MCP server and no
`delegate_start` is written. To the auditor that work never happened.

This hook appends a breadcrumb for each such call to
`.ceo/hook-events.jsonl`:

```json
{"ts":1788294511960,"tool":"Agent","subagent_type":"code-reviewer","description":"Review the diff","model":"claude-sonnet-5","session_id":"abc123","source":"hook:PostToolUse"}
```

The auditor diffs these against `delegate_start` entries in the ledger.
Breadcrumbs with no matching delegation are the delegations that bypassed
`/delegate`: untracked spend, and work with no provenance.

Notes:

- Writes to `hook-events.jsonl`, **never** to `ledger.jsonl`. Separate
  file, no hash chain, no ordering guarantees, appended with `O_APPEND`
  so concurrent hook runs cannot interleave partial lines.
- Matches tool name `Agent` or `Task`, the older name for the same tool.
- Non-matching tools produce no output at all. The file is not even
  created.
- `description` is truncated to 200 characters. This is a breadcrumb, not
  an archive. `.ceo/outputs/` is where real output lives.
- Always exits 0. The tool call has already run, so a hook failure here must
  not colour its result.

`hook-events.jsonl` is a local artifact, like `outputs/`. Add it to
`.gitignore` alongside the others:

```gitignore
.ceo/hook-events.jsonl
```

### `stop.sh`: Stop

Counts `delegate_end` entries with a `seq` above the most recent `audit`
entry. At five or more:

```
◆ 6 delegations since last audit. Consider /audit
```

Below the threshold it prints nothing. A Stop hook that speaks every turn
is a Stop hook that gets ignored, and then so is the one time it matters.
Change `THRESHOLD` at the top of the script to retune.

The boundary is `seq`, not timestamp: `seq` is contiguous and assigned at
append time, so it cannot tie or drift the way a wall-clock `ts` can.

### `../statusline/ceo-status.sh`: status line

```
◆ 3 · $0.42 · ⚠2
```

- **3**: agents currently in the org.
- **$0.42**: delegation spend since **local midnight**, not all time.
  The status line answers "what is today costing me". `/ledger` and the
  session banner cover the lifetime number.
- **⚠2**: `findingCount` from the most recent `audit` entry. Omitted
  entirely when the latest audit was clean or the org has never been
  audited. Core has no per-finding resolution state, so the newest report
  stands until another audit supersedes it.

Silent when the project has no org.

**Cost.** One `sh`, one `jq`, and no `date` or `dirname` forks. The org
root is found by parameter expansion and local midnight is computed inside
jq via `now | localtime`. A render takes about 30 ms on a small ledger,
mostly process startup.

## Registering them

### As a plugin

`hooks/hooks.json` in this directory is the plugin's hook manifest, wired
up by `"hooks": "./hooks/hooks.json"` in `.claude-plugin/plugin.json`.
Installing CEO as a plugin registers all three hooks with no further
setup.

The status line is not part of the plugin manifest. Claude Code takes one
status line, and that choice belongs to the user, not to a plugin. To use
CEO's, add this to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "${CLAUDE_PLUGIN_ROOT}/statusline/ceo-status.sh",
    "padding": 0
  }
}
```

If you already have a status line, call `ceo-status.sh` from it and
append its output. It prints one short segment, or nothing at all.

### By hand

Working in this repo rather than installing it, or wanting to register
only some of the hooks: add the following to `.claude/settings.json` in
the project. Or add it to `~/.claude/settings.json` to run them everywhere.
The scripts are silent in projects with no org, so global registration is
safe.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/hooks/session-start.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Agent|Task",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/hooks/post-tool-use.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/hooks/stop.sh"
          }
        ]
      }
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "$CLAUDE_PROJECT_DIR/statusline/ceo-status.sh",
    "padding": 0
  }
}
```

The `PostToolUse` matcher is what keeps the hook from running after every
Bash and Read call. The script filters on tool name again internally, so
it stays correct if the matcher is dropped or widened. It just does more
useless work.

`$CLAUDE_PROJECT_DIR` resolves to the user's project. Use
`${CLAUDE_PLUGIN_ROOT}` instead when the scripts live in an installed
plugin directory rather than in the project itself.

After editing settings, restart the session, or run `/hooks`, to pick the
changes up.

## Checking they work

Every script can be run by hand from inside a project that has an org:

```sh
hooks/session-start.sh </dev/null
hooks/stop.sh </dev/null
echo '{}' | statusline/ceo-status.sh

# PostToolUse takes the hook payload on stdin:
echo '{"cwd":"'"$PWD"'","tool_name":"Agent","tool_input":{"subagent_type":"ceo-auditor"}}' \
  | hooks/post-tool-use.sh
tail -1 .ceo/hook-events.jsonl
```

Silence is a valid result. It means no org, no `jq`, or nothing worth
reporting. To tell "no org" apart from "broken script", run with tracing:

```sh
sh -x hooks/session-start.sh </dev/null
```

The scripts find `.ceo/` by walking up from `$CLAUDE_PROJECT_DIR`, then
`$PWD`, then the payload's `cwd`. That matches how `src/core/paths.ts`
resolves the project root. Running one from a subdirectory of the project
works and reports the same org.
