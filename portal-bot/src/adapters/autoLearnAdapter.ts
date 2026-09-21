import fs from "fs";
import { rankAddressVersions } from "../addressVersion";
import { imageToPdfBytes, pdfNameFor, shouldConvertToPdf } from "../imageToPdf";
import path from "path";
import type { Page, Frame } from "playwright";
import type { ProjectRecord, RecipeSelector, RecipeStep, StepFingerprint } from "../../../shared/src/types";
import { BasePortalAdapter, HUMAN_REVIEW_MESSAGE, type PortalContext, type PortalStepResult } from "../adapter";
import { openPortal } from "../browser";
import { selectWithFallback, readClosedComboboxOptions } from "../comboboxFill";
import { detectChallengeFrame, frameSelectorFor, readbackMatches, redactStatusText, safeAction, sleep, smartWait, waitForElement, waitForInteractiveControls } from "../safeAction";
import { scrapeReviewScreen as scrapeReviewScreenShared } from "../reviewScreenScraper";
import { performLogin, lastRevealTrail } from "./loginFlow";
import { enterApplicationFlow, isExcludedEntryLabel, normalizeEntryLabel, chooseApplicationType } from "./applicationEntry";
import { chooseProgram, offeredLabels, programSelector, scanProgramGroups, type ProgramGroup } from "./applicationProgram";
import { planHiddenReveal, planLabelProxy } from "./revealHidden";
import { looksLikeConsentWall, planConsentDismissal } from "./consentBanner";
import { chooseRow, scanRowChoices, markAddressRow, type AddressRowPick } from "./rowChooser";
import { parseStreetName, parseStreetNumber, parseStreetLine, correctTruncatedAddressFill, isSplitAddressForm } from "../addressParse";
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
  /** True when the control cannot be operated right now — :disabled (which also covers a
   *  control inside <fieldset disabled>), aria-disabled="true", or a `disabled` class token.
   *  Carried because A DISABLED NEXT IS A GATE, NOT AN ABSENCE: a wizard step whose Next
   *  unlocks on validation was read as a terminal page precisely because nothing recorded
   *  that the Next existed. See classifyTerminalSubmitPage. */
  disabled?: boolean;
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
  /** ONE LINE PER PAGE THE WALK SAW: title, url, how many fields were fillable, what the
   *  planner chose, how many fills landed, whether it looked like review. Printed to stdout
   *  for years and stored nowhere — so diagnosing "recorded steps but never reached review"
   *  across a 59-portal run meant scrolling a console log, and a benchmark that has finished
   *  cannot be asked the question at all. Twelve portals ended in that state on 2026-09-08
   *  and not one of them can be explained from its scorecard row. */
  pageTrace?: string[];
  /** Labels of REQUIRED, non-sensitive fields left blank/unselected (dropped fills + untouched
   *  required fields). Surfaced structurally (not just in `message`) so the backend trust gate
   *  can refuse to promote a recipe with a known blank required field. Empty = clean. */
  requiredFieldMisses?: string[];
  /** Labels of REQUIRED document-upload slots with no matching project file (left empty). */
  missingRequiredDocs?: string[];
  /** Inline validation errors the portal raised when an advance was blocked. */
  validationBlocks?: string[];
  /** Page-level messages the PORTAL printed during the walk, on any page, whether or not
   *  it advanced ("Property Address not found."). Distinct from validationBlocks, which
   *  only ever means "an advance was refused". */
  portalNotices?: string[];
  /** The FULL url (query string included) of the application this run worked on, captured
   *  where it stopped. Without it there is no way to audit the right application afterwards:
   *  a portal list can hold several drafts for the same customer, and auditing "the first" or
   *  "the newest" matching row picked the wrong one both times it was tried. */
  applicationUrl?: string;
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
//
// WIDENED, because the terminal-page classifier below now RECORDS a control as the end of an
// application, and this list is the first thing standing between that rule and a payment. The
// holes were reproduced live on synthetic markup and are the same three the replay-side twin
// closed in 6e614bc:
//   "Pay and Submit Application"  — "submit and pay" was listed; the REVERSE order was not.
//   "Submit Payment"              — no bare \bpayment\b, and \bpay\b cannot match "Payment"
//                                   (there is no word boundary before the m).
//   "Pay Fees Due" / "Total Fees" — the bare `fee` had no plural.
// Now at parity with PAY_FEE_REPLAY_GATE in recipeAdapter.ts, which guards a click that really
// happens; this copy classifies controls the learn will never click, so the two stay separate
// (see that file's comment) but must never again be separately WRONG.
// PURCHASE-COMMIT wording added alongside MONEY_ANYWHERE (see its comment): a control that
// COMMITS an order is a control that moves money. Narrow on purpose — `order` only counts when
// a commit verb governs it, so "Sort Order", "Work Order" and "Order Status" still click. This
// list BLOCKS CLICKS, so over-refusal here stalls a real page rather than costing one
// classification, which is why it is not the blunt `\border\b` used in MONEY_ANYWHERE.
//
// BARE `pay` — the phrase list lost this race exactly as the comment above predicted it would.
// Every alternative here governed an object ("pay fees", "pay now", "pay $", "pay and submit"),
// so the plainest pay control of all went straight through BOTH copies: isPayFee("Pay"),
// ("Pay Later"), ("Pay by Credit Card"), ("Review and Pay"), ("Confirm and Pay") were all false.
// That is not a classification miss, it is a CLICK: "Continue and Pay" is ADVANCE_ONLY-anchored
// on "Continue" and matches no SUBMIT_INTENT, so clickFallbackAdvance's only remaining guard was
// isOffLimitsButton — which said false — and the learn walk would have pressed a pay control on
// a live portal, against CLAUDE.md rule 1. `\bpay\b` cannot match "Payee"/"Payroll"/"Prepay"
// (no boundary after "pay"), so the MUST_ALLOW list is untouched.
const PAY_FEE = /\b(pay\s*(and|&)\s*submit|pay fees?|pay fee|pay now|submit\s*(&|and)\s*pay|make payment|payments?|remit|invoices?|continue to payment|pay \$|add to cart|proceed to (payment|checkout)|checkout|fees? due|fees?|purchases?|buy now|(place|submit|confirm|complete|finali[sz]e)\s+(the\s+|my\s+|your\s+)?order|pay)\b/i;

// Submit-intent button labels. On a READ-ONLY review page these SUBMIT (Accela's
// "Continue Application" on Step 3: Review is the submit gate — it advances on input
// pages but submits on the review page). The structural guard below treats them as the
// final submit (recorded, never clicked) whenever the page has no fillable inputs.
/** How many times the walk may see the SAME page signature before it stops and says so.
 *  Three allows a legitimate re-render plus one retry; Miami's Property Search was walked
 *  SEVEN times, which bought nothing and spent the whole budget. */
const REPEAT_PAGE_LIMIT = 3;

const SUBMIT_INTENT = /\b(continue application|submit application|file application|submit|finish|finalize|confirm submission|place order|complete submission)\b/i;

// PAGING A TABLE IS NOT ADVANCING AN APPLICATION.
//
// ComEd's banked recipe (interconnect.comed.com, a NEM portal) carries this as step 10:
//   {"action":"click","selector":{"role":"button","name":"Next page"},"note":"advance: Next page"}
// "Next page" is Angular Material's mat-paginator aria-label on the DASHBOARD BEHIND the open
// application drawer. It passed the advance test because that regex matches /^next\b/, and the
// did-it-move rollback never fired because the page fingerprint includes
// document.body.innerText.length - and paging a table changes it. So the walk "advanced" over and
// over on one screen, and the recipe now teaches replay to click a paginator.
//
// Matched by SHAPE, never by hostname: the words a pager uses ("Next page", "Next 10",
// "Previous page"), which no wizard's forward control is ever called. A bare "Next", "Next Step"
// or "Continue" is untouched - those are the real advances and must keep working.
export const PAGINATION_CONTROL = /^\s*(next|prev|previous)\s+(page|\d+)\s*$/i;

// Controls that act on an EXISTING portal record (the operator's real filings) — never
// part of learning a NEW application. "Resume Application" reopens a draft record;
// "Pay Fees Due" is a payment path. Off-limits for click/advance/nav alike.
//
// These two phrases were the WHOLE denylist, and they are literal: "Resume" alone, "Renew",
// "Withdraw", "Amend" and "Search Applications" all passed straight through to a click. A
// live Accela run drifted into the records module on a planner "Search" click — landing on
// a page of the operator's real filings — so this is a demonstrated path, not a theoretical
// one. Widened to the record actions that are NEVER part of starting a new application.
//
// Deliberately NOT here: a bare "Search". The address/parcel lookup on a permit wizard is a
// legitimate, required click ("Search" next to the address fields), so only the record-noun
// forms ("Search Applications"/"Search Records"/"Search Permits") are refused.
const EXISTING_RECORD_ACTION = /\bresume\b|\bpay fees? due\b|\brenew\b|\bwithdraw\b|\bamend\b|\bmy (records|permits|applications)\b|\bsearch (applications|records|permits)\b/i;

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

// An Accela RECORD TYPE — the checkbox that decides which permit is being applied for
// ("Residential - Electrical", "Commercial - Mechanical"). Which one is right is the
// discipline on the request, so the planner never gets to choose it; see the guard in
// applyFill and accelaRecordTypePass, which picks it deterministically.
const RECORD_TYPE_LABEL = /^\s*(residential|commercial)\s*[-–—]\s*\S/i;

// PGE/PowerClerk Yes/No POLICY questions whose answer is fixed for standard residential NEM.
// Mirrors the knowledge-base seed. A deterministic pass applies the policy answer so the portal
// default — or a wrong planner pick — can't stand.
//   • enforce=false (default): only acts when the group is UNANSWERED. Used where project DATA
//     could legitimately differ (export limit is "No" unless the project chooses to limit it).
//   • enforce=true: selects the policy answer even if another option is already checked, so a
//     planner that picked the wrong option is corrected. Used for answers fixed by equipment
//     listing (UL 1741-SB lab certification is "Yes" for standard listed residential inverters).
// What an "Other — please specify" box gets. This product files solar permits; the work is
// always solar, so the specify box is always the same answer.
const OTHER_SPECIFY_VALUE = "Solar";

const POLICY_RADIO_DEFAULTS: Array<{ question: RegExp; answer: "Yes" | "No"; enforce?: boolean }> = [
  { question: /do you propose to limit the export capacity/i, answer: "No" },
  // HYPHENS COUNT. Ameren Illinois asks "Is the inverter lab-certified as that term is
  // defined in the Illinois Distributed Generation Interconnection Standard?" — hyphenated,
  // which a whitespace-only pattern misses, leaving a REQUIRED question blank on every
  // Illinois run. Separators are now flexible everywhere in this rule.
  { question: /are all inverters lab[-\s]*certified|inverters?\s+lab[-\s]*certified|\blab[-\s]*certified\b|UL\s*1741/i, answer: "Yes", enforce: true },
  // Standard residential detail places the lockable AC disconnect adjacent to the meter;
  // the prompt default alone was observed missed (required radio left blank → portal
  // blocked the submit), so the deterministic pass backs it like the other two.
  // Two phrasings of the same rule. PGE asks "within 10 feet of the meter"; PacifiCorp asks
  // "within the states required distance from the utility meter? (California - 3 Ft.,
  // Oregon - 10 Ft., Washington - 3 Ft.)" — the operator confirms standard residential
  // detail places the lockable AC disconnect within the required distance on every install.
  { question: /disconnect within 10\s*(feet|ft|')\s*of the .{0,20}meter/i, answer: "Yes" },
  { question: /disconnect.{0,60}(required distance|within the state).{0,40}meter/i, answer: "Yes" },
  // Ameren Illinois asks every applicant whether this is a "public school project" as
  // defined by 220 ILCS 5/16-107.6 — a statutory category that decides a different
  // incentive path. A residential rooftop install never is one, and left unanswered it is a
  // REQUIRED question that blocks the page. enforce=false, so a project that genuinely is
  // one (answered by a human or by project data) is never overridden.
  { question: /public\s*school\s*project/i, answer: "No" },
  // Illinois compensation election (Ameren's Compensation step): take kWh netting and
  // monetise the credits. Operator-confirmed as the standing choice for residential.
  //
  // NOTE FOR WHOEVER TOUCHES THIS: Ameren treats the netting election as IRREVERSIBLE once
  // the application is submitted, so this is a commercial decision encoded as a default, not
  // a mechanical one. enforce=false, so anything already answered — by a human or from
  // project data — always wins.
  { question: /net\s*k?wh|kwh\s*netting|net\s*metering\s*\(k?wh\)/i, answer: "Yes" },
  { question: /monetiz/i, answer: "Yes" },
  // Ameren Illinois: "requires a Manual, External Knife-Blade Type Disconnect OR a Circuit
  // Breaker in a Secured Compartment/Enclosure … along with signage … no less than 5\" by 7\"
  // … Will your system meet this requirement?" — Yes; standard residential detail includes
  // both, and the matching site photo is the "labels" document.
  { question: /knife[-\s]?blade|secured (compartment|enclosure).{0,60}meter|signage.{0,40}5\s*("|in|inch)?\s*(by|x)\s*7/i, answer: "Yes" },
  // METER COLLAR ADAPTER — genuinely job-dependent, and a Yes opens additional MMD fields.
  // It is visible on the SLD, so the right long-term answer is parsed project data driving
  // it; until the parser extracts that, No is the common residential case and enforce=false
  // means a human answer or project data always wins. If a job DOES use one, expect extra
  // required fields to appear and be reported by the required-field sweep.
  { question: /meter\s*collar\s*(adapter|adaptor)?/i, answer: "No" },
];

// Sensitive field labels whose literal value must NEVER be stored in a recorded step.
// FREE-TEXT IDENTIFIERS. An account or meter number is typed; it is never one of three
// options in a dropdown. The planner picks the field a fill binds to and its choice is taken
// verbatim, and it reads a label like "Are the AC disconnect(s) ... within the states
// required distance from the utility meter?" as being ABOUT the meter number — so replay
// then tried to select the option "84198350" in a Yes/No select, landed nothing, and left a
// REQUIRED question blank that PacifiCorp refuses the page over.
//
// labelRulesOutAllCandidates cannot catch this: the label really does contain "meter". The
// control's SHAPE settles it instead — an enumeration cannot hold an identifier.
const IDENTIFIER_FIELDS = new Set(["meterNumber", "accountNumber"]);

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

export const UPLOAD_LABEL_PATTERNS: Array<{ re: RegExp; docType: string }> = [
  // Completed-application slots FIRST (before the generic doc patterns): even
  // portal-entry AHJs (some Accela configs) ask for the filled application/
  // checklist PDF as an attachment. The filled forms are overlaid into
  // docsByType by the backend (filledFormsByDocType).
  { re: /electrical\s*(renewable\s*energy\s*)?(permit\s*)?application/i, docType: "electrical_application" },
  { re: /(building|structural)\s*(permit\s*)?application/i, docType: "building_application" },
  // The generated application package renders these as PDFs now (generatedDocFiles.ts,
  // operator ruling 2026-09-21) — a slot naming a transfer sheet or an interconnection/NEM
  // application can be satisfied instead of skipped. Ordered before the checklist pattern
  // because that one's bare "worksheet" would otherwise swallow "transfer sheet" rows.
  { re: /transfer\s*sheet|application\s*transfer/i, docType: "application_transfer_sheet" },
  { re: /(interconnection|net\s*meter(ing)?|\bnem\b)\s*(application|agreement|form)/i, docType: "utility_application" },
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
  // SIGNAGE BEFORE INVERTER. Ameren Illinois asks for a "Picture of 5 x 7 signage, knife
  // blade disconnect, and smart inverter" — one photo of the installed placard and gear.
  // The inverter pattern below matches the word "inverter" in that sentence, so without
  // this the site photo slot would receive the INVERTER DATA SHEET: an upload that looks
  // successful and is wrong, the same failure the meter-photo note describes.
  { re: /signage|\bsign\b.{0,20}(photo|picture)|(photo|picture).{0,30}(signage|placard|disconnect)/i, docType: "labels" },
  { re: /inverter|micro[-\s]?inverter/i, docType: "inverter_spec" },
  { re: /module|panel\s*(spec|data\s*sheet)|cut\s*sheets?/i, docType: "module_spec" },
  // Both word orders. PacifiCorp's label is "Upload a photo of meter where system will
  // be interconnected" — photo BEFORE meter — which the meter-first pattern missed, so
  // the control matched nothing and, being REQUIRED, fell through to the plan_set
  // substitute: the entire plan set filed into the meter-photo slot, which is worse
  // than leaving it empty.
  { re: /meter\s*(photo|picture|image|spec|reading|tag)|(photo|picture|image)\s+of\s+(the\s+)?meter/i, docType: "meter_photo" },
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

// A SLOT'S `accept` LIST IS A PROMISE ABOUT WHAT THE REVIEWER WILL BE ABLE TO OPEN.
//
// Nothing used to check it: fileFits() weighed SIZE only, so any document could land in any
// control. The fallback chain ends in "utility_package_zip", so a generic "Attach documents"
// slot that accepts only .pdf was handed a ZIP — and the utility reviewer who clicked the
// attachment downloaded a file that would not open as a PDF. A meter photo (.jpg) into a
// PDF-only slot fails the same way. The upload "succeeded" every time, which is why this
// survived: the failure is only visible to whoever downloads it at the other end.
//
// An absent accept list means the portal declares no restriction — allow everything, which
// is the old behaviour and must stay, or slots with no accept would stop being filled.
export function fileTypeAllowed(filePath: string, accept: string): boolean {
  const list = (accept || "").trim();
  if (!list) return true;
  const ext = (filePath.match(/\.[A-Za-z0-9]+$/) || [""])[0].toLowerCase();
  if (!ext) return false;
  // Extension -> the MIME types a portal might name it by.
  const MIME: Record<string, string[]> = {
    ".pdf": ["application/pdf"],
    ".png": ["image/png"],
    ".jpg": ["image/jpeg"], ".jpeg": ["image/jpeg"],
    ".gif": ["image/gif"], ".webp": ["image/webp"], ".bmp": ["image/bmp"],
    ".heic": ["image/heic"], ".tif": ["image/tiff"], ".tiff": ["image/tiff"],
    ".zip": ["application/zip", "application/x-zip-compressed"],
    ".doc": ["application/msword"],
    ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ".xls": ["application/vnd.ms-excel"],
    ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ".csv": ["text/csv"],
  };
  const mimes = MIME[ext] ?? [];
  for (const raw of list.split(",")) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    if (token === "*" || token === "*/*") return true;
    if (token.startsWith(".")) { if (token === ext) return true; continue; }
    if (token.endsWith("/*")) { // "image/*"
      const family = token.slice(0, -2);
      if (mimes.some((m) => m.startsWith(`${family}/`))) return true;
      continue;
    }
    if (mimes.includes(token)) return true;
  }
  return false;
}

// SLOTS THAT MUST NEVER RECEIVE A SUBSTITUTE. The fallback above is right for a vague
// "Attach documents" control, and wrong for a slot that names a document we simply do not
// hold: proof of insurance, an installation invoice, a W-9, a commissioning settings photo.
// Filing the plan set against "Attach Proof of Insurance" is not a near-miss — it is a wrong
// document in a named slot, which reads as complete to us and as nonsense to the reviewer,
// and it is exactly the failure the meter-photo note above records. Leave these empty so the
// required-field sweep reports them and a human supplies the real file.
const UPLOAD_NO_SUBSTITUTE = /insurance|invoice|\bw-?9\b|tax\s*form|voided\s*check|bank|volt\s*var|settings\s*(picture|photo|screenshot)|commissioning\s*(photo|report)|interconnection\s*agreement|signed\s*agreement/i;
const EXACT_UPLOAD_TYPES = new Set(["building_application", "electrical_application", "permit_application", "solar_checklist", "structural_letter"]);

export function exactUploadDocType(label: string): string | null {
  const type = UPLOAD_LABEL_PATTERNS.find(({ re }) => re.test(label))?.docType;
  return type && EXACT_UPLOAD_TYPES.has(type) ? type : null;
}

/** True when a slot names a document the split cannot produce, so the generic plan-set
 *  fallback must not fire for it. */
export function uploadForbidsSubstitute(label: string | undefined): boolean {
  if (!label) return false;
  return UPLOAD_NO_SUBSTITUTE.test(label) || exactUploadDocType(label) !== null;
}

export function isPayFee(text: string | undefined): boolean {
  return !!text && PAY_FEE.test(text);
}

export function isSensitiveLabel(label: string): boolean {
  return SENSITIVE_LABEL.test(label);
}

// CSS selector used in $$eval() to extract all interactive elements from the page.
// Exported so llmGapFill.ts can reuse the same selector for consistency.
// IS THIS ELEMENT A DROPDOWN WIDGET'S BACKING INPUT? Runs INSIDE the page.
//
// The same test extractFieldsInPage uses to call such an input a select — hidden, wrapped
// in something named like a dropdown, and that wrapper showing a value. Exported because
// the FILL path needs the same answer: for these controls "not visible" is the normal
// state, not a reason to give up.
export function hasVisibleWidgetFaceInPage(el: Element): boolean {
  const wrap = el.closest('[class*="dropdown"], [class*="combobox"], [class*="t-widget"], [class*="k-widget"], [class*="select2"], [class*="chosen"]');
  if (!wrap) return false;
  const face = wrap.querySelector('.t-input, .k-input, [class*="-input"], [class*="dropdown-wrap"], [class*="rendered"]');
  return !!face && (face as HTMLElement).offsetParent !== null;
}

export const EXTRACT_SEL = "input, select, textarea, button, [role=button], a[href]:not([href='#']):not([href=''])";

// ---------------------------------------------------------------------------
// ONE ACTIVE SCOPE PER PAGE — scope the HARVEST, never the page's exits.
//
// ComEd (interconnect.comed.com, a NEM portal, and its platform twin
// peco.connectthegrid.com) opens the application in a DRAWER over the dashboard and leaves
// the dashboard mounted behind it. The walk harvested both at once; the banked census reads
//
//   p2 "ConnectTheGrid" [interconnect.comed.com/applications] form
//      fields=55(fill=28,btn=27,link=6) plan:nav=- adv=- fills=7 review=false
//   p3 "ConnectTheGrid" [interconnect.comed.com/applications] form
//      fields=55(fill=28,btn=27,link=6) plan:nav=26 adv=- fills=0 review=false
//
// — the drawer's 28 fillables PLUS the dashboard's 27 buttons in ONE list. Given that list
// the planner picked nav=26, "New Application Button. This will open a popup drawer.", and
// RE-OPENED the drawer instead of advancing inside it, page after page. Two pages of the
// budget bought seven fills and no review screen.
//
// The fix is structural and portal-agnostic: resolve ONE active scope per page (the topmost
// open panel with a real bounding box) and harvest inside it. Nothing here names a host.
//
// *** THE HOLE, CLOSED FROM THE START: THE PAGE'S ONLY WAY FORWARD. ***
// An earlier build of this dropped EVERY control outside the scope, buttons and links
// included. A mainstream SPA wizard renders its step body in a panel and its Next in a
// STICKY ACTION BAR outside that panel — and the scope gate below counts only FILLABLES, of
// which an action bar has none. That wizard lost its only way forward entirely: the planner
// never saw the footer Next (it came back inActiveScope=false), clickFallbackAdvance
// iterated the same scoped array and never saw it either, the panel's own Submit became the
// only forward control the engine could see, and the run banked a live "Step 2 of 5" page as
// a review screen. A lost advance is a page nobody learns, which is the opposite of the job.
//
// We take OPTION (a) — exempt outside controls from the scope filter when the scope holds no
// way forward — and NOT option (b) (require real modality before scoping at all), because
// (b) only ever fires on aria-modal/dialog[open]/inert-background markup and the drawer that
// produced the defect is a .mat-drawer / .cdk-overlay-pane; gating on modality would leave
// ComEd exactly as broken as it is today, which is failing the assignment.
//
// (a) is NARROWED from "exempt every outside button/link" to "re-admit the outside controls
// that are themselves SHAPED LIKE A WAY FORWARD": if the exemption re-admitted everything,
// ComEd's 27 dashboard buttons would come straight back the moment its drawer happened to
// carry no advance-shaped control, and the planner would pick "New Application Button"
// again — the very defect. "Next"/"Continue"/"Submit" come back; "New Application Button"
// does not. What we give up is a wizard whose sole footer control is an icon or a bare
// "Save": that page stalls and banks nothing, which is recoverable. Re-banking the defect is
// not.
// ---------------------------------------------------------------------------

/** The wording a page's WAY FORWARD takes. Hoisted out of clickFallbackAdvance so the
 *  fallback finder and the scope exemption below cannot drift apart — they must agree on
 *  what "an advance" is, or the exemption re-admits a control the fallback then refuses. */
export const ADVANCE_ONLY = /^\s*(next|continue|proceed|save (and|&) (continue|next)|save & next|next step|go to next)\b/i;

/** The panels a portal opens OVER the page it is on. Identical to the list
 *  clickCreateDialogAdvance already probes — one page, one idea of what "the open panel" is.
 *  NOTE: markActiveScopeInPage repeats this literally rather than closing over it, because
 *  that function is serialized into the browser and a closed-over constant is a
 *  ReferenceError there. Change one, change both. */
export const ACTIVE_SCOPE_PANEL_SEL =
  "[aria-modal='true'], [role='dialog'], dialog[open], mat-dialog-container, .cdk-overlay-pane, .mat-drawer, .modal";

/** The transient attribute the resolver stamps on the winning panel. The harvest and the
 *  did-it-move signature both READ it rather than each re-deciding what the scope is, so
 *  they cannot disagree: there is one resolver and one marked element. Precedent for a
 *  transient learn-time DOM marker: data-al-resultrow. */
export const ACTIVE_SCOPE_CSS = '[data-al-activescope="1"]';

/** Resolve and MARK the one active scope on the page. Serialized into the browser, so: no
 *  reference to any module constant, and no named inner helper (esbuild's keepNames wraps
 *  those as `__name(fn, "x")`, which does not exist in a raw page — see
 *  waitForAutosaveIndicator's comment for the verified failure).
 *
 *  Tiers, in order:
 *    1. the topmost OPEN panel with a real bounding box that actually holds a visible
 *       fillable, or
 *    2. nothing — the document, i.e. exactly today's behaviour.
 *
 *  The "container of the fields filled on this page" tier the brief also describes is
 *  DELIBERATELY NOT IMPLEMENTED, and the reason is in this file: advanceSignatureOf's own
 *  comment records that scoping out an appearing results panel was "the opposite of the bug
 *  it was written to fix", and its two callers — pressEnterInLastFilledField and
 *  clickMatchingResultRow — are exactly the fill-a-search-box-then-results-render-OUTSIDE-the
 *  -form interaction, both of which throw the step away when the signature does not change.
 *  That tier would also scope a plain single-form page to its own <form> after the first
 *  fill, which contradicts the requirement that an ordinary page behave exactly as before.
 *
 *  A panel with no fillable is not a scope: a confirm dialog, a toolbar that happens to
 *  carry class="modal", a collapsed Material drawer. A closed drawer is PRESENT BUT SHUT and
 *  has no box — the 40px floor is the same one clickCreateDialogAdvance uses. */
export function markActiveScopeInPage(): { marked: boolean; tag: string; fillables: number } {
  for (const prev of Array.from(document.querySelectorAll('[data-al-activescope="1"]'))) {
    prev.removeAttribute("data-al-activescope");
  }
  const panels = Array.from(document.querySelectorAll(
    "[aria-modal='true'], [role='dialog'], dialog[open], mat-dialog-container, .cdk-overlay-pane, .mat-drawer, .modal",
  )) as HTMLElement[];
  let pick: HTMLElement | null = null;
  let pickFillables = 0;
  for (const p of panels) {
    const r = p.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) continue; // present but shut
    const st = window.getComputedStyle(p);
    if (st.visibility === "hidden" || st.display === "none") continue;
    // A panel the page itself has retired is not the active one, whatever its classes say.
    if (p.closest('[aria-hidden="true"], [inert]')) continue;
    let n = 0;
    for (const f of Array.from(p.querySelectorAll("input, select, textarea")) as HTMLElement[]) {
      const fr = f.getBoundingClientRect();
      if (fr.width > 2 && fr.height > 2) n++;
    }
    if (n < 1) continue;
    // TOPMOST = LAST IN DOM ORDER. Overlay hosts append, and a panel nested inside another
    // panel comes after its container in document order, so "keep the last survivor" picks
    // the innermost/newest open thing without reading z-index off a stacking context.
    pick = p;
    pickFillables = n;
  }
  if (!pick) return { marked: false, tag: "", fillables: 0 };
  pick.setAttribute("data-al-activescope", "1");
  return { marked: true, tag: pick.tagName.toLowerCase(), fillables: pickFillables };
}

/** THE SINGLE ENTRY POINT to the scope, for Node. Both consumers — the field harvest and
 *  the did-it-move signature — go through here, so "the resolver and the signature's scope
 *  move together" is true by construction rather than by convention.
 *
 *  AUTOLEARN_NO_ACTIVE_SCOPE=1 turns scoping off and clears any marker, which is what the
 *  activeScope fixture's KILL TEST flips: with it set, the harvest must go back to carrying
 *  the dashboard behind the drawer. A fixture that passes without the fix is not a test.
 *  Never throws — a page mid-navigation falls back to the whole document, i.e. today. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolveActiveScope(page: any): Promise<{ marked: boolean; tag: string; fillables: number }> {
  const none = { marked: false, tag: "", fillables: 0 };
  if (!page || typeof page.evaluate !== "function") return none;
  if (process.env.AUTOLEARN_NO_ACTIVE_SCOPE === "1") {
    await page.evaluate(() => {
      for (const p of Array.from(document.querySelectorAll('[data-al-activescope="1"]'))) {
        p.removeAttribute("data-al-activescope");
      }
    }).catch(() => null);
    return none;
  }
  try {
    const r = await page.evaluate(markActiveScopeInPage) as { marked: boolean; tag: string; fillables: number } | null;
    return r && typeof r.marked === "boolean" ? r : none;
  } catch {
    return none;
  }
}

/** THE GATE: does the panel own an advance the engine is actually ALLOWED to click?
 *  clickFallbackAdvance's own test, to the letter — and the asymmetry with
 *  isForwardExitLabel below is the whole point. A SUBMIT is not an answer here: the
 *  incident this closes is a panel whose only control was a Submit, where counting that
 *  Submit as "the panel has a way forward" suppresses the exemption and hands the engine a
 *  filing as its only move. Refusing to count it means the exemption fires and the real
 *  Next, out in the sticky footer, comes back. */
function isPanelAdvanceLabel(label: string | undefined): boolean {
  const t = String(label ?? "").trim();
  if (!t || t.length > 40) return false;
  if (PAGINATION_CONTROL.test(t)) return false;
  if (SUBMIT_INTENT.test(t)) return false;
  return ADVANCE_ONLY.test(t);
}

/** RE-ADMISSION: is this label shaped like a page's WAY FORWARD at all? Union of the
 *  advance wording and the submit wording, minus a paginator. Submits count HERE because a
 *  review screen's Submit really is that page's exit and must be SEEN so it can be recorded
 *  (recorded, never clicked — hard rule 1); a footer Submit filtered away is a recipe with
 *  no final step for the human to perform. Composes with the PAGINATION_CONTROL guard
 *  (c86fc08) rather than duplicating it: "Next page" is a table pager on somebody's
 *  dashboard, never a wizard's exit, and must never be re-admitted. */
export function isForwardExitLabel(label: string | undefined): boolean {
  const t = String(label ?? "").trim();
  if (!t || t.length > 60) return false;
  if (PAGINATION_CONTROL.test(t)) return false;
  return ADVANCE_ONLY.test(t) || SUBMIT_INTENT.test(t);
}

/** isOffLimitsButton's test, at the RawField level (the filter runs before the map to
 *  ExtractedField). Keep the two in step: a control the click paths refuse must never be
 *  re-admitted by the exemption as if it were a way forward. */
function rawIsOffLimits(r: RawField): boolean {
  return isPayFee(r.label) || isPayFee(r.name) || isPayFee(r.text)
    || EXISTING_RECORD_ACTION.test(r.label || "")
    || EXISTING_RECORD_ACTION.test(r.name || "")
    || EXISTING_RECORD_ACTION.test(r.text || "");
}

/** Apply the resolved scope to a harvest. `scopeActive` is what markActiveScopeInPage
 *  reported; when it is false NOTHING is filtered and an ordinary single-form page behaves
 *  exactly as it did before this existed. Exported so the fixture can pin both directions. */
export function applyActiveScopeFilter(
  raws: RawField[],
  scopeActive: boolean,
): { fields: RawField[]; dropped: number; exempted: string[] } {
  if (!scopeActive) return { fields: raws, dropped: 0, exempted: [] };
  // A control nobody can reach is not the panel's way forward: if an offstage "Continue"
  // counted here, the exemption would stay shut and the page would lose its real exit for
  // the sake of a control the page itself has retired.
  const scopeHasForward = raws.some(
    (r) => r.inActiveScope !== false && !r.offstage
      && r.fieldType === "button" && isPanelAdvanceLabel(r.label) && !rawIsOffLimits(r),
  );
  const exempted: string[] = [];
  let dropped = 0;
  // Filtered in place rather than concatenated: the planner addresses fields BY INDEX, so a
  // re-ordered list would silently re-aim every fill it asks for.
  const fields = raws.filter((r) => {
    if (r.inActiveScope !== false) {
      // aria-hidden / inert subtrees are excluded even INSIDE the scope. A panel that keeps
      // its next step pre-rendered behind aria-hidden offers fields no person can type into;
      // planning a fill there spends the reveal attempt and four retries on a control the
      // page has explicitly retired, and (worse) can answer a question the operator never
      // sees. Only applies when a scope resolved, so a plain page is untouched.
      if (r.offstage) { dropped++; return false; }
      return true;
    }
    // The panel owns the FIELDS unconditionally — the whole point is that the dashboard's
    // inputs behind an open drawer are not this page's inputs.
    if (r.fieldType !== "button") { dropped++; return false; }
    if (scopeHasForward) { dropped++; return false; }
    // aria-hidden / inert is the page saying nobody can reach this. Never re-admit it —
    // that is also where a genuinely modal portal parks its background, so real modality
    // still wins where the portal bothers to declare it.
    if (r.offstage) { dropped++; return false; }
    if (!isForwardExitLabel(r.label) || rawIsOffLimits(r)) { dropped++; return false; }
    exempted.push(String(r.label ?? "").slice(0, 40));
    return true;
  });
  return { fields, dropped, exempted };
}

// ---------------------------------------------------------------------------
// A TERMINAL PAGE WHOSE ONLY FORWARD CONTROL IS A FINAL SUBMIT IS ITS OWN REVIEW.
//
// permiteyes.us is a 176-field SINGLE-PAGE application: no Next, no wizard, one "Submit". The
// walk fills ~60 fields, finds no advance, and dies at the repeat-page stop, banking 65 steps
// as needs_rerecord — which findCompleteRecipeForProject then ignores. Every portal built this
// way is unlearnable for the same reason: the engine's only definition of "the end" was a
// review SCREEN, and a one-page application never shows one.
//
// So: after every way forward has declined, ask whether the page IS the end. If it is, the
// submit is RECORDED (isFinalSubmit:true, hard rule 1) and NEVER clicked, and the run reports
// reachedReview so the recipe is staged instead of thrown away.
//
// *** THE FIVE HOLES AN ADVERSARIAL REVIEW FOUND IN THE FIRST BUILD OF THIS, CLOSED FROM THE
// *** START. Each was reproduced live. The cost of getting this wrong is not a missed page: it
// *** is a recipe that teaches a human (or trusted auto-submit) to click a control that saves a
// *** draft, pays a fee, or files a half-finished application.
//
// HOLE 1 — it accepted ANY control containing the bare word "submit" or "finish", so a
//   DRAFT-SAVE ended the application. Repro: "Step 2 of 4 — Equipment. Two more steps to go.",
//   whose real advance is "Save and Proceed" (not advance-shaped, so clickFallbackAdvance
//   declines) and whose other control is "Save and Finish Later" (matches \bfinish\b). That
//   banked reachedReview=true with isFinalSubmit on a button that saves and exits — and
//   promotion to 'complete' is REACHABLE from there, because a mid-wizard page clears the
//   pageCount>=3 / substantiveFills>=5 floor and the verifier sees values that really do match
//   the project. The answer is that ABSENCE OF AN ADVANCE IS NOT EVIDENCE OF AN END: a
//   POSITIVE terminality signal is required, an unfinished step-of-N marker is disqualifying,
//   and defer/draft wording is refused outright.
//
// HOLE 2 — a wizard step whose Next is PRESENT BUT DISABLED (the ordinary state of a gated
//   step) was classified as review. clickFallbackAdvance selects that Next on LABEL alone,
//   never inspects disabled state, fails actionability, pops its own step and falls straight
//   through to here — which never noticed an advance-shaped control existed. Repro: "Step 1 of
//   3 — Site. Next unlocks once the address is validated.", <button disabled>Next</button> +
//   <button>Submit</button>. A page that owns a Next is a page with a next; a DISABLED one is a
//   GATE, which is the opposite of terminality. Hence the gate rule below refuses on the
//   PRESENCE of an advance-shaped control, enabled or not.
//
// HOLE 3 — PAY_FEE was the only thing between this rule and a PAYMENT recorded as the final
//   submit, and it listed "submit and pay" but not the reverse order and had no bare
//   \bpayment\b. "Pay and Submit Application" and "Submit Payment" both produced isFinalSubmit
//   steps. Two layers now, because a phrase list keeps losing this race: PAY_FEE is widened
//   (above), AND this classifier refuses any candidate that mentions money at all, regardless.
//   A control that mentions money is never the safe thing to record as the end of a NEW
//   application — losing a legitimate one costs a miss, not a filing.
//
// HOLE 4 — an advance-shaped control is never the terminal submit even when it also matches
//   submit wording. "Continue Application" FILES on Accela's review page and is the ordinary
//   page advance everywhere else; treating it as evidence of an end stops a six-page wizard on
//   page two.
//
// HOLE 5 — the operator-delegation click branch is deliberately NOT wired into this path. An
//   INFERENCE that a page is terminal is not authority to file it. See the call site.
// ---------------------------------------------------------------------------

/** An UNFINISHED wizard marker. "Step 2 of 4", "Step 2/4", "Page 3 of 7" — current < total
 *  means the portal itself says there is more to come, which outranks any shape argument.
 *  current === total is left alone: "Step 4 of 4" is legitimately the last step. Scanned with
 *  matchAll rather than a first match, because a stray marker elsewhere in the body text must
 *  not be allowed to stand in for the real one. */
const STEP_OF_N = /\b(?:step|page|section)\s*(\d{1,2})\s*(?:of|\/)\s*(\d{1,2})\b/gi;

/** DEFER / DRAFT wording: the control saves and leaves; it does not file. This is the whole of
 *  hole 1 in one line — "Save and Finish Later" matches SUBMIT_INTENT's \bfinish\b. */
const DEFER_DRAFT = /\b(later|draft|for now)\b|save\s*(and|&)\s*(exit|close|finish)/i;

/** MONEY, IN ANY FORM — layer 2 of hole 3, independent of PAY_FEE on purpose. Deliberately
 *  unbounded on the right (`\bfee` catches "Fees"/"Feedback"): over-refusing here costs one
 *  un-learned page, under-refusing costs a payment recorded as the end of an application.
 *
 *  PURCHASE-COMMIT VOCABULARY (`purchase`/`buy`/`order`) added after an adversarial probe of
 *  this classifier: "Place Order" and "Submit Order" came back TERMINAL and were recorded
 *  isFinalSubmit:true. Both clear every other guard — `\bplace order\b` is in TERMINAL_VERB,
 *  "orders?" is in APPLICATION_NOUN, and neither PAY_FEE nor PAY_FEE_REPLAY_GATE mentions
 *  "order" at all, so the replay gate answered replayGateBlocks=false. In trusted autoSubmit
 *  that is a money-committing click reached by INFERENCE, which is hard-rule-1 territory.
 *  Blunt (bare `\border\b`) is right HERE specifically because this regex only ever decides
 *  whether an already-submit-shaped button is recorded as the end — a "Sort Order" header is
 *  not a TERMINAL_VERB match and never reaches this line. The click-blocking lists below are
 *  widened more narrowly, because there over-refusal stalls a real page. */
const MONEY_ANYWHERE = /\bpay\b|\bpaid\b|\bfee|\bpayment|\bcart|\bcheckout|\bremit|\binvoice|\bpurchase|\bbuy\b|\border\b/i;

/** The verbs that END an application. Bare `file` is excluded on purpose — "Choose File" and
 *  "Upload File" are upload controls, and counting them would refuse terminality on every page
 *  that has an attachment slot (which permiteyes, the portal this exists for, does).
 *
 *  DELIBERATELY A SUPERSET OF SUBMIT_INTENT, "continue application" included. Narrowing this
 *  to exclude the advance-shaped wording would make hole 4's guard unreachable — and a guard
 *  nothing can reach is a guard nothing tests, which is how it comes back the next time
 *  somebody widens this line. Everything advance-shaped is refused EXPLICITLY below instead,
 *  twice: once at the page level (the gate) and once at the candidate level. */
const TERMINAL_VERB =
  /\b(submit|finali[sz]e|finish|complete)\b|\bfile\s+(a|an|the|my|your)?\s*(application|request|permit|submittal|interconnection|form|project)\b|\bconfirm submission\b|\bplace order\b|\bcontinue application\b/i;

/** The nouns a terminal verb is allowed to govern, so "Submit Search", "Submit Documents" and
 *  "Submit Feedback" stop qualifying while "Submit"/"Submit Application" keep working. */
const APPLICATION_NOUN =
  /\b(applications?|submissions?|submittals?|requests?|permits?|interconnections?|forms?|projects?|registrations?|filings?|packages?|packets?|enrollments?|orders?)\b/i;

/** Words that carry no object of their own, so "Submit Now" is still a bare submit. */
const SUBMIT_STOPWORD = /^(now|my|the|a|an|your|this|these|all|and|to|it|here|please)$/i;

/** Advance wording ANYWHERE in a label, not just anchored at the front (ADVANCE_ONLY). This is
 *  what disqualifies "Submit and Continue" — a control that is plainly still mid-wizard. */
const ADVANCE_WORD_ANYWHERE = /\b(next|continue|proceed)\b/i;

/** Anything shaped like a page's way FORWARD, for the "no other forward control" clause. */
const FORWARD_SHAPED = /\b(next|continue|proceed|forward|submit|finish|finali[sz]e|complete)\b/i;

/** Every distinct reason this classifier can refuse. Named so the walk emits ONE debug event
 *  that says WHICH rule spoke (the operator can then see the gate that stopped it), and so the
 *  fixture can disable exactly one rule at a time — a guard whose removal breaks nothing is not
 *  a guard. */
export type TerminalGuard =
  | "validation" | "step" | "gate" | "advance" | "payfee" | "money" | "defer" | "noun" | "positive" | "none";

export type TerminalVerdict =
  | { terminal: true; index: number; label: string; why: string }
  | { terminal: false; guard: TerminalGuard; reason: string };

/** isOffLimitsButton at module scope, so the classifier and the click paths refuse the same
 *  controls without the classifier needing an adapter instance. */
function labelIsOffLimits(label: string): boolean {
  return isPayFee(label) || EXISTING_RECORD_ACTION.test(label);
}

/** Does the terminal verb in this label govern an APPLICATION, or something else entirely?
 *  True for "Submit", "Submit »", "Submit Now", "Submit Application", "Complete Submission".
 *  False for "Submit Search", "Submit Documents", "Submit Feedback", "Submit Payment". */
export function submitGovernsApplication(label: string): boolean {
  const t = String(label ?? "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (APPLICATION_NOUN.test(t)) return true;
  // No application noun — then the verb must govern NOTHING at all. Strip the verb and any
  // non-letters (a "»" chevron is not an object) and see what is left.
  const rest = t
    .replace(/\b(submit|finali[sz]e|finish|complete|file|confirm|place|save|order)\b/gi, " ")
    .replace(/[^A-Za-z ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !SUBMIT_STOPWORD.test(w));
  return rest.length === 0;
}

/** IS THIS PAGE THE WHOLE APPLICATION? Pure, so the fixture can drive every branch from real
 *  harvested markup, and so `without` can retire one guard at a time for the kill matrix.
 *
 *  `without` is a TEST-ONLY affordance and is never passed by the walk. It is a parameter
 *  rather than an env var deliberately: an env switch that weakens a classifier which records
 *  isFinalSubmit steps is a production hazard (the precedent, AUTOLEARN_NO_ACTIVE_SCOPE, can
 *  only cost a page; this one could cost a filing). */
export function classifyTerminalSubmitPage(
  input: { fields: ExtractedField[]; bodyText: string; validationErrors?: string[] },
  without: TerminalGuard[] = [],
): TerminalVerdict {
  const off = (g: TerminalGuard): boolean => without.includes(g);
  const fields = Array.isArray(input.fields) ? input.fields : [];
  const body = String(input.bodyText ?? "");
  const buttons = fields.filter((f) => f?.fieldType === "button");
  const labelOf = (f: ExtractedField): string => String(f?.label ?? "").replace(/\s+/g, " ").trim();

  // 1) THE PORTAL IS COMPLAINING. A page showing a live validation error is a page that has
  //    just refused something, not a page waiting to be filed.
  if (!off("validation") && (input.validationErrors?.length ?? 0) > 0) {
    return { terminal: false, guard: "validation", reason: `the page is showing a validation error: ${input.validationErrors![0].slice(0, 80)}` };
  }

  // 2) HOLE 2: the page OWNS a way forward. Enabled or not — a disabled Next is a GATE, and a
  //    gate is the opposite of an end. Pagination and off-limits controls are not advances
  //    (composes with PAGINATION_CONTROL, c86fc08, rather than re-deciding it).
  //    CHECKED BEFORE THE STEP MARKER on purpose: the brief's hole-2 repro carries both
  //    ("Step 1 of 3" AND a disabled Next), and of the two reasons only one tells an operator
  //    what to do — the page is waiting for them to unlock something.
  if (!off("gate")) {
    const gate = buttons.find((f) => {
      const t = labelOf(f);
      if (!t || t.length > 60) return false;
      if (PAGINATION_CONTROL.test(t)) return false;
      if (labelIsOffLimits(t)) return false;
      return ADVANCE_ONLY.test(t);
    });
    if (gate) {
      const t = labelOf(gate);
      return {
        terminal: false,
        guard: "gate",
        reason: `the page owns an advance-shaped control ${JSON.stringify(t)}${gate.disabled ? " (DISABLED — a gate, not an absence)" : ""}`,
      };
    }
  }

  // 3) HOLE 1(a): the portal says there are more steps. Nothing below can outrank that.
  if (!off("step")) {
    for (const m of body.matchAll(STEP_OF_N)) {
      const cur = Number(m[1]);
      const total = Number(m[2]);
      if (Number.isFinite(cur) && Number.isFinite(total) && total > 1 && cur < total) {
        return { terminal: false, guard: "step", reason: `the page says "${m[0]}" — ${total - cur} step(s) still to come` };
      }
    }
  }

  // 4) Find the one control that could be this application's end.
  const refusals: Array<{ guard: TerminalGuard; reason: string }> = [];
  const note = (guard: TerminalGuard, reason: string): void => { refusals.push({ guard, reason }); };
  let candidate: { index: number; label: string } | null = null;
  for (let i = 0; i < fields.length && !candidate; i++) {
    const f = fields[i];
    if (f?.fieldType !== "button") continue;
    const t = labelOf(f);
    if (!t || t.length > 60) continue;
    if (!TERMINAL_VERB.test(t)) continue;
    // A submit nobody can press is not this page's exit.
    if (f.disabled) { note("gate", `the only submit-shaped control ${JSON.stringify(t)} is disabled`); continue; }
    // HOLE 4 — an advance is never the end, however it is worded.
    if (!off("advance") && (ADVANCE_ONLY.test(t) || ADVANCE_WORD_ANYWHERE.test(t))) {
      note("advance", `${JSON.stringify(t)} is advance-shaped — it is this page's Next on every page but the last`);
      continue;
    }
    // HOLE 3, layer 1.
    if (!off("payfee") && labelIsOffLimits(t)) { note("payfee", `${JSON.stringify(t)} is a pay/fee/record control`); continue; }
    // HOLE 3, layer 2 — independent of the phrase list above, on purpose.
    if (!off("money") && MONEY_ANYWHERE.test(t)) { note("money", `${JSON.stringify(t)} mentions money`); continue; }
    // HOLE 1(c), first half.
    if (!off("defer") && DEFER_DRAFT.test(t)) { note("defer", `${JSON.stringify(t)} saves a draft and leaves — it does not file`); continue; }
    // HOLE 1(c), second half — the verb must govern the APPLICATION, not a search or an upload.
    if (!off("noun") && !submitGovernsApplication(t)) {
      note("noun", `${JSON.stringify(t)} submits something that is not the application`);
      continue;
    }
    candidate = { index: i, label: t };
  }
  if (!candidate) {
    // The FIRST refusal is the one reported: on a page with several submit-shaped controls it
    // names the one nearest the top of the document, which is the one an operator will look at.
    return refusals[0]
      ? { terminal: false, guard: refusals[0].guard, reason: refusals[0].reason }
      : { terminal: false, guard: "none", reason: "the page has no submit-shaped control at all" };
  }

  // 5) HOLE 1(b): a POSITIVE terminality signal, never merely the absence of an advance.
  //    One of: the page reads as a review/attestation screen; it carries an accept-terms gate;
  //    or the submit really is the only enabled way forward on it.
  //    DEFER-WORDED CONTROLS DO NOT COUNT AS FORWARD CONTROLS — a draft-save is definitionally
  //    not a way forward, and counting one would make a genuine single-page application whose
  //    exit is "Save and Finish Later" permanently unlearnable, which is the silently-deleted
  //    feature this file has shipped before.
  if (!off("positive")) {
    const reviewish = REVIEW_MARKERS.test(body);
    const termsGate = fields.some((f) => f?.fieldType === "checkbox" && ACCEPT_TERMS.test(String(f.label ?? "")));
    const chosen = fields[candidate.index];
    const otherForward = buttons.filter((f) => {
      // By IDENTITY, not by index: `buttons` is a filtered view, so its indices are not the
      // indices into `fields` that candidate.index speaks. Comparing the two numbers excluded
      // an arbitrary OTHER button and left the candidate itself in the "other forward" count,
      // which refuses every genuine single-page application.
      if (f === chosen) return false;
      const t = labelOf(f);
      if (!t || t.length > 60) return false;
      if (f.disabled) return false;               // a gated control is not an enabled way forward
      if (PAGINATION_CONTROL.test(t)) return false;
      if (DEFER_DRAFT.test(t)) return false;
      return FORWARD_SHAPED.test(t);
    }).map((f) => labelOf(f));
    if (!reviewish && !termsGate && otherForward.length > 0) {
      return {
        terminal: false,
        guard: "positive",
        reason: `no positive sign this page is the end, and it still offers ${otherForward.slice(0, 3).map((t) => JSON.stringify(t)).join(", ")}`,
      };
    }
    const why = reviewish ? "the page reads as a review/attestation screen"
      : termsGate ? "the page carries an accept-terms gate"
        : `${JSON.stringify(candidate.label)} is the only enabled way forward on the page`;
    return { terminal: true, index: candidate.index, label: candidate.label, why };
  }
  return { terminal: true, index: candidate.index, label: candidate.label, why: "positive-signal guard disabled (test)" };
}

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
  /** Set ONLY when an active scope was resolved on the page (see markActiveScopeInPage).
   *  `false` means "this control belongs to the page BEHIND the open panel" — the dashboard
   *  under ComEd's application drawer. Left undefined when there is no panel, so a plain
   *  page carries no scope opinion at all. */
  inActiveScope?: boolean;
  /** True when the control sits inside an aria-hidden="true" or [inert] subtree — the page
   *  itself saying nobody can reach it. Never re-admitted by the exit exemption. */
  offstage?: boolean;
  /** True when the control is not operable right now. See ExtractedField.disabled. */
  disabled?: boolean;
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
    // A SUBMIT/BUTTON INPUT'S TEXT IS ITS VALUE. It has no textContent at all, so the
    // fallbacks below reached `name` and labelled Miami's way forward "btnSubmit" —
    // <input type="submit" name="btnSubmit" value="Start New Application">. The planner,
    // offered a control called btnSubmit, went back to the Legal Agreement page instead.
    // Classic ASP.NET renders every button this way, so this is most of the fleet.
    //
    // It also closes a safety hole in the other direction: a real "Submit Application"
    // button whose label read as "btnSubmit" matched no SUBMIT_INTENT and could be clicked
    // as an ordinary advance.
    {
      const t = el.tagName.toLowerCase();
      const ty = (el.getAttribute("type") || "").toLowerCase();
      if (t === "input" && (ty === "submit" || ty === "button" || ty === "reset")) {
        const v = ((el as HTMLInputElement).value || el.getAttribute("value") || "").trim();
        if (v) return v;
      }
    }
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder.trim();
    // A RADIO'S ANSWER IS THE WORD NEXT TO IT, AND ITS <label for> MAY POINT AT NOTHING.
    //
    // Miami's Additional Options renders each Yes/No question as two radios that share ONE
    // id and one name, with <label for="Yes">Yes</label> and <label for="No">No</label> —
    // `for` attributes naming ids that do not exist on the page. Every rule above therefore
    // misses, `name` wins, and the planner is offered two identical controls both called
    // "bolIsCityProject". It cannot answer a Yes/No question when Yes and No look the same,
    // and the portal says "You must select one option for City Project Question".
    //
    // Radios and checkboxes only: for a text input the neighbouring word is a prompt, not a
    // value, and the rules above already handle it.
    const tag2 = el.tagName.toLowerCase();
    const type2 = (el.getAttribute("type") || "").toLowerCase();
    if (tag2 === "input" && (type2 === "radio" || type2 === "checkbox")) {
      // Adjacent in EITHER direction, and from the control OR its wrapper. Miami writes its
      // Yes/No answers as a preceding <label for=...> naming an id that does not exist, and
      // its work-item list as
      //     <div class="chkZone"><input type="checkbox" name="chkTradeItem"></div>
      //     <div class="Zonelbl">FLAT ROOF</div>
      // where the words are in a FOLLOWING div, sibling of the checkbox's PARENT. Four
      // checkboxes on that page all reached the planner as "chkTradeItem", it checked none of
      // them, and the portal said "Please select at least one work item".
      //
      // A <label> wins wherever it is; otherwise any short text-only neighbour will do, as
      // long as it holds no form control of its own (or it is the NEXT field's label, not
      // this one's).
      const neighbourText = (from: Element | null): string => {
        let best = "";
        for (const dir of ["previousElementSibling", "nextElementSibling"] as const) {
          let sib: Element | null = from ? (from[dir] as Element | null) : null;
          for (let k = 0; sib && k < 3; k++) {
            const t = (sib.textContent || "").replace(/\s+/g, " ").trim();
            const ownsControl = !!sib.querySelector("input, select, textarea");
            if (t && t.length <= 40 && !ownsControl) {
              if (sib.tagName === "LABEL") return t;
              if (!best) best = t;
            }
            sib = sib[dir] as Element | null;
          }
        }
        return best;
      };
      const own = neighbourText(el);
      if (own) return own;
      const viaWrapper = neighbourText(el.parentElement);
      if (viaWrapper) return viaWrapper;
    }
    // A BUTTON'S VISIBLE TEXT BEATS ITS name ATTRIBUTE.
    //
    // permiteyes.us renders its three footer controls as
    //   <button id="submit_form" name="submit_form">Submit</button>
    //   <button name="save_form1">Save and Exit</button>
    //   <button name="exit_form">Exit</button>
    // and this function returned `name` first, so they were labelled "submit_form" /
    // "save_form1" / "exit_form". SUBMIT_INTENT.test("submit_form") is FALSE - \bsubmit\b finds
    // no word boundary before an underscore - so a page whose only forward control was a Submit
    // button looked like it had none. The natural experiment is INSIDE THE SAME PAGE: the one
    // copy with an id but NO name (<button id="exit_form1">Exit</button>) was labelled "Exit"
    // correctly, because it fell through to textContent.
    //
    // This is the same hazard the <input type=submit> value-beats-name fix above already covers
    // for one element type; the comment there records a real "Submit Application" button reading
    // as "btnSubmit" and being clicked as an ordinary advance. It costs more than submit
    // detection: a "Next" button named next_page was labelled "next_page", so clickFallbackAdvance
    // could not see the page's way forward either, and the walk simply stopped.
    //
    // <select> is deliberately excluded - its textContent is the whole option list.
    const tag = el.tagName;
    const roleAttr = (el.getAttribute("role") || "").toLowerCase();
    const buttonish = tag === "BUTTON" || tag === "A" || tag === "SUMMARY"
      || roleAttr === "button" || roleAttr === "link";
    if (buttonish) {
      const visible = (el.textContent || "").trim();
      if (visible) return visible;
    }
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
    // 2d) THE QUESTION A CHOICE ROW IS ASKING. Miami puts it in a bare <span> at the head
    //     of the row — "Is this request for a capital construction project for the City of
    //     Miami? (Yes / No)" — and no heading rule can see a <span>. Without it the planner
    //     gets three Yes/No pairs on one page with nothing to tell them apart. Restricted to
    //     radios and checkboxes, and to text that actually reads as a question.
    {
      const t2 = el.tagName.toLowerCase();
      const ty2 = (el.getAttribute("type") || "").toLowerCase();
      if (t2 === "input" && (ty2 === "radio" || ty2 === "checkbox")) {
        const row = el.closest("li, .form-group, [class*='form-group'], div");
        if (row) {
          for (const cand of Array.from(row.querySelectorAll("span, p, label, div"))) {
            const t = clean(cand.textContent);
            if (t.length >= 15 && /\?/.test(t)) return t;
          }
        }
        // A GROUP HEADING IS NOT ALWAYS AN <h*>. Miami's work-item list is
        //     <div class="cldvSeparatorSNoB">ROOF NEW OR REPLACE</div><ul><li>…FLAT ROOF…
        // so the checkboxes underneath read as bare trade names with nothing to say which
        // trade they belong to — and for a SOLAR permit the roofing group is precisely the
        // one not to tick. Choice controls only, and only a short text-only element with no
        // controls of its own, which is what a heading looks like when it is a div.
        let node: Element | null = el.closest("li, tr, .form-group") ?? el;
        for (let hops = 0; node && hops < 4; hops++) {
          let sib: Element | null = node.previousElementSibling;
          while (sib) {
            const t = clean(sib.textContent);
            if (t.length >= 3 && t.length <= 60 && !sib.querySelector("input, select, textarea")) return t;
            sib = sib.previousElementSibling;
          }
          node = node.parentElement;
        }
      }
    }
    // 3) The active wizard-step / stepper label (page-level "which step are we on").
    const active = document.querySelector('.wizard-step.active, .step.active, [aria-current="step"], [class*="stepper"] [class*="active"], [class*="wizard"] [class*="active"]');
    if (active && clean(active.textContent)) return clean(active.textContent);
    return "";
  }

  // THE ONE ACTIVE SCOPE, READ (not re-decided) — markActiveScopeInPage stamped it just
  // before this ran. Null on an ordinary page and inside a child frame (the marker lives in
  // the main document); extractAllFrames stamps frame fields from the frame ELEMENT's
  // position instead. The literal selector is repeated here because this function is
  // serialized into the page and cannot close over ACTIVE_SCOPE_CSS.
  const scopeEl = document.querySelector('[data-al-activescope="1"]');

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

    // Set when a dropdown widget's visible caption is the only real name this control has.
    let widgetLabel = "";
    // A HIDDEN INPUT INSIDE A DROPDOWN WIDGET IS A DROPDOWN — no ARIA required.
    //
    // Miami's Job Category, the page that stops the walk with "Please select mandatory Job
    // Category", is a Telerik dropdown: a visible <div class="t-widget t-dropdown"> showing
    // "Please select a Job Category...", and behind it <input id="JobCategoryID"
    // style="display:none" type="text"> holding the id the form posts. The tag check calls
    // that a TEXT field, applyFill's fill() throws on a hidden input, and the value drops in
    // silence — the same failure the ARIA case above was written for, on a widget family
    // (Telerik/Kendo) that predates ARIA and is everywhere in government portals.
    //
    // Tightly gated so this cannot sweep up ordinary hidden state: the input must be hidden,
    // it must sit inside something NAMED like a dropdown, and that container must be showing
    // a value — which is what makes it a control a person can see and use.
    if (tag === "input" && (fieldType === "text" || fieldType === "other")) {
      const style = el.getAttribute("style") || "";
      const hidden = /display\s*:\s*none/i.test(style) || (el as HTMLElement).offsetParent === null;
      if (hidden) {
        const wrap = el.closest('[class*="dropdown"], [class*="combobox"], [class*="t-widget"], [class*="k-widget"], [class*="select2"], [class*="chosen"]');
        const face = wrap ? wrap.querySelector('.t-input, .k-input, [class*="-input"], [class*="dropdown-wrap"], [class*="rendered"]') : null;
        if (wrap && face && (face as HTMLElement).offsetParent !== null) {
          fieldType = "select";
          // THE NAME ATTRIBUTE IS NOT A LABEL. Left as-is this field reaches the planner as
          // "JobCategoryID"; the words a person reads — "*Job Category" — are in a sibling
          // of the widget's container, which no label rule looks at. Only consulted when the
          // label we have is the id/name, so a real label always wins.
          const current = labelFor(el);
          const nameOrId = (el.getAttribute("name") || el.getAttribute("id") || "").trim();
          if (!current || current === nameOrId) {
            let node: Element | null = wrap;
            for (let hops = 0; node && hops < 3; hops++) {
              let sib: Element | null = node.previousElementSibling;
              while (sib) {
                const t = (sib.textContent || "").replace(/\s+/g, " ").trim();
                if (t && t.length <= 60 && !sib.querySelector("input, select, textarea")) {
                  widgetLabel = t.replace(/^[*\s]+/, "");
                  break;
                }
                sib = sib.previousElementSibling;
              }
              if (widgetLabel) break;
              node = node.parentElement;
            }
          }
        }
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
    let rawLabel = labelFor(el);
    // A FRAMEWORK-GENERATED ID IS NOT A LABEL. Angular Material (and CDK/Ionic) name their
    // generated wrappers "mat-button-toggle-group-2", "cdk-overlay-4" — ids that look like
    // labels to any label-shaped lookup but tell a planner nothing. ComEd's new-application
    // drawer offers exactly two choices, "Distributed Generation" and "Distributed Generation
    // Rebates", and the learn clicked one blind as "mat-button-toggle-group-2" because that
    // was the only name it had. When the label is one of these, use the control's own visible
    // text instead — which is what a person reads.
    if (/^(mat|cdk|ng|ion|p|v)-[a-z-]*\d+$/i.test(rawLabel.trim())) {
      const ownText = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (ownText && ownText.length <= 80) rawLabel = ownText;
    }
    // A generic prompt ("Please select…", "Qty") on a widget that carries a data-test identity is
    // less useful to the planner than the identity itself (which disambiguates e.g. the inverter
    // Qty from a PV-array Qty) — prefer the test hint in that case; otherwise keep the real label.
    const genericLabel = /^(please\s+)?select\.{0,3}$|^select$|^qty$|^\s*$/i.test(rawLabel);
    const label = widgetLabel || ((genericLabel && testHint) ? testHint : (rawLabel || testHint || ""));
    const name = el.getAttribute("name") || undefined;
    const placeholder = el.getAttribute("placeholder") || undefined;
    const id = el.getAttribute("id") || undefined;
    // <a> elements have ARIA role "link", not "button", even though we treat them as
    // button-type fields for extraction. Use "link" so Playwright's getByRole locator
    // resolves correctly; explicit [role="button"] overrides this.
    const role = el.getAttribute("role") || (tag === "a" ? "link" : fieldType === "button" ? "button" : undefined);
    // AN ICON BUTTON'S TEXT IS NOT ITS NAME. Icon fonts render by LIGATURE, so a Material
    // icon button's textContent is literally "add" / "search" / "filter_list" while the name
    // a person (or a screen reader) sees lives in aria-label. Recording the ligature makes a
    // useless selector: ComEd's interconnection portal is icon-only, and its first learn
    // died clicking getByRole('button', { name: 'add' }) even though the planner had
    // correctly read "New Application Button. This will open a popup drawer." from the
    // aria-label. Prefer the aria-label whenever the visible text is a bare ligature-shaped
    // token, or the element is marked as an icon.
    const iconish = (e: Element): boolean => {
      const cls = `${e.className ?? ""} ${(e.querySelector("i, span, svg")?.className ?? "")}`;
      return typeof cls === "string" && /material-(icons|symbols)|mat-icon|glyphicon|\bfa-|\bicon\b/i.test(cls);
    };
    const rawText = (el.textContent || "").trim();
    const ariaName = el.getAttribute("aria-label")?.trim() || "";
    const ligatureShaped = /^[a-z][a-z0-9_]{1,24}$/.test(rawText); // one lowercase token, no spaces
    const buttonText = ariaName && (ligatureShaped || !rawText || iconish(el)) ? ariaName : rawText;
    const text = fieldType === "button" ? buttonText || undefined : undefined;
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

    out.push({
      label, fieldType, options, role, name, placeholder, id, text, href,
      required: required || undefined,
      section: sectionFor(el) || undefined,
      testCss,
      ariaLabel: el.getAttribute("aria-label")?.trim() || undefined,
      inActiveScope: scopeEl ? scopeEl.contains(el) : undefined,
      offstage: scopeEl ? !!el.closest('[aria-hidden="true"], [inert]') : undefined,
      // IS THIS CONTROL OPERABLE? :disabled is the primary test rather than the .disabled
      // PROPERTY because the pseudo-class also catches a control inside <fieldset disabled>,
      // which the property misses entirely — and a gated wizard step is very often a whole
      // disabled fieldset. aria-disabled covers the div-with-role=button case (a real
      // <button> is never what an SPA design system ships), and the class token covers
      // Bootstrap's <a class="btn disabled">, which has no attribute at all.
      disabled: (() => {
        try { if (el.matches(":disabled")) return true; } catch { /* :disabled unsupported on this node */ }
        if (el.getAttribute("aria-disabled") === "true") return true;
        const cls = el.getAttribute("class") || "";
        return /(^|\s)disabled(\s|$)/.test(cls) ? true : undefined;
      })(),
    });
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
  // Carried, not derived: the terminal-page classifier counts ENABLED forward controls, and a
  // `disabled` that stops at the RawField boundary would make every gated Next invisible to it.
  if (raw.disabled) field.disabled = true;
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
  /** The control's own `accept` list, verbatim (".docx, .xlsx, .pdf" or "application/pdf").
   *  Empty when the portal declares none, which means "anything". */
  accept: string;
}

// Serializable in-page detector for document-upload controls. Runs via page.evaluate.
// Universal: handles native <input type=file> AND custom "Browse"/"Upload"/"Choose File"
// widgets (PowerClerk, Telerik/Kendo, jQuery-file-upload) whose real input is created only
// when the trigger is clicked — those never appear in the normal field scrape. Each matched
// control is tagged with a data-al-upl attribute so the adapter can locate it deterministically.
// Returns one slot per control with its derived label + required flag. Never throws.
// The certified names a portal's manufacturer dropdown actually lists, for a plan-set
// make. PowerClerk (and friends) load equipment dropdowns from the CEC listing, whose legal
// names rarely match what a plan set prints — "ZNShine Solar" is listed as "Znshine
// PV-Tech". The learner has always applied these; REPLAY did not, so a recorded
// manufacturer select silently selected nothing, and because a select that lands nothing
// returns false rather than throwing, the step was SKIPPED in silence. On PowerClerk that
// also strands the array's dependent fields (Tilt/Azimuth never render), so one unmatched
// name took out the whole equipment section.
//
// MAKES ONLY, deliberately: a manufacturer is a closed set an alias table can map exactly,
// whereas guessing at a MODEL could select the wrong equipment onto a live interconnection
// application — a silent skip is much the safer failure there.
export function equipmentMakeCandidates(make: string): string[] {
  const raw = String(make ?? "").trim();
  if (!raw) return [];
  const compact = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  return [...new Set([raw, ...(EQUIPMENT_MAKE_ALIASES[compact] ?? [])])];
}

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
    slots.push({ key, label: deriveLabel(el), kind: "input", required: isRequired(el), accept: el.getAttribute("accept") || "" });
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
    // A browse TRIGGER has no accept of its own; borrow one from a file input in the same
    // container if the portal put it there, else leave it open.
    const nearInput = container ? container.querySelector('input[type="file"]') : null;
    slots.push({ key, label: deriveLabel(el), kind: "browse", required: isRequired(el), accept: nearInput ? (nearInput.getAttribute("accept") || "") : "" });
  }

  return slots;
}

/** @param pagesWalked HOW FAR THE WALK ACTUALLY GOT. This was hardcoded to 0, so every failed
 *  learn reported zero pages however far it had walked — and scoreLearnOutcome picks the rung
 *  FROM pageCount, so a run that reached a form and then failed was scored "authenticated, no
 *  way into an application was found". Measured: Miami walked seven pages, hit the repeat-page
 *  stop, and its row said 0 pages and no way in. The row described a run that never happened.
 *
 *  Every in-walk failure passes its real count now; the paths that genuinely have not started
 *  a walk keep the 0 default. */
function fail(
  steps: RecipeStep[],
  portalName: string,
  message: string,
  pauseReason: string | null = null,
  pagesWalked = 0,
  // What the portal itself printed during the walk. A failure that can quote the portal's
  // own words ("Property Address not found.") is a failure an operator can act on; the same
  // failure without them reads as a portal defect and gets triaged as one.
  notices: string[] = [],
): LearnResult {
  return {
    ok: false,
    portalName,
    steps,
    reviewScreen: { fields: [], bodyTextSnippet: "" },
    finalSubmitRecorded: steps.some((s) => s.isFinalSubmit === true),
    pageCount: pagesWalked,
    pauseReason,
    message: notices.length ? `${message} 📣 The portal reported: ${notices.slice(0, 5).join(" | ")}` : message,
    portalNotices: notices.length ? notices.slice(0, 5) : undefined,
  };
}

export class AutoLearnAdapter extends BasePortalAdapter {
  portalName: string;
  private page: Page | null = null;
  /** Accept a cookie banner that offers NOTHING BUT an acceptance. Declining is always tried
   *  first; this only governs the residual. Off unless the operator turns it on, because
   *  consenting on their behalf is theirs to authorise — and it never applies to a CAPTCHA,
   *  which is refused whatever this says. */
  private allowConsentAccept: boolean;
  private maxPages: number;
  /** Wall-clock deadline (epoch ms) after which the page walk stops itself. See budgetMs. */
  private deadlineAt = 0;
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
  /** Field keys a replay can resolve; empty means "do not validate". */
  private bindableFields: Set<string>;
  // Who and where this project is, for choosing between versions of an address on a
  // disambiguation grid. Not fill data — identity used to REJECT another property's row.
  private siteIdentity: { city?: string; zip?: string; homeownerName?: string; isElectrical?: boolean } | undefined;
  // Operator delegation for the final submit, honoured only alongside PORTAL_ALLOW_FINAL_SUBMIT=1.
  private allowFinalSubmit = false;
  // Tri-state on purpose: false means the project SAYS there is no battery (guard it),
  // undefined means nobody knows and the planner still decides.
  private hasBattery: boolean | undefined;
  /** The permit discipline this run is filing ("electrical", "structural", …). Empty when
   *  the caller didn't say — the record-type guard then only checks label-vs-control. */
  private permitDiscipline = "";
  /** True once the delegated final submit actually went through. Read by the caller. */
  finalSubmitClicked = false;
  /** The completion/receipt page as text + URL, captured while standing on it. */
  finalSubmitPageText = "";
  finalSubmitUrl = "";
  // A grid is chosen once per run; re-choosing on a re-scrape would re-click the row.
  private addressRowChosen = false;
  /** One programme choice per run — a drawer re-opened later must not re-pick. */
  private programChosen = false;
  private equipment: Record<string, string>;
  private certifiedAliases: Record<string, string[]>;
  private contactIdentity: ContactIdentity = {};
  private siteContactIdentity: ContactIdentity = {};
  // Attach keys used this RUN (pathname::slotLabel::file) - see the duplicate-row guard.
  private attachedKeys = new Set<string>();
  // Set once the APPLICANT contact has been filled with the contractor identity.
  private acaApplicantFilled = false;
  /** Record-type categories already expanded this run, so a category that reveals nothing
   *  useful is not retried. */
  private readonly acaTypeCategoriesTried = new Set<string>();

  /** Entry controls already clicked this run. An entry that opens a drawer in place leaves
   *  the page looking unchanged, which otherwise invites clicking it again. */
  private readonly entryLabelsClicked = new Set<string>();
  /** `pathname::label` for every navigate/entry control clicked this run. Re-clicking the
   *  SAME control while still on the SAME page is a loop by definition — it cannot be
   *  forward progress. Keyed by path so a label that legitimately recurs on a LATER page
   *  ("Continue" on a multi-step wizard) is still allowed. */
  private readonly navClicksByPath = new Set<string>();
  // Equipment fields whose select verification failed for EVERY candidate this
  // run — retrying them each rescan pass just burns waitForOptionReady caps.
  private equipmentFillFailed = new Set<string>();

  constructor(
    portalName: string,
    private planner: LearnPlanner,
    private options: {
      maxPages?: number;
      /** See allowConsentAccept: accept a cookie banner offering nothing but an acceptance. */
      allowConsentAccept?: boolean;
      /**
       * WALL-CLOCK BUDGET FOR THE PAGE WALK, IN MILLISECONDS.
       *
       * A caller that gives up on the promise does NOT stop this run: it keeps walking
       * pages, holding a browser profile and spending LLM calls, invisible to whoever
       * stopped waiting. Measured on 2026-09-04 — a benchmark capped at 400s left one
       * portal running 1220s, straight through the next two portals' turns, and all
       * three then "timed out". One abandoned run cost three measurements.
       *
       * So the budget belongs INSIDE the walk. On expiry the loop breaks like any other
       * exit: the recipe, the page count and the debug bundle are all real and the
       * caller gets a result describing how far it actually got, rather than silence.
       */
      budgetMs?: number;
      autoSubmit?: false;
      docsByType?: Record<string, string>;
      beforeUpload?: (docType: string, file: string) => void;
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
      /** The field keys a REPLAY can actually resolve (Object.keys of
       *  resolveRecipeFieldValues). The planner CHOOSES the field a fill binds to, and a
       *  key it invents — or one that exists only in the planner's own richer map —
       *  resolves to "" on every replay, forever, and the step is skipped in silence.
       *  When supplied, a binding outside this set is refused and the literal actually
       *  filled is recorded instead, so the step still fills. Empty/omitted = no
       *  validation (byte-identical to the previous behaviour). */
      bindableFields?: string[];
      /** City/ZIP/owner of the project, so a row for someone else's property is refused. */
      siteIdentity?: { city?: string; zip?: string; homeownerName?: string; isElectrical?: boolean };
      /** Operator delegation: click the recorded final submit instead of leaving it. */
      allowFinalSubmit?: boolean;
      /** Whether the PROJECT says a battery exists. false = guard against declaring one. */
      hasBattery?: boolean;
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
    this.bindableFields = new Set(options.bindableFields ?? []);
    this.siteIdentity = options.siteIdentity;
    this.allowFinalSubmit = options.allowFinalSubmit === true;
    this.hasBattery = options.hasBattery;
    this.equipment = options.equipment ?? {};
    this.certifiedAliases = options.certifiedAliases ?? {};
    this.contactIdentity = options.contactIdentity ?? {};
    this.siteContactIdentity = options.siteContactIdentity ?? {};
    // Default page budget. Multi-step utility/permit wizards (PowerClerk NEM, Accela)
    // routinely run 10-15 input steps before the review screen, so 8 was too low — it
    // capped out mid-form. The stuck-page guard + review detection bound the loop, so a
    // higher cap can't run away; it just allows long wizards to reach review.
    this.maxPages = options.maxPages ?? 18;
    this.allowConsentAccept = options.allowConsentAccept ?? process.env.PORTAL_ACCEPT_COOKIE_BANNER === "1";
    // 0 = no deadline (the default everywhere except the benchmark and any caller that
    // must bound its own wall clock).
    this.deadlineAt = options.budgetMs && options.budgetMs > 0 ? Date.now() + options.budgetMs : 0;
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
        // A DATA-TEST HOOK BEATS A PER-RENDER ID, and this is the case that proves it.
        //
        // PowerClerk renders the inverter's Manufacturer/Model and the PV array's with
        // identical bare labels, so this branch fires and pins the step to whatever css
        // fallback comes first — which was the element id. Those ids are per-render tokens:
        // #pcInputBase34 pointed at a different, concealed control on the next project, and
        // the replayed step spent months resolving it. The same element carries
        // `data-test-role="inverter-model-select"`, which is stable AND says which side it
        // belongs to. Prefer it whenever it is there; fall back to the id only when it is not.
        const fbs = field.selector.fallbacks ?? [];
        const hookFb = fbs.find((fb) => typeof fb.css === "string" && /^\[data-(testid|test-role|test|cy|qa)=/.test(fb.css));
        const cssFb = hookFb ?? fbs.find((fb) => fb.css);
        // With a stable hook the occurrence pin is unnecessary — and harmful, because an
        // ordinal recorded against one render is a guess about the next.
        const labelFb = hookFb
          ? [{ label: field.label, ...frame }]
          : [{ label: field.label, nth: occurrence, ...frame }];
        target = cssFb?.css
          ? { ...field, selector: { css: cssFb.css, ...frame, fallbacks: labelFb } }
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

  private resolveUpload(field: ExtractedField, required = true, accept = ""): { docType: string; file: string } | null {
    const label = field.label || "";
    const cap = this.uploadMaxBytes();
    // A candidate must fit the size cap AND be a type this control accepts. Folding the type
    // test into fits() means every fallback tier below inherits it — including the
    // last-resort tiers, which are exactly the ones that used to file a ZIP into a PDF slot.
    // A slot that refuses the image but takes a PDF is still fillable — the photo just has to
    // travel as a PDF. PacifiCorp asks for a photo of the meter and accepts only .docx/.pdf.
    const fits = (docType: string) => Boolean(this.docsByType[docType])
      && this.fileFits(this.docsByType[docType], cap)
      && (fileTypeAllowed(this.docsByType[docType], accept)
        || shouldConvertToPdf(this.docsByType[docType], accept, false));
    // Applications, compliance checklists and sealed letters cannot be supplied
    // by a plan-set fallback, in either upload mode. Record only the exact type
    // so learning cannot teach replay to repeat a substitute indefinitely.
    const namedType = UPLOAD_LABEL_PATTERNS.find(({ re }) => re.test(label))?.docType;
    if (uploadForbidsSubstitute(label)) {
      if (namedType && fits(namedType)) return { docType: namedType, file: this.docsByType[namedType] };
      this.debug?.event({ type: "upload_no_substitute", label: label.slice(0, 60) });
      return null;
    }
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
    // A slot that NAMES a document we cannot produce (insurance, invoice, W-9, a
    // commissioning settings photo) takes no substitute, required or not. Filing the plan
    // set there would look complete to us and read as nonsense to the reviewer; leaving it
    // empty lets the required-field sweep report it and a human attach the real file.
    if (uploadForbidsSubstitute(label)) {
      this.debug?.event({ type: "upload_no_substitute", label: (label || "").slice(0, 60) });
      return null;
    }
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
  private resolveUploadByLabel(label: string, required = true, accept = ""): { docType: string; file: string } | null {
    return this.resolveUpload({ selector: {}, label, fieldType: "file" }, required, accept);
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
      // A FULL-PAGE SHOT OF A LONG PAGE IS NOT A USABLE IMAGE.
      //
      // The vision API refuses any image over 8000px on a side. Prince George's County's
      // Momentum dashboard renders 800 x 22148 — nearly three times the limit — so the
      // planner call failed outright with a 400 and the page was planned with NO vision at
      // all. The learn then reported "nothing fillable", which reads as a portal the engine
      // cannot handle rather than an image it never managed to send. Any long application
      // form hits this; it is not a Momentum quirk.
      //
      // So: clip to a tall-but-legal window rather than send nothing. The top of a portal
      // page is where the form and its controls live; the 22,000px below it is a paginated
      // records table the planner has no use for. A clipped screenshot beats no screenshot,
      // and both beat a failed request.
      const MAX_EDGE = 7800; // a little under the 8000 limit, for device-pixel rounding
      const dims = await this.page.evaluate(() => ({
        w: Math.max(document.documentElement?.scrollWidth || 0, window.innerWidth || 0),
        h: Math.max(document.documentElement?.scrollHeight || 0, window.innerHeight || 0),
      })).catch(() => null);
      const tooTall = !!dims && dims.h > MAX_EDGE;
      const tooWide = !!dims && dims.w > MAX_EDGE;
      if (tooTall || tooWide) {
        const buf = await this.page.screenshot({
          type: "png",
          clip: { x: 0, y: 0, width: Math.min(dims!.w, MAX_EDGE), height: Math.min(dims!.h, MAX_EDGE) },
        });
        this.debug?.event({ type: "plan_screenshot_clipped", pageSize: `${dims!.w}x${dims!.h}`, clippedTo: `${Math.min(dims!.w, MAX_EDGE)}x${Math.min(dims!.h, MAX_EDGE)}` });
        return Buffer.from(buf as Buffer).toString("base64");
      }
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
    // ONE ACTIVE SCOPE PER PAGE, resolved ONCE per harvest and marked in the DOM so every
    // reader below (and advanceSignatureOf) sees the same answer. Fails open: if the
    // evaluate throws mid-navigation we harvest the whole document, exactly as before.
    const scope = await resolveActiveScope(this.page);
    const scopeActive = scope.marked;

    const out: RawField[] = [];
    let frames: Frame[] = [];
    try { frames = typeof this.page.frames === "function" ? this.page.frames() : []; } catch { frames = []; }
    const main = typeof this.page.mainFrame === "function" ? this.page.mainFrame() : null;
    for (const frame of frames) {
      let frameKey: string | undefined;
      // A CHILD FRAME CANNOT SEE THE MARKER — it lives in the main document, so
      // extractFieldsInPage running inside the frame finds no scope and stamps nothing.
      // Decide the frame's scope membership from its <iframe> ELEMENT instead. Undefined
      // means "no scope on this page"; true/false is stamped over the frame's fields below.
      // Accela renders its contact/upload dialogs inside ACADialogFrame, so a frame whose
      // element sits INSIDE the open panel must keep its fields — dropping every framed
      // field whenever a panel is open would break that pattern outright.
      let frameInScope: boolean | undefined;
      let frameOffstage: boolean | undefined;
      if (main && frame !== main) {
        try {
          const el = await frame.frameElement();
          if (scopeActive) {
            frameInScope = await el.evaluate((n: Element) => !!n.closest('[data-al-activescope="1"]')).catch(() => true) as boolean;
            frameOffstage = await el.evaluate((n: Element) => !!n.closest('[aria-hidden="true"], [inert]')).catch(() => false) as boolean;
          }
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
        for (const r of raws) {
          if (frameKey) r.frame = frameKey;
          if (frameInScope !== undefined) { r.inActiveScope = frameInScope; r.offstage = frameOffstage; }
          out.push(r);
        }
      } catch { /* detached frame — skip */ }
    }
    // Safety net: if frame enumeration yielded nothing (e.g. a fake/stub page in tests, or an
    // older runtime), fall back to a direct main-document scrape so the loop still sees fields.
    if (!out.length) {
      try { out.push(...(await this.page.$$eval(extractSel, extractFieldsInPage))); } catch { /* ignore */ }
    }
    const scoped = applyActiveScopeFilter(out, scopeActive);
    if (scopeActive && (scoped.dropped || scoped.exempted.length)) {
      this.debug?.event({
        type: "active_scope",
        panel: scope.tag,
        fillables: scope.fillables,
        kept: scoped.fields.length,
        dropped: scoped.dropped,
        // Named so a trace can show WHICH exits the panel did not own — the reviewer's
        // vocabulary for the lost-advance bug was exactly "inActiveScope=false".
        exempted: scoped.exempted.slice(0, 5),
      });
    }
    return scoped.fields;
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
  // The labels of the upload slots currently ON the page. Only EMPTY slots have a file
  // input, so this set shrinks as documents attach and grows when the page reveals more —
  // which is why the caller watches for new LABELS rather than a bigger count.
  private async uploadSlotLabels(): Promise<string[]> {
    if (!this.page || typeof this.page.evaluate !== "function") return [];
    try {
      const slots = await this.page.evaluate(tagUploadControls);
      return Array.isArray(slots) ? slots.map((s) => (s.label || "").trim().toLowerCase()).filter(Boolean) : [];
    } catch { return []; }
  }

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

    // "NO UPLOAD SLOTS" ONLY MEANS SOMETHING ONCE THE PAGE HAS SETTLED.
    //
    // PowerClerk paints its controls late. Measured on Ivy's PacifiCorp NEM: the upload phase
    // returned zero slots in TEN MILLISECONDS on every page including the one that carries
    // "Upload a photo of meter where system will be interconnected" — a slot a probe finds
    // reliably on the same application seconds later. The utility then rejected the filing for
    // that exact field. An empty first look is indistinguishable from a page that has no
    // uploads, which is why this went unnoticed through five runs.
    //
    // So an empty result is re-checked after a settle. A page that genuinely has no uploads
    // pays one wait; a page whose controls are still arriving gets seen.
    const tagSlots = async (): Promise<UploadSlot[]> => {
      try {
        const s = await this.page!.evaluate(tagUploadControls);
        return Array.isArray(s) ? s : [];
      } catch { return []; }
    };
    let slots: UploadSlot[] = await tagSlots();
    if (slots.length === 0) {
      await this.waitForDynamicFieldsSettle().catch(() => null);
      await sleep(1500);
      slots = await tagSlots();
      if (slots.length > 0) {
        this.debug?.event({ type: "upload_slots_late", count: slots.length, labels: slots.map((s) => s.label).join(" | ").slice(0, 160) });
      }
    }
    if (slots.length === 0) return { filled, missingRequired, attached };

    // Attach keys already used THIS RUN. Per-visit scoping is not enough: Accela serves
    // every wizard step from the same CapEdit.aspx and the loop re-enters it many times,
    // so a per-visit set still re-attached the file on each pass (live: 3 pending rows of
    // one PDF). Key = pathname + slot label + file, so a labeled slot on another page can
    // still receive the same combined document.
    let pathKey = "";
    try { pathKey = new URL(String(this.page.url?.() ?? "")).pathname.toLowerCase(); } catch { pathKey = ""; }
    for (const slot of slots) {
      const resolved = this.resolveUploadByLabel(slot.label, !!slot.required, slot.accept || "");
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
      // WRAP A PHOTO THE SLOT WILL NOT TAKE AS AN IMAGE. Only the container changes: one
      // page, the photograph at its own size. Done here rather than at resolve time so the
      // recorded docType still says meter_photo — what was sent is still the meter photo.
      const needsPdf = shouldConvertToPdf(resolved.file, slot.accept || "", fileTypeAllowed(resolved.file, slot.accept || ""));
      const converted = needsPdf
        ? await imageToPdfBytes(resolved.file).then((buf) => ({ buf })).catch((e) => {
            this.debug?.event({ type: "image_to_pdf_failed", why: String(e).slice(0, 120) });
            return null;
          })
        : null;
      if (converted) {
        this.debug?.event({ type: "image_to_pdf", docType: resolved.docType, accept: (slot.accept || "").slice(0, 60) });
      }
      const uploadPayload = (() => {
        const base = path.basename(resolved.file);
        const clean = base.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "");
        if (converted) {
          return { name: pdfNameFor(clean || base), mimeType: "application/pdf", buffer: converted.buf };
        }
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
            this.options.beforeUpload?.(resolved.docType, resolved.file);
            await loc.setInputFiles(uploadPayload ?? resolved.file);
          } else {
            // Custom widget — the real <input> is created on click, so intercept the
            // browser's file-chooser dialog (works for ANY uploader, no DOM coupling).
            const [chooser] = await Promise.all([
              this.page!.waitForEvent("filechooser", { timeout: 8000 }),
              this.page!.locator(selector.css!).click({ timeout: 6000 }),
            ]);
            this.options.beforeUpload?.(resolved.docType, resolved.file);
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
        // A FAILED NAVIGATION MUST NOT BE REPORTED AS A LOGIN PROBLEM.
        //
        // This swallowed the error and carried on, so a host that never answered was judged
        // by whatever was on the blank page — always "could not find a login form", which
        // reads as a detector defect. Live: www4.citizenserve.com timed out and
        // www.gosolarapp.org returned 403, and the benchmark scored both as engine failures.
        // Two of five portals mis-blamed is enough to send a day's work the wrong way.
        //
        // The catch stays, because a slow single-page portal routinely misses
        // domcontentloaded and then renders perfectly well. So the error is only fatal when
        // the page really is empty — nothing to read and nothing to click.
        let navError = "";
        await this.page.goto(context.startUrl, { waitUntil: "domcontentloaded", timeout: 30000 })
          .catch((err: unknown) => { navError = String((err as Error)?.message || err).slice(0, 200); return null; });
        await smartWait(this.page);

        // A STORED URL THAT LANDS ON FACEBOOK IS NOT A PORTAL, AND LEARNING IT IS WORSE THAN
        // FAILING. Live in the 59-portal learn benchmark: snohomishcountywa.gov redirected to
        // www.facebook.com/SnohomishCountyWA, and the learn walked it as a permit portal --
        // 112 form fields, 42 of them fillable, a navigation plan, and a recipe row at the
        // end of it. Nothing about that is recoverable at replay: the recipe would drive a
        // social network on every future filing for that jurisdiction.
        //
        // Named hosts only, and only the ones that cannot be a permit portal under any
        // reading. A city that genuinely runs its permitting on some unexpected domain must
        // still be learnable, so this refuses to guess from shape -- it refuses from a list.
        {
          const landedHost = await this.page.evaluate(() => location.hostname.toLowerCase()).catch(() => "");
          const NOT_A_PORTAL = /(^|\.)(facebook|instagram|twitter|x|linkedin|youtube|tiktok|pinterest|reddit)\.com$/;
          if (landedHost && NOT_A_PORTAL.test(landedHost)) {
            this.debug?.event({ type: "not_a_portal", host: landedHost });
            return {
              ok: false,
              steps: [],
              pageCount: 0,
              message: `The stored URL for this portal lands on ${landedHost}, which is a social network rather than a permitting portal. Nothing was learned; the stored portal URL needs correcting before this jurisdiction can be automated.`,
            } as never;
          }
        }

        if (navError) {
          const landed = await this.page.evaluate(() => ({
            url: location.href,
            text: (document.body?.innerText || "").trim().length,
            controls: document.querySelectorAll("input, button, a, select, textarea").length,
          })).catch(() => null);
          const blank = !landed || landed.url === "about:blank" || (landed.text < 40 && landed.controls < 3);
          if (blank) {
            this.debug?.event({ type: "navigation_failed", startUrl: safeHostPath(context.startUrl), error: navError.slice(0, 120) });
            return { ok: false, message: `${this.portalName} did not load: ${navError}` };
          }
          // Rendered anyway — note it and carry on rather than discarding a usable page.
          this.debug?.event({ type: "navigation_error_recovered", startUrl: safeHostPath(context.startUrl), error: navError.slice(0, 120) });
        }
      }

      // Log in via the shared, portal-agnostic login flow. It detects/reveals the login
      // form, fills it (known + unknown portals), verifies success, and stops on MFA.
      // Never logs credentials.
      const result = await performLogin(this.page, context.credential);
      // Status + redacted message only — performLogin never returns credentials.
      this.debug?.event({ type: "login", status: result.status, startUrl: context.startUrl ? safeHostPath(context.startUrl) : null });
      // A LOGIN FAILURE MUST LEAVE BEHIND THE PAGE IT FAILED ON.
      //
      // The 2026-09-04 baseline reported four portals as "the portal's login form was not
      // recognised" and their bundles held nothing but that sentence — no markup, no
      // screenshot, nothing to argue with. Diagnosing them meant driving all four live
      // again, and the answers were not one bug but four: one portal had no login at all,
      // one hid it in a closed dropdown behind an icon, one served an SSO stub that never
      // forwarded, and one was probably a contaminated browser profile.
      //
      // Every one of those was legible in the page itself. Capturing it turns the next such
      // failure into an offline read of a fixture instead of a live sweep, and the captures
      // become the fixtures the DOM smokes run against. Best-effort and non-throwing: a
      // diagnostic must never be able to change the outcome it is diagnosing.
      if (result.status !== "logged_in" && result.status !== "already_authenticated" && result.status !== "no_login_required") {
        // WHAT WAS TRIED, not only what happened. Wilsonville's bundle held the verdict and
        // nothing else, and the captured page proved its login control was present — leaving
        // three different bugs behind one indistinguishable symptom.
        this.debug?.event({ type: "login_reveal_trail", steps: lastRevealTrail(this.page).slice(0, 20) });
        await this.debug?.capturePageHtml(this.page, `login-${result.status}`).catch(() => {});
        await this.debug?.screenshot(this.page, `login-${result.status}`).catch(() => {});
      }
      if (result.status === "logged_in" || result.status === "already_authenticated" || result.status === "no_login_required") {
        // no_login_required: the jurisdiction publishes its application directly, with no
        // account to sign in to. Proceeding is the correct outcome, not a fallback — the
        // form is already in front of us.
        return { ok: true, message: `Opened ${this.portalName} for autonomous learning. ${result.message}` };
      }
      if (result.status === "mfa_captcha") {
        return { ok: false, message: result.message, pauseReason: "mfa_captcha" };
      }
      if (result.status === "no_credential") {
        // NAME THE PORTAL IT NEEDED. "No credential for this client/portal" sent an operator
        // hunting a phantom bug: the client had 83 stored logins including one for Oregon
        // ePermitting, and the message never said the page in front of it was City of
        // Portland's own DevHub — a different system needing its own account. Which host was
        // asked for is the whole answer, so it goes in the message.
        const host = context.startUrl ? safeHostPath(context.startUrl).split("/")[0] : "";
        const at = host ? ` at ${host}` : "";
        return { ok: false, message: `${this.portalName}${at} is showing a login page but no stored credential was found for THIS portal. Add the username + password for ${host || "this portal"} under the client's logins, then retry. A login saved for a different portal is never reused — jurisdictions on the same platform still use separate hosts and accounts. (Or run \`npm run portal:login\` once to establish a persistent session.)` };
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
      // What discipline this run is filing. Held on the instance so the fill guard can refuse
      // a record type that contradicts it — the planner sees one page at a time and does not.
      this.permitDiscipline = String(project.permitType ?? "");
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
    // A FRESH SEARCH IS A FRESH GRID. The ranked chooser latches so it picks once per grid;
    // a recovery re-entry re-runs this search and lands back on the county's default row,
    // and a latch held from the previous grid then leaves it there.
    this.addressRowChosen = false;
    // RANKED FIRST — owner, city/ZIP and discipline together, recorded as a data-al-row
    // marker that replay re-ranks against ITS project's grid.
    //
    // The selector this replaced could not see the row it was aiming at. ACA nests the
    // results grid inside an outer layout table, so tr:has-text("CITY APPLICATIONS") matches
    // BOTH the city's row and the wrapper row containing the whole grid — and the wrapper
    // comes first in document order, so .first() took the wrapper and its first "Select"
    // link, which belongs to the COUNTY row. Live on Marineau's structural filing: the pass
    // reported picking the city row while the page went on showing Coos County's services
    // (Commercial - Electrical, Residential - Electrical), the city's structural type was
    // never on offer, and the run spent twelve pages being refused.
    if (await this.chooseProjectAddressRow(steps)) {
      selected = true;
      await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => null);
    }
    const selectLinks = scope.getByRole("link", { name: /^Select$/i });
    if (!selected && await selectLinks.count().catch(() => 0)) {
      let rows = scope.locator("tr", { hasText: new RegExp(rowText, "i") });
      if (cityUpper) rows = rows.filter({ hasText: cityUpper });
      // Innermost match only: a row whose text runs past a few hundred characters is the
      // wrapper around the whole grid, not one address version.
      const rowLink = await this.leafRowSelectLink(rows) ?? rows.getByRole("link", { name: /^Select$/i }).first();
      const link = (await rowLink.count().catch(() => 0)) ? rowLink : selectLinks.first();
      // Verified action → recorded step: a swallowed click failure recorded anyway
      // leaves a duplicate pair once the planner retakes the page.
      if (!(await link.click({ timeout: 15000 }).then(() => true).catch(() => false))) return bail("address row select click failed");
      // The ROW CONTEXT is baked into the recorded selector — a bare role/name "Select"
      // resolves to .first() at replay and silently files under the wrong jurisdiction.
      steps.push({ action: "click", phase: "fill", selector: { css: `tr:has-text("${rowText}") a:has-text("Select")`, fallbacks: [{ role: "link", name: "Select", exact: true }], ...inFrame }, note: `work location: select ${isElectrical ? "county/electrical" : "city/structural"} address row` });
      selected = true;
    } else if (!selected) {
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

  // The "Select" link of the first LEAF row among a set of matching <tr>s. ACA nests its
  // results grid inside an outer layout table, so a text match on a row also matches the
  // wrapper containing every row — and the wrapper comes first in document order, so a bare
  // .first() reaches for one address version and clicks whichever row happens to lead the
  // grid. A leaf row offers exactly ONE Select; the wrapper offers one per address.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async leafRowSelectLink(rows: any): Promise<any | null> {
    const n = await rows.count?.().catch(() => 0) ?? 0;
    for (let i = 0; i < Math.min(n, 8); i++) {
      const links = rows.nth(i).getByRole("link", { name: /^Select$/i });
      if (await links.count().catch(() => 0) === 1) return links.first();
    }
    return null;
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

  /** Expand a record-type CATEGORY so its types become selectable. Ordered by where a
   *  residential solar permit actually lives: an explicit solar/PV category if the AHJ has
   *  one, then Residential (never "Non Residential"), then Trades — where many counties file
   *  electrical. Clicks at most one category per call; the caller re-extracts and either the
   *  radios appear (record-type pass takes over) or the next call tries the next category. */
  private async accelaExpandRecordTypeCategory(steps: RecipeStep[]): Promise<boolean> {
    const page = this.page;
    if (!page) return false;
    const prefs: RegExp[] = [/solar|photovoltaic|\bpv\b/i, /^residential$/i, /^trades$/i, /^building$/i];
    let labels: string[] = [];
    try {
      labels = await page.evaluate(() => {
        const vis = (el: Element) => { const r = (el as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        return (Array.from(document.querySelectorAll("a")) as HTMLElement[])
          .filter(vis)
          .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
          .filter((t) => t && t.length < 40);
      });
    } catch { return false; }
    for (const pref of prefs) {
      const label = labels.find((l) => pref.test(l) && !/^non[\s-]?residential$/i.test(l) && !this.acaTypeCategoriesTried.has(l));
      if (!label) continue;
      this.acaTypeCategoriesTried.add(label);
      // Exact-text link; ACA renders these as <a> inside the category tree. A category that
      // refuses the click is not fatal — the next call tries the next preference.
      const loc = page.getByRole("link", { name: label, exact: true }).first();
      const ok = await loc.click({ timeout: 8000 }).then(() => true).catch(() => false);
      if (!ok) continue;
      await page.waitForLoadState?.("networkidle", { timeout: 12000 }).catch(() => null);
      await page.waitForTimeout?.(1200).catch(() => null);
      steps.push({
        action: "click",
        phase: "fill",
        selector: { role: "link", name: label, exact: true },
        note: `accela: expand record-type category "${label}"`,
      });
      return true;
    }
    return false;
  }

  // Record-type selection: prefer a solar/PV-specific type when the AHJ offers one,
  // else the discipline's residential type (electrical vs structural — same mapping the
  // hand-coded adapter live-verified: county rows file electrical, city structural).
  // AN ENTRY THAT OPENS A DRAWER MAY ASK WHICH PROGRAMME FIRST.
  //
  // ComEd's Intellio Connect has no "new application" page: a text-less floating action
  // button (identifiable only by aria-label "New Application Button. This will open a popup
  // drawer.") slides a drawer in place. The drawer's first screen is not a form — it is a
  // CHOICE between "Distributed Generation" and "Distributed Generation Rebates" — and the
  // fields appear only after one is picked. A live learn clicked the button, watched the page
  // grow by 32 KB, then reported "found nothing fillable on 3 pages" while standing on the
  // choice with no steps recorded.
  //
  // Which programme is not a judgement call: an interconnection application is not a rebate
  // application, and picking the rebate would file the wrong thing entirely — the same class
  // of error as choosing a permit type by array index. So: prefer an explicitly
  // interconnection/generation-flavoured option, never take a rebate/incentive one, and when
  // nothing matches, leave the drawer alone and say what was offered rather than guessing.
  /**
   * Key for "this control, on this page". Keyed by PATHNAME rather than the whole URL so a
   * query string or fragment that changes as a wizard advances doesn't disguise a re-click,
   * and so a label that legitimately recurs on a genuinely different page stays allowed.
   */
  /** Forget every "already clicked this here" record for one page. Called when something
   *  else on the page has just worked: the guard exists to stop a control being clicked
   *  twice in the SAME state, and the state has changed. */
  private forgetNavClicksOn(pageUrl: string): void {
    let pathname = String(pageUrl ?? "").toLowerCase();
    try { pathname = new URL(pageUrl).pathname.toLowerCase(); } catch { /* compare as given */ }
    for (const key of Array.from(this.navClicksByPath)) {
      if (key.startsWith(`${pathname}::`)) this.navClicksByPath.delete(key);
    }
  }

  private navClickKey(pageUrl: string, label: string): string {
    let pathname = String(pageUrl ?? "").toLowerCase();
    try { pathname = new URL(pageUrl).pathname.toLowerCase(); } catch { /* not a URL — compare as given */ }
    return `${pathname}::${normalizeEntryLabel(label)}`;
  }

  private async chooseApplicationProgram(steps: RecipeStep[]): Promise<boolean> {
    if (!this.page || typeof this.page.evaluate !== "function") return false;
    if (this.programChosen) return false;

    // The scan/ranking live in applicationProgram.ts so the smoke test drives THIS code
    // rather than a copy of it. Scoped by the tightest grouping that offers a real choice —
    // never document-wide, which on ComEd's own page finds the header's category switcher
    // (same label, opens a menu instead of an application).
    const groups = await this.page.evaluate(scanProgramGroups).catch(() => [] as ProgramGroup[]);
    const list = Array.isArray(groups) ? groups : [];
    if (list.length === 0) return false; // no revealed panel offering a choice

    const picked = chooseProgram(list, this.permitDiscipline);
    if (!picked) {
      this.debug?.event({
        type: "application_program_unmatched",
        offered: offeredLabels(list).slice(0, 8).join(" | ").slice(0, 200),
        why: "no option reads as an interconnection/generation application",
      });
      return false;
    }

    const css = `[data-al-prog="${picked.key}"]`;
    const ok = await this.page.locator(css).first().click({ timeout: 10000 }).then(() => true).catch(() => false);
    if (!ok) return false;
    this.programChosen = true;
    await this.waitForDynamicFieldsSettle().catch(() => null);
    this.debug?.event({
      type: "application_program_chosen",
      label: picked.label.slice(0, 60),
      offered: offeredLabels(list).slice(0, 8).join(" | ").slice(0, 160),
    });
    steps.push({
      action: "click",
      phase: "open",
      // Recorded BY LABEL and scoped BY ROLE: the data-al-prog tag is a learn-time marker,
      // a programme chosen by position is the wrong-permit-type mistake in another costume,
      // and a BARE text match collides with the header switcher at replay time.
      selector: programSelector(picked),
      note: `application program: ${picked.label}`,
    });
    return true;
  }

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

    // THE RECORD TYPE IS INSIDE A CATEGORY THAT HAS TO BE OPENED FIRST.
    //
    // Accela's CapType page lists CATEGORY checkboxes (Administration, Residential,
    // Building Project, Non-Residential) above the record-type radios, and a type stays
    // collapsed until its category is ticked. Live on aca-prod/CHINO: "Residential Solar"
    // was extracted and then reported hidden_field_skipped, check() failed with
    // "record-type check/click failed", and the portal answered every advance with "You
    // have not selected a record type." — four times, through two recovery attempts.
    //
    // The category is named by the record type's own leading words, so the control to open
    // is the checkbox whose label is a prefix of it ("Residential" for "Residential Solar").
    // Only a genuine prefix qualifies, so this can never tick an unrelated category.
    // typeof-guarded like every other isVisible call in this file: a stub locator has no
    // such method, and calling it bare threw "loc.isVisible is not a function" — which the
    // enclosing try turned into a silent "record type not handled" rather than an error.
    // Absent the method, assume visible: that is the behaviour from before this category
    // pass existed, so a stub falls through to it rather than into a path meant for a
    // collapsed Accela category.
    const chosenVisible = typeof loc.isVisible === "function"
      ? await loc.isVisible().catch(() => false)
      : true;
    if (!chosenVisible) {
      const wanted = String(chosen.label || "").trim().toLowerCase();
      const category = fields.find((f) => {
        if (f.fieldType !== "checkbox" || f === chosen) return false;
        const cat = String(f.label || "").trim().toLowerCase();
        return cat.length >= 4 && wanted.startsWith(cat) && wanted.length > cat.length;
      });
      if (category) {
        const catLoc = await this.locator(category.selector);
        const opened = catLoc
          ? await catLoc.check({ timeout: 8000 }).then(() => true)
            .catch(async () => catLoc.click({ timeout: 6000 }).then(() => true).catch(() => false))
          : false;
        if (opened) {
          steps.push({ action: "check", phase: "fill", selector: category.selector, note: `record type category: ${(category.label || "").slice(0, 50)}` });
          await this.page?.waitForTimeout?.(1200).catch(() => null);
          this.debug?.event({ type: "record_type_category_opened", category: String(category.label || "").slice(0, 40), forType: String(chosen.label || "").slice(0, 40) });
        }
      } else {
        this.debug?.event({ type: "record_type_hidden_no_category", label: String(chosen.label || "").slice(0, 40) });
      }
    }

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
    // Deterministic "start an application" passes used this run (see b9). Two is enough for
    // a dashboard → apply hop plus one recovery; more would mean the portal keeps bouncing
    // us back, which the stuck/cycle guards should handle instead.
    // HOW MANY TIMES TO GO LOOKING FOR THE WAY IN. Two was enough for a portal whose home
    // page carries an "Apply" tile, and not enough for one that goes home -> department ->
    // permits -> apply. In the 59-portal learn benchmark, EIGHT portals reached a form and
    // filled NOTHING, and their traces put them on a lookup, list or dashboard page planning
    // more navigation: frederickcountymd sat on "Lookup Record" with 99 fillable fields it
    // never touched, peco on /applications, communitycore on /dashboard.
    //
    // Raising this is safe because the gate below is already the strongest one available:
    // the pass only runs while NOTHING has been filled. Once any value is entered it can
    // never fire again, so this cannot restart a wizard mid-flow. Repeats are barred by
    // entryLabelsClicked, records and payment by the finder's own exclusion list, and the
    // page budget still bounds the walk. If we have walked five pages and filled nothing, we
    // are lost, and another look for the way in is exactly what is wanted.
    const ENTRY_PASS_MAX = 4;
    let entryPasses = 0;
    let acaRecordTypeHandled = false;
    // Record-type CATEGORY expansions used this run (ACA CapType tree). Two is enough for
    // Residential then Trades; more means the tree is not the blocker.
    const ACA_TYPE_EXPANSION_MAX = 2;
    let acaTypeExpansions = 0;
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
    // A directive raised by THIS iteration for the NEXT planner call. The stuck/cycle
    // detector only speaks after a fingerprint repeats twice, which is 2-3 planner calls of
    // a 6-page budget; a refusal already knows what went wrong, so it says so immediately.
    let pendingHint = "";
    const MAX_RECOVERY = 3;
    // Validation blockers: collected when an advance click fails to move the page forward
    // (portal blocked the step due to required-field errors). Injected into the recovery hint
    // and surfaced in the final message so the operator can see WHICH fields the portal rejected.
    const validationBlocks: string[] = [];
    let lastValidationErrors: string[] = [];
    // What the PORTAL said, on any page, moved or not — a separate channel from
    // validationBlocks on purpose. validationBlocks means "an advance was blocked"; this
    // means "the portal printed a message at us", which is the only thing that explains a
    // walk that keeps advancing and keeps landing back on the same page.
    const portalNotices: string[] = [];
    // Page signatures the results-row pass has already had its one turn on.
    const rowPickedSigs = new Set<string>();
    // A LIST WITH NOTHING ON IT FOR THIS JOB IS A WRONG TURN UPSTREAM, NOT A STALL.
    //
    // Miami's Job Description offers the work items the permit covers. On a solar PV job it
    // offered FLAT ROOF and SHINGLE ROOF under "ROOF NEW OR REPLACE" — because the Job
    // Category chosen two pages earlier (STAND-ALONE, whose only sub-category was BUILDING
    // ROOFING) put the application in the roofing trade. The planner correctly ticked
    // nothing; the portal said "Please select at least one work item"; and the run reported
    // that it never reached review, which names neither the choice nor the turn that caused
    // it. What the operator needs to read is: here is what the page offered, none of it
    // matches this job, and the branch was taken upstream.
    const unmatchedChoices: string[] = [];
    // Required document-upload slots we detected but had NO matching project file for —
    // surfaced in the final message so the human can attach them before submitting.
    const missingRequiredDocs: string[] = [];
    // Diagnostics: a compact, redacted breadcrumb per page (title + host/path + field
    // counts + classification + the planner's decision). Surfaced in the result message
    // and logs so a "nothing fillable" run is debuggable WITHOUT re-running blind.
    const pageTrace: string[] = [];
    /** How many times each page signature has been walked. See the repeat-stop below. */
    const repeatPageCounts = new Map<string, number>();
    /** Advance controls proven not to move a given page. See the advance_did_nothing event. */
    const deadAdvances = new Map<string, Set<string>>();
    /** The page identity the dead-advance set is keyed on: host+path plus control count, so
     *  the same label on a different page keeps its own chance. */
    const deadPageKey = (u: string, fieldCount: number): string => {
      let hp = "";
      try { const parsed = new URL(u); hp = parsed.host + parsed.pathname; } catch { hp = (u || "").slice(0, 60); }
      return `${hp}|${fieldCount}`;
    };
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
      // And keep the page's own markup, blanked of the operator's data — this is what the
      // offline portal replica is built from (see learnDebug.capturePageHtml).
      await this.debug?.capturePageHtml(this.page, label);
    };

    // Required fields that did NOT hold their value after filling (portal silently dropped them).
    // Surfaced in the final message so the operator re-checks them before a human submits.
    const fillVerifyMisses: string[] = [];
    // The same misses, split by WHY — see the note at verifyFillsLanded's call site.
    const missesDidNotHold: string[] = [];
    const missesNeverFilled: string[] = [];

    // Pathnames already walked this run. Mid-wizard, a planner NAVIGATE back to one of
    // these RESTARTS the flow (live Salem/Accela: from CapHome it clicked a link back to
    // the Apply entry — disclaimer → address → CapHome all over again, burning 3 pages of
    // budget). A navigate whose target was already visited is rejected once any fill has
    // been recorded; the advance path handles forward motion.
    const visitedPaths = new Set<string>();

    // THE BUDGET IS PAGES, NOT ATTEMPTS.
    //
    // maxPages was spent per ITERATION, so a retry cost the same as new ground. Miami's
    // intake is twelve distinct pages plus a review; on the 18-page default the walk spent
    // six of them re-visiting Property Search and Job Category and ran out one page short
    // of the end, twice, having filled 35 fields correctly. A portal that never repeats
    // sees no change from this; a portal that does gets its full depth.
    //
    // The hard iteration cap stays, at twice the page budget, so a pathological loop still
    // terminates — and the repeat-page stop (four visits to one signature) and the recovery
    // cap bound the thrashing long before it gets there.
    const distinctPages = new Set<string>();
    for (let pageIdx = 0; pageIdx < this.maxPages * 2; pageIdx++) {
      if (distinctPages.size >= this.maxPages) {
        this.debug?.event({ type: "page_budget_spent", distinct: distinctPages.size, iterations: pageIdx });
        break;
      }
      // OUT OF TIME — STOP OURSELVES RATHER THAN BE ABANDONED.
      //
      // Checked between pages, never mid-page: a page half-filled and then torn down is
      // the one state worth avoiding, and the portal is mid-transaction until this page
      // settles. Breaking here leaves the run finalising normally, so the caller learns
      // what was reached instead of inferring it from a corpse.
      if (this.deadlineAt && Date.now() >= this.deadlineAt && pageIdx > 0) {
        this.debug?.event({ type: "budget_exhausted", page: pageIdx + 1, pagesWalked: pageCount });
        break;
      }
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
      await this.declineConsentBanner();

      // a3) Section render-readiness: wait until the SPA has MOUNTED an interactive control
      //     before scraping/filling. PGE PowerClerk (and other Vue/React wizards) render the
      //     page chrome and inputs present-but-unbound for a beat; a fill fired then sets the
      //     DOM value but it never commits to the JS model → a blank draft at review. This is
      //     the same gate the hand-coded PowerClerk adapter and the RecipeAdapter replay use;
      //     wiring it here makes the universal auto-learn path robust on PGE's multi-section
      //     ("blocks") form. Non-throwing/best-effort — never skips the page (the empty-scrape
      //     retry below still recovers a genuine miss).
      await waitForInteractiveControls(this.page);

      // a4) And wait out any visible loading mask. ACA postbacks paint "Please wait..." while
      //     the partial render is in flight; extraction that runs behind it reads the page as
      //     it WAS. Live: the city's record types were mid-render behind that overlay, the
      //     extraction missed all seven, and the planner was handed a page whose answer
      //     wasn't in it. waitForDynamicFieldsSettle carries the overlay wait.
      await this.waitForDynamicFieldsSettle().catch(() => null);

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
        return fail(steps, this.portalName, `Failed to scrape page ${pageCount}: ${err instanceof Error ? err.message : String(err)}`, null, pageCount, portalNotices);
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
      let recoveryHint = pendingHint;
      pendingHint = "";
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
          `${recoveryHint ? `${recoveryHint} ` : ""}${problem} Recent steps: ${pageTrace.slice(-4).join("  ->  ") || "(none)"}.${validationLine} ` +
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
            applicationUrl: (() => { try { return typeof this.page?.url === "function" ? this.page.url() : undefined; } catch { return undefined; } })(),
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
        // Record-type CATEGORY expansion. ACA's CapType page can list collapsible category
        // links ("Residential", "Trades", "Non Residential"…) and only reveals the actual
        // record-type radios once a category is expanded. Until then the page has no radios,
        // so the record-type pass below cannot fire and the planner clicks a category blind —
        // live on Anne Arundel that cost an 8s timeout on "Residential" and ended the run.
        // Expanding is a disclosure click: it selects nothing and starts nothing.
        if (/CapType\.aspx/i.test(url) && !acaRecordTypeHandled && !this.acaRecordTypePageDetected(fields) && acaTypeExpansions < ACA_TYPE_EXPANSION_MAX) {
          acaTypeExpansions++;
          const expanded = await this.accelaExpandRecordTypeCategory(steps);
          this.debug?.event({ type: "aca_record_type_expand", page: pageCount, expanded });
          if (expanded) continue;
        }
        // Record-type selection (the page right after the address row is chosen).
        if (!acaRecordTypeHandled && this.acaRecordTypePageDetected(fields)) {
          acaRecordTypeHandled = true;
          const advanced = await this.accelaRecordTypePass(_project, fields, steps);
          this.debug?.event({ type: "aca_record_type_pass", page: pageCount, advanced });
          if (advanced) continue;
        }
      }

      // b9) DETERMINISTIC APPLICATION ENTRY (portal-agnostic). On a logged-in DASHBOARD the
      //     only useful move is "start a new application", and every vendor words that
      //     control differently ("Create an Application", a bare "Apply" tile, "Apply for a
      //     permit", "Apply Online", "Apply Here"). That is a lookup, not a judgement call,
      //     so do it here instead of paying a planner call to guess — and the finder refuses
      //     controls that touch the operator's REAL filings (Resume/Pay/Search/Renew), which
      //     a planner staring at a dashboard can mistake for the way in.
      //     GATE: "the application has not been started yet" — no fill/select/check has been
      //     recorded — plus a bound of ENTRY_PASS_MAX. Deliberately NOT gated on isDashboard:
      //     that requires ZERO fillable inputs, and a real portal home carries a search box
      //     (Accela's AACO dashboard reports 4), so the pass never fired where it was needed
      //     and the planner guessed "Permits" — landing in the operator's RECORDS module on a
      //     live run. Once any value has been entered, this must never fire: clicking "start
      //     an application" mid-flow would restart the wizard. A review page is likewise
      //     excluded (fills are always recorded by then), and the finder's own exclusion list
      //     still refuses anything touching existing records.
      const applicationStarted = steps.some((st) => st.action === "fill" || st.action === "select" || st.action === "check");
      if (!applicationStarted && !reviewSignals && entryPasses < ENTRY_PASS_MAX && this.page) {
        entryPasses++;
        // Clicking the SAME entry control twice never helps. ComEd's entry opens a drawer in
        // place rather than navigating, so the page still looks like a dashboard afterwards
        // and the pass finds the identical button again — the second click TOGGLES the
        // drawer shut and the step lands in the recipe twice. The finder refuses it outright
        // now, so no click happens and nothing is recorded.
        const entered = await enterApplicationFlow(this.page, { skipLabels: this.entryLabelsClicked }).catch(() => null);
        if (entered?.alreadyClicked) {
          this.debug?.event({ type: "application_entry_repeat_ignored", label: (entered.label || "").slice(0, 60) });
        } else if (entered?.ok && entered.label) {
          this.entryLabelsClicked.add(normalizeEntryLabel(entered.label));
          // Also barred from the PLANNER's navigate path: the entry pass and the planner are
          // separate doors to the same button, and the planner walked through its one after
          // the entry pass had already used the other.
          this.navClicksByPath.add(this.navClickKey(url, entered.label));
        }
        this.debug?.event({ type: "application_entry_pass", page: pageCount, ok: Boolean(entered?.ok), label: entered?.label ?? null });

        // WHICH PERMIT TO FILE — A LOOKUP, NOT A PLANNER CALL.
        //
        // permiteyes.us answers "New Application" with a menu of ~50 permit types. Handing
        // that page to the field planner cost 16.6k input tokens and 7-8k output per call at
        // 25-96s each, hit the 8192-token ceiling once and returned unparseable JSON, and two
        // learn runs were cut off mid-page having saved nothing. Fifty permit types is fifty
        // navigation candidates; an LLM is the wrong instrument for a lookup.
        //
        // It is the wrong instrument for the DECISION too. Filing the wrong permit type is
        // worse than filing nothing — this project has already put a Residential Mechanical
        // permit on a solar job — so the chooser refuses on nothing-matched and on
        // several-matched, and says what was offered either way. It never guesses.
        //
        // Recorded as an ordinary step, which is the whole point: the type choice has to be
        // IN the recipe or replay lands on this menu with no step for it, which is exactly
        // how permiteyes' nine-fill recipe failed at step 2 of 12.
        if (!applicationStarted && this.page) {
          const track = /elec/i.test(this.permitDiscipline) ? "electrical"
            : /struct|build/i.test(this.permitDiscipline) ? "structural"
            : "solar";
          const picked = await chooseApplicationType(this.page, track).catch(() => null);
          if (picked && picked.ok) {
            const beforeTypeUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
            const beforeTypeFp = await this.pageFingerprint();
            const clicked = await picked.choice.locator.click({ timeout: 8000 }).then(() => true).catch(() => false);
            if (clicked) {
              await this.waitAfterClick(beforeTypeUrl, beforeTypeFp, this.tabCount());
              steps.push({
                action: "click",
                phase: "open",
                selector: { role: "link", name: picked.choice.label, text: picked.choice.label },
                note: `permit type: ${picked.choice.label}`,
              });
              this.debug?.event({ type: "permit_type_chosen", track, label: picked.choice.label });
            }
          } else if (picked && !picked.ok && picked.refusal.reason === "ambiguous") {
            // Two plausible types (roof-mount vs ground-mount is a real shape). A human picks;
            // guessing files one of them.
            this.debug?.event({ type: "permit_type_ambiguous", track, matched: picked.refusal.matched.slice(0, 6) });
          }
        }
        if (entered?.ok) {
          // Record it the way replay will need it: click the control by its visible text.
          steps.push({
            action: "click",
            phase: "open",
            selector: { text: entered.label, fallbacks: [{ role: "link", name: entered.label }, { role: "button", name: entered.label }] },
            note: `application entry: ${entered.label}`,
          });
          await this.page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => null);
          await this.page.waitForTimeout?.(1200).catch(() => null);
        }

        // The entry may have opened a DRAWER that asks which programme to apply under before
        // it will show a single field. Answer it, or the run reports "nothing fillable" while
        // standing on the choice (live: ComEd, six pages, no steps recorded).
        //
        // Attempted on EVERY iteration once an entry click has landed — not just the one that
        // opened the drawer. When the repeat guard above refuses a second entry click, the
        // drawer is sitting open and unanswered, and a choice-only pass tied to `entered.ok`
        // would never get its second chance. Gated on an entry having happened so it cannot
        // fire on a pre-entry dashboard's unrelated radios.
        const programJustChosen = this.entryLabelsClicked.size > 0 && !this.programChosen
          ? await this.chooseApplicationProgram(steps)
          : false;
        if (entered?.ok || programJustChosen) continue;
      }

      // b9) AN OPTION-LESS DROPDOWN IS UNANSWERABLE. Ask it what it offers, first.
      //
      // A widget that renders its list only on click reaches the planner as a select with
      // no options, so the planner has to invent a value; nothing matches it, the fill is
      // dropped, and the portal says the field is still empty. Miami's Job Category did
      // exactly that on three consecutive visits — its options do not exist in the DOM
      // until the widget is opened, and the definitions printed beside it are prose.
      //
      // Capped and best-effort: a handful per page, each opened and shut, nothing changed.
      try {
        let opened = 0;
        for (const f of fields) {
          if (opened >= 6) break;
          if (f.fieldType !== "select") continue;
          if (Array.isArray(f.options) && f.options.length > 0) continue;
          const loc = await this.locator(f.selector).catch(() => null);
          if (!loc) continue;
          const opts = await readClosedComboboxOptions(this.page, loc);
          if (opts.length) {
            f.options = opts;
            opened++;
            this.debug?.event({
              type: "dropdown_options_read",
              page: pageCount,
              label: String(f.label ?? "").slice(0, 40),
              count: opts.length,
              // The count alone cannot say whether the planner's answer was on the menu.
              options: opts.slice(0, 12),
            });
          }
        }
      } catch { /* best-effort — a page the planner sees without options is the status quo */ }

      // c) Ask the planner what to do on this page. Attach a screenshot so it can SEE the
      //    section headings/layout (vision-assisted planning) — the reliable signal for which
      //    contact block is the customer vs the installer.
      let plan: LearnPlanResponse;
      const planShot = await this.capturePlanScreenshot();
      try {
        plan = await this.planner({ url, pageTitle, fields, bodyText, alreadyFilledLabels, isDashboard, recoveryHint: recoveryHint || undefined, screenshotBase64: planShot });
      } catch (err) {
        this.debug?.event({ type: "planner_error", page: pageCount, message: err instanceof Error ? err.message : String(err) });
        return fail(steps, this.portalName, `Planner failed on page ${pageCount}: ${err instanceof Error ? err.message : String(err)}`, null, pageCount, portalNotices);
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

        // WHAT DID THE PORTAL SAY? Read it here, on every page, before deciding anything —
        // this is the only place that sees a page which advanced INTO an error.
        {
          const notices = await collectPortalNoticesFrom(this.page);
          const fresh = notices.filter((n) => !portalNotices.includes(n));
          if (fresh.length) {
            for (const n of fresh) portalNotices.push(n);
            this.debug?.event({ type: "portal_notice", page: pageCount, notices: fresh.slice(0, 5) });
          }
        }

        // THE SAME PAGE, OVER AND OVER, UNTIL THE BUDGET DIES.
        //
        // Miami's iBuildPortal — a portal reached for the FIRST TIME today after its stored
        // URL was corrected — walked Home, Legal Agreement, then Property Search seven times.
        // Pages 3 through 9 are byte-identical in the trace: same path, same 69 fields, an
        // advance planned every time, and nothing moving. Ten pages of budget bought three
        // distinct pages. Boston did it eight times and Baltimore four.
        //
        // A walk that cannot tell it is standing still cannot stop, and cannot say why. This
        // does both: after REPEAT_PAGE_LIMIT visits to the same signature it stops and names
        // the page, which is a run an operator can act on rather than a budget timeout.
        //
        // The signature deliberately EXCLUDES body text — an inline validation message
        // changes that on every attempt, which would make a stuck page look like progress.
        {
          const sig = `${hostPath}|${fields.length}|${fillCount}|${btnCount}`;
          distinctPages.add(sig);
          repeatPageCounts.set(sig, (repeatPageCounts.get(sig) ?? 0) + 1);
          const seen = repeatPageCounts.get(sig) ?? 1;
          if (seen > REPEAT_PAGE_LIMIT) {
            this.debug?.event({ type: "page_repeat_stop", page: pageCount, seen, sig: sig.slice(0, 90) });
            return fail(
              steps,
              this.portalName,
              // DO NOT NAME A CAUSE THIS CHECK CANNOT SEE. The first version of this ended
              // "the advance on this page is not advancing" — on Miami that was flatly
              // untrue: every advance fired a search, the URL changed each time, and the
              // portal handed back the same page with "Property Address not found." The
              // observation is "we keep ending up here"; the cause comes from the notices.
              `The walk stopped making progress: "${(redactStatusText(pageTitle) || hostPath).slice(0, 60)}" was reached ${seen} times with the same controls. Recorded ${steps.filter((st) => ["fill", "select", "check"].includes(String(st.action))).length} field(s) before that. Either its advance does nothing, or it advances and the portal sends the walk straight back.`,
              null,
              pageCount,
              portalNotices,
            );
          }

          // BACK ON THE SAME PAGE MEANS THE LAST ACTION DID NOT WORK, WHATEVER IT WAS.
          //
          // The results-row pass hung off the ADVANCE path, so it only ever ran when the
          // planner called the control an advance. Told the button's real name, the planner
          // called "Start New Application" a NAVIGATE instead — a different branch, with its
          // own no-movement handling — and the row click never got a turn on three
          // consecutive visits to Miami's search results. Whether the last action was an
          // advance, a navigate or a fallback, being back on a page with the same controls
          // says it did not work, and a results page's answer is its row.
          // ONCE PER PAGE, THOUGH. Clicking the same row again is not progress, and the
          // first version of this ran on EVERY repeat visit: it preempted the planner's own
          // choice two visits running, so the control the planner had picked was never
          // executed at all and the walk hit the repeat-stop having tried nothing new.
          if (seen >= 2 && !rowPickedSigs.has(sig)) {
            rowPickedSigs.add(sig);
            if (await this.clickMatchingResultRow(_project, steps)) {
              // EVERY MEMORY OF WHAT DID NOT WORK ON THIS PAGE IS NOW OUT OF DATE, and there
              // are two of them. The dead-advance ban is one; the nav RE-CLICK guard is the
              // other, and on Miami it was the one that mattered: the planner clicked "Start
              // New Application" while the parcel was unchosen and the button inert, the
              // guard remembered it as a loop, and after the row click made that button the
              // way forward the walk refused to click it again.
              deadAdvances.delete(deadPageKey(url, fields.length));
              this.forgetNavClicksOn(url);
              this.debug?.event({ type: "result_row_on_repeat", page: pageCount, seen });
              continue;
            }
          }
        }

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
            // OPTIONS TOO. Without them the bundle cannot answer the one question a
            // dropped select raises — what was this control offering, and was the planner's
            // answer among it. Miami's Job Category took a live re-run and a database query
            // to establish that the planner said "STAND-ALONE" and the click found no rows.
            fieldsSeen: fields.map((f, i) => ({
              i, type: f.fieldType, label: (f.label || "").slice(0, 80),
              ...(f.options?.length ? { options: f.options.slice(0, 25) } : {}),
            })),
            decisions: (plan.fills ?? []).map((fl) => {
              const f = fields[fl.selectorIndex];
              // Match what applyFill actually RECORDS, or this diagnostic lies about the
              // one bug it is best placed to reveal: a Yes/No question whose label merely
              // says "meter" is not a secret, and its answer IS stored. Showing the
              // redaction placeholder for it sent an investigation down the wrong path.
              const fixedOptions = f ? (f.fieldType === "select" || f.fieldType === "radio" || f.fieldType === "checkbox") : false;
              const sensitive = f ? isSensitiveLabel(f.label) && !fixedOptions : false;
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
        let navField = fields[plan.navigateSelectorIndex];
        // A LIST WHERE EVERY CONTROL SAYS THE SAME WORD — see rowChooser.ts. The planner has
        // nothing to choose BY on such a page: Des Moines offers twelve buttons all reading
        // "SELECT" and the meaning is in the row beside each one.
        //
        // The pick REPLACES the planner's target and then goes through the ordinary navigate
        // path below. An earlier version clicked it here instead, and reimplementing a
        // fraction of that path cost two live runs: first a flat 1200ms wait where the real
        // path does a networkidle race, then a missing waitAfterClick — which is what adopts
        // a new tab. PermitTrax picked the right row both times and the walk ended anyway,
        // still looking at the dashboard. Do not duplicate the path; feed it.
        const rowPick = await this.chooseRowTarget();
        if (rowPick) navField = rowPick;
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
        // RE-CLICK GUARD: the same control, on the same page, a second time. That is a loop
        // by definition — it cannot be forward progress. The href-based revisit check above
        // misses it entirely on a single-page app: ComEd's entry is an href-less <button>,
        // its URL never changes, and nothing had been filled yet, so the planner clicked
        // "New Application" again with the drawer's form already on screen — closing it and
        // throwing away 28 fillable fields, twice, until the page budget ran out.
        const navLabelRaw = (navField?.label || "").replace(/\s+/g, " ").trim();
        const navLoopKey = navLabelRaw ? this.navClickKey(url, navLabelRaw) : "";
        const navLoop = !!navLoopKey && this.navClicksByPath.has(navLoopKey);
        if (navRevisit) {
          this.debug?.event({ type: "navigate_revisit_rejected", page: pageCount, label: (navField?.label || "").slice(0, 60) });
          if (process.env.AUTOLEARN_DEBUG === "1") console.error(`[learn] rejected navigate to an already-visited path (p${pageCount}).`);
        } else if (navLoop) {
          this.debug?.event({ type: "navigate_reclick_rejected", page: pageCount, label: navLabelRaw.slice(0, 60) });
          pendingHint =
            `You already clicked "${navLabelRaw.slice(0, 60)}" on THIS page earlier in this run, and it was refused this time. ` +
            `It does not make forward progress — it re-opens or resets what is already open. ` +
            `Work with the form that is on the page NOW: fill its required fields, or click its Continue/Next button.`;
          if (process.env.AUTOLEARN_DEBUG === "1") console.error(`[learn] rejected a re-click of "${navLabelRaw}" (p${pageCount}).`);
        } else if (navField && this.addressRowChosen && /^\s*select\s*$/i.test(navField.label || "")) {
          // THE ADDRESS VERSION IS ALREADY CHOSEN — the ranked chooser picked this project's
          // row (owner + city + discipline). A bare row "Select" clicked after that RE-SELECTS
          // a jurisdiction and wipes the services panel: live on Marineau's structural learn,
          // the city's 7 services (Residential - Structural among them) were on screen when
          // the planner clicked a "Select" and replaced them with the county's electrical-only
          // list. The grid belongs to the chooser; the planner never re-picks it.
          this.debug?.event({ type: "address_reselect_refused", page: pageCount, label: (navField.label || "").slice(0, 40) });
        } else if (navField && this.acaApplicantFilled && CONTACT_CONTROL.test(navField.label || "")) {
          // The applicant contact is already filled with the FILING CONTRACTOR's identity.
          // Re-opening that section is how the planner overwrote it with the homeowner's
          // details (live Coos Bay), so refuse the click and let the advance path move on.
          this.debug?.event({ type: "contact_reopen_refused", label: (navField.label || "").slice(0, 60) });
        } else if (navField && (isDashboard ? this.isOffLimitsDashboardTarget(navField) : this.isOffLimitsButton(navField))) {
          // The planner picked a control that reaches into the operator's existing records
          // (or, on a dashboard, anything that isn't starting a new application). Refuse and
          // let the next pass try again — a live run drifted into Accela's records module
          // exactly this way.
          this.debug?.event({ type: "navigate_offlimits_rejected", page: pageCount, label: (navField.label || "").slice(0, 60), dashboard: isDashboard });
        } else if (navField) {
          // WHAT IT DECIDED TO CLICK, not only what it refused.
          //
          // Every refusal above records a reason and a label; the ACCEPTED navigate recorded
          // neither, so a run that walked somewhere useless left no note of what it followed.
          // Des Moines (PermitTrax) reached /citizen/CookiePolicy/ twice AFTER the legal-page
          // exclusion shipped, and the bundle could not say which control took it there —
          // the fifth time today an artifact could not answer the question it existed for.
          this.debug?.event({
            type: "navigate_chosen",
            page: pageCount,
            label: (navField.label || "").slice(0, 60),
            dashboard: isDashboard,
            href: String((navField.selector as { href?: unknown } | undefined)?.href ?? "").slice(0, 90),
          });
          navCount++;
          if (navLoopKey) this.navClicksByPath.add(navLoopKey);
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
            return fail(steps, this.portalName, `Failed to click navigation link "${navField.label}" on page ${pageCount}: ${res.message ?? "unknown"}`, null, pageCount, portalNotices);
          }
          // A CONSENT WALL, NAMED RATHER THAN WANDERED INTO.
          //
          // Des Moines answers a click on ANY permit type by serving its cookie policy — the
          // row picked was verifiably correct ("05) RESIDENTIAL ROOFTOP PHOTOVOLTAIC
          // PERMIT") and the portal bounced it anyway, because its Termly consent decision
          // has not been made and the application flow is gated behind it. Three runs were
          // spent re-reading that policy page.
          //
          // Accepting non-essential cookies on the operator's behalf to get a filing done is
          // not a decision automation should take, so the run stops and says so — the same
          // treatment a CAPTCHA gets, and for the same reason.
          const navAfterUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
          if (looksLikeConsentWall(navBeforeUrl, navAfterUrl)) {
            this.debug?.event({ type: "consent_wall", from: safeHostPath(navBeforeUrl), to: safeHostPath(navAfterUrl), via: (navField.label || "").slice(0, 70) });
            // ANSWER IT THE PRIVACY-PRESERVING WAY, THEN CARRY ON.
            //
            // The old behaviour was to stop, on the grounds that consenting is the operator's
            // decision. That is right about ACCEPTING and wrong about the wall: declining is
            // also an answer, and it is the one that suits the operator. declineConsentBanner
            // clicks Reject / Decline / Necessary-only, or a plain Close which consents to
            // nothing, and it still refuses outright when Accept is the only control offered.
            //
            // So decline on the policy page the portal bounced us to, go back, and try the
            // entry once more. Two portals in the 59-portal benchmark ended their run here
            // (apps.lakestevenswa.gov, desmoines-wa.permittrax.com) having filled nothing.
            await this.declineConsentBanner();
            await this.page.goto(navBeforeUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
            await smartWait(this.page);
            await this.declineConsentBanner();
            const retryUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
            if (looksLikeConsentWall(navBeforeUrl, retryUrl)) {
              return fail(
                steps,
                this.portalName,
                `This portal will not start an application until its cookie consent is answered, and declining did not clear it: clicking "${(navField.label || "the application entry").slice(0, 60)}" is still redirected to its cookie policy. A person must make that choice — automation declines non-essential cookies but never accepts them on the operator's behalf.`,
                null,
                pageCount,
                portalNotices,
              );
            }
            // TWO THINGS THE FIRST DRAFT OF THIS GOT WRONG, both of them silent.
            //
            // The bounced click is ALREADY IN THE RECIPE by the time we get here — it is
            // pushed before the wall is detected, exactly as the validation-block path
            // discovered and already handles by popping it. Leaving it in records a click
            // that lands on a cookie policy, and replay runs on a fresh per-portal profile,
            // so it would bounce there too, where nothing knows how to go back.
            if (steps.length && String(steps[steps.length - 1].note ?? "").startsWith("navigate to application:")) {
              steps.pop();
              navCount = Math.max(0, navCount - 1);
            }
            // And the click was registered in the loop-guard the moment it was made, so the
            // "try it once more" this comment promised could never happen: the guard exists
            // to refuse a second click on the same control. Clearing the wall is precisely
            // the case where a second click is the right thing, so the key comes back out.
            if (navLoopKey) this.navClicksByPath.delete(navLoopKey);
            this.debug?.event({ type: "consent_wall_cleared", by: "declined" });
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
        const seenSlotLabels = new Set<string>(await this.uploadSlotLabels());
        const up = await this.withPhaseTimeout(
          "uploads",
          150_000,
          () => this.performUploads(steps, alreadyFilledLabels),
          { filled: [] as string[], missingRequired: [] as string[], attached: 0 },
        );
        this.debug?.event({ type: "upload_phase_done", page: pageCount, attached: up.attached, missing: up.missingRequired.length });

        // AN UPLOAD SLOT CAN APPEAR ONLY AFTER AN ANSWER ON THE SAME PAGE. Ameren's
        // Generator page reveals "Please attach the Data Sheet for the DC Source/PV Module"
        // once the energy-source/equipment selects finish cascading (~600ms on PowerClerk),
        // so a single pass ran against the pre-cascade page, attached the two slots that
        // existed, and reported missing:0 — while the module data sheet we HAD sat
        // unattached with nothing flagging it. This is the shape of every conditional
        // document section (a battery job's storage attachments, a second array's specs),
        // so wait for the page to settle and run again whenever NEW slot labels appear.
        // New labels, not a bigger count: attaching a document REMOVES its file input, so
        // the slot count falls even as the page reveals more.
        for (let extraPass = 0; extraPass < 2; extraPass++) {
          await sleep(1500);
          const fresh = (await this.uploadSlotLabels()).filter((l) => !seenSlotLabels.has(l));
          if (fresh.length === 0) break;
          for (const l of fresh) seenSlotLabels.add(l);
          this.debug?.event({ type: "upload_late_slots", page: pageCount, labels: fresh.slice(0, 6).join(" | ").slice(0, 200) });
          const late = await this.withPhaseTimeout(
            "uploads_late",
            90_000,
            () => this.performUploads(steps, alreadyFilledLabels),
            { filled: [] as string[], missingRequired: [] as string[], attached: 0 },
          );
          up.attached += late.attached;
          for (const m of late.missingRequired) if (!up.missingRequired.includes(m)) up.missingRequired.push(m);
          this.debug?.event({ type: "upload_phase_done", page: pageCount, pass: extraPass + 2, attached: late.attached, missing: late.missingRequired.length });
        }
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

      // c4b) A COMBINED ADDRESS BOX GETS THE WHOLE STREET LINE.
      //
      // The planner's value dictionary offers `street` (whole) alongside `streetNumber`,
      // `streetNameCore` and `streetNameSearchPortion` — keys written for Accela's SPLIT
      // work-location form, where dropping the suffix is required. Nothing tells it which
      // one a single search box wants. Miami's iBuild searched "3500 Pan American", then
      // "Pan American", for a property its own database holds as "3500 PAN AMERICAN DR";
      // both came back "Property Address not found." The whole line finds it first try
      // (browser-verified against the live portal).
      //
      // Deterministic, not a prompt tweak: the planner had the right key available and did
      // not pick it, twice, on the same page.
      const splitAddressForm = isSplitAddressForm(fields.filter((f) => f.fieldType !== "button").map((f) => f.label));
      if (splitAddressForm) {
        this.debug?.event({ type: "address_split_form", page: pageCount });
      } else {
        const fullStreetLine = parseStreetLine(String(_project.projectAddress ?? ""), _project.city || undefined);
        for (const fillReq of plan.fills ?? []) {
          const corrected = correctTruncatedAddressFill(
            { value: fillReq.value, field: fillReq.field },
            { fullStreetLine, projectAddress: String(_project.projectAddress ?? ""), splitForm: false },
          );
          if (!corrected) continue;
          this.debug?.event({
            type: "address_fill_expanded",
            page: pageCount,
            from: String(fillReq.value ?? "").slice(0, 60),
            fromField: fillReq.field,
            to: corrected.value.slice(0, 60),
          });
          fillReq.value = corrected.value;
          fillReq.field = corrected.field;
        }
      }

      let pageFillCountPre = 0;
      let answeredAnyPicker = false;
      // c4c) A CONTACT BLOCK'S SOURCE PICKER MUST BE ANSWERED BEFORE ITS FIELDS ARE TYPED.
      //
      // PowerClerk renders each contact block with a select — "Existing contact to use for
      // this contact" — offering the contacts already on the project plus "New Contact".
      // Left unset, the block is not in manual-entry mode, and the values typed into Name /
      // Company / Address are discarded on the autosave round-trip. Live on Ameren: the
      // planner filled the Electrical Contractor block correctly, the read-back re-applied
      // once, and all three came back blank at the review screen anyway.
      //
      // "New Contact" is the option that means "I am about to type these", which is exactly
      // what the walk is doing — it can never pick the wrong party, unlike copying another
      // block's contact. Answered here, before the fills, because after them is too late.
      try {
        for (const f of fields) {
          if (f.fieldType !== "select") continue;
          if (!/existing contact|contact to use|select a contact/i.test(String(f.label ?? ""))) continue;
          const loc = await this.locator(f.selector).catch(() => null);
          if (!loc) continue;
          const current = typeof loc.inputValue === "function"
            ? String((await loc.inputValue().catch(() => "")) ?? "").trim()
            : "";
          if (current && !/^(please select|select|choose|--)/i.test(current)) continue;
          const chosen = (f.options ?? []).find((o) => /new contact/i.test(String(o)));
          if (!chosen) continue;
          const step = await this.applyFill(f, { value: chosen, field: undefined }, false);
          if (step) {
            steps.push(step);
            pageFillCountPre++;
            this.debug?.event({ type: "contact_source_answered", page: pageCount, label: String(f.label ?? "").slice(0, 50), chose: chosen });
            // CHOOSING RE-RENDERS THE BLOCK. PowerClerk rebuilds the contact fields when the
            // source changes, and their ids are render-order counters (pcInputBase15…), so a
            // fill applied against the pre-render list lands on a detached node or the wrong
            // control. Let the rebuild finish; applyFill re-resolves each selector at fill
            // time, so a settled page is all it needs.
            await this.waitForDynamicFieldsSettle().catch(() => null);
            answeredAnyPicker = true;
          }
        }
        // ...AND THEN THE SELECTORS THE PLANNER'S FILLS POINT AT ARE STALE.
        //
        // The miss-split is what caught this half: answering the picker turned Ameren's
        // Name/Company/Address from "typed but not kept" into "NEVER FILLED", because the
        // rebuild gives every input a new render-order id and applyFill could no longer
        // resolve them. Strictly worse than not answering it.
        //
        // Re-extract and adopt the fresh selectors — but ONLY when the rebuild produced the
        // same controls in the same order, which is what a re-render of the same block looks
        // like. Anything else and the planner's indices no longer mean what it chose, so the
        // safe move is to leave the list alone and say so.
        if (answeredAnyPicker) {
          const refreshed = (await this.extractAllFrames(EXTRACT_SEL)).map(toExtractedField);
          const sameShape = refreshed.length === fields.length
            && refreshed.every((f, i) => String(f.label ?? "") === String(fields[i].label ?? "")
              && f.fieldType === fields[i].fieldType);
          if (sameShape) {
            for (let i = 0; i < fields.length; i++) fields[i].selector = refreshed[i].selector;
            this.debug?.event({ type: "selectors_refreshed_after_rerender", page: pageCount, count: fields.length });
          } else {
            // A RE-RENDER THAT CHANGES THE PAGE INVALIDATES AN INDEX, NOT THE PLAN.
            //
            // Answering "Existing contact to use for this contact" with "New Contact" is the
            // case this whole block exists for, and it EXPANDS the block — the Name, Company
            // and Address inputs the customer is supposed to fill only exist after the answer.
            // So the shape legitimately changes, `sameShape` is false, and the old code logged
            // that and moved on with the pre-render field list: every planned index now points
            // at a different control, or at nothing. Live cost on Ameren, across every
            // cross-project run: "Name [Interconnection Application]" and "Company
            // [Interconnection Application]" reported blank on a filing that cannot be
            // submitted without them.
            //
            // Re-anchor instead of giving up. The planner chose a FIELD, and a field's identity
            // is its label within its section — not its position in a list that just changed
            // under us. Anything that cannot be re-anchored unambiguously is dropped and
            // reported, because filling the wrong control is worse than leaving one blank.
            const before = fields.length;
            const keyOf = (f: { label?: string; section?: string; fieldType?: string }): string =>
              `${String(f.section ?? "").trim()}\u0000${String(f.label ?? "").trim()}\u0000${String(f.fieldType ?? "")}`;
            const counts = new Map<string, number>();
            for (const f of refreshed) counts.set(keyOf(f), (counts.get(keyOf(f)) ?? 0) + 1);
            const remapped: Array<{ selectorIndex: number; value: string }> = [];
            let dropped = 0;
            for (const fillReq of plan.fills ?? []) {
              const old = fields[fillReq.selectorIndex];
              if (!old) { dropped++; continue; }
              const key = keyOf(old);
              // Exactly one match, or we do not know which control the planner meant.
              if ((counts.get(key) ?? 0) !== 1) { dropped++; continue; }
              const idx = refreshed.findIndex((f) => keyOf(f) === key);
              if (idx < 0) { dropped++; continue; }
              remapped.push({ selectorIndex: idx, value: fillReq.value });
            }
            fields.length = 0;
            for (const f of refreshed) fields.push(f);
            plan.fills = remapped;
            this.debug?.event({
              type: "rerender_changed_the_page", page: pageCount, before, after: refreshed.length,
              reanchored: remapped.length, dropped,
            });
          }
        }
      } catch { /* best-effort — a block without a picker is the common case */ }

      // d) Apply the fills and record each as a RecipeStep.
      let pageFillCount = pageFillCountPre;
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
        // Choose whose property this is BEFORE filling anything: on a disambiguation grid the
        // page that follows the choice is the one the rest of this pass will fill.
        if (await this.chooseProjectAddressRow(steps)) await sleep(1200);
        const otherFilled = await this.fillOtherSpecifyFields(steps, alreadyFilledLabels);
        // A required contact email the planner left blank, answered from the section it sits in.
        const emailsFilled = await this.fillSectionEmails(steps, alreadyFilledLabels);
        if (emailsFilled > 0) pageFillCount += emailsFilled;
        if (otherFilled > 0 || emailsFilled > 0) await this.waitForDynamicFieldsSettle().catch(() => null);
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
        for (const m of misses) {
          if (!fillVerifyMisses.includes(m)) fillVerifyMisses.push(m);
          // TYPED-AND-LOST AND NEVER-TYPED NEED OPPOSITE FIXES, and they were being merged
          // into one list. Ameren's review reports Street, Name, Company, Address blank every
          // run; whether the walk typed them and the portal took them back, or never reached
          // them at all, decides whether the next fix is about persistence or about
          // selectors — and the run could not say which.
          if (!missesDidNotHold.includes(m)) missesDidNotHold.push(m);
        }
        if (misses.length) this.debug?.event({ type: "fills_did_not_hold", page: pageCount, labels: misses.slice(0, 8) });
      }

      // d4b) REQUIRED-FIELD SWEEP — before advancing, scan the live page for REQUIRED fields
      //      still blank/unselected that the planner never touched (an unanswered Yes/No group,
      //      an unselected equipment-model dropdown, a dropped Schedule). verifyFillsLanded only
      //      re-checks fields we DID fill, so these would otherwise sail through to a wrongly-
      //      "trusted" recipe. Only on real form pages (skip dashboards/review). Sensitive +
      //      acknowledgment fields are excluded inside the sweep.
      if (!plan.atReview && !isDashboard && hasFillable) {
        const unfilled = await this.collectUnfilledRequired();
        for (const m of unfilled) {
          if (!fillVerifyMisses.includes(m)) fillVerifyMisses.push(m);
          if (!missesNeverFilled.includes(m) && !missesDidNotHold.includes(m)) missesNeverFilled.push(m);
        }
        if (unfilled.length) this.debug?.event({ type: "required_never_filled", page: pageCount, labels: unfilled.slice(0, 8) });
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

      // e) Record the final submit (if any). Clicked ONLY on the operator's explicit
      //    delegation; otherwise recorded and left for a human. Pay/fee buttons rejected.
      if (typeof plan.finalSubmitSelectorIndex === "number") {
        const submitField = fields[plan.finalSubmitSelectorIndex];
        if (submitField && !this.isOffLimitsButton(submitField)) {
          // THE DELEGATED CLICK LIVES HERE BECAUSE THIS IS THE PATH THAT RUNS.
          //
          // runAdapter has the same gate, but auto-learn does not go through runAdapter --
          // the staging precedence puts AutoLearnAdapter ahead of the hand-coded adapters and
          // calls autoLearnPortal directly, so a delegation wired only into runAdapter never
          // fires. Live: a structural application reached Step 3 Review, correctly filled,
          // and stopped there with finalSubmitClicked=false.
          //
          // Both switches must still agree (the per-run flag AND PORTAL_ALLOW_FINAL_SUBMIT=1),
          // isOffLimitsButton has already refused anything pay/fee shaped, and the step is
          // recorded either way so the recipe carries it for replay.
          const delegated = this.allowFinalSubmit === true && process.env.PORTAL_ALLOW_FINAL_SUBMIT === "1";
          // THE NOTE MUST DESCRIBE WHAT HAPPENED, NOT WHAT WAS PERMITTED. Writing "clicked on
          // operator delegation" the moment delegation was ARMED made a recipe claim a filing
          // that never occurred: the click timed out, no application reached the utility, and
          // the recorded note said otherwise. A step is recorded either way, so the note is
          // written after the attempt, from its result.
          const submitStep: RecipeStep = {
            action: "click",
            phase: "review",
            selector: submitField.selector,
            isFinalSubmit: true,
            note: `final submit: ${submitField.label || "submit"} (recorded, NOT clicked)`,
          };
          steps.push(submitStep);
          finalSubmitRecorded = true;

          if (delegated) {
            this.debug?.event({ type: "final_submit_delegated", label: (submitField.label || "").slice(0, 60) });
            const res = await safeAction(
              "final submit",
              async () => {
                const loc = await this.locator(submitField.selector);
                await loc.click({ timeout: 20000 });
                await this.page!.waitForLoadState?.("networkidle", { timeout: 30000 }).catch(() => null);
                await smartWait(this.page!, 4000);
              },
              { required: false },
            );
            if (res.ok && !res.message) {
              this.finalSubmitClicked = true;
              submitStep.note = `final submit: ${submitField.label || "submit"} (CLICKED on operator delegation)`;
              // The completion page is the receipt: it carries the number the portal just
              // issued, and it is the only place that number appears before the record list
              // catches up. Grab it while we are standing on it.
              this.finalSubmitPageText = String(
                (await this.page!.locator("body").innerText().catch(() => "")) ?? "",
              ).replace(/\s+/g, " ").trim().slice(0, 4000);
              this.finalSubmitUrl = (() => { try { return String(this.page!.url?.() ?? ""); } catch { return ""; } })();
              this.debug?.event({ type: "final_submit_done", url: this.finalSubmitUrl.slice(0, 120) });
            } else {
              submitStep.note = `final submit: ${submitField.label || "submit"} (delegation armed but the click did NOT go through: ${(res.message || "timed out").slice(0, 80)})`;
              this.debug?.event({ type: "final_submit_failed", why: (res.message || "click did not go through").slice(0, 160) });
            }
          }
        }
      }

      // f) Stop at review, OR advance to the next page, OR stop (no advance).
      if (plan.atReview) {
        // THE VALUE THAT MATTERS IS THE ONE ON THE PAGE WHEN WE LEAVE IT. Replay has had
        // this discipline for a while (reassertBlanksOnce before every advancing click and
        // on the final page); the learn never did. On Ameren the Electrical Contractor
        // block was filled, VERIFIED PRESENT by verifyFillsLanded, and wiped again by a
        // later autosave round-trip — a one-shot mid-page verify cannot survive a portal
        // that keeps resetting. One more pass at the exit; verifyFillsLanded already
        // re-applies whatever is lost.
        await this.verifyFillsLanded(appliedThisPage, { budgetMs: 25_000, requiredOnly: true }).catch(() => [] as string[]);
        reachedReview = true;
        break;
      }

      if (typeof plan.advanceSelectorIndex === "number") {
        const advanceField = fields[plan.advanceSelectorIndex];
        if (!advanceField) break; // bad index — stop cleanly.
        // Already proven not to move this page — fall through to the fallback finder, which
        // will pick a different control rather than repeating a click that does nothing.
        {
          const deadKey = deadPageKey(url, fields.length);
          const label = String(advanceField.label ?? "").slice(0, 60);
          if (label && deadAdvances.get(deadKey)?.has(label)) {
            this.debug?.event({ type: "advance_skipped_dead", page: pageCount, label });
            // A search that returned results is answered by clicking a result — try that
            // BEFORE hunting for another button, because on a results page there usually
            // isn't one. See clickMatchingResultRow.
            if (await this.clickMatchingResultRow(_project, steps)) { deadAdvances.delete(deadKey); continue; }
            if (await this.clickFallbackAdvance(steps, fields)) continue;
            if (await this.pressEnterInLastFilledField(steps, fields)) continue;
            // AND IF NONE OF THEM MOVED IT, HAND THE PAGE BACK TO THE PLANNER — do not end
            // the run. This branch used to `break`, which killed the walk on the SECOND
            // visit to a blocked page: the recovery hint that carries the portal's own
            // validation errors ("Schedule: This field is required.") is not built until the
            // THIRD, so the planner was never told why it was stuck and the run ended saying
            // nothing. Looping is bounded already — the repeat-page stop, the recovery cap
            // and the page budget all still apply.
            this.debug?.event({ type: "dead_advance_replan", page: pageCount, label });
            continue;
          }
        }
        // SAFETY: never click/record a pay/fee/checkout button as the "advance".
        if (this.isOffLimitsButton(advanceField)) {
          return {
            ok: false,
            portalName: this.portalName,
            steps,
            reviewScreen: { fields: [], bodyTextSnippet: "" },
            finalSubmitRecorded,
            applicationUrl: (() => { try { return typeof this.page?.url === "function" ? this.page.url() : undefined; } catch { return undefined; } })(),
            pageCount,
            pauseReason: null,
            message: `Stopped: the planner returned a pay/fee control ("${advanceField.label}") as the advance button. Never automated. The recipe was recorded up to this page; a human must continue.`,
          };
        }
        // Same exit discipline as the atReview break above: re-assert what the portal wiped
        // since the mid-page verify, so the page we advance OFF carries what we typed. Then
        // give the autosave a moment — a re-typed value that has not round-tripped is lost
        // by the very click that follows (the reason the d1 settle exists).
        await this.verifyFillsLanded(appliedThisPage, { budgetMs: 25_000, requiredOnly: true }).catch(() => [] as string[]);
        if (appliedThisPage.length > 0) {
          await this.waitForAutosaveIndicator(3000);
          await sleep(400);
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
        const advBeforeSig = await advanceSignatureOf(this.page);
        const advTabsBefore = this.tabCount(); // capture BEFORE the click — the popup opens during it
        // ONE ADVANCE IS ONE PAGE'S WORK, NOT A BUDGET.
        //
        // safeAction retries the whole action, clickResilient retries four times inside it,
        // and each of those waits for the element and then for the network. Multiplied out,
        // Miami's page 6 spent FIFTEEN MINUTES on a single advance click and emitted not one
        // event — the portal cap killed the run, and the trace showed a walk that simply
        // stopped after "upload_phase_done". A run that cannot say where its time went
        // cannot be debugged.
        //
        // The bound does not cancel the click (nothing can), so it is set well above any
        // healthy advance: it only ever fires on the pathological case, and lands the walk
        // in the did-nothing path, which already knows what to do — ban the control, try the
        // results row, try the fallbacks.
        const ADVANCE_BUDGET_MS = 90_000;
        const advStarted = Date.now();
        // The timer is unref'd and cleared on the happy path. Armed and left running, every
        // advance would hold the process open for 90 seconds past its own summary — which
        // reads exactly like the hang this exists to catch.
        let advTimer: ReturnType<typeof setTimeout> | undefined;
        const advBudget = new Promise<{ ok: boolean; field: string; message: string; timedOut: boolean }>((resolve) => {
          advTimer = setTimeout(
            () => resolve({ ok: true, field: "advance", message: "advance click exceeded its budget", timedOut: true }),
            ADVANCE_BUDGET_MS,
          );
          (advTimer as { unref?: () => void }).unref?.();
        });
        const res = await Promise.race([
          safeAction(
            "advance",
            async () => {
              const loc = await this.locator(advanceField.selector);
              if (!loc) throw new Error("advance selector unresolved");
              const gen = this.clickGeneration;
              await this.clickResilient(loc);
              if (this.clickGeneration !== gen) return; // retired mid-click; the walk owns the page
              await this.waitAfterClick(advBeforeUrl, advBeforeFp, advTabsBefore);
            },
            { required: true },
          ),
          advBudget,
        ]);
        if (advTimer) clearTimeout(advTimer);
        if ((res as { timedOut?: boolean }).timedOut) {
          this.clickGeneration++; // retire the click still in flight before anything else
          this.debug?.event({
            type: "advance_timed_out",
            page: pageCount,
            label: String(advanceField.label ?? "").slice(0, 60),
            ms: Date.now() - advStarted,
          });
        }
        if (!res.ok) {
          return fail(steps, this.portalName, `Failed to click the advance button on page ${pageCount}: ${res.message ?? "unknown"}`, null, pageCount, portalNotices);
        }

        // d5) POST-ADVANCE VALIDATION GUARD — did the page actually move forward?
        // When a portal blocks submission because required fields are missing or invalid,
        // the "Next" click silently stays on the same page (the URL/fingerprint doesn't change).
        // Detect this and scrape any inline error messages so the recovery hint is specific.
        {
          const advAfterUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
          const advAfterFp = await this.pageFingerprint();
          // STRUCTURE, NOT TEXT. advBeforeFp/advAfterFp include body-text length, so a page
          // that merely re-rendered a results panel reads as advanced — see advanceSignatureOf.
          const advAfterSig = await advanceSignatureOf(this.page);
          const movedForward = (advAfterUrl && advAfterUrl !== advBeforeUrl)
            || (!!advBeforeSig && !!advAfterSig && advAfterSig !== advBeforeSig)
            || (!advBeforeSig && !!advAfterFp && advAfterFp !== advBeforeFp);
          if (!movedForward) {
            // A CONTROL THAT DID NOT MOVE THE PAGE MUST NOT BE CHOSEN AGAIN HERE.
            //
            // Miami's Property Search: the planner picked advance index 43 on page 3, page 4
            // and page 5 — the same control, three times, and the page never moved. Boston did
            // it eight times, Baltimore four. Stopping the loop (the repeat-page guard) stops
            // the waste; it does not get anybody past the page. Banning the control does,
            // because the fallback advance below then gets its turn on a DIFFERENT control —
            // on this page the real one is an icon-only magnifier the planner never names.
            //
            // Scoped to THIS page signature: the same label on a later page is a different
            // control and deserves its own chance.
            const deadKey = deadPageKey(url, fields.length);
            const label = String(advanceField.label ?? "").slice(0, 60);
            if (label) {
              const set = deadAdvances.get(deadKey) ?? new Set<string>();
              set.add(label);
              deadAdvances.set(deadKey, set);
              this.debug?.event({ type: "advance_did_nothing", page: pageCount, label, deadCount: set.size });
            }
            const blockers = await this.collectValidationErrors();
            if (blockers.length > 0) {
              this.debug?.event({ type: "validation_blocked", page: pageCount, errors: blockers.slice(0, 10) });
              lastValidationErrors = blockers;
              for (const b of blockers) if (!validationBlocks.includes(b)) validationBlocks.push(b);
              // Remove the advance step we just recorded — it didn't actually work.
              if (steps.length && steps[steps.length - 1].note?.startsWith("advance:")) steps.pop();
            }
            // THE MOMENT WE KNOW THE PAGE DID NOT MOVE is the moment to try the results row.
            //
            // The first version of this only ran when the planner offered NO advance or
            // repeated a KNOWN-DEAD one. Miami never gave it a turn: told btnSubmit was dead,
            // the planner just named a different control that also did nothing — 43, then 54,
            // then 56, three dead advances and three pages of budget, with the row it needed
            // to click sitting on screen the whole time.
            // A CONTROL THAT DID NOTHING WHILE IT WAS SHUT IS NOT A DEAD CONTROL.
            // "Start New Application" is display:none on Miami's search page until a parcel
            // is chosen. Clicked before the row, it does nothing and earns a ban; chosen
            // after, it is the way forward. The row click just moved the page, so the state
            // the ban was recorded against no longer exists — clear it and let the planner
            // pick that control again.
            if (blockers.length === 0 && await this.clickMatchingResultRow(_project, steps)) {
              deadAdvances.delete(deadKey);
              continue;
            }
          } else {
            lastValidationErrors = [];
          }
        }

        continue;
      }

      // No advance + not at review → nothing more we can do, UNLESS a create dialog is
      // waiting on its own Submit (see clickCreateDialogAdvance).
      if (await this.clickCreateDialogAdvance(steps)) continue;
      // ...OR THE NEXT BUTTON IS SITTING RIGHT THERE AND THE PLANNER DID NOT NAME IT.
      //
      // Twelve portals in the 59-portal benchmark recorded fills and never reached review,
      // and their stored traces all end the same way: a filled page, and `adv=-`. The walk
      // stops on a page it has just completed while the page still shows dozens of buttons
      // — ComEd ended on a form with 27 of them, Boston on one with 96. Whatever the planner
      // was doing, "no advance" was not true of the page.
      // BEFORE GIVING UP ON THIS PAGE: did it ask for a choice we could not make?
      {
        const choices = fields.filter((f) => f.fieldType === "checkbox" || f.fieldType === "radio");
        const filledHere = (plan.fills ?? []).length > 0;
        if (choices.length > 0 && !filledHere) {
          const offered = Array.from(new Set(choices
            .map((f) => String(f.label ?? "").replace(/\s+/g, " ").trim())
            .filter((t) => t && t.length <= 60))).slice(0, 8);
          const group = String(choices.find((f) => f.section)?.section ?? "").slice(0, 60);
          if (offered.length) {
            const line = `"${(redactStatusText(pageTitle) || "this page").slice(0, 40)}" required a choice and none of what it offered fits this job${group ? ` (group: ${group})` : ""}: ${offered.join(", ")}`;
            if (!unmatchedChoices.includes(line)) unmatchedChoices.push(line);
            this.debug?.event({ type: "no_matching_choice", page: pageCount, group, offered });
          }
        }
      }
      if (await this.clickFallbackAdvance(steps, fields)) continue;
      // A search page's control is often an icon with no name; Enter is what a person presses.
      if (await this.pressEnterInLastFilledField(steps, fields)) continue;
      // …and once the search has answered, the answer is the row.
      if (await this.clickMatchingResultRow(_project, steps)) { deadAdvances.delete(deadPageKey(url, fields.length)); continue; }

      // A TERMINAL PAGE WHOSE ONLY FORWARD CONTROL IS A FINAL SUBMIT IS ITS OWN REVIEW.
      //
      // Every way forward has now declined. Before giving up, ask the last question: is the
      // page not stuck but FINISHED? permiteyes.us is a 176-field SINGLE-PAGE application —
      // no Next, one "Submit" — and the walk filled ~60 fields, found no advance, hit the
      // repeat-page stop and banked 65 steps as needs_rerecord, which
      // findCompleteRecipeForProject then ignores. Every one-page portal fails the same way,
      // because the engine's only definition of "the end" was a review SCREEN.
      //
      // THIS IS AN INFERENCE, NOT AN AUTHORITY (hole 5). The delegated-click branch that
      // lives in step (e) above is deliberately NOT repeated here: there, the PLANNER named
      // the final submit on a page it recognised as review; here, the ENGINE concluded a page
      // is terminal from its shape. The step is recorded so a human can perform it, and
      // nothing clicks it — ever, under any flag. Hard rule 1, and the weaker the evidence the
      // more absolute the rule.
      {
        // A TERMINAL PAGE CANNOT PRECEDE THE FIRST RECORDED FILL. Same rule the entry-
        // disclaimer guard states in section c2, for the same reason: the live Salem run
        // stopped on page 2 and promoted an EMPTY recipe, because a page the walk typed
        // nothing into still had a submit-shaped control on it. clickFallbackAdvance has
        // carried this precondition ("a page we filled nothing on is a page we have no
        // business advancing past") since it was written; recording a FILING on such a page
        // is the same mistake with a worse ending. Terms/acknowledgment ticks do not count —
        // an agree box is not an application.
        const mutationsRecorded = steps.some(
          (s) => (s.action === "fill" || s.action === "check" || s.action === "select") && !isTermsAcknowledgment(s));
        if (!mutationsRecorded) {
          this.debug?.event({ type: "terminal_page_refused", page: pageCount, guard: "empty", why: "nothing has been filled on this run yet" });
          break;
        }
        const terminal = await this.terminalSubmitHere(pageCount);
        if (terminal) {
          // Same exit discipline as the atReview break: one more re-assert so the page we
          // leave carries what we typed. A portal that autosaves and takes values back has
          // done exactly that between the mid-page verify and here (live Ameren).
          await this.verifyFillsLanded(appliedThisPage, { budgetMs: 25_000, requiredOnly: true }).catch(() => [] as string[]);
          steps.push({
            action: "click",
            phase: "review",
            selector: terminal.field.selector,
            isFinalSubmit: true,
            note: `final submit: ${terminal.label || "submit"} (recorded, NOT clicked — single-page application)`,
          });
          finalSubmitRecorded = true;
          reachedReview = true;
          break;
        }
      }
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
      ? ` ⚠ ${fillVerifyMisses.length} required field(s) are blank in the portal.`
        + (missesDidNotHold.length ? ` TYPED BUT NOT KEPT (the portal took the value back): ${missesDidNotHold.slice(0, 8).join(", ")}.` : "")
        + (missesNeverFilled.length ? ` NEVER FILLED (nothing was typed): ${missesNeverFilled.slice(0, 8).join(", ")}.` : "")
        + " Re-check these before submit."
      : "";
    // The portal's own words, quoted. On a run that never reached review this is usually the
    // ONLY line that names a cause — the trace shows the same page seven times and the
    // validation channel is empty, because every advance "worked".
    // The portal says what is missing; this says what was on offer and why none of it fit.
    // Together they name the upstream choice that put the application on the wrong branch.
    const choiceWarning = unmatchedChoices.length > 0
      ? ` 🔀 ${unmatchedChoices.slice(0, 3).join(" | ")}. A choice made on an EARLIER page decides what these pages offer — check that one.`
      : "";
    const noticeWarning = portalNotices.length > 0
      ? ` 📣 The portal reported: ${portalNotices.slice(0, 5).join(" | ")}`
      : "";
    const message = reachedReview
      ? `${HUMAN_REVIEW_MESSAGE} Auto-learn reached the review screen after ${pageCount} page(s). Verify every field/value below before a human submits.${validationWarning}${docsWarning}${verifyWarning}${noticeWarning}${choiceWarning}`
      : filledSomething
        ? `Auto-learn filled ${pageCount} page(s) and recorded the steps, but did not reach a review screen. Page trace: ${traceLine}${validationWarning}${docsWarning}${verifyWarning}${noticeWarning}${choiceWarning}`
        : `Auto-learn found nothing fillable on ${pageCount} page(s); no steps recorded.${nothingFillableHint} Page trace: ${traceLine}${validationWarning}${docsWarning}${verifyWarning}${noticeWarning}${choiceWarning}`;

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
      pageTrace: pageTrace.slice(0, 40),
      filledSomething,
      // Where this run actually ended up, query string and all — the only reliable handle
      // for auditing THIS application afterwards rather than some other draft of the same
      // customer's that happens to sit higher in the portal's list.
      applicationUrl: (() => { try { return typeof this.page?.url === "function" ? this.page.url() : undefined; } catch { return undefined; } })(),
      requiredFieldMisses: fillVerifyMisses,
      missingRequiredDocs,
      validationBlocks,
      portalNotices: portalNotices.length ? portalNotices.slice(0, 5) : undefined,
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
    // A VISIBLE LOADING MASK MEANS THE PAGE IS STILL BECOMING WHAT IT WILL BE. ACA's ASP.NET
    // postbacks paint a "Please wait..." overlay while the partial render is in flight, and it
    // outlives networkidle. Live on Marineau's structural learn: the city row's services —
    // "City of Coos Bay (7 services found)", Residential - Structural among them — were mid-
    // render behind that overlay when extraction ran, so the record-type pass saw none of
    // them and the planner was handed a page without its own answer on it. Extraction must
    // not read a page that says it is not finished. Portal-agnostic (text + the common mask
    // classes), bounded, and never throws.
    if (typeof this.page.evaluate === "function") {
      for (let i = 0; i < 40; i++) { // ~10s cap
        const busy = await this.page.evaluate(() => {
          const vis = (e: Element) => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          for (const el of Array.from(document.querySelectorAll("div, span, [role='status'], [aria-busy='true']"))) {
            if (!vis(el)) continue;
            const t = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
            if (t && t.length < 60 && /^(please wait|loading|processing)(\s|\.|…|$)/i.test(t)) return true;
          }
          return false;
        }).catch(() => false);
        // Strict true only: a test fake's evaluate() answers every call with its own shape
        // (an empty array is truthy), and anything but a positive "the mask is up" must not
        // hold extraction hostage.
        if (busy !== true) break;
        await sleep(250);
      }
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
  /**
   * The select-shaped twin of applyPolicyDefaults' radio walk: answer a policy question
   * rendered as a dropdown. Only touches a select that is UNANSWERED (empty or a
   * "Select..." placeholder), so a portal that already carries an answer is left alone.
   */
  private async applyPolicySelect(
    policy: { question: RegExp; answer: "Yes" | "No" },
    alreadyFilledLabels: string[],
  ): Promise<{ step: RecipeStep; applied: AppliedFill } | null> {
    if (!this.page || typeof this.page.evaluate !== "function") return null;
    const found = await this.page.evaluate(
      (args: { qSource: string; answer: string }) => {
        const norm = (s: string | null | undefined) => (s || "").trim().replace(/\s+/g, " ");
        const question = new RegExp(args.qSource, "i");
        const wanted = args.answer.trim().toLowerCase();
        const selects = Array.from(document.querySelectorAll("select")) as HTMLSelectElement[];
        for (const sel of selects) {
          const id = sel.getAttribute("id") || "";
          const lbl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
          const own = norm(lbl?.textContent || sel.getAttribute("aria-label") || "");
          const grp = sel.closest("fieldset, .form-group, [class*='form-group'], [class*='field'], .row, [class*='row']");
          if (!question.test(own) && !question.test(norm(grp?.textContent || ""))) continue;
          const current = norm(sel.options[sel.selectedIndex]?.textContent || "");
          const placeholder = !current || /^(please\s+)?select\.{0,3}$/i.test(current);
          if (!placeholder) return { answered: true as const };
          const match = Array.from(sel.options).find((o) => norm(o.textContent).toLowerCase() === wanted);
          if (!match || !id) return null;
          return { id, optionText: norm(match.textContent), label: own || norm(grp?.textContent || "").slice(0, 80) };
        }
        return null;
      },
      { qSource: policy.question.source, answer: policy.answer },
    ).catch(() => null) as { answered?: true; id?: string; optionText?: string; label?: string } | null;

    if (!found || found.answered || !found.id || !found.optionText) return null;
    const groupLabel = (found.label || `policy:${policy.answer}`).slice(0, 80);
    if (alreadyFilledLabels.includes(groupLabel)) return null;
    const selector: RecipeSelector = { css: `#${found.id}` };
    const loc = await this.locator(selector);
    if (!loc) return null;
    const res = await safeAction(
      groupLabel.slice(0, 40),
      async () => { await selectWithFallback(this.page, loc, found.optionText as string); },
      { required: false },
    );
    if (!res.ok || res.message) return null;
    alreadyFilledLabels.push(groupLabel);
    return {
      step: {
        action: "select",
        phase: "fill",
        selector,
        value: found.optionText,
        note: `policy default: ${groupLabel} → ${policy.answer}`,
      },
      applied: {
        selector,
        label: groupLabel,
        fieldType: "select",
        expected: found.optionText,
        sensitive: false,
        required: true,
      },
    };
  }

  // A DISAMBIGUATION GRID IS A CHOICE ABOUT WHOSE PROPERTY WE ARE FILING ON.
  //
  // Permit portals answer an address search with several rows for the same street address —
  // one per issuing jurisdiction, each a different parcel with its own owner — and the permit
  // types on offer differ per row. Left to the planner this is a guess, and it guessed wrong
  // repeatedly on Coos Bay: it selected "DEQ Applications", which issues onsite/septic and
  // nothing else, and the run then sat on "No Building services were returned for this
  // address" re-planning the same page until it gave up.
  //
  // The hand-coded Accela adapter already had this discipline, but auto-learn OUTRANKS the
  // hand-coded adapters in the staging precedence, so that code never ran. Hence here.
  //
  // The rejection matters more than the ordering: the street search is loose enough that
  // "119 7th" returns four other towns, and opening an application against a stranger's house
  // is not something a later step can undo. Rows outside this project's city/ZIP are refused
  // outright; among this property's own versions, order is a hint (the operator's rule is that
  // one record often carries both disciplines).
  private async chooseProjectAddressRow(steps: RecipeStep[]): Promise<boolean> {
    if (this.addressRowChosen || !this.siteIdentity) return false;
    if (!this.page || typeof this.page.evaluate !== "function") return false;
    const id = this.siteIdentity;
    if (!id.city && !id.zip) return false; // nothing to verify identity against — don't guess

    const rows = await this.page.evaluate(() => {
      const vis = (e: Element) => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const out: Array<{ key: string; text: string }> = [];
      let n = 0;
      for (const tr of Array.from(document.querySelectorAll("tr"))) {
        if (!vis(tr)) continue;
        const actions = Array.from(tr.querySelectorAll("a, button, [role='button']"))
          .filter((a) => /^\s*select\s*$/i.test((a as HTMLElement).innerText || ""));
        // ONE action means one address version. None means this row is not a result; SEVERAL
        // means it is the wrapper <tr> that ACA's outer layout table puts around the whole
        // grid — counting its actions identifies it exactly, where a text-length cap only
        // guesses (and a short grid slips straight through).
        if (actions.length !== 1) continue;
        const action = actions[0];
        const text = ((tr as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 400) continue; // belt-and-braces on the same wrapper
        const key = `ar${n++}`;
        (action as HTMLElement).setAttribute("data-al-row", key);
        out.push({ key, text });
      }
      return out;
    }).catch(() => [] as Array<{ key: string; text: string }>);

    if (rows.length < 2) return false; // one row (or none) is not a choice

    const { ranked, rejected } = rankAddressVersions(rows.map((r) => r.text), {
      city: id.city, zip: id.zip, homeownerName: id.homeownerName, isElectrical: id.isElectrical === true,
    });
    if (ranked.length === 0) {
      this.debug?.event({ type: "address_row_refused", why: "no result is this project's property", rejected: rejected.slice(0, 3).join(" | ").slice(0, 200) });
      return false;
    }
    const best = rows[ranked[0].index];
    if (!best) return false;
    const css = `[data-al-row="${best.key}"]`;
    const clicked = await this.page.locator(css).first().click({ timeout: 12000 }).then(() => true).catch(() => false);
    if (!clicked) return false;
    this.addressRowChosen = true;
    await this.waitForDynamicFieldsSettle().catch(() => null);
    this.debug?.event({
      type: "address_row_chosen",
      // Jurisdiction words and whether the owner matched — never the address itself.
      jurisdiction: (ranked[0].text.match(/(CITY|COUNTY|DEQ)\s+APPLICATIONS/i) || [])[0] || "unlabelled",
      ownerMatched: ranked[0].ownerHit,
      considered: ranked.length,
      rejected: rejected.length,
    });
    steps.push({
      action: "click",
      phase: "fill",
      selector: { css, fallbacks: [{ role: "link", name: "Select" }] },
      note: `address version: ${(ranked[0].text.match(/(CITY|COUNTY|DEQ)\s+APPLICATIONS/i) || ["this property"])[0]}`,
    });
    return true;
  }

  // AN "OTHER — PLEASE SPECIFY" BOX BECOMES REQUIRED THE MOMENT ITS PARENT SAYS "Other".
  //
  // Coos Bay's electrical application sets Category of Construction = Other, which reveals a
  // required "* Other Category of Construction:" text box. The planner never fills it: it is
  // not on the page when the plan is made, and nothing in the project data is named after it.
  // The portal then refuses to advance ("Please enter a Category of Construction") and the run
  // loops on one page until it gives up — live, pages 10 through 14 were the same page.
  //
  // The sweep already NOTICES the blank; noticing is not filling. This pattern ("Other …",
  // "If other, specify", "Other (please specify)") is one of the most common on permit forms,
  // and for this product the answer is always the same: the work is solar. Deterministic and
  // portal-agnostic — no policy profile gate, because it is a form convention, not NEM policy.
  // A REQUIRED "Email" BOX IS ANSWERED BY THE SECTION IT SITS IN, NOT BY ITS LABEL.
  //
  // Live on Marineau's PacifiCorp interconnection: page 3 "Customer Information" and page 5
  // "Installer Information" each render a bare, required `Email *`, and the planner left both
  // blank — the same failure shape as PowerClerk's bare "Manufacturer"/"Model", where the role
  // comes from the SECTION and four characters of label cannot carry it. Page 4 "Property
  // Owner Information" then mirrored the customer block read-only, so one blank showed up as
  // two, and the portal refuses the filing over a field whose value we hold all along.
  //
  // So: match on the SECTION HEADING above the control, and fill from the identity that
  // heading names. Only a REQUIRED, still-EMPTY, visible box — never an overwrite, never a
  // guess when the heading is unrecognised.
  private async fillSectionEmails(steps: RecipeStep[], alreadyFilledLabels: string[]): Promise<number> {
    if (!this.page || typeof this.page.evaluate !== "function") return 0;
    const owner = String(this.siteContactIdentity?.email || "").trim();
    const installer = String(this.contactIdentity?.email || "").trim();
    if (!owner && !installer) return 0;

    const targets = await this.page.evaluate(() => {
      const out: Array<{ key: string; heading: string; label: string }> = [];
      let n = 0;
      const nodes = Array.from(document.querySelectorAll('input[type="email"], input[type="text"], input:not([type])')) as HTMLInputElement[];
      for (const el of nodes) {
        if ((el.value || "").trim()) continue;          // answered already — never overwrite
        if (el.disabled || el.readOnly) continue;       // a mirrored block is not ours to fill
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const id = el.getAttribute("id") || "";
        let label = id ? ((document.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLElement | null)?.innerText || "") : "";
        if (!label) label = (el.closest("label") as HTMLElement | null)?.innerText || "";
        if (!label) label = el.getAttribute("placeholder") || "";
        label = label.replace(/\s+/g, " ").trim();
        if (!/^\*?\s*e-?mail\b/i.test(label)) continue;
        // REQUIRED only: the portal's own asterisk, or the attribute.
        const wrap = el.closest("td, div, li, fieldset") as HTMLElement | null;
        const required = el.hasAttribute("required") || el.getAttribute("aria-required") === "true"
          || /\*/.test(label) || /\*/.test((wrap?.innerText || "").slice(0, 120));
        if (!required) continue;
        // The nearest heading ABOVE this control — the section that says whose email this is.
        let heading = "";
        for (let node: Element | null = el; node && !heading; node = node.parentElement) {
          let sib: Element | null = node.previousElementSibling;
          for (; sib && !heading; sib = sib.previousElementSibling) {
            const t = ((sib as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
            if (t && t.length < 80 && /information|contact|details/i.test(t)) heading = t;
          }
        }
        out.push({ key: `em${n++}`, heading, label });
        el.setAttribute("data-al-email", `em${n - 1}`);
      }
      return out;
    }).catch(() => [] as Array<{ key: string; heading: string; label: string }>);

    let filled = 0;
    for (const t of (Array.isArray(targets) ? targets : [])) {
      if (!t || typeof t.key !== "string") continue;
      const h = String(t.heading || "");
      // Customer / account holder and property owner are both the homeowner's address on a
      // residential job; installer is the filing contractor. An unrecognised heading is left
      // alone — a wrong email on an interconnection is worse than a blank one a human fills.
      const value = /installer|contractor/i.test(h) ? installer
        : /customer|property owner|applicant|generation system owner|site/i.test(h) ? owner
        : "";
      if (!value) {
        // Say WHICH absence this is: a recognised section whose identity carries no email is
        // a data gap upstream, not a heading-matching miss — the first live skip event
        // blamed the heading and sent the diagnosis the wrong way.
        const recognised = /installer|contractor|customer|property owner|applicant|generation system owner|site/i.test(h);
        this.debug?.event({
          type: "section_email_skipped",
          heading: h.slice(0, 60),
          why: !h ? "no section heading found" : recognised ? "identity carries no email for this section" : "heading not recognised",
        });
        continue;
      }
      const css = `[data-al-email="${t.key}"]`;
      const ok = await this.page.locator(css).first().fill(value, { timeout: 8000 }).then(() => true).catch(() => false);
      if (!ok) continue;
      await this.page.locator(css).first().blur?.().catch(() => null);
      filled++;
      alreadyFilledLabels.push(t.label);
      this.debug?.event({ type: "section_email_filled", heading: h.slice(0, 60), role: /installer|contractor/i.test(h) ? "installer" : "owner" });
      steps.push({
        action: "fill",
        phase: "fill",
        selector: { css, fallbacks: [{ role: "textbox", name: t.label }] },
        // BOUND, never literal: recipes are shared, so a replay must use ITS project's email.
        field: /installer|contractor/i.test(h) ? "installerEmail" : "homeownerEmail",
        note: `section email: ${h.slice(0, 40) || "contact"}`,
      });
    }
    return filled;
  }

  private async fillOtherSpecifyFields(steps: RecipeStep[], alreadyFilledLabels: string[]): Promise<number> {
    if (!this.page || typeof this.page.evaluate !== "function") return 0;
    const OTHER_SPECIFY = /other\s+(category|type|description|use|construction)|please\s+specify|if\s+other|other\s*\(\s*specify/i;
    const targets = await this.page.evaluate((src: string) => {
      const re = new RegExp(src, "i");
      const out: Array<{ key: string; label: string }> = [];
      let n = 0;
      const nodes = Array.from(document.querySelectorAll('input[type="text"], input:not([type]), textarea')) as HTMLInputElement[];
      for (const el of nodes) {
        if ((el.value || "").trim()) continue; // already answered — never overwrite
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue; // hidden twin of a revealed field
        const id = el.getAttribute("id") || "";
        let label = id ? ((document.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLElement | null)?.innerText || "") : "";
        if (!label) label = (el.closest("label") as HTMLElement | null)?.innerText || "";
        if (!label) {
          const cell = el.closest("td, div, li");
          const prev = cell?.previousElementSibling as HTMLElement | null;
          if (prev && (prev.innerText || "").length < 120) label = prev.innerText || "";
        }
        label = label.replace(/\s+/g, " ").trim();
        if (!re.test(label)) continue;
        // Only a REQUIRED one. An optional "other notes" box is not ours to invent an answer for.
        const wrap = el.closest("td, div, li, fieldset") as HTMLElement | null;
        const required = el.hasAttribute("required") || el.getAttribute("aria-required") === "true"
          || /\*/.test(label) || /\*/.test((wrap?.innerText || "").slice(0, 100));
        if (!required) continue;
        const key = `os${n++}`;
        el.setAttribute("data-al-other", key);
        out.push({ key, label: label.slice(0, 80) });
      }
      return out;
    }, OTHER_SPECIFY.source).catch(() => [] as Array<{ key: string; label: string }>);

    let filled = 0;
    // Whatever comes back from a page's evaluate() is the PAGE's word, not ours — a portal that
    // returns a shape we didn't ask for must cost us this one convenience, not the whole learn.
    const wellFormed = (Array.isArray(targets) ? targets : [])
      .filter((t) => t && typeof t.key === "string" && typeof t.label === "string");
    for (const t of wellFormed) {
      if (alreadyFilledLabels.includes(t.label)) continue;
      const css = `[data-al-other="${t.key}"]`;
      const okFill = await this.page.locator(css).first()
        .fill(OTHER_SPECIFY_VALUE, { timeout: 8000 }).then(() => true).catch(() => false);
      if (!okFill) continue;
      await this.page.locator(css).first().blur?.().catch(() => null);
      filled++;
      alreadyFilledLabels.push(t.label);
      this.debug?.event({ type: "other_specify_filled", label: t.label.slice(0, 60), value: OTHER_SPECIFY_VALUE });
      steps.push({
        action: "fill",
        phase: "fill",
        selector: { css, fallbacks: [{ role: "textbox", name: t.label }] },
        value: OTHER_SPECIFY_VALUE,
        note: `other-specify: ${t.label}`,
      });
    }
    return filled;
  }

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

        // A POLICY QUESTION IS NOT ALWAYS A RADIO GROUP. PacifiCorp asks the same
        // disconnect-distance question as a three-option <select>, so the radio walk above
        // finds nothing, the required field is left blank, and the portal refuses
        // "compute totals: Calculate" 113 steps into the run. Same policy, same answer,
        // different control — so try the select shape before giving up on this question.
        if (!target) {
          const picked = await this.applyPolicySelect(policy, alreadyFilledLabels);
          if (picked) out.push(picked);
          continue;
        }
        if ((target as { answered?: boolean }).answered) continue;
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

    // DETERMINISTIC GUARD: WHICH PERMIT WE APPLY FOR IS NOT A PLANNER CHOICE.
    //
    // Live on Ann Marineau's STRUCTURAL learn at Coos Bay: the planner ticked a record-type
    // box and the step went into the recipe as label "Residential - Electrical" over control
    // cbListServices_1. The city's list has no Electrical — that discipline files with the
    // county — and index 1 there is Residential - Mechanical. A Residential MECHANICAL permit
    // was filed on a solar job at 1780 Ocean Blvd and issued, fees paid. The run's own audit
    // caught it only afterwards, in a note: "Fee schedule is Residential Mechanical, but the
    // project is a roof-mounted solar PV system".
    //
    // Record type is project data, not a judgement call: the discipline is on the request. So
    // the deterministic pass (accelaRecordTypePass) owns this control, and a planner pick that
    // contradicts the discipline is refused — nothing checked, nothing recorded, so no recipe
    // can inherit it. A solar/PV-specific type is always allowed: that IS the right answer
    // wherever an AHJ offers one.
    if (isCheckable && RECORD_TYPE_LABEL.test(field.label || "") && this.permitDiscipline) {
      const label = field.label || "";
      const wantElectrical = /elec/i.test(this.permitDiscipline);
      const isSolarType = /solar|photovoltaic|\bpv\b/i.test(label);
      const matchesDiscipline = wantElectrical
        ? /electrical/i.test(label)
        : /structural|building/i.test(label);
      if (!isSolarType && !matchesDiscipline) {
        this.debug?.event({
          type: "record_type_refused",
          label: label.slice(0, 70),
          discipline: this.permitDiscipline,
          why: "the offered type is a different permit discipline than this filing",
        });
        return null;
      }
    }

    // DETERMINISTIC GUARD: never check an "Alternative Billing Contact"-style checkbox.
    // Unchecked routes the portal's invoice to the installer email on file — the correct
    // default — while checking it demands an alternative email the project data doesn't
    // carry; the planner has been seen ticking it anyway, and the resulting contradiction
    // (checked box, no alt email) blocks the recipe trust gate on every run.
    if (field.fieldType === "checkbox" && /alternative\s+billing/i.test(field.label || "")) return null;

    // DETERMINISTIC GUARD: A SYSTEM WITHOUT A BATTERY NEVER DECLARES ONE.
    //
    // Live on Ivy's PacifiCorp interconnection: the project carries hasBattery = "No" and a
    // plan set with 8 modules and 4 microinverters, and the planner ticked "This system
    // includes battery storage" anyway. That tick reveals a block of REQUIRED battery fields,
    // which the gap-fill then answered with textbook numbers — 13.5 kWh, 11.5 kW, 89%
    // round-trip. Those are a Powerwall's specifications, not this customer's, and they were
    // on their way to a utility as fact.
    //
    // The planner is given hasBattery and still got it wrong, so this cannot be a prompt: a
    // declaration about what EXISTS on the roof is project data, never a judgement call.
    // Guarded only when the project explicitly says No — unknown stays the planner's call.
    if (this.hasBattery === false) {
      const label = field.label || "";
      const declaresBattery = /\b(includes?|has|with)\b[^.]{0,40}\b(batter(y|ies)|energy storage|\bess\b|storage system)\b/i.test(label)
        || /^\s*(battery|energy)\s*storage\b/i.test(label);
      if (field.fieldType === "checkbox" && declaresBattery) {
        this.debug?.event({ type: "battery_declaration_refused", label: label.slice(0, 70) });
        return null;
      }
      // And never invent the specifications of equipment that is not there. If the box got
      // ticked some other way, the fields it reveals still go unanswered rather than fabricated.
      //
      // A PROGRAM question is not a specification. "Will you be participating in the Wattsmart
      // Battery Program?" asks about a utility programme and is REQUIRED of every applicant,
      // battery or not — refusing it left it blank and PacifiCorp rejected the submission for
      // it by name. The replay guard already carried this exemption; this one did not, which
      // is how a guard against inventing data became a guard against answering a question.
      const isProgramQuestion = /\bprogram\b/i.test(label);
      const isBatterySpec = !isProgramQuestion
        && /\bbatter(y|ies)\b|\benergy storage\b|\bess\b|round-?trip|state of charge/i.test(label);
      if (isBatterySpec && field.fieldType !== "checkbox") {
        this.debug?.event({ type: "battery_spec_refused", label: label.slice(0, 70) });
        return null;
      }
    }

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
          // …EXCEPT FOR A DROPDOWN WIDGET'S BACKING INPUT, WHICH IS MEANT TO BE INVISIBLE.
          //
          // Miami's Job Category is <input id="JobCategoryID" style="display:none"> behind a
          // Telerik dropdown. The extractor correctly calls it a select, the option list is
          // read, the planner answers "STAND-ALONE" — an exact match — and this gate threw
          // before selectWithFallback ever ran, three visits in a row, logging
          // "hidden_field_skipped: Job Category" each time. The widget's visible face is the
          // control; selectWithFallback already knows to click it.
          const widgetBacked = field.fieldType === "select"
            && typeof loc.evaluate === "function"
            && await loc.evaluate(hasVisibleWidgetFaceInPage).catch(() => false);
          if (!widgetBacked) {
            // INVISIBLE USUALLY MEANS NOBODY HAS OPENED THIS YET — see revealHidden.ts.
            // Momentum skipped "Licenses & Permits" as hidden on three consecutive pages,
            // clicked advance each time, and never moved: the field it would not fill was
            // the gate. Try once to open whatever is holding it shut before giving up.
            const revealed = await this.tryRevealHidden(loc, field);
            if (!revealed) {
              this.debug?.event({ type: "hidden_field_skipped", label: (field.label || "").slice(0, 60) });
              throw new Error("control is not visible (hidden field)");
            }
          }
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
    // A SECRET IS FREE TEXT, NEVER A CHOICE FROM A FIXED LIST.
    //
    // SENSITIVE_LABEL makes the identifier suffix optional ("meter\s*(number|no|#)?"), so a
    // bare "meter" matches — and PacifiCorp's meter PAGE is full of Yes/No questions that
    // merely mention one: "Will there be a Meter Mounted Device (MMD)", "Is this meter
    // located inside a garage/residence/facility?", "Possible meter access issues?",
    // "...meter aggregation...". Each was redacted as a secret, so its answer was recorded
    // as "" with no field to bind — a dead step filling nothing on every future replay.
    // Live consequence: those REQUIRED questions stayed blank and PacifiCorp refused the
    // page, quoting them straight back at us.
    //
    // Narrowed for RECORDING only. Redaction of what we SEND the planner is unchanged and
    // stays deliberately broad, because under-redacting an account number is the worse
    // failure. An account number is not a dropdown, so keeping a select/radio/checkbox
    // answer leaks nothing.
    const answerComesFromFixedOptions = field.fieldType === "select" || field.fieldType === "radio" || field.fieldType === "checkbox";
    if (sensitive && !answerComesFromFixedOptions) {
      // Password fields are login credentials handled by the login step — never record as
      // a form fill step (the planner may send one but we drop it here to avoid replaying
      // a stored blank into a plain-text login form on review/settings pages).
      if (/\bpassword\b|\bpasscode\b/i.test(field.label)) return null;
      // NEVER store the literal value of a sensitive field.
      step.sensitive = true;
      step.value = "";
      step.field = fillReq.field || undefined;
    } else if (fillReq.field && (!this.bindableFields.size || this.bindableFields.has(fillReq.field))
      && !(answerComesFromFixedOptions && IDENTIFIER_FIELDS.has(String(fillReq.field)))) {
      // Data-bound to a project/client field — resolved at replay time.
      step.field = fillReq.field;
    } else if (fillReq.field) {
      // The planner picked a field name a REPLAY cannot resolve. Binding it would make this
      // step fill "" on every future project, silently, forever. Keep the literal actually
      // filled instead: for the portal-policy questions this happens on ("Description of
      // Service"), the learn-time answer is the right constant anyway, and a frozen literal
      // that fills beats a binding that never will.
      this.debug?.event({ type: "unbindable_field_refused", field: String(fillReq.field), label: String(field.label ?? "").slice(0, 60) });
      if (action !== "check") step.value = value;
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
  private async verifyFillsLanded(applied: AppliedFill[], opts?: { budgetMs?: number; requiredOnly?: boolean }): Promise<string[]> {
    const misses: string[] = [];
    // A RE-ASSERT PASS IS A SAFETY NET, NOT A SECOND FILL PHASE. Unbounded, the exit pass
    // spent FIFTEEN MINUTES on Miami's Contact Information — 21 applied fills, each
    // re-locating, re-typing against a 5s timeout and re-reading on a page that keeps
    // re-rendering — and ate the whole run's budget. Ameren survived it only because its
    // pages carry fewer fills. Callers that run at a page EXIT pass a budget and ask for
    // required fields only: those are the ones a blank actually blocks.
    const deadline = opts?.budgetMs ? Date.now() + opts.budgetMs : Infinity;
    for (const a of applied) {
      if (Date.now() > deadline) {
        this.debug?.event({ type: "reassert_budget_spent", checked: applied.indexOf(a), of: applied.length });
        break;
      }
      if (opts?.requiredOnly && !a.required) continue;
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
  // A CREATE DIALOG'S "SUBMIT" CREATES THE RECORD — IT DOES NOT FILE THE APPLICATION.
  //
  // ComEd's ConnectTheGrid opens a "New Application" drawer whose only forward control is
  // labelled "Submit": pick Distributed Generation, name the project, Submit, and the real
  // application form opens. The planner will never nominate a submit-shaped control (rightly
  // — rule 1 is that automation never files), so the run filled the drawer and then stopped
  // with no advance at all, which is why ComEd's list still reads "No applications were
  // found" after every run. Nothing had ever been created to save.
  //
  // The exception is deliberately a conjunction, because getting it wrong means filing an
  // application with a utility. All of these must hold:
  //   - the control is inside a VISIBLE OVERLAY, never the main document (a real final
  //     submit lives on the page/review screen, not in a creation drawer);
  //   - the dialog is ENTRY-ORIGINATED — we opened it during the start-an-application pass;
  //   - its heading reads as create-intent ("New Application", "Start Request");
  //   - it carries NO filing language: no certification, no "by submitting", no terms gate,
  //     none of the review markers that mark a real submit screen;
  //   - it is not a pay/fee control, which stays absolute.
  // Recorded as a plain advance (never isFinalSubmit) so replay performs it, and the caller's
  // page fingerprint still decides whether it actually moved.
  private createDialogSubmits = 0;

  /** THE MOST UNIVERSAL SUBMIT ON THE WEB: ENTER, IN THE FIELD YOU JUST TYPED INTO.
   *
   *  A search page advances by SEARCHING, and its control is very often an icon: a bare
   *  magnifier with no text, no value and frequently no accessible name. The planner cannot
   *  name what has no name, and the fallback finder matches on wording, so both walk past it.
   *
   *  Measured on City of Miami's iBuild Property Search — a toolbar with a dropdown, a text
   *  box and a blue magnifier. The address went in correctly and nothing ever ran the search,
   *  so the results panel stayed on its instructions and the walk had nothing to click.
   *
   *  Enter costs one keypress and is what a person does. Bounded to a field this run actually
   *  filled on THIS page, so it can never fire on a page we have not touched, and it reports
   *  itself — a search that runs and returns nothing is a different problem from one that
   *  never ran, and they have looked identical. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async pressEnterInLastFilledField(steps: RecipeStep[], fields: any[]): Promise<boolean> {
    if (!this.page || !Array.isArray(fields)) return false;
    // ENTER ON AN APPLICATION FORM CAN FILE IT. This fallback exists for SEARCH pages whose
    // submit is an unnamed icon (Miami's property magnifier) — a page with one or two text
    // boxes. On permiteyes.us the walk pressed Enter on a 176-field single-page permit
    // application: Enter triggered the form's own submit, the page went to about:blank, and
    // on a live application that keystroke would have FILED it. Automation never submits, so
    // this only ever runs where a person would press Enter — a search, not an application.
    const fillableCount = fields.filter((f: { fieldType?: string }) =>
      f?.fieldType === "text" || f?.fieldType === "select").length;
    if (fillableCount > 5) {
      this.debug?.event({ type: "enter_submit_refused_not_search", fillable: fillableCount });
      return false;
    }
    const lastFill = [...steps].reverse().find((st) => st.phase === "fill" && String(st.action) === "fill");
    if (!lastFill?.selector) return false;
    const beforeSig = await advanceSignatureOf(this.page);
    const beforeUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
    const loc = await this.locator(lastFill.selector).catch(() => null);
    if (!loc) return false;
    const pressed = await loc.press("Enter").then(() => true).catch(() => false);
    if (!pressed) return false;
    await this.waitAfterClick(beforeUrl, await this.pageFingerprint(), this.tabCount()).catch(() => null);
    const afterSig = await advanceSignatureOf(this.page);
    const afterUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
    const moved = (afterUrl && afterUrl !== beforeUrl) || (!!beforeSig && !!afterSig && afterSig !== beforeSig);
    if (!moved) {
      this.debug?.event({ type: "enter_submit_did_nothing", note: String(lastFill.note ?? "").slice(0, 40) });
      return false;
    }
    steps.push({
      action: "press",
      phase: "fill",
      selector: lastFill.selector,
      value: "Enter",
      note: `submit by Enter: ${String(lastFill.note ?? "search").slice(0, 44)}`,
    });
    this.debug?.event({ type: "enter_submit", note: String(lastFill.note ?? "").slice(0, 40) });
    return true;
  }

  /** THE SEARCH ANSWERED, AND THE ANSWER IS A ROW.
   *
   *  Miami's Property Search finds the parcel and renders one result row whose only
   *  clickable thing is a <td> the portal underlined and coloured blue. No link, no button,
   *  no onclick attribute — a grid handler bound in script. EXTRACT_SEL cannot see it, so
   *  the planner is never offered it and picks the nearest submit-shaped thing instead: one
   *  of two display:none <input type=submit id="btnSubmit">, which does nothing, four times.
   *
   *  Runs only as a fallback, after an advance has already proven dead or none was offered.
   *  The row must contain every word of this project's address — matching by property, not
   *  by position — and more than one surviving row is a refusal, because clicking the wrong
   *  one files against the wrong parcel.
   *
   *  Recorded with a bound note rather than a frozen selector: a recipe is shared across
   *  projects, and replay re-runs the same match against ITS project's address. */
  private async clickMatchingResultRow(project: ProjectRecord, steps: RecipeStep[]): Promise<boolean> {
    if (!this.page || typeof this.page.evaluate !== "function") return false;
    const want = parseStreetLine(String(project.projectAddress ?? ""), project.city || undefined);
    if (!want || want.split(/\s+/).length < 2) return false;
    const beforeSig = await advanceSignatureOf(this.page);
    const beforeUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
    const beforeFp = await this.pageFingerprint();
    const raw = await this.page.evaluate(markAddressRow, { want }).catch(() => null) as unknown;
    // Same rule as collectPortalNoticesFrom: a page that answers every evaluate with one
    // canned object would otherwise have this reporting a row it never found, and clicking
    // whatever the marker selector happened to resolve to.
    const pick = raw && typeof raw === "object" && typeof (raw as AddressRowPick).text === "string"
      ? raw as AddressRowPick
      : null;
    if (!pick) return false;
    const target = this.page.locator('[data-al-resultrow="1"]').first();
    if (!(await target.count().catch(() => 0))) return false;
    const clicked = await this.clickResilient(target).then(() => true).catch(() => false);
    if (!clicked) {
      this.debug?.event({ type: "result_row_click_failed", via: pick.via, text: pick.text.slice(0, 60) });
      return false;
    }
    await this.waitAfterClick(beforeUrl, beforeFp, this.tabCount()).catch(() => null);
    const afterSig = await advanceSignatureOf(this.page);
    const afterUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
    const moved = (afterUrl && afterUrl !== beforeUrl) || (!!beforeSig && !!afterSig && afterSig !== beforeSig);
    if (!moved) {
      // Say which of the two it was. "The row was not there" and "the row was there and the
      // click did nothing" are different defects and have looked identical in every run.
      this.debug?.event({ type: "result_row_did_nothing", via: pick.via, text: pick.text.slice(0, 60) });
      return false;
    }
    steps.push({
      action: "click",
      phase: "fill",
      // The marker attribute exists only for the click that just happened; the note is what
      // replay reads, and pickAddressRow re-derives the row from the replay project's own
      // address. Recording the literal row text would file every future job against this
      // project's parcel.
      // A SELECTOR THAT CANNOT ACCIDENTALLY SUCCEED. Replay tries the recorded selector
      // first and only falls back to the address matcher when it fails, so a broad
      // "tr, [role=row], li" would resolve to the FIRST row on the page — the header, whose
      // sort link is a real clickable — report success, and never run the matcher at all.
      // This marker exists only during the learn click, so replay always reaches the
      // matcher, which re-derives the row from ITS project's address.
      selector: { css: '[data-al-resultrow="1"]' },
      note: `address row: pick the search result matching this project's address (learned on "${pick.text.slice(0, 40)}")`,
    });
    this.debug?.event({ type: "result_row_clicked", via: pick.via, matched: pick.matched, text: pick.text.slice(0, 60) });
    return true;
  }

  /** THE NEXT BUTTON THE PLANNER DID NOT NAME.
   *
   *  Used only as a last resort: the page is not review, the planner offered no advance,
   *  and the create-dialog path found nothing. Curated wording rather than a guess, and
   *  deliberately NARROWER than the planner is allowed to be:
   *
   *    - never anything matching SUBMIT_INTENT. That excludes "Submit", "Finish",
   *      "Finalize" AND Accela's "Continue Application", which is the page advance on
   *      every page but the last, where it FILES. Losing a legitimate advance is a page we
   *      do not learn; clicking a submit is a filing nobody authorised, and only one of
   *      those is recoverable.
   *    - never a pay/fee control, via the same isOffLimitsButton the planner path uses.
   *    - only when this page actually took a value. A page we filled nothing on is a page
   *      we have no business advancing past. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async clickFallbackAdvance(steps: RecipeStep[], fields: any[]): Promise<boolean> {
    if (!this.page || !Array.isArray(fields) || !fields.length) return false;
    const filledHere = steps.some((st) => st.phase === "fill" && ["fill", "select", "check"].includes(String(st.action)));
    if (!filledHere) return false;
    // ADVANCE_ONLY now lives at module scope: the active-scope exit exemption re-admits a
    // control OUTSIDE the open panel only when it matches this, so if the two copies drifted
    // the exemption would hand back a control this finder then refused — a page with a
    // visible Next and no way to click it.
    const candidate = fields.find((f: { label?: string; kind?: string }) => {
      const label = String(f?.label ?? "").trim();
      if (!label || label.length > 40) return false;
      if (!ADVANCE_ONLY.test(label)) return false;
      if (PAGINATION_CONTROL.test(label)) return false;
      if (SUBMIT_INTENT.test(label)) return false;
      return !this.isOffLimitsButton(f as never);
    });
    if (!candidate) return false;
    const beforeUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
    const beforeFp = await this.pageFingerprint();
    const tabsBefore = this.tabCount();
    steps.push({
      action: "click",
      phase: "fill",
      selector: candidate.selector,
      note: `advance: ${candidate.label || "next"}`,
    });
    const res = await safeAction("fallback-advance", async () => {
      const loc = await this.locator(candidate.selector);
      if (!loc) throw new Error("fallback advance selector unresolved");
      await this.clickResilient(loc);
      await this.waitAfterClick(beforeUrl, beforeFp, tabsBefore);
    }, { required: false });
    if (!res.ok) { steps.pop(); return false; }
    const movedUrl = typeof this.page.url === "function" ? String(this.page.url() ?? "") : "";
    const movedFp = await this.pageFingerprint();
    if (movedUrl === beforeUrl && movedFp === beforeFp) {
      // It did nothing. Recording a click that does not move the page teaches replay a lie.
      steps.pop();
      this.debug?.event({ type: "fallback_advance_did_nothing", label: String(candidate.label ?? "").slice(0, 40) });
      return false;
    }
    this.debug?.event({ type: "fallback_advance", label: String(candidate.label ?? "").slice(0, 40) });
    return true;
  }

  private async clickCreateDialogAdvance(steps: RecipeStep[]): Promise<boolean> {
    if (this.createDialogSubmits >= 2) return false;
    if (this.entryLabelsClicked.size === 0) return false; // not entry-originated
    if (!this.page || typeof this.page.evaluate !== "function") return false;

    const found = await this.page.evaluate(() => {
      const CREATE_HEADING = /\b(new|create|start|begin|add)\b[\s\S]{0,40}\b(application|project|request|submittal|interconnection)\b/i;
      const SUBMIT_SHAPED = /^(submit|create|start|begin|add|ok)$/i;
      // NO trailing \b: these are STEMS. "certif" inside \b(...)\b cannot match "certify",
      // so a drawer gated on "I certify under penalty of perjury" read as safe to click.
      const FILING_LANGUAGE = /by submitting|cannot be (edited|changed|modified)|certif|affirm|under penalt|perjur|final submi|review (and|&) submit|terms and conditions|accept the terms/i;
      const panels = Array.from(document.querySelectorAll(
        "[role='dialog'], mat-dialog-container, .cdk-overlay-pane, .mat-drawer, .modal, [aria-modal='true']"));
      for (const p of panels) {
        const r = (p as HTMLElement).getBoundingClientRect();
        if (r.width < 40 || r.height < 40) continue; // not actually open
        const text = ((p as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
        if (!text || !CREATE_HEADING.test(text.slice(0, 200))) continue;
        if (FILING_LANGUAGE.test(text)) return { blocked: "the dialog carries filing/certification language" };
        for (const b of Array.from(p.querySelectorAll("button, [role='button'], input[type='submit']"))) {
          if ((b as HTMLButtonElement).disabled) continue;
          const br = (b as HTMLElement).getBoundingClientRect();
          if (br.width < 1 || br.height < 1) continue;
          const t = `${(b as HTMLElement).innerText || (b as HTMLInputElement).value || ""} ${b.getAttribute("aria-label") || ""}`
            .replace(/\s+/g, " ").trim();
          if (SUBMIT_SHAPED.test(t)) return { name: t };
        }
      }
      return null;
    }).catch(() => null) as { name?: string; blocked?: string } | null;

    if (!found) return false;
    if (found.blocked || !found.name) {
      this.debug?.event({ type: "create_dialog_refused", why: found.blocked || "no submit-shaped control" });
      return false;
    }
    if (isPayFee(found.name)) {
      this.debug?.event({ type: "create_dialog_refused", why: `pay/fee control ("${found.name}")` });
      return false;
    }

    const dlg = this.page.locator(
      "[role='dialog'], mat-dialog-container, .cdk-overlay-pane, .mat-drawer, .modal, [aria-modal='true']").first();
    const btn = dlg.getByRole("button", { name: found.name, exact: true }).first();
    if (!(await btn.count().catch(() => 0))) return false;

    const beforeFp = await this.pageFingerprint();
    const clicked = await btn.click({ timeout: 8000 }).then(() => true).catch(() => false);
    if (!clicked) return false;
    this.createDialogSubmits++;
    await this.waitForDynamicFieldsSettle().catch(() => null);
    await smartWait(this.page, 2500);
    const afterFp = await this.pageFingerprint();
    if (afterFp === beforeFp) {
      // It refused (a required choice left unmade, say). Don't record a step that does nothing.
      this.debug?.event({ type: "create_dialog_submit", name: found.name, moved: false });
      return false;
    }
    this.debug?.event({ type: "create_dialog_submit", name: found.name, moved: true });
    steps.push({
      action: "click",
      phase: "fill",
      selector: { role: "button", name: found.name, exact: true },
      note: `create application: ${found.name} (creates the record, does NOT file)`,
    });
    return true;
  }

  /** IS THIS PAGE THE WHOLE APPLICATION? The Node half of classifyTerminalSubmitPage.
   *
   *  RE-HARVESTS LIVE rather than reusing the walk loop's `fields`. That census was taken
   *  BEFORE this page's fills, and the control that must veto terminality is very often one
   *  the fills themselves REVEAL or ENABLE — a Next that unlocks once the address validates is
   *  precisely hole 2, and judging a post-fill page by a pre-fill census would hand that page
   *  straight back to the classifier with no advance in it. The re-harvest goes through
   *  extractAllFrames, so the active scope, the frame keys and the exit re-admission all
   *  compose exactly as they do at the top of the loop.
   *
   *  Returns the FRESH field, so the selector recorded is the one just verified. */
  private async terminalSubmitHere(pageCount: number): Promise<{ field: ExtractedField; label: string } | null> {
    if (!this.page) return null;
    let fields: ExtractedField[];
    try {
      fields = (await this.extractAllFrames(EXTRACT_SEL)).map(toExtractedField);
    } catch {
      return null; // a page mid-navigation is not a page we get to call finished
    }
    let bodyText = "";
    try {
      const rawBody = await this.page.locator("body").innerText().catch(() => "");
      bodyText = (redactStatusText(String(rawBody)) ?? "").slice(0, 2000);
    } catch { bodyText = ""; }
    const validationErrors = await this.collectValidationErrors().catch(() => [] as string[]);
    const verdict = classifyTerminalSubmitPage({ fields, bodyText, validationErrors });
    if (!verdict.terminal) {
      // A DISTINCT REASON, NAMED. "The walk stopped" and "the walk stopped because this page
      // holds a DISABLED Next it is waiting for you to unlock" are different facts, and only
      // one of them tells an operator what to do next.
      this.debug?.event({ type: "terminal_page_refused", page: pageCount, guard: verdict.guard, why: verdict.reason.slice(0, 160) });
      if (process.env.AUTOLEARN_DEBUG === "1") console.error(`[learn] p${pageCount} is not a terminal page (${verdict.guard}): ${verdict.reason}`);
      return null;
    }
    const field = fields[verdict.index];
    if (!field?.selector) return null;
    this.debug?.event({ type: "terminal_page", page: pageCount, label: verdict.label.slice(0, 60), why: verdict.why.slice(0, 160) });
    if (process.env.AUTOLEARN_DEBUG === "1") console.error(`[learn] p${pageCount} IS a terminal page — ${verdict.why}; recording ${JSON.stringify(verdict.label)} as the final submit (NOT clicked).`);
    return { field, label: verdict.label };
  }

  private isOffLimitsButton(field: ExtractedField): boolean {
    const sel = field.selector;
    return isPayFee(field.label) || isPayFee(sel?.name) || isPayFee(sel?.text)
      || EXISTING_RECORD_ACTION.test(field.label || "")
      || EXISTING_RECORD_ACTION.test(sel?.name || "")
      || EXISTING_RECORD_ACTION.test(sel?.text || "");
  }

  /** Off-limits for a DASHBOARD navigate specifically. On a logged-in home the only valid
   *  move is starting a NEW application, so the full exclusion list the deterministic entry
   *  finder uses applies here too — the planner gets to pick a control the patterns don't
   *  recognise ("Begin Submittal"), but never one that reaches into existing records. This
   *  is stricter than isOffLimitsButton on purpose and must NOT be used on form pages, where
   *  "Search" (address lookup) and "View" controls are legitimate. */
  private isOffLimitsDashboardTarget(field: ExtractedField): boolean {
    if (this.isOffLimitsButton(field)) return true;
    const sel = field.selector;
    // Only test text we actually have: isExcludedEntryLabel treats an EMPTY label as
    // excluded (nothing to start an application with), which would refuse every control
    // whose selector happens to carry no name/text.
    const texts = [field.label, sel?.name, sel?.text].map((t) => String(t ?? "").trim()).filter(Boolean);
    return texts.some((t) => isExcludedEntryLabel(t));
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
  /**
   * One attempt to open the container concealing a required control, then re-check. Returns
   * true only when the control is genuinely visible afterwards — a reveal that does not
   * reveal is a failure, and the field is skipped exactly as it was before.
   */
  private async tryRevealHidden(loc: unknown, field: ExtractedField): Promise<boolean> {
    if (!this.page || typeof this.page.evaluate !== "function") return false;
    try {
      const l = loc as { evaluate?: (fn: (el: Element) => void) => Promise<void>; isVisible?: () => Promise<boolean> };
      if (typeof l.evaluate !== "function") return false;
      await l.evaluate((el: Element) => el.setAttribute("data-al-hidden-target", "1"));
      // A VISUALLY-HIDDEN RADIO/CHECKBOX IS NOT A CLOSED CONTAINER — its label is the
      // handle, and clicking that is exactly what a person does. Tried first because it is
      // the commoner shape and needs nothing opened.
      const labelText = await this.page.evaluate(planLabelProxy);
      if (labelText) {
        await this.page.locator("[data-al-reveal]").first().click({ timeout: 3000 });
        await sleep(400);
        const checked = await (l as { evaluate?: (fn: (el: Element) => boolean) => Promise<boolean> })
          .evaluate!((el: Element) => (el as HTMLInputElement).checked === true).catch(() => false);
        this.debug?.event({
          type: checked ? "hidden_field_clicked_via_label" : "hidden_field_label_click_no_effect",
          label: (field.label || "").slice(0, 60), via: labelText,
        });
        await l.evaluate((el: Element) => el.removeAttribute("data-al-hidden-target")).catch(() => {});
        if (checked) return true;
      }
      const plan = await this.page.evaluate(planHiddenReveal);
      if (!plan?.opener) {
        // SAY THAT WE LOOKED. Returning quietly here made "no opener exists" identical to
        // "no reveal was attempted" in the run log — momentum's bundle showed three
        // hidden_field_skipped lines and no way to tell which. That ambiguity is the thing
        // this whole day kept costing live runs to resolve.
        this.debug?.event({
          type: "hidden_field_no_opener",
          label: (field.label || "").slice(0, 60),
          why: plan?.why || "not concealed by any ancestor we recognise",
        });
        await l.evaluate((el: Element) => el.removeAttribute("data-al-hidden-target")).catch(() => {});
        return false;
      }
      await this.page.locator("[data-al-reveal]").first().click({ timeout: 3000 });
      await sleep(500);
      const now = typeof l.isVisible === "function" ? await l.isVisible().catch(() => false) : false;
      this.debug?.event({
        type: now ? "hidden_field_revealed" : "hidden_field_reveal_failed",
        label: (field.label || "").slice(0, 60),
        why: plan.why,
        opener: plan.opener,
      });
      await l.evaluate((el: Element) => el.removeAttribute("data-al-hidden-target")).catch(() => {});
      return now;
    } catch {
      return false;
    }
  }

  /**
   * Decline the cookie/consent banner if one is up. See consentBanner.ts for why this
   * declines rather than accepts, and why it does nothing at all when "Accept" is the only
   * way through.
   *
   * Runs each page because a single-page portal can raise the banner late, and because
   * every portal now has its own fresh profile, so every visit is a first visit.
   */
  private async declineConsentBanner(): Promise<void> {
    if (!this.page || typeof this.page.evaluate !== "function") return;
    try {
      const outcome = await this.page.evaluate(planConsentDismissal);
      if (!outcome?.how) return;
      if (outcome.how === "accept-only") {
        // DECLINE FIRST, ALWAYS. This is the residual: a banner whose only control is an
        // acceptance. Leaving it standing was the safe default and it is what blocked two
        // portals from ever reaching a form — the operator has since said to accept when it
        // is the thing in the way, so this accepts ONLY here, only when no decline, no
        // necessary-only and no close was offered, and it records that it did.
        //
        // Narrow on purpose. This is a cookie banner, not a terms-of-service agreement and
        // not a CAPTCHA: the planner requires the banner's own wording (cookies / consent /
        // tracking / privacy preferences) before anything here runs at all.
        if (!this.allowConsentAccept) {
          this.debug?.event({ type: "consent_banner_left_standing", why: "the only control offered was an acceptance and accepting is not enabled for this run" });
          return;
        }
        await this.page.locator("[data-al-consent]").first().click({ timeout: 3000 }).catch(() => null);
        await sleep(400);
        this.debug?.event({ type: "consent_banner_accepted", control: outcome.clicked, why: "no decline, necessary-only or close was offered and the banner was blocking" });
        return;
      }
      await this.page.locator("[data-al-consent]").first().click({ timeout: 3000 });
      await sleep(400);
      this.debug?.event({ type: "consent_banner_dismissed", how: outcome.how, control: outcome.clicked });
    } catch {
      /* a banner we could not dismiss is the overlay neutraliser's problem, not an error */
    }
  }

  /**
   * Answer a chooser whose controls are all identically labelled by reading the ROW each
   * one sits in. Returns true when it clicked one; false leaves the planner's pick alone.
   *
   * Deliberately conservative: three or more identical controls, a row that does not
   * contradict the filing, and a recognised match. Anything else is not this pass's
   * business — picking the wrong row files the wrong permit.
   */
  /**
   * On a page whose controls are all identically labelled, pick the row that matches the
   * filing and return it AS A NAVIGATE TARGET for the ordinary navigate path to click.
   *
   * It only chooses. Clicking belongs to the path that already knows how to wait for a
   * postback, adopt a popup and verify the page actually moved.
   */
  private async chooseRowTarget(): Promise<ExtractedField | null> {
    if (!this.page || typeof this.page.evaluate !== "function") return null;
    try {
      const rows = await this.page.evaluate(scanRowChoices);
      if (!rows?.length) return null;
      const pick = chooseRow(rows, this.permitDiscipline);
      if (!pick) {
        this.debug?.event({ type: "row_chooser_refused", rows: rows.length, why: "no row matched the filing without contradicting it" });
        return null;
      }
      this.debug?.event({ type: "row_chooser_picked", rows: rows.length, control: pick.control, text: pick.text.slice(0, 110) });
      return {
        label: pick.text.slice(0, 80),
        fieldType: "button",
        selector: { css: `[data-al-row="${pick.key}"]` },
      } as ExtractedField;
    } catch {
      return null;
    }
  }

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
  /** ABANDONING A CLICK DOES NOT STOP IT. The advance budget races safeAction against a
   *  timer, and nothing can cancel the work that lost — clickResilient keeps waiting for its
   *  element and clicks it whenever it finally becomes actionable. On Miami that element is
   *  the SAME control the results-row click reveals, so the abandoned attempt would come back
   *  to life the instant the walk moved forward, and navigate the page out from under the
   *  next scrape. Bumping this retires every click still in flight. */
  private clickGeneration = 0;

  private async clickResilient(loc: any): Promise<void> {
    const dbg = process.env.AUTOLEARN_DEBUG === "1";
    const gen = this.clickGeneration;
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
      if (this.clickGeneration !== gen) return; // retired — the walk has moved on without us
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
        // Last check before the gesture: waitForElement above can sit for 12 seconds, ample
        // time for the budget to expire and the walk to move on.
        if (this.clickGeneration !== gen) return;
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
      // A BLANK CURRENT PAGE IS NOT A VALID ANCHOR. Bitco's "Citizens Connect" opens the
      // application in a new tab AND leaves the dashboard tab on about:blank, so this.page
      // sits on about:blank and the walk scrapes an empty page forever. When the current
      // tab is blank the "strictly newer" rule is meaningless — adopt any non-blank
      // same-host tab, newest first.
      let curUrl = ""; try { curUrl = String(current.url?.() ?? ""); } catch { curUrl = ""; }
      const currentIsBlank = !curUrl || curUrl === "about:blank";
      const floor = currentIsBlank ? -1 : curIdx;
      // Walk newest → oldest; adopt a tab NEWER than the current one (or any, if blank).
      for (let i = pages.length - 1; i > floor; i--) {
        const p = pages[i];
        if (p === current) continue;
        let u = "";
        try { u = String(p.url?.() ?? ""); } catch { u = ""; }
        // A FRESHLY-OPENED TAB IS about:blank FOR A MOMENT before its real navigation. The
        // old code skipped it and moved on, so a form that opened in a new tab was missed
        // whenever adoption raced the tab's first navigation (Bitco, and any portal whose
        // popup redirects). Give a blank newer tab a brief chance to become the form.
        if (u === "about:blank") {
          for (let w = 0; w < 6 && (u === "about:blank" || !u); w++) {
            try { await p.waitForLoadState?.("domcontentloaded", { timeout: 1500 }); } catch { /* keep polling url */ }
            await sleep(500);
            try { u = String(p.url?.() ?? ""); } catch { u = ""; }
          }
        }
        if (!u || u === "about:blank") continue;
        let host = ""; try { host = new URL(u).host; } catch { host = ""; }
        // Same-host filter still applies EXCEPT when our own tab is blank — then any real tab
        // beats sitting on about:blank, and currentHost is empty anyway.
        if (!currentIsBlank && currentHost && host && host !== currentHost) continue;
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
    return pageFingerprintOf(this.page);
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
  private _buildLocator(page: Page, sel: RecipeSelector, opts?: { raw?: boolean }): any {
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
    if (typeof sel.nth === "number") return loc.nth(sel.nth);
    // RAW mode exists for locator() below: `.first()` makes every locator count as 1, so an
    // AMBIGUOUS strategy is indistinguishable from a resolved one — a duplicated label's
    // fill then lands silently on the FIRST block, which on PowerClerk's identical contact
    // blocks files the wrong party's details. The caller that wants to measure breadth asks
    // for the raw locator; every other caller keeps the old first-match behaviour.
    return opts?.raw ? loc : loc.first();
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
    return collectValidationErrorsFrom(this.page);
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
    try { primary = this._buildLocator(this.page, sel, { raw: true }); }
    catch { primary = null; }
    const primaryCount = primary ? await primary.count().catch(() => 0) : 0;
    if (primaryCount === 1) return primary.first();
    // AMONG SEVERAL MATCHES, THE ONE A PERSON CAN SEE. Miami's Contact Information renders
    // Owner / Tenant / Contractor / Qualifier blocks with identical labels, most of them
    // collapsed — so "the unique #id" can be a control inside a hidden section, and every
    // fill on it burns the visibility probe, the reveal attempt and four safeAction retries.
    // Eighteen fills at ~50s each is the sixteen minutes Contact Information cost.
    if (primaryCount > 1) {
      const visible = primary.locator("visible=true");
      if ((await visible.count().catch(() => 0)) === 1) return visible.first();
    }
    // AMBIGUOUS IS NOT RESOLVED. "count > 0" returned a label locator that matched BOTH of
    // PowerClerk's identical contact blocks; every action on it then threw a strict-mode
    // violation, applyFill swallowed the throw, and Ameren's Electrical Contractor block
    // read "required_never_filled: Name, Company, Address" run after run — while the unique
    // #id fallback recorded for exactly this sat unconsulted, because the ambiguous primary
    // "resolved". A fallback that matches exactly ONE element beats a primary that matches
    // two; a primary that matches two is still better than nothing when no fallback narrows.
    for (const fb of sel.fallbacks ?? []) {
      try {
        const loc = this._buildLocator(this.page, fb, { raw: true });
        const n = await loc.count().catch(() => 0);
        if (n !== 1) continue;
        // A unique match that nobody can see is not the control the planner meant. Prefer a
        // visible one from the primary before settling for it.
        if (await loc.first().isVisible().catch(() => true)) return loc.first();
        if (primaryCount > 1) {
          const vis = primary.locator("visible=true");
          if ((await vis.count().catch(() => 0)) >= 1) return vis.first();
        }
        return loc.first();
      } catch { /* bad fallback selector — skip */ }
    }
    if (primaryCount > 1) return primary.first();
    for (const fb of sel.fallbacks ?? []) {
      try {
        const loc = this._buildLocator(this.page, fb);
        if ((await loc.count().catch(() => 0)) > 0) return loc;
      } catch { /* bad fallback selector — skip */ }
    }
    // Return the primary even if empty — the caller's waitFor will surface a clear timeout.
    return primary ? primary.first() : primary;
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
  // FAST PATH. The walk below probes 20+ selectors, up to 3 times, plus an Escape fallback
  // — about 1.5s even on a page with no overlay at all. That was fine when only the learner
  // called it once per page; replay calls it before every click, where it added ~5s to a
  // three-click run and would add far more across a 99-step recipe. One round trip decides
  // whether the expensive walk is worth running: is there ANY overlay-shaped element, or
  // any button whose text is a dismissal? Deliberately broader than the selectors below, so
  // it can only skip work that would have found nothing.
  if (typeof page.evaluate === "function") {
    const worthDoing = await page.evaluate(() => {
      const CSS_HINTS = '.modal, .popover, .modal-backdrop, [class*="backdrop"], [id*="cpr-banner"],'
        + ' [class*="cookie"], [class*="consent"], .btn-close, [aria-label="Close"], [aria-label="close"],'
        + ' .x-tool-close, [class*="x-window"], [class*="modal"], [class*="popover"]';
      if (document.querySelector(CSS_HINTS)) return true;
      const DISMISS_TEXT = /^(got it|dismiss|close|accept all|accept|ok|×|x)$/i;
      const els = Array.from(document.querySelectorAll("button, a, .btn, [role=button]"));
      return els.some((el) => DISMISS_TEXT.test(((el as HTMLElement).innerText || "").trim()));
    }).catch(() => true); // unreadable page → do the full walk, as before
    if (!worthDoing) return;
  }
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
    // EXACT TEXT, NOT SUBSTRING — THIS LIST CLICKED A PERMIT TYPE.
    //
    // `:has-text("OK")` matches any clickable whose text CONTAINS "ok", case-insensitively.
    // On permiteyes.us's permit-type menu that is "Smoke Detector Permit" (sm-OK-e) and
    // "Look Up Record" (LO-OK). The dismisser clicked one, the learn carried on filling
    // whatever form it landed on, and NOTHING RECORDED THE CLICK because the dismisser is
    // not a recording pass. That is why a nine-fill permiteyes recipe replays into a
    // permit-type menu it has no step for: the type was never chosen by a step at all.
    //
    // `:text-is()` matches the element's own normalised text exactly, which is what every
    // one of these dismissals actually is: a button whose entire label is "OK" or "Close".
    // A dismissal button never says "Smoke Detector Permit".
    // PowerClerk "What's new?" popover
    `${clickable}:text-is("Got it")`,
    `${clickable}:text-is("Got It")`,
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
    `${clickable}:text-is("Dismiss")`,
    `${clickable}:text-is("Close")`,
    // Cookie consent
    `${clickable}:text-is("Accept All")`,
    `${clickable}:text-is("Accept")`,
    `${clickable}:text-is("OK")`,
    // Generic "×" close
    `${clickable}:text-is("×")`,
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

// SHARED WITH REPLAY. Extracted verbatim from AutoLearnAdapter.pageFingerprint so RecipeAdapter can
// run the same POST-ADVANCE guard the learner has always had. The learner detects a portal
// that refused a "Next" (the click succeeds, the page does not move) and scrapes the
// portal's own complaint; replay had none of it, so it marched on a page behind and filled
// forty steps into whatever controls happened to sit at the recorded ids.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// SHARED WITH REPLAY. Oregon ePermitting (and every Accela Citizen Access build) serves one
// portal to many jurisdictions, and the jurisdiction is chosen by the ADDRESS SEARCH inside
// the Apply wizard — not by a different site per city. So reaching the wizard is all that
// separates one city from another.
//
// The learner already knows how to get there; replay did not, and that is what blocked a
// cross-jurisdiction replay at its very first click. The learner starts from the public
// entry page that lists the applications, while replay reuses the persistent AUTHENTICATED
// profile and lands on Dashboard.aspx, whose nav is Apply / Building / Licensing / Planning
// — the recorded application link is simply not on that page. Two live runs, one with a
// stale recipe and one with a freshly-learned one, failed identically, which is what ruled
// out portal drift.
//
// Derive the Apply entry from ANY page of the instance (the learner's own version only
// worked from a /Cap/ URL, which Dashboard.aspx is not). module=Building is correct for both
// structural and electrical: ACA drives permits through the Building module, and utilities
// are PowerClerk, never this.
export function acaApplyEntryFrom(url: string): string | null {
  if (!/accela\.com|citizenaccess/i.test(url || "")) return null;
  try {
    const u = new URL(url);
    // The instance is the first path segment ("/oregon"), shared by /oregon/Dashboard.aspx
    // and /oregon/Cap/CapHome.aspx alike.
    const seg = u.pathname.split("/").filter(Boolean)[0];
    if (!seg) return null;
    return `${u.origin}/${seg}/Cap/CapApplyDisclaimer.aspx?module=Building`;
  } catch { return null; }
}

/** DID THE PAGE ACTUALLY ADVANCE, structurally — no body text.
 *
 *  pageFingerprintOf includes document.body.innerText.length, which is right for
 *  waitAfterClick (it wants to notice ANY change, quickly) and wrong for "did this Next
 *  work". Any inline re-render moves it: a validation banner, a spinner, a results panel.
 *
 *  Measured on City of Miami's iBuild Property Search. The planner chose the same advance
 *  control on three consecutive pages; each click re-rendered the results panel, the text
 *  length changed, and the walk concluded it had advanced. So the control was never recorded
 *  as dead, the fallback finder never got its turn, and the run spent seven pages on one.
 *
 *  This looks only at structure: where we are, what can be typed into, what the step says,
 *  how many controls are live. A page that re-renders its own panel keeps the same signature;
 *  a page that genuinely advances does not. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function advanceSignatureOf(page: any): Promise<string> {
  if (!page || typeof page.evaluate !== "function") return "";
  // ONE ACTIVE SCOPE PER PAGE — the SAME resolver the harvest uses, run here rather than a
  // second copy of the panel rules, so the two cannot drift: there is one function that
  // decides what the scope is and one marked element that both of them read. Without this,
  // ComEd's drawer advance was measured against a signature dominated by the dashboard
  // behind it (27 buttons, a paginated table's rows), where movement inside the drawer is
  // noise. Fails open to the whole document if the evaluate throws mid-navigation.
  await resolveActiveScope(page);
  try {
    return await page.evaluate(() => {
      const vis = (el: Element): boolean => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      // Literal selector, not ACTIVE_SCOPE_CSS: this callback is serialized into the page.
      const scopeEl = document.querySelector('[data-al-activescope="1"]');
      const root: ParentNode = scopeEl ?? document;
      const fillable = (Array.from(root.querySelectorAll("input, select, textarea")) as HTMLElement[])
        .filter(vis)
        .map((el) => (el.getAttribute("name") || el.getAttribute("id") || (el as HTMLInputElement).type || "").toLowerCase())
        .sort()
        .join(",");
      const buttons = (Array.from(root.querySelectorAll("button, input[type=submit], input[type=button]")) as HTMLElement[])
        .filter((el) => vis(el) && !(el as HTMLButtonElement).disabled).length;
      const heading = (root.querySelector("h1, h2, legend, .wizard-step.active, [aria-current='step']")?.textContent || "")
        .replace(/\s+/g, " ").trim().slice(0, 60);
      // RESULTS ARE STRUCTURE, NOT TEXT. A search that returns rows changes no heading, no
      // button count and no field names — the first version of this signature therefore
      // called a successful search "no movement", which is the opposite of the bug it was
      // written to fix. Counting rows and options separates a results panel APPEARING from
      // the same panel re-rendering its instructions.
      const rows = (Array.from(root.querySelectorAll("tr, li, [role='row'], option")) as HTMLElement[])
        .filter(vis).length;
      // The scope flag is part of the signature: a drawer OPENING or CLOSING over an
      // otherwise unchanged page is movement, and without this the two scopes would be
      // compared as if they were the same measurement.
      return `${location.pathname}|${scopeEl ? "s" : "d"}|${heading}|${buttons}|${rows}|${fillable.slice(0, 400)}`;
    });
  } catch {
    return "";
  }
}

export async function pageFingerprintOf(page: any): Promise<string> {
  if (!page || typeof page.evaluate !== "function") return "";
  try {
    return await page.evaluate(() => {
      const inputs = document.querySelectorAll("input, select, textarea").length;
      const heading = (document.querySelector("h1, h2, legend, .wizard-step.active, .active")?.textContent || "").trim().slice(0, 50);
      return `${location.href}|${inputs}|${heading}|${(document.body?.innerText || "").length}`;
    });
  } catch {
    return "";
  }
}

// SHARED WITH REPLAY. Extracted verbatim from AutoLearnAdapter.collectValidationErrors so RecipeAdapter can
// run the same POST-ADVANCE guard the learner has always had. The learner detects a portal
// that refused a "Next" (the click succeeds, the page does not move) and scrapes the
// portal's own complaint; replay had none of it, so it marched on a page behind and filled
// forty steps into whatever controls happened to sit at the recorded ids.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function collectValidationErrorsFrom(page: any): Promise<string[]> {
  if (!page || typeof page.evaluate !== "function") return [];
  try {
    return await page.evaluate((): string[] => {
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
        // ASP.NET MVC's Html.ValidationSummary — the single most common error container in
        // the fleet's legacy portals, and absent from this list until Miami's "Property
        // Address not found." went unread for a whole walk. The empty twin that MVC always
        // renders carries .validation-summary-valid, which the :not() excludes; the
        // innerText length guard below drops it anyway.
        '.validation-summary-errors',
        '[data-valmsg-summary]:not(.validation-summary-valid)',
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

// A PAGE THAT MOVED CAN STILL HAVE MOVED BACKWARDS.
//
// collectValidationErrorsFrom above runs in exactly one place: after an advance that did
// NOTHING. Miami's Property Search advanced every time — the URL gained
// ?searchFor=…&searchBy=address on each attempt — and every one of those pages came back
// carrying "Property Address not found." in an MVC ValidationSummary. Nothing read it. The
// run ended saying "the advance on this page is not advancing", which is the opposite of
// what happened, and named no cause a person could act on.
//
// So: read the portal's OWN page-level notices on every page, whether or not it moved.
//
// Deliberately narrower than collectValidationErrorsFrom — SUMMARY/BANNER containers only,
// and none of its per-field required-but-empty synthesis. A freshly rendered form is full
// of not-yet-filled required fields; folding those in here would stamp "the portal reported"
// onto healthy runs. This channel means one thing: the portal printed a message at us.
export async function collectPortalNoticesFrom(page: any): Promise<string[]> {
  if (!page || typeof page.evaluate !== "function") return [];
  try {
    // WHAT COMES BACK FROM A PAGE IS NOT NECESSARILY WHAT THE CODE ASKED FOR. A stubbed or
    // instrumented page answers every evaluate with the same canned value, and this returned
    // it verbatim: the caller's .filter then threw and took a whole learn down with
    // "notices.filter is not a function". Trust the shape, not the call.
    const raw = await page.evaluate((): string[] => {
      const sels = [
        ".validation-summary-errors",
        '[data-valmsg-summary]:not(.validation-summary-valid)',
        ".alert-danger",
        ".alert-error",
        '[class*="error-summary"]',
        '[class*="errorSummary"]',
        '[role="alert"]',
      ];
      const seen = new Set<string>();
      const out: string[] = [];
      for (const sel of sels) {
        for (const el of Array.from(document.querySelectorAll(sel)) as HTMLElement[]) {
          if (el.offsetParent === null) continue;
          const t = (el.innerText || "").replace(/\s+/g, " ").trim();
          // Long blobs are page copy that happens to sit in an alert region, not a message.
          if (t.length < 4 || t.length > 300) continue;
          if (seen.has(t)) continue;
          seen.add(t);
          out.push(t);
        }
      }
      return out.slice(0, 5);
    });
    return Array.isArray(raw) ? raw.filter((n) => typeof n === "string" && n.length > 0).slice(0, 5) : [];
  } catch {
    return [];
  }
}
