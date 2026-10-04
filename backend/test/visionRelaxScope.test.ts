// VISION ANSWERS "IS IT ON THE SHEET?" — AND THAT IS THE WRONG QUESTION FOR A MEASURED FAILURE.
//
// The vision pass exists to relax findings the PARSER missed: the text extraction did not find
// the fire pathway note, vision looks at the page, the note is there, the warning relaxes. That
// is sound. But it applied to every plan-topic finding, and topicForFinding maps
// city.elec.load-side-over-120 to "sld" (its title contains "load-side"), so a high-confidence
// "the SLD is on the sheet" verdict downgraded a MEASURED NEC 705.12 violation — 200A main +
// 50A PV on a 200A bus, 250A against a 240A allowance — from blocker to a non-blocking callout
// reading "Vision-verified on the plan set". (That rule is retired; the busbar arithmetic is
// city.elec.sizing-busbar-120 since #153, and the same protection holds for it.)
//
// Vision confirmed the calculation is PRESENT. It never said the calculation PASSES. Those are
// different claims, and only the first is something a picture can answer.
// Run: tsx backend/test/visionRelaxScope.test.ts
import assert from "node:assert/strict";
import type { ProjectRecord } from "../../shared/src/types";
import { buildReviewerReport } from "../src/reviewerEngine";
import { buildCodeContext } from "../src/codeProfiles";
import { visionMayRelax, MEASURED_FINDING_IDS } from "../src/reviewerVision";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const mk = (over: Record<string, string> = {}): ProjectRecord => ({
  id: "vrs", clientId: "c", homeownerName: "Vision Scope", projectAddress: "1 Bus Bar Way",
  city: "Coos Bay", state: "OR", zip: "97420", ahj: "City of Coos Bay",
  utility: "Pacific Power", accountNumber: "1234567890", meterNumber: "987654",
  systemSizeDcKw: 9, systemSizeAcKw: 7.6, interconnectionMethod: "Load-side breaker",
  status: "pending",
  parserSnapshot: {
    state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power",
    mounting: "Roof mount", interco: "Load-side breaker",
    busRating: "200A", mainBreaker: "200A", pvBreaker: "50",
    planSetExtractedText: '36" FIRE ACCESS PATHWAY. 705.12 BUSBAR CALC ON PV-4: BUS RATING 200A, MAIN BREAKER 200A, PV BREAKER 50A. ATTACHMENT DETAIL: LAG SCREW.',
    ...over,
  },
} as unknown as ProjectRecord);

console.log("\n1. A MEASURED FAILURE IS NOT RELAXABLE BY A PICTURE");
for (const id of [...MEASURED_FINDING_IDS]) {
  check(`MUST PASS: vision may not relax ${id}`, () => {
    assert.equal(visionMayRelax({ id, severity: "blocker", title: "" } as never), false,
      `${id} reports a measured result; a photo of the sheet cannot overturn arithmetic`);
  });
}

console.log("\n2. THE PROTECTED SET IS NOT DEAD WEIGHT");
// A hardcoded id set rots silently when a rule is renamed. Every id in it must still be
// producible by the engine, or the protection is decorative.
const allProducibleIds = new Set<string>();
for (const variant of [
  {},                                                                   // the 120% violation
  { moduleQty: "40", moduleWattage: "400" },                            // DC cross-check mismatch
  { interco: "Load-side breaker or supply-side tap" },                  // ambiguous
  { interco: "Net Metering" },                                          // unclassified
  // Electrical sizing (#144): busbar on the 48 A inverter current (no breaker), 690.7 string Voc,
  // inputs missing (no conductor) …
  { pvBreaker: "", invMake: "Synthetic", invModel: "SI-1", invOutputW: "48", moduleVoc: "49.5", siteLowTempC: "-10", modulesPerString: "14" },
  // … OCPD under 1.25 x 24.2 A, over #14's ampacity, and a 150 ft run's voltage drop.
  { pvBreaker: "25", pvMicroMake: "Enphase", pvMicroModel: "IQ8M", pvMicroQty: "20", pvMicroOutputW: "1.21", acConductor: "#14 AWG THWN-2 CU", acRunLengthFt: "150" },
]) {
  const p = mk(variant as Record<string, string>);
  if ("interco" in variant) (p as unknown as { interconnectionMethod: string }).interconnectionMethod = String((variant as Record<string, string>).interco);
  for (const f of buildReviewerReport(p).findings) allProducibleIds.add(f.id);
}
// The design-criteria / code-basis / listings / anchor-spacing findings need the jurisdiction
// context (and, for a two-document conflict, per-document text) — the production path passes both.
{
  const plan = "GROUND SNOW LOAD = 20 PSF WIND SPEED = 110 MPH GOVERNING CODES: 2023 OESC (NEC 2020) NEW PV ATTACHMENTS AT 4'-0\" O.C.";
  const letter = "Design wind speed, Vult: 95 mph Ground snow load, Pg : 28 psf";
  const p = mk({ planSetExtractedText: `${plan}
${letter}` });
  const base = { key: "or|city of coos bay|unknown", state: "OR", ahj: "City of Coos Bay", confidence: "verified" as const, adoptedCodes: [{ code: "OESC", edition: "2023" }, { code: "NEC", edition: "2023" }], amendments: [], fireSetbacks: [], citations: [], updatedAt: "" };
  // The state minimum ground snow load (ORSC 2023 R301.2.3.1: 36 / 25 psf) produces the
  // ground-snow-below-state-minimum finding against the plan's 20 psf.
  for (const over of [{ designCriteria: { windSpeedMph: 120, groundSnowLoadPsf: 36 }, prescriptive: { maxAttachmentSpacingIn: 24, minGroundSnowPsfPrescriptive: 36, minGroundSnowPsfEngineered: 25 } }, { designCriteria: {}, prescriptive: {} }]) {
    const codeContext = buildCodeContext("OR", "City of Coos Bay", { ...base, ...over });
    for (const f of buildReviewerReport(p, { codeContext, documentTexts: [{ label: "Plan set", text: plan }, { label: "Structural letter", text: letter }] }).findings) allProducibleIds.add(f.id);
  }
  // No editions on file (model-code defaults): the plan's code basis gets the unverified callout.
  for (const f of buildReviewerReport(p, { codeContext: buildCodeContext("OR", "City of Coos Bay", null), documentTexts: [{ label: "Plan set", text: plan }] }).findings) allProducibleIds.add(f.id);
  // On the prescriptive path, a stated 110 mph Exposure C over a 100 mph Exposure C cap (issue #111).
  const capped = mk({ permitPath: "Prescriptive", planSetExtractedText: "WIND SPEED = 110 MPH EXPOSURE CATEGORY = C" });
  // An 18" pathway against the jurisdiction's 36" fire access rule (issue #142).
  for (const f of buildReviewerReport(mk({ planSetExtractedText: '18" FIRE ACCESS PATHWAY' }), { codeContext: buildCodeContext("OR", "City of Coos Bay", { ...base, designCriteria: {}, prescriptive: {}, fireSetbacks: [{ id: "fire-1", description: "Minimum 36-inch fire access pathways." }] }), documentTexts: [{ label: "Plan set", text: '18" FIRE ACCESS PATHWAY' }] }).findings) allProducibleIds.add(f.id);
  for (const f of buildReviewerReport(capped, { codeContext: buildCodeContext("OR", "City of Coos Bay", { ...base, designCriteria: {}, prescriptive: { maxWindSpeedMphExpC: 100 } }), documentTexts: [{ label: "Plan set", text: "WIND SPEED = 110 MPH EXPOSURE CATEGORY = C" }] }).findings) allProducibleIds.add(f.id);
  // An attachment unlike the one an issued permit here carried, where the AHJ has corrected attachments (#147).
  const precedentCtx = {
    ...buildCodeContext("OR", "City of Coos Bay", null, [{ projectId: "issued-1", recordNumber: "", issuedAt: "2026-05-01", criteria: [], precedents: [{ dimension: "attachment" as const, value: "Footco FlashFoot 2" }] }]),
    ahjCorrections: [{ signature: "s", bucket: "B_designer_fix" as const, rootCause: "Attachment detail not per listing", requiredAction: "", count: 1, lastSeenAt: "2026-06-01" }],
  };
  for (const f of buildReviewerReport(mk({ attachmentHardware: "Otherco Mount Z" }), { codeContext: precedentCtx }).findings) allProducibleIds.add(f.id);
}
for (const id of [...MEASURED_FINDING_IDS]) {
  check(`MUST PASS: ${id} is still a real finding this engine emits`, () => {
    assert.ok(allProducibleIds.has(id),
      `${id} is protected from vision but no longer produced — the id was renamed and the guard now protects nothing`);
  });
}

console.log("\n3. THE ABSENCE FINDINGS STAY RELAXABLE — that is what vision is FOR");
for (const id of [
  "city.fire.pathways-missing",
  "city.struct.framing-missing",
  "city.struct.attachment-detail-missing",
  "city.plan.sld-missing",
  "reviewer.plan.fire-path",
]) {
  check(`MUST EXCLUDE: vision may still relax ${id}`, () => {
    assert.equal(visionMayRelax({ id, severity: "blocker", title: "" } as never), true,
      `${id} says evidence was not FOUND — exactly the claim a look at the page can settle`);
  });
}

console.log("\n4. THE VIOLATION THIS PROTECTS IS REAL");
check("the fixture genuinely breaches the 120% screen", () => {
  const f = buildReviewerReport(mk()).findings.find((x) => x.id === "city.elec.sizing-busbar-120");
  assert.ok(f, "the control fixture does not raise the violation — the test proves nothing");
  assert.equal(f!.severity, "blocker");
  assert.ok(/= 250 A, above 120 % of the 200 A busbar/.test(f!.message), `unexpected message: ${f!.message}`);
});

console.log(failures === 0
  ? "\nAll vision-relaxation scope checks passed."
  : `\n${failures} vision-relaxation scope check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
