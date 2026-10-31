/**
 * Companies: a whole team hired in one step.
 *
 * A company is a named set of seats. Each seat carries a brief, a provider
 * it prefers, a level, a cap and whether the work it does belongs on a
 * branch of its own. Every company also gets a chief of staff, so the next
 * step after hiring is a sentence in the chat rather than a form.
 *
 * Providers are mixed on purpose. A seat names the provider it prefers, and
 * the plan moves it to the next ready provider when that one is not signed
 * in, and says so. A role is never bound to a vendor. The preference is a
 * starting point the operator changes with `v`.
 *
 * Worktrees are a choice made once for the whole company:
 *
 *   writers   agents that write files get a worktree and a branch, the rest
 *             read the main tree. The default in a git repository.
 *   all       every agent gets one, readers included.
 *   none      everyone works in the main tree.
 *
 * Outside a git repository there are no worktrees, and the plan says why.
 * `i` on the roster gives any agent a worktree later.
 */

import { ensureChief } from "./chat.js";
import { hasCommits, isGitRepo } from "./git.js";
import { append } from "./ledger.js";
import { providerFor } from "./providers.js";
import { hire, readRoster } from "./roster.js";
import { providerReadiness } from "./setup.js";
import { spreadProviders, swarmNames } from "./swarm.js";
import { PROVIDERS, type AutonomyLevel, type Provider } from "./types.js";

export type Seat = {
  name: string;
  brief: string;
  provider: Provider;
  autonomy: AutonomyLevel;
  budgetUsd: number;
  /** The seat writes files, so its work belongs on a branch of its own. */
  writes: boolean;
  collaboration?: string;
};

export type CompanyTemplate = {
  id: string;
  title: string;
  /** One line under the title: what the company is for. */
  tagline: string;
  seats: Seat[];
};

export type WorktreeMode = "writers" | "all" | "none";

export const WORKTREE_MODES: WorktreeMode[] = ["writers", "all", "none"];

export const WORKTREE_LABEL: Record<WorktreeMode, string> = {
  writers: "a worktree for each agent that writes",
  all: "a worktree for every agent",
  none: "everyone in the main tree",
};

const SCOUT: Seat = {
  name: "scout",
  brief: "Survey the codebase and answer questions about how it is structured. Read widely before answering. Cite file paths and line numbers for every claim. Say so when unsure instead of guessing.",
  provider: "claude",
  autonomy: "observe",
  budgetUsd: 2,
  writes: false,
};

const IMPLEMENTER: Seat = {
  name: "implementer",
  brief: "Implement the change the task describes. Match the surrounding conventions. Make the smallest change that fully solves the problem, and run the tests before calling it done.",
  provider: "codex",
  autonomy: "execute",
  budgetUsd: 5,
  writes: true,
  collaboration: "Ask scout where things are before reading widely. Hand finished work to reviewer.",
};

const REVIEWER: Seat = {
  name: "reviewer",
  brief: "Read diffs and flag correctness bugs. Give the file, the line and a concrete failure scenario for each finding. Ignore formatting.",
  provider: "gemini",
  autonomy: "propose",
  budgetUsd: 2,
  writes: false,
  collaboration: "Post findings to the author of the change with org_post.",
};

const TESTER: Seat = {
  name: "tester",
  brief: "Write and run tests for the behaviour described. Cover the failure cases, not just the happy path. Report the actual output. Report a failing test instead of adjusting it to pass.",
  provider: "codex",
  autonomy: "execute",
  budgetUsd: 3,
  writes: true,
};

const DOCUMENTER: Seat = {
  name: "documenter",
  brief: "Keep the documentation true to what the code does. Read the implementation before describing it. Prefer short concrete examples to prose.",
  provider: "claude",
  autonomy: "execute",
  budgetUsd: 2,
  writes: true,
};

export const COMPANIES: CompanyTemplate[] = [
  {
    id: "software",
    title: "Software team",
    tagline: "Features built, tested and reviewed, on three providers",
    seats: [SCOUT, IMPLEMENTER, REVIEWER, TESTER],
  },
  {
    id: "bugs",
    title: "Bug squad",
    tagline: "Find the cause, fix it, prove the fix holds",
    seats: [
      { ...SCOUT, name: "triager", brief: "Reproduce the reported bug and find its cause. Give the failing input, the file and the line. Do not fix it." },
      { ...IMPLEMENTER, name: "fixer", budgetUsd: 4, collaboration: "Start from triager's latest output. Hand the fix to tester." },
      { ...TESTER, provider: "gemini", collaboration: "Add a regression test that fails before the fix and passes after." },
    ],
  },
  {
    id: "review",
    title: "Review desk",
    tagline: "Every diff read three ways, by three providers",
    seats: [
      { ...REVIEWER, name: "correctness", provider: "claude" },
      { ...REVIEWER, name: "security", provider: "codex", brief: "Read diffs for security defects: injection, secrets, unsafe deserialization, missing authorization. Give the file, the line and an exploit scenario for each." },
      { ...REVIEWER, name: "tests", provider: "gemini", brief: "Read diffs for missing or weak tests. Name the behaviour left untested and the test that would catch a regression." },
    ],
  },
  {
    id: "docs",
    title: "Docs studio",
    tagline: "Documentation that matches the code",
    seats: [
      { ...SCOUT, name: "reader", provider: "gemini", brief: "Read the code and list what the documentation gets wrong or leaves out, with file and line for each." },
      { ...DOCUMENTER, name: "writer", collaboration: "Work from reader's latest list. Hand drafts to editor." },
      { ...REVIEWER, name: "editor", provider: "codex", brief: "Edit documentation drafts for accuracy and plain language. Check every claim against the code." },
    ],
  },
  {
    id: "research",
    title: "Research lab",
    tagline: "Answers with sources, checked by a second provider",
    seats: [
      { name: "researcher", provider: "claude", autonomy: "observe", budgetUsd: 3, writes: false, brief: "Research the question with web search. Cite a source URL for every factual claim. Separate what was verified from what was inferred." },
      { name: "analyst", provider: "gemini", autonomy: "propose", budgetUsd: 2, writes: false, brief: "Turn findings into a recommendation with the trade-offs stated. Run small calculations when numbers decide the answer." },
      { name: "checker", provider: "codex", autonomy: "observe", budgetUsd: 2, writes: false, brief: "Check every cited claim against its source. Flag claims the source does not support." },
    ],
  },
  {
    id: "full",
    title: "Full company",
    tagline: "Every role a software project needs, on three providers",
    seats: [SCOUT, IMPLEMENTER, REVIEWER, TESTER, DOCUMENTER],
  },
];

export function findCompany(id: string): CompanyTemplate | undefined {
  const key = id.trim().toLowerCase();
  return COMPANIES.find((c) => c.id === key || c.title.toLowerCase() === key);
}

/** One seat as it will be hired: the provider it lands on, and why. */
export type PlannedSeat = Seat & {
  model: string;
  isolated: boolean;
  /** The provider the seat asked for, when the plan moved it. */
  movedFrom: Provider | null;
  /** Set when the seat is skipped, with the reason. */
  skip: string | null;
  /** The template seat this one copies, when the company is scaled up. */
  group: string;
};

export type CompanyPlan = {
  template: CompanyTemplate;
  worktrees: WorktreeMode;
  /** Worktrees were asked for and are not possible here. */
  worktreeNote: string | null;
  seats: PlannedSeat[];
  /** How many agents each template seat becomes. */
  scale: number;
  /** The chief of staff: hired with the company unless the org has one. */
  chief: { hire: boolean; name: string; provider: Provider };
  /** The sum of the budgets of the seats that will be hired. The chief has no cap. */
  totalCapUsd: number;
  providers: Provider[];
};

/** Whether a provider can run now. A failed check is a provider that cannot. */
function readyNow(p: Provider): boolean {
  if (process.env.CEO_SKIP_SETUP_CHECK) return true;
  try {
    return providerReadiness(p).ready;
  } catch {
    return false;
  }
}

/** The seat's provider if ready, else the next ready one around the cycle, else the seat's own. */
export function landingProvider(preferred: Provider, ready: (p: Provider) => boolean = readyNow): Provider {
  if (ready(preferred)) return preferred;
  const start = PROVIDERS.indexOf(preferred);
  for (let i = 1; i < PROVIDERS.length; i++) {
    const p = PROVIDERS[(start + i) % PROVIDERS.length];
    if (ready(p)) return p;
  }
  return preferred;
}

/** What hiring a company here would do, without doing it. */
/** The largest team size the picker offers. A swarm by count has no limit. */
export const MAX_SCALE = 50;

export function planCompany(
  template: CompanyTemplate,
  cwd?: string,
  opts: { worktrees?: WorktreeMode; ready?: (p: Provider) => boolean; scale?: number } = {},
): CompanyPlan {
  const ready = opts.ready ?? readyNow;
  const repo = isGitRepo(cwd);
  const git = repo && hasCommits(cwd);
  const asked: WorktreeMode = opts.worktrees ?? (git ? "writers" : "none");
  const worktrees: WorktreeMode = git ? asked : "none";
  const worktreeNote = git
    ? null
    : repo
      ? "the repository has no commits yet, so everyone works in the main tree until the first commit"
      : "not a git repository, so everyone works in the main tree";

  const roster = readRoster(cwd).agents;
  const taken = new Set(roster.map((a) => a.name));
  const sitting = roster.find((a) => a.chief);

  // A scaled company turns each seat into a swarm: `coder-01` to `coder-08`,
  // dealt across every ready provider, starting with the seat's own.
  const scale = Math.max(1, Math.min(MAX_SCALE, Math.floor(opts.scale ?? 1)));
  const seats: PlannedSeat[] = template.seats.flatMap((s): PlannedSeat[] => {
    const provider = landingProvider(s.provider, ready);
    const isolated = worktrees === "all" || (worktrees === "writers" && s.writes);
    if (scale === 1) {
      return [{
        ...s,
        provider,
        model: providerFor(provider).defaultModel(),
        isolated,
        movedFrom: provider === s.provider ? null : s.provider,
        skip: taken.has(s.name) ? "already in the org" : null,
        group: s.name,
      }];
    }
    const order = [provider, ...PROVIDERS.filter((p) => p !== provider && ready(p))];
    const names = swarmNames(s.name, scale, taken);
    const spread = spreadProviders(scale, order);
    return names.map((name, i) => ({
      ...s,
      name,
      brief: `${s.brief}\n\nOne of ${scale} ${s.name} agents. Claim work on the board before starting, so two members never do the same piece.`,
      provider: spread[i],
      model: providerFor(spread[i]).defaultModel(),
      isolated,
      movedFrom: i === 0 && provider !== s.provider ? s.provider : null,
      skip: null,
      group: s.name,
    }));
  });

  const chiefProvider = sitting?.provider ?? landingProvider(preferredProviderOf(ready), ready);
  const chief = { hire: !sitting, name: sitting?.name ?? "chief", provider: chiefProvider };
  const totalCapUsd = seats.filter((s) => !s.skip).reduce((n, s) => n + s.budgetUsd, 0);
  const providers = [...new Set([...(chief.hire ? [chief.provider] : []), ...seats.filter((s) => !s.skip).map((s) => s.provider)])];
  return { template, worktrees, worktreeNote, seats, scale, chief, totalCapUsd, providers };
}

function preferredProviderOf(ready: (p: Provider) => boolean): Provider {
  return PROVIDERS.find((p) => ready(p)) ?? "claude";
}

export type CompanyResult = {
  hired: string[];
  skipped: string[];
  /** Seats that could not be hired, each with the reason. */
  failed: string[];
  chief: string | null;
  ms: number;
};

/**
 * Hire every seat in the plan, and the chief of staff when the org has
 * none. A seat that fails, say a worktree git refuses, is reported and the
 * rest are still hired. One note records the company and its seats.
 */
export function hireCompany(plan: CompanyPlan, cwd?: string): CompanyResult {
  const started = Date.now();
  const hired: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  let chief: string | null = null;

  if (plan.chief.hire) {
    try {
      chief = ensureChief(cwd, { provider: plan.chief.provider }).agent.name;
      hired.push(chief);
    } catch (e) {
      failed.push(`chief: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    chief = plan.chief.name;
  }

  for (const s of plan.seats) {
    if (s.skip) {
      skipped.push(s.name);
      continue;
    }
    try {
      hire(
        {
          name: s.name,
          role: s.brief,
          provider: s.provider,
          model: s.model,
          budgetUsd: s.budgetUsd,
          autonomy: s.autonomy,
          isolated: s.isolated,
          collaboration: s.collaboration,
        },
        cwd,
      );
      hired.push(s.name);
    } catch (e) {
      failed.push(`${s.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  append("note", null, {
    kind: "company",
    template: plan.template.id,
    worktrees: plan.worktrees,
    hired,
    skipped,
    failed,
  }, cwd);

  return { hired, skipped, failed, chief, ms: Date.now() - started };
}

/** "5 agents on claude, codex and gemini", counting only who was hired now. */
export function describeHire(result: CompanyResult, plan: CompanyPlan): string {
  const n = result.hired.length;
  if (n === 0) return "nobody new";
  const providerOf = new Map<string, Provider>(plan.seats.map((s) => [s.name, s.provider]));
  if (plan.chief.hire) providerOf.set(plan.chief.name, plan.chief.provider);
  const providers = [...new Set(result.hired.map((h) => providerOf.get(h)).filter((p): p is Provider => Boolean(p)))];
  const on =
    providers.length <= 1
      ? providers[0] ?? "one provider"
      : `${providers.slice(0, -1).join(", ")} and ${providers[providers.length - 1]}`;
  return `${n} agent${n === 1 ? "" : "s"} on ${on}`;
}
