// WHICH PORTAL A PROJECT FILES ON IS NOT A SIDE EFFECT OF AN EDIT.
//
// updateProject re-derives every column from the merged snapshot, so a project whose stored
// columns and snapshot disagree silently adopts the SNAPSHOT's identity on any update.
//
// Live: an Illinois / Commonwealth Edison test project was edited to add plan-evidence text
// — nothing to do with identity — and came back as Oregon / City Of Salem / PGE, because the
// fixture's snapshot carried a copy-pasted PGE identity. The next staging run then opened
// PGE's REAL portal with Illinois data on it. Its sibling il-test-ameren still showed the
// same split (columns IL/Ameren, snapshot OR/PGE), so this was one edit from happening again.
//
// State, AHJ and utility decide WHICH PORTAL a filing goes to — the single thing this
// codebase is most careful about everywhere else. An edit that does not mention them must
// leave them exactly as they were.
// Run: tsx backend/test/projectIdentity.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-identity-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

import { openDatabase } from "../src/db";
import { createProject, updateProject } from "../src/repository";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const db = await openDatabase();

// An Illinois interconnection, exactly like the ComEd fixture.
const made = createProject(db, {
  owner: "Identity Test", street: "2100 Ridge Ave", city: "Evanston", state: "IL", zip: "60201",
  ahj: "City of Evanston", utility: "Commonwealth Edison (ComEd)",
  dcKw: "5.16", acKw: "3.90", moduleQty: "12", moduleWattage: "430",
});
const id = made.project.id;

// Reproduce the corruption the live fixtures had: a snapshot naming a DIFFERENT utility
// than the columns. (Seeded fixtures acquire this by copy-paste; a re-parse can too.)
db.run("UPDATE projects SET parser_json = ? WHERE id = ?", [
  JSON.stringify({ ...made.project.parserSnapshot, state: "OR", ahj: "City Of Salem", utility: "PGE" }),
  id,
]);

check("THE REGRESSION: an edit that never mentions identity cannot move the project's portal", () => {
  const after = updateProject(db, id, { roofPlanNotesText: "2x6 rafters at 24 in on center." }).project;
  assert.equal(after.utility, "Commonwealth Edison (ComEd)", "utility must survive an unrelated edit");
  assert.equal(after.state, "IL", "state must survive");
  assert.equal(after.ahj, "City of Evanston", "AHJ must survive");
});

check("...and the edit it DID ask for still lands", () => {
  const after = updateProject(db, id, { labelsText: "Rapid shutdown label present." }).project;
  assert.match(String((after.parserSnapshot as Record<string, unknown>).labelsText ?? ""), /Rapid shutdown/);
});

check("the snapshot is repaired to agree with the columns, so the next edit is safe too", () => {
  const snap = updateProject(db, id, { snow: "25" }).project.parserSnapshot as Record<string, unknown>;
  assert.equal(snap.utility, "Commonwealth Edison (ComEd)");
  assert.equal(snap.state, "IL");
});

check("an EXPLICIT identity change is still honoured — this is a guard, not a freeze", () => {
  const after = updateProject(db, id, { utility: "Ameren Illinois", ahj: "City of Springfield" }).project;
  assert.equal(after.utility, "Ameren Illinois");
  assert.equal(after.ahj, "City of Springfield");
  assert.equal(after.state, "IL", "unmentioned identity fields still hold");
});

check("an empty string is not an identity change — it is an omission", () => {
  const after = updateProject(db, id, { utility: "   " }).project;
  assert.equal(after.utility, "Ameren Illinois", "blank must not wipe the portal this files on");
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} project-identity check(s) FAILED.`); process.exit(1); }
console.log("\nAll project-identity checks passed.");
process.exit(0);
