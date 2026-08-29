import fs from "fs";
import path from "path";
import type { Page, Frame } from "playwright";
import type { ProjectRecord, RecipeSelector, RecipeStep, StepFingerprint } from "../../../shared/src/types";
import { BasePortalAdapter, HUMAN_REVIEW_MESSAGE, type PortalContext, type PortalStepResult } from "../adapter";
import { openPortal } from "../browser";
import { selectWithFallback } from "../comboboxFill";
import { detectChallengeFrame, frameSelectorFor, readbackMatches, redactStatusText, safeAction, sleep, smartWait, waitForElement, waitForInteractiveControls } from "../safeAction";
import { scrapeReviewScreen as scrapeReviewScreenShared } from "../reviewScreenScraper";
import { performLogin } from "./loginFlow";
import { parseStreetName, parseStreetNumber } from "../addressParse";
import { portalUploadCapBytes } from "../uploadCap";
import { LearnRunDebug } from "../learnDebug";
import { armHumanCaptureOnPage } from "../humanCapture";

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

/** One portal contact: who is filing (applicant) or who owns the site (site contact). */
export interface ContactIdentity {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}

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
  /** The section/heading/wizard-step this field lives under — the planner uses it to tell
   *  identical contact blocks apart (Customer vs Installer) without portal-specific rules. */
  section?: string;
  /** Recorded-element attributes for replay-heal tie-breaking (see StepFingerprint). */
  fingerprint?: StepFingerprint;
  /** Radio-group identity (the input's name attribute). Radios in one group have DISTINCT
   *  labels, so after one option is filled its siblings look like "new" fields to the
   *  post-reveal re-scan — this key lets it recognize (and never re-answer) a group that
   *  already has a recorded answer, which would silently flip the selection. */
  group?: string;
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
  /** Base64 PNG screenshot of the CURRENT page (vision-assisted planning). Lets the planner SEE
   *  the layout + section headings — the authoritative signal for which contact block is which
   *  and what each control is — instead of reasoning from labels + text alone. Learn-time only;
   *  undefined when capture is unavailable or disabled (PORTAL_VISION_PLAN=0). */
  screenshotBase64?: string;
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
  /** Labels of REQUIRED, non-sensitive fields left blank/unselected (dropped fills + untouched
   *  required fields). Surfaced structurally (not just in `message`) so the backend trust gate
   *  can refuse to promote a recipe with a known blank required field. Empty = clean. */
  requiredFieldMisses?: string[];
  /** Labels of REQUIRED document-upload slots with no matching project file (left empty). */
  missingRequiredDocs?: string[];
  /** Inline validation errors the portal raised when an advance was blocked. */
  validationBlocks?: string[];
  /** Absolute path of this run's debug bundle (data/learn-runs/<runId>) — the folder the
   *  operator zips up for troubleshooting. Undefined when AUTOLEARN_RUN_DEBUG=0. */
  debugDir?: string;
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

// Controls that act on an EXISTING portal record (the operator's real filings) — never
// part of learning a NEW application. "Resume Application" reopens a draft record;
// "Pay Fees Due" is a payment path. Off-limits for click/advance/nav alike.
const EXISTING_RECORD_ACTION = /\bresume application\b|\bpay fees? due\b/i;

// ACA contact-section controls. Once the applicant is filled deterministically with the
// FILING CONTRACTOR's identity, a planner click on one of these re-opens that contact and
// overwrites it with the homeowner's details (live Coos Bay).
const CONTACT_CONTROL = /add new|select from account/i;

// Accela ACA's wizard-advance control: an <a> on some layouts, a button/submit-input on
// others (live-verified union from the hand-coded OregonEPermittingAdapter).
const ACA_CONTINUE_CSS = 'a:has-text("Continue Application"), button:has-text("Continue Application"), input[type="submit"][value*="Continue Application" i]';

// Markers that a page is the review/confirm step — portal-AGNOSTIC phrasing only (a generic
// "Step N: Review", a read-only summary, a "please review" instruction, or a terms-acceptance /
// "will not be submitted until" acknowledgment gate). Portal-specific review behaviour (e.g. a
// submit-intent button on a no-input page) is detected STRUCTURALLY, not by one portal's wording,
// so this stays generic across never-seen portals.
const REVIEW_MARKERS = /\bstep\s*\d+\s*:?\s*review\b|review (all )?(your |the )?(information|application|details|entries)\b|please review|\(read-only\)|review and submit|review & submit|accept (the )?terms and conditions|will not be submitted until/i;

// Terms-acceptance / certification / acknowledgment checkboxes that gate a final submit.
// Portal-agnostic: PowerClerk "Click to Accept Terms and Conditions" + "I understand that
// my form will not be submitted until…", Accela/Salesforce "I certify/I agree" attestations.
// Used both to (a) recognize a review/submit screen and (b) auto-check these required gates
// before recording the submit. Deliberately narrow so it never matches a normal form toggle.
const ACCEPT_TERMS = /\b(accept (the )?terms|terms (and|&) conditions|i agree\b|i understand\b|i acknowledge|acknowledge that|i certify|i attest|i confirm that|agree to the)\b/i;
function looksLikeReviewUrl(url: string): boolean {
  return /capconfirm|confirm\.aspx|\/review/i.test(url || "");
}

// host+pathname only (no query string) for debug artifacts — avoids leaking ids/tokens.
function safeHostPath(url: string): string {
  try { const u = new URL(url); return u.host + u.pathname; } catch { return (url || "").slice(0, 60); }
}

// "Equipment is not listed" / "enter manually" escape-hatch checkbox. Checking it HIDES the
// searchable manufacturer/model dropdowns and degrades to plain-text inputs the portal scores
// as UNLISTED equipment (PGE/PowerClerk "The proposed PV equipment is not listed."). The LLM
// planner is instructed to leave it unchecked, but it has been observed checking it anyway, so
// this is a deterministic safety net: a checkbox whose label matches this is NEVER checked.
const NOT_LISTED_CHECKBOX =
  /\b(proposed\s+\w+\s+equipment\s+is\s+not\s+listed|equipment\s+is\s+not\s+listed|not\s+in\s+the\s+list|enter\s+(equipment\s+)?manually|manual\s+entry)\b/i;

// PGE/PowerClerk Yes/No POLICY questions whose answer is fixed for standard residential NEM.
// Mirrors the knowledge-base seed. A deterministic pass applies the policy answer so the portal
// default — or a wrong planner pick — can't stand.
//   • enforce=false (default): only acts when the group is UNANSWERED. Used where project DATA
//     could legitimately differ (export limit is "No" unless the project chooses to limit it).
//   • enforce=true: selects the policy answer even if another option is already checked, so a
//     planner that picked the wrong option is corrected. Used for answers fixed by equipment
//     listing (UL 1741-SB lab certification is "Yes" for standard listed residential inverters).
const POLICY_RADIO_DEFAULTS: Array<{ question: RegExp; answer: "Yes" | "No"; enforce?: boolean }> = [
  { question: /do you propose to limit the export capacity/i, answer: "No" },
  { question: /are all inverters lab certified|inverters?\s+lab\s+certified|UL\s*1741/i, answer: "Yes", enforce: true },
  // Standard residential detail places the lockable AC disconnect adjacent to the meter;
  // the prompt default alone was observed missed (required radio left blank → portal
  // blocked the submit), so the deterministic pass backs it like the other two.
  { question: /disconnect within 10\s*(feet|ft|')\s*of the .{0,20}meter/i, answer: "Yes" },
];

// Sensitive field labels whose literal value must NEVER be stored in a recorded step.
const SENSITIVE_LABEL = /\b(password|passcode|account\s*(number|no|#)?|acct|meter\s*(number|no|#)?|ssn|social security|tax\s*id|ein|routing|card\s*number|cvv|security code)\b/i;

// Portal upload-field label → document type. Maps a file-input's visible label to the
// docType produced by the existing doc-splitting tools (docSplitter.ts / projectDocsByType),
// so the learner attaches the RIGHT split document to each upload control. Ordered most-
// specific first (a combined "module/inverter" label resolves to inverter_spec first).
// Certified-name aliases: what the plan set calls a manufacturer vs how equipment
// databases (CEC listings, PowerClerk) list it. Keyed by the plan-set name with all
// non-alphanumerics stripped, lowercase. Extend as new mismatches surface.
// Equipment with its OWN make/model that must never receive PV module/inverter
// data: service gear, storage, EV, generators, racking, optimizers, monitoring.
// Shared by the positive matcher (side exclusion) and the proximity reset.
const EQUIPMENT_NEGATIVE_GUARD =
  /main (service )?panel|service panel|sub ?panel|panelboard|electrical panel|load center|breaker|disconnect|meter\b|battery|storage|charger|vehicle|\bev\b|generator|genset|hvac|heat ?pump|racking|rail\b|optimi[sz]er|monitor/;

// Keyed by the compact-lowercase plan-set name; values are the CEC/certified
// names portals actually list (PowerClerk and friends load their equipment
// dropdowns from the CEC listing, whose legal names rarely match plan sets).
// Covers the mainstream residential makes so a NEW utility's certified list
// still resolves on first contact; the distinctive-token fallback catches the
// long tail. When a run shows an unmatched make, add its certified name here.
const EQUIPMENT_MAKE_ALIASES: Record<string, string[]> = {
  // Microinverters / inverters
  apsystems: ["Altenergy Power System", "APsystems"],
  altenergypowersystem: ["AP Systems", "APsystems"],
  enphase: ["Enphase Energy"],
  solaredge: ["SolarEdge Technologies"],
  hoymiles: ["Hoymiles Power Electronics"],
  sma: ["SMA America", "SMA Solar Technology"],
  fronius: ["Fronius USA", "Fronius International"],
  goodwe: ["GoodWe Technologies"],
  growatt: ["Growatt New Energy"],
  solark: ["Sol-Ark", "Portable Solar (Sol-Ark)"],
  generac: ["Generac Power Systems"],
  tesla: ["Tesla Energy", "Tesla Motors", "Tesla Inc"],
  tigo: ["Tigo Energy"],
  nep: ["Northern Electric Power", "NEP"],
  chilicon: ["Chilicon Power"],
  // Modules
  znshine: ["Znshine PV-Tech"],
  znshinesolar: ["Znshine PV-Tech", "Znshine"],
  qcells: ["Hanwha Q CELLS", "Q CELLS"],
  hanwhaqcells: ["Q CELLS", "Qcells"],
  rec: ["REC Solar", "REC Group"],
  canadiansolar: ["Canadian Solar Inc"],
  jinko: ["Jinko Solar", "JinkoSolar"],
  jinkosolar: ["Jinko Solar"],
  trina: ["Trina Solar"],
  trinasolar: ["Trina Solar Energy"],
  longi: ["LONGi Green Energy", "LONGi Solar"],
  longisolar: ["LONGi Green Energy Technology"],
  jasolar: ["JA Solar Technology"],
  silfab: ["Silfab Solar"],
  missionsolar: ["Mission Solar Energy"],
  hyundai: ["Hyundai Energy Solutions"],
  panasonic: ["Panasonic Corporation", "Panasonic Eco Solutions"],
  aptos: ["Aptos Solar Technology"],
  boviet: ["Boviet Solar Technology"],
  seg: ["SEG Solar"],
  segsolar: ["SEG Solar"],
  maxeon: ["Maxeon Solar Technologies", "SunPower"],
  sunpower: ["SunPower Corporation", "Maxeon Solar Technologies"],
  phonosolar: ["Phono Solar Technology"],
  vsun: ["VSUN Solar", "Vietnam Sunergy"],
};

const UPLOAD_LABEL_PATTERNS: Array<{ re: RegExp; docType: string }> = [
  // Completed-application slots FIRST (before the generic doc patterns): even
  // portal-entry AHJs (some Accela configs) ask for the filled application/
  // checklist PDF as an attachment. The filled forms are overlaid into
  // docsByType by the backend (filledFormsByDocType).
  { re: /electrical\s*(permit\s*)?application/i, docType: "electrical_application" },
  { re: /(building|structural)\s*(permit\s*)?application/i, docType: "building_application" },
  { re: /checklist|worksheet|eligibilit/i, docType: "solar_checklist" },
  { re: /(completed|signed|permit|solar)\s*application|application\s*(form|packet)/i, docType: "permit_application" },
  { re: /one[-\s]?line|single[-\s]?line|\bsld\b|electrical\s*(diagram|schematic|one)/i, docType: "sld" },
  { re: /site\s*plan|plot\s*plan/i, docType: "site_plan" },
  // The SEALED LETTER before the generic structural pattern. These are different
  // documents: "structural" is the roof-framing/attachment-detail sheet split out of
  // the plan set, while a slot asking for an engineer's letter, calcs, or a wet stamp
  // wants the separately-uploaded PE-sealed PDF. Ordered first because the generic
  // pattern below matches the word "structural" and would otherwise file the framing
  // sheet against "Structural engineering letter" — an AHJ rejection that looks like
  // a successful upload.
  { re: /(structural|engineer(ing|'s|s')?|\bPE\b|design)\s*(letter|certification|certificate)|letter\s*of\s*certification|structural\s*(calc|analysis|report)|wet\s*stamp|stamped\s*letter|sealed\s*letter/i, docType: "structural_letter" },
  { re: /structural|roof\s*framing|mounting|attachment\s*detail/i, docType: "structural" },
  { re: /inverter|micro[-\s]?inverter/i, docType: "inverter_spec" },
  { re: /module|panel\s*(spec|data\s*sheet)|cut\s*sheets?/i, docType: "module_spec" },
  { re: /meter\s*(photo|picture|image|spec|reading|tag)/i, docType: "meter_photo" },
  { re: /label|placard/i, docType: "labels" },
  { re: /utility\s*bill|electric(ity)?\s*bill/i, docType: "utility_bill" },
  { re: /plan\s*set|full\s*plan|construction\s*(plan|doc)|drawings?/i, docType: "plan_set" },
];

// When an upload control's label doesn't name a specific document (a generic "Upload
// documents" / "Attach files" control), attach the full plan-set PDF instead — most
// portals with a single upload slot want the complete set. Tried in order. ZIP is last
// because portal file inputs typically only accept PDFs; attaching a ZIP to an
// "Electrical Diagram" slot silently fails or shows up in the wrong section.
const UPLOAD_FALLBACK_DOCTYPES = ["plan_set", "sld", "site_plan", "utility_package_zip"];

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
  /** aria-label attribute, captured for the step fingerprint (heal tie-break). */
  ariaLabel?: string;
  /** Stable identifier (name or id) of the child <iframe> this field lives in, if any.
   *  Undefined for the main document. Stamped by extractAllFrames so the fill/replay locator
   *  can scope into the right frame (e.g. Accela's ACADialogFrame contact/upload dialogs). */
  frame?: string;
  /** The section/heading/wizard-step this field lives under (e.g. "PGE Customer Information"
   *  vs "Installer Information"). Lets the planner disambiguate identical contact blocks. */
  section?: string;
  /** CSS selector built from a data-test* attribute (e.g. [data-test-role="inverter-model-select"]).
   *  Stable across sessions — captured as a high-priority replay selector for custom widgets. */
  testCss?: string;
}

// Serializable extractor — derives a label and selector hints for each interactive
// element. Defined as a string-compatible function so it runs inside the page.
export function extractFieldsInPage(els: Element[]): RawField[] {
  function labelFor(el: Element): string {
    const id = el.getAttribute("id");
    if (id) {
      // Look the label up in the element's OWN root — for a field inside an open shadow
      // root the <label for=…> lives in the same shadow root, where document.querySelector
      // can't see it. getRootNode() returns the document for light-DOM fields, so this is
      // a strict superset of the old behavior.
      const root = el.getRootNode() as Document | ShadowRoot;
      const lbl = root.querySelector(`label[for="${CSS.escape(id)}"]`);
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

  // Derive the SECTION a field lives under — its fieldset legend / enclosing card-or-panel
  // heading / nearest preceding heading / active wizard-step. Portals reuse IDENTICAL contact
  // blocks ("Name / Company / Email / Phone") across steps, and the ONLY thing distinguishing a
  // Customer block from an Installer/Preparer block is the SECTION HEADING — which is rendered as
  // an <h*>/legend/stepper element the field selector never captures. Attaching it per field lets
  // the planner route homeowner-vs-installer data correctly WITHOUT any portal-specific rules.
  function sectionFor(el: Element): string {
    const clean = (s: string | null | undefined): string => (s || "").replace(/\s+/g, " ").trim().slice(0, 80);
    // 1) Enclosing fieldset legend — the strongest grouping signal.
    const fs = el.closest("fieldset");
    const legend = fs ? fs.querySelector("legend") : null;
    if (legend && clean(legend.textContent)) return clean(legend.textContent);
    // 2) Nearest card / panel / section container's leading heading.
    const container = el.closest('section, [class*="panel"], [class*="card"], [class*="section"], [class*="form-section"], [class*="block"], [role="group"], [role="region"]');
    if (container) {
      const h = container.querySelector('legend, h1, h2, h3, h4, h5, h6, .panel-title, .card-title, .card-header, .section-title, .panel-heading');
      if (h && clean(h.textContent)) return clean(h.textContent);
    }
    // 2b) Nearest heading appearing BEFORE this field (heading-then-fields sibling layouts).
    let node: Element | null = el;
    for (let hops = 0; node && hops < 6; hops++) {
      let sib: Element | null = node.previousElementSibling;
      while (sib) {
        if (/^(H[1-6]|LEGEND)$/.test(sib.tagName) && clean(sib.textContent)) return clean(sib.textContent);
        const inner = sib.querySelector ? sib.querySelector("h1, h2, h3, h4, h5, h6, legend") : null;
        if (inner && clean(inner.textContent)) return clean(inner.textContent);
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    // 2c) SHADOW BOUNDARY HOP — a web-component field's heading often lives OUTSIDE its
    // shadow root (the component renders bare inputs; the page around it carries the
    // section heading). closest()/sibling walks stop at the root, so continue the search
    // from the shadow host in the outer tree. Recursion depth == nesting depth (small).
    const rootNode = el.getRootNode();
    if (rootNode instanceof ShadowRoot && rootNode.host) return sectionFor(rootNode.host);
    // 3) The active wizard-step / stepper label (page-level "which step are we on").
    const active = document.querySelector('.wizard-step.active, .step.active, [aria-current="step"], [class*="stepper"] [class*="active"], [class*="wizard"] [class*="active"]');
    if (active && clean(active.textContent)) return clean(active.textContent);
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

    // ROLE=COMBOBOX / aria-haspopup=listbox is a DROPDOWN even when it's an <input>.
    // PowerClerk's live "System Information" renders each equipment Manufacturer/Model as a
    // Vue "filtered select": a READONLY <input role="combobox" aria-haspopup="listbox"
    // aria-label="Manufacturer" class="visually-hidden"> backed by an aria-controls listbox.
    // Classified as "text" (the tag check above) it takes applyFill's fill() path — which
    // THROWS on the readonly input and drops the value silently (the specs-page stall). Route
    // it through the select/combobox path (click -> open -> pick) instead. Only upgrades text/
    // other, never a real <select>/checkbox/radio/file.
    // INPUTS ONLY: a styled <div role="combobox"> stays "other" so the pre-existing
    // custom-dropdown block below still handles it — that block ALSO captures the
    // aria-controls listbox's rendered options into RawField.options, which gap-fill
    // uses to validate planner-proposed values. Upgrading divs here would skip it.
    {
      const comboRole = (el.getAttribute("role") || "").toLowerCase();
      const comboPopup = (el.getAttribute("aria-haspopup") || "").toLowerCase();
      if ((comboRole === "combobox" || comboRole === "listbox" || comboPopup === "listbox") &&
          tag === "input" && fieldType === "text") {
        fieldType = "select";
      }
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
        // Capture any options already rendered in an associated open listbox. Resolve the
        // aria-controls id in the element's own root first (shadow-DOM widgets keep their
        // listbox in the same root), then the document (portals that teleport listboxes
        // to <body>).
        const listId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
        const ownRoot = el.getRootNode() as Document | ShadowRoot;
        const list = listId
          ? ((typeof ownRoot.getElementById === "function" ? ownRoot.getElementById(listId) : null) || document.getElementById(listId))
          : el.querySelector('[role="listbox"]');
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

    // data-test* hooks (data-testid / data-test-role / data-test / data-cy / data-qa) — a
    // widespread convention that gives both a STABLE selector and a semantic identity for custom
    // widgets that have no real label (e.g. a Vue "filtered select" carrying
    // data-test-role="inverter-manufacturer-select"). Universal: any app using test attributes.
    let testCss: string | undefined;
    let testHint: string | undefined;
    for (const attr of ["data-testid", "data-test-role", "data-test", "data-cy", "data-qa"]) {
      const tv = el.getAttribute(attr);
      if (tv) { testCss = `[${attr}="${tv}"]`; testHint = tv.replace(/[-_]+/g, " ").trim(); break; }
    }
    const rawLabel = labelFor(el);
    // A generic prompt ("Please select…", "Qty") on a widget that carries a data-test identity is
    // less useful to the planner than the identity itself (which disambiguates e.g. the inverter
    // Qty from a PV-array Qty) — prefer the test hint in that case; otherwise keep the real label.
    const genericLabel = /^(please\s+)?select\.{0,3}$|^select$|^qty$|^\s*$/i.test(rawLabel);
    const label = (genericLabel && testHint) ? testHint : (rawLabel || testHint || "");
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
    // Required detection. The HTML `required`/`aria-required` attributes are the cheap path,
    // but PowerClerk (and most Bootstrap forms) mark required fields ONLY with a red asterisk
    // in the visible label — no attribute at all. Without catching the asterisk, Schedule,
    // Account/Meter, and the Yes/No option groups all looked OPTIONAL, so a silently-dropped
    // value never surfaced and the recipe was wrongly promoted to "trusted". Detect the
    // asterisk too: from the field's OWN label for normal inputs, and from the enclosing
    // group/fieldset label for radios/checkboxes (whose asterisk sits on the group prompt,
    // e.g. "Service Type *", not the individual option).
    function labelHasAsterisk(text: string | null | undefined): boolean {
      return !!text && /\*/.test(text);
    }
    let requiredByAsterisk = false;
    if (fieldType === "radio" || fieldType === "checkbox") {
      const group = el.closest("fieldset, .form-group, [class*='form-group'], [class*='field'], .row, [class*='row']");
      const groupLbl = group?.querySelector("legend, label, .control-label, .field-label, strong, b");
      requiredByAsterisk = labelHasAsterisk(groupLbl?.textContent);
    } else {
      const ownId = el.getAttribute("id");
      const forLbl = ownId ? document.querySelector(`label[for="${CSS.escape(ownId)}"]`) : null;
      const wrapLbl = el.closest("label");
      requiredByAsterisk = labelHasAsterisk(forLbl?.textContent) || labelHasAsterisk(wrapLbl?.textContent);
    }
    const required = (el as HTMLInputElement).required || el.getAttribute("aria-required") === "true" || requiredByAsterisk || undefined;

    out.push({ label, fieldType, options, role, name, placeholder, id, text, href, required: required || undefined, section: sectionFor(el) || undefined, testCss, ariaLabel: el.getAttribute("aria-label")?.trim() || undefined });
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
  // A data-test* attribute is the most stable hook for a custom widget — use it as the primary
  // selector when nothing better was derived, else keep it as a fallback so replay can still find
  // the control if the label/role/id selector drifts.
  if (raw.testCss) {
    if (!selector.label && !selector.role && !selector.name && !selector.placeholder && !selector.css) {
      selector.css = raw.testCss;
    } else {
      selector.fallbacks = [...(selector.fallbacks ?? []), { css: raw.testCss }];
    }
  }

  // Scope the selector (and its fallbacks) into the child frame this field came from, so the
  // fill/replay locator resolves inside the iframe rather than the main document.
  if (raw.frame) {
    selector.frame = raw.frame;
    if (selector.fallbacks) selector.fallbacks = selector.fallbacks.map((fb) => ({ ...fb, frame: raw.frame }));
  }
  const field: ExtractedField = {
    selector,
    label: raw.label,
    fieldType: raw.fieldType,
  };
  if (raw.options && raw.options.length) field.options = raw.options;
  if (raw.href) field.href = raw.href;
  if (raw.required) field.required = true;
  if (raw.section) field.section = raw.section;
  // Fingerprint: raw element attributes for replay-heal tie-breaking. Attribute
  // NAMES/labels only — never values, so nothing sensitive can land in a recipe.
  if (raw.id || raw.name || raw.placeholder || raw.ariaLabel || raw.section) {
    field.fingerprint = {
      ...(raw.id ? { id: raw.id } : {}),
      ...(raw.name ? { name: raw.name } : {}),
      ...(raw.placeholder ? { placeholder: raw.placeholder } : {}),
      ...(raw.ariaLabel ? { ariaLabel: raw.ariaLabel } : {}),
      ...(raw.section ? { section: raw.section } : {}),
    };
  }
  if (raw.fieldType === "radio" && raw.name) field.group = raw.name;
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
  /** Radio-group identity of the filled field (see ExtractedField.group). */
  group?: string;
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

  // querySelectorAll that also walks OPEN shadow roots (web-component upload widgets).
  // document.querySelectorAll alone can't see into a shadow root, so a portal built on
  // custom elements would silently expose zero upload slots. Depth-first, never throws.
  function deepQueryAll(root: ParentNode, sel: string): Element[] {
    const out: Element[] = Array.from(root.querySelectorAll(sel));
    for (const host of Array.from(root.querySelectorAll("*"))) {
      if ((host as Element).shadowRoot) out.push(...deepQueryAll((host as Element).shadowRoot as ShadowRoot, sel));
    }
    return out;
  }
  let n = 0;

  // Derive the field label for an upload control: nearest <label>, else the closest
  // form-group/row container's leading label/heading/text, else the trigger's own text.
  function deriveLabel(el: Element): string {
    const id = el.getAttribute("id");
    if (id) {
      // Element's own root, so a label inside the same shadow root is found too.
      const root = el.getRootNode() as Document | ShadowRoot;
      const forLbl = root.querySelector(`label[for="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`);
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
  const fileInputs = deepQueryAll(document, 'input[type="file"]');
  for (const el of fileInputs) {
    const key = `f${n++}`;
    el.setAttribute("data-al-upl", key);
    slots.push({ key, label: deriveLabel(el), kind: "input", required: isRequired(el) });
  }

  // 2) Browse/Upload/Choose-File triggers whose real input is created dynamically — these
  //    have NO file input anywhere in their container, so the scrape above missed them.
  const TRIGGER = /^(browse|upload|choose(\s+file)?|attach|add\s+file|select\s+file|choose\s+files?|upload\s+file)\.{0,3}$/i;
  const clickables = deepQueryAll(document, 'button, a, [role="button"], input[type="button"], .btn, span[class*="upload"], span[class*="browse"]');
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

  // Per-run debug bundle (data/learn-runs/<runId>): manifest + event timeline + per-page
  // plan sidecars + screenshots + Playwright trace. On by default; null when disabled
  // (AUTOLEARN_RUN_DEBUG=0). Public so learnPortal() can finalize it on early exits
  // (login failure / thrown error) and callers can surface the bundle path.
  readonly debug: LearnRunDebug | null;

  // See constructor options.policyProfile.
  private policyProfile: "residential_nem" | "none";
  private equipment: Record<string, string>;
  private certifiedAliases: Record<string, string[]>;
  private contactIdentity: ContactIdentity = {};
  private siteContactIdentity: ContactIdentity = {};
  // Attach keys used this RUN (pathname::slotLabel::file) - see the duplicate-row guard.
  private attachedKeys = new Set<string>();
  // Set once the APPLICANT contact has been filled with the contractor identity.
  private acaApplicantFilled = false;
  // Equipment fields whose select verification failed for EVERY candidate this
  // run — retrying them each rescan pass just burns waitForOptionReady caps.
  private equipmentFillFailed = new Set<string>();

  constructor(
    portalName: string,
    private planner: LearnPlanner,
    private options: {
      maxPages?: number;
      autoSubmit?: false;
      docsByType?: Record<string, string>;
      uploadMode?: "split" | "combined";
      onProgress?: LearnProgressFn;
      // Which deterministic policy-answer set applyPolicyDefaults may use.
      //   "residential_nem" — the standard-residential-NEM Yes/No answers (export
      //     capacity → No, UL 1741 lab certified → Yes). Correct for utility
      //     interconnection portals on standard residential projects.
      //   "none" — never force-answer a policy question; the planner + project data
      //     decide. Right for AHJ/permit portals and non-standard projects.
      // Default "residential_nem" preserves prior behavior for direct constructor users;
      // the backend passes the scope-appropriate profile explicitly.
      policyProfile?: "residential_nem" | "none";
      // Equipment identity for the deterministic PV-spec pass: inverterMake,
      // inverterModel, moduleMake, moduleModel. Portals list equipment under
      // certified names ("AP Systems" → "Altenergy Power System"), so these are
      // matched with aliases + distinctive-token fallback, never left to the planner.
      equipment?: Record<string, string>;
      /** CEC-certified manufacturer names per compact plan-set make (weekly
       *  cec_equipment sync) — appended AFTER the curated static alias table;
       *  empty map = byte-identical behavior. */
      certifiedAliases?: Record<string, string[]>;
      /** Contractor contact identity for the deterministic ACA "Add New" contact
       *  pass (firstName/lastName/email/phone). The operator's account carries many
       *  pre-existing contacts, so "Add New" with the filing contractor's own info is
       *  preferred over selecting one. Empty = the pass is skipped (planner handles it). */
      /** Contact identities for the deterministic ACA "Add New" pass, IN SECTION ORDER
       *  (ACA renders Applicant first, then Site Contact). The applicant is the FILING
       *  CONTRACTOR; the site contact is the PROPERTY OWNER. Filling installer identity
       *  into both produces a mixed contact (owner name + contractor address), which is
       *  what a live Coos Bay run wrote. Empty = the pass is skipped for that section. */
      contactIdentity?: ContactIdentity;
      siteContactIdentity?: ContactIdentity;
    } = {},
  ) {
    super();
    this.portalName = portalName;
    this.onProgress = options.onProgress;
    this.policyProfile = options.policyProfile ?? "residential_nem";
    this.equipment = options.equipment ?? {};
    this.certifiedAliases = options.certifiedAliases ?? {};
    this.contactIdentity = options.contactIdentity ?? {};
    this.siteContactIdentity = options.siteContactIdentity ?? {};
    // Default page budget. Multi-step utility/permit wizards (PowerClerk NEM, Accela)
    // routinely run 10-15 input steps before the review screen, so 8 was too low — it
    // capped out mid-form. The stuck-page guard + review detection bound the loop, so a
    // higher cap can't run away; it just allows long wizards to reach review.
    this.maxPages = options.maxPages ?? 18;
    this.docsByType = options.docsByType ?? {};
    this.uploadMode = options.uploadMode ?? "split";
    this.debug = LearnRunDebug.start(portalName, { maxPages: this.maxPages, uploadMode: this.uploadMode });
  }

  // ---------------------------------------------------------------------------
  // DETERMINISTIC EQUIPMENT-SPEC PASS. PowerClerk-style PV System Specification
  // repeaters expose manufacturer/model comboboxes whose options load via AJAX
  // (extracted with empty option lists + generic labels), and whose certified
  // names differ from the plan set's ("AP Systems" is listed as "Altenergy Power
  // System"; the model option is "0.8 kW (Model DS3-L {240V} [SI1])"). The LLM
  // planner reliably fails here — but the ANSWER is pure project data, so fill
  // these deterministically: match fields by their test-hint labels, then try
  // the value, its known aliases, and its most distinctive token in order.
  // ---------------------------------------------------------------------------
  // CONTEXT, not just label: PowerClerk's PV System Specification page labels its
  // controls bare — "Manufacturer", "Model", "Quantity" — and puts the side in the
  // SECTION header ("PV Module Information" / "Inverter Information"). Match against
  // section+label together, with a proximity fallback (a bare "Model" right after
  // the inverter "Manufacturer" belongs to the inverter) supplied by the caller.
  private equipmentValueFor(
    context: string,
    fallbackSide?: "inverter" | "module",
    bareSelect = false,
  ): { key: string; candidates: string[]; side: "inverter" | "module" | null } | null {
    const l = (context || "").toLowerCase();
    const isModel = /\bmodel\b/.test(l);
    const isMake = /manufacturer|\bmake\b|\bbrand\b/.test(l);
    const isQty = /\bquantity\b|\bqty\b|number of (modules|panels|inverters|micro)/.test(l);
    const isTilt = /\btilt\b/.test(l); // NOT "pitch": AHJ "Roof Pitch" fields want rise/run (4:12), not degrees
    const isAzimuth = /\bazimuth\b/.test(l);
    const isTracking = /\btracking\b/.test(l);
    if (!isModel && !isMake && !isQty && !isTilt && !isAzimuth && !isTracking) {
      // COMBINED EQUIPMENT SELECT. PowerClerk's other spec template renders each
      // repeater row as a Qty box plus ONE unlabeled "Please select..." dropdown
      // whose options are certified make+model strings ("Enphase Energy Inc.:
      // IQ8PLUS-72-2-US [240V]") — no "Manufacturer"/"Model" wording anywhere.
      // Candidates run model-first (full, then distinctive token) so a combined
      // list matches on the model; make/aliases last so a manufacturer-only
      // select still resolves. Every fill is verified against the option list,
      // so a candidate that isn't in this select simply doesn't hold.
      if (!bareSelect) return null;
      const bareBattery = /battery|energy storage|\bess\b|storage system|powerwall/.test(l);
      const bareSide = /inverter|micro/.test(l) ? "inverter" as const
        : /module|pv ?array|solar panel|photovoltaic/.test(l) ? "module" as const
        : fallbackSide ?? null;
      if (!bareBattery) {
        if (!bareSide) return null;
        if (EQUIPMENT_NEGATIVE_GUARD.test(l) && !/module|pv ?array|solar|photovoltaic|inverter|micro/.test(l)) return null;
      }
      const prefix = bareBattery ? "battery" : bareSide!;
      const model = (this.equipment[`${prefix}Model`] || "").trim();
      const make = (this.equipment[`${prefix}Make`] || "").trim();
      if (!model && !make) return null;
      const candidates: string[] = [];
      if (model) {
        candidates.push(model);
        const tokens = model.split(/[\s,()[\]{}]+/).filter((t) => /\d/.test(t) && t.length >= 3);
        const core = tokens.sort((a, b) => b.length - a.length)[0];
        if (core) candidates.push(core);
      }
      if (make) {
        candidates.push(make);
        const compactMake0 = make.toLowerCase().replace(/[^a-z0-9]/g, "");
        candidates.push(...(EQUIPMENT_MAKE_ALIASES[compactMake0] ?? []), ...(this.certifiedAliases[compactMake0] ?? []));
      }
      return { key: `${prefix}Model`, candidates: [...new Set(candidates)], side: bareBattery ? null : bareSide };
    }
    // NEGATIVE GUARD: service equipment, storage, EV gear, generators, racking,
    // optimizers, monitoring — anything with its own make/model that is NOT the
    // PV modules/inverters. The wider section+label context makes accidental
    // keyword hits likelier, so these are out unless PV is EXPLICITLY named —
    // and "explicitly" means module/PV wording, not "inverter": a "Battery
    // Inverter Model" is storage gear, not the PV inverter.
    // BATTERY/ESS is its own side: storage sections ask Manufacturer/Model/
    // Quantity too, answered from battery project data (never PV data, and a
    // battery side never seeds proximity inheritance for later bare fields).
    const batterySide = /battery|energy storage|\bess\b|storage system|powerwall/.test(l);
    if (batterySide && (isMake || isModel || isQty)) {
      const key = isQty ? "batteryQty" : isModel ? "batteryModel" : "batteryMake";
      const value = (this.equipment[key] || "").trim();
      if (!value) return null;
      const candidates = [value];
      if (isModel) {
        const tokens = value.split(/[\s,()[\]{}]+/).filter((t) => /\d/.test(t) && t.length >= 3);
        const core = tokens.sort((a, b) => b.length - a.length)[0];
        if (core && core.toLowerCase() !== value.toLowerCase()) candidates.push(core);
      } else if (isMake) {
        const compactMake1 = value.toLowerCase().replace(/[^a-z0-9]/g, "");
        candidates.push(...(EQUIPMENT_MAKE_ALIASES[compactMake1] ?? []), ...(this.certifiedAliases[compactMake1] ?? []));
      }
      return { key, candidates: [...new Set(candidates)], side: null };
    }
    const explicitlyPv = /module|pv ?array|solar|photovoltaic/.test(l);
    if (EQUIPMENT_NEGATIVE_GUARD.test(l) && !explicitlyPv) return null;

    // Array-geometry fields are side-agnostic — fill straight from project data.
    if (isTilt || isAzimuth || isTracking) {
      const key = isTilt ? "tilt" : isAzimuth ? "azimuth" : "tracking";
      const value = (this.equipment[key] || "").trim();
      return value ? { key, candidates: [value], side: null } : null;
    }

    const inverterSide = /inverter|micro/.test(l);
    // "panel" alone must NOT claim the module side — "Electrical Panel", "Sub
    // Panel" etc. are service equipment; only solar-flavored wording counts.
    const moduleSide = /module|pv ?array|solar panel|photovoltaic/.test(l);
    const side: "inverter" | "module" | null = inverterSide ? "inverter" : moduleSide ? "module" : fallbackSide ?? null;
    if (!side) return null;
    const key = side === "inverter"
      ? (isQty ? "inverterQty" : isModel ? "inverterModel" : "inverterMake")
      : (isQty ? "moduleQty" : isModel ? "moduleModel" : "moduleMake");
    const value = (this.equipment[key] || "").trim();
    if (!value) return null;
    const candidates = [value];
    if (isMake) {
      const compactMake2 = value.toLowerCase().replace(/[^a-z0-9]/g, "");
      candidates.push(...(EQUIPMENT_MAKE_ALIASES[compactMake2] ?? []), ...(this.certifiedAliases[compactMake2] ?? []));
      // First word as a last resort ("Znshine" finds "Znshine PV-Tech").
      const first = value.split(/\s+/)[0];
      if (first.length >= 5 && first.toLowerCase() !== value.toLowerCase()) candidates.push(first);
    } else if (isModel) {
      // Most distinctive model token: the longest run containing a digit
      // ("DS3-L" from "AP SYSTEMS DS3-L [240V]"; "ZXM7-UHLDD108-440/N" whole).
      const tokens = value.split(/[\s,()[\]{}]+/).filter((t) => /\d/.test(t) && t.length >= 3);
      const core = tokens.sort((a, b) => b.length - a.length)[0];
      if (core && core.toLowerCase() !== value.toLowerCase()) candidates.push(core);
    }
    return { key, candidates: [...new Set(candidates)], side };
  }

  /** The control's CURRENT value(s): for selects, the selected option's TEXT and
   *  VALUE (\u0007-joined — selectOption can legitimately land via the value
   *  attr while the display text shares no substring with our candidate); the
   *  input value otherwise. null = unreadable (e.g. unit-test fake page). */
  private async currentControlValue(field: ExtractedField): Promise<string | null> {
    try {
      const loc = await this.locator(field.selector);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!loc || typeof (loc as any).evaluate !== "function") return null; // can't read (e.g. unit-test fake page)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (loc as any).evaluate((el: Element) => {
        if ((el.tagName || "").toLowerCase() === "select") {
          const s = el as HTMLSelectElement;
          const opt = s.selectedIndex >= 0 ? s.options[s.selectedIndex] : null;
          const text = (opt?.textContent || "").trim();
          if (/^(please\s+)?select\.{0,3}$/i.test(text)) return "";
          return [text, (opt?.value || "").trim()].filter(Boolean).join("\u0007");
        }
        const tag = (el.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea") return (el as HTMLInputElement).value || "";
        // Custom div widget: `.value` is undefined → "" → every verify fails and the
        // field gets blacklisted even when the fill landed. Read its VISIBLE state
        // instead: an associated hidden input, the aria-activedescendant option text,
        // then the trimmed display text. All empty → null ("unreadable — trust applyFill").
        const hidden = el.querySelector('input[type="hidden"]') as HTMLInputElement | null;
        if (hidden && (hidden.value || "").trim()) return hidden.value.trim();
        const activeId = el.getAttribute("aria-activedescendant")
          || el.querySelector("[aria-activedescendant]")?.getAttribute("aria-activedescendant");
        if (activeId) {
          const opt = document.getElementById(activeId);
          const t = (opt?.textContent || "").trim();
          if (t) return t;
        }
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (text && !/^(please\s+)?select\.{0,3}$/i.test(text)) return text;
        return null;
      }).catch(() => null);
    } catch {
      return null;
    }
  }

  /** Does the control's current content match a candidate? Exact for numbers
   *  (candidate "12" must never "match" a stale "1" or "23"); substring both
   *  ways for names, but only with >= 4 chars on the contained side so a short
   *  fragment ("AP") can't satisfy "AP Systems". */
  private static equipmentValueMatches(currentRaw: string, candidate: string): boolean {
    const cand = candidate.trim().toLowerCase();
    if (!cand) return false;
    const candNumeric = /^[\d.,\s]+$/.test(cand);
    // DIGIT-SIGNATURE tolerance (mirrors comboboxFill.bestOptionMatch): certified lists
    // respell model names with minor letter variance (live PGE: plan-set
    // "ZXM7-UHLD108-440/N" vs certified "ZXM7-UHLDD108-440/N") — plain contains fails
    // and the verify rejects a CORRECT pick, so the pass retries and blacklists the
    // field. All digit groups + the leading alpha token are series-defining.
    const candDigits = Array.from(new Set(cand.match(/\d+/g) ?? []));
    const candAlpha = (cand.match(/[a-z]{2,}/i)?.[0] ?? "").toLowerCase();
    const digitSigApplies = candDigits.length >= 2 && candAlpha.length >= 2;
    for (const part of currentRaw.split("\u0007")) {
      const cur = part.trim().toLowerCase();
      if (!cur) continue;
      if (cur === cand) return true;
      if (candNumeric || /^[\d.,\s]+$/.test(cur)) continue; // numbers: exact only
      if (cand.length >= 4 && cur.includes(cand)) return true;
      if (cur.length >= 4 && cand.includes(cur)) return true;
      if (digitSigApplies && cur.includes(candAlpha)
          && candDigits.every((d) => new RegExp(`(^|\\D)${d}(\\D|$)`).test(cur))) return true;
    }
    return false;
  }

  /** Fill unresolved equipment manufacturer/model/quantity + array-geometry fields
   *  from project data. Returns how many were filled; appends recipe steps + labels
   *  like other passes. Fills in DOM order so a manufacturer select's AJAX postback
   *  lands before its dependent model select is attempted (applyFill then waits for
   *  the model option to exist via waitForOptionReady). */
  private async fillEquipmentSelects(
    fields: ExtractedField[],
    alreadyFilledLabels: string[],
    steps: RecipeStep[],
  ): Promise<number> {
    let filled = 0;
    // Proximity side-tracking for portals with NO usable section headers: once a
    // side is established (e.g. "Inverter Manufacturer"), the next few bare
    // fields ("Model", "Quantity") inherit it. STRICTLY BOUNDED: inheritance
    // dies after 3 fields, on any section change, and on any negative-guard hit
    // — on a sectionless page it must never leak PV data into a later racking/
    // generator/battery block's bare "Model".
    let lastSide: "inverter" | "module" | undefined;
    let lastSideAt = -1;
    let lastSection = "";
    // Bare labels REPEAT on spec pages ("Manufacturer"/"Model" under both the
    // module and inverter sections). alreadyFilledLabels dedupes by label alone,
    // which used to permanently skip the second section's fields after the first
    // filled — so only apply the label skip to labels that are UNIQUE on this page.
    const labelCounts = new Map<string, number>();
    for (const f of fields) {
      if (f.label) labelCounts.set(f.label, (labelCounts.get(f.label) || 0) + 1);
    }
    const labelSeen = new Map<string, number>();
    // Ordinal of bare combined selects seen within a spec-flavored section — see
    // the side heuristic below.
    let specBareSelectSeen = 0;
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      // Unlabeled / generic-labeled SELECTS stay in the pass: the PowerClerk
      // repeater template renders one bare "Please select..." combined equipment
      // dropdown per row with NO label at all — skipping label-less fields here
      // skipped exactly the controls this pass exists for.
      const bareSelect = field.fieldType === "select" &&
        (!field.label ||
          /^(please\s+)?select\.{0,3}$|^choose\b/i.test(field.label) ||
          // Row header as the label ("Inverter", "PV Array 2", "Battery"): pure
          // side wording with no field-kind keyword is the combined select too.
          /^(inverter|micro-?inverter|pv ?array|module|battery|energy storage)s?\s*#?\d*$/i.test(field.label.trim()));
      if (!field.label && !bareSelect) continue;
      const occurrence = labelSeen.get(field.label || "") ?? 0;
      labelSeen.set(field.label || "", occurrence + 1);
      if (field.fieldType === "button" || field.fieldType === "file" || field.fieldType === "checkbox" || field.fieldType === "radio") continue;
      const dupLabel = (labelCounts.get(field.label || "") || 0) > 1;
      if (field.label && !dupLabel && alreadyFilledLabels.includes(field.label)) continue;
      // Proximity only carries WITHIN one section and only a few fields deep.
      if ((field.section || "") !== lastSection) {
        lastSide = undefined;
        lastSection = field.section || "";
      }
      if (lastSide && i - lastSideAt > 3) lastSide = undefined;
      const context = `${field.section || ""} ${field.label}`.trim();
      // A negative-guard hit (battery/EV/generator/racking wording) ends any
      // inherited side immediately — the page has moved on to other equipment.
      if (EQUIPMENT_NEGATIVE_GUARD.test(context.toLowerCase())) lastSide = undefined;
      // SIDE for a bare combined select with no side wording anywhere (section is
      // just "PV System Specification", rows carry no labels): PowerClerk always
      // renders the Inverter row first, then its PV Array rows — so within a
      // spec-flavored section the FIRST bare select is the inverter, the rest are
      // arrays. A wrong guess is harmless: the fill is verified against the
      // option list and a wrong-side model/make never holds.
      const specSection = /pv system|system specification|generating (facility|system)/i.test(context);
      let fallbackSide = lastSide;
      if (bareSelect && !fallbackSide && specSection) {
        fallbackSide = specBareSelectSeen === 0 ? "inverter" : "module";
      }
      const resolved = this.equipmentValueFor(context, fallbackSide, bareSelect);
      if (bareSelect && specSection) specBareSelectSeen++;
      if (!resolved) continue;
      // A combined bare select never seeds proximity inheritance — its side may
      // be an ordinal guess, and leaking it onto a later bare "Qty" would let
      // inverter data overwrite an array quantity the planner already filled.
      if (resolved.side && !bareSelect) { lastSide = resolved.side; lastSideAt = i; }
      const failKey = `${resolved.key}::${context}`;
      if (this.equipmentFillFailed.has(failKey)) continue;
      // DUPLICATE LABELS make a label selector ambiguous — getByLabel("Quantity")
      // resolves to the FIRST match, so the inverter quantity would overwrite the
      // module quantity. Prefer the element's unique #id fallback (kept as the
      // step's primary with the label retained as a replay fallback); when there
      // is no id, pin the label selector to THIS occurrence via nth.
      let target = field;
      if (dupLabel && field.selector.label) {
        const frame = field.selector.frame ? { frame: field.selector.frame } : {};
        const cssFb = field.selector.fallbacks?.find((fb) => fb.css);
        target = cssFb?.css
          ? { ...field, selector: { css: cssFb.css, ...frame, fallbacks: [{ label: field.label, nth: occurrence, ...frame }] } }
          : { ...field, selector: { ...field.selector, nth: occurrence } };
      }
      // Already holding one of our values (e.g. a rescan pass)? Leave it alone —
      // re-selecting a manufacturer re-fires the portal's cascade and WIPES the
      // dependent model select that was just filled.
      const currentRaw = await this.currentControlValue(target);
      if (currentRaw && resolved.candidates.some((c) => AutoLearnAdapter.equipmentValueMatches(currentRaw, c))) {
        if (field.label) alreadyFilledLabels.push(field.label);
        continue;
      }
      let sawNotHeld = false;
      let success = false;
      for (const candidate of resolved.candidates) {
        const step = await this.applyFill(target, { value: candidate, field: resolved.key }, false);
        if (!step) continue;
        // VERIFY the select actually took the value: the custom-combobox fallback
        // can report success without changing a native select (seen with alias
        // candidate ordering — "AP Systems" no-ops, then the loop never reached
        // "Altenergy Power System"). A fill that didn't land tries the next candidate.
        if (target.fieldType === "select") {
          const raw = await this.currentControlValue(target);
          // null = unreadable (trust applyFill); a READ value must actually match.
          if (raw !== null && !AutoLearnAdapter.equipmentValueMatches(raw, candidate)) {
            sawNotHeld = true;
            this.debug?.event({ type: "equipment_fill_not_held", label: context.slice(0, 80), key: resolved.key, candidate: candidate.slice(0, 60) });
            continue;
          }
        }
        steps.push(step);
        if (field.label) alreadyFilledLabels.push(field.label);
        filled++;
        success = true;
        this.debug?.event({ type: "equipment_fill", label: context.slice(0, 80), key: resolved.key, candidate: candidate.slice(0, 60) });
        break;
      }
      // Every candidate applied but none held: remember and stop retrying this
      // field for the rest of the run (each retry burns option-wait caps).
      if (!success && sawNotHeld) this.equipmentFillFailed.add(failKey);
    }
    return filled;
  }

  // Resolve the document file to attach to a given file-input field. Matches the field's
  // label to a docType, then to an available split file in docsByType. Falls back to the
  // full package/plan set for a generic upload control. Returns null when nothing is
  // available (the upload is then left for the human, never faked).
  // Portal per-file size cap. Split-mode portals (PowerClerk NEM) reject big files —
  // PGE's limit is 5.00 MB — so never offer a file the portal will bounce. Combined-mode
  // AHJ portals (Accela) take the full plan set and typically allow much larger uploads.
  private uploadMaxBytes(): number {
    return portalUploadCapBytes(this.uploadMode);
  }

  // Size cache: docsByType is fixed at construction and the files don't change mid-run,
  // but one resolveUpload pass can stat the same file several times across its fallback
  // tiers, once per upload slot per page pass.
  private readonly fileSizeCache = new Map<string, number>();
  private fileSize(file: string): number {
    let size = this.fileSizeCache.get(file);
    if (size === undefined) {
      try { size = fs.statSync(file).size; } catch { size = -1; } // unreadable → treat as fitting; the upload attempt surfaces the real error
      this.fileSizeCache.set(file, size);
    }
    return size;
  }

  private fileFits(file: string, cap: number): boolean {
    if (!Number.isFinite(cap)) return true;
    const size = this.fileSize(file);
    return size < 0 || size <= cap;
  }

  private resolveUpload(field: ExtractedField, required = true): { docType: string; file: string } | null {
    const label = field.label || "";
    const cap = this.uploadMaxBytes();
    const fits = (docType: string) => this.docsByType[docType] && this.fileFits(this.docsByType[docType], cap);
    // Combined mode (Accela / Oregon ePermitting): attach the SINGLE full plan-set PDF to
    // every upload control regardless of label — the AHJ wants all plan pages as one PDF.
    // fits() applies here too so an explicit PORTAL_UPLOAD_MAX_MB override is honored
    // (the default combined cap is Infinity, so this normally passes everything through).
    if (this.uploadMode === "combined") {
      // Application/checklist slots keep their SPECIFIC filled PDF even in
      // combined mode — "Completed Building Permit Application" must never
      // receive the whole plan set when the filled form exists.
      for (const { re, docType } of UPLOAD_LABEL_PATTERNS.slice(0, 4)) {
        if (re.test(label) && fits(docType)) return { docType, file: this.docsByType[docType] };
      }
      for (const docType of ["plan_set", "combined_plan_set", "full_plan_set"]) {
        if (fits(docType)) return { docType, file: this.docsByType[docType] };
      }
      const firstKey = Object.keys(this.docsByType).find((k) => fits(k)) ?? Object.keys(this.docsByType)[0];
      return firstKey ? { docType: firstKey, file: this.docsByType[firstKey] } : null;
    }
    // 1) Label names a specific document → attach that docType if we have the split file.
    //    If the label matches but the split file isn't available yet, fall through to plan_set
    //    (the full plan PDF) rather than jumping straight to a ZIP or wrong document.
    let labelMatchedDocType: string | null = null;
    for (const { re, docType } of UPLOAD_LABEL_PATTERNS) {
      if (re.test(label)) {
        if (fits(docType)) return { docType, file: this.docsByType[docType] };
        labelMatchedDocType = docType; // label matched but split file missing/too large
        break;
      }
    }
    // OPTIONAL slot with no exact document: leave it EMPTY. The fallback tiers below
    // exist so a REQUIRED upload is never silently skipped — but stuffing a substitute
    // (e.g. the SLD) into an optional "Cut Sheets" / "Other" slot files the WRONG
    // document with the utility. The human can attach extras at review if wanted.
    if (!required) return null;
    // 1b) Specific label matched but split doc is missing → use plan_set as the best
    //     available substitute (a PDF the portal can actually accept), not a ZIP.
    if (labelMatchedDocType && fits("plan_set")) {
      return { docType: "plan_set", file: this.docsByType["plan_set"] };
    }
    // 2) Generic/unlabeled upload control → fall back to the full package/plan set.
    for (const docType of UPLOAD_FALLBACK_DOCTYPES) {
      if (fits(docType)) return { docType, file: this.docsByType[docType] };
    }
    // 3) Last resort: ANY available document that fits the portal's size cap, so a
    //    required upload isn't silently skipped.
    for (const key of Object.keys(this.docsByType)) {
      if (fits(key)) return { docType: key, file: this.docsByType[key] };
    }
    // 4) NOTHING fits the default cap. Never silently skip: many split-mode portals allow
    //    more than our 5 MB default, so attach the SMALLEST available doc and let the
    //    post-upload rejection scan catch a genuine bounce (visible + attributable),
    //    instead of leaving the slot empty on a portal that would have accepted the file.
    const smallest = Object.keys(this.docsByType)
      .map((docType) => ({ docType, file: this.docsByType[docType], size: this.fileSize(this.docsByType[docType]) }))
      .filter((c) => c.size >= 0)
      .sort((a, b) => a.size - b.size)[0];
    if (smallest) {
      this.debug?.event({
        type: "upload_over_cap_attempted",
        label: label.slice(0, 80),
        docType: smallest.docType,
        sizeMb: Math.round((smallest.size / 1024 / 1024) * 100) / 100,
        capMb: Math.round((cap / 1024 / 1024) * 100) / 100,
      });
      return { docType: smallest.docType, file: smallest.file };
    }
    return null;
  }

  // Resolve a docType for an upload control by its label only (no ExtractedField wrapper).
  private resolveUploadByLabel(label: string, required = true): { docType: string; file: string } | null {
    return this.resolveUpload({ selector: {}, label, fieldType: "file" }, required);
  }

  // Capture a full-page PNG of the current page as base64 for VISION-ASSISTED PLANNING, so the
  // planner can read the visible section headings + layout (the authoritative homeowner-vs-installer
  // signal) instead of guessing from labels. Learn-time only and best-effort: returns undefined when
  // disabled (PORTAL_VISION_PLAN=0), unavailable (test fakes), or on any capture error, in which case
  // the planner falls back to text-only. fullPage so headings above/below the fold are included.
  private async capturePlanScreenshot(): Promise<string | undefined> {
    if (process.env.PORTAL_VISION_PLAN === "0" || process.env.PORTAL_VISION_PLAN === "false") return undefined;
    if (!this.page || typeof this.page.screenshot !== "function") return undefined;
    try {
      const buf = await this.page.screenshot({ type: "png", fullPage: true });
      return Buffer.from(buf as Buffer).toString("base64");
    } catch {
      return undefined;
    }
  }

  // Extract interactive fields from the main document AND every child frame — including
  // CROSS-ORIGIN frames (Playwright reads them regardless of origin) — stamping each child
  // frame's stable key onto its fields so the fill/replay locator can target the right frame.
  // Portals like Accela render their contact and document-upload dialogs inside an <iframe>
  // (e.g. ACADialogFrame); some embed a third-party form widget in a cross-origin iframe.
  // Frame keys: name/id when the element has one, else "src:<pathname>" (frameSelectorFor
  // turns either into the frameLocator CSS). Only a frame with NO name/id AND no usable src
  // (about:blank, doc.write) is skipped — it can't be re-targeted at replay, so planning a
  // fill inside it would record an unreplayable step.
  // Never throws — falls back to a direct main-document scrape if frame enumeration is unavailable.
  private async extractAllFrames(extractSel: string): Promise<RawField[]> {
    if (!this.page) return [];
    const out: RawField[] = [];
    let frames: Frame[] = [];
    try { frames = typeof this.page.frames === "function" ? this.page.frames() : []; } catch { frames = []; }
    const main = typeof this.page.mainFrame === "function" ? this.page.mainFrame() : null;
    for (const frame of frames) {
      let frameKey: string | undefined;
      if (main && frame !== main) {
        try {
          const el = await frame.frameElement();
          frameKey = (await el.getAttribute("name")) || (await el.getAttribute("id")) || undefined;
          if (!frameKey) {
            // No name/id — key by the src URL's pathname (query strings carry per-session
            // tokens, so they'd break replay; the pathname is the stable part).
            const src = (await el.getAttribute("src")) || "";
            if (src && !/^about:|^javascript:/i.test(src)) {
              try {
                const u = new URL(src, this.page.url());
                if (u.pathname && u.pathname !== "/") frameKey = `src:${u.pathname}`;
              } catch { /* unparseable src — leave undefined */ }
            }
          }
        } catch { frameKey = undefined; }
        if (!frameKey) continue; // untargetable frame — skip so we never plan an unreplayable fill
      }
      try {
        const raws = await frame.$$eval(extractSel, extractFieldsInPage);
        for (const r of raws) { if (frameKey) r.frame = frameKey; out.push(r); }
      } catch { /* detached frame — skip */ }
    }
    // Safety net: if frame enumeration yielded nothing (e.g. a fake/stub page in tests, or an
    // older runtime), fall back to a direct main-document scrape so the loop still sees fields.
    if (!out.length) {
      try { out.push(...(await this.page.$$eval(extractSel, extractFieldsInPage))); } catch { /* ignore */ }
    }
    return out;
  }

  // Hard time bound for a whole PHASE. Playwright bounds individual actions, but a phase
  // that loops over several controls (uploads on a multi-row attachment section) has no
  // ceiling of its own — a live Coos Bay run sat in the upload phase for 10+ minutes and
  // only ended when the browser was closed. On timeout we log, return the fallback, and
  // let the loop move on rather than wedging the run.
  private async withPhaseTimeout<T>(phase: string, ms: number, fn: () => Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<T>((resolve) => {
          timer = setTimeout(() => {
            this.debug?.event({ type: "phase_timeout", phase, ms });
            resolve(fallback);
          }, ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Universal upload pass. Detects every document-upload control on the current page —
  // native <input type=file> AND custom Browse/Upload widgets whose real input is created
  // only on click — attaches the matching split document, and records a replayable `upload`
  // step. Returns labels filled + the labels of REQUIRED slots we had no document for.
  // Best-effort and non-throwing: a stuck upload never aborts the learn run.
  private async performUploads(
    steps: RecipeStep[],
    alreadyFilledLabels: string[],
  ): Promise<{ filled: string[]; missingRequired: string[]; attached: number }> {
    const filled: string[] = [];
    const missingRequired: string[] = [];
    // Count of files actually attached. Distinct from `filled`, which only records slots
    // that HAVE a visible label - Accela's attachment rows are unlabeled, so a label-based
    // signal reports zero even when the upload succeeded (and the Save pass never fires).
    let attached = 0;
    if (!this.page || typeof this.page.evaluate !== "function") return { filled, missingRequired, attached };

    let slots: UploadSlot[] = [];
    try {
      slots = await this.page.evaluate(tagUploadControls);
    } catch { return { filled, missingRequired, attached }; }
    if (!Array.isArray(slots) || slots.length === 0) return { filled, missingRequired, attached };

    // Attach keys already used THIS RUN. Per-visit scoping is not enough: Accela serves
    // every wizard step from the same CapEdit.aspx and the loop re-enters it many times,
    // so a per-visit set still re-attached the file on each pass (live: 3 pending rows of
    // one PDF). Key = pathname + slot label + file, so a labeled slot on another page can
    // still receive the same combined document.
    let pathKey = "";
    try { pathKey = new URL(String(this.page.url?.() ?? "")).pathname.toLowerCase(); } catch { pathKey = ""; }
    for (const slot of slots) {
      const resolved = this.resolveUploadByLabel(slot.label, !!slot.required);
      if (!resolved) {
        // No document for this control — never fake it. Report it if the portal requires it.
        if (slot.required) missingRequired.push(slot.label || "Required document");
        continue;
      }
      // DUPLICATE-ROW GUARD. A LABELED slot names the document it wants, so combined mode
      // legitimately gives each one the same plan set. An UNLABELED/generic slot is just a
      // repeated attachment row (Accela's Attachment section renders several) — attaching
      // the same file to each creates duplicate rows that EACH demand their own required
      // Description + Type, which then block the page (live Coos Bay: 3 rows of one PDF,
      // two of them empty and flagged). One attach per file through generic slots.
      const genericLabel = !slot.label || /^(browse|upload|attach|choose(\s+file)?|add\s+file|select\s+file|file|document|attachment)\b/i.test(slot.label.trim());
      const attachKey = `${pathKey}::${genericLabel ? "" : slot.label.trim().toLowerCase()}::${resolved.file}`;
      if (this.attachedKeys.has(attachKey)) {
        this.debug?.event({ type: "upload_dedupe", why: "this document was already attached to this control during the run", docType: resolved.docType });
        continue;
      }
      const selector: RecipeSelector = { css: `[data-al-upl="${slot.key}"]` };
      // Baseline of visible error banners BEFORE this attach — only a NEW banner after the
      // settle counts as THIS slot's rejection (a persistent banner from an earlier slot
      // must not fail every subsequent upload on the page).
      const bannersBefore = await this.collectUploadBannerTexts();
      // Upload under a CLEAN filename: stored files are prefixed with the document row's
      // UUID for on-disk uniqueness (e.g. "7fd69186-…-Javier_…_SLD_one-line.pdf"), but that
      // prefix must not leak into what the utility/AHJ reviewer sees. Read the bytes and
      // attach as a payload named without the UUID prefix.
      const uploadPayload = (() => {
        const base = path.basename(resolved.file);
        const clean = base.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "");
        try {
          const buffer = fs.readFileSync(resolved.file);
          const ext = path.extname(clean).toLowerCase();
          const mimeType = ext === ".pdf" ? "application/pdf"
            : ext === ".png" ? "image/png"
            : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
            : ext === ".zip" ? "application/zip"
            : "application/octet-stream";
          return { name: clean || base, mimeType, buffer };
        } catch {
          return null; // unreadable — fall back to the path (Playwright reads it itself)
        }
      })();
      const res = await safeAction(
        `upload ${resolved.docType}`,
        async () => {
          if (slot.kind === "input") {
            // Native input — set files directly even when visually hidden behind a button.
            const loc = this.page!.locator(selector.css!);
            await loc.setInputFiles(uploadPayload ?? resolved.file);
          } else {
            // Custom widget — the real <input> is created on click, so intercept the
            // browser's file-chooser dialog (works for ANY uploader, no DOM coupling).
            const [chooser] = await Promise.all([
              this.page!.waitForEvent("filechooser", { timeout: 8000 }),
              this.page!.locator(selector.css!).click({ timeout: 6000 }),
            ]);
            await chooser.setFiles(uploadPayload ?? resolved.file);
          }
          await smartWait(this.page!, 500);
        },
        { required: false },
      );
      // setInputFiles resolving does NOT mean the portal accepted the file — PowerClerk
      // validates async and shows "Could not upload file. File size exceeds the 5.00 MB
      // limit." while the step would otherwise be recorded as a success. Scrape for a
      // rejection banner after the upload settles; on rejection, drop the step and flag
      // the slot so the human (and the result message) see the real failure.
      let rejected: string | null = null;
      if (res.ok && !res.message) {
        await sleep(1200);
        rejected = this.detectNewUploadRejection(bannersBefore, await this.collectUploadBannerTexts());
      }
      if (res.ok && !res.message && !rejected) {
        this.attachedKeys.add(attachKey);
        attached++;
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
      } else if (rejected) {
        this.debug?.event({ type: "upload_rejected", label: (slot.label || "").slice(0, 80), docType: resolved.docType, message: rejected.slice(0, 160) });
        // Only a REQUIRED slot's rejection blocks; an optional slot's is informational.
        if (slot.required) missingRequired.push(`${slot.label || "Document"} (portal rejected the upload: ${rejected.slice(0, 120)})`);
      } else if (slot.required) {
        // Detected + required + we had a file, but the attach failed — still flag for the human.
        missingRequired.push(slot.label || "Required document");
      }
    }
    return { filled, missingRequired, attached };
  }

  // Snapshot the VISIBLE error-banner texts currently on the page. Two uses per upload:
  // BEFORE the attach (baseline) and AFTER the settle — only a banner that is NEW since
  // the baseline counts as this slot's rejection. Without the delta, slot 1's persistent
  // "file size exceeds the 5.00 MB limit" banner (PowerClerk keeps it until dismissed)
  // would falsely reject every later slot on the page; and without the visibility check,
  // a hidden .error template node containing limit text would reject every upload.
  private async collectUploadBannerTexts(): Promise<string[]> {
    try {
      return await this.page!.evaluate(() => {
        const sel = "[role=alert], .alert-danger, .alert-error, .validation-summary-errors, .error, .field-validation-error, .text-danger";
        return Array.from(document.querySelectorAll(sel))
          .filter((el) => {
            const he = el as HTMLElement;
            return typeof he.getClientRects !== "function" || he.getClientRects().length > 0;
          })
          .map((el) => (el.textContent || "").trim())
          .filter((t) => t.length > 0 && t.length < 500);
      });
    } catch { return []; }
  }

  private static readonly UPLOAD_REJECTION_RE =
    /(could not upload|upload failed|file size exceeds|exceeds the .{0,20}limit|too large|file type (is )?not (allowed|supported)|invalid file type)/i;

  private detectNewUploadRejection(before: string[], after: string[]): string | null {
    const baseline = new Set(before);
    for (const t of after) {
      if (!baseline.has(t) && AutoLearnAdapter.UPLOAD_REJECTION_RE.test(t)) return t;
    }
    return null;
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
      // Status + redacted message only — performLogin never returns credentials.
      this.debug?.event({ type: "login", status: result.status, startUrl: context.startUrl ? safeHostPath(context.startUrl) : null });
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
      this.debug?.event({ type: "login_error", message: err instanceof Error ? err.message : String(err) });
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

  // PATCH-BY-DEMONSTRATION: arm the (still-open, headed) page so anything the human
  // fixes by hand at the review handoff — a missed dropdown, an unmapped field — is
  // captured as RecipeSteps and streamed to the caller for merging into the learned
  // recipe. Called by learnPortal() only when the browser is left open at review.
  async armHumanCapture(onStep: (step: RecipeStep) => void): Promise<boolean> {
    if (!this.page) return false;
    const armed = await armHumanCaptureOnPage(this.page as Page, (step) => {
      this.debug?.event({ type: "human_patch_step", action: step.action, note: (step.note || "").slice(0, 80) });
      onStep(step);
    });
    if (armed) this.debug?.event({ type: "human_capture_armed" });
    return armed;
  }

  async learn(context: PortalContext, project: ProjectRecord): Promise<LearnResult> {
    // Run a 5s heartbeat for the whole learn run so the UI can tell a slow step from a hung
    // one (elapsedMs climbs, then a real event resets it). try/finally guarantees the timer is
    // cleared on every exit path — early `return fail(...)`, success, or a thrown error.
    this.startHeartbeat();
    // Playwright trace of the learn loop (DOM snapshots + actions + network). Started HERE —
    // after login — so credentials never enter the trace; saved into the run's debug bundle.
    await this.debug?.startTrace(this.page);
    let result: LearnResult | null = null;
    try {
      result = await this.learnImpl(context, project);
      return result;
    } catch (err) {
      // The thrown error is about to leave the adapter as a bare message — persist the stack
      // into the bundle so the failure is diagnosable from the artifacts alone.
      this.debug?.event({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? (err.stack || "").split("\n").slice(0, 12).join("\n") : undefined,
      });
      throw err;
    } finally {
      this.stopHeartbeat();
      await this.debug?.stopTrace(this.page);
      this.debug?.finalize({
        outcome: result ? (result.pauseReason ? "paused" : result.ok ? "ok" : "failed") : "error",
        ok: result?.ok ?? false,
        pauseReason: result?.pauseReason ?? null,
        reachedReview: result?.reachedReview ?? false,
        pageCount: result?.pageCount ?? 0,
        stepsRecorded: result?.steps.length ?? 0,
        message: result?.message ?? "learn threw before producing a result — see events.jsonl for the error/stack.",
      });
      // Stamp the bundle path onto the result (the object was already returned by reference,
      // so this reaches the caller) — it's how the backend + UI surface "where to look".
      if (result && this.debug) result.debugDir = this.debug.dir;
    }
  }

  // ---------------------------------------------------------------------------
  // ACCELA (ACA) DETERMINISTIC PASSES. Oregon ePermitting's Apply flow has three
  // steps the LLM planner reliably fumbled on live Salem runs (2026-08-27 bundles):
  //   1. entry T&C (CapApplyDisclaimer) — agree checkbox + "Continue Application";
  //   2. "Enter Work Site Location" — the street-number control is an UNLABELED
  //      from/to range pair (name …txtStreetNo4Search$ChildControl0/1), so the
  //      planner left the number EMPTY; and the page carries TWO "Search" controls
  //      (the header-nav tab and the panel button) — every live run clicked the
  //      NAV tab and bounced into the records/search module (CapHome), so no run
  //      ever reached record-type selection;
  //   3. record-type selection — a checkbox list of application types + Continue.
  // Selector hooks are the live-verified ones from the hand-coded
  // OregonEPermittingAdapter (operator codegen) plus the captured extractions in
  // data/learn-runs/2026-08-27_*_city-of-salem_*. Every pass bails to the planner
  // when its hooks don't match. Steps are recorded for replay (literal address
  // parts — the post-learn binding pass evaluates them like any other literal).
  // ---------------------------------------------------------------------------

  private isAcaUrl(url: string): boolean {
    return /accela\.com|citizenaccess/i.test(url || "");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private acaContinueLocator(): any {
    if (!this.page) throw new Error("acaContinueLocator called before login() opened a page");
    return this.page.locator(ACA_CONTINUE_CSS).first();
  }

  // Derive the Apply-flow entry URL (Building-module disclaimer) from any ACA page
  // URL: /{instance}/Cap/CapHome.aspx → /{instance}/Cap/CapApplyDisclaimer.aspx.
  // The learner only ever drives ACA for the PERMIT track (utilities are PowerClerk),
  // so module=Building is the right wizard for both structural and electrical.
  private acaApplyEntryUrl(url: string): string | null {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/^(.*)\/Cap\/[^/]+$/i);
      if (!m) return null;
      return `${u.origin}${m[1]}/Cap/CapApplyDisclaimer.aspx?module=Building`;
    } catch { return null; }
  }

  // The records/search module — NOT part of the Apply wizard. A learner that lands here
  // has drifted (live: the header-nav "Search" click). CapHome is the "Applications &
  // Permits" list + General Search; CapDetail is an EXISTING record's detail view. Both
  // are full of controls that act on the operator's REAL filings ("Resume Application",
  // "Pay Fees Due", record links, attachment uploads) — the learner must never operate
  // them. Detect by URL + the module's own captured control names, so an ACA build that
  // reuses these URLs for wizard steps is left to the planner rather than misdetected.
  private acaWrongModulePage(url: string, fields: ExtractedField[]): "records_home" | "record_detail" | null {
    if (!this.isAcaUrl(url)) return null;
    let pathname = "";
    try { pathname = new URL(url).pathname.toLowerCase(); } catch { return null; }
    const marker = (re: RegExp) =>
      fields.some((f) => re.test(f.label || "") || re.test(f.selector?.name || "") || re.test(f.selector?.css || ""));
    if ((pathname.endsWith("/cap/caphome.aspx") || pathname.endsWith("/cap/myrecordscap.aspx")) && marker(/generalsearchform|gdvpermitlist/i)) return "records_home";
    if (pathname.endsWith("/cap/capdetail.aspx") && marker(/addfordetailpage|attachmentedit/i)) return "record_detail";
    return null;
  }

  // Entry T&C: agree + continue without burning an LLM call. The agree checkbox id is
  // …termAccept on the live build (codegen-verified); role-name fallback for others.
  private async accelaDisclaimerPass(steps: RecipeStep[]): Promise<boolean> {
    const page = this.page;
    if (!page) return false;
    let agree = page.locator("input[id$='termAccept'], input[name$='termAccept']").first();
    if (!(await agree.count().catch(() => 0))) agree = page.getByRole("checkbox", { name: /i have read and agree|agree|accept/i }).first();
    if (!(await agree.count().catch(() => 0))) return false;
    await agree.check({ timeout: 8000 }).catch(() => null);
    const cont = this.acaContinueLocator();
    if (!(await cont.count().catch(() => 0))) return false;
    const preUrl = typeof page.url === "function" ? String(page.url() ?? "") : "";
    await cont.click({ timeout: 10000 }).catch(() => null);
    await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout?.(1500).catch(() => null);
    // Record ONLY on a verified advance — the check/click above swallow failures, and an
    // unverified true would re-run the pass (cap 3) and duplicate the accept/continue
    // pair in the recipe. Still sitting on the same disclaimer URL → bail to the planner.
    const postUrl = typeof page.url === "function" ? String(page.url() ?? "") : "";
    if (postUrl && postUrl === preUrl && /CapApplyDisclaimer/i.test(postUrl)) return false;
    // Recorded selectors carry the SAME breadth the pass matched with (id OR name css;
    // role-name as fallback) so a build that only the wider union matched still replays.
    steps.push({ action: "check", phase: "fill", selector: { css: "input[id$='termAccept'], input[name$='termAccept']", fallbacks: [{ role: "checkbox", name: "I have read and agree" }] }, note: "accela: accept entry terms" });
    steps.push({ action: "click", phase: "fill", selector: { css: ACA_CONTINUE_CSS, fallbacks: [{ role: "button", name: "Continue Application »" }] }, note: "accela: continue past entry disclaimer" });
    return true;
  }

  private async accelaWorkLocationPass(project: ProjectRecord, steps: RecipeStep[]): Promise<boolean> {
    const page = this.page;
    if (!page) return false;
    const bail = (why: string): false => { this.debug?.event({ type: "work_location_bail", why }); return false; };
    const addr = String(project.projectAddress ?? "");
    // The live-tested parsers from the hand-coded adapter: number = first token of the
    // street LINE; name = the CORE name only ("925 N Grant St" → "Grant" — direction and
    // suffix in the search field return zero results).
    const streetNo = parseStreetNumber(addr);
    const nameCore = parseStreetName(addr);
    if (!streetNo || !nameCore) return bail("address unparseable");
    // Some ACA builds render the wizard inside an IFRAME — resolve the frame holding the
    // WorkLocation controls first (aca-oregon renders top-level, so page scope wins there).
    // EVERYTHING below must stay in this scope: results, retries, row selection, and the
    // Continue click all live in the same frame as the inputs.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let scope: any = page;
    let frameKey: string | undefined;
    try {
      const main = typeof page.mainFrame === "function" ? page.mainFrame() : null;
      for (const f of (typeof page.frames === "function" ? page.frames() : [])) {
        if (main && f === main) continue;
        if (await f.locator("input[id*='StreetNo4Search'], input[name*='StreetNo4Search']").count().catch(() => 0)) {
          scope = f;
          // Same frame-key derivation as extractAllFrames, so the recorded steps carry
          // selector.frame and replay into the right frame (a bare css selector on the
          // main page finds nothing on iframe builds).
          try {
            const el = await f.frameElement();
            frameKey = (await el.getAttribute("name")) || (await el.getAttribute("id")) || undefined;
            if (!frameKey) {
              const src = (await el.getAttribute("src")) || "";
              if (src && !/^about:|^javascript:/i.test(src)) {
                const u = new URL(src, String(typeof page.url === "function" ? page.url() : ""));
                if (u.pathname && u.pathname !== "/") frameKey = `src:${u.pathname}`;
              }
            }
          } catch { frameKey = undefined; }
          break;
        }
      }
    } catch { /* keep page scope */ }
    const inFrame: Partial<RecipeSelector> = frameKey ? { frame: frameKey } : {};
    // ACA is classic ASP.NET — the street-number pair has NO label/aria (watermark hints
    // only), so getByLabel misses it. The stable hooks are the control ids/names
    // (…txtStreetNo4Search$ChildControl0/1 — a from/to range; fill the FROM box only,
    // ACA matches an exact number). Captured live: p003-plan.json in the Salem bundles.
    let numBox = scope.locator("input[id*='StreetNo4Search'], input[name*='StreetNo4Search']").first();
    if (!(await numBox.count().catch(() => 0))) numBox = scope.getByLabel(/street number/i).first();
    let nameBox = scope.locator("input[id*='txtStreetName'], input[name*='txtStreetName']").first();
    if (!(await nameBox.count().catch(() => 0))) nameBox = scope.getByLabel(/street name/i).first();
    if (!(await numBox.count().catch(() => 0)) || !(await nameBox.count().catch(() => 0))) return bail("street inputs not found (checked frames)");
    // The address panel's OWN Search control — NEVER a bare role/name "Search", which
    // also matches the header-nav Search tab (the live drift that left the wizard).
    // Precise codegen-verified suffix first, then the PlaceHolderMain-scoped generic
    // (…_btnSearch never matches the nav — the nav lives outside PlaceHolderMain).
    const searchBtn = scope.locator(
      "a[id$='WorkLocationEdit_btnSearch'], a[id^='ctl00_PlaceHolderMain'][id$='_btnSearch'], input[id^='ctl00_PlaceHolderMain'][id$='_btnSearch'], button[id^='ctl00_PlaceHolderMain'][id$='_btnSearch']",
    ).first();
    if (!(await searchBtn.count().catch(() => 0))) return bail("address panel search button not found");
    // Results detection must POLL: ACA renders the grid (and the "Address Not Found"
    // banner) via partial postbacks, so a single fixed-delay read can see the PREVIOUS
    // attempt's stale banner and falsely bail (live Coos Bay run: the retry's verdict
    // was read ~2s after the click, against the first attempt's banner).
    const resultRows = async (): Promise<number> => {
      const links = await scope.getByRole("link", { name: /^Select$/i }).count().catch(() => 0);
      if (links) return links;
      return await scope.locator("table input[type='radio'], table input[type='checkbox']").count().catch(() => 0);
    };
    const noResultsText = async (): Promise<boolean> => {
      const body = String((await scope.locator("body").innerText().catch(() => "")) ?? "");
      return /address not found|no records? (were )?found|returned no results|no results (were )?found/i.test(body);
    };
    // Returns "results" | "empty" | "unknown" after polling up to ~12s.
    const doSearch = async (nameValue: string): Promise<"results" | "empty" | "unknown"> => {
      await numBox.fill(streetNo).catch(() => null);
      await nameBox.fill(nameValue).catch(() => null);
      await searchBtn.click({ timeout: 10000 }).catch(() => null);
      await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => null);
      let sawEmpty = 0;
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout?.(1000).catch(() => null);
        if (await resultRows()) return "results";
        // Require the banner on TWO consecutive polls so a stale banner mid-postback
        // (about to be replaced by the grid) doesn't end the attempt early.
        if (await noResultsText()) { if (++sawEmpty >= 2) return "empty"; }
        else sawEmpty = 0;
      }
      return (await noResultsText()) ? "empty" : "unknown";
    };
    // The portal's own hint — "enter JUST the exact street number and a portion of the
    // street name. For example, enter 1234 pin instead of 1234 Pine St" — and this
    // build's Street Name watermark ("First 3 characters only") both say the PORTION
    // leads. Full core name is the fallback for builds that match full names.
    let nameUsed = nameCore.slice(0, 3);
    let outcome = await doSearch(nameUsed);
    if (outcome !== "results" && nameCore.length > 3) {
      this.debug?.event({ type: "work_location_retry", why: `no results for 3-char portion (${outcome}) — retrying with the full core name` });
      nameUsed = nameCore;
      outcome = await doSearch(nameUsed);
    }
    if (outcome !== "results") return bail(`address search returned no results (${outcome})`);
    // Forensics: capture the result rows' text (address + jurisdiction offerings) so a
    // wrong-row selection is diagnosable from the bundle alone (address only — already
    // part of this run's data, no new PII).
    try {
      const gridText = String((await scope.locator("table").filter({ hasText: /APPLICATIONS|Select/i }).first().innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").slice(0, 400);
      if (gridText) this.debug?.event({ type: "work_location_rows", rows: gridText });
    } catch { /* forensics only */ }
    // The fills are BOUND (field:), not literal — portal_recipes are shared, so a replay
    // must search THAT project's address, never the learn project's. The backend's
    // resolveRecipeFieldValues derives both keys with the same addressParse helpers.
    steps.push({ action: "fill", phase: "fill", selector: { css: "input[id*='StreetNo4Search']", fallbacks: [{ label: "Street Number" }], ...inFrame }, field: "streetNumber", value: streetNo, note: "work location: street number" });
    // When THIS portal only matched the 3-char portion (the retry fired), bind the
    // portion key — replaying the full core name would re-hit the same zero-result
    // wall on every future project, and the replay has no retry of its own.
    steps.push({ action: "fill", phase: "fill", selector: { css: "input[id*='txtStreetName']", fallbacks: [{ label: "Street Name" }], ...inFrame }, field: nameUsed === nameCore ? "streetNameCore" : "streetNameSearchPortion", value: nameUsed, note: "work location: street name (portion)" });
    // Recorded with the SAME union breadth the pass matched with, so a build whose
    // panel search is an input/button (not an <a>) still replays.
    steps.push({ action: "click", phase: "fill", selector: { css: "a[id$='WorkLocationEdit_btnSearch'], a[id^='ctl00_PlaceHolderMain'][id$='_btnSearch'], input[id^='ctl00_PlaceHolderMain'][id$='_btnSearch'], button[id^='ctl00_PlaceHolderMain'][id$='_btnSearch']", ...inFrame }, note: "work location: search" });
    // Result selection. Oregon's grid lists the SAME address once per jurisdiction
    // offering (CITY APPLICATIONS → structural/building; COUNTY APPLICATIONS →
    // electrical) with a per-row "Select" link — pick by permit discipline, narrowed by
    // city when known (the hand-coded adapter's live-verified logic). Other ACA builds
    // render a radio/checkbox per address row instead.
    const isElectrical = /elec/i.test(project.permitType ?? "");
    const rowText = isElectrical ? "COUNTY APPLICATIONS" : "CITY APPLICATIONS";
    const cityUpper = (project.city || "").toUpperCase();
    let selected = false;
    const selectLinks = scope.getByRole("link", { name: /^Select$/i });
    if (await selectLinks.count().catch(() => 0)) {
      let rows = scope.locator("tr", { hasText: new RegExp(rowText, "i") });
      if (cityUpper) rows = rows.filter({ hasText: cityUpper });
      const rowLink = rows.getByRole("link", { name: /^Select$/i }).first();
      const link = (await rowLink.count().catch(() => 0)) ? rowLink : selectLinks.first();
      // Verified action → recorded step: a swallowed click failure recorded anyway
      // leaves a duplicate pair once the planner retakes the page.
      if (!(await link.click({ timeout: 15000 }).then(() => true).catch(() => false))) return bail("address row select click failed");
      // The ROW CONTEXT is baked into the recorded selector — a bare role/name "Select"
      // resolves to .first() at replay and silently files under the wrong jurisdiction.
      steps.push({ action: "click", phase: "fill", selector: { css: `tr:has-text("${rowText}") a:has-text("Select")`, fallbacks: [{ role: "link", name: "Select", exact: true }], ...inFrame }, note: `work location: select ${isElectrical ? "county/electrical" : "city/structural"} address row` });
      selected = true;
    } else {
      const pick = scope.locator("table input[type='radio'], table input[type='checkbox']").first();
      if (await pick.count().catch(() => 0)) {
        if (!(await pick.check().then(() => true).catch(() => false))) return bail("address result radio check failed");
        steps.push({ action: "check", phase: "fill", selector: { css: "table input[type='radio']", ...inFrame }, note: "work location: select first address result" });
        selected = true;
      }
    }
    if (!selected) return bail("no address results to select");
    await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout?.(1000).catch(() => null);
    // Selecting the row can itself advance the wizard (ASP.NET postback). Only click
    // Continue when we are STILL on the WorkLocation step — clicking it after an
    // auto-advance would skip the record-type page unanswered. On iframe builds the
    // step URL lives on the FRAME, not the top page.
    const currentUrl = typeof scope.url === "function"
      ? String(scope.url() ?? "")
      : (typeof page.url === "function" ? String(page.url() ?? "") : "");
    if (/worklocation/i.test(currentUrl)) {
      const cont = scope.locator(ACA_CONTINUE_CSS).first();
      if (await cont.count().catch(() => 0)) {
        // Record only a Continue that actually clicked — on failure the planner retakes
        // the page next iteration and records its own advance instead.
        if (await cont.click({ timeout: 10000 }).then(() => true).catch(() => false)) {
          steps.push({ action: "click", phase: "fill", selector: { css: ACA_CONTINUE_CSS, fallbacks: [{ role: "button", name: "Continue Application »" }], ...inFrame }, note: "work location: continue" });
        }
        await page.waitForLoadState?.("networkidle", { timeout: 20000 }).catch(() => null);
        await page.waitForTimeout?.(2000).catch(() => null);
      }
    }
    return true;
  }

  // First VISIBLE match for a css selector. ASP.NET pages carry hidden inputs whose ids
  // contain the same token as the real control (state fields, collapsed second contact
  // blocks), so a bare .first() can type into an invisible input while the field the
  // reviewer sees keeps the portal's own prefill — live: the applicant ZIP read 98664 on
  // screen while our 98683 went somewhere invisible, and the primary phone ended in
  // digits belonging to neither party. Falls back to .first() on a stub locator.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async firstVisible(scope: any, css: string): Promise<any | null> {
    const all = scope.locator(css);
    const n = await all.count().catch(() => 0);
    if (!n) return null;
    for (let i = 0; i < n; i++) {
      const c = all.nth(i);
      if (typeof c.isVisible !== "function") return all.first();
      if (await c.isVisible().catch(() => false)) return c;
    }
    return null;
  }

  // CLOSE the ACA dialog and WAIT for it to actually go away. After a save, ACA leaves the
  // dialog iframe in the DOM — so "are there inputs in the frame" never reports closed, and
  // the still-present overlay silently swallows the NEXT click (live: the Site Contact's
  // Add New and then Continue Application both returned without doing anything, and the
  // page was handed back to the planner mid-modal). Visibility of the iframe ELEMENT is the
  // honest signal. Returns true when the dialog is gone.
  private async closeAcaDialog(): Promise<boolean> {
    const page = this.page;
    if (!page) return true;
    const frameEl = page.locator('iframe[name="ACADialogFrame"]').first();
    // typeof guard, not `?.()`: optional chaining stops at the CALL, so `.catch()` would
    // then run on undefined and throw (a stub locator has no isVisible).
    const stillUp = async (): Promise<boolean> => {
      if ((await frameEl.count().catch(() => 0)) === 0) return false;
      if (typeof frameEl.isVisible !== "function") return false;
      return await frameEl.isVisible().catch(() => false);
    };
    if (!(await stillUp())) return true;
    // The modal's own close control first, then Escape.
    for (const sel of ["#ACADialogFrame_Close", ".ui-dialog-titlebar-close", 'a[title="Close" i]', 'button[aria-label="Close" i]', 'img[alt="Close" i]']) {
      const c = page.locator(sel).first();
      const closeVisible = (await c.count().catch(() => 0)) > 0
        && (typeof c.isVisible === "function" ? await c.isVisible().catch(() => false) : false);
      if (closeVisible) {
        await c.click({ timeout: 4000 }).catch(() => null);
        break;
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kb = (page as any)?.keyboard;
    if (kb && typeof kb.press === "function") await kb.press("Escape").catch(() => null);
    for (let i = 0; i < 10; i++) {
      if (!(await stillUp())) return true;
      await page.waitForTimeout?.(500).catch(() => null);
    }
    this.debug?.event({ type: "aca_dialog_still_open" });
    return false;
  }

  // ACA CONTACT step (CapEdit "Step 1: General Info > Applicant"): a section with a
  // "Select from Account" button + an "Add New" button. The operator's ePermitting
  // account carries MANY pre-existing contacts (leftovers from other filings), and the
  // account-dialog's Continue stays disabled until a radio is picked — the planner
  // stalls there (live Coos Bay: stuck ×3 → recovery exhausted). Per the operator, the
  // right move is "Add New" with THIS filing's contractor identity. Detect the contacts
  // page by the Add New control + an Applicant/Contact section, and only BEFORE any
  // dialog is open.
  private acaContactPageDetected(fields: ExtractedField[], _bodyText: string): boolean {
    // Detect from the extracted CONTROLS, never from bodyText: that is capped at 2000
    // chars and ACA's nav chrome pushes the "Applicant" / "Select from Account" wording
    // past the cap, so a text-based gate silently never fires (live: the planner then
    // opened the account picker itself). The "Select from Account" + "Add New" button
    // PAIR is the contact section's signature.
    const btn = (re: RegExp) => fields.some((f) => f.fieldType === "button" && re.test(f.label || ""));
    const hasContactPair = btn(/select from account/i) && btn(/add new/i);
    if (!hasContactPair) return false;
    if (!this.hasContactIdentity()) return false;
    // A dialog already open is still ours to finish — the pass cancels the account
    // picker and takes the Add New path instead.
    return true;
  }

  private hasContactIdentity(): boolean {
    const any = (c: ContactIdentity) => Boolean(c.lastName || c.email);
    return any(this.contactIdentity) || any(this.siteContactIdentity);
  }

  // ACA renders the contact sections in a fixed order (Applicant, then Site Contact),
  // each with its own "Select from Account" / "Add New" pair. Section 0 is the filing
  // CONTRACTOR; section 1 is the PROPERTY OWNER.
  private identityForSection(index: number): ContactIdentity {
    return index === 0 ? this.contactIdentity : this.siteContactIdentity;
  }

  // Click "Add New", then fill the contractor identity into the ACADialogFrame form
  // (First/Last/Email/Phone by row-label; the dialog's own Continue commits it). Bails
  // to the planner if Add New or the dialog can't be resolved.
  private async accelaAddContactPass(steps: RecipeStep[], sectionIndex: number, usedAddNew: string[] = []): Promise<{ ok: boolean; usedId: string }> {
    const page = this.page;
    if (!page) return { ok: false, usedId: "" };
    const id = this.identityForSection(sectionIndex);
    const who = sectionIndex === 0 ? "applicant" : "site contact";
    // Steps recorded from here belong to THIS section; if the portal turns out not to have
    // attached the contact, they are rolled back so the recipe never replays a save that
    // achieved nothing.
    const stepMark = steps.length;
    if (!id.lastName && !id.email) { this.debug?.event({ type: "contact_add_bail", why: `no identity for section ${sectionIndex} (${who})` }); return { ok: false, usedId: "" }; }
    const dlg = page.frameLocator('iframe[name="ACADialogFrame"]');
    // The planner may already have opened the ACCOUNT PICKER ("Select Contact from
    // Account"). Never pick from it: on a shared operator account that attaches another
    // company's contact to this filing, and even on a per-client login it attaches an
    // arbitrary colleague rather than the person filing. Cancel it and use Add New.
    const cancel = dlg.getByRole("link", { name: /^cancel$/i }).or(dlg.getByRole("button", { name: /^cancel$/i })).first();
    if (await cancel.count().catch(() => 0)) {
      await cancel.click({ timeout: 6000 }).catch(() => null);
      this.debug?.event({ type: "contact_account_picker_cancelled" });
      await page.waitForTimeout?.(1200).catch(() => null);
    }
    const addNewAll = page.getByRole("button", { name: /add new/i })
      .or(page.getByRole("link", { name: /add new/i }))
      .or(page.locator('input[value*="Add New" i], button:has-text("Add New"), a:has-text("Add New")'));
    const addNewCount = await addNewAll.count().catch(() => 0);
    if (!addNewCount) { this.debug?.event({ type: "contact_add_bail", why: "no Add New control", section: sectionIndex }); return { ok: false, usedId: "" }; }
    // Pick by ELEMENT IDENTITY, never by position. Once a section is saved ACA re-renders
    // it with Edit/Remove and its Add New disappears, so indices shift; and if the save has
    // not settled yet the applicant's button is still there, so "first visible" re-opened
    // the SAME dialog and overwrote the applicant with the owner's details (live Coos Bay:
    // Charles Bitton became Wynema Wright over the contractor's street). Skipping the ids
    // we already used makes reusing a section structurally impossible.
    let addNew: any = null;
    let usedId = "";
    for (let i = 0; i < addNewCount; i++) {
      const candidate = addNewAll.nth(i);
      // typeof guards, not `?.()`: optional chaining stops at the CALL, so `.catch()`
      // would then run on undefined and throw. A stub locator (tests) counts as visible.
      const visible = typeof candidate.isVisible === "function"
        ? await candidate.isVisible().catch(() => false)
        : true;
      if (!visible) continue;
      const cid = (typeof candidate.getAttribute === "function"
        ? String((await candidate.getAttribute("id").catch(() => "")) ?? "")
        : "") || `idx:${i}`;
      if (usedAddNew.includes(cid)) continue;
      addNew = candidate;
      usedId = cid;
      break;
    }
    if (!addNew) { this.debug?.event({ type: "contact_add_bail", why: `no unused Add New control for section ${sectionIndex} (${who})`, sections: addNewCount }); return { ok: false, usedId: "" }; }
    if (!(await addNew.click({ timeout: 8000 }).then(() => true).catch(() => false))) {
      // Almost always the PREVIOUS section's dialog still overlaying the page: ACA leaves
      // the dialog iframe in the DOM after a save, and it intercepts the click.
      this.debug?.event({ type: "contact_add_bail", why: `Add New click intercepted for section ${sectionIndex} (${who})`, control: usedId });
      return { ok: false, usedId };
    }
    await page.waitForLoadState?.("networkidle", { timeout: 12000 }).catch(() => null);
    await page.waitForTimeout?.(1500).catch(() => null);
    // VERIFY the Add-New form actually opened before recording anything — an unopened
    // dialog would otherwise leave a recorded click that replays into nothing.
    const anyInput = dlg.locator("input[type='text']").first();
    if (!(await anyInput.count().catch(() => 0))) {
      this.debug?.event({ type: "contact_add_bail", why: "Add New dialog did not open" });
      return { ok: false, usedId };
    }
    steps.push({ action: "click", phase: "fill", selector: { role: "button", name: "Add New", fallbacks: [{ css: 'a:has-text("Add New")' }] }, note: `contact(${who}): add new` });
    // GROUND TRUTH for the dialog's real control ids. The field locators are guesses from
    // one build's DOM; when one misses (live: the Address field), the pass fills a partial
    // contact and ACA quietly falls back to an ACCOUNT contact, which then shows on the
    // review screen as somebody else entirely. Dump ids/names once per section so the next
    // run's bundle says exactly what to target. Ids only - no values, so no PII.
    try {
      const ids = await dlg.locator("input, select").evaluateAll((els: Element[]) =>
        els.slice(0, 40).map((el) => `${el.tagName.toLowerCase()}#${el.getAttribute("id") || ""}|${el.getAttribute("name") || ""}`));
      this.debug?.event({ type: "contact_dialog_controls", section: sectionIndex, ids });
    } catch { /* diagnostics only */ }
    // Field-specific ASP.NET control ids/names — NOT row-label scoping. ACA renders First
    // and Last name in the SAME table row, so a row filter for /last name/ also matches
    // that row and .first() returns the FIRST-name box: the last name would overwrite the
    // first (review finding). Distinct selectors also keep each recorded step replayable
    // into its own control instead of all four landing in one input.
    // Section 1 (site contact) binds to the PROJECT's own keys. A blind
    // installer→homeowner prefix swap invents homeownerStreet/City/State/Zip, which exist
    // nowhere in resolveRecipeFieldValues — at replay those resolve to "" and the required
    // address block goes in BLANK with no error. The site address lives under
    // street/city/state/zip; only the person fields carry a homeowner* prefix.
    const SITE_KEYS: Record<string, string> = {
      installerFirstName: "homeownerFirstName",
      installerLastName: "homeownerLastName",
      installerEmail: "homeownerEmail",
      installerPhone: "homeownerPhone",
      installerStreet: "street",
      installerCity: "city",
      installerState: "state",
      installerZip: "zip",
    };
    const bindKey = (installerKey: string): string =>
      sectionIndex === 0 ? installerKey : (SITE_KEYS[installerKey] ?? installerKey);
    // Accept SEVERAL id tokens per field, tried in order. ACA's control names vary by
    // build and the guess only has to be wrong once to matter: the street box here is
    // `txtAppStreetAdd1`, which contains neither "AddressLine1" nor "Address", so the fill
    // missed, Playwright waited out its full timeout twice (30s each, measured), and the
    // half-filled contact let ACA substitute one of the ACCOUNT's own contacts on the
    // review screen. The hidden `hfIsForNewContactAddress` is skipped by firstVisible.
    const fillField = async (idParts: string | string[], value: string | undefined, note: string, field: string): Promise<void> => {
      if (!value) return;
      const parts = Array.isArray(idParts) ? idParts : [idParts];
      let loc: unknown = null;
      let css = "";
      for (const part of parts) {
        css = `input[id*='${part}' i], input[name*='${part}' i]`;
        loc = await this.firstVisible(dlg, css);
        if (loc) break;
      }
      if (!loc) { this.debug?.event({ type: "contact_field_miss", field, tried: parts }); return; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (await (loc as any).fill(value, { timeout: 8000 }).then(() => true).catch(() => false)) {
        steps.push({ action: "fill", phase: "fill", selector: { css, frame: "ACADialogFrame" }, field: bindKey(field), value, note: `${note} [${who}]` });
      }
    };
    await fillField("FirstName", id.firstName, "contact: first name", "installerFirstName");
    await fillField("LastName", id.lastName, "contact: last name", "installerLastName");
    await fillField("Email", id.email, "contact: email", "installerEmail");
    // ACA's contact dialog also REQUIRES the address block (Address / City / State / Zip)
    // and validates Zip as exactly ##### — a ZIP+4 or a stray space is rejected.
    // Address ids vary by build (AddressLine1 / addressLine1 / txtAddress) - the
    // live Coos Bay dialog missed on "AddressLine1" alone.
    await fillField(["StreetAdd", "AddressLine", "Address", "Street"], id.street, "contact: address", "installerStreet");
    await fillField("City", id.city, "contact: city", "installerCity");
    const zip5 = (id.zip || "").replace(/\D/g, "").slice(0, 5);
    if (zip5) {
      const zipLoc = await this.firstVisible(dlg, "input[id*='Zip' i], input[name*='Zip' i]");
      if (zipLoc) {
        // Keystrokes: ACA's zip validator ignores a programmatic value set.
        await this.typeMasked(zipLoc, zip5);
        steps.push({ action: "fill", phase: "fill", selector: { css: "input[id*='Zip' i]", frame: "ACADialogFrame" }, field: bindKey("installerZip"), value: zip5, note: `contact: zip [${who}]` });
      }
    }
    // State is a dropdown keyed by the 2-letter code.
    const stateCode = (id.state || "").trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(stateCode)) {
      const stateSel = await this.firstVisible(dlg, "select[id*='State' i], select[name*='State' i]");
      if (stateSel) {
        const okState = await stateSel.selectOption(stateCode).then(() => true)
          .catch(async () => stateSel.selectOption({ label: stateCode }).then(() => true).catch(() => false));
        if (okState) steps.push({ action: "select", phase: "fill", selector: { css: "select[id*='State' i]", frame: "ACADialogFrame" }, field: bindKey("installerState"), value: stateCode, note: `contact: state [${who}]` });
      }
    }
    // PRIMARY PHONE is a SEGMENTED control on ACA: three boxes (area / prefix / line,
    // rendered as ...$ChildControl0/1/2) whose validator reads KEYSTROKES, not an assigned
    // value. Writing the whole formatted string into one box leaves the other two empty and
    // the portal reports "Primary Phone: Invalid" (operator-observed).
    const phoneDigits = (id.phone || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    if (phoneDigits.length >= 10) {
      const phoneCss = "input[id*='Phone' i]:not([id*='Secondary' i]):not([id*='Fax' i])";
      const phoneMode = await this.fillPhoneSegments(page, id.phone || "", "ACADialogFrame");
      const parts = [phoneDigits.slice(0, 3), phoneDigits.slice(3, 6), phoneDigits.slice(6, 10)];
      if (phoneMode === "ok") {
        for (let i = 0; i < 3; i++) {
          // BOUND per segment, never frozen: a literal here replays the LEARN project's
          // phone number for every future project. resolveRecipeFieldValues derives
          // <base>Area/Prefix/Line via phoneSegmentKeys.
          const segKey = `${bindKey("installerPhone")}${["Area", "Prefix", "Line"][i]}`;
          steps.push({ action: "fill", phase: "fill", selector: { css: phoneCss, nth: i, frame: "ACADialogFrame" }, field: segKey, value: parts[i], note: `contact: phone (${["area", "prefix", "line"][i]}) [${who}]` });
        }
      } else if (phoneMode === "not-segmented") {
        const single = dlg.locator(phoneCss).first();
        if (await single.count().catch(() => 0)) {
          const dashed = `${parts[0]}-${parts[1]}-${parts[2]}`;
          await this.typeMasked(single, dashed);
          steps.push({ action: "fill", phase: "fill", selector: { css: phoneCss, frame: "ACADialogFrame" }, field: bindKey("installerPhone"), value: dashed, note: `contact: phone [${who}]` });
        }
      }
    } else if (id.phone) {
      await fillField("Phone", id.phone, "contact: phone", "installerPhone");
    }
    // The dialog's Continue/Save/Submit commits the contact (NOT "Continue Application").
    const dlgSubmit = dlg.getByRole("button", { name: /^(continue|save|submit|ok)$/i })
      .or(dlg.locator('a:has-text("Continue"), input[type="submit"]')).first();
    if (await dlgSubmit.count().catch(() => 0)) {
      if (await dlgSubmit.click({ timeout: 8000 }).then(() => true).catch(() => false)) {
        steps.push({ action: "click", phase: "fill", selector: { role: "button", name: "Continue", frame: "ACADialogFrame", fallbacks: [{ css: 'a:has-text("Continue")', frame: "ACADialogFrame" }] }, note: `contact(${who}): save new contact` });
      }
    }
    await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout?.(1500).catch(() => null);
    // READ BACK what the section now shows. A dialog save that silently does not commit
    // leaves ACA free to attach one of the ACCOUNT's own contacts instead, which reads as
    // success here but files the permit under the wrong person (live: the Applicant came
    // out as the account's "Permit Tech", not the contractor we typed). Claiming success
    // without checking is how that reached the review screen unnoticed.
    const expectName = `${id.firstName ?? ""} ${id.lastName ?? ""}`.trim();
    if (expectName) {
      const body = String((await page.locator("body").innerText().catch(() => "")) ?? "");
      const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
      const committed = norm(body).includes(norm(expectName));
      this.debug?.event({ type: "contact_readback", section: sectionIndex, who, committed });
      if (!committed) {
        this.debug?.event({ type: "contact_add_bail", why: `saved contact is not on the page - ACA may have substituted an account contact (${who})` });
        steps.length = stepMark; // drop this section's steps: they did not take
        return { ok: false, usedId };
      }
    }
    return { ok: true, usedId };
  }

  // ACA ATTACHMENT step. Accela stages attachments in a pending list that is only
  // COMMITTED by the section's own "Save" button — "Continue Application" alone leaves
  // the files uncommitted (operator-reported, live). Each pending row also demands its
  // own required Description + Type before Save will take it. Deterministic: fill the
  // empty Description/Type on every pending row, click Save (never "Save and resume
  // later"), and wait for the grid to stop reading "No records found".
  private async accelaAttachmentSavePass(project: ProjectRecord, steps: RecipeStep[]): Promise<boolean> {
    const page = this.page;
    if (!page) return false;
    const isElectrical = /elec/i.test(project.permitType ?? "");
    const description = isElectrical
      ? "Solar PV plan set — electrical plans and specifications"
      : "Solar PV plan set — structural plans and specifications";
    // Row layout differs across ACA builds (table rows on some, divs on others), so work
    // from the CONTROLS themselves rather than a row structure. The document-Type select
    // is the section's signature: it is the only select whose options are document types
    // ("Plans - Structural", "Plans - Electrical", …).
    const typePrefs = isElectrical
      ? [/plans?\s*[-–—]?\s*electrical/i, /electrical/i, /plans?\b/i]
      : [/plans?\s*[-–—]?\s*structural/i, /structural/i, /plans?\b/i];
    const readOptions = async (sel: { evaluate?: unknown }): Promise<Array<{ v: string; t: string }>> => {
      // Best-effort: a locator with no .evaluate (older runtime / stub page) throws
      // SYNCHRONOUSLY, which .catch() cannot absorb — and this pass must never abort a run.
      try {
        return await (sel as { evaluate: (fn: unknown) => Promise<Array<{ v: string; t: string }>> })
          .evaluate((el: HTMLSelectElement) => Array.from(el.options).map((o) => ({ v: o.value, t: (o.text || "").trim() })))
          .catch(() => []);
      } catch { return []; }
    };
    // 1) Document-Type selects: fill only the EMPTY ones (--Select-- reads as "").
    const allSelects = page.locator("select");
    const selCount = await allSelects.count().catch(() => 0);
    let typeSet = 0;
    let sawTypeSelect = false;
    let pickedTypeText = "";
    for (let i = 0; i < selCount; i++) {
      const sel = allSelects.nth(i);
      const opts = await readOptions(sel);
      const isDocType = opts.some((o) => /plans?\s*[-–—]/i.test(o.t)) || opts.some((o) => /^(plans|calculations|photos?|forms?)\b/i.test(o.t));
      if (!isDocType) continue;
      sawTypeSelect = true;
      const current = String((await sel.inputValue().catch(() => "")) ?? "").trim();
      if (current) continue;
      let pick: { v: string; t: string } | undefined;
      for (const re of typePrefs) { pick = opts.find((o) => o.v && re.test(o.t)); if (pick) break; }
      if (!pick) continue; // no sensible option — leave it for the human rather than guess
      if (await sel.selectOption(pick.v).then(() => true).catch(() => false)) {
        typeSet++;
        pickedTypeText = pick.t;
        // Each Type choice fires an ACA partial postback; without a settle the next
        // row's select can be re-rendered mid-iteration and the choice lost.
        await page.waitForTimeout?.(900).catch(() => null);
      }
    }
    // 2) Description textareas: only inside a CONFIRMED attachment section (a document-Type
    //    select exists), and only the empty ones — never overwrite the planner's text or a
    //    "Description of Work" field on some other step.
    let descFilled = 0;
    if (sawTypeSelect) {
      const descBoxes = page.locator("textarea");
      const descCount = await descBoxes.count().catch(() => 0);
      for (let i = 0; i < descCount; i++) {
        const box = descBoxes.nth(i);
        const current = String((await box.inputValue().catch(() => "")) ?? "").trim();
        if (current) continue;
        if (await box.fill(description).then(() => true).catch(() => false)) descFilled++;
      }
    }
    // 3) SAVE — the commit. On the live ACA DOM this is an ANCHOR:
    //      <a id="…_Attachment_24Edit_btnSave" title="Save" href="javascript:…"><span>Save</span></a>
    //    so its ARIA role is LINK, not button, and `a:text-is("Save")` matches the inner
    //    <span> rather than the anchor — a button/text-is locator counts ZERO and the pass
    //    bails without ever committing (verified against the captured live trace; the
    //    hand-coded OregonEPermittingAdapter uses the link form for the same reason).
    //    The exact name keeps "Save and resume later:" out (its accessible name is that
    //    control's long img alt text).
    const saveBtn = page.getByRole("link", { name: /^\s*Save\s*$/i })
      .or(page.getByRole("button", { name: /^\s*Save\s*$/i }))
      .or(page.locator("a[id*='btnSave' i], input[type='submit'][value='Save' i], input[type='button'][value='Save' i]"))
      .first();
    // ACA keeps the Save anchor inside a container it reveals with JS only once the
    // uploads finish, and a role locator skips the hidden a11y tree — so WAIT for it
    // instead of counting once.
    await saveBtn.waitFor?.({ state: "visible", timeout: 15000 }).catch(() => null);
    if (!(await saveBtn.count().catch(() => 0))) { this.debug?.event({ type: "attachment_save_bail", why: "no Save control" }); return false; }
    if (!(await saveBtn.click({ timeout: 10000 }).then(() => true).catch(() => false))) return false;
    await page.waitForLoadState?.("networkidle", { timeout: 20000 }).catch(() => null);
    await page.waitForTimeout?.(2500).catch(() => null);
    // 4) Verify the commit. The committed-file grid renders in a CHILD IFRAME
    //    (…iframeAttachmentList → FileUpload/AttachmentsList.aspx), so "No records found"
    //    never appears in the main-frame body — reading it there reports success
    //    unconditionally. Prefer the grid frame; fall back to the main body only when no
    //    such frame exists (other ACA builds render the list inline).
    let gridText = "";
    try {
      gridText = String((await page.frameLocator("iframe[id*='AttachmentList' i], iframe[src*='AttachmentsList' i]")
        .locator("body").innerText().catch(() => "")) ?? "");
    } catch { gridText = ""; }
    const verifyText = gridText || String((await page.locator("body").innerText().catch(() => "")) ?? "");
    const committed = Boolean(verifyText) && !/no records found/i.test(verifyText);
    this.debug?.event({ type: "attachment_save", descFilled, typeSet, committed });
    if (descFilled) steps.push({ action: "fill", phase: "upload", selector: { css: "textarea" }, value: description, note: "attachment: description" });
    // Record the option the pass ACTUALLY selected - a fabricated label would replay as
    // a select-by-label miss on any build whose wording differs.
    if (typeSet && pickedTypeText) steps.push({ action: "select", phase: "upload", selector: { css: "select" }, value: pickedTypeText, note: "attachment: document type" });
    steps.push({
      action: "click",
      phase: "upload",
      selector: {
        // LINK role - the live control is an anchor (see the locator note above).
        role: "link",
        name: "Save",
        exact: true,
        fallbacks: [
          { css: "a[id*='btnSave' i]" },
          { role: "button", name: "Save", exact: true },
        ],
      },
      note: "attachment: save (commits the upload)",
    });
    return committed;
  }

  // True when the page offers ACA record types to choose from — at least one
  // checkbox/radio labeled like a discipline record type ("Residential - Electrical
  // Comprehensive"). Deliberately narrow: a detail form with a stray "Solar" checkbox
  // must NOT trigger this (only the selection pass may then PREFER a solar-labeled
  // type once the page is confirmed to be record-type selection).
  private acaRecordTypePageDetected(fields: ExtractedField[]): boolean {
    return fields.some((f) =>
      (f.fieldType === "checkbox" || f.fieldType === "radio") &&
      /residential\s*[-–—]?\s*(electrical|structural|mechanical|plumbing|building)/i.test(f.label || ""));
  }

  // Record-type selection: prefer a solar/PV-specific type when the AHJ offers one,
  // else the discipline's residential type (electrical vs structural — same mapping the
  // hand-coded adapter live-verified: county rows file electrical, city structural).
  private async accelaRecordTypePass(project: ProjectRecord, fields: ExtractedField[], steps: RecipeStep[]): Promise<boolean> {
    const page = this.page;
    if (!page) return false;
    const isElectrical = /elec/i.test(project.permitType ?? "");
    const prefs: RegExp[] = [
      /solar|photovoltaic|\bpv\b/i,
      isElectrical ? /residential\s*[-–—]?\s*electrical/i : /residential\s*[-–—]?\s*structural/i,
    ];
    const candidates = fields.filter((f) => f.fieldType === "checkbox" || f.fieldType === "radio");
    let chosen: ExtractedField | undefined;
    for (const re of prefs) {
      chosen = candidates.find((f) => re.test(f.label || ""));
      if (chosen) break;
    }
    if (!chosen) { this.debug?.event({ type: "record_type_bail", why: "no candidate matched the solar/discipline preference" }); return false; }
    const loc = await this.locator(chosen.selector);
    if (!loc) return false;
    // Verified action → recorded step (an unverified push here duplicates the pair once
    // the planner retakes the page, and the duplicate corrupts every future replay).
    const checkOk = await loc.check({ timeout: 10000 }).then(() => true)
      .catch(async () => loc.click({ timeout: 8000 }).then(() => true).catch(() => false));
    if (!checkOk) { this.debug?.event({ type: "record_type_bail", why: "record-type check/click failed" }); return false; }
    steps.push({ action: "check", phase: "fill", selector: chosen.selector, note: `record type: ${(chosen.label || "").slice(0, 60)}` });
    const cont = this.acaContinueLocator();
    if (await cont.count().catch(() => 0)) {
      if (!(await cont.click({ timeout: 10000 }).then(() => true).catch(() => false))) {
        // Checked but couldn't advance — leave the advance to the planner next iteration
        // (the recorded check stands; the box holds its state on the live page).
        return false;
      }
      steps.push({ action: "click", phase: "fill", selector: { css: ACA_CONTINUE_CSS, fallbacks: [{ role: "button", name: "Continue Application »" }] }, note: "record type: continue" });
      await page.waitForLoadState?.("networkidle", { timeout: 20000 }).catch(() => null);
      await page.waitForTimeout?.(2000).catch(() => null);
    }
    return true;
  }

  private async learnImpl(context: PortalContext, _project: ProjectRecord): Promise<LearnResult> {
    const steps: RecipeStep[] = [];
    const alreadyFilledLabels: string[] = [];
    let pageCount = 0;
    let finalSubmitRecorded = false;
    // Accela's "Enter Work Site Location" step is handled deterministically once per run
    // (see the pass below) — flag prevents re-running it if the page reappears.
    let workLocationHandled = false;
    // Accela deterministic-pass state: wrong-module re-entries are BOUNDED (a broken
    // entry URL must not goto-loop), the disclaimer pass may legitimately run again
    // after a re-entry (capped), record-type selection happens once.
    let acaReentries = 0;
    let acaDisclaimerPasses = 0;
    let acaRecordTypeHandled = false;
    let acaContactDialogPasses = 0;
    let acaAttachmentSaves = 0;
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

    // Debug forensic trail — part of the per-run bundle (data/learn-runs/<runId>/, on by
    // default). A full-page PNG before and after fills for every wizard step, plus
    // pNNN-plan.json / pNNN-rescan.json sidecars (see .env.example). Lets the operator see
    // exactly what the bot saw and what it changed without re-running blind. Best-effort only;
    // PNGs alone can be disabled with AUTOLEARN_DEBUG_SCREENSHOTS=0 (sidecars still written).
    const saveDebugShot = async (label: string) => {
      await this.debug?.screenshot(this.page, label);
    };

    // Required fields that did NOT hold their value after filling (portal silently dropped them).
    // Surfaced in the final message so the operator re-checks them before a human submits.
    const fillVerifyMisses: string[] = [];

    // Pathnames already walked this run. Mid-wizard, a planner NAVIGATE back to one of
    // these RESTARTS the flow (live Salem/Accela: from CapHome it clicked a link back to
    // the Apply entry — disclaimer → address → CapHome all over again, burning 3 pages of
    // budget). A navigate whose target was already visited is rejected once any fill has
    // been recorded; the advance path handles forward motion.
    const visitedPaths = new Set<string>();

    for (let pageIdx = 0; pageIdx < this.maxPages; pageIdx++) {
      pageCount++;
      // Reset per-page label tracking so the planner sees a clean slate on each page —
      // PowerClerk reuses field labels ("Name", "Email", "Phone") across wizard steps and
      // passing stale labels from page N to page N+1 caused the planner to skip re-fills.
      alreadyFilledLabels.length = 0;

      // Required-field misses recorded PROVISIONALLY by the premature-atReview guard below.
      // That guard sweeps BEFORE this page's fills and before the deterministic policy pass,
      // so a field it reports as blank is very often filled moments later — the misses are
      // evidence for the guard's decision, not a final verdict. Reconciled at d4b.
      const provisionalMisses: string[] = [];

      // a2) Dismiss any modals/popups/banners and clear lingering loading scrims before
      //     extracting fields, so overlays can't intercept the actions we take this page.
      await this.dismissModals();
      await this.clearOverlays();

      // a3) Section render-readiness: wait until the SPA has MOUNTED an interactive control
      //     before scraping/filling. PGE PowerClerk (and other Vue/React wizards) render the
      //     page chrome and inputs present-but-unbound for a beat; a fill fired then sets the
      //     DOM value but it never commits to the JS model → a blank draft at review. This is
      //     the same gate the hand-coded PowerClerk adapter and the RecipeAdapter replay use;
      //     wiring it here makes the universal auto-learn path robust on PGE's multi-section
      //     ("blocks") form. Non-throwing/best-effort — never skips the page (the empty-scrape
      //     retry below still recovers a genuine miss).
      await waitForInteractiveControls(this.page);

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
          raws = await this.extractAllFrames(extractSel);
          if (raws.length > 0) break;
          await smartWait(this.page, 1500);
          await this.dismissModals();
          await this.clearOverlays();
        }
        fields = raws.map(toExtractedField);
        pageTitle = typeof this.page.title === "function" ? String((await this.page.title().catch(() => "")) ?? "") : "";
        url = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
        try { visitedPaths.add(new URL(url).pathname.toLowerCase()); } catch { /* non-URL (test fakes) */ }
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

      // A deterministic ACA pass is about to handle this page (see b8 below) — its
      // page revisits are DELIBERATE (wrong-module re-entry walks back through the
      // disclaimer + address steps), so they must not consume the stuck/cycle
      // recovery budget or trip its exhaustion break before the pass can run.
      const acaDeterministicAhead = this.isAcaUrl(url) && (
        (this.acaWrongModulePage(url, fields) !== null && acaReentries < 2) ||
        (/CapApplyDisclaimer/i.test(url) && acaDisclaimerPasses < 3) ||
        (!workLocationHandled && (/WorkLocation/i.test(url) || /enter work site location/i.test(bodyText))) ||
        (!acaRecordTypeHandled && this.acaRecordTypePageDetected(fields)) ||
        (acaContactDialogPasses < 1 && this.acaContactPageDetected(fields, bodyText))
      );

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
      if (((consecutiveStuck && stuckStreak >= 2) || cycling) && !acaDeterministicAhead) {
        if (recoveryAttempts >= MAX_RECOVERY) {
          this.debug?.event({ type: "recovery_exhausted", mode: cycling ? "cycle" : "stuck", page: pageCount });
          if (process.env.AUTOLEARN_DEBUG === "1") console.error(`[learn] ${cycling ? "cycling" : "stuck"} and recovery budget exhausted — stopping.`);
          break;
        }
        recoveryAttempts++;
        this.debug?.event({ type: "recovery_attempt", n: recoveryAttempts, max: MAX_RECOVERY, mode: cycling ? "cycle" : "stuck", page: pageCount });
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
          this.debug?.event({ type: "challenge_stop", page: pageCount, detail: challenge });
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

      // b8) ACCELA DETERMINISTIC PASSES (see the ACA section above) — each bails to the
      //     planner when its hooks don't match, and `continue` re-extracts whatever page
      //     the pass landed on.
      if (this.isAcaUrl(url)) {
        // Wrong-module drift: the records/search module is never part of the Apply
        // wizard — leave immediately (bounded), BEFORE the planner can operate on the
        // operator's real filings (Resume Application / Pay Fees Due / attachments).
        const wrongModule = this.acaWrongModulePage(url, fields);
        if (wrongModule && acaReentries < 2) {
          const entry = this.acaApplyEntryUrl(url);
          if (entry) {
            acaReentries++;
            this.debug?.event({ type: "aca_wrong_module", page: pageCount, kind: wrongModule, reentry: acaReentries });
            const gotoOk = await this.page.goto(entry, { waitUntil: "domcontentloaded", timeout: 30000 }).then(() => true).catch(() => false);
            await this.page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => null);
            // Record only a navigation that actually happened — a failed goto recorded
            // anyway would replay a dead re-entry.
            if (gotoOk) steps.push({ action: "goto", phase: "fill", value: entry, note: `accela: re-enter apply flow (left ${wrongModule})` });
            // The re-entry walks back through the address AND record-type steps — let
            // both passes run again (an unreset record-type leg would also trip the
            // cycle guard mid-walk-back with no exemption, burning recovery budget).
            workLocationHandled = false;
            acaRecordTypeHandled = false;
            continue;
          }
        }
        // Entry T&C — accept + continue without burning an LLM call on a static page.
        if (/CapApplyDisclaimer/i.test(url) && acaDisclaimerPasses < 3) {
          acaDisclaimerPasses++;
          const advanced = await this.accelaDisclaimerPass(steps);
          this.debug?.event({ type: "aca_disclaimer_pass", page: pageCount, advanced });
          if (advanced) continue;
        }
        // Work-site location (address search → jurisdiction row → continue). Trigger on
        // the URL too — bodyText is capped at 2000 chars and ACA's chrome/header can
        // push the "Enter Work Site Location" heading past the cap.
        if (!workLocationHandled && (/WorkLocation/i.test(url) || /enter work site location/i.test(bodyText))) {
          workLocationHandled = true;
          const advanced = await this.accelaWorkLocationPass(_project, steps);
          this.debug?.event({ type: "work_location_pass", page: pageCount, advanced });
          if (advanced) continue; // next iteration re-extracts the page the Continue landed on
        }
        // CONTACT step (CapEdit): "Add New" + fill the contractor identity (operator's
        // guidance — the account has many pre-existing contacts). Appears once per
        // contact section (Applicant, Site Contact), so allow a few.
        if (acaContactDialogPasses < 1 && this.acaContactPageDetected(fields, bodyText)) {
          acaContactDialogPasses++;
          // BOTH sections in ONE visit, then advance off the page ourselves. Handing the
          // page back to the planner between sections let it re-open the contact we had
          // just filled and overwrite the applicant's NAME with the homeowner's, leaving
          // the contractor address underneath — a mixed contact on the review screen
          // (live Coos Bay). Owning the whole step closes that window.
          let anyFilled = false;
          const usedAddNew: string[] = [];
          // BOTH sections: Site Contact is a REQUIRED section, so the wizard cannot advance
          // until it is filled (live: with only the applicant filled, Continue Application
          // did nothing and the page came back to the planner, which then overwrote the
          // applicant). Applicant = filing contractor, Site Contact = property owner.
          for (const sectionIndex of [0, 1]) {
            const idn = this.identityForSection(sectionIndex);
            if (!idn.lastName && !idn.email) continue;
            const res = await this.accelaAddContactPass(steps, sectionIndex, usedAddNew);
            this.debug?.event({ type: "aca_contact_add_pass", page: pageCount, section: sectionIndex, advanced: res.ok, control: res.usedId });
            if (res.usedId) usedAddNew.push(res.usedId);
            if (res.ok) { anyFilled = true; if (sectionIndex === 0) this.acaApplicantFilled = true; }
            // Close the saved dialog before the next section — an overlay that is still up
            // swallows the next Add New click.
            await this.closeAcaDialog();
          }
          if (anyFilled) {
            // CLEAR THE LINGERING MODAL FIRST. ACA leaves the saved dialog's iframe in the
            // DOM and its overlay swallows the next click — that is how the Continue below
            // silently missed, handing the page back to the planner mid-modal to overwrite
            // the applicant we had just filled.
            await this.closeAcaDialog();
            await this.dismissModals();
            await this.clearOverlays();
            await this.page.waitForTimeout?.(800).catch(() => null);
            const beforeFp = await this.pageFingerprint();
            const cont = this.acaContinueLocator();
            if (await cont.count().catch(() => 0)) {
              if (await cont.click({ timeout: 10000 }).then(() => true).catch(() => false)) {
                steps.push({ action: "click", phase: "fill", selector: { css: ACA_CONTINUE_CSS, fallbacks: [{ role: "button", name: "Continue Application »" }] }, note: "contacts: continue" });
                await this.page.waitForLoadState?.("networkidle", { timeout: 20000 }).catch(() => null);
                await this.page.waitForTimeout?.(1500).catch(() => null);
              }
            }
            // Did the page ACTUALLY move? If not, the planner is about to get this page
            // back — say so in the bundle rather than leaving a silent overwrite to
            // explain later.
            const afterFp = await this.pageFingerprint();
            this.debug?.event({ type: "aca_contacts_continue", advanced: Boolean(afterFp) && afterFp !== beforeFp });
            continue;
          }
        }
        // Record-type selection (the page right after the address row is chosen).
        if (!acaRecordTypeHandled && this.acaRecordTypePageDetected(fields)) {
          acaRecordTypeHandled = true;
          const advanced = await this.accelaRecordTypePass(_project, fields, steps);
          this.debug?.event({ type: "aca_record_type_pass", page: pageCount, advanced });
          if (advanced) continue;
        }
      }

      // c) Ask the planner what to do on this page. Attach a screenshot so it can SEE the
      //    section headings/layout (vision-assisted planning) — the reliable signal for which
      //    contact block is the customer vs the installer.
      let plan: LearnPlanResponse;
      const planShot = await this.capturePlanScreenshot();
      try {
        plan = await this.planner({ url, pageTitle, fields, bodyText, alreadyFilledLabels, isDashboard, recoveryHint: recoveryHint || undefined, screenshotBase64: planShot });
      } catch (err) {
        this.debug?.event({ type: "planner_error", page: pageCount, message: err instanceof Error ? err.message : String(err) });
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
      // ENTRY-DISCLAIMER EXCLUSION: the third shape (submit-intent button + accept-terms
      // checkbox) ALSO describes Accela's T&C page at the very START of the wizard
      // (CapApplyDisclaimer: terms text + agree box + "Continue Application »") — the live
      // Salem run stopped there at page 2 and promoted an EMPTY recipe to trusted. A true
      // review/submit screen cannot precede the first recorded fill: when nothing has been
      // filled yet and the page reads as terms/disclaimer, it is a pass-through page
      // (accept + continue), never review.
      const disclaimerish =
        /disclaimer|(^|\/)terms/i.test(url) ||
        /terms and conditions/i.test((bodyText || "").slice(0, 4000));
      // "Nothing filled yet" must mean REAL FORM DATA this RUN, not the current page:
      // alreadyFilledLabels resets every iteration (so it can't carry the signal), and
      // terms/acknowledgment checks must not count either — the agree box recorded ON
      // the entry disclaimer itself would otherwise arm this after one blocked advance,
      // flipping the T&C page into a forced review stop with its Continue recorded as
      // the final submit. A real review screen with a terms gate at the END of the
      // wizard still re-arms the guard through its earlier genuine fills.
      const isTermsAcknowledgment = (s: RecipeStep): boolean =>
        s.action === "check" && (
          ACCEPT_TERMS.test(String(s.selector?.name ?? "")) ||
          ACCEPT_TERMS.test(String(s.selector?.label ?? "")) ||
          /termaccept/i.test(String(s.selector?.css ?? "")) ||
          /accept entry terms/i.test(String(s.note ?? "")));
      const anyFormMutationRecorded = steps.some(
        (s) => (s.action === "fill" || s.action === "check" || s.action === "select") && !isTermsAcknowledgment(s));
      const entryDisclaimer = disclaimerish && !anyFormMutationRecorded;
      const isReviewPage =
        ((!hasFillable && !isDashboard) ||
          (reviewSignals && hasSubmitIntentBtn) ||
          (hasSubmitIntentBtn && hasAcceptTermsCheckbox)) && !entryDisclaimer;
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

      // c2a) INVERSE REVIEW GUARD — the structural check above only forces atReview ON for real
      // review pages; nothing stops a planner that wrongly claims atReview=true on a mid-wizard
      // FORM page. Left unchecked that STOPS the loop early and can be promoted to trusted with
      // required fields still blank. Reject a premature atReview ONLY when the harm is concrete:
      // the page is not a structural review page / dashboard / review-signalled screen, yet it
      // still has UNFILLED REQUIRED fields. Gating on actual unfilled-required (not merely "has a
      // fillable input") avoids rejecting a legitimate review/terminal page that carries a stray
      // control like a terms checkbox. The misses are also recorded so the trust gate sees them.
      if (plan.atReview && !isReviewPage && !isDashboard && hasFillable && !reviewSignals && !hasSubmitIntentBtn) {
        const prematureUnfilled = await this.collectUnfilledRequired();
        if (prematureUnfilled.length > 0) {
          plan = { ...plan, atReview: false };
          for (const m of prematureUnfilled) {
            if (!fillVerifyMisses.includes(m)) fillVerifyMisses.push(m);
            if (!provisionalMisses.includes(m)) provisionalMisses.push(m);
          }
          if (process.env.AUTOLEARN_DEBUG === "1") console.error(`[learn] rejected premature atReview on a form page (p${pageCount}) — ${prematureUnfilled.length} required field(s) still unfilled.`);
        }
      }
      // c2a') The planner itself has claimed atReview on the ENTRY disclaimer (it carries no
      // unfilled required fields, so the guard above can't catch it). Nothing has been filled
      // yet — this cannot be the review screen; accept-and-continue handling takes it instead.
      if (plan.atReview && entryDisclaimer) {
        // Convert the planner's "final submit" (the disclaimer's Continue) into the
        // ADVANCE for this page — leaving finalSubmitSelectorIndex set would record the
        // entry Continue as isFinalSubmit:true (a bogus allowlist entry that trusted
        // auto-submit would later click), and clearing it without an advance dead-ends
        // the run on page 1-2 instead of passing through.
        plan = {
          ...plan,
          atReview: false,
          advanceSelectorIndex: plan.advanceSelectorIndex ?? plan.finalSubmitSelectorIndex,
          finalSubmitSelectorIndex: undefined,
        };
        this.debug?.event({ type: "entry_disclaimer_pass_through", page: pageCount });
        if (process.env.AUTOLEARN_DEBUG === "1") console.error(`[learn] rejected atReview on the entry disclaimer (p${pageCount}) — passing through.`);
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
        // Titles go through redactStatusText — portal record pages often title themselves
        // with the record number/applicant address, and the trace is logged + persisted.
        pageTrace.push(
          `p${pageCount} "${(redactStatusText(pageTitle) || "").slice(0, 40)}" [${hostPath}] ${cls} ` +
          `fields=${fields.length}(fill=${fillCount},btn=${btnCount},link=${linkCount}) ` +
          `plan:nav=${plan.navigateSelectorIndex ?? "-"} adv=${plan.advanceSelectorIndex ?? "-"} ` +
          `fills=${(plan.fills ?? []).length} review=${plan.atReview}`,
        );
        // Same breadcrumb into the run bundle's timeline (redacted, host+path only).
        this.debug?.event({ type: "page", trace: pageTrace[pageTrace.length - 1], recovery: recoveryHint ? true : undefined });

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
        if (this.debug) {
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
            // Observability: was a page SCREENSHOT actually sent to the planner this page (vision
            // planning active)? Lets the operator confirm vision is on vs silently text-only.
            visionUsed: typeof planShot === "string" && planShot.length > 0,
            visionKb: typeof planShot === "string" ? Math.round((planShot.length * 0.75) / 1024) : 0,
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
          this.debug.writeJson(`p${pageCount.toString().padStart(3, "0")}-plan.json`, sidecar);
        }
      }

      // c3) DASHBOARD NAVIGATION — click a link/button to get from the portal home to the
      //     actual application form. Recorded as a click step (phase:"open") then loop again.
      if (typeof plan.navigateSelectorIndex === "number") {
        const navField = fields[plan.navigateSelectorIndex];
        // NO-REVISIT GUARD: once any fill has been recorded, a NAVIGATE whose target
        // pathname was already walked this run would RESTART the wizard (live Salem/Accela:
        // CapHome → back to the Apply disclaimer → address → CapHome, burning page budget).
        // Reject it; the advance path owns forward motion.
        let navRevisit = false;
        if (navField?.href && steps.some((st) => st.action === "fill" || st.action === "select" || st.action === "check")) {
          try {
            const target = new URL(navField.href, url).pathname.toLowerCase();
            navRevisit = visitedPaths.has(target);
          } catch { /* non-URL href — leave allowed */ }
        }
        if (navRevisit) {
          this.debug?.event({ type: "navigate_revisit_rejected", page: pageCount, label: (navField?.label || "").slice(0, 60) });
          if (process.env.AUTOLEARN_DEBUG === "1") console.error(`[learn] rejected navigate to an already-visited path (p${pageCount}).`);
        } else if (navField && this.acaApplicantFilled && CONTACT_CONTROL.test(navField.label || "")) {
          // The applicant contact is already filled with the FILING CONTRACTOR's identity.
          // Re-opening that section is how the planner overwrote it with the homeowner's
          // details (live Coos Bay), so refuse the click and let the advance path move on.
          this.debug?.event({ type: "contact_reopen_refused", label: (navField.label || "").slice(0, 60) });
        } else if (navField && !this.isOffLimitsButton(navField)) {
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
      // A REVIEW/confirm screen is a read-only summary of what was already staged — it
      // lists the attachments rather than accepting new ones. Uploading there re-attaches
      // a document that is already committed and then re-runs the attachment Save on a
      // page that has nothing to commit (operator-observed on ACA's Step 3: Review).
      if (isReviewPage || plan.atReview) {
        this.debug?.event({ type: "upload_skipped_on_review", page: pageCount });
      } else {
        this.debug?.event({ type: "upload_phase_start", page: pageCount });
        const up = await this.withPhaseTimeout(
          "uploads",
          150_000,
          () => this.performUploads(steps, alreadyFilledLabels),
          { filled: [] as string[], missingRequired: [] as string[], attached: 0 },
        );
        this.debug?.event({ type: "upload_phase_done", page: pageCount, attached: up.attached, missing: up.missingRequired.length });
        for (const m of up.missingRequired) if (!missingRequiredDocs.includes(m)) missingRequiredDocs.push(m);
        // ACA commits attachments only on the section's own Save (Continue Application
        // leaves them pending) — and each pending row needs its Description + Type first.
        if (up.attached > 0 && this.isAcaUrl(url) && acaAttachmentSaves < 3) {
          acaAttachmentSaves++;
          const saved = await this.withPhaseTimeout(
            "attachment_save",
            90_000,
            () => this.accelaAttachmentSavePass(_project, steps),
            false,
          );
          this.debug?.event({ type: "aca_attachment_save_pass", page: pageCount, saved });
          if (saved) continue; // re-extract: the grid now lists the committed file(s)
          // A commit that did NOT take is invisible to the operator otherwise: the run
          // walks on and the portal shows an application with no documents attached.
          const warn = "Attachments were uploaded but the portal's Save did not confirm them — re-attach and click Save by hand before submitting.";
          if (!missingRequiredDocs.includes(warn)) missingRequiredDocs.push(warn);
        }
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
            group: field.group,
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

      // d2b) DETERMINISTIC EQUIPMENT PASS on the initial fields — manufacturer/model
      //      comboboxes the planner didn't (or couldn't) fill, matched by test-hint
      //      labels and filled from project equipment data with alias/token fallback.
      try {
        pageFillCount += await this.fillEquipmentSelects(fields, alreadyFilledLabels, steps);
      } catch { /* best-effort */ }

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
        // +1 pass headroom: a Calculate/Update-Totals click consumes one extra pass to fill
        // whatever the computation then reveals (e.g. an export-capacity question).
        const MAX_RESCAN_PASSES = 7;
        let computedThisPage = false;
        let lateEquipTried = false;
        for (let rescanPass = 0; rescanPass < MAX_RESCAN_PASSES; rescanPass++) {
          let revealedThisPass = 0;
          try {
            // Wait for the AJAX that ENABLES + POPULATES the next dependent control to land
            // before scraping — a flat sleep raced it, so the just-revealed <select> scraped
            // empty/disabled and the planner had no options to choose. Then clear any overlay.
            await this.waitForDynamicFieldsSettle();
            await this.clearOverlays();
            const raws2 = await this.extractAllFrames(EXTRACT_SEL);
            const postFields = raws2.map(toExtractedField);
            // Radio groups already answered this page: each option has a DIFFERENT label, so
            // after filling one option its siblings pass the label filter below and look
            // "newly revealed" — planning a fill on a sibling silently FLIPS the recorded
            // answer (seen live: "currently served by PGE" → "NOT YET served by PGE").
            const filledRadioGroups = new Set(
              appliedThisPage.filter((a) => a.fieldType === "radio" && a.group).map((a) => a.group as string),
            );
            const inFilledGroup = (f: ExtractedField): boolean =>
              f.fieldType === "radio" && !!f.group && filledRadioGroups.has(f.group);
            const newFillable = postFields.filter(
              (f) =>
                f.fieldType !== "button" &&
                f.fieldType !== "file" &&
                f.label &&
                !alreadyFilledLabels.includes(f.label) &&
                !inFilledGroup(f),
            );
            if (newFillable.length === 0) {
              // A cascade can reveal a SECOND section reusing bare labels the first
              // section already "filled" ("Manufacturer"/"Model") — those are invisible
              // to the label-based newFillable filter, so give the equipment pass ONE
              // look before giving up (once per page: it self-guards via value-held
              // skip + fail memory, but pages whose values can't be read back must
              // not loop here).
              if (!lateEquipTried) {
                lateEquipTried = true;
                const lateEquip = await this.fillEquipmentSelects(postFields, alreadyFilledLabels, steps);
                if (lateEquip > 0) { pageFillCount += lateEquip; continue; }
              }
              // No more cascade reveals. Before giving up, click any Calculate/Update-Totals
              // button once and loop again so the values it computes (and any field it then
              // reveals) are captured. Universal — no portal coupling.
              if (!computedThisPage) {
                computedThisPage = true;
                if (await this.clickComputeButton(steps)) continue;
              }
              break; // nothing new appeared — done cascading.
            }

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
                // Re-capture after the reveal so the planner sees the newly-shown fields/sections.
                // COST: rescan passes reuse the page the planner already SAW —
                // a fresh full-page screenshot per rescan (×7/page) is vision
                // spend with little new signal. Off by default; PORTAL_VISION_RESCAN=1
                // re-enables for portals whose reveals are visual-only.
                screenshotBase64: process.env.PORTAL_VISION_RESCAN === "1" ? await this.capturePlanScreenshot() : undefined,
              });
            } catch { /* planner failure is non-fatal for the re-scrape pass */ }

            for (const fillReq of postPlan.fills ?? []) {
              const field = postFields[fillReq.selectorIndex];
              if (!field) continue;
              if (field.fieldType === "button" || field.fieldType === "file") continue;
              if (isSensitiveLabel(field.label)) continue; // handled by the deterministic pass below
              if (field.label && alreadyFilledLabels.includes(field.label)) continue;
              if (inFilledGroup(field)) continue; // never re-answer a radio group filled this page
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

            // Deterministic equipment pass on the POST-REVEAL fields — the PV-spec
            // repeater's manufacturer/model comboboxes appear only after the Energy
            // Source cascade, so this is where they usually become fillable.
            try {
              const equipFilled = await this.fillEquipmentSelects(postFields, alreadyFilledLabels, steps);
              pageFillCount += equipFilled;
              revealedThisPass += equipFilled;
            } catch { /* best-effort */ }

            // Debug: dump what appeared after the reveal so the operator can audit it.
            this.debug?.writeJson(`p${pageCount.toString().padStart(3, "0")}-rescan${rescanPass + 1}.json`, {
              page: pageCount,
              pass: rescanPass + 1,
              title: pageTitle,
              revealedFields: newFillable.map((f) => (f.label || "?").slice(0, 80)),
              filledThisPass: revealedThisPass,
            });

            // Let the portal autosave the conditional-field fills before re-scanning again.
            if (revealedThisPass > 0 && typeof this.page?.waitForLoadState === "function") {
              await this.page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => null);
            }
          } catch { /* post-selection re-scrape is best-effort — never break the loop */ }
          if (revealedThisPass === 0) {
            // Converged on field reveals — try the compute button once before stopping, in
            // case totals/derived fields still need calculating (and may reveal more).
            if (!computedThisPage) {
              computedThisPage = true;
              if (await this.clickComputeButton(steps)) continue;
            }
            break; // converged — no further reveals to chase.
          }
        }
      }

      // d3b) POLICY-DEFAULT PASS — answer fixed Yes/No policy questions the planner left blank
      //      (e.g. "Do you propose to limit the export capacity?" → No). Deterministic so the
      //      portal's default selection can't stand. Only touches an UNANSWERED group; records a
      //      replayable step. Runs on real form pages only.
      if (!plan.atReview && !isDashboard && this.page) {
        const policySteps = await this.applyPolicyDefaults(alreadyFilledLabels);
        for (const ps of policySteps) {
          steps.push(ps.step);
          pageFillCount++;
          appliedThisPage.push(ps.applied);
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

      // d4b) REQUIRED-FIELD SWEEP — before advancing, scan the live page for REQUIRED fields
      //      still blank/unselected that the planner never touched (an unanswered Yes/No group,
      //      an unselected equipment-model dropdown, a dropped Schedule). verifyFillsLanded only
      //      re-checks fields we DID fill, so these would otherwise sail through to a wrongly-
      //      "trusted" recipe. Only on real form pages (skip dashboards/review). Sensitive +
      //      acknowledgment fields are excluded inside the sweep.
      if (!plan.atReview && !isDashboard && hasFillable) {
        const unfilled = await this.collectUnfilledRequired();
        for (const m of unfilled) if (!fillVerifyMisses.includes(m)) fillVerifyMisses.push(m);
        // RETRACT a provisional miss the page has since answered. The premature-atReview
        // guard sweeps before this page's fills and before applyPolicyDefaults, so a
        // question the policy pass then answers ("Do you propose to limit the export
        // capacity?" → No) stayed on the miss list for the rest of the run. That list is a
        // HARD BLOCKER in the trust gate, so a portal whose planner once over-claimed
        // atReview could never be promoted no matter how clean the run — the live PGE
        // recipe sat at draft through twelve learns for exactly this reason. `unfilled` is
        // the CURRENT state of the same sweep, so anything absent from it is answered.
        for (const m of provisionalMisses) {
          if (unfilled.includes(m)) continue;
          const at = fillVerifyMisses.indexOf(m);
          if (at >= 0) {
            fillVerifyMisses.splice(at, 1);
            if (process.env.AUTOLEARN_DEBUG === "1") console.error(`[learn] retracted provisional required-miss now answered: ${m}`);
          }
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
              this.debug?.event({ type: "validation_blocked", page: pageCount, errors: blockers.slice(0, 10) });
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
      requiredFieldMisses: fillVerifyMisses,
      missingRequiredDocs,
      validationBlocks,
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
          const w = norm(want);
          // Same CONTAINS semantics as selectWithFallback's native partial match —
          // an equality-only wait burns the full cap on certified-name options
          // ("Altenergy Power System Inc. (APsystems)" vs "Altenergy Power System")
          // even though the select will succeed immediately. Ordered like
          // selectWithFallback / bestOptionMatch: prefer releasing on an EXACT
          // normalized text/value match, contains kept as the fallback pass.
          const options = Array.from((el as HTMLSelectElement).options);
          const real = options.filter((o) => {
            const t = norm(o.textContent || "");
            return t && !/^(please\s+)?select\.{0,3}$/i.test(t);
          });
          if (real.some((o) => norm(o.textContent || "") === w || norm(o.value) === w)) return true;
          if (w !== "" && options.some((o) => norm(o.value) === w)) return true;
          return real.some((o) => {
            const t = norm(o.textContent || "");
            return t.includes(w) || w.includes(t);
          });
        }, value)
        .catch(() => true);
      if (ready) return;
      await sleep(250);
    }
  }

  // Select the policy answer for any POLICY_RADIO_DEFAULTS question whose group is present and
  // UNANSWERED on the live page. Locates the radio by walking the DOM for the question text,
  // confirms nothing in the group is already checked, clicks the matching option, and returns a
  // replayable `check` step (css-targeted by id) plus an AppliedFill record. Best-effort; never
  // throws. Skips any group whose question label is already in `alreadyFilledLabels`.
  private async applyPolicyDefaults(
    alreadyFilledLabels: string[],
  ): Promise<Array<{ step: RecipeStep; applied: AppliedFill }>> {
    const out: Array<{ step: RecipeStep; applied: AppliedFill }> = [];
    // Policy answers are DOMAIN policy (standard residential NEM), not universal truths —
    // never force them on a portal the caller didn't opt into (AHJ/permit portals,
    // non-standard projects). The planner + project data answer instead.
    if (this.policyProfile !== "residential_nem") return out;
    if (!this.page || typeof this.page.evaluate !== "function") return out;
    for (const policy of POLICY_RADIO_DEFAULTS) {
      try {
        const target = await this.page.evaluate(
          (args: { qSource: string; answer: string; enforce: boolean }) => {
            const norm = (s: string | null | undefined) => (s || "").trim().replace(/\s+/g, " ");
            const question = new RegExp(args.qSource, "i");
            const answerLc = args.answer.trim().toLowerCase();
            const labelOf = (el: Element): string => {
              const id = el.getAttribute("id");
              if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l?.textContent?.trim()) return norm(l.textContent); }
              const w = el.closest("label"); if (w?.textContent?.trim()) return norm(w.textContent);
              return norm(el.getAttribute("aria-label") || el.getAttribute("value") || "");
            };
            const radios = Array.from(document.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
            for (const r of radios) {
              const grp = r.closest("fieldset, .form-group, [class*='form-group'], [class*='field'], .row, [class*='row']");
              const groupText = norm(grp?.textContent || "");
              if (!question.test(groupText)) continue;
              const peers = grp
                ? (Array.from(grp.querySelectorAll('input[type="radio"]')) as HTMLInputElement[])
                : [r];
              const want = peers.find((p) => labelOf(p).toLowerCase() === answerLc);
              // Already correct → nothing to do. For enforce=false, ANY checked peer counts as
              // answered (don't override a legitimate choice). For enforce=true, only the policy
              // answer counts — a different checked peer is a wrong pick we must correct.
              if (want?.checked) return { answered: true as const };
              if (!args.enforce && peers.some((p) => p.checked)) return { answered: true as const };
              if (!want) continue;
              const id = want.getAttribute("id");
              const rect = (want as HTMLElement).getBoundingClientRect?.();
              if (!rect || (rect.width === 0 && rect.height === 0)) continue;
              return {
                answered: false as const,
                css: id ? `#${CSS.escape(id)}` : null,
                groupLabel: norm(grp?.querySelector("legend, label, .control-label, strong, b")?.textContent || ""),
              };
            }
            return null;
          },
          { qSource: policy.question.source, answer: policy.answer, enforce: !!policy.enforce },
        ).catch(() => null);

        if (!target || (target as { answered?: boolean }).answered) continue;
        const css = (target as { css?: string | null }).css;
        if (!css) continue;
        const groupLabel = ((target as { groupLabel?: string }).groupLabel || "").slice(0, 80) || `policy:${policy.answer}`;
        if (alreadyFilledLabels.includes(groupLabel)) continue;
        const selector: RecipeSelector = { css };
        const loc = await this.locator(selector);
        if (!loc) continue;
        const res = await safeAction(
          groupLabel.slice(0, 40),
          async () => { await loc.check({ timeout: 5000 }); },
          { required: false },
        );
        if (!res.ok || res.message) continue;
        alreadyFilledLabels.push(groupLabel);
        out.push({
          step: {
            action: "check",
            phase: "fill",
            selector,
            note: `policy default: ${groupLabel} → ${policy.answer}`,
          },
          applied: {
            selector,
            label: groupLabel,
            fieldType: "radio",
            // The selector above targets the ONE radio input whose label equals the policy
            // answer, so "did this land?" means "is THAT input checked" — not "is the group's
            // value truthy". Recording the answer itself here made fieldHoldsValue read "No"
            // as the boolean false and conclude the control should be UNCHECKED, so every
            // policy answer of "No" reported itself as a required-field miss the moment it
            // succeeded. That miss is a hard blocker in the trust gate, which is why the live
            // PGE recipe could never be promoted while its export-limit answer ("No") was
            // correct on the page. The "Yes" answers never tripped it -- hence only ever this
            // one question. The human-readable answer stays in the step note.
            expected: "true",
            sensitive: false,
            required: true,
          },
        });
      } catch { /* policy pass is best-effort */ }
    }
    return out;
  }

  // Fields whose control is MASKED/validated on keystrokes rather than on a value
  // assignment. Playwright's fill() sets .value and fires input+change, but ACA's phone
  // and zip controls (AJAX masked-edit + segmented ChildControls) keep their own state
  // from key events — so a filled box shows the right text and STILL reports
  // "Required Invalid" (operator-observed on both Primary Phone and Zip).
  private static readonly MASKED_LABEL = /\b(phone|telephone|fax|zip|postal(\s*code)?)\b/i;

  // Type a value as real keystrokes, then blur to commit + trigger validation. Falls back
  // to fill() when the locator has no typing API (stub pages in tests).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async typeMasked(loc: any, value: string): Promise<void> {
    // focus(), never click(): a click on some portals opens a picker/overlay.
    if (typeof loc.focus === "function") await loc.focus().catch(() => null);
    if (typeof loc.fill === "function") await loc.fill("").catch(() => null);
    if (typeof loc.pressSequentially === "function") {
      await loc.pressSequentially(value, { delay: 35 }).catch(() => null);
    } else if (typeof loc.type === "function") {
      await loc.type(value, { delay: 35 }).catch(() => null);
    } else if (typeof loc.fill === "function") {
      await loc.fill(value).catch(() => null);
    }
    if (typeof loc.blur === "function") await loc.blur().catch(() => null);
  }

  // A US phone on ACA is THREE boxes (area / prefix / line, rendered as …$ChildControl0/1/2).
  // Writing the whole number into whichever box a single locator resolved leaves the other
  // two empty and the portal rejects it. Returns true when it filled a segmented control.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async fillPhoneSegments(scope: any, value: string, frame?: string): Promise<"ok" | "partial" | "not-segmented"> {
    const digits = (value || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    if (digits.length < 10) return "not-segmented";
    const css = "input[id*='Phone' i]:not([id*='Secondary' i]):not([id*='Fax' i])";
    try {
      const root = frame && typeof scope.frameLocator === "function"
        ? scope.frameLocator(`iframe[name="${frame}"]`)
        : scope;
      // VISIBLE segments only: hidden ASP.NET inputs sharing the "Phone" token would
      // otherwise absorb the digits while the on-screen boxes kept the portal's prefill
      // (live: the applicant primary phone ended in digits belonging to neither party).
      const all = root.locator(css);
      const total = await all.count().catch(() => 0);
      const visibleIdx: number[] = [];
      for (let i = 0; i < total; i++) {
        const c = all.nth(i);
        const vis = typeof c.isVisible === "function" ? await c.isVisible().catch(() => false) : true;
        if (vis) visibleIdx.push(i);
        if (visibleIdx.length >= 3) break;
      }
      if (visibleIdx.length < 3) return "not-segmented";
      const target = { nth: (i: number) => all.nth(visibleIdx[i]), count: async () => visibleIdx.length };
      const parts = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 10)];
      // Read back what each segment actually holds — the only reliable success signal.
      const segValues = async (): Promise<string[]> => {
        const out: string[] = [];
        for (let i = 0; i < 3; i++) {
          const box = target.nth(i);
          const v = typeof box.inputValue === "function" ? await box.inputValue().catch(() => "") : "";
          out.push(String(v ?? "").replace(/\D/g, ""));
        }
        return out;
      };
      const filledOk = async (): Promise<boolean> => (await segValues()).join("") === digits;
      // PASS 1 — type it the way a human does: focus the FIRST box and type all ten
      // digits straight through. The mask ADVANCES FOCUS between segments on its own, so
      // driving each box separately fights it (live: only "800" landed, boxes 2-3 empty).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const kb = (this.page as any)?.keyboard;
      if (kb && typeof kb.type === "function") {
        await target.nth(0).focus?.().catch(() => null);
        await target.nth(0).fill?.("").catch(() => null);
        await kb.type(digits, { delay: 60 }).catch(() => null);
        await target.nth(2).blur?.().catch(() => null);
        if (await filledOk()) { this.debug?.event({ type: "phone_segments", how: "continuous" }); return "ok"; }
      }
      // PASS 2 — per segment, letting each box's own key handling settle before moving on.
      for (let i = 0; i < 3; i++) {
        await target.nth(i).focus?.().catch(() => null);
        await target.nth(i).fill?.("").catch(() => null);
        if (kb && typeof kb.type === "function") await kb.type(parts[i], { delay: 60 }).catch(() => null);
        else await this.typeMasked(target.nth(i), parts[i]);
        await this.page?.waitForTimeout?.(250).catch(() => null);
      }
      await target.nth(2).blur?.().catch(() => null);
      const ok = await filledOk();
      // Values are PII — log only which segments came back non-empty.
      this.debug?.event({ type: "phone_segments", how: "per-segment", ok, filled: (await segValues()).map((v) => v.length) });
      // "partial" still means SEGMENTED - callers must not fall back to writing the whole
      // number into one box, which is what produced the live "Invalid" state.
      return ok ? "ok" : "partial";
    } catch { return "not-segmented"; }
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

    // DETERMINISTIC GUARD: never check an "equipment is not listed / enter manually" checkbox.
    // Checking it hides the searchable manufacturer/model dropdowns and degrades the entry to
    // unlisted plain-text. The planner is told to skip it but has been seen checking it anyway,
    // so refuse here regardless of the requested value — record no step, leave it unchecked.
    if (field.fieldType === "checkbox" && NOT_LISTED_CHECKBOX.test(field.label || "")) return null;

    // DETERMINISTIC GUARD: never check an "Alternative Billing Contact"-style checkbox.
    // Unchecked routes the portal's invoice to the installer email on file — the correct
    // default — while checking it demands an alternative email the project data doesn't
    // carry; the planner has been seen ticking it anyway, and the resulting contradiction
    // (checked box, no alt email) blocks the recipe trust gate on every run.
    if (field.fieldType === "checkbox" && /alternative\s+billing/i.test(field.label || "")) return null;

    // A "false/no/off/0" value means "leave this control unselected":
    //   • checkbox → leave it unchecked (its default); record no step.
    //   • radio    → skip THIS option — UNLESS the value echoes the radio's OWN label. A radio
    //     literally labeled "No" (e.g. "Do you propose to limit the export capacity? → No") is
    //     the chosen answer and MUST be clicked, otherwise the portal's default (often "Yes")
    //     stays selected — that's why we can't just skip every false-ish radio. But a radio the
    //     planner marked "false" that ISN'T a No/Off option (e.g. "3-Phase" in a Single/3-Phase
    //     group) means "don't pick this one" and must be left unselected. The planner selects a
    //     radio with value "true" or by echoing the option label, so a bare negation token that
    //     does NOT name this radio is an explicit "skip this option".
    const NEGATION = /^(false|no|off|0|unchecked|none)$/i;
    const v = value.trim();
    const labelLc = (field.label || "").trim().toLowerCase();
    const vLc = v.toLowerCase();
    const echoesOwnLabel = vLc.length > 0 && (labelLc === vLc || labelLc.includes(vLc) || vLc.includes(labelLc));
    const negated =
      field.fieldType === "checkbox" ? NEGATION.test(v)
      : field.fieldType === "radio" ? (NEGATION.test(v) && !echoesOwnLabel)
      : false;
    if (negated) return null; // leave unselected — no action and no recorded step

    const res = await safeAction(
      // The label is non-PII enough for a log line, but keep it short.
      (field.label || field.fieldType).slice(0, 40),
      async () => {
        const loc = await this.locator(field.selector);
        if (!loc) throw new Error("selector unresolved");
        // NEVER WAIT ON A CONTROL THAT CANNOT BECOME ACTIONABLE. fill()/check() block on
        // visibility for 30s (Playwright's default) and safeAction then retries 4x with
        // backoff — measured on a live Accela run, ONE display:none date input inside a
        // 0x0 container (title "This is a hidden field.") cost 137 SECONDS and recorded
        // nothing, because the field is optional so the failure was swallowed. A visibility
        // probe costs ~5ms. isVisible, NOT isEditable: a hidden input is still "editable".
        if (typeof loc.isVisible === "function" && !(await loc.isVisible().catch(() => true))) {
          this.debug?.event({ type: "hidden_field_skipped", label: (field.label || "").slice(0, 60) });
          throw new Error("control is not visible (hidden field)");
        }
        if (action === "select") {
          // A dependent/cascading <select> may still be disabled or have an empty option list
          // when we reach it (its options arrive via the AJAX a prior field triggered). Wait
          // for the target option to actually exist before selecting, so the choice isn't a
          // silent no-op. Bounded; custom comboboxes don't block. Portal-agnostic.
          await this.waitForOptionReady(loc, value);
          // Native <select> exact → native partial/normalized contains-match → custom-combobox
          // interaction for styled-div dropdowns. Shared with replay via selectWithFallback so
          // a value like "Schedule 7" resolves to "Schedule 7 - Residential…" identically in
          // both paths (a learn that fills it must replay it the same way).
          await selectWithFallback(this.page, loc, value);
        } else if (action === "check") {
          if (negated) {
            // Explicit false/no → uncheck the box (leave it unchecked).
            if (typeof loc.uncheck === "function") await loc.uncheck({ timeout: 5000 }).catch(() => {});
          } else {
            // Second-chance "not listed" guard AT THE ELEMENT: extraction can mis-associate a
            // checkbox's label (seen on PowerClerk — the "proposed PV equipment is not listed"
            // box surfaced with an unrelated label), which defeats the label-based guard above.
            // Read the element's OWN accessible text (label[for], wrapping label, aria-label)
            // in-page and refuse to check it if that text is the not-listed escape hatch.
            const ownText: string = typeof loc.evaluate !== "function" ? "" : await loc.evaluate((el: Element) => {
              const id = el.getAttribute("id");
              const root = el.getRootNode() as Document | ShadowRoot;
              // CSS.escape: an id with a quote/backslash would otherwise throw inside
              // querySelector, the catch would swallow it, and this guard would no-op on
              // exactly the mislabeled checkbox it exists to stop.
              const safeId = id && typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id;
              const forLabel = safeId && typeof (root as Document).querySelector === "function"
                ? (root as Document).querySelector(`label[for="${safeId}"]`)?.textContent
                : null;
              const wrapLabel = (el.closest && el.closest("label"))?.textContent;
              return (forLabel || wrapLabel || el.getAttribute("aria-label") || "").trim();
            }).catch(() => "");
            if (NOT_LISTED_CHECKBOX.test(ownText)) throw new Error(`refusing to check "not listed" escape hatch (${ownText.slice(0, 60)})`);
            await loc.check({ timeout: 5000 });
          }
        } else if (AutoLearnAdapter.MASKED_LABEL.test(field.label || "")) {
          // Masked/segmented control: keystrokes, not a value assignment (see MASKED_LABEL).
          const isPhone = /\b(phone|telephone|fax)\b/i.test(field.label || "");
          // "partial" still means the control IS segmented — writing the whole number into
          // one box is exactly the state the portal rejects, so only fall through when no
          // segmented control was found at all.
          const phoneMode = isPhone ? await this.fillPhoneSegments(this.page, value, field.selector?.frame) : "not-segmented";
          if (phoneMode === "not-segmented") {
            // Zip must be exactly ##### on ACA — a ZIP+4 is rejected outright.
            const typed = /\b(zip|postal)\b/i.test(field.label || "")
              ? (value.replace(/\D/g, "").slice(0, 5) || value)
              : value;
            await this.typeMasked(loc, typed);
          }
        } else {
          // Bounded: a control that never becomes actionable must not cost the 30s default.
          await loc.fill(value, { timeout: 8000 });
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
      // Heal tie-break metadata (attribute names only — never values).
      ...(field.fingerprint ? { fingerprint: field.fingerprint } : {}),
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

  // Click a "Calculate" / "Update Totals" style button that computes derived values from the
  // equipment just entered (system rating, export capacity) WITHOUT advancing the wizard.
  // Portal-agnostic: matched purely by an anchored compute-intent label, never a pay/submit/
  // navigation control, so it can't derail the flow. Records a replayable click step (replay
  // must recompute too, or the saved draft carries stale 0.00 totals). Returns true if clicked.
  private async clickComputeButton(steps: RecipeStep[]): Promise<boolean> {
    if (!this.page || typeof this.page.getByRole !== "function") return false;
    const COMPUTE = /^\s*(calculate|recalculate|re-calculate|compute|update\s+totals?|refresh\s+totals?|update\s+calculation)\s*$/i;
    try {
      const btn = this.page.getByRole("button", { name: COMPUTE }).first();
      if (!(await btn.count().catch(() => 0))) return false;
      if (!(await btn.isVisible().catch(() => false))) return false;
      if (!(await btn.isEnabled().catch(() => true))) return false;
      const label = ((await btn.textContent().catch(() => "")) || "").trim();
      // Defense in depth: never click something that's actually a pay or submit control.
      if (isPayFee(label) || SUBMIT_INTENT.test(label)) return false;
      await this.clickResilient(btn);
      await this.waitForDynamicFieldsSettle();
      await this.clearOverlays();
      steps.push({
        action: "click",
        phase: "fill",
        selector: { role: "button", name: label || "Calculate", exact: true },
        note: `compute totals: ${label || "Calculate"}`,
      });
      return true;
    } catch {
      return false;
    }
  }

  // Sweep the LIVE page for REQUIRED fields that are still empty/unselected after this page's
  // fills + cascade. This catches what verifyFillsLanded cannot: required fields the planner
  // NEVER touched (so they're not in appliedThisPage) — an unanswered Yes/No option group
  // ("limit export capacity?", "smart inverter settings?"), an unselected equipment-model
  // dropdown, a dropped Schedule. Sensitive fields (account/meter/password) are EXCLUDED:
  // they're intentionally blank during learn and bound at replay from the credential store, so
  // flagging them would block every PowerClerk recipe from ever being trusted. The standard
  // "I understand my form will not be submitted…" acknowledgment is excluded too — it's the
  // review-gate checkbox, ticked at the review screen, not a data field. Returns visible labels.
  private async collectUnfilledRequired(): Promise<string[]> {
    if (!this.page || typeof this.page.evaluate !== "function") return [];
    const labels = await this.page.evaluate(() => {
      const SENSITIVE = /\b(password|passcode|account\s*(number|no|#)?|acct|meter\s*(number|no|#)?|ssn|social security|tax\s*id|ein|routing|card\s*number|cvv|security code)\b/i;
      const ACK = /will not be submitted until|i understand\b|i acknowledge|i certify|i attest|accept (the )?terms|terms (and|&) conditions/i;
      const norm = (s: string | null | undefined) => (s || "").trim().replace(/\s+/g, " ");
      // Walk OPEN shadow roots too — a required field inside a web component must gate
      // trust exactly like a light-DOM one (the fill loop can see and fill it, so this
      // sweep must see it as well or the two disagree).
      const deepQueryAll = (root: ParentNode, sel: string): Element[] => {
        const found: Element[] = Array.from(root.querySelectorAll(sel));
        for (const host of Array.from(root.querySelectorAll("*"))) {
          if ((host as Element).shadowRoot) found.push(...deepQueryAll((host as Element).shadowRoot as ShadowRoot, sel));
        }
        return found;
      };
      const labelOf = (el: Element): string => {
        const id = el.getAttribute("id");
        if (id) { const l = (el.getRootNode() as Document | ShadowRoot).querySelector(`label[for="${CSS.escape(id)}"]`); if (l?.textContent?.trim()) return norm(l.textContent); }
        const w = el.closest("label"); if (w?.textContent?.trim()) return norm(w.textContent);
        const grp = el.closest("fieldset, .form-group, [class*='form-group'], [class*='field'], .row, [class*='row']");
        const gl = grp?.querySelector("legend, label, .control-label, .field-label, strong, b");
        if (gl?.textContent?.trim()) return norm(gl.textContent);
        return norm(el.getAttribute("aria-label") || el.getAttribute("name") || "");
      };
      const hasAsterisk = (el: Element, group: boolean): boolean => {
        if ((el as HTMLInputElement).required || el.getAttribute("aria-required") === "true") return true;
        const id = el.getAttribute("id");
        if (!group && id) { const l = (el.getRootNode() as Document | ShadowRoot).querySelector(`label[for="${CSS.escape(id)}"]`); if (l && /\*/.test(l.textContent || "")) return true; }
        if (!group) { const w = el.closest("label"); if (w && /\*/.test(w.textContent || "")) return true; }
        if (group) {
          const grp = el.closest("fieldset, .form-group, [class*='form-group'], [class*='field'], .row, [class*='row']");
          const gl = grp?.querySelector("legend, label, .control-label, .field-label, strong, b");
          if (gl && /\*/.test(gl.textContent || "")) return true;
        }
        return false;
      };
      const isVisible = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect?.();
        return !!r && (r.width > 0 || r.height > 0);
      };
      const out = new Set<string>();
      const seenRadioGroups = new Set<string>();
      // text/textarea/select
      for (const el of deepQueryAll(document, "input, textarea, select")) {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (type === "hidden") continue;
        if (!isVisible(el)) continue;
        const lbl = labelOf(el);
        if (!lbl || SENSITIVE.test(lbl) || ACK.test(lbl)) continue;
        if (tag === "select") {
          if (!hasAsterisk(el, false)) continue;
          const v = norm((el as HTMLSelectElement).value);
          const txt = norm((el as HTMLSelectElement).selectedOptions?.[0]?.textContent);
          if (!v || /^(please\s+)?select\.{0,3}$/i.test(txt)) out.add(lbl);
        } else if (type === "radio") {
          if (!hasAsterisk(el, true)) continue;
          const name = el.getAttribute("name") || lbl;
          if (seenRadioGroups.has(name)) continue;
          seenRadioGroups.add(name);
          // Radio groups scope to the element's own root (a shadow component's radios share
          // a name only within that root).
          const anyChecked = Array.from((el.getRootNode() as Document | ShadowRoot).querySelectorAll(`input[type=radio][name="${CSS.escape(name)}"]`)).some((r) => (r as HTMLInputElement).checked);
          if (!anyChecked) out.add(lbl);
        } else if (type === "checkbox" || type === "file" || type === "button" || type === "submit") {
          continue; // checkboxes default-false legitimately; uploads handled separately
        } else {
          if (!hasAsterisk(el, false)) continue;
          if (!norm((el as HTMLInputElement).value)) out.add(lbl);
        }
      }
      return Array.from(out).slice(0, 20);
    }).catch(() => [] as string[]);
    return Array.isArray(labels) ? labels : [];
  }

  // Read each applied fill back; re-apply once if it didn't hold; return the labels of REQUIRED
  // fields that STILL won't hold their value (the portal silently dropped them).
  private async verifyFillsLanded(applied: AppliedFill[]): Promise<string[]> {
    const misses: string[] = [];
    for (const a of applied) {
      // Sensitive fields (account/meter) are INTENTIONALLY left blank during a learn run — we
      // never keep their literal value; it's bound at replay from the credential/project store.
      // So they read back empty by design. Flagging that emptiness as a required-field miss would
      // make hasHardBlockers true → trusted=false → the recipe is stuck in "recording" forever
      // and staging re-runs autolearn instead of replaying. Skip them here (collectUnfilledRequired
      // and the deterministic trust check already exclude sensitive fields for the same reason).
      if (a.sensitive) continue;
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
    return isPayFee(field.label) || isPayFee(sel?.name) || isPayFee(sel?.text)
      || EXISTING_RECORD_ACTION.test(field.label || "")
      || EXISTING_RECORD_ACTION.test(sel?.name || "")
      || EXISTING_RECORD_ACTION.test(sel?.text || "");
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
    await dismissPageModals(this.page);
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
    await clearPageOverlays(this.page);
  }

  // Build a Playwright locator for a single selector descriptor (no fallback chain).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _buildLocator(page: Page, sel: RecipeSelector): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scope: any = sel.frame ? page.frameLocator(frameSelectorFor(sel.frame)) : page;
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
          // NO HOISTED HELPER OF ANY KIND inside an in-page callback: the bundler's
          // keepNames transform wraps any function it can infer a name for — both
          // `const vis = (el) => …` and `const vis = function (el) {…}` — as
          // `__name(fn, "vis")`, and `__name` does not exist in the browser. Verified in
          // real Chromium: both forms throw "ReferenceError: __name is not defined"; only
          // a fully inline anonymous callback survives. The surrounding catch turned that
          // throw into a permanent "no autosave in flight", so this guard never fired.
          // Text-based "Saving…/Processing…" status (PowerClerk's top-right "Saving…").
          const texts = Array.from(document.querySelectorAll<HTMLElement>("span, div, small, p, label"));
          for (const el of texts) {
            const t = (el.textContent || "").trim();
            const rr = el.getBoundingClientRect();
            const ss = window.getComputedStyle(el);
            const visible = rr.width > 0 && rr.height > 0 && ss.visibility !== "hidden" && ss.display !== "none";
            if (/^(saving|processing|uploading|please wait)(\.{0,3}|…)?$/i.test(t) && visible) return true;
          }
          // Common spinner/overlay classes used by SPA wizards while an XHR is in flight.
          const spinners = document.querySelectorAll(
            "[class*='saving'], [class*='spinner']:not([style*='display: none']), .loading-overlay, .x-mask-loading, [aria-busy='true']",
          );
          for (const el of spinners) {
            const rr = (el as HTMLElement).getBoundingClientRect();
            const ss = window.getComputedStyle(el as HTMLElement);
            if (rr.width > 0 && rr.height > 0 && ss.visibility !== "hidden" && ss.display !== "none") return true;
          }
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
        // Include OPEN shadow roots — a web component's inline validation must be able to
        // block an advance exactly like light-DOM validation.
        const deepQueryAll = (root: ParentNode, sel: string): Element[] => {
          const found: Element[] = Array.from(root.querySelectorAll(sel));
          for (const host of Array.from(root.querySelectorAll("*"))) {
            if ((host as Element).shadowRoot) found.push(...deepQueryAll((host as Element).shadowRoot as ShadowRoot, sel));
          }
          return found;
        };

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
          for (const el of deepQueryAll(document, sel) as HTMLElement[]) {
            const t = el.innerText?.trim();
            if (t && t.length > 3 && el.offsetParent !== null) add(t);
          }
        }

        // 2. aria-invalid inputs that are also required — append a synthetic label+message.
        for (const el of deepQueryAll(
          document,
          "input[aria-invalid='true'][required], select[aria-invalid='true'][required], " +
          "textarea[aria-invalid='true'][required]"
        ) as Array<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) {
          const label = ((el.getRootNode() as Document | ShadowRoot).querySelector(`label[for="${el.id}"]`) as HTMLLabelElement)?.innerText?.trim()
            || (el as HTMLInputElement).placeholder || el.name || "Field";
          add(`${label}: This field is required.`);
        }

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
    // A selector with no usable strategy (empty {} — e.g. an ASP.NET radio the extractor
    // couldn't key) makes _buildLocator THROW; catch it so a deterministic pass bails
    // gracefully instead of crashing the whole run (live: contact-dialog radio).
    let primary: any;
    try { primary = this._buildLocator(this.page, sel); }
    catch { primary = null; }
    if (primary && (await primary.count().catch(() => 0)) > 0) return primary;
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

// SHARED WITH REPLAY. Extracted verbatim from AutoLearnAdapter.dismissModals so the RecipeAdapter
// can run the same pass: replay had NO modal handling at all, and the first live replay died
// on step 2 of 99 because PowerClerk's "What's new?" popover — which this code already knows
// how to dismiss — swallowed the click that opens a new application. The learner never hit it
// because it dismisses modals at the top of every page; replay is the path that actually runs
// for every project.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function dismissPageModals(page: any): Promise<void> {
  if (!page) return;
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
        const loc = page.locator(sel).first();
        if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
          await loc.click({ timeout: 2000 }).catch(() => null);
          await smartWait(page, 400);
          dismissed = true;
          break;
        }
      } catch { /* non-fatal */ }
    }
    // Fallback: a lingering backdrop/popover with no matched button — press Escape.
    if (!dismissed) {
      const backdrop = await page
        .locator('.modal-backdrop, [class*="backdrop"], div.position-absolute.opacity-50.bg-black, .popover')
        .first().count().catch(() => 0);
      if (backdrop > 0) {
        try { await page.keyboard?.press?.("Escape"); } catch { /* no keyboard (mock) */ }
        await smartWait(page, 300);
        dismissed = true; // loop once more to confirm it cleared
      }
    }
    if (!dismissed) break;
  }
}

// SHARED WITH REPLAY. Extracted verbatim from AutoLearnAdapter.clearOverlays so the RecipeAdapter
// can run the same pass: replay had NO modal handling at all, and the first live replay died
// on step 2 of 99 because PowerClerk's "What's new?" popover — which this code already knows
// how to dismiss — swallowed the click that opens a new application. The learner never hit it
// because it dismisses modals at the top of every page; replay is the path that actually runs
// for every project.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function clearPageOverlays(page: any): Promise<void> {
  if (!page || typeof page.evaluate !== "function") return;
  try {
    await page.evaluate(() => {
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
