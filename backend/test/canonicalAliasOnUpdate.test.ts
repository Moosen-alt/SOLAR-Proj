// #225: editing a source field must move its canonical alias. updateProject merges the edit over
// the stored snapshot and canonicalizeSnapshot never clobbers a present key, so a stored
// inverterModel derived from invModel outlived an edit to invModel — and isMlpeDesign (which joins
// both) kept treating a corrected string-inverter design as microinverters. Run:
//   tsx backend/test/canonicalAliasOnUpdate.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-alias-update-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { createProject, updateProject } = await import("../src/repository");
const { isMlpeDesignForProject } = await import("../src/codeReviewRules");
const db = await openDatabase();

let failed = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) console.log(`ok   - ${name}`);
  else { failed++; console.log(`FAIL - ${name}${detail === undefined ? "" : ` (got ${JSON.stringify(detail)})`}`); }
};

const base = {
  owner: "Test Owner", street: "100 Example St", city: "Testville", state: "OR", zip: "97000",
  ahj: "City of Testville", utility: "Test Utility", dcKw: 8, acKw: 7.6,
  moduleMake: "TestSolar", moduleModel: "TS-400", moduleQty: "20", busRating: "200",
};

// 1) Enphase micros / 20 → Sunny Boy string / 1: the aliases follow, MLPE turns off.
{
  const created = createProject(db, { ...base, invModel: "Enphase IQ8M-72-2-US", invQty: "20" });
  const snap0 = created.project.parserSnapshot;
  check("create derives inverterModel from invModel", snap0.inverterModel === "Enphase IQ8M-72-2-US", snap0.inverterModel);
  check("create: design is MLPE", isMlpeDesignForProject(created.project));
  const updated = updateProject(db, created.project.id, { invModel: "Sunny Boy SB7.7-1SP-US-41", invQty: "1" });
  const snap = updated.project.parserSnapshot;
  check("edit invModel → inverterModel follows", snap.inverterModel === "Sunny Boy SB7.7-1SP-US-41", snap.inverterModel);
  check("edit invQty → inverterQuantity follows", snap.inverterQuantity === "1", snap.inverterQuantity);
  check("edited design is no longer MLPE", !isMlpeDesignForProject(updated.project));
  // An unrelated edit leaves the (now current) aliases alone.
  const again = updateProject(db, created.project.id, { zip: "97001" });
  check("unrelated edit keeps the re-derived alias", again.project.parserSnapshot.inverterModel === "Sunny Boy SB7.7-1SP-US-41", again.project.parserSnapshot.inverterModel);
}

// 2) An inverterModel set explicitly in the update wins over its source.
{
  const created = createProject(db, { ...base, invModel: "Enphase IQ8M-72-2-US", invQty: "20" });
  const updated = updateProject(db, created.project.id, { invModel: "Sunny Boy SB7.7-1SP-US-41", inverterModel: "SB7.7-1SP-US-41 (operator)" });
  check("explicit inverterModel in the update is kept", updated.project.parserSnapshot.inverterModel === "SB7.7-1SP-US-41 (operator)", updated.project.parserSnapshot.inverterModel);
  // …and it is not an echo of invModel, so a later invModel-only edit does not overwrite it.
  const later = updateProject(db, created.project.id, { invModel: "Sunny Boy SB6.0-1SP-US-41" });
  check("operator-set inverterModel survives a later source edit", later.project.parserSnapshot.inverterModel === "SB7.7-1SP-US-41 (operator)", later.project.parserSnapshot.inverterModel);
}

// 3) The other aliases canonicalization fills from a parser field follow too (audit).
{
  const created = createProject(db, {
    ...base, invMake: "Enphase", invModel: "IQ8M-72-2-US", invQty: "20",
    batteryMake: "TestCell", batteryModel: "TC-10", batteryQty: "1", batteryCapacityKwh: "10",
    ownerPhone: "555-0100", moduleWattage: "400",
  });
  const updated = updateProject(db, created.project.id, {
    moduleMake: "OtherSolar", moduleQty: "24", moduleWattage: "410", invMake: "SMA",
    batteryMake: "OtherCell", batteryQty: "2", batteryCapacityKwh: "20", busRating: "225", ownerPhone: "555-0199",
  });
  const s = updated.project.parserSnapshot as Record<string, unknown>;
  const expect: Record<string, string> = {
    moduleManufacturer: "OtherSolar", moduleQuantity: "24", moduleWatts: "410", inverterManufacturer: "SMA",
    batteryManufacturer: "OtherCell", batteryQuantity: "2", essKwh: "20", mainServiceRating: "225", homeownerPhone: "555-0199",
  };
  for (const [key, want] of Object.entries(expect)) check(`edit moves ${key}`, s[key] === want, s[key]);
  const arrays = s.pvArrays as Array<Record<string, unknown>>;
  check("edit moves the derived pvArrays", Array.isArray(arrays) && arrays[0]?.quantity === "24" && arrays[0]?.moduleManufacturer === "OtherSolar", arrays);
}

// 4) A pvArrays list provided on its own (not the single-array build) is kept across a module edit.
{
  const pvArrays = [{ quantity: "10", moduleModel: "TS-400", tilt: "20", azimuth: "180" }, { quantity: "10", moduleModel: "TS-400", tilt: "20", azimuth: "90" }];
  const created = createProject(db, { ...base, pvArrays });
  const updated = updateProject(db, created.project.id, { moduleQty: "22" });
  check("a provided multi-array pvArrays is kept", JSON.stringify(updated.project.parserSnapshot.pvArrays) === JSON.stringify(pvArrays), updated.project.parserSnapshot.pvArrays);
}

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
if (failed) { console.log(`\ncanonicalAliasOnUpdate: ${failed} check(s) FAILED`); process.exit(1); }
console.log("\ncanonicalAliasOnUpdate: all checks passed");
