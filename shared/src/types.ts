export type ProjectStatus =
  | "intake_uploaded"
  | "parsed"
  | "qc_failed"
  | "qc_passed"
  | "ready_to_stage"
  | "submit_staging"
  | "awaiting_human_submit"
  | "submitted"
  | "correction_received"
  | "correction_triaged"
  | "waiting_on_designer"
  | "ready_to_resubmit"
  | "resubmit_staging"
  | "awaiting_human_resubmit"
  | "ready_for_issue"
  | "issued"
  | "approved"
  | "nem_approved"
  | "handoff_ready"
  | "blocked";

export type QcStatus = "pass" | "fail" | "warning";
export type Severity = "info" | "warning" | "error" | "blocker";
export type HumanReviewStatus = "pending" | "approved" | "edited" | "rejected";
export type CorrectionBucket =
  | "A_we_fix"
  | "B_designer_fix"
  | "C_reviewer_clarification";
export type PortalRunStatus =
  | "queued"
  | "running"
  | "awaiting_human_submit"
  | "paused_for_human"
  | "submitted"
  | "failed";
export type PermitCheckSource = "manual" | "portal" | "email" | "mock" | "public_url";
export type PermitCheckOutcome =
  | "waiting"
  | "correction_flagged"
  | "reviewed_by_ahj"
  | "ready_for_issue"
  | "issued"
  | "nem_approved"
  | "needs_human_review"
  | "no_change";

export type ParserPayload = Record<string, unknown>;

export interface ClientPortalIdentity {
  id: string;
  clientId: string;
  portalType: string;
  installerCompanyLabel: string;
  installerContactCode: string;
  notes: string;
  createdAt: string;
}

export interface ClientRecord {
  id: string;
  companyName: string;
  contactName: string;
  contactEmail: string;
  phone: string;
  billingStatus: string;
  notes: string;
  // Contractor licensing & business identity
  legalBusinessName: string;
  dba: string;
  ccbLicenseNumber: string;
  /** The installer's standard AC disconnect — plan sets specify the RATING but leave the
   *  part to the installer, and utility portals require a make and model. */
  standardDisconnectMake: string;
  standardDisconnectModel: string;
  ccbExpiration: string;
  electricalLicenseNumber: string;
  /** ICC/state docket number for the installer's DG certification (Illinois Part 468).
   *  A per-installer credential like the licences beside it, required on every Illinois
   *  interconnection application. */
  docketNumber: string;
  // Metro/city contractor license (e.g. Portland Metro), and the supervising
  // electrician's own personal license — distinct from the company electrical
  // contractor license above. Many AHJ permit forms require all three.
  metroCityLicenseNumber: string;
  electricalSupervisorName: string;
  electricianLicenseNumber: string;
  businessAddress: string;
  businessCity: string;
  businessState: string;
  businessZip: string;
  businessPhone: string;
  businessEmail: string;
  /** Where OUR outbound updates go — deliberately NOT businessEmail, which is the installer
   *  address printed on the application for the AHJ to write to. The onboarding packet marks
   *  this REQUIRED and asks for a shared inbox rather than one person's. Falls back to
   *  businessEmail in clientNotifier when blank. */
  updatesInbox: string;
  /** Who receives OUR invoices — a third address again: the AHJ's correspondent, the
   *  operations inbox and accounts payable are rarely one person. */
  billingContactEmail: string;
  /** The issuing state for the contractor licence numbers above. A bare number is ambiguous
   *  the moment a company is licensed in two states. */
  licenseState: string;
  /** ISO YYYY-MM-DD so it sorts. An expired COI is not a code failure — it is every filing in
   *  that jurisdiction rejected by a human until it is renewed. */
  insuranceExpiry: string;
  bondExpiry: string;
  ein: string;
  bondCarrier: string;
  insuranceCarrier: string;
  authorizedSignerName: string;
  authorizedSignerTitle: string;
  logoBase64: string; // base64-encoded PNG/JPEG; empty string = no logo
  logoMime: string;   // "image/png" | "image/jpeg"
  /** "per_submission" gates staging behind a paid/waived payment; "" / "monthly" = no gate. */
  billingMode: string;
  /** Operator's per-submission service fee ("top fee") in USD; null = env default. */
  serviceFeeUsd: number | null;
  portalIdentities: ClientPortalIdentity[];
  createdAt: string;
}

// --- Per-submission payment gate ------------------------------------------

export interface SubmissionPaymentRecord {
  id: string;
  projectId: string;
  track: string;
  status: "quoted" | "paid" | "waived";
  permitFeeEstimateUsd: number | null;
  /** The portal-calculated real fee, once known (operator enters it from the fee/review screen). */
  permitFeeActualUsd: number | null;
  serviceFeeUsd: number;
  totalUsd: number;
  feeBasis: string;
  paymentReference: string;
  /** The fee agreement IN FORCE when the real fee was recorded — one of
   *  card-on-file | customer-pays | mailed-check | keelix-pays, or "" when nothing was on
   *  file at the time. Stamped rather than read live, so an invoice cannot change because
   *  somebody edited a credential afterwards. Only 'keelix-pays' is ours to re-bill. */
  feeResponsibility: string;
  /** When the real fee became known. Distinct from paidAt (which is the client-pays-operator
   *  gate and never fires for monthly-billed clients) and from updatedAt (which moves on any
   *  touch): this is the date a billing period is cut on. */
  feeRecordedAt: string;
  quotedAt: string;
  paidAt: string | null;
  updatedAt: string;
}

/** How a jurisdiction fee actually gets paid. NOT a property of whichever tier
 *  produced the amount — it belongs to the jurisdiction's process, so it holds
 *  even when the operator typed the number in by hand. "mailed_check" is the
 *  one that changes who does the work: no portal can take a check, so the
 *  human sends it (Ameren Illinois Level 1 = $50 by mail within 15 business days). */
export type FeePaymentMethod = "portal" | "mailed_check" | "none" | "unknown";

/** How much to trust the amount. "actual" is the portal's own number. "verified"
 *  means a human stands behind it — a human-checked schedule row, or a median of
 *  fees people read off real portal screens. "seeded" is unreviewed research, so
 *  it never auto-overwrites anything (safety rule 3). "estimated" is the
 *  valuation heuristic, which knows nothing about the jurisdiction. */
export type FeeConfidence = "actual" | "verified" | "seeded" | "estimated" | "unknown";

export type PermitFeeSource =
  | "actual"
  | "learned_history"
  | "published_schedule"
  | "valuation_estimate"
  | "unknown";

export interface SubmissionPaymentQuote {
  track: string;
  /** True when the project's client bills per submission (staging is gated). */
  required: boolean;
  billingMode: string;
  permitFeeUsd: number | null;
  permitFeeSource: PermitFeeSource;
  permitFeeBasis: string;
  /** The jurisdiction's own fee page, when a published schedule supplied or
   *  corroborated the number — so the operator can click through and check. */
  permitFeeSourceUrl: string | null;
  /** The schedule line this project's size landed on ("5.01 kVA through 15 kVA").
   *  Carrying the bracket is the point: a replayed filing that freezes the learn
   *  project's bracket bills a 20 kW job at the 15 kVA rate. */
  permitFeeBracketLabel: string | null;
  permitFeeConfidence: FeeConfidence;
  paymentMethod: FeePaymentMethod;
  serviceFeeUsd: number;
  totalUsd: number | null;
  payment: SubmissionPaymentRecord | null;
}

// --- Published fee schedules ----------------------------------------------
// The consumer-side contract between backend/src/submissionFees.ts (the quote
// ladder + fee sheet) and backend/src/feeSchedules.ts (which finds, stores and
// brackets published AHJ/utility schedules). Declared structurally rather than
// imported from that module so the ladder keeps compiling — and quoting — if it
// is absent: feeSchedules.ts's own ProjectFeeResolution satisfies this shape.
//
// The lookup is SYNCHRONOUS: it reads already-researched rows, it does not go to
// the web, because the payment gate that calls it is synchronous.

export interface PublishedFeeResult {
  /** The amount the schedule resolves to for THIS project. 0 is an answer
   *  ("this utility charges nothing"); null means a schedule was found but could
   *  not be evaluated — see `reason`. Neither is ever rendered as a plain $0. */
  feeUsd: number | null;
  /** The schedule line that was matched, in the jurisdiction's own wording —
   *  which is exactly what an application's fee-quantity field is asking for. */
  bracketLabel?: string | null;
  /** The jurisdiction's published fee page. */
  sourceUrl?: string | null;
  /** The SCHEDULE's own citation — provenance of the table. Row grain, so on a
   *  bracketed schedule it agrees with at most one of the brackets: read it as a
   *  pointer back to the document (and, as below, as a mailed-check hint), never
   *  as the evidence for the amount. `bracketQuote` is that. */
  sourceQuote?: string | null;
  /** The published line that supports THIS amount, verbatim — the corroborated
   *  printed row where there is one, else the matched bracket's own label. "" or
   *  absent when the amount is the total of more than one permit: no single
   *  published line states a sum. This is the only quote safe to show beside the
   *  number. */
  bracketQuote?: string | null;
  /** A MACHINE went back to the cited document and found every line printed
   *  there — label and fee on one row. A dimension of its own, NOT a third
   *  `confidence` value: 'verified' means a PERSON vouched (hard rule 3) and
   *  nothing automatic may ever set it. The operator-facing word is
   *  CORROBORATED. */
  corroborated?: boolean;
  /** Research lands as "seeded"; only human review promotes it to "verified". */
  confidence?: "verified" | "seeded";
  /** Optional: schedules that state how the fee is paid. Absent means unknown,
   *  and a mailed-check hint may instead be read out of `sourceQuote`. */
  paymentMethod?: FeePaymentMethod;
  /** The name the schedule is filed under, which may be the legal name where
   *  the project carries an operator short name ("Coos Bay" / "City of Coos Bay"). */
  matchedName?: string;
  /** Populated when feeUsd is null: why the schedule did not evaluate. */
  reason?: string;
}

// --- Project fee sheet -----------------------------------------------------

export interface ProjectFeeSheetLine {
  track: "permit" | "nem";
  /** Who is owed the money ("City of Coos Bay", "Ameren Illinois"). */
  jurisdiction: string;
  feeUsd: number | null;
  source: PermitFeeSource;
  basis: string;
  bracketLabel: string | null;
  sourceUrl: string | null;
  confidence: FeeConfidence;
  paymentMethod: FeePaymentMethod;
  serviceFeeUsd: number;
  /** This track's client total, null whenever the jurisdiction fee is unknown. */
  totalUsd: number | null;
  /** False when the fee is not KNOWN. A known $0 is known; a valuation ESTIMATE
   *  is not — the number still travels on feeUsd with confidence "estimated",
   *  and the sheet's `unknowns` names the gap. known:true beside an estimate
   *  was the machine-readable claim that nothing here is unknown. */
  known: boolean;
}

/** One answer to "what will this project cost": both tracks, what is known,
 *  and — explicitly — what is not. A total is reported ONLY when every
 *  component carries a number; an unknown is never summed as a zero, and a
 *  total that includes an ESTIMATED line says so (`totalConfidence`) rather
 *  than presenting as flat fact. */
export interface ProjectFeeSheet {
  projectId: string;
  billingMode: string;
  /** True when the client bills per submission, i.e. the service fees below are
   *  actually collected (and staging is gated on them). */
  billingRequired: boolean;
  lines: ProjectFeeSheetLine[];
  /** Permit + NEM jurisdiction fees. Null if either has no number at all. */
  jurisdictionFeesUsd: number | null;
  /** The operator's service fees, counted PER TRACK (two submissions = two
   *  fees) and only for per-submission clients; 0 for monthly billing. */
  serviceFeesUsd: number;
  /** Null the moment any component has no number. An estimate is a number and
   *  is summed — see totalConfidence, which is how the total says so. */
  totalUsd: number | null;
  /** The weakest confidence among the summed fees — a total is only as good as
   *  its shakiest line (actual > verified > seeded > estimated). "estimated"
   *  means the total INCLUDES the valuation heuristic and must present as an
   *  estimate, never as flat fact; "unknown" whenever totalUsd is null. Same
   *  vocabulary as each line's `confidence` — no new one. */
  totalConfidence: FeeConfidence;
  /** Plain-language list of what is not known. Empty = the sheet is complete. */
  unknowns: string[];
  /** Fees no portal can take — the human sends these (mailed checks). */
  outOfPortalPayments: string[];
  generatedAt: string;
}

// Existing-system / NEM-addition disclosure. Projects adding PV or storage to an
// already-interconnected system must disclose the existing system's size,
// equipment, and NEM standing on interconnection applications. Intake/manual
// fields for now — NOT auto-populated from parsing (the parser's existing*
// snapshot fields remain the raw evidence; this block is the reviewed record).
// agreementNumber/applicationNumber are account-linked identifiers: bound by
// name for portal fill, never sent to the LLM (safety rule 2).
export interface ExistingSystemInfo {
  hasExistingSystem?: boolean;
  /** Existing system DC size in kW (nameplate). */
  existingDcKw?: number;
  /** Existing system AC size in kW. */
  existingAcKw?: number;
  existingInverterMake?: string;
  existingInverterModel?: string;
  existingInverterQty?: number;
  existingModuleMake?: string;
  existingModuleModel?: string;
  existingBatteryMakeModel?: string;
  /** Combined (existing + new) DC size in kW after the addition. */
  combinedDcKw?: number;
  /** Combined (existing + new) AC size in kW after the addition. */
  combinedAcKw?: number;
  /** NEM tariff the existing system is on (e.g. "NEM1", "NEM2", "NEM3/NBT"). */
  nemTariff?: string;
  /** Permission-to-operate date of the existing system (ISO date). */
  ptoDate?: string;
  /** Existing interconnection/NEM agreement number (sensitive — never sent to the LLM). */
  agreementNumber?: string;
  /** Existing interconnection application number (sensitive — never sent to the LLM). */
  applicationNumber?: string;
  exportMode?: "export" | "non-export-pcs" | "ngom";
}

export interface ProjectRecord {
  id: string;
  clientId: string | null;
  homeownerName: string;
  projectAddress: string;
  city: string;
  state: string;
  zip: string;
  ahj: string;
  utility: string;
  accountNumber: string;
  meterNumber: string;
  systemSizeDcKw: number | null;
  systemSizeAcKw: number | null;
  totalExportKw: number | null;
  interconnectionMethod: string;
  status: ProjectStatus;
  currentStage: string;
  parserConfidenceSummary: string;
  parserSnapshot: ParserPayload;
  assignedUserId?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Which permit discipline to file: "structural" (BLD) or "electrical" (ELE).
   *  Drives jurisdiction row selection (city vs county) and app-type checkbox
   *  in the Accela ACA flow. Undefined defaults to structural. */
  permitType?: "structural" | "electrical";
  /** Existing-system / NEM-addition disclosure (derived from the parser snapshot's
   *  existing/combined fields; intake/manual — see ExistingSystemInfo). */
  existingSystem?: ExistingSystemInfo;
  /** PER-JOB PORTAL ANSWERS — questions portals ask that no plan set or bill carries,
   *  proven live 2026-09-11 (PacifiCorp replayed a frozen "Customer-Owned"; Ameren left
   *  "Community Solar / Behind the Meter" blank). Stored as project columns (db.ts
   *  migration v17) so recipes bind them per job instead of freezing the learn
   *  project's answer. Empty string = unanswered. Optional here because mapProject
   *  predates them; resolveRecipeFieldValues also reads the columns directly. */
  /** Financing: 'customer-owned' | 'third-party-owned' | 'lease' | 'ppa'.
   *  NEVER defaulted — financing is not guessable; empty replays blank and is reported. */
  ownershipModel?: string;
  /** 'behind-the-meter' | 'community-solar' | 'standalone'. When empty, resolution
   *  defaults to behind-the-meter ONLY for a project with a utility account
   *  (see resolveRecipeFieldValues for why that is the one safe default). */
  systemConfiguration?: string;
  /** Site fact: is the AC disconnect within 10 feet of the utility meter — 'yes' | 'no'.
   *  NEVER defaulted (it is measured on site, not inferable). */
  disconnectWithin10ft?: string;
  /** ISO timestamp when this project was ARCHIVED; "" while it is live.
   *
   *  Archiving takes a job off the CLIENT-FACING portal and deletes nothing
   *  (backend/src/projectArchive.ts) — operator surfaces still answer for it on
   *  purpose, because hiding work from the people doing it is how a cleanup
   *  becomes a second problem. What they must not do is answer IDENTICALLY, and
   *  that is what they did for as long as this column could not reach a record:
   *  the superseded Daly pass (cf1c56aa) priced out at $274.43 and raised blocking
   *  demands with nothing anywhere saying its live twin is the real job. */
  archivedAt?: string;
  /** Why it was archived — the sentence that explains, six months later, why a job
   *  vanished from a client's list. "" while live. Shown, not just stored: a
   *  notice that cannot say "superseded by the certified run" is just a scold. */
  archivedReason?: string;
}

export interface ProjectListItem extends Omit<ProjectRecord, "parserSnapshot"> {
  qcFailCount: number;
  qcWarningCount: number;
  pendingReviewCount: number;
  correctionCount: number;
  latestPortalStatus: PortalRunStatus | null;
  latestPermitLabel: string | null;
  latestPermitOutcome: PermitCheckOutcome | null;
  latestPermitCheckedAt: string | null;
  readyForIssue: boolean;
  latestNemLabel: string | null;
  latestNemOutcome: PermitCheckOutcome | null;
  latestNemCheckedAt: string | null;
  nemApproved: boolean;
  overdueCorrections: number;
  // Pipeline stage (computed from status by backend/src/projectStage.ts) so the
  // dashboard can render the stepper/board without duplicating the lifecycle map.
  stageKey: string;
  stageIndex: number;
  stageLabel: string;
  stageCount: number;
  isBlocked: boolean;
  // Submitting client/company name (for the team dashboard's company filter/column).
  clientName?: string | null;
}

export interface QcResult {
  id: string;
  projectId: string;
  qcStatus: QcStatus;
  ruleId: string;
  ruleName: string;
  message: string;
  severity: Severity;
  createdAt: string;
}

export interface HumanReviewItem {
  id: string;
  projectId: string;
  issueType: string;
  fieldName: string;
  parserValue: string;
  llmSuggestedValue: string;
  sourceExcerpt: string;
  status: HumanReviewStatus;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface CorrectionRecord {
  id: string;
  projectId: string;
  source: "email" | "portal" | "manual";
  correctionText: string;
  correctionBucket: CorrectionBucket;
  rootCause: string;
  requiredAction: string;
  assignedTo: string;
  draftResponse: string;
  humanApproved: boolean;
  resubmitted: boolean;
  newRuleRecommended: boolean;
  createdAt: string;
  closedAt: string | null;
  dueAt: string | null;
  slaDays: number;
  daysOpen: number;
  isOverdue: boolean;
}

export interface PortalRun {
  id: string;
  projectId: string;
  portalProfileId: string | null;
  runType: string;
  status: PortalRunStatus;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string;
  humanActionRequired: boolean;
  screenshotsPath: string;
  logsPath: string;
  // Set when status is paused_for_human (e.g. "mfa_captcha")
  pauseReason?: string;
  // Captured after human completes final submit
  confirmationNumber?: string;
  // Public AHJ portal URL — no login needed; paste into browser to check status.
  // e.g. Accela CapDetail.aspx links, DevelopmentDirect record pages.
  trackingUrl?: string;
}

export interface SubmissionRecord {
  id: string;
  projectId: string;
  portalProfileId: string | null;
  submissionType: "permit" | "interconnection" | "correction" | "revision";
  status: "staged" | "awaiting_human_submit" | "paused_for_human" | "submitted" | "failed" | "approved";
  applicationNumber: string;
  permitNumber: string;
  confirmationNumber: string;
  submittedAt: string | null;
  submittedBy: string;
  screenshotsPath: string;
  notes: string;
}

export interface PermitCheckTarget {
  id: string;
  projectId: string;
  jurisdiction: string;
  portalName: string;
  portalUrl: string;
  applicationNumber: string;
  permitNumber: string;
  checkFrequencyDays: number;
  active: boolean;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  latestOutcome: PermitCheckOutcome | null;
  latestStatusLabel: string;
  notes: string;
  targetType: "permit" | "nem";
  /** 'building' | 'electrical' | 'combo' | 'nem' — which permit this track is. */
  permitType?: string;
  /** Auto-detected from portalUrl — drives the public HTTP status-check strategy. */
  portalPlatform?: string;
  /** Public AHJ portal record URL — no login required. Paste into browser to check status. */
  trackingUrl?: string;
  createdAt: string;
  updatedAt: string;
}

// A project's required submittal tracks (utility NEM + building/electrical permits),
// each submitted to its portal and tracked independently through to issuance.
export type SubmittalTrackType = "nem" | "building" | "electrical" | "combo" | "permit" | "mpu";
export type SubmittalTrackStatus =
  | "not_started"
  | "staged"
  | "submitted"
  | "in_review"
  | "correction"
  | "issued";

export interface SubmittalTrack {
  type: SubmittalTrackType;
  label: string;
  /** "utility" = the NEM/interconnection filing; "permit" = an AHJ building/electrical permit. */
  category: "utility" | "permit";
  /** Short channel hint, e.g. "Oregon ePermitting (Accela)" or "PowerClerk (PGE NEM)". */
  channel: string;
  status: SubmittalTrackStatus;
  statusLabel: string;
  /** One-line "what to do next" for this track, e.g. "Stage in PowerClerk" / "Submit in the portal". */
  nextAction: string;
  applicationNumber: string;
  permitNumber: string;
  confirmationNumber: string;
  trackingUrl: string;
  submittedAt: string | null;
  lastCheckedAt: string | null;
  /**
   * Which capture fields this track actually uses. NEM is an interconnection
   * application (no AHJ "permit number"); permits issue a permit number. The UI
   * renders only these fields + relabels them per category.
   */
  captureFields: Array<{ key: "applicationNumber" | "permitNumber" | "confirmationNumber" | "trackingUrl"; label: string; placeholder: string }>;
  /** True when this track is required for the project but has not been submitted. */
  outstanding: boolean;
  /** Whether a complete (or in-progress) recipe exists for this track's portal. */
  hasRecipe: boolean;
  /** The recipe's status — "complete", "recording", "needs_rerecord", or undefined if no recipe. */
  recipeStatus?: string;
  /** The portal URL from the recipe, if any — pre-fills the record command. */
  recipePortalUrl?: string;
  /** The recipe id, if any — for "review recording" link. */
  recipeId?: string;
  /** The scope type used to look up the recipe — "ahj" or "utility". */
  recipeScopeType?: "ahj" | "utility";
}

export interface PermitStatusCheck {
  id: string;
  projectId: string;
  targetId: string | null;
  /** The lane of the target this check descends from ("permit" | "nem"), joined from
   *  permit_check_targets. Empty for legacy checks recorded before targets were typed. */
  targetType?: string;
  source: PermitCheckSource;
  rawStatusText: string;
  statusLabel: string;
  outcome: PermitCheckOutcome;
  confidence: number;
  correctionId: string | null;
  reviewedByAhj: boolean;
  readyForIssue: boolean;
  issueFeeDue: boolean;
  applicationNumber: string;
  permitNumber: string;
  message: string;
  createdAt: string;
}

export interface ApplicationRequirementProfile {
  id: string;
  name: string;
  matchJurisdictions: string[];
  portalName: string;
  sourceUrl: string;
  requiresAhjApplication: boolean;
  requiresStructuralApplication: boolean;
  requiresElectricalApplication: boolean;
  requiresPrescriptiveChecklist: boolean;
  requiresBidSheet: boolean;
  requiresPortalEntryOnly: boolean;
  requiredDocuments: string[];
  notes: string[];
  /**
   * How the AHJ structures the solar permit(s):
   * - "combo": ONE combined building+electrical permit covers the whole job.
   * - "separate": distinct building (BLD) and electrical (ELE) permits must BOTH be filed.
   * - "unknown": not yet determined (default).
   */
  permitStructure?: "combo" | "separate" | "unknown";
  /** How the completed application is submitted: email | online portal | in-person | combination. */
  submissionMethod?: string;
}

export interface GeneratedApplicationDocument {
  id: string;
  title: string;
  required: boolean;
  documentType: "cover" | "manifest" | "ahj_application" | "structural_application" | "electrical_application" | "checklist" | "utility_application" | "worksheet";
  fileName: string;
  markdown: string;
}

export interface ApplicationDocumentPackage {
  projectId: string;
  profile: ApplicationRequirementProfile;
  generatedAt: string;
  docs: GeneratedApplicationDocument[];
  /** SCALAR project FIELDS that are blank — fifteen checks, none of which ever looks
   *  at a document. Feeds packageReady and four stage-status computations, so its
   *  meaning must not widen. */
  missingFields: string[];
  /**
   * Required DOCUMENTS (actual files) that are not attached — documentInventory's
   * blocking set, resolved against real uploads and filled forms on disk.
   *
   * DELIBERATELY NOT FOLDED INTO missingFields. The screen used to report "No critical
   * document fields missing from the generated packet" out of missingFields alone, and
   * an operator read that as "the packet is complete" — which is how a jurisdiction
   * that files TWO permits passed through with one application never attached. The
   * sentence was true and the impression was false. Folding the documents into
   * missingFields would fix the sentence and silently change what packageReady and
   * every stage-status computation mean; a separate field fixes the sentence only.
   *
   * Optional: buildApplicationDocumentPackage is DB-free and cannot resolve it — it is
   * attached by getApplicationDocumentPackage, which has the database.
   */
  missingDocuments?: Array<{
    docType: string;
    label: string;
    lane: "permit" | "nem";
    /** Why a clean submittal needs it, in the jurisdiction's own terms. */
    why: string;
  }>;
  /**
   * WHETHER missingDocuments ABOVE IS AN ANSWER AT ALL. An ABSENT list and an EMPTY list
   * are not the same fact, and for two permits the difference was invisible: the inventory
   * throw was swallowed, missingDocuments stayed undefined, the screen's `|| []` turned it
   * into an empty list, and a pass-styled "every required document is attached" printed
   * over a computation that never ran.
   *
   *  - "resolved"    — documentInventory ran. The list is authoritative, and an EMPTY list
   *                    genuinely means nothing blocking is missing. Only this value may
   *                    render an all-clear.
   *  - "unavailable" — documentInventory threw. missingDocuments is ABSENT, not empty. The
   *                    honest rendering is "we could not determine what this AHJ needs",
   *                    with missingDocumentsError as the reason. Never an all-clear.
   *  - absent        — this package came off the DB-free builder (buildApplicationDocumentPackage),
   *                    which never resolves an inventory. Read it as unavailable, not clear.
   *
   * Deliberately its own field rather than a change to missingDocuments' type: widening
   * that array to carry a sentinel would change what every existing reader means.
   */
  missingDocumentsStatus?: "resolved" | "unavailable";
  /** Why the inventory could not be computed, for the operator. Set only alongside
   *  missingDocumentsStatus === "unavailable". */
  missingDocumentsError?: string;
  html: string;
  /** When the knowledge base has a learned profile for this AHJ, its real
   *  required-document list + portal (so the PM isn't relying on the generic fallback). */
  learnedRequirements?: {
    ahj: string;
    utility: string;
    portalName: string;
    portalUrl: string;
    requiredDocuments: string[];
    confidence: string;
    correctionCount: number;
  };
  /** Human callout of the permit TYPE: combo vs separate BLD/ELE + submission method. */
  permitType?: string;
}

export interface AhjProcessProfile {
  state: string;
  ahj: string;
  submissionMethod: string;
  timeline: string;
  requiresElectricianSign: boolean;
  requiresElectricalStamp: boolean;
  requiresStructuralStamp: boolean;
  requiresElectricalPermitApplication: boolean;
  requiresBuildingPermitApplication: boolean;
  requiresSolarChecklist: boolean;
  requiresPlanSet: boolean;
  requiresUtilityApproval: boolean;
  requiresCustomerSignature: boolean;
  requiresFloodplainCheck: boolean;
  requiresJurisdictionCheck: boolean;
  otherRequirements: string;
  reviewerNotes: string;
  sourceSheet: string;
}

export interface CodeReference {
  code: string;
  section: string;
  title: string;
  adoptionScope: string;
  sourceUrl: string;
  note: string;
}

// ---------------------------------------------------------------------------
// Jurisdiction code profiles — the per-AHJ adopted-codes data layer that makes the
// review gate sellable to ANY jurisdiction (state/county/city), not just Oregon.
// Discipline-agnostic: covers building/electrical/fire/plumbing/mechanical codes,
// local amendments, and site design criteria. confidence "seeded" = LLM-researched
// or bulk-imported, findings must say "verify locally"; "verified" = a human
// confirmed the values against the jurisdiction's official sources.
// ---------------------------------------------------------------------------

export interface CodeEdition {
  /** Model/state code family: NEC | IRC | IBC | IFC | IPC | IMC | IECC | a state
   *  specialty code (e.g. OESC, ORSC) — free string so states' own codes fit. */
  code: string;
  /** Edition/cycle year, e.g. "2023". */
  edition: string;
  title?: string;
  sourceUrl?: string;
  notes?: string;
}

export interface JurisdictionDesignCriteria {
  groundSnowLoadPsf?: number;
  windSpeedMph?: number;
  windExposure?: string;
  seismicDesignCategory?: string;
  frostDepthIn?: number;
  sourceUrl?: string;
}

/** Solar-pack prescriptive-path limits; future rule packs add their own blocks. */
export interface PrescriptiveLimits {
  maxGroundSnowPsf?: number;
  maxPvDeadLoadPsf?: number;
  maxRafterSpacingIn?: number;
  allowedWindExposures?: string[];
  maxExportKwWithoutStudy?: number;
  engineerStampOverKwDc?: number;
}

export interface FireSetbackRule {
  id: string;
  description: string;
  codeReference?: CodeReference;
}

export interface JurisdictionCodeAmendment {
  code: string;
  section?: string;
  summary: string;
  sourceUrl?: string;
}

export interface JurisdictionCodeProfile {
  /** knowledgeProfileKey({state, ahj, utility: ""}). */
  key: string;
  state: string;
  /** "" = the state-level default profile every AHJ in the state falls back to. */
  ahj: string;
  confidence: "seeded" | "verified";
  adoptedCodes: CodeEdition[];
  amendments: JurisdictionCodeAmendment[];
  designCriteria: JurisdictionDesignCriteria;
  prescriptive: PrescriptiveLimits;
  fireSetbacks: FireSetbackRule[];
  /** Official sources backing this profile (the human-verification checklist). */
  citations: Array<{ label: string; sourceUrl: string }>;
  researchedAt?: string;
  verifiedAt?: string;
  verifiedBy?: string;
  updatedAt: string;
}

// Review work types (rule packs). "solar_pv_residential" is the deterministic pack;
// the others are served by the LLM general plan-review mode until dedicated packs exist.
export type ReviewWorkType = "solar_pv_residential" | "reroof" | "water_heater" | "adu" | "deck" | "general";

/** One AI-generated pre-review observation (LLM general mode). Always advisory:
 *  mapped to category "ai_review" with severity capped at "warning". */
export interface AiReviewFinding {
  title: string;
  message: string;
  severity: "warning" | "callout";
  /** Code family + section the model cites (rendered against the jurisdiction's
   *  adopted editions; "verify locally" when the profile isn't verified). */
  codeFamily?: string;
  codeSection?: string;
  sheetRef?: string;
}

export interface AiPlanReviewResult {
  provider: "claude" | "stub";
  findings: AiReviewFinding[];
  summary: string;
  confidence: "low" | "medium" | "high";
  notes: string;
}

/** LLM web-search research result for a jurisdiction's ADOPTED CODES (the code-profile
 *  onboarding path). Always confidence "seeded" until a human verifies. */
export interface JurisdictionCodeResearchResult {
  provider: "claude" | "stub";
  profile: JurisdictionCodeProfile;
  webGrounded: boolean;
  needsHumanVerification: true;
  notes: string;
}

/** Standalone review-gate submission DTO — the small, ProjectRecord-free contract
 *  the sellable POST /api/review accepts. `fields` uses parserSnapshot-compatible
 *  keys for the solar pack (snow, deadLoad, wind, roofRafterSpacing, busRating,
 *  mainBreaker, pvBreaker, module.. / inverter.., permitPath, splitPagesText, …) and
 *  free-form facts for AI-served work types. */
export interface ReviewSubject {
  workType: ReviewWorkType;
  state: string;
  ahj: string;
  utility?: string;
  applicant?: {
    name?: string;
    address?: string;
    city?: string;
    zip?: string;
  };
  system?: {
    sizeDcKw?: number;
    sizeAcKw?: number;
    interconnectionMethod?: string;
  };
  fields?: Record<string, string | number | null>;
}

export type ReviewerEvidenceStatus = "verified" | "weak" | "missing" | "profile" | "not_applicable";

export interface ReviewerFindingEvidence {
  kind: "source_excerpt" | "absence_check" | "field_value" | "process_profile" | "screenshot_placeholder";
  label: string;
  source: string;
  excerpt: string;
  confidence: "high" | "medium" | "low";
  pageHint: string;
  screenshotPath: string;
  verifier: "parser" | "normalized_field" | "rule_engine" | "ahj_profile" | "llm" | "vision";
  note: string;
}

// Result of a Claude vision pass that looked at the actual rendered plan-set
// sheet to confirm/deny a finding whose text-only evidence was weak or missing.
export interface ReviewerVisionVerdict {
  checked: boolean;
  present: boolean;
  confidence: "high" | "medium" | "low";
  page: number; // 1-based plan-set page the model inspected
  observed: string; // what the model reports seeing on the sheet
  note: string;
}

export interface ReviewerFinding {
  id: string;
  severity: "blocker" | "warning" | "callout" | "pass";
  category: "project_data" | "ahj_profile" | "plan_set" | "utility_nem" | "structural" | "electrical" | "portal" | "installer" | "ai_review";
  title: string;
  message: string;
  cityFeedback: string;
  designTeamAction: string;
  evidenceNeeded: string[];
  codeReferences: CodeReference[];
  installerCallout: boolean;
  evidenceStatus?: ReviewerEvidenceStatus;
  evidenceFound?: ReviewerFindingEvidence[];
  /** Optional Claude-vision confirmation of this finding against the rendered sheet. */
  visionVerification?: ReviewerVisionVerdict;
}

export interface FinalSubmitGate {
  mustShowAhjPreviewWindow: boolean;
  finalSubmitButtonAloneIsEnough: boolean;
  requirements: string[];
}

export interface ReviewerReport {
  projectId: string;
  generatedAt: string;
  matchedProcessProfile: AhjProcessProfile | null;
  findings: ReviewerFinding[];
  installerCallouts: ReviewerFinding[];
  finalSubmitGate: FinalSubmitGate;
}

export interface KnowledgeSource {
  label: string;
  url: string;
  sourceType: "official" | "sanitized_reference" | "learned_project" | "learned_correction" | "learned_permit_status" | "learned_batch_import" | "ai_researched";
  observedAt: string;
}

export interface CommonCorrectionPattern {
  signature: string;
  bucket: CorrectionBucket;
  rootCause: string;
  requiredAction: string;
  count: number;
  lastSeenAt: string;
  sample: string;
}

export interface PermitUtilityKnowledgeProfile {
  id: string;
  profileKey: string;
  state: string;
  ahj: string;
  utility: string;
  portalName: string;
  portalUrl: string;
  /** Underlying portal platform (Accela, ProjectDox, EnerGov…) — drives Playwright automation reuse. */
  portalPlatform: string;
  /** How submittals are made (online portal, email, in-person, combination). */
  submissionMethod: string;
  requiredDocuments: string[];
  averageTimelineDays: number | null;
  timelineSampleCount: number;
  timelineNotes: string[];
  commonCorrections: CommonCorrectionPattern[];
  projectCount: number;
  correctionCount: number;
  confidence: "seeded" | "learned" | "mixed";
  sources: KnowledgeSource[];
  notes: string;
  firstSeenAt: string;
  lastLearnedAt: string;
  updatedAt: string;
}

export interface HistoricalFailureCause {
  signature: string;
  title: string;
  count: number;
  correctionBucket: CorrectionBucket | "";
  rootCause: string;
  requiredAction: string;
  sample: string;
  severity: "blocker" | "warning" | "callout";
}

export interface HistoricalChecklistItem {
  // "external" = a document the homeowner/installer/utility provides with the package
  // (e.g. signed owner authorization). The autopilot does not produce it, so it is an
  // advisory reminder — never a "missing" gap or blocker on the service's side.
  status: "present" | "missing" | "needs_review" | "external";
  id: string;
  title: string;
  why: string;
  action: string;
  evidence: string[];
  sourceCauseSignature: string | null;
}

export interface HistoricalFailureReport {
  projectId: string;
  generatedAt: string;
  summaryLabel: string;
  matchedProjectCount: number;
  matchedFailureRecordCount: number;
  matchTags: string[];
  topRejectionCauses: HistoricalFailureCause[];
  checklist: HistoricalChecklistItem[];
  dataConfidence: "low" | "medium" | "high";
  notes: string[];
}

export type MboxEmailBucket =
  | "permit_approval"
  | "permit_correction"
  | "nem_approval"
  | "nem_correction"
  | "status_update"
  | "missing_info_request"
  | "fee_request"
  | "inspection_final_notice"
  | "spam_irrelevant";

export interface MboxExtractedLearningRecord {
  source: "email";
  type: MboxEmailBucket;
  workflow: "permit" | "nem" | "both" | "unknown";
  jurisdiction: string | null;
  utility: string | null;
  projectAddress: "REDACTED" | null;
  projectAddressHash: string | null;
  portalName: string | null;
  correctionCategory: string | null;
  correctionSubcategory: string | null;
  requiredAction: string | null;
  preventable: boolean;
  requiredDocuments: string[];
  timelineSignal: string | null;
  statusLabel: string | null;
  classifier: "deterministic" | "llm_stub" | "llm";
  confidence: number;
  sample: string;
  occurredAt: string;
}

export interface MboxKnowledgeImportResult {
  messagesScanned: number;
  learningEvents: number;
  failureExamplesImported: number;
  profilesTouched: number;
  skippedMessages: number;
  duplicateMessages: number;
  llmReviewRecommended: number;
  bucketCounts: Record<MboxEmailBucket, number>;
  extractedRecords: MboxExtractedLearningRecord[];
}

export interface EmailTrackingSource {
  id: string;
  sourceType: "mbox_path";
  label: string;
  filePath: string;
  defaultState: string;
  defaultAhj: string;
  defaultUtility: string;
  active: boolean;
  lastCheckedAt: string | null;
  lastMessageCount: number;
  lastMatchedCount: number;
  lastError: string;
  createdAt: string;
  updatedAt: string;
}

export interface EmailProjectMatch {
  id: string;
  projectId: string;
  sourceId: string | null;
  sourceSignature: string;
  sourceLabel: string;
  emailBucket: MboxEmailBucket;
  workflow: "permit" | "nem" | "both" | "unknown";
  confidence: number;
  matchReason: string;
  statusCheckId: string | null;
  correctionId: string | null;
  subject: string;
  occurredAt: string;
  createdAt: string;
}

export interface EmailTrackerRunResult {
  sourcesChecked: number;
  messagesScanned: number;
  projectMatches: number;
  statusChecksCreated: number;
  correctionsCreated: number;
  skippedDuplicates: number;
  unmatchedMessages: number;
  sourceErrors: string[];
  matches: EmailProjectMatch[];
}

export type OperationStepStatus = "not_started" | "in_progress" | "waiting" | "blocked" | "done";
export type ProjectNoteType = "pm_note" | "blocker" | "client_update" | "handoff" | "system_note";

export interface OperationStep {
  id: string;
  projectId: string;
  phaseKey: string;
  phaseName: string;
  status: OperationStepStatus;
  statusSource: "system" | "manual";
  ownerRole: string;
  dueAt: string | null;
  summary: string;
  nextAction: string;
  notes: string;
  sortOrder: number;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectNote {
  id: string;
  projectId: string;
  noteType: ProjectNoteType;
  body: string;
  createdBy: string;
  createdAt: string;
}

export interface OperationsPlan {
  projectId: string;
  generatedAt: string;
  status: OperationStepStatus;
  currentPhase: string;
  nextAction: string;
  steps: OperationStep[];
  notes: ProjectNote[];
  counts: Record<OperationStepStatus, number>;
}

export interface ProjectRunbookStep {
  id: string;
  phaseKey: string;
  phaseName: string;
  status: OperationStepStatus;
  ownerRole: string;
  dueAt: string | null;
  whatToDo: string;
  why: string;
  doneCriteria: string[];
  evidence: string[];
  notes: string;
  source: string;
  isCurrent: boolean;
}

export interface ProjectRunbook {
  projectId: string;
  generatedAt: string;
  status: OperationStepStatus;
  headline: string;
  currentStepId: string | null;
  nextAction: string;
  totalSteps: number;
  doneCount: number;
  blockedCount: number;
  waitingCount: number;
  inProgressCount: number;
  noteCount: number;
  steps: ProjectRunbookStep[];
  recentNotes: ProjectNote[];
  reportText: string;
}

export type OperationsBriefHealth = "ready" | "watch" | "blocked";
export type OperationsBriefSeverity = "pass" | "info" | "warning" | "blocker";

export interface OperationsBriefAction {
  phaseName: string;
  ownerRole: string;
  action: string;
  reason: string;
  status: OperationStepStatus;
  dueAt: string | null;
}

export interface OperationsBriefSignal {
  title: string;
  detail: string;
  severity: OperationsBriefSeverity;
  source: string;
}

export interface OperationsBriefActivity {
  title: string;
  detail: string;
  severity: OperationsBriefSeverity;
  occurredAt: string;
  source: string;
}

export interface OperationsBrief {
  projectId: string;
  generatedAt: string;
  health: OperationsBriefHealth;
  headline: string;
  currentPhase: string;
  nextAction: string;
  counts: Record<OperationStepStatus, number>;
  immediateActions: OperationsBriefAction[];
  blockers: OperationsBriefSignal[];
  readySignals: OperationsBriefSignal[];
  recentActivity: OperationsBriefActivity[];
  handoffNote: string;
}

export interface ProjectHandoffPacketSection {
  title: string;
  severity: OperationsBriefSeverity;
  source: string;
  lines: string[];
}

export interface ProjectHandoffPacket {
  projectId: string;
  generatedAt: string;
  health: OperationsBriefHealth;
  headline: string;
  nextAction: string;
  currentPhase: string;
  blockerCount: number;
  actionCount: number;
  readinessStatus: LiveProjectReadinessReport["status"];
  timelineEventCount: number;
  ownerRoles: string[];
  sections: ProjectHandoffPacketSection[];
  reportText: string;
}

export type ProjectCommunicationAudience = "internal_pm" | "installer_design" | "client_safe";

export interface ProjectCommunicationDraft {
  audience: ProjectCommunicationAudience;
  title: string;
  subject: string;
  body: string;
  severity: OperationsBriefSeverity;
  source: string;
}

export interface ProjectCommunicationDraftPacket {
  projectId: string;
  generatedAt: string;
  headline: string;
  status: OperationsBriefHealth;
  nextAction: string;
  drafts: ProjectCommunicationDraft[];
  reportText: string;
}

export interface OperationsBoardProject {
  projectId: string;
  homeownerName: string;
  projectAddress: string;
  status: ProjectStatus;
  health: OperationsBriefHealth;
  currentPhase: string;
  nextAction: string;
  ownerRole: string;
  blockerCount: number;
  activeActionCount: number;
  dueAt: string | null;
  latestActivityAt: string | null;
  latestActivity: string;
  updatedAt: string;
}

export interface OperationsBoard {
  generatedAt: string;
  totalProjects: number;
  blockedProjects: number;
  watchProjects: number;
  readyProjects: number;
  totalBlockers: number;
  totalActiveActions: number;
  projects: OperationsBoardProject[];
}

export type OperationsActionDueBucket = "overdue" | "today" | "upcoming" | "no_due";

export interface OperationsActionItem {
  projectId: string;
  stepId: string;
  homeownerName: string;
  projectAddress: string;
  health: OperationsBriefHealth;
  phaseName: string;
  status: OperationStepStatus;
  ownerRole: string;
  dueAt: string | null;
  dueBucket: OperationsActionDueBucket;
  action: string;
  reason: string;
  notes: string;
  source: string;
  blockerCount: number;
  updatedAt: string;
}

export interface OperationsActionQueue {
  generatedAt: string;
  totalActions: number;
  blockedActions: number;
  waitingActions: number;
  inProgressActions: number;
  overdueActions: number;
  todayActions: number;
  actions: OperationsActionItem[];
}

export interface OperationsOwnerWorkload {
  ownerRole: string;
  totalActions: number;
  blockedActions: number;
  waitingActions: number;
  inProgressActions: number;
  overdueActions: number;
  todayActions: number;
}

export interface OperationsDailyReport {
  generatedAt: string;
  headline: string;
  summary: string[];
  board: OperationsBoard;
  actionQueue: OperationsActionQueue;
  ownerWorkload: OperationsOwnerWorkload[];
  topProjects: OperationsBoardProject[];
  dueNow: OperationsActionItem[];
  topActions: OperationsActionItem[];
  reportText: string;
}

export type LiveProjectReadinessStatus = "done" | "needs_review" | "blocked";

export interface LiveProjectReadinessItem {
  id: string;
  title: string;
  status: LiveProjectReadinessStatus;
  ownerRole: string;
  detail: string;
  nextAction: string;
  evidence: string[];
  source: string;
}

export interface LiveProjectReadinessReport {
  projectId: string;
  generatedAt: string;
  status: "ready" | "needs_review" | "blocked";
  headline: string;
  nextAction: string;
  doneCount: number;
  needsReviewCount: number;
  blockedCount: number;
  totalCount: number;
  items: LiveProjectReadinessItem[];
  reportText: string;
}

export type ProjectTimelineEventCategory =
  | "project"
  | "pm_note"
  | "operation"
  | "qc"
  | "human_review"
  | "correction"
  | "permit_status"
  | "email"
  | "portal"
  | "submission"
  | "audit";

export interface ProjectTimelineEvent {
  id: string;
  projectId: string;
  occurredAt: string;
  category: ProjectTimelineEventCategory;
  severity: OperationsBriefSeverity;
  title: string;
  detail: string;
  actor: string;
  source: string;
  ownerRole: string;
  nextAction: string;
  evidence: string[];
  relatedId: string | null;
}

export interface ProjectTimelineReport {
  projectId: string;
  generatedAt: string;
  headline: string;
  latestActivityAt: string | null;
  totalEvents: number;
  blockerCount: number;
  warningCount: number;
  emailCount: number;
  correctionCount: number;
  events: ProjectTimelineEvent[];
  reportText: string;
}

export type ProjectProcessLaneKey = "intake" | "permit" | "nem" | "closeout";
export type ProjectProcessStepStatus = "not_started" | "in_progress" | "waiting" | "blocked" | "done";

export interface ProjectProcessStep {
  id: string;
  laneKey: ProjectProcessLaneKey;
  label: string;
  status: ProjectProcessStepStatus;
  ownerRole: string;
  summary: string;
  nextAction: string;
  evidence: string[];
  source: string;
}

export interface ProjectProcessLane {
  key: ProjectProcessLaneKey;
  title: string;
  status: ProjectProcessStepStatus;
  summary: string;
  currentStep: string;
  nextAction: string;
  steps: ProjectProcessStep[];
}

export interface ProjectProcessMap {
  projectId: string;
  generatedAt: string;
  headline: string;
  status: ProjectProcessStepStatus;
  permitStatus: ProjectProcessStepStatus;
  nemStatus: ProjectProcessStepStatus;
  nextAction: string;
  lanes: ProjectProcessLane[];
  reportText: string;
}

export type SubmitGateDecision = "blocked" | "ready_to_stage" | "staged_awaiting_human" | "submitted_tracking";
export type SubmitGateLane = "intake" | "qc" | "permit" | "nem" | "portal" | "tracking" | "closeout";
export type SubmitGateCheckStatus = "pass" | "warning" | "blocker";

export interface SubmitGateCheck {
  id: string;
  title: string;
  lane: SubmitGateLane;
  status: SubmitGateCheckStatus;
  ownerRole: string;
  requirement: string;
  evidence: string[];
  nextAction: string;
  source: string;
}

export interface SubmitGateReport {
  projectId: string;
  generatedAt: string;
  decision: SubmitGateDecision;
  headline: string;
  nextAction: string;
  canPrepareSubmission: boolean;
  canHumanSubmit: boolean;
  blockerCount: number;
  warningCount: number;
  passCount: number;
  checks: SubmitGateCheck[];
  manualSubmitChecklist: string[];
  reportText: string;
}

export type InstallerActionCategory =
  | "design"
  | "field_verification"
  | "utility_nem"
  | "documents"
  | "correction"
  | "portal"
  | "approval_tracking";

export interface InstallerActionItem {
  id: string;
  category: InstallerActionCategory;
  severity: OperationsBriefSeverity;
  title: string;
  ask: string;
  why: string;
  ownerRole: string;
  dueBefore: string;
  evidence: string[];
  source: string;
  relatedId: string | null;
}

export interface InstallerActionPacket {
  projectId: string;
  generatedAt: string;
  headline: string;
  status: "clear" | "needs_action" | "blocked";
  totalActions: number;
  blockerCount: number;
  warningCount: number;
  installerActionCount: number;
  designActionCount: number;
  nemActionCount: number;
  nextAction: string;
  items: InstallerActionItem[];
  reportText: string;
}

export interface WorkflowStep {
  id: string;
  label: string;
  status: "done" | "needs_review" | "blocked" | "ready";
  summary: string;
  action: string;
}

export interface ProjectWorkflow {
  projectId: string;
  generatedAt: string;
  status: "blocked" | "needs_review" | "ready_to_stage" | "staged_or_submitted";
  nextAction: string;
  canPrepareSubmission: boolean;
  steps: WorkflowStep[];
  historicalReport: HistoricalFailureReport;
  reviewerReport: ReviewerReport;
  applicationDocs: ApplicationDocumentPackage;
}

export interface AuditLog {
  id: string;
  projectId: string | null;
  actorType: "system" | "human" | "llm" | "portal_bot";
  actorName: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ProjectDetail {
  project: ProjectRecord;
  qcResults: QcResult[];
  humanReviewItems: HumanReviewItem[];
  corrections: CorrectionRecord[];
  permitCheckTargets: PermitCheckTarget[];
  permitStatusChecks: PermitStatusCheck[];
  emailProjectMatches: EmailProjectMatch[];
  portalRuns: PortalRun[];
  submissions: SubmissionRecord[];
  auditLogs: AuditLog[];
  projectNotes: ProjectNote[];
  // Pipeline stage (computed from project.status by backend/src/projectStage.ts).
  stageKey: string;
  stageIndex: number;
  stageLabel: string;
  stageCount: number;
  isBlocked: boolean;
}

// ---------------------------------------------------------------------------
// THE TOKENIZED, NO-LOGIN CLIENT STATUS PAGE (/api/public/status/:token → frontend/status.html).
//
// Declared here rather than inside the backend because frontend/status.html is the other half of
// the contract and there is nothing else holding the two in step. Everything on this page is
// visible to anyone holding the link, so the shape is a whitelist: raw scraped portal prose,
// correction text, fees, credentials, documents and internal review state are all absent BY
// CONSTRUCTION — a field that is not here cannot be published by accident.
// ---------------------------------------------------------------------------

/**
 * HOW MUCH WE KNOW ABOUT ONE PUBLISHED READING. THREE VALUES, AND NEVER TWO.
 *
 * Every badge on both customer pages is a STORED reading, and there are three separable things
 * that can be true about it — not two:
 *
 *   "current"    — the drift pass RAN and today's rules agree with what the row stored.
 *   "stale"      — the drift pass RAN and today's rules read that same stored text differently.
 *   "unverified" — THE DRIFT PASS COULD NOT RUN AT ALL. We do not know which of the other two
 *                  this is. It is not an all-clear, and it must never render as one.
 *
 * The third value exists because the boolean did not have room for it. `needsRecheck:false` used
 * to mean BOTH "we checked and it is current" AND "our check blew up", and the pages rendered the
 * reassuring reading of that: Christopher Ivy's building permit — stalled at Coos Bay's counter on
 * "Intake Requirements Needed" since Sep 3 — went on telling the homeowner "In review by the
 * jurisdiction" with no caveat at all, in a payload BYTE-IDENTICAL to a confirmed-fresh one. A
 * failed check that looks exactly like a passed check is worse than no check, because it is the
 * shape of a fact.
 *
 * So the wire carries the three-valued answer and the pages word each one differently. Anything
 * that reduces this to a boolean must reduce "unverified" to the CAUTIOUS side — see needsRecheck.
 */
export type ReadingFreshness = "current" | "stale" | "unverified";

/** One line on a client's timeline: a filing, NAMED, and what it moved TO. */
export interface PublicStatusHistoryEntry {
  /** When this state was FIRST seen — the moment it CHANGED, not the last time we looked. */
  at: string;
  /** WHICH filing moved: "Building permit" / "Electrical permit" / "Utility interconnection (NEM)". */
  label: string;
  /** The jurisdiction's own reference for that filing, so two permit rows are never ambiguous. */
  applicationNumber: string;
  /**
   * Client-facing wording — says who the next move belongs to, AND who is holding it: the
   * jurisdiction on a permit, the UTILITY on an interconnection. See publicCheckLabel.
   */
  statusLabel: string;
  /** The raw outcome. For badge STYLING only; the words are in statusLabel. */
  outcome: string;
  /**
   * What we know about this entry AS A CLAIM ABOUT TODAY. Only an entry that is still its filing's
   * CURRENT state can be "stale" or "unverified"; a superseded entry is what we believed then, not
   * a claim about now, and stays "current" (i.e. unmarked) forever. The stored row is never
   * rewritten — it is an audit trail — so the cure for either mark is a fresh check, which writes
   * a NEW row.
   */
  reading: ReadingFreshness;
  /**
   * "DO NOT PUBLISH THIS AS TODAY'S FACT" — true for BOTH `stale` and `unverified`.
   *
   * It is `reading !== "current"`, computed in one place beside it, and the widening is the whole
   * point: the boolean used to mean "today's rules disagree with this row", which left a FAILED
   * drift pass falling through to `false` — the same value a confirmed-fresh reading carries. Any
   * consumer still reading only this boolean now errs toward the caveat instead of the all-clear.
   * A consumer that wants to word the two cases differently reads `reading`.
   */
  needsRecheck: boolean;
}

/** One filing being tracked, as the client sees it. */
export interface PublicStatusTrack {
  type: string;
  label: string;
  statusLabel: string;
  outcome: string;
  lastCheckedAt: string | null;
  applicationNumber: string;
  permitNumber: string;
  /** What we know about this badge's reading: checked-and-current, checked-and-stale, or NOT CHECKED. */
  reading: ReadingFreshness;
  /** `reading !== "current"` — true for a stale reading AND for one we could not check. */
  needsRecheck: boolean;
}

export interface PublicProjectStatusPayload {
  project: {
    address: string;
    ahj: string;
    utility: string;
    status: string;
    updatedAt: string;
  };
  tracks: PublicStatusTrack[];
  history: PublicStatusHistoryEntry[];
  submissions: Array<{ type: string; status: string; submittedAt: string | null }>;
}

/** Where an extracted value came from — shown to the PM to verify accuracy. */
export interface ParserFieldEvidence {
  source: "plan_set" | "utility_bill" | "meter_photo";
  /** Sheet/page hint, e.g. "PV-2" or "Cover". */
  sheet?: string;
  /** Short verbatim excerpt the value was read from. */
  excerpt?: string;
}

/** One extracted parser field with provenance and confidence. */
export interface ParserExtractedField {
  /** Scalar for almost every field. STRUCTURED for the few the prompt asks for as
   *  objects/arrays — notably `pvArrays`, the per-roof-plane breakdown utility portals
   *  need one repeater row from. Stringifying those collapsed them to "[object Object]",
   *  which the normalizer then discarded, so a multi-plane project silently filed a
   *  single synthesized array. */
  value: string | number | null | Array<Record<string, unknown>> | Record<string, unknown>;
  confidence: number; // 0-1
  evidence?: ParserFieldEvidence;
}

/** Result of the LLM-assisted parser extraction across plan set + utility bill + meter photo. */
export interface ParserLlmExtraction {
  provider: "claude" | "stub";
  /** Field id -> extracted value+confidence. Keys match the parser form field ids. */
  fields: Record<string, ParserExtractedField>;
  /** Fields the model could not confidently determine — surface for human review. */
  lowConfidenceFields: string[];
  /** Short human-readable notes about anything ambiguous or worth verifying. */
  notes: string;
}

export interface LLMProvider {
  /** LLM-assisted extraction of all project fields from raw document text (plan set, utility bill, meter photo). */
  extractProjectFields(input: {
    planText?: string;
    utilityBillText?: string;
    meterText?: string;
    /** Stamped/sealed structural letter or calc package — the source of record for
     *  the structural screen (loads, exposure, framing) and for stamp evidence. */
    structuralLetterText?: string;
    defaultState?: string;
  }): Promise<ParserLlmExtraction>;
  /** Vision-based extraction from the actual document images — accurate for account/meter numbers that OCR mangles. */
  extractProjectFieldsFromImages(input: {
    images: { kind: "utility_bill" | "meter_photo" | "plan_page"; base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }[];
    defaultState?: string;
  }): Promise<ParserLlmExtraction>;
  classifyCorrection(input: {
    correctionText: string;
    project?: ProjectRecord;
  }): Promise<{ bucket: CorrectionBucket; confidence: number; notes: string }>;
  draftResponse(input: {
    correctionText: string;
    project?: ProjectRecord;
  }): Promise<{ draft: string; confidence: number }>;
  /** Web-search research of a jurisdiction's ADOPTED CODES (editions, amendments,
   *  design criteria) for the code-profile onboarding flow. Saved as confidence
   *  "seeded"; a human verifies before citations become authoritative. */
  researchJurisdictionCodes(input: { ahj: string; state: string }): Promise<JurisdictionCodeResearchResult>;
  /** LLM GENERAL PLAN REVIEW (hybrid review gate): Claude vision over rendered plan
   *  pages for ANY permit work type, grounded in the jurisdiction's adopted codes.
   *  Always advisory — the caller maps findings to category "ai_review", severity
   *  capped at warning, and they never gate anything. */
  reviewPlanSetGeneral(input: {
    workType: ReviewWorkType;
    jurisdictionLabel: string;
    codeSummary: string;
    verifiedProfile: boolean;
    pageImagesBase64: string[];
    extractedText?: string;
    applicantFacts?: Record<string, string>;
  }): Promise<AiPlanReviewResult>;
  /** Extract structured data from an image (base64 PNG/JPEG) — used for image-only SLDs */
  visionExtract(input: {
    imageBase64: string;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    prompt: string;
  }): Promise<Record<string, unknown>>;
  /** Synthesize AHJ/utility requirements from past project history */
  synthesizeKnowledge(input: {
    ahjName: string;
    state: string;
    utility?: string;
    pastApplicationTexts: string[];
    correctionPatterns: string[];
  }): Promise<{
    requiredDocuments: string[];
    commonRejectionReasons: string[];
    tips: string[];
    confidence: "low" | "medium" | "high";
  }>;
  /** Research an UNKNOWN AHJ's residential-solar permitting requirements from the
   *  model's knowledge, so a new jurisdiction can be onboarded automatically.
   *  Advisory — flagged for human verification before relying on it. */
  researchAhjRequirements(input: {
    ahj: string;
    state: string;
    utility?: string;
    /** What the KB already knows (imported reference data) — a verified-first starting point. */
    knownContext?: string;
  }): Promise<AhjResearchResult>;
  /** Research an UNKNOWN utility's residential NEM / interconnection process from the
   *  model's knowledge, so a new utility can be onboarded the same way as an AHJ.
   *  Advisory — flagged for human verification before relying on it. */
  researchUtilityRequirements(input: {
    utility: string;
    state: string;
    ahj?: string;
    /** What the KB already knows (imported reference data) — a verified-first starting point. */
    knownContext?: string;
  }): Promise<UtilityResearchResult>;
  /** Given a list of portal form fill/select interactions that weren't auto-bound to a
   *  field during recording (exact-match missed), ask the model to suggest which project
   *  or client field each typed value corresponds to. Returns null for portal-literal
   *  values (dropdown options, fixed text) that shouldn't be data-bound. Called ONCE
   *  at save-time (not per keystroke) so latency is acceptable. */
  suggestRecipeFieldBindings(input: {
    unbound: Array<{ index: number; action: string; label?: string; value: string }>;
    fieldValues: Record<string, string>;
  }): Promise<Array<{ index: number; field: string | null }>>;
  /** Autonomous portal-learning: given the fillable fields on the CURRENT portal page
   *  plus the project's available field values, decide what to fill where, which "next"
   *  button advances the form, and which button is the final submit (recorded, never
   *  clicked). Advisory + safety-gated — the result is verified before any recipe is
   *  trusted. */
  planPortalFields(input: PortalFieldPlanInput): Promise<PortalFieldPlan>;
  /** Verify a learned portal fill: compare the review-screen field/value pairs against
   *  the project's authoritative data and return a per-field match + an overall
   *  accuracy verdict that gates whether the learned recipe may be trusted for replay. */
  verifyPortalFill(input: PortalFillVerifyInput): Promise<PortalFillVerification>;
  /** Vision verification: look at a SCREENSHOT of the rendered review/confirm screen
   *  (what a human sees — on Accela the review step shows the whole application) and check
   *  the visible values against the project data, flagging contradictions and blank required
   *  fields. More robust than DOM scraping on read-only review pages. */
  verifyPortalFillVision(input: PortalFillVisionVerifyInput): Promise<PortalFillVerification>;
  /** Look up an inverter/microinverter model's rated continuous AC output from datasheet
   *  knowledge (web search as a fallback when unsure), and derive a suggested PV breaker.
   *  Advisory only — the result pre-fills the human-review boxes for approval. */
  lookupInverterSpec(input: {
    inverterModel: string;
    inverterQty?: number;
    /** System AC nameplate (kW). When the model can't be resolved, the inverter's
     *  continuous AC output current is derived from the nameplate (VA / voltage),
     *  which is the most reliable fallback (the AC nameplate IS the inverter output). */
    acNameplateKw?: number;
    /** Service line-to-line voltage (default 240 for residential split-phase). */
    serviceVoltageV?: number;
  }): Promise<InverterSpecLookup>;

  /** Web-search for the AHJ's official blank permit application PDF and return
   *  candidate direct-download URLs to try. Advisory — URLs must be fetched and
   *  validated as PDFs before use. */
  findAhjFormUrl(input: {
    ahj: string;
    state: string;
    formType?: string;
    /** What the KB already knows (imported reference data) — a verified-first starting point. */
    knownContext?: string;
  }): Promise<AhjFormUrlResult>;

  /** Map a blank form's AcroForm field names onto project data sources so the
   *  form can be auto-filled. Returns the textField/checkbox source maps using
   *  the same source convention as ahjForms (project.* / snapshot.* / client.* /
   *  computed.* / lit:*). */
  mapAcroFormFields(input: {
    ahj: string;
    state: string;
    formName: string;
    fields: { name: string; type: string }[];
    availableSources: string[];
  }): Promise<AhjFieldMapResult>;

  /** Vision-map a FLAT (non-fillable / scanned) form: given page images, return
   *  where each project value should be drawn, as normalized (0..1) coordinates
   *  from each page's top-left. Used to build a coordinate overlay so flat PDFs
   *  can be auto-filled too — computed once and saved. */
  mapFlatFormOverlay(input: {
    ahj: string;
    state: string;
    formName: string;
    pages: { base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }[];
    availableSources: string[];
  }): Promise<AhjOverlayMapResult>;

  /** Bounded tool-use loop for the edge agents (run triage, correction handling).
   *  The caller supplies read-only / propose-only tools; the loop runs until the
   *  model stops calling tools or maxIterations is hit. Every tool is a narrow
   *  local handler — the agent never gets a shell or network. Stub mode returns
   *  immediately without invoking any tool. */
  runToolAgent(input: AgentRunInput): Promise<AgentRunResult>;
}

/** A tool the agent may call. `handler` runs locally; its return value is JSON-
 *  serialized back to the model as the tool_result. Return an image block array
 *  to let the model SEE a screenshot (used by read_bundle_file). */
export interface AgentToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<AgentToolResult> | AgentToolResult;
}

/** Either plain text/JSON (serialized) or image content blocks for vision tools. */
export type AgentToolResult =
  | { kind: "json"; value: unknown }
  | { kind: "text"; text: string }
  | { kind: "image"; base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp"; caption?: string };

export interface AgentRunInput {
  label: string;
  system: string;
  user: string;
  tools: AgentToolDef[];
  maxIterations?: number;
  effort?: "low" | "medium" | "high";
}

export interface AgentRunResult {
  provider: "claude" | "stub";
  /** The model's final text (after its last tool call), if any. */
  finalText: string;
  /** How many model turns ran. */
  iterations: number;
  /** True when the loop hit maxIterations without the model stopping on its own. */
  hitIterationCap: boolean;
  stopReason: string | null;
}

export interface AhjOverlayMapResult {
  provider: "claude" | "stub";
  fields: AhjOverlayPlacement[];
  /** Detected signature lines where the operator's stored signature can be stamped. */
  signatures: AhjSignaturePlacementNorm[];
  notes: string;
}

export interface AhjSignaturePlacementNorm {
  /** Whose signature: applicant | owner | contractor | electrician | other. */
  role: string;
  page: number;
  /** Normalized bottom-left corner of the signature box (0..1 from top-left). */
  nx: number;
  ny: number;
  /** Box size as a fraction of page width/height. */
  widthFrac: number;
  heightFrac: number;
  label?: string;
  /** Adjacent "date signed" line position (normalized baseline), if present. */
  dateNx?: number;
  dateNy?: number;
}

export interface AhjOverlayPlacement {
  /** Value source string (project.* / snapshot.* / client.* / computed.* / lit:*). */
  source: string;
  /** 0-based page index. */
  page: number;
  /** Normalized horizontal position of the text start, 0 (left) .. 1 (right). */
  nx: number;
  /** Normalized vertical baseline position, 0 (top) .. 1 (bottom). */
  ny: number;
  /** Font size in points (default 9). */
  size?: number;
  /** Optional max width as a fraction of page width, to truncate long values. */
  maxWidthFrac?: number;
  /** What this placement is (label text), for human review. */
  label?: string;
}

export interface AhjFormUrlResult {
  provider: "claude" | "stub";
  formName: string;
  /** Direct-download URLs for the blank PDF, best first. May be empty. */
  candidateUrls: string[];
  formType: string;
  confidence: "low" | "medium" | "high";
  notes: string;
  /** The AHJ forms/applications landing page these were found on. */
  formsPageUrl?: string;
  /** How the completed application is submitted: email | online portal | in-person | combination. */
  submissionMethod?: string;
  /** URL of the actual submittal portal (login/landing), pre-filled into the record/training step. */
  submittalPortalUrl?: string;
  /** Platform the submittal portal runs on: Oregon ePermitting | Portland Portal | ProjectDox | Email | Other. */
  portalPlatform?: string;
  /** AHJ-specific submittal requirements posted on the site. */
  submittalRequirements?: string;
  /** Permit structure: "combo" (one combined permit) vs "separate" (distinct BLD + ELE permits). */
  permitStructure?: "combo" | "separate" | "unknown";
  /** TRUE when the lookup could not be MADE — the web-search call errored or timed out — as
   *  opposed to being made and finding nothing. Without it a 45-second abort is reported as
   *  "this AHJ has no forms page", which is a claim about the jurisdiction rather than about us,
   *  and the operator goes looking for a page that is very likely sitting there. Measured on
   *  City of Salem: findAhjFormUrl aborted at 45,016ms and the harvest printed "research found
   *  no forms page (0 direct candidates)". */
  lookupFailed?: boolean;
  /** Why it could not be made, when it could not. */
  lookupError?: string;
}

export interface AhjFieldMapResult {
  provider: "claude" | "stub";
  /** AcroForm text field name -> value source (e.g. "project.homeownerName"). */
  textFields: Record<string, string>;
  /** AcroForm checkbox field name -> check rule. */
  checkboxes: Record<string, { source: string; equals?: string }>;
  notes: string;
}

// ---- Autonomous portal learning ----
export interface PortalFieldPlanInput {
  url: string;
  pageTitle: string;
  /** Fillable fields + candidate buttons on the current page (index is stable for this call).
   *  `section` is the field's enclosing heading / wizard-step (e.g. "Customer Information" vs
   *  "Installer Information") — used to disambiguate otherwise-identical contact blocks. */
  fields: Array<{ index: number; label: string; fieldType: string; options?: string[]; section?: string }>;
  /** Short, redacted page text snippet. */
  bodyText: string;
  /** The project/client field values available to fill (secrets already redacted). */
  projectFields: Record<string, string>;
  /** Labels already filled on prior pages (context for a multi-page form). */
  alreadyFilledLabels: string[];
  /** Optional knowledge-base context for the AHJ/utility (portal hints, required docs, etc.). */
  kbContext?: string;
  /** Optional jurisdiction + permit-discipline context for portals (e.g. Accela / Oregon
   *  ePermitting) where the SAME street address resolves to multiple authorities — a CITY
   *  row and a COUNTY row — each exposing a different application-type list. Tells the planner
   *  which results row to Select and which application type to check (structural vs electrical). */
  jurisdictionContext?: string;
  /** True when no fillable inputs were found on this page — likely a dashboard/home/landing page.
   *  The planner should look for a navigation link/button to reach the application form. */
  isDashboard?: boolean;
  /** Set when the learn loop detected it is stuck or cycling. Carries a directive + recent
   *  step trace so the planner picks a different, forward-progress action instead of looping. */
  recoveryHint?: string;
  /** Base64 PNG screenshot of the current page for VISION-ASSISTED planning — lets the planner
   *  read the visible section headings/layout (the authoritative who-owns-this-block signal)
   *  rather than reasoning from labels + text alone. Learn-time only; omitted when unavailable. */
  screenshotBase64?: string;
}
export interface PortalFieldPlan {
  /** Which field index to fill with what. Prefer `field` (a reusable project-field key,
   *  e.g. "homeownerName") over a literal `value` so the recorded recipe generalizes. */
  fills: Array<{ index: number; value: string; field?: string }>;
  /** A "Next/Continue" button that advances to the next form page (NEVER the final submit). */
  advanceIndex?: number;
  /** A link/button on a dashboard/home page that navigates TO the application form.
   *  Used when the current page has no fillable fields (e.g. portal home after login).
   *  Clicking it is recorded as a "goto" step, then learning continues on the next page. */
  navigateIndex?: number;
  /** The final submit button — recorded for the allowlist, never clicked by the learner. */
  finalSubmitIndex?: number;
  /** True once this is the review/confirm/submit screen. */
  atReview: boolean;
  confidence: "low" | "medium" | "high";
  notes: string;
}
export interface PortalFillVerifyInput {
  /** The field/value pairs scraped from the review screen. */
  reviewFields: Array<{ label: string; value: string }>;
  /** The project's authoritative field values to check against. */
  projectFields: Record<string, string>;
  bodyText: string;
}
export interface PortalFillVisionVerifyInput {
  /** Base64 PNG/JPEG of the rendered review/confirm screen (what a human would see). */
  screenshotBase64: string;
  mimeType?: "image/png" | "image/jpeg" | "image/webp";
  /** Field/value pairs scraped from the DOM (may be thin on read-only review pages). */
  reviewFields: Array<{ label: string; value: string }>;
  /** The project's authoritative field values to check against. */
  projectFields: Record<string, string>;
  bodyText: string;
}
export interface PortalFillVerification {
  matches: Array<{ label: string; expected: string; found: string; ok: boolean }>;
  overallConfidence: "low" | "medium" | "high";
  /** True = the fill matches the project data closely enough to trust the recipe for replay. */
  accurate: boolean;
  issues: string[];
  notes: string;
}

export interface InverterSpecLookup {
  provider: "claude" | "stub";
  inverterModel: string;
  inverterQty: number;
  /** Per-unit rated continuous AC output current in amps (this is the QC "inverter output"). */
  outputCurrentA: number | null;
  /** Per-unit rated continuous AC output power in VA/W. */
  outputVa: number | null;
  /** outputCurrentA * inverterQty. */
  totalContinuousCurrentA: number | null;
  /** Suggested PV backfeed breaker/OCPD: next standard size >= 1.25 * total continuous current. */
  derivedPvBreakerA: number | null;
  confidence: "low" | "medium" | "high";
  /** "model knowledge" | "web search" | "" — where the rating came from. */
  source: string;
  notes: string;
  needsHumanVerification: boolean;
}

export interface AhjResearchResult {
  provider: "claude" | "stub";
  portalName: string;
  /** The UNDERLYING portal platform/vendor (Accela, ProjectDox/Avolve, EnerGov/Tyler,
   *  MyGov, etc.) — many branded portals (e.g. "Oregon ePermitting") run on Accela,
   *  so the Playwright automation for that platform is reusable across AHJs (only the
   *  entry URL + login differ; no retraining of the automation flow). */
  portalPlatform: string;
  portalUrl: string;
  submissionMethod: string;
  requiredDocuments: string[];
  commonCorrections: string[];
  tips: string[];
  /** Step-by-step submittal process the model believes this AHJ uses. */
  submissionSteps: string[];
  confidence: "low" | "medium" | "high";
  /** Always true for AI research — a human must verify before trusting it. */
  needsHumanVerification: boolean;
  notes: string;
}

/** AI-researched (or human-verified) onboarding profile for a UTILITY's residential
 *  net-metering / interconnection process. Mirrors AhjResearchResult but focused on
 *  the NEM/interconnection portal and its application requirements, so a new utility
 *  can be taught the same way a new AHJ is. */
export interface UtilityResearchResult {
  provider: "claude" | "stub";
  /** Interconnection/NEM portal name as the utility refers to it (e.g. "PowerClerk"). */
  portalName: string;
  /** Underlying portal platform/vendor (PowerClerk / Clean Power Research, Tyler,
   *  custom). Many utilities share PowerClerk, so the automation is reusable across
   *  utilities on the same platform — only the entry URL + login differ. */
  portalPlatform: string;
  portalUrl: string;
  submissionMethod: string;
  /** Documents the utility's NEM/interconnection application requires (one-line, site
   *  plan, inverter technical specs/cut sheets, account/meter proof, signed agreement…). */
  requiredDocuments: string[];
  /** How the utility handles smart-inverter settings in its NEM app — e.g. a Yes/No
   *  question ("Will you use the utility's recommended smart inverter settings?")
   *  answered Yes for UL 1741-SB listed inverters. NOT a grid-profile drawing. */
  smartInverterSettings: string;
  /** Whether/how meter aggregation is offered (most residential projects: no aggregation). */
  meterAggregation: string;
  /** AC disconnect rule (e.g. "lockable AC disconnect within 10 ft of the meter; max AC
   *  output permitted without a disconnect varies by service type"). */
  acDisconnectRule: string;
  /** Export-capacity limit / tier note (e.g. "export over 25 kW is evaluated as Tier 2"). */
  exportLimitNote: string;
  commonCorrections: string[];
  tips: string[];
  /** Ordered steps a coordinator follows in this utility's NEM application. */
  submissionSteps: string[];
  confidence: "low" | "medium" | "high";
  /** Always true for AI research — a human must verify before trusting it. */
  needsHumanVerification: boolean;
  notes: string;
}

// ---------------------------------------------------------------------------
// Portal record/replay recipes — teach the bot a NEW AHJ or utility portal by
// recording the steps once, then replay them for future projects (substituting
// project/client data + uploading the right docs, always stopping before final
// submit). Admins can delete and re-record an incomplete recipe.
// ---------------------------------------------------------------------------

/** Which phase of the bot run a recorded step belongs to. The replay runner drives
 *  login → open → fill → upload → review; steps are grouped by phase. */
/**
 * Where a step sits in a portal run.
 *
 * `correct` is the way back into a filing that has ALREADY been submitted. A utility that
 * suspends an application does not want it re-filed — it exposes a named form on the
 * project's landing page that reopens the original wizard with the reviewer's notes beside
 * the offending fields (PacifiCorp: "PP - Suspended - Changes Needed From Customer"; PGE:
 * the same shape plus per-correction confirmation checkboxes). Submitting that form replaces
 * the filing rather than creating a second one.
 *
 * It is a phase of its own rather than more `open` steps because the two must never be
 * confused: `open` starts a NEW application and is barred from touching existing records,
 * while `correct` deliberately reaches into one — under the naming guard in
 * adapters/correctionForm.ts, since the control beside the correction form cancels the
 * customer's interconnection.
 */
export type RecipePhase = "open" | "fill" | "upload" | "review" | "correct";

export type RecipeAction =
  | "goto"
  | "click"
  | "fill"
  | "select"
  | "check"
  | "uncheck"
  | "press"
  | "waitFor"
  | "upload"
  | "stopForReview";

/** A portable locator descriptor captured at record time. Replay tries the richest
 *  available strategy first (role+name, label, placeholder, testId, text, then css). */
export interface RecipeSelector {
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  testId?: string;
  css?: string;
  /** Optional child-iframe key to scope the locator into (portals like Accela use dialogs).
   *  Either the frame element's name/id, or "src:<pathname>" for frames with no name/id
   *  (incl. cross-origin embeds) — see frameSelectorFor in portal-bot/src/safeAction.ts. */
  frame?: string;
  /** 0-based index when multiple match; omitted means .first(). */
  nth?: number;
  exact?: boolean;
  /** Alternate locator strategies tried in order when the primary selector finds
   *  nothing — survives portal UI updates that change one attribute but not all.
   *  Recorder contributors should capture 1-2 fallbacks (e.g. a stable css id as a
   *  backup for a role+name, or vice versa). Each fallback is a full RecipeSelector
   *  but its own nested `fallbacks` are ignored (one level deep). */
  fallbacks?: RecipeSelector[];
}

/** Attributes of the recorded element captured at record time. NEVER used to
 *  build a locator; consumed only by replay self-heal to rank candidates when
 *  the label anchor is ambiguous (two bare "Manufacturer" fields). Attribute
 *  names/labels only — never values, never secrets. Old recipes lack the bag. */
export interface StepFingerprint {
  id?: string;
  name?: string;
  placeholder?: string;
  ariaLabel?: string;
  section?: string;
  /** Reserved for short preceding text; not populated in v1. */
  nearText?: string;
}

export interface RecipeStep {
  action: RecipeAction;
  phase?: RecipePhase;
  selector?: RecipeSelector;
  /** For fill/select: the project/client field key to substitute at replay
   *  (e.g. "accountNumber", "installerCompanyName"). Resolved server-side. */
  field?: string;
  /** Literal value (goto url, press key, or a fixed fill/select value). */
  value?: string;
  /** For upload: which document type to attach (e.g. "sld", "site_plan"). */
  docType?: string;
  /** For upload: the control is a custom Browse/Upload widget whose real <input> is
   *  created on click — replay it via the browser file-chooser dialog (click + setFiles)
   *  rather than setInputFiles on a (non-existent) static input. */
  viaFileChooser?: boolean;
  /** Don't fail the run if this step's target isn't found. */
  optional?: boolean;
  /** A credential/secret field (password, account#, meter#, MFA). The recorder
   *  NEVER stores its literal value — it must be bound to the encrypted credential
   *  store / redacted project data, not a plaintext recipe value. */
  sensitive?: boolean;
  /** The SINGLE approved final-submit click. autoSubmit replay will ONLY click a
   *  step flagged isFinalSubmit (an allowlist) — never a step inferred from button
   *  text. The operator sets this at approval time. Fee-payment steps are NEVER
   *  flagged; they are always blocked regardless. Without this flag, autoSubmit
   *  safely stops at the review screen and never clicks final submit. */
  isFinalSubmit?: boolean;
  note?: string;
  /** See StepFingerprint — heal tie-break metadata captured at record time. */
  fingerprint?: StepFingerprint;
}

export type PortalRecipeStatus = "recording" | "complete" | "needs_rerecord";

export interface PortalRecipeLoginStep {
  /** Selector for the username/email field. */
  usernameSel?: RecipeSelector;
  /** Selector for the password field. */
  passwordSel?: RecipeSelector;
  /** Selector for the submit/login button. */
  submitSel?: RecipeSelector;
}

export interface PortalRecipe {
  id: string;
  /** Whether this teaches an AHJ permit portal or a utility NEM portal. */
  scopeType: "ahj" | "utility";
  /** The KB profile key (state|ahj|utility) this recipe serves. */
  profileKey: string;
  state: string;
  ahj: string;
  utility: string;
  portalPlatform: string;
  portalUrl: string;
  status: PortalRecipeStatus;
  version: number;
  steps: RecipeStep[];
  /** Optional selectors for auto-filling the login form when a session expires. */
  loginStep?: PortalRecipeLoginStep;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  notes: string;
  /** Hybrid: operator has trusted this portal for one-click approve-submit. Off by default. */
  autoSubmitEnabled?: boolean;
  /** Permit discipline this recipe was learned for — "structural" | "electrical" | "combo".
   *  Empty for utility (NEM) recipes and for legacy rows recorded before recipes gained the
   *  dimension. An AHJ holds ONE recipe PER DISCIPLINE: the city/structural and
   *  county/electrical filings drive different portal steps. */
  discipline?: string;
}

// ---------------------------------------------------------------------------
// Network-level recipes (Path B — bypass the DOM, replay the portal's own
// save requests). PowerClerk/Accela are server-rendered apps whose SPA POSTs
// every field to backend endpoints with the session cookie + an anti-forgery
// token. Capturing and replaying those requests is far more robust than
// driving brittle custom dropdowns, and it runs headless on the cloud.
// ---------------------------------------------------------------------------

/** One value inside a captured request body that matched a known project/client
 *  field at record time, so replay substitutes the NEW project's value.
 *  The literal recorded value of a SENSITIVE field (account#, meter#, password)
 *  is NEVER stored — `sensitive` is set and `recordedValue` is omitted. */
export interface NetworkFieldBinding {
  /** The project/client field key whose value appeared (e.g. "accountNumber"). */
  field: string;
  /** Location of the value in the body. For JSON bodies a dot/bracket path
   *  (e.g. "Fields[3].Value"); for urlencoded/form bodies the form key. */
  jsonPath?: string;
  formKey?: string;
  /** The value seen at record time — for NON-sensitive fields only, used to
   *  locate-and-replace at replay. Omitted when `sensitive`. */
  recordedValue?: string;
  /** A credential/PII field: literal value is redacted; replay pulls it from the
   *  encrypted credential store / project data, never from the recipe. */
  sensitive?: boolean;
}

/** A single save/mutation request captured during recording. Replay re-fires it
 *  with a freshly-scraped anti-forgery token and the new project's field values. */
export interface NetworkRequestRecord {
  /** Capture order — replay fires requests in this sequence. */
  seq: number;
  method: string;
  /** Full URL as captured. Per-project path segments (ProjectId/FormId) are
   *  templated via `pathParamKeys` so replay swaps in the new draft's IDs. */
  url: string;
  resourceType: string;
  contentType?: string;
  /** Raw request body as captured (with sensitive values already redacted to a
   *  placeholder token). Replay rehydrates bindings before sending. */
  bodyRaw?: string;
  /** Header name that carried the anti-forgery/CSRF token, if any. Replay never
   *  reuses the recorded token value — it re-scrapes a live one. */
  csrfHeaderName?: string;
  /** Whether the body itself carried the token (e.g. __RequestVerificationToken). */
  csrfBodyKey?: string;
  bindings?: NetworkFieldBinding[];
  /** HTTP status observed at record time — replay verifies it matches. */
  responseStatus?: number;
  /** True if this request is (or precedes) the final submit. Replay STOPS here in
   *  guided-manual mode and never fires it; the human submits. */
  isFinalSubmit?: boolean;
  note?: string;
}

export type NetworkRecipeStatus = "recording" | "complete" | "needs_rerecord";

export interface NetworkRecipe {
  id: string;
  scopeType: "ahj" | "utility";
  profileKey: string;
  state: string;
  ahj: string;
  utility: string;
  portalPlatform: string;
  portalUrl: string;
  status: NetworkRecipeStatus;
  version: number;
  /** Which URL path segments are per-project, captured so replay can template them.
   *  e.g. { programId: "JYEHFEPJXQ00", projectId: "NPAA8645J795", formId: "6FJDHPYAD2H1" } */
  pathParamKeys?: { programId?: string; projectId?: string; formId?: string };
  requests: NetworkRequestRecord[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  notes: string;
}
/** A paid receipt is an observed component, not proof of a whole filing cost. */
export interface PaidFeeReceipt {
  jurisdiction: string;
  permitNumber: string;
  receiptNumber: string;
  discipline: "electrical" | "building" | "unknown";
  authorityAmountUsd: number;
  processingFeeUsd: number;
  /** Separately labelled service fees whose recipient is not established. */
  otherFeeUsd?: number;
  invoiceNumber?: string;
  totalPaidUsd: number;
  paidAt: string;
}
