#!/usr/bin/env bash
#
# Install CEO: the `ceo` binary and the Claude Code plugin.
#
# Both installs are symlinks back into this checkout. A rebuild with
# `pnpm build` is picked up with no reinstall.
#
# Safe to re-run.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
PLUGIN_DIR="${HOME}/.claude/skills"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n  %s\n\n' "$*" >&2; exit 1; }

printf '\nInstalling CEO from %s\n\n' "$REPO"

# ---- prerequisites --------------------------------------------------------

command -v node >/dev/null 2>&1 || fail "node is required and not on PATH."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "node 22+ is required. Found $(node -v)."

if ! command -v claude >/dev/null 2>&1 && ! command -v codex >/dev/null 2>&1 && ! command -v agy >/dev/null 2>&1; then
  # Not fatal for the dashboard. Running an agent needs one agent CLI.
  say "WARNING: none of 'claude', 'codex' or 'agy' is on PATH. The dashboard"
  say "         opens. Running an agent needs one of the three installed."
  echo
fi

command -v pnpm >/dev/null 2>&1 || fail "pnpm is required. Install with: npm i -g pnpm"

# ---- build ----------------------------------------------------------------

cd "$REPO"
say "Installing dependencies…"
pnpm install --silent

say "Building…"
pnpm build >/dev/null

[ -f "$REPO/dist/cli.js" ] || fail "Build produced no dist/cli.js. Check 'pnpm build' output."
chmod +x "$REPO/dist/cli.js"

# ---- the ceo binary -------------------------------------------------------

mkdir -p "$BIN_DIR"
ln -sfn "$REPO/dist/cli.js" "$BIN_DIR/ceo"
say "Linked $BIN_DIR/ceo"

case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *)
    say ""
    say "NOTE: $BIN_DIR is not on PATH. A line for the shell profile:"
    say "      export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac

# ---- the Claude Code plugin -----------------------------------------------

if [ -d "${HOME}/.claude" ]; then
  mkdir -p "$PLUGIN_DIR"
  ln -sfn "$REPO" "$PLUGIN_DIR/ceo"
  say "Linked $PLUGIN_DIR/ceo. It loads as ceo@skills-dir."

  if command -v claude >/dev/null 2>&1; then
    if claude plugin validate "$REPO" >/dev/null 2>&1; then
      say "Plugin manifest validates."
    else
      say "WARNING: plugin manifest failed validation. Run:"
      say "         claude plugin validate $REPO"
    fi
  fi
else
  say "No ~/.claude directory. Skipped the plugin install."
fi

# ---- done -----------------------------------------------------------------

cat <<EOF

Done.

  ceo                     open the dashboard in a directory
  ceo suggest             propose a team from session history and the repo
  ceo billing             which account each provider bills to
  ceo snapshot            print the org as text
  ceo status              one line

Agents run as \`claude -p\`, \`codex exec\` or \`agy -p\` under the logins
already on this machine. The checklist below shows each one:

  ceo setup               the checklist
  ceo setup claude        sign in to Claude Code
  ceo setup codex         sign in to Codex
  ceo setup gemini        sign in to the Antigravity CLI

The optional Claude Code companion (/hire, /delegate, /audit, /ledger)
needs a Claude Code restart, because MCP servers load at session start.

Start an org in any directory. Git only matters for isolated agents:

  cd <a project> && ceo

EOF
