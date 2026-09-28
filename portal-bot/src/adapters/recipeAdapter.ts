import fs from "fs";
import path from "path";
import type { PortalRecipe, ProjectRecord, RecipeSelector, RecipeStep } from "../../../shared/src/types";
import { BasePortalAdapter, HUMAN_REVIEW_MESSAGE, ok, fail, type PortalContext, type PortalStepResult } from "../adapter";
import { applyFormatHint } from "../formatHint";
import { extractRecordNumber, pageConfirmsSubmission } from "../recordNumber";
import { armHumanCaptureOnPage, HUMAN_SUBMIT_OBSERVED_NOTE } from "../humanCapture";
import { feeBracketCoverage, feeBracketCoverageMessage, decideFeeTier, FEE_TIER_DC_FIELD, FEE_TIER_RATING_FIELD, kvaText, parseFeeBracketFieldKey, readTierLabel, sameFeeTier, TIER_UNIT_RE, type TierBoxOnPage } from "../feeBracketQuantity";

/** The pause's reason when a recorded kVA tier step finds no tier box on its page (close MF2). */
const FEE_TIER_NO_BOX_REASON = "the recorded kVA tier box was not found on this page and no kVA-labelled box could be read";
import { collectPortalErrorBanner } from "../safeAction";
import { structureTypeMeaning } from "../../../backend/src/permitProcess";

// A RECORDED ANSWER THAT DESCRIBES A PROJECT OR A PERSON BELONGS TO THAT PROJECT.
//
// portal_recipes are shared deliberately — across AHJs and, per CLAUDE.md's tenancy model,
// across ORGS. So a literal frozen into a recipe is replayed for other customers of other
// solar companies. That is fine for the portal's own vocabulary ("STAND-ALONE", "Residential")
// and catastrophic for the learn project's homeowner, service address, account number, or an
// installer licence belonging to a different company.
//
// Reproduced in crossProjectReplay.test.ts before this guard existed: "Alice Anderson" and
// "111 First Street" typed into a second project's application, and 8000 W filed for a 6 kW
// system, because the binder keeps any literal that does not EXACTLY match a project value.
//
// Deliberately LABEL-FIRST and high-precision. Blanking a portal constant would break a
// required dropdown on every replay, so the taxonomy words below are excluded first and only
// unmistakable per-person/per-property/per-equipment labels (plus two unambiguous value
// shapes) return true.
const TAXONOMY_LABEL = /\b(category|type|class|kind|purpose|scope|description|reason|status|method|discipline|jurisdiction|program|option|permit\s*type|work\s*type)\b/i;
const PROJECT_DATA_LABEL = /\b(owner|homeowner|applicant|customer|contact|first\s*name|last\s*name|full\s*name|middle|surname|address|street|city|zip|postal|county|parcel|apn|phone|mobile|tel|fax|e-?mail|account|meter|serial|licen[sc]e|contractor|installer|company|business|ein|tax\s*id|ssn|docket|kw|kva|watt|capacity|system\s*size|quantity|qty|azimuth|tilt|manufacturer|model)\b/i;
const UNAMBIGUOUS_PII_VALUE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i /* email */;
const PHONE_VALUE = /^\+?\d[\d\s().-]{8,}$/;

// "NAME" ON ITS OWN IS THE COMMONEST LABEL A PORTAL PRINTS, AND IT MATCHED NOTHING.
//
// PROJECT_DATA_LABEL asks for "owner name", "first name", "customer"… so a box labelled just
// "Name" — which is what PowerClerk, PGE and Ameren all print beside their contact fields —
// fell through every rule and the recorded literal replayed. This is the leak the guard above
// was written to close, still open for the label it is most likely to arrive under, and it is
// visible in the DOM suite right now: finalPageReassert files Name="ZZTest Replay Benchmark"
// and identicalSections files "Charles"/"Bitton" in checks that PASS.
//
// Widened on evidence rather than on instinct. Every step in the 76 recorded recipes whose
// label contains "name" was read first: all 36 person-name steps are already BOUND (to
// homeownerFirstName, installerLastName…), so this rule costs them nothing — and the ONLY
// unbound "name" literals in the whole corpus are two copies of
//     "Permit Name" = "Solar PV System Installation"
// which is the portal's word for the kind of permit, not anybody's name. Blanking that would
// have traded a hypothetical leak for a real blank required field, so a label that names a
// THING is excluded explicitly. "Project Name" is deliberately NOT on that list: on the live
// Ameren recipe it is bound to projectAddress, because a project's name is usually the
// customer's address or the customer.
const BARE_NAME_LABEL = /\bnames?\b/i;
const NAMES_A_THING_NOT_A_PERSON = /\b(permit|file|document|program|record|application|template|report|folder|attachment|field|column|tab|page)\s*names?\b/i;

export function looksLikeProjectData(label: string, value: string): boolean {
  const l = String(label ?? "");
  const v = String(value ?? "").trim();
  if (!v) return false;
  // The portal's own vocabulary wins: a "Job Category" answer is the portal's word even
  // though "category" sits near words we treat as project data elsewhere.
  if (TAXONOMY_LABEL.test(l) && !PROJECT_DATA_LABEL.test(l)) return false;
  if (PROJECT_DATA_LABEL.test(l)) return true;
  // A bare "Name" is a person's until the label says it is a thing's — see the comment above.
  if (BARE_NAME_LABEL.test(l) && !NAMES_A_THING_NOT_A_PERSON.test(l)) return true;
  return UNAMBIGUOUS_PII_VALUE.test(v) || PHONE_VALUE.test(v);
}
import { rankAddressVersions } from "../addressVersion";
import { imageToPdfBytes, shouldConvertToPdf } from "../imageToPdf";
import { removeUploadStaging, uploadPayloadFor, type PreparedUpload } from "./uploadPayload";
import { attachmentTypeFor } from "./attachmentTypes";
import { exactUploadDocType, fileTypeAllowed, UPLOAD_LABEL_PATTERNS, uploadForbidsSubstitute } from "./autoLearnAdapter";
import { reviewComparison, scrapeReviewScreen as scrapeReviewScreenShared, type ReviewMismatch } from "../reviewScreenScraper";
import { sweepEmptyRequiredControls, type EmptyRequired } from "../requiredControlSweep";
import { openPortal } from "../browser";
import { selectWithFallback } from "../comboboxFill";
import {
  classifySubmissionText, finalSubmitEnvAllows, finalSubmitRefusals, isFinalSubmitControl, isPayFee, isPayNowDialogText, mayClickFinalSubmit,
  isRecipeShapeValid, isSignatureNameLabel, isSubmitIntent, isSubmitOrPayRequestUrl, PORTAL_SAFETY_GLOBAL, PORTAL_SAFETY_IN_PAGE_SOURCE, splitSignerName,
  type HealedStep, type RunApproval, type SubmissionOutcome,
} from "../../../shared/src/portalSafety";
import { commitField, installSettleProbe, waitForSettled } from "../settle";
import { siteOfUrl } from "../siteOf";
import { installFilingBackstop, withBackstopWindow, withOwnWriteWindow, describeBackstopAbort, type FilingBackstop } from "../filingBackstop";

// How long the drift precheck waits for an async-rendered form to paint before concluding
// the replay is on the wrong page. PowerClerk's Ameren form reports zero inputs for several
// seconds after its URL loads; judging it on the first DOM read failed whole runs.
const DRIFT_SETTLE_MS = Math.max(2000, Number(process.env.RECIPE_DRIFT_SETTLE_MS ?? 15000));
import { redactCaptureText, readbackMatches, detectChallengeFrame, frameSelectorFor, hasNumericValidationError, scanStatusFromBody, RETRY_BACKOFF_MS, sleep, smartWait, toBareNumber, waitForElement, waitForInteractiveControls } from "../safeAction";
import { performLogin, portalErrorPage } from "./loginFlow";
import { chooseCorrectionForm, correctionFormSelector, isRefusal, scanProjectForms, type ProjectFormRow } from "./correctionForm";
import { type ExtractedField, EXTRACT_SEL, extractFieldsInPage, toExtractedField, dismissPageModals, clearPageOverlays, equipmentMakeCandidates, pageFingerprintOf, collectValidationErrorsFrom, acaApplyEntryFrom, advanceSignatureOf } from "./autoLearnAdapter";
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
// THIS IS THE REPLAY-SIDE CLICK GATE, AND IT IS THE NARROWER OF TWO COPIES.
//
// autoLearnAdapter.ts carries its own PAY_FEE. This one guards an ACTION during an automated
// replay against a live portal - line ~2848, `if (PAY_FEE_REPLAY_GATE.test(name)) return false;` - so a word
// it fails to match is a real fee paid with the operator's money, against CLAUDE.md rule 1.
//
// Holes found by an adversarial review of the learn-side twin, all of which applied here too and
// several of which were WIDER here (this copy had no bare `fee`, no `payment`, no `remit`):
//   - "submit and pay" was listed but not the reverse order, so "Pay and Submit Application" passed
//   - there was no bare \bpayment\b, and \bpay\b cannot match "Payment" (no boundary before the m),
//     so "Submit Payment" passed
//   - "Pay Fees and Submit" passed on the plural alone
//
// Kept as a deliberate DUPLICATE rather than shared, because the two sides must be able to differ:
// the learn side classifies a control it will never click, this side gates a click that will
// really happen, and this one must be allowed to stay stricter. paymentGate.test.ts pins the
// behaviour; if you widen one copy, widen this one too and check that test.
// PURCHASE-COMMIT wording, kept at parity with the learn-side PAY_FEE: an adversarial probe of
// the terminal-page classifier recorded "Place Order" as isFinalSubmit:true, and THIS gate
// answered false for it - so the one layer that stops a real click during autoSubmit was silent
// on a control that commits an order. Narrow (a commit verb must govern "order") because this
// list halts a replay; the blunt form lives in MONEY_ANYWHERE, which only ever classifies.
//
// BARE `pay`, same probe: every alternative here governed an object ("pay fees", "pay now",
// "pay $", "pay and submit"), so "Pay", "Pay Later", "Pay by Credit Card", "Review and Pay" and
// "Confirm and Pay" ALL passed this gate. A recorded click on one of those spends the operator's
// money on replay, and SUBMIT_KEYWORDS does not cover them either (none say "submit"). `\bpay\b`
// cannot match "Payee Name" - there is no word boundary after "pay" - so MUST_ALLOW is untouched.
export const PAY_FEE_REPLAY_GATE = /\b(pay\s*(and|&)\s*submit|pay fees?|pay now|submit\s*(&|and)\s*pay|make payment|payments?|remit|invoice|pay \$|add to cart|proceed to (payment|checkout)|checkout|fees? due|purchases?|buy now|(place|submit|confirm|complete|finali[sz]e)\s+(the\s+|my\s+|your\s+)?order|pay)\b/i;
// Submit-ish keywords. A step matching these is HARD-BLOCKED in autoSubmit UNLESS it
// also carries the explicit isFinalSubmit flag — we never decide "this is the submit
// button" purely from a regex over recorded names.
const SUBMIT_KEYWORDS = /\b(submit|file application|finalize|finish|complete application|send application|confirm submission)\b/i;

// A recorded step may carry an operator/recorder-set `isFinalSubmit` flag. This field
// is not (yet) in the shared RecipeStep type, so read it structurally + type-safely.
// CARD ENTRY IS A WALL, NOT A STEP. Hard safety rule #1: automation never pays a portal
// fee. A recipe learned by a human who paid one carries their card fields, and replay used
// to walk into them and fail on page drift at the fee page -- scored as a broken recipe when
// what actually happened is the boundary working. Live: Coos Bay electrical, 53 of 62 steps,
// stopping at CapFees.aspx with "CVV:", a month list and a year list still recorded ahead.
//
// Deliberately narrow, and narrowed again once its own smoke caught it. "Contractor Licence
// Expiration Date" is on half the permit forms in this project and it is not a card, so a
// bare "expiration date" cannot qualify. A card is the one thing that splits its expiry into
// a MONTH and a YEAR -- that split, or an explicit card word, is what makes it a card.
// "Amount" and "fees due" are project costs and never match at all. Being wrong here halts a
// filing that could have continued, so this list only grows with evidence.
/** An Accela-style record number: 187-26-000309-STR. The same shape the completion-page
 *  capture already looks for, named here because a RECORDED one is a different problem: it
 *  belongs to the application the learn session created, and can never exist again. */
const RECORD_NUMBER = /\b\d{2,4}-\d{2}-\d{4,7}-?[A-Z]{0,4}\b/;

const PAYMENT_FIELD = /\bcvv\b|\bcvc\b|\bccv\b|card ?(number|no\b|#)|cardholder|name on card|security code|credit ?card|debit ?card|(card|\bcc\b|credit|debit)[a-z ]{0,12}exp|exp(iration|\.)? ?(month|year)\b/i;

function isPaymentField(step: RecipeStep): boolean {
  if (step.action !== "fill" && step.action !== "select" && step.action !== "check") return false;
  const label = `${step.note ?? ""} ${step.field ?? ""} ${step.selector?.label ?? ""} ${step.selector?.name ?? ""}`;
  return PAYMENT_FIELD.test(label);
}

/** A recorded e-signature step: the learner's own (note "e-signature: ...") or any fill whose
 *  label is the signer's-name box (portalSafety isSignatureNameLabel) — an older recipe may have
 *  one bound to whatever the planner chose. Its value is ALWAYS the client's authorized signer. */
function isSignatureStep(step: RecipeStep): boolean {
  if (/^e-signature:/i.test(String(step.note ?? ""))) return true;
  if (step.action !== "fill") return false;
  // EVERY NAME THE STEP CARRIES FOR ITS BOX, not only selector.label: the learner records an
  // id-addressed control as { css: "#consentName", fallbacks: [{ label }] }, so a recipe whose
  // signature box a planner had bound to installerContactName passed this test by its (empty)
  // top-level label and replay typed the CONTACT's name (portal-run-close kill C, red before
  // this). A css/name id reads as words ("signatureTypedNameId" -> "signature Typed Name Id").
  const sel = (step.selector ?? {}) as RecipeSelector & { fallbacks?: RecipeSelector[] };
  const words = (s: unknown): string => String(s ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[#_\-.[\]="']+/g, " ");
  const names = [sel.label, sel.placeholder, sel.name, words(sel.css), ...(sel.fallbacks ?? []).map((f) => f.label ?? f.placeholder ?? words(f.css))]
    .map((s) => String(s ?? "").trim()).filter(Boolean);
  return names.some((n) => isSignatureNameLabel(n));
}

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

// The SHAPES an open popup takes, never a portal's class names — the portal this has to
// work on is the one nobody has opened yet. Shared by the "is anything open" probe and the
// "is my target inside it" test so the two cannot disagree.
const OPEN_POPUP_SELECTOR = [
  '[role="listbox"]',
  '[aria-expanded="true"][role="combobox"]',
  '[class*="dropdown"][class*="open"]',
  '[class*="dropdown-menu"][class*="show"]',
  '[class*="select2-container--open"]',
  '[class*="datepicker"]',
  '[class*="date-picker"]',
  '[class*="calendar"][class*="open"]',
  '[class*="ui-datepicker"]',
].join(", ");

/** The one warning in this file that is a SUSPICION rather than an observation, kept as a
 *  constant because the end of the run has to be able to find it again and take it back. */
/** How long to let a portal finish taking a file before saying it has not. Generous on
 *  purpose: a plan set is megabytes and a slow AHJ afternoon is not a defect. */
/** How many blank fields ONE re-assert pass will try to put back. Was three, chosen when
 *  the case in hand had one — and Ameren's contact block carries FIVE required fields, so
 *  two of them were never attempted while the run reported all five blank. Still bounded:
 *  a page that genuinely cannot be filled must not become a loop. */
const REASSERT_MAX_FIELDS = 8;
/** How many times to go round. A portal that blanks a field on re-render can blank the
 *  re-assert too; a second pass separates "it needed saying twice" from "this block will not
 *  hold", and the second answer is worth REPORTING rather than retrying forever. */
const REASSERT_ROUNDS = 2;

const UPLOAD_ACCEPT_MS = 30000;
/** How long to let an upload indicator SHOW UP before concluding this portal has none. An
 *  uploader binds to the input's change event, so it is drawn after setInputFiles returns. */
const UPLOAD_APPEAR_MS = 3000;

const COVERED_CONTROL_WARNING =
  "a dropdown or date picker stayed open after two Escapes — the next control may have been driven while covered; verify it by eye";

/** Where replay's diagnostic captures go: REPLAY_CAPTURE_DIR, else data/ under the cwd. */
export function replayCaptureRoot(): string {
  return process.env.REPLAY_CAPTURE_DIR ? path.resolve(process.env.REPLAY_CAPTURE_DIR) : path.join(process.cwd(), "data");
}

/** Retention: a capture folder keeps its newest CAPTURE_KEEP files. */
const CAPTURE_KEEP = Math.max(20, Number(process.env.REPLAY_CAPTURE_KEEP ?? 400) || 400);
function pruneCaptureDir(dir: string): void {
  try {
    const files = fs.readdirSync(dir).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).filter((x) => Number.isFinite(x.t));
    if (files.length <= CAPTURE_KEEP) return;
    files.sort((a, b) => b.t - a.t);
    for (const old of files.slice(CAPTURE_KEEP)) fs.rmSync(path.join(dir, old.f), { force: true, recursive: true });
  } catch { /* retention is best-effort */ }
}

/** A click, press or goto the replay chokepoint (guardAction) refused. Its message is the named
 *  reason; it is never a timeout, so the retry loop does not retry it. */
export class ReplayGuardRefusal extends Error {
  constructor(public readonly reason: string) {
    super(`replay safety gate refused: ${reason}`);
    this.name = "ReplayGuardRefusal";
  }
}

/** THE APPROVED FINAL SUBMIT ENDED THE RUN — a pause for a person (a CAPTCHA/MFA challenge, a fee
 *  the portal wants paid) or a verdict (the portal refused it, or said nothing a person can trust).
 *  Typed so the step loop returns AT ONCE: never retried (the approved click is at most once, and a
 *  "Timeout" inside the click's own error text used to trip the retry-and-reload path), never
 *  healed, and a pause reaches the result as pauseReason instead of a "step failed". */
export class FinalSubmitStop extends Error {
  constructor(message: string, public readonly pauseReason: "mfa_captcha" | "fee_payment" | null) {
    super(message);
    this.name = "FinalSubmitStop";
  }
}

// THE APPROVAL'S BURN STATE AT THE BOT LAYER (portal-run-close-2 C1). The skeptic re-passed ONE
// {approver, runId} three times in one process: run 1 refused (env unset), run 2 FILED, run 3
// FILED AGAIN. Production is protected by the backend's claimRunApproval (atomic, consumed at
// claim, burned on a refusal), but any other caller of stageWithRecipe was not. A runId whose
// approved final submit was clicked — or refused at the gate while an approval was offered — is
// burned for the life of this process, and the gate refuses it after that.
//
// CHECK AND CLAIM ARE ONE SYNCHRONOUS STEP (autosubmit-close MF-C). The burn was checked in
// finalSubmitRefusalsNow(), then the click path AWAITED detectChallengeFrame, and only then burned
// the runId — two runs started together with the same {approver, runId} both passed the check
// before either burned it, and both filed (3/3). tryClaimApprovedRun is the only way onto the
// approved click: it reads and sets in one turn of the event loop, before any await, so exactly one
// of N concurrent runs holds the claim. "claimed" is a claim that has not clicked (yet — or ever: a
// CAPTCHA/MFA stop after the claim); it is never reported as a click.
export type ApprovedRunBurn = "claimed" | "clicked" | "refused";
const BURNED_APPROVED_RUNS = new Map<string, ApprovedRunBurn>();
export function burnApprovedRun(runId: string, how: "clicked" | "refused"): void {
  const id = String(runId || "").trim();
  if (!id) return;
  if (BURNED_APPROVED_RUNS.get(id) !== "clicked") BURNED_APPROVED_RUNS.set(id, how);
}
/** How this runId's approval was spent (or is held) in this process, or null. */
export function approvedRunBurn(runId: string): ApprovedRunBurn | null {
  const id = String(runId || "").trim();
  return id ? BURNED_APPROVED_RUNS.get(id) ?? null : null;
}
/** Claim this runId's approval for ONE approved final-submit click: true exactly once per runId per
 *  process (a runId already claimed, clicked or refused -> false). Synchronous on purpose — call it
 *  before any await on the click path. An empty runId can never be claimed. */
export function tryClaimApprovedRun(runId: string): boolean {
  const id = String(runId || "").trim();
  if (!id || BURNED_APPROVED_RUNS.has(id)) return false;
  BURNED_APPROVED_RUNS.set(id, "claimed");
  return true;
}
const burnWords = (b: ApprovedRunBurn): string => b === "clicked" ? "it clicked a final submit"
  : b === "claimed" ? "another run in this process claimed it for its final submit"
    : "it was refused";

/** One live progress line from a replay (options.onProgress): what the run is waiting on, never
 *  PII. index.ts StageOptions passes it through so a caller (the dashboard) can show it. */
export interface RecipeProgress {
  phase: "open" | "login" | "goto" | "step" | "wait";
  message: string;
  elapsedMs: number;
  stepIndex?: number;
}

export class RecipeAdapter extends BasePortalAdapter {
  portalName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private page: any = null;
  /** Steps repaired mid-replay by label re-anchoring (reported to the backend,
   *  which patches the recipe and requires human re-verification). */
  private healedSteps: HealedStep[] = [];
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
  /** THE ANSWER TO "IS THE INFORMATION ACTUALLY SET" — counted, not assumed.
   *
   *  The review-screen check cannot answer it on every portal: PacifiCorp's run ends on a page
   *  holding four controls, so "4 fields seen, 0 confirmed" is the scraper reading a page that
   *  is not a summary, not a scraper that is broken. But every fill already reads its value
   *  back (fillHeld) and every select already reports whether it landed. That per-field
   *  evidence was being thrown away after each step. Counting it gives the operator the thing
   *  they actually asked for: how many of this filing's values are verified present in the
   *  portal, and which are not. */
  /** Every control the portal marked REQUIRED across this run — the denominator for
   *  "is everything this permit needs present". Paired with requiredStillEmpty. */
  /** Set when replay reached a payment card field and stopped there. Reported so the
   *  scorecard can tell "we stopped where we must" from "the recipe fell over". */
  /** The page identity the last gap-fill ran against, so the end-of-run pass can tell a page
   *  that still needs one from a page that has just had one. */
  private gapFilledPage = "";
  private stoppedAtPayment = false;
  /** Set by a fill step whose control the in-page reading marks as a signature box when this
   *  client has no authorized signer: runAll pauses signature_no_signer right after it. */
  private liveSignaturePause: string | null = null;
  private requiredFieldsSeen: string[] = [];
  private fieldsVerified: string[] = [];
  private fieldsUnverified: string[] = [];
  /** Why each selector level was accepted or rejected, for the step currently resolving.
   *  Reported only when a step fails — see the note in resolveLocator. */
  private resolveTrail: string[] = [];
  /** Steps that had NOTHING TO TYPE — the project carried no value for the field.
   *
   *  Not the same failure as a fill that did not land, and until now indistinguishable:
   *  both returned false and landed in `skipped`. A live benchmark run reported eight
   *  skipped steps of which two were sensitive fields the throwaway project simply did not
   *  have (account number, meter number) and two were documents it was never given — read
   *  as recipe drift, which is the wrong person to send to fix it. A missing value is a
   *  DATA gap: real, worth reporting, and owned by whoever fills the project in. */
  private unresolvedFields: string[] = [];
  /** F1 — the kVA tier could NOT be decided from the page (no rating, two tiers, a schedule that
   *  disagrees…): set at the tier step, and the next advancing click PAUSES the run instead of
   *  clicking on into the portal's "Please select at least 1 electrical service" refusal. */
  private feeTierStop: string | null = null;
  /** The step index whose "no tier box on this page" stop is PROVISIONAL (close MF2): withdrawn only
   *  if that step then performs with a real quantity. -1 = none. */
  private feeTierProvisionalAt = -1;
  /** The tier box this run ticked, per page identity (a second recorded tier step on the same page
   *  re-decides to the same box and types nothing twice). */
  private feeTierFilled = new Map<string, string>();
  /** Wall-clock marks of the phases before the first recorded step (open, goto, login) — the part
   *  of a run the trace never covered (live run 99baa5d0 spent ~3 min there with no evidence). */
  private phaseTimings: Array<{ phase: string; ms: number; note?: string }> = [];
  /** F4 — the waits inside the CURRENT step, by name (ms), reported on a slow step. */
  private stepPhases: Record<string, number> = {};
  private async timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t = Date.now();
    try { return await fn(); } finally {
      const ms = Date.now() - t;
      if (ms >= 300) this.stepPhases[name] = (this.stepPhases[name] ?? 0) + ms;
    }
  }
  /** Where this run's page screenshots go, and how many were written. Replay only ever
   *  photographed FAILURES, so every page that filled "successfully" was invisible — and
   *  the two worst bugs of this session (the homeowner's details written into the
   *  installer's block; a required meter-photo upload left blank) were both caught by a
   *  human looking at the portal, not by anything the run reported. */
  private pageShotDir = "";
  /** The one shot that says how the filing ended — the completion page with its record
   *  number, or the portal's refusal. Reported so the submission record can point at it. */
  private outcomeShotPath = "";
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
  /** Recorded uploads this run PERFORMED: the slot's recorded label and the file name the portal
   *  was handed. The read-back for an upload (see uploadSlotsHeld). */
  private uploadsPerformed: Array<{ label: string; fileName: string; docType?: string }> = [];
  /** Doc types whose Save was followed by a list check that never showed the file (not confirmed). */
  private unconfirmedDocTypes = new Set<string>();
  /** runs-finish item 4: how many of uploadsPerformed a commit click has confirmed (or an advance left behind). */
  private uploadsSettledUpTo = 0;
  /** D7: the name the portal's reviewer sees for an owed document's upload (by docType). */
  private uploadNames = new Map<string, string>();
  /** D7: owed documents already tried this run (one row per document, never twice). */
  private owedAttempted = new Set<string>();
  /** Doc types this run actually handed to a file control (recorded uploads and owed ones). */
  private uploadedDocTypes = new Set<string>();
  /** D4 — WHAT WENT UP: every owed document's outcome this run, in the portal's own list's terms. */
  private attachmentLedger: Array<{ docType: string; label: string; status: "attached" | "already listed" | "not attached"; detail: string }> = [];
  /** runs-finish item 3: the run ended on a page NOT verified as the review page — where, in the
   *  page's own words. stopAtReview then says so instead of "staged to the review screen". */
  private stoppedBeforeReview = "";
  /** Policy-default steps whose control was absent when their turn came — re-tried once
   *  just before the page's advance, when a conditional section has had every chance to
   *  render. Cleared on each advance. */
  private pendingPolicyRetries: RecipeStep[] = [];
  private inPolicyRetry = false;
  /** Drift-precheck annotations ("this page barely matches the recipe") — surfaced
   *  in every result payload so a run that squeaked through via heals still tells
   *  the operator the portal likely changed. */
  private driftWarnings: string[] = [];
  /** THE ENGINE GOT THERE BY ANOTHER ROUTE AND THE FILING IS FINE.
   *
   *  driftWarnings was carrying four different meanings in one list -- a real defect, a
   *  human-must-look, a correct decision ("skipped Energy Storage, this project has no
   *  battery"), and a successful self-heal -- and every one of them blocked a clean score.
   *  A portal where any recorded id had gone stale could therefore never replay clean, no
   *  matter how correct the filing was, and the reliability number would have measured the
   *  engine's own rescues as failures.
   *
   *  The test is what the message means FOR THIS FILING, not how alarming it sounds. If a
   *  person would still have to open the portal and check something, it stays in
   *  driftWarnings. If the value landed and only the RECIPE is aging, it belongs here --
   *  still reported, still driving the re-record signal, but not a defect in today's work.
   *
   *  Blocking is the DEFAULT: a message is only benign once someone has established that it
   *  is. Anything unclassified stays in driftWarnings and stops the run being called clean,
   *  so a new warning that means "this filing is wrong" fails closed. */
  private agingNotes: string[] = [];
  // Set true the moment automation CLICKED the recipe's approved final submit — whatever the
  // portal said afterwards (see finalSubmitOutcome). A click whose outcome is unknown is still a
  // click: reporting it false invites a second one (the 09-02 double filing).
  finalSubmitClicked = false;
  /** What the page said after the final-submit click, read ONLY through classifySubmissionText:
   *  "accepted" needs positive evidence, a quiet page is "unknown". null = never clicked. */
  finalSubmitOutcome: SubmissionOutcome | null = null;
  /** Set before the final-submit click is attempted: a run clicks it at most once. */
  private finalSubmitAttempted = false;
  /** A native dialog we dismissed cancelled the approved click: nothing was sent (M3). */
  private finalSubmitNothingSent = false;
  /** The recipe step index the loop is on — the final-submit gate's "is this the terminal step". */
  private currentStepIdx = -1;
  /** The step whose selector resolveLocator is resolving right now (for disambiguation). */
  private resolvingStep: RecipeStep | null = null;
  /** Every click/press/goto the chokepoint refused this run, in order. */
  guardRefusals: string[] = [];
  /** How long an upload step waits for its named file slot to MOUNT (client-rendered steps show a
   *  spinner first) before it is skipped, named. Bounded: never a 30 s wait per retry. */
  static UPLOAD_SLOT_WAIT_MS = 10_000;

  constructor(
    private recipe: PortalRecipe,
    private fieldValues: Record<string, string>,
    private docsByType: Record<string, string>,
    private options: {
      autoSubmit?: boolean;
      beforeUpload?: (docType: string, file: string) => void;
      /** A named person's approval of ONE run. Absent/null → the final submit is never clicked.
       *  There is no standing per-recipe arm. */
      runApproval?: RunApproval | null;
      /** The run this replay IS. The approval must name exactly this run. */
      runId?: string;
      /** Live progress for a dashboard: every wait longer than ~10 s says what it is waiting on
       *  (F3 — the operator watched a frozen login screen for three minutes). Non-PII. */
      onProgress?: (p: RecipeProgress) => void;
      /** THE DOCUMENTS THIS FILING OWES beyond what the recording uploads (docs plan D7): the AHJ's
       *  required list for THIS track, on file, in docsByType (the backend's owedAttachmentsFor).
       *  Attached through the page's own recorded attachment row, one row per document. */
      owedAttachments?: Array<{ docType: string; label: string }>;
    } = {},
  ) {
    super();
    this.portalName = `Recipe: ${recipe.ahj || recipe.utility || recipe.profileKey} (${recipe.portalPlatform || "portal"})`;
    // A ZERO IN THE ONLY BOX WE KNOW ABOUT IS A FEE THE COUNTY WILL NOT HAVE CHARGED.
    //
    // Accela prints one text box per bracket row of the fee table and the quantity ticks
    // the row that applies. Computing that quantity per project (feeBracketQuantity:* —
    // backend/src/feeBracketFields.ts) turns a 20 kVA job's frozen, wrong "1" into a right
    // "0", which is a strict improvement — but the 15.01–25 box then needs its own "1" and
    // NO STEP EXISTS FOR IT, because the recording only ever captured the box the learn
    // project filled. Left alone that trades a wrongly-billed permit for a silently
    // UNDER-billed one, which is the same invisible failure wearing different clothes.
    //
    // So the run is flagged for human completion, on BOTH existing channels and for two
    // different readers: gapFillReport.reportedMissing is what getAutopilotState turns into
    // the review screen's banner (the screen a person already checks before approving), and
    // driftWarnings is what stops the run scoring clean — a person still has to open the
    // portal and type something, which is that list's own stated test. Computed here, in the
    // constructor, because it is pure over (recipe steps, field values) and must be reported
    // whether or not the run reaches the box.
    const coverage = feeBracketCoverage(recipe.steps, fieldValues);
    if (coverage?.uncovered) {
      const message = feeBracketCoverageMessage(coverage);
      this.gapFillReport.reportedMissing.push(message);
      this.driftWarnings.push(message);
    }
  }

  async login(context: PortalContext): Promise<PortalStepResult> {
    const tStart = Date.now();
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
      // F3 — THE PHASES BEFORE THE FIRST RECORDED STEP ARE TIMED AND REPORTED. Live run 99baa5d0
      // ran 3 min 20 s from its start to its first page shot and the result carried nothing about
      // where that went (browser open, portal goto, login); the operator watched a login screen
      // that never said what it was waiting on. Each phase is a progress line for the dashboard
      // and a number in the login step's data.
      const mark = (phase: string, started: number, note?: string) => { this.phaseTimings.push({ phase, ms: Date.now() - started, ...(note ? { note } : {}) }); };
      mark("open browser", tStart);
      this.progress("open", "Browser open — going to the portal", Date.now() - tStart);
      if (this.recipe.portalUrl) {
        const tGoto = Date.now();
        await this.withProgress("goto", "Opening the portal", () => this.guardedGoto(this.recipe.portalUrl!, "open the recipe's portal", { waitUntil: "domcontentloaded", timeout: 30000 }));
        const stuck = await this.recoverFromPortalErrorPage(this.recipe.portalUrl, "open the recipe's portal");
        await smartWait(this.page);
        mark("portal goto", tGoto, stuck ? "error page not left" : undefined);
      }

      // Log in via the shared, portal-agnostic login flow. It detects/reveals the login
      // form, fills it (known + unknown portals), verifies success, and stops on MFA.
      // When the persistent session is still valid there's no form and it's a no-op.
      // Never logs credentials.
      const tLogin = Date.now();
      const login = await this.withProgress("login", "Signing in to the portal", () => performLogin(this.page, context.credential));
      mark("login", tLogin, login.status);
      if (login.status === "mfa_captcha") {
        return { ok: false, message: login.message, pauseReason: "mfa_captcha" };
      }
      if (login.status === "no_credential") {
        return fail(`${this.portalName}: a login page is showing but no stored credential was found for this client/portal. Add the portal login under the client's logins and re-stage.`);
      }
      if (!login.ok && login.status !== "already_authenticated") {
        return fail(`${this.portalName}: ${login.message}`);
      }

      this.progress("login", "Signed in — starting the recipe", Date.now() - tStart);
      return ok(`Opened ${this.portalName}. ${login.message}`, { phaseTimings: this.phaseTimings, msToRecipeStart: Date.now() - tStart });
    } catch (err) {
      return fail(`Recipe login failed: ${err instanceof Error ? err.message : String(err)}`, { phaseTimings: this.phaseTimings });
    }
  }

  // openSubmission/uploadFiles are no-ops: the recipe replays as ONE ordered sequence
  // (navigation, fills, AND uploads interleaved exactly as recorded) inside
  // fillApplication, so multi-page portals stay in the right order.
  async openSubmission(_project: ProjectRecord): Promise<PortalStepResult> {
    return ok("Recipe replay runs as a single ordered sequence; see fill step.");
  }
  /** GAP-FILL NEVER SIGNS. On an e-signature step (portalSafety signatureStepInPage) the LLM
   *  gap-fill is skipped: it would type whichever name it chose into "type your name as consent to
   *  electronically sign". The recorded signature steps (bound to the authorized signer) are the
   *  only way a signature is typed on replay. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected override async runGapFill(page: any): Promise<void> {
    if (page && typeof page.evaluate === "function") {
      await page.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE).catch(() => null);
      const kind = await page.evaluate((g: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ps = (globalThis as any)[g];
        return ps && typeof ps.signatureStepInPage === "function" ? String(ps.signatureStepInPage().kind || "") : "";
      }, PORTAL_SAFETY_GLOBAL).catch(() => "");
      if (kind) {
        this.driftWarnings.push(`gap-fill skipped on the e-signature step (${kind}) — only the recorded signer steps sign`);
        return;
      }
    }
    return super.runGapFill(page);
  }

  /** Does the in-page reading (portalSafety signatureStepInPage — the learner's own, run fresh on
   *  this page) mark THIS control as a signer's name box (data-al-sig consent / typed)?
   *  Unreadable = false: the recorded binding stands, as before this check existed. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async liveSignatureBoxOf(scoped: any): Promise<{ part: "" | "first" | "last" } | null> {
    if (!this.page || typeof this.page.evaluate !== "function" || !scoped || typeof scoped.evaluate !== "function") return null;
    await this.page.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE).catch(() => null);
    const read = await scoped.evaluate((el: Element, g: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ps = (globalThis as any)[g];
      if (!ps || typeof ps.signatureStepInPage !== "function") return "";
      ps.signatureStepInPage();
      return `${el.getAttribute("data-al-sig") || ""}|${el.getAttribute("data-al-sig-part") || ""}`;
    }, PORTAL_SAFETY_GLOBAL, { timeout: 1500 }).catch(() => "");
    const [role, part] = String(read || "").split("|");
    if (role !== "consent" && role !== "typed") return null;
    return { part: part === "first" || part === "last" ? part : "" };
  }

  async fillApplication(project: ProjectRecord): Promise<PortalStepResult> {
    // The project is what the review screen gets checked AGAINST — see verifyReviewScreen.
    // This parameter was received and discarded, which is precisely why replay never
    // verified its own work.
    this.hookDocumentMethod();
    // THE NETWORK BACKSTOP for the whole replay (filingBackstop.ts). Installed here and REMOVED
    // before this returns: the operator submits by hand in this same page after stopAtReview
    // (armSubmitWatch), and a route left behind would abort the person's own filing.
    this.backstop = await installFilingBackstop(this.page, "replay run").catch(() => null);
    try {
      const ran = await this.runAll(project);
      // A dismissed dialog cancelled the approved click: the result says so in data too.
      const r = this.finalSubmitNothingSent ? { ...ran, data: { ...(ran.data ?? {}), finalSubmitClicked: false, finalSubmitRequestSent: false } } : ran;
      // Hand-off: the route comes off FIRST, then every abort up to that moment is counted (an
      // abort between the last check and the hand-off is not lost).
      await this.backstop?.dispose().catch(() => null);
      // AFTER THE APPROVED CLICK "Nothing was sent" is false: the filing went (or the click's own
      // request was the one aborted). Every abort is still reported, and the result says which.
      if (this.finalSubmitClicked) return this.withApprovedClickBackstopNotes(r);
      const stop = this.backstopStop();
      // A DIALOG WE DISMISSED CANCELLED THE APPROVED CLICK, AND THE PAGE POSTED ANYWAY (autosubmit-2
      // MF-S3: an alert() cannot cancel its form) — the backstop aborted that POST. The run's own
      // pause (fee_payment) and its "NOTHING was filed" stand, first; the abort is reported after.
      if (stop && this.finalSubmitNothingSent && r.pauseReason) {
        return { ...fail(`${String(r.message ?? "")} ${stop}`.trim(), { ...(r.data ?? {}), driftWarnings: this.driftWarnings, guardRefusals: this.guardRefusals }), pauseReason: r.pauseReason };
      }
      // Every abort is reported (driftWarnings + guardRefusals, pushed by backstopStop); a
      // filing/payment/lockdown abort turns ANY ending — "reached review", or a step that then
      // "did not advance" because its request was aborted — into the backstop's named failure.
      if (stop) return fail(r.ok ? stop : `${stop} (The run then reported: ${String(r.message ?? "").slice(0, 300)})`, { ...(r.data ?? {}), driftWarnings: this.driftWarnings, guardRefusals: this.guardRefusals });
      return r;
    } finally {
      await this.backstop?.dispose().catch(() => null);
      this.backstop = null;
    }
  }

  /** The approved final submit was clicked: report every backstop abort (warnings + refusals) and
   *  say on the result whether the click's own request reached the server and what else was
   *  stopped. Never turns the run into "Nothing was sent". */
  private withApprovedClickBackstopNotes(r: PortalStepResult): PortalStepResult {
    const bs = this.backstop;
    if (!bs) return r;
    this.backstopStop(); // pushes each unreported abort into driftWarnings + guardRefusals
    const notes: string[] = [];
    // WHAT WENT, IN WORDS THAT ARE TRUE (portal-run-close-2 M4). "The approved click's request"
    // only for a NAVIGATION of the clicked page (its form's submission); a fetch/XHR admitted in
    // the window is "a state-changing request in the approved window" — the backstop cannot tell
    // it was the click's own. A GET navigation is a request that reached the server too, but not a
    // state-changing one.
    // SENT MEANS THE FILING WENT (autosubmit-2 MF-S4): an admitted request counts only when it IS the
    // filing (bs.approvedAdmissions[].filing — the clicked page's main-frame form submission, or a
    // fetch / XHR to a filing-shaped endpoint). A request that merely took the approved window (a
    // same-origin analytics fetch, a subframe navigation) is named, never reported as the filing;
    // the backend then records "NO filing request reached the portal" (repository submitted_by).
    // ...and a fetch the window admitted is not the filing when the clicked page's OWN form submission
    // (a state-changing document request, not a payment) was then aborted as a filing (autosubmit-close-2
    // skeptic s4ValidateSubmit: fetch('/api/validate-submit') took the window, the form's POST was aborted).
    const formPostAborted = bs.aborts.some((x) => x.rule === "filing-url" && /^document$/i.test(String(x.resourceType || ""))
      && !/^(GET|HEAD)$/i.test(String(x.method || "")) && !/fee-payment/i.test(String(x.why || "")));
    const isFiling = (a: { filing: boolean; navigation: boolean }): boolean => a.filing && (a.navigation || !formPostAborted);
    const sent = bs.approvedAdmissions.some(isFiling) || bs.approvedNavigations.length > 0;
    for (const a of bs.approvedAdmissions) {
      if (isFiling(a)) notes.push(a.navigation ? `the approved click's request (the clicked page's form submission) went to ${a.where}` : `a state-changing request in the approved window went to ${a.where}`);
      else {
        const kind = a.navigation ? (a.mainFrame ? "navigation" : "subframe navigation") : /^(fetch|xhr)$/i.test(a.resourceType) ? "fetch/XHR" : (a.resourceType || "state-changing");
        notes.push(`the approved click's request did not reach the portal (a ${kind} request to ${a.where} took the window)`);
      }
    }
    if (!bs.approvedAdmissions.length && bs.approvedNavigations.length) {
      notes.push(`the approved click navigated the page by GET to ${bs.approvedNavigations.join(", ")} — no state-changing request was sent or admitted`);
    }
    if (!sent && !bs.approvedAdmissions.length) {
      notes.push("the approved click sent NO request the network backstop saw reach the portal (no state-changing request admitted, no navigation) — the filing request never reached the server");
    }
    const dialogs = bs.approvedDialogs.filter((d) => d.action === "accepted");
    if (dialogs.length) notes.push(`accepted the click's own ${dialogs.map((d) => `${d.type} ("${d.message.slice(0, 60)}")`).join(", ")}`);
    const others = bs.aborts;
    if (others.length) {
      notes.push(`the network backstop aborted ${others.length} other state-changing request(s) during/after it (${describeBackstopAbort(others[0])}) — only one request in the approved click's slot was admitted`);
    }
    const line = `APPROVED FINAL SUBMIT: ${notes.join("; ")}.`;
    if ((others.length || !sent) && !this.driftWarnings.includes(line)) this.driftWarnings.push(line);
    const data = {
      ...(r.data ?? {}), approvedRequests: [...bs.approvedRequests], approvedNavigations: [...bs.approvedNavigations],
      finalSubmitRequestSent: sent, backstopAborts: others.length, driftWarnings: this.driftWarnings, guardRefusals: this.guardRefusals,
    };
    return { ...r, message: `${String(r.message ?? "")} ${line}`.trim(), data };
  }

  private backstop: FilingBackstop | null = null;
  private backstopReported = 0;
  /** Record every backstop abort not yet reported; the run-stopping reason when any of them was a
   *  filing/payment request (the filing-URL rule), else "". A window abort (a dismisser click or
   *  a terminal-page Enter fired a state-changing request — often a consent XHR) is reported and
   *  the run goes on: nothing was sent. */
  private backstopStop(): string {
    const bs = this.backstop;
    if (!bs) return "";
    for (; this.backstopReported < bs.aborts.length; this.backstopReported++) {
      const line = describeBackstopAbort(bs.aborts[this.backstopReported]);
      this.guardRefusals.push(line);
      this.driftWarnings.push(line);
    }
    const stopping = bs.stoppingAborts();
    if (!stopping.length) return "";
    const first = stopping[0];
    return first.rule === "review-lockdown"
      ? `STOPPED BY THE NETWORK BACKSTOP: the page tried to send a state-changing request while the run was at review, and it was aborted — ${describeBackstopAbort(first)}. Nothing was sent. At review nothing legitimate posts until a person takes the page; a step of this recipe (or a page script) acted on the review page.`
      : `STOPPED BY THE NETWORK BACKSTOP: the page tried to file or pay with no named approval for this run, and the request was aborted — ${describeBackstopAbort(first)}. Nothing was sent. A step of this recipe (or a page script it triggered) is a filing control the word gates did not recognise; review the recipe before the next run.`;
  }

  /** The HTTP method of the request that produced the main frame's current document: "GET",
   *  "POST", or null when unknown (no listener, a fake page, nothing navigated yet). A redirect
   *  after a POST (303 -> GET) lands on a GET document. */
  //
  // THE COMMITTED DOCUMENT, NOT THE LAST REQUEST (checker close-mustfix P2). This was set on
  // every main-frame navigation REQUEST — and a link answered 204, or a download
  // (Content-Disposition: attachment), is a navigation request that never replaces the document:
  // after a POST-rendered page, such a click read "GET" and the retry loop's reload re-sent the
  // POST (bypass-reload.log: 2 POSTs). Now: only navigation RESPONSES that commit a document are
  // kept (not 204/205, not a 3xx hop, not an attachment), and the method is the one whose URL is
  // the page's current URL. A URL no committing response produced (a pushState) is unknown.
  private navDocuments: Array<{ url: string; method: string }> = [];
  private get lastDocumentMethod(): string | null {
    const here = typeof this.page?.url === "function" ? String(this.page.url() ?? "").split("#")[0] : "";
    if (!here) return null;
    for (let i = this.navDocuments.length - 1; i >= 0; i--) {
      if (this.navDocuments[i].url === here) return this.navDocuments[i].method || null;
    }
    return null;
  }
  private documentMethodHooked = false;
  private hookDocumentMethod(): void {
    const page = this.page as { on?: (ev: string, fn: (resp: unknown) => void) => void; mainFrame?: () => unknown } | null;
    if (this.documentMethodHooked || !page || typeof page.on !== "function" || typeof page.mainFrame !== "function") return;
    this.documentMethodHooked = true;
    page.on("response", (resp: unknown) => {
      try {
        const r = resp as { url: () => string; status: () => number; headers: () => Record<string, string>; request: () => { isNavigationRequest: () => boolean; frame: () => unknown; method: () => string } };
        const req = r.request();
        if (!req.isNavigationRequest() || req.frame() !== page.mainFrame!()) return;
        const status = Number(r.status());
        const cd = String((r.headers() || {})["content-disposition"] || "");
        if (status === 204 || status === 205 || (status >= 300 && status < 400) || /\battachment\b/i.test(cd)) return;
        this.navDocuments.push({ url: String(r.url() || "").split("#")[0], method: String(req.method() || "").toUpperCase() });
        if (this.navDocuments.length > 60) this.navDocuments.shift();
      } catch { /* a response we cannot read adds nothing: the method stays unknown */ }
    });
  }
  async uploadFiles(_project: ProjectRecord, _files: string[]): Promise<PortalStepResult> {
    return ok("Uploads are replayed inline within the recorded sequence.");
  }
  async stopAtReview(): Promise<PortalStepResult> {
    if (this.finalSubmitClicked) {
      const outcome = this.finalSubmitOutcome ?? { verdict: "unknown" as const, evidence: null };
      return ok(
        outcome.verdict === "accepted"
          ? `${this.portalName}: the approved final submit was clicked and the portal confirmed it (${String(outcome.evidence ?? "").slice(0, 80)}). CONFIRM the filing exists on the portal (list/record number). No fee payment was automated.`
          : `${this.portalName}: the approved final submit was CLICKED; outcome ${outcome.verdict.toUpperCase()} — human must verify on the portal before anything is clicked again.${outcome.evidence ? ` (${String(outcome.evidence).slice(0, 120)})` : ""} No fee payment was automated.`,
        { finalSubmitClicked: true, finalSubmitOutcome: outcome },
      );
    }
    // Never "staged to the review screen" for a run that did not verifiably reach it (runs-finish 3).
    if (this.stoppedBeforeReview) {
      return ok(
        `${HUMAN_REVIEW_MESSAGE} The recipe did NOT stage ${this.portalName} at its review screen — it ${this.stoppedBeforeReview} AUTOMATION HAS STOPPED.`,
        { finalSubmitClicked: false, stoppedBeforeReview: true },
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
  /**
   * Arm the still-open review page so the operator's own submit click is NOTICED. Hard
   * rule 1 is untouched — the human still clicks, this only watches — and the detector is
   * the one the learn path already uses, which distinguishes the FINAL submit from
   * mid-flow "Submit Documents" buttons.
   */
  async armSubmitWatch(onSubmitObserved: () => void): Promise<boolean> {
    if (!this.page) return false;
    return armHumanCaptureOnPage(this.page, (step) => {
      // The detector emits one submitObserved step when the final submit is clicked; every
      // other captured step belongs to the learn path and is ignored here.
      if (String(step.note || "").includes(HUMAN_SUBMIT_OBSERVED_NOTE)) onSubmitObserved();
    }).catch(() => false);
  }

  async captureSubmissionConfirmation(): Promise<PortalStepResult> {
    if (!this.page) return ok("No open page to capture confirmation from.", { permitNumber: "", recordLink: "" });
    try {
      await smartWait(this.page);
      const bodyText = String((await this.page.locator("body").innerText().catch(() => "")) || "");
      // The Accela / PowerClerk / labelled patterns live in recordNumber.ts now, because the
      // HUMAN-submit path needs the identical reading and a second copy would drift. That
      // module also carries the history: these word boundaries were once literal BACKSPACE
      // characters written through a heredoc, so the regex silently matched nothing and a
      // PowerClerk APP-###### was never read out of the page.
      const read = extractRecordNumber(bodyText);
      const permitNumber = read.value;
      // Accela record suffix encodes the discipline: -STR (structural), -ELE (electrical), etc.
      const discipline = permitNumber.match(/-([A-Z]{2,4})$/)?.[1] ?? null;
      // Keep origin+path only — completion-page URLs can embed session-scoped query tokens
      // (capId/agency/auth tickets) that would persist session material in the stored run
      // result and won't work when clicked later anyway.
      const rawUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
      let recordLink = rawUrl;
      try {
        const u = new URL(rawUrl);
        // ProjectId/ProgramId identify the record, not the session — dropping them made the
        // stored link useless (a bare /MvcProjects/EditProject reaches nothing). Same rule
        // as cleanRecordLink: keep identifiers, drop everything else.
        const KEEP = /^(projectid|programid|formid|capid1|capid2|capid3|module|tabname|agencycode|id|recordid)$/i;
        const kept = new URLSearchParams();
        u.searchParams.forEach((v, k) => { if (KEEP.test(k)) kept.append(k, v); });
        const q = kept.toString();
        recordLink = u.origin + u.pathname + (q ? `?${q}` : "");
      } catch { /* keep raw */ }
      const submitted = pageConfirmsSubmission(bodyText);
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
      await this.guardedGoto(this.recipe.portalUrl, "read-only status check");
      await this.settle(15000);
      return scanStatusFromBody(this.page, applicationNumbers);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // CORRECTION CONTINUATION — reopen the ORIGINAL suspended filing's correction form.
  //
  // A suspended filing is not re-filed, it is REOPENED (see correctionForm.ts). This is
  // the production caller of that chooser: it binds the ORIGINAL application number,
  // opens THAT filing's landing page, picks the named correction form (never the
  // cancellation form sitting beside it), clicks only the chooser's tagged control,
  // stages revised documents through the attach-time gate, and STOPS. The resubmit
  // confirmation is a human's click — this method never touches a submit control.
  //
  // Every uncertain outcome is a NEEDS-HUMAN refusal carrying what was seen, never a
  // silent no-op: an unknown must never read as fine.
  async reopenSuspendedFiling(applicationNumber: string): Promise<PortalStepResult> {
    // THE NETWORK BACKSTOP COVERS THE CORRECTION REOPEN TOO (close2-safety caveat 2: its clicks
    // ran with no backstop installed). Installed for the reopen's own clicks and REMOVED before
    // this returns — the person clicks the portal's resubmit themselves in this page. A
    // filing/payment abort turns the reopen into a named failure.
    this.backstop = await installFilingBackstop(this.page, "correction reopen").catch(() => null);
    this.backstopReported = 0;
    try {
      const r = await this.reopenSuspendedFilingImpl(applicationNumber);
      await this.backstop?.dispose().catch(() => null);
      const stop = this.backstopStop();
      if (stop) return fail(`${stop} (The reopen then reported: ${String(r.message ?? "").slice(0, 300)})`, { ...(r.data ?? {}), needsHuman: true, driftWarnings: this.driftWarnings, guardRefusals: this.guardRefusals });
      return r;
    } finally {
      await this.backstop?.dispose().catch(() => null);
      this.backstop = null;
    }
  }

  private async reopenSuspendedFilingImpl(applicationNumber: string): Promise<PortalStepResult> {
    const appNo = String(applicationNumber || "").trim();
    if (!this.page) return fail("Correction reopen: the portal is not open — login must run first.");
    if (!appNo) {
      return fail(
        "Correction reopen refused: no application number is bound for this filing. The reopen must target the ORIGINAL application — never create a new one — so it cannot run without the filing's number.",
        { needsHuman: true },
      );
    }
    try {
      await smartWait(this.page);
      // THE BOUND FILING MUST BE ON THE PAGE WE ACT ON. Scanning a page that never
      // mentions the application number means we are somewhere else entirely — refuse
      // before anything is clicked, and say where we were.
      const pageHasApp = async (): Promise<boolean> => {
        const body = String(await this.page.locator("body").innerText().catch(() => ""));
        return body.includes(appNo);
      };
      if (!(await pageHasApp())) {
        return fail(
          `Correction reopen stopped: application ${appNo} does not appear on the portal page (${String(this.page.url?.() ?? "")}). A human must locate the filing — nothing was clicked.`,
          { needsHuman: true, applicationNumber: appNo },
        );
      }

      // The applications LIST renders the number as the link into the filing; the filing's
      // own landing page shows it as plain text. Click through only when a link exists —
      // exact text first, so APP-1116 can never open APP-11168's project.
      const linkish = this.page.locator("a, [role='link']").filter({ hasText: appNo });
      const linkCount: number = await linkish.count().catch(() => 0);
      if (linkCount > 0) {
        let target = null as null | { click: (o?: { timeout?: number }) => Promise<void> };
        for (let i = 0; i < Math.min(linkCount, 25); i++) {
          const cand = linkish.nth(i);
          const t = String(await cand.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
          if (t === appNo) { target = cand; break; }
        }
        if (!target && linkCount === 1) target = linkish.first();
        if (!target && linkCount > 1) {
          return fail(
            `Correction reopen stopped: ${linkCount} links on this page contain "${appNo}" and none is an exact match — refusing to guess which opens the filing.`,
            { needsHuman: true, applicationNumber: appNo },
          );
        }
        if (target) {
          await this.guardedClick(target, "open the filing to correct", { timeout: 10_000 });
          await smartWait(this.page);
        }
      }

      // Scan the project's form list and choose BY NAME. The scan tags each row's own
      // control (data-al-cform) so the click below cannot land on an adjacent row.
      let scanFailed = false;
      const rows = await this.page.evaluate(scanProjectForms).catch(() => { scanFailed = true; return []; });
      if (scanFailed) {
        // An evaluate error is NOT "no forms" — say which it was, or a broken shim reads
        // as an empty portal (the exact failure the __name lesson records).
        return fail(
          `Correction reopen stopped: the form list on ${String(this.page.url?.() ?? "the page")} could not be scanned (in-page script failed). A human must reopen the correction form.`,
          { needsHuman: true, applicationNumber: appNo },
        );
      }
      const choice = chooseCorrectionForm(rows as ProjectFormRow[]);
      if (isRefusal(choice)) {
        return fail(
          `Correction reopen refused for ${appNo}: ${choice.why}`,
          { needsHuman: true, applicationNumber: appNo, offeredForms: choice.offered, refusalWhy: choice.why },
        );
      }

      // Click ONLY the chosen row's own tagged control — and if it does not open
      // anything, refuse and surface. Refusal beats preference at the click layer too:
      // never fall through to a second-choice row.
      const urlBefore = String(this.page.url?.() ?? "");
      const control = this.page.locator(`[data-al-cform="${choice.row.key}"]`).first();
      const clicked = await this.guardedClick(control, "open the correction form", { timeout: 10_000 }).then(() => true).catch(() => false);
      if (!clicked) {
        return fail(
          `Correction reopen stopped: the chosen form's own control ("${choice.row.name}" [${choice.row.action}]) could not be clicked. Nothing else was tried — a human must reopen it.`,
          { needsHuman: true, applicationNumber: appNo, offeredForms: rows.map((r: ProjectFormRow) => r.name) },
        );
      }
      await smartWait(this.page);
      const urlAfter = String(this.page.url?.() ?? "");
      const controlStillThere = await control.isVisible().catch(() => false);
      if (urlAfter === urlBefore && controlStillThere) {
        return fail(
          `Correction reopen stopped: clicking "${choice.row.name}" [${choice.row.action}] did not open the form (the page did not change). No other row was tried — a human must look.`,
          { needsHuman: true, applicationNumber: appNo, offeredForms: rows.map((r: ProjectFormRow) => r.name) },
        );
      }

      // The reopened wizard is showing. Stage revised documents through the SAME
      // attach-time gate replay uses (beforeUpload re-reads the project's current path +
      // selected file immediately before each attach). A gate refusal stops the attach
      // and is REPORTED — it never crashes the reopen or silently skips.
      let attachedDocs = 0;
      let attachNote = "";
      // WHAT THE SWEEP SAID, NOT JUST HOW MANY IT ATTACHED. A refused attach is reported only
      // as a drift warning; this result used to carry the count alone, so a document the
      // portal refused read as "0 document(s) staged" with no reason. Kept separate from
      // attachNote: that one means "the GATE stopped it" (attachGateStopped), this does not.
      const warningsBefore = this.driftWarnings.length;
      try {
        attachedDocs = await this.sweepUnrecordedUploads();
      } catch (err) {
        attachNote = ` Document staging stopped by the attach-time gate: ${err instanceof Error ? err.message : String(err)} — verify the documents and re-run.`;
      }
      const stagingWarnings = this.driftWarnings.slice(warningsBefore);
      const stagingNote = stagingWarnings.length ? ` Document staging notes: ${stagingWarnings.join("; ")}.` : "";

      return ok(
        `Reopened the correction form for ${appNo}: ${choice.why}. ${attachedDocs} document(s) staged through the attach-time gate.${attachNote}${stagingNote} AUTOMATION HAS STOPPED — review the reopened application and click the portal's resubmit yourself.`,
        {
          finalSubmitClicked: false,
          applicationNumber: appNo,
          reopenedForm: choice.row.name,
          reopenWhy: choice.why,
          // Recorded by NAME, never position — the same discipline the chooser documents.
          reopenSelector: correctionFormSelector(choice.row),
          attachedDocs,
          driftWarnings: stagingWarnings,
          offeredForms: rows.map((r: ProjectFormRow) => r.name),
          ...(attachNote ? { attachGateStopped: true } : {}),
        },
      );
    } catch (err) {
      return fail(`Correction reopen errored: ${err instanceof Error ? err.message : String(err)}`, { needsHuman: true, applicationNumber: appNo });
    }
  }

  // Replay every recorded step IN ORDER (uploads inline). In guided-manual mode it stops
  // permanently at the first stopForReview marker so we never proceed to the final submit.
  // In autoSubmit mode it may proceed past the marker but only to perform explicitly
  // allowlisted (isFinalSubmit) steps — everything else past the marker is hard-blocked.
  /**
   * CHECK THE REVIEW SCREEN AGAINST THE PROJECT, the way the learn does.
   *
   * scrapeReviewScreen and compareReviewFields are shared utilities whose own comment says
   * "the same logic serves all adapters" — and the replay adapter had never called either.
   * The learn verified once, at record time; every replay after it reported success on the
   * strength of that one check.
   *
   * ADVISORY, NOT A GATE. A mismatch here does not fail the run: this scraper reads
   * label/value pairs off pages it has never seen, and a false failure that blocks a correct
   * filing is worse than a warning a person reads. What it does is put the discrepancy in
   * front of the human who performs the submit, which is the moment it can still be acted on.
   * Non-throwing: a review screen it cannot read reports that, and nothing else changes.
   */
  private async verifyReviewScreen(
    project?: ProjectRecord,
  ): Promise<{ summary: string; fieldsSeen: number; confirmed: number; mismatches: ReviewMismatch[] }> {
    const none = { summary: "", fieldsSeen: 0, confirmed: 0, mismatches: [] as ReviewMismatch[] };
    if (!this.page || !project) return none;
    try {
      const fields = await scrapeReviewScreenShared(this.page);
      const body = String(await this.page.locator("body").innerText().catch(() => ""));
      // A REVIEW SCREEN WE COULD NOT READ MUST LEAVE ITS PAGE BEHIND.
      //
      // The first live replay benchmark scored PacifiCorp `replayed_clean` — 98 steps, no
      // blanks — and UNVERIFIED, because this scrape returned zero fields. That is the right
      // verdict and a useless one on its own: it says the check failed without saying what
      // the page looked like, which is another live run's worth of guessing. The scraper is
      // proven against definition lists, two-column tables and read-only inputs; whatever
      // PowerClerk renders is a fourth shape, and the only way to add it is to have it.
      if (!fields.length) {
        try {
          const dir = this.pageShotDir || path.join(replayCaptureRoot(), "replay-review-misses");
          const stamp = String(Date.now());
          // Through the sanitizer: no typed value, no digit run, every frame.
          await this.writeSanitizedCapture(dir, `review-unreadable-${stamp}`, { text: body });
          await this.page.screenshot({ path: path.join(dir, `review-unreadable-${stamp}.png`), fullPage: true }).catch(() => {});
        } catch { /* diagnostics must never change the outcome */ }
      }
      const cmp = reviewComparison(fields, project, body);
      const mismatches = cmp.mismatches;
      if (!mismatches.length) {
        // SAY WHAT WAS CONFIRMED, NOT JUST THAT NOTHING COMPLAINED. Zero mismatches on a page
        // where nothing could be compared is not a verified filing.
        return {
          summary: ` Review screen checked against the project: ${fields.length} field(s) read, ${cmp.confirmed} project value(s) confirmed present, no mismatch.`,
          fieldsSeen: fields.length, confirmed: cmp.confirmed, mismatches,
        };
      }
      const named = mismatches.slice(0, 4)
        .map((m) => `${m.field}: shows "${String(m.found).slice(0, 40)}", expected "${String(m.expected).slice(0, 40)}"`)
        .join("; ");
      return {
        summary: ` VERIFY BEFORE SUBMITTING — the review screen does not match the project on ${mismatches.length} field(s): ${named}${mismatches.length > 4 ? ", …" : ""}.`,
        fieldsSeen: fields.length,
        confirmed: cmp.confirmed,
        mismatches,
      };
    } catch {
      return none;
    }
  }

  private async runAll(project?: ProjectRecord): Promise<PortalStepResult> {
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
      if (driftFail) return fail(driftFail, { executed, skipped, healedSteps: this.healedSteps, driftWarnings: this.driftWarnings, agingNotes: this.agingNotes });
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
    const slowSteps: Array<{ i: number; action: string; note: string; ms: number; phases?: Record<string, number> }> = [];
    // Timed from the TOP of the next iteration rather than the bottom of this one: the loop
    // body has a dozen `continue` paths (skips, policy defaults, drift), and a bottom-of-loop
    // timer would silently miss exactly the steps most likely to be slow.
    let prevStart = 0;
    let prevStep: { i: number; action: string; note: string } | null = null;
    const closePrevStepTiming = (): void => {
      if (prevStep) {
        const ms = Date.now() - prevStart;
        // F4 — WHERE A SLOW STEP'S SECONDS WENT. "save new contact 75.6 s" told the operator a
        // number and nothing about which wait ate it; the phases (autosave wait, settle, gap-fill,
        // the click itself, the advance's settle ladder, the page shot…) are the answer.
        if (ms >= 4000) slowSteps.push({ ...prevStep, ms, ...(Object.keys(this.stepPhases).length ? { phases: { ...this.stepPhases } } : {}) });
      }
      this.stepPhases = {};
    };
    for (let stepIdx = 0; stepIdx < this.recipe.steps.length; stepIdx++) {
      // THE BACKSTOP ABORTED A FILING OR A PAYMENT: stop here, named. Carrying on would retry the
      // step (or reload the entry URL) and serve the same filing control again.
      {
        const bsStop = this.backstopStop();
        if (bsStop) return fail(bsStop, { executed, skipped, healedSteps: this.healedSteps, driftWarnings: this.driftWarnings, agingNotes: this.agingNotes, guardRefusals: this.guardRefusals, failedStepIndex: Math.max(0, stepIdx - 1), trace });
      }
      const recordedStep = this.recipe.steps[stepIdx];
      this.currentStepIdx = stepIdx;
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
      // Sweep before leaving a page (an advancing click) and before review: those are the
      // moments when whatever the page reveals is finally all present.
      if (step.action === "click" || step.action === "stopForReview") {
        await this.timed("upload-sweep", () => this.sweepUnrecordedUploads().catch(() => 0));
      }

      // THE E-SIGNATURE IS TYPED ONLY AS THE CLIENT'S AUTHORIZED SIGNER (operator ruling
      // 2026-09-26). A recorded signature step is bound to authorizedSignerName; when this
      // project's client names no signer there is no one to sign as — stop here, named, before
      // anything is typed. Skipping it silently would leave the portal to refuse Next with a
      // validation error the operator then has to decode.
      if (isSignatureStep(step) && step.action === "fill" && !this.resolveValue(step).trim()) {
        return {
          ...fail(`Paused at the e-signature step: this client has no authorized signer name, so there is no one the bot may sign as ("${String(step.note ?? "").slice(0, 60)}"). Add the authorized signer to the client and run again, or sign in the browser. Nothing was typed into the signature.`,
            { executed, skipped, healedSteps: this.healedSteps, driftWarnings: this.driftWarnings, agingNotes: this.agingNotes, guardRefusals: this.guardRefusals, failedStepIndex: stepIdx, trace, needsHuman: true }),
          pauseReason: "signature_no_signer",
        };
      }

      // STOP AT THE CARD, EVERY TIME, IN EVERY MODE. Not a skip: the steps after this one are
      // the rest of the payment form, and walking through them to "see how far we get" is
      // walking into a checkout. The filing is staged and a person pays and submits — the
      // same handoff the final submit gets, at the boundary that comes before it.
      if (isPaymentField(step)) {
        this.stoppedAtPayment = true;
        for (let k = stepIdx; k < this.recipe.steps.length; k++) {
          const rest = this.recipe.steps[k];
          skipped.push(`payment: ${String(rest.note ?? rest.field ?? rest.action).slice(0, 44)} (recorded, NOT entered)`);
        }
        await this.runGapFill(this.page);
        this.gapFilledPage = await this.pageIdentity().catch(() => "");
        break;
      }

      // THE RECORDED FINAL SUBMIT IS WHERE A GUIDED RUN ENDS. A learn records the filing click
      // as a flagged step (often with no stopForReview before it). When the gate refuses it — no
      // approval for this run, the env switch off, an invalid shape — that is the review stop
      // doing its job, not a step that failed: stop here exactly as stopForReview does, and say
      // why in the report. (Counted as a "skipped" step it made every correct run read as
      // incomplete.)
      if (isFinalSubmitStep(step) && !pastReview) {
        const refusals = this.finalSubmitRefusalsNow();
        if (refusals.length) {
          this.agingNotes.push(`final submit left for a human (not clicked: ${refusals.join("; ")})`);
          await this.runGapFill(this.page);
          this.gapFilledPage = await this.pageIdentity().catch(() => "");
          break;
        }
      }
      if (step.action === "stopForReview") {
        if (!this.options.autoSubmit) {
          // Gap-fill the LAST data section once more before review: it is not followed by an
          // advancing click, so any required field the recipe missed (selector drift / a newly
          // added field) would otherwise reach review blank. No-op when gap-fill is not enabled.
          await this.runGapFill(this.page);
          this.gapFilledPage = await this.pageIdentity().catch(() => "");
          break;
        }
        // Past review only toward an APPROVED final submit: every state-changing request is now
        // aborted except inside THE approved click's window (filingBackstop.ts).
        this.backstop?.lockReview(`replay stopForReview before the approved final submit (${this.recipe.id})`);
        pastReview = true;
        continue;
      }

      // F1 — THE kVA TIER COULD NOT BE DECIDED: never click on into the portal's refusal. Checked
      // BEFORE the autosave wait, the settle and the LLM gap-fill (which would otherwise get a shot
      // at the tier box with no AC size — the guess this exists to forbid). The run pauses for a
      // person with the reason named; a headed run keeps its window (runAdapter: a step pause).
      if (this.feeTierStop && step.action === "click" && this.isAdvancingClick(step)) {
        closePrevStepTiming();
        const why = this.feeTierStop;
        await this.capturePageShot("FEE-TIER-UNDECIDED", true).catch(() => null);
        return {
          ...fail(`Paused before "${String(step.note ?? "the advance").slice(0, 44)}": the electrical services page needs one service line ticked and the kVA tier could not be decided: ${why}. Nothing was clicked — tick the tier box in the browser (or add the system's AC size to the project and re-stage) and continue from there.`,
            { executed, skipped, healedSteps: this.healedSteps, driftWarnings: this.driftWarnings, agingNotes: this.agingNotes, guardRefusals: this.guardRefusals, failedStepIndex: stepIdx, trace, slowSteps, needsHuman: true, unresolvedFields: this.unresolvedFields, fieldsVerified: this.fieldsVerified, fieldsUnverified: this.fieldsUnverified, requiredFieldsSeen: this.requiredFieldsSeen, pageShotDir: this.pageShotDir, outcomeShotPath: this.outcomeShotPath }),
          pauseReason: "fee_tier_undecided",
        };
      }
      // Never advance while the portal is still saving — the commit signal is exact.
      if (step.action === "click") await this.timed("autosave-wait", () => this.waitForAutosaveCommitted());
      // Nor while its loading mask is up ("Please wait..."): a click under it lands nowhere (runs-finish item 4).
      if (step.action === "click") await this.timed("overlay-wait", () => this.waitForLoadingMaskClear(`"${String(step.note ?? "the click").slice(0, 50)}"`));
      // PERSIST SETTLE before an advancing click. PowerClerk autosaves each page (~3s) and
      // only commits fields on blur; advancing too soon saves a BLANK draft. If the prior
      // steps filled fields, wait for the autosave to settle before this click.
      if (step.action === "click" && prevWasInput) {
        await this.timed("persist-settle", () => this.settle(8000));
        // Number.isFinite (not ||) so an explicit AUTOLEARN_SAVE_SETTLE_MS=0 disables the wait.
        //
        // THE PORTAL'S OWN COMMIT SIGNAL BEATS A GUESSED SLEEP. When the page carries an
        // autosave indicator (PowerClerk's data-test-role project-save-state), "Saved" IS the
        // settle — waiting a further fixed 3s after the platform said committed was pure tax,
        // and this sleep was the single largest fixed cost in a replay (~3s x every advancing
        // click after a fill ≈ 30s/run, measured). No indicator on the page = the guessed sleep
        // stands in full, because there is nothing exact to wait on.
        const indicatorCommitted = await this.autosaveIndicatorCommitted();
        const settleMs = Number(process.env.AUTOLEARN_SAVE_SETTLE_MS);
        await this.timed("persist-sleep", () => sleep(Number.isFinite(settleMs) ? settleMs : indicatorCommitted ? 300 : 3000));
        // Now that the recipe's fills have committed (blurred + autosaved), let the LLM gap-fill
        // any REQUIRED field the recipe didn't cover — from real project data only. Run it AFTER
        // the persist-settle so the LLM reads a stable page; the advancing click that follows is
        // the commit window for the gap-filled values. No-op when gap-fill is not enabled.
        await this.timed("gap-fill", () => this.withProgress("wait", "Checking the page for required fields the recipe missed", () => this.runGapFill(this.page), stepIdx));
        this.gapFilledPage = await this.pageIdentity().catch(() => "");
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
      // A CHECKBOX IS A CLICK. This gate listed click and goto, and an announcement modal
      // does not care which verb we call it: it intercepts the pointer either way. Live in
      // the reliability sweep, Ameren Illinois stopped after 2 of 75 steps because
      // PowerClerk's "What's new?" popover — the exact overlay this line exists to clear —
      // sat over the Terms and Conditions checkbox, and a `check` step never reached the
      // clearing pass. It is a FIRST-RUN artifact, and per-portal browser profiles mean
      // every portal now gets a first run.
      if (step.action === "click" || step.action === "goto" || step.action === "check" || step.action === "uncheck") {
        await this.dismissModalsGuarded();
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
        // A FIELD WE FILLED THAT HAS SINCE GONE BLANK IS A RE-RENDER, NOT A MISSING VALUE.
        //
        // Coos Bay's electrical recipe fills "*Other Category of Construction" and reports
        // success — nothing skipped — and the sweep at this advance finds it EMPTY. A
        // conditional control that appears when its parent is answered is also re-created
        // when anything re-renders it, and the value goes with it. The recorded step for it
        // ran twenty steps earlier and cannot know.
        //
        // The array held-check already does this for equipment rows; this is the same idea
        // for any control: before advancing, re-run the recorded step for anything blank that
        // we have a step for. Bounded to three, once, so a page that genuinely cannot be
        // filled does not loop — and reported, because a value that needs re-asserting is a
        // portal quirk the operator should know about.
        const blanks = await this.timed("reassert-blanks", () => this.reassertBlanksOnce(pastReview));
        // WHICH PAGE IT WAS BLANK ON. "Name, Company, Address, Email, Phone" told an operator
        // five field names and nothing about where to look — and those five labels repeat
        // across a wizard's contact blocks, so the list could not distinguish "the customer
        // block we filled came back empty" from "there is a second block nobody recorded".
        // Ameren's five blanks were unreadable for exactly that reason, through a full sweep
        // and two pilots. A field name without a page is half a bug report.
        {
          const where = await currentPageLabel();
          for (const label of blanks) {
            const named = where ? `${label} [${where}]` : label;
            if (!this.requiredStillEmpty.includes(named)) this.requiredStillEmpty.push(named);
          }
        }
        // PHOTOGRAPH THE FINISHED PAGE. Same moment as the sweep above: everything the
        // recipe will put on this page is on it, and the next click leaves it for good.
        await this.timed("page-shot", async () => this.capturePageShot(await currentPageLabel()));
      }

      let lastErr: unknown;
      // Context from the FIRST failure. The retry path RELOADS the page, and a portal that
      // reloads to its first wizard page (PowerClerk does) then shows a screenshot of the
      // start of the form for a step that failed two-thirds of the way in — evidence that
      // points at entirely the wrong problem. Capture before any reload can rewrite it.
      let failureContext = "";
      let succeeded = false;
      // SUCCEEDED AND PERFORMED ARE NOT THE SAME THING. A step whose selector resolves to
      // nothing returns false, is recorded as SKIPPED, and sets succeeded=true — it did not
      // throw, so there is nothing to retry. The address-row fallback keyed on !succeeded
      // therefore never ran for a skip, only for an exhausted timeout, which is Accela's
      // shape and not the generic one: the generic pass records a marker selector that
      // deliberately cannot resolve at replay, precisely so the matcher gets its turn.
      let performed = false;
      for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
        if (attempt > 0) {
          const bsStop = this.backstopStop();
          if (bsStop) return fail(bsStop, { executed, skipped, healedSteps: this.healedSteps, driftWarnings: this.driftWarnings, agingNotes: this.agingNotes, guardRefusals: this.guardRefusals, failedStepIndex: stepIdx, trace });
        }
        try {
          const done = await this.timed("execute", () => this.withProgress("step", `Step ${stepIdx + 1}/${this.recipe.steps.length}: ${String(step.note ?? step.action).slice(0, 60)}`, () => this.executeStep(step, pastReview), stepIdx));
          if (this.liveSignaturePause !== null) {
            const what = this.liveSignaturePause;
            this.liveSignaturePause = null;
            return {
              ...fail(`Paused at the e-signature step: this client has no authorized signer name, so there is no one the bot may sign as ("${what}"). Add the authorized signer to the client and run again, or sign in the browser. Nothing was typed into the signature.`,
                { executed, skipped, healedSteps: this.healedSteps, driftWarnings: this.driftWarnings, agingNotes: this.agingNotes, guardRefusals: this.guardRefusals, failedStepIndex: stepIdx, trace, needsHuman: true }),
              pauseReason: "signature_no_signer",
            };
          }
          if (done) executed++;
          else skipped.push(String(step.note || step.action).slice(0, 70));
          performed = done;
          // close MF2: a tier step that found no kVA box on its page stands under a provisional
          // stop; it is withdrawn only here, when that very step typed its real quantity.
          if (done && this.feeTierProvisionalAt === stepIdx && this.feeTierStop === FEE_TIER_NO_BOX_REASON) {
            this.feeTierStop = null;
            this.feeTierProvisionalAt = -1;
            this.driftWarnings = this.driftWarnings.filter((m) => !m.startsWith(`kVA tier: ${FEE_TIER_NO_BOX_REASON}`));
          }
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
          if (err instanceof FinalSubmitStop) {
            closePrevStepTiming();
            const base = fail(err.pauseReason ? err.message : `Recipe step failed (${step.action}${step.note ? ` — ${step.note}` : ""}): ${err.message}`,
              { executed, skipped, healedSteps: this.healedSteps, driftWarnings: this.driftWarnings, agingNotes: this.agingNotes, guardRefusals: this.guardRefusals, failedStepIndex: stepIdx, trace, slowSteps, finalSubmitClicked: this.finalSubmitClicked, ...(err.pauseReason ? { needsHuman: true } : {}), pageShotDir: this.pageShotDir, outcomeShotPath: this.outcomeShotPath });
            return err.pauseReason ? { ...base, pauseReason: err.pauseReason } : base;
          }
          if (!failureContext) failureContext = await this.timed("failure-context", () => this.captureFailureContext(step, stepIdx).catch(() => ""));
          const isTimeout = err instanceof Error && /timeout|TimeoutError/i.test(err.message);
          // A STRICT-MODE VIOLATION IS ALWAYS WORTH ONE MORE PASS, and it is not a timeout.
          //
          // Coos Bay's street number resolved to ONE element when the step narrowed it and to
          // FOUR by the time the fill ran — Accela renders that address panel asynchronously,
          // which the drift precheck already documents as reporting zero inputs for seconds.
          // The narrowing was right for the DOM it saw and stale for the DOM it was used on.
          // Retrying re-resolves against a settled page, where narrowing sees all four and
          // picks one; breaking out instead turned a timing artefact into a dead recipe.
          const isAmbiguous = err instanceof Error && /strict mode violation/i.test(err.message);
          if ((!isTimeout && !isAmbiguous) || attempt >= RETRY_BACKOFF_MS.length) break;
          // NEVER RETRY — AND NEVER RELOAD — ON THE REVIEW PAGE. A control that is missing there
          // belongs to a page this portal does not have (the recipe is longer than the portal),
          // so waiting cannot produce it, and a reload of a review page is the last thing a
          // replay should do to it. Measured: three backoffs and reloads per missing upload slot
          // put the one-page-fewer replays past 200 s, on a page that had already been reached.
          {
            const here = await this.pageSafetyContext();
            if (here.reviewPage === true) {
              this.driftWarnings.push(`"${String(step.note ?? step.action).slice(0, 44)}" is not on this page, and this page is the portal's REVIEW page — the recipe expects a page this portal does not have; not retried`);
              break;
            }
          }
          if (isAmbiguous) {
            this.agingNotes.push(
              `"${String(step.note ?? step.action).slice(0, 40)}" matched several controls by the time it was acted on — the page was still rendering; retried against the settled page`,
            );
          }
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
          // FOUR MATCHES IS PROOF THE CONTROL IS THERE. This guard asks whether the step's
          // LABEL is on the page and stops retrying when it is not — sound for a control the
          // portal never rendered, and exactly wrong after a strict-mode violation, which can
          // only happen when SEVERAL of the thing matched. Coos Bay's street number was
          // declared absent immediately after four of it were found.
          if (DATA_ACTIONS.has(step.action) && !isAmbiguous) {
            const want = String(step.note || step.selector?.label || step.selector?.name || "").trim();
            if (want.length >= 3 && (await this.labelPresentOnPage(want)) === false) {
              this.driftWarnings.push(`"${want.slice(0, 44)}" is not on this page — stopped retrying rather than reloading (a reload sends PowerClerk back to page 1)`);
              break;
            }
          }
          await sleep(RETRY_BACKOFF_MS[attempt]);
          // A LOGIN REDIRECT CAN STEAL THE PAGE THE RECIPE STARTED FROM, AND RELOADING
          // WHEREVER WE LANDED CANNOT GET IT BACK.
          //
          // Both Coos Bay recipes died on their FIRST real step — `click application entry:
          // Apply`, a 30s timeout — and the failure screenshot shows why: Oregon
          // ePermitting's home dashboard, logged in, with no Apply control on it. The
          // recipe's goto had gone to the entry URL and the authenticated session bounced
          // to Home. Reloading Home forever cannot produce an Apply link; returning to the
          // URL the recipe recorded can.
          //
          // Bounded to the START of the run, because after the entry step a recipe is
          // SUPPOSED to have navigated away and going back would undo its own progress.
          // An ambiguity is a timing problem, not a stale-page one: settle, do not reload.
          if (isAmbiguous) { await this.settle(8000); continue; }
          const entryUrl = String(this.recipe.steps.find((s) => s.action === "goto")?.value || "");
          const here = String(this.page.url?.() ?? "");
          if (entryUrl && executed <= 1 && here && !here.startsWith(entryUrl)) {
            this.driftWarnings.push(
              `the session landed on ${here.slice(0, 60)} rather than the recipe's entry URL — returned there before retrying (commonly a login redirect)`,
            );
            await this.guardedGoto(entryUrl, "return to the recipe's entry URL after a login redirect", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
            await this.settle(8000);
          } else {
            // Reload on timeout retries to recover from stale page state — only a document that
            // a GET produced (guardedReload refuses to re-send a POST).
            await this.guardedReload("retry a timed-out step on a fresh copy of the page").catch(() => null);
            await this.settle(8000);
          }
          // A reload can bring the announcement/cookie banner straight back, and a timeout
          // is the signature of a covered target — clear both before spending the next
          // attempt. clearOverlays is the generic breaker for portals we have no selector
          // for; dismissModals handles the ones we do.
          await this.dismissModalsGuarded();
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
      // "work location: … address row" is Accela's wording; "address row:" is what the
      // generic results-row pass records on any portal. Both mean the same thing: find the
      // row for THIS project's address, not the one the recipe was learned on.
      if (!performed && /(work location:.*address row|\baddress row:)/i.test(String(step.note ?? ""))) {
        if (await this.pickAddressRowForProject(step)) { executed++; succeeded = true; }
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
        // The recipe's own entry URL carries the module (Lee: Permitting) and marks the portal
        // as ACA even on a custom domain (Columbus: portal.columbus.gov/permits) — B5/B8.
        const entryUrl = String(this.recipe.steps.find((s) => s.action === "goto" && s.value)?.value ?? this.recipe.portalUrl ?? "");
        const recordedOnAca = /accela/i.test(String(this.recipe.portalPlatform ?? ""))
          || this.recipe.steps.some((s) => s.action === "goto" && /\/Cap\/Cap\w+\.aspx/i.test(String(s.value ?? "")));
        const entry = acaApplyEntryFrom(here, { entryUrl, aca: recordedOnAca });
        if (entry) {
          const went = await this.guardedGoto(entry, "re-enter the Accela Apply flow", { waitUntil: "domcontentloaded", timeout: 30000 })
            .then(() => true).catch(() => false);
          if (went) {
            await waitForInteractiveControls(this.page);
            this.driftWarnings.push(`recorded application link was not on ${here.split("/").pop()} — re-entered the Apply flow directly`);
            executed++;
            succeeded = true;
          }
        }
      }
      // NEVER HEAL A PERMIT TYPE. Heal re-anchors a missed step onto the best label match on
      // the page, and "Residential - Electrical" scores high against "Residential -
      // Mechanical" — the same wrong permit the guard above just refused, arriving through a
      // second door, and this one PATCHES THE RECIPE with it. If the type isn't offered, the
      // answer is a different jurisdiction, not a different permit.
      // NEVER HEAL A kVA TIER BOX either (close MF2): heal re-anchors by label score, and "5.01kva
      // through 15kva" scores high against "15.01kva through 25kva" — a tier row must never hop to
      // its neighbour by similarity. The tier is decided from the page's labels or not at all.
      if (!succeeded && !step.isFinalSubmit && !this.isRecordTypeStep(step) && !this.isFeeTierStep(step) && this.arrayPass === 1 && process.env.RECIPE_SELF_HEAL !== "off") {
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
        const heal = await this.healSelectorForStep(step).catch(() => null);
        if (heal && "ambiguous" in heal) {
          // A named refusal, not a guess: the step fails below with the ambiguity as its reason.
          lastErr = new Error(heal.ambiguous);
        } else if (heal) {
          const healedSelector = heal;
          try {
            const healedStep: RecipeStep = { ...step, selector: { ...healedSelector, fallbacks: [...(step.selector ? [step.selector] : []), ...(healedSelector.fallbacks ?? [])] } };
            const done = await this.executeStep(healedStep, pastReview);
            if (done) {
              executed++;
              // A HEAL IS REPORTED ONLY WHEN THE HEALED STEP PERFORMED, and it is identified by
              // step index + recipe version — never by (note, action), which several steps of
              // one recipe share (19 of 79 production recipes). A heal that resolved but never
              // acted must not patch the recipe.
              this.healedSteps.push({
                stepIndex: stepIdx, recipeVersion: Number(this.recipe.version ?? 0),
                note: step.note || step.action, action: step.action, selector: healedSelector, performed: true,
              });
            } else skipped.push(String(step.note || step.action).slice(0, 70));
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
        // WHY did the control disappear? A step timeout on a page the portal has replaced
        // with "Session Ended" is not a selector problem, and reporting it as one sends the
        // operator chasing drift. Live: a NEM replay's "meter number" fill timed out because
        // the operator logged in concurrently and PowerClerk — one session per account —
        // killed the bot's. Name the real event when the page itself announces it.
        const ended = await this.sessionEndedBanner();
        return fail(`${ended ? `THE PORTAL ENDED THIS SESSION mid-run ("${ended}") — commonly a concurrent login with the same account (some portals allow exactly one session per user). The step failure below is the symptom, not the cause. ` : ""}Recipe step failed (${step.action}${step.note ? ` — ${step.note}` : ""}): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}${context}`, { executed, skipped, healedSteps: this.healedSteps, driftWarnings: this.driftWarnings, agingNotes: this.agingNotes, failedStepIndex: stepIdx, trace, slowSteps, requiredStillEmpty: this.requiredStillEmpty, unresolvedFields: this.unresolvedFields, fieldsVerified: this.fieldsVerified, fieldsUnverified: this.fieldsUnverified, requiredFieldsSeen: this.requiredFieldsSeen, stoppedAtPayment: this.stoppedAtPayment, pageShotDir: this.pageShotDir, outcomeShotPath: this.outcomeShotPath });
      }
      // A COMMIT CLICK AFTER THIS PAGE'S UPLOADS (the attachment Save): the page must LIST the file
      // before the run moves on (runs-finish item 4). An advance leaves the page's uploads behind.
      if (performed && step.action === "click" && this.uploadsPerformed.length > this.uploadsSettledUpTo) {
        const said = `${String(step.note ?? "")} ${String(step.selector?.name ?? step.selector?.text ?? "")}`;
        if (/^advance\b/i.test(String(step.note ?? ""))) this.uploadsSettledUpTo = this.uploadsPerformed.length;
        else if (/\b(save|upload|attach|commit)/i.test(said)) {
          // Only a LEARNER-STAMPED attachment Save is a place the committed list is known to show the
          // file; any other save-worded click (a form's "Save and continue", a portal with no list
          // grid) gets a warning, never the final-submit refusal (skeptic eb36a8f N1).
          const stampedRow = this.recordedAttachmentRow(stepIdx);
          await this.timed("upload-commit", () => this.confirmUploadsListed(`"${String(step.note ?? "the save").slice(0, 50)}"`, !!stampedRow));
          // THE DOCUMENTS THE FILING OWES (docs plan D7): the same recorded row takes each owed
          // document the recording never uploaded — one row per document, then this same commit.
          const row = !pastReview ? stampedRow : null;
          if (row) await this.timed("owed-attachments", () => this.attachOwedDocuments(row, step));
        }
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
            // THE PORTAL'S OWN ADVANCE, AS THE RECIPE NAMES IT: the advance step that just ran
            // ("Next" on PowerClerk and SPAs), else Accela's "Continue Application".
            const advName = String(step.selector?.name || step.selector?.text || "").trim();
            const byRecipe = advName && /^advance\b/i.test(String(step.note ?? ""))
              ? this.page.getByRole(step.selector?.role === "link" ? "link" : "button", { name: advName, exact: true })
              : null;
            const cont = byRecipe && (await byRecipe.count().catch(() => 0)) > 0
              ? byRecipe.first()
              : this.page.getByRole("link", { name: /continue application/i }).first();
            const has = await cont.count().catch(() => 0);
            if (!has) break;
            // THROUGH THE CHOKEPOINT, AS A PASS-THROUGH. A read-only page with nothing to fill
            // is exactly what a review page is too, and there this link FILES. The gate refuses
            // a pass-through click-through on any terminal page, whatever the link says.
            try {
              await this.guardedClick(cont, "drift-seek click-through of a page with nothing to fill", { timeout: 8000 }, { passThrough: true });
            } catch (err) {
              if (err instanceof ReplayGuardRefusal) {
                driftFail = `${driftFail} — and the page it landed on is TERMINAL: ${err.reason}. Stopped without clicking; the recipe expects a page this portal does not have.`;
                break;
              }
              // A click that merely timed out is the old behaviour: carry on and re-check.
            }
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
          return fail(`${driftFail}${driftContext}`, { executed, skipped, healedSteps: this.healedSteps, driftWarnings: this.driftWarnings, agingNotes: this.agingNotes, failedStepIndex: stepIdx, trace, slowSteps, requiredStillEmpty: this.requiredStillEmpty, unresolvedFields: this.unresolvedFields, fieldsVerified: this.fieldsVerified, fieldsUnverified: this.fieldsUnverified, requiredFieldsSeen: this.requiredFieldsSeen, stoppedAtPayment: this.stoppedAtPayment, pageShotDir: this.pageShotDir, outcomeShotPath: this.outcomeShotPath });
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
      // AFTER every measurement this path will ever collect, never before one. See below.
      this.dischargeCoveredWarning();
      return ok(`Replayed ${executed} recorded step(s) and clicked the approved final submit.`, {
        executed, skipped, finalSubmitClicked: true,
        permitNumber: capture.data?.permitNumber || "",
        confirmationNumber: capture.data?.confirmationNumber || "",
        recordLink: capture.data?.recordLink || "",
        // What the LLM gap-fill added (and what it left blank for lack of real data) — same key
        // the hand-coded adapters surface, so the operator/UI sees a uniform report.
        gapFill: this.gapFillReport, healedSteps: this.healedSteps, driftWarnings: this.driftWarnings, agingNotes: this.agingNotes, slowSteps, requiredStillEmpty: this.requiredStillEmpty, unresolvedFields: this.unresolvedFields, fieldsVerified: this.fieldsVerified, fieldsUnverified: this.fieldsUnverified, requiredFieldsSeen: this.requiredFieldsSeen, stoppedAtPayment: this.stoppedAtPayment, pageShotDir: this.pageShotDir, outcomeShotPath: this.outcomeShotPath,
      });
    }
    closePrevStepTiming();
    // READ BACK WHAT THE PORTAL NOW SHOWS. Until this existed, a replay reported
    // "Replayed 98 recorded step(s)" without once looking at the result — the LEARN verified
    // its review screen against project data (that is what earns a recipe its trust) and the
    // REPLAY, which runs on every subsequent filing, never did. A recipe verified once in
    // August then replayed forever on the strength of that single check, so a drifted
    // selector writing the homeowner's name into a contractor field, or a value that failed
    // to commit, produced a clean success. The only thing standing between that and a wrong
    // filing was a person noticing by eye.
    // SWEEP THE PAGE THE RUN ACTUALLY ENDS ON. The blank sweep above is attached to
    // ADVANCING clicks, which means the one page it never covers is the last one — the
    // page the run stops on and hands to a human. A live PacifiCorp replay ended on an
    // equipment page with an empty required model select and an empty required
    // "Total System Export (kW)", both flagged in red by the portal, and reported
    // `requiredStillEmpty: []` because no advancing click ever followed them.
    // AND RE-ASSERT ON IT, exactly as every earlier page gets. The re-render fix above is
    // attached to ADVANCING clicks, so the one page it never reaches is the last one — the
    // page the run stops on and hands to a human. Live on Ameren Illinois: Name, Company,
    // Address, Email and Phone were each filled, blanked by a re-render, re-asserted on the
    // way out of earlier pages, and then left blank on the final page because no advance
    // ever followed them. Five required fields, on the page a person is asked to check.
    // Nothing here clicks; it only re-fills values the run already decided.
    await this.reassertBlanksOnce(false);
    // AND GAP-FILL IT, for the same reason and in the right order. Re-asserting can only put
    // back a value the recipe already knows how to write; it cannot fill a required field the
    // recipe has no step for at all. Live on Ameren Illinois: Name, Company, Address, Email
    // and Phone came back blank on all three attempts, and the notes show the re-assert
    // working perfectly on the pages BEFORE this one — those five belong to a section the
    // recipe never recorded, which is precisely what gap-fill exists to cover.
    //
    // Every other page in the run gets this before its advancing click. The last page got
    // neither pass, and it is the one a person is handed. Re-assert first (cheap, exact),
    // gap-fill second (fills what remains from real project data), then sweep and report.
    // ...but ONLY IF THIS PAGE HAS NOT JUST HAD ONE. Gap-fill costs an LLM call, and both
    // paths that end a run (the review halt, and the payment stop) already gap-fill the page
    // they stop on. Firing again on the same page would buy nothing and pay twice; the case
    // this is here for is the OTHER ending — a run that simply reaches its last recorded step
    // on a page no advancing click ever followed, which is where Ameren's five blanks live.
    // The condition is deliberately the strict one: run only when the page can be identified
    // AND differs from the one last gap-filled. "I could not tell" is not a reason to spend
    // an LLM call — and on a page whose identity cannot even be read, a planner would have
    // nothing coherent to read either.
    const endPage = await this.pageIdentity().catch(() => "");
    if (endPage && endPage !== this.gapFilledPage) {
      await this.runGapFill(this.page).catch(() => null);
      this.gapFilledPage = endPage;
    }
    {
      const where = await this.pageLabelNow();
      for (const label of await this.emptyRequiredControls()) {
        const named = where ? `${label} [${where}]` : label;
        if (!this.requiredStillEmpty.includes(named)) this.requiredStillEmpty.push(named);
      }
    }
    // ONLY NOW. The sweep directly above is the last thing that can add a blank, and a
    // discharge that ran before it would be deciding on evidence that had not finished
    // arriving — reading requiredStillEmpty as empty a moment before the final page filled
    // it in. An earlier draft of this call sat above that loop and would have withdrawn the
    // warning on exactly the page the warning was about.
    this.dischargeCoveredWarning();
    // D4: every owed document has an outcome — an owed one no attachment row carried is named.
    this.settleOwedLedger();
    // THE REVIEW-PAGE LOCKDOWN (filingBackstop.ts): the run's last write to the page (the final
    // re-assert and gap-fill above, which a portal autosaves on blur) is done. From here until
    // fillApplication hands the page to a person (dispose), every state-changing request is
    // aborted and stops the run, named.
    this.backstop?.lockReview(`replay stopped at review (${this.recipe.id})`);
    const review = await this.verifyReviewScreen(project);
    const data = {
      executed, skipped, finalSubmitClicked: false, gapFill: this.gapFillReport,
      healedSteps: this.healedSteps, driftWarnings: this.driftWarnings, agingNotes: this.agingNotes, slowSteps,
      requiredStillEmpty: this.requiredStillEmpty, unresolvedFields: this.unresolvedFields, fieldsVerified: this.fieldsVerified, fieldsUnverified: this.fieldsUnverified, requiredFieldsSeen: this.requiredFieldsSeen, stoppedAtPayment: this.stoppedAtPayment, pageShotDir: this.pageShotDir,
      outcomeShotPath: this.outcomeShotPath,
      reviewFieldsSeen: review.fieldsSeen, reviewFieldsConfirmed: review.confirmed, reviewMismatches: review.mismatches,
      attachmentLedger: this.attachmentLedger,
    };
    // HONEST STATUS (runs-finish item 3). Live run 191e45c8 said "stopped at review" on Accela's
    // attachments page with 0 of 5 project values found, and was recorded ready-to-submit. A run
    // that ends on a page the shared reading says is NOT the review page, showing none of the
    // project's values, pauses for a person, named — never "staged to the review screen".
    const stop = !pastReview && !this.stoppedAtPayment ? await this.whereTheRunStopped(review.confirmed) : null;
    if (stop) {
      this.stoppedBeforeReview = stop.message;
      return { ...ok(`Replayed ${executed} recorded step(s); ${stop.message}${review.summary}`, { ...data, stoppedBeforeReview: stop.where }), pauseReason: "stopped_before_review" };
    }
    return ok(`Replayed ${executed} recorded step(s); stopped at review.${review.summary}`, data);
  }

  /** WHERE DID THE RUN STOP, IF NOT AT REVIEW? (runs-finish item 3, the part that needs no wizard-
   *  step reading.) null = at review, or cannot tell: the review check found this project's values
   *  on the page, or the shared reading (terminalPageInPage, the backstop's own question) does not
   *  say "not review" — a page that cannot be read (a unit-test double) keeps today's report.
   *  Otherwise: the page is readable, is not the review page, and shows none of the project's
   *  values — the run stopped before review, and says where in the page's own words. */
  private async whereTheRunStopped(confirmed: number): Promise<{ where: string; message: string } | null> {
    if (confirmed > 0) return null;
    const at = await this.pageSafetyContext();
    if (at.reviewPage !== false) return null;
    // The page's own title for itself (Accela's "Step 2 : Services > Attachments"), else its heading —
    // before pageLabelNow, whose "active" match can be the site banner ("Oregon ePermitting").
    const titled = typeof this.page?.evaluate === "function" ? String(await this.page.evaluate(() => {
      // A page-title element first, wherever it sits; headings only when there is none.
      for (const sel of ["[class*='pagetitle' i], [class*='page-title' i]", "main h1, main h2, form h1, form h2", "h1, h2, legend"]) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const r = el.getBoundingClientRect();
          const t = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").replace(/\s+:/g, ":").trim();
          if (r.width > 0 && r.height > 0 && t) return t.slice(0, 80);
        }
      }
      return "";
    }).catch(() => "")) : "";
    const where = titled || (await this.pageLabelNow().catch(() => "")) || "the last page the recipe reached";
    const refused = (await this.readPortalRefusal().catch(() => [] as string[])).slice(0, 3).map((t) => t.replace(/[.\s]+$/, ""));
    return {
      where,
      message: `STOPPED on "${where}" — NOT the review page (the page does not read as the portal's review step, and none of the project's values are on it), so the application is NOT staged at review.`
        + `${refused.length ? ` The portal says: ${refused.join(" | ")}.` : ""}`
        + ` Next: in the portal, finish that page (check every attachment is listed and nothing is flagged required), continue to the review page, verify every field there, then submit. Nothing was filed.`,
    };
  }

  /** Binding keys the planner invented that the dictionary does not define — reported once
   *  each, not once per resolveValue call (it runs in several loops). */
  private readonly inventedBindings = new Set<string>();

  /** REFUSING THE LEARN ROOF'S NUMBER IS HALF A FIX; THE OTHER HALF IS FILING THIS ROOF'S.
   *
   *  Measured on the PacifiCorp storage section replayed for a project that DOES have a
   *  battery: the declaration answered "Yes" and the manufacturer replayed "Tesla" (a
   *  `select`, so closed vocabulary survives the guard below), but "Energy Storage Capacity
   *  of Battery (kWh)" came out EMPTY. Two things combined to do that, and neither is
   *  wrong on its own:
   *    - capacity is the one battery spec with NO binding key. RECIPE_FIELD_DESCRIPTIONS
   *      defines batteryManufacturer/batteryModel/batteryQuantity but nothing for kWh, so
   *      the binder can only freeze the recorded number as an unbound literal.
   *    - `looksLikeProjectData` matches "capacity", so that frozen literal is refused —
   *      correctly. 13.5 is the learn roof's Powerwall; filing it on a 27 kWh job is the
   *      8000-W-on-a-6-kW-system incident wearing a battery label.
   *  The result was a filing that tells the utility there IS a Tesla battery and never says
   *  how big it is — a required kWh field left empty, which is a suspended interconnection
   *  application rather than a rejected one, but still a filing that does not complete.
   *
   *  So the refusal grows its missing half: substitute the capacity THIS project holds.
   *  Battery context is REQUIRED in the label, not merely "capacity": a bare "System
   *  Capacity (kW)" is the PV system's AC rating, and answering it with the battery's kWh
   *  would be the wrong-number outcome this guard exists to prevent. Still blank when the
   *  project carries no capacity — blank and visible beats another roof's number. */
  private projectBatteryCapacityFor(label: string): string {
    if (!/\bbatter(y|ies)\b|\benergy storage\b|\bess\b|\bstorage\b/i.test(label)) return "";
    if (!/\bcapacity\b|kwh/i.test(label)) return "";
    // Stated where the value is produced, not only in skipForNoBattery: a project declared
    // WITHOUT storage must never have a capacity filed for it, whatever else is in scope.
    if (/^(no|false|none|n)$/i.test(String(this.fieldValues.hasBattery ?? "").trim())) return "";
    // essKwh is the canonical key normalize.ts derives; batteryCapacityKwh is what the
    // parser itself emits. Both reach fieldValues through resolveRecipeFieldValues' snapshot
    // passthrough, and the raw key is the fallback for a snapshot that never went through
    // normalisation — the same case portalRecipes.ts guards for the energy-source answer.
    return String(this.fieldValues.essKwh ?? this.fieldValues.batteryCapacityKwh ?? "").trim();
  }

  private resolveValue(step: RecipeStep): string {
    // NOT HAVING A BATTERY IS AN ANSWER, AND IT IS "NO". This step is only reached now
    // because it is the DECLARATION rather than a spec, and the recorded literal on it came
    // from whichever roof the recipe was learned on — which had a battery, or the step would
    // not exist. Replaying that literal would declare a battery the customer does not own,
    // which is the failure this whole rule was written to stop: a live PacifiCorp replay
    // once told the utility a Powerwall's capacity as fact about a job with no storage.
    // Leaving it blank is not the alternative either — the portal marks it required, and it
    // was this run's only blank on PGE.
    if (this.isBatteryDeclaration(step) && /^(no|false|none|n)$/i.test(String(this.fieldValues.hasBattery ?? "").trim())) {
      return "No";
    }
    // THE SIGNER IS THE CLIENT'S AUTHORIZED SIGNER, whatever key an older recipe bound the box
    // to (a planner-chosen installerContactName would sign as the contact). Empty = runAll
    // pauses before this step, named.
    // A SPLIT signature step (signerNamePart) takes that part of the signer — "" when the name
    // cannot be split, which pauses the run exactly like no signer at all (MF-E d).
    if (step.action === "fill" && isSignatureStep(step)) {
      const signer = String(this.fieldValues.authorizedSignerName ?? "").replace(/\s+/g, " ").trim();
      return step.signerNamePart ? splitSignerName(signer, step.signerNamePart) : signer;
    }
    // A PARCEL SEARCHED "(no dashes)" (the learner's ACA work-location pass, Lee County): the
    // same characters, dashes and spaces dropped — the way the learn searched it.
    if (step.action === "fill" && step.field && /\(no dashes\)/i.test(String(step.note ?? ""))) {
      return String(this.fieldValues[step.field] ?? "").replace(/[-\s]/g, "");
    }
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
        return applyFormatHint(this.fieldValues[mapped] ?? "", String(step.note ?? ""));
      }
      // RE-GROUP TO THE FORMAT THE PORTAL PRINTED. PacifiCorp labels its account field
      // "please use this format: xxxxxxxx xxx x"; the bill prints "58103504-001 2" and we
      // hold "58103504-0012", so the submission came back rejected with that field named.
      // The digits were right; only the grouping was wrong, and the portal had already said
      // what it wanted. applyFormatHint only ever re-groups the SAME characters.
      // A KEY NOBODY DEFINED RESOLVES TO NOTHING, AND NOTHING IS WHAT GETS FILLED.
      //
      // The planner names its own binding keys. Miami's Job Category came back bound to
      // "jobCategory" — a key the value dictionary has never heard of — so this returned ""
      // and the recorded answer, "STAND-ALONE", was thrown away. On replay that is a blank
      // required field and a portal that refuses to advance, every time, silently.
      //
      // The literal is only used when the key is UNKNOWN. A key the dictionary defines and
      // leaves empty for this project is an answer — blank — and must stay blank, or a
      // shared recipe files the learn project's homeowner. This distinguishes "the planner
      // invented a name" from "this project has no value for that".
      const known = Object.prototype.hasOwnProperty.call(this.fieldValues, step.field);
      const bound = applyFormatHint(this.fieldValues[step.field] ?? "", String(step.note ?? ""));
      if (!known && !bound && String(step.value ?? "").trim()) {
        const key = String(step.field);
        // ...BUT A RECIPE IS SHARED, AND THE RECORDED ANSWER BELONGS TO THE PROJECT IT WAS
        // LEARNED ON. The rule above asks only whether the KEY is known. When the planner
        // invents a key ("ownerFullName") the key is unknown, so the literal replayed — and
        // the literal was the LEARN project's homeowner. Reproduced in
        // crossProjectReplay.test.ts: "Alice Anderson" and "111 First Street" typed into a
        // different customer's application, and 8000 W filed for a 6 kW system.
        //
        // The fallback still earns its place for PORTAL VOCABULARY — Miami's Job Category
        // "STAND-ALONE" is bound to an invented "jobCategory" key and must survive, or the
        // required dropdown replays blank and the portal refuses to advance. So the test is
        // not "is the key known" but "could this answer belong to a different project":
        //   - a closed-vocabulary answer (select/check) is the PORTAL's own word, never the
        //     customer's, so it replays;
        //   - free text under a project-data label (owner, address, phone, email, account,
        //     size...) is the customer's, so it is refused and left blank for the reviewer.
        // Refusing is the safe direction: a blank required field is a visible stop, while a
        // stale name is an invisible one that reaches a real filing.
        const closedVocabulary = step.action === "select" || step.action === "check";
        const labelText = `${step.selector?.label ?? ""} ${step.note ?? ""}`;
        if (!closedVocabulary && looksLikeProjectData(labelText, String(step.value))) {
          const ownCapacity = this.projectBatteryCapacityFor(labelText);
          if (ownCapacity) return applyFormatHint(ownCapacity, String(step.note ?? ""));
          if (!this.inventedBindings.has(key)) {
            this.inventedBindings.add(key);
            this.agingNotes.push(
              `"${String(step.note ?? key).slice(0, 40)}" is bound to "${key}", which the value dictionary does not define, and its recorded answer looks like the learn project's own data — left BLANK rather than replaying another project's value`,
            );
          }
          return "";
        }
        if (!this.inventedBindings.has(key)) {
          this.inventedBindings.add(key);
          this.agingNotes.push(
            `"${String(step.note ?? key).slice(0, 40)}" is bound to "${key}", which the value dictionary does not define — replayed the recorded answer instead of leaving it blank`,
          );
        }
        return applyFormatHint(String(step.value), String(step.note ?? ""));
      }
      return bound;
    }
    // AN UNBOUND LITERAL IS THE SAME HAZARD WITHOUT EVEN A KEY TO WARN US.
    //
    // The binder keeps any literal that does not EXACTLY match a project value as a
    // "portal-specific literal" (portalRecipes.ts). That is how project A's 8 kW system,
    // recorded as "8000" watts, froze and would file 8000 for a 6 kW job — and how an
    // address written differently than the project record froze as a "constant". Because
    // recipes are shared across orgs, an installer licence frozen this way crosses COMPANIES.
    //
    // Same rule as the invented-key branch above, and the same safe direction: a closed
    // vocabulary answer is the portal's, free text under a project-data label is somebody's.
    if (step.action !== "select" && step.action !== "check") {
      const labelText = `${step.selector?.label ?? ""} ${step.note ?? ""}`;
      if (looksLikeProjectData(labelText, String(step.value ?? ""))) {
        const ownCapacity = this.projectBatteryCapacityFor(labelText);
        if (ownCapacity) return applyFormatHint(ownCapacity, String(step.note ?? ""));
        const key = `literal:${labelText.slice(0, 40)}`;
        if (!this.inventedBindings.has(key)) {
          this.inventedBindings.add(key);
          this.agingNotes.push(
            `"${labelText.trim().slice(0, 40)}" carries a recorded literal that looks like the learn project's own data and is bound to nothing — left BLANK rather than replaying it onto this project`,
          );
        }
        return "";
      }
    }
    return applyFormatHint(step.value ?? "", String(step.note ?? ""));
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
        await this.guardedClick(loc.first(), "add another array row", { timeout: 8000 });
        await sleep(1200);
        await this.settle(4000);
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
    // A BARE "Model" LABEL MATCHES BOTH SIDES. PowerClerk's spec block carries the inverter's
    // Model and, nested inside it, the PV array's Model — same label, no qualifier. .first()
    // lands on whichever renders first, and when that is the ARRAY's (filled) select, the
    // INVERTER's empty one reads as held and is never repaired. Live: replay shipped page 7
    // with "This field is required" under the inverter Qty while the check reported nothing
    // empty. So when several controls match the label, the check reads the EMPTY one — an
    // empty peer is precisely the control this verification exists to catch.
    const emptyIndexFor = new Map<string, number>();
    const displayed = async (s: RecipeStep): Promise<string | null> => {
      const loc = await this.resolveLocator(labelOnly(s).selector).catch(() => null);
      const n = loc ? await loc.count?.().catch(() => 0) : 0;
      if (!loc || !n) return null;
      let target = loc.first();
      if (n > 1) {
        for (let k = 0; k < Math.min(n, 6); k++) {
          const v = await loc.nth(k).evaluate((el: Element) => {
            if ((el.tagName || "").toLowerCase() !== "select") return "";
            const sl = el as HTMLSelectElement;
            return (sl.options[sl.selectedIndex]?.textContent || "").trim();
          }).catch(() => "");
          if (!v || /^(please\s+)?select\.{0,3}$/i.test(v) || /^--/.test(v)) {
            target = loc.nth(k);
            emptyIndexFor.set(String(s.field), k);
            break;
          }
        }
      }
      return await target.evaluate((el: Element) => {
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
      // Aim the re-run at the EMPTY control the check just found — the label matches the
      // filled peer too, and refilling that one would both miss the gap and risk clobbering
      // a correct answer with a value from the other side's list.
      const retryStep = ((): RecipeStep => {
        const base = labelOnly(s);
        const k = emptyIndexFor.get(String(s.field));
        return k === undefined ? base : { ...base, selector: { ...base.selector, nth: k } };
      })();
      await this.executeStep(retryStep, false).catch(() => false);
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
  /**
   * The options belonging to THIS control, not to whatever is open on the page.
   *
   * This sampled the whole document — every `[role=option]`, every `select option`, anywhere.
   * So a miss on PGE's inverter "Model" reported `13 option(s) were showing, list offers
   * "a. Solar", "b. Wind", "c. Hydro"`, which are Energy Source values from an entirely
   * different widget, and the report read as though the Model dropdown contained them. It is
   * the same class of mistake describeResolved was making one function away: describing
   * something other than the thing being acted on, in a line that then gets believed.
   *
   * Given the control, sample from it: a native select's own options, or the listbox a
   * combobox owns via aria-controls/aria-owns, or the nearest open list inside its container.
   * Page-wide is kept only as the last resort, and says so.
   */
  private async visibleOptionSample(loc?: unknown): Promise<{ count: number; sample: string[]; scoped: boolean }> {
    if (!this.page || typeof this.page.evaluate !== "function") return { count: 0, sample: [], scoped: false };
    const own = loc as { evaluate?: (fn: unknown) => Promise<{ count: number; sample: string[] } | null> } | undefined;
    if (own && typeof own.evaluate === "function") {
      const scopedRes = await own.evaluate((el: Element) => {
        const textOf = (o: Element): string => (( o as HTMLElement).innerText || o.textContent || "").trim();
        const vis = (o: Element): boolean => {
          const r = o.getBoundingClientRect();
          return (r.width > 0 && r.height > 0) || (o.tagName || "").toLowerCase() === "option";
        };
        if ((el.tagName || "").toLowerCase() === "select") {
          const t = Array.from((el as HTMLSelectElement).options).map(textOf).filter(Boolean);
          return { count: t.length, sample: t.slice(0, 6) };
        }
        const owns = el.getAttribute("aria-controls") || el.getAttribute("aria-owns") || "";
        const list = owns ? document.getElementById(owns) : null;
        const box = list
          || el.closest('[class*="dropdown"], [class*="select"], [class*="combobox"], [role="combobox"]')
          || el.parentElement;
        if (!box) return null;
        const rows = Array.from(box.querySelectorAll('[role=option], .dropdown-item, .v-list-item, li[class*="option"], li[class*="item"], option'))
          .filter(vis).map(textOf).filter(Boolean);
        return rows.length ? { count: rows.length, sample: rows.slice(0, 6) } : null;
      }).catch(() => null);
      if (scopedRes && scopedRes.count) return { ...scopedRes, scoped: true };
    }
    const wide = await this.page.evaluate(() => {
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
    return { ...wide, scoped: false };
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
    // (An unlabelled control has no label to contradict — decided below, AFTER the fingerprint.)

    // A LABEL CAN BE SHORT AND STILL SAY SOMETHING, AND AN EMPTY SET ACCEPTS ANYTHING.
    //
    // The `length > 3` filter exists to stop weak tokens creating false agreement ("Job
    // Category" and "Job Value" must not agree on "job"). But it also empties the set for a
    // label that is nothing BUT a short word — "Fax:", "ZIP:", "APN:", "Tel:", "Qty:" — and
    // `!b.size` then returns null, which means ACCEPT. So the one class of label where a
    // mis-resolution is hardest to notice was the one class that could never be contradicted:
    // any step at all could be typed into a box labelled "Fax".
    //
    // The fix keeps the strict filter wherever it has anything to work with, and falls back
    // to the short tokens ONLY when a label has no long ones. That is why it does not
    // reintroduce the "job" problem: "Job Category" has "category", so "job" is never
    // admitted. And `*Type (Required):` — all stopwords and markers — still yields nothing at
    // either length, so a label that is genuinely all boilerplate still has nothing to
    // contradict and is still accepted.
    //
    // The cost is a short label whose synonym differs ("APN" recorded, "Parcel Number" on the
    // page) reaching the candidate scan, and aborting if nothing better is found. That is the
    // trade this function already declares below: filing the right answer into the wrong
    // question is far worse than leaving it blank for the human at review.
    const meaningful = (v: string): string[] =>
      v.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
        .filter((w) => w && !IDENTITY_STOPWORDS.has(w));
    const words = (v: string) => {
      const tokens = meaningful(v);
      const strong = tokens.filter((w) => w.length > 3);
      return new Set(strong.length ? strong : tokens);
    };
    // ONE predicate for "does a control's label agree with the recorded one?" — used by the
    // label check below AND by the fingerprint re-anchor, so the two can never disagree about
    // what "the same label" means. true = they share meaning, or there is nothing to contradict.
    const agree = (recordedText: string, actualText: string): boolean => {
    const a = words(recordedText);
    const b = words(actualText);
    if (!a.size || !b.size) return true;
    for (const w of a) if (b.has(w)) return true; // they agree on something — accept it
    // HYPHENS SPLIT WHAT PEOPLE READ AS ONE WORD. "E-mail:" tokenizes to {mail} while the
    // recorded note says "email" — zero overlap, and a correctly-resolved control got
    // SKIPPED as unrelated (measured live: ACA's contact popup email). Compare against the
    // compacted form too, both directions, before calling two labels strangers.
    const compact = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
    const aCompact = compact(recordedText);
    const bCompact = compact(actualText);
    for (const w of a) if (bCompact.includes(w)) return true;
    for (const w of b) if (aCompact.includes(w)) return true;
    // AN ABBREVIATION IS NOT A CONTRADICTION, and admitting short tokens above made it look
    // like one. multiArray went red on a control labelled "Qty" whose step is noted "pv array
    // quantity": zero shared words, and "quantity" does not CONTAIN "qty", so a correct fill
    // was refused and aborted. Qty/quantity, Amt/amount, Mfr/manufacturer and Tel/telephone
    // are all the same shape.
    //
    // A written abbreviation keeps its letters in order, so a subsequence test is what tells
    // "qty" inside "pvarrayquantity" (q…t…y) from "fax" inside "contactemailapplicant" (no f
    // at all). Capped at four letters, because past that a subsequence match is coincidence
    // rather than shorthand.
    //
    // This direction of error is the cheap one: an escape that fires spuriously only ACCEPTS,
    // which is precisely what this function did for every short label before today — so the
    // worst case is the old behaviour, while a missing escape ABORTS a correct fill and leaves
    // a required field blank. The corpus agrees it should be generous: all seven all-short
    // labels in the 76 recorded recipes ("Zip", "Yes", "No", "Sub Type", "120/240") carry a
    // note identical to the label, so none of them needs this at all — the hole being closed
    // above is real but unwitnessed, and it must not be closed at the price of a real abort.
    const subsequence = (needle: string, hay: string): boolean => {
      let i = 0;
      for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
      return needle.length === 0;
    };
    for (const w of a) if (w.length <= 4 && subsequence(w, bCompact)) return true;
    for (const w of b) if (w.length <= 4 && subsequence(w, aCompact)) return true;
    return false;
    };

    // A WRITE TO THE WRONG ELEMENT THAT READS BACK CLEAN (replay skeptic MF5). The label check
    // below cannot see this: accela/relabelled's owner step recorded {label "E-mail:", id
    // OwnerEdit_txtEmail, section "Property Owner"}; the owner's label became "Email Address:",
    // so "E-mail:" resolved to the APPLICANT's box — the SAME label, so it agreed, the installer's
    // email was overwritten, and the read-back from that same box agreed too. The recorded
    // FINGERPRINT says which element was meant: when the resolved element's id AND name contradict
    // it while the fingerprinted element is on the page (exactly one), and that element's own label
    // or section still agrees with the recording, write THERE. An absent fingerprint element
    // redirects nothing (ids_renamed), and a step with no fingerprint is unaffected.
    const fp = (step as { fingerprint?: { id?: string; name?: string; section?: string } }).fingerprint;
    if (fp && (fp.id || fp.name) && this.page && typeof this.page.locator === "function") {
      const got = await el0.evaluate((el: Element) => ({ id: el.getAttribute("id") || "", name: el.getAttribute("name") || "" })).catch(() => null) as { id: string; name: string } | null;
      const agreesById = !!fp.id && got?.id === fp.id;
      const agreesByName = !!fp.name && got?.name === fp.name;
      const contradicts = !!got && !agreesById && !agreesByName
        && ((!!fp.id && !!got.id && got.id !== fp.id) || (!!fp.name && !!got.name && got.name !== fp.name));
      if (contradicts) {
        const target = fp.id
          ? this.page.locator(`[id="${String(fp.id).replace(/["\\]/g, "\\$&")}"]`)
          : this.page.locator(`[name="${String(fp.name).replace(/["\\]/g, "\\$&")}"]`);
        const n = await target.count().catch(() => 0);
        if (n === 1) {
          const meant = await target.first().evaluate((el: Element) => {
            const id = el.getAttribute("id");
            const forLbl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
            const wrap = el.closest("label");
            const label = ((forLbl as HTMLElement | null)?.textContent || (wrap as HTMLElement | null)?.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
            const fs = el.closest("fieldset");
            const legend = fs ? fs.querySelector("legend") : null;
            const section = (legend && legend.textContent ? legend.textContent : "").replace(/\s+/g, " ").trim();
            return { label, section };
          }).catch(() => null) as { label: string; section: string } | null;
          const sectionAgrees = !!fp.section && !!meant?.section && meant.section.toLowerCase() === String(fp.section).replace(/\s+/g, " ").trim().toLowerCase();
          if (meant && (sectionAgrees || (meant.label && agree(recorded, meant.label)))) {
            this.driftWarnings.push(
              `step "${recorded.slice(0, 44)}" resolved onto #${(got!.id || got!.name).slice(0, 50)}, but the recorded control #${String(fp.id || fp.name).slice(0, 50)}${fp.section ? ` (${String(fp.section).slice(0, 30)})` : ""} is on the page — written there, not into the other box`,
            );
            return target.first();
          }
        }
      }
    }

    if (!actual) return null; // unlabelled control — nothing to contradict
    if (agree(recorded, actual)) return null;
    const a = words(recorded);

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
  // A RECIPE IS SHARED; THE EQUIPMENT ON THE ROOF IS NOT.
  //
  // A recipe learned on a job WITH a battery records the whole storage section — the
  // declaration checkbox, and specs frozen as literals. Live: the PacifiCorp NEM recipe
  // carries 16 battery steps including `Energy Storage Capacity of Battery (kWh) = "13.5"`,
  // and replaying it onto Christopher Ivy — 8 modules, 4 microinverters, hasBattery "No" —
  // declared a battery he does not own and gave the utility a Powerwall's capacity as fact.
  // Every later job under that profile would have inherited it.
  //
  // The learn side refuses to record this now, but recipes already recorded still exist, and
  // a shared recipe must adapt to the project it is replaying for. Skipping (rather than
  // failing) is right: the section is simply not part of this filing.
  /** IS THIS THE QUESTION, OR IS IT THE SPECS?
   *
   *  "Energy Storage" / "Battery included?" ASK whether there is a battery — a job without
   *  one answers No. "Battery Capacity (kWh)", "Battery Manufacturer", "Round-trip
   *  efficiency" DESCRIBE a battery that does not exist, and those are what must be skipped
   *  rather than filled from a recipe learned on some other roof.
   *
   *  Told apart by shape rather than by portal: a spec asks for a number, a make, a model or
   *  a rating; a declaration is a bare storage noun, and a checkbox is always a declaration
   *  because there is nothing else a checkbox could be. */
  private isBatteryDeclaration(step: RecipeStep): boolean {
    const label = `${step.note ?? ""} ${step.field ?? ""}`;
    if (!/\bbatter(y|ies)\b|\benergy storage\b|\bess\b|\bstorage\b/i.test(label)) return false;
    // An UPLOAD is never the yes/no battery question — "upload battery_spec: Battery Specification
    // Sheet" is a battery's document (skeptic eb36a8f MF1: it read as a declaration, so the no-battery
    // skip never fired and a datasheet went up on a no-battery filing).
    if (step.action === "upload") return false;
    if (step.action === "check" || step.action === "uncheck") return true;
    const SPEC = /capacity|kwh|kw\b|\bah\b|manufacturer|model|make|quantity|\bqty\b|\bsize\b|rating|voltage|efficiency|round-?trip|state of charge|serial|nameplate|inverter/i;
    return !SPEC.test(label);
  }

  private skipForNoBattery(step: RecipeStep): boolean {
    const raw = String(this.fieldValues.hasBattery ?? "").trim();
    if (!/^(no|false|none|n)$/i.test(raw)) return false; // unknown or yes → replay as recorded
    const label = `${step.note ?? ""} ${step.field ?? ""}`;
    // "Wattsmart Battery Program?" is a PROGRAM question answered No, not a spec — answering
    // it is correct and skipping it would leave a required question blank.
    if (/program\b/i.test(label)) return false;
    // NEITHER IS THE QUESTION "IS THERE A BATTERY". Live on PGE: the recipe's "Energy Storage"
    // step was skipped for a job with no battery, and the portal then reported "Energy
    // Storage" as a REQUIRED FIELD LEFT BLANK — the run's only blank. Not having a battery is
    // the answer to that question, not a reason to leave it unanswered. A declaration gets
    // answered; only the SPECS of a battery that does not exist are skipped.
    if (this.isBatteryDeclaration(step)) return false;
    return /\bbatter(y|ies)\b|\benergy storage\b|\bess\b|round-?trip|state of charge/i.test(label);
  }

  // A SLOT THAT ONLY EXISTS AT REPLAY CAN ONLY BE FILLED AT REPLAY.
  //
  // PacifiCorp reveals "Upload a photo of meter where system will be interconnected" once the
  // meter number is entered — and a LEARN never enters one, because the meter number is
  // sensitive and is recorded as a binding with an empty literal. So the slot is not on the
  // page while the recipe is being written, no upload step is ever recorded for it, and the
  // utility rejects the filing naming that field. Five learns could not have fixed this: the
  // recording is made under precisely the conditions that hide the control.
  //
  // Replay is the first time the meter number is real, so it is the first time the slot
  // exists. This sweeps whatever upload controls are actually on the page and fills the ones
  // the recipe has no step for. Conservative on purpose: only a slot whose LABEL names a
  // document we hold, never a substitute, and never a slot that forbids one.
  private readonly sweptUploadLabels = new Set<string>();

  /** A SLOT A RECORDED STEP FILLED IS NOT "A SLOT THE RECIPE HAS NO STEP FOR".
   *
   *  The sweep's own bookkeeping (sweptUploadLabels) only knew about the sweep's OWN attaches,
   *  so a slot the recorded upload step had just filled was attached a SECOND time before the
   *  next advancing click, with a false "no step for" warning — on a portal where each attach
   *  adds a row, a duplicate document on a live application. The slot identity the engine
   *  uses is the tagged element itself (data-al-upl), so the fact lives ON the element: the
   *  recorded attach marks the control it filled (and, for a chooser widget, the input the
   *  chooser handed the file to). A fresh page or re-rendered form has fresh elements and no
   *  marks, so this is scoped to exactly this page and pass — never a run-wide label list,
   *  which would starve a later page whose slots merely share a label. Best-effort: a mark
   *  that cannot be written falls back to the old behaviour for that slot, and never fails
   *  the attach that already happened. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async markRecordedUpload(target: any, chooser: any): Promise<void> {
    const mark = (el: Element): void => {
      el.setAttribute("data-al-upl-recorded", "1");
      // A <label>/wrapper resolved as the target: mark the input it drives as well.
      const input = el.tagName === "INPUT" ? null
        : ((el as HTMLLabelElement).control ?? el.querySelector('input[type="file"]'));
      input?.setAttribute("data-al-upl-recorded", "1");
    };
    await target?.evaluate?.(mark).catch(() => null);
    // FileChooser.element() is SYNCHRONOUS (an ElementHandle, not a promise) — awaiting a
    // .catch on it short-circuited to undefined and the chooser's input was never marked.
    try {
      const handle = chooser?.element?.();
      await handle?.evaluate?.(mark).catch(() => null);
    } catch { /* best-effort, as above */ }
  }

  /** Keys (data-al-upl, as tagUploadControls just assigned them) of slots a recorded attach
   *  already filled on this page. The locator pierces open shadow roots the way
   *  tagUploadControls does. */
  private async satisfiedUploadSlotKeys(): Promise<Set<string>> {
    try {
      const keys = await this.page.locator("[data-al-upl][data-al-upl-recorded]")
        .evaluateAll((els: Element[]) => els.map((e) => e.getAttribute("data-al-upl") || "")) as string[];
      return new Set((Array.isArray(keys) ? keys : []).filter(Boolean));
    } catch {
      return new Set(); // unreadable: behave exactly as before this check existed
    }
  }

  /** Staging dirs holding large documents handed to the browser BY PATH (uploadPayload.ts).
   *  The browser reads such a file when the portal uploads it — possibly at the human's final
   *  submit — so they live exactly as long as the browser this adapter opened: close()
   *  removes them after the browser is gone, never earlier. */
  private readonly uploadStagingDirs: string[] = [];

  private stageUpload(prepared: PreparedUpload): PreparedUpload["file"] {
    if (prepared.tempDir) this.uploadStagingDirs.push(prepared.tempDir);
    return prepared.file;
  }

  override async close(): Promise<void> {
    try {
      await super.close();
    } finally {
      this.releaseUploadStaging();
    }
  }

  /** Remove the staged large-file copies WITHOUT touching the browser. For the one case where
   *  the browser is already gone but close() was never called: the HUMAN closed the left-open
   *  review window (index.ts trackOpenAdapter's context "close" handler). Nothing can read
   *  the copies any more, and waiting for the 7-day prune left them on disk indefinitely on
   *  a server that stages no further large file. Idempotent. */
  releaseUploadStaging(): void {
    for (const dir of this.uploadStagingDirs.splice(0)) removeUploadStaging(dir);
  }

  private async sweepUnrecordedUploads(): Promise<number> {
    if (!this.page || typeof this.page.evaluate !== "function") return 0;
    const slots = await this.page.evaluate(tagUploadControls).catch(() => []) as Array<
      { key: string; label: string; kind: string; required: boolean; accept: string }>;
    if (!Array.isArray(slots) || slots.length === 0) return 0;
    const satisfied = await this.satisfiedUploadSlotKeys();
    let filled = 0;
    for (const slot of slots) {
      const label = String(slot.label || "");
      const key = label.trim().toLowerCase();
      if (!key || this.sweptUploadLabels.has(key)) continue;
      if (satisfied.has(slot.key)) continue;
      // An application forbids substitutes, but its exact document is welcome.
      if (uploadForbidsSubstitute(label) && !exactUploadDocType(label)) continue;
      // Only a slot that NAMES its document. A generic "attach files" control at replay is
      // not ours to guess at — the recipe would have recorded it if it mattered.
      const hit = UPLOAD_LABEL_PATTERNS.find((p) => p.re.test(label));
      if (!hit) continue;
      const file = this.docsByType[hit.docType];
      if (!file) continue;
      const accept = slot.accept || "";
      const allowed = fileTypeAllowed(file, accept);
      const pdf = shouldConvertToPdf(file, accept, allowed) ? await imageToPdfBytes(file).catch(() => null) : null;
      if (!allowed && !pdf) continue;
      const loc = await this.resolveLocator({ css: `[data-al-upl="${slot.key}"]` });
      if (!loc) continue;
      // The SAME payload the recorded upload step presents — never the raw stored path, whose
      // basename carries the on-disk UUID prefix into what the portal reviewer sees.
      const payload = this.stageUpload(uploadPayloadFor(file, pdf));
      this.options.beforeUpload?.(hit.docType, file);
      // A REFUSED ATTACH IS REPORTED, NEVER SWALLOWED. This was `.catch(() => false)` and a
      // bare continue: a document Playwright refused (a 50MB+ buffer did, every time) was
      // simply not attached, with no warning — a missing document nobody was told about.
      let failure = "";
      const ok = slot.kind === "browse"
        ? await Promise.all([
            this.page.waitForEvent("filechooser", { timeout: 8000 }),
            this.guardedClick(loc, "open an upload file chooser", { timeout: 6000 }),
          ]).then(([chooser]: [{ setFiles: (f: unknown) => Promise<void> }, unknown]) => {
            this.options.beforeUpload?.(hit.docType, file);
            return chooser.setFiles(payload);
          }).then(() => true).catch((e: unknown) => { failure = e instanceof Error ? e.message : String(e); return false; })
        : await loc.setInputFiles(payload).then(() => true)
          .catch((e: unknown) => { failure = e instanceof Error ? e.message : String(e); return false; });
      if (!ok) {
        this.driftWarnings.push(`could not attach ${hit.docType} to "${label.slice(0, 44)}" (a slot the recipe has no step for): ${failure.split("\n")[0].slice(0, 160)} — attach it by hand`);
        continue;
      }
      await this.waitForUploadAccepted();
      this.sweptUploadLabels.add(key);
      filled++;
      this.driftWarnings.push(`attached ${hit.docType} to "${label.slice(0, 44)}" — a slot the recipe has no step for`);
    }
    return filled;
  }

  // A VALUE IS NOT COMMITTED UNTIL THE PORTAL SAYS "Saved". PowerClerk autosaves per field
  // and re-renders from the SERVER's state: advance while "Saving..." is still up and the
  // re-render restores the old (empty) value. The operator watched exactly that — the
  // inverter manufacturer went in, then vanished — and the final screenshot caught the page
  // mid-"Saving...". The learn engine waits for the save indicator; replay never did. The
  // indicator is the platform's own commit signal (data-test-role project-save-state →
  // save-state-saved), so waiting on it is exact, not a guessed sleep. No indicator on the
  // page = nothing to wait for = zero cost on every other portal.
  private async waitForAutosaveCommitted(): Promise<void> {
    if (!this.page || typeof this.page.locator !== "function") return;
    const state = this.page.locator("[data-test-role='project-save-state']");
    if (typeof state?.evaluate !== "function") return; // test fakes — nothing to wait on
    if (!(await state.count?.().catch(() => 0))) return;
    for (let i = 0; i < 20; i++) {
      const saved = await state.evaluate((el: Element) =>
        Boolean(el.querySelector("[data-test-role='save-state-saved']")) || /saved/i.test((el as HTMLElement).innerText || ""),
      ).catch(() => true);
      if (saved) return;
      await sleep(400);
    }
  }

  /** True only when the page CARRIES the autosave indicator AND it reports committed —
   *  the discriminating answer the persist-settle needs. Never true on a portal without
   *  the indicator: absence of the signal must not read as "saved" (that is the
   *  unknown-as-reassurance shape), so those pages keep the full guessed sleep. */
  private async autosaveIndicatorCommitted(): Promise<boolean> {
    if (!this.page || typeof this.page.locator !== "function") return false;
    const state = this.page.locator("[data-test-role='project-save-state']");
    if (typeof state?.evaluate !== "function") return false;
    if (!(await state.count?.().catch(() => 0))) return false;
    await this.waitForAutosaveCommitted();
    return await state.evaluate((el: Element) =>
      Boolean(el.querySelector("[data-test-role='save-state-saved']")) || /saved/i.test((el as HTMLElement).innerText || ""),
    ).catch(() => false);
  }

  // data-al-row IS A LEARN-TIME TAG, NOT A SELECTOR. chooseProjectAddressRow stamps it while
  // ranking the address grid, so the recipe records [data-al-row="ar1"] — an attribute that
  // exists only in the run that wrote it. On replay nothing stamps it and the click waits 30s
  // for an element that will never appear (measured on Marineau's structural). The recorded
  // step is still meaningful, though: it says "pick this project's version of the address".
  // So re-run the ranking against the live grid, which is the right answer anyway — the row
  // order and the parcels differ per address, and ar1 on Ivy means nothing at Marineau's.
  private async pickAddressVersionLive(step: RecipeStep): Promise<boolean> {
    if (!this.page || typeof this.page.evaluate !== "function") return false;
    // SCAN THE FRAME THE STEP LIVES IN. Accela serves its work-location panel inside a child
    // frame — every recorded step on that page carries `frame` — while this scan ran against
    // the MAIN document and found no rows at all. It then returned false in silence, so the
    // step landed in `skipped` with no reason and the next step, waiting for a Continue
    // button that only appears once a row is chosen, took the blame for it.
    const evalScope: { evaluate: (fn: unknown) => Promise<Array<{ key: string; text: string }>> } =
      step.selector?.frame
        ? (this.page.frameLocator(frameSelectorFor(step.selector.frame)).locator("body") as never)
        : (this.page as never);
    // AN UNPAINTED GRID IS NOT AN EMPTY GRID — the same rule this file already applies to
    // form fields ("a portal that renders asynchronously looked identical to being on the
    // wrong page"). Accela draws the address results on a postback, and this scan got one
    // look with no retry: the row it needed was in the saved page seconds later. Poll until
    // rows appear, briefly, instead of concluding the search found nothing.
    const scanOnce = async (): Promise<Array<{ key: string; text: string }>> => await evalScope.evaluate(() => {
      const vis = (e: Element) => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const out: Array<{ key: string; text: string }> = [];
      let n = 0;
      for (const tr of Array.from(document.querySelectorAll("tr"))) {
        if (!vis(tr)) continue;
        const action = Array.from(tr.querySelectorAll("a, button, [role='button']"))
          .find((a) => /^\s*select\s*$/i.test((a as HTMLElement).innerText || ""));
        if (!action) continue;
        const text = ((tr as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 400) continue;
        const key = `rr${n++}`;
        (action as HTMLElement).setAttribute("data-al-row", key);
        out.push({ key, text });
      }
      return out;
    }).catch(() => [] as Array<{ key: string; text: string }>);
    let rows = await scanOnce();
    for (let waited = 0; rows.length === 0 && waited < 8000; waited += 800) {
      await this.page.waitForTimeout?.(800).catch(() => null);
      rows = await scanOnce();
    }
    if (rows.length === 0) {
      // The fifth silent return found today. A grid with no rows and no explanation is
      // indistinguishable from a grid that was never looked at — which is exactly what had
      // happened, in the main frame instead of the child one.
      this.driftWarnings.push(
        `address grid: no selectable rows found${step.selector?.frame ? ` inside frame ${String(step.selector.frame).slice(0, 40)}` : " in the main document"} — the address step was skipped, so anything waiting on a chosen row will fail next`,
      );
      return false;
    }

    // THE RECIPE'S OWN DISCIPLINE IS THE MOST RELIABLE SIGNAL HERE, and it was not consulted.
    //
    // Oregon ePermitting lists an address under several VERSIONS — "City Applications",
    // "County Applications" — and which record types are offered depends on which one is
    // chosen. Coos Bay's structural recipe wants "Residential - Structural" and finds it;
    // its ELECTRICAL sibling wants "Residential - Electrical", which the version this ranks
    // to does not offer at all, and the record-type guard then correctly refuses to file
    // under a type the portal never listed. Both recipes ranked identically because
    // `permitType` is unset on the project and the step note says only "address version".
    //
    // `recipe.discipline` is the field the learn stored for exactly this: "structural" on one
    // and "electrical" on the other.
    const wantsElectrical = /elec/i.test(String(this.fieldValues.permitType ?? ""))
      || /elec/i.test(String(step.note ?? "").replace(/\s+—\s+issuing agency:.*$/i, ""))
      || /elec/i.test(String(this.recipe.discipline ?? ""));
    // THE LOOKED-UP ISSUING AGENCY DECIDES THE ROW when it is known (production 2026-09-27: City
    // of Jefferson's permits are issued by Marion County; the discipline convention above would
    // take the city's row for a structural filing). bindRecipeForReplay writes it into the field
    // values for THIS project and track — the recipe's own recorded row means nothing here.
    const issuingAgency = String(this.fieldValues.issuingAgency ?? "").trim();
    const { ranked, rejected, preference } = rankAddressVersions(rows.map((r: { key: string; text: string }) => r.text), {
      city: this.fieldValues.city,
      zip: this.fieldValues.zip,
      homeownerName: this.fieldValues.homeownerName,
      isElectrical: wantsElectrical,
      issuingAgency: issuingAgency || undefined,
    });
    // How many the grid offered, always — "which row did it pick" is unanswerable otherwise.
    this.agingNotes.push(`address grid: ${rows.length} result(s) offered for ${String(this.fieldValues.city ?? "(no city)")} ${String(this.fieldValues.zip ?? "")}`.slice(0, 140));
    if (ranked.length === 0) {
      this.driftWarnings.push(`address grid: none of ${rows.length} result(s) are in ${this.fieldValues.city ?? "(no city)"} ${this.fieldValues.zip ?? ""} — refusing to open an application against another property`);
      return false;
    }
    if (preference.note) this.agingNotes.push(`address version: ${preference.note}`.slice(0, 300));
    // The agency's row is not on offer and the convention's pick is the OTHER kind of
    // jurisdiction: clicking it files with an agency the lookup says does not issue this permit
    // (rule 5's entity clause). Stop, named — the same way an unoffered record type stops.
    if (preference.contradicts) {
      // Worded in the "is not offered here" family on purpose: the replay-failure classifier
      // (portalRecipes.replayFailureBlamesRecipe) reads that as THIS project's jurisdiction, not
      // recipe drift, so a correct stop never demotes the recipe or queues a re-learn.
      const why = `Address version: the issuing agency's row (${issuingAgency}) is not offered here — ${preference.note}. Refusing to file with the wrong agency: choose the row by hand, or correct the issuing agency on the per-job lookup.`;
      this.driftWarnings.push(`address grid: ${preference.note}`.slice(0, 300));
      throw new Error(why);
    }
    const best = rows[ranked[0].index];
    const okClick = await this.guardedClick(this.page.locator(`[data-al-row="${best.key}"]`).first(), "select the ranked address version", { timeout: 12000 })
      .then(() => true).catch((err: unknown) => {
        // SAY WHY. This returned false in silence, so the step landed in `skipped` with no
        // reason and the NEXT step — waiting for a Continue button that only appears once a
        // row is chosen — took the blame. Coos Bay reported "work location: continue" timing
        // out when the real event was one line earlier and unreported.
        this.driftWarnings.push(
          `address grid: found ${rows.length} result(s), chose ${JSON.stringify(String(best.text).slice(0, 60))} and could not click it — ${err instanceof Error ? err.message.slice(0, 90) : String(err).slice(0, 90)}`,
        );
        return false;
      });
    if (!okClick) return false;
    await smartWait(this.page, 2500);
    this.agingNotes.push(`address version re-ranked live: ${(ranked[0].text.match(/(CITY|COUNTY|DEQ)\s+APPLICATIONS/i) || ["this property"])[0]}${preference.basis === "agency" ? ` (issuing agency ${issuingAgency})` : ""}${rejected.length ? `, ${rejected.length} other propert${rejected.length === 1 ? "y" : "ies"} rejected` : ""}`);
    return true;
  }

  // WHICH PERMIT WE ARE APPLYING FOR IS NEVER CHOSEN BY ARRAY INDEX.
  //
  // The record-type checkbox is recorded with the label AND a positional fallback
  // (cbListServices_1). The offered list differs per jurisdiction: Coos Bay's CITY record has
  // no "Residential - Electrical" at all, so on Marineau the label matched nothing, the
  // positional fallback fired, and index 1 on that list is "Residential - Mechanical". A
  // MECHANICAL permit was filed and issued on a solar job at 1780 Ocean Blvd, fees paid.
  //
  // The label is the only thing that identifies a permit type. If the recorded type is not on
  // offer, that is a real answer — this jurisdiction files this discipline somewhere else —
  // and it must stop, not approximate. The hand-coded Accela adapter learned this same lesson
  // earlier; the replay path kept the fallback.
  private isRecordTypeStep(step: RecipeStep): boolean {
    const s = `${step.selector?.label ?? ""} ${step.note ?? ""}`;
    return step.action === "check"
      && (/cbListServices/i.test(step.selector?.fallbacks?.map((f) => f.css ?? "").join(" ") ?? "")
        || /^(residential|commercial)\s*-\s*/i.test(s.trim()));
  }

  // The list this jurisdiction actually offers — for the error, so a human reads "the city has
  // no Electrical" instead of "step 12 failed" and knows to file that discipline with the county.
  private async readOfferedRecordTypes(): Promise<string[]> {
    if (typeof this.page.evaluate !== "function") return [];
    return this.page.evaluate(() =>
      Array.from(document.querySelectorAll('input[type="checkbox"]')).map((cb) => {
        const id = cb.getAttribute("id") || "";
        const lab = id ? document.querySelector(`label[for="${id.replace(/"/g, '\\"')}"]`) : null;
        return ((lab as HTMLElement | null)?.innerText || "").replace(/\s+/g, " ").trim();
      }).filter(Boolean).slice(0, 10)).catch(() => [] as string[]);
  }

  /** Every recorded step. A step that WRITES a value (fill / select / check / uncheck / upload)
   *  runs inside an own-write window on the network backstop (autosubmit-close item 7): its
   *  per-field autosave on a page that reads as review — PowerClerk's Terms checkbox, recorded
   *  before stopForReview — is the write's commit, not the page posting on its own, and the
   *  review lockdown's live reading let it through. Its filing/payment rules and the run's own
   *  review lock (set at stopForReview) are untouched. Clicks, presses and gotos get no window. */
  private async executeStep(step: RecipeStep, pastReview: boolean): Promise<boolean> {
    if (!RecipeAdapter.WRITE_ACTIONS.has(step.action) || !this.backstop) return this.executeStepInner(step, pastReview);
    return withOwnWriteWindow(this.page, `recorded ${step.action}${step.note ? ` (${String(step.note).slice(0, 50)})` : ""}`, () => this.executeStepInner(step, pastReview));
  }
  private static readonly WRITE_ACTIONS: ReadonlySet<string> = new Set(["fill", "select", "check", "uncheck", "upload"]);

  private async executeStepInner(step: RecipeStep, pastReview: boolean): Promise<boolean> {
    // AN ADDRESS-ROW STEP HAS NO SELECTOR WORTH TRYING, so do not spend 30 seconds proving
    // it. The generic pass records a marker that exists only during the learn click - by
    // design, so the matcher gets its turn - and Playwright treats a selector that resolves
    // to nothing as something to WAIT for: the first version burned a full click timeout
    // and every retry (with page reloads) before the fallback below could run. Route on the
    // note, the way the address-version tag already routes on its attribute.
    if (/\baddress row:/i.test(String(step.note ?? ""))) return this.pickAddressRowForProject(step);

    // A recorded learn-time row tag can only be honoured by redoing the choice it stood for.
    // MATCH THE WHOLE ATTRIBUTE. A bare substring test also caught [data-al-resultrow="1"] —
    // the generic results-row marker — and routed it into the address-VERSION ranking, which
    // only sees rows carrying a "Select" link. It found none, warned that the grid was empty,
    // and the address matcher this step was written for never ran.
    if (/data-al-row\s*=/.test(step.selector?.css ?? "")) {
      return this.pickAddressVersionLive(step);
    }
    if (this.isRecordTypeStep(step)) {
      const wanted = String(step.selector?.label || step.note || "").trim();
      // SETTLE BEFORE COUNTING. count() does not wait: right after the previous page's full
      // postback navigated here, the list can be unpainted, and "not offered — refusing to file"
      // was then a race (measured on the Accela replica: the record-type page had been served,
      // the guard read "(none read)"). Settle on what the page is doing, wait for a control,
      // then count — and when nothing matches, settle and look exactly once more.
      await this.settle(8000);
      await waitForInteractiveControls(this.page, 8000);
      // Exact first. "Residential - Structural" must not resolve through a substring onto
      // "Residential - Structural - Demolition": one unambiguous name, or nothing.
      const exact = this.page.getByRole("checkbox", { name: wanted, exact: true });
      let exactCount = await exact.count().catch(() => 0);
      if (exactCount === 0 && (await this.page.getByRole("checkbox", { name: wanted, exact: false }).count().catch(() => 0)) === 0) {
        await this.settle(4000);
        exactCount = await exact.count().catch(() => 0);
      }
      if (exactCount === 1) {
        await exact.first().check({ timeout: 10000 });
        this.driftWarnings.push(`record type "${wanted}" selected by label (positional fallback refused)`);
        return true;
      }
      const loose = this.page.getByRole("checkbox", { name: wanted, exact: false });
      const looseCount = exactCount > 1 ? exactCount : await loose.count().catch(() => 0);
      if (looseCount === 1) {
        await loose.first().check({ timeout: 10000 });
        this.driftWarnings.push(`record type "${wanted}" selected by label (positional fallback refused)`);
        return true;
      }
      const offered = await this.readOfferedRecordTypes();
      throw new Error(
        looseCount === 0
          ? `Record type "${wanted}" is not offered here — refusing to pick another permit type. `
            + `This jurisdiction offers: ${offered.join("; ") || "(none read)"}. `
            + "A permit type chosen by position files the wrong permit (live: a Residential Mechanical permit on a solar job)."
          : `Record type "${wanted}" matches ${looseCount} of the types offered here — refusing to guess which permit to file. `
            + `This jurisdiction offers: ${offered.join("; ") || "(none read)"}.`,
      );
    }
    if (this.skipForNoBattery(step)) {
      this.agingNotes.push(`skipped "${String(step.note ?? step.field ?? "battery step").slice(0, 48)}" — this project has no battery`);
      return true; // not a failure: the section does not apply to this filing
    }
    // F1 — A kVA TIER BOX IS DECIDED FROM THE PAGE'S OWN LABELS, not from the recorded selector:
    // the recorded label is the DONOR agency's spelling and the recorded box is the DONOR job's
    // tier. See fillFeeTierFromPage.
    if (step.action === "fill" && this.isFeeTierStep(step)) {
      const verdict = await this.fillFeeTierFromPage(step);
      if (verdict !== "normal") return verdict;
    }
    // A POPUP LEFT OPEN BY THE LAST STEP MUST NOT SHADOW THIS ONE.
    //
    // Replay had no Escape anywhere in it; the learner has nine. Same asymmetry that
    // produced the modal, validation-scrape and review-screen bugs before it, and it cost a
    // live PacifiCorp filing its inverter model. The step reported:
    //
    //   select "Model" landed nothing though 49 option(s) were showing
    //     resolved <input id="pcInputBase55" label="Model" visible=false>
    //     list offers "Select...", "Solar PV", "Wind", "Hydro", "Battery Only"
    //
    // Those are Energy Source options. An earlier widget's list was still open, covering the
    // Model control — so resolution found nothing visible and fell through to a hidden node,
    // and the option scan read the wrong list entirely. CLAUDE.md already records the same
    // hazard for date inputs ("pop a picker that must be Escape-dismissed"); replay never
    // dismissed those either, so every replayed date left an overlay on the next control.
    //
    // ONLY WHEN THE CONTROL IS ACTUALLY OUT OF REACH, never pre-emptively. Dismissing before
    // every step would close a list the CURRENT step needs — a recipe is free to record
    // "open the dropdown" and "choose the option" as two steps, and blanket Escapes would
    // break exactly that. Resolving first makes the guard self-limiting: if the target were
    // inside the open popup it would resolve visible, and nothing is dismissed.
    //
    // `let`, not `const`: the upload branch may re-anchor to a different slot once the
    // page's real upload controls have been re-tagged (see the upload case below), and the
    // identity check below may re-anchor a step that resolved onto the wrong control.
    // NO NAME-SCORING FOR CHECK/UNCHECK — the same exclusion narrowToOne needs, for the same
    // reason, through a different door. A styled checkbox or switch keeps its real <input>
    // visually hidden behind a span; the check branch measures that and passes `force`.
    // Scoring candidates by the step's words picks a VISIBLE element instead, `force` switches
    // off, and the click lands on the decoration. Ameren went 73/75 -> 2/75 on exactly that
    // when narrowToOne did it, and again when this hint was added without the same guard.
    const nameHint = (step.action === "check" || step.action === "uncheck")
      ? "" : String(step.note ?? step.field ?? "");
    this.resolvingStep = step;
    let scoped = await this.resolveLocator(step.selector, nameHint).finally(() => { this.resolvingStep = null; });
    // A HIDDEN INPUT IS THE NORMAL STATE FOR A STYLED CHECKBOX, NOT A PROBLEM TO SOLVE.
    //
    // The third door onto the same regression. `isTrulyVisible` correctly calls an opacity:0
    // control hidden — which is exactly what a rounded-pill switch's real <input> is — so
    // `looksOutOfReach` becomes true for every styled checkbox and fires the rescues below,
    // swapping the control out from under a branch that was built to drive the hidden one
    // with `force`. Ameren went 73/75 -> 2/75 three separate ways today: narrowToOne, then
    // the name hint, then this. check/uncheck keep whatever they resolved.
    const isToggle = step.action === "check" || step.action === "uncheck";
    if (!isToggle && (await this.looksOutOfReach(scoped) || await this.overlayShadowsTarget(scoped))) {
      if (await this.dismissStaleOverlays()) scoped = await this.resolveLocator(step.selector);
    }
    // THE SECTION THE LEARNER RECORDED, FINALLY USED.
    //
    // When what we resolved is still not something a person could act on, and the step was
    // recorded with a section, that section is better evidence than any selector: PGE's two
    // "Model" selects differ only by "Inverter Clone System" versus "PV ArrayDelete Array",
    // and that string has been sitting in every such step's fingerprint since the day it was
    // learned. Consulted last, because a working selector needs no rescue.
    if (!isToggle && await this.looksOutOfReach(scoped)) {
      // THE PORTAL'S OWN NAME FOR THE CONTROL FIRST. A test hook is stable across renders and
      // says which side it belongs to; a recorded id is neither.
      // A RESCUE THAT HANDS BACK AN UNUSABLE CONTROL IS NOT A RESCUE.
      //
      // PGE's inverter Model failed on every attempt of the sweep, and the trail said the
      // hook had RESOLVED it — three aging notes saying so in the same run. Both were true:
      // PowerClerk puts data-test-role on the concealed native input, so the hook found the
      // control it names and handed back the same unreachable element the recorded id had.
      // Success was reported, the select then had "no list could be tied to this control",
      // and the recipe lost its Model.
      //
      // So each route has to clear the bar the rescue exists to clear. Otherwise the next
      // one is tried, and when none of them produce something a person could act on, the
      // step keeps its original resolution and SAYS the rescue came up empty.
      const usable = async (loc: unknown): Promise<boolean> =>
        !!loc && await this.isTrulyVisible(loc as never).catch(() => false);
      const byHook = await this.resolveByTestHook(step);
      if (await usable(byHook)) scoped = byHook as never;
      else if (step.fingerprint?.section) {
        const bySection = await this.resolveBySection(step);
        if (await usable(bySection)) scoped = bySection as never;
        else if (bySection || byHook) {
          this.resolveTrail.push(`  ...rescue: ${byHook ? "the test hook" : "the section"} resolved a control that is STILL concealed — the portal puts its hook on the hidden native input; kept the original`);
        }
      } else {
        // SAY WHEN THE RESCUE HAD NOTHING TO WORK WITH. PGE's inverter Model failed here on
        // all three attempts of the sweep, and the trail said only that level 0 was rejected
        // — leaving "the hook found nothing", "the section was missing" and "the rescue never
        // ran" indistinguishable from each other. They need different fixes, and one of them
        // is not a code fix at all: a step carrying no section was recorded that way.
        this.resolveTrail.push(`  ...rescue: control out of reach, no test hook matched ${JSON.stringify(String(step.field ?? step.note ?? "").slice(0, 30))} and the step carries NO recorded section`);
      }
      if (byHook === null && step.fingerprint?.section && await this.looksOutOfReach(scoped)) {
        this.resolveTrail.push(`  ...rescue: no test hook and section ${JSON.stringify(String(step.fingerprint.section).slice(0, 34))} did not resolve either — still out of reach`);
      }
    }
    // NEVER ACT ON AN AMBIGUOUS LOCATOR.
    //
    // Playwright refuses a fill or click whose locator matches more than one element, and it
    // refuses it as a "strict mode violation" — which reads like a selector that has drifted
    // and is nothing of the kind. Accela renders one logical field as several inputs sharing
    // an id fragment: `input[id*='StreetNo4Search']` matches the street-number box, its
    // hidden watermark state, and the "Street Number To" of a range. The recorded selector
    // is perfectly good and names four things.
    //
    // preferVisible already chooses among candidates on the paths that reach it; this is the
    // floor under every path, including the ones that do not. The choice is the same one a
    // person makes — the first that is visible and enabled — and it is made HERE rather than
    // left to Playwright, which would only refuse.
    // NOT FOR CHECK/UNCHECK. A styled checkbox or switch keeps its real <input> visually
    // hidden behind a span, and the check branch below handles that on purpose: it measures
    // whether the input is visible and passes `force` when it is not. Narrowing to the first
    // VISIBLE match hands that branch a different element, `force` switches off, and the
    // click lands on the decoration — "Clicking the checkbox did not change its state".
    // Ameren went from 73 of 75 steps to 2 on exactly that, one commit after this was added.
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
    // NARROW AT THE POINT OF ACTION, because everything above can widen it again.
    //
    // The earlier narrowing ran before the identity check, which RE-ANCHORS by label when a
    // recorded id turns out to point at the wrong control — and a label re-anchor is exactly
    // the kind of locator that matches several elements. So Coos Bay's street number came
    // back as a strict-mode violation on `input[id*='StreetNo4Search']` (4 matches: the box,
    // its hidden watermark state, and a range's "To") after the narrowing had already
    // happened and been undone. Narrowing once, last, is the only placement that holds
    // against every path above it.
    if (step.action !== "check" && step.action !== "uncheck") {
      scoped = await this.narrowToOne(scoped, step);
    }
    switch (step.action) {
      case "goto": {
        // F3 — DOMCONTENTLOADED, NOT LOAD. Live run 99baa5d0: the entry goto was answered with
        // Accela's Error.aspx, blank, whose subresources never finished — `load` waited out its
        // budget on a page nobody could use, then the interactive-controls wait burned 12 s more
        // on a page with no controls (50.9 s for step 0). The document is enough to READ the page;
        // an error landing is then recognised at once and re-entered (recoverFromPortalErrorPage),
        // and only a real page is given the controls wait.
        const target = this.resolveValue(step);
        const why = `recipe goto${step.note ? ` (${String(step.note).slice(0, 40)})` : ""}`;
        await this.withProgress("goto", `Opening ${String(step.note ?? "the recipe's page").slice(0, 40)}`, () => this.guardedGoto(target, why, { waitUntil: "domcontentloaded", timeout: 30000 }));
        const landedOnError = await this.recoverFromPortalErrorPage(target, why);
        await smartWait(this.page);
        // A recorded goto lands on a fresh section that a Vue/SPA portal may still be mounting.
        // Wait until an interactive control is up so the next step's fill targets a bound input
        // (best-effort; never skips — the retry/reload loop still recovers a genuine miss). Not on
        // an error page that could not be left: there is nothing to wait for there. And only the
        // FULL budget when the next step types into something: a dashboard (Accela's has links and
        // no inputs) burned the whole 12 s on every entry (measured 12.7 s on the replica) before
        // a click whose own locator wait covers its target anyway.
        if (!landedOnError) {
          const next = this.recipe.steps[this.currentStepIdx + 1];
          const nextTypes = !!next && ["fill", "select", "check", "uncheck", "upload", "press"].includes(String(next.action));
          await this.withProgress("wait", "Waiting for the page's controls to appear", () => waitForInteractiveControls(this.page, nextTypes ? undefined : 3000));
        }
        return true;
      }
      case "click":
        return this.executeClick(step, scoped, pastReview);
      case "fill": {
        let v = this.resolveValue(step);
        // THE ONE SIGNER RULE, READ LIVE (portal-run-close 1). isSignatureStep sees only what
        // the recipe recorded; a box that is a signature only by the statement above it ("Type
        // your full name" under "I certify under penalty of perjury…") has an ordinary label, and
        // an older recipe learned before this rule may have it bound to installerContactName —
        // replay would sign as the contact. The in-page reading the learner uses
        // (signatureStepInPage, which marks the control data-al-sig) is asked about THIS control:
        // a signature box takes the client's authorized signer or nobody.
        const live = isSignatureStep(step) ? null : await this.liveSignatureBoxOf(scoped);
        if (live) {
          const full = String(this.fieldValues.authorizedSignerName ?? "").replace(/\s+/g, " ").trim();
          // A split signature box (First / Last name under a signing statement) takes that part.
          const signer = live.part ? splitSignerName(full, live.part) : full;
          const what = String(step.selector?.label ?? step.note ?? "signature").slice(0, 60);
          this.driftWarnings.push(`e-signature box read on the page ("${what}") on a step bound to ${step.field ? step.field : "a recorded literal"} — ${signer ? `typed as the client's authorized signer${live.part ? ` (${live.part} name)` : ""} instead` : full ? "the authorized signer's name cannot be split into first and last, nothing typed" : "no authorized signer, nothing typed"}`);
          if (!signer) { this.liveSignaturePause = what; return false; }
          v = signer;
        }
        if (!v) { this.noteUnresolved(step); return false; }
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
        // COMMIT THE VALUE, THEN WAIT FOR WHAT THE COMMIT STARTED. locator.fill() fires
        // `input` only — no `change`, no blur — so a portal that saves (PowerClerk's Vue) or
        // cascades/postbacks (ASP.NET autopostback) on change never hears it. commitField blurs
        // (Tab as the fallback) and then settles on what the page is doing — PageRequestManager
        // begin/end, a postback just begun, requests, DOM quiet — so autopostback fields go
        // strictly ONE AT A TIME (overlapping UpdatePanel postbacks are last-wins).
        await this.commitAndSettle(scoped);
        // A data-bound value can carry a unit suffix ("225A") that a decimal field (e.g.
        // PowerClerk "Amps") rejects with "Please enter a valid decimal number." Retry once
        // with a bare number so replayed recipes don't re-introduce the invalid value.
        if (await hasNumericValidationError(scoped)) {
          const bare = toBareNumber(v);
          if (bare && bare !== v) {
            await scoped!.fill(bare);
            await this.commitAndSettle(scoped);
          }
        }
        // READ IT BACK, BECAUSE TYPING IS NOT SAVING.
        //
        // This returned true the moment .fill() resolved — success meant "we typed", never
        // "it stuck". Two lines below, the SELECT path does the opposite: it waits for the
        // autosave to finish and returns `selected` honestly, with a comment explaining
        // that skipping the wait lets a server re-render restore the old value. Fill both
        // started that autosave and walked away from it.
        //
        // A live PacifiCorp replay reported success on "Total System Export (kW)" and the
        // portal's own screenshot shows the box empty with a required error under it. On
        // that evidence a fill's return value said nothing at all.
        //
        // A miss returns false, which lands the step in `skipped` — visible to the operator
        // and a gap to the benchmark, rather than a clean run over a lost value.
        await this.waitForAutosaveCommitted();
        const fieldName = String(step.note ?? step.field ?? step.action).slice(0, 60);
        // ONE readback, not two: asking twice costs a round-trip and can disagree with itself.
        const held = await this.fillHeld(scoped, v);
        if (held && !this.fieldsVerified.includes(fieldName)) this.fieldsVerified.push(fieldName);
        if (!held) {
          // ONE RETRY, BY THE SAME ROUTE AS THE FIRST ATTEMPT. A masked control keeps its
          // validation state from KEY events, so retrying it with .fill() would fail the
          // way the first attempt was written to avoid — and report a miss caused by the
          // retry rather than by the portal.
          if (maskedStep && typeof scoped!.pressSequentially === "function") {
            if (typeof scoped!.focus === "function") await scoped!.focus().catch(() => null);
            await scoped!.fill("").catch(() => null);
            await scoped!.pressSequentially(v, { delay: 35 }).catch(() => null);
          } else {
            await scoped!.fill(v, { timeout: FILL_TIMEOUT_MS }).catch(() => null);
          }
          await this.commitAndSettle(scoped);
          await this.waitForAutosaveCommitted();
          if (!(await this.fillHeld(scoped, v))) {
            // RE-ASSERTED ONCE WITH A PROPER COMMIT AND IT STILL DID NOT HOLD: the portal is
            // re-rendering the value away (a contact block patched from saved state) or the
            // fill landed somewhere else. A FAILED step with its reason — never a silent accept,
            // and never a loop.
            this.driftWarnings.push(`FAILED "${String(step.note ?? step.action).slice(0, 48)}": did not hold after commit + settle and one re-assert — read back from the intended control it shows something else (re-render wipe or a write that landed elsewhere)`);
            if (!this.fieldsUnverified.includes(fieldName)) this.fieldsUnverified.push(fieldName);
            return false;
          }
          // The retry held: verified after all.
          if (!this.fieldsVerified.includes(fieldName)) this.fieldsVerified.push(fieldName);
        }
        return true;
      }
      case "select": {
        const v = this.resolveValue(step);
        if (!v) { this.noteUnresolved(step); return false; }
        // TWO "Manufacturer" SELECTS, ONE LABEL — THE FIELD NAME CARRIES THE SIDE.
        //
        // PowerClerk's spec block renders the INVERTER's Manufacturer/Model and, nested
        // inside it, the PV ARRAY's — identical bare labels. A label-resolved step lands on
        // whichever comes first, so the module step overwrote the inverter's pick: the
        // operator watched "AP Systems" go in and be replaced by "Znshine PV-Tech", after
        // which the inverter Model had nothing valid to cascade from. The step's own field
        // name says which side it belongs to; when the label matches several controls, use
        // it — inverter is the outer (first) pair, module/array the inner (later) one.
        if (scoped) {
          // AN INVISIBLE CONTROL IS NEVER THE ONE THE USER SEES. The recorded primary is a
          // volatile per-render id; on a fresh project #pcInputBase55 resolved to a HIDDEN
          // combobox input whose nearby list was the ENERGY SOURCE options ("Solar PV",
          // "Wind", "Hydro") — its label also reads "Model", so the identity check passed,
          // the model rules rightly refused those options, and the real visible Model select
          // sat untouched. So: among everything the selector matches, only VISIBLE controls
          // are candidates, and when several remain, the step's field name picks the side —
          // inverter is the outer (first) pair, module/array the inner (later) one.
          const nMatches = await scoped.count?.().catch(() => 0);
          const canProbe = typeof scoped.nth === "function"
            && typeof scoped.first?.().isVisible === "function"; // test fakes have neither
          if (nMatches >= 1 && canProbe) {
            const visible: number[] = [];
            for (let k = 0; k < Math.min(nMatches, 8); k++) {
              if (await scoped.nth(k).isVisible().catch(() => false)) visible.push(k);
            }
            if (visible.length >= 1) {
              const firstVisible = visible[0];
              const wantsArray = Boolean(step.field) && /^(module|pvMicro|array\d*Module)/i.test(String(step.field));
              const pick = wantsArray ? visible[visible.length - 1] : firstVisible;
              const firstIsVisible = await scoped.first().isVisible().catch(() => false);
              if (pick !== 0 || !firstIsVisible) {
                this.driftWarnings.push(`"${this.stepLabel(step)}" — ${nMatches} match(es), ${visible.length} visible; took visible #${pick}${step.field ? ` for ${step.field}` : ""}`);
                scoped = scoped.nth(pick);
              }
            }
          }
        }
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
        /** The exact value the select landed as (a model listing, a certified alias) — what the
         *  read-back compares against. */
        let landedAs = v;
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
            if (selected) landedAs = picked;
            if (selected && picked !== v) this.driftWarnings.push(`model "${v}" matched the portal's listing "${picked}"`);
          } else {
            // No safe match on a list that IS loaded. Leave it blank for the human rather
            // than let the generic contains-match choose a neighbouring model for us —
            // asked for "DS3-L" it would take "DS3-LV {120V}" and report success.
            this.driftWarnings.push(`model "${v}" has no unambiguous match in this dropdown — left blank for review`);
            await this.settle(4000);
            return false;
          }
        }
        if (!selected) {
          const r = await this.trySelect(scoped, v, step);
          selected = r.selected;
          if (selected && r.how === "meaning") landedAs = r.landedAs;
        }
        // A MANUFACTURER dropdown lists CEC certified names, not the plan set's wording.
        // Retry the certified aliases before giving up — the learner has always done this,
        // and without it a select lands nothing, returns false, and is SKIPPED silently.
        if (!selected && this.isManufacturerStep(step)) {
          for (const alt of equipmentMakeCandidates(v).slice(1)) {
            selected = (await this.trySelect(scoped, alt, step)).selected;
            if (selected) {
              landedAs = alt;
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
                {
                  const r = await this.trySelect(relox.first(), v, step);
                  selected = r.selected;
                  if (selected && r.how === "meaning") landedAs = r.landedAs;
                }
                if (!selected && this.isManufacturerStep(step)) {
                  for (const alt of equipmentMakeCandidates(v).slice(1)) {
                    selected = (await this.trySelect(relox.first(), alt, step)).selected;
                    if (selected) { landedAs = alt; this.driftWarnings.push(`manufacturer "${v}" matched the portal's certified name "${alt}"`); break; }
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
        await this.settle(4000);
        // WHY DID IT MISS? A select that lands nothing is reported as a bare SKIP, and
        // "the widget never opened" and "it opened but this value is not in it" need
        // completely different fixes. Live PacifiCorp skipped both equipment Model steps
        // after 26 seconds each, on a control the diagnostic showed as visible=false — and
        // there was no way to tell which of the two had happened. Only paid for on a miss.
        if (!selected) {
          const seen = await this.visibleOptionSample(scoped);
          const resolved = await this.describeResolved(step, scoped);
          this.driftWarnings.push(
            seen.count === 0
              ? `select "${String(step.note ?? step.field ?? "")}" landed nothing and NO option list was open — the widget never opened (wanted ${JSON.stringify(v.slice(0, 40))}; resolved ${resolved})`
              : `select "${String(step.note ?? step.field ?? "")}" landed nothing though ${seen.count} option(s) were showing — wanted ${JSON.stringify(v.slice(0, 40))}, resolved ${resolved}, ${seen.scoped ? "ITS OWN list offers" : "no list could be tied to this control; the PAGE shows"} ${seen.sample.map((o) => JSON.stringify(o)).join(", ")}`,
          );
          // HOW THAT CONTROL WAS CHOSEN. The line above says WHICH control the step landed
          // on; this says which candidates were considered and why each was taken or passed
          // over. Four fixes at PGE's "Model" were shipped without it, each answering a
          // question about a branch that was never entered, and four live runs went into
          // discovering that. Only emitted on a miss.
          if (this.resolveTrail.length) {
            this.driftWarnings.push(`  ...how it resolved: ${this.resolveTrail.join(" | ").slice(0, 400)}`);
          }
          // KEEP THE PAGE ON A MISS, NOT ONLY ON A FAILURE. A select that lands nothing does
          // not throw — it returns false and the run carries on — so the page it happened on
          // was never saved, and answering "what does that dropdown actually contain" cost a
          // live run every time. Capturing here makes the equipment page readable offline the
          // way the failure captures already made Accela's readable.
          try {
            const dir = this.pageShotDir || path.join(replayCaptureRoot(), "replay-failures");
            const safe = String(step.note ?? step.field ?? "select").replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
            await this.writeSanitizedCapture(dir, `miss-${safe}-${String(Date.now())}`, { target: scoped });
          } catch { /* diagnostics never change the outcome */ }
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
          } catch { /* commit is best-effort — never fail a landed select over it */ }
          // Blur + settle: a cascade / autopostback this select started finishes before the
          // next step runs (one at a time — overlapping postbacks are last-wins).
          await this.commitAndSettle(scoped);
        }
        // The blur STARTS the autosave; the next step must not run until it FINISHES, or the
        // server re-render restores the old value ("Saving..." caught on the final screenshot,
        // the inverter manufacturer empty again after every pass).
        if (selected) await this.waitForAutosaveCommitted();
        // READ IT BACK FROM THE INTENDED CONTROL — the selected option's text/value, after the
        // commit settled. selectWithFallback's "true" means "I clicked an option"; an autopostback
        // that re-rendered the panel, or a pick that landed on another widget, shows up only
        // here. A mismatch is re-asserted ONCE with the proper commit, then it is a failed step.
        if (selected) {
          const held = await this.selectionHeld(scoped, landedAs);
          if (held === false) {
            const again = await selectWithFallback(this.page, scoped, landedAs).catch(() => false);
            if (again) await this.commitAndSettle(scoped);
            await this.waitForAutosaveCommitted();
            if ((await this.selectionHeld(scoped, landedAs)) !== true) {
              this.driftWarnings.push(`FAILED select "${String(step.note ?? step.field ?? "").slice(0, 48)}": the control does not show ${JSON.stringify(landedAs.slice(0, 40))} after commit + settle and one re-assert (re-rendered away, or the pick landed on another control)`);
              selected = false;
            } else {
              this.agingNotes.push(`select "${String(step.note ?? step.field ?? "").slice(0, 40)}" needed a second commit to hold — the portal re-rendered it once`);
            }
          }
        }
        const selName = String(step.note ?? step.field ?? step.action).slice(0, 60);
        if (selected) { if (!this.fieldsVerified.includes(selName)) this.fieldsVerified.push(selName); }
        else if (!this.fieldsUnverified.includes(selName)) this.fieldsUnverified.push(selName);
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
        // THE SAME NOTION OF VISIBLE THE REST OF THIS FILE USES.
        //
        // `usable` decides `force` below, and it asked PLAYWRIGHT — which counts an opacity:0
        // or 1x1 control as VISIBLE. A rounded-pill switch's real <input> is exactly that, so
        // usable came back true, force was switched off, and check() issued a real click that
        // the styled widget swallows: "Clicking the checkbox did not change its state", which
        // is precisely how Ameren's terms switch failed. Everything else in this file was
        // moved onto isTrulyVisible for this exact divergence; this call was missed.
        const usable = present ? await this.isTrulyVisible(scoped.first()) : false;
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
        try {
          await target!.check({ force: !usable });
        } catch (err) {
          // "CLICKING THE CHECKBOX DID NOT CHANGE ITS STATE" IS NOT A MISSING CONTROL.
          //
          // Playwright resolved the input, forced the click, and reported the click done —
          // and the box stayed unticked. That is the styled widget this branch already
          // describes two comments up, seen from the other end: the real <input> is
          // concealed under a styled span and the page's handler lives on the LABEL, so a
          // click delivered to the input itself is delivered to something nothing listens
          // to. Live in the reliability sweep, Ameren Illinois lost a whole run to it on
          // step 2 of 75 — the Terms and Conditions box, on the first page of the form.
          //
          // So click what a person clicks. Verified by reading the state back, and it
          // re-throws the ORIGINAL error when the label route does not work either, because
          // a checkbox that cannot be ticked must still fail the run.
          const viaLabel = await this.checkViaLabel(target).catch(() => false);
          if (!viaLabel) throw err;
          this.agingNotes.push(`"${String(step.note ?? "checkbox").slice(0, 40)}" would not tick from the input — ticked it by its label, which is how a styled checkbox is driven`);
        }
        // Same settle for checkbox changes that may trigger form re-renders.
        await this.settle(3000);
        return true;
      }
      case "uncheck":
        await waitForElement(scoped);
        await scoped!.uncheck();
        return true;
      case "press":
        await waitForElement(scoped);
        await this.guardedPress(scoped, step.value || "Enter", `recipe press${step.note ? ` (${String(step.note).slice(0, 40)})` : ""}`);
        return true;
      case "waitFor":
        if (scoped) await scoped.waitFor({ state: "visible", timeout: 15000 });
        else await smartWait(this.page);
        return true;
      case "upload": {
        const recordedLabel = String(step.note ?? "").split(":").slice(1).join(":").trim();
        const requiredType = exactUploadDocType(recordedLabel);
        if (requiredType && step.docType !== requiredType) {
          this.driftWarnings.push(`refused ${step.docType || "unbound file"} for "${recordedLabel.slice(0, 60)}"; this slot requires ${requiredType}`);
          this.noteUnresolved(step);
          return false;
        }
        const filePath = step.docType ? this.docsByType[step.docType] : undefined;
        if (!filePath) { this.noteUnresolved(step); return false; }
        // Attach under a CLEAN filename: stored files carry a UUID prefix for on-disk
        // uniqueness that must not leak into what the portal reviewer sees.
        // The slot may refuse the image but take a PDF — PacifiCorp asks for a photo of the
        // meter and accepts only .docx/.pdf. Read the live control's own accept list rather
        // than trusting what it declared when this was recorded.
        const liveAccept = await this.page.evaluate((sel: string) => {
          const el = sel ? document.querySelector(sel) : null;
          const input = el && (el as HTMLElement).tagName === "INPUT" ? el : el?.querySelector('input[type="file"]');
          return (input?.getAttribute("accept") || "");
        }, step.selector?.css ?? "").catch(() => "");
        const pdfBuf = shouldConvertToPdf(filePath, liveAccept, fileTypeAllowed(filePath, liveAccept))
          ? await imageToPdfBytes(filePath).catch(() => null)
          : null;
        // The SAME payload builder the unrecorded-upload sweep uses (uploadPayload.ts).
        const file = this.stageUpload(uploadPayloadFor(filePath, pdfBuf, step.docType ? this.uploadNames.get(step.docType) : undefined));
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
          // TAG AFTER THE CONTROLS MOUNT — AND NEVER WAIT ON AN ATTRIBUTE NOTHING WILL SET.
          //
          // This tagged ONCE and then setInputFiles waited 30 s (per retry) for [data-al-upl="f0"].
          // A client-rendered step (the SPA shows a spinner, then mounts its file slots) had no
          // file input at tag time, so the tag never existed: 7 of 8 SPA cells died on "upload
          // plan_set" at ~174 s each (replay skeptic, evidence/step022-upload-plan-set-*). Now the
          // tag is re-taken in a bounded poll until the slot the step names is there; if it never
          // appears, the step is skipped NAMED within seconds, and the document goes to no other
          // slot (a differently labelled slot is never a fallback).
          const wanted = String(step.note ?? "").split(":").slice(1).join(":").trim();
          const norm = (v: string) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          const want = norm(wanted);
          const recordedCss = step.selector.css;
          const pick = (slots: Array<{ key: string; label: string }>) => want
            ? (slots.find((sl) => norm(sl.label) === want)
              ?? slots.find((sl) => want.length > 6 && !!norm(sl.label) && (norm(sl.label).includes(want) || want.includes(norm(sl.label)))))
            : slots.find((sl) => `[data-al-upl="${sl.key}"]` === recordedCss);
          const started = Date.now();
          let slots: Array<{ key: string; label: string }> = [];
          let hit: { key: string; label: string } | undefined;
          for (;;) {
            slots = (await this.page.evaluate(tagUploadControls).catch(() => null) as Array<{ key: string; label: string }> | null) ?? [];
            hit = pick(slots);
            if (hit || Date.now() - started >= RecipeAdapter.UPLOAD_SLOT_WAIT_MS) break;
            await this.settle(1500);
            await sleep(400);
          }
          if (!hit) {
            // The recorded index is a fallback only for a slot with no label of its own to
            // contradict the step's (an unlabelled Browse box); never for a differently labelled one.
            const recorded = slots.find((sl) => `[data-al-upl="${sl.key}"]` === recordedCss);
            const recordedLabel2 = norm(recorded?.label ?? "");
            if (!recorded || (want && recordedLabel2 && recordedLabel2 !== "document")) {
              const secs = Math.round((Date.now() - started) / 100) / 10;
              this.driftWarnings.push(`upload "${wanted.slice(0, 48) || recordedCss}" has no matching file slot on this page after ${secs}s (${slots.length} slot(s): ${slots.map((s) => s.label.slice(0, 30)).join(" | ") || "none"}) — not attached, and not attached to any other slot`);
              this.noteUnresolved(step);
              return false;
            }
          } else if (`[data-al-upl="${hit.key}"]` !== recordedCss) {
            this.agingNotes.push(`upload "${wanted.slice(0, 48)}" moved from ${recordedCss} to slot ${hit.key} — re-anchored by label`);
          }
          scoped = await this.locator({ css: hit ? `[data-al-upl="${hit.key}"]` : recordedCss });
        }
        if (step.viaFileChooser) {
          // The real <input> is created on click — intercept the file-chooser dialog.
          const [chooser] = await Promise.all([
            this.page.waitForEvent("filechooser", { timeout: 8000 }),
            this.guardedClick(scoped, "open the recorded upload chooser", { timeout: 6000 }),
          ]);
          this.options.beforeUpload?.(step.docType!, filePath);
          await chooser.setFiles(file);
          await this.markRecordedUpload(scoped, chooser);
          await this.waitForUploadAccepted();
          this.noteUploadPerformed(recordedLabel, file, step.docType); if (step.docType) this.uploadedDocTypes.add(step.docType);
          return true;
        }
        this.options.beforeUpload?.(step.docType!, filePath);
        // Bounded: the slot was just found (or the selector is a recorded css the page has); a
        // 30 s default wait here is a hang, not patience.
        await scoped!.setInputFiles(file, { timeout: 8000 });
        await this.markRecordedUpload(scoped, null);
        await this.waitForUploadAccepted();
        this.noteUploadPerformed(recordedLabel, file, step.docType); if (step.docType) this.uploadedDocTypes.add(step.docType);
        return true;
      }
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // THE CHOKEPOINT. Replay performs no click, press or goto that did not pass guardAction.
  //
  // Before this, the gates lived in executeClick alone, so every other door onto the page — the
  // drift-seek click-through, the address-row picker, the rejection-repair Submit, a goto to
  // whatever URL a recipe resolved to — went round them. The drift-seek loop clicked "Continue
  // Application" on Accela's read-only review page, where that link FILES (the scoreboard's
  // isolated tripwire recorded the filing POST). Page-aware on purpose: a label alone cannot tell
  // Accela's two meanings of "Continue Application" apart; the page it sits on can.
  //
  // recipeAdapter.test.ts reads this file and fails on any .click( / .press( / .goto( outside
  // the three guarded helpers below.
  // ---------------------------------------------------------------------------------------------

  /** Registrable-domain-ish key of a URL: the last two host labels (three under a two-letter
   *  second level such as co.uk), the whole host for an IP or a single-label host. */
  private static siteOf(url: string): string {
    return siteOfUrl(url);
  }

  // ---------------------------------------------------------------------------------------------
  // docs plan D7 / D4: every owed document through the page's own attachment row, and the ledger.
  // ---------------------------------------------------------------------------------------------

  /** The recorded ATTACHMENT ROW whose commit is step `commitIdx` — ONLY a row the learner itself
   *  recorded as an attachment row (accelaAttachmentSavePass: phase "upload", notes "attachment: …"):
   *  the upload before it on the same page, and that row's "attachment: description" / "attachment:
   *  document type" steps. Any other Description / Type / Save is an ordinary form field and never
   *  carries a document (skeptic 21d2502 MF1: a "Description of Work" + "Work Type" + Save page had
   *  its description overwritten, a field retyped and its Plan Set slot given the E-01). */
  private recordedAttachmentRow(commitIdx: number): { upload: RecipeStep; desc: RecipeStep | null; type: RecipeStep | null } | null {
    const steps = this.recipe.steps;
    const commit = steps[commitIdx];
    const stamped = (s: RecipeStep | undefined, re: RegExp): boolean => !!s && re.test(String(s.note ?? "").trim());
    if (!stamped(commit, /^attachment:\s*save\b/i)) return null;
    let desc: RecipeStep | null = null;
    let type: RecipeStep | null = null;
    for (let i = commitIdx - 1; i >= 0 && i >= commitIdx - 8; i--) {
      const s = steps[i];
      if (!s) break;
      if (s.action === "goto" || (s.action === "click" && /^advance\b/i.test(String(s.note ?? "")))) return null;
      if (s.action === "upload") return s.docType ? { upload: s, desc, type } : null;
      if (s.action === "fill" && !desc && stamped(s, /^attachment:\s*description\b/i)) desc = s;
      else if (s.action === "select" && !type && stamped(s, /^attachment:\s*document\s*type\b/i)) type = s;
    }
    return null;
  }

  /** The live options of the row's DOCUMENT-TYPE select — the select whose options read as document
   *  types (the learner's own test: "Plans - …", "Calculations", "Photos", "Forms"), the newest one.
   *  Never simply the last select: a real Accela row carries a second one after it ("also attach to",
   *  only "--Select--" — skeptic MF3). [] = no such select on the page yet. */
  private async typeOptionsOf(_typeStep: RecipeStep): Promise<string[]> {
    const got = await this.page.evaluate(() => {
      const lists = Array.from(document.querySelectorAll("select")).map((el) => Array.from((el as HTMLSelectElement).options).map((o) => String(o.textContent || o.label || "").replace(/\s+/g, " ").trim()));
      // The learner's own test (autoLearnAdapter.accelaAttachmentSavePass isDocType) — never "Other"
      // alone: a "Category of Construction" select offers "Other" too (skeptic 13985c6 S5).
      const typed = lists.filter((opts) => opts.length > 2
        && (opts.some((t) => /plans?\s*[-–—]/i.test(t)) || opts.some((t) => /^(plans|calculations|photos?|forms?)\b/i.test(t))));
      return typed.length ? typed[typed.length - 1] : [];
    }).catch(() => [] as string[]) as string[];
    return Array.isArray(got) ? got : [];
  }

  /** A PENDING attachment row is on the page: a document-type select (the same test as typeOptionsOf)
   *  that holds a chosen Type. Accela removes the row on Save; a static-row widget resets it; a refused
   *  Save leaves it holding its Type. */
  private async pendingAttachmentRow(): Promise<boolean> {
    return await this.page.evaluate(() => Array.from(document.querySelectorAll("select")).some((el) => {
      const sel = el as HTMLSelectElement;
      const opts = Array.from(sel.options).map((o) => String(o.textContent || o.label || "").replace(/\s+/g, " ").trim());
      const docType = opts.length > 2 && (opts.some((t) => /plans?\s*[-–—]/i.test(t)) || opts.some((t) => /^(plans|calculations|photos?|forms?)\b/i.test(t)));
      const chosen = String(sel.value || "").trim() && !/^\s*-*\s*(select|choose)/i.test(String(sel.selectedOptions?.[0]?.textContent || ""));
      return docType && !!chosen;
    })).catch(() => false) as boolean;
  }

  /** Is this file in the portal's COMMITTED attachment list? Only the list counts (skeptic 13985c6
   *  S1/S3/S7b): Accela's pending row prints "File: <name>" in the main page before Save, and a name in
   *  an instructions paragraph is not an attachment. Listed = a whole-name match in the attachment-list
   *  frame (FileUpload/AttachmentsList.aspx), or inside a TABLE ROW of >= 3 cells that holds no form
   *  control (a list row, never the pending row). Each frame's read is bounded (3 s); a frame that
   *  never navigated (no URL) is skipped. */
  private async pageListsFile(fileName: string): Promise<boolean> {
    if (!fileName) return false;
    type FrameLike = { evaluate: (fn: unknown, arg: unknown) => Promise<unknown>; url?: () => string };
    const frames: FrameLike[] =
      typeof (this.page as { frames?: () => unknown[] }).frames === "function" ? ((this.page as { frames: () => unknown[] }).frames() as never) : [this.page as never];
    for (const [i, f] of frames.entries()) {
      const url = typeof f.url === "function" ? String(f.url() ?? "") : "";
      if (i > 0 && !url) continue;
      const listFrame = /attachments?list|documentlist/i.test(url);
      const read = f.evaluate(({ n, whole }: { n: string; whole: boolean }) => {
        const want = n.toLowerCase();
        const texts: string[] = [];
        if (whole) texts.push(String(document.body?.innerText || "").toLowerCase());
        else {
          for (const tr of Array.from(document.querySelectorAll("tr"))) {
            if (tr.querySelectorAll(":scope > td").length < 3) continue;
            if (tr.querySelector("select, textarea, input[type=file]")) continue;
            texts.push(String((tr as HTMLElement).innerText || "").toLowerCase());
          }
        }
        for (const t of texts) {
          let at = t.indexOf(want);
          while (at >= 0) {
            const before = at === 0 ? "" : t[at - 1];
            const after = t[at + want.length] ?? "";
            if (!/[a-z0-9._-]/.test(before) && !/[a-z0-9_-]/.test(after)) return true;
            at = t.indexOf(want, at + 1);
          }
        }
        return false;
      }, { n: fileName, whole: listFrame }).catch(() => false);
      const hit = await Promise.race([read, sleep(3000).then(() => false)]);
      if (hit) return true;
    }
    return false;
  }

  /** ATTACH EVERY OWED DOCUMENT THROUGH THE RECORDED ROW (docs plan D7). For each document the
   *  backend says this filing owes (the AHJ's required list for THIS track, on file) that the
   *  recording never uploads: its Type is chosen by the DOCUMENT against the row's live options
   *  (attachmentTypes.ts; never the owner-builder "Homeowner Acknowledgement") BEFORE anything is
   *  uploaded — no fitting Type, nothing attached, named; then the recorded upload → Description →
   *  Type → the same commit click, and the page's list must show it. Never on the review page. Each
   *  outcome goes to the ledger (D4), which the approved final submit refuses on while anything owed
   *  is not attached. */
  private async attachOwedDocuments(row: { upload: RecipeStep; desc: RecipeStep | null; type: RecipeStep | null }, commitStep: RecipeStep): Promise<void> {
    if (!this.page || typeof this.page.evaluate !== "function") return;
    const recorded = new Set(this.recipe.steps.filter((s) => s.action === "upload" && s.docType).map((s) => String(s.docType)));
    const owed = (this.options.owedAttachments ?? []).filter((o) => o && o.docType && o.docType !== "__unreadable__" && !recorded.has(o.docType) && !this.owedAttempted.has(o.docType));
    if (!owed.length) return;
    const at = await this.pageSafetyContext();
    if (at.reviewPage === true) return; // the review page is never written to (acfcd99 rule 4b)
    // NEVER ON TOP OF AN UNSAVED ROW (skeptic 13985c6 S2): when the recorded row's own Save was not
    // confirmed by the list, or a document-type row still holds a Type, an owed upload would add a
    // second row and its Description / Type would be written onto the first (the plan set's). Nothing
    // is attached; every owed document is named.
    const rowDoc = String(row.upload.docType ?? "");
    if ((rowDoc && this.unconfirmedDocTypes.has(rowDoc)) || await this.pendingAttachmentRow()) {
      const why = rowDoc && this.unconfirmedDocTypes.has(rowDoc)
        ? `the recorded ${rowDoc.replace(/_/g, " ")} upload on that page was not confirmed on the portal's list`
        : "an attachment row on that page still holds an unsaved Type";
      for (const o of owed) {
        this.owedAttempted.add(o.docType);
        const l = String(o.label || o.docType).replace(/\s+/g, " ").trim();
        this.attachmentLedger.push({ docType: o.docType, label: l, status: "not attached", detail: `not tried: ${why}` });
        this.driftWarnings.push(`NOT ATTACHED: ${l} — not tried, because ${why}. Check the attachment step and attach it by hand before submitting.`);
      }
      return;
    }
    const slotLabel = String(row.upload.note ?? "").split(":").slice(1).join(":").trim();
    for (const o of owed) {
      this.owedAttempted.add(o.docType);
      const label = String(o.label || o.docType).replace(/\s+/g, " ").trim();
      const filePath = this.docsByType[o.docType];
      const fail = (detail: string): void => {
        this.attachmentLedger.push({ docType: o.docType, label, status: "not attached", detail });
        this.driftWarnings.push(`NOT ATTACHED: ${label} — ${detail}. Attach it by hand on the portal's attachment step before submitting.`);
      };
      if (!filePath) { fail("no file of it is on hand for this filing"); continue; }
      // The Type is read from the row's LIVE options. Where the row already shows its Type control, the
      // choice is made before anything is uploaded. Accela builds the row — and its Type select — only
      // AFTER a file is added (live run 090fa574, Oregon ePermitting: "no options read", the E-01 never
      // went up), so there the choice is made on the new row right after the upload, and a row no Type
      // fits is never saved (below).
      let pick = "";
      if (row.type) {
        const early = await this.typeOptionsOf(row.type);
        if (early.length) {
          pick = attachmentTypeFor(o.docType, early) ?? "";
          if (!pick) { fail(`no Type on the portal's list fits it (${early.filter(Boolean).slice(0, 10).join(", ")})`); continue; }
        }
      }
      this.uploadNames.set(o.docType, label);
      const fileName = (() => { const p = uploadPayloadFor(filePath, null, label); removeUploadStaging(p.tempDir); return typeof p.file === "string" ? path.basename(p.file) : p.file.name; })();
      if (await this.pageListsFile(fileName)) {
        this.attachmentLedger.push({ docType: o.docType, label, status: "already listed", detail: `"${fileName}" is already on the portal's list` });
        this.agingNotes.push(`owed document already listed on the portal: ${label} ("${fileName}") — not attached twice`);
        continue;
      }
      await this.waitForLoadingMaskClear(`attaching ${label.slice(0, 40)}`);
      const uploaded = await this.executeStep({ ...row.upload, docType: o.docType, note: `upload ${o.docType}: ${slotLabel}` }, false).catch(() => false);
      if (!uploaded) { fail("the page's file control did not take it"); continue; }
      // THE ROW IS NOW ON THE PAGE, UNSAVED. Anything that stops here leaves it pending, and the NEXT
      // document's Save would commit it under that document's Description and Type — so a failure from
      // here on stops the whole pass, and every owed document still to go is named.
      const abandon = (detail: string): void => {
        // "Not confirmed", never "unsaved": the Save may have gone through while the list did not show it
        // in time (skeptic 13985c6 S5) — telling a person to attach it again would duplicate it.
        fail(`${detail} — NOT CONFIRMED: look at the portal's attachment list first; attach it only if it is not listed (and remove any half-finished row)`);
        for (const rest of owed.slice(owed.indexOf(o) + 1)) {
          if (this.owedAttempted.has(rest.docType)) continue;
          this.owedAttempted.add(rest.docType);
          const l2 = String(rest.label || rest.docType).replace(/\s+/g, " ").trim();
          this.attachmentLedger.push({ docType: rest.docType, label: l2, status: "not attached", detail: `not tried: the row for ${label.slice(0, 60)} was left unsaved on that page` });
          this.driftWarnings.push(`NOT ATTACHED: ${l2} — not tried, because the row for ${label.slice(0, 60)} was left unsaved on that page. Attach it by hand before submitting.`);
        }
      };
      if (row.type && !pick) {
        const late = await this.waitTypeOptions(row.type, RecipeAdapter.ATTACH_ROW_WAIT_MS);
        pick = attachmentTypeFor(o.docType, late) ?? "";
        if (!pick) { abandon(`no Type on the portal's list fits it (${late.filter(Boolean).slice(0, 10).join(", ") || "no Type control appeared on its row"})`); return; }
      }
      if (row.desc) await this.executeStep({ ...row.desc, value: label.slice(0, 200) }, false).catch(() => false);
      if (row.type && !(await this.executeStep({ ...row.type, value: pick }, false).catch(() => false))) {
        abandon(`its Type "${pick}" could not be chosen on the row`);
        return;
      }
      await this.waitForLoadingMaskClear(`saving ${label.slice(0, 40)}`);
      const committed = await this.executeStep(commitStep, false).catch(() => false);
      const saved = committed ? await this.attachmentCommitted(fileName, row.type, pick, RecipeAdapter.ATTACH_LIST_WAIT_MS) : false;
      if (saved) {
        this.uploadsSettledUpTo = this.uploadsPerformed.length;
        this.attachmentLedger.push({ docType: o.docType, label, status: "attached", detail: `"${fileName}"${pick ? ` as "${pick}"` : ""}` });
        this.agingNotes.push(`attached the owed ${label} ("${fileName}"${pick ? `, Type "${pick}"` : ""}) — the portal lists it and its row is saved`);
      } else {
        abandon(committed ? `after the save the portal's attachment list does not show "${fileName}" as saved` : "the save did not go through");
        return;
      }
    }
  }

  /** How long an owed document's new row may take to show its Type control after the upload. */
  static ATTACH_ROW_WAIT_MS = 15_000;
  /** How long the portal's list may take to show a saved attachment (Accela redraws it seconds after
   *  its "successfully uploaded" banner — live 090fa574's list outlasted a 20 s wait). */
  static ATTACH_LIST_WAIT_MS = 45_000;

  /** The Type control's options once the new row shows it (bounded poll). [] = it never appeared. */
  private async waitTypeOptions(typeStep: RecipeStep, timeoutMs: number): Promise<string[]> {
    const t0 = Date.now();
    for (;;) {
      const got = await this.typeOptionsOf(typeStep);
      if (got.length || Date.now() - t0 >= timeoutMs) return got;
      await sleep(300);
    }
  }

  /** SAVED, NOT MERELY PENDING. Before Save, Accela shows the chosen file's name on the pending row
   *  itself ("File: <name>"), so "the name is on the page" proves nothing. Saved = the name is on the
   *  page AND no row still holds the Type this run picked (Accela removes the row on Save; a static-row
   *  widget resets it; a refused Save leaves the pick in place). Bounded poll. */
  private async attachmentCommitted(fileName: string, typeStep: RecipeStep | null, pick: string, timeoutMs: number): Promise<boolean> {
    const t0 = Date.now();
    for (;;) {
      await this.waitForLoadingMaskClear(`reading the attachment list for "${fileName.slice(0, 40)}"`, Math.max(0, timeoutMs - (Date.now() - t0)));
      // Listed in the COMMITTED list (pageListsFile) and no document-type row still holding a Type
      // (pendingAttachmentRow — the same document-type test, so a Category "Other" never counts: S5).
      const listed = await this.pageListsFile(fileName);
      const pending = typeStep && pick ? await this.pendingAttachmentRow() : false;
      if (listed && !pending) return true;
      if (Date.now() - t0 >= timeoutMs) return false;
      await sleep(500);
    }
  }

  /** Owed documents with no outcome yet at the end of the run: the recording has no attachment row
   *  the run passed through, so nothing could carry them. Named, never silent. */
  private settleOwedLedger(): void {
    const recorded = new Set(this.recipe.steps.filter((s) => s.action === "upload" && s.docType).map((s) => String(s.docType)));
    for (const o of this.options.owedAttachments ?? []) {
      if (!o?.docType || o.docType === "__unreadable__" || recorded.has(o.docType) || this.attachmentLedger.some((e) => e.docType === o.docType)) continue;
      const label = String(o.label || o.docType).replace(/\s+/g, " ").trim();
      this.attachmentLedger.push({ docType: o.docType, label, status: "not attached", detail: "the run passed no attachment row that could carry it" });
      this.driftWarnings.push(`NOT ATTACHED: ${label} — the run passed no attachment row that could carry it. Attach it by hand on the portal's attachment step before submitting.`);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // runs-finish item 4: the portal's loading mask and the upload's commit.
  // ---------------------------------------------------------------------------------------------

  /** The portal's visible LOADING MASK right now, named ("" = none, or the page cannot be read):
   *  a short "Please wait…" / "Loading…" / "Processing…" box that is POSITIONED (fixed/absolute,
   *  itself or a near ancestor — Accela's ProcessLoading popup over the step bar), a page-covering
   *  loading / overlay / mask element, or a large aria-busy region. Positioned on purpose: an
   *  inline "Processing... Please wait." tip that a page leaves visible is not a mask, and must not
   *  cost every click the whole wait. */
  private async loadingMaskNow(): Promise<string> {
    if (!this.page || typeof this.page.evaluate !== "function") return "";
    await this.page.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE).catch(() => null); // the __name shim
    const found = await this.page.evaluate((stale: string[]) => {
      const vw = Math.max(1, window.innerWidth || 1);
      const vh = Math.max(1, window.innerHeight || 1);
      const shown = (el: Element): DOMRect | null => {
        const r = el.getBoundingClientRect();
        if (r.width <= 4 || r.height <= 4) return null;
        // Not PARKED: a template placed at negative page coordinates (left:-9999px) is not a mask
        // over anything. Merely scrolled out of view still counts — Accela's popup sits by the step
        // bar while the click target is far down the page.
        if (r.right + window.scrollX <= 0 || r.bottom + window.scrollY <= 0) return null;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) return null;
        return r;
      };
      const positioned = (el: Element): boolean => {
        let p: Element | null = el;
        for (let i = 0; p && i < 4; i++, p = p.parentElement) {
          const pos = getComputedStyle(p).position;
          if (pos === "fixed" || pos === "absolute") return true;
        }
        return false;
      };
      const MASK_TEXT = /^(please\s+wait|loading|processing|saving|uploading)\b[\s.…!]*$/i;
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = String(n.nodeValue || "").replace(/\s+/g, " ").trim();
        if (!t || t.length > 40 || !MASK_TEXT.test(t)) continue;
        const el = n.parentElement;
        const name = `"${t.slice(0, 30)}"`;
        if (el && !stale.includes(name) && shown(el) && positioned(el)) return name;
      }
      for (const el of Array.from(document.querySelectorAll("[aria-busy=true], [class*=loading i], [class*=overlay i], [class*=mask i], [class*=blockui i], [id*=loading i], [id*=overlay i], [id*=mask i]"))) {
        const r = shown(el);
        if (!r || r.width * r.height < 0.25 * vw * vh) continue;
        const name = `a page-covering ${el.getAttribute("aria-busy") === "true" ? "aria-busy region" : "loading overlay"}`;
        if (!stale.includes(name) && (el.getAttribute("aria-busy") === "true" || positioned(el))) return name;
      }
      return "";
    }, Array.from(this.staleMasks)).catch(() => "");
    return String(found || "");
  }

  /** How long one click waits for a loading mask to clear. Static so a smoke can shorten it. */
  static LOADING_MASK_WAIT_MS = 20_000;
  /** Masks that outlasted a whole wait once this run: never waited on again (a permanently shown
   *  "Loading..." must cost one bounded wait per run, never one per click). */
  private staleMasks = new Set<string>();

  /** WAIT OUT THE PORTAL'S LOADING MASK BEFORE AN ADVANCING OR COMMITTING CLICK (runs-finish item
   *  4). Live run 191e45c8: the attachment Save and the Continue after it were clicked while
   *  Accela's "Please wait..." was still up (the plan set at 100% in the widget, the table still
   *  "No records found"); the advance landed nowhere and the run reported a review it never
   *  reached. Bounded; the wait is noted when it happened, and a mask that never clears is named. */
  private async waitForLoadingMaskClear(before: string, timeoutMs = RecipeAdapter.LOADING_MASK_WAIT_MS): Promise<void> {
    const first = await this.loadingMaskNow();
    if (!first) return;
    const t0 = Date.now();
    let still = first;
    while (still && Date.now() - t0 < timeoutMs) {
      await sleep(250);
      still = await this.loadingMaskNow();
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (still) {
      this.staleMasks.add(still);
      this.driftWarnings.push(`the portal's loading mask ${still} was still up after ${secs}s before ${before} — clicked anyway, and not waited on again this run; check that page`);
    } else this.agingNotes.push(`waited ${secs}s for the portal's loading mask ${first} to clear before ${before}`);
  }

  /** A COMMITTED UPLOAD IS ONE THE PAGE LISTS (runs-finish item 4). After a commit click (the
   *  attachment Save) that follows this page's uploads, wait (bounded) for the page to list every
   *  file the run handed it — the attachment table, not the widget. A file the page never lists is
   *  named: the portal did not take it, and a person attaches it before submitting. */
  private async confirmUploadsListed(after: string, stampedRow: boolean, timeoutMs = RecipeAdapter.ATTACH_LIST_WAIT_MS): Promise<void> {
    const pending = this.uploadsPerformed.slice(this.uploadsSettledUpTo);
    this.uploadsSettledUpTo = this.uploadsPerformed.length;
    if (!pending.length || !this.page || typeof this.page.evaluate !== "function") return;
    const names = Array.from(new Set(pending.map((u) => u.fileName).filter(Boolean)));
    if (!names.length) return;
    const t0 = Date.now();
    let missing = names;
    for (;;) {
      await this.waitForLoadingMaskClear(`reading the attachment list after ${after}`, Math.max(0, timeoutMs - (Date.now() - t0)));
      // Listed = the name appears in the page OR any frame (Accela's committed grid is a child iframe,
      // FileUpload/AttachmentsList.aspx — the main body never shows it: live 090fa574's false alarm).
      const listed: string[] = [];
      for (const n of names) if (await this.pageListsFile(n)) listed.push(n);
      if (Array.isArray(listed)) missing = names.filter((n) => !listed.includes(n));
      if (!missing.length || Date.now() - t0 >= timeoutMs) break;
      await sleep(400);
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    // WHAT THE LIST CONFIRMED, BY DOCUMENT (skeptic 13985c6 S1): an upload handed to the control is not a
    // committed one — the approved final submit refuses while a recorded upload is unconfirmed, and the
    // owed pass never starts on a row whose own Save was not confirmed.
    // Only a learner-stamped attachment Save marks a document unconfirmed (N1); a list that does show
    // it clears the mark either way.
    for (const u of pending) {
      if (!u.docType) continue;
      if (!missing.includes(u.fileName)) this.unconfirmedDocTypes.delete(u.docType);
      else if (stampedRow) this.unconfirmedDocTypes.add(u.docType);
    }
    if (missing.length && !stampedRow) {
      this.driftWarnings.push(`after ${after} the upload of ${missing.map((n) => `"${n}"`).join(", ")} was NOT CONFIRMED on a committed attachment list (waited ${secs}s; this save is not a recorded attachment row, so the list may simply look different) — look at the portal's attachments before submitting`);
    } else if (missing.length) {
      this.driftWarnings.push(`after ${after} the portal's attachment list does not show ${missing.map((n) => `"${n}"`).join(", ")} (waited ${secs}s) — the upload may not have committed; attach it and click Save by hand before submitting`);
    } else if (Date.now() - t0 >= 1000) {
      this.agingNotes.push(`the portal listed ${names.map((n) => `"${n}"`).join(", ")} ${secs}s after ${after} — the upload committed`);
    }
  }

  /** Identity providers a portal login legitimately bounces through. Small on purpose. */
  private static readonly SSO_SITES = new Set([
    "microsoftonline.com", "b2clogin.com", "okta.com", "auth0.com", "onelogin.com", "pingidentity.com", "login.gov", "id.me",
  ]);

  /** The page, as the shared predicates read it: does it NAME itself the review step, is it
   *  read-only, and does it show a filing-shaped control. Unknown (a page that cannot be read)
   *  answers every question with undefined. */
  private async pageSafetyContext(): Promise<{ reviewPage?: boolean; readOnlyPage?: boolean; filingControl?: string }> {
    if (!this.page || typeof this.page.evaluate !== "function") return {};
    await this.page.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE).catch(() => null);
    // THE SHARED terminalPageInPage (portalSafety.ts): the same question the network backstop's
    // review-page lockdown asks, so the click gate and the lockdown cannot disagree.
    const read = await this.page.evaluate((g: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ps = (globalThis as any)[g];
      if (!ps || typeof ps.terminalPageInPage !== "function") return {};
      const t = ps.terminalPageInPage();
      return { reviewPage: t.reviewPage, readOnlyPage: t.readOnlyPage, filingControl: t.filingControl };
    }, PORTAL_SAFETY_GLOBAL).catch(() => null) as { reviewPage?: boolean; readOnlyPage?: boolean; filingControl?: string } | null;
    return read && typeof read === "object" ? read : {};
  }

  /** The control's label as a person reads it (aria, label[for], value, text, img alt). "" when
   *  it cannot be read — an unknown, never reassurance. */
  private async controlLabelOf(target: unknown): Promise<string> {
    const t = target as { evaluate?: (fn: unknown, arg: unknown) => Promise<unknown> } | null;
    if (!t || typeof t.evaluate !== "function" || !this.page || typeof this.page.evaluate !== "function") return "";
    await this.page.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE).catch(() => null);
    const label = await t.evaluate((el: Element, g: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ps = (globalThis as any)[g];
      const img = el.querySelector ? el.querySelector("img[alt]") : null;
      return String((ps && ps.controlLabelInPage(el)) || (el as HTMLElement).innerText || (el as HTMLInputElement).value
        || el.getAttribute("title") || (img && img.getAttribute("alt")) || "").replace(/\s+/g, " ").trim();
    }, PORTAL_SAFETY_GLOBAL).catch(() => "");
    return String(label ?? "");
  }

  /** What Enter in this control would activate by implicit submission (shared in-page predicate),
   *  tagging the default button data-al-default-submit. null when it submits nothing or cannot be
   *  read. */
  private async implicitSubmitOf(target: unknown): Promise<{ label: string; action: string; tagged: boolean } | null> {
    const t = target as { evaluate?: (fn: unknown, arg: unknown) => Promise<unknown> } | null;
    if (!t || typeof t.evaluate !== "function" || !this.page || typeof this.page.evaluate !== "function") return null;
    await this.page.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE).catch(() => null);
    const r = await t.evaluate((el: Element, g: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ps = (globalThis as any)[g];
      return ps && typeof ps.implicitSubmitInPage === "function" ? ps.implicitSubmitInPage(el) : null;
    }, PORTAL_SAFETY_GLOBAL).catch(() => null) as { label: string; action: string; tagged: boolean } | null;
    return r && typeof r === "object" ? r : null;
  }

  /** The shared in-page Enter question (enterRefusalInPage) for this control. A control that
   *  cannot be asked (no evaluate: a unit-test double) has nothing Enter can reach that we could
   *  read, and the caller's label gate still runs; a page that fails to answer is refused. */
  private async enterRefusalOf(target: unknown): Promise<string> {
    const t = target as { evaluate?: (fn: unknown, arg: unknown) => Promise<unknown> } | null;
    if (!t || typeof t.evaluate !== "function" || !this.page || typeof this.page.evaluate !== "function") return "";
    await this.page.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE).catch(() => null);
    return String(await t.evaluate((el: Element, g: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ps = (globalThis as any)[g];
      return ps && typeof ps.enterRefusalInPage === "function" ? ps.enterRefusalInPage(el) : "the page's safety predicates are not installed";
    }, PORTAL_SAFETY_GLOBAL).catch((e: unknown) => `the control could not be read (${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 100)})`) ?? "");
  }

  /**
   * May replay perform this action? Returns the refusal reason, or "" when allowed. Every
   * refusal is recorded (guardRefusals + driftWarnings) so a refused click that a caller's
   * .catch swallows is still visible in the run report.
   */
  private async guardAction(intent:
    | { kind: "goto"; url: string; why: string }
    | { kind: "click" | "press"; target: unknown; why: string; key?: string; passThrough?: boolean; finalSubmitApproved?: boolean },
  ): Promise<string> {
    const refuse = (reason: string): string => {
      const line = `REFUSED ${intent.kind} (${intent.why}): ${reason}`;
      this.guardRefusals.push(line);
      this.driftWarnings.push(line);
      return reason;
    };
    if (intent.kind === "goto") {
      // HARD RULE 5 INSIDE REPLAY. A goto may not leave the portal the recipe belongs to: a
      // permit recipe must never land on a utility portal and vice versa, and a recipe whose
      // goto points at another site is a recipe to fix, not a URL to follow.
      const url = String(intent.url || "");
      if (!/^https?:\/\//i.test(url)) return url ? refuse(`"${url.slice(0, 80)}" is not an http(s) URL`) : refuse("no URL");
      const target = RecipeAdapter.siteOf(url);
      const anchor = this.recipe.portalUrl || String(this.recipe.steps.find((s) => s.action === "goto")?.value ?? "");
      const home = anchor ? RecipeAdapter.siteOf(anchor) : "";
      if (this.recipe.scopeType === "ahj" && /powerclerk/i.test(target) && !/powerclerk/i.test(home)) {
        return refuse(`a permit recipe may not open a utility (PowerClerk) portal: ${target}`);
      }
      if (this.recipe.scopeType === "utility" && /accela|tylerhost|epermit/i.test(target) && !/accela|tylerhost|epermit/i.test(home)) {
        return refuse(`a utility recipe may not open a permit portal: ${target}`);
      }
      if (home && target !== home && !RecipeAdapter.SSO_SITES.has(target)) {
        return refuse(`goto leaves the recipe's portal (${home}) for ${target} — stopped rather than followed`);
      }
      return "";
    }
    // A key press that is not Enter/Space cannot activate a control (Escape, Tab, arrows).
    if (intent.kind === "press" && !/^(enter|numpadenter|space| )$/i.test(String(intent.key ?? "Enter"))) return "";
    // ENTER IN A TEXT BOX IS A CLICK ON THE FORM'S DEFAULT BUTTON. Implicit submission activates
    // the first submit button of the form, whatever the focused box is called: a recipe's Enter
    // in "Parcel Number" posted the form's "Submit Application" (replay skeptic, enter-probe.log).
    // The default button is judged by the full click gate below; with no button, the form's action.
    if (intent.kind === "press" && /^(enter|numpadenter)$/i.test(String(intent.key ?? "Enter"))) {
      const imp = await this.implicitSubmitOf(intent.target);
      if (imp?.tagged) {
        const viaDefault = await this.guardAction({
          kind: "click", target: this.page.locator('[data-al-default-submit="1"]').first(),
          why: `${intent.why}: Enter activates the form's default button "${imp.label.slice(0, 40)}"`,
        });
        if (viaDefault) return viaDefault;
      } else if (imp && isSubmitOrPayRequestUrl(imp.action)) {
        return refuse(`Enter submits the form to ${imp.action.slice(0, 80)}, a filing/payment endpoint`);
      }
      // EVERY CONTROL ENTER CAN REACH, not only the default: a declared default whose button is
      // missing, a page script that maps Enter to the form's filing button (the conservative
      // rule), and any form on a page that names itself the review step (enterRefusalInPage).
      // Unreadable -> refused.
      const enterWhy = await this.enterRefusalOf(intent.target);
      if (enterWhy) return refuse(`Enter here: ${enterWhy}`);
    }
    const label = await this.controlLabelOf(intent.target);
    // 1) Fees: never, in any mode, whatever the flag.
    if (isPayFee(label) || PAY_FEE_REPLAY_GATE.test(label)) return refuse(`"${label.slice(0, 60)}" pays a fee`);
    if (intent.finalSubmitApproved) {
      // Only executeClick's flagged branch sets this, after finalSubmitRefusalsNow() passed.
      return "";
    }
    const ctx = await this.pageSafetyContext();
    // 2) THE filing click, as the shared predicate knows it: submit-worded, or "Continue
    //    Application" on a page that names itself the review step.
    if (isFinalSubmitControl(label, { reviewPage: ctx.reviewPage === true })) return refuse(`"${label.slice(0, 60)}" is the filing click on this page`);
    // Submit-worded (never "Continue Application" here — that one is decided by the page below).
    if (isSubmitIntent(label, { reviewPage: false, readOnlyPage: false })) return refuse(`"${label.slice(0, 60)}" is submit-worded`);
    // 3) A TERMINAL PAGE: it names itself the review step, or it is read-only and shows a
    //    filing-shaped control. On it, a pass-through click-through is refused whatever the
    //    control says, and so is any forward-shaped or unreadable control.
    const terminal = ctx.reviewPage === true || (ctx.readOnlyPage === true && !!ctx.filingControl);
    if (terminal) {
      const why = ctx.reviewPage ? "the page names itself the review step" : `the page is read-only and shows the filing control "${String(ctx.filingControl).slice(0, 40)}"`;
      if (intent.passThrough) return refuse(`terminal-page drift: ${why} — clicking through it would file the application`);
      if (!label || /\b(continue|next|proceed|forward|submit|finish|finali[sz]e|complete|confirm|file|done|send|save\s*(and|&)\s*continue)\b/i.test(label)) {
        return refuse(`terminal-page drift: ${why}, and "${label.slice(0, 60) || "(unreadable control)"}" would move past it`);
      }
    }
    return "";
  }

  /** Every click in replay. Refused → throws ReplayGuardRefusal (named), nothing clicked. */
  private async guardedClick(target: unknown, why: string, opts?: { timeout?: number; force?: boolean }, flags: { passThrough?: boolean; finalSubmitApproved?: boolean } = {}): Promise<void> {
    const reason = await this.guardAction({ kind: "click", target, why, ...flags });
    if (reason) throw new ReplayGuardRefusal(reason);
    // THE APPROVED FINAL SUBMIT (and its confirm dialog) is the one click whose FILING request
    // the backstop lets through — a named person approved this run and finalSubmitRefusalsNow()
    // passed. A payment endpoint stays blocked even then.
    // The slot is bound to THIS page (portal-run-close-2 M4) and carries the native-dialog handler
    // for the click (M3); see filingBackstop.allowApprovedFiling.
    if (flags.finalSubmitApproved) this.backstop?.allowApprovedFiling(20_000, { page: this.page });
    await (target as { click: (o?: unknown) => Promise<void> }).click(opts);
  }

  /** Every key press in replay. Enter/Space are clicks on the focused control. */
  private async guardedPress(target: unknown, key: string, why: string): Promise<void> {
    const focused = /^(enter|numpadenter|space| )$/i.test(key) && this.page && typeof this.page.locator === "function"
      ? (target && typeof (target as { evaluate?: unknown }).evaluate === "function" ? target : this.page.locator(":focus"))
      : target;
    const reason = await this.guardAction({ kind: "press", target: focused, key, why });
    if (reason) throw new ReplayGuardRefusal(reason);
    // A BOT ENTER ON A REVIEW / TERMINAL PAGE has no business changing server state: whatever a
    // page script maps it to, a state-changing request fired while it is in flight is aborted
    // (the backstop's window rule).
    if (/^(enter|numpadenter)$/i.test(key) && this.backstop) {
      const ctx = await this.pageSafetyContext();
      if (ctx.reviewPage === true || (ctx.readOnlyPage === true && !!ctx.filingControl)) {
        await withBackstopWindow(this.page, "enter-window", `${why} on a ${ctx.reviewPage ? "review" : "read-only terminal"} page`,
          () => (target as { press: (k: string) => Promise<void> }).press(key));
        return;
      }
    }
    await (target as { press: (k: string) => Promise<void> }).press(key);
  }

  /** The overlay dismisser, with every click it makes routed through guardAction. It was the one
   *  door onto the page left outside the chokepoint: a raw click on a confirm dialog's "OK" or
   *  first button, before every click step and on every retry (replay skeptic, 4 filing POSTs).
   *  What it refused is recorded like any other refusal. */
  private async dismissModalsGuarded(): Promise<void> {
    const r = await dismissPageModals(this.page, {
      click: (loc: unknown, why: string) => this.guardedClick(loc, why, { timeout: 2000 }),
    }).catch(() => null);
    // A refusal by guardAction (the click callback threw) is already recorded there; the in-page
    // refusals are not.
    for (const line of r?.refused ?? []) {
      if (this.guardRefusals.includes(line) || line.includes("replay safety gate refused:")) continue;
      this.guardRefusals.push(line);
      this.driftWarnings.push(line);
    }
  }

  /** Every reload in replay. A reload of a document that a POST produced RE-SENDS that POST: on
   *  an ASP.NET portal every Continue is a full postback that renders the next page in place, and
   *  on a portal whose filing renders its result without a redirect a reload files again (the
   *  replay skeptic's modal probe: POSTs 2-4 were the retry loop's reloads). Only a document a GET
   *  produced is reloaded; a POST result or an unknown method is left alone and named. */
  private async guardedReload(why: string): Promise<boolean> {
    this.hookDocumentMethod();
    const method = this.lastDocumentMethod;
    if (method !== "GET") {
      const line = `NOT RELOADED (${why}): the page is ${method ? `the result of a ${method}` : "a document of unknown origin"} — a reload would re-send it`;
      if (!this.driftWarnings.includes(line)) this.driftWarnings.push(line);
      return false;
    }
    await this.page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
    return true;
  }

  /** Every navigation in replay. */
  private async guardedGoto(url: string, why: string, opts?: Record<string, unknown>): Promise<unknown> {
    const reason = await this.guardAction({ kind: "goto", url, why });
    if (reason) throw new ReplayGuardRefusal(reason);
    return this.page.goto(url, opts);
  }

  /** WAIT FOR THE PAGE TO SETTLE BY WHAT IT IS DOING (settle.ts): PageRequestManager begin/end,
   *  a postback just begun, young requests, DOM quiet. Replaces every networkidle wait replay had
   *  — an UpdatePanel postback fires no load event, and networkidle is a guess about quiet that a
   *  long-poll never gives. A page that cannot be read (unit-test fakes) has nothing to wait on. */
  private async settle(timeoutMs = 10_000): Promise<void> {
    if (!this.page || typeof this.page.evaluate !== "function" || typeof this.page.addInitScript !== "function") return;
    await installSettleProbe(this.page).catch(() => null);
    await waitForSettled(this.page, { timeoutMs }).catch(() => null);
  }

  /** Why the final submit may NOT be clicked right now — the shared gate, asked at the click.
   *  THE GATE IS mayClickFinalSubmit (CLAUDE.md rule 1 names it): it decides; finalSubmitRefusals
   *  only words the refusal. Replay used to ask finalSubmitRefusals alone, so the named gate had no
   *  production caller and a kill of it proved nothing (portal-run-close 8). */
  private finalSubmitRefusalsNow(): string[] {
    const steps = this.recipe.steps;
    const last = steps.length - 1;
    const ctx = {
      envAllows: finalSubmitEnvAllows(process.env),
      runApproval: this.options.runApproval ?? null,
      runId: String(this.options.runId ?? ""),
      stepIsTerminalFlagged: this.currentStepIdx === last && isFinalSubmitStep(steps[last]),
      recipeShapeValid: isRecipeShapeValid(steps),
    };
    const may = mayClickFinalSubmit(ctx);
    const out = may ? [] : finalSubmitRefusals(ctx);
    if (!may && !out.length) out.push("the final-submit gate refused this click");
    if (this.finalSubmitAttempted) out.push("the final submit was already attempted in this run");
    // D4: NEVER FILE WITH AN OWED DOCUMENT MISSING. Every document the filing owes that the recording
    // does not upload must be ATTACHED or ALREADY LISTED on the portal before the approved click.
    {
      const recorded = new Set(steps.filter((s) => s.action === "upload" && s.docType).map((s) => String(s.docType)));
      const missing = (this.options.owedAttachments ?? []).filter((o) => o?.docType && o.docType !== "__unreadable__" && !recorded.has(o.docType)
        && !this.attachmentLedger.some((e) => e.docType === o.docType && e.status !== "not attached"));
      if (missing.length) out.push(`${missing.length} owed document(s) not attached on the portal (${missing.map((o) => String(o.label || o.docType).slice(0, 60)).join("; ")})`);
      // ...and a document the RECORDING uploads counts only if this run actually uploaded it (skeptic
      // 21d2502 g: a skipped recorded upload — the plan set — was covered by no gate at all).
      // A recorded upload a RULE skips is not missing (skeptic 13985c6 S4: a battery spec on a
      // no-battery job — skipForNoBattery, which now fires for uploads). One whose file is simply not
      // on hand IS missing (skeptic eb36a8f MF1: a required SLD with no file let the approved submit
      // through): it is refused, never exempted.
      const skipped = Array.from(new Set(steps.filter((s) => s.action === "upload" && s.docType
        && !this.skipForNoBattery(s) && !this.uploadedDocTypes.has(String(s.docType))).map((s) => String(s.docType))));
      // ...and a required-document list the backend could not read refuses (skeptic eb36a8f MF2).
      if ((this.options.owedAttachments ?? []).some((o) => o?.docType === "__unreadable__")) out.push("the required-document list for this filing could not be read");
      if (skipped.length) out.push(`the recording's upload of ${skipped.join(", ")} did not happen this run`);
      // ...and one whose Save was followed by a list check that never showed it is not confirmed (S1).
      const unconfirmed = Array.from(this.unconfirmedDocTypes);
      if (unconfirmed.length) out.push(`the portal's attachment list never showed ${unconfirmed.join(", ")} after its Save`);
    }
    const burned = approvedRunBurn(ctx.runId);
    if (burned && !this.finalSubmitAttempted) out.push(`this run's approval (runId ${ctx.runId.slice(0, 40)}) was already used in this process — ${burnWords(burned)}; one approval covers one filing attempt, a new run needs a new approval`);
    return out;
  }

  /** Read the page after a final-submit click through the ONE shared classifier. Waits out a
   *  visible "Processing…" indicator and presses a confirm dialog's OK (part of the approved
   *  submit — a dialog mentioning payment stops instead). */
  private async pollSubmissionOutcome(): Promise<SubmissionOutcome> {
    if (!this.page || typeof this.page.evaluate !== "function") {
      return { verdict: "unknown", evidence: "the page could not be read" };
    }
    let last: SubmissionOutcome = { verdict: "unknown", evidence: null };
    let processingTicks = 0;
    for (let poll = 0; poll < 6; poll++) {
      await smartWait(this.page, 2500);
      if (processingTicks < 120) { // ~5min of spinner grace — PacifiCorp outlasted 90s twice
        const processing = await this.page.evaluate(() => Array.from(document.querySelectorAll("div, span, [role='status']")).some((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const t = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
          return r.width > 0 && r.height > 0 && !!t && t.length < 60 && /^(processing|submitting|saving)\b/i.test(t);
        })).catch(() => false);
        if (processing === true) { processingTicks++; poll--; continue; }
      }
      const modal = await this.page.evaluate(() => {
        const panels = Array.from(document.querySelectorAll(
          "[data-test-role='ai-screen-multi-page-progression-warning'], [data-test-role='ai-screen-nav-warning'], [role='dialog'], .modal.show, .modal[style*='display: block']"));
        const texts: string[] = [];
        let found: { ok: string; text: string } | null = null;
        for (const p of panels) {
          const r = (p as HTMLElement).getBoundingClientRect();
          if (!(r.width > 2 && r.height > 2)) continue;
          const text = ((p as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
          texts.push(text.slice(0, 400));
          if (found) continue;
          for (const b of Array.from(p.querySelectorAll("button, a, [role='button']"))) {
            const t = ((b as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
            if (/^(ok|yes|confirm|continue|submit|proceed)$/i.test(t)) {
              (b as HTMLElement).setAttribute("data-al-modal-ok", "1");
              found = { ok: t, text: text.slice(0, 120) };
              break;
            }
          }
        }
        return texts.length ? { ...(found ?? {}), all: texts } : null;
      }).catch(() => null) as { ok?: string; text?: string; all?: string[]; blocked?: string } | null;
      // ONE PREDICATE for "does this dialog pay NOW?" — the same one the native-dialog handler asks
      // (portalSafety isPayNowDialogText / paymentDialogVerdict; this was its own substring regex,
      // where "feedback" read as a fee). A fee mentioned as deferred ("will be invoiced later")
      // is not paying — the operator's ruling of 2026-09-27; "Pay $150 and submit?" is. Every
      // visible dialog is asked, not only the one with an OK.
      const payDialog = (modal?.all ?? []).find((t) => isPayNowDialogText(t));
      if (modal && payDialog) modal.blocked = payDialog.slice(0, 160);
      if (modal?.blocked) {
        this.finalSubmitOutcome = { verdict: "unknown", evidence: `payment dialog: ${modal.blocked.slice(0, 80)}` };
        const bsPay = this.backstop;
        if (bsPay && !bsPay.approvedRequests.length && !bsPay.approvedNavigations.length) {
          // Nothing reached the portal: the click only opened this dialog. Not a filing (M3).
          bsPay.closeApprovedSlot();
          this.finalSubmitClicked = false;
          this.finalSubmitNothingSent = true;
          throw new FinalSubmitStop(`The approved final submit's confirmation asks for a payment — fees are never automated, the dialog was not answered, and NOTHING was filed (no request reached the portal). A person pays and submits on the portal. (${modal.blocked.slice(0, 120)})`, "fee_payment");
        }
        throw new FinalSubmitStop(`The submit raised a payment dialog — fees are never automated; a person pays and confirms the filing on the portal. (${modal.blocked.slice(0, 120)})`, "fee_payment");
      }
      // A MODAL IS ANSWERED ONLY WHILE THE FILING HAS NOT GONE (portal-run-close-2 C3). Its OK
      // opens a fresh approved slot — which is right for the submit's own confirmation ("Are you
      // sure you want to submit?", nothing sent yet), and wrong after the filing request reached
      // the server: a "Take our survey? [Continue]" modal on the completion page would have been
      // clicked with a slot open. After the filing, the slot is closed and no modal is clicked;
      // the page's text (modal included) is still read below.
      const bsNow = this.backstop;
      const filingWent = !!bsNow && (bsNow.approvedRequests.length > 0 || bsNow.approvedNavigations.length > 0);
      if (modal?.ok && filingWent) {
        bsNow!.closeApprovedSlot();
        const line = `a dialog after the filing request ("${(modal.text || "").slice(0, 60)}") — NOT clicked: the approved click's request already reached the portal`;
        if (!this.driftWarnings.includes(line)) this.driftWarnings.push(line);
      } else if (modal?.ok) {
        this.driftWarnings.push(`submit confirm dialog ("${(modal.text || "").slice(0, 60)}") — clicked ${modal.ok}`);
        await this.guardedClick(this.page.locator("[data-al-modal-ok='1']").first(), "the approved submit's confirm dialog", { timeout: 5000 }, { finalSubmitApproved: true }).catch(() => null);
        await smartWait(this.page, 2500);
      }
      const body = String(await this.page.locator("body").innerText().catch(() => "") ?? "");
      last = classifySubmissionText(body);
      if (last.verdict !== "unknown") return last;
      // A FEE PAGE BETWEEN THE SUBMIT AND THE COMPLETION PAGE. Nothing on it says the filing was
      // accepted, and it offers a pay control or a card field: the portal wants a fee before it
      // files (or finishes). Automation never pays — the network backstop aborts any payment
      // request whatever — so this is a pause for a person, named, not fifteen seconds of polling
      // and then "outcome unknown".
      const pay = await this.paymentOnPage();
      if (pay) {
        this.finalSubmitOutcome = { verdict: "unknown", evidence: `fee page: ${pay}` };
        await this.capturePageShot("FEE-PAGE", true).catch(() => null);
        throw new FinalSubmitStop(`The approved final submit landed on a fee-payment page (${pay}) — automation never pays. A person pays on the portal and confirms the filing (and its record number) there.`, "fee_payment");
      }
    }
    return last;
  }

  /** A visible pay control (its label read by the shared isPayFee) or a payment-card field on the
   *  current page, named; "" when there is none or the page cannot be read. */
  private async paymentOnPage(): Promise<string> {
    if (!this.page || typeof this.page.evaluate !== "function") return "";
    await this.page.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE).catch(() => null);
    const found = await this.page.evaluate((g: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ps = (globalThis as any)[g];
      if (!ps) return "";
      const shown = (el: Element): boolean => { const r = (el as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      for (const el of Array.from(document.querySelectorAll("button, a[href], [role='button'], input[type='submit'], input[type='button']"))) {
        if (!shown(el)) continue;
        const label = String(ps.controlLabelInPage(el) || (el as HTMLElement).innerText || (el as HTMLInputElement).value || "").replace(/\s+/g, " ").trim();
        if (label && label.length <= 60 && ps.isPayFee(label)) return `"${label}"`;
      }
      for (const el of Array.from(document.querySelectorAll("input, select"))) {
        if (shown(el) && ps.isPaymentElementInPage(el)) return "a payment-card field";
      }
      return "";
    }, PORTAL_SAFETY_GLOBAL).catch(() => "");
    return String(found || "");
  }

  // Click safety gate (P0-3 allowlist + P0-4 structural challenge detection).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async executeClick(step: RecipeStep, scoped: any, pastReview: boolean): Promise<boolean> {
    // Include the step NOTE in the safety haystack: a human-patch click step may carry a
    // css-only selector (no name/text) while its note names the button ("human-patch:
    // Submit") — the regex gates below must see that label too.
    const name = `${step.selector?.name || step.selector?.text || ""} ${step.note || ""}`.trim();
    const flaggedFinal = isFinalSubmitStep(step);

    // A RECORD NUMBER FROM THE LEARN SESSION NAMES A FILING THAT IS NOT THIS ONE. Checked
    // here, before the click is attempted, because the alternative is a 30s timeout on a
    // link that cannot exist and a dead recipe behind it. Refuses on ambiguity; see
    // reanchorRecordNumberLink for why several matches means STOP rather than guess.
    const reanchored = await this.reanchorRecordNumberLink(step).catch(() => null);
    if (reanchored) scoped = reanchored;

    // 1) Fee payment is NEVER automated — always blocked, even if (wrongly) flagged. A FLAGGED
    //    final submit that pays ("Pay and Submit") under an approval that otherwise holds is a
    //    PAUSE, named: the filing is staged at review and a person pays — it used to be skipped
    //    in silence and the approved run read as an ordinary review stop.
    if (PAY_FEE_REPLAY_GATE.test(name)) {
      if (flaggedFinal && this.finalSubmitRefusalsNow().length === 0) {
        throw new FinalSubmitStop(`The approved final submit "${name.slice(0, 60)}" pays a fee — automation never pays. Nothing was clicked; the application is staged at review for a person to pay and submit.`, "fee_payment");
      }
      return false;
    }

    // 2) Anything past the review marker (autoSubmit territory) is hard-blocked unless
    //    it carries the explicit isFinalSubmit allowlist flag. This catches id/css-only
    //    submit buttons whose recorded name is empty (the P0-3 bypass).
    if (pastReview && !flaggedFinal) return false;

    // 3) Any step whose name/text matches submit keywords is hard-blocked UNLESS it is
    //    the explicitly flagged final submit. We never infer "submit button" from regex.
    if (SUBMIT_KEYWORDS.test(name) && !flaggedFinal) return false;

    // 4) The explicitly allowlisted final submit — clicked ONLY through the shared gate, asked
    //    at the click itself: PORTAL_ALLOW_FINAL_SUBMIT=1 re-read now, a named person's
    //    approval of exactly THIS run, the recipe's single terminal flagged step after its
    //    stopForReview, and a valid recipe shape. autoSubmit alone (a standing per-recipe arm)
    //    is not an approval, and never was meant to be one.
    if (flaggedFinal) {
      const refusals = this.finalSubmitRefusalsNow();
      if (refusals.length) {
        this.driftWarnings.push(`final submit NOT clicked — ${refusals.join("; ")}`);
        // A REFUSED approval is spent too (C1): the backend burns it on a refusal, and a second
        // run re-passing the same {approver, runId} after the refusal (env flipped in between)
        // filed at this layer.
        if (this.options.runApproval) burnApprovedRun(String(this.options.runId ?? ""), "refused");
        return false;
      }
      // THE CLAIM, IN THE SAME SYNCHRONOUS TURN AS THE CHECK ABOVE (MF-C): no await between
      // finalSubmitRefusalsNow() and this line, so of N runs sharing one {approver, runId} exactly
      // one gets past here. The loser is refused, named — never clicked.
      if (!tryClaimApprovedRun(String(this.options.runId ?? ""))) {
        const held = approvedRunBurn(String(this.options.runId ?? ""));
        this.driftWarnings.push(`final submit NOT clicked — this run's approval (runId ${String(this.options.runId ?? "").slice(0, 40)}) was already used in this process — ${held ? burnWords(held) : "it could not be claimed"}; one approval covers one filing attempt, a new run needs a new approval`);
        return false;
      }
      // Trusted auto-submit: STRUCTURALLY detect a CAPTCHA/MFA challenge (iframe-based
      // included) on the final page and bail to a human if present. Never solve/bypass.
      const challenge = await detectChallengeFrame(this.page);
      if (challenge) {
        throw new FinalSubmitStop(`Final submit needs a human: ${challenge}. Automation stopped without clicking.`, "mfa_captcha");
      }
      // AT MOST ONCE PER RUN. Marked before the click: a click that throws mid-way may still
      // have reached the portal, and the retry loop must never produce a second filing.
      this.finalSubmitAttempted = true;
      // ONE APPROVAL, ONE FILING ATTEMPT — AT THIS LAYER TOO (portal-run-close-2 C1). The backend
      // burns an approval when it is claimed, but any other caller of stageWithRecipe (a script,
      // a retry that re-passes the same runId + approval) could file twice with it. The runId is
      // burned here, before the click, for the life of this process.
      burnApprovedRun(String(this.options.runId ?? ""), "clicked");
      try {
        await this.guardedClick(scoped, "the approved final submit", undefined, { finalSubmitApproved: true });
      } catch (err) {
        throw new FinalSubmitStop(`The approved final-submit click did not complete (${err instanceof Error ? err.message.slice(0, 160) : String(err)}) — NOT retried; a human must check whether the portal filed it.`, null);
      }
      this.finalSubmitClicked = true;
      // Let the portal settle, then verify we did not land on a challenge.
      await smartWait(this.page, 3000);
      // A NATIVE DIALOG WE DISMISSED CANCELLED THE CLICK (portal-run-close-2 M3): a confirm()
      // that speaks of paying ("Pay $150 and submit?"), or a prompt. Nothing was sent (the
      // backstop admitted nothing and the page did not navigate) — this is a pause for a person,
      // never a filing: finalSubmitClicked goes back to false so nothing downstream records one.
      const dismissed = this.backstop?.approvedDialogs.find((d) => d.action === "dismissed");
      if (dismissed && this.backstop && !this.backstop.approvedRequests.length && !this.backstop.approvedNavigations.length) {
        this.finalSubmitClicked = false;
        this.finalSubmitNothingSent = true;
        const payment = /payment/.test(dismissed.why);
        this.finalSubmitOutcome = { verdict: "unknown", evidence: `${dismissed.type} dialog dismissed: ${dismissed.message.slice(0, 80)}` };
        throw new FinalSubmitStop(payment
          ? `The approved final submit's confirmation asks for a payment ("${dismissed.message.slice(0, 100)}") — dismissed, automation never pays. NOTHING was filed (no request reached the portal); a person pays and submits on the portal.`
          : `The approved final submit opened a ${dismissed.type} ("${dismissed.message.slice(0, 100)}") that was dismissed (${dismissed.why}). NOTHING was filed (no request reached the portal); a person completes the submit on the portal.`,
        payment ? "fee_payment" : null);
      }
      const postChallenge = await detectChallengeFrame(this.page);
      if (postChallenge) {
        this.finalSubmitOutcome = { verdict: "unknown", evidence: `challenge after the click: ${postChallenge}` };
        throw new FinalSubmitStop(`Final submit triggered a challenge after the click (${postChallenge}); pausing for human verification.`, "mfa_captcha");
      }
      // A CLICK THAT LANDED IS NOT A FILING THAT WAS ACCEPTED. Read the page through the ONE
      // shared classifier: "accepted" only on positive evidence (a confirmation sentence or an
      // issued record number), "rejected" on the portal's refusal, and a quiet page "unknown" —
      // never "accepted because the page went quiet".
      // A REJECTION STOPS FOR A PERSON (portal-run-close-2 C2). This used to "repair" the pages the
      // portal's banner named and re-click getByRole('button', {name: /^Submit$/}) — NOT the
      // recipe's flagged step, a control nobody recorded or approved — with a fresh approved slot:
      // a second filing request on one approval. The named approval covered ONE click of ONE
      // flagged control; after the portal refuses it, what to change and whether to file again is
      // the person's call, in the portal's own words (the verdict's evidence below).
      const outcome = await this.pollSubmissionOutcome();
      this.finalSubmitOutcome = outcome;
      if (outcome.verdict === "accepted") {
        await this.capturePageShot("SUBMITTED", true);
        return true;
      }
      if (outcome.verdict === "rejected") {
        await this.capturePageShot("REFUSED", true);
        throw new FinalSubmitStop(`Final submit clicked; the portal REFUSED the submission: ${String(outcome.evidence ?? "").slice(0, 300)}`, null);
      }
      await this.capturePageShot("UNCONFIRMED", true);
      throw new FinalSubmitStop("Final submit clicked; outcome unknown — human must verify. The page neither confirmed nor refused the filing; a quiet page is not an accepted application.", null);
    }

    // 5) Ordinary navigation/UI click (pre-review). Safe to perform.
    //
    // Fingerprint FIRST: this is the only way to tell "the portal advanced" from "the
    // portal refused". waitForInteractiveControls below cannot — it is page-global and
    // identity-free, so a page that never moved satisfies it instantly.
    const beforeUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
    const beforeFp = await this.pageIdentity();
    // Values too, not just identity — so a click that computed a total can prove it did.
    const beforeEffect = await this.pageEffect();

    await waitForElement(scoped);
    await this.guardedClick(scoped, `recipe click${step.note ? ` (${String(step.note).slice(0, 50)})` : ""}`);
    // A recorded Next/Continue advances a Vue wizard to a not-yet-bound section. Wait for an
    // interactive control to mount before the next fill so we never type onto an unmounted page
    // (best-effort; never skips — the retry/reload loop still recovers a genuine miss).
    await waitForInteractiveControls(this.page);
    await this.assertAdvanced(step, beforeUrl, beforeFp, beforeEffect);
    return true;
  }

  /** The page's own words when it has thrown the user out — "Session Ended", "logged out",
   *  "session expired" as a prominent heading — or "" when it hasn't. Best-effort. */
  private async sessionEndedBanner(): Promise<string> {
    if (!this.page || typeof this.page.evaluate !== "function") return "";
    return this.page.evaluate(() => {
      const vis = (e: Element) => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      for (const el of Array.from(document.querySelectorAll("h1, h2, h3, [role='heading']"))) {
        if (!vis(el)) continue;
        const t = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
        if (t && t.length < 80 && /session\s+(ended|expired|timed?\s*out)|signed\s+out|logged\s+out/i.test(t)) return t;
      }
      return "";
    }).catch(() => "");
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
  /** WHAT THE CLICK ACTUALLY DID, when it did not move the page.
   *
   *  pageIdentity answers "are we still on the same page" and deliberately ignores values,
   *  which is right for that question and useless for this one. "Calculate" fills a total,
   *  "Add Array" appends a row, "Add Contact" opens a sub-form -- all leave the identity
   *  untouched, and all plainly DID something. Without a way to see that, the engine could
   *  only say "in-page action, or an advance that silently did nothing" and leave the
   *  operator to guess which. That sentence fired on four of five portals and was the single
   *  biggest reason otherwise-correct filings could not score clean.
   *
   *  This is the cheap second look: control count, option count, and the values themselves.
   *  A real in-page action moves at least one of them; a click that was swallowed moves
   *  none. */
  private async pageEffect(): Promise<string> {
    if (!this.page || typeof this.page.evaluate !== "function") return "";
    return await this.page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("input, select, textarea")) as HTMLElement[];
      let vals = "";
      let options = 0;
      let shown = 0;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (!r || (r.width === 0 && r.height === 0)) continue;
        shown++;
        const t = (el as HTMLInputElement).type;
        if (t === "checkbox" || t === "radio") vals += (el as HTMLInputElement).checked ? "1" : "0";
        else vals += String((el as HTMLInputElement).value ?? "").slice(0, 24);
        vals += ";";
        if (el.tagName === "SELECT") options += (el as HTMLSelectElement).options.length;
      }
      // Rows and list items move when a portal appends an array or a contact.
      const rows = document.querySelectorAll("tr, li, [role='row']").length;
      // AND THE TEXT, because a computed total is usually not in an input at all. PowerClerk
      // renders "compute totals: Calculate" into read-only markup, so measuring only form
      // values reported that click as having done NOTHING — a specific finding, made with an
      // instrument that could not have seen the thing it was looking for. A hash rather than
      // the text itself: this is compared, never read, and a page of text is not worth
      // carrying across the boundary on every click.
      const text = (document.body?.innerText || "").replace(/\s+/g, " ");
      let h = 0;
      for (let i = 0; i < text.length; i++) { h = ((h << 5) - h + text.charCodeAt(i)) | 0; }
      return `${shown}|${options}|${rows}|${text.length}:${h}|${vals.slice(0, 4000)}`;
    }).catch(() => "") as Promise<string>;
  }

  /** pageIdentity is "path|heading|ids": the same path and heading, and every visible control gone
   *  where there were some. */
  static controlsOnlyVanished(before: string, after: string): boolean {
    const cut = (s: string): [string, string] => { const i = s.lastIndexOf("|"); return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)]; };
    const [bPage, bIds] = cut(before);
    const [aPage, aIds] = cut(after);
    return bPage === aPage && bIds !== "" && aIds === "";
  }
  /** How long an advance check waits for vanished controls to come back (or the page to move). */
  static VANISHED_CONTROLS_WAIT_MS = 6000;

  private async assertAdvanced(step: RecipeStep, beforeUrl: string, beforeFp: string, beforeEffect = ""): Promise<void> {
    // No identity means a mock/no-DOM page (the unit-test doubles) — assert nothing.
    if (!beforeFp) return;
    const urlNow = (): string => (typeof this.page.url === "function" ? String(this.page.url() ?? "") : "");
    const moved = async (): Promise<boolean> => {
      if (urlNow() && urlNow() !== beforeUrl) return true;
      let fp = await this.pageIdentity();
      // CONTROLS THAT MERELY VANISHED ARE NOT AN ADVANCE (runs-finish item 4). A postback hides the
      // form under its "Please wait..." and brings the SAME page back: same path, same heading, no
      // visible control where there were some. Wait a bounded moment for the page to show what it
      // is; a page that stays empty is then read as today (moved), never as a false stop.
      if (fp && RecipeAdapter.controlsOnlyVanished(beforeFp, fp)) {
        const t0 = Date.now();
        while (Date.now() - t0 < RecipeAdapter.VANISHED_CONTROLS_WAIT_MS) {
          await sleep(250);
          if (urlNow() && urlNow() !== beforeUrl) return true;
          fp = await this.pageIdentity();
          if (!fp || !RecipeAdapter.controlsOnlyVanished(beforeFp, fp)) break;
        }
      }
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
    let blockers = await this.readPortalRefusal();
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
      // ASK THE SECOND QUESTION BEFORE GIVING UP ON THE ANSWER. The page did not move; did
      // anything happen at all? A total that filled, a row that appeared, an option list that
      // grew — any of those settles it as the in-page action the recorder said it was, and
      // there is nothing for a person to check. Only when NOTHING moved is this still the
      // open question it used to always be, and only then does it block a clean score.
      const afterEffect = beforeEffect ? await this.pageEffect() : "";
      if (afterEffect && afterEffect !== beforeEffect) {
        this.agingNotes.push(`click "${String(step.note ?? "click").slice(0, 44)}" acted on the page without advancing it — the in-page action the recipe recorded`);
        return;
      }
      // ONLY CLAIM THE FINDING WE ACTUALLY MADE. If the before-snapshot never came back —
      // an evaluate the portal interrupted, a page mid-navigation — then nothing was
      // compared, and saying "no value, row or option moved" would be describing a check
      // that did not run. That is the same fault this whole change was written to remove,
      // committed one branch further down. Unmeasured falls back to the honest ambiguity.
      const measured = !!beforeEffect && !!afterEffect;
      this.driftWarnings.push(measured
        ? `click "${String(step.note ?? "click").slice(0, 44)}" changed nothing on the page — no value, row or option moved, so it was either a no-op control or an advance the portal silently refused`
        : `click "${String(step.note ?? "click").slice(0, 44)}" left the page unchanged and the page could not be re-read to tell an in-page action from an advance that silently did nothing`);
      return;
    }

    // The portal is refusing. Give a slow SPA a moment in case the complaint is stale and
    // the next section is still rendering, then try clearing an overlay and clicking once
    // more — an announcement modal ate every click of a diagnostic probe for fourteen
    // iterations without it ever noticing.
    await this.timed("advance-settle", async () => { for (let i = 0; i < ADVANCE_SETTLE_TRIES && !(await moved()); i++) await sleep(ADVANCE_SETTLE_MS); });
    if (await moved()) return;
    await this.timed("advance-overlays", async () => { await this.dismissModalsGuarded(); await clearPageOverlays(this.page).catch(() => null); });
    const again = await this.resolveLocator(step.selector).catch(() => null);
    if (again && typeof again.click === "function") await this.timed("advance-retry-click", () => this.guardedClick(again, "retry an advance that did not move", { timeout: 8000 }).catch(() => null));
    await this.timed("advance-settle", async () => { for (let i = 0; i < ADVANCE_SETTLE_TRIES && !(await moved()); i++) await sleep(ADVANCE_SETTLE_MS); });
    if (await moved()) {
      this.driftWarnings.push(`advance "${String(step.note ?? "click").slice(0, 44)}" needed an overlay dismissed before it took`);
      return;
    }

    // Still refused. Report the PORTAL'S OWN words — "Meter Number: This field is required."
    // is worth more to an operator than any drift percentage we could compute.
    blockers = (await this.timed("refusal-read", () => this.readPortalRefusal())) || blockers;
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
  /**
   * Resolve by the portal's OWN stable test hook, derived from the step's field name.
   *
   * PowerClerk publishes 91 `data-test-role` attributes on its equipment page, among them
   * `inverter-model-select`, `pv-array-model-select`, `inverter-manufacturer-select`,
   * `pv-array-manufacturer-select`, `inverter-quantity`, `pv-array-quantity`. They are stable
   * across renders and unambiguous about side — everything `#pcInputBase34` and a bare label
   * of "Model" are not. A whole day went into disambiguating two identically-labelled
   * selects that the portal had been naming distinctly the entire time.
   *
   * Generic on purpose: it matches the tokens of the step's FIELD name against
   * data-test-role / data-testid / data-test-id, so any portal that ships such hooks gets the
   * benefit. `inverterModel` becomes ["inverter","model"], which matches
   * `inverter-model-select` and cannot match `pv-array-model-select`. Every token must
   * appear, so a partial overlap never wins.
   */
  private async resolveByTestHook(step: RecipeStep): Promise<unknown | null> {
    if (!this.page || typeof this.page.evaluate !== "function") return null;
    const field = String(step.field ?? "");
    if (!field) return null;
    // inverterModel -> inverter model ; array1ModuleQuantity -> array module quantity
    const tokens = field
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()
      .replace(/[^a-z ]+/g, " ").split(/\s+/)
      .map((t) => (t === "module" ? "array" : t === "pv" ? "array" : t))
      .filter((t) => t.length > 2 && !["the", "certified", "make"].includes(t));
    if (tokens.length < 2) return null;
    const found = await this.page.evaluate((toks: string[]) => {
      let best: HTMLElement | null = null;
      let bestLen = Infinity;
      for (const el of Array.from(document.querySelectorAll("[data-test-role], [data-testid], [data-test-id]")) as HTMLElement[]) {
        const hook = (el.getAttribute("data-test-role") || el.getAttribute("data-testid") || el.getAttribute("data-test-id") || "")
          .toLowerCase().replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^a-z]+/g, " ");
        if (!hook) continue;
        if (!toks.every((t) => hook.includes(t))) continue;
        // The control itself, or the nearest one this hook wraps.
        const ctl = (el.matches("input, select, textarea") ? el : el.querySelector("input, select, textarea")) as HTMLElement | null;
        if (!ctl) continue;
        if (hook.length < bestLen) { bestLen = hook.length; best = ctl; }
      }
      if (!best) return "";
      document.querySelectorAll("[data-rc-hook-hit]").forEach((e) => e.removeAttribute("data-rc-hook-hit"));
      best.setAttribute("data-rc-hook-hit", "1");
      return best.closest("[data-test-role], [data-testid], [data-test-id]")?.getAttribute("data-test-role")
        || best.getAttribute("data-test-role") || "hook";
    }, tokens).catch(() => "") as string;
    if (!found) return null;
    this.agingNotes.push(
      `"${String(step.note ?? field).slice(0, 34)}" resolved by the portal's own test hook ${JSON.stringify(found.slice(0, 40))} — stabler than the recorded id`,
    );
    return this.page.locator("[data-rc-hook-hit='1']").first();
  }

  /**
   * Pick the control whose SECTION matches the one recorded for this step.
   *
   * The learn side already captures it. PGE's two "Model" selects record as
   * `section: "Inverter Clone System"` and `section: "PV ArrayDelete Array"`, and PacifiCorp's
   * as the same pair — the exact disambiguator, sitting in the step's fingerprint, written
   * every time and read never. The selector rebuild for duplicate labels drops it (it builds
   * a fresh selector object around the element id), so resolution has been choosing between
   * identically-labelled controls on position and visibility alone.
   *
   * The section algorithm here is deliberately the SAME one the learner uses — fieldset
   * legend, then the enclosing panel's leading heading, then the nearest heading before the
   * field — because a section computed differently at replay would not match the string that
   * was recorded, and a comparison that never matches is worse than no comparison.
   */
  private async resolveBySection(step: RecipeStep): Promise<unknown | null> {
    if (!this.page || typeof this.page.evaluate !== "function") return null;
    const want = String(step.fingerprint?.section ?? "").trim();
    const label = String(step.fingerprint?.ariaLabel ?? step.selector?.label ?? "").trim();
    if (!want || !label) return null;
    const found = await this.page.evaluate((arg: { want: string; label: string }) => {
      const clean = (t: string | null | undefined): string => (t || "").replace(/\s+/g, " ").trim().slice(0, 80);
      const norm = (t: string): string => clean(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const sectionOf = (el: Element): string => {
        const fs = el.closest("fieldset");
        const legend = fs ? fs.querySelector("legend") : null;
        if (legend && clean(legend.textContent)) return clean(legend.textContent);
        const container = el.closest('section, [class*="panel"], [class*="card"], [class*="section"], [class*="form-section"], [class*="block"], [role="group"], [role="region"]');
        if (container) {
          const h = container.querySelector('legend, h1, h2, h3, h4, h5, h6, .panel-title, .card-title, .card-header, .section-title, .panel-heading');
          if (h && clean(h.textContent)) return clean(h.textContent);
        }
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
        return "";
      };
      const labelOf = (el: Element): string => {
        const id = el.getAttribute("id");
        const forLbl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        return clean(
          el.getAttribute("aria-label")
          || (forLbl ? forLbl.textContent : "")
          || (el.closest("label") ? (el.closest("label") as HTMLElement).textContent : "")
          || el.getAttribute("placeholder")
          || "",
        );
      };
      const wantS = norm(arg.want), wantL = norm(arg.label);
      let best: HTMLElement | null = null;
      let bestScore = -1;
      for (const el of Array.from(document.querySelectorAll("input, select, textarea")) as HTMLElement[]) {
        const l = norm(labelOf(el));
        if (!l || (l !== wantL && !l.includes(wantL) && !wantL.includes(l))) continue;
        const sec = norm(sectionOf(el));
        if (!sec) continue;
        // Exact section beats a containment match; a visible control beats a concealed one.
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const shown = r.width > 2 && r.height > 2 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) !== 0;
        let score = -1;
        if (sec === wantS) score = 4;
        else if (sec.includes(wantS) || wantS.includes(sec)) score = 2;
        if (score < 0) continue;
        if (shown) score += 1;
        if (score > bestScore) { bestScore = score; best = el; }
      }
      if (!best) return "";
      document.querySelectorAll("[data-rc-section-hit]").forEach((e) => e.removeAttribute("data-rc-section-hit"));
      best.setAttribute("data-rc-section-hit", "1");
      return sectionOf(best);
    }, { want, label }).catch(() => "") as string;
    if (!found) return null;
    this.agingNotes.push(
      `"${String(step.note ?? step.field ?? label).slice(0, 36)}" resolved by SECTION ${JSON.stringify(want.slice(0, 34))} rather than by its recorded selector`,
    );
    return this.page.locator("[data-rc-section-hit='1']").first();
  }

  /** A selector in one short phrase, for the resolution trail. */
  private describeSelector(sel?: RecipeSelector): string {
    if (!sel) return "(none)";
    const bits = [
      sel.css ? `css:${String(sel.css).slice(0, 40)}` : "",
      sel.label ? `label:${JSON.stringify(String(sel.label).slice(0, 30))}` : "",
      sel.role ? `role:${sel.role}` : "",
      sel.name ? `name:${JSON.stringify(String(sel.name).slice(0, 30))}` : "",
      sel.text ? `text:${JSON.stringify(String(sel.text).slice(0, 30))}` : "",
      sel.nth != null ? `nth:${sel.nth}` : "",
    ].filter(Boolean);
    return bits.join(" ") || "(empty)";
  }

  /**
   * Visible in the sense a PERSON means, not merely in Playwright's sense.
   *
   * The two differ, and the difference cost three fixes that never ran. Playwright counts an
   * `opacity: 0` control and a 1x1 control as VISIBLE — reasonably, since both can receive
   * events — while the diagnostic a human reads computes visibility from the box and the
   * computed style and calls them hidden. `visibilityAgreement.dom.smoke.ts` proves the
   * divergence on exactly those two shapes.
   *
   * Both are how a portal hides a native input behind a styled widget, and both are what
   * PowerClerk's `#pcInputBase34` "Model" combobox is. So the acceptance test kept saying
   * yes to a control the report was calling hidden, level 0 was accepted every run, and the
   * enabled check, the no-fallback fall-through and the unpinned ordinal twin were all
   * unreachable code for that step.
   *
   * The gate and the report must answer the same question. This is that question.
   */
  private async isTrulyVisible(loc: { evaluate?: (fn: unknown) => Promise<boolean>; isVisible?: () => Promise<boolean> } | null | undefined): Promise<boolean> {
    if (!loc) return false;
    if (typeof loc.evaluate !== "function") {
      return typeof loc.isVisible === "function" ? await loc.isVisible().catch(() => false) : false;
    }
    return await loc.evaluate((el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el as HTMLElement);
      return r.width > 2 && r.height > 2
        && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) !== 0;
    }).catch(() => false) as boolean;
  }

  /**
   * Reduce a locator to exactly one element, choosing the way a person would.
   *
   * Silent when there is nothing to choose (0 or 1 match), which is the common case.
   */
  /** A label that matched several controls: the one the step RECORDED (its id fallback), else
   *  the one in the section its binding names — only a UNIQUE answer. null = no decision. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async disambiguateByRecordedIdentity(loc: any, step: RecipeStep, n: number): Promise<any | null> {
    if (!loc || typeof loc.nth !== "function" || n <= 1) return null;
    // A REPEATED LABEL IS NOT A CHOICE BETWEEN EQUALS — THE STEP RECORDED WHICH ONE IT MEANT.
    //
    // PowerClerk prints "Name *" in the installer block AND the electrical-contractor block; a
    // label-first selector matches both, and "first visible" wrote the electrician into the
    // installer's box (the scoreboard's inst.name wrong_box). The recorded id fallback and the
    // step's binding (electricalSupervisorName → an Electrical section) each say which. Asked in
    // that order, and only a UNIQUE answer among the label's own matches is taken — an id alone
    // never overrides the label, it only chooses between controls that carry it.
    const sel = step.selector ?? {};
    const ids = new Set([step.fingerprint?.id, ...[sel, ...(sel.fallbacks ?? [])].map((s) => /^#([A-Za-z_][\w:.-]*)$/.exec(String(s?.css ?? ""))?.[1])]
      .filter((x): x is string => !!x));
    const side = SIDES.find((s) => s.field.test(String(step.field ?? "")));
    const probe: Array<{ i: number; id: string; section: string; visible: boolean }> = [];
    for (let i = 0; i < Math.min(n, 12); i++) {
      const c = loc.nth(i) as { evaluate?: (fn: unknown) => Promise<{ id: string; section: string }>; isVisible?: () => Promise<boolean> };
      if (typeof c.evaluate !== "function" || typeof c.isVisible !== "function") break;
      const info = await c.evaluate((el: Element) => {
        let section = "";
        for (let a: Element | null = el.parentElement; a && !section; a = a.parentElement) {
          const h = a.querySelector("h1, h2, h3, h4, h5, legend, [role=heading]");
          if (h && !h.contains(el)) section = (h.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
        }
        return { id: el.id || "", section };
      }).catch(() => null);
      if (!info) continue;
      probe.push({ i, id: info.id, section: info.section, visible: await c.isVisible().catch(() => false) });
    }
    const byId = probe.filter((p) => p.id && ids.has(p.id));
    if (byId.length === 1) {
      this.agingNotes.push(`"${String(step.note ?? step.action).slice(0, 40)}" matched ${n} controls — its recorded id picked one of them`);
      return loc.nth(byId[0].i);
    }
    if (side) {
      const graded = probe.filter((p) => p.visible).map((p) => ({ ...p, v: sideVerdict(side.side, p.section) }));
      const best = Math.max(0, ...graded.map((p) => p.v));
      const own = best > 0 ? graded.filter((p) => p.v === best) : [];
      if (own.length === 1) {
        this.agingNotes.push(`"${String(step.note ?? step.action).slice(0, 40)}" matched ${n} controls — the ${side.side} section (${own[0].section.slice(0, 30)}) is the one its binding names`);
        return loc.nth(own[0].i);
      }
    }
    return null;
  }

  private async narrowToOne(
    scoped: { count?: () => Promise<number>; nth?: (i: number) => unknown; first?: () => unknown } | null | undefined,
    step: RecipeStep,
  ): Promise<never> {
    if (!scoped || typeof scoped.count !== "function" || typeof scoped.nth !== "function") return scoped as never;
    let n = 0;
    try { n = await scoped.count(); } catch {
      this.driftWarnings.push(`"${String(step.note ?? step.action).slice(0, 40)}" — could not count what its selector matched, so it was acted on unnarrowed`);
      return scoped as never;
    }
    if (n <= 1) return scoped as never;
    {
      const picked = await this.disambiguateByRecordedIdentity(scoped, step, n);
      if (picked) return picked as never;
    }
    // THE STEP SAYS WHICH CONTROL IT WANTS — READ IT BEFORE TAKING THE FIRST ONE.
    //
    // A recipe can record a selector as bare as `{css: "select"}`, and Coos Bay's attachment
    // step does exactly that on a page carrying `ddlDocType` AND `ddlAlsoAttachTo`. Taking
    // the first visible match is a coin toss between "Document Type" and "Also Attach To",
    // and a wrong pick files the plan set under the wrong heading with nothing reported.
    //
    // The step's own note — "attachment: document type" — names it, and portals name their
    // controls too: doctype, docType, ddlDocType. Matching the note's words against each
    // candidate's id and name settles it, and it generalises to every bare selector a learn
    // ever records. Falls through to the first visible when nothing matches, unchanged.
    const words = String(step.note ?? step.field ?? "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()
      .split(/[^a-z]+/).filter((w) => w.length > 3 && !["attachment", "select", "field", "type"].includes(w));
    if (words.length) {
      for (let i = 0; i < Math.min(n, 12); i++) {
        const c = scoped.nth(i) as { evaluate?: (fn: unknown, arg: unknown) => Promise<boolean>; isVisible?: () => Promise<boolean> };
        if (typeof c.evaluate !== "function" || typeof c.isVisible !== "function") break;
        if (!(await c.isVisible().catch(() => false))) continue;
        const named = await c.evaluate((el: Element, ws: string[]) => {
          // PORTALS ABBREVIATE. The step says "document type"; the control is `ddlDocType`,
          // which camel-splits to "ddl doc type" — and "doc" does not CONTAIN "document".
          // Matching on a shared prefix of at least three characters bridges the ordinary
          // abbreviations (doc/document, desc/description, qty/quantity) without letting
          // two unrelated words collide.
          const tokens = `${el.getAttribute("id") || ""} ${el.getAttribute("name") || ""}`
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).filter(Boolean);
          return ws.every((w) => tokens.some((t) => t.length >= 3
            && (t === w || w.startsWith(t) || t.startsWith(w))));
        }, words).catch(() => false);
        if (named) {
          this.driftWarnings.push(
            `"${String(step.note ?? step.action).slice(0, 40)}" matched ${n} controls — chose the one whose own id/name says ${JSON.stringify(words.join(" "))}`,
          );
          return c as never;
        }
      }
    }
    for (let i = 0; i < Math.min(n, 12); i++) {
      const c = scoped.nth(i) as { isVisible?: () => Promise<boolean>; isEnabled?: () => Promise<boolean> };
      if (typeof c.isVisible !== "function") break;
      if (!(await c.isVisible().catch(() => false))) continue;
      const enabled = typeof c.isEnabled === "function" ? await c.isEnabled().catch(() => true) : true;
      if (!enabled) continue;
      this.driftWarnings.push(
        `"${String(step.note ?? step.action).slice(0, 44)}" matched ${n} elements — used the first visible, enabled one (a recorded selector naming several controls is not drift, but verify it)`,
      );
      return c as never;
    }
    // NOTHING VISIBLE AND ENABLED AMONG THEM — and say so. This branch returned `.first()`
    // silently, which is the only path through this function that leaves no trace, so a
    // strict-mode violation that survived the narrowing looked like the narrowing had never
    // run. Every other branch here reports; this one was the blind spot.
    this.driftWarnings.push(
      `"${String(step.note ?? step.action).slice(0, 40)}" matched ${n} elements and NONE were visible and enabled — acted on the first, which is a guess`,
    );
    return (typeof scoped.first === "function" ? scoped.first() : scoped) as never;
  }

  /**
   * A control whose menu is CLOSED, opened and picked from.
   *
   * Oregon ePermitting's entry point is a CSS hover menu: the trigger is
   * `<button class="dropbtn1" disabled>` — disabled ON PURPOSE, because the menu opens on
   * hover, not click — and the real destinations live in a sibling `.dropdown-content` that
   * is display:none until then. So the recorded "Apply" matched a control that can never be
   * clicked, and the items behind it ("Building Dept Application", "Onsite/Septic
   * Application") contain no "Apply" for a name search to find. Every layer answered
   * correctly and the filing still could not start.
   *
   * This is the "present but shut" pattern one level up: not a concealed field but a
   * concealed MENU. Hover the trigger, then choose among what appears — by the recipe's own
   * discipline when there are several, because "Building Dept Application" versus
   * "Onsite/Septic Application" is a question about the permit, not about the DOM.
   *
   * Refuses to guess: with several plausible items and nothing to separate them it returns
   * null and lists what it saw, which is a better failure than filing under the wrong module.
   */
  private async revealMenuAndPick(want: string, hint: string): Promise<unknown | null> {
    if (!this.page || typeof this.page.evaluate !== "function") return null;
    // 1) Find a trigger matching the recorded name that owns hidden links, and tag it.
    const armed = await this.page.evaluate((needle: string) => {
      const norm = (t: string): string => t.replace(/\s+/g, " ").trim();
      const strip = (t: string): string => norm(t).replace(/^[a-z][a-z_]{2,}(?=[A-Z])/, "");
      const wants = needle.toLowerCase();
      const triggers = Array.from(document.querySelectorAll("button, a, [role=button], summary")) as HTMLElement[];
      for (const t of triggers) {
        const label = strip(t.innerText || t.getAttribute("aria-label") || "");
        if (!label || !label.toLowerCase().includes(wants)) continue;
        // Its menu: the nearest ancestor that also holds links this trigger does not.
        let box: HTMLElement | null = t.parentElement;
        for (let up = 0; box && up < 3; up++, box = box.parentElement) {
          const links = Array.from(box.querySelectorAll("a[href]")).filter((a) => !t.contains(a));
          if (!links.length) continue;
          const hidden = links.filter((a) => {
            const r = a.getBoundingClientRect();
            return r.width < 4 || r.height < 4 || getComputedStyle(a as HTMLElement).display === "none";
          });
          if (!hidden.length) continue;
          document.querySelectorAll("[data-rc-trigger]").forEach((e) => e.removeAttribute("data-rc-trigger"));
          document.querySelectorAll("[data-rc-menu]").forEach((e) => e.removeAttribute("data-rc-menu"));
          t.setAttribute("data-rc-trigger", "1");
          box.setAttribute("data-rc-menu", "1");
          return true;
        }
      }
      return false;
    }, want).catch(() => false);
    if (!armed) return null;

    // 2) Open it the way a person would. Hover first — these menus are CSS-driven and the
    //    trigger is often deliberately unclickable; click only as a second attempt.
    const trigger = this.page.locator("[data-rc-trigger='1']").first();
    await trigger.hover({ timeout: 4000 }).catch(() => null);
    await this.page.waitForTimeout?.(250).catch(() => null);

    // 3) Pick from what is now showing.
    const picked = await this.page.evaluate((wantHint: string) => {
      const box = document.querySelector("[data-rc-menu='1']");
      if (!box) return "none";
      const shown = (Array.from(box.querySelectorAll("a[href]")) as HTMLElement[]).filter((a) => {
        const r = a.getBoundingClientRect();
        return r.width > 4 && r.height > 4 && getComputedStyle(a).display !== "none";
      });
      if (!shown.length) return "none";
      let chosen: HTMLElement | null = shown.length === 1 ? shown[0] : null;
      if (!chosen && wantHint) {
        const words = wantHint.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
        const hits = shown.filter((a) => words.some((w) => (a.innerText || "").toLowerCase().includes(w)));
        if (hits.length === 1) chosen = hits[0];
      }
      if (!chosen) return `ambiguous: ${shown.map((a) => JSON.stringify((a.innerText || "").trim().slice(0, 40))).join(", ")}`;
      document.querySelectorAll("[data-rc-name-hit]").forEach((e) => e.removeAttribute("data-rc-name-hit"));
      chosen.setAttribute("data-rc-name-hit", "1");
      return "ok";
    }, hint).catch(() => "none") as string;

    if (picked === "ok") {
      this.agingNotes.push(`"${want.slice(0, 30)}" is a closed menu — opened it and chose the entry matching ${JSON.stringify(hint.slice(0, 30))}`);
      return this.page.locator("[data-rc-name-hit='1']").first();
    }
    if (picked.startsWith("ambiguous")) {
      // REFUSE TO GUESS. Filing under the wrong module is worse than not filing.
      this.driftWarnings.push(`"${want.slice(0, 30)}" opened a menu but nothing identified which entry this recipe wants — ${picked.slice(0, 160)}`);
    }
    return null;
  }

  /**
   * Find a visible, ENABLED clickable whose name contains `want`, ignoring icon-font noise.
   *
   * Tags the winner with a data attribute and returns a locator for it, because there is no
   * other way to hand a specific in-page element back to Playwright from an evaluate.
   * Conservative on purpose: enabled and visible only, shortest match wins (so "Apply" does
   * not pick "Apply for a Licence" over "Apply"), and nothing is returned when the match is
   * ambiguous in size.
   */
  private async findEnabledControlByName(want: string): Promise<unknown | null> {
    if (!this.page || typeof this.page.evaluate !== "function") return null;
    const found = await this.page.evaluate((needle: string) => {
      const norm = (t: string): string => t.replace(/\s+/g, " ").trim();
      // Icon ligatures sit immediately before the real label with no separator and are
      // always lowercase words: "check_circleApply" -> "Apply", "eventSchedule" -> "Schedule".
      const strip = (t: string): string => norm(t).replace(/^[a-z][a-z_]{2,}(?=[A-Z])/, "");
      const wants = needle.toLowerCase();
      let best: HTMLElement | null = null;
      let bestLen = Infinity;
      const els = Array.from(document.querySelectorAll(
        "a, button, input[type=submit], input[type=button], [role=button], [role=link]",
      )) as HTMLElement[];
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        if ((el as HTMLButtonElement).disabled) continue;
        if (el.getAttribute("aria-disabled") === "true") continue;
        const label = strip(
          el.innerText || el.getAttribute("value") || el.getAttribute("aria-label") || el.getAttribute("title") || "",
        );
        if (!label) continue;
        if (!label.toLowerCase().includes(wants)) continue;
        if (label.length < bestLen) { best = el; bestLen = label.length; }
      }
      if (!best) return false;
      document.querySelectorAll("[data-rc-name-hit]").forEach((e) => e.removeAttribute("data-rc-name-hit"));
      best.setAttribute("data-rc-name-hit", "1");
      return true;
    }, want).catch((err: unknown) => {
      // DO NOT SWALLOW THIS. A recovery that fails silently is indistinguishable from a page
      // that genuinely had no match, and this whole session has been about that difference.
      // The evaluate can throw for reasons worth knowing — a navigation mid-read, a CSP, the
      // __name shim missing on a fresh document — and each needs a different fix.
      this.driftWarnings.push(
        `the name-based control recovery could not run: ${err instanceof Error ? err.message.slice(0, 90) : String(err).slice(0, 90)}`,
      );
      return false;
    });
    if (!found) {
      this.driftWarnings.push(`no enabled control on this page has a name containing "${want.slice(0, 40)}"`);
      return null;
    }
    return this.page.locator("[data-rc-name-hit='1']").first();
  }

  private async preferVisible(loc: any, sel?: RecipeSelector, hint?: string): Promise<any> {
    if (!loc || typeof loc.count !== "function" || sel?.nth != null) return loc;
    const collapse = () => (typeof loc.first === "function" ? loc.first() : loc);
    try {
      const n = await loc.count();
      if (n <= 1) return collapse();
      // The step being resolved recorded which of these it meant (id fallback / binding side).
      if (this.resolvingStep) {
        const picked = await this.disambiguateByRecordedIdentity(loc, this.resolvingStep, n);
        if (picked) return picked;
      }
      // VISIBLE AND ENABLED beats merely visible. Oregon ePermitting's landing page carries a
      // DISABLED decorative "Apply" nav pill; headless layout put it first in DOM order, this
      // returned it as "the visible match", and the click waited its full timeout on a button
      // that can never be clicked — while the real Apply link sat enabled right below. A
      // disabled control is no more the one the user acted on than a hidden one is. The first
      // visible-but-disabled match is kept only as the last resort, so when NOTHING is
      // enabled the failure stays the familiar one.
      // A STEP'S OWN WORDS BEAT ITS POSITION. `{css: "select"}` on Accela's attachment page
      // matches `ddlAlsoAttachTo` and `ddlDocType`; taking the first visible one files the
      // plan set under the wrong heading with nothing reported. The step is noted "attachment:
      // document type" and the portal names its control `ddlDocType`, so the answer is on the
      // page — it just was not reachable from here, because this collapses to ONE element
      // before any later stage can apply it. (Measured: the identity check downstream sees
      // count=1, which is why two earlier attempts to fix this downstream never ran at all.)
      //
      // Scored, not first-past-the-post: every id on that page contains `Attachment_24Edit`,
      // so "attachment" agrees with everything and only the specific word discriminates. A
      // tie means the words do not discriminate, and the old positional answer stands.
      if (hint) {
        const words = [...new Set(hint.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")
          .filter((w) => w.length > 3 && !IDENTITY_STOPWORDS.has(w)))];
        if (words.length) {
          const scored: Array<{ i: number; score: number }> = [];
          for (let i = 0; i < Math.min(n, 12); i++) {
            const c = loc.nth(i);
            if (typeof c.evaluate !== "function" || typeof c.isVisible !== "function") break;
            if (!(await c.isVisible().catch(() => false))) continue;
            scored.push({ i, score: await c.evaluate((el: Element, ws: string[]) => {
              const id = el.getAttribute("id") || "";
              const forLbl = id ? document.querySelector(`label[for="${id}"]`) : null;
              const lbl = String((forLbl as HTMLElement | null)?.innerText
                || (el.closest("label") as HTMLElement | null)?.innerText
                || el.getAttribute("aria-label") || "").toLowerCase();
              const toks = `${id} ${el.getAttribute("name") || ""}`
                .replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).filter(Boolean);
              return ws.filter((w) => lbl.includes(w)
                || toks.some((t) => t.length >= 3 && (t === w || w.startsWith(t) || t.startsWith(w)))).length;
            }, words).catch(() => 0) as number });
          }
          const top = Math.max(0, ...scored.map((x) => x.score));
          const winners = scored.filter((x) => x.score === top);
          if (top > 0 && winners.length === 1 && winners[0].i > 0) {
            this.agingNotes.push(
              `"${hint.slice(0, 40)}" matched ${n} controls — took #${winners[0].i}, the one this portal names for it, not the first`,
            );
            return loc.nth(winners[0].i);
          }
        }
      }
      let disabledFallback: any = null;
      for (let i = 0; i < Math.min(n, 12); i++) {
        const c = loc.nth(i);
        if (typeof c.isVisible !== "function") return collapse();
        if (!(await c.isVisible().catch(() => false))) continue;
        const enabled = typeof c.isEnabled === "function" ? await c.isEnabled().catch(() => true) : true;
        if (enabled) return c;
        if (!disabledFallback) disabledFallback = c;
      }
      if (disabledFallback) return disabledFallback;
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
  private async capturePageShot(label: string, force = false): Promise<void> {
    if (!this.page || typeof this.page.screenshot !== "function") return;
    // The OUTCOME shot is never dropped for the cap. It is the one picture that says what
    // happened to the filing — the record number on the completion page, or the portal's
    // refusal — and it is taken at the end of a long run, exactly where the cap bites.
    if (!force && this.pageShotCount >= 40) return;
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
      // The outcome sorts last in the folder and is the file the submission record points at.
      const name = force ? `zzz-outcome-${safe}.png` : `p${String(this.pageShotCount).padStart(3, "0")}-${safe}.png`;
      await this.page.screenshot({ path: path.join(this.pageShotDir, name), fullPage: true });
      if (force) this.outcomeShotPath = path.join(this.pageShotDir, name);
    } catch { /* best-effort: never fail a replay over a screenshot */ }
  }

  /**
   * Close any dropdown list, date picker or popover a previous step left open.
   *
   * Portal-agnostic on purpose: it looks for the SHAPES an open popup takes (an expanded
   * combobox, a shown menu, a visible listbox, a calendar) rather than any portal's class
   * names, because the portal this has to work on is the one nobody has opened yet.
   *
   * Called only when a step's control could not be reached, so the happy path pays nothing
   * and a popup the current step legitimately opened is never closed underneath it.
   * Returns whether anything was actually dismissed, so the caller knows to resolve again.
   */
  private async looksOutOfReach(
    scoped: { count?: () => Promise<number>; first?: () => { isVisible?: () => Promise<boolean> } } | null | undefined,
  ): Promise<boolean> {
    if (!scoped || typeof scoped.count !== "function") return false; // test fakes: unchanged behaviour
    try {
      if (await scoped.count() === 0) return true;
      const first = scoped.first?.();
      if (!first || typeof first.isVisible !== "function") return false;
      // THE SAME MEASURE THE GATE USES. This asked Playwright, which counts an opacity:0 or
      // 1x1 control as visible — so a concealed native input behind a styled widget read as
      // perfectly reachable, and every rescue hanging off this predicate stayed asleep. The
      // acceptance test was corrected for exactly this; leaving its sibling on the other
      // measure just moved the blind spot rather than closing it.
      return !(await this.isTrulyVisible(first as never));
    } catch { return false; }
  }

  /**
   * Is a popup open that the target is NOT part of?
   *
   * The distinction that keeps this safe. A recipe may record "open the dropdown" and
   * "choose the option" as two steps, and the option lives INSIDE the open list — dismissing
   * there would break the very interaction being replayed. A control that is merely COVERED
   * by someone else's list is the opposite case, and it is the one that cost a live filing
   * its inverter model. Containment tells them apart exactly; visibility does not, because
   * an occluded input is still visible by CSS.
   */
  private async overlayShadowsTarget(
    scoped: { first?: () => { evaluate?: (fn: unknown, arg: unknown) => Promise<boolean> } } | null | undefined,
  ): Promise<boolean> {
    const first = scoped?.first?.();
    if (!first || typeof first.evaluate !== "function") return false;
    return await first.evaluate((el: Element, sel: string) => {
      const open = Array.from(document.querySelectorAll(sel)).filter((o) => {
        const r = o.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return false;
        const cs = getComputedStyle(o as HTMLElement);
        return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) !== 0;
      });
      if (!open.length) return false;
      return !open.some((o) => o.contains(el));
    }, OPEN_POPUP_SELECTOR).catch(() => false) as boolean;
  }

  private async dismissStaleOverlays(): Promise<boolean> {
    if (!this.page || typeof this.page.evaluate !== "function") return false;
    const OPEN = OPEN_POPUP_SELECTOR;
    const countOpen = async (): Promise<number> => {
      if (!this.page || typeof this.page.evaluate !== "function") return 0;
      return await this.page.evaluate((sel: string) => {
        let n = 0;
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;
          const cs = getComputedStyle(el as HTMLElement);
          if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
          n++;
        }
        return n;
      }, OPEN).catch(() => 0) as number;
    };
    try {
      if (!(await countOpen())) return false;
      // Page-level Escape, never an element refocus — refocusing a combobox is how these
      // widgets OPEN, so "closing" one that way reopens it over the next control.
      for (let i = 0; i < 2; i++) {
        const kb = (this.page as { keyboard?: { press?: (k: string) => Promise<void> } }).keyboard;
        if (!kb?.press) return false;
        await this.guardedPress(kb, "Escape", "dismiss a stale popup").catch(() => null);
        await this.page.waitForTimeout?.(120).catch(() => null);
        if (!(await countOpen())) {
          this.driftWarnings.push(
            "a control was unreachable until a dropdown or date picker left open by an earlier step was dismissed",
          );
          return true;
        }
      }
      // THIRD ATTEMPT, AND NOT ANOTHER ESCAPE. A widget that ignored two Escapes will ignore a
      // third; what it usually has not been given is a reason to lose focus. These pickers
      // anchor to the focused input and close when it blurs, so blur first, then Escape once
      // more against the page. Still never a click — a blind click to dismiss an overlay is
      // how automation presses something it cannot see.
      const blurred = await this.page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (el && typeof el.blur === "function") { el.blur(); return true; }
        return false;
      }).catch(() => false);
      if (blurred) {
        const kb2 = (this.page as { keyboard?: { press?: (k: string) => Promise<void> } }).keyboard;
        await kb2?.press?.("Escape").catch(() => null);
        await this.page.waitForTimeout?.(120).catch(() => null);
        if (!(await countOpen())) {
          this.agingNotes.push("a dropdown or date picker ignored Escape and closed when the field it was anchored to lost focus");
          return true;
        }
      }
      // Still open: say so rather than drive a shadowed control silently. This is a SUSPICION
      // about values — "the next control may have been driven while covered" — and the run
      // ends holding a direct measurement of exactly that. See dischargeCoveredWarning.
      this.driftWarnings.push(COVERED_CONTROL_WARNING);
      return false;
    } catch { return false; /* a diagnostic must never fail a run */ }
  }

  // ── F1: THE kVA TIER FROM THE PAGE ────────────────────────────────────────────────────────
  //
  // Live run 99baa5d0 (City of Jefferson OR, 2026-09-27): the Coos Bay electrical recipe borrowed
  // onto MARION COUNTY's services page, 12.913 kVA AC, no Marion fee schedule on file. The
  // recorded "5.01kva through 15kva" box was left BLANK (R6, rightly: the donor's "1" is the donor
  // job's tier) and the run clicked Continue into "Please select at least 1 electrical service for
  // purchase". Every tier box prints its own bounds in its label, and the project's rating is
  // known (feeTierRatingKw — the same number the fee evaluator uses): the box to tick is decidable
  // from the page WITHOUT a schedule. A stored schedule, when there is one, must AGREE.
  //
  // What may never happen here: a guess. No rating, a rating in two tiers or in none, a schedule
  // that disagrees, a box that does not keep what it was given — all leave every tier box alone
  // and set feeTierStop, and the next advancing click pauses the run for a person.

  /** A recorded fill whose key is a fee-tier key, or whose label reads as a (non-wind) kVA tier. */
  private isFeeTierStep(step: RecipeStep): boolean {
    if (step.action !== "fill") return false;
    const label = String(step.selector?.label || step.note || "");
    const read = readTierLabel(label);
    if (read?.kind === "wind") return false;
    if (step.field && parseFeeBracketFieldKey(step.field)) return true;
    return !!read;
  }

  /** A click that leaves the page: the recorder's "advance:" wording, or a Continue/Next control. */
  private isAdvancingClick(step: RecipeStep): boolean {
    const note = String(step.note ?? "");
    if (/^advance\b/i.test(note)) return true;
    const name = `${step.selector?.name ?? ""} ${step.selector?.text ?? ""} ${note}`;
    return /\bcontinue\b|\bnext\b|save (and|&) continue/i.test(name) && !/add new|add contact|search|lookup|calculate/i.test(name);
  }

  /** Every visible text box on the page whose own label carries a kVA bound, by control id. The
   *  label is the portal's: label[for], then aria-label, then Accela's fieldname attribute. */
  private async readTierBoxes(): Promise<TierBoxOnPage[]> {
    if (!this.page || typeof this.page.evaluate !== "function") return [];
    // The unit gate is the leaf grammar's own (TIER_UNIT_RE: kVA AND kW, as pdfTables reads them —
    // close MF3), handed in as source text because a page function cannot close over it.
    return await this.page.evaluate((unitSrc: string) => {
      const unit = new RegExp(unitSrc, "i");
      const out: Array<{ id: string; label: string }> = [];
      const inputs = Array.from(document.querySelectorAll("input:not([type]), input[type='text'], input[type='number'], input[type='tel']")) as HTMLInputElement[];
      for (const el of inputs) {
        if (el.disabled || el.readOnly) continue;
        const r = el.getBoundingClientRect();
        const st = window.getComputedStyle(el);
        if (!(r.width > 0 && r.height > 0) || st.display === "none" || st.visibility === "hidden") continue;
        const id = el.id || "";
        if (!id) continue;
        let label = "";
        const lab = document.querySelector(`label[for="${(window as unknown as { CSS: { escape: (s: string) => string } }).CSS.escape(id)}"]`) as HTMLElement | null;
        if (lab) label = lab.innerText || lab.textContent || "";
        if (!label.trim()) label = el.getAttribute("aria-label") || el.getAttribute("fieldname") || "";
        if (!label.trim()) { const wrap = el.closest("label") as HTMLElement | null; if (wrap) label = wrap.innerText || ""; }
        label = label.replace(/\s+/g, " ").trim();
        if (!label || !unit.test(label)) continue;
        out.push({ id, label });
      }
      return out;
    }, TIER_UNIT_RE.source).catch(() => [] as TierBoxOnPage[]) as TierBoxOnPage[];
  }

  /** true = the chosen box holds the value; false = nothing typed (feeTierStop set, or a second
   *  step for an already-ticked page); "normal" = this page prints no kVA box at all — the recorded
   *  step takes its ordinary resolve path, UNDER A PROVISIONAL STOP (see below). */
  private async fillFeeTierFromPage(step: RecipeStep): Promise<boolean | "normal"> {
    const boxes = await this.readTierBoxes();
    if (!boxes.length) {
      // A RECORDED TIER STEP THAT FINDS NO kVA-LABELLED BOX (close MF2). The recipe KNOWS this page
      // needs a service line ticked; tier labels the grammar cannot read, a single un-tiered
      // "Renewable energy systems (solar)" box that asks for a count, the tier as a <select> — each
      // used to skip the step and click Continue into "Please select at least 1 electrical service
      // for purchase". FAIL CLOSED: the stop is set now and withdrawn ONLY when this step then
      // types a real quantity through its recorded box (an own recipe whose stored schedule keyed
      // it). Every skip path — a blank R6 key, a refused literal, an optional skip — leaves it
      // standing, and the pause-before-Continue fires. Never a guessed "1".
      const v = String(this.resolveValue(step) ?? "").trim();
      this.feeTierStop = FEE_TIER_NO_BOX_REASON;
      this.feeTierProvisionalAt = this.currentStepIdx;
      this.driftWarnings.push(`kVA tier: ${FEE_TIER_NO_BOX_REASON} ("${String(step.selector?.label || step.note || step.field || "tier box").replace(/:\s*$/, "").slice(0, 70)}")`);
      if (!v || v === "0") { this.noteUnresolved(step); return false; }
      // AC ONLY, on this path too (live-run-jefferson-close skeptic MF1). The recorded box's value
      // comes from the stored schedule, whose evaluator falls back to DC when the project has no AC
      // rating — so with no AC it would tick the DC tier (td-only labels readTierBoxes cannot
      // reach). No AC rating: nothing is typed, and the stop stands with the AC wording.
      const acRaw = Number(String(this.fieldValues[FEE_TIER_RATING_FIELD] ?? "").trim() || NaN);
      if (!(Number.isFinite(acRaw) && acRaw > 0)) {
        const dcRaw = Number(String(this.fieldValues[FEE_TIER_DC_FIELD] ?? "").trim() || NaN);
        this.feeTierStop = Number.isFinite(dcRaw) && dcRaw > 0
          ? `the project has no AC (inverter) rating; DC is ${kvaText(dcRaw)} kW — confirm the AC size`
          : "the project has no AC (inverter) rating and no DC size either — confirm the AC size";
        this.driftWarnings.push(`kVA tier NOT typed: ${this.feeTierStop}`);
        this.noteUnresolved(step);
        return false;
      }
      return "normal";
    }
    const ratingRaw = String(this.fieldValues[FEE_TIER_RATING_FIELD] ?? "").trim();
    const ratingNum = ratingRaw ? Number(ratingRaw) : NaN;
    const ratingKw = Number.isFinite(ratingNum) && ratingNum > 0 ? ratingNum : null;
    const dcNum = Number(String(this.fieldValues[FEE_TIER_DC_FIELD] ?? "").trim() || NaN);
    const dcKw = Number.isFinite(dcNum) && dcNum > 0 ? dcNum : null;
    const scheduleTierKey = Object.entries(this.fieldValues).find(([k, val]) => parseFeeBracketFieldKey(k) && String(val).trim() === "1")?.[0] ?? null;
    const stepLabel = String(step.selector?.label || step.note || step.field || "tier box").replace(/:\s*$/, "").slice(0, 70);
    const decision = decideFeeTier({ boxes, ratingKw, dcKw, scheduleTierKey });
    if (!decision.chosen) {
      this.feeTierStop = decision.reason;
      this.driftWarnings.push(`kVA tier NOT typed for "${stepLabel}": ${decision.reason}`);
      this.noteUnresolved(step);
      return false;
    }
    const chosen = decision.chosen;
    const chosenLabel = chosen.label.replace(/:\s*$/, "").slice(0, 70);
    const pageKey = (await this.pageIdentity().catch(() => "")) || "page";
    const loc = this.page.locator(`[id="${chosen.id}"]`).first();
    await waitForElement(loc);
    const current = String((await loc.inputValue().catch(() => "")) ?? "");
    if (current !== chosen.value) {
      await loc.fill(chosen.value, { timeout: FILL_TIMEOUT_MS });
      await this.commitAndSettle(loc);
    }
    const held = String((await loc.inputValue().catch(() => "")) ?? "");
    if (held !== chosen.value) {
      this.feeTierStop = `typed "${chosen.value}" into "${chosenLabel}" and the box did not keep it (it reads "${held}")`;
      this.driftWarnings.push(`kVA tier NOT held: ${this.feeTierStop}`);
      this.noteUnresolved(step);
      return false;
    }
    this.feeTierStop = null;
    if (!this.fieldsVerified.includes(chosenLabel)) this.fieldsVerified.push(chosenLabel);
    if (this.feeTierFilled.get(pageKey) !== chosen.id) {
      this.feeTierFilled.set(pageKey, chosen.id);
      this.agingNotes.push(`kVA tier read from the page: ${ratingRaw} kVA → "${chosenLabel}" = ${chosen.value}${scheduleTierKey ? " (the stored fee schedule agrees)" : " (no fee schedule needed — the page prints its own bounds)"}`);
      const recorded = readTierLabel(stepLabel);
      if (recorded && !sameFeeTier(recorded, chosen.bounds)) {
        this.agingNotes.push(`the recorded box "${stepLabel}" is not this project's tier — "${chosenLabel}" was ticked instead, and the recorded box was left empty`);
      }
      // The constructor's coverage warning ("this job's bracket has NO box in the recorded recipe")
      // was written for a run that could only type into recorded boxes. The box was found on the
      // page: withdraw it, on both channels it was posted to.
      const stale = (m: string) => /has NO box in the recorded recipe/.test(m);
      if (this.driftWarnings.some(stale) || this.gapFillReport.reportedMissing.some(stale)) {
        this.driftWarnings = this.driftWarnings.filter((m) => !stale(m));
        this.gapFillReport.reportedMissing = this.gapFillReport.reportedMissing.filter((m) => !stale(m));
        this.agingNotes.push(`the "no box in the recorded recipe" warning is withdrawn — the tier box was read off the page and ticked`);
      }
    }
    return true;
  }

  /** F2 — THE PORTAL'S OWN WORDS: the generic validation reader plus the WebForms/Accela banner
   *  families it does not know (safeAction.collectPortalErrorBanner). Banner first: it is the
   *  portal's sentence, and "An error has occurred. Please select at least 1 electrical service for
   *  purchase" is worth more than any field-level echo. */
  private async readPortalRefusal(): Promise<string[]> {
    const banner = await collectPortalErrorBanner(this.page).catch(() => [] as string[]);
    const generic = await collectValidationErrorsFrom(this.page).catch(() => [] as string[]);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const t of [...banner, ...generic]) {
      const line = String(t).replace(/\s+/g, " ").trim();
      const key = line.toLowerCase();
      if (!line || seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
    return out.slice(0, 20);
  }

  /** F4/F5 — BEFORE SPENDING selectOption's TIMEOUTS on a native select, read its loaded list
   *  once. An exact/contains candidate (what selectWithFallback would land) → let it run. Nothing
   *  direct, but the wanted value and exactly ONE option share a STRUCTURE-TYPE MEANING (R5:
   *  Category of Construction = the structure type; "1-1 or 2 Family Dwelling" ≡ Marion's "Single
   *  Family Dwelling"; permitProcess.structureTypeMeaning) → land that option here, by label.
   *  Nothing at all on a LOADED list → the known negative costs no timeouts (live: 44 s on one
   *  select). An unloaded or non-native control takes the old path unchanged. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async trySelect(loc: any, value: string, step: RecipeStep): Promise<{ selected: boolean; landedAs: string; how: "" | "meaning" | "known_negative" }> {
    const native = await this.isNativeSelect(loc);
    if (native && !(await this.optionsLookUnloaded(loc))) {
      // TEXT AND VALUE. selectOption(value) matches the option's VALUE attribute first, and a
      // recorded state is bound to the 2-letter code Accela's contact dialog stores
      // (<option value="TX">Texas</option>): a text-only read called "TX" a known negative.
      const options: Array<{ value: string; text: string }> = await loc.evaluate((el: Element) => Array.from((el as HTMLSelectElement).options)
        .map((o) => ({ value: String(o.value ?? ""), text: (o.textContent || "").replace(/\s+/g, " ").trim() }))).catch(() => [] as Array<{ value: string; text: string }>);
      const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
      const w = norm(value);
      const placeholder = (t: string) => !t || /^(please\s+)?select\.{0,3}$|^-+\s*select\s*-+$/i.test(t);
      const realOptions = options.filter((o) => !placeholder(o.text));
      const real = realOptions.map((o) => o.text);
      const direct = !!w && realOptions.some((o) => norm(o.value) === w || norm(o.text) === w || norm(o.text).includes(w) || w.includes(norm(o.text)));
      if (!direct && real.length) {
        const meaning = structureTypeMeaning(value);
        const label = this.stepLabel(step);
        const wantsStructure = meaning === "single_family" || /category of construction|structure type|building type|type of structure|occupancy/i.test(label);
        if (meaning && wantsStructure) {
          const same = real.filter((t) => structureTypeMeaning(t) === meaning);
          if (same.length === 1) {
            const landed = await loc.selectOption({ label: same[0] }, { timeout: 5000 }).then(() => true).catch(() => false);
            if (landed) {
              this.agingNotes.push(`select "${label}" landed "${same[0]}" by MEANING — wanted "${value}" (the structure type in this agency's own words; state guidance R5), no LLM`);
              return { selected: true, landedAs: same[0], how: "meaning" };
            }
          } else if (same.length > 1) {
            this.driftWarnings.push(`select "${label}": ${same.length} options mean "${meaning}" (${same.map((s) => JSON.stringify(s)).join(", ")}) — none chosen`);
          }
        }
        return { selected: false, landedAs: value, how: "known_negative" };
      }
    }
    const selected = await selectWithFallback(this.page, loc, value);
    return { selected, landedAs: value, how: "" };
  }

  /** F3 — AN ERROR LANDING IS RECOGNISED AT ONCE AND RE-ENTERED, not waited out. Accela answers a
   *  request it cannot serve with its own Error.aspx (blank; it refreshes itself to the dashboard
   *  some 20 s later — the operator's recording, f001→f002). Give the portal's own redirect a short
   *  grace, then go back to `target` ourselves; three tries inside a bounded budget, every one
   *  reported as progress so the dashboard says "Waiting for the portal (error page, retrying…)"
   *  instead of freezing. Returns true when the page is STILL an error page after the budget (the
   *  caller then skips the controls wait; the next step's failure carries the context). */
  private async recoverFromPortalErrorPage(target: string, why: string): Promise<boolean> {
    if (!this.page || typeof this.page.evaluate !== "function") return false;
    const GRACE_MS = 3000;
    const TRIES = 3;
    const started = Date.now();
    let err = await portalErrorPage(this.page);
    if (!err) return false;
    this.agingNotes.push(`entry landed on ${err} — re-entered ${String(target).replace(/^https?:\/\//, "").slice(0, 60)} without waiting it out`);
    for (let attempt = 1; attempt <= TRIES && err; attempt++) {
      this.progress("wait", `Waiting for the portal (error page, retrying… ${attempt}/${TRIES})`, Date.now() - started);
      // The portal's own redirect first (cheap, and it keeps whatever state the portal wanted).
      const before = String(this.page.url?.() ?? "");
      const deadline = Date.now() + GRACE_MS;
      while (Date.now() < deadline) {
        await sleep(250);
        if (String(this.page.url?.() ?? "") !== before) break;
      }
      err = await portalErrorPage(this.page);
      if (!err) break;
      await this.guardedGoto(target, `${why} — re-enter after the portal's error page`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
      err = await portalErrorPage(this.page);
    }
    if (err) {
      this.driftWarnings.push(`the portal kept answering with ${err} for ${Math.round((Date.now() - started) / 1000)}s (${TRIES} re-entries) — the next step runs against it`);
      return true;
    }
    this.agingNotes.push(`recovered from the portal's error page in ${Math.round((Date.now() - started) / 1000)}s`);
    return false;
  }

  /** A progress line for the dashboard (options.onProgress); never throws, never carries PII. */
  private progress(phase: "open" | "login" | "goto" | "step" | "wait", message: string, elapsedMs: number, stepIndex?: number): void {
    const sink = this.options.onProgress;
    if (!sink) return;
    try { sink({ phase, message: message.slice(0, 200), elapsedMs, ...(stepIndex != null ? { stepIndex } : {}) }); } catch { /* a progress sink must never break a run */ }
  }

  /** Run `work` while reporting progress every 10 s until it finishes (F3: a wait longer than ten
   *  seconds says what it is waiting on instead of freezing the dashboard). */
  private async withProgress<T>(phase: "open" | "login" | "goto" | "step" | "wait", what: string, work: () => Promise<T>, stepIndex?: number): Promise<T> {
    const started = Date.now();
    this.progress(phase, what, 0, stepIndex);
    const timer = this.options.onProgress
      ? setInterval(() => this.progress(phase, `${what} (still waiting — ${Math.round((Date.now() - started) / 1000)}s)`, Date.now() - started, stepIndex), 10_000)
      : null;
    try { return await work(); } finally { if (timer) clearInterval(timer); }
  }

  /** Record a step that had no value in the project to give it. */
  private noteUnresolved(step: RecipeStep): void {
    const name = String(step.note || step.field || step.action).slice(0, 70);
    if (name && !this.unresolvedFields.includes(name)) this.unresolvedFields.push(name);
  }

  /**
   * Did the control keep what we gave it?
   *
   * DELIBERATELY LENIENT, because portals reformat what you type and a FALSE miss is the
   * expensive direction: it costs a retry, a drift warning, and a demoted benchmark run on
   * a filing that was actually correct. A phone becomes "(503) 555-0142", a decimal field
   * turns 7.2 into 7.20, and a date input rewrites 2026-10-01 as 10/01/2026 — none of those
   * are failures. Only an empty box, or a value sharing nothing with what we typed, is.
   */
  /** Commit a field the way a person does — leave it — and settle on what that started
   *  (settle.ts commitField: blur, Tab as the fallback, then PageRequestManager / postback /
   *  request / DOM quiet). A control without a page behind it (unit-test fakes) is blurred. */
  private async commitAndSettle(scoped: unknown): Promise<void> {
    const loc = scoped as { blur?: (o?: unknown) => Promise<void>; page?: () => unknown } | null;
    if (!loc) return;
    const real = typeof loc.page === "function" && this.page && typeof this.page.evaluate === "function" && typeof this.page.addInitScript === "function";
    if (real) {
      // quietMs 450: longer than the ~300ms a portal waits before re-rendering a block from its
      // saved state after an autosave, so a re-render that is coming is waited for, not raced.
      await commitField(loc as never, { timeoutMs: 8000, quietMs: 450 }).catch(() => null);
      return;
    }
    if (typeof loc.blur === "function") await loc.blur().catch(() => {});
  }

  /** Does the intended select/combobox show `want`? Reads the SELECTED OPTION (text and value)
   *  of a native select, the value/text of a combobox face. null = could not read (not
   *  evidence either way). */
  private async selectionHeld(scoped: unknown, want: string): Promise<boolean | null> {
    const loc = scoped as { evaluate?: (fn: (el: Element) => string) => Promise<string> } | null;
    if (!loc || typeof loc.evaluate !== "function" || !want.trim()) return null;
    const shown = await loc.evaluate((el: Element) => {
      if (el.tagName === "SELECT") {
        const s = el as HTMLSelectElement;
        const o = s.options[s.selectedIndex];
        return o ? `${o.text}\u0001${o.value}` : "";
      }
      const i = el as HTMLInputElement;
      return String((typeof i.value === "string" && i.value) || el.textContent || "");
    }).catch(() => null as unknown as string);
    if (shown === null || shown === undefined) return null;
    const [text, value] = String(shown).split("\u0001");
    if (!String(text ?? "").trim() && !String(value ?? "").trim()) return false;
    return readbackMatches(String(text ?? ""), want) || (value !== undefined && readbackMatches(value, want));
  }

  private async fillHeld(
    scoped: { inputValue?: (opts?: { timeout?: number }) => Promise<string> } | null | undefined,
    expected: string,
  ): Promise<boolean> {
    if (!scoped || typeof scoped.inputValue !== "function") return true; // nothing to read (test fakes)
    const shown = String(await scoped.inputValue({ timeout: 2000 }).catch(() => "__unreadable__"));
    if (shown === "__unreadable__") return true; // an unreadable control is not evidence of a miss
    const want = String(expected ?? "").trim();
    if (!want) return true;
    if (!shown.trim()) return false; // the one unambiguous failure: we typed, the box is empty
    const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const a = norm(shown), b = norm(want);
    if (a === b) return true;
    const na = Number(shown.replace(/[^0-9.-]/g, "")), nb = Number(want.replace(/[^0-9.-]/g, ""));
    if (Number.isFinite(na) && Number.isFinite(nb) && na === nb && a && b) return true;
    // The box may DECORATE what we typed (a mask adds "(", ")", a suffix), so shown ⊇ wanted
    // holds. The reverse — the box shows a FRAGMENT of what we typed — is the signature of a
    // re-render that wiped the field mid-typing ("0199" left of "541-555-0199"), and it used to
    // read as held. It is a miss.
    if (a.includes(b)) return true;
    // A date input reorders its parts rather than losing them: 2026-10-01 → 10/01/2026.
    const parts = (s: string): string => (s.match(/\d+/g) ?? []).map((n) => String(Number(n))).sort().join("-");
    if (parts(shown) && parts(shown) === parts(want)) return true;
    return false;
  }

  /**
   * Required controls still empty on this page.
   *
   * The logic moved to requiredControlSweep.ts so it could be TESTED. It could not be,
   * living here as a private method, and it was wrong: a live PacifiCorp replay scored
   * "nothing was left blank" on a page showing "This field is required." under an empty
   * module select and an empty "Total System Export (kW) *". See that module for both
   * misses; the smoke reproduces the page.
   */
  /** The page a person would say they are on — the active wizard tab, else the heading. */
  private async pageLabelNow(): Promise<string> {
    if (typeof this.page?.evaluate !== "function") return "";
    return await this.page.evaluate(() => {
      const clean = (t: string | null | undefined): string => (t || "").trim().replace(/\s+/g, " ").slice(0, 48);
      const active = document.querySelector('.nav-link.active, [aria-current="page"], [class*="active"]');
      const fromTab = clean(active && (active as HTMLElement).innerText);
      if (fromTab) return fromTab;
      const h = document.querySelector("h1, h2, legend");
      return clean(h && (h as HTMLElement).innerText);
    }).catch(() => "") as Promise<string>;
  }

  /** A FILE HANDED TO THE BROWSER IS NOT A FILE THE PORTAL HAS TAKEN.
   *
   *  setInputFiles returns the instant the input holds the file; the transfer that follows
   *  is the portal's own async upload, and everything the recipe does next -- the
   *  description, the type, the Save that commits it -- happens while that is still in
   *  flight. Live on Coos Bay: Accela's review page showed a filing that was otherwise
   *  complete, the upload bar at 0%, Save greyed out, an empty attachment table and the
   *  portal's own "Your documents are not yet saved" banner. Continue was refused after
   *  that, and the run reported "the portal did not advance" -- true, and a symptom.
   *
   *  The learn side already waits for this ("ACA keeps the Save anchor inside a container it
   *  reveals with JS only once the uploads finish"). Replay replays the recorded clicks and
   *  waits for nothing. This is that wait, written portably: hold while any visible progress
   *  indicator reads under 100%, and give up saying so rather than silently proceeding into
   *  a Save the portal will refuse. */
  private async waitForUploadAccepted(): Promise<void> {
    if (!this.page || typeof this.page.evaluate !== "function") return;
    // EVERY FRAME, NOT JUST THE TOP ONE. Accela runs its whole attachment dialog inside
    // iframe[name="ACADialogFrame"] — the file input, the description, the Type select, the
    // Save anchor and the progress bar, all of it. The learn side has always reached into
    // that frame by name; page.evaluate cannot see any of it. So this wait, written for
    // exactly that portal, was looking at a document that could never contain the thing it
    // was waiting for, found nothing, and returned — which is precisely the silence the
    // post-fix pilot showed.
    const scanIn = async (frame: { evaluate?: (fn: unknown) => Promise<unknown> }): Promise<number | null> => {
      if (typeof frame?.evaluate !== "function") return null;
      return await frame.evaluate(() => {
      const visible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const cs = getComputedStyle(el as HTMLElement);
        return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) !== 0;
      };
      let worst: number | null = null;
      const note = (n: number): void => { if (n < 100 && (worst === null || n < worst)) worst = n; };
      for (const el of Array.from(document.querySelectorAll("progress")) as HTMLProgressElement[]) {
        if (!visible(el) || !(el.max > 0)) continue;
        note(Math.round((el.value / el.max) * 100));
      }
      const bars = document.querySelectorAll('[role="progressbar"], .progress-bar, [class*="progress"], [class*="upload"]');
      for (const el of Array.from(bars) as HTMLElement[]) {
        if (!visible(el)) continue;
        // A MISSING aria-valuenow IS NOT 0%. Number(null) is 0, so every Bootstrap-style
        // ".progress" wizard nav and "upload-*" container read as a stalled upload: each
        // attach waited the full UPLOAD_ACCEPT_MS and reported "still taking a document (0%)".
        // Only an element that states a value — the attribute, or its own "N%" text — is a
        // progress reading.
        const raw = el.getAttribute("aria-valuenow");
        const now = raw !== null && raw.trim() !== "" ? Number(raw) : NaN;
        if (Number.isFinite(now) && now >= 0) { note(now); continue; }
        const m = (el.innerText || "").trim().match(/^(\d{1,3})%$/);
        if (m) note(Number(m[1]));
      }
      return worst;
      }).catch(() => null) as number | null;
    };

    const pending = async (): Promise<number | null> => {
      const frames: Array<{ evaluate?: (fn: unknown) => Promise<unknown> }> =
        typeof this.page.frames === "function" ? this.page.frames() : [this.page];
      let worst: number | null = null;
      for (const f of frames.slice(0, 12)) {
        const n = await scanIn(f);
        if (n === null) continue;
        if (worst === null || n < worst) worst = n;
      }
      return worst;
    };

    // WAIT FOR THE INDICATOR TO APPEAR, NOT JUST TO EXIST. An uploader binds to the input's
    // change event, so the bar is drawn a beat AFTER setInputFiles returns — and the first
    // version of this asked once, saw nothing, and returned before the portal had started.
    // On a live Coos Bay run that produced exactly the silence it was written to remove: no
    // wait, no warning, and the same refused Continue eleven steps later.
    let first: number | null = null;
    const appearBy = Date.now() + UPLOAD_APPEAR_MS;
    for (;;) {
      first = await pending();
      if (first !== null) break;
      if (Date.now() >= appearBy) return;             // nothing here reports progress at all
      await sleep(250);
    }
    const deadline = Date.now() + UPLOAD_ACCEPT_MS;
    let last = first;
    while (Date.now() < deadline) {
      await sleep(500);
      const now = await pending();
      if (now === null) return;                      // the indicator went away: taken
      last = now;
    }
    // STILL UNFINISHED, AND SAY SO. A Save clicked over an incomplete upload is refused, and
    // the refusal surfaces pages later as an advance that "did not work" -- naming it here
    // is the difference between one line an operator can act on and a hunt through a wizard.
    this.driftWarnings.push(`the portal was still taking a document (${last}%) after ${Math.round(UPLOAD_ACCEPT_MS / 1000)}s — anything that commits it will be refused until it finishes`);
  }

  /** A RECORDED RECORD NUMBER NAMES SOMEBODY ELSE'S APPLICATION.
   *
   *  Coos Bay's structural recipe carries `click - human-patch: 187-26-000309-STR`: a link
   *  named after the record the LEARN session created. That record is real, it belongs to a
   *  filing made months ago, and it can never appear in a new run - so the step spends its
   *  full 30s timeout and takes the recipe down with it, on all three attempts of the sweep.
   *
   *  The engine can do better than fail, and the safe version is narrow. The link this run
   *  wants is the record THIS run just created. So: only when the recorded name is itself
   *  record-shaped, only when it is genuinely absent, and only when EXACTLY ONE
   *  record-shaped link is on the page, re-anchor to that one. Several means a records
   *  LIST - the operator's real, already-filed applications - and there the answer is to
   *  refuse and let the step fail, because clicking into a stranger's filing is far worse
   *  than stopping. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async reanchorRecordNumberLink(step: RecipeStep): Promise<any | null> {
    if (!this.page || step.action !== "click") return null;
    const recorded = String(step.selector?.name ?? step.selector?.text ?? step.note ?? "")
      .replace(/^human-patch:\s*/i, "").trim();
    if (!recorded || !RECORD_NUMBER.test(recorded)) return null;
    const links = this.page.getByRole("link");
    const n = await links.count().catch(() => 0);
    if (!n) return null;
    const found: Array<{ i: number; text: string }> = [];
    for (let i = 0; i < Math.min(n, 60); i++) {
      const t = ((await links.nth(i).innerText().catch(() => "")) || "").trim();
      const m = t.match(RECORD_NUMBER);
      if (!m) continue;
      if (m[0] === recorded) return null;              // it IS here; nothing to re-anchor
      if (!(await this.isTrulyVisible(links.nth(i)))) continue;
      found.push({ i, text: m[0] });
    }
    const distinct = [...new Set(found.map((f) => f.text))];
    if (distinct.length !== 1) {
      if (distinct.length > 1) {
        this.driftWarnings.push(`the recipe clicks record "${recorded}" from its learn session, and this page offers ${distinct.length} different records - REFUSING to guess which is this filing`);
      }
      return null;
    }
    this.agingNotes.push(`the recipe clicks record "${recorded}" from its own learn session - re-anchored to "${distinct[0]}", the record this run created`);
    return links.nth(found[0].i);
  }

  /** TICK A STYLED CHECKBOX THE WAY A PERSON DOES — BY ITS LABEL.
   *
   *  A portal that draws its own checkbox keeps the real <input> for form submission and
   *  hides it under a styled span; the click handler is bound to the label. Playwright can
   *  resolve and click that input all day and the state never moves, which is exactly what
   *  "Clicking the checkbox did not change its state" means.
   *
   *  Both shapes are tried: the label that POINTS at the input (label[for]) and the label
   *  that WRAPS it. Only a truly visible one is worth clicking — a concealed label is the
   *  same dead end as the concealed input. Returns whether the box actually ended up
   *  checked, read back from the control rather than assumed from the click. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async checkViaLabel(target: any): Promise<boolean> {
    if (!this.page || !target?.first) return false;
    const box = target.first();
    if (await box.isChecked().catch(() => false)) return true;
    const id = await box.getAttribute("id").catch(() => null);
    const routes: unknown[] = [];
    if (id) routes.push(this.page.locator(`label[for="${String(id).replace(/"/g, '\\"')}"]`));
    if (typeof box.locator === "function") routes.push(box.locator("xpath=ancestor::label[1]"));
    for (const r of routes) {
      const loc = r as { count?: () => Promise<number>; first?: () => { click?: (o?: unknown) => Promise<void> } };
      if (typeof loc.count !== "function" || !(await loc.count().catch(() => 0))) continue;
      const one = loc.first?.();
      if (!one?.click) continue;
      if (!(await this.isTrulyVisible(one as never))) continue;
      await this.guardedClick(one, "tick a styled checkbox by its label", { timeout: 6000 }).catch(() => null);
      if (await box.isChecked().catch(() => false)) return true;
    }
    return false;
  }

  /** THE ONLY PLACE THE SWEEP IS CALLED, so the denominator cannot leak. Both callers want
   *  the blanks; only one of them used to record what the portal ASKED for, and the one that
   *  didn't is `pageIsPassThrough` — the path a page takes when its required fields arrived
   *  already filled from the account. That is precisely the page whose required fields count,
   *  and routing it through here is what keeps a clean run from printing "verified 47,
   *  required 0" — a sentence that cannot be told apart from never having looked. */
  /** A MEASUREMENT BEATS A SUSPICION.
   *
   *  The covered-control warning says the next control MAY have been driven while an overlay
   *  sat over it. That is a guess about whether values landed — and by the end of the run we
   *  no longer have to guess: every fill reads its value back, every select reports whether
   *  it took, every advancing click now reports whether anything moved, and the required
   *  sweep says what the portal still wants. If all four of those came back clean, the thing
   *  the warning was worried about did not happen.
   *
   *  So it is withdrawn — into agingNotes, not deleted, because the portal quirk is real and
   *  the operator should still know the picker fought us. If ANY value failed to verify the
   *  warning stands, which is the direction that matters: the discharge is evidence, never
   *  optimism. */
  private dischargeCoveredWarning(): void {
    const i = this.driftWarnings.indexOf(COVERED_CONTROL_WARNING);
    if (i < 0) return;
    if (this.fieldsUnverified.length || this.requiredStillEmpty.length) return;
    this.driftWarnings.splice(i, 1);
    this.agingNotes.push(
      `a dropdown or date picker stayed open despite Escape and a blur — but every one of ${this.fieldsVerified.length} value(s) read back correctly and the portal flagged nothing empty, so nothing was driven while covered`,
    );
  }

  private async sweepRequired(): Promise<{ empty: EmptyRequired[]; requiredSeen: string[] }> {
    if (!this.page) return { empty: [], requiredSeen: [] };
    const found = await sweepEmptyRequiredControls(this.page);
    for (const name of found.requiredSeen) {
      if (!this.requiredFieldsSeen.includes(name)) this.requiredFieldsSeen.push(name);
    }
    const held = await this.uploadSlotsHeld(found.empty.map((e) => e.name));
    if (held.size) return { ...found, empty: found.empty.filter((e) => !held.has(e.name)) };
    return found;
  }

  private noteUploadPerformed(label: string, file: unknown, docType?: string): void {
    const fileName = typeof file === "string" ? path.basename(file)
      : String((file as { name?: unknown } | null)?.name ?? "");
    if (label && fileName) this.uploadsPerformed.push({ label, fileName, ...(docType ? { docType } : {}) });
  }

  /** AN EMPTY FILE BOX IS NOT A MISSING DOCUMENT. A browser never restores a file input's
   *  value, so after the portal takes the upload and re-renders (Accela's Save, any postback)
   *  the required slot reads EMPTY beside the portal's own "Uploaded: plan-set.pdf". The sweep
   *  reported that as a required field "that would not stay filled" on every Accela replay whose
   *  server held the document — telling a person to attach by hand what was already attached.
   *
   *  Discharged ONLY on positive evidence, read back from the page now: (a) this run performed
   *  the recorded upload for a slot of that label, (b) a visible FILE input carries that label,
   *  and (c) the page lists the exact file name the run handed the portal. A slot the run never
   *  uploaded to, a same-named text box, or a page that does not list the file all stay blank —
   *  pageIsPassThrough shares this sweep, and a false "filled" there clicks past a missing
   *  attachment. Returns the empty names that are held uploads. */
  private async uploadSlotsHeld(emptyNames: string[]): Promise<Set<string>> {
    const held = new Set<string>();
    if (!emptyNames.length || !this.uploadsPerformed.length || typeof this.page?.evaluate !== "function") return held;
    const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const candidates: Array<{ name: string; fileName: string }> = [];
    for (const name of emptyNames) {
      const nb = norm(name);
      if (!nb) continue;
      const up = [...this.uploadsPerformed].reverse().find((u) => {
        const nl = norm(u.label);
        return !!nl && (nl === nb || (nb.length > 6 && nl.includes(nb)) || (nl.length > 6 && nb.includes(nl)));
      });
      if (up) candidates.push({ name, fileName: up.fileName });
    }
    if (!candidates.length) return held;
    const verdicts = await this.page.evaluate((cands: Array<{ name: string; fileName: string }>) => {
      const n = (t: string): string => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const body = String(document.body?.innerText || "").toLowerCase();
      const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 || r.height > 0;
      });
      const labelOf = (el: Element): string => {
        const id = el.getAttribute("id");
        const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        const parts = [byFor?.textContent, el.getAttribute("aria-label"), el.closest("label")?.textContent];
        let p: Element | null = el.parentElement;
        for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
          const t = (p as HTMLElement).innerText || "";
          if (t.length <= 200) parts.push(t);
        }
        return parts.filter(Boolean).map((t) => n(String(t))).join(" | ");
      };
      const labels = fileInputs.map(labelOf);
      return cands.map((c) => {
        const want = n(c.name);
        const isFileSlot = !!want && labels.some((l) => l.includes(want));
        const listed = !!c.fileName && body.includes(c.fileName.toLowerCase());
        return isFileSlot && listed;
      });
    }, candidates).catch(() => null) as boolean[] | null;
    if (!Array.isArray(verdicts)) return held; // unreadable: not evidence the upload held
    candidates.forEach((c, i) => {
      if (verdicts[i] !== true) return;
      held.add(c.name);
      const note = `"${c.name.slice(0, 48)}": the file box reads empty after the portal took the upload, and the page lists the uploaded file — held (a browser never restores a file input's value)`;
      if (!this.agingNotes.includes(note)) this.agingNotes.push(note);
    });
    return held;
  }

  /** A FIELD WE FILLED THAT HAS SINCE GONE BLANK IS A RE-RENDER, NOT A MISSING VALUE.
   *
   *  Coos Bay's electrical recipe fills "*Other Category of Construction" and reports
   *  success — nothing skipped — and the sweep finds it EMPTY. A conditional control that
   *  appears when its parent is answered is also re-created when anything re-renders it, and
   *  the value goes with it. The recorded step ran twenty steps earlier and cannot know.
   *
   *  Re-run the recorded step for anything blank we have a step for. Bounded to three, once,
   *  so a page that genuinely cannot be filled does not loop. Returns what is STILL blank.
   *  FILLS ONLY — it never clicks, which is what makes it safe on the last page, where a
   *  click would carry a filing somewhere nobody asked for. */
  private async reassertBlanksOnce(pastReview: boolean): Promise<string[]> {
    // ROUNDS, BECAUSE A PORTAL THAT BLANKS ON RE-RENDER CAN BLANK THE REPAIR TOO.
    //
    // Live on Ameren: gap-fill FILLED Email and Phone, and the sweep a moment later still
    // found them empty on the same page — alongside seven notes saying other fields had been
    // filled, gone blank, and been re-asserted. One pass assumes the repair sticks. A second
    // separates "it needed saying twice" from "this block will not hold", and only the second
    // of those is worth an operator's attention.
    //
    // Bounded hard and stops early on no progress, so a page that genuinely cannot be filled
    // costs two passes, not a loop.
    let remaining = await this.reassertPass(pastReview);
    for (let round = 1; round < REASSERT_ROUNDS && remaining.length; round++) {
      const before = remaining.length;
      remaining = await this.reassertPass(pastReview);
      if (remaining.length >= before) {
        // No ground gained. Say so ONCE, in the terms the operator needs: this is not a
        // value we failed to write, it is a page that will not keep it.
        const names = remaining.slice(0, 5).map((b) => b.replace(/ — the portal flagged this field$/, "")).join(", ");
        this.driftWarnings.push(`${remaining.length} required field(s) would not stay filled on this page after two passes (${names}) — the portal clears them on re-render; they need entering by hand before submit`);
        break;
      }
    }
    return remaining;
  }

  /** One pass of the re-assert. See reassertBlanksOnce for why there is more than one. */
  private async reassertPass(pastReview: boolean): Promise<string[]> {
    let blanks = await this.emptyRequiredControls();
    if (blanks.length && !this.inPolicyRetry) {
      const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const refills = this.recipe.steps.filter((rs) => {
        if (rs.action !== "fill" && rs.action !== "select") return false;
        const name = norm(String(rs.note ?? rs.selector?.label ?? ""));
        return !!name && blanks.some((b) => {
          const nb = norm(b.replace(/ — the portal flagged this field$/, ""));
          return nb === name || (nb.length > 6 && name.includes(nb)) || (name.length > 6 && nb.includes(name));
        });
      }).slice(0, REASSERT_MAX_FIELDS);
      if (refills.length) {
        this.inPolicyRetry = true;   // reuses the re-entry guard: no retry of a retry
        try {
          for (const rs of refills) {
            const done = await this.executeStep(rs, pastReview).catch(() => false);
            // BOTH OUTCOMES, or this becomes the sixth silent path in this file. A
            // re-assert that fails says something different from one that was never
            // attempted, and today proved repeatedly that the difference is the whole
            // diagnosis.
            // The two halves belong in different channels. A value re-asserted is a value
            // present — a portal quirk worth reporting, not a defect in the filing. A
            // re-assert that could NOT re-fill leaves the field blank, and blocks.
            if (done) {
              this.agingNotes.push(`"${String(rs.note ?? rs.field ?? "").slice(0, 40)}" was filled earlier and had gone blank — re-asserted (the portal re-rendered it)`);
            } else {
              this.driftWarnings.push(`"${String(rs.note ?? rs.field ?? "").slice(0, 40)}" is blank and its recorded step could not re-fill it here — the control may no longer be on this page`);
            }
          }
        } finally { this.inPolicyRetry = false; }
        blanks = await this.emptyRequiredControls();
      }
    }
    return blanks;
  }

  private async emptyRequiredControls(): Promise<string[]> {
    if (!this.page) return [];
    const found = await this.sweepRequired();
    // Carry WHY a field counted as required into the operator's report: "the portal itself
    // flagged this" and "the label has an asterisk" warrant different amounts of trust.
    return found.empty.map((f) => (f.why === "complaint" || f.why === "unattributed-complaint"
      ? `${f.name} — the portal flagged this field`
      : f.name));
  }

  /** Nothing here to fill: no visible required control is empty. A page like ACA's
   *  "Licensed Professional List" — already populated from the account, just needing a
   *  Continue — is safe to click through; a page with an empty required field is not,
   *  because clicking past it files an incomplete application. */
  private async pageIsPassThrough(): Promise<boolean> {
    if (!this.page) return false;
    // ONE ANSWER TO "IS ANYTHING UNFILLED", NOT TWO. This asked the question with its own
    // narrower copy of the logic: requiredness from `label[for]` asterisks only, and
    // emptiness from `.value`, which reads a select resting on "Please select..." as
    // answered. Both are the misses that let a live PacifiCorp replay report a clean run
    // on a page the portal was refusing — and this caller is the more dangerous of the
    // two, because a wrong "yes" here CLICKS PAST the page, which is how an incomplete
    // application gets filed. The shared sweep is stricter, and strict is the safe
    // direction: the cost of a false "not pass-through" is that replay stops.
    return (await this.sweepRequired()).empty.length === 0;
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
  /** The address-row choice, made from THIS project's address rather than the recorded row.
   *  Shared by the note-routed path (generic results grids, where there is no selector worth
   *  trying) and the post-failure fallback (Accela, whose recorded "Select" link can still
   *  work and is tried first). */
  private async pickAddressRowForProject(step: RecipeStep): Promise<boolean> {
    const num = String(this.fieldValues.streetNumber ?? "").trim();
    const street = String(this.fieldValues.street ?? "").trim();
    if (!num || !street) return false;
    // ACA returns ONE ROW PER JURISDICTION for the same address — city and county both serve
    // it. Which one is right is the discipline: a structural permit files with the CITY, an
    // electrical one with the COUNTY, and the recorded note says which ("select
    // city/structural address row"). Without that tiebreak the match is ambiguous on
    // essentially every search.
    const wantCounty = /county|electrical/i.test(String(step.note ?? "")) && !/city/i.test(String(step.note ?? ""));
    const picked = await this.pickAddressRow(num, street, wantCounty ? "county" : "city");
    // AN EMPTY SEARCH IS A CONCLUSION, NOT A RETRY. Oregon ePermitting participation is
    // VOLUNTARY: a jurisdiction that has not joined never appears in this search at all. So
    // an address the statewide portal cannot find almost always means the AHJ runs its OWN
    // permit portal — and re-learning ePermitting will never fix that. Say so plainly, and
    // deliberately WITHOUT the "recipe step failed" prefix, so the backend does not flag this
    // recipe stale and queue a pointless re-learn of a portal that is working correctly.
    // ...AND ONLY OREGON'S. This message names a specific statewide portal and tells the
    // operator to go find the AHJ's own; generalised to every portal it fired on Miami, whose
    // own portal is the one we are already standing in. Scoped to the Accela/ePermitting
    // shape that earned it.
    const isEPermitting = /work location/i.test(String(step.note ?? ""))
      || /accela|epermitting/i.test(String(this.recipe.portalPlatform ?? ""));
    if (!picked && isEPermitting && !(await this.addressSearchHadResults())) {
      throw new Error(
        `ADDRESS NOT IN OREGON EPERMITTING: the statewide portal returned no results for ${num} ${street}. `
        + `Participation is voluntary, so this almost certainly means ${this.recipe.ahj || "this jurisdiction"} runs its own permit portal. `
        + `Find and record that portal for this AHJ rather than re-recording this recipe.`,
      );
    }
    if (!picked) {
      this.driftWarnings.push(`address row: no result matched ${num} ${street} — refusing to open an application against another property`);
      return false;
    }
    this.driftWarnings.push(`address row chosen by matching "${picked.slice(0, 52)}" (the recorded row label belongs to the project this recipe was learned on)`);
    return true;
  }

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
        // NOT "only rows with a Select link" — that is Accela's shape. Miami's grid binds
        // its handler in script and the row carries no <a> at all, so requiring one found
        // nothing on every portal that is not Accela. Skip headers instead.
        if (tr.closest("thead")) continue;
        if (tr.querySelector("th") && !tr.querySelector("td")) continue;
        // Same trap as markAddressRow: tr.textContent fuses adjacent cells, so a row reading
        // "3500 PAN AMERICAN DR" then "CITY OF MIAMI" becomes "...DRCITY OF MIAMI" and the
        // street type disappears. Join the cells.
        const cellText = Array.from(tr.querySelectorAll("td, th"))
          .map((c) => (c.textContent || "").replace(/\s+/g, " ").trim())
          .filter((t) => t.length > 0).join(" ") || (tr.textContent || "");
        const words: string[] = [];
        for (const raw of cellText.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
          if (!raw) continue;
          words.push(DIRECTIONS[raw] || TYPES[raw] || raw);
        }
        let all = true;
        for (const w of wantWords) if (words.indexOf(w) < 0) { all = false; break; }
        if (all) hits.push({ idx: i, text: cellText.replace(/\s+/g, " ").trim().slice(0, 90) });
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
    // What in the row takes the click, widest-first: Accela's "Select" link, then any link
    // or button in the row, then the row itself for a grid that binds its handler in script.
    const row = this.page.locator('tr[data-replay-addr="1"]');
    // A CLICK THAT LANDS IS NOT A CLICK THAT WORKED. Playwright happily clicks a plain <td>,
    // so the widened candidate list would report success on any grid whose row is inert.
    // Every candidate is judged on whether the page moved, not on whether the click threw.
    // A SNAPSHOT THAT CANNOT THROW. advanceSignatureOf declares helpers inside the
    // evaluate, so on a page without the __name shim it throws, the catch turns it into ""
    // and every candidate then reads as "did not move" — the fixture caught exactly that.
    // One arrow function, no nested declarations, nothing to shim.
    const snap = async (): Promise<string> => await this.page.evaluate(() =>
      `${location.href}|${(document.querySelector("h1, h2, h3")?.textContent || "").trim().slice(0, 60)}`
      + `|${document.querySelectorAll("tr, li, option").length}|${(document.body?.innerText || "").length}`,
    ).catch(() => "") as string;
    const beforeUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
    const beforeSig = await snap();
    for (const cand of [
      row.locator("a:has-text('Select')").first(),
      row.locator("a[href], button, input[type='submit'], input[type='button'], [role='button']").first(),
      row.locator("td").first(),
      row.first(),
    ]) {
      if (!(await cand.count().catch(() => 0))) continue;
      if (!(await this.guardedClick(cand, "select the project's address row", { timeout: 8000 }).then(() => true).catch(() => false))) continue;
      await this.settle(12000);
      await this.page.waitForTimeout?.(900).catch(() => null);
      const afterUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
      const afterSig = await snap();
      if ((afterUrl && afterUrl !== beforeUrl) || (beforeSig && afterSig && afterSig !== beforeSig)) return id;
    }
    return "";
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

  // A SELECTOR LEVEL WHOSE EVERY MATCH IS INVISIBLE HAS NOT FOUND THE CONTROL.
  //
  // The recorded primary is routinely a per-render id, and on a fresh project that id can
  // belong to a HIDDEN twin whose label reads the same. Live on Marineau's NEM replay: the
  // inverter Model step's primary #pcInputBase55 uniquely matched the invisible combobox
  // whose option list is the ENERGY SOURCE values, resolveLocator settled for it because
  // count() > 0, the label fallback that resolves to the real visible Model box was never
  // consulted, the model rules rightly refused "Solar PV/Wind/Hydro" as models, and the
  // cascade never completed — PowerClerk then took the manufacturer back too. A match that
  // cannot be seen does not end the search; only when NO level yields a visible control does
  // the first non-empty level stand, so the familiar failure is preserved.
  private async resolveLocator(sel?: RecipeSelector, hint?: string) {
    const primary = this.locator(sel);
    // A SELECTOR WITH NO FALLBACKS STILL DESERVES THE USABILITY CHECKS.
    //
    // This returned the primary's best match immediately, skipping the visible-AND-enabled
    // test and both recoveries below — so a recipe step recorded WITHOUT fallbacks could
    // resolve an invisible control and act on it with nothing raised. That is exactly what
    // PacifiCorp's and PGE's inverter "Model" step did, on both portals, run after run:
    // `resolved <input id="pcInputBase34" label="Model" visible=false>` while 13 real options
    // were on screen. Having no fallbacks is a reason to try HARDER to rescue the step, not
    // a reason to skip the rescue. Falling through with an empty fallback list costs one
    // extra visibility probe on the happy path and nothing else.
    if (!sel || !primary) return this.preferVisible(primary, sel, hint);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let firstNonEmpty: { loc: any; from?: RecipeSelector } | null = null;
    // A RECORDED ORDINAL IS A GUESS ABOUT PAGE STRUCTURE, AND STRUCTURE MOVES.
    //
    // PGE's inverter Model is `{css:"#pcInputBase34", fallbacks:[{label:"Model", nth:0}]}`.
    // The id is a per-render token that now points at a HIDDEN combobox, and the fallback is
    // pinned to `nth:0` — which preferVisible honours untouched, by design, because an
    // explicit ordinal is an instruction. On this project the first "Model" on the page is
    // that same hidden control, so both levels resolve to something unusable and the select
    // branch's side-picker — which knows perfectly well that `inverterModel` wants the outer
    // pair — never receives a set to choose from.
    //
    // So every ordinal level gets an unpinned twin queued directly after it. The recording is
    // still tried first and still wins when it is right; when it lands on something hidden or
    // disabled, the label alone plus visibility is better evidence than a position captured
    // against a page that has since re-rendered.
    this.resolveTrail = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const levels: Array<{ loc: any; from?: RecipeSelector }> = [{ loc: primary, from: sel }];
    for (const fb of sel.fallbacks ?? []) {
      levels.push({ loc: this.locator({ ...fb, fallbacks: undefined }), from: fb as RecipeSelector });
      if (fb.nth != null) {
        levels.push({ loc: this.locator({ ...fb, nth: undefined, fallbacks: undefined }), from: { ...fb, nth: undefined } as RecipeSelector });
      }
    }
    let levelIdx = -1;
    for (const level of levels) {
      levelIdx++;
      if (!level.loc) continue;
      try {
        if (await level.loc.count() === 0) continue;
      } catch { continue; } // count() can throw on a malformed selector — try the next level.
      if (!firstNonEmpty) firstNonEmpty = level;
      const picked = await this.preferVisible(level.loc, level.from, hint);
      // On a probeable page, take this level only if what it picked is actually VISIBLE;
      // a test fake without isVisible keeps the pre-existing first-non-empty behaviour.
      // VISIBLE IS NOT ENOUGH TO ACCEPT A LEVEL — IT MUST ALSO BE ENABLED.
      //
      // preferVisible already prefers an enabled match, but only when a level matches SEVERAL
      // elements. Oregon ePermitting's dashboard carries exactly one node whose text is
      // "Apply": a disabled decorative pill (`<button disabled class="dropbtn1"
      // onclick="alert('Button was clicked!')">`). One match, so preferVisible collapsed to
      // it; visible, so this accepted it; and the click then waited out its full 30 seconds
      // on a control that can never be clicked. Both Coos Bay recipes died there, at step 1.
      //
      // The real control was one fallback away and enabled — its accessible name is
      // "check_circleApply", the Material-icon ligature glued to the label, which the
      // recorded `role=link name="Apply"` fallback matches by substring. Rejecting the
      // disabled level is all it takes to reach it.
      const canProbe = typeof picked?.isVisible === "function";
      let vis = canProbe ? await this.isTrulyVisible(picked) : null;
      let enab = canProbe && typeof picked.isEnabled === "function"
        ? await picked.isEnabled().catch(() => true) : null;
      // A DISABLED CONTROL MAY BE BUSY RATHER THAN DECORATIVE, and the difference is time.
      //
      // Oregon ePermitting's nav "Apply" is a `disabled` pill that never enables — the case
      // that made resolution reject disabled matches and look elsewhere. But the SAME portal
      // disables its attachment dialog's Save while the upload is in flight, and rejecting
      // THAT one sends the click to the page-level Save instead, which saves a draft and
      // leaves the attachment uncommitted. The recipe then walks into a Continue the portal
      // refuses, three steps later, with nothing on the page to explain it.
      //
      // Waiting separates them with no portal knowledge at all: a busy control enables within
      // a second or two, a decorative one never does. Paid only when the RECORDED selector
      // resolves to something visible-but-disabled, so the happy path never waits.
      if (vis === true && enab === false && level === levels[0] && typeof picked.isEnabled === "function") {
        for (let waited = 0; waited < 4000 && enab === false; waited += 500) {
          await this.page?.waitForTimeout?.(500).catch(() => null);
          enab = await picked.isEnabled().catch(() => false);
        }
        if (enab === true) {
          this.driftWarnings.push(
            `"${this.stepLabel({ selector: sel } as RecipeStep)}" was disabled when reached and enabled itself moments later — the portal was still working, so replay waited rather than resolving elsewhere`,
          );
          vis = await this.isTrulyVisible(picked);
        }
      }
      const usable = canProbe ? (vis === true && enab !== false) : false;
      // NARRATE THE DECISION, NOT JUST THE OUTCOME.
      //
      // Four fixes were shipped at PGE's "Model" step and its failure line never changed —
      // same resolved control, same count — because each one was answering a question about
      // a branch that was never taken. Four live runs went into learning that, and none of
      // them could have told us: the report said WHICH control was chosen and never WHY, or
      // which levels were considered and rejected first.
      //
      // One line per level turns "why did the fallback not fire" from a live-run guess into
      // a sentence on the scorecard. Kept only for steps that end up failing (the trail is
      // discarded on success), so a healthy run pays nothing for it.
      this.resolveTrail.push(
        `level ${levelIdx} ${this.describeSelector(level.from)} -> count ${await level.loc.count?.().catch(() => -1) ?? -1}`
        + `, visible=${vis === null ? "n/a" : vis}, enabled=${enab === null ? "n/a" : enab}`
        + `, ${(!canProbe || usable) ? "ACCEPTED" : "rejected"}`,
      );
      if (!canProbe || usable) {
        // Worth a warning only when an EARLIER matching level was passed over as hidden.
        if (level !== firstNonEmpty) {
          this.driftWarnings.push(`"${this.stepLabel({ selector: sel } as RecipeStep)}" — recorded selector matched only hidden or disabled control(s); resolved via a fallback to a usable one`);
        }
        return picked;
      }
    }
    // NOTHING USABLE AT ANY LEVEL — TRY THE CONTROL'S NAME, WITH ICON NOISE REMOVED.
    //
    // Icon fonts inject their ligature text into an element's accessible name: Oregon
    // ePermitting's Apply link reads "check_circleApply", Search reads "searchSearch",
    // Schedule reads "eventSchedule". A recorded name of "Apply" matches none of them by
    // role+name, so every fallback missed and replay was left holding a disabled decorative
    // pill that happened to carry the same word. Material Icons are used across government
    // portals, so this is a fleet-wide shape rather than one portal's quirk.
    const want = String(sel.name || sel.text || "").trim();
    if (want) {
      const rescued = await this.findEnabledControlByName(want)
        // Nothing enabled and visible carries this name — it may be behind a closed menu.
        ?? await this.revealMenuAndPick(want, `${this.recipe.discipline ?? ""} ${this.recipe.ahj ?? ""} building electrical permit`);
      if (rescued) {
        this.agingNotes.push(
          `"${want.slice(0, 40)}" matched no usable control by selector — found an enabled one by name instead (icon-font ligatures pollute accessible names)`,
        );
        return rescued;
      }
    }
    // Nothing visible at any level: the first level that matched at all keeps the familiar
    // failure shape (identity check / skip reporting sees the same control it always did).
    return firstNonEmpty ? this.preferVisible(firstNonEmpty.loc, firstNonEmpty.from, hint) : primary;
  }

  /**
   * What a step's selector actually landed on, for the trace. Reports the element's id, its
   * own label, and (for a select) how many options it is offering — enough to tell "the
   * control is missing" from "the control is there but it is the wrong one" from "the
   * control is right but its option list has not loaded".
   */
  /**
   * Describe the control a step ACTED ON — not a fresh re-resolution of its selector.
   *
   * This used to re-run resolveLocator and report whatever that returned, which is a
   * different element as soon as any rescue fires: the section match, the closed-menu
   * reveal and the name recovery all happen in executeStep, downstream of resolution. So a
   * step could be driven against the right control while its failure line named the stale
   * one, and PGE's "Model" reported `<input id="pcInputBase34" visible=false>` on runs where
   * it had in fact resolved by section to something else entirely.
   *
   * Four fixes were aimed at that phantom. A diagnostic that describes a different element
   * than the one acted on is worse than none, because it is believed.
   */
  private async describeResolved(step: RecipeStep, actual?: unknown): Promise<string> {
    try {
      const loc = (actual as { count?: unknown } | undefined)?.count
        ? actual as never
        : await this.resolveLocator(step.selector);
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
      // A STEP THIS RUN WILL NEVER EXECUTE IS NOT A MISSING FIELD.
      //
      // The same denominator error as counting blanks with nothing to divide by. This project
      // has no battery, so the recipe's storage steps are skipped by design — and where the
      // portal only renders those controls once storage is declared, their labels are
      // genuinely not on the page. Counting them as "recorded fields not found" made a
      // correct filing read as 4/14 and emitted "the portal may have changed; verify", which
      // was the last blocking warning standing on PGE.
      if (this.skipForNoBattery(st)) continue;
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
      // A PAYMENT SEGMENT IS NOT A DRIFTED PAGE. This precheck runs at the START of a
      // segment, before the loop reaches any of its steps — so on Coos Bay electrical it
      // fired on the section whose recorded fields are "CVV:", a month list and a year list,
      // and reported "0 of 5 recorded fields ... the replay is not on the page the recipe
      // expects". The replay was exactly where it should be: at the fee page, in front of a
      // card form it must never fill. The payment boundary was one step away and never got
      // its turn, so the run scored steps_failed against the recipe instead of stopping
      // where the first safety rule says to stop.
      if (expected.filter((e) => PAYMENT_FIELD.test(e)).length >= Math.max(1, Math.ceil(expected.length / 3))) {
        return null;
      }

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
      // A SETTLED PAGE HAS ANSWERED THE QUESTION. The full budget exists for slow paints and
      // interstitials that redirect late — but a page that has rendered REAL FIELDS and then
      // held them identical across three consecutive scans is done painting, and burning the
      // rest of a 15s budget on it just delays the same drift verdict (the comment below says
      // it: the full burn "stops the run, which it was going to do anyway"). Stability only
      // counts when fields exist: a field-LESS page stays on the full budget, because an
      // interstitial can sit empty for ten seconds and then become the recorded page.
      let stableScans = 0;
      let prevSignature = "";
      for (;;) {
        // A NAVIGATION IN FLIGHT IS NOT A VERDICT. The advance that opened this segment may
        // still be navigating when the scan runs ("Execution context was destroyed"); the old
        // catch below turned that into "no drift", the drift-seek never ran, and the next step
        // timed out on the extra page it should have clicked through (accela/extra_readonly_page
        // failed 1 run in 2). Settle and scan again within the budget; only a page that cannot
        // be read at all by the deadline falls through to the old answer.
        let raws: Array<{ label?: string }>;
        try {
          raws = (await this.page.$$eval(EXTRACT_SEL, extractFieldsInPage)) as Array<{ label?: string }>;
        } catch (scanErr) {
          // Only a NAVIGATION error is worth a rescan. Any other failure (a page that cannot run
          // the extractor at all) is not going to change by waiting, and must not burn the whole
          // drift budget on every segment (it cost the replay smokes ~10 s each).
          const navigating = /context was destroyed|because of a navigation|frame was detached|navigating/i.test(String((scanErr as Error)?.message ?? scanErr));
          if (!navigating || Date.now() >= deadline) throw scanErr;
          await this.settle(3000);
          await sleep(300);
          continue;
        }
        const live = raws.map((r) => (r.label || "").trim().toLowerCase()).filter(Boolean);
        const matches = (want: string): boolean => {
          const w = want.toLowerCase();
          return live.some((l) => l === w || (Math.min(l.length, w.length) >= 5 && (l.includes(w) || w.includes(l))));
        };
        hit = expected.filter(matches).length;
        overlap = hit / expected.length;
        if (overlap >= 0.34) return null;
        const signature = JSON.stringify(live);
        stableScans = live.length > 0 && signature === prevSignature ? stableScans + 1 : 0;
        prevSignature = signature;
        if (stableScans >= 2) break;
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
    // KEEP THE PAGE, NOT JUST A DESCRIPTION OF IT.
    //
    // A failing step already saves a screenshot and a list of visible control labels, and
    // that was enough to see THAT Oregon ePermitting's "Apply" was unreachable but never
    // enough to see WHY: five live runs went into narrowing it — a disabled namesake, an
    // icon ligature in the accessible name, and a control that is none of anchor, button or
    // ARIA role. Every one of those questions is answerable from the markup in seconds and
    // from a screenshot never. The HTML costs nothing to keep and turns the next portal
    // puzzle from a sequence of live runs into a file someone reads once.
    try {
      const dir = this.pageShotDir || path.join(replayCaptureRoot(), "replay-failures");
      const safe = String(step.note ?? step.action).replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
      // The step's own control, as its recorded selector names it (every frame is kept too,
      // so a control inside an iframe is in the capture whichever way this resolves).
      let target: unknown = null;
      try { target = step.selector ? this.locator(step.selector) : null; } catch { target = null; }
      const body = String(await this.page.locator?.("body").innerText().catch(() => "") ?? "");
      await this.writeSanitizedCapture(dir, `step${String(stepIdx).padStart(3, "0")}-${safe}`, { target, text: body });
    } catch { /* diagnostics must never change the outcome */ }
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
        const dir = process.env.REPLAY_CAPTURE_DIR ? path.join(process.env.REPLAY_CAPTURE_DIR, "screenshots")
          : process.env.PORTAL_SCREENSHOT_DIR || path.join(process.cwd(), "data", "screenshots");
        await fs.promises.mkdir(dir, { recursive: true });
        const file = path.join(dir, `replay-fail-step${String(stepIdx).padStart(3, "0")}-${Date.now()}.png`);
        await this.page.screenshot({ path: file, fullPage: true });
        parts.push(`screenshot:${file}`);
      }
    } catch { /* best-effort */ }
    void step;
    return parts.length ? ` [${parts.join(" | ")}]` : "";
  }

  /**
   * A SANITIZED, ALL-FRAMES CAPTURE — the learn sanitizer's rules, for replay's diagnostic files.
   *
   * Replay wrote raw page.content() (typed values, prefilled account numbers) and a body slice
   * with no redaction: 22 review-miss .txt files held runs of 9+ digits. And it saved only the
   * TOP frame, so half the real-portal failure captures (PowerClerk's County, inside a frame)
   * could not show the control that failed. This keeps every frame, with values, `checked` and
   * `selected` stripped and scripts removed exactly as learnDebug.capturePageHtml does, the body
   * text redacted (digit runs, emails), and the TARGET control's own markup + option list.
   * Directories: REPLAY_RUN_DIR (the run's page folder) / REPLAY_CAPTURE_DIR, data/ only when
   * neither is set; each capture folder is pruned to its newest CAPTURE_KEEP files.
   * Best-effort and never throws. Returns the path written ("" when nothing was).
   */
  private async writeSanitizedCapture(dir: string, base: string, opts: { target?: unknown; text?: string } = {}): Promise<string> {
    try {
      if (!this.page) return "";
      const frames: Array<{ url?: () => string; name?: () => string; evaluate?: (fn: unknown) => Promise<unknown> }> =
        typeof this.page.frames === "function" ? this.page.frames() : [this.page];
      const captured: Array<{ url: string; name: string; html: string }> = [];
      for (const fr of frames.slice(0, 12)) {
        if (typeof fr?.evaluate !== "function") continue;
        const html = await fr.evaluate(() => {
          const doc = document.documentElement.cloneNode(true) as HTMLElement;
          for (const el of Array.from(doc.querySelectorAll("script, noscript"))) el.remove();
          for (const el of Array.from(doc.querySelectorAll("input, textarea"))) {
            el.removeAttribute("value");
            el.removeAttribute("checked");
            (el as HTMLInputElement).value = "";
            if (el.tagName === "TEXTAREA") el.textContent = "";
          }
          for (const el of Array.from(doc.querySelectorAll("option"))) el.removeAttribute("selected");
          return `<!doctype html><html>${doc.innerHTML}</html>`;
        }).catch(() => "") as string;
        if (html) captured.push({ url: String(fr.url?.() ?? "").slice(0, 200), name: String(fr.name?.() ?? ""), html: redactCaptureText(html, 2_000_000) });
      }
      type TargetCapture = { outerHTML: string; options: string[]; secret: boolean };
      let target: TargetCapture | null = null;
      const t = opts.target as { first?: () => unknown; count?: () => Promise<number>; evaluate?: (fn: unknown, arg: unknown, o?: { timeout?: number }) => Promise<unknown> } | null | undefined;
      const one = t && typeof t.first === "function" ? (t.first() as typeof t) : t;
      // A FAILURE CAPTURE NEVER WAITS FOR THE CONTROL THAT FAILED TO APPEAR. A locator's
      // evaluate() waits the default 30 s for its element — and the commonest reason we are
      // capturing at all is that the element is NOT there. Measured: a missing upload slot on a
      // review page cost 30 s for the step and another 30 s for this capture. Count first (no
      // wait), and bound the read for an element that detaches between the count and the read.
      const present = one && typeof one.count === "function" ? await one.count().catch(() => 0) : 1;
      if (one && typeof one.evaluate === "function" && present > 0) {
        await this.page.evaluate?.(PORTAL_SAFETY_IN_PAGE_SOURCE).catch(() => null);
        target = await one.evaluate((el: Element, g: string) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ps = (globalThis as any)[g];
          const secret = !!ps && ps.isSecretField(ps.fieldIdentityInPage(el));
          const c = el.cloneNode(true) as HTMLElement;
          c.removeAttribute("value");
          for (const o of Array.from(c.querySelectorAll("option"))) o.removeAttribute("selected");
          const opts = el.tagName === "SELECT" && !secret
            ? Array.from((el as HTMLSelectElement).options).map((o) => o.text.replace(/\s+/g, " ").trim()).slice(0, 200)
            : [];
          return { outerHTML: secret ? `<${el.tagName.toLowerCase()} [secret control — markup withheld]>` : c.outerHTML.slice(0, 20_000), options: opts, secret };
        }, PORTAL_SAFETY_GLOBAL, { timeout: 2000 }).catch(() => null) as TargetCapture | null;
      }
      // Nothing readable (a unit-test fake, a closed page): write nothing rather than an empty shell.
      if (!captured.length && !target) return "";
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${base}.json`);
      fs.writeFileSync(file, JSON.stringify({
        url: String(this.page.url?.() ?? "").slice(0, 200),
        capturedAt: new Date().toISOString(),
        sanitized: "values/checked/selected stripped, scripts removed, digit runs and emails masked",
        text: redactCaptureText(opts.text ?? ""),
        target: target ? { ...target, outerHTML: redactCaptureText(target.outerHTML, 20_000), options: target.options.map((o) => redactCaptureText(o, 200)) } : null,
        frames: captured,
      }, null, 1));
      // The main frame alone as .html, so a person can open it in a browser.
      if (captured[0]) fs.writeFileSync(path.join(dir, `${base}.html`), captured[0].html);
      pruneCaptureDir(dir);
      return file;
    } catch {
      return "";
    }
  }

  private async healSelectorForStep(step: RecipeStep): Promise<RecipeSelector | { ambiguous: string } | null> {
    // WHY THIS REPORTS. Every exit below used to be a bare `return null`, so a heal that
    // never ran (page gone, $$eval threw) looked exactly like a heal that ran and found
    // nothing. A live PGE replay failed at step 1 on a control the failure diagnostic
    // listed as VISIBLE, with healedSteps: 0 and no way to tell which had happened.
    this.healDiagnostic = "";
    if (!this.page || typeof this.page.$$eval !== "function") {
      this.healDiagnostic = "no page to re-extract from";
      return null;
    }
    const target = healTargetOf(step, step.action === "select" ? this.resolveValue(step) : "");
    if (target.label.length < 3) {
      this.healDiagnostic = `nothing to anchor on (note/label is ${JSON.stringify(target.label)})`;
      return null;
    }
    const compat = (t: string): boolean =>
      step.action === "select" ? t === "select"
      : step.action === "check" || step.action === "uncheck" ? t === "checkbox" || t === "radio"
      : step.action === "click" ? t === "button"
      : t === "text" || t === "other" || t === "select";
    // BELOW THE MINIMUM, LOOK ONCE MORE — the page may still be rendering the control. One
    // settle and one re-localization, then a clear failure. Never a loop.
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) await this.settle(4000);
      let raws: unknown[] = [];
      try { raws = await this.page.$$eval(EXTRACT_SEL, extractFieldsInPage); }
      catch (err) {
        // Do NOT swallow this. A function declared inside the extraction script compiles to
        // __name(fn, "…"), which does not exist in the browser; that throw is what made an
        // earlier scan read as "found nothing" for three separate investigations.
        this.healDiagnostic = `re-extraction threw: ${err instanceof Error ? err.message : String(err)}`;
        return null;
      }
      const fields = (raws as Parameters<typeof toExtractedField>[0][]).map((r) => toExtractedField(r)).filter((f) => compat(f.fieldType));
      const ranked = rankHealCandidates(fields, target);
      const verdict = decideHeal(ranked);
      if (verdict.kind === "none") {
        const seen = fields.map((f) => (f.label || "").trim().toLowerCase()).filter(Boolean).slice(0, 10);
        this.healDiagnostic = ranked.length
          ? `best candidate ${JSON.stringify(ranked[0].label.slice(0, 40))} scored ${ranked[0].score} < minimum ${HEAL_MIN_SCORE}${pass ? " (after one settle + re-localize)" : ""}`
          : seen.length
            ? `no ${step.action}-compatible control matched ${JSON.stringify(target.label.slice(0, 50))}; page offers: ${seen.map((s) => JSON.stringify(s.slice(0, 40))).join(", ")}`
            : `re-extraction returned no ${step.action}-compatible controls at all (${raws.length} element(s) scanned)`;
        continue;
      }
      if (verdict.kind === "ambiguous") {
        // A TIE IS NOT A CHOICE. Two bare "Manufacturer" boxes with nothing to tell them apart
        // used to heal onto whichever came first — the inverter make written into the module's
        // box, and the RECIPE PATCHED with that selector. Refuse, named.
        this.healDiagnostic = verdict.reason;
        return { ambiguous: verdict.reason };
      }
      if (JSON.stringify(verdict.field.selector) === JSON.stringify(step.selector)) {
        // The page still offers exactly the control we recorded, so the selector is not the
        // problem — something is stopping the action from LANDING (an overlay, a disabled
        // state). Saying so points at a completely different fix than "selector drifted".
        this.healDiagnostic = "the live page offers the SAME selector that just failed — the control is there but the click is not landing (overlay/disabled?), not a drifted selector";
        return null;
      }
      this.healDiagnostic = `healed onto ${JSON.stringify(verdict.field.label.slice(0, 40))} (score ${verdict.score}, next ${verdict.runnerUp ?? "none"})`;
      return verdict.field.selector;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// SELF-HEAL BY WEIGHTED MULTI-ATTRIBUTE FINGERPRINT
//
// One attribute is one guess; several agreeing attributes are evidence (the Similo result: a
// weighted multi-attribute match roughly halves locator failures against any single locator).
// The target is what the step RECORDED — label, name, id, placeholder, aria-label, section,
// neighbouring text — plus what can be DERIVED at replay when the learn did not capture it: the
// side of the form the step's binding belongs to (inverterMake → an inverter section), the value
// a select must be able to take (the option-list signature), and the recorded ordinal.
//
// Rules: the label is the anchor (no label, no heal — attributes alone never invent a target);
// a heal must clear a minimum score; and two candidates within the tie margin are a refusal with
// a named ambiguity, never "the first one".
// ---------------------------------------------------------------------------------------------

export const HEAL_MIN_SCORE = 40;
export const HEAL_TIE_MARGIN = 6;

export interface HealTarget {
  label: string;
  name?: string;
  id?: string;
  placeholder?: string;
  ariaLabel?: string;
  section?: string;
  nearText?: string;
  /** The form side the step's binding names (inverter / module / battery / owner / installer / electrical). */
  side?: string;
  /** For a select: the value it must be able to take. */
  value?: string;
  /** The recorded ordinal among same-labelled controls. */
  ordinal?: number;
}

const SIDES: Array<{ side: string; field: RegExp; section: RegExp }> = [
  { side: "inverter", field: /^(inverter|existingInverter)/i, section: /\binverter/i },
  { side: "module", field: /^(module|pvModule|array\d*Module|existingModule|totalModule)/i, section: /\b(module|pv\s*array|array|panel)/i },
  { side: "battery", field: /^(battery|ess|storage)/i, section: /\b(batter|storage|ess)\b/i },
  { side: "owner", field: /^(homeowner|owner|ubAccountHolder|customer)/i, section: /\b(owner|customer|homeowner|property|account\s*holder)/i },
  { side: "installer", field: /^(installer|contractor|applicant|ccb)/i, section: /\b(installer|contractor|applicant|company|licensed)/i },
  { side: "electrical", field: /^(electrical|electrician)/i, section: /\belectric/i },
];

/** Does this section heading belong to the side a binding names? 1 = only that side's words;
 *  0.5 = that side's AND another's ("Electrical Contractor" reads as installer — "contractor" —
 *  and electrical); -1 = only another side's; 0 = no side at all. Graded, so the section that is
 *  ONLY the installer's beats one that is also the electrician's, and the electrician's own
 *  section still counts for the electrician. */
export function sideVerdict(side: string, section: string): 1 | 0.5 | 0 | -1 {
  const s = String(section ?? "");
  if (!s.trim()) return 0;
  const own = SIDES.find((x) => x.side === side);
  if (!own) return 0;
  const mine = own.section.test(s);
  const other = SIDES.some((x) => x.side !== side && x.section.test(s));
  return mine && !other ? 1 : mine && other ? 0.5 : other ? -1 : 0;
}

/** The heal target for a recorded step: recorded attributes first, derived ones otherwise. */
export function healTargetOf(step: RecipeStep, value = ""): HealTarget {
  const fp = step.fingerprint ?? {};
  const sel = step.selector ?? {};
  const allSel = [sel, ...(sel.fallbacks ?? [])];
  const cssId = allSel.map((s) => /^#([A-Za-z_][\w:.-]*)$/.exec(String(s.css ?? ""))?.[1]).find(Boolean);
  const side = SIDES.find((s) => s.field.test(String(step.field ?? "")))?.side;
  return {
    label: String(step.note || sel.label || sel.name || "").trim().toLowerCase(),
    name: fp.name || (sel.role ? undefined : sel.name) || undefined,
    id: fp.id || cssId || undefined,
    placeholder: fp.placeholder || sel.placeholder || undefined,
    ariaLabel: fp.ariaLabel || undefined,
    section: fp.section || undefined,
    nearText: fp.nearText || undefined,
    side,
    value: value || undefined,
    ordinal: typeof sel.nth === "number" ? sel.nth : undefined,
  };
}

const lc = (s?: string): string => String(s ?? "").trim().toLowerCase();
const compactHeal = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Score one live candidate against the target. Pure; exported for tests. Returns -1 when the
 *  label anchor does not hold (the candidate is not considered at all). */
export function scoreHealCandidate(f: ExtractedField, t: HealTarget, ordinalAmongSameLabel = 0): number {
  const label = lc(f.label);
  if (!label || !t.label) return -1;
  const contains = label.includes(t.label) || t.label.includes(label);
  const labelScore = label === t.label ? 40 : contains && Math.min(label.length, t.label.length) >= 5 ? 28 : 0;
  if (!labelScore) return -1;
  const fp = f.fingerprint ?? {};
  const eq = (a?: string, b?: string): boolean => !!a && !!b && lc(a) === lc(b);
  let score = labelScore;
  if (eq(fp.name, t.name)) score += 12;
  if (eq(fp.id, t.id)) score += 8;
  if (eq(fp.placeholder, t.placeholder)) score += 8;
  if (eq(fp.ariaLabel, t.ariaLabel)) score += 8;
  const section = lc(f.section || fp.section);
  const rs = lc(t.section);
  if (section && rs && Math.min(section.length, rs.length) >= 4 && (section.includes(rs) || rs.includes(section))) score += 14;
  if (t.side && section) {
    score += 12 * sideVerdict(t.side, section);
  }
  if (t.nearText && lc(fp.nearText) && (lc(fp.nearText).includes(lc(t.nearText)) || lc(t.nearText).includes(lc(fp.nearText)))) score += 6;
  if (t.value && f.options?.length) {
    const v = compactHeal(t.value);
    score += f.options.some((o) => { const c = compactHeal(o); return !!c && (c === v || c.includes(v) || (c.length >= 4 && v.includes(c))); }) ? 10 : -10;
  }
  if (typeof t.ordinal === "number" && t.ordinal === ordinalAmongSameLabel) score += 4;
  return score;
}

export interface RankedHeal { field: ExtractedField; label: string; score: number }

/** Every candidate whose label anchor holds, best first. */
export function rankHealCandidates(fields: ExtractedField[], t: HealTarget): RankedHeal[] {
  const seenPerLabel = new Map<string, number>();
  const out: RankedHeal[] = [];
  for (const f of fields) {
    const key = lc(f.label);
    const ord = seenPerLabel.get(key) ?? 0;
    seenPerLabel.set(key, ord + 1);
    const score = scoreHealCandidate(f, t, ord);
    if (score >= 0) out.push({ field: f, label: f.label || "", score });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Heal, refuse a tie, or find nothing — never "the first of equals". */
export function decideHeal(ranked: RankedHeal[]):
  | { kind: "heal"; field: ExtractedField; score: number; runnerUp?: number }
  | { kind: "ambiguous"; reason: string }
  | { kind: "none" } {
  const top = ranked[0];
  if (!top || top.score < HEAL_MIN_SCORE) return { kind: "none" };
  const next = ranked[1];
  if (next && top.score - next.score < HEAL_TIE_MARGIN) {
    const where = (r: RankedHeal) => `${JSON.stringify(r.label.slice(0, 30))}${r.field.section ? ` in ${JSON.stringify(String(r.field.section).slice(0, 30))}` : ""} (${r.score})`;
    return { kind: "ambiguous", reason: `self-heal refused — ambiguous: ${where(top)} and ${where(next)} score within ${HEAL_TIE_MARGIN}; nothing recorded or derivable tells them apart` };
  }
  return { kind: "heal", field: top.field, score: top.score, runnerUp: next?.score };
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
