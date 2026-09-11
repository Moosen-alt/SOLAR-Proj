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
