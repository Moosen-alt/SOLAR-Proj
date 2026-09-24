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
import type { JurisdictionCodeProfile, ProjectRecord, ReviewerFinding, StatedDesignCriteria } from "../../shared/src/types";
import { buildCodeContext } from "../src/codeProfiles";
import { evaluateDesignCodeFindings } from "../src/codeReviewRules";
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

// ---------------------------------------------------------------------------------------------
// Part B — other states' formats. Shapes taken from PUBLIC sources (a Washington city's public
// permit plan sets, county/state design-criteria tables and code bulletins); values and names
// are synthetic. Each state runs the extractor AND the comparison against a profile shaped like
// that state's real profile rows, so a correct plan stays silent and a stale one is named.
console.log("\nB. other states' formats");

const planIn = (state: string, ahj: string): ProjectRecord => ({
  id: "multi-state-plan", state, ahj, utility: "Test Power", homeownerName: "Test Owner", projectAddress: "1 Test St",
  interconnectionMethod: "Load-side breaker", parserSnapshot: { mounting: "Roof mount" },
} as unknown as ProjectRecord);
const profileOf = (state: string, ahj: string, over: Partial<JurisdictionCodeProfile>): JurisdictionCodeProfile => ({
  key: `${state.toLowerCase()}|${ahj.toLowerCase()}|unknown`, state, ahj, confidence: "seeded",
  adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  researchedAt: "2026-09-01T00:00:00.000Z", ...over,
});
const findings = (state: string, ahj: string, text: string, over: Partial<JurisdictionCodeProfile>): ReviewerFinding[] =>
  evaluateDesignCodeFindings(planIn(state, ahj), null, buildCodeContext(state, ahj, profileOf(state, ahj, over)), [], [{ label: "Plan set", text }]);
const BASIS = "city.code.basis-mismatch";
const BELOW = "city.struct.design-criteria-below-ahj";
const has = (fs: ReviewerFinding[], id: string): ReviewerFinding | undefined => fs.find((f) => f.id === id);
const ed = (code: string, edition: string) => ({ code, edition });

// WASHINGTON — two cover-sheet templates seen on a WA city's public permit plans.
const WA_A = "AHJ CITY OF TESTLAKE ENVIRONMENTAL WIND SPEED: 110 MPH SNOW LOAD: 15 PSF EXPOSURE CATEGORY: B UTILITY TEST POWER COVER SHEET CODES AND STANDARDS WITH AMENDMENTS 2021 IBC 2021 IFC 2021 IRC 2023 NEC PROJECT NOTES: - THIS PHOTOVOLTAIC (PV) SYSTEM SHALL COMPLY";
const WA_B = "DESIGN CRITERIA WIND SPEED: 110 mph GROUND SNOW LOAD: 15 lb/ft² WIND EXPOSURE FACTOR: C SEISMIC DESIGN CATEGORY: D SITE SPECIFICATIONS GOVERNING CODES ALL WORK SHALL CONFORM TO THE FOLLOWING CODES 2021 WASHINGTON STATE BUILDING CODE (IBC) 2021 WASHINGTON STATE RESIDENTIAL CODE (IRC) 2021 WASHINGTON STATE FIRE CODE 2023 NATIONAL ELECTRIC CODE";
const WA_CODES = [ed("IRC", "2021"), ed("IBC", "2021"), ed("IFC", "2021"), ed("NEC", "2023")];
check("WA MUST-PASS: 'WIND EXPOSURE FACTOR: C', 'GROUND SNOW LOAD: 15 lb/ft²', '(IBC)'/'(IRC)' after the state's name", () => {
  assert.deepEqual(stated(WA_B).filter((s) => !s.startsWith("asce")), ["groundSnowPsf=15/ground", "windExposure=C/unspecified", "windSpeedMph=110/unspecified"]);
  assert.deepEqual(codes(WA_B), ["IBC 2021", "IRC 2021", "NEC 2023", "WSFC 2021"]);
  assert.deepEqual(codes(WA_A), ["IBC 2021", "IFC 2021", "IRC 2021", "NEC 2023"]);
});
check("WA MUST-EXCLUDE: a bare 'SNOW LOAD: 15 PSF' is not labelled ground snow; the snow 'Exposure Factor, C e : 0.9' is no wind exposure", () => {
  assert.deepEqual(stated(WA_A, "groundSnowPsf"), []);
  assert.deepEqual(stated(WA_A, "windExposure"), ["windExposure=B/unspecified"]);
  assert.deepEqual(stated("ASCE 7-16, Table 7.3-1 Exposure Factor, C e : 0.9 Thermal Factor, C t : 1.1", "windExposure"), []);
});
check("WA: a plan matching the WA profile is silent; one a cycle behind is named", () => {
  assert.ok(!has(findings("WA", "City of Testlake", WA_A, { adoptedCodes: WA_CODES }), BASIS), "matching plan -> no basis finding");
  assert.ok(!has(findings("WA", "City of Testlake", WA_B, { adoptedCodes: WA_CODES }), BASIS), "state-named codes with (IBC)/(IRC) -> no basis finding");
  const f = has(findings("WA", "City of Testlake", WA_A.replace("2021 IRC", "2018 IRC"), { adoptedCodes: WA_CODES }), BASIS);
  assert.ok(f && /IRC 2018/.test(f.message) && !/IBC/.test(f.message.split("—")[0]), f?.message);
});

// CALIFORNIA — the CRC/CEC/CFC cover list (a county's solar checklist asks for exactly these),
// a 0 psf ground snow, and a California Energy Code that is NOT the Electrical Code.
const CA = "GOVERNING CODES: 2022 CALIFORNIA RESIDENTIAL CODE (CRC) 2022 CALIFORNIA ELECTRICAL CODE (CEC) 2022 CALIFORNIA FIRE CODE (CFC) 2022 CALIFORNIA ENERGY CODE DESIGN CRITERIA: ULTIMATE WIND SPEED: 110 MPH EXPOSURE CATEGORY: C GROUND SNOW LOAD: 0 PSF SEISMIC DESIGN CATEGORY: D";
check("CA MUST-PASS: 'GROUND SNOW LOAD: 0 PSF' is a stated value; CRC/CEC/CFC parse; the Energy Code is not the CEC", () => {
  assert.deepEqual(stated(CA).filter((s) => !s.startsWith("asce")), ["groundSnowPsf=0/ground", "windExposure=C/unspecified", "windSpeedMph=110/ultimate"]);
  assert.deepEqual(codes(CA), ["CEC 2022", "CEC-ENERGY 2022", "CFC 2022", "CRC 2022"]);
});
check("CA: a 2022-cycle plan against the 2025 profile is named (CRC, CEC), never through the Energy Code", () => {
  const f = has(findings("CA", "City of Testvale", CA, { adoptedCodes: [ed("CRC", "2025"), ed("CEC-CA", "2025"), ed("T24-P6", "2025")] }), BASIS);
  assert.ok(f && /CRC 2022/.test(f.message) && /CEC 2022/.test(f.message) && !/CEC-ENERGY/.test(f.message), f?.message);
  assert.ok(!has(findings("CA", "City of Testvale", CA, { adoptedCodes: [ed("CRC", "2022"), ed("CEC-CA", "2022"), ed("CFC", "2022")] }), BASIS));
});

// FLORIDA — HVHZ wind data: Vult and Vasd side by side; the residential volume by ordinal edition.
const FL = "FLORIDA BUILDING CODE, RESIDENTIAL 8TH EDITION (2023) 2020 NATIONAL ELECTRICAL CODE WIND DESIGN DATA: ULTIMATE DESIGN WIND SPEED (Vult): 175 MPH NOMINAL DESIGN WIND SPEED (Vasd): 136 MPH RISK CATEGORY: II EXPOSURE CATEGORY: C HVHZ: YES";
const FL_CODES = [ed("FBC-R", "2023"), ed("FBC-B", "2023"), ed("NEC", "2020")];
check("FL MUST-PASS: Vult 175 (ultimate) and Vasd 136 (nominal) kept apart; FBC-R 2023 + NEC 2020", () => {
  assert.deepEqual(stated(FL, "windSpeedMph"), ["windSpeedMph=136/nominal", "windSpeedMph=175/ultimate"]);
  assert.deepEqual(codes(FL), ["FBC-R 2023", "NEC 2020"]);
  assert.ok(!has(findings("FL", "Testdade County", FL, { adoptedCodes: FL_CODES, designCriteria: { windSpeedMph: 175, windExposure: "C" } }), BELOW), "the Vasd 136 is never compared with a 175 Vult");
  const f = has(findings("FL", "Testdade County", FL.replace("(Vult): 175", "(Vult): 170"), { adoptedCodes: FL_CODES, designCriteria: { windSpeedMph: 175 } }), BELOW);
  assert.ok(f && /170/.test(f.message) && !/136/.test(f.message), f?.message);
});
check("MUST-EXCLUDE: the NEXT field's 'NOMINAL … WIND SPEED' never qualifies the value before it", () => {
  assert.deepEqual(stated("WIND SPEED: 150 MPH NOMINAL DESIGN WIND SPEED: 116 MPH", "windSpeedMph"), ["windSpeedMph=116/nominal", "windSpeedMph=150/unspecified"]);
  assert.deepEqual(stated("DESIGN WIND SPEED 150 MPH ULTIMATE, EXPOSURE C", "windSpeedMph"), ["windSpeedMph=150/ultimate"]);
});

// COLORADO — high ground snow and a county table's "115 mph Vult." (qualifier after the value).
const CO = "DESIGN CRITERIA: GROUND SNOW LOAD (Pg): 110 PSF ROOF SNOW LOAD: 77 PSF WIND SPEED: 115 mph Vult. EXPOSURE CATEGORY: C SEISMIC DESIGN CATEGORY: C";
check("CO MUST-PASS: Pg 110 psf, roof 77 psf, '115 mph Vult.' is ultimate; a 120 psf county value names the 110", () => {
  assert.deepEqual(stated(CO).filter((s) => !s.startsWith("asce")), ["groundSnowPsf=110/ground", "roofSnowPsf=77/roof", "windExposure=C/unspecified", "windSpeedMph=115/ultimate"]);
  const f = has(findings("CO", "Testfee County", CO, { designCriteria: { groundSnowLoadPsf: 120 } }), BELOW);
  assert.ok(f && /110/.test(f.message) && !/77/.test(f.message), f?.message);
});
check("MUST-EXCLUDE: a value-first snow read never takes a value another snow label assigned; a heading's colon assigns nothing", () => {
  assert.deepEqual(stated("ROOF SNOW LOAD: 20 PSF GROUND SNOW LOAD = 25 PSF", "groundSnowPsf"), ["groundSnowPsf=25/ground"]);
  assert.deepEqual(stated("Plan-set loads: 20 psf roof snow, 20 psf roof live", "roofSnowPsf"), ["roofSnowPsf=20/roof"]);
});

// IDAHO / ARIZONA / TEXAS — model codes by name, "WIND DESIGN SPEED", "ULT. WIND SPEED", Vult = .
check("ID/AZ/TX MUST-PASS: 'WIND DESIGN SPEED: 90 MPH', 'ULT. WIND SPEED: 110 MPH (3-SEC GUST)', 'Vult = 150 MPH, EXPOSURE D'", () => {
  assert.deepEqual(stated("GROUND SNOW LOAD: 20 PSF WIND DESIGN SPEED: 90 MPH", "windSpeedMph"), ["windSpeedMph=90/unspecified"]);
  assert.deepEqual(stated("ULT. WIND SPEED: 110 MPH (3-SEC GUST) EXPOSURE: C GROUND SNOW LOAD: 0 PSF").filter((s) => !s.startsWith("asce")), ["groundSnowPsf=0/ground", "windExposure=C/unspecified", "windSpeedMph=110/ultimate"]);
  assert.deepEqual(stated("WIND LOADS PER ASCE 7-16: Vult = 150 MPH, EXPOSURE D, RISK CATEGORY II").filter((s) => !s.startsWith("asce")), ["riskCategory=II/unspecified", "windExposure=D/unspecified", "windSpeedMph=150/ultimate"]);
  assert.deepEqual(codes("APPLICABLE CODES: 2018 INTERNATIONAL RESIDENTIAL CODE 2018 INTERNATIONAL BUILDING CODE 2023 NATIONAL ELECTRICAL CODE"), ["IBC 2018", "IRC 2018", "NEC 2023"]);
});
check("ID MUST-EXCLUDE: 'roof load shall not be less than a uniform snow load of 25 psf' is a code minimum, not a value", () => {
  assert.deepEqual(stated("Design roof load shall not be less than a uniform snow load of 25 psf.", "roofSnowPsf"), []);
  assert.deepEqual(stated("Design roof load shall not be less than a uniform snow load of 25 psf.", "groundSnowPsf"), []);
});

// ILLINOIS — Chicago's own codes recorded as "CBC-CHI" / "CEC-CHI"; the rest of the state on the IECC.
const CHI = "GOVERNING CODES: 2019 CHICAGO BUILDING CODE 2018 CHICAGO ELECTRICAL CODE 2021 INTERNATIONAL ENERGY CONSERVATION CODE";
check("IL MUST-PASS: a Chicago plan is compared with the 'CBC-CHI'/'CEC-CHI' profile rows", () => {
  assert.deepEqual(codes(CHI), ["CBC 2019", "CEC 2018", "IECC 2021"]);
  assert.ok(!has(findings("IL", "Chicago", CHI, { adoptedCodes: [ed("CBC-CHI", "2019"), ed("CEC-CHI", "2018")] }), BASIS), "matching plan -> silent");
  const f = has(findings("IL", "Chicago", CHI, { adoptedCodes: [ed("CBC-CHI", "2019"), ed("CEC-CHI", "2023")] }), BASIS);
  assert.ok(f && /CEC 2018/.test(f.message) && /CEC-CHI 2023/.test(f.message), f?.message);
});

// NEW YORK — "… CODE OF NEW YORK STATE (2020 RCNYS)": the state is part of the name, and the
// parenthetical is the code's own abbreviation, not a base.
const NY = "GOVERNING CODES: 2020 RESIDENTIAL CODE OF NEW YORK STATE (2020 RCNYS) 2020 FIRE CODE OF NEW YORK STATE 2023 NATIONAL ELECTRICAL CODE DESIGN CRITERIA: ULTIMATE DESIGN WIND SPEED: 115 MPH GROUND SNOW LOAD: 50 PSF";
check("NY MUST-PASS: RCNYS / FCNYS parse whole, no self-base; stale RCNYS named against the profile", () => {
  assert.deepEqual(codes(NY), ["FCNYS 2020", "NEC 2023", "RCNYS 2020"]);
  assert.deepEqual(codes("APPLICABLE CODES: 2020 RCNYS, 2020 BCNYS, 2020 FCNYS, 2023 NEC"), ["BCNYS 2020", "FCNYS 2020", "NEC 2023", "RCNYS 2020"]);
  assert.deepEqual(stated(NY).filter((s) => !s.startsWith("asce")), ["groundSnowPsf=50/ground", "windSpeedMph=115/ultimate"]);
  assert.ok(!has(findings("NY", "Town of Testville", NY, { adoptedCodes: [ed("RCNYS", "2020"), ed("NEC", "2023")] }), BASIS));
  const f = has(findings("NY", "Town of Testville", NY, { adoptedCodes: [ed("RCNYS", "2025"), ed("NEC", "2023")] }), BASIS);
  assert.ok(f && /RCNYS 2020/.test(f.message), f?.message);
});
check("MUST-EXCLUDE: '2017 & 2020 NEC CODE' is the NEC, never a code named 'NC'", () => {
  assert.deepEqual(codes("LABELING REQUIREMENTS BASED ON THE 2017 & 2020 NEC CODE, OSHA STANDARD"), ["NEC 2020"]);
});

if (failures) {
  console.error(`\n${failures} multi-state design-criteria check(s) FAILED`);
  process.exit(1);
}
console.log("\nall multi-state design-criteria checks passed");
