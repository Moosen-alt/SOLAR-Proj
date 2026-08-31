import fs from "fs";
import path from "path";
import type { PortalRecipe, ProjectRecord, RecipeSelector, RecipeStep } from "../../../shared/src/types";
import { BasePortalAdapter, HUMAN_REVIEW_MESSAGE, ok, fail, type PortalContext, type PortalStepResult } from "../adapter";
import { openPortal } from "../browser";
import { selectWithFallback } from "../comboboxFill";

// How long the drift precheck waits for an async-rendered form to paint before concluding
// the replay is on the wrong page. PowerClerk's Ameren form reports zero inputs for several
// seconds after its URL loads; judging it on the first DOM read failed whole runs.
const DRIFT_SETTLE_MS = Math.max(2000, Number(process.env.RECIPE_DRIFT_SETTLE_MS ?? 15000));
import { detectChallengeFrame, frameSelectorFor, hasNumericValidationError, scanStatusFromBody, RETRY_BACKOFF_MS, sleep, smartWait, toBareNumber, waitForElement, waitForInteractiveControls } from "../safeAction";
import { performLogin } from "./loginFlow";
import { EXTRACT_SEL, extractFieldsInPage, toExtractedField, dismissPageModals, clearPageOverlays, equipmentMakeCandidates, pageFingerprintOf, collectValidationErrorsFrom, acaApplyEntryFrom } from "./autoLearnAdapter";
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

// How long to let a same-URL SPA wizard render its next section before deciding the portal
// refused the advance. Four short waits rather than one long one, so the common case (the
// page moved immediately) costs a single fingerprint read.
const ADVANCE_SETTLE_TRIES = 4;
// How many times to re-look at a model dropdown whose options are still cascading in.
const MODEL_CASCADE_TRIES = 4;
// How many unknown pass-through pages to click past before giving up. Bounded on purpose:
// "click Continue until something matches" is how automation ends up deep in a wizard it
// does not understand.
const DRIFT_SEEK_PAGES = 3;
const ADVANCE_SETTLE_MS = 600;

// Actions whose target control is identified by a LABEL and therefore worth verifying
// before we touch it. Navigation (goto/click) and uploads are excluded: a button's text is
// already its selector, and an upload's real input is routinely unlabelled and hidden.
// Escape an id for a css selector on the NODE side (CSS.escape is browser-only).
const CSS_ESCAPE = (v: string): string => v.replace(/([^a-zA-Z0-9_-])/g, "\$1");
const IDENTITY_CHECKED = new Set(["fill", "select", "check", "uncheck"]);
/** Steps that write project data. A missing control for one of these can legitimately mean
 *  "this portal did not ask that for this project" — unlike a missing button, which means
 *  the flow itself has drifted. */
const DATA_ACTIONS = new Set(["fill", "select", "check", "uncheck"]);
// Words too common in portal labels to prove two labels mean the same question.
const IDENTITY_STOPWORDS = new Set([
  "this", "that", "your", "will", "with", "from", "please", "select", "there", "have",
  "does", "the", "and", "for", "are", "you", "system", "site", "number", "name", "type",
  "information", "address", "would", "like", "used", "using", "enter", "provide",
  // Requirement MARKERS carry no identity: ACA labels its attachment-type select
  // "*Type (Required):" — with "type" rightly stopped, "required" was the only token
  // left, and a correctly-resolved select was refused as unrelated. A label that is all
  // markers has nothing to contradict.
  "required", "optional",
]);

export class RecipeAdapter extends BasePortalAdapter {
  portalName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private page: any = null;
  /** Steps repaired mid-replay by label re-anchoring (reported to the backend,
   *  which patches the recipe and requires human re-verification). */
  private healedSteps: Array<{ note: string; action: string; selector: RecipeSelector }> = [];
  /** Why the last self-heal attempt produced nothing. Empty when it healed or was never
   *  tried. Surfaced in the failure context so "the selector drifted" and "the control is
   *  present but unclickable" stop looking identical from the outside. */
  private healDiagnostic = "";
  /** Which of the project's arrays the array block is currently filling (1-based). */
  /** Required controls this run left empty, by page. The learner has always reported its
   *  required-field misses; replay reported nothing, so an application could reach the
   *  reviewer with a REQUIRED upload blank and no one the wiser — live PacifiCorp asks for
   *  "a photo of the meter where the system will be interconnected", which is never in a
   *  plan set, so no recipe step exists for it and no QC rule looks for it. */
  private requiredStillEmpty: string[] = [];
  /** Where this run's page screenshots go, and how many were written. Replay only ever
   *  photographed FAILURES, so every page that filled "successfully" was invisible — and
   *  the two worst bugs of this session (the homeowner's details written into the
   *  installer's block; a required meter-photo upload left blank) were both caught by a
   *  human looking at the portal, not by anything the run reported. */
  private pageShotDir = "";
  private pageShotCount = 0;
  private arrayPass = 1;
  /** Bounds of the recorded array block — the span of steps bound to array1*. -1 when the
   *  recipe has none. */
  private arrayBlockStart = -1;
  private arrayBlockEnd = -1;
  /** The post-pass held-check runs exactly once, after the last array pass. */
  private arrayVerifyDone = false;
  /** Select-step fields that reported SUCCESS this run — the held-check's candidates.
   *  A field that never landed (ambiguous model left blank for the human) is not
   *  "lost to a re-render" and must not be repaired or reported as such. */
  private landedSelectFields = new Set<string>();
  /** Policy-default steps whose control was absent when their turn came — re-tried once
   *  just before the page's advance, when a conditional section has had every chance to
   *  render. Cleared on each advance. */
  private pendingPolicyRetries: RecipeStep[] = [];
  private inPolicyRetry = false;
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
    // Did the steps that just ran WRITE to the page we are standing on? Distinct from
    // prevWasInput, which the persist-settle block clears before the advance guard reads it.
    // Without this, the "extra page" guard below cannot tell a genuinely-skippable duplicate
    // advance from the page it has this instant finished filling.
    let wroteToThisPage = false;

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

    // WHERE THE TIME GOES. Two live PowerClerk replays spent ~1300s on ~25 steps and were
    // cut off mid-run by the portal's own session timeout (PGE landed on
    // /MvcAccount/InvalidSession). "Learn slow, replay fast" is the product's whole
    // economics, so a replay that cannot finish inside a portal session is a correctness
    // problem, not a comfort one — and averages hide it. Record the steps that actually
    // cost seconds so the next fix targets the right one.
    // THE RECORDED ARRAY BLOCK. A learn records one array's worth of steps because that is
    // what the portal renders on a fresh application — but real projects routinely have
    // several roof planes. Measured: Bren Trask has FOUR arrays (10+3+5+6 = 24 modules) and
    // the recipe learned on him types "10"; Randal Rowland has two (18+5 = 23) and gets 18.
    // A 10.32 kW system was being filed as roughly 4.4 kW.
    const arrayBound = this.recipe.steps
      .map((s2, i) => ({ s2, i }))
      .filter(({ s2 }) => /^array1[A-Z]/.test(String(s2.field ?? "")));
    this.arrayBlockStart = arrayBound.length ? arrayBound[0].i : -1;
    this.arrayBlockEnd = arrayBound.length ? arrayBound[arrayBound.length - 1].i : -1;
    const slowSteps: Array<{ i: number; action: string; note: string; ms: number }> = [];
    // Timed from the TOP of the next iteration rather than the bottom of this one: the loop
    // body has a dozen `continue` paths (skips, policy defaults, drift), and a bottom-of-loop
    // timer would silently miss exactly the steps most likely to be slow.
    let prevStart = 0;
    let prevStep: { i: number; action: string; note: string } | null = null;
    const closePrevStepTiming = (): void => {
      if (!prevStep) return;
      const ms = Date.now() - prevStart;
      if (ms >= 4000) slowSteps.push({ ...prevStep, ms });
    };
    for (let stepIdx = 0; stepIdx < this.recipe.steps.length; stepIdx++) {
      const recordedStep = this.recipe.steps[stepIdx];
      const inArrayBlock = this.arrayBlockStart >= 0
        && stepIdx >= this.arrayBlockStart && stepIdx <= this.arrayBlockEnd;
      // ON A REPEAT PASS, ONLY THE PER-ARRAY STEPS RUN AGAIN. The block's bounds are
      // "first array1* step .. last array1* step", which sweeps in whatever the learner
      // recorded between them — on PacifiCorp that is the battery section and a duplicate
      // inverter Manufacturer/Model pair. Re-running those nth-shifted lands them on OTHER
      // sections' controls: measured live, the pass-2 "inverter Manufacturer" landed on
      // array 1's module manufacturer (their labels are identically "Manufacturer", so no
      // re-anchor guard can see it), whose cascade then offered inverter models to the
      // module-model step — "landed nothing though 58 option(s) were showing". They
      // already ran on pass 1; nothing per-array is lost by not repeating them.
      if (this.arrayPass > 1 && inArrayBlock && !this.isPerArrayStep(recordedStep)) continue;
      // ON A REPEAT PASS, TARGET THE Nth RENDERED COPY OF EACH CONTROL.
      //
      // The recorded selector points at the FIRST array's control, because that is the only
      // one that existed while learning. Replaying the block unscoped would refill array 1
      // with array 2's numbers — the same silent overwrite as the Preparer/Customer bug,
      // with the same absence of any error. Each added row renders its own copy of the
      // block's controls, so the Nth match IS array N. When the recorded selector is a
      // row-unique id there is no Nth match, the step finds nothing and skips — which
      // leaves array 1 intact rather than corrupting it.
      const step = (this.arrayPass > 1 && inArrayBlock && recordedStep?.selector)
        ? this.arrayPassStep(recordedStep)
        : recordedStep;
      closePrevStepTiming();
      prevStart = Date.now();
      prevStep = { i: stepIdx, action: String(step?.action ?? ""), note: String(step?.note ?? "").slice(0, 52) };
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

      // DO NOT ADVANCE PAST A PAGE YOU STILL NEED TO FILL.
      //
      // One portal, many jurisdictions, DIFFERENT PAGE COUNTS. Oregon ePermitting lets each
      // participating city configure its own Building application, so a recipe learned in
      // one city can carry an advance the next city does not need. Measured live: the Coos
      // Bay recipe has TWO consecutive "advance: Continue Application" steps, and replaying
      // it in Hood River the second one skipped clean over the page holding Job Value,
      // Category of Construction and Project Name — the run then stopped reporting 0 of 4
      // fields, from inside the wizard, two pages past where it should have been.
      //
      // So before an advancing click, look at what the NEXT segment expects: if those fields
      // are on the page right now, this advance is one the recipe brought from another
      // jurisdiction. Skip it and let the fills happen. Deliberately conservative — it needs
      // a real overlap of the next segment's labels, not a single incidental match.
      if (step.action === "click" && /^advance\b/i.test(String(step.note ?? ""))) {
        const upcoming = this.expectedLabelsForSegment(stepIdx + 1);
        // NEVER skip an advance off a page we just filled. Label overlap alone cannot tell
        // two DIFFERENT sections apart when a portal reuses one contact block — PowerClerk's
        // "Preparer Information" and "Customer Information" pages carry byte-identical
        // labels (Name, Last, Address, City, State, Zip, Email, Phone), so this guard saw
        // the customer segment "already on the page", skipped the Next, and the homeowner
        // steps overwrote the installer's details. Measured live: Charles Bitton of TML
        // INTERNATIONAL replaced by the homeowner Randal Rowland, with the homeowner's
        // site address, in the PREPARER block of a real interconnection application.
        // Recorded steps carry section="" so there is no heading to disambiguate with —
        // but "we just wrote to this page" is decisive on its own and needs no recording.
        if (upcoming.length >= 3 && !wroteToThisPage && await this.segmentIsOnThisPage(upcoming)) {
          this.driftWarnings.push(`skipped an advance this jurisdiction does not need — the next section's fields (${upcoming.slice(0, 3).join(", ")}…) are already on this page`);
          continue;
        }
      }

      // CLEAR THE WAY BEFORE A CLICK. Replay had no modal handling at all, while the
      // learner dismisses modals at the top of every page — so the learner never met the
      // popover that the first live replay died on. PowerClerk raises a "What's new?"
      // announcement over its home page; it swallowed the click that opens a new
      // application, and the run failed on the NEXT step with a bare 30s click timeout
      // 2 steps into 99. Cheap: each pass exits immediately when nothing matches.
      // dismissPageModals CLICKS a dismissal ("Got it"). PowerClerk's "What's new?"
      // popover is a SEQUENCE of those, anchored on the very toolbar button we are
      // about to click — so clicking through it is unreliable and it stays up,
      // intercepting the click anyway. clearPageOverlays REMOVES it (it already
      // knows .new-feature-popper by name), but replay only reached that on the
      // retry and advance-guard paths, never before the first click. A live run
      // died at step 1 behind exactly that popover, announcing the homepage
      // redesign that moved the button underneath it.
      if (step.action === "click" || step.action === "goto") {
        await dismissPageModals(this.page).catch(() => null);
        await clearPageOverlays(this.page).catch(() => null);
      }

      // WHAT DID WE LEAVE BLANK? Swept just before an ADVANCING click, which is the moment
      // this page is as filled as the recipe will ever make it. Restricted to advancing
      // clicks so in-page actions ("add new contact") do not report fields that are about
      // to be filled. A portal can require something no recipe step covers and no QC rule
      // looks for — PacifiCorp wants a photo of the meter, which is never in a plan set —
      // and until now that reached the reviewer as a silently empty box.
      if (step.action === "click" && /^advance\b/i.test(String(step.note ?? ""))) {
        // A CONDITIONAL POLICY QUESTION CAN RENDER LATE. PGE's "disconnect within 10
        // feet" appears only once the computed system size warrants it — potentially
        // AFTER the recorded step's turn, which then skipped it as "not asked". This is
        // the last moment on the page: give each skipped policy question one more look.
        if (this.pendingPolicyRetries.length) {
          const retries = this.pendingPolicyRetries.splice(0);
          this.inPolicyRetry = true;
          try {
            for (const ps of retries) {
              const done = await this.executeStep(ps, pastReview).catch(() => false);
              if (done) this.driftWarnings.push(`policy question appeared after the page settled — answered on the way out: ${String(ps.note ?? "").slice(0, 60)}`);
            }
          } finally { this.inPolicyRetry = false; }
        }
        for (const label of await this.emptyRequiredControls()) {
          if (!this.requiredStillEmpty.includes(label)) this.requiredStillEmpty.push(label);
        }
        // PHOTOGRAPH THE FINISHED PAGE. Same moment as the sweep above: everything the
        // recipe will put on this page is on it, and the next click leaves it for good.
        await this.capturePageShot(await currentPageLabel());
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
          // The held-check distinguishes LANDED-THEN-LOST from NEVER-LANDED: only a
          // select that reported success is a candidate for "a re-render took it back".
          if (done && step.action === "select" && recordedStep?.field) this.landedSelectFields.add(String(recordedStep.field));
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
          // A RELOAD CANNOT CONJURE A CONTROL THE PAGE DOES NOT HAVE — and on PowerClerk it
          // costs more than time: the reload returns the wizard to its FIRST page, throwing
          // away where we are. Portals ask conditional questions ("Who will install this
          // generation system?") that simply are not rendered for every project, and the
          // recipe carries the shape of the project it was learned on.
          //
          // Measured: one such step burned 301 SECONDS of a 340-second run — three
          // sleep/reload/settle cycles proving a control absent that a single DOM read
          // settles. Only short-circuit on an explicit false; null means the page could not
          // be read, which is not evidence the control is missing.
          if (DATA_ACTIONS.has(step.action)) {
            const want = String(step.note || step.selector?.label || step.selector?.name || "").trim();
            if (want.length >= 3 && (await this.labelPresentOnPage(want)) === false) {
              this.driftWarnings.push(`"${want.slice(0, 44)}" is not on this page — stopped retrying rather than reloading (a reload sends PowerClerk back to page 1)`);
              break;
            }
          }
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
      // ACA ADDRESS-ROW SELECTION: PICK THE ROW WHOSE ADDRESS MATCHES THIS PROJECT.
      //
      // This is the one thing standing between one Accela recipe and every city on the
      // instance. Oregon ePermitting is a single statewide portal and the jurisdiction comes
      // from the address search, so the rest of the flow generalises — but the recorded row
      // selector does not:
      //     tr:has-text("CITY APPLICATIONS") a:has-text("Select")
      // "CITY APPLICATIONS" is how COOS BAY labels its row. Another city labels it its own
      // way, the selector misses, and the recorded fallback is a bare "Select" link that
      // takes whichever row comes first — potentially the county's offering instead of the
      // city's, or another parcel entirely.
      //
      // The search returns one row per matching ADDRESS, so match the address: the project's
      // street number plus street name, compared with directionals and street types
      // normalised, because a portal writes "SE" where a plan set writes "Southeast" (and
      // "St"/"Street", "Ave"/"Avenue"). Exact-normalised first, and only a UNIQUE match is
      // clicked — several candidate rows means a human should choose, not us.
      if (!succeeded && /work location:.*address row/i.test(String(step.note ?? ""))) {
        const num = String(this.fieldValues.streetNumber ?? "").trim();
        const street = String(this.fieldValues.street ?? "").trim();
        if (num && street) {
          // ACA returns ONE ROW PER JURISDICTION for the same address — city and county
          // both serve it. Which one is right is the discipline: a structural permit files
          // with the CITY, an electrical one with the COUNTY, and the recorded note says
          // which ("select city/structural address row"). Without that tiebreak the address
          // match is ambiguous on essentially every search.
          const wantCounty = /county|electrical/i.test(String(step.note ?? "")) && !/city/i.test(String(step.note ?? ""));
          const picked = await this.pickAddressRow(num, street, wantCounty ? "county" : "city");
          // AN EMPTY SEARCH IS A CONCLUSION, NOT A RETRY. Oregon ePermitting participation is
          // VOLUNTARY: a jurisdiction that has not joined never appears in this search at all.
          // So an address the statewide portal cannot find almost always means the AHJ runs
          // its OWN permit portal — and re-learning ePermitting will never fix that. Say so
          // plainly, and deliberately WITHOUT the "recipe step failed" prefix, so the backend
          // does not flag this recipe stale and queue a pointless re-learn of a portal that
          // is working correctly.
          if (!picked && !(await this.addressSearchHadResults())) {
            throw new Error(
              `ADDRESS NOT IN OREGON EPERMITTING: the statewide portal returned no results for ${num} ${street}. `
              + `Participation is voluntary, so this almost certainly means ${this.recipe.ahj || "this jurisdiction"} runs its own permit portal. `
              + `Find and record that portal for this AHJ rather than re-recording this recipe.`,
            );
          }
          if (picked) {
            this.driftWarnings.push(`address row chosen by matching "${picked.slice(0, 52)}" (the recorded row label belongs to the city this recipe was learned on)`);
            executed++;
            succeeded = true;
          }
        }
      }
      // ACA APPLY-FLOW RE-ENTRY. Accela Citizen Access serves one portal to many
      // jurisdictions and picks the jurisdiction from the ADDRESS SEARCH inside the Apply
      // wizard, so getting INTO the wizard is the only thing standing between one city and
      // the next. The learner starts from the public entry page that lists the applications;
      // replay reuses the persistent AUTHENTICATED profile and lands on Dashboard.aspx,
      // whose nav is Apply / Building / Licensing / Planning — the recorded application link
      // is not on that page at all. Two live runs, one stale recipe and one freshly learned,
      // failed identically here, which is what ruled out portal drift.
      //
      // The learner already re-enters the wizard by URL when it drifts out of it; do the
      // same rather than hunting for a link that is on a different page.
      if (!succeeded && /^navigate to application/i.test(String(step.note ?? ""))) {
        const here = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
        const entry = acaApplyEntryFrom(here);
        if (entry) {
          const went = await this.page.goto(entry, { waitUntil: "domcontentloaded", timeout: 30000 })
            .then(() => true).catch(() => false);
          if (went) {
            await waitForInteractiveControls(this.page);
            this.driftWarnings.push(`recorded application link was not on ${here.split("/").pop()} — re-entered the Apply flow directly`);
            executed++;
            succeeded = true;
          }
        }
      }
      if (!succeeded && !step.isFinalSubmit && this.arrayPass === 1 && process.env.RECIPE_SELF_HEAL !== "off") {
        // arrayPass === 1: heal re-anchors BY LABEL against the whole page with no row
        // concept, and a repeat-pass step's labels are bare copies ("Manufacturer") of
        // controls in OTHER sections — a heal here would write array N's value into the
        // inverter's dropdown and then PATCH THE RECIPE with that selector. A repeat pass
        // that misses simply skips; the post-pass held-check reports what stayed empty.
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
        closePrevStepTiming();
        return fail(`Recipe step failed (${step.action}${step.note ? ` — ${step.note}` : ""}): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}${context}`, { executed, skipped, healedSteps: this.healedSteps, driftWarnings: this.driftWarnings, failedStepIndex: stepIdx, trace, slowSteps, requiredStillEmpty: this.requiredStillEmpty, pageShotDir: this.pageShotDir });
      }
      // Remember whether this step entered data, so the next advancing click waits for the
      // portal's autosave to commit (prevents blank-draft saves on PowerClerk).
      if (["fill", "select", "check", "uncheck", "press"].includes(step.action)) { prevWasInput = true; wroteToThisPage = true; }
      else if (step.action === "click" || step.action === "goto") {
        prevWasInput = false;
        wroteToThisPage = false;
        // New page segment begins after an advance — precheck it before burning
        // per-step timeouts on a page the portal may have rebuilt.
        let driftFail = await this.precheckPageDrift(stepIdx + 1);
        // AN EXTRA PAGE THIS JURISDICTION HAS AND THE RECIPE DOES NOT.
        //
        // The mirror of the skip above: one portal, many jurisdictions, different page
        // counts — so a city can also have a page the recipe never saw. Measured live,
        // replaying Coos Bay's recipe in Hood River: the run stopped on
        // "Step 1: General Info > Licensed Professional", a page listing the CCB and
        // electrician already attached to the account, with nothing to fill and a
        // "Continue Application" button. The recipe had no step for it because Coos Bay's
        // application does not include it.
        //
        // So before failing on drift, try clicking through — but ONLY when the page has
        // nothing to fill. A page with an empty required field is a page that needs DATA,
        // and clicking past it would file an incomplete application; that still fails, which
        // is the whole point of the drift stop. Bounded, because "click Continue until
        // something matches" is how automation ends up deep in a wizard it does not
        // understand.
        if (driftFail) {
          let sought = 0;
          while (sought < DRIFT_SEEK_PAGES && await this.pageIsPassThrough()) {
            const cont = this.page.getByRole("link", { name: /continue application/i }).first();
            const has = await cont.count().catch(() => 0);
            if (!has) break;
            await cont.click({ timeout: 8000 }).catch(() => null);
            await waitForInteractiveControls(this.page);
            sought++;
            if (!(await this.precheckPageDrift(stepIdx + 1))) {
              this.driftWarnings.push(`clicked through ${sought} page(s) this jurisdiction has that the recipe does not (nothing to fill on them)`);
              driftFail = null;
              break;
            }
          }
        }
        if (driftFail) {
          // A drift stop is the one failure with NO screenshot, because it does not come
          // from a step throwing — and it is precisely when "what page am I actually on?"
          // is the whole question. Capture it like any other failure.
          const driftContext = await this.captureFailureContext(step, stepIdx);
          closePrevStepTiming();
          return fail(`${driftFail}${driftContext}`, { executed, skipped, healedSteps: this.healedSteps, driftWarnings: this.driftWarnings, failedStepIndex: stepIdx, trace, slowSteps, requiredStillEmpty: this.requiredStillEmpty, pageShotDir: this.pageShotDir });
        }
      }

      // REPEAT THE ARRAY BLOCK, ONCE PER ROOF PLANE.
      //
      // Only after the portal CONFIRMS a new row exists. A silently-failed add would leave
      // the second array's values landing on the first array's controls — the identical
      // failure to the Preparer/Customer overwrite, and just as invisible. When no row can
      // be added we say so loudly and file array 1, which is no worse than before.
      if (stepIdx === this.arrayBlockEnd && this.arrayBlockStart >= 0) {
        const want = this.projectArrayCount();
        if (this.arrayPass < want) {
          if (await this.addAnotherArrayRow()) {
            this.arrayPass++;
            this.driftWarnings.push(`added array row ${this.arrayPass} of ${want} and refilled the recorded array block for it`);
            stepIdx = this.arrayBlockStart - 1; // the loop's ++ lands us back on the block
            continue;
          }
          this.driftWarnings.push(
            `project has ${want} arrays but no array row could be added — filed array 1 only `
            + `(${this.fieldValues.array1ModuleQuantity ?? "?"} of ${this.fieldValues.totalModuleQuantity ?? "?"} modules). REVIEW BEFORE SUBMIT.`,
          );
          this.arrayPass = want; // do not retry the add on every later pass
        }
        // DID THE FILLS ACTUALLY HOLD? Adding a row makes PowerClerk re-render the whole
        // spec section from SERVER state, and a select that was never committed (blur) is
        // rendered back to its placeholder — measured live: array 1's module manufacturer
        // reverted to "Please select..." after the row-add, and nothing noticed because
        // every write had individually reported success. The learner has verified its
        // equipment fills persist since the beginning (equipment_fill_not_held); replay
        // now does the same for the array rows it owns: read each row back, re-run the
        // recorded per-array steps for any row left on a placeholder, and say so loudly
        // when even the repair does not hold.
        if (this.arrayPass >= this.projectArrayCount() && !this.arrayVerifyDone) {
          this.arrayVerifyDone = true;
          await this.verifyAndRepairArrayRows();
          await this.verifyEquipmentSelectsHeld();
        }
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
        gapFill: this.gapFillReport, healedSteps: this.healedSteps, slowSteps, requiredStillEmpty: this.requiredStillEmpty, pageShotDir: this.pageShotDir,
      });
    }
    closePrevStepTiming();
    return ok(`Replayed ${executed} recorded step(s); stopped at review.`, { executed, skipped, finalSubmitClicked: false, gapFill: this.gapFillReport, healedSteps: this.healedSteps, driftWarnings: this.driftWarnings, slowSteps, requiredStillEmpty: this.requiredStillEmpty, pageShotDir: this.pageShotDir });
  }

  private resolveValue(step: RecipeStep): string {
    if (step.field) {
      // PREFER THE PORTAL'S OWN STRING for equipment models. The backend resolves
      // "<field>Certified" from the CEC list — the same list the portal builds its dropdown
      // from — so "DS3-L" arrives as "DS3-L {240V}" and "Q.TRON BLK M-G2.C1+/AC" as the
      // wattage-correct one of six. Resolved server-side because a portal renders a native
      // <select> on one page and a combobox <input> on another, and a combobox exposes no
      // <option> elements for a page-side matcher to read. Falls through to the plan-set
      // value whenever the CEC list is unsynced or the choice was ambiguous.
      if (/model$/i.test(step.field)) {
        const certified = this.fieldValues[`${step.field}Certified`];
        if (certified) return certified;
      }
      // ON A REPEAT PASS, array1Tilt means array2Tilt. The recipe only ever records ONE
      // array block (the learner fills the block the portal renders), so replaying it for
      // a second roof plane is a matter of reading the second array's values into the
      // same recorded steps.
      if (this.arrayPass > 1 && /^array1[A-Z]/.test(step.field)) {
        const mapped = step.field.replace(/^array1/, `array${this.arrayPass}`);
        return this.fieldValues[mapped] ?? "";
      }
      return this.fieldValues[step.field] ?? "";
    }
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
  /** Signature of a NATIVE select's option list. Compared between polls to tell a list
   *  that is still being replaced by the cascade from one that has settled. */
  private async optionListSignature(loc: any): Promise<string> {
    if (!loc || typeof loc.evaluate !== "function") return "";
    return await loc.evaluate((el: Element) => {
      if ((el.tagName || "").toLowerCase() !== "select") return "";
      const o = Array.from((el as HTMLSelectElement).options).map((x) => (x.textContent || "").trim());
      return o.length + "|" + o.slice(0, 40).join("~");
    }).catch(() => "") as string;
  }

  /** How many arrays the PROJECT has, from the resolved values (array1..N ModuleQuantity). */
  private projectArrayCount(): number {
    let n = 0;
    for (let i = 1; i <= 12; i++) {
      if (String(this.fieldValues[`array${i}ModuleQuantity`] ?? "").trim()) n = i;
      else break;
    }
    return n || 1;
  }

  /** How many array rows the PAGE is showing. Each rendered PV Array carries its own
   *  "Delete Array" control, which makes counting them a reliable proxy — and gives the
   *  add below something to verify against rather than trusting a click. */
  private async countArrayRows(): Promise<number> {
    if (!this.page || typeof this.page.evaluate !== "function") return 0;
    return await this.page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("a, button, span, div")) as HTMLElement[];
      return els.filter((el) => {
        const t = (el.innerText || "").trim();
        // Portal-agnostic repeater vocabulary, but "array" stays required: it is the
        // domain's own word for a roof plane (the field family is array1*), while a bare
        // "Remove"/"Delete Row" would count unrelated repeaters (contacts, attachments).
        if (!/^(delete|remove)\s+(pv\s+)?array$/i.test(t)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }).length;
    }).catch(() => 0) as number;
  }

  /** Add one PV Array row, and return whether the page actually gained one. */
  private async addAnotherArrayRow(): Promise<boolean> {
    if (!this.page || typeof this.page.getByRole !== "function") return false;
    const before = await this.countArrayRows();
    const candidates = [
      // Portal-agnostic adder wording, "array" required for the same reason the row
      // marker requires it — a bare "Add Row" could belong to any repeater on the page.
      () => this.page.getByRole("button", { name: /add\s*(another\s*)?(pv\s*)?array/i }),
      () => this.page.getByRole("link", { name: /add\s*(another\s*)?(pv\s*)?array/i }),
      // PowerClerk labels the array-level duplicate simply "Clone". EXACT, because
      // "Clone System" beside it duplicates the WHOLE generating system.
      () => this.page.getByRole("button", { name: "Clone", exact: true }),
      () => this.page.getByRole("link", { name: "Clone", exact: true }),
    ];
    for (const make of candidates) {
      try {
        const loc = make();
        if (!(await loc.count().catch(() => 0))) continue;
        await loc.first().click({ timeout: 8000 });
        await sleep(1200);
        await this.page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => null);
        if (await this.countArrayRows() > before) return true;
      } catch { /* try the next shape */ }
    }
    return false;
  }

  /** A step that must run once per rendered array row: the array1* numbers plus the
   *  module make/model selects the row owns. Everything else the learner happened to
   *  record between the block's bounds (battery, disconnect, duplicate inverter steps)
   *  belongs to OTHER sections and runs on pass 1 only. */
  private isPerArrayStep(step: RecipeStep | undefined): boolean {
    const f = String(step?.field ?? "");
    return /^array1[A-Z]/.test(f) || f === "moduleMake" || f === "moduleModel";
  }

  /**
   * The recorded step re-targeted at array row `pass`. The recorded selector (and each of
   * its fallbacks) ranked Nth among the page-wide matches AT LEARN TIME — one array row on
   * a fresh application — so row `pass` is that recorded rank plus one per added row.
   * Shifting only the top level was measured live to do nothing at all: the primary is a
   * volatile learn-time id (zero matches at any nth), and the label fallbacks kept their
   * recorded rank — so every pass-2 write landed back on array 1 and array 2 stayed empty.
   */
  private arrayPassStep(recordedStep: RecipeStep, pass = this.arrayPass): RecipeStep {
    const shift = pass - 1;
    // A row-1 re-run (shift 0) keeps the selector EXACTLY as recorded: forcing nth:0 onto
    // a selector that had none would bypass preferVisible and could land a hidden twin.
    if (shift === 0) return recordedStep;
    const sel = recordedStep.selector ?? {};
    return {
      ...recordedStep,
      selector: {
        ...sel,
        nth: (typeof sel.nth === "number" ? sel.nth : 0) + shift,
        fallbacks: sel.fallbacks?.map((fb) => ({
          ...fb,
          nth: (typeof fb.nth === "number" ? fb.nth : 0) + shift,
        })),
      },
      note: `${recordedStep.note ?? ""} [array ${pass}]`,
    };
  }

  /** Every rendered array row's controls, read back by label: value, and whether a select
   *  is still sitting on its placeholder. Rows are found the same way countArrayRows finds
   *  them — each rendered PV Array owns a "Delete Array" control. */
  private async readArrayRowsBack(): Promise<Array<Array<{ label: string; tag: string; value: string; placeholder: boolean }>>> {
    if (!this.page || typeof this.page.evaluate !== "function") return [];
    return await this.page.evaluate(() => {
      const visible = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const markers = (Array.from(document.querySelectorAll("a, button, span, div")) as HTMLElement[])
        .filter((el) => /^(delete|remove)\s+(pv\s+)?array$/i.test((el.innerText || "").trim()) && visible(el));
      // Innermost only: a wrapper around the real control repeats its innerText.
      const inner = markers.filter((el) => !markers.some((o) => o !== el && el.contains(o)));
      const rows: Array<Array<{ label: string; tag: string; value: string; placeholder: boolean }>> = [];
      // Section-level controls bound the climb: with ONE rendered row, "contains exactly
      // one marker" is true of every ancestor up to the page, and the "row" would balloon
      // to the whole section — reading the INVERTER's Manufacturer for the module step.
      // Generic adder/section vocabulary: "Add …" and Calculate-style controls live
      // OUTSIDE any row on every repeater layout seen so far; a wider net here only
      // stops the climb EARLIER, which is the safe direction.
      const sectionCtl = (Array.from(document.querySelectorAll("a, button")) as HTMLElement[])
        .filter((el) => /^add\s|clone\s*system|^(re)?calculate$/i.test((el.innerText || "").trim()) && visible(el));
      for (const marker of inner) {
        // The row container: the largest ancestor still containing exactly this one marker
        // and none of the section-level controls that live OUTSIDE any row.
        let row: HTMLElement = marker;
        let up: HTMLElement | null = marker.parentElement;
        while (up && up !== document.body
          && inner.filter((m) => up!.contains(m)).length === 1
          && !sectionCtl.some((c) => up!.contains(c))) {
          row = up;
          up = up.parentElement;
        }
        const controls = (Array.from(row.querySelectorAll("input, select, textarea")) as HTMLElement[])
          .filter((el) => visible(el) && (el.getAttribute("type") || "").toLowerCase() !== "hidden");
        rows.push(controls.map((el) => {
          const id = el.getAttribute("id") || "";
          let label = id ? ((document.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLElement | null)?.innerText ?? "") : "";
          if (!label) label = (el.closest("label") as HTMLElement | null)?.innerText ?? "";
          if (!label) label = el.getAttribute("aria-label") || "";
          const tag = (el.tagName || "").toLowerCase();
          let value = "";
          let placeholder = false;
          if (tag === "select") {
            const s = el as HTMLSelectElement;
            value = (s.options[s.selectedIndex]?.textContent || "").trim();
            placeholder = !value || /^(please\s+)?select\.{0,3}$/i.test(value) || /^--/.test(value);
          } else {
            value = (el as HTMLInputElement).value ?? "";
            // A custom COMBOBOX renders as an input whose "value" is its placeholder
            // text — PowerClerk's equipment make/model are exactly this shape, and
            // treating "Please select..." as a filled value made this sweep blind to
            // the very widgets it was written for.
            placeholder = /^(please\s+)?select\.{0,3}$/i.test(value.trim());
          }
          return { label: label.replace(/\s+/g, " ").trim(), tag, value, placeholder };
        }));
      }
      return rows;
    }).catch(() => []) as Array<Array<{ label: string; tag: string; value: string; placeholder: boolean }>>;
  }

  /** The label a recorded step would resolve by — its selector's, or the first fallback's. */
  private stepLabel(step: RecipeStep): string {
    const sel = step.selector;
    return String(sel?.label ?? sel?.fallbacks?.find((f) => f.label)?.label ?? "").trim();
  }

  /**
   * Post-pass held-check over the array rows. For each rendered row, every recorded
   * per-array step whose value resolves non-empty must have left its control non-empty —
   * a select on its placeholder or a blank number means the write did not survive
   * (PowerClerk re-renders the section from server state on a row-add, and an uncommitted
   * value is simply gone). One repair round re-runs that row's recorded steps through the
   * normal execution path (same matching, aliases, cascade waits); what still does not
   * hold is reported in driftWarnings AND requiredStillEmpty so the operator sees it in
   * the same list as every other blank.
   */
  private async verifyAndRepairArrayRows(): Promise<void> {
    if (this.arrayBlockStart < 0) return;
    const perArraySteps = this.recipe.steps
      .slice(this.arrayBlockStart, this.arrayBlockEnd + 1)
      .filter((s) => this.isPerArrayStep(s));
    if (!perArraySteps.length) return;
    const savedPass = this.arrayPass;
    try {
      const seen = (await this.readArrayRowsBack()).length;
      const want = Math.min(this.projectArrayCount(), Math.max(1, seen));
      // FAIL LOUD, NOT OPEN. A held-check that could not see the rows must not read as
      // "verified and held" — that is the exact false confidence this sweep removes.
      if (seen < this.projectArrayCount()) {
        this.driftWarnings.push(
          `held-check could read only ${seen} of ${this.projectArrayCount()} array row(s) — verify the arrays by eye before submit`,
        );
      }
      const brokenRows = async (): Promise<number[]> => {
        const rows = await this.readArrayRowsBack();
        const out: number[] = [];
        for (let i = 1; i <= Math.min(want, rows.length); i++) {
          const row = rows[i - 1];
          for (const s of perArraySteps) {
            this.arrayPass = i; // resolveValue maps array1* -> array{i}*
            const expected = this.resolveValue(this.arrayPassStep(s, i));
            if (!expected) continue;
            const lbl = this.stepLabel(s).toLowerCase();
            if (!lbl) continue;
            const ctl = row.find((c) => {
              const own = c.label.toLowerCase();
              return own && (own.includes(lbl) || lbl.includes(own));
            });
            if (!ctl) continue; // no such control in this row — nothing to verify against
            const empty = ctl.placeholder || (ctl.tag !== "select" && !String(ctl.value ?? "").trim());
            if (empty) { out.push(i); break; }
            // A NUMBER CAN BE PRESENT AND WRONG. The live incident filed array 2's
            // qty/tilt into array 1 — non-empty, so an emptiness check blesses it. Fill
            // values are the project's own numbers (no certified-name aliasing), so they
            // must match; selects stay emptiness-only because the landed option is
            // legitimately the portal's spelling of the value.
            if (s.action === "fill" && ctl.tag !== "select") {
              const got = String(ctl.value ?? "").trim();
              const numEq = got !== "" && expected !== ""
                && Number.isFinite(Number(got)) && Number.isFinite(Number(expected))
                && Number(got) === Number(expected);
              if (got !== expected.trim() && !numEq) { out.push(i); break; }
            }
          }
        }
        return out;
      };
      const broken = await brokenRows();
      if (!broken.length) return;
      for (const i of broken) {
        this.arrayPass = i;
        this.driftWarnings.push(`array row ${i} lost fills to a re-render — re-running its recorded steps`);
        for (const s of perArraySteps) {
          await this.executeStep(this.arrayPassStep(s, i), false).catch(() => false);
        }
      }
      const still = await brokenRows();
      for (const i of still) {
        const msg = `array row ${i}: fills did not hold even after repair — REVIEW BEFORE SUBMIT`;
        this.driftWarnings.push(msg);
        if (!this.requiredStillEmpty.includes(msg)) this.requiredStillEmpty.push(msg);
      }
    } finally {
      this.arrayPass = savedPass;
    }
  }

  /**
   * The NON-row equipment selects get the same held-check as the array rows. Measured
   * live: the inverter Manufacturer (filled at its recorded step, BEFORE the array
   * passes) sat uncommitted in the DOM, Add Array's server re-render wiped it, and the
   * committed draft held "Please select..." — while every write had reported success.
   * Pre-fix it was rescued BY ACCIDENT: a duplicate recorded step re-ran after the add;
   * the foreign-step skip removed the accident, so this is the intentional replacement.
   *
   * Resolution is by the step's LABEL fallback only — the recorded css primary is a
   * volatile per-render id ("#pcInputBase54") whose counter depends on how many controls
   * rendered before it, so mid-run it can point at an arbitrary same-page control.
   */
  private async verifyEquipmentSelectsHeld(): Promise<void> {
    const fields = ["inverterMake", "inverterModel"];
    const steps: RecipeStep[] = [];
    for (const f of fields) {
      // The LAST recorded step for the field that carries a usable label — dup steps
      // (a learner rescan) record the same control twice; any labeled one will do.
      const s = [...this.recipe.steps].reverse().find((x) =>
        x.field === f && (x.action === "select" || x.action === "fill") && this.stepLabel(x));
      if (s) steps.push(s);
    }
    if (!steps.length) return;
    const labelOnly = (s: RecipeStep): RecipeStep => {
      const sel = s.selector ?? {};
      const fb = sel.label ? sel : sel.fallbacks?.find((f2) => f2.label);
      return { ...s, selector: { label: fb?.label ?? this.stepLabel(s), nth: fb?.nth, exact: fb?.exact } };
    };
    const displayed = async (s: RecipeStep): Promise<string | null> => {
      const loc = await this.resolveLocator(labelOnly(s).selector).catch(() => null);
      if (!loc || !(await loc.count?.().catch(() => 0))) return null;
      return await loc.first().evaluate((el: Element) => {
        const tag = (el.tagName || "").toLowerCase();
        if (tag === "select") {
          const sl = el as HTMLSelectElement;
          return (sl.options[sl.selectedIndex]?.textContent || "").trim();
        }
        return ((el as HTMLInputElement).value ?? "").trim();
      }).catch(() => null) as string | null;
    };
    const empty = (v: string | null) => v !== null && (!v || /^(please\s+)?select\.{0,3}$/i.test(v) || /^--/.test(v));
    let repairedMake = false;
    let makeCommitted = false;
    for (const s of steps) {
      if (!this.resolveValue(s)) continue; // nothing to hold
      // Never-landed steps stay out — EXCEPT a model whose make is COMMITTED: the cascade
      // parent exists, so its list is real and one fresh attempt is warranted. This used
      // to require the make to have been JUST REPAIRED — but the blur-commit fix means
      // the make now survives the row-add, the repair never fires, and the model lost
      // its accidental rescue: a production replay shipped "Altenergy Power System" with
      // its Model still on "Please select...". The ambiguous-model guard still applies
      // inside the step, so a genuinely unlistable model stays blank for the human.
      const cascadeUnblocked = (repairedMake || makeCommitted) && this.isModelStep(s);
      if (!this.landedSelectFields.has(String(s.field)) && !cascadeUnblocked) continue;
      const before = await displayed(s);
      if (!empty(before)) {
        if (this.isManufacturerStep(s)) makeCommitted = true;
        continue;
      }
      this.driftWarnings.push(cascadeUnblocked && !this.landedSelectFields.has(String(s.field))
        ? `equipment select "${this.stepLabel(s)}" (${s.field}) — its make is set, retrying the cascade child`
        : `equipment select "${this.stepLabel(s)}" (${s.field}) lost its fill to a re-render — re-running it`);
      const hadLanded = this.landedSelectFields.has(String(s.field));
      await this.executeStep(labelOnly(s), false).catch(() => false);
      const after = await displayed(s);
      if (empty(after)) {
        // Say what actually happened: a landed pick that vanished is "did not hold";
        // a pick that never landed (the ambiguity guard keeps refusing it) was LEFT
        // BLANK deliberately — both belong in the blanks list, under honest names.
        const msg = hadLanded
          ? `${this.stepLabel(s)} (${s.field}): fill did not hold even after repair — REVIEW BEFORE SUBMIT`
          : `${this.stepLabel(s)} (${s.field}): no safe match — left blank for review`;
        this.driftWarnings.push(msg);
        if (!this.requiredStillEmpty.includes(msg)) this.requiredStillEmpty.push(msg);
      } else if (this.isManufacturerStep(s)) {
        repairedMake = true;
      }
    }
  }

  /** What option rows are on screen right now, for diagnosing a select that landed
   *  nothing: zero means the widget never opened; a populated list means the value simply
   *  is not offered (or is spelled differently). */
  private async visibleOptionSample(): Promise<{ count: number; sample: string[] }> {
    if (!this.page || typeof this.page.evaluate !== "function") return { count: 0, sample: [] };
    return await this.page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(
        '[role=option], .dropdown-item, .v-list-item, li[class*="option"], li[class*="item"], select option',
      )) as HTMLElement[];
      const texts = rows
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return (r.width > 0 && r.height > 0) || (el.tagName || "").toLowerCase() === "option";
        })
        .map((el) => (el.innerText || el.textContent || "").trim())
        .filter(Boolean);
      return { count: texts.length, sample: texts.slice(0, 6) };
    }).catch(() => ({ count: 0, sample: [] as string[] })) as { count: number; sample: string[] };
  }

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
    // HYPHENS SPLIT WHAT PEOPLE READ AS ONE WORD. "E-mail:" tokenizes to {mail} while the
    // recorded note says "email" — zero overlap, and a correctly-resolved control got
    // SKIPPED as unrelated (measured live: ACA's contact popup email). Compare against the
    // compacted form too, both directions, before calling two labels strangers.
    const compact = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
    const aCompact = compact(recorded);
    const bCompact = compact(actual);
    for (const w of a) if (bCompact.includes(w)) return null;
    for (const w of b) if (aCompact.includes(w)) return null;

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
        // Compacted twin for hyphenated labels: "E-mail:" must count as a hit for "email".
        const textCompact = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
        let score = 0;
        for (const w of args.words) if (text.indexOf(w) >= 0 || textCompact.indexOf(w) >= 0) score++;
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
        // MODEL FIRST — before the generic select. selectWithFallback matches "exact, then
        // contains either direction", and contains-matching picks whatever option comes
        // first in the DOM: asked for "DS3-L" it selects "DS3-LV {120V}", a different
        // inverter, and reports SUCCESS. Silently filing the wrong equipment on a live
        // interconnection application is far worse than the skip this started as, so the
        // model rules have to run before that fallback ever sees the value.
        let selected = false;
        // The page-side model rules can only read a NATIVE <select>. PowerClerk renders a
        // Vue combobox <input> on its spec pages, which exposes no <option> elements — and
        // treating "cannot read this control" as "no match" made the guard refuse every
        // combobox model, blocking the very values the CEC lookup had just resolved
        // correctly. For a non-select, hand straight to selectWithFallback's combobox path;
        // the value it receives is already the portal's own certified string, so the
        // wrong-neighbour risk that motivated these rules is largely gone.
        let isNativeSelect = await this.isNativeSelect(scoped);
        if (this.isModelStep(step) && isNativeSelect) {
          // The model list is populated by an XHR fired when the manufacturer above it
          // changed (~600ms on PowerClerk), so "no match" and "not loaded yet" look
          // identical on the first look. Retry only while the list is still unloaded —
          // a populated list that lacks the value will never gain it, and each extra
          // attempt costs multi-second timeouts on a path that has to stay fast.
          let picked = "";
          // "Populated" is NOT "ready". The cascade REPLACES the list, so between the
          // manufacturer change and the XHR landing the control still holds the PREVIOUS
          // manufacturer's models — plenty of options, none of them ours. Photographed live
          // on PGE: the Model popup listing SF160-24-M155, SF160-24-M160 ... while the
          // manufacturer beside it read "Hanwha Q CELLS (Qidong)". The old gate broke out
          // the moment the list was non-empty, so it matched against the wrong list.
          // Wait while the list is empty OR still changing; stop once it has settled.
          let prevSig = await this.optionListSignature(scoped);
          for (let attempt = 0; attempt <= MODEL_CASCADE_TRIES; attempt++) {
            picked = await this.bestModelOption(scoped, v, step);
            if (picked) break;
            const sig = await this.optionListSignature(scoped);
            const stillChanging = sig !== prevSig;
            prevSig = sig;
            // TWO quiet polls before calling a list settled, not one. With a single
            // window, "the cascade has not fired yet" and "the cascade is done" are the
            // same observation — the list is unchanged either way — and the wait ends
            // exactly when the stale list is still showing.
            if (!(await this.optionsLookUnloaded(scoped)) && !stillChanging && attempt >= 2) break;
            await sleep(ADVANCE_SETTLE_MS);
          }
          if (picked) {
            selected = await selectWithFallback(this.page, scoped, picked);
            if (selected && picked !== v) this.driftWarnings.push(`model "${v}" matched the portal's listing "${picked}"`);
          } else {
            // No safe match on a list that IS loaded. Leave it blank for the human rather
            // than let the generic contains-match choose a neighbouring model for us —
            // asked for "DS3-L" it would take "DS3-LV {120V}" and report success.
            this.driftWarnings.push(`model "${v}" has no unambiguous match in this dropdown — left blank for review`);
            await this.page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => null);
            return false;
          }
        }
        if (!selected) selected = await selectWithFallback(this.page, scoped, v);
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
        // A VOLATILE PRIMARY CAN RESOLVE TO THE WRONG CONTROL MID-RUN. The recorded css id
        // ("#pcInputBase55") carries a per-render counter: on a fresh load it does not
        // exist (fallbacks fire, all is well), but mid-run — after eight pages have
        // rendered controls — the SAME id can exist on an arbitrary control, and every
        // match attempt above then runs against the wrong element. Before giving up,
        // re-resolve by the LABEL fallback alone and try once more. Bare labels repeat
        // ("Model" is on every equipment row), so the fallback keeps its recorded nth.
        if (!selected && step.selector?.css) {
          const fbl = step.selector.fallbacks?.find((f2) => f2.label);
          if (fbl) {
            const relox = await this.resolveLocator({ ...fbl, fallbacks: undefined }).catch(() => null);
            if (relox && (await relox.count?.().catch(() => 0)) > 0) {
              const same = await relox.first().evaluate(
                (el: Element, cssId: string) => `#${el.getAttribute("id") || ""}` === cssId, step.selector.css,
              ).catch(() => false);
              if (!same) {
                selected = await selectWithFallback(this.page, relox.first(), v);
                if (!selected && this.isManufacturerStep(step)) {
                  for (const alt of equipmentMakeCandidates(v).slice(1)) {
                    selected = await selectWithFallback(this.page, relox.first(), alt);
                    if (selected) { this.driftWarnings.push(`manufacturer "${v}" matched the portal's certified name "${alt}"`); break; }
                  }
                }
                if (selected) {
                  this.driftWarnings.push(`select "${String(step.note ?? step.field ?? "")}" landed via its LABEL fallback — the recorded id resolved to a different control mid-run`);
                  scoped = relox.first();
                  isNativeSelect = await this.isNativeSelect(scoped); // the commit path needs the RETRIED widget's type
                }
              }
            }
          }
        }
        // Wait for any Vue/React re-renders triggered by the dropdown change to settle
        // before filling subsequent fields (e.g. PowerClerk resets contact fields on
        // contact-type dropdown change).
        await this.page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => null);
        // WHY DID IT MISS? A select that lands nothing is reported as a bare SKIP, and
        // "the widget never opened" and "it opened but this value is not in it" need
        // completely different fixes. Live PacifiCorp skipped both equipment Model steps
        // after 26 seconds each, on a control the diagnostic showed as visible=false — and
        // there was no way to tell which of the two had happened. Only paid for on a miss.
        if (!selected) {
          const seen = await this.visibleOptionSample();
          const resolved = await this.describeResolved(step);
          this.driftWarnings.push(
            seen.count === 0
              ? `select "${String(step.note ?? step.field ?? "")}" landed nothing and NO option list was open — the widget never opened (wanted ${JSON.stringify(v.slice(0, 40))}; resolved ${resolved})`
              : `select "${String(step.note ?? step.field ?? "")}" landed nothing though ${seen.count} option(s) were showing — wanted ${JSON.stringify(v.slice(0, 40))}, resolved ${resolved}, list offers ${seen.sample.map((o) => JSON.stringify(o)).join(", ")}`,
          );
        }
        // COMMIT WHAT LANDED. PowerClerk autosaves per field on blur — the fill path has
        // always blurred for exactly this reason (and so does the learner after a model
        // select), but a replayed select never did. The value showed in the DOM, every
        // check passed, and the next server re-render (a row-add, a Calculate) restored
        // the placeholder — measured live on array 1's module manufacturer, and again on
        // the inverter manufacturer (a COMBOBOX: its pick sat uncommitted, Add Array's
        // re-render wiped it, and the committed draft held "Please select...").
        // NATIVE: focus first — selectOption never focuses, and blurring an unfocused
        // element fires no blur event (the smoke proved a bare blur() commits nothing).
        // COMBOBOX: blur ONLY — the interaction already focused its input, and focus()
        // is an OPENER on these widgets (comboboxFill uses it to open); re-focusing pops
        // the list back open to shadow the NEXT widget's option scan. The learner has
        // blurred after combobox model picks since the beginning ("saved model on blur").
        if (selected && typeof scoped?.blur === "function") {
          try {
            if (isNativeSelect && typeof scoped.focus === "function") await scoped.focus({ timeout: 2000 });
            await scoped.blur({ timeout: 2000 });
          } catch { /* commit is best-effort — never fail a landed select over it */ }
        }
        // Propagate the miss: a select that landed NOTHING must not report success.
        return selected;
      }
      case "check": {
        // A policy radio's recorded id carries a per-render counter — re-anchor by the
        // question's stable prefix and the recorded answer before waiting out a timeout on
        // an id that cannot exist on this project.
        // Recover when the recorded id matches NOTHING, and equally when it matches an
        // element that cannot be checked. Requiring a zero count missed the live case
        // entirely: PowerClerk's radio ids carry a per-render suffix
        // ("#XWXYUBJ7ZTNQInput_11513"), and on a new project that id often still exists
        // while pointing at the hidden half of a styled widget — so count() was 1, recovery
        // never ran, and check() spent its full 30s before failing the whole replay.
        const present = await scoped?.count?.().catch(() => 0);
        const usable = present ? await scoped.first().isVisible().catch(() => false) : false;
        const recovered = usable ? null : await this.recoverVolatileIdOption(step);
        // A CONDITIONAL QUESTION THE PORTAL DID NOT ASK THIS TIME.
        //
        // Portals show sections conditionally, and a recipe records whatever the LEARN
        // project happened to trigger. Measured live: PGE renders "Disconnect Requirements"
        // only above 7.2 kW at 240V single phase, so a recipe learned on a 10.32 kW system
        // carries a disconnect step that a 6.97 kW system is never asked. The control is
        // genuinely absent — not drifted, not hidden — and failing the whole replay over a
        // question the portal declined to ask is wrong.
        //
        // Only for a POLICY DEFAULT: those are fixed answers to questions that may or may
        // not appear, so "not asked" needs no answer. A recorded data fill that vanishes is
        // a different matter and still fails, because that IS missing information.
        if (!usable && !recovered && /^policy default:/i.test(String(step.note ?? ""))) {
          if (!this.inPolicyRetry) {
            // Say what the recovery SAW, not just that it gave up — "no candidates" (the
            // question truly is not rendered) and "candidates whose labels match nothing"
            // (a lookup gap) need different fixes and looked identical for a whole day.
            const diag = await this.describePolicyGroup(step);
            this.driftWarnings.push(`policy question not asked for this project — skipped: ${String(step.note ?? "").slice(0, 60)}${diag}`);
            // A CONDITIONAL QUESTION CAN ALSO RENDER LATE — give it one more look just
            // before this page's advance, when the page is as settled as it will ever be.
            this.pendingPolicyRetries.push(step);
          }
          return false;
        }
        const target = recovered ?? scoped;
        await waitForElement(target);
        // force: a radio inside a styled widget is driven by its label, so the input itself
        // can be visually hidden while still being the thing that must end up checked.
        // A RECOVERED radio is usually exactly that hidden half (recovery only runs when
        // the recorded id was unusable) — force must follow !usable alone, or the check
        // waits out its full actionability timeout on an element that can never be visible.
        await target!.check({ force: !usable });
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
    //
    // Fingerprint FIRST: this is the only way to tell "the portal advanced" from "the
    // portal refused". waitForInteractiveControls below cannot — it is page-global and
    // identity-free, so a page that never moved satisfies it instantly.
    const beforeUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
    const beforeFp = await this.pageIdentity();

    await waitForElement(scoped);
    await scoped!.click();
    // A recorded Next/Continue advances a Vue wizard to a not-yet-bound section. Wait for an
    // interactive control to mount before the next fill so we never type onto an unmounted page
    // (best-effort; never skips — the retry/reload loop still recovers a genuine miss).
    await waitForInteractiveControls(this.page);
    await this.assertAdvanced(step, beforeUrl, beforeFp);
    return true;
  }

  /**
   * WHICH page this is, not whether anything on it changed. The learner's pageFingerprint
   * includes document.body.innerText.length, which is right for its purpose but wrong here:
   * a portal REFUSING an advance renders a validation message, the body text grows, and the
   * fingerprint duly changes — so "the portal rejected you" would read as "the page moved".
   * That is not hypothetical; it is what the first version of the advance guard did.
   *
   * Identity is the wizard heading plus the ids of the controls currently on screen. A
   * validation message perturbs neither.
   */
  private async pageIdentity(): Promise<string> {
    if (!this.page || typeof this.page.evaluate !== "function") return "";
    return await this.page.evaluate(() => {
      const h = document.querySelector("h1, h2, legend, .wizard-step.active, .nav-link.active, [aria-current='page']");
      const heading = ((h as HTMLElement | null)?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
      const ids: string[] = [];
      const els = Array.from(document.querySelectorAll("input, select, textarea")) as HTMLElement[];
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (!r || (r.width === 0 && r.height === 0)) continue;
        ids.push(el.getAttribute("id") || el.getAttribute("name") || (el.tagName || "").toLowerCase());
      }
      return `${location.pathname}|${heading}|${ids.sort().join(",")}`;
    }).catch(() => "") as Promise<string>;
  }

  /**
   * DID THE PORTAL ACTUALLY MOVE? The learner has always checked this (its POST-ADVANCE
   * VALIDATION GUARD); replay never did, and that single omission is what turned a blocked
   * "Next" into forty steps of wrong-control fills.
   *
   * When a required field is left blank, the portal refuses the advance but the CLICK still
   * succeeds — the button was there and was clicked. Replay then believed it had advanced,
   * ran the next page's steps against the page it was still on, and every recorded id
   * resolved onto whatever unrelated control happened to occupy it. Measured live: 59 steps
   * executed and 6 skipped past a desync before anything noticed.
   *
   * Throws on a confirmed block, so the caller's existing retry/fail path reports it with
   * the "Recipe step failed" prefix that repository.ts matches to flag the recipe and queue
   * a fresh learn. A goto/navigation click legitimately changes the URL, which counts as
   * moving; only a click that changes NOTHING is a block.
   */
  private async assertAdvanced(step: RecipeStep, beforeUrl: string, beforeFp: string): Promise<void> {
    // No identity means a mock/no-DOM page (the unit-test doubles) — assert nothing.
    if (!beforeFp) return;
    const moved = async (): Promise<boolean> => {
      const url = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
      if (url && url !== beforeUrl) return true;
      const fp = await this.pageIdentity();
      return !!fp && fp !== beforeFp;
    };

    // FAST PATH 1 — it moved. One identity read, no waiting. This is the common case and it
    // must stay free: an earlier ordering settled first and put 5s on every click, which is
    // the opposite of what "fast once learned" needs.
    if (await moved()) return;

    // FAST PATH 2 — it did not move and the portal is not complaining. NOT every recorded
    // click is an advance: "Calculate", "Add Array", "Add New" contact and saves all
    // legitimately leave the page as it was, and failing those would break working replays
    // (the Accela replay smoke caught exactly that). Note it and move on; precheckPageDrift
    // remains the backstop if this really was a desync.
    let blockers = await collectValidationErrorsFrom(this.page).catch(() => [] as string[]);
    // IS THIS STEP AN ADVANCE? The recorder answers that: the learner marks a page advance
    // "advance: <button>" and gives in-page actions their own wording ("compute totals:
    // Calculate", "contacts: continue"). For a step the recorder called an advance, a page
    // that did not move IS the failure — whether or not the portal explains itself.
    //
    // That distinction is load-bearing. Requiring visible validation errors was too weak on
    // the live portal: PacifiCorp refuses silently, so six advances "left the page
    // unchanged" and were all waved through as in-page actions. Requiring EVERY click to
    // move the page is too strong and broke the Accela replay smoke outright.
    const isAdvance = /^advance\b/i.test(String(step.note ?? "").trim());
    if (!blockers.length && !isAdvance) {
      this.driftWarnings.push(`click "${String(step.note ?? "click").slice(0, 44)}" left the page unchanged (in-page action, or an advance that silently did nothing)`);
      return;
    }

    // The portal is refusing. Give a slow SPA a moment in case the complaint is stale and
    // the next section is still rendering, then try clearing an overlay and clicking once
    // more — an announcement modal ate every click of a diagnostic probe for fourteen
    // iterations without it ever noticing.
    for (let i = 0; i < ADVANCE_SETTLE_TRIES && !(await moved()); i++) await sleep(ADVANCE_SETTLE_MS);
    if (await moved()) return;
    await dismissPageModals(this.page).catch(() => null);
    await clearPageOverlays(this.page).catch(() => null);
    const again = await this.resolveLocator(step.selector).catch(() => null);
    if (again && typeof again.click === "function") await again.click({ timeout: 8000 }).catch(() => null);
    for (let i = 0; i < ADVANCE_SETTLE_TRIES && !(await moved()); i++) await sleep(ADVANCE_SETTLE_MS);
    if (await moved()) {
      this.driftWarnings.push(`advance "${String(step.note ?? "click").slice(0, 44)}" needed an overlay dismissed before it took`);
      return;
    }

    // Still refused. Report the PORTAL'S OWN words — "Meter Number: This field is required."
    // is worth more to an operator than any drift percentage we could compute.
    blockers = await collectValidationErrorsFrom(this.page).catch(() => blockers);
    const said = blockers.length
      ? ` The portal says: ${blockers.slice(0, 6).join(" | ")}`
      : " The portal gave no visible reason — check that page for a required field the recipe left blank.";
    throw new Error(`the portal did not advance (it refused "${String(step.note ?? "the advance").slice(0, 44)}").${said}`);
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
  /**
   * Visible REQUIRED controls that are still empty, by label. The mirror of
   * pageIsPassThrough — that one asks "is anything unfilled?", this one asks "what?".
   * File inputs count: an empty one reads as value "", which is exactly the meter-photo
   * case that prompted this.
   */
  /**
   * One screenshot per completed wizard page, so a run can be reviewed by eye afterwards
   * instead of only when it fails. Capped, so a recipe that loops cannot fill the disk.
   */
  private async capturePageShot(label: string): Promise<void> {
    if (!this.page || typeof this.page.screenshot !== "function") return;
    if (this.pageShotCount >= 40) return;
    try {
      if (!this.pageShotDir) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const who = String(this.recipe?.utility || this.recipe?.ahj || "portal")
          .toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 28);
        this.pageShotDir = path.join(
          process.env.REPLAY_RUN_DIR || path.join(process.cwd(), "data", "replay-runs"),
          stamp + "-" + who,
        );
        await fs.promises.mkdir(this.pageShotDir, { recursive: true });
      }
      this.pageShotCount++;
      const safe = String(label || "page").replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 40) || "page";
      const n = String(this.pageShotCount).padStart(3, "0");
      await this.page.screenshot({ path: path.join(this.pageShotDir, "p" + n + "-" + safe + ".png"), fullPage: true });
    } catch { /* best-effort: never fail a replay over a screenshot */ }
  }

  private async emptyRequiredControls(): Promise<string[]> {
    if (!this.page || typeof this.page.evaluate !== "function") return [];
    return await this.page.evaluate(() => {
      const out: string[] = [];
      const els = Array.from(document.querySelectorAll("input, select, textarea")) as HTMLElement[];
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (!r || (r.width === 0 && r.height === 0)) continue;
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (type === "hidden" || type === "submit" || type === "button" || type === "checkbox" || type === "radio") continue;
        const id = el.getAttribute("id") || "";
        const lbl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        const labelText = ((lbl && (lbl as HTMLElement).textContent) || "").replace(/\s+/g, " ").trim();
        // A PORTAL CAN MARK "REQUIRED" WITH A MESSAGE, NOT AN ATTRIBUTE. PacifiCorp
        // renders a red "This field is required." beside the control and carries neither
        // the attribute nor an asterisk in the label — so a blank REQUIRED inverter
        // manufacturer went unreported on a run that ended ok:true, and the operator found
        // it by looking at the portal. A visible complaint in the control's own container
        // is the requirement marker, plainly.
        // A bare div ancestor is the whole PAGE on some layouts, which made every control
        // inherit one control's complaint. Bound it: the container must own exactly ONE
        // form control, or the message is not about this control.
        const container = el.closest('[class*="form-group"], [class*="field"], [class*="row"], li, tr, dd, p');
        const ownsOne = !!container && container.querySelectorAll("input, select, textarea").length === 1;
        const complaint = ownsOne
          && /this field is required|required field|cannot be (blank|empty)|please (select|enter)/i
            .test((container as HTMLElement).innerText || "");
        const required = el.hasAttribute("required")
          || el.getAttribute("aria-required") === "true"
          || /\*/.test(labelText)
          || complaint;
        if (!required) continue;
        // "Filled" must mean filled: a native select sitting on its placeholder option
        // reports that option's text as .value, and a custom COMBOBOX is an input whose
        // .value IS the placeholder ("Please select...") — both read as non-empty and
        // made this sweep bless unanswered controls.
        const raw = ((el as HTMLInputElement).value || "").trim();
        const shown = (el.tagName || "").toLowerCase() === "select"
          ? ((((el as HTMLSelectElement).options[(el as HTMLSelectElement).selectedIndex] || {}).textContent) || "").trim()
          : raw;
        const sitsOnPlaceholder = /^(please\s+)?select\.{0,3}$/i.test(shown) || /^--/.test(shown);
        if (raw && !sitsOnPlaceholder) continue;
        const name = labelText
          || el.getAttribute("aria-label")
          || el.getAttribute("placeholder")
          || el.getAttribute("name")
          || "(unlabelled control)";
        const clean = name.replace(/\s*\*\s*$/, "").trim().slice(0, 70);
        if (clean && !out.includes(clean)) out.push(clean);
      }
      // UNANSWERED REQUIRED RADIO GROUPS. Radios are skipped above (a single unchecked
      // radio is not a blank), but a GROUP where nothing is checked is exactly a blank —
      // and PGE's required "disconnect within 10 feet" pair sat unanswered while this
      // sweep reported a clean page. Conservative: only groups whose shared container
      // carries a required marker (asterisk or a visible complaint), keyed by name attr
      // or the per-render id prefix PowerClerk uses.
      const radios = (Array.from(document.querySelectorAll("input[type=radio]")) as HTMLInputElement[])
        .filter((el) => { const r = el.getBoundingClientRect(); return (r.width > 0 && r.height > 0) || !!el.closest("label"); });
      const groups = new Map<string, HTMLInputElement[]>();
      for (const r of radios) {
        const key = r.getAttribute("name") || (r.getAttribute("id") || "").replace(/_\d+$/, "");
        if (!key) continue;
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
      }
      for (const [, members] of groups) {
        if (members.length < 2 || members.some((r) => r.checked)) continue;
        // The group's shared container: the closest ancestor of the first radio that
        // contains every member.
        let cont: HTMLElement | null = members[0].parentElement;
        while (cont && cont !== document.body && !members.every((r) => cont!.contains(r))) cont = cont.parentElement;
        if (!cont || cont === document.body) continue;
        const text = (cont.innerText || "").replace(/\s+/g, " ").trim();
        const requiredish = /\*/.test(text.slice(0, 200)) || /this field is required|required field|please (select|choose)/i.test(text);
        if (!requiredish) continue;
        const q = text.replace(/\s*\*\s*/g, " ").trim().slice(0, 70);
        if (q && !out.includes(q)) out.push(q);
      }
      return out.slice(0, 12);
    }).catch(() => [] as string[]) as string[];
  }

  /** Nothing here to fill: no visible required control is empty. A page like ACA's
   *  "Licensed Professional List" — already populated from the account, just needing a
   *  Continue — is safe to click through; a page with an empty required field is not,
   *  because clicking past it files an incomplete application. */
  private async pageIsPassThrough(): Promise<boolean> {
    if (!this.page || typeof this.page.evaluate !== "function") return false;
    return await this.page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("input, select, textarea")) as HTMLElement[];
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (!r || (r.width === 0 && r.height === 0)) continue;
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (type === "hidden" || type === "submit" || type === "button" || type === "checkbox" || type === "radio") continue;
        const id = el.getAttribute("id") || "";
        const lbl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        const required = el.hasAttribute("required")
          || el.getAttribute("aria-required") === "true"
          || /\*/.test((lbl && (lbl as HTMLElement).textContent) || "");
        if (!required) continue;
        const value = (el as HTMLInputElement).value || "";
        if (!value.trim()) return false; // something here needs data
      }
      return true;
    }).catch(() => false) as boolean;
  }

  /** Are most of these recorded labels on the page right now? Used to spot an advance the
   *  recipe carries from another jurisdiction, where the next section is already showing.
   *  Reuses the drift precheck's own matcher so both agree on what "this section" means. */
  /**
   * Is this ONE recorded label on the page right now?
   *   true  - found it
   *   false - read the page and it is genuinely not there
   *   null  - could NOT read the page, which is not evidence of anything
   * The tri-state is the point. segmentIsOnThisPage collapses "absent" and "unreadable"
   * into false, and a caller that skips work on false would then skip it hardest exactly
   * when the page is unreadable. That conflation has produced three wrong diagnoses in
   * this codebase already.
   */
  private async labelPresentOnPage(label: string): Promise<boolean | null> {
    if (!this.page || typeof this.page.$$eval !== "function") return null;
    let raws: Array<{ label?: string }>;
    try { raws = (await this.page.$$eval(EXTRACT_SEL, extractFieldsInPage)) as Array<{ label?: string }>; }
    catch { return null; }
    if (!Array.isArray(raws) || !raws.length) return null; // nothing extracted at all: unreadable, not empty
    const w = label.trim().toLowerCase();
    return raws.some((r) => {
      const l = (r.label || "").trim().toLowerCase();
      if (!l) return false;
      return l === w || (Math.min(l.length, w.length) >= 5 && (l.includes(w) || w.includes(l)));
    });
  }

  private async segmentIsOnThisPage(expected: string[]): Promise<boolean> {
    try {
      if (!this.page || typeof this.page.$$eval !== "function") return false;
      const raws = (await this.page.$$eval(EXTRACT_SEL, extractFieldsInPage)) as Array<{ label?: string }>;
      const live = raws.map((r) => (r.label || "").trim().toLowerCase()).filter(Boolean);
      let hit = 0;
      for (const want of expected) {
        const w = want.toLowerCase();
        if (live.some((l) => l === w || (Math.min(l.length, w.length) >= 5 && (l.includes(w) || w.includes(l))))) hit++;
      }
      // The same 34% bar precheckPageDrift uses to call a page "the recorded one".
      return hit / expected.length >= 0.34;
    } catch { return false; }
  }

  /** Did the address search return ANY selectable result rows? Distinguishes "the portal
   *  does not serve this jurisdiction" from "it does, but the row could not be matched". */
  private async addressSearchHadResults(): Promise<boolean> {
    if (!this.page || typeof this.page.evaluate !== "function") return true;
    return await this.page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("tr"));
      for (const tr of rows) {
        const a = tr.querySelector("a");
        if (a && /select/i.test(a.textContent || "")) return true;
      }
      return false;
    }).catch(() => true) as boolean;
  }

  /**
   * Click the search-result row whose ADDRESS is this project's, and return its text.
   *
   * Normalises the way portals and plan sets disagree: directionals ("SE" vs "Southeast")
   * and street types ("St" vs "Street", "Ave" vs "Avenue"). Requires the street NUMBER to
   * match as well, so "25th St" cannot select a different building on the same street.
   * Returns "" unless exactly one row matches — several candidates is a decision for the
   * human at review, not a guess that files against the wrong parcel.
   */
  private async pickAddressRow(streetNumber: string, street: string, prefer: "city" | "county" = "city"): Promise<string> {
    if (!this.page || typeof this.page.evaluate !== "function") return "";
    const id = await this.page.evaluate((args: { num: string; street: string; prefer: string }) => {
      // No nested function declarations — esbuild's keepNames would wrap them as __name(…)
      // and this evaluate would throw into a swallowed catch.
      const DIRECTIONS: Record<string, string> = {
        n: "north", s: "south", e: "east", w: "west",
        ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest",
      };
      const TYPES: Record<string, string> = {
        st: "street", ave: "avenue", av: "avenue", rd: "road", dr: "drive", ln: "lane",
        ct: "court", blvd: "boulevard", pl: "place", ter: "terrace", cir: "circle",
        hwy: "highway", pkwy: "parkway", way: "way", loop: "loop", trl: "trail",
      };
      const rows = Array.from(document.querySelectorAll("tr"));
      const hits: Array<{ idx: number; text: string }> = [];
      // Expand the wanted address once.
      const wantWords: string[] = [];
      for (const raw of `${args.num} ${args.street}`.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
        if (!raw) continue;
        wantWords.push(DIRECTIONS[raw] || TYPES[raw] || raw);
      }
      for (let i = 0; i < rows.length; i++) {
        const tr = rows[i];
        if (!tr.querySelector("a")) continue; // only rows offering a Select link
        const words: string[] = [];
        for (const raw of (tr.textContent || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
          if (!raw) continue;
          words.push(DIRECTIONS[raw] || TYPES[raw] || raw);
        }
        let all = true;
        for (const w of wantWords) if (words.indexOf(w) < 0) { all = false; break; }
        if (all) hits.push({ idx: i, text: (tr.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90) });
      }
      if (!hits.length) return "";
      let chosen = hits[0];
      if (hits.length > 1) {
        // Same address, several jurisdictions. Prefer the one this discipline files with;
        // the county row usually names "COUNTY" and the city row does not.
        const wantCounty = args.prefer === "county";
        const matching = hits.filter((h) => /county/i.test(h.text) === wantCounty);
        if (matching.length !== 1) return ""; // still ambiguous — a human should choose
        chosen = matching[0];
      }
      rows[chosen.idx].setAttribute("data-replay-addr", "1");
      return chosen.text;
    }, { num: streetNumber, street, prefer }).catch(() => "") as string;
    if (!id) return "";
    const link = this.page.locator('tr[data-replay-addr="1"]').locator("a:has-text('Select')").first();
    if (!(await link.count().catch(() => 0))) return "";
    await link.click({ timeout: 8000 }).catch(() => null);
    return id;
  }

  /** Is this locator a native <select>, whose options can actually be read? */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async isNativeSelect(loc: any): Promise<boolean> {
    if (!loc || typeof loc.evaluate !== "function") return false;
    return await loc.evaluate((el: Element) => (el.tagName || "").toLowerCase() === "select").catch(() => false) as boolean;
  }

  /** Is this step choosing an equipment MODEL? Field name first, the control's own bare
   *  "Model" label second — PowerClerk spec pages label them exactly that. */
  private isModelStep(step: RecipeStep): boolean {
    if (/model$/i.test(String(step.field ?? ""))) return true;
    return /\bmodel\b/i.test(`${step.selector?.label ?? ""} ${step.note ?? ""}`);
  }

  /**
   * The option in THIS control that the plan set's model refers to. Reads the live option
   * list rather than guessing at suffixes, and applies three rules in order:
   *   1. exact (normalised) match wins;
   *   2. otherwise the option must START with the model at a TOKEN BOUNDARY — so "DS3-L"
   *      matches "DS3-L {240V}" but never "DS3-LV {120V}", which a plain contains-match
   *      would happily choose;
   *   3. among several boundary matches, prefer the one carrying this project's wattage —
   *      "Q.TRON BLK M-G2.C1+/AC" lists six options differing only by 415…440 W, and the
   *      wattage is the only thing that distinguishes them.
   * Returns "" when nothing matches or the choice stays ambiguous: selecting the wrong
   * module on a live interconnection application is worse than leaving it for the human.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async bestModelOption(loc: any, want: string, step: RecipeStep): Promise<string> {
    if (!loc || typeof loc.evaluate !== "function" || !want) return "";
    // The wattage that disambiguates a module family, from whichever key this project has.
    const side = /module/i.test(String(step.field ?? "")) ? "module" : "inverter";
    const watts = String(
      (side === "module" ? this.fieldValues.moduleWattage : this.fieldValues.inverterWattage) ?? "",
    ).replace(/[^0-9]/g, "");
    return await loc.evaluate((el: Element, args: { want: string; watts: string }) => {
      // No nested function declarations in here — esbuild's keepNames would wrap them as
      // __name(...) and the evaluate would throw into a swallowed catch.
      const opts: string[] = [];
      if ((el.tagName || "").toLowerCase() === "select") {
        for (const o of Array.from((el as HTMLSelectElement).options)) opts.push((o.textContent || "").trim());
      }
      if (!opts.length) return "";
      const norm = args.want.toLowerCase().replace(/\s+/g, " ").trim();
      // Punctuation-free form too: the CEC writes "ZXM7-SH108-410/M" where the plan set
      // writes "ZXM7-SH108-410M". That is one inserted slash, not a suffix, so prefix
      // matching alone cannot see it.
      const bare = norm.replace(/[^a-z0-9]/g, "");
      let exact = "";
      const boundary: string[] = [];
      for (const raw of opts) {
        const t = raw.toLowerCase().replace(/\s+/g, " ").trim();
        if (!t || /^(please\s+)?select/.test(t)) continue;
        if (t === norm || t.replace(/[^a-z0-9]/g, "") === bare) { exact = raw; break; }
        if (t.startsWith(norm)) {
          // The character right after the model must not continue the token, or "DS3-L"
          // would swallow "DS3-LV".
          const next = t.charAt(norm.length);
          if (!next || !/[a-z0-9]/.test(next)) boundary.push(raw);
        }
      }
      if (exact) return exact;
      if (!boundary.length) return "";
      if (boundary.length === 1) return boundary[0];
      if (args.watts) {
        const byWatts = boundary.filter((b) => b.replace(/[^0-9]/g, "").includes(args.watts));
        if (byWatts.length === 1) return byWatts[0];
      }
      return ""; // still ambiguous — leave it for the human rather than guess a module
    }, { want, watts }).catch(() => "") as string;
  }

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

  /** One line of ground truth for a policy-radio miss: how many candidates the volatile-id
   *  group held at that moment, and what their labels read. "(0 candidates)" means the
   *  question was not rendered; candidates with labels that match nothing means the
   *  LOOKUP is wrong — two different bugs that read identically without this. */
  private async describePolicyGroup(step: RecipeStep): Promise<string> {
    const css = String(step.selector?.css ?? "");
    const m = /^#([A-Za-z0-9_-]+?)_\d+$/.exec(css);
    if (!m) return " (no volatile-id group to inspect)";
    try {
      const labels = await this.page.evaluate((prefix: string) => {
        const els = Array.from(document.querySelectorAll(`[id^="${prefix}_"]`));
        return els.slice(0, 6).map((el) => {
          const eid = el.getAttribute("id") || "";
          let t = eid ? ((document.querySelector(`label[for="${CSS.escape(eid)}"]`) as HTMLElement | null)?.innerText ?? "") : "";
          if (!t) t = (el.closest("label") as HTMLElement | null)?.innerText ?? "";
          if (!t) t = el.getAttribute("aria-label") || "";
          const r = (el as HTMLElement).getBoundingClientRect?.();
          return `#${eid.slice(-8)}="${t.replace(/\s+/g, " ").trim().slice(0, 20)}"${r && (r.width > 0 || r.height > 0) ? "" : "[hidden]"}`;
        });
      }, m[1]).catch(() => null) as string[] | null;
      if (!labels) return " (group unreadable)";
      return labels.length ? ` (${labels.length} candidate(s): ${labels.join(", ")})` : " (0 candidates — not rendered)";
    } catch { return " (group inspect failed)"; }
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
        // The FULL accessible-label chain, not just label[for]: PGE's disconnect radios
        // WRAP their input in the label, so a for-only lookup read "" and recovery
        // declared the question "not asked" — while it sat unanswered on the live page.
        const label = await opt.evaluate((el: Element) => {
          const eid = el.getAttribute("id") || "";
          let t = eid ? ((document.querySelector(`label[for="${CSS.escape(eid)}"]`) as HTMLElement | null)?.innerText ?? "") : "";
          if (!t) t = (el.closest("label") as HTMLElement | null)?.innerText ?? "";
          if (!t) t = el.getAttribute("aria-label") || "";
          return t;
        }).catch(() => "");
        if (String(label ?? "").replace(/\s+/g, " ").trim().toLowerCase() === answer.trim().toLowerCase()) {
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

      // AN UNPAINTED PAGE IS NOT DRIFT. This read the DOM once, so a portal that renders
      // its fields asynchronously looked identical to being on the wrong page: measured
      // live on Ameren Illinois (PowerClerk), the form URL loads and reports ZERO visible
      // inputs for seconds afterwards, and the replay failed the whole run at "0 of 17
      // recorded fields" while the page it wanted was still on its way. Poll until the
      // expected fields show up, and only call it drift when they never do. Genuine drift
      // pays this budget once and then stops the run, which it was going to do anyway.
      let hit = 0;
      let overlap = 0;
      const deadline = Date.now() + DRIFT_SETTLE_MS;
      for (;;) {
        const raws = (await this.page.$$eval(EXTRACT_SEL, extractFieldsInPage)) as Array<{ label?: string }>;
        const live = raws.map((r) => (r.label || "").trim().toLowerCase()).filter(Boolean);
        const matches = (want: string): boolean => {
          const w = want.toLowerCase();
          return live.some((l) => l === w || (Math.min(l.length, w.length) >= 5 && (l.includes(w) || w.includes(l))));
        };
        hit = expected.filter(matches).length;
        overlap = hit / expected.length;
        if (overlap >= 0.34) return null;
        if (Date.now() >= deadline) break;
        await sleep(750);
      }
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
    // The listing above says what the page HAS; this says what the repair made of it.
    // Without it, a control that is present and named in that very list but still fails
    // to click gives no clue whether the re-anchor looked, or looked and declined.
    if (this.healDiagnostic) parts.push(`self-heal: ${this.healDiagnostic}`);
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
    // WHY THIS REPORTS. Every exit below used to be a bare `return null`, so a heal that
    // never ran (page gone, $$eval threw) looked exactly like a heal that ran and found
    // nothing. A live PGE replay failed at step 1 on a control the failure diagnostic
    // listed as VISIBLE, with healedSteps: 0 and no way to tell which had happened.
    this.healDiagnostic = "";
    if (!this.page || typeof this.page.$$eval !== "function") {
      this.healDiagnostic = "no page to re-extract from";
      return null;
    }
    const wanted = (step.note || step.selector?.label || step.selector?.name || "").trim().toLowerCase();
    if (wanted.length < 3) {
      this.healDiagnostic = `nothing to anchor on (note/label is ${JSON.stringify(wanted)})`;
      return null;
    }
    let raws: unknown[] = [];
    try { raws = await this.page.$$eval(EXTRACT_SEL, extractFieldsInPage); }
    catch (err) {
      // Do NOT swallow this. A function declared inside the extraction script compiles to
      // __name(fn, "…"), which does not exist in the browser; that throw is what made an
      // earlier scan read as "found nothing" for three separate investigations.
      this.healDiagnostic = `re-extraction threw: ${err instanceof Error ? err.message : String(err)}`;
      return null;
    }
    const compat = (t: string): boolean =>
      step.action === "select" ? t === "select"
      : step.action === "check" || step.action === "uncheck" ? t === "checkbox" || t === "radio"
      : step.action === "click" ? t === "button"
      : t === "text" || t === "other" || t === "select";
    let best: { sel: RecipeSelector; score: number } | null = null;
    const sawCompatible: string[] = [];
    for (const raw of raws as Parameters<typeof toExtractedField>[0][]) {
      const f = toExtractedField(raw);
      if (!compat(f.fieldType)) continue;
      const label = (f.label || "").trim().toLowerCase();
      if (label && sawCompatible.length < 10) sawCompatible.push(label.slice(0, 40));
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
    if (best && JSON.stringify(best.sel) === JSON.stringify(step.selector)) {
      // The page still offers exactly the control we recorded, so the selector is not the
      // problem — something is stopping the click from LANDING (an overlay, a disabled
      // state). Saying so points at a completely different fix than "selector drifted".
      this.healDiagnostic = "the live page offers the SAME selector that just failed — the control is there but the click is not landing (overlay/disabled?), not a drifted selector";
      return null;
    }
    if (!best) {
      this.healDiagnostic = sawCompatible.length
        ? `no ${step.action}-compatible control matched ${JSON.stringify(wanted.slice(0, 50))}; page offers: ${sawCompatible.map((s) => JSON.stringify(s)).join(", ")}`
        : `re-extraction returned no ${step.action}-compatible controls at all (${raws.length} element(s) scanned)`;
    }
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
