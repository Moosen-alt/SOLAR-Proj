// WHICH PERMIT WE APPLY FOR IS NEVER CHOSEN BY ARRAY INDEX.
//
// The record-type checkbox is recorded with its label AND a positional fallback
// (cbListServices_1). The offered list differs per jurisdiction: Coos Bay's CITY record has
// no "Residential - Electrical" at all — that lives on the COUNTY record. On Placeholder the
// label matched nothing, the positional fallback fired, and index 1 on the city list is
// "Residential - Mechanical". A MECHANICAL permit was filed and ISSUED on a solar job at
// 5050 Placeholder Blvd, and its fees were paid.
//
// The label is the only thing that identifies a permit type. If the recorded type is not on
// offer, that is information — this jurisdiction files this discipline elsewhere — and the
// run must stop rather than approximate.
//   npx tsx portal-bot/src/adapters/recordType.test.ts
import assert from "node:assert/strict";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// The detector as executeStep applies it.
const isRecordTypeStep = (step: { action: string; selector?: { label?: string; fallbacks?: Array<{ css?: string }> }; note?: string }): boolean => {
  const s = `${step.selector?.label ?? ""} ${step.note ?? ""}`;
  return step.action === "check"
    && (/cbListServices/i.test(step.selector?.fallbacks?.map((f) => f.css ?? "").join(" ") ?? "")
      || /^(residential|commercial)\s*-\s*/i.test(s.trim()));
};

check("THE REGRESSION: the step that filed a mechanical permit is recognised", () => {
  assert.equal(isRecordTypeStep({
    action: "check",
    selector: { label: "Residential - Electrical", fallbacks: [{ css: "#ctl00_PlaceHolderMain_WorkLocationEdit_ucAddressList_serviceControl_rptAgency_ctl00_cbListServices_1" }] },
    note: "Residential - Electrical",
  }), true);
});

check("its structural twin is recognised too", () => {
  assert.equal(isRecordTypeStep({ action: "check", selector: { label: "Residential - Structural" }, note: "record type: Residential - Structural" }), true);
  assert.equal(isRecordTypeStep({ action: "check", selector: { label: "Commercial - Mechanical" }, note: "" }), true);
});

check("an ordinary checkbox is NOT treated as a record type", () => {
  for (const note of [
    "I have read and agree to the terms",
    "This system includes battery storage",
    "Is the inverter lab-certified?",
    "accela: accept entry terms",
  ]) {
    assert.equal(isRecordTypeStep({ action: "check", selector: { label: note }, note }), false, note);
  }
});

check("a non-check action is never a record-type step", () => {
  assert.equal(isRecordTypeStep({ action: "click", selector: { label: "Residential - Structural" }, note: "" }), false);
});

// The rule the guard enforces, stated as data: a list that lacks the wanted type must not
// yield a pick. This is the whole bug in one assertion.
const pickByLabel = (offered: string[], wanted: string): string | null =>
  offered.find((o) => o.toLowerCase().includes(wanted.toLowerCase())) ?? null;

const COOS_BAY_CITY = [
  "Residential - Manufactured Dwelling Placement",
  "Residential - Mechanical",
  "Residential - Structural",
  "Commercial - Structural",
  "Commercial - Mechanical",
];
const COOS_COUNTY = ["Commercial - Electrical", "Residential - Electrical"];

check("Electrical on the CITY list yields NOTHING — never index 1 (Mechanical)", () => {
  assert.equal(pickByLabel(COOS_BAY_CITY, "Residential - Electrical"), null);
  // The bug in one line: the positional fallback would have returned this.
  assert.equal(COOS_BAY_CITY[1], "Residential - Mechanical");
});

check("Electrical resolves on the COUNTY list, where it is actually offered", () => {
  assert.equal(pickByLabel(COOS_COUNTY, "Residential - Electrical"), "Residential - Electrical");
});

check("Structural resolves on the CITY list", () => {
  assert.equal(pickByLabel(COOS_BAY_CITY, "Residential - Structural"), "Residential - Structural");
});

// ---------------------------------------------------------------------------
// A RECORD TYPE INSIDE A CLOSED CATEGORY IS NOT AN ABSENT RECORD TYPE.
//
// Accela's CapType page lists CATEGORY checkboxes above the record-type radios, and a type
// stays collapsed until its category is ticked. Live on aca-prod/CHINO the learn extracted
// "Residential Solar", reported it hidden, failed to check it, and the portal answered every
// advance with "You have not selected a record type." — four times, through two recovery
// attempts, then gave up.
//
// The category to open is named by the record type's own leading words. This pins that rule,
// and pins that it stays narrow: only a genuine prefix may be ticked, or the pass would open
// unrelated categories on a page where several are offered.
// ---------------------------------------------------------------------------
const categoryFor = (wantedLabel: string, checkboxes: string[]): string | undefined => {
  const wanted = wantedLabel.trim().toLowerCase();
  return checkboxes.find((c) => {
    const cat = c.trim().toLowerCase();
    return cat.length >= 4 && wanted.startsWith(cat) && wanted.length > cat.length;
  });
};
// The real category list from that page.
const CHINO_CATEGORIES = ["Administration", "Residential", "Building Project", "Non-Residential"];
check("THE REGRESSION: 'Residential Solar' opens the 'Residential' category", () => {
  assert.equal(categoryFor("Residential Solar", CHINO_CATEGORIES), "Residential");
});
check("a non-residential type opens ITS category, not Residential", () => {
  // "Non-Residential Electrical" must not match "Residential" — it does not start with it.
  assert.equal(categoryFor("Non-Residential Electrical", CHINO_CATEGORIES), "Non-Residential");
});
check("an unrelated category is never opened", () => {
  assert.equal(categoryFor("Residential Solar", ["Administration", "Building Project"]), undefined);
});
check("a category is only a prefix, never an equal or a substring elsewhere", () => {
  // Equal is not a category-of-itself, and a word appearing mid-label does not qualify.
  assert.equal(categoryFor("Residential", CHINO_CATEGORIES), undefined);
  assert.equal(categoryFor("Solar Residential Array", CHINO_CATEGORIES), undefined);
});
check("a too-short category label cannot match by accident", () => {
  assert.equal(categoryFor("Residential Solar", ["Res"]), undefined);
});

if (failures) { console.error(`\n${failures} record-type check(s) FAILED.`); process.exit(1); }
console.log("\nAll record-type checks passed.");
process.exit(0);
