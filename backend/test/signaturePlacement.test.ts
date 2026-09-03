// A SIGNATURE STAYS ON ITS OWN LINE, AND A DATE NEVER LANDS IN A LICENCE FIELD.
//
// Two defects on a filled City of Portland Electrical Renewable Energy application, both
// visible on the operator's own copy:
//
//   1. "Print name: Charles Bitton   License no 09/03/2026" — the supervising electrician's
//      LICENCE NUMBER field contained today's DATE. That row carries Print name + License
//      no and no date line at all; the signature placement was writing its date at those
//      coordinates. A filed application asserting a date as a licence number is a defect a
//      reviewer will bounce, and it is the electrician's credential being misstated.
//
//   2. The signature ink spanned nearly two rows. Rows on this form are ~13-17pt apart, the
//      placement box was 22pt tall, and SIGNATURE_LIFT adds 6 more — so each signature was
//      drawn across the line above its own.
//
// This pins the registry entry itself: the shape of the placement, not the rendering.
// Browser-free. Run: tsx backend/test/signaturePlacement.test.ts
import assert from "node:assert/strict";
import { ahjFormRegistry } from "../src/ahjForms";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const portland = ahjFormRegistry.find((f) => /portland/i.test(f.id) && /electrical/i.test(f.id));

check("the Portland electrical form is in the registry", () => {
  assert.ok(portland, `not found among: ${ahjFormRegistry.map((f) => f.id).join(", ").slice(0, 200)}`);
});

if (portland) {
  const sigs = portland.signatureFields ?? [];
  const overlay = portland.overlayFields ?? [];
  const electrician = sigs.find((s) => s.role === "electrician");
  const applicant = sigs.find((s) => s.role === "applicant");

  check("THE REGRESSION: the electrician signature writes NO date — that row has no date line", () => {
    assert.ok(electrician, "electrician placement missing");
    assert.equal(electrician!.dateX, undefined, "a date here lands in the License no field");
    assert.equal(electrician!.dateY, undefined);
  });

  check("...and the electrician's License no is filled with an actual licence", () => {
    const lic = overlay.find((f) => f.source === "client.electricianLicenseNumber");
    assert.ok(lic, "no licence mapped to the electrician's License no field");
    // Same row as the electrician's printed name, to its right.
    const printed = overlay.find((f) => f.source === "computed.electricianSignerName");
    assert.ok(printed, "electrician print-name field missing");
    assert.equal(lic!.y, printed!.y, "License no shares the print-name row");
    assert.ok(lic!.x > printed!.x, "License no sits to the RIGHT of the printed name");
  });

  check("no signature box is taller than the form's row pitch", () => {
    // Rows here run 275 -> 237 -> 225 -> 212 -> 197 -> 189: the tightest gap is 8pt, and a
    // 22pt box plus a 6pt lift crossed two of them. Cap at the typical 13-17pt row.
    for (const s of sigs) {
      assert.ok((s.height ?? 0) <= 14, `${s.role} box is ${s.height}pt — it will cross the row above`);
      assert.ok((s.height ?? 0) > 0, `${s.role} needs a real height`);
    }
  });

  check("the applicant signature DOES still date its own line", () => {
    assert.ok(applicant, "applicant placement missing");
    // The Authorized-signature row genuinely has "Date:" — that one is correct and stays.
    assert.ok(Number.isFinite(applicant!.dateX) && Number.isFinite(applicant!.dateY));
  });

  check("the two signatures do not overlap each other's rows", () => {
    assert.ok(electrician && applicant);
    const eBottom = electrician!.y;
    const aTop = applicant!.y + (applicant!.height ?? 0);
    assert.ok(aTop <= eBottom, `applicant ink reaches ${aTop} but the electrician line starts at ${eBottom}`);
  });
}

if (failures) { console.error(`\n${failures} signature-placement check(s) FAILED.`); process.exit(1); }
console.log("\nAll signature-placement checks passed.");
process.exit(0);
