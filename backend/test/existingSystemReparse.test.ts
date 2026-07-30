// Re-parse staleness guard: an existing PV system DISCOVERED ON RE-PARSE must
// flip the canonical hasExistingSystem flag. Previously the first parse baked a
// derived value into parser_json and updateProject's merge + canonicalize's
// never-clobber kept it frozen forever (and updateProject persisted the raw
// merged snapshot, so recomputed canonical keys never landed). Run:
//   tsx backend/test/existingSystemReparse.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "existing-reparse-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { createProject, updateProject } = await import("../src/repository");
const db = await openDatabase();

let passed = 0;
const ok = (name: string) => { passed++; console.log(`ok   ${name}`); };

// 1) First parse: plain install, no existing-system evidence → flag absent
//    (blank, not "No") in the persisted snapshot.
const created = createProject(db, {
  owner: "Kristina Anderson", street: "4891 Bonanza Dr NE", city: "Salem", state: "OR", zip: "97305",
  ahj: "City of Salem", utility: "PGE", dcKw: 5.28, acKw: 5.376,
  moduleModel: "ZXM7-UHLD108-440/N", moduleQty: 12,
});
assert.equal(created.project.parserSnapshot.hasExistingSystem, undefined, "no evidence → no flag");
ok("first parse without evidence leaves hasExistingSystem blank");

// 2) Re-parse discovers the existing array → the canonical flag must flip to
//    "Yes" in the PERSISTED snapshot (read back through the repository).
const updated = updateProject(db, created.project.id, {
  existingSystem: "yes", existingDcKw: 5.16, existingAcKw: 7.6,
  existingModuleModel: "SIL 430 QD", combinedDcKw: 10.44, combinedAcKw: 12.976,
});
assert.equal(updated.project.parserSnapshot.hasExistingSystem, "Yes", "re-parse evidence must flip the flag");
assert.equal(updated.project.parserSnapshot.existingDcKw, 5.16, "merge keeps the new evidence");
assert.equal(updated.project.parserSnapshot.moduleModel, "ZXM7-UHLD108-440/N", "merge keeps prior fields");
ok("re-parse evidence flips hasExistingSystem to Yes in the persisted snapshot");

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\nexistingSystemReparse: all ${passed} checks passed`);
