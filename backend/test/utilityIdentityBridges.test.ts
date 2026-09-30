// ONE UTILITY IS ONE UTILITY — AND A NAME THE IDENTITY DOES NOT KNOW IS NOT PROOF OF ANOTHER ONE
// (converge 2026-09-28, skeptic item 2 on B9).
//
// B9 made the recipe alias (portalRecipes.findRecipeByNameAlias) and the KB fuzzy
// (knowledgeBase.findKnowledgeByName) ask utilityIdentity first. Its provablyDifferentUtility said
// "different" when only ONE name was a known identity — which zeroed every short-name bridge
// CLAUDE.md relies on: Utah "RMP" never found the "Rocky Mountain Power" recipe or its verified KB
// row, Oregon "P.G.E." never found Portland General Electric. Fixed: provably different only when
// BOTH names are known identities and they differ; the identity is state-aware and knows PG&E (a
// matching identity only — never a portal: knownPowerClerkUtility("CA","PG&E") stays null).
//
//   I1 THE PREDICATES — both-known rule; the state-aware "PGE"; PG&E known for matching only.
//   I2 MUST-PASS  — UT "RMP" finds the complete "Rocky Mountain Power" recipe AND its verified KB row.
//   I3 MUST-PASS  — OR "P.G.E." / "Portland GE" find the Portland General Electric KB row.
//   I4 MUST-PASS  — "Rocky Mtn Power" / "Pac Power" bridge (recipe and KB).
//   I5 THE KILL   — a name the identity does NOT know, beside one it does, is the fuzzy scorer's call
//                   (UT "R.M.P." 78, "Rocky Mountain Pwr" 70): the one-side rule zeroed these.
//   I6 MUST-EXCLUDE — CA "PG&E" never resolves Portland General Electric (an EMPTY-state KB row
//                   matches anywhere, so the state filter alone does not protect it), and vice versa.
//   I7 B9 STAYS FIXED — "PacifiCorp" finds "Pacific Power"; CA "Pacific Gas and Electric" never does.
//
// KILLS (verified by hand, see the commit): provablyDifferentUtility back to the one-side rule ->
// I5 FAILS; utilityIdentityOf without PG&E -> I6 FAILS; without the any-state "Portland General"
// spelling -> I6 FAILS.
//
//   npx tsx backend/test/utilityIdentityBridges.test.ts
import "./_isolate"; // FIRST
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import type { RecipeStep } from "../../shared/src/types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "utility-identity-bridges-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(dir, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(dir, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const recipes = await import("../src/portalRecipes");
const kb = await import("../src/knowledgeBase");
const identity = await import("../src/utilityIdentity");
const db = await openDatabase();
if (/autopilot\.sqlite$/.test(String(process.env.AUTOPILOT_DB_PATH))) throw new Error("tests must run on a scratch DB");

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   ${label}`); } catch (err) {
    failures += 1;
    console.log(`  FAIL ${label} — ${err instanceof Error ? err.message : String(err)}`);
  }
};

const PACIFICORP_NM = "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login";
const fill = (i: number): RecipeStep => ({ action: "fill", selector: { name: `f${i}` }, field: "homeownerName", note: `Field ${i}` } as RecipeStep);
const REVIEW = { action: "stopForReview", selector: {} } as RecipeStep;
const completeUtilityRecipe = (state: string, utility: string, portalUrl: string) => {
  const r = recipes.startPortalRecording(db, { scopeType: "utility", state, utility, portalUrl, portalPlatform: "powerclerk", createdBy: "test" });
  return recipes.savePortalRecipeSteps(db, r.id, [{ action: "goto", value: portalUrl } as RecipeStep, fill(1), fill(2), REVIEW], { status: "complete" });
};
const kbUtility = (state: string, utility: string) => kb.findKnowledgeForLearn(db, { state, utility }).utility;
const recipeFor = (state: string, utility: string) => recipes.findCompleteRecipeForProject(db, { scopeType: "utility", state, utility });

console.log("\nI1. THE PREDICATES");
await check("I1. both-known rule, state-aware 'PGE', PG&E known for matching only (never a portal identity)", () => {
  // Same utility, here.
  assert.equal(identity.sameUtilityEntity("UT", "RMP", "Rocky Mountain Power"), true);
  assert.equal(identity.sameUtilityEntity("UT", "Rocky Mtn Power", "PacifiCorp"), true);
  assert.equal(identity.sameUtilityEntity("OR", "Pac Power", "Pacific Power"), true);
  assert.equal(identity.sameUtilityEntity("OR", "P.G.E.", "Portland General Electric"), true);
  assert.equal(identity.sameUtilityEntity("OR", "Portland GE", "Portland General Electric"), true);
  assert.equal(identity.sameUtilityEntity("CA", "PG&E", "Pacific Gas and Electric Company"), true);
  assert.equal(identity.sameUtilityEntity("CA", "PGE", "P.G.&E."), true, "in California the bare acronym is PG&E");
  // "RMP" is Rocky Mountain Power only where Rocky Mountain Power serves.
  assert.equal(identity.sameUtilityEntity("OR", "RMP", "Pacific Power"), false);
  // Provably different: BOTH known, and not the same.
  assert.equal(identity.provablyDifferentUtility("CA", "Pacific Gas and Electric", "Pacific Power"), true);
  assert.equal(identity.provablyDifferentUtility("CA", "PG&E", "Portland General Electric"), true);
  assert.equal(identity.provablyDifferentUtility("OR", "Portland General Electric", "PG&E"), true);
  assert.equal(identity.provablyDifferentUtility("OR", "PGE", "PG&E"), true, "in Oregon the bare acronym is Portland General");
  // Only ONE side known is NOT proof — the fuzzy scorer's question.
  assert.equal(identity.provablyDifferentUtility("UT", "R.M.P.", "Rocky Mountain Power"), false);
  assert.equal(identity.provablyDifferentUtility("UT", "Rocky Mountain Pwr", "Rocky Mountain Power"), false);
  assert.equal(identity.provablyDifferentUtility("", "PG&E", "Portland General Electric"), false, "an unknown state proves nothing");
  // PG&E is a MATCHING identity only: the portal identity is unchanged (leakFixPortal pins the rest).
  assert.equal(identity.knownPowerClerkUtility({ state: "CA", utility: "PG&E" }), null);
  assert.equal(identity.knownPowerClerkUtility({ state: "CA", utility: "Portland General Electric" }), null);
  assert.equal(identity.knownPowerClerkUtility({ state: "UT", utility: "RMP" }), "pacificorp");
  assert.equal(identity.knownPowerClerkUtility({ state: "OR", utility: "RMP" }), null);
});

// The world, through the real writers.
const rmpRecipe = completeUtilityRecipe("UT", "Rocky Mountain Power", PACIFICORP_NM);
const pacRecipe = completeUtilityRecipe("OR", "Pacific Power", PACIFICORP_NM);
kb.saveVerifiedUtilityProfile(db, { state: "UT", utility: "Rocky Mountain Power", portalUrl: PACIFICORP_NM, portalPlatform: "powerclerk", verifiedBy: "test" });

console.log("\nI2-I4. THE SHORT-NAME BRIDGES");
await check("I2. MUST-PASS: UT 'RMP' finds the complete 'Rocky Mountain Power' recipe AND its verified KB row", () => {
  assert.equal(recipeFor("UT", "RMP")?.id, rmpRecipe.id);
  const hit = kbUtility("UT", "RMP");
  assert.ok(hit && hit.utility === "Rocky Mountain Power" && kb.isVerifiedKnowledge(hit), `found ${hit?.utility ?? "nothing"} (verified: ${hit ? kb.isVerifiedKnowledge(hit) : "-"})`);
});

await check("I4. MUST-PASS: 'Rocky Mtn Power' and 'Pac Power' bridge (recipe and KB)", () => {
  assert.equal(recipeFor("UT", "Rocky Mtn Power")?.id, rmpRecipe.id);
  assert.equal(kbUtility("UT", "Rocky Mtn Power")?.utility, "Rocky Mountain Power");
  assert.equal(recipeFor("OR", "Pac Power")?.id, pacRecipe.id);
  const pac = kbUtility("OR", "Pac Power");
  assert.equal(identity.utilityIdentityOf("OR", pac?.utility), "pacificorp", `found ${pac?.utility ?? "nothing"}`);
});

console.log("\nI5. A NAME THE IDENTITY DOES NOT KNOW IS THE FUZZY SCORER'S CALL");
await check("I5. THE KILL: UT 'R.M.P.' (fuzzy 78) and 'Rocky Mountain Pwr' (fuzzy 70) still bridge — only one side is a known identity", () => {
  // Prove the fixture exercises the fuzzy path: one side unknown, a score that clears the bar.
  assert.equal(identity.utilityIdentityOf("UT", "R.M.P."), null);
  assert.equal(identity.utilityIdentityOf("UT", "Rocky Mountain Pwr"), null);
  assert.equal(kb.knowledgeNameMatchScore("R.M.P.", "Rocky Mountain Power"), 78);
  assert.equal(kb.knowledgeNameMatchScore("Rocky Mountain Pwr", "Rocky Mountain Power"), 70);
  assert.equal(recipeFor("UT", "R.M.P.")?.id, rmpRecipe.id, "the recipe alias zeroed a fuzzy 78");
  assert.equal(kbUtility("UT", "R.M.P.")?.utility, "Rocky Mountain Power", "the KB zeroed a fuzzy 78");
  assert.equal(kbUtility("UT", "Rocky Mountain Pwr")?.utility, "Rocky Mountain Power", "the KB zeroed a fuzzy 70");
});

console.log("\nI6. MUST-EXCLUDE: PG&E IS NEVER PORTLAND GENERAL");
// An EMPTY-state row matches in every state (findKnowledgeByName), so this is the case the state
// filter cannot catch. No California row exists yet, so nothing else answers a CA job.
kb.saveVerifiedUtilityProfile(db, { state: "", utility: "Portland General Electric", notes: "Fixture: an imported row with no state.", verifiedBy: "test" });
await check("I6a. CA 'PG&E' / 'PGE' / 'P.G.&E.' never resolve the empty-state 'Portland General Electric' KB row (fuzzy says 78)", () => {
  assert.equal(kb.knowledgeNameMatchScore("PG&E", "Portland General Electric"), 78, "setup: the fuzzy collision this pins");
  for (const u of ["PG&E", "PGE", "P.G.&E."]) {
    const hit = kbUtility("CA", u);
    assert.ok(!hit || !/portland/i.test(hit.utility), `CA ${u} resolved ${hit?.utility} (${hit?.state || "no state"})`);
  }
});
await check("I6b. and a CA 'PG&E' never replays an Oregon Portland General recipe", () => {
  completeUtilityRecipe("OR", "Portland General Electric", "https://pgenm.powerclerk.com/MvcAccount/Login");
  assert.equal(recipes.findAnyRecipeForProject(db, { scopeType: "utility", state: "CA", utility: "PG&E" }), null);
});
kb.saveVerifiedUtilityProfile(db, { state: "", utility: "PG&E", notes: "Fixture: an imported row with no state.", verifiedBy: "test" });
await check("I6c. VICE VERSA: an OR Portland General job never resolves the empty-state 'PG&E' KB row", () => {
  for (const u of ["Portland General Electric Co", "Portland General", "PGE"]) {
    const hit = kbUtility("OR", u);
    assert.ok(hit && identity.utilityIdentityOf("OR", hit.utility) === "portland_general", `OR ${u} resolved ${hit?.utility ?? "nothing"} (${hit?.state || "no state"})`);
  }
});

console.log("\nI3. OREGON'S SPELLINGS OF PORTLAND GENERAL");
kb.saveVerifiedUtilityProfile(db, { state: "OR", utility: "Portland General Electric", portalUrl: "https://pgenm.powerclerk.com/MvcAccount/Login", portalPlatform: "powerclerk", verifiedBy: "test" });
await check("I3. MUST-PASS: OR 'P.G.E.' and 'Portland GE' find the (verified) Portland General Electric KB row", () => {
  for (const u of ["P.G.E.", "Portland GE"]) {
    const hit = kbUtility("OR", u);
    assert.ok(hit && hit.utility === "Portland General Electric" && String(hit.state).toUpperCase() === "OR", `OR ${u} resolved ${hit?.utility ?? "nothing"} (${hit?.state || "no state"})`);
  }
});

console.log("\nI7. THE B9 SYMPTOM STAYS FIXED");
kb.saveVerifiedUtilityProfile(db, { state: "CA", utility: "Pacific Power", portalUrl: PACIFICORP_NM, portalPlatform: "powerclerk", verifiedBy: "test" });
await check("I7. 'PacifiCorp' finds the 'Pacific Power' recipe; CA 'Pacific Gas and Electric' never resolves Pacific Power (fuzzy 65)", () => {
  assert.equal(recipes.findAnyRecipeForProject(db, { scopeType: "utility", state: "OR", utility: "PacifiCorp" })?.id, pacRecipe.id);
  assert.equal(kb.knowledgeNameMatchScore("Pacific Gas and Electric", "Pacific Power"), 65, "setup: the fuzzy collision B9 fixed");
  const hit = kbUtility("CA", "Pacific Gas and Electric");
  assert.ok(!hit || !/pacific power/i.test(hit.utility), `resolved ${hit?.utility}`);
});

console.log(failures ? `\nutilityIdentityBridges: ${failures} check(s) FAILED` : "\nutilityIdentityBridges: all checks passed");
db.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
