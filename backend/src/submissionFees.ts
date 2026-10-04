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
  FeeChargeBreakdown,
  FeeComparison,
  FeeConfidence,
  FeeConfirmItem,
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
import { isServiceLineBaseKind, serviceLineCounts, SERVICE_FEEDER_200A_LABEL, SERVICE_FEEDER_400A_LABEL } from "./batteryServiceFeeder";
import { stateRulesFor } from "./permitProcess";
import { localPermitReview, permitFeeProject } from "./feeIssuer";
import { portalFeeSummary } from "./portalFeeReadings";

/** The portal's own total for the filing — typed by a person ("actual") or read off the record
 *  ("portal_record"). Either already contains every line the jurisdiction billed. */
const isPortalFigure = (source: PermitFeeSource): boolean => source === "actual" || source === "portal_record";

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

/** History sources a PERSON entered (typed off the portal's fee/review screen). Every other
 *  source — a parsed billing summary (fee_summary:*), a portal record the monitor read
 *  (portal_record) — is a machine's reading, and a median containing one is not "verified". */
const PERSON_ENTERED_HISTORY = new Set(["operator", "portal_review"]);

/** Median of real fees seen for this AHJ (permit track) / utility (nem track),
 *  fuzzy-matched so "City of Woodburn" learns from a "Woodburn" history row.
 *
 *  THIS PROJECT'S OWN PORTAL FIGURES ARE LEFT OUT. The ladder below the portal's number now
 *  runs on every quote so the portal's figure can be shown BESIDE it ("researched $360 — the
 *  portal's $415.20"); a median fed by the very figure it is compared with would compare the
 *  number to itself. A parsed billing summary of its own (fee_summary:*) still counts — that is
 *  how a project's own summary reaches its quote (feeSummary.ts). */
function learnedFee(
  db: AppDb,
  project: ProjectRecord,
  track: "permit" | "nem",
): { fee: number; samples: number; machineSamples: number; matchedName: string } | null {
  const wanted = track === "nem" ? project.utility : project.ahj;
  if (!wanted) return null;
  const rows = db.query<Row>(
    `SELECT state, ahj, utility, fee_usd, source FROM permit_fee_history
      WHERE track = ? AND source NOT LIKE 'receipt_component:%'
        AND NOT (COALESCE(project_id, '') = ? AND source IN ('operator', 'portal_review', 'portal_record'))`,
    [track, project.id],
  );
  const state = (project.state || "").trim().toUpperCase();
  const fees: number[] = [];
  let machineSamples = 0;
  let matchedName = "";
  for (const row of rows) {
    const rowState = text(row.state).trim().toUpperCase();
    if (state && rowState && rowState !== state) continue;
    const name = track === "nem" ? text(row.utility) : text(row.ahj);
    if (knowledgeNameMatchScore(wanted, name) < 60) continue;
    const fee = Number(row.fee_usd);
    if (Number.isFinite(fee) && fee >= 0) {
      fees.push(fee);
      if (!PERSON_ENTERED_HISTORY.has(text(row.source))) machineSamples++;
      matchedName = matchedName || name;
    }
  }
  if (!fees.length) return null;
  fees.sort((a, b) => a - b);
  const mid = Math.floor(fees.length / 2);
  const median = fees.length % 2 ? fees[mid] : (fees[mid - 1] + fees[mid]) / 2;
  return { fee: round2(median), samples: fees.length, machineSamples, matchedName };
}

/** The portal's figure beside the researched one: both numbers and the difference. */
function compareFees(
  portalUsd: number,
  portalSource: PermitFeeSource,
  researched: { usd: number | null; source: PermitFeeSource; confidence: FeeConfidence },
  shown: "portal" | "researched",
  note: string,
): FeeComparison {
  return {
    researchedUsd: researched.usd,
    researchedSource: researched.source,
    researchedConfidence: researched.confidence,
    portalUsd: round2(portalUsd),
    portalSource,
    differenceUsd: researched.usd == null ? null : round2(portalUsd - researched.usd),
    shown,
    note,
  };
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
/** The exact-row lookup for an AHJ's own zoning review fee (feeSchedules.localReviewFeeForProject). */
const LOCAL_REVIEW_EXPORT = "localReviewFeeForProject";
let loadedReviewLookup: FeeScheduleLookup | null | undefined;

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

/** Same defensive load as feeScheduleLookup, for the local review row; absent → no review fee. */
function localReviewLookup(): FeeScheduleLookup | null {
  if (loadedReviewLookup !== undefined) return loadedReviewLookup;
  loadedReviewLookup = null;
  const req = createRequire(import.meta.url);
  for (const spec of ["./feeSchedules.ts", "./feeSchedules.js"]) {
    try {
      const mod = req(spec) as Record<string, unknown> | undefined;
      if (typeof mod?.[LOCAL_REVIEW_EXPORT] === "function") loadedReviewLookup = mod[LOCAL_REVIEW_EXPORT] as FeeScheduleLookup;
      break;
    } catch { /* absent or broken: feeScheduleLookup already says so once */ }
  }
  return loadedReviewLookup;
}

interface ScheduleFee {
  /** null = a schedule exists but did not evaluate for this project (see reason). */
  feeUsd: number | null;
  bracketLabel: string | null;
  sourceUrl: string | null;
  /** The ROW's citation. Read below by MAILED_CHECK_RE — a signal about how the
   *  money moves — and NEVER printed beside the amount: a bracketed schedule has
   *  one of these and N brackets, so it agrees with at most one of them. */
  sourceQuote: string;
  /** The evidence for THIS amount, which is what may be shown beside it. "" when
   *  the producer could not offer one (or when the amount is a total of two
   *  permits, which no single published line states). */
  bracketQuote: string;
  /** The producer found every line printed in the document it cites. A machine
   *  check, and a different dimension from `confidence` — it never means a
   *  person has vouched for the number. */
  corroborated: boolean;
  /** The producer's reading of what its printed evidence row names (feeSchedules
   *  corroborationVerdict): "other_permit" means the row names another permit and must not be
   *  offered as this fee's published line. Anything unrecognised reads "none". */
  evidenceVerdict: "names_permit" | "other_permit" | "unnamed" | "none";
  confidence: "verified" | "seeded";
  /** Who verified it and when — "" unless confidence is "verified". The NAME is a tenant's fact:
   *  shown only when every org in verifiedOrgIds is the project's own (verifierNameFor). */
  verifiedBy: string;
  verifiedAt: string;
  verifiedOrgIds: string[];
  /** WHAT A CONFIRM WOULD VERIFY, line by line — each line's bracket at its amount on its own
   *  row, and the delegation hop it was reached through — read off the producer's per-line split
   *  (fees-close2: a person vouches for exactly what was on the card, never a whole row).
   *  feeConfirmRows adds the rows' versions. */
  confirmTargets: ScheduleConfirmTarget[];
  /** The amount was computed from a per-watt ESTIMATED valuation, not a contract figure. A
   *  different dimension from  again: that one grades the TABLE, this one the
   *  INPUT, and a perfect table walked on a guess still owes the operator a true-up. */
  valuationEstimated: boolean;
  paymentMethod: FeePaymentMethod | null;
  matchedName: string;
  reason: string;
  /** The jurisdiction's bill for this filing, itemised. See the whitelist in
   *  normalizeScheduleResult — this list is drawn on an operator's screen and
   *  summed nowhere here, so it is read defensively like every other field the
   *  producer hands over. */
  charges: FeeChargeBreakdown[];
  /** The priced permit lines that carry NO state surcharge ("Marion County structural"), read off
   *  the producer's per-line split. Empty when every line carries one, or when the filing already
   *  holds a surcharge charge of its own. See stateSurchargeNotice. */
  surchargeGaps: string[];
}

const PAYMENT_METHODS: FeePaymentMethod[] = ["portal", "mailed_check", "none", "unknown"];
/** One filing does not draw fifty charges — the same ceiling the storage side
 *  applies, restated here because this module must not trust that one held. */
const CHARGE_CAP = 16;

/** Trust order for FeeConfidence, weakest last — buildProjectFeeSheet grades a
 *  TOTAL by the weakest line summed into it. Same vocabulary as the lines. */
const FEE_CONFIDENCE_RANK: Record<FeeConfidence, number> = {
  actual: 4, verified: 3, seeded: 2, estimated: 1, unknown: 0,
};

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

/** Read the itemised bill through the same whitelist discipline as the amount.
 *
 *  An unpriced charge KEEPS ITS PLACE IN THE LIST. `amountUsd: null` is the whole
 *  point of the shape — a conditional review nobody has answered is why the total
 *  above it is null, and a normaliser that dropped the charge for having no number
 *  would leave a null total with nothing on screen to explain it. Unknowns are
 *  carried, never tidied away. */
function normalizeCharges(raw: unknown): FeeChargeBreakdown[] {
  if (!Array.isArray(raw)) return [];
  const out: FeeChargeBreakdown[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const label = text(c.label).trim().slice(0, 200);
    if (!label) continue;
    const amount = Number(c.amountUsd);
    const priced = c.amountUsd != null && c.amountUsd !== "" && Number.isFinite(amount) && amount >= 0;
    const url = text(c.sourceUrl).trim();
    out.push({
      label,
      kind: text(c.kind).trim().toLowerCase().slice(0, 40) || "other",
      amountUsd: priced ? round2(amount) : null,
      partOfLineFee: c.partOfLineFee === true,
      conditional: c.conditional === true,
      // Explicit true only, like every other flag crossing this seam. The default is HOLD: a
      // producer that has never heard of this field cannot accidentally release a charge from
      // nulling the total, which is the direction that costs somebody money.
      ...(c.futureContingent === true ? { futureContingent: true } : {}),
      reason: text(c.reason).trim().slice(0, 400),
      quote: text(c.quote).trim().slice(0, 400),
      sourceUrl: /^https?:\/\//i.test(url) ? url.slice(0, 500) : "",
    });
    if (out.length >= CHARGE_CAP) break;
  }
  return out;
}

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

  const verified = text(r.confidence).trim().toLowerCase() === "verified";
  return {
    feeUsd: usable ? round2(fee) : null,
    bracketLabel: text(r.bracketLabel).trim().slice(0, 200) || null,
    sourceUrl: /^https?:\/\//i.test(url) ? url.slice(0, 500) : null,
    sourceQuote: quote,
    bracketQuote: text(r.bracketQuote).trim().slice(0, 400),
    corroborated: r.corroborated === true,
    evidenceVerdict: (["names_permit", "other_permit", "unnamed"] as const).find((v) => v === text(r.evidenceVerdict)) ?? "none",
    // Research lands as seeded (safety rule 3); only a human promotes it.
    confidence: verified ? "verified" : "seeded",
    // A name beside a seeded row would read as a vouch nobody made — read only beside verified.
    verifiedBy: verified ? text(r.verifiedBy).trim().slice(0, 120) : "",
    verifiedAt: verified ? text(r.verifiedAt).trim().slice(0, 40) : "",
    // Absent/malformed reads as [ ] — which shows the name to nobody (fail closed).
    verifiedOrgIds: verified && Array.isArray(r.verifiedOrgIds) ? (r.verifiedOrgIds as unknown[]).map((o) => text(o).trim().slice(0, 120)).slice(0, 8) : [],
    confirmTargets: confirmTargetsOf(r),
    // Defensive like everything else crossing this seam: anything that is not an explicit true
    // reads as "not an estimate", so a producer that has never heard of this field cannot make
    // a real published fee look like a guess.
    valuationEstimated: r.valuationEstimated === true,
    paymentMethod,
    matchedName: text(r.matchedName).trim().slice(0, 200),
    reason: text(r.reason).trim().slice(0, 400),
    charges: normalizeCharges(r.charges),
    surchargeGaps: surchargeGapsOf(r),
  };
}

/** One item a Confirm would verify, before the row's version is read (feeConfirmRows). */
type ScheduleConfirmTarget = Omit<FeeConfirmItem, "id" | "updatedAt" | "collectedBy"> & { scheduleId: string };

/** THE ITEMS BEHIND THE AMOUNT, as the card shows them: every line's bracket at the line's amount
 *  on its own row, and the delegation hop a hopped line was reached through — once each. A line
 *  with no amount has nothing a person could have seen, so it contributes no bracket item (its
 *  total is unknown and not confirmable anyway). `verified` is the producer's own per-piece grade
 *  (FeeScheduleLine.bracketVouched / hopVouched) — the one predicate, not a second reading here. */
function confirmTargetsOf(r: Record<string, unknown>): ScheduleConfirmTarget[] {
  const lines = Array.isArray(r.lines) ? (r.lines as Array<Record<string, unknown>>) : [];
  const out: ScheduleConfirmTarget[] = [];
  const seen = new Set<string>();
  const push = (t: ScheduleConfirmTarget): void => {
    const key = `${t.kind}|${t.scheduleId}|${t.bracketLabel}|${t.feeUsd ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  for (const l of lines) {
    if (!l || typeof l !== "object") continue;
    const discipline = text(l.discipline).trim().slice(0, 40);
    const sid = text(l.scheduleId).trim().slice(0, 80);
    const fee = l.feeUsd == null || l.feeUsd === "" ? NaN : Number(l.feeUsd);
    if (sid && Number.isFinite(fee)) {
      push({
        scheduleId: sid, kind: "bracket", authority: text(l.authority).trim().slice(0, 200), discipline,
        bracketLabel: text(l.bracketLabel), feeUsd: round2(fee), collectedByAuthority: "", verified: l.bracketVouched === true,
      });
    }
    const pointer = text(l.delegatedFromScheduleId).trim().slice(0, 80);
    if (pointer) {
      push({
        scheduleId: pointer, kind: "delegation", authority: text(l.hoppedFrom).trim().slice(0, 200), discipline,
        bracketLabel: "", feeUsd: null, collectedByAuthority: text(l.authority).trim().slice(0, 200), verified: l.hopVouched === true,
      });
    }
  }
  return out.slice(0, 16);
}

/** Permit lines priced WITHOUT a state surcharge. A line whose own label says it already includes
 *  surcharges, and a filing that holds any surcharge charge as its own item, are not gaps. */
function surchargeGapsOf(r: Record<string, unknown>): string[] {
  const lines = Array.isArray(r.lines) ? (r.lines as Array<Record<string, unknown>>) : [];
  const charges = Array.isArray(r.charges) ? (r.charges as Array<Record<string, unknown>>) : [];
  if (charges.some((c) => c && c.partOfLineFee !== true && /surcharge/i.test(`${text(c.kind)} ${text(c.label)}`))) return [];
  const out: string[] = [];
  for (const l of lines) {
    if (!l || typeof l !== "object") continue;
    const fee = Number(l.feeUsd);
    if (l.feeUsd == null || !Number.isFinite(fee) || fee <= 0) continue;
    if (l.stateSurchargeUsd != null) continue;
    const lineCharges = Array.isArray(l.charges) ? (l.charges as Array<Record<string, unknown>>) : [];
    if (lineCharges.some((c) => /surcharge/i.test(`${text(c?.kind)} ${text(c?.label)}`))) continue;
    if (/\binclud(?:es?|ing)\b[^.;]{0,50}\bsurcharges?\b|\bsurcharges?\b[^.;]{0,20}\bincluded\b/i.test(text(l.bracketLabel))) continue;
    out.push([text(l.authority).trim(), text(l.discipline).trim()].filter(Boolean).join(" ") || "permit");
  }
  return out.slice(0, 6);
}

/** THE STATE SURCHARGE THE QUOTE DOES NOT INCLUDE (close M3). A state that levies a surcharge on
 *  permit fees (a cited STATE_PERMIT_RULES entry — Oregon's ORS 455.210, at most 12%) and a quoted
 *  permit line that carries none: the amount is short by up to that percentage, and it must say so
 *  instead of reading as a complete price. "" when nothing is missing. */
export function stateSurchargeNotice(state: string, gaps: string[]): string {
  if (!gaps.length) return "";
  const rule = stateRulesFor(state).surcharge;
  if (!rule || typeof rule.value !== "number") return "";
  const pct = Math.round(rule.value * 1000) / 10;
  return ` PLUS the state surcharge on the ${gaps.join(" and ")} permit${gaps.length > 1 ? "s" : ""} (up to ${pct}% of the permit fee — ${rule.quote.split(":")[0]}) — NOT included in this amount; confirm the surcharge with the agency.`;
}

/** The published schedule's answer for THIS project, or null if no schedule is
 *  stored at all. Resolved for every quote — see buildPaymentQuote for why the
 *  payment METHOD is taken from here even when a higher tier wins the amount. */
function publishedScheduleFee(db: AppDb, project: ProjectRecord, track: "permit" | "nem"): ScheduleFee | null {
  // THE PERMIT FEE IS THE ISSUER'S (issue #56): where a cited state rule issues the permits (New
  // Mexico CID), the schedule is the state agency's, never the village's — the quote, the sheet and
  // a Confirm (feeConfirmRows) all read it here, so they cannot disagree about whose row it is.
  return scheduleFeeAt(db, track === "permit" ? permitFeeProject(project) : project, track);
}

/** The published-schedule lookup for exactly this project's agency, no issuer re-keying. */
function scheduleFeeAt(db: AppDb, project: ProjectRecord, track: "permit" | "nem"): ScheduleFee | null {
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
    basis: `Rough estimate: ${Math.round(rate * 1000) / 10}% of ${valuation.method === "contract" ? "the permit valuation" : "the ESTIMATED permit valuation"} ${valuation.value.toLocaleString()} (${valuation.basis.replace(/.s*$/, "")}) (clamped $${min}–$${max}). Enter the portal-calculated fee to true it up.`,
  };
}

// AN ARCHIVED PROJECT STILL GETS A REAL QUOTE. IT MUST NOT GET A SILENT ONE.
//
// Archiving hides a job from the CLIENT portal and deletes nothing; projectArchive.ts
// is explicit that operator surfaces keep showing everything, "because hiding work
// from the people doing it is how a cleanup becomes a second problem". So suppressing
// the fee here would be the wrong fix twice over: it would contradict that decision,
// and a suppressed fee arrives at the sheet through the SAME `known: false` channel as
// "we have no schedule" — an amount we know perfectly well, re-rendered as an unknown.
//
// What was actually wrong is that nobody was told. On the live database the superseded
// Fixture pass (cf1c56aa, archived "Superseded pass at 520 Example St NE; 8f4ca8dd is the
// certified Fixture/PGE run") quotes $274.43 and reads exactly like the job that is real.
// So: quote it, and say what it is, in the one sentence that is already drawn beside
// every amount — the payment panel prints `permitFeeBasis`, and so does each fee-sheet
// line, so one chokepoint covers both with no new field for a renderer to forget.
function archivedNotice(project: ProjectRecord): string {
  const at = String(project.archivedAt ?? "").trim();
  if (!at) return "";
  const why = String(project.archivedReason ?? "").trim();
  // The reason is quoted, not paraphrased, and bounded: it is operator-written text
  // of no fixed length, and this sentence leads a field the fee sheet slices.
  return `ARCHIVED PROJECT (${at}) — this job was taken off the client's portal, so this quote is for work that `
    + `is not expected to be filed. Check before collecting anything.`
    + `${why ? ` Reason on file: "${why.length > 200 ? `${why.slice(0, 200).trimEnd()}…` : why}".` : ""} `;
}

/** THE VERIFIER'S NAME, AS THIS PROJECT MAY SEE IT (skeptic MF3). fee_schedules is shared on
 *  purpose — every tenant gets the verified amount and grade — but the name of the person who
 *  confirmed it is the confirming org's fact (rule 6). It is shown, and persisted into this
 *  project's submission_payments.fee_basis, only when EVERY org behind the verification is this
 *  project's own org; otherwise "" and the quote says "human-verified" + the date. A row with no
 *  org on record ('') names nobody. The fee sheet belongs to a project and a project to one org,
 *  so the project's org is the viewer's (a superadmin reading across orgs sees it as that org). */
export function verifierNameFor(db: AppDb, projectId: string, verifiedBy: string, verifiedOrgIds: string[]): string {
  if (!verifiedBy || !verifiedOrgIds.length) return "";
  const projectOrg = text(db.get<Row>("SELECT org_id FROM projects WHERE id = ?", [projectId])?.org_id).trim();
  if (!projectOrg) return "";
  return verifiedOrgIds.every((o) => o === projectOrg) ? verifiedBy : "";
}

/** WHAT A CONFIRM VOUCHES FOR, ITEM BY ITEM, WITH THE ROWS' VERSIONS (skeptic MF2; fees-close2)
 *  — each line's bracket at its amount and the delegation hop it was reached through, exactly as
 *  the card shows them, each with its row's updated_at. ONE answer for both doors: the fee sheet
 *  draws it beside the amount the person looks at (confirmRows — the dialog names every item), and
 *  confirmPublishedFee re-asks it at click time and refuses unless the items — rows, versions,
 *  brackets, amounts — are the ones the person saw, then records exactly those items. A version is
 *  part of the answer because research re-saves a row in place (same id): an unseen bracket can
 *  move while the displayed amount stays the same. */
export function feeConfirmRows(db: AppDb, project: ProjectRecord, track: "permit" | "nem"): FeeConfirmItem[] {
  const schedule = publishedScheduleFee(db, project, track);
  if (!schedule || !schedule.confirmTargets.length) return [];
  const out: FeeConfirmItem[] = [];
  for (const t of schedule.confirmTargets) {
    const row = db.get<Row>("SELECT id, updated_at, collected_by_profile_key FROM fee_schedules WHERE id = ?", [t.scheduleId]);
    if (!row) continue;
    out.push({
      id: text(row.id), updatedAt: text(row.updated_at), kind: t.kind, authority: t.authority, discipline: t.discipline,
      bracketLabel: t.bracketLabel, feeUsd: t.feeUsd,
      collectedBy: t.kind === "delegation" ? text(row.collected_by_profile_key) : "", collectedByAuthority: t.collectedByAuthority,
      verified: t.verified,
    });
  }
  return out;
}

/** MAY A PERSON CONFIRM THIS AMOUNT? The one answer, asked by the fee sheet (to draw the
 *  Confirm control) and by feeConfirm.confirmPublishedFee (to refuse anything else): a
 *  researched, unchecked ("seeded") amount read off a published schedule. An estimate rests on
 *  a guessed valuation, not on the table a person would be vouching for; an actual, a learned
 *  median and an already-verified row have nothing on the schedule left to confirm. */
export function feeLineConfirmable(source: PermitFeeSource, confidence: FeeConfidence): boolean {
  return source === "published_schedule" && confidence === "seeded";
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
  // The agency the permit fee is owed to (the state issuer's view, or the project itself).
  const feeProject = track === "permit" ? permitFeeProject(project) : project;
  const scheduleConflicted = !!schedule?.reason && FEE_CONFLICT_RE.test(schedule.reason);

  let permitFeeUsd: number | null = null;
  let permitFeeSource: PermitFeeSource = "unknown";
  let permitFeeBasis = "";
  let permitFeeConfidence: FeeConfidence = "unknown";
  // Set on the published_schedule tier only — see the note where it is assigned.
  let permitFeeCorroborated = false;
  let permitFeeEvidenceQuote = "";
  let permitFeeVerifiedBy = "";
  let permitFeeVerifiedAt = "";
  let permitFeeBracketLabel: string | null = schedule?.bracketLabel ?? null;
  const permitFeeSourceUrl: string | null = schedule?.sourceUrl ?? null;

  // THE RESEARCHED LADDER RUNS ON EVERY QUOTE — learned history, then the published schedule,
  // then the estimate — even when the portal's own figure is known, because that figure is
  // shown BESIDE it ("researched $360.00; the portal's $415.20, $55.20 more"), never silently in
  // its place. The portal's figure (typed by the operator, or read off the filed record) is
  // applied on top of this, below.
  {
    const learned = learnedFee(db, project, track);
    if (learned) {
      permitFeeUsd = learned.fee;
      permitFeeSource = "learned_history";
      // "verified" MEANS A PERSON (hard rule 3). A median of fees people typed off real portal
      // screens is a number people stand behind; one that contains a MACHINE's reading (a parsed
      // billing summary, a portal record the monitor read) is not, however real the money was.
      permitFeeConfidence = learned.machineSamples ? "seeded" : "verified";
      permitFeeBasis = `Median of ${learned.samples} real fee(s) previously observed for ${learned.matchedName}`
        + (learned.machineSamples
          ? ` (${learned.machineSamples === learned.samples ? "all" : `${learned.machineSamples} of them`} read automatically from portal records or billing summaries — no person has checked ${learned.machineSamples === 1 ? "it" : "them"}).`
          : ".");
    } else if (schedule && schedule.feeUsd != null) {
      permitFeeUsd = schedule.feeUsd;
      permitFeeSource = "published_schedule";
      // A PUBLISHED TABLE PLUS A GUESSED INPUT IS STILL A GUESS.
      //
      // Portland's structural fee is a valuation ladder: $540.78 for the first $25,000 and
      // $10.26 for every $1,000 above it. Walk it on a real contract figure and the answer is
      // the jurisdiction's own arithmetic. Walk it on the per-watt estimate we fall back to
      // when a project carries no job valuation and the answer is computed to the cent off a
      // number nobody supplied — $602.34 instead of $592.08 on the same house, because the
      // guess landed one $1,000 step higher. Both print identically without this line.
      //
      // "estimated" is what the fee sheet keys on to print ≈, to tag the total (ESTIMATE), and
      // to tell the operator to true it up from the portal's own fee screen. That is exactly
      // the right instruction here, and it is the difference between a number a customer can
      // be quoted and one that only looks like it.
      permitFeeConfidence = schedule.valuationEstimated ? "estimated" : schedule.confidence;
      const who = schedule.matchedName || (track === "nem" ? project.utility : feeProject.ahj) || "this jurisdiction";
      // THE SENTENCE BESIDE THE NUMBER MUST BE ABOUT THAT NUMBER.
      //
      // This used to print the schedule ROW's `sourceQuote`, which is one line
      // of an N-line table. On the live Coos County row that meant a 3.072 kVA
      // job was quoted $135 under `Published as: "5.01 KVA to 15 KVA | $160.00"`
      // — a citation for a bracket we did not charge, on three of that table's
      // four rows. `bracketQuote` is the producer's evidence for THIS amount
      // (the printed line it was corroborated against, or the bracket's own
      // verbatim label), and it is "" rather than wrong when the amount is the
      // total of two permits — no published line states a sum.
      //
      // CORROBORATED IS NOT VERIFIED and the wording keeps them apart: a machine
      // re-read the cited document and found this row printed in it; nobody has
      // signed off on the number (hard rule 3). Only a person moves a row to
      // 'verified', and nothing in this file may say otherwise.
      //
      // "MATCHES THE PUBLISHED SCHEDULE" is the operator-facing name for corroborated, and it
      // travels as its own flag (permitFeeCorroborated) so the fee sheet can label the line
      // with it instead of the bare "provisional" every unchecked research row wears. It is a
      // statement about THIS AMOUNT, so a guessed-valuation walk does not earn it: the table
      // line is printed, the number computed from our guess is not.
      // SWITCHED OFF BY DEFAULT (2026-09-27, before Tuesday's presentation): three skeptic rounds kept
      // finding printed-row shapes where the machine's "this row names this permit" reading is wrong
      // (a table heading on the column-label line, "Solar - Thermal", a wind interconnection line).
      // Until that reading holds, a researched fee stays "provisional" until a PERSON confirms it
      // (Confirm, bracket by bracket) or the portal's own record is read ("actual"). FEE_MATCH_BADGE=1
      // turns the badge and the corroboration wording back on (the fee tests run with it on).
      const matchBadgeOn = process.env.FEE_MATCH_BADGE === "1";
      permitFeeCorroborated = matchBadgeOn && schedule.corroborated && !schedule.valuationEstimated;
      // A PRINTED ROW THAT NAMES ANOTHER PERMIT IS NOT THIS FEE'S PUBLISHED LINE (skeptic M8). The
      // only line printed at this amount being "Plumbing permit fee | $160.00" says the research
      // may have priced the wrong permit — so it is never offered as "Published as", and the
      // basis says so instead. A row that names nothing (a bare size row) is still shown, marked.
      const evidenceOtherPermit = schedule.evidenceVerdict === "other_permit";
      permitFeeEvidenceQuote = evidenceOtherPermit ? "" : schedule.bracketQuote;
      const evidenceClause = evidenceOtherPermit
        ? " The only line the machine found printed at this amount in the cited schedule names ANOTHER permit (another trade, scope or discipline), so it is not offered as this fee's published line — this amount may be the wrong permit's; check the schedule before quoting."
        : schedule.bracketQuote
          ? schedule.evidenceVerdict === "unnamed"
            ? ` Printed as: "${schedule.bracketQuote}" — that line does not itself name this permit; check which table it sits in.`
            : ` Published as: "${schedule.bracketQuote}".`
          : "";
      // The NAME only on the confirming org's projects; "human-verified" + the date to everyone.
      permitFeeVerifiedBy = schedule.confidence === "verified" ? verifierNameFor(db, project.id, schedule.verifiedBy, schedule.verifiedOrgIds) : "";
      permitFeeVerifiedAt = schedule.verifiedAt;
      const vouching = schedule.confidence === "verified"
        ? ` (human-verified${permitFeeVerifiedBy ? ` by ${permitFeeVerifiedBy}` : ""}${schedule.verifiedAt ? ` on ${schedule.verifiedAt.slice(0, 10)}` : ""})`
        : permitFeeCorroborated
          ? " (matches the published schedule — CORROBORATED: a machine re-read the cited document and found this line printed in it; no person has confirmed it yet)"
          : matchBadgeOn && schedule.corroborated
            ? " (researched and CORROBORATED against the cited document — still not human-verified)"
            : " (researched, not yet human-verified)";
      permitFeeBasis = `${who}'s published fee schedule${schedule.bracketLabel ? `, line "${schedule.bracketLabel}"` : ""}`
        + `${vouching}.`
        + evidenceClause
        + `${schedule.sourceUrl ? ` ${schedule.sourceUrl}` : ""}`
        + (track === "permit" ? stateSurchargeNotice(project.state, schedule.surchargeGaps) : "");
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

  // ── THE PORTAL'S OWN FIGURE, ON TOP OF THE LADDER ─────────────────────────────────────────
  const researched = { usd: permitFeeUsd, source: permitFeeSource, confidence: permitFeeConfidence };
  const portalFeeRecords = portalFeeSummary(db, project.id, track);
  let permitFeeComparison: FeeComparison | null = null;
  // A READ LEADS THE LINE ONLY WHEN IT IS THE WHOLE TRACK, AND NOT A PARTIAL LIFECYCLE THAT
  // UNDER-QUOTES. Every filed record read (complete), and either every record issued (final) or
  // the read already reaching the researched figure — a record in review whose plan-review fee
  // is invoiced and whose permit fee is not yet would otherwise print $99 as the "actual" of a
  // $360 job, and somebody quotes a customer off this screen. Short of that it is shown BESIDE
  // the researched number with both figures and the gap.
  const portalRead = portalFeeRecords && portalFeeRecords.totalUsd != null ? portalFeeRecords.totalUsd : null;
  const portalCovers = !!portalFeeRecords && portalFeeRecords.complete && portalRead != null
    && (portalFeeRecords.final || researched.usd == null || portalRead >= researched.usd - 0.005);
  const resetScheduleQualifiers = (): void => {
    permitFeeCorroborated = false;
    permitFeeEvidenceQuote = "";
    permitFeeVerifiedBy = "";
    permitFeeVerifiedAt = "";
    // Kept as the fee-quantity fact it has always been beside an actual (a fact about the job's
    // size in the jurisdiction's table), not as a claim about where the amount came from.
    permitFeeBracketLabel = schedule?.bracketLabel ?? null;
  };
  if (existing?.permitFeeActualUsd != null) {
    // A PERSON TYPED THE PORTAL'S FIGURE — it stands (rule 3: a machine read never overwrites a
    // person's entry). A portal read that disagrees is on portalFeeRecords, drawn beside it.
    permitFeeUsd = existing.permitFeeActualUsd;
    permitFeeSource = "actual";
    permitFeeConfidence = "actual";
    permitFeeBasis = "Portal-calculated fee (entered from the portal's fee/review screen).";
    resetScheduleQualifiers();
    permitFeeComparison = compareFees(existing.permitFeeActualUsd, "actual", researched, "portal",
      portalRead != null && portalFeeRecords?.complete && Math.abs(portalRead - existing.permitFeeActualUsd) > 0.005
        ? `The portal record${portalFeeRecords.records.length === 1 ? "" : "s"} read $${portalRead.toFixed(2)} (${portalFeeRecords.provenance}) — not the figure entered; the entered figure stands until a person changes it.`
        : "");
  } else if (portalCovers && portalFeeRecords && portalRead != null) {
    permitFeeUsd = portalRead;
    permitFeeSource = "portal_record";
    // The portal's own number — "actual" — read by a machine. Never "verified".
    permitFeeConfidence = "actual";
    permitFeeBasis = `The portal's own fee, ${portalFeeRecords.provenance}`
      + (portalFeeRecords.final
        ? "."
        : ` — invoiced so far; ${portalFeeRecords.records.length === 1 ? "the record is" : "not every record is"} issued yet, so the jurisdiction may invoice more.`)
      + " Read automatically; no person has checked it.";
    resetScheduleQualifiers();
    permitFeeComparison = compareFees(portalRead, "portal_record", researched, "portal", "");
  } else if (portalFeeRecords && portalRead != null) {
    // A PARTIAL READ: shown beside the researched number, never in its place.
    const unread = portalFeeRecords.unread.map((u) => u.recordNumber || u.jurisdiction || "a record").join(", ");
    permitFeeComparison = compareFees(portalRead, "portal_record", researched, "researched",
      !portalFeeRecords.complete
        ? `Read so far: $${portalRead.toFixed(2)} (${portalFeeRecords.provenance}); not yet read: ${unread}. The amount above stays the researched figure until every filed record is read.`
        : `The portal has invoiced $${portalRead.toFixed(2)} so far (${portalFeeRecords.provenance}), below the researched figure, and the record is not issued yet — more may be invoiced. The amount above stays the researched figure.`);
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
      // The ESTIMATE column holds what research says; a portal read is not an estimate, so beside
      // one it keeps the researched figure (and permit_fee_actual_usd — a person's column — is
      // never written from a machine read).
      [id(), project.id, track, permitFeeSource === "actual" ? null : permitFeeSource === "portal_record" ? researched.usd : permitFeeUsd, serviceFeeUsd, totalUsd ?? 0, permitFeeBasis, ts, ts],
    );
  } else if (existing.status === "quoted") {
    db.run(
      `UPDATE submission_payments
         SET permit_fee_estimate_usd = ?, service_fee_usd = ?, total_usd = ?, fee_basis = ?, updated_at = ?
       WHERE id = ?`,
      [permitFeeSource === "actual" ? existing.permitFeeEstimateUsd : permitFeeSource === "portal_record" ? researched.usd : permitFeeUsd, serviceFeeUsd, totalUsd ?? 0, permitFeeBasis, ts, existing.id],
    );
  }

  return {
    track,
    required: billing.billingMode === "per_submission",
    billingMode: billing.billingMode,
    permitFeeUsd,
    permitFeeSource,
    // A DISPLAY VALUE, PREPENDED AFTER THE WRITE ABOVE — deliberately not the
    // stored `fee_basis`. The archive is reversible (unarchiveProject), so a
    // notice baked into the persisted column would outlive the fact it reports
    // and would have to be scrubbed on un-archive; computed per quote it simply
    // stops being true. The stored sentence stays the reason for the AMOUNT,
    // which is what a re-read of that column is for.
    permitFeeBasis: archivedNotice(project) + permitFeeBasis,
    permitFeeSourceUrl,
    permitFeeBracketLabel,
    // Named only when the payee is not the AHJ. "cited" is about the SCHEDULE: said only when the
    // amount came off a published (sourced) state schedule; otherwise the line says none is on file.
    ...(feeProject !== project ? {
      permitFeeIssuerLabel: `Permit fee — ${feeProject.ahj} (${permitFeeSource === "published_schedule" ? "state schedule, cited"
        : permitFeeSource === "valuation_estimate" || permitFeeSource === "unknown" ? "state issuer — no state schedule on file yet" : "state issuer"})`,
    } : {}),
    permitFeeConfidence,
    permitFeeCorroborated,
    permitFeeEvidenceQuote,
    permitFeeVerifiedBy,
    permitFeeVerifiedAt,
    permitFeeComparison,
    portalFeeRecords,
    paymentMethod,
    serviceFeeUsd,
    totalUsd,
    payment: getSubmissionPayment(db, project.id, track),
    // RESOLVED FOR EVERY QUOTE, WHICHEVER TIER WON THE AMOUNT — deliberately not
    // gated on `permitFeeSource === "published_schedule"`.
    //
    // What a City of Portland filing is MADE OF (four bills, three bureaus) is a
    // fact about the jurisdiction, exactly like `paymentMethod` and
    // `permitFeeSourceUrl` above it. Gating it on the published tier would hide the
    // itemisation in precisely the state that needs it most: a conditional charge
    // nobody has answered nulls the schedule's total, the ladder drops to the
    // valuation heuristic, and the operator would then be shown a rough $450 with
    // no sign that the real bill has seven charges on it and which one is missing.
    permitFeeCharges: schedule?.charges ?? [],
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
    // THE TRACK'S OWN RECORDED PORTAL. permit_check_targets.portal_url is written by
    // markTrackSubmitted and by staging, it is per TRACK, and on the live database it is the only
    // one of these that is actually populated — every submission carries portal_profile_id NULL,
    // so the lookup above never fires and everything fell to the "exactly one credential" rule
    // below. That rule worked only while ONE credential had an agreement; recording the agreement
    // across all 83 turned it from "unambiguous" into "ambiguous" and every invoice blocked.
    //
    // Track-scoped on purpose, and it is safety rule 5: a permit track must never inherit the
    // utility portal's agreement. Both credentials usually state one and they can disagree, so an
    // unscoped match would under- or over-bill silently.
    const targetUrl = text(db.get<Row>(
      `SELECT portal_url FROM permit_check_targets
        WHERE project_id = ? AND target_type = ? AND portal_url <> ''
        ORDER BY updated_at DESC LIMIT 1`,
      [project.id, track],
    )?.portal_url);

    // The submission's own portal first when it exists — it is the narrowest evidence — then the
    // track's target. Both are records of the door the filing went through, not predictions.
    for (const recorded of [profileUrl, targetUrl]) {
      if (!recorded) continue;
      const usable = selectCredentialUrlsFor(recorded, rows.map((r) => r.portalUrl));
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
    // The permit fee's payee is its issuer (permitFeeProject — the project AHJ unless a cited state
    // rule issues the permits), the same agency buildPaymentQuote priced.
    jurisdiction: (track === "nem" ? project.utility : permitFeeProject(project).ahj) || "",
    ...(quote.permitFeeIssuerLabel ? { issuerLabel: quote.permitFeeIssuerLabel } : {}),
    feeUsd: quote.permitFeeUsd,
    source: quote.permitFeeSource,
    basis: quote.permitFeeBasis,
    bracketLabel: quote.permitFeeBracketLabel,
    sourceUrl: quote.permitFeeSourceUrl,
    confidence: quote.permitFeeConfidence,
    corroborated: quote.permitFeeCorroborated,
    evidenceQuote: quote.permitFeeEvidenceQuote,
    confirmable: feeLineConfirmable(quote.permitFeeSource, quote.permitFeeConfidence),
    // What the Confirm click sends back with the amount it displayed (MF2) — the rows and their
    // versions as they stand while the person is looking.
    confirmRows: feeLineConfirmable(quote.permitFeeSource, quote.permitFeeConfidence) ? feeConfirmRows(db, project, track) : [],
    verifiedBy: quote.permitFeeVerifiedBy,
    verifiedAt: quote.permitFeeVerifiedAt,
    comparison: quote.permitFeeComparison,
    portalRecords: quote.portalFeeRecords,
    paymentMethod: quote.paymentMethod,
    serviceFeeUsd: quote.serviceFeeUsd,
    totalUsd: quote.totalUsd,
    // AN ESTIMATE IS NOT KNOWLEDGE. `known: feeUsd != null` marked the
    // 1.5%-of-valuation heuristic as a known fee — measured on the live Trask /
    // City of Portland quote: $450.00, source valuation_estimate, known:true,
    // unknowns:[]. The basis SENTENCE was honest ("Rough estimate … true it
    // up") while the machine-readable flags claimed nothing was unknown, which
    // is the unknown-rendering-as-reassurance defect again. The number is kept
    // (feeUsd + confidence "estimated" — the operator quoting a customer needs
    // it); the claim of knowledge goes, and `unknowns` below names the gap.
    known: quote.permitFeeUsd != null && quote.permitFeeConfidence !== "estimated",
    charges: quote.permitFeeCharges,
  }));

  // THE AHJ'S OWN CHARGE WHERE A STATE AGENCY ISSUES THE PERMITS (issue #56): its zoning /
  // site-development review, a line of its own, summed into the total like any other line.
  const review = localPermitReview(project);
  if (review) lines.push(localReviewLine(db, project, review));

  const unknowns: string[] = [];
  const outOfPortalPayments: string[] = [];
  for (const line of lines) {
    const who = line.jurisdiction || (line.track === "nem" ? "the utility" : "the AHJ");
    const label = line.role === "local_review" ? "Zoning / site-development review fee"
      : line.track === "nem" ? "NEM / interconnection fee" : "Permit fee";
    if (line.feeUsd == null) unknowns.push(`${label} for ${who} is unknown. ${line.basis}`);
    else if (!line.known) {
      // AN ESTIMATED LINE IS AN OPEN QUESTION AND IS LISTED AS ONE — an empty
      // unknowns array beside it is the machine-readable claim that nothing is
      // unknown. "resolved" rather than "held" on purpose: it stays true both
      // when no schedule exists at all (Portland) and when one is held but
      // refused this project (an engineered job against a prescriptive-only
      // row — the basis carries that refusal's own words either way).
      const discipline = line.track === "nem" ? "interconnection" : "permit";
      // TWO DIFFERENT ESTIMATES, AND ONLY ONE OF THEM MEANS "WE FOUND NO SCHEDULE".
      //
      // The sentence below used to be the only one, and it said "no published fee schedule
      // resolved" for every estimated line. Since the valuation ladder landed, a line can be
      // estimated because the SCHEDULE was read perfectly and the VALUATION under it was
      // guessed — at which point that sentence is false, and it went on to cite the very
      // schedule it had just denied finding, in the same paragraph. `source` already tells the
      // two apart, so it decides which gap the operator is actually being sent to close.
      //
      // AND A THIRD: the schedule EVALUATED, priced its lines, and one charge on it
      // has no amount — which nulls the schedule's total, so the ladder drops to the
      // heuristic. "No published fee schedule resolved" is false there too (measured
      // on 6a1c2127: the same sheet itemised that schedule's $94 line and named the
      // unpriced battery services charge right below). The charges array is the
      // evaluator's own output, so a non-empty unpriced charge on it is proof the
      // schedule was read; the unpriced charges are named by the loop below.
      const unpricedCharges = (line.charges ?? []).filter(
        (c) => c.amountUsd == null && !c.partOfLineFee && !c.futureContingent,
      );
      unknowns.push(
        line.source === "valuation_estimate" && unpricedCharges.length
          ? `${label} for ${who} is an ESTIMATE, not a known fee — ${who}'s published fee schedule WAS read and prices `
            + `this filing's lines, but ${unpricedCharges.length === 1 ? "one charge on it is" : `${unpricedCharges.length} charges on it are`} `
            + `not priced (named below), so the schedule gives no total and the $${line.feeUsd.toFixed(2)} shown is a valuation `
            + `heuristic. Price ${unpricedCharges.length === 1 ? "that charge" : "those charges"} (or enter the portal's own fee) `
            + `and this becomes the schedule's figure. ${line.basis}`
          : line.source === "published_schedule"
          ? `${label} for ${who} is an ESTIMATE because this project carries NO JOB VALUATION. `
            + `${who}'s published schedule prices this filing off the job's valuation, so the $${line.feeUsd.toFixed(2)} `
            + `shown was computed from a per-watt guess at it rather than from a real figure. Record the job `
            + `valuation (or enter the portal's own fee) and this becomes a real number. ${line.basis}`
          : `${label} for ${who} is an ESTIMATE, not a known fee — no published fee schedule resolved for ${who} (${discipline}), `
            + `no portal figure recorded, no observed history. The $${line.feeUsd.toFixed(2)} shown is a valuation heuristic. ${line.basis}`,
      );
    }
    // A CHARGE ON THIS FILING THAT NOBODY HAS PRICED IS ITS OWN UNKNOWN, and it is
    // named separately from the line's. "Permit fee for the City of Portland is
    // unknown" sends an operator looking for a permit fee that is sitting right
    // there at $153; what is actually missing is one review, by name, with the
    // question that would settle it. Listed whichever tier won the amount — a
    // learned median or an operator-entered actual is a better answer than the
    // schedule's and still does not answer whether the fire bureau billed this job.
    for (const charge of line.charges ?? []) {
      if (charge.amountUsd != null || charge.partOfLineFee) continue;
      // A reinspection fee is not an open question, it is a price list for something that has
      // not happened. Listing it under STILL UNKNOWN sends an operator to "resolve" whether a
      // filing they have not made yet failed an inspection. It stays visible on the charge
      // breakdown with its own wording — see FeeChargeBreakdown.futureContingent.
      if (charge.futureContingent) continue;
      // THE BATTERY'S SERVICES/FEEDERS LINE IS NOT AN OPEN QUESTION ONCE THE PORTAL'S
      // OWN TOTAL IS ENTERED. Unlike a conditional review (did the fire bureau bill
      // this job?), this line is not conditional — the operator rule says a battery
      // on the electrical permit bills it — and the only thing missing was its
      // AMOUNT. An operator-entered actual is the portal's computed total, which
      // already contains it; "the total stays UNRESOLVED" beside a known total is
      // the sheet contradicting itself (the no-schedule battery note below already
      // stops at an actual — one question, one answer). Kind-specific on purpose:
      // every other unpriced charge keeps its unknown under an actual.
      // (Every service line — the battery's, a service upgrade's in either tier — is the same
      // kind of question: owed, only its amount missing.)
      if (isServiceLineBaseKind(charge.kind) && isPortalFigure(line.source)) continue;
      unknowns.push(`${who} also charges "${charge.label}" on this filing, and it is not priced. ${charge.reason}`);
    }
    // A BATTERY JOB'S SERVICES/FEEDERS <=200A LINE, WHEN NO SCHEDULE ITEMISED IT.
    //
    // Operator rule 2026-09-24 (batteryServiceFeeder.ts): a battery on the electrical
    // permit bills one "Services or feeders: 200 amps or less" line. The evaluator
    // carries it on the electrical line whenever a schedule EVALUATES — priced, or
    // unpriced with its own reason, and then it is named by the loop above. What it
    // cannot carry is a line for a schedule that did not evaluate at all (no schedule
    // on file, a basis a human has to read, a dangling hop): the permit amount is
    // already an estimate or unknown there, and without this sentence nothing on the
    // sheet would tell the person reading the schedule by hand to add the line.
    // Every permit project files an electrical permit (submittalTracks.requiredTracks
    // adds "combo" or "building"+"electrical"), so the permit billing track always
    // includes the filing this rule is about. An operator-entered actual is the
    // portal's own total and already contains it.
    // A SERVICE UPGRADE is the same shape (live Corvallis 2026-09-28): the plan set's own
    // upgrade is a services line on the electrical permit, counted by the ONE count
    // (batteryServiceFeeder.serviceLineCounts) the portal boxes and the PDF read.
    const svcLines = serviceLineCounts(project.parserSnapshot as Record<string, unknown> | null | undefined);
    const itemised = (line.charges ?? []).some((c) => isServiceLineBaseKind(c.kind));
    if (line.track === "permit" && line.role !== "local_review" && !isPortalFigure(line.source) && !itemised) {
      if (svcLines.battery) {
        unknowns.push(
          `Battery/ESS job: the electrical permit for ${who} also bills one "${SERVICE_FEEDER_200A_LABEL}" line `
          + `(operator rule 2026-09-24), and no published schedule on file itemises it for this project — `
          + `the permit amount shown does not include it. Add it from the jurisdiction's electrical fee schedule, `
          + `or enter the portal's own fee.`,
        );
      }
      if (svcLines.upgrade) {
        const tier = svcLines.upgradeAmps == null ? "a services/feeders line in the tier of the new service (its size is not on file)"
          : svcLines.upgradeAmps <= 200 ? `one "${SERVICE_FEEDER_200A_LABEL}" line`
          : svcLines.upgradeAmps <= 400 ? `one "${SERVICE_FEEDER_400A_LABEL}" line`
          : `a services/feeders line for a ${svcLines.upgradeAmps} A service`;
        unknowns.push(
          `Service upgrade job: the electrical permit for ${who} also bills ${tier} for the plan set's service upgrade, `
          + `and no published schedule on file itemises it for this project — the permit amount shown does not include it. `
          + `Add it from the jurisdiction's electrical fee schedule, or enter the portal's own fee.`,
        );
      }
    }
    if (line.paymentMethod === "mailed_check") {
      outOfPortalPayments.push(
        `${label} for ${who}${line.feeUsd != null ? ` ($${line.feeUsd.toFixed(2)})` : ""} is paid by MAILED CHECK — no portal can take it, so a human sends it.`,
      );
    }
  }

  // A total is reported only when EVERY component carries a NUMBER — estimates
  // included, because "what will this cost" deserves the best current answer.
  // A line with no number at all still nulls the total rather than quietly
  // summing as a zero. (This gate used to read `line.known`; `known` was true
  // for estimates then, so the arithmetic here is unchanged — only the flags
  // moved, and totalConfidence below is how a summed estimate now says so.)
  const allPriced = lines.every((line) => line.feeUsd != null);
  const jurisdictionFeesUsd = allPriced ? round2(lines.reduce((sum, line) => sum + (line.feeUsd ?? 0), 0)) : null;
  // The service fee is charged per SUBMISSION, so a project filing both tracks
  // carries two — and none at all when the client is not billed per submission.
  const serviceFeesUsd = billingRequired ? round2(lines.reduce((sum, line) => sum + line.serviceFeeUsd, 0)) : 0;

  // THE TOTAL IS ONLY AS GOOD AS ITS SHAKIEST LINE. A $785 that is $335 of
  // published schedule plus $450 of 1.5%-guess presenting as flat fact is the
  // per-line lie one level up, so the total carries the weakest grade of
  // anything summed into it — on the vocabulary the lines already speak.
  const worstConfidence = (): FeeConfidence => {
    let worst: FeeConfidence = "actual";
    for (const line of lines) {
      if (FEE_CONFIDENCE_RANK[line.confidence] < FEE_CONFIDENCE_RANK[worst]) worst = line.confidence;
    }
    return worst;
  };

  return {
    projectId: project.id,
    billingMode,
    billingRequired,
    lines,
    jurisdictionFeesUsd,
    serviceFeesUsd,
    totalUsd: jurisdictionFeesUsd == null ? null : round2(jurisdictionFeesUsd + serviceFeesUsd),
    totalConfidence: allPriced ? worstConfidence() : "unknown",
    unknowns,
    outOfPortalPayments,
    generatedAt: nowIso(),
  };
}

/** THE LOCAL ZONING / SITE-DEVELOPMENT REVIEW LINE (issue #56). Read off the AHJ's OWN key (an
 *  EXACT undifferentiated row there is its review fee: it issues no permit here), never re-keyed to the
 *  state issuer. Only a published schedule prices it — never the valuation heuristic, which models a
 *  building permit, not a site-plan review — so with none on file the line has no number and the
 *  sheet's total says unknown. Not confirmable here: a Confirm keys on the billing track, whose
 *  permit row is the state issuer's. No service fee: it is not a submission this tool files. */
function localReviewLine(db: AppDb, project: ProjectRecord, review: { ahj: string; issuer: string }): ProjectFeeSheetLine {
  const at = { ...project, ahj: review.ahj } as ProjectRecord;
  // EXACTLY the undifferentiated row under the AHJ's key (localReviewFeeForProject) — never the
  // general lookup, whose "only row under the key" fallback would print a legacy building-permit
  // row researched under the village as its review fee.
  let s: ScheduleFee | null = null;
  try { s = normalizeScheduleResult(localReviewLookup()?.(db, at, "permit")); } catch { s = null; }
  const priced = s != null && s.feeUsd != null;
  const confidence: FeeConfidence = priced ? (s!.valuationEstimated ? "estimated" : s!.confidence) : "unknown";
  return {
    track: "permit",
    role: "local_review",
    jurisdiction: review.ahj,
    issuerLabel: `Local zoning / site-development review — ${review.ahj} (before ${review.issuer}'s permits)`,
    feeUsd: priced ? s!.feeUsd : null,
    source: priced ? "published_schedule" : "unknown",
    basis: priced
      ? `${review.ahj}'s own zoning / site-development review fee, read off its published schedule${s!.bracketLabel ? ` ("${s!.bracketLabel}")` : ""}`
        + `${s!.confidence === "verified" ? "." : " — researched, not yet checked by a person."} ${review.issuer} issues the building and electrical permits; this is ${review.ahj}'s separate charge.`
      : `No published zoning / site-development review fee on file for ${review.ahj} yet${s?.reason ? ` (${s.reason})` : ""}. `
        + `${review.ahj} issues no building or electrical permit here — ${review.issuer} does — but it reviews the site plan first and may charge for it. `
        + `Ask ${review.ahj}'s planning office for the fee.`,
    bracketLabel: priced ? s!.bracketLabel : null,
    sourceUrl: s?.sourceUrl ?? null,
    confidence,
    corroborated: false,
    evidenceQuote: priced && s!.evidenceVerdict !== "other_permit" ? s!.bracketQuote : "",
    confirmable: false,
    confirmRows: [],
    verifiedBy: "",
    verifiedAt: "",
    comparison: null,
    portalRecords: null,
    paymentMethod: s?.paymentMethod ?? "unknown",
    serviceFeeUsd: 0,
    totalUsd: priced ? s!.feeUsd : null,
    known: priced && confidence !== "estimated",
    charges: s?.charges ?? [],
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
