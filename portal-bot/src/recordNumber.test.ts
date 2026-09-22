// A WRONG RECORD NUMBER IS WORSE THAN NO RECORD NUMBER.
//
// Everything downstream keys on this value — permit tracking, status checks, the client
// page — so a mis-scrape silently tracks the wrong filing forever. These tests pin both
// directions: the real completion pages this product has actually seen must be read, and
// every look-alike on a busy completion page (phone, ZIP+4, dates, bare digits) must not
// be. Confidence is the safety valve: only a `high` read may be written without a person.
// Run: tsx portal-bot/src/recordNumber.test.ts
import assert from "node:assert/strict";
import { extractRecordNumber, pageConfirmsSubmission } from "./recordNumber";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Real shapes, from filings this product has handled.
const ACCELA_PAGE = `
  Your application has been successfully submitted.
  Record Number: 187-26-000328-STR
  City of Coos Bay — Building
  Questions? Call 541-269-8918 or visit City Hall, Coos Bay OR 97420-1234
  Submitted 09/21/2026
`;
const POWERCLERK_PAGE = `
  Thank you for your application. Your application has been submitted.
  PP - Application Submitted (APP-111681)
  Portland General Electric — Net Metering
`;
const LABELLED_PAGE = `
  Submission complete.
  Permit Number: BLDR2026000912
  Contact 503-555-0100
`;
const DRAFT_PAGE = `
  Application 187-26-000328-STR
  Status: Draft — not yet submitted. Continue editing to submit.
`;
const NOISE_PAGE = `
  Application received. Thank you for your submission.
  Phone number: 541-269-8918
  Mailing ZIP: 97420-1234
  Submitted on 2026-09-21
`;

console.log("\n1. THE PAGES IT MUST READ");
check("MUST PASS: an Accela completion page yields the record number, high confidence", () => {
  const r = extractRecordNumber(ACCELA_PAGE);
  assert.equal(r.value, "187-26-000328-STR");
  assert.equal(r.source, "accela");
  assert.equal(r.confidence, "high", r.reason);
});

check("MUST PASS: a PowerClerk completion page yields APP-######, high confidence", () => {
  const r = extractRecordNumber(POWERCLERK_PAGE);
  assert.equal(r.value, "APP-111681");
  assert.equal(r.source, "powerclerk");
  assert.equal(r.confidence, "high", r.reason);
});

console.log("\n2. WHAT IT MUST REFUSE TO WRITE UNSEEN");
check("MUST EXCLUDE: a DRAFT page is never a confident read, even with a real-looking number", () => {
  const r = extractRecordNumber(DRAFT_PAGE);
  assert.equal(r.confidence, "low", `a draft was read as a filed application: ${r.reason}`);
});

check("MUST EXCLUDE: a phone number, ZIP+4 or date is never the record number", () => {
  const r = extractRecordNumber(NOISE_PAGE);
  assert.ok(!/541-269-8918|97420-1234|2026-09-21/.test(r.value),
    `a look-alike was taken for a record number: "${r.value}"`);
});

check("a LABELLED but non-portal-specific number is reported for confirmation, not written", () => {
  const r = extractRecordNumber(LABELLED_PAGE);
  assert.equal(r.value, "BLDR2026000912");
  assert.equal(r.source, "labelled");
  assert.equal(r.confidence, "low", "an unrecognised shape must not be written without a person");
});

check("an empty or blank page reads as nothing at all", () => {
  assert.equal(extractRecordNumber("").value, "");
  assert.equal(extractRecordNumber("   \n  ").source, "none");
});

console.log("\n3. THE SUBMISSION SIGNAL ITSELF");
check("pageConfirmsSubmission separates a completed filing from a draft", () => {
  assert.equal(pageConfirmsSubmission(ACCELA_PAGE), true);
  assert.equal(pageConfirmsSubmission(POWERCLERK_PAGE), true);
  assert.equal(pageConfirmsSubmission(DRAFT_PAGE), false);
  assert.equal(pageConfirmsSubmission(""), false);
});

console.log(failures === 0
  ? "\nAll record-number checks passed."
  : `\n${failures} record-number check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
