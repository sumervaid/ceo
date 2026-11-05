/** Workspace names: stars. Short, easy to say, easy to tell apart in a sidebar. */
export const STARS = [
  "vega", "rigel", "altair", "deneb", "sirius", "castor", "pollux", "antares", "spica", "arcturus",
  "capella", "procyon", "regulus", "mira", "polaris", "bellatrix", "canopus", "achernar", "hadar", "acrux",
  "mimosa", "adhara", "shaula", "gacrux", "alnair", "alioth", "dubhe", "mirfak", "wezen", "sargas",
  "kaus", "avior", "alkaid", "menkar", "atria", "alhena", "peacock", "mizar", "alpheratz", "hamal",
  "diphda", "nunki", "saiph", "enif", "scheat", "markab", "naos", "izar", "merak", "phecda",
];

export function pickName(taken: Set<string>): string {
  for (const s of STARS) if (!taken.has(s)) return s;
  for (let n = 2; ; n++) {
    for (const s of STARS) if (!taken.has(`${s}-${n}`)) return `${s}-${n}`;
  }
}
