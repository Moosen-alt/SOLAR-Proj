// ---------------------------------------------------------------------------
// A BATTERY ON AN ELECTRICAL PERMIT BILLS ONE "SERVICES OR FEEDERS: 200 AMPS OR
// LESS" LINE.
//
// Operator rule, 2026-09-24, verbatim: "for battery jobs, when on an elec permit,
// it will count as 'Services/feeders 200 amps or less'". So a project with a
// battery/ESS whose filing carries ELECTRICAL fee items (the electrical permit, a
// combination permit, or a jurisdiction's one undifferentiated permit schedule)
// owes ONE services/feeders <=200A item in addition to the PV kVA item. Never on
// a building/structural filing and never on an interconnection (NEM) application.
//
// THREE QUESTIONS, ONE ANSWER EACH, AND THIS MODULE IS WHERE EACH ONE LIVES:
//
//   1. Does this project have a battery?          batteryStatus()
//   2. Does this filing carry electrical fee items? feeFilingIsElectrical()
//   3. Is this printed/recorded label THE services/feeders <=200A line?
//                                                 isServiceFeeder200Label()
//
// The portal fee-item answer (feeBracketFields.ts), the electrical PDF
// (ahjForms.ts computed values) and the fee sheet (feeSchedules.ts) all read
// these, so the three surfaces cannot disagree about the same job. A LEAF on
// purpose: feeBracketFields imports feeSchedules, and both need (3) — a copy in
// each would be two regexes answering one question, which this codebase has
// paid for more than once.
// ---------------------------------------------------------------------------

/** The charge kinds the fee evaluator writes for this line. Exported so the PDF
 *  side reads the amount by kind rather than by re-matching a label. */
export const SERVICE_FEEDER_CHARGE_KIND = "service_feeder_200a";
export const SERVICE_FEEDER_STATE_SURCHARGE_KIND = "service_feeder_200a_state_surcharge";
export const SERVICE_FEEDER_COMMUNITY_SURCHARGE_KIND = "service_feeder_200a_community_surcharge";

/** The flat-map key a recorded portal box binds to. NOT under the
 *  "feeBracketQuantity:" prefix: that family is the kVA brackets, and the
 *  portal-bot coverage check reads every key under it as a kVA row ("every
 *  bracket box this run filled reads 0"), which a services box is not. */
export const SERVICE_FEEDER_200A_FIELD = "feeLineQuantity:servicesFeeders200A";

/** The operator-facing name of the line, in the Oregon schedule's own wording. */
export const SERVICE_FEEDER_200A_LABEL = "Services or feeders: 200 amps or less";

export type BatteryStatus = "yes" | "no" | "unknown";

function str(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

/** DOES THIS PROJECT HAVE A BATTERY? — tri-state.
 *
 *  THE POSITIVE HALF IS portalRecipes.ts's energySource predicate, exactly: the
 *  one that decides whether a utility portal is told "Solar PV and Battery" and
 *  so whether ~17 storage questions get asked at all. hasBattery Yes (written by
 *  normalize.ts from batteryModel / batteryQuantity), OR a battery model, OR a
 *  battery quantity above zero — the fallback covers a snapshot that never went
 *  through normalisation. Reading the same evidence means the fee line and the
 *  portal's own battery declaration cannot disagree about one job.
 *
 *  THE NEGATIVE HALF IS autoLearn.ts's: only an EXPLICIT "no" is a no.
 *  normalize.ts writes hasBattery "No" whenever a parsed plan set carries no
 *  battery model or quantity, so every parsed project answers; a snapshot with
 *  no hasBattery and no battery evidence was never parsed, and silence about a
 *  battery is not a statement that there isn't one. That case is "unknown", and
 *  every caller must treat it as neither answer (an unknown must not read as
 *  reassurance — a "0" typed into a fee box, or a fee sheet without the line,
 *  would both claim a fact nobody established). */
export function batteryStatus(snapshot: Record<string, unknown> | null | undefined): BatteryStatus {
  const s = (snapshot ?? {}) as Record<string, unknown>;
  const flag = str(s.hasBattery);
  const qty = Number(str(s.batteryQuantity) || str(s.batteryQty) || 0);
  if (/^(yes|true|y)$/i.test(flag) || str(s.batteryModel) !== "" || (Number.isFinite(qty) && qty > 0)) return "yes";
  if (/^(no|false|none|n)$/i.test(flag)) return "no";
  return "unknown";
}

/** DOES THIS FILING CARRY ELECTRICAL FEE ITEMS?
 *
 *  `track` is the billing/fee track ("permit" | "nem") or a submittal track;
 *  `discipline` is the fee discipline ("structural" | "electrical" | "combo" |
 *  "") or a submittal track name. The vocabulary is portalChannel
 *  .recipeDisciplineForTrack's: "electrical" and "mpu" file the electrical
 *  permit, "combo" is ONE filing covering both trades, "building"/"structural"
 *  is the structural permit alone.
 *
 *  "" ON THE PERMIT TRACK IS THE WHOLE PROJECT'S PERMIT — an undifferentiated
 *  schedule row, which feeSchedules.applicableSchedules treats as "the whole
 *  answer" for every permit this project owes. Every permit project files an
 *  electrical permit (submittalTracks.requiredTracks always adds either "combo"
 *  or "building"+"electrical"), so that row covers the electrical filing. A
 *  caller asking specifically for the structural permit passes "structural". */
export function feeFilingIsElectrical(track: string | null | undefined, discipline: string | null | undefined): boolean {
  const t = str(track).toLowerCase();
  const d = str(discipline).toLowerCase();
  if (t === "nem" || d === "nem") return false;
  if (t === "building" || t === "structural") return false;
  if (d === "structural" || d === "building") return false;
  return d === "" || d === "electrical" || d === "combo" || d === "mpu" || d === "permit";
}

/** Squash a label to lowercase letters, digits and the few symbols a bound can
 *  be written with. Accela's flattened ASI labels and pdf.js text both arrive
 *  with the spaces gone ("200ampsorless", "Feeforbranchcircuitswithpurchase
 *  ofaserviceorfeederfee"), so matching is done on the squashed form only —
 *  one grammar for every spelling rather than one regex per spelling. */
function squash(label: string): string {
  // "=" is kept so "<= 200A" squashes to "<=200a" (LE_200A's "<=" branch was
  // unreachable while "=" was stripped).
  return label.toLowerCase().replace(/[^a-z0-9<=≤]+/g, "");
}

/** The label with every run of non-alphanumerics turned into ONE space, and
 *  printed money removed. This is the form the AMPERAGE-TIER test and the
 *  word-anchored "rating" test read, because squash() destroys exactly what
 *  they need: it turns "201-400" into "201400", and a digit guard on either
 *  side of 201 or 400 then sees a digit and never fires — so a heading listing
 *  every tier ("200 amps or less / 201-400 amps / 401-600 amps") bound as THE
 *  <=200A row. Money is removed first: "$401.00" printed beside the row is a
 *  price, not the 401-600 tier. Thousands separators are joined ("1,000" is one
 *  number) before the separators become spaces. */
function spaced(label: string): string {
  return label
    .toLowerCase()
    .replace(/\$\s*\d[\d,]*(?:\.\d+)?/g, " ")
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Anything that names ANOTHER line of the same schedule. Each is a real row
 *  printed next to the one we want, on the Coos County and City of Tigard
 *  electrical applications and in the Oregon minimum schedule:
 *    - temporary services or feeders (its own 200A row);
 *    - branch circuits "with/without purchase of a service or feeder fee";
 *    - "Miscellaneous (service or feeder not included)";
 *    - manufactured-home / modular dwelling service or feeder;
 *    - reconnect only;
 *    - the PV/renewable kVA lines (kva / renewable / photovoltaic).
 *
 *  Tested on the SQUASHED form, because Accela's flattened labels carry no word
 *  boundaries ("Feeforbranchcircuitswithpurchase..."). That makes every entry a
 *  plain substring, and both binders hand this the selector label AND the
 *  step's note joined — so an entry must be a word no services/feeders label or
 *  note would carry in passing. "solar", "panel" and "upgrade" were here and
 *  are not: a note reading "qty for the solar + battery electrical permit" or a
 *  label "(includes panel)" unbound the real box, and an unbound box replays
 *  the learn project's literal with no key and no warning. The PV rows those
 *  words were meant to catch already say kva / renewable / photovoltaic.
 *  "rating" is not here either — see MAIN_SERVICE_RATING. */
const OTHER_LINE = /temp|branch|circuit|notincluded|miscellaneous|manufactured|modular|mfd|reconnect|kva|renewable|photovoltaic|busbar/;

/** A main-service RATING question (a site fact with a recorded answer of "200",
 *  not a fee item). ANCHORED: a bare /rating/ substring also matches inside
 *  "operating", "generating", "integrating". So it is the word "rating" on the
 *  spaced form, or — for a flattened label with no spaces — "rating" directly
 *  after the words a rating question is about. */
const MAIN_SERVICE_RATING_SPACED = /\brating\b/;
const MAIN_SERVICE_RATING_SQUASHED = /(?:service|services|feeder|feeders|main|entrance|panel|amp|amps|amperage)rating/;

/** Another amperage tier printed in the same label means it is not THE <=200A
 *  row (a header listing every tier, or the 201-400 / 401-600 rows). Read on
 *  the SPACED form (see spaced()), where each number stands alone; digits are
 *  guarded on both sides so 1,200 or 2000 never read as 200. */
const OTHER_TIER = /(?<!\d)(?:201|400|401|599|600|601|1000|1001)(?!\d)/;

/** The <=200A bound, in the ways a schedule or portal prints it. Read on the
 *  SQUASHED form: "1,200 amps or less" squashes to "1200ampsorless", which the
 *  (?<!\d) guard correctly refuses (spaced, it would read "1 200 amps"). */
const LE_200A = [
  /(?<!\d)200(?:amps?|a)(?:orless|andless|orunder|andunder|orbelow|andbelow|max|maximum)/,
  /(?:upto|notover|notexceeding|lessthanorequalto|<=|≤)200(?:amps?|a)/,
];

/** IS THIS LABEL THE "SERVICES OR FEEDERS: 200 AMPS OR LESS" LINE?
 *
 *  Requires BOTH "service" and "feeder": every jurisdiction's line says both,
 *  and a label with only "service" is far more often a main-service rating
 *  question (a site fact with a recorded value of "200") than a fee item. The
 *  price of that strictness is a portal that prints "Service 200 amps or less"
 *  alone would not be recognised — a missed binding replays the recorded
 *  literal visibly, where a false one types a quantity into the wrong row. */
export function isServiceFeeder200Label(label: string | null | undefined): boolean {
  const raw = str(label);
  const s = squash(raw);
  if (!s) return false;
  if (!/servic/.test(s) || !/feeder/.test(s)) return false;
  if (OTHER_LINE.test(s)) return false;
  const w = spaced(raw);
  if (MAIN_SERVICE_RATING_SPACED.test(w) || MAIN_SERVICE_RATING_SQUASHED.test(s)) return false;
  if (OTHER_TIER.test(w)) return false;
  return LE_200A.some((re) => re.test(s));
}

/** The quantity a services/feeders <=200A box is answered with, for a filing
 *  known to carry electrical fee items: "1" for a battery job, "0" for a job
 *  the parser says has none, "" when nobody knows. "" is a DEFINED-but-empty
 *  value on purpose: the replay adapter types a defined empty key as blank,
 *  whereas an undefined key would replay the LEARN project's recorded literal —
 *  exactly the frozen answer this exists to stop. */
export function serviceFeeder200Quantity(snapshot: Record<string, unknown> | null | undefined): string {
  const status = batteryStatus(snapshot);
  return status === "yes" ? "1" : status === "no" ? "0" : "";
}
