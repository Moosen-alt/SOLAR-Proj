// ONE RECIPE PER AHJ PER DISCIPLINE. portal_recipes used to carry a UNIQUE index on
// profile_key alone, so whichever permit discipline learned an AHJ first owned it: the
// other track resolved that same recipe, was forced onto the replay adapter, and the
// discipline gate refused it — so the second discipline could neither replay NOR
// self-seed. Oregon solar files BOTH a city/structural and a county/electrical permit for
// one project, and their portal steps differ (jurisdiction row, record type).
//
// Pins: the track→discipline map, per-discipline isolation of the learn/replace rule, the
// legacy-row fallback, and migration v14's backfill + index swap.
// Browser-free. Run: tsx backend/test/recipeDiscipline.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-discipline-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { startPortalRecording, savePortalRecipeSteps, findCompleteRecipeForProject, findAnyRecipeForProject } = await import("../src/portalRecipes");
const { recipeDisciplineForTrack, recipeDisciplineFromSteps, disciplineConflictsWithTrack } = await import("../src/portalChannel");

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
const AHJ = { scopeType: "ahj" as const, state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power" };

run("track → discipline: the two permit tracks map to different recipes", () => {
  assert.equal(recipeDisciplineForTrack("building"), "structural");
  assert.equal(recipeDisciplineForTrack("electrical"), "electrical");
  // A service upgrade files as an electrical permit; a combo is its own record type.
  assert.equal(recipeDisciplineForTrack("mpu"), "electrical");
  assert.equal(recipeDisciplineForTrack("combo"), "combo");
  // NEM is utility-scoped and has no permit discipline.
  assert.equal(recipeDisciplineForTrack("nem"), "");
  assert.equal(recipeDisciplineForTrack(undefined), "");
});

run("an AHJ holds a SEPARATE recipe per discipline (the old ceiling was one)", () => {
  const structural = startPortalRecording(db, { ...AHJ, discipline: "structural", portalUrl: "https://aca-oregon.accela.com/oregon/" });
  const electrical = startPortalRecording(db, { ...AHJ, discipline: "electrical", portalUrl: "https://aca-oregon.accela.com/oregon/" });
  assert.notEqual(structural.id, electrical.id, "electrical got its own row, not the structural one reset");
  assert.equal(structural.discipline, "structural");
  assert.equal(electrical.discipline, "electrical");
});

run("an electrical learn does NOT destroy the trusted structural recipe", () => {
  const structural = findAnyRecipeForProject(db, { ...AHJ, discipline: "structural" })!;
  savePortalRecipeSteps(db, structural.id, [
    { action: "click", phase: "fill", note: "work location: select city/structural address row" },
    { action: "check", phase: "fill", note: "record type: Residential - Structural" },
  ], { status: "complete" });
  // Re-record the ELECTRICAL side — startPortalRecording resets the row it claims.
  startPortalRecording(db, { ...AHJ, discipline: "electrical", portalUrl: "https://aca-oregon.accela.com/oregon/" });
  const stillComplete = findCompleteRecipeForProject(db, { ...AHJ, discipline: "structural" });
  assert.ok(stillComplete, "the structural recipe survived the electrical learn");
  assert.equal(stillComplete!.steps.length, 2, "and kept its steps");
});

run("each track resolves ITS OWN complete recipe", () => {
  const electrical = findAnyRecipeForProject(db, { ...AHJ, discipline: "electrical" })!;
  savePortalRecipeSteps(db, electrical.id, [
    { action: "click", phase: "fill", note: "work location: select county/electrical address row" },
    { action: "check", phase: "fill", note: "record type: Residential - Electrical Comprehensive" },
  ], { status: "complete" });
  const forBuilding = findCompleteRecipeForProject(db, { ...AHJ, discipline: recipeDisciplineForTrack("building") })!;
  const forElectrical = findCompleteRecipeForProject(db, { ...AHJ, discipline: recipeDisciplineForTrack("electrical") })!;
  assert.notEqual(forBuilding.id, forElectrical.id, "the two tracks no longer share one recipe");
  assert.equal(recipeDisciplineFromSteps(forBuilding.steps), "structural");
  assert.equal(recipeDisciplineFromSteps(forElectrical.steps), "electrical");
  // And neither is the wrong one for its track.
  assert.equal(disciplineConflictsWithTrack(recipeDisciplineFromSteps(forBuilding.steps), "building"), false);
  assert.equal(disciplineConflictsWithTrack(recipeDisciplineFromSteps(forElectrical.steps), "electrical"), false);
});

run("a LEGACY row (discipline '') still resolves for any track", () => {
  const legacyAhj = { scopeType: "ahj" as const, state: "OR", ahj: "City of Legacy", utility: "PGE" };
  const legacy = startPortalRecording(db, { ...legacyAhj, portalUrl: "https://aca-oregon.accela.com/oregon/" });
  savePortalRecipeSteps(db, legacy.id, [{ action: "goto", phase: "open", value: "https://aca-oregon.accela.com/oregon/" }], { status: "complete" });
  db.run("UPDATE portal_recipes SET discipline = '' WHERE id = ?", [legacy.id]);
  for (const track of ["building", "electrical"]) {
    const found = findCompleteRecipeForProject(db, { ...legacyAhj, discipline: recipeDisciplineForTrack(track) });
    assert.ok(found, `legacy recipe still found for the ${track} track`);
    assert.equal(found!.id, legacy.id);
  }
});

run("utility (NEM) recipes are unaffected — no permit discipline", () => {
  const util = { scopeType: "utility" as const, state: "OR", utility: "Pacific Power" };
  const rec = startPortalRecording(db, { ...util, portalUrl: "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login", discipline: "electrical" });
  assert.equal(rec.discipline, "", "a utility recipe never takes a permit discipline");
});

run("migration v14 backfilled discipline from the recorded steps", () => {
  // A pre-migration row: discipline blank, steps that name the discipline.
  db.run(
    `INSERT INTO portal_recipes (id, scope_type, profile_key, state, ahj, utility, portal_platform, portal_url, status, version, steps_json, created_by, created_at, updated_at, notes, discipline)
     VALUES ('legacy-elec', 'ahj', 'or|city of backfill|pge', 'OR', 'City of Backfill', 'PGE', '', '', 'complete', 1, ?, '', '2026-01-01', '2026-01-01', '', '')`,
    [JSON.stringify([{ action: "click", note: "work location: select county/electrical address row" }])],
  );
  db.run("DELETE FROM schema_meta WHERE version >= 14");
  return openDatabase().then((db2) => {
    const row = db2.get<{ discipline: string }>("SELECT discipline FROM portal_recipes WHERE id = 'legacy-elec'");
    assert.equal(row?.discipline, "electrical", "the backfill read the discipline out of the steps");
    db2.close();
  }) as unknown as void;
});

// Give the async migration check above a moment, then tear down.
await new Promise((r) => setTimeout(r, 800));
try { db.close(); } catch { /* worker may hold it briefly */ }
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* leave to OS */ }

if (failures) {
  console.error(`\n${failures} recipe-discipline test(s) failed.`);
  process.exit(1);
}
console.log("\nAll recipe-discipline tests passed.");
process.exit(0);
