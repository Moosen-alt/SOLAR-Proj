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
import { classifyPermitStatusText, extractStatedStatus, isAuthWallText } from "../src/permitMonitor";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Verbatim shape of the live Accela record page, both permits.
const SUBMITTED = "Permit/Application 187-26-000305-STR: Residential Structural Record Status: App Submitted "
  + "Expiration Date: 02/28/2027 Work Location 540 MOCKUP AVE COOS BAY OR 97420 Additional Information "
  + "Additional Application Information Attachment Fees Inspections";
const ISSUED = "Permit/Application 194-26-001471-ELEC: Residential Electrical Record Status: Permit Issued "
  + "Expiration Date: 02/28/2027 Work Location 540 MOCKUP AVE COOS BAY OR 97420 Additional Information";

check("the stated status is pulled out of the page", () => {
  assert.equal(extractStatedStatus(SUBMITTED), "App Submitted");
  assert.equal(extractStatedStatus(ISSUED), "Permit Issued");
});

check("THE REGRESSION: a freshly filed permit is not a correction", () => {
  const c = classifyPermitStatusText(SUBMITTED, "permit");
  assert.notEqual(c.outcome, "correction_flagged", `classified as ${c.outcome} — the "Additional Information" heading again`);
  assert.equal(c.outcome, "waiting");
});

check("an issued permit still reads as issued", () => {
  assert.equal(classifyPermitStatusText(ISSUED, "permit").outcome, "issued");
});

check("a REAL correction is still caught, stated in the status field", () => {
  const c = classifyPermitStatusText("Permit/Application 1: Record Status: Corrections Required Expiration Date: 01/01/2027", "permit");
  assert.equal(c.outcome, "correction_flagged");
});

check("a portal with no status field still falls back to scanning the prose", () => {
  const c = classifyPermitStatusText("Your application has been reviewed and corrections are required before we can proceed.", "permit");
  assert.equal(c.outcome, "correction_flagged");
});

check("empty text is still an explicit needs-review, not a silent pass", () => {
  assert.equal(classifyPermitStatusText("", "permit").outcome, "needs_human_review");
});

// A LOGIN PAGE IS NOT A STATUS.
//
// Live: three interconnection applications, each verified minutes earlier, were all
// downgraded to needs_human_review when the monitor's authenticated scrape landed on
// PowerClerk's sign-in screen and recorded THAT page's text as the record's status. The
// scrape succeeded; it just wasn't looking at the record.
const POWERCLERK_LOGIN = "‌ PowerClerk Log In Username: Password: Log In Forgot Password? Register a new account Sign in with PacifiCorp SSO © 2026 Clean Power Research, L.L.C. Terms of Use | Privacy Policy";

check("THE REGRESSION: PowerClerk's login page is recognised as an auth wall", () => {
  assert.equal(isAuthWallText(POWERCLERK_LOGIN), true);
  // …and it classifies as needs-review, which is exactly why recording it was a downgrade.
  assert.equal(classifyPermitStatusText(POWERCLERK_LOGIN, "permit").outcome, "needs_human_review");
});

check("a generic vendor sign-in page is caught too", () => {
  assert.equal(isAuthWallText("Sign In Email Address Password Forgot password? Create an account"), true);
});

check("a real record page is never mistaken for one", () => {
  assert.equal(isAuthWallText("Record Status: Permit Issued. Record 194-26-001482-ELEC. Residential Electrical. Expiration Date: 03/01/2027."), false);
});

check("...nor is a status page whose nav merely says Log In", () => {
  assert.equal(isAuthWallText("Home Projects Tools Log In View/Edit: APP-111667 Application Received Current Status Status marked as PP - Application Submitted on 9/2/2026 at 1:54 PM Project Owner"), false);
});

check("empty text is not an auth wall — it is simply nothing", () => {
  assert.equal(isAuthWallText(""), false);
});

// ---------------------------------------------------------------------------
// A NAMED REVIEW DESK IS STILL "UNDER REVIEW", AND NOBODY SHOULD BE PAGED FOR IT.
// The single largest category of open human-review items in the live database was
// "Permit monitor status review" (10 of 25, measured 2026-09-22) — and one of them
// was the perfectly legible "PP - Engineering Review as of 9/2/2026", escalated to
// a person only because the waiting vocabulary lacked the words portals actually use.
// ---------------------------------------------------------------------------
for (const text of [
  "PP - Engineering Review as of 9/2/2026 (APP-111651). Verified logged-in on the PowerClerk Projects grid.",
  "Plan Review — assigned to plans examiner",
  "Structural Review in progress",
  "Electrical Review",
  "Application Received",
]) {
  check(`MUST PASS: "${text.slice(0, 34)}…" reads as WAITING, not a human interruption`, () => {
    assert.equal(classifyPermitStatusText(text, "permit").outcome, "waiting");
  });
}

check("MUST EXCLUDE: an ISSUED permit still wins over the broadened review vocabulary", () => {
  assert.equal(classifyPermitStatusText("Plan Review complete — Permit issued 9/14/2026", "permit").outcome, "issued");
});

check("MUST EXCLUDE: corrections still win over it — that one IS a person's job", () => {
  assert.equal(classifyPermitStatusText("Plan Review: corrections required, see review comments", "permit").outcome, "correction_flagged");
});

check("MUST EXCLUDE: 'Intake Requirements Needed' still escalates — the city is waiting on US", () => {
  assert.notEqual(classifyPermitStatusText("Intake Requirements Needed", "permit").outcome, "waiting");
});

check("a portal LOGIN page is an auth wall, never a status", () => {
  assert.equal(isAuthWallText("‌ PowerClerk Log In Username: Password: Log In Forgot Password? Register a new account"), true);
});

if (failures) { console.error(`\n${failures} permit-status check(s) FAILED.`); process.exit(1); }
console.log("\nAll permit-status-line checks passed.");
process.exit(0);
