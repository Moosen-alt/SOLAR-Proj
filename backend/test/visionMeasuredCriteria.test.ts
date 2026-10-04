// DESIGN-CRITERIA FINDINGS ARE MEASURED — THE VISION PASS MAY NEVER SOFTEN THEM.
//
// reviewerVision relaxes a warning/blocker whose id/title maps to a plan topic once a sheet image
// merely SHOWS the topic. The design-criteria findings compare VALUES (plan 110 mph vs letter
// 95 mph; 16 psf vs the jurisdiction's 36; 48" o.c. vs 24"); a picture of a wind-speed note
// cannot say the value is right. Until now they were kept out of vision only because their
// titles happened not to contain "wind"/"snow"/"attachment" — one rename away from a real
// conflict being downgraded to "Vision-verified on the plan set".
//
// The ids are listed EXPLICITLY here (not read back from the set), so removing one from
// MEASURED_FINDING_IDS fails this test; and each is produced by the engine, so a rename fails it.
//
// Run: npx tsx backend/test/visionMeasuredCriteria.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { JurisdictionCodeProfile, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { buildCodeContext } from "../src/codeProfiles";
import { buildReviewerReport, topicForFinding } from "../src/reviewerEngine";
import { visionMayRelax } from "../src/reviewerVision";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const MEASURED = [
  "city.struct.design-criteria-conflict",
  "city.struct.design-criteria-below-ahj",
  "city.struct.design-criteria-unknown",
  "city.code.basis-mismatch",
  "city.struct.ground-snow-below-state-minimum",
  "city.struct.anchor-spacing-exceeds-ahj",
  "city.plan.ul-listings-missing",
  "city.struct.wind-exceeds-prescriptive-cap",
  "city.fire.pathway-below-required",
];

const PLAN = "GROUND SNOW LOAD = 20 PSF WIND SPEED = 110 MPH EXPOSURE CATEGORY = C GOVERNING CODES: 2023 ORSC 2023 OESC (NEC 2020) NEW PV ATTACHMENTS AT 4'-0\" O.C.";
const LETTER = "Design wind speed, Vult: 95 mph (3-sec gust) Ground snow load, Pg : 28 psf";
const project: ProjectRecord = {
  id: "vision-measured", state: "OR", ahj: "City of Testport", utility: "Test Power",
  homeownerName: "Test Owner", projectAddress: "1 Test St", interconnectionMethod: "Load-side breaker",
  parserSnapshot: { mounting: "Roof mount", planSetExtractedText: `${PLAN}\n${LETTER}` },
} as unknown as ProjectRecord;
const profile = (over: Partial<JurisdictionCodeProfile>): JurisdictionCodeProfile => ({
  key: "or|city of testport|unknown", state: "OR", ahj: "City of Testport", confidence: "verified", verifiedBy: "operator",
  adoptedCodes: [{ code: "ORSC", edition: "2023" }, { code: "OESC", edition: "2023" }, { code: "NEC", edition: "2023" }],
  amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  ...over,
});
const docs = [{ label: "Plan set", text: PLAN }, { label: "Structural letter", text: LETTER }];
const produced: ReviewerFinding[] = [
  ...buildReviewerReport(project, { codeContext: buildCodeContext("OR", "City of Testport", profile({ designCriteria: { windSpeedMph: 120, groundSnowLoadPsf: 36 }, prescriptive: { maxAttachmentSpacingIn: 24, minGroundSnowPsfPrescriptive: 36, minGroundSnowPsfEngineered: 25 } })), documentTexts: docs }).findings,
  ...buildReviewerReport(project, { codeContext: buildCodeContext("OR", "City of Testport", profile({})), documentTexts: docs }).findings,
  // On the prescriptive path, the plan's 110 mph in Exposure C is above a 100 mph Exposure C cap.
  ...buildReviewerReport({ ...project, parserSnapshot: { ...project.parserSnapshot, permitPath: "Prescriptive" } } as unknown as ProjectRecord, { codeContext: buildCodeContext("OR", "City of Testport", profile({ prescriptive: { maxWindSpeedMphExpC: 100 } })), documentTexts: docs }).findings,
  // An 18" pathway against the jurisdiction's 36" (issue #142).
  ...buildReviewerReport(project, { codeContext: buildCodeContext("OR", "City of Testport", profile({ fireSetbacks: [{ id: "fire-1", description: "Minimum 36-inch fire access pathways." }] })), documentTexts: [{ label: "Plan set", text: '18" FIRE ACCESS PATHWAY' }] }).findings,
];

for (const id of MEASURED) {
  check(`MUST PASS: ${id} is produced by the engine (the protection is not decorative)`, () => {
    assert.ok(produced.some((f) => f.id === id), `${id} not produced — renamed? the guard would protect nothing`);
  });
  check(`MUST PASS: vision may not relax ${id}, even with a plan-topic title`, () => {
    const f = { id, severity: "blocker", title: "Wind speed, snow load and attachment spacing" } as unknown as ReviewerFinding;
    // Without the guard this title WOULD reach vision: it maps to a plan topic.
    assert.ok(topicForFinding(f), "control: the title maps to a plan topic");
    assert.equal(visionMayRelax(f), false);
  });
}

check("MUST EXCLUDE: an absence finding with the same title stays relaxable — that is what vision is FOR", () => {
  const f = { id: "city.struct.loads-missing", severity: "blocker", title: "Wind speed, snow load and attachment spacing" } as unknown as ReviewerFinding;
  assert.equal(visionMayRelax(f), true);
});

if (failures) {
  console.error(`\n${failures} vision measured-criteria check(s) FAILED`);
  process.exit(1);
}
console.log("\nall vision measured-criteria checks passed");
