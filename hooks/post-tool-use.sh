#!/bin/sh
# CEO: PostToolUse hook.
#
# Records a breadcrumb every time the session spawns a subagent through the
# Agent tool directly, rather than through /delegate. Those calls never reach
# the MCP server, so they leave no ledger entry: to the auditor the work looks
# like it never happened.
#
# The breadcrumb goes to .ceo/hook-events.jsonl, deliberately NOT the
# ledger. The ledger is hash-chained. Only core code writes the ledger,
# under the lock. A hook appending to the ledger would fork the chain. This
# file is a plain side-channel the auditor diffs against delegate_start
# entries to find delegations that bypassed /delegate.
#
# Reads the hook payload on stdin. Always exits 0. A PostToolUse hook that
# fails must not affect a tool call that already ran.

set -u

quit_quiet() { exit 0; }

command -v jq >/dev/null 2>&1 || quit_quiet

# stdin is the hook payload. Guard against being run interactively, where a
# bare `cat` would hang waiting for a terminal.
[ -t 0 ] && quit_quiet
PAYLOAD=$(cat 2>/dev/null) || quit_quiet
[ -n "$PAYLOAD" ] || quit_quiet

# --- locate the org ---------------------------------------------------------
find_org() {
    d=${1:-}
    case "$d" in /*) ;; *) return 1 ;; esac
    while [ -n "$d" ]; do
        [ -f "$d/.ceo/ledger.jsonl" ] && { printf '%s\n' "$d"; return 0; }
        d=${d%/*}
    done
    [ -f "/.ceo/ledger.jsonl" ] && { printf '/\n'; return 0; }
    return 1
}

# --- parse the payload -------------------------------------------------------
# One jq pass does everything: filter on tool name, pull the session cwd, and
# render the breadcrumb. `select` drops non-Agent tools, so an ordinary tool
# call produces no output and nothing is written, not even an empty file.
# "Task" is the older name for the same tool. Accept both so the cross-check
# does not go blind on an older Claude Code.
#
# Output is "<cwd>\t<json>". join() is used rather than @tsv because @tsv
# escapes backslashes and would corrupt the JSON it is carrying.
OUT=$(printf '%s' "$PAYLOAD" | jq -r '
    (.tool_name // .toolName // "") as $tool
    | select($tool == "Agent" or $tool == "Task")
    | (.tool_input // .toolInput // {}) as $in
    | [ (.cwd // .workspace.current_dir // ""),
        ({
          ts: (now * 1000 | floor),
          tool: $tool,
          subagent_type: ($in.subagent_type // $in.subagentType // null),
          description: (($in.description // null)
                        | if type == "string" then .[0:200] else . end),
          model: ($in.model // null),
          session_id: (.session_id // .sessionId // null),
          source: "hook:PostToolUse"
        } | tojson) ]
    | join("\t")
' 2>/dev/null) || quit_quiet

[ -n "$OUT" ] || quit_quiet

IFS='	' read -r PAYLOAD_CWD LINE <<EOF
$OUT
EOF

[ -n "${LINE:-}" ] || quit_quiet

# --- locate the org ---------------------------------------------------------
ROOT=""
for candidate in "${CLAUDE_PROJECT_DIR:-}" "${PAYLOAD_CWD:-}" "$PWD"; do
    [ -n "$candidate" ] || continue
    if ROOT=$(find_org "$candidate") && [ -n "$ROOT" ]; then break; fi
    ROOT=""
done
[ -n "$ROOT" ] || quit_quiet

# Single-line append with O_APPEND. Safe to interleave with other hook runs.
printf '%s\n' "$LINE" >>"$ROOT/.ceo/hook-events.jsonl" 2>/dev/null

exit 0
