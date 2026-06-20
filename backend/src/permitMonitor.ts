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
  /\b(pto granted|permission to operate|interconnection approved|nem approved|net metering approved|customer generation approved|utility application approved)\b/i;

const reviewedPattern =
  /\b(review complete|plan review complete|approved|approved with conditions|reviewed by ahj|reviewed and approved|passed review|application approved)\b/i;

const waitingPattern =
  /\b(under review|in review|review in progress|submitted|received|intake|pending review|processing|assigned to reviewer|awaiting review|queued)\b/i;

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function classifyPermitStatusText(rawStatusText: string): PermitStatusClassification {
  const text = clean(rawStatusText);
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
