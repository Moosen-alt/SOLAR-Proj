import fs from "fs";
import path from "path";
import type { Page } from "playwright";
import type { ProjectRecord, RecipeSelector, RecipeStep } from "../../../shared/src/types";
import { BasePortalAdapter, HUMAN_REVIEW_MESSAGE, type PortalContext, type PortalStepResult } from "../adapter";
import { openPortal } from "../browser";
import { fillCustomCombobox, selectWithFallback } from "../comboboxFill";
import { detectChallengeFrame, readbackMatches, redactStatusText, safeAction, sleep, smartWait, waitForElement } from "../safeAction";
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
  /** For <a> nav links: the href, so a hidden/menu-nested link that can't be clicked can
   *  still be reached by navigating to it directly. */
  href?: string;
  /** True when the field has the HTML required attribute — used by gap-fill to report
   *  fields the planner had no data for. */
  required?: boolean;
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
  /** Base64 PNG screenshot taken when the review/confirm page is reached. */
  reviewScreenshotBase64?: string;
  /** True when the bot reached a review/confirm page. */
  reachedReview?: boolean;
  /** True when at least one fill/select/check step was recorded. */
  filledSomething?: boolean;
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
  // slow step (number climbing, then advances) from a hung one (climbing forever).
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
// summary, "click the Continue Application button below", CapConfirm URL; PowerClerk and
// similar: an accept-terms gate / "will not be submitted until" acknowledgment).
const REVIEW_MARKERS = /\bstep\s*\d+\s*:?\s*review\b|review all information|continue application button below|please review (all )?information|\(read-only\)|accept terms and conditions|will not be submitted until/i;

// Terms-acceptance / certification / acknowledgment checkboxes that gate a final submit.
// Portal-agnostic: PowerClerk "Click to Accept Terms and Conditions" + "I understand that
// my form will not be submitted until…", Accela/Salesforce "I certify/I agree" attestations.
// Used both to (a) recognize a review/submit screen and (b) auto-check these required gates
// before recording the submit. Deliberately narrow so it never matches a normal form toggle.
const ACCEPT_TERMS = /\b(accept (the )?terms|terms (and|&) conditions|i agree\b|i understand\b|i acknowledge|acknowledge that|i certify|i attest|i confirm that|agree to the)\b/i;
function looksLikeReviewUrl(url: string): boolean {
  return /capconfirm|confirm\.aspx|\/review/i.test(url || "");
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

// CSS selector used in $$eval() to extract all interactive elements from the page.
// Exported so llmGapFill.ts can reuse the same selector for consistency.
export const EXTRACT_SEL = "input, select, textarea, button, [role=button], a[href]:not([href='#']):not([href=''])";

// ---------------------------------------------------------------------------
// The DOM extraction script — runs in the page via $$eval. Pure (no closures over
// adapter state) so it can be serialized into the browser. Returns plain JSON.
// ---------------------------------------------------------------------------

export interface RawField {
  label: string;
  fieldType: ExtractedField["fieldType"];
  options?: string[];
  // Selector hints captured from the element.
  role?: string;
  name?: string;
  placeholder?: string;
  id?: string;
  css?: string;
  text?: string;
  href?: string;
  required?: boolean;
}

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
    const required = (el as HTMLInputElement).required || el.getAttribute("aria-required") === "true" || undefined;

    out.push({ label, fieldType, options, role, name, placeholder, id, text, href, required: required || undefined });
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
  if (raw.href) field.href = raw.href;
  if (raw.required) field.required = true;
  return field;
}

// The derived label equals the name attribute only — a label-based locator would then
// be unreliable, so prefer a more structural selector.
function isLikelyOnlyName(raw: RawField): boolean {
  return !!raw.name && raw.label === raw.name && !raw.placeholder;
}

// A fill we applied this page, retained so d2 can read it back and confirm the portal kept it.
interface AppliedFill {
  selector: RecipeSelector;
  label: string;
  fieldType: ExtractedField["fieldType"];
  /** Value typed (empty for sensitive fields, which are only checked for non-emptiness). */
  expected: string;
  sensitive: boolean;
  required: boolean;
}

export interface UploadSlot {
  /** A unique per-page key; the matching element is tagged with data-al-upl="<key>". */
  key: string;
  /** The human label of the upload field (e.g. "One-Line Electrical Diagram"). */
  label: string;
  /** "input" → a real <input type=file> (use setInputFiles); "browse" → a click-to-open
   *  trigger whose real input is created dynamically (use the filechooser event). */
  kind: "input" | "browse";
  /** True when the field is marked required (asterisk / required attr / aria-required). */
  required: boolean;
}

// Serializable in-page detector for document-upload controls. Runs via page.evaluate.
// Universal: handles native <input type=file> AND custom "Browse"/"Upload"/"Choose File"
// widgets (PowerClerk, Telerik/Kendo, jQuery-file-upload) whose real input is created only
// when the trigger is clicked — those never appear in the normal field scrape. Each matched
// control is tagged with a data-al-upl attribute so the adapter can locate it deterministically.
// Returns one slot per control with its derived label + required flag. Never throws.
export function tagUploadControls(): UploadSlot[] {
  const slots: UploadSlot[] = [];
  let n = 0;

  // Derive the field label for an upload control: nearest <label>, else the closest
  // form-group/row container's leading label/heading/text, else the trigger's own text.
  function deriveLabel(el: Element): string {
    const id = el.getAttribute("id");
    if (id) {
      const forLbl = document.querySelector(`label[for="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`);
      if (forLbl && forLbl.textContent && forLbl.textContent.trim()) return forLbl.textContent.trim();
    }
    const wrapLbl = el.closest("label");
    if (wrapLbl && wrapLbl.textContent && wrapLbl.textContent.trim()) return wrapLbl.textContent.trim();
    const container = el.closest('[class*="form-group"], [class*="field"], [class*="row"], li, tr, dd, p, div');
    if (container) {
      const lbl = container.querySelector("label, .control-label, .field-label, strong, b, h1, h2, h3, h4, h5, legend");
      if (lbl && lbl.textContent && lbl.textContent.trim()) return lbl.textContent.trim().replace(/\s+/g, " ");
      // Fall back to the container's leading text node (e.g. "Cut Sheets" before the Browse box).
      const own = (container.textContent || "").trim().replace(/\s+/g, " ");
      if (own) return own.slice(0, 80);
    }
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    return (el.textContent || "").trim() || "Document";
  }

  function isRequired(el: Element): boolean {
    if ((el as HTMLInputElement).required) return true;
    if (el.getAttribute("aria-required") === "true") return true;
    const container = el.closest('[class*="form-group"], [class*="field"], [class*="row"], li, tr, dd, p, div');
    const lbl = container?.querySelector("label, .control-label, .field-label");
    // PowerClerk/Bootstrap mark required with a red asterisk in/after the label text.
    if (lbl && /\*/.test(lbl.textContent || "")) return true;
    return false;
  }

  // 1) Native file inputs (even when visually hidden behind a styled Browse button).
  const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
  for (const el of fileInputs) {
    const key = `f${n++}`;
    el.setAttribute("data-al-upl", key);
    slots.push({ key, label: deriveLabel(el), kind: "input", required: isRequired(el) });
  }

  // 2) Browse/Upload/Choose-File triggers whose real input is created dynamically — these
  //    have NO file input anywhere in their container, so the scrape above missed them.
  const TRIGGER = /^(browse|upload|choose(\s+file)?|attach|add\s+file|select\s+file|choose\s+files?|upload\s+file)\.{0,3}$/i;
  const clickables = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], .btn, span[class*="upload"], span[class*="browse"]'));
  for (const el of clickables) {
    const txt = ((el as HTMLInputElement).value || el.textContent || "").trim();
    if (!TRIGGER.test(txt)) continue;
    // Guard against false positives that actually SUBMIT or NAVIGATE the wizard. A button
    // labelled "Upload" can be a page-advance action, not a file picker; clicking it derails
    // the run (and skips the review screen, so no review screenshot is ever captured). Never
    // tag a submit button, or an anchor that navigates to a real URL.
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "button" && (type === "submit" || (el as HTMLButtonElement).type === "submit")) continue;
    if (type === "submit") continue;
    if (tag === "a") {
      const href = el.getAttribute("href") || "";
      if (href && !/^#|^javascript:/i.test(href)) continue; // real navigation link — not a picker
    }
    const container = el.closest('[class*="form-group"], [class*="field"], [class*="row"], li, tr, dd, p, div, td');
    // If a real file input already lives in this container, it's covered by pass 1 — skip.
    if (container && container.querySelector('input[type="file"]')) continue;
    const key = `b${n++}`;
    el.setAttribute("data-al-upl", key);
    slots.push({ key, label: deriveLabel(el), kind: "browse", required: isRequired(el) });
  }

  return slots;
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

  // Resolve a docType for an upload control by its label only (no ExtractedField wrapper).
  private resolveUploadByLabel(label: string): { docType: string; file: string } | null {
    return this.resolveUpload({ selector: {}, label, fieldType: "file" });
  }

  // Universal upload pass. Detects every document-upload control on the current page —
  // native <input type=file> AND custom Browse/Upload widgets whose real input is created
  // only on click — attaches the matching split document, and records a replayable `upload`
  // step. Returns labels filled + the labels of REQUIRED slots we had no document for.
  // Best-effort and non-throwing: a stuck upload never aborts the learn run.
  private async performUploads(
    steps: RecipeStep[],
    alreadyFilledLabels: string[],
  ): Promise<{ filled: string[]; missingRequired: string[] }> {
    const filled: string[] = [];
    const missingRequired: string[] = [];
    if (!this.page || typeof this.page.evaluate !== "function") return { filled, missingRequired };

    let slots: UploadSlot[] = [];
    try {
      slots = await this.page.evaluate(tagUploadControls);
    } catch { return { filled, missingRequired }; }
    if (!Array.isArray(slots) || slots.length === 0) return { filled, missingRequired };

    for (const slot of slots) {
      const resolved = this.resolveUploadByLabel(slot.label);
      if (!resolved) {
        // No document for this control — never fake it. Report it if the portal requires it.
        if (slot.required) missingRequired.push(slot.label || "Required document");
        continue;
      }
      const selector: RecipeSelector = { css: `[data-al-upl="${slot.key}"]` };
      const res = await safeAction(
        `upload ${resolved.docType}`,
        async () => {
          if (slot.kind === "input") {
            // Native input — set files directly even when visually hidden behind a button.
            const loc = this.page!.locator(selector.css!);
            await loc.setInputFiles(resolved.file);
          } else {
            // Custom widget — the real <input> is created on click, so intercept the
            // browser's file-chooser dialog (works for ANY uploader, no DOM coupling).
            const [chooser] = await Promise.all([
              this.page!.waitForEvent("filechooser", { timeout: 8000 }),
              this.page!.locator(selector.css!).click({ timeout: 6000 }),
            ]);
            await chooser.setFiles(resolved.file);
          }
          await smartWait(this.page!, 500);
        },
        { required: false },
      );
      if (res.ok && !res.message) {
        steps.push({
          action: "upload",
          phase: "fill",
          selector,
          docType: resolved.docType,
          viaFileChooser: slot.kind === "browse",
          note: `upload ${resolved.docType}: ${slot.label || "document"}`,
        });
        if (slot.label) {
          filled.push(slot.label);
          alreadyFilledLabels.push(slot.label);
        }
      } else if (slot.required) {
        // Detected + required + we had a file, but the attach failed — still flag for the human.
        missingRequired.push(slot.label || "Required document");
      }
    }
    return { filled, missingRequired };
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
    // Run a 5s heartbeat for the whole learn run so the UI can tell a slow step from a hung
    // one (elapsedMs climbs, then a real event resets it). try/finally guarantees the timer is
    // cleared on every exit path — early `return fail(...)`, success, or a thrown error.
    this.startHeartbeat();
    try {
      return await this.learnImpl(context, project);
    } finally {
      this.stopHeartbeat();
    }
  }

  private async learnImpl(context: PortalContext, _project: ProjectRecord): Promise<LearnResult> {
    const steps: RecipeStep[] = [];
    const alreadyFilledLabels: string[] = [];
    let pageCount = 0;
    let finalSubmitRecorded = false;
    let reachedReview = false;
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
    // Validation blockers: collected when an advance click fails to move the page forward
    // (portal blocked the step due to required-field errors). Injected into the recovery hint
    // and surfaced in the final message so the operator can see WHICH fields the portal rejected.
    const validationBlocks: string[] = [];
    let lastValidationErrors: string[] = [];
    // Required document-upload slots we detected but had NO matching project file for —
    // surfaced in the final message so the human can attach them before submitting.
    const missingRequiredDocs: string[] = [];
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

    // Debug forensic trail — created once if AUTOLEARN_DEBUG_SCREENSHOTS=1. Writes a full-page
    // PNG before and after fills for every wizard step into data/screenshots/learn-<timestamp>/,
    // plus pNNN-plan.json / pNNN-rescan.json sidecars (see .env.example). Lets the operator see
    // exactly what the bot saw and what it changed without re-running blind. Best-effort only.
    let debugScreenshotDir: string | null = null;
    if (process.env.AUTOLEARN_DEBUG_SCREENSHOTS === "1") {
      const ts = Date.now();
      debugScreenshotDir = path.resolve(process.cwd(), "data", "screenshots", `learn-${ts}`);
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

    // Required fields that did NOT hold their value after filling (portal silently dropped them).
    // Surfaced in the final message so the operator re-checks them before a human submits.
    const fillVerifyMisses: string[] = [];

    for (let pageIdx = 0; pageIdx < this.maxPages; pageIdx++) {
      pageCount++;
      // Reset per-page label tracking so the planner sees a clean slate on each page —
      // PowerClerk reuses field labels ("Name", "Email", "Phone") across wizard steps and
      // passing stale labels from page N to page N+1 caused the planner to skip re-fills.
      alreadyFilledLabels.length = 0;

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
        const extractSel = "input, select, textarea, button, [role=button], a[href]:not([href='#']):not([href=''])";
        let raws: RawField[] = [];
        for (let tryN = 0; tryN < 4; tryN++) {
          raws = await this.page.$$eval(extractSel, extractFieldsInPage).catch(() => [] as RawField[]);
          if (raws.length > 0) break;
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
      //   - REVIEW  → has a submit-intent button (Continue Application/Submit/Finish) or
      //               review markers ("Step N: Review", "review all information", /review URL).
      //   - DASHBOARD → no inputs, no submit-intent button, no review markers → only links.
      const hasFillable = fields.some((f) => f.fieldType !== "button");
      const hasSubmitIntentBtn = fields.some((f) => f.fieldType === "button" && SUBMIT_INTENT.test(f.label));
      // A terms/certification gate checkbox is a strong, portal-agnostic review-screen signal:
      // mid-flow form pages advance with "Next/Continue", not a terminal Submit alongside an
      // "Accept Terms and Conditions" / "I certify" attestation. Only checkboxes count.
      const hasAcceptTermsCheckbox = fields.some((f) => f.fieldType === "checkbox" && ACCEPT_TERMS.test(f.label));
      const reviewSignals = REVIEW_MARKERS.test(bodyText) || looksLikeReviewUrl(url);
      const isDashboard = !hasFillable && !hasSubmitIntentBtn && !reviewSignals;
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
      // A no-input page that is NOT a dashboard is, by definition, a review page.
      // A review/submit screen takes three shapes: a no-input read-only summary; a page
      // carrying review markers + a submit button; OR a submit button gated by a terms/
      // certification checkbox (PowerClerk's final page has a live "Accept Terms" checkbox,
      // so it IS fillable — the first clause would miss it). The last shape is portal-agnostic.
      const isReviewPage =
        (!hasFillable && !isDashboard) ||
        (reviewSignals && hasSubmitIntentBtn) ||
        (hasSubmitIntentBtn && hasAcceptTermsCheckbox);
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
        // Auto-check the required terms/certification gate(s) so the recorded recipe ticks them
        // and the live submit isn't blocked. The planner often returns no fills on a review page
        // it didn't recognize, so inject them here. Only ACCEPT_TERMS checkboxes — never the
        // submit button or other toggles (e.g. an optional "alternative billing contact").
        const termsFills = fields
          .map((f, i) => ({ f, i }))
          .filter(({ f }) => f.fieldType === "checkbox" && ACCEPT_TERMS.test(f.label))
          .filter(({ i }) => !(plan.fills ?? []).some((fl) => fl.selectorIndex === i))
          .map(({ i }) => ({ selectorIndex: i, value: "true" }));
        plan = {
          ...plan,
          fills: [...(plan.fills ?? []), ...termsFills],
          atReview: true,
          advanceSelectorIndex: undefined,
          finalSubmitSelectorIndex: promotedFinal,
        };
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

        // Debug: write a JSON sidecar next to this page's screenshots showing what the bot SAW
        // (field labels) and DECIDED (each fill's bound-field/value, sensitive masked). Pair it
        // with the pNNN-before/after PNGs for the "real vs guessing" record.
        if (debugScreenshotDir) {
          const sidecar = {
            page: pageCount,
            title: pageTitle,
            url: hostPath,
            classification: cls,
            atReview: plan.atReview ?? false,
            navigateIndex: plan.navigateSelectorIndex ?? null,
            advanceIndex: plan.advanceSelectorIndex ?? null,
            finalSubmitIndex: plan.finalSubmitSelectorIndex ?? null,
            recoveryHint: recoveryHint || null,
            fieldsSeen: fields.map((f, i) => ({ i, type: f.fieldType, label: (f.label || "").slice(0, 80) })),
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
            const dest = path.join(debugScreenshotDir, `p${pageCount.toString().padStart(3, "0")}-plan.json`);
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

      // d0) UPLOAD PASS — attach the right split document to every upload control on this
      //     page. Universal: handles native <input type=file> (setInputFiles) AND custom
      //     "Browse"/"Upload"/"Choose File" widgets whose real input is created only on click
      //     (driven via the browser's filechooser event). Required slots with no matching
      //     document are reported (never faked) so the human can complete them.
      {
        const up = await this.performUploads(steps, alreadyFilledLabels);
        for (const m of up.missingRequired) if (!missingRequiredDocs.includes(m)) missingRequiredDocs.push(m);
      }

      // d) Apply the fills and record each as a RecipeStep.
      let pageFillCount = 0;
      // Fills applied this page, retained so d2 can read them back and confirm they held.
      const appliedThisPage: AppliedFill[] = [];
      for (const fillReq of plan.fills ?? []) {
        const field = fields[fillReq.selectorIndex];
        if (!field) continue; // out-of-range index from the planner — skip safely.
        if (field.fieldType === "file") continue; // handled by the upload pass above.
        const sensitive = isSensitiveLabel(field.label);
        const step = await this.applyFill(field, fillReq, sensitive);
        if (step) {
          steps.push(step);
          pageFillCount++;
          if (field.label) alreadyFilledLabels.push(field.label);
          appliedThisPage.push({
            selector: field.selector,
            label: field.label || "",
            fieldType: field.fieldType,
            expected: sensitive ? "" : (fillReq.value ?? ""),
            sensitive,
            required: !!field.required,
          });
        }
      }

      // d2) SENSITIVE-FIELD DETERMINISTIC PASS — any sensitive text field (account/meter number)
      //     already present in the initial scrape that the planner didn't fill gets bound to
      //     project data here. Restricted to text/select inputs — never checkboxes, radios, or
      //     file controls (a checkbox whose label mentions "meter" is NOT a meter-number field).
      //     Never stored with a literal value; never includes password fields (login credentials).
      for (const field of fields) {
        if (!isSensitiveLabel(field.label)) continue;
        if (/\bpassword\b|\bpasscode\b/i.test(field.label)) continue; // login credential — skip
        // Only text/select fields can hold account/meter numbers — checkboxes/radios with labels
        // that happen to contain "meter" (e.g. "Is meter mounted on a pole?") are NOT number inputs.
        // Only text/select/other can hold a number — checkbox/radio/file/button are excluded
        // by this single guard (the earlier file/button re-check was dead code: tsc flagged the
        // comparison as impossible and it broke `npm run build`).
        if (field.fieldType !== "text" && field.fieldType !== "select" && field.fieldType !== "other") continue;
        if (alreadyFilledLabels.includes(field.label)) continue;
        const syntheticFill = {
          value: "",
          field: /account/i.test(field.label) ? "accountNumber" : /meter/i.test(field.label) ? "meterNumber" : undefined,
        };
        const step = await this.applyFill(field, syntheticFill, true);
        if (step) {
          steps.push(step);
          pageFillCount++;
          if (field.label) alreadyFilledLabels.push(field.label);
          appliedThisPage.push({
            selector: field.selector,
            label: field.label || "",
            fieldType: field.fieldType,
            expected: "",
            sensitive: true,
            required: !!field.required,
          });
        }
      }

      // d3) POST-SELECTION RE-SCRAPE — conditional fields revealed by a prior fill.
      //     Many real portals progressively disclose fields: PowerClerk reveals a Schedule
      //     dropdown once Account Type = "Residential", then Account#/Meter# once a Schedule
      //     is picked; an Accela "Commercial" radio reveals Business License / Tax ID; a
      //     "Yes — battery storage" checkbox reveals battery make/model/kWh inputs. The page
      //     was scraped ONCE at entry, so the planner never saw these. After applying this
      //     page's fills, re-scrape the live DOM and fill any NEW fields that appeared —
      //     both planner-driven (text/select/checkbox/radio) and deterministic sensitive
      //     binding (account/meter). Best-effort and single-pass-with-cascade: it loops a
      //     few times so a reveal that triggers a further reveal is also caught. Never throws.
      if (pageFillCount > 0 && !plan.atReview && this.page) {
        // Deep cascades chain one reveal per pass (PowerClerk: Energy Source → Prime Mover →
        // Type → Energy Storage → the PV equipment repeater — 5+ levels), so allow enough
        // passes to walk the whole chain. Cheap pages still exit immediately via the
        // converged/no-new-fields breaks below, so this only costs time when reveals keep coming.
        const MAX_RESCAN_PASSES = 6;
        for (let rescanPass = 0; rescanPass < MAX_RESCAN_PASSES; rescanPass++) {
          let revealedThisPass = 0;
          try {
            // Wait for the AJAX that ENABLES + POPULATES the next dependent control to land
            // before scraping — a flat sleep raced it, so the just-revealed <select> scraped
            // empty/disabled and the planner had no options to choose. Then clear any overlay.
            await this.waitForDynamicFieldsSettle();
            await this.clearOverlays();
            const raws2 = await this.page
              .$$eval(EXTRACT_SEL, extractFieldsInPage)
              .catch(() => [] as RawField[]);
            const postFields = raws2.map(toExtractedField);
            const newFillable = postFields.filter(
              (f) =>
                f.fieldType !== "button" &&
                f.fieldType !== "file" &&
                f.label &&
                !alreadyFilledLabels.includes(f.label),
            );
            if (newFillable.length === 0) break; // nothing new appeared — done cascading.

            // Re-derive the page text so the planner reasons over the post-reveal content.
            let postBodyText = bodyText;
            try {
              const rawBody2 = await this.page.evaluate(() => (document.body?.innerText ?? "")).catch(() => "");
              postBodyText = (redactStatusText(String(rawBody2)) ?? "").slice(0, 2000);
            } catch { /* keep the original snippet */ }

            // Ask the planner to fill the newly-visible NON-sensitive fields. Pass the full
            // postFields list so selectorIndex math is correct; alreadyFilledLabels makes it
            // skip fields already handled this page.
            let postPlan: LearnPlanResponse = { fills: [], atReview: false };
            try {
              postPlan = await this.planner({
                url,
                pageTitle,
                fields: postFields,
                bodyText: postBodyText,
                alreadyFilledLabels,
                isDashboard: false,
              });
            } catch { /* planner failure is non-fatal for the re-scrape pass */ }

            for (const fillReq of postPlan.fills ?? []) {
              const field = postFields[fillReq.selectorIndex];
              if (!field) continue;
              if (field.fieldType === "button" || field.fieldType === "file") continue;
              if (isSensitiveLabel(field.label)) continue; // handled by the deterministic pass below
              if (field.label && alreadyFilledLabels.includes(field.label)) continue;
              const step = await this.applyFill(field, fillReq, false);
              if (step) {
                steps.push(step);
                pageFillCount++;
                revealedThisPass++;
                if (field.label) alreadyFilledLabels.push(field.label);
                appliedThisPage.push({
                  selector: field.selector,
                  label: field.label || "",
                  fieldType: field.fieldType,
                  expected: fillReq.value ?? "",
                  sensitive: false,
                  required: !!field.required,
                });
              }
            }

            // Deterministic sensitive binding for newly-revealed account/meter fields. The
            // planner never receives these values, so it can't fill them — bind from project
            // data. Restricted to text/select inputs; never password/login credentials.
            for (const nf of postFields) {
              if (!isSensitiveLabel(nf.label)) continue;
              if (/\bpassword\b|\bpasscode\b/i.test(nf.label)) continue;
              if (nf.fieldType !== "text" && nf.fieldType !== "select" && nf.fieldType !== "other") continue;
              if (alreadyFilledLabels.includes(nf.label)) continue;
              const syntheticFill = {
                value: "",
                field: /account/i.test(nf.label) ? "accountNumber" : /meter/i.test(nf.label) ? "meterNumber" : undefined,
              };
              const step = await this.applyFill(nf, syntheticFill, true);
              if (step) {
                steps.push(step);
                pageFillCount++;
                revealedThisPass++;
                if (nf.label) alreadyFilledLabels.push(nf.label);
                appliedThisPage.push({
                  selector: nf.selector,
                  label: nf.label || "",
                  fieldType: nf.fieldType,
                  expected: "",
                  sensitive: true,
                  required: !!nf.required,
                });
              }
            }

            // Debug: dump what appeared after the reveal so the operator can audit it.
            if (debugScreenshotDir) {
              try {
                const dest = path.join(
                  debugScreenshotDir,
                  `p${pageCount.toString().padStart(3, "0")}-rescan${rescanPass + 1}.json`,
                );
                fs.writeFileSync(dest, JSON.stringify({
                  page: pageCount,
                  pass: rescanPass + 1,
                  title: pageTitle,
                  revealedFields: newFillable.map((f) => (f.label || "?").slice(0, 80)),
                  filledThisPass: revealedThisPass,
                }, null, 2));
              } catch { /* non-fatal */ }
            }

            // Let the portal autosave the conditional-field fills before re-scanning again.
            if (revealedThisPass > 0 && typeof this.page?.waitForLoadState === "function") {
              await this.page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => null);
            }
          } catch { /* post-selection re-scrape is best-effort — never break the loop */ }
          if (revealedThisPass === 0) break; // converged — no further reveals to chase.
        }
      }

      // d1) PERSIST SETTLE (ADAPTIVE). Portals like PowerClerk autosave each page's fields via
      //     an AJAX round-trip. If we advance before that completes, the entered values are LOST
      //     (a blank draft saves). The OLD approach slept a flat 3s every page; instead we now
      //     wait for the network to go idle (which IS the autosave XHR completing) and only keep
      //     waiting while a "Saving…" indicator is actually visible — so a fast page proceeds in
      //     well under a second and a slow save is still given the time it genuinely needs.
      //     AUTOLEARN_SAVE_SETTLE_MS (default 800) is just the final commit buffer.
      if (pageFillCount > 0) {
        const settleNetwork = async (timeout: number) => {
          if (typeof this.page?.waitForLoadState === "function") {
            await this.page.waitForLoadState("networkidle", { timeout }).catch(() => null);
          }
        };
        await settleNetwork(8000);
        await this.waitForAutosaveIndicator(4000);
        const settleMs = Number(process.env.AUTOLEARN_SAVE_SETTLE_MS) || 800;
        await sleep(settleMs);

        // Debug: capture the page AFTER fills have settled so it can be compared with "before".
        await saveDebugShot(`p${pageCount.toString().padStart(3, "0")}-after-${(pageTitle || "page").replace(/\s+/g, "_").slice(0, 40)}`);
      }

      // d4) VERIFY THE FILLS LANDED before advancing. A portal can silently drop a fill — a
      //     Vue/React model rejects it, an overlay eats the keystrokes, inline validation clears
      //     it, or an autosave round-trip blanks it. If we advance blindly the field is gone and
      //     only resurfaces (if at all) as a blank at the review screen. Read each filled control
      //     back; re-apply once if it didn't hold; record any REQUIRED field that still won't hold
      //     its value so the operator sees exactly what to fix.
      if (appliedThisPage.length > 0) {
        const misses = await this.verifyFillsLanded(appliedThisPage);
        for (const m of misses) if (!fillVerifyMisses.includes(m)) fillVerifyMisses.push(m);
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

        // d5) POST-ADVANCE VALIDATION GUARD — did the page actually move forward?
        // When a portal blocks submission because required fields are missing or invalid,
        // the "Next" click silently stays on the same page (the URL/fingerprint doesn't change).
        // Detect this and scrape any inline error messages so the recovery hint is specific.
        {
          const advAfterUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
          const advAfterFp = await this.pageFingerprint();
          const movedForward = (advAfterUrl && advAfterUrl !== advBeforeUrl) || (!!advAfterFp && advAfterFp !== advBeforeFp);
          if (!movedForward) {
            const blockers = await this.collectValidationErrors();
            if (blockers.length > 0) {
              lastValidationErrors = blockers;
              for (const b of blockers) if (!validationBlocks.includes(b)) validationBlocks.push(b);
              // Remove the advance step we just recorded — it didn't actually work.
              if (steps.length && steps[steps.length - 1].note?.startsWith("advance:")) steps.pop();
            }
          } else {
            lastValidationErrors = [];
          }
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

    const validationWarning = validationBlocks.length > 0
      ? ` ⛔ The portal blocked an advance with ${validationBlocks.length} validation error(s) — fix before submit: ${validationBlocks.slice(0, 8).join("; ")}.`
      : "";
    const docsWarning = missingRequiredDocs.length > 0
      ? ` 📎 ${missingRequiredDocs.length} required document upload(s) had no matching project file and were left empty — attach before submit: ${missingRequiredDocs.slice(0, 8).join("; ")}.`
      : "";
    const verifyWarning = fillVerifyMisses.length > 0
      ? ` ⚠ ${fillVerifyMisses.length} required field(s) did not hold their value after filling and may be blank in the portal: ${fillVerifyMisses.slice(0, 12).join(", ")}${fillVerifyMisses.length > 12 ? ", …" : ""}. Re-check these before submit.`
      : "";
    const message = reachedReview
      ? `${HUMAN_REVIEW_MESSAGE} Auto-learn reached the review screen after ${pageCount} page(s). Verify every field/value below before a human submits.${validationWarning}${docsWarning}${verifyWarning}`
      : filledSomething
        ? `Auto-learn filled ${pageCount} page(s) and recorded the steps, but did not reach a review screen. Page trace: ${traceLine}${validationWarning}${docsWarning}${verifyWarning}`
        : `Auto-learn found nothing fillable on ${pageCount} page(s); no steps recorded.${nothingFillableHint} Page trace: ${traceLine}${validationWarning}${docsWarning}${verifyWarning}`;

    // Capture the review page screenshot when we've reached the review screen. fullPage:true so
    // the vision verifier sees the WHOLE review — a viewport-only shot would let an off-screen
    // blank/wrong required field pass unseen. Best-effort, but a SILENT failure here is why
    // "screenshots stopped showing up in the folder" — the backend only writes data/screenshots
    // when this base64 is present. Settle the page first, retry once, and log the reason on
    // failure so a missing screenshot is diagnosable, not invisible.
    let reviewScreenshotBase64: string | undefined;
    for (let attempt = 0; attempt < 2 && !reviewScreenshotBase64; attempt++) {
      try {
        if (typeof this.page.waitForLoadState === "function") {
          await this.page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
        }
        const buf = await this.page.screenshot({ type: "png", fullPage: true });
        reviewScreenshotBase64 = buf.toString("base64");
      } catch (err) {
        if (attempt === 1) {
          console.error(`[auto-learn] ${this.portalName}: review screenshot capture failed — ${(err as Error)?.message || err}`);
        } else {
          await sleep(500);
        }
      }
    }

    return {
      ok,
      portalName: this.portalName,
      steps,
      reviewScreen,
      finalSubmitRecorded,
      pageCount,
      pauseReason: null,
      message,
      reviewScreenshotBase64,
      reachedReview,
      filledSomething,
    };
  }

  // Apply a single fill/select/check and return the RecipeStep that records it (or null
  // if the action could not be applied). Sensitive fields are recorded WITHOUT a literal
  // value (sensitive:true, value:"") and are bound by `field` instead.
  // Count enabled <select>s that already hold a REAL (non-placeholder) option. A cascading
  // dropdown is disabled with only a "Select…"/"Please select…" option until a prior field's
  // AJAX enables and populates it, so this count rises by one as each level reveals. Used to
  // know when a post-selection re-render has actually landed. Never throws.
  private async countReadySelects(): Promise<number> {
    if (!this.page || typeof this.page.evaluate !== "function") return 0;
    const n = await this.page
      .evaluate(() => {
        let n = 0;
        for (const s of Array.from(document.querySelectorAll("select"))) {
          if ((s as HTMLSelectElement).disabled) continue;
          const real = Array.from(s.querySelectorAll("option"))
            .map((o) => (o.textContent || "").trim())
            .filter((t) => t && !/^(please\s+)?select\.{0,3}$/i.test(t));
          if (real.length >= 1) n++;
        }
        return n;
      })
      .catch(() => 0);
    return typeof n === "number" ? n : 0;
  }

  // Wait for a post-selection re-render to settle before re-scraping: first the AJAX network,
  // then poll until the count of populated <select>s stops changing (a cascade enables/fills
  // the next dropdown via that round-trip). Bounded; portal-agnostic; never throws.
  private async waitForDynamicFieldsSettle(): Promise<void> {
    if (!this.page) { await sleep(1200); return; }
    if (typeof this.page.waitForLoadState === "function") {
      await this.page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => null);
    }
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 16; i++) { // ~4s cap (16 * 250ms)
      const n = await this.countReadySelects();
      if (n === last) { if (++stable >= 2) break; } else { stable = 0; last = n; }
      await sleep(250);
    }
  }

  // Block until a <select> is enabled AND contains an option matching `value` (by visible text
  // or value attribute), so a cascading dropdown isn't selected against an empty/stale option
  // list. Returns immediately for custom comboboxes (non-<select> widgets) and on timeout, so
  // the existing combobox fallback still runs. Bounded (~5s); never throws.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async waitForOptionReady(loc: any, value: string): Promise<void> {
    if (!loc || !value || typeof loc.evaluate !== "function") return;
    for (let i = 0; i < 20; i++) { // ~5s cap (20 * 250ms)
      const ready = await loc
        .evaluate((el: Element, want: string) => {
          if ((el.tagName || "").toLowerCase() !== "select") return true; // custom combobox — don't block
          if ((el as HTMLSelectElement).disabled) return false;
          const norm = (s: string) => (s || "").trim().toLowerCase();
          return Array.from((el as HTMLSelectElement).options).some(
            (o) => norm(o.textContent || "") === norm(want) || norm(o.value) === norm(want),
          );
        }, value)
        .catch(() => true);
      if (ready) return;
      await sleep(250);
    }
  }

  private async applyFill(
    field: ExtractedField,
    fillReq: { value: string; field?: string },
    sensitive: boolean,
  ): Promise<RecipeStep | null> {
    const value = fillReq.value ?? "";
    const isCheckable = field.fieldType === "checkbox" || field.fieldType === "radio";
    const action: RecipeStep["action"] =
      field.fieldType === "select" ? "select" : isCheckable ? "check" : "fill";

    // A "false/no/off/0" value on a radio means "don't select this option" — skip entirely.
    // A "false" on a checkbox means "leave unchecked" — the default portal state needs no
    // recorded step (and we never recorded a spurious "uncheck" of an already-unchecked box).
    const negated = isCheckable && /^(false|no|off|0|unchecked|none)$/i.test(value.trim());
    if (negated) return null; // both radio AND checkbox: false = no action needed

    const res = await safeAction(
      // The label is non-PII enough for a log line, but keep it short.
      (field.label || field.fieldType).slice(0, 40),
      async () => {
        const loc = await this.locator(field.selector);
        if (!loc) throw new Error("selector unresolved");
        if (action === "select") {
          // A dependent/cascading <select> may still be disabled or have an empty option list
          // when we reach it (its options arrive via the AJAX a prior field triggered). Wait
          // for the target option to actually exist before selecting, so the choice isn't a
          // silent no-op. Bounded; custom comboboxes don't block. Portal-agnostic.
          await this.waitForOptionReady(loc, value);
          // Native <select> first; fall back to the custom-combobox interaction for
          // styled-div dropdowns (PowerClerk "Please select...", select2, ExtJS, etc.)
          // that selectOption() can't drive.
          await loc.selectOption(value)
            .catch(async () => loc.selectOption({ label: value }))
            .catch(async () => { await fillCustomCombobox(this.page, loc, value); });
        } else if (action === "check") {
          if (negated) {
            // Explicit false/no → uncheck the box (leave it unchecked).
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
          // A date/calendar text input pops a floating date-picker on focus that overlays the
          // page and intercepts the NEXT click — the P006 "getting caught up after putting the
          // calendar dates in" hang. We type the date straight into the input (above) and never
          // touch the Calendar button, so the picker is pure obstruction: dismiss it with a
          // page-level Escape (no element refocus) and sweep any lingering popup. Portal-agnostic.
          if (/\bdate\b|\bcalendar\b|datepicker/i.test(field.label || "")) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const kb = (this.page as any)?.keyboard;
            if (kb && typeof kb.press === "function") await kb.press("Escape").catch(() => {});
            await this.clearOverlays();
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
      // Password fields are login credentials handled by the login step — never record as
      // a form fill step (the planner may send one but we drop it here to avoid replaying
      // a stored blank into a plain-text login form on review/settings pages).
      if (/\bpassword\b|\bpasscode\b/i.test(field.label)) return null;
      // NEVER store the literal value of a sensitive field.
      step.sensitive = true;
      step.value = "";
      step.field = fillReq.field || undefined;
    } else if (fillReq.field) {
      // Data-bound to a project/client field — resolved at replay time.
      step.field = fillReq.field;
    } else if (action !== "check") {
      // A portal-literal value (dropdown option / fixed text).
      step.value = value;
    }
    return step;
  }

  // Read each applied fill back; re-apply once if it didn't hold; return the labels of REQUIRED
  // fields that STILL won't hold their value (the portal silently dropped them).
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
    // Final dwell so a client-rendered destination (a slow PowerClerk/Accela page still
    // "downloading"/hydrating its form fields after networkidle) is fully present before the
    // next scrape — scraping too early misses fields. Tunable via AUTOLEARN_NAV_DWELL_MS.
    const navDwellMs = Number(process.env.AUTOLEARN_NAV_DWELL_MS) || 1100;
    await sleep(navDwellMs);
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
          // Floating date-picker popups. We type dates straight into the input and never click
          // the calendar, so an open picker is pure click-interception (the P006 hang). These
          // only exist while a picker is open; pointer-events:none lets the next click through.
          "#ui-datepicker-div",            // jQuery UI datepicker
          ".datepicker.dropdown-menu",     // bootstrap-datepicker
          ".datepicker-dropdown",          // bootstrap-datepicker (alt)
          ".flatpickr-calendar.open",      // flatpickr
          ".react-datepicker__portal",     // react-datepicker (portal mode)
          ".react-datepicker-popper",      // react-datepicker (popper mode)
          ".air-datepicker.-active-",      // air-datepicker
          ".k-calendar-container",         // Kendo UI
          ".mat-datepicker-popup",         // Angular Material
          ".p-datepicker-panel",           // PrimeNG/PrimeReact
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

  // Wait — only as long as needed — for a portal "Saving…/Processing…" indicator to clear.
  // Universal: many SPA wizards (PowerClerk, Accela, generic Bootstrap) show a transient
  // "Saving…" / "Saved✓" status or a spinner while the autosave XHR runs. We poll for one;
  // if none is present the page already saved (network was idle) and we return immediately.
  // Best-effort, never throws. Returns when no saving indicator is visible OR the budget ends.
  private async waitForAutosaveIndicator(maxMs: number): Promise<void> {
    if (!this.page || typeof this.page.evaluate !== "function") return;
    const deadline = Date.now() + maxMs;
    const savingVisible = async (): Promise<boolean> => {
      try {
        return await this.page!.evaluate(() => {
          const vis = (el: Element): boolean => {
            const r = (el as HTMLElement).getBoundingClientRect();
            const st = window.getComputedStyle(el as HTMLElement);
            return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
          };
          // Text-based "Saving…/Processing…" status (PowerClerk's top-right "Saving…").
          const texts = Array.from(document.querySelectorAll<HTMLElement>("span, div, small, p, label"));
          for (const el of texts) {
            const t = (el.textContent || "").trim();
            if (/^(saving|processing|uploading|please wait)(\.{0,3}|…)?$/i.test(t) && vis(el)) return true;
          }
          // Common spinner/overlay classes used by SPA wizards while an XHR is in flight.
          const spinners = document.querySelectorAll(
            "[class*='saving'], [class*='spinner']:not([style*='display: none']), .loading-overlay, .x-mask-loading, [aria-busy='true']",
          );
          for (const el of spinners) if (vis(el)) return true;
          return false;
        });
      } catch { return false; }
    };
    // Quick exit: if nothing is saving right now, don't wait at all.
    if (!(await savingVisible())) return;
    while (Date.now() < deadline) {
      await sleep(200);
      if (!(await savingVisible())) return;
    }
  }

  // Scrape visible inline validation errors from the page — works on ASP.NET field-validation
  // spans, Bootstrap invalid-feedback divs, aria-invalid controls, role=alert banners, and
  // required-but-empty inputs. Returns labelled, de-duplicated strings like:
  //   "Schedule: This field is required."  or  "Energy Source: Please select an option."
  // Best-effort; never throws. Returns [] when nothing is found.
  private async collectValidationErrors(): Promise<string[]> {
    if (!this.page || typeof this.page.evaluate !== "function") return [];
    try {
      return await this.page.evaluate((): string[] => {
        const seen = new Set<string>();
        const out: string[] = [];
        const add = (msg: string) => { const t = msg.trim(); if (t && !seen.has(t)) { seen.add(t); out.push(t); } };

        // 1. Visible text inside validation/error elements.
        const errSels = [
          '[class*="validation-message"]:not([style*="display:none"]):not([style*="display: none"])',
          '[class*="field-validation-error"]',
          '.invalid-feedback:not([style*="display:none"])',
          '[class*="error-message"]:not([style*="display:none"])',
          '[role="alert"]:not([style*="display:none"])',
          '[aria-live="assertive"]:not([style*="display:none"])',
          '.alert-danger:not([style*="display:none"])',
        ];
        for (const sel of errSels) {
          document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
            const t = el.innerText?.trim();
            if (t && t.length > 3 && el.offsetParent !== null) add(t);
          });
        }

        // 2. aria-invalid inputs that are also required — append a synthetic label+message.
        document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
          "input[aria-invalid='true'][required], select[aria-invalid='true'][required], " +
          "textarea[aria-invalid='true'][required]"
        ).forEach((el) => {
          const label = (document.querySelector(`label[for="${el.id}"]`) as HTMLLabelElement)?.innerText?.trim()
            || (el as HTMLInputElement).placeholder || el.name || "Field";
          add(`${label}: This field is required.`);
        });

        return out.slice(0, 20);
      });
    } catch {
      return [];
    }
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
