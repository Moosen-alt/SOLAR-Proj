import type { Page } from "playwright";
import type { ProjectRecord, RecipeSelector, RecipeStep } from "../../../shared/src/types";
import { BasePortalAdapter, HUMAN_REVIEW_MESSAGE, type PortalContext, type PortalStepResult } from "../adapter";
import { openPortal } from "../browser";
import { detectChallengeFrame, redactStatusText, safeAction, sleep, smartWait, waitForElement } from "../safeAction";
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
}

// ---------------------------------------------------------------------------
// Safety classifiers (shared shape with recipeAdapter's gate).
// ---------------------------------------------------------------------------

// ALWAYS-blocked fee-payment controls — never recorded as advance/finalSubmit, never clicked.
const PAY_FEE = /\b(pay fee|pay now|submit & pay|submit and pay|make payment|pay \$|add to cart|proceed to (payment|checkout)|checkout|fee)\b/i;

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

function isPayFee(text: string | undefined): boolean {
  return !!text && PAY_FEE.test(text);
}

function isSensitiveLabel(label: string): boolean {
  return SENSITIVE_LABEL.test(label);
}

// ---------------------------------------------------------------------------
// The DOM extraction script — runs in the page via $$eval. Pure (no closures over
// adapter state) so it can be serialized into the browser. Returns plain JSON.
// ---------------------------------------------------------------------------

interface RawField {
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
}

// Serializable extractor — derives a label and selector hints for each interactive
// element. Defined as a string-compatible function so it runs inside the page.
function extractFieldsInPage(els: Element[]): RawField[] {
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

    out.push({ label, fieldType, options, role, name, placeholder, id, text });
  }
  return out;
}

// Turn a RawField captured in the page into the contract's ExtractedField, building a
// stable RecipeSelector preferring label / role+name / name, falling back to css #id.
function toExtractedField(raw: RawField): ExtractedField {
  const selector: RecipeSelector = {};
  if (raw.fieldType === "button") {
    // Use the element's actual ARIA role ("link" for <a> tags, "button" otherwise).
    // getByRole("button", {name}) never matches a plain <a> — it must be "link".
    const ariaRole = raw.role || "button";
    if (raw.text) {
      selector.role = ariaRole;
      selector.name = raw.text;
      // Always keep a css fallback so a role-name miss still resolves the element.
      if (raw.id) selector.fallbacks = [{ css: `#${raw.id}` }];
    } else if (raw.id) {
      selector.css = `#${raw.id}`;
    } else if (raw.name) {
      selector.name = raw.name;
      selector.role = ariaRole;
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

  constructor(
    portalName: string,
    private planner: LearnPlanner,
    private options: { maxPages?: number; autoSubmit?: false; docsByType?: Record<string, string> } = {},
  ) {
    super();
    this.portalName = portalName;
    this.maxPages = options.maxPages ?? 8;
    this.docsByType = options.docsByType ?? {};
  }

  // Resolve the document file to attach to a given file-input field. Matches the field's
  // label to a docType, then to an available split file in docsByType. Falls back to the
  // full package/plan set for a generic upload control. Returns null when nothing is
  // available (the upload is then left for the human, never faked).
  private resolveUpload(field: ExtractedField): { docType: string; file: string } | null {
    const label = field.label || "";
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
  async learn(context: PortalContext, _project: ProjectRecord): Promise<LearnResult> {
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

    for (let pageIdx = 0; pageIdx < this.maxPages; pageIdx++) {
      pageCount++;

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

      // PAGE CLASSIFICATION. A page with NO fillable inputs is EITHER a dashboard/home
      // (just navigation links — the portal entry screen after login) OR a read-only
      // REVIEW/confirm page (a data summary + a submit-intent button). They look identical
      // by "no inputs" alone, so discriminate by submit-intent button + review markers:
      //   - REVIEW  → has a submit-intent button (Continue Application/Submit/Finish) or
      //               review markers ("Step N: Review", "review all information", /review URL).
      //   - DASHBOARD → no inputs, no submit-intent button, no review markers → only links.
      const hasFillable = fields.some((f) => f.fieldType !== "button");
      const hasSubmitIntentBtn = fields.some((f) => f.fieldType === "button" && SUBMIT_INTENT.test(f.label));
      const reviewSignals = REVIEW_MARKERS.test(bodyText) || looksLikeReviewUrl(url);
      const isDashboard = !hasFillable && !hasSubmitIntentBtn && !reviewSignals;
      if (hasFillable) everFoundFillable = true;

      // a0) STUCK-PAGE GUARD — bail if the same page recurs across iterations (advance had
      //     no effect). Stops a silent infinite loop without waiting out maxPages.
      const loopFp = await this.pageFingerprint();
      if (loopFp && loopFp === lastLoopFp) {
        if (++stuckStreak >= 2) {
          if (process.env.AUTOLEARN_DEBUG === "1") console.error(`[learn] stuck on the same page for 3 iterations — stopping.`);
          break;
        }
      } else {
        stuckStreak = 0;
        lastLoopFp = loopFp;
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
        plan = await this.planner({ url, pageTitle, fields, bodyText, alreadyFilledLabels, isDashboard });
      } catch (err) {
        return fail(steps, this.portalName, `Planner failed on page ${pageCount}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // c2) STRUCTURAL REVIEW GUARD — the Accela "Continue Application" trap.
      // On a review page its primary button (e.g. "Continue Application") SUBMITS, so we
      // NEVER advance-click — we force the review stop and record that button as the final
      // submit, overriding a planner that mistook the submit button for an "advance/next".
      // A no-input page that is NOT a dashboard is, by definition, a review page.
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
              await this.clickResilient(loc);
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
      for (const fillReq of plan.fills ?? []) {
        const field = fields[fillReq.selectorIndex];
        if (!field) continue; // out-of-range index from the planner — skip safely.
        if (field.fieldType === "file") continue; // handled by the upload pass above.
        const sensitive = isSensitiveLabel(field.label);
        const step = await this.applyFill(field, fillReq, sensitive);
        if (step) {
          steps.push(step);
          if (field.label) alreadyFilledLabels.push(field.label);
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

    const message = reachedReview
      ? `${HUMAN_REVIEW_MESSAGE} Auto-learn reached the review screen after ${pageCount} page(s). Verify every field/value below before a human submits.`
      : filledSomething
        ? `Auto-learn filled ${pageCount} page(s) and recorded the steps, but did not reach a review screen. Page trace: ${traceLine}`
        : `Auto-learn found nothing fillable on ${pageCount} page(s); no steps recorded.${nothingFillableHint} Page trace: ${traceLine}`;

    // Capture review page screenshot when we've reached the review screen
    let reviewScreenshotBase64: string | undefined;
    try {
      const buf = await this.page.screenshot({ type: "png", fullPage: false });
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
    const action: RecipeStep["action"] =
      field.fieldType === "select" ? "select" : field.fieldType === "checkbox" ? "check" : "fill";

    const res = await safeAction(
      // The label is non-PII enough for a log line, but keep it short.
      (field.label || field.fieldType).slice(0, 40),
      async () => {
        const loc = await this.locator(field.selector);
        if (!loc) throw new Error("selector unresolved");
        if (action === "select") {
          await loc.selectOption(value).catch(async () => loc.selectOption({ label: value }));
        } else if (action === "check") {
          await loc.check();
        } else {
          await loc.fill(value);
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
      // A portal-literal value (dropdown option / fixed text).
      step.value = value;
    }
    return step;
  }

  // A button is off-limits if its label/selector text matches a pay/fee/checkout keyword.
  private isOffLimitsButton(field: ExtractedField): boolean {
    const sel = field.selector;
    return isPayFee(field.label) || isPayFee(sel?.name) || isPayFee(sel?.text);
  }

  // Scrape visible label/value pairs on the review screen. Values are redacted. Best
  // effort: reads input/select/textarea current values plus their derived labels.
  private async scrapeReviewScreen(): Promise<LearnResult["reviewScreen"]> {
    if (!this.page) return { fields: [], bodyTextSnippet: "" };
    const pairs: Array<{ label: string; value: string }> = await this.page
      .$$eval("input, select, textarea", (els: Element[]) => {
        function labelFor(el: Element): string {
          const id = el.getAttribute("id");
          if (id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (lbl && lbl.textContent) return lbl.textContent.trim();
          }
          const parentLabel = el.closest("label");
          if (parentLabel && parentLabel.textContent) {
            const t = parentLabel.textContent.trim();
            if (t) return t;
          }
          return (
            el.getAttribute("aria-label") ||
            el.getAttribute("placeholder") ||
            el.getAttribute("name") ||
            ""
          ).trim();
        }
        const out: Array<{ label: string; value: string }> = [];
        for (const el of els) {
          const tag = el.tagName.toLowerCase();
          const typeAttr = (el.getAttribute("type") || "").toLowerCase();
          if (tag === "input" && (typeAttr === "hidden" || typeAttr === "password" || typeAttr === "file")) continue;
          let value = "";
          if (tag === "select") {
            const sel = el as HTMLSelectElement;
            const opt = sel.selectedOptions && sel.selectedOptions[0];
            value = opt ? (opt.textContent || "").trim() : sel.value;
          } else {
            value = (el as HTMLInputElement).value || "";
          }
          if (!value) continue;
          const label = labelFor(el);
          out.push({ label, value });
        }
        return out;
      })
      .catch(() => [] as Array<{ label: string; value: string }>);

    const redactedFields = pairs.map((p) => ({
      label: p.label,
      value: redactStatusText(p.value) ?? "",
    }));

    const rawBody = await this.page!.locator("body").innerText().catch(() => "");
    const bodyTextSnippet = (redactStatusText(String(rawBody)) ?? "").slice(0, 2000);

    return { fields: redactedFields, bodyTextSnippet };
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

  // Click that survives a modal/popover overlay intercepting pointer events. Works for
  // both PowerClerk (Vue backdrop) and Accela (ExtJS .x-mask page-wide loading masks).
  // Strategy per attempt: dismiss modals → clear overlays → wait for visible → scroll into
  // view → click. Falls back to force-click (bypasses coverage check) then dispatchEvent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async clickResilient(loc: any): Promise<void> {
    const dbg = process.env.AUTOLEARN_DEBUG === "1";
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.dismissModals();
      await this.clearOverlays();
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
  private async clearOverlays(): Promise<void> {
    if (!this.page || typeof this.page.evaluate !== "function") return;
    try {
      await this.page.evaluate(() => {
        const sel = [
          // PowerClerk (Bootstrap/Vue): semi-transparent position-absolute loading scrims
          "div.position-absolute.opacity-50.bg-black",
          ".modal-backdrop",
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
