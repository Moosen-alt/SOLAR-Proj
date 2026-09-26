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
  isReviewPageText,
  isSecretField,
  isSubmitIntent,
  isSubmitOrPayRequestUrl,
  mayClickFinalSubmit,
  PORTAL_SAFETY_IN_PAGE_SOURCE,
  recordingHasFormData,
  validateRecipeShape,
  type ControlContext,
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
  // Filing verbs that are not "submit" (foundation verdict, probe A): the correction flow files
  // with "Resubmit"; a signature step files with "Sign and File"; "e-File", "File Permit".
  "Resubmit", "Resubmit Application", "Re-submit", "Refile", "Sign and File", "Sign & Submit", "e-File", "eFile",
  "File Permit", "File Permit Application",
  // A control whose whole label is "File" (a form's default button, replay skeptic MF3).
  "File", "File now", "File »",
];
const SUBMIT_MUST_ALLOW = [
  "Next", "Continue", "Save and Continue", "Save & Next", "Proceed", "Next Step", "Save Draft", "Back",
  "Upload Document", "Search", "Add Equipment", "Cancel", "Submittal Type", "Resubmittal Documents",
  "Finished Floor Elevation", "Complete", "Applications", "",
  // MUST-ALLOW beside the new filing verbs: a correction flow's type picker, and file widgets.
  "Resubmittal Type", "Resubmittal", "Refiled Date", "Profile", "File Upload", "Upload File", "File Name", "Select File",
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
const FINAL_MUST_BE: Array<[string, ControlContext | undefined]> = [
  ["Submit", undefined], ["Submit Application", undefined], ["Submit & Pay", undefined], ["submit and pay", undefined],
  ["Confirm Submission", undefined], ["Complete Submission", undefined], ["File Application", undefined],
  ["Submit Now", undefined],
  // Accela's advance files on the page that NAMES itself the review step — read-only or not (a
  // review page with a signature box or an attachment widget still files).
  ["Continue Application", { reviewPage: true }], ["Continue Application »", { readOnlyPage: true, formDataEntered: true, reviewPage: true }],
  ["Continue Application »", { readOnlyPage: false, formDataEntered: true, reviewPage: true }],
  ["Resubmit", undefined], ["Resubmit Application", undefined], ["Sign and File", undefined], ["e-File", undefined],
  ["File Permit", undefined],
];
const FINAL_MUST_NOT_BE: Array<[string, ControlContext | undefined]> = [
  ["Submit Documents", undefined], ["Submit for Review", undefined], ["Save and Submit Later", undefined],
  // A bare "File" is BLOCKED (submit-worded) but not proven to be THE filing click: it must not
  // end a capture session or promote a draft on a guess.
  ["File", undefined], ["File now", undefined],
  ["Pay Now", undefined], ["Submit Payment", undefined], ["Next", undefined], ["Continue", { readOnlyPage: true }],
  // Unknown page: the capture must not disarm on every Accela page.
  ["Continue Application", undefined],
  ["Continue Application", { readOnlyPage: false }],
  // The entry disclaimer: read-only, nothing entered yet — a pass-through, never the filing.
  ["Continue Application »", { readOnlyPage: true, formDataEntered: false }],
  // Read-only but NOT named a review page (an attachments-only step; wording we do not know):
  // blocked by isSubmitIntent, but not PROVEN the filing — no disarm, no draft promotion.
  ["Continue Application", { readOnlyPage: true }],
  ["Continue Application »", { readOnlyPage: true, formDataEntered: true, reviewPage: false }],
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
  // Utility identifiers of one customer's service (foundation verdict, probe A).
  { label: "SA ID" }, { name: "saId" }, { label: "Service Point ID" }, { name: "servicePointId" }, { label: "Premise ID" },
  { label: "Premise Number" }, { label: "ESI ID" }, { label: "Customer Number" }, { label: "Customer #" }, { name: "customerNo" },
];
const SECRET_MUST_ALLOW: FieldIdentity[] = [
  { label: "Account Holder Name" }, { label: "Account Holder" }, { label: "Account Type" }, { label: "Meter Location" },
  { name: "parameterValue" }, { label: "Parameter" }, { label: "Submeter installed?" }, { label: "Email" },
  { label: "Project Name" }, { label: "Contractor License Number" }, { label: "Main Breaker Size" },
  { label: "Username", type: "text" }, { label: "Company Name" }, { label: "Application Number" }, {},
  { label: "Customer Name" }, { label: "Customer Type" }, { label: "Premise Address" }, { label: "Service Point Location" },
  { label: "Accounting Contact" }, { label: "Pinellas County" }, { label: "Resale ID Type" },
  // "acct" abbreviates "account" and takes the same name-ish exclusions.
  { id: "acctType" }, { name: "acctHolderName" }, { label: "Account Type", name: "accountType", id: "acctType", type: "select-one" },
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
  // A record number alone, in the shapes the verdict names as MUST-PASS.
  "Record Number: 187-26-000309-STR",
  "Confirmation #: APP-111667",
  "Permit # BLD2026-00123 was issued to your account.",
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
  // A record-number LABEL is not a record number (foundation verdict: every one of these read
  // "accepted" because the token check ran under /i and took any four-letter word).
  "Record ID will be assigned after submission",
  "Project Number: pending",
  "Permit Number Type",
  "Case Number Status Open",
  "Application Number TBD",
  "Your confirmation number will be emailed to you after you submit",
  "Record Number: 2026-0042 will be assigned when the review completes",
  "Permit Number: BLD-2026-0042 (pending)",
  // An upper-case placeholder has no digit; a lower-case hex session/trace id is not an issued number.
  "Permit Number: PENDING",
  "Application ID: NONE",
  "Tracking ID: 5f3a9c2e-7d41",
  // A page that still asks for the submit cancels record-number-only evidence.
  "Review your application before submitting. Project ID: PGE-INT-12345",
  "Draft application. Application ID: 12345. Click Submit to file.",
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
  // A page that names itself the review step is never excused — not by a live signature box,
  // not by an empty recording (a resumed draft's review page).
  assert.ok(isSubmitIntent("Continue Application", { readOnlyPage: false, reviewPage: true }), "review page with a live field");
  assert.ok(isSubmitIntent("Continue Application »", { readOnlyPage: true, formDataEntered: false, reviewPage: true }), "review page, nothing entered in THIS session");
  assert.ok(isSubmitIntent("Continue Application »", { readOnlyPage: true, formDataEntered: undefined }), "mid-flow session, read-only page");
});
await check("isReviewPageText: the page NAMES itself the review step (MUST-MATCH / MUST-NOT)", () => {
  const MUST = ["Step 3: Review", "Step 4 - Review", "STEP 3 : REVIEW", "Review and Submit", "Review & Submit",
    "Review your application", "Review all of the information below", "Your form will not be submitted until you click Submit",
    // The captured review page names itself AND carries locked sections: still the review page.
    "Step 4 : Review Site Address (Read-only) Parcel (Read-only) Owner (Read-only) Continue Application »"];
  const NOT = ["Please review the terms and conditions below", "I accept the terms and conditions", "Plan Review Fee", "Review Type",
    "Step 2: Project Information", "Resubmittal Review Comments", "Reviewer", "", "Step 3: Documents",
    // A locked section is not the page naming itself — Oregon ePermitting Step 1 after the address pick
    // (production false stop, City of Jefferson 2026-09-26), with the wizard bar listing Review and Pay Fees ahead.
    "Contact Information (Read-only)",
    "ePermit 1 General Info 2 Services 3 Review 4 Pay Fees 5 Completion Step 1 : General Info > Site Address Information Site Address (Read-only) Parcel (Read-only) Owner (Read-only) Continue Application » Save and resume later"];
  for (const t of MUST) { assert.ok(isReviewPageText(t), `"${t}" is not a review page`); assert.ok(pageCopy.isReviewPageText(t), `page copy: "${t}"`); }
  for (const t of NOT) { assert.ok(!isReviewPageText(t), `"${t}" wrongly reads as a review page`); assert.ok(!pageCopy.isReviewPageText(t), `page copy: "${t}"`); }
});
await check("recordingHasFormData: fills/selects/checks count; a terms tick and clicks do not", () => {
  assert.equal(recordingHasFormData([]), false);
  assert.equal(recordingHasFormData([{ action: "click", selector: { name: "Next" } }]), false);
  assert.equal(recordingHasFormData([{ action: "check", note: "I agree to the terms and conditions" }]), false, "the disclaimer's agree box is not form data");
  assert.equal(recordingHasFormData([{ action: "check", selector: { name: "Solar PV" } }]), true);
  assert.equal(recordingHasFormData([{ action: "fill", selector: { label: "Job" } }]), true);
  assert.equal(recordingHasFormData([{ action: "select", selector: {} }]), true);
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
  assert.equal(classifyRecordedClick("Continue Application", { readOnlyPage: true }), "blocked", "read-only, not named review: blocked, not proven filing");
  assert.equal(classifyRecordedClick("Continue Application", { readOnlyPage: true, reviewPage: true }), "finalSubmit");
  assert.equal(classifyRecordedClick("Continue Application", { readOnlyPage: false, reviewPage: true }), "finalSubmit", "a live field does not excuse a review page");
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
  sink({ kind: "click", selector: {}, label: "Continue Application »", readOnlyPage: true, reviewPage: true });
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
  // The CLI opened --url itself, so it KNOWS the recording starts fresh (the default is unknown).
  const sink = createRecorderSink(steps, () => undefined, { startsFresh: true });
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
  sink({ kind: "click", selector: { role: "link", name: "Continue Application »" }, label: "Continue Application »", readOnlyPage: true, reviewPage: true });
  assert.deepEqual(steps[4].selector, {});
  assert.equal(steps[4].isFinalSubmit, true, "the review page's Continue Application is the filing click");
  // Read-only after data, but not named review (an attachments-only step): blocked, unflagged.
  sink({ kind: "click", selector: { role: "link", name: "Continue Application »" }, label: "Continue Application »", readOnlyPage: true, reviewPage: false });
  assert.deepEqual(steps[5].selector, {}, "a read-only page's Continue Application stayed replayable");
  assert.notEqual(steps[5].isFinalSubmit, true);
  steps.splice(5, 1);
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
await check("F1 humanCapture: formDataEntered from the SAME predicate as the recorder; a mid-flow session keeps it unknown", () => {
  const CONT = "Continue Application »";
  // Production shape: armed AT REVIEW, no steps seen. The review page (named review, read-only
  // with an attachment widget) -> the filing click: one signal, never a replayable step.
  {
    const got: RecipeStep[] = [];
    const sink = createHumanCaptureSink((s) => got.push(s));
    sink({ kind: "click", selector: { role: "link", name: CONT }, label: CONT, readOnlyPage: true, reviewPage: true });
    assert.equal(got.length, 1); assert.equal(got[0].note, HUMAN_SUBMIT_OBSERVED_NOTE, "mid-flow review page: not observed as the filing");
  }
  // MUST-EXCLUDE the old inversion: mid-flow, zero emitted steps must NOT read as "nothing
  // entered" — a read-only page's Continue Application is never captured as navigation.
  {
    const got: RecipeStep[] = [];
    createHumanCaptureSink((s) => got.push(s))({ kind: "click", selector: { role: "link", name: CONT }, label: CONT, readOnlyPage: true, reviewPage: false });
    assert.equal(got.length, 0, `mid-flow read-only page: ${JSON.stringify(got)} (captured, or a signal on a guess)`);
  }
  // MUST-PASS: a session KNOWN to start fresh -> the entry disclaimer's advance is navigation,
  // no signal, no disarm; after a fill, an unnamed read-only page is blocked; the review page files.
  {
    const got: RecipeStep[] = [];
    const sink = createHumanCaptureSink((s) => got.push(s), { startsFresh: true });
    sink({ kind: "check", selector: { role: "checkbox", name: "I agree to the terms and conditions" }, label: "I agree to the terms and conditions" });
    sink({ kind: "click", selector: { role: "link", name: CONT }, label: CONT, readOnlyPage: true, reviewPage: false });
    assert.ok(got.some((s) => s.action === "click" && Object.keys(s.selector ?? {}).length > 0), `fresh disclaimer advance not captured: ${JSON.stringify(got)}`);
    assert.ok(!got.some((s) => s.note === HUMAN_SUBMIT_OBSERVED_NOTE), "fresh disclaimer advance signalled a submit");
    sink({ kind: "fill", selector: { label: "Job" }, label: "Job", value: "PV", identity: { label: "Job" } });
    const n = got.length;
    sink({ kind: "click", selector: { role: "link", name: CONT }, label: CONT, readOnlyPage: true, reviewPage: false });
    assert.equal(got.length, n, "after data, an unnamed read-only page's advance was captured");
    sink({ kind: "click", selector: { role: "link", name: CONT }, label: CONT, readOnlyPage: true, reviewPage: true });
    assert.equal(got[got.length - 1].note, HUMAN_SUBMIT_OBSERVED_NOTE, "the review page's advance did not signal the filing");
  }
});
await check("F1 recorder: a recording that may start mid-flow keeps formDataEntered unknown; a named review page files even with nothing entered", () => {
  const CONT = "Continue Application »";
  const steps: RecipeStep[] = [];
  const sink = createRecorderSink(steps, () => undefined, { startsFresh: false });
  sink({ kind: "click", selector: { role: "link", name: CONT }, label: CONT, readOnlyPage: true, reviewPage: false });
  assert.deepEqual(steps[0].selector, {}, "not-fresh recorder captured a read-only page's advance as navigation");
  const fresh: RecipeStep[] = [];
  createRecorderSink(fresh, () => undefined)({ kind: "click", selector: { role: "link", name: CONT }, label: CONT, readOnlyPage: true, reviewPage: true });
  assert.deepEqual(fresh[0].selector, {}, "a resumed draft's REVIEW page advance was captured as navigation");
  assert.equal(fresh[0].isFinalSubmit, true);
});
await check("F1 recorder default (recorder skeptic MF3): no opts is UNKNOWN, like humanCapture — a read-only page's Continue Application is not captured; startsFresh:true captures the disclaimer advance", () => {
  const CONT = "Continue Application »";
  const payload = { kind: "click", selector: { role: "link", name: CONT }, label: CONT, readOnlyPage: true, reviewPage: false } as const;
  // MUST-EXCLUDE: a new caller that passes no opts.
  const noOpts: RecipeStep[] = [];
  createRecorderSink(noOpts, () => undefined)(payload);
  assert.equal(noOpts.length, 1);
  assert.deepEqual(noOpts[0].selector, {}, `no-opts recorder captured a read-only page's Continue Application as navigation: ${JSON.stringify(noOpts)}`);
  assert.equal(noOpts[0].optional, true);
  // MUST-PASS: the CLI that opened --url itself says so, and the entry disclaimer's advance is navigation.
  const fresh: RecipeStep[] = [];
  createRecorderSink(fresh, () => undefined, { startsFresh: true })(payload);
  assert.deepEqual(fresh[0].selector, { role: "link", name: CONT }, `fresh recorder did not capture the disclaimer advance: ${JSON.stringify(fresh)}`);
});
await check("F5: a secret <select> is sensitive in BOTH sinks — no literal, no option text; an ordinary select keeps its value", () => {
  const meterByName = { kind: "select", selector: { css: "#m" }, label: "", value: "1009283745", rawValue: "1009283745", identity: { name: "meterNumber", id: "m" } };
  const meterByLabel = { kind: "select", selector: { role: "combobox", name: "Meter Number" }, label: "Meter Number", value: "5550001111", identity: {} };
  const util = { kind: "select", selector: { role: "combobox", name: "Utility" }, label: "Utility", value: "Pacific Power", identity: { label: "Utility", id: "util" } };
  const steps: RecipeStep[] = [];
  const rec = createRecorderSink(steps, () => undefined);
  rec(meterByName); rec(meterByLabel); rec(util);
  assert.equal(steps[0].sensitive, true, "recorder: select name=meterNumber is not sensitive");
  assert.equal(steps[1].sensitive, true, "recorder: a select labelled Meter Number is not sensitive");
  assert.equal(steps[0].value, undefined); assert.equal(steps[1].value, undefined);
  assert.ok(!/1009283745|5550001111/.test(JSON.stringify(steps)), `recorder kept a secret option: ${JSON.stringify(steps)}`);
  assert.equal(steps[2].value, "Pacific Power", "recorder: an ordinary select lost its value");
  assert.notEqual(steps[2].sensitive, true);
  const hs = [meterByName, meterByLabel].map((p) => payloadToStep(p as never));
  for (const s of hs) {
    assert.equal(s?.sensitive, true, `humanCapture: ${JSON.stringify(s?.selector)} not sensitive`);
    assert.ok(!/1009283745|5550001111/.test(JSON.stringify({ selector: s?.selector, note: s?.note })), "humanCapture put the option text in the selector/note");
  }
  assert.notEqual(payloadToStep(util as never)?.sensitive, true, "humanCapture: an ordinary select became sensitive");
});
await check("F4: a click whose page could not run the shared labeler is blocked in BOTH sinks (unknown label is not 'not submit')", () => {
  const steps: RecipeStep[] = [];
  createRecorderSink(steps, () => undefined)({ kind: "click", selector: { css: "#btnSubmit" }, label: "", safetyUnavailable: true });
  assert.deepEqual(steps[0].selector, {}, "recorder kept a replayable selector on an unlabelled click from a page without the predicates");
  assert.equal(payloadToStep({ kind: "click", selector: { css: "#btnSubmit" }, label: "", safetyUnavailable: true }), null);
  const got: RecipeStep[] = [];
  createHumanCaptureSink((s) => got.push(s))({ kind: "click", selector: { css: "#btnSubmit" }, label: "", safetyUnavailable: true });
  assert.equal(got.length, 0, "humanCapture sink emitted a step for an unknown-label click");
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
