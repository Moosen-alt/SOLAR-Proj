import fs from "fs";
import path from "path";
import type { Page } from "playwright";
import type { ProjectRecord, RecipeSelector, RecipeStep } from "../../../shared/src/types";
import { BasePortalAdapter, HUMAN_REVIEW_MESSAGE, type PortalContext, type PortalStepResult } from "../adapter";
import { openPortal } from "../browser";
import { selectWithFallback } from "../comboboxFill";
import { detectChallengeFrame, hasNumericValidationError, readbackMatches, redactStatusText, safeAction, sleep, smartWait, toBareNumber, waitForElement, waitForInteractiveControls } from "../safeAction";
import { scrapeReviewScreen as scrapeReviewScreenShared } from "../reviewScreenScraper";
import { performLogin } from "./loginFlow";

// AutoLearnAdapter — AUTONOMOUSLY learns an unknown AHJ/utility portal form instead of
// having a human record it. Each page is scraped into a structured snapshot
// (fillable fields + candidate buttons), handed to an injected LLM "planner" callback,
// and the planner's plan (which fields to fill, which "Next" button advances to the
// next page, where the final submit is) is applied + RECORDED as a RecipeStep[] that a
// human can later review and replay.
//
// SAFETY (the whole point — non-negotiable):
//   - NEVER clicks the final submit. The final submit is RECORDED (isFinalSubmit:true)
//     but learn() never executes it. A human always submits.
//   - NEVER clicks a pay/fee/checkout control. Even if the planner returns one as the
//     "advance" button, it is skipped and the run stops.
//   - Reuses detectChallengeFrame before any page action; a CAPTCHA/MFA challenge stops
//     the run with pauseReason "mfa_captcha" (never solved/bypassed).
//   - Never logs credentials, account/meter numbers, or full PII. Body text and scraped
//     field values are redacted via redactStatusText. Sensitive-looking fields
//     (password/account/meter/ssn) are recorded with sensitive:true and no literal value.

// ---------------------------------------------------------------------------
// The contract the backend depends on (must match exactly).
// ---------------------------------------------------------------------------

export interface ExtractedField {
  /** A stable selector for this field (prefer label/role+name/name, then css #id). */
  selector: RecipeSelector;
  /** Visible label / aria-label / placeholder / name. */
  label: string;
  fieldType: "text" | "select" | "checkbox" | "radio" | "file" | "button" | "other";
  /** For <select>, the option labels. */
  options?: string[];
  /** True when the portal marks this field required (attribute or "*" in the label). */
  required?: boolean;
  /** For <a> nav links: the href, so a hidden/menu-nested link that can't be clicked can
   *  still be reached by navigating to it directly. */
  href?: string;
}

// A fill we applied on the current page, retained so we can read it back and confirm it
// actually held its value before advancing to the next page.
interface AppliedFill {
  selector: RecipeSelector;
  label: string;
  fieldType: ExtractedField["fieldType"];
  /** Value typed (empty for sensitive fields, which are only checked for non-emptiness). */
  expected: string;
  sensitive: boolean;
  required: boolean;
}

export interface LearnPlanRequest {
  url: string;
  pageTitle: string;
  /** The fillable fields + candidate buttons + navigation links on the CURRENT page. */
  fields: ExtractedField[];
  /** Short, redacted page text snippet (<= 2000 chars). */
  bodyText: string;
  /** Labels filled on prior pages (for context). */
  alreadyFilledLabels: string[];
  /** True when no fillable inputs were found — page is likely a dashboard/home screen. */
  isDashboard?: boolean;
  /** Set when the loop has detected it is stuck or cycling. Carries a directive + the recent
   *  step trace so the planner can pick a DIFFERENT, forward-progress action instead of
   *  repeating the one that looped. Empty/undefined on normal iterations. */
  recoveryHint?: string;
}

export interface LearnPlanResponse {
  /** Fills to apply; selectorIndex indexes into request.fields. */
  fills: Array<{ selectorIndex: number; value: string; field?: string }>;
  /** A "Next/Continue" button to click to reach the NEXT form page (NOT final submit). */
  advanceSelectorIndex?: number;
  /** A link/button to click when we're on a dashboard/home page — navigates to the
   *  actual application form so learning can begin. Recorded as a click "open" step. */
  navigateSelectorIndex?: number;
  /** The final submit button — RECORD it, NEVER click it. */
  finalSubmitSelectorIndex?: number;
  /** True once the review/confirm/submit screen is reached. */
  atReview: boolean;
  notes?: string;
}

export type LearnPlanner = (req: LearnPlanRequest) => Promise<LearnPlanResponse>;

export interface LearnResult {
  ok: boolean;
  portalName: string;
  /** The recorded recipe (goto + fills + selects + advance clicks), in order; the final
   *  submit step is recorded with isFinalSubmit:true but never executed. */
  steps: RecipeStep[];
  /** What to verify accuracy against. */
  reviewScreen: { fields: Array<{ label: string; value: string }>; bodyTextSnippet: string };
  finalSubmitRecorded: boolean;
  pageCount: number;
  /** "mfa_captcha" if a challenge stopped us, else null. */
  pauseReason: string | null;
  message: string;
  /** True only when the learner actually reached the portal's review/confirm screen. `ok` alone
   *  conflates this with "filled something" — callers must use reachedReview to tell a real
   *  stage-to-review from a run that got lost mid-wizard (which must NOT report a staged draft). */
  reachedReview?: boolean;
  /** True when at least one data field (fill/select/check) was entered. A reachedReview that filled
   *  nothing is a landing/disclaimer page misread as review — callers require BOTH for a clean stage. */
  filledSomething?: boolean;
  /** Base64 PNG screenshot taken when the review/confirm page is reached. */
  reviewScreenshotBase64?: string;
}

// Live progress signal emitted while learning a portal, so the UI can show a real
// progress bar instead of a static "learning…" spinner. Carries no PII — only phase,
// page counters, a coarse classification, and a short human-readable message.
export interface LearnProgress {
  phase: "login" | "page" | "review" | "verify" | "done";
  pageCount: number;
  maxPages: number;
  classification?: "form" | "dashboard" | "review" | "empty";
  fillsPlanned?: number;
  message: string;
  // Milliseconds spent on the CURRENT step (time since the last real progress event).
  // A heartbeat re-emits the last progress with a growing elapsedMs so the UI can tell a
  // slow step (number climbing) from a hung one (climbing without ever advancing).
  elapsedMs?: number;
  heartbeat?: boolean;
}

export type LearnProgressFn = (p: LearnProgress) => void;

// ---------------------------------------------------------------------------
// Safety classifiers (shared shape with recipeAdapter's gate).
// ---------------------------------------------------------------------------

// ALWAYS-blocked fee-payment controls — never recorded as advance/finalSubmit, never clicked.
const PAY_FEE = /\b(pay fee|pay now|submit & pay|submit and pay|make payment|continue to payment|pay \$|add to cart|proceed to (payment|checkout)|checkout|fee)\b/i;

// Submit-intent button labels. On a READ-ONLY review page these SUBMIT (Accela's
// "Continue Application" on Step 3: Review is the submit gate — it advances on input
// pages but submits on the review page). The structural guard below treats them as the
// final submit (recorded, never clicked) whenever the page has no fillable inputs.
const SUBMIT_INTENT = /\b(continue application|submit application|file application|submit|finish|finalize|confirm submission|place order|complete submission)\b/i;

// Markers that a page is the review/confirm step (Accela: "Step 3: Review", read-only
// summary, "click the Continue Application button below", CapConfirm URL).
const REVIEW_MARKERS = /\bstep\s*\d+\s*:?\s*review\b|review all information|continue application button below|please review (all )?information|\(read-only\)/i;
function looksLikeReviewUrl(url: string): boolean {
  return /capconfirm|confirm\.aspx|\/review/i.test(url || "");
}

// T&C / billing / disclaimer pages have no inputs but DO have a "Continue Application"
// button — the same surface as a review page. Without this guard they get misclassified
// as review screens (no inputs + no dashboard → isReviewPage). Detect by body text and
// treat as pass-through dashboards: the planner navigates by clicking the continue button.
const TERMS_MARKERS = /\b(terms\s*(and\s*)?conditions|disclaimer|billing\s*(agreement|information|policy)|you\s+(agree|must\s+agree)\s+to|i\s+agree|accept\s+the\s+terms|privacy\s+policy|legal\s+notice|refund\s+policy)\b/i;
function looksLikeTermsUrl(url: string): boolean {
  return /disclaimer|\/terms|\/billing|\/agreement|\/privacy|CapApplyDisclaimer/i.test(url || "");
}

// Sensitive field labels whose literal value must NEVER be stored in a recorded step.
const SENSITIVE_LABEL = /\b(password|passcode|account\s*(number|no|#)?|acct|meter\s*(number|no|#)?|ssn|social security|tax\s*id|ein|routing|card\s*number|cvv|security code)\b/i;

// Portal upload-field label → document type. Maps a file-input's visible label to the
// docType produced by the existing doc-splitting tools (docSplitter.ts / projectDocsByType),
// so the learner attaches the RIGHT split document to each upload control. Ordered most-
// specific first (a combined "module/inverter" label resolves to inverter_spec first).
const UPLOAD_LABEL_PATTERNS: Array<{ re: RegExp; docType: string }> = [
  { re: /one[-\s]?line|single[-\s]?line|\bsld\b|electrical\s*(diagram|schematic|one)/i, docType: "sld" },
  { re: /site\s*plan|plot\s*plan/i, docType: "site_plan" },
  { re: /structural|roof\s*framing|mounting|attachment\s*detail/i, docType: "structural" },
  { re: /inverter|micro[-\s]?inverter/i, docType: "inverter_spec" },
  { re: /module|panel\s*(spec|data\s*sheet)/i, docType: "module_spec" },
  { re: /meter\s*(photo|picture|image|spec|reading|tag)/i, docType: "meter_photo" },
  { re: /label|placard/i, docType: "labels" },
  { re: /utility\s*bill|electric(ity)?\s*bill/i, docType: "utility_bill" },
  { re: /plan\s*set|full\s*plan|construction\s*(plan|doc)|drawings?/i, docType: "plan_set" },
];

// When an upload control's label doesn't name a specific document (a generic "Upload
// documents" / "Attach files" control), attach the full package/plan set instead — most
// portals with a single upload slot want the complete set. Tried in order.
const UPLOAD_FALLBACK_DOCTYPES = ["utility_package_zip", "plan_set", "sld", "site_plan"];

export function isPayFee(text: string | undefined): boolean {
  return !!text && PAY_FEE.test(text);
}

export function isSensitiveLabel(label: string): boolean {
  return SENSITIVE_LABEL.test(label);
}

// Map a sensitive portal-field LABEL to the project key that holds its value, so the learner can
// fill account/meter DETERMINISTICALLY (never via the LLM, which never receives these values) and
// bind the recorded step to the key for replay. Password/CVV/SSN have no project-data binding (a
// password is a login credential; SSN isn't on the project record), so they return null and are
// left for the human. The literal value is still never written into the recipe (step.value stays "").
export function sensitiveFieldKey(label: string): "accountNumber" | "meterNumber" | null {
  const l = (label || "").toLowerCase();
  if (/\bmeter\b/.test(l)) return "meterNumber";
  if (/\bacct\b|\baccount\b/.test(l)) return "accountNumber";
  return null;
}

// ---------------------------------------------------------------------------
// The DOM extraction script — runs in the page via $$eval. Pure (no closures over
// adapter state) so it can be serialized into the browser. Returns plain JSON.
// ---------------------------------------------------------------------------

export interface RawField {
  label: string;
  fieldType: ExtractedField["fieldType"];
  options?: string[];
  // True when the portal marks the field required (required/aria-required attribute or a
  // "*" in its label). Used by the gap-fill to report required fields it had no data for.
  required?: boolean;
  // Selector hints captured from the element.
  role?: string;
  name?: string;
  placeholder?: string;
  id?: string;
  css?: string;
  text?: string;
  href?: string;
}

// The CSS selector that enumerates every interactive control on a page (inputs, selects,
// textareas, buttons, role=button, and real <a href> links). Shared with llmGapFill so both
// the learn loop and the gap-fill pass scrape the exact same element set. NOTE: a test mock
// dispatches on selector.includes("button") — keep this literal string byte-identical.
export const EXTRACT_SEL = "input, select, textarea, button, [role=button], a[href]:not([href='#']):not([href=''])";

// Serializable extractor — derives a label and selector hints for each interactive
// element. Defined as a string-compatible function so it runs inside the page.
export function extractFieldsInPage(els: Element[]): RawField[] {
  function labelFor(el: Element): string {
    const id = el.getAttribute("id");
    if (id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lbl && lbl.textContent) return lbl.textContent.trim();
    }
    // Wrapping <label>
    const parentLabel = el.closest("label");
    if (parentLabel && parentLabel.textContent) {
      const t = parentLabel.textContent.trim();
      if (t) return t;
    }
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder.trim();
    const name = el.getAttribute("name");
    if (name) return name.trim();
    const text = (el.textContent || "").trim();
    if (text) return text;
    return "";
  }

  // Is the element actually rendered (not display:none / visibility:hidden, and not collapsed
  // to zero size by a hidden ancestor)? PowerClerk keeps hidden modal TEMPLATES in the DOM —
  // e.g. an "I understand…" confirmation checkbox and a row of OK/Cancel buttons — and not-yet-
  // revealed cascade fields are display:none until a parent dropdown is selected. Extracting
  // those phantom fields makes a content-less wizard page (the "Welcome" step) look like a
  // fillable form, which misclassifies it and sends the loop into stuck/recovery churn.
  // STRICT test only: display/visibility + offsetParent+zero-rect. Deliberately NOT filtering
  // on opacity / off-screen position / aria-hidden, since some portals fade-in or position
  // revealed fields and a looser test could drop a genuinely interactable control.
  function isRendered(el: Element): boolean {
    const he = el as HTMLElement;
    const style = typeof getComputedStyle === "function" ? getComputedStyle(he) : null;
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    // offsetParent is null when an ancestor is display:none (also for position:fixed, which we
    // exclude). Pair with a zero-size rect so a fixed-position visible control isn't dropped.
    if (he.offsetParent === null && (!style || style.position !== "fixed")) {
      const rect = he.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
    }
    return true;
  }

  const out: RawField[] = [];
  for (const el of els) {
    const tag = el.tagName.toLowerCase();
    const typeAttr = (el.getAttribute("type") || "").toLowerCase();
    let fieldType: ExtractedField["fieldType"] = "other";
    let options: string[] | undefined;

    if (tag === "select") {
      fieldType = "select";
      options = Array.from(el.querySelectorAll("option"))
        .map((o) => (o.textContent || "").trim())
        .filter((t) => t.length > 0);
    } else if (tag === "textarea") {
      fieldType = "text";
    } else if (tag === "button" || tag === "a" || (tag === "input" && (typeAttr === "submit" || typeAttr === "button"))) {
      fieldType = "button";
    } else if (tag === "input") {
      if (typeAttr === "checkbox") fieldType = "checkbox";
      else if (typeAttr === "radio") fieldType = "radio";
      else if (typeAttr === "file") fieldType = "file";
      else if (typeAttr === "hidden" || typeAttr === "password") fieldType = typeAttr === "password" ? "text" : "other";
      else fieldType = "text";
    }

    // Custom (non-native-<select>) dropdowns: PowerClerk "Please select..." widgets,
    // select2 / chosen / ui-select / ExtJS comboboxes. These render as styled divs, so
    // the tag checks above miss them and the planner never sees a dropdown to fill.
    // Detect by ARIA role / haspopup / known widget classes / the "Select..." prompt text,
    // and mark them "select" so applyFill's combobox fallback drives them.
    if (fieldType === "other") {
      const aria = (el.getAttribute("role") || "").toLowerCase();
      const haspopup = (el.getAttribute("aria-haspopup") || "").toLowerCase();
      const cls = (el.getAttribute("class") || "").toLowerCase();
      const ownText = (el.textContent || "").trim();
      const widgetClass = /\b(select2|chosen|ui-select|ng-select|v-select|x-combo|k-dropdown|multiselect|dropdown-toggle)\b/.test(cls);
      const promptText = /^(please\s+)?select\.{0,3}$/i.test(ownText);
      if (aria === "combobox" || aria === "listbox" || haspopup === "listbox" || haspopup === "true" || widgetClass || promptText) {
        fieldType = "select";
        // Capture any options already rendered in an associated open listbox.
        const listId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
        const list = listId ? document.getElementById(listId) : el.querySelector('[role="listbox"]');
        if (list) {
          const opts = Array.from(list.querySelectorAll('[role="option"], li, .dropdown-item'))
            .map((o) => (o.textContent || "").trim())
            .filter((t) => t.length > 0);
          if (opts.length) options = opts;
        }
      }
    }

    // Skip hidden inputs entirely.
    if (tag === "input" && typeAttr === "hidden") continue;

    // Skip elements that aren't rendered (display:none modal templates, not-yet-revealed
    // cascade fields, etc.). EXCEPTION: a non-visible <a> with a REAL href is kept — clickResilient's
    // fast path navigates straight to that href for menu-nested/hidden nav links (e.g. Accela's
    // "Building Dept Application"), so dropping it here would break dashboard navigation.
    const hrefAttr = tag === "a" ? (el.getAttribute("href") || "") : "";
    const anchorWithRealHref = !!hrefAttr && hrefAttr !== "#" && !/^javascript:/i.test(hrefAttr);
    if (!anchorWithRealHref && !isRendered(el)) continue;

    const label = labelFor(el);
    const name = el.getAttribute("name") || undefined;
    const placeholder = el.getAttribute("placeholder") || undefined;
    const id = el.getAttribute("id") || undefined;
    // <a> elements have ARIA role "link", not "button", even though we treat them as
    // button-type fields for extraction. Use "link" so Playwright's getByRole locator
    // resolves correctly; explicit [role="button"] overrides this.
    const role = el.getAttribute("role") || (tag === "a" ? "link" : fieldType === "button" ? "button" : undefined);
    const text = fieldType === "button" ? (el.textContent || "").trim() || undefined : undefined;
    // Capture href for anchors so a hidden/menu-nested nav link can be reached by direct
    // navigation when it can't be clicked.
    const href = tag === "a" ? (el.getAttribute("href") || undefined) : undefined;
    // Required signal: the native/ARIA attribute, or a "*"/"required" marker in the label
    // (PowerClerk & Accela both flag required fields with a red asterisk in the label text).
    const required =
      (el as HTMLInputElement).required === true ||
      el.getAttribute("aria-required") === "true" ||
      el.hasAttribute("required") ||
      /[*]/.test(label) ||
      /\brequired\b/i.test(label) ||
      undefined;

    out.push({ label, fieldType, options, required, role, name, placeholder, id, text, href });
  }
  return out;
}

// Turn a RawField captured in the page into the contract's ExtractedField, building a
// stable RecipeSelector preferring label / role+name / name, falling back to css #id.
export function toExtractedField(raw: RawField): ExtractedField {
  const selector: RecipeSelector = {};
  if (raw.fieldType === "button") {
    // Use the element's actual ARIA role ("link" for <a> tags, "button" otherwise).
    // getByRole("button", {name}) never matches a plain <a> — it must be "link".
    const ariaRole = raw.role || "button";
    if (raw.text) {
      selector.role = ariaRole;
      selector.name = raw.text;
      // EXACT name match: a substring match makes "Next" also match "Next page" (a decoy
      // pager button), and .first() then resolves to whichever is first in the DOM — the
      // wrong control. Exact matching pins it to the button whose accessible name IS the
      // text; the #id fallback below still resolves it if the exact name happens to miss.
      selector.exact = true;
      // Always keep a css fallback so a role-name miss still resolves the element.
      if (raw.id) selector.fallbacks = [{ css: `#${raw.id}` }];
    } else if (raw.id) {
      selector.css = `#${raw.id}`;
    } else if (raw.name) {
      selector.name = raw.name;
      selector.role = ariaRole;
      selector.exact = true;
    }
  } else {
    // Inputs/selects: prefer label, then placeholder, then name, then css id.
    if (raw.label && raw.label === raw.placeholder) {
      selector.placeholder = raw.placeholder;
    } else if (raw.label && !isLikelyOnlyName(raw)) {
      selector.label = raw.label;
    } else if (raw.placeholder) {
      selector.placeholder = raw.placeholder;
    } else if (raw.name) {
      selector.name = raw.name;
    } else if (raw.id) {
      selector.css = `#${raw.id}`;
    }
    // Always keep a css #id fallback when we have one and didn't already use it.
    if (raw.id && !selector.css) {
      selector.fallbacks = [{ css: `#${raw.id}` }];
    }
  }
  // Absolute last resort so the selector is always usable.
  if (!selector.label && !selector.role && !selector.name && !selector.placeholder && !selector.css) {
    if (raw.id) selector.css = `#${raw.id}`;
    else if (raw.label) selector.text = raw.label;
  }
  const field: ExtractedField = {
    selector,
    label: raw.label,
    fieldType: raw.fieldType,
  };
  if (raw.options && raw.options.length) field.options = raw.options;
  if (raw.required) field.required = true;
  if (raw.href) field.href = raw.href;
  return field;
}

// The derived label equals the name attribute only — a label-based locator would then
// be unreliable, so prefer a more structural selector.
function isLikelyOnlyName(raw: RawField): boolean {
  return !!raw.name && raw.label === raw.name && !raw.placeholder;
}

function fail(steps: RecipeStep[], portalName: string, message: string, pauseReason: string | null = null): LearnResult {
  return {
    ok: false,
    portalName,
    steps,
    reviewScreen: { fields: [], bodyTextSnippet: "" },
    finalSubmitRecorded: steps.some((s) => s.isFinalSubmit === true),
    pageCount: 0,
    pauseReason,
    message,
  };
}

export class AutoLearnAdapter extends BasePortalAdapter {
  portalName: string;
  private page: Page | null = null;
  private maxPages: number;
  // docType → absolute file path of the upload-ready document (from the doc-splitting
  // tools). Used to attach the right split document at each portal upload control.
  private docsByType: Record<string, string>;
  // "split" attaches the matching split sheet to each labeled upload control (utility
  // portals like PowerClerk, which have a slot per document). "combined" attaches the
  // single full construction plan-set PDF to every upload control — Oregon ePermitting /
  // Accela explicitly require "all plan pages as one PDF" under a single "Plans -
  // Construction" attachment, so splitting would attach the wrong (partial) document.
  private uploadMode: "split" | "combined";

  // Optional progress sink — called at each page/phase so callers can drive a UI bar.
  // Wrapped so a throwing callback can never break the learn loop.
  private onProgress?: LearnProgressFn;

  // Heartbeat state: re-emits the last progress with a growing elapsedMs so the UI can
  // distinguish a slow step from a hung one. Reset on every REAL progress event.
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private lastProgress: LearnProgress | null = null;
  private lastProgressAtMs = 0;

  constructor(
    portalName: string,
    private planner: LearnPlanner,
    private options: {
      maxPages?: number;
      autoSubmit?: false;
      docsByType?: Record<string, string>;
      uploadMode?: "split" | "combined";
      onProgress?: LearnProgressFn;
    } = {},
  ) {
    super();
    this.portalName = portalName;
    this.onProgress = options.onProgress;
    // Default page budget. Multi-step utility/permit wizards (PowerClerk NEM, Accela)
    // routinely run 10-15 input steps before the review screen, so 8 was too low — it
    // capped out mid-form. The stuck-page guard + review detection bound the loop, so a
    // higher cap can't run away; it just allows long wizards to reach review.
    this.maxPages = options.maxPages ?? 18;
    this.docsByType = options.docsByType ?? {};
    this.uploadMode = options.uploadMode ?? "split";
  }

  // Resolve the document file to attach to a given file-input field. Matches the field's
  // label to a docType, then to an available split file in docsByType. Falls back to the
  // full package/plan set for a generic upload control. Returns null when nothing is
  // available (the upload is then left for the human, never faked).
  private resolveUpload(field: ExtractedField): { docType: string; file: string } | null {
    const label = field.label || "";
    // Combined mode (Accela / Oregon ePermitting): attach the SINGLE full plan-set PDF to
    // every upload control regardless of label — the AHJ wants all plan pages as one PDF.
    if (this.uploadMode === "combined") {
      for (const docType of ["plan_set", "combined_plan_set", "full_plan_set"]) {
        if (this.docsByType[docType]) return { docType, file: this.docsByType[docType] };
      }
      const firstKey = Object.keys(this.docsByType)[0];
      return firstKey ? { docType: firstKey, file: this.docsByType[firstKey] } : null;
    }
    // 1) Label names a specific document → attach that docType if we have the split file.
    for (const { re, docType } of UPLOAD_LABEL_PATTERNS) {
      if (re.test(label) && this.docsByType[docType]) return { docType, file: this.docsByType[docType] };
    }
    // 2) Generic/unlabeled upload control → fall back to the full package/plan set.
    for (const docType of UPLOAD_FALLBACK_DOCTYPES) {
      if (this.docsByType[docType]) return { docType, file: this.docsByType[docType] };
    }
    // 3) Last resort: any available document, so a required upload isn't silently skipped.
    const firstKey = Object.keys(this.docsByType)[0];
    return firstKey ? { docType: firstKey, file: this.docsByType[firstKey] } : null;
  }

  // --- credential injection (mirrors recipeAdapter.login) -------------------
  async login(context: PortalContext): Promise<PortalStepResult> {
    try {
      const opened = await openPortal({
        userDataDir: context.userDataDir,
        storageStatePath: context.storageStatePath,
        // Pass headless through as-is (undefined when unset) so resolveHeadless applies its
        // server-correct default (headless unless PORTAL_HEADLESS=false). Defaulting to
        // false here would force a headed launch that crashes on a display-less server.
        headless: context.headless,
      });
      this.opened = opened;
      this.page = opened.page;

      // Navigate to the portal entry URL so the learn loop starts on the application page.
      if (context.startUrl) {
        await this.page.goto(context.startUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
        await smartWait(this.page);
      }

      // Log in via the shared, portal-agnostic login flow. It detects/reveals the login
      // form, fills it (known + unknown portals), verifies success, and stops on MFA.
      // Never logs credentials.
      const result = await performLogin(this.page, context.credential);
      if (result.status === "logged_in" || result.status === "already_authenticated") {
        return { ok: true, message: `Opened ${this.portalName} for autonomous learning. ${result.message}` };
      }
      if (result.status === "mfa_captcha") {
        return { ok: false, message: result.message, pauseReason: "mfa_captcha" };
      }
      if (result.status === "no_credential") {
        return { ok: false, message: `${this.portalName} is showing a login page but no stored credential was found for this client/portal. Add the portal username + password under the client's logins, then retry. (Or run \`npm run portal:login\` once to establish a persistent session.)` };
      }
      // still_on_login / no_username_field / no_submit_control / error
      return { ok: false, message: `${this.portalName}: ${result.message}` };
    } catch (err) {
      return { ok: false, message: `Auto-learn login failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // --- the real entrypoint --------------------------------------------------
  // Emit a progress signal, swallowing any callback error so UI plumbing can never
  // interfere with the learn run itself.
  private emitProgress(p: LearnProgress): void {
    // Record this as the last REAL progress and reset the per-step clock so the heartbeat
    // measures elapsed-on-this-step from here.
    this.lastProgress = p;
    this.lastProgressAtMs = Date.now();
    if (!this.onProgress) return;
    try { this.onProgress({ ...p, elapsedMs: 0 }); } catch { /* progress sink must never break the run */ }
  }

  // Start a 5s heartbeat that re-emits the last real progress with a climbing elapsedMs and a
  // "(still working — Ns)" suffix. The number climbing without the step advancing is the signal
  // that a step is genuinely hung vs. merely slow. Safe to call once per run.
  private startHeartbeat(): void {
    if (this.hbTimer || !this.onProgress) return;
    this.hbTimer = setInterval(() => {
      if (!this.lastProgress || !this.onProgress) return;
      const elapsedMs = Date.now() - this.lastProgressAtMs;
      if (elapsedMs < 5000) return; // only chime once a step has been quiet a while
      const secs = Math.round(elapsedMs / 1000);
      const base = this.lastProgress.message.replace(/\s*\(still working[^)]*\)\s*$/, "");
      try {
        this.onProgress({ ...this.lastProgress, elapsedMs, heartbeat: true, message: `${base} (still working — ${secs}s)` });
      } catch { /* progress sink must never break the run */ }
    }, 5000);
    if (typeof (this.hbTimer as { unref?: () => void }).unref === "function") (this.hbTimer as { unref?: () => void }).unref!();
  }

  private stopHeartbeat(): void {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
  }

  async learn(context: PortalContext, project: ProjectRecord): Promise<LearnResult> {
    this.startHeartbeat();
    try {
      return await this.learnImpl(context, project);
    } finally {
      this.stopHeartbeat();
    }
  }

  private async learnImpl(context: PortalContext, project: ProjectRecord): Promise<LearnResult> {
    const steps: RecipeStep[] = [];
    // Secrets (account/meter) are stripped before the LLM, so the planner can neither fill nor bind
    // them — yet they're exactly the fields a NEM/utility portal keys the customer on. Fill + bind
    // them deterministically below from the project's own values. Never sent to the model; the
    // recorded step keeps value:"" and binds by `field`, so the literal never lands in steps_json.
    const sensitiveValues: Record<string, string> = {
      accountNumber: project.accountNumber || "",
      meterNumber: project.meterNumber || "",
    };
    let pageCount = 0;
    let finalSubmitRecorded = false;
    let reachedReview = false;
    // Fields we filled that did NOT hold their value when we read them back before advancing
    // (a portal silently dropped the fill). Accumulated across pages and surfaced so the
    // operator knows exactly which fields to fix — instead of finding them blank at review.
    const fillVerifyMisses: string[] = [];
    // Inline validation errors that BLOCKED an advance (a required field empty, or a value the
    // portal rejected). Accumulated across pages and surfaced so the operator knows exactly why
    // the form wouldn't move forward — instead of the run silently looping or recording a broken
    // page. `lastValidationErrors` carries the most recent page's blockers into the recovery hint
    // so the planner is told precisely which fields the portal flagged.
    const validationBlocks: string[] = [];
    let lastValidationErrors: string[] = [];
    // Stuck-page detection: if the page fingerprint doesn't change across consecutive
    // iterations (an advance silently failed — e.g. blocked by a validation error), stop
    // instead of burning every remaining page re-planning the same screen.
    let lastLoopFp = "";
    let stuckStreak = 0;
    // Cycle detection + LLM self-recovery: a ring buffer of recent page fingerprints catches
    // an A→B→C→A LOOP (which the consecutive-identical guard misses), e.g. a planner that
    // keeps restarting an application it already began. On stuck OR cycle we don't bail
    // immediately — we re-plan with a loop-aware recovery directive (up to MAX_RECOVERY
    // times) so the model can pick a different, forward-progress action and heal itself.
    const recentFingerprints: string[] = [];
    let recoveryAttempts = 0;
    const MAX_RECOVERY = 3;
    // Diagnostics: a compact, redacted breadcrumb per page (title + host/path + field
    // counts + classification + the planner's decision). Surfaced in the result message
    // and logs so a "nothing fillable" run is debuggable WITHOUT re-running blind.
    const pageTrace: string[] = [];
    // Did we ever reach a page with editable fields? Distinguishes "wandered through
    // dashboards/links and never found a form" from "found a form but couldn't finish".
    let everFoundFillable = false;
    // How many navigation-link clicks we've followed from dashboard/home pages.
    let navCount = 0;

    if (!this.page) {
      return fail(steps, this.portalName, "learn() called before login() opened a page.");
    }

    // Record the entry navigation (so the recipe is replayable from a clean session).
    try {
      const startUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
      if (startUrl) {
        steps.push({ action: "goto", phase: "open", value: startUrl, note: "entry url" });
      }
    } catch {
      // url() can fail on a fake/odd page — non-fatal.
    }

    // Debug screenshot dir — created once if AUTOLEARN_DEBUG_SCREENSHOTS=1.
    // Saves a "before fills" and "after fills" screenshot for every page so the
    // operator can see exactly what the bot saw and what it changed.
    let debugScreenshotDir: string | null = null;
    if (process.env.AUTOLEARN_DEBUG_SCREENSHOTS === "1") {
      const ts = Date.now();
      debugScreenshotDir = path.resolve(
        process.cwd(),
        "data",
        "screenshots",
        `learn-${ts}`,
      );
      try { fs.mkdirSync(debugScreenshotDir, { recursive: true }); } catch { debugScreenshotDir = null; }
    }

    const saveDebugShot = async (label: string) => {
      if (!debugScreenshotDir || !this.page) return;
      const safe = label.replace(/[^a-z0-9_-]/gi, "_").slice(0, 80);
      const dest = path.join(debugScreenshotDir, `${safe}.png`);
      try {
        const buf = await (this.page as Page).screenshot({ type: "png", fullPage: true });
        fs.writeFileSync(dest, buf);
      } catch { /* non-fatal */ }
    };

    for (let pageIdx = 0; pageIdx < this.maxPages; pageIdx++) {
      pageCount++;

      // Labels filled on THIS page, used to dedup the initial fill pass against the
      // post-selection re-scrape (d3) so a revealed field isn't filled twice. PER-PAGE on
      // purpose: PowerClerk's wizard reuses identical labels ("Name", "Address", "Email",
      // "Phone") across successive contact steps (Installer page, then Applicant page). A
      // run-wide accumulator would tell the planner those labels were "already done" and it
      // would skip the entire next contact page — leaving it blank.
      const alreadyFilledLabels: string[] = [];

      // a2) Dismiss any modals/popups/banners and clear lingering loading scrims before
      //     extracting fields, so overlays can't intercept the actions we take this page.
      await this.dismissModals();
      await this.clearOverlays();

      // b) Extract fields + candidate buttons + nav links on the current page. Retry while
      //    EMPTY — right after a login redirect / SPA navigation the page can be mid-render
      //    (0 elements); scraping then would wrongly look like an empty page and stop the run.
      let fields: ExtractedField[];
      let pageTitle = "";
      let url = "";
      let bodyText = "";
      try {
        let raws: RawField[] = [];
        // PowerClerk (and Bootstrap/jQuery/ExtJS SPAs generally) render each wizard step's
        // INPUTS asynchronously behind a loader while the page chrome (sidebar nav, Next
        // button) is already present. Breaking the retry the instant raws is non-empty would
        // capture the chrome but ZERO form fields, so the page looks empty and the bot
        // advances past it WITHOUT filling — the "customer info page skipped" failure. So:
        // wait for loaders to clear each attempt, and keep retrying until REAL input fields
        // appear (not just buttons/links), only giving up after the loaders are gone.
        const isInput = (r: RawField) => r.fieldType === "text" || r.fieldType === "select" || r.fieldType === "checkbox" || r.fieldType === "radio" || r.fieldType === "file";
        for (let tryN = 0; tryN < 6; tryN++) {
          await this.waitForContentLoaders();
          // After the loaders clear, give the SPA a short window to MOUNT an interactive control
          // before scraping, so a recording made on a Vue mount race captures the real fields (not
          // chrome-only). Short (4s) budget so a genuinely input-less page (terms/dashboard) does
          // not pay the full section-ready timeout before the settled-empty break below fires.
          await waitForInteractiveControls(this.page, 4000);
          raws = await this.page.$$eval(EXTRACT_SEL, extractFieldsInPage).catch(() => [] as RawField[]);
          if (raws.some(isInput)) break;            // real fields rendered — proceed
          if (raws.length > 0 && tryN >= 2 && !(await this.hasVisibleLoader())) break; // settled, genuinely no inputs
          await smartWait(this.page, 1500);
          await this.dismissModals();
          await this.clearOverlays();
        }
        fields = raws.map(toExtractedField);
        pageTitle = typeof this.page.title === "function" ? String((await this.page.title().catch(() => "")) ?? "") : "";
        url = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
        const rawBody = await this.page.locator("body").innerText().catch(() => "");
        bodyText = (redactStatusText(String(rawBody)) ?? "").slice(0, 2000);
      } catch (err) {
        return fail(steps, this.portalName, `Failed to scrape page ${pageCount}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Debug: capture the page as-seen BEFORE any fills.
      await saveDebugShot(`p${pageCount.toString().padStart(3, "0")}-before-${(pageTitle || "page").replace(/\s+/g, "_").slice(0, 40)}`);

      // PAGE CLASSIFICATION. A page with NO fillable inputs is EITHER a dashboard/home
      // (just navigation links — the portal entry screen after login) OR a read-only
      // REVIEW/confirm page (a data summary + a submit-intent button). They look identical
      // by "no inputs" alone, so discriminate by submit-intent button + review markers:
      //   - REVIEW  → positive review signals (URL or body) + (no inputs OR submit-intent btn).
      //   - TERMS   → T&C/billing/disclaimer page — pass-through, treated as dashboard so the
      //               planner clicks the Continue/I-Agree button without recording it as submit.
      //   - DASHBOARD → no inputs, no submit-intent button, no review signals → only links.
      const hasFillable = fields.some((f) => f.fieldType !== "button");
      const hasSubmitIntentBtn = fields.some((f) => f.fieldType === "button" && SUBMIT_INTENT.test(f.label));
      const reviewSignals = REVIEW_MARKERS.test(bodyText) || looksLikeReviewUrl(url);
      // T&C pages look like review pages (no inputs + Continue Application) but are not —
      // detect before the isDashboard/isReviewPage split so they're treated as pass-throughs.
      const isTermsPage = !hasFillable && !reviewSignals && (TERMS_MARKERS.test(bodyText) || looksLikeTermsUrl(url));
      // isDashboard: no inputs, no submit intent, no review signals — ALSO treats T&C as
      // dashboard so the planner navigates by clicking the Continue/Agree button.
      const isDashboard = (!hasFillable && !hasSubmitIntentBtn && !reviewSignals) || isTermsPage;
      if (hasFillable) everFoundFillable = true;

      // a0) STUCK / CYCLE GUARD with SELF-RECOVERY. Two failure shapes:
      //   - STUCK: the same page recurs on consecutive iterations (an advance had no effect).
      //   - CYCLE: an EARLIER page reappears (A→B→C→A) — e.g. the planner keeps restarting an
      //     application it already began. The consecutive guard alone misses this.
      // On either, instead of bailing we re-plan THIS iteration with a loop-aware recovery
      // directive (capped at MAX_RECOVERY) so the model can choose a different action and heal.
      let recoveryHint = "";
      const loopFp = await this.pageFingerprint();
      const consecutiveStuck = !!loopFp && loopFp === lastLoopFp;
      const cycling = !!loopFp && !consecutiveStuck && recentFingerprints.includes(loopFp);
      if (loopFp) {
        recentFingerprints.push(loopFp);
        if (recentFingerprints.length > 8) recentFingerprints.shift();
      }
      if (consecutiveStuck) stuckStreak++; else stuckStreak = 0;
      lastLoopFp = loopFp;
      if ((consecutiveStuck && stuckStreak >= 2) || cycling) {
        if (recoveryAttempts >= MAX_RECOVERY) {
          if (process.env.AUTOLEARN_DEBUG === "1") console.error(`[learn] ${cycling ? "cycling" : "stuck"} and recovery budget exhausted — stopping.`);
          break;
        }
        recoveryAttempts++;
        const problem = cycling
          ? "You are CYCLING: this page was already visited earlier in this run, so a previous action looped you back to the start."
          : "You are STUCK: the last action did not change the page.";
        // If the last advance was blocked by inline validation, tell the planner EXACTLY which
        // fields the portal flagged so it fixes those instead of guessing (or re-clicking Next).
        const validationLine = lastValidationErrors.length > 0
          ? ` The portal BLOCKED the advance with these validation errors — fix these specific fields before advancing again: ${lastValidationErrors.slice(0, 10).join(" | ")}.`
          : "";
        recoveryHint =
          `${problem} Recent steps: ${pageTrace.slice(-4).join("  ->  ") || "(none)"}.${validationLine} ` +
          `Do NOT repeat the action that caused this. In particular, do NOT click a navigation link that RESTARTS the flow ` +
          `(e.g. "Building Dept Application", "New Application", "Start Application") if the application is already begun. ` +
          `Choose a DIFFERENT action that makes FORWARD progress on THIS page: fill the remaining required fields, ` +
          `Select the correct results row, check the required option (e.g. the application type), or click this page's Continue/Next button.`;
        if (process.env.AUTOLEARN_DEBUG === "1") console.error(`[learn] recovery attempt ${recoveryAttempts}/${MAX_RECOVERY} (${cycling ? "cycle" : "stuck"})`);
      }

      // a) CHALLENGE GATE (after extraction so it can use field counts). A real MFA/CAPTCHA
      //    page is STRUCTURAL (an iframe / distinctive title) or SPARSE (a code box + submit).
      //    Structural/title/iframe signals always stop. A TEXT-only match is treated as a
      //    challenge ONLY on a sparse page (≤2 fillable inputs) — otherwise it's a false
      //    positive on a real application form that merely contains words like "verification"
      //    or "authenticate". We never proceed past a genuine challenge; we just don't let a
      //    keyword on a 35-field form halt the whole run.
      const challenge = await detectChallengeFrame(this.page);
      if (challenge) {
        const textOnly = /challenge text detected/i.test(challenge);
        const fillableCount = fields.filter((f) => f.fieldType !== "button").length;
        if (!textOnly || fillableCount <= 2) {
          return {
            ok: false,
            portalName: this.portalName,
            steps,
            reviewScreen: { fields: [], bodyTextSnippet: "" },
            finalSubmitRecorded,
            pageCount,
            pauseReason: "mfa_captcha",
            message: `Stopped: ${challenge}. A human must complete the MFA/CAPTCHA. The recipe was recorded up to this page.`,
          };
        }
        // else: text keyword on a field-rich form — false positive, continue learning.
      }

      // c) Ask the planner what to do on this page.
      let plan: LearnPlanResponse;
      try {
        plan = await this.planner({ url, pageTitle, fields, bodyText, alreadyFilledLabels, isDashboard, recoveryHint: recoveryHint || undefined });
      } catch (err) {
        return fail(steps, this.portalName, `Planner failed on page ${pageCount}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // c2) STRUCTURAL REVIEW GUARD — the Accela "Continue Application" trap.
      // On a review page its primary button (e.g. "Continue Application") SUBMITS, so we
      // NEVER advance-click — we force the review stop and record that button as the final
      // submit, overriding a planner that mistook the submit button for an "advance/next".
      // T&C pages are implicitly excluded: isTermsPage → isDashboard=true → !isDashboard=false,
      // so the first clause never fires for them. No need for an explicit isTermsPage check.
      const isReviewPage = (!hasFillable && !isDashboard) || (reviewSignals && hasSubmitIntentBtn);
      if (isReviewPage && !plan.atReview) {
        // Promote a planner "advance" that is actually a submit-intent button to finalSubmit.
        let promotedFinal = typeof plan.finalSubmitSelectorIndex === "number" ? plan.finalSubmitSelectorIndex : undefined;
        if (promotedFinal == null && typeof plan.advanceSelectorIndex === "number") {
          const adv = fields[plan.advanceSelectorIndex];
          if (adv && SUBMIT_INTENT.test(adv.label) && !this.isOffLimitsButton(adv)) promotedFinal = plan.advanceSelectorIndex;
        }
        if (promotedFinal == null) {
          // Fall back to the first submit-intent (non-pay) button on the page.
          const idx = fields.findIndex((f) => f.fieldType === "button" && SUBMIT_INTENT.test(f.label) && !this.isOffLimitsButton(f));
          if (idx >= 0) promotedFinal = idx;
        }
        plan = { ...plan, atReview: true, advanceSelectorIndex: undefined, finalSubmitSelectorIndex: promotedFinal };
      }

      // c2b) DIAGNOSTIC BREADCRUMB — record what we saw + what the planner decided on this
      //      page. host+pathname only (NO query string — avoids leaking any ids), title
      //      capped, no field values. This is the trace surfaced when a run finds nothing.
      {
        let hostPath = "";
        try { const u = new URL(url); hostPath = u.host + u.pathname; } catch { hostPath = (url || "").slice(0, 60); }
        const fillCount = fields.filter((f) => f.fieldType !== "button").length;
        const btnCount = fields.filter((f) => f.fieldType === "button").length;
        const linkCount = fields.filter((f) => f.fieldType === "button" && f.selector?.role === "link").length;
        const cls = isReviewPage ? "review" : isDashboard ? "dashboard" : hasFillable ? "form" : "empty";
        pageTrace.push(
          `p${pageCount} "${(pageTitle || "").slice(0, 40)}" [${hostPath}] ${cls} ` +
          `fields=${fields.length}(fill=${fillCount},btn=${btnCount},link=${linkCount}) ` +
          `plan:nav=${plan.navigateSelectorIndex ?? "-"} adv=${plan.advanceSelectorIndex ?? "-"} ` +
          `fills=${(plan.fills ?? []).length} review=${plan.atReview}`,
        );

        // Live progress for the UI — a short, non-PII description of this page. The
        // review phase is driven by the planner's atReview (or a structural review page),
        // even if the screen still carries a trailing field (e.g. a terms checkbox).
        const plannedFills = (plan.fills ?? []).length;
        const atReview = plan.atReview || cls === "review";
        const progressMsg =
          atReview
            ? "Review screen reached — checking the filled values…"
            : cls === "dashboard"
              ? `Navigating to the application form (step ${pageCount})…`
              : cls === "form"
                ? `Filling step ${pageCount}${plannedFills ? ` — ${plannedFills} field${plannedFills === 1 ? "" : "s"}` : ""}…`
                : `Reading step ${pageCount}…`;
        this.emitProgress({
          phase: atReview ? "review" : "page",
          pageCount,
          maxPages: this.maxPages,
          classification: cls,
          fillsPlanned: plannedFills,
          message: progressMsg,
        });

        // Debug: write a JSON sidecar next to this page's screenshots showing what the bot
        // SAW (field labels) and DECIDED (each fill's field/value, sensitive masked). This is
        // the "real vs guessing" record — pair it with the p{n}-before/after PNGs.
        if (debugScreenshotDir) {
          const sidecar = {
            page: pageCount,
            title: pageTitle,
            url: hostPath,
            classification: cls,
            atReview: plan.atReview,
            navigateIndex: plan.navigateSelectorIndex ?? null,
            advanceIndex: plan.advanceSelectorIndex ?? null,
            finalSubmitIndex: plan.finalSubmitSelectorIndex ?? null,
            recoveryHint: recoveryHint || null,
            fieldsSeen: fields.map((f, i) => ({
              i,
              type: f.fieldType,
              label: (f.label || "").slice(0, 80),
            })),
            decisions: (plan.fills ?? []).map((fl) => {
              const f = fields[fl.selectorIndex];
              const sensitive = f ? isSensitiveLabel(f.label) : false;
              return {
                index: fl.selectorIndex,
                label: (f?.label || "?").slice(0, 80),
                boundField: fl.field || null,
                value: sensitive ? "***sensitive (bound at replay)***" : (fl.value ?? ""),
                source: fl.field ? "data-bound" : "literal",
              };
            }),
          };
          try {
            const dest = path.join(
              debugScreenshotDir,
              `p${pageCount.toString().padStart(3, "0")}-plan.json`,
            );
            fs.writeFileSync(dest, JSON.stringify(sidecar, null, 2));
          } catch { /* non-fatal */ }
        }
      }

      // c3) DASHBOARD NAVIGATION — click a link/button to get from the portal home to the
      //     actual application form. Recorded as a click step (phase:"open") then loop again.
      if (typeof plan.navigateSelectorIndex === "number") {
        const navField = fields[plan.navigateSelectorIndex];
        if (navField && !this.isOffLimitsButton(navField)) {
          navCount++;
          steps.push({
            action: "click",
            phase: "open",
            selector: navField.selector,
            note: `navigate to application: ${navField.label || "link"}`,
          });
          // Extra settle before the first navigation click. Accela/ExtJS dashboards render
          // their permit-type links via AJAX after the page shell loads; the links are in the
          // DOM a few ms after extraction but may still have an ExtJS loading mask above them.
          // A short networkidle race clears that window without blocking indefinitely.
          await Promise.race([
            this.page.waitForLoadState?.("networkidle", { timeout: 4000 }).catch(() => null),
            sleep(2000),
          ]);
          await this.clearOverlays();
          const navBeforeUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
          const navBeforeFp = await this.pageFingerprint();
          const navTabsBefore = this.tabCount(); // capture BEFORE the click — the popup opens during it
          const res = await safeAction(
            "navigate",
            async () => {
              const loc = await this.locator(navField.selector);
              if (!loc) throw new Error("navigate selector unresolved");
              const href = navField.href;
              const realHref = !!href && href !== "#" && !/^javascript:/i.test(href);
              const gotoHref = async () => {
                const abs = new URL(href!, String(this.page!.url())).href;
                if (process.env.AUTOLEARN_DEBUG === "1") console.error(`[navigate] navigating to href ${abs}`);
                await this.page!.goto(abs, { waitUntil: "domcontentloaded", timeout: 30000 });
              };
              // FAST PATH: a hidden/menu-nested anchor with a real href is never clickable —
              // don't burn ~80s on click retries; navigate straight to the href. (Accela's
              // "Building Dept Application" is a hidden <a href="...CapApplyDisclaimer.aspx">.)
              let visible = false;
              try { visible = (await loc.count()) > 0 && (await loc.isVisible().catch(() => false)); } catch { visible = false; }
              if (!visible && realHref) {
                await gotoHref();
              } else {
                try {
                  await this.clickResilient(loc);
                } catch (clickErr) {
                  // Fallback: a link we couldn't click but that has a usable href.
                  if (realHref && this.page) await gotoHref();
                  else throw clickErr;
                }
              }
              await this.waitAfterClick(navBeforeUrl, navBeforeFp, navTabsBefore);
            },
            { required: true },
          );
          if (!res.ok) {
            return fail(steps, this.portalName, `Failed to click navigation link "${navField.label}" on page ${pageCount}: ${res.message ?? "unknown"}`);
          }
          continue; // re-enter the loop on the new page
        }
      }

      // d0) UPLOAD PASS — attach the right split document to every file-input on this page.
      //     Deterministic (no LLM): each upload control's label is matched to a docType and
      //     the corresponding split file is attached, then recorded as an `upload` step so
      //     the replayed recipe uploads the same document. File inputs are often visually
      //     hidden behind a styled button, so we DON'T require visibility before setting.
      for (const field of fields) {
        if (field.fieldType !== "file") continue;
        const resolved = this.resolveUpload(field);
        if (!resolved) continue; // no document available — leave it for the human, never fake it.
        const res = await safeAction(
          `upload ${resolved.docType}`,
          async () => {
            const loc = await this.locator(field.selector);
            if (!loc) throw new Error("upload selector unresolved");
            await loc.setInputFiles(resolved.file);
            await smartWait(this.page!, 500);
          },
          { required: false },
        );
        if (res.ok && !res.message) {
          steps.push({
            action: "upload",
            phase: "fill",
            selector: field.selector,
            docType: resolved.docType,
            note: `upload ${resolved.docType}: ${field.label || "document"}`,
          });
          if (field.label) alreadyFilledLabels.push(field.label);
        }
      }

      // d) Apply the fills and record each as a RecipeStep.
      let pageFillCount = 0;
      const appliedThisPage: AppliedFill[] = [];
      for (const fillReq of plan.fills ?? []) {
        const field = fields[fillReq.selectorIndex];
        if (!field) continue; // out-of-range index from the planner — skip safely.
        if (field.fieldType === "file") continue; // handled by the upload pass above.
        // Sensitive fields (account/meter) are filled + bound DETERMINISTICALLY below from the
        // project, not from the planner — which never receives their values, so its fill here would
        // be blank or a guess. Skip them in the planner pass so nothing wrong lands in the control
        // or the recipe.
        if (isSensitiveLabel(field.label)) continue;
        const step = await this.applyFill(field, fillReq, false);
        if (step) {
          steps.push(step);
          pageFillCount++;
          if (field.label) alreadyFilledLabels.push(field.label);
          appliedThisPage.push({
            selector: field.selector,
            label: field.label || field.fieldType,
            fieldType: field.fieldType,
            // The value typed into the control (literal, data-bound, or numeric-sanitized),
            // used to re-apply if the fill didn't hold.
            expected: step.value ?? fillReq.value ?? "",
            sensitive: false,
            required: Boolean(field.required),
          });
        }
      }

      // d′) DETERMINISTIC SENSITIVE BINDING. The planner never sees account/meter values, so it can
      //     neither fill nor bind them — and those are precisely the fields a NEM/utility portal
      //     keys the customer on. Fill them here from the project (typed into the page so the review
      //     screen verifies) and record a data-BOUND step (field=key, value:"") so replay re-types
      //     them from the project. The literal secret is never sent to the LLM nor written to
      //     steps_json; it's typed into the browser only. A field with no project value is left for
      //     the human (gap-fill / the review verifier flags it).
      for (const field of fields) {
        if (field.fieldType === "file") continue;
        if (!isSensitiveLabel(field.label)) continue;
        if (field.label && alreadyFilledLabels.includes(field.label)) continue;
        const sensKey = sensitiveFieldKey(field.label);
        if (!sensKey) continue; // password/cvv/ssn → no project binding; left for the human.
        const sensVal = sensitiveValues[sensKey];
        if (!sensVal) continue; // no value on the project — gap-fill/verify will surface it.
        const step = await this.applyFill(field, { value: sensVal, field: sensKey }, true);
        if (step) {
          steps.push(step);
          pageFillCount++;
          if (field.label) alreadyFilledLabels.push(field.label);
          appliedThisPage.push({
            selector: field.selector,
            label: field.label || field.fieldType,
            fieldType: field.fieldType,
            expected: "", // sensitive — never logged or retyped; only confirmed non-empty.
            sensitive: true,
            required: Boolean(field.required),
          });
        }
        // After a dropdown/checkbox change, wait for any Vue/React re-renders triggered
        // by the change event to complete before filling the next field. Portals like
        // PowerClerk reset sibling fields when a contact-type dropdown is changed; fills
        // that land during the re-render are cleared when Vue finishes diffing.
        if ((field.fieldType === "select" || field.fieldType === "checkbox") && this.page) {
          await this.page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => null);
          const selectSettleMs = Number(process.env.AUTOLEARN_SELECT_SETTLE_MS) || 1000;
          if (selectSettleMs > 0) await sleep(selectSettleMs);
        }
      }

      // d1) PERSIST SETTLE. Portals like PowerClerk autosave each page's fields via an AJAX
      //     round-trip (~3s/page). If we advance before that completes, the entered values are
      //     LOST — the visibly-filled form saves a BLANK draft. After filling a page, wait for
      //     the network to settle and give the autosave time to commit before advancing.
      //     Tunable via AUTOLEARN_SAVE_SETTLE_MS (default 3000).
      if (pageFillCount > 0) {
        const settleNetwork = async (timeout: number) => {
          if (typeof this.page?.waitForLoadState === "function") {
            await this.page.waitForLoadState("networkidle", { timeout }).catch(() => null);
          }
        };
        await settleNetwork(8000);
        const settleMs = Number(process.env.AUTOLEARN_SAVE_SETTLE_MS) || 3000;
        await sleep(settleMs);
        await settleNetwork(4000);

        // Debug: capture the page AFTER fills have settled so we can compare with "before".
        await saveDebugShot(`p${pageCount.toString().padStart(3, "0")}-after-${(pageTitle || "page").replace(/\s+/g, "_").slice(0, 40)}`);
      }

      // d2) VERIFY THE FILLS LANDED before advancing. A portal can silently drop a fill — a
      //     Vue/React model rejects it, an overlay eats the keystrokes, inline validation
      //     clears it, or an autosave round-trip blanks it. If we advance blindly the field
      //     is gone and only resurfaces (if at all) as a blank at the review screen. Read each
      //     filled control back; re-apply once if it didn't hold; record any required field
      //     that STILL won't hold its value so the operator sees exactly what to fix.
      if (appliedThisPage.length > 0) {
        const misses = await this.verifyFillsLanded(appliedThisPage);
        for (const m of misses) if (!fillVerifyMisses.includes(m)) fillVerifyMisses.push(m);
      }

      // d3) POST-SELECTION RE-SCRAPE: conditional fields revealed by dropdown selections.
      //     On portals like PowerClerk, selecting "Residential" as Account Type reveals a
      //     Schedule dropdown; selecting a Schedule reveals Account# and Meter# fields.
      //     After applying this page's fills, re-scrape and fill any NEW fields that appeared.
      //     This is a best-effort, single-pass catch-up — never throws or breaks the loop.
      if (pageFillCount > 0 && !plan.atReview) {
        try {
          await this.waitForContentLoaders();
          await this.clearOverlays();
          const postRaws = await this.page.$$eval(EXTRACT_SEL, extractFieldsInPage).catch(() => [] as RawField[]);
          const postFields = postRaws.map(toExtractedField);
          const newFillable = postFields.filter(
            (f) => f.fieldType !== "button" && f.label && !alreadyFilledLabels.includes(f.label),
          );
          // Debug: record what the re-scrape revealed and what it decided to fill.
          const rescanDecisions: Array<{ label: string; boundField: string | null; value: string; source: string }> = [];
          if (newFillable.length > 0) {
            // Ask the planner to fill the newly-visible fields. Use the full postFields list
            // so index math is correct; supply alreadyFilledLabels so it skips already-done fields.
            let postPlan: LearnPlanResponse = { fills: [], atReview: false };
            try {
              postPlan = await this.planner({
                url, pageTitle, fields: postFields, bodyText,
                alreadyFilledLabels, isDashboard: false,
              });
            } catch { /* planner failure is non-fatal for the re-scrape pass */ }

            let postFillCount = 0;
            for (const fillReq of postPlan.fills ?? []) {
              const field = postFields[fillReq.selectorIndex];
              if (!field || field.fieldType === "file") continue;
              if (isSensitiveLabel(field.label)) continue;
              if (field.label && alreadyFilledLabels.includes(field.label)) continue;
              const step = await this.applyFill(field, fillReq, false);
              if (step) {
                steps.push(step);
                postFillCount++;
                pageFillCount++;
                if (field.label) alreadyFilledLabels.push(field.label);
                rescanDecisions.push({
                  label: (field.label || "?").slice(0, 80),
                  boundField: fillReq.field || null,
                  value: fillReq.field ? "" : (fillReq.value ?? ""),
                  source: fillReq.field ? "data-bound" : "literal",
                });
              }
            }
            // Deterministic sensitive binding for newly-visible account/meter fields.
            for (const field of postFields) {
              if (field.fieldType === "file") continue;
              if (!isSensitiveLabel(field.label)) continue;
              if (field.label && alreadyFilledLabels.includes(field.label)) continue;
              const sensKey = sensitiveFieldKey(field.label);
              if (!sensKey) continue;
              const sensVal = sensitiveValues[sensKey];
              if (!sensVal) continue;
              const step = await this.applyFill(field, { value: sensVal, field: sensKey }, true);
              if (step) {
                steps.push(step);
                postFillCount++;
                pageFillCount++;
                if (field.label) alreadyFilledLabels.push(field.label);
                rescanDecisions.push({
                  label: (field.label || "?").slice(0, 80),
                  boundField: sensKey,
                  value: "***sensitive (bound at replay)***",
                  source: "sensitive-deterministic",
                });
              }
            }
            // Let the portal autosave the conditional-field fills before advancing.
            if (postFillCount > 0) {
              if (typeof this.page?.waitForLoadState === "function") {
                await this.page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => null);
              }
              await sleep(2000);
            }
          }
          // Debug: dump the re-scrape result (revealed fields + decisions) and an after-shot
          // so the operator can see what conditional fields appeared post-dropdown.
          if (debugScreenshotDir && newFillable.length > 0) {
            try {
              const dest = path.join(
                debugScreenshotDir,
                `p${pageCount.toString().padStart(3, "0")}-rescan.json`,
              );
              fs.writeFileSync(dest, JSON.stringify({
                page: pageCount,
                title: pageTitle,
                revealedFields: newFillable.map((f) => (f.label || "?").slice(0, 80)),
                decisions: rescanDecisions,
              }, null, 2));
            } catch { /* non-fatal */ }
            await saveDebugShot(`p${pageCount.toString().padStart(3, "0")}-rescan-${(pageTitle || "page").replace(/\s+/g, "_").slice(0, 40)}`);
          }
        } catch { /* post-selection re-scrape is best-effort — never break the loop */ }
      }

      // d4) COMPUTE-TOTAL CLICK (portal-agnostic). Some forms render a derived value (system
      //     size kW, total cost) only after the user clicks a "Calculate"/"Recalculate"/"Update
      //     total" button — otherwise the field stays 0.00 and reads blank/wrong at review. Click
      //     any such button by its LABEL (never a portal-specific selector) after fills so the
      //     computed value populates before we advance. Guarded by isOffLimitsButton so a
      //     pay/fee/submit control can never be clicked here; the regex is intentionally narrow.
      if (pageFillCount > 0 && !plan.atReview) {
        const COMPUTE_BTN = /\b(re-?calculate|calculate|compute|recompute|update total)\b/i;
        const computeField = fields.find(
          (f) => f.fieldType === "button" && COMPUTE_BTN.test(f.label) && !this.isOffLimitsButton(f),
        );
        if (computeField) {
          try {
            const loc = await this.locator(computeField.selector);
            if (loc) {
              await this.clickResilient(loc);
              if (typeof this.page?.waitForLoadState === "function") {
                await this.page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => null);
              }
              await sleep(1000);
            }
          } catch { /* compute-button click is best-effort — never break the loop */ }
        }
      }

      // e) Record the final submit (if any) — NEVER click it. Reject pay/fee buttons.
      if (typeof plan.finalSubmitSelectorIndex === "number") {
        const submitField = fields[plan.finalSubmitSelectorIndex];
        if (submitField && !this.isOffLimitsButton(submitField)) {
          steps.push({
            action: "click",
            phase: "review",
            selector: submitField.selector,
            isFinalSubmit: true,
            note: `final submit: ${submitField.label || "submit"} (recorded, NOT clicked)`,
          });
          finalSubmitRecorded = true;
        }
      }

      // f) Stop at review, OR advance to the next page, OR stop (no advance).
      if (plan.atReview) {
        reachedReview = true;
        break;
      }

      if (typeof plan.advanceSelectorIndex === "number") {
        const advanceField = fields[plan.advanceSelectorIndex];
        if (!advanceField) break; // bad index — stop cleanly.
        // SAFETY: never click/record a pay/fee/checkout button as the "advance".
        if (this.isOffLimitsButton(advanceField)) {
          return {
            ok: false,
            portalName: this.portalName,
            steps,
            reviewScreen: { fields: [], bodyTextSnippet: "" },
            finalSubmitRecorded,
            pageCount,
            pauseReason: null,
            message: `Stopped: the planner returned a pay/fee control ("${advanceField.label}") as the advance button. Never automated. The recipe was recorded up to this page; a human must continue.`,
          };
        }
        // Record the advance click, then perform it.
        steps.push({
          action: "click",
          phase: "fill",
          selector: advanceField.selector,
          note: `advance: ${advanceField.label || "next"}`,
        });
        const advBeforeUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
        const advBeforeFp = await this.pageFingerprint();
        const advTabsBefore = this.tabCount(); // capture BEFORE the click — the popup opens during it
        const res = await safeAction(
          "advance",
          async () => {
            const loc = await this.locator(advanceField.selector);
            if (!loc) throw new Error("advance selector unresolved");
            await this.clickResilient(loc);
            await this.waitAfterClick(advBeforeUrl, advBeforeFp, advTabsBefore);
          },
          { required: true },
        );
        if (!res.ok) {
          return fail(steps, this.portalName, `Failed to click the advance button on page ${pageCount}: ${res.message ?? "unknown"}`);
        }

        // d5) POST-ADVANCE VALIDATION GUARD. The click succeeded, but did the form actually
        //     MOVE? If the URL and page fingerprint are BOTH unchanged, the portal blocked the
        //     advance — almost always inline validation (a required field empty, or a value it
        //     rejected). Rather than silently recording a broken page and letting the loop churn,
        //     scrape the visible validation errors + required-empty fields and flag them. We pop
        //     the advance step that didn't advance, stash the blockers for the recovery hint, and
        //     fall through to the loop — the stuck-guard re-plans WITH the specific errors so the
        //     planner can fix them; after the recovery budget is spent the run stops and the final
        //     message lists exactly what blocked it.
        const advAfterUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
        const advAfterFp = await this.pageFingerprint();
        const movedForward = (advAfterUrl && advAfterUrl !== advBeforeUrl) || (!!advAfterFp && advAfterFp !== advBeforeFp);
        if (!movedForward) {
          const blockers = await this.collectValidationErrors();
          if (blockers.length > 0) {
            lastValidationErrors = blockers;
            for (const b of blockers) if (!validationBlocks.includes(b)) validationBlocks.push(b);
            // Drop the advance step we optimistically recorded — it advanced nothing, so a
            // replay must not re-issue it as-is.
            if (steps.length && steps[steps.length - 1].note?.startsWith("advance:")) steps.pop();
            if (process.env.AUTOLEARN_DEBUG === "1") console.error(`[learn] advance BLOCKED by validation on page ${pageCount}: ${blockers.join(" | ")}`);
          }
        } else {
          // Moved forward cleanly — clear any stale blockers from a prior page.
          lastValidationErrors = [];
        }
        continue;
      }

      // No advance + not at review → nothing more we can do.
      break;
    }

    // 3) Scrape the review screen (best effort).
    let reviewScreen: LearnResult["reviewScreen"] = { fields: [], bodyTextSnippet: "" };
    try {
      reviewScreen = await this.scrapeReviewScreen();
    } catch {
      // non-fatal — keep the empty default.
    }

    // 6) ok:true only when it reached a review screen, or filled >=1 page cleanly.
    const filledSomething = steps.some((s) => s.action === "fill" || s.action === "select" || s.action === "check");
    const ok = reachedReview || filledSomething;

    // Compact, redacted page trace for diagnostics. Always logged; appended to the result
    // message when the run didn't reach a review screen so the operator can see WHERE the
    // bot got lost (which page, what fields, what the planner chose) without re-running blind.
    const traceLine = pageTrace.join(" | ");
    if (!ok || process.env.AUTOLEARN_DEBUG === "1") {
      console.error(`[auto-learn] ${this.portalName}: ${pageCount} page(s), navigated ${navCount} link(s), foundFillable=${everFoundFillable}\n  ${pageTrace.join("\n  ")}`);
    }

    // When nothing was fillable, explain the most likely cause so the message is actionable.
    // The dominant failure mode on PowerClerk-style portals is "Start/Create Application"
    // opening the real form in a NEW TAB or behind a program/type picker — the bot then
    // re-scrapes the dead home page until the stuck-guard bails. (New-tab adoption now
    // handles the common case; this guidance covers what's left.)
    const nothingFillableHint = !everFoundFillable && navCount > 0
      ? ` It followed ${navCount} navigation link(s) from the portal home but never reached a form with editable fields — the start URL may point at the wrong page, the "start application" action may open a new tab or a program/record-type picker the bot couldn't follow, or a program must be selected first. Verify the start URL is the program's application/home page.`
      : "";

    // Surface any field that didn't hold its value after we filled it (caught by the
    // pre-advance readback) so the operator knows what to fix instead of finding it blank.
    const verifyWarning = fillVerifyMisses.length > 0
      ? ` ⚠ ${fillVerifyMisses.length} required field(s) did not hold their value after filling and may be blank in the portal: ${fillVerifyMisses.slice(0, 12).join(", ")}${fillVerifyMisses.length > 12 ? ", …" : ""}. Re-check these before submit.`
      : "";

    // Surface inline-validation errors that BLOCKED an advance, so the operator sees exactly which
    // required/invalid fields stopped the form instead of a vague "got stuck". This is the signal
    // that a page was NOT silently recorded as complete when the portal refused to advance it.
    const validationWarning = validationBlocks.length > 0
      ? ` ⛔ The portal blocked an advance with ${validationBlocks.length} validation error(s) — fix before submit: ${validationBlocks.slice(0, 12).join("; ")}${validationBlocks.length > 12 ? "; …" : ""}.`
      : "";

    const message = (reachedReview
      ? `${HUMAN_REVIEW_MESSAGE} Auto-learn reached the review screen after ${pageCount} page(s). Verify every field/value below before a human submits.`
      : filledSomething
        ? `Auto-learn filled ${pageCount} page(s) and recorded the steps, but did not reach a review screen. Page trace: ${traceLine}`
        : `Auto-learn found nothing fillable on ${pageCount} page(s); no steps recorded.${nothingFillableHint} Page trace: ${traceLine}`) + verifyWarning + validationWarning;

    // Capture the review page screenshot when we've reached the review screen. fullPage:true
    // so the vision verifier sees the WHOLE review — a viewport-only shot would let an
    // off-screen blank/wrong required field pass unseen.
    let reviewScreenshotBase64: string | undefined;
    try {
      const buf = await this.page.screenshot({ type: "png", fullPage: true });
      reviewScreenshotBase64 = buf.toString("base64");
    } catch { /* non-fatal */ }

    return {
      ok,
      portalName: this.portalName,
      steps,
      reviewScreen,
      finalSubmitRecorded,
      pageCount,
      pauseReason: null,
      message,
      reachedReview,
      filledSomething,
      reviewScreenshotBase64,
    };
  }

  // Apply a single fill/select/check and return the RecipeStep that records it (or null
  // if the action could not be applied). Sensitive fields are recorded WITHOUT a literal
  // value (sensitive:true, value:"") and are bound by `field` instead.
  private async applyFill(
    field: ExtractedField,
    fillReq: { value: string; field?: string },
    sensitive: boolean,
  ): Promise<RecipeStep | null> {
    const value = fillReq.value ?? "";
    // Radios are CHECKABLE like checkboxes — selecting one is a check(), NOT a fill().
    // The previous code routed radio to the text-fill branch (loc.fill), which throws on a
    // radio input, so radio choices (PGE "Description of Service", "Service Type: Single")
    // silently never got selected. Treat checkbox AND radio as the "check" action.
    const isCheckable = field.fieldType === "checkbox" || field.fieldType === "radio";
    const action: RecipeStep["action"] =
      field.fieldType === "select" ? "select" : isCheckable ? "check" : "fill";

    // Whether the planner wants this checkable control OFF. A planner that returns a
    // checkbox/radio with value "false"/"no"/"off"/"0" means "do NOT select it" — without
    // this, loc.check() would force-enable it (e.g. wrongly ticking "meter mounted on a pole").
    const negated = isCheckable && /^(false|no|off|0|unchecked|none)$/i.test(value.trim());
    // A negated RADIO is simply not selected — there's nothing to record, so skip it entirely.
    if (field.fieldType === "radio" && negated) return null;

    // The value actually committed (may be sanitized below if the portal rejects it as a
    // non-number); recorded so a literal step replays the value the portal accepted.
    let filledValue = value;
    const res = await safeAction(
      // The label is non-PII enough for a log line, but keep it short.
      (field.label || field.fieldType).slice(0, 40),
      async () => {
        const loc = await this.locator(field.selector);
        if (!loc) throw new Error("selector unresolved");
        if (action === "select") {
          // Native <select> first; fall back to the custom-combobox interaction for
          // styled-div dropdowns (PowerClerk "Please select...", select2, ExtJS, etc.)
          // that selectOption() can't drive.
          await selectWithFallback(this.page, loc, value);
        } else if (action === "check") {
          // Respect negation for checkboxes: uncheck rather than force-enable.
          if (negated) {
            if (typeof loc.uncheck === "function") await loc.uncheck({ timeout: 5000 }).catch(() => {});
          } else {
            await loc.check({ timeout: 5000 });
          }
        } else {
          await loc.fill(value);
          // Blur to COMMIT the value into the portal's JS model. Playwright's fill() fires
          // input+change, but some frameworks (PowerClerk's Vue) only push a field into their
          // saved model on blur — and PowerClerk autosaves per field. Without the blur the
          // value shows on screen but is never persisted, so the saved draft comes back blank.
          if (typeof loc.blur === "function") await loc.blur().catch(() => {});
          // Decimal fields (e.g. PowerClerk's "Main Service Entrance Rating (Amps)") reject
          // unit-suffixed values like "225A" with "Please enter a valid decimal number." When
          // the portal flags the value as a non-number, retry once with a bare decimal so the
          // run doesn't carry an invalid required field forward to the submit page.
          if (await hasNumericValidationError(loc)) {
            const bare = toBareNumber(value);
            if (bare && bare !== value) {
              await loc.fill(bare);
              if (typeof loc.blur === "function") await loc.blur().catch(() => {});
              filledValue = bare;
            }
          }
        }
      },
      { required: false },
    );
    // Optional fields that failed are tolerated (res.ok stays true with a message). Only
    // record a step when the action actually went through (no skip message).
    if (!res.ok) return null;
    if (res.message) return null; // optional, skipped — don't record a broken step.

    const step: RecipeStep = {
      action,
      phase: "fill",
      selector: field.selector,
      note: field.label || undefined,
    };
    if (sensitive) {
      // NEVER store the literal value of a sensitive field.
      step.sensitive = true;
      step.value = "";
      step.field = fillReq.field || undefined;
    } else if (fillReq.field) {
      // Data-bound to a project/client field — resolved at replay time.
      step.field = fillReq.field;
    } else if (action !== "check") {
      // A portal-literal value (dropdown option / fixed text) — the value the portal accepted.
      step.value = filledValue;
    }
    return step;
  }

  // Scrape VISIBLE inline-validation errors and required-but-empty fields from the current page.
  // Called after a blocked advance to explain WHY the form wouldn't move forward — portal-agnostic
  // (no per-portal selectors): it reads the common validation-message patterns (ASP.NET MVC
  // field-validation, Bootstrap invalid-feedback, aria-invalid, role=alert, "* This field is
  // required" text) plus any [required]/[aria-required] control whose value is empty. Returns a
  // de-duplicated list of short, human-readable blocker descriptions ("Schedule: This field is
  // required"). Best-effort: returns [] on any failure so it can never break the run.
  private async collectValidationErrors(): Promise<string[]> {
    if (!this.page || typeof this.page.evaluate !== "function") return [];
    try {
      const raw: string[] = await this.page.evaluate(() => {
        const out: string[] = [];
        const seen = new Set<string>();
        const push = (s: string) => {
          const t = (s || "").replace(/\s+/g, " ").trim().slice(0, 120);
          if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
        };
        const isVisible = (el: Element): boolean => {
          const he = el as HTMLElement;
          const s = getComputedStyle(he);
          if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
          const r = he.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        // Nearest field label for a validation message / control, so the blocker is identifiable.
        const labelNear = (el: Element): string => {
          // A labelled ancestor group (PowerClerk wraps each field in a .form-group with a <label>).
          const group = el.closest(".form-group, .field, .form-field, .mb-3, fieldset, [class*='field']");
          const lbl = group?.querySelector("label");
          if (lbl?.textContent) return lbl.textContent.replace(/\s+/g, " ").trim().slice(0, 60);
          const id = (el as HTMLElement).id;
          if (id) {
            const forLbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (forLbl?.textContent) return forLbl.textContent.replace(/\s+/g, " ").trim().slice(0, 60);
          }
          return "";
        };
        // 1) Explicit validation-message elements.
        const MSG_SEL = [
          ".field-validation-error", ".validation-summary-errors li", ".invalid-feedback",
          ".text-danger", ".error-message", ".help-block.error", "[role='alert']",
          "[class*='error']:not(input):not(select)", "[class*='invalid']:not(input):not(select)",
        ].join(", ");
        document.querySelectorAll(MSG_SEL).forEach((el) => {
          const txt = (el.textContent || "").trim();
          if (!txt || txt.length > 200 || !isVisible(el)) return;
          // Ignore decorative containers that hold no actual message text.
          if (!/[a-z]/i.test(txt)) return;
          const lab = labelNear(el);
          push(lab ? `${lab}: ${txt}` : txt);
        });
        // 2) aria-invalid / required-but-empty controls (catches a blank required field even when
        //    the portal hasn't rendered a message yet).
        document.querySelectorAll("input, select, textarea").forEach((el) => {
          const he = el as HTMLInputElement;
          const type = (he.getAttribute("type") || "").toLowerCase();
          if (type === "hidden" || !isVisible(el)) return;
          const ariaInvalid = he.getAttribute("aria-invalid") === "true";
          const required = he.hasAttribute("required") || he.getAttribute("aria-required") === "true";
          const empty = type === "checkbox" || type === "radio"
            ? false // checkable required state is handled by the message scan above
            : !String(he.value || "").trim();
          if (ariaInvalid || (required && empty)) {
            const lab = labelNear(el) || he.getAttribute("name") || he.getAttribute("placeholder") || "field";
            push(`${lab}: ${ariaInvalid ? "invalid value" : "required field is empty"}`);
          }
        });
        return out.slice(0, 20);
      });
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  // Read each just-filled control back and confirm it still HOLDS a value before we advance.
  // The goal is catching the "silently blanked" failure mode (Vue/React rejected the fill, an
  // overlay ate it, autosave wiped it), not exact-value correctness — so the check is "is it
  // still non-empty / in the expected checked state". A control that came back empty gets one
  // re-apply attempt; a REQUIRED field that still won't hold is returned so the caller can
  // surface it. Best-effort: an unreadable control is treated as fine (never block on it).
  private async verifyFillsLanded(applied: AppliedFill[]): Promise<string[]> {
    const misses: string[] = [];
    for (const a of applied) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const loc = (await this.locator(a.selector)) as any;
      if (!loc) continue;
      if (await this.fieldHoldsValue(loc, a)) continue;

      // One re-apply attempt. Sensitive fields are never retyped here (we don't keep the
      // literal); select fields go back through the combobox fallback.
      try {
        if (a.sensitive || !a.expected) {
          // nothing to retype — fall through to the re-check
        } else if (a.fieldType === "select") {
          await selectWithFallback(this.page!, loc, a.expected);
        } else if (a.fieldType === "checkbox" || a.fieldType === "radio") {
          if (/^(true|yes|on|1)$/i.test(a.expected) && typeof loc.check === "function") await loc.check({ timeout: 5000 });
        } else if (typeof loc.fill === "function") {
          await loc.fill(a.expected, { timeout: 5000 });
          if (typeof loc.blur === "function") await loc.blur().catch(() => {});
        }
      } catch { /* re-apply is best-effort */ }

      if (!(await this.fieldHoldsValue(loc, a)) && a.required) misses.push(a.label);
    }
    return misses;
  }

  // True when the control still holds a value consistent with what we filled. For text/select
  // that means non-empty (and not a "please select" placeholder); for checkbox/radio it means
  // the checked state matches the intended boolean. Unreadable → treated as held (don't block).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async fieldHoldsValue(loc: any, a: AppliedFill): Promise<boolean> {
    try {
      if (a.fieldType === "checkbox" || a.fieldType === "radio") {
        if (typeof loc.isChecked !== "function") return true;
        const want = /^(true|yes|on|1)$/i.test(a.expected);
        const isChecked = await loc.isChecked().catch(() => false);
        return Boolean(isChecked) === want;
      }
      if (typeof loc.inputValue !== "function") return true;
      const v = String((await loc.inputValue().catch(() => "")) ?? "").trim();
      if (!v) return false;
      if (/^(please select|select\.\.\.|-- ?select|choose)/i.test(v)) return false;
      // When we have the literal we filled, a non-empty value that matches is best; but a
      // non-empty value that DIFFERS is still "filled" (the portal may reformat dates/numbers),
      // so we only treat truly-empty as a miss. readbackMatches is used opportunistically.
      if (a.expected) return v.length > 0 || readbackMatches(v, a.expected);
      return v.length > 0;
    } catch {
      return true;
    }
  }

  // A button is off-limits if its label/selector text matches a pay/fee/checkout keyword.
  private isOffLimitsButton(field: ExtractedField): boolean {
    const sel = field.selector;
    return isPayFee(field.label) || isPayFee(sel?.name) || isPayFee(sel?.text);
  }

  // Scrape visible label/value pairs on the review screen. Delegates to the shared
  // utility in reviewScreenScraper.ts so the same logic serves all adapters.
  private async scrapeReviewScreen(): Promise<LearnResult["reviewScreen"]> {
    if (!this.page) return { fields: [], bodyTextSnippet: "" };
    const fields = await scrapeReviewScreenShared(this.page);
    const rawBody = await this.page.locator("body").innerText().catch(() => "");
    const bodyTextSnippet = (redactStatusText(String(rawBody)) ?? "").slice(0, 2000);
    return { fields, bodyTextSnippet };
  }

  // --- PortalAdapter interface (minimal — learn() is the real entrypoint) ---
  async openSubmission(_project: ProjectRecord): Promise<PortalStepResult> {
    return { ok: true, message: "AutoLearnAdapter learns via learn(); openSubmission is a no-op." };
  }
  async fillApplication(_project: ProjectRecord): Promise<PortalStepResult> {
    return { ok: true, message: "AutoLearnAdapter learns via learn(); fillApplication is a no-op." };
  }
  async uploadFiles(_project: ProjectRecord, _files: string[]): Promise<PortalStepResult> {
    return { ok: true, message: "AutoLearnAdapter learns via learn(); uploads are not automated during learning." };
  }
  async stopAtReview(): Promise<PortalStepResult> {
    return {
      ok: true,
      message: `${HUMAN_REVIEW_MESSAGE} AutoLearnAdapter never clicks final submit; the learned recipe stops at review.`,
      data: { finalSubmitClicked: false },
    };
  }
  async captureSubmissionConfirmation(): Promise<PortalStepResult> {
    return { ok: true, message: "Capture the confirmation number manually after the human submits." };
  }

  // Dismiss common modal/popup/banner overlays so they can't intercept clicks.
  // Covers: PowerClerk "What's new?" popover → "Got it", its semi-transparent backdrop,
  // Bootstrap/Vue popovers + their close buttons, cookie banners, generic close buttons.
  // Loops up to 3 times (back-to-back modals) and falls back to Escape for popovers with no
  // matched button. Best-effort: never throws.
  private async dismissModals(): Promise<void> {
    if (!this.page) return;
    // Match dismiss controls whether they're <button>, <a>, or .btn (PowerClerk uses
    // Bootstrap .btn links/buttons), so a "Got it"/"Close" link is caught too.
    const clickable = ":is(button, a, .btn, [role=button])";
    const dismissSelectors = [
      // PowerClerk cookie-consent banner — a high z-index (999999) "shadow-lg border"
      // floating div that covers the bottom of the page (where the wizard "Next" button
      // sits), intercepting the click. Dismiss it by its specific Close button.
      '#cpr-banner-dimiss-btn',
      '[id*="cpr-banner"][id*="dismiss"]',
      '[id*="cookie"] [class*="dismiss"], [class*="cookie-banner"] [aria-label="Close"]',
      // PowerClerk "What's new?" popover
      `${clickable}:has-text("Got it")`,
      `${clickable}:has-text("Got It")`,
      // Bootstrap/Vue popover + modal close controls (PowerClerk uses these).
      '.popover-header button',
      '.popover .btn-close',
      '.modal .btn-close',
      '.btn-close',
      '[aria-label="Close"]',
      '[aria-label="close"]',
      '[class*="modal"] [class*="close"]',
      '[class*="popover"] [class*="close"]',
      // Accela ACA (ExtJS): window/dialog close tools (.x-tool-close is the ExtJS close icon)
      '.x-tool-close',
      '.x-window-header-right .x-tool',
      '[class*="x-window"] [class*="close"]',
      `${clickable}:has-text("Dismiss")`,
      `${clickable}:has-text("Close")`,
      // Cookie consent
      `${clickable}:has-text("Accept All")`,
      `${clickable}:has-text("Accept")`,
      `${clickable}:has-text("OK")`,
      // Generic "×" close
      `${clickable}:has-text("×")`,
      '[role="dialog"] button',
    ];
    for (let attempt = 0; attempt < 3; attempt++) {
      let dismissed = false;
      for (const sel of dismissSelectors) {
        try {
          const loc = this.page.locator(sel).first();
          if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
            await loc.click({ timeout: 2000 }).catch(() => null);
            await smartWait(this.page, 400);
            dismissed = true;
            break;
          }
        } catch { /* non-fatal */ }
      }
      // Fallback: a lingering backdrop/popover with no matched button — press Escape.
      if (!dismissed) {
        const backdrop = await this.page
          .locator('.modal-backdrop, [class*="backdrop"], div.position-absolute.opacity-50.bg-black, .popover')
          .first().count().catch(() => 0);
        if (backdrop > 0) {
          try { await this.page.keyboard?.press?.("Escape"); } catch { /* no keyboard (mock) */ }
          await smartWait(this.page, 300);
          dismissed = true; // loop once more to confirm it cleared
        }
      }
      if (!dismissed) break;
    }
  }

  // GENERIC overlay breaker for UNKNOWN portals. Given the locator we're trying to click,
  // find the element actually sitting at its center point (document.elementFromPoint). When
  // a click times out the target is, by definition, covered — so that hit element is an
  // interceptor. Walk up from it and disable pointer-events on any positioned (fixed/absolute/
  // sticky) and/or high-z-index and/or large-area ancestor (popover, modal, backdrop, cookie/
  // announcement banner, loading mask). pointer-events:none lets the click fall through to the
  // real control beneath without removing portal content. No portal-specific selectors needed.
  // Returns true if it neutralized at least one element. Best-effort; never throws.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async neutralizeInterceptor(loc: any): Promise<boolean> {
    if (!this.page || typeof this.page.evaluate !== "function") return false;
    try {
      const box = await loc.boundingBox?.().catch(() => null);
      if (!box) return false;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      return await this.page.evaluate(
        ({ x, y }: { x: number; y: number }) => {
          const hit = document.elementFromPoint(x, y) as HTMLElement | null;
          if (!hit || hit === document.body || hit === document.documentElement) return false;
          const vw = window.innerWidth, vh = window.innerHeight;
          let el: HTMLElement | null = hit;
          let neutralized = false;
          for (let i = 0; el && i < 6 && el !== document.body; i++) {
            const s = getComputedStyle(el);
            const z = parseInt(s.zIndex || "0") || 0;
            const r = el.getBoundingClientRect();
            const bigArea = r.width * r.height > vw * vh * 0.12;
            const positioned = s.position === "fixed" || s.position === "absolute" || s.position === "sticky";
            // Overlay signature: a positioned element that's either stacked above content
            // (z-index) or covers a large slice of the viewport (modal/banner/backdrop).
            if (positioned && (z >= 10 || bigArea)) {
              el.style.setProperty("pointer-events", "none", "important");
              neutralized = true;
            }
            el = el.parentElement;
          }
          return neutralized;
        },
        { x, y },
      );
    } catch {
      return false;
    }
  }

  // Click that survives a modal/popover overlay intercepting pointer events. Works for
  // both PowerClerk (Vue backdrop) and Accela (ExtJS .x-mask page-wide loading masks).
  // Strategy per attempt: dismiss modals → clear overlays → wait for visible → scroll into
  // view → click. Falls back to force-click (bypasses coverage check) then dispatchEvent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async clickResilient(loc: any): Promise<void> {
    const dbg = process.env.AUTOLEARN_DEBUG === "1";
    let lastErr: unknown;
    // Capture the URL + tab count BEFORE clicking. On slow ExtJS/AJAX portals (Accela) a
    // click can actually land and navigate even though Playwright reports a click timeout;
    // the target element then vanishes (count=0) and naive retries thrash a gone element and
    // ultimately throw "failed" — despite the navigation having succeeded. After any failed
    // attempt we check whether the page moved (URL changed or a new tab opened) and, if so,
    // treat the click as successful.
    const preClickUrl = (this.page && typeof this.page.url === "function") ? String(this.page.url() ?? "") : "";
    const preClickTabs = this.tabCount();
    for (let attempt = 0; attempt < 4; attempt++) {
      // clearOverlays BEFORE dismissModals: PowerClerk's onboarding popover is removed by
      // clearOverlays, but if dismissModals runs first it clicks the popover's "Got it"
      // button, which consumes the gesture / soft-re-renders the toolbar and leaves the
      // subsequent navigate click registering without navigating. Clearing the popover
      // first means dismissModals has no stray "Got it" to click. (Proven on live PGE.)
      await this.clearOverlays();
      await this.dismissModals();
      // Wait for the element to be visible before clicking. On Accela/ExtJS this is critical:
      // the ExtJS loading mask clears asynchronously; the link exists in the DOM but isn't
      // actionable until the mask is fully gone. Give the first attempt extra time (12s) so
      // slow AJAX dashboard renders don't fail immediately.
      await waitForElement(loc, attempt === 0 ? 12000 : 6000);
      // Scroll into viewport — elements below the fold are not clickable until scrolled.
      try { await loc.scrollIntoViewIfNeeded?.({ timeout: 2000 }); } catch { /* off-screen or mock — ignore */ }
      if (dbg) {
        const cnt = await loc.count?.().catch(() => "?");
        const vis = await loc.isVisible?.().catch(() => "?");
        console.error(`[clickResilient] attempt ${attempt}: count=${cnt} visible=${vis}`);
      }
      try {
        // Longer timeout (8s) to survive Accela's slow AJAX actionability transition.
        await loc.click({ timeout: 8000 });
        if (dbg) console.error(`[clickResilient] attempt ${attempt}: CLICK OK`);
        return;
      } catch (err) {
        lastErr = err;
        if (dbg) console.error(`[clickResilient] attempt ${attempt}: FAIL ${(err as Error).message.split("\n")[0]}`);
        // Did the click actually navigate despite the reported timeout? (common on slow
        // ExtJS portals). If the URL changed or a new tab opened, the click succeeded —
        // stop retrying a now-vanished element.
        await smartWait(this.page!, 500);
        const nowUrl = (this.page && typeof this.page.url === "function") ? String(this.page.url() ?? "") : "";
        if ((nowUrl && nowUrl !== preClickUrl) || this.tabCount() > preClickTabs) {
          if (dbg) console.error(`[clickResilient] attempt ${attempt}: click navigated despite timeout — treating as success`);
          return;
        }
        // GENERIC interception breaker (works on UNKNOWN portals): a timed-out click means
        // something is covering the target. Find whatever element is actually at the
        // target's center and neutralize that overlay (pointer-events:none on its positioned/
        // high-z ancestors) so the next click reaches the real control — without needing to
        // know the overlay's class/id. This is what makes new portals' popovers, cookie
        // banners, announcement modals, and masks non-blocking the first time we meet them.
        const broke = await this.neutralizeInterceptor(loc);
        if (dbg && broke) console.error(`[clickResilient] attempt ${attempt}: neutralized an interceptor`);
        try { await this.page!.keyboard?.press?.("Escape"); } catch { /* no keyboard (mock) */ }
        await smartWait(this.page!, 600);
      }
    }
    // Fallback 1: force-click — bypasses Playwright's coverage/actionability check. Useful
    // when a transparent or zero-opacity overlay still passes the CSS pointer-events rule but
    // Playwright's hit-test sees it as an interception (Accela overlays sometimes do this).
    try {
      await this.clearOverlays();
      await loc.click({ force: true, timeout: 4000 });
      if (dbg) console.error(`[clickResilient] force-click OK`);
      return;
    } catch (e) { if (dbg) console.error(`[clickResilient] force-click FAIL ${(e as Error).message.split("\n")[0]}`); }
    // Fallback 2: synthetic JS click — works for <a href> navigation links on any portal.
    try {
      await this.clearOverlays();
      await loc.dispatchEvent("click");
      if (dbg) console.error(`[clickResilient] dispatchEvent OK`);
      return;
    } catch (e) { if (dbg) console.error(`[clickResilient] dispatchEvent FAIL ${(e as Error).message.split("\n")[0]}`); }
    throw lastErr instanceof Error ? lastErr : new Error("clickResilient: click failed after retries");
  }

  // Wait for a page transition to COMPLETE after a navigate/advance click. PowerClerk (and
  // similar SPAs) take several seconds to create the new project / load the next form page;
  // smartWait alone returns on the still-current page, so the loop would re-scrape the stale
  // transitioning page. Wait for the URL to change (navigation) OR the network to settle,
  // then let the destination render — so the next iteration scrapes the REAL next page.
  // `tabsBefore` is the open-tab count captured by the CALLER *before* the click (the popup
  // can open during the click, i.e. before this method runs), so we can early-break the wait
  // the moment a new tab appears instead of burning the full 12s deadline on the dead tab.
  private async waitAfterClick(beforeUrl: string, beforeFp = "", tabsBefore = this.tabCount()): Promise<void> {
    if (!this.page) return;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      await sleep(350);
      // A new tab opened → the next step rendered in a popup; stop waiting and adopt it.
      if (this.tabCount() > tabsBefore) break;
      const u = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
      if (u && u !== beforeUrl) break; // URL navigation (new page)
      // Same-URL SPA wizard: wait until the page content actually changes (the next step
      // rendered) so we don't re-scrape the stale current step.
      if (beforeFp) {
        const fp = await this.pageFingerprint();
        if (fp && fp !== beforeFp) break;
      }
    }
    // If the click spawned a NEW tab (the real form), switch this.page to it BEFORE settling.
    // adoptPopupIfAny only moves FORWARD (to a higher-index tab), so a later in-form advance
    // can never switch back to the still-open dashboard tab.
    await this.adoptPopupIfAny();
    // Let the destination settle (domcontentloaded + a networkidle race), then a short dwell
    // so client-rendered form fields are present before the next scrape.
    await this.page.waitForLoadState?.("domcontentloaded", { timeout: 9000 }).catch(() => null);
    await Promise.race([
      this.page.waitForLoadState?.("networkidle", { timeout: 6000 }).catch(() => null),
      sleep(6000),
    ]);
    await sleep(700);
  }

  // Count open tabs in the browser context (1 when there's no context, e.g. a mock page).
  private tabCount(): number {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx: any = this.opened?.context;
      return typeof ctx?.pages === "function" ? ctx.pages().length : 1;
    } catch { return 1; }
  }

  // PowerClerk (and several portals) open the "Start/Create Application" form in a NEW TAB.
  // When that happens the original page (this.page) never navigates, so the learn loop would
  // keep re-scraping the dead dashboard until the stuck-guard bails ("nothing fillable on N
  // pages"). Switch this.page to the newest SAME-ORIGIN tab that is NEWER (higher index in the
  // context's page list) than the current one. Moving only forward means a later in-form
  // advance can never switch BACK to the still-open dashboard tab (a lower index), and a
  // same-origin filter means an external help/docs popup is never mistaken for the form.
  // Best-effort; never throws.
  private async adoptPopupIfAny(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx: any = this.opened?.context;
      if (!ctx || typeof ctx.pages !== "function" || !this.page) return;
      const current = this.page;
      let currentHost = "";
      try { currentHost = new URL(String(current.url?.() ?? "")).host; } catch { currentHost = ""; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pages: any[] = ctx.pages().filter((p: any) => {
        try { return !(typeof p.isClosed === "function" && p.isClosed()); } catch { return true; }
      });
      const curIdx = pages.indexOf(current); // -1 if the current tab was closed
      // Walk newest → oldest; only adopt a tab strictly NEWER than the current one.
      for (let i = pages.length - 1; i > curIdx; i--) {
        const p = pages[i];
        if (p === current) continue;
        let u = "";
        try { u = String(p.url?.() ?? ""); } catch { u = ""; }
        if (!u || u === "about:blank") continue;
        let host = ""; try { host = new URL(u).host; } catch { host = ""; }
        if (currentHost && host && host !== currentHost) continue; // skip external popups
        try { await p.bringToFront?.(); } catch { /* ignore */ }
        try { await p.waitForLoadState?.("domcontentloaded", { timeout: 9000 }); } catch { /* ignore */ }
        this.page = p;
        if (process.env.AUTOLEARN_DEBUG === "1") console.error(`[auto-learn] adopted new tab (${host})`);
        return;
      }
    } catch { /* non-fatal — mock page or no context */ }
  }

  // A cheap content fingerprint used to detect when a same-URL SPA wizard has advanced to
  // the next step (input count + the step heading + body length). Not a security hash —
  // just "did the page meaningfully change". Returns "" on a mock/no-DOM page.
  private async pageFingerprint(): Promise<string> {
    if (!this.page || typeof this.page.evaluate !== "function") return "";
    try {
      return await this.page.evaluate(() => {
        const inputs = document.querySelectorAll("input, select, textarea").length;
        const heading = (document.querySelector("h1, h2, legend, .wizard-step.active, .active")?.textContent || "").trim().slice(0, 50);
        return `${location.href}|${inputs}|${heading}|${(document.body?.innerText || "").length}`;
      });
    } catch {
      return "";
    }
  }

  // Remove stubborn overlay SCRIMS that intercept pointer events but aren't dismissible by a
  // button — covers PowerClerk (Bootstrap/Vue semi-transparent backdrop), Accela ACA
  // (ExtJS .x-mask / #divGlobalCover page-wide loading masks), and generic jQuery UI / BlockUI
  // overlays. Scoped to backdrop/scrim selectors only — never removes form fields or modal
  // content, just the transparent layer on top. Best-effort; never throws.
  // Loader/spinner selectors that indicate the SPA is still fetching this step's content.
  // Covers PowerClerk's `.loader`, generic Bootstrap/jQuery spinners, ExtJS load masks, and
  // blockUI. We WAIT for these to clear (not remove them — removing a loader doesn't make the
  // data arrive) before trusting a "no fillable fields" read of the page.
  private static readonly LOADER_SEL = ".loader, .loading, [class*='loading-'], [class*='spinner'], .spinner-border, .x-mask-loading, [id*='loadingMask'], [id*='LoadingMask'], .blockUI.blockOverlay, [aria-busy='true']";

  // True if any known loader/spinner is currently visible on the page. Best-effort.
  private async hasVisibleLoader(): Promise<boolean> {
    if (!this.page || typeof this.page.locator !== "function") return false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const loc = this.page.locator(AutoLearnAdapter.LOADER_SEL) as any;
      if (!loc || typeof loc.count !== "function" || typeof loc.nth !== "function") return false;
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 8); i++) {
        if (await loc.nth(i).isVisible?.().catch(() => false)) return true;
      }
    } catch { /* mock/no DOM — treat as not loading */ }
    return false;
  }

  // Poll until no loader/spinner is visible (the async form has rendered) or we time out.
  // Returns fast when nothing is loading; bounded so a perpetually-"busy" SPA can't hang us.
  private async waitForContentLoaders(timeoutMs = 12000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!(await this.hasVisibleLoader())) return;
      await sleep(400);
    }
  }

  private async clearOverlays(): Promise<void> {
    if (!this.page || typeof this.page.evaluate !== "function") return;
    try {
      await this.page.evaluate(() => {
        const sel = [
          // PowerClerk (Bootstrap/Vue): semi-transparent position-absolute loading scrims
          "div.position-absolute.opacity-50.bg-black",
          ".modal-backdrop",
          // PowerClerk "new feature" onboarding popover — a Bootstrap popover (z-index 900)
          // anchored ON the toolbar buttons (e.g. "New Net Metering Application"), so its
          // header overlaps and intercepts the click. The backdrop above is removed but the
          // popover itself must be too, or every navigate click is intercepted. It has a
          // sequence of "Got it" steps, so clicking-through is unreliable — just remove it.
          ".popover.new-feature-popper",
          ".new-feature-popper",
          // Generic loading/spinner overlays
          "[class*='loading-overlay']",
          "[class*='spinner-overlay']",
          // Accela ACA (ExtJS): page-wide loading masks that cover ALL content during AJAX
          ".x-mask",
          ".x-mask-loading",
          // Accela-specific global cover divs
          "#divGlobalCover",
          "#divProgress",
          ".ACA_Loading",
          // ExtJS/Accela pattern: any div whose ID contains "loadingMask" or "Loading"
          "[id*='loadingMask']",
          "[id*='LoadingMask']",
          // jQuery BlockUI / jQuery UI overlay (used by some Accela modules)
          ".blockUI",
          ".ui-widget-overlay",
          ".ui-blocker",
        ].join(", ");
        // Remove any scrims present right now...
        document.querySelectorAll(sel).forEach((el) => el.remove());
        // ...AND inject a persistent rule so RE-RENDERED scrims (PowerClerk's Vue re-adds its
        // loading backdrop reactively; Accela's ExtJS re-renders masks on each AJAX call)
        // can't intercept clicks. pointer-events:none lets clicks pass through to the real control.
        if (!document.getElementById("__autolearn_scrim_bypass")) {
          const style = document.createElement("style");
          style.id = "__autolearn_scrim_bypass";
          style.textContent = sel + " { pointer-events: none !important; }";
          document.head.appendChild(style);
        }
      });
    } catch { /* mock page or no DOM — non-fatal */ }
  }

  // Build a Playwright locator for a single selector descriptor (no fallback chain).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _buildLocator(page: Page, sel: RecipeSelector): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scope: any = sel.frame ? page.frameLocator(`iframe[name="${sel.frame}"]`) : page;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let loc: any;
    if (sel.role && sel.name) loc = scope.getByRole(sel.role, { name: sel.name, exact: sel.exact ?? false });
    else if (sel.label) loc = scope.getByLabel(sel.label, { exact: sel.exact });
    else if (sel.placeholder) loc = scope.getByPlaceholder(sel.placeholder, { exact: sel.exact });
    else if (sel.testId) loc = scope.getByTestId(sel.testId);
    else if (sel.text) loc = scope.getByText(sel.text, { exact: sel.exact });
    else if (sel.css) loc = scope.locator(sel.css);
    else if (sel.role) loc = scope.getByRole(sel.role);
    else throw new Error("AutoLearn selector has no usable strategy.");
    return typeof sel.nth === "number" ? loc.nth(sel.nth) : loc.first();
  }

  // Resolve a selector descriptor to the first locator that has ≥1 matching element on
  // the current page. Tries the primary strategy first, then each fallback in order.
  // Returns null when the page is unavailable or no strategy finds the element.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async locator(sel?: RecipeSelector): Promise<any | null> {
    if (!sel || !this.page) return null;
    const primary = this._buildLocator(this.page, sel);
    if ((await primary.count().catch(() => 0)) > 0) return primary;
    for (const fb of sel.fallbacks ?? []) {
      try {
        const loc = this._buildLocator(this.page, fb);
        if ((await loc.count().catch(() => 0)) > 0) return loc;
      } catch { /* bad fallback selector — skip */ }
    }
    // Return the primary even if empty — the caller's waitFor will surface a clear timeout.
    return primary;
  }
}
