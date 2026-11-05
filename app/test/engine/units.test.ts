import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decideNext } from "../../src/engine/decide";
import { parsePatch } from "../../src/engine/gitops";
import { licenseState, readKey, TRIAL_DAYS } from "../../src/engine/license";
import { pickName, STARS } from "../../src/engine/names";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const issue = (payload: object): string => {
  const head = `CEO1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${head}.${sign(null, Buffer.from(head), privateKey).toString("base64url")}`;
};
const DAY = 86400000;

describe("license", () => {
  const good = { email: "a@b.c", plan: "pro", id: "1", issuedAt: 0, expiresAt: null };
  it("accepts a signed key and refuses a changed one", () => {
    expect(readKey(issue(good), PEM).email).toBe("a@b.c");
    const k = issue(good).split(".");
    k[1] = Buffer.from(JSON.stringify({ ...good, email: "x@y.z" })).toString("base64url");
    expect(() => readKey(k.join("."), PEM)).toThrow(/not valid/);
    expect(() => readKey("hello", PEM)).toThrow(/not a CEO/);
  });
  it("moves from trial to free, and pro stays pro", () => {
    const now = Date.now();
    expect(licenseState({ key: null, firstRunAt: now, now, publicKeyPem: PEM }).plan).toBe("trial");
    const free = licenseState({ key: null, firstRunAt: now - (TRIAL_DAYS + 1) * DAY, now, publicKeyPem: PEM });
    expect(free.plan).toBe("free");
    expect(free.limits.activeWorkspaces).toBe(3);
    expect(free.limits.race).toBe(false);
    expect(licenseState({ key: issue(good), firstRunAt: 0, now, publicKeyPem: PEM }).plan).toBe("pro");
  });
  it("an expired key falls back and says why", () => {
    const now = Date.now();
    const s = licenseState({ key: issue({ ...good, expiresAt: now - 1 }), firstRunAt: 0, now, publicKeyPem: PEM });
    expect(s.plan).toBe("free");
    expect(s.error).toMatch(/expired/);
  });
});

const G = { added: 1, removed: 0, files: 1, ahead: 1, behind: 0, dirty: false, conflicts: [] as string[] };
const PR = { number: 1, url: "u", state: "OPEN" as const, isDraft: false, mergeable: "MERGEABLE", reviewDecision: "" };
const base = { running: false, hasRemote: true, ghReady: true, git: G, pr: null, runs: [], reviews: [], merged: false };

describe("next action", () => {
  it("follows the path from no change to archive", () => {
    expect(decideNext({ ...base, git: { ...G, files: 0, ahead: 0 } }).next).toBe("start");
    expect(decideNext({ ...base, running: true }).next).toBe("wait");
    expect(decideNext({ ...base, git: { ...G, conflicts: ["a"] } }).next).toBe("resolve-conflicts");
    expect(decideNext(base).next).toBe("create-pr");
    expect(decideNext({ ...base, hasRemote: false }).next).toBe("merge-local");
    expect(decideNext({ ...base, pr: PR, runs: [{ name: "ci", state: "fail", url: null, detail: null }] }).next).toBe("fix-checks");
    expect(decideNext({ ...base, pr: PR, reviews: [{ id: "1", author: "m", body: "x", path: null, line: null, url: null }] }).next).toBe("respond");
    expect(decideNext({ ...base, pr: PR, runs: [{ name: "ci", state: "running", url: null, detail: null }] }).next).toBe("wait");
    expect(decideNext({ ...base, pr: PR }).next).toBe("merge");
    expect(decideNext({ ...base, pr: { ...PR, state: "MERGED" } }).next).toBe("archive");
  });
});

describe("patch parser", () => {
  it("reads numbers, renames, deletions and binaries", () => {
    const files = parsePatch([
      "diff --git a/a.ts b/a.ts", "index 1..2 100644", "--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,2 @@", " keep", "-old", "+new",
      "diff --git a/old.ts b/new.ts", "similarity index 100%", "rename from old.ts", "rename to new.ts",
      "diff --git a/gone.ts b/gone.ts", "deleted file mode 100644", "--- a/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
      "diff --git a/i.png b/i.png", "Binary files a/i.png and b/i.png differ",
    ].join("\n"));
    expect(files.map((f) => [f.path, f.status])).toEqual([["a.ts", "modified"], ["new.ts", "renamed"], ["gone.ts", "deleted"], ["i.png", "modified"]]);
    expect(files[0]!.hunks[0]!.lines.map((l) => [l.t, l.o, l.n])).toEqual([["ctx", 1, 1], ["del", 2, null], ["add", null, 2]]);
    expect(files[1]!.oldPath).toBe("old.ts");
    expect(files[3]!.binary).toBe(true);
  });
});

describe("names", () => {
  it("never repeats", () => {
    expect(pickName(new Set())).toBe("vega");
    expect(pickName(new Set(STARS))).toBe("vega-2");
  });
});
