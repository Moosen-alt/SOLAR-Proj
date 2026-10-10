// IS THIS CONTROL THE STORAGE QUESTION, OR IS IT THE STORAGE SPECS? — ONE PREDICATE.
//
// Two live incidents, mirror images of each other:
//
//   PacifiCorp (Ivy): the project carried hasBattery "No", the planner ticked "This system
//   includes battery storage" anyway, and the fields that tick revealed were answered with a
//   Powerwall's textbook numbers — 13.5 kWh, 11.5 kW, 89% round-trip — on their way to a
//   utility as fact. So the learner grew a guard: on a no-battery job, never fill a battery
//   field.
//
//   PGE (2026-09-28, two supervised learns, hasBattery "No"): the planner decided the REQUIRED
//   select "Energy Storage" → "No" — the right answer — and that guard refused it as a battery
//   SPEC (battery_spec_refused ×4 per run), so page 7 ended with required_never_filled
//   ["Energy Storage"]. The yes/no question stayed blank, a required miss at review, and the
//   recipe could never be trusted. A guard against inventing a battery had become a guard
//   against saying there is none.
//
// The guard's regex knew the storage WORDS but not what the control ASKS. That is the whole
// distinction, and it is asked here, once, by every door — the learner's fill pass and its
// required-field sweep, the learner's declaration pass, and replay's skip / answer logic:
//
//   SPEC         asks for a value OF the battery: manufacturer/make, model, capacity (kWh/kW),
//                quantity, part number, certification, its inverter, its efficiency… On a job
//                with no battery these are REFUSED (never invented); on a battery job they are
//                filled from the project's battery fields. A battery's document upload is a spec.
//   DECLARATION  asks WHETHER storage is present: a bare "Energy Storage" / "Battery storage?",
//                "Will energy storage be installed?", "Does the system include a battery?", a
//                Yes/No (or Yes/No/None) select, a checkbox declaring storage. Answered from the
//                project: No on a no-battery job (never refused — not having one is the answer),
//                Yes on a battery job.
//   PROGRAM      a utility programme question that merely names batteries ("Will you be
//                participating in the Wattsmart Battery Program?") — required of every applicant,
//                battery or not; never refused, never forced (PacifiCorp rejected a filing by name
//                when it was left blank).
//   MENTION      the words appear but the control is none of the above (an acknowledgment box
//                citing "the Battery System Interim Technical Requirements", a notes box) — the
//                planner's value stands.
//
// Pure: no imports, so backend, portal-bot and every test import the same function.

/** What kind of control carries the label — the learner's ExtractedField.fieldType, or a recorded
 *  step's action mapped by batteryControlOfStep. Anything else reads as "other". */
export type BatteryControl = "select" | "radio" | "checkbox" | "text" | "file" | "other";

export type BatteryControlKind = "spec" | "declaration" | "program" | "mention";

/** The words that make a label ABOUT storage at all. Bare "storage" counts: "Storage capacity
 *  (kWh)" is a battery spec on every interconnection portal that asks it. */
const STORAGE_WORDS = /\bbatter(?:y|ies)\b|\benergy\s*storage\b|\bess\b|\bstorage\b|\bpowerwall\b|round-?trip|state\s+of\s+charge/i;

/** A label that asks for a VALUE of the battery. Ordered before the declaration shapes on
 *  purpose: "Energy Storage Capacity of Battery (kWh)" starts like a declaration and is a spec. */
const SPEC_WORDS = /\bmanufacturer\b|\bmake\b(?!\s+use)|\bmodel\b|\bcapacity\b|\bkwh\b|\bkw\b|\bkva\b|\bah\b|\bquantity\b|\bqty\b|\bnumber\s+of\b|\bhow\s+many\b|\bpart\s*(?:number|no\.?|#)|\bcertif|\bul\s*\d{3,4}\b|\binverter\b|\bvoltage\b|\bvolts?\b|\bamps?\b|\bamperage\b|\befficiency\b|round-?trip|state\s+of\s+charge|\brating\b|\brated\b|\bsize\b|\bserial\b|\bnameplate\b|\bpower\s+draw\b|\bdischarge\b|\bcharg(?:e|ing)\s+(?:rate|cycle|power)\b|\bspec(?:ification)?s?\b|\bdata\s*sheet\b|\bdatasheet\b|\bchemistry\b|\bcost\b|\bprice\b/i;

/** An ACKNOWLEDGMENT that names the battery is never the question of whether there is one:
 *  "I have read the Battery System Interim Technical Requirements", "I agree to comply with the
 *  battery storage guidelines". Refusing such a box on every no-battery job would leave a
 *  required acknowledgment unticked. */
const ACKNOWLEDGMENT = /\b(?:read|agree|comply|acknowledge|understand|accept|certify|attest|confirm)\b|\b(?:requirements?|terms|conditions|policy|policies|guidelines?|standards?|instructions?|resources?)\b/i;

/** The shapes that ask WHETHER storage is present. */
const DECLARING_SHAPES: RegExp[] = [
  // "This system includes battery storage", "System with battery storage", "This project has a
  // battery", "Adding energy storage", "Energy storage will be installed". The verb reaches the
  // storage noun through at most an article and one word ("has an integrated battery"), never a
  // clause ("have read the Battery…" is an acknowledgment).
  /\b(?:includes?|including|has|have|with|add(?:s|ing)?|install(?:s|ed|ing)?|propos(?:es|ed|ing)?|plan(?:s|ned|ning)?|present)\s+(?:(?:an?|the|any|this|new)\s+)?(?:[\w-]+\s+)?(?:batter(?:y|ies)|energy\s*storage|storage\s*system|ess|storage)\b/i,
  // Bare "Energy Storage", "Battery Storage", "Battery storage included?", "Energy Storage
  // Installed?", "Energy Storage System Information" — the noun and at most a qualifier, never a
  // longer label ("Energy storage notes" is a notes box).
  /^\s*(?:energy|battery)\s*storage(?:\s+system)?(?:\s+(?:installed|included|present|proposed|planned|information|info|details?))?\s*[?*:]*\s*$/i,
  // Bare "Battery?", "Batteries", "ESS"
  /^\s*(?:batter(?:y|ies)|ess)\s*(?:\?|\*|:)?\s*$/i,
  // "Battery installed?", "Storage included", "Energy storage present"
  /\b(?:batter(?:y|ies)|energy\s*storage|storage)\s*(?:installed|included|present|proposed|planned)\b/i,
];

/** The storage noun as a question's OBJECT OF EXISTENCE. */
const NOUN = String.raw`(?:batter(?:y|ies)|energy\s*storage(?:\s+system)?|storage\s*system|ess|storage)`;
/** A question that asks whether storage EXISTS on this job — "Is there a battery?", "Will energy
 *  storage be installed?", "Does the system include a battery?", "Do you plan to add storage?",
 *  "Are you installing a battery?" — and never a question about a PROPERTY of the battery ("Is the
 *  battery AC-coupled?", "Is the battery located indoors?"), which the planner answers on a battery
 *  job and which a no-battery job is never asked. */
export const BATTERY_PRESENCE_QUESTION = new RegExp(String.raw`^\s*(?:` + [
  String.raw`(?:is|are|will)\s+there\s+(?:be\s+)?(?:(?:an?|any)\s+)?${NOUN}`,
  String.raw`will\s+(?:(?:an?|any|the)\s+)?${NOUN}\s+be\s+(?:installed|included|added|present|part|proposed)`,
  String.raw`does\s+(?:the|this|your)\s+[\w-]+\s+(?:include|have|contain|use|make\s+use\s+of|propose|add)\s+(?:(?:an?|any)\s+)?${NOUN}`,
  String.raw`do\s+you\s+(?:have|plan|propose|intend|want|wish)\b[^.?]{0,30}\b${NOUN}`,
  String.raw`is\s+(?:(?:an?|any)\s+)?${NOUN}\s+(?:installed|included|proposed|planned|present|part\s+of|being|to\s+be)`,
  String.raw`are\s+you\s+(?:installing|adding|including|proposing|planning)\s+(?:(?:an?|any)\s+)?${NOUN}`,
].join("|") + String.raw`)\b`, "i");
DECLARING_SHAPES.push(BATTERY_PRESENCE_QUESTION);

/** Bare "storage" that is plainly not a battery: a permit portal's "storage shed", a "storage
 *  tank", "storage of materials". Only the bare word is ambiguous — "battery"/"energy storage"/
 *  "ESS" always mean the battery. */
const STORAGE_BUT_NOT_A_BATTERY = /\bstorage\s+(?:shed|unit|building|structure|container|tank|area|room|space|facility|of\s+materials|yard)\b|\b(?:self|cold|dry|food|water|fuel|material)\s*storage\b/i;
const UNAMBIGUOUS_BATTERY = /\bbatter(?:y|ies)\b|\benergy\s*storage\b|\bess\b|\bpowerwall\b|round-?trip|state\s+of\s+charge/i;

/** A dropdown's placeholder is not an answer. */
const PLACEHOLDER_OPTION = /^(?:[-–—\s]*(?:please\s+)?(?:select|choose|pick)\b.*|[-–—\s]*|none selected)$/i;

/** "No", "None", "N/A", "false", "No storage" — the answer that says there is no battery. */
export function readsAsNoAnswer(v: unknown): boolean {
  return /^\s*(?:no|none|n|false|0|off|n\/?a|not\s+applicable)\b/i.test(String(v ?? ""));
}
/** "Yes", "true", "Yes - battery storage" — the answer that says there is one. */
export function readsAsYesAnswer(v: unknown): boolean {
  return /^\s*(?:yes|y|true|1|on)\b/i.test(String(v ?? ""));
}

const cleanOptions = (options: ReadonlyArray<unknown> | null | undefined): string[] =>
  (options ?? []).map((o) => String(o ?? "").trim()).filter((o) => o && !PLACEHOLDER_OPTION.test(o));

/** The learner's fieldType / a mapped action, normalised. */
function controlOf(raw: unknown): BatteryControl {
  const c = String(raw ?? "").toLowerCase();
  if (c === "select" || c === "radio" || c === "checkbox" || c === "text" || c === "file") return c;
  return "other";
}

/** A recorded step's control, for the same question on the replay side. */
export function batteryControlOfStep(step: { action?: string | null }): BatteryControl {
  switch (String(step.action ?? "")) {
    case "select": return "select";
    case "fill": return "text";
    case "check": case "uncheck": return "checkbox";
    case "upload": return "file";
    default: return "other";
  }
}

/**
 * THE ONE PREDICATE. null when the label is not about storage at all (an inverter's
 * manufacturer, a PV system size — the guard must never touch an ordinary job's fields).
 */
export function batteryControlKind(
  label: unknown,
  control: { control?: unknown; options?: ReadonlyArray<unknown> | null } = {},
): BatteryControlKind | null {
  const text = String(label ?? "").replace(/\s+/g, " ").trim();
  if (!text || !STORAGE_WORDS.test(text)) return null;
  if (STORAGE_BUT_NOT_A_BATTERY.test(text) && !UNAMBIGUOUS_BATTERY.test(text)) return null;
  const kind = controlOf(control.control);
  // A programme question names the battery but asks about enrolment.
  if (/\bprogram(?:me)?\b/i.test(text)) return "program";
  // A battery's document is a fact about the battery, never the yes/no question.
  if (kind === "file") return "spec";
  if (SPEC_WORDS.test(text)) return "spec";
  if (ACKNOWLEDGMENT.test(text)) return "mention";
  const declaringShape = DECLARING_SHAPES.some((re) => re.test(text));
  if (declaringShape) return "declaration";
  // A choice control whose options are the yes/no vocabulary asks the question whatever its
  // label's grammar ("Energy Storage" with [Select…, Yes, No]; "Storage" with [None, Yes]).
  if (kind === "select" || kind === "radio" || kind === "other") {
    const opts = cleanOptions(control.options);
    if (opts.length && opts.some((o) => readsAsYesAnswer(o) || readsAsNoAnswer(o))) return "declaration";
  }
  return "mention";
}

/**
 * The answer a declaration takes for THIS project, in the control's own vocabulary.
 *   - no battery: the recorded/planned answer when it already reads as No (keeps a portal's
 *     "None"), else the option that reads as No, else the literal "No";
 *   - battery:    the recorded/planned answer when it already reads as Yes, else — when it reads
 *     as No or is blank — the option that reads as Yes, else the literal "Yes". null means "leave
 *     it": the option list is known and offers no Yes (a "None / Lithium / Lead-acid" picker is
 *     not a yes/no question on that side), or the current answer is neither Yes nor No (a product
 *     name typed into a free-text "Energy Storage" box already says there is one).
 */
export function batteryDeclarationAnswer(
  hasBattery: boolean,
  options?: ReadonlyArray<unknown> | null,
  current?: unknown,
): string | null {
  const cur = String(current ?? "").trim();
  const opts = cleanOptions(options);
  if (!hasBattery) {
    if (cur && readsAsNoAnswer(cur)) return cur;
    return opts.find((o) => readsAsNoAnswer(o)) ?? "No";
  }
  if (cur && readsAsYesAnswer(cur)) return cur;
  if (cur && !readsAsNoAnswer(cur)) return null;
  const yes = opts.find((o) => readsAsYesAnswer(o));
  if (yes) return yes;
  return opts.length ? null : "Yes";
}

// ── DOES THIS PROJECT HAVE A BATTERY? (moved here from backend batteryServiceFeeder, #246) ──
// The backend re-exports these; the portal-bot adapters import them directly, so a PDF sentence, a
// fee line and a portal declaration all ask one question.
export type BatteryStatus = "yes" | "no" | "unknown";

/** A battery MODEL field that says there is NO battery ("N/A", "N.A.", "(none)", "None proposed",
 *  "No ESS", "Not in scope", "-", "Future", "Battery ready", "Pre-wire"): not battery evidence, wherever a battery is asked about —
 *  normalize.ts (where hasBattery is DERIVED), batteryStatus below, and every reader of it (#246). Normalized first (case, dots, parentheses,
 *  spacing, " / "), so the spellings an operator actually types all read the same. "TBD" is NOT a
 *  placeholder (operator ruling on #256): a battery whose model is undecided is still a battery, and
 *  declaring "no storage" to the utility for it would be false. */
export function isPlaceholderBatteryModel(value: unknown): boolean {
  const v = String(value ?? "").toLowerCase().replace(/[().]/g, "").replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ").trim();
  // NEGATION-LED, not a closed list (Helm on #256): "No battery storage", "None at this time", "Not
  // installed" each read as a battery when only listed spellings counted, and a real model beats an
  // explicit "No" — so an unlisted negation became a false storage declaration to the utility. A
  // future / battery-ready / pre-wire / provision note is a statement that there is no battery TODAY.
  // Both are anchored at the START: "Powerwall 3 w/ provision for future expansion" is a battery, and
  // a hyphenated name ("No-Break X", "NA-10", "Na-ion 10kWh") is a model, not a negation. An UNDECIDED
  // model ("Not yet selected", "None selected yet", "No model selected") is TBD-class (operator ruling
  // on #256): a battery that owes its spec sheet, never a "no storage" declaration.
  if (/^(?:n\/?a|no|none|not|nil|null)[\s,;:]+(?:yet|selected|specified|decided|determined|chosen|known|model)\b/.test(v)) return false;
  return /^(?:n\/?a|no|none|not|nil|null)(?=$|[\s,;:])|^(?:0|[-\u2013\u2014]+)$|^(?:future|battery[- ]?ready|pre-?wired?|provision(?:ed)? for)\b/.test(v);
}

function batteryStr(value: unknown): string {
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
  const flag = batteryStr(s.hasBattery);
  const qty = Number(batteryStr(s.batteryQuantity) || batteryStr(s.batteryQty) || 0);
  // A placeholder model ("N/A", "None") is not battery evidence — the ONE predicate normalize.ts
  // derives hasBattery with, so the fee line and the portal's declaration agree with the flag (#246).
  const model = batteryStr(s.batteryModel);
  if (/^(yes|true|y)$/i.test(flag) || (model !== "" && !isPlaceholderBatteryModel(model)) || (Number.isFinite(qty) && qty > 0)) return "yes";
  if (/^(no|false|none|n)$/i.test(flag)) return "no";
  return "unknown";
}

/** The tri-state the project's hasBattery carries: false = the project SAYS there is no battery
 *  (the guard arms), true = it says there is one, undefined = silence, which stays the planner's
 *  call — the backend, the learner and replay must all read it the same way. */
export function parseHasBattery(raw: unknown): boolean | undefined {
  const v = String(raw ?? "").trim();
  if (/^(?:no|false|none|n)$/i.test(v)) return false;
  if (/^(?:yes|true|y)$/i.test(v)) return true;
  return undefined;
}

/** The question the learner's declaration pass looks for in a select's OWN label on the live
 *  page: the bare storage question ("Energy Storage", "Battery storage?") or a presence question —
 *  never a spec, a programme question or an acknowledgment. Matched against the control's own
 *  label only, never its section text: a fieldset titled "Energy Storage" holds the specs too. */
export const BATTERY_DECLARATION_QUESTION = new RegExp(
  String.raw`^(?![^?]*\b(?:program(?:me)?|manufacturer|make|model|capacity|kwh|kw|quantity|qty|inverter|certif|rating|size|serial|type|requirements?|read|agree|comply)\b)`
  + String.raw`\s*(?:(?:energy|battery)\s*storage(?:\s+system)?(?:\s+(?:installed|included|present|proposed|planned))?\s*[?*:]*\s*$|`
  + BATTERY_PRESENCE_QUESTION.source.replace(/^\^\\s\*/, "") + String.raw`)`,
  "i",
);
