#!/usr/bin/env node
// keygen writes .secrets/license.pem and puts the public key into the app.
// issue signs a key: node tools/license.mjs issue buyer@example.com [days]
import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const SECRET = new URL("../.secrets/license.pem", import.meta.url);
const SOURCE = new URL("../src/engine/license.ts", import.meta.url);
const [cmd, email, days] = process.argv.slice(2);

if (cmd === "keygen") {
  if (existsSync(SECRET)) { console.error("A signing key already exists. Replacing the key voids every issued license."); process.exit(1); }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  mkdirSync(new URL("../.secrets/", import.meta.url), { recursive: true });
  writeFileSync(SECRET, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const pem = publicKey.export({ type: "spki", format: "pem" }).trim().replace(/\n/g, "\\n");
  const src = readFileSync(SOURCE, "utf8").replace(/export const LICENSE_PUBLIC_KEY = ".*";/, `export const LICENSE_PUBLIC_KEY = "${pem}";`);
  writeFileSync(SOURCE, src);
  console.log("Signing key written to .secrets/license.pem. Public key written into the app.");
} else if (cmd === "issue" && email) {
  const payload = { email, plan: "pro", id: randomUUID(), issuedAt: Date.now(), expiresAt: days ? Date.now() + Number(days) * 86400000 : null };
  const head = `CEO1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const sig = sign(null, Buffer.from(head), createPrivateKey(readFileSync(SECRET)));
  console.log(`${head}.${sig.toString("base64url")}`);
} else {
  console.error("license.mjs keygen | issue <email> [days]");
  process.exit(1);
}
