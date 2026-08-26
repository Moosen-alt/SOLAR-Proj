// RE-RECORD MUST NOT DESTROY THE WORKING RECIPE. Starting a re-record used to wipe
// a complete recipe's steps before anything new was captured — an abandoned re-record
// left the portal with NO working recipe at all (production-readiness residual #1).
// Now the outgoing steps are snapshotted at re-record start, and the stale-recording
// sweep restores them when the attempt is abandoned; a finished re-record clears the
// snapshot. Browser-free. Run: tsx backend/test/recipeRerecordSnapshot.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RecipeStep } from "../../shared/src/types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-snapshot-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
// Make the 2h abandonment threshold instant so the sweep sees fresh rows as stale.
process.env.RECIPE_RECORDING_STALE_MS = "0";

const { openDatabase } = await import("../src/db");
const { startPortalRecording, savePortalRecipeSteps, getPortalRecipe } = await import("../src/portalRecipes");
const { recoverStalePortalRecordings } = await import("../src/jobQueue");
const db = await openDatabase();

let passed = 0;
const ok = (n: string) => { passed++; console.log(`ok   ${n}`); };

const provenSteps: RecipeStep[] = [
  { action: "fill", selector: { name: "owner_name" }, field: "homeownerName", value: "Jane Doe" },
  { action: "click", selector: { text: "Continue" } },
  { action: "stopForReview", selector: {} },
];
const scope = { scopeType: "utility" as const, state: "OR", utility: "PGE" };

// A proven, complete recipe exists for the portal.
const original = startPortalRecording(db, { ...scope, portalUrl: "https://pge.example/portal" });
savePortalRecipeSteps(db, original.id, provenSteps);
assert.equal(getPortalRecipe(db, original.id).status, "complete");

// 1) Starting a re-record wipes the live steps but keeps them recoverable.
const rerecord = startPortalRecording(db, scope);
assert.equal(rerecord.id, original.id, "re-record reuses the same recipe row");
assert.equal(rerecord.status, "recording");
assert.equal(rerecord.steps.length, 0, "live steps are cleared for the new capture");
const snap = db.get<{ prev_steps_json?: string }>("SELECT prev_steps_json FROM portal_recipes WHERE id = ?", [original.id]);
assert.equal(JSON.parse(String(snap?.prev_steps_json)).length, provenSteps.length, "outgoing steps snapshotted");
ok("re-record start snapshots the outgoing steps before wiping");

// 2) An ABANDONED re-record is rolled back to the proven recipe by the stale sweep.
recoverStalePortalRecordings(db);
const restored = getPortalRecipe(db, original.id);
assert.equal(restored.status, "complete", "abandoned re-record restores the previous complete recipe");
assert.equal(restored.steps.length, provenSteps.length, "the proven steps are back");
assert.equal(restored.steps[0].field, "homeownerName");
assert.match(restored.notes, /restored the previous working recipe/);
ok("abandoned re-record restores the previous working recipe (no recipe-less portal)");

// 3) Re-recording twice in a row must not clobber the good snapshot with attempt one's
//    empty stub: after an immediate second re-record, the snapshot still restores.
startPortalRecording(db, scope); // attempt 1 (wipes, snapshots proven steps)
startPortalRecording(db, scope); // attempt 2 (steps are now [] — snapshot must survive)
recoverStalePortalRecordings(db);
assert.equal(getPortalRecipe(db, original.id).steps.length, provenSteps.length, "snapshot survived back-to-back re-records");
ok("back-to-back re-records keep the original snapshot");

// 4) A FINISHED re-record supersedes the snapshot: new steps stand, and a later sweep
//    has nothing to restore or mark.
startPortalRecording(db, scope);
const newSteps: RecipeStep[] = [
  { action: "fill", selector: { name: "applicant" }, field: "homeownerName", value: "Jane Doe" },
  { action: "stopForReview", selector: {} },
];
savePortalRecipeSteps(db, original.id, newSteps);
recoverStalePortalRecordings(db);
const finished = getPortalRecipe(db, original.id);
assert.equal(finished.status, "complete");
assert.equal(finished.steps.length, newSteps.length, "the NEW recording stands");
assert.equal(finished.steps[0].selector.name, "applicant");
const cleared = db.get<{ prev_steps_json?: string }>("SELECT prev_steps_json FROM portal_recipes WHERE id = ?", [original.id]);
assert.ok(!cleared?.prev_steps_json, "completing the re-record drops the snapshot");
ok("finished re-record supersedes the snapshot; nothing left to roll back");

// 5) A FIRST recording abandoned with no history still goes to needs_rerecord (no
//    snapshot to restore) — the pre-existing sweep behavior is unchanged.
const fresh = startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj: "City of Salem", portalUrl: "https://salem.example" });
recoverStalePortalRecordings(db);
assert.equal(getPortalRecipe(db, fresh.id).status, "needs_rerecord", "first recording with no snapshot is marked needs_rerecord");
ok("first-ever abandoned recording still surfaces as needs_rerecord");

console.log(`\nrecipeRerecordSnapshot: all ${passed} checks passed`);
