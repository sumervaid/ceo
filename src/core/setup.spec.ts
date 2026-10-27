/**
 * Readiness, against the stubs. The stubs answer `--version` and
 * `login status`. A nonexistent binary stands in for "not installed".
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { notReadyReason, providerReadiness, resetReadiness } from "./setup.js";

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "tools");

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetReadiness();
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetReadiness();
  }
}

test("codex: installed and signed in with ChatGPT is ready; an API key is ready with a warning; not logged in is not ready", () => {
  withEnv({ CEO_CODEX_BIN: path.join(TOOLS, "stub-codex"), STUB_CODEX_LOGIN: "chatgpt", OPENAI_API_KEY: undefined }, () => {
    const r = providerReadiness("codex");
    assert.equal(r.installed, true);
    assert.match(r.version ?? "", /stub/);
    assert.equal(r.ready, true);
    assert.equal(r.billing.mode, "subscription");
    assert.equal(notReadyReason("codex"), null);
  });
  withEnv({ CEO_CODEX_BIN: path.join(TOOLS, "stub-codex"), STUB_CODEX_LOGIN: "apikey", OPENAI_API_KEY: undefined }, () => {
    const r = providerReadiness("codex");
    assert.equal(r.ready, true);
    assert.equal(r.billing.mode, "api_key");
    assert.match(r.billing.warning ?? "", /metered/);
  });
  withEnv({ CEO_CODEX_BIN: path.join(TOOLS, "stub-codex"), STUB_CODEX_LOGIN: "none", OPENAI_API_KEY: undefined }, () => {
    const r = providerReadiness("codex");
    assert.equal(r.installed, true);
    assert.equal(r.ready, false);
    assert.match(r.fix[0], /codex login/);
    assert.match(notReadyReason("codex") ?? "", /not signed in/);
  });
});

test("a missing binary is not installed, and the reason says how to install it", () => {
  withEnv({ CEO_CODEX_BIN: "/nonexistent/codex" }, () => {
    const r = providerReadiness("codex");
    assert.equal(r.installed, false);
    assert.equal(r.ready, false);
    assert.match(r.fix[0], /npm i -g @openai\/codex/);
    assert.match(notReadyReason("codex") ?? "", /not installed/);
  });
});

test("claude: a login token in the environment counts as signed in", () => {
  withEnv({ CEO_CLAUDE_BIN: path.join(TOOLS, "stub-claude"), CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: undefined }, () => {
    const r = providerReadiness("claude");
    assert.equal(r.installed, true);
    assert.equal(r.ready, true);
    assert.equal(r.billing.mode, "subscription");
  });
});

test("gemini: the Antigravity CLI counts as signed in when it can list models, and not otherwise", () => {
  withEnv({ CEO_GEMINI_BIN: path.join(TOOLS, "stub-gemini"), STUB_GEMINI_LOGIN: "ok", GEMINI_API_KEY: undefined }, () => {
    const r = providerReadiness("gemini");
    assert.equal(r.installed, true);
    assert.equal(r.ready, true);
    assert.equal(r.billing.mode, "subscription");
  });
  withEnv({ CEO_GEMINI_BIN: path.join(TOOLS, "stub-gemini"), STUB_GEMINI_LOGIN: "none", GEMINI_API_KEY: undefined }, () => {
    const r = providerReadiness("gemini");
    assert.equal(r.ready, false);
    assert.match(r.fix[0], /^agy/);
    assert.match(notReadyReason("gemini") ?? "", /not signed in/);
  });
  withEnv({ CEO_GEMINI_BIN: "/nonexistent/agy" }, () => {
    const r = providerReadiness("gemini");
    assert.equal(r.installed, false);
    assert.match(r.fix[0], /antigravity\.google\/cli\/install\.sh/);
  });
});
