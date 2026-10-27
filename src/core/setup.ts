/**
 * Is a provider ready to run agents?
 *
 * A headless run has nobody at the keyboard. If the CLI is missing, the
 * process fails to spawn. If nobody is signed in, the CLI prints a login
 * prompt to a pipe and exits. Either way the ledger would get a delegation
 * that spent nothing and did nothing. The person finds out from a red
 * line on the run pane rather than from a sentence before they started.
 *
 * So readiness is checked up front, in three places. `ceo setup` prints
 * it. The dashboard opens on it when nothing is ready. The runner
 * refuses to start an agent on a provider that is not ready, before any
 * ledger entry is written. The checks are the same two questions per
 * provider: installed, and signed in. The billing line is added too. It is
 * not a gate, but it is the thing people most want to know before the first run.
 *
 * Nothing here can sign anyone in. Both logins are interactive browser
 * flows owned by the vendor's CLI. `loginCommand()` says what to run and
 * the dashboard opens a window for it.
 */

import { execFileSync } from "node:child_process";

import { billingFor, resetAuthCache, type AuthStatus } from "./auth.js";
import { reflexStatus, resetReflexStatus } from "./reflex.js";
import { providerFor } from "./providers.js";
import { PROVIDERS, type Provider } from "./types.js";

export type Readiness = {
  provider: Provider;
  /** The binary the runner would spawn. */
  binary: string;
  installed: boolean;
  /** `--version` output when installed. */
  version: string | null;
  signedIn: boolean;
  billing: AuthStatus;
  /** Installed and signed in. */
  ready: boolean;
  /** What to do, in order, when not ready. Empty when ready. */
  fix: string[];
};

const INSTALL: Record<Provider, string> = {
  claude: "npm i -g @anthropic-ai/claude-code",
  codex: "npm i -g @openai/codex",
  gemini: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
};

/** The interactive command that signs a provider in. */
export function loginCommand(provider: Provider): string {
  // `claude` has no separate login verb: the first interactive start asks.
  if (provider === "claude") return "claude";
  if (provider === "gemini") return "agy";
  return "codex login";
}

function versionOf(binary: string): string | null {
  try {
    const out = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().split("\n")[0] || "installed";
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // A binary that exists but dislikes --version is still installed.
    if (err.code === "ENOENT") return null;
    return "installed";
  }
}

const memo = new Map<Provider, Readiness>();

/** Drop memoised answers, after the user has installed or signed in. */
export function resetReadiness(): void {
  memo.clear();
  resetAuthCache();
  resetReflexStatus();
}

export function providerReadiness(provider: Provider, env: NodeJS.ProcessEnv = process.env): Readiness {
  const hit = memo.get(provider);
  if (hit) return hit;

  const spec = providerFor(provider);
  const binary = spec.binary();
  const version = versionOf(binary);
  const installed = version !== null;
  const billing = billingFor(provider, env);
  // "unknown" means the config could not be read, which for a headless run
  // is indistinguishable from not signed in: the CLI will ask, and nobody
  // will answer.
  const signedIn = installed && billing.mode !== "unknown";

  const fix: string[] = [];
  if (!installed) {
    fix.push(`${INSTALL[provider]}    or set CEO_${provider.toUpperCase()}_BIN to the binary`);
  }
  if (installed && !signedIn) {
    fix.push(
      provider === "claude"
        ? "claude    run it once interactively and sign in; or export CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`"
        : provider === "gemini"
          ? "agy    run it once in a terminal and finish the Google sign-in in the browser it opens"
          : "codex login    for a ChatGPT plan, or `codex login --with-api-key` for a metered account",
    );
  }

  const r: Readiness = { provider, binary, installed, version, signedIn, billing, ready: installed && signedIn, fix };
  memo.set(provider, r);
  return r;
}

export function allReadiness(env: NodeJS.ProcessEnv = process.env): Readiness[] {
  return PROVIDERS.map((p) => providerReadiness(p, env));
}

/** True when at least one provider can run an agent. */
export function anyReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return allReadiness(env).some((r) => r.ready);
}

/**
 * The sentence the runner and the hire form refuse with. Null when ready.
 * One line, because it lands on a status bar and in a `failed` event.
 */
export function notReadyReason(provider: Provider, env: NodeJS.ProcessEnv = process.env): string | null {
  const r = providerReadiness(provider, env);
  if (r.ready) return null;
  if (!r.installed) return `${provider} is not installed: ${r.binary} is not on PATH. ${INSTALL[provider]}, then press S for setup.`;
  return `${provider} is not signed in. Run \`${loginCommand(provider)}\`, then press S for setup.`;
}

/** The checklist, as text, for `ceo setup` and the install script. */
export function renderSetup(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const all = allReadiness(env);
  for (const r of all) {
    out.push(`${r.ready ? "✓" : "✗"} ${r.provider}  ${r.ready ? "ready" : "not ready"}`);
    out.push(`    installed  ${r.installed ? `yes, ${r.version}` : `no, ${r.binary} not found`}`);
    out.push(`    signed in  ${!r.installed ? "-" : r.signedIn ? "yes" : "no"}`);
    out.push(`    ${r.billing.summary}`);
    if (r.billing.warning && r.ready) out.push(`    ! ${r.billing.warning}`);
    for (const f of r.fix) out.push(`    next: ${f}`);
    out.push("");
  }
  // Reflex is optional and never gates a run. It is on the checklist because
  // the suggested team is only as good as the history it can read.
  const rx = reflexStatus(env);
  out.push(`${rx.scanned ? "✓" : "·"} ${rx.summary}`);
  if (rx.fix) out.push(`    next: ${rx.fix}`);
  out.push("");
  const ready = all.filter((r) => r.ready).map((r) => r.provider);
  out.push(ready.length === 0
    ? "No provider is ready. Agents cannot run until one is: follow the next steps above, then run `ceo setup` again."
    : `Agents can run on: ${ready.join(", ")}. Every run bills the account named above.`);
  return out;
}
