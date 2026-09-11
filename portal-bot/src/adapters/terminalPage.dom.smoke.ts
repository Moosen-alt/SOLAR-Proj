// A TERMINAL PAGE WHOSE ONLY FORWARD CONTROL IS A FINAL SUBMIT IS ITS OWN REVIEW.
//
// permiteyes.us is a 176-field SINGLE-PAGE application: no Next, no wizard, one "Submit". The
// walk fills ~60 fields, finds no advance, dies at the repeat-page stop and banks 65 steps as
// needs_rerecord -- which findCompleteRecipeForProject then ignores. Every one-page portal
// fails identically, because the engine's only definition of "the end" was a review SCREEN and
// a one-page application never shows one.
//
// This file pins the rule in BOTH directions, because the cost of getting it wrong is not a
// missed page: it is a recipe that teaches a human (or trusted auto-submit) to click a control
// that saves a draft, pays a fee, or files a half-finished application.
//
//   MUST FIRE  -- a genuine single-page application (many fields, no Next, one "Submit") is
//                 classified as its own review, the submit is recorded isFinalSubmit:true and
//                 NEVER clicked, and the form never submits. Proven through the REAL WALK.
//   HOLE 5     -- and it still never clicks it with the operator-delegation switches BOTH on.
//   MUST NOT   -- "Step 2 of 4" + "Save and Finish Later"      (hole 1)
//   MUST NOT   -- "Step 1 of 3" + a DISABLED "Next"            (hole 2)
//   MUST NOT   -- "Pay and Submit Application" / "Submit Payment" (hole 3)
//   MUST NOT   -- "Continue Application" mid-wizard            (hole 4)
//   MUST NOT   -- a page showing a live validation error
//   KILL MATRIX -- each guard is retired ON ITS OWN against a page where it is the ONLY thing
//                 refusing, and the verdict must flip. A guard whose removal breaks nothing is
//                 not a guard.
//
//   npx tsx portal-bot/src/adapters/terminalPage.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import {
  AutoLearnAdapter,
  EXTRACT_SEL,
  applyActiveScopeFilter,
  classifyTerminalSubmitPage,
  collectValidationErrorsFrom,
  extractFieldsInPage,
  isPayFee,
  resolveActiveScope,
  submitGovernsApplication,
  toExtractedField,
  type ExtractedField,
  type LearnPlanner,
  type RawField,
  type TerminalGuard,
} from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const STYLE = `<style>body{font:14px sans-serif;margin:0;padding:14px}label{display:block;margin-top:6px}
  .err{color:#b00;border:1px solid #b00;padding:6px;margin:8px 0}</style>`;

/** Six labelled text inputs. SIX and not five on purpose: pressEnterInLastFilledField refuses a
 *  page with more than five fillables ("Enter on an application form can file it"), so every
 *  page here must be past that line or the walk never reaches the classifier at all. */
const fieldBlock = (prefix: string): string =>
  ["Owner Name", "Owner Email", "Owner Phone", "Service Address", "Service City", "System Size kW"]
    .map((l, i) => {
      const id = `${prefix}${i}`;
      return `<label for="${id}">${l}</label><input id="${id}" name="${id}" type="text">`;
    })
    .join("\n    ");

const PAGES: Record<string, string> = {
  // ---- MUST FIRE: the genuine single-page application ------------------------------------
  // permiteyes.us in miniature, down to the control names: <button id="submit_form"
  // name="submit_form">Submit</button> alongside "Save and Exit" and "Exit". The <form> posts
  // to /wrong so that ANY submission path -- the button, an Enter keypress, a stray
  // requestSubmit -- is loud, not just a click on the control we record.
  "/single": `<!doctype html><html><body>${STYLE}
    <h1>Solar PV Permit Application</h1>
    <p>Complete every section below. Required items are marked with an asterisk.</p>
    <form id="theForm" action="/wrong" method="get">
      ${fieldBlock("s")}
      <label for="sMod">Module Manufacturer</label><input id="sMod" name="sMod" type="text">
      <label for="sInv">Inverter Manufacturer</label><input id="sInv" name="sInv" type="text">
      <label for="sQty">Module Quantity</label><input id="sQty" name="sQty" type="text">
      <!-- The number the UTILITY issues, which no automation can know. Present so the run
           still reports a hard blocker even while the page IS learned -- that is the whole
           difference between "this portal is replayable" and "this portal is now stageable". -->
      <label for="sAuth">* Utility Auth. No.</label><input id="sAuth" name="sAuth" type="text" required>
      <button id="submit_form" name="submit_form" type="submit">Submit</button>
      <button id="save_form1" name="save_form1" type="button">Save and Exit</button>
      <button id="exit_form" name="exit_form" type="button">Exit</button>
    </form>
  </body></html>`,

  // ---- HOLE 1 (brief's repro): a mid-wizard page whose draft-save matches \bfinish\b --------
  // The real advance is "Save and Proceed", which is NOT advance-shaped, so
  // clickFallbackAdvance declines and the page falls straight through to the classifier.
  "/wizarddraft": `<!doctype html><html><body>${STYLE}
    <h1>Step 2 of 4 &mdash; Equipment</h1>
    <p>Two more steps to go.</p>
    ${fieldBlock("w")}
    <button id="saveProceed" onclick="location.href='/wrong'">Save and Proceed</button>
    <button id="finishLater" onclick="location.href='/wrong'">Save and Finish Later</button>
  </body></html>`,

  // ---- HOLE 2 (brief's repro): the Next is PRESENT BUT DISABLED ----------------------------
  "/gatednext": `<!doctype html><html><body>${STYLE}
    <h1>Step 1 of 3 &mdash; Site</h1>
    <p>Next unlocks once the address is validated.</p>
    ${fieldBlock("g")}
    <button id="gatedNext" disabled onclick="location.href='/wrong'">Next</button>
    <button id="gatedSubmit" onclick="location.href='/wrong'">Submit</button>
  </body></html>`,

  // ---- HOLE 3a -----------------------------------------------------------------------------
  "/paysubmit": `<!doctype html><html><body>${STYLE}
    <h1>Interconnection Request</h1>
    ${fieldBlock("p")}
    <button id="paySubmit" onclick="location.href='/wrong'">Pay and Submit Application</button>
  </body></html>`,

  // ---- HOLE 3b -----------------------------------------------------------------------------
  "/submitpayment": `<!doctype html><html><body>${STYLE}
    <h1>Interconnection Request</h1>
    ${fieldBlock("q")}
    <button id="submitPayment" onclick="location.href='/wrong'">Submit Payment</button>
  </body></html>`,

  // ---- HOLE 4: Accela's page advance, which only files on the LAST page ---------------------
  "/continueapp": `<!doctype html><html><body>${STYLE}
    <h1>Permit Application &mdash; Applicant</h1>
    ${fieldBlock("c")}
    <button id="contApp" onclick="location.href='/wrong'">Continue Application</button>
  </body></html>`,

  // ---- MUST NOT: the portal is complaining --------------------------------------------------
  "/liveerror": `<!doctype html><html><body>${STYLE}
    <h1>Permit Application</h1>
    <div class="validation-summary-errors err">Service Address: This field is required.</div>
    ${fieldBlock("e")}
    <button id="errSubmit" onclick="location.href='/wrong'">Submit Application</button>
  </body></html>`,

  // ===== ISOLATION PAGES: on each of these exactly ONE guard refuses ==========================
  // "step" alone: a clean submit, nothing else forward, and a portal that says there is more.
  "/isolate-step": `<!doctype html><html><body>${STYLE}
    <h1>Step 2 of 5 &mdash; Electrical</h1>
    ${fieldBlock("i1")}
    <button id="i1Submit">Submit Application</button>
    <button id="i1Cancel">Cancel</button>
  </body></html>`,

  // "gate" alone: no step marker, nothing else forward, and a disabled Next.
  "/isolate-gate": `<!doctype html><html><body>${STYLE}
    <h1>Electrical Details</h1>
    ${fieldBlock("i2")}
    <button id="i2Next" disabled>Next</button>
    <button id="i2Submit">Submit Application</button>
  </body></html>`,

  // "defer" alone: the ONLY submit-shaped control saves a draft and leaves -- and it names the
  // application, so the noun rule has nothing to say about it.
  "/isolate-defer": `<!doctype html><html><body>${STYLE}
    <h1>Electrical Details</h1>
    ${fieldBlock("i3")}
    <button id="i3Later">Finish Application Later</button>
    <button id="i3Cancel">Cancel</button>
  </body></html>`,

  // "noun" alone: the verb governs something that is not the application.
  "/isolate-noun": `<!doctype html><html><body>${STYLE}
    <h1>Attachments</h1>
    ${fieldBlock("i4")}
    <button id="i4Docs">Submit Documents</button>
    <button id="i4Cancel">Cancel</button>
  </body></html>`,

  // "advance" alone: a control carrying BOTH vocabularies, anchored on the submit half. The
  // page-level gate is anchored at the START of a label (ADVANCE_ONLY) and structurally cannot
  // see this one, so only the candidate rule can refuse it.
  "/isolate-advance": `<!doctype html><html><body>${STYLE}
    <h1>Applicant</h1>
    ${fieldBlock("i6")}
    <button id="i6Both">Submit Application and Continue</button>
    <button id="i6Cancel">Cancel</button>
  </body></html>`,

  // "positive" alone: a clean submit, no step marker, no review wording -- but the page still
  // offers another enabled way forward, which is not advance-SHAPED so the gate stays quiet.
  "/isolate-positive": `<!doctype html><html><body>${STYLE}
    <h1>Equipment</h1>
    ${fieldBlock("i5")}
    <button id="i5Submit">Submit Application</button>
    <button id="i5Proceed">Save and Proceed</button>
  </body></html>`,

  // MUST NOT: a page the walk typed NOTHING into. The planner below is given no label it
  // recognises, so it returns no fills -- exactly the shape of the live Salem run that
  // promoted an empty recipe from an entry page it had not filled.
  "/nofills": `<!doctype html><html><body>${STYLE}
    <h1>Permit Application</h1>
    <label for="x1">Parcel Identification Number</label><input id="x1" name="x1" type="text">
    <label for="x2">Folio Reference</label><input id="x2" name="x2" type="text">
    <label for="x3">Zoning District</label><input id="x3" name="x3" type="text">
    <label for="x4">Flood Zone</label><input id="x4" name="x4" type="text">
    <label for="x5">Historic Designation</label><input id="x5" name="x5" type="text">
    <label for="x6">Plat Book Page</label><input id="x6" name="x6" type="text">
    <button id="nfSubmit" onclick="location.href='/wrong'">Submit Application</button>
  </body></html>`,

  "/p2": `<!doctype html><html><body>${STYLE}<h1>Next Page</h1>
    <label for="n1">System Size kW</label><input id="n1" name="n1"></body></html>`,

  "/wrong": `<!doctype html><html><body>${STYLE}
    <h1>Application Filed</h1><p>This page must never be reached by automation.</p>
  </body></html>`,
};

const server = http.createServer((q, r) => {
  const body = PAGES[(q.url || "/").split("?")[0]] ?? "<!doctype html><html><body>404</body></html>";
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(body);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext();
// esbuild's keepNames wraps nameable functions as __name(fn); a raw page has no such global,
// and the surrounding .catch() would turn the ReferenceError into "found nothing".
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

interface Harvest { fields: ExtractedField[]; raws: RawField[]; bodyText: string; errors: string[] }

/** The single-frame equivalent of what terminalSubmitHere does in the adapter: resolve the
 *  scope, harvest, filter, map, read the body text and the portal's own complaints. */
async function harvest(path: string): Promise<Harvest> {
  const page = await ctx.newPage();
  await page.goto(`${base}${path}`);
  const scope = await resolveActiveScope(page);
  const raws = (await page.$$eval(EXTRACT_SEL, extractFieldsInPage)) as RawField[];
  const kept = applyActiveScopeFilter(raws, scope.marked).fields;
  const bodyText = ((await page.locator("body").innerText()) || "").replace(/\s+/g, " ").trim().slice(0, 2000);
  const errors = await collectValidationErrorsFrom(page);
  await page.close();
  return { fields: kept.map(toExtractedField), raws: kept, bodyText, errors };
}

const verdictOf = (h: Harvest, without: TerminalGuard[] = []) =>
  classifyTerminalSubmitPage({ fields: h.fields, bodyText: h.bodyText, validationErrors: h.errors }, without);

const say = (v: ReturnType<typeof verdictOf>): string =>
  v.terminal ? `TERMINAL on ${JSON.stringify(v.label)} (${v.why})` : `refused by "${v.guard}": ${v.reason}`;

const PROJECT = {
  projectAddress: "1 Test St, Springfield, IL, 62701",
  city: "Springfield", state: "IL", zip: "62701", homeownerName: "Ada Lovelace",
} as never;

/** Fill anything the page offers by label, never name an advance, never claim review. */
const fillingPlanner = (seen: string[][]): LearnPlanner => async (req) => {
  seen.push(req.fields.map((f) => f.label));
  const fills: Array<{ selectorIndex: number; value: string }> = [];
  const want: Record<string, string> = {
    "Owner Name": "Ada Lovelace", "Owner Email": "ada@example.com", "Owner Phone": "555-0100",
    "Service Address": "1 Test St", "Service City": "Springfield", "System Size kW": "7.2",
    "Module Manufacturer": "Qcells", "Inverter Manufacturer": "Enphase", "Module Quantity": "18",
  };
  req.fields.forEach((f, i) => { if (want[f.label]) fills.push({ selectorIndex: i, value: want[f.label] }); });
  return { fills, atReview: false };
};

/** Run the REAL walk against one page and report what it recorded. */
async function walk(path: string, opts: { allowFinalSubmit?: boolean } = {}) {
  const seen: string[][] = [];
  const page = await ctx.newPage();
  await page.goto(`${base}${path}`);
  const adapter = new AutoLearnAdapter(`Terminal ${path}`, fillingPlanner(seen), {
    maxPages: 2, ...(opts.allowFinalSubmit ? { allowFinalSubmit: true } : {}),
  } as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).page = page;
  const res = await adapter.learn({ portalUrl: `${base}${path}` } as never, PROJECT);
  const endedOn = page.url();
  await page.close();
  return { res, endedOn, seen };
}

// ===========================================================================================
// 1) MUST FIRE -- the genuine single-page application. THE OVER-CORRECTION CHECK: a guard set
//    that makes the feature unreachable is a silently deleted feature, and this repo has
//    shipped one before.
// ===========================================================================================
console.log("\n[1] a genuine single-page application (the permiteyes shape)");
const hSingle = await harvest("/single");
const vSingle = verdictOf(hSingle);
check("THE FEATURE FIRES: a one-page application with no Next is its own review",
  vSingle.terminal === true, say(vSingle));
check("...and the control it picked is the page's Submit, not its draft-save or its Exit",
  vSingle.terminal && vSingle.label === "Submit", say(vSingle));
check("...and it said WHY in terms an operator can check",
  vSingle.terminal && /only enabled way forward/.test(vSingle.why), say(vSingle));

const wSingle = await walk("/single");
const finals = wSingle.res.steps.filter((s) => s.isFinalSubmit === true);
check("THE WALK reaches review on a page that has no review screen",
  wSingle.res.reachedReview === true,
  `reachedReview=${String(wSingle.res.reachedReview)} message=${JSON.stringify(String(wSingle.res.message).slice(0, 160))}`);
check("...and records EXACTLY ONE final-submit step",
  finals.length === 1, JSON.stringify(wSingle.res.steps.map((s) => s.note)));
check("...flagged isFinalSubmit:true and marked NOT clicked",
  finals.length === 1 && finals[0].isFinalSubmit === true && /NOT clicked/.test(String(finals[0].note ?? "")),
  JSON.stringify(finals[0]?.note));
check("...and finalSubmitRecorded is set, so the backend stages it instead of discarding the run",
  wSingle.res.finalSubmitRecorded === true, String(wSingle.res.finalSubmitRecorded));
check("THE FORM NEVER SUBMITTED -- the page is still the application page",
  wSingle.endedOn.endsWith("/single"), `ended on ${wSingle.endedOn}`);
check("...and real fills were recorded, so this is a learned page and not an empty stop",
  wSingle.res.steps.filter((s) => s.action === "fill").length >= 8,
  JSON.stringify(wSingle.res.steps.filter((s) => s.action === "fill").length));
check("...and the required field only the UTILITY can supply is still reported as a blocker",
  (wSingle.res.requiredFieldMisses ?? []).some((m) => /Utility Auth/i.test(m)),
  JSON.stringify(wSingle.res.requiredFieldMisses));

// ===========================================================================================
// 2) HOLE 5 -- an inference that a page is terminal is not authority to file it. Both operator
//    delegation switches ON, and the click must still not happen.
// ===========================================================================================
console.log("\n[2] hole 5: operator delegation must not reach this path");
process.env.PORTAL_ALLOW_FINAL_SUBMIT = "1";
const wDelegated = await walk("/single", { allowFinalSubmit: true });
delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
check("with allowFinalSubmit AND PORTAL_ALLOW_FINAL_SUBMIT=1, the form STILL never submits",
  wDelegated.endedOn.endsWith("/single"), `ended on ${wDelegated.endedOn}`);
check("...and the recorded note still says NOT clicked",
  wDelegated.res.steps.filter((s) => s.isFinalSubmit).every((s) => /NOT clicked/.test(String(s.note ?? ""))),
  JSON.stringify(wDelegated.res.steps.filter((s) => s.isFinalSubmit).map((s) => s.note)));

// ===========================================================================================
// 3) HOLE 1 -- "Step 2 of 4" + "Save and Finish Later".
// ===========================================================================================
console.log("\n[3] hole 1: a draft-save on a mid-wizard page");
const hDraft = await harvest("/wizarddraft");
const vDraft = verdictOf(hDraft);
check("a mid-wizard page whose only submit-shaped control is a draft-save is NOT terminal",
  vDraft.terminal === false, say(vDraft));
check("...and it is refused by MORE than one rule -- retiring the step marker alone is not enough",
  verdictOf(hDraft, ["step"]).terminal === false, say(verdictOf(hDraft, ["step"])));
check("...and retiring the step marker AND the defer wording still leaves it refused",
  verdictOf(hDraft, ["step", "defer"]).terminal === false, say(verdictOf(hDraft, ["step", "defer"])));
const wDraft = await walk("/wizarddraft");
check("THE WALK banks no final submit on it",
  !wDraft.res.steps.some((s) => s.isFinalSubmit) && wDraft.res.reachedReview !== true,
  `reachedReview=${String(wDraft.res.reachedReview)} steps=${JSON.stringify(wDraft.res.steps.map((s) => s.note))}`);
check("...and never clicked either control (both navigate to /wrong)",
  wDraft.endedOn.endsWith("/wizarddraft"), `ended on ${wDraft.endedOn}`);

// ===========================================================================================
// 4) HOLE 2 -- "Step 1 of 3" + a DISABLED Next.
// ===========================================================================================
console.log("\n[4] hole 2: a Next that is present but disabled");
const hGated = await harvest("/gatednext");
check("the extractor really carried the disabled state through to the field",
  hGated.raws.find((f) => f.id === "gatedNext")?.disabled === true,
  JSON.stringify(hGated.raws.filter((f) => f.fieldType === "button").map((f) => [f.label, f.disabled])));
const vGated = verdictOf(hGated);
check("a gated wizard step is NOT terminal",
  vGated.terminal === false, say(vGated));
check("...and the reason NAMES THE GATE, so the operator can see what the page is waiting for",
  vGated.terminal === false && vGated.guard === "gate" && /DISABLED/.test(vGated.reason), say(vGated));
const wGated = await walk("/gatednext");
check("THE WALK banks no final submit on it",
  !wGated.res.steps.some((s) => s.isFinalSubmit) && wGated.res.reachedReview !== true,
  `reachedReview=${String(wGated.res.reachedReview)} steps=${JSON.stringify(wGated.res.steps.map((s) => s.note))}`);
check("...and the page never moved to /wrong",
  !wGated.endedOn.endsWith("/wrong"), `ended on ${wGated.endedOn}`);

// ===========================================================================================
// 5) HOLE 3 -- money. Two independent layers, and the phrase list alone was not enough.
// ===========================================================================================
console.log("\n[5] hole 3: a control that mentions money is never the end of a NEW application");
const hPay = await harvest("/paysubmit");
const hPmt = await harvest("/submitpayment");
check('"Pay and Submit Application" is NOT terminal', verdictOf(hPay).terminal === false, say(verdictOf(hPay)));
check('"Submit Payment" is NOT terminal', verdictOf(hPmt).terminal === false, say(verdictOf(hPmt)));
check("LAYER 1 ALONE holds it: with the money regex retired, the phrase list still refuses",
  verdictOf(hPay, ["money"]).terminal === false, say(verdictOf(hPay, ["money"])));
check("LAYER 2 ALONE holds it: with the phrase list retired, the money regex still refuses",
  verdictOf(hPay, ["payfee"]).terminal === false, say(verdictOf(hPay, ["payfee"])));
check("AND THE HAZARD IS REAL: retire BOTH and a payment control is recorded as the final submit",
  verdictOf(hPay, ["money", "payfee"]).terminal === true,
  `${say(verdictOf(hPay, ["money", "payfee"]))} -- if this is still refused, the two layers above prove nothing`);
check('"Submit Payment" survives even both -- the noun rule catches it as defence in depth',
  verdictOf(hPmt, ["money", "payfee"]).terminal === false, say(verdictOf(hPmt, ["money", "payfee"])));
// THE WIDENING ITSELF, pinned against the exact pattern that shipped before it.
const OLD_PAY_FEE = /\b(pay fee|pay now|submit & pay|submit and pay|make payment|continue to payment|pay \$|add to cart|proceed to (payment|checkout)|checkout|fee)\b/i;
check("the SHIPPED PAY_FEE missed 'Pay and Submit Application' (the reverse word order)",
  !OLD_PAY_FEE.test("Pay and Submit Application"));
check("the SHIPPED PAY_FEE missed 'Submit Payment' (no boundary before the m in Payment)",
  !OLD_PAY_FEE.test("Submit Payment"));
for (const label of ["Pay and Submit Application", "Submit Payment", "Pay Fees Due", "Remit Payment", "Pay Invoice", "Total Fees"]) {
  check(`PAY_FEE now catches ${JSON.stringify(label)}`, isPayFee(label));
}
// MUST-ALLOW is pinned as hard as MUST-REFUSE: over-blocking halts an ordinary page.
for (const label of ["Next", "Continue", "Submit Application", "Upload Document", "Payee Name", "Save and Continue"]) {
  check(`PAY_FEE still allows ${JSON.stringify(label)}`, !isPayFee(label));
}
const wPay = await walk("/paysubmit");
check("THE WALK banks no final submit on a payment control",
  !wPay.res.steps.some((s) => s.isFinalSubmit),
  JSON.stringify(wPay.res.steps.map((s) => s.note)));
check("...and never pressed it", wPay.endedOn.endsWith("/paysubmit"), `ended on ${wPay.endedOn}`);

// ===========================================================================================
// 6) HOLE 4 -- an advance is never the end, however it is worded.
// ===========================================================================================
console.log("\n[6] hole 4: 'Continue Application' is the page advance everywhere but the last");
const hCont = await harvest("/continueapp");
check("a page whose only submit-ish control is 'Continue Application' is NOT terminal",
  verdictOf(hCont).terminal === false, say(verdictOf(hCont)));
check("GATE ALONE holds it: retire the candidate rule and the page-owns-an-advance rule refuses",
  verdictOf(hCont, ["advance"]).terminal === false, say(verdictOf(hCont, ["advance"])));
check("CANDIDATE RULE ALONE holds it: retire the gate and the candidate is still refused",
  verdictOf(hCont, ["gate"]).terminal === false, say(verdictOf(hCont, ["gate"])));
check("AND THE HAZARD IS REAL: retire both and a six-page wizard ends on page two",
  verdictOf(hCont, ["gate", "advance"]).terminal === true, say(verdictOf(hCont, ["gate", "advance"])));
const wCont = await walk("/continueapp");
check("THE WALK banks no final submit on it",
  !wCont.res.steps.some((s) => s.isFinalSubmit),
  JSON.stringify(wCont.res.steps.map((s) => s.note)));
check("...and never clicked it", wCont.endedOn.endsWith("/continueapp"), `ended on ${wCont.endedOn}`);

// ===========================================================================================
// 7) MUST NOT -- a page showing a live validation error has just refused something.
// ===========================================================================================
console.log("\n[7] a page showing a live validation error");
const hErr = await harvest("/liveerror");
check("the portal's own complaint was actually scraped (else the check below is vacuous)",
  hErr.errors.length > 0, JSON.stringify(hErr.errors));
check("a page showing a validation error is NOT terminal",
  verdictOf(hErr).terminal === false, say(verdictOf(hErr)));
check("KILL: retire the validation rule and the page is classified terminal",
  verdictOf(hErr, ["validation"]).terminal === true, say(verdictOf(hErr, ["validation"])));

// ===========================================================================================
// 7b) MUST NOT -- a page the walk typed NOTHING into. A terminal page cannot precede the
//     first recorded fill; the live Salem run promoted an EMPTY recipe from exactly this.
// ===========================================================================================
console.log("\n[7b] a page the walk filled nothing on");
const hNoFills = await harvest("/nofills");
check("THE PAGE ITSELF LOOKS TERMINAL to the classifier -- so the precondition is what stops it",
  verdictOf(hNoFills).terminal === true,
  `${say(verdictOf(hNoFills))} -- if the classifier refused it, the walk check below proves nothing`);
const wNoFills = await walk("/nofills");
check("...but the WALK records no final submit, because it typed nothing",
  !wNoFills.res.steps.some((s) => s.isFinalSubmit) && wNoFills.res.reachedReview !== true,
  `reachedReview=${String(wNoFills.res.reachedReview)} steps=${JSON.stringify(wNoFills.res.steps.map((s) => s.note))}`);
check("...and no fill step was recorded either, so this really is the empty case",
  !wNoFills.res.steps.some((s) => s.action === "fill" || s.action === "select" || s.action === "check"),
  JSON.stringify(wNoFills.res.steps.map((s) => s.note)));

// ===========================================================================================
// 8) THE KILL MATRIX -- one page per guard, where that guard is the ONLY thing refusing.
// ===========================================================================================
console.log("\n[8] kill matrix: every guard retired on its own");
const matrix: Array<{ guard: TerminalGuard; path: string; what: string }> = [
  { guard: "step", path: "/isolate-step", what: '"Step 2 of 5" with a clean Submit and nothing else forward' },
  { guard: "gate", path: "/isolate-gate", what: "a DISABLED Next beside a clean Submit" },
  { guard: "defer", path: "/isolate-defer", what: '"Finish Application Later" as the only submit-shaped control' },
  { guard: "noun", path: "/isolate-noun", what: '"Submit Documents" -- the verb governs the wrong noun' },
  { guard: "advance", path: "/isolate-advance", what: '"Submit Application and Continue" -- both vocabularies, anchored on the submit half' },
  { guard: "positive", path: "/isolate-positive", what: 'a clean Submit, but "Save and Proceed" is still on offer' },
];
for (const row of matrix) {
  const h = await harvest(row.path);
  const withAll = verdictOf(h);
  const without = verdictOf(h, [row.guard]);
  check(`"${row.guard}" REFUSES ${row.what}`,
    withAll.terminal === false && withAll.guard === row.guard, say(withAll));
  check(`"${row.guard}" is the ONLY thing refusing it -- retire it and the page is terminal`,
    without.terminal === true,
    `${say(without)} -- a guard whose removal breaks nothing is not a guard`);
}

// ===========================================================================================
// 9) The noun rule, as a rule -- stated the way the code states it.
// ===========================================================================================
console.log("\n[9] the submit verb must govern the application");
for (const label of ["Submit", "Submit »", "Submit Now", "Submit Application", "Complete Submission", "File Application", "Finish"]) {
  check(`governs the application: ${JSON.stringify(label)}`, submitGovernsApplication(label));
}
for (const label of ["Submit Search", "Submit Documents", "Submit Feedback", "Submit a Comment", "Submit Payment"]) {
  check(`does NOT govern the application: ${JSON.stringify(label)}`, !submitGovernsApplication(label));
}

await browser.close();
server.close();
console.log(failures === 0 ? "\nterminalPage.dom.smoke: PASS" : `\nterminalPage.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
