// VISION ANSWERS "IS IT ON THE SHEET?" — AND THAT IS THE WRONG QUESTION FOR A MEASURED FAILURE.
//
// The vision pass exists to relax findings the PARSER missed: the text extraction did not find
// the fire pathway note, vision looks at the page, the note is there, the warning relaxes. That
// is sound. But it applied to every plan-topic finding, and topicForFinding maps
// city.elec.load-side-over-120 to "sld" (its title contains "load-side"), so a high-confidence
// "the SLD is on the sheet" verdict downgraded a MEASURED NEC 705.12 violation — 200A main +
// 50A PV on a 200A bus, 250A against a 240A allowance — from blocker to a non-blocking callout
// reading "Vision-verified on the plan set".
//
// Vision confirmed the calculation is PRESENT. It never said the calculation PASSES. Those are
// different claims, and only the first is something a picture can answer.
// Run: tsx backend/test/visionRelaxScope.test.ts
import assert from "node:assert/strict";
import type { ProjectRecord } from "../../shared/src/types";
import { buildReviewerReport } from "../src/reviewerEngine";
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
    planSetExtractedText: '36" FIRE ACCESS PATHWAY. 705.12 BUSBAR CALC ON PV-4. ATTACHMENT DETAIL: LAG SCREW.',
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
]) {
  const p = mk(variant as Record<string, string>);
  if ("interco" in variant) (p as unknown as { interconnectionMethod: string }).interconnectionMethod = String((variant as Record<string, string>).interco);
  for (const f of buildReviewerReport(p).findings) allProducibleIds.add(f.id);
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
  const f = buildReviewerReport(mk()).findings.find((x) => x.id === "city.elec.load-side-over-120");
  assert.ok(f, "the control fixture does not raise the violation — the test proves nothing");
  assert.equal(f!.severity, "blocker");
  assert.ok(/250A|200A main/.test(f!.message), `unexpected message: ${f!.message}`);
});

console.log(failures === 0
  ? "\nAll vision-relaxation scope checks passed."
  : `\n${failures} vision-relaxation scope check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
