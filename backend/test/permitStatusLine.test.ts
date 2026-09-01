// A PORTAL THAT STATES ITS STATUS HAS ALREADY ANSWERED THE QUESTION.
//
// The classifier scanned whatever the fetcher scraped, which on a record page is the entire
// page. Accela prints an "Additional Information" section heading on EVERY record, and the
// correction pattern matches that phrase — so 187-26-000305-STR, filed minutes earlier and
// reading "Record Status: App Submitted", classified as correction_flagged at 0.9 confidence.
// That is a false alarm to the customer, and the review item it raises blocks staging of the
// project's other tracks. It would have happened on every Accela filing.
//   npx tsx backend/test/permitStatusLine.test.ts
import assert from "node:assert/strict";
import { classifyPermitStatusText, extractStatedStatus } from "../src/permitMonitor";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Verbatim shape of the live Accela record page, both permits.
const SUBMITTED = "Permit/Application 187-26-000305-STR: Residential Structural Record Status: App Submitted "
  + "Expiration Date: 02/28/2027 Work Location 773 KENTUCKY AVE COOS BAY OR 97420 Additional Information "
  + "Additional Application Information Attachment Fees Inspections";
const ISSUED = "Permit/Application 194-26-001471-ELEC: Residential Electrical Record Status: Permit Issued "
  + "Expiration Date: 02/28/2027 Work Location 773 KENTUCKY AVE COOS BAY OR 97420 Additional Information";

check("the stated status is pulled out of the page", () => {
  assert.equal(extractStatedStatus(SUBMITTED), "App Submitted");
  assert.equal(extractStatedStatus(ISSUED), "Permit Issued");
});

check("THE REGRESSION: a freshly filed permit is not a correction", () => {
  const c = classifyPermitStatusText(SUBMITTED);
  assert.notEqual(c.outcome, "correction_flagged", `classified as ${c.outcome} — the "Additional Information" heading again`);
  assert.equal(c.outcome, "waiting");
});

check("an issued permit still reads as issued", () => {
  assert.equal(classifyPermitStatusText(ISSUED).outcome, "issued");
});

check("a REAL correction is still caught, stated in the status field", () => {
  const c = classifyPermitStatusText("Permit/Application 1: Record Status: Corrections Required Expiration Date: 01/01/2027");
  assert.equal(c.outcome, "correction_flagged");
});

check("a portal with no status field still falls back to scanning the prose", () => {
  const c = classifyPermitStatusText("Your application has been reviewed and corrections are required before we can proceed.");
  assert.equal(c.outcome, "correction_flagged");
});

check("empty text is still an explicit needs-review, not a silent pass", () => {
  assert.equal(classifyPermitStatusText("").outcome, "needs_human_review");
});

if (failures) { console.error(`\n${failures} permit-status check(s) FAILED.`); process.exit(1); }
console.log("\nAll permit-status-line checks passed.");
process.exit(0);
