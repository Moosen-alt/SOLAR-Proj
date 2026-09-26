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
  /** true = the page NAMES itself the review step ("Step 3: Review", "Review and Submit",
   *  "(read-only)" — reviewPageInPage). Independent of readOnlyPage: a review page with a
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

  // THE PAGE NAMES ITSELF THE REVIEW STEP. Deliberately narrower than "mentions review":
  // "Please review the terms and conditions" is an entry disclaimer, "Plan Review Fee" a fee line.
  const REVIEW_PAGE =
    /\bstep\s*\d+\s*[:.\-–—]?\s*review\b|\breview\s+(and|&)\s+submit\b|\(read[\s-]*only\)|\breview\s+(all\s+)?(of\s+)?(your|the)\s+(application|information|details|entries|submission)\b|\bwill\s+not\s+be\s+submitted\s+until\b/i;
  const isReviewPageText = (text: string | null | undefined): boolean => REVIEW_PAGE.test(String(text ?? ""));

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
    return isReviewPageText(d.body.innerText || d.body.textContent || "");
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
    const labelledBy = clean(String(el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map((id) => labelTextOf(byId(id), el)).join(" "));
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
    // (i) CLOSE-ONLY: the control's label, aria-label or own id/class says it only closes
    // (X, Close, Dismiss, No thanks; PowerClerk's #cpr-banner-dimiss-btn).
    const cls = String(el.getAttribute("class") || "");
    const idAttr = String(el.getAttribute("id") || "");
    const aria = clean(el.getAttribute("aria-label"));
    const closeOnly = /^(got it|dismiss|close|cancel|no thanks|no,? thanks|not now|skip|maybe later|later|×|x|✕|✖)$/i.test(label)
      || /^(close|dismiss)\b/i.test(aria) || /\b(btn-close|x-tool-close)\b/.test(cls)
      || /(^|[\s_-])(dismiss|dimiss|close)([\s_-]|$)/i.test(`${idAttr} ${cls}`);
    if (closeOnly) return "";
    // (ii) AN ANSWER (OK / Yes / Accept / Confirm / Continue / Proceed / I agree) is allowed ONLY
    // inside a container POSITIVELY identified as a cookie / consent / announcement banner — by
    // its own attributes (id, class, aria-label: a consent framework's names), or by its text
    // saying cookies / consent / what's new. Every other container is UNKNOWN, and an unknown
    // question is refused: "Are you ready to send your application to the city?" and "Your card
    // will be charged $450.00" both passed a word list that did not know those words.
    const answer = /^(ok|okay|yes|accept|accept all|accept all cookies|allow|allow all|allow cookies|agree|i agree|confirm|continue|proceed|i understand|understood)\b[.!]?$/i.test(label);
    if (!answer) return `${shown} is neither a close control nor an answer to a known banner — the dismisser does not click what it cannot identify`;
    const CONSENT_ATTR = /cookie|consent|gdpr|ccpa|onetrust|cookiebot|cybot|truste|osano|usercentrics|didomi|qc-cmp|cmp-?banner|cc-(window|banner)|privacy-?banner|announcement|whats-?new|what-?s-?new|new-?feature|release-?notes/i;
    let container: Element | null = null;
    let byAttr = false;
    for (let p: Element | null = el.parentElement, depth = 0; p && depth < 10; p = p.parentElement, depth++) {
      if (/^(BODY|HTML|FORM|MAIN)$/.test(p.tagName)) break;
      const attrs = `${p.getAttribute("id") || ""} ${p.getAttribute("class") || ""} ${p.getAttribute("aria-label") || ""}`;
      if (CONSENT_ATTR.test(attrs)) { container = p; byAttr = true; break; }
    }
    if (!container) {
      container = el.closest ? el.closest("[role=dialog], [role=alertdialog], dialog, .modal, [class*=modal], .popover, [class*=x-window], [class*=banner], [class*=notice], [class*=panel], [class*=confirm]") : null;
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
    for (let p: Element | null = el; p; p = p.parentElement) {
      const code = `${p.getAttribute("onkeypress") || ""} ${p.getAttribute("onkeydown") || ""}`;
      const m = /WebForm_FireDefaultButton\s*\(\s*event\s*,\s*['"]([^'"]+)['"]/.exec(code);
      const id = m ? m[1] : (p.getAttribute("data-default-button") || p.getAttribute("data-defaultbutton") || "");
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
   * Not in a form, and no declared default: "" (a page script is the network backstop's job).
   */
  const enterRefusalInPage = (el: Element | null | undefined): string => {
    if (!el) return "the box could not be read";
    const own = implicitSubmitRefusalInPage(el);
    if (own) return own;
    const form = ((el as HTMLInputElement).form || (el.closest ? el.closest("form") : null)) as HTMLFormElement | null;
    if (!form) return "";
    const reviewPage = reviewPageInPage();
    if (reviewPage === true) return "this page names itself the review step — Enter in its form would submit it";
    const readOnlyPage = readOnlyPageInPage();
    const ctx: ControlContext = { reviewPage: reviewPage === false ? false : undefined, readOnlyPage };
    const visible = (c: Element): boolean => {
      const r = c.getBoundingClientRect();
      const cs = getComputedStyle(c);
      return r.width > 1 && r.height > 1 && cs.display !== "none" && cs.visibility !== "hidden";
    };
    const candidates = new Set<Element>();
    for (const c of Array.from(form.elements)) candidates.add(c);
    for (const c of Array.from(form.querySelectorAll("button, input[type=submit], input[type=image], input[type=button], [role=button], a[href*='doPostBack' i], a[onclick*='doPostBack' i], a[href*='DoPostBack']"))) candidates.add(c);
    for (const c of Array.from(candidates)) {
      if (c === el) continue;
      const tag = c.tagName;
      const type = String(c.getAttribute("type") || "").toLowerCase();
      const isControl = tag === "BUTTON" || (tag === "INPUT" && /^(submit|image|button)$/.test(type)) || c.getAttribute("role") === "button" || tag === "A";
      if (!isControl || !visible(c)) continue;
      const label = String(controlLabelInPage(c) || (c as HTMLElement).innerText || (c as HTMLInputElement).value || "").replace(/\s+/g, " ").trim();
      if (!label) continue;
      if (isPayFee(label)) return `the form also holds "${label.slice(0, 50)}", which pays a fee — a page script can map Enter to it`;
      if (isSubmitIntent(label, ctx)) return `the form also holds "${label.slice(0, 50)}", which is submit-worded — a page script can map Enter to it`;
    }
    return "";
  };

  return {
    dismissalRefusalInPage,
    implicitSubmitInPage,
    implicitSubmitRefusalInPage,
    enterRefusalInPage,
    submitsOrNavigatesInPage,
    isSubmitOrPayRequestUrl,
    isSubmitIntent,
    isPayFee,
    isFinalSubmitControl,
    classifyRecordedClick,
    isSecretField,
    isPaymentField,
    isAcceptTermsLabel,
    readOnlyPageInPage,
    isReviewPageText,
    reviewPageInPage,
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
export const isFinalSubmitControl = impl.isFinalSubmitControl;
export const classifyRecordedClick = impl.classifyRecordedClick;
export const isSecretField = impl.isSecretField;
export const isPaymentField = impl.isPaymentField;
export const isAcceptTermsLabel = impl.isAcceptTermsLabel;
export const isReviewPageText = impl.isReviewPageText;

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
