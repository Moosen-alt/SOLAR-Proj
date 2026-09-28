// ---------------------------------------------------------------------------
// IS THIS PRINTED / RECORDED LABEL A SERVICES-OR-FEEDERS FEE LINE, AND WHICH TIER?
//
// The ONE label grammar for the services/feeders fee rows, asked by the backend (the portal
// fee-item key a recorded box binds to — feeBracketFields; the fee evaluator — feeSchedules;
// the electrical PDF — ahjForms, all through batteryServiceFeeder, which re-exports these) AND by
// the replay adapter (portal-bot recipeAdapter: a service box the recipe never recorded is read
// off the live page and typed with this project's count). One grammar in a shared leaf, because
// two regexes answering one question is how this codebase has been bitten before.
//
// Live City of Corvallis electrical record, 2026-09-28: "Service 0-200 amps (qty)" stayed 0 on a
// job upgrading its service — the grammar demanded "feeder" in the label.
// ---------------------------------------------------------------------------

/** The flat-map key a recorded portal box binds to. NOT under the "feeBracketQuantity:" prefix:
 *  that family is the kVA brackets, and the portal-bot coverage check reads every key under it as
 *  a kVA row, which a services box is not. */
export const SERVICE_FEEDER_200A_FIELD = "feeLineQuantity:servicesFeeders200A";
/** The 201-400 A service tier's box — its own key, never the <=200A one. */
export const SERVICE_FEEDER_400A_FIELD = "feeLineQuantity:servicesFeeders201to400A";

function str(value: unknown): string {
  return value == null ? "" : String(value).trim();
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
 *  (?<!\d) guard correctly refuses (spaced, it would read "1 200 amps").
 *  "0-200 amps" (Accela's City of Corvallis electrical record: "Service 0-200 amps
 *  (qty)") squashes to "0200amps"; the guard refuses "10-200" / "100-200". */
const LE_200A = [
  /(?<!\d)200(?:amps?|a)(?:orless|andless|orunder|andunder|orbelow|andbelow|max|maximum)/,
  /(?:upto|notover|notexceeding|lessthanorequalto|<=|≤)200(?:amps?|a)/,
  /(?<!\d)0(?:to|thru|through)?200(?:amps?|a)/,
];

/** The 201-400 A tier, read on the SQUASHED form like LE_200A (Accela flattens
 *  "Service201-400amps(qty)"): "201-400 amps", "201 amps to 400 amps", "201 to 400 amps",
 *  "201-400A". The guard refuses "1201-400". */
const TIER_201_400 = /(?<!\d)201(?:amps?|a)?(?:to|thru|through)?400(?:amps?|a)/;
/** Any OTHER tier than 201-400 in the same label: the <=200A row's bound (read on the
 *  squashed form by LE_200A) or a higher tier. */
const OTHER_TIER_400 = /(?<!\d)(?:401|599|600|601|1000|1001)(?!\d)/;

/** A QUANTITY question, in the words a fee-item box is labelled with: "(qty)",
 *  "Quantity", "Number of", "#". Read on the squashed form (Accela flattens labels:
 *  "Service0-200amps(qty)" → "service0200ampsqty") plus the raw "#". */
function isQuantityLabel(raw: string, s: string): boolean {
  return /qty|quantity|numberof/.test(s) || /#/.test(raw);
}

/** The prefilter both service tiers share: a services line (and never another line of
 *  the same schedule, nor a main-service RATING question).
 *
 *  "SERVICE" ALONE COUNTS ONLY AS A QUANTITY. Every Oregon-schedule line says "services
 *  or feeders", and a label with only "service" is far more often a main-service rating
 *  question (a site fact with a recorded value of "200") than a fee item. But an Accela
 *  record can print the tier as "Service 0-200 amps (qty)" (City of Corvallis, live
 *  2026-09-28: the box stayed 0 on a job whose plan set upgrades the service) — a label
 *  that asks for a COUNT is a fee item, whatever it omits. So: "feeder" in the label, or
 *  a quantity marker, or a fee-list row that LEADS with the plural "Services" (Oregon
 *  ePermitting's Marion County services page: "Services 200 amps or less", "Services 201 to
 *  400 amps" — a site fact is never phrased as a plural list row); a rating question, and a
 *  service SIZE / EXISTING / MAIN / PANEL wording, is refused either way. */
function isServiceLineLabel(raw: string, s: string): boolean {
  if (!s || !/servic/.test(s)) return false;
  const w0 = spaced(raw);
  const feeRow = /feeder/.test(s) || isQuantityLabel(raw, s)
    || (/^services\b/.test(w0) && !/\b(?:size|existing|main|panel|amperage|entrance)\b/.test(w0));
  if (!feeRow) return false;
  if (OTHER_LINE.test(s)) return false;
  const w = spaced(raw);
  if (MAIN_SERVICE_RATING_SPACED.test(w) || MAIN_SERVICE_RATING_SQUASHED.test(s)) return false;
  return true;
}

/** IS THIS LABEL THE "SERVICES OR FEEDERS: 200 AMPS OR LESS" LINE?
 *
 *  "Services or feeders … 200 amps or less" in any spelling, or a SERVICE amps tier
 *  asked as a quantity ("Service 0-200 amps (qty)"). Refused: temporary service,
 *  reconnect only, manufactured dwelling, branch circuits, the PV kVA rows, a heading
 *  listing several tiers, and a main-service RATING question — a missed binding
 *  replays the recorded literal visibly, where a false one types a quantity into the
 *  wrong row. */
export function isServiceFeeder200Label(label: string | null | undefined): boolean {
  const raw = str(label);
  const s = squash(raw);
  if (!isServiceLineLabel(raw, s)) return false;
  if (OTHER_TIER.test(spaced(raw))) return false;
  return LE_200A.some((re) => re.test(s));
}

/** IS THIS LABEL THE SERVICES/FEEDERS 201-400 A LINE? ("Service 201-400 amps (qty)",
 *  "Services or feeders: 201 amps to 400 amps"). Its own key — never the <=200A box,
 *  and never a heading that also lists the <=200A or a higher tier. */
export function isServiceFeeder400Label(label: string | null | undefined): boolean {
  const raw = str(label);
  const s = squash(raw);
  if (!isServiceLineLabel(raw, s)) return false;
  if (!TIER_201_400.test(s)) return false;
  if (OTHER_TIER_400.test(spaced(raw))) return false;
  if (LE_200A.some((re) => re.test(s))) return false;
  return true;
}
