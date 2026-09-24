// THE GOLDEN LIST FOR EVERY PORTAL SAFETY QUESTION.
//
// shared/src/portalSafety.ts is the one answer to "is this a submit", "is this a fee", "is this
// field a secret / a payment card", "did the portal accept the filing", "is this recipe shape
// allowed to carry a final submit" and "may automation click final submit". This file holds the
// labels each must REFUSE and each must ALLOW (a filter list fails both ways), and runs them
// through:
//   - the exported predicates;
//   - the SAME predicates evaluated from PORTAL_SAFETY_IN_PAGE_SOURCE (the bytes a portal page
//     runs) in a separate VM context — so the page copy cannot drift from the Node copy;
//   - the capture wrappers that adopted them: humanCapture's sink and payloadToStep, and the
//     recorder's createRecorderSink / finalizeRecordedSteps;
//   - the older copies still living in the adapters (learn-side isPayFee, replay-side
//     PAY_FEE_REPLAY_GATE) — parity, until those adapters adopt the shared module.
//
// Kill test: drop "continue application" from the shared module and the submit, recorder and
// human-capture checks go red.
//
//   npx tsx portal-bot/src/portalSafety.test.ts
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  classifyRecordedClick,
  classifySubmissionText,
  finalSubmitEnvAllows,
  finalSubmitRefusals,
  isFinalSubmitControl,
  isPayFee,
  isPaymentField,
  isRecipeShapeValid,
  isSecretField,
  isSubmitIntent,
  isSubmitOrPayRequestUrl,
  mayClickFinalSubmit,
  PORTAL_SAFETY_IN_PAGE_SOURCE,
  validateRecipeShape,
  type FieldIdentity,
  type FinalSubmitContext,
  type PortalSafety,
  type ShapeStep,
} from "../../shared/src/portalSafety";
import type { RecipeStep } from "../../shared/src/types";
import { createHumanCaptureSink, HUMAN_SUBMIT_OBSERVED_NOTE, payloadToStep } from "./humanCapture";
import { createRecorderSink, finalizeRecordedSteps } from "./recordRecipe";
import { NetworkRecorder } from "./networkRecorder";
import { PAY_FEE_REPLAY_GATE } from "./adapters/recipeAdapter";
import { isPayFee as learnIsPayFee } from "./adapters/autoLearnAdapter";

let failures = 0;
let passes = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passes++; console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

// ---------------------------------------------------------------------------------------------
// The golden lists
// ---------------------------------------------------------------------------------------------

/** Submit intent with NO page context (unknown falls to "submit"). */
const SUBMIT_MUST_REFUSE = [
  "Submit", "Submit Application", "File Application", "Finalize", "Finalise", "Finish",
  "Confirm Submission", "Complete Submission", "Place Order", "Send Application", "Complete Application",
  "Submit Documents", "Submit for Review", "Submit Now",
  // Accela's page advance — on the review page the SAME control files the permit.
  "Continue Application", "Continue Application »",
];
const SUBMIT_MUST_ALLOW = [
  "Next", "Continue", "Save and Continue", "Save & Next", "Proceed", "Next Step", "Save Draft", "Back",
  "Upload Document", "Search", "Add Equipment", "Cancel", "Submittal Type", "Resubmittal Documents",
  "Finished Floor Elevation", "Complete", "Applications", "",
];

/** Pay / fee (the click-blocking list). The paymentGate corpora, plus. */
const PAY_MUST_REFUSE = [
  "Pay and Submit Application", "Submit Payment", "Pay Fees and Submit", "Pay Fee", "Pay Now", "Submit & Pay",
  "Submit and Pay", "Make Payment", "Proceed to Payment", "Proceed to Checkout", "Checkout", "Add to Cart",
  "Remit Invoice", "Fees Due", "Pay $50.00", "Pay", "Pay Later", "Pay Balance", "Pay by Credit Card",
  "Review and Pay", "Confirm and Pay", "Agree and Pay", "Submit Application and Pay", "Place Order",
  "Submit Order", "Complete Purchase", "Buy Now", "Continue and Pay", "Continue to Payment", "Next — Pay Fees",
  "View Invoices",
];
const PAY_MUST_ALLOW = [
  "Next", "Continue", "Save and Continue", "Submit Application", "Submit", "Upload Document", "Add Equipment",
  "Select Utility", "Payee Name", "Company Name", "Repay", "Payroll", "Sort Order", "Work Order", "Order Status",
  "Fee Schedule",
];

/** THE filing click, with and without page context. */
const FINAL_MUST_BE: Array<[string, { readOnlyPage?: boolean; formDataEntered?: boolean } | undefined]> = [
  ["Submit", undefined], ["Submit Application", undefined], ["Submit & Pay", undefined], ["submit and pay", undefined],
  ["Confirm Submission", undefined], ["Complete Submission", undefined], ["File Application", undefined],
  ["Submit Now", undefined],
  ["Continue Application", { readOnlyPage: true }], ["Continue Application »", { readOnlyPage: true, formDataEntered: true }],
];
const FINAL_MUST_NOT_BE: Array<[string, { readOnlyPage?: boolean; formDataEntered?: boolean } | undefined]> = [
  ["Submit Documents", undefined], ["Submit for Review", undefined], ["Save and Submit Later", undefined],
  ["Pay Now", undefined], ["Submit Payment", undefined], ["Next", undefined], ["Continue", { readOnlyPage: true }],
  // Unknown page: the capture must not disarm on every Accela page.
  ["Continue Application", undefined],
  ["Continue Application", { readOnlyPage: false }],
  // The entry disclaimer: read-only, nothing entered yet — a pass-through, never the filing.
  ["Continue Application »", { readOnlyPage: true, formDataEntered: false }],
];

const SECRET_MUST_REFUSE: FieldIdentity[] = [
  { type: "password", name: "ctl00$pw" }, { label: "Password" }, { name: "ctl00$txtPassword" },
  { label: "Account Number" }, { name: "accountNumber" }, { name: "acctNo" }, { label: "Utility Account" },
  { label: "Account #" }, { label: "Meter Number" }, { label: "Meter #" }, { label: "Meter" }, { label: "Electric Meter:" },
  { id: "meterId" }, { label: "SSN" }, { label: "Social Security Number" }, { label: "Routing Number" },
  { label: "Bank Account" }, { label: "Tax ID" }, { label: "EIN" }, { label: "Verification Code" },
  { autocomplete: "one-time-code" }, { autocomplete: "current-password" }, { label: "One-Time Passcode" },
  { label: "OTP" }, { label: "PIN" }, { label: "Service Agreement ID" }, { label: "Card Number" }, { label: "CVV" },
  { label: "Security Code" }, { placeholder: "Enter your MFA code" },
];
const SECRET_MUST_ALLOW: FieldIdentity[] = [
  { label: "Account Holder Name" }, { label: "Account Holder" }, { label: "Account Type" }, { label: "Meter Location" },
  { name: "parameterValue" }, { label: "Parameter" }, { label: "Submeter installed?" }, { label: "Email" },
  { label: "Project Name" }, { label: "Contractor License Number" }, { label: "Main Breaker Size" },
  { label: "Username", type: "text" }, { label: "Company Name" }, { label: "Application Number" }, {},
];

const PAYMENT_MUST_REFUSE: FieldIdentity[] = [
  { label: "CVV:" }, { label: "CVC" }, { label: "Card Number" }, { label: "Name on Card" }, { label: "Cardholder Name" },
  { label: "Expiration Month" }, { label: "Expiry Year" }, { label: "Card Type" }, { label: "Credit Card" },
  { autocomplete: "cc-number" }, { autocomplete: "cc-exp" }, { label: "Card Expiration Date" }, { label: "Billing Zip" },
  { name: "ccExpMonth" },
];
const PAYMENT_MUST_ALLOW: FieldIdentity[] = [
  { label: "Contractor License Expiration Date" }, { label: "Expiration Date" }, { label: "Amount" },
  { label: "Fees Due" }, { label: "Permit Fee" }, { label: "Account Number" }, { label: "Job Description" }, {},
];

const ACCEPTED_TEXT = [
  "Your application has been successfully submitted. Record Number: 187-26-000309-STR",
  "Thank you for your submission. Confirmation Number: APP-004521",
  "Application was submitted",
  "Submission complete",
  "Your request has been received and is being processed.",
];
const REJECTED_TEXT = [
  "Please correct the following errors: Email is required",
  "Your application could not be submitted.",
  "There was a problem with your submission.",
  "Submission failed. Try again later.",
];
const UNKNOWN_TEXT = [
  "", "   ", "Loading...",
  "Please review all information before you submit.",
  "Enter the verification code we sent to your phone",
  "Please verify you are human",
  "Status: Submitted",
  // Positive AND negative evidence at once is not acceptance.
  "Your application has been submitted. There was a problem uploading one document.",
];

// ---------------------------------------------------------------------------------------------
// The page copy — PORTAL_SAFETY_IN_PAGE_SOURCE, evaluated in its own context
// ---------------------------------------------------------------------------------------------

const sandbox: Record<string, unknown> = {};
vm.createContext(sandbox);
vm.runInContext(PORTAL_SAFETY_IN_PAGE_SOURCE, sandbox);
const pageCopy = sandbox.__portalSafety as PortalSafety;

await check("the in-page source installs the predicates as a frozen, non-writable global", () => {
  assert.ok(pageCopy && typeof pageCopy.isSubmitIntent === "function", "window.__portalSafety was not installed");
  vm.runInContext("try { globalThis.__portalSafety = { isSubmitIntent: () => false }; } catch (e) {}", sandbox);
  assert.equal(sandbox.__portalSafety, pageCopy, "a page script replaced the predicates");
  assert.ok(Object.isFrozen(pageCopy), "the installed object is mutable");
});

// ---------------------------------------------------------------------------------------------
// Submit intent
// ---------------------------------------------------------------------------------------------

await check("SUBMIT MUST REFUSE (Node and page copy)", () => {
  for (const l of SUBMIT_MUST_REFUSE) {
    assert.ok(isSubmitIntent(l), `"${l}" is not submit intent`);
    assert.ok(pageCopy.isSubmitIntent(l), `page copy: "${l}" is not submit intent`);
  }
});
await check("SUBMIT MUST ALLOW (Node and page copy)", () => {
  for (const l of SUBMIT_MUST_ALLOW) {
    assert.ok(!isSubmitIntent(l), `"${l}" is refused as submit — over-refusal stalls a real page`);
    assert.ok(!pageCopy.isSubmitIntent(l), `page copy: "${l}" refused`);
  }
});
await check("'Continue Application' is allowed ONLY when the page is KNOWN fillable or KNOWN pre-data", () => {
  assert.ok(isSubmitIntent("Continue Application", {}), "unknown context must read as submit");
  assert.ok(isSubmitIntent("Continue Application", { readOnlyPage: true }), "read-only page");
  assert.ok(!isSubmitIntent("Continue Application", { readOnlyPage: false }), "known fillable page");
  assert.ok(!isSubmitIntent("Continue Application »", { readOnlyPage: true, formDataEntered: false }), "entry disclaimer");
  assert.ok(isSubmitIntent("Submit", { readOnlyPage: false }), "a real submit word is never excused by context");
});

// ---------------------------------------------------------------------------------------------
// Pay / fee
// ---------------------------------------------------------------------------------------------

await check("PAY MUST REFUSE (shared, page copy, and parity with the replay gate + learn isPayFee)", () => {
  for (const l of PAY_MUST_REFUSE) {
    assert.ok(isPayFee(l), `shared isPayFee("${l}") is false`);
    assert.ok(pageCopy.isPayFee(l), `page copy isPayFee("${l}") is false`);
  }
  for (const l of PAY_MUST_REFUSE.filter((x) => x !== "View Invoices")) {
    assert.ok(PAY_FEE_REPLAY_GATE.test(l), `replay gate drifted: "${l}" passes it`);
    assert.ok(learnIsPayFee(l), `learn-side isPayFee drifted: "${l}" passes it`);
  }
});
await check("PAY MUST ALLOW (shared, page copy, and the replay gate)", () => {
  for (const l of PAY_MUST_ALLOW) {
    assert.ok(!isPayFee(l), `shared isPayFee("${l}") refuses an ordinary control`);
    assert.ok(!pageCopy.isPayFee(l), `page copy refuses "${l}"`);
    assert.ok(!PAY_FEE_REPLAY_GATE.test(l), `replay gate refuses "${l}"`);
  }
});

// ---------------------------------------------------------------------------------------------
// The filing click and the recorded-click classifier
// ---------------------------------------------------------------------------------------------

await check("FINAL SUBMIT: the filing click is recognised, the mid-flow submit is not", () => {
  for (const [l, ctx] of FINAL_MUST_BE) {
    assert.ok(isFinalSubmitControl(l, ctx), `"${l}" ${JSON.stringify(ctx ?? {})} is not the filing click`);
    assert.ok(pageCopy.isFinalSubmitControl(l, ctx), `page copy: "${l}"`);
  }
  for (const [l, ctx] of FINAL_MUST_NOT_BE) {
    assert.ok(!isFinalSubmitControl(l, ctx), `"${l}" ${JSON.stringify(ctx ?? {})} wrongly counts as the filing click`);
  }
});
await check("recorded clicks: capture / blocked / finalSubmit", () => {
  assert.equal(classifyRecordedClick("Next"), "capture");
  assert.equal(classifyRecordedClick("Continue Application", { readOnlyPage: false }), "capture");
  assert.equal(classifyRecordedClick("Continue Application"), "blocked");
  assert.equal(classifyRecordedClick("Continue Application", { readOnlyPage: true }), "finalSubmit");
  assert.equal(classifyRecordedClick("Submit Documents"), "blocked");
  assert.equal(classifyRecordedClick("Pay Fees"), "blocked");
  assert.equal(classifyRecordedClick("Place Order"), "blocked");
  assert.equal(classifyRecordedClick("Submit"), "finalSubmit");
  for (const l of [...SUBMIT_MUST_REFUSE, ...PAY_MUST_REFUSE]) {
    assert.notEqual(classifyRecordedClick(l), "capture", `"${l}" would be captured as a replayable click`);
  }
});

// ---------------------------------------------------------------------------------------------
// Secret and payment fields
// ---------------------------------------------------------------------------------------------

await check("SECRET MUST REFUSE (Node and page copy)", () => {
  for (const f of SECRET_MUST_REFUSE) {
    assert.ok(isSecretField(f), `${JSON.stringify(f)} is not treated as a secret`);
    assert.ok(pageCopy.isSecretField(f), `page copy: ${JSON.stringify(f)}`);
  }
});
await check("SECRET MUST ALLOW (Node and page copy) — project data the planner must still see", () => {
  for (const f of SECRET_MUST_ALLOW) {
    assert.ok(!isSecretField(f), `${JSON.stringify(f)} is wrongly treated as a secret`);
    assert.ok(!pageCopy.isSecretField(f), `page copy: ${JSON.stringify(f)}`);
  }
});
await check("PAYMENT FIELD MUST REFUSE / MUST ALLOW", () => {
  for (const f of PAYMENT_MUST_REFUSE) {
    assert.ok(isPaymentField(f), `${JSON.stringify(f)} is not a payment field`);
    assert.ok(pageCopy.isPaymentField(f), `page copy: ${JSON.stringify(f)}`);
  }
  for (const f of PAYMENT_MUST_ALLOW) {
    assert.ok(!isPaymentField(f), `${JSON.stringify(f)} is wrongly a payment field`);
  }
  assert.ok(isPaymentField({ label: "Expiration Date" }, { cardFieldNearby: true }), "a bare expiry beside a card field IS the card's");
  assert.ok(!isPaymentField({ label: "Expiration Date" }, { cardFieldNearby: false }), "a bare expiry alone is a licence date");
});

// ---------------------------------------------------------------------------------------------
// Submission outcome — positive evidence only
// ---------------------------------------------------------------------------------------------

await check("classifySubmissionText: accepted / rejected / unknown", () => {
  for (const t of ACCEPTED_TEXT) assert.equal(classifySubmissionText(t).verdict, "accepted", `"${t}"`);
  for (const t of REJECTED_TEXT) assert.equal(classifySubmissionText(t).verdict, "rejected", `"${t}"`);
  for (const t of UNKNOWN_TEXT) assert.equal(classifySubmissionText(t).verdict, "unknown", `"${t}" must be unknown`);
  assert.equal(classifySubmissionText(null).verdict, "unknown");
  assert.ok(classifySubmissionText(ACCEPTED_TEXT[0]).evidence, "an accepted verdict names its evidence");
});

// ---------------------------------------------------------------------------------------------
// Recipe shape
// ---------------------------------------------------------------------------------------------

const fill: ShapeStep = { action: "fill", selector: { label: "Name" } };
const review: ShapeStep = { action: "stopForReview" };
const flagged: ShapeStep = { action: "click", selector: { role: "button", name: "Submit" }, isFinalSubmit: true };

await check("recipe shape: valid shapes", () => {
  assert.ok(isRecipeShapeValid([]), "empty");
  assert.ok(isRecipeShapeValid([fill, review]), "no flagged step");
  assert.ok(isRecipeShapeValid([fill, review, flagged]), "one terminal flagged step after stopForReview");
  assert.deepEqual(validateRecipeShape([fill, review, flagged]), { valid: true, problems: [] });
});
await check("recipe shape: the three-flagged shape and its cousins are refused", () => {
  const threeFlagged = [flagged, fill, flagged, review, flagged];
  assert.ok(!isRecipeShapeValid(threeFlagged), "three flagged steps (c1ada057's shape)");
  assert.ok(validateRecipeShape(threeFlagged).problems.some((p) => /3 steps/.test(p)));
  assert.ok(!isRecipeShapeValid([fill, review, flagged, fill]), "flagged step not last");
  assert.ok(!isRecipeShapeValid([fill, flagged]), "no stopForReview before it");
  assert.ok(!isRecipeShapeValid([flagged]), "flagged step alone");
  assert.ok(!isRecipeShapeValid([fill, review, fill, flagged]), "stopForReview not IMMEDIATELY before it");
  assert.ok(!isRecipeShapeValid([fill, review, { action: "fill", isFinalSubmit: true }]), "flagged step is not a click");
});

// ---------------------------------------------------------------------------------------------
// May automation click final submit?
// ---------------------------------------------------------------------------------------------

const allowed: FinalSubmitContext = {
  envAllows: true, runApproval: { approver: "A. Operator", runId: "run-1" }, runId: "run-1",
  stepIsTerminalFlagged: true, recipeShapeValid: true,
};
await check("mayClickFinalSubmit: all four conditions, and only then", () => {
  assert.equal(mayClickFinalSubmit(allowed), true);
  assert.equal(typeof mayClickFinalSubmit(allowed), "boolean", "a gate that returns an object is always truthy");
  const off: Array<[string, FinalSubmitContext]> = [
    ["env switch off", { ...allowed, envAllows: false }],
    ["no approval", { ...allowed, runApproval: null }],
    ["blank approver", { ...allowed, runApproval: { approver: "  ", runId: "run-1" } }],
    ["approval for another run", { ...allowed, runApproval: { approver: "A. Operator", runId: "run-0" } }],
    ["empty run ids", { ...allowed, runId: "", runApproval: { approver: "A. Operator", runId: "" } }],
    ["not the terminal flagged step", { ...allowed, stepIsTerminalFlagged: false }],
    ["invalid recipe shape", { ...allowed, recipeShapeValid: false }],
  ];
  for (const [why, ctx] of off) {
    assert.equal(mayClickFinalSubmit(ctx), false, `allowed with ${why}`);
    assert.ok(finalSubmitRefusals(ctx).length > 0, `no refusal reason for ${why}`);
  }
  assert.equal(mayClickFinalSubmit(null), false);
  assert.equal(mayClickFinalSubmit(undefined), false);
  // Truthy-but-not-true values must not open the gate.
  assert.equal(mayClickFinalSubmit({ ...allowed, envAllows: 1 as unknown as boolean }), false, "envAllows must be exactly true");
});
await check("finalSubmitEnvAllows reads exactly '1'", () => {
  assert.equal(finalSubmitEnvAllows({ PORTAL_ALLOW_FINAL_SUBMIT: "1" }), true);
  for (const v of [undefined, "", "0", "true", "yes", "on", "01"]) {
    assert.equal(finalSubmitEnvAllows({ PORTAL_ALLOW_FINAL_SUBMIT: v }), false, `"${v}"`);
  }
});

// ---------------------------------------------------------------------------------------------
// The wrappers that adopted the shared predicates
// ---------------------------------------------------------------------------------------------

await check("humanCapture: no submit/pay-worded click ever becomes a replayable step", () => {
  for (const l of [...SUBMIT_MUST_REFUSE, ...PAY_MUST_REFUSE]) {
    const step = payloadToStep({ kind: "click", selector: { role: "button", name: l }, label: l });
    assert.equal(step, null, `payloadToStep turned "${l}" into a step`);
  }
  assert.ok(payloadToStep({ kind: "click", selector: { role: "button", name: "Next" }, label: "Next" }), "an ordinary click still maps");
});
await check("humanCapture sink: the filing click signals ONCE and disarms; a mid-flow submit does neither", () => {
  const got: RecipeStep[] = [];
  const sink = createHumanCaptureSink((s) => got.push(s));
  sink({ kind: "click", selector: {}, label: "Submit Documents" });
  sink({ kind: "fill", selector: { label: "Job" }, label: "Job", value: "PV", identity: { label: "Job" } });
  assert.equal(got.length, 1, "a mid-flow submit must not disarm the capture");
  sink({ kind: "click", selector: {}, label: "Continue Application", readOnlyPage: false });
  assert.equal(got.length, 2, "Accela's advance on a fillable page is captured as navigation");
  sink({ kind: "click", selector: {}, label: "Continue Application »", readOnlyPage: true });
  sink({ kind: "click", selector: {}, label: "Submit" });
  sink({ kind: "fill", selector: { label: "After" }, label: "After", value: "x", identity: { label: "After" } });
  const signals = got.filter((s) => s.note === HUMAN_SUBMIT_OBSERVED_NOTE);
  assert.equal(signals.length, 1, `expected one submitObserved signal, got ${signals.length}`);
  assert.equal(got.length, 3, "nothing is captured after the filing click");
});
await check("humanCapture: secret identity marks the fill sensitive; ordinary identity does not", () => {
  const acct = payloadToStep({ kind: "fill", selector: { label: "Utility Account Number" }, label: "Utility Account Number", value: "3091", identity: { label: "Utility Account Number", name: "account_number" } });
  assert.equal(acct?.sensitive, true);
  const holder = payloadToStep({ kind: "fill", selector: { label: "Account Holder Name" }, label: "Account Holder Name", value: "Jo", identity: { label: "Account Holder Name" } });
  assert.notEqual(holder?.sensitive, true, "Account Holder Name is project data");
});

await check("recorder sink: Accela's advance is navigation mid-flow, a placeholder when unknown, the filing click on review", () => {
  const steps: RecipeStep[] = [];
  const sink = createRecorderSink(steps, () => undefined);
  // Entry disclaimer: read-only page, nothing entered yet -> a pass-through click.
  sink({ kind: "click", selector: { role: "link", name: "Continue Application »" }, label: "Continue Application »", readOnlyPage: true });
  assert.equal(steps[0].action, "click");
  assert.ok(steps[0].selector && Object.keys(steps[0].selector).length > 0, "the disclaimer's Continue must stay replayable");
  sink({ kind: "fill", selector: { label: "Job" }, label: "Job", value: "PV", identity: { label: "Job" } });
  sink({ kind: "click", selector: { role: "link", name: "Continue Application »" }, label: "Continue Application »", readOnlyPage: false });
  assert.ok(Object.keys(steps[2].selector ?? {}).length > 0, "mid-flow advance on a fillable page is replayable");
  sink({ kind: "click", selector: { role: "link", name: "Continue Application »" }, label: "Continue Application »" });
  assert.deepEqual(steps[3].selector, {}, "unknown page: a targetless placeholder, never a replayable filing click");
  assert.notEqual(steps[3].isFinalSubmit, true);
  sink({ kind: "click", selector: { role: "link", name: "Continue Application »" }, label: "Continue Application »", readOnlyPage: true });
  assert.deepEqual(steps[4].selector, {});
  assert.equal(steps[4].isFinalSubmit, true, "the review page's Continue Application is the filing click");
  for (const l of [...SUBMIT_MUST_REFUSE, ...PAY_MUST_REFUSE]) {
    const before = steps.length;
    sink({ kind: "click", selector: { role: "button", name: l }, label: l });
    assert.deepEqual(steps[before].selector, {}, `the recorder kept a replayable selector on "${l}"`);
  }
});
await check("recorder sink: secret fields keep the step, never the literal", () => {
  const steps: RecipeStep[] = [];
  createRecorderSink(steps, () => undefined)({ kind: "fill", selector: { label: "Meter #" }, label: "Meter #", value: "M-99", identity: { label: "Meter #" } });
  assert.equal(steps[0].sensitive, true);
  assert.equal(steps[0].value, undefined, "a secret literal reached the recipe step");
});
await check("finalizeRecordedSteps always yields a valid shape", () => {
  const nav: RecipeStep = { action: "click", selector: { role: "button", name: "Next" } };
  const fin: RecipeStep = { action: "click", selector: {}, optional: true, isFinalSubmit: true, note: "BLOCKED" };
  const shapes: RecipeStep[][] = [[], [nav], [nav, fin], [fin, nav, fin], [fin, nav], [fin, fin, fin]];
  for (const s of shapes) {
    const out = finalizeRecordedSteps(s);
    assert.ok(isRecipeShapeValid(out), `${JSON.stringify(s.map((x) => x.isFinalSubmit ? "F" : x.action))} -> ${JSON.stringify(validateRecipeShape(out).problems)}`);
    assert.ok(out.some((x) => x.action === "stopForReview"), "no stopForReview marker");
  }
  const kept = finalizeRecordedSteps([nav, fin]);
  assert.equal(kept[kept.length - 1].isFinalSubmit, true, "a terminal filing click keeps its flag after the marker");
});

await check("network recorder flags filing and payment URLs through the shared predicate", () => {
  for (const u of ["https://x.test/Project/SubmitApplication", "https://x.test/api/Payment", "https://x.test/Cap/ContinueApplication.aspx", "https://x.test/cart/checkout"]) {
    assert.ok(isSubmitOrPayRequestUrl(u), u);
  }
  for (const u of ["https://x.test/api/SaveField", "https://x.test/Project/UpdateSection", ""]) {
    assert.ok(!isSubmitOrPayRequestUrl(u), u);
  }
  const rec = new NetworkRecorder({ fieldValues: {} });
  const handlers: Record<string, (r: unknown) => void> = {};
  rec.attach({ on: (ev: string, fn: (r: unknown) => void) => { handlers[ev] = fn; } });
  const req = (url: string) => ({ method: () => "POST", url: () => url, resourceType: () => "xhr", headers: () => ({}), postData: () => "" });
  handlers.request(req("https://x.test/Cap/ContinueApplication"));
  handlers.request(req("https://x.test/api/SaveField"));
  const built = rec.build({ scopeType: "ahj", profileKey: "k", state: "", ahj: "", utility: "", portalPlatform: "", portalUrl: "", createdBy: "t", nowIso: "2026-01-01" });
  assert.equal(built.requests[0].isFinalSubmit, true, "ContinueApplication request not flagged");
  assert.notEqual(built.requests[1].isFinalSubmit, true, "an ordinary save was flagged");
});

console.log(failures === 0
  ? `\nAll ${passes} portal-safety checks passed.`
  : `\n${failures} of ${passes + failures} portal-safety check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
