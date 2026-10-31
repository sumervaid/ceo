/**
 * The loop between CEO, Everval and Reflex.
 *
 * CEO writes one trace per run to `.ceo/runs/` and one verdict per check
 * to the ledger. Everval's grades arrive as those verdicts. Reflex reads
 * the traces and the verdicts as reward, and proposes skills from the work
 * that passed. An approved skill lands here: `syncReflexSkills` adds each
 * new Reflex skill to the docket and records a `promote` with scope
 * "skill". The router then offers the skill as an arm, so the next
 * dispatch can try it, and the verdicts say whether it helped.
 */

import { addContext, listContext } from "./context.js";
import { append } from "./ledger.js";
import { readySkills } from "./skills.js";

/** Add every Reflex skill the docket does not hold yet. Returns the names added. */
export async function syncReflexSkills(cwd?: string): Promise<string[]> {
  const held = new Set(listContext(cwd).filter((i) => i.kind === "skill").map((i) => i.source));
  const added: string[] = [];
  for (const skill of readySkills(cwd).filter((s) => s.source === "reflex")) {
    if (held.has(`skill:${skill.name}`)) continue;
    try {
      const item = await addContext(`skill:${skill.name}`, cwd, { by: "reflex" });
      append("promote", null, { scope: "skill", name: skill.name, from: "reflex", contextId: item.id }, cwd);
      added.push(skill.name);
    } catch {
      /* a skill that cannot be read stays out of the docket until it can */
    }
  }
  return added;
}
