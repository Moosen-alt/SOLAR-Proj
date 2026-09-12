// A PERMIT APPLICATION ASKS ABOUT THE HOUSE, AND THE HOUSE IS DIFFERENT EVERY TIME.
//
// Coos Bay's Accela recipe carried the learn project's house onto every future filing:
// Existing Building Area "1675", Building Height "15" feet, Number of Stories, and an
// Additional Comments line naming that job's 8.36 kW system. The live cross-project sweep
// scored that portal "0 leaks" — correctly, by its own rules: it compares filled values
// against the FIXTURE's value sets, and 1675 is in neither project's set, so it landed in
// "unverifiable". The question bank found them by reading the RECIPE instead of the run.
//
// These now bind. The rules the test pins, in both directions:
//   PARSED WINS      — whatever the plan set states is what gets filed.
//   BLANK STAYS BLANK — a house fact the documents do not state resolves to "", so it
//                       surfaces as an intake question instead of filing somebody else's
//                       house. This is the half that matters: a default here would be a
//                       silent wrong answer with a confident number attached.
//   ROOFTOP FACTS DEFAULT — new building area 0, one dwelling unit, one building are facts
//                       about a rooftop retrofit, not about a project, and the plan set
//                       overrides them whenever it says otherwise.
//   THE NARRATIVE IS DERIVED — workDescription is built from THIS project's own kW, so it
//                       can never carry another job's system size.
//
//   npx tsx backend/test/buildingGeometryBinding.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "geom-"));
process.env.AUTOPILOT_DB_PATH = path.join(scratch, "test.sqlite");

const { openDatabase } = await import("../src/db");
const { resolveRecipeFieldValues } = await import("../src/portalRecipes");

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

const db = await openDatabase();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const projectWith = (snapshot: Record<string, unknown>): any => ({
  id: "p-geom", clientId: null, homeownerName: "ZZ Test", projectAddress: "1 Test St",
  city: "Coos Bay", state: "OR", zip: "97420", ahj: "City of Coos Bay", utility: "Pacific Power",
  parserSnapshot: snapshot,
});

const PARSED = resolveRecipeFieldValues(db, projectWith({
  existingBuildingArea: "2340", buildingHeightFeet: "22", buildingHeightInches: "6",
  numberOfStories: "2", county: "Coos", dcKw: "5.67", acKw: "4.55", mountType: "roof",
}), "accela");

const BLANK = resolveRecipeFieldValues(db, projectWith({}), "accela");

check("PARSED WINS: the plan set's house is what gets filed", () => {
  assert.equal(PARSED.existingBuildingArea, "2340");
  assert.equal(PARSED.buildingHeightFeet, "22");
  assert.equal(PARSED.buildingHeightInches, "6");
  assert.equal(PARSED.numberOfStories, "2");
  assert.equal(PARSED.county, "Coos");
});

check("BLANK STAYS BLANK: an unstated house fact resolves empty, never a default number", () => {
  for (const key of ["existingBuildingArea", "buildingHeightFeet", "buildingHeightInches", "numberOfStories", "county"]) {
    assert.equal(BLANK[key], "",
      `${key} resolved to ${JSON.stringify(BLANK[key])} — a confident wrong number is worse than a blank the operator is asked about`);
  }
});

check("ROOFTOP FACTS DEFAULT: no new area, one unit, one building", () => {
  assert.equal(BLANK.newBuildingArea, "0", "adding panels to a roof creates no new building area");
  assert.equal(BLANK.dwellingUnits, "1");
  assert.equal(BLANK.numberOfBuildings, "1");
});

check("...and the plan set overrides those defaults when it says otherwise", () => {
  const duplex = resolveRecipeFieldValues(db, projectWith({ dwellingUnits: "2", numberOfBuildings: "3", newBuildingArea: "120" }), "accela");
  assert.equal(duplex.dwellingUnits, "2");
  assert.equal(duplex.numberOfBuildings, "3");
  assert.equal(duplex.newBuildingArea, "120");
});

check("THE NARRATIVE IS DERIVED from this project's own numbers", () => {
  assert.match(PARSED.workDescription, /5\.67 kW DC/, `got ${JSON.stringify(PARSED.workDescription)}`);
  assert.match(PARSED.workDescription, /4\.55 kW AC/);
  assert.match(PARSED.workDescription, /^Roof-mounted/);
});

check("MUST NOT: the narrative can never carry the LEARN project's size", () => {
  // 8.36 / 7.68 is the Coos Bay learn job, frozen in the recipe's Additional Comments.
  assert.ok(!PARSED.workDescription.includes("8.36"), "another job's system size reached the comments line");
  assert.ok(!PARSED.workDescription.includes("7.68"));
});

check("a ground mount says so, and a sizeless project says nothing at all", () => {
  const ground = resolveRecipeFieldValues(db, projectWith({ dcKw: "9.9", mountType: "ground" }), "accela");
  assert.match(ground.workDescription, /^Ground-mounted/);
  assert.equal(BLANK.workDescription, "", "a project with no system size must not invent a scope sentence");
});

check("an explicitly supplied description always beats the derived one", () => {
  const explicit = resolveRecipeFieldValues(db, projectWith({ dcKw: "5.67", workDescription: "Reroof and PV" }), "accela");
  assert.equal(explicit.workDescription, "Reroof and PV");
});

check("every new key is ALWAYS present, so a bound step is never called a dead binding", () => {
  for (const key of ["existingBuildingArea", "buildingHeightFeet", "buildingHeightInches", "numberOfStories",
    "newBuildingArea", "dwellingUnits", "numberOfBuildings", "county", "workDescription"]) {
    assert.ok(key in BLANK, `${key} missing from the resolved map entirely`);
  }
});

console.log(failures === 0
  ? "\nAll building-geometry binding checks passed."
  : `\n${failures} building-geometry binding check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
