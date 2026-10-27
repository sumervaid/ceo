#!/bin/sh
# CEO: SessionStart hook.
#
# Prints a one-line org summary when the project has an org. A second line
# appears only when something needs attention: dangling delegations, a
# ledger chain that no longer links up, or unreadable lines.
#
#   CEO: 3 agents · $2.14 spent · last audit 3h ago
#      ⚠ 2 dangling delegations. Run /audit
#
# Read-only. This hook never touches .ceo/. Only core code writes the
# ledger, under the lock. If there is no org, no jq, or anything
# malformed, it prints nothing and exits 0. A hook must never be the reason
# a session breaks.

set -u

# Every abnormal path lands here: silence, success.
quit_quiet() { exit 0; }

command -v jq >/dev/null 2>&1 || quit_quiet

# --- locate the org ---------------------------------------------------------
# .ceo/ lives at the project root, the git toplevel per src/core/paths.ts.
# So walk up from wherever the session started until a ledger turns up. Pure
# parameter expansion, no `dirname` fork per level.
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

# --- read the ledger ---------------------------------------------------------
# One jq pass emits seven TSV fields. The shell only does wording and money
# formatting. `fromjson?` drops unparseable lines instead of aborting, and the
# count of dropped lines becomes its own warning.
#
# The chain check here is structural: contiguous seq, genesis prevHash, and
# each entry's prevHash matching its predecessor's hash. That catches
# deletion, reordering and truncation, which is what a session banner needs.
# It does NOT recompute sha256 over entry bodies, so an in-place content edit
# slips past. /audit runs core's verify() for that, and the banner points
# there rather than pretending to be it.
FIELDS=$(jq -n -R -r '
    def ago($ms):
      ((now * 1000 - $ms) / 1000) as $d
      | if   $d < 60    then "just now"
        elif $d < 3600  then "\(($d / 60)    | floor)m ago"
        elif $d < 86400 then "\(($d / 3600)  | floor)h ago"
        else                 "\(($d / 86400) | floor)d ago" end;

    [inputs | select(test("\\S"))] as $lines
    | ($lines | map(fromjson?)) as $e

    # Agents currently in the org: replay hire/fire. The ledger is the
    # authority. roster.json is only a cache.
    | ($e
       | reduce .[] as $x ({};
           if   $x.type == "hire" and ($x.agent | type) == "string" then .[$x.agent] = true
           elif $x.type == "fire" and ($x.agent | type) == "string" then del(.[$x.agent])
           else . end)
       | length) as $agents

    # Settled cost lives on delegate_end only; delegate_start has none yet.
    | ([$e[] | select(.type == "delegate_end") | .data.costUsd]
       | map(select(type == "number")) | add // 0) as $spend

    | ([$e[] | select(.type == "audit") | .ts]
       | map(select(type == "number")) | max) as $audit

    # A delegate_start with no matching delegate_end is an interrupted
    # delegation (core/delegation.ts danglingDelegations).
    | ([$e[] | select(.type == "delegate_end") | .data.id | tostring] | unique) as $ended
    | ([$e[] | select(.type == "delegate_start") | .data.id | tostring]
       | map(select(. as $i | ($ended | index($i)) == null)) | length) as $dangling

    | (first(
        range(0; $e | length)
        | select(
            ($e[.].seq != .)
            or (if . == 0
                then ($e[0].prevHash != ("0" * 64))
                else ($e[.].prevHash != $e[. - 1].hash) end))) // -1) as $break

    | [($e | length),
       $agents,
       $spend,
       (if $audit == null then "never audited" else "last audit " + ago($audit) end),
       $dangling,
       $break,
       (($lines | length) - ($e | length))]
    | @tsv
' <"$LEDGER" 2>/dev/null) || quit_quiet

[ -n "$FIELDS" ] || quit_quiet

# Tab-separated read, POSIX-safe. No here-strings.
IFS='	' read -r ENTRIES AGENTS SPEND AUDIT_TXT DANGLING BREAK_SEQ SKIPPED <<EOF
$FIELDS
EOF

[ -n "${AGENTS:-}" ] || quit_quiet
# A ledger file with nothing readable in it is not an org yet.
[ "${ENTRIES:-0}" -gt 0 ] 2>/dev/null || quit_quiet

# --- banner ------------------------------------------------------------------
SPEND_FMT=$(printf '%.2f' "$SPEND" 2>/dev/null) || SPEND_FMT="0.00"

if [ "$AGENTS" = "1" ]; then AGENT_WORD="agent"; else AGENT_WORD="agents"; fi

printf 'CEO: %s %s · $%s spent · %s\n' \
    "$AGENTS" "$AGENT_WORD" "$SPEND_FMT" "$AUDIT_TXT"

# --- warnings ----------------------------------------------------------------
# One line, only when there is something to say. Each warning names a state
# the user can act on, and the line ends with the command that acts on it.
WARN=""
add_warn() { if [ -z "$WARN" ]; then WARN="$1"; else WARN="$WARN · $1"; fi; }

if [ "${DANGLING:-0}" -gt 0 ] 2>/dev/null; then
    if [ "$DANGLING" = "1" ]; then
        add_warn "1 dangling delegation"
    else
        add_warn "$DANGLING dangling delegations"
    fi
fi

if [ "${BREAK_SEQ:--1}" -ge 0 ] 2>/dev/null; then
    add_warn "ledger chain broken at seq $BREAK_SEQ"
fi

if [ "${SKIPPED:-0}" -gt 0 ] 2>/dev/null; then
    if [ "$SKIPPED" = "1" ]; then
        add_warn "1 unreadable ledger line"
    else
        add_warn "$SKIPPED unreadable ledger lines"
    fi
fi

[ -n "$WARN" ] && printf '   ⚠ %s. Run /audit\n' "$WARN"

exit 0
