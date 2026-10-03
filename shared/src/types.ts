// A project is BORN `parsed`: upload and parse happen together in the parser, so there is
// no separate pre-parse status to occupy. `intake_uploaded`, `submit_staging` and
// `resubmit_staging` were removed (2026-09-19) — all three had zero writers anywhere in the
// codebase yet were labeled, bannered with operator instructions and offered as board
// filters: dead vocabulary rendered as live UI. Live-DB landing gate: zero rows carrying any
// of the three, in any column of any of the 54 tables. Portal RUN state (staging in
// progress) belongs to `portal_runs.status` / the job queue, not to the project's lifecycle.
export type ProjectStatus =
  | "parsed"
  | "qc_failed"
  | "qc_passed"
  | "ready_to_stage"
  | "awaiting_human_submit"
  | "submitted"
  | "correction_received"
  | "correction_triaged"
  | "waiting_on_designer"
  | "ready_to_resubmit"
  | "awaiting_human_resubmit"
  | "ready_for_issue"
  | "issued"
  | "approved"
  | "nem_approved"
  | "handoff_ready"
  | "blocked";

// WHERE INSIDE THE STAGE THE JOB ACTUALLY IS — the machine-readable half of what
// `projects.current_stage` has always tried to say in prose.
//
// current_stage is free-text in every one of its writers ("PGE staged. Human must verify and
// submit manually."), which is fine for a human reading one project and useless for anything
// that has to decide, filter or render. The permit monitor even overwrites it with a raw
// portal message and no status change, so the column cannot be trusted to describe the
// pipeline at all. Rather than rewrite those strings — a stored label is a matching key, and
// rewriting them would break nothing today only by luck — this enum is written ALONGSIDE them
// into `projects.stage_detail`. The prose stays exactly as it is and becomes a display note;
// this is the truth.
//
// "" IS AN HONEST UNKNOWN AND MUST RENDER AS NOTHING. Every row that existed before the column
// did carries "", and so does any project whose current state no writer has claimed yet. A
// placeholder chip there would invent progress that was never reported — so renderers show
// no chip at all, never a neutral-looking one.
//
// MINIMAL BY DESIGN: exactly the values Round A writes, one per writer site. Later rounds add
// values additively (`approved_awaiting_filing` in C1, the corrections legs in B) — a new
// value is a new writer, never a relabel of an old one.
export type StageDetail =
  // No writer has spoken for this project's current state. Renders as nothing.
  | ""
  // Born from the parser, QC not yet run (createProject, superseded seconds later by QC).
  | "awaiting_qc"
  // qc.ts: the QC gate's own verdict.
  | "qc_failed"
  | "qc_passed"
  // prepareSubmission tail: the filing sits on the portal's review screen and a human must
  // verify and click submit. This is the state hard rule 1 exists to protect.
  | "staged_for_review"
  // prepareSubmission tail: the run walled at an MFA/CAPTCHA challenge. NOTHING was staged —
  // distinct from a failure because the operator's next move is different (finish the
  // challenge in the open browser, then re-stage).
  | "staging_paused"
  // prepareSubmission tail: the adapter failed before review. NOTHING was staged.
  | "staging_failed"
  // prepareSubmission tail: an operator-approved auto-submit actually clicked final submit.
  | "auto_submitted"
  // captureConfirmation / submittalTracks: one track is filed, others still await a human.
  | "submitted_partial"
  // captureConfirmation / submittalTracks: every track this project files is now filed.
  | "submitted_all"
  // captureConfirmation: a human confirmed the filing, and it carried NO application or permit
  // number — so nothing can be looked up and NO permit_check_target was invented for it. This
  // filing is not being checked by anyone, and it is the operator's move to add the number
  // under Permit/NEM Checks.
  //
  // It OUTRANKS submitted_partial/submitted_all deliberately. Those two read as reassurance
  // ("it's in, we're watching"), and on a filing with no number that is false. How many tracks
  // are still out stays answerable from the tracks panel; whether anything is watching THIS
  // filing was answerable nowhere. Retired by the next capture that carries a number.
  | "submitted_untracked"
  // Permit monitor: the jurisdiction/utility is still reviewing.
  | "under_review"
  // A correction has been received and triaged; the bucket says whose move it is.
  | "correction_open"
  // The correction's items are closed AND THE FILING IS STILL ON FILE — the utility/AHJ
  // reopened the original application, the operator corrected it in the portal, and it
  // never stopped existing. The project goes back to `submitted`; nothing is re-staged.
  | "correction_resolved"
  // The correction's items are closed and NOTHING IS ON FILE — no submitted submission row
  // for this project. The corrected package has to be re-staged and re-filed, so the project
  // goes to `ready_to_resubmit` and re-enters the pipeline at the Submit stage. Distinct
  // from `correction_resolved` because the operator's next move is opposite: there, wait for
  // the agency; here, drive 3 · Prepare Submittal. Round A wrote `correction_resolved` on
  // BOTH legs as a placeholder while the status write was still the `parsed` rewind; this is
  // the value that leg was waiting for.
  | "correction_resolved_restage"
  // reopenCorrectionOnPortal: the SUSPENDED filing's own correction form was reopened on the
  // portal and the revised documents were staged through the attach gate — and then automation
  // STOPPED. The project sits at `awaiting_human_resubmit` waiting for a person to review the
  // reopened application and click the portal's own resubmit (hard rule 1). Distinct from
  // `staged_for_review`, which is a NEW filing waiting on its first submit: here an application
  // already exists on the account and is being amended in place.
  | "correction_reopened"
  // markCorrectionResubmitted: a human confirmed the reopened application was actually
  // resubmitted. The corrections it answers are closed (resubmitted=1) and the project returns
  // to `submitted`. Distinct from `submitted_all` — that is a first filing captured through
  // captureConfirmation, which writes submission rows; this amends a filing that never stopped
  // existing and writes none.
  | "correction_resubmitted"
  // applyCorrectionProposals on a `B_designer_fix` correction: the triage was approved and the
  // ball is in the DESIGNER's court — the plan set / calcs have to come back revised before
  // anything can be re-filed. The one sub-stage whose exit is a human's word (the operator's
  // "Revisions received" action). Never inferred from a document landing on the project: an
  // upload is not evidence the revisions are complete, and a designer attaching one partial
  // sheet must not advance the job.
  | "awaiting_design_revision"
  // recordDesignRevisionsReceived: the operator said the revised design is in hand. The project
  // leaves the designer wait for `ready_to_resubmit` (the Submit stage) and faces the full
  // re-QC and every staging gate from there. Distinct from `correction_resolved_restage`, which
  // is the same destination reached by CLOSING the correction; this one ends the designer wait
  // with the correction still open, because the package has not gone back out yet.
  | "design_revisions_received"
  // Permit monitor outcomes, each a real milestone rather than a shade of "in review".
  | "permit_approved"
  | "ready_for_issue"
  | "permit_issued"
  | "nem_approved"
  // Permit issued AND NEM approved — the installer handoff is ready.
  | "handoff_ready"
  // An operator moved the status by hand through the audited override. Deliberately says only
  // that a human did it: the reason they typed is on the audit row, which is the record.
  | "operator_override"
  // getReviewerReport / getReviewerReportWithVision on a PRE-STAGE project whose reviewer gate
  // came back with ZERO blockers. The reviewer gate has no approve button — its "approval" IS
  // the report returning clean — so this is the machine record of that verdict. Deliberately a
  // stage_detail and NOT a status: passing the gate does not move the job along the pipeline,
  // it only says the packet is defensible; `ready_to_stage` (written when the docs are built)
  // stays the status either way. Never written once a project has staged: re-running the report
  // on a filed job must not relabel where that job is.
  | "reviewer_gate_approved"
  // runAutopilotApproval on a REAL (non-mock) portal: the operator's regulatory approval is
  // recorded and the automation STOPS. The filing itself has not happened — a person must open
  // the portal, click its own submit, and then capture the confirmation here.
  //
  // THE STATUS DELIBERATELY STAYS `awaiting_human_submit`. That is what the approval gate keys
  // on (autopilot.ts), what the staged portal run still says, and what is TRUE: nothing has been
  // filed. Without this value the approval left no trace a renderer could see — the autopilot
  // panel went straight back to "Click Approve & Submit to file", so a half-done filing looked
  // exactly like one nobody had touched. This is the half the screen can act on.
  //
  // It is cleared by the next real event: captureConfirmation writes submitted_partial/
  // submitted_all, so capturing the number retires the banner by itself.
  | "approved_awaiting_filing";

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
  // A suspended filing's correction form was reopened and staged; the operator reviews
  // and clicks the portal's resubmit themselves. DELIBERATELY not "awaiting_human_submit":
  // that status is what the approve/auto-submit path selects runs by (autopilot.ts
  // awaitingPortalRun), and a correction reopen must never become eligible for a
  // delegated final submit — the resubmit confirmation is a human's click, recorded only.
  | "awaiting_human_resubmit"
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
  /** Contractor licences beyond the named columns, one per issuing state/kind (Iowa "EL"
   *  electrical, Florida EC/CVC, Texas TECL, Utah DOPL...). clientMatch matches them like a CCB. */
  stateLicenses?: ClientStateLicense[];
  /** A PARTNER contractor this client files through, per portal and/or AHJ (Iowa City: the plan
   *  set is the solar company's, the permit's "Contractor (Electrical)" is a local licensed EC). */
  partnerContacts?: ClientPartnerContact[];
  createdAt: string;
}

export interface ClientStateLicense {
  /** Two-letter issuing state. */
  state: string;
  /** What the licence is: a canonical LicenceKind (shared/src/licenceKinds.ts — parseStateLicenses
   *  normalises "EC", "CSL", "HIC", "general contractor"… to one). "" = a stored free-text kind no
   *  canonical kind matched; such a licence is never offered to a slot (it is named instead). */
  kind: string;
  number: string;
  /** YYYY-MM-DD when the licence expires ("" / absent = not on file). */
  expires?: string;
  /** The PERSON a person licence belongs to (master / supervising electrician, construction
   *  supervisor) — the name a "licence holder" slot takes. Absent = not on file. */
  holder?: string;
}

/** What a licence IS — the one vocabulary the fill, the portal overlay and the submit gate use to
 *  answer "which number goes in this slot". The list with labels is LICENCE_KINDS
 *  (shared/src/licenceKinds.ts). business_registration is NEVER offered as a contractor licence. */
export type LicenceKind =
  | "contractor"
  | "electrical_contractor"
  | "construction_supervisor"
  | "home_improvement_contractor"
  | "solar_contractor"
  | "master_electrician"
  | "business_registration";

/** The answer to "which licence goes in this slot" (clients.licenceFor). number "" = none on file of
 *  the kind the slot needs, or the choice is ambiguous — never another kind's, state's or company's. */
export interface LicenceAnswer {
  number: string;
  kind: LicenceKind | "";
  state: string;
  /** How a person reads it: "CCB", "MA construction supervisor licence"… */
  label: string;
  expires: string;
  holder: string;
  /** Why the number is "" (for the operator item / gate evidence); "" when a number was found. */
  reason: string;
  /** When ambiguous: the licences it could have been, labelled ("MA construction supervisor licence CS-…"). */
  candidates: string[];
}

export interface ClientPartnerContact {
  /** The permit contact role this partner fills, e.g. "contractor_electrical". */
  role: string;
  companyName: string;
  contactName: string;
  licenseNumber: string;
  licenseState: string;
  email: string;
  phone: string;
  /** Scope: a portal type and/or an AHJ name ("" = any). */
  portalType: string;
  ahj: string;
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

/** "actual" is the portal's fee TYPED BY THE OPERATOR off its fee/review screen; "portal_record"
 *  is the portal's fee READ AUTOMATICALLY off the filed record by the permit monitor. Both rank
 *  as confidence "actual" (it is the portal's own number either way), and they stay two values
 *  because who read it is a different fact: a machine read is never "verified". */
export type PermitFeeSource =
  | "actual"
  | "portal_record"
  | "learned_history"
  | "published_schedule"
  | "valuation_estimate"
  | "unknown";

/** One filed record's fees, as the permit monitor last read them off the portal
 *  (portal_fee_readings). */
export interface PortalFeeRecordReading {
  recordNumber: string;
  jurisdiction: string;
  /** "read" = the amounts are the portal's own; anything else is WHY nothing was read, and
   *  carries no amount (a record with no fee invoiced yet is not a $0 fee). */
  status: "read" | "not_loaded" | "none_invoiced" | "unreadable" | "wrong_record";
  totalUsd: number | null;
  paidUsd: number | null;
  outstandingUsd: number | null;
  lines: Array<{ label: string; amountUsd: number; status: "paid" | "outstanding" | "invoiced"; date: string }>;
  sourceUrl: string;
  /** When the amounts were read; "" when they never were. */
  readAt: string;
  attemptedAt: string;
  /** The record's own status when read. Until it is issued the jurisdiction may invoice more. */
  recordOutcome: string;
  final: boolean;
  detail: string;
}

/** Every filed record of one billing track, read or not. */
export interface PortalFeeRecordSummary {
  track: "permit" | "nem";
  /** Every filed record of this track has a reading. Only then is the sum the track's fee. */
  complete: boolean;
  /** Sum over the records that were read; null when none was. */
  totalUsd: number | null;
  /** Every read record is issued — the fees are unlikely to grow. */
  final: boolean;
  records: PortalFeeRecordReading[];
  /** Filed records with no reading, and why. */
  unread: Array<{ recordNumber: string; jurisdiction: string; reason: string }>;
  /** "read from the portal record 187-26-000309-STR on 2026-09-27 (+ …)". */
  provenance: string;
}

/** ONE THING A PERSON'S CONFIRM VOUCHES FOR, as the fee card shows it (fees-close2, hard rule 3:
 *  "verified" is a person vouching for exactly what they saw — never a bracket or an amount that
 *  was not on their screen). */
export interface FeeConfirmItem {
  /** The fee_schedules row, and its version as the card was drawn (research re-saves in place). */
  id: string;
  updatedAt: string;
  /** "bracket": this row's bracket at this amount. "delegation": this pointer row's "the other
   *  authority collects this permit" hop. */
  kind: "bracket" | "delegation";
  /** Whose row it is ("Coos County"; the city on a delegation) and which permit. */
  authority: string;
  discipline: string;
  /** The bracket and the amount as shown — "5.01 KVA to 15 KVA", 160. "" / null on a delegation. */
  bracketLabel: string;
  feeUsd: number | null;
  /** On a delegation: the authority the pointer hops to (profile key, and its name for the eye). */
  collectedBy: string;
  collectedByAuthority: string;
  /** Somebody already vouched for this item (or its row was verified whole): a Confirm leaves it
   *  exactly as it is. */
  verified: boolean;
}

/** THE PORTAL'S NUMBER BESIDE THE RESEARCHED ONE — never a silent replacement. */
export interface FeeComparison {
  /** What the published schedule / learned history / estimate says without the portal's number. */
  researchedUsd: number | null;
  researchedSource: PermitFeeSource;
  researchedConfidence: FeeConfidence;
  /** The portal's figure (read, or typed by the operator) this is compared with. */
  portalUsd: number;
  portalSource: PermitFeeSource;
  /** portalUsd − researchedUsd; null when the researched figure is unknown. */
  differenceUsd: number | null;
  /** Which of the two the line shows as its amount. */
  shown: "portal" | "researched";
  note: string;
}

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
  /** WHO CHARGES THIS PERMIT FEE, when it is not the AHJ: a cited state rule's issuer (New Mexico
   *  CID / MHD — submissionFees via feeIssuer.permitFeeProject), e.g. "Permit fee — New Mexico
   *  Construction Industries Division (CID) (state schedule, cited)". Absent when the AHJ issues. */
  permitFeeIssuerLabel?: string;
  permitFeeConfidence: FeeConfidence;
  /** THE PUBLISHED SCHEDULE WAS RE-READ BY A MACHINE AND THIS AMOUNT'S LINE IS PRINTED IN IT —
   *  label and fee on one row of the cited document. A qualifier on a `seeded` amount, never a
   *  confidence of its own: the operator-facing words are "matches the published schedule", and
   *  it NEVER reads "verified" (a person — hard rule 3). False on every tier but
   *  published_schedule. */
  permitFeeCorroborated: boolean;
  /** The printed line that supports THIS amount (the schedule's bracketQuote), verbatim — ""
   *  when there is none, or when the amount is a sum no single published line states. */
  permitFeeEvidenceQuote: string;
  /** Who verified the published schedule behind this amount, and when — "" unless the tier is
   *  published_schedule and its confidence "verified". */
  permitFeeVerifiedBy: string;
  permitFeeVerifiedAt: string;
  /** The portal's figure beside the researched one, whenever a portal figure exists (read off
   *  the record, or typed by the operator) — both numbers and the difference. */
  permitFeeComparison: FeeComparison | null;
  /** What the permit monitor has read off this track's filed records, complete or not. */
  portalFeeRecords: PortalFeeRecordSummary | null;
  paymentMethod: FeePaymentMethod;
  serviceFeeUsd: number;
  totalUsd: number | null;
  payment: SubmissionPaymentRecord | null;
  /** The jurisdiction's bill for this track, itemised — see FeeChargeBreakdown.
   *  Resolved for EVERY quote, like `paymentMethod` and `permitFeeSourceUrl`:
   *  what a City of Portland filing is MADE OF does not change because an
   *  operator typed the portal's total in. Empty where the schedule holds one
   *  permit line and nothing else. */
  permitFeeCharges: FeeChargeBreakdown[];
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
  /** The person who verified it (every line, when the amount is a total) and when — only
   *  meaningful beside confidence "verified"; "" / absent otherwise. */
  verifiedBy?: string;
  verifiedAt?: string;
  /** The org(s) whose person verified the rows behind it ('' = none on record). The NAME above
   *  is a tenant's fact: the quote shows it only on a project of that org (rule 6). */
  verifiedOrgIds?: string[];
  /** THE AMOUNT WAS COMPUTED FROM A GUESSED INPUT. A valuation-basis schedule (Portland's
   *  structural ladder: $540.78 for the first $25,000, $10.26 per $1,000 above it) is walked
   *  with the project's job valuation — and when the project carries none, with a per-watt
   *  ESTIMATE instead. The arithmetic is exact either way and the answer is not: the same house
   *  prices at $592.08 from a contract figure and $602.34 from the estimate, because the guess
   *  landed one step higher. A third dimension alongside `confidence` and `corroborated` for
   *  the same reason they are separate — this one grades the INPUT, not the table or the
   *  citation. The quote seam degrades such a fee to "estimated", which is what makes the sheet
   *  print ≈ and tell the operator to true it up from the portal's own fee screen. */
  valuationEstimated?: boolean;
  /** Optional: schedules that state how the fee is paid. Absent means unknown,
   *  and a mailed-check hint may instead be read out of `sourceQuote`. */
  paymentMethod?: FeePaymentMethod;
  /** The name the schedule is filed under, which may be the legal name where
   *  the project carries an operator short name ("Coos Bay" / "City of Coos Bay"). */
  matchedName?: string;
  /** Populated when feeUsd is null: why the schedule did not evaluate. */
  reason?: string;
  /** THE BILL, ITEMISED. See FeeChargeBreakdown. Absent/empty on a jurisdiction
   *  that publishes one permit line and nothing else, which is most of them. */
  charges?: FeeChargeBreakdown[];
}

/** ONE CHARGE ON THIS FILING, PRICED — the presentation grain, not the storage one.
 *
 *  A FILING IS NOT A PERMIT. The operator's own paid City of Portland receipt for a
 *  3.52 kW rooftop system is FOUR BILLS FROM THREE BUREAUS totalling $762.93:
 *
 *    Fire - Plan Review                 $50.00
 *    Electrical Permit RS              $201.00  + St Sur $24.12  (12% of the permit)
 *    Land Use Plan Review Res          $217.00
 *    Bldg Plan Rvw/Processing RS/MI/MP  $99.45  (65% of the building permit)
 *    Building Permit RS                $153.00  + St Sur $18.36  (12% of the permit)
 *
 *  Two of those seven charges are permits. Quoting only the permits is how a $762.93
 *  filing printed as $298, sourced and confident. So the evaluated answer carries
 *  every charge it is made of, and the screens draw the list rather than a lump.
 *
 *  `partOfLineFee` IS LOAD-BEARING ARITHMETIC, not a display hint: the permit and its
 *  surcharges are ALREADY inside the line's own `feeUsd`, and a consumer that sums
 *  this list without reading it double-counts the permit. Charges with
 *  `partOfLineFee:false` are the ones added on top of the lines to reach the total.
 *
 *  `amountUsd: null` is the whole point of the type. A charge the jurisdiction levies
 *  only sometimes, whose trigger the recorded project facts do not answer, is carried
 *  HERE with its reason — never dropped. Dropping it is what makes a partial total
 *  read as a complete one, and a total containing one of these is null, not smaller. */
export interface FeeChargeBreakdown {
  /** The jurisdiction's own printed wording for this charge. */
  label: string;
  /** 'permit' | 'state_surcharge' | 'community_surcharge' for the parts of the
   *  permit line itself, else the stored ancillary kind ('plan_review',
   *  'land_use_review', 'fire_review', 'processing', 'surcharge', 'other'). */
  kind: string;
  /** Null when this charge could not be priced for this project — see `reason`. */
  amountUsd: number | null;
  /** True when the permit line's own amount already contains this charge. */
  partOfLineFee: boolean;
  /** True when the schedule says only some filings incur it. */
  conditional: boolean;
  /** THIS CHARGE IS FOR SOMETHING THAT HAS NOT HAPPENED — a reinspection, a plan revision after
   *  submittal, checksheets beyond the two the review includes. It is LISTED, so an operator can
   *  see what those would cost, and it never nulls a total or appears as an unknown: a filing
   *  that has not been made cannot have failed an inspection. Distinct from an ordinary
   *  `conditional`, which is an open question about THIS filing (is a plan review required at
   *  this size?) and does still hold the total. */
  futureContingent?: boolean;
  /** Populated when amountUsd is null: why, and what would resolve it. */
  reason: string;
  /** The printed row this charge was matched on, verbatim. "" when there is none. */
  quote: string;
  sourceUrl: string;
}

// --- Project fee sheet -----------------------------------------------------

export interface ProjectFeeSheetLine {
  track: "permit" | "nem";
  /** Who is owed the money ("City of Coos Bay", "Ameren Illinois"). */
  jurisdiction: string;
  /** "local_review" = the AHJ's own zoning / site-development review fee, a line of its own where a
   *  STATE agency issues the permits (feeIssuer.localPermitReview; issue #56). Absent on the
   *  permit and NEM lines. */
  role?: "local_review";
  /** The card's heading when the payee is not simply "the AHJ": the state issuer on the permit
   *  line, the AHJ's review on the local_review line. Absent otherwise. */
  issuerLabel?: string;
  feeUsd: number | null;
  source: PermitFeeSource;
  basis: string;
  bracketLabel: string | null;
  sourceUrl: string | null;
  confidence: FeeConfidence;
  /** See SubmissionPaymentQuote.permitFeeCorroborated — "matches the published schedule", a
   *  machine check, never "verified". */
  corroborated: boolean;
  /** The printed schedule line supporting this amount, verbatim; "" when there is none. */
  evidenceQuote: string;
  /** A PERSON MAY CONFIRM THIS LINE: its amount is a researched ("seeded") published-schedule
   *  figure. Confirming marks the schedule row(s) behind it human-verified under the signed-in
   *  person's name (POST /api/projects/:id/fee-sheet/confirm) — the one place "verified" is
   *  written from the dashboard. False on every other tier and grade. */
  confirmable: boolean;
  /** WHAT A CONFIRM WOULD VERIFY, ITEM BY ITEM, WITH THE ROWS' VERSIONS — each line's bracket at
   *  its amount (and the pointer hop it was reached through), exactly as this card shows them.
   *  The Confirm dialog names these; the click sends them back with the amount it displayed; the
   *  server records exactly these items (never a whole row) and only when they — amount, rows,
   *  versions, brackets — are still what stands (409 otherwise). [] unless `confirmable`. */
  confirmRows: FeeConfirmItem[];
  /** Who verified the schedule behind this amount and when; "" unless confidence is "verified"
   *  on the published_schedule tier. */
  verifiedBy: string;
  verifiedAt: string;
  /** See SubmissionPaymentQuote.permitFeeComparison / portalFeeRecords. */
  comparison: FeeComparison | null;
  portalRecords: PortalFeeRecordSummary | null;
  paymentMethod: FeePaymentMethod;
  serviceFeeUsd: number;
  /** This track's client total, null whenever the jurisdiction fee is unknown. */
  totalUsd: number | null;
  /** False when the fee is not KNOWN. A known $0 is known; a valuation ESTIMATE
   *  is not — the number still travels on feeUsd with confidence "estimated",
   *  and the sheet's `unknowns` names the gap. known:true beside an estimate
   *  was the machine-readable claim that nothing here is unknown. */
  known: boolean;
  /** WHAT THIS FEE IS MADE OF, when the jurisdiction charges more than a permit.
   *  Carried whichever tier won the amount — like `paymentMethod`, the shape of
   *  the bill is a fact about the jurisdiction, not about where the number came
   *  from. Empty on the jurisdictions that publish one line, which is most. */
  charges: FeeChargeBreakdown[];
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
  /** The enum half of `currentStage` (see StageDetail). Ships on the project LIST items and on
   *  the detail payload's `project`, because both are built by mapProject. Optional only
   *  because normalizeProject builds an in-memory record before any row exists; every record
   *  that has been through the database carries it, "" included. Absent and "" mean the same
   *  thing — unknown — and both must render as nothing. */
  stageDetail?: StageDetail;
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
  /** THE OPERATOR'S PER-TRACK ISSUER (split issuer, operator fact 2026-09-28: "Electrical permit
   *  issued through Yamhill; Building permit issued through Newberg"). An Oregon city can run its
   *  own building program while the county (or the state) issues the electrical permit, so ONE
   *  project AHJ cannot say who issues every track. Stored like the other operator-entered facts —
   *  flat parser-snapshot keys written by PUT /api/projects/:id (trackIssuerBuilding /
   *  trackIssuerElectrical / trackIssuerCombo / trackIssuerMpu, normalize.TRACK_ISSUER_SNAPSHOT_KEYS)
   *  — and mapped here by mapProject / normalizeProject. Absent when none is set. Read ONLY through
   *  permitProcess.trackIssuer; MPU follows electrical unless its own is set. */
  trackIssuers?: TrackIssuerOverrides;
  /** Set ONLY by permitProcess.projectForTrack on the TRACK-SCOPED VIEW it returns (ahj replaced by
   *  the track's issuer) — never persisted, never mapped from a row. It names the project's own AHJ
   *  so the per-job lookup's cited answer about this permit still reaches the view, and makes the
   *  view idempotent (a view of a view is itself). */
  trackView?: { track: string; projectAhj: string; source: "operator" | "lookup" | "state_rule" };
}

/** The permit tracks an issuing agency can be named for. NEM is never one: a utility files it. */
export type IssuerTrackKey = "building" | "electrical" | "combo" | "mpu";
export type TrackIssuerOverrides = Partial<Record<IssuerTrackKey, string>>;
/** THE ONE ANSWER to "which agency issues THIS track's permit" (permitProcess.trackIssuer):
 *  the operator's per-track issuer, else the per-job lookup's cited per-permit agency when it names
 *  another agency than the project AHJ, else a cited state rule naming a STATE issuer (New Mexico
 *  CID / MHD where the AHJ has no building department), else the project AHJ. */
export interface TrackIssuerAnswer {
  name: string;
  source: "operator" | "lookup" | "state_rule" | "project";
  /** The lookup's (or state rule's) source page and words (source "lookup" / "state_rule"). */
  sourceUrl?: string;
  quote?: string;
  /** The operator's value on file for this track ("" when none) — what the card's input shows. */
  override: string;
  /** An operator value that was NOT honoured, and why (it names an agency in another state). */
  refused?: string;
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
  /** The server's ONE answer to "what does this project need next, and from whom"
   *  (backend/src/nextStep.ts), compact for the board. Same rule table as
   *  GET /api/projects/:id/next-step; `gateChecked:false` means the list tier did not run the
   *  submit gate (too costly per row), so a gate/reviewer blocker is only on the full answer. */
  nextStep: NextStepCompact;
}

// ---------------------------------------------------------------------------
// NEXT STEP — backend/src/nextStep.ts. Before this, "what is needed next" was guessed in
// several places that disagreed (the client-side banner, the board chip, current_stage prose,
// the autopilot badge replaying an old job result). One rule table, first match wins.
// ---------------------------------------------------------------------------
export type NextStepWho = "me" | "designer" | "customer" | "ahj" | "utility" | "nobody";
export type NextStepUrgency = "overdue" | "today" | "waiting" | "done";
export type NextStepKey =
  | "operator_blocked"
  | "correction_overdue"
  | "portal_paused"
  | "automation_running"
  | "staging_failed"
  | "qc_not_run"
  | "qc_failed"
  | "qc_review_pending"
  | "gate_blocked"
  | "gap_fill_missing"
  | "resubmit_awaiting_me"
  | "staged_awaiting_submit"
  | "approved_awaiting_filing"
  | "fee_due"
  | "correction_open"
  | "payment_due"
  | "ready_to_stage"
  | "filing_untracked"
  | "portal_readings"
  | "waiting_on_agency"
  | "handoff_ready"
  | "done"
  | "archived"
  | "unknown";
export interface NextStepWhy {
  text: string;
  /** A dashboard element id the operator can be taken to (a panel or a control). */
  fixTarget?: string;
}
export interface NextStep {
  key: NextStepKey;
  who: NextStepWho;
  urgency: NextStepUrgency;
  /** One sentence. Never interpolates homeowner name/address — agency names only. */
  headline: string;
  why: NextStepWhy[];
  /** The ONE thing to press: an existing dashboard <button> id, or null when the move is
   *  outside the dashboard (a portal, a designer) or has no single control. */
  button: { id: string; label: string } | null;
  stageIndex: number;
  since?: string;
  /** Did this answer include the submit gate + reviewer blockers (the detail tier)? */
  gateChecked: boolean;
  /** Every required filing is made (each required track filed or done) — the gate has nothing
   *  left to hold back. Derived in nextStep.ts; the client must not re-derive it from `key`. */
  allFiled: boolean;
  /** A list-tier answer (gateChecked:false) that the full answer may change: something is still
   *  to file and the rule table passed the submit-gate rule without running the gate. */
  gateCanOverrule: boolean;
  /** A draft is staged on a portal awaiting a person (an unfiled track's awaiting_human_submit
   *  run, or a reopened correction form awaiting the human resubmit), whatever `key` says. */
  hasStagedDraft: boolean;
}
export interface NextStepCompact {
  key: NextStepKey;
  who: NextStepWho;
  urgency: NextStepUrgency;
  headline: string;
  buttonId: string | null;
  gateChecked: boolean;
  allFiled: boolean;
  gateCanOverrule: boolean;
  hasStagedDraft: boolean;
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

/** How a correction's text relates to the text it was read from (corrections.source_text).
 *  "items": the conditions / review comments read off a portal page (the page is sourceText).
 *  "whole_text": a page was read but no such block was found — the whole text IS the correction,
 *  and a screen showing it must say so. "not_extracted": entered as-is (a typed note, an email) or
 *  stored before extraction existed — sourceText is "". */
export type CorrectionExtraction = "items" | "whole_text" | "not_extracted";

/** The filing a correction answers, by track (migration v43): from the submissions row or the
 *  tracking target it was read on, never from its prose. '' = unknown. */
export type CorrectionTrack = "" | "building" | "electrical" | "combo" | "mpu" | "nem";

export interface CorrectionRecord {
  id: string;
  projectId: string;
  source: "email" | "portal" | "manual";
  /** The correction itself — for a portal reading, what was read off the page, not the page. */
  correctionText: string;
  /** The full text the correction was read from (the portal record page), kept as evidence. */
  sourceText: string;
  extraction: CorrectionExtraction;
  /** The bucket in plain words, from the one label map (corrections.humanizeBucket). */
  bucketLabel: string;
  correctionBucket: CorrectionBucket;
  rootCause: string;
  requiredAction: string;
  assignedTo: string;
  draftResponse: string;
  humanApproved: boolean;
  resubmitted: boolean;
  newRuleRecommended: boolean;
  track: CorrectionTrack;
  /** The submissions row this answers, when one could be named. */
  submissionId: string | null;
  /** Groups the items of one notice: one notice is one correction cycle. */
  noticeId: string;
  /** The AHJ's / utility's own date for the notice; null = only the ingestion time is known. */
  noticedAt: string | null;
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
  // WHICH TRACK this run staged — the `permit_type` column ("nem", "building", "electrical",
  // "combo", "permit", "mpu"). Mapped through so the project screen can NAME the portal an
  // operator still has to go and file in: a `nem` run points at the UTILITY, everything else at
  // the AHJ. The run's result_json is not an option for that — only the RecipeAdapter writes a
  // `portalName` into it (measured on the live DB: 59 AutoLearnAdapter rows carry none), so a
  // renderer reading it would name the portal on some filings and go silent on others.
  permitType?: string;
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
  // The AHJ has approved the permit but will not issue it until fees are paid. NOT "issued":
  // the fee is a human action still outstanding on this track.
  | "ready_for_issue"
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
  /** How this track is filed, as a kind (submittalTracks.channelKindOf). in_person / email / mail =
   *  a person delivers the packet outside this tool — shown as a bold banner, never grey text. */
  channelKind?: "portal" | "in_person" | "email" | "mail" | "unknown";
  /** No recipe of its own: the recipe this project's LAST run of this track borrowed (another entity's,
   *  same portal — portalRecipes.findBorrowableRecipe), read from that run's result. null = none used. */
  borrowedRecipe?: { recipeId: string; recipeVersion: number | null; learnedFor: string; recordType: string; portalHost: string; lastUsedAt: string } | null;
  /** PERMIT tracks only: the agency that issues this track's permit and where that answer came from
   *  (permitProcess.trackIssuer) — every portal/recipe answer on this card is that agency's. */
  issuer?: TrackIssuerAnswer;
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
  /** The portal record's own status field, verbatim ("Ready to Issue"); "" when none is stated or the
   *  reading came from an email. Shown beside statusLabel so the AHJ's words are always visible. */
  portalStatedStatus?: string;
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
  /**
   * Set (alongside "resolved") when the AHJ's APPLICATION set is empty because NOTHING is known about
   * it — structure unknown, no flags, no cited documents (requiredDocuments.documentInventory). The
   * packet renders it as an advisory "which application(s) <AHJ> requires is not known" row and
   * NEVER the pass-green all-clear: an unasked question is not an answered one.
   */
  applicationSetUnknown?: string;
  /** Why the inventory could not be computed, for the operator. Set only alongside
   *  missingDocumentsStatus === "unavailable". */
  missingDocumentsError?: string;
  /**
   * Required documents the inventory has not seen on disk YET that the staging-time fill
   * produces from a stored template (owedMissingDocuments' `filledAtStaging`) — held OUT of
   * missingDocuments, because they are not the operator's to attach, and named here so the
   * screen can say "filled at staging" instead of letting them vanish. Set alongside
   * missingDocumentsStatus === "resolved".
   */
  filledAtStagingDocuments?: Array<{
    docType: string;
    label: string;
    lane: "permit" | "nem";
    why: string;
  }>;
  /**
   * Required forms Stage DOWNLOADS (or researches) and fills itself before it counts
   * (owedMissingDocuments' `acquiredAtStaging`, gates-proper C1) — held out of missingDocuments
   * and named here with how Stage gets each one. Set alongside missingDocumentsStatus === "resolved".
   */
  acquiredAtStagingDocuments?: Array<{
    docType: string;
    label: string;
    lane: "permit" | "nem";
    why: string;
    via: "curated" | "cited" | "research";
    sourceUrl: string;
    /** The form research pass for this AHJ/path is running RIGHT NOW (started at `since`): the
     *  App Docs panel says so and holds its "Find missing official forms" button until it ends. */
    inFlight?: { since: string };
  }>;
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
    /** When a person verified the row (null = nobody has) — the badge says "Verified" only then. */
    verifiedAt?: string | null;
    verifiedBy?: string;
  };
  /** Human callout of the permit TYPE: combo vs separate BLD/ELE + submission method. */
  permitType?: string;
  /**
   * THE RESOLVED PERMIT PATH AND WHAT DECIDED IT (permitPath.resolvePermitPath).
   *
   * Prescriptive and engineered are mutually exclusive — the AHJ takes exactly one
   * application — so this single call decides which application is built, which fee
   * schedule applies and whether a PE stamp is required. It was previously legible only
   * as prose inside the generated cover/manifest documents, so an operator could see the
   * conclusion but not the evidence, and could not tell a confident read from a default.
   *
   * `source` says WHO decided (an explicit operator override always wins) and `basis`
   * carries the evidence sentences verbatim, so a wrong read is visible and correctable
   * rather than silently carried into the filing. Deliberately mirrors PermitPathResolution
   * rather than importing it: shared/ is the type surface both sides read, and backend-only
   * fields (needsEngineeredDocs, requiredEngineeredDocs) are derivable from `path`.
   */
  permitPath?: {
    path: "prescriptive" | "engineered" | "unknown";
    source: "operator" | "parser" | "structural-screen" | "default";
    basis: string[];
  };
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
  /** The canonical family this code governs (codeFamilies.codeFamilyOf decides when absent). */
  family?: CodeFamily;
  /** The model code + edition this state code is built on ("2021 IRC", "2024 IFC"). */
  basedOn?: string;
  /** ISO date this edition took effect. */
  effectiveDate?: string;
  /** ISO date from which ONLY this edition may be used (a phase-in, if any, ends the day before). */
  mandatoryDate?: string;
  /** The edition this one replaced — still allowed during a phase-in. */
  previousEdition?: string;
  /** A short quote from `sourceUrl` that states the edition (research / reference evidence). */
  quote?: string;
  /** WHO put this entry on the row. "research" (a web-grounded research save) and "reference"
   *  (the shipped, source-verified reference data) are machine-owned: a later grounded research
   *  replaces them family by family. "import" (an operator spreadsheet) and "operator" are kept
   *  by research saves. Absent = a legacy entry written before this field existed. */
  origin?: CodeEditionOrigin;
  /** READ-TIME ONLY (getCodeProfile): this AHJ inherits the entry from its state's row. */
  inheritedFrom?: "state";
}

/** The canonical code families a state's own code names map onto (ORSC -> residential,
 *  OSSC -> building, 780 CMR -> building …). codeFamilies.ts owns the mapping. */
export type CodeFamily = "residential" | "building" | "electrical" | "fire" | "energy" | "mechanical" | "plumbing";

/** How a state adopts a code family:
 *  - statewide_uniform: one edition everywhere; a city/county cannot adopt its own (OR, NY, NC).
 *  - statewide_minimum_local_amend: a state edition every AHJ enforces, with local amendments (WA, CA, FL).
 *  - local_adoption: each city/county adopts its own edition (TX residential, AZ, IL).
 *  - mixed: differs by family — see byFamily. */
export type CodeAdoptionModel = "statewide_uniform" | "statewide_minimum_local_amend" | "local_adoption" | "mixed";
export type CodeFamilyAdoptionModel = Exclude<CodeAdoptionModel, "mixed">;
export type CodeEditionOrigin = "research" | "reference" | "import" | "operator";

/** A state layer's adoption model (only on a state row, ahj ""). */
export interface JurisdictionAdoptionModel {
  model: CodeAdoptionModel;
  /** Per family where it differs from `model` (and every family when model is "mixed"). */
  byFamily?: Partial<Record<CodeFamily, CodeFamilyAdoptionModel>>;
  sourceUrl?: string;
  quote?: string;
  note?: string;
}

/** An edition a state has announced but that is not (yet) in effect. */
export interface UpcomingCodeEdition {
  family: CodeFamily;
  code: string;
  edition: string;
  basedOn?: string;
  /** ISO date the state expects it to take effect. */
  anticipatedDate?: string;
  /** "adopted" | "filed" | "in rulemaking" | "proposed" — free text as the source says it. */
  status?: string;
  sourceUrl?: string;
  quote?: string;
}

/** HOW A SEEDED PROFILE'S CODES WERE FOUND — stored in payload_json. "seeded" alone cannot tell an
 *  operator (or a re-research trigger) a web-grounded answer from model memory, and both are shared
 *  with every tenant. The grounding EVIDENCE rides along so a stored row can be audited. */
export interface CodeResearchProvenance {
  webGrounded: boolean;
  /** "reference_truth": the shipped reference data, each value confirmed on an official page. */
  method: "web_search" | "model_memory" | "reference_truth";
  notes?: string;
  /** ISO timestamp of the research (or the reference data's as-of date). */
  at?: string;
  /** web_search calls attempted / calls that returned results. */
  searches?: number;
  groundedSearches?: number;
  /** Result URLs the searches actually returned (bounded). */
  resultUrls?: string[];
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** A newer edition found for a HUMAN-VERIFIED row. Never written to the row (hard rule 3): it is
 *  recorded as a proposal and a person re-verifies.
 *  kind "adoption_model": a grounded state research DISAGREED with the state's known adoption model
 *  (on any row, seeded or verified). The stored model is kept — one research does not flip how a
 *  whole state adopts its codes — and a person decides; `changes[].current/proposed` are then
 *  per-family adoption models, `adoptionModel` the research's, and `proposedCodes` is empty. */
export interface JurisdictionEditionProposal {
  profileKey: string;
  state: string;
  ahj: string;
  /** Absent = "editions" (proposals recorded before the kind existed). */
  kind?: "editions" | "adoption_model";
  /** Stable hash of the proposed codes — one proposal per distinct finding. */
  fingerprint: string;
  source: "reference" | "research";
  createdAt: string;
  changes: Array<{ family: CodeFamily; current: string | null; proposed: string | null; sourceUrl?: string; quote?: string }>;
  /** The full adopted-code list a re-verification would record. */
  proposedCodes: CodeEdition[];
  adoptionModel?: JurisdictionAdoptionModel;
  upcoming?: UpcomingCodeEdition[];
}

export interface JurisdictionDesignCriteria {
  /** Strength-level ground snow load Pg — what every rule compares with a plan's Pg. */
  groundSnowLoadPsf?: number;
  /** The ground snow load as published in ALLOWABLE-STRESS form, pg(asd) (2024 IRC Table R301.2).
   *  A different quantity (~0.7 x Pg): kept in its own field so it is stored, not dropped, and never
   *  read as the strength Pg a below-ahj check compares against. */
  groundSnowLoadAsdPsf?: number;
  windSpeedMph?: number;
  windExposure?: string;
  /** The jurisdiction says it sits in a special wind region (IRC/ORSC Figure R301.2(2)
   *  shaded area): the mapped speed is not the answer — the local value is. */
  specialWindRegion?: boolean;
  seismicDesignCategory?: string;
  frostDepthIn?: number;
  sourceUrl?: string;
}

/** Profile fields an AHJ correction can teach. `block` says where it lands. */
export type JurisdictionCriterionKey =
  | "groundSnowLoadPsf"
  | "windSpeedMph"
  | "windExposure"
  | "specialWindRegion"
  | "maxAttachmentSpacingIn"
  | "listingEvidenceRequired";

/** A design requirement an AHJ STATED in a correction, proposed for that AHJ's code profile.
 *  Never applied without a human (POST /api/corrections/:id/apply); lands as "seeded" with a
 *  citation to the comment; never touches a verified row. */
export interface JurisdictionCriteriaProposal {
  kind: "jurisdiction_design_criteria";
  /** Stable selector for the apply route's `fields`: "jurisdiction:<criterion>". */
  id: string;
  ahj: string;
  state: string;
  /** The existing profile row the value would land on (codeProfiles.resolveCriteriaWriteRow): the
   *  exact key, or the SAME jurisdiction under another label ("Plano" for "City of Plano") — never
   *  another jurisdiction's row ("City of Lincoln City" never lands on "Lincoln County"). "" = no
   *  row yet; applying creates one under `targetProfileKey`. When the row reads use is verified the
   *  proposal is blocked_verified and this names that row. */
  profileKey: string;
  /** The key the value will be written under (set whether or not the row exists yet). */
  targetProfileKey?: string;
  /** A DIFFERENT existing row a fuzzy name match would have picked — shown, never written. */
  nearestOtherRow?: { key: string; ahj: string };
  block: "designCriteria" | "prescriptive";
  criterion: JurisdictionCriterionKey;
  value: number | string | boolean;
  /** What that row holds for the criterion now (null = blank). Shown as old -> new. */
  currentValue: number | string | boolean | null;
  currentConfidence: "seeded" | "verified" | null;
  /** The sentence the AHJ wrote (quoted, tight). */
  basis: string;
  source: { correctionId: string; recordNumber: string; receivedAt: string };
  /** proposed: a human may apply it. same_as_current: nothing to change. blocked_verified: the
   *  row is human-verified and will not be touched. applied / refused: after an apply. */
  status: "proposed" | "same_as_current" | "blocked_verified" | "applied" | "refused";
  statusNote?: string;
}

/** Where a correction was READ: the permit/NEM target the monitor checked. A monitor correction
 *  carries it from the check itself (never reverse-engineered from the page text); it decides
 *  which jurisdiction — if any — the correction's requirements are proposed for (hard rule 5). */
export interface CorrectionReadingOrigin {
  targetId: string;
  targetType: string;
  permitType: string;
  jurisdiction: string;
  recordNumber: string;
  /** The check's source. "email": the tracker ASSIGNS a target (newest active), so the target is
   *  a guess, not where the text was read — such a correction proposes nothing. */
  readingSource: string;
}

/** The design criteria an ISSUED project used — corroboration for the AHJ, never its rule. */
export interface ApprovedDesignObservation {
  projectId: string;
  recordNumber: string;
  issuedAt: string;
  criteria: Array<{ criterion: StatedDesignCriterionKind; value: number | string; qualifier: StatedDesignCriterionQualifier }>;
}

export interface DesignCriteriaResearchResult {
  provider: "claude" | "stub";
  /** Only values found on a page the search actually returned; each carries its citation. */
  values: Array<{
    criterion: "groundSnowLoadPsf" | "windSpeedMph" | "windExposure" | "seismicDesignCategory" | "frostDepthIn";
    value: number | string;
    sourceUrl: string;
    quote?: string;
    /** Ground snow only: "pg" (strength) or "pg_asd" (allowable-stress, stored as groundSnowLoadAsdPsf). */
    qualifier?: "pg" | "pg_asd";
    /** Set when the page is NOT a jurisdiction-wide design value (a project-type handout: a storage
     *  building, deck, fence…): why. The value is kept, seeded, and flagged for a person. */
    weakSource?: string;
  }>;
  webGrounded: boolean;
  /** The answer was cut off (max_tokens / pause_turn): a missing value is "not researched", not "not found". */
  truncated?: boolean;
  /** Criteria the jurisdiction publishes ONLY per site (an elevation-banded table, an address lookup
   *  tool): no one value to store, but a page a person reads for the site. Official pages only. */
  siteSpecific?: Array<{
    criterion: "groundSnowLoadPsf" | "windSpeedMph" | "windExposure" | "seismicDesignCategory" | "frostDepthIn";
    sourceUrl: string;
    note: string;
  }>;
  notes: string;
}

/** WHAT A DESIGN-CRITERIA LOOKUP IS ASKED TO ANSWER for an AHJ. Every item is recorded as found
 *  (with its citation), found on a weak source, not found, or not researched — never silently absent:
 *  QC and the reviewer compare plan sets against this profile, so a missing criterion is a silent pass. */
export type DesignCriteriaChecklistItem =
  | "groundSnowLoad"
  | "windSpeed"
  | "windExposure"
  | "seismicDesignCategory"
  | "frostDepth"
  | "fireSetbacks"
  | "localPvAmendments";

export interface DesignCriteriaLookupRecord {
  at: string;
  items: Array<{
    item: DesignCriteriaChecklistItem;
    /** not_found: a grounded, complete lookup found no citable value. not_researched: the lookup
     *  did not run, failed, or was cut off. weak_source: found, but on a page that is not a
     *  jurisdiction-wide design value. site_specific: the jurisdiction publishes it only per site
     *  (elevation bands, an address lookup) — sourceUrl is that table/tool. */
    status: "found" | "weak_source" | "not_found" | "not_researched" | "site_specific";
    sourceUrl?: string;
    note?: string;
  }>;
}

/** WHERE AN AHJ'S DESIGN-CRITERIA LOOKUP STANDS, read from the job queue (never written by the read).
 *  The reviewer's "criteria not on file" finding words itself from it: a lookup that is still running
 *  is not "not on file", and one that ran and found nothing is not "never looked".
 *  queued/running: a lookup (design-criteria or full code research) is pending or running.
 *  retrying: the last lookup was incomplete (failed, cut off, not web-grounded) and will be retried.
 *  incomplete: incomplete and out of retries for now. landed: a complete lookup ran (`items` is its
 *  checklist). */
export interface DesignCriteriaLookupProgress {
  status: "queued" | "running" | "retrying" | "incomplete" | "landed";
  /** When it was queued / started / finished. */
  at?: string;
  items?: DesignCriteriaLookupRecord["items"];
}

/** WHAT KIND OF STRUCTURE CARRIES THE ARRAY. One predicate answers it (structureType in
 *  codeReviewRules.ts); every rule reads that. "site_built" exists only as a STATED answer
 *  (the intake's structure-type field, or the parser's structureType): silence never proves a
 *  site-built house, so the absence of any signal is "unknown". */
export type StructureKind = "manufactured_home" | "site_built" | "unknown";

/** HOW the answer is known — the two confidence levels the rules act on.
 *  stated   — an explicit structure-type field: the operator's intake answer
 *             (structureTypeOverride, which always wins) or the parser's structureType.
 *             A stated manufactured home is a BLOCKER on the prescriptive path.
 *  inferred — only the package text suggests it ("HUD manufactured home" in a letter). A
 *             WARNING that asks for the structure type to be confirmed; text can be a
 *             disclaimer the reader misjudged, so it never blocks on its own.
 *  none     — no answer (kind "unknown"). */
export type StructureBasis = "stated" | "inferred" | "none";

export interface StructureTypeFact {
  kind: StructureKind;
  basis: StructureBasis;
  /** Where the answer came from: a structure-type FIELD, or the document text that said so. */
  source: string;
  /** The words that decided it, tight (no surrounding title-block text). "" when unknown. */
  excerpt: string;
}

/** Solar-pack prescriptive-path limits; future rule packs add their own blocks. */
export interface PrescriptiveLimits {
  maxGroundSnowPsf?: number;
  /** The jurisdiction's MINIMUM ground snow load Pg a design may use, by permit path — a floor
   *  under the site value, not the site value (Oregon, ORSC 2023 R301.2.3.1: site-specific Pg
   *  from the SEAO lookup, never less than 36 psf for prescriptive design or 25 psf for
   *  non-prescriptive / engineered design). Compared with the package's stated Pg — never
   *  Pg(asd), never roof snow. */
  minGroundSnowPsfPrescriptive?: number;
  minGroundSnowPsfEngineered?: number;
  /** Where the minimums come from ("ORSC 2023 R301.2.3.1"), quoted in the finding. */
  minGroundSnowCitation?: string;
  maxPvDeadLoadPsf?: number;
  maxRafterSpacingIn?: number;
  /** Maximum roof-attachment (mount/standoff) spacing the jurisdiction accepts, inches o.c. */
  maxAttachmentSpacingIn?: number;
  allowedWindExposures?: string[];
  maxExportKwWithoutStudy?: number;
  engineerStampOverKwDc?: number;
  maxWindSpeedMphExpB?: number;
  maxWindSpeedMphExpC?: number;
  /** DOES THIS JURISDICTION PUBLISH A PRESCRIPTIVE ROOFTOP-PV PATH AT ALL?
   *  Oregon does (ORSC / BCD 440-5952). Florida does not in the same shape — rooftop PV
   *  goes through product approval and the FBC, so "no published prescriptive path" is a
   *  real, useful answer rather than missing data, and it routes every project in that
   *  jurisdiction to standard/engineered review instead of leaving the path undecided
   *  forever. Undefined means nobody has established it yet. */
  hasPrescriptivePath?: boolean;
  /** The jurisdiction has ASKED for module / racking UL listing evidence (e.g. an AHJ correction
   *  "Provide UL listing for the panels, mounting and racking hardware"). Where set, a package
   *  that does not show the listings is a warning there, not just a callout. */
  listingEvidenceRequired?: boolean;
  /** Where the limits above were read from, for the reviewer's citation. */
  sourceUrl?: string;
}

export interface FireSetbackRule {
  id: string;
  description: string;
  codeReference?: CodeReference;
}

/** A design criterion a submittal package STATES (label-anchored), per source. */
export type StatedDesignCriterionKind =
  | "windSpeedMph"
  | "windExposure"
  | "groundSnowPsf"
  | "roofSnowPsf"
  | "riskCategory"
  | "asce7Edition";

/** What KIND of the quantity was stated. Wind: ultimate (Vult / strength) vs nominal
 *  (Vasd / ASD) — a Vult and a Vasd of one design are two different numbers of the same
 *  wind. Ground snow: Pg vs Pg(asd). Roof snow: flat pf vs sloped ps vs an unqualified
 *  "roof snow". "unspecified" = the label carried no qualifier. */
export type StatedDesignCriterionQualifier =
  | "ultimate"
  | "nominal"
  | "ground"
  | "ground_asd"
  | "roof"
  | "flat"
  | "sloped"
  | "unspecified";

export interface StatedDesignCriterion {
  criterion: StatedDesignCriterionKind;
  /** Numbers for mph/psf, a letter for exposure ("B"|"C"|"D"), roman/arabic for risk
   *  category ("II"), "7-22" style for the ASCE 7 edition. */
  value: number | string;
  qualifier: StatedDesignCriterionQualifier;
  /** Where it was stated ("Parsed project fields", "Structural calculation text", …). */
  source: string;
  /** True for parser-derived scalar fields — a reading of a document, not a document. */
  derived: boolean;
  /** Short text window around the label + value (never a whole title block). */
  excerpt: string;
}

/** One entry of a plan's GOVERNING CODES / code-basis block. */
export interface StatedCodeBasisEntry {
  /** Family token comparable to CodeEdition.code: "ORSC", "OESC", "NEC", "IRC", … */
  code: string;
  /** Edition year as printed. */
  edition: string;
  /** The printed name when the entry was spelled out ("OREGON ELECTRICAL SPECIALTY CODE"). */
  name?: string;
  /** Model code the state code is based on, when printed: "(NEC 2020)". */
  baseCode?: string;
  baseEdition?: string;
  source: string;
  excerpt: string;
}

export interface StatedDesignCriteria {
  /** True when some of the package's own text (a document, or the sheet text) was there to
   *  read. False means "could not be read from the package" — never "not stated". */
  documentTextRead: boolean;
  criteria: StatedDesignCriterion[];
  codeBasis: StatedCodeBasisEntry[];
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
  /** Official sources backing this profile (the human-verification checklist). An applied AHJ
   *  correction has no URL: it is cited by kind "ahj_correction", the field it set, the value and
   *  the date, under a generic label — never the AHJ's sentence, the correction id or the record
   *  number (this table is shared with every tenant; those stay in the org's review item and audit
   *  log). `quote` is only the design-criteria lookup's quote from a PUBLIC page. */
  citations: Array<{
    label: string;
    sourceUrl: string;
    kind?: "ahj_correction" | "design_criteria_research";
    field?: string;
    quote?: string;
    at?: string;
    /** The page is a project-type handout, not a jurisdiction-wide design value: why (verify it). */
    weakSource?: string;
  }>;
  /** The last design-criteria lookup's checklist: each item found / weak / not found / not researched. */
  designCriteriaLookup?: DesignCriteriaLookupRecord;
  researchedAt?: string;
  verifiedAt?: string;
  verifiedBy?: string;
  updatedAt: string;
  /** AGGREGATE of the approved designs issued there (listCodeProfiles only): values, counts and
   *  dates — never a project id or record number, because this list is shared across tenants. */
  approvedDesignSummary?: Array<{ criterion: StatedDesignCriterionKind; value: number | string; count: number; lastIssuedAt: string }>;
  /** A LAYERED read (getCodeProfile) merges an AHJ row over its state's row field by field and
   *  reports the WEAKER confidence overall. This says which row supplied each designCriteria /
   *  prescriptive field ("prescriptive.minGroundSnowPsfPrescriptive"), so a rule can say whose
   *  value it compared against and whether a person verified THAT row. Absent on a single row:
   *  the row's own confidence applies. Never persisted. */
  fieldSources?: Record<string, JurisdictionFieldSource>;
  /** State rows only: how the state adopts each code family (research or the reference data). */
  adoptionModel?: JurisdictionAdoptionModel;
  /** State rows only: announced editions not yet in effect. */
  upcoming?: UpcomingCodeEdition[];
  /** How the row's codes were found (absent: an import / legacy row that does not say). */
  researchProvenance?: CodeResearchProvenance;
  /** listCodeProfiles only, verified rows only: newer editions found that await a person. */
  editionProposals?: JurisdictionEditionProposal[];
}

export interface JurisdictionFieldSource {
  /** "" for the state-level row. */
  ahj: string;
  state: string;
  confidence: "seeded" | "verified";
  verifiedBy?: string;
  verifiedAt?: string;
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
export interface JurisdictionCodeResearchInput {
  ahj: string;
  state: string;
  /** AHJ layer only: the families the state leaves to local adoption — the only editions worth
   *  researching at this level. Absent = every family (a state layer, or an unknown state model). */
  families?: CodeFamily[];
  /** ISO date the research is "as of" (defaults to today) — which editions are in effect ON it. */
  asOf?: string;
}

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

/**
 * A correction pattern rolled up onto a SHARED knowledge row (every tenant reads it).
 * Deliberately carries no raw sample text: a correction excerpt can name a homeowner or
 * a co-customer, and the raw excerpt lives only in the org-scoped
 * historical_failure_examples table.
 */
export interface CommonCorrectionPattern {
  signature: string;
  bucket: CorrectionBucket;
  rootCause: string;
  requiredAction: string;
  count: number;
  lastSeenAt: string;
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
  /** A provenance LABEL only — never a lock. "mixed" was historically written both by a
   *  human verification and by an automatic seeded+learned merge; whether a person checked
   *  the row is `verifiedAt`, read through isVerifiedKnowledge(). */
  confidence: "seeded" | "learned" | "mixed";
  /** When a person first verified this row (verified save or operator ruling); null =
   *  nobody has. The ONE signal hard rule 3 locks on. */
  verifiedAt: string | null;
  /** Who verified it (user id, or the ruling / backfill provenance); "" when unverified. */
  verifiedBy: string;
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
  /** A BLOCKER's items and the filings each one holds (backend/src/gateScope.ts — the one answer
   *  the gate, Stage, Approve and prepareSubmission read). Absent = the blocker holds every filing
   *  (an unknown never clears). */
  holds?: SubmitGateHold[];
}

/** One blocking item of a gate check and the tracks whose filing it holds. */
export interface SubmitGateHold {
  label: string;
  tracks: SubmittalTrackType[];
  /** What to do about it, when it differs from the check's nextAction (the document check's
   *  "Find official form or upload the blank" vs "attach"). */
  action?: string;
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
  /** `structural_letter` carries the sealed-source rule: when a letter and the plan set
   *  disagree on a structural value, the letter governs — so its provenance must survive
   *  (it used to be coerced to plan_set on receipt). */
  source: "plan_set" | "utility_bill" | "meter_photo" | "structural_letter";
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
  /** Which documents this pass was GIVEN (from the request, not the model). The parser
   *  page attributes notes by pass and refuses a pass's claim that a document it was
   *  never handed was "not supplied". Absent on older backends. */
  documentsSeen?: Array<ParserFieldEvidence["source"]>;
  /** Cross-document disagreements the model found, one per field with every reading, so
   *  the page can resolve by rule (sealed letter over plan set; bill account holder over
   *  title block) or show a CONFLICT naming each reading. Absent on older backends. */
  conflicts?: ParserExtractionConflict[];
  /** WHY each lowConfidenceFields entry is uncertain. `unconfirmed` = printed once and not
   *  corroborated — the page treats that as STATED; the other kinds stay unsure. */
  uncertainties?: ParserExtractionUncertainty[];
  /** Deterministic server-side resolutions (no model): e.g. moduleMake from the CEC list. */
  resolutions?: ParserExtractionResolution[];
  /** Set when the plan set had no text layer and was read by VISION from page images: the
   *  field ids that came from vision, and which pages were read (scannedPlanSet.ts). */
  visionFields?: string[];
  visionPages?: number[];
  /** "vision" = the whole set was a scan; "hybrid" = a text set whose image-only pages (spec
   *  sheets pasted in as pictures) were read by vision and merged under the text read. */
  planReadMode?: "vision" | "hybrid";
  /** What each vision page was taken to be (the page index read, or the position rule). */
  visionPageRoles?: Array<{ page: number; kind: PlanSheetKind; sheet?: string; title?: string; rotate?: number }>;
  /** Pages that were candidates but NOT read, and why (cap, byte budget, render failure). */
  visionSkipped?: Array<{ page: number; reason: string }>;
}

/** What a plan-set page is, as the page-index read names it (scannedPlanSet.ts chooses the
 *  vision pages from these). */
export type PlanSheetKind =
  | "cover" | "site_plan" | "roof_plan" | "attachment" | "structural" | "one_line" | "calcs" | "labels"
  | "module_spec" | "inverter_spec" | "battery_spec" | "racking_spec" | "other_spec" | "certificate"
  | "notes" | "other" | "blank";

export interface PlanPageClass {
  page: number;
  /** Sheet number as printed (e.g. "PV-2"), when legible. */
  sheet?: string;
  /** Sheet title as printed, when legible. */
  title?: string;
  kind: PlanSheetKind;
  /** Clockwise degrees that turn the sheet's drawing upright (set by the orientation read). */
  rotate: 0 | 90 | 180 | 270;
}

/** The page-index read of a plan set: one entry per page image it was shown. */
export interface PlanPageIndex {
  pages: PlanPageClass[];
  /** The set's own sheet index (cover sheet table), when one was legible. */
  sheetIndex?: Array<{ sheet: string; title: string }>;
}

export interface ParserExtractionConflict {
  field: string;
  readings: Array<{ value: string | number; source: ParserFieldEvidence["source"]; sheet?: string; excerpt?: string }>;
  note?: string;
}

export interface ParserExtractionUncertainty {
  field: string;
  kind: "unreadable" | "guessed" | "inferred" | "conflicting" | "unconfirmed";
  reason: string;
}

export interface ParserExtractionResolution {
  field: string;
  value: string | number;
  how: string;
}

// ===========================================================================
// PLAN-SET INSTALLER IDENTITY -> CLIENT RESOLUTION
//
// The plan set's title block names the company that designed/installs the job.
// The parser prompt has always read it (llm.ts "CLIENT ONBOARDING" block) and
// always thrown it away. These types carry it onto the parse response so the
// client picker can pre-select the company instead of asking a human to.
//
// MEASURED ON THE REAL CORPUS (operator drive, 10 plan sets + all 23 pages of
// Bren Trask's set): the title block prints the COMPANY NAME, ADDRESS, PHONE
// and website — and NO CCB number at all. So the CCB leg (the only one allowed
// to bind without a human) is correct but usually silent, and the phone is the
// only exact identifier these plan sets actually carry. That is why phone is an
// exact-match leg that PRE-SELECTS and never auto-assigns: a licence number
// identifies a contractor in a state registry, a phone number does not.
// ===========================================================================

/** The installer/contractor identity as read off the plan set — never the homeowner. */
export interface PlanSetInstallerIdentity {
  companyName?: string;
  /** Oregon CCB (or equivalent state contractor registry) number, as printed. */
  ccbLicenseNumber?: string;
  /** The COMPANY's electrical contractor licence — never compared against a CCB field. */
  electricalLicenseNumber?: string;
  /** Metro/city business licence — never compared against a CCB field. */
  metroCityLicenseNumber?: string;
  address?: string;
  phone?: string;
  email?: string;
  supervisorName?: string;
  /** The supervising electrician's PERSONAL licence — never a company identifier. */
  electricianLicenseNumber?: string;
  /** False when a text layer was supplied and the company name is NOT in it (a logo-only name):
   *  the name can then only propose candidates, never pre-select. */
  companyNameInText?: boolean;
  /** Printed numbers that LOOK like licences but are not (an EIN-shaped NN-NNNNNNN), kept so the
   *  explanation can say why they were not used. */
  rejectedLicenceNumbers?: string[];
}

/** Which leg of the match fired. Only an exact licence (`ccb`, `state_license`) may bind a
 *  client without a human. */
export type ClientMatchKind = "ccb" | "state_license" | "phone" | "name";

/** One reason a client was proposed — what matched, on which field, how well. */
export interface ClientMatchEvidence {
  kind: ClientMatchKind;
  /** The clients-table column compared (named so a reviewer can check the claim). */
  clientField: "ccb_license_number" | "electrical_license_number" | "state_licenses" | "business_phone" | "phone" | "company_name" | "legal_business_name" | "dba";
  /** The value read off the plan set. */
  planSetValue: string;
  /** The value stored on the client row. */
  clientValue: string;
  /** 0-100. 100 = exact identifier match. */
  score: number;
}

export interface ClientMatchCandidate {
  clientId: string;
  companyName: string;
  /** Best score across this candidate's evidence. */
  score: number;
  /** Strong enough to stand alone (exact CCB, exact phone, or a strong name hit). */
  strong: boolean;
  evidence: ClientMatchEvidence[];
  /** One readable sentence naming exactly what matched. Rendered to the operator. */
  reason: string;
}

/**
 * `auto_assign` — exact CCB on exactly one client. Binds without a prompt.
 * `preselect`   — one strong non-licence signal. Fills the picker, HUMAN MUST CONFIRM.
 * `candidates`  — weak, or more than one plausible company. Shows them, assigns NOTHING.
 * `none`        — nothing matched (or the plan set named no installer). Offer onboarding.
 */
export type ClientMatchDecision = "auto_assign" | "preselect" | "candidates" | "none";

export interface ClientResolution {
  decision: ClientMatchDecision;
  /** Set ONLY for auto_assign and preselect. Always null for candidates/none. */
  clientId: string | null;
  /**
   * False ONLY for auto_assign. The picker may not bind a preselected client
   * until a human says so — auto-assigning on a guess files the job under the
   * wrong contractor's LICENCE, which is worse than asking.
   */
  requiresConfirmation: boolean;
  /** Every client with any signal, best first. Empty when nothing matched. */
  candidates: ClientMatchCandidate[];
  /** What the plan set said, echoed so the onboarding form can prefill from it. */
  installer: PlanSetInstallerIdentity;
  /** One sentence explaining the decision. Plain text — escape before innerHTML. */
  explanation: string;
}

/**
 * The `/api/parser/llm-extract` response. The extraction is unchanged; the
 * resolution rides along so the parser page can fill its (still required)
 * client picker instead of asking the coordinator to pick blind.
 */
export interface ParserExtractionResponse extends ParserLlmExtraction {
  clientResolution?: ClientResolution;
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
    /** A SCANNED plan set (no text layer): its key sheets as page images (backend scannedPlanSet.ts).
     *  `label` names what the page was taken to be ("site plan, PV-2, rotated 90° upright"). */
    planPageImages?: Array<{ page: number; base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp"; label?: string }>;
    /** "scan" (default) = the images ARE the plan set; "hybrid" = the set's text layer was read
     *  separately and these are its image-only pages. */
    planImageMode?: "scan" | "hybrid";
  }): Promise<ParserLlmExtraction>;
  /** PAGE INDEX of a plan set from small page images: what each page is, its sheet number and
   *  title, and how to turn it upright (scannedPlanSet.ts chooses the vision pages from it).
   *  Optional so test doubles need not implement it — without it the position rule applies. */
  classifyPlanPages?(input: {
    pageImages: Array<{ page: number; base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }>;
  }): Promise<PlanPageIndex>;
  /** ORIENTATION of scanned pages by COMPARISON: each page is shown turned 0/90/180/270 degrees
   *  and the reader names the version that reads upright (asking for an angle directly was wrong
   *  on a real scan: "180" for sheets that were 90 degrees sideways). Optional like the index. */
  orientPlanPages?(input: {
    pages: Array<{ page: number; versions: Array<{ rotate: 0 | 90 | 180 | 270; base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }> }>;
  }): Promise<Array<{ page: number; rotate: number }>>;
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
  researchJurisdictionCodes(input: JurisdictionCodeResearchInput): Promise<JurisdictionCodeResearchResult>;
  /** NARROW design-criteria lookup (ground snow, ultimate wind, exposure) for ONE AHJ whose
   *  profile has none on file. Web-grounded values only, each with its citation. Optional so
   *  test doubles of LLMProvider need not implement it. */
  researchDesignCriteria?(input: { ahj: string; state: string }): Promise<DesignCriteriaResearchResult>;
  /** ONE web-grounded lookup with a caller-owned prompt (the per-job permit-process lookup,
   *  backend/src/permitProcessLookup.ts). Transport only: the caller parses and validates. */
  webLookup?(input: { label: string; system: string; user: string; maxTokens?: number; maxSearches?: number; readPages?: boolean; maxFetches?: number; timeoutMs?: number }): Promise<WebLookupResult>;
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
    /** Each field with where it is and the printed caption(s) around it — the blank's own text,
     *  never a field value or project data (hard rule 2). */
    fields: AcroFieldForMapping[];
    /** Which side of its boxes this form prints captions on, when the widget names agree on one. */
    captionSide?: "below" | "above" | "left" | "right" | null;
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
  /** Printed blanks no source can fill (the model's "operator:<caption>" entries), by label. */
  operatorItems?: Array<{ field?: string; label: string }>;
}

/** One AcroForm field as the mapper sees it. */
export interface AcroFieldForMapping {
  name: string;
  type: string;
  /** 0-based page. */
  page?: number;
  /** THE printed caption of the box (the form's calibrated caption side), when it could be told. */
  caption?: string;
  /** The nearest printed text on each side of the box. */
  captions?: { left?: string; right?: string; below?: string; above?: string };
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
  /** The raw web-search results the call received (URL + the result's title), kept so the
   *  acquisition can take a document link the model saw but did not list (a CivicPlus
   *  /DocumentCenter/View/<id>/<name> link has no ".pdf"). Data, never an instruction. */
  searchResults?: Array<{ url: string; title: string }>;
}

export interface AhjFieldMapResult {
  provider: "claude" | "stub";
  /** AcroForm text field name -> value source (e.g. "project.homeownerName"). */
  textFields: Record<string, string>;
  /** AcroForm checkbox field name -> check rule. */
  checkboxes: Record<string, { source: string; equals?: string }>;
  notes: string;
  /** Blanks the applicant must fill that no source answers (the model's "operator:<caption>"
   *  entries), by printed label — listed for the operator on every fill, never silently blank. */
  operatorItems?: Array<{ field?: string; label: string }>;
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
  /** True when a web search actually ran and grounded this answer; false when it fell back to
   *  model memory. Absent on results built by hand (older callers) — provenance unknown, which
   *  must never read as web-grounded. */
  webGrounded?: boolean;
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
  /** Same meaning as AhjResearchResult.webGrounded: true = web search ran, false = model
   *  memory, absent = unknown (never to be read as web-grounded). */
  webGrounded?: boolean;
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
  /** A SPLIT e-signature box (portalSafety signatureNamePartOf: "First name" / "Last name" under a
   *  signing statement): the step types that part of the client's authorized signer
   *  (splitSignerName), never the whole name, never a contact's. Only on signature steps. */
  signerNamePart?: "first" | "last";
  /** Set when this step's recorded answer was withheld from the shared recipe and the step replays
   *  BLANK for a person to answer — why, in words (e.g. a company-identity literal the save guard
   *  refused to persist). Metadata only: never part of the step's label or matching. */
  operatorItem?: string;
  /** companyFacts.companyFactStamp of the client whose job recorded this company ATTESTATION (a
   *  check/select answering a fact about the installer company). Replayed only for that client's
   *  jobs; on any other job (or when absent) the step is left for a person. Opaque, never the id. */
  companyFactOf?: string;
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

// ── PER-JOB PERMIT PROCESS (operator steer 2026-09-25: "It needs to look up the right stuff per job") ──
// One record per AHJ answering: who issues the permits, how the work is permitted (one combo
// permit or separate structural + electrical), which portal and record type each permit files
// under, which documents each permit needs, and what each costs. Every answer carries its
// source and the words it rests on, or says it was NOT FOUND — never a guess. Lands 'seeded'
// (shared knowledge, like permit_utility_knowledge); a person's 'verified' row is never
// auto-overwritten (hard rule 3).
export type PermitProcessOrigin = "lookup" | "state_rule" | "operator" | "kb";
export interface CitedFact<T> {
  /** null = not found. */
  value: T | null;
  sourceUrl: string;
  /** The exact words on the source that state the answer. */
  quote: string;
  origin: PermitProcessOrigin;
  /** When value is null: what was searched and why no answer was accepted. */
  notFound?: string;
  /** A PORTAL a source NAMED but the lookup's door did not keep (value null): the URL as claimed.
   *  "Named, not kept" is still evidence of where the AHJ files — the statewide fallback is never
   *  taken over it (permitProcess.statewidePortalFor). Older rows carry it only in notFound's words. */
  claimed?: string;
  /** A named portal that REDIRECTS to its official host (lookup D3): kept as the final URL, with the
   *  URL the source named and the hops our one polite read saw. */
  redirect?: { from: string; finalUrl: string; chain: string[]; status: number };
}
export type PermitProcessDiscipline = "structural" | "electrical" | "combo" | "other";
export interface PermitFeeAnswer {
  /** The authority's total for this permit on this job, when the schedule prices it. */
  amountUsd: number | null;
  /** "flat" (prescriptive flat fee), "tiered" (kVA tier), "valuation", … in words. */
  basis: string;
  lines: Array<{ label: string; amountUsd: number }>;
}
export interface PermitProcessPermitAnswer {
  discipline: PermitProcessDiscipline;
  /** The permit as the AHJ names it ("Residential Structural"). */
  label: string;
  issuingAgency: CitedFact<string>;
  portalUrl: CitedFact<string>;
  recordType: CitedFact<string>;
  documents: CitedFact<string[]>;
  fee: CitedFact<PermitFeeAnswer>;
  /** Every solar record type the PORTAL'S OWN catalog lists for this permit, with the condition
   *  that selects each (SolarAPP+ vs standard, prescriptive vs engineered). When the plan path
   *  cannot pick one, recordType stays null and the operator is asked. */
  recordTypeCandidates?: Array<{ label: string; condition: string; sourceUrl: string; quote: string }>;
  /** The portal's platform as its own page shows it ("accela" / "energov" / "other"). */
  portalPlatform?: string;
}
export interface PermitProcessLookup {
  profileKey: string;
  state: string;
  ahj: string;
  confidence: "seeded" | "verified";
  /** The agency that issues this AHJ's residential solar permits (a county can issue for a city). */
  issuingAgency: CitedFact<string>;
  permitStructure: CitedFact<"separate" | "combo">;
  permits: PermitProcessPermitAnswer[];
  /** Steps at ANOTHER office before or beside filing ("submit to City Hall first", a zoning
   *  sign-off), each cited. Never the issuing agency. */
  prerequisites?: CitedFact<string>[];
  /** Adopted codes the lookup found (display only; the gate reads jurisdiction_code_profiles). */
  codes?: CitedFact<string[]>;
  /** Pages the lookup READ ITSELF (agency pages, the portal's public catalog, fee schedules), each
   *  with what came of the read — the audit trail for every value cited to one of them. */
  pagesRead?: Array<{ url: string; ok: boolean; reason: string }>;
  lookedUpAt: string;
  model?: string;
  costUsd?: number;
  notes?: string[];
  verifiedAt?: string | null;
  verifiedBy?: string | null;
}

/** What LLMProvider.webLookup returns: the model's text and the search evidence around it. */
export interface WebLookupResult {
  text: string;
  /** Searches that returned results (0 = the answer is model memory and must not be used). */
  groundedSearches: number;
  /** "max_tokens" / "pause_turn" = the answer was cut off. */
  stopReason: string | null;
  resultUrls: string[];
  pagesRead: number;
  /** Searches the model ran (with or without results) — for the cost line. */
  searches?: number;
  /** Pages the fetch tool returned (readPages): a lookup may cite a page it OPENED. */
  fetchedUrls?: string[];
  /** The title each search result carried, by URL. */
  resultTitles?: Record<string, string>;
  error?: string;
  /** The call hit its own time budget; text/URLs are what the search had gathered by then. */
  timedOut?: boolean;
}
