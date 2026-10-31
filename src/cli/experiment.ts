/**
 * `ceo experiment`: run a designed experiment on agent teams, and read it.
 *
 *   ceo experiment new <name> [--backend ceo]   write a starter spec
 *   ceo experiment plan <spec>                  what a run would do, and what it would cost
 *   ceo experiment run <spec> [--fresh] [--live] [--out dir]
 *   ceo experiment export <spec|dir>            cells.csv and attempts.csv
 *   ceo experiment report <spec|dir> [--json]   the curve, split into sampling and teamwork
 *   ceo experiment ls                           experiments in this project
 *
 * A run picks up where the last one stopped. --fresh starts over.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import "../core/evidence.js";
import { analyze, renderReport } from "../core/analysis.js";
import { experimentDir, exportExperiment, parseSpec, planOf, readSpec, renderPlan, runExperiment, writeExport, type ExperimentSpec } from "../core/experiment.js";
import { projectRoot } from "../core/paths.js";

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" || args[i] === "--backend") i++;
    else if (!args[i].startsWith("--")) out.push(args[i]);
  }
  return out;
}

/** A spec file, or an experiment directory holding spec.json. */
function resolveTarget(target: string, cwd: string, out: string | null): { dir: string; spec: ExperimentSpec | null } {
  const p = path.resolve(cwd, target);
  if (existsSync(p) && statSync(p).isDirectory()) {
    const f = path.join(p, "spec.json");
    return { dir: p, spec: existsSync(f) ? parseSpec(JSON.parse(readFileSync(f, "utf8")), p) : null };
  }
  if (existsSync(p)) {
    const spec = readSpec(p);
    return { dir: experimentDir(spec, cwd, out), spec };
  }
  const named = path.join(projectRoot(cwd), ".ceo", "experiments", target);
  if (existsSync(named)) return resolveTarget(named, cwd, null);
  throw new Error(`No spec file or experiment at ${target}.`);
}

function starter(name: string, backend: "sim" | "ceo"): Record<string, unknown> {
  if (backend === "sim") {
    return {
      name,
      backend: "sim",
      sizes: [1, 2, 4, 8, 16, 32],
      seeds: 5,
      conditions: [
        { name: "independent", mode: "independent" },
        { name: "team", mode: "team" },
      ],
      tasks: Array.from({ length: 12 }, (_, i) => ({ id: `t${String(i + 1).padStart(2, "0")}` })),
      sim: { runCorrelation: 0.3, armTaskSpread: 1.0, overfit: 0.1, team: { synergy: 0.15, conflictRate: 0.02, overheadMinutes: 0.5, messageUsd: 0.02 } },
    };
  }
  return {
    name,
    backend: "ceo",
    sizes: [1, 2, 4],
    seeds: 2,
    budgetUsd: 2,
    conditions: [{ name: "independent", mode: "independent" }],
    agent: { provider: "claude" },
    arms: [
      { provider: "claude", model: "claude-haiku-4-5" },
      { provider: "codex", model: "gpt-5-mini" },
      { provider: "gemini", model: "gemini-2.5-flash" },
    ],
    tasks: [{ id: "first", prompt: "Make the failing test in this repository pass.", fixture: "fixtures/first", verify: ["npm test"], holdout: ["npm run test:holdout"] }],
  };
}

export async function experimentCmd(args: string[], cwd: string): Promise<void> {
  const fail = (m: string): void => {
    process.stderr.write(`${m}\n`);
    process.exitCode = 1;
  };
  const [sub, ...rest] = args;
  const pos = positional(rest);
  const out = flag(rest, "--out");

  try {
    switch (sub) {
      case "new": {
        const name = pos[0];
        if (!name) return fail("ceo experiment new <name> [--backend sim|ceo]");
        const backend = flag(rest, "--backend") ?? "sim";
        if (backend !== "sim" && backend !== "ceo") return fail("--backend is sim or ceo.");
        const file = path.resolve(cwd, `${name}.json`);
        if (existsSync(file)) return fail(`${file} already exists.`);
        const spec = starter(name, backend);
        if (backend === "sim") parseSpec(spec, cwd);
        writeFileSync(file, JSON.stringify(spec, null, 2) + "\n", "utf8");
        process.stdout.write(`Wrote ${file}.\n${backend === "ceo" ? "Point each task's fixture at a repo with a failing test before a run.\n" : ""}Next: ceo experiment plan ${path.relative(cwd, file)}\n`);
        return;
      }

      case "plan": {
        if (!pos[0]) return fail("ceo experiment plan <spec.json>");
        const spec = readSpec(path.resolve(cwd, pos[0]));
        process.stdout.write(`${renderPlan(spec, planOf(spec))}\n  cells go to ${experimentDir(spec, cwd, out)}\n`);
        return;
      }

      case "run": {
        if (!pos[0]) return fail("ceo experiment run <spec.json> [--fresh] [--live] [--out dir]");
        const spec = readSpec(path.resolve(cwd, pos[0]));
        const dir = experimentDir(spec, cwd, out);
        const live = rest.includes("--live");
        process.stdout.write(`${renderPlan(spec)}\n\n`);

        const abort = new AbortController();
        const onInt = () => {
          if (abort.signal.aborted) process.exit(130);
          abort.abort();
          process.stderr.write("\nStopping after this cell. Ctrl-C again to quit now.\n");
        };
        process.on("SIGINT", onInt);
        const tty = process.stdout.isTTY && spec.backend === "sim";
        let spent = 0;
        try {
          const summary = await runExperiment(spec, {
            dir,
            live,
            fresh: rest.includes("--fresh"),
            signal: abort.signal,
            onCell: (o, i, total) => {
              spent += o.costUsd;
              if (tty) {
                if (i % 25 === 0 || i === total - 1) process.stdout.write(`\r  ${i + 1}/${total} cells · $${spent.toFixed(2)} simulated`);
                return;
              }
              if (o.status === "skipped" && spec.backend === "sim") return;
              const mark = o.status === "skipped" ? "·" : o.status === "deferred" ? "…" : o.solved ? "✓" : "✗";
              process.stdout.write(`  ${mark} ${o.cell.id.padEnd(40)} $${o.costUsd.toFixed(4)}${o.status === "skipped" ? " done before" : ""}\n`);
            },
          });
          if (tty) process.stdout.write("\n");
          const ex = writeExport(dir);
          process.stdout.write(`\n${summary.ran} cells ran, ${summary.skipped} were done before · $${summary.spentUsd.toFixed(2)}${spec.backend === "sim" ? " simulated" : ""}${summary.stopped ? ` · stopped: ${summary.stopped}` : ""}\n`);
          process.stdout.write(`Wrote ${path.relative(cwd, ex.cells) || ex.cells} and ${path.relative(cwd, ex.attempts) || ex.attempts}.\n\n`);
          const data = exportExperiment(dir);
          process.stdout.write(`${renderReport(analyze(data.cells, data.attempts, spec))}\n`);
          if (summary.stopped) process.exitCode = 1;
        } finally {
          process.off("SIGINT", onInt);
        }
        return;
      }

      case "export": {
        if (!pos[0]) return fail("ceo experiment export <spec.json|dir>");
        const { dir } = resolveTarget(pos[0], cwd, out);
        const ex = writeExport(dir);
        process.stdout.write(`${ex.rows.cells} cells, ${ex.rows.attempts} attempts\n${ex.cells}\n${ex.attempts}\n`);
        return;
      }

      case "report": {
        if (!pos[0]) return fail("ceo experiment report <spec.json|dir> [--json]");
        const { dir, spec } = resolveTarget(pos[0], cwd, out);
        const data = exportExperiment(dir);
        const a = analyze(data.cells, data.attempts, spec);
        process.stdout.write(rest.includes("--json") ? `${JSON.stringify(a, null, 2)}\n` : `${renderReport(a)}\n`);
        return;
      }

      case "ls":
      case undefined: {
        const root = path.join(projectRoot(cwd), ".ceo", "experiments");
        const names = existsSync(root) ? readdirSync(root).filter((n) => existsSync(path.join(root, n, "spec.json"))) : [];
        if (names.length === 0) {
          process.stdout.write("No experiments yet. ceo experiment new <name> writes a starter spec.\n");
          return;
        }
        for (const n of names) {
          const data = exportExperiment(path.join(root, n));
          const spec = JSON.parse(readFileSync(path.join(root, n, "spec.json"), "utf8")) as ExperimentSpec;
          process.stdout.write(`  ${n.padEnd(24)} ${spec.backend.padEnd(4)} ${data.cells.length} cells done\n`);
        }
        return;
      }

      default:
        return fail(`No experiment command "${sub}". One of: new, plan, run, export, report, ls.`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
