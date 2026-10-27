/**
 * The roster's reconfigure path, for the provider switch: everything but
 * the provider and model survives, and the history is one more event.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { initLedger, readLedger, verify } from "./ledger.js";
import { findAgent, hire, reconfigure, setBudget } from "./roster.js";

test("moving an agent to another provider keeps its brief, budget, level and spend history", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ceo-roster-"));
  try {
    initLedger(dir);
    hire({ name: "scout", role: "Survey the codebase and answer questions about it.", budgetUsd: 3, autonomy: "observe", guardrails: ["never edit files"] }, dir);
    setBudget("scout", 5, dir);
    const before = findAgent("scout", dir)!;
    assert.equal(before.provider, "claude");

    const after = reconfigure("scout", { provider: "gemini", model: "gemini" }, dir);
    assert.equal(after.provider, "gemini");
    assert.equal(after.model, "gemini");
    assert.equal(after.role, before.role);
    assert.equal(after.budgetUsd, 5);
    assert.equal(after.autonomy, "observe");
    assert.deepEqual(after.guardrails, ["never edit files"]);
    assert.equal(after.hiredAt, before.hiredAt);

    const config = readLedger(dir).filter((e) => e.type === "agent_config");
    assert.equal(config.length, 1);
    assert.equal(config[0].data.provider, "gemini");
    assert.equal(verify(dir).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
