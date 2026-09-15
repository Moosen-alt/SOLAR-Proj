// "INTAKE REQUIREMENTS NEEDED" IS THE CITY WAITING ON US, AND WE CALLED IT "IN REVIEW".
//
// Read off the real Coos Bay Accela record for 187-26-000309-STR (1780 Ocean Blvd) on 2026-09-15:
//
//   Record 187-26-000309-STR: Residential Structural
//   Record Status: Intake Requirements Needed
//   Condition: PERMIT OUTSTANDING  Severity: Notice
//   "Outstanding permit 187-M16-213 expired prior to final."  Applied 12/13/2019
//
// The monitor classified that `waiting` / "In review" at 0.72, because waitingPattern contains
// the bare word `intake`:
//
//   /\b(under review|in review|...|intake|pending review|processing|...)\b/i
//
// "Intake Requirements Needed" matches on `intake` and the two words that REVERSE its meaning are
// never looked at. So a filing stalled pending OUR action was reported to the operator — and on
// the client's tracker — as the city working on it. Nobody chases a permit that says "In review".
//
// Same shape as the stamp bug found the same day: a positive keyword beating the qualifier that
// negates it.
//
//   MUST FLAG    — every "the agency needs something before it will review" wording, as a state
//                  that is NOT review-in-progress.
//   MUST KEEP    — genuine in-review wordings, including ones containing the word "intake".
//   MUST SURFACE — a parcel/record CONDITION or hold, which is currently invisible: the notice
//                  above sat in text we captured and stored, and nothing read it.
//
//   npx tsx backend/test/intakeRequirements.test.ts
import assert from "node:assert/strict";

const { classifyPermitStatusText } = await import("../src/permitMonitor");

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// The verbatim record text, trimmed to what the classifier sees.
const LIVE = "Record 187-26-000309-STR: Residential Structural Record Status: Intake Requirements Needed "
  + "Expiration Date: 03/01/2027 A notice was added to this record on 12/13/2019. Condition: PERMIT OUTSTANDING "
  + "Severity: Notice Total Conditions: 1 (Notice: 1) Parcel Notifications - 1 Applied Parcel Other PERMIT "
  + "OUTSTANDING Outstanding permit 187-M16-213 expired prior to final. Applied | Notice | 12/13/2019";

const ACTION_NEEDED = [
  LIVE,
  "Record Status: Intake Requirements Needed",
  "Status: Additional Information Required",
  "Status: Incomplete - additional documents required",
  "Status: Pending Applicant Response",
  "Status: Awaiting Applicant",
  "Status: Resubmittal Required",
  "Status: On Hold - missing documents",
  "Status: Application Incomplete",
];

const STILL_IN_REVIEW = [
  "Record Status: In Review",
  "Status: Under Review by Plans Examiner",
  "Status: Intake Complete - routed to plan review",
  "Status: Intake Review In Progress",
  "Status: Submitted - queued for review",
  "Status: Plan Review In Progress",
];

check("THE HEADLINE: the live record is NOT reported as 'In review'", () => {
  const c = classifyPermitStatusText(LIVE);
  assert.notEqual(c.outcome, "waiting",
    `the real stalled permit still reads as review-in-progress: ${c.outcome} / "${c.statusLabel}"`);
  assert.doesNotMatch(c.statusLabel, /^In review$/i,
    `a client reading "${c.statusLabel}" has no reason to chase anything`);
});

check("MUST FLAG: every 'the agency needs something from us' wording", () => {
  const missed = ACTION_NEEDED.filter((t) => classifyPermitStatusText(t).outcome === "waiting");
  assert.deepEqual(missed, [], `still reported as review-in-progress: ${JSON.stringify(missed, null, 1)}`);
});

check("MUST KEEP: genuine in-review wordings, including ones containing 'intake'", () => {
  // The fix must not swing the other way. "Intake Complete - routed to plan review" contains both
  // "intake" and a word from the new pattern's neighbourhood, and it IS in review.
  const broken = STILL_IN_REVIEW.filter((t) => classifyPermitStatusText(t).outcome !== "waiting");
  assert.deepEqual(broken, [],
    `real in-review statuses were flagged as needing action: ${JSON.stringify(broken, null, 1)}`);
});

check("the classification says WHAT is wanted, not just that something is", () => {
  const c = classifyPermitStatusText(LIVE);
  assert.match(String(c.message || ""), /intake|requirement|before|applicant/i,
    `the operator needs to know it is stalled on us: ${c.message}`);
});

check("MUST SURFACE: a parcel condition / hold is reported, not silently dropped", () => {
  // The 2019 PERMIT OUTSTANDING notice on this parcel is the kind of thing that stops a permit
  // dead and has nothing to do with our documents. It was in the text we captured and stored.
  // ASSERT THE PORTAL'S OWN WORDS, not a word that also appears in our message. The first
  // version matched /outstanding/ — which our own "requirements are outstanding at intake" text
  // satisfies — so it passed while the condition was being dropped entirely.
  const c: Record<string, unknown> = classifyPermitStatusText(LIVE) as never;
  const message = String((c as { message?: string }).message || "");
  assert.match(message, /187-M16-213/,
    `the parcel condition never reached the operator — it must quote the record: ${message}`);
  assert.match(message, /condition/i, message);
});

check("MUST NOT: a record with no condition does not invent one", () => {
  const c: Record<string, unknown> = classifyPermitStatusText("Record Status: Permit Issued") as never;
  assert.equal((c as { outcome?: string }).outcome, "issued");
  assert.doesNotMatch(JSON.stringify(c).toLowerCase(), /outstanding permit|parcel condition/,
    "a clean record was reported as carrying a condition");
});

console.log(failures === 0
  ? "\nintakeRequirements: all checks passed."
  : `\nintakeRequirements: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
