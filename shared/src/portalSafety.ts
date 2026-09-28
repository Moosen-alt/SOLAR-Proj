// ONE MODULE ANSWERS EACH PORTAL SAFETY QUESTION.
//
// Before this file, "is this a final submit", "is this a fee payment" and "is this field a
// secret" each had five to eleven separate answers spread over the learner, replay, the two
// human recorders, the network recorder and the LLM post-filter — and they disagreed. The
// recorder's OFF_LIMITS list lacked "continue application" (Accela's filing control on its
// review page), replay's SUBMIT_KEYWORDS lacked it too, humanCapture refused a contractor's
// licence expiry as a payment card, and the recorder called any name containing "parameter" a
// secret because it matched bare `meter`. Each drift was fixed where it was found and came back
// through the next copy. This is the one copy.
//
// Contract:
//   - PURE. Nothing here touches the DOM, the network or the database. The only outside input
//     is the PORTAL_ALLOW_FINAL_SUBMIT switch, and even that is read by the caller through
//     finalSubmitEnvAllows() and passed in — mayClickFinalSubmit never reads process.env.
//   - SAME BYTES IN THE PAGE. Capture scripts run inside the portal page, where an import does
//     not exist. The label/field predicates are therefore built by one self-contained factory
//     (portalSafetyFactory) whose source is injected as PORTAL_SAFETY_IN_PAGE_SOURCE. Node calls
//     the factory once; the page evaluates the same function text. There is no second copy to
//     drift — portalSafety.test.ts and portalSafetyInPage.dom.smoke.ts pin that both sides give
//     identical answers over the golden list.
//   - BOOLEAN PREDICATES RETURN BOOLEANS. A gate that returns an object is truthy on refusal
//     (`if (mayClickFinalSubmit(x))` would always pass), so every "may I?" question returns a
//     plain boolean and its reasons come from a separately named function.
//   - AN UNKNOWN NEVER READS AS REASSURANCE. classifySubmissionText answers "accepted" only on
//     positive evidence; "Continue Application" is a submit unless the caller KNOWS the page is
//     still fillable.

// ---------------------------------------------------------------------------------------------
// Shared contract types (other groups build on these; kept here, not in types.ts)
// ---------------------------------------------------------------------------------------------

import type { RecipeSelector } from "./types";

/** What a page tells us about itself when classifying a control on it. Every field optional:
 *  an absent field means UNKNOWN, and each predicate says which way unknown falls. */
export interface ControlContext {
  /** true = the page shows no fillable input (a read-only review/summary page). An attachment
   *  widget (input[type=file]) does not make a page fillable: review pages carry one. */
  readOnlyPage?: boolean;
  /** Has this session entered any real form data yet (a fill, a select, or a check that is not
   *  a terms acknowledgment)? false = KNOWN nothing entered: a read-only page before the first
   *  fill is an entry disclaimer (Accela's CapApplyDisclaimer — terms text, an agree box and
   *  "Continue Application »"), which is a pass-through, never the review page. A session that
   *  starts mid-flow does not know, and leaves this undefined — never false. */
  formDataEntered?: boolean;
  /** true = the page NAMES itself the review step ("Step 3: Review", "Review and Submit" —
   *  reviewPageInPage; a "(Read-only)" section marker is not a name). Independent of readOnlyPage: a review page with a
   *  signature box or an attachment widget still files on its advance. */
  reviewPage?: boolean;
}

/** The identity of a form field as far as the secret/payment questions need it. Attribute
 *  NAMES and label text only — never the field's value. */
export interface FieldIdentity {
  label?: string | null;
  name?: string | null;
  id?: string | null;
  autocomplete?: string | null;
  type?: string | null;
  placeholder?: string | null;
  ariaLabel?: string | null;
}

/** How a click on a recorded control must be treated by a capture surface. */
export type RecordedClickClass =
  /** An ordinary control: capture it as a replayable step. */
  | "capture"
  /** Submit- or pay-worded: NEVER a replayable step. */
  | "blocked"
  /** Blocked AND it is the application's final filing click (the human just filed). */
  | "finalSubmit";

export type SubmissionVerdict = "accepted" | "rejected" | "unknown";

export interface SubmissionOutcome {
  verdict: SubmissionVerdict;
  /** The phrase that decided it (for the run record), or null when nothing did. */
  evidence: string | null;
}

/** A replay heal, identified by the step it healed and the recipe version it was read from —
 *  never by (action, note), which several steps can share. `performed` is true only when the
 *  healed step actually acted; a heal that resolved but never ran must not be persisted. */
export interface HealedStep {
  stepIndex: number;
  recipeVersion: number;
  action: string;
  note?: string;
  selector?: RecipeSelector;
  performed: boolean;
}

/** A named person's approval of ONE run. There is no standing per-recipe arm. */
export interface RunApproval {
  approver: string;
  runId: string;
}

export interface FinalSubmitContext {
  /** finalSubmitEnvAllows() — PORTAL_ALLOW_FINAL_SUBMIT=1 on this process. */
  envAllows: boolean;
  /** The approval for THIS run, or null. */
  runApproval: RunApproval | null;
  /** The run the click would happen in. The approval must name exactly this run. */
  runId: string;
  /** The step being executed is the recipe's single terminal isFinalSubmit step. */
  stepIsTerminalFlagged: boolean;
  /** isRecipeShapeValid(recipe.steps). */
  recipeShapeValid: boolean;
}

/** The minimum a recipe step must carry for the shape check. */
export interface ShapeStep {
  action: string;
  isFinalSubmit?: boolean;
  selector?: RecipeSelector | Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------------------------
// The label / field predicates — ONE self-contained factory, run in Node and in the page
// ---------------------------------------------------------------------------------------------

/**
 * Builds every label/field predicate. SELF-CONTAINED ON PURPOSE: it references nothing outside
 * its own body, so its source text can be evaluated inside a portal page and behave exactly as
 * it does here. Do not hoist a regex or helper out of it — the page copy would lose it and the
 * capture script would fail closed (every click blocked) on a live recording.
 */
export function portalSafetyFactory() {
  // SUBMIT INTENT. Everything that files, finalises or commits an application. Word-bounded so
  // "Submittal Type", "Finished Floor Elevation" and "Resubmittal" do not match. The filing
  // verbs are more than "submit": the correction flow's "Resubmit", a signature-and-filing
  // "Sign and File", "e-File" and "File Permit" all file the application.
  const SUBMIT_WORDS =
    /\b(submit|submit application|file application|finali[sz]e|finish|complete application|send application|confirm submission|complete submission|place order|re-?submit|re-?file|e-?file|sign\s*(and|&)\s*(file|submit)|file\s+(application|permit))\b/i;
  // Accela's page advance on every page but the last, where the SAME control files the permit.
  const CONTINUE_APPLICATION = /\bcontinue\s+application\b/i;

  // PAY / FEE. The click-blocking list (it halts a real click, so it governs objects: "pay
  // fees", "make payment", a commit verb + "order"). Bare `pay` is in: "Pay", "Pay Later",
  // "Review and Pay" all passed earlier copies. `\bpay\b` cannot reach "Payee", "Payroll" or
  // "Repay" (no word boundary after "pay"). Bare `fee` is deliberately NOT here — "Fee Schedule"
  // is a link a replay may need to pass.
  const PAY_FEE =
    /\b(pay\s*(and|&)\s*submit|pay fees?|pay now|submit\s*(&|and)\s*pay|make payment|payments?|remit|invoices?|continue to payment|pay \$|add to cart|proceed to (payment|checkout)|checkout|fees? due|purchases?|buy now|(place|submit|confirm|complete|finali[sz]e)\s+(the\s+|my\s+|your\s+)?order|pay)\b/i;

  // THE FILING CLICK ITSELF — narrower than SUBMIT_WORDS. A mid-flow "Submit Documents" or
  // "Submit for Review" is submit-worded (never captured) but is not the application's filing,
  // so it must not end a human's capture session.
  const FINAL_SUBMIT_EXACT = /^(submit|submit application|submit & pay|submit and pay|submit now|submit my application|re-?submit|re-?submit application|re-?file|e-?file|e-?file application)$/i;
  const FINAL_SUBMIT_PHRASE = /\b(confirm submission|complete submission|file application|sign\s*(and|&)\s*(file|submit)|file\s+permit)\b/i;

  // SECRETS. Each alternative names a secret; the name-ish words after "account" are excluded
  // because "Account Holder Name" is project data the planner must see and bind.
  const SECRET_WORDS = new RegExp([
    "password", "passcode", "pass\\s*phrase",
    "\\bpin\\b",
    "\\baccount\\b(?!\\s*(holder|name|owner|type|manager|executive|representative|status|contact))",
    // "acct" is "account" abbreviated, with the same name-ish exclusions: an id "acctType" or
    // "acctHolderName" is project data, exactly like "Account Type".
    "\\bacct\\b(?!\\s*(holder|name|owner|type|manager|executive|representative|status|contact))", "\\bacct\\s*(no|num|number)\\b",
    "\\bmeter\\s*(number|no|num|#|id)\\b",
    "\\b(service\\s*)?agreement\\s*(number|no|num|#|id)\\b",
    // Utility identifiers that name ONE customer's service, like an account number: PG&E's
    // "SA ID", "Service Point ID", "Premise ID", Texas' "ESI ID", a "Customer Number". Only the
    // identifier words — "Customer Name", "Customer Type" and "Premise Address" are project data.
    "\\bsa\\s*id\\b", "\\besi\\s*id\\b",
    "\\b(service\\s*point|premise|customer)\\s*(#|(id|number|no|num)\\b)",
    "\\bssn\\b", "social\\s*security", "\\btax\\s*id\\b", "\\bein\\b", "\\bitin\\b", "\\btin\\b",
    "routing", "bank\\s*account",
    "card\\s*(number|no\\b|#)", "\\bcvv\\b", "\\bcvc\\b", "\\bccv\\b", "security\\s*code",
    "\\bmfa\\b", "\\b2fa\\b", "\\botp\\b", "one[\\s-]*time", "verification\\s*code", "authentication\\s*code",
  ].join("|"), "i");
  // A label that is ONLY "Meter" (optionally "Electric Meter:") holds the meter number.
  const BARE_METER_LABEL = /^\s*(electric\s+|utility\s+|service\s+|gas\s+)?meter\s*[:#*]?\s*$/i;
  const SECRET_AUTOCOMPLETE = /^(current-password|new-password|one-time-code|cc-)/i;

  // PAYMENT CARD FIELDS. A card's expiry is split into MONTH and YEAR, or carries a card word —
  // a bare "Expiration Date" is a contractor licence on half the permit forms here.
  const PAYMENT_WORDS =
    /\bcvv\b|\bcvc\b|\bccv\b|card\s*(number|no\b|#|type)|cardholder|card\s*holder|name on card|credit\s*card|debit\s*card|(card|\bcc\b|credit|debit)[a-z ]{0,12}exp|exp(iration|iry|\.)?\s*(month|year)\b|billing\s*zip/i;

  // A camelCase / snake_case attribute reads as words: accountNumber -> "account Number".
  const words = (s: unknown): string =>
    String(s ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.[\]]+/g, " ").trim();

  const parts = (f: FieldIdentity | null | undefined): string[] => {
    if (!f) return [];
    return [f.label, f.name, f.id, f.placeholder, f.ariaLabel].map(words).filter(Boolean);
  };

  const isPayFee = (label: string | null | undefined): boolean => !!label && PAY_FEE.test(String(label));
  /** ONE question: does a DIALOG's text (a native confirm(), a DOM modal) speak of paying? Asked of
   *  the approved final submit's confirm dialogs (native and DOM): a payment-worded one is never
   *  accepted — automation never pays (portal-run-close-2 M3). Word-bounded: "feedback" is not a fee. */
  const isPaymentWordedText = (text: string | null | undefined): boolean => /\b(pay(s|ing|ment|ments|able)?|fees?|checkout|credit\s*card|debit\s*card|card\s*(number|holder)|charges?|charged)\b/i.test(String(text ?? ""));
  /** THE ONE ANSWER TO "MAY THE APPROVED SUBMIT ACCEPT THIS CONFIRMATION?" (autosubmit-close,
   *  operator ruling 2026-09-27: "Yes, submit and then we can pay the fees later"). Asked of every
   *  dialog the approved final submit raises — a native confirm()/alert (filingBackstop's dialog
   *  handler) and a DOM confirm modal (replay's outcome reader):
   *    "no_payment"   — speaks of no payment: the click's own confirmation, accepted;
   *    "fee_deferred" — mentions a fee only as informational / deferred ("Fees will be invoiced
   *                     later", "assessed after review", "you will be billed", "due at issuance",
   *                     "pay later"): accepted — filing now and paying later is what the operator
   *                     approved; nothing is paid;
   *    "pays_now"     — pays NOW ("Pay $150 and submit?", "your card will be charged", "proceed to
   *                     payment", "checkout", "enter card"), OR speaks of payment with no deferral
   *                     (fail-closed): dismissed, nothing filed, a fee_payment pause.
   *  A pay-now marker wins over any deferral in the same text. The network backstop's
   *  isPayRequestUrl stays the hard line under all of this: no payment request ever goes. */
  // The deferral qualifiers a fee sentence can carry ("at issuance", "after review", "later").
  const LATER_Q = "(later|separately|after|following|at\\s+(the\\s+)?(time\\s+of\\s+)?(permit\\s+)?(issuance|issue|approval|pickup|inspection)|upon\\s+(the\\s+)?(permit\\s+)?(issuance|issue|approval|review|pickup|inspection)|when\\s+(the\\s+)?(permit|application)\\s+is\\s+(issued|approved|reviewed))";
  const PAY_NOW_DIALOG = new RegExp([
    // The verb "pay" / "pays" (never "payment"/"payable"), unless deferred right after it or later
    // in its clause ("pay later", "pay at issuance", "pay the fee later"). "Submitting PAYS the $150
    // fee from your account" is paying (autosubmit-2 MF-S2: "pays" passed as fee_deferred).
    "\\bpay(s|ing)?\\b(?!\\s+(later|at|upon|when|after|once)\\b)(?![^.?!]{0,30}\\blater\\b)",
    // An amount to pay is always now ("Pay $150 later" is fail-closed), and so is "pay now"
    // whatever else the text offers ("pay now or later?").
    "\\bpay(s|ing)?\\s+(\\$|usd\\b|[0-9])",
    "\\bpay(s|ing)?\\s+(now|today|immediately|online)\\b",
    "\\b(proceed|continue|go|redirect(ed)?|taken)\\s+to\\s+(the\\s+)?(payment|checkout|pay)\\b",
    "\\bcheck\\s*-?\\s*out\\b",
    // A card being charged is a payment whenever it happens (automation never authorizes one).
    "\\b(will\\s+be|is|are|is\\s+being|be|was|were|been|get|gets)\\s+(automatically\\s+|immediately\\s+)?charged\\b",
    "\\bcharged\\s+(to|against)\\b",
    "\\bcharg(e|es|ing)\\s+(it\\s+)?(to\\s+)?(your|the|my)\\s+(\\w+\\s+)?(card|account|credit|bank)\\b",
    "\\b(credit|debit)\\s*card\\b",
    "\\bcard\\s*(number|holder|details|information|on\\s+file)\\b",
    "\\benter\\s+(your\\s+)?(card|payment)\\b",
    "\\bpayment\\s+(is\\s+)?(required|due)\\s+(now|today|before|to\\s+(submit|file|continue))\\b",
    "\\bmake\\s+(a\\s+)?payment\\b",
    "\\bsubmit\\s+(your\\s+)?payment\\b",
    // MONEY LEAVING THE PAYER BY ITSELF (autosubmit-2 MF-S2): debited / deducted / withdrawn from an
    // account, billed TO a card or account, an account or card on file, auto-pay, a payment that
    // "will be processed" — whenever it happens, like a charged card. ("You will be billed" alone
    // is still an invoice: deferred. "Withdrawn" needs money in its clause — "your draft will be
    // withdrawn" is not paying.)
    "\\bdebit(s|ed|ing)?\\b",
    "\\bdeduct(s|ed|ing|ions?)?\\b",
    "(\\$\\s?\\d|\\bfees?\\b|\\bamount\\b|\\bpayments?\\b|\\bfunds\\b)[^.?!;]{0,60}\\bwithdraw(n|s|al|ing)?\\b",
    "\\bwithdraw(n|s|al|ing)?\\b[^.?!;]{0,40}\\b(account|card|balance|bank|funds|wallet)\\b",
    "\\bbill(s|ed|ing)?\\s+(it\\s+)?(to|against)\\s+(your|the|my)\\s+(\\w+\\s+)?(card|account|credit|bank)\\b",
    "\\bbill(s|ed|ing)?\\s+(your|the|my)\\s+(\\w+\\s+)?(card|account|bank)\\b",
    "\\b(card|account)\\s+(will\\s+be|is|gets|shall\\s+be)\\s+(billed|debited|drafted)\\b",
    "\\b(account|card|payment\\s+method|bank\\s+account)\\s+on\\s+file\\b",
    "\\bauto[\\s-]?pay(ments?)?\\b",
    "\\bpayments?\\s+(will\\s+be|is\\s+being|is|are|gets|shall\\s+be)\\s+(automatically\\s+)?(processed|taken|drafted)\\b",
    "\\b(collected|taken|processed|drafted)\\s+(now|today|immediately|(on|at|upon|with|when\\s+you)\\s+(submi\\w*|filing|checkout))\\b",
  ].join("|"), "i");
  const FEE_DEFERRED_DIALOG = new RegExp([
    "\\binvoic(e|ed|es|ing)\\b",
    "\\b(will\\s+be|be|are|is|get|gets)\\s+billed\\b",
    "\\bbilled\\s+" + LATER_Q,
    "\\b(assessed|calculated|determined|collected|due|payable|paid|pay)\\s+" + LATER_Q,
    "\\bpay\\b[^.?!]{0,30}\\blater\\b",
    "\\bno\\s+(charge|fee|fees|cost|payment)\\b",
  ].join("|"), "i");
  // A NEGATED pay ("you do not need to pay now") is a deferral, not the verb. It removes only ITS OWN
  // words: a pays-now phrase anywhere else in the text still wins (autosubmit-2 MF-S2 — "You do not
  // need to pay now - $150 will be debited on submit." read fee_deferred and was filed).
  const NEGATED_PAY = /\b(no\s+need\s+to|(do|does|will|need)\s+not\s+(need\s+to\s+|have\s+to\s+)?|don'?t\s+(need|have)\s+to|not\s+(be\s+)?required\s+to|nothing\s+to)\s*pay\b/gi;
  // FAIL CLOSED ON MONEY, CLAUSE BY CLAUSE (autosubmit-close-2 skeptic: ~20 shapes FILED — "$150 is due
  // now.", "Total due: $150.00.", "Your balance will be reduced by $150 when you submit.", "Pagar $150 y
  // enviar?", and a deferral or a negation anywhere winning over a pays-now clause elsewhere). A clause
  // that mentions MONEY — an amount, or any word for paying, owing or moving money — is accepted only when
  // IT defers the money (FEE_DEFERRED_DIALOG) and nothing in it takes money now, at the click, or from an
  // account (MONEY_TAKEN). Every money clause must pass; the first that does not is pays_now, whatever the
  // other clauses say. A negated pay ("you do not need to pay now", "no payment is required") is removed
  // from its clause first, and what remains of that clause is judged on its own.
  const CLAUSE_BREAK = /[.?!;](?=\s|$)|\n+|\s[-–—]\s/;
  const MONEY_MENTION = new RegExp([
    "[$€£]\\s?\\d", "\\b\\d[\\d,]*(\\.\\d{1,2})?\\s*(usd|dollars?)\\b", "\\busd\\b",
    "\\b(pay\\w*|pag(ar|o|ue)|fees?|charges?|charged|charging|bill(s|ed|ing)?|invoic\\w*|debit\\w*|deduct\\w*|funds?|refund\\w*|card|bank|ach|e-?check|remit\\w*|checkout|transaction|wallet|escrow|balance|costs?|price|purchas\\w*|deposit\\w*|money|amount)\\b",
    "\\bdue\\s+(now|today|immediately)\\b", "\\btaken\\s+from\\b", "\\b(from|to|on)\\s+(your|the|my)\\s+(\\w+\\s+)?(account|card|bank)\\b",
  ].join("|"), "i");
  const MONEY_TAKEN = new RegExp([
    "\\b(now|today|immediately|instantly|right\\s+away|at\\s+this\\s+time)\\b",
    "\\b(on|upon|at|with|by)\\s+(submi\\w*|filing|clicking|checkout|continuing|proceeding)\\b",
    "\\b(when|once|as)\\s+(you\\s+)?(submit|file|click|continue|proceed)\\w*\\b",
    "\\b(before|to)\\s+(you\\s+)?(submit|file|continue|proceed)\\w*\\b",
    "\\b(card|bank|ach|e-?check|wallet|escrow|account)\\b",
    "\\b(debit\\w*|deduct\\w*|withdraw\\w*|charged|charging|remit\\w*|draw(n|s)?|reduc\\w*|purchas\\w*|authoriz\\w*|hold|taken\\s+from)\\b",
    "\\bcomplet\\w*\\s+(your\\s+|the\\s+)?(purchase|payment|order|transaction)\\b",
  ].join("|"), "i");
  // "Submit now" is the click's own timing, not the money's ("Submit now and pay later?").
  const SUBMIT_NOW = /\b(submit|file|send|continue|proceed|apply)\w*\s+(it\s+|this(\s+application)?\s+|the\s+application\s+|your\s+application\s+)?(now|today)\b/gi;
  const NEGATED_PAY_NOW = new RegExp(`(${NEGATED_PAY.source})(\\s+(anything|any\\s+fees?))?(\\s+(now|today|at\\s+this\\s+time|yet|here))?`, "gi");
  const NEGATED_MONEY = /\b(no\s+(charge|fee|fees|cost|payment|payments)(\s+(is|are|will\s+be))?(\s+(required|due|needed|necessary|owed|collected|charged))?(\s+(now|today|at\s+this\s+time|yet|here))?|free\s+of\s+charge|at\s+no\s+(cost|charge))/gi;
  const paymentDialogVerdict = (text: string | null | undefined): "no_payment" | "fee_deferred" | "pays_now" => {
    const raw = String(text ?? "");
    // A negation removes only its own words ("no payment is required now"); the rest is still judged.
    const t = raw.replace(NEGATED_PAY, " ").replace(NEGATED_MONEY, " ");
    if (PAY_NOW_DIALOG.test(t)) return "pays_now";
    let spoke = t !== raw;
    for (const clause of raw.split(CLAUSE_BREAK)) {
      const rest = clause.replace(NEGATED_PAY_NOW, " ").replace(NEGATED_MONEY, " ");
      if (rest !== clause) spoke = true;
      if (!MONEY_MENTION.test(rest)) continue;
      if (!FEE_DEFERRED_DIALOG.test(rest) || MONEY_TAKEN.test(rest.replace(SUBMIT_NOW, " "))) return "pays_now";
      spoke = true;
    }
    return spoke ? "fee_deferred" : "no_payment";
  };
  /** Does this dialog pay NOW (or speak of payment with no deferral)? The boolean every door asks. */
  const isPayNowDialogText = (text: string | null | undefined): boolean => paymentDialogVerdict(text) === "pays_now";

  // THE PAGE NAMES ITSELF THE REVIEW STEP. Deliberately narrower than "mentions review":
  // "Please review the terms and conditions" is an entry disclaimer, "Plan Review Fee" a fee line.
  // A "(Read-only)" SECTION marker is NOT the page naming itself: Oregon ePermitting's Step 1
  // locks the picked Site Address / Parcel / Owner sections as "(Read-only)", and reading that as
  // the review page refused the ordinary "Continue Application »" on a production replay
  // (City of Jefferson, 2026-09-26). The captured review page (CapConfirm) says "Step 4 : Review"
  // itself; dropping the marker changed no verdict on the 94 captured replica pages.
  //
  // THE ONE REVIEW QUESTION (portal-run-close MF2). The learner's own REVIEW_MARKERS and this
  // regex answered "is this the review page" differently: "Please review and sign" was a review
  // marker to the learner and NOT to the backstop, so a combined confirm-and-sign page whose
  // Next FILED (skeptic combinedReviewSign) was signed, its planner stop overridden into a
  // Next click, and the backstop's review lockdown never fired — 4 filing POSTs. Now the
  // learner reads reviewSignals() below; there is no second list. "Review and sign / submit /
  // file / certify / finish" names the step; a bare "please review" does not (the entry
  // disclaimer's "please review the terms").
  // NOT "please review and <any verb>", NOT "review and confirm <anything>": a mid-flow form
  // page says "Please review and correct the errors below" (stock validation text) and an
  // address step says "Please review and confirm your address" — reading either as review
  // makes replay refuse the ordinary Continue and the backstop lock the page down, the same
  // production false stop as the "(Read-only)" marker. "Review and Confirm" counts only as a
  // heading (end of line / sentence) or followed by the application / submission / permit /
  // request it confirms.
  const REVIEW_PAGE =
    /\bstep\s*\d+\s*[:.\-–—]?\s*review\b|\breview\s+(and|&)\s+(submit|sign|file|certify|finish)\b|\breview\s+(and|&)\s+confirm\b(?=\s*($|[\n.:!])|\s+(your|the|this)\s+(application|submission|permit|request)\b)|\breview\s+(all\s+(of\s+)?(your\s+|the\s+)?|(your|the)\s+)(application|information|details|entries|submission)\b|\bwill\s+not\s+be\s+submitted\s+until\b/i;
  const isReviewPageText = (text: string | null | undefined): boolean => REVIEW_PAGE.test(String(text ?? ""));
  /** A URL that names the review step: Accela's CapConfirm / Confirm.aspx, a "/review" path
   *  segment (bounded — "/reviewer", "/review-comments" are not it). */
  const REVIEW_URL = /capconfirm|confirm\.aspx|\/review(?=[/?#.]|$)/i;
  const looksLikeReviewUrl = (url: string | null | undefined): boolean => REVIEW_URL.test(String(url ?? ""));
  /** THE review signal the learner's page classification, its atReview override, replay's click
   *  gate and the network backstop all read: the page's text (navigator cut) names the review
   *  step, or its URL does. */
  const reviewSignals = (text: string | null | undefined, url?: string | null): boolean =>
    isReviewPageText(text) || looksLikeReviewUrl(url);

  /**
   * Submit-, file- or commit-worded. "Continue Application" — Accela's advance, which FILES on
   * the review page — is excused ONLY when the caller KNOWS it cannot file here: the page does
   * not name itself the review step, AND either it is still fillable (readOnlyPage === false) or
   * nothing has been entered yet (formDataEntered === false — the entry disclaimer). Anything
   * unknown falls to "submit".
   */
  const isSubmitIntent = (label: string | null | undefined, ctx?: ControlContext | null): boolean => {
    const t = String(label ?? "");
    if (!t.trim()) return false;
    if (SUBMIT_WORDS.test(t)) return true;
    // A control whose WHOLE label is "File" / "File now" files (a default button, a filing step).
    // Only the whole label: "File Upload", "Select File" and "File Name" are attachment words.
    if (/^\s*file(\s+now)?\s*[»›>→]*\s*$/i.test(t)) return true;
    if (CONTINUE_APPLICATION.test(t)) {
      const excused = !!ctx && ctx.reviewPage !== true && (ctx.readOnlyPage === false || ctx.formDataEntered === false);
      return !excused;
    }
    return false;
  };

  /**
   * THE filing click: the control that files the application, not merely a submit-worded step.
   * "Continue Application" is the filing click only on a page that NAMES itself the review step.
   * A read-only page that does not (an attachments-only step, a page whose wording we do not
   * know) is NOT proven to be the filing — isSubmitIntent still blocks the click, but a capture
   * session is not ended and a draft is not promoted on a guess.
   */
  const isFinalSubmitControl = (label: string | null | undefined, ctx?: ControlContext | null): boolean => {
    const t = String(label ?? "").replace(/\s+/g, " ").replace(/[»›>→]+\s*$/, "").trim();
    if (!t) return false;
    if (isPayFee(t) && !/^submit\s*(&|and)\s*pay$/i.test(t)) return false;
    if (FINAL_SUBMIT_EXACT.test(t) || FINAL_SUBMIT_PHRASE.test(t)) return true;
    return CONTINUE_APPLICATION.test(t) && !!ctx && ctx.reviewPage === true;
  };

  // A terms / certification acknowledgment. Ticking one is not entering form data, and a page
  // whose only live control is one is still a read-only page.
  const ACCEPT_TERMS = /\b(i\s+)?(agree|accept|certify|acknowledge|attest|consent)\b|terms\s+(and|&)\s+conditions|under\s+penalt/i;
  const isAcceptTermsLabel = (label: string | null | undefined): boolean => !!label && ACCEPT_TERMS.test(String(label));

  /** How a capture surface (human recorder, human patch) must treat a click on this control. */
  const classifyRecordedClick = (label: string | null | undefined, ctx?: ControlContext | null): RecordedClickClass => {
    if (isFinalSubmitControl(label, ctx)) return "finalSubmit";
    if (isSubmitIntent(label, ctx) || isPayFee(label)) return "blocked";
    return "capture";
  };

  /** A field whose typed value must never be stored or sent to an LLM. */
  const isSecretField = (f: FieldIdentity | null | undefined): boolean => {
    if (!f) return false;
    if (String(f.type ?? "").toLowerCase() === "password") return true;
    if (SECRET_AUTOCOMPLETE.test(String(f.autocomplete ?? "").trim())) return true;
    if (BARE_METER_LABEL.test(String(f.label ?? ""))) return true;
    return parts(f).some((p) => SECRET_WORDS.test(p));
  };

  /** A payment-card field — never captured at all, not even sensitively bound. A bare
   *  "Expiration Date" is a card expiry only when the caller knows a card field sits in the same
   *  form (ctx.cardFieldNearby) — on its own it is the contractor's licence expiry. */
  const isPaymentField = (f: FieldIdentity | null | undefined, ctx?: { cardFieldNearby?: boolean } | null): boolean => {
    if (!f) return false;
    if (/^cc-/i.test(String(f.autocomplete ?? "").trim())) return true;
    const ps = parts(f);
    if (ps.some((p) => PAYMENT_WORDS.test(p))) return true;
    return !!ctx && ctx.cardFieldNearby === true && ps.some((p) => /\bexp(iry|iration|ires|\.)?\b|\b(mm|yy|yyyy)\b|\bmonth\b|\byear\b/i.test(p));
  };

  /**
   * Runs IN THE PAGE: does the document show NO fillable form control? Two kinds of live control
   * do not count, because a review page carries them too: a site-wide search box in the header,
   * and a terms/certification acknowledgment (PowerClerk's and Accela's final pages both have
   * one). Unknown (no document) is undefined, never "fillable".
   *
   * An attachment widget (input[type=file]) does not count either. Accela's review page
   * (CapConfirm) carries a live "Attachments" upload input; counting it called the review page
   * fillable, so "Continue Application" there — the filing click — was recorded as ordinary
   * navigation by both recorders and replayed. The cost is on an attachments-ONLY step: it reads
   * read-only, so its "Continue Application" is blocked (not replayable) rather than captured.
   */
  const readOnlyPageInPage = (): boolean | undefined => {
    const d = (globalThis as { document?: Document }).document;
    if (!d || typeof d.querySelectorAll !== "function") return undefined;
    const boxOk = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) !== 0;
    };
    const labelText = (el: HTMLInputElement): string => {
      const bits = [el.getAttribute("aria-label") || ""];
      if (el.labels) for (const l of Array.from(el.labels)) bits.push(l.textContent || "");
      return bits.join(" ");
    };
    const fields = Array.from(d.querySelectorAll(
      "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]):not([type=file]), select, textarea, [contenteditable=true]",
    ));
    return !fields.some((el) => {
      const e = el as HTMLInputElement;
      if (e.disabled || e.readOnly) return false;
      if (e.type === "search" || e.closest("[role=search], form[role=search], header, nav")) return false;
      if (/search/i.test(`${e.getAttribute("name") || ""} ${e.id || ""} ${e.getAttribute("placeholder") || ""}`)) return false;
      if (e.type === "checkbox" || e.type === "radio") {
        if (isAcceptTermsLabel(labelText(e))) return false;
        // A styled checkbox hides its real input (opacity 0 / 1x1) behind a visible label —
        // still a fillable control when the label can be seen.
        if (boxOk(e)) return true;
        return !!e.labels && Array.from(e.labels).some(boxOk);
      }
      return boxOk(e);
    });
  };

  /** Runs IN THE PAGE: does the page's visible text name it the review step? Unknown (no
   *  document/body) is undefined. */
  const reviewPageInPage = (): boolean | undefined => {
    const d = (globalThis as { document?: Document }).document;
    if (!d || !d.body) return undefined;
    return reviewSignals(pageTextWithoutNavigatorInPage(d), (globalThis as { location?: { href?: string } }).location?.href);
  };

  /**
   * Runs IN THE PAGE: the page's laid-out text with its STEP NAVIGATOR cut (see
   * terminalPageInPage). ONE reading for every "does this page name itself the review step"
   * question: EnerGov CSS and PowerClerk list "Review and Submit" / "Review & Submit" in the step
   * bar on EVERY page, so reading the whole body called step 1 the review page — Enter in a search
   * box was then refused as "Enter in its form would submit it" (enterFormScopeOk), and a human's
   * mid-flow click would be classed as the filing click. textContent is the fallback where layout
   * is unavailable.
   */
  //
  // A NAVIGATOR IS A STEP BAR, NOT THE STEP (portal-run-close 3). Angular Material's
  // mat-stepper (class "mat-stepper-horizontal") wraps the step CONTENT as well as its header,
  // and a [class*=stepper|steps|progress] cut swallowed the whole step: a review page whose
  // heading sat inside a "wizard-steps-content" container read as an ordinary form page (its
  // text gone), and every button inside counted as navigator-only (skeptic reviewNextStepsClass:
  // 3 filing POSTs). A candidate is cut only when it holds no fillable control (a site-wide
  // search box does not count, as in readOnlyPageInPage) and — unless it is a semantic
  // nav/navigation/tablist, which may carry a hidden "Main menu" heading — no heading. The
  // nested header ([role=tablist], the <ol class=steps>) is matched on its own by the same
  // querySelectorAll, so the bar is still cut while its content is not.
  const FILLABLE_IN_NAV = "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]):not([type=search]), select, textarea, [contenteditable=true]";
  const holdsFillable = (el: Element): boolean =>
    Array.from(el.querySelectorAll(FILLABLE_IN_NAV)).some((c) => {
      if (c.closest("[role=search], form[role=search]")) return false;
      return !/search/i.test(`${c.getAttribute("name") || ""} ${c.id || ""} ${c.getAttribute("placeholder") || ""} ${c.getAttribute("aria-label") || ""}`);
    });
  const holdsHeading = (el: Element): boolean => !!el.querySelector("h1, h2, h3, h4, h5, h6, legend");
  //
  // THE BAR, NEVER ITS WRAPPER (portal-run-close-2 M1). "No fillable and no heading" is the shape
  // of a REVIEW PAGE too: it has no fillables by nature, and its title may be a <div
  // class="step-title">Step 3: Review and Submit</div>. mat-stepper-horizontal wraps that content
  // with its header, so the whole step was cut, the page did not read as review, the learner
  // clicked the filing "Next" (skeptic reviewStepperNoHeading: 3 POSTs) and the backstop — which
  // reads the same text — saw a non-terminal page. Two rules, both needed:
  //   WRAPPER: a candidate that CONTAINS a step bar (the [role=tablist] header, the <ol> of short
  //            steps, the stepper-header container) and ANY text outside it is a wrapper, never
  //            cut — the nested bar is cut on its own and the step's content stays.
  //   LEAF:    a class-matched candidate with no nested bar is cut only when it has a BAR'S
  //            SHAPE: no fillable, no heading, no paragraph / definition list / table, at least
  //            three lines (a wizard lists its steps) and every line short (step labels).
  //            "wizard-steps-content" holding a div title and "Please review your application…"
  //            is content, and so is a div title over one short line.
  // A semantic nav / navigation / tablist keeps the old rule (no fillable; it may carry a
  // hidden "Main menu" heading). Only the OUTERMOST bar is returned: its items' own texts, cut
  // one by one, would also cut a page title that repeats a step's name ("Review and Submit").
  const BAR_SEMANTIC = "nav, [role=navigation], [role=tablist]";
  const BAR_CANDIDATES = `${BAR_SEMANTIC}, [aria-label*=step i], [class*=stepper], [class*=steps], [class*=stepNav], [class*=step-nav], [class*=step-header], [class*=progress]`;
  const textOf = (el: Element): string => String((el as HTMLElement).innerText || el.textContent || "");
  const shortStepList = (list: Element): boolean => {
    const items = Array.from(list.children);
    return items.length >= 3 && items.every((li) => textOf(li).trim().length < 60);
  };
  const barShaped = (el: Element): boolean => {
    if (el.querySelector("p, dl, table")) return false;
    const text = textOf(el);
    if (text.length > 600) return false;
    // The steps: its element children (through one wrapper), or its lines — inline <span> steps
    // share one line ("1. Customer 2. Documents 3. Review & Submit"), block ones do not.
    // And the steps are ALIKE: one tag, one class (a step's state — active / current / done — set
    // aside). A review step's content is a title div, then rows unlike it.
    const shown = (c: Element): boolean => textOf(c).trim() !== "";
    let items = Array.from(el.children).filter(shown);
    if (items.length === 1 && items[0].children.length >= 3) items = Array.from(items[0].children).filter(shown);
    if (items.length < 3 || !items.every((c) => textOf(c).trim().length < 60)) return false;
    const kind = (c: Element): string => `${c.tagName}.${String(typeof c.className === "string" ? c.className : "").split(/\s+/)
      .filter((k) => k && !/^(is-|has-)|active|current|complete|done|selected|disabled|visited|focus|first|last|odd|even|todo|pending|upcoming/i.test(k)).sort().join(".")}`;
    return items.every((c) => kind(c) === kind(items[0]));
  };
  const isBarItself = (el: Element): boolean => {
    if (holdsFillable(el)) return false;
    if (el.matches(BAR_SEMANTIC)) return true;
    if (el.matches("ol, ul")) return shortStepList(el) && !holdsHeading(el);
    return !holdsHeading(el) && barShaped(el);
  };
  const isStepBar = (el: Element): boolean => {
    if (holdsFillable(el)) return false;
    if (el.matches(BAR_SEMANTIC) || el.matches("ol, ul")) return isBarItself(el);
    if (holdsHeading(el)) return false;
    const inner = Array.from(el.querySelectorAll(`${BAR_CANDIDATES}, ol, ul`)).filter((c) => c !== el && isBarItself(c));
    if (inner.length) {
      // A wrapper: cut only when nothing but its bar(s) is inside.
      let rest = textOf(el);
      for (const n of inner) { const t = textOf(n).trim(); if (t) rest = rest.split(t).join(" "); }
      return rest.trim() === "";
    }
    return barShaped(el);
  };
  //
  // TWO READINGS, AND EVIDENCE BREAKS THE TIE (hand close after portal-run-close-2's skeptic).
  // isStepBar above now serves the signature reader's chrome skip only. For the REVIEW question,
  // guessing which class-matched container is "the step bar" failed both ways across three
  // rounds: the cut wide enough for every real bar (an <a>/<span> mix, a "Step 2 of 4" caption, a
  // help link, chevron separators, a two-step bar) also swallowed a review step whose title is a
  // div inside a "steps"/"stepper"/"progress" container (a learn filed: 3 POSTs), and the
  // alike-items cut that kept that title stopped each of those FORM steps at step 1 (skeptic
  // barSeparators / barMixedTags / barCaption / barHelpLink: the draft-save POST aborted by the
  // review lockdown). So the page is read both ways:
  //   WIDE   — every candidate with no fillable and (unless semantic) no heading, as at 2078e56;
  //   NARROW — only a semantic nav / navigation / tablist, and a short <ol>/<ul> of steps.
  // Both agree: that is the answer. Only NARROW names review — the words sit inside a
  // class-matched container, and it takes positive evidence of a FORM step to call it one: a
  // live fillable control on the page (readOnlyPageInPage false), or a bar that marks its active
  // step and none of the active steps is review. With neither, it is the review page — the
  // direction that cannot file. And whatever either reading says, the page IS review when a
  // bar's ACTIVE step (aria-current / aria-selected / a whole "active"/"current" class token —
  // not mat-stepper's "mat-step-label-active", which a non-linear stepper puts on every step) or
  // a visible panel's own name (aria-label / aria-labelledby of a tabpanel, region, section,
  // dialog, main or form) names the review step: mat-stepper's default review step carries its
  // title nowhere else (skeptic reviewAriaTabpanel: 3 filing POSTs in a learn).
  const wideBar = (el: Element): boolean => {
    if (holdsFillable(el)) return false;
    if (el.matches(BAR_SEMANTIC)) return true;
    return !holdsHeading(el);
  };
  const narrowBar = (el: Element): boolean => {
    if (holdsFillable(el)) return false;
    if (el.matches(BAR_SEMANTIC)) return true;
    return el.matches("ol, ul") && shortStepList(el) && !holdsHeading(el);
  };
  const outermost = (els: Element[]): Element[] => {
    const all = Array.from(new Set(els));
    return all.filter((b) => !all.some((o) => o !== b && o.contains(b)));
  };
  const wideBarsInPage = (d: Document): Element[] => outermost(Array.from(d.querySelectorAll(BAR_CANDIDATES)).filter(wideBar)
    .concat(Array.from(d.querySelectorAll("ol, ul")).filter((list) => shortStepList(list) && wideBar(list))));
  const narrowBarsInPage = (d: Document): Element[] => outermost(Array.from(d.querySelectorAll(`${BAR_SEMANTIC}, ol, ul`)).filter(narrowBar));
  const textWithout = (d: Document, navs: Element[]): string => {
    let pageText = d.body.innerText || d.body.textContent || "";
    for (const el of navs) {
      const t = textOf(el).trim();
      if (t) pageText = pageText.split(t).join(" \n ");
    }
    return pageText;
  };
  const shownEl = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && cs.display !== "none" && cs.visibility !== "hidden";
  };
  const ACTIVE_STEP_ATTR = "[aria-current]:not([aria-current=false]), [aria-selected=true]";
  const activeByClass = (el: Element): boolean => String(typeof el.className === "string" ? el.className : "").split(/\s+/)
    .some((k) => /^(active|current|is-active|is-current|selected|is-selected)$/i.test(k));
  // The texts of the steps a bar marks active (each short; a bar's own container is never one).
  const activeStepTexts = (bars: Element[]): string[] => {
    const out: string[] = [];
    for (const b of bars) {
      for (const it of Array.from(b.querySelectorAll("*"))) {
        if (!it.matches(ACTIVE_STEP_ATTR) && !activeByClass(it)) continue;
        const t = textOf(it).replace(/\s+/g, " ").trim();
        if (t && t.length < 80) out.push(t);
      }
    }
    return out;
  };
  const PANEL_NAMED = "[role=tabpanel], [role=region], [role=dialog], [role=main], section, main, form, [role=form]";
  const panelNamesInPage = (d: Document): string[] => Array.from(d.querySelectorAll(PANEL_NAMED)).filter(shownEl).map((el) => {
    const byId = String(el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map((id) => { const n = d.getElementById(id); return n ? textOf(n) : ""; }).join(" ");
    return `${el.getAttribute("aria-label") || ""} ${byId}`.replace(/\s+/g, " ").trim();
  }).filter(Boolean);
  const reviewReadingInPage = (d: Document): { review: boolean; text: string; navs: Element[] } => {
    const url = (globalThis as { location?: { href?: string } }).location?.href;
    const wide = wideBarsInPage(d);
    const narrow = narrowBarsInPage(d);
    const textWide = textWithout(d, wide);
    const textNarrow = textWithout(d, narrow);
    // Only a bar that LISTS the review step speaks for the step: a site menu's aria-current="page"
    // ("My Permits") says nothing about where the wizard is, and must not count as a form step.
    const active = activeStepTexts(outermost(wide.concat(narrow)).filter((b) => isReviewPageText(textOf(b))));
    const named = active.concat(panelNamesInPage(d)).filter((t) => isReviewPageText(t));
    // The positive read's words ride on the text, so a caller that applies its own wording
    // (the learner's reviewTextInPage) reaches the same answer.
    if (named.length) return { review: true, text: `${textNarrow} \n ${named.join(" \n ")}`, navs: narrow };
    if (reviewSignals(textWide, url)) return { review: true, text: textWide, navs: wide };
    if (!reviewSignals(textNarrow, url)) return { review: false, text: textWide, navs: wide };
    const formEvidence = active.length > 0 || readOnlyPageInPage() === false;
    return formEvidence ? { review: false, text: textWide, navs: wide } : { review: true, text: textNarrow, navs: narrow };
  };
  const pageTextWithoutNavigatorInPage = (d: Document): string => reviewReadingInPage(d).text;

  /**
   * THE E-SIGNATURE STEP (EnerGov CSS step 6, operator ruling 2026-09-26: "This is fine. Push it
   * to the review page."). The bot MAY complete a TYPED e-signature on the draft with the client
   * record's authorized signer; a DRAWN signature is a person's. These are the ONE reading of
   * "is this control the signer's name / the type-signature switch", used by the in-page
   * detector below and by the learner's fill guard (nothing but the signature pass may type
   * into one — a planner would put the contact's or the homeowner's name there).
   *   - the name box: "Please type your name as consent to electronically sign this application"
   *     (Iowa City), a typed-signature box (EnerGov #signatureTypedNameId), and — since the ONE
   *     SIGNER RULE below — a bare "Signature" / "Applicant Signature" label too, or a plain name
   *     box whose own block carries a signing attestation (isSignatureNameBox + textAroundInPage).
   *     None of these is the planner's any more: a planner would type a contact's name there.
   *   - the switch: "Enable Type Signature".
   */
  //
  // ONE SIGNER RULE (portal-run-close MF1, operator ruling: a typed signature is completed with
  // the CLIENT RECORD's authorized signer, never invented, never a contact's or installer's
  // name). A box is a SIGNATURE box when its label, or the statement above it, reads as
  // signing, certifying, attesting or e-signing: "Applicant Signature", "Signature of owner",
  // "Full name of person certifying", "Type your full name" under "I certify under penalty of
  // perjury…" / "By typing your name below you are signing…". The skeptic's probe typed the
  // installer contact ("Casey Contact") into all three of those shapes, because only the
  // e-signature WORDING was recognised. A box the wording names an EMAIL, phone, date, title
  // or attachment ("Customer Email for e-Signature") is never a signature box: the signer's
  // name was typed into PowerClerk's DocuSign email box.
  //   isSignatureNameLabel(label)         — the label alone names it (replay's resolveValue and
  //                                         the fill guard have nothing but the label).
  //   isSignatureNameBox(label, above)    — the label is a name box ("type your full name",
  //                                         "printed name", "full name") and the text AROUND it
  //                                         in its own block (textAroundInPage) attests a
  //                                         signature. The in-page reading uses this; the learner
  //                                         records such a box with an "e-signature:" note, which
  //                                         is how replay knows it again.
  const SIGNATURE_NAME_LABEL =
    /consent\s+to\s+(electronically\s+)?sign|electronically\s+sign|electronic\s+signature|\be-?signature\b|\btyped?\s*signature\b|signature\s*typed|type\s+(in\s+)?your\s+(full[\s-]*)?name\b[^.]{0,40}\bsign|\bsignature\b|\bsign\s+here\b|\b(name|person|party|individual|applicant|owner|contractor|agent|representative)\b[^.]{0,30}\b(certif(y|ying|ies|ier)|attest(s|ing)?|declar(es|ing|ant)|sign(s|ing|ee)?)\b|\b(certif(ying|ier)|attesting|signing|signatory|declarant)\b[^.]{0,30}\bname\b|\bprint(ed)?\s+name\b|\bname\s*\(\s*print(ed)?\s*\)/i;
  // A label that names something ELSE about the signature — never the signer's own name box.
  const SIGNATURE_LABEL_EXCLUDE = /\b(date|e-?mail|phone|fax|title|upload|attach(ment)?|file|initials?|witness|notary|required\?)\b|\bsign(ed)?\s+(copy|form|document|agreement|letter)\b|\bsignature\s+(page|line|block|form|required|date|type|method|style)\b/i;
  const TYPE_SIGNATURE_TOGGLE = /\b(enable|use)\s+typed?\s+signature\b|\btype\s+(a|my|your)\s+signature\s+instead\b/i;
  const isSignatureNameLabel = (label: string | null | undefined): boolean => {
    const t = String(label ?? "").replace(/\s+/g, " ").trim();
    if (!t) return false;
    return SIGNATURE_NAME_LABEL.test(t) && !TYPE_SIGNATURE_TOGGLE.test(t) && !SIGNATURE_LABEL_EXCLUDE.test(t);
  };
  // The statement around a name box that makes typing into it a signature. ABOUT SIGNING, not any
  // "I certify": "I certify that the contact information provided is accurate" above a contacts
  // "Full name" made the contact box a signature box (skeptic contactUnderCertify: the client's
  // signer typed as the contact, or a false pause signature_no_signer on a contacts page). An
  // "I certify / attest / declare…" counts when the same sentence is about the APPLICATION /
  // permit / this form / request / submission, or it is under penalty of perjury; the signing
  // wordings (by typing your name, electronic signature, sign below…) count on their own.
  //
  // PERJURY IS ABOUT SOMETHING (autosubmit-close MF-D). "Under penalty of perjury" used to count
  // on its own, so "I certify under penalty of perjury that the CONTACT information provided is
  // true and correct" above a contacts "Full name" typed the client's signer as the contact (or
  // paused signature_no_signer on a contacts page), and "I declare under penalty of perjury that
  // the contact named above may be reached…" below a lone "Full name" read as a signature. It now
  // counts only when the same sentence is about the application / permit / this form / request /
  // submission, or about signing.
  //
  // SIGNING_TEXT is the signing half of the attestation ("By typing your name below you are
  // signing…", "electronic signature", "sign below"). An "Applicant Name" / "Signer Name" box, and a
  // split First / Last name, are signature boxes only under the STRICT signing act below
  // (SIGNING_ACT_TEXT, MF-E): under an "I certify the information in this application…" alone, or a
  // mention of e-signature as a later process, they are still the contact's names.
  const SIGNING_TEXT =
    /by\s+(typing|entering|providing|printing)\s+(your|my)\s+(full\s+|first\s+and\s+last\s+|legal\s+)?name\b|\bsign(ing|ed|s)?\s+(this\s+)?(application|form|document|agreement|permit|request)?\s*electronically|electronic(ally)?\s+sign|\be-?sign(ature|ing|ed)?\b|consent\s+to\s+(electronically\s+)?sign|constitutes?\s+(your|an?|my|the)\s+(legal\s+|electronic\s+|digital\s+)?signature|\b(your|my|applicant'?s?|owner'?s?|contractor'?s?)\s+(electronic\s+|typed\s+|digital\s+)?signature\b|(^|\n)\s*(e-?|electronic\s+|typed\s+|digital\s+)?signature\s*[:*]?\s*($|\n)|\bsign\s+(below|here)\b/i;
  // THE STRICT HALF, for a ROLE's name box and a split First / Last name: the statement must say
  // that typing the name HERE is the act of signing. A mention of e-signature as a later process —
  // PowerClerk's "the utility will send the interconnection agreement for e-signature through
  // DocuSign" above the CUSTOMER's First / Last Name — must never turn the homeowner's name boxes
  // into the client's signer (auto-submit would file it).
  const SIGNING_ACT_TEXT =
    /by\s+(typing|entering|providing|printing)\s+(your|my)\s+(full\s+|first\s+and\s+last\s+|legal\s+)?name\b|\b(you|i)\s+(are|am)\s+(electronically\s+)?signing\b|consent\s+to\s+(electronically\s+)?sign|constitutes?\s+(your|an?|my|the)\s+(legal\s+|electronic\s+|digital\s+)?signature|\bserves?\s+as\s+(your|my|an?|the)\s+(legal\s+|electronic\s+|digital\s+)?signature|\bsign\s+(below|here)\b|\b(type|enter|print)\s+(your|my)\s+(full\s+|legal\s+|first\s+and\s+last\s+)?name\s+((below|here|above)\s+)?(to|as)\s+(sign|your\s+signature|an?\s+(electronic\s+)?signature)/i;
  // WHO SIGNS, AND WHEN (autosubmit-2 MF-S1). "Sign below" / "consent to sign" counted on their own,
  // so "The homeowner will sign below once the utility approves." above the homeowner's First / Last
  // name, and "The customer must consent to sign the interconnection agreement electronically; the
  // utility will email it after approval." above the customer's, made those boxes the CLIENT's
  // signature — the authorized signer typed as the homeowner, at learn and at replay (auto-submit
  // would file it). A signing act counts only as the applicant's own act, NOW, read SENTENCE BY
  // SENTENCE:
  //   - never when a THIRD PARTY is the subject of the signing verb — a homeowner / owner / customer /
  //     utility (…) followed by an optional modal and "sign" / "consent to sign". The noun alone is
  //     not it: "you are signing as the property owner or the owner's authorized agent" is the
  //     applicant's act;
  //   - the WEAK wordings ("sign below / here", "consent to sign", "e-signature", "Signature") never
  //     in a sentence about a LATER or OFFLINE act ("will sign", "once … approves", "after approval",
  //     "will email", a printed / downloaded form, DocuSign); the STRONG first-person act ("by typing
  //     your name…", "you are signing", "constitutes your signature") still counts beside such a
  //     clause — demoting it would hand a real signature box to the planner's contact (MF1).
  const STRONG_SIGNING_ACT =
    /by\s+(typing|entering|providing|printing)\s+(your|my)\s+(full\s+|first\s+and\s+last\s+|legal\s+)?name\b|\b(you|i)\s+(are|am)\s+(electronically\s+)?signing\b|constitutes?\s+(your|an?|my|the)\s+(legal\s+|electronic\s+|digital\s+)?signature|\bserves?\s+as\s+(your|my|an?|the)\s+(legal\s+|electronic\s+|digital\s+)?signature|\b(type|enter|print)\s+(your|my)\s+(full\s+|legal\s+|first\s+and\s+last\s+)?name\s+((below|here|above)\s+)?(to|as)\s+(sign|your\s+signature|an?\s+(electronic\s+)?signature)/i;
  const THIRD_PARTY_SIGNS =
    /\b(home\s*-?owners?|(property\s+)?owners?|customers?|utility|utilities|landlords?|tenants?|lenders?|spouses?|co-?applicants?|account\s*holders?|other\s+part(y|ies))('s|s')?\s+((must|will|shall|should|may|can|would|needs?\s+to|has\s+to|have\s+to|(is|are)\s+(required|asked|expected)\s+to|also|then|later)\s+)*(consent\s+to\s+)?(electronically\s+|e-?)?sign(s|ed|ing)?\b/i;
  // THE SIGNING ITSELF is later or offline — never a later DELIVERY (autosubmit-close-2 skeptic: "Please
  // sign below and the permit will be emailed to you after approval." and "I consent to sign this
  // application electronically, and I understand the utility will email the agreement after approval."
  // are the applicant signing NOW; demoting them handed the signature box to the planner's contact).
  const LATER_OR_OFFLINE = new RegExp([
    "\\b(will|shall|would)\\s+((later|then|also)\\s+)?(be\\s+)?(e-?)?sign(ed)?\\b", "\\bto\\s+be\\s+(e-?)?signed\\b",
    "\\bsign(ed|ing)?\\s+(it\\s+|this\\s+|them\\s+)?(later|afterwards?|at\\s+(a\\s+)?later)\\b",
    "\\bprint(ed)?\\s+(and|&)\\s+sign\\b", "\\bprinted\\s+(\\w+\\s+){0,2}(form|copy|document|agreement)\\b", "\\bdownload", "\\bwet[\\s-]+(ink\\s+)?signature\\b", "\\bin\\s+person\\b", "\\bnotari[sz]", "\\bdocu-?sign\\b",
  ].join("|"), "i");
  // WHOSE ACT (autosubmit-close-2 skeptic, MF-S1's spec): the subject blacklist above needs noun + modal +
  // "sign" back to back, and "The homeowner, not the installer, must sign below.", "Property owner: sign
  // here.", "Homeowner to sign below…", "The person named on the utility account must sign below.", "Sign
  // below (homeowner)." got past it — our signer typed into the homeowner's boxes. A sentence that names
  // a THIRD PARTY and has no first person (you / I) and no agent capacity ("the owner or the owner's
  // authorized agent", "the applicant") is that party's act, not ours.
  const THIRD_PARTY_NOUN = /\b(home\s*-?owners?|(property\s+)?owners?|customers?|utility|utilities|landlords?|lessors?|lessees?|tenants?|lenders?|spouses?|co-?applicants?|account\s*holders?|property\s+managers?|trustees?|other\s+part(y|ies)|person\s+named)\b/i;
  const FIRST_PERSON = /\b(you|your|i|my|me)\b/i;
  const AGENT_CAPACITY = /\b(agent|authori[sz]ed|representative|applicant|permittee)\b/i;
  const signingActIn = (text: string | null | undefined, act: RegExp): boolean =>
    String(text ?? "").split(/[.!?;\n]+/).some((s) => act.test(s) && !THIRD_PARTY_SIGNS.test(s)
      && !(THIRD_PARTY_NOUN.test(s) && !FIRST_PERSON.test(s) && !AGENT_CAPACITY.test(s))
      && (STRONG_SIGNING_ACT.test(s) || !LATER_OR_OFFLINE.test(s)));
  const ABOUT_THE_FILING ="\\b(application|permit|this\\s+(form|request|submission|document)|sign(s|ing|ed|ature)?)\\b";
  // The certify / perjury half. The signing half (SIGNING_TEXT) is read through signingActIn (MF-S1).
  const ATTESTATION_TEXT = new RegExp([
    "\\bi\\s+(hereby\\s+)?(certify|attest|declare|swear|affirm|acknowledge and certify)\\b[^.]{0,200}\\b(application|permit|this\\s+(form|request|submission|document))\\b",
    "under\\s+(the\\s+)?penalt(y|ies)\\s+of\\s+perjury[^.]{0,200}" + ABOUT_THE_FILING,
    ABOUT_THE_FILING + "[^.]{0,200}under\\s+(the\\s+)?penalt(y|ies)\\s+of\\s+perjury",
  ].join("|"), "i");
  const attestsIn = (text: string): boolean => ATTESTATION_TEXT.test(text) || signingActIn(text, SIGNING_TEXT);
  // A bare name box — the kind an attestation turns into a signature.
  const NAME_BOX_LABEL =
    /\b(type|print|enter)\s+(in\s+)?(your|my)\s+(full\s+|legal\s+)*name\b|\b(your|my)\s+(full\s+|legal\s+)+name\b|^\s*(full\s+|legal\s+)*name\s*(\*|:)?\s*$|\b(full|legal)\s+name\s+of\s+(the\s+)?(person|individual|party)\b/i;
  // A ROLE's name box ("Applicant Name", "Signer Name", "Owner's Full Name") — a signature box only
  // under a SIGNING statement (MF-E b/c).
  const ROLE_NAME_BOX_LABEL =
    /^\s*(applicant|owner|property\s+owner|signer|signatory|contractor|agent|authorized\s+(agent|signer|signatory|representative))('?s)?\s+(full\s+|legal\s+|printed\s+)?name\s*[*:]?\s*$/i;
  // A label that WRAPS its statement ("<label><span>I certify … this application …</span><span>Full
  // name *</span><input></label>", MF-E a): the box's own name is the label's last segment, the
  // statement its head.
  const labelTail = (t: string): { head: string; tail: string } => {
    const parts = t.split(/(?<=[.!?:])\s*/).map((s) => s.trim()).filter(Boolean);
    const tail = parts.length > 1 ? parts[parts.length - 1] : t;
    return { head: parts.length > 1 ? parts.slice(0, -1).join(" ") : "", tail };
  };
  const isSignatureNameBox = (label: string | null | undefined, textAbove?: string | null): boolean => {
    if (isSignatureNameLabel(label)) return true;
    const t = String(label ?? "").replace(/\s+/g, " ").trim();
    if (!t || TYPE_SIGNATURE_TOGGLE.test(t)) return false;
    const { head, tail } = labelTail(t);
    if (SIGNATURE_LABEL_EXCLUDE.test(tail)) return false;
    const around = `${head}\n${String(textAbove ?? "")}`;
    if ((NAME_BOX_LABEL.test(t) || NAME_BOX_LABEL.test(tail)) && attestsIn(around)) return true;
    return ROLE_NAME_BOX_LABEL.test(tail) && signingActIn(around, SIGNING_ACT_TEXT);
  };
  // A SPLIT signature (MF-E d): "First name" / "Last name" under a SIGNING statement ("By typing
  // your first and last name below you are signing…") — the authorized signer's first / last name,
  // never a contact's. "" = not a part of a signature.
  const FIRST_NAME_BOX = /^\s*(first|given)\s*-?\s*name\s*[*:]?\s*$/i;
  const LAST_NAME_BOX = /^\s*(last|sur|family)\s*-?\s*name\s*[*:]?\s*$/i;
  const signatureNamePartOf = (label: string | null | undefined, textAbove?: string | null): "first" | "last" | "" => {
    const t = String(label ?? "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    const { head, tail } = labelTail(t);
    const part = FIRST_NAME_BOX.test(tail) ? "first" : LAST_NAME_BOX.test(tail) ? "last" : "";
    return part && signingActIn(`${head}\n${String(textAbove ?? "")}`, SIGNING_ACT_TEXT) ? part : "";
  };
  /** The signer's first or last name for a split signature: the first token / the last token
   *  (a trailing Jr./Sr./II/III/IV/Esq. is not a last name; "Signer, Dana" reads last-first).
   *  "" when the name cannot be split into two — the run pauses rather than guess. */
  const splitSignerName = (name: string | null | undefined, part: "first" | "last"): string => {
    const raw = String(name ?? "").replace(/\s+/g, " ").trim();
    if (!raw) return "";
    let first = "";
    let last = "";
    const comma = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (comma.length === 2 && !/^(jr|sr|ii|iii|iv|esq|phd|md)\.?$/i.test(comma[1])) {
      last = comma[0];
      first = comma[1].split(" ")[0];
    } else {
      const toks = raw.replace(/,/g, " ").split(" ").filter(Boolean);
      while (toks.length > 2 && /^(jr|sr|ii|iii|iv|esq|phd|md)\.?$/i.test(toks[toks.length - 1])) toks.pop();
      if (toks.length < 2) return "";
      first = toks[0];
      last = toks[toks.length - 1];
    }
    return part === "first" ? first : last;
  };
  const isTypeSignatureToggleLabel = (label: string | null | undefined): boolean => !!label && TYPE_SIGNATURE_TOGGLE.test(String(label));

  /**
   * Runs IN THE PAGE: the text AROUND a control within its OWN BLOCK — siblings before AND after
   * it, ascending (nearest first), until the level whose parent also holds ANOTHER, UNRELATED
   * fillable control: there only the siblings up to that control are read, and the reading
   * stops. Never the whole contacts form: an "I certify" tick elsewhere must not turn a plain
   * "Full name" box into a signature.
   *
   * portal-run-close-2 M2. This read "the preceding siblings at up to four ancestor levels", and
   * was wrong both ways: a statement BELOW the box ("By typing your name above you are
   * signing…", skeptic sibBelow) and one in a sibling <section> five levels up (sibAbove5,
   * ordinary Angular nesting) were missed — the installer contact was typed into the signature
   * box, at learn AND at replay — while a contacts step whose "I certify the contact information
   * is accurate" tick sat two siblings above "Full name" became a signature box. RELATED controls
   * do not bound the block: a Date / Title / Initials box, or any control whose label says
   * "sign", is part of a signature block. A checkbox or radio does not bound it either (the
   * attestation tick is one). Capped at twelve levels and `cap` characters.
   */
  // Word-bounded "sign": "Design firm" / "Assigned inspector" are unrelated contact fields and
  // must bound the block (a bare substring let a design-professional section read up to an
  // attestation above it).
  // A first / last / middle name box is part of a split signature block (MF-E d), so the "Last
  // name" box still reads the statement above its "First name" partner.
  const SIGNATURE_BLOCK_RELATED = /\b(date|title|initials?)\b|\b(e-?)?sign|\b(first|last|middle|given|family|sur)\s*-?\s*name\b/i;
  const textAroundInPage = (el: Element, cap = 1500): string => {
    const clean = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();
    const shownBox = (c: Element): boolean => {
      const r = c.getBoundingClientRect();
      const cs = getComputedStyle(c);
      return r.width > 1 && r.height > 1 && cs.display !== "none" && cs.visibility !== "hidden";
    };
    const OTHER = "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=search]), select, textarea";
    // An unrelated fillable control inside `root` (other than the box itself)?
    const unrelatedIn = (root: Element): boolean => {
      const all = root.matches(OTHER) ? [root] : [];
      return all.concat(Array.from(root.querySelectorAll(OTHER))).some((c) => {
        if (c === el || c.contains(el) || !shownBox(c)) return false;
        const label = String(controlLabelInPage(c) || c.getAttribute("aria-label") || c.getAttribute("placeholder") || `${c.id || ""} ${c.getAttribute("name") || ""}`);
        return !SIGNATURE_BLOCK_RELATED.test(label);
      });
    };
    const bits: string[] = [];
    let total = 0;
    const push = (t: string): void => { if (t && total < cap) { bits.push(t); total += t.length; } };
    const body = el.ownerDocument ? el.ownerDocument.body : null;
    let node: Element | null = el;
    for (let hops = 0; node && node.parentElement && hops < 12 && total < cap; hops++) {
      const parent: Element = node.parentElement;
      const bounded = unrelatedIn(parent);
      // A wrapping <label>/<fieldset>'s own text (its statement) belongs to the box.
      if (node !== el && (node.tagName === "LABEL" || node.tagName === "FIELDSET")) {
        push(clean(Array.from(node.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(" ")));
      }
      for (const dir of ["previousElementSibling", "nextElementSibling"] as const) {
        let sib: Element | null = node[dir];
        while (sib && total < cap) {
          if (bounded && unrelatedIn(sib)) break;
          // Not the page's chrome: a step bar listing "Signature", a site header or footer.
          const chrome = /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(sib.tagName)
            || sib.matches("nav, header, footer, [role=navigation], [role=banner], [role=contentinfo]")
            || ((sib.matches(BAR_CANDIDATES) || (sib.matches("ol, ul") && shortStepList(sib))) && isStepBar(sib));
          if (!chrome) push(clean((sib as HTMLElement).innerText || sib.textContent));
          sib = sib[dir];
        }
      }
      if (bounded || parent.tagName === "FORM" || parent === body) break;
      node = parent;
    }
    return bits.join(" \n ").slice(0, cap);
  };

  /**
   * Runs IN THE PAGE: is this an e-signature step, and can the bot complete it?
   *   typed — a type-signature switch or typed-signature box is offered (Iowa City: the consent
   *           name + "Enable Type Signature" + the typed box, which draws into the pad for you);
   *           or only a consent-name box and no pad at all;
   *   drawn — a signature pad (a visible <canvas> in a signature container) and NO way to type
   *           it (Carlsbad: "Type in your full-name and draw your signature in the box below").
   * Marks the controls data-al-sig="consent" | "toggle" | "typed" and returns each one's id /
   * label / name for recording. "" = not a signature step. A pad on an ordinary page with no
   * signature wording is not read as a signature step.
   */
  const signatureStepInPage = (): {
    kind: "typed" | "drawn" | "";
    why: string;
    controls: Array<{ role: "consent" | "toggle" | "typed"; id: string; label: string; name: string; tag: string; type: string; part?: "first" | "last"; index: number }>;
  } => {
    const d = (globalThis as { document?: Document }).document;
    const none = { kind: "" as const, why: "", controls: [] };
    if (!d || !d.body) return none;
    for (const e of Array.from(d.querySelectorAll("[data-al-sig]"))) { e.removeAttribute("data-al-sig"); e.removeAttribute("data-al-sig-i"); e.removeAttribute("data-al-sig-part"); }
    const shown = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && cs.display !== "none" && cs.visibility !== "hidden";
    };
    const nameOf = (el: Element): string => String(controlLabelInPage(el) || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim();
    const idWords = (el: Element): string => `${el.id || ""} ${el.getAttribute("name") || ""}`.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.[\]]+/g, " ");
    const controls: Array<{ role: "consent" | "toggle" | "typed"; id: string; label: string; name: string; tag: string; type: string; part?: "first" | "last"; index: number }> = [];
    // Each control carries its own index (data-al-sig-i): a page with TWO boxes of one role (a
    // split first / last signature) is filled box by box, never twice into the first.
    const take = (el: Element, role: "consent" | "toggle" | "typed", part?: "first" | "last"): void => {
      if (el.getAttribute("data-al-sig")) return;
      el.setAttribute("data-al-sig", role);
      el.setAttribute("data-al-sig-i", String(controls.length));
      if (part) el.setAttribute("data-al-sig-part", part);
      controls.push({ role, id: el.id || "", label: nameOf(el), name: el.getAttribute("name") || "", tag: el.tagName.toLowerCase(), type: String((el as HTMLInputElement).type || "").toLowerCase(), ...(part ? { part } : {}), index: controls.length });
    };
    // The switch: a checkbox / role=switch / button whose label says "Enable Type Signature".
    for (const el of Array.from(d.querySelectorAll("input[type=checkbox], [role=switch], [role=checkbox], button"))) {
      const label = nameOf(el) || String((el as HTMLElement).innerText || "").trim();
      const styledOk = shown(el) || (el as HTMLInputElement).labels && Array.from((el as HTMLInputElement).labels || []).some(shown);
      if (styledOk && isTypeSignatureToggleLabel(label)) take(el, "toggle");
    }
    const parts: Array<{ el: Element; part: "first" | "last" }> = [];
    // The name boxes (disabled ones count: EnerGov's typed box unlocks when the switch is on).
    // NOT AN ECHO: a locked box that already holds a name is the review page showing the
    // signature back (skeptic reviewEchoTyped: "Type Signature" disabled, value "Dana Signer"
    // on the review step ended the run signature_incomplete instead of reaching review). A
    // locked EMPTY box is still a step (EnerGov's typed box before the switch).
    for (const el of Array.from(d.querySelectorAll("input:not([type]), input[type=text], textarea"))) {
      if (!shown(el)) continue;
      const box = el as HTMLInputElement;
      if ((box.disabled || box.readOnly) && String(box.value ?? "").trim() !== "") continue;
      const label = nameOf(el);
      const typedBox = /\btyped?\s*signature\b|signature\s*typed/i.test(`${label} ${idWords(el)}`);
      if (typedBox) { take(el, "typed"); continue; }
      const around = textAroundInPage(el);
      // A <label> that WRAPS the box and its statement reads (capped) as the statement's head —
      // "Full name *" falls off the end (MF-E a). The box's own name is then the nearest text
      // before it inside that label.
      let own = "";
      const wrap = el.closest("label");
      if (wrap && !wrap.getAttribute("for")) {
        for (let s: ChildNode | null = el.previousSibling; s && !own; s = s.previousSibling) {
          own = String(s.nodeType === 3 ? s.nodeValue : ((s as HTMLElement).innerText || s.textContent || "")).replace(/\s+/g, " ").trim();
        }
      }
      if (isSignatureNameBox(label, around) || (own && isSignatureNameBox(own, around))) { take(el, "consent"); continue; }
      const part = signatureNamePartOf(label, around) || (own ? signatureNamePartOf(own, around) : "");
      if (part) parts.push({ el, part });
    }
    // A SPLIT signature is a FIRST and a LAST name box, and the page's only way to sign: a lone
    // "Last name", or First / Last name boxes on a page that already has a signature box (a contact
    // block read past it), stay the planner's.
    if (!controls.some((c) => c.role === "consent" || c.role === "typed") && parts.some((x) => x.part === "first") && parts.some((x) => x.part === "last")) {
      for (const x of parts) take(x.el, "consent", x.part);
    }
    // The pad: a visible canvas inside (or named as) a signature container.
    const pad = Array.from(d.querySelectorAll("canvas")).find((c) => {
      if (!shown(c)) return false;
      for (let p: Element | null = c, i = 0; p && i < 5; p = p.parentElement, i++) {
        if (/signature|sig-?pad|e-?sign/i.test(`${p.id || ""} ${typeof p.className === "string" ? p.className : ""} ${p.getAttribute("aria-label") || ""}`)) return true;
      }
      return false;
    });
    const hasToggle = controls.some((c) => c.role === "toggle");
    const hasTyped = controls.some((c) => c.role === "typed");
    const hasConsent = controls.some((c) => c.role === "consent");
    if (!hasToggle && !hasTyped && !hasConsent && !pad) return none;
    if (!hasToggle && !hasTyped && !hasConsent) {
      // A pad alone is a signature step only when the page's own text says so — and never on
      // the page that names itself the review step: there the pad is the signature ECHOED
      // (skeptic reviewEchoCanvas), and the run must reach review, not stop signature_drawn.
      // A person signs on the review page anyway when the portal wants a drawn one there.
      const text = pageTextWithoutNavigatorInPage(d);
      if (!/\bsign(ature)?\b/i.test(text)) return none;
      if (reviewSignals(text, (globalThis as { location?: { href?: string } }).location?.href)) return none;
      return { kind: "drawn", why: "a signature pad (canvas) and no way to type the signature", controls };
    }
    if (pad && !hasToggle && !hasTyped) return { kind: "drawn", why: "a typed consent name AND a signature pad to draw in, with no type-signature option", controls };
    return { kind: "typed", why: hasToggle ? "a type-signature option" : hasTyped ? "a typed-signature box" : "a typed consent name and no pad", controls };
  };

  /** Runs IN THE PAGE: the page's text with the step navigator cut (the reading reviewPageInPage
   *  and terminalPageInPage judge), for a caller that applies its own wording on top. */
  const reviewTextInPage = (): string => {
    const d = (globalThis as { document?: Document }).document;
    return d && d.body ? pageTextWithoutNavigatorInPage(d) : "";
  };

  /** Runs IN THE PAGE: the labels of VISIBLE controls that appear ONLY inside the step navigator
   *  (a clickable "Review and Submit" step, never a button of the page itself). A label that also
   *  names a control outside the navigator is not listed. Whitespace-collapsed, lower-cased. */
  const navigatorOnlyControlLabelsInPage = (): string[] => {
    const d = (globalThis as { document?: Document }).document;
    if (!d || !d.body) return [];
    const navs = reviewReadingInPage(d).navs;
    const inNav = new Set<string>();
    const outside = new Set<string>();
    for (const el of Array.from(d.querySelectorAll("a, button, [role=button], [role=link], [role=tab], input[type=submit], input[type=button]"))) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) continue;
      const names = [controlLabelInPage(el), (el as HTMLElement).innerText, (el as HTMLInputElement).value, el.getAttribute("aria-label")]
        .map((s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean);
      const target = navs.some((n) => n.contains(el)) ? inNav : outside;
      for (const n of names) target.add(n);
    }
    return Array.from(inNav).filter((l) => !outside.has(l));
  };

  /**
   * Runs IN THE PAGE: THE ONE "IS THIS PAGE TERMINAL?" QUESTION — does the page NAME itself the
   * review step, is it read-only, and does it show a filing-shaped control. terminal = review, or
   * read-only with a filing control. Asked by replay's click gate (pageSafetyContext) AND by the
   * network backstop's review-page lockdown, so the two can never disagree about where review is.
   * Unknown (no document) answers every question with undefined.
   *
   * THE PAGE, NOT ITS STEP NAVIGATOR. A wizard lists every step on every page ("Review & Submit"
   * in PowerClerk's step bar, the SPA's stepper header), so the whole body names the review step
   * on page one. The page's LAID-OUT text (innerText, so block boundaries stay word boundaries) is
   * read with the navigator's text cut. Deliberately NOT header/footer: a portal may put the
   * page's own title in a <header>, and losing it would un-name a review page — the direction
   * that files.
   */
  const terminalPageInPage = (): { reviewPage?: boolean; readOnlyPage?: boolean; filingControl?: string; terminal?: boolean } => {
    const d = (globalThis as { document?: Document }).document;
    if (!d || !d.body) return {};
    const reviewPage = reviewSignals(pageTextWithoutNavigatorInPage(d), (globalThis as { location?: { href?: string } }).location?.href);
    const readOnlyPage = readOnlyPageInPage();
    const filing = Array.from(d.querySelectorAll("button, a, input[type=submit], input[type=button], input[type=image], [role=button], [role=link]"))
      .filter((el) => { const r = (el as HTMLElement).getBoundingClientRect(); return r.width > 2 && r.height > 2; })
      .map((el) => String(controlLabelInPage(el) || (el as HTMLElement).innerText || (el as HTMLInputElement).value || ""))
      .find((t) => isFinalSubmitControl(t, { reviewPage }));
    const filingControl = filing || "";
    return { reviewPage, readOnlyPage, filingControl, terminal: reviewPage === true || (readOnlyPage === true && !!filingControl) };
  };

  /**
   * Runs IN THE PAGE: a form control's identity as a HUMAN sees it — attribute names plus the
   * text of its <label for> and its wrapping <label>. Never its value. The CVV that reached a
   * shared recipe as a literal had no telling attribute at all: Accela labels it with a plain
   * <label>CVV:</label>, so reading attributes alone caught the card number and missed its three
   * neighbours.
   */
  /**
   * Runs IN THE PAGE: the text of a LABELLING element about `field`, with every form control's
   * own text removed — the field itself, and any select / option / listbox / combobox / textarea /
   * input / textbox inside the label. A <select>'s textContent is every option (a meter number),
   * a textarea's is what was typed, a widget's rendered selection is the current value. Walked by
   * node, not string-replaced: `<label for=m>Meter <select id=m>..1009283745..</select></label>`
   * gave "Meter --1009283745" on the label[for] route, which also un-matched BARE_METER_LABEL
   * (recorder skeptic F5, probes G-a / H).
   */
  const labelTextOf = (labelEl: Element | null | undefined, field: Element | null | undefined): string => {
    if (!labelEl) return "";
    // Only a FIELD has a value to leak. A button or link labelled by itself or by a container
    // (aria-labelledby="btn row3") keeps its text, exactly as before.
    const FIELDISH = "select, textarea, input:not([type=submit]):not([type=button]):not([type=image]):not([type=reset]), [role=combobox], [role=listbox], [role=textbox], [role=searchbox]";
    if (!field || typeof field.matches !== "function" || !field.matches(FIELDISH)) return String(labelEl.textContent || "").replace(/\s+/g, " ").trim();
    const SKIP ="select, option, optgroup, textarea, input, [role=listbox], [role=combobox], [role=option], [role=textbox], [role=searchbox], [contenteditable=true]";
    let out = "";
    const walk = (n: Node): void => {
      if (n.nodeType === 3) { out += n.nodeValue || ""; return; }
      if (n.nodeType !== 1) return;
      const e = n as Element;
      // A removed control leaves a word boundary; plain text concatenates exactly as textContent.
      if (field && e === field) { out += " "; return; }
      if (e !== labelEl && typeof e.matches === "function" && e.matches(SKIP)) { out += " "; return; }
      if (/^(SCRIPT|STYLE|TEMPLATE)$/.test(e.tagName)) return;
      for (const c of Array.from(n.childNodes)) walk(c);
    };
    // A labelling element that IS a control, or sits inside the field (a widget's rendered
    // selection), labels nothing — it is the field's own value.
    if (field && (labelEl === field || field.contains(labelEl))) return "";
    if (labelEl !== field && typeof labelEl.matches === "function" && labelEl.matches("select, option, textarea, input, [role=option], [role=listbox]")) return "";
    walk(labelEl);
    return out.replace(/\s+/g, " ").trim();
  };

  const fieldIdentityInPage = (el: Element): FieldIdentity => {
    const labels: string[] = [];
    const id = el.getAttribute("id");
    let forLabel: Element | null = null;
    if (id) {
      try {
        const root = (el.getRootNode ? el.getRootNode() : null) as Document | null;
        const esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"');
        forLabel = root && root.querySelector ? root.querySelector(`label[for="${esc}"]`) : null;
        const t = labelTextOf(forLabel, el);
        if (t) labels.push(t);
      } catch { /* attributes are still read */ }
    }
    const wrap = el.closest ? el.closest("label") : null;
    if (wrap && wrap !== forLabel) {
      // A <select>/<textarea> inside its <label>: the label's text minus every control's own text
      // (its options / what was typed) — never a value.
      const t = labelTextOf(wrap, el);
      if (t) labels.push(t);
    }
    return {
      label: labels.join(" ").replace(/\s+/g, " ").trim(),
      name: el.getAttribute("name") || "",
      id: id || "",
      autocomplete: el.getAttribute("autocomplete") || "",
      type: String((el as HTMLInputElement).type || ""),
      placeholder: el.getAttribute("placeholder") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
    };
  };

  /**
   * Runs IN THE PAGE: the ARIA role a replay selector should use for this control. An
   * <input type=submit|button|image|reset> is a BUTTON — mapping every INPUT to "textbox" made
   * `<input type=submit value="Next">` a selector that can never match at replay.
   */
  const controlRoleInPage = (el: Element): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === "INPUT") {
      const t = String((el as HTMLInputElement).type || "text").toLowerCase();
      if (t === "submit" || t === "button" || t === "image" || t === "reset") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "file" || t === "hidden") return "";
      return "textbox";
    }
    return ({ BUTTON: "button", SELECT: "combobox", A: "link", TEXTAREA: "textbox", SUMMARY: "button" } as Record<string, string>)[tag] || "";
  };

  /**
   * Runs IN THE PAGE: the label a PERSON reads on this control — the text every click
   * classifier (submit? pay? filing?) is asked about, so an empty answer is a hole: the
   * recorder once captured `<input type=submit value="Submit">` and `<button><img
   * alt="Submit Application"></button>` as replayable clicks because it read neither `value`
   * nor `alt`. Read in accessible-name order: aria-label, aria-labelledby, <label for>, a
   * wrapping <label> (form fields), a button's value / an image's alt / an img child's alt,
   * the text of a button or link, placeholder, title.
   *
   * A form field's own TEXT is never its label: a <select>'s textContent is every option
   * concatenated (a meter-number select would copy the meter numbers into the recipe), a
   * listbox/combobox's is its options, a textarea's is what was typed.
   */
  /**
   * Runs IN THE PAGE: does this aria-labelledby target RENDER THE WIDGET'S CURRENT SELECTION
   * rather than label it? Generic, not select2/chosen-only (checker close-mustfix MF3: a plain ARIA
   * combobox with aria-labelledby="lbl cur", #cur a sibling span showing the previously selected
   * meter number, put that number in the recorded selector). Any one of:
   *   1. PARTNER OF A NATIVE CONTROL the widget fronts: its id is "<stem>_label" / "-label" /
   *      "_container" / "_display" / "_selection" / "_value" / "select2-<stem>-container", and
   *      <stem> (or <stem>_input / _select / _focus) is a native select/input other than the field
   *      — or a container holding both the field and such a native control (PrimeFaces' <id> div
   *      around <id>_focus, <id>_input and <id>_label);
   *   2. ITS TEXT IS THE FIELD'S VALUE: the field's own value / aria-valuetext / selected option,
   *      or the value of a hidden native control right beside it;
   *   3. THE ARIA 1.0 "label value" PAIR: the list also names a real label (label, legend,
   *      heading) and this target is not one but a sibling element of the field (or of the
   *      field's wrapper) — the pattern that labels a widget by its label AND its displayed value.
   * The capture listener runs BEFORE the page updates the display, so rule 2 sees the PRIOR value
   * in the display and an empty native control; rules 1 and 3 are structural and carry that case.
   */
  const isRenderedValueOf = (t: Element, field: Element, all: Element[]): boolean => {
    if (!field || typeof field.matches !== "function") return false;
    const FIELDISH = "select, textarea, input:not([type=submit]):not([type=button]):not([type=image]):not([type=reset]), [role=combobox], [role=listbox], [role=textbox], [role=searchbox], [role=spinbutton]";
    if (!field.matches(FIELDISH)) return false;
    const clean = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();
    const root = (field.getRootNode ? field.getRootNode() : null) as Document | ShadowRoot | null;
    const byId = (id: string): Element | null => {
      try { return root && (root as Document).getElementById ? (root as Document).getElementById(id) : (root ? root.querySelector(`#${CSS.escape(id)}`) : null); } catch { return null; }
    };
    const isNative = (e: Element | null): e is HTMLInputElement | HTMLSelectElement =>
      !!e && e !== field && (e.tagName === "SELECT" || (e.tagName === "INPUT" && !/^(submit|button|image|reset|checkbox|radio|file)$/i.test(String((e as HTMLInputElement).type || ""))));
    const nativeText = (e: HTMLInputElement | HTMLSelectElement): string[] => {
      const out = [clean(e.value)];
      if (e.tagName === "SELECT") for (const o of Array.from((e as HTMLSelectElement).selectedOptions || [])) out.push(clean(o.textContent));
      return out.filter(Boolean);
    };
    // 1. partner of a native control
    const id = String(t.getAttribute("id") || "");
    const m = /^select2-(.+)-container$/.exec(id) || /^(.+?)[_-](label|container|display|selection|value|text)$/i.exec(id);
    if (m) {
      const stem = m[1];
      for (const cand of [stem, `${stem}_input`, `${stem}_select`, `${stem}_focus`, `${stem}-input`]) {
        const e = byId(cand);
        if (isNative(e) && e !== field) return true;
        if (e && cand === stem && e.contains(field) && e.contains(t) && e.querySelector("select, input[type=hidden]")) return true;
      }
    }
    // 2. its text is the field's value
    const text = clean(t.textContent);
    if (text) {
      const values: string[] = [];
      const f = field as HTMLInputElement | HTMLSelectElement;
      if (typeof f.value === "string") values.push(clean(f.value));
      values.push(clean(field.getAttribute("aria-valuetext")));
      if (field.tagName === "SELECT") for (const o of Array.from((field as HTMLSelectElement).selectedOptions || [])) values.push(clean(o.textContent));
      for (const sib of [field.previousElementSibling, field.nextElementSibling]) {
        if (isNative(sib) && (String((sib as HTMLInputElement).type || "").toLowerCase() === "hidden" || sib.tagName === "SELECT")) values.push(...nativeText(sib));
      }
      if (values.filter(Boolean).includes(text)) return true;
    }
    // 3. the "label value" pair
    const POSITIVE = (e: Element): boolean => /^(LABEL|LEGEND|H[1-6]|CAPTION|TH|DT)$/.test(e.tagName) || e.getAttribute("role") === "heading";
    if (!POSITIVE(t) && all.some((o) => o !== t && POSITIVE(o))) {
      const parents = [field.parentElement, field.parentElement ? field.parentElement.parentElement : null].filter(Boolean);
      if (t.parentElement && parents.includes(t.parentElement)) return true;
    }
    return false;
  };

  const controlLabelInPage = (el: Element): string => {
    const clean = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();
    const tag = el.tagName;
    const role = String(el.getAttribute("role") || "").toLowerCase();
    const type = String((el as HTMLInputElement).type || "").toLowerCase();
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria.slice(0, 120);
    const root = (el.getRootNode ? el.getRootNode() : null) as Document | ShadowRoot | null;
    const byId = (id: string): Element | null => {
      try { return root && (root as Document).getElementById ? (root as Document).getElementById(id) : (root ? root.querySelector(`#${CSS.escape(id)}`) : null); } catch { return null; }
    };
    // EVERY LABEL ROUTE STRIPS THE FIELD'S OWN TEXT (labelTextOf): aria-labelledby that points at
    // a widget's rendered selection (select2's "select2-<id>-container" — the CURRENT VALUE) or at
    // a container holding the field, a label[for] that wraps its own <select>, a wrapping label.
    const lbTargets = String(el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map((id) => byId(id)).filter((t): t is Element => !!t);
    const labelledBy = clean(lbTargets.filter((t) => !isRenderedValueOf(t, el, lbTargets))
      .map((t) => labelTextOf(t, el)).join(" "));
    if (labelledBy) return labelledBy.slice(0, 120);
    const isField = tag === "SELECT" || tag === "TEXTAREA" || (tag === "INPUT" && !/^(submit|button|image|reset)$/.test(type));
    const id = el.getAttribute("id");
    if (id && root) {
      try {
        const lbl = root.querySelector(`label[for="${CSS.escape(id)}"]`);
        const t = clean(labelTextOf(lbl, el));
        if (t) return t.slice(0, 120);
      } catch { /* fall through */ }
    }
    if (isField) {
      // A wrapping <label>'s text, minus every control's own text (a <select> inside a <label>).
      const wrap = el.closest ? el.closest("label") : null;
      if (wrap) {
        const t = clean(labelTextOf(wrap, el));
        if (t) return t.slice(0, 120);
      }
    }
    if (tag === "INPUT" && /^(submit|button|reset)$/.test(type)) {
      const v = clean((el as HTMLInputElement).value || el.getAttribute("value"));
      if (v) return v.slice(0, 120);
    }
    if (tag === "INPUT" && type === "image") {
      const a = clean(el.getAttribute("alt") || el.getAttribute("value"));
      if (a) return a.slice(0, 120);
    }
    const textless = isField || role === "listbox" || role === "combobox" || role === "option" || role === "textbox" || role === "searchbox";
    if (!textless) {
      const t = clean(el.textContent);
      if (t) return t.slice(0, 120);
      const img = el.querySelector ? el.querySelector("img[alt], [role=img][aria-label]") : null;
      const alt = clean(img && (img.getAttribute("alt") || img.getAttribute("aria-label")));
      if (alt) return alt.slice(0, 120);
    }
    const ph = clean(el.getAttribute("placeholder"));
    if (ph) return ph.slice(0, 120);
    return clean(el.getAttribute("title")).slice(0, 120);
  };

  /** Runs IN THE PAGE: is this element a payment-card field? Its own identity decides first; a
   *  bare expiry decides by whether a card field shares its form (or document). */
  const isPaymentElementInPage = (el: Element): boolean => {
    if (isPaymentField(fieldIdentityInPage(el))) return true;
    const form = (el as HTMLInputElement).form;
    const scope = (form || (el.getRootNode ? el.getRootNode() : null)) as ParentNode | null;
    const others = scope && typeof scope.querySelectorAll === "function" ? Array.from(scope.querySelectorAll("input, select, textarea")) : [];
    const cardFieldNearby = others.some((o) => o !== el && isPaymentField(fieldIdentityInPage(o)));
    return isPaymentField(fieldIdentityInPage(el), { cardFieldNearby });
  };

  /**
   * Runs IN THE PAGE: may an overlay DISMISSER (not a recorded step) click this control? Returns
   * the refusal reason, or "" when the click only closes something.
   *
   * The dismisser's list reaches `[role=dialog] button` and a bare "OK": on a confirm dialog that
   * says "You are about to submit your application", OK IS the filing click, and the first button
   * of a Bootstrap confirm can be "Submit Application" itself. A close-only label (Got it, Close,
   * Dismiss, x, Cancel, a close icon) closes whatever the dialog says. Any other label — OK, Yes,
   * Accept, Confirm, a dialog's arbitrary first button — answers the dialog's QUESTION, so the
   * dialog's own text is read too: a question about submitting, filing or paying is refused.
   * Unknown (no element) refuses.
   *
   * INVARIANT (checker close-mustfix P1 — a word list lost to "send your application to the
   * city", "your card will be charged", "By accepting you certify"): the dismisser clicks ONLY
   * (i) a close-only control, or (ii) an answer-shaped control inside a container POSITIVELY
   * identified as a cookie / consent / announcement banner — and in both cases never a control
   * that submits, posts back or navigates. Everything else, including a control in no container
   * at all, is unknown and refused.
   */
  const dismissalRefusalInPage = (el: Element | null | undefined): string => {
    if (!el) return "the control could not be read";
    const clean = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();
    const h = el as HTMLElement;
    const label = clean(controlLabelInPage(el) || h.innerText || (el as HTMLInputElement).value || "");
    const shown = `"${label.slice(0, 40) || "(unlabelled)"}"`;
    if (isPayFee(label)) return `"${label.slice(0, 60)}" pays a fee`;
    if (isSubmitIntent(label, null) || isFinalSubmitControl(label, { reviewPage: true })) return `"${label.slice(0, 60)}" is submit-worded`;
    // (b) A DISMISSER NEVER SUBMITS OR NAVIGATES, whatever it is labelled. A dismissal only hides
    // something; a control that sends a form, posts back or follows a link does more than that,
    // and the page decides what (checker's panelOk / dialogSendYes: an OK and a Yes that were
    // each a form's submit button, four filing POSTs per replay). Only SUBMITTERS count: a
    // type=button inside ASP.NET's one whole-page <form method=post> is not one, or every close
    // icon on Accela would be refused — what its script does is the network backstop's question.
    const moves = submitsOrNavigatesInPage(el);
    if (moves) return `${shown} ${moves} — a dismisser never submits or navigates`;
    // (i) CLOSE-ONLY IS DECIDED BY WHAT A PERSON READS ON THE CONTROL — its visible label or
    // aria-label (X, Close, Dismiss, No thanks, Cancel, an icon) — NEVER by its class. An
    // ANSWER-shaped label is never close-only whatever its id or class says: Materialize's own
    // documented modal gives the ANSWER "Agree" class modal-close, and the dismisser answered
    // "Submit your application to the city?" through the class token (close2-safety checker:
    // matForm / matFetch / matDelayed / matDelayedXhr). An id/class close token (PowerClerk's
    // #cpr-banner-dimiss-btn, .btn-close, ExtJS x-tool-close) counts ONLY for a control with no
    // label of its own — an icon.
    const cls = String(el.getAttribute("class") || "");
    const idAttr = String(el.getAttribute("id") || "");
    const aria = clean(el.getAttribute("aria-label"));
    const visibleText = clean(h.innerText || h.textContent || "");
    const ANSWER = /^(ok|okay|yes|accept|accept all|accept all cookies|allow|allow all|allow cookies|agree|i agree|confirm|continue|proceed|i understand|understood|submit)\b[.!]?$/i;
    const answer = ANSWER.test(label) || ANSWER.test(visibleText);
    const CLOSE_WORDS = /^(got it|dismiss|close|cancel|no thanks|no,? thanks|not now|skip|maybe later|later|×|x|✕|✖)$/i;
    const iconOnly = !label && !visibleText;
    const closeOnly = !answer && (
      CLOSE_WORDS.test(label)
      || (/^(close|dismiss)\b/i.test(aria) && (!visibleText || CLOSE_WORDS.test(visibleText)))
      || (iconOnly && (/\b(btn-close|x-tool-close)\b/.test(cls) || /(^|[\s_-])(dismiss|dimiss|close)([\s_-]|$)/i.test(`${idAttr} ${cls}`))));
    if (closeOnly) return "";
    // (ii) AN ANSWER (OK / Yes / Accept / Confirm / Continue / Proceed / I agree) is allowed ONLY
    // inside a container POSITIVELY identified as a cookie / consent / announcement banner — by
    // its own attributes (id, class, aria-label: a consent framework's names), or by its text
    // saying cookies / consent / what's new. Every other container is UNKNOWN, and an unknown
    // question is refused: "Are you ready to send your application to the city?" and "Your card
    // will be charged $450.00" both passed a word list that did not know those words.
    if (!answer) return `${shown} is neither a close control (by its label) nor an answer to a known banner — the dismisser does not click what it cannot identify`;
    const CONSENT_ATTR = /cookie|consent|gdpr|ccpa|onetrust|cookiebot|cybot|truste|osano|usercentrics|didomi|qc-cmp|cmp-?banner|cc-(window|banner)|privacy-?banner|announcement|whats-?new|what-?s-?new|new-?feature|release-?notes/i;
    let container: Element | null = null;
    let byAttr = false;
    for (let p: Element | null = el.parentElement, depth = 0; p && depth < 10; p = p.parentElement, depth++) {
      if (/^(BODY|HTML|FORM|MAIN)$/.test(p.tagName)) break;
      const attrs = `${p.getAttribute("id") || ""} ${p.getAttribute("class") || ""} ${p.getAttribute("aria-label") || ""}`;
      if (CONSENT_ATTR.test(attrs)) { container = p; byAttr = true; break; }
    }
    if (!container) {
      const DIALOGISH = "[role=dialog], [role=alertdialog], dialog, .modal, [class*=modal], .popover, [class*=x-window], [class*=banner], [class*=notice], [class*=panel], [class*=confirm]";
      container = el.closest ? el.closest(DIALOGISH) : null;
      // THE WHOLE DIALOG, NOT ITS FOOTER. "[class*=modal]" also matches Materialize/Bootstrap's
      // .modal-footer / .modal-content: the nearest match held only the button, so the dialog's
      // question ("Submit your application to the city?") was never read. Climb to the OUTERMOST
      // DIALOG ancestor (a few levels, never past body/form/main; a layout "panel" or "banner"
      // wrapping the whole page is not climbed into).
      const MODALISH = "[role=dialog], [role=alertdialog], dialog, .modal, [class*=modal], [class*=x-window], .popover";
      for (let p: Element | null = container ? container.parentElement : null, depth = 0; p && depth < 6; p = p.parentElement, depth++) {
        if (/^(BODY|HTML|FORM|MAIN)$/.test(p.tagName)) break;
        if (p.matches(MODALISH)) container = p;
      }
      if (!container) {
        // The nearest fixed/sticky box the control sits in (a floating banner has no class name).
        for (let p: Element | null = el.parentElement; p && !/^(BODY|HTML)$/.test(p.tagName); p = p.parentElement) {
          const pos = getComputedStyle(p).position;
          if (pos === "fixed" || pos === "sticky") { container = p; break; }
        }
      }
    }
    if (!container) return `${shown} answers a question outside any container this code can identify — refused`;
    let text = clean((container as HTMLElement).innerText || container.textContent || "");
    const own = clean(h.innerText || h.textContent || "");
    if (own) text = text.split(own).join(" ");
    // ANY FILING OR PAYING WORD VETOES THE BANNER, however it was identified.
    if (isPayFee(text) || /\$\s*\d|\b(charged?|charges|debit(ed)?|fees?)\b/i.test(text)) return `${shown} answers a question about paying: "${text.slice(0, 80)}"`;
    // ("Cookies are small text FILES" is every consent banner, so bare "file" is not a veto.)
    if (isSubmitIntent(text, null) || /\b(submi(t|ts|tted|tting|ssion)|fil(e|ing)\s+(this|the|your|my|an?)\b|filed\b|(send|sent)\b[^.]{0,40}\b(city|county|agency|department|division|utility|application|permit|request)|certif|attest|under\s+penalt|cannot\s+be\s+undone|application)/i.test(text)) {
      return `${shown} answers a question about filing: "${text.slice(0, 80)}"`;
    }
    const byText = /\bcookies?\b|\bconsent\b|what'?s\s+new|\bnew\s+feature/i.test(text) && text.length <= 600;
    if (byAttr || byText) return "";
    return `${shown} answers a question that is not a known cookie / consent / announcement banner: "${text.slice(0, 80)}"`;
  };

  /** Runs IN THE PAGE: would activating this control submit a form, post back or navigate? The
   *  reason, or "". SUBMITTERS only: a <button> whose type is submit (or missing — the default)
   *  inside a form, an input type=submit|image inside a form, a link with a real href, or any
   *  href/onclick that calls __doPostBack / WebForm_DoPostBackWithOptions / requestSubmit /
   *  .submit(). A type=button, a bare href="#" and javascript:void(0) are not. */
  const submitsOrNavigatesInPage = (el: Element): string => {
    const tag = el.tagName;
    const type = String(el.getAttribute("type") || "").toLowerCase();
    const link = el.closest ? el.closest("a[href]") : null;
    const code = `${el.getAttribute("onclick") || ""} ${el.getAttribute("href") || ""} ${link ? `${link.getAttribute("onclick") || ""} ${link.getAttribute("href") || ""}` : ""}`;
    if (/__doPostBack|WebForm_DoPostBack|requestSubmit|\.submit\s*\(/i.test(code)) return "posts the page back";
    const form = (el as HTMLButtonElement).form || null;
    if (tag === "BUTTON" && (type === "" || type === "submit") && form) return "is a submit button in a form";
    if (tag === "INPUT" && (type === "submit" || type === "image") && form) return "is a submit button in a form";
    if (link) {
      const href = String(link.getAttribute("href") || "").trim();
      if (href && !/^#/.test(href) && !/^javascript:\s*(void\s*\(\s*0\s*\)|;|false|undefined)?\s*;?\s*$/i.test(href)) return "is a link that navigates";
    }
    return "";
  };

  // Request-URL predicates (network recorder, implicit submission). Portal endpoints concatenate
  // words ("SubmitApplication", "CompleteApplication"), so these have no trailing word boundary.
  const FINAL_SUBMIT_URL = /(submit|finali[sz]e|completeapplication|fileapplication|continueapplication)/i;
  const PAY_FEE_URL = /(payment|checkout|invoice|paymentus|payfee|placeorder)/i;
  const isSubmitOrPayRequestUrl = (url: string | null | undefined): boolean => {
    const u = String(url ?? "");
    return !!u && (FINAL_SUBMIT_URL.test(u) || PAY_FEE_URL.test(u));
  };
  const isPayRequestUrl = (url: string | null | undefined): boolean => {
    const u = String(url ?? "");
    return !!u && PAY_FEE_URL.test(u);
  };

  /**
   * Runs IN THE PAGE: what an Enter key in this element would ACTIVATE by the form's implicit
   * submission — the form's default button (the first submit button in tree order, which is what
   * form.requestSubmit() and Enter use), or, with no button, the form's own action. null when Enter
   * here submits nothing: not in a form, a textarea (newline), or a button (Enter activates the
   * button itself, which the caller already judged).
   *
   * A recipe "press Enter" in a Parcel Number box whose form's only button is "Submit
   * Application" FILES — the gate that read the focused box's label saw "Parcel Number" (replay
   * skeptic, enter-probe.log). The default button is tagged data-al-default-submit="1" so the
   * caller can judge it with its full click gate.
   */
  const implicitSubmitInPage = (el: Element | null | undefined): { label: string; action: string; tagged: boolean; missingDefault?: string } | null => {
    if (!el) return null;
    const tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "BUTTON" || tag === "A" || tag === "SELECT") return null;
    if (tag === "INPUT" && /^(submit|image|button|reset|checkbox|radio|file)$/i.test(String((el as HTMLInputElement).type || ""))) return null;
    const form = (el as HTMLInputElement).form || (el.closest ? el.closest("form") : null);
    for (const old of Array.from(document.querySelectorAll("[data-al-default-submit]"))) old.removeAttribute("data-al-default-submit");
    // A DECLARED DEFAULT BUTTON OUTRANKS TREE ORDER. ASP.NET's Panel DefaultButton renders
    // onkeypress="return WebForm_FireDefaultButton(event, '<id>')" on an ancestor: Enter clicks
    // THAT button and cancels the browser's own implicit submission. The first submit was
    // "Search" and the declared default "Submit Application" on the checker's aspnetDefault
    // fixture — the exact markup WebForms emits, and Accela is WebForms.
    //
    // READ AS THE BROWSER RUNS IT: the handler PROPERTY (String(p.onkeypress)) as well as the
    // attribute, with any argument name, up through the document and the window. WebForms and
    // page scripts set it after load — `pnl.onkeypress = function(e){ return
    // WebForm_FireDefaultButton(e, 'btnFile') }` pointed Enter at a hidden "Submit Application"
    // that an attribute-only read never saw (close2-safety checker, scriptDefaultHidden).
    const handlerSource = (n: unknown): string => {
      const o = n as { onkeypress?: unknown; onkeydown?: unknown; getAttribute?: (a: string) => string | null };
      let s = "";
      try { if (typeof o.getAttribute === "function") s += ` ${o.getAttribute("onkeypress") || ""} ${o.getAttribute("onkeydown") || ""}`; } catch { /* unreadable attribute */ }
      try { if (o.onkeypress) s += ` ${String(o.onkeypress)}`; if (o.onkeydown) s += ` ${String(o.onkeydown)}`; } catch { /* unreadable property */ }
      return s;
    };
    const chain: unknown[] = [];
    for (let p: Node | null = el; p; p = p.parentNode) chain.push(p);
    chain.push(globalThis);
    for (const node of chain) {
      const p = node as Element;
      const m = /WebForm_FireDefaultButton\s*\(\s*[\w$.]+\s*,\s*['"]([^'"]+)['"]/.exec(handlerSource(node));
      const id = m ? m[1] : (typeof p.getAttribute === "function" ? (p.getAttribute("data-default-button") || p.getAttribute("data-defaultbutton") || "") : "");
      if (!id) continue;
      const declared = document.getElementById(id);
      if (!declared) return { label: "", action: "", tagged: false, missingDefault: id.slice(0, 60) };
      declared.setAttribute("data-al-default-submit", "1");
      const label = String(controlLabelInPage(declared) || (declared as HTMLElement).innerText || (declared as HTMLInputElement).value || "").replace(/\s+/g, " ").trim();
      return { label, action: String((declared as HTMLButtonElement).formAction || (form ? form.action : "") || ""), tagged: true };
    }
    if (!form) return null;
    const btn = Array.from(form.elements).find((c) => (c.tagName === "BUTTON" && String((c as HTMLButtonElement).type || "submit").toLowerCase() === "submit")
      || (c.tagName === "INPUT" && /^(submit|image)$/i.test(String((c as HTMLInputElement).type || "")))) as HTMLButtonElement | HTMLInputElement | undefined;
    if (btn) {
      btn.setAttribute("data-al-default-submit", "1");
      const label = String(controlLabelInPage(btn) || (btn as HTMLElement).innerText || (btn as HTMLInputElement).value || "").replace(/\s+/g, " ").trim();
      return { label, action: String(btn.formAction || form.action || ""), tagged: true };
    }
    return { label: "", action: String(form.action || ""), tagged: false };
  };

  /** Runs IN THE PAGE: would Enter in this element file or pay by implicit submission? The
   *  reason, or "". For a widget that presses Enter with no chokepoint of its own (comboboxFill). */
  const implicitSubmitRefusalInPage = (el: Element | null | undefined): string => {
    const imp = implicitSubmitInPage(el);
    if (!imp) return "";
    if (imp.missingDefault) return `Enter here activates the declared default button #${imp.missingDefault}, which is not on the page — unknown`;
    if (isPayFee(imp.label)) return `Enter here activates "${imp.label.slice(0, 60)}", which pays a fee`;
    if (isSubmitIntent(imp.label, null) || isFinalSubmitControl(imp.label, { reviewPage: true })) return `Enter here activates "${imp.label.slice(0, 60)}", which is submit-worded`;
    if (isSubmitOrPayRequestUrl(imp.action)) return `Enter here submits the form to ${imp.action.slice(0, 80)}, a filing/payment endpoint`;
    return "";
  };

  /**
   * Runs IN THE PAGE: may the BOT press Enter in this element? The reason, or "". An Enter is
   * judged against EVERY control it can activate, not only the one implicit submission picks:
   *   1. the control implicit submission / a declared ASP.NET default button activates
   *      (implicitSubmitRefusalInPage — the caller also runs its full click gate on it);
   *   2. CONSERVATIVE: a page script can map Enter to ANY control of the form (a keydown that
   *      calls requestSubmit(fileBtn) — checker's jsKeydown), so Enter is refused in a form that
   *      holds any visible submit- or pay-worded control: buttons, submit/image inputs, and
   *      __doPostBack links. Judged with isSubmitIntent IN THIS PAGE'S CONTEXT, so Accela's
   *      mid-flow "Continue Application" on a fillable, non-review page stays excused;
   *   3. TERMINAL PAGE: on a page that names itself the review step, Enter in any form submits
   *      that form whatever its action says (checker's reviewNoButton: action /apply/42).
   *
   * CLOSE3 — ENTER IS AN ALLOWLIST, and the scope is everything Enter can reach (two skeptic
   * passes each found three new shapes a deny rule did not know):
   *   0. The box must be POSITIVELY identified as a search / autocomplete / login control
   *      (enterIdentityInPage: role searchbox/combobox, type=search, aria-autocomplete,
   *      enterkeyhint/inputmode=search, a search landmark, a password form). Anything else —
   *      "Parcel Number", an unnamed text box — is refused by name.
   *   2'. The scope is THE PAGE, whether or not the box sits in a form (a document keydown can
   *      map Enter to any control: checker's enterNoForm, and enterFormScope — a search box in
   *      its own little form), minus the page's step navigator.
   *      SUBMITTERS count even when hidden (a display:none "Submit Application" is still what a
   *      script-set default clicks: scriptDefaultHidden); custom-element buttons (a tag with "-"
   *      and type=submit or role=button, read by their light-DOM text: shadowSubmit) and the
   *      buttons inside open shadow roots count too.
   */
  const enterIdentityInPage = (el: Element): string => {
    const attr = (a: string): string => String(el.getAttribute(a) || "").trim().toLowerCase();
    const role = attr("role");
    if (role === "searchbox" || role === "combobox") return `role=${role}`;
    const type = String((el as HTMLInputElement).type || "").toLowerCase();
    if (el.tagName === "INPUT" && type === "search") return "type=search";
    const ac = attr("aria-autocomplete");
    if (ac && ac !== "none") return "aria-autocomplete";
    if (attr("enterkeyhint") === "search" || attr("inputmode") === "search") return "a search keyboard hint";
    if (el.closest && el.closest("[role=search], search")) return "a search landmark";
    const form = ((el as HTMLInputElement).form || (el.closest ? el.closest("form") : null)) as HTMLFormElement | null;
    if (form && el.tagName === "INPUT" && /^(text|email|password|tel)$/.test(type || "text") && form.querySelector("input[type=password]")) return "a login form";
    return "";
  };

  const enterRefusalInPage = (el: Element | null | undefined): string => {
    if (!el) return "the box could not be read";
    const clean = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();
    const own = implicitSubmitRefusalInPage(el);
    if (own) return own;
    if (!enterIdentityInPage(el)) {
      const name = clean(controlLabelInPage(el)).slice(0, 40) || "(unlabelled box)";
      return `Enter is pressed only in a positively identified search, autocomplete or login box (role searchbox/combobox, type=search, aria-autocomplete, a search landmark, a password form) — "${name}" is none of these`;
    }
    const form = ((el as HTMLInputElement).form || (el.closest ? el.closest("form") : null)) as HTMLFormElement | null;
    const reviewPage = reviewPageInPage();
    if (form && reviewPage === true) return "this page names itself the review step — Enter in its form would submit it";
    const readOnlyPage = readOnlyPageInPage();
    const ctx: ControlContext = { reviewPage: reviewPage === false ? false : undefined, readOnlyPage };
    // THE SCOPE IS ALWAYS THE PAGE (close3 skeptic MF1, enterFormScope). A document keydown maps
    // Enter to ANY control whatever form the box sits in: a type=search header box inside its
    // OWN <form role=search onsubmit="return false"> pressed "Submit Application" outside that
    // form (1 filing POST, ok=true). The form is a subset of the page, so the page is judged
    // every time; the reason still names the form when the control is inside it.
    const scope: ParentNode = document;
    const whereOf = (c: Element): string => (form && (c === form || form.contains(c) || (c as HTMLInputElement).form === form) ? "form" : "page");
    const visible = (c: Element): boolean => {
      const r = c.getBoundingClientRect();
      const cs = getComputedStyle(c);
      return r.width > 1 && r.height > 1 && cs.display !== "none" && cs.visibility !== "hidden";
    };
    // The page's step navigator is not something Enter reaches ("Review & Submit" in a step bar)
    // — with or without a form around the box.
    const inNavigator = (c: Element): boolean => !!c.closest && !!c.closest("nav, [role=navigation], [role=tablist]");
    const labelOf = (c: Element): string => clean(controlLabelInPage(c) || (c as HTMLElement).innerText || (c as HTMLInputElement).value || c.textContent || "");
    const judge = (label: string, what: string, c: Element): string => {
      if (!label) return "";
      const where = whereOf(c);
      if (isPayFee(label)) return `the ${where} also holds${what} "${label.slice(0, 50)}", which pays a fee — a page script can map Enter to it`;
      if (isSubmitIntent(label, ctx)) return `the ${where} also holds${what} "${label.slice(0, 50)}", which is submit-worded — a page script can map Enter to it`;
      return "";
    };
    // Native and role controls. A SUBMITTER counts hidden; any other control counts when visible.
    const candidates = new Set<Element>();
    if (form) for (const c of Array.from(form.elements)) candidates.add(c);
    for (const c of Array.from(scope.querySelectorAll("button, input[type=submit], input[type=image], input[type=button], [role=button], a[href*='doPostBack' i], a[onclick*='doPostBack' i], a[href*='DoPostBack']"))) candidates.add(c);
    for (const c of Array.from(candidates)) {
      if (c === el) continue;
      const tag = c.tagName;
      const type = String(c.getAttribute("type") || "").toLowerCase();
      const submitter = (tag === "BUTTON" && (type === "" || type === "submit")) || (tag === "INPUT" && /^(submit|image)$/.test(type));
      const isControl = submitter || tag === "BUTTON" || (tag === "INPUT" && type === "button") || c.getAttribute("role") === "button" || tag === "A";
      if (!isControl || (!submitter && !visible(c)) || inNavigator(c)) continue;
      const why = judge(labelOf(c), submitter && !visible(c) ? " the hidden submitter" : "", c);
      if (why) return why;
    }
    // Custom-element buttons and open shadow roots.
    const all = Array.from(scope.querySelectorAll("*"));
    for (const c of all) {
      if (!c.tagName.includes("-") || inNavigator(c)) continue;
      const type = String(c.getAttribute("type") || "").toLowerCase();
      const role = String(c.getAttribute("role") || "").toLowerCase();
      if (type !== "submit" && role !== "button") continue;
      const why = judge(labelOf(c), " the custom-element button", c);
      if (why) return why;
    }
    const walkShadow = (root: ShadowRoot, host: Element, depth: number): string => {
      for (const s of Array.from(root.querySelectorAll("button, input[type=submit], input[type=image], input[type=button], [role=button]"))) {
        const why = judge(labelOf(s) || clean(host.textContent), ", inside a shadow root,", host);
        if (why) return why;
      }
      if (depth < 4) {
        for (const e of Array.from(root.querySelectorAll("*"))) {
          const sr = (e as Element).shadowRoot;
          if (sr) { const why = walkShadow(sr, e, depth + 1); if (why) return why; }
        }
      }
      return "";
    };
    for (const h of all) {
      const sr = h.shadowRoot;
      if (!sr || inNavigator(h)) continue;
      const why = walkShadow(sr, h, 0);
      if (why) return why;
    }
    return "";
  };

  return {
    dismissalRefusalInPage,
    implicitSubmitInPage,
    implicitSubmitRefusalInPage,
    enterIdentityInPage,
    enterRefusalInPage,
    submitsOrNavigatesInPage,
    isSubmitOrPayRequestUrl,
    isPayRequestUrl,
    isSubmitIntent,
    isPayFee,
    isPaymentWordedText,
    paymentDialogVerdict,
    isPayNowDialogText,
    isFinalSubmitControl,
    classifyRecordedClick,
    isSecretField,
    isPaymentField,
    isAcceptTermsLabel,
    readOnlyPageInPage,
    isReviewPageText,
    looksLikeReviewUrl,
    reviewSignals,
    reviewPageInPage,
    reviewTextInPage,
    navigatorOnlyControlLabelsInPage,
    isSignatureNameLabel,
    isSignatureNameBox,
    signatureNamePartOf,
    splitSignerName,
    isTypeSignatureToggleLabel,
    signatureStepInPage,
    textAroundInPage,
    terminalPageInPage,
    fieldIdentityInPage,
    isPaymentElementInPage,
    controlRoleInPage,
    controlLabelInPage,
  };
}

export type PortalSafety = ReturnType<typeof portalSafetyFactory>;

const impl: PortalSafety = portalSafetyFactory();

export const isSubmitIntent = impl.isSubmitIntent;
export const isPayFee = impl.isPayFee;
export const isPaymentWordedText = impl.isPaymentWordedText;
export const paymentDialogVerdict = impl.paymentDialogVerdict;
export const isPayNowDialogText = impl.isPayNowDialogText;
export const isFinalSubmitControl = impl.isFinalSubmitControl;
export const classifyRecordedClick = impl.classifyRecordedClick;
export const isSecretField = impl.isSecretField;
export const isPaymentField = impl.isPaymentField;
export const isAcceptTermsLabel = impl.isAcceptTermsLabel;
export const isReviewPageText = impl.isReviewPageText;
export const looksLikeReviewUrl = impl.looksLikeReviewUrl;
export const reviewSignals = impl.reviewSignals;
export const isSignatureNameLabel = impl.isSignatureNameLabel;
export const isSignatureNameBox = impl.isSignatureNameBox;
export const signatureNamePartOf = impl.signatureNamePartOf;
export const splitSignerName = impl.splitSignerName;
export const isTypeSignatureToggleLabel = impl.isTypeSignatureToggleLabel;

/** The minimum of a recorded step the form-data question needs. */
export interface FormDataStep {
  action: string;
  note?: string;
  selector?: { name?: string; label?: string } | Record<string, unknown> | null;
}

/**
 * Has a recording entered real form data yet? A fill or a select does; a check/uncheck does
 * unless it is a terms/certification acknowledgment (the agree box on an entry disclaimer is not
 * form data). The ONE predicate both capture sinks use for ControlContext.formDataEntered — the
 * recorder over its whole recording, humanCapture over the steps it has emitted.
 */
export function recordingHasFormData(steps: ReadonlyArray<FormDataStep>): boolean {
  return steps.some((s) => {
    if (s.action === "fill" || s.action === "select") return true;
    if (s.action !== "check" && s.action !== "uncheck") return false;
    const sel = (s.selector ?? {}) as { name?: unknown; label?: unknown };
    return !isAcceptTermsLabel(`${s.note ?? ""} ${String(sel.name ?? "")} ${String(sel.label ?? "")}`);
  });
}

/**
 * The capture sinks' one secret question, for a fill AND a select: the page flagged it, or its
 * attribute/label identity is secret, or the label a person reads on it is. A <select name=
 * "meterNumber"> is as secret as the <input> beside it — the select branch once skipped this and
 * kept the meter number as the step's literal.
 */
export function capturedFieldIsSecret(p: { sensitive?: boolean; identity?: FieldIdentity | null; label?: string | null } | null | undefined): boolean {
  if (!p) return false;
  return !!p.sensitive || isSecretField(p.identity) || isSecretField({ label: p.label ?? "" });
}

/** The name every in-page consumer reads the predicates from. */
export const PORTAL_SAFETY_GLOBAL = "__portalSafety";

/**
 * Script text that installs the SAME predicates in a page as window.__portalSafety. Includes the
 * __name shim (tsx/esbuild wraps inner functions in __name calls). Idempotent, and the global is
 * non-writable so a page script cannot swap in a permissive copy.
 */
export const PORTAL_SAFETY_IN_PAGE_SOURCE =
  "globalThis.__name = globalThis.__name || function (fn) { return fn; };\n" +
  `if (!globalThis.${PORTAL_SAFETY_GLOBAL}) { try { Object.defineProperty(globalThis, ${JSON.stringify(PORTAL_SAFETY_GLOBAL)}, ` +
  `{ value: Object.freeze((${portalSafetyFactory.toString()})()), writable: false, configurable: false }); } catch (e) {} }`;

// ---------------------------------------------------------------------------------------------
// Request-URL predicates (network recorder). Portal endpoints concatenate words
// ("SubmitApplication", "CompleteApplication"), so these have no trailing word boundary.
// ---------------------------------------------------------------------------------------------

/** A request whose URL looks like a filing or a fee payment — flagged, never auto-fired. (Built
 *  in the factory so the in-page implicit-submission question uses the same regexes.) */
export function isSubmitOrPayRequestUrl(url: string | null | undefined): boolean {
  return impl.isSubmitOrPayRequestUrl(url);
}

/** A fee-payment endpoint only (never allowed, not even inside an approved final submit). */
export function isPayRequestUrl(url: string | null | undefined): boolean {
  return impl.isPayRequestUrl(url);
}

/**
 * THE ONE "IS THIS REQUEST A FILING OR A PAYMENT?" QUESTION for request-level aborts: a method
 * that can change server state (anything but GET / HEAD / OPTIONS) to a URL that reads as a
 * filing or a fee payment. For a form POST the request URL IS the form action. The demo
 * recorder's abort (scripts/demo-record-portal.ts) asks exactly this; the run backstop
 * (portal-bot/src/filingBackstop.ts) asks it of every main-frame navigation.
 */
export function isFilingOrPaymentRequest(method: string | null | undefined, url: string | null | undefined): boolean {
  const m = String(method ?? "").trim().toUpperCase();
  if (!m || m === "GET" || m === "HEAD" || m === "OPTIONS") return false;
  return isSubmitOrPayRequestUrl(url);
}

// ---------------------------------------------------------------------------------------------
// Submission outcome — positive evidence only
// ---------------------------------------------------------------------------------------------

const ACCEPTED_EVIDENCE: RegExp[] = [
  /\b(application|request|submission|submittal|permit|project|form|interconnection|filing)\s+(has\s+been|was|is)\s+(successfully\s+)?(submitted|received|filed|accepted)\b/i,
  /\bsuccessfully\s+(submitted|filed|received)\b/i,
  /\bthank\s+you\s+for\s+(your\s+)?(submission|submitting|applying|your\s+application)\b/i,
  /\bsubmission\s+(complete|successful|received|confirmed)\b/i,
];

// RECORD-NUMBER EVIDENCE is weaker than a sentence that says "submitted": a draft page, a form
// header and a help text all carry a "Project ID:" or "Confirmation number" LABEL. So the token
// after the label must look like an issued number — upper-case/digits/hyphens, at least four
// characters, AT LEAST ONE DIGIT, matched case-sensitively (under /i any four-letter word such as
// "Type" or "will" counted) — and it must not be followed by "will", "pending", "TBD" or
// "(to) be assigned". And a page that still ASKS for the submit ("review your application
// before submitting", "Click Submit to file", a "Draft") cancels record-number-only evidence:
// PowerClerk shows the project id on the draft's own header.
const RECORD_LABEL = /\b(confirmation|record|application|reference|tracking|permit|case|project)\s*(number|no\.?|#|id)(?![A-Za-z])\s*[:#]?\s*/gi;
const RECORD_TOKEN = /^[A-Z0-9][A-Z0-9-]{3,}$/;
const RECORD_NOT_YET = /^[\s:()\-–—]*(will\b|pending\b|tbd\b|(to\s+)?be\s+(assigned|issued|generated|emailed|provided)\b)/i;
const STILL_ASKS_FOR_SUBMIT =
  /\bbefore\s+(you\s+)?(submit|submitting|filing)\b|\b(click|press|select|tap|use)\s+(the\s+)?["“']?(submit|file|finish)\b|\bsubmit\b[^.]{0,30}\bto\s+(file|complete|finish|send)\b|\breview\s+(all\s+)?(your|the)\s+(application|information|submission|details|entries)\b|\bdraft\b|\bnot\s+(yet\s+)?(been\s+)?submitted\b/i;

function recordNumberEvidence(text: string): string | null {
  RECORD_LABEL.lastIndex = 0;
  for (let m = RECORD_LABEL.exec(text); m; m = RECORD_LABEL.exec(text)) {
    const rest = text.slice(m.index + m[0].length);
    const token = (/^[A-Za-z0-9][A-Za-z0-9-]*/.exec(rest) || [""])[0].replace(/-+$/, "");
    if (!token || !RECORD_TOKEN.test(token) || !/\d/.test(token)) continue;
    if (RECORD_NOT_YET.test(rest.slice(token.length))) continue;
    return `${m[0]}${token}`.trim();
  }
  return null;
}

const REJECTED_EVIDENCE: RegExp[] = [
  /\bplease\s+correct\s+the\s+following\b/i,
  /\b(could|can)\s*not\s+be\s+submitted\b/i,
  /\bsubmission\s+(failed|was\s+unsuccessful|error)\b/i,
  /\b(an?\s+)?errors?\s+(has|have)?\s*occurred\b/i,
  /\bthere\s+(was|were|is|are)\s+(an?\s+)?(problem|error|issue)s?\b/i,
  /\b[A-Za-z][A-Za-z /]{1,40}\s+is\s+(required|invalid)\b/i,
  /\b(required|invalid)\s+field/i,
  /\bunable\s+to\s+(submit|process)\b/i,
];

/**
 * What the page said after a submit click. "accepted" needs POSITIVE evidence (a confirmation or
 * record number, "has been submitted"); "rejected" needs a validation/error phrase; a quiet
 * page, a challenge, or both kinds at once are "unknown". A quiet page is NOT acceptance — that
 * reading once counted a non-PowerClerk filing as accepted with nothing on screen to say so.
 */
export function classifySubmissionText(body: string | null | undefined): SubmissionOutcome {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { verdict: "unknown", evidence: null };
  const phrase = ACCEPTED_EVIDENCE.map((re) => text.match(re)?.[0]).find(Boolean) ?? null;
  // A record number counts only when no sentence on the page still asks for the submit.
  const acc = phrase ?? (STILL_ASKS_FOR_SUBMIT.test(text) ? null : recordNumberEvidence(text));
  const rej = REJECTED_EVIDENCE.map((re) => text.match(re)?.[0]).find(Boolean) ?? null;
  if (acc && rej) return { verdict: "unknown", evidence: `conflicting: "${acc}" / "${rej}"` };
  if (acc) return { verdict: "accepted", evidence: acc };
  if (rej) return { verdict: "rejected", evidence: rej };
  return { verdict: "unknown", evidence: null };
}

// ---------------------------------------------------------------------------------------------
// Recipe shape
// ---------------------------------------------------------------------------------------------

/**
 * The only recipe shape in which a final submit may exist: AT MOST ONE isFinalSubmit step, it is
 * the LAST step, it is a click, and the step immediately before it is stopForReview. Zero flagged
 * steps is valid (most recipes). Returns the problems; empty means valid.
 */
export function recipeShapeProblems(steps: ReadonlyArray<ShapeStep> | null | undefined): string[] {
  const list = Array.isArray(steps) ? steps : [];
  const flagged = list.map((s, i) => (s && s.isFinalSubmit === true ? i : -1)).filter((i) => i >= 0);
  if (flagged.length === 0) return [];
  const problems: string[] = [];
  if (flagged.length > 1) problems.push(`${flagged.length} steps are flagged isFinalSubmit (at most one is allowed): indexes ${flagged.join(", ")}`);
  const last = flagged[flagged.length - 1];
  if (last !== list.length - 1) problems.push(`the isFinalSubmit step (index ${last}) is not the last step (${list.length - 1})`);
  if (String(list[last]?.action) !== "click") problems.push(`the isFinalSubmit step is a "${String(list[last]?.action)}", not a click`);
  if (last === 0 || String(list[last - 1]?.action) !== "stopForReview") {
    problems.push("the isFinalSubmit step does not immediately follow a stopForReview marker");
  }
  return problems;
}

/** Boolean form of recipeShapeProblems. */
export function isRecipeShapeValid(steps: ReadonlyArray<ShapeStep> | null | undefined): boolean {
  return recipeShapeProblems(steps).length === 0;
}

/** Object form, for callers that report: { valid, problems }. Never use it as a condition. */
export function validateRecipeShape(steps: ReadonlyArray<ShapeStep> | null | undefined): { valid: boolean; problems: string[] } {
  const problems = recipeShapeProblems(steps);
  return { valid: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------------------------
// May automation click final submit? (hard rule 1, as amended by the operator decision)
// ---------------------------------------------------------------------------------------------

/** The process switch, read by the CALLER and passed in. Exactly "1" — not "true", not "yes". */
export function finalSubmitEnvAllows(env: Record<string, string | undefined> = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}): boolean {
  return String(env.PORTAL_ALLOW_FINAL_SUBMIT ?? "").trim() === "1";
}

/** Every reason the click is refused. Empty only when ALL conditions hold. */
export function finalSubmitRefusals(ctx: FinalSubmitContext | null | undefined): string[] {
  if (!ctx) return ["no context"];
  const out: string[] = [];
  if (ctx.envAllows !== true) out.push("PORTAL_ALLOW_FINAL_SUBMIT is not 1 on this process");
  const a = ctx.runApproval;
  const approver = a && typeof a.approver === "string" ? a.approver.trim() : "";
  const approvedRun = a && typeof a.runId === "string" ? a.runId.trim() : "";
  const runId = typeof ctx.runId === "string" ? ctx.runId.trim() : "";
  if (!a) out.push("no named person approved this run");
  else {
    if (!approver) out.push("the approval names no approver");
    if (!approvedRun || !runId || approvedRun !== runId) out.push("the approval is for a different run");
  }
  if (ctx.stepIsTerminalFlagged !== true) out.push("the step is not the recipe's single terminal isFinalSubmit step");
  if (ctx.recipeShapeValid !== true) out.push("the recipe shape is invalid");
  return out;
}

/**
 * THE final-submit gate. True only when the environment switch is on, a named person approved
 * exactly this run, the step is the single terminal flagged step, and the recipe shape is valid.
 * No standing per-recipe arm exists. Until a caller passes a real approval, this is always false.
 */
export function mayClickFinalSubmit(ctx: FinalSubmitContext | null | undefined): boolean {
  return finalSubmitRefusals(ctx).length === 0;
}
