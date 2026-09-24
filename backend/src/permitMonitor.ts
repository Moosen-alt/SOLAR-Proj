import type { AppDb } from "./db";
import type { PermitCheckOutcome, PermitCheckSource, ReadingFreshness } from "../../shared/src/types";
import { logger } from "./logger";

export interface PermitStatusClassification {
  outcome: PermitCheckOutcome;
  statusLabel: string;
  confidence: number;
  reviewedByAhj: boolean;
  readyForIssue: boolean;
  issueFeeDue: boolean;
  message: string;
}

// "ADDL INFO NEEDED" IS A REVIEWER'S CORRECTION REQUEST. Oregon ePermitting (Accela) abbreviates
// it, and the record status reads "In Review/Addl Info Needed" — which matched waitingPattern's
// "in review" and was reported as "In review" at 0.72 while Coos Bay's building reviewer sat on
// 187-26-000309-STR asking for a 36 psf snow load, 2' o.c. attachments and UL listings. Lincoln
// City's 521-26-000356-STR went through the same status twice. The reviewer's comment itself lives
// in the AJAX-loaded Processing Status panel a plain fetch never sees, so the STATUS is the only
// signal we get — it has to be read as the correction it is.
const correctionPattern =
  /\b(correction|corrections|deficien(?:cy|cies)|rejected|returned|revision required|resubmit|resubmittal|required revisions|additional information|add(?:'?l|itional)\.?\s+info(?:rmation)?\.?\s+(?:needed|required|requested)|info(?:rmation)?\s+requested|incomplete|review comments|not approved|denied|failed review|revise and resubmit)\b/i;

// A BARE STATED STATUS. Accela states "Record Status: Issued" or "Record Status: Finaled" with no
// other words, and issuedPattern wants a phrase ("permit issued", "status: issued") — the stated
// status is extracted WITHOUT its "Status:" label, so both read "Needs human review". Only the
// stated field is tested: a bare "issued" or "final" in page prose ("permits issued by the city",
// "final fees") says nothing about this record.
const statedIssuedPattern = /^(?:issued|finaled|permit finaled|closed\s*-\s*finaled?)$/i;

const readyForIssuePattern =
  /\b(ready for issue|ready to issue|ready for issuance|permit ready|ready for pickup|ready for pick up|approved pending payment|pay fees?|fees? due|issuance fees?|final fees?|ready to be issued)\b/i;

const issuedPattern =
  /\b(permit issued|issued permit|status:\s*issued|issued on|download permit|permit card|inspection card|permit has been issued)\b/i;

const nemApprovalPattern =
  /\b(pto granted|permission to operate|net metering approved|customer generation approved|(?:interconnection|nem)(?:\s+\w+){0,3}\s+approved|approved(?:\s+\w+){0,3}\s+(?:interconnection|nem)|authorization to (?:install|interconnect|operate))\b/i;

const reviewedPattern =
  /\b(review complete|plan review complete|approved|approved with conditions|reviewed by ahj|reviewed and approved|passed review|application approved)\b/i;

// NAMED REVIEW STAGES ARE STILL "THE AGENCY IS REVIEWING IT". Portals rarely print the
// tidy phrase "under review" — they print the name of the desk the file is sitting on.
// PowerClerk says "Engineering Review", AHJs say "Plan Review" / "Plans Examiner" /
// "Structural Review" / "Electrical Review". Measured 2026-09-22: of ten open "permit
// monitor status review" items — the single largest category of human interruption in the
// product — one was the perfectly legible "PP - Engineering Review as of 9/2/2026
// (APP-111651)", escalated to a person because this list did not contain the words.
// Every one of these means the same operational thing as "under review": nobody does
// anything, the next poll is the whole job.
const waitingPattern =
  /\b(under review|in review|review in progress|submitted|received|intake|pending review|processing|assigned to reviewer|awaiting review|queued|engineering review|plan(?:s)? review|plans? examiner|structural review|electrical review|technical review|application received|in progress|being reviewed|routed for review)\b/i;

// THE AGENCY IS WAITING ON US. Checked BEFORE waitingPattern, because these wordings contain
// the very words that pattern matches — Coos Bay's real status is "Intake Requirements Needed",
// which hit `intake` and was reported as "In review" at 0.72 while the permit sat stalled.
// Nobody chases a permit that says the city is reviewing it.
const actionNeededPattern =
  /\b(intake\s+requirements?\s+needed|requirements?\s+needed|additional\s+(?:information|documents?)\s+(?:required|needed)|pending\s+applicant|awaiting\s+applicant|resubmittal\s+required|application\s+incomplete|incomplete\b[^.;\n]{0,32}\brequired|on\s+hold)\b/i;

// A RECORD- OR PARCEL-LEVEL CONDITION stops a permit dead and has nothing to do with our
// documents. 1780 Ocean carries one from 2019 — "Outstanding permit 187-M16-213 expired prior to
// final" — which sat in text we captured and stored, and which nothing ever read.
const conditionPattern =
  /\b(condition:\s*[a-z]|total\s+conditions:\s*[1-9]|parcel\s+notifications?|permit\s+outstanding|outstanding\s+permit|stop\s+work|lien\b)/i;

/**
 * The condition text as the portal printed it, so the operator sees the actual notice.
 *
 * THE SPECIFIC SENTENCE WINS. Accela prints a generic header ("Condition: PERMIT OUTSTANDING
 * Severity: Notice Total Conditions: 1 ...") ahead of the sentence that actually says what is
 * wrong ("Outstanding permit 187-M16-213 expired prior to final."). Taking the first match and
 * truncating produced a banner with no facts in it — the permit number, which is the one thing an
 * operator can act on, fell off the end.
 */
export function extractPortalCondition(text: string): string {
  const blob = String(text || "").replace(/\s+/g, " ");
  // NO LEADING WORD BOUNDARY: Accela renders this page with words glued together where markup was
  // stripped — the real record reads "PERMIT OUTSTANDINGOutstanding permit 187-M16-213", so \b
  // before "outstanding permit" never matches and the useless generic header wins instead.
  const specific = /(outstanding permit[^.|]{0,140}|stop work order[^.|]{0,140}|lien[^.|]{0,140})/i.exec(blob);
  if (specific) return specific[0].trim().slice(0, 180);
  // THE CONDITION'S NAME ENDS WHERE ACCELA'S NEXT FIELD BEGINS. The same glued markup puts the
  // severity straight after the name — "Condition: FloodplainSeverity: NoticeTotal Conditions: 1"
  // (and on production "Condition: Sewer RecoverySeverity: Notice...") — so reading to the next
  // "|" produced "FloodplainSeverity: NoticeTotal Conditions: 1 (Notice: 1)View Condition".
  // THE WINDOW FIRST, THEN THE CUT. The name is read up to 140 characters (or the next "|"), then
  // cut at the next field if one falls inside the window. A lookahead that had to find its marker
  // within 140 characters matched nothing on a written-out condition with no marker in reach, so
  // the page carried a condition and the reading showed none.
  const header = /condition:\s*([^|]{1,140})/i.exec(blob);
  const name = header ? header[1].split(/severity\s*:|total\s+conditions|view\s+condition/i)[0].trim() : "";
  return name ? `Condition: ${name}`.slice(0, 180) : "";
}

/** The record-level condition on this page, or "" — read from the WHOLE page (a condition lives
 *  outside the stated-status line), and only where the page carries condition wording. */
export function recordConditionOf(rawStatusText: string): string {
  return conditionPattern.test(rawStatusText) ? extractPortalCondition(rawStatusText) : "";
}



function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// A PORTAL THAT STATES THE STATUS OUTRIGHT HAS ALREADY ANSWERED THE QUESTION.
//
// The patterns below scan whatever text the fetcher scraped, which on a record page is the
// whole page — headings, help text and all. Accela prints an "Additional Information" section
// on every record, and correctionPattern matches that phrase, so a permit that had just been
// filed ("Record Status: App Submitted") classified as correction_flagged at 0.9: a false
// alarm to the client, a review item that then BLOCKS staging of the project's other tracks,
// and it would have happened on every Accela filing we ever made. Measured live on
// 187-26-000305-STR.
//
// So when the page states the status in a labelled field, classify on THAT and let the
// page-wide scan stay the fallback for portals that only render prose.
const STATUS_LINE = /\b(?:record|permit|application)\s+status\s*:?\s*([A-Za-z][A-Za-z /&-]{2,40}?)\s*(?:expiration|expires|date|record|permit|application|$)/i;

export function extractStatedStatus(rawStatusText: string): string {
  const m = clean(rawStatusText).match(STATUS_LINE);
  return m ? m[1].trim().replace(/\s+/g, " ") : "";
}

// A LOGIN PAGE IS NOT A STATUS. A status check whose session has lapsed lands on the
// portal's sign-in screen, and that page's text scrapes like any other: the monitor recorded
// "PowerClerk Log In Username: Password: ..." as the status of three live interconnection
// applications and classified all three as needs_human_review, overwriting statuses that had
// been verified minutes earlier. The scrape succeeded; it just wasn't looking at the record.
// Portal-agnostic — every vendor's login page carries these same words.
export function isAuthWallText(rawStatusText: string): boolean {
  const t = String(rawStatusText || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!t || t.length > 1200) return false; // a real record page is longer and richer
  const saysLogin = /\b(log ?in|sign ?in|logon)\b/.test(t);
  const asksCredentials = /\busername\b|\bpassword\b|\bemail address\b.*\bpassword\b/.test(t);
  const offersRecovery = /forgot password|register a new account|reset your password|create an account/.test(t);
  // Two independent signals, so a record page that merely says "Log In" in a nav bar and
  // happens to be short is never mistaken for the wall itself.
  return [saysLogin, asksCredentials, offersRecovery].filter(Boolean).length >= 2;
}

// A RECORD CONDITION RIDES ON EVERY READING. It was appended only when the status said the
// agency was waiting on the applicant, so the same "Condition: Floodplain" notice was silent on
// a record reading "Addl Info Needed" (correction_flagged) or "In Review" (waiting) — and a
// floodplain condition stops a permit whatever its review status says. The classification
// (outcome / label / confidence) is unchanged; only the message carries it.
export function classifyPermitStatusText(rawStatusText: string): PermitStatusClassification {
  const result = classifyStatusOnly(rawStatusText);
  const condition = recordConditionOf(rawStatusText);
  return condition
    ? { ...result, message: `${result.message} The record also carries a condition: "${condition}".` }
    : result;
}

function classifyStatusOnly(rawStatusText: string): PermitStatusClassification {
  const stated = extractStatedStatus(rawStatusText);
  // Keep the full text when the portal states nothing — that is the old behaviour, and the
  // only behaviour available for portals that render status as prose.
  const text = stated || clean(rawStatusText);
  const lower = text.toLowerCase();

  if (!text) {
    return {
      outcome: "needs_human_review",
      statusLabel: "No status text",
      confidence: 0.2,
      reviewedByAhj: false,
      readyForIssue: false,
      issueFeeDue: false,
      message: "No AHJ/portal status text was provided. Manual check is required.",
    };
  }

  if (issuedPattern.test(text) || statedIssuedPattern.test(stated)) {
    return {
      outcome: "issued",
      statusLabel: "Permit issued",
      confidence: 0.95,
      reviewedByAhj: true,
      readyForIssue: true,
      issueFeeDue: false,
      message: "Permit appears to be issued. Download/record permit documents and move to inspections/PTO path.",
    };
  }

  if (correctionPattern.test(text)) {
    return {
      outcome: "correction_flagged",
      statusLabel: "Correction flagged",
      confidence: 0.9,
      reviewedByAhj: true,
      readyForIssue: false,
      issueFeeDue: false,
      message: "AHJ/utility correction language detected. Correction was bucketed and queued for human follow-up.",
    };
  }

  if (nemApprovalPattern.test(text)) {
    return {
      outcome: "nem_approved",
      statusLabel: "NEM / interconnection approved",
      confidence: 0.94,
      reviewedByAhj: true,
      readyForIssue: false,
      issueFeeDue: false,
      message: "Utility NEM / interconnection approval detected. Your submission scope is complete — hand off to installer for final inspection scheduling.",
    };
  }

  if (readyForIssuePattern.test(text)) {
    return {
      outcome: "ready_for_issue",
      statusLabel: lower.includes("fee") || lower.includes("payment") ? "Ready for issue - fee/payment needed" : "Ready for issue",
      confidence: 0.9,
      reviewedByAhj: true,
      readyForIssue: true,
      issueFeeDue: /\b(fee|fees|payment|pay)\b/i.test(text),
      message: "AHJ review appears complete and the permit is ready for issue. Human should pay fees/download permit as required.",
    };
  }

  if (reviewedPattern.test(text)) {
    return {
      outcome: "reviewed_by_ahj",
      statusLabel: "Reviewed by AHJ",
      confidence: 0.82,
      reviewedByAhj: true,
      readyForIssue: false,
      issueFeeDue: false,
      message: "AHJ review appears complete or approved, but ready-for-issue wording was not found.",
    };
  }

  // Checked ahead of waitingPattern on purpose — see the comment on actionNeededPattern.
  if (actionNeededPattern.test(text)) {
    // The record's condition is appended by classifyPermitStatusText, read AGAINST THE FULL PAGE,
    // not `text`: extractStatedStatus narrows `text` to the stated status ("Intake Requirements
    // Needed") and the condition lives elsewhere on the record — testing the narrowed string found
    // nothing, and the first version of the test passed anyway because it matched the word
    // "outstanding" in this very message rather than the portal's notice.
    return {
      outcome: "needs_human_review",
      statusLabel: "Action needed before review",
      confidence: 0.8,
      reviewedByAhj: false,
      readyForIssue: false,
      issueFeeDue: false,
      message:
        "The agency is waiting on the APPLICANT, not reviewing — the record says requirements are "
        + "outstanding at intake. Nothing moves until they are supplied.",
    };
  }


  if (waitingPattern.test(text)) {
    return {
      outcome: "waiting",
      statusLabel: "In review",
      confidence: 0.72,
      reviewedByAhj: false,
      readyForIssue: false,
      issueFeeDue: false,
      message: "Permit appears to still be in AHJ/utility review.",
    };
  }

  return {
    outcome: "needs_human_review",
    statusLabel: "Needs human review",
    confidence: 0.45,
    reviewedByAhj: false,
    readyForIssue: false,
    issueFeeDue: false,
    message: "Status text did not match a known monitor rule. Human review is required.",
  };
}

// ---------------------------------------------------------------------------
// A HISTORY OF CHANGES, NOT A LOG OF LOOKUPS.
//
// permit_status_checks was written unconditionally on every poll, so a permit that sat in "In
// review" for three weeks produced a row per sweep. The client's "Recent updates" list reads
// those rows, so it showed twelve identical lines — six pairs seconds apart, because a sweep
// walks the project's STR target and then its ELEC target — and the client concluded nothing was
// happening because nothing legible was.
//
// The email side already had this right: shouldNotifyClient suppresses a re-send when the outcome
// has not moved. The row was written anyway, so the page showed the ladder the inbox was
// deliberately spared. This is that same gate, for the row.
//
// WHY THIS LIVES WITH THE CLASSIFIER AND NOT AT THE INSERT. "Did anything change?" is a judgement
// about monitor output — which labels count as the same state, which sources are polls — and it
// belongs beside the code that produces those labels. It does not belong in two places: a second
// copy of this rule would drift from the classifier that feeds it.
//
// WHO CALLS IT. recordPermitStatusCheck() in repository.ts, and nothing else — it is the one
// function that writes permit_status_checks, and it gates that INSERT (plus the
// human_review_items row and insertMonitorCorrection, which are the same check's other "this is
// news" artifacts) on the answer. This paragraph used to assert the call existed while the
// function had no production caller at all and only a test drove it; if you are moving this
// logic, grep for `shouldRecordStatusCheck` in backend/src before trusting the sentence above.
//
// WHAT IS NOT LOST. audit_logs already records one `permit_status.checked` row per check, inside
// the same transaction, carrying source/outcome/statusLabel/targetId. The per-check evidence trail
// is there and is unaffected. permit_check_targets.last_checked_at is also advanced on every
// check, so "when did we last look" is a different question from "when did it last move" and
// both still have an answer.
// ---------------------------------------------------------------------------

/**
 * The sources that are a POLL — us going and looking, on a timer, at something that usually has
 * not moved. These are the only ones that can ladder, and the only ones gated.
 *
 * `email` and `manual` are deliberately absent:
 *
 *   · `email` — an inbound AHJ email is an EVENT, not a poll. Two emails saying the same thing are
 *     two things that happened. It is already deduped upstream by email_project_matches
 *     .source_signature (UNIQUE), so it cannot ladder; and the match row stores the id of the
 *     check written for it, so suppressing that insert would silently link a new email to an
 *     older check.
 *   · `manual` — an operator pasting status text expects a record of having done so.
 */
const POLLED_CHECK_SOURCES: ReadonlySet<PermitCheckSource> = new Set<PermitCheckSource>([
  "portal",
  "public_url",
  "mock",
]);

export function isPolledCheckSource(source: string): boolean {
  return POLLED_CHECK_SOURCES.has(source as PermitCheckSource);
}

/**
 * Does this check represent a CHANGE worth recording as a row?
 *
 * `previous` is the target's latest_outcome / latest_status_label as they stood BEFORE this check
 * — the same pair the client-notification gate reads. Pass null when there is no target (a
 * project-level check has nothing to compare against and is always recorded).
 *
 * COMPARE ON BOTH FIELDS, NOT THE OUTCOME ALONE. One outcome carries several distinct labels:
 * `ready_for_issue` is either "Ready for issue" or "Ready for issue - fee/payment needed", and
 * `needs_human_review` is "No status text", "Needs human review" OR "Action needed before
 * review". A permit moving from "In review" to "Action needed before review" is the single most
 * important thing a client can be told — the agency has stopped and is waiting on us — and on an
 * outcome-only comparison from some prior states it would be swallowed as "no change".
 *
 * THE FIRST CHECK ALWAYS COUNTS. A blank previous outcome is a target that has never been looked
 * at; the first reading is a transition from nothing to something.
 *
 * A STALE BASELINE IS NO BASELINE. `previous.stale` says the newest STORED row for this target is
 * one today's rules would classify differently (classificationDrift). Comparing against it asks
 * "did anything move since a verdict we no longer believe", and a "no" left that row in place as
 * the reading every page publishes: 1fb3dc39's operator pressed Re-check three times, the target's
 * last_checked_at advanced, no row was written, and the dashboard went on saying "Last checked
 * 9/14" beside a panel offering the same Re-check. A fresh reading supersedes a stale one, always.
 */
export function shouldRecordStatusCheck(
  previous: { outcome?: string | null; statusLabel?: string | null; stale?: boolean } | null | undefined,
  next: { outcome: string; statusLabel: string },
  source: PermitCheckSource,
): boolean {
  if (!isPolledCheckSource(source)) return true;
  if (!previous) return true;
  if (previous.stale) return true;
  const previousOutcome = String(previous.outcome ?? "").trim();
  if (!previousOutcome) return true;
  const previousLabel = String(previous.statusLabel ?? "").trim();
  return previousOutcome !== String(next.outcome ?? "").trim()
    || previousLabel !== String(next.statusLabel ?? "").trim();
}

export function nextCheckIso(days: number, from = new Date()): string {
  const next = new Date(from);
  next.setDate(next.getDate() + Math.max(1, Math.floor(days || 7)));
  return next.toISOString();
}

// ---------------------------------------------------------------------------
// A CLASSIFIER FIX THAT NEVER REACHES THE STORED ROWS IS INVISIBLE TO THE CUSTOMER.
//
// THE LIVE CASE. Two Coos Bay structural permits (187-26-000309-STR, 187-26-000305-STR) have read
// "Record Status: Intake Requirements Needed" since Sep 3 — the city is waiting on US. The rule
// that says so landed at 21:12; the last status check ran at 20:12, one hour earlier. So the
// stored rows still say waiting / "In review", the client page reads STORED rows, and it will go
// on telling the customer the city is reviewing a permit the city has stalled until something
// checks again. The classifier was fixed and the customer never saw it.
//
// WHAT IS NOT DONE ABOUT IT, ON PURPOSE: the stored rows are NOT rewritten. permit_status_checks
// is an audit trail — email_project_matches.status_check_id is a foreign key into it, and
// correction_id / reviewed_by_ahj feed other logic. Rewriting a row changes what we believed at
// the time, which is the one thing an audit trail must never do. The fix is a NEW row, written by
// a real re-check through recordPermitStatusCheck; everything here exists to make the staleness
// VISIBLE so somebody triggers one.
//
// WHY RE-CLASSIFICATION AND NOT A "RULES CHANGED AT" CONSTANT. The obvious design is a version or
// date stamp on the rules, compared against created_at. It rots: the day somebody edits a pattern
// without bumping the stamp, every affected row reads as current. Re-running the classifier over
// the row's own stored text needs no maintenance and is stronger evidence — recordPermitStatusCheck
// takes NO outcome/statusLabel override (its input is targetId/source/rawStatusText/application
// /permit numbers only), so every stored label was produced by classifyPermitStatusText() from the
// very text stored beside it. If today's rules disagree with the stored pair, the rules have
// CHANGED since that row was written. That is a proof, not a heuristic.
//
// WHAT IT CANNOT SEE: a poll whose text moved but whose classification did not. Such a check is
// suppressed by shouldRecordStatusCheck, so the newest STORED text can be older than the newest
// text we fetched. The drift below is a statement about the reading we are still showing, which is
// exactly the reading the client page is publishing.
// ---------------------------------------------------------------------------

export interface StoredClassificationDrift {
  /** Today's rules disagree with what this row stored — i.e. the row predates the current rules. */
  stale: boolean;
  storedOutcome: string;
  storedStatusLabel: string;
  /** What classifyPermitStatusText() says about the SAME stored text today. */
  currentOutcome: string;
  currentStatusLabel: string;
}

/**
 * Would a re-read of this stored row's own text, under today's rules, say something else?
 *
 * Blank text or a blank stored outcome answers `false`: there is nothing to re-derive, and
 * inventing drift for a row we cannot re-classify would mark half a legacy table as suspect.
 */
export function classificationDrift(stored: {
  outcome?: string | null;
  statusLabel?: string | null;
  rawStatusText?: string | null;
}): StoredClassificationDrift {
  const raw = String(stored.rawStatusText ?? "").trim();
  const storedOutcome = String(stored.outcome ?? "").trim();
  const storedStatusLabel = String(stored.statusLabel ?? "").trim();
  if (!raw || !storedOutcome) {
    return {
      stale: false,
      storedOutcome,
      storedStatusLabel,
      currentOutcome: storedOutcome,
      currentStatusLabel: storedStatusLabel,
    };
  }
  const current = classifyPermitStatusText(raw);
  return {
    stale: current.outcome !== storedOutcome || current.statusLabel !== storedStatusLabel,
    storedOutcome,
    storedStatusLabel,
    currentOutcome: current.outcome,
    currentStatusLabel: current.statusLabel,
  };
}

/** One filing whose CURRENT stored reading was classified by rules we no longer use. */
export interface StaleStatusReading extends StoredClassificationDrift {
  projectId: string;
  targetId: string;
  /** The permit_status_checks row that is stale. Never rewritten — quoted so it can be audited. */
  checkId: string;
  /** When that reading was taken. */
  checkedAt: string;
  source: string;
  targetType: string;
  permitType: string;
  applicationNumber: string;
  /**
   * Whether a re-check can actually FETCH anything. A `public_url` re-check against a target with
   * no portal URL resolves to "No status text available…" and writes a needs_human_review row —
   * an honest answer, but it replaces one stale reading with a blanker one, so an operator being
   * offered the trigger has to be told which of the two they are about to get.
   */
  hasPortalUrl: boolean;
}

/**
 * The stale readings across a set of projects — newest stored row per TARGET, and only the ones
 * today's rules disagree with.
 *
 * NEWEST ROW PER TARGET, not per project: a project's structural filing can be stale while its
 * electrical one is current, and permit_check_targets.latest_outcome/latest_status_label always
 * mirror the newest row (the target UPDATE is never gated), so the row this finds is the one both
 * public pages are publishing.
 *
 * raw_status_text is read HERE and nowhere else. It is scraped portal prose carrying homeowner
 * names and examiners' direct lines; it is used to re-classify and is never returned. The client
 * payload takes a boolean off this and nothing more — see clientPortal.ts.
 */
export function staleStatusClassifications(db: AppDb, projectIds: string[]): StaleStatusReading[] {
  const ids = (projectIds || []).map((p) => String(p || "").trim()).filter(Boolean);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  // rowid, not created_at: two checks recorded in the same millisecond tie, and the primary key is
  // a random UUID. SQLite's rowid is this table's insertion counter (TEXT primary key, so the
  // implicit rowid is intact) — the same ordering projectStatusHistory relies on.
  const rows = db.query<Record<string, unknown>>(
    `SELECT c.id, c.project_id, c.target_id, c.source, c.outcome, c.status_label,
            c.raw_status_text, c.created_at,
            t.target_type, t.permit_type, t.application_number, t.portal_url
       FROM permit_status_checks c
       JOIN permit_check_targets t ON t.id = c.target_id
      WHERE c.project_id IN (${placeholders})
        AND c.rowid = (SELECT MAX(c2.rowid) FROM permit_status_checks c2 WHERE c2.target_id = c.target_id)`,
    ids,
  );
  const stale: StaleStatusReading[] = [];
  for (const row of rows) {
    const drift = classificationDrift({
      outcome: String(row.outcome || ""),
      statusLabel: String(row.status_label || ""),
      rawStatusText: String(row.raw_status_text || ""),
    });
    if (!drift.stale) continue;
    stale.push({
      ...drift,
      projectId: String(row.project_id || ""),
      targetId: String(row.target_id || ""),
      checkId: String(row.id || ""),
      checkedAt: String(row.created_at || ""),
      source: String(row.source || ""),
      targetType: String(row.target_type || ""),
      permitType: String(row.permit_type || ""),
      applicationNumber: String(row.application_number || ""),
      hasPortalUrl: Boolean(String(row.portal_url || "").trim()),
    });
  }
  return stale;
}

/**
 * The drift pass, WITH THE THIRD ANSWER: "we could not tell".
 *
 * staleStatusClassifications above reads permit_status_checks, joins permit_check_targets and
 * RE-RUNS classifyPermitStatusText over stored portal prose. Any of that can throw — a schema
 * migration mid-deploy, a row the classifier chokes on, a locked database. Unguarded, that throw
 * propagates into clientPortalPayload / publicProjectStatusPayload / projectStatusHistory and
 * takes down the tokenized status page a CUSTOMER was emailed. A homeowner gets a 500 because a
 * diagnostic about our own rule changes failed. That trade is never worth making: the staleness
 * marker is a caveat on the page, not the page.
 *
 * So a failure degrades to NO MARKER — and says so. `checked:false` is not `readings:[]`:
 *
 *   checked:true,  readings:[]   — the drift pass ran and every stored reading is current.
 *   checked:false, readings:[]   — the drift pass FAILED. We do not know. Treat nothing here as
 *                                  confirmed fresh.
 *
 * Collapsing those two into a bare empty array is the bug this exists to prevent: "unknown"
 * rendering as an affirmative all-clear is exactly how a stalled permit goes on reading "In
 * review" to the person waiting on it. Callers that have somewhere to SAY it (the operator route,
 * which reports `checked` to the dashboard) must say it; the customer pages, which have no wording
 * for "our diagnostic broke", drop the caveat and leave the loud log below as the channel.
 *
 * NEVER RETHROWS. Every call site is a page render.
 */
export interface StaleReadingScan {
  /** false means the pass FAILED, not that nothing is stale. See above — the distinction is the point. */
  checked: boolean;
  readings: StaleStatusReading[];
}

/**
 * THE SAME PASS, IN A SHAPE A CALLER CANNOT COLLAPSE. This is what the customer payloads use.
 *
 * `scanStaleStatusClassifications` above is honest — `checked:false` is not `readings:[]` — and it
 * was STILL collapsed, one line later, in exactly the way its own comment warned about:
 *
 *     return new Set(scan.readings.map((s) => s.targetId));   // clientPortal.staleTargetIds
 *
 * That Set answers `has()` with `false` for a reading we confirmed is current AND for a pass that
 * exploded before it read anything, and the pages published the flattering one. Christopher Ivy's
 * building permit went from "needs confirming" to an unqualified "In review by the jurisdiction",
 * on a permit that has been stalled at the counter since Sep 3, in a payload byte-identical to a
 * confirmed-fresh one. The guard was there. The SHAPE it returned is what lost the third answer.
 *
 * So the answer that reaches a page is not a membership test. It is a THREE-VALUED verdict per
 * target, and "we could not check" is a value of its own — there is no empty collection to read a
 * reassurance out of, and no boolean whose `false` branch has two meanings. A caller that ignores
 * `"unverified"` has to write the word, which is a thing a reviewer can see.
 *
 * NEVER THROWS, for the same reason the scan does not: every call site is a page a customer opened.
 * A failure means every reading on that page is `"unverified"` — not marked stale (we have no
 * evidence of drift) and never confirmed current (we have no evidence of freshness either).
 */
export type PublishedReadingFreshness = (targetId: string) => ReadingFreshness;

export function publishedReadingFreshness(db: AppDb, projectIds: string[]): PublishedReadingFreshness {
  const scan = scanStaleStatusClassifications(db, projectIds);
  // THE FAILURE BRANCH FIRST, and it ignores its argument on purpose: with no pass there is no
  // per-target answer to give, and every reading the page is about to publish is unverified.
  if (!scan.checked) return () => "unverified";
  const stale = new Set(scan.readings.map((s) => String(s.targetId || "")).filter(Boolean));
  return (targetId: string) => (stale.has(String(targetId || "")) ? "stale" : "current");
}

export function scanStaleStatusClassifications(db: AppDb, projectIds: string[]): StaleReadingScan {
  try {
    return { checked: true, readings: staleStatusClassifications(db, projectIds) };
  } catch (err) {
    // No project ids, no scraped prose — the ids are internal UUIDs and the count is the useful
    // number. logger redacts nothing for us here, so nothing identifying goes in.
    logger.error(
      "permit-monitor",
      "Stale-classification pass failed; status pages will render WITHOUT staleness markers. "
      + "An unmarked reading is now unverified, not confirmed current.",
      { projects: (projectIds || []).length, reason: err instanceof Error ? err.message : String(err) },
    );
    return { checked: false, readings: [] };
  }
}
