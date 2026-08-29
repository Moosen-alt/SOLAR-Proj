import fs from "fs";
import path from "path";
import type { PortalRecipe, ProjectRecord, RecipeSelector, RecipeStep } from "../../../shared/src/types";
import { BasePortalAdapter, HUMAN_REVIEW_MESSAGE, ok, fail, type PortalContext, type PortalStepResult } from "../adapter";
import { openPortal } from "../browser";
import { selectWithFallback } from "../comboboxFill";
import { detectChallengeFrame, frameSelectorFor, hasNumericValidationError, scanStatusFromBody, RETRY_BACKOFF_MS, sleep, smartWait, toBareNumber, waitForElement, waitForInteractiveControls } from "../safeAction";
import { performLogin } from "./loginFlow";
import { EXTRACT_SEL, extractFieldsInPage, toExtractedField, dismissPageModals, clearPageOverlays, equipmentMakeCandidates } from "./autoLearnAdapter";
import { tagUploadControls } from "./autoLearnAdapter";

// RecipeAdapter — replays a recorded portal recipe (see portal_recipes / the recorder).
// Works for ANY AHJ or utility portal an admin has taught by recording. It substitutes
// the project + assigned-client field values and uploads the right docs, then STOPS at
// the review screen.
//
// SECURITY (hybrid submit model):
//   - DEFAULT (guided manual): stops at the `stopForReview` marker and never clicks the
//     final application-submit — a human always submits.
//   - autoSubmit (opt-in per trusted portal, operator-approved): may proceed past the
//     review marker, but ONLY to click a step the operator/recorder EXPLICITLY flagged
//     `isFinalSubmit: true`. Everything past the review marker without that flag is
//     hard-blocked, as is any step whose selector name/text matches submit/pay keywords.
//     It still NEVER clicks a fee-payment control (PAY_FEE), and bails to a human if a
//     CAPTCHA/MFA challenge (including iframe-based) appears at the final step.
//
// P0-3: the final-submit decision is an ALLOWLIST (explicit isFinalSubmit flag set by a
// trusted recorder/operator), NOT a denylist over recorded selector `name` text — which
// is empty for id-based ASP.NET buttons and would let submit/pay slip through.

// ALWAYS-blocked fee-payment controls (even on a trusted auto-submit portal).
const PAY_FEE = /\b(pay fee|pay now|submit & pay|submit and pay|make payment|pay \$|add to cart|proceed to (payment|checkout)|checkout)\b/i;
// Submit-ish keywords. A step matching these is HARD-BLOCKED in autoSubmit UNLESS it
// also carries the explicit isFinalSubmit flag — we never decide "this is the submit
// button" purely from a regex over recorded names.
const SUBMIT_KEYWORDS = /\b(submit|file application|finalize|finish|complete application|send application|confirm submission)\b/i;

// A recorded step may carry an operator/recorder-set `isFinalSubmit` flag. This field
// is not (yet) in the shared RecipeStep type, so read it structurally + type-safely.
function isFinalSubmitStep(step: RecipeStep): boolean {
  return (step as { isFinalSubmit?: unknown }).isFinalSubmit === true;
}

// A fill on a control that never becomes actionable must not cost Playwright's 30s
// default — on replay that failure aborts the entire run, not just the step.
const FILL_TIMEOUT_MS = 8000;

// Actions whose target control is identified by a LABEL and therefore worth verifying
// before we touch it. Navigation (goto/click) and uploads are excluded: a button's text is
// already its selector, and an upload's real input is routinely unlabelled and hidden.
// Escape an id for a css selector on the NODE side (CSS.escape is browser-only).
const CSS_ESCAPE = (v: string): string => v.replace(/([^a-zA-Z0-9_-])/g, "\$1");
const IDENTITY_CHECKED = new Set(["fill", "select", "check", "uncheck"]);
// Words too common in portal labels to prove two labels mean the same question.
const IDENTITY_STOPWORDS = new Set([
  "this", "that", "your", "will", "with", "from", "please", "select", "there", "have",
  "does", "the", "and", "for", "are", "you", "system", "site", "number", "name", "type",
  "information", "address", "would", "like", "used", "using", "enter", "provide",
]);

export class RecipeAdapter extends BasePortalAdapter {
  portalName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private page: any = null;
  /** Steps repaired mid-replay by label re-anchoring (reported to the backend,
   *  which patches the recipe and requires human re-verification). */
  private healedSteps: Array<{ note: string; action: string; selector: RecipeSelector }> = [];
  /** Drift-precheck annotations ("this page barely matches the recipe") — surfaced
   *  in every result payload so a run that squeaked through via heals still tells
   *  the operator the portal likely changed. */
  private driftWarnings: string[] = [];
  // Set true ONLY when the automation actually clicked an explicit isFinalSubmit step
  // in autoSubmit mode and the portal accepted it (no challenge / no error).
  finalSubmitClicked = false;

  constructor(
    private recipe: PortalRecipe,
    private fieldValues: Record<string, string>,
    private docsByType: Record<string, string>,
    private options: { autoSubmit?: boolean } = {},
  ) {
    super();
    this.portalName = `Recipe: ${recipe.ahj || recipe.utility || recipe.profileKey} (${recipe.portalPlatform || "portal"})`;
  }

  async login(context: PortalContext): Promise<PortalStepResult> {
    try {
      const opened = await openPortal({
        userDataDir: context.userDataDir,
        storageStatePath: context.storageStatePath,
        // Pass headless through (undefined when unset) so resolveHeadless picks the
        // server-correct default; a hard `?? false` would crash on a display-less server.
        headless: context.headless,
      });
      this.opened = opened;
      this.page = opened.page;
      if (this.recipe.portalUrl) {
        await this.page.goto(this.recipe.portalUrl);
        await smartWait(this.page);
      }

      // Log in via the shared, portal-agnostic login flow. It detects/reveals the login
      // form, fills it (known + unknown portals), verifies success, and stops on MFA.
      // When the persistent session is still valid there's no form and it's a no-op.
      // Never logs credentials.
      const login = await performLogin(this.page, context.credential);
      if (login.status === "mfa_captcha") {
        return { ok: false, message: login.message, pauseReason: "mfa_captcha" };
      }
      if (login.status === "no_credential") {
        return fail(`${this.portalName}: a login page is showing but no stored credential was found for this client/portal. Add the portal login under the client's logins and re-stage.`);
      }
      if (!login.ok && login.status !== "already_authenticated") {
        return fail(`${this.portalName}: ${login.message}`);
      }

      return ok(`Opened ${this.portalName}. ${login.message}`);
    } catch (err) {
      return fail(`Recipe login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // openSubmission/uploadFiles are no-ops: the recipe replays as ONE ordered sequence
  // (navigation, fills, AND uploads interleaved exactly as recorded) inside
  // fillApplication, so multi-page portals stay in the right order.
  async openSubmission(_project: ProjectRecord): Promise<PortalStepResult> {
    return ok("Recipe replay runs as a single ordered sequence; see fill step.");
  }
  async fillApplication(_project: ProjectRecord): Promise<PortalStepResult> {
    return this.runAll();
  }
  async uploadFiles(_project: ProjectRecord, _files: string[]): Promise<PortalStepResult> {
    return ok("Uploads are replayed inline within the recorded sequence.");
  }
  async stopAtReview(): Promise<PortalStepResult> {
    if (this.finalSubmitClicked) {
      return ok(
        `${this.portalName}: approved auto-submit clicked the recorded final application submit and the portal accepted it. No fee payment was automated.`,
        { finalSubmitClicked: true },
      );
    }
    return ok(
      `${HUMAN_REVIEW_MESSAGE} The recipe staged ${this.portalName} to the review screen. Verify every field and uploaded file, handle any MFA/fee, then click submit manually. AUTOMATION HAS STOPPED.`,
      { finalSubmitClicked: false },
    );
  }
  // After a final submit, scrape the COMPLETION page for the issued permit/record number
  // and the record link, so the operator's "relay continuation" click captures them
  // automatically. Read-only — never clicks anything. (Accela completion page shows
  // "Your application has been successfully submitted." + a record number like
  // 517-26-000274-STR and a record/summary link.)
  async captureSubmissionConfirmation(): Promise<PortalStepResult> {
    if (!this.page) return ok("No open page to capture confirmation from.", { permitNumber: "", recordLink: "" });
    try {
      await smartWait(this.page);
      const bodyText = String((await this.page.locator("body").innerText().catch(() => "")) || "");
      // Accela-style record number: 517-26-000274-STR (digits/dashes + optional type suffix).
      const accela = bodyText.match(/\b\d{2,4}-\d{2}-\d{4,7}-?[A-Z]{0,4}\b/);
      // Generic confirmation/record number fallback (avoid pure phone/zip).
      const generic = bodyText.match(/\b(?:record|permit|application|confirmation)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{5,})\b/i);
      const permitNumber = (accela?.[0] || generic?.[1] || "").trim();
      // Accela record suffix encodes the discipline: -STR (structural), -ELE (electrical), etc.
      const discipline = permitNumber.match(/-([A-Z]{2,4})$/)?.[1] ?? null;
      // Keep origin+path only — completion-page URLs can embed session-scoped query tokens
      // (capId/agency/auth tickets) that would persist session material in the stored run
      // result and won't work when clicked later anyway.
      const rawUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
      let recordLink = rawUrl;
      try { const u = new URL(rawUrl); recordLink = u.origin + u.pathname; } catch { /* keep raw */ }
      const submitted = /successfully submitted|application has been submitted|record (number|#)/i.test(bodyText);
      if (permitNumber || submitted) {
        return ok(`Captured submission confirmation${permitNumber ? `: ${permitNumber}` : ""}.`, {
          permitNumber,
          confirmationNumber: permitNumber,
          discipline,
          recordLink,
        });
      }
      return ok("Submitted; no record number found on the completion page yet.", { permitNumber: "", recordLink });
    } catch (err) {
      return ok(`Confirmation capture skipped: ${err instanceof Error ? err.message : String(err)}`, { permitNumber: "", recordLink: "" });
    }
  }

  // Read-only status scrape: navigate to the portal URL, search the page body for
  // any of the known application/permit numbers, and return a REDACTED status snippet.
  // NEVER clicks submit, modifies, or pays anything. PII (long digit runs such as
  // account/meter numbers) is masked and the text is capped to a short snippet.
  async checkStatus(applicationNumbers: string[]): Promise<string | null> {
    if (!this.page || !this.recipe.portalUrl || !applicationNumbers.length) return null;
    try {
      await this.page.goto(this.recipe.portalUrl);
      await this.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
      return scanStatusFromBody(this.page, applicationNumbers);
    } catch {
      return null;
    }
  }

  // Replay every recorded step IN ORDER (uploads inline). In guided-manual mode it stops
  // permanently at the first stopForReview marker so we never proceed to the final submit.
  // In autoSubmit mode it may proceed past the marker but only to perform explicitly
  // allowlisted (isFinalSubmit) steps — everything else past the marker is hard-blocked.
  private async runAll(): Promise<PortalStepResult> {
    if (!this.page) return fail("Recipe replay has no open page.");
    let executed = 0;
    const skipped: string[] = [];
    // Tracks whether we are past the review marker (autoSubmit-only territory).
    let pastReview = false;
    // Tracks whether the previous executed step entered data, so we can let the portal's
    // autosave commit before an advancing click (mirrors the auto-learn persist-settle).
    let prevWasInput = false;

    // PAGE-DRIFT PRECHECK before the first segment (see precheckPageDrift).
    {
      const driftFail = await this.precheckPageDrift(0);
      if (driftFail) return fail(driftFail, { executed, skipped, healedSteps: this.healedSteps, driftWarnings: this.driftWarnings });
    }
    // PER-STEP TRACE. A replay that "executed 60 and skipped 5" says nothing about WHERE it
    // was when each of those happened, and a skipped step is silent by design — so a run
    // can march through most of a recipe against the wrong pages and only surface at the
    // first step that throws. Recording the wizard page alongside each step is what turns
    // that into a readable story. Cheap: one heading read per step, no screenshots.
    const trace: Array<{ i: number; action: string; note: string; outcome: string; page: string; resolved?: string; shot?: string }> = [];
    // ONE non-blocking DOM read. Written first with Playwright locators and innerText
    // timeouts, this ran per step and waited out its budget on every page that had no
    // active-tab element — about 700ms x every step, which doubled the replay smoke.
    // A trace must never be able to slow down the thing it is tracing.
    const currentPageLabel = async (): Promise<string> => {
      if (typeof this.page?.evaluate !== "function") return "";
      return await this.page.evaluate(() => {
        const clean = (s: string | null | undefined) => (s || "").trim().replace(/\s+/g, " ").slice(0, 48);
        const active = document.querySelector('.nav-link.active, [aria-current="page"], [class*="active"]');
        const fromTab = clean(active && (active as HTMLElement).innerText);
        if (fromTab) return fromTab;
        const h = document.querySelector("h1, h2, legend");
        return clean(h && (h as HTMLElement).innerText);
      }).catch(() => "") as Promise<string>;
    };

    for (let stepIdx = 0; stepIdx < this.recipe.steps.length; stepIdx++) {
      const step = this.recipe.steps[stepIdx];
      // Guided-manual: stop at review. autoSubmit (trusted, approved): proceed past
      // the review marker to replay ONLY allowlisted final-submit steps.
      if (step.action === "stopForReview") {
        if (!this.options.autoSubmit) {
          // Gap-fill the LAST data section once more before review: it is not followed by an
          // advancing click, so any required field the recipe missed (selector drift / a newly
          // added field) would otherwise reach review blank. No-op when gap-fill is not enabled.
          await this.runGapFill(this.page);
          break;
        }
        pastReview = true;
        continue;
      }

      // PERSIST SETTLE before an advancing click. PowerClerk autosaves each page (~3s) and
      // only commits fields on blur; advancing too soon saves a BLANK draft. If the prior
      // steps filled fields, wait for the autosave to settle before this click.
      if (step.action === "click" && prevWasInput) {
        if (typeof this.page.waitForLoadState === "function") {
          await this.page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => null);
        }
        // Number.isFinite (not ||) so an explicit AUTOLEARN_SAVE_SETTLE_MS=0 disables the wait.
        const settleMs = Number(process.env.AUTOLEARN_SAVE_SETTLE_MS);
        await sleep(Number.isFinite(settleMs) ? settleMs : 3000);
        // Now that the recipe's fills have committed (blurred + autosaved), let the LLM gap-fill
        // any REQUIRED field the recipe didn't cover — from real project data only. Run it AFTER
        // the persist-settle so the LLM reads a stable page; the advancing click that follows is
        // the commit window for the gap-filled values. No-op when gap-fill is not enabled.
        await this.runGapFill(this.page);
        prevWasInput = false;
      }

      // CLEAR THE WAY BEFORE A CLICK. Replay had no modal handling at all, while the
      // learner dismisses modals at the top of every page — so the learner never met the
      // popover that the first live replay died on. PowerClerk raises a "What's new?"
      // announcement over its home page; it swallowed the click that opens a new
      // application, and the run failed on the NEXT step with a bare 30s click timeout
      // 2 steps into 99. Cheap: each pass exits immediately when nothing matches.
      if (step.action === "click" || step.action === "goto") {
        await dismissPageModals(this.page).catch(() => null);
      }

      let lastErr: unknown;
      // Context from the FIRST failure. The retry path RELOADS the page, and a portal that
      // reloads to its first wizard page (PowerClerk does) then shows a screenshot of the
      // start of the form for a step that failed two-thirds of the way in — evidence that
      // points at entirely the wrong problem. Capture before any reload can rewrite it.
      let failureContext = "";
      let succeeded = false;
      for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
        try {
          const done = await this.executeStep(step, pastReview);
          if (done) executed++;
          else skipped.push(step.note || step.action);
          trace.push({
            i: stepIdx, action: step.action, note: String(step.note ?? "").slice(0, 52),
            outcome: done ? "ok" : "SKIPPED", page: await currentPageLabel(),
            // A SKIPPED step is the silent failure mode, and "it didn't take" says nothing
            // about WHY. Recording what its selector actually landed on separates a control
            // that isn't there from one that is the WRONG control — the difference between
            // portal drift and a recorded id (pcInputBase34, ..._11513) that is really a
            // render-order counter pointing somewhere else on a fresh project. Only paid
            // for on the skip path.
            ...(done ? {} : {
              resolved: await this.describeResolved(step),
              // A skip is silent AND cheap to photograph — and "the control is hidden" does
              // not say whether the row it belongs to was ever rendered. Capped so a recipe
              // that skips widely cannot fill the disk.
              ...(skipped.length <= 3 ? { shot: await this.captureFailureContext(step, stepIdx) } : {}),
            }),
          });
          succeeded = true;
          break;
        } catch (err) {
          lastErr = err;
          if (!failureContext) failureContext = await this.captureFailureContext(step, stepIdx).catch(() => "");
          const isTimeout = err instanceof Error && /timeout|TimeoutError/i.test(err.message);
          if (!isTimeout || attempt >= RETRY_BACKOFF_MS.length) break;
          await sleep(RETRY_BACKOFF_MS[attempt]);
          // Reload on timeout retries to recover from stale page state.
          await this.page.reload({ waitUntil: "networkidle", timeout: 15000 }).catch(() => null);
          // A reload can bring the announcement/cookie banner straight back, and a timeout
          // is the signature of a covered target — clear both before spending the next
          // attempt. clearOverlays is the generic breaker for portals we have no selector
          // for; dismissModals handles the ones we do.
          await dismissPageModals(this.page).catch(() => null);
          await clearPageOverlays(this.page).catch(() => null);
        }
      }
      if (!succeeded && !step.isFinalSubmit && process.env.RECIPE_SELF_HEAL !== "off") {
        // PER-STEP SELF-HEAL (research-validated: targeted repair beats full
        // re-record). Re-extract the live page and re-anchor this step by its
        // recorded LABEL (semantic anchor) — portals churn ids/markup far more
        // often than wording. One healed retry; never for final-submit steps
        // (safety rule) and never invented: no confident label match → fail as
        // before. Heals are reported so the backend patches the recipe AND
        // drops auto-submit trust until a human re-verifies the next review.
        const healedSelector = await this.healSelectorForStep(step).catch(() => null);
        if (healedSelector) {
          try {
            const healedStep: RecipeStep = { ...step, selector: { ...healedSelector, fallbacks: [...(step.selector ? [step.selector] : []), ...(healedSelector.fallbacks ?? [])] } };
            const done = await this.executeStep(healedStep, pastReview);
            if (done) executed++;
            else skipped.push(step.note || step.action);
            this.healedSteps.push({ note: step.note || step.action, action: step.action, selector: healedSelector });
            succeeded = true;
          } catch { /* healed selector didn't take either — fail below as before */ }
        }
      }
      if (!succeeded) {
        if (step.optional) {
          skipped.push(`${step.note || step.action} (optional, skipped: ${lastErr instanceof Error ? lastErr.message : String(lastErr)})`);
          continue;
        }
        // CAPTURE THE PAGE BEFORE GIVING UP. Replay is the path that runs for every
        // project, on a live portal, and until now it recorded NOTHING when a step
        // failed — a run that died on step 2 of 99 left only "locator.click: Timeout",
        // which cannot distinguish a drifted selector from a portal that put up a
        // different page entirely. The screenshot plus the page's own url/title and its
        // visible buttons is usually enough to tell those apart at a glance.
        const context = failureContext || await this.captureFailureContext(step, stepIdx);
        trace.push({ i: stepIdx, action: step.action, note: String(step.note ?? "").slice(0, 52), outcome: "FAILED", page: await currentPageLabel() });
        return fail(`Recipe step failed (${step.action}${step.note ? ` — ${step.note}` : ""}): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}${context}`, { executed, skipped, healedSteps: this.healedSteps, driftWarnings: this.driftWarnings, failedStepIndex: stepIdx, trace });
      }
      // Remember whether this step entered data, so the next advancing click waits for the
      // portal's autosave to commit (prevents blank-draft saves on PowerClerk).
      if (["fill", "select", "check", "uncheck", "press"].includes(step.action)) prevWasInput = true;
      else if (step.action === "click" || step.action === "goto") {
        prevWasInput = false;
        // New page segment begins after an advance — precheck it before burning
        // per-step timeouts on a page the portal may have rebuilt.
        const driftFail = await this.precheckPageDrift(stepIdx + 1);
        if (driftFail) return fail(driftFail, { executed, skipped, healedSteps: this.healedSteps, driftWarnings: this.driftWarnings });
      }
    }

    if (this.finalSubmitClicked) {
      // The operator authorized the final submit — grab the permit number + record link
      // off the completion page so they're captured automatically.
      const capture = await this.captureSubmissionConfirmation();
      return ok(`Replayed ${executed} recorded step(s) and clicked the approved final submit.`, {
        executed, skipped, finalSubmitClicked: true,
        permitNumber: capture.data?.permitNumber || "",
        confirmationNumber: capture.data?.confirmationNumber || "",
        recordLink: capture.data?.recordLink || "",
        // What the LLM gap-fill added (and what it left blank for lack of real data) — same key
        // the hand-coded adapters surface, so the operator/UI sees a uniform report.
        gapFill: this.gapFillReport, healedSteps: this.healedSteps,
      });
    }
    return ok(`Replayed ${executed} recorded step(s); stopped at review.`, { executed, skipped, finalSubmitClicked: false, gapFill: this.gapFillReport, healedSteps: this.healedSteps, driftWarnings: this.driftWarnings });
  }

  private resolveValue(step: RecipeStep): string {
    if (step.field) return this.fieldValues[step.field] ?? "";
    return step.value ?? "";
  }

  /**
   * Does this control still look like it is WAITING for its options? True for a native
   * <select> holding nothing but a placeholder ("Select...", "Please select…"), and for a
   * non-select widget whose list we cannot read — those are the shapes a cascade produces
   * before its XHR lands. False for a populated list, which is the signal that a missing
   * value is genuinely missing rather than merely late.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async optionsLookUnloaded(loc: any): Promise<boolean> {
    if (!loc || typeof loc.evaluate !== "function") return true;
    return await loc.evaluate((el: Element) => {
      if ((el.tagName || "").toLowerCase() !== "select") return true; // custom widget — unreadable
      const real = Array.from((el as HTMLSelectElement).options).filter((o) => {
        const t = (o.textContent || "").trim().toLowerCase();
        return t && !/^(please\s+)?select\.{0,3}$/.test(t) && !/^--/.test(t);
      });
      return real.length === 0;
    }).catch(() => true) as boolean;
  }

  /**
   * When a step's selector lands on a control whose OWN label contradicts the one recorded,
   * re-anchor to the labelled control instead. Returns the replacement locator, or null to
   * keep what was resolved (which is the answer whenever there is no contradiction, no
   * recorded label to compare against, or no better candidate on the page).
   *
   * Deliberately conservative: a mismatch is declared only when the two labels share NO
   * meaningful word. Portal labels get truncated, re-punctuated and suffixed with "*", so
   * anything stricter would fire on formatting differences and re-anchor correct steps onto
   * worse ones — the exact mistake that broke a working replay earlier today.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async reanchorIfWrongControl(step: RecipeStep, scoped: any): Promise<any | "abort" | null> {
    const recorded = String(step.selector?.label || step.note || "").trim();
    if (!recorded || !scoped || typeof scoped.count !== "function") return null;
    // Nothing resolved at all is a different problem (a genuine miss); leave it alone.
    if (!(await scoped.count().catch(() => 0))) return null;

    // A locator without .first()/.evaluate is a fake/legacy page (the unit-test doubles, and
    // any adapter host that predates evaluate). There is nothing to contradict, so accept
    // what was resolved. Guarded with typeof, not optional chaining: `x.evaluate?.(...)`
    // still throws when `first()` itself is missing, and a synchronous throw here escapes
    // the .catch() entirely and fails the whole step.
    if (typeof scoped.first !== "function") return null;
    const el0 = scoped.first();
    if (!el0 || typeof el0.evaluate !== "function") return null;
    const actual = await el0.evaluate((el: Element) => {
      const id = el.getAttribute("id");
      const forLbl = id ? document.querySelector(`label[for="${id}"]`) : null;
      const wrap = el.closest("label");
      return ((forLbl as HTMLElement | null)?.innerText
        || (wrap as HTMLElement | null)?.innerText
        || el.getAttribute("aria-label") || "").trim();
    }).catch(() => "") as string;
    if (!actual) return null; // unlabelled control — nothing to contradict

    const words = (v: string) => new Set(
      v.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
        .filter((w) => w.length > 3 && !IDENTITY_STOPWORDS.has(w)),
    );
    const a = words(recorded);
    const b = words(actual);
    if (!a.size || !b.size) return null;
    for (const w of a) if (b.has(w)) return null; // they agree on something — accept it

    // They share nothing. Find the control the recipe actually meant — by scanning the
    // page's own label associations, the SAME mechanism that just detected the mismatch.
    // getByLabel was tried first and found nothing on the live portal even though the
    // control was demonstrably there with a `for` association, so this does not depend on
    // Playwright's accessible-name computation matching the recorded string exactly.
    const wanted = [...a];
    // NO NESTED FUNCTION DECLARATIONS IN HERE. esbuild's keepNames wraps any nameable
    // function as __name(fn, "..."), and __name does not exist in the page — the evaluate
    // then throws, the .catch swallows it, and this silently reports "no candidate found".
    // That is exactly what happened on the first live attempt: every re-anchor failed while
    // the control sat right there. The detection code above works because it declares
    // nothing. Keep it that way; the normalisation is inlined for the same reason.
    const foundId = await this.page.evaluate((args: { words: string[] }) => {
      const controls = Array.from(document.querySelectorAll("input, select, textarea")) as HTMLElement[];
      let bestId = "";
      let bestScore = 0;
      let bestWords = 0;
      for (const el of controls) {
        const id = el.getAttribute("id");
        if (!id) continue;
        const forLbl = document.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLElement | null;
        const wrap = el.closest("label") as HTMLElement | null;
        const src = forLbl || wrap;
        // textContent, NOT innerText: innerText is layout-dependent and returns "" for a
        // label that is not currently rendered, which silently drops the candidate.
        const raw = (src ? src.textContent : el.getAttribute("aria-label")) || "";
        const text = raw.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
        let score = 0;
        for (const w of args.words) if (text.indexOf(w) >= 0) score++;
        if (!score) continue;
        // Visibility is a TIE-BREAK, not a filter. A portal that keeps its real control
        // behind a styled widget (PowerClerk does) would otherwise have every candidate
        // discarded before scoring — and selectWithFallback drives a hidden native fine.
        const r = el.getBoundingClientRect();
        const visible = !!r && (r.width > 0 || r.height > 0);
        const rank = score * 2 + (visible ? 1 : 0);
        if (rank > bestScore) { bestScore = rank; bestId = id; bestWords = score; }
      }
      // Require a real overlap of MEANINGFUL WORDS, not one incidental hit. bestScore
      // carries the visibility tie-break, so gate on the word count itself.
      return bestWords >= (args.words.length < 2 ? 1 : 2) ? bestId : "";
    }, { words: wanted }).catch(() => "") as string;

    if (foundId) {
      this.driftWarnings.push(
        `step "${recorded.slice(0, 44)}" resolved onto "${actual.slice(0, 34)}" — re-anchored by label to #${foundId}`,
      );
      return this.page.locator(`#${CSS_ESCAPE(foundId)}`);
    }

    // No better candidate. ABORT the step — never act on a control we have just proven is
    // the wrong one. Filing the right answer into the wrong question is far worse than
    // leaving it blank for the human at review, and the warning says which it was.
    this.driftWarnings.push(
      `step "${recorded.slice(0, 44)}" resolved onto an UNRELATED control labelled "${actual.slice(0, 44)}" and the recorded field could not be found — SKIPPED rather than filled into the wrong control`,
    );
    return "abort";
  }

  // Returns true if the step performed an action, false if it was safely skipped.
  // `pastReview` is true only in autoSubmit mode AFTER the stopForReview marker.
  private async executeStep(step: RecipeStep, pastReview: boolean): Promise<boolean> {
    // `let`, not `const`: the upload branch may re-anchor to a different slot once the
    // page's real upload controls have been re-tagged (see the upload case below), and the
    // identity check below may re-anchor a step that resolved onto the wrong control.
    let scoped = await this.resolveLocator(step.selector);
    // IS THIS THE CONTROL WE RECORDED? Portal field ids are routinely per-form-instance
    // (PowerClerk's "AWQBPS8U00XGInput"), so on a NEW project the same id is a DIFFERENT
    // question. Measured live: a step recorded for "Description of Service:" resolved to
    // the "Will the System be Customer-Owned or Third-Party Owned" dropdown, and two later
    // steps both resolved onto one unrelated control. Skipping was the lucky outcome — the
    // value simply did not match that control's options. Had it matched, replay would have
    // filed the RIGHT ANSWER IN THE WRONG BOX on a live interconnection application, with
    // nothing reported. So confirm the control's own label still agrees with what was
    // recorded before touching it, and re-anchor by label when it does not.
    if (IDENTITY_CHECKED.has(step.action)) {
      const anchored = await this.reanchorIfWrongControl(step, scoped);
      if (anchored === "abort") return false;
      if (anchored) scoped = anchored;
    }
    switch (step.action) {
      case "goto":
        await this.page.goto(this.resolveValue(step));
        await smartWait(this.page);
        // A recorded goto lands on a fresh section that a Vue/SPA portal may still be mounting.
        // Wait until an interactive control is up so the next step's fill targets a bound input
        // (best-effort; never skips — the retry/reload loop still recovers a genuine miss).
        await waitForInteractiveControls(this.page);
        return true;
      case "click":
        return this.executeClick(step, scoped, pastReview);
      case "fill": {
        const v = this.resolveValue(step);
        if (!v) return false;
        await waitForElement(scoped);
        // MASKED CONTROLS (Accela phone / zip): they keep their validation state from KEY
        // events, so .fill() - which assigns .value and fires input+change - leaves the box
        // showing the right text while the portal still reports "Required Invalid". The
        // learner had to type these; replay must type them too or it re-creates exactly the
        // state the learn run fixed. Detected from the step's own note/selector.
        const maskedStep = /\b(phone|telephone|fax|zip|postal)\b/i.test(String(step.note ?? ""))
          || /phone|zip/i.test(String(step.selector?.css ?? ""));
        if (maskedStep) {
          if (typeof scoped!.focus === "function") await scoped!.focus().catch(() => null);
          await scoped!.fill("").catch(() => null);
          if (typeof scoped!.pressSequentially === "function") await scoped!.pressSequentially(v, { delay: 35 }).catch(() => null);
          else if (typeof scoped!.type === "function") await scoped!.type(v, { delay: 35 }).catch(() => null);
          else await scoped!.fill(v, { timeout: FILL_TIMEOUT_MS });
        } else {
          // BOUNDED. Replay does NOT go through the learner's applyFill, so the visibility
          // probe and bounded fill added there are not shared: a control that never becomes
          // actionable blocked Playwright's full 30s default here and then FAILED THE WHOLE
          // REPLAY. 8s is far beyond any real re-render while surfacing a genuine miss fast.
          await scoped!.fill(v, { timeout: FILL_TIMEOUT_MS });
        }
        // Blur to COMMIT the value into the portal's JS model (PowerClerk's Vue saves on
        // blur). Without it the field shows filled but never persists → blank draft.
        if (typeof scoped!.blur === "function") await scoped!.blur().catch(() => {});
        // A data-bound value can carry a unit suffix ("225A") that a decimal field (e.g.
        // PowerClerk "Amps") rejects with "Please enter a valid decimal number." Retry once
        // with a bare number so replayed recipes don't re-introduce the invalid value.
        if (await hasNumericValidationError(scoped)) {
          const bare = toBareNumber(v);
          if (bare && bare !== v) {
            await scoped!.fill(bare);
            if (typeof scoped!.blur === "function") await scoped!.blur().catch(() => {});
          }
        }
        return true;
      }
      case "select": {
        const v = this.resolveValue(step);
        if (!v) return false;
        await waitForElement(scoped);
        // Native <select> first; fall back to the custom-combobox interaction for styled
        // div dropdowns (PowerClerk "Please select...", select2, ExtJS) selectOption can't drive.
        let selected = await selectWithFallback(this.page, scoped, v);
        // A MANUFACTURER dropdown lists CEC certified names, not the plan set's wording.
        // Retry the certified aliases before giving up — the learner has always done this,
        // and without it a select lands nothing, returns false, and is SKIPPED silently.
        if (!selected && this.isManufacturerStep(step)) {
          for (const alt of equipmentMakeCandidates(v).slice(1)) {
            selected = await selectWithFallback(this.page, scoped, alt);
            if (selected) {
              this.driftWarnings.push(`manufacturer "${v}" matched the portal's certified name "${alt}"`);
              break;
            }
          }
        }
        // CASCADE. A model list is populated by an XHR fired when the manufacturer above it
        // changed (~600ms on PowerClerk, per CLAUDE.md), so the first attempt can run
        // against an option list that is still just "Please select...". The learner waits
        // for this; replay did not, so the model select landed nothing, returned false, and
        // was SKIPPED IN SILENCE — which on the live PGE run left the array with no module,
        // every capacity reading 0.00 kW, and the wizard branching down a different path
        // than the recipe recorded. Give the list time to arrive before believing the miss.
        // Retry ONLY while the option list looks unloaded. A select whose list is fully
        // populated and simply does not contain this value will never contain it, and each
        // retry costs several multi-second actionability timeouts — on a 99-step recipe
        // that is minutes of replay spent proving a known negative. The cascade signature
        // is an EMPTY or placeholder-only list, so gate on that.
        for (let attempt = 0; !selected && attempt < 3 && await this.optionsLookUnloaded(scoped); attempt++) {
          await sleep(800);
          selected = await selectWithFallback(this.page, scoped, v);
          if (selected) this.driftWarnings.push(`select "${String(step.note ?? step.field ?? "")}" needed ${(attempt + 1) * 800}ms for its control to appear (cascade)`);
        }
        // Wait for any Vue/React re-renders triggered by the dropdown change to settle
        // before filling subsequent fields (e.g. PowerClerk resets contact fields on
        // contact-type dropdown change).
        await this.page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => null);
        // Propagate the miss: a select that landed NOTHING must not report success.
        return selected;
      }
      case "check": {
        // A policy radio's recorded id carries a per-render counter — re-anchor by the
        // question's stable prefix and the recorded answer before waiting out a timeout on
        // an id that cannot exist on this project.
        const recovered = (await scoped?.count?.().catch(() => 0)) ? null : await this.recoverVolatileIdOption(step);
        const target = recovered ?? scoped;
        await waitForElement(target);
        await target!.check();
        // Same settle for checkbox changes that may trigger form re-renders.
        await this.page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => null);
        return true;
      }
      case "uncheck":
        await waitForElement(scoped);
        await scoped!.uncheck();
        return true;
      case "press":
        await waitForElement(scoped);
        await scoped!.press(step.value || "Enter");
        return true;
      case "waitFor":
        if (scoped) await scoped.waitFor({ state: "visible", timeout: 15000 });
        else await smartWait(this.page);
        return true;
      case "upload": {
        const filePath = step.docType ? this.docsByType[step.docType] : undefined;
        if (!filePath) return false;
        // Attach under a CLEAN filename: stored files carry a UUID prefix for on-disk
        // uniqueness that must not leak into what the portal reviewer sees.
        const file = (() => {
          const base = path.basename(filePath);
          const clean = base.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "");
          try {
            const ext = path.extname(clean).toLowerCase();
            const mimeType = ext === ".pdf" ? "application/pdf"
              : ext === ".png" ? "image/png"
              : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
              : ext === ".zip" ? "application/zip"
              : "application/octet-stream";
            return { name: clean || base, mimeType, buffer: fs.readFileSync(filePath) };
          } catch {
            return filePath; // unreadable — let Playwright read the path itself
          }
        })();
        // Custom Browse/Upload widgets tag their controls with data-al-upl at record time;
        // that attribute is gone on a fresh page, so re-tag before resolving the selector.
        //
        // But the tag is an INDEX ("f0", "f1") assigned in DOM order, and an upload step is
        // the only step type recorded with no fallbacks and no label to re-anchor on — so
        // "same DOM → same keys" is the whole safety argument, and it fails quietly in both
        // directions: one extra or conditional upload control shifts every key, and f0 then
        // attaches the one-line drawing to whatever now sits first. Wrong document, no
        // error. The recorded NOTE carries the control's own label ("upload sld: Please
        // upload your one-line drawing"), so prefer matching that against the labels the
        // re-tag reports, and fall back to the recorded index only when nothing matches.
        if (step.selector?.css?.includes("data-al-upl")) {
          const slots = await this.page.evaluate(tagUploadControls).catch(() => null) as Array<{ key: string; label: string }> | null;
          const wanted = String(step.note ?? "").split(":").slice(1).join(":").trim();
          if (slots?.length && wanted) {
            const norm = (v: string) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
            const want = norm(wanted);
            const hit = slots.find((sl) => norm(sl.label) === want)
              ?? slots.find((sl) => want.length > 6 && (norm(sl.label).includes(want) || want.includes(norm(sl.label))));
            if (hit && `[data-al-upl="${hit.key}"]` !== step.selector.css) {
              this.driftWarnings.push(`upload "${wanted.slice(0, 48)}" moved from ${step.selector.css} to slot ${hit.key} — re-anchored by label`);
              scoped = await this.locator({ css: `[data-al-upl="${hit.key}"]` });
            }
          }
        }
        if (step.viaFileChooser) {
          // The real <input> is created on click — intercept the file-chooser dialog.
          const [chooser] = await Promise.all([
            this.page.waitForEvent("filechooser", { timeout: 8000 }),
            scoped!.click({ timeout: 6000 }),
          ]);
          await chooser.setFiles(file);
          return true;
        }
        await scoped!.setInputFiles(file);
        return true;
      }
      default:
        return false;
    }
  }

  // Click safety gate (P0-3 allowlist + P0-4 structural challenge detection).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async executeClick(step: RecipeStep, scoped: any, pastReview: boolean): Promise<boolean> {
    // Include the step NOTE in the safety haystack: a human-patch click step may carry a
    // css-only selector (no name/text) while its note names the button ("human-patch:
    // Submit") — the regex gates below must see that label too.
    const name = `${step.selector?.name || step.selector?.text || ""} ${step.note || ""}`.trim();
    const flaggedFinal = isFinalSubmitStep(step);

    // 1) Fee payment is NEVER automated — always blocked, even if (wrongly) flagged.
    if (PAY_FEE.test(name)) return false;

    // 2) Anything past the review marker (autoSubmit territory) is hard-blocked unless
    //    it carries the explicit isFinalSubmit allowlist flag. This catches id/css-only
    //    submit buttons whose recorded name is empty (the P0-3 bypass).
    if (pastReview && !flaggedFinal) return false;

    // 3) Any step whose name/text matches submit keywords is hard-blocked UNLESS it is
    //    the explicitly flagged final submit. We never infer "submit button" from regex.
    if (SUBMIT_KEYWORDS.test(name) && !flaggedFinal) return false;

    // 4) The explicitly allowlisted final submit.
    if (flaggedFinal) {
      // Guided-manual: never click the final submit — a human always does.
      if (!this.options.autoSubmit) return false;
      // Trusted auto-submit: STRUCTURALLY detect a CAPTCHA/MFA challenge (iframe-based
      // included) on the final page and bail to a human if present. Never solve/bypass.
      const challenge = await detectChallengeFrame(this.page);
      if (challenge) {
        throw new Error(`Final submit needs a human: ${challenge}. Automation stopped without clicking.`);
      }
      await scoped!.click();
      // Let the portal settle, then verify we did not land back on a challenge or an
      // error page. "Unknown page state after the click" is treated as a STOP, not a
      // success — finalSubmitClicked stays false unless the portal cleanly accepted it.
      await smartWait(this.page, 3000);
      const postChallenge = await detectChallengeFrame(this.page);
      if (postChallenge) {
        throw new Error(`Final submit triggered a challenge after the click (${postChallenge}); pausing for human verification.`);
      }
      this.finalSubmitClicked = true;
      return true;
    }

    // 5) Ordinary navigation/UI click (pre-review). Safe to perform.
    await waitForElement(scoped);
    await scoped!.click();
    // A recorded Next/Continue advances a Vue wizard to a not-yet-bound section. Wait for an
    // interactive control to mount before the next fill so we never type onto an unmounted page
    // (best-effort; never skips — the retry/reload loop still recovers a genuine miss).
    await waitForInteractiveControls(this.page);
    return true;
  }

  // Resolve a selector to a present locator: try the primary, and if it matches
  // nothing, walk the recorded fallbacks in order and use the first that exists.
  // Returns the primary locator unchanged when there are no fallbacks (so the
  // action/wait still fails or times out naturally and the retry loop applies).
  // Prefer the first VISIBLE match of a locator that resolves to several elements.
  // A recorded css union can legitimately match a hidden ASP.NET twin of the real control
  // (Accela's contact dialog carries `hfIsForNewContactAddress` alongside the real
  // `txtAppStreetAdd1`). `.first()` then resolves to the hidden one and fill() waits out
  // its full 30s before FAILING THE WHOLE REPLAY — verified in real Chromium by
  // recipeReplay.dom.smoke.ts. Explicit nth stays exactly as recorded.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async preferVisible(loc: any, sel?: RecipeSelector): Promise<any> {
    if (!loc || typeof loc.count !== "function" || sel?.nth != null) return loc;
    const collapse = () => (typeof loc.first === "function" ? loc.first() : loc);
    try {
      const n = await loc.count();
      if (n <= 1) return collapse();
      for (let i = 0; i < Math.min(n, 12); i++) {
        const c = loc.nth(i);
        if (typeof c.isVisible !== "function") return collapse();
        if (await c.isVisible().catch(() => false)) return c;
      }
    } catch { /* fall through */ }
    // Nothing visible: keep the recorded behaviour so the failure is the familiar one.
    return collapse();
  }

  // Is this step selecting an equipment MANUFACTURER? Checked against the bound field name
  // first (authoritative) and the control's own label second — PowerClerk's spec-page
  // labels are bare "Manufacturer", which is exactly the wording to match.
  private isManufacturerStep(step: RecipeStep): boolean {
    const field = String(step.field ?? "");
    if (/(^|[a-z])(make|manufacturer)$/i.test(field)) return true;
    return /manufacturer|\bmake\b/i.test(`${step.selector?.label ?? ""} ${step.note ?? ""}`);
  }

  private async resolveLocator(sel?: RecipeSelector) {
    const primary = this.locator(sel);
    if (!sel || !sel.fallbacks?.length || !primary) return this.preferVisible(primary, sel);
    try {
      if (await primary.count() > 0) return this.preferVisible(primary, sel);
    } catch {
      // count() can throw on a malformed primary — fall through to fallbacks.
    }
    for (const fb of sel.fallbacks) {
      // Ignore a fallback's own nested fallbacks (one level deep).
      const loc = this.locator({ ...fb, fallbacks: undefined });
      if (!loc) continue;
      try {
        if (await loc.count() > 0) return this.preferVisible(loc, fb);
      } catch {
        // Try the next fallback.
      }
    }
    return primary;
  }

  /**
   * What a step's selector actually landed on, for the trace. Reports the element's id, its
   * own label, and (for a select) how many options it is offering — enough to tell "the
   * control is missing" from "the control is there but it is the wrong one" from "the
   * control is right but its option list has not loaded".
   */
  private async describeResolved(step: RecipeStep): Promise<string> {
    try {
      const loc = await this.resolveLocator(step.selector);
      const n = await loc?.count?.().catch(() => 0);
      if (!n) return "no element matched";
      return await loc.first().evaluate((el: Element) => {
        const id = el.getAttribute("id") || "";
        const tag = (el.tagName || "").toLowerCase();
        let label = "";
        if (id) label = (document.querySelector(`label[for="${id}"]`) as HTMLElement | null)?.innerText?.trim() ?? "";
        if (!label) label = (el.closest("label") as HTMLElement | null)?.innerText?.trim() ?? "";
        if (!label) label = el.getAttribute("aria-label") || "";
        const opts = tag === "select" ? (el as HTMLSelectElement).options.length : -1;
        const r = (el as HTMLElement).getBoundingClientRect?.();
        const vis = !!r && (r.width > 0 || r.height > 0);
        return `<${tag} id="${id}" label="${(label || "").replace(/\s+/g, " ").slice(0, 40)}"${opts >= 0 ? ` options=${opts}` : ""} visible=${vis}>`;
      }, undefined as never).catch(() => "element present but unreadable") as string;
    } catch { return "resolve failed"; }
  }

  private async recoverVolatileIdOption(step: RecipeStep) {
    const css = String(step.selector?.css ?? "");
    const m = /^#([A-Za-z0-9_-]+?)_\d+$/.exec(css);
    if (!m) return null;
    const answer = (/→\s*(.+?)\s*$/.exec(String(step.note ?? "")) ?? [])[1];
    if (!answer) return null;
    const prefix = m[1];
    try {
      const group = this.page.locator(`[id^="${prefix}_"]`);
      const n = await group.count();
      if (!n) return null;
      for (let i = 0; i < Math.min(n, 12); i++) {
        const opt = group.nth(i);
        const id = await opt.getAttribute("id").catch(() => null);
        if (!id) continue;
        const label = await this.page.locator(`label[for="${id}"]`).first().innerText({ timeout: 700 }).catch(() => "");
        if (String(label ?? "").trim().toLowerCase() === answer.trim().toLowerCase()) {
          this.driftWarnings.push(`policy option "${answer}" re-anchored from ${css} to #${id} (per-render id suffix)`);
          return opt;
        }
      }
    } catch { /* recovery is best-effort */ }
    return null;
  }

  // Build a Playwright locator from a portable selector descriptor.
  private locator(sel?: RecipeSelector) {
    if (!sel) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // frameSelectorFor understands both name/id keys and the "src:<pathname>" keys the
    // learner records for frames with no name/id (incl. cross-origin embeds).
    const scope: any = sel.frame ? this.page.frameLocator(frameSelectorFor(sel.frame)) : this.page;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let loc: any;
    if (sel.role && sel.name) loc = scope.getByRole(sel.role, { name: sel.name, exact: sel.exact });
    else if (sel.label) loc = scope.getByLabel(sel.label, { exact: sel.exact });
    else if (sel.placeholder) loc = scope.getByPlaceholder(sel.placeholder, { exact: sel.exact });
    else if (sel.testId) loc = scope.getByTestId(sel.testId);
    else if (sel.text) loc = scope.getByText(sel.text, { exact: sel.exact });
    else if (sel.css) loc = scope.locator(sel.css);
    else if (sel.role) loc = scope.getByRole(sel.role);
    else throw new Error("Recipe step has no usable selector.");
    // An explicit nth is honoured exactly. Otherwise return the UNCOLLAPSED locator so
    // resolveLocator can prefer the first VISIBLE match — collapsing with .first() here
    // hid the choice: a css union that also matches a hidden ASP.NET twin resolved to the
    // hidden element and fill() waited out 30s before failing the whole replay.
    return typeof sel.nth === "number" ? loc.nth(sel.nth) : loc;
  }

  /** Labels the recipe expects on the page segment starting at fromIndex (steps
   *  until the next advancing click/goto/stopForReview). Fill/select steps only;
   *  frame-scoped and optional steps are excluded (main-frame extraction can't
   *  see into iframes; optional fields legitimately vanish). */
  private expectedLabelsForSegment(fromIndex: number): string[] {
    const labels: string[] = [];
    for (let i = fromIndex; i < this.recipe.steps.length; i++) {
      const st = this.recipe.steps[i];
      if (st.action === "click" || st.action === "goto" || st.action === "stopForReview") break;
      if (st.action !== "fill" && st.action !== "select") continue;
      if (st.optional || st.selector?.frame) continue;
      const label = (st.note || st.selector?.label || st.selector?.name || st.selector?.placeholder || "")
        .replace(/^human-patch:\s*/i, "")
        .replace(/\s*—\s*SENSITIVE.*$/i, "")
        .trim();
      if (label.length >= 3) labels.push(label);
    }
    return labels;
  }

  /** PAGE-DRIFT PRECHECK. Compares the segment's recorded labels against the live
   *  page: zero overlap on a data-heavy segment (>=3 labels) → fail fast with a
   *  "Recipe step failed (page drift)" message — the literal "Recipe step failed"
   *  prefix is load-bearing: repository.ts's staleness handler matches
   *  /recipe step failed/i to mark the recipe needs_rerecord (comment there too).
   *  Partial overlap → annotate driftWarnings and continue (self-heal may still
   *  save the run). Sparse segments (dashboards, logins, upload-only pages) and
   *  any precheck error → silent pass. Never runs past stopForReview (segment
   *  walk stops there). */
  private async precheckPageDrift(fromIndex: number): Promise<string | null> {
    try {
      if (!this.page || typeof this.page.$$eval !== "function") return null;
      const expected = this.expectedLabelsForSegment(fromIndex);
      if (expected.length < 3) return null;
      const raws = (await this.page.$$eval(EXTRACT_SEL, extractFieldsInPage)) as Array<{ label?: string }>;
      const live = raws.map((r) => (r.label || "").trim().toLowerCase()).filter(Boolean);
      const matches = (want: string): boolean => {
        const w = want.toLowerCase();
        return live.some((l) => l === w || (Math.min(l.length, w.length) >= 5 && (l.includes(w) || w.includes(l))));
      };
      const hit = expected.filter(matches).length;
      const overlap = hit / expected.length;
      if (overlap >= 0.34) return null;
      // BELOW THIS, WE ARE NOT ON THE RECORDED PAGE — stop rather than warn.
      //
      // Stopping used to require ZERO matches, so a couple of incidental hits ("Name",
      // "Email" appear on half a wizard's pages) suppressed it. Measured live: a replay
      // found 2 of 26 recorded fields, warned, and carried on for forty more steps — every
      // one of them resolving onto whatever control happened to sit at the recorded id on
      // a page the recipe was not looking at. That is how a wizard desync turns into wrong
      // data rather than a clean failure.
      //
      // The desync itself is upstream: a step that does not fill leaves a required field
      // blank, the portal then refuses the "Next", and the recipe marches on believing it
      // advanced. Detecting it HERE is what converts that into a stop plus a re-learn (the
      // "recipe step failed" wording is what repository.ts matches to queue one).
      if (overlap < 0.15) {
        return `Recipe step failed (page drift): only ${hit} of ${expected.length} recorded fields for this section (${expected.slice(0, 3).map((e) => `"${e}"`).join(", ")}…) are on the current page — the replay is not on the page the recipe expects, most likely because an earlier required field was left blank and the portal refused to advance. Stopping rather than filling the wrong controls.`;
      }
      this.driftWarnings.push(
        `Page drift: only ${hit}/${expected.length} recorded fields found for this section (${expected.slice(0, 4).join(", ")}…) — the portal may have changed; verify the review screen closely.`,
      );
      return null;
    } catch {
      return null; // precheck must never break a replay
    }
  }

  /** Find the CURRENT page element matching a failed step's recorded label/name.
   *  Deterministic semantic anchor — no LLM cost; returns null without a
   *  confident, action-compatible match, and never "heals" onto the selector
   *  that just failed. */
  /**
   * What the page actually looked like when a step gave up: a screenshot on disk plus the
   * url, title and the visible clickable text. Appended to the failure message so a live
   * replay is diagnosable from its result alone — before this, a run that died on step 2
   * of 99 reported only "locator.click: Timeout", which cannot tell a drifted selector
   * from a portal that showed a different page entirely. Best-effort and never throws: a
   * capture problem must not replace the real failure.
   */
  private async captureFailureContext(step: RecipeStep, stepIdx: number): Promise<string> {
    if (!this.page) return "";
    const parts: string[] = [];
    try {
      const url = typeof this.page.url === "function" ? String(this.page.url()) : "";
      const title = typeof this.page.title === "function" ? String((await this.page.title().catch(() => "")) ?? "") : "";
      if (url) parts.push(`url=${url.slice(0, 160)}`);
      if (title) parts.push(`title=${JSON.stringify(title.slice(0, 80))}`);
    } catch { /* best-effort */ }
    try {
      // The portal's own affordances. When a recorded "Next" is gone, what IS on the page
      // is the single most useful thing to see.
      const names = await this.page.$$eval(
        "button, a[href], [role=button], input[type=submit], input[type=button]",
        (els: Element[]) => els
          .filter((el) => {
            const r = (el as HTMLElement).getBoundingClientRect?.();
            return !!r && r.width > 0 && r.height > 0;
          })
          .map((el) => ((el as HTMLElement).innerText || el.getAttribute("value") || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " "))
          .filter((t) => t.length > 0 && t.length < 60)
          .slice(0, 14),
      ).catch(() => [] as string[]);
      if (names.length) parts.push(`visible controls: ${names.map((n: string) => JSON.stringify(n)).join(", ")}`);
    } catch { /* best-effort */ }
    try {
      if (typeof this.page.screenshot === "function") {
        const dir = process.env.PORTAL_SCREENSHOT_DIR || path.join(process.cwd(), "data", "screenshots");
        await fs.promises.mkdir(dir, { recursive: true });
        const file = path.join(dir, `replay-fail-step${String(stepIdx).padStart(3, "0")}-${Date.now()}.png`);
        await this.page.screenshot({ path: file, fullPage: true });
        parts.push(`screenshot:${file}`);
      }
    } catch { /* best-effort */ }
    void step;
    return parts.length ? ` [${parts.join(" | ")}]` : "";
  }

  private async healSelectorForStep(step: RecipeStep): Promise<RecipeSelector | null> {
    if (!this.page || typeof this.page.$$eval !== "function") return null;
    const wanted = (step.note || step.selector?.label || step.selector?.name || "").trim().toLowerCase();
    if (wanted.length < 3) return null;
    let raws: unknown[] = [];
    try { raws = await this.page.$$eval(EXTRACT_SEL, extractFieldsInPage); } catch { return null; }
    const compat = (t: string): boolean =>
      step.action === "select" ? t === "select"
      : step.action === "check" || step.action === "uncheck" ? t === "checkbox" || t === "radio"
      : step.action === "click" ? t === "button"
      : t === "text" || t === "other" || t === "select";
    let best: { sel: RecipeSelector; score: number } | null = null;
    for (const raw of raws as Parameters<typeof toExtractedField>[0][]) {
      const f = toExtractedField(raw);
      if (!compat(f.fieldType)) continue;
      const label = (f.label || "").trim().toLowerCase();
      if (!label) continue;
      const contains = label.includes(wanted) || wanted.includes(label);
      const base = label === wanted ? 100 : contains && Math.min(label.length, wanted.length) >= 5 ? 70 : 0;
      // Fingerprint is a TIE-BREAK bonus only (max 58 < the 70 label gate):
      // two bare "Manufacturer" fields both score 70/100 on label — the one whose
      // recorded attributes (name/placeholder/id/aria/section) match wins. A
      // fingerprint can never substitute for the label anchor (never invented).
      if (base < 70) continue;
      const score = base + fingerprintBoost(f.fingerprint, step.fingerprint);
      if (!best || score > best.score) best = { sel: f.selector, score };
    }
    if (best && JSON.stringify(best.sel) === JSON.stringify(step.selector)) return null;
    return best?.sel ?? null;
  }
}


/** Tie-break bonus for replay self-heal: how well a live element's recorded-style
 *  attributes match the step's captured fingerprint. Pure + exported for tests.
 *  Max 58 — deliberately below the 70-point label gate so attributes alone can
 *  never manufacture a heal target. */
export function fingerprintBoost(
  live: { id?: string; name?: string; placeholder?: string; ariaLabel?: string; section?: string } | undefined,
  recorded: { id?: string; name?: string; placeholder?: string; ariaLabel?: string; section?: string } | undefined,
): number {
  if (!live || !recorded) return 0;
  const eq = (a?: string, b?: string): boolean => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  let boost = 0;
  if (eq(live.name, recorded.name)) boost += 15;
  if (eq(live.placeholder, recorded.placeholder)) boost += 15;
  if (eq(live.id, recorded.id)) boost += 10;
  if (eq(live.ariaLabel, recorded.ariaLabel)) boost += 10;
  // Sections are headings that get reworded — substring both ways, min 4 chars.
  const ls = (live.section || "").trim().toLowerCase();
  const rs = (recorded.section || "").trim().toLowerCase();
  if (ls && rs && Math.min(ls.length, rs.length) >= 4 && (ls.includes(rs) || rs.includes(ls))) boost += 8;
  return boost;
}
