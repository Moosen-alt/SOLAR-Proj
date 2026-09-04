// THE FILLED APPLICATION HAS TO REACH THE PORTAL SLOT THAT ASKS FOR IT.
//
// Coos Bay files on Oregon ePermitting (Accela), and its Accela config offers attachment
// slots for the building permit application and the solar checklist as well as the plan set.
// The KB has known this all along — its required_documents list names "Building/structural
// permit application", "Solar prescriptive checklist" and "Renewable Energy (electrical)
// permit application". The replay adapter has known it too: UPLOAD_LABEL_PATTERNS has
// matched those slot labels since it was written, with a comment saying the filled forms are
// overlaid into docsByType for exactly this purpose.
//
// And yet only the plan set was ever uploaded, because the path between the two halves was
// broken in two places:
//
//   1. The filled forms live outside the document store (backend/data/filled/), and were
//      merged into docsByType only on the LEARN path. On replay — which is every run after
//      an AHJ is learned — the sweep looked up docsByType["building_application"], found
//      nothing, and skipped the slot silently.
//
//   2. Coos Bay's stored template is literally named "Building Permit Application.pdf" but
//      carried form_type "permit_application", because callers pass a formType inferred from
//      why they went looking rather than from the form itself. The slot label resolves to
//      "building_application". Two vocabularies for one document, one letter apart, never
//      meeting.
//
// This test pins the AGREEMENT between the two vocabularies, which is the thing that drifted.
// Browser-free. Run: tsx backend/test/filledFormUpload.test.ts
import assert from "node:assert/strict";
import { classifyFormType } from "../src/ahjFormAuto";
import { UPLOAD_LABEL_PATTERNS } from "../../portal-bot/src/adapters/autoLearnAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

/** What docType the replay sweep resolves a portal's upload-slot label to. */
const slotDocType = (label: string): string | null =>
  UPLOAD_LABEL_PATTERNS.find((p) => p.re.test(label))?.docType ?? null;

// Real documents, named the way the AHJ names them.
const CASES: Array<{ file: string; slot: string; expect: string }> = [
  // The live one: Coos Bay's stored template, and the Accela slot that wants it.
  { file: "Building Permit Application.pdf", slot: "Building Permit Application", expect: "building_application" },
  { file: "Structural Permit Application.pdf", slot: "Structural permit application", expect: "building_application" },
  { file: "Electrical Permit Application.pdf", slot: "Electrical Permit Application", expect: "electrical_application" },
  { file: "Renewable Energy Electrical Permit Application.pdf", slot: "Electrical permit application", expect: "electrical_application" },
  { file: "Solar Prescriptive Checklist.pdf", slot: "Solar prescriptive checklist", expect: "solar_checklist" },
  { file: "Rooftop PV Eligibility Worksheet.pdf", slot: "Eligibility worksheet", expect: "solar_checklist" },
];

for (const c of CASES) {
  check(`"${c.file}" is classified ${c.expect}`, () => {
    // The fallback is the generic value a caller would otherwise impose; a specific name
    // must beat it, which is precisely what failed on Coos Bay.
    assert.equal(classifyFormType(c.file, "permit_application"), c.expect);
  });

  check(`...and the portal slot "${c.slot}" resolves to the same docType`, () => {
    assert.equal(slotDocType(c.slot), c.expect,
      `the stored form and the upload slot must agree, or the file is on disk and never attached`);
  });
}

check("THE REGRESSION: a generic caller no longer overrides a specific filename", () => {
  // This is the exact call that stored Coos Bay's building application as permit_application.
  assert.notEqual(classifyFormType("Building Permit Application.pdf", "permit_application"), "permit_application");
});

check("a form whose name says nothing keeps the caller's classification", () => {
  // The fallback still matters — an unnamed or oddly-named form should not be reclassified
  // into a slot it does not belong in.
  assert.equal(classifyFormType("form-2024-rev3.pdf", "permit_application"), "permit_application");
  assert.equal(classifyFormType("", "solar_checklist"), "solar_checklist");
});

check("every docType the classifier can emit is reachable from some slot label", () => {
  // If the classifier can produce a docType that no upload pattern ever yields, a filled
  // form of that type can never be attached to anything — a silent dead end.
  const emitted = ["solar_checklist", "electrical_application", "building_application"];
  const reachable = new Set(UPLOAD_LABEL_PATTERNS.map((p) => p.docType));
  for (const t of emitted) {
    assert.ok(reachable.has(t), `${t} is produced by classifyFormType but no upload slot resolves to it`);
  }
});

check("the generic application slot still exists as a catch-all", () => {
  // Portals that just say "Application" should still receive a filled application.
  assert.equal(slotDocType("Completed application"), "permit_application");
});

if (failures) { console.error(`\n${failures} filled-form-upload check(s) FAILED.`); process.exit(1); }
console.log("\nAll filled-form-upload checks passed.");
process.exit(0);
