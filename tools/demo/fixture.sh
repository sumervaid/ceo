#!/usr/bin/env bash
#
# Build the world the demo GIF is recorded in, for $0: a small repository, a
# few past codex and Claude Code sessions for it, a Reflex store with one
# repeated workflow that names it, and every agent CLI stubbed. Everything
# lands under $DEMO, by default /tmp/ceo-demo. Nothing outside it is touched.
#
#   tools/demo/fixture.sh            # build
#   eval "$(tools/demo/fixture.sh env)"   # the environment the recording runs with
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Resolved to a real path: on macOS /tmp is a symlink, and git reports real
# paths, so a fixture under the symlink would never match its own transcripts.
mkdir -p "${DEMO:-/tmp/ceo-demo}"
DEMO="$(cd "${DEMO:-/tmp/ceo-demo}" && pwd -P)"
HOMEDIR="$DEMO/home"
PROJECT="$DEMO/home/code/orbit"

if [ "${1:-}" = "env" ]; then
  cat <<ENV
export HOME="$HOMEDIR"
export PATH="$DEMO/bin:$PATH"
export CEO_HOME="$HOMEDIR/.ceo"
export CODEX_HOME="$HOMEDIR/.codex"
export CLAUDE_CONFIG_DIR="$HOMEDIR/.claude"
export REFLEX_HOME="$HOMEDIR/.reflex"
export CEO_CLAUDE_BIN="$REPO/tools/stub-claude"
export CEO_CODEX_BIN="$REPO/tools/stub-codex"
export CEO_GEMINI_BIN="$REPO/tools/stub-gemini"
export STUB_GEMINI_LOGIN=ok
export STUB_GEMINI_VERSION="1.4.7"
export CEO_REFLEX_BIN="$DEMO/bin/reflex"
export CEO_GH_BIN="$REPO/tools/stub-gh"
export CEO_HF_ENDPOINT="file://$DEMO/hub"
export HF_HOME="$DEMO/hf-home"
export CEO_NOTIFY_BIN=/usr/bin/true
export CLAUDE_CODE_OAUTH_TOKEN=demo
export STUB_CODEX_LOGIN=chatgpt
export STUB_DELAY_MS=650
export STUB_TURNS=3
# The versions actually installed where this was recorded. The runs are still stubs.
export STUB_VERSION="2.1.302 (Claude Code)"
export STUB_CODEX_VERSION="codex-cli 0.162.1"
export GIT_AUTHOR_NAME=demo GIT_AUTHOR_EMAIL=demo@example.com GIT_COMMITTER_NAME=demo GIT_COMMITTER_EMAIL=demo@example.com
export DEMO_PROJECT="$PROJECT"
export DEMO="$DEMO"
ENV
  exit 0
fi

rm -rf "$DEMO"
mkdir -p "$PROJECT/src" "$PROJECT/test" "$PROJECT/.github/workflows" "$HOMEDIR/.ceo" "$HOMEDIR/.reflex" "$DEMO/bin"

# ---- the repository ---------------------------------------------------------
cat > "$PROJECT/package.json" <<'JSON'
{
  "name": "orbit",
  "version": "2.3.1",
  "description": "A small HTTP client with retries.",
  "scripts": { "test": "node --test", "build": "tsc", "lint": "eslint ." }
}
JSON
: > "$PROJECT/pnpm-lock.yaml"
cat > "$PROJECT/README.md" <<'MD'
# orbit

A small HTTP client with retries and backoff.
MD
cat > "$PROJECT/src/client.ts" <<'TS'
export async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
TS
cat > "$PROJECT/test/client.test.ts" <<'TS'
import { test } from "node:test";
test("retries three times", () => {});
TS
echo "name: ci" > "$PROJECT/.github/workflows/ci.yml"
cat > "$PROJECT/src/retry.ts" <<'TS'
export async function fetchWithRetry(url: string, maxAttempts = 5): Promise<Response> {
  let attempts = 0;
  for (;;) {
    const res = await fetch(url).catch(() => null);
    attempts = 0;
    if (res && res.ok) return res;
    if (++attempts >= maxAttempts) throw new Error("gave up");
    await new Promise((r) => setTimeout(r, 2 ** attempts * 100));
  }
}
TS
(
  cd "$PROJECT"
  git init -q
  for i in $(seq 1 12); do
    echo "// change $i" >> src/client.ts
    git add -A >/dev/null
    git -c user.email=demo@example.com -c user.name=demo commit -q -m "client: change $i"
  done
)

# ---- past sessions -----------------------------------------------------------
# codex rollouts in this project, one claude transcript, so the model line
# has something to say.
DAY="$HOMEDIR/.codex/sessions/2026/10/20"
mkdir -p "$DAY"
rollout() { # file cwd ask
  cat > "$1" <<JSONL
{"timestamp":"2026-10-20T10:00:00Z","type":"session_meta","payload":{"id":"$(basename "$1" .jsonl)","timestamp":"2026-10-20T10:00:00Z","cwd":"$2"}}
{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"gpt-5-codex"}}}
{"type":"event_msg","payload":{"type":"user_message","message":"$3"}}
{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{}"}}
{"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"c1"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":640000,"cached_input_tokens":480000,"output_tokens":52000}}}}
JSONL
}
rollout "$DAY/rollout-2026-10-20T10-00-00-a1.jsonl" "$PROJECT" "fix the flaky retry test in client.ts"
rollout "$DAY/rollout-2026-10-20T14-00-00-a2.jsonl" "$PROJECT" "the retry test is flaky again, find the root cause"
rollout "$DAY/rollout-2026-10-20T16-00-00-a3.jsonl" "$PROJECT" "add exponential backoff to fetchWithRetry"
CLP="$HOMEDIR/.claude/projects/$(echo "$PROJECT" | tr '/' '-')"
mkdir -p "$CLP"
cat > "$CLP/9b1e.jsonl" <<'JSONL'
{"type":"user","timestamp":"2026-10-21T09:00:00Z","message":{"role":"user","content":"write a changelog entry for the backoff change"}}
{"type":"assistant","message":{"id":"m1","model":"claude-sonnet-5","usage":{"input_tokens":1200,"output_tokens":400,"cache_read_input_tokens":30000},"content":[{"type":"tool_use","name":"Edit","input":{}}]}}
JSONL

# ---- Reflex store ------------------------------------------------------------
WF='{"slug":"fix-flaky-test","title":"Repeated workflow: fix flaky test","description":"Repeated workflow involving reading the failing test, finding the root cause, fixing it and running the suite.","whenToUse":"Use for requests similar to: retry, flaky, test, root cause.","confidence":0.84,"instances":5,"repositories":["orbit","web"],"sources":{"codex":4,"claude-code":1},"steps":[{"kind":"inspect-code","label":"read the failing test","instruction":"Read the failing test and the code it exercises before changing anything.","support":1,"examples":["node --test test/client.test.ts"]},{"kind":"reproduce-failure","label":"reproduce","instruction":"Reproduce the failure locally with the same command.","support":0.8,"examples":[]},{"kind":"modify-code","label":"patch","instruction":"Fix the root cause with the smallest focused change. Never loosen the assertion.","support":1,"examples":[]},{"kind":"run-tests","label":"run the suite","instruction":"Run the suite and report the actual output.","support":1,"examples":["pnpm test"]}],"topTerms":["retry","flaky","test","backoff"],"verifiedRate":0.8,"medianMinutes":9,"cost":{"runs":5,"runsWithTokens":5,"medianTokens":1400000,"usage":{"input":1600000,"output":260000,"cacheRead":4800000,"cacheWrite":40000},"medianToolCalls":14},"constraints":{"avoid":["adjust the test to make it pass"],"prefer":["pnpm over npm"]}}'
TR='{"sessionId":"codex:a1","source":"codex","projectName":"orbit","projectHash":"x","usage":{"input":160000,"output":52000,"cacheRead":480000,"cacheWrite":0},"usageByModel":{"gpt-5-codex":{"input":160000,"output":52000,"cacheRead":480000,"cacheWrite":0}},"outcome":{"verified":true},"toolCalls":11,"excerpt":"fix the flaky retry test in client.ts"}'
sqlite3 "$HOMEDIR/.reflex/reflex.db" <<SQL
CREATE TABLE scans (id INTEGER PRIMARY KEY, started_at TEXT, days INTEGER, mode TEXT, sources_json TEXT, files INTEGER, sessions INTEGER, partial INTEGER, unreadable INTEGER, skipped_records INTEGER);
INSERT INTO scans VALUES (1, '$(date -u +%Y-%m-%dT%H:%M:%SZ)', 30, 'full', '[]', 4, 4, 0, 0, 0);
CREATE TABLE suggestions (slug TEXT PRIMARY KEY, status TEXT, rank INTEGER, scan_id INTEGER, data_json TEXT, updated_at TEXT);
INSERT INTO suggestions VALUES ('fix-flaky-test', 'pending', 1, 1, '$WF', '2026-10-24');
CREATE TABLE traces (row_id INTEGER PRIMARY KEY, path TEXT, session_id TEXT, source TEXT, ended_at TEXT, context_hash TEXT, trace_json TEXT);
INSERT INTO traces VALUES (1, 'p', 'codex:a1', 'codex', NULL, NULL, '$TR');
INSERT INTO traces VALUES (2, 'p', 'codex:a2', 'codex', NULL, NULL, '$(echo "$TR" | sed 's/codex:a1/codex:a2/')');
SQL

# `ceo` on PATH, pointing at this checkout's build.
printf '#!/bin/sh\nexec node "%s/dist/cli.js" "$@"\n' "$REPO" > "$DEMO/bin/ceo"
chmod +x "$DEMO/bin/ceo"

# A reflex that answers --version, so `ceo setup` shows the row as scanned,
# and approves a waiting workflow by writing its SKILL.md, as the real one does.
cat > "$DEMO/bin/reflex" <<'RFX'
#!/bin/sh
[ "$1" = "--version" ] && { echo 0.3.1; exit 0; }
if [ "$1" = "approve" ]; then
  mkdir -p "$REFLEX_HOME/skills/$2"
  printf -- "---\nname: %s\ndescription: Make a flaky test pass reliably, then prove it with ten straight runs\n---\n\n## When to use\n\nA test fails some runs and passes others.\n\n## Workflow\n\n1. Run the test ten times and record which runs fail.\n2. Find the state the failing runs share.\n3. Fix the cause, not the test.\n4. Run the test ten times again.\n\n## Constraints\n\n- Do not adjust the test to make it pass.\n- Prefer pnpm over npm.\n" "$2" > "$REFLEX_HOME/skills/$2/SKILL.md"
  echo "Approved $2"; exit 0
fi
echo "reflex (demo stub): nothing to do"
RFX
chmod +x "$DEMO/bin/reflex"

# Two skills Reflex already approved.
mkdir -p "$HOMEDIR/.reflex/skills/map-callers" "$HOMEDIR/.reflex/skills/review-a-diff"
cat > "$HOMEDIR/.reflex/skills/map-callers/SKILL.md" <<'SK'
---
name: map-callers
description: Find every caller of a function and what each one passes
---

## When to use

Before changing a function's behaviour.

## Workflow

1. Search for the function's name and its re-exports.
2. List each caller with the file, the line and the arguments.
3. Say which callers depend on the behaviour being changed.
SK
cat > "$HOMEDIR/.reflex/skills/review-a-diff/SKILL.md" <<'SK'
---
name: review-a-diff
description: Review a diff for correctness, one finding per bug
---

## Workflow

1. Read the whole diff before commenting.
2. For each bug: the file, the line, and an input that breaks it.
3. Skip style.
SK

# A Hub in a directory: one model card, one dataset, one paper.
mkdir -p "$DEMO/hub/api/models/acme" "$DEMO/hub/acme/retry-coder/raw/main" "$DEMO/hub/api/papers" "$DEMO/hf-home"
cat > "$DEMO/hub/api/models/acme/retry-coder.json" <<'HF'
{ "id": "acme/retry-coder", "pipeline_tag": "text-generation", "library_name": "transformers", "downloads": 48210, "likes": 312, "tags": ["code", "retry", "backoff", "en"] }
HF
cat > "$DEMO/hub/acme/retry-coder/raw/main/README.md" <<'HF'
---
license: apache-2.0
---
# retry-coder

A 7B model fine-tuned on retry and backoff code. Prefers exponential backoff
with full jitter, and resets the attempt counter only after a success.
HF
cat > "$DEMO/hub/api/papers/2408.01234.json" <<'HF'
{ "id": "2408.01234", "title": "Exponential Backoff and Jitter, Revisited", "summary": "Resetting the backoff counter before the final attempt removes the delay where it matters most, and accounts for most tail failures in retry loops. Full jitter with a capped exponent fixes it.", "authors": [{ "name": "M. Rivera" }, { "name": "J. Okafor" }] }
HF

# A remote for pull requests: a bare repository beside the project.
git init -q --bare "$DEMO/remote.git"
git -C "$PROJECT" remote add origin "$DEMO/remote.git"
git -C "$PROJECT" push -q origin HEAD:main 2>/dev/null || true

# ---- the two-pane layout the collaboration recording types into ---------------
# One script, so the tape types one word and no quoting crosses VHS, bash
# and tmux at once. A neutral prompt, the status bar off, and a separate
# tmux socket so a running `ceo` session on the machine is never touched.
cat > "$DEMO/bin/demo-tmux" <<'TMUX'
#!/bin/bash
cd "$DEMO_PROJECT" || exit 1
export STUB_TURNS=10 STUB_DELAY_MS=1000 BASH_SILENCE_DEPRECATION_WARNING=1
# A session left from an earlier recording points at a deleted fixture. The
# socket is the demo's own, so clearing it touches nothing else.
tmux -L ceodemo kill-server 2>/dev/null
tmux -L ceodemo -f /dev/null new-session -d -s demo -x 190 -y 50 'ceo ui'
tmux -L ceodemo set -g status off
tmux -L ceodemo set -g default-command "env PS1='orbit \$ ' bash --norc --noprofile"
tmux -L ceodemo split-window -h -l 62 -c "$DEMO_PROJECT"
exec tmux -L ceodemo attach -t demo
TMUX
chmod +x "$DEMO/bin/demo-tmux"

# ---- the chat recording -------------------------------------------------------
# `fixture.sh chat` builds an org with two agents and a scripted chief of
# staff. The stub plays the chief: for each message it calls the real org
# server, so the hires and the delegations are real ledger events.
cat > "$DEMO/chat.json" <<'JSON'
[
  {
    "match": "who is on the team",
    "calls": [{ "tool": "org_roster", "args": {} }, { "tool": "org_running", "args": {} }],
    "reply": "Two agents, nobody running.\n\n- scout reads the codebase on claude at observe, with a $2 cap.\n- coder writes on its own branch on codex at execute, with a $4 cap.\n\nNobody on the team reviews code yet.",
    "costUsd": 0.0042
  },
  {
    "match": "flaky retry test",
    "calls": [
      { "tool": "org_providers", "args": {} },
      { "tool": "org_hire", "args": { "name": "reviewer", "brief": "Read the coder's branch and flag correctness bugs with the file, the line and a failure scenario.", "provider": "gemini", "budgetUsd": 2, "level": "propose" } },
      { "tool": "org_budget", "args": { "agent": "coder", "budgetUsd": 6 } },
      { "tool": "org_delegate", "args": { "agent": "coder", "task": "Make the flaky retry test pass ten times in a row. Done when ten straight runs pass.", "provider": "codex" } },
      { "tool": "org_delegate", "args": { "agent": "reviewer", "task": "Review the retry fix on coder's branch and post what you find to coder.", "provider": "gemini" } }
    ],
    "reply": "The fix is on codex and the review on gemini, as asked.\n\n- coder has the fix, with the budget raised to $6.\n- Nobody reviewed, so I hired reviewer on gemini with $2.\n- $4 of the $25 allowance is given, $21 is left.\n\nBoth runs start now. esc shows them on the dashboard.",
    "costUsd": 0.0089
  },
  {
    "match": "how is it going",
    "calls": [{ "tool": "org_running", "args": {} }],
    "reply": "Both are done.\n\n- coder made the retry test pass ten runs in a row, on branch ceo/coder.\n- reviewer read the fix and posted one note to coder about the backoff reset.\n\nThe branch is ready for you to merge with m on the dashboard.",
    "costUsd": 0.0031
  }
]
JSON

cat > "$DEMO/bin/demo-chat" <<'CHAT'
#!/bin/bash
cd "$DEMO_PROJECT" || exit 1
export STUB_CHAT="$DEMO/chat.json" STUB_TURNS=8 STUB_DELAY_MS=900 BASH_SILENCE_DEPRECATION_WARNING=1
exec ceo chat
CHAT
chmod +x "$DEMO/bin/demo-chat"

if [ "${1:-}" = "chat" ]; then
  (
    eval "$(bash "$0" env)"
    cd "$PROJECT"
    ceo op init '{}' >/dev/null
    ceo op hire '{"name":"scout","role":"Survey the codebase and answer questions about how it is structured. Cite file paths and line numbers.","budgetUsd":2,"autonomy":"observe"}' >/dev/null
    ceo op hire '{"name":"coder","role":"Implement what the queue asks for. Match the surrounding conventions and make the smallest change that fully solves the problem.","provider":"codex","budgetUsd":4,"autonomy":"execute","isolated":true}' >/dev/null
    ceo op mission '{"objective":"Make the retry path in orbit reliable without changing its public API","successCriteria":["the flaky test passes ten times in a row"]}' >/dev/null
  )
fi

# ---- the team recordings: three providers working one task -------------------
# `fixture.sh team` hires the software company with a worktree for every
# agent, so the gemini reviewer gets the org tools too. The chief gives the
# work out; the stubs then trade notes through the real org server.
cat > "$DEMO/team-chat.json" <<'JSON'
[
  {
    "match": "flaky",
    "calls": [
      { "tool": "org_budget", "args": { "agent": "implementer", "budgetUsd": 7 } },
      { "tool": "org_delegate", "args": { "agent": "scout", "task": "Find every caller of fetchWithRetry and say which ones retry on a 429.", "provider": "claude" } },
      { "tool": "org_delegate", "args": { "agent": "implementer", "task": "Make the flaky retry test pass ten runs in a row. Done when ten straight runs pass.", "provider": "codex" } },
      { "tool": "org_delegate", "args": { "agent": "reviewer", "task": "Review the retry fix as it lands and post findings to implementer.", "provider": "gemini" } }
    ],
    "reply": "On it, one provider per part, as asked.\n\n- scout maps the callers, on claude.\n- implementer fixes the test, on codex, with the budget raised to $7.\n- reviewer checks the fix, on gemini.\n\nThe three trade notes as they go. L on the dashboard shows the exchange live.",
    "costUsd": 0.0072
  }
]
JSON

cat > "$DEMO/team.json" <<'JSON'
[
  { "agent": "scout", "after": 2, "calls": [{ "tool": "org_post", "args": { "to": "implementer", "text": "fetchWithRetry has two callers: src/client.ts:41 and src/sync.ts:88. Only sync.ts retries on a 429." } }], "say": "Posted the two callers to implementer." },
  { "agent": "implementer", "after": 3, "calls": [{ "tool": "org_post", "args": { "to": "reviewer", "text": "Moved the backoff reset after the last attempt in src/retry.ts:12. Ready for a look." } }], "say": "Asked reviewer to look at the reset." },
  { "agent": "reviewer", "after": 5, "calls": [{ "tool": "org_post", "args": { "to": "implementer", "text": "src/retry.ts:12 still resets on success. Keep the reset inside the success branch." } }], "say": "The reset is still on the success path." },
  { "agent": "implementer", "on": "resume", "match": "still resets on success", "after": 1, "calls": [{ "tool": "org_post", "args": { "to": "reviewer", "text": "Fixed. The reset lives in the success branch now, and ten straight runs pass." } }], "say": "Moved the reset. Ten runs pass." },
  { "agent": "reviewer", "on": "resume", "match": "ready for a look", "after": 1, "calls": [{ "tool": "org_post", "args": { "to": "implementer", "text": "Read the change. One note above. Otherwise good." } }] },
  { "agent": "reviewer", "on": "resume", "match": "ten straight runs pass", "after": 1, "calls": [{ "tool": "org_post", "args": { "to": "implementer", "text": "Approved. Nothing blocking." } }], "say": "Approved." },
  { "agent": "scout", "steps": ["Reading src/client.ts.", "Two callers so far: client.ts and sync.ts.", "Checking which callers retry on a 429.", "Only sync.ts retries on a 429.", "Writing up the map.", "Callers mapped: client.ts:41 and sync.ts:88."], "done": "Two callers. Only sync.ts retries on a 429." },
  { "agent": "implementer", "steps": ["Reading src/retry.ts and its test.", "The test fails when the backoff resets early.", "Moving the reset after the last attempt.", "Running the test ten times.", "Nine of ten pass. Looking at the failure.", "Waiting on the review."], "done": "Reset moved. Waiting on the review." },
  { "agent": "reviewer", "steps": ["Reading the diff on implementer's branch.", "Checking the reset path in retry.ts.", "Tracing the success branch.", "The reset still runs on success.", "Posting the finding to implementer.", "Review posted."], "done": "One finding posted." },
  { "agent": "implementer", "on": "resume", "steps": ["Reading the notes from scout and reviewer.", "Moving the reset into the success branch.", "Running the test ten times.", "Ten of ten pass.", "Committing on ceo/implementer.", "Ten straight runs pass."], "done": "Fixed. Ten straight runs pass on ceo/implementer." },
  { "agent": "reviewer", "on": "resume", "steps": ["Reading implementer's note.", "Re-reading src/retry.ts:12.", "The reset now lives in the success branch.", "Running the test once more.", "The test passes.", "Approved."], "done": "Approved." }
]
JSON

for name in hero live; do
cat > "$DEMO/bin/demo-$name" <<'TEAM'
#!/bin/bash
cd "$DEMO_PROJECT" || exit 1
export STUB_CHAT="$DEMO/team-chat.json" STUB_SCRIPT="$DEMO/team.json" STUB_TURNS=6 STUB_DELAY_MS=900 BASH_SILENCE_DEPRECATION_WARNING=1
exec ceo ui
TEAM
chmod +x "$DEMO/bin/demo-$name"
done

if [ "${1:-}" = "team" ]; then
  (
    eval "$(bash "$0" env)"
    cd "$PROJECT"
    ceo op init '{}' >/dev/null
    ceo company software --worktrees all >/dev/null
    ceo op mission '{"objective":"Make the retry path in orbit reliable without changing its public API","successCriteria":["the flaky test passes ten times in a row"]}' >/dev/null
  )
fi

# ---- the constellation recording: a swarm around the chief ---------------------
# `fixture.sh sky` hires the software company. In the recording the chief
# is asked for a swarm, hires twelve fixers across claude, codex and
# gemini, and gives each one a flaky test. The fixers trade notes with
# their neighbours, report to the chief, and one tells everyone.
node - "$DEMO" <<'NODE'
const fs = require("fs");
const dir = process.argv[2];
const N = 12;
const name = (i) => `fixer-${String(((i - 1 + N) % N) + 1).padStart(2, "0")}`;
const tests = ["retry backoff", "socket timeout", "429 handling", "jitter seed", "redirect loop", "gzip stream", "abort signal", "proxy auth", "chunked body", "keep-alive", "dns cache", "clock skew"];
const providers = ["claude", "codex", "gemini"];
const chat = [{
  match: "swarm",
  calls: [
    { tool: "org_hire", args: { name: "fixer", count: N, provider: "claude", providers, brief: "Fix one flaky test in orbit. Find the race, make the smallest change that removes it, and run the test twenty times before calling it done.", budgetUsd: 1.5, level: "execute" } },
    ...Array.from({ length: N }, (_, i) => ({ tool: "org_delegate", args: { agent: name(i + 1), task: `Fix the flaky ${tests[i]} test. Done when it passes twenty runs in a row.` } })),
  ],
  reply: `A swarm of ${N} fixers, four each on claude, codex and gemini, one flaky test apiece, $1.50 each from the allowance.\n\nO shows them working around the chief.`,
  costUsd: 0.0091,
}];
fs.writeFileSync(`${dir}/sky-chat.json`, JSON.stringify(chat, null, 2));
const script = [];
for (let i = 1; i <= N; i++) {
  script.push({ agent: name(i), after: 1 + (i % 3), calls: [{ tool: "org_post", args: { to: name(i + 1), text: `Claimed the ${tests[i - 1]} test. Leaving the ${tests[i % N]} test to you.` } }] });
  script.push({ agent: name(i), after: 3 + (i % 2), calls: [{ tool: "org_post", args: { to: i % 4 === 0 ? "chief" : name(i + 5), text: i % 4 === 0 ? `The ${tests[i - 1]} test passes twenty runs in a row.` : `Seeing the same shared timer in test/helpers.ts. Worth a look before you patch.` } }] });
}
script.push({ agent: name(7), after: 2, calls: [{ tool: "org_post", args: { to: "*", text: "Heads up: test/helpers.ts shares one fake clock across files. Reset it in afterEach." } }] });
script.push({ agent: "fixer-*", on: "resume", after: 1, calls: [] });
script.push({ agent: "fixer-*", steps: ["Reading the test and the code under it.", "Running the test fifty times to see the race.", "Found it: a shared timer between cases.", "Isolating the timer per case.", "Twenty runs in a row pass.", "Committing on the agent's branch."], done: "Twenty straight runs pass." });
script.push({ agent: "fixer-*", on: "resume", steps: ["Reading the note.", "Checking test/helpers.ts.", "Resetting the clock in afterEach.", "Twenty runs pass."], done: "Done, with the clock reset." });
fs.writeFileSync(`${dir}/sky.json`, JSON.stringify(script, null, 2));
NODE

cat > "$DEMO/bin/demo-sky" <<'SKY'
#!/bin/bash
cd "$DEMO_PROJECT" || exit 1
export STUB_CHAT="$DEMO/sky-chat.json" STUB_SCRIPT="$DEMO/sky.json" STUB_TURNS=6 STUB_DELAY_MS=850 BASH_SILENCE_DEPRECATION_WARNING=1
exec ceo ui
SKY
chmod +x "$DEMO/bin/demo-sky"

if [ "${1:-}" = "sky" ]; then
  (
    eval "$(bash "$0" env)"
    cd "$PROJECT"
    ceo op init '{}' >/dev/null
    ceo company software --worktrees all >/dev/null
    ceo op mission '{"objective":"Make every test in orbit pass twenty runs in a row","successCriteria":["no flaky test left in CI"]}' >/dev/null
  )
fi

# ---- the evidence recording: three attempts, one check, one winner ------------
# `fixture.sh evidence` hires the software company. The chief is asked for
# three attempts across providers with a check. The check passes only where
# the codex stub writes FIXED into its worktree, so one arm wins.
cat > "$DEMO/evidence-chat.json" <<'JSON'
[
  {
    "match": "flaky",
    "calls": [
      { "tool": "org_delegate", "args": { "agent": "implementer", "task": "Fix the flaky retry test. Done when the suite passes.", "verify": ["test -f FIXED"], "samples": 3 } }
    ],
    "reply": "Three attempts are running, one on each provider.\n\nThe check is test -f FIXED. The task is done only when an attempt passes it.\n\nO shows the attempts around the chief.",
    "costUsd": 0.0064
  }
]
JSON

cat > "$DEMO/evidence.json" <<'JSON'
[
  { "agent": "implementer", "steps": ["Reading src/retry.ts and its test.", "The test fails when the backoff resets early.", "Moving the reset after the last attempt.", "Running the suite.", "Checking the result.", "Change ready."], "done": "Change ready on this arm." }
]
JSON

cat > "$DEMO/bin/demo-evidence" <<'EVIDENCE'
#!/bin/bash
cd "$DEMO_PROJECT" || exit 1
export STUB_CHAT="$DEMO/evidence-chat.json" STUB_SCRIPT="$DEMO/evidence.json" STUB_WRITE_FILE=FIXED STUB_TURNS=6 STUB_DELAY_MS=900 BASH_SILENCE_DEPRECATION_WARNING=1
exec ceo ui
EVIDENCE
chmod +x "$DEMO/bin/demo-evidence"

if [ "${1:-}" = "evidence" ]; then
  (
    eval "$(bash "$0" env)"
    cd "$PROJECT"
    ceo op init '{}' >/dev/null
    ceo company software --worktrees all >/dev/null
    ceo op mission '{"objective":"Make the retry path in orbit reliable without changing its public API","successCriteria":["the flaky test passes ten times in a row"]}' >/dev/null
  )
fi

# ---- an org, for the collaboration recording ----------------------------------
# `fixture.sh org` also hires two agents so the second tape can start on a
# running org with agents on three providers, each at its own level.
if [ "${1:-}" = "org" ]; then
  (
    eval "$(bash "$0" env)"
    cd "$PROJECT"
    ceo op init '{}' >/dev/null
    ceo op hire '{"name":"scout","role":"Survey the codebase and answer questions about how it is structured. Cite file paths and line numbers.","budgetUsd":2,"autonomy":"observe"}' >/dev/null
    ceo op hire '{"name":"coder","role":"Implement what the queue asks for. Match the surrounding conventions and make the smallest change that fully solves the problem.","provider":"codex","budgetUsd":4,"autonomy":"execute","isolated":true}' >/dev/null
    ceo op hire '{"name":"reviewer","role":"Read diffs and flag correctness bugs with the file, the line and a concrete failure scenario.","provider":"gemini","budgetUsd":2,"autonomy":"observe"}' >/dev/null
    ceo op mission '{"objective":"Make the retry path in orbit reliable without changing its public API","successCriteria":["the flaky test passes ten times in a row"]}' >/dev/null
  )
fi

echo "fixture at $DEMO, project $PROJECT"
