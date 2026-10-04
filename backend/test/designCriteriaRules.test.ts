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
import { visionMayRelax } from "../src/reviewerVision";

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

check("C: basis-mismatch fires vs a SEEDED profile adopting NEC 2023 — a WARNING (a seeded row never blocks)", () => {
  const f = get(run(caseC, ctxFor({})), BASIS);
  assert.ok(f, "mismatch must fire");
  assert.equal(f!.severity, "warning");
  assert.match(f!.message, /NEC 2020/);
  assert.match(f!.message, /NEC 2023/);
});

check("C #108: basis-mismatch vs a human-VERIFIED profile adopting NEC 2023 is a BLOCKER", () => {
  const f = get(run(caseC, ctxFor({ confidence: "verified" })), BASIS);
  assert.ok(f, "mismatch must fire");
  assert.equal(f!.severity, "blocker");
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

// ── #108: every plan set that prints a code basis gets an answer ─────────────────────────
const BASIS_UNVERIFIED = "city.code.basis-unverified";
const UT_PLAN = "GOVERNING CODES: 2021 IRC, 2021 IBC, 2020 NEC, 2021 IFC. SYSTEM SIZE: 8 kW DC";
const utah = project({ planSetExtractedText: UT_PLAN }, { state: "UT", ahj: "City of Testvale" } as Partial<ProjectRecord>);
const utProfile = (over: Partial<JurisdictionCodeProfile>): JurisdictionCodeProfile => profile({
  key: "ut|city of testvale|unknown", state: "UT", ahj: "City of Testvale",
  adoptedCodes: [{ code: "IRC", edition: "2021" }, { code: "IBC", edition: "2021" }, { code: "NEC", edition: "2023" }, { code: "IFC", edition: "2021" }],
  ...over,
});
const utCtx = (over: Partial<JurisdictionCodeProfile>) => buildCodeContext("UT", "City of Testvale", utProfile(over));
const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

check("#108 MUST-PASS: defaults (no profile) -> a basis-unverified CALLOUT quoting the plan, and nothing that warns or blocks", () => {
  const fs = run(utah, buildCodeContext("UT", "City of Testvale", null));
  const f = get(fs, BASIS_UNVERIFIED);
  assert.ok(f, "a plan that prints a code basis must get an answer on defaults");
  assert.equal(f!.severity, "callout");
  assert.equal(f!.installerCallout, false);
  assert.match(f!.message, /2020 NEC/);
  assert.match(f!.message, /2021 IRC/);
  assert.match(f!.message, /not on file/);
  assert.match(f!.message, /lookup not landed/);
  assert.ok(!get(fs, BASIS), "no mismatch against placeholders");
});

check("#108 MUST-PASS: a SEEDED profile with no editions on file -> callout naming the seeded lookup, never a blocker", () => {
  const fs = run(utah, utCtx({ adoptedCodes: [] }));
  const f = get(fs, BASIS_UNVERIFIED);
  assert.ok(f);
  assert.equal(f!.severity, "callout");
  assert.match(f!.message, /seeded 2026-09-01/);
  assert.ok(!fs.some((x) => x.id.startsWith("city.code.basis") && x.severity === "blocker"));
});

check("#108 MUST-PASS: verified profile, plan on NEC 2020 vs adopted NEC 2023 -> basis-mismatch BLOCKER", () => {
  const fs = run(utah, utCtx({ confidence: "verified", verifiedBy: "operator" }));
  const f = get(fs, BASIS);
  assert.ok(f);
  assert.equal(f!.severity, "blocker");
  assert.match(f!.message, /NEC 2020/);
  assert.ok(!get(fs, BASIS_UNVERIFIED), "editions on file: no unverified callout");
});

check("#108 MUST-PASS: the same mismatch on a SEEDED profile stays a warning (rule 3)", () => {
  const f = get(run(utah, utCtx({})), BASIS);
  assert.ok(f);
  assert.equal(f!.severity, "warning");
});

check("#108 MUST-EXCLUDE: verified profile and a matching plan -> no basis finding at all", () => {
  const fs = run(utah, utCtx({ confidence: "verified", adoptedCodes: [{ code: "IRC", edition: "2021" }, { code: "IBC", edition: "2021" }, { code: "NEC", edition: "2020" }, { code: "IFC", edition: "2021" }] }));
  assert.ok(!fs.some((f) => f.id.startsWith("city.code.basis")), JSON.stringify(fs.filter((f) => f.id.startsWith("city.code.basis")).map((f) => f.id)));
});

check("#108 MUST-EXCLUDE: a verified state code naming its model base still matches (base-edition equivalence)", () => {
  const fs = run(caseC, ctxFor({ confidence: "verified", adoptedCodes: [{ code: "ORSC", edition: "2023" }, { code: "OESC", edition: "2023" }, { code: "NEC", edition: "2020" }] }));
  assert.ok(!get(fs, BASIS));
});

const NEXT_PLAN = "GOVERNING CODES: 2021 IRC, 2026 NEC. SYSTEM SIZE: 8 kW DC";
const nextCycle = project({ planSetExtractedText: NEXT_PLAN }, { state: "UT", ahj: "City of Testvale" } as Partial<ProjectRecord>);
const withUpcoming = (date: string) => utCtx({ confidence: "verified", upcoming: [{ family: "electrical", code: "NEC", edition: "2026", anticipatedDate: date, status: "adopted" }] });

check("#108 MUST-PASS: verified, plan prints the UPCOMING edition due within 90 days -> a warning naming the date", () => {
  const date = inDays(30);
  const f = get(run(nextCycle, withUpcoming(date)), BASIS);
  assert.ok(f);
  assert.equal(f!.severity, "warning");
  assert.ok(f!.message.includes(date), f!.message);
  assert.match(f!.message, /upcoming NEC 2026/);
});

check("#108 MUST-PASS: the upcoming edition due beyond 90 days does not soften -> blocker", () => {
  const f = get(run(nextCycle, withUpcoming(inDays(200))), BASIS);
  assert.ok(f);
  assert.equal(f!.severity, "blocker");
});

check("#108 MUST-PASS: vision may never relax either code-basis finding", () => {
  assert.equal(visionMayRelax({ id: BASIS } as ReviewerFinding), false);
  assert.equal(visionMayRelax({ id: BASIS_UNVERIFIED } as ReviewerFinding), false);
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
  // A limit word earlier in the line does not swallow an ASSIGNED category.
  assert.deepEqual(exposures("PER ASCE 7-16 MINIMUM DESIGN LOADS AND ASSOCIATED CRITERIA EXPOSURE CATEGORY = C"), ["C"]);
  assert.deepEqual(exposures("MINIMUM ROOF LIVE LOAD 20 PSF EXPOSURE CATEGORY = C"), ["C"]);
  assert.deepEqual(exposures("MAX ATTACHMENT SPAN 48 IN WIND EXPOSURE CATEGORY: D"), ["D"]);
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

// ---------------------------------------------------------------------------------------
// CODE BASIS — one year per code; state codes compared state-to-state; bases only when both
// sides state one.
// ---------------------------------------------------------------------------------------
const basisOf = (text: string): string[] =>
  extractStatedDesignCriteria(project({ planSetExtractedText: text })).codeBasis
    .map((e) => `${e.code} ${e.edition}${e.baseCode ? ` (${e.baseCode} ${e.baseEdition})` : ""}`);
const basisFinding = (text: string, adoptedCodes: JurisdictionCodeProfile["adoptedCodes"]) =>
  get(run(project({ planSetExtractedText: text }), ctxFor({ adoptedCodes })), BASIS);

// The shipped Oregon state row after 2e79795 (operator-verified), in shape.
const OR_PROFILE: JurisdictionCodeProfile["adoptedCodes"] = [
  { code: "OESC", edition: "2023" }, { code: "NEC", edition: "2023" },
  { code: "ORSC", edition: "2023", title: "Oregon Residential Specialty Code (2023 edition, based on the 2021 IRC)" },
  { code: "IRC", edition: "2021" }, { code: "IFC", edition: "2021" },
];

check("MUST-PASS: a comma-less CODE-YEAR list pairs each code with ITS year — never the previous code's", () => {
  assert.deepEqual(basisOf("GOVERNING CODES: IRC 2021 NEC 2023 IFC 2021"), ["IRC 2021", "NEC 2023", "IFC 2021"]);
  assert.ok(!basisFinding("GOVERNING CODES: IRC 2021 NEC 2023 IFC 2021", [{ code: "IRC", edition: "2021" }, { code: "NEC", edition: "2023" }, { code: "IFC", edition: "2021" }]), "a correct plan raises nothing");
});

check("MUST-PASS: 'ORSC 2023 OESC 2023 NEC 2023' keeps ORSC, and each code keeps its own year", () => {
  assert.deepEqual(basisOf("CODES USED: ORSC 2023 OESC 2023 NEC 2023"), ["ORSC 2023", "OESC 2023", "NEC 2023"]);
  assert.deepEqual(basisOf("APPLICABLE CODES: ORSC 2023 OESC 2021 NEC 2020"), ["ORSC 2023", "OESC 2021", "NEC 2020"]);
});

check("MUST-EXCLUDE: a permit-number shape is not a code and lends no year", () => {
  assert.deepEqual(basisOf("APPLICABLE CODES: PERMIT NO 2024 BLDC 2024-00012 2021 IRC"), ["IRC 2021"]);
  assert.deepEqual(basisOf("GOVERNING CODES: BLDC 2024-00012"), []);
});

check("MUST-EXCLUDE: a correct Oregon plan (2023 ORSC / 2023 OESC (NEC 2023) / 2022 OFC) raises no basis-mismatch", () => {
  for (const text of [
    "GOVERNING CODES: · 2023 OREGON RESIDENTIAL SPECIALTY CODE (ORSC) · 2023 OREGON ELECTRICAL SPECIALTY CODE (NEC 2023) · 2022 OREGON FIRE CODE",
    "GOVERNING CODES: · 2023 OREGON RESIDENTIAL SPECIALTY CODE · 2023 OREGON ELECTRICAL SPECIALTY CODE (2023 NEC) · 2022 OREGON FIRE CODE",
    "GOVERNING CODES: 2023 ORSC 2023 OESC (NEC 2023) 2022 OFC",
  ]) {
    const f = basisFinding(text, OR_PROFILE);
    assert.ok(!f, `${text} -> ${f?.message}`);
  }
});

check("MUST-PASS: the same Oregon plan printing (NEC 2020) beside the 2023 OESC still warns, naming the base", () => {
  const f = basisFinding("GOVERNING CODES: · 2023 OREGON RESIDENTIAL SPECIALTY CODE (ORSC) · 2023 OREGON ELECTRICAL SPECIALTY CODE (NEC 2020) · 2022 OREGON FIRE CODE", OR_PROFILE);
  assert.ok(f, "must warn");
  assert.match(f!.message, /OESC 2023 based on NEC 2020/);
  assert.match(f!.message, /NEC 2023/);
  assert.doesNotMatch(f!.message, /OFC|IFC/, "the 2022 OFC is never compared with the 2021 IFC by year");
});

check("STATE CODES MAP TO THEIR BASE: a base parenthetical is compared only with that model code's record", () => {
  const ca = [{ code: "CRC", edition: "2022" }, { code: "IRC", edition: "2021" }, { code: "CEC", edition: "2022" }, { code: "NEC", edition: "2020" }];
  assert.ok(!basisFinding("GOVERNING CODES: 2022 CALIFORNIA RESIDENTIAL CODE (2021 IRC) 2022 CALIFORNIA ELECTRICAL CODE (NEC 2020)", ca));
  const f = basisFinding("GOVERNING CODES: 2022 CALIFORNIA RESIDENTIAL CODE (2018 IRC)", ca);
  assert.match(f?.message ?? "", /CRC 2022 based on IRC 2018/);
  // State name to state name.
  assert.match(basisFinding("GOVERNING CODES: 2019 CALIFORNIA RESIDENTIAL CODE", ca)?.message ?? "", /plan states CRC 2019/);
  // A state-amended model code is that model code.
  assert.deepEqual(basisOf("GOVERNING CODES: 2021 WASHINGTON STATE AMENDED INTERNATIONAL RESIDENTIAL CODE"), ["IRC 2021"]);
  // Florida's residential volume is FBC-R (-> IRC), however the profile spells it.
  assert.deepEqual(basisOf("GOVERNING CODES: 2023 FLORIDA BUILDING CODE, RESIDENTIAL"), ["FBC-R 2023"]);
  assert.ok(!basisFinding("GOVERNING CODES: 2023 FLORIDA BUILDING CODE, RESIDENTIAL", [{ code: "FBC Residential", edition: "2023" }]));
  assert.match(basisFinding("GOVERNING CODES: 2020 FLORIDA BUILDING CODE, RESIDENTIAL", [{ code: "FBC Residential", edition: "2023" }])?.message ?? "", /FBC-R 2020 .*FBC Residential 2023/, "the profile's spelling is the same code");
  // A parenthetical that is not this state code's model base is not compared as its base.
  assert.ok(!basisFinding("GOVERNING CODES: 2023 OREGON ELECTRICAL SPECIALTY CODE (IRC 2018)", OR_PROFILE));
  // The California ENERGY Code is not the (NEC-based) California Electrical Code.
  assert.ok(!basisOf("GOVERNING CODES: 2022 CALIFORNIA ENERGY CODE").some((e) => e.startsWith("CEC ")));
});

check("A model code on the plan vs a profile naming only the state code: compared only through the base the profile states", () => {
  const orscOnly = [{ code: "ORSC", edition: "2023", title: "Oregon Residential Specialty Code (2023 edition, based on the 2021 IRC)" }];
  assert.ok(!basisFinding("GOVERNING CODES: 2021 IRC", orscOnly));
  assert.match(basisFinding("GOVERNING CODES: 2018 IRC", orscOnly)?.message ?? "", /IRC 2018.*based on IRC 2021/);
  // No base stated on the profile side -> not compared at all.
  assert.ok(!basisFinding("GOVERNING CODES: 2018 IRC", [{ code: "ORSC", edition: "2023" }]));
});

check("A name-first edition is read: 'Oregon Structural Specialty Code, 2025 Edition (2024 IBC)'", () => {
  const b = extractStatedDesignCriteria(project({}), [{ label: "Structural letter", text: "Building Code: Oregon Structural Specialty Code, 2025 Edition (2024 IBC) Risk Category: II" }]).codeBasis;
  assert.deepEqual(b.map((e) => `${e.code} ${e.edition} ${e.baseCode} ${e.baseEdition}`), ["OSSC 2025 IBC 2024"]);
});

// ---------------------------------------------------------------------------------------
// OTHER STATES — the same engine read against the shapes other states' plans and profiles use
// (profile tokens as the live research rows spell them: "CEC-CA", "FBC-R", "FBC-B").
// ---------------------------------------------------------------------------------------
check("CA: a profile's state-suffixed 'CEC-CA' is the California Electrical Code a plan calls CEC", () => {
  const ca = [{ code: "CRC", edition: "2025" }, { code: "CEC-CA", edition: "2025" }, { code: "T24-P6", edition: "2025" }];
  assert.ok(!basisFinding("APPLICABLE CODES: 2025 CRC 2025 CEC 2025 CFC", ca), "a current CA plan raises nothing");
  const f = basisFinding("GOVERNING CODES: 2025 CALIFORNIA RESIDENTIAL CODE (CRC) 2022 CALIFORNIA ELECTRICAL CODE (CEC)", ca);
  assert.match(f?.message ?? "", /plan states CEC 2022 .*CEC-CA 2025/);
  assert.doesNotMatch(f?.message ?? "", /CRC 2025 \(/, "the matching CRC is not reported");
});

check("FL: an ordinal edition '8TH EDITION (2023)' and the BUILDING volume are read as FBC-R / FBC-B", () => {
  assert.deepEqual(basisOf("APPLICABLE CODES: FLORIDA BUILDING CODE, RESIDENTIAL 8TH EDITION (2023) 2020 NATIONAL ELECTRICAL CODE").sort(), ["FBC-R 2023", "NEC 2020"]);
  assert.deepEqual(basisOf("GOVERNING CODES: 2023 FLORIDA BUILDING CODE, BUILDING").sort(), ["FBC-B 2023"]);
  const fl = [{ code: "FBC-R", edition: "2023" }, { code: "FBC-B", edition: "2023" }, { code: "NEC", edition: "2020" }];
  assert.ok(!basisFinding("GOVERNING CODES: 2023 FLORIDA BUILDING CODE, RESIDENTIAL 2023 FLORIDA BUILDING CODE, BUILDING NEC 2020", fl));
  assert.match(basisFinding("GOVERNING CODES: FLORIDA BUILDING CODE, RESIDENTIAL 7TH EDITION (2020)", fl)?.message ?? "", /FBC-R 2020/);
});

check("WA: a bare 'CODES:' heading is a code-basis block; a state-amendment tail does not change the code", () => {
  assert.deepEqual(basisOf("CODES: 2021 IRC WITH WASHINGTON STATE AMENDMENTS 2023 NEC").sort(), ["IRC 2021", "NEC 2023"]);
  // MUST-EXCLUDE: the singular "PER CODE:" of a placard is still not a heading.
  assert.deepEqual(basisOf("LABEL LOCATION: AC DISCONNECT PER CODE: NEC 2020 690.54"), []);
});

// ---------------------------------------------------------------------------------------
// #68 — an ASSIGNED product RANGE is not a stated value. A ballasted-racking design report
// states the site's loads once ("WIND SPEED 105.00 mph GROUND SNOW LOAD 5.00 psf") and then, in a
// boilerplate "Design Parameters" block, the PRODUCT's applicability ranges ("Basic Wind Speed:
// 110.00 mph - 150.00 mph", "Ground Snow Load: 0 - 100.00 psf"). Read as values they raised a
// false conflict warning and — in a verified AHJ above 110 mph — a false below-AHJ blocker.
// ---------------------------------------------------------------------------------------
const statedOf = (text: string, crit: string): unknown[] => {
  const s = extractStatedDesignCriteria(project({}), [{ label: "Structural letter", text }]);
  return [...new Set(s.criteria.filter((c) => c.criterion === crit && c.source === "Structural letter").map((c) => c.value))];
};
const RANGE_BLOCK = "Design Parameters 1. Risk Category I to IV 2. Wind Design a. Basic Wind Speed:110.00 mph - 150.00 mph (ASCE 7-10)/90.00 mph - 180.00 mph (ASCE 7-16) "
  + "b. Exposure: B, C or D (ASCE 7-10/ASCE 7-16) 3. Snow Design a. Ground Snow Load: 0 - 100.00 psf (ASCE 7-10/ASCE 7-16)";

check("#68 MUST-EXCLUDE: an assigned wind-speed range is refused, with or without the unit repeated, dash or 'to'", () => {
  for (const t of ["Basic Wind Speed:110.00 mph - 150.00 mph (ASCE 7-10)", "Basic Wind Speed: 110 mph - 150 mph", "Basic Wind Speed: 110 to 150 mph",
    "Basic Wind Speed: 110 - 150 mph", "wind speed 110 to 150 mph"]) {
    assert.deepEqual(statedOf(t, "windSpeedMph"), [], t);
  }
});

check("#68 MUST-EXCLUDE: an assigned ground-snow range is refused — the range, not the zero", () => {
  for (const t of ["Ground Snow Load: 0 - 100.00 psf (ASCE 7-10/ASCE 7-16)", "Ground Snow Load: 20 - 30 psf", "Ground Snow Load: 20 psf - 30 psf", "Ground snow load 20-30 psf"]) {
    assert.deepEqual(statedOf(t, "groundSnowPsf"), [], t);
  }
});

check("#68 MUST-PASS: a lone 0 psf, a dash label, and a dash followed by a WORD are still values", () => {
  assert.deepEqual(statedOf("GROUND SNOW LOAD: 0 PSF", "groundSnowPsf"), [0]);
  assert.deepEqual(statedOf("GROUND SNOW LOAD - 36 PSF", "groundSnowPsf"), [36]);
  assert.deepEqual(statedOf("36 PSF – GROUND SNOW LOAD", "groundSnowPsf"), [36]);
  assert.deepEqual(statedOf("ROOF DEAD LOAD - 3 PSF GROUND SNOW LOAD - 36 PSF", "groundSnowPsf"), [36]);
  assert.deepEqual(statedOf("WIND SPEED: 110 MPH - EXPOSURE C", "windSpeedMph"), [110]);
  assert.deepEqual(statedOf("WIND SPEED: 110 MPH - EXPOSURE C", "windExposure"), ["C"]);
  const ult = extractStatedDesignCriteria(project({}), [{ label: "Structural letter", text: "Ult Wind Speed: 120 mph - Risk Category II" }]).criteria
    .filter((c) => c.criterion === "windSpeedMph" && c.source === "Structural letter");
  assert.deepEqual(ult.map((c) => [c.value, c.qualifier]), [[120, "ultimate"]]);
});

check("#68 MUST-PASS: the report's site loads are read; its Design Parameters ranges are not", () => {
  const text = `Loads Used for Design BUILDING CODE ASCE 7-16 WIND SPEED 105.00 mph GROUND SNOW LOAD 5.00 psf WIND EXPOSURE B RISK CATEGORY II ${RANGE_BLOCK}`;
  assert.deepEqual(statedOf(text, "windSpeedMph"), [105]);
  assert.deepEqual(statedOf(text, "groundSnowPsf"), [5]);
});

check("#68 MUST-PASS: a Design Parameters block that states SITE values is not refused wholesale", () => {
  const text = "DESIGN PARAMETERS: GROUND SNOW LOAD: 25 PSF WIND SPEED: 115 MPH EXPOSURE CATEGORY: C RISK CATEGORY: II";
  assert.deepEqual(statedOf(text, "groundSnowPsf"), [25]);
  assert.deepEqual(statedOf(text, "windSpeedMph"), [115]);
});

check("#68 gate: a correct letter plus the range block raises no conflict and no below-AHJ blocker in a verified 115 mph AHJ", () => {
  const letter = `Loads Used for Design BUILDING CODE ASCE 7-16 WIND SPEED 120.00 mph GROUND SNOW LOAD 25.00 psf WIND EXPOSURE C RISK CATEGORY II ${RANGE_BLOCK}`;
  const p = project({ snow: "25", windSpeed: "120", wind: "C", riskCategory: "II" });
  const ctx = ctxFor({ confidence: "verified", verifiedBy: "operator", verifiedAt: "2026-09-20T00:00:00Z",
    designCriteria: { windSpeedMph: 115, groundSnowLoadPsf: 25, windExposure: "C" } });
  const fs = run(p, ctx, [{ label: "Structural letter", text: letter }]);
  assert.ok(!get(fs, BELOW), `no below-ahj: ${get(fs, BELOW)?.message}`);
  assert.ok(!get(fs, CONFLICT), `no conflict: ${get(fs, CONFLICT)?.message}`);
});

// ---------------------------------------------------------------------------------------
// Issue #111 — the cheap numeric comparisons: seismic design category, frost depth, the
// prescriptive path's wind caps, an allowable-stress ground snow load, risk category. Same policy
// as below-ahj: a BLOCKER only when the field's row is human-verified AND a document (not the
// parser) states the value; otherwise a warning. Wind caps are never a blocker.
// ---------------------------------------------------------------------------------------
const WIND_CAP = "city.struct.wind-exceeds-prescriptive-cap";
const VERIFIED = { confidence: "verified" as const, verifiedBy: "operator", verifiedAt: "2026-09-20T00:00:00Z" };
// Wind and snow on file and met, so only the new lines can fire.
const MET = { windSpeedMph: 110, groundSnowLoadPsf: 25 };
const plan111 = (extra: string, snap: Record<string, unknown> = {}) =>
  project({ ...snap, planSetExtractedText: `STRUCTURAL NOTES: GROUND SNOW LOAD = 25 PSF WIND SPEED = 110 MPH EXPOSURE CATEGORY = C ${extra}` });

check("#111 SDC: extractor reads the category, never a site class, a list, or a limit", () => {
  const sdc = (text: string) => extractStatedDesignCriteria(project({ planSetExtractedText: text })).criteria
    .filter((c) => c.criterion === "seismicDesignCategory").map((c) => c.value);
  assert.deepEqual(sdc("SEISMIC DESIGN CATEGORY = C"), ["C"]);
  assert.deepEqual(sdc("SDC: D2"), ["D2"]);
  assert.deepEqual(sdc("Seismic Design Category D1. Seismic Site Class D."), ["D1"]);
  assert.deepEqual(sdc("limited to Seismic Design Categories A, B and C"), []);
  assert.deepEqual(sdc("Seismic Design Category D0, D1 or D2"), []);
  assert.deepEqual(sdc("the seismic design category and site class are per ASCE 7"), []);
});

check("#111 SDC: plan C below the AHJ's D1 — warning on a seeded row, BLOCKER on a verified one", () => {
  const p = plan111("SEISMIC DESIGN CATEGORY = C");
  const seeded = get(run(p, ctxFor({ designCriteria: { ...MET, seismicDesignCategory: "D1" } })), BELOW);
  assert.equal(seeded?.severity, "warning");
  assert.match(seeded!.message, /Seismic design category: stated C .* requires Seismic Design Category D1/);
  assert.match(seeded!.message, /not human-verified/);
  const verified = get(run(p, ctxFor({ ...VERIFIED, designCriteria: { ...MET, seismicDesignCategory: "D1" } })), BELOW);
  assert.equal(verified?.severity, "blocker");
});

check("#111 SDC MUST-EXCLUDE: at or above the AHJ, and a bare D against a D subcategory, are not below", () => {
  for (const [planSdc, ahjSdc] of [["D1", "D1"], ["D2", "D1"], ["D", "D2"], ["D0", "D"], ["E", "D2"]]) {
    const f = get(run(plan111(`SEISMIC DESIGN CATEGORY = ${planSdc}`), ctxFor({ ...VERIFIED, designCriteria: { ...MET, seismicDesignCategory: ahjSdc } })), BELOW);
    assert.ok(!f, `plan ${planSdc} vs AHJ ${ahjSdc}: ${f?.message}`);
  }
  // D0 < D1 < D2 is compared.
  assert.ok(get(run(plan111("SEISMIC DESIGN CATEGORY = D0"), ctxFor({ designCriteria: { ...MET, seismicDesignCategory: "D2" } })), BELOW));
});

check("#111 frost depth: plan 18 in below the AHJ's 24 in — warning seeded, BLOCKER verified; feet-inches read", () => {
  const p = plan111("GROUND MOUNT FOOTINGS: FROST DEPTH = 18 IN");
  const seeded = get(run(p, ctxFor({ designCriteria: { ...MET, frostDepthIn: 24 } })), BELOW);
  assert.equal(seeded?.severity, "warning");
  assert.match(seeded!.message, /Frost depth: stated 18 in .* requires 24 in/);
  assert.equal(get(run(p, ctxFor({ ...VERIFIED, designCriteria: { ...MET, frostDepthIn: 24 } })), BELOW)?.severity, "blocker");
  const ftIn = get(run(plan111("FROST DEPTH: 1'-6\" BELOW GRADE"), ctxFor({ designCriteria: { ...MET, frostDepthIn: 24 } })), BELOW);
  assert.match(String(ftIn?.message), /stated 18 in/);
});

check("#111 frost depth MUST-EXCLUDE: no frost depth stated (a footing note), or one at the AHJ's, raises nothing", () => {
  const ctx = ctxFor({ ...VERIFIED, designCriteria: { ...MET, frostDepthIn: 24 } });
  assert.ok(!get(run(plan111("FOOTINGS SHALL EXTEND 12 IN BELOW FROST DEPTH"), ctx), BELOW));
  assert.ok(!get(run(plan111("FROST DEPTH = 24 IN"), ctx), BELOW));
  assert.ok(!get(run(plan111("FROST DEPTH 18-24 IN"), ctx), BELOW), "a range is not the plan's frost depth");
});

check("#111 risk category: plan I below the AHJ's II — warning seeded, BLOCKER verified; II vs II is nothing", () => {
  const p = plan111("RISK CATEGORY = I");
  const seeded = get(run(p, ctxFor({ designCriteria: { ...MET, riskCategory: "II" } })), BELOW);
  assert.equal(seeded?.severity, "warning");
  assert.match(seeded!.message, /Risk category: stated I .* requires Risk Category II/);
  assert.equal(get(run(p, ctxFor({ ...VERIFIED, designCriteria: { ...MET, riskCategory: "II" } })), BELOW)?.severity, "blocker");
  assert.ok(!get(run(plan111("RISK CATEGORY = II"), ctxFor({ ...VERIFIED, designCriteria: { ...MET, riskCategory: "II" } })), BELOW));
});

check("#111 hard rule: a value only the PARSER read never blocks, even against a verified row", () => {
  // No document states a risk category; the parser's field says I.
  const p = project({ riskCategory: "I", planSetExtractedText: "STRUCTURAL NOTES: GROUND SNOW LOAD = 25 PSF WIND SPEED = 110 MPH" });
  const f = get(run(p, ctxFor({ ...VERIFIED, designCriteria: { ...MET, riskCategory: "II" } })), BELOW);
  assert.equal(f?.severity, "warning");
  assert.match(f!.message, /only the parser's reading states it/);
});

check("#111 two different documented values never block: the package contradicts itself", () => {
  const ctx = ctxFor({ ...VERIFIED, designCriteria: { ...MET, seismicDesignCategory: "D1" } });
  const f = get(run(project({}), ctx, [
    { label: "Plan set", text: "GROUND SNOW LOAD = 25 PSF WIND SPEED = 110 MPH SEISMIC DESIGN CATEGORY = C" },
    { label: "Structural letter", text: "Seismic Design Category: D1" },
  ]), BELOW);
  assert.equal(f?.severity, "warning");
  assert.match(f!.message, /more than one value/);
});

check("#111 Pg(asd): today it is never compared with the strength Pg (pinned); with the AHJ's pg(asd) on file it is", () => {
  const p = plan111("GROUND SNOW LOAD, PG(ASD) = 15 PSF");
  // Pg(asd) 15 against a strength Pg 25 would always read "below": it is not compared.
  const strengthOnly = get(run(p, ctxFor({ ...VERIFIED, designCriteria: { ...MET } })), BELOW);
  assert.ok(!strengthOnly, `Pg(asd) mis-compared with Pg: ${strengthOnly?.message}`);
  const seeded = get(run(p, ctxFor({ designCriteria: { ...MET, groundSnowLoadAsdPsf: 18 } })), BELOW);
  assert.equal(seeded?.severity, "warning");
  assert.match(seeded!.message, /Ground snow load pg\(asd\): stated 15 psf .* requires 18 psf pg\(asd\)/);
  assert.equal(get(run(p, ctxFor({ ...VERIFIED, designCriteria: { ...MET, groundSnowLoadAsdPsf: 18 } })), BELOW)?.severity, "blocker");
  assert.ok(!get(run(plan111("GROUND SNOW LOAD, PG(ASD) = 18 PSF"), ctxFor({ ...VERIFIED, designCriteria: { ...MET, groundSnowLoadAsdPsf: 18 } })), BELOW));
});

check("#111 wind cap: 130 mph in Exposure C over a 120 mph cap on the prescriptive path — a WARNING, even verified", () => {
  const plan = "GROUND SNOW LOAD = 25 PSF WIND SPEED = 130 MPH EXPOSURE CATEGORY = C";
  const prescriptive = project({ permitPath: "Prescriptive", planSetExtractedText: plan });
  const caps = { maxWindSpeedMphExpB: 140, maxWindSpeedMphExpC: 120 };
  for (const ctx of [ctxFor({ designCriteria: { ...MET }, prescriptive: caps }), ctxFor({ ...VERIFIED, designCriteria: { ...MET }, prescriptive: caps })]) {
    const f = get(run(prescriptive, ctx), WIND_CAP);
    assert.equal(f?.severity, "warning");
    assert.match(f!.message, /130 mph .* Exposure C .* at most 120 mph in Exposure C/);
    assert.match(f!.title, /engineered path needed/);
  }
});

check("#111 wind cap MUST-EXCLUDE: engineered or undecided path, within the cap for the stated exposure, or a nominal speed", () => {
  const caps = { maxWindSpeedMphExpB: 140, maxWindSpeedMphExpC: 120 };
  const ctx = ctxFor({ ...VERIFIED, designCriteria: { ...MET }, prescriptive: caps });
  const over = "GROUND SNOW LOAD = 25 PSF WIND SPEED = 130 MPH EXPOSURE CATEGORY = C";
  assert.ok(!get(run(project({ permitPath: "Engineered", planSetExtractedText: over }), ctx), WIND_CAP));
  assert.ok(!get(run(project({ planSetExtractedText: over }), ctx), WIND_CAP), "path unknown: permitPath decides, not this rule");
  assert.ok(!get(run(project({ permitPath: "Prescriptive", planSetExtractedText: "WIND SPEED = 130 MPH EXPOSURE CATEGORY = B" }), ctx), WIND_CAP), "Exposure B's cap is 140");
  assert.ok(!get(run(project({ permitPath: "Prescriptive", planSetExtractedText: "Vasd = 130 mph EXPOSURE CATEGORY = C" }), ctx), WIND_CAP), "a nominal speed is not Vult");
});

check("#111 not on file: the plan's SDC / frost depth / risk category ride along in the unknown callout", () => {
  const p = project({ planSetExtractedText: "SEISMIC DESIGN CATEGORY = D1 FROST DEPTH = 30 IN RISK CATEGORY = II" });
  const f = get(run(p, ctxFor({ designCriteria: {} })), UNKNOWN);
  assert.equal(f?.severity, "callout");
  assert.match(f!.message, /seismic design category — stated in the package: D1/);
  assert.match(f!.message, /frost depth — stated in the package: 30 in/);
  assert.match(f!.message, /risk category — stated in the package: II/);
  // On file -> not repeated as unchecked.
  const onFile = get(run(p, ctxFor({ designCriteria: { seismicDesignCategory: "D1" } })), UNKNOWN);
  assert.doesNotMatch(String(onFile?.message), /seismic design category —/);
});

if (failures) {
  console.error(`\n${failures} design-criteria check(s) FAILED`);
  process.exit(1);
}
console.log("\nall design-criteria checks passed");
