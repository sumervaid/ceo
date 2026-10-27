#!/usr/bin/env node
/**
 * The `ceo` binary.
 *
 *   ceo                 attach to the persistent dashboard in tmux, else run it here
 *   ceo ui              run the dashboard in this terminal, no tmux
 *   ceo chat            the dashboard, opened on the chat with the chief of staff
 *   ceo open            open the dashboard beside the current session
 *   ceo shell <agent>   open a tmux window in an agent's worktree
 *   ceo snapshot        print a static text org view and exit
 *   ceo status          print the one-line status and exit
 *   ceo workspace …     list / add / remove registered repos
 *   ceo task …          list / add / update queue tasks
 *   ceo billing         which account agent runs bill to
 *
 * The bare `ceo` is the front door. With tmux installed it starts one session
 * named `ceo` whose first window is the dashboard and attaches to it, so the
 * agents the dashboard is running survive the terminal that started them.
 * Run it again from anywhere and you are back in the same session. Without
 * tmux it falls back to a foreground dashboard, which is the same program
 * minus the persistence.
 *
 * `ceo open` finds the best available second surface and starts the
 * dashboard there: a tmux split, otherwise a new terminal window. That is for
 * the case where the caller's own terminal is busy with an editor, a Claude
 * Code session, or a script.
 *
 * Agents run as headless CLIs the dashboard spawns itself: `claude -p`,
 * `codex exec` or `agy -p`, by the agent's provider. `ceo billing` names the
 * account each one draws on.
 */

import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runOp, snapshotJson } from "./bridge.js";
import { renderSnapshot } from "./tui/snapshot.js";
import { readOrgState } from "./tui/data.js";
import { compactBudget, compactUsd } from "./tui/format.js";
import { COMPANIES, describeHire, findCompany, hireCompany, planCompany, WORKTREE_MODES, type WorktreeMode } from "./core/companies.js";
import { addContext, findContext, giveContext, listContext, refreshContext, removeContext, takeContext, tokenLabel } from "./core/context.js";
import { approveWorkflow, skillCatalog } from "./core/skills.js";
import { ghBinary, githubStatus, listIssues, openPullRequest, resetGithubStatus } from "./core/github.js";
import { hfCard, hfPaper, hfStatus, parseHfSource } from "./core/huggingface.js";
import { ALERT_KINDS, ALERT_LABEL, alertsPath, describeChannels, readAlerts, sendAlert, writeAlerts, type AlertKind } from "./core/alerts.js";
import { authStatus, billingExplainer, codexAuthStatus, codexBillingExplainer, geminiAuthStatus, geminiBillingExplainer } from "./core/auth.js";
import { anyReady, loginCommand, renderSetup, resetReadiness } from "./core/setup.js";
import { renderProposal, suggestTeam } from "./core/suggest.js";
import { describeMessage, liveRuns, messages as readMessages, postMessage, traceFor, YOU } from "./core/collab.js";
import { reflexScanCommand, reflexStatus, resetReflexStatus } from "./core/reflex.js";
import { hire } from "./core/roster.js";
import { initLedger } from "./core/ledger.js";
import { PROVIDERS, type Provider } from "./core/types.js";
import { readRoster } from "./core/roster.js";
import { findAgent } from "./core/roster.js";
import { orgExists, projectRoot } from "./core/paths.js";
import { workdirFor } from "./core/runner.js";
import {
  addTask,
  listTasks,
  taskCounts,
  updateTask,
  type TaskPriority,
  type TaskStoredStatus,
} from "./core/tasks.js";
import {
  attach,
  describeHost,
  ensureSession,
  hasTmux,
  inTmux,
  openWindow,
  SESSION,
  sessionExists,
  shellQuote,
  splitBeside,
} from "./core/tmux.js";
import {
  addWorkspace,
  ensureCurrentWorkspace,
  listWorkspaces,
  registryPath,
  removeWorkspace,
} from "./core/workspaces.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TUI_ENTRY = path.join(HERE, "tui", "index.js");

/** The dashboard command as a shell string, for tmux to run. */
function dashboardCommand(): string {
  const env = process.env.CEO_HOME ? `CEO_HOME=${shellQuote(process.env.CEO_HOME)} ` : "";
  return `${env}${shellQuote(process.execPath)} ${shellQuote(TUI_ENTRY)}`;
}

function statusLine(cwd: string): string {
  const s = readOrgState(cwd);
  if (!s.exists) return "No org in this project. Run `ceo` and press n to start one.";
  const agents = s.roster?.agents.length ?? 0;
  const total = s.rollup?.totalUsd ?? 0;
  const count = s.rollup?.delegationCount ?? 0;
  const dangling = (s.delegations ?? []).filter((d) => !d.complete).length;
  const counts = taskCounts(s.tasks);
  const bits = [
    `${agents} agent${agents === 1 ? "" : "s"}`,
    `${compactUsd(total)} today, ${count} delegation${count === 1 ? "" : "s"}`,
  ];
  if (counts.queued + counts.blocked + counts.running > 0) {
    bits.push(
      `queue: ${counts.running} running · ${counts.queued} queued · ${counts.blocked} blocked`,
    );
  }
  if (dangling > 0) bits.push(`${dangling} dangling`);
  if (s.verifyResult && !s.verifyResult.ok) bits.push("LEDGER CHAIN BROKEN");
  return bits.join(" · ");
}

/** Run the dashboard in this terminal, inheriting stdio. `view` opens it on the chat. */
function runUi(cwd: string, view?: "chat"): void {
  const child = spawn(process.execPath, [TUI_ENTRY], {
    cwd,
    stdio: "inherit",
    env: view ? { ...process.env, CEO_VIEW: view } : process.env,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

/**
 * The front door. Start the `ceo` tmux session with the dashboard in it if
 * it is not already running, then attach. From inside tmux this is a
 * switch-client, so `ceo` typed in any window of any session lands on the
 * dashboard.
 */
function attachOrRun(cwd: string): void {
  ensureCurrentWorkspace(cwd);
  if (!hasTmux()) {
    process.stderr.write(
      "tmux is not installed, so the dashboard runs in the foreground. With tmux installed, agents keep running after the terminal closes.\n",
    );
    runUi(cwd);
    return;
  }
  const started = ensureSession({ cwd, command: dashboardCommand() });
  if (!started.ok) {
    process.stderr.write(`Could not start the ${SESSION} tmux session: ${started.error}\nFalling back to a foreground dashboard.\n`);
    runUi(cwd);
    return;
  }
  if (started.created) process.stdout.write(`Started tmux session ${SESSION} with the dashboard.\n`);
  const r = attach();
  if (!r.ok) {
    process.stderr.write(`${r.error}\n`);
    process.exitCode = 1;
  }
}

/**
 * Launch the dashboard beside the caller rather than in front of it.
 * Returns a human-readable description of what happened so the caller can
 * report it, or null when no surface was available.
 */
function openBeside(cwd: string): string | null {
  ensureCurrentWorkspace(cwd);

  // tmux: split the current window. Best experience: the dashboard sits
  // next to the session that is driving it, and both stay visible. If the
  // persistent dashboard is already up somewhere, split with a client that
  // attaches to it rather than starting a second, competing dashboard.
  if (inTmux()) {
    const cmd = sessionExists()
      ? `tmux attach-session -t =${SESSION}`
      : dashboardCommand();
    const r = splitBeside({ cwd, command: cmd });
    if (r.ok) {
      return sessionExists() && cmd.startsWith("tmux")
        ? `attached to the ${SESSION} session in a tmux split`
        : "opened in a tmux split";
    }
  }

  // tmux available but we are not inside it: start the persistent session
  // and tell the user how to get to it, rather than opening a throwaway.
  if (hasTmux()) {
    const started = ensureSession({ cwd, command: dashboardCommand() });
    if (started.ok) {
      return started.created
        ? `started in tmux session ${SESSION}. Attach with: ceo`
        : `already running in tmux session ${SESSION}. Attach with: ceo`;
    }
  }

  // macOS: open a new Terminal window. Not as tidy as a split, but it
  // keeps the dashboard live and independent of this session.
  if (process.platform === "darwin") {
    const cmd = `cd ${JSON.stringify(cwd)} && ${process.execPath} ${TUI_ENTRY}`;
    const term = process.env.TERM_PROGRAM === "iTerm.app" ? "iTerm" : "Terminal";
    const script =
      term === "iTerm"
        ? `tell application "iTerm"
             create window with default profile
             tell current session of current window to write text ${JSON.stringify(cmd)}
           end tell`
        : `tell application "Terminal"
             do script ${JSON.stringify(cmd)}
             activate
           end tell`;
    try {
      execFileSync("osascript", ["-e", script], { stdio: "ignore" });
      return `opened in a new ${term} window`;
    } catch {
      // fall through
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function workspaceCmd(args: string[]): void {
  const [verb = "ls", ...rest] = args;
  switch (verb) {
    case "ls":
    case "list": {
      const all = listWorkspaces();
      if (all.length === 0) {
        process.stdout.write(
          `No workspaces registered in ${registryPath()}.\nRun \`ceo\` inside a directory with an org, or \`ceo workspace add <path>\`.\n`,
        );
        return;
      }
      const nameWidth = Math.max(...all.map((w) => w.name.length));
      for (const w of all) {
        const org = orgExists(w.path);
        process.stdout.write(
          `${w.name.padEnd(nameWidth)}  ${w.path}${org ? "" : "  · no org yet"}\n`,
        );
      }
      return;
    }
    case "add": {
      const [p, name] = rest;
      if (!p) {
        process.stderr.write("Usage: ceo workspace add <path> [name]\n");
        process.exitCode = 1;
        return;
      }
      try {
        const w = addWorkspace(p, name);
        process.stdout.write(`Registered ${w.name} at ${w.path}\n`);
      } catch (e) {
        process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
      }
      return;
    }
    case "rm":
    case "remove": {
      const [p] = rest;
      if (!p) {
        process.stderr.write("Usage: ceo workspace rm <path|name>\n");
        process.exitCode = 1;
        return;
      }
      if (removeWorkspace(p)) process.stdout.write(`Removed ${p} from the registry. Its .ceo/ is untouched.\n`);
      else {
        process.stderr.write(`Not registered: ${p}\n`);
        process.exitCode = 1;
      }
      return;
    }
    default:
      process.stderr.write("Usage: ceo workspace ls | add <path> [name] | rm <path|name>\n");
      process.exitCode = 1;
  }
}

function taskCmd(args: string[], cwd: string): void {
  if (!orgExists(cwd)) {
    process.stderr.write("No org in this project. Run `ceo` and press n to start one.\n");
    process.exitCode = 1;
    return;
  }
  const [verb = "ls", ...rest] = args;
  switch (verb) {
    case "ls":
    case "list": {
      const tasks = listTasks(cwd);
      if (tasks.length === 0) {
        process.stdout.write("Queue is empty. `ceo task add <agent|-> <title>`\n");
        return;
      }
      for (const t of tasks) {
        const who = (t.assignee ?? "-").padEnd(12);
        const st = t.status.padEnd(9);
        const cost = t.costUsd !== null ? ` ${compactUsd(t.costUsd)}` : "";
        const why = t.blockedReason ? ` · ${t.blockedReason}` : "";
        process.stdout.write(`${t.id}  ${st} ${who} ${t.priority.padEnd(6)} ${t.title}${cost}${why}\n`);
      }
      return;
    }
    case "add": {
      // `-` means unassigned. Priority via a leading `!` for high or `.` for low.
      const [who, ...words] = rest;
      let priority: TaskPriority = "normal";
      if (words[0] === "!") { priority = "high"; words.shift(); }
      if (words[0] === ".") { priority = "low"; words.shift(); }
      const title = words.join(" ");
      if (!who || !title) {
        process.stderr.write("Usage: ceo task add <agent|-> [!|.] <title…>\n");
        process.exitCode = 1;
        return;
      }
      try {
        const t = addTask({ title, assignee: who === "-" ? null : who, priority }, cwd);
        process.stdout.write(`Queued ${t.id} for ${t.assignee ?? "nobody yet"}: ${t.title}\n`);
      } catch (e) {
        process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
      }
      return;
    }
    default: {
      // ceo task <id> done|cancel|queue|assign <agent>
      const id = verb;
      const [action, arg] = rest;
      try {
        if (action === "assign") {
          const t = updateTask(id, { assignee: arg ?? null }, cwd);
          process.stdout.write(`${t.id} is now ${t.assignee ? `assigned to ${t.assignee}` : "unassigned"}\n`);
          return;
        }
        const map: Record<string, TaskStoredStatus> = {
          done: "done", cancel: "cancelled", cancelled: "cancelled", queue: "queued", requeue: "queued",
        };
        const status = action ? map[action] : undefined;
        if (!status) {
          process.stderr.write("Usage: ceo task <id> done | cancel | queue | assign <agent>\n");
          process.exitCode = 1;
          return;
        }
        const t = updateTask(id, { status }, cwd);
        process.stdout.write(`${t.id} is now ${t.status}\n`);
      } catch (e) {
        process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
      }
    }
  }
}

/**
 * `ceo setup`: the readiness checklist. `ceo setup claude|codex|gemini` runs that
 * provider's interactive login in this terminal, then prints the checklist
 * again. The logins are the vendors' own browser flows. CEO only launches
 * them.
 */
function setupCmd(args: string[]): void {
  const [which] = args;
  if (which === "github" || which === "gh") {
    process.stdout.write("Running `gh auth login`. CEO uses the gh login and holds no token.\n\n");
    const child = spawn(ghBinary(), ["auth", "login"], { stdio: "inherit" });
    child.on("error", () => {
      process.stderr.write("The GitHub CLI is not installed: brew install gh\n");
      process.exitCode = 1;
    });
    child.on("exit", () => {
      resetGithubStatus();
      githubCmd([], process.cwd());
    });
    return;
  }
  if (which === "hf" || which === "huggingface") {
    process.stdout.write(
      [
        "Hugging Face needs no setup for public models, datasets, Spaces and papers.",
        "For private repos, sign in once with the Hub's own CLI, and CEO reads the token it saves:",
        "",
        "  pip install -U huggingface_hub && hf auth login",
        "",
        "or set HF_TOKEN in the environment.",
        "",
      ].join("\n"),
    );
    void hfStatus().then((s) => process.stdout.write(s.token ? `Token found${s.account ? ` for ${s.account}` : ""}.\n` : "No token yet. Public content works now.\n"));
    return;
  }
  if (which) {
    if (!PROVIDERS.includes(which as Provider)) {
      process.stderr.write(`Usage: ceo setup [claude|codex|gemini|github|hf]\n`);
      process.exitCode = 1;
      return;
    }
    const cmd = loginCommand(which as Provider).split(" ");
    process.stdout.write(`Running \`${cmd.join(" ")}\`. Sign in, then quit it to come back here.\n\n`);
    const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit" });
    child.on("error", (e) => {
      process.stderr.write(`Could not start ${cmd[0]}: ${e.message}\n`);
      process.exitCode = 1;
    });
    child.on("exit", () => {
      resetReadiness();
      process.stdout.write("\n");
      for (const line of renderSetup()) process.stdout.write(line + "\n");
      process.exit(anyReady() ? 0 : 1);
    });
    return;
  }
  for (const line of renderSetup()) process.stdout.write(line + "\n");
  if (!anyReady()) process.exitCode = 1;
}

/**
 * `ceo suggest`: a proposed team from Reflex's workflows, this directory's
 * session history and the repository itself. `--json` for scripts,
 * `--hire` to hire every seat as proposed, creating an org if needed,
 * `--everywhere` to include Reflex workflows seen only in other repos.
 */
async function suggestCmd(args: string[], cwd: string): Promise<void> {
  const flag = (f: string) => args.includes(f);
  const daysIdx = args.indexOf("--days");
  const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) || 60 : 60;
  const root = projectRoot(cwd);

  // --scan runs Reflex's own scan first, in this terminal, so the proposal
  // is built from history that includes everything up to now.
  if (flag("--scan")) {
    const rx = reflexStatus();
    if (!rx.installed) {
      process.stderr.write("reflex is not installed: npm i -g reflex-skills\n");
      process.exitCode = 1;
      return;
    }
    const [bin, ...scanArgs] = reflexScanCommand(Math.max(days, 7));
    process.stdout.write(`${[bin, ...scanArgs].join(" ")}\n`);
    const code = await new Promise<number>((resolve) => {
      const child = spawn(bin, scanArgs, { stdio: "inherit" });
      child.on("error", () => resolve(1));
      child.on("exit", (c) => resolve(c ?? 1));
    });
    resetReflexStatus();
    if (code !== 0) process.stdout.write(`reflex scan exited ${code}. Proposing from what is there.\n`);
    process.stdout.write("\n");
  }

  const taken = orgExists(root) ? readRoster(root).agents.map((a) => a.name) : [];
  const proposal = await suggestTeam(root, { days, everywhere: flag("--everywhere"), taken });

  if (flag("--json")) {
    const { history, ...rest } = proposal;
    process.stdout.write(JSON.stringify({ ...rest, reflex: { available: history.reflex.available, note: history.reflex.note } }) + "\n");
    return;
  }
  for (const line of renderProposal(proposal)) process.stdout.write(line + "\n");

  if (flag("--hire")) {
    if (!orgExists(root)) {
      initLedger(root);
      ensureCurrentWorkspace(root);
      process.stdout.write(`Created an org in ${root}/.ceo\n`);
    }
    for (const s of proposal.team) {
      try {
        const rec = hire(
          {
            name: s.name,
            role: s.role,
            provider: s.provider,
            model: s.model,
            budgetUsd: s.budgetUsd,
            isolated: s.isolated,
            autonomy: s.autonomy,
            collaboration: s.collaboration,
            guardrails: s.guardrails,
          },
          root,
        );
        process.stdout.write(`hired ${rec.name}: ${rec.provider} ${rec.model}, ${rec.autonomy}, $${rec.budgetUsd}\n`);
      } catch (e) {
        process.stdout.write(`skipped ${s.name}: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
  }
}

/** `ceo runs`: who is working right now, from the live traces. */
function runsCmd(cwd: string): void {
  const rows = liveRuns(cwd, { tail: 3 });
  const live = rows.filter((r) => r.live);
  if (live.length === 0) {
    process.stdout.write("Nobody is running right now.\n");
    return;
  }
  for (const r of live) {
    process.stdout.write(`${r.agent}  ${r.provider}  turn ${r.turn}  since ${new Date(r.startedAt).toISOString().slice(11, 19)}  ${r.task}\n`);
    for (const l of r.tail) process.stdout.write(`    ${l}\n`);
  }
}

/** `ceo trace <agent> [lines]`: a teammate's live or latest run, as lines. */
function traceCmd(args: string[], cwd: string): void {
  const [agent, n] = args;
  if (!agent) {
    process.stderr.write("Usage: ceo trace <agent> [lines]\n");
    process.exitCode = 1;
    return;
  }
  const t = traceFor(agent, cwd, Number(n) || 40);
  if (!t) {
    process.stdout.write(`No run by ${agent} has left a trace yet.\n`);
    return;
  }
  process.stdout.write(`${t.run.agent} · ${t.run.live ? "running" : "finished"} · turn ${t.run.turn} · ${t.run.task}\n`);
  for (const l of t.lines) process.stdout.write(`${l}\n`);
}

/**
 * `ceo company [id] [--worktrees writers|all|none]`: hire a whole company,
 * or list the companies when no id is given.
 */
function companyCmd(args: string[], cwd: string): void {
  const id = args.find((a) => !a.startsWith("--"));
  const wIdx = args.indexOf("--worktrees");
  const mode = wIdx >= 0 ? args[wIdx + 1] : undefined;
  if (!id) {
    const rows = COMPANIES.map((c) => {
      const plan = planCompany(c, cwd);
      return `  ${c.id.padEnd(10)} ${c.title.padEnd(14)} ${String(plan.seats.length + (plan.chief.hire ? 1 : 0)).padStart(2)} agents  ${plan.providers.join(" ")}  ${compactBudget(plan.totalCapUsd)} in budgets\n             ${c.tagline}`;
    });
    process.stdout.write(`Companies. ceo company <id> hires one.\n\n${rows.join("\n")}\n`);
    return;
  }
  const template = findCompany(id);
  if (!template) {
    process.stderr.write(`No company "${id}". One of: ${COMPANIES.map((c) => c.id).join(", ")}.\n`);
    process.exitCode = 1;
    return;
  }
  if (mode && !WORKTREE_MODES.includes(mode as WorktreeMode)) {
    process.stderr.write(`--worktrees takes ${WORKTREE_MODES.join(", ")}.\n`);
    process.exitCode = 1;
    return;
  }
  if (!orgExists(cwd)) initLedger(cwd);
  const plan = planCompany(template, cwd, mode ? { worktrees: mode as WorktreeMode } : {});
  const result = hireCompany(plan, cwd);
  const lines = [`Hired the ${template.title.toLowerCase()}: ${describeHire(result, plan)}, in ${(result.ms / 1000).toFixed(1)}s.`];
  for (const s of plan.seats) {
    if (!result.hired.includes(s.name)) continue;
    lines.push(`  ${s.name.padEnd(12)} ${s.provider.padEnd(7)} ${s.autonomy.padEnd(11)} ${compactBudget(s.budgetUsd).padEnd(5)}${s.isolated ? ` branch ceo/${s.name}` : ""}${s.movedFrom ? `  moved from ${s.movedFrom}, which is not ready` : ""}`.trimEnd());
  }
  if (plan.worktreeNote) lines.push(`Worktrees: ${plan.worktreeNote}.`);
  if (result.skipped.length > 0) lines.push(`Kept ${result.skipped.join(", ")}, already in the org.`);
  if (result.failed.length > 0) lines.push(`Not hired: ${result.failed.join("; ")}.`);
  if (result.chief && result.hired.length > 0) lines.push(`Next: ceo chat, and tell ${result.chief} what to build.`);
  process.stdout.write(lines.join("\n") + "\n");
  if (result.failed.length > 0) process.exitCode = 1;
}

/**
 * `ceo docket`: the context agents are given.
 *   ceo docket                         every item and who holds it
 *   ceo docket add <source> [--to a,b] add an item and give it
 *   ceo docket give <item> <agent>     give an item; take, rm and refresh work the same way
 */
async function docketCmd(args: string[], cwd: string): Promise<void> {
  const [verb, ...rest] = args;
  const fail = (m: string) => {
    process.stderr.write(`${m}\n`);
    process.exitCode = 1;
  };
  try {
    if (!verb || verb === "ls") {
      const items = listContext(cwd);
      if (items.length === 0) return void process.stdout.write("The docket is empty. ceo docket add <source> adds an item.\n");
      for (const i of items) process.stdout.write(`${i.id}  ${i.kind.padEnd(8)} ${tokenLabel(i.chars).padStart(6)}  ${i.title}\n          held by ${i.agents.length > 0 ? i.agents.join(", ") : "nobody"} · ${i.source}\n`);
      return;
    }
    if (verb === "add") {
      const toAt = rest.indexOf("--to");
      const agents = toAt >= 0 ? (rest[toAt + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];
      const source = rest.filter((_, i) => i !== toAt && i !== toAt + 1).join(" ").trim();
      if (!source) return fail("Usage: ceo docket add <path|#42|hf:org/model|paper:id|url|skill:name|note> [--to agent,agent]");
      const it = await addContext(source, cwd, { agents });
      return void process.stdout.write(`Added ${it.id}: ${it.title}, ${it.kind}, ${tokenLabel(it.chars)} tokens. Held by ${it.agents.length > 0 ? it.agents.join(", ") : "nobody"}.\n`);
    }
    const [itemArg, agent] = rest;
    const it = itemArg ? findContext(itemArg, cwd) : null;
    if (!it) return fail(`No docket item matches "${itemArg ?? ""}". ceo docket lists them.`);
    if (verb === "give" || verb === "take") {
      if (!agent) return fail(`Usage: ceo docket ${verb} <item> <agent>`);
      if (verb === "give") giveContext(it.id, agent, cwd);
      else takeContext(it.id, agent, cwd);
      return void process.stdout.write(`${agent} ${verb === "give" ? "now holds" : "no longer holds"} ${it.title}.\n`);
    }
    if (verb === "rm") {
      removeContext(it.id, cwd);
      return void process.stdout.write(`Removed ${it.title}.\n`);
    }
    if (verb === "refresh") {
      const n = await refreshContext(it.id, cwd);
      return void process.stdout.write(`Refreshed ${n.title}, ${tokenLabel(n.chars)} tokens.\n`);
    }
    fail("Usage: ceo docket [ls|add|give|take|rm|refresh]");
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

/** `ceo skills`: the catalogue, from Reflex and the CLIs' skill folders. `ceo skills give <name> <agent>`. */
async function skillsCmd(args: string[], cwd: string): Promise<void> {
  const [verb, name, agent] = args;
  if (verb === "give") {
    if (!name || !agent) {
      process.stderr.write("Usage: ceo skills give <name> <agent>\n");
      process.exitCode = 1;
      return;
    }
    try {
      const catalog = await skillCatalog(cwd);
      const s = catalog.find((x) => x.name === name);
      if (s?.status === "pending") approveWorkflow(name, cwd);
      const it = await addContext(`skill:${name}`, cwd, { agents: [agent] });
      process.stdout.write(`${agent} now holds the ${it.title} skill.\n`);
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    }
    return;
  }
  const catalog = await skillCatalog(cwd);
  if (catalog.length === 0) {
    process.stdout.write("No skills yet. Reflex finds repeated workflows: reflex scan, then reflex suggest.\n");
    return;
  }
  for (const s of catalog) {
    const where = s.status === "pending" ? `waiting in Reflex, ${Math.round((s.confidence ?? 0) * 100)}%` : s.source;
    process.stdout.write(`${s.name.padEnd(28)} ${where.padEnd(22)} ${s.description.slice(0, 80)}\n`);
  }
  process.stdout.write("\nceo skills give <name> <agent> gives one. A waiting workflow is approved with Reflex first.\n");
}

/** `ceo github`: whether gh is ready here, and the open issues. */
function githubCmd(_args: string[], cwd: string): void {
  const s = githubStatus(cwd);
  if (!s.installed || !s.signedIn) {
    process.stdout.write(`GitHub: ${s.fix}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`GitHub: signed in as ${s.account ?? "you"}${s.repo ? ` · ${s.repo}` : ""}\n`);
  if (!s.repo) return;
  try {
    const issues = listIssues(cwd, { limit: 20 });
    process.stdout.write(`${issues.length} open issue${issues.length === 1 ? "" : "s"}${issues.length > 0 ? ":" : "."}\n`);
    for (const i of issues) process.stdout.write(`  #${String(i.number).padEnd(5)} ${i.title}${i.labels.length ? `  [${i.labels.join(", ")}]` : ""}\n`);
    if (issues.length > 0) process.stdout.write(`\nceo docket add "#${issues[0].number}" --to <agent> gives one to an agent.\n`);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/** `ceo pr <agent> [--base <branch>]`: push the agent's branch and open a pull request. */
function prCmd(args: string[], cwd: string): void {
  const agent = args.find((a) => !a.startsWith("--"));
  const at = args.indexOf("--base");
  if (!agent) {
    process.stderr.write("Usage: ceo pr <agent> [--base <branch>]\n");
    process.exitCode = 1;
    return;
  }
  try {
    const url = openPullRequest(agent, cwd, { base: at >= 0 ? args[at + 1] : defaultBase(cwd) });
    process.stdout.write(`${url}\n`);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}

function defaultBase(cwd: string): string {
  const r = spawnSyncGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  return r ? r.replace(/^origin\//, "") : "main";
}

function spawnSyncGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** `ceo hf <source>`: print what an agent would read from the Hub. */
async function hfCmd(args: string[]): Promise<void> {
  const source = args.join(" ").trim();
  const parsed = source ? parseHfSource(source.startsWith("hf:") || source.startsWith("paper:") || source.startsWith("http") ? source : `hf:${source}`) : null;
  if (!parsed) {
    const s = await hfStatus();
    process.stdout.write(`Hugging Face: ${s.token ? `token${s.account ? ` for ${s.account}` : ""}` : "public content, no token"} · ${s.endpoint}\nceo hf org/model, ceo hf datasets/org/name or ceo hf paper:2401.12345 prints a card.\n`);
    return;
  }
  try {
    const card = parsed.kind === "paper" ? await hfPaper(parsed.id) : await hfCard(parsed.kind, parsed.id);
    process.stdout.write(`${card.text}\n`);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}

/**
 * `ceo alerts`: where alerts go.
 *   ceo alerts                       the channels and events
 *   ceo alerts bell|desktop on|off
 *   ceo alerts slack <url>|off       ceo alerts webhook <url>|off
 *   ceo alerts <event> on|off        done, failed, budget, denied, chief, queue
 *   ceo alerts test
 */
async function alertsCmd(args: string[], cwd: string): Promise<void> {
  const [a, b] = args;
  try {
    if (a === "test") {
      const res = await sendAlert({ kind: "done", title: "CEO test alert", body: "Alerts from this machine reach this channel.", workspace: projectRoot(cwd) }, { force: true });
      if (res.length === 0) process.stdout.write("Every channel is off. ceo alerts bell on turns the bell on.\n");
      for (const r of res) process.stdout.write(`${r.channel.padEnd(8)} ${r.ok ? "✓" : "✗"} ${r.detail}\n`);
      return;
    }
    if (a === "bell" || a === "desktop") writeAlerts({ [a]: b !== "off" });
    else if (a === "slack" || a === "webhook") writeAlerts({ [a]: !b || b === "off" ? null : b });
    else if (a && (ALERT_KINDS as string[]).includes(a)) writeAlerts({ events: { [a]: b !== "off" } as Partial<Record<AlertKind, boolean>> });
    else if (a) throw new Error("Usage: ceo alerts [bell|desktop on|off] [slack|webhook <url>|off] [<event> on|off] [test]");
    const c = readAlerts();
    process.stdout.write(`${describeChannels(c)}\n`);
    for (const k of ALERT_KINDS) process.stdout.write(`  ${c.events[k] ? "●" : "○"} ${k.padEnd(7)} ${ALERT_LABEL[k]}\n`);
    process.stdout.write(`Settings: ${alertsPath()}\n`);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}

/** `ceo agent <name> provider <claude|codex|gemini> [model]`: move an agent; everything else stays. */
function agentCmd(args: string[], cwd: string): void {
  const [name, field, value, model] = args;
  if (!name || field !== "provider" || !value) {
    process.stderr.write("Usage: ceo agent <name> provider <claude|codex|gemini> [model]\n");
    process.exitCode = 1;
    return;
  }
  const out = runOp(["reconfigure", JSON.stringify({ name, provider: value, ...(model ? { model } : {}) })], cwd);
  const parsed = JSON.parse(out) as { ok: boolean; message?: string; error?: string };
  process.stdout.write(`${parsed.ok ? parsed.message : parsed.error}\n`);
  if (!parsed.ok) process.exitCode = 1;
}

/** `ceo board [n]`: the notes posted by agents and the operator, newest first. */
function boardCmd(args: string[], cwd: string): void {
  if (!orgExists(cwd)) {
    process.stderr.write("No org in this directory.\n");
    process.exitCode = 1;
    return;
  }
  const rows = readMessages(cwd, Number(args[0]) || 20);
  if (rows.length === 0) {
    process.stdout.write("The board is empty. `ceo post <agent|*> <text>` leaves a note; agents post with org_post.\n");
    return;
  }
  for (const m of rows) process.stdout.write(`${new Date(m.ts).toISOString().slice(0, 16).replace("T", " ")}  ${describeMessage(m)}\n`);
}

/** `ceo post <agent|*> <text…>`: a note from you to one agent or everyone. */
function postCmd(args: string[], cwd: string): void {
  const [to, ...words] = args;
  const text = words.join(" ");
  if (!to || !text) {
    process.stderr.write("Usage: ceo post <agent|*> <text…>\n");
    process.exitCode = 1;
    return;
  }
  try {
    const m = postMessage({ from: YOU, to, text }, cwd);
    process.stdout.write(`Posted to ${m.to === "*" ? "everyone" : m.to}. It reaches them at the start of their next run.\n`);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}

function shellCmd(args: string[], cwd: string): void {
  const [name] = args;
  let dir = projectRoot(cwd);
  let label = path.basename(dir);
  if (name) {
    const agent = findAgent(name, cwd);
    if (!agent) {
      process.stderr.write(`No agent named "${name}" in this org.\n`);
      process.exitCode = 1;
      return;
    }
    dir = workdirFor(agent, cwd);
    label = `${label}/${name}`;
  }
  const r = openWindow({ name: label, cwd: dir });
  if (r.ok) process.stdout.write(`${r.detail}\n`);
  else {
    process.stderr.write(`${r.error}\n`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const [, , sub = "attach", ...rest] = process.argv;
  const cwd = process.cwd();

  switch (sub) {
    case "attach":
      attachOrRun(cwd);
      return;

    case "ui":
      ensureCurrentWorkspace(cwd);
      runUi(cwd);
      return;

    case "chat":
      ensureCurrentWorkspace(cwd);
      runUi(cwd, "chat");
      return;

    case "open": {
      const how = openBeside(cwd);
      if (how) {
        process.stdout.write(`Dashboard ${how}.\n`);
      } else {
        // No surface available. Say so plainly and give the exact command
        // rather than pretending something happened.
        process.stdout.write(
          `Could not open a second pane here. Run this in another terminal:\n  cd ${cwd} && ceo ui\n`,
        );
        process.exitCode = 1;
      }
      return;
    }

    case "shell":
      shellCmd(rest, cwd);
      return;

    case "setup":
    case "doctor":
      setupCmd(rest);
      return;

    case "board":
      boardCmd(rest, cwd);
      return;

    case "agent":
      agentCmd(rest, cwd);
      return;

    case "company":
      companyCmd(rest, cwd);
      return;

    case "docket":
    case "context":
      await docketCmd(rest, cwd);
      return;

    case "skills":
      await skillsCmd(rest, cwd);
      return;

    case "github":
    case "gh":
      githubCmd(rest, cwd);
      return;

    case "pr":
      prCmd(rest, cwd);
      return;

    case "hf":
    case "huggingface":
      await hfCmd(rest);
      return;

    case "alerts":
      await alertsCmd(rest, cwd);
      return;

    case "runs":
      runsCmd(cwd);
      return;

    case "trace":
      traceCmd(rest, cwd);
      return;

    case "post":
      postCmd(rest, cwd);
      return;

    case "suggest":
    case "propose":
      void suggestCmd(rest, cwd).catch((e) => {
        process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
      });
      return;

    // Machine interface for the Claude Code mod. One JSON object on stdout,
    // nothing else. See src/bridge.ts.
    case "json": {
      let out: Record<string, unknown>;
      try {
        out = snapshotJson(rest[0] || cwd);
      } catch (e) {
        out = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      process.stdout.write(JSON.stringify(out) + "\n");
      return;
    }

    case "op":
      process.stdout.write(runOp(rest, cwd) + "\n");
      return;

    case "snapshot": {
      const snap = renderSnapshot(cwd);
      process.stdout.write(
        snap ?? "No org in this project. Run `ceo` and press n to start one.\n",
      );
      process.stdout.write("\n");
      return;
    }

    case "status": {
      process.stdout.write(statusLine(cwd) + "\n");
      process.stdout.write(authStatus().summary + "\n");
      // Only ask codex when an agent here runs on it: it is a subprocess call.
      const providers = orgExists(cwd) ? new Set(readRoster(cwd).agents.map((a) => a.provider)) : new Set<string>();
      if (providers.has("codex")) process.stdout.write(codexAuthStatus().summary + "\n");
      if (providers.has("gemini")) process.stdout.write(geminiAuthStatus().summary + "\n");
      process.stdout.write(describeHost() + "\n");
      process.stdout.write(
        `${listWorkspaces().length} workspace${listWorkspaces().length === 1 ? "" : "s"} registered in ${registryPath()}\n`,
      );
      return;
    }

    case "workspace":
    case "workspaces":
    case "ws":
      workspaceCmd(rest);
      return;

    case "task":
    case "tasks":
      taskCmd(rest, cwd);
      return;

    case "whoami":
    case "billing": {
      const st = authStatus();
      process.stdout.write("claude agents\n");
      for (const line of billingExplainer(st)) process.stdout.write(`  ${line}\n`);
      if (st.warning) process.stdout.write(`  ! ${st.warning}\n`);
      const cx = codexAuthStatus();
      process.stdout.write("\ncodex agents\n");
      for (const line of codexBillingExplainer(cx)) process.stdout.write(`  ${line}\n`);
      if (cx.warning) process.stdout.write(`  ! ${cx.warning}\n`);
      const gm = geminiAuthStatus();
      process.stdout.write("\ngemini agents\n");
      for (const line of geminiBillingExplainer(gm)) process.stdout.write(`  ${line}\n`);
      if (gm.warning) process.stdout.write(`  ! ${gm.warning}\n`);
      return;
    }

    case "-v":
    case "--version":
    case "version": {
      const pkg = JSON.parse(readFileSync(path.join(HERE, "..", "package.json"), "utf8")) as { version: string };
      process.stdout.write(`${pkg.version}\n`);
      return;
    }

    case "-h":
    case "--help":
    case "help":
      process.stdout.write(
        [
          "ceo: run a team of headless agents, claude, codex or gemini, from one terminal",
          "",
          "  ceo                    attach to the dashboard in tmux session `ceo`, or run it here",
          "  ceo ui                 run the dashboard in this terminal without tmux",
          "  ceo chat               talk to the chief of staff, who hires and gives out work",
          "  ceo company [id]       hire a whole company in one step; no id lists them; --worktrees writers|all|none",
          "  ceo docket [add|give|take|rm|refresh]   the context each agent is given",
          "  ceo skills [give <name> <agent>]        skills from Reflex and the CLIs' skill folders",
          "  ceo github · ceo pr <agent>             issues here; a pull request for an agent's branch",
          "  ceo hf <org/model|datasets/..|paper:id>  what an agent would read from the Hub",
          "  ceo alerts [bell|desktop|slack|webhook|<event>|test]   where alerts go",
          "  ceo open               open the dashboard beside the current session",
          "  ceo shell [agent]      tmux window in the repo root, or an agent's worktree",
          "  ceo snapshot           print a static org view",
          "  ceo status             print the one-line status",
          "  ceo --version          print the version",
          "  ceo workspace ls|add <path> [name]|rm <path|name>",
          "  ceo task ls|add <agent|-> [!|.] <title>|<id> done|cancel|queue|assign <agent>",
          "  ceo agent <name> provider <p> [model]   move an agent to another provider; brief, budget, history stay",
          "  ceo board [n]          notes posted by agents and the operator",
          "  ceo runs               who is working right now, from the live traces",
          "  ceo trace <agent>      what an agent is doing, or did last, line by line",
          "  ceo post <agent|*> <text>   leave a note for an agent, or everyone",
          "  ceo setup [provider]   check claude, codex and gemini are installed and signed in, or run a login",
          "  ceo suggest            propose a team from Reflex workflows, session history and the repo",
          "                         --scan runs `reflex scan` first · --hire hires it · --json · --everywhere · --days N",
          "  ceo billing            which accounts claude, codex and gemini agent runs bill to",
          "  ceo json [root]        the org as one JSON object, for scripts",
          "  ceo op <verb> <json>   one mutation through the core, reported as JSON",
          "",
          "Agents run as `claude -p`, `codex exec` or `agy -p`, chosen per agent at hire.",
          "Autonomy is enforced by that process: a tool allowlist on claude,",
          "a filesystem sandbox on codex, a read-only mode on gemini. Every run lands in .ceo/ledger.jsonl.",
          "",
        ].join("\n"),
      );
      return;

    default:
      process.stderr.write(
        `Unknown command "${sub}". Try: ceo | ui | open | setup | suggest | shell | snapshot | status | workspace | task\n`,
      );
      process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
