// A SIGNATURE GOES ON ITS OWN RULE, AT THE SIZE THE ROW ALLOWS.
//
// Defects seen on filled City of Portland Electrical Renewable Energy applications, each
// found by rendering the real output rather than reading the coordinates:
//
//   1. "Print name: Charles Bitton   License no 09/03/2026" — the supervising electrician's
//      LICENCE field contained today's DATE, because the signature placement was writing its
//      date at those coordinates. That row carries Print name + License no and no date line.
//
//   2. The electrician's signature sat on the words "Supervising electrician" instead of the
//      "Signature, required:" rule beneath them. The ink was 12pt tall and the lift added 6
//      more ON TOP, so a placement declaring 12 actually occupied 18 — and the form's own
//      text layer puts those two lines just 9pt apart.
//
//   3. "Charles Bitton" appeared TWICE: once beside "Print name:" and again in the blank
//      strip below it, from a second overlay resolving to the same person. The licence
//      number sat on that same phantom row, nowhere near its "License no." label.
//
//   4. Both signatures rendered about a third of their intended width. The stored PNGs are
//      57% and 68% empty margin, so scaling the whole canvas into a short row shrank the ink
//      to a mark. Cropping to the ink first yields ~45% more signature at the same height.
//
// The coordinates asserted here are measured from the form's OWN text layer (pdf.js
// baselines), not estimated:
//
//      248.7  "Supervising electrician"
//      239.7  "Signature, required:"          <- the electrician's rule
//      224.7  "Print name:"  |  256.4 "License no."
//      204.3  "Authorized signature:"         <- the applicant's rule
//      189.3  "Print name:"  |  251.7 "Date:"
//
// Browser-free. Run: tsx backend/test/signaturePlacement.test.ts
import assert from "node:assert/strict";
import { ahjFormRegistry } from "../src/ahjForms";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// The form's real label baselines, from its text layer.
const RULE_ELECTRICIAN = 239.7;
const LABEL_ABOVE_ELECTRICIAN = 248.7;   // "Supervising electrician"
const ROW_PRINT_NAME = 224.7;
const LABEL_LICENSE_NO_X = 256.4;
const RULE_APPLICANT = 204.3;

const portland = ahjFormRegistry.find((f) => /portland/i.test(f.id) && /electrical/i.test(f.id));

check("the Portland electrical form is in the registry", () => {
  assert.ok(portland, `not found among: ${ahjFormRegistry.map((f) => f.id).join(", ").slice(0, 200)}`);
});

if (portland) {
  const sigs = portland.signatureFields ?? [];
  const overlay = portland.overlayFields ?? [];
  const electrician = sigs.find((s) => s.role === "electrician");
  const applicant = sigs.find((s) => s.role === "applicant");

  // -------------------------------------------------------------------------
  // 1. No date in the licence field.
  // -------------------------------------------------------------------------
  check("the electrician signature writes NO date — that row has no date line", () => {
    assert.ok(electrician, "electrician placement missing");
    assert.equal(electrician!.dateX, undefined, "a date here lands in the License no field");
    assert.equal(electrician!.dateY, undefined);
  });

  check("the applicant signature DOES date its own line, which really has one", () => {
    assert.ok(applicant);
    assert.ok(Number.isFinite(applicant!.dateX) && Number.isFinite(applicant!.dateY));
  });

  // -------------------------------------------------------------------------
  // 2. Each signature sits on its own rule, within the room that rule has.
  // -------------------------------------------------------------------------
  check("THE REGRESSION: the electrician signature anchors on 'Signature, required:'", () => {
    // Not on "Supervising electrician" nine points above it.
    assert.ok(Math.abs(electrician!.y - RULE_ELECTRICIAN) <= 2,
      `y=${electrician!.y} is not on the rule at ${RULE_ELECTRICIAN}`);
  });

  check("...and fits in the 9pt the form gives that row, lift included", () => {
    // height is the ENVELOPE: the renderer takes the lift out of this budget, so the
    // declared height is the space the signature really occupies.
    const room = LABEL_ABOVE_ELECTRICIAN - RULE_ELECTRICIAN;
    assert.ok(electrician!.height <= room,
      `height ${electrician!.height} exceeds the ${room}pt between the rule and the label above it`);
  });

  check("the applicant signature anchors on 'Authorized signature:'", () => {
    assert.ok(Math.abs(applicant!.y - RULE_APPLICANT) <= 2, `y=${applicant!.y} is not on the rule at ${RULE_APPLICANT}`);
  });

  check("...and fits under the Print name row above it", () => {
    const room = ROW_PRINT_NAME - RULE_APPLICANT;
    assert.ok(applicant!.height <= room, `height ${applicant!.height} exceeds the ${room}pt of clear space`);
  });

  check("the roomier row carries the larger signature — size follows the form, not a constant", () => {
    assert.ok(applicant!.height > electrician!.height,
      "the applicant's rule has ~20pt and the electrician's ~9pt; the placements should reflect that");
  });

  check("the two signatures never reach into each other's rows", () => {
    const applicantTop = applicant!.y + applicant!.height;
    assert.ok(applicantTop <= electrician!.y,
      `applicant ink reaches ${applicantTop} but the electrician's rule is at ${electrician!.y}`);
  });

  // -------------------------------------------------------------------------
  // 3. One printed name, and a licence beside its own label.
  // -------------------------------------------------------------------------
  check("THE DUPLICATE: the electrician is printed exactly ONCE", () => {
    const nameFields = overlay.filter((f) => /electricalSupervisorName|electricianSignerName/.test(String(f.source)));
    assert.equal(nameFields.length, 1,
      `${nameFields.length} overlays print the electrician's name: ${nameFields.map((f) => `${f.source}@y${f.y}`).join(", ")}`);
  });

  check("...on the real Print name row", () => {
    const printed = overlay.find((f) => /electricalSupervisorName/.test(String(f.source)));
    assert.ok(printed, "electrician print-name overlay missing");
    assert.ok(Math.abs(printed!.y - ROW_PRINT_NAME) <= 2, `y=${printed!.y}, expected the row at ${ROW_PRINT_NAME}`);
  });

  check("the licence sits on that same row, clear of the 'License no.' label", () => {
    const lic = overlay.find((f) => f.source === "client.electricianLicenseNumber");
    const printed = overlay.find((f) => /electricalSupervisorName/.test(String(f.source)));
    assert.ok(lic, "no licence mapped to the electrician's License no field");
    assert.equal(lic!.y, printed!.y, "the licence belongs on the print-name row");
    assert.ok(lic!.x > LABEL_LICENSE_NO_X + 40,
      `x=${lic!.x} collides with the "License no." label that starts at ${LABEL_LICENSE_NO_X}`);
  });

  // -------------------------------------------------------------------------
  // 4. Every placement is well-formed.
  // -------------------------------------------------------------------------
  check("every signature placement declares a real box", () => {
    for (const s of sigs) {
      assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y), `${s.role} has non-finite coordinates`);
      assert.ok((s.height ?? 0) > 0 && (s.width ?? 0) > 0, `${s.role} needs a real width and height`);
    }
  });
}

// -------------------------------------------------------------------------
// Registry-wide: the envelope rule is not a Portland special case.
// -------------------------------------------------------------------------
check("no form in the registry declares an implausibly tall signature box", () => {
  for (const form of ahjFormRegistry) {
    for (const s of form.signatureFields ?? []) {
      assert.ok((s.height ?? 0) <= 40,
        `${form.id}/${s.role} declares height ${s.height} — that is taller than any signature row on a permit form`);
    }
  }
});

if (failures) { console.error(`\n${failures} signature-placement check(s) FAILED.`); process.exit(1); }
console.log("\nAll signature-placement checks passed.");
process.exit(0);
