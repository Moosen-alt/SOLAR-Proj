// A VALUE BELONGS TO ITS OWN FIELD — and a profile entry is read as the code it names.
//
// Two review rounds found the same class of fault from both sides of the design-criteria check:
//  · on the PACKAGE side, a word or a number that belongs to a NEIGHBOURING field decided this
//    one: a racking span table's last exposure head lent its letter to the speed after it; a
//    limit word ("MAX ROOF SLOPE") silenced every value after it on a period-less sheet; a
//    "MAX ..." that opens the NEXT field dropped the assigned value before it; a value-first
//    "20 PSF GROUND SNOW LOAD: 25 PSF" took the live load's 20 as ground snow; a state named after
//    "CODE" turned the 2021 IRC into a code named "IRCSC";
//  · on the PROFILE side, a state code filed under a model-code token ("IRC 2023 | 2023 Oregon
//    Residential Specialty Code (ORSC)") was compared as an IRC edition.
// Every fixture is SYNTHETIC (invented values; the profile titles are the shapes the research
// seeder writes for public jurisdiction rows). No database, no LLM, no network.
//
// Run: npx tsx backend/test/designCriteriaFieldScope.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { CodeEdition, JurisdictionCodeProfile, ProjectRecord, ReviewerFinding, StatedDesignCriteria } from "../../shared/src/types";
import { buildCodeContext } from "../src/codeProfiles";
import { evaluateDesignCodeFindings } from "../src/codeReviewRules";
import { extractStatedDesignCriteria } from "../src/designCriteria";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const bare = { id: "field-scope-test", parserSnapshot: {} } as unknown as ProjectRecord;
const read = (text: string): StatedDesignCriteria => extractStatedDesignCriteria(bare, [{ label: "Sheet", text }]);
const stated = (text: string, criterion?: string): string[] =>
  read(text).criteria.filter((c) => (!criterion || c.criterion === criterion) && c.criterion !== "asce7Edition").map((c) => `${c.criterion}=${c.value}/${c.qualifier}`).sort();
const codes = (text: string): string[] =>
  read(text).codeBasis.map((b) => `${b.code} ${b.edition}${b.baseCode ? ` (${b.baseCode} ${b.baseEdition})` : ""}`).sort();

const planIn = (state: string, ahj: string): ProjectRecord => ({
  id: "field-scope-plan", state, ahj, utility: "Test Power", homeownerName: "Test Owner", projectAddress: "1 Test St",
  interconnectionMethod: "Load-side breaker", parserSnapshot: { mounting: "Roof mount" },
} as unknown as ProjectRecord);
const profileOf = (state: string, ahj: string, over: Partial<JurisdictionCodeProfile>): JurisdictionCodeProfile => ({
  key: `${state.toLowerCase()}|${ahj.toLowerCase()}|unknown`, state, ahj, confidence: "seeded",
  adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  researchedAt: "2026-09-01T00:00:00.000Z", ...over,
});
const findings = (state: string, ahj: string, text: string, over: Partial<JurisdictionCodeProfile>): ReviewerFinding[] =>
  evaluateDesignCodeFindings(planIn(state, ahj), null, buildCodeContext(state, ahj, profileOf(state, ahj, over)), [], [{ label: "Plan set", text }]);
const has = (fs: ReviewerFinding[], id: string): ReviewerFinding | undefined => fs.find((f) => f.id === id);
const BASIS = "city.code.basis-mismatch";
const BELOW = "city.struct.design-criteria-below-ahj";
const CONFLICT = "city.struct.design-criteria-conflict";

console.log("A. wind: a table head, a row of speeds, a capacity is not a design speed");

const VERIFIED_120_C = { confidence: "verified" as const, designCriteria: { windSpeedMph: 120, windExposure: "C", groundSnowLoadPsf: 25 } };
check("MUST-EXCLUDE: a racking span table's 'EXPOSURE B EXPOSURE C EXPOSURE D 110 MPH 6.0 …' beside a correct 120/C plan -> no below-ahj", () => {
  const t = "DESIGN CRITERIA: WIND SPEED = 120 MPH EXPOSURE CATEGORY = C GROUND SNOW LOAD = 25 PSF. RAIL SPAN TABLE (FT) EXPOSURE B EXPOSURE C EXPOSURE D 110 MPH 6.0 5.3 4.7 120 MPH 5.5 4.8 4.2";
  assert.deepEqual(stated(t, "windSpeedMph"), ["windSpeedMph=120/unspecified"]);
  const fs = findings("OR", "City of Testport", t, VERIFIED_120_C);
  assert.equal(has(fs, BELOW), undefined, has(fs, BELOW)?.message);
  assert.equal(has(fs, CONFLICT), undefined, has(fs, CONFLICT)?.message);
});
check("MUST-EXCLUDE: a row of speeds after one exposure letter ('EXPOSURE C 90 MPH 110 MPH 120 MPH') states no speed", () => {
  assert.deepEqual(stated("EXPOSURE C 90 MPH 110 MPH 120 MPH", "windSpeedMph"), []);
  assert.equal(has(findings("OR", "City of Testport", "EXPOSURE C 90 MPH 110 MPH 120 MPH", VERIFIED_120_C), BELOW), undefined);
});
check("MUST-EXCLUDE: a capacity or a certification ('WIND UPLIFT CAPACITY 115 MPH', '115 MPH MAX', '140 MPH UPLIFT CAPACITY', 'CERTIFIED TO WIND SPEED: 180')", () => {
  assert.deepEqual(stated("WIND UPLIFT CAPACITY 115 MPH MAX", "windSpeedMph"), []);
  assert.deepEqual(stated("RAIL WIND UPLIFT CAPACITY 115 MPH", "windSpeedMph"), []);
  assert.deepEqual(stated("WIND SPEED 140 MPH UPLIFT CAPACITY PER UL 2703", "windSpeedMph"), []);
  assert.deepEqual(stated("RACKING CERTIFIED TO WIND SPEED: 180", "windSpeedMph"), []);
});
check("MUST-PASS: a speed inside an exposure clause still reads ('Exposure B, 95 mph', 'EXPOSURE B 115 MPH ULTIMATE')", () => {
  assert.deepEqual(stated("Exposure B, 95 mph", "windSpeedMph"), ["windSpeedMph=95/unspecified"]);
  assert.deepEqual(stated("EXPOSURE B 115 MPH ULTIMATE", "windSpeedMph"), ["windSpeedMph=115/ultimate"]);
  assert.deepEqual(stated("Vasd = 93 mph Vult = 120 mph", "windSpeedMph"), ["windSpeedMph=120/ultimate", "windSpeedMph=93/nominal"]);
});

console.log("\nB. a limit word governs its own field, not the rest of the line");

check("MUST-PASS: values after a limit's OWN field read ('MAX ROOF SLOPE 30 DEG …', 'UP TO 16 MODULES …', 'NOT TO EXCEED 6 FT …', 'MAX 30 KW …')", () => {
  assert.deepEqual(stated("MAX ROOF SLOPE 30 DEG ROOF TYPE COMP SHINGLE WIND SPEED 110 MPH EXPOSURE C GROUND SNOW LOAD 25 PSF RISK CATEGORY II"),
    ["groundSnowPsf=25/ground", "riskCategory=II/unspecified", "windExposure=C/unspecified", "windSpeedMph=110/unspecified"]);
  assert.deepEqual(stated("INVERTER: IQ8 UP TO 16 MODULES PER BRANCH DESIGN WIND SPEED 115 MPH EXPOSURE B GROUND SNOW 30 PSF"),
    ["groundSnowPsf=30/ground", "windExposure=B/unspecified", "windSpeedMph=115/unspecified"]);
  assert.deepEqual(stated("RAIL SPAN NOT TO EXCEED 6 FT GROUND SNOW LOAD 40 PSF WIND SPEED 100 MPH EXPOSURE B"),
    ["groundSnowPsf=40/ground", "windExposure=B/unspecified", "windSpeedMph=100/unspecified"]);
  assert.deepEqual(stated("SYSTEM SIZE 7.2 KW DC MAX 30 KW WIND SPEED 110 MPH", "windSpeedMph"), ["windSpeedMph=110/unspecified"]);
});
check("MUST-PASS (finding): an under-designed plan after 'MAX ROOF SLOPE 30 DEG' (Pg 20 vs 25 verified) -> below-ahj BLOCKER, not the unknown callout", () => {
  const f = has(findings("IL", "Testfield", "MAX ROOF SLOPE 30 DEG WIND SPEED 110 MPH EXPOSURE C GROUND SNOW LOAD 20 PSF", { confidence: "verified", designCriteria: { groundSnowLoadPsf: 25 } }), BELOW);
  assert.ok(f, "below-ahj must fire");
  assert.equal(f!.severity, "blocker");
  assert.match(f!.message, /stated 20 psf/);
});
check("MUST-EXCLUDE: a checklist's bounds stay bounds ('does not exceed … ( check one ) 120 mph in … C; or 135 mph …')", () => {
  const t = "The basic design wind speed does not exceed the following: Yes No ( check one )  120 mph in Wind Exposure Category C for structures under the OSSC; or  135 mph in Wind Exposure Category B for structures under the OSSC";
  assert.deepEqual(stated(t, "windSpeedMph"), []);
  assert.deepEqual(stated(t, "windExposure"), []);
  const code = "wind loads that do not exceed Risk Category II, Ultimate Wind Speed of 120 mph [95 mph three-second gust in the Residential Code] in exposure C or Risk Category II, Ultimate Wind Speed of 135 mph";
  assert.deepEqual(stated(code, "windSpeedMph"), []);
  assert.deepEqual(stated(code, "riskCategory"), []);
});
check("MUST-EXCLUDE (snow guard): an unassigned ground snow value under a limit earlier in its sentence is a bound", () => {
  assert.deepEqual(stated("Array is located on a structure not exceeding a ground snow load of 50 psf", "groundSnowPsf"), []);
  assert.deepEqual(stated("PRESCRIPTIVE PATH LIMITED TO SITES WITH GROUND SNOW LOAD 70 PSF", "groundSnowPsf"), []);
  // …and a value assigned after the limit is still a statement.
  assert.deepEqual(stated("MAXIMUM ATTACHMENT SPACING 48 IN OC GROUND SNOW LOAD = 25 PSF", "groundSnowPsf"), ["groundSnowPsf=25/ground"]);
});

console.log("\nC. a 'MAX …' that opens the NEXT field never drops an assigned value");

check("MUST-PASS: 'GROUND SNOW LOAD = 25 PSF MAXIMUM ATTACHMENT SPACING 48 IN', 'WIND SPEED: 110 MPH MAX RAIL CANTILEVER 16 IN', 'EXPOSURE CATEGORY: C MAX. SYSTEM VOLTAGE'", () => {
  assert.deepEqual(stated("GROUND SNOW LOAD = 25 PSF MAXIMUM ATTACHMENT SPACING 48 IN", "groundSnowPsf"), ["groundSnowPsf=25/ground"]);
  assert.deepEqual(stated("WIND SPEED: 110 MPH MAX RAIL CANTILEVER 16 IN", "windSpeedMph"), ["windSpeedMph=110/unspecified"]);
  assert.deepEqual(stated("EXPOSURE CATEGORY: C MAX. SYSTEM VOLTAGE 480V", "windExposure"), ["windExposure=C/unspecified"]);
});
check("MUST-PASS (finding): 'GROUND SNOW LOAD = 20 PSF MAXIMUM ATTACHMENT SPACING 48 IN' vs a verified 25 -> below-ahj BLOCKER", () => {
  const f = has(findings("IL", "Testfield", "GROUND SNOW LOAD = 20 PSF MAXIMUM ATTACHMENT SPACING 48 IN", { confidence: "verified", designCriteria: { groundSnowLoadPsf: 25 } }), BELOW);
  assert.ok(f && f.severity === "blocker", f?.message);
});
check("MUST-EXCLUDE: an UNASSIGNED '120 mph max' is still a rating; 'or less' bounds an assigned value too", () => {
  assert.deepEqual(stated("RACKING WIND 120 MPH MAX", "windSpeedMph"), []);
  assert.deepEqual(stated("DESIGN WIND SPEED 120 MPH MAXIMUM", "windSpeedMph"), []);
  assert.deepEqual(stated("Is the ground snow load = 70 psf or less?", "groundSnowPsf"), []);
});

console.log("\nD. value-first snow never takes the previous field's value");

check("MUST-EXCLUDE: 'ROOF LIVE LOAD: 20 PSF GROUND SNOW LOAD: 25 PSF' -> ground snow 25 only; dead load 3 / 35 likewise", () => {
  assert.deepEqual(stated("ROOF LIVE LOAD: 20 PSF GROUND SNOW LOAD: 25 PSF", "groundSnowPsf"), ["groundSnowPsf=25/ground"]);
  assert.deepEqual(stated("ROOF DEAD LOAD: 3 PSF GROUND SNOW LOAD: 25 PSF", "groundSnowPsf"), ["groundSnowPsf=25/ground"]);
  assert.deepEqual(stated("DEAD LOAD = 3 5 PSF GROUND SNOW LOAD = 25 PSF", "groundSnowPsf"), ["groundSnowPsf=25/ground"]);
  assert.deepEqual(stated("DEAD LOAD: 10 PSF ROOF SNOW LOAD: 20 PSF", "roofSnowPsf"), ["roofSnowPsf=20/roof"]);
});
check("MUST-EXCLUDE (finding): a correct 25 psf plan with a live load before it raises neither below-ahj nor conflict against a verified 25", () => {
  const fs = findings("IL", "Testfield", "ROOF LIVE LOAD: 20 PSF GROUND SNOW LOAD: 25 PSF WIND SPEED: 115 MPH", { confidence: "verified", designCriteria: { groundSnowLoadPsf: 25 } });
  assert.equal(has(fs, BELOW), undefined, has(fs, BELOW)?.message);
  assert.equal(has(fs, CONFLICT), undefined, has(fs, CONFLICT)?.message);
});
check("MUST-PASS: a genuine value-first ground snow still reads ('ROOF LIVE LOAD = 20 PSF, 25 PSF GROUND SNOW LOAD', '28 psf ground snow')", () => {
  assert.deepEqual(stated("ROOF LIVE LOAD = 20 PSF, 25 PSF GROUND SNOW LOAD", "groundSnowPsf"), ["groundSnowPsf=25/ground"]);
  assert.deepEqual(stated("Design loads: 28 psf ground snow, 20 psf roof live", "groundSnowPsf"), ["groundSnowPsf=28/ground"]);
});

console.log("\nE. a state named after CODE never swallows a model code's name");

check("MUST-PASS: '… INTERNATIONAL RESIDENTIAL CODE OF THE STATE OF COLORADO' is IRC; '… BUILDING CODE OF THE STATE OF OREGON' is IBC; NY keeps RCNYS", () => {
  assert.deepEqual(codes("APPLICABLE CODES: 2021 INTERNATIONAL RESIDENTIAL CODE OF THE STATE OF COLORADO AS AMENDED 2023 NEC"), ["IRC 2021", "NEC 2023"]);
  assert.deepEqual(codes("APPLICABLE CODES: 2021 INTERNATIONAL BUILDING CODE OF THE STATE OF OREGON 2023 NEC"), ["IBC 2021", "NEC 2023"]);
  assert.deepEqual(codes("GOVERNING CODES: 2020 RESIDENTIAL CODE OF NEW YORK STATE (2020 RCNYS) 2020 FIRE CODE OF NEW YORK STATE"), ["FCNYS 2020", "RCNYS 2020"]);
});
check("MUST-PASS (finding): a stale '2018 INTERNATIONAL RESIDENTIAL CODE OF THE STATE OF COLORADO' against IRC 2021 -> basis-mismatch", () => {
  const f = has(findings("CO", "Testfee County", "APPLICABLE CODES: 2018 INTERNATIONAL RESIDENTIAL CODE OF THE STATE OF COLORADO 2023 NEC", {
    confidence: "verified", adoptedCodes: [{ code: "IRC", edition: "2021" }, { code: "NEC", edition: "2023" }],
  }), BASIS);
  assert.ok(f && /IRC 2018/.test(f.message), f?.message);
});

console.log("\nF. a state code filed under a model-code token is compared as the state code");

// The research seeder's shape (measured on the shared rows for a coastal Oregon city and a
// California city): the STATE code, with the state edition, under the MODEL code's token.
const COOS_SHAPE: CodeEdition[] = [
  { code: "IRC", edition: "2023", title: "2023 Oregon Residential Specialty Code (ORSC) — statewide amended adoption of the 2021 International Residential Code" },
  { code: "IBC", edition: "2022", title: "2022 Oregon Structural Specialty Code (OSSC) — statewide amended adoption of the 2021 International Building Code" },
  { code: "NEC", edition: "2023", title: "2023 Oregon Electrical Specialty Code (OESC) — statewide amended adoption of the 2023 National Electrical Code (NFPA 70)" },
  { code: "IFC", edition: "2022", title: "2022 Oregon Fire Code (OFC) — statewide amended adoption of the 2021 International Fire Code" },
  { code: "IPC", edition: "2023", title: "2023 Oregon Plumbing Specialty Code (OPSC) — statewide amended adoption of the 2021 Uniform Plumbing Code (UPC), NOT the IPC" },
];
const SAC_SHAPE: CodeEdition[] = [
  { code: "IBC", edition: "2022", title: "2022 California Building Code (CBC), California Code of Regulations Title 24, Part 2 — state-adopted, based on the 2021 IBC with California amendments" },
  { code: "IRC", edition: "2022", title: "2022 California Residential Code (CRC), Title 24 Part 2.5 — state-adopted, based on the 2021 IRC with California amendments" },
  { code: "NEC", edition: "2022", title: "2022 California Electrical Code (CEC), Title 24 Part 3 — state-adopted, based on the 2020 NFPA 70 (NEC) with California amendments" },
  { code: "IFC", edition: "2022", title: "2022 California Fire Code (CFC), Title 24 Part 9 — state-adopted (Office of the State Fire Marshal), based on the 2021 IFC with California amendments" },
];
const basisAt = (state: string, ahj: string, adoptedCodes: CodeEdition[], text: string): ReviewerFinding | undefined =>
  has(findings(state, ahj, text, { adoptedCodes }), BASIS);
check("MUST-PASS: correct Oregon plans raise nothing at the Coos Bay shape ('(2021 IFC)', '(2021 IRC)', abbreviations)", () => {
  for (const t of [
    "APPLICABLE CODES: 2023 OREGON RESIDENTIAL SPECIALTY CODE (ORSC), 2023 OREGON ELECTRICAL SPECIALTY CODE (NEC 2023), 2022 OREGON FIRE CODE (2021 IFC)",
    "Design codes: Oregon Residential Specialty Code, 2023 Edition (2021 IRC); Oregon Electrical Specialty Code, 2023 Edition (2023 NEC); Oregon Fire Code, 2022 Edition",
    "GOVERNING CODES: 2023 ORSC, 2023 OESC, 2022 OFC, 2023 NEC",
  ]) {
    const f = basisAt("OR", "City of Coos Bay", COOS_SHAPE, t);
    assert.equal(f, undefined, `${t}\n         -> ${f?.message}`);
  }
});
check("MUST-PASS: a stale '2021 ORSC' and a wrong base '(2018 IRC)' ARE named at the Coos Bay shape", () => {
  const f = basisAt("OR", "City of Coos Bay", COOS_SHAPE, "GOVERNING CODES: 2021 ORSC, 2023 OESC, 2022 OFC");
  assert.ok(f && /ORSC 2021/.test(f.message) && /ORSC 2023/.test(f.message), f?.message);
  const g = basisAt("OR", "City of Coos Bay", COOS_SHAPE, "GOVERNING CODES: 2023 OREGON RESIDENTIAL SPECIALTY CODE (2018 IRC)");
  assert.ok(g && /IRC 2018/.test(g.message) && /IRC 2021/.test(g.message), g?.message);
});
check("MUST-PASS: correct California plans raise nothing at the Sacramento shape; a stale CRC / wrong NEC base is named", () => {
  for (const t of [
    "GOVERNING CODES: 2022 CALIFORNIA RESIDENTIAL CODE (2021 IRC), 2022 CALIFORNIA ELECTRICAL CODE (2020 NEC), 2022 CALIFORNIA FIRE CODE",
    "GOVERNING CODES: 2022 CRC 2022 CEC 2020 NEC 2022 CFC",
  ]) {
    const f = basisAt("CA", "City of Sacramento", SAC_SHAPE, t);
    assert.equal(f, undefined, `${t}\n         -> ${f?.message}`);
  }
  const f = basisAt("CA", "City of Sacramento", SAC_SHAPE, "GOVERNING CODES: 2019 CRC, 2022 CEC (2017 NEC)");
  assert.ok(f && /CRC 2019/.test(f.message) && /NEC 2017/.test(f.message) && /NEC 2020/.test(f.message), f?.message);
});
check("MUST-EXCLUDE: a model-code entry whose title names no state code of its edition is still that model code", () => {
  // Oregon's state row: "IFC 2021 | International Fire Code / Oregon Fire Code (PV access …)".
  const OR_ROW: CodeEdition[] = [{ code: "IFC", edition: "2021", title: "International Fire Code / Oregon Fire Code (PV access & pathways, IFC 1205)" }];
  assert.equal(basisAt("OR", "City of Testport", OR_ROW, "GOVERNING CODES: 2021 IFC"), undefined);
  assert.ok(basisAt("OR", "City of Testport", OR_ROW, "GOVERNING CODES: 2018 IFC"), "a stale IFC is still compared");
  // Michigan's: "IRC 2015 | Michigan Residential Code (state-adopted, based on the 2015 International Residential Code …)".
  const MI_ROW: CodeEdition[] = [{ code: "IRC", edition: "2015", title: "Michigan Residential Code (state-adopted, based on the 2015 International Residential Code with Michigan amendments)" }];
  const f = basisAt("MI", "City of Testville", MI_ROW, "APPLICABLE CODES: 2021 IRC");
  assert.ok(f && /IRC 2021/.test(f.message) && /IRC 2015/.test(f.message), f?.message);
});

console.log("\nG. a limit's field also ends at a field boundary: a list item, a bullet, a label with its own value");

check("MUST-PASS: a value after a NEW list item / bullet / labelled field reads ('(2) WIND SPEED …', '2) …', '• …', 'MAXIMUM ROOF HEIGHT: TWO STORIES …')", () => {
  const all = ["groundSnowPsf=25/ground", "riskCategory=II/unspecified", "windExposure=C/unspecified", "windSpeedMph=110/unspecified"];
  assert.deepEqual(stated("(1) ARRAY NOT TO EXCEED ROOF RIDGE (2) WIND SPEED 110 MPH EXPOSURE C GROUND SNOW LOAD 25 PSF RISK CATEGORY II"), all);
  assert.deepEqual(stated("1) ARRAY NOT TO EXCEED ROOF RIDGE 2) WIND SPEED 110 MPH EXPOSURE C GROUND SNOW LOAD 25 PSF RISK CATEGORY II"), all);
  assert.deepEqual(stated("• RACKING LIMITED TO COMP SHINGLE ROOFS • WIND SPEED 110 MPH EXPOSURE C GROUND SNOW LOAD 25 PSF RISK CATEGORY II"), all);
  assert.deepEqual(stated("• ARRAY NOT TO EXCEED ROOF RIDGE • WIND SPEED 110 MPH EXPOSURE C GROUND SNOW LOAD 25 PSF RISK CATEGORY II"), all);
  assert.deepEqual(stated("MAXIMUM ROOF HEIGHT: TWO STORIES WIND SPEED 110 MPH EXPOSURE C GROUND SNOW LOAD 25 PSF RISK CATEGORY II"), all);
});
check("MUST-PASS (finding): '(1) ARRAY NOT TO EXCEED ROOF RIDGE (2) … GROUND SNOW LOAD 20 PSF' vs a verified 25 -> below-ahj BLOCKER, not the unknown callout", () => {
  const f = has(findings("IL", "Testfield", "(1) ARRAY NOT TO EXCEED ROOF RIDGE (2) WIND SPEED 110 MPH (3) GROUND SNOW LOAD 20 PSF", { confidence: "verified", designCriteria: { groundSnowLoadPsf: 25 } }), BELOW);
  assert.ok(f && f.severity === "blocker" && /stated 20 psf/.test(f.message), f?.message);
});
check("MUST-EXCLUDE: a limit's OWN list stays bounds ('does not exceed (1) 120 mph in … C; (2) 135 mph …', '…the following: 1) …', 'LIMITED TO: (1) WIND SPEED …', bullets of values)", () => {
  for (const t of [
    "The basic design wind speed does not exceed (1) 120 mph in Wind Exposure Category C; (2) 135 mph in Wind Exposure Category B",
    "The basic design wind speed does not exceed the following: (1) 120 mph in Wind Exposure Category C; (2) 135 mph in Wind Exposure Category B",
    "The basic design wind speed does not exceed the following: 1) 120 mph in Wind Exposure Category C 2) 135 mph in Wind Exposure Category B",
    "SYSTEM LIMITED TO: (1) WIND SPEED 110 MPH (2) GROUND SNOW LOAD 70 PSF (3) EXPOSURE C",
    "Wind speed does not exceed: • 120 mph Exposure C • 135 mph Exposure B",
    "• Ground snow load not to exceed 70 psf • Wind speed not to exceed 120 mph",
  ]) assert.deepEqual(stated(t), [], t);
});
check("MUST-EXCLUDE: a form's furniture after the limit's colon is not a field's value ('…the following: Yes No ( check one ) Wind speed 120 mph …')", () => {
  assert.deepEqual(stated("The basic design wind speed does not exceed the following: Yes No ( check one ) Wind speed 120 mph in Exposure Category C"), []);
  assert.deepEqual(stated("Ground snow load does not exceed maximum load: Yes No ( check one ) 50 psf for structures under the ORSC, or 70 psf for structures under the OSSC"), []);
});

if (failures) {
  console.error(`\n${failures} design-criteria field-scope check(s) FAILED`);
  process.exit(1);
}
console.log("\nall design-criteria field-scope checks passed");
process.exit(0);
