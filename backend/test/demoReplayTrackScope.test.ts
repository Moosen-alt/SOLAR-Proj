// DEMO REPLAY TARGETS ARE NEM FILINGS; THEY MAY ONLY RESOLVE A UTILITY RECIPE (hard rule 5).
//
// demoReplay matched recipes on `r.utility || r.ahj`. An AHJ permit recipe carries the
// project's utility in its `utility` column (the profile key is state|ahj|utility), so the
// "pacificorp" target resolved to an Accela PERMIT recipe — measured on production's
// portal_recipes (read-only, 2026-09-23): scope=ahj, platform auto-learned, City of Coos Bay,
// utility "Pacific Power", host aca-oregon.accela.com, 53 steps — and would have replayed it
// against a real homeowner's project as the NEM filing.
//
// Run: tsx backend/test/demoReplayTrackScope.test.ts
const { TARGETS, pickDemoRecipe } = await import("../../portal-bot/src/demoReplay");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

type R = { scopeType: "ahj" | "utility"; utility: string; ahj: string; status: "complete" | "recording" | "needs_rerecord" };
const pacificorp = TARGETS.find((t) => t.key === "pacificorp")!;
const pge = TARGETS.find((t) => t.key === "pge")!;

// The live shape: the only COMPLETE row naming Pacific Power is a permit recipe.
const permitRecipe: R = { scopeType: "ahj", ahj: "City of Coos Bay", utility: "Pacific Power", status: "complete" };
const nemRecipe: R = { scopeType: "utility", ahj: "", utility: "Pacific Power", status: "complete" };
const draftNem: R = { scopeType: "utility", ahj: "", utility: "Pacific Power", status: "recording" };

check("0. every demo target is a utility (NEM) target", TARGETS.every((t) => t.scope === "utility"), JSON.stringify(TARGETS.map((t) => t.scope)));
check("1. MUST EXCLUDE: an AHJ permit recipe whose utility column names Pacific Power is never picked",
  pickDemoRecipe([permitRecipe], pacificorp) === -1, String(pickDemoRecipe([permitRecipe], pacificorp)));
check("2. MUST EXCLUDE: an AHJ recipe is not reachable through its AHJ name either",
  pickDemoRecipe([{ scopeType: "ahj", ahj: "Portland General Electric", utility: "", status: "complete" }], pge) === -1);
check("3. MUST PASS: the utility recipe is picked, even listed after the permit one",
  pickDemoRecipe([permitRecipe, nemRecipe], pacificorp) === 1, String(pickDemoRecipe([permitRecipe, nemRecipe], pacificorp)));
check("4. an incomplete utility recipe is not a demo", pickDemoRecipe([draftNem], pacificorp) === -1);

console.log(failures ? `\ndemoReplayTrackScope: ${failures} FAILED` : "\ndemoReplayTrackScope: all passed");
process.exit(failures ? 1 : 0);
