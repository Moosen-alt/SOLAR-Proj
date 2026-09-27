// MANUFACTURED HOMES, UL LISTINGS, AND ATTACHMENT SPACING vs THE JURISDICTION'S LIMIT.
//
// Two real Oregon bounces (fixtures below are SYNTHETIC strings modelled on their facts — no
// names, addresses, firms or seals):
//   A. A coastal city: "Provide updated mounting spacing. -The mounting spacing should be 2' oc
//      ... Provide UL listing for the panels, mounting and racking hardware." The plan said
//      attachments 4'-0" O.C. (24" within 3 ft of edges) and showed only UL1699B.
//   B. Another coastal city: "The proposed installation is being placed on a manufactured
//      home. Prescriptive code does not allow this ... (Cont. load path). R301.1.3 ORSC". The
//      approved letter later said "HUD manufactured home", "2x2 manufactured trusses @ 24\" o.c.".
//
// Every MUST-PASS fails with its rule removed; every MUST-EXCLUDE is a real way the patterns
// could misread a package.
//
// Run: npx tsx backend/test/structureListingsSpacing.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { JurisdictionCodeProfile, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { buildCodeContext } from "../src/codeProfiles";
import { evaluateDesignCodeFindings, structureType } from "../src/codeReviewRules";
import { extractAhjRequiredCriteria, extractAttachmentSpacings, type DesignTextSource } from "../src/designCriteria";
import { buildReviewerReport, topicForFinding } from "../src/reviewerEngine";
import { visionMayRelax } from "../src/reviewerVision";
import { classifyPermitStatusText, extractPortalCondition } from "../src/permitMonitor";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const project = (snapshot: Record<string, unknown>, over: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: "structure-listings-test",
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
const ctxFor = (over: Partial<JurisdictionCodeProfile> = {}) => buildCodeContext("OR", "City of Testport", profile(over));
const VERIFIED = { confidence: "verified" as const, verifiedBy: "operator", verifiedAt: "2026-09-20T00:00:00Z" };

// null = NO jurisdiction context (the legacy path). Not `undefined`: that would take the default.
const run = (p: ProjectRecord, ctx: ReturnType<typeof ctxFor> | null = ctxFor(), docs: DesignTextSource[] = [], docTypes: string[] = []): ReviewerFinding[] =>
  evaluateDesignCodeFindings(p, null, ctx ?? undefined, docTypes, docs);
const get = (fs: ReviewerFinding[], id: string): ReviewerFinding | undefined => fs.find((f) => f.id === id);

const MH_PRESCRIPTIVE = "city.struct.manufactured-home-prescriptive";
const MH_LOAD_PATH = "city.struct.manufactured-home-load-path";
const LISTINGS = "city.plan.ul-listings-missing";
const SPACING_OVER = "city.struct.anchor-spacing-exceeds-ahj";
const SPACING_UNCHECKED = "city.struct.anchor-spacing-unchecked";

const isMh = (snapshot: Record<string, unknown>, docs: DesignTextSource[] = []): boolean =>
  structureType(project(snapshot), docs).kind === "manufactured_home";

// ---------------------------------------------------------------------------------------
// 1. Manufactured home — the predicate.
// ---------------------------------------------------------------------------------------
check("MH MUST-PASS: the approved letter's own words (HUD manufactured home, 2x2 manufactured trusses)", () => {
  assert.ok(isMh({ structuralCalcText: "Structure: HUD manufactured home. Framing: 2x2 manufactured trusses @ 24\" o.c." }));
});
check("MH MUST-PASS: '2x2 manufactured trusses' alone is the tell", () => {
  assert.ok(isMh({ structuralCalcText: "ROOF FRAMING: 2\"x2\" MANUFACTURED TRUSSES @ 24\" O.C." }));
});
check("MH MUST-PASS: mobile home / manufactured dwelling / HUD data plate / 24 CFR 3280 / MH unit", () => {
  assert.ok(isMh({ planSetExtractedText: "EXISTING MOBILE HOME, SINGLE STORY" }), "mobile home");
  assert.ok(isMh({ projectDescriptionText: "Roof-mounted PV on a manufactured dwelling." }), "manufactured dwelling");
  assert.ok(isMh({ roofPlanNotesText: "See HUD data plate for roof load zone." }), "HUD data plate");
  assert.ok(isMh({ structuralCalcText: "Home constructed per 24 CFR 3280." }), "24 CFR 3280");
  assert.ok(isMh({ sitePlanNotesText: "Existing MH unit on piers." }), "MH unit");
});
check("MH MUST-PASS: a structure-type FIELD answers it ('MH' short value), and a per-document text counts", () => {
  const fact = structureType(project({ structureType: "MH" }));
  assert.equal(fact.kind, "manufactured_home");
  assert.match(fact.excerpt, /structureType: MH/);
  assert.ok(isMh({}, [{ label: "Engineer's letter", text: "The home is a manufactured home on a pier foundation." }]));
});
check("MH MUST-PASS: a nearby 'not' that negates something ELSE does not deny the home", () => {
  assert.ok(isMh({ structuralCalcText: "Design is engineered, not prescriptive, for a manufactured home." }));
});
check("MH MUST-EXCLUDE: manufacturer / manufactured by / site-built 'manufactured trusses'", () => {
  assert.ok(!isMh({ planSetExtractedText: "GROUNDED USING WEEB GROUNDING CLIPS AS SHOWN IN MANUFACTURER DOCUMENTATION AND APPROVED BY THE AHJ." }), "manufacturer documentation");
  assert.ok(!isMh({ planSetExtractedText: "RAIL MANUFACTURED BY TESTRACK INC. INSTALL PER MANUFACTURER'S INSTRUCTIONS." }), "manufactured by");
  assert.ok(!isMh({ structuralCalcText: "ROOF FRAMING: 2x4 MANUFACTURED TRUSSES @ 24\" O.C." }), "2x4 manufactured trusses on a site-built house");
  assert.ok(!isMh({ structuralCalcText: "Pre-manufactured trusses, engineered by the truss manufacturer." }), "pre-manufactured trusses");
});
check("MH MUST-EXCLUDE: a 2\"X2\" rafter with no manufactured-home words (the Lincoln City near-miss)", () => {
  assert.ok(!isMh({ planSetExtractedText: "(N) PV MODULE 2\" X 2\" RAFTER @ 24\" O.C.", framingType: "truss", roofRafterSize: "2x2" }));
});
check("MH MUST-EXCLUDE: negated and answered-no forms", () => {
  assert.ok(!isMh({ projectDescriptionText: "The structure is not a manufactured home." }), "not a manufactured home");
  assert.ok(!isMh({ planSetExtractedText: "MANUFACTURED HOME: NO" }), "answered no");
  assert.ok(!isMh({ planSetExtractedText: "Manufactured home? N/A" }), "N/A");
  assert.ok(!isMh({ planSetExtractedText: "Non-manufactured home construction, site built." }), "non-");
});
check("MH MUST-EXCLUDE: manhole 'MH', 'Hudson', and parser commentary (reviewFlags / stampRecommendation)", () => {
  assert.ok(!isMh({ sitePlanNotesText: "EXISTING SEWER MANHOLE (MH) AT CURB. MH RIM EL 102.3" }), "manhole MH");
  assert.ok(!isMh({ planSetExtractedText: "HUDSON STREET FRONTAGE" }), "Hudson");
  assert.ok(!isMh({ reviewFlags: "Verify whether this is a manufactured home.", stampRecommendation: "If a mobile home, engineering is required." }), "commentary");
});

// ---------------------------------------------------------------------------------------
// 1b. Manufactured home — the rules.
// ---------------------------------------------------------------------------------------
const MH_TEXT = { structuralCalcText: "HUD manufactured home, 2x2 manufactured trusses @ 24\" o.c., attachments at 24\" o.c." };
// STATED — the blocker level. Text alone is the warning level (structureTypeConfidence.test.ts).
const MH_STATED = { ...MH_TEXT, structureTypeOverride: "manufactured" };

check("MH + prescriptive -> BLOCKER citing R301.1.3 of the adopted ORSC, with the AHJ's load-path wording", () => {
  const f = get(run(project({ ...MH_STATED, permitPath: "prescriptive" })), MH_PRESCRIPTIVE);
  assert.ok(f, "must fire");
  assert.equal(f!.severity, "blocker");
  assert.match(f!.cityFeedback, /continuous load path/);
  assert.ok(f!.codeReferences.some((r) => r.section === "R301.1.3" && /ORSC/.test(r.code)), JSON.stringify(f!.codeReferences));
  assert.match(f!.evidenceFound?.[0]?.excerpt ?? "", /structureTypeOverride: manufactured/i);
});
check("MH + prescriptive is a blocker even with NO jurisdiction context (code applicability, not profile data)", () => {
  const f = get(run(project({ ...MH_STATED, permitPath: "prescriptive" }), null), MH_PRESCRIPTIVE);
  assert.equal(f?.severity, "blocker");
});
check("MH + engineered, engineering silent on the load path -> BLOCKER (load-path), not the prescriptive one", () => {
  const fs = run(project({ ...MH_STATED, permitPath: "engineered" }));
  assert.equal(get(fs, MH_LOAD_PATH)?.severity, "blocker");
  assert.ok(!get(fs, MH_PRESCRIPTIVE));
});
check("MH + engineered, engineering carries the load to the foundation -> cleared", () => {
  for (const text of [
    "A continuous load path is provided from the PV attachments through the roof framing and walls to the foundation piers.",
    "New loads are transferred from roof framing through the exterior walls to the footing.",
    "Roof framing through footing verified for the added PV load.",
  ]) {
    const fs = run(project({ ...MH_STATED, permitPath: "engineered" }), ctxFor(), [{ label: "Engineer's letter", text }]);
    assert.ok(!get(fs, MH_LOAD_PATH), `should clear: ${text}`);
  }
});
check("MH load-path MUST-EXCLUDE: a load path that ends at the rafters, 'ground snow', a negated statement, commentary", () => {
  for (const snap of [
    { ...MH_STATED, structuralCalcText: `${MH_TEXT.structuralCalcText} Load path to the rafters verified by pull-out calc.` },
    { ...MH_STATED, structuralCalcText: `${MH_TEXT.structuralCalcText} Load path per attachment ground snow load 28 psf.` },
    { ...MH_STATED, structuralCalcText: `${MH_TEXT.structuralCalcText} Load path to the foundation not evaluated.` },
    { ...MH_STATED, stampRecommendation: "Engineer must show the continuous load path to the foundation." },
  ]) {
    const fs = run(project({ ...snap, permitPath: "engineered" }));
    assert.equal(get(fs, MH_LOAD_PATH)?.severity, "blocker", `must still fire: ${JSON.stringify(snap).slice(0, 120)}`);
  }
});
check("MH rules MUST-EXCLUDE: a site-built house and a ground-mounted array raise neither", () => {
  const siteBuilt = run(project({ structuralCalcText: "2x4 manufactured trusses @ 24\" o.c.", permitPath: "prescriptive" }));
  assert.ok(!get(siteBuilt, MH_PRESCRIPTIVE) && !get(siteBuilt, MH_LOAD_PATH));
  const ground = run(project({ ...MH_STATED, mounting: "Ground mount", permitPath: "prescriptive" }));
  assert.ok(!get(ground, MH_PRESCRIPTIVE) && !get(ground, MH_LOAD_PATH));
});

// ---------------------------------------------------------------------------------------
// 2. UL listings.
// ---------------------------------------------------------------------------------------
const BOTH = "MODULES LISTED TO UL 61730. RACKING SYSTEM LISTED TO UL 2703 FOR BONDING AND MECHANICAL LOADING.";

const INVERTER_LISTINGS_ONLY = "INVERTERS LISTED TO UL 1741. ARC-FAULT PROTECTION ACCORDING TO NEC 690.11 AND UL1699B.";
const ASKED = { prescriptive: { listingEvidenceRequired: true } };
check("LISTINGS MUST-PASS: only UL 1741 and UL1699B -> a CALLOUT by default, both missing, in the AHJ's own words", () => {
  const f = get(run(project({ planSetExtractedText: INVERTER_LISTINGS_ONLY })), LISTINGS);
  assert.ok(f, "must fire");
  assert.equal(f!.severity, "callout", "no jurisdiction has asked — an unread cut sheet is not a warning everywhere");
  assert.equal(f!.cityFeedback, "Provide UL listing for the panels, mounting and racking hardware.");
  assert.match(f!.message, /module listing/);
  assert.match(f!.message, /UL 2703/);
  assert.match(f!.message, /text that could be read/, "an absence we could not fully check says so");
});
check("LISTINGS MUST-PASS: where the jurisdiction's profile asks for listing evidence -> WARNING (UL 1741 / 1699B still do not satisfy it)", () => {
  const f = get(run(project({ planSetExtractedText: INVERTER_LISTINGS_ONLY }), ctxFor(ASKED)), LISTINGS);
  assert.ok(f, "UL 1741 / UL 1699B satisfied a jurisdiction that asked for module/racking listings");
  assert.equal(f!.severity, "warning");
  assert.match(f!.message, /has asked for this listing evidence/);
});
check("LISTINGS in other states: WA / CA / FL / IL — callout by default, warning where that jurisdiction asked, never cleared by UL 1741", () => {
  for (const [st, ahj] of [["WA", "City of Spokane"], ["CA", "City of Fresno"], ["FL", "City of Tampa"], ["IL", "Village of Oak Park"]] as const) {
    const c = (prescriptive: Record<string, unknown>) => buildCodeContext(st, ahj, { ...profile({ prescriptive }), key: `${st.toLowerCase()}|${ahj.toLowerCase()}|unknown`, state: st, ahj, adoptedCodes: [{ code: "IRC", edition: "2021" }, { code: "NEC", edition: "2023" }] });
    const p = project({ planSetExtractedText: INVERTER_LISTINGS_ONLY }, { state: st, ahj } as Partial<ProjectRecord>);
    assert.equal(get(run(p, c({})), LISTINGS)?.severity, "callout", `${st} default`);
    assert.equal(get(run(p, c({ listingEvidenceRequired: true })), LISTINGS)?.severity, "warning", `${st} asked`);
  }
});
check("LISTINGS MUST-EXCLUDE: a jurisdiction that asks, and a package that shows both -> no finding; listingEvidenceRequired:false -> callout", () => {
  assert.ok(!get(run(project({ planSetExtractedText: BOTH }), ctxFor(ASKED)), LISTINGS));
  assert.equal(get(run(project({ planSetExtractedText: INVERTER_LISTINGS_ONLY }), ctxFor({ prescriptive: { listingEvidenceRequired: false } })), LISTINGS)?.severity, "callout");
});
check("LISTINGS through the real engine: both missing stays evidence 'missing' (a flashing detail does not verify it)", () => {
  const p = project({ planSetExtractedText: "ATTACHMENT DETAIL: L-FOOT WITH FLASHING, LAG SCREW 2.5\" EMBEDMENT. INVERTERS UL 1741. UL1699B." });
  const f = buildReviewerReport(p, { codeContext: ctxFor() }).findings.find((x) => x.id === LISTINGS);
  assert.ok(f, "must fire");
  assert.equal(f!.evidenceStatus, "missing");
  assert.ok(!(f!.evidenceFound ?? []).some((e) => /flashing|l-foot|lag/i.test(e.excerpt)), "no racking-topic excerpts pasted in");
});
check("LISTINGS: module shown, racking not -> names only the racking", () => {
  const f = get(run(project({ planSetExtractedText: "PV MODULES: UL 61730 LISTED." })), LISTINGS);
  assert.ok(f);
  assert.doesNotMatch(f!.message, /module listing/);
  assert.match(f!.message, /racking\/mounting listing \(UL 2703\)/);
});
check("LISTINGS: both shown (incl. UL/IEC 61730, ANSI/UL 2703, legacy UL 1703) -> no finding", () => {
  assert.ok(!get(run(project({ planSetExtractedText: BOTH })), LISTINGS));
  assert.ok(!get(run(project({ planSetExtractedText: "Module certified UL/IEC 61730. Rail ANSI/UL 2703." })), LISTINGS));
  assert.ok(!get(run(project({ planSetExtractedText: "Module UL1703. Racking UL-2703." })), LISTINGS));
  assert.ok(!get(run(project({}), ctxFor(), [{ label: "Racking certificate", text: "Certified to UL 2703" }, { label: "Module cut sheet", text: "UL 61730" }])), LISTINGS);
});
check("LISTINGS MUST-EXCLUDE: an attached module_spec DOCUMENT without the listing text does not satisfy it", () => {
  assert.ok(get(run(project({ planSetExtractedText: "MODULE SPEC SHEET 400W" }), ctxFor(), [], ["module_spec", "plan_set"]), LISTINGS));
});
check("LISTINGS MUST-EXCLUDE: a negated listing and parser commentary do not satisfy it", () => {
  assert.ok(get(run(project({ planSetExtractedText: "MODULES UL 61730.", structuralCalcText: "No UL 2703 listing provided for the rail." })), LISTINGS), "negated");
  assert.ok(get(run(project({ planSetExtractedText: "MODULES UL 61730.", reviewFlags: "UL 2703 listing looks fine" })), LISTINGS), "reviewFlags");
});
check("LISTINGS: no jurisdiction context (legacy golden path) and ground mount -> no finding", () => {
  assert.ok(!get(run(project({}), null), LISTINGS));
  assert.ok(!get(run(project({ mounting: "Ground mount" })), LISTINGS));
});

// ---------------------------------------------------------------------------------------
// 3. Attachment spacing vs the jurisdiction's limit.
// ---------------------------------------------------------------------------------------
const LIMIT24 = { prescriptive: { maxAttachmentSpacingIn: 24 } };
const A_PLAN = "SYSTEM LEGEND = ATTACHMENT POINTS = RAFTER SIZE & SPACING - 2\"X4\" @ 16\" O.C. NEW PV ATTACHMENTS AT 4'-0\" O.C.";
const A_CALC = "Attachments: roof hooks with (2) wood screws into decking, rail, spaced ~4'-0\" O.C. (max 24\" O.C. within 3 ft of edge/hip/eave/ridge).";

check("SPACING extractor: the field 4'-0\" reads as 48; the rafter's 16\" o.c. is framing, not attachment", () => {
  assert.deepEqual(extractAttachmentSpacings(A_PLAN).map((s) => s.inches), [48]);
  // The edge-zone 24" sits 60+ chars from any attachment word, so it is not read — harmless:
  // the FIELD spacing is the larger value, and that is the one compared.
  assert.ok(extractAttachmentSpacings(A_CALC).some((s) => s.inches === 48));
});
check("SPACING excerpt stops at the value — the title block after it (owner name) never rides along", () => {
  const [s] = extractAttachmentSpacings("FENCE 1'-8\" NEW PV ATTACHMENTS AT 4'-0\" O.C. N Rev TEST OWNER RESIDENCE 1 TEST ST");
  assert.equal(s?.excerpt, "ATTACHMENTS AT 4'-0\" O.C.");
});
check("SPACING: the AHJ-comment extractor still reads 'mounting spacing should be 2' oc' (shared reader)", () => {
  const got = extractAhjRequiredCriteria("Provide updated mounting spacing. -The mounting spacing should be 2' oc per R324.4.1 exception 5 exception 1.4.");
  assert.deepEqual(got.filter((c) => c.criterion === "maxAttachmentSpacingIn").map((c) => c.value), [24]);
});
check("SPACING MUST-PASS: plan field 4'-0\" vs limit 24\" -> finding; seeded -> warning; names 48 and 24", () => {
  const f = get(run(project({ planSetExtractedText: A_PLAN, permitPath: "prescriptive" }), ctxFor(LIMIT24)), SPACING_OVER);
  assert.ok(f, "must fire");
  assert.equal(f!.severity, "warning");
  assert.match(f!.message, /48" o\.c\./);
  assert.match(f!.message, /24" o\.c\./);
});
check("SPACING: verified profile + prescriptive path -> BLOCKER; verified + engineered -> warning (screeningSeverity)", () => {
  assert.equal(get(run(project({ structuralCalcText: A_CALC, permitPath: "prescriptive" }), ctxFor({ ...VERIFIED, ...LIMIT24 })), SPACING_OVER)?.severity, "blocker");
  assert.equal(get(run(project({ structuralCalcText: A_CALC, permitPath: "engineered" }), ctxFor({ ...VERIFIED, ...LIMIT24 })), SPACING_OVER)?.severity, "warning");
});
check("SPACING: the parser's attachmentSpacingIn field alone is enough to compare", () => {
  assert.ok(get(run(project({ attachmentSpacingIn: "48", attachmentEdgeSpacingIn: "24" }), ctxFor(LIMIT24)), SPACING_OVER));
});
check("SPACING MUST-EXCLUDE: a compliant plan, framing-only spacing, and a profile with no limit", () => {
  assert.ok(!get(run(project({ planSetExtractedText: "NEW PV ATTACHMENTS AT 24\" O.C." }), ctxFor(LIMIT24)), SPACING_OVER), "compliant");
  const framingOnly = run(project({ planSetExtractedText: "2x4 RAFTERS @ 24\" O.C. RAFTER SIZE & SPACING 2\"X6\" @ 16\" O.C." }), ctxFor({ prescriptive: { maxAttachmentSpacingIn: 12 } }));
  assert.ok(!get(framingOnly, SPACING_OVER), "framing spacing is not attachment spacing");
  assert.equal(get(framingOnly, SPACING_UNCHECKED)?.severity, "callout", "nothing readable -> the unchecked callout, never silence");
  const noLimit = run(project({ planSetExtractedText: A_PLAN }), ctxFor());
  assert.ok(!get(noLimit, SPACING_OVER) && !get(noLimit, SPACING_UNCHECKED), "no limit on file -> no spacing finding");
});
check("SPACING: a measured violation is out of vision's reach (not relaxable by 'the sheet shows a spacing')", () => {
  const f = get(run(project({ planSetExtractedText: A_PLAN, permitPath: "prescriptive" }), ctxFor({ ...VERIFIED, ...LIMIT24 })), SPACING_OVER)!;
  assert.ok(!visionMayRelax(f) || topicForFinding(f) === null, `topic ${topicForFinding(f)} would let vision soften a measured result`);
});

// ---------------------------------------------------------------------------------------
// 4. Floodplain — the monitor's condition reader (characterisation; the gap is reported).
// ---------------------------------------------------------------------------------------
const ACCELA_INTAKE = "Record 000-00-000000-STR: Record Status: Intake Requirements Needed Expiration Date: "
  + "Record on 05/01/2026.Condition: FloodplainSeverity: NoticeTotal Conditions: 1 (Notice: 1)View Condition";
check("FLOOD: extractPortalCondition surfaces an Accela 'Condition: Floodplain' notice", () => {
  assert.match(extractPortalCondition(ACCELA_INTAKE), /Floodplain/);
  assert.match(classifyPermitStatusText(ACCELA_INTAKE, "permit").message, /Floodplain/);
});
check("FLOOD MUST-EXCLUDE: 'air conditioning' and 'Conditions of approval' are not a record condition", () => {
  assert.equal(extractPortalCondition("New air conditioning condenser on pad. Conditions of approval attached."), "");
});
// The Lincoln City record page, as Accela renders it: markup stripped, fields glued together.
const accelaPage = (status: string, condition = "Floodplain"): string =>
  `Record 000-26-000000-STR: Residential Solar Record Status: ${status} Expiration Date: 03/01/2027 `
  + `Add Cancel A notice was added to this record on 05/01/2026.Condition: ${condition}Severity: NoticeTotal Conditions: 1 `
  + "(Notice: 1)View Condition Conditions Showing 1-1 of 1 Record Details";
check("FLOOD: the condition's name is cut at Accela's glued 'Severity:' — 'Condition: Floodplain', nothing after", () => {
  assert.equal(extractPortalCondition(accelaPage("In Review")), "Condition: Floodplain");
  assert.equal(extractPortalCondition(accelaPage("In Review", "Sewer Recovery")), "Condition: Sewer Recovery", "the production 720b05f3 shape");
});
check("FLOOD: the condition reaches the message on EVERY branch — correction_flagged, waiting, action-needed", () => {
  const seen: string[] = [];
  for (const status of ["Addl Info Needed", "In Review", "Intake Requirements Needed"]) {
    const c = classifyPermitStatusText(accelaPage(status), "permit");
    seen.push(c.outcome);
    assert.match(c.message, /The record also carries a condition: "Condition: Floodplain"\./, `${status} -> ${c.outcome}: ${c.message}`);
    assert.doesNotMatch(c.message, /Severity|Total Conditions/, `${status}: the condition text ran on into the next field`);
    assert.equal((c.message.match(/carries a condition/g) || []).length, 1, `${status}: condition appended twice`);
  }
  assert.deepEqual(seen, ["correction_flagged", "waiting", "needs_human_review"], "fixture premise: three different branches");
});
// A CONDITION LONGER THAN THE WINDOW STILL SHOWS. The name-ending lookahead (Severity / Total
// Conditions / View Condition / | / end) must fall inside 140 characters; a written-out condition
// with no marker in reach matched nothing, so conditionPattern saw a condition and the reading
// showed none — an unknown reading as "no condition". The first 140 characters show, as before.
const LONG_CONDITION = "Applicant shall record a floodplain elevation certificate with the county prior to requesting a final inspection; the building official will not schedule a final until";
check("FLOOD MUST-PASS: a condition that runs past 140 characters shows its first 140, marker far or absent, on every branch", () => {
  const far = `Record Status: Issued Condition: ${LONG_CONDITION} the recorded certificate is on file with the department Severity: Notice`;
  const none = `Record Status: In Review Condition: ${LONG_CONDITION} it is on file. Inspections Contacts Fees Payments`;
  for (const [label, page] of [["severity far", far], ["no marker", none]] as const) {
    const got = extractPortalCondition(page);
    assert.match(got, /^Condition: Applicant shall record a floodplain elevation certificate/, `${label}: ${JSON.stringify(got)}`);
    assert.ok(got.length <= "Condition: ".length + 140, `${label}: ${got.length} chars`);
    assert.match(classifyPermitStatusText(page, "permit").message, /The record also carries a condition: "Condition: Applicant shall record/, `${label}: message`);
  }
});
check("FLOOD MUST-EXCLUDE: the long-condition fallback does not undo the cut — a glued short name still ends at its Severity:", () => {
  assert.equal(extractPortalCondition(`Condition: Floodplain${"Severity: Notice".padEnd(200, " x")}`), "Condition: Floodplain");
  assert.equal(extractPortalCondition(`Conditions Condition: Sewer RecoverySeverity: NoticeTotal Conditions: 1 (Notice: 1)View Condition ${"filler ".repeat(40)}`), "Condition: Sewer Recovery");
  assert.equal(extractPortalCondition(`Condition: ${"x".repeat(150)} | next field`).length, "Condition: ".length + 140);
});
// r3f: "lien" had no word boundary — a page's "Client Services" became the lien "lient Services: …" and
// outranked the page's real condition — and "Condition: None" was shown as a condition.
check("FLOOD MUST-EXCLUDE (r3f): 'Client Services' is not a lien; 'Condition: None' / 'N/A' / 'none on file' is not a condition", () => {
  const withClient = `Client Services: 555-0100 ${accelaPage("In Review")}`;
  assert.equal(extractPortalCondition(withClient), "Condition: Floodplain");
  assert.doesNotMatch(classifyPermitStatusText(withClient, "permit").message, /lient/);
  for (const none of ["None", "N/A", "none on file", "No conditions"]) {
    const page = accelaPage("In Review", none);
    assert.equal(extractPortalCondition(page), "", `Condition: ${none}`);
    assert.doesNotMatch(classifyPermitStatusText(page, "permit").message, /carries a condition/, `Condition: ${none}`);
  }
  assert.equal(extractPortalCondition("Record Status: In Review Condition: None Inspections Contacts Fees Payments"), "", "the window running on past 'None'");
});
check("FLOOD MUST-PASS (r3f): a real lien and the glued Accela names still read; a None header does not hide a later real one", () => {
  assert.equal(extractPortalCondition(accelaPage("In Review")), "Condition: Floodplain");
  assert.equal(extractPortalCondition(accelaPage("In Review", "Sewer Recovery")), "Condition: Sewer Recovery");
  assert.equal(extractPortalCondition(accelaPage("In Review", "Nonconforming Use")), "Condition: Nonconforming Use", "'Non…' is a name, not 'None'");
  assert.equal(extractPortalCondition(accelaPage("In Review", "Nonexempt Floodway")), "Condition: Nonexempt Floodway", "'None…' inside a word is a name");
  const lien = "Record Status: In Review Parcel Notifications: Lien recorded against parcel 000-000 for unpaid sewer charges. Record Details";
  assert.equal(extractPortalCondition(lien), "Lien recorded against parcel 000-000 for unpaid sewer charges");
  assert.match(classifyPermitStatusText(lien, "permit").message, /carries a condition: "Lien recorded against parcel/);
  assert.equal(extractPortalCondition("Parcel NotificationsHoldLien recorded 2019."), "Lien recorded 2019", "a lien glued after a lower-case word end");
  assert.equal(extractPortalCondition("Condition: None Severity: Notice | Condition: FloodplainSeverity: Notice"), "Condition: Floodplain");
});
check("FLOOD MUST-EXCLUDE: a record with no condition gets no condition sentence, and the outcome is unchanged by one", () => {
  const plain = "Record 000-26-000000-STR: Residential Solar Record Status: In Review Expiration Date: 03/01/2027 Record Details";
  assert.doesNotMatch(classifyPermitStatusText(plain, "permit").message, /condition/i);
  assert.equal(classifyPermitStatusText(plain, "permit").outcome, classifyPermitStatusText(accelaPage("In Review"), "permit").outcome);
});

if (failures) {
  console.error(`\n${failures} structure/listing/spacing check(s) FAILED`);
  process.exit(1);
}
console.log("\nall structure/listing/spacing checks passed");
