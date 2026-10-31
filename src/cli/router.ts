/**
 * `ceo router`: what the router knows and what the router would pick.
 *
 *   ceo router [kind]                   the evidence table, for one kind or all
 *   ceo router pick "<title>" [-n 3]    the arms the router would choose, and why
 */

import { recommend, renderChoices, renderRouterTable, routerTable, TASK_KINDS, taskKind } from "../core/router.js";

export function routerCmd(args: string[], cwd: string): void {
  const fail = (m: string): void => {
    process.stderr.write(`${m}\n`);
    process.exitCode = 1;
  };
  const [sub, ...rest] = args;

  if (sub === "pick") {
    const nAt = rest.findIndex((a) => a === "-n" || a === "--n");
    const n = nAt >= 0 ? Number(rest[nAt + 1]) : 3;
    const title = rest.filter((_, i) => nAt < 0 || (i !== nAt && i !== nAt + 1)).join(" ").trim();
    if (!title) return fail('ceo router pick "<task title>" [-n 3]');
    if (!Number.isInteger(n) || n < 1 || n > 12) return fail("-n takes a whole number from 1 to 12.");
    const kind = taskKind(title);
    process.stdout.write(`${kind}\n${renderChoices(recommend(kind, cwd, n))}\n`);
    return;
  }

  if (sub && !(TASK_KINDS as readonly string[]).includes(sub)) return fail(`No kind "${sub}". One of: ${TASK_KINDS.join(", ")}. Or: ceo router pick "<task title>" [-n 3]`);
  process.stdout.write(`${renderRouterTable(routerTable(cwd, sub))}\n`);
}
