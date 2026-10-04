// FIRE ACCESS PATHWAYS AND RIDGE SETBACKS ARE MEASURED, NOT JUST MENTIONED (issue #142).
//
// The gate asked only whether a roof plan MENTIONED a fire pathway (city.fire.pathways-missing)
// and listed the AHJ's placement rules as "confirm the roof plan meets them". A plan printing an
// 18" pathway for a jurisdiction that requires 36" passed both. Fixtures are SYNTHETIC strings and
// a synthetic one-page PDF: no names, addresses or real plan sets.
//
//   THE READER   — one reader for both sides: the plan's "36\" FIRE ACCESS PATHWAY" and the AHJ
//                  rule's "minimum 36-inch pathways … 3 feet from the ridge"; hip/valley, eave and
//                  ridge-vent dimensions are not pathways or ridge setbacks.
//   THE RULE     — city.fire.pathway-below-required, rule 3 shape: a BLOCKER only against a
//                  human-verified AHJ rule AND a document's statement; a seeded rule, a model-code
//                  default or the parser's reading is a WARNING. Meeting the number is a pass.
//   THE FALLBACK — no readable dimension: a city.fire.pathway-unmeasured callout carrying the
//                  requirement; city.fire.pathways-missing only when there is no pathway text AND
//                  no dimension.
//   THE VISION   — ONE measurement within MAX_VISION_CHECKS, stubbed here: cached, read back
//                  under cacheOnly with no call, never a blocker, and the measured finding can
//                  never be relaxed by vision.
//
// Run: npx tsx backend/test/firePathways.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JurisdictionCodeProfile, LLMProvider, ProjectRecord, ReviewerFinding, ReviewerVisionVerdict } from "../../shared/src/types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fire-pathways-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { PDFDocument, StandardFonts } = await import("pdf-lib");
const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { buildCodeContext } = await import("../src/codeProfiles");
const { evaluateDesignCodeFindings } = await import("../src/codeReviewRules");
const { readRoofPlanDimensions, requiredRoofPlanDimensions, applyRoofPlanMeasurement } = await import("../src/designCriteria");
const { buildReviewerReport } = await import("../src/reviewerEngine");
const { applyVisionToReviewerReport, applyCachedVisionVerdicts, visionMayRelax, MEASURED_FINDING_IDS } = await import("../src/reviewerVision");

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const BELOW = "city.fire.pathway-below-required";
const UNMEASURED = "city.fire.pathway-unmeasured";
const MISSING = "city.fire.pathways-missing";
const AHJ_RULE = "Minimum 36-inch fire access pathways on each roof plane; arrays shall be set back three (3) feet from the ridge.";

const project = (snapshot: Record<string, unknown>, over: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: "fire-pathways-test", state: "OR", ahj: "City of Testport", utility: "Test Power",
  homeownerName: "Test Owner", projectAddress: "1 Test St", interconnectionMethod: "Load-side breaker",
  parserSnapshot: { mounting: "Roof mount", ...snapshot },
  ...over,
} as unknown as ProjectRecord);
const profile = (over: Partial<JurisdictionCodeProfile>): JurisdictionCodeProfile => ({
  key: "or|city of testport|unknown", state: "OR", ahj: "City of Testport", confidence: "seeded",
  adoptedCodes: [{ code: "IRC", edition: "2021" }, { code: "NEC", edition: "2023" }],
  amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  ...over,
});
const withRule = (confidence: "verified" | "seeded") => buildCodeContext("OR", "City of Testport", profile({
  confidence, ...(confidence === "verified" ? { verifiedBy: "operator" } : {}),
  fireSetbacks: [{ id: "fire-1", description: AHJ_RULE }],
}));
const plan = (text: string) => [{ label: "Plan set", text }];
const run = (p: ProjectRecord, ctx: ReturnType<typeof withRule>, docs: Array<{ label: string; text: string }> = []): ReviewerFinding[] =>
  evaluateDesignCodeFindings(p, null, ctx, [], docs);
const get = (fs: ReviewerFinding[], id: string) => fs.find((f) => f.id === id);
const read = (t: string) => readRoofPlanDimensions(t).map((d) => `${d.kind}=${d.inches}`);

console.log("\n1. THE READER — one reader for the plan and the AHJ's rule");
await check("MUST PASS: a callout's pathway width, in inches and in feet-inches", () => {
  assert.deepEqual(read('36" FIRE ACCESS PATHWAY'), ["pathwayWidth=36"]);
  assert.deepEqual(read("1'-6\" FIRE PATHWAY"), ["pathwayWidth=18"]);
});
await check("MUST PASS: a ridge setback, value first or label first", () => {
  assert.deepEqual(read('18" SETBACK FROM RIDGE'), ["ridgeSetback=18"]);
  assert.deepEqual(read("RIDGE SETBACK: 2'-0\""), ["ridgeSetback=24"]);
});
await check("MUST PASS: the AHJ's own sentence (36-inch, three (3) feet)", () => {
  assert.deepEqual(read(AHJ_RULE), ["pathwayWidth=36", "ridgeSetback=36"]);
});
await check("MUST EXCLUDE: hip/valley and eave clearances are not pathways or ridge setbacks", () => {
  assert.deepEqual(read('36" PATHWAY FROM EAVE TO RIDGE. 18" CLEAR FROM HIP/VALLEY. 3\' FROM EAVE'), ["pathwayWidth=36"]);
});
await check("MUST EXCLUDE: a clearance joined to a ridge setback by AND is not a second (short) ridge setback", () => {
  // Read across "AND", the ridge label won and a compliant plan read 18 in from the ridge.
  assert.deepEqual(read('MAINTAIN 36" FROM RIDGE AND 18" CLEAR OF HIPS AND VALLEYS'), ["ridgeSetback=36"]);
  assert.deepEqual(read('ARRAY 36" FROM RIDGE AND 18" FROM EAVE'), ["ridgeSetback=36"]);
  assert.deepEqual(read('ARRAY 36" FROM RIDGE, 18" FROM EAVE'), ["ridgeSetback=36"]);
});
await check("MUST EXCLUDE: with no break at all, a value takes the label its preposition attaches it to", () => {
  // No AND, comma or stop: "18\" CLEAR OF HIPS" is the hips' even though RIDGE is nearer.
  assert.deepEqual(read('36" FROM RIDGE 18" CLEAR OF HIPS'), ["ridgeSetback=36"]);
  assert.deepEqual(read('ARRAY 36" FROM RIDGE 18" FROM EAVE'), ["ridgeSetback=36"]);
});
await check("MUST PASS: units with no space (36in, 3ft)", () => {
  assert.deepEqual(read("36in FIRE ACCESS PATHWAY"), ["pathwayWidth=36"]);
  assert.deepEqual(read("RIDGE SETBACK 3ft"), ["ridgeSetback=36"]);
});
await check("MUST EXCLUDE: a ridge vent, rafter spacing, a zoning setback, attachment spacing", () => {
  assert.deepEqual(read('RAFTER @ 24" O.C. RIDGE VENT 12" FRONT SETBACK 20 FT. NEW PV ATTACHMENTS AT 4\'-0" O.C.'), []);
});

console.log("\n2. THE RULE — measured against the AHJ's rule, rule 3 severity");
await check("MUST PASS: pathway 36 in vs the AHJ's 36 in (ridge 36 in vs 36 in) — no finding", () => {
  const fs = run(project({}), withRule("verified"), plan('36" FIRE ACCESS PATHWAY. 3\'-0" SETBACK FROM RIDGE.'));
  assert.equal(get(fs, BELOW), undefined, get(fs, BELOW)?.message);
  assert.equal(get(fs, UNMEASURED), undefined);
  assert.equal(get(fs, MISSING), undefined);
});
await check("MUST PASS: pathway 18 in vs 36 in on a VERIFIED rule, stated by a document — BLOCKER", () => {
  const f = get(run(project({}), withRule("verified"), plan('18" FIRE ACCESS PATHWAY. 36" SETBACK FROM RIDGE.')), BELOW);
  assert.ok(f, "no finding for an 18 in pathway against a 36 in rule");
  assert.equal(f!.severity, "blocker");
  assert.match(f!.message, /pathway width: stated 18 in \(Plan set\); requires at least 36 in/);
  assert.equal(f!.evidenceStatus, "verified");
});
await check("MUST PASS: the same plan against a SEEDED rule — WARNING, saying why", () => {
  const f = get(run(project({}), withRule("seeded"), plan('18" FIRE ACCESS PATHWAY')), BELOW);
  assert.equal(f?.severity, "warning");
  assert.match(f!.message, /not human-verified/);
});
await check("MUST PASS: ridge 2 ft vs the AHJ's 3 ft — BLOCKER on a verified rule", () => {
  const f = get(run(project({}), withRule("verified"), plan('36" FIRE ACCESS PATHWAY. 2\'-0" SETBACK FROM RIDGE.')), BELOW);
  assert.equal(f?.severity, "blocker");
  assert.match(f!.message, /setback from the ridge: stated 24 in .* requires at least 36 in/);
  assert.doesNotMatch(f!.message, /pathway width/, "a pathway that meets the rule is not reported");
});
await check("MUST PASS: parser-only — the short pathway only in the parser's roof plan notes — WARNING", () => {
  const f = get(run(project({ roofPlanNotesText: 'Roof plan shows 18" fire access pathway on plane 1.' }), withRule("verified")), BELOW);
  assert.equal(f?.severity, "warning");
  assert.match(f!.message, /only the parser's reading states it/);
});
await check("MUST PASS: no AHJ rule — the adopted IRC 2021 default (36 in pathway), a WARNING", () => {
  const ctx = buildCodeContext("OR", "City of Testport", profile({ confidence: "verified", verifiedBy: "operator" }));
  const f = get(run(project({}), ctx, plan('18" FIRE ACCESS PATHWAY')), BELOW);
  assert.equal(f?.severity, "warning");
  assert.match(f!.message, /IRC 2021 R324\.6\.1 model-code default/);
});
await check("MUST PASS: the edition decides the default ridge setback (IRC 2012: 36 in; IRC 2015 on: the 18 in floor)", () => {
  // IRC 2015 R324.6.2 (mirroring IFC 2015 605.11.3.2.3) already splits on roof coverage: 18 in at
  // no more than 33%, 36 in above. Coverage is not read, so the floor applies and the message
  // names the 36 in case. The 36-in-only text is the 2012 IFC's.
  const at = (edition: string) => buildCodeContext("OR", "City of Testport", profile({ adoptedCodes: [{ code: "IRC", edition }] }));
  assert.equal(requiredRoofPlanDimensions(at("2012")).find((r) => r.kind === "ridgeSetback")?.inches, 36);
  for (const edition of ["2015", "2018", "2021"]) {
    const ridge = requiredRoofPlanDimensions(at(edition)).find((r) => r.kind === "ridgeSetback");
    assert.equal(ridge?.inches, 18, `IRC ${edition}`);
    assert.match(ridge!.source, /R324\.6\.2 \/ IFC 605\.11\.3\.2\.3 .*36 in where it covers more/);
  }
  const docs = plan('36" FIRE ACCESS PATHWAY. 12" SETBACK FROM RIDGE.');
  assert.equal(get(run(project({}), at("2012"), docs), BELOW)?.severity, "warning");
  assert.equal(get(run(project({}), at("2015"), docs), BELOW)?.severity, "warning", "12 in is under the 18 in floor");
  assert.equal(get(run(project({}), at("2015"), plan('36" FIRE ACCESS PATHWAY. 24" SETBACK FROM RIDGE.')), BELOW), undefined);
});
await check("MUST EXCLUDE: a ground mount is never measured for roof pathways", () => {
  const fs = run(project({ mounting: "Ground mount" }), withRule("verified"), plan('18" FIRE ACCESS PATHWAY'));
  assert.equal(get(fs, BELOW), undefined);
  assert.equal(get(fs, UNMEASURED), undefined);
});
await check("MUST PASS: through the whole report, the blocker survives dedupe and keeps its evidence", () => {
  const p = project({ planSetExtractedText: '18" FIRE ACCESS PATHWAY' });
  const f = buildReviewerReport(p, { codeContext: withRule("verified"), documentTexts: plan('18" FIRE ACCESS PATHWAY') }).findings.find((x) => x.id === BELOW);
  assert.equal(f?.severity, "blocker");
  assert.equal(f!.evidenceFound?.[0]?.excerpt, '18" FIRE ACCESS PATHWAY');
});
await check("MUST PASS: the AHJ placement-rules callout quotes what the plan states", () => {
  const ctx = buildCodeContext("OR", "City of Testport", profile({ fireSetbacks: [{ id: "placement-research:1", description: AHJ_RULE }] }));
  const p = project({ planSetExtractedText: '18" FIRE ACCESS PATHWAY' });
  const f = buildReviewerReport(p, { codeContext: ctx, documentTexts: plan('18" FIRE ACCESS PATHWAY') }).findings.find((x) => x.id === "reviewer.plan.ahj-placement-rules");
  assert.match(f?.message ?? "", /The plan states: "18" FIRE ACCESS PATHWAY" \(Plan set\)/);
});

console.log("\n3. THE FALLBACK — nothing readable");
await check("MUST PASS: pathway words, no dimension — an unmeasured callout quoting the plan, carrying the requirement", () => {
  const text = "PROVIDE FIRE ACCESS PATHWAYS PER AHJ. SEE ROOF PLAN.";
  const fs = run(project({ planSetExtractedText: text }), withRule("verified"), plan(text));
  const f = get(fs, UNMEASURED);
  assert.equal(f?.severity, "callout");
  assert.match(f!.message, /The plan says: "FIRE ACCESS PATHWAYS PER AHJ"/);
  assert.deepEqual(f!.roofPlanRequired?.map((r) => `${r.kind}=${r.inches}:${r.basis}`), ["pathwayWidth=36:ahj", "ridgeSetback=36:ahj"]);
  assert.equal(get(fs, MISSING), undefined, "the plan mentions fire access");
});
await check("MUST PASS: no pathway text and no dimension — pathways-missing stays, plus the unmeasured callout", () => {
  const fs = run(project({}), withRule("verified"), plan("PV-2 ROOF PLAN. MODULES 20 TOTAL."));
  assert.equal(get(fs, MISSING)?.severity, "blocker");
  assert.ok(get(fs, UNMEASURED));
});
await check("MUST PASS: a ridge-setback dimension with no 'fire' word — measured, so pathways-missing does not fire", () => {
  const fs = run(project({}), withRule("verified"), plan("3'-0\" SETBACK FROM RIDGE"));
  assert.equal(get(fs, MISSING), undefined);
  assert.equal(get(fs, BELOW), undefined);
});

console.log("\n4. MEASURED — vision may never relax it");
await check("MUST PASS: the id is in MEASURED_FINDING_IDS and visionMayRelax is false", () => {
  assert.ok(MEASURED_FINDING_IDS.has(BELOW));
  assert.equal(visionMayRelax({ id: BELOW, severity: "blocker", title: "Fire access pathway" } as unknown as ReviewerFinding), false);
});

console.log("\n5. THE ONE VISION MEASUREMENT (stubbed)");
const unmeasured = get(run(project({}), withRule("verified"), plan("FIRE ACCESS PATHWAYS PER AHJ")), UNMEASURED)!;
const verdict = (pathwayWidthIn: number | null, ridgeSetbackIn: number | null, confidence: "high" | "medium" | "low" = "high"): ReviewerVisionVerdict => ({
  checked: true, present: true, confidence, page: 2, observed: `${pathwayWidthIn}" PATHWAY`, note: "", measured: { pathwayWidthIn, ridgeSetbackIn },
});
await check("MUST PASS: a measured 18 in pathway vs the verified 36 in rule — a WARNING, never a blocker", () => {
  const f = applyRoofPlanMeasurement(unmeasured, verdict(18, 36));
  assert.equal(f.id, BELOW);
  assert.equal(f.severity, "warning");
  assert.match(f.message, /read from the sheet image by vision/);
  assert.equal(f.evidenceFound?.[0]?.verifier, "vision");
});
await check("MUST EXCLUDE: a measurement that meets the rule, or a low-confidence one, leaves the callout", () => {
  assert.equal(applyRoofPlanMeasurement(unmeasured, verdict(36, 36)).severity, "callout");
  assert.equal(applyRoofPlanMeasurement(unmeasured, verdict(18, 36, "low")).id, UNMEASURED);
});

const db = await openDatabase();
const client = createClient(db, { companyName: "Fire Pathway Test Solar", ccbLicenseNumber: "000000" });
const created = createProject(db, { clientId: client.id, owner: "Synthetic Owner", street: "1 Test St", city: "Testport", state: "OR", ahj: "City of Testport", utility: "Test Power", dcKw: "6", acKw: "5" }).project;
// A synthetic one-page roof plan whose TEXT states no dimension (the text rule cannot measure it).
const pdf = await PDFDocument.create();
const page = pdf.addPage([612, 792]);
page.drawText("PV-2 ROOF PLAN - FIRE ACCESS PATHWAYS PER AHJ", { x: 40, y: 740, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
const pdfPath = path.join(tmpDir, "plan-set.pdf");
fs.writeFileSync(pdfPath, await pdf.save());
db.run(
  `INSERT INTO project_documents (id, project_id, doc_type, original_filename, stored_path, content_type, source, uploaded_at)
   VALUES (?, ?, 'plan_set', 'plan-set.pdf', ?, 'application/pdf', 'upload', ?)`,
  [`${created.id}-plan`, created.id, pdfPath, new Date().toISOString()],
);
// The other plan-topic findings get their ordinary "is it on the sheet?" call (answered "not
// present", so nothing relaxes); only the measurement prompt is counted.
console.log("\n6. THE TWO-LAYER PROFILE — whose fireSetbacks, verified by whom");
{
  const { saveVerifiedCodeProfile, saveResearchedCodeProfile, resolveEffectiveCodeContext } = await import("../src/codeProfiles");
  const row = (ahj: string, fireSetbacks: JurisdictionCodeProfile["fireSetbacks"]): JurisdictionCodeProfile => ({
    key: "", state: "WY", ahj, confidence: "seeded", adoptedCodes: [{ code: "IRC", edition: "2021" }],
    amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks, citations: [], updatedAt: "",
  });
  saveVerifiedCodeProfile(db, row("", [{ id: "state-fire", description: "Minimum 36-inch fire access pathways." }]), "operator");
  saveResearchedCodeProfile(db, row("Town of Seededburg", [{ id: "city-fire", description: "Minimum 36-inch fire access pathways." }]));
  saveResearchedCodeProfile(db, row("Town of Inheritville", []));
  const pathway = (ahj: string) => requiredRoofPlanDimensions(resolveEffectiveCodeContext(db, "WY", ahj)).find((r) => r.kind === "pathwayWidth")!;
  await check("MUST PASS: a seeded city's own rules under a verified state row do not read as verified (no blocker)", () => {
    const req = pathway("Town of Seededburg");
    assert.equal(req.basis, "ahj");
    assert.equal(req.verified, false);
    const f = get(run(project({}, { state: "WY", ahj: "Town of Seededburg" } as Partial<ProjectRecord>), resolveEffectiveCodeContext(db, "WY", "Town of Seededburg"), plan('18" FIRE ACCESS PATHWAY')), BELOW);
    assert.equal(f?.severity, "warning");
  });
  await check("MUST PASS: a seeded city with no rules of its own inherits the verified state's — verified", () => {
    const req = pathway("Town of Inheritville");
    assert.equal(req.basis, "ahj");
    assert.equal(req.verified, true, "the merged row reads seeded; the field's own layer is the verified state row");
  });
}

let calls = 0;
let allCalls = 0;
const fakeLlm = {
  async visionExtract(input: { prompt: string }): Promise<Record<string, unknown>> {
    allCalls++;
    if (!/Read the DIMENSIONS/.test(input.prompt)) return { present: false, confidence: "low", observed: "", missing: "" };
    calls++;
    return { pathwayWidthIn: 18, ridgeSetbackIn: 36, confidence: "high", observed: '18" FIRE ACCESS PATHWAY on PV-2' };
  },
} as unknown as LLMProvider;
const report = buildReviewerReport(
  { ...project({ planSetExtractedText: "PV-2 ROOF PLAN - FIRE ACCESS PATHWAYS PER AHJ" }), id: created.id } as ProjectRecord,
  { codeContext: withRule("verified"), documentTexts: plan("PV-2 ROOF PLAN - FIRE ACCESS PATHWAYS PER AHJ") },
);
await check("control: the text-only report carries the unmeasured callout, no measured finding", () => {
  assert.ok(report.findings.some((f) => f.id === UNMEASURED));
  assert.ok(!report.findings.some((f) => f.id === BELOW));
});
await check("MUST PASS: cacheOnly with an empty cache — no call, the report unchanged", async () => {
  const out = await applyVisionToReviewerReport(db, fakeLlm, report, { cacheOnly: true });
  assert.equal(calls, 0);
  assert.ok(out.findings.some((f) => f.id === UNMEASURED));
});
await check("MUST PASS: the vision pass makes ONE measurement and reports the short pathway as a warning", async () => {
  const out = await applyVisionToReviewerReport(db, fakeLlm, report);
  assert.equal(calls, 1, "exactly one vision call for the measurement");
  assert.ok(allCalls <= 8, `${allCalls} vision calls in one pass — over MAX_VISION_CHECKS (8)`);
  const f = out.findings.find((x) => x.id === BELOW);
  assert.equal(f?.severity, "warning");
  assert.equal(f!.visionVerification?.measured?.pathwayWidthIn, 18);
  assert.ok(!out.findings.some((x) => x.id === UNMEASURED));
});
await check("MUST PASS: cached — cacheOnly and the submit gate's synchronous read both apply it with no call", async () => {
  const again = await applyVisionToReviewerReport(db, fakeLlm, report, { cacheOnly: true });
  assert.equal(again.findings.find((x) => x.id === BELOW)?.severity, "warning");
  assert.equal(applyCachedVisionVerdicts(db, report).findings.find((x) => x.id === BELOW)?.severity, "warning");
  assert.equal(calls, 1);
});

if (failures) {
  console.error(`\n${failures} fire pathway check(s) FAILED`);
  process.exit(1);
}
console.log("\nall fire pathway checks passed");
