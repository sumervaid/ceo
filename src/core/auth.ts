/**
 * Which account an agent run will be billed to.
 *
 * `ceo` never holds credentials of its own. It shells out to `claude`, so
 * runs are billed exactly the way that user's Claude Code is billed. For
 * almost everyone that means their Claude subscription, which is the
 * behaviour people expect and the reason this tool does not ask for an API
 * key at install.
 *
 * The case worth catching is the other one. If ANTHROPIC_API_KEY is set in
 * the environment, `claude` may use it instead of the OAuth session, and
 * that bills a metered API account rather than drawing on a subscription.
 * Somebody who set that variable months ago for an unrelated script should
 * not discover the difference on a monthly invoice, so the app states which
 * account it is about to spend on rather than leaving it implicit.
 *
 * Reading ~/.claude.json here is a deliberate compromise: it is Claude
 * Code's own config, not ours, and its shape could change. Everything is
 * defensive and a failure to read it degrades to "unknown" rather than
 * blocking a run.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

import { providerFor } from "./providers.js";
import type { Provider } from "./types.js";

export type BillingMode = "subscription" | "api_key" | "unknown";

export type AuthStatus = {
  mode: BillingMode;
  /** Account email when we can see it. */
  account: string | null;
  /** e.g. "stripe_subscription" */
  billingType: string | null;
  /** True when usage past the plan allowance bills to a card. */
  extraUsageEnabled: boolean;
  /** Name of the env var that would redirect billing, when one is set. */
  apiKeyEnvVar: string | null;
  /** One line suitable for a status bar or a run confirmation. */
  summary: string;
  /** Set when the user should look at this before running anything. */
  warning: string | null;
};

const API_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/** A long-lived login token (`claude setup-token`), used by CI and headless hosts. */
const OAUTH_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";

function readClaudeConfig(): Record<string, unknown> | null {
  const p = path.join(homedir(), ".claude.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function authStatus(env: NodeJS.ProcessEnv = process.env): AuthStatus {
  const apiKeyEnvVar = API_KEY_VARS.find((v) => (env[v] ?? "").trim()) ?? null;

  const cfg = readClaudeConfig();
  const oauth = (cfg?.oauthAccount ?? null) as Record<string, unknown> | null;
  const account = typeof oauth?.emailAddress === "string" ? oauth.emailAddress : null;
  const billingType =
    typeof oauth?.billingType === "string" ? oauth.billingType : null;
  const extraUsageEnabled = Boolean(
    oauth?.hasExtraUsageEnabled ?? cfg?.hasExtraUsageEnabled ?? false,
  );

  // An API key in the environment takes precedence in the report even when
  // an OAuth session also exists, because it is the case that can bill
  // somewhere the user is not expecting.
  if (apiKeyEnvVar) {
    return {
      mode: "api_key",
      account,
      billingType,
      extraUsageEnabled,
      apiKeyEnvVar,
      summary: `billing: metered API account, ${apiKeyEnvVar} is set`,
      warning:
        `${apiKeyEnvVar} is set in this environment, so agent runs may bill a metered API account rather than a Claude subscription. Unsetting the variable runs agents on the subscription instead.`,
    };
  }

  if ((env[OAUTH_TOKEN_VAR] ?? "").trim()) {
    return {
      mode: "subscription",
      account,
      billingType,
      extraUsageEnabled,
      apiKeyEnvVar: null,
      summary: `billing: Claude login via ${OAUTH_TOKEN_VAR}${account ? `, ${account}` : ""}`,
      warning: null,
    };
  }

  if (oauth && account) {
    return {
      mode: "subscription",
      account,
      billingType,
      extraUsageEnabled,
      apiKeyEnvVar: null,
      summary: `billing: ${account}'s Claude subscription`,
      warning: extraUsageEnabled
        ? null
        : null,
    };
  }

  return {
    mode: "unknown",
    account: null,
    billingType: null,
    extraUsageEnabled: false,
    apiKeyEnvVar: null,
    summary: "billing: unknown, could not read Claude Code's account config",
    warning:
      "Could not determine which account agent runs will bill. Run `claude` once to sign in, or check ~/.claude.json.",
  };
}

/**
 * Longer explanation for a first-run screen. Says plainly whose money is
 * about to be spent, because an app that runs models on someone's behalf
 * should never make that a thing they have to infer.
 */
export function billingExplainer(status: AuthStatus): string[] {
  const lines: string[] = [];

  if (status.mode === "subscription") {
    lines.push(`Agent runs use ${status.account}'s Claude Code login.`);
    lines.push(
      "CEO holds no model credential. Agent runs go through the `claude` CLI.",
    );
    lines.push("Usage bills exactly as Claude Code usage on that login bills.");
    if (status.extraUsageEnabled) {
      lines.push("");
      lines.push(
        "Extra usage is enabled on that account. Usage past the plan allowance",
      );
      lines.push("bills to the card on file.");
    }
  } else if (status.mode === "api_key") {
    lines.push(`${status.apiKeyEnvVar} is set in this environment.`);
    lines.push(
      "Agent runs may bill a metered API account rather than a subscription.",
    );
    lines.push("");
    lines.push(`Unsetting the variable restores the Claude login:`);
    lines.push(`  unset ${status.apiKeyEnvVar}`);
  } else {
    lines.push("Could not tell which account agent runs will bill.");
    lines.push("Run `claude` once to sign in, then try again.");
  }

  return lines;
}

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

/**
 * Which account a codex run bills to. `codex login status` says "Logged in
 * using ChatGPT" for a subscription and "Logged in using an API key" for a
 * metered one. OPENAI_API_KEY in the environment also redirects billing.
 * The answer is memoised per process: it is a subprocess call, and the
 * dashboard asks on every hire form.
 */
let codexMemo: AuthStatus | null = null;

/** Forget the memoised codex answer, after a login the user just completed. */
export function resetAuthCache(): void {
  codexMemo = null;
  geminiMemo = null;
}

export function codexAuthStatus(env: NodeJS.ProcessEnv = process.env): AuthStatus {
  if (codexMemo) return codexMemo;
  const apiKeyEnvVar = (env.OPENAI_API_KEY ?? "").trim() ? "OPENAI_API_KEY" : null;
  const binary = providerFor("codex").binary();

  // codex writes the status line to stderr, so both streams are read
  // whatever the exit code. "Not logged in" exits 1.
  const run = spawnSync(binary, ["login", "status"], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  const installed = (run.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT";
  const report = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;

  let status: AuthStatus;
  if (!installed) {
    status = {
      mode: "unknown", account: null, billingType: null, extraUsageEnabled: false, apiKeyEnvVar,
      summary: "codex: not installed",
      warning: "codex is not on PATH, so codex agents cannot run. Install with: npm i -g @openai/codex",
    };
  } else if (apiKeyEnvVar || /api key/i.test(report)) {
    status = {
      mode: "api_key", account: null, billingType: null, extraUsageEnabled: false, apiKeyEnvVar,
      summary: "codex billing: metered OpenAI API account",
      warning:
        "codex is signed in with an API key, so codex agents bill a metered OpenAI account per token, not a ChatGPT subscription. `codex login` with ChatGPT to change that.",
    };
  } else if (/chatgpt/i.test(report)) {
    const m = /\(([^)]*@[^)]*)\)/.exec(report);
    status = {
      mode: "subscription", account: m ? m[1] : null, billingType: "chatgpt", extraUsageEnabled: false, apiKeyEnvVar: null,
      summary: `codex billing: ChatGPT subscription${m ? `, ${m[1]}` : ""}`,
      warning: null,
    };
  } else {
    status = {
      mode: "unknown", account: null, billingType: null, extraUsageEnabled: false, apiKeyEnvVar,
      summary: "codex billing: not signed in",
      warning: "codex is installed but not signed in. codex agents will fail until `codex login` runs.",
    };
  }
  codexMemo = status;
  return status;
}

// ---------------------------------------------------------------------------
// gemini, through the Antigravity CLI
// ---------------------------------------------------------------------------

let geminiMemo: AuthStatus | null = null;

/**
 * Which account a gemini run bills to. The Antigravity CLI keeps its token
 * in the OS keyring and has no status command, so the check asks it for
 * the model list: a signed-in CLI prints slugs, a signed-out one says to
 * sign in. That is one short network call, memoised per process.
 * GEMINI_API_KEY means a metered key, but only when the CLI's settings also
 * set modelProvider to gemini; the warning says so.
 */
export function geminiAuthStatus(env: NodeJS.ProcessEnv = process.env): AuthStatus {
  if (geminiMemo) return geminiMemo;
  const apiKeyEnvVar = (env.GEMINI_API_KEY ?? "").trim() ? "GEMINI_API_KEY" : null;
  const binary = providerFor("gemini").binary();
  const run = spawnSync(binary, ["models"], {
    encoding: "utf8",
    timeout: 20000,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  const installed = (run.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT";
  const report = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const signedIn = installed && run.status === 0 && !/sign in/i.test(report);

  let status: AuthStatus;
  if (!installed) {
    status = {
      mode: "unknown", account: null, billingType: null, extraUsageEnabled: false, apiKeyEnvVar,
      summary: "gemini: the Antigravity CLI (agy) is not installed",
      warning: "agy is not on PATH, so gemini agents cannot run. Install with: curl -fsSL https://antigravity.google/cli/install.sh | bash",
    };
  } else if (apiKeyEnvVar) {
    status = {
      mode: "api_key", account: null, billingType: null, extraUsageEnabled: false, apiKeyEnvVar,
      summary: "gemini billing: metered Google AI key (GEMINI_API_KEY)",
      warning:
        "GEMINI_API_KEY is set. The Antigravity CLI uses it only when ~/.gemini/antigravity-cli/settings.json sets modelProvider to gemini; then gemini agents bill that key per token.",
    };
  } else if (signedIn) {
    status = {
      mode: "subscription", account: null, billingType: "google", extraUsageEnabled: false, apiKeyEnvVar: null,
      summary: "gemini billing: the signed-in Google account, through the Antigravity CLI",
      warning: null,
    };
  } else {
    status = {
      mode: "unknown", account: null, billingType: null, extraUsageEnabled: false, apiKeyEnvVar,
      summary: "gemini billing: not signed in",
      warning: "The Antigravity CLI is installed but not signed in. Run `agy` in a terminal and finish the browser sign-in; headless runs cannot open the browser.",
    };
  }
  geminiMemo = status;
  return status;
}

/** Billing for whichever provider an agent runs on. */
export function billingFor(provider: Provider, env: NodeJS.ProcessEnv = process.env): AuthStatus {
  if (provider === "codex") return codexAuthStatus(env);
  if (provider === "gemini") return geminiAuthStatus(env);
  return authStatus(env);
}

/** The explainer, for gemini. */
export function geminiBillingExplainer(status: AuthStatus): string[] {
  if (status.mode === "subscription") {
    return ["gemini agents run under the Google account signed in to the Antigravity CLI. Runs draw on that account's quota."];
  }
  if (status.mode === "api_key") {
    return ["gemini agents bill a metered Google AI key per token.", "CEO costs each run from list prices and records the figure as an estimate."];
  }
  return [status.summary];
}

/** The explainer, for codex. */
export function codexBillingExplainer(status: AuthStatus): string[] {
  const lines: string[] = [];
  if (status.mode === "subscription") {
    lines.push("codex agents run under the ChatGPT login. Runs draw on that plan.");
  } else if (status.mode === "api_key") {
    lines.push("codex agents bill a metered OpenAI API account per token.");
    lines.push("CEO costs each run from list prices, since codex reports tokens, not dollars,");
    lines.push("and records the figure as an estimate.");
  } else {
    lines.push(status.summary);
  }
  return lines;
}
