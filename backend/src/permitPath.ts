// ---------------------------------------------------------------------------
// Permit path resolver — prescriptive vs engineered (non-prescriptive).
//
// This is the single most consequential routing decision on an Oregon (and most
// western-state) residential rooftop solar permit. The AHJ publishes TWO solar
// applications and you upload exactly ONE:
//
//   - PRESCRIPTIVE application  → the project meets the prescriptive code, NO plan
//     review, REDUCED permit fee. Upload only when the structural screen passes.
//   - STRUCTURAL (engineered) application → the project does NOT meet prescriptive
//     code, WILL require plan review, FULL structural fees, and a PE-stamped plan
//     set + structural engineering letter/calcs must be attached.
//
//   "Please upload only the application that pertains to your project — DO NOT
//    upload both." (City of Keizer / Marion County guidance.)
//
// We deduce the path from the parsed structural data + stamp recommendation, let
// the operator override it from the UI, and feed the result into doc generation
// (which application to build) and the reviewer (what engineered docs to collect).
// ---------------------------------------------------------------------------

import type { PrescriptiveLimits, ProjectRecord } from "../../shared/src/types";
import { classifyRoofCovering, oregonRoofingRowQualifies } from "./roofCovering";

export type PermitPath = "prescriptive" | "engineered" | "unknown";

export interface PermitPathResolution {
  path: PermitPath;
  /** Where the decision came from — an explicit operator choice always wins. */
  source: "operator" | "parser" | "structural-screen" | "default";
  /** STANDARD STRUCTURAL REVIEW: OUTSIDE Oregon, where the jurisdiction has no prescriptive
   *  rooftop-PV path on file (researched false, or never researched). There is no
   *  prescriptive-vs-engineered CHOICE to confirm there — the one application is the standard
   *  structural (building) review — so the path is "engineered" for routing (which application,
   *  which fee rows) but it does NOT by itself demand a PE stamp: the jurisdiction's own stamp
   *  rule decides that (resolveStampRequirement steps 2-3). A flag beside `source` (which stays
   *  "structural-screen") because the source union is mirrored in shared/src/types.ts. */
  standardReview: boolean;
  /** Human-readable reasons, surfaced in the docs + reviewer so the call is auditable. */
  basis: string[];
  /** True when the path is engineered → stamped plans + structural letter are required. */
  needsEngineeredDocs: boolean;
  /** The documents an engineered submittal must include (client/engineer-provided). */
  requiredEngineeredDocs: string[];
}

/** EVERYTHING resolvePermitPath reads is the parser snapshot — see `snap`/`num`
 *  below, which are its only accessors. Stated as a type rather than left
 *  implicit because callers already rely on it: ahjForms.permitPathForProject
 *  casts a bare `{ parserSnapshot }` through `as ProjectRecord` to call this, and
 *  feeSchedules.ts asks the same question from a Pick that carries no more than
 *  this. Widening the parameter is safe for every existing caller (a full
 *  ProjectRecord still satisfies it) and removes the need for the next one to
 *  lie to the compiler. */
/** STATE IS REQUIRED, NOT OPTIONAL. The screen below is Oregon's, and for most of this
 *  project's life every project was in Oregon, so the resolver never needed to ask. An
 *  audit of multi-state readiness (2026-09-22) found the consequence: a Columbus, Ohio
 *  roof measured against Oregon's ORSC limits came back "prescriptive — meets
 *  prescriptive code, no plan review, reduced fee", and nothing in the chain had ever
 *  consulted Ohio. The fix has to be a WIDER INPUT rather than a conditional, because
 *  state was not reachable from inside this function at all.
 *
 *  Required, never an optional trailing field: CLAUDE.md's rule for the org filter
 *  applies with the same force here — an optional state fails open the moment a caller
 *  forgets it, and failing open here means Oregon's rules quietly judging Florida. */
export type PermitPathInputs = Pick<ProjectRecord, "parserSnapshot" | "state"> & Partial<Pick<ProjectRecord, "ahj">>;

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

// THE STATE IS AN ALLOWLIST, NOT "ANYTHING THAT IS NOT OR" (2026-09-24, D1 verification MF2).
//
// Intake stores the state as typed (createProject has no normaliser), and the standard-review
// rule below routes every non-Oregon state past Oregon's prescriptive-vs-engineered confirmation.
// Its first normaliser only knew "OREGON" and "ORE", so a Portland project stored as "Oreg.",
// "OR 97201", "Portland, OR", "97201", "OR, USA", "O.R." or "Oregon State" was NOT "OR", routed to
// the standard review, and skipped the confirmation with no gate blocker at all — the fail-open
// the previous "unknown" fallback had prevented. Now a state routes only when it normalises to a
// recognised two-letter US code: full names and the common abbreviations map to their code;
// anything else resolves UNKNOWN with the "add the project's state" basis, which the gate blocks
// on. Inlined (designCriteria.US_STATES is the same list) because this module must not import
// the design-criteria engine for a two-line lookup.
const US_STATE_CODES = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "));
const US_STATE_NAMES: Record<string, string> = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA", COLORADO: "CO", CONNECTICUT: "CT",
  DELAWARE: "DE", FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA",
  KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD", MASSACHUSETTS: "MA", MICHIGAN: "MI",
  MINNESOTA: "MN", MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV", "NEW HAMPSHIRE": "NH",
  "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH",
  OKLAHOMA: "OK", OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD",
  TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT", VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV",
  WISCONSIN: "WI", WYOMING: "WY", "DISTRICT OF COLUMBIA": "DC",
  // Common abbreviations (AP style and the ones operators type).
  ORE: "OR", OREG: "OR", CALIF: "CA", CAL: "CA", TEX: "TX", FLA: "FL", WASH: "WA", ARIZ: "AZ", COLO: "CO", ILL: "IL",
  MASS: "MA", MICH: "MI", MINN: "MN", MISS: "MS", NEB: "NE", NEV: "NV", OKLA: "OK", PENN: "PA", PENNA: "PA", TENN: "TN",
  WIS: "WI", WISC: "WI", WYO: "WY", KANS: "KS", CONN: "CT", DEL: "DE", IND: "IN",
};

/** The two-letter US state code a stored state spelling means, or "" when it is not one we
 *  recognise. "Oregon", "Ore.", "oreg", " or " → "OR"; "OR 97201", "Portland, OR", "97201",
 *  "OR, USA", "O.R.", "OR-Oregon", "Oregon State" → "" (never guessed: the gate asks). */
export function usStateCode(value: unknown): string {
  const raw = clean(value).toUpperCase().replace(/\.+$/, "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (US_STATE_CODES.has(raw)) return raw;
  return US_STATE_NAMES[raw] ?? "";
}

function snap(project: PermitPathInputs, key: string): string {
  return clean((project.parserSnapshot || {})[key]);
}

function num(project: PermitPathInputs, key: string): number | null {
  const raw = snap(project, key).replace(/[^0-9.\-]/g, "");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Documents an engineered (non-prescriptive) submittal must carry. These are
 * provided by the installer / engineer (the autopilot does not produce a wet
 * stamp) — the reviewer collects them and flags any that aren't already uploaded.
 */
export const ENGINEERED_REQUIRED_DOCS = [
  "PE-stamped structural plan set (wet/digital stamp on the structural sheets)",
  "Structural engineering letter or stamped calculations (PE-sealed)",
];

// ---------------------------------------------------------------------------
// IS A SEALED STRUCTURAL DOCUMENT ACTUALLY IN HAND?
//
// Twice now, a sentence stating that a sealed document is ABSENT has been counted
// as proof that it is PRESENT:
//
//   Coos Bay 187-26-000309-STR (Ann Marineau, 1780 Ocean Blvd) — filed, then sent
//   to plan review for stamps. The parser had already written:
//     "No PE stamp/seal shown (title block 'Signature with Seal' is blank); AHJ
//      may require stamped structural for 2x4 @16" rafters"
//   The old rule matched "stamped" and its negative guard wanted "no stamp"
//   ADJACENT. "PE" sat between them. Fixed in 8c6f6a8 by a DENIES_A_SEAL list.
//
//   Portland 26-033226-000-00-RS (Bren Trask, 11739 SE Reedway) — same defect,
//   different words, straight through that list:
//     "Vector Structural Engineering review block with signature/seal area shown
//      (VSE Project U4703-1659-261) referencing a separate structural letter; the
//      letter itself was not supplied — submit the sealed letter with the permit"
//   DENIES_A_SEAL enumerated "not stamped / not sealed / not signed" and had no
//   pattern for "not supplied". So the packet printed the all-clear on a letter
//   its own parse says nobody ever sent.
//
// A LIST OF WAYS TO SAY "ABSENT" CANNOT BE FINISHED. "not supplied", "not
// provided", "was never included", "we do not have it", "still outstanding" — the
// PREDICATE side of English is open-class and a keyword list will keep losing to
// it. NEGATION ITSELF is closed-class: roughly twenty words carry it, and they are
// listed below in full. So this reads the negators, not the predicates, and binds
// each one to its own CLAUSE — which is the other half of the 8c6f6a8 bug, where
// "no" and "stamp" had to sit within 24 characters of each other to count.
//
// FIVE RULES, all of them defaulting to NOT SATISFIED:
//   1. Clause scope. Split on sentence AND clause punctuation, so a negator is
//      weighed against the artifact in its own clause and nothing else.
//   2. A denial anywhere outranks every affirmative everywhere. A sentence that
//      denies a seal almost always ALSO contains "stamped", because it goes on to
//      say a stamped structural may be required; any rule that weighs the two
//      loses to its own subject matter. This is also the honest answer when text
//      both mentions a seal and disclaims it.
//   3. Hedged, conditional or imperative language is not evidence. "submit the
//      sealed letter with the permit" is an instruction about the future.
//   4. Naming the BOX is not naming the MARK. "signature/seal area shown" says a
//      title-block region exists, which every title block has.
//   5. A MENTION IS NOT AN ASSERTION. The clause must actually say the document is
//      in hand. "referencing a separate structural letter" names one without
//      claiming anyone has it, and so did not survive Portland.
//
// THE SAFETY PROPERTY, and the reason the two lists below are built differently:
// negators are closed-class, so NEGATOR can be exhaustive; presence predicates are
// open-class, so ASSERTS_PRESENCE cannot be. That is fine HERE and only here,
// because a gap in EITHER list now lands on "not satisfied" — an unrecognised
// denial no longer counts as proof, and an unrecognised affirmation blocks. The
// old code had this exactly inverted: a gap in its negative list produced
// "satisfied", which is how two permits went out the door.
//
// REGEX LITERALS, not strings joined into a RegExp: "\b" inside a JS string
// literal is a BACKSPACE character, and this module shipped exactly that bug once.
// ---------------------------------------------------------------------------

/** Sentence and clause boundaries. Commas and colons count, because the parser's
 *  own specified phrasing for a genuine letter (llm.ts) is
 *  "PE-sealed structural letter provided: existing framing adequate, no upgrades
 *  required." — one blob-wide read of that sees "no" and refuses a real seal. */
const CLAUSE_BREAK = /[\n;:,()\[\]|"]|—|–|\.(?=\s|$)|\bbut\b|\bhowever\b|\balthough\b/i;

/** The ARTIFACTS whose presence or absence this question is about. Deliberately
 *  nouns for the document/mark only — never "engineer" or "PE" on their own,
 *  because plan-set boilerplate ("do not scale without written approval of the
 *  engineer") would then read as a denial on every project. */
const SEAL_ARTIFACT = /\b(?:wet[-\s]?stamps?|stamps?|stamped|stamping|seals?|sealed|sealing|signatures?|signed|unstamped|unsealed|unsigned)\b|\b(?:structural|engineering|sealed|stamped|pe|se)[\s-]*letters?\b|\bletter\b|\bengineer\s+of\s+record\b/i;

/** NEGATION IS A CLOSED CLASS — this is the whole list, and it does not grow with
 *  the verbs people choose. "not supplied", "not provided", "never included" and
 *  every future phrasing are all caught by "not"/"never" alone. */
const NEGATOR = /\b(?:no|not|non|never|none|neither|nor|without|lacks?|lacking|lacked|absent|absence|missing|blank|empty|omits?|omitted|omitting|unavailable|illegible|unreadable|pending|tbd|awaits?|awaiting)\b|n't\b|\bun(?:stamped|sealed|signed|executed|certified|available)\b/i;

/** Conditional / prospective / imperative — a statement about what SHOULD happen,
 *  not a report of what is in hand. Past participles are deliberately excluded:
 *  "provide" is a hedge, "provided" is a fact, and \b keeps them apart. */
const HEDGED = /\b(?:may|might|could|should|would|will|shall|if|whether|unless|prior|before|needs?|needed|requires?|required|recommend\w*|pending|tbd|assume\w*)\b|\b(?:submit|provide|supply|obtain|upload|attach|furnish|secure|request)\b/i;

/** The container, not its contents: "signature/seal area", "stamp block". */
const CONTAINER_ONLY = /\b(?:stamps?|seals?|signatures?)[\s\/-]*(?:\w+[\s\/-]*)?(?:areas?|blocks?|box(?:es)?|fields?|spaces?|placeholders?)\b/i;

/** The clause has to CLAIM the document is in hand, not merely name it. Open-class
 *  and therefore incomplete on purpose — every phrasing this misses blocks. */
const ASSERTS_PRESENCE = /\b(?:present|presents|provided|supplied|included|attached|affixed|applied|shown|executed|received|furnished|issued|bears?|carries|carrying|contains?|includes?)\b|\bon\s+file\b|\bin\s+hand\b|\b(?:sealed|stamped|signed)\s+by\b|\b(?:is|are|was|were)\s+(?:\w+\s+){0,3}?(?:stamped|sealed|signed)\b/i;

/** "No. 12345" / "No 4" is the abbreviation for NUMBER — a licence number sits
 *  next to a real seal ("Sealed by Jane Roe, PE, Oregon No. 12345"), so reading it
 *  as a negator would refuse the genuine article. */
function withoutNumberAbbreviation(clause: string): string {
  return clause.replace(/\bno\.?\s*(?=[#\d])/gi, " number ");
}

/**
 * Does the parsed evidence show a stamped structural plan / engineering letter is
 * already in hand?
 *
 * TWO TIERS, and the asymmetry runs in the SAFE direction:
 *
 *   ASSESSED text — the parser's own findings about the documents — may assert
 *   that a seal is present, and may deny it.
 *
 *   RAW EXTRACTED text — the literal characters pulled out of the uploaded plan
 *   set — may only DENY. It cannot assert, because an empty title block prints
 *   the words "SIGNATURE WITH SEAL" exactly like a signed one does. Measured on
 *   the live database: reading raw plan text in the positive direction flipped
 *   two projects (15622 SE Vivian Way, 990 17th St NE) to "stamped" on that
 *   boilerplate alone, with no seal anywhere in either set. An extracted string is
 *   not an assessment, and a label is not a signature.
 *
 * A project whose sealed letter is a real FILE does not come through here at all —
 * requiredDocuments satisfies it from stamped_plans / engineering_letter /
 * structural_letter uploads before it ever asks this question.
 */
export function hasStampedStructuralEvidence(project: PermitPathInputs): boolean {
  // structuralCalcText is the key the parser actually emits (the narrative
  // structural blob), and llm.ts asks it for "whether stamped engineering is
  // present". The legacy keys beside it are read for years but written NOWHERE in
  // the codebase — kept only so an older snapshot carrying them still resolves.
  const assessed = ["stampRecommendation", "structuralCalcText", "reviewFlags",
    "structuralText", "structuralNotesText", "uploadedDocumentNames", "documentInventoryText"];
  // planSetExtractedText is the uploaded-document text overlay; splitPagesText is
  // the splitter's sheet map. Both are machine extracts of the sheets themselves.
  const extracted = ["planSetExtractedText", "splitPagesText"];

  let affirmed = false;
  /** Returns TRUE as soon as any clause DENIES a seal — that ends the question
   *  outright (rule 2). Sets `affirmed` for a clause that survives rules 3-5. */
  const deniesASeal = (keys: string[], mayAssert: boolean): boolean => {
    for (const key of keys) {
      for (const piece of snap(project, key).toLowerCase().split(CLAUSE_BREAK)) {
        const clause = (piece || "").trim();
        if (!clause || !SEAL_ARTIFACT.test(clause)) continue;   // RULE 1 — clause scope
        if (NEGATOR.test(withoutNumberAbbreviation(clause))) return true; // RULE 2
        if (!mayAssert) continue;                     // raw extracts never assert
        if (HEDGED.test(clause)) continue;            // RULE 3
        if (CONTAINER_ONLY.test(clause)) continue;    // RULE 4
        if (!ASSERTS_PRESENCE.test(clause)) continue; // RULE 5
        affirmed = true;
      }
    }
    return false;
  };
  if (deniesASeal(assessed, true)) return false;
  if (deniesASeal(extracted, false)) return false;
  return affirmed;
}

// ---------------------------------------------------------------------------
// SEALED STRUCTURAL STAMP — the single authority.
//
// "Does THIS project need a PE/SE-sealed structural letter?" used to be answered
// independently by four consumers (required-documents, the reviewer gate, the
// application-docs builder, and the dashboard via documentInventory), each with
// its own subset of the triggers. They could disagree — the dashboard nagging for
// a letter the reviewer didn't require, or vice versa. Every consumer now asks
// here and passes in whatever context it has; missing context simply means that
// trigger can't fire, never a guess.
// ---------------------------------------------------------------------------

export interface StampRequirement {
  required: boolean;
  /** Which trigger fired. Ordered strongest-first; the first that fires wins. */
  source: "engineered_path" | "jurisdiction_threshold" | "process_profile" | "none";
  /** Operator-facing sentence naming WHY, so the requirement is actionable. */
  reason: string;
  /**
   * True when the trigger is hearsay (a learned process-profile flag) rather than
   * this project's own path or the jurisdiction's adopted rule. Waivable sources
   * surface as advisories ("confirm before submittal"), never hard blocks.
   */
  waivable: boolean;
  /** A stamp/sealed letter is already evidenced in the parsed documents. */
  satisfiedByEvidence: boolean;
}

export function resolveStampRequirement(
  project: ProjectRecord,
  inputs: {
    /** Jurisdiction threshold (prescriptive.engineerStampOverKwDc): <=0 means a
     *  stamp at ANY size (Chicago); positive means above that DC size (CA/MA 10). */
    stampThresholdKwDc?: number | null;
    jurisdictionLabel?: string;
    /** The learned AHJ process profile's requiresStructuralStamp flag. */
    processProfileRequiresStamp?: boolean;
  } = {},
): StampRequirement {
  const satisfiedByEvidence = hasStampedStructuralEvidence(project);
  const done = (
    required: boolean,
    source: StampRequirement["source"],
    reason: string,
    waivable = false,
  ): StampRequirement => ({ required, source, reason, waivable, satisfiedByEvidence });

  // 1. This project's own path. Strongest signal — engineered means engineered. A STANDARD
  //    structural review (outside Oregon, no prescriptive path on file) is not a demand for an
  //    Oregon-style PE package: the jurisdiction's own rule below decides the stamp there.
  const own = resolvePermitPath(project);
  if (own.path === "engineered" && !own.standardReview) {
    return done(true, "engineered_path",
      "Non-prescriptive path: the AHJ requires a wet/digital PE stamp on the structural sheets and a sealed engineering letter.");
  }

  // 2. The jurisdiction's adopted rule. Unknown system size never fabricates a
  //    requirement from a positive threshold — only <=0 (any-size) fires sizeless.
  const threshold = inputs.stampThresholdKwDc;
  const dcKw = Number(project.systemSizeDcKw ?? 0);
  const where = inputs.jurisdictionLabel || "This jurisdiction";
  if (threshold != null && Number.isFinite(threshold)) {
    if (threshold <= 0) {
      return done(true, "jurisdiction_threshold",
        `${where} requires stamped/sealed structural certification on every rooftop PV permit, regardless of system size.`);
    }
    if (dcKw > 0 && dcKw > threshold) {
      return done(true, "jurisdiction_threshold",
        `${where} requires a stamped structural letter above ${threshold} kW DC (this system is ${dcKw} kW DC).`);
    }
  }

  // 3. The learned process profile. Hearsay from imports/research, so it is an
  //    advisory the operator confirms — never a hard block on its own.
  if (inputs.processProfileRequiresStamp) {
    return done(true, "process_profile",
      `${where} process profile indicates a structural stamp/letter may be required. Confirm before submittal.`, true);
  }

  return done(false, "none", "Prescriptive path with no jurisdiction stamp rule — no sealed structural letter needed.");
}

/**
 * Resolve a project's permit path across all signals:
 *   1. Operator override (snapshot.permitPathOverride) — always wins.
 *   2. Parser hint (snapshot.permitPath) when it explicitly says prescriptive/engineered.
 *   3. Stamp recommendation that calls for a stamp/engineering → engineered.
 *   4. Structural prescriptive screen (snow ≤70, dead load ≤4.5, rafter spacing ≤24,
 *      wind B/C). Any failure → engineered. Microinverter roof mounts that pass the
 *      screen → prescriptive.
 *   5. Default for a standard residential roof mount → prescriptive.
 */
export interface PermitPathOptions {
  /** This jurisdiction's OWN prescriptive limits, from its code profile. Supplied by
   *  resolvePermitPathForProject (which has the db); absent here means "not researched
   *  yet", never "no limits apply". */
  limits?: PrescriptiveLimits;
}

export function resolvePermitPath(project: PermitPathInputs, opts: PermitPathOptions = {}): PermitPathResolution {
  const basis: string[] = [];
  const finalize = (path: PermitPath, source: PermitPathResolution["source"], standardReview = false): PermitPathResolution => {
    // A standard structural review asks for what THAT jurisdiction's rule asks for — not
    // Oregon's engineered-path PE package. See `standardReview` above.
    const engineeredPackage = path === "engineered" && !standardReview;
    return {
      path,
      source,
      standardReview,
      basis,
      needsEngineeredDocs: engineeredPackage,
      requiredEngineeredDocs: engineeredPackage ? ENGINEERED_REQUIRED_DOCS : [],
    };
  };

  // 1. Operator override — explicit dropdown choice is authoritative.
  const override = snap(project, "permitPathOverride").toLowerCase();
  if (/engineer|structural|non.?prescriptive/.test(override)) {
    basis.push("Operator selected the engineered / non-prescriptive path.");
    return finalize("engineered", "operator");
  }
  if (/prescriptive/.test(override)) {
    basis.push("Operator selected the prescriptive path.");
    return finalize("prescriptive", "operator");
  }

  // 2. Parser hint when it explicitly states the path.
  const hint = snap(project, "permitPath").toLowerCase();
  if (/engineer|non.?prescriptive/.test(hint)) {
    basis.push("Parser identified an engineered / non-prescriptive permit path.");
    return finalize("engineered", "parser");
  }

  // 3. Stamp recommendation calling for a stamp / engineering review.
  //
  // A HEDGE IS NOT A MANDATE. Brittany Reavis's parse carried "AHJ *may require* stamped
  // structural documentation for the 2x4 truss roof" — and this rule's `requires?` matched the
  // "require" inside "may require", overriding the parser's own permitPath="prescriptive" and
  // demanding PE-stamped plans the filing never needed. Salem's ISSUED permit for that exact
  // roof (26-108868-DW, 2026-07-06) reads "Solar Photovoltaic System Prescriptive Install?:
  // Yes" with no stamp anywhere — the "may" resolved to NO in the real world, consistent with
  // the standing Salem ruling (stamp not required on prescriptive). The same inversion as the
  // blank-seal lesson (commit 0a70e58), pointing the other way: uncertain language must fall
  // through to the prescriptive SCREEN below, which answers from measured facts, not wording.
  const stampText = `${snap(project, "stampRecommendation")} ${snap(project, "reviewFlags")}`.toLowerCase();
  const callsForStamp = /(requires?|needs?|recommend|must).{0,30}(stamp|engineer|pe seal|sealed|calc)/.test(stampText)
    || /engineered path|non.?prescriptive|structural review required/.test(stampText);
  const hedgedStamp = /\b(may|might|could|can|if|whether|possibly|potentially|in case|consider)\b[^.;]{0,16}\b(requires?|needs?|recommend|must)\b/.test(stampText);
  const explicitlyNoStamp = /(no stamp|stamp not required|prescriptive ok|prescriptive path)/.test(stampText);
  if (callsForStamp && !explicitlyNoStamp && !hedgedStamp) {
    basis.push(`Stamp recommendation indicates engineering is required: "${snap(project, "stampRecommendation") || snap(project, "reviewFlags")}".`);
    return finalize("engineered", "parser");
  }
  if (callsForStamp && hedgedStamp && !explicitlyNoStamp) {
    basis.push(
      `Stamp language is HEDGED ("may/might require") — a question for the AHJ, not a routing fact. `
      + `The prescriptive screen below decides from the measured limits; verify the stamp question with the jurisdiction.`,
    );
  }

  // 3.5 THE SCREEN BELOW IS OREGON'S, AND ONLY OREGON'S.
  //
  // Steps 1-3 above are jurisdiction-neutral and still rule for every state: an operator
  // override, the plan set's own engineered verdict, and affirmative stamp language all
  // decide a Florida project exactly as they decide an Oregon one. What cannot cross a
  // state line is the SCREEN — snow <= 70 psf, dead load <= 4.5, spacing <= 24",
  // exposure B/C, the 120/135 mph caps, the prescriptive-roofing rule. Those are ORSC /
  // BCD 440-5952 values, and Florida (FBC, exposure D, 150 mph as a matter of course),
  // Ohio (RCO) and Iowa answer to their own codes.
  //
  // So outside Oregon the screen is never run from Oregon's numbers. A recognised non-Oregon
  // state routes to the STANDARD structural review (the rule below — there is no
  // prescriptive-vs-engineered choice to confirm there); a state this resolver cannot
  // recognise, or none at all, is UNKNOWN, not a verdict from the wrong book. "unknown" is
  // not a dead end here: staging already refuses to proceed on it until the operator picks
  // a path (repository.ts), and the project screen has the dropdown for exactly that.
  //
  // When a jurisdiction's own limits are loaded (jurisdiction_code_profiles carries
  // `prescriptive`, and evaluatePrescriptiveCriteria already reads them), this gate is
  // where that data gets its say.
  // Intake stores the state as typed: "Oregon", "Ore." or " or " must still be OREGON here, and
  // "Oreg.", "OR 97201" or "Portland, OR" must not read as SOME OTHER STATE (which routes past
  // Oregon's confirmation). One allowlist normaliser (usStateCode), at the one comparison: a
  // spelling it does not recognise is "" and resolves UNKNOWN below, which the gate blocks on.
  const stateCode = usStateCode(project.state);
  const stateUnrecognised = !stateCode && Boolean(clean(project.state));
  const jurisdiction = opts.limits ?? {};
  // A STRAY LIMIT IS NOT A PRESCRIPTIVE PATH. Only the explicit hasPrescriptivePath flag —
  // which research sets by asking the question directly — says this jurisdiction publishes
  // one. Loose limit fragments do not: Florida's seeded state profile carries
  // allowedWindExposures ["B","C","D"], which is CORRECT Florida design-criteria data and
  // says nothing about a prescriptive PV path. Counting it as one let a Cape Coral project
  // "clear" a screen consisting of a single check with every other limit absent — an
  // unknown reading as reassurance, caught while measuring how often the gate interrupts
  // an operator (2026-09-22).
  const hasResearchedLimits = jurisdiction.hasPrescriptivePath === true;

  // A jurisdiction that PUBLISHES NO prescriptive PV path has answered the question: every
  // rooftop project there goes to standard/engineered review. That is a fact researched from
  // the jurisdiction, not an Oregon inference, so it routes.
  //
  // AND SO DOES A JURISDICTION WITH NO PRESCRIPTIVE PATH ON FILE. "Prescriptive vs engineered —
  // confirm which" is an OREGON question (ORSC / BCD 440-5952 publishes two applications and the
  // AHJ takes one). Asking it of every other state stopped all 25 IL and WA projects in the
  // 100-project load test at "Permit path confirmed" (2026-09-24): an operator was being asked to
  // choose between two applications that jurisdiction does not publish. Outside Oregon, unless the
  // jurisdiction's own research says it HAS a prescriptive path, there is one route — the standard
  // structural (building) review — and the project asks only for what that review needs: the
  // roof framing + attachment detail (every project's required set) and a sealed letter only when
  // the jurisdiction's own stamp rule says so (resolveStampRequirement). The operator can still
  // pick prescriptive for a jurisdiction that publishes one; its researched limits take over once
  // they land. Never "prescriptive": no Oregon number judges a Florida roof.
  if (stateCode && stateCode !== "OR" && !hasResearchedLimits) {
    const where = project.ahj || stateCode;
    basis.push(
      jurisdiction.hasPrescriptivePath === false
        ? `${where} publishes no prescriptive rooftop-PV path${jurisdiction.sourceUrl ? ` (${jurisdiction.sourceUrl})` : ""}, so rooftop PV goes through standard structural review.`
        : `No prescriptive rooftop-PV path is on file for ${where} (the prescriptive-vs-engineered screen here is Oregon's ORSC / BCD 440-5952 and does not apply in ${stateCode}), so rooftop PV goes through the standard structural (building) review — no path choice to confirm.`,
      `What that review needs: the roof framing + attachment detail, and a PE-sealed structural letter only if ${where}'s own rule requires one. If ${where} publishes a prescriptive path, choose it (Manual entry → Permit path).`,
    );
    return finalize("engineered", "structural-screen", true);
  }

  if (stateCode !== "OR" && !hasResearchedLimits) {
    // No state on file, or a spelling this resolver does not recognise: there is no jurisdiction
    // to route by, so no claim is made — never "some other state, standard review".
    basis.push(
      `The prescriptive screen encoded here is Oregon's (ORSC / BCD 440-5952 limits). `
      + (stateUnrecognised
        ? `This project's state ("${clean(project.state).slice(0, 40)}") is not a recognised US state spelling, so no path is inferred from it. `
        : `This project has no state on file, so those limits do not apply and no path is inferred from them. `)
      + `${stateUnrecognised ? "Correct" : "Add"} the project's state (a two-letter code, e.g. OR) or confirm the path on Manual entry → Permit path.`,
    );
    return finalize("unknown", "default");
  }

  // 4. Structural prescriptive screen — any breach routes to engineered.
  const snow = num(project, "snow");
  const deadLoad = num(project, "deadLoad");
  const spacing = num(project, "roofRafterSpacing");
  const wind = snap(project, "wind");
  // WHOSE LIMITS ARE THESE? Oregon's when the project is in Oregon; otherwise the ones
  // researched from the jurisdiction itself (we only reach this line outside Oregon when
  // some were found). A limit nobody published stays undefined and its check is SKIPPED —
  // an absent limit is not a limit of zero, and it must never borrow Oregon's number.
  const L = {
    snow: stateCode === "OR" ? OREGON_PRESCRIPTIVE_DEFAULTS.maxGroundSnowPsf : jurisdiction.maxGroundSnowPsf,
    dead: stateCode === "OR" ? OREGON_PRESCRIPTIVE_DEFAULTS.maxPvDeadLoadPsf : jurisdiction.maxPvDeadLoadPsf,
    spacing: stateCode === "OR" ? OREGON_PRESCRIPTIVE_DEFAULTS.maxRafterSpacingIn : jurisdiction.maxRafterSpacingIn,
    exposures: stateCode === "OR" ? OREGON_PRESCRIPTIVE_DEFAULTS.allowedWindExposures : jurisdiction.allowedWindExposures,
  };
  const whose = stateCode === "OR" ? "prescriptive" : `${project.ahj || stateCode} prescriptive`;
  const screenFailures: string[] = [];
  if (snow != null && L.snow != null && snow > L.snow) screenFailures.push(`ground snow load ${snow} psf > ${L.snow} psf ${whose} limit`);
  if (deadLoad != null && L.dead != null && deadLoad > L.dead) screenFailures.push(`PV dead load ${deadLoad} psf > ${L.dead} psf ${whose} limit`);
  if (spacing != null && L.spacing != null && spacing > L.spacing) screenFailures.push(`rafter spacing ${spacing} in > ${L.spacing} in ${whose} limit`);
  if (wind && L.exposures?.length && !L.exposures.some((e: string) => new RegExp(`\\b${e}\\b`, "i").test(wind))) {
    screenFailures.push(`wind exposure "${wind}" outside ${whose} ${L.exposures.join("/")}`);
  }
  // ROOFING MATERIAL IS A SCREEN INPUT, NOT JUST A CHECKLIST ROW. The ORSC prescriptive
  // path admits only metal, wood shingle/shake, or <=2-layer composition (the BCD 5952
  // roofing row) — a membrane roof is outside it no matter how clean the numbers are.
  // Operator ruling (2026-09-21): "In Oregon, a PV solar installation on a TPO roof is
  // automatically a non-prescriptive project... we had to get stamps for them." Proven on
  // David Simmons: TPO + ballasted, numerics all inside the limits, screen said
  // prescriptive — his REAL filing is 187-26-000328-STR, a stamped STRUCTURAL permit.
  // An UNKNOWN material stays silent (absence is not failure); only a RECOGNIZED
  // non-qualifying covering fails the screen.
  const roofMaterial = snap(project, "roofMaterial");
  // TILE IS OUTSIDE THE ROW TOO. Concrete / clay / S-tile / flat tile are none of metal, wood
  // shingle/shake or composition, so an Oregon tile roof answers the BCD 5952 roofing row NO and
  // the job is not prescriptive — before this, the screen only knew membranes and a tile roof with
  // clean numbers routed PRESCRIPTIVE (the wrong application, and a 5952 that should never be
  // filed). roofCovering.ts is the one predicate (bcdChecklistFacts asks the same one).
  const covering = classifyRoofCovering(roofMaterial, snap(project, "roofMaterialSubtype"));
  // A roof described only by its material ("Concrete", "Clay", "Terra cotta") is tile; slate is its
  // own recognised family — both outside the row's allowlist (roofCovering.ts decides).
  const nonPrescriptiveRoof = covering.family === "membrane" || covering.family === "tile" || covering.family === "slate";
  // The roofing rule is Oregon's ORSC row, so it only speaks for Oregon. Another state's
  // published path may admit membranes or tile; until its own rule is researched, this stays
  // quiet rather than asserting Oregon's into a Florida verdict.
  // The same row also refuses a THIRD layer of composition (or a second of wood) — the checklist
  // answers No there, so the path must not say prescriptive while its own form says No.
  const layersFail = !nonPrescriptiveRoof && stateCode === "OR"
    && oregonRoofingRowQualifies(roofMaterial, snap(project, "roofMaterialSubtype"), snap(project, "roofLayers")) === false;
  if (layersFail) {
    screenFailures.push(`${snap(project, "roofLayers")} existing layer(s) of "${roofMaterial}" — the BCD 5952 roofing row admits no more than two layers of composition (one of wood shingles/shakes)`);
  }
  if (nonPrescriptiveRoof && stateCode === "OR") {
    screenFailures.push(covering.family === "tile"
      ? `roofing material "${roofMaterial}"${covering.subtype && !roofMaterial.toLowerCase().includes(covering.subtype.toLowerCase()) ? ` (${covering.subtype})` : ""} is tile — not a prescriptive-eligible covering (the BCD 5952 roofing row admits only metal, single-layer wood shingles/shakes, or <=2-layer composition), so tile-roof PV is non-prescriptive in Oregon: file the engineered/structural application`
      : `roofing material "${roofMaterial}" is not a prescriptive-eligible covering (metal, wood shingle/shake, or <=2-layer composition) — ${covering.family}-roof PV is non-prescriptive in Oregon`);
  }
  // ULTIMATE WIND SPEED, not just exposure. A COASTAL site routinely parses as exposure C —
  // inside the B/C allowance — while its design wind speed sits in the special wind region
  // above the prescriptive tables' cap (120 mph Vult at exposure C, 135 at B: the same
  // numbers the criterion rows answer from). Without this line, a coastal plan set that
  // happens to carry a stamp recommendation of "none needed" would clear the screen on
  // exposure alone and route prescriptive where the tables do not apply. Both live Coos Bay
  // projects routed engineered only because their title blocks lacked a seal — the screen
  // itself was blind to the coast.
  const windSpeed = num(project, "windSpeed");
  const speedCap = stateCode === "OR"
    ? (/\bB\b/i.test(wind) ? OREGON_PRESCRIPTIVE_DEFAULTS.maxWindSpeedMphExpB : OREGON_PRESCRIPTIVE_DEFAULTS.maxWindSpeedMphExpC)
    : (/\bB\b/i.test(wind) ? jurisdiction.maxWindSpeedMphExpB : jurisdiction.maxWindSpeedMphExpC);
  if (windSpeed != null && speedCap != null && windSpeed > speedCap) {
    screenFailures.push(`ultimate design wind speed ${windSpeed} mph > ${speedCap} mph ${whose} cap${wind ? ` at exposure ${wind.toUpperCase()}` : ""}`);
  }
  if (screenFailures.length) {
    basis.push(`Structural prescriptive screen failed: ${screenFailures.join("; ")}.`);
    return finalize("engineered", "structural-screen");
  }

  // 5. Default — a standard residential roof mount that clears the screen is prescriptive.
  const mounting = snap(project, "mounting").toLowerCase();
  const isGroundMount = /ground[-\s]?mount|pole[-\s]?mount/.test(mounting);
  if (isGroundMount) {
    basis.push("Ground/pole mount — typically engineered (verify against the AHJ's prescriptive scope).");
    return finalize("engineered", "structural-screen");
  }
  const hasMicro = Boolean(snap(project, "pvMicroModel") || snap(project, "pvMicroMake"));
  if (hasMicro) basis.push("Microinverter roof mount clearing the structural screen — prescriptive path.");
  else basis.push("Roof mount clears the prescriptive structural screen — prescriptive path (verify the structural inputs were parsed).");
  // If we never saw any structural inputs at all, mark it unknown so the UI nudges
  // the operator to confirm rather than silently assuming prescriptive.
  const sawStructuralInputs = snow != null || deadLoad != null || spacing != null || Boolean(wind);
  if (!sawStructuralInputs && !hasMicro) {
    basis.push("No structural inputs were parsed — confirm the path with the dropdown before building docs.");
    return finalize("unknown", "default");
  }
  return finalize("prescriptive", "default");
}

// ---------------------------------------------------------------------------
// Prescriptive structural criteria — the itemized screen the AHJ's prescriptive
// checklist asks. Each row answers Yes / No / [verify] straight from the parsed
// structural data, so the generated checklist stops shipping hardcoded [verify].
// Thresholds default to the Oregon residential prescriptive solar limits (which
// match the seeded jurisdiction code profile) and can be overridden per-AHJ.
// ---------------------------------------------------------------------------

export interface PrescriptiveLimitInputs {
  maxGroundSnowPsf?: number;
  maxPvDeadLoadPsf?: number;
  maxRafterSpacingIn?: number;
  allowedWindExposures?: string[];
  /** Ultimate design wind speed cap (mph) by exposure — prescriptive tables. */
  maxWindSpeedMphExpC?: number;
  maxWindSpeedMphExpB?: number;
  /** Max module height above the roof surface (in.) to stay in the array tables. */
  maxModuleHeightIn?: number;
  /** Max existing roofing layers under the array. */
  maxRoofLayers?: number;
}

export type PrescriptiveAnswer = "Yes" | "No" | "[verify]";

/** Stable identifiers for each criterion row — the PDF form-fill bridge binds
 *  checklist checkboxes to these (computed.presc<Key>Yes / ...No), so they must
 *  never be renamed once templates reference them. */
export type PrescriptiveCriterionKey =
  | "roofMount"
  | "lightFrame"
  | "riskCategory"
  | "snowLoad"
  | "windExposure"
  | "windSpeed"
  | "rafterSpacing"
  | "deadLoad"
  | "moduleHeight"
  | "roofLayers";

export interface PrescriptiveCriterion {
  key: PrescriptiveCriterionKey;
  label: string;
  answer: PrescriptiveAnswer;
  detail: string;
}

/** The criterion keys + default labels, for building the mapper's source list.
 *  Derived from an empty evaluation so labels stay in lockstep with the rows. */
export function prescriptiveCriterionCatalog(): Array<{ key: PrescriptiveCriterionKey; label: string }> {
  const empty = { parserSnapshot: {} } as unknown as ProjectRecord;
  return evaluatePrescriptiveCriteria(empty).map(({ key, label }) => ({ key, label }));
}

const OREGON_PRESCRIPTIVE_DEFAULTS: Required<PrescriptiveLimitInputs> = {
  maxGroundSnowPsf: 70,
  maxPvDeadLoadPsf: 4.5,
  maxRafterSpacingIn: 24,
  allowedWindExposures: ["B", "C"],
  maxWindSpeedMphExpC: 120,
  maxWindSpeedMphExpB: 135,
  maxModuleHeightIn: 18,
  maxRoofLayers: 1,
};

function yesNoFlag(raw: string): PrescriptiveAnswer {
  const v = raw.toLowerCase();
  if (!v) return "[verify]";
  if (/\b(yes|y|true|conventional|light[-\s]?frame)\b/.test(v)) return "Yes";
  if (/\b(no|n|false)\b/.test(v)) return "No";
  return "[verify]";
}

/** Evaluate every prescriptive-screen criterion from parsed data (Yes/No/[verify]). */
export function evaluatePrescriptiveCriteria(
  project: ProjectRecord,
  limits: PrescriptiveLimitInputs = {},
): PrescriptiveCriterion[] {
  const L = { ...OREGON_PRESCRIPTIVE_DEFAULTS, ...limits };
  const rows: PrescriptiveCriterion[] = [];

  // Numeric "<= limit" criterion: Yes when parsed and within, No when over, else verify.
  const maxRow = (key: PrescriptiveCriterionKey, label: string, snapKey: string, limit: number, unit: string): void => {
    const n = num(project, snapKey);
    if (n == null) rows.push({ key, label, answer: "[verify]", detail: `${label} not parsed` });
    else rows.push({ key, label, answer: n <= limit ? "Yes" : "No", detail: `${n} ${unit} (limit ${limit} ${unit})` });
  };

  // Roof-mounted PV.
  const mounting = snap(project, "mounting").toLowerCase();
  rows.push({
    key: "roofMount",
    label: "Roof-mounted PV",
    answer: mounting ? (/roof/.test(mounting) && !/ground|pole/.test(mounting) ? "Yes" : "No") : "[verify]",
    detail: mounting || "mounting not parsed",
  });

  // Conventional light-frame construction.
  const lf = yesNoFlag(snap(project, "lightFrame"));
  rows.push({
    key: "lightFrame",
    label: "Conventional light-frame construction",
    answer: lf,
    detail: snap(project, "lightFrame") || snap(project, "framingType") || "light-frame flag not parsed",
  });

  // Risk category I or II (residential).
  const rc = snap(project, "riskCategory").toUpperCase().replace(/[^IV]/g, "");
  rows.push({
    key: "riskCategory",
    label: "Risk Category I or II",
    answer: rc ? (rc === "I" || rc === "II" ? "Yes" : "No") : "[verify]",
    detail: rc ? `Category ${rc}` : "risk category not parsed",
  });

  maxRow("snowLoad", `Ground snow load <= ${L.maxGroundSnowPsf} psf`, "snow", L.maxGroundSnowPsf, "psf");

  // Wind exposure.
  const wind = snap(project, "wind").toUpperCase().replace(/[^A-D]/g, "");
  rows.push({
    key: "windExposure",
    label: `Wind exposure ${L.allowedWindExposures.join(" or ")}`,
    answer: wind ? (L.allowedWindExposures.includes(wind) ? "Yes" : "No") : "[verify]",
    detail: wind ? `Exposure ${wind}` : "wind exposure not parsed",
  });

  // Ultimate design wind speed vs exposure-specific cap.
  const windSpeed = num(project, "windSpeed");
  const speedCap = wind === "B" ? L.maxWindSpeedMphExpB : L.maxWindSpeedMphExpC;
  if (windSpeed == null) rows.push({ key: "windSpeed", label: "Ultimate design wind speed within prescriptive cap", answer: "[verify]", detail: "wind speed not parsed" });
  else rows.push({
    key: "windSpeed",
    label: "Ultimate design wind speed within prescriptive cap",
    answer: windSpeed <= speedCap ? "Yes" : "No",
    detail: `${windSpeed} mph (limit ${speedCap} mph for Exp ${wind || "C"})`,
  });

  maxRow("rafterSpacing", `Rafter/truss spacing <= ${L.maxRafterSpacingIn} in. o.c.`, "roofRafterSpacing", L.maxRafterSpacingIn, "in");
  maxRow("deadLoad", `PV dead load <= ${L.maxPvDeadLoadPsf} psf`, "deadLoad", L.maxPvDeadLoadPsf, "psf");
  maxRow("moduleHeight", `Module height above roof <= ${L.maxModuleHeightIn} in.`, "moduleHeightAboveRoof", L.maxModuleHeightIn, "in");
  maxRow("roofLayers", `Existing roofing layers <= ${L.maxRoofLayers}`, "roofLayers", L.maxRoofLayers, "layer(s)");

  return rows;
}

// ---------------------------------------------------------------------------
// WHAT PATH DOES A PUBLISHED LINE CLAIM TO BE ABOUT?
//
// The AHJ publishes two applications and you file one; it also publishes two
// FEES and you owe one. The document half of that pair has been path-scoped for
// a while (formApplicationKind / formAllowedForPath in ahjForms.ts). The fee
// half was not, and on a live Coos Bay project the two halves said opposite
// things on the same screen: the blocker panel demanded a PE stamp and a sealed
// engineering letter (engineered path) while the fee card quoted $200 off a row
// whose own label reads "Solar Permit (when required) – PRESCRIPTIVE PATH
// System" and whose own notes say engineered installs are charged from a
// different table by valuation. This is that gate, for the fee side.
//
// THE ENGINEERED TEST RUNS FIRST, AND THAT ORDER IS THE WHOLE CORRECTNESS OF
// THIS FUNCTION — the same rule, for the same reason, as formApplicationKind's
// header states: "Non-Prescriptive" CONTAINS "prescriptive". Test /prescriptive/
// first and every line the AHJ titles with its own word for ENGINEERED comes
// back "prescriptive", which is the inverted gate rebuilt on the money side.
//
// WHY THIS IS NOT formApplicationKind, and must not be "deduplicated" into it:
//
//   1. IMPORT CYCLE. ahjForms.ts imports feeSchedules.ts (findFeeScheduleForProject).
//      feeSchedules.ts needing a classifier from ahjForms.ts would close that
//      loop. permitPath.ts imports nothing but the shared types, so it is the
//      side of the edge a shared classifier can live on.
//   2. "STRUCTURAL" MEANS SOMETHING ELSE HERE. formApplicationKind reads
//      /structural/ as the engineered application, which is right for a FORM
//      NAME. On a fee row "structural" is the DISCIPLINE (FeeDiscipline:
//      structural vs electrical vs combo) and says nothing about the path — the
//      City of Coos Bay row IS the structural permit AND is prescriptive-only.
//      A label reading "Solar structural permit, prescriptive path" would
//      classify engineered under formApplicationKind and invert the gate again.
//
// LABELS ONLY — NEVER NOTES. A bracket's label is the jurisdiction's own wording
// for THAT line, at the grain of the claim. Notes are prose ABOUT the row and
// routinely discuss both paths in one breath: the live City of Coos Bay row's
// notes read "Prescriptive path only. NONPRESCRIPTIVE (engineered) installs are
// charged from the Structural Permit Fee table by valuation …" — every
// engineered word in the table sits in the notes of a PRESCRIPTIVE row. Any
// classifier pointed at that blob reports "engineered" and hands the engineered
// project the prescriptive fee it was built to refuse. feePathScope.test.ts
// holds that exact row as a fixture so the rule is enforced, not just written.
// ---------------------------------------------------------------------------

/** "" means the line makes NO claim about the path, which is the ordinary case
 *  and is compatible with either one — the same convention formApplicationKind
 *  uses for null. Never a guess. */
export type PathWordingScope = "prescriptive" | "engineered" | "";

/** Does this published line's own wording scope it to one of the two mutually
 *  exclusive permit paths? Engineered is tested FIRST — see the header. */
export function pathWordingScope(label: string | null | undefined): PathWordingScope {
  const n = String(label ?? "").toLowerCase();
  // REGEX LITERALS, not strings joined into a RegExp — "\b" inside a JS string
  // literal is a BACKSPACE character, and this module has shipped that bug once
  // already (see hasStampedStructuralEvidence above).
  if (/\bnon-?\s*prescriptive\b|\bengineered\b/.test(n)) return "engineered";
  if (/\bprescriptive\b/.test(n)) return "prescriptive";
  return "";
}

/** Does a line scoped THIS way contradict a project resolved to THAT path?
 *
 *  Deliberately the same shape and the same weakness as ahjForms'
 *  formContradictsPath: only an AFFIRMATIVE contradiction counts. An UNKNOWN
 *  path contradicts nothing (we have not decided, so we cannot say the row is
 *  wrong) and a line that claims no path contradicts nothing either. */
export function pathWordingContradicts(scope: PathWordingScope, path: PermitPath): boolean {
  if (!scope) return false;
  if (path !== "prescriptive" && path !== "engineered") return false;
  return scope !== path;
}

/** One-line human callout summarizing the path + its fee/review implications. */
export function permitPathCallout(res: PermitPathResolution): string {
  if (res.standardReview) {
    return "Standard structural review — this jurisdiction has no prescriptive rooftop-PV path on file, so there is no prescriptive-vs-engineered choice to make. File its building/structural application with the roof framing + attachment detail; a PE-sealed letter only where its own rule requires one.";
  }
  if (res.path === "prescriptive") {
    return "Prescriptive path — upload ONLY the prescriptive application. Meets prescriptive code, no plan review, reduced permit fee. Do NOT also upload the structural application.";
  }
  if (res.path === "engineered") {
    return "Engineered (non-prescriptive) path — upload ONLY the structural application. Requires plan review, full structural fees, and a PE-stamped plan set + structural engineering letter/calcs. Do NOT also upload the prescriptive application.";
  }
  return "Permit path not yet confirmed — choose prescriptive vs engineered before building the AHJ application. They are mutually exclusive; upload only one.";
}
