/**
 * Plans and license keys. A key is `CEO1.<payload>.<signature>`, signed
 * offline with Ed25519. The app holds the public key only. Nothing phones home.
 */
import { createPublicKey, verify } from "node:crypto";

import type { LicenseState } from "../shared/api";

/** Written by `npm run license:keygen`. The matching private key signs every license, and stays out of git. */
export const LICENSE_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAg1txuRT7auRKkJ3mO0dlwjWkWDl7kjv0mFCSa6vFklE=\n-----END PUBLIC KEY-----";
/** Set at build time. A Finder launch has no environment to read it from. */
export const CHECKOUT_URL: string = process.env.CEO_CHECKOUT_URL ?? "";
export const TRIAL_DAYS = 14;
export const FREE_ACTIVE_WORKSPACES = 3;
export const FREE_TEAM_AGENTS = 3;

const DAY = 86400000;

export type KeyPayload = { email: string; plan: "pro"; id: string; issuedAt: number; expiresAt: number | null };

export function readKey(key: string, publicKeyPem: string = LICENSE_PUBLIC_KEY): KeyPayload {
  const parts = key.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "CEO1") throw new Error("That is not a CEO license key.");
  let ok = false;
  try {
    ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey(publicKeyPem), Buffer.from(parts[2]!, "base64url"));
  } catch {
    throw new Error("That license key could not be checked.");
  }
  if (!ok) throw new Error("That license key is not valid.");
  const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as KeyPayload;
  if (payload.plan !== "pro" || typeof payload.email !== "string") throw new Error("That license key is not valid.");
  return payload;
}

export function licenseState(input: { key: string | null; firstRunAt: number; now?: number; publicKeyPem?: string }): LicenseState {
  const now = input.now ?? Date.now();
  const trialEndsAt = input.firstRunAt + TRIAL_DAYS * DAY;
  const trialDaysLeft = Math.max(0, Math.ceil((trialEndsAt - now) / DAY));
  const paid = { activeWorkspaces: null, race: true, planner: true, insights: true, exportData: true, teamAgents: null, chief: true, companies: true, attempts: true };
  const base = { trialEndsAt, trialDaysLeft, checkoutUrl: CHECKOUT_URL };
  let error: string | null = null;
  if (input.key) {
    try {
      const p = readKey(input.key, input.publicKeyPem);
      if (p.expiresAt && p.expiresAt < now) error = "This license has expired.";
      else return { ...base, plan: "pro", email: p.email, expiresAt: p.expiresAt, limits: paid, error: null };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  if (trialDaysLeft > 0) return { ...base, plan: "trial", email: null, expiresAt: null, limits: paid, error };
  return {
    ...base,
    plan: "free",
    email: null,
    expiresAt: null,
    limits: { activeWorkspaces: FREE_ACTIVE_WORKSPACES, race: false, planner: false, insights: false, exportData: false, teamAgents: FREE_TEAM_AGENTS, chief: false, companies: false, attempts: false },
    error,
  };
}
