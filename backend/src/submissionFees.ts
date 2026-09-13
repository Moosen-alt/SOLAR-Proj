// ---------------------------------------------------------------------------
// Per-submission payment gate: quote = REAL permit fees + the operator's
// service fee ("top fee"), collected from the client BEFORE staging begins.
//
// Permit-fee resolution, most-trusted first:
//   1. actual        — the portal-calculated fee, entered by the operator from
//                      the portal's fee/review screen (or a prior true-up).
//   2. learned       — median of real fees previously observed for the same
//                      AHJ/utility (permit_fee_history), fuzzy name matching.
//   3. published     — the jurisdiction's own published fee schedule, bracketed
//                      to THIS project's size (backend/src/feeSchedules.ts).
//   4. estimate      — valuation-based heuristic, clearly labelled as rough.
//
// Why "published" sits below "learned" and above "estimate": a fee we actually
// watched a portal charge beats a printed one, because schedules go stale and
// portals add surcharges, plan-review add-ons and state fees that the PDF does
// not mention. But a published schedule carrying a source URL the operator can
// click beats 1.5%-of-valuation by a mile — that guess knows nothing about the
// jurisdiction at all, and its whole job was to be better than a blank.
//
// IMPORTANT: this bills the CLIENT for the submission service. It never pays —
// and never automates — the AHJ/utility portal's own fee checkout; that stays
// human-only (same rule as final submit).
// ---------------------------------------------------------------------------

import { createRequire } from "node:module";
import type { AppDb } from "./db";
import type {
  FeeConfidence,
  FeePaymentMethod,
  PermitFeeSource,
  ProjectFeeSheet,
  ProjectFeeSheetLine,
  ProjectRecord,
  PublishedFeeResult,
  SubmissionPaymentQuote,
  SubmissionPaymentRecord,
} from "../../shared/src/types";
import { knowledgeNameMatchScore } from "./knowledgeBase";
import { listPortalCredentials, selectCredentialUrlsFor } from "./portalCredentials";
import { resolveValuation, parseMoney } from "./valuation";
import { HttpError } from "./httpError";
import { id } from "./ids";
import { text } from "./json";
import { nowIso } from "./time";
import { logger } from "./logger";

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
    feeResponsibility: text(row.fee_responsibility),
    feeRecordedAt: text(row.fee_recorded_at),
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

// --- Published fee schedules (optional module) ------------------------------
// backend/src/feeSchedules.ts owns FINDING and storing schedules; this module
// only consumes them. Everything here is defensive on purpose: the quote runs
// inside the staging gate, so a schedule module that is missing, half-written,
// throwing, or returning a shape we did not expect must degrade to the ladder
// below it — never break a submission.

// The signature is feeSchedules.feeForProject's, so the seam the tests drive is
// the same call production makes — a stub shaped differently would prove nothing.
export type FeeScheduleLookup = (
  db: AppDb,
  project: ProjectRecord,
  track: "permit" | "nem",
) => PublishedFeeResult | null;

/** The export names accepted from the schedule module, most-current first. */
const LOOKUP_EXPORTS = ["feeForProject", "lookupPublishedFee"];

let injectedLookup: FeeScheduleLookup | null = null;
let loadedLookup: FeeScheduleLookup | null | undefined; // undefined = not tried yet
let loadWarned = false;

/** Boot/test seam for the schedule lookup. Pass null to reset, which puts the
 *  ladder back to whatever the module on disk provides (or, with no module,
 *  back to its pre-schedule behaviour) in the same process. */
export function registerFeeScheduleLookup(lookup: FeeScheduleLookup | null): void {
  injectedLookup = lookup;
  loadedLookup = undefined;
}

function feeScheduleLookup(): FeeScheduleLookup | null {
  if (injectedLookup) return injectedLookup;
  if (loadedLookup !== undefined) return loadedLookup;
  loadedLookup = null;
  const req = createRequire(import.meta.url);
  for (const spec of ["./feeSchedules.ts", "./feeSchedules.js"]) {
    try {
      const mod = req(spec) as Record<string, unknown> | undefined;
      for (const name of LOOKUP_EXPORTS) {
        if (typeof mod?.[name] === "function") { loadedLookup = mod[name] as FeeScheduleLookup; break; }
      }
      break;
    } catch (err) {
      // Absent is an expected state — stay quiet. Present-but-broken is not:
      // say so once, or the tier vanishes silently and every quote quietly
      // falls back to guessing.
      if ((err as { code?: string }).code !== "MODULE_NOT_FOUND" && !loadWarned) {
        loadWarned = true;
        console.warn(`[fees] published fee schedules unavailable (${spec}): ${(err as Error)?.message || err}`);
      }
    }
  }
  return loadedLookup;
}

interface ScheduleFee {
  /** null = a schedule exists but did not evaluate for this project (see reason). */
  feeUsd: number | null;
  bracketLabel: string | null;
  sourceUrl: string | null;
  sourceQuote: string;
  confidence: "verified" | "seeded";
  paymentMethod: FeePaymentMethod | null;
  matchedName: string;
  reason: string;
}

const PAYMENT_METHODS: FeePaymentMethod[] = ["portal", "mailed_check", "none", "unknown"];

// A schedule that spells out payment by post is stating a process automation
// cannot perform. Read only an explicit positive statement, and never flip a
// method the producer set itself.
const MAILED_CHECK_RE = /\b(?:mail(?:ed)?\s+(?:a\s+|the\s+)?check|check\s+(?:payable|by\s+mail)|paid?\s+by\s+check|remit\s+(?:a\s+)?check)\b/i;

// "WE HOLD TWO CONTRADICTORY PUBLISHED NUMBERS" IS NOT "WE HAVE NO SCHEDULE".
//
// A conflicted schedule refuses to evaluate, so it arrives here as feeUsd:null —
// the same channel as "no system size yet" and "no schedule stored at all" — and
// the quote drops to the labelled 1.5%-of-valuation estimate. That degrade is
// RIGHT and is kept: the portal's own number trues this up later
// (recordActualPermitFee), automation never pays the fee (hard rule 1), and this
// function runs inside the staging gate whose whole contract is never to break a
// submission. Blocking a filing over a fee-sheet disagreement would trade a
// minute of somebody's reading for a stopped job.
//
// What is NOT right is showing it the way every other gap is shown. Measured on
// Coos County: the estimate reads $450 against a true $160, under "Rough
// estimate … true it up" — the sentence an operator sees on every jurisdiction
// with no schedule, i.e. the ordinary state of the world, i.e. nobody acts. The
// one actionable fact — that the county's own form says $94 and its own adopted
// schedule says $160, 1.70x apart, one stamped 2022 and one 2025, resolvable in
// sixty seconds — was compressed into "needs a human to read it", which says
// nothing about what to do. So a conflict LEADS the basis line, on whichever
// tier won the amount.
//
// Matched by regex and not by import on purpose: this module require()s the
// schedule module defensively and must keep quoting if it is absent or broken
// (see feeScheduleLookup). The literal is feeSchedules.FEE_CONFLICT_MARKER, and
// submissionFees.test.ts asserts the two still agree so the copies cannot drift.
const FEE_CONFLICT_RE = /\bUNRESOLVED FEE CONFLICT\b/;

/** Read the producer's result through a whitelist. A module owned elsewhere must
 *  not be able to put a negative fee, a novel enum or a junk URL on a quote. */
function normalizeScheduleResult(raw: unknown): ScheduleFee | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rawFee = r.feeUsd;
  const fee = Number(rawFee);
  // 0 is an ANSWER ("this jurisdiction charges nothing"). Absent/NaN/negative is
  // "the schedule could not say", which keeps the row for its reason and URL but
  // hands the amount to the tier below.
  const usable = rawFee != null && rawFee !== "" && Number.isFinite(fee) && fee >= 0;

  const url = text(r.sourceUrl).trim();
  const quote = text(r.sourceQuote).trim().slice(0, 400);
  const declared = text(r.paymentMethod).trim().toLowerCase() as FeePaymentMethod;
  let paymentMethod: FeePaymentMethod | null = PAYMENT_METHODS.includes(declared) ? declared : null;
  if (!paymentMethod && usable && fee > 0 && MAILED_CHECK_RE.test(quote)) paymentMethod = "mailed_check";

  return {
    feeUsd: usable ? round2(fee) : null,
    bracketLabel: text(r.bracketLabel).trim().slice(0, 200) || null,
    sourceUrl: /^https?:\/\//i.test(url) ? url.slice(0, 500) : null,
    sourceQuote: quote,
    // Research lands as seeded (safety rule 3); only a human promotes it.
    confidence: text(r.confidence).trim().toLowerCase() === "verified" ? "verified" : "seeded",
    paymentMethod,
    matchedName: text(r.matchedName).trim().slice(0, 200),
    reason: text(r.reason).trim().slice(0, 400),
  };
}

/** The published schedule's answer for THIS project, or null if no schedule is
 *  stored at all. Resolved for every quote — see buildPaymentQuote for why the
 *  payment METHOD is taken from here even when a higher tier wins the amount. */
function publishedScheduleFee(db: AppDb, project: ProjectRecord, track: "permit" | "nem"): ScheduleFee | null {
  const lookup = feeScheduleLookup();
  if (!lookup) return null;
  try {
    return normalizeScheduleResult(lookup(db, project, track));
  } catch (err) {
    if (!loadWarned) {
      loadWarned = true;
      console.warn(`[fees] published fee schedule lookup failed: ${(err as Error)?.message || err}`);
    }
    return null;
  }
}

// Rough valuation-based fallback, env-tunable. Clearly labelled — the operator
// trues it up with the portal-calculated fee from the review screen.
function estimatedFee(db: AppDb, project: ProjectRecord, track: "permit" | "nem"): { fee: number | null; basis: string } {
  if (track === "nem") {
    // An operator who sets the env var has made a statement; honour it.
    const raw = Number(process.env.NEM_FEE_ESTIMATE_USD);
    if (Number.isFinite(raw) && raw >= 0) {
      return { fee: round2(raw), basis: `Configured NEM application estimate (NEM_FEE_ESTIMATE_USD) — a house default, not ${project.utility || "this utility"}'s published schedule. True it up from the portal or the interconnection tariff.` };
    }
    // Nothing else may invent one. "Most residential NEM carries no fee" is
    // true in aggregate and FALSE per utility — Ameren Illinois Level 1 is $50
    // by mailed check — so with no schedule and no history this is unknown,
    // not $0. A zero the operator trusts is worse than a blank they chase.
    return {
      fee: null,
      basis: `No published interconnection fee schedule found for ${project.utility || "this utility"} yet. Most residential NEM applications carry no utility fee, but some do (Ameren Illinois Level 1 is $50 by mailed check), so this is reported unknown rather than $0 — find the schedule or enter the real fee.`,
    };
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

  // Resolved for EVERY quote, whichever tier wins the amount: the payment method
  // and the source URL are facts about the jurisdiction's process, not about
  // where we got the number. Ameren Illinois' $50 is a mailed check whether we
  // read it off the schedule, learned it from a past filing, or typed it in.
  const schedule = publishedScheduleFee(db, project, track);
  const scheduleConflicted = !!schedule?.reason && FEE_CONFLICT_RE.test(schedule.reason);

  let permitFeeUsd: number | null = null;
  let permitFeeSource: PermitFeeSource = "unknown";
  let permitFeeBasis = "";
  let permitFeeConfidence: FeeConfidence = "unknown";
  let permitFeeBracketLabel: string | null = schedule?.bracketLabel ?? null;
  const permitFeeSourceUrl: string | null = schedule?.sourceUrl ?? null;

  if (existing?.permitFeeActualUsd != null) {
    permitFeeUsd = existing.permitFeeActualUsd;
    permitFeeSource = "actual";
    permitFeeConfidence = "actual";
    permitFeeBasis = "Portal-calculated fee (entered from the portal's fee/review screen).";
  } else {
    const learned = learnedFee(db, project, track);
    if (learned) {
      permitFeeUsd = learned.fee;
      permitFeeSource = "learned_history";
      permitFeeConfidence = "verified";
      permitFeeBasis = `Median of ${learned.samples} real fee(s) previously observed for ${learned.matchedName}.`;
    } else if (schedule && schedule.feeUsd != null) {
      permitFeeUsd = schedule.feeUsd;
      permitFeeSource = "published_schedule";
      permitFeeConfidence = schedule.confidence;
      const who = schedule.matchedName || (track === "nem" ? project.utility : project.ahj) || "this jurisdiction";
      permitFeeBasis = `${who}'s published fee schedule${schedule.bracketLabel ? `, line "${schedule.bracketLabel}"` : ""}`
        + `${schedule.confidence === "verified" ? " (human-verified)" : " (researched, not yet human-verified)"}.`
        + `${schedule.sourceQuote ? ` Published as: "${schedule.sourceQuote}".` : ""}`
        + `${schedule.sourceUrl ? ` ${schedule.sourceUrl}` : ""}`;
    } else {
      const est = estimatedFee(db, project, track);
      permitFeeUsd = est.fee;
      permitFeeSource = est.fee == null ? "unknown" : "valuation_estimate";
      permitFeeConfidence = est.fee == null ? "unknown" : "estimated";
      // A schedule that was found but would not evaluate is the most useful thing
      // we can say here: "no size on the project yet" is a fixable answer, where
      // a bare guess just hides it.
      permitFeeBasis = schedule?.reason && !scheduleConflicted
        ? `${est.basis} A published schedule for ${schedule.matchedName || "this jurisdiction"} was found but did not resolve: ${schedule.reason}${schedule.sourceUrl ? ` (${schedule.sourceUrl})` : ""}`
        : est.basis;
      // A bracket label describes a schedule line we did not use — do not let it
      // ride along on a guess and read as though the guess were bracketed.
      permitFeeBracketLabel = null;
    }
  }

  // A CONFLICT IS A FACT ABOUT THE JURISDICTION, NOT ABOUT WHICH TIER WON — so it
  // is prepended after the ladder, not inside one of its branches. A learned
  // median or an operator-entered actual is a better answer than either disputed
  // number and rightly keeps the amount; the open question about what this county
  // publishes is still true, still unanswered, and still the only thing on this
  // screen anyone can act on.
  if (scheduleConflicted && schedule) {
    permitFeeBasis = `${schedule.reason}${schedule.sourceUrl ? ` (${schedule.sourceUrl})` : ""}`
      + ` THE AMOUNT QUOTED IS NOT FROM THAT SCHEDULE — ${permitFeeBasis}`;
  }

  // Honest default: unknown unless the schedule said, or unless the fee is a
  // known zero (nothing to pay is a payment method).
  let paymentMethod: FeePaymentMethod = schedule?.paymentMethod ?? "unknown";
  if (paymentMethod === "unknown" && permitFeeUsd === 0) paymentMethod = "none";

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
    permitFeeSourceUrl,
    permitFeeBracketLabel,
    permitFeeConfidence,
    paymentMethod,
    serviceFeeUsd,
    totalUsd,
    payment: getSubmissionPayment(db, project.id, track),
  };
}

/** Record the REAL portal-calculated fee (true-up) and feed the fee history so
 *  future quotes for this AHJ/utility start from reality. */
/** THE FEE AGREEMENT AT THIS MOMENT, for stamping onto a payment row.
 *
 *  Whether a jurisdiction fee is ours to re-bill lives on the portal credential, and only
 *  'keelix-pays' means we advance it. Resolved here, at record time, so the invoice can read a
 *  fact rather than recompute one — see migration v24.
 *
 *  NEVER GUESSES BETWEEN CREDENTIALS. A client with several portals on file and no way to tell
 *  which one this track filed through returns "" — unrecorded — and the invoice says so. An
 *  invented agreement is worse than a missing one: it puts a number in front of a customer that
 *  nobody consented to, which is the whole failure this column exists to prevent. */
export function feeResponsibilityNow(db: AppDb, project: ProjectRecord, track: "permit" | "nem"): string {
  const clientId = text(project.clientId);
  if (!clientId) return "";
  // STATICALLY IMPORTED, not require()d. The first version reached for require() inside a
  // try/catch here and silently returned "" in an ESM module where require does not exist —
  // so every fee looked like it had no agreement on file, which is indistinguishable from a
  // client who genuinely has none. That is the catch-swallows-the-answer shape this codebase
  // keeps getting bitten by. portalCredentials does not import this module, so there is no
  // cycle to avoid.
  try {
    const rows = listPortalCredentials(db, clientId);
    if (!rows.length) return "";

    // The portal this track actually filed through, when the submission recorded one. That is
    // better evidence than any prediction made today: it is the door the money went through.
    const profileUrl = text(db.get<Row>(
      `SELECT p.portal_url AS portal_url FROM submissions s
         JOIN portal_profiles p ON p.id = s.portal_profile_id
        WHERE s.project_id = ? AND p.portal_url <> ''
        ORDER BY s.created_at DESC LIMIT 1`,
      [project.id],
    )?.portal_url);
    if (profileUrl) {
      const usable = selectCredentialUrlsFor(profileUrl, rows.map((r) => r.portalUrl));
      for (const url of usable) {
        const hit = rows.find((r) => r.portalUrl === url && text(r.feeResponsibility));
        if (hit) return text(hit.feeResponsibility);
      }
    }

    // No recorded portal. One credential is unambiguous; several are not, and a permit track
    // must never inherit a utility portal's agreement (safety rule 5).
    const stated = rows.filter((r) => text(r.feeResponsibility));
    if (stated.length === 1) return text(stated[0].feeResponsibility);
    return "";
  } catch (err) {
    // A credential store that cannot be read is not a reason to refuse the fee entry — the
    // agreement goes unrecorded and the invoice reports it as such. But it is SAID, because a
    // silent "" here reads exactly like a client who never agreed anything, and that is a
    // statement about a business relationship.
    logger.warn("fees", "could not resolve fee responsibility — recording the fee without an agreement", {
      projectId: project.id, track, err: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

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
  // STAMPED HERE, ONCE. Re-entering a corrected fee re-stamps, which is right — the agreement
  // that matters is the one in force when the amount was settled. An already-stamped row whose
  // agreement has since been REMOVED keeps what it had, because "" means "nothing was on file",
  // not "the agreement was withdrawn".
  const responsibility = feeResponsibilityNow(db, project, track) || existing.feeResponsibility;
  db.run(
    `UPDATE submission_payments SET permit_fee_actual_usd = ?, total_usd = ?, fee_basis = ?,
       fee_responsibility = ?, fee_recorded_at = ?, updated_at = ? WHERE id = ?`,
    [fee, total, "Portal-calculated fee (entered from the portal's fee/review screen).",
      responsibility, ts, ts, existing.id],
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

/** ONE call answering the operator's actual question — "what will this project
 *  cost?" — across both tracks: every fee with its source, bracket, citation,
 *  confidence and payment method, plus what is still unknown. */
export function buildProjectFeeSheet(db: AppDb, project: ProjectRecord): ProjectFeeSheet {
  // Built from FRESH quotes, never read back from submission_payments: that row
  // stores total_usd NOT NULL and persists an unknown as 0, which is the exact
  // lie this sheet exists to prevent.
  const quotes: Array<{ track: "permit" | "nem"; quote: SubmissionPaymentQuote }> = [
    { track: "permit", quote: buildPaymentQuote(db, project, "permit") },
    { track: "nem", quote: buildPaymentQuote(db, project, "nem") },
  ];
  const billingMode = quotes[0].quote.billingMode;
  const billingRequired = quotes[0].quote.required;

  const lines: ProjectFeeSheetLine[] = quotes.map(({ track, quote }) => ({
    track,
    jurisdiction: (track === "nem" ? project.utility : project.ahj) || "",
    feeUsd: quote.permitFeeUsd,
    source: quote.permitFeeSource,
    basis: quote.permitFeeBasis,
    bracketLabel: quote.permitFeeBracketLabel,
    sourceUrl: quote.permitFeeSourceUrl,
    confidence: quote.permitFeeConfidence,
    paymentMethod: quote.paymentMethod,
    serviceFeeUsd: quote.serviceFeeUsd,
    totalUsd: quote.totalUsd,
    known: quote.permitFeeUsd != null,
  }));

  const unknowns: string[] = [];
  const outOfPortalPayments: string[] = [];
  for (const line of lines) {
    const who = line.jurisdiction || (line.track === "nem" ? "the utility" : "the AHJ");
    const label = line.track === "nem" ? "NEM / interconnection fee" : "Permit fee";
    if (!line.known) unknowns.push(`${label} for ${who} is unknown. ${line.basis}`);
    if (line.paymentMethod === "mailed_check") {
      outOfPortalPayments.push(
        `${label} for ${who}${line.feeUsd != null ? ` ($${line.feeUsd.toFixed(2)})` : ""} is paid by MAILED CHECK — no portal can take it, so a human sends it.`,
      );
    }
  }

  // A total is reported only when EVERY component is known. One unknown line
  // nulls the total rather than quietly summing it as a zero.
  const allKnown = lines.every((line) => line.known);
  const jurisdictionFeesUsd = allKnown ? round2(lines.reduce((sum, line) => sum + (line.feeUsd ?? 0), 0)) : null;
  // The service fee is charged per SUBMISSION, so a project filing both tracks
  // carries two — and none at all when the client is not billed per submission.
  const serviceFeesUsd = billingRequired ? round2(lines.reduce((sum, line) => sum + line.serviceFeeUsd, 0)) : 0;

  return {
    projectId: project.id,
    billingMode,
    billingRequired,
    lines,
    jurisdictionFeesUsd,
    serviceFeesUsd,
    totalUsd: jurisdictionFeesUsd == null ? null : round2(jurisdictionFeesUsd + serviceFeesUsd),
    unknowns,
    outOfPortalPayments,
    generatedAt: nowIso(),
  };
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
