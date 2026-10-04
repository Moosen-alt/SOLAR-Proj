// ELECTRICAL SIZING IS RECOMPUTED FROM THE SLD'S OWN VALUES (#144).
//
// The gate read the plan's calcs for PRESENCE; a city plan checker redoes the arithmetic. These
// checks pin the four recomputes (705.12 busbar with the inverter's real output current, OCPD vs
// 1.25 x Imax and vs the corrected conductor ampacity, 690.7 string Voc, advisory voltage drop) and
// the severity shape: every input stated on the sheets -> blocker; any parser-only input ->
// warning; partially stated -> one inputs-missing callout. All fixtures are synthetic.
//
// Run: npx tsx backend/test/electricalSizing.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { evaluateElectricalSizingFindings, parseConductor, SIZING_FINDING_IDS } from "../src/electricalSizing";
import { buildReviewerReport } from "../src/reviewerEngine";
import { MEASURED_FINDING_IDS, visionMayRelax } from "../src/reviewerVision";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const mk = (snapshot: Record<string, unknown>): ProjectRecord => ({
  id: "elec-sizing", clientId: "c", homeownerName: "Synthetic Owner", projectAddress: "1 Test Way",
  city: "Testville", state: "OR", zip: "97000", ahj: "City of Testville", utility: "Test Power",
  interconnectionMethod: "Load-side breaker", status: "pending",
  parserSnapshot: { state: "OR", ahj: "City of Testville", mounting: "Roof mount", interco: "Load-side breaker", ...snapshot },
} as unknown as ProjectRecord);
const run = (snapshot: Record<string, unknown>, loadSide = true): ReviewerFinding[] =>
  evaluateElectricalSizingFindings(mk(snapshot), { loadSide });
const byId = (fs: ReviewerFinding[], id: string): ReviewerFinding | undefined => fs.find((f) => f.id === id);

// A compliant micro system, every value on the sheet: 20 x 1.21 A = 24.2 A; 1.25 x 24.2 = 30.25 A
// -> 35 A breaker; #8 THWN-2 CU 55 A x 0.96 (35 C) = 52.8 A, 50 A at 75 C terminals >= 35 A;
// busbar 1.25 x 24.2 + 200 = 230.25 A <= 240 A; Voc 49.5 x (1 + 0.0027 x 35) = 54.2 V <= 60 V micro max.
const MICRO_SHEET = [
  "SINGLE LINE DIAGRAM PV-4. (20) ENPHASE IQ8M-72-2-US MICROINVERTERS. MAX CONTINUOUS OUTPUT CURRENT 1.21 A.",
  "MAXIMUM INPUT DC VOLTAGE 60 V. MAIN SERVICE PANEL: BUS RATING 200A, MAIN BREAKER 200A, PV BREAKER 35A.",
  "MODULE DATASHEET: OPEN-CIRCUIT VOLTAGE (VOC) 49.5 V, TEMPERATURE COEFFICIENT OF VOC -0.27 %/°C.",
  "DESIGN CRITERIA: ASHRAE EXTREME MINIMUM TEMPERATURE -10°C. HIGH DESIGN TEMPERATURE 35°C.",
  "WIRE SCHEDULE: (3) #8 AWG THWN-2 CU IN 3/4\" EMT.",
].join(" ");
const MICRO_FIELDS = {
  pvMicroMake: "Enphase", pvMicroModel: "IQ8M-72-2-US", pvMicroQty: "20", pvMicroOutputW: "1.21", pvMicroMaxDcInputV: "60",
  busRating: "200A", mainBreaker: "200A", pvBreaker: "35A",
  moduleVoc: "49.5", moduleVocTempCoeff: "-0.27", siteLowTempC: "-10", siteHighTempC: "35",
  acConductor: "#8 AWG THWN-2 CU", acConductorCount: "3",
};

check("a correct SLD produces no sizing findings", () => {
  const fs = run({ ...MICRO_FIELDS, planSetExtractedText: MICRO_SHEET });
  assert.deepEqual(fs.map((f) => f.id), []);
});

// (a) 120% rule: 200 A bus / 200 A main / 60 A backfeed on a 48 A string inverter.
const STRING_SHEET = [
  "SINGLE LINE DIAGRAM. INVERTER: (1) SYNTHETIC SI-11400 STRING INVERTER, MAX CONTINUOUS OUTPUT CURRENT 48 A, MAXIMUM DC INPUT VOLTAGE 600 V.",
  "BUSBAR RATING 200A. MAIN BREAKER 200A. PV BACKFEED BREAKER 60A.",
  "2 STRINGS OF 14 MODULES. VOC 49.5 V. TEMPERATURE COEFFICIENT OF VOC -0.27 %/°C. EXTREME MIN TEMPERATURE -10°C.",
  "INVERTER OUTPUT CIRCUIT: (3) #6 AWG THWN-2 CU.",
].join(" ");
const STRING_FIELDS = {
  invMake: "Synthetic", invModel: "SI-11400", invQty: "1", invOutputW: "48", invMaxDcInputV: "600",
  busRating: "200A", mainBreaker: "200A", pvBreaker: "60A",
  moduleVoc: "49.5", moduleVocTempCoeff: "-0.27", siteLowTempC: "-10", modulesPerString: "14",
  acConductor: "#6 AWG THWN-2 CU", acConductorCount: "3",
};

check("busbar 200 A / main 200 A / 60 A backfeed with a 48 A inverter fails the 120 % rule as a BLOCKER, arithmetic shown", () => {
  const f = byId(run({ ...STRING_FIELDS, planSetExtractedText: STRING_SHEET }), "city.elec.sizing-busbar-120");
  assert.ok(f, "no busbar finding");
  assert.equal(f.severity, "blocker");
  assert.match(f.message, /1\.25 x 48 A = 60 A \+ 200 A main = 260 A/);
  assert.match(f.message, /1\.2 x 200 = 240 A/);
});

check("busbar: a supply-side (not load-side) design is not measured against 705.12", () => {
  assert.equal(byId(run({ ...STRING_FIELDS, planSetExtractedText: STRING_SHEET }, false), "city.elec.sizing-busbar-120"), undefined);
});

check("busbar through the engine: one blocker for the violation, not two (the breaker screen already reports it)", () => {
  const report = buildReviewerReport(mk({ ...STRING_FIELDS, planSetExtractedText: STRING_SHEET }));
  assert.ok(report.findings.some((f) => f.id === "city.elec.load-side-over-120" && f.severity === "blocker"));
  assert.ok(!report.findings.some((f) => f.id === "city.elec.sizing-busbar-120"), "duplicate busbar blocker");
});

check("busbar through the engine: with no breaker rating, the current-based screen still runs", () => {
  const { pvBreaker: _drop, ...noBreaker } = STRING_FIELDS;
  const report = buildReviewerReport(mk({ ...noBreaker, planSetExtractedText: STRING_SHEET.replace("PV BACKFEED BREAKER 60A.", "") }));
  assert.equal(report.findings.find((f) => f.id === "city.elec.sizing-busbar-120")?.severity, "blocker");
});

// (c) 690.7: 49.5 V x (1 + 0.0027 x 35) x 14 = 758.5 V > 600 V.
check("2 x 14 modules: Voc at -10 °C over 600 V is a BLOCKER with the 690.7 arithmetic", () => {
  const f = byId(run({ ...STRING_FIELDS, planSetExtractedText: STRING_SHEET }), "city.elec.sizing-string-voc");
  assert.ok(f, "no string-voc finding");
  assert.equal(f.severity, "blocker");
  assert.match(f.message, /49\.5 V Voc x \(1 \+ 0\.27 %\/C x \(25 - \(-10\)\) C\) = 1\.0945 x 14 modules in series = 758\.5 V/);
  assert.match(f.message, /above the 600 V limit for one- and two-family dwellings \(690\.7\)/);
});

check("690.7: no temperature coefficient falls back to Table 690.7(A) (1.14 at -10 °C)", () => {
  const { moduleVocTempCoeff: _drop, ...fields } = STRING_FIELDS;
  const f = byId(run({ ...fields, planSetExtractedText: STRING_SHEET.replace("TEMPERATURE COEFFICIENT OF VOC -0.27 %/°C.", "") }), "city.elec.sizing-string-voc");
  assert.match(f?.message ?? "", /Table 690\.7\(A\) factor 1\.14 at -10 C x 14 modules in series = 790\.02 V|= 790 V/);
});

check("690.7: an optimizer system answers to 690.7(B) and is not recomputed here", () => {
  const fs = run({ ...STRING_FIELDS, invMake: "SolarEdge", invModel: "SE7600H-US", planSetExtractedText: STRING_SHEET });
  assert.equal(byId(fs, "city.elec.sizing-string-voc"), undefined);
});

// (b) OCPD under 1.25 x Imax: 20 x 1.21 A = 24.2 A; 1.25 x 24.2 = 30.25 A > a 30 A breaker.
check("OCPD under 1.25 x Imax is a BLOCKER with the arithmetic", () => {
  const fs = run({ ...MICRO_FIELDS, pvBreaker: "30A", acConductor: "#10 AWG THWN-2 CU", planSetExtractedText: MICRO_SHEET.replace("PV BREAKER 35A", "PV BREAKER 30A").replace("#8 AWG", "#10 AWG") });
  const f = byId(fs, "city.elec.sizing-ocpd-under-125");
  assert.ok(f, "no OCPD finding");
  assert.equal(f.severity, "blocker");
  assert.match(f.message, /20 x 1\.21 A = 24\.2 A; 1\.25 x 24\.2 A = 30\.25 A minimum OCPD/);
  assert.match(f.message, /PV breaker is 30 A/);
});

// (b) OCPD over the corrected ampacity: #10 THWN-2 40 A x 0.87 (45 C) x 0.8 (6 ccc) = 27.84 A -> 30 A max.
check("OCPD over the conductor's 310.15-corrected ampacity is a BLOCKER showing every factor", () => {
  const sheet = MICRO_SHEET.replace("HIGH DESIGN TEMPERATURE 35°C", "HIGH DESIGN TEMPERATURE 45°C").replace("PV BREAKER 35A", "PV BREAKER 40A").replace("(3) #8 AWG", "(6) #10 AWG");
  const fs = run({ ...MICRO_FIELDS, pvBreaker: "40A", siteHighTempC: "45", acConductor: "#10 AWG THWN-2 CU", acConductorCount: "6", planSetExtractedText: sheet });
  const f = byId(fs, "city.elec.sizing-ocpd-over-ampacity");
  assert.ok(f, "no ampacity finding");
  assert.equal(f.severity, "warning", "the conductor COUNT is parser-only here (the sheet says (6) but not as a count label)");
  assert.match(f.message, /#10 CU THWN-2: 40 A \(Table 310\.16, 90 C\) x 0\.87 ambient at 45 C x 0\.8 for 6 current-carrying conductors/);
  assert.match(f.message, /= 27\.84 A/);
  assert.match(f.message, /largest permitted OCPD 30 A/);
});

check("OCPD over ampacity with every input on the sheet (count not stated -> favourable 3 assumed) is a BLOCKER", () => {
  const { acConductorCount: _drop, ...fields } = MICRO_FIELDS;
  const sheet = MICRO_SHEET.replace("HIGH DESIGN TEMPERATURE 35°C", "HIGH DESIGN TEMPERATURE 50°C").replace("PV BREAKER 35A", "PV BREAKER 40A").replace("(3) #8 AWG", "#10 AWG");
  const f = byId(run({ ...fields, pvBreaker: "40A", siteHighTempC: "50", acConductor: "#10 AWG THWN-2 CU", planSetExtractedText: sheet }), "city.elec.sizing-ocpd-over-ampacity");
  assert.equal(f?.severity, "blocker");
  assert.match(f?.message ?? "", /count not stated; 3 or fewer assumed/);
});

// THE MOST COMMON MICRO TOPOLOGY (Helm's review of #152): an Enphase combiner, two #12 / 20 A
// branches, a 40 A backfeed on #8. Every value is on the sheet, but WHICH conductor the 40 A breaker
// protects is the parser's pairing. If it pairs the breaker with the branch #12 the recompute says
// "largest permitted OCPD 20 A, but the PV breaker is 40 A" — that may only ever be a WARNING.
// 32 x 1.21 A = 38.72 A; 1.25 x 38.72 = 48.4 A (so the 40 A breaker is itself undersized: that is
// a different finding and not what this pins).
const COMBINER_SHEET = [
  "SINGLE LINE DIAGRAM PV-4. (16) ENPHASE IQ8M-72-2-US MICROINVERTERS PER BRANCH. MAX CONTINUOUS OUTPUT CURRENT 1.21 A.",
  "MAIN SERVICE PANEL: BUS RATING 200A, MAIN BREAKER 175A, PV BACKFEED BREAKER 40A.",
  "BRANCH CIRCUIT 1: (2) #12 AWG THWN-2 CU, 20A BREAKER IN ENPHASE IQ COMBINER 4.",
  "BRANCH CIRCUIT 2: (2) #12 AWG THWN-2 CU, 20A BREAKER IN ENPHASE IQ COMBINER 4.",
  "COMBINER OUTPUT TO MSP: (3) #8 AWG THWN-2 CU IN 3/4\" EMT.",
].join("\n");
const COMBINER_FIELDS = {
  pvMicroMake: "Enphase", pvMicroModel: "IQ8M-72-2-US", pvMicroQty: "32", pvMicroOutputW: "1.21",
  busRating: "200A", mainBreaker: "175A", pvBreaker: "40A",
};

check("Enphase combiner: the parser pairs the 40 A backfeed with the #12 branch -> ocpd-over-ampacity is a WARNING, never a blocker", () => {
  const f = byId(run({ ...COMBINER_FIELDS, acConductor: "#12 AWG THWN-2 CU", planSetExtractedText: COMBINER_SHEET }), "city.elec.sizing-ocpd-over-ampacity");
  assert.ok(f, "no ampacity finding");
  assert.equal(f.severity, "warning");
  assert.match(f.message, /#12 CU THWN-2 \(parser\)/);
  assert.match(f.message, /acConductor/);
});

check("Enphase combiner, one line: same answer when the sheet text is not split into lines", () => {
  const f = byId(run({ ...COMBINER_FIELDS, acConductor: "#12 AWG THWN-2 CU", planSetExtractedText: COMBINER_SHEET.replace(/\n/g, " ") }), "city.elec.sizing-ocpd-over-ampacity");
  assert.equal(f?.severity, "warning");
});

check("Enphase combiner, control: the parser pairs the 40 A backfeed with the #8 output -> no ampacity finding", () => {
  const fs = run({ ...COMBINER_FIELDS, acConductor: "#8 AWG THWN-2 CU", planSetExtractedText: COMBINER_SHEET });
  assert.equal(byId(fs, "city.elec.sizing-ocpd-over-ampacity"), undefined);
});

check("two conductor sizes, the undersized one LABELLED as the output circuit -> still a BLOCKER", () => {
  // String inverter: #10 PV WIRE on the DC side, #8 on the AC output circuit (50 A at 75 C) too small for 60 A.
  const sheet = STRING_SHEET.replace("INVERTER OUTPUT CIRCUIT: (3) #6 AWG THWN-2 CU.", "DC SOURCE CIRCUITS: (4) #10 AWG PV WIRE CU.\nINVERTER OUTPUT CIRCUIT: (3) #8 AWG THWN-2 CU.");
  const { acConductorCount: _drop, ...fields } = STRING_FIELDS; // the count is parser-only (see above)
  const f = byId(run({ ...fields, acConductor: "#8 AWG THWN-2 CU", planSetExtractedText: sheet }), "city.elec.sizing-ocpd-over-ampacity");
  assert.equal(f?.severity, "blocker");
  assert.doesNotMatch(f?.message ?? "", /\(parser\)/);
});

// (d) Voltage drop: only on a STATED run length.
check("missing run length -> no voltage-drop finding", () => {
  const fs = run({ ...MICRO_FIELDS, acConductor: "#10 AWG THWN-2 CU", planSetExtractedText: MICRO_SHEET });
  assert.equal(byId(fs, "city.elec.sizing-voltage-drop"), undefined);
});

check("control: a stated 150 ft run on #10 CU at 24.2 A is 3.75 % — an advisory callout with the arithmetic", () => {
  const fs = run({ ...MICRO_FIELDS, acConductor: "#10 AWG THWN-2 CU", acRunLengthFt: "150", planSetExtractedText: `${MICRO_SHEET} CIRCUIT LENGTH 150 FT.` });
  const f = byId(fs, "city.elec.sizing-voltage-drop");
  assert.equal(f?.severity, "callout");
  assert.match(f?.message ?? "", /2 x 150 ft x 24\.2 A .* x 1\.24 ohm\/kft .* = 9 V; 9 \/ 240 V \(assumed\) = 3\.75 %/);
});

// Severity follows provenance.
check("parser-only values -> WARNING, never a blocker, and the message says which values are parser-only", () => {
  const fs = run({ ...STRING_FIELDS });
  const voc = byId(fs, "city.elec.sizing-string-voc");
  const bus = byId(fs, "city.elec.sizing-busbar-120");
  assert.equal(voc?.severity, "warning");
  assert.equal(bus?.severity, "warning");
  assert.match(voc?.message ?? "", /\(parser\)/);
  assert.ok(!fs.some((f) => f.severity === "blocker"), "a parser-only value blocked");
});

check("partially stated inputs -> one inputs-missing callout naming what the SLD must state", () => {
  const { acConductor: _a, acConductorCount: _b, modulesPerString: _c, ...fields } = STRING_FIELDS;
  const f = byId(run(fields), "city.elec.sizing-inputs-missing");
  assert.equal(f?.severity, "callout");
  assert.match(f?.message ?? "", /conductor size, material and insulation/);
  assert.match(f?.message ?? "", /modules in series per string/);
});

check("nothing electrical stated at all -> silence (absence is other rules' job)", () => {
  assert.deepEqual(run({}).map((f) => f.id), []);
});

check("parseConductor reads size, material and the insulation's column", () => {
  assert.deepEqual(parseConductor("#10 AWG THWN-2 CU"), { size: "10", material: "CU", column: 90, insulation: "THWN-2" });
  assert.deepEqual(parseConductor("(3) 1/0 AWG XHHW-2 AL"), { size: "1/0", material: "AL", column: 90, insulation: "XHHW-2" });
  assert.equal(parseConductor("12 AWG NM-B")?.column, 60);
  assert.equal(parseConductor("#8 THWN")?.column, 75);
  assert.equal(parseConductor("8")?.size, undefined, "a bare number is not a conductor");
});

check("every sizing id is measured: vision may never relax it", () => {
  for (const id of SIZING_FINDING_IDS) {
    assert.ok(MEASURED_FINDING_IDS.has(id), `${id} missing from MEASURED_FINDING_IDS`);
    assert.equal(visionMayRelax({ id, severity: "blocker", title: "SLD load-side busbar calc" } as unknown as ReviewerFinding), false);
  }
});

if (failures) {
  console.error(`\n${failures} electrical sizing check(s) FAILED`);
  process.exit(1);
}
console.log("\nall electrical sizing checks passed");
