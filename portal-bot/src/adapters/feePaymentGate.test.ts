import assert from "node:assert/strict";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter, isFeePaymentControl } from "./recipeAdapter";

// THE REPLAY-SIDE PAY GATE. Browser-free, on purpose: the thing under test is a decision
// about a control's NAME, and it is the last thing standing between a live portal's payment
// control and a click. CLAUDE.md rule 1 — automation never pays a portal fee.
//
// Why this file exists (the incident): the gate was a PHRASE list, and it was NARROWER than
// the learn-side copy in autoLearnAdapter. "Pay Fees and Submit" beat it on a plural ("pay
// fee" cannot match "Pay Fees" — the trailing \b fails against the "s"); "Pay and Submit
// Application" beat it on word order (the list carried "submit and pay", not the reverse);
// "Submit Payment" beat it on vocabulary (\bpay\b does not match "Payment"); and "Remit
// Invoice" matched nothing at all — not this gate, and not SUBMIT_KEYWORDS either, since
// \bsubmit\b does not match "Remit".
//
// The damage mode is not a rogue click out of nowhere: it is a recipe banked with
// isFinalSubmit stamped on the wrong control, replayed later on a trusted auto-submit
// portal. So the behavioural rows below stamp isFinalSubmit:true and turn autoSubmit ON —
// the state in which every OTHER gate in executeClick waves the step through, and only this
// one refuses.
//
// Run with: npm run portal:test:unit

// The persist-settle sleep is 3s in production; keep it negligible here.
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";

// Controls that must NEVER be clicked, in any mode, flagged or not.
const MUST_REFUSE = [
  "Pay Fees and Submit",
  "Pay and Submit Application",
  "Submit Payment",
  "Proceed to Checkout",
  "Remit Invoice",
  // Shapes the pre-widening list did already hold — kept so a future "simplification"
  // cannot quietly drop them while the new ones pass.
  "Pay Now",
  "Submit & Pay",
  "Make Payment",
  "Add to Cart",
  "Continue to Payment",
  "Pay $412.50",
  // PLURALS, the shape that started this: a trailing \b loses to an "s". Both are real
  // portal labels (applicationEntry's own fixture carries "Pay Invoices").
  "Pay Invoices",
  "Payments",
];

// Ordinary forward controls. Refusing one of these costs a filing that could have
// continued, so the widening is only correct if every one of them still passes.
const MUST_ALLOW = [
  "Submit Application",
  "Continue",
  "Next",
  "Save and Continue",
  // Adjacent words that are NOT money-moving controls and must not be caught by the
  // word list: a billing address is an ordinary form section on permit portals.
  "Save Billing Address",
  "Continue Application",
];

// --- Layer 1: the predicate itself ------------------------------------------------

function testPredicateRefusesPaymentControls() {
  for (const label of MUST_REFUSE) {
    assert.equal(isFeePaymentControl(label), true, `"${label}" must be refused as a payment control`);
  }
}

function testPredicateAllowsOrdinaryAdvances() {
  for (const label of MUST_ALLOW) {
    assert.equal(isFeePaymentControl(label), false, `"${label}" must stay clickable`);
  }
}

function testPredicateHandlesEmptyAndNoise() {
  // A css-only step has no name; the gate must not refuse everything on an empty haystack.
  assert.equal(isFeePaymentControl(""), false);
  assert.equal(isFeePaymentControl(undefined), false);
  // Word boundaries, not substrings: these are not payment controls.
  assert.equal(isFeePaymentControl("Payee Details"), false, "\"Payee\" is not \"Pay\"");
  assert.equal(isFeePaymentControl("Coffee Shop Permit"), false, "\"Coffee\" is not \"fee\"");
}

// --- Layer 2: the gate as replay actually reaches it -------------------------------

interface ActionLog { clicks: string[] }

// Minimal fake Playwright page — enough for executeClick's path. Deliberately a local copy
// rather than an import: recipeAdapter.test.ts's harness is private to that file, and this
// test must keep working if that one is restructured.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakePage(log: ActionLog): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const locatorFor = (key: string): any => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loc: any = {
      first: () => loc,
      nth: () => loc,
      count: async () => 1,
      click: async () => { log.clicks.push(key); },
      fill: async () => undefined,
      selectOption: async () => undefined,
      check: async () => undefined,
      uncheck: async () => undefined,
      press: async () => undefined,
      waitFor: async () => undefined,
      setInputFiles: async () => undefined,
      evaluateAll: async () => [],
    };
    return loc;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page: any = {
    goto: async () => undefined,
    waitForLoadState: async () => undefined,
    reload: async () => undefined,
    frames: () => [],
    getByRole: (role: string, o?: { name?: string }) => locatorFor(`role:${role}:${o?.name ?? ""}`),
    getByLabel: (label: string) => locatorFor(`label:${label}`),
    getByPlaceholder: (p: string) => locatorFor(`placeholder:${p}`),
    getByTestId: (t: string) => locatorFor(`testId:${t}`),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getByText: (t: any) => {
      if (t instanceof RegExp && /captcha/i.test(t.source)) {
        return { ...locatorFor("text:challenge"), count: async () => 0 };
      }
      return locatorFor(`text:${String(t)}`);
    },
    locator: (css: string) => locatorFor(`css:${css}`),
    frameLocator: () => page,
    waitForFunction: async () => true,
  };
  return page;
}

function recipeWith(steps: RecipeStep[]): PortalRecipe {
  return {
    id: "fp1", scopeType: "ahj", profileKey: "or|portland|", state: "OR",
    ahj: "Portland", utility: "PGE", portalPlatform: "test", portalUrl: "",
    status: "complete", version: 1, steps,
    createdBy: "test", createdAt: "", updatedAt: "", notes: "",
  };
}

/** Replay one click step and report every control the adapter actually pressed. */
async function clicksFor(step: RecipeStep, autoSubmit: boolean): Promise<string[]> {
  const log: ActionLog = { clicks: [] };
  const adapter = new RecipeAdapter(recipeWith([step]), {}, {}, { autoSubmit });
  (adapter as unknown as { page: unknown }).page = makeFakePage(log);
  await adapter.fillApplication({} as ProjectRecord);
  return log.clicks;
}

// The exact damage mode: a recipe banked with isFinalSubmit on a payment control, replayed
// on a portal the operator marked trusted. Every other gate in executeClick passes it.
async function testPaymentControlsRefusedEvenWhenFlaggedFinalInAutoSubmit() {
  for (const name of MUST_REFUSE) {
    const step = { action: "click", selector: { role: "button", name }, isFinalSubmit: true } as unknown as RecipeStep;
    const clicks = await clicksFor(step, true);
    assert.deepEqual(clicks, [], `"${name}" was CLICKED on a live portal (flagged final, autoSubmit on)`);
  }
}

// The same controls unflagged, mid-flow, guided-manual — the "Remit Invoice" shape, which
// no other gate in executeClick matches.
async function testPaymentControlsRefusedUnflaggedMidFlow() {
  for (const name of MUST_REFUSE) {
    const step = { action: "click", selector: { role: "button", name } } as unknown as RecipeStep;
    const clicks = await clicksFor(step, false);
    assert.deepEqual(clicks, [], `"${name}" was CLICKED as an ordinary mid-flow advance`);
  }
}

// A payment control named only in the step NOTE (a human-patch step carries a css selector
// and names the button in its note) must be refused too — the gate's haystack includes it.
//
// The label here is "Remit Invoice" ON PURPOSE: it is the one shape NO other gate catches.
// SUBMIT_KEYWORDS does not match it (\bsubmit\b does not match "Remit"), so an earlier draft
// of this row that said "Pay Fees and Submit" passed with the widening DISABLED — blocked by
// the submit-keyword gate, proving nothing about this one. A row that passes without the fix
// is not a test.
async function testPaymentControlRefusedWhenNamedOnlyInTheNote() {
  const step = { action: "click", selector: { css: "#btn1" }, note: "human-patch: Remit Invoice" } as unknown as RecipeStep;
  assert.deepEqual(await clicksFor(step, true), [], "a payment control named in the note was clicked");
}

// THE FAIL-SAFE ROW. A gate that refuses everything is not a safe gate, it is a broken
// replay: ordinary advances must still run.
async function testOrdinaryAdvancesStillClick() {
  for (const name of ["Continue", "Next", "Save and Continue", "Save Billing Address"]) {
    const step = { action: "click", selector: { role: "button", name } } as unknown as RecipeStep;
    const clicks = await clicksFor(step, false);
    assert.deepEqual(clicks, [`role:button:${name}`], `"${name}" must still be clickable`);
  }
}

// "Submit Application" is blocked by SUBMIT_KEYWORDS unless it carries the explicit
// isFinalSubmit allowlist flag AND autoSubmit is on — that is the one mode in which the
// pay gate is the only thing left, so prove the pay gate does not eat it there.
async function testFlaggedFinalSubmitStillClicksInAutoSubmit() {
  const step = { action: "click", selector: { role: "button", name: "Submit Application" }, isFinalSubmit: true } as unknown as RecipeStep;
  const clicks = await clicksFor(step, true);
  assert.deepEqual(clicks, ["role:button:Submit Application"], "the allowlisted final submit must still be clickable in autoSubmit");
}

const tests: Array<[string, () => void | Promise<void>]> = [
  ["predicate REFUSES every payment wording (plural, word order, bare noun)", testPredicateRefusesPaymentControls],
  ["predicate ALLOWS ordinary forward controls", testPredicateAllowsOrdinaryAdvances],
  ["predicate handles an empty name and near-miss words", testPredicateHandlesEmptyAndNoise],
  ["replay refuses a payment control even when flagged final in autoSubmit", testPaymentControlsRefusedEvenWhenFlaggedFinalInAutoSubmit],
  ["replay refuses a payment control unflagged, mid-flow", testPaymentControlsRefusedUnflaggedMidFlow],
  ["replay refuses a payment control named only in the step note", testPaymentControlRefusedWhenNamedOnlyInTheNote],
  ["THE FAIL-SAFE: ordinary advances still click", testOrdinaryAdvancesStillClick],
  ["THE FAIL-SAFE: the allowlisted final submit still clicks in autoSubmit", testFlaggedFinalSubmitStillClicksInAutoSubmit],
];

let failures = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok   - ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (failures) {
  console.error(`\n${failures} fee-payment-gate test(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} fee-payment-gate tests passed.`);
