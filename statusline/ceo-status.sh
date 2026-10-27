#!/bin/sh
# CEO: Claude Code status line.
#
#   ◆ 3 · $0.42 · ⚠2
#
#   3      agents currently in the org (hires minus fires, from the ledger)
#   $0.42  delegation spend since local midnight
#   ⚠2     findings from the most recent audit; omitted when there are none
#
# Prints nothing when the project has no org. Budget: one shell, one jq,
# nothing else: no node, no build step, no `date` or `dirname` forks. This
# runs on every render, so the whole thing has to stay in the tens of
# milliseconds or it is not worth having.

set -u

quit_quiet() { exit 0; }

command -v jq >/dev/null 2>&1 || quit_quiet

# Walk up to the project root that owns .ceo/ (git toplevel, per
# src/core/paths.ts). Parameter expansion, not `dirname`, to keep it fork-free.
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

# Fast path: the status line runs in the project directory, so this resolves
# without touching stdin. Only if it does not do we spend a second jq parsing
# the status-line payload for a cwd.
ROOT=$(find_org "${CLAUDE_PROJECT_DIR:-$PWD}") || ROOT=""
[ -n "$ROOT" ] || ROOT=$(find_org "$PWD") || ROOT=""

if [ -z "$ROOT" ] && [ ! -t 0 ]; then
    PAYLOAD=$(cat 2>/dev/null) || PAYLOAD=""
    if [ -n "$PAYLOAD" ]; then
        PCWD=$(printf '%s' "$PAYLOAD" \
            | jq -r '.workspace.current_dir // .workspace.project_dir // .cwd // empty' \
              2>/dev/null) || PCWD=""
        if [ -n "$PCWD" ]; then
            ROOT=$(find_org "$PCWD") || ROOT=""
        fi
    fi
fi

[ -n "$ROOT" ] || quit_quiet

LEDGER="$ROOT/.ceo/ledger.jsonl"
[ -r "$LEDGER" ] || quit_quiet

# Local midnight is computed inside jq (`now | localtime` gives
# [year, month, mday, hour, min, sec, ...] in local time) rather than by
# shelling out to date twice.
FIELDS=$(jq -n -R -r '
    (now | localtime) as $lt
    | ((((now | floor) - ($lt[3] * 3600 + $lt[4] * 60 + ($lt[5] | floor)))) * 1000) as $since

    | [inputs | select(test("\\S")) | fromjson?] as $e

    # Ledger is the authority for who is in the org; roster.json is a cache.
    | ($e
       | reduce .[] as $x ({};
           if   $x.type == "hire" and ($x.agent | type) == "string" then .[$x.agent] = true
           elif $x.type == "fire" and ($x.agent | type) == "string" then del(.[$x.agent])
           else . end)
       | length) as $agents

    # Settled cost lives on delegate_end only.
    | ([$e[]
        | select(.type == "delegate_end" and (.ts | type) == "number" and .ts >= $since)
        | .data.costUsd]
       | map(select(type == "number")) | add // 0) as $today

    # "Open" findings = the finding count of the most recent audit. Core has
    # no per-finding resolution state, so the newest report stands until
    # another audit supersedes it.
    | ([$e[] | select(.type == "audit")] | last
       | if . == null then 0
         else (.data.findingCount | if type == "number" then . else 0 end) end) as $findings

    | [($e | length), $agents, $today, $findings] | @tsv
' <"$LEDGER" 2>/dev/null) || quit_quiet

[ -n "$FIELDS" ] || quit_quiet

IFS='	' read -r ENTRIES AGENTS TODAY FINDINGS <<EOF
$FIELDS
EOF

[ -n "${AGENTS:-}" ] || quit_quiet
# A ledger file with nothing readable in it is not an org worth a segment.
[ "${ENTRIES:-0}" -gt 0 ] 2>/dev/null || quit_quiet

TODAY_FMT=$(printf '%.2f' "${TODAY:-0}" 2>/dev/null) || TODAY_FMT="0.00"

LINE="◆ $AGENTS · \$$TODAY_FMT"
if [ "${FINDINGS:-0}" -gt 0 ] 2>/dev/null; then
    LINE="$LINE · ⚠$FINDINGS"
fi

printf '%s\n' "$LINE"

exit 0
