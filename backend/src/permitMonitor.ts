import type { PermitCheckOutcome } from "../../shared/src/types";

export interface PermitStatusClassification {
  outcome: PermitCheckOutcome;
  statusLabel: string;
  confidence: number;
  reviewedByAhj: boolean;
  readyForIssue: boolean;
  issueFeeDue: boolean;
  message: string;
}

const correctionPattern =
  /\b(correction|corrections|deficien(?:cy|cies)|rejected|returned|revision required|resubmit|resubmittal|required revisions|additional information|incomplete|review comments|not approved|denied|failed review|revise and resubmit)\b/i;

const readyForIssuePattern =
  /\b(ready for issue|ready to issue|ready for issuance|permit ready|ready for pickup|ready for pick up|approved pending payment|pay fees?|fees? due|issuance fees?|final fees?|ready to be issued)\b/i;

const issuedPattern =
  /\b(permit issued|issued permit|status:\s*issued|issued on|download permit|permit card|inspection card|permit has been issued)\b/i;

const nemApprovalPattern =
  /\b(pto granted|permission to operate|net metering approved|customer generation approved|(?:interconnection|nem)(?:\s+\w+){0,3}\s+approved|approved(?:\s+\w+){0,3}\s+(?:interconnection|nem)|authorization to (?:install|interconnect|operate))\b/i;

const reviewedPattern =
  /\b(review complete|plan review complete|approved|approved with conditions|reviewed by ahj|reviewed and approved|passed review|application approved)\b/i;

const waitingPattern =
  /\b(under review|in review|review in progress|submitted|received|intake|pending review|processing|assigned to reviewer|awaiting review|queued)\b/i;

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
  const header = /condition:\s*([^|]{0,140})/i.exec(blob);
  return header ? `Condition: ${header[1].trim()}`.slice(0, 180) : "";
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

export function classifyPermitStatusText(rawStatusText: string): PermitStatusClassification {
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

  if (issuedPattern.test(text)) {
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
    // AGAINST THE FULL PAGE, not `text`. extractStatedStatus narrows `text` to the stated status
    // ("Intake Requirements Needed") and the condition lives elsewhere on the record — testing
    // the narrowed string found nothing, and the first version of the test passed anyway because
    // it matched the word "outstanding" in this very message rather than the portal's notice.
    const condition = conditionPattern.test(rawStatusText) ? extractPortalCondition(rawStatusText) : "";
    return {
      outcome: "needs_human_review",
      statusLabel: "Action needed before review",
      confidence: 0.8,
      reviewedByAhj: false,
      readyForIssue: false,
      issueFeeDue: false,
      message:
        "The agency is waiting on the APPLICANT, not reviewing — the record says requirements are "
        + "outstanding at intake. Nothing moves until they are supplied."
        + (condition ? ` The record also carries a condition: "${condition}".` : ""),
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

export function nextCheckIso(days: number, from = new Date()): string {
  const next = new Date(from);
  next.setDate(next.getDate() + Math.max(1, Math.floor(days || 7)));
  return next.toISOString();
}
