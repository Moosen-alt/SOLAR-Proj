// THE ONE SUCCESS IN THE BASELINE WAS A RECIPE FOR THE WRONG FORM.
//
// Gilbert, AZ was the only portal of eleven to reach a review screen on 2026-09-04 — top
// rung, 6 of 6, nobody owes anything. The page it filled was titled "Neumo: Permit
// Extension Request", reached from the stored URL .../f/permitext. A permit EXTENSION.
//
// The engine performed perfectly on the wrong document, and the ladder had no way to say
// so, because it measures mechanical progress. A trusted recipe replays unattended on every
// future project in a jurisdiction, so a trusted recipe for a permit extension would file
// permit extensions for real customers.
//
// Most of this test is the OPPOSITE risk. A permit form mentions extensions and inspections
// constantly — "this permit may be extended once", a nav bar linking to "Request
// Inspection" — and a guard that trips on those would block every good recipe and be turned
// off within a week. It has to name a wrong form without being fooled by a right one
// talking about wrong ones.
//
// Browser-free. Run: tsx backend/test/formPurpose.test.ts
import assert from "node:assert/strict";
import { formPurposeMismatch } from "../src/formPurpose";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------
// The live case.
// ---------------------------------------------------------------------------
check("THE REGRESSION: Gilbert's permit-extension form is named as the wrong form", () => {
  const v = formPurposeMismatch(
    ["Neumo: Permit Extension Request", "Permit Extension Request — Town of Gilbert"],
    ["https://gilbertaz.seamlessdocs.com/f/permitext"],
  );
  assert.equal(v.mismatch, true);
  assert.match(v.reason, /EXTENSION/);
  assert.match(v.reason, /NOT trusted/);
});

check("...and the URL alone is enough, when the page says nothing useful", () => {
  const v = formPurposeMismatch(["Application Form"], ["https://x.gov/f/permitext"]);
  assert.equal(v.mismatch, true);
});

check("...and the TITLE alone is enough, when the URL is opaque", () => {
  const v = formPurposeMismatch(["Request an Inspection"], ["https://x.gov/forms/8842"]);
  assert.equal(v.mismatch, true);
  assert.match(v.reason, /INSPECTION/);
});

// ---------------------------------------------------------------------------
// The expensive direction: a RIGHT form that talks about wrong ones.
// ---------------------------------------------------------------------------
check("a real solar permit application is NOT flagged", () => {
  const v = formPurposeMismatch([
    "Residential Solar PV Permit Application",
    "Applicant, contractor, system size, module and inverter details.",
  ], ["https://x.gov/apply/solar-pv"]);
  assert.equal(v.mismatch, false, v.reason);
});

check("...even when its own text mentions extensions and renewals", () => {
  // Real permit forms say this constantly.
  const v = formPurposeMismatch([
    "New Permit Application — Electrical",
    "Permits expire after 180 days. A permit may be extended once upon written request. Renewal of an expired permit requires a new application.",
  ], ["https://x.gov/apply/electrical"]);
  assert.equal(v.mismatch, false, v.reason);
});

check("...even when a nav bar links to inspections and payments", () => {
  const v = formPurposeMismatch([
    "Apply for a new permit",
    "Home | Apply | Request Inspection | Pay Fees | Schedule an inspection | Complaint",
  ], ["https://x.gov/apply"]);
  assert.equal(v.mismatch, false, v.reason);
});

check("an interconnection application mentioning rebates is NOT flagged", () => {
  // The utility's own page usually advertises its rebate beside the interconnection form.
  const v = formPurposeMismatch([
    "Interconnection Application — Net Metering",
    "After approval you may also be eligible for a rebate under our solar incentive program.",
  ], ["https://utility.com/interconnection/apply"]);
  assert.equal(v.mismatch, false, v.reason);
});

check("'Renewable' in a URL is not 'Renewal'", () => {
  // The same mistake that made PROGRAM_EXCLUDE reject the target, in a second place.
  const v = formPurposeMismatch(["Renewable Energy Systems Permit"], ["https://x.gov/renewable-energy/apply"]);
  assert.equal(v.mismatch, false, v.reason);
});

// ---------------------------------------------------------------------------
// The wrong forms it must keep naming, when they are the SUBJECT and not an aside.
// ---------------------------------------------------------------------------
for (const [title, word] of [
  ["Permit Renewal Application", "RENEWAL"],
  ["Inspection Request Form", "INSPECTION"],
  ["Code Enforcement Complaint", "COMPLAINT"],
  ["Appeal of a Permit Decision", "APPEAL"],
  ["Make a Payment", "PAYMENT"],
  ["Solar Rebate Application", "REBATE"],
  ["Withdraw a permit application", "WITHDRAWAL"],
  ["Pre-Application Meeting Request", "MEETING"],
] as Array<[string, string]>) {
  check(`"${title}" is named as ${word}`, () => {
    const v = formPurposeMismatch([title], []);
    assert.equal(v.mismatch, true, `not flagged: ${title}`);
    assert.match(v.reason, new RegExp(word));
  });
}

check("nothing at all is not a mismatch — silence is not evidence", () => {
  assert.equal(formPurposeMismatch([], []).mismatch, false);
  assert.equal(formPurposeMismatch([undefined, ""], [undefined]).mismatch, false);
});

check("the reason names WHAT to check, not just that something is wrong", () => {
  const v = formPurposeMismatch(["Permit Extension Request"], []);
  assert.match(v.reason, /stored portal URL/, "an operator needs to know where to look");
});

if (failures) { console.error(`\n${failures} form-purpose check(s) FAILED.`); process.exit(1); }
console.log("\nAll form-purpose checks passed.");
process.exit(0);
