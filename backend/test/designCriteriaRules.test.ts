// DESIGN CRITERIA ARE CHECKED FOR VALUE, NOT JUST PRESENCE.
//
// Two real bounces (fixtures below are SYNTHETIC strings modelled on their facts — no names,
// addresses, firms or seals):
//   A. A coastal city: "Ground snow load 36 psf. Provide updated design criteria for the
//      letter from the engineer and the plan set." The plan printed GROUND SNOW 16 PSF.
//   B. Another coastal city: "The structural engineered design criteria is conflicting
//      between the calculations and the submitted plans set" (ORSC R106), and "minimum wind
//      speed design is 120 MPH Ultimate Exposure D". Plan 110 mph / Exp C / Pg 20; a sealed
//      calculation 95 mph / Exp B / Pg 28 that claimed to "supersede" the plan for loads.
//   C. A plan's own GOVERNING CODES block + ASCE 7-10 wind/roof-snow site detail.
//
// Every MUST-PASS below fails with the rule removed; every MUST-EXCLUDE is a real way the
// widened patterns could misread a package.
//
// Run: npx tsx backend/test/designCriteriaRules.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { JurisdictionCodeProfile, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { buildCodeContext } from "../src/codeProfiles";
import { evaluateDesignCodeFindings } from "../src/codeReviewRules";
import { extractStatedDesignCriteria, type DesignTextSource } from "../src/designCriteria";
import { buildReviewerReport } from "../src/reviewerEngine";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const project = (snapshot: Record<string, unknown>, over: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: "design-criteria-test",
  state: "OR",
  ahj: "City of Testport",
  utility: "Test Power",
  homeownerName: "Test Owner",
  projectAddress: "1 Test St",
  interconnectionMethod: "Load-side breaker",
  parserSnapshot: { mounting: "Roof mount", ...snapshot },
  ...over,
} as unknown as ProjectRecord);

const profile = (over: Partial<JurisdictionCodeProfile>): JurisdictionCodeProfile => ({
  key: "or|city of testport|unknown", state: "OR", ahj: "City of Testport", confidence: "seeded",
  adoptedCodes: [{ code: "ORSC", edition: "2023" }, { code: "OESC", edition: "2023" }, { code: "NEC", edition: "2023" }],
  amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  researchedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});
const ctxFor = (over: Partial<JurisdictionCodeProfile>) => buildCodeContext("OR", "City of Testport", profile(over));

const run = (p: ProjectRecord, ctx = ctxFor({}), docs: DesignTextSource[] = []): ReviewerFinding[] =>
  evaluateDesignCodeFindings(p, null, ctx, [], docs);
const get = (fs: ReviewerFinding[], id: string): ReviewerFinding | undefined => fs.find((f) => f.id === id);

const CONFLICT = "city.struct.design-criteria-conflict";
const BELOW = "city.struct.design-criteria-below-ahj";
const UNKNOWN = "city.struct.design-criteria-unknown";
const BASIS = "city.code.basis-mismatch";

// ---------------------------------------------------------------------------------------
// Case A — plan states 16 psf ground snow; the city requires 36.
// ---------------------------------------------------------------------------------------
const A_PLAN = "STRUCTURAL NOTES: 1. ROOF LIVE LOAD = 20 PSF TYPICAL, 0 PSF UNDER NEW PV SYSTEM. 2. GROUND SNOW LOAD = 16 PSF 3. WIND SPEED = 120 MPH 4. EXPOSURE CATEGORY = C 5. RISK CATEGORY = II "
  + "ROOF MATERIAL: COMPOSITE SHINGLE ASCE 7-10 WINDSPEEDS: (3 SEC GUST IN MPH) WIND SPEED AND EXPOSURE: 120 MPH, C ROOF SNOW LOAD: 16 PSF DEAD LOAD FOR ROOF-MOUNTED PANELS ATTACHMENTS: 2.85 PSF";
const caseA = project({ snow: "16", windSpeed: "120", wind: "C", riskCategory: "II", planSetExtractedText: A_PLAN });

check("A: extractor reads Pg 16 (labelled), wind 120, Exp C, roof snow 16 — and never the note number or roof live", () => {
  const s = extractStatedDesignCriteria(caseA);
  const values = (crit: string) => [...new Set(s.criteria.filter((c) => c.criterion === crit).map((c) => c.value))];
  assert.deepEqual(values("groundSnowPsf"), [16]);
  assert.deepEqual(values("windSpeedMph"), [120]);
  assert.deepEqual(values("windExposure"), ["C"]);
  assert.deepEqual(values("roofSnowPsf"), [16]);
  assert.deepEqual(values("riskCategory"), ["II"]);
  assert.ok(s.criteria.some((c) => c.source === "Parsed project fields" && c.derived), "parser fields are a (derived) source");
});

check("A: below-ahj fires vs a SEEDED profile carrying Pg 36 — warning, names 16 vs 36 and the provenance", () => {
  const f = get(run(caseA, ctxFor({ designCriteria: { groundSnowLoadPsf: 36 } })), BELOW);
  assert.ok(f, "below-ahj must fire");
  assert.equal(f!.severity, "warning", "seeded profile -> warning");
  assert.match(f!.message, /16 psf/);
  assert.match(f!.message, /36 psf/);
  assert.match(f!.message, /seeded/i);
});

check("A: below-ahj is a BLOCKER vs a human-verified profile", () => {
  const f = get(run(caseA, ctxFor({ confidence: "verified", verifiedBy: "operator", verifiedAt: "2026-09-20T00:00:00Z", designCriteria: { groundSnowLoadPsf: 36 } })), BELOW);
  assert.equal(f?.severity, "blocker");
  assert.match(f!.message, /human-verified/);
});

check("A: provenance names the ROW used — a city resolved to the state-level default is not called a verified city profile", () => {
  const stateCtx = buildCodeContext("OR", "City of Testport", profile({ key: "or||unknown", ahj: "", confidence: "verified", designCriteria: { groundSnowLoadPsf: 36 } }));
  const f = get(run(caseA, stateCtx), BELOW);
  assert.match(f!.message, /OR state-level code profile \(human-verified/);
  assert.doesNotMatch(f!.message, /City of Testport code profile/);
});

check("A: a row verified only by the shipped reference seed is not called human-verified", () => {
  const seedCtx = ctxFor({ confidence: "verified", verifiedBy: "reference-seed", verifiedAt: "2026-07-02T00:00:00Z", designCriteria: { groundSnowLoadPsf: 36 } });
  const f = get(run(caseA, seedCtx), BELOW);
  assert.match(f!.message, /shipped reference seed/);
  assert.doesNotMatch(f!.message, /human-verified/);
});

check("A: profile has no criteria -> UNKNOWN callout quoting the stated 16 psf / 120 mph (never silent, never a blocker)", () => {
  const fs = run(caseA, ctxFor({ designCriteria: {} }));
  const f = get(fs, UNKNOWN);
  assert.ok(f, "unknown callout must fire");
  assert.equal(f!.severity, "callout");
  assert.match(f!.message, /16 psf/);
  assert.match(f!.message, /120 mph/);
  assert.match(f!.message, /not on file/i);
  assert.ok(!get(fs, BELOW), "nothing to compare -> no below-ahj");
});

check("A: no profile at all (model-code defaults) still raises the UNKNOWN callout", () => {
  const f = get(run(caseA, buildCodeContext("OR", "City of Nowhere", null)), UNKNOWN);
  assert.equal(f?.severity, "callout");
});

check("A MUST-EXCLUDE: stated values AT the AHJ's criteria -> no below-ahj, no unknown", () => {
  const fs = run(caseA, ctxFor({ designCriteria: { groundSnowLoadPsf: 16, windSpeedMph: 120, windExposure: "C" } }));
  assert.ok(!get(fs, BELOW), "equal values are not below");
  assert.ok(!get(fs, UNKNOWN), "criteria on file -> no unknown callout");
});

check("A MUST-EXCLUDE: a ground-mount array gets no roof UNKNOWN callout", () => {
  const ground = project({ snow: "16", windSpeed: "120", wind: "C", mounting: "Ground mount", planSetExtractedText: A_PLAN });
  assert.ok(!get(run(ground, ctxFor({ designCriteria: {} })), UNKNOWN));
});

check("A MUST-EXCLUDE: no jurisdiction context (legacy path) -> none of the new findings", () => {
  const fs = evaluateDesignCodeFindings(caseA, null, undefined, []);
  assert.ok(![CONFLICT, BELOW, UNKNOWN, BASIS].some((id) => get(fs, id)));
});

// ---------------------------------------------------------------------------------------
// Case B — plan 110/C/Pg 20 vs sealed calculation 95/B/Pg 28 that "supersedes".
// ---------------------------------------------------------------------------------------
const B_PLAN = "STRUCTURAL NOTES: 1. ROOF LIVE LOAD = 20 PSF TYPICAL, 0 PSF UNDER NEW PV SYSTEM. 2. GROUND SNOW LOAD = 20 PSF 3. WIND SPEED = 110 MPH 4. EXPOSURE CATEGORY = C 5. RISK CATEGORY = II "
  + "ASCE 7-10 WINDSPEEDS: (3 SEC GUST IN MPH) WIND SPEED AND EXPOSURE: 110 MPH, C ROOF SNOW LOAD: 20 PSF";
const B_CALC_SUMMARY = "Plan-set loads: 20 psf roof snow, 20 psf roof live (0 under array), 110 mph wind Exposure C, Risk Category II, PV adds 2.37 psf. "
  + "A sealed structural analysis supersedes for loads: Exposure B, 95 mph, Risk Category II, ground snow 28 psf, total roof snow 20 psf.";
const B_LETTER = "Loading Summary Exposure and Occupancy Categories B II Wind Loading: v 95 mph qz 13.74 psf pg 28.00 psf Ground Snow Load pg "
  + "Exposure Category (ASCE 7-22 Table 26.7.3, Page 274) Fully Exposed Exposure category Ce = 0.9 Exposure Factor, Ce (ASCE 7-22 Table 7.3-1, Page 61) "
  + "q z = 13.74 psf Vasd q z = 8.34 psf Basic wind pressure V= 95 mph p f = 17.64 psf p m = 20 psf p f = 20.00 psf Total Snow Load p s = 20.00 psf";
// Production shape (repository.buildReviewerReportFor): one source per stored document, and the
// snapshot's planSetExtractedText is those same documents merged into one blob.
const caseB = project({ snow: "28", windSpeed: "95", wind: "B", riskCategory: "II", structuralCalcText: B_CALC_SUMMARY, planSetExtractedText: `${B_PLAN}
${B_LETTER}` });
const B_DOCS: DesignTextSource[] = [{ label: "Plan set", text: B_PLAN }, { label: "Engineer's letter", text: B_LETTER }];

check("B: CONFLICT fires as a BLOCKER — plan 110/C/Pg 20 vs calculation 95/B/Pg 28, 'supersedes' does not clear it", () => {
  const f = get(run(caseB, ctxFor({}), B_DOCS), CONFLICT);
  assert.ok(f, "conflict must fire");
  assert.equal(f!.severity, "blocker", "two documents state different labelled values");
  assert.match(f!.message, /110 mph/);
  assert.match(f!.message, /95 mph/);
  assert.match(f!.message, /Wind exposure category: .*\bC\b.*\bB\b|Wind exposure category: .*\bB\b.*\bC\b/);
  assert.match(f!.message, /28 psf/);
  assert.match(f!.message, /20 psf/);
  assert.match(f!.message, /Engineer's letter/, "names the sources");
  assert.ok(f!.codeReferences.some((r) => /R106/.test(r.section)), "cites R106 (construction documents), as the AHJ did");
});

check("B: the conflict survives the full reviewer (dedupe) path", () => {
  const report = buildReviewerReport(caseB, { codeContext: ctxFor({}), documentTexts: B_DOCS });
  assert.equal(report.findings.find((f) => f.id === CONFLICT)?.severity, "blocker");
});

check("B: vs a profile requiring 120 mph / Exposure D -> below-ahj lists BOTH 110 and 95, BOTH C and B", () => {
  const f = get(run(caseB, ctxFor({ confidence: "verified", designCriteria: { windSpeedMph: 120, windExposure: "D", groundSnowLoadPsf: 28 } }), B_DOCS), BELOW);
  assert.ok(f, "below-ahj must fire");
  assert.equal(f!.severity, "blocker");
  assert.match(f!.message, /110 mph/);
  assert.match(f!.message, /95 mph/);
  assert.match(f!.message, /Wind exposure: stated .*\bC\b/);
  assert.match(f!.message, /Wind exposure: stated .*\bB\b/);
  assert.match(f!.message, /Ground snow load: stated 20 psf/, "Pg 20 < 28");
  const statedSnow = f!.message.match(/Ground snow load: stated ([^—]*)—/)?.[1] ?? "";
  assert.doesNotMatch(statedSnow, /28 psf/, "Pg 28 is not below 28");
});

check("B: the letter's speed is ultimate/unqualified, not nominal (the Vasd two numbers back does not relabel it)", () => {
  const s = extractStatedDesignCriteria(project({}), [{ label: "Engineer's letter", text: B_LETTER }]);
  const w = s.criteria.filter((c) => c.criterion === "windSpeedMph");
  assert.ok(w.length > 0 && w.every((c) => c.value === 95 && c.qualifier !== "nominal"), JSON.stringify(w));
});

check("B: a conflict inside ONE source only (no second document) is a WARNING, not a blocker", () => {
  const one = project({ structuralCalcText: B_CALC_SUMMARY });
  const f = get(run(one), CONFLICT);
  assert.equal(f?.severity, "warning");
});

check("C1: ONE document internally inconsistent + a parser narrative repeating one value -> WARNING, not a blocker", () => {
  // The narrative fields are the parser's summaries (llm.ts), a reading like the scalar fields.
  const p = project({ planSetExtractedText: "WIND SPEED = 110 MPH ... CALCULATION: Vult = 95 mph", projectDescriptionText: "Roof mount, wind 110 mph" });
  const f = get(run(p), CONFLICT);
  assert.equal(f?.severity, "warning", f?.message);
  assert.match(f!.message, /No two documents disagree/);
});

check("C1: the parser's structural summary describing the conflict does not make it a second document", () => {
  const p = project({ planSetExtractedText: B_PLAN, structuralCalcText: B_CALC_SUMMARY });
  assert.equal(get(run(p), CONFLICT)?.severity, "warning");
});

check("C3: identical text copied into two snapshot keys is ONE source -> WARNING", () => {
  const text = "WIND SPEED = 110 MPH GROUND SNOW LOAD = 20 PSF ... LETTER: V = 95 mph pg 28.00 psf";
  const p = project({ planSetExtractedText: text, splitPagesText: text });
  const f = get(run(p), CONFLICT);
  assert.equal(f?.severity, "warning", f?.message);
});

check("C3: the merged blob beside the documents it was merged from is not a third document", () => {
  // Plan set internally inconsistent; the merged snapshot text contains it (and a labels sheet).
  const plan = "WIND SPEED = 110 MPH ... Vult = 95 mph";
  const labels = "PV SYSTEM DISCONNECT LABEL";
  const p = project({ planSetExtractedText: `${plan}
${labels}` });
  const f = get(run(p, ctxFor({}), [{ label: "Plan set", text: plan }, { label: "Labels sheet", text: labels }]), CONFLICT);
  assert.equal(f?.severity, "warning", f?.message);
});

check("MUST-EXCLUDE: a sheet whose text is wholly inside another document is the same pages, not a second document", () => {
  const plan = "S-1 WIND SPEED = 110 MPH ... CALC PAGE Vult = 95 mph";
  const f = get(run(project({}), ctxFor({}), [{ label: "Plan set", text: plan }, { label: "Structural sheets", text: "S-1 WIND SPEED = 110 MPH" }]), CONFLICT);
  assert.equal(f?.severity, "warning", f?.message);
});

check("B: a conflict that needs the parser's reading to exist is a WARNING", () => {
  const p = project({ windSpeed: "95", planSetExtractedText: "WIND SPEED = 110 MPH" });
  const f = get(run(p), CONFLICT);
  assert.equal(f?.severity, "warning");
});

// ---------------------------------------------------------------------------------------
// Case C — plan-printed code basis.
// ---------------------------------------------------------------------------------------
const C_PLAN = "GOVERNING CODES: · 2023 OREGON RESIDENTIAL SPECIALTY CODE (ORSC) · 2023 OREGON ELECTRICAL SPECIALTY CODE (NEC 2020) · 2022 OREGON FIRE CODE "
  + "ASCE 7-10 WINDSPEEDS: (3 SEC GUST IN MPH) WIND SPEED AND EXPOSURE: 110 MPH, C ROOF SNOW LOAD: 36 PSF DEAD LOAD FOR ROOF-MOUNTED PANELS ATTACHMENTS: 2.44 PSF";
const caseC = project({ planSetExtractedText: C_PLAN });

check("C: code basis parsed into family + edition + base model code", () => {
  const b = extractStatedDesignCriteria(caseC).codeBasis;
  const oesc = b.find((e) => e.code === "OESC");
  assert.ok(oesc, JSON.stringify(b));
  assert.equal(oesc!.edition, "2023");
  assert.equal(oesc!.baseCode, "NEC");
  assert.equal(oesc!.baseEdition, "2020");
  assert.ok(b.some((e) => e.code === "ORSC" && e.edition === "2023"));
  assert.ok(b.some((e) => e.code === "OFC" && e.edition === "2022"));
});

check("C: site detail read — wind 110 / Exp C; ROOF SNOW 36 is roof snow, NOT ground snow; dead load is not snow", () => {
  const s = extractStatedDesignCriteria(caseC);
  assert.deepEqual([...new Set(s.criteria.filter((c) => c.criterion === "windSpeedMph").map((c) => c.value))], [110]);
  assert.deepEqual([...new Set(s.criteria.filter((c) => c.criterion === "windExposure").map((c) => c.value))], ["C"]);
  assert.deepEqual(s.criteria.filter((c) => c.criterion === "roofSnowPsf").map((c) => c.value), [36]);
  assert.equal(s.criteria.filter((c) => c.criterion === "groundSnowPsf").length, 0);
});

check("C: basis-mismatch fires vs a profile adopting NEC 2023 — a WARNING even when the profile is verified", () => {
  const f = get(run(caseC, ctxFor({ confidence: "verified" })), BASIS);
  assert.ok(f, "mismatch must fire");
  assert.equal(f!.severity, "warning");
  assert.match(f!.message, /NEC 2020/);
  assert.match(f!.message, /NEC 2023/);
});

check("C MUST-EXCLUDE: plan basis matching the profile -> no mismatch", () => {
  const fs = run(caseC, ctxFor({ adoptedCodes: [{ code: "ORSC", edition: "2023" }, { code: "OESC", edition: "2023" }, { code: "NEC", edition: "2020" }] }));
  assert.ok(!get(fs, BASIS));
});

check("C MUST-EXCLUDE: no adopted-code record (defaults) -> no mismatch against placeholders", () => {
  assert.ok(!get(run(caseC, buildCodeContext("OR", "City of Nowhere", null)), BASIS));
});

check("C: a list printed BEFORE its heading (PDF text order) is still read", () => {
  const b = extractStatedDesignCriteria(project({ planSetExtractedText: "2023 OREGON RESIDENTIAL SPECIALTY CODE 2021 OREGON ELECTRICAL SPECIALTY CODE (NEC 2020) GOVERNING CODES: SYSTEM SIZE: 10 kW DC" })).codeBasis;
  assert.ok(b.some((e) => e.code === "OESC" && e.edition === "2021" && e.baseEdition === "2020"), JSON.stringify(b));
});

check("C: an engineer's 'References and Codes' list is read (IBC/IRC), NDS/ASCE are not codes", () => {
  const b = extractStatedDesignCriteria(project({}), [{ label: "Letter", text: "References and Codes: 1) ASCE 7-22 Minimum Design Loads for Buildings and Other Structures 2) 2021 IBC 3) 2018 IRC 4) American Wood Council, NDS 2018,Table 12.2A" }]).codeBasis;
  assert.deepEqual(b.map((e) => `${e.code} ${e.edition}`).sort(), ["IBC 2021", "IRC 2018"]);
});

check("C MUST-EXCLUDE: the labels sheet's placard citations are not a code basis", () => {
  const b = extractStatedDesignCriteria(project({ labelsText: "LABEL LOCATION: JUNCTION BOX NEC: 2020, PER CODE: NEC 690.31(D)(2) LABEL LOCATION: AC DISCONNECT NEC: 2020 (PER CODE: NEC 690.54) PER CODE(S): NEC 2020: ARTICLE 690.56(C) NEC 2020 PER CODE 690.13(B)" })).codeBasis;
  assert.deepEqual(b, []);
});

// ---------------------------------------------------------------------------------------
// MUST-EXCLUDE — conflict
// ---------------------------------------------------------------------------------------
check("MUST-EXCLUDE: Vult vs Vasd of one design is not a conflict", () => {
  const p = project({ planSetExtractedText: "ULTIMATE WIND SPEED Vult = 120 MPH" });
  const fs = run(p, ctxFor({}), [{ label: "Letter", text: "Vasd = 93 mph" }]);
  assert.ok(!get(fs, CONFLICT));
  const s = extractStatedDesignCriteria(p, [{ label: "Letter", text: "Vasd = 93 mph" }]);
  assert.equal(s.criteria.find((c) => c.value === 93)?.qualifier, "nominal");
  assert.equal(s.criteria.find((c) => c.value === 120)?.qualifier, "ultimate");
});

check("MUST-EXCLUDE: a nominal (ASD) speed is never compared against the AHJ's ultimate speed", () => {
  const p = project({ planSetExtractedText: "Vasd = 93 mph" });
  assert.ok(!get(run(p, ctxFor({ designCriteria: { windSpeedMph: 120, groundSnowLoadPsf: 10 } })), BELOW));
});

check("MUST-EXCLUDE: ground snow vs roof snow is not a conflict", () => {
  const fs = run(project({ planSetExtractedText: "GROUND SNOW LOAD = 25 PSF" }), ctxFor({}), [{ label: "Letter", text: "ROOF SNOW LOAD: 20 PSF" }]);
  assert.ok(!get(fs, CONFLICT));
});

check("MUST-EXCLUDE: Pg vs Pg(asd) is not a conflict", () => {
  const p = project({ planSetExtractedText: "GROUND SNOW LOAD = 28 PSF" });
  const docs = [{ label: "Letter", text: "Ground snow load, Pg : 28 psf; Pg(asd): 20 psf Minimum roof snow load" }];
  assert.ok(!get(run(p, ctxFor({}), docs), CONFLICT));
  const s = extractStatedDesignCriteria(p, docs);
  assert.equal(s.criteria.find((c) => c.value === 20 && c.criterion === "groundSnowPsf")?.qualifier, "ground_asd");
});

check("MUST-EXCLUDE: a value repeated identically across sources is not a conflict", () => {
  const p = project({ snow: "28", windSpeed: "110", wind: "C", planSetExtractedText: "GROUND SNOW LOAD = 28 PSF WIND SPEED = 110 MPH EXPOSURE CATEGORY = C", structuralCalcText: "ground snow 28 psf, 110 mph wind Exposure C" });
  assert.ok(!get(run(p, ctxFor({}), [{ label: "Letter", text: "pg 28.00 psf Wind Loading: v 110 mph Exposure C" }]), CONFLICT));
});

check("MUST-EXCLUDE: flat-roof Pf printed before the minimum governs (17.64 then 20) is not a conflict", () => {
  assert.ok(!get(run(project({}), ctxFor({}), [{ label: "Letter", text: "p f = 17.64 psf p m = 20 psf p f = 20.00 psf" }, { label: "Plan", text: "flat roof snow load 20 psf" }]), CONFLICT));
});

check("MUST-EXCLUDE: roof live, PV dead load, 'under array' and page refs are not snow", () => {
  const s = extractStatedDesignCriteria(project({ planSetExtractedText: "ROOF LIVE LOAD = 20 PSF TYPICAL, 0 PSF UNDER NEW PV SYSTEM. PV adds 2.37 psf. DEAD LOAD 2.44 PSF. 20 psf roof live. see pg 5 of the manual" }));
  assert.deepEqual(s.criteria.filter((c) => c.criterion === "groundSnowPsf" || c.criterion === "roofSnowPsf"), []);
});

check("MUST-EXCLUDE: exposure words that are not a wind exposure category", () => {
  const s = extractStatedDesignCriteria(project({ planSetExtractedText: "WIRING MATERIALS SHALL BE SUITABLE FOR THE SUN EXPOSURE AND WET LOCATIONS. Exposure Factor, Ce (ASCE 7-22 Table 7.3-1) Exposure Category (ASCE 7-22 Table 26.7.3, Page 274) Fully Exposed Exposure category Ce = 0.9 SUN EXPOSURE DURING INSTALL" }));
  assert.deepEqual(s.criteria.filter((c) => c.criterion === "windExposure"), []);
});

check("MUST-EXCLUDE: a rating or a limit is not the design wind speed", () => {
  const s = extractStatedDesignCriteria(project({ planSetExtractedText: "RACKING TESTED TO 160 MPH WIND. MODULE RATED FOR WIND SPEEDS UP TO 150 MPH. PRESCRIPTIVE PATH: WIND SPEED ≤ 110 MPH" }));
  assert.deepEqual(s.criteria.filter((c) => c.criterion === "windSpeedMph"), []);
});

// ---------------------------------------------------------------------------------------
// EXPOSURE only from a design-criteria label — never a limit, a rating, a list or a table.
// ---------------------------------------------------------------------------------------
const exposures = (text: string): string[] =>
  extractStatedDesignCriteria(project({ planSetExtractedText: text })).criteria.filter((c) => c.criterion === "windExposure").map((c) => String(c.value));
const speeds = (text: string): number[] =>
  extractStatedDesignCriteria(project({ planSetExtractedText: text })).criteria.filter((c) => c.criterion === "windSpeedMph").map((c) => Number(c.value));

// A public prescriptive-checklist wording (the kind stored on a real project as an "other"
// document), verbatim in shape: it LIMITS the path to B or C; it states no site category.
const OR_CHECKLIST = "• Wind exposure for structure is limited to Exposure Category B or C: • Structure is of conventional light-frame construction "
  + "• Ultimate design wind speed a. Less than or equal to 120 mph in Exposure Category B; or b. Less than or equal to 110 mph in Exposure Category C.";

check("MUST-PASS: exposure stated with a design-criteria label, or beside a wind speed", () => {
  assert.deepEqual(exposures("Wind exposure category: C"), ["C"]);
  assert.deepEqual(exposures("5. EXPOSURE CATEGORY = D 6. RISK CATEGORY = II"), ["D"]);
  assert.deepEqual(exposures("Exp. Cat. C"), ["C"]);
  assert.deepEqual(exposures("A sealed analysis: Exposure B, 95 mph"), ["B"]);
  assert.deepEqual(exposures("Wind Loading: v 110 mph Exposure C"), ["C"]);
});

check("MUST-EXCLUDE: a rating, a bare roof word, a span-table head row and a list are not the site's exposure", () => {
  assert.deepEqual(exposures("MODULES SHALL HAVE EXPOSURE B RATING"), [], "rating");
  assert.deepEqual(exposures("WIND: RACKING LISTED FOR EXPOSURE CATEGORY D RATED LOADS"), [], "a labelled category followed by a rating");
  assert.deepEqual(exposures("roof exposure c. site is open to the south"), [], "no wind label");
  assert.deepEqual(exposures("RAIL SPAN TABLE WIND SPEED (MPH) EXPOSURE B EXPOSURE C EXPOSURE D 110 72 IN 64 IN 58 IN"), [], "table heads");
  assert.deepEqual(exposures("Exposure category B or C permitted"), [], "a list is not a category");
  assert.deepEqual(exposures("EXPOSURE CATEGORY C/D"), [], "a range is not a category");
});

check("MUST-EXCLUDE: the prescriptive checklist states no exposure and no design wind speed", () => {
  assert.deepEqual(exposures(OR_CHECKLIST), []);
  assert.deepEqual(speeds(OR_CHECKLIST), []);
});

check("MUST-EXCLUDE: a plan correctly stating Exposure C beside the checklist -> no false conflict, no false below-ahj", () => {
  const p = project({ planSetExtractedText: `WIND SPEED = 120 MPH EXPOSURE CATEGORY = C\n${OR_CHECKLIST}` });
  const docs = [{ label: "Plan set", text: "WIND SPEED = 120 MPH EXPOSURE CATEGORY = C" }, { label: "Prescriptive checklist", text: OR_CHECKLIST }];
  const fs = run(p, ctxFor({ confidence: "verified", verifiedBy: "operator", designCriteria: { windSpeedMph: 120, windExposure: "C", groundSnowLoadPsf: 10 } }), docs);
  assert.ok(!get(fs, CONFLICT), get(fs, CONFLICT)?.message);
  assert.ok(!get(fs, BELOW), get(fs, BELOW)?.message);
});

check("MUST-EXCLUDE / MUST-PASS: 'designed for' right before a speed is a rating; a 'DESIGNED FOR:' header with a label is not", () => {
  assert.deepEqual(speeds("RAIL SYSTEM DESIGNED FOR 160 MPH WIND"), []);
  assert.deepEqual(speeds("SYSTEM DESIGNED FOR: WIND SPEED = 110 MPH"), [110]);
});

// ---------------------------------------------------------------------------------------
// Parentheticals between label and value (caveat a).
// ---------------------------------------------------------------------------------------
check("MUST-PASS: a parenthetical between the wind label and the speed does not hide it", () => {
  assert.deepEqual(speeds("BASIC WIND SPEED (3-SECOND GUST) = 115 MPH"), [115]);
  assert.deepEqual(speeds("WIND SPEED (ASCE 7-16): 110 MPH"), [110]);
  const s = extractStatedDesignCriteria(project({ planSetExtractedText: "Vult (3-sec gust): 120 mph" })).criteria.filter((c) => c.criterion === "windSpeedMph");
  assert.deepEqual(s.map((c) => [c.value, c.qualifier]), [[120, "ultimate"]]);
});

const grounds = (text: string): Array<[unknown, string]> =>
  extractStatedDesignCriteria(project({ planSetExtractedText: text })).criteria.filter((c) => c.criterion === "groundSnowPsf").map((c) => [c.value, c.qualifier]);

check("MUST-PASS: ground snow with a parenthetical, prose, or the qualifier after the label", () => {
  assert.deepEqual(grounds("GROUND SNOW LOAD (Pg) = 25 PSF"), [[25, "ground"]]);
  assert.deepEqual(grounds("GROUND SNOW LOAD (ASCE 7-16 FIG 7.2-1) = 30 PSF"), [[30, "ground"]]);
  assert.deepEqual(grounds("the site has a ground snow load of 36 psf"), [[36, "ground"]]);
  assert.deepEqual(grounds("SNOW LOAD (GROUND): 25 PSF"), [[25, "ground"]]);
});

check("MUST-EXCLUDE: Pg(asd) stays ASD; roof snow in parentheses is not ground; prose with no value reads nothing", () => {
  assert.deepEqual(grounds("Ground snow load Pg(asd) = 20 psf"), [[20, "ground_asd"]]);
  assert.deepEqual(grounds("SNOW LOAD (ROOF): 25 PSF"), []);
  assert.deepEqual(grounds("GROUND SNOW LOAD (SEE NOTE 3) VARIES BY ELEVATION"), []);
  assert.deepEqual(grounds("3. GROUND SNOW LOAD (Pg) 4. WIND SPEED = 110 MPH"), [], "an item number is never a load");
});

// ---------------------------------------------------------------------------------------
// The unknown callout's THREE answers (caveat a): stated / not stated / could not be read.
// ---------------------------------------------------------------------------------------
check("UNKNOWN: 'stated in the package' / 'not stated in the package text we read' / 'could not be read' — never 'not stated' with no text", () => {
  const stated = get(run(project({ planSetExtractedText: "GROUND SNOW LOAD = 25 PSF WIND SPEED = 110 MPH" })), UNKNOWN)!;
  assert.match(stated.message, /ground snow — stated in the package: 25 psf/);
  const silent = get(run(project({ planSetExtractedText: "ROOF MOUNT PV ARRAY, 12 MODULES" })), UNKNOWN)!;
  assert.match(silent.message, /ground snow — not stated in the package text we read/);
  const unread = get(run(project({})), UNKNOWN)!;
  assert.match(unread.message, /ground snow — could not be read from the package/);
  assert.doesNotMatch(unread.message, /not stated/);
  // The parser's own summary is a reading, not the package text: still "could not be read".
  const onlyNarrative = get(run(project({ structuralCalcText: "Roof framing 2x6 @ 24 in." })), UNKNOWN)!;
  assert.match(onlyNarrative.message, /could not be read from the package/);
  // A stored document with no text layer is unreadable, not silent.
  const scanned = get(run(project({}), ctxFor({}), [{ label: "Plan set", text: "[no text layer]" }]), UNKNOWN)!;
  assert.match(scanned.message, /could not be read from the package/);
});

// ---------------------------------------------------------------------------------------
// Excerpts stop at the value's own field (caveat e) — title-block names never ride along.
// ---------------------------------------------------------------------------------------
check("MUST-EXCLUDE: an excerpt runs label..value, never into the title block beside it", () => {
  const text = "5. EXPOSURE CATEGORY = C 6. RISK CATEGORY = II DECK Rev JANE ROE 1 MAPLE ST OWNER JANE ROE WIND SPEED = 120 MPH MAPLE ST GROUND SNOW LOAD = 25 PSF JANE ROE";
  const s = extractStatedDesignCriteria(project({ planSetExtractedText: text }));
  const excerpts = s.criteria.filter((c) => !c.derived).map((c) => c.excerpt);
  assert.ok(excerpts.length >= 4, JSON.stringify(excerpts));
  for (const e of excerpts) assert.doesNotMatch(e, /ROE|MAPLE|DECK|OWNER/, e);
  assert.ok(excerpts.includes("RISK CATEGORY = II"), JSON.stringify(excerpts));
  assert.ok(excerpts.includes("WIND SPEED = 120 MPH"), JSON.stringify(excerpts));
});

if (failures) {
  console.error(`\n${failures} design-criteria check(s) FAILED`);
  process.exit(1);
}
console.log("\nall design-criteria checks passed");
