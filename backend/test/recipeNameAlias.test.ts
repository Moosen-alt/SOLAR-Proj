// A RECIPE MUST OUTLIVE THE SPELLING IT WAS LEARNED UNDER.
// portal_recipes are keyed by a profile key built from the utility/AHJ string as the
// PROJECT spells it. Measured on the live DB: the trusted 60-step PGE recipe is keyed
// "or|unknown|pge", but real PGE projects store "Portland General Electric" and so
// resolved to NO complete recipe. Every NEM stage therefore re-learned the portal from
// scratch (~5 min + planner spend) instead of replaying (~seconds), and the second
// spelling quietly accumulated its own throwaway recording. Same for "Pacific Power".
//
// The fallback reuses the KB's own scorer, which already bridges operator short names to
// legal names. Pins here: the alias hit, that an EXACT key still wins (CLAUDE.md), that
// state never crosses, that unrelated utilities never match, that discipline scoping
// survives the fallback, and that "complete" still means complete.
// Browser-free. Run: tsx backend/test/recipeNameAlias.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-alias-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { startPortalRecording, savePortalRecipeSteps, findCompleteRecipeForProject, findAnyRecipeForProject } = await import("../src/portalRecipes");

let failures = 0;
const run = (label: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ok   - ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}`);
    console.error(`         ${err instanceof Error ? err.message : String(err)}`);
  }
};

const db = await openDatabase();
const complete = (id: string, note: string): void => {
  savePortalRecipeSteps(db, id, [{ action: "goto", phase: "open", value: "https://portal.example/", note }], { status: "complete" });
};

// Learn the portal the way the operator typed it: the short name.
const learned = startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "PGE", portalUrl: "https://powerclerk.example/" });
complete(learned.id, "pge nem entry");

run("a project storing the LEGAL name reaches the recipe learned under the short name", () => {
  const found = findCompleteRecipeForProject(db, { scopeType: "utility", state: "OR", utility: "Portland General Electric", discipline: "" });
  assert.ok(found, "Portland General Electric resolved to nothing — every NEM stage would re-learn the portal");
  assert.equal(found!.id, learned.id);
});

run("...and so does a longer legal variant", () => {
  const found = findCompleteRecipeForProject(db, { scopeType: "utility", state: "OR", utility: "Portland General Electric Co", discipline: "" });
  assert.equal(found?.id, learned.id);
});

run("an EXACT profile-key hit still wins over the alias (CLAUDE.md invariant)", () => {
  // Give the legal spelling its own row, deliberately NEWER than the short-name one.
  const exact = startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "Portland General Electric", portalUrl: "https://powerclerk.example/" });
  complete(exact.id, "legal-name entry");
  assert.notEqual(exact.id, learned.id, "the two spellings are genuinely separate rows");
  const found = findCompleteRecipeForProject(db, { scopeType: "utility", state: "OR", utility: "Portland General Electric", discipline: "" });
  assert.equal(found?.id, exact.id, "the exact key must win — fuzzy only fills a miss");
  // And the short spelling is unaffected by the new row.
  const short = findCompleteRecipeForProject(db, { scopeType: "utility", state: "OR", utility: "PGE", discipline: "" });
  assert.equal(short?.id, learned.id);
});

run("the alias NEVER crosses a state line", () => {
  // A same-named utility in another state is a different portal with different steps.
  const found = findCompleteRecipeForProject(db, { scopeType: "utility", state: "CA", utility: "Portland General Electric", discipline: "" });
  assert.equal(found, null, "matched across states — that would replay the wrong portal");
});

run("a state-less project never aliases (nothing to guard the match with)", () => {
  assert.equal(findCompleteRecipeForProject(db, { scopeType: "utility", utility: "Portland General Electric", discipline: "" }), null);
});

run("an unrelated utility does not fuzzy-match its way onto someone else's recipe", () => {
  assert.equal(findCompleteRecipeForProject(db, { scopeType: "utility", state: "OR", utility: "Idaho Power", discipline: "" }), null);
  assert.equal(findAnyRecipeForProject(db, { scopeType: "utility", state: "OR", utility: "Idaho Power", discipline: "" }), null);
});

run("an INCOMPLETE alias row is not passed off as complete", () => {
  const partial = startPortalRecording(db, { scopeType: "utility", state: "WA", utility: "Puget Sound Energy", portalUrl: "https://powerclerk.example/" });
  assert.equal(partial.status, "recording");
  const asComplete = findCompleteRecipeForProject(db, { scopeType: "utility", state: "WA", utility: "PSE", discipline: "" });
  assert.equal(asComplete, null, "a half-learned recording must not be replayed as if trusted");
  const asAny = findAnyRecipeForProject(db, { scopeType: "utility", state: "WA", utility: "PSE", discipline: "" });
  assert.equal(asAny?.id, partial.id, "but it is still resumable under the alias");
});

run("AHJ scope gets the same bridge, per discipline", () => {
  const structural = startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", discipline: "structural", portalUrl: "https://aca.example/" });
  complete(structural.id, "work location: select city/structural address row");
  // The operator's short spelling finds it.
  const found = findCompleteRecipeForProject(db, { scopeType: "ahj", state: "OR", ahj: "Coos Bay", utility: "Pacific Power", discipline: "structural" });
  assert.equal(found?.id, structural.id);
  // But the ELECTRICAL track must not be handed the structural recipe by the fallback —
  // the discipline gate would refuse it and the track could neither replay nor self-seed.
  const wrongTrack = findCompleteRecipeForProject(db, { scopeType: "ahj", state: "OR", ahj: "Coos Bay", utility: "Pacific Power", discipline: "electrical" });
  assert.equal(wrongTrack, null, "the alias fallback leaked a structural recipe to the electrical track");
});

await new Promise((r) => setTimeout(r, 300));
try { db.close(); } catch { /* worker may hold it briefly */ }
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* leave to OS */ }

if (failures) {
  console.error(`\n${failures} recipe name-alias test(s) failed.`);
  process.exit(1);
}
console.log("\nAll recipe name-alias tests passed.");
process.exit(0);
