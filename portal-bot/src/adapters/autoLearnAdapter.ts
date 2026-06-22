import type { ProjectRecord, RecipeSelector, RecipeStep, PortalRecipeLoginStep } from "../../../shared/src/types";
import { BasePortalAdapter, HUMAN_REVIEW_MESSAGE, type PortalContext, type PortalStepResult } from "../adapter";
import { openPortal } from "../browser";
import { detectChallengeFrame, redactStatusText, safeAction } from "../safeAction";

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
  /** The fillable fields + candidate buttons on the CURRENT page. */
  fields: ExtractedField[];
  /** Short, redacted page text snippet (<= 2000 chars). */
  bodyText: string;
  /** Labels filled on prior pages (for context). */
  alreadyFilledLabels: string[];
}

export interface LearnPlanResponse {
  /** Fills to apply; selectorIndex indexes into request.fields. */
  fills: Array<{ selectorIndex: number; value: string; field?: string }>;
  /** A "Next/Continue" button to click to reach the NEXT form page (NOT final submit). */
  advanceSelectorIndex?: number;
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
    } else if (tag === "button" || (tag === "input" && (typeAttr === "submit" || typeAttr === "button"))) {
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
    const role = el.getAttribute("role") || (fieldType === "button" ? "button" : undefined);
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
    // Buttons: prefer role+name (visible text), else css id.
    if (raw.text) {
      selector.role = "button";
      selector.name = raw.text;
    } else if (raw.id) {
      selector.css = `#${raw.id}`;
    } else if (raw.name) {
      selector.name = raw.name;
      selector.role = "button";
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private page: any = null;
  private maxPages: number;

  constructor(
    portalName: string,
    private planner: LearnPlanner,
    private options: { maxPages?: number; autoSubmit?: false } = {},
  ) {
    super();
    this.portalName = portalName;
    this.maxPages = options.maxPages ?? 8;
  }

  // --- credential injection (mirrors recipeAdapter.login) -------------------
  async login(context: PortalContext): Promise<PortalStepResult> {
    try {
      const opened = await openPortal({
        userDataDir: context.userDataDir,
        storageStatePath: context.storageStatePath,
        headless: context.headless ?? false,
      });
      this.opened = opened;
      this.page = opened.page;

      // Navigate to the portal entry URL so the learn loop starts on the application page.
      if (context.startUrl) {
        await this.page.goto(context.startUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
        await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
      }

      // If a credential is available, auto-fill a login form when the session expired.
      // Never logs credentials. The login selectors are best-effort/structural.
      if (context.credential) {
        try {
          const challenge = await detectChallengeFrame(this.page);
          if (challenge) {
            return { ok: false, message: `Login paused: ${challenge}. Complete verification in the browser, then retry.`, pauseReason: "mfa_captcha" };
          }
          const loginStep: PortalRecipeLoginStep = {
            usernameSel: { css: 'input[type="email"], input[name*="user" i], input[name*="email" i]' },
            passwordSel: { css: 'input[type="password"]' },
            submitSel: { role: "button", name: /log\s*in|sign\s*in|submit/i.source },
          };
          const uLoc = this.locator(loginStep.usernameSel);
          if (uLoc && (await uLoc.count().catch(() => 0)) > 0) {
            await uLoc.fill(context.credential.username);
            const pLoc = this.locator(loginStep.passwordSel);
            if (pLoc && (await pLoc.count().catch(() => 0)) > 0) {
              await pLoc.fill(context.credential.password);
            }
            const sLoc = this.locator(loginStep.submitSel);
            if (sLoc && (await sLoc.count().catch(() => 0)) > 0) {
              await sLoc.click();
            }
            await this.page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => null);
            const postChallenge = await detectChallengeFrame(this.page);
            if (postChallenge) {
              return { ok: false, message: `MFA/2FA required after credential fill — pausing for human (${postChallenge}). Complete verification in the browser window, then retry.`, pauseReason: "mfa_captcha" };
            }
          }
        } catch (fillErr) {
          return { ok: false, message: `Auto-learn credential auto-fill failed: ${fillErr instanceof Error ? fillErr.message : String(fillErr)}` };
        }
      }

      return { ok: true, message: `Opened ${this.portalName} for autonomous learning. Using the persistent login session (log in once with npm run portal:login if prompted).` };
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
      // a) Challenge gate BEFORE any page action.
      const challenge = await detectChallengeFrame(this.page);
      if (challenge) {
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
      pageCount++;

      // b) Extract fields + candidate buttons on the current page.
      let fields: ExtractedField[];
      let pageTitle = "";
      let url = "";
      let bodyText = "";
      try {
        const raws: RawField[] = await this.page
          .$$eval("input, select, textarea, button, [role=button]", extractFieldsInPage)
          .catch(() => [] as RawField[]);
        fields = raws.map(toExtractedField);
        pageTitle = typeof this.page.title === "function" ? String((await this.page.title().catch(() => "")) ?? "") : "";
        url = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
        const rawBody = await this.page.locator("body").innerText().catch(() => "");
        bodyText = (redactStatusText(String(rawBody)) ?? "").slice(0, 2000);
      } catch (err) {
        return fail(steps, this.portalName, `Failed to scrape page ${pageCount}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // c) Ask the planner what to do on this page.
      let plan: LearnPlanResponse;
      try {
        plan = await this.planner({ url, pageTitle, fields, bodyText, alreadyFilledLabels });
      } catch (err) {
        return fail(steps, this.portalName, `Planner failed on page ${pageCount}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // c2) STRUCTURAL REVIEW GUARD — the Accela "Continue Application" trap.
      // A page with NO fillable inputs is a read-only review/confirm page; its primary
      // button (e.g. "Continue Application") SUBMITS. We NEVER advance-click on such a
      // page — we force the review stop and record that button as the final submit,
      // overriding the planner if it mistook the submit button for an "advance/next".
      const hasFillable = fields.some((f) => f.fieldType !== "button");
      const isReviewPage = !hasFillable || ((REVIEW_MARKERS.test(bodyText) || looksLikeReviewUrl(url)) && fields.some((f) => f.fieldType === "button" && SUBMIT_INTENT.test(f.label)));
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

      // d) Apply the fills and record each as a RecipeStep.
      for (const fillReq of plan.fills ?? []) {
        const field = fields[fillReq.selectorIndex];
        if (!field) continue; // out-of-range index from the planner — skip safely.
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
        const res = await safeAction(
          "advance",
          async () => {
            const loc = this.locator(advanceField.selector);
            if (!loc) throw new Error("advance selector unresolved");
            await loc.click();
            await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
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
    const message = reachedReview
      ? `${HUMAN_REVIEW_MESSAGE} Auto-learn reached the review screen after ${pageCount} page(s). Verify every field/value below before a human submits.`
      : filledSomething
        ? `Auto-learn filled ${pageCount} page(s) and recorded the steps, but did not reach a review screen.`
        : `Auto-learn found nothing fillable on ${pageCount} page(s); no steps recorded.`;

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
        const loc = this.locator(field.selector);
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

    const rawBody = await this.page.locator("body").innerText().catch(() => "");
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

  // Build a Playwright locator from a portable selector descriptor (mirrors recipeAdapter).
  private locator(sel?: RecipeSelector) {
    if (!sel) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scope: any = sel.frame ? this.page.frameLocator(`iframe[name="${sel.frame}"]`) : this.page;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let loc: any;
    if (sel.role && sel.name) loc = scope.getByRole(sel.role, { name: sel.name, exact: sel.exact });
    else if (sel.label) loc = scope.getByLabel(sel.label, { exact: sel.exact });
    else if (sel.placeholder) loc = scope.getByPlaceholder(sel.placeholder, { exact: sel.exact });
    else if (sel.testId) loc = scope.getByTestId(sel.testId);
    else if (sel.text) loc = scope.getByText(sel.text, { exact: sel.exact });
    else if (sel.css) loc = scope.locator(sel.css);
    else if (sel.role) loc = scope.getByRole(sel.role);
    else throw new Error("AutoLearn selector has no usable strategy.");
    return typeof sel.nth === "number" ? loc.nth(sel.nth) : loc.first();
  }
}
