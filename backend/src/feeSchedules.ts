// ---------------------------------------------------------------------------
// FEE SCHEDULES — the schedule a fee came from, not just the fee.
//
// submissionFees.ts already resolves a DOLLAR AMOUNT for a submission, best
// source first: actual > learned_history > valuation_estimate > unknown. That
// ladder answers "what will this cost?" and nothing else. It cannot answer the
// question an AHJ application actually asks.
//
// Coos Bay's Accela recipe carries the frozen answer
//     "Renewable energy for electrical systems- 5.01kva through 15kva = 1"
// — a fee BRACKET QUANTITY, learned once from a learn project and replayed ever
// after. A 20 kW job replays into the 5.01–15 kVA bracket and is billed in the
// wrong tier, on a field that looks perfectly answered. No total, however
// accurate, fixes that: the bracket is a different fact than the price.
//
// So this module stores the schedule as a FUNCTION of something. `basis` names
// the variable the jurisdiction keys on (system kVA/kW, job valuation, or a flat
// charge); the brackets are the ordered table; feeForProject evaluates it for a
// specific project and returns BOTH the dollar amount and the bracket label the
// application needs.
//
// Two rules this module exists to keep:
//   - A fee with no quotable sentence behind it is a rumour. Research that
//     cannot produce a source URL *and* the sentence the number came from is
//     refused, not stored (hard safety: a rumour in a fee field is
//     indistinguishable from a fact).
//   - Research lands 'seeded' and NEVER auto-verifies (hard rule 3). Against a
//     human-'verified' row a research pass REFUSES to change anything and
//     appends its finding to notes, so the disagreement is visible instead of
//     the row quietly moving under the person who verified it.
//
// "No fee" is a FINDING, not a gap: a sourced flat $0 (most residential NEM) is
// stored as a real schedule. found:false means we could not find out. The two
// must never collapse into each other — that is exactly the conflation the
// quote ladder's "unknown" already suffers.
//
// NOTE ON TYPES: these live here rather than in shared/src/types.ts because
// nothing outside the backend consumes them yet. They move to the shared
// surface when the API/dashboard build lands.
// ---------------------------------------------------------------------------

import Anthropic from "@anthropic-ai/sdk";
import { performance } from "node:perf_hooks";
import type { AppDb } from "./db";
import type { FeeChargeBreakdown, FeePaymentMethod, PaidFeeReceipt, ProjectRecord } from "../../shared/src/types";
// ONE READER FOR "Revised 12/23/2022", shared with ahj_form_templates' own
// document_date column. A second parser here would eventually disagree with the
// column it is meant to explain, and a wrong date makes a stale schedule look
// current — strictly worse than no date at all.
import { isoForDocumentDate } from "./documentDate";
import { fetchPublicDocument } from "./documentFetch";
import type { FetchPublicDocumentOptions } from "./documentFetch";
import { DEFAULT_FEE_KEYWORDS, groupItemsIntoRows, extractPdfTextItems } from "./pdfTables";
import type { PdfTextRow } from "./pdfTables";
import { knowledgeNameMatchScore, knowledgeProfileKey, knowledgeResearchHint } from "./knowledgeBase";
// THE track→discipline MAPPING IS NOT COPIED HERE, IT IS IMPORTED. portalChannel
// is a leaf module with no imports of its own, so there is no cycle — and a
// second copy of this mapping is precisely how "the concept lived in two places
// and the copies disagreed" has bitten this codebase before.
import { recipeDisciplineForTrack } from "./portalChannel";
// THE PERMIT PATH IS AN INPUT TO THE FEE, NOT JUST TO THE DOCUMENTS. permitPath.ts
// imports nothing but the shared types, so there is no cycle — and it is the only
// safe home for the classifier, because the module that already owns the
// prescriptive/engineered vocabulary on the DOCUMENT side (ahjForms.ts) imports
// THIS file. See pathWordingScope's header for the full argument.
import { resolvePermitPath, pathWordingScope, pathWordingContradicts } from "./permitPath";
import type { PermitPath, PermitPathInputs } from "./permitPath";
import { resolveValuation } from "./valuation";
import {
  batteryStatus, feeFilingIsElectrical, isServiceFeeder200Label,
  SERVICE_FEEDER_200A_LABEL, SERVICE_FEEDER_CHARGE_KIND,
  SERVICE_FEEDER_COMMUNITY_SURCHARGE_KIND, SERVICE_FEEDER_STATE_SURCHARGE_KIND,
} from "./batteryServiceFeeder";
// recordLlmCall, NOT a new accounting log. The fee researcher is the single most
// expensive model operation in this system — up to twelve Opus turns with web
// search and ten document retrievals, per jurisdiction — and it was the only one
// invisible to the call log, because it is self-contained rather than routed
// through LLMProvider. "Invisible and expensive" is the pair that makes a cost
// regression unfindable, so every turn now files the same record instrument()
// files, under a label that names the jurisdiction.
import { recordLlmCall, sanitizeApiKey } from "./llm";
import { logger } from "./logger";
import { agencyKind } from "./recipeReplayBinding";
import { id } from "./ids";
import { text } from "./json";
import { nowIso } from "./time";

type Row = Record<string, unknown>;

export type FeeTrack = "permit" | "nem";
export type FeeBasis = "system_kw" | "valuation" | "flat" | "other";
export type FeeConfidence = "seeded" | "verified";

/** IS THIS ROW AN ANSWER, OR AN OPEN QUESTION?
 *
 *  A dimension of its own, and deliberately NOT a third `confidence` value.
 *  Confidence says who vouches for the row — research ('seeded') or a person
 *  ('verified', hard rule 3). A conflict says something else entirely: that two
 *  published documents for this jurisdiction disagree about the same bracket.
 *  Those are orthogonal. A human-verified row can be conflicted (somebody
 *  verified that we hold two numbers and has not yet picked), and it must still
 *  refuse to price a job — so folding 'conflicted' into confidence would have
 *  made the refusal depend on nobody ever verifying it. */
export type FeeScheduleStatus = "ok" | "conflicted";

/** THE MARKER, AND WHY IT LIVES HERE.
 *
 *  jurisdictionHarvest.ts writes it into notes and re-exports it, but the
 *  constant belongs to the module that REFUSES, not to the module that
 *  detected: the evaluator's refusal reason carries it, and submissionFees.ts
 *  recognises it at the quote seam. Harvest imports feeSchedules (never the
 *  other way round), so the one definition has to be on this side of that edge.
 *  It carries NO " | " of its own — fee/KB notes are " | "-joined SEGMENTS and a
 *  marker containing the separator would be shredded by mergeNotes. */
export const FEE_CONFLICT_MARKER = "UNRESOLVED FEE CONFLICT";

/** One line of a published schedule. Which pair of bounds is populated follows
 *  the schedule's `basis`; a flat schedule carries one bracket with neither. A
 *  null/absent upper bound means "and above" (the open last row). */
export interface FeeBracket {
  /** Derived from an unconditional state-surcharge statement in the same
   * retrieved document as this bracket. Never accepted from model output. */
  stateSurcharge?: { percent: number; quote: string; sourceUrl: string };
  communitySurcharge?: { percent: number; quote: string; sourceUrl: string };
  minKw?: number | null;
  maxKw?: number | null;
  minValuationUsd?: number | null;
  maxValuationUsd?: number | null;
  feeUsd: number;
  /** The jurisdiction's OWN wording for this line — this is what the permit
   *  application's fee-quantity field is asking for, verbatim where possible. */
  label?: string;
  /** Set ONLY by corroborateBrackets, from bytes this process retrieved. Neither
   *  a model nor a JSON file replayed by a script can put it here: it survives
   *  into storage only when saveFeeSchedule was handed the ledger to re-derive
   *  it from — see normalizeBrackets' `trusted` flag. */
  corroboration?: FeeBracketCorroboration;
  /** THE REST OF THE BILL — every charge the jurisdiction levies on this filing
   *  BESIDES the permit line this bracket prices. Written ONLY by
   *  corroborateAncillaryCharges, from bytes this process retrieved, and stripped
   *  on the untrusted read path exactly as `corroboration` is.
   *
   *  It rides the BRACKET rather than the record because that is where the
   *  surcharges already ride and because brackets_json is the one structured
   *  column a schedule owns — the same list is attached to every bracket of a
   *  table, since these charges are levied on the FILING, not on one size tier. */
  ancillaryCharges?: FeeAncillaryCharge[];
}

/** ONE MORE CHARGE ON THE SAME FILING — a plan review, a land-use review, a fire
 *  review, a processing fee, a surcharge.
 *
 *  WHY THIS EXISTS. The researcher's ask used to be "find the permit fee line",
 *  and the researcher answered it faithfully: one line. A real paid City of
 *  Portland receipt for one 3.5 kW rooftop system is FOUR BILLS FROM THREE
 *  BUREAUS totalling $762.93, of which the two permit lines are $354. Everything
 *  else — fire plan review, land use review, building plan review/processing,
 *  and the 12% state surcharge on each permit — was never asked for, so it was
 *  never held, so no quote built from this table could reach a real total.
 *
 *  A PERCENTAGE IS STORED AS A PERCENTAGE. The receipt's $99.45 is 65% of the
 *  $153.00 building permit; storing the product would make the charge wrong for
 *  every other job. `percent` + `percentOf` keeps it a function, exactly as
 *  `basis` keeps the permit line one. */
export interface FeeAncillaryCharge {
  /** The jurisdiction's OWN printed wording — "Bldg Plan Rvw/Processing RS/MI/MP".
   *  This is the matching key AND what an operator reads beside the amount. */
  label: string;
  kind: FeeAncillaryKind;
  /** Exactly one of these two is populated; the normaliser refuses a charge
   *  carrying both or neither. */
  amountUsd?: number;
  percent?: number;
  /** What the percentage is taken OF, in the document's own words ("of the
   *  building permit fee"). "" on a flat charge. */
  percentOf: string;
  /** THE HONEST HALF. A charge the schedule applies only in some cases may not
   *  be silently added to anybody's total — see the evaluator's existing refusal
   *  to resolve a total when a known plan-review trigger is unpriced. */
  conditional: boolean;
  condition: string;
  /** Which filing it rides. "" = the filing as a whole. Portland's fire and
   *  land-use reviews ride the BUILDING filing; the electrical pass must not
   *  fold them into the electrical permit. */
  appliesTo: FeeDiscipline;
  /** The sentence the model reported, verbatim. Advisory prose. */
  quote: string;
  /** The document actually fetched, as the fetcher finally saw it. */
  sourceUrl: string;
  /** THE EVIDENCE, and the reason this type can be stored at all: the printed
   *  row THIS RUN retrieved where the label and the amount (or the percentage)
   *  co-occur. Required by the normaliser, so a charge nothing we read supports
   *  cannot reach storage down any path. */
  matchedLine: string;
}

/** What kind of charge, for the operator's eye and for a later evaluator that
 *  will want to treat a mandatory surcharge differently from an optional review. */
export const ANCILLARY_KINDS = ["plan_review", "land_use_review", "fire_review", "processing", "surcharge", "other"] as const;
export type FeeAncillaryKind = (typeof ANCILLARY_KINDS)[number];
/** One filing does not draw fifty charges. A longer list is a model listing a
 *  whole fee schedule rather than the charges on THIS filing. */
const ANCILLARY_CHARGE_CAP = 12;

/** DID THE DOCUMENT ACTUALLY PRINT THIS BRACKET? — a dimension of its own.
 *
 *  Deliberately NOT a third `FeeConfidence` value, for exactly the reason
 *  FeeScheduleStatus is not one either (see above). Confidence says WHO vouches
 *  for the row: research ('seeded') or a person ('verified', hard rule 3).
 *  Corroboration says something orthogonal and much narrower: that a machine
 *  went back to the cited document, found the printed line where this bracket's
 *  LABEL and its FEE sit together, and kept that line verbatim. Code may write
 *  this; code may NEVER write 'verified'. The operator-facing word for it is
 *  CORROBORATED, never "verified" — a machine reading a PDF is not a person
 *  taking responsibility for a number.
 *
 *  It lives per BRACKET rather than per document because that is the grain of
 *  the claim. FeeResearchEvidence already answers "what did we open"; this
 *  answers "was THIS row in it", and a schedule has N rows and one document.
 *  Stored inside brackets_json, so no migration and so a bracket can never be
 *  separated from the line that supports it. */
export interface FeeBracketCorroboration {
  corroborated: boolean;
  /** The coordinate-paired printed row, verbatim, where the label and the fee
   *  CO-OCCUR. This — not the row-level sourceQuote — is the sentence that may
   *  be shown beside this bracket's amount. */
  matchedLine: string;
  /** The document actually fetched and read, as the fetcher finally saw it. */
  sourceUrl: string;
  checkedAt: string;
  via: "http" | "browser";
}

/** ONE DOCUMENT'S OWN ACCOUNT OF THIS SCHEDULE — kept per source, not flattened.
 *
 *  A conflicted row used to be stored as both candidates' brackets in ONE list
 *  with "[S1]"/"[S2]" glued onto each label, because the table had nowhere else
 *  to put them. That loses exactly the thing that resolves a conflict: which
 *  document said what, and how old each document says it is. Coos County's
 *  dispute ($79/$94/$156 against $135/$160/$265) is settled the moment you can
 *  see that the first list comes off a form stamped "Revised 12/23/2022" and the
 *  second off a schedule stamped "Effective 7-1-25" — and until v23 that fact
 *  survived only as prose in notes. */
export interface FeeScheduleSource {
  /** Short tag as it appears in the notes trail and the refusal reason: S0, S1… */
  tag: string;
  /** Human name of the document/authority this reading came from. */
  name: string;
  sourceUrl: string;
  sourceQuote: string;
  /** The document's own words about its currency — "Revised 12/23/2022",
   *  "Effective 7-1-25" — verbatim, never normalised. "" when it never said.
   *  Same convention (and same reader) as ahj_form_templates.document_date. */
  documentDate: string;
  /** The comparable date inside that phrase, derived by documentDate.ts's single
   *  parser so there is never a second reader to drift away from the column. */
  documentDateIso: string;
  /** What THIS document printed, before anything was merged or tagged. */
  brackets: FeeBracket[];
}

export interface FeeScheduleRecord {
  id: string;
  profileKey: string;
  state: string;
  ahj: string;
  utility: string;
  track: FeeTrack;
  /** Which permit this row is the fee for — see FeeDiscipline. */
  discipline: FeeDiscipline;
  /** THE HOP, and it is data rather than inference on purpose. Non-empty means
   *  this row does not publish a fee: the authority named by this profile key
   *  does. A City of Coos Bay address files its ELECTRICAL permit with Coos
   *  County, and the only safe way to say so is to have somebody record it with
   *  a source — matching "City of Coos Bay" onto "Coos County" by name
   *  similarity is the wrong-authority filing bug rebuilt as lookup code. */
  collectedByProfileKey: string;
  basis: FeeBasis;
  brackets: FeeBracket[];
  /** 'conflicted' = two sources disagree and this row must not price anything.
   *  Read by evaluateSchedule BEFORE any basis branch — see the comment there. */
  status: FeeScheduleStatus;
  /** What the document behind this row says about its own currency, verbatim.
   *  "" when it never said. The currency comparison is what settles a conflict,
   *  and before this column it survived only as prose in `notes`. */
  documentDate: string;
  /** Derived from documentDate, never stored twice. */
  documentDateIso: string;
  /** Every source behind this row — one for an ordinary schedule, two or more
   *  for a conflicted one, each with its own brackets and its own date. */
  sources: FeeScheduleSource[];
  notes: string;
  /** HOW the money moves. 'mailed_check' is the load-bearing one: it says no portal
   *  can take this fee and a person has to post it (Ameren Illinois' $50 Level 1).
   *  Exactly submissionFees.ts's four values — anything else it silently drops. */
  paymentMethod: FeePaymentMethod;
  sourceUrl: string;
  sourceQuote: string;
  /** 'official' = the jurisdiction's/utility's own domain; 'third_party' = a
   *  summary site, acceptable only when labelled as such. */
  sourceKind: string;
  confidence: FeeConfidence;
  firstSeenAt: string;
  updatedAt: string;
  verifiedAt: string;
  verifiedBy: string;
}

/** What a researcher reports back. `found:false` carries a reason so a caller
 *  can tell "this jurisdiction charges nothing" from "we could not find out". */
export interface FeeScheduleFinding {
  found: boolean;
  reason: string;
  basis: FeeBasis;
  brackets: FeeBracket[];
  notes: string;
  sourceUrl: string;
  sourceQuote: string;
  sourceKind: string;
  /** How the jurisdiction takes the money. Optional so every existing caller
   *  (imports, seed scripts, tests) keeps compiling; absent reads as "unknown". */
  paymentMethod?: string;
  /** Which permit this finding priced. Absent reads as "" — undifferentiated,
   *  which is what every pre-existing caller means. */
  discipline?: string;
  /** 'conflicted' says this finding is not a price at all: it is the RECORD OF A
   *  DISAGREEMENT between the sources below, and the row it writes must refuse
   *  to answer. Absent reads as 'ok', which is what every pre-existing caller
   *  means — a finding is normally somebody's answer. */
  status?: FeeScheduleStatus;
  /** The document's own currency phrase, verbatim ("Revised 12/23/2022"). */
  documentDate?: string;
  /** Each document's own reading, unmerged. Absent means "one source, this
   *  finding" and saveFeeSchedule synthesises that entry rather than storing an
   *  empty list — a row whose sources are blank cannot explain itself. */
  sources?: FeeScheduleSource[];
  /** A PERSON HAS READ BOTH CANDIDATES AND PICKED ONE.
   *
   *  Without this, the only way past a conflicted row is refusal — including for
   *  the automated research pass, which is the whole point: a conflict is a
   *  question asked OF a human, and a later pass that happens to return one of
   *  the two numbers must not be allowed to answer it by overwriting. Set it
   *  only where a human gesture actually happened (see
   *  scripts/apply-fee-findings.ts --resolve-conflicts). */
  resolvesConflict?: boolean;
  /** Set INSTEAD of brackets to record that another authority publishes this
   *  fee (see FeeScheduleRecord.collectedByProfileKey). A delegation still needs
   *  its URL and its quoted sentence: "somebody else charges this" is a claim
   *  about the world and gets sourced like any other. */
  collectedByProfileKey?: string;
  /** RETRIEVAL PROVENANCE — set only by a researcher that fetched the document
   *  itself. `quoteVerified` means the stored sentence was found, character for
   *  character, in bytes this process retrieved: the difference between a quote
   *  and a paraphrase of a search result. Never a gate (a finding sourced from
   *  web search alone cannot be checked this way); always reported. */
  evidence?: FeeResearchEvidence[];
  quoteVerified?: boolean;
  /** True when the plain HTTP rung was refused and a real window got through. */
  neededBrowser?: boolean;
}

/** One document the researcher actually retrieved, and how. */
export interface FeeResearchEvidence {
  url: string;
  via: "http" | "browser";
  status: number;
  kind: "html" | "pdf" | "other";
  bytes: number;
  /** Rows/characters handed to the model from this document. */
  handed: number;
}

export interface FeeScheduleResearchInput {
  state: string;
  ahj?: string;
  utility?: string;
  track: FeeTrack;
  /** WHICH PERMIT the research is for ("structural" | "electrical" | "combo").
   *  ""/absent = undifferentiated — research whatever the jurisdiction publishes.
   *  Carried so a split jurisdiction's electrical pass asks for the electrical
   *  line (not whichever table a search happens to surface first), and so the
   *  row that lands carries the discipline the project actually files — an
   *  undifferentiated row SHADOWS split rows at lookup (applicableSchedules),
   *  which is the measured Ivy $335→$200 under-quote. */
  discipline?: string;
  /** What the KB already knows about this jurisdiction/utility — several of the
   *  permit_utility_knowledge rows already carry the AHJ's own fee-page URL. */
  knownContext?: string;
}

/** The optional second argument is the RETRIEVAL LEDGER: pass one in and the
 *  researcher records every document it opened into it, so a caller (a harvest
 *  script, a report) can see what was actually read rather than taking the
 *  finding's word for it. Optional so an injected test researcher stays a
 *  one-argument function. */
export type FeeScheduleResearcher = (
  input: FeeScheduleResearchInput,
  options?: { ledger?: FeeDocumentLedger },
) => Promise<FeeScheduleFinding>;

export interface FeeScheduleResearchOutcome {
  found: boolean;
  reason: string;
  saved: boolean;
  /** True when a human-verified row blocked the write (its finding went to notes). */
  refusedVerified: boolean;
  /** True when an UNRESOLVED CONFLICT on the stored row blocked the write. A
   *  distinct flag rather than a shade of `refused`, because the repair is
   *  distinct: a person reads the two candidates and picks, they do not go
   *  looking for a better source. */
  refusedConflicted: boolean;
  profileKey: string;
  track: FeeTrack;
  /** The row as it stands AFTER the pass — unchanged when refusedVerified. */
  schedule: FeeScheduleRecord | null;
  /** What research actually said, saved or not. */
  finding: FeeScheduleFinding | null;
}

export interface ProjectFeeResolution {
  /** null when a schedule exists but cannot be evaluated for this project. */
  feeUsd: number | null;
  /** True when any line in this total was computed from a per-watt ESTIMATED valuation. The
   *  quote seam degrades such a total to "estimated", which is what puts the ≈ and the
   *  true-it-up banner on it — a computed-to-the-cent figure resting on a guess must not print
   *  in the same ink as one read off a table. */
  valuationEstimated?: boolean;
  /** The schedule line's own wording — what the application's fee field wants. */
  bracketLabel: string;
  basis: FeeBasis;
  paymentMethod: FeePaymentMethod;
  sourceUrl: string;
  /** THE ROW'S CITATION — where the TABLE came from. Row grain, so it supports
   *  at most one of N brackets and contradicts the rest. NOT evidence for the
   *  amount above it: read `bracketQuote` for that. Kept row-grain because
   *  submissionFees.ts reads it with MAILED_CHECK_RE as a last-resort signal
   *  about how the money moves, which is a fact about the schedule, not the
   *  bracket. */
  sourceQuote: string;
  /** THE EVIDENCE FOR *THIS AMOUNT*, verbatim, and the only quote that may be
   *  shown beside it. "" when the total is made of more than one permit: no
   *  single published line supports a sum that no document anywhere prints. */
  bracketQuote: string;
  /** True only when EVERY line was found printed — label and fee on one row — in
   *  the cited document. Never a promotion: confidence stays 'seeded'. */
  corroborated: boolean;
  confidence: FeeConfidence;
  /** The AHJ/utility name the schedule is filed under (may differ from the
   *  project's spelling when the fuzzy fallback matched). */
  matchedName: string;
  scheduleId: string;
  /** Populated when feeUsd is null: why the schedule did not evaluate. */
  reason: string;
  /** EVERY permit this project owes, itemised. One entry for an ordinary
   *  jurisdiction; two where the city takes the structural permit and the county
   *  takes the electrical one. feeUsd above is their TOTAL, which is what the
   *  customer pays — read `lines` to show them what it is made of. */
  lines: FeeScheduleLine[];
  /** EVERY CHARGE ON THIS FILING, PRICED — permits, their surcharges, and the
   *  reviews and processing charges levied beside them. `feeUsd` above is the
   *  sum of the charges whose `partOfLineFee` is false PLUS every line's own
   *  amount; see FeeChargeBreakdown for why the flag is arithmetic and not a
   *  display hint. A charge carrying `amountUsd: null` is what makes `feeUsd`
   *  null: a filing missing one of its charges is not a smaller filing. */
  charges: FeeChargeBreakdown[];
}

/** One permit, one authority, one number. */
export interface FeeScheduleLine {
  baseFeeUsd?: number;
  stateSurchargeUsd?: number;
  communitySurchargeUsd?: number;
  discipline: FeeDiscipline;
  /** Who publishes and collects THIS line — the county on a hopped electrical
   *  row, even though the project's AHJ is the city. */
  authority: string;
  /** Non-empty when the line was reached by a delegation: the AHJ the project
   *  is filed under, which does not itself charge this fee. */
  hoppedFrom: string;
  feeUsd: number | null;
  bracketLabel: string;
  basis: FeeBasis;
  paymentMethod: FeePaymentMethod;
  sourceUrl: string;
  /** The ROW's citation (see ProjectFeeResolution.sourceQuote) — provenance of
   *  the table, not evidence for this line's amount. */
  sourceQuote: string;
  /** THE EVIDENCE FOR THIS LINE'S AMOUNT: the corroborated printed row where
   *  possible, else the bracket's own verbatim label, else "". This is what
   *  belongs beside the number; the row's sourceQuote is not. */
  bracketQuote: string;
  /** Present only when this bracket was found printed in the cited document. */
  corroboration?: FeeBracketCorroboration;
  confidence: FeeConfidence;
  /** True when this amount was computed from a per-watt ESTIMATED valuation rather than a
   *  contract figure. The schedule can be perfect and the answer still a guess. */
  valuationEstimated?: boolean;
  notes: string;
  scheduleId: string;
  /** Populated when feeUsd is null. */
  reason: string;
  /** THIS LINE'S OWN BILL, ITEMISED — the permit, its surcharges, and every
   *  ancillary charge this schedule attaches to the filing. The first three
   *  carry `partOfLineFee: true` and are already inside `feeUsd`; the ancillary
   *  ones are not, and are added at the resolution above. */
  charges: FeeChargeBreakdown[];
}

const NOTE_SEGMENT_CAP = 40;
const round2 = (n: number): number => Math.round(n * 100) / 100;

export function knownElectricalReviewRequired(snapshot: Record<string, unknown> | undefined): boolean {
  return /^(?:yes|true)$/i.test(String(snapshot?.electricalPlanReviewRequired ?? '')) || Number(snapshot?.buildingStories) > 3;
}

function clean(value: unknown): string {
  return text(value).replace(/\s+/g, " ").trim();
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** KB notes are " | "-joined SEGMENTS; merge and dedupe by segment, never as one
 *  blob (the runaway-notes bug). Same convention as knowledgeBase.noteSegments. */
function noteSegments(value: unknown): string[] {
  return clean(value).split(" | ").map((s) => s.trim()).filter(Boolean);
}

function mergeNotes(existing: unknown, incoming: string[]): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const seg of [...noteSegments(existing), ...incoming].map(clean).filter(Boolean)) {
    const key = seg.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(seg);
    if (out.length >= NOTE_SEGMENT_CAP) break;
  }
  return out.join(" | ");
}

export function feeTrack(track?: string | null): FeeTrack {
  return String(track || "").toLowerCase() === "nem" ? "nem" : "permit";
}

/** WHICH PERMIT, not which jurisdiction. One rooftop in Coos Bay draws TWO
 *  permit fees — the city's structural ($200) and the county's electrical
 *  ($160) — and before this dimension existed the table could hold only one of
 *  them, so the fee sheet quoted $200 and was 44% short.
 *
 *  These are portal_recipes' OWN discipline values, not a parallel vocabulary:
 *  portalChannel.recipeDisciplineForTrack maps a submittal track onto exactly
 *  this set, so the fee for a stage and the recipe that files it are keyed
 *  alike. "" means undifferentiated — the NEM track, and every permit row
 *  recorded before the distinction was drawn. */
export type FeeDiscipline = "" | "structural" | "electrical" | "combo";

export function feeDiscipline(value?: string | null): FeeDiscipline {
  const v = clean(value).toLowerCase();
  return v === "structural" || v === "electrical" || v === "combo" ? v : "";
}

/** submissionFees.ts whitelists EXACTLY these four and silently drops anything
 *  else, so a schedule that said "check" or "by mail" would arrive at the fee
 *  sheet as no answer at all. Normalise here, at the point the value is stored,
 *  rather than hoping the producer used the enum. */
export function normalizeFeePaymentMethod(value: unknown): FeePaymentMethod {
  const v = clean(value).toLowerCase().replace(/[\s\-/]+/g, "_");
  if (!v) return "unknown";
  if (/check|cheque|mail|post|money_order/.test(v)) return "mailed_check";
  if (/portal|online|website|web|card|credit|e_?pay|checkout/.test(v)) return "portal";
  if (/^(none|no_fee|no_charge|free|not_applicable|n_a|nothing)$/.test(v)) return "none";
  return "unknown";
}

/** Profile key at permit_utility_knowledge's OWN grain, which is two grains and
 *  not three: a permit schedule belongs to (state, AHJ) and an interconnection
 *  schedule to (state, utility). Keying on all three would file the same city's
 *  permit fee separately per utility and miss on every lookup. */
export function feeScheduleProfileKey(input: { state?: string; ahj?: string; utility?: string }, track: FeeTrack): string {
  return track === "nem"
    ? knowledgeProfileKey({ state: input.state, ahj: "", utility: input.utility })
    : knowledgeProfileKey({ state: input.state, ahj: input.ahj, utility: "" });
}

function parseBrackets(raw: unknown): FeeBracket[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text(raw) || "[]"); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  // THE DB-READ PATH IS TRUSTED because only this module ever wrote it, and only
  // through corroborateBrackets. Dropping corroboration here would quietly
  // un-corroborate every row on the next read.
  return normalizeBrackets(parsed, { trusted: true });
}

/** A corroboration claim, read through a whitelist. `corroborated: true` with no
 *  matched line and no URL is not a claim anybody can check, so it is discarded
 *  rather than stored — the same rule the module already applies to a fee with
 *  no quote. */
function normalizeCorroboration(raw: unknown): FeeBracketCorroboration | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  if (c.corroborated !== true) return undefined;
  const matchedLine = clean(c.matchedLine).slice(0, 300);
  const sourceUrl = clean(c.sourceUrl).slice(0, 500);
  if (!matchedLine || !sourceUrl) return undefined;
  return {
    corroborated: true,
    matchedLine,
    sourceUrl,
    checkedAt: clean(c.checkedAt).slice(0, 40),
    via: clean(c.via).toLowerCase() === "browser" ? "browser" : "http",
  };
}

/** THE STORAGE BOUNDARY FOR AN ANCILLARY CHARGE, and it is deliberately STRICTER
 *  than the one for a bracket.
 *
 *  A bracket with no corroboration still saves — it is the thing the caller asked
 *  for by name, the notes record that it is unchecked, and refusing it would lose
 *  real findings. An ancillary charge is the opposite case: nobody asked for it
 *  individually, it arrives as a list the model composed, and a plausible
 *  "Plan Review — 65% of permit fee" that no document anywhere prints would be
 *  added to a customer's total and never questioned, because it is exactly what a
 *  reader expects to see. So `matchedLine` — the printed row THIS RUN retrieved —
 *  is REQUIRED here. Only corroborateAncillaryCharges can produce one, and only
 *  the trusted path preserves it, so model output and a replayed findings file
 *  both lose the list entirely. Same rule as corroboration, one notch harder. */
function normalizeAncillaryCharges(raw: unknown): FeeAncillaryCharge[] {
  if (!Array.isArray(raw)) return [];
  const out: FeeAncillaryCharge[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const label = clean(c.label).slice(0, 200);
    const matchedLine = clean(c.matchedLine).slice(0, 300);
    const sourceUrl = clean(c.sourceUrl).slice(0, 500);
    if (!label || !matchedLine || !sourceUrl) continue;
    const amountUsd = num(c.amountUsd);
    const percent = num(c.percent);
    // EXACTLY ONE OF THE TWO. "$50 and 65%" is not a charge anything can
    // evaluate, and a charge with neither is a label with no price attached.
    const hasAmount = amountUsd != null && amountUsd >= 0;
    const hasPercent = percent != null && percent > 0 && percent <= 100;
    if (hasAmount === hasPercent) continue;
    const key = `${label.toLowerCase()}|${hasAmount ? amountUsd : `${percent}%`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = clean(c.kind).toLowerCase() as FeeAncillaryKind;
    out.push({
      label,
      kind: ANCILLARY_KINDS.includes(kind) ? kind : "other",
      ...(hasAmount ? { amountUsd: round2(amountUsd as number) } : { percent: round2(percent as number) }),
      percentOf: hasPercent ? clean(c.percentOf).slice(0, 200) : "",
      conditional: c.conditional === true,
      condition: clean(c.condition).slice(0, 300),
      appliesTo: feeDiscipline(clean(c.appliesTo)),
      // A charge with no reported sentence still has the row we matched it on;
      // that is the evidence either way, so it is never stored quote-less.
      quote: clean(c.quote).slice(0, 400) || matchedLine,
      sourceUrl,
      matchedLine,
    });
    // A HARD BOUND ON THE WORK, not on what is kept: the cap below decides that.
    if (out.length >= ANCILLARY_CHARGE_CAP * 5) break;
  }
  if (out.length <= ANCILLARY_CHARGE_CAP) return out;

  // WHEN THE CAP BITES, A CONDITIONAL CHARGE MAY NOT CROWD OUT A MANDATORY ONE.
  //
  // The two are not interchangeable and the asymmetry is not a matter of taste.
  // An unconditional charge is money the filing owes and the evaluator prices it.
  // A conditional one the recorded project facts cannot speak to comes back
  // `null` from conditionalChargeApplies — deliberately, because an absence of
  // facts is not permission to drop a charge — and a null NULLS THE WHOLE TOTAL.
  // So a conditional charge that arrives 13th and evicts a mandatory 12th does
  // not merely reorder a list: it trades a fee the customer certainly owes for a
  // fee they usually do not, and leaves every quote for that jurisdiction
  // unresolved into the bargain. Measured on the live City of Portland electrical
  // row: one held conditional charge ("Additional checksheet fee", $324, charged
  // only past the second checksheet) was enough to make every Portland electrical
  // quote unresolved.
  //
  // It bites ONLY at the cap, and the survivors come back in the order they
  // arrived — the notes, the screens and the stored row read the same as before
  // for every schedule small enough not to be cut, which is all of them today.
  const keep = new Set<FeeAncillaryCharge>();
  for (const pass of [false, true]) {
    for (const c of out) {
      if (keep.size >= ANCILLARY_CHARGE_CAP) break;
      if (c.conditional === pass) keep.add(c);
    }
  }
  return out.filter((c) => keep.has(c));
}

/** Keep only lines with a real fee, and ORDER them, because bracket evaluation
 *  is first-match — an unsorted table silently answers with the wrong tier.
 *
 *  `trusted` IS THE WHOLE SAFETY PROPERTY OF CORROBORATION, so it defaults to
 *  false. Untrusted (the default) STRIPS `corroboration`, which is what the
 *  model-output path at the end of claudeFeeScheduleResearcher relies on: a
 *  model that emitted `"corroboration":{"corroborated":true}` alongside an
 *  invented fee would otherwise have laundered its own guess into the one field
 *  that is supposed to mean "we went back and read the document". Same class of
 *  rule as "code never writes confidence 'verified'".
 *
 *  TRUSTED IS PASSED BY EXACTLY TWO CALLERS, and the second one earns it every
 *  time rather than assuming it:
 *    · parseBrackets — bytes this module itself wrote into brackets_json;
 *    · saveFeeSchedule — and ONLY on brackets it has just re-derived through
 *      corroborateBrackets against a FeeDocumentLedger its caller handed over.
 *  It used to say the second caller's input "has already been through
 *  corroborateBrackets", and that was FALSE: scripts/apply-fee-findings.ts hands
 *  saveFeeSchedule the brackets out of a JSON file, in a process that never
 *  fetches a document and never runs corroborateBrackets. A hand-edited findings
 *  file could therefore assert `corroborated: true` with any matchedLine it
 *  liked and have it printed next to the amount as evidence. A ledger is
 *  something only a process that actually retrieved bytes can produce, so
 *  requiring one is what makes the sentence above true instead of hopeful. */
function normalizeBrackets(raw: unknown[], opts: { trusted?: boolean } = {}): FeeBracket[] {
  const out: FeeBracket[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const b = item as Record<string, unknown>;
    const fee = num(b.feeUsd ?? b.fee_usd ?? b.fee);
    if (fee == null || fee < 0) continue;
    const corroboration = opts.trusted ? normalizeCorroboration(b.corroboration) : undefined;
    // Same rail as corroboration, and for the same reason: untrusted input may
    // not assert that a charge was printed anywhere.
    const ancillaryCharges = opts.trusted ? normalizeAncillaryCharges(b.ancillaryCharges) : [];
    out.push({
      minKw: num(b.minKw ?? b.min_kw ?? b.minKva ?? b.min_kva),
      maxKw: num(b.maxKw ?? b.max_kw ?? b.maxKva ?? b.max_kva),
      minValuationUsd: num(b.minValuationUsd ?? b.min_valuation_usd),
      maxValuationUsd: num(b.maxValuationUsd ?? b.max_valuation_usd),
      feeUsd: round2(fee),
      label: clean(b.label).slice(0, 200),
      ...(corroboration ? { corroboration } : {}),
      ...(opts.trusted && b.stateSurcharge && typeof b.stateSurcharge === "object"
        && (b.stateSurcharge as FeeBracket["stateSurcharge"])?.percent === 12
        ? { stateSurcharge: b.stateSurcharge as NonNullable<FeeBracket["stateSurcharge"]> } : {}),
      ...(opts.trusted && b.communitySurcharge && typeof b.communitySurcharge === "object"
        && (b.communitySurcharge as FeeBracket["communitySurcharge"])?.percent === 5
        ? { communitySurcharge: b.communitySurcharge as NonNullable<FeeBracket["communitySurcharge"]> } : {}),
      ...(ancillaryCharges.length ? { ancillaryCharges } : {}),
    });
  }
  const sortKey = (b: FeeBracket): number => b.minKw ?? b.minValuationUsd ?? 0;
  return out.sort((a, b) => sortKey(a) - sortKey(b));
}

/** Same defensive shape as parseBrackets: a candidates_json we cannot read is a
 *  row with no recorded sources, never a throw at the quote seam. */
function parseSources(raw: unknown): FeeScheduleSource[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text(raw) || "[]"); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return normalizeSources(parsed);
}

function normalizeSources(raw: unknown[]): FeeScheduleSource[] {
  const out: FeeScheduleSource[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    const documentDate = clean(s.documentDate).slice(0, 60);
    out.push({
      tag: clean(s.tag).slice(0, 12),
      name: clean(s.name).slice(0, 200),
      sourceUrl: clean(s.sourceUrl).slice(0, 500),
      sourceQuote: clean(s.sourceQuote).slice(0, 1000),
      documentDate,
      // Derived, never read off the stored JSON: one parser, so the phrase and
      // the comparable date can never disagree about the same document.
      documentDateIso: isoForDocumentDate(documentDate),
      brackets: normalizeBrackets(Array.isArray(s.brackets) ? s.brackets : []),
    });
    if (out.length >= 8) break;
  }
  return out;
}

function scheduleStatus(value: unknown): FeeScheduleStatus {
  return clean(value).toLowerCase() === "conflicted" ? "conflicted" : "ok";
}

function mapSchedule(row: Row): FeeScheduleRecord {
  const documentDate = text(row.document_date);
  return {
    id: text(row.id),
    profileKey: text(row.profile_key),
    state: text(row.state),
    ahj: text(row.ahj),
    utility: text(row.utility),
    track: feeTrack(text(row.track)),
    discipline: feeDiscipline(text(row.discipline)),
    collectedByProfileKey: text(row.collected_by_profile_key),
    basis: (["system_kw", "valuation", "flat", "other"].includes(text(row.basis)) ? text(row.basis) : "other") as FeeBasis,
    brackets: parseBrackets(row.brackets_json),
    status: scheduleStatus(row.status),
    documentDate,
    documentDateIso: isoForDocumentDate(documentDate),
    sources: parseSources(row.candidates_json),
    notes: text(row.notes),
    paymentMethod: normalizeFeePaymentMethod(row.payment_method),
    sourceUrl: text(row.source_url),
    sourceQuote: text(row.source_quote),
    sourceKind: text(row.source_kind),
    confidence: text(row.confidence) === "verified" ? "verified" : "seeded",
    firstSeenAt: text(row.first_seen_at),
    updatedAt: text(row.updated_at),
    verifiedAt: text(row.verified_at),
    verifiedBy: text(row.verified_by),
  };
}

/** One stored row. `discipline` defaults to "" — the undifferentiated row, which
 *  is what every caller written before disciplines existed is asking for, and
 *  what every row written before then carries. */
export function getFeeSchedule(
  db: AppDb,
  profileKey: string,
  track: FeeTrack,
  discipline: FeeDiscipline = "",
): FeeScheduleRecord | null {
  const row = db.get<Row>(
    "SELECT * FROM fee_schedules WHERE profile_key = ? AND track = ? AND discipline = ?",
    [profileKey, track, discipline],
  );
  return row ? mapSchedule(row) : null;
}

/** Every discipline stored under one key+track, in a stable order. */
export function getFeeSchedulesForKey(db: AppDb, profileKey: string, track: FeeTrack): FeeScheduleRecord[] {
  const rows = db.query<Row>(
    "SELECT * FROM fee_schedules WHERE profile_key = ? AND track = ? ORDER BY discipline",
    [profileKey, track],
  );
  return rows.map(mapSchedule);
}

/** FOLLOW THE HOP EXACTLY ONCE.
 *
 *  A delegation row says "the authority at this other key publishes this fee".
 *  One hop is all a jurisdiction split needs (city → county), and stopping at
 *  one is what makes a cycle impossible to write: a pair of rows pointing at
 *  each other resolves to nothing and says so, rather than spinning. A hop that
 *  lands on another delegation is reported as unresolved for the same reason —
 *  a chain of pointers is a modelling mistake somebody should see, not a
 *  traversal to optimise. */
function followCollectedBy(
  db: AppDb,
  record: FeeScheduleRecord,
): { record: FeeScheduleRecord; collectedBy: FeeScheduleRecord | null; unresolved: string } {
  const target = clean(record.collectedByProfileKey);
  if (!target) return { record, collectedBy: null, unresolved: "" };
  // The hop preserves the discipline: the city's ELECTRICAL row points at the
  // county's ELECTRICAL row, never at whatever the county happens to file first.
  const hopped = getFeeSchedule(db, target, record.track, record.discipline)
    // A county that publishes one undifferentiated permit schedule still answers
    // a discipline-specific hop — that row is the only thing it has to say.
    ?? getFeeSchedule(db, target, record.track, "");
  if (!hopped) {
    return { record, collectedBy: null, unresolved: `Fee is collected by "${target}", and no schedule is stored for that authority yet.` };
  }
  if (clean(hopped.collectedByProfileKey)) {
    return { record, collectedBy: null, unresolved: `Fee is collected by "${target}", whose row delegates onward — a chain of pointers needs a person to untangle it.` };
  }
  return { record: hopped, collectedBy: hopped, unresolved: "" };
}

/** Mark a schedule human-verified. From here on a research pass may not change
 *  it — it can only append what it found to notes (hard rule 3).
 *
 *  DELIBERATELY DOES NOT TOUCH `status`. Verifying a conflicted row says "yes,
 *  we really do hold two contradictory published numbers here" — it does not
 *  pick one, and the brackets it would be vouching for are two tagged tables
 *  stapled together. Such a row stays conflicted and stays unquotable; the way
 *  to resolve it is to re-save the schedule a person picked (see
 *  FeeScheduleFinding.resolvesConflict). */
export function markFeeScheduleVerified(
  db: AppDb,
  profileKey: string,
  track: FeeTrack,
  verifiedBy: string,
  discipline: FeeDiscipline = "",
): FeeScheduleRecord | null {
  const existing = getFeeSchedule(db, profileKey, track, discipline);
  if (!existing) return null;
  const ts = nowIso();
  db.run(
    "UPDATE fee_schedules SET confidence = 'verified', verified_at = ?, verified_by = ?, updated_at = ? WHERE id = ?",
    [ts, clean(verifiedBy).slice(0, 120), ts, existing.id],
  );
  return getFeeSchedule(db, profileKey, track, discipline);
}

/** WHAT THE DISAGREEMENT ACTUALLY IS, in one readable line.
 *
 *  Built from the stored sources rather than from notes prose, so the sentence a
 *  person reads on a quote screen carries the two things that settle a Coos-shaped
 *  conflict: each document's numbers, and what each document says about its own
 *  currency. "S1 (Revised 12/23/2022) says $79.00 / $94.00 / $156.00 vs S2
 *  (Effective 7-1-25) says $135.00 / $160.00 / $265.00" resolves in a minute;
 *  "needs a human to read it" — which is all this used to say — resolves never. */
export function conflictSummary(schedule: FeeScheduleRecord): string {
  const sources = schedule.sources.filter((s) => s.brackets.length);
  if (sources.length < 2) {
    // Marked conflicted with nothing to show. Still a refusal, and still says so:
    // "we do not trust this row" is the message either way.
    return "two published sources disagree about this fee, and the row does not record which — read its notes and the jurisdiction's own page";
  }
  return sources
    .map((s) => {
      const when = s.documentDate ? `(${s.documentDate})` : "(undated)";
      const fees = s.brackets.slice(0, 6).map((b) => `$${b.feeUsd.toFixed(2)}`).join(" / ");
      return `${s.tag || s.name || "source"} ${when} says ${fees}`;
    })
    .join(" vs ")
    .slice(0, 400);
}

/** One-line human-readable rendering of a finding, for the notes trail. */
function findingSummary(finding: FeeScheduleFinding): string {
  const fees = finding.brackets.map((b) => `${b.label ? `${b.label}: ` : ""}$${b.feeUsd.toFixed(2)}`).join("; ");
  const method = normalizeFeePaymentMethod(finding.paymentMethod);
  return [
    `basis ${finding.basis}`,
    fees ? `(${fees})` : "",
    method === "unknown" ? "" : `paid: ${method}`,
    finding.sourceUrl ? `[${finding.sourceUrl}]` : "",
    finding.sourceQuote ? `"${finding.sourceQuote.slice(0, 240)}"` : "",
  ].filter(Boolean).join(" ");
}

/** Store a finding as a 'seeded' schedule. Refuses (a) unsourced numbers and
 *  (b) any write over a human-verified row. Exported so an importer or an
 *  operator-entered schedule can use the same guard as research.
 *
 *  CORROBORATION IS DENIED BY DEFAULT, AND THE ONLY KEY IS A LEDGER.
 *  `opts.corroborateAgainst` is the retrieval trail of the process that is doing
 *  the saving; hand one over and every bracket's corroboration is RE-DERIVED
 *  from it here (corroborateBrackets discards whatever arrived and asks the
 *  corpus). Hand nothing over — an importer, a seed script, an operator-entered
 *  row, or scripts/apply-fee-findings.ts replaying a JSON file — and any
 *  `corroboration` riding on the incoming brackets is STRIPPED. That is
 *  deliberate and it is the whole point: corroboration means "a machine fetched
 *  the cited source and found this number printed in it", and a caller that
 *  cannot produce the bytes it read has not done that. It is not a refusal — the
 *  fee still saves, as seeded, simply uncorroborated. */
export function saveFeeSchedule(
  db: AppDb,
  input: { state: string; ahj?: string; utility?: string; track: FeeTrack; discipline?: string },
  finding: FeeScheduleFinding,
  opts: { corroborateAgainst?: FeeDocumentLedger } = {},
): FeeScheduleResearchOutcome {
  const track = input.track;
  const profileKey = feeScheduleProfileKey(input, track);
  // The discipline may travel on either side: on the input (an operator or a
  // seed script saying which permit this is) or on the finding (a researcher
  // that worked it out). The input wins — it is the caller's own statement of
  // what it asked for.
  const discipline = feeDiscipline(input.discipline || finding.discipline);
  const collectedBy = clean(finding.collectedByProfileKey);
  // THE TRUST BOUNDARY, and it is structural rather than documented.
  //
  // With a ledger: corroborateBrackets deletes every incoming corroboration
  // unconditionally and re-derives from the corpus this process retrieved, so
  // what `trusted` then keeps was computed here, one line ago, out of bytes we
  // read. Without one: untrusted, and corroboration is stripped — a caller that
  // cannot show what it read cannot claim to have read it.
  const brackets = opts.corroborateAgainst
    ? normalizeBrackets(corroborateBrackets({...finding, discipline}, opts.corroborateAgainst), { trusted: true })
    : normalizeBrackets(finding.brackets || [], {});
  const sourceUrl = clean(finding.sourceUrl);
  const sourceQuote = clean(finding.sourceQuote);
  const status = finding.status === "conflicted" ? "conflicted" : "ok";
  const documentDate = clean(finding.documentDate).slice(0, 60);
  const base = { found: finding.found, profileKey, track, finding: { ...finding, brackets } };

  if (!finding.found) {
    return { ...base, reason: finding.reason || "Researcher reported no finding.", saved: false, refusedVerified: false, refusedConflicted: false, schedule: getFeeSchedule(db, profileKey, track, discipline) };
  }
  // A FEE WITH NO QUOTE IS A RUMOUR. Both halves are required: the URL says
  // where to go back and check, the sentence says what was actually read there.
  if (!sourceUrl || !sourceQuote) {
    const reason = `Refused: a fee needs both a source URL and the sentence it came from (url=${sourceUrl ? "yes" : "no"}, quote=${sourceQuote ? "yes" : "no"}).`;
    logger.warn("fees", "fee schedule refused — unsourced", { profileKey, track });
    return { ...base, found: false, reason, saved: false, refusedVerified: false, refusedConflicted: false, schedule: getFeeSchedule(db, profileKey, track, discipline) };
  }
  // A DELEGATION IS THE ONE ROW WITH NOTHING TO EVALUATE, and it still had to
  // pass the sourcing rule above: naming another authority is a claim about the
  // world, and an unsourced one belongs in this table no more than an unsourced
  // number does. A row that is neither a fee nor a hop is refused as before.
  if (!brackets.length && !collectedBy) {
    return { ...base, found: false, reason: "Refused: no usable fee line (every bracket lacked a finite, non-negative feeUsd), and no collecting authority named.", saved: false, refusedVerified: false, refusedConflicted: false, schedule: getFeeSchedule(db, profileKey, track, discipline) };
  }
  if (collectedBy && collectedBy === profileKey) {
    return { ...base, found: false, reason: `Refused: a row cannot delegate its fee to itself ("${profileKey}").`, saved: false, refusedVerified: false, refusedConflicted: false, schedule: getFeeSchedule(db, profileKey, track, discipline) };
  }

  const existing = getFeeSchedule(db, profileKey, track, discipline);
  const ts = nowIso();

  // HUMAN-VERIFIED IS NOT A STARTING POINT. Record what research found, in
  // notes, and change nothing else — a person compares and decides.
  if (existing && existing.confidence === "verified") {
    const segment = `Research ${ts.slice(0, 10)} (NOT applied — row is human-verified): ${findingSummary({ ...finding, brackets })}`;
    db.run("UPDATE fee_schedules SET notes = ?, updated_at = ? WHERE id = ?", [mergeNotes(existing.notes, [segment]), ts, existing.id]);
    logger.info("fees", "research refused against human-verified fee schedule", { profileKey, track, discipline });
    return { ...base, reason: "Row is human-verified — finding recorded in notes, schedule unchanged.", saved: false, refusedVerified: true, refusedConflicted: false, schedule: getFeeSchedule(db, profileKey, track, discipline) };
  }

  // AN OPEN CONFLICT IS A QUESTION ASKED OF A HUMAN, AND AN AUTOMATED PASS MUST
  // NOT ANSWER IT BY WINNING THE RACE.
  //
  // Measured reachable today: Coos County's row holds $79/$94/$156 against
  // $135/$160/$265 and refuses to price anything. Any later researcher that
  // returns ONE of those tables — having very possibly read only one of the two
  // documents — would have overwritten the row, cleared the status, and started
  // quoting that number with a straight face. The disagreement would be gone
  // from everywhere except a notes segment nobody reads. So the conflict guard
  // sits alongside the human-verified guard (and AFTER it: a verified row must
  // be reported as verified, which is the stronger and more specific refusal),
  // and the only way past it is a finding that says a person picked.
  if (existing && existing.status === "conflicted" && !finding.resolvesConflict && status !== "conflicted") {
    const segment = `Research ${ts.slice(0, 10)} (NOT applied — an ${FEE_CONFLICT_MARKER} is open on this row): ${findingSummary({ ...finding, brackets })}`;
    db.run("UPDATE fee_schedules SET notes = ?, updated_at = ? WHERE id = ?", [mergeNotes(existing.notes, [segment]), ts, existing.id]);
    logger.info("fees", "write refused against an unresolved fee conflict", { profileKey, track, discipline });
    return {
      ...base,
      reason: `Refused: an ${FEE_CONFLICT_MARKER} is open on this row (${conflictSummary(existing)}). The finding was recorded in its notes and nothing was changed. `
        + `A person must read both candidates and pick one — re-save with resolvesConflict (scripts/apply-fee-findings.ts --resolve-conflicts).`,
      saved: false, refusedVerified: false, refusedConflicted: true,
      schedule: getFeeSchedule(db, profileKey, track, discipline),
    };
  }

  // EVERY ROW EXPLAINS ITSELF, conflicted or not. A finding that named its
  // sources keeps them; one that did not gets a single entry synthesised from
  // itself, because a row with an empty source list cannot say where its number
  // came from — and "candidates_json is only for conflicts" is how the ordinary
  // row's document date would have gone on being lost.
  const sources = normalizeSources(finding.sources || []);
  if (!sources.length) {
    sources.push({
      tag: "S1",
      name: clean(input.ahj) || clean(input.utility) || profileKey,
      sourceUrl, sourceQuote, documentDate,
      documentDateIso: isoForDocumentDate(documentDate),
      brackets,
    });
  }

  const notes = mergeNotes(existing?.notes, noteSegments(finding.notes));
  // A schedule that says nothing about payment does not erase what the row already
  // said: "unknown" is the absence of an answer, and an absence must never overwrite
  // an answer somebody found. Only a real method replaces a real method.
  const incomingMethod = normalizeFeePaymentMethod(finding.paymentMethod);
  const paymentMethod = incomingMethod === "unknown" ? (existing?.paymentMethod ?? "unknown") : incomingMethod;
  if (existing) {
    db.run(
      `UPDATE fee_schedules SET state = ?, ahj = ?, utility = ?, basis = ?, brackets_json = ?, notes = ?,
         payment_method = ?, source_url = ?, source_quote = ?, source_kind = ?, collected_by_profile_key = ?,
         status = ?, document_date = ?, candidates_json = ?,
         confidence = 'seeded', updated_at = ?
       WHERE id = ?`,
      [
        clean(input.state), clean(input.ahj), clean(input.utility), finding.basis,
        JSON.stringify(brackets), notes, paymentMethod, sourceUrl, sourceQuote, clean(finding.sourceKind),
        collectedBy, status, documentDate, JSON.stringify(sources), ts, existing.id,
      ],
    );
  } else {
    db.run(
      `INSERT INTO fee_schedules
         (id, profile_key, state, ahj, utility, track, discipline, basis, brackets_json, notes, payment_method,
          source_url, source_quote, source_kind, collected_by_profile_key, status, document_date, candidates_json,
          confidence, first_seen_at, updated_at, verified_at, verified_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seeded', ?, ?, '', '')`,
      [
        id(), profileKey, clean(input.state), clean(input.ahj), clean(input.utility), track, discipline, finding.basis,
        JSON.stringify(brackets), notes, paymentMethod, sourceUrl, sourceQuote, clean(finding.sourceKind), collectedBy,
        status, documentDate, JSON.stringify(sources), ts, ts,
      ],
    );
  }
  logger.info("fees", "fee schedule saved (seeded)", {
    profileKey, track, discipline: discipline || "(any)", basis: finding.basis,
    brackets: brackets.length, collectedBy: collectedBy || undefined,
    status, sources: sources.length, documentDate: documentDate || undefined,
    resolvedConflict: finding.resolvesConflict && existing?.status === "conflicted" ? true : undefined,
  });
  return { ...base, reason: "", saved: true, refusedVerified: false, refusedConflicted: false, schedule: getFeeSchedule(db, profileKey, track, discipline) };
}

// ---------------------------------------------------------------------------
// The researcher
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// RETRIEVAL: the researcher's hands.
//
// The researcher used to have exactly one faculty — web search — and one way to
// fail: honestly. It reported found:false for the City of Coos Bay and gave a
// well-reasoned refusal; the operator then found the fee schedule in their
// browser in seconds. It was right that the document was hard to REACH and wrong
// about why. coosbayor.gov sits behind Akamai and returns 403 to every
// programmatic client — WebFetch, curl with a browser User-Agent, headless
// Playwright. A HEADED window gets 200, and the PDF fetched from inside that
// page context comes back 1.2 MB of application/pdf.
//
// And getting the bytes is only half of it. Read in text-stream order, that PDF
// pairs "Plan Review" with "65% of permit fee" where the printed row says
// "Structural Plan Review". Same stream, two different facts — and a fee
// attributed to the wrong line goes onto a customer's quote.
//
// So the model gets a tool that does both, and neither half is its job to get
// right: documentFetch.ts climbs from a plain GET to a real window when the far
// end refuses one, and pdfTables.ts hands back VISUAL ROWS grouped by baseline
// and ordered by x. What the model then quotes is a row a person would see.
//
// EVERY STRING THIS TOOL RETURNS IS KEPT (the ledger below). After the model
// answers, its quote is checked against those bytes. That check never refuses a
// finding — a fee found through web search alone cannot be checked this way, and
// silently dropping it would be worse than reporting it unchecked — but a stored
// quote that was never in anything we retrieved is exactly the shape a
// hallucinated fee has, and the notes say so in as many words.
// ---------------------------------------------------------------------------

/** The retrieval trail for one research pass: what came back, and the text of it. */
export interface FeeDocumentLedger {
  evidence: FeeResearchEvidence[];
  /** THE DOCUMENT WE RETRIEVED — not the window the model was shown.
   *
   *  This used to read "exactly the strings handed to the model", and that made
   *  corroboration a function of the model's own search terms. MEASURED, against
   *  the real City of Portland electrical schedule and one fixed set of reported
   *  charges: `find:"324"` + `find:"renewable"` holds ONE charge (a conditional
   *  $324 checksheet fee) and drops three; `pages:[1,2,3]` on the SAME pdf, with
   *  the SAME reported charges, holds three — the published 25% plan review and
   *  the reinspection fee among them. Nothing about the document or the model's
   *  answer differed. Only which rows `selectRows` had trimmed out of the body,
   *  to keep the model's context small, before it reached the corroborator.
   *
   *  Trimming for context is right; trimming the EVIDENCE is not. The question
   *  corroboration asks is "is this label printed beside this amount in the
   *  document we fetched", and the answer must not depend on which `find` the
   *  model happened to type. So `corpus[i]` is now every row / every text line of
   *  the document `evidence[i]` names, and `evidence[i].handed` stays the count
   *  the MODEL was shown, so the two facts remain separable.
   *
   *  It cannot launder anything: these are still only bytes this process
   *  retrieved, and every rule downstream (whole label, amount on the same
   *  printed line) is untouched. */
  corpus: string[];
}

export function newFeeDocumentLedger(): FeeDocumentLedger {
  return { evidence: [], corpus: [] };
}

const OPEN_DOCUMENT_TOOL = {
  name: "open_document",
  description:
    "Retrieve a PUBLIC web page or PDF and read it. Escalates to a real browser window by itself when a site "
    + "refuses an ordinary HTTP client (many .gov sites sit behind a WAF that 403s every script), so a 403 from "
    + "your own knowledge of a site is not a reason to skip it — try it here. A PDF comes back as VISUAL ROWS: "
    + "cells that share a printed line, left to right, joined with ' | '. That pairing is read from the glyph "
    + "coordinates, NOT from the PDF's text order, so the row you see is the row that is printed. An HTML page "
    + "comes back as its links (to follow into a document search) plus its text. Never authenticates and never "
    + "solves a CAPTCHA.",
  input_schema: {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "Absolute http(s) URL of the page or PDF." },
      find: {
        type: "string",
        description:
          "Case-insensitive filter. On a PDF, only rows containing it (plus a line of context either side) are "
          + "returned; omit it and the solar/renewable/kVA rows are returned. On an HTML page it filters the links "
          + "and text lines. Use it to find the fee table in a 60-page schedule.",
      },
      pages: {
        type: "array",
        items: { type: "integer" },
        description: "PDF only: 1-based page numbers to return IN FULL, as printed in a PDF reader. Use this once "
          + "`find` has told you which page the fee table is on, to read the whole table including its header rows.",
      },
    },
    required: ["url"],
  },
};

/** Rows/links/text are capped so one 60-page schedule cannot eat the context
 *  window (and the budget) that the other five jurisdictions need. */
const DOC_MAX_ROWS = 220;
const DOC_MAX_ROW_CHARS = 300;
const DOC_MAX_LINKS = 70;
const DOC_MAX_TEXT_CHARS = 3500;
const DOC_MAX_PDF_PAGES = 80;

/** The LEDGER's own ceilings, and they are NOT the ones above. The caps above
 *  exist to protect the model's context window and the token bill; these exist
 *  only to stop one pathological document eating this process's memory. Nothing
 *  under them is ever sent to an LLM (grep `.corpus`: corroboration, the quote
 *  check and the notes are its only readers), so they can afford to be the whole
 *  document — which is the point. */
const LEDGER_MAX_ROWS = 4000;
const LEDGER_MAX_TEXT_CHARS = 400_000;

const looksLikePdf = (doc: { contentType: string; bytes?: Uint8Array }): boolean => {
  if (/pdf/i.test(doc.contentType)) return true;
  const b = doc.bytes;
  return !!b && b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF
};

const rowText = (row: PdfTextRow): string => `p${row.page}  ${row.cells.join(" | ")}`.slice(0, DOC_MAX_ROW_CHARS);

/** Rows matching the filter, each with one line of context either side, so a
 *  bracket row is never read without the "Renewable Energy" heading above it. */
function selectRows(rows: PdfTextRow[], pages: number[], find: string): { picked: PdfTextRow[]; how: string } {
  const ordered = [...rows].sort((a, b) => a.page - b.page || b.y - a.y);
  if (pages.length) {
    const want = new Set(pages);
    return { picked: ordered.filter((r) => want.has(r.page)), how: `every row on page(s) ${pages.join(", ")}` };
  }
  const needles = find ? [find.toLowerCase()] : DEFAULT_FEE_KEYWORDS;
  const hit = (r: PdfTextRow): boolean => {
    const hay = r.cells.join(" ").toLowerCase();
    return needles.some((k) => hay.includes(k));
  };
  const keep = new Set<number>();
  ordered.forEach((r, i) => {
    if (!hit(r) && !/12\s*%.*surcharge|Community Dev surcharge 5%/i.test(r.cells.join(" "))) return;
    for (let j = Math.max(0, i - 1); j <= Math.min(ordered.length - 1, i + 1); j++) keep.add(j);
  });
  return {
    picked: ordered.filter((_r, i) => keep.has(i)),
    how: find
      ? `rows containing "${find}" (with one line of context either side)`
      : `rows mentioning ${DEFAULT_FEE_KEYWORDS.join("/")} (with one line of context either side)`,
  };
}

function renderHtml(html: string, base: string, find: string, textBudget = DOC_MAX_TEXT_CHARS): { body: string; handed: number } {
  const lines: string[] = [];
  let text = html;
  let links: Array<{ text: string; href: string }> = [];
  try {
    // Regex rather than cheerio on purpose: this runs inside a tool call on an
    // arbitrary government page, and a parser failure must degrade to "here is
    // the text" rather than lose the whole retrieval.
    const anchors = html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);
    for (const m of anchors) {
      const raw = m[1].trim();
      if (!raw || raw.startsWith("#") || /^(javascript|mailto|tel):/i.test(raw)) continue;
      let href: string;
      try { href = new URL(raw, base).toString(); } catch { continue; }
      const label = clean(m[2].replace(/<[^>]*>/g, " "));
      if (!label) continue;
      links.push({ text: label, href });
    }
    text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, "\n");
  } catch { /* fall through with whatever we have */ }

  const needle = find.toLowerCase();
  if (needle) links = links.filter((l) => l.text.toLowerCase().includes(needle) || l.href.toLowerCase().includes(needle));
  const seen = new Set<string>();
  const uniq = links.filter((l) => (seen.has(l.href) ? false : (seen.add(l.href), true))).slice(0, DOC_MAX_LINKS);

  const textLines = text.split("\n").map((l) => clean(l)).filter(Boolean);
  const picked = needle ? textLines.filter((l) => l.toLowerCase().includes(needle)) : textLines;

  lines.push(`LINKS (${uniq.length}${links.length > uniq.length ? ` of ${links.length}` : ""}):`);
  for (const l of uniq) lines.push(`  ${l.text}  ->  ${l.href}`);
  lines.push("");
  lines.push("TEXT:");
  let budget = textBudget;
  for (const l of picked) {
    if (budget <= 0) { lines.push("  … (truncated)"); break; }
    lines.push(`  ${l.slice(0, budget)}`);
    budget -= l.length + 1;
  }
  const body = lines.join("\n");
  return { body, handed: uniq.length + picked.length };
}

/** The tool handler. Never throws: a tool that throws ends the loop, and a
 *  jurisdiction we could not retrieve is a REASON, not a crash. */
export async function openFeeDocument(
  args: { url?: unknown; find?: unknown; pages?: unknown },
  ledger: FeeDocumentLedger,
  opts: FetchPublicDocumentOptions = {},
): Promise<string> {
  const url = clean(args.url);
  if (!url) return "No url was given. Call open_document with an absolute http(s) URL.";
  const find = clean(args.find);
  const pages = Array.isArray(args.pages)
    ? args.pages.map((p) => Number(p)).filter((p) => Number.isInteger(p) && p >= 1).slice(0, 8)
    : [];

  let doc: Awaited<ReturnType<typeof fetchPublicDocument>>;
  try {
    doc = await fetchPublicDocument(url, opts);
  } catch (err) {
    return `Could not retrieve ${url}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!doc.ok || !doc.bytes) {
    // The reason names what blocked us — status, Server header, whether a real
    // window was tried. That is a fact about this jurisdiction worth reporting
    // in notes, so it goes to the model rather than being flattened to "failed".
    return `Could not retrieve ${url}. ${doc.reason}`;
  }

  const head = `${url}\nHTTP ${doc.status} via ${doc.via}${doc.via === "browser" ? " (a real window — the plain HTTP client was refused)" : ""}`
    + ` — ${doc.bytes.length} bytes of ${doc.contentType || "unknown type"}${doc.finalUrl && doc.finalUrl !== url ? `\nfinal URL: ${doc.finalUrl}` : ""}`;

  /** `body` is what the MODEL reads (filtered, capped for context). `read` is what
   *  WE read (the whole document), and it is what lands in the ledger — see the
   *  `corpus` comment on FeeDocumentLedger for the measurement that forced the
   *  split. They are the same string only for a retrieval with nothing to filter. */
  const record = (kind: FeeResearchEvidence["kind"], handed: number, body: string, read?: string): string => {
    ledger.evidence.push({ url: doc.finalUrl || url, via: doc.via, status: doc.status, kind, bytes: doc.bytes?.length ?? 0, handed });
    ledger.corpus.push(read ?? body);
    return `${head}\n\n${body}`;
  };

  if (looksLikePdf(doc)) {
    let rows: PdfTextRow[];
    try {
      const items = await extractPdfTextItems(doc.bytes, { maxPages: DOC_MAX_PDF_PAGES });
      rows = groupItemsIntoRows(items);
    } catch (err) {
      return `${head}\n\nThis is a PDF but it could not be read: ${err instanceof Error ? err.message : String(err)}`;
    }
    const pageCount = rows.reduce((max, r) => Math.max(max, r.page), 0);
    const { picked, how } = selectRows(rows, pages, find);
    const shown = picked.slice(0, DOC_MAX_ROWS);
    const body = [
      `${pageCount} page(s). Rows are read BY COORDINATE — cells sharing a printed line, left to right, joined " | ".`,
      `Showing ${shown.length}${picked.length > shown.length ? ` of ${picked.length}` : ""}: ${how}.`,
      picked.length ? "" : "Nothing matched. Try a different `find`, or ask for a page in full with `pages`.",
      ...shown.map(rowText),
    ].filter((l) => l !== undefined).join("\n");
    // Same coordinate pairing, same row rendering — every row of the document, in
    // printed order, for the corroborator. The model still gets `body`.
    const everyRow = [...rows]
      .sort((a, b) => a.page - b.page || b.y - a.y)
      .slice(0, LEDGER_MAX_ROWS)
      .map(rowText)
      .join("\n");
    return record("pdf", shown.length, body, everyRow);
  }

  if (doc.text != null) {
    const { body, handed } = renderHtml(doc.text, doc.finalUrl || url, find);
    // Unfiltered and on the ledger's own budget: a charge printed below a fee
    // page's 3,500th character is still printed on that page.
    const { body: whole } = renderHtml(doc.text, doc.finalUrl || url, "", LEDGER_MAX_TEXT_CHARS);
    return record("html", handed, body, whole);
  }

  return record("other", 0, "Retrieved, but it is neither HTML nor a PDF, so there is nothing to read here.");
}

// ---------------------------------------------------------------------------
// Did the quote come from anything we actually read?
// ---------------------------------------------------------------------------

/** Fold away the differences that make two renderings of the SAME printed row
 *  look different: the en-dash a fee schedule prints where a model types a
 *  hyphen, the "$" and thousands separators, runs of white space. */
function matchKey(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[$,]/g, "")
    .replace(/[^a-z0-9.%'"()+/\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface QuoteSupport {
  /** A fragment of the quote, 15+ characters, found verbatim in retrieved bytes. */
  quoteVerified: boolean;
  /** Every bracket's fee appears in retrieved bytes. */
  feesVerified: boolean;
  /** Nothing was retrieved this run — the check could not be made either way. */
  noEvidence: boolean;
  matchedFragment: string;
  missingFees: number[];
}

/** Check a finding against the bytes this run actually retrieved.
 *
 *  ADVISORY, NEVER A GATE. A fee read off a page our fetcher never opened (web
 *  search returns its results encrypted, so they are unreadable here) is not
 *  thereby wrong — refusing it would lose real findings. But "the quote is not
 *  in anything we read" is the exact signature of an invented one, so it is
 *  reported every time, in the notes that travel with the row. */
export function checkQuoteSupport(finding: FeeScheduleFinding, ledger: FeeDocumentLedger): QuoteSupport {
  const corpus = ledger.corpus.map(matchKey).join("\n");
  const out: QuoteSupport = {
    quoteVerified: false, feesVerified: false, noEvidence: corpus.length === 0,
    matchedFragment: "", missingFees: [],
  };
  if (!corpus) return out;

  // Fragments, not the whole sentence: a good quote legitimately staples a row
  // to its heading, or appends "[Exhibit A, p.8]". One 15-character run that is
  // verbatim in the document is what distinguishes reading from paraphrasing.
  const fragments = String(finding.sourceQuote || "")
    .split(/\s*\|\s*|\s{2,}|[[\]]|(?<=\.)\s+/)
    .map(matchKey)
    .filter((f) => f.length >= 15)
    .sort((a, b) => b.length - a.length);
  for (const f of fragments) {
    if (corpus.includes(f)) { out.quoteVerified = true; out.matchedFragment = f.slice(0, 160); break; }
  }

  const missing = (finding.brackets || []).filter((b) => {
    const plain = matchKey(String(b.feeUsd));
    const exact = matchKey(b.feeUsd.toFixed(2));
    return !corpus.includes(plain) && !corpus.includes(exact);
  });
  out.missingFees = missing.map((b) => b.feeUsd);
  out.feesVerified = missing.length === 0;
  return out;
}

// ---------------------------------------------------------------------------
// PER-BRACKET CORROBORATION: was THIS row in the document, on one printed line?
//
// checkQuoteSupport above answers two ROW-grain questions — "is the stored
// sentence in anything we read" and "does each fee appear ANYWHERE in the
// corpus". The second one is too weak to be called corroboration, and it is weak
// in precisely the way this codebase has already been bitten: a third-party
// summary reported $346 and $796 for two solar brackets because it had taken the
// amounts off the WIND GENERATION rows printed below them. "Does $346 appear in
// the document?" answers YES for that mistake, because $346 really is printed on
// page 8 — on the wrong line.
//
// So corroboration requires CO-OCCURRENCE ON ONE PRINTED LINE: the bracket's fee
// and a run of the bracket's own label, in the same coordinate-paired row
// openFeeDocument handed back ("p8  5 KVA or less | $135.00"). That is the same
// pairing a person's eye makes, and it is what keeps a wind fee off a solar row.
//
// ADVISORY, NEVER A GATE — the same contract as checkQuoteSupport. A bracket we
// could not corroborate still saves, as seeded, recorded as uncorroborated. A
// fee found through web search alone is not thereby wrong, and turning a failed
// fetch into found:false would surface on the very channel ("this jurisdiction
// publishes nothing") the timeout wording below exists to keep clear.
// ---------------------------------------------------------------------------

/** The dollar amounts a piece of printed text actually NAMES. `$`-anchored and
 *  run on the raw string, because matchKey folds the "$" away — and a bare
 *  number in a fee schedule is as likely to be a kVA bound as a price. */
export function quotedAmounts(value: unknown): number[] {
  const out: number[] = [];
  for (const m of String(value ?? "").matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(round2(n));
  }
  return out;
}

/** Is this fee printed on this line AS A NUMBER OF ITS OWN? A substring test
 *  would find "135" inside "1350.00" and corroborate a bracket off a ten-times
 *  bigger fee. */
function feeOnLine(folded: string, feeUsd: number): boolean {
  return [feeUsd.toFixed(2), String(feeUsd)].some((form) => {
    const esc = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^\\d.])${esc}(?![\\d])`).test(folded);
  });
}

/** The runs of a bracket's own label specific enough to pin one printed row.
 *
 *  The WHOLE label first, then the label with its inline "$135.00" removed (many
 *  stored labels are the whole row, fee and all). Deliberately NOT the label
 *  chopped into small pieces: "25.01 kva to 50 kva" is a fragment of the SOLAR
 *  label that appears verbatim on the WIND row, which is the entire mistake this
 *  function exists to refuse. */
function labelFragments(label: string): string[] {
  const whole = matchKey(label);
  const core = matchKey(String(label ?? "").replace(/\$\s*[\d,]+(?:\.\d{1,2})?/g, " "));
  const out: string[] = [];
  for (const f of [whole, core]) if (f.length >= 10 && !out.includes(f)) out.push(f);
  return out;
}

/** Re-derive every bracket's corroboration from the bytes THIS RUN retrieved.
 *
 *  Whatever arrived on the incoming brackets is DISCARDED first, unconditionally.
 *  That is the guard, not the `trusted` flag: even if a model's output reached
 *  here with `corroborated: true` glued to an invented fee, this function throws
 *  it away and asks the corpus. */
export function corroborateBrackets(finding: FeeScheduleFinding, ledger: FeeDocumentLedger): FeeBracket[] {
  const brackets: FeeBracket[] = (finding.brackets || []).map((b) => {
    const copy: FeeBracket = { ...b };
    delete copy.corroboration;
    delete copy.stateSurcharge;
    delete copy.communitySurcharge;
    return copy;
  });

  // openFeeDocument pushes to `evidence` and `corpus` in the same call, so the
  // two are index-parallel and a matched line can name the document it came off.
  const lines: Array<{ raw: string; folded: string; doc: number }> = [];
  ledger.corpus.forEach((body, doc) => {
    const documentLines = String(body ?? "").split("\n");
    for (const [index, line] of documentLines.entries()) {
      const raw = line.trim();
      if (!raw) continue;
      lines.push({ raw, folded: matchKey(raw), doc });
      // Tigard prints one renewable-energy heading above three size rows.
      // Preserve that heading only for immediately consecutive kVA/price rows;
      // never carry it across another heading (especially the wind table).
      if (/^(?:p\d+\s+)?Renewable electrical energy systems$/i.test(raw)) {
        for (let offset = 1; offset <= 3; offset++) {
          const row = documentLines[index + offset]?.trim() ?? '';
          if (!/^(?:p\d+\s+)?(?:\d+(?:\.\d+)?\s+kva or less|\d+(?:\.\d+)?\s+to\s+\d+(?:\.\d+)?\s+kva)\s*\|\s*\$[\d,.]+$/i.test(row)) break;
          const joined = `${raw.replace(/^p\d+\s+/, '')} — ${row.replace(/^p\d+\s+/, '')}`;
          lines.push({raw:joined,folded:matchKey(joined),doc});
        }
      }
      // A two-line PV fee: its heading names the system, the immediately
      // following row names plan review/admin and the price. Keep both as
      // evidence, without matching small label fragments against wind rows.
      const next = documentLines[index + 1]?.trim() ?? "";
      if (/Photovoltaic\s*\(PV\)\s*Solar Panel System\s*$/i.test(raw)
        && /^(?:p\d+\s+)?Plan Review\s*&\s*Admin Fees\s*\|\s*\$[\d,.]+$/i.test(next)) {
        const joined = `${raw.replace(/^p\d+\s+/, '')} — ${next.replace(/^p\d+\s+/, '')}`;
        lines.push({raw:joined,folded:matchKey(joined),doc});
      }
    }
  });
  if (!lines.length) return brackets;
  // Prefer the cited final schedule over earlier exploratory/proposed copies.
  lines.sort((a,b) => Number(clean(ledger.evidence[b.doc]?.url) === clean(finding.sourceUrl)) - Number(clean(ledger.evidence[a.doc]?.url) === clean(finding.sourceUrl)));

  const checkedAt = nowIso();
  for (const b of brackets) {
    const fragments = labelFragments(String(b.label ?? ""));
    // A bracket with no label of its own (or a label too short to identify a
    // row) has nothing to co-occur WITH. Reporting it uncorroborated is the
    // honest answer; matching on the fee alone is the wind-row bug.
    if (!fragments.length) continue;
    const hitLine = lines.find((l) => feeOnLine(l.folded, b.feeUsd) && fragments.some((f) => l.folded.includes(f)));
    if (!hitLine) continue;
    const doc = ledger.evidence[hitLine.doc];
    b.corroboration = {
      corroborated: true,
      matchedLine: hitLine.raw.slice(0, 300),
      sourceUrl: clean(doc?.url) || clean(finding.sourceUrl),
      checkedAt,
      via: doc?.via === "browser" ? "browser" : "http",
    };
    // Deliberately narrow: only a mandatory surcharge on ALL permit fees.
    // "12% of valuation", optional review, and totals already including the
    // surcharge must never be converted into an additional permit charge.
    const corpus = String(ledger.corpus[hitLine.doc] ?? "").replace(/\s+/g, " ");
    const surcharge = /\b12\s*%\s+surcharge\s+fee\s+as\s+mandated\s+by\s+the\s+State\s+Building\s+Codes\s+Division\s+is\s+applied\s+to\s+all\s+permit\s+fees/i.exec(corpus);
    const printed = /State surcharge\s*\(12% of permit fee\):\s*\$\s*(\d+(?:\.\d{2})?)/i.exec(corpus);
    const applicationSurcharge = printed && /prescriptive photovoltaic solar panel system permit fee/i.test(b.label ?? "")
      && round2(b.feeUsd * .12) === Number(printed[1]) ? printed : null;
    if ((surcharge || applicationSurcharge) && !feeIncludesSurcharges(`${b.label ?? ''} ${hitLine.raw}`)) {
      b.stateSurcharge = { percent: 12, quote: (surcharge || applicationSurcharge)![0], sourceUrl: b.corroboration.sourceUrl };
    }
    // Coos County's published application supplies two surcharge rows while
    // its separate schedule supplies the base. Require BOTH retrieved sources
    // from the collecting authority, and the electrical discipline; this must
    // never spread to Coos Bay's separate structural charge.
    if (finding.discipline === 'electrical' && /^https:\/\/co\.coos\.or\.us\//i.test(b.corroboration.sourceUrl)) {
      const formIndex = ledger.evidence.findIndex(e => e.url === 'https://co.coos.or.us/files/5bb0a81e5/electrical_permit.pdf');
      const form = formIndex < 0 ? '' : String(ledger.corpus[formIndex]).replace(/\s+/g,' ');
      if (/12%\s*surcharge\s*\(?\s*\.?12\s*x\s*subtotal/i.test(form) && /Community Dev surcharge 5%/i.test(form)
        && !feeIncludesSurcharges(`${b.label ?? ''} ${hitLine.raw}`)) {
        const sourceUrl = ledger.evidence[formIndex].url;
        b.stateSurcharge = {percent:12,quote:'12% surcharge (.12 x subtotal)',sourceUrl};
        b.communitySurcharge = {percent:5,quote:'Community Dev surcharge 5%',sourceUrl};
      }
    }
  }
  return brackets;
}

/** One line for the notes trail, in the operator's vocabulary. Says CORROBORATED
 *  — never "verified", which belongs to a person (hard rule 3). */
export function corroborationNotes(brackets: FeeBracket[]): string[] {
  if (!brackets.length) return [];
  const done = brackets.filter((b) => b.corroboration?.corroborated);
  if (!done.length) {
    return ["NO BRACKET CORROBORATED: none of this schedule's rows was found printed — label and fee on one line — in anything this run retrieved. The numbers are research, unchecked against the document."];
  }
  const missing = brackets.filter((b) => !b.corroboration?.corroborated).map((b) => `$${b.feeUsd.toFixed(2)}`);
  return [
    `CORROBORATED ${done.length}/${brackets.length} bracket(s) against the fetched document — each one's label and fee found together on one printed line`
    + `${missing.length ? `; NOT corroborated: ${missing.join(", ")}` : ""}.`,
  ];
}

/** The note segments that carry the retrieval trail onto the stored row. */
export function retrievalNotes(finding: FeeScheduleFinding, ledger: FeeDocumentLedger, support: QuoteSupport): string[] {
  const out: string[] = [];
  if (!ledger.evidence.length) {
    out.push("RETRIEVAL: no document was opened this run — the finding rests on web search alone, and its quote could not be checked against any bytes we read.");
    return out;
  }
  const viaBrowser = ledger.evidence.filter((e) => e.via === "browser");
  out.push(
    `RETRIEVAL: read ${ledger.evidence.length} document(s) directly`
    + `${viaBrowser.length ? `, ${viaBrowser.length} of them through a headed browser because the site refused an ordinary HTTP client` : ""}`
    + ` — ${ledger.evidence.map((e) => `${e.kind} ${e.status} ${e.url}`).join("; ")}`.slice(0, 600),
  );
  if (ledger.evidence.some((e) => e.kind === "pdf")) {
    out.push("PDF rows were paired BY COORDINATE (same printed line, left to right), not in the PDF's text order.");
  }
  out.push(
    support.quoteVerified
      ? `Quote verified: "${support.matchedFragment}" appears verbatim in the retrieved document.`
      : "QUOTE NOT VERIFIED: no 15-character run of the stored quote appears in anything this run retrieved. Check it against the source before quoting a customer.",
  );
  if (!support.feesVerified && support.missingFees.length) {
    out.push(`FEE NOT FOUND IN THE RETRIEVED TEXT: ${support.missingFees.map((f) => `$${f}`).join(", ")} — the amount does not appear in the document we read.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE REST OF THE BILL — ancillary charges, gated on retrieved bytes.
//
// The ask used to be one sentence long ("find the permit fee schedule line…
// extract the full bracket table for the solar/renewable-energy line") and the
// researcher answered it faithfully: one line. A real paid City of Portland
// receipt for one 3.520 kW rooftop system is FOUR SEPARATE BILLS FROM THREE
// BUREAUS — fire plan review $50.00; electrical permit $201.00 + $24.12 state
// surcharge; land use review $217.00 + building plan review/processing $99.45
// (which is 65% of the building permit); building permit $153.00 + $18.36 state
// surcharge. $762.93 in total, against $354.00 of permit lines. Plan review,
// land use review, fire review and processing were never requested, so they were
// never held, so no quote built from this table could reach a real total.
//
// WIDENING THE ASK IS ONLY HALF THE FIX, and the other half is this gate. The
// moment you ask a model for "every other charge on this filing" you have asked a
// question it can answer plausibly from priors: nearly every jurisdiction in the
// country has a plan-review fee, most express it as a percentage, and 65% is a
// real number in several of them. An unchecked list like that is the most
// convincing wrong answer this system is capable of producing, and it would land
// on a customer quote looking exactly like the researched half.
//
// So: the SAME standard corroborateBrackets applies, for the same reason —
// CO-OCCURRENCE ON ONE PRINTED LINE. The charge's own label and its amount (or
// its percentage) in one coordinate-paired row we actually retrieved. A charge
// that fails is DROPPED rather than stored uncorroborated, which is the one place
// this module is stricter about an ancillary charge than about a bracket (see
// normalizeAncillaryCharges for why), and the DROPS ARE COUNTED IN THE NOTES:
// "we dropped three" and "there were none" are different facts, and only the
// second one reads as reassurance.
// ---------------------------------------------------------------------------

/** Is this percentage printed on this line AS A PERCENTAGE OF ITS OWN? The
 *  numeric sibling of feeOnLine: without the leading guard, a charge reported as
 *  "65%" would corroborate off a line printing "165%". */
function percentOnLine(folded: string, percent: number): boolean {
  return [String(percent), percent.toFixed(1), percent.toFixed(2)].some((form) => {
    const esc = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^\\d.])${esc}\\s*%`).test(folded);
  });
}

/** Check every ancillary charge the model reported against the bytes THIS RUN
 *  retrieved, and return the survivors plus a named list of what was refused.
 *
 *  `reported` is raw model output — it is never trusted, never stored as it
 *  arrives, and the only field of it that reaches storage unexamined is prose.
 *  The survivors come back through normalizeAncillaryCharges, the same function
 *  the storage boundary uses, so the notes and the stored row cannot drift. */
export function corroborateAncillaryCharges(
  reported: unknown,
  finding: FeeScheduleFinding,
  ledger: FeeDocumentLedger,
): { held: FeeAncillaryCharge[]; dropped: string[] } {
  const items = Array.isArray(reported) ? reported.slice(0, 60) : [];
  if (!items.length) return { held: [], dropped: [] };

  const lines: Array<{ raw: string; folded: string; doc: number }> = [];
  ledger.corpus.forEach((body, doc) => {
    const documentLines = String(body ?? "").split("\n").map((l) => l.trim());
    for (const [index, raw] of documentLines.entries()) {
      if (!raw) continue;
      lines.push({ raw, folded: matchKey(raw), doc });
      // A WRAPPED ROW IS STILL ONE ROW, and refusing to see that costs real
      // charges. MEASURED, not imagined: Portland's adopted electrical schedule
      // prints its plan-review charge across two printed lines —
      //     p2  Plan Review Fee
      //     p2  25% of total electrical permit fee - Maximum number of allowable checksheets: 2
      // — and the live pass reported it, correctly, as one charge with both
      // halves in its label. Nothing matched, so a published, mandatory 25% plan
      // review was dropped. That is a false negative, not safety.
      //
      // The pairing is deliberately the NARROWEST shape that fixes it, and it is
      // generic rather than a patch for one document: line N is joined to line
      // N+1 ONLY when N names no money of its own and N+1 does — a label cell
      // above its value cell. A priced line never absorbs its neighbour, so the
      // wind row printed under the solar row can still never lend it a fee, and
      // the whole-label requirement below is unchanged.
      const next = documentLines[index + 1] ?? "";
      if (!next || /[$%]/.test(raw) || !/[$%]/.test(next)) continue;
      const joined = `${raw.replace(/^p\d+\s+/, "")} — ${next.replace(/^p\d+\s+/, "")}`;
      lines.push({ raw: joined, folded: matchKey(joined), doc });
    }
  });
  // Prefer the cited final schedule over earlier exploratory copies — the same
  // ordering rule corroborateBrackets applies, for the same reason.
  lines.sort((a, b) => Number(clean(ledger.evidence[b.doc]?.url) === clean(finding.sourceUrl))
    - Number(clean(ledger.evidence[a.doc]?.url) === clean(finding.sourceUrl)));

  const candidates: Record<string, unknown>[] = [];
  const dropped: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const label = clean(c.label).slice(0, 200);
    const named = label || "(unlabelled charge)";
    const amountUsd = num(c.amountUsd);
    const percent = num(c.percent);
    const hasAmount = amountUsd != null && amountUsd >= 0;
    const hasPercent = percent != null && percent > 0 && percent <= 100;
    if (hasAmount === hasPercent) { dropped.push(`${named} — neither a single amount nor a single percentage`); continue; }
    // Deliberately the WHOLE label (and the label with its inline amount
    // removed), never small pieces of it: "plan review" is a fragment of half the
    // rows in a fee schedule, and matching on it is the wind-row mis-attribution
    // this module already learned once.
    const fragments = labelFragments(label);
    if (!fragments.length) { dropped.push(`${named} — label too short to pin one printed row`); continue; }
    const hit = lines.find((l) => fragments.some((f) => l.folded.includes(f))
      && (hasAmount ? feeOnLine(l.folded, amountUsd as number) : percentOnLine(l.folded, percent as number)));
    // NO LEDGER MEANS NO SURVIVORS, and that is intended: a finding resting on
    // web search alone keeps its permit line (advisory, as everywhere else here)
    // and loses this list, because a list nothing was read for is the one shape a
    // fabrication and a reading are indistinguishable in.
    if (!hit) { dropped.push(named); continue; }
    candidates.push({
      ...c,
      label,
      matchedLine: hit.raw.slice(0, 300),
      sourceUrl: clean(ledger.evidence[hit.doc]?.url) || clean(finding.sourceUrl),
    });
  }
  const held = normalizeAncillaryCharges(candidates);
  // The normaliser can still refuse (the cap, a shape it will not store). A
  // refusal there is a drop too, and an uncounted drop is a silent loss.
  const kept = new Set(held.map((c) => c.label.toLowerCase()));
  for (const c of candidates) {
    const label = clean(c.label);
    if (!kept.has(label.toLowerCase())) dropped.push(`${label || "(unlabelled charge)"} — refused at the storage boundary`);
  }
  return { held, dropped };
}

/** Put the surviving charges on the brackets — and REFUSE TO BILL A SURCHARGE
 *  TWICE while doing it.
 *
 *  Every bracket gets the list, because these charges are levied on the FILING
 *  and nothing here knows which size tier a future job will land in; the
 *  evaluator reads only the bracket it matched, so one list per bracket yields
 *  exactly one instance per quoted line.
 *
 *  THE DOUBLE-CHARGE. A 12% state surcharge now has two roads onto the same
 *  bracket: corroborateBrackets can attach `stateSurcharge`, which the evaluator
 *  folds INTO the line's own fee, and this list can hold the identical 12% as a
 *  charge added ON TOP of it. A bracket carrying both bills the customer the
 *  surcharge twice, and the arithmetic would look deliberate. Coos County and
 *  Tigard print exactly the sentences that fire the bracket-level path, so this
 *  is reachable today and not a hypothetical. Per BRACKET, because the two
 *  channels are per bracket: a row whose own surcharge field is empty keeps the
 *  ancillary one, which is the only way the charge survives at all where the
 *  narrow bracket-level detector does not fire. */
export function attachAncillaryCharges(brackets: FeeBracket[], held: FeeAncillaryCharge[]): void {
  if (!held.length) return;
  for (const b of brackets) {
    const alreadyInTheLine = [b.stateSurcharge?.percent, b.communitySurcharge?.percent]
      .filter((p): p is number => typeof p === "number");
    const mine = held.filter((c) => !(c.kind === "surcharge" && c.percent != null && alreadyInTheLine.includes(c.percent)));
    if (mine.length) b.ancillaryCharges = mine.map((c) => ({ ...c }));
    else delete b.ancillaryCharges;
  }
}

/** The notes trail for the rest of the bill. Reads the charges back OFF THE
 *  BRACKETS — the same grain and the same contract as corroborationNotes — so the
 *  sentence an operator reads and the row that was stored are one fact, not two
 *  that can drift. */
export function ancillaryChargeNotes(brackets: FeeBracket[], dropped: string[]): string[] {
  const noPipe = (s: string): string => s.replace(/\s*\|\s*/g, " / ");
  // THE UNION ACROSS BRACKETS, not the first bracket's list: attachAncillaryCharges
  // drops a surcharge from the rows that already carry it inside their own fee, so
  // reading one bracket would under-report what the row holds.
  const held: FeeAncillaryCharge[] = [];
  const seen = new Set<string>();
  for (const b of brackets) {
    for (const c of b.ancillaryCharges ?? []) {
      const key = `${c.label.toLowerCase()}|${c.amountUsd ?? `${c.percent}%`}`;
      if (seen.has(key)) continue;
      seen.add(key);
      held.push(c);
    }
  }
  const out: string[] = [];
  if (held.length) {
    const itemised = held.map((c) => {
      const money = c.amountUsd != null ? `$${c.amountUsd.toFixed(2)}` : `${c.percent}%${c.percentOf ? ` ${c.percentOf}` : ""}`;
      return `${noPipe(c.label)} ${money}`
        + `${c.appliesTo ? ` [${c.appliesTo} filing]` : ""}`
        + `${c.conditional ? ` (CONDITIONAL${c.condition ? `: ${noPipe(c.condition)}` : ""})` : ""}`;
    }).join("; ").slice(0, 900);
    out.push(
      `ANCILLARY CHARGES HELD (${held.length}) — this filing draws more than the permit line, and NONE of these is inside the permit fee above: `
      + `${itemised}. Held as corroborated evidence; NOT yet totalled into any quote.`,
    );
  }
  if (dropped.length) {
    out.push(
      `${dropped.length} REPORTED ANCILLARY CHARGE(S) NOT STORED — nothing this run retrieved prints the label and its amount together on one line: `
      + `${dropped.map(noPipe).join("; ").slice(0, 600)}. The real filing may still owe them; this row does not price them.`,
    );
  }
  if (!held.length && !dropped.length) {
    out.push(
      "NO ANCILLARY CHARGES REPORTED — research named no plan-review, land-use, fire-review, processing or surcharge line beyond the permit fee."
      + " That is an ABSENCE OF REPORT, not a finding that this jurisdiction levies nothing else: a real filing here may still arrive as several"
      + " separate bills from several bureaus, so this row is a permit line and not a total.",
    );
  }
  return out;
}

const FEE_RESEARCH_SYSTEM = `You research PUBLISHED FEE SCHEDULES for residential solar work and return them as structured data.

WHAT YOU ARE LOOKING FOR
A jurisdiction's fee schedule is a FUNCTION, not a price. Most AHJ schedules are long documents mostly about new construction; you want the SOLAR / PHOTOVOLTAIC / RENEWABLE-ENERGY line item specifically. Those lines are usually BRACKETED — a real example reads "Renewable energy for electrical systems - 5.01kva through 15kva", with further rows for larger systems. When a bracket table exists, extract EVERY row, not just the one you think applies: the permit application asks which bracket, so the table is the answer, and a single dollar amount is not.

Identify which variable the schedule keys on and say so in "basis":
  "system_kw"  — brackets keyed on system size in kVA/kW (use minKw/maxKw; kVA and kW are the same number on these schedules)
  "valuation"  — brackets keyed on job valuation / declared value (use minValuationUsd/maxValuationUsd)
  "flat"       — one charge regardless of size (a single bracket, no bounds)
  "other"      — anything else; explain in notes

ANSWER FOR THE AUTHORITY YOU WERE ASKED ABOUT, AND NO OTHER
This is the single most damaging mistake available to you, because its result looks perfect: a real fee, from a real published schedule, with a verbatim quote — filed under a jurisdiction that does not charge it.

A CITY and the COUNTY around it are different authorities with different schedules. So are a city's building department and its electrical inspection authority, and so are a utility and the state commission that regulates it. The fee you return must be one THE NAMED AUTHORITY ITSELF PUBLISHES AND COLLECTS.

The trap is that schedules cross-reference each other. The City of Coos Bay's own schedule says "Solar Structural Installation Permits – separate Electrical Permit application may also be required through the county". That sentence tells you the CITY does not charge the electrical fee. It does NOT make the county's bracket table the city's fee, and returning that table when asked about the city is wrong even though every number in it is real.

So:
  · If you were given an AHJ, return what that AHJ charges. If the only schedule you can find belongs to a different authority, return found:false and say in "reason" which authority publishes what you found, with its URL. A pointer is a useful answer; a misfiled fee is not.
  · Never mix two authorities' lines into one schedule. One row from the city and three from the county is not a fee table, it is two tables stapled together, and no project can be priced from it.
  · Name the authority in "notes" — "this is <authority>'s own adopted schedule" — so the next reader can check the filing without re-doing the search.

HOW TO WORK: SEARCH FINDS THE DOOR, open_document WALKS THROUGH IT
Use web_search to LOCATE the jurisdiction's fee page, document search or schedule PDF. Then use open_document to READ it. A search snippet is a lead, not a source: snippets and third-party summaries routinely staple a fee to the wrong line of a table. One real case — a summary of a county electrical schedule reported $346 and $796 for two solar brackets, because it had taken the amounts off the WIND GENERATION rows printed below them. The published numbers were $160 and $265. Only the document says which row a number is on.

open_document climbs to a real browser window by itself when a site refuses an ordinary HTTP client, so DO NOT give up on a .gov page because it seems to block automation — try it. It reads PDF tables BY COORDINATE, returning the cells that share a printed line joined with " | ", which is the same pairing your eye makes and is NOT the order the text sits in the file.

A GOOD SEQUENCE: search → open_document on the fee page (read its links) → open_document on the schedule PDF with find:"solar" or find:"renewable" to locate the table → open_document again with pages:[N] to read that whole page, headings included → quote the row.

SUPERSESSION: fee schedules are dated and replaced. When you find one, check whether a NEWER schedule exists (search the fee page for a later effective date) and say in notes which document you used and why. A permit-application FORM often carries fees years out of date; the adopted schedule wins.

EVERY NUMBER NEEDS A QUOTE, AND THE QUOTE MUST BE A ROW YOU READ
"sourceQuote" must be the actual table row or sentence carrying the fee, copied verbatim. Where open_document returned a row, quote that row's text exactly as it came back to you — including its " | " separator between the description and the amount — and name the document and page after it in square brackets. What you read is checked against the bytes we retrieved, so a paraphrase is visibly worse than a copy. DO NOT GUESS A FEE. If you cannot find a quotable sentence, return found:false with a reason — an unsourced number is worse than no number, because it will be filed on a real application.

SOURCES
PREFER the jurisdiction's own domain (.gov / .us) or the utility's own site — the published fee schedule PDF or fee page. A state rule or commission order (e.g. an OAR on oregon.gov) is official too, and is the right source for "the utility may not charge for this": say in notes whose domain it is. A third-party summary (solar blog, aggregator, permitting vendor) is acceptable ONLY as a last resort and ONLY if you set sourceKind "third_party" and say so in notes.

HOW IT IS PAID IS PART OF THE FEE
Set "paymentMethod" to how the money actually moves: "portal" (paid online at the portal's own checkout), "mailed_check" (a paper check is posted — there is no online payment), "none" (there is no fee to pay), or "unknown" if the source does not say. This matters more than it looks: Ameren Illinois' $50 Level 1 fee is paid BY MAILED CHECK within 15 business days and the application is not reviewed until the check arrives, so an operator who believes it is payable in the portal has a filing that silently stalls. Say so in notes too, with the deadline if the source states one.

"NO FEE" IS AN ANSWER
Most residential net-metering / interconnection applications carry no utility fee. If the utility's own documentation says so, that is a REAL FINDING: return found:true, basis "flat", one bracket with feeUsd 0, and the sentence that says it. Some utilities do charge — Ameren Illinois, for example, charges a $50 Level 1 interconnection fee paid by mailed check — so check, do not assume. Return found:false ONLY when you genuinely could not determine it.

ONE FILING, SEVERAL BILLS — THE PERMIT LINE IS NOT THE PRICE (permit schedules only)
Returning only the permit fee line is an INCOMPLETE ANSWER, and it is the single most common way this research goes wrong. A residential solar filing routinely produces SEVERAL SEPARATE BILLS FROM SEVERAL BUREAUS of the same jurisdiction. One real paid receipt — a 3.5 kW rooftop system, one address, one day — came to four bills from three bureaus: a fire plan review charge, an electrical permit plus a state surcharge, a land use review plus a building plan-review/processing charge, and a building permit plus its own state surcharge. The two permit lines were less than half the money. An answer holding only the permit line would have quoted that customer a fraction of what they paid.

So for the filing you were asked about, ALSO collect every OTHER charge the jurisdiction levies on it, in "ancillaryCharges":
  · PLAN REVIEW / plan check — very often a PERCENTAGE of the permit fee (65% is common), sometimes a flat charge.
  · LAND USE / zoning / planning review.
  · FIRE or life-safety review.
  · PROCESSING, technology, records, or administrative fees.
  · STATE and LOCAL SURCHARGES — normally a percentage of the permit fee (Oregon's state surcharge is 12%).
For EACH one give: the label EXACTLY AS PRINTED; either its dollar amount OR its percentage together with what the percentage is taken OF — NEVER pre-multiply a percentage into dollars, report 65%, not the product, because the product is only true for one job; whether it is MANDATORY or CONDITIONAL and on what; which filing it rides (the building permit, the electrical permit, or the filing as a whole); and the verbatim printed line and the URL it came from.

ONLY WHAT THE SCHEDULE PRINTS. Every one of these is checked against the bytes we retrieved, the same way the permit line is: a charge whose label and amount you did not read together on a line of a document you opened is DROPPED. If the jurisdiction genuinely levies nothing beyond the permit fee, return an EMPTY list — an honest absence is a correct answer here. Do not add a plan-review fee because most jurisdictions have one.

THE LABEL IS THE PRINTED ROW, NOT A SENTENCE ABOUT IT — this is where real charges are lost. One measured case: Oregon's state surcharge came back as "Surcharge. For all building, plumbing, electrical, and mechanical permits, a 12% surcharge is applied by the State of Oregon." That sentence is TRUE and it is printed on no document the pass opened, so the charge was dropped — while the permit application opened in the same pass printed the row "State surcharge (12% of permit fee)", which would have been held. If a document you opened prints the charge, the label MUST BE THAT PRINTED LINE, copied (both halves, joined, when the label cell sits above its value cell). Anything you want to explain goes in "condition" or in "notes".

MANDATORY CHARGES FIRST, and mark "conditional" honestly. List the ones this jurisdiction levies on EVERY filing of this kind before the ones that apply only sometimes. The distinction is arithmetic, not emphasis: a charge marked conditional cannot be priced until a person confirms it applies, so a mandatory charge mis-marked conditional leaves every quote for this jurisdiction UNRESOLVED, and a conditional one mis-marked mandatory over-charges a real customer.

THIS DOES NOT WIDEN WHICH PERMIT YOU ARE PRICING. The discipline scoping above still holds exactly as it did: "brackets" is still that one permit's table and nothing else. Charges that ride the OTHER discipline's filing are reported with "appliesTo" naming that filing, never folded into this one.

"appliesTo" IS ARITHMETIC, NOT A LABEL. Leave it empty ONLY for a charge that is genuinely levied on EVERY permit in the filing — a percentage surcharge is the usual case, and the receipt above really does carry the state surcharge twice, once on each permit. A FLAT charge billed ONCE for the whole job (a single fire plan review, a single land use review) must NAME the filing it is billed with, because a flat charge left unattributed is charged again on every permit we price and the customer is quoted it twice.

Return ONLY JSON:
{
  "found": true|false,
  "reason": "<when found:false, why — 'no published schedule located', 'fee page found but no solar line', etc.>",
  "basis": "system_kw|valuation|flat|other",
  "brackets": [
    { "minKw": 5.01, "maxKw": 15, "feeUsd": 175, "label": "<the schedule's OWN wording for this row, verbatim>" }
  ],
  "ancillaryCharges": [
    { "label": "<the schedule's OWN wording for this charge, verbatim>",
      "kind": "plan_review|land_use_review|fire_review|processing|surcharge|other",
      "amountUsd": 50,
      "percent": null,
      "percentOf": "<what the percentage is taken of, in the document's words; omit on a flat charge>",
      "conditional": false,
      "condition": "<when it applies, if it does not always>",
      "appliesTo": "structural|electrical|combo|<empty for the filing as a whole>",
      "quote": "<the verbatim printed line carrying this charge>",
      "sourceUrl": "<the document it is printed in>" }
  ],
  "notes": "<short segments: what the schedule covers, whether it is combined building+electrical, plan-review percentages, which document and effective date you used and whether a newer one exists, anything a coordinator must know. Say plainly if this is a third-party source.>",
  "paymentMethod": "portal|mailed_check|none|unknown",
  "sourceUrl": "<the page/PDF the numbers came from>",
  "sourceQuote": "<the verbatim sentence or table row carrying the fee>",
  "sourceKind": "official|third_party"
}`;

function parseResearchJson(raw: string): Record<string, unknown> {
  try {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/(\{[\s\S]*\})/);
    const parsed = JSON.parse(match ? match[1] : raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function emptyFinding(reason: string): FeeScheduleFinding {
  return { found: false, reason, basis: "other", brackets: [], notes: "", sourceUrl: "", sourceQuote: "", sourceKind: "" };
}

// SEARCH FINDS THE DOOR; open_document WALKS THROUGH IT — AND THE VARIANT MATTERS.
//
// web_search_20260209 filters its results with code execution running under the
// hood, so an assistant turn that searched leaves a live container behind. In a
// SINGLE-turn call that is invisible. In the tool loop below it is fatal: the next
// request is refused outright with
//     400 "container_id is required when there are pending tool uses generated by
//         code execution with tools"
// and the response carries no container id to send back. Measured twice against
// Coos County — both runs died at turn two, after open_document had already
// retrieved the county's solar page, and the failure arrived at the fee sheet as
// "research failed" on a jurisdiction that publishes its schedule plainly.
//
// The basic variant runs no container and loops fine. We lose the server's own
// result filtering and lose nothing that matters: this researcher does not read
// pages through the search tool. It reads them through open_document, which climbs
// to a real browser when a site refuses a script and pairs PDF rows by coordinate —
// neither of which any server-side fetch does for us.
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 8 };

/** How many times the model may call open_document in one pass. A fee page, the
 *  schedule PDF, a find, a page-in-full and a supersession check is five; ten
 *  leaves room to follow a wrong link and come back. */
export const FEE_RESEARCH_MAX_DOCUMENTS = 10;
/** Assistant turns. Each turn may carry several tool calls, so this is not the
 *  same ceiling as the one above. */
const FEE_RESEARCH_MAX_TURNS = 12;

/**
 * THE ANSWER'S TOKEN CEILING, AND WHY IT IS NOT 4,000 ANY MORE.
 *
 * Measured on a real pass over five jurisdictions: THREE of the five came back
 * `stop_reason: max_tokens` — City of Portland (structural), City of Lincoln City and City of
 * Salem — and their truncated JSON parsed to nothing. The refusal was honest (the reason string
 * below says a cut-off answer is not a finding of "no schedule"), but a 60% failure rate is the
 * ask outgrowing its budget, not bad luck, and the code's own comment already admitted the ask
 * had widened — "a permit pass now asks for the whole filing, not one line" — without the
 * ceiling moving with it.
 *
 * Two things share this budget: `thinking: {type: "adaptive"}` and the answer. A jurisdiction
 * like Portland publishes a six-rung valuation ladder, each rung's verbatim label running well
 * over a hundred characters, plus the filing's surcharges and reviews. Reasoning about which of
 * several retrieved PDFs is the current one and then emitting all of that does not fit in 4,000
 * tokens alongside the thinking that chose it.
 *
 * A ceiling is not a spend: output tokens are billed as generated, so a pass that only needs
 * 3,000 still costs 3,000. What the old number bought was not savings — it was a wasted call,
 * and then a second call to retry it.
 */
const FEE_RESEARCH_MAX_ANSWER_TOKENS = 16000;

/** The SDK client's own ceiling, below. The outer AbortController must never be the
 *  tighter of the two, or the client's timeout and its retries are unreachable. */
export const FEE_RESEARCH_CLIENT_TIMEOUT_MS = 240000;

/** How long one research call may run before it is abandoned.
 *
 *  A WEB-GROUNDED SEARCH IS NOT A CHAT TURN. This call reads fee pages and PDFs across up to
 *  six searches; measured live against the four jurisdictions we actually file in, it took
 *  62s, 66s, 82s and 69s. The previous 60s ceiling therefore aborted EVERY real call — and an
 *  abort comes back as found:false with a reason, which is the same channel a jurisdiction
 *  that publishes nothing comes back on. So automatic fee research was off by default and
 *  said nothing about it: the fee sheet simply reported no schedule, for every jurisdiction,
 *  forever.
 *
 *  Exported so the default itself is testable — the failure was a CONSTANT, and a constant
 *  nothing asserts is a constant that regresses. */
export function feeResearchTimeoutMs(): number {
  const configured = Number(process.env.FEE_RESEARCH_TIMEOUT_MS);
  return configured > 0 ? configured : FEE_RESEARCH_CLIENT_TIMEOUT_MS;
}

/** Default researcher: web-grounded Claude. Self-contained rather than routed
 *  through llm.ts because LLMProvider is the shared type surface and this build
 *  does not own it; the call mirrors askWithWebSearch (streamed, hard-timed-out
 *  so a stalled search can never hang a request). No API key → found:false with
 *  a reason, never a fabricated schedule. */
export const claudeFeeScheduleResearcher: FeeScheduleResearcher = async (input, options) => {
  const apiKey = sanitizeApiKey(process.env["ANTHROPIC_API_KEY"]);
  if (!apiKey) return emptyFinding("No ANTHROPIC_API_KEY configured — fee-schedule research is off. Enter the schedule by hand from the jurisdiction's fee page.");

  const who = input.track === "nem"
    ? `Utility: ${clean(input.utility) || "(unknown)"}`
    : `AHJ: ${clean(input.ahj) || "(unknown)"}`;
  // WHICH PERMIT, when the caller knows. A split jurisdiction publishes a
  // structural table AND an electrical one; an unscoped ask returns whichever a
  // search surfaces first, filed as though it priced everything.
  const askedDiscipline = input.track === "nem" ? "" : feeDiscipline(input.discipline);
  const disciplineAsk =
    askedDiscipline === "structural"
      ? "This research is for the BUILDING/STRUCTURAL permit specifically: extract that permit's fee line, not the electrical permit's (some jurisdictions file the two separately, sometimes with different authorities)."
      : askedDiscipline === "electrical"
        ? "This research is for the ELECTRICAL permit specifically: extract that permit's fee line, not the building/structural permit's (some jurisdictions file the two separately, sometimes with different authorities)."
        : askedDiscipline === "combo"
          ? "This research is for a COMBINATION (building + electrical in one filing) solar permit: extract the fee for the combined solar permit as this jurisdiction publishes it."
          : "";
  const userMsg = [
    who,
    `State: ${clean(input.state)}`,
    input.track === "nem" && input.ahj ? `AHJ (context only): ${clean(input.ahj)}` : "",
    input.track === "permit" && input.utility ? `Utility (context only): ${clean(input.utility)}` : "",
    input.knownContext ? `\n${input.knownContext}` : "",
    "",
    input.track === "nem"
      ? "Find the published APPLICATION / INTERCONNECTION FEE for a residential net-metering (net energy metering) application to this utility. If there is none, say so with the sentence that says so."
      // ONE PASS, A WIDER ASK — not a second pass. This is the most expensive
      // operation in the system (up to twelve web-grounded turns and ten document
      // retrievals), so the fix for "a quote cannot reach a real total" is to
      // collect the whole filing while the schedule is already open, never to go
      // back for the rest of it.
      : "Find the published PERMIT FEE SCHEDULE line for a residential rooftop solar PV installation in this jurisdiction (building and/or electrical permit). Extract the full bracket table for the solar/renewable-energy line.\n"
        + "THEN, FROM THE SAME SCHEDULE, collect every OTHER mandatory or commonly-applied charge this jurisdiction bills on that same filing — plan review, land use / planning review, fire or life-safety review, processing/technology/records fees, and state or local surcharges — into \"ancillaryCharges\". The permit line alone is NOT this filing's price: one paid residential solar filing here can arrive as several separate bills from several bureaus, and a quote built from the permit line only is short by more than half in jurisdictions that work that way. Report a percentage as a percentage, never pre-multiplied, and return an empty list if the schedule genuinely levies nothing else.",
    disciplineAsk,
  ].filter(Boolean).join("\n");

  const model = process.env.AUTOPILOT_LLM_MODEL || "claude-opus-5";
  const timeoutMs = feeResearchTimeoutMs();
  const controller = new AbortController();
  let timedOut = false;
  // ONE DEADLINE FOR THE WHOLE PASS, not per call. The loop below may take five
  // turns and open ten documents; a per-call clock would let a pass that keeps
  // making progress run without any ceiling at all.
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const ledger = options?.ledger ?? newFeeDocumentLedger();
  try {
    const client = new Anthropic({ apiKey, maxRetries: 3, timeout: FEE_RESEARCH_CLIENT_TIMEOUT_MS });
    logger.debug("fees", "→ researchFeeSchedule", { model, track: input.track, state: input.state });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages: any[] = [{ role: "user", content: userMsg }];
    let raw = "";
    let opened = 0;
    let exhausted = "";
    // WHY THE ANSWER STOPPED, kept beside the answer itself. The ask above is
    // wider than it was — a permit pass now asks for the whole filing, not one
    // line — and the failure mode that buys is a reply CUT OFF at max_tokens,
    // whose truncated JSON parses to nothing and arrives as found:false. That is
    // the same channel "this jurisdiction publishes no schedule" arrives on, and
    // the two must never be confusable (the same lesson the timeout wording
    // below was written for).
    let lastStop = "";
    // A container is carried forward when the server hands one back. It normally
    // does not here — see WEB_SEARCH_TOOL — but a null id must never be sent.
    let containerId: string | null = null;

    const who4 = `${input.track}:${clean(input.state)}:${(clean(input.ahj) || clean(input.utility) || "?").slice(0, 40)}`;
    for (let turn = 0; turn < FEE_RESEARCH_MAX_TURNS; turn++) {
      if (Date.now() >= deadline) { timedOut = true; controller.abort(); break; }
      const startedAt = Date.now();
      const t0 = performance.now();
      const msg = await client.messages
        .stream(
          {
            model,
            max_tokens: FEE_RESEARCH_MAX_ANSWER_TOKENS,
            thinking: { type: "adaptive" },
            ...(containerId ? { container: containerId } : {}),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            tools: [WEB_SEARCH_TOOL, OPEN_DOCUMENT_TOOL] as any,
            // THE SYSTEM PROMPT IS RE-SENT ON EVERY TURN OF THIS LOOP, unchanged —
            // it is the one part of the request that never varies while the message
            // list grows. Twelve turns per jurisdiction, several jurisdictions per
            // fee-sheet run, all inside the cache's five-minute window: this prompt
            // is the textbook case for caching and was the only multi-turn loop in
            // the codebase not doing it. It clears the 512-token Opus 5 minimum on
            // its own (see the MODEL note in llm.ts).
            system: [{ type: "text", text: FEE_RESEARCH_SYSTEM, cache_control: { type: "ephemeral" } }],
            messages,
          },
          { signal: controller.signal },
        )
        .finalMessage();
      // EVERY TURN IS A RECORD, and it carries the cache columns on purpose: a
      // cache that silently stops hitting looks exactly like a cache that is
      // working, right up until the bill. cacheRead near zero on turn two of a pass
      // is the signal, and it is only visible if it is written down.
      recordLlmCall({
        at: startedAt,
        label: `researchFeeSchedule[${who4}]#${turn + 1}`,
        model,
        ms: Math.round(performance.now() - t0),
        inTok: msg.usage?.input_tokens,
        outTok: msg.usage?.output_tokens,
        cacheRead: msg.usage?.cache_read_input_tokens ?? undefined,
        cacheWrite: msg.usage?.cache_creation_input_tokens ?? undefined,
        stop: msg.stop_reason,
      });
      containerId = msg.container?.id ?? containerId;

      const text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
      if (text.trim()) { raw = text; lastStop = clean(msg.stop_reason); }
      // The assistant turn goes back VERBATIM — thinking blocks, server-side
      // web_search results and all. Reconstructing it would drop the search
      // results the model is reasoning from.
      messages.push({ role: "assistant", content: msg.content });

      const calls = msg.content.filter(
        (b) => b.type === "tool_use" && (b as { name?: string }).name === OPEN_DOCUMENT_TOOL.name,
      ) as Array<{ id: string; input: Record<string, unknown> }>;
      if (!calls.length) break;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results: any[] = [];
      for (const call of calls) {
        if (opened >= FEE_RESEARCH_MAX_DOCUMENTS) {
          exhausted = `the ${FEE_RESEARCH_MAX_DOCUMENTS}-document budget for one research pass`;
          results.push({ type: "tool_result", tool_use_id: call.id, content: `Document budget spent (${FEE_RESEARCH_MAX_DOCUMENTS} retrievals). Answer now from what you have read, or return found:false saying what you would have needed to open.` });
          continue;
        }
        if (Date.now() >= deadline) { timedOut = true; controller.abort(); break; }
        opened++;
        const body = await openFeeDocument(call.input || {}, ledger, { timeoutMs: 25_000 });
        results.push({ type: "tool_result", tool_use_id: call.id, content: body.slice(0, 60_000) });
      }
      if (timedOut) break;
      messages.push({ role: "user", content: results });
      if (turn === FEE_RESEARCH_MAX_TURNS - 1) exhausted = `the ${FEE_RESEARCH_MAX_TURNS}-turn ceiling for one research pass`;
    }
    if (timedOut) throw new Error("aborted");

    const parsed = parseResearchJson(raw);
    const basisRaw = clean(parsed.basis).toLowerCase();
    const finding: FeeScheduleFinding = {
      found: parsed.found === true,
      reason: clean(parsed.reason),
      basis: (["system_kw", "valuation", "flat", "other"].includes(basisRaw) ? basisRaw : "other") as FeeBasis,
      brackets: Array.isArray(parsed.brackets) ? normalizeBrackets(parsed.brackets) : [],
      notes: clean(parsed.notes).slice(0, 2000),
      paymentMethod: normalizeFeePaymentMethod(parsed.paymentMethod),
      sourceUrl: clean(parsed.sourceUrl).slice(0, 500),
      sourceQuote: clean(parsed.sourceQuote).slice(0, 1000),
      sourceKind: clean(parsed.sourceKind).toLowerCase() === "official" ? "official" : clean(parsed.sourceKind) ? "third_party" : "",
      evidence: ledger.evidence,
      neededBrowser: ledger.evidence.some((e) => e.via === "browser"),
    };
    // GO AND READ THE DOCUMENT IT CITED, IF IT DID NOT ALREADY.
    //
    // Without this, corroboration is opportunistic: it can only check bytes the
    // model happened to open, so a finding sourced from web search alone could
    // never be corroborated even when its URL is one GET away. The operator's
    // ask was "verify it while you are looking it up", and this is the half that
    // makes that true rather than lucky.
    //
    // OUTSIDE the document budget (that ceiling governs the MODEL's exploration,
    // not our verification) and INSIDE the pass deadline, which is the only
    // clock that may stop this. openFeeDocument never throws and never refuses a
    // finding — a fetch that fails simply leaves the brackets uncorroborated.
    const alreadyRead = new Set(ledger.evidence.map((e) => clean(e.url)));
    // Discipline is caller-owned; the model schema may omit it entirely.
    if (input.discipline) finding.discipline = feeDiscipline(input.discipline);
    if (finding.found && finding.sourceUrl && !alreadyRead.has(clean(finding.sourceUrl)) && Date.now() < deadline) {
      await openFeeDocument({ url: finding.sourceUrl }, ledger, { timeoutMs: 25_000 });
    }
    if (finding.found && finding.discipline === 'electrical' && /^https:\/\/co\.coos\.or\.us\//i.test(finding.sourceUrl)) {
      const formUrl = 'https://co.coos.or.us/files/5bb0a81e5/electrical_permit.pdf';
      if (!ledger.evidence.some(e => e.url === formUrl)) await openFeeDocument({url:formUrl,pages:[1]},ledger,{timeoutMs:25_000});
    }
    // Re-derived from retrieved bytes, and it discards anything the model may
    // have attached to its own brackets. Runs BEFORE the quote check so the
    // notes describe the same corpus the corroboration was drawn from.
    finding.brackets = corroborateBrackets(finding, ledger);

    // THE REST OF THE BILL. Gated against the same corpus, then ATTACHED TO EVERY
    // BRACKET: these charges are levied on the FILING, not on one size tier, and
    // brackets_json is the structured column a schedule owns — so a bracket
    // carries its own list wherever the evaluator later picks it up. A permit
    // pass with no surviving charges still says so in notes; a NEM pass is left
    // alone entirely (the ask was never widened there, and an empty list would
    // print a sentence about bureaus on an interconnection fee).
    const ancillary = input.track === "nem"
      ? { held: [] as FeeAncillaryCharge[], dropped: [] as string[] }
      : corroborateAncillaryCharges(parsed.ancillaryCharges, finding, ledger);
    attachAncillaryCharges(finding.brackets, ancillary.held);

    // The check runs on every finding, saved or not, and its verdict travels in
    // the notes — a row whose quote nothing we read supports must say so where
    // the person reading the fee sheet will see it.
    const support = checkQuoteSupport(finding, ledger);
    finding.quoteVerified = support.quoteVerified;
    // A REPLY CUT OFF IS NOT A SCHEDULE READ. The wider ask makes a longer answer,
    // and a truncated one must never pass as a complete one.
    const truncated = lastStop === "max_tokens";
    if (finding.found) {
      finding.notes = mergeNotes(finding.notes, [
        ...retrievalNotes(finding, ledger, support),
        ...corroborationNotes(finding.brackets),
        ...(input.track === "nem" ? [] : ancillaryChargeNotes(finding.brackets, ancillary.dropped)),
        ...(truncated
          ? ["ANSWER TRUNCATED: the model stopped at its token ceiling (stop_reason max_tokens), so what is stored is as far as it got — charges it had not finished listing are missing, and this row is not a complete reading of the schedule."]
          : []),
      ]);
    }
    if (!finding.found && !finding.reason) {
      finding.reason = truncated
        ? "The research reply was CUT OFF at the token ceiling (stop_reason max_tokens) and its JSON could not be parsed — this is a truncated ANSWER, not a finding that this jurisdiction publishes no schedule. Re-run; if it recurs the ask is returning more than one reply can hold."
        : exhausted
          ? `Research ran out of room — it hit ${exhausted} before producing an answer. Re-run, or enter the schedule by hand from the jurisdiction's fee page.`
          : "Research returned no usable fee schedule.";
    }
    return finding;
  } catch (err) {
    // SAY WHICH FAILURE THIS WAS. A timeout surfaced as the SDK's bare "Request was aborted."
    // is the worst possible wording here: found:false already means "we could not find out",
    // and the fee sheet renders that beside the jurisdiction as though nothing is published.
    // Name the ceiling and the knob, so a run that ran out of clock cannot be mistaken for a
    // jurisdiction that charges nothing.
    const reason = timedOut
      ? `Fee-schedule research timed out after ${Math.round(timeoutMs / 1000)}s — this is a RUN that ran out of clock, NOT a finding that ${input.track === "nem" ? "this utility" : "this jurisdiction"} publishes no fee. Re-run, or raise FEE_RESEARCH_TIMEOUT_MS.`
      : `Fee-schedule research failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn("fees", "researchFeeSchedule failed", { track: input.track, state: input.state, timedOut, documentsRead: ledger.evidence.length });
    // THE FAILURE IS AN ACCOUNTING FACT TOO. A pass that burns four minutes of Opus
    // turns and then aborts has cost real money; recording only the successes would
    // make the expensive failure mode the invisible one. The turns that DID come
    // back are already recorded above — this is the one that did not.
    recordLlmCall({
      at: Date.now(),
      label: `researchFeeSchedule[${input.track}:${clean(input.state)}:${(clean(input.ahj) || clean(input.utility) || "?").slice(0, 40)}]#failed`,
      model,
      ms: 0,
      error: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (err instanceof Error ? err.message : String(err)),
    });
    // The retrieval trail survives the failure: "we were refused by the site" and
    // "we read the schedule and then the model fell over" are different problems,
    // and only the evidence list tells them apart.
    return { ...emptyFinding(reason), evidence: ledger.evidence, neededBrowser: ledger.evidence.some((e) => e.via === "browser") };
  } finally {
    clearTimeout(timer);
  }
};

/** Research this jurisdiction's/utility's published fee schedule and store it
 *  as a 'seeded' row. Always returns a structured outcome — a caller can tell
 *  "charges nothing" (found, flat $0) from "could not find out" (found:false),
 *  which the quote ladder's single "unknown" cannot. */
export async function researchFeeSchedule(
  db: AppDb,
  input: { state: string; ahj?: string; utility?: string; track?: string | null; discipline?: string },
  options: { researcher?: FeeScheduleResearcher; ledger?: FeeDocumentLedger } = {},
): Promise<FeeScheduleResearchOutcome> {
  const track = feeTrack(input.track);
  const profileKey = feeScheduleProfileKey(input, track);
  const subject = track === "nem" ? clean(input.utility) : clean(input.ahj);
  if (!subject) {
    return {
      found: false, saved: false, refusedVerified: false, refusedConflicted: false, profileKey, track, schedule: null, finding: null,
      reason: track === "nem" ? "utility is required to research a NEM fee schedule." : "ahj is required to research a permit fee schedule.",
    };
  }
  // Seed the search with what the KB already holds — several permit_utility_knowledge
  // rows carry the AHJ's own fee-page URL in their notes, which is the page we want.
  let knownContext: string | undefined;
  try {
    knownContext = knowledgeResearchHint(db, { state: input.state, ahj: input.ahj, utility: input.utility }, track === "nem" ? "utility" : "ahj")?.text;
  } catch { /* non-fatal: research still runs unseeded */ }

  const researcher = options.researcher || claudeFeeScheduleResearcher;
  // ONE LEDGER FOR THE PASS, OWNED HERE — not "whatever the caller happened to
  // pass". saveFeeSchedule now re-derives corroboration from the ledger and
  // strips it when there is none, so a caller that wanted a fee schedule but did
  // not care about the retrieval trail (scripts/fee-sheet.ts) would otherwise
  // have every bracket silently uncorroborated. Making it here means the bytes
  // the researcher read and the bytes the save checks against are the same
  // object, always.
  const ledger = options.ledger ?? newFeeDocumentLedger();
  let finding: FeeScheduleFinding;
  try {
    finding = await researcher({ state: input.state, ahj: input.ahj, utility: input.utility, track, discipline: input.discipline, knownContext }, { ledger });
  } catch (err) {
    finding = emptyFinding(`Researcher threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The caller's discipline travels on the INPUT side of saveFeeSchedule, where it
  // wins over anything the researcher inferred — the row that lands is keyed to the
  // permit the caller asked to price (see FeeScheduleResearchInput.discipline).
  return saveFeeSchedule(db, { state: input.state, ahj: input.ahj, utility: input.utility, track, discipline: input.discipline }, finding, { corroborateAgainst: ledger });
}

// ---------------------------------------------------------------------------
// Autonomous acquisition: the moment a project needs a fee we do not hold, go
// find the schedule — as a BACKGROUND JOB, never a call on a request path.
// ---------------------------------------------------------------------------

/** How long after a fee_research attempt (found something or not) the same target
 *  is left alone. Longer than code_research's 6h window on purpose: one fee pass
 *  is up to twelve web-grounded Opus turns and ten document retrievals — the most
 *  expensive model operation in the system — where a code pass is one call, and a
 *  jurisdiction that published nothing this morning will not have published it by
 *  this afternoon. The job rows themselves are the marker; a miss is NEVER stored
 *  as an empty fee row, which would block auto-research forever. */
export const FEE_RESEARCH_BACKOFF_HOURS_DEFAULT = 24;

function feeResearchBackoffMs(): number {
  const hours = Number(process.env.FEE_RESEARCH_BACKOFF_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : FEE_RESEARCH_BACKOFF_HOURS_DEFAULT) * 3600_000;
}

/** One row the fee table must be able to answer for this project. */
export interface FeeResearchNeed {
  track: FeeTrack;
  discipline: FeeDiscipline;
}

/** The (track, discipline) fee rows a project's submittal tracks will ask the
 *  quote ladder for — the SAME mapping the lookup side uses (feeForProject's
 *  recipeDisciplineForTrack), so what research is asked for and what the fee
 *  sheet later asks about cannot disagree. "nem" needs the utility row; every
 *  permit track needs its own discipline's row (building→structural,
 *  electrical/mpu→electrical, combo→combo — mpu collapses into electrical here,
 *  which the Set dedupe below makes harmless). */
export function feeResearchNeedsForTracks(tracks: readonly string[]): FeeResearchNeed[] {
  const seen = new Set<string>();
  const out: FeeResearchNeed[] = [];
  for (const t of tracks) {
    const track = feeTrack(t);
    const discipline = track === "nem" ? ("" as FeeDiscipline) : feeDiscipline(recipeDisciplineForTrack(t));
    const key = `${track}|${discipline}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ track, discipline });
  }
  return out;
}

/** Acquisition coverage is not the same as one quotable combination row. An
 *  AHJ can publish separate electrical and structural schedules; researching a
 *  nonexistent combo row every backoff window would repeatedly buy the same
 *  schedules. Keep lookup/evaluation semantics unchanged: held formula rows,
 *  conflicts and unresolved delegations still need a person, not another pass.
 *  With only one split row held, acquire only the missing discipline. */
function missingFeeResearchNeeds(
  db: AppDb,
  project: Pick<ProjectRecord, "state" | "ahj" | "utility">,
  tracks: readonly string[],
): FeeResearchNeed[] {
  const missing = new Map<string, FeeResearchNeed>();
  for (const need of feeResearchNeedsForTracks(tracks)) {
    if (findFeeScheduleForProject(db, project, need.track, need.discipline)) continue;
    if (need.track === "permit" && need.discipline === "combo") {
      const splitNeeds: FeeResearchNeed[] = [
        { track: "permit", discipline: "electrical" },
        { track: "permit", discipline: "structural" },
      ];
      const missingSplit = splitNeeds.filter((split) =>
        !findFeeScheduleForProject(db, project, split.track, split.discipline));
      if (missingSplit.length < splitNeeds.length) {
        for (const split of missingSplit) missing.set(`${split.track}|${split.discipline}`, split);
        continue;
      }
    }
    missing.set(`${need.track}|${need.discipline}`, need);
  }
  return [...missing.values()];
}

/** WHEN A PROJECT LANDS AT AN AHJ (OR UTILITY) WE HOLD NO FEE ROW FOR, QUEUE THE
 *  RESEARCHER. Called from QC (runQcForProject) — the same day-the-plan-set-lands
 *  moment the document demands moved to — and fire-and-forget: the current QC run
 *  proceeds on the honest miss, the researched row starts answering the next
 *  quote. Follows ensureCodeProfilesResearched's shape exactly.
 *
 *  Enqueues NOTHING when:
 *   · FEE_RESEARCH=off (operator kill switch), or this process runs no job worker
 *     (jobWorkerRunning) — the smoke, unit tests, scripts and benchmarks all run
 *     QC under a dotenv'd real API key, and an enqueue's instant kick would spend
 *     a multi-minute web-grounded pass in-process. Today "runs the worker" is
 *     exactly the server.
 *   · the production lookup (findFeeScheduleForProject: exact key → undifferentiated
 *     fallback → state-scoped fuzzy → delegation hop) already holds a row for the
 *     (track, discipline) this project needs, or a combo need is covered by both
 *     electrical and structural schedules — including a delegation whose target
 *     is missing, which is a modelling question for a person, not a research gap;
 *   · an identical target (dedupe key `track|profileKey|discipline`, carried in the
 *     payload as researchKey) already has a pending/running fee_research job, or
 *     ANY fee_research attempt inside the backoff window above — a miss must not
 *     be re-bought on every QC re-run.
 *
 *  The API-key gate lives in the researcher itself (claudeFeeScheduleResearcher
 *  refuses keyless and stores nothing), same as code_research's stub path — so a
 *  keyless deployment costs one no-op job per target per backoff window, and the
 *  moment a key appears research resumes with no code change. */
export async function ensureFeeSchedulesResearched(
  db: AppDb,
  project: Pick<ProjectRecord, "id" | "state" | "ahj" | "utility">,
  tracks: readonly string[],
): Promise<number> {
  if (process.env.FEE_RESEARCH === "off") return 0;
  // Lazy import avoids the static cycle (jobQueue → repository → … → feeSchedules).
  let jobQueue: typeof import("./jobQueue");
  try {
    jobQueue = await import("./jobQueue");
  } catch {
    return 0;
  }
  if (!jobQueue.jobWorkerRunning()) return 0;
  let enqueued = 0;
  for (const need of missingFeeResearchNeeds(db, project, tracks)) {
    try {
      const subject = need.track === "nem" ? clean(project.utility) : clean(project.ahj);
      if (!subject) continue;
      if (findFeeScheduleForProject(db, project, need.track, need.discipline)) continue;
      const profileKey = feeScheduleProfileKey(project, need.track);
      const researchKey = `${need.track}|${profileKey}|${need.discipline}`;
      const recent = db.get<Row>(
        `SELECT id FROM job_queue
          WHERE job_type = 'fee_research' AND payload LIKE ?
            AND (status IN ('pending','running') OR created_at > ?)
          LIMIT 1`,
        [`%"researchKey":${JSON.stringify(researchKey)}%`, new Date(Date.now() - feeResearchBackoffMs()).toISOString()],
      );
      if (recent) continue;
      // maxRetries 2: the worker's retry math (`retryCount+1 < maxRetries`) means
      // 1 yields ZERO retries — 2 gives the intended single retry (and the
      // researcher catches its own failures, so retries are rare anyway).
      jobQueue.enqueueJob(db, "fee_research", {
        state: clean(project.state), ahj: clean(project.ahj), utility: clean(project.utility),
        track: need.track, discipline: need.discipline, profileKey, researchKey,
      }, { priority: 3, maxRetries: 2, projectId: project.id });
      enqueued++;
      logger.info("fees", `fee-schedule auto-research queued for ${subject} (${need.track}${need.discipline ? `/${need.discipline}` : ""})`);
    } catch { /* autonomy is best-effort — never break the caller */ }
  }
  return enqueued;
}

// ---------------------------------------------------------------------------
// Resolving a stored schedule for a real project
// ---------------------------------------------------------------------------

/** Exact profile-key hit first, then a state-scoped fuzzy fallback over the same
 *  track — the same precedence knowledgeBase uses. Without the fallback a
 *  project filed as "Coos Bay" misses a schedule stored as "City Of Coos Bay",
 *  which is the headline case this exists for. */
export function findFeeScheduleForProject(
  db: AppDb,
  project: Pick<ProjectRecord, "state" | "ahj" | "utility">,
  track: FeeTrack,
  discipline: FeeDiscipline = "",
): FeeScheduleRecord | null {
  const raw = findRawScheduleForProject(db, project, track, discipline);
  return raw ? followCollectedBy(db, raw).record : null;
}

/** The row filed under this project's own key BEFORE any hop is followed — the
 *  delegation itself, when there is one. Kept separate because a caller that
 *  intends to EVALUATE needs `followCollectedBy`'s `unresolved` reason too, and
 *  a hop that lands nowhere must read as unresolved rather than as a stored
 *  schedule with no fee lines (which is a different repair). */
function findRawScheduleForProject(
  db: AppDb,
  project: Pick<ProjectRecord, "state" | "ahj" | "utility">,
  track: FeeTrack,
  discipline: FeeDiscipline = "",
): FeeScheduleRecord | null {
  const key = feeScheduleProfileKey(project, track);
  // Ask for the discipline requested; fall back to the undifferentiated row,
  // which is what a jurisdiction publishing ONE permit schedule has to say
  // about any discipline, and what every row predating this dimension carries.
  const exact = getFeeSchedule(db, key, track, discipline)
    ?? (discipline ? getFeeSchedule(db, key, track, "") : null)
    // No discipline asked for and no undifferentiated row: a jurisdiction with
    // exactly one permit schedule still answers. With more than one it does
    // NOT — picking between a structural and an electrical fee by row order is
    // how a quote ends up confidently wrong — so the caller gets null here and
    // feeLinesForProject, which can carry both, is the way to ask.
    ?? (!discipline ? onlySchedule(getFeeSchedulesForKey(db, key, track)) : null);
  if (exact) return exact;

  const wanted = track === "nem" ? clean(project.utility) : clean(project.ahj);
  if (!wanted) return null;
  const state = clean(project.state).toUpperCase();
  const rows = db.query<Row>("SELECT * FROM fee_schedules WHERE track = ?", [track]);
  let best: { row: FeeScheduleRecord; score: number } | null = null;
  for (const row of rows) {
    const rec = mapSchedule(row);
    // State mismatch always loses: a like-named city in another state files
    // somewhere else entirely.
    const rowState = rec.state.trim().toUpperCase();
    if (state && rowState && rowState !== state) continue;
    // A fuzzy match crossing DISCIPLINES is the same error as one crossing
    // jurisdictions: "Coos County" scores well against itself under either
    // heading, and handing an electrical stage the structural table quotes a
    // real fee for the wrong permit.
    if (discipline && rec.discipline && rec.discipline !== discipline) continue;
    const name = track === "nem" ? rec.utility : rec.ahj;
    // A CITY IS NOT THE COUNTY OF THE SAME NAME. "City of Jefferson" (Marion County area) scores
    // 65 against "Jefferson County" (Madras) — a different place; a fuzzy bridge across kinds is
    // the wrong-authority fee. A county that collects a city's fees is a sourced DELEGATION row
    // (collectedByProfileKey), never a name match.
    const kindWanted = track === "nem" ? "" : agencyKind(wanted);
    const kindRow = track === "nem" ? "" : agencyKind(name);
    if (kindWanted && kindRow && kindWanted !== kindRow) continue;
    const score = knowledgeNameMatchScore(wanted, name);
    if (score < 60) continue;
    if (!best || score > best.score) best = { row: rec, score };
  }
  return best ? best.row : null;
}

/** WHAT THE EVALUATOR WAS TOLD ABOUT THE PERMIT PATH. Four values, TWO behaviours,
 *  and the split is not where it used to be.
 *
 *    "prescriptive" / "engineered" — DECIDED. The gate SELECTS on it: the line
 *                    scoped to this path is kept, the line scoped to the other is
 *                    dropped, and a table that prices only the other path says so.
 *
 *  The other two are both UNDECIDED, and an undecided path buys a path-scoped line
 *  NOTHING. They differ only in what a person has to do about it:
 *
 *    "unknown"     — WE LOOKED AND COULD NOT DECIDE. A real parser snapshot went
 *                    through resolvePermitPath and came back undecided (in practice:
 *                    "No structural inputs were parsed"). It contradicts no row —
 *                    pathWordingContradicts still says so, and ahjForms
 *                    .formContradictsPath says the same on the document side — but
 *                    NOT CONTRADICTING A ROW IS NOT QUALIFYING FOR IT. A line whose
 *                    own label restricts it to one of two mutually exclusive paths
 *                    cannot be charged until somebody knows which path this is.
 *                    Repair: confirm the path (the operator's dropdown) or parse the
 *                    structural inputs. autopilot.ts raises its own `permit_path`
 *                    blocker over the same gap.
 *    "unresolved"  — WE NEVER LOOKED. No snapshot was in reach at this seam. Same
 *                    refusal, DIFFERENT REPAIR — a caller has to bring a project,
 *                    where "unknown" needs an operator to make a decision — so it
 *                    keeps its own sentence.
 *
 *  THE ONE LESSON THIS TYPE EXISTS TO HOLD: an unknown must never read as permission
 *  and must never read as reassurance. For two rounds "unknown" read as permission —
 *  it switched the gate OFF, so the state that knew LEAST quoted the most
 *  confidently, at $200 off City of Coos Bay's row titled "…Prescriptive Path
 *  System" for every job whose plan set carried no structural inputs.
 *
 *  Local to this module on purpose (see the seam header near lookupPublishedFee):
 *  "unresolved" is not a permit path, it is a statement about the CALLER, and
 *  permitPath.ts must keep owning PermitPath alone. */
type FeePathInput = PermitPath | "unresolved";

/** Evaluation inputs a caller may pre-compute.
 *
 *  `permitPath` IS REQUIRED, and that is the fix rather than a style choice. It used
 *  to be optional "because a seam with no parser snapshot cannot resolve one", and
 *  every consumer wrote `inputs?.permitPath ?? pathForProject(project, track)` —
 *  which, on a synthetic project carrying `parserSnapshot: null`, silently returned
 *  "unknown", turned the gate off, and handed back the other path's fee. Nobody
 *  had to make a mistake for that to happen; they only had to omit a field.
 *  Required means the omission is a COMPILE ERROR, and a caller that genuinely
 *  cannot resolve a path has to say so in the value ("unresolved") where a reviewer
 *  reads it. */
interface FeeEvalInputs {
  kw: number | null;
  kwSource: string;
  valuationUsd: number | null;
  /** True when `valuationUsd` is a per-watt ESTIMATE rather than a contract figure. A ladder
   *  walked on an estimate produces a number to the cent that is only as good as the guess
   *  underneath it, and a fee that looks computed must not hide a valuation that was not. */
  valuationIsEstimate?: boolean;
  permitPath: FeePathInput;
}

/** The permit path for fee selection, read from THE SAME resolver the document
 *  gate uses. One resolver is the point: a fee card and a blocker panel computing
 *  the path two different ways is exactly how one screen came to demand a PE stamp
 *  while billing the prescriptive rate.
 *
 *  Never throws. This runs inside the staging gate and inside every quote; a path
 *  resolver that blew up on a malformed snapshot would take a submission down, and
 *  "unknown" is both the safe answer and the honest one. */
function pathForProject(project: PermitPathInputs, track: FeeTrack): PermitPath {
  if (track !== "permit") return "unknown";
  try {
    return resolvePermitPath(project).path;
  } catch (err) {
    logger.warn("fees", "permit path could not be resolved for fee selection — treating as unknown", {
      err: err instanceof Error ? err.message : String(err),
    });
    return "unknown";
  }
}

/** Lookup + hop + evaluate for ONE discipline, as a line. The single-answer
 *  seams route through this so a dangling or circular hop reaches them as the
 *  reason it is, not as an empty schedule. */
function resolveLine(
  db: AppDb,
  project: Pick<ProjectRecord, "state" | "ahj" | "utility" | "systemSizeAcKw" | "systemSizeDcKw" | "parserSnapshot">,
  track: FeeTrack,
  discipline: FeeDiscipline,
  inputs?: FeeEvalInputs,
): FeeScheduleLine | null {
  const raw = findRawScheduleForProject(db, project, track, discipline);
  if (!raw) return null;
  const hop = followCollectedBy(db, raw);
  const hoppedFrom = hop.collectedBy ? (track === "nem" ? raw.utility : raw.ahj) : "";
  // The filing is the discipline ASKED FOR — an undifferentiated row answering a
  // structural ask is answering for the building permit, which bills no services
  // line — and only when nothing was asked does the row's own discipline stand.
  const line = lineFor(db, project, track, hop.record, hoppedFrom, discipline || raw.discipline, inputs);
  // A DANGLING HOP CLEARS THE ITEMISATION TOO. The charges on the line were read
  // off a row we have just decided does not answer for this project; leaving them
  // on it would print somebody else's bill beside a refusal.
  if (hop.unresolved) return { ...line, feeUsd: null, bracketLabel: "", bracketQuote: "", corroboration: undefined, charges: [], reason: hop.unresolved };
  // The discipline reported is the one that was ASKED FOR — a hopped line is
  // still the electrical permit even though it was read off the county's row,
  // and an undifferentiated row answering a discipline-specific ask answers AS
  // that discipline.
  return { ...line, discipline: discipline || line.discipline };
}

/** The one schedule, when there is exactly one. Never a choice between two. */
function onlySchedule(rows: FeeScheduleRecord[]): FeeScheduleRecord | null {
  return rows.length === 1 ? rows[0] : null;
}

/** WHICH PERMITS THIS PROJECT OWES, as separate lines.
 *
 *  An undifferentiated row answers for everything and is the whole answer — a
 *  jurisdiction that publishes one permit schedule is not secretly charging
 *  twice, and adding discipline rows to it would double-count. Otherwise every
 *  stored discipline is a permit this project owes, EXCEPT that a `combo` row
 *  is an alternative way to file the same work: where a jurisdiction offers
 *  both, the separate permits are the default and the combo line is reported
 *  alongside rather than added, because which one gets filed is a choice
 *  somebody makes per job. */
function applicableSchedules(db: AppDb, key: string, track: FeeTrack): FeeScheduleRecord[] {
  const all = getFeeSchedulesForKey(db, key, track);
  const undifferentiated = all.find((r) => !r.discipline);
  if (undifferentiated) return [undifferentiated];
  const separate = all.filter((r) => r.discipline === "structural" || r.discipline === "electrical");
  if (separate.length) return separate;
  return all;
}

export function feeLinesForProject(
  db: AppDb,
  project: Pick<ProjectRecord, "state" | "ahj" | "utility" | "systemSizeAcKw" | "systemSizeDcKw" | "parserSnapshot">,
  track: FeeTrack,
  /** Evaluation inputs, when the caller already has them. lookupPublishedFee
   *  runs at a seam with no parser snapshot and its own pre-computed bracket
   *  size, and must not silently re-derive either — including the PERMIT PATH,
   *  which is why FeeEvalInputs requires it rather than leaving it to the
   *  fallback below. */
  inputs?: FeeEvalInputs,
): FeeScheduleLine[] {
  const key = feeScheduleProfileKey(project, track);
  let rows = applicableSchedules(db, key, track);
  if (!rows.length) {
    // Nothing under this project's own key — fall back to the fuzzy match the
    // singular lookup has always done, so an operator short name ("Coos Bay")
    // still reaches the legal name on file.
    const fuzzy = findFeeScheduleForProject(db, project, track);
    rows = fuzzy ? [fuzzy] : [];
  }

  const rating = inputs ? { kw: inputs.kw, which: inputs.kwSource } : systemRatingKw(project);
  const { kw, which } = rating;
  // A TERNARY ON `inputs`, NOT `inputs?.permitPath ?? …`. The `??` form reads as a
  // default and would come back the moment someone made the field optional again;
  // this form says what is true — a caller that brought inputs decided the path,
  // and only a caller that brought none is asking us to resolve it.
  const permitPath: FeePathInput = inputs ? inputs.permitPath : pathForProject(project, track);
  const lines: FeeScheduleLine[] = [];
  for (const row of rows) {
    const hop = followCollectedBy(db, row);
    const schedule = hop.record;
    const hoppedFrom = hop.collectedBy ? (track === "nem" ? row.utility : row.ahj) : "";
    const valuation = inputs || schedule.basis !== "valuation" ? null : resolveValuation(project.parserSnapshot, project.systemSizeDcKw);
    const valuationUsd = inputs ? inputs.valuationUsd : (valuation ? valuation.value : null);
    const valuationIsEstimate = inputs ? inputs.valuationIsEstimate === true : valuation?.method !== "contract";
    const evaluated: ReturnType<typeof evaluateSchedule> = hop.unresolved
      ? { feeUsd: null, bracketLabel: "", bracketQuote: "", corroboration: undefined, reason: hop.unresolved }
      : evaluateSchedule(schedule, { kw, kwSource: which, valuationUsd, valuationIsEstimate, track, permitPath, electricalReviewRequired: knownElectricalReviewRequired(project.parserSnapshot),
        // The FILING is the row asked for (a hopped city row is still the electrical
        // permit), not the collecting authority's row it hops to.
        batteryServiceFeeder: batteryServiceFeederApplies(project, track, row.discipline) });
    lines.push({
      discipline: row.discipline,
      authority: (track === "nem" ? schedule.utility : schedule.ahj) || (track === "nem" ? row.utility : row.ahj),
      hoppedFrom,
      feeUsd: evaluated.feeUsd,
      baseFeeUsd: evaluated.baseFeeUsd,
      stateSurchargeUsd: evaluated.stateSurchargeUsd,
      communitySurchargeUsd: evaluated.communitySurchargeUsd,
      bracketLabel: evaluated.bracketLabel,
      basis: schedule.basis,
      paymentMethod: schedule.paymentMethod,
      sourceUrl: schedule.sourceUrl,
      sourceQuote: schedule.sourceQuote,
      bracketQuote: evaluated.bracketQuote,
      ...(evaluated.corroboration ? { corroboration: evaluated.corroboration } : {}),
      // A hopped line's confidence is the COLLECTING authority's, because the
      // number is theirs. A verified pointer at a seeded table is still a
      // seeded number, and the weaker of the two is the honest one to show.
      confidence: hop.collectedBy && (row.confidence === "seeded" || schedule.confidence === "seeded") ? "seeded" : schedule.confidence,
      // A LADDER WALKED ON A GUESS IS AN ESTIMATE, whatever the schedule itself is worth. The
      // table can be verified and the arithmetic exact and the answer still only as good as the
      // valuation underneath — every $1,000 of that guess is another $10.26 here. It rides
      // BESIDE the confidence rather than inside it because a schedule's confidence is a fact
      // about the table (seeded or verified, nothing else) and this is a fact about the INPUT.
      valuationEstimated: evaluated.fromEstimatedValuation === true,
      notes: schedule.notes,
      scheduleId: schedule.id,
      reason: evaluated.reason,
      charges: evaluated.charges ?? [],
    });
  }
  return lines;
}

/** The system rating the kVA brackets are about. AC first: a schedule bracketed
 *  in kVA is rating the INVERTER output, not the array, and a 20 kW-DC job with
 *  15 kW-AC of inverters sits in a different bracket depending on which you
 *  read. DC is the fallback because it is the field most reliably populated. */
function systemRatingKw(project: Pick<ProjectRecord, "systemSizeAcKw" | "systemSizeDcKw">): { kw: number | null; which: string } {
  const ac = num(project.systemSizeAcKw);
  if (ac != null && ac > 0) return { kw: ac, which: "AC" };
  const dc = num(project.systemSizeDcKw);
  if (dc != null && dc > 0) return { kw: dc, which: "DC" };
  return { kw: null, which: "" };
}

/** First bracket whose bounds contain the value. Bounds are INCLUSIVE at both
 *  ends and an absent bound is open, which is how published schedules read
 *  ("5.01 through 15", then "15.01 through 25", then "25 and above"). */
function matchBracket(brackets: FeeBracket[], value: number, kind: "kw" | "valuation"): FeeBracket | null {
  for (const b of brackets) {
    const min = kind === "kw" ? b.minKw : b.minValuationUsd;
    const max = kind === "kw" ? b.maxKw : b.maxValuationUsd;
    // A ROW WITH NEITHER BOUND IS NOT A SIZE ROW, AND MUST NOT SWALLOW EVERY JOB.
    //
    // Measured on ComEd: research read the real interconnection table and returned
    // Level 1 (25 kW export, $50), Level 2 (to 5 MW, $100/kVA) — and alongside them
    // a $500 non-export line and a $300 PRE-APPLICATION report fee, neither of which
    // is keyed on system size at all. An unbounded row passes both tests below, so
    // first-match handed a 60 kW job the $500 line: outside Level 1's bound, and the
    // unbounded row was next. The table is bracketed on size; a row that carries no
    // size cannot be the answer to "which size bracket is this?", and skipping it
    // means the schedule reports "outside every published bracket" — which is true,
    // and which a person then reads. An open-ended TOP row ("25 kVA and above") has
    // a min and is untouched.
    if (min == null && max == null) continue;
    if (min != null && value < min) continue;
    if (max != null && value > max) continue;
    return b;
  }
  return null;
}

// A ROW THAT DESCRIBES A FORMULA CANNOT ANSWER WITH A SINGLE NUMBER.
//
// Measured while pricing Portland as a brand-new AHJ. Its schedule's top row reads "Solar
// Generation System Over 25 KVA — Each kva over 25.012 up to 100 kva | $15.52", and the
// researcher stored feeUsd 15.52 — the RATE — with the formula in the label. matchBracket then
// hands a 40 kVA job $15.52, where the real fee is $391 for the first 25 plus 15.52 x ~15, about
// $624. A 40x under-quote, sourced, quotable and completely confident.
//
// Every jurisdiction priced so far has one of these rows and they store it differently, which is
// the point — the label is prose and the shape cannot be trusted:
//   Portland      "Each kva over 25.012 up to 100 kva"          stored the RATE   ($15.52)
//   Lincoln City  "$250.00 for first 25kva plus $6.25 per kva"  stored the BASE   ($250)
//   Coos County   "$265 + $10 per add'l kva up to 100 kva"      stored the FLOOR  ($265)
// One of those under-quotes by 40x, the others by whatever the job is over the threshold.
//
// So a formula row REFUSES rather than guessing which number it stored. Until FeeBracket can
// carry the rate and its threshold as data (see the note on FeeBracket), the honest answer is
// that a person has to read the schedule — which is the same rule already applied to a
// conflicting fee and to a valuation with no valuation.
//   NOTE the "each <unit>" arm. Portland's row says "EACH kva over 25.012" — no "per", no
//   "additional" — and the first version of this regex missed exactly the one label that costs
//   the most to miss. A rate is a rate whichever preposition the city chose.
//   Written as ONE literal rather than a joined array. The array version was assembled by a
//   patch script that turned every \b into a literal BACKSPACE character (0x08) — invisible in
//   a terminal, so the regex read as "<BS>per\s+..." and matched nothing at all while looking
//   perfectly correct on screen. A literal is what the next person can read and check.
const FORMULA_LABEL =
  /\bper\s+(add|addl|additional|each)|\beach\s+(add|addl|additional|kva|kw|kilowatt|\$)|\bfor\s+each\b|\bplus\s*\$|\+\s*\$[\d.,]+\s*(for|per)|\bper\s+(kva|kw|kilowatt)\b|\bper\s+\$\s*1,?000|\brate\s+plus\b/i;

export function bracketDescribesFormula(label: string | undefined): boolean {
  return FORMULA_LABEL.test(String(label ?? "")) || /\bno\s*[-–]?\s*additional charge\b/i.test(String(label ?? ""));
}

/** A valuation ladder read out of a bracket's own printed wording. */
export interface ValuationLadder {
  /** The flat amount that covers everything up to `aboveUsd`. */
  baseUsd: number;
  /** Steps are counted on valuation ABOVE this figure. */
  aboveUsd: number;
  /** Dollars of valuation in one step — Portland uses $100 low down and $1,000 higher up. */
  stepUsd: number;
  /** Dollars added per step. */
  ratePerStepUsd: number;
  /** "or fraction thereof": a part step counts as a whole one. */
  roundUp: boolean;
  /** The clause this was read from, verbatim. A computed number must name its sentence. */
  quote: string;
}

/**
 * A FORMULA IS STORED AS A FORMULA, THE SAME WAY A PERCENTAGE IS STORED AS A PERCENTAGE.
 *
 * Portland's residential structural permit is a valuation LADDER, and the whole ladder is
 * printed in the bracket's own label:
 *
 *   "$25,001 - $50,000 Fee for the first $25,000 | $ 540.78 ... For each additional $1,000
 *    or fraction thereof up to and including $50,000 | $ | 10.26"
 *
 * Until now the evaluator saw "per each additional" and refused outright — correctly, because
 * quoting the stored $540.78 alone under-states a $30,000 job by $51.30 and a $49,000 job by
 * $246. But refusing is only right while the rest of the sentence is unread. It is all there.
 *
 * Read at evaluation time from the label rather than stored as a new column: the label is a
 * string the bracket already carries, so deriving from it adds no field to migrate and — more
 * importantly — no new place for an untrusted writer to put a number. `corroboration` and
 * `ancillaryCharges` are stripped on the untrusted read path precisely because they must come
 * from retrieved bytes; a ladder derived from the quote inherits that provenance for free.
 *
 * Returns null unless the whole ladder is present AND the base it names is the bracket's own
 * `feeUsd`. A label that says "for the first $25,000 | $ 540.78" beside a bracket charging
 * something else is two readings of one schedule that disagree, which is the condition this
 * file already refuses to quote through (see FEE_CONFLICT_MARKER) — not a licence to guess.
 */
export function parseValuationLadder(b: FeeBracket): ValuationLadder | null {
  const label = String(b.label ?? "");
  if (!label) return null;

  const num = (s: string): number => Number(s.replace(/,/g, ""));

  // "Fee for the first $25,000 | $ 540.78"  ·  "Fee for the first $500 | $ 167.00"
  const base = /Fee\s+for\s+the\s+first\s*\$\s*([\d,]+(?:\.\d+)?)\s*\|?\s*\$\s*([\d,]+(?:\.\d+)?)/i.exec(label);
  if (!base) return null;
  const aboveUsd = num(base[1]);
  const baseUsd = num(base[2]);

  // "For each additional $1,000 or fraction thereof up to and including $50,000 | $ | 10.26"
  const step = /For\s+each\s+additional\s*\$\s*([\d,]+(?:\.\d+)?)([^|]*)\|\s*\$\s*\|\s*([\d,]+(?:\.\d+)?)/i.exec(label);
  if (!step) return null;
  const stepUsd = num(step[1]);
  const ratePerStepUsd = num(step[3]);
  const roundUp = /fraction\s+thereof/i.test(step[2]);

  if (!Number.isFinite(aboveUsd) || !Number.isFinite(baseUsd) || !Number.isFinite(stepUsd) || !Number.isFinite(ratePerStepUsd)) return null;
  if (stepUsd <= 0 || ratePerStepUsd < 0 || aboveUsd < 0) return null;

  // THE LADDER AND THE BRACKET MUST BE THE SAME MONEY. Sub-cent tolerance only.
  if (Math.abs(baseUsd - b.feeUsd) > 0.005) return null;

  return { baseUsd, aboveUsd, stepUsd, ratePerStepUsd, roundUp, quote: label };
}

/** Walk one ladder for a valuation. Returns null when the valuation is not known. */
export function evaluateValuationLadder(ladder: ValuationLadder, valuationUsd: number | null): number | null {
  if (valuationUsd == null || !Number.isFinite(valuationUsd)) return null;
  const over = valuationUsd - ladder.aboveUsd;
  if (over <= 0) return round2(ladder.baseUsd);
  const rawSteps = over / ladder.stepUsd;
  // "or fraction thereof" is the jurisdiction saying a part step is charged as a whole one.
  // Without those words a part step is not charged at all. The difference on Trask's $30,000
  // job is nothing; on a $30,001 job it is one whole $10.26 step, which is why it is read
  // from the wording and not assumed.
  const steps = ladder.roundUp ? Math.ceil(rawSteps) : Math.floor(rawSteps);
  return round2(ladder.baseUsd + steps * ladder.ratePerStepUsd);
}

function feeIncludesSurcharges(label: string): boolean {
  return /\b(?:total|all[-\s]?in)\b|\binclud(?:es?|ing)\b[^.;]{0,50}\bsurcharges?\b|\bsurcharges?\b[^.;]{0,20}\bincluded\b/i.test(label);
}

function bracketLabelFor(b: FeeBracket, basis: FeeBasis): string {
  if (b.label) return b.label;
  if (basis === "system_kw" && (b.minKw != null || b.maxKw != null)) {
    return b.maxKw == null ? `${b.minKw ?? 0} kVA and above` : `${b.minKw ?? 0} through ${b.maxKw} kVA`;
  }
  if (basis === "valuation" && (b.minValuationUsd != null || b.maxValuationUsd != null)) {
    return b.maxValuationUsd == null ? `$${b.minValuationUsd ?? 0} and above` : `$${b.minValuationUsd ?? 0} – $${b.maxValuationUsd}`;
  }
  return "Flat fee";
}

/** THE EVIDENCE FOR ONE BRACKET, VERBATIM — never a string this code composed.
 *
 *  Order matters and each rung is a different kind of fact:
 *    1. the corroborated printed row (we fetched the document and found this
 *       bracket's label and fee together on one line);
 *    2. for a ONE-BRACKET schedule, the row's own sourceQuote — with a single
 *       bracket, row grain IS bracket grain, and that sentence is usually the
 *       richest thing we have ("payable by check mailed within 15 business
 *       days");
 *    3. the bracket's own stored label.
 *
 *  bracketLabelFor() is deliberately NOT a rung. It SYNTHESISES a label when the
 *  schedule printed none ("$0 – $25000"), and a synthesised string is not
 *  evidence — worse, its bounds look exactly like fees and would fail the
 *  contradiction check below against numbers no document ever charged. */
function bracketEvidence(schedule: FeeScheduleRecord, b: FeeBracket): string {
  const corroborated = b.corroboration?.corroborated ? clean(b.corroboration.matchedLine) : "";
  if (corroborated) return corroborated;
  if (schedule.brackets.length === 1 && clean(schedule.sourceQuote)) return clean(schedule.sourceQuote);
  return clean(b.label);
}

// ---------------------------------------------------------------------------
// WHICH PATH'S FEE IS THIS PROJECT'S FEE?
//
// The prescriptive and the engineered applications are mutually exclusive, and so
// are their FEES. The document half of that pair has been path-scoped for a while
// (ahjForms.formAllowedForPath / formContradictsPath); the fee half was blind, and
// on Ann Marineau's live Coos Bay project the two halves contradicted each other
// on one screen: the blocker panel demanded a PE stamp and a sealed engineering
// letter, while the fee card quoted $360 — $160 county electrical plus $200 off a
// row labelled "Solar Permit (when required) – PRESCRIPTIVE PATH System" whose own
// notes read "NONPRESCRIPTIVE (engineered) installs are charged from the Structural
// Permit Fee table by valuation … a different number this row does not cover".
// The row said it did not cover her; the evaluator quoted it anyway, sourced and
// confident, because nothing in the fee path had ever heard of the permit path.
//
// SCOPE OF THE GATE, and each clause earns its place:
//   · track === "permit"  — the prescriptive/engineered split is an AHJ building
//     application distinction. A NEM schedule's lines are free to say "engineering
//     review" about a utility study, and letting that word veto an interconnection
//     fee would be a new bug wearing this one's clothes.
//   · discipline !== "electrical" — the path decides which STRUCTURAL application
//     you file. The electrical permit is the same permit on either path, and its
//     fee must not move because a rafter failed a screen.
//   · a DECIDED path — the gate SELECTS between two lines, and selecting takes a
//     decision. With one in hand the contradicting line is dropped and the matching
//     one is charged.
//
// AND THE HALF THAT WAS INVERTED FOR TWO ROUNDS: WHAT HAPPENS WITH NO DECISION.
//
// The gate used to switch ITSELF OFF for "unknown", on the reasoning that an
// undecided path contradicts no row. That reasoning is true and it is not the
// question. NOT CONTRADICTING A ROW IS NOT QUALIFYING FOR IT: a line whose own
// label restricts it to one of two mutually exclusive paths cannot be charged
// until somebody knows which path this is. The effect was that the state where the
// system knows LEAST quoted the most confidently: a Coos Bay project whose plan set
// carried no structural inputs resolved "unknown" (resolvePermitPath step 5 —
// "No structural inputs were parsed"), turned the gate off, and was handed $200 off
// the row titled "…Prescriptive Path System" inside a sourced, citable $335 total,
// with no screen and no operator decision behind the choice. Ann was refused that
// row for being engineered while a project nobody had screened at all was charged
// it.
//
// MEASURED HONESTLY: on the live database at the time of the fix, 0 of 13 Oregon
// projects were in that state (9 engineered, 4 prescriptive), so nothing was being
// mis-quoted THAT DAY. This is a fix to the mechanism, not to a row — the state is
// reachable from any plan set that parses without structural inputs, and the
// quote it produced was confident and citable.
//
// So an undecided path is GATE-ON (pathUndecidedGate below): every line that CLAIMS
// a path refuses, every line that claims none still prices, and the total goes
// unreadable rather than quietly wrong — the same partial the split already
// produces for any other unreadable line. The two undecided values keep separate
// SENTENCES because their repairs differ ("unknown" is an operator confirming a
// path; "unresolved" is a caller bringing a project), but neither of them buys a
// path-scoped line anything.
// ---------------------------------------------------------------------------

/** The two SCOPE clauses both gates share, in one place so they cannot drift: a NEM
 *  line and an electrical line are not scoped by the building path at all, so NO
 *  state of the path — decided, undecided or never asked — decides anything about
 *  them. */
function pathScopeApplies(schedule: FeeScheduleRecord, track: FeeTrack): boolean {
  if (track !== "permit") return false;
  return schedule.discipline !== "electrical";
}

/** Is there a DECISION here to select on? */
function pathGateApplies(schedule: FeeScheduleRecord, track: FeeTrack, path: FeePathInput | undefined): path is "prescriptive" | "engineered" {
  if (!pathScopeApplies(schedule, track)) return false;
  return path === "prescriptive" || path === "engineered";
}

/** IS THE PATH UNDECIDED WHERE IT MATTERS? — "unknown" (we looked and could not
 *  tell), "unresolved" (we never looked), and anything a future edit adds.
 *
 *  WRITTEN AS A NEGATIVE ON PURPOSE, and that is the safety property. Its
 *  predecessor asked `path === "unresolved"`, which enumerates the states that
 *  REFUSE — so every state it forgot (there was one: "unknown") fell through to
 *  gate-off and quoted. This form enumerates the two states that may SELECT and
 *  treats everything else as undecided, so a value added later lands on the careful
 *  side without anyone remembering to come back here. Within scope the two
 *  predicates are exact complements: either we select on a decision or we refuse
 *  every line that needs one. There is no third outcome to fall into. */
function pathUndecidedGate(schedule: FeeScheduleRecord, track: FeeTrack, path: FeePathInput | undefined): boolean {
  if (!pathScopeApplies(schedule, track)) return false;
  return path !== "prescriptive" && path !== "engineered";
}

/** The lines this project could be charged from, once the ones its path cannot
 *  reach are removed. Returns the list unchanged whenever the gate is out of scope,
 *  so a NEM row and an electrical row evaluate exactly as they always did — and a
 *  schedule whose lines claim no path is untouched in every case, because the
 *  filters are over the line's CLAIM, never over the row. */
function bracketsForPath(
  schedule: FeeScheduleRecord,
  track: FeeTrack,
  path: FeePathInput | undefined,
): FeeBracket[] {
  // NO DECISION: every line that CLAIMS a path is out of reach, because choosing
  // one of them would BE choosing a path — with nothing behind the choice. A line
  // that claims no path is untouched: it prices the job on either path and needs
  // no decision, which is why this filter is over the CLAIM and not over the row.
  // That is what keeps the answer a PARTIAL rather than a blank — Coos County's
  // electrical row is not path-scoped and still prices at $135 while the city's
  // prescriptive-only line refuses beside it.
  if (pathUndecidedGate(schedule, track, path)) return schedule.brackets.filter((b) => !pathWordingScope(b.label));
  if (!pathGateApplies(schedule, track, path)) return schedule.brackets;
  return schedule.brackets.filter((b) => !pathWordingContradicts(pathWordingScope(b.label), path));
}

/** The sentence the operator reads when this jurisdiction's table holds a fee for
 *  the OTHER path and none for this one.
 *
 *  THE ACTIONABLE CLAUSE COMES FIRST, on purpose: submissionFees.normalizeScheduleResult
 *  slices `reason` to 400 characters before it reaches the quote's basis line, and
 *  resolutionFrom joins several lines' reasons together, so anything at the tail can
 *  be cut. The row's own label and the row's own notes about the other path follow —
 *  they are the repair (they name the table that DOES cover this project), but they
 *  are not the headline.
 *
 *  It deliberately carries NO FEE_CONFLICT_MARKER. This is not two documents
 *  disagreeing about one number — it is a GAP, one path priced and the other not —
 *  and submissionFees.ts's conflict wording ("two published sources disagree …
 *  needs a human to pick a source") would describe something that never happened. */
function pathMissReason(schedule: FeeScheduleRecord, path: "prescriptive" | "engineered", blocked: FeeBracket[]): string {
  const other = path === "engineered" ? "PRESCRIPTIVE" : "ENGINEERED (non-prescriptive)";
  const who = schedule.ahj || "this jurisdiction";
  const labels = blocked.map((b) => clean(b.label)).filter(Boolean).slice(0, 2);
  // " | " is the NOTE SEGMENT SEPARATOR (mergeNotes splits on it). Quoting segments
  // back with that separator inside a reason invites the next writer to feed this
  // string into notes and have it shredded into fragments; "; " cannot.
  //
  // TRUNCATED PER SEGMENT, because a research note is not length-bounded: the live
  // City of Coos Bay row carries a 1,500-character segment, and an un-capped quote
  // would push the actionable headline past the 400 characters
  // submissionFees.normalizeScheduleResult keeps. The notes are the repair, not the
  // report — a person who wants the rest opens the row.
  //
  // NOTE THE FILTER IS OVER SEGMENTS, NOT OVER THE BLOB. pathWordingScope must
  // never be asked to classify whole notes (see its header): this row's notes are
  // FULL of engineered words and the row is prescriptive-only. Here the classifier
  // is used the other way round — to FIND the segments that talk about the path we
  // could not price — which is safe precisely because nothing is decided by it.
  const relevant = noteSegments(schedule.notes)
    .filter((seg) => pathWordingScope(seg) === path || /valuation/i.test(seg))
    .slice(0, 2)
    .map((seg) => (seg.length > 240 ? `${seg.slice(0, 240).trimEnd()}…` : seg))
    .join("; ");
  return `NO ${path.toUpperCase()} FEE HELD: every fee line stored for ${who} is scoped to the ${other} path, and this `
    + `project resolved to the ${path.toUpperCase()} path, so none of them prices it. Nothing is quoted — read ${who}'s `
    + `published schedule for the ${path} figure and enter it.`
    + `${labels.length ? ` The stored line${labels.length > 1 ? "s" : ""}: "${labels.join('", "')}".` : ""}`
    + `${relevant ? ` The row's own note: ${relevant}` : ""}`;
}

/** The sentence when THE PROJECT has no decided path — the resolver ran against a
 *  real plan set and could not tell prescriptive from engineered.
 *
 *  THREE REFUSALS, THREE REPAIRS, WHICH IS WHY THERE ARE THREE SENTENCES:
 *    "NO … FEE HELD"           — the TABLE prices the other path. Read this
 *                                jurisdiction's published schedule for your figure.
 *    "PERMIT PATH UNDECIDED"   — the PROJECT has not been screened. Confirm the
 *                                path, or parse the structural inputs, and the fee
 *                                that is already stored prices itself. (Here.)
 *    "PERMIT PATH NOT CHECKED" — the CALL never held a project to ask. Quote through
 *                                feeForProject.
 *  Printing any of them for either of the others sends somebody to the wrong repair:
 *  the first would send an operator hunting a fee that is sitting right there, and
 *  the third would hand an operator a developer's job.
 *
 *  ACTIONABLE CLAUSE FIRST, like its siblings: submissionFees.normalizeScheduleResult
 *  slices `reason` to 400 characters on its way to the quote's basis line, so the
 *  repair leads and the stored labels trail. And NO FEE_CONFLICT_MARKER — nothing
 *  disagrees with anything here; a decision has simply not been made yet. */
function pathUndecidedReason(schedule: FeeScheduleRecord, blocked: FeeBracket[]): string {
  const who = schedule.ahj || "this jurisdiction";
  const labels = blocked.map((b) => clean(b.label)).filter(Boolean).slice(0, 2);
  return `PERMIT PATH UNDECIDED: confirm this project's permit path (prescriptive vs engineered) — resolvePermitPath `
    + `ran and could not decide, typically because no structural inputs were parsed. Every fee line stored for `
    + `${who} is scoped to one of those two mutually exclusive paths, so nothing is quoted: a line picked before `
    + `the path is decided is a coin toss that would print as a citation.`
    + `${labels.length ? ` The stored line${labels.length > 1 ? "s" : ""}: "${labels.join('", "')}".` : ""}`;
}

/** The sentence when THE CALL never held a project — no plan set was ever in reach,
 *  so the question of the path was not merely undecided, it was never put.
 *
 *  See pathUndecidedReason's header for why this is a third sentence and not a
 *  reuse of either other one. */
function pathUncheckedReason(schedule: FeeScheduleRecord, blocked: FeeBracket[]): string {
  const who = schedule.ahj || "this jurisdiction";
  const labels = blocked.map((b) => clean(b.label)).filter(Boolean).slice(0, 2);
  return `PERMIT PATH NOT CHECKED: this lookup was handed jurisdiction names and a system size, not a project, so `
    + `there is no plan set to resolve a permit path from — and every fee line stored for ${who} is scoped to the `
    + `prescriptive or the engineered path. Nothing is quoted; a path-scoped line chosen without the path is a coin `
    + `toss that would print as a citation. Quote through feeForProject(db, project, track), which resolves the path `
    + `from the project itself.`
    + `${labels.length ? ` The stored line${labels.length > 1 ? "s" : ""}: "${labels.join('", "')}".` : ""}`;
}

/** Which refusal this is. The three miss sites below route through here, so the
 *  narrowing to a decided path can only happen where it is actually true — an
 *  undecided path reaching pathMissReason would print "NO UNKNOWN FEE HELD", which
 *  is both nonsense and a claim about the jurisdiction we cannot make.
 *
 *  Note the shape: the DECIDED values are enumerated and everything else falls to a
 *  refusal about the call rather than about the table. That is the same asymmetry
 *  pathUndecidedGate is built on — a value nobody remembered to handle lands on the
 *  careful side — and it is what let the old `as "prescriptive" | "engineered"`
 *  cast go away. */
function pathRefusalReason(schedule: FeeScheduleRecord, path: FeePathInput | undefined, blocked: FeeBracket[]): string {
  if (path === "prescriptive" || path === "engineered") return pathMissReason(schedule, path, blocked);
  if (path === "unknown") return pathUndecidedReason(schedule, blocked);
  return pathUncheckedReason(schedule, blocked);
}

// ---------------------------------------------------------------------------
// THE REST OF THE BILL — PRICING THE CHARGES THAT ARE NOT THE PERMIT.
//
// Measured on a real paid City of Portland receipt (3915 N Kiska St, IVR 5269491,
// paid 2026-09-18) for a 3.520 kW DC / 3.072 kW AC prescriptive rooftop system:
// FOUR BILLS FROM THREE BUREAUS, $762.93, of which $354 is permits —
//
//   Fire - Plan Review                  $50.00
//   Electrical Permit RS               $201.00   + St Sur  $24.12  (12% of 201.00)
//   Land Use Plan Review Res           $217.00
//   Bldg Plan Rvw/Processing RS/MI/MP   $99.45   (65% of the building permit)
//   Building Permit RS                 $153.00   + St Sur  $18.36  (12% of 153.00)
//
// — against which this table's answer for the same job was one permit line. That
// gap is not a rounding error, it is more than half the bill, and it printed as a
// sourced, citable, confident number.
//
// THREE RULES, EACH EARNED BY A LINE OF THAT RECEIPT:
//
//  1. THE SURCHARGE IS ON THE PERMIT, NEVER ON THE ANCILLARIES. $24.12 is 12% of
//     $201.00, not 12% of the bill. Surcharging a plan review invents money the
//     jurisdiction never charged, and the receipt is the proof.
//  2. A PERCENTAGE IS EVALUATED, NOT STORED AS A PRODUCT. $99.45 is 65% of the
//     $153.00 building permit; the same 65% on a bigger job is a different number.
//     It is taken off the BASE permit fee (`b.feeUsd`), before surcharges, because
//     that is what "of the building permit fee" names.
//  3. ROUNDED PER CHARGE, like the surcharges above it — the receipt's own
//     arithmetic is per line, and summing unrounded then rounding once drifts.
//
// AND THE HONEST HALF: A CONDITIONAL CHARGE WHOSE TRIGGER NOBODY ANSWERED IS
// CARRIED WITH amountUsd:null, NEVER DROPPED. Dropping it produces a smaller total
// that reads exactly like a complete one — which is the $762.93-as-$298 defect
// rebuilt one level down, and it would be harder to see because the charge WOULD
// appear in the itemisation with a plausible neighbour beside it.
// ---------------------------------------------------------------------------

/** Can the RECORDED PROJECT FACTS say this conditional charge is incurred?
 *
 *  THREE-VALUED, AND `false` IS DELIBERATELY UNREACHABLE. knownElectricalReviewRequired
 *  — the one fact of this kind the parser records — is a `known…` predicate: it returns
 *  false both for "the plan set says no review" and for "nothing in the plan set
 *  mentions one". Those are different facts and only one of them is permission to drop
 *  a charge from somebody's total, so this returns `true` (the facts assert it) or
 *  `null` (nobody has said), and never the value that would let an absence read as a
 *  denial. A charge whose trigger genuinely does not apply is answered by an operator
 *  entering the portal's own figure, not by this function guessing.
 *
 *  Scoped to the conditions the recorded facts actually speak to — one, today. A
 *  condition this cannot read comes back `null`, which is the truth about our
 *  knowledge and not a claim about the jurisdiction. */
/** " | " is the note SEGMENT separator (mergeNotes splits on it). Research output
 *  routinely contains it — a stored charge label is often the whole printed row,
 *  "Fire - Plan Review | $50.00" — so any of it quoted into a REASON has to lose
 *  it, or the first writer to file that reason into notes shreds it into
 *  fragments. Same rule pathMissReason already follows by hand. */
function noPipe(value: string): string {
  return String(value ?? "").replace(/\s*\|\s*/g, " — ");
}

/**
 * TWO KINDS OF "CONDITIONAL", AND ONLY ONE OF THEM IS AN OPEN QUESTION ABOUT THIS FILING.
 *
 * The rule that an unpriced conditional charge nulls the total was written for a review that is
 * MANDATORY above some threshold — Salem's electrical plan review "when required", Portland's
 * above-25-kVA review. Nobody has answered whether it applies, the answer changes the bill
 * today, and a smaller confident number is the dangerous one. That rule stays.
 *
 * But every jurisdiction researched for the active six also publishes OVERAGE fees: a
 * reinspection charged when an inspection fails, a fee for revising plans after submittal, a
 * charge for checksheets beyond the two the plan review includes. Those are contingent on events
 * that have not happened, and by construction cannot have happened on a filing not yet made.
 * The operator's own paid $762.93 City of Portland receipt — four bills from three bureaus —
 * contains not one of them. Holding a total hostage to them means Portland, Salem and Lincoln
 * City can never produce a number at all, which is the opposite of the job.
 *
 * DEFAULT IS HOLD. This releases only on wording that is unmistakably about extra work beyond
 * what the permit already covers; anything ambiguous keeps the existing behaviour. Note what is
 * deliberately NOT here: "additional" on its own. Portland prints "Additional Plan Review Fee:
 * For changes, additions, or revisions to plans" (overage) three lines from a mandatory review
 * whose text also says "additional", and Salem's "Electrical Plan Review (when required or
 * requested)" must keep holding. So the match is on whole phrases, not on one suggestive word.
 *
 * A literal, like FORMULA_LABEL above, for the same reason: a regex assembled from pieces is a
 * regex nobody can check against the strings it is supposed to match.
 */
const FUTURE_CONTINGENT_CHARGE =
  /\bre-?inspection\b|\bre-?review\b|\beach\s+additional\s+inspection\b|\badditional\s+inspections?\b|\bbeyond\s+(?:the\s+)?(?:\d+\s+)?(?:checksheets?|inspections?|reviews?|hours?)\b|\bchanges,?\s*additions,?\s*or\s*revisions\b|\brevisions?\s+to\s+plans\b|\bafter\s+(?:permit\s+)?issuance\b|\bper\s+additional\s+checksheet\b|\badditional\s+checksheet\b|\blate\s+fee\b|\bpenalt(?:y|ies)\b|\bexpired?\s+permit\b|\bwork\s+(?:started|commenced)\s+without\b/i;

/**
 * Is this conditional charge about something that has not happened yet, rather than about a
 * property of this filing? Reads the condition AND the label, because jurisdictions split the
 * information between them ("Reinspection Fee - fee charged per inspection" carries it all in
 * the label, with an empty condition).
 */
export function chargeIsFutureContingent(condition: string | undefined, label: string | undefined): boolean {
  return FUTURE_CONTINGENT_CHARGE.test(`${String(label ?? "")} ${String(condition ?? "")}`);
}

/**
 * A THRESHOLD THE CONDITION NAMES, IN kVA. Portland's electrical plan review prints its own
 * trigger — "Solar Generation System Over 25 KVA (Plan Review Required)" — and the researched
 * condition repeats it. Matched narrowly on an explicit over/above/exceeding phrase, because
 * this value is allowed to answer a question a human would otherwise be asked.
 */
const KVA_THRESHOLD = /\b(?:over|above|exceed(?:s|ing)?|in\s+excess\s+of|greater\s+than)\s*\$?\s*(\d+(?:\.\d+)?)\s*kva\b/i;

/** Test seam only: conditionalChargeApplies is internal, and its threshold answers are exactly
 *  the kind of quiet "does not apply" that must be provable in both directions. */
export function __testConditionalChargeApplies(
  condition: string,
  inputs: { electricalReviewRequired?: boolean; kw?: number | null },
): true | false | null {
  return conditionalChargeApplies(condition, inputs);
}

function conditionalChargeApplies(
  condition: string,
  inputs: { electricalReviewRequired?: boolean; kw?: number | null },
): true | false | null {
  // Recorded project facts outrank everything: an operator (or the parser) saying electrical
  // plan review IS required settles it, whatever size the system is.
  if (inputs.electricalReviewRequired === true
    && /\belectrical\b[^.;]{0,60}\bplan\s+review\b|\bplan\s+review\b[^.;]{0,60}\belectrical\b/i.test(condition)) {
    return true;
  }
  // THE SCHEDULE ANSWERED ITS OWN QUESTION. When the condition names a kVA threshold and this
  // project's rating is known and at-or-below it, the charge does not apply — by the
  // jurisdiction's own words, evaluated against the same kW the bracket was matched on. This is
  // a determination, not a guess: without it, every residential quote at every jurisdiction
  // whose plan review triggers above 25 kVA was held UNRESOLVED for a review that a 7 kW
  // rooftop can never incur. `false` here, never for an unknown size — a project with no
  // rating stays an open question (null), because an unknown must not read as reassurance.
  const threshold = KVA_THRESHOLD.exec(condition);
  if (threshold && inputs.kw != null && Number.isFinite(inputs.kw)) {
    const limit = Number(threshold[1]);
    if (Number.isFinite(limit) && inputs.kw <= limit) return false;
    // Above the threshold the charge applies — same words, other side of the same line.
    if (Number.isFinite(limit) && inputs.kw > limit) return true;
  }
  return null;
}

/** The charge the PERMIT itself is, plus its surcharges — the parts already inside
 *  the line's own `feeUsd`. Itemised so the screens can show the arithmetic the
 *  receipt shows, never so anybody re-adds them. */
function permitCharges(
  schedule: FeeScheduleRecord,
  b: FeeBracket,
  bracketLabel: string,
  bracketQuote: string,
  stateSurchargeUsd: number | undefined,
  communitySurchargeUsd: number | undefined,
): FeeChargeBreakdown[] {
  const out: FeeChargeBreakdown[] = [{
    label: clean(b.label) || bracketLabel,
    kind: "permit",
    amountUsd: round2(b.feeUsd),
    partOfLineFee: true,
    conditional: false,
    reason: "",
    quote: bracketQuote,
    sourceUrl: clean(b.corroboration?.sourceUrl) || schedule.sourceUrl,
  }];
  if (stateSurchargeUsd != null && b.stateSurcharge) {
    out.push({
      label: `State surcharge (${b.stateSurcharge.percent}% of the permit fee)`,
      kind: "state_surcharge",
      amountUsd: stateSurchargeUsd,
      partOfLineFee: true,
      conditional: false,
      reason: "",
      quote: clean(b.stateSurcharge.quote),
      sourceUrl: clean(b.stateSurcharge.sourceUrl),
    });
  }
  if (communitySurchargeUsd != null && b.communitySurcharge) {
    out.push({
      label: `Community surcharge (${b.communitySurcharge.percent}% of the permit fee)`,
      kind: "community_surcharge",
      amountUsd: communitySurchargeUsd,
      partOfLineFee: true,
      conditional: false,
      reason: "",
      quote: clean(b.communitySurcharge.quote),
      sourceUrl: clean(b.communitySurcharge.sourceUrl),
    });
  }
  return out;
}

/** Every ancillary charge this bracket carries, priced for THIS filing.
 *
 *  `appliesTo` IS A FILTER AND NOT A LABEL. Portland's fire and land-use reviews
 *  ride the BUILDING filing; an electrical pass that folded them into the electrical
 *  permit would bill them twice the moment both rows are quoted together. A charge
 *  naming no discipline rides the filing as a whole and is charged wherever it is
 *  stored — which is why the storage side attaches a filing-level charge to exactly
 *  one row per jurisdiction. */
function ancillaryCharges(
  schedule: FeeScheduleRecord,
  b: FeeBracket,
  inputs: { electricalReviewRequired?: boolean; kw?: number | null; batteryServiceFeeder?: boolean },
): FeeChargeBreakdown[] {
  const out: FeeChargeBreakdown[] = [];
  for (const c of b.ancillaryCharges ?? []) {
    if (c.appliesTo && c.appliesTo !== schedule.discipline) continue;
    // A battery job's services/feeders <=200A line is emitted ONCE, by
    // serviceFeederCharges below, which knows the answer to the condition this
    // stored charge may carry ("when the job includes a service"). Listing it here
    // too would bill it twice, or hold it open as a question already answered.
    if (inputs.batteryServiceFeeder && isServiceFeeder200Label(c.label)) continue;
    // Rule 2 above: a percentage is a function of the BASE permit fee, evaluated
    // here and rounded here, never a product somebody stored.
    const amount = c.percent != null ? round2(b.feeUsd * c.percent / 100) : round2(c.amountUsd ?? 0);
    const basis = c.percent != null
      ? `${c.percent}% of ${clean(c.percentOf) || "the permit fee"} ($${b.feeUsd.toFixed(2)})`
      : "";
    const known = c.conditional ? conditionalChargeApplies(c.condition, inputs) : true;
    // THE SCHEDULE ANSWERED NO. A charge whose printed trigger is a kVA threshold this project
    // is below does not apply to this filing — the same skip as a charge naming another
    // discipline, and for the same reason: it is not this filing's charge. Only an explicit
    // false skips; an unanswered condition (null) stays listed and holds the total.
    if (known === false) continue;
    // An overage fee is not a question about THIS filing — see chargeIsFutureContingent. It is
    // still listed, with its own wording, so an operator knows what a failed inspection or a
    // plan revision would cost; it just stops nulling a total it is not part of.
    const futureContingent = c.conditional && known !== true && chargeIsFutureContingent(c.condition, c.label);
    out.push({
      label: c.label,
      kind: c.kind,
      amountUsd: known === true ? amount : null,
      partOfLineFee: false,
      conditional: c.conditional,
      ...(futureContingent ? { futureContingent: true } : {}),
      // ACTIONABLE CLAUSE FIRST, AND SHORT ENOUGH TO SURVIVE THE SLICE.
      //
      // submissionFees.normalizeScheduleResult cuts a reason to 400 characters and
      // resolutionFrom joins several together, so LENGTH IS A CORRECTNESS PROPERTY
      // here, not a style one: the repair leads, the jurisdiction's own condition is
      // capped (a research note is not length-bounded), and the sentence fits.
      //
      // No FEE_CONFLICT_MARKER — nothing disagrees with anything here, a question has
      // simply not been put. And no " | ": that is the note SEGMENT separator
      // mergeNotes splits on, and a reason carrying it would be shredded into
      // fragments the first time somebody fed this string into a row's notes. The
      // label and the percentage basis are RESEARCH OUTPUT and routinely carry it
      // ("Fire - Plan Review | $50.00"), so they are stripped rather than trusted.
      reason: known === true
        ? ""
        : futureContingent
          ? `NOT PART OF THIS QUOTE — "${noPipe(c.label)}"${basis ? ` (${noPipe(basis)})` : ` (${amount.toFixed(2)})`} is charged only if it happens`
            + `${clean(c.condition) ? `: ${noPipe(clean(c.condition)).slice(0, 120)}` : ""}. A filing that has not been made cannot `
            + `have failed an inspection or revised its plans, so it is shown here and left out of the total.`
          : `CONDITIONAL CHARGE UNRESOLVED — confirm whether this filing incurs "${noPipe(c.label)}"`
          + `${basis ? ` (${noPipe(basis)})` : ` ($${amount.toFixed(2)})`} and enter the portal's own figure. `
          + `${noPipe(clean(schedule.ahj)) || "This jurisdiction"} levies it only on some filings`
          + `${clean(c.condition) ? `: ${noPipe(clean(c.condition)).slice(0, 120)}` : ""}. `
          + `Nothing is quoted for it, and the total stays UNRESOLVED rather than smaller.`,
      quote: basis ? `${c.quote} — ${basis}` : c.quote,
      sourceUrl: c.sourceUrl,
    });
  }
  return out;
}

/** DOES A BATTERY ADD THE SERVICES/FEEDERS <=200A LINE TO THIS FILING?
 *
 *  Operator rule 2026-09-24 — see batteryServiceFeeder.ts. Both inputs come from
 *  that module's one predicate each: the battery from the parser snapshot
 *  (tri-state; only "yes" adds anything — an unknown adds nothing and claims
 *  nothing), the filing from the discipline this line is FOR. */
function batteryServiceFeederApplies(
  project: Pick<ProjectRecord, "parserSnapshot">,
  track: FeeTrack,
  filing: FeeDiscipline,
): boolean {
  if (track !== "permit") return false;
  if (!feeFilingIsElectrical(track, filing)) return false;
  return batteryStatus(project.parserSnapshot as Record<string, unknown> | null | undefined) === "yes";
}

/** Where a stored schedule records the services/feeders <=200A amount, if it
 *  does: an ancillary charge carrying that label (the shape research writes a
 *  second line of the same filing in), or an UNSIZED bracket carrying it. Only a
 *  flat dollar amount answers — a percentage of "the permit fee" is not the
 *  price of a service line. */
function storedServiceFeederAmount(
  schedule: FeeScheduleRecord,
  b: FeeBracket,
): { amountUsd: number; quote: string; sourceUrl: string } | null {
  for (const c of b.ancillaryCharges ?? []) {
    if (c.appliesTo && c.appliesTo !== schedule.discipline) continue;
    if (!isServiceFeeder200Label(c.label)) continue;
    const amount = Number(c.amountUsd);
    if (c.amountUsd == null || !Number.isFinite(amount) || amount < 0) continue;
    return { amountUsd: round2(amount), quote: clean(c.matchedLine) || clean(c.quote), sourceUrl: clean(c.sourceUrl) || schedule.sourceUrl };
  }
  for (const other of schedule.brackets) {
    if (other === b) continue;
    if (other.minKw != null || other.maxKw != null || other.minValuationUsd != null || other.maxValuationUsd != null) continue;
    if (!isServiceFeeder200Label(other.label)) continue;
    const amount = Number(other.feeUsd);
    if (!Number.isFinite(amount) || amount < 0) continue;
    return { amountUsd: round2(amount), quote: bracketEvidence(schedule, other), sourceUrl: clean(other.corroboration?.sourceUrl) || schedule.sourceUrl };
  }
  return null;
}

/** THE BATTERY'S SERVICES/FEEDERS <=200A LINE, as its own charge on the filing.
 *
 *  `partOfLineFee: false`, so resolutionFrom adds it to the filing's total and
 *  the permit line's own amount (what a form's kVA row and a portal's kVA box ask
 *  for) is untouched. Its surcharges ride beside it at the SAME percentages the
 *  bracket's own surcharges carry: those statements are about "all permit fees"
 *  (Tigard) and "the subtotal" (Coos), and a services line is a permit fee.
 *
 *  NOT PRICED AS $0 AND NOT LEFT OUT when the schedule does not record the
 *  amount — which, on 2026-09-24, is every stored schedule. It is listed with
 *  `amountUsd: null`, which is what nulls the total (a filing missing one of its
 *  charges is not a smaller filing) and what puts the gap, in these words, on
 *  the fee sheet's STILL-UNKNOWN list. */
function serviceFeederCharges(
  schedule: FeeScheduleRecord,
  b: FeeBracket,
  inputs: { batteryServiceFeeder?: boolean },
): FeeChargeBreakdown[] {
  if (!inputs.batteryServiceFeeder) return [];
  const label = `${SERVICE_FEEDER_200A_LABEL} (battery/ESS on the electrical permit)`;
  const stored = storedServiceFeederAmount(schedule, b);
  if (!stored) {
    const who = noPipe(clean(schedule.ahj)) || "this jurisdiction";
    return [{
      label,
      kind: SERVICE_FEEDER_CHARGE_KIND,
      amountUsd: null,
      partOfLineFee: false,
      conditional: false,
      // ACTIONABLE CLAUSE FIRST and under 400 characters (normalizeScheduleResult
      // slices there); no " | " (the note-segment separator).
      reason: `SERVICES/FEEDERS <=200A AMOUNT MISSING — a battery/ESS on an electrical permit adds one `
        + `"${SERVICE_FEEDER_200A_LABEL}" line (operator rule 2026-09-24), and ${who}'s stored schedule does not `
        + `record that line's amount. Nothing is quoted for it and the total stays UNRESOLVED rather than smaller: `
        + `enter the amount from the published schedule or the portal's own fee.`,
      quote: "",
      sourceUrl: "",
    }];
  }
  const out: FeeChargeBreakdown[] = [{
    label,
    kind: SERVICE_FEEDER_CHARGE_KIND,
    amountUsd: stored.amountUsd,
    partOfLineFee: false,
    conditional: false,
    reason: "",
    quote: stored.quote,
    sourceUrl: stored.sourceUrl,
  }];
  if (b.stateSurcharge) {
    out.push({
      label: `State surcharge (${b.stateSurcharge.percent}% of the services/feeders fee)`,
      kind: SERVICE_FEEDER_STATE_SURCHARGE_KIND,
      amountUsd: round2(stored.amountUsd * b.stateSurcharge.percent / 100),
      partOfLineFee: false,
      conditional: false,
      reason: "",
      quote: clean(b.stateSurcharge.quote),
      sourceUrl: clean(b.stateSurcharge.sourceUrl),
    });
  }
  if (b.communitySurcharge) {
    out.push({
      label: `Community surcharge (${b.communitySurcharge.percent}% of the services/feeders fee)`,
      kind: SERVICE_FEEDER_COMMUNITY_SURCHARGE_KIND,
      amountUsd: round2(stored.amountUsd * b.communitySurcharge.percent / 100),
      partOfLineFee: false,
      conditional: false,
      reason: "",
      quote: clean(b.communitySurcharge.quote),
      sourceUrl: clean(b.communitySurcharge.sourceUrl),
    });
  }
  return out;
}

/** THE ONE EVALUATOR. Both public entry points below route through this, so the
 *  bracket boundary can only ever be decided in one place — two parallel
 *  evaluations would drift, and the boundary is the whole point of the table. */
function evaluateSchedule(
  schedule: FeeScheduleRecord,
  inputs: { kw: number | null; kwSource: string; valuationUsd: number | null; valuationIsEstimate?: boolean; track?: FeeTrack; permitPath?: FeePathInput; electricalReviewRequired?: boolean; batteryServiceFeeder?: boolean },
): { feeUsd: number | null; baseFeeUsd?: number; stateSurchargeUsd?: number; communitySurchargeUsd?: number; bracketLabel: string; bracketQuote: string; corroboration?: FeeBracketCorroboration; reason: string; charges?: FeeChargeBreakdown[]; fromEstimatedValuation?: boolean } {
  const miss = (reason: string) => ({ feeUsd: null, bracketLabel: "", bracketQuote: "", reason });
  const hit = (b: FeeBracket) => {
    const bracketQuote = bracketEvidence(schedule, b);
    const corroboration = b.corroboration?.corroborated ? b.corroboration : undefined;
    const bracketLabel = bracketLabelFor(b, schedule.basis);
    if (schedule.discipline === 'electrical' && inputs.electricalReviewRequired) {
      return {feeUsd:null,bracketLabel,bracketQuote,corroboration,
        reason:'Electrical plan review is required by the recorded project facts. Its additional charge must be resolved before quoting a grand total.'};
    }
    // A LADDER WE CAN READ IS NOT AN UNKNOWN. Portland's valuation table prints the base, the
    // step and the per-step rate in the bracket's own wording; when all three are there and the
    // base agrees with this bracket's own fee, the formula is arithmetic, not a mystery.
    //
    // WHAT THIS MUST NOT DO IS RETURN HERE. The first version of this computed the amount and
    // returned it on the spot, skipping everything below — the evidence/amount conflict check,
    // the bracket's surcharges, and the FILING's ancillary charges, whose percentages are
    // functions OF the permit fee. Measured on Trask: Portland's 65% Plan Review/Process Fee is
    // an UNCONDITIONAL charge on his structural permit, $384.85 of real money, and his sheet
    // showed no charges block at all and no sign that anything was missing. So the ladder only
    // replaces the bracket's AMOUNT, and every rule below runs on it unchanged.
    let ladderFeeUsd: number | null = null;
    if (bracketDescribesFormula(b.label)) {
      const ladder = schedule.basis === "valuation" ? parseValuationLadder(b) : null;
      if (!ladder) {
        return {
          feeUsd: null,
          bracketLabel,
          bracketQuote,
          corroboration,
          reason: `This bracket is a FORMULA, not a flat fee — "${String(b.label ?? "").slice(0, 120)}". The stored `
            + `$${b.feeUsd.toFixed(2)} is one part of it (a base, a floor or a per-unit rate, and schedules differ), `
            + `so quoting it would under-state the real fee. Read the published schedule and enter the portal's own `
            + `figure once you have it.`,
        };
      }
      const computed = evaluateValuationLadder(ladder, inputs.valuationUsd);
      if (computed == null) {
        // The formula is known and the valuation is not. THIS is the case an "enter the job
        // valuation" affordance actually resolves — say so, instead of the generic refusal.
        return {
          feeUsd: null,
          bracketLabel,
          bracketQuote,
          corroboration,
          reason: `This fee is $${ladder.baseUsd.toFixed(2)} for the first $${ladder.aboveUsd.toLocaleString("en-US")} of valuation `
            + `plus $${ladder.ratePerStepUsd.toFixed(2)} per $${ladder.stepUsd.toLocaleString("en-US")} above it — but this project `
            + `carries NO JOB VALUATION, so there is nothing to walk the ladder with. Record the job valuation and this resolves itself.`,
        };
      }
      ladderFeeUsd = computed;
    }

    // THE EVIDENCE AND THE CHARGE MUST BE THE SAME MONEY.
    //
    // Measured on the live Coos County row: the stored evidence read "5.01 KVA
    // to 15 KVA | $160.00" while the bracket matched for a 3.072 kVA job charges
    // $135 — so the sentence printed beside the number named a DIFFERENT number,
    // on three of the four brackets. Quoted confidently, that is worse than no
    // citation at all: the operator reads "published as $160", quotes $135, and
    // one of the two is wrong with no way to tell which from this screen.
    //
    // Re-using FEE_CONFLICT_MARKER is the point, not a shortcut. This IS the
    // conflict the marker names — two readings of the same published schedule
    // that do not agree — so it degrades exactly the way a two-source conflict
    // already does: the amount falls to the tier below and submissionFees.ts
    // leads the basis line with the disagreement (its FEE_CONFLICT_RE is
    // unanchored, so the marker survives resolutionFrom's reason join).
    //
    // NOTE WHAT THIS DOES NOT DO: it never moves the bracket. The row matched
    // for 3.072 kVA is still "5 KVA or less"; a "fix" that picked a different
    // bracket to agree with the quote would invent a real under/over-quote where
    // there was only a mis-grained citation. The refusal is scoped to the ROW's
    // status being untouched too — 'conflicted' there means two documents
    // disagree, which is a different and durable fact about the jurisdiction.
    const named = quotedAmounts(bracketQuote);
    if (named.length && !named.includes(round2(b.feeUsd))) {
      return {
        feeUsd: null,
        bracketLabel,
        bracketQuote,
        corroboration,
        reason: `${FEE_CONFLICT_MARKER}: the evidence stored for this line names `
          + `${named.slice(0, 4).map((n) => `$${n.toFixed(2)}`).join(" / ")}, but the bracket matched for this `
          + `project charges $${b.feeUsd.toFixed(2)} — "${bracketQuote.slice(0, 160)}". A citation that names a `
          + `different amount than the one being charged cannot support it, so nothing is quoted from this line. `
          + `Re-read the published schedule and re-save the row with the line this bracket is actually printed on.`,
      };
    }

    // THE BRACKET, WITH THE LADDER'S ANSWER IN PLACE OF ITS PRINTED BASE. Everything from here
    // down — surcharges, the permit charge, the filing's percentage charges — is a function of
    // "the permit fee", and for a ladder bracket the permit fee is what the ladder computed, not
    // the base rung it started from. The conflict check above deliberately stayed on `b`: the
    // stored evidence names the BASE ($540.78), and testing the computed $592.08 against it
    // would manufacture a disagreement where the schedule agrees with itself.
    const eb: FeeBracket = ladderFeeUsd == null ? b : { ...b, feeUsd: ladderFeeUsd };

    const stateSurchargeUsd = eb.stateSurcharge ? round2(eb.feeUsd * eb.stateSurcharge.percent / 100) : undefined;
    const communitySurchargeUsd = eb.communitySurcharge ? round2(eb.feeUsd * eb.communitySurcharge.percent / 100) : undefined;
    // THE PERMIT LINE'S OWN AMOUNT IS UNCHANGED, and that is deliberate: the
    // ancillary charges are levied on the FILING, not on this permit, and a form
    // field or a portal quantity that asks for "the electrical permit fee" must
    // keep getting the electrical permit fee. They are added at resolutionFrom,
    // where the filing's total is made, and they travel on `charges` so the
    // screens can itemise both halves without either of them moving.
    const charges = [
      ...permitCharges(schedule, eb, bracketLabel, bracketQuote, stateSurchargeUsd, communitySurchargeUsd),
      ...ancillaryCharges(schedule, eb, inputs),
      ...serviceFeederCharges(schedule, eb, inputs),
    ];
    return { feeUsd: round2(eb.feeUsd + (stateSurchargeUsd ?? 0) + (communitySurchargeUsd ?? 0)), baseFeeUsd: feeIncludesSurcharges(`${b.label ?? ''} ${bracketQuote}`) ? undefined : eb.feeUsd, stateSurchargeUsd, communitySurchargeUsd, charges,
      fromEstimatedValuation: ladderFeeUsd != null && inputs.valuationIsEstimate === true,
      bracketLabel, bracketQuote: stateSurchargeUsd == null ? bracketQuote
        : `${bracketQuote}; ${eb.stateSurcharge!.quote} (+$${stateSurchargeUsd.toFixed(2)})${communitySurchargeUsd == null ? '' : `; ${eb.communitySurcharge!.quote} (+$${communitySurchargeUsd.toFixed(2)})`}.`, corroboration, reason: "" };
  };

  // A DISPUTED FEE IS REFUSED BY ITS OWN BRANCH, AND IT IS THE FIRST ONE.
  //
  // This used to be an ACCIDENT that worked. jurisdictionHarvest.ts stores a
  // conflicted schedule as basis "other" carrying both candidates' brackets —
  // the one shape that falls past every branch below to the "needs a human"
  // miss at the bottom — and its author wrote the coupling down because they
  // could not edit this file: "if basis 'other' with multiple brackets ever
  // becomes evaluable, conflicted schedules silently start answering with one of
  // the two disputed numbers." That is a safety property resting on a
  // fall-through nobody reading evaluateSchedule would recognise as load-bearing.
  // Someone teaching "other" to evaluate a two-row table — a perfectly ordinary
  // improvement — would have quietly started quoting Coos County $94 or $160
  // with no way to tell which, and no test would have gone red.
  //
  // So the refusal is now a FACT ON THE ROW (fee_schedules.status, v23) checked
  // before any basis is looked at. It holds whatever the basis is, whatever the
  // bracket count is, and whatever `confidence` says: a person marking a
  // conflicted row 'verified' has verified that we hold two contradictory
  // numbers, which is not permission to quote one of them.
  if (schedule.status === "conflicted") {
    return miss(
      `${FEE_CONFLICT_MARKER}: two published sources disagree about this jurisdiction's fee — ${conflictSummary(schedule)}. `
      + `Nothing is quoted from a disputed schedule; it needs a human to pick a source and re-save it.`,
    );
  }

  if (!schedule.brackets.length) return miss("Schedule is stored but carries no fee lines.");

  // THE PATH FILTERS THE CANDIDATES, IT DOES NOT VETO THE WINNER — and that
  // difference is the whole reason this is SELECTION rather than a second gate
  // bolted after matchBracket. A jurisdiction that publishes both paths in one
  // table (a prescriptive flat line and an engineered valuation line) must hand
  // an engineered project the ENGINEERED line, not refuse. A jurisdiction that
  // publishes only the other path's line has nothing to hand over, and says so.
  const track = inputs.track ?? "permit";
  const candidates = bracketsForPath(schedule, track, inputs.permitPath);
  if (!candidates.length) {
    // Reached only when one of the two path gates applied (otherwise
    // candidates === brackets, and the empty case was already refused above), so
    // this is one of three facts: your path is not priced here, nobody has decided
    // your path yet, or nobody ever put the question. pathRefusalReason picks.
    return miss(pathRefusalReason(schedule, inputs.permitPath, schedule.brackets));
  }

  // NOTE THE WIDENING, AND WHY IT IS SAFE. This arm used to read
  // `schedule.brackets.length === 1`; it now reads the FILTERED list, so a
  // basis-"other" row holding one line per path becomes evaluable for the path
  // that matched. jurisdictionHarvest.ts's author wrote down the exact fear this
  // raises: "if basis 'other' with multiple brackets ever becomes evaluable,
  // conflicted schedules silently start answering with one of the two disputed
  // numbers." It cannot happen here, for two independent reasons — a conflicted
  // row is refused by the status branch ABOVE this, before any basis is looked at
  // (v23 made that a fact on the row rather than this fall-through); and a
  // conflict's two candidates are the SAME jurisdiction's fee read off two
  // documents, so their labels differ by amount and date, never by path, and the
  // filter never separates them. feeConflict.test.ts holds both halves.
  if (schedule.basis === "flat" || (schedule.basis === "other" && candidates.length === 1)) {
    return hit(candidates[0]);
  }

  if (schedule.basis === "system_kw") {
    if (inputs.kw == null) return miss("Schedule brackets on system size, but this project has no system size yet.");
    const b = matchBracket(candidates, inputs.kw, "kw");
    // "OUTSIDE EVERY BRACKET" AND "THE ONLY BRACKET THAT FITS IS THE OTHER PATH'S"
    // are different facts with different repairs — one sends a person looking for
    // a row we failed to read, the other tells them this table prices the other
    // path. Re-matching the UNFILTERED list is the only way to tell them apart.
    if (!b) {
      if (candidates.length !== schedule.brackets.length && matchBracket(schedule.brackets, inputs.kw, "kw")) {
        return miss(pathRefusalReason(schedule, inputs.permitPath, schedule.brackets.filter((x) => !candidates.includes(x))));
      }
      return miss(`System size ${inputs.kw} kW (${inputs.kwSource || "rated"}) falls outside every published bracket — check the schedule for a row we missed.`);
    }
    return hit(b);
  }

  if (schedule.basis === "valuation") {
    if (inputs.valuationUsd == null) return miss("Schedule brackets on job valuation, but this project has no valuation yet.");
    const b = matchBracket(candidates, inputs.valuationUsd, "valuation");
    if (!b) {
      if (candidates.length !== schedule.brackets.length && matchBracket(schedule.brackets, inputs.valuationUsd, "valuation")) {
        return miss(pathRefusalReason(schedule, inputs.permitPath, schedule.brackets.filter((x) => !candidates.includes(x))));
      }
      return miss(`Valuation $${inputs.valuationUsd.toLocaleString()} falls outside every published bracket.`);
    }
    return hit(b);
  }

  // THIS IS NO LONGER THE CONFLICT REFUSAL — the status branch at the top is.
  // It is back to meaning only what it says: a table that is not a function of
  // anything this code evaluates. Teaching "other" to evaluate something is now
  // a safe change; before v23 it would have unblocked every disputed schedule
  // in the table at the same time.
  return miss(`Schedule basis "${schedule.basis}" needs a human to read it — see notes and the source quote.`);
}

/** Resolve a stored schedule to a NUMBER (and a bracket label) for THIS project.
 *  Returns null when no schedule is stored at all; returns a row with feeUsd
 *  null + a reason when a schedule exists but cannot be evaluated — so "we have
 *  no schedule" never reads as "the fee is zero". */
export function feeForProject(
  db: AppDb,
  project: Pick<ProjectRecord, "state" | "ahj" | "utility" | "systemSizeAcKw" | "systemSizeDcKw" | "parserSnapshot">,
  trackInput?: string | null,
): ProjectFeeResolution | null {
  const track = feeTrack(trackInput);
  // A SUBMITTAL TRACK NAMES ITS PERMIT. "electrical"/"mpu" → the electrical fee,
  // "building" → the structural one; a bare "permit" (or a null) names no
  // discipline and asks for everything this project owes.
  const asked = feeDiscipline(recipeDisciplineForTrack(trackInput));
  if (asked) {
    const line = resolveLine(db, project, track, asked);
    if (!line) return null;
    return { ...resolutionFrom([line], track), lines: [line] };
  }

  const lines = feeLinesForProject(db, project, track);
  if (!lines.length) return null;
  return { ...resolutionFrom(lines, track), lines };
}

/** Evaluate one already-resolved schedule into a line. */
function lineFor(
  db: AppDb,
  project: Pick<ProjectRecord, "systemSizeAcKw" | "systemSizeDcKw" | "parserSnapshot" | "state">,
  track: FeeTrack,
  schedule: FeeScheduleRecord,
  hoppedFrom: string,
  /** Which permit this line is FOR — decides whether a battery adds the
   *  services/feeders line (batteryServiceFeeder.ts). Required, not defaulted: a
   *  forgotten argument must be a compile error, not a silently dropped line. */
  filing: FeeDiscipline,
  inputs?: FeeEvalInputs,
): FeeScheduleLine {
  const { kw, which } = inputs ? { kw: inputs.kw, which: inputs.kwSource } : systemRatingKw(project);
  // Only pay for the valuation walk when the schedule actually keys on it.
  const valuation = inputs || schedule.basis !== "valuation" ? null : resolveValuation(project.parserSnapshot, project.systemSizeDcKw);
  const valuationUsd = inputs ? inputs.valuationUsd : (valuation ? valuation.value : null);
  const valuationIsEstimate = inputs ? inputs.valuationIsEstimate === true : valuation?.method !== "contract";
  // Same ternary, same reason as feeLinesForProject — see the note there.
  const permitPath: FeePathInput = inputs ? inputs.permitPath : pathForProject(project, track);
  const evaluated = evaluateSchedule(schedule, { kw, kwSource: which, valuationUsd, valuationIsEstimate, track, permitPath, electricalReviewRequired: knownElectricalReviewRequired(project.parserSnapshot),
    batteryServiceFeeder: batteryServiceFeederApplies(project, track, filing) });
  return {
    discipline: schedule.discipline,
    authority: track === "nem" ? schedule.utility : schedule.ahj,
    hoppedFrom,
    feeUsd: evaluated.feeUsd,
    baseFeeUsd: evaluated.baseFeeUsd,
    stateSurchargeUsd: evaluated.stateSurchargeUsd,
    communitySurchargeUsd: evaluated.communitySurchargeUsd,
    bracketLabel: evaluated.bracketLabel,
    basis: schedule.basis,
    paymentMethod: schedule.paymentMethod,
    sourceUrl: schedule.sourceUrl,
    sourceQuote: schedule.sourceQuote,
    bracketQuote: evaluated.bracketQuote,
    ...(evaluated.corroboration ? { corroboration: evaluated.corroboration } : {}),
    confidence: schedule.confidence,
    // Same rule as the sibling builder above — both sites, or the two entry points disagree
    // about the same number depending on which one happened to ask.
    valuationEstimated: evaluated.fromEstimatedValuation === true,
    notes: schedule.notes,
    scheduleId: schedule.id,
    reason: evaluated.reason,
    charges: evaluated.charges ?? [],
  };
}

/** COLLAPSE THE LINES TO THE ONE NUMBER THE CUSTOMER OWES.
 *
 *  A project that files two permits owes both, so the total is their sum — and
 *  one unreadable line makes the TOTAL unreadable, not smaller. Returning
 *  "$200" while a $160 line sits unresolved beside it is the under-quote this
 *  whole dimension exists to stop, and it would look exactly like a confident
 *  answer. The lines travel alongside so a caller can show the split. */
function resolutionFrom(lines: FeeScheduleLine[], track: FeeTrack): Omit<ProjectFeeResolution, "lines"> {
  const primary = lines[0];
  const unresolved = lines.filter((l) => l.feeUsd == null);
  // THE FILING'S OTHER CHARGES, GATHERED ONCE.
  //
  // DE-DUPLICATED BY (label, source) ACROSS THE LINES, and the guard is cheap
  // insurance against the one way this arithmetic can go wrong in the customer's
  // favour of the jurisdiction: a filing-level charge attached to BOTH of a
  // jurisdiction's rows would otherwise be billed twice. The storage side attaches
  // a charge naming no discipline to exactly one row per jurisdiction, and
  // ancillaryCharges() already drops a charge whose `appliesTo` names another
  // filing — this is the belt to those braces, and it is keyed on the printed
  // label plus the document so two genuinely different reviews from two bureaus
  // (Portland's fire and land-use) are never collapsed into one.
  const seenCharge = new Set<string>();
  const charges: FeeChargeBreakdown[] = [];
  for (const line of lines) {
    for (const c of line.charges ?? []) {
      // THE DOCUMENT IS NOT PART OF A FILING-LEVEL CHARGE'S IDENTITY.
      //
      // Measured: two $100 permits plus ONE filing-wide $217 review totalled $634
      // instead of $417, because the jurisdiction's two discipline passes each
      // corroborated that one review from a DIFFERENT published document. Keying on
      // sourceUrl made the same charge two charges. The same fixture with both passes
      // citing one URL deduped correctly, which isolates the URL term as the cause.
      //
      // Two genuinely different reviews are already distinguished by the thing the
      // jurisdiction printed — Portland bills "Fire - Plan Review" and "Land Use Plan
      // Review Res" — so kind+label separates them without the URL, and the URL only
      // ever splits what should be one charge.
      //
      // A per-LINE charge (the permit and its own surcharges) keeps the line in its
      // key, because those legitimately recur once per permit filed.
      const key = c.partOfLineFee
        ? `${c.kind}|${c.label.toLowerCase()}|${c.sourceUrl.toLowerCase()}|${line.scheduleId}`
        : `${c.kind}|${c.label.toLowerCase()}`;
      if (seenCharge.has(key)) continue;
      seenCharge.add(key);
      charges.push(c);
    }
  }
  const extra = charges.filter((c) => !c.partOfLineFee);
  // AN UNPRICED CHARGE NULLS THE TOTAL EXACTLY AS AN UNPRICED LINE DOES — same
  // rule, same vocabulary, no fourth state. A conditional review nobody has
  // answered is the difference between a $762.93 filing and a confident $663.48,
  // and the smaller number is the dangerous one because it looks finished.
  // …EXCEPT A CHARGE FOR SOMETHING THAT HAS NOT HAPPENED. A reinspection fee is unpriced for
  // the same reason it is not owed: nothing has been inspected. Every jurisdiction researched
  // for the active six publishes one, so counting them here meant none of them could ever
  // produce a total — and the operator's own paid $762.93 Portland receipt, four bills from
  // three bureaus, contains not a single overage charge. They stay on the sheet; they stop
  // holding a number hostage to an event that cannot have occurred yet.
  const unpricedCharges = extra.filter((c) => c.amountUsd == null && c.futureContingent !== true);
  const total = unresolved.length || unpricedCharges.length
    ? null
    : round2(lines.reduce((sum, l) => sum + (l.feeUsd ?? 0), 0) + extra.reduce((sum, c) => sum + (c.amountUsd ?? 0), 0));
  const label = lines.length === 1 && !extra.length
    ? primary.bracketLabel
    : [
      ...lines.map((l) => `${l.authority || "?"}${l.discipline ? ` ${l.discipline}` : ""}: ${l.feeUsd == null ? "unresolved" : `$${l.feeUsd.toFixed(2)}`}`),
      ...extra.map((c) => `${c.label}: ${c.amountUsd == null ? "unresolved" : `$${c.amountUsd.toFixed(2)}`}`),
    ].join(" + ");
  return {
    feeUsd: total,
    charges,
    bracketLabel: label,
    // A mixed-basis total is not any one basis. "other" is the existing value
    // for "a human has to read this", which is exactly right for the split.
    basis: lines.length === 1 ? primary.basis : (lines.every((l) => l.basis === primary.basis) ? primary.basis : "other"),
    // Likewise the payment method: two permits paid two ways cannot be reported
    // as one, and 'unknown' is what already makes the fee sheet say so.
    paymentMethod: lines.every((l) => l.paymentMethod === primary.paymentMethod) ? primary.paymentMethod : "unknown",
    sourceUrl: primary.sourceUrl,
    sourceQuote: primary.sourceQuote,
    // NO SINGLE PUBLISHED LINE SUPPORTS A TOTAL OF TWO PERMITS. A Coos Bay
    // rooftop owes the city $200 and the county $135; no document anywhere
    // prints $335, so quoting ANY row beside it — which is what propagating
    // lines[0]'s citation did — is a citation for a number its source never
    // mentioned. "" here, and the caller shows each line's own evidence beside
    // its own amount (`lines[i].bracketQuote`). The same reasoning covers the
    // ancillary charges: a single permit line PLUS a fire review is still a sum no
    // document prints, so `extra.length` disqualifies the citation exactly as a
    // second permit does.
    bracketQuote: lines.length === 1 && !extra.length ? primary.bracketQuote : "",
    // Weakest link, like confidence: a total is corroborated only if every line
    // in it was found printed. Still never a promotion — confidence below is
    // decided separately and code never writes 'verified'.
    corroborated: lines.length > 0 && lines.every((l) => !!l.corroboration?.corroborated),
    // The weakest confidence in the set: a verified line does not vouch for a
    // seeded one standing next to it in the same total.
    confidence: lines.some((l) => l.confidence === "seeded") ? "seeded" : "verified",
    // Weakest link again: one line computed off a guessed valuation makes the whole total a
    // number to true up, however solid the rest of it is.
    valuationEstimated: lines.some((l) => l.valuationEstimated === true),
    matchedName: lines.length === 1 ? primary.authority : lines.map((l) => l.authority).filter(Boolean).join(" + "),
    scheduleId: primary.scheduleId,
    // EVERY REASON THE TOTAL IS UNREADABLE, LINES AND CHARGES ALIKE. An unpriced
    // charge that nulled the total without saying why would be the worst of both:
    // no number and no repair.
    reason: [
      ...unresolved.map((l) => `${l.authority || "this jurisdiction"}${l.discipline ? ` (${l.discipline})` : ""}: ${l.reason}`),
      ...unpricedCharges.map((c) => c.reason),
    ].join(" "),
  };
}

// ---------------------------------------------------------------------------
// Seam: the quote ladder's "published_schedule" tier — THE FALLBACK NAME, NOT THE
// EXPORT PRODUCTION LOADS. READ THIS BEFORE FIXING ANYTHING HERE.
//
// submissionFees.ts loads this module by name and takes the FIRST export it finds
// from `LOOKUP_EXPORTS = ["feeForProject", "lookupPublishedFee"]`, most-current
// first. feeForProject is always exported, so IT is what every production quote
// runs through, and this function has NO PRODUCTION CALLER AT ALL.
//
// This header used to say the loader "looks for exactly this export
// (`mod?.lookupPublishedFee`)", which is false and was expensive: a whole round's
// work landed on this dead seam believing it was the live one, while the same
// defect stayed live on feeForProject. A fix to the path gate belongs in
// evaluateSchedule / bracketsForPath, which both entry points share; anything done
// only here is done to a compatibility shim.
//
// The name is still load-bearing in one direction: a MISSING export is SILENT (the
// loader warns only on a require error), so if feeForProject were ever renamed and
// this one had been deleted, the whole tier would quietly vanish and every quote
// would fall back to guessing 1.5% of valuation. Keep BOTH names.
//
// Deliberately typed against LOCAL structural interfaces rather than the shared
// PublishedFeeLookupInput/Result: the consumer owns those, they are still in
// flight, and this module must keep compiling if they move. Its loader
// duck-types the function and its normalizer whitelists every field of the
// result, so nothing is lost by staying structural.
// ---------------------------------------------------------------------------

export interface PublishedFeeLookupArgs {
  track: string;
  state: string;
  ahj: string;
  utility: string;
  /** The size to bracket on, pre-computed by the caller (AC-first, as the kVA
   *  brackets intend). Falls back to the AC/DC fields when absent. */
  bracketKw?: number | null;
  systemSizeAcKw?: number | null;
  systemSizeDcKw?: number | null;
  /** Pre-resolved job valuation — this seam gets no parser snapshot, so a
   *  valuation-keyed schedule is unresolvable without it (and says so). */
  valuationUsd?: number | null;
  // THERE IS DELIBERATELY NO `permitPath` HERE, AND ITS ABSENCE IS THE POINT.
  //
  // One existed for exactly one round and NOTHING IN PRODUCTION EVER SET IT — this
  // seam has no production caller at all (see the header above), so the field could
  // only ever be set by the tests written to exercise it. A field only tests set is
  // a field only tests are protected by, and it read as though the path question
  // had been dealt with here while the live gate — feeForProject's — still let an
  // undecided path quote a prescriptive-only line.
  //
  // A caller that holds a project already has the answer and should call
  // feeForProject(db, project, track), which resolves the path from the project's
  // own plan set through the same resolver the document gate uses. A caller that
  // holds only jurisdiction names and a size is, correctly, told that the path was
  // never checked (pathUncheckedReason) rather than being handed a switch that
  // silences the refusal without doing the check.
}

export interface PublishedFeeLookupResult {
  feeUsd: number | null;
  bracketLabel: string | null;
  sourceUrl: string | null;
  /** ROW GRAIN, AND A MACHINE SIGNAL RATHER THAN A CITATION. The consumer reads
   *  it with MAILED_CHECK_RE as a last resort — how the money moves is a fact
   *  about the schedule, not about which bracket matched — so it stays the row's
   *  own sentence. Do NOT print it beside the amount; that is `bracketQuote`. */
  sourceQuote: string;
  /** The evidence for THIS amount, safe to show beside it. "" when the amount is
   *  the total of more than one permit. */
  bracketQuote: string;
  /** Every line was found printed in its cited document. Never promotes
   *  `confidence`, which only a person may move to 'verified'. */
  corroborated: boolean;
  /** 'portal' | 'mailed_check' | 'none' | 'unknown' — the consumer whitelists
   *  exactly these and drops anything else, which is why this is normalised on
   *  the way into the table rather than here. */
  paymentMethod: FeePaymentMethod;
  confidence: FeeConfidence;
  /** A HUMAN one-liner for the quote screen, not the basis enum. */
  basis: string;
  /** The schedule's own name for the jurisdiction — may be the legal name where
   *  the project carries an operator short name. */
  jurisdictionName: string;
  /** The filing's charges, itemised — see shared FeeChargeBreakdown. Carried at
   *  this seam too so the compatibility shim and feeForProject cannot answer the
   *  same question two different ways. */
  charges: FeeChargeBreakdown[];
}

/** Look up the published schedule for a project and evaluate it. Returns null
 *  when no schedule is stored; `feeUsd: null` when one is stored but cannot be
 *  evaluated for this project. Never throws at the caller — it runs inside the
 *  staging gate, where a thrown error would block a submission. */
export function lookupPublishedFee(db: AppDb, input: PublishedFeeLookupArgs): PublishedFeeLookupResult | null {
  try {
    const track = feeTrack(input.track);
    const kwRaw = num(input.bracketKw) ?? num(input.systemSizeAcKw) ?? num(input.systemSizeDcKw);
    // ANNOTATED, NOT INFERRED. FeeEvalInputs requires `permitPath`; spelling the
    // type here is what makes the compiler reject this object literal if the field
    // is ever dropped again, instead of quietly inferring a narrower shape that
    // the call site below still accepts.
    const evalInputs: FeeEvalInputs = {
      kw: kwRaw != null && kwRaw > 0 ? kwRaw : null,
      kwSource: input.bracketKw != null ? "bracket" : "AC/DC",
      valuationUsd: num(input.valuationUsd),
      // "UNRESOLVED", ALWAYS, WITH NO ARGUMENT THAT CAN OVERRIDE IT. The project
      // built below carries `parserSnapshot: null`: this seam is handed jurisdiction
      // names and a size, never a plan set, so nothing here has ever looked at a
      // permit path and saying otherwise would be a claim that a check happened.
      // NOT `pathForProject(project, track)` either — that resolver would read the
      // empty snapshot, return "unknown", and quietly restate "we never looked" as
      // "we looked and could not tell", which are different facts with different
      // repairs. See PublishedFeeLookupArgs for why there is no field to pass.
      permitPath: "unresolved",
    };
    const project = {
      state: input.state, ahj: input.ahj, utility: input.utility,
      systemSizeAcKw: null, systemSizeDcKw: null, parserSnapshot: null,
    } as unknown as Pick<ProjectRecord, "state" | "ahj" | "utility" | "systemSizeAcKw" | "systemSizeDcKw" | "parserSnapshot">;

    // THE TRACK STILL NAMES THE PERMIT AT THIS SEAM. input.track carries the
    // submittal track ("electrical", "building", …) — feeTrack() collapses it to
    // permit/nem for the table, but the discipline is still in there, and an
    // electrical stage asking for "the permit fee" must not be handed the
    // structural one.
    const asked = feeDiscipline(recipeDisciplineForTrack(input.track));
    let lines: FeeScheduleLine[];
    if (asked) {
      const line = resolveLine(db, project, track, asked, evalInputs);
      if (!line) return null;
      lines = [line];
    } else {
      lines = feeLinesForProject(db, project, track, evalInputs);
    }
    if (!lines.length) return null;

    const rolled = resolutionFrom(lines, track);
    const jurisdictionName = rolled.matchedName;
    return {
      feeUsd: rolled.feeUsd,
      bracketLabel: rolled.bracketLabel || null,
      sourceUrl: rolled.sourceUrl || null,
      sourceQuote: rolled.sourceQuote,
      bracketQuote: rolled.bracketQuote,
      corroborated: rolled.corroborated,
      paymentMethod: rolled.paymentMethod,
      confidence: rolled.confidence,
      basis: rolled.feeUsd == null
        ? rolled.reason
        : `Published fee schedule${lines.length > 1 ? "s" : ""}${jurisdictionName ? ` (${jurisdictionName})` : ""}${rolled.bracketLabel ? `: ${rolled.bracketLabel}` : ""}`,
      jurisdictionName,
      charges: rolled.charges,
    };
  } catch (err) {
    logger.warn("fees", "lookupPublishedFee failed — falling through the quote ladder", { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Paid receipts against the seeded schedules (read-only reconciliation)
// ---------------------------------------------------------------------------
//
// L5. Real paid-fee receipts sit in permit_fee_history under `receipt_component:`
// and every quote deliberately ignores them (submissionFees.learnedFee), because a
// receipt's discipline label is unreliable: Tigard's `REP` receipt is filed as
// "electrical", yet its $351.19 is electrical $133.56 + structural $180.00 + the 12%
// Oregon state surcharge. A per-discipline median would record that combined total
// as the electrical fee. So receipts do NOT become a quote rung — they are held up
// against the schedule instead, and a disagreement goes to a person.
//
// READ-ONLY. reconcileReceiptsWithSchedules never writes, and nothing here ever
// changes a schedule (hard rule 3): a receipt is evidence for a person to weigh,
// not an instruction to rewrite a row.

/** How a schedule stands against the receipts paid at its jurisdiction.
 *   · corroborated — a receipt equals (within $0.02) a total this schedule, as held,
 *     can produce: one discipline, or electrical + structural combined, each with or
 *     without the schedule's own flat processing fee.
 *   · corroborated_missing_surcharge — a receipt matches ONLY once the 12% Oregon
 *     state surcharge is added to permit lines that do not carry it. The schedule's
 *     brackets are right and its quote is short: the margin finding this exists for.
 *   · contradicted — no total the schedule can produce matches any receipt. */
export type ReceiptReconciliationVerdict = "corroborated" | "corroborated_missing_surcharge" | "contradicted";

export const MISSING_OR_SURCHARGE_CAUSE = "missing 12% OR state surcharge";
const RECEIPT_MATCH_TOLERANCE_USD = 0.02;
const OREGON_STATE_SURCHARGE_PERCENT = 12;

export interface ReconciledReceipt {
  jurisdiction: string;
  /** The parser's label — shown, never trusted (see the header above). */
  discipline: string;
  authorityAmountUsd: number;
  projectId: string | null;
  /** The candidate total that explained this receipt for this schedule; "" = none. */
  explainedBy: string;
  /** True when that explanation needed the 12% surcharge the schedule does not hold. */
  neededSurcharge: boolean;
}

export interface ScheduleReceiptReconciliation {
  profileKey: string;
  track: FeeTrack;
  discipline: FeeDiscipline;
  state: string;
  ahj: string;
  confidence: FeeConfidence;
  verdict: ReceiptReconciliationVerdict;
  /** "" unless a cause is actually shown by the numbers. */
  likelyCause: string;
  receipts: ReconciledReceipt[];
}

export interface ReceiptReconciliationReport {
  results: ScheduleReceiptReconciliation[];
  /** Denominators: a clean-looking result list means nothing without them. */
  schedulesConsidered: number;
  schedulesWithoutReceipts: number;
  /** Conflicted rows and delegation rows price nothing, so they are not compared. */
  schedulesSkipped: number;
  receiptsRead: number;
  receiptsWithoutSchedule: number;
}

interface ReceiptRow { receipt: PaidFeeReceipt; state: string; projectId: string | null }

/** A county and a city sharing a word are different authorities: "Lincoln County"
 *  scores 65 against "City of Lincoln City" in knowledgeNameMatchScore, over the
 *  60 bar. Only a KNOWN kind on both sides can disagree. */
function jurisdictionKind(name: string): "county" | "city" | "" {
  if (/\bcounty\b/i.test(name)) return "county";
  if (/\b(?:city|town|village)\b/i.test(name)) return "city";
  return "";
}

function receiptsFromHistory(db: AppDb): ReceiptRow[] {
  return db.query<Row>(
    "SELECT state, source, project_id FROM permit_fee_history WHERE track = 'permit' AND source LIKE 'receipt_component:%' ORDER BY recorded_at, id",
  ).flatMap((row) => {
    try {
      const receipt = JSON.parse(text(row.source).slice("receipt_component:".length)) as PaidFeeReceipt;
      const amount = Number(receipt?.authorityAmountUsd);
      if (!receipt || !clean(receipt.jurisdiction) || !Number.isFinite(amount) || amount <= 0) return [];
      return [{ receipt, state: clean(row.state).toUpperCase(), projectId: row.project_id ? text(row.project_id) : null }];
    } catch { return []; }
  });
}

/** One permit line a schedule can charge, with what the schedule itself adds to it. */
interface ReceiptPart {
  schedule: FeeScheduleRecord;
  baseUsd: number;
  label: string;
  /** Surcharge percents the schedule already holds for this line (deduped: the same
   *  12% can arrive both as bracket.stateSurcharge and as an ancillary). */
  heldPercents: number[];
  /** Unconditional flat processing fees: filing-wide ('' appliesTo) vs this discipline's. */
  filingFlatUsd: number;
  ownFlatUsd: number;
}

function receiptParts(schedule: FeeScheduleRecord): ReceiptPart[] {
  const parts: ReceiptPart[] = [];
  for (const b of schedule.brackets) {
    const baseUsd = Number(b.feeUsd);
    if (!Number.isFinite(baseUsd) || baseUsd <= 0) continue;
    const held = new Set<number>();
    if (b.stateSurcharge?.percent) held.add(b.stateSurcharge.percent);
    if (b.communitySurcharge?.percent) held.add(b.communitySurcharge.percent);
    let filingFlatUsd = 0, ownFlatUsd = 0;
    for (const c of b.ancillaryCharges ?? []) {
      if (c.conditional) continue;
      const rides = !c.appliesTo ? "filing" : (!schedule.discipline || c.appliesTo === schedule.discipline) ? "own" : "";
      if (!rides) continue;
      if (c.kind === "surcharge" && c.percent != null && c.percent > 0) held.add(c.percent);
      else if (c.kind === "processing" && c.amountUsd != null && c.amountUsd > 0) {
        if (rides === "filing") filingFlatUsd += c.amountUsd; else ownFlatUsd += c.amountUsd;
      }
    }
    parts.push({ schedule, baseUsd, label: clean(b.label).slice(0, 60), heldPercents: [...held], filingFlatUsd, ownFlatUsd });
  }
  return parts;
}

interface ReceiptCandidate { totalUsd: number; neededSurcharge: boolean; description: string; schedules: FeeScheduleRecord[] }

/** Every total a combination of permit lines can reach: the held surcharges always,
 *  the Oregon 12% added where a line lacks it (flagged), flat processing on or off.
 *  The surcharge is taken on the PERMIT LINE only, then flat fees are added — Salem:
 *  $94 × 1.12 + $5 = $110.28, while ($94 + $5) × 1.12 = $110.88 is not a real bill. */
function receiptCandidates(parts: ReceiptPart[], oregon: boolean): ReceiptCandidate[] {
  const out: ReceiptCandidate[] = [];
  const lacks12 = parts.some((p) => !p.heldPercents.includes(OREGON_STATE_SURCHARGE_PERCENT));
  for (const add12 of oregon && lacks12 ? [false, true] : [false]) {
    let permitTotal = 0;
    for (const p of parts) {
      permitTotal += p.baseUsd;
      for (const pct of p.heldPercents) permitTotal += round2(p.baseUsd * pct / 100);
      if (add12 && !p.heldPercents.includes(OREGON_STATE_SURCHARGE_PERCENT)) permitTotal += round2(p.baseUsd * OREGON_STATE_SURCHARGE_PERCENT / 100);
    }
    // A filing-wide fee is charged once per filing, however many permit lines ride it.
    const flat = Math.max(0, ...parts.map((p) => p.filingFlatUsd)) + parts.reduce((s, p) => s + p.ownFlatUsd, 0);
    const lines = parts.map((p) => `${p.schedule.discipline || "permit"} "${p.label}" $${p.baseUsd.toFixed(2)}`).join(" + ");
    const surcharge = add12 ? ` + ${OREGON_STATE_SURCHARGE_PERCENT}% OR state surcharge (not held by the schedule)` : "";
    out.push({ totalUsd: round2(permitTotal), neededSurcharge: add12, description: `${lines}${surcharge}`, schedules: parts.map((p) => p.schedule) });
    if (flat > 0) out.push({ totalUsd: round2(permitTotal + flat), neededSurcharge: add12, description: `${lines}${surcharge} + $${flat.toFixed(2)} processing`, schedules: parts.map((p) => p.schedule) });
  }
  return out;
}

/** READ-ONLY. Compare every paid receipt with the permit schedule(s) held for the same
 *  jurisdiction — fuzzy name + state, as learnedFee matches — and say, per schedule,
 *  whether the receipts corroborate it. Never writes; never changes a schedule. */
export function reconcileReceiptsWithSchedules(db: AppDb): ReceiptReconciliationReport {
  const all = db.query<Row>("SELECT * FROM fee_schedules WHERE track = 'permit' ORDER BY profile_key, discipline").map(mapSchedule);
  const usable = all.filter((s) => s.status === "ok" && !s.collectedByProfileKey && s.brackets.length > 0);
  const groups = new Map<string, FeeScheduleRecord[]>();
  for (const s of usable) groups.set(s.profileKey, [...(groups.get(s.profileKey) ?? []), s]);

  // Each receipt goes to its BEST-scoring jurisdiction only, never to every name
  // that clears the bar.
  const receipts = receiptsFromHistory(db);
  const byGroup = new Map<string, ReceiptRow[]>();
  let receiptsWithoutSchedule = 0;
  for (const r of receipts) {
    let best = 0;
    let keys: string[] = [];
    for (const [key, rows] of groups) {
      const s = rows[0];
      const rowState = s.state.trim().toUpperCase();
      if (r.state && rowState && rowState !== r.state) continue;
      const a = jurisdictionKind(r.receipt.jurisdiction), b = jurisdictionKind(s.ahj);
      if (a && b && a !== b) continue;
      const score = knowledgeNameMatchScore(r.receipt.jurisdiction, s.ahj);
      if (score < 60 || score < best) continue;
      if (score > best) { best = score; keys = []; }
      keys.push(key);
    }
    if (!keys.length) { receiptsWithoutSchedule++; continue; }
    for (const key of keys) byGroup.set(key, [...(byGroup.get(key) ?? []), r]);
  }

  const results: ScheduleReceiptReconciliation[] = [];
  let schedulesWithoutReceipts = 0;
  for (const [key, rows] of groups) {
    const groupReceipts = byGroup.get(key) ?? [];
    if (!groupReceipts.length) { schedulesWithoutReceipts += rows.length; continue; }
    const oregon = rows[0].state.trim().toUpperCase() === "OR";
    const partsBySchedule = new Map(rows.map((s) => [s, receiptParts(s)] as const));
    const candidates: ReceiptCandidate[] = [];
    for (const [, parts] of partsBySchedule) for (const p of parts) candidates.push(...receiptCandidates([p], oregon));
    // Combined filings: one electrical line + one structural line from distinct rows.
    // Never a combo or undifferentiated row with anything — Douglas County holds both
    // with identical brackets, and adding them would double-count one permit.
    const elec = rows.find((s) => s.discipline === "electrical");
    const struct = rows.find((s) => s.discipline === "structural");
    if (elec && struct) {
      for (const e of partsBySchedule.get(elec) ?? []) for (const st of partsBySchedule.get(struct) ?? []) {
        candidates.push(...receiptCandidates([e, st], oregon));
      }
    }
    for (const schedule of rows) {
      const mine = candidates.filter((c) => c.schedules.includes(schedule));
      const reconciled: ReconciledReceipt[] = groupReceipts.map((r) => {
        const amount = Number(r.receipt.authorityAmountUsd);
        const hits = mine.filter((c) => Math.abs(c.totalUsd - amount) <= RECEIPT_MATCH_TOLERANCE_USD);
        const hit = hits.find((c) => !c.neededSurcharge) ?? hits[0];
        return {
          jurisdiction: clean(r.receipt.jurisdiction), discipline: clean(r.receipt.discipline),
          authorityAmountUsd: amount, projectId: r.projectId,
          explainedBy: hit ? `$${hit.totalUsd.toFixed(2)} = ${hit.description}` : "",
          neededSurcharge: !!hit?.neededSurcharge,
        };
      });
      const verdict: ReceiptReconciliationVerdict = reconciled.some((r) => r.explainedBy && !r.neededSurcharge)
        ? "corroborated"
        : reconciled.some((r) => r.explainedBy) ? "corroborated_missing_surcharge" : "contradicted";
      results.push({
        profileKey: schedule.profileKey, track: schedule.track, discipline: schedule.discipline,
        state: schedule.state, ahj: schedule.ahj, confidence: schedule.confidence, verdict,
        likelyCause: verdict === "corroborated_missing_surcharge" ? MISSING_OR_SURCHARGE_CAUSE : "",
        receipts: reconciled,
      });
    }
  }
  return {
    results,
    schedulesConsidered: usable.length,
    schedulesWithoutReceipts,
    schedulesSkipped: all.length - usable.length,
    receiptsRead: receipts.length,
    receiptsWithoutSchedule,
  };
}

export const RECEIPT_REVIEW_ISSUE_TYPE = "Fee schedule disagrees with paid receipts";

export interface ReceiptReviewOutcome {
  profileKey: string;
  action: "inserted" | "updated" | "unchanged" | "no_anchor";
  projectId: string | null;
}

/** ONE deduped operator review item per schedule KEY whose receipts do not plainly
 *  corroborate it. The note names the key, the verdicts and the receipt AMOUNTS —
 *  never a receipt or permit number. It changes no schedule (rule 3).
 *
 *  human_review_items rows belong to a project, so the item rides a project that
 *  paid one of the disagreeing receipts (same org as the receipt by construction).
 *  A receipt imported with no project has nowhere to land: that key is reported as
 *  `no_anchor` rather than attached to some other tenant's job.
 *
 *  Dedupe: an item for the key with the SAME evidence, in any status, is left alone
 *  (a dismissed item is not resurrected by an unrelated upload); new evidence
 *  updates the pending item, or opens one if the old item was closed. */
export function raiseReceiptContradictionReviews(db: AppDb, report: ReceiptReconciliationReport): ReceiptReviewOutcome[] {
  const byKey = new Map<string, ScheduleReceiptReconciliation[]>();
  for (const r of report.results) byKey.set(r.profileKey, [...(byKey.get(r.profileKey) ?? []), r]);
  const outcomes: ReceiptReviewOutcome[] = [];
  for (const [profileKey, rows] of byKey) {
    const flagged = rows.filter((r) => r.verdict !== "corroborated");
    if (!flagged.length) continue;
    const amounts = [...new Set(flagged.flatMap((r) => r.receipts.map((x) => x.authorityAmountUsd.toFixed(2))))].sort();
    const fingerprint = `${flagged.map((r) => `${r.discipline || "any"}:${r.verdict}`).sort().join(",")}|${amounts.join(",")}`;
    const lines = flagged.map((r) => {
      const surchargeHit = r.receipts.find((x) => x.neededSurcharge);
      const why = r.verdict === "contradicted"
        ? `no total this schedule can produce matches any receipt ($${[...new Set(r.receipts.map((x) => x.authorityAmountUsd.toFixed(2)))].join(", $")})`
        : `${r.likelyCause}: receipt $${surchargeHit?.authorityAmountUsd.toFixed(2)} = ${(surchargeHit?.explainedBy ?? "").replace(/^\$[\d.]+ = /, "")}`;
      return `${r.discipline || "undifferentiated"} schedule (${r.confidence}) ${r.verdict === "contradicted" ? "CONTRADICTED" : "SHORT"}: ${why}.`;
    });
    const notes = [
      `Fee schedule ${profileKey} disagrees with paid receipts.`,
      ...lines,
      "The schedule was NOT changed. Check it against the jurisdiction's current fee sheet and correct or verify it by hand.",
    ].join(" ").slice(0, 1500);
    const fieldName = `fee_schedule:${profileKey}`;
    const same = db.get<Row>("SELECT id, project_id FROM human_review_items WHERE issue_type = ? AND field_name = ? AND parser_value = ? LIMIT 1",
      [RECEIPT_REVIEW_ISSUE_TYPE, fieldName, fingerprint]);
    if (same) { outcomes.push({ profileKey, action: "unchanged", projectId: text(same.project_id) }); continue; }
    const ts = nowIso();
    const pending = db.get<Row>("SELECT id, project_id FROM human_review_items WHERE issue_type = ? AND field_name = ? AND status = 'pending' LIMIT 1",
      [RECEIPT_REVIEW_ISSUE_TYPE, fieldName]);
    if (pending) {
      db.run("UPDATE human_review_items SET parser_value = ?, notes = ?, updated_at = ? WHERE id = ?", [fingerprint, notes, ts, text(pending.id)]);
      outcomes.push({ profileKey, action: "updated", projectId: text(pending.project_id) });
      continue;
    }
    const anchor = flagged.flatMap((r) => r.receipts.filter((x) => r.verdict === "contradicted" || x.neededSurcharge))
      .map((x) => x.projectId).find((pid) => pid && db.get<Row>("SELECT id FROM projects WHERE id = ?", [pid])) ?? null;
    if (!anchor) { outcomes.push({ profileKey, action: "no_anchor", projectId: null }); continue; }
    db.run(
      `INSERT INTO human_review_items
        (id, project_id, issue_type, field_name, parser_value, llm_suggested_value, source_excerpt, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', '', 'pending', ?, ?, ?)`,
      [id(), anchor, RECEIPT_REVIEW_ISSUE_TYPE, fieldName, fingerprint, notes, ts, ts],
    );
    outcomes.push({ profileKey, action: "inserted", projectId: anchor });
  }
  return outcomes;
}
