// ---------------------------------------------------------------------------
// THE FROZEN FEE-BRACKET QUANTITY — computing the box instead of remembering it.
//
// This is the bug migration v19 was written to make fixable, in its own words:
// Coos Bay's Accela recipe carries the frozen answer "Renewable energy for
// electrical systems- 5.01kva through 15kva = 1", which is a FEE BRACKET
// QUANTITY. Accela renders ONE TEXT BOX PER BRACKET ROW of Coos County's
// schedule and the quantity ticks the row that applies. "1" is the answer for
// the project that was LEARNED; replay it onto a 20 kVA job and the county
// bills the 5.01–15 tier for a 15.01–25 system — wrong, and invisible, because
// the field looks answered and every click succeeds.
//
// v19 stored the schedule as a FUNCTION so the bracket could be evaluated per
// project; v22 gave it the DISCIPLINE dimension, because this fee is the COUNTY's
// electrical permit, reached from a City of Coos Bay project through the stored
// city→county hop. All this module does is turn that evaluation into the flat
// Record<string,string> replay already substitutes step `field`s from:
//
//     feeBracketQuantity:-5        -> "0"
//     feeBracketQuantity:5.01-15   -> "1"     <- this job's bracket
//     feeBracketQuantity:15.01-25  -> "0"
//
// Bind each recorded box to its own key and replay needs no change at all: "0"
// is a non-empty string, so it passes the adapter's `if (!v)` blank check and is
// typed like any other value.
//
// ---------------------------------------------------------------------------
// WHY THERE IS A SECOND BRACKET MATCHER HERE, AND WHY IT CANNOT DRIFT
//
// feeSchedules.ts calls its evaluator "THE ONE EVALUATOR ... so the bracket
// boundary can only ever be decided in one place — two parallel evaluations
// would drift, and the boundary is the whole point of the table." That comment
// is right, and `matchBracket` is private, so the containment test below is a
// copy of it.
//
// A copy is only dangerous when it can disagree SILENTLY. So it does not get the
// last word: after the local match picks a bracket, feeForProject() — the one
// evaluator, through its public door — is asked the same question, and the keys
// are emitted ONLY if it agrees on the schedule row, the fee and the bracket
// label. Any disagreement, and any reason the evaluator cannot price this job at
// all, returns {} — no keys, so the recipe's recorded literal replays exactly as
// it does today. Drift therefore degrades to the status quo, which is visible,
// instead of to a computed "0", which is not.
//
// That veto also inherits refusals this module knows nothing about: a schedule
// the evaluator declines to price (no size on the project, a hop that lands
// nowhere, a jurisdiction whose stored sources disagree) arrives here as
// feeUsd: null and the keys simply do not appear.
//
// TODO once feeSchedules.ts is quiet: fold this containment test into
// matchBracket by exporting it, and keep the veto as the regression test.
// ---------------------------------------------------------------------------
import type { AppDb } from "./db";
import type { ProjectRecord } from "../../shared/src/types";
import type { FeeBracket, FeeScheduleRecord } from "./feeSchedules";
import { feeForProject, findFeeScheduleForProject } from "./feeSchedules";
import { FEE_TIER_RATING_FIELD, feeBracketFieldKey, tierBoundsFromLabel } from "../../portal-bot/src/feeBracketQuantity";
import { SERVICE_FEEDER_200A_FIELD, isServiceFeeder200Label, serviceFeeder200Quantity } from "./batteryServiceFeeder";

/** The project shape this needs — the same Pick feeForProject takes, so a caller
 *  that can evaluate a fee can always call this. */
export type FeeBracketProject = Pick<
  ProjectRecord,
  "state" | "ahj" | "utility" | "systemSizeAcKw" | "systemSizeDcKw" | "parserSnapshot"
>;

/** The submittal track this fee belongs to. The Accela boxes this exists for are
 *  Coos County's ELECTRICAL permit table; "electrical" is what
 *  recipeDisciplineForTrack maps onto the electrical fee row, and what
 *  findFeeScheduleForProject/feeForProject are asked for below.
 *
 *  resolveRecipeFieldValues has no track in its signature, so this is fixed
 *  rather than passed. The degradation is safe in the other direction: a
 *  structural recipe's bracket box would bind a key the ELECTRICAL schedule does
 *  not emit, the key resolves unknown, and the step replays its kept literal —
 *  today's behaviour. Where the two disciplines happen to share bounds the
 *  answer is identical anyway. */
const FEE_BRACKET_TRACK = "electrical";

function ratingKw(project: FeeBracketProject): number | null {
  // AC FIRST, for the reason systemRatingKw states: a schedule bracketed in kVA
  // is rating the INVERTER output, and a 20 kW-DC job with 15 kW-AC of inverters
  // sits in a different bracket depending on which you read. DC is the fallback
  // because it is the field most reliably populated.
  const ac = Number(project.systemSizeAcKw);
  if (Number.isFinite(ac) && ac > 0) return ac;
  const dc = Number(project.systemSizeDcKw);
  if (Number.isFinite(dc) && dc > 0) return dc;
  return null;
}

/** A bracket that answers a SIZE question. A row with neither bound carries no
 *  size key (matchBracket skips those for the same reason) and gets no box. */
function isSized(b: FeeBracket): boolean {
  return b.minKw != null || b.maxKw != null;
}

/** Copy of matchBracket's kw arm — first sized bracket whose bounds contain the
 *  value, INCLUSIVE at both ends. Vetoed by feeForProject below. */
function localMatch(brackets: FeeBracket[], kw: number): FeeBracket | null {
  for (const b of brackets) {
    if (!isSized(b)) continue;
    if (b.minKw != null && kw < b.minKw) continue;
    if (b.maxKw != null && kw > b.maxKw) continue;
    return b;
  }
  return null;
}

/** Does the one evaluator agree that THIS bracket is what this project owes? */
function evaluatorAgrees(
  db: AppDb,
  project: FeeBracketProject,
  schedule: FeeScheduleRecord,
  picked: FeeBracket,
): boolean {
  const resolution = feeForProject(db, project, FEE_BRACKET_TRACK);
  const line = resolution?.lines.find((l) => l.scheduleId === schedule.id);
  if (!line || line.feeUsd == null) return false;
  // The line's fee carries the bracket's surcharges (a state surcharge stated by the agency's own
  // source — close M3); the BRACKET's amount is the line before them. Comparing the surcharged
  // total to the bare bracket vetoed every surcharged schedule, so no tier box was ever computed.
  const lineBase = Math.round((line.feeUsd - (line.stateSurchargeUsd ?? 0) - (line.communitySurchargeUsd ?? 0)) * 100) / 100;
  if (lineBase !== picked.feeUsd) return false;
  // The evaluator derives a label when the schedule printed none; compare only
  // when both sides actually have one, or a bounds-derived string would fail a
  // comparison it was never meant to answer.
  const own = String(picked.label ?? "").trim();
  const theirs = String(line.bracketLabel ?? "").trim();
  if (own && theirs && own !== theirs) return false;
  return true;
}

/** ONE KEY PER BRACKET OF THIS PROJECT'S SCHEDULE: "1" for the bracket the job
 *  falls in, "0" for every other.
 *
 *  Returns {} — deliberately no keys — whenever the answer is not certain:
 *    · no schedule on file for this project's AHJ (after the city→county hop);
 *    · a schedule that does not bracket on system size;
 *    · a project with no system size to bracket on;
 *    · a size outside every published bracket (all-zeros would be the same
 *      silent under-bill through a different door);
 *    · the one evaluator disagreeing, or refusing to price the job.
 *  In every one of those cases the recipe's recorded literal is left to replay
 *  exactly as it does today. That is the safe direction: an unbound literal is
 *  the status quo and is visible in the recipe; a computed 0 is neither. */
export function feeBracketQuantityFields(db: AppDb, project: FeeBracketProject): Record<string, string> {
  return {
    ...kvaBracketQuantityFields(db, project),
    ...serviceFeederQuantityFields(project),
    ...feeTierRatingField(project),
  };
}

/** THE RATING THE PAGE-READ TIER IS DECIDED ON (feeBracketQuantity.decideFeeTier, in the replay
 *  adapter). ALWAYS EMITTED — with or without a stored schedule — and "" when the project has no
 *  size: the adapter then refuses to guess the tier and pauses for a person. Live run 99baa5d0
 *  (City of Jefferson OR → Marion County's services page, no Marion schedule on file) had a
 *  12.913 kVA job and no way to say so to the page. The same ratingKw the schedule match uses,
 *  so the two can only ever disagree about the schedule, never about the number. */
function feeTierRatingField(project: FeeBracketProject): Record<string, string> {
  const kw = ratingKw(project);
  return { [FEE_TIER_RATING_FIELD]: kw == null ? "" : String(kw) };
}

/** THE BATTERY'S SERVICES/FEEDERS <=200A BOX — the same frozen-answer bug as the
 *  kVA bracket, on the row next to it.
 *
 *  Operator rule 2026-09-24: a battery job on an electrical permit bills ONE
 *  "Services or feeders: 200 amps or less" line on top of the PV kVA line. The
 *  portal prints that line as its own quantity box, and the recorded quantity is
 *  whatever the LEARN project needed: "0" from a PV-only roof replayed onto a
 *  Powerwall job under-bills the county; "1" from a battery roof replayed onto a
 *  PV-only job bills a service nobody installed. So it is recomputed per project,
 *  exactly as the bracket is.
 *
 *  ALWAYS EMITTED, and "" when the project's battery status is unknown. A
 *  DEFINED key whose value is empty is typed blank by the replay adapter; an
 *  UNDEFINED key replays the recorded literal — the learn project's answer. So
 *  omitting the key for an unknown would carry the frozen quantity through,
 *  and "0" would assert a fact nobody established.
 *
 *  NO SCHEDULE IS CONSULTED. This is a COUNT of service lines, not a price, and
 *  it does not depend on whether we hold the jurisdiction's amount.
 *
 *  THE FILING GATE IS THE BINDING, not this function. resolveRecipeFieldValues
 *  carries no track (see FEE_BRACKET_TRACK), so this key is emitted for every
 *  recipe — and it reaches a portal box only through a step bound to it, which
 *  feeBracketFieldForLabel does only for a label naming the services/feeders
 *  <=200A fee item. That item is printed on electrical (and combination) permit
 *  fee lists only; a building application or a utility interconnection form has
 *  no such box, so the key simply goes unread there. */
function serviceFeederQuantityFields(project: FeeBracketProject): Record<string, string> {
  return { [SERVICE_FEEDER_200A_FIELD]: serviceFeeder200Quantity(project.parserSnapshot as Record<string, unknown> | null | undefined) };
}

/** The kVA bracket half — see the module header. */
function kvaBracketQuantityFields(db: AppDb, project: FeeBracketProject): Record<string, string> {
  let schedule: FeeScheduleRecord | null = null;
  try {
    schedule = findFeeScheduleForProject(db, project, "permit", "electrical");
  } catch {
    // A fee lookup must never break a staging run. No schedule reachable reads
    // as "leave the recipe alone", which is what it was doing yesterday.
    return {};
  }
  if (!schedule || schedule.basis !== "system_kw") return {};

  const sized = schedule.brackets.filter(isSized);
  if (!sized.length) return {};

  const kw = ratingKw(project);
  if (kw == null) return {};

  const picked = localMatch(schedule.brackets, kw);
  if (!picked || !isSized(picked)) return {};

  let agrees = false;
  try {
    agrees = evaluatorAgrees(db, project, schedule, picked);
  } catch {
    agrees = false;
  }
  if (!agrees) return {};

  const out: Record<string, string> = {};
  for (const b of sized) {
    const key = feeBracketFieldKey(b.minKw, b.maxKw);
    if (key) out[key] = "0";
  }
  const matchedKey = feeBracketFieldKey(picked.minKw, picked.maxKw);
  if (!matchedKey || !(matchedKey in out)) return {};
  // Written LAST so two rows printed with identical bounds (a malformed table)
  // still resolve to one ticked box rather than to none.
  out[matchedKey] = "1";
  return out;
}

/** The bracket key a RECORDED PORTAL LABEL is asking about, or "" — including the
 *  battery's services/feeders <=200A box (SERVICE_FEEDER_200A_FIELD).
 *
 *  MATCHING MUST BE NUMERIC, NEVER BY STRING. The Accela label reads
 *  "Renewable energy for electrical systems- 5.01kva through 15kva:" and the
 *  county schedule reads "5.01 KVA to 15 KVA" — different strings, identical
 *  bounds, and any string comparison between them is a coin toss.
 *
 *  The bounds grammar is the ONE portal-label grammar (feeBracketQuantity.
 *  tierBoundsFromLabel — the replay adapter reads the live page with it, and it
 *  cannot import the PDF table reader). Its agreement with pdfTables.parseBracketRow
 *  on the shared spellings is pinned by feeTierFromPage.test. */
export function feeBracketFieldForLabel(label: string): string {
  const text = String(label ?? "").trim();
  if (!text) return "";
  // The services/feeders <=200A row first, and as its own key family: it is a
  // count, not a size bracket, and the tier grammar must never be asked to read
  // "200 amps" as a bound. The two recognisers are disjoint — the services one
  // refuses any label carrying "kva" — so the order only saves a parse.
  if (isServiceFeeder200Label(text)) return SERVICE_FEEDER_200A_FIELD;
  const parsed = tierBoundsFromLabel(text);
  if (!parsed) return "";
  return feeBracketFieldKey(parsed.minKw, parsed.maxKw);
}
