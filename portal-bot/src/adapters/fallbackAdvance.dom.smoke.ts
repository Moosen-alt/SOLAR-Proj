// THE NEXT BUTTON THE PLANNER DID NOT NAME.
//
// Twelve portals in the 59-portal learn benchmark recorded fills and never reached review.
// Their stored traces all end the same way: a filled page, and `adv=-`. The walk stops on a
// page it has just completed while that page still shows dozens of buttons -- ComEd ended on
// a form with 27 of them, Boston on one with 96. Whatever the planner was doing, "no
// advance" was not true of the page.
//
// The fallback is deliberately NARROWER than the planner is allowed to be, and the second
// half of this file is why: clicking the wrong button here files somebody's application.
//   npx tsx portal-bot/src/adapters/fallbackAdvance.dom.smoke.ts
import assert from "node:assert/strict";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// The two rules the fallback applies, stated here as the code states them. Kept in step with
// autoLearnAdapter's ADVANCE_ONLY and SUBMIT_INTENT.
const ADVANCE_ONLY = /^\s*(next|continue|proceed|save (and|&) (continue|next)|save & next|next step|go to next)\b/i;
const SUBMIT_INTENT = /\b(continue application|submit application|file application|submit|finish|finalize|confirm submission|place order|complete submission)\b/i;
const wouldClick = (label: string): boolean =>
  !!label && label.length <= 40 && ADVANCE_ONLY.test(label) && !SUBMIT_INTENT.test(label);

// ---- what it MUST take ---------------------------------------------------------
for (const label of ["Next", "Continue", "Next Step", "Save and Continue", "Save & Next", "Proceed", "continue"]) {
  check(`takes a plain advance: ${JSON.stringify(label)}`, wouldClick(label));
}

// ---- what it MUST NOT take -----------------------------------------------------
// Accela's page advance is literally "Continue Application" -- and on the LAST page that
// same button FILES the permit. Losing a legitimate advance costs a page we do not learn;
// clicking a submit costs a filing nobody authorised. Only one of those is recoverable.
check("REFUSES Accela's 'Continue Application' — the same control that files on the last page",
  !wouldClick("Continue Application »"));

for (const label of ["Submit", "Submit Application", "Finish", "Finalize", "Confirm Submission", "File Application", "Place Order"]) {
  check(`refuses a submit: ${JSON.stringify(label)}`, !wouldClick(label));
}

// Not an advance at all -- these are why the pattern is anchored at the start of the label.
for (const label of ["Pay Fees Due", "Add to Cart", "Checkout", "Cancel", "Back", "Search", "Continue Application and Pay"]) {
  check(`refuses a non-advance: ${JSON.stringify(label)}`, !wouldClick(label));
}

check("refuses a sentence that merely contains 'next'",
  !wouldClick("Please review the details before you continue to the next screen"));

assert.ok(true);
if (failures) { console.error(`\n${failures} fallback-advance check(s) FAILED.`); process.exit(1); }
console.log("\nAll fallback-advance checks passed.");
