#!/bin/sh
# CEO: Stop hook.
#
# Nudges toward an audit when delegations have piled up unreviewed:
#
#   ◆ 6 delegations since last audit. Consider /audit
#
# Threshold is 5 completed delegations since the most recent `audit` entry,
# or since the start of the ledger if the org has never been audited.
# Below the threshold it prints nothing at all. A Stop hook that speaks
# every turn gets ignored, and then so does the one time it matters.
#
# Read-only, silent on any error, always exits 0.

set -u

quit_quiet() { exit 0; }

THRESHOLD=5

command -v jq >/dev/null 2>&1 || quit_quiet

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

ROOT=$(find_org "${CLAUDE_PROJECT_DIR:-$PWD}") || ROOT=""
[ -n "$ROOT" ] || ROOT=$(find_org "$PWD") || quit_quiet
[ -n "$ROOT" ] || quit_quiet

LEDGER="$ROOT/.ceo/ledger.jsonl"
[ -r "$LEDGER" ] || quit_quiet

# Count delegate_end entries whose seq is above the last audit's seq. Using
# seq rather than timestamp keeps the boundary exact: seq is contiguous and
# assigned at append time, so it cannot tie or drift the way ts can.
COUNT=$(jq -n -R -r '
    [inputs | select(test("\\S")) | fromjson?] as $e
    | ([$e[] | select(.type == "audit") | .seq] | map(select(type == "number")) | max) as $a
    | [$e[]
       | select(.type == "delegate_end")
       | select($a == null or ((.seq | type) == "number" and .seq > $a))]
    | length
' <"$LEDGER" 2>/dev/null) || quit_quiet

case "$COUNT" in
    ''|*[!0-9]*) quit_quiet ;;
esac

[ "$COUNT" -ge "$THRESHOLD" ] || quit_quiet

printf '◆ %s delegations since last audit. Consider /audit\n' "$COUNT"

exit 0
