// DESIGN-CRITERIA EXTRACTION, MEASURED ON REAL PACKAGES AND OTHER STATES' FORMATS.
//
// Part A — formats measured on the customer corpus (plan sets, engineer letters, racking design
// reports, jurisdiction checklists). Every fixture is a SYNTHETIC string that reproduces the
// measured SHAPE (label, unit, separator, PDF text-layer quirk) with invented values — no names,
// addresses, firms, seals or project numbers. Each MUST-PASS was a miss or a false read on the
// corpus before its fix; each MUST-EXCLUDE is the nearest thing the widened pattern could misread.
//
// Run: npx tsx backend/test/designCriteriaMultiState.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { ProjectRecord, StatedDesignCriteria } from "../../shared/src/types";
import { extractStatedDesignCriteria } from "../src/designCriteria";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const bare = { id: "multi-state-test", parserSnapshot: {} } as unknown as ProjectRecord;
const read = (text: string): StatedDesignCriteria => extractStatedDesignCriteria(bare, [{ label: "Sheet", text }]);
/** "criterion=value/qualifier" for every stated criterion, sorted. */
const stated = (text: string, criterion?: string): string[] =>
  read(text).criteria.filter((c) => !criterion || c.criterion === criterion).map((c) => `${c.criterion}=${c.value}/${c.qualifier}`).sort();
const codes = (text: string): string[] =>
  read(text).codeBasis.map((b) => `${b.code} ${b.edition}${b.baseCode ? ` (${b.baseCode} ${b.baseEdition})` : ""}`).sort();

console.log("A. formats measured on the corpus");

// A PDF text layer split one number into two glyph runs: "GROUND SNOW LOAD = 2 5 PSF" read as
// 2 psf — against a 25+ psf jurisdiction that is a false below-ahj finding.
check("MUST-PASS: a value split by the PDF ('= 2 5 PSF', ': 2 5 PSF') is one number", () => {
  assert.deepEqual(stated("2. GROUND SNOW LOAD = 2 5 PSF 3. WIND SPEED = 110 MPH", "groundSnowPsf"), ["groundSnowPsf=25/ground"]);
  assert.deepEqual(stated("WIND SPEED AND EXPOSURE: 110 MPH, C ROOF SNOW LOAD: 2 5 PSF DEAD LOAD", "roofSnowPsf"), ["roofSnowPsf=25/roof"]);
});
check("MUST-PASS: a split ASCE edition ('ASCE 7-1 6') is 7-16", () => {
  assert.deepEqual(stated("ROOF MATERIAL: COMPOSITE ASCE 7-1 6 WINDSPEEDS", "asce7Edition"), ["asce7Edition=7-16/unspecified"]);
});
check("MUST-EXCLUDE: two numbers are joined only between a separator and the unit", () => {
  assert.deepEqual(stated("ROOF LIVE LOAD 2 5 PSF", "groundSnowPsf"), []);
  assert.deepEqual(stated("GROUND SNOW LOAD = 25 PSF, ITEM 3 5 PSF DEAD", "groundSnowPsf"), ["groundSnowPsf=25/ground"]);
  assert.deepEqual(stated("ASCE 7-16 TABLE 7 2", "asce7Edition"), ["asce7Edition=7-16/unspecified"]);
});

// An engineer letter's criteria table prints the UNIT in its own column before the label, and
// the value with no unit after it: "mph Ult Wind Speed: 110.0".
check("MUST-PASS: 'mph Ult Wind Speed: 110.0' (unit column, no unit after) is 110 mph ultimate", () => {
  const t = "Design Criteria Risk Category: II 20 psf Live Load: mph Ult Wind Speed: 110.0 Exposure Cat: B psf Ground Snow: 15.0 N/A Min Snow Roof:";
  assert.deepEqual(stated(t, "windSpeedMph"), ["windSpeedMph=110/ultimate"]);
  assert.deepEqual(stated(t, "windExposure"), ["windExposure=B/unspecified"]);
  assert.deepEqual(stated(t, "groundSnowPsf"), ["groundSnowPsf=15/ground"]);
});
// A racking vendor's design report: "Wind Speed ASCE 7-10 (3s gust) mph V 120 Ground Snow Load
// psf 25" — the unit sits between label and value.
check("MUST-PASS: a design report's 'Wind Speed … mph V 120' and 'Ground Snow Load psf 25'", () => {
  const t = "ASCE Parameters Unit Equation Value Wind Speed ASCE 7-10 (3s gust) mph V 120 Ground Snow Load psf 25 Exposure Category D Building Risk Category II";
  assert.deepEqual(stated(t, "windSpeedMph"), ["windSpeedMph=120/unspecified"]);
  assert.deepEqual(stated(t, "groundSnowPsf"), ["groundSnowPsf=25/ground"]);
  assert.deepEqual(stated(t, "windExposure"), ["windExposure=D/unspecified"]);
});
check("MUST-EXCLUDE: a speed heading over a row of numbers, a gust duration, a range", () => {
  assert.deepEqual(stated("SPAN TABLE WIND SPEED (MPH) 110 120 130 140 EXPOSURE", "windSpeedMph"), []);
  assert.deepEqual(stated("WIND SPEED: 3-SECOND GUST", "windSpeedMph"), []);
  assert.deepEqual(stated("DESIGN WIND SPEED: 110-120 PER MAP", "windSpeedMph"), []);
  assert.deepEqual(stated("Wind Speed, V ult [mph] Wind Exp. Cat. Roof Height, h [ft] 15", "windSpeedMph"), []);
});

// A calculation summary written value-first: "120 MPH ultimate wind speed".
check("MUST-PASS: the qualifier AFTER a value-first speed ('120 MPH ultimate wind speed')", () => {
  assert.deepEqual(stated("dead load 2.8 PSF, 120 MPH ultimate wind speed, Exposure C per ASCE 7-10.", "windSpeedMph"), ["windSpeedMph=120/ultimate"]);
  assert.deepEqual(stated("checked for 95 mph nominal wind, Exposure B.", "windSpeedMph"), ["windSpeedMph=95/nominal"]);
});

// The engineer letter's roof-snow lines were never read: "Pm", and the calc table's
// "[psf]:" unit-first cells.
check("MUST-PASS: 'Minimum roof snow load, Pm: 20 psf' and calc-table 'p f [psf]: 21' / 'p s [psf]: 19'", () => {
  const t = "Ground snow load, Pg : 28 psf; Pg(asd): 20 psf Minimum roof snow load, Pm: 20 psf (not reducible) Seismic design category: D "
    + "Flat Roof Snow Load, p f [psf]: 21 ASCE 7-22, Equation 7.3-1 Minimum Roof Snow Load, p m [psf]: 0 ASCE 7-22 Sloped Roof Snow Load, p s [psf]: 19 ASCE 7-22";
  assert.deepEqual(stated(t, "roofSnowPsf"), ["roofSnowPsf=19/sloped", "roofSnowPsf=20/roof", "roofSnowPsf=21/flat"]);
  assert.deepEqual(stated(t, "groundSnowPsf"), ["groundSnowPsf=20/ground_asd", "groundSnowPsf=28/ground"]);
  assert.deepEqual(stated("Minimum Snow Load pm (ASCE 7-16 Table 7.3.4) p m = 20 psf.", "roofSnowPsf"), ["roofSnowPsf=20/roof"]);
});
check("MUST-EXCLUDE: a bracketed-unit calc cell with no separator, and a 0 psf 'not applicable'", () => {
  // The measured template repeats Pg under a "(asd)" label in this cell; reading it would put a
  // second, contradictory Pg(asd) in every letter.
  const t = "Ground snow load, Pg : 28 psf; Pg(asd): 20 psf SNOW LOAD (S): Roof Slope [°]: 18 Ground Snow Load, p g (asd) [psf] 28 ASCE 7-22, Section 7.2";
  assert.deepEqual(stated(t, "groundSnowPsf"), ["groundSnowPsf=20/ground_asd", "groundSnowPsf=28/ground"]);
  assert.deepEqual(stated("Minimum Roof Snow Load, p m [psf]: 0 ASCE 7-22", "roofSnowPsf"), []);
});

// A jurisdiction's prescriptive checklist (a public state form) states BOUNDS, not the site's
// values; a plan set that includes it as a sheet must not "state" 120 and 135 mph, Exposure B
// and C, Risk Category I, and 70 psf ground snow.
check("MUST-EXCLUDE: a checklist's bounds across its form furniture ('does not exceed … Yes No ( check one ) 120 mph …; or 135 mph')", () => {
  const t = "Structure is classified Risk Category I or II in accordance with OSSC 1604.5: Yes No x The basic design wind speed does not exceed the following: Yes No ( check one )  120 mph in Wind Exposure Category C for structures under the OSSC; or  135 mph in Wind Exposure Category B for structures under the OSSC; or  135 mph in Wind Exposure Category C for structures under the ORSC x Ground snow load";
  assert.deepEqual(stated(t, "windSpeedMph"), []);
  assert.deepEqual(stated(t, "windExposure"), []);
  assert.deepEqual(stated(t, "riskCategory"), []);
});
check("MUST-EXCLUDE: 'Is the ground snow load 70 psf or less?', a code excerpt's 'do not exceed … 120 mph … in exposure C', a risk list", () => {
  assert.deepEqual(stated("Ground Snow Load Array on habitable structure(s) Is the ground snow load 70 psf or less? Yes No", "groundSnowPsf"), []);
  assert.deepEqual(stated("Wind Is the design wind speed 110 mph or less? Yes No", "windSpeedMph"), []);
  const code = "wind loads that do not exceed Risk Category II, Ultimate Wind Speed of 120 mph [95 mph three-second gust in the Residential Code] in exposure C or Risk Category II, Ultimate Wind Speed of 135 mph [105 mph three-second gust in the Residential Code] in exposures A or B";
  assert.deepEqual(stated(code, "windSpeedMph"), []);
  assert.deepEqual(stated(code, "windExposure"), []);
  assert.deepEqual(stated(code, "riskCategory"), []);
  assert.deepEqual(stated("Identify Risk Category: I II III IV If Risk Category III or IV, the project may not be submitted", "riskCategory"), []);
});
check("MUST-PASS: an ASSIGNED value still reads under a limit word in the same run of text", () => {
  const t = "MAXIMUM ATTACHMENT SPACING 48 IN OC DESIGN CRITERIA: GROUND SNOW LOAD = 25 PSF WIND SPEED = 110 MPH EXPOSURE CATEGORY = C RISK CATEGORY = II";
  assert.deepEqual(stated(t).filter((s) => !s.startsWith("asce")), ["groundSnowPsf=25/ground", "riskCategory=II/unspecified", "windExposure=C/unspecified", "windSpeedMph=110/unspecified"]);
  // A sentence without a limit keeps its unassigned values.
  assert.deepEqual(stated("Plan-set loads: 20 psf roof snow, 110 mph wind Exposure C, Risk Category II.", "windSpeedMph"), ["windSpeedMph=110/unspecified"]);
});

// Code basis.
check("MUST-PASS: a letter's singular 'Design Criteria Code: 2021 WSBC, 2021 WSRC, ASCE 7-16'", () => {
  assert.deepEqual(codes("Design Criteria Code: 2021 WSBC, 2021 WSRC, ASCE 7-16 Risk Category: II"), ["WSBC 2021", "WSRC 2021"]);
});
check("MUST-EXCLUDE: a placard's 'PER CODE: NEC 2020', a portal date '06/03/2026 Result Code'", () => {
  assert.deepEqual(codes("PV AC DISCONNECT PER CODE: NEC 2020 ELECTRICAL SHOCK HAZARD"), []);
  assert.deepEqual(codes("Inspection 06/03/2026 Result Code Approved View Details"), []);
  assert.deepEqual(codes("Evaluation - 3/1/2023 IAS Code: 4.2.1.1.5."), []);
});

if (failures) {
  console.error(`\n${failures} multi-state design-criteria check(s) FAILED`);
  process.exit(1);
}
console.log("\nall multi-state design-criteria checks passed");
