/**
 * Registry behaviour under a throwaway CEO_HOME.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { initLedger } from "./ledger.js";
import {
  addWorkspace,
  ensureCurrentWorkspace,
  listWorkspaces,
  readRegistry,
  registryPath,
  removeWorkspace,
  renameWorkspace,
  touchWorkspace,
} from "./workspaces.js";

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(path.join(tmpdir(), "ceo-home-"));
  const prev = process.env.CEO_HOME;
  process.env.CEO_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.CEO_HOME;
    else process.env.CEO_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

test("add is idempotent, names deduplicate, remove forgets only the path", () =>
  withHome((home) => {
    const a = path.join(home, "proj", "api");
    const b = path.join(home, "other", "api");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });

    const first = addWorkspace(a);
    assert.equal(first.name, "api");
    assert.equal(addWorkspace(a).path, first.path);
    assert.equal(readRegistry().workspaces.length, 1);

    const second = addWorkspace(b);
    assert.equal(second.name, "api-2");
    assert.equal(existsSync(registryPath()), true);

    assert.equal(removeWorkspace(a), true);
    assert.equal(removeWorkspace(a), false);
    assert.equal(existsSync(a), true);
    assert.deepEqual(listWorkspaces().map((w) => w.name), ["api-2"]);
  }));

test("a missing directory is refused", () =>
  withHome((home) => {
    assert.throws(() => addWorkspace(path.join(home, "nope")), /No such directory/);
  }));

test("touch orders most recently opened first; rename keeps names unique", () =>
  withHome((home) => {
    const a = path.join(home, "a");
    const b = path.join(home, "b");
    mkdirSync(a);
    mkdirSync(b);
    addWorkspace(a);
    addWorkspace(b);
    assert.deepEqual(listWorkspaces().map((w) => w.name), ["a", "b"]);
    touchWorkspace(b);
    assert.deepEqual(listWorkspaces().map((w) => w.name), ["b", "a"]);
    renameWorkspace(a, "b");
    assert.deepEqual(listWorkspaces().map((w) => w.name).sort(), ["b", "b-2"]);
  }));

test("ensureCurrentWorkspace registers only directories that have an org", () =>
  withHome((home) => {
    const bare = path.join(home, "bare");
    const org = path.join(home, "org");
    mkdirSync(bare);
    mkdirSync(org);
    assert.equal(ensureCurrentWorkspace(bare), null);
    initLedger(org);
    assert.equal(ensureCurrentWorkspace(org)?.path, org);
    assert.equal(ensureCurrentWorkspace(org)?.path, org);
    assert.equal(readRegistry().workspaces.length, 1);
  }));
