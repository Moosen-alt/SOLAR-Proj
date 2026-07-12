// ---------------------------------------------------------------------------
// Per-submission payment gate: quote = REAL permit fees + the operator's
// service fee ("top fee"), collected from the client BEFORE staging begins.
//
// Permit-fee resolution, most-trusted first:
//   1. actual        — the portal-calculated fee, entered by the operator from
//                      the portal's fee/review screen (or a prior true-up).
//   2. learned       — median of real fees previously observed for the same
//                      AHJ/utility (permit_fee_history), fuzzy name matching.
//   3. estimate      — valuation-based heuristic, clearly labelled as rough.
//
// IMPORTANT: this bills the CLIENT for the submission service. It never pays —
// and never automates — the AHJ/utility portal's own fee checkout; that stays
// human-only (same rule as final submit).
// ---------------------------------------------------------------------------

import type { AppDb } from "./db";
import type { ProjectRecord, SubmissionPaymentQuote, SubmissionPaymentRecord } from "../../shared/src/types";
import { knowledgeNameMatchScore } from "./knowledgeBase";
import { resolveValuation, parseMoney } from "./valuation";
import { HttpError } from "./httpError";
import { id } from "./ids";
import { text } from "./json";
import { nowIso } from "./time";

type Row = Record<string, unknown>;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Default service fee when the client has none set (env-configurable). */
export function defaultServiceFeeUsd(): number {
  const raw = Number(process.env.SUBMISSION_SERVICE_FEE_USD);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

// A submission "track" for billing collapses to permit vs nem: building /
// electrical / combo / mpu all bill as one permit submission.
export function billingTrack(track?: string | null): "permit" | "nem" {
  return String(track || "").toLowerCase() === "nem" ? "nem" : "permit";
}

function mapPayment(row: Row): SubmissionPaymentRecord {
  const num = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    track: text(row.track),
    status: (["quoted", "paid", "waived"].includes(text(row.status)) ? text(row.status) : "quoted") as SubmissionPaymentRecord["status"],
    permitFeeEstimateUsd: num(row.permit_fee_estimate_usd),
    permitFeeActualUsd: num(row.permit_fee_actual_usd),
    serviceFeeUsd: num(row.service_fee_usd) ?? 0,
    totalUsd: num(row.total_usd) ?? 0,
    feeBasis: text(row.fee_basis),
    paymentReference: text(row.payment_reference),
    quotedAt: text(row.quoted_at),
    paidAt: row.paid_at ? text(row.paid_at) : null,
    updatedAt: text(row.updated_at),
  };
}

export function getSubmissionPayment(db: AppDb, projectId: string, track?: string | null): SubmissionPaymentRecord | null {
  const row = db.get<Row>(
    "SELECT * FROM submission_payments WHERE project_id = ? AND track = ?",
    [projectId, billingTrack(track)],
  );
  return row ? mapPayment(row) : null;
}

interface ClientBilling {
  billingMode: string;
  serviceFeeUsd: number;
}

function clientBilling(db: AppDb, clientId: string | null): ClientBilling {
  if (!clientId) return { billingMode: "", serviceFeeUsd: defaultServiceFeeUsd() };
  const row = db.get<Row>("SELECT billing_mode, service_fee_usd FROM clients WHERE id = ?", [clientId]);
  const fee = row?.service_fee_usd == null ? null : Number(row.service_fee_usd);
  return {
    billingMode: text(row?.billing_mode).toLowerCase(),
    serviceFeeUsd: fee != null && Number.isFinite(fee) && fee >= 0 ? fee : defaultServiceFeeUsd(),
  };
}

/** Median of real fees seen for this AHJ (permit track) / utility (nem track),
 *  fuzzy-matched so "City of Woodburn" learns from a "Woodburn" history row. */
function learnedFee(
  db: AppDb,
  project: ProjectRecord,
  track: "permit" | "nem",
): { fee: number; samples: number; matchedName: string } | null {
  const wanted = track === "nem" ? project.utility : project.ahj;
  if (!wanted) return null;
  const rows = db.query<Row>("SELECT state, ahj, utility, fee_usd FROM permit_fee_history WHERE track = ?", [track]);
  const state = (project.state || "").trim().toUpperCase();
  const fees: number[] = [];
  let matchedName = "";
  for (const row of rows) {
    const rowState = text(row.state).trim().toUpperCase();
    if (state && rowState && rowState !== state) continue;
    const name = track === "nem" ? text(row.utility) : text(row.ahj);
    if (knowledgeNameMatchScore(wanted, name) < 60) continue;
    const fee = Number(row.fee_usd);
    if (Number.isFinite(fee) && fee >= 0) { fees.push(fee); matchedName = matchedName || name; }
  }
  if (!fees.length) return null;
  fees.sort((a, b) => a - b);
  const mid = Math.floor(fees.length / 2);
  const median = fees.length % 2 ? fees[mid] : (fees[mid - 1] + fees[mid]) / 2;
  return { fee: round2(median), samples: fees.length, matchedName };
}

// Rough valuation-based fallback, env-tunable. Clearly labelled — the operator
// trues it up with the portal-calculated fee from the review screen.
function estimatedFee(db: AppDb, project: ProjectRecord, track: "permit" | "nem"): { fee: number | null; basis: string } {
  if (track === "nem") {
    const raw = Number(process.env.NEM_FEE_ESTIMATE_USD);
    const fee = Number.isFinite(raw) && raw >= 0 ? raw : 0;
    return { fee, basis: fee > 0 ? `Estimated NEM application fee (NEM_FEE_ESTIMATE_USD).` : "Most residential NEM applications carry no utility fee — trued up from the portal's review screen if one appears." };
  }
  const valuation = resolveValuation(project.parserSnapshot, project.systemSizeDcKw);
  if (valuation.value == null) {
    return { fee: null, basis: "No valuation available yet — upload/parse the plan set or enter the contract value, or enter the portal-calculated fee directly." };
  }
  const rateRaw = Number(process.env.PERMIT_FEE_ESTIMATE_RATE);
  const rate = Number.isFinite(rateRaw) && rateRaw > 0 ? rateRaw : 0.015;
  const minRaw = Number(process.env.PERMIT_FEE_ESTIMATE_MIN_USD);
  const min = Number.isFinite(minRaw) && minRaw >= 0 ? minRaw : 150;
  const maxRaw = Number(process.env.PERMIT_FEE_ESTIMATE_MAX_USD);
  const max = Number.isFinite(maxRaw) && maxRaw > min ? maxRaw : 900;
  const fee = round2(Math.min(max, Math.max(min, valuation.value * rate)));
  return {
    fee,
    basis: `Rough estimate: ${Math.round(rate * 1000) / 10}% of ${valuation.method === "contract" ? "contract value" : "estimated valuation"} $${valuation.value.toLocaleString()} (clamped $${min}–$${max}). Enter the portal-calculated fee to true it up.`,
  };
}

/** Build (and persist, unless already paid/waived) the payment quote for a track. */
export function buildPaymentQuote(db: AppDb, project: ProjectRecord, trackInput?: string | null): SubmissionPaymentQuote {
  const track = billingTrack(trackInput);
  const billing = clientBilling(db, project.clientId);
  const existing = getSubmissionPayment(db, project.id, track);

  let permitFeeUsd: number | null = null;
  let permitFeeSource: SubmissionPaymentQuote["permitFeeSource"] = "unknown";
  let permitFeeBasis = "";
  if (existing?.permitFeeActualUsd != null) {
    permitFeeUsd = existing.permitFeeActualUsd;
    permitFeeSource = "actual";
    permitFeeBasis = "Portal-calculated fee (entered from the portal's fee/review screen).";
  } else {
    const learned = learnedFee(db, project, track);
    if (learned) {
      permitFeeUsd = learned.fee;
      permitFeeSource = "learned_history";
      permitFeeBasis = `Median of ${learned.samples} real fee(s) previously observed for ${learned.matchedName}.`;
    } else {
      const est = estimatedFee(db, project, track);
      permitFeeUsd = est.fee;
      permitFeeSource = est.fee == null ? "unknown" : "valuation_estimate";
      permitFeeBasis = est.basis;
    }
  }

  const serviceFeeUsd = round2(billing.serviceFeeUsd);
  const totalUsd = permitFeeUsd == null ? null : round2(permitFeeUsd + serviceFeeUsd);
  const ts = nowIso();

  // Persist/refresh the quote row so the dashboard and the gate share one record.
  // A paid/waived row is never rewritten by a re-quote.
  if (!existing) {
    db.run(
      `INSERT INTO submission_payments
         (id, project_id, track, status, permit_fee_estimate_usd, permit_fee_actual_usd, service_fee_usd, total_usd, fee_basis, quoted_at, updated_at)
       VALUES (?, ?, ?, 'quoted', ?, NULL, ?, ?, ?, ?, ?)`,
      [id(), project.id, track, permitFeeSource === "actual" ? null : permitFeeUsd, serviceFeeUsd, totalUsd ?? 0, permitFeeBasis, ts, ts],
    );
  } else if (existing.status === "quoted") {
    db.run(
      `UPDATE submission_payments
         SET permit_fee_estimate_usd = ?, service_fee_usd = ?, total_usd = ?, fee_basis = ?, updated_at = ?
       WHERE id = ?`,
      [permitFeeSource === "actual" ? existing.permitFeeEstimateUsd : permitFeeUsd, serviceFeeUsd, totalUsd ?? 0, permitFeeBasis, ts, existing.id],
    );
  }

  return {
    track,
    required: billing.billingMode === "per_submission",
    billingMode: billing.billingMode,
    permitFeeUsd,
    permitFeeSource,
    permitFeeBasis,
    serviceFeeUsd,
    totalUsd,
    payment: getSubmissionPayment(db, project.id, track),
  };
}

/** Record the REAL portal-calculated fee (true-up) and feed the fee history so
 *  future quotes for this AHJ/utility start from reality. */
export function recordActualPermitFee(
  db: AppDb,
  project: ProjectRecord,
  trackInput: string | null | undefined,
  actualFee: unknown,
  source: "operator" | "portal_review" = "operator",
): SubmissionPaymentQuote {
  const fee = parseMoney(actualFee);
  if (fee == null) throw new HttpError(400, "actualPermitFeeUsd must be a positive amount.");
  const track = billingTrack(trackInput);
  buildPaymentQuote(db, project, track); // ensure the row exists
  const existing = getSubmissionPayment(db, project.id, track)!;
  const ts = nowIso();
  const total = round2(fee + existing.serviceFeeUsd);
  db.run(
    `UPDATE submission_payments SET permit_fee_actual_usd = ?, total_usd = ?, fee_basis = ?, updated_at = ? WHERE id = ?`,
    [fee, total, "Portal-calculated fee (entered from the portal's fee/review screen).", ts, existing.id],
  );
  db.run(
    `INSERT INTO permit_fee_history (id, state, ahj, utility, track, fee_usd, source, project_id, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id(), project.state || "", project.ahj || "", project.utility || "", track, fee, source, project.id, ts],
  );
  return buildPaymentQuote(db, project, track);
}

export function markSubmissionPaid(
  db: AppDb,
  project: ProjectRecord,
  trackInput: string | null | undefined,
  input: { paymentReference?: string; actualPermitFeeUsd?: unknown },
): SubmissionPaymentQuote {
  if (input.actualPermitFeeUsd != null && input.actualPermitFeeUsd !== "") {
    recordActualPermitFee(db, project, trackInput, input.actualPermitFeeUsd, "operator");
  } else {
    buildPaymentQuote(db, project, trackInput);
  }
  const track = billingTrack(trackInput);
  const existing = getSubmissionPayment(db, project.id, track)!;
  const ts = nowIso();
  db.run(
    `UPDATE submission_payments SET status = 'paid', payment_reference = ?, paid_at = ?, updated_at = ? WHERE id = ?`,
    [text(input.paymentReference).slice(0, 200), ts, ts, existing.id],
  );
  return buildPaymentQuote(db, project, track);
}

export function waiveSubmissionPayment(db: AppDb, project: ProjectRecord, trackInput?: string | null): SubmissionPaymentQuote {
  buildPaymentQuote(db, project, trackInput);
  const track = billingTrack(trackInput);
  const existing = getSubmissionPayment(db, project.id, track)!;
  const ts = nowIso();
  db.run(`UPDATE submission_payments SET status = 'waived', updated_at = ? WHERE id = ?`, [ts, existing.id]);
  return buildPaymentQuote(db, project, track);
}

/** The staging gate: throws 402 for per-submission clients until this track's
 *  payment is paid or waived. Clients on other billing modes pass through. */
export function assertSubmissionPaid(db: AppDb, project: ProjectRecord, trackInput?: string | null): void {
  const quote = buildPaymentQuote(db, project, trackInput);
  if (!quote.required) return;
  const status = quote.payment?.status;
  if (status === "paid" || status === "waived") return;
  throw new HttpError(402, `Payment required before staging: this client bills per submission. Collect ${quote.totalUsd != null ? `$${quote.totalUsd.toFixed(2)}` : "the submission total"} (permit fees${quote.permitFeeUsd != null ? ` $${quote.permitFeeUsd.toFixed(2)}` : ""} + service fee $${quote.serviceFeeUsd.toFixed(2)}) on the Payment screen, then mark it paid.`, {
    paymentRequired: true,
    quote,
  });
}
