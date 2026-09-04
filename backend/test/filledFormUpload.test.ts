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
// A third naming of the same documents arrived later: the KB's required_documents prose,
// which documentInventory reads to surface the application/checklist a jurisdiction wants
// attached. This test pins the AGREEMENT between all three, since their drifting apart —
// in any direction — is the actual defect.
// Browser-free. Run: tsx backend/test/filledFormUpload.test.ts
import assert from "node:assert/strict";
import { classifyFormType } from "../src/ahjFormAuto";
import { KB_APPLICATION_DOC_PATTERNS, kbApplicationDocItems } from "../src/requiredDocuments";
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

// ---------------------------------------------------------------------------
// THE THIRD VOCABULARY: what the KB says a jurisdiction requires.
//
// documentInventory now surfaces the filled application/checklist a jurisdiction asks for,
// read from the KB's required_documents prose. That prose is a third naming of the same
// documents, alongside the stored form's filename and the portal's slot label. If it drifts,
// the inventory demands a document under a name no upload slot will ever match — the same
// silent dead end, arrived at from the other direction.
// ---------------------------------------------------------------------------
const KB_REQUIREMENTS: Array<{ text: string; expect: string }> = [
  // Verbatim from or|city of coos bay|pacific power.
  { text: "Building/structural permit application", expect: "building_application" },
  { text: "Renewable Energy (electrical) permit application", expect: "electrical_application" },
  { text: "Electrical permit application", expect: "electrical_application" },
  { text: "Solar prescriptive checklist", expect: "solar_checklist" },
  // Verbatim from the Portland profile — "electrical" and "application" four words apart.
  { text: "Electrical Renewable Energy Permit Application", expect: "electrical_application" },
  { text: "Solar worksheet / prescriptive path eligibility", expect: "solar_checklist" },
];

for (const r of KB_REQUIREMENTS) {
  check(`KB requirement "${r.text.slice(0, 46)}" maps to ${r.expect}`, () => {
    const items = kbApplicationDocItems([r.text]);
    assert.equal(items.length, 1, `expected one mapped document, got ${items.length}`);
    assert.equal(items[0].docType, r.expect);
  });
}

check("every docType the KB mapper can demand is one an upload slot can receive", () => {
  const reachable = new Set(UPLOAD_LABEL_PATTERNS.map((p) => p.docType));
  for (const p of KB_APPLICATION_DOC_PATTERNS) {
    assert.ok(reachable.has(p.docType),
      `the inventory can demand ${p.docType}, but no portal upload slot resolves to it`);
  }
});

check("KB items are ADVISORY — learned data must not block a complete filing", () => {
  for (const item of kbApplicationDocItems(KB_REQUIREMENTS.map((r) => r.text))) {
    assert.equal(item.blocking, false, `${item.docType} would block staging on learned data`);
  }
});

check("...and each quotes the jurisdiction's own words, so the claim is checkable", () => {
  const [item] = kbApplicationDocItems(["Building/structural permit application"]);
  assert.match(item.why, /Building\/structural permit application/);
});

check("a document the baseline already covers is not demanded twice", () => {
  const items = kbApplicationDocItems(["Building/structural permit application"], new Set(["building_application"]));
  assert.deepEqual(items, []);
});

check("A REBATE APPLICATION IS NOT THE FILING", () => {
  // Verbatim from an Illinois KB profile. An incentive application is a different document
  // from the permit application, and demanding it here would send the operator chasing the
  // wrong form — the same mistake as picking the rebate programme in ComEd's drawer.
  assert.deepEqual(kbApplicationDocItems(["Illinois Distributed Generation Rebate Application (Rider CGR)"]), []);
  assert.deepEqual(kbApplicationDocItems(["Solar Rebate Application form"]), []);
  assert.deepEqual(kbApplicationDocItems(["Incentive enrollment application"]), []);
});

check("KB prose that names no application/checklist is ignored", () => {
  // The rest of a KB list — plan set, meter photo, post-install sign-off — belongs to the
  // baseline or another lane. Surfacing it here would be noise.
  const items = kbApplicationDocItems(["Meter photo", "Complete plan set", "Site / plot plan", "Inspection and safety sign upload after install"]);
  assert.deepEqual(items.map((i) => i.docType), []);
});

if (failures) { console.error(`\n${failures} filled-form-upload check(s) FAILED.`); process.exit(1); }
console.log("\nAll filled-form-upload checks passed.");
process.exit(0);
