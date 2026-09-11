// THE REPLAY-SIDE PAY GATE DECIDES WHETHER REAL MONEY MOVES.
//
// recipeAdapter's click path runs `if (PAY_FEE.test(name)) return false;` before every recorded
// click during an automated replay against a LIVE portal. A word this pattern fails to match is a
// portal fee paid with the operator's money, which CLAUDE.md rule 1 forbids outright.
//
// It is the narrower of two copies (autoLearnAdapter.ts has the other) and an adversarial review
// of the learn-side twin found holes that applied here and were WIDER here:
//   - "submit and pay" was listed, the reverse order was not -> "Pay and Submit Application" passed
//   - no bare \bpayment\b, and \bpay\b cannot match "Payment" (no word boundary before the m)
//     -> "Submit Payment" passed
//   - no plural -> "Pay Fees and Submit" passed
//
// A filter list fails BOTH ways, so both are pinned. Over-blocking here costs a stopped replay the
// operator finishes by hand; under-blocking costs a filing fee and a licence.
//
//   npx tsx portal-bot/src/adapters/paymentGate.test.ts
import assert from "node:assert/strict";
import { PAY_FEE_REPLAY_GATE } from "./recipeAdapter";
import { isPayFee, ADVANCE_ONLY, PAGINATION_CONTROL } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

// Every one of these must be REFUSED. The first four are the reproduced holes.
const MUST_REFUSE = [
  "Pay and Submit Application",
  "Submit Payment",
  "Pay Fees and Submit",
  "Pay Fee",
  "Pay Now",
  "Submit & Pay",
  "Submit and Pay",
  "Make Payment",
  "Proceed to Payment",
  "Proceed to Checkout",
  "Checkout",
  "Add to Cart",
  "Remit Invoice",
  "Fees Due",
  "Pay $50.00",
  // BARE `pay`. Every alternative in both copies governed an object ("pay fees", "pay now",
  // "pay $", "pay and submit"), so the plainest pay control of all passed BOTH gates. Found by
  // adversarially probing the new terminal-page classifier, not by a portal failing.
  "Pay",
  "Pay Later",
  "Pay Balance",
  "Pay by Credit Card",
  "Review and Pay",
  "Confirm and Pay",
  "Agree and Pay",
  "Submit Application and Pay",
  // PURCHASE-COMMIT wording. "Place Order" was classified TERMINAL and recorded
  // isFinalSubmit:true while this gate answered false for it.
  "Place Order",
  "Submit Order",
  "Complete Purchase",
  "Buy Now",
];

// Every one of these must still be CLICKABLE. Blocking these would stop replay dead on ordinary
// pages — which is the failure mode this test exists to prevent as much as the other.
const MUST_ALLOW = [
  "Next",
  "Continue",
  "Save and Continue",
  "Submit Application",
  "Submit",
  "Upload Document",
  "Add Equipment",
  "Select Utility",
  "Payee Name",          // a FIELD label containing 'pay' as a prefix, not a payment action
  "Company Name",
  // `\bpay\b` must not reach a word that merely CONTAINS pay — there is no boundary after it.
  "Repay",
  "Payroll",
  // `order` counts only when a COMMIT VERB governs it, which is why the click-blocking copies
  // do not use the blunt `\border\b` that MONEY_ANYWHERE can afford.
  "Sort Order",
  "Work Order",
  "Order Status",
];

check("MUST REFUSE: every payment-shaped control, including the reproduced holes", () => {
  for (const label of MUST_REFUSE) {
    assert.ok(PAY_FEE_REPLAY_GATE.test(label),
      `"${label}" reaches the click path — during a live replay that spends the operator's money`);
  }
});

check("MUST ALLOW: ordinary controls still click, or replay stops dead", () => {
  for (const label of MUST_ALLOW) {
    assert.ok(!PAY_FEE_REPLAY_GATE.test(label),
      `"${label}" is blocked as a payment control — over-blocking halts every replay on an ordinary page`);
  }
});

check("the two reproduced word-order holes specifically", () => {
  assert.ok(PAY_FEE_REPLAY_GATE.test("Pay and Submit Application"), "reverse word order");
  assert.ok(PAY_FEE_REPLAY_GATE.test("Submit Payment"), "bare 'Payment' — \\bpay\\b cannot match it");
});

// The two copies are deliberately separate (see recipeAdapter's comment) but must never again be
// separately WRONG — that is the invariant d8e950e's hole 3 recorded and this pins it directly,
// rather than leaving each file to test its own copy against its own list.
check("PARITY: the learn-side isPayFee refuses everything this gate refuses", () => {
  for (const label of MUST_REFUSE) {
    assert.ok(isPayFee(label),
      `PAY_FEE_REPLAY_GATE refuses "${label}" but the learn-side isPayFee does not — the copies have drifted, which is exactly how hole 3 happened`);
  }
});

check("PARITY: and still allows everything this gate allows", () => {
  for (const label of MUST_ALLOW) {
    assert.ok(!isPayFee(label),
      `the learn-side isPayFee blocks "${label}" — over-blocking stalls the walk on an ordinary page`);
  }
});

// THE HAZARD THAT MADE BARE `pay` URGENT. clickFallbackAdvance takes a control on
// ADVANCE_ONLY && !SUBMIT_INTENT && !isOffLimitsButton. "Continue and Pay" is anchored on
// "Continue", says no "submit", and — before this — was not off-limits, so the LEARN WALK
// would have clicked it on a live portal. isPayFee is the only guard standing between
// ADVANCE_ONLY and a real payment, so it is asserted here at the predicate level.
check("an ADVANCE-SHAPED pay control is off-limits — the clickFallbackAdvance hazard", () => {
  for (const label of ["Continue and Pay", "Continue to Payment", "Proceed to Payment", "Next — Pay Fees"]) {
    const advanceShaped = ADVANCE_ONLY.test(label) && !PAGINATION_CONTROL.test(label);
    assert.ok(isPayFee(label),
      `"${label}" is not off-limits${advanceShaped ? " AND is ADVANCE_ONLY-shaped, so clickFallbackAdvance would press it" : ""}`);
  }
});

check("the gate is shape-based and names no portal", () => {
  const src = PAY_FEE_REPLAY_GATE.source.toLowerCase();
  for (const portalish of ["powerclerk", "accela", "ameren", "comed", "miami", "http"]) {
    assert.ok(!src.includes(portalish), `the pattern names "${portalish}"`);
  }
});

console.log(failures === 0
  ? "\nAll replay pay-gate checks passed."
  : `\n${failures} replay pay-gate check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
