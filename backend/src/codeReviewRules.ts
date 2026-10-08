import type { AhjProcessProfile, CodeReference, NecEditionRequirements, ProjectRecord, ReviewerFinding, ReviewerFindingEvidence, StructureTypeFact } from "../../shared/src/types";
import type { EffectiveCodeContext } from "./codeProfiles";
import { FIRE_PATHWAY_PATTERNS, packageShowsSld } from "./projectEvidence";
import { evaluateElectricalSizingFindings } from "./electricalSizing";
import { evaluateAmendmentFindings } from "./amendmentChecks";
import { evaluatePriorCorrectionFindings } from "./ahjReviewRules";
import { pathWordingScope, resolvePermitPath, usStateCode } from "./permitPath";
import { classifyRoofCovering, statedRoofDeadLoads, tileAttachmentFromText, tileAttachmentMethodOf, TILE_MIN_ROOF_DEAD_LOAD_PSF } from "./roofCovering";
import {
  evaluateDesignCriteriaFindings,
  evaluateFirePathwayFindings,
  extractAttachmentSpacings,
  packageTextSources,
  PARSED_FIELDS_SOURCE,
  residentialCodeRef,
  sheetTextSources,
  type DesignTextSource,
} from "./designCriteria";
import { adoptedNecEdition, necEditionRequirements, NEC_EDITION_REQUIREMENTS } from "./necEditions";
import { moduleLevelElectronicsEquipment, type ModuleLevelElectronicsEvidence } from "./moduleLevelElectronics";
import { designText, mountKind, type MountKind } from "./mountKind";
export { designText, engineeredGroundMount, groundMountFromField, isGroundMount, mountKind, mountKindForProject, type MountKind } from "./mountKind";

const oregonElectrical2023: CodeReference = {
  code: "2023 OESC / 2023 NEC",
  section: "Articles 690 and 705",
  title: "Solar PV and interconnected power production sources",
  adoptionScope: "Oregon electrical submittals; verify local adopted NEC cycle outside Oregon.",
  sourceUrl: "https://www.oregon.gov/bcd/codes-stand/pages/electrical.aspx",
  note: "Oregon BCD lists the 2023 Oregon Electrical Specialty Code as effective Oct. 1, 2023 and based on the 2023 NEC.",
};

const rapidShutdown: CodeReference = {
  code: "NEC",
  section: "690.12",
  title: "Rapid shutdown of PV systems on buildings",
  adoptionScope: "Rooftop/building-mounted PV where the AHJ has adopted NEC rapid shutdown provisions.",
  sourceUrl: "https://www.oregon.gov/bcd/codes-stand/pages/electrical.aspx",
  note: "Use the locally adopted NEC edition and amendments for exact label/control wording.",
};

const powerSourceDirectory: CodeReference = {
  code: "NEC",
  section: "705.10",
  title: "Identification of power sources",
  adoptionScope: "Interconnected PV systems.",
  sourceUrl: "https://www.oregon.gov/bcd/codes-stand/pages/electrical.aspx",
  note: "Plan sets should include a permanent directory/placard concept where required by the adopted NEC.",
};

const loadSideInterconnection: CodeReference = {
  code: "NEC",
  section: "705.12",
  title: "Load-side source connections",
  adoptionScope: "PV connected on the load side of service equipment.",
  sourceUrl: "https://codes.iccsafe.org/s/ISEP2021P1/national-electrical-code-nec-solar-provisions/ISEP2021P1-NEC-Sec705.12",
  note: "Verify against the adopted NEC edition; plan reviewers commonly expect bus/main/PV breaker math to be explicit.",
};

const supplySideInterconnection: CodeReference = {
  code: "NEC",
  section: "705.11",
  title: "Supply-side source connections",
  adoptionScope: "PV connected ahead of the service disconnect or by line-side tap.",
  sourceUrl: "https://www.oregon.gov/bcd/codes-stand/pages/electrical.aspx",
  note: "Show the tap point, disconnect/OCPD, conductor routing, utility coordination, and service equipment details.",
};

const roofLoads: CodeReference = {
  code: "IRC / ORSC",
  section: "R324.4.1",
  title: "Rooftop-mounted photovoltaic systems and roof loads",
  adoptionScope: "One- and two-family residential rooftop PV, subject to local amendments.",
  sourceUrl: "https://codes.iccsafe.org/content/IRC2021P1/chapter-3-building-planning",
  note: "Roof structure, dead load, live load, and attachment assumptions must be shown clearly enough for review.",
};

const roofAccess: CodeReference = {
  code: "IRC",
  section: "R324.6",
  title: "Roof access and pathways for PV systems",
  adoptionScope: "Residential rooftop PV where adopted by the AHJ.",
  sourceUrl: "https://codes.iccsafe.org/s/IRC2021P2/chapter-3-building-planning/IRC2021P2-Pt03-Ch03-SecR324.6.1",
  note: "Use the local code cycle and fire official amendments for pathway/setback dimensions and exceptions.",
};

const fireAccess: CodeReference = {
  code: "IFC",
  section: "1205.2",
  title: "Access and pathways for PV systems",
  adoptionScope: "Fire-code review for rooftop PV.",
  sourceUrl: "https://codes.iccsafe.org/s/IFC2021P1/chapter-12-energy-systems/IFC2021P1-Pt03-Ch12-Sec1205.2",
  note: "Pathways should be placed over structurally capable roof areas with minimal obstructions.",
};

const oregonPrescriptive: CodeReference = {
  code: "ORSC / OSSC",
  section: "Oregon Prescriptive Rooftop-Mounted Solar PV Checklist",
  title: "Oregon prescriptive rooftop PV installation screening",
  adoptionScope: "Oregon residential and commercial prescriptive rooftop PV path.",
  sourceUrl: "https://www.washingtoncountyor.gov/lut/building-services/documents/solar-checklist/download?inline=",
  note: "Common screens include PV dead load, ground snow load, wind exposure, roof slope, and framing spacing/span evidence.",
};

const portlandRafterSpan: CodeReference = {
  code: "OSSC",
  section: "Table 2308.7.2(1)",
  title: "Rafter span tables used by Portland solar worksheet",
  adoptionScope: "Portland-style prescriptive rafter span review; useful baseline for Oregon AHJ review.",
  sourceUrl: "https://www.portland.gov/ppd/documents/solar-worksheet/download",
  note: "Show rafter size, spacing, species/grade, span, roof slope, and support conditions when using a prescriptive path.",
};

const essReference: CodeReference = {
  code: "NEC / IRC / IFC",
  section: "NEC 706; IRC R328; IFC 1207",
  title: "Energy storage system installation and location",
  adoptionScope: "Battery/ESS projects; verify adopted editions and local fire amendments.",
  sourceUrl: "https://codes.iccsafe.org/content/IFC2021P1/chapter-12-energy-systems",
  note: "ESS comments are conservative because exact adopted section numbering varies by state and code cycle.",
};

function str(project: ProjectRecord, key: string): string {
  const value = project.parserSnapshot[key];
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

// A FIELD WITH TWO NUMBERS IN IT IS NOT A NUMBER.
//
// This used to delete every non-digit and parseFloat whatever was left, so a rating that
// carried a note became the CONCATENATION of its numbers. The live book holds a real example:
// pvBreaker "50A (fuses in 60A AC disconnect at line-side tap)" read as 5060 amps. It fails in
// both directions, which is what makes it dangerous rather than merely wrong:
//   - busRating "200A (Note 3)" -> 2003, so a genuine 200A/200A/60A violation (260A against a
//     240A allowance) sits far below 120% of 2003 and the blocker goes SILENT;
//   - mainBreaker "175A (2 of 2)" -> 17522, so a COMPLIANT design is blocked, with the report
//     printing "17522A main" to the operator.
//
// So: one number means one number. Several numbers with exactly one carrying an amp unit means
// that one — "50A (fuses in 60A AC disconnect)" is unambiguous to a human and should be to us.
// Anything still ambiguous returns null, which routes to city.elec.load-side-calc-missing
// ("ratings not readable") instead of a confident calculation on a fabricated figure. An
// unknown must not read as a number.
export function parseRating(raw: string): number | null {
  const numbers = raw.match(/-?\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length === 0) return null;
  if (numbers.length === 1) {
    const only = Number.parseFloat(numbers[0]);
    return Number.isFinite(only) ? only : null;
  }
  // Several numbers: let the UNITS disambiguate, but only when they point at exactly one.
  // "50A (fuses in 60A AC disconnect)" names two currents and stays ambiguous; "200A, 120/240V"
  // names one current and a voltage, so the current wins. Volts are deliberately absent from
  // this list — a service voltage is never the rating any of these rules is asking for, and
  // admitting it would re-ambiguate every field that states one.
  const united = [...raw.matchAll(/(-?\d+(?:\.\d+)?)\s*(?:A\b|AMPS?\b|PSF\b|PCF\b|MPH\b|FT\b|FEET\b|IN\b|INCH(?:ES)?\b)/gi)].map((m) => m[1]);
  const distinct = [...new Set(united)];
  if (distinct.length === 1) {
    const value = Number.parseFloat(distinct[0]);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

function num(project: ProjectRecord, keys: string[]): number | null {
  for (const key of keys) {
    const raw = str(project, key);
    if (!raw) continue;
    const value = parseRating(raw);
    if (value != null) return value;
  }
  return null;
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

// "IS THIS OREGON" IS THE PROJECT'S STATE, NOTHING ELSE (leak-fix-forms F4, forms skeptic note 3):
// usStateCode(state) === "OR". A blank state is UNKNOWN — never Oregon guessed from a place name
// ("Salem", "Portland", "Washington County" exist in many states) or from a profile row.
function isOregon(project: ProjectRecord, _profile: AhjProcessProfile | null): boolean {
  return usStateCode(project.state) === "OR";
}

// IS THIS ON A ROOF? — the one mount predicate (mountKind / mountKindForProject) lives in
// mountKind.ts, so permitPath and requiredDocuments ask the same question without importing this
// module (which imports permitPath). Re-exported here for the callers that always read it from here.

/** The mount, as the scope-of-work sentence names it — "" when the mount is not known: an unknown
 *  mount is never written as "roof-mounted" on an application (leak sweep 2026-09-28). */
export function mountAdjective(kind: MountKind): string {
  return kind === "roof" ? "Roof-mounted" : kind === "ground" ? "Ground-mounted" : kind === "carport" ? "Carport-mounted" : "";
}

/** True when the array sits on a roof and the roof rule family applies. */
export function isRoofMounted(project: ProjectRecord, allText: string): boolean {
  const kind = mountKind(project, allText);
  return kind === "roof" || kind === "unknown";
}

/** NEC 690.12 governs PV on BUILDINGS — a ground/pole array is not on one; a carport may be. */
export function rapidShutdownApplies(project: ProjectRecord, allText: string): boolean {
  return mountKind(project, allText) !== "ground";
}

// Same reasoning, same shape: the engine's plan-set pass raises its own rapid-shutdown finding
// and had no idea what MLPE is, so a microinverter design collected a BLOCKER there while this
// module correctly softened its own finding to a warning. The two are paired on
// topic:rapid-shutdown, and once dedupe started ranking by severity the blocker won — a design
// that satisfies NEC 690.12 inherently was hard-blocked for a labelling gap.
export function isMlpeDesignForProject(project: ProjectRecord): boolean {
  return mlpeDesign(project, designText(project), packageTextSources(project)).mlpe;
}

// Module-level power electronics (microinverters / RSD-integrated optimizers) provide
// inherent module-level rapid shutdown under NEC 690.12. When the design is MLPE-based,
// a missing RSD plan callout is a labeling/documentation gap — not a missing-equipment
// blocker that should stop staging.
// A BRAND NAME IS NOT AN INVERTER TOPOLOGY. MLPE satisfies NEC 690.12 inherently, so an MLPE
// design has its rapid-shutdown finding softened from blocker to warning — which means getting
// this wrong DOWNGRADES a safety blocker. The old test scanned the whole plan text for brands,
// and Enphase makes batteries: measured, a SolarEdge string-inverter system carrying an Enphase
// IQ Battery was reclassified as MLPE and had its blocker softened.
//
// So the INVERTER FIELDS decide when they exist — brand names are meaningful there, because
// that field names the inverter. The plan text is only a fallback for a parse that captured no
// inverter at all, and the fallback asks for topology words rather than brands, since every one
// of those brands also sells storage.
const MLPE_TOPOLOGY = [
  /micro.?inverter/i,
  /\bmlpe\b/i,
  /module.level (power electronics|shutdown|rapid shutdown)/i,
];
// An Enphase micro is named by its model family as often as by the make: "IQ8M-72-2-US", "IQ8A",
// "IQ7PLUS". `\biq\s?[678]\b` never matched those — the digit and the suffix letter are both word
// characters — so a field holding just the model read as a string design and was hard-blocked
// (#213). The suffix is letters only, so "IQ Battery 5P" (no digit after IQ) stays out.
const ENPHASE_MICRO = /enphase|\biq\s?[678](?:[a-z]+)?\b/i;
const MLPE_INVERTER_BRANDS = [
  ENPHASE_MICRO,
  /ap\s?systems|apsystems|\bds3\b|\bqs1\b|\byc600\b/i,
  /hoymiles/i,
  /tigo\s?(ts4|rsd)/i,
];

// RSD-INTEGRATED OPTIMIZERS ARE MLPE TOO (#213). The policy above always said so, but nothing here
// read optimizers: a SolarEdge string inverter with an S440 on every module came out a plain string
// design and its edition-evidence finding went to a blocker once the profile was verified. The
// optimizer EQUIPMENT (a model field, or a schedule line with a quantity and an optimizer model) is
// read by moduleLevelElectronicsEquipment — the same predicate the Iowa worksheet asks — never the
// brand (SolarEdge sells string inverters and batteries) or the bare word (rail datasheets and city
// handouts say "optimizers"). `equipment` is that line, so the finding can cite it.
function mlpeDesign(project: ProjectRecord, allText: string, texts: DesignTextSource[]): { mlpe: boolean; equipment: ModuleLevelElectronicsEvidence } {
  const equipment = moduleLevelElectronicsEquipment(project.parserSnapshot ?? {}, texts);
  return { mlpe: equipment.present || isMicroOrMlpeInverter(project, allText), equipment };
}

function isMicroOrMlpeInverter(project: ProjectRecord, allText: string): boolean {
  const microModel = str(project, "pvMicroModel");
  const inverterText = [
    microModel,
    str(project, "pvMicroQty") ? "microinverter" : "",
    str(project, "invModel"),
    str(project, "inverterModel"),
  ].filter(Boolean).join("\n");

  // An inverter is on file: it answers the question, brands included.
  if (inverterText.trim()) return hasAny(inverterText, [...MLPE_TOPOLOGY, ...MLPE_INVERTER_BRANDS]);

  // Nothing recorded — fall back to the sheets, but only on topology language.
  return hasAny(allText, MLPE_TOPOLOGY);
}

// ---------------------------------------------------------------------------
// A STATEMENT, NOT A MENTION. The three questions below (is this a manufactured home? does
// the engineering carry the load to the foundation? is the listing shown?) are each answered
// by a phrase in the package — and each phrase can appear NEGATED ("not a manufactured home",
// "no UL 2703 listing provided", "load path to the foundation not evaluated"). A negated
// phrase must not answer yes. One reader, so the three cannot disagree about what "stated"
// means.
// The negation must sit IMMEDIATELY before the phrase (at most two short words between:
// "not a manufactured home", "not listed to UL 2703") — a wider window read "engineered, not
// prescriptive, for a manufactured home" as a denial.
const NEGATION_BEFORE = /(?:\b(?:not|no|never|without|missing|lacks?|lacking|other\s+than|excluding|except|isn'?t)\s+(?:[a-z]+\s+){0,2}|\bnon[-\s]?)$/i;
// "NOT USED" denies only DIRECTLY after the mention (#242: "690.12(B)(2)(3) - NOT USED"), like
// "N/A" and "NONE". Never in the 30-character window: affirmedIn joins whitespace, so the next
// schedule row ("EV CHARGER: N/A", "HOA: N/A") would deny a real mention before it.
const NEGATION_AFTER = /^[^.;]{0,30}?\b(?:not\s+(?:provided|shown|found|included|listed|evaluated|verified|checked|analy[sz]ed|addressed|applicable)|missing|by\s+others|excluded)\b|^\s*[?:\u2013\u2014-]?\s*(?:no|n\/a|none|not\s+used)\b/i;

interface Affirmed {
  source: string;
  excerpt: string;
}

/** An extra, question-specific "this mention is not a statement" test (see notAboutThisStructure). */
type MentionGuard = (text: string, index: number, matched: string) => boolean;

function affirmedIn(sources: DesignTextSource[], patterns: RegExp[], notAStatement?: MentionGuard): Affirmed | null {
  for (const s of sources) {
    const text = String(s.text || "").replace(/\s+/g, " ");
    for (const pattern of patterns) {
      const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        const before = text.slice(Math.max(0, m.index - 40), m.index);
        const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
        if (NEGATION_BEFORE.test(before) || NEGATION_AFTER.test(after) || /\b(?:not|no|without)\b/i.test(m[0])) continue;
        if (notAStatement?.(text, m.index, m[0])) continue;
        // The matched phrase itself, not a window: the sentence around it on a cover sheet is
        // the title block (homeowner name, address).
        return { source: s.label, excerpt: m[0].slice(0, 120) };
      }
    }
  }
  return null;
}

function affirmedEvidence(hit: Affirmed, label: string, note: string): ReviewerFindingEvidence {
  return {
    kind: hit.source === PARSED_FIELDS_SOURCE ? "field_value" : "source_excerpt",
    label,
    source: hit.source,
    excerpt: hit.excerpt,
    confidence: hit.source === PARSED_FIELDS_SOURCE ? "medium" : "high",
    pageHint: "",
    screenshotPath: "",
    verifier: hit.source === PARSED_FIELDS_SOURCE ? "parser" : "rule_engine",
    note,
  };
}

// IS THE ARRAY GOING ON A MANUFACTURED HOME?
//
// A coastal Oregon city bounced a roof-mounted design (2026-05-05): "The proposed installation
// is being placed on a manufactured home. Prescriptive code does not allow this as these
// structures are not conventionally designed to support any additional loads... revise the
// structural design to show how the new loads will be adequately transferred through the
// existing walls ... to the ground below (Cont. load path). R301.1.3 ORSC". Nothing in the
// package said so — the approved engineer letter later did ("HUD manufactured home", "2x2
// manufactured trusses @ 24\" o.c.") — and no intake field asks.
//
// "manufactur" is also the most common word on a plan set that is NOT about the house:
// "AS SHOWN IN MANUFACTURER DOCUMENTATION", "manufactured by", and "manufactured trusses" on
// an ordinary site-built roof. Those must never count. 2x2 trusses are the manufactured-home
// tell, so "2x2 manufactured trusses" does; "2x4 manufactured trusses" does not.
//
// SINGULAR NOUNS ONLY. A project is one house; "manufactured homes" / "mobile homes" is the
// generic plural of a disclaimer or a rule ("does not apply to mobile/manufactured homes",
// "NOT FOR INSTALLATION ON MOBILE HOMES", "excludes manufactured homes", "Manufactured homes
// require a separate evaluation") — each of which read as a BLOCKER before. "HUD standards" and
// "HUD-certified" are income-program words too, so HUD counts only with a housing word.
const MANUFACTURED_HOME_PATTERNS: RegExp[] = [
  /\bmanufactured\s+(?:home|dwelling|residence|house|housing\s+unit)\b/i,
  /\bmobile\s+(?:home|dwelling|residence)\b/i,
  /\b(?:single|double|triple)[-\s]?wide\s+(?:(?:manufactured|mobile)\s+)?(?:home|unit|trailer|dwelling)\b/i,
  /\bHUD[-\s]*(?:code\b|label|tag|data\s*plate|manufactured)/i,
  /\b24\s*CFR\s*(?:part\s*)?3280\b/i,
  /\b(?:home|HUD|dwelling)\s+data\s*plate\b/i,
  /\bdata\s*plate\s+(?:of|on|for)\s+(?:the\s+)?(?:home|dwelling|manufactured|mobile)\b/i,
  // "MH" is case-sensitive (a bare "MH" is also a manhole on a site plan); the dwelling word is
  // not — plan text is capitals, so "MH UNIT" / "MH HOME" must read like "MH unit".
  /\bMH\s+(?:[Hh][Oo][Mm][Ee]|[Uu][Nn][Ii][Tt]|[Dd][Ww][Ee][Ll][Ll][Ii][Nn][Gg]|[Pp][Aa][Rr][Kk])\b/,
  /\b2\s*["”]?\s*x\s*2\s*["”]?\s+(?:pre-?)?manufactured\s+truss/i,
];

// A MENTION IS NOT A STATEMENT ABOUT THIS HOUSE. Beyond the adjacent-negation reader shared with
// the other questions (affirmedIn), a manufactured-home phrase is skipped when its SENTENCE:
//   - denies applicability to it: "This letter does not apply to a manufactured home", "not for
//     installation on a mobile home", "not valid/approved/intended for ...", "excludes ..."
//     (unless the phrase is pinned to this house: "does not apply to THIS manufactured home");
//   - is a code or standard's TITLE: "2022 OREGON MANUFACTURED DWELLING AND PARK SPECIALTY CODE"
//     in a GOVERNING CODES block, "... CONSTRUCTION AND SAFETY STANDARDS";
//   - is a form: an unchecked box ("[ ] MANUFACTURED HOME [X] SITE BUILT"), or a question with
//     no answer or answered no ("... MANUFACTURED HOME OR MOBILE HOME (Y/N): N").
// The window is the sentence, not two words: that was how the disclaimers got through.
const SENTENCE_BREAK = /[.;!?]/;
// "not" + an applicability word, or "not for / not on / not to be". A bare "for" after a "not"
// is not enough: "engineered, not prescriptive, for a manufactured home" is a statement.
const APPLICABILITY_DENIED = /\b(?:not|never|nor)\b[^.;!?]{0,60}?\b(?:appl(?:y|ies|icable)|valid|approved|intended|use[ds]?|install(?:ed|ation)?|permitted|allowed|suitable|designed|rated)\b[^.;!?]*$|\bnot\s+(?:for|on|to\s+be)\b[^.;!?]*$|\bexclud\w*\b[^.;!?]*$|\bexcept(?:ing)?\b[^.;!?]*$/i;
const THIS_STRUCTURE = /(?:\b(?:this|the\s+subject|subject|the\s+existing|existing)|\(E\))\s*$/i;
// A title runs straight into its "CODE"/"STANDARDS" — "per" / "to" / "under" in between make it
// a sentence citing a code ("EXISTING MANUFACTURED HOME PER OREGON CODE"), which still counts.
const TITLE_AFTER = /^\s+(?:(?!(?:per|to|under|by|with|in|of|on)\b)[A-Za-z]+\s+){0,3}(?:specialty\s+)?(?:code|standards?|act|regulations?|program)\b/i;
// A form's box sits on one side of its label. A box BEFORE the phrase is this label's box
// ("[X] MANUFACTURED HOME [ ] SITE BUILT": the "[ ]" after belongs to SITE BUILT); only a label
// with no box before it takes the one after it ("MANUFACTURED HOME [ ]").
const BOX_BEFORE = /(\[\s*[xX✓✔]?\s*\]|[☐□☒☑■]|\(\s*[xX]?\s*\))\s*$/;
const UNCHECKED_BOX = /^(?:\[\s*\]|☐|□|\(\s*\))$/;
const UNCHECKED_AFTER = /^\s*(?:\[\s*\]|☐|□)/;
const QUESTION_AFTER = /^[^.;!]{0,60}?(\?|\(\s*y\s*\/\s*n\s*\))\s*:?\s*(?:(yes|y|no|n\/a|n)(?![a-z/]))?/i;

function notAboutThisStructure(text: string, index: number, matched: string): boolean {
  const lookback = text.slice(Math.max(0, index - 160), index);
  const breaks = [...lookback.matchAll(new RegExp(SENTENCE_BREAK.source, "g"))];
  const sentenceBefore = breaks.length ? lookback.slice(breaks[breaks.length - 1].index! + 1) : lookback;
  const after = text.slice(index + matched.length, index + matched.length + 120);
  if (APPLICABILITY_DENIED.test(sentenceBefore) && !THIS_STRUCTURE.test(sentenceBefore)) return true;
  if (TITLE_AFTER.test(after)) return true;
  const boxBefore = BOX_BEFORE.exec(sentenceBefore);
  if (boxBefore ? UNCHECKED_BOX.test(boxBefore[1].replace(/\s+/g, "")) : UNCHECKED_AFTER.test(after)) return true;
  const question = QUESTION_AFTER.exec(after);
  if (question) return !/^y(?:es)?$/i.test(question[2] || ""); // a question counts only when answered yes
  return false;
}

// THE STRUCTURE-TYPE FIELDS, in precedence order. The operator's intake answer
// (structureTypeOverride, written only by the dashboard — the parser never emits it, so a
// re-parse cannot clobber it) always wins; then the parser's own structureType; then the
// other names a structure-type field has carried. A short value is the answer itself.
const INTAKE_STRUCTURE_FIELD = "structureTypeOverride";
const STRUCTURE_TYPE_FIELDS = [INTAKE_STRUCTURE_FIELD, "structureType", "buildingType", "dwellingType", "homeType"];
const STRUCTURE_FIELD_MANUFACTURED = /^\s*(?:MH|HUD|manufactured|mobile|manufactured\s*[/-]?\s*mobile)(?:[-_\s]*(?:home|dwelling|housing))?\s*$/i;
const STRUCTURE_FIELD_SITE_BUILT = /^\s*(?:site|stick)[-_\s]?built(?:\s+(?:home|house|dwelling))?\s*$/i;
export const INTAKE_STRUCTURE_SOURCE = "Intake: structure type (operator)";

/** The one predicate: which structure carries the array, and how that is known. Rules read
 *  this, nothing else. */
export function structureType(project: ProjectRecord, extraTexts: DesignTextSource[] = []): StructureTypeFact {
  const fields: DesignTextSource[] = [];
  for (const key of STRUCTURE_TYPE_FIELDS) {
    const value = str(project, key);
    if (!value || /^\s*(?:unknown|not\s+sure|n\/a)\s*$/i.test(value)) continue;
    const source = key === INTAKE_STRUCTURE_FIELD ? INTAKE_STRUCTURE_SOURCE : PARSED_FIELDS_SOURCE;
    const excerpt = `${key}: ${value}`.slice(0, 80);
    if (STRUCTURE_FIELD_MANUFACTURED.test(value)) return { kind: "manufactured_home", basis: "stated", source, excerpt };
    // A STATED site-built answer is the answer: text inference does not override a human's (or
    // the parser's explicit) statement about the house.
    if (STRUCTURE_FIELD_SITE_BUILT.test(value)) return { kind: "site_built", basis: "stated", source, excerpt };
    fields.push({ label: PARSED_FIELDS_SOURCE, text: value });
  }
  // Parser fields that carry the parser's own reading of the house.
  for (const key of ["description", "framingType", "roofRafterSize"]) {
    const value = str(project, key);
    if (value) fields.push({ label: PARSED_FIELDS_SOURCE, text: value });
  }
  const hit = affirmedIn([...fields, ...packageTextSources(project, extraTexts)], MANUFACTURED_HOME_PATTERNS, notAboutThisStructure);
  return hit
    ? { kind: "manufactured_home", basis: "inferred", source: hit.source, excerpt: hit.excerpt }
    : { kind: "unknown", basis: "none", source: "", excerpt: "" };
}

export function structureTypeForProject(project: ProjectRecord): StructureTypeFact {
  return structureType(project);
}

// DOES THE ENGINEERING CARRY THE NEW LOAD TO THE GROUND? A load path must END somewhere: "load
// path to the rafters" is an attachment check, not a load path through the walls. And "ground"
// is not "ground snow" or "ground mount".
const FOUNDATION = String.raw`(?:foundations?|footings?|piers?|chassis|soil|ground(?!\s*(?:snow|-?\s*mount|fault)))`;
const LOAD_PATH_TO_FOUNDATION: RegExp[] = [
  new RegExp(String.raw`\bload\s+path\b[^.;]{0,100}?\b${FOUNDATION}\b`, "i"),
  new RegExp(String.raw`\b${FOUNDATION}\b[^.;]{0,60}?\bcontinuous\s+load\s+path\b`, "i"),
  new RegExp(String.raw`\b(?:roof\s+)?framing\b[^.;]{0,60}?\bthrough\b[^.;]{0,80}?\b${FOUNDATION}\b`, "i"),
  new RegExp(String.raw`\bloads?\b[^.;]{0,40}?\btransferr?(?:ed|ing|s)?\b[^.;]{0,80}?\bwalls?\b[^.;]{0,60}?\b${FOUNDATION}\b`, "i"),
];

// WHAT THE LISTING IS. The module listing is UL 61730 (or the legacy UL 1703); racking and
// mounting is UL 2703. UL 1741 (inverters) and UL 1699B (arc-fault) are listings too, and are
// on every plan set — which is exactly why a bare /UL\s*\d+/ would clear this for a package
// that shows neither.
export const MODULE_LISTING_PATTERNS: RegExp[] = [
  /\bUL\s*[-/]?\s*(?:IEC\s*)?61730\b/i,
  /\bIEC\s*\/\s*UL\s*61730\b/i,
  /\bUL\s*-?\s*1703\b/i,
];
export const RACKING_LISTING_PATTERNS: RegExp[] = [/\bUL\s*-?\s*2703\b/i];
export const INVERTER_LISTING_PATTERNS: RegExp[] = [/\bUL\s*1741\b/i];

// THE TEXT EACH ELECTRICAL RULE READS AS "SHOWN". Exported so requiredDocuments' sheet-content
// layer (SHEET_CONTENT_ELEMENTS) reads the same words these rules do — a second copy of any of
// them is how the advisory and the reviewer finding end up disagreeing about the same plan set.
/** city.elec.rapid-shutdown-missing: a rapid shutdown callout or equipment evidence. */
export const RAPID_SHUTDOWN_PATTERNS: RegExp[] = [/rapid shutdown/i, /\bRSD\b/i, /690\.12/i];
/** The NEC 705.10 power-source directory, by itself. */
export const POWER_SOURCE_DIRECTORY_PATTERNS: RegExp[] = [/directory/i, /705\.10/i];
/** city.elec.labels-missing: a PV label / placard schedule. */
export const LABEL_SCHEDULE_PATTERNS: RegExp[] = [/label/i, /placard/i, ...POWER_SOURCE_DIRECTORY_PATTERNS, /690\.12/i];
/** city.elec.load-side-calc-missing: the 705.12 busbar screen. */
export const LOAD_SIDE_CALC_PATTERNS: RegExp[] = [/705\.12/i, /120%|120 percent/i, /busbar/i, /bus bar/i];
/** city.elec.supply-side-detail-missing: what a tap detail actually contains. */
export const SUPPLY_SIDE_DETAIL_PATTERNS: RegExp[] = [
  /705\.11/i,
  /tap\s*(?:point|detail|conductor)/i,
  /service\s*(?:entrance\s*)?conductor/i,
  /fused\s*disconnect/i,
  /line.?side\s*(?:tap|connection)\s*detail/i,
  /supply.?side\s*(?:tap|connection)\s*detail/i,
];

// --- Edition-keyed evidence (issue #143; the table is necEditions.ts) ---------------------------

const rapidShutdownLabel: CodeReference = {
  code: "NEC",
  section: "690.56(C)",
  title: "Rapid shutdown identification",
  adoptionScope: "Buildings with PV rapid shutdown, per the adopted NEC edition.",
  sourceUrl: "",
  note: "The label wording and the switch marking follow the adopted edition.",
};

/** 690.12(B)(2) (2017+): HOW the inside-the-array-boundary requirement is met — a listed PV hazard
 *  control system, or rapid shutdown equipment stated as listed. A bare "rapid shutdown" is not it. */
export const RSD_LISTED_EQUIPMENT_PATTERNS: RegExp[] = [
  /\bPV\s*hazard\s*control/i,
  /\bPVHCS\b/i,
  /\bUL\s*3741\b/i,
  /\bPVRS[ES]\b/i,
  // Not "(B)(2)(3)": that is the no-exposed-wiring option, not listed equipment (#242). It answers
  // the gap only where the edition still has it (RSD_NO_EXPOSED_WIRING_CITATION below).
  /690\.12\s*\(\s*B\s*\)\s*\(\s*2\s*\)(?!\s*\(\s*3\s*\))/i,
  /\blisted\b[^.;\n]{0,40}\b(?:rapid\s*shutdown|RSD)\b/i,
  /\b(?:rapid\s*shutdown|RSD)\b[^.;\n]{0,40}\blisted\b/i,
];
/** The 2017/2020 690.12(B)(2)(3) citation — the "no exposed wiring methods or conductive parts"
 *  option the 2023 NEC deleted (necEditions' `noExposedWiringOption`). Only the citation itself: a
 *  general "no exposed wiring" note (attic, EMT, a city handout) is not the option (Helm review). */
const RSD_NO_EXPOSED_WIRING_CITATION = /690\.12\s*\(\s*B\s*\)\s*\(\s*2\s*\)\s*\(\s*3\s*\)/i;
/** The option's own title after its citation ("690.12(B)(2)(3) NO EXPOSED WIRING METHODS") is part
 *  of the citation — dropped before the negation read, or its "NO" would read as rejecting it. What
 *  follows the title ("- NOT USED", "N/A") still decides (#242). */
const RSD_OPTION_TITLE = /(690\.12\s*\(\s*B\s*\)\s*\(\s*2\s*\)\s*\(\s*3\s*\))\s*[-\u2013\u2014:]?\s*no\s+exposed\s+(?:wiring(?:\s+methods)?|conductive\s+parts)(?:\s+(?:or|and|,)\s*(?:wiring(?:\s+methods)?|conductive\s+parts))?/gi;
function withoutRsdOptionTitle(sources: DesignTextSource[]): DesignTextSource[] {
  return sources.map((s) => ({ ...s, text: String(s.text || "").replace(RSD_OPTION_TITLE, "$1") }));
}
/** city.ess.details-missing's trigger: a mention of storage scope. */
const ESS_TRIGGER_PATTERNS: RegExp[] = [/battery/i, /\bESS\b/i, /powerwall/i, /encharge/i, /backup/i];
const STORAGE_WORD = String.raw`(?:batter(?:y|ies)|ESS|backup|powerwall|encharge|energy\s+storage(?:\s+system)?|storage)`;
const STORAGE_RUN_THEN_DENIAL = new RegExp(String.raw`^(?:\s*(?:\/|&|,|\+|and|or)?\s*${STORAGE_WORD}\b)*\s*\)?\s*[?:\u2013\u2014-]?\s*(?:no|none|n\/a|not\s+(?:used|applicable|included|proposed|provided))\b`, "i");
const DENIAL_THEN_STORAGE_RUN = new RegExp(String.raw`\b(?:no|without)\s+(?:${STORAGE_WORD}\s*(?:\/|&|,|\+|and|or)\s*)+$`, "i");
/** "BATTERY / ESS: NONE", "(BATTERY BACKUP): NOT USED": the denial sits after the next storage
 *  word (or its closing parenthesis), past NEGATION_AFTER's reach. */
const essMentionDenied: MentionGuard = (text, index, matched) =>
  STORAGE_RUN_THEN_DENIAL.test(text.slice(index + matched.length, index + matched.length + 60))
  || DENIAL_THEN_STORAGE_RUN.test(text.slice(Math.max(0, index - 60), index));
/** 690.12(C) (2017+): where the initiation device is. */
export const RSD_INITIATION_PATTERNS: RegExp[] = [
  /\binitiat(?:ion|ing|or)\b/i,
  /\b(?:rapid\s*shutdown|RSD)\s*(?:switch|initiator|button)\b/i,
  /690\.12\s*\(\s*C\s*\)/i,
];
const SPEC_SHEET_SOURCE = /\bspec(?:ification)?s?\s*sheet|\bdata\s*sheet|\bcut\s*sheet/i;
const STAND_ALONE = /\boff.?grid\b|\bstand.?alone\s+(?:system|PV|solar)/i;

/** The marker projectDocuments stores for a PDF with no text layer — nothing was read from it. */
function readableDocumentText(text: unknown): boolean {
  const t = String(text ?? "").trim();
  return t !== "" && t !== "[no text layer]";
}

/** A microinverter design has no DC PV source circuits to label beyond the module leads. */
function isMicroinverterDesign(project: ProjectRecord, allText: string): boolean {
  if (str(project, "pvMicroModel") || str(project, "pvMicroQty")) return true;
  const inverter = [str(project, "invModel"), str(project, "inverterModel")].filter(Boolean).join("\n");
  if (inverter.trim()) return /micro.?inverter|hoymiles|apsystems/i.test(inverter) || ENPHASE_MICRO.test(inverter);
  return /micro.?inverter/i.test(allText);
}

/** A table cell taken from secondary sources and not yet checked against the edition's text. */
function isUnconfirmed(nec: NecEditionRequirements, cell: string): boolean {
  return Boolean(nec.unconfirmed?.includes(cell));
}
/** Said in the finding wherever it rests on such a cell, so a reader knows to check the code. */
function unconfirmedNote(nec: NecEditionRequirements, cells: string[]): string {
  return cells.some((c) => isUnconfirmed(nec, c)) ? ` (per secondary sources; not yet confirmed against the NFPA 70-${nec.edition} text)` : "";
}

function necRapidShutdownEvidence(nec: NecEditionRequirements, mlpe: boolean): string[] {
  const rs = nec.rapidShutdown;
  return [
    mlpe ? `${rs.article} module-level shutdown note (MLPE listing)` : `RSD device or inverter listing basis (${rs.article})`,
    ...(rs.insideBoundaryArticle ? [`Inside-array-boundary basis: listed PV hazard control system or listed RSD equipment (${rs.insideBoundaryArticle})`] : []),
    ...(rs.initiationDeviceArticle ? [`Initiation device location (${rs.initiationDeviceArticle})`] : [`RSD initiation/control location`]),
    `Rapid shutdown label "${nec.labels.rapidShutdownWording}" (${nec.labels.rapidShutdown})`,
    `NEC ${nec.edition} code-cycle note`,
  ];
}

interface NecLabelRequirement {
  label: string;
  section: string;
  wording?: string;
  patterns: RegExp[];
}

/** A cited section as written on a sheet: "690.12(D)" also matches "690.12 (D)". */
function sectionPattern(section: string): RegExp {
  return new RegExp(section.replace(/\./g, "\\.").replace(/\(/g, "\\s*\\(\\s*").replace(/\)/g, "\\s*\\)"), "i");
}

/** The labels the edition names that apply to this design. A null cell is skipped, not guessed. */
function necLabelRequirements(nec: NecEditionRequirements, opts: { rsdApplies: boolean; standAlone: boolean; dcCircuits: boolean }): NecLabelRequirement[] {
  const l = nec.labels;
  const out: NecLabelRequirement[] = [];
  if (opts.rsdApplies) {
    out.push({
      label: "Rapid shutdown label", section: l.rapidShutdown, wording: l.rapidShutdownWording,
      // The 690.56(C) PLACARD, not the device: "rapid shutdown switch" names the initiation
      // device (690.12(C)) and must not satisfy the label.
      // The edition's own label section counts too (2023 moved it to 690.12(D), #215).
      patterns: [/equipped\s+with\s+rapid\s+shutdown/i, /690\.56\s*\(\s*C\s*\)/i, /\b(?:rapid\s*shutdown|RSD)\s*(?:label|placard|sign)\b/i,
        ...(l.rapidShutdown !== "690.56(C)" ? [sectionPattern(l.rapidShutdown)] : [])],
    });
  }
  out.push({ label: "Power-source directory", section: l.powerSourceDirectory, patterns: POWER_SOURCE_DIRECTORY_PATTERNS });
  if (l.disconnect) out.push({ label: "PV system disconnect marking", section: l.disconnect, wording: "PV SYSTEM DISCONNECT", patterns: [/PV\s+system\s+disconnect/i, /690\.13/i] });
  if (l.pointOfInterconnection) {
    out.push({
      label: "Point-of-interconnection label (rated AC output current, nominal AC voltage)", section: l.pointOfInterconnection,
      patterns: [/690\.54/i, /\bAC\s+output\s+current\b/i, /\bnominal\s+(?:operating\s+)?AC\s+voltage\b/i],
    });
  }
  if (l.dcSource && opts.dcCircuits) {
    out.push({
      label: "DC PV circuit label (maximum DC voltage)", section: l.dcSource,
      patterns: [/690\.53/i, /\bmax(?:imum|\.)?\s+(?:DC\s+)?(?:system\s+)?voltage\b/i, /\bDC\s+PV\s+(?:source|circuit)/i],
    });
  }
  if (l.standAloneDirectory && opts.standAlone) {
    out.push({ label: "Stand-alone system power-source plaque", section: l.standAloneDirectory, patterns: [/710\.10/i, /\bstand.?alone\b[^.;]{0,40}\b(?:plaque|directory)\b/i] });
  }
  return out;
}

const engineeredDesign: CodeReference = {
  code: "IRC / ORSC",
  section: "R301.1.3",
  title: "Engineered design",
  adoptionScope: "One- and two-family residential; verify the locally adopted edition.",
  sourceUrl: "https://codes.iccsafe.org/content/IRC2021P1/chapter-3-building-planning",
  note: "Construction outside the prescriptive provisions is designed by accepted engineering practice. A manufactured home is not conventional light-frame construction.",
};

const equipmentListings: CodeReference = {
  code: "IRC / ORSC",
  section: "R324.3.1",
  title: "Equipment listings",
  adoptionScope: "Residential rooftop PV; verify the locally adopted edition.",
  sourceUrl: "https://codes.iccsafe.org/content/IRC2021P1/chapter-3-building-planning",
  note: "PV modules are listed and labeled to UL 61730 (or UL 1703); rack mounting systems are listed to UL 2703 where the adopted code or the AHJ requires it.",
};

function finding(input: {
  id: string;
  severity: ReviewerFinding["severity"];
  category: ReviewerFinding["category"];
  title: string;
  message: string;
  cityFeedback: string;
  designTeamAction: string;
  evidenceNeeded: string[];
  codeReferences: CodeReference[];
  installerCallout?: boolean;
}): ReviewerFinding {
  return {
    id: input.id,
    severity: input.severity,
    category: input.category,
    title: input.title,
    message: input.message,
    cityFeedback: input.cityFeedback,
    designTeamAction: input.designTeamAction,
    evidenceNeeded: input.evidenceNeeded,
    codeReferences: input.codeReferences,
    installerCallout: input.installerCallout ?? true,
  };
}

/**
 * Documents that ARE the stamped engineering. `structural` is deliberately absent: that is
 * the framing sheet out of the plan set, which is what a design HAS while still owing the
 * jurisdiction a sealed calculation. Bren Trask's Portland package carried `structural` and
 * a plan set naming a Vector Structural Engineering review block, and Portland still
 * demanded calculations — because none had been attached.
 */
const STAMPED_ENGINEERING_DOC_TYPES = ["structural_letter", "stamped_plans", "engineering_letter"];

export function evaluateDesignCodeFindings(
  project: ProjectRecord,
  profile: AhjProcessProfile | null,
  ctx?: EffectiveCodeContext,
  uploadedDocTypes: string[] = [],
  /** Per-document text (one source per uploaded document), so a design-criteria conflict
   *  can name "plan set vs engineer's letter" rather than one merged text blob. */
  documentTexts: DesignTextSource[] = [],
): ReviewerFinding[] {
  const out: ReviewerFinding[] = [];
  const all = designText(project);
  // A STAMP IS A DOCUMENT, NOT A SENTENCE ABOUT ONE.
  const hasStampedEngineering = uploadedDocTypes.some((t) => STAMPED_ENGINEERING_DOC_TYPES.includes(String(t)));
  const roofMounted = isRoofMounted(project, all);
  const rsdApplies = rapidShutdownApplies(project, all);
  const oregon = isOregon(project, profile);
  // "NON-PRESCRIPTIVE" CONTAINS "PRESCRIPTIVE". A bare substring test therefore read an
  // explicitly engineered project as a prescriptive one and inverted the structural gate:
  // measured, permitPath "Non-prescriptive" produced the prescriptive blockers (span table,
  // loads) and — the dangerous half — did NOT raise city.struct.stamped-engineering-missing,
  // while "Engineered" correctly did. So a project flagged non-prescriptive was never asked
  // for the stamped engineering it needs.
  //
  // That is not a hypothetical wording: the operator's standing ruling is that a PV install on
  // a TPO roof in Oregon is automatically non-prescriptive, and those are exactly the jobs that
  // had to get stamps. permitPath.ts already classifies this correctly — it tests the
  // non-/engineered wording BEFORE the prescriptive substring — so use it rather than keeping a
  // second, wrong opinion here.
  const prescriptive = pathWordingScope(str(project, "permitPath")) === "prescriptive";

  // JURISDICTION CONTEXT (data-driven rules). With a context, prescriptive structural
  // screening applies wherever the jurisdiction records prescriptive limits — not just
  // Oregon — and citations render the jurisdiction's ADOPTED code editions. Without a
  // context the legacy behavior is preserved exactly (Oregon regex + the hardcoded
  // constants), which is what the Oregon golden test pins.
  const prescriptiveScreening = ctx
    // A minimum ground snow load is a floor for every design, not a prescriptive screening limit.
    ? Object.entries(ctx.prescriptive).some(([k, v]) => !/^minGroundSnow/.test(k) && v != null && (!Array.isArray(v) || v.length > 0))
    : oregon;
  // Threshold-style findings from a SEEDED (unverified) profile must not hard-block —
  // the data hasn't been human-confirmed against official sources yet.
  const screeningSeverity: ReviewerFinding["severity"] = prescriptive && (ctx ? ctx.verified : true) ? "blocker" : "warning";
  // Citation resolver: jurisdiction-adopted edition when a context is present, the
  // legacy constant otherwise (or when the family isn't in the adopted list).
  const cite = (code: string, fallback: CodeReference): CodeReference =>
    ctx ? ctx.citationFor(code, fallback.section, fallback.title, fallback) : fallback;
  // THE ADOPTED NEC EDITION (issue #143). Read only from a profile that records editions: the model
  // defaults buildCodeContext falls back to (NEC 2023) are placeholders, not the jurisdiction's
  // adoption, so a default context is "edition unknown" exactly like no context. Known → the RSD,
  // label and interconnection rules cite that edition's article and ask for its evidence; unknown
  // → the generic rules below, unchanged, plus one callout naming the gap (context present only).
  const necAdopted = ctx?.profile?.adoptedCodes?.length ? adoptedNecEdition(ctx.adoptedCodes) : null;
  const nec = necEditionRequirements(necAdopted);
  // The edition's own section where the table states one; a null cell keeps the generic citation.
  const necRef = (section: string | null | undefined, fallback: CodeReference): CodeReference =>
    ctx && nec && section ? ctx.citationFor("NEC", section, fallback.title, { ...fallback, section }) : cite("NEC", fallback);
  const electricalRef = cite("NEC", oregonElectrical2023);
  const rapidShutdownRef = necRef(nec?.rapidShutdown.article, rapidShutdown);
  const powerSourceDirectoryRef = necRef(nec?.labels.powerSourceDirectory, powerSourceDirectory);
  const loadSideRef = necRef(nec?.interconnection.loadSide, loadSideInterconnection);
  const supplySideRef = necRef(nec?.interconnection.supplySide, supplySideInterconnection);
  // The section numbers the interconnection messages print. Unknown edition: today's wording.
  const supplyArt = nec?.interconnection.supplySide ?? "705.11";
  const busbarArt = nec ? (nec.interconnection.busbar120 ?? nec.interconnection.loadSide) : "705.12(B)(3)(2)";
  const loadArt = nec?.interconnection.loadSide ?? "705.12";
  // The roof-loads section is a RESIDENTIAL-code section: cite it under the jurisdiction's own
  // residential code (ORSC / CRC / FBC-R …) where the numbering is known to match, else the IRC's
  // number with an "unmapped" note — never "2023 IRC" for an ORSC row filed under the IRC token, and
  // never the legacy "IRC / ORSC" label in California or Florida. No context: the legacy constant.
  const roofLoadsRef = ctx ? residentialCodeRef(ctx, roofLoads.section, roofLoads.title, roofLoads.note) : roofLoads;
  const roofAccessRef = cite("IRC", roofAccess);
  const fireAccessRef = cite("IFC", fireAccess);
  const essRef = cite("NEC", essReference);
  // Oregon-specific prescriptive worksheet refs only make sense where the ORSC/OSSC
  // (or legacy Oregon detection) applies — never cite them at an Idaho county.
  const oregonWorksheetRefs: CodeReference[] = (ctx ? ctx.adoptedCodes.some((c) => /^(ORSC|OSSC|OESC)$/i.test(c.code)) : oregon)
    ? [oregonPrescriptive, portlandRafterSpan]
    : [];

  // The evidence topic's own predicate (projectEvidence.packageShowsSld): this rule's private
  // list lacked "one-line" and fired a blocker on a package the evidence called SLD-present/high.
  if (!packageShowsSld(project)) {
    out.push(finding({
      id: "city.plan.sld-missing",
      severity: "blocker",
      category: "electrical",
      title: "Electrical one-line not reviewable",
      message: "The package does not clearly map an SLD/one-line/three-line diagram.",
      cityFeedback: "Provide a complete electrical one-line diagram showing modules, inverter(s), rapid shutdown equipment, disconnects, point of interconnection, service equipment ratings, grounding/bonding path, and utility meter/service relationship.",
      designTeamAction: "Add or remap the SLD sheet and verify it matches the equipment schedule and interconnection method.",
      evidenceNeeded: ["SLD/one-line sheet number", "Point of interconnection detail", "Disconnect/OCPD schedule", "Grounding/bonding callouts"],
      codeReferences: [electricalRef, loadSideRef, supplySideRef],
    }));
  }

  if (roofMounted && !hasAny(all, [/site.plan/i, /plot.plan/i, /roof.plan/i, /\bPV layout\b/i])) {
    out.push(finding({
      id: "city.plan.site-roof-missing",
      severity: "blocker",
      category: "plan_set",
      title: "Site/roof plan not reviewable",
      message: "The package does not clearly map a site plan, plot plan, roof plan, or PV layout sheet.",
      cityFeedback: "Provide a site/roof plan showing array location, roof planes, ridge/eave/valley/hip locations, roof obstructions, access pathway dimensions, service equipment location, and equipment layout.",
      designTeamAction: "Add a roof/site plan sheet or correct the split-page mapping so the reviewer can verify layout and fire access.",
      evidenceNeeded: ["Roof/site plan sheet number", "Array dimensions and roof plane labels", "Service equipment and disconnect locations", "Obstructions and access path dimensions"],
      codeReferences: [roofAccessRef, fireAccessRef],
    }));
  }

  // Same vocabulary as projectEvidence's firePathway topic, imported rather than restated.
  // The old list here accepted a bare "setback" or "ridge" — ordinary zoning and roof-geometry
  // words — so this rule cleared on any plan set too, in step with the evidence topic. Letting
  // the two drift apart is how the gate ends up contradicting itself about the same project.
  //
  // MEASURED FIRST (issue #142): the plan's stated pathway widths and ridge setback against the
  // jurisdiction's fireSetbacks, else the adopted edition's model-code default. The word list
  // below is now only the fallback, for a plan with no pathway text AND no readable dimension.
  const fire = ctx ? evaluateFirePathwayFindings(project, ctx, { roofMounted, extraTexts: documentTexts }) : { findings: [], measured: false };
  out.push(...fire.findings);
  if (roofMounted && !fire.measured && !hasAny(all, FIRE_PATHWAY_PATTERNS)) {
    out.push(finding({
      id: "city.fire.pathways-missing",
      severity: "blocker",
      category: "plan_set",
      title: "Fire access pathway evidence missing",
      message: "No fire access pathway/setback evidence was detected in the mapped plan package.",
      cityFeedback: "Revise the roof plan to show firefighter access pathways, ridge/eave setbacks, smoke ventilation areas where required, and any applicable exception basis. Dimensions must be shown on the plan, not only stated in notes.",
      designTeamAction: "Add pathway dimensions and exception notes to the roof plan; confirm local fire-code amendments for the AHJ.",
      evidenceNeeded: ["Dimensioned pathway/setback callouts", "Ridge/eave/valley/hip labels", "Applicable fire-code exception, if used"],
      codeReferences: [roofAccessRef, fireAccessRef],
    }));
  }

  // /structural/i and /engineer/i cleared this, and title blocks carry both — so "STRUCTURAL
  // ENGINEER OF RECORD: SMITH PE" was accepted as framing evidence. Worse, the sentence "NO
  // STRUCTURAL FRAMING INFORMATION WAS AVAILABLE" also contains "structural", so the report
  // cleared itself on a statement of its own ignorance. Ask for MEMBERS.
  if (roofMounted && !hasAny(all, [
    /\brafter/i, /\btruss/i, /\bjoist/i,
    /span\s*table/i,
    /\d+\s*x\s*\d+\s*(?:@|at\b|o\.?c\.?)/i,
    /o\.?c\.?\s*spacing/i,
    /framing\s*(?:member|type|plan|detail|size)/i,
  ])) {
    out.push(finding({
      id: "city.struct.framing-missing",
      severity: "blocker",
      category: "structural",
      title: "Roof framing information missing",
      message: "The plan package does not show enough roof framing information for structural review.",
      cityFeedback: "Provide roof framing type and member information: rafter/truss type, member size, spacing, span, species/grade when applicable, roof slope, sheathing, array attachment locations, and whether the design uses a prescriptive or engineered path.",
      designTeamAction: "Add structural/framing notes or a stamped structural letter/calculation package.",
      evidenceNeeded: ["Rafter/truss size and spacing", "Clear span/support condition", "Roof slope", "Prescriptive worksheet or stamped structural calculation"],
      codeReferences: prescriptiveScreening ? [roofLoadsRef, ...oregonWorksheetRefs] : [roofLoadsRef],
    }));
  }

  const rafterSpacing = num(project, ["roofRafterSpacing", "rafterSpacing"]);
  const rafterSpan = num(project, ["roofRafterSpan", "rafterSpan"]);

  // THE DESIGN LEANS ON ENGINEERING IT HAS NOT ATTACHED.
  //
  // Portland bounced Bren Trask (26-033226-000-00-RS) on the roof: "Roof is overspanned. In
  // the prescriptive span tables, 2x4 rafters can span roughly half the distance that is
  // shown in the drawings... Unsupported intermediate brace or collar tie do not alter span
  // length of rafter. Please provide engineering calculations to show that roof structure is
  // adequate to support proposed system."
  //
  // Everything needed to see that coming was on file. permitPath was "engineered", the plan
  // set named a Vector Structural Engineering review block, the framing sheets showed 2x4
  // rafters at 24" o.c. — and no sealed calculation was ever attached. A design that
  // declares itself engineered owes the jurisdiction the stamp; strict AHJs (Portland
  // emphatically, and it is not alone) will not approve on the reference alone.
  //
  // Worse, that same reference used to SILENCE the span warning below, because the old
  // suppression matched the word "engineer" anywhere in the design text. A plan set that
  // merely mentioned engineering muted the one check that would have caught the overspan.
  // Same classifier as the prescriptive flag above, so the two cannot disagree about one
  // project. /engineer/i alone missed "Non-prescriptive" — the operator's own wording for a
  // TPO-roof job — which is exactly the case that needs a stamp. pathWordingScope reads that
  // as engineered; the plan-text signals below stay as the independent second route in.
  // B8(a): ONE PREDICATE WITH permitPath. On City of Jefferson this fired "Engineered design with no
  // stamped calculation" while the path had RESOLVED prescriptive — the text signals matched the
  // parser's own NEGATIVE sentences ("No PE stamp or sealed structural letter present"). A path the
  // shared resolver decided is the answer; the text signals speak only while it is undecided.
  const resolvedPath = resolvePermitPath(project).path;
  // The resolver only SUPPRESSES here (a resolved-prescriptive path owes no stamp); what raises the
  // finding is unchanged — the path wording or the plan's own engineering signals.
  const claimsEngineered = resolvedPath !== "prescriptive" && (
    pathWordingScope(str(project, "permitPath")) === "engineered"
    || hasAny(all, [/stamped structural/i, /structural letter/i, /sealed by/i, /\bP\.?E\.?\b/, /engineering (calc|letter|review|analysis)/i]));
  if (roofMounted && claimsEngineered && !hasStampedEngineering) {
    out.push(finding({
      id: "city.struct.stamped-engineering-missing",
      // The design DEPENDS on it when it declares the engineered path — that is a blocker,
      // not a note. A passing reference in an otherwise prescriptive package is a warning.
      // Read the PATH through the shared classifier: /engineer/i was a third independent
      // opinion about the same question and it did not recognise "Non-prescriptive", so the
      // operator's own wording for a TPO job produced a warning where it owed a blocker.
      severity: pathWordingScope(str(project, "permitPath")) === "engineered" ? "blocker" : "warning",
      category: "structural",
      title: "Engineered design with no stamped calculation attached",
      message: "The design relies on structural engineering, but no stamped/sealed engineering document is in the package.",
      cityFeedback: "Provide the wet- or digitally-stamped structural calculations or engineer's letter covering rafter size, spacing, clear span, and the PV attachment/point loads for this roof.",
      designTeamAction: "Obtain the sealed calculation package from the engineer of record before submittal — a review-block reference on the plan set is not the stamp, and strict jurisdictions (Portland among them) will issue a correction for it.",
      evidenceNeeded: ["Stamped/sealed structural calculation or engineer's letter", "Rafter size, spacing and clear span used in the calculation", "PV dead load and attachment point loads"],
      codeReferences: [...oregonWorksheetRefs, roofLoadsRef],
    }));
  }

  // TRUSSES HAVE NO SPAN-TABLE DEMAND. The state's own prescriptive screen (BCD 5952,
  // encoded in bcdChecklistFacts) splits framing into two arms: the TRUSS arm asks for
  // framing type + spacing <= 24" — trusses are pre-engineered components — while clear
  // span (+ the rafter exception) belongs only to the RAFTER arm. This rule used to
  // demand span for both, which blocked Brittany Reavis's 2x4 truss @ 24" o.c. roof —
  // the exact roof Salem issued 26-108868-DW for, prescriptive, no span table anywhere.
  // Rafters keep the full demand: Portland bounced Trask for precisely that overspan.
  // ONLY AN UNAMBIGUOUS TRUSS EARNS THE EXEMPTION. A bare /truss/i opened it for
  // "rafter/truss", "truss or rafter (unverified)" and even "not truss" — dropping the very
  // clear-span demand that caught the overspan Portland bounced Trask for. Ambiguity keeps the
  // full demand, because the stricter arm is the safe one to land on when the framing is
  // genuinely unclear.
  const framingTypeText = str(project, "framingType");
  const trussFraming = /\btruss(?:es)?\b/i.test(framingTypeText)
    && !/\brafter/i.test(framingTypeText)
    && !/\bno[nt]?[-\s]?truss|not\s+a?\s*truss/i.test(framingTypeText);
  const spanEvidenceIncomplete = trussFraming
    ? rafterSpacing == null
    : rafterSpacing == null || rafterSpan == null;

  // Suppression now requires the DOCUMENT, not a mention of one — see above.
  if (roofMounted && prescriptiveScreening && !hasStampedEngineering && spanEvidenceIncomplete) {
    out.push(finding({
      id: "city.struct.span-table-incomplete",
      severity: screeningSeverity,
      category: "structural",
      title: "Prescriptive rafter span evidence incomplete",
      message: ctx && !oregon
        ? `${ctx.ahj || ctx.state} prescriptive review needs rafter/truss spacing and span evidence or an engineered alternate path.`
        : "Oregon-style prescriptive review needs rafter/truss spacing and span evidence or an engineered alternate path.",
      cityFeedback: "Provide the prescriptive rooftop PV checklist/worksheet information, including framing member size, spacing, span, species/grade, roof slope, dead load, snow load, and wind exposure. If this cannot be documented, provide stamped engineering.",
      designTeamAction: "Complete the structural worksheet inputs or route the design to engineered review.",
      evidenceNeeded: ["Framing spacing", "Framing clear span", "Species/grade or engineered truss evidence", "Dead load, snow load, wind exposure"],
      codeReferences: [...oregonWorksheetRefs, roofLoadsRef],
    }));
  }

  // /mount/i CLEARED THIS, and every plan set says "roof mount". Measured on the live book:
  // projects carrying no extracted plan text at all passed this screen, because their
  // `mounting` FIELD reads "Roof mount". /rail/i was satisfied by a guardrail and /lag/i by
  // any word containing those three letters. Ask instead for what an attachment detail
  // actually contains.
  if (roofMounted && !hasAny(all, [
    /attachment\s*(?:detail|schedule|spacing|point)/i,
    /standoff/i, /flashing/i, /flashfoot/i, /l.?foot/i,
    /lag\s*(?:screw|bolt)/i, /fastener/i, /embedment/i, /pull.?out/i,
    /racking\s*(?:detail|spec|schedule|plan)/i,
    /mount(?:ing)?\s*(?:detail|hardware|spacing|schedule)/i,
  ])) {
    out.push(finding({
      id: "city.struct.attachment-detail-missing",
      severity: "blocker",
      category: "structural",
      title: "Racking/attachment detail missing",
      message: "The package does not show enough racking attachment and waterproofing detail.",
      cityFeedback: "Provide racking manufacturer, attachment type, attachment spacing, fastener embedment, flashing/waterproofing method, uplift/downforce basis, and roof attachment detail tied to the framing members.",
      designTeamAction: "Add the racking attachment detail and manufacturer spec sheet or engineering table used for spacing.",
      evidenceNeeded: ["Racking/attachment detail", "Attachment spacing table", "Fastener/embedment callout", "Flashing/waterproofing note"],
      codeReferences: [roofLoadsRef],
    }));
  }

  // TILE ROOFS (roofCovering.ts is the one predicate). A tile roof is attached differently
  // (tile hook / tile-replacement mount / comp-out), leaks differently (the flashing detail is the
  // tile's, not a comp flashing), and weighs 9-12 psf where composition weighs 2-4 — so a calc
  // carrying a shingle roof's dead load under-reads the framing. Each finding quotes what the
  // package says; none fires on a composition, metal or membrane roof.
  const covering = classifyRoofCovering(str(project, "roofMaterial"), str(project, "roofMaterialSubtype"));
  if (roofMounted && covering.family === "tile") {
    const roofLabel = `${str(project, "roofMaterial")}${covering.subtype && !str(project, "roofMaterial").toLowerCase().includes(covering.subtype.toLowerCase()) ? ` (${covering.subtype})` : ""}`;
    const parsedMethod = tileAttachmentMethodOf(str(project, "tileAttachmentMethod"));
    const textMethods = tileAttachmentFromText(all);
    const distinctText = [...new Set(textMethods.map((m) => m.method))];
    if (!parsedMethod && distinctText.length !== 1) {
      out.push(finding({
        id: "city.struct.tile-attachment-missing",
        severity: distinctText.length === 0 ? "blocker" : "warning",
        category: "structural",
        title: distinctText.length === 0 ? "Tile roof with no tile attachment method" : "Tile attachment method ambiguous",
        message: distinctText.length === 0
          ? `The roof is ${roofLabel}, but no tile attachment method (tile hook, tile-replacement mount, or comp-out) is named anywhere in the package.`
          : `The roof is ${roofLabel}, and the package names more than one tile attachment method: ${textMethods.map((m) => `${m.method} ("${m.quote}")`).join("; ")}.`,
        cityFeedback: "Identify the attachment listed for tile roofs (tile hook, tile-replacement mount/flashing, or comp-out), with the manufacturer detail showing how the tile is cut/replaced and flashed.",
        designTeamAction: "Add the tile attachment detail and its manufacturer spec sheet; name one method per roof plane.",
        evidenceNeeded: ["Tile attachment detail (hook / replacement mount / comp-out)", "Attachment manufacturer spec sheet listing tile roofs", "Flashing detail for the tile attachment"],
        codeReferences: [roofLoadsRef],
      }));
    }
    const method = parsedMethod || (distinctText.length === 1 ? distinctText[0] : "");
    if (method && !/\bflash(?:ing|ings|ed|foot)?\b/i.test(all)) {
      out.push(finding({
        id: "city.struct.tile-flashing-missing",
        severity: "warning",
        category: "structural",
        title: "Tile attachment flashing detail not shown",
        message: `The roof is ${roofLabel} with a ${method} attachment, but the package shows no flashing/waterproofing detail for it.`,
        cityFeedback: `Provide the flashing/waterproofing detail for the ${method} on the ${roofLabel} roof (under-tile flashing, replacement-tile flashing, or the comp-out patch flashing).`,
        designTeamAction: "Add the manufacturer's flashing detail for the tile attachment to the attachment sheet.",
        evidenceNeeded: ["Tile attachment flashing detail"],
        codeReferences: [roofLoadsRef],
      }));
    }
    const statedDl = statedRoofDeadLoads(all);
    const light = statedDl.filter((d) => d.psf < TILE_MIN_ROOF_DEAD_LOAD_PSF);
    if (statedDl.length === 0 || light.length === statedDl.length) {
      out.push(finding({
        id: "city.struct.tile-dead-load",
        severity: "warning",
        category: "structural",
        title: statedDl.length === 0 ? "Roof dead load for the tile not stated" : "Roof dead load reads like a shingle roof",
        message: statedDl.length === 0
          ? `The roof is ${roofLabel} (tile weighs roughly ${TILE_MIN_ROOF_DEAD_LOAD_PSF}-12 psf), and no roof dead load including the tile is stated in the package.`
          : `The roof is ${roofLabel}, but the stated roof dead load ${light.map((d) => `${d.psf} psf ("${d.quote}")`).join("; ")} is below the roughly ${TILE_MIN_ROOF_DEAD_LOAD_PSF}-12 psf a tile covering alone weighs.`,
        cityFeedback: "State the existing roof dead load including the tile covering in the structural calculation, and show the framing carries it plus the PV dead load.",
        designTeamAction: "Update the structural calculation / letter to include the tile weight in the roof dead load.",
        evidenceNeeded: ["Roof dead load including tile (psf)", "PV dead load (psf)", "Framing check with both"],
        codeReferences: [roofLoadsRef],
      }));
    }
    const needsStamp = resolvePermitPath(project).needsEngineeredDocs;
    if (needsStamp && !hasStampedEngineering && !out.some((f) => f.id === "city.struct.stamped-engineering-missing")) {
      out.push(finding({
        id: "city.struct.tile-stamped-engineering-missing",
        severity: "blocker",
        category: "structural",
        title: "Tile roof on the engineered path with no stamped engineering",
        message: `The roof is ${roofLabel}; ${project.state.toUpperCase() === "OR" ? "Oregon's prescriptive roofing row does not admit tile, so" : "the resolved permit path is engineered, so"} the job files the engineered/structural application and needs a stamped structural calculation — none is in the package.`,
        cityFeedback: "Provide the stamped/sealed structural calculation or engineer's letter covering the tile roof's dead load, the framing, and the tile attachment point loads.",
        designTeamAction: "Obtain the sealed engineering from the engineer of record and file the engineered/structural application (not the prescriptive checklist).",
        evidenceNeeded: ["Stamped/sealed structural calculation or letter", "Roof dead load including tile", "Tile attachment point loads"],
        codeReferences: [...oregonWorksheetRefs, roofLoadsRef],
      }));
    }
  }

  const snow = num(project, ["snow", "groundSnowLoad"]);
  const deadLoad = num(project, ["deadLoad", "pvDeadLoad"]);
  const wind = str(project, "wind") || str(project, "windExposure");
  if (roofMounted && prescriptiveScreening && (snow == null || deadLoad == null || !wind)) {
    out.push(finding({
      id: "city.struct.loads-missing",
      severity: screeningSeverity,
      category: "structural",
      title: "Structural load criteria missing",
      message: "Ground snow load, PV dead load, and/or wind exposure were not captured for prescriptive structural screening.",
      cityFeedback: "Provide design load criteria on the plans: ground snow load, roof/PV dead load, wind exposure, roof slope, and whether the project remains within the prescriptive checklist limits.",
      designTeamAction: "Add load criteria to the structural notes or provide stamped engineering.",
      evidenceNeeded: ["Ground snow load", "PV dead load psf", "Wind exposure", "Roof slope"],
      codeReferences: [...oregonWorksheetRefs, roofLoadsRef],
    }));
  }

  // PRESENT IS NOT ENOUGH — the stated VALUES are compared with each other and with the
  // jurisdiction's recorded criteria (designCriteria.ts). Needs the jurisdiction context:
  // without one there is nothing to compare against and no citation to render, so the
  // legacy no-context path (pinned by the Oregon golden) is untouched.
  // The permit path picks the state minimum ground snow load (prescriptive vs engineered). The
  // operator override decides first, as it does for the path itself (permitPath.resolvePermitPath).
  const designPath = pathWordingScope(str(project, "permitPathOverride")) || pathWordingScope(str(project, "permitPath"));
  if (ctx) out.push(...evaluateDesignCriteriaFindings(project, ctx, { roofMounted, extraTexts: documentTexts, permitPath: designPath }));
  // The jurisdiction's LOCAL AMENDMENTS, compared with the plan where research classified them, and
  // listed for a person where it could not (amendmentChecks.ts, #145).
  if (ctx) out.push(...evaluateAmendmentFindings(project, ctx, { extraTexts: documentTexts }));
  // What this AHJ corrected on EARLIER plans, once a person approved it as a review rule
  // (ahjReviewRules.ts, #146). A proposed rule runs nothing.
  if (ctx) out.push(...evaluatePriorCorrectionFindings(project, ctx, { extraTexts: documentTexts }));

  // What the package itself states (parser commentary excluded — see packageTextSources).
  const packageTexts = packageTextSources(project, documentTexts);

  // MANUFACTURED HOME — the prescriptive path does not apply, and an engineered design must
  // carry the new load through the walls to the ground. Not gated on a jurisdiction context:
  // this is what the structure IS, not a threshold from a profile (see structureType).
  //
  // TWO CONFIDENCE LEVELS, ONE PREDICATE. A STATED structure type (the operator's intake answer
  // or the parser's structureType field) is a BLOCKER. A structure only the package TEXT
  // suggests is a WARNING asking for the structure type to be confirmed: text can be a
  // disclaimer the reader misjudged, and a blocker from a misread sentence stops a real job.
  const structure = structureType(project, documentTexts);
  if (roofMounted && structure.kind === "manufactured_home") {
    const stated = structure.basis === "stated";
    const fromIntake = structure.source === INTAKE_STRUCTURE_SOURCE;
    const detected: ReviewerFindingEvidence = {
      kind: stated ? "field_value" : "source_excerpt",
      label: "Manufactured home",
      source: structure.source,
      excerpt: structure.excerpt,
      confidence: fromIntake ? "high" : "medium",
      pageHint: "",
      screenshotPath: "",
      verifier: fromIntake ? "normalized_field" : stated ? "parser" : "rule_engine",
      note: stated
        ? "The structure type is recorded as a manufactured (HUD / mobile) home."
        : "Inferred from the package text only — confirm the structure type in the project's intake (Structure type).",
    };
    const identified = stated
      ? `The structure is recorded as a manufactured home ("${structure.excerpt}", ${structure.source})`
      : `The package text suggests a manufactured home ("${structure.excerpt}", ${structure.source}) — inferred from text, not confirmed`;
    const confirmStep = stated ? "" : " First confirm the structure type in the project's intake (Structure type: site-built / manufactured); a site-built answer clears this.";
    const severity: ReviewerFinding["severity"] = stated ? "blocker" : "warning";
    const loadPathRef = ctx
      ? residentialCodeRef(ctx, "R301.1.3", "Engineered design", engineeredDesign.note)
      : engineeredDesign;
    const cityFeedback = "The proposed installation is being placed on a manufactured home. Prescriptive code does not allow this, as these structures are not conventionally designed to support additional loads. Revise the structural design to show how the new loads will be adequately transferred through the existing roof framing and walls to the foundation / ground below (continuous load path).";
    if (prescriptive) {
      out.push({
        ...finding({
          id: "city.struct.manufactured-home-prescriptive",
          severity,
          category: "structural",
          title: "Manufactured home on the prescriptive path",
          message: `${identified}, and the permit path is prescriptive. The prescriptive rooftop-PV provisions assume conventional light-frame construction; a manufactured home needs an engineered design.`,
          cityFeedback,
          designTeamAction: `Route the design to a structural engineer: an engineered design (not the prescriptive checklist) that shows the continuous load path from the PV attachments through the roof framing and walls to the foundation/piers.${confirmStep}`,
          evidenceNeeded: ["Stamped engineered design for the manufactured home", "Continuous load path: attachments -> roof framing -> walls -> foundation/piers", "Framing members as built (manufactured trusses, size and spacing)"],
          codeReferences: [loadPathRef],
        }),
        evidenceStatus: stated ? "verified" : "weak",
        evidenceFound: [detected],
      });
    } else {
      const loadPath = affirmedIn(packageTexts, LOAD_PATH_TO_FOUNDATION);
      if (!loadPath) {
        out.push({
          ...finding({
            id: "city.struct.manufactured-home-load-path",
            severity,
            category: "structural",
            title: "Manufactured home — engineering does not show a load path to the foundation",
            message: `${identified}, and no engineering text in the package shows how the new PV load reaches the foundation (a continuous load path through the walls). An attachment/rafter check alone does not answer it.`,
            cityFeedback,
            designTeamAction: `Have the engineer of record extend the design from the attachments through the roof framing, walls and floor system to the foundation/piers, and state the continuous load path in the sealed letter.${confirmStep}`,
            evidenceNeeded: ["Sealed engineering showing the continuous load path to the foundation/piers", "Wall and foundation/pier capacity for the added load"],
            codeReferences: [loadPathRef],
          }),
          evidenceStatus: "missing",
          evidenceFound: [detected],
        });
      }
    }
  }

  // UL LISTINGS — module (UL 61730 / UL 1703) and racking/mounting (UL 2703), stated in the
  // package. An attached module_spec DOCUMENT is not the answer by itself: a coastal Oregon city
  // asked for exactly these listings on a package that carried one. Its text is read (it is in
  // the plan-set text), its presence is not. Gated on a jurisdiction context like the criteria
  // rules above — the legacy no-context path is pinned by the Oregon golden.
  if (ctx && roofMounted) {
    // The module datasheet's listing, when its page was an IMAGE, is read once by vision
    // (moduleListing.ensureModuleListingAgency) and kept with the printed words — those words are
    // package evidence too ("UL listing not shown" was FALSE on City of Jefferson: the marks were on
    // an image page).
    const datasheetWords = str(project, "moduleListingAgencyEvidence");
    const moduleListing = affirmedIn(packageTexts, MODULE_LISTING_PATTERNS)
      ?? (datasheetWords ? affirmedIn([{ label: "Module datasheet (read from the page image)", text: datasheetWords }], MODULE_LISTING_PATTERNS) : null);
    const rackingListing = affirmedIn(packageTexts, RACKING_LISTING_PATTERNS);
    if (!moduleListing || !rackingListing) {
      const missing = [!moduleListing ? "module listing (UL 61730 or UL 1703)" : "", !rackingListing ? "racking/mounting listing (UL 2703)" : ""].filter(Boolean);
      const found = [moduleListing, rackingListing].filter((x): x is Affirmed => x != null);
      // A CALLOUT BY DEFAULT, A WARNING WHERE THE JURISDICTION HAS ASKED. It fired as a warning on
      // every roof job on production (19 of 19): most plan sets name the listings only on the
      // attached cut sheets, whose text is often image-only and never read — so "not found" is
      // an absence we could not fully check. Where the jurisdiction's profile records that it
      // asks for listing evidence (prescriptive.listingEvidenceRequired — learned from an AHJ
      // correction through a human, or researched), the same absence is a warning there.
      const listingAsked = ctx.prescriptive.listingEvidenceRequired === true;
      out.push({
        ...finding({
          id: "city.plan.ul-listings-missing",
          severity: listingAsked ? "warning" : "callout",
          category: "plan_set",
          title: "UL listing for modules / racking not shown",
          message: `No ${missing.join(" or ")} was found in the package text that could be read (cut sheets whose pages are images are not read). UL 1741 (inverters) and UL 1699B (arc-fault) are different listings and do not answer this.`
            + (listingAsked ? ` ${ctx.ahj || "This jurisdiction"} has asked for this listing evidence before.` : ""),
          cityFeedback: "Provide UL listing for the panels, mounting and racking hardware.",
          designTeamAction: "Add the module UL 61730 (or UL 1703) listing and the racking/mounting UL 2703 listing to the plan set — equipment notes or the attached cut sheets/certificates.",
          evidenceNeeded: missing.map((m) => `${m[0].toUpperCase()}${m.slice(1)} on the plan set or an attached cut sheet/certificate`),
          codeReferences: [residentialCodeRef(ctx, equipmentListings.section, equipmentListings.title, equipmentListings.note)],
        }),
        evidenceStatus: found.length ? "weak" : "missing",
        // NEVER EMPTY. reviewerEngine.attachEvidence fills an empty list from the finding's topic
        // — "racking" in the title maps it to rackingAttachment — and overwrites the status with
        // that topic's: "verified" on any plan set with a flashing detail, i.e. "UL listing not
        // shown — evidence: verified". The absence is the evidence.
        evidenceFound: found.length
          ? found.map((f) => affirmedEvidence(f, "Listing stated", "Listing found in the package."))
          : [{
            kind: "absence_check",
            label: "UL 61730 / UL 1703 / UL 2703 not stated",
            source: "Package text",
            excerpt: "No module (UL 61730 / UL 1703) or racking (UL 2703) listing in the package text.",
            confidence: "low",
            pageHint: "",
            screenshotPath: "",
            verifier: "rule_engine",
            note: "Absence check over the package text (parser commentary excluded).",
          }],
      });
    }
  }

  // ATTACHMENT SPACING vs THE JURISDICTION'S LIMIT. The profile's prescriptive
  // maxAttachmentSpacingIn is data (learned from an AHJ comment through a human, or
  // researched) — no number lives here. The plan's FIELD spacing is the larger of what it
  // states: "4'-0\" O.C. (24\" O.C. within 3 ft of edges)" is 48" in the field.
  //
  // "ANCHOR", NOT "ATTACHMENT", IN THE ID AND TITLE — ON PURPOSE. This finding is a MEASURED
  // result (48 > 24), and reviewerVision relaxes any warning/blocker whose id/title maps to a
  // plan topic (topicForFinding: /attachment|racking|mount/ -> rackingAttachment) once a sheet
  // image merely SHOWS a spacing — the same trap that softened a real 705.12 violation. It is
  // listed in reviewerVision's MEASURED_FINDING_IDS (visionMeasuredCriteria.test.ts pins that);
  // the wording is a second guard, and structureListingsSpacing.test.ts fails if a rename makes
  // it relaxable.
  const ahjMaxSpacing = ctx && typeof ctx.prescriptive.maxAttachmentSpacingIn === "number" && ctx.prescriptive.maxAttachmentSpacingIn > 0
    ? ctx.prescriptive.maxAttachmentSpacingIn
    : null;
  if (ctx && roofMounted && ahjMaxSpacing != null) {
    const who = ctx.ahj || ctx.state || "the jurisdiction";
    const stated: Array<{ inches: number; source: string; excerpt: string }> = [];
    for (const key of ["attachmentSpacingIn", "attachmentEdgeSpacingIn"]) {
      const v = num(project, [key]);
      if (v != null && v >= 6 && v <= 96) stated.push({ inches: v, source: PARSED_FIELDS_SOURCE, excerpt: `${key}: ${str(project, key)}`.slice(0, 80) });
    }
    for (const source of packageTexts) {
      for (const s of extractAttachmentSpacings(source.text)) stated.push({ inches: s.inches, source: source.label, excerpt: s.excerpt });
    }
    const profileNote = ctx.verified ? "human-verified code profile" : "seeded code profile (not yet human-verified)";
    const ref = residentialCodeRef(ctx, roofLoads.section, roofLoads.title, roofLoads.note);
    if (!stated.length) {
      out.push(finding({
        id: "city.struct.anchor-spacing-unchecked",
        severity: "callout",
        category: "structural",
        title: "Roof anchor spacing not readable — not checked against the jurisdiction's limit",
        message: `${who} accepts roof attachments at no more than ${ahjMaxSpacing}" o.c. (${profileNote}), and no attachment spacing could be read from the package, so it has NOT been checked.`,
        cityFeedback: `Show the roof-attachment spacing on the plans; ${who} limits it to ${ahjMaxSpacing}" o.c.`,
        designTeamAction: `Confirm the attachment spacing on the roof plan / attachment detail is no more than ${ahjMaxSpacing}" o.c.`,
        evidenceNeeded: ["Attachment spacing (field and edge zones) on the roof plan or attachment detail"],
        codeReferences: [ref],
        installerCallout: false,
      }));
    } else {
      const fieldSpacing = Math.max(...stated.map((s) => s.inches));
      if (fieldSpacing > ahjMaxSpacing) {
        const over = stated.filter((s) => s.inches > ahjMaxSpacing);
        out.push({
          ...finding({
            id: "city.struct.anchor-spacing-exceeds-ahj",
            severity: screeningSeverity,
            category: "structural",
            title: "Roof anchor spacing exceeds the jurisdiction's limit",
            message: `The plan's field attachment spacing is ${fieldSpacing}" o.c. (${[...new Set(over.map((s) => s.source))].join(", ")}); ${who} accepts at most ${ahjMaxSpacing}" o.c. (${profileNote}).`,
            cityFeedback: `Provide updated mounting spacing. The mounting spacing should be ${ahjMaxSpacing}" o.c. or less.`,
            designTeamAction: `Revise the attachment layout and detail to ${ahjMaxSpacing}" o.c. maximum (field and edge zones), or provide engineering that justifies the wider spacing where the jurisdiction accepts it.`,
            evidenceNeeded: [`Attachment spacing at or below ${ahjMaxSpacing}" o.c. on the roof plan and attachment detail`, ...over.slice(0, 3).map((s) => `${s.inches}" o.c. stated (${s.source})`)],
            codeReferences: [ref],
          }),
          evidenceStatus: "verified",
          evidenceFound: over.slice(0, 6).map((s) => affirmedEvidence({ source: s.source, excerpt: s.excerpt }, `Attachment spacing ${s.inches}" o.c.`, `Compared against ${who}'s ${ahjMaxSpacing}" o.c. limit.`)),
        });
      }
    }
  }

  if (rsdApplies && !hasAny(all, RAPID_SHUTDOWN_PATTERNS)) {
    const { mlpe } = mlpeDesign(project, all, packageTexts);
    out.push(finding({
      id: "city.elec.rapid-shutdown-missing",
      // MLPE designs (microinverters / RSD optimizers) satisfy module-level rapid
      // shutdown inherently — the remaining gap is the plan callout/label, which is
      // a warning, not a staging blocker.
      severity: mlpe ? "warning" : "blocker",
      category: "electrical",
      title: mlpe ? "Rapid shutdown callout missing (MLPE design)" : "Rapid shutdown not shown",
      message: (mlpe
        ? "The design uses microinverters/module-level power electronics, which provide inherent module-level rapid shutdown, but the plans do not call out NEC 690.12 compliance or the RSD label."
        : "No rapid shutdown callout or equipment evidence was detected.")
        + (nec ? ` The adopted NEC ${nec.edition} ${nec.rapidShutdown.article} requires ${nec.rapidShutdown.limits}${unconfirmedNote(nec, ["rapidShutdown.limits"])}.` : "")
        + (nec && isUnconfirmed(nec, "labels.rapidShutdown") ? ` The rapid shutdown label section ${nec.labels.rapidShutdown} is${unconfirmedNote(nec, ["labels.rapidShutdown"])}.` : ""),
      cityFeedback: mlpe
        ? "Add a rapid shutdown note to the electrical plans stating the module-level shutdown basis (microinverter/MLPE listing) and show the required rapid shutdown label/placard for the adopted NEC cycle."
        : "Revise the electrical plans to identify rapid shutdown equipment, initiation/control location, controlled conductors or array boundary basis, and required field marking for the adopted NEC cycle.",
      designTeamAction: mlpe
        ? "Add a 690.12 module-level shutdown note and RSD label callout to the SLD/label schedule (equipment already complies)."
        : "Add RSD equipment and label callouts to the SLD/site/equipment schedule.",
      evidenceNeeded: nec
        ? necRapidShutdownEvidence(nec, mlpe)
        : mlpe
          ? ["690.12 module-level shutdown note", "RSD label/placard callout", "Microinverter/MLPE listing reference"]
          : ["RSD device or inverter listing basis", "RSD initiation/control location", "RSD label/placard callout", "Code-cycle note"],
      codeReferences: nec ? [rapidShutdownRef, necRef(nec.labels.rapidShutdown, rapidShutdownLabel), electricalRef] : [rapidShutdownRef, electricalRef],
    }));
  }

  // THE EDITION'S OWN EVIDENCE (issue #143). A plan set that says "rapid shutdown" has cleared the
  // presence rule above; a 2017+ checker then asks HOW the inside-the-array-boundary requirement is
  // met (a listed PV hazard control system / listed RSD equipment, 690.12(B)(2)), and where the
  // initiation device is (690.12(C): outside, readily accessible, on a dwelling). Rule-3
  // shape: a human-VERIFIED edition and a package whose documents were actually read → blocker;
  // a seeded edition, or nothing but parser fields to read → warning. An MLPE design meets
  // 690.12 inherently, so its gap is documentation: never more than a warning.
  const documentsRead = documentTexts.some((d) => readableDocumentText(d.text)) || readableDocumentText(str(project, "planSetExtractedText"));
  const ruleThreeSeverity: ReviewerFinding["severity"] = ctx?.verified && documentsRead ? "blocker" : "warning";
  if (nec && rsdApplies && hasAny(all, RAPID_SHUTDOWN_PATTERNS)) {
    const { mlpe, equipment } = mlpeDesign(project, all, packageTexts);
    const rs = nec.rapidShutdown;
    const gaps: Array<{ item: string; section: string }> = [];
    // THE EDITION'S OWN OPTIONS (#215). 2017/2020 690.12(B)(2) had a third inside-boundary option,
    // (3) no exposed wiring methods or conductive parts, which the 2023 NEC deleted. Under 2017/2020
    // a "690.12(B)(2)(3)" citation answers the gap as it always has; under 2023 it no longer does.
    // Only that citation counts as relying on the option — never a general "no exposed wiring"
    // note — and a citation that rejects it ("… – NOT USED", #242) answers nothing under either.
    const deletedOption = !rs.noExposedWiringOption && rs.insideBoundaryArticle;
    const listed = affirmedIn(
      withoutRsdOptionTitle(packageTexts),
      rs.noExposedWiringOption ? [...RSD_LISTED_EQUIPMENT_PATTERNS, RSD_NO_EXPOSED_WIRING_CITATION] : RSD_LISTED_EQUIPMENT_PATTERNS,
    );
    const planSheets = sheetTextSources(project, documentTexts).filter((src) => !SPEC_SHEET_SOURCE.test(src.label) && !/handout/i.test(src.label));
    const deletedOptionCited = deletedOption && !listed ? affirmedIn(withoutRsdOptionTitle(planSheets), [RSD_NO_EXPOSED_WIRING_CITATION]) : null;
    if (rs.requiresListedEquipment && rs.insideBoundaryArticle && !listed) {
      gaps.push({ item: "Listed PV hazard control system or listed rapid shutdown equipment for inside the array boundary", section: rs.insideBoundaryArticle });
    }
    if (rs.initiationDeviceArticle && !affirmedIn(packageTexts, RSD_INITIATION_PATTERNS)) {
      gaps.push({ item: "Rapid shutdown initiation device location (readily accessible, outside a dwelling)", section: rs.initiationDeviceArticle });
    }
    if (gaps.length) {
      const sectionList = gaps.map((g) => g.section).join(" / ");
      const editionNote = deletedOptionCited
        ? ` The plans cite ${deletedOptionCited.excerpt} ("no exposed wiring"), an option the NEC ${nec.edition} removed from ${rs.insideBoundaryArticle}${unconfirmedNote(nec, ["rapidShutdown.noExposedWiringOption"])}.`
        : "";
      out.push({
        ...finding({
          id: "city.elec.rapid-shutdown-edition-evidence",
          // A blocker only when no inside-boundary method is identifiable at all: no module-level
          // electronics (microinverters, or optimizer EQUIPMENT), no listed PVHCS / RSD device — on
          // top of a verified edition and documents read (ruleThreeSeverity).
          // A finding that rests ONLY on the deleted option is at most a warning while that table
          // cell is unconfirmed against the code text; another gap beside it keeps its severity.
          severity: mlpe || (deletedOptionCited && isUnconfirmed(nec, "rapidShutdown.noExposedWiringOption") && gaps.every((g) => g.section === rs.insideBoundaryArticle))
            ? "warning"
            : ruleThreeSeverity,
          category: "electrical",
          // The adopted edition is named as the one applied, not as a change from the last cycle —
          // unless the check actually tested a difference (deletedOptionCited).
          title: deletedOptionCited
            ? `Rapid shutdown relies on an option the NEC ${nec.edition} removed`
            : `Rapid shutdown basis not shown for the adopted NEC ${nec.edition}`,
          message: `The plans mention rapid shutdown, but the adopted NEC ${nec.edition} also needs: ${gaps.map((g) => `${g.item} (${g.section})`).join("; ")}.${editionNote}`
            + (equipment.present ? ` Module-level electronics are shown (${equipment.excerpt}); state the ${sectionList} basis and listing for them.` : ""),
          cityFeedback: `Revise the electrical plans to show the NEC ${nec.edition} rapid shutdown basis: ${gaps.map((g) => `${g.section} — ${g.item.toLowerCase()}`).join("; ")}.`,
          designTeamAction: equipment.present
            ? `State the ${sectionList} basis and listing for the named MLPE (${equipment.excerpt}) on the SLD and label schedule (equipment already complies).`
            : mlpe
              ? `Add the MLPE listing as the ${sectionList} basis on the SLD and label schedule (equipment already complies).`
              : `Add the ${sectionList} evidence to the SLD/equipment schedule.`,
          evidenceNeeded: gaps.map((g) => g.item),
          codeReferences: gaps.map((g) => necRef(g.section, rapidShutdown)),
        }),
        ...(equipment.present
          ? { evidenceFound: [affirmedEvidence({ source: equipment.fromField ? PARSED_FIELDS_SOURCE : equipment.source, excerpt: equipment.excerpt }, "Module-level electronics (equipment)", "Optimizer/MLPE equipment on the design: module-level rapid shutdown is present; the listing basis is what is missing.")] }
          : {}),
      });
    }
  }

  if (!hasAny(all, LABEL_SCHEDULE_PATTERNS)) {
    out.push(finding({
      id: "city.elec.labels-missing",
      severity: "warning",
      category: "electrical",
      title: "PV label schedule not obvious",
      message: "The package does not clearly show required PV placards/labels.",
      cityFeedback: "Provide a PV label schedule showing service equipment directory, rapid shutdown label, disconnect labels, backfed breaker warning where applicable, and any AHJ/utility-specific placards.",
      designTeamAction: "Add label sheet or label callouts to the electrical plan.",
      evidenceNeeded: nec
        ? ["Label schedule", "Placard locations", "Backfed breaker warning where applicable", ...necLabelRequirements(nec, { rsdApplies, standAlone: STAND_ALONE.test(all), dcCircuits: !isMicroinverterDesign(project, all) }).map((l) => `${l.label} (${l.section})`)]
        : ["Label schedule", "Placard locations", "Backfed breaker warning where applicable", "Power source directory"],
      codeReferences: nec
        ? necLabelRequirements(nec, { rsdApplies, standAlone: STAND_ALONE.test(all), dcCircuits: !isMicroinverterDesign(project, all) }).map((l) => necRef(l.section, { ...rapidShutdownLabel, section: l.section, title: l.label }))
        : [rapidShutdownRef, powerSourceDirectoryRef],
    }));
  } else if (nec) {
    // A CUT SHEET IS NOT A LABEL. An inverter datasheet prints "rated AC output current" and
    // "maximum DC voltage" as specifications, which would otherwise answer 690.54 / 690.53. Where a
    // source is known to be a spec sheet it is not read for labels; the merged plan-set text, whose
    // sheet types are not known, still is.
    const labelTexts = packageTexts.filter((s) => !SPEC_SHEET_SOURCE.test(s.label));
    // The schedule exists; does it carry the labels THIS edition names? Same rule-3 severity as the
    // rapid-shutdown evidence above. Each missing label is cited by the edition's own section.
    const missingLabels = necLabelRequirements(nec, { rsdApplies, standAlone: STAND_ALONE.test(all), dcCircuits: !isMicroinverterDesign(project, all) })
      .filter((l) => !affirmedIn(labelTexts, l.patterns));
    if (missingLabels.length) {
      out.push(finding({
        id: "city.elec.labels-edition-missing",
        severity: ruleThreeSeverity,
        category: "electrical",
        title: `PV label schedule is missing labels NEC ${nec.edition} requires`,
        message: `The package shows a label schedule, but not: ${missingLabels.map((l) => `${l.label} (${l.section})`).join("; ")}.`
          + (missingLabels.some((l) => l.section === nec.labels.rapidShutdown) && isUnconfirmed(nec, "labels.rapidShutdown") ? ` The rapid shutdown label section ${nec.labels.rapidShutdown} is${unconfirmedNote(nec, ["labels.rapidShutdown"])}.` : ""),
        cityFeedback: `Add the NEC ${nec.edition} labels to the label schedule: ${missingLabels.map((l) => `${l.section} ${l.label}${l.wording ? ` ("${l.wording}")` : ""}`).join("; ")}.`,
        designTeamAction: "Add the missing labels and their locations to the label sheet.",
        evidenceNeeded: missingLabels.map((l) => `${l.label} (${l.section})`),
        codeReferences: missingLabels.map((l) => necRef(l.section, { ...rapidShutdownLabel, section: l.section, title: l.label })),
      }));
    }
  }

  // EDITION UNKNOWN: the generic rules above ran, and the report says why they were generic. Only
  // with a jurisdiction context — the no-context path stays exactly as the Oregon golden pins it.
  if (ctx && !nec) {
    out.push(finding({
      id: "city.code.nec-edition-unknown",
      severity: "callout",
      category: "electrical",
      title: "Adopted NEC edition not known — rapid shutdown, labels and interconnection checked generically",
      message: necAdopted == null
        ? `No adopted electrical code edition is on file for ${ctx.ahj || ctx.state || "this jurisdiction"}, so rapid shutdown (690.12), labels (690.56(C), 705.10) and the interconnection sections were checked for presence only, not against an edition's articles.`
        : `${ctx.ahj || ctx.state || "This jurisdiction"} is on NEC ${necAdopted}, which the edition table does not cover (${Object.keys(NEC_EDITION_REQUIREMENTS).join(", ")}), so rapid shutdown, labels and the interconnection sections were checked for presence only.`,
      cityFeedback: "Confirm the locally adopted NEC edition so rapid shutdown, labeling and interconnection can be checked against its articles.",
      designTeamAction: "Record the jurisdiction's adopted NEC edition on its code profile.",
      evidenceNeeded: ["Adopted NEC edition for the jurisdiction"],
      codeReferences: [rapidShutdownRef],
      installerCallout: false,
    }));
  }

  const intercoText = `${project.interconnectionMethod}\n${str(project, "interco")}`;
  const bus = num(project, ["busRating"]);
  const mainBreaker = num(project, ["mainBreaker"]);
  const pvBreaker = num(project, ["pvBreaker"]);

  // WHICH SIDE OF THE SERVICE IS THIS? The 120% busbar screen is NEC 705.12(B)(3)(2) — a
  // LOAD-SIDE rule. A SUPPLY-SIDE (line-side) tap is 705.11 and is not governed by it at all:
  // the question there is whether the tap conductors and their OCPD are sized to the service.
  //
  // The old gate matched the bare word "breaker", so Harper Fakename's parsed interconnection
  // "Supply Breaker" — corroborated by his own plan set, "POINT OF INTERCONNECT, SUPPLY
  // BREAKER FEED THRU LUG" — was measured against the load-side rule and produced a BLOCKER
  // that the code it cites does not support. 200A main + 50A PV on a 200A bus exceeds 240A
  // and would be a real finding on a load-side design; on a supply-side tap it is not the
  // test. Found 2026-09-22 while stress-testing the gate.
  //
  // THREE ANSWERS, NOT TWO, and the third is the honest one. Silence would be worse than the
  // false blocker: a supply-side design still has to be checked, just against a different
  // rule. So supply side gets its own callout naming 705.11, an interconnection naming BOTH
  // is reported as ambiguous rather than guessed, and only a genuine load-side design is
  // measured against 120%.
  const saysSupplySide = /supply.?side|supply breaker|line.?side|705\.11|ahead of (?:the )?main|feed.?thr(?:u|ough) lug|service.entrance tap/i.test(intercoText);
  const saysLoadSide = /load.?side|back.?fed|back.?feed|705\.12/i.test(intercoText);
  // The chain's third branch: reached only when nothing says supply side. Named once so the
  // electrical sizing recompute below asks the same question rather than a copy that can drift.
  const loadSideBranch = !saysSupplySide && /load.side|breaker|back.?feed|bus/i.test(intercoText);

  // RECOMPUTE THE SIZING (#144): the busbar screen with the inverter's real output current, the
  // output circuit's OCPD and conductor, the cold-weather string voltage, and voltage drop. The
  // busbar part runs only on a LOAD-side classification (the chain below). It is the ONE 120 %
  // rule (#153): the adopted NEC edition decides whether it reads the inverter current (2017+)
  // or the PV breaker (older editions). The edition is necAdopted (a defaults context reads
  // unknown), and the citation is that edition's own busbar section (2014: 705.12(D)(2)(3)(b)).
  const sizingFindings = evaluateElectricalSizingFindings(project, {
    documentTexts,
    loadSide: loadSideBranch,
    adoptedNecEdition: necAdopted,
    busbarSection: busbarArt,
    cite,
  });

  if (saysSupplySide && !saysLoadSide) {
    out.push(finding({
      id: "city.elec.supply-side-tap",
      severity: "callout",
      category: "electrical",
      title: "Supply-side tap — the 120% busbar screen does not apply",
      message: `The interconnection is recorded as "${str(project, "interco") || project.interconnectionMethod}", a supply-side (line-side) connection. NEC ${busbarArt}'s 120% busbar calculation governs LOAD-side connections and is not the applicable test here.`,
      cityFeedback: "Show the supply-side tap detail: tap conductor size and ampacity relative to the service, the PV disconnect/OCPD ahead of the service disconnect, and the labelling required at the service equipment.",
      designTeamAction: `Confirm the tap conductors and overcurrent protection are sized to the service per NEC ${supplyArt}, and that the busbar calculation is correctly omitted rather than missing.`,
      evidenceNeeded: ["Supply-side tap detail on the one-line", "Tap conductor size/ampacity vs service rating", "PV disconnect and OCPD location", "Service-equipment labelling"],
      // 705.11, not 705.12. This finding EXISTS to say the load-side busbar screen does not
      // govern here, so citing the load-side section as its basis contradicted its own text.
      codeReferences: [supplySideRef],
    }));
  } else if (saysSupplySide && saysLoadSide) {
    out.push(finding({
      id: "city.elec.interconnection-ambiguous",
      severity: "warning",
      category: "electrical",
      title: "Interconnection method names both supply side and load side",
      message: `The recorded interconnection ("${str(project, "interco") || project.interconnectionMethod}") carries both supply-side and load-side language, and the two answer to different code sections — ${supplyArt} versus the ${busbarArt} busbar screen.`,
      cityFeedback: "State the interconnection method unambiguously on the one-line, with the calculation that matches it.",
      designTeamAction: "Settle which connection the design actually makes before filing; the reviewer cannot apply the right screen until it is stated once.",
      evidenceNeeded: ["Interconnection method stated once on the one-line", `The matching calculation (${supplyArt} tap sizing OR the ${loadArt} busbar screen)`],
      // The whole content of this finding is that the design has not said WHICH of the two
      // governs, so both are cited — matching the message's own "705.11 versus 705.12".
      codeReferences: [supplySideRef, loadSideRef],
    }));
  } else if (loadSideBranch) {
    // THE 120 % ARITHMETIC LIVES IN ONE RULE (#153): city.elec.sizing-busbar-120, evaluated above
    // in electricalSizing.ts. This branch used to carry its own breaker-rating copy
    // (city.elec.load-side-over-120); two copies disagreed — the 2017+ NEC measures 125 % of the
    // inverter output current, not the breaker, and only the recompute follows where each value
    // came from. Here only the "calculation not shown / ratings not readable" door remains. The
    // warning for an unshown calc is dropped when the busbar rule already reports the violation
    // with every rating readable — the old over-120 blocker suppressed it the same way.
    const ratingMissing = bus == null || mainBreaker == null || pvBreaker == null;
    const busbarReported = sizingFindings.some((f) => f.id === "city.elec.sizing-busbar-120");
    if (ratingMissing || (!hasAny(all, LOAD_SIDE_CALC_PATTERNS) && !busbarReported)) {
      out.push(finding({
        id: "city.elec.load-side-calc-missing",
        severity: ratingMissing ? "blocker" : "warning",
        category: "electrical",
        title: "Load-side interconnection calculation incomplete",
        message: "The package does not clearly show the load-side interconnection ratings/calculation.",
        cityFeedback: "Provide the NEC load-side interconnection calculation on the SLD, including bus rating, main breaker rating, PV breaker/OCPD rating, inverter output current basis, breaker location, and any required warning label.",
        designTeamAction: `Add the ${loadArt} calculation and verify it matches the MSP schedule.`,
        evidenceNeeded: ["MSP bus rating", "Main breaker rating", "PV breaker/OCPD rating", "Breaker location/opposite-end note", "Inverter output current basis"],
        codeReferences: [loadSideRef, powerSourceDirectoryRef],
      }));
    }
  } else {
    // THE MISSING DOOR. This chain had no final else, so an interconnection matching none of
    // the three vocabularies above fell off the end and produced NOTHING — not a blocker, not
    // a warning, not a callout. The 120% busbar arithmetic runs only for the load-side
    // branch above and nothing downstream repeats it: QC checks that the rating FIELDS ARE
    // PRESENT, never that the math passes. So an unrecognised wording did not merely skip a
    // label, it skipped the only NEC 705.12 calculation in the product.
    //
    // The trigger is not exotic. "Net Metering" is the FIRST example value in the parser's own
    // prompt (llm.ts), and Blake Fixture's live row carries exactly that string — measured, his
    // filing has never had its busbar screen run. Six of eight realistic wordings were silent.
    //
    // An unknown method is NOT routed into the load-side branch: demanding a 705.12 busbar calc
    // from what may be a supply-side tap would just trade a silent hole for a false demand.
    // It gets its own finding that asks the one question that resolves it.
    out.push(finding({
      id: "city.elec.interconnection-unclassified",
      severity: "warning",
      category: "electrical",
      title: "Interconnection method not classifiable — the busbar screen did not run",
      message: `The recorded interconnection ("${str(project, "interco") || project.interconnectionMethod}") does not say whether the connection is supply side or load side, and the two answer to different code sections. No interconnection calculation has been checked for this project.`,
      cityFeedback: "State the interconnection method explicitly on the one-line — supply-side/line-side tap, or load-side breaker connection — with the calculation that matches it.",
      designTeamAction: `Record the method as supply side or load side. A load-side connection needs the ${loadArt} busbar screen (bus rating, main breaker, PV breaker); a supply-side tap needs the ${supplyArt} tap detail and conductor sizing.`,
      evidenceNeeded: ["Interconnection method stated as supply side or load side", "MSP bus rating", "Main breaker rating", "PV breaker/OCPD rating"],
      codeReferences: [supplySideRef, loadSideRef],
    }));
  }

  // GATED ON THE CLASSIFIER, not on a second, narrower vocabulary of its own. This rule used
  // to test /line.side|supply.side|tap/ — so the phrasings the supply-side classifier learned
  // ("Supply Breaker", "ahead of the main", "feed-thru lug") were called supply-side by one
  // rule and not by this one, and never had to show a tap detail at all.
  //
  // The suppression list is tightened at the same time. /tap/i was satisfied by the word
  // "tape", and /supply.side/i was very nearly circular: a plan set that says "supply side"
  // once counted as having SHOWN the detail. What a tap detail actually contains is the tap
  // point, the service conductor sizing, and the disconnect — so ask for those.
  if (saysSupplySide && !hasAny(all, SUPPLY_SIDE_DETAIL_PATTERNS)) {
    out.push(finding({
      id: "city.elec.supply-side-detail-missing",
      severity: "blocker",
      category: "electrical",
      title: "Supply-side connection detail missing",
      message: "The project appears to use a supply-side/line-side connection but the service tap detail was not found.",
      cityFeedback: "Provide a supply-side connection detail showing exact tap location, service conductor sizes, disconnect/OCPD, conductor lengths/routing, service equipment listing implications, grounding/bonding, and utility approval requirements.",
      designTeamAction: "Add a supply-side connection detail and utility coordination note.",
      evidenceNeeded: ["Tap point detail", "Service conductor/OCPD sizing", "PV disconnect location", "Utility approval note"],
      codeReferences: [supplySideRef, electricalRef],
    }));
  }

  // RECOMPUTE THE SIZING (#144), evaluated above so the load-side branch can see the busbar
  // result; pushed here so the report's finding order is unchanged.
  out.push(...sizingFindings);

  const moduleFields = [str(project, "moduleMake"), str(project, "moduleModel"), str(project, "moduleWattage"), str(project, "moduleQty")].filter(Boolean);
  const inverterFields = [str(project, "invModel"), str(project, "pvMicroModel"), str(project, "inverterModel"), str(project, "invQty"), str(project, "pvMicroQty")].filter(Boolean);
  const hasModuleSpec = hasAny(all, [/module spec/i, /module data/i, ...MODULE_LISTING_PATTERNS]);
  const hasInverterSpec = hasAny(all, [/inverter spec/i, /microinverter spec/i, ...INVERTER_LISTING_PATTERNS, /PCS/i]);
  // Core equipment data present = the schedule IS there (make/model/wattage/qty for
  // modules and at least model+qty for the inverter). When that's the case, only a
  // separate SPEC-SHEET is unverified, which is a non-blocking callout the human
  // confirms — not a warning that the equipment is "missing". The warning/blocker
  // is reserved for genuinely missing core fields.
  const coreEquipmentPresent = moduleFields.length >= 4 && inverterFields.length >= 2;
  if (moduleFields.length < 4 || inverterFields.length < 2 || !hasModuleSpec || !hasInverterSpec) {
    const severity = !coreEquipmentPresent ? "blocker" : "callout";
    out.push(finding({
      id: "city.elec.equipment-specs-incomplete",
      severity,
      category: "electrical",
      title: coreEquipmentPresent ? "Equipment spec sheets — confirm attached" : "Equipment schedule/spec package incomplete",
      message: coreEquipmentPresent
        ? "Module/inverter schedule is present; confirm the matching spec sheets are attached."
        : "Module/inverter schedule or spec-sheet evidence is incomplete.",
      cityFeedback: "Provide a complete equipment schedule and matching specification sheets for modules, inverter(s)/microinverters, racking, rapid shutdown devices, ESS equipment if applicable, and disconnect/OCPD equipment. Equipment names on specs must match the SLD and application.",
      designTeamAction: coreEquipmentPresent
        ? "Confirm module/inverter/racking/RSD spec sheets are included and model numbers match the schedule."
        : "Add missing equipment fields/spec sheets and reconcile model numbers across the plan set.",
      evidenceNeeded: ["Module make/model/wattage/quantity", "Inverter or microinverter make/model/quantity/output", "Module and inverter spec sheets", "Racking and RSD spec sheets"],
      codeReferences: [electricalRef, rapidShutdownRef],
    }));
  }

  const dcKw = project.systemSizeDcKw ?? num(project, ["dcKw"]);
  const moduleQty = num(project, ["moduleQty"]);
  const moduleWattage = num(project, ["moduleWattage"]);
  if (dcKw != null && moduleQty != null && moduleWattage != null) {
    const calculatedDc = (moduleQty * moduleWattage) / 1000;
    if (Math.abs(calculatedDc - dcKw) > 0.15) {
      out.push(finding({
        id: "city.elec.dc-size-mismatch",
        severity: "blocker",
        category: "electrical",
        title: "DC size mismatch",
        message: `Captured module count/wattage calculates ${calculatedDc.toFixed(2)} kW DC but project DC size is ${dcKw.toFixed(2)} kW.`,
        cityFeedback: "Revise the equipment schedule/application so module quantity, module wattage, and DC system size match across all sheets and portal fields.",
        designTeamAction: "Correct either module quantity, module wattage, or DC kW and regenerate affected application fields.",
        evidenceNeeded: ["Corrected equipment schedule", "Corrected application DC size", "Matching SLD/module sheet"],
        codeReferences: [electricalRef],
      }));
    }
  }

  // The designer's sheets, not the parser's own labels (#257): the split map, the download
  // checklist and the packet-readiness list always print "07 Battery / ESS specs: not detected" /
  // "OPTIONAL/MISSING - 07 Battery / ESS Spec Sheet" / "READY - Battery / ESS", so a no-battery
  // project posted with that JSON raised this review.
  const batterySources: DesignTextSource[] = [
    { label: "batteryModel", text: str(project, "batteryModel") },
    { label: "batteryQty", text: str(project, "batteryQty") },
    { label: "design text", text: designText(project, ["splitPagesText", "utilityDownloadChecklistText", "packetReadinessText"]) },
  ];
  const batteryText = batterySources.map((s) => s.text).join("\n");
  // The suppression list held a bare /fire/i — and since the fire-pathway work every plan set
  // reliably carries "FIRE ACCESS PATHWAY", so that fix would itself have switched off every
  // battery review. It also held an unbounded /ESS/i, which matches "addrESS" and "procESS".
  // Word-boundary the acronym, and take fire SEPARATION/rating rather than the bare word.
  // The acronym itself is a TRIGGER only (#245): it also sat in the suppression list, so an
  // equipment-schedule line reading "ESS" both raised this review and cleared it. Suppression
  // takes real detail evidence — a 706/R328/1207/NFPA 855 citation, clearances, fire separation.
  // A NEGATED mention is not storage scope (#257): "ESS: N/A", "NO ESS PROPOSED",
  // "BATTERY / ESS: NONE" — affirmedIn's negation read, plus a run of storage words before the
  // denial ("BATTERY / ESS: NONE", "NO BATTERY / ESS").
  if (affirmedIn(batterySources, ESS_TRIGGER_PATTERNS, essMentionDenied)
    && !hasAny(batteryText, [
      /clearance/i, /working\s*space/i,
      /\b706\b/i, /R\s*328/i, /\b1207\b/i, /NFPA\s*855/i,
      /fire\s*(?:separation|barrier|rating)|fire.?rated/i,
    ])) {
    out.push(finding({
      id: "city.ess.details-missing",
      severity: "warning",
      category: "electrical",
      title: "Battery/ESS detail not reviewable",
      message: "Battery/ESS scope appears present but location, clearance, disconnect, and fire-code details are not obvious.",
      cityFeedback: "Provide ESS equipment schedule, location plan, working clearance, ventilation/listing basis, disconnect/emergency shutdown details, labels, and local fire-code notes.",
      designTeamAction: "Add ESS detail sheets and verify local fire/AHJ requirements.",
      evidenceNeeded: ["ESS model/quantity", "ESS location plan", "Clearance and working space notes", "Disconnect/shutdown/label callouts"],
      codeReferences: [essRef],
    }));
  }

  return out;
}
