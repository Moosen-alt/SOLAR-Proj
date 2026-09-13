// ---------------------------------------------------------------------------
// WHAT THE SOLAR COMPANY OWES US FOR ONE PROJECT.
//
// Two kinds of money, and they are never added together:
//
//   REIMBURSEMENT — a jurisdiction or utility fee WE advanced and re-bill. Pass-through, not
//                   revenue. Only a fee whose recorded agreement is 'keelix-pays' ("we pay it
//                   and re-bill") belongs here; card-on-file, customer-pays and mailed-check
//                   were all settled on the customer's side and are not ours to recover.
//   SERVICE       — our own per-submission fee. Revenue. Charged only to a client on
//                   per_submission billing; a monthly client's service fee is not a line here.
//
// A bookkeeper treats those differently, so a single blended total would be wrong even when
// the arithmetic is right. There is deliberately NO grand total on this object.
//
// AN ESTIMATE IS NOT AN INVOICE, and that is the load-bearing rule. submission_payments carries
// permit_fee_estimate_usd (a quote — the published schedule, a learned median, or 1.5% of
// valuation) alongside permit_fee_actual_usd (the number a person read off the portal's own fee
// screen and typed in). Only the ACTUAL is invoiceable. Billing an estimate charges a company
// for a number nobody paid, and it would look exactly like a real invoice.
//
// THIS MODULE NEVER WRITES. buildPaymentQuote persists quote rows as a side effect of being
// asked — fee-sheet.ts wraps it in a rolled-back transaction for that reason. An invoice reads
// getSubmissionPayment only, so a project with no payment row simply has nothing to invoice,
// which is the honest answer rather than a row conjured by the act of looking.
//
// BUILT AS A LINE-BUILDER OVER PAYMENT ROWS so the monthly statement, when it comes, is the
// same function over a different set of rows plus a WHERE on fee_recorded_at. Nothing here
// knows it is looking at exactly one project.
// ---------------------------------------------------------------------------
import type { AppDb } from "./db";
import type { ClientRecord, ProjectRecord, SubmissionPaymentRecord } from "../../shared/src/types";
import { getSubmissionPayment, defaultServiceFeeUsd } from "./submissionFees";
import { feeForProject } from "./feeSchedules";
import { getClient } from "./clients";
import { text } from "./json";
import { nowIso } from "./time";

const TRACKS = ["permit", "nem"] as const;
export type InvoiceTrack = (typeof TRACKS)[number];

/** The one agreement that makes a jurisdiction fee ours to recover. */
export const REIMBURSABLE_RESPONSIBILITY = "keelix-pays";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** One authority's share of a re-billed fee, as the published schedule breaks it down. */
export interface InvoiceComposition {
  authority: string;
  discipline: string;
  amountUsd: number | null;
  sourceUrl: string;
  /** Non-empty when this share is collected by an authority other than the project's AHJ. */
  collectedVia: string;
}

export interface InvoiceLine {
  track: InvoiceTrack;
  kind: "reimbursement" | "service";
  description: string;
  amountUsd: number;
  /** Empty for a service line. For a reimbursement, the split the schedule publishes — one
   *  rooftop can owe a city and a county separately, and an invoice that shows only the sum
   *  shows a number no published schedule contains. */
  composition: InvoiceComposition[];
  /** Set when the composition does not add up to the invoiced amount. Not an error: a portal
   *  may charge a surcharge the schedule does not list, or the typed figure may be wrong. It
   *  is a question for a person, which is why it travels with the line. */
  reconciliation: string;
  paymentReference: string;
  recordedAt: string;
}

/** Something real that is NOT on the invoice, and what would put it there. Never silently
 *  dropped and never summed as zero — a missing line that nobody mentions reads as "this
 *  project cost nothing". */
export interface InvoiceExclusion {
  track: InvoiceTrack;
  reason: string;
  resolution: string;
  /** The amount we can see but are not charging, so a person can judge the size of the gap. */
  amountSeenUsd: number | null;
}

export interface ProjectInvoice {
  projectId: string;
  homeownerName: string;
  jurisdiction: string;
  clientId: string;
  clientName: string;
  billingMode: string;
  lines: InvoiceLine[];
  /** Fees we advanced and are recovering. Pass-through. */
  reimbursementTotalUsd: number;
  /** Our own service fees. Revenue. */
  serviceTotalUsd: number;
  notInvoiceable: InvoiceExclusion[];
  generatedAt: string;
}

const TRACK_LABEL: Record<InvoiceTrack, string> = {
  permit: "Building/electrical permit fee",
  nem: "Interconnection (NEM) application fee",
};

const RESPONSIBILITY_PROSE: Record<string, string> = {
  "card-on-file": "settled on the customer's own payment method in their portal account",
  "customer-pays": "settled by a person on the customer's side",
  "mailed-check": "settled by a paper cheque the customer mailed",
};

/** The published schedule's own breakdown of a track's fee, for the invoice to show beneath
 *  the amount. Read-only, and a schedule that cannot be evaluated simply contributes nothing. */
function compositionFor(db: AppDb, project: ProjectRecord, track: InvoiceTrack): InvoiceComposition[] {
  try {
    const resolved = feeForProject(db, project, track);
    if (!resolved || !resolved.lines.length) return [];
    return resolved.lines.map((l) => ({
      authority: text(l.authority),
      discipline: text(l.discipline),
      amountUsd: l.feeUsd,
      sourceUrl: text(l.sourceUrl),
      collectedVia: text(l.hoppedFrom),
    }));
  } catch {
    return [];
  }
}

/** Does the composition account for the invoiced amount? */
function reconcile(amountUsd: number, composition: InvoiceComposition[]): string {
  if (!composition.length) return "";
  if (composition.some((c) => c.amountUsd == null)) {
    return "The published schedule could not price every part of this fee, so the breakdown below is incomplete — the amount invoiced is the figure recorded from the portal.";
  }
  const sum = round2(composition.reduce((t, c) => t + (c.amountUsd ?? 0), 0));
  if (sum === round2(amountUsd)) return "";
  const diff = round2(amountUsd - sum);
  return `The portal charged $${amountUsd.toFixed(2)} and the published schedule adds up to $${sum.toFixed(2)}`
    + ` (${diff > 0 ? "+" : "-"}$${Math.abs(diff).toFixed(2)}). A surcharge the schedule does not list, or a`
    + ` mistyped figure — worth a look before this goes out. The amount invoiced is what the portal charged.`;
}

/** THE PRIMITIVE. One payment row in, at most two invoice lines out, plus whatever it could
 *  not charge and why. The monthly statement will call exactly this, once per row. */
export function invoiceLinesForPayment(
  db: AppDb,
  project: ProjectRecord,
  client: ClientRecord | null,
  row: SubmissionPaymentRecord,
): { lines: InvoiceLine[]; excluded: InvoiceExclusion[] } {
  const track = (row.track === "nem" ? "nem" : "permit") as InvoiceTrack;
  const lines: InvoiceLine[] = [];
  const excluded: InvoiceExclusion[] = [];
  const actual = row.permitFeeActualUsd;
  const responsibility = text(row.feeResponsibility);

  if (row.status === "waived") {
    excluded.push({
      track,
      reason: "This submission's fees were WAIVED.",
      resolution: "Nothing to do — a waiver is a decision, not a gap.",
      amountSeenUsd: actual ?? row.permitFeeEstimateUsd,
    });
    return { lines, excluded };
  }

  // ── the jurisdiction fee ────────────────────────────────────────────────────────────
  if (actual == null) {
    excluded.push({
      track,
      reason: row.permitFeeEstimateUsd == null
        ? "No jurisdiction fee has been recorded for this track."
        // The basis text usually ends in its own full stop, so do not add a second one.
        : `Only an ESTIMATE is on file ($${row.permitFeeEstimateUsd.toFixed(2)}), and an estimate is not invoiceable. `
          + `It was quoted as: ${row.feeBasis || "basis not recorded"}`.replace(/\.?$/, ".")
          + ` NOTE: this is the figure stored when the quote was last built — the published schedule may since`
          + ` have moved, and scripts/fee-sheet.ts shows what it says today. Neither number is invoiceable.`,
      resolution: "Enter the portal-calculated fee from its own fee/review screen (\"Record real fee\"), which also teaches future quotes for this jurisdiction.",
      amountSeenUsd: row.permitFeeEstimateUsd,
    });
  } else if (responsibility === REIMBURSABLE_RESPONSIBILITY) {
    const composition = compositionFor(db, project, track);
    lines.push({
      track,
      kind: "reimbursement",
      description: `${TRACK_LABEL[track]} — advanced by us, re-billed at cost`,
      amountUsd: round2(actual),
      composition,
      reconciliation: reconcile(actual, composition),
      paymentReference: text(row.paymentReference),
      recordedAt: text(row.feeRecordedAt) || text(row.updatedAt),
    });
  } else if (!responsibility) {
    excluded.push({
      track,
      reason: `A fee of $${actual.toFixed(2)} is recorded, but no fee responsibility was on file when it was entered — so there is no agreement saying whose money it was.`,
      resolution: "Record fee responsibility on the portal credential (guide S3.7), then re-enter the fee so the agreement is stamped on it. Historic rows are deliberately not back-filled: reading today's credential would rewrite what was agreed then.",
      amountSeenUsd: actual,
    });
  } else {
    excluded.push({
      track,
      reason: `A fee of $${actual.toFixed(2)} is recorded, and it was ${RESPONSIBILITY_PROSE[responsibility] || responsibility} — not advanced by us, so not ours to recover.`,
      resolution: "Nothing to do. This is recorded for the project's history, not for billing.",
      amountSeenUsd: actual,
    });
  }

  // ── our own service fee ─────────────────────────────────────────────────────────────
  const billingMode = text(client?.billingMode).toLowerCase();
  const serviceFee = round2(row.serviceFeeUsd);
  if (billingMode === "per_submission" && serviceFee > 0) {
    lines.push({
      track,
      kind: "service",
      description: `Submission service fee — ${track === "nem" ? "interconnection" : "permit"} filing prepared and staged`,
      amountUsd: serviceFee,
      composition: [],
      reconciliation: "",
      paymentReference: text(row.paymentReference),
      recordedAt: text(row.feeRecordedAt) || text(row.quotedAt),
    });
  } else if (serviceFee > 0) {
    excluded.push({
      track,
      reason: `A service fee of $${serviceFee.toFixed(2)} is quoted, but this client is billed ${billingMode || "monthly/none"} rather than per submission.`,
      resolution: "Nothing to do — it belongs on the monthly arrangement, not on this project.",
      amountSeenUsd: serviceFee,
    });
  }

  return { lines, excluded };
}

/** A per-project invoice. Reads only; writes nothing. */
export function buildProjectInvoice(db: AppDb, project: ProjectRecord): ProjectInvoice {
  let client: ClientRecord | null = null;
  if (text(project.clientId)) {
    try { client = getClient(db, text(project.clientId)); } catch { client = null; }
  }

  const lines: InvoiceLine[] = [];
  const notInvoiceable: InvoiceExclusion[] = [];
  let sawAnyRow = false;

  for (const track of TRACKS) {
    const row = getSubmissionPayment(db, project.id, track);
    if (!row) continue;               // never conjured — see the header
    sawAnyRow = true;
    const out = invoiceLinesForPayment(db, project, client, row);
    lines.push(...out.lines);
    notInvoiceable.push(...out.excluded);
  }

  if (!sawAnyRow) {
    notInvoiceable.push({
      track: "permit",
      reason: "No submission payment has been quoted for this project yet, on either track.",
      resolution: "The quote row is created when the project reaches the payment screen. Nothing is invoiceable before a fee exists.",
      amountSeenUsd: null,
    });
  }
  if (!client) {
    notInvoiceable.push({
      track: "permit",
      reason: "This project is not assigned to a client, so there is nobody to invoice.",
      resolution: "Assign the project to a client.",
      amountSeenUsd: null,
    });
  }

  const sum = (kind: InvoiceLine["kind"]): number =>
    round2(lines.filter((l) => l.kind === kind).reduce((t, l) => t + l.amountUsd, 0));

  return {
    projectId: project.id,
    homeownerName: text(project.homeownerName),
    jurisdiction: [text(project.ahj), text(project.utility)].filter(Boolean).join(" | "),
    clientId: text(project.clientId),
    clientName: text(client?.companyName) || text(client?.legalBusinessName),
    billingMode: text(client?.billingMode).toLowerCase() || "monthly/none",
    lines,
    reimbursementTotalUsd: sum("reimbursement"),
    serviceTotalUsd: sum("service"),
    notInvoiceable,
    generatedAt: nowIso(),
  };
}

/** The default service fee, exposed so a renderer can explain a zero. */
export { defaultServiceFeeUsd };
