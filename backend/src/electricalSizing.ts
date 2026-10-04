// RECOMPUTE THE ELECTRICAL SIZING FROM THE SLD'S OWN NUMBERS (#144).
//
// The gate used to read the plan's calcs and ask whether they were PRESENT. A city plan checker
// redoes the arithmetic: the 705.12 busbar screen with the inverter's real output current, the
// inverter output circuit's OCPD against 1.25 x its current and against the conductor's ampacity
// after the 310.15 corrections, the string's cold-weather Voc against the inverter and the 690.7
// 600 V ceiling, and (advisory) the voltage drop on a stated run. This module does that, from
// values the parser already captures plus the sheet text — no vision call, no LLM call.
//
// SEVERITY IS ABOUT WHERE THE NUMBERS CAME FROM, not about how far over the line they are:
//   - every input the arithmetic USED is stated on the package's own sheets  -> BLOCKER. These are
//     plan-internal facts: the city rejects a set whose own numbers fail, whatever we know about
//     the jurisdiction;
//   - any input only the parser read                                         -> WARNING. A misread
//     must never block a filing on its own;
//   - inputs the check needs but nobody stated                               -> one CALLOUT
//     (city.elec.sizing-inputs-missing) naming what the SLD must state.
// An assumption FAVOURABLE to the design (no conduit-fill derate when the count is not stated, a
// 30 C ambient when no design high is stated, the 90 C column when the insulation is unnamed) is
// not an input: a design that fails even under it fails for real, so it does not soften severity.
//
// Every message prints the arithmetic so a reviewer can redo it by hand. Every finding id here is
// in reviewerVision's MEASURED_FINDING_IDS: a picture of the SLD says the calc is on the sheet,
// never that it passes.
import type { CodeReference, ElectricalSizingInput, ElectricalSizingInputKey, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { sheetTextSources, type DesignTextSource } from "./designCriteria";
import { dcDcConverterEvidence, nextStandardOcpd, table6907AFactor } from "./iowaPvWorksheet";

export const SIZING_FINDING_IDS = [
  "city.elec.sizing-busbar-120",
  "city.elec.sizing-ocpd-under-125",
  "city.elec.sizing-ocpd-over-ampacity",
  "city.elec.sizing-string-voc",
  "city.elec.sizing-voltage-drop",
  "city.elec.sizing-inputs-missing",
] as const;

const NEC_URL = "https://www.nfpa.org/codes-and-standards/nfpa-70-standard-development/70";
const busbarRef: CodeReference = {
  code: "NEC", section: "705.12(B)(3)(2)", title: "Load-side connections — the 120 percent busbar rule",
  adoptionScope: "PV connected on the load side of service equipment.", sourceUrl: NEC_URL,
  note: "125 percent of the power source output circuit current plus the busbar's main OCPD may not exceed 120 percent of the busbar rating.",
};
const ocpdRef: CodeReference = {
  code: "NEC", section: "690.9 / 240.4 / 310.15", title: "Inverter output circuit OCPD and conductor ampacity",
  adoptionScope: "PV inverter output circuits.", sourceUrl: NEC_URL,
  note: "OCPD at least 125 percent of the continuous output current (690.9(B)), and no larger than the conductor's ampacity after 310.15(B) ambient and 310.15(C)(1) fill corrections (240.4, next size up per 240.4(B); 240.4(D) small-conductor limits).",
};
const maxVoltageRef: CodeReference = {
  code: "NEC", section: "690.7", title: "Maximum PV system voltage",
  adoptionScope: "PV source and output circuits.", sourceUrl: NEC_URL,
  note: "Voc corrected to the lowest expected ambient (690.7(A)(1) datasheet coefficient or Table 690.7(A)); at most 600 V on one- and two-family dwellings and at most the inverter's listed maximum DC input.",
};
const voltageDropRef: CodeReference = {
  code: "NEC", section: "210.19(A) Informational Note 4 / 215.2(A)(2) Informational Note 2", title: "Voltage drop (advisory)",
  adoptionScope: "Advisory; not an enforceable requirement unless the AHJ amends it in.", sourceUrl: NEC_URL,
  note: "The informational notes recommend no more than 3 percent drop on a branch circuit or feeder.",
};

// NEC Table 310.16 (60 / 75 / 90 C columns), copper and aluminum, AWG 14 - 4/0.
const AMPACITY: Record<"CU" | "AL", Record<string, [number, number, number]>> = {
  CU: {
    "14": [15, 20, 25], "12": [20, 25, 30], "10": [30, 35, 40], "8": [40, 50, 55], "6": [55, 65, 75],
    "4": [70, 85, 95], "3": [85, 100, 115], "2": [95, 115, 130], "1": [110, 130, 145],
    "1/0": [125, 150, 170], "2/0": [145, 175, 195], "3/0": [165, 200, 225], "4/0": [195, 230, 260],
  },
  AL: {
    "12": [15, 20, 25], "10": [25, 30, 35], "8": [35, 40, 45], "6": [40, 50, 55], "4": [55, 65, 75],
    "3": [65, 75, 85], "2": [75, 90, 100], "1": [85, 100, 115],
    "1/0": [100, 120, 135], "2/0": [115, 135, 150], "3/0": [130, 155, 175], "4/0": [150, 180, 205],
  },
};
// NEC Chapter 9 Table 8, DC resistance at 75 C, ohms per 1000 ft, stranded uncoated copper / aluminum.
const RESISTANCE: Record<"CU" | "AL", Record<string, number>> = {
  CU: { "14": 3.14, "12": 1.98, "10": 1.24, "8": 0.778, "6": 0.491, "4": 0.308, "3": 0.245, "2": 0.194, "1": 0.154, "1/0": 0.122, "2/0": 0.0967, "3/0": 0.0766, "4/0": 0.0608 },
  AL: { "12": 3.25, "10": 2.04, "8": 1.28, "6": 0.808, "4": 0.508, "3": 0.403, "2": 0.319, "1": 0.253, "1/0": 0.201, "2/0": 0.159, "3/0": 0.126, "4/0": 0.1 },
};
// 240.4(D) small-conductor OCPD ceilings.
const SMALL_CONDUCTOR_MAX: Record<"CU" | "AL", Record<string, number>> = { CU: { "14": 15, "12": 20, "10": 30 }, AL: { "12": 15, "10": 25 } };
// NEC Table 310.15(B)(1) ambient correction (30 C basis): [upper bound C, 60 C, 75 C, 90 C column].
const AMBIENT: Array<[number, number, number, number]> = [
  [30, 1, 1, 1], [35, 0.91, 0.94, 0.96], [40, 0.82, 0.88, 0.91], [45, 0.71, 0.82, 0.87], [50, 0.58, 0.75, 0.82],
  [55, 0.41, 0.67, 0.76], [60, 0, 0.58, 0.71], [65, 0, 0.47, 0.65], [70, 0, 0.33, 0.58], [75, 0, 0, 0.5], [80, 0, 0, 0.41], [85, 0, 0, 0.29],
];
// NEC Table 310.15(C)(1): more than three current-carrying conductors in a raceway.
function fillAdjustment(count: number): number {
  if (count <= 3) return 1;
  if (count <= 6) return 0.8;
  if (count <= 9) return 0.7;
  if (count <= 20) return 0.5;
  if (count <= 30) return 0.45;
  if (count <= 40) return 0.4;
  return 0.35;
}
const COLUMN_INDEX: Record<60 | 75 | 90, 0 | 1 | 2> = { 60: 0, 75: 1, 90: 2 };
function ambientFactor(tempC: number, column: 60 | 75 | 90): number {
  // Below 30 C the table would RAISE the ampacity; we never take that credit (favourable to nobody).
  for (const row of AMBIENT) if (tempC <= row[0]) return row[COLUMN_INDEX[column] + 1];
  return 0;
}

export interface ParsedConductor {
  size: string;
  material: "CU" | "AL";
  /** Insulation temperature column, or null when the insulation is not named. */
  column: 60 | 75 | 90 | null;
  insulation: string;
}

/** "#10 AWG THWN-2 CU", "(3) 8 AWG XHHW-2 AL", "10 AWG CU THWN-2" -> size / material / column. */
export function parseConductor(raw: string): ParsedConductor | null {
  const text = raw.toUpperCase();
  const m = /(?:#\s*|\b)(14|12|10|8|6|4|3|2|1|[1-4]\s*\/\s*0)\s*(?:AWG\b)?(?=[\s,)]|$)/.exec(text.replace(/\(\s*\d+\s*\)/g, " "));
  if (!m) return null;
  // A bare number is a conductor size only when something says so ("#", or "AWG").
  if (!/#|AWG/.test(text)) return null;
  const size = m[1].replace(/\s/g, "");
  const material: "CU" | "AL" = /\bAL\b|ALUMIN/.test(text) ? "AL" : "CU";
  if (!AMPACITY[material][size]) return null;
  const ins = /\b(THWN-2|THHN|XHHW-2|USE-2|RHW-2|PV\s*WIRE|THWN|THW|XHHW|UF(?:-B)?|NM-B|TW)\b/.exec(text);
  const insulation = ins ? ins[1].replace(/\s+/g, " ") : "";
  let column: 60 | 75 | 90 | null = null;
  if (ins) {
    // NM-B is 90 C insulation but 334.80 holds it to the 60 C column.
    if (/^(UF|UF-B|NM-B|TW)$/.test(insulation)) column = 60;
    else if (/^(THWN|THW|XHHW)$/.test(insulation)) column = 75;
    else column = 90;
  }
  return { size, material, column, insulation };
}

// --- reading values off the sheets --------------------------------------------------------------

type Reader = (text: string) => number[];
const NUM = String.raw`(-?\d{1,4}(?:\.\d{1,3})?)`;
function labelled(label: string, unit: string, valueFirst = true): Reader {
  const after = new RegExp(String.raw`\b(?:${label})\b\s*(?:\([A-Z]+\))?\s*[:=]?\s*${NUM}\s*(?:${unit})`, "gi");
  const before = new RegExp(String.raw`${NUM}\s*(?:${unit})\s*(?:${label})\b`, "gi");
  return (text) => [
    ...[...text.matchAll(after)].map((m) => Number(m[1])),
    ...(valueFirst ? [...text.matchAll(before)].map((m) => Number(m[1])) : []),
  ].filter(Number.isFinite);
}
const AMPS = String.raw`A\b|AMPS?\b`;
const VOLTS = String.raw`V\b|VDC\b|VOLTS?\b`;
function temperature(label: string): Reader {
  const re = new RegExp(String.raw`\b(?:${label})\b\s*(?:\([^)]{0,12}\))?\s*[:=]?\s*(-?\d{1,3}(?:\.\d)?)\s*°?\s*([CF])\b`, "gi");
  return (text) => [...text.matchAll(re)].map((m) => {
    const v = Number(m[1]);
    return m[2].toUpperCase() === "F" ? Math.round(((v - 32) * 5) / 9 * 10) / 10 : v;
  });
}
const READERS: Partial<Record<ElectricalSizingInputKey, Reader>> = {
  busRating: labelled(String.raw`BUS\s*BAR(?:\s+RATING)?|BUSBAR(?:\s+RATING)?|BUS\s+RATING`, AMPS),
  mainBreaker: labelled(String.raw`MAIN\s+(?:BREAKER|OCPD|DISCONNECT)(?:\s+RATING)?`, AMPS),
  pvBreaker: labelled(String.raw`(?:PV|SOLAR)\s+(?:BACK\s*-?\s*FEED\s+)?(?:BREAKER|OCPD)|BACK\s*-?\s*FEED(?:ING)?\s+(?:BREAKER|OCPD)`, AMPS),
  invOutputW: labelled(String.raw`(?:MAX(?:IMUM|\.)?\s+)?(?:CONT(?:INUOUS|\.)?\s+)?OUTPUT\s+CURRENT`, AMPS, false),
  pvMicroOutputW: labelled(String.raw`(?:MAX(?:IMUM|\.)?\s+)?(?:CONT(?:INUOUS|\.)?\s+)?OUTPUT\s+CURRENT`, AMPS, false),
  moduleVoc: labelled(String.raw`OPEN[-\s]CIRCUIT\s+VOLTAGE|V\s?OC`, VOLTS, false),
  moduleVocTempCoeff: (text) => [...text.matchAll(/\bTEMPERATURE\s+COEFFICIENT\s+(?:OF\s+)?V\s?OC\s*(?:\(β\)|\(BETA\))?\s*[:=]?\s*(-\s?0?\.\d{1,3})\s*%/gi)].map((m) => Number(m[1].replace(/\s/g, ""))),
  modulesPerString: (text) => [
    ...[...text.matchAll(/\b(\d{1,2})\s*MODULES?\s*(?:IN\s+SERIES|PER\s+STRING|\/\s*STRING)/gi)].map((m) => Number(m[1])),
    ...[...text.matchAll(/\bMODULES?\s+PER\s+STRING\s*[:=]?\s*(\d{1,2})\b/gi)].map((m) => Number(m[1])),
    ...[...text.matchAll(/\bSTRINGS?\s+OF\s+(\d{1,2})\s*(?:MODULES?|PANELS?)/gi)].map((m) => Number(m[1])),
  ],
  siteLowTempC: temperature(String.raw`(?:ASHRAE\s+)?(?:EXTREME\s+)?(?:MIN(?:IMUM|\.)?|LOW(?:EST)?|RECORD\s+LOW|COLD(?:EST)?)\s+(?:DESIGN\s+|AMBIENT\s+|RECORD\s+|EXPECTED\s+)?(?:AMBIENT\s+)?TEMP(?:ERATURE)?|DESIGN\s+LOW\s+TEMP(?:ERATURE)?`),
  siteHighTempC: temperature(String.raw`(?:HIGH|MAX(?:IMUM|\.)?)\s+(?:DESIGN|AMBIENT)\s+TEMP(?:ERATURE)?|DESIGN\s+HIGH\s+TEMP(?:ERATURE)?|ASHRAE\s+(?:2|0\.4)\s*%\s*(?:HIGH\s+|DESIGN\s+)*TEMP(?:ERATURE)?`),
  invMaxDcInputV: labelled(String.raw`MAX(?:IMUM|\.)?\s+(?:DC\s+)?INPUT\s+(?:DC\s+)?VOLTAGE`, VOLTS, false),
  pvMicroMaxDcInputV: labelled(String.raw`MAX(?:IMUM|\.)?\s+(?:DC\s+)?INPUT\s+(?:DC\s+)?VOLTAGE`, VOLTS, false),
  acRunLengthFt: (text) => [
    ...[...text.matchAll(/\b(?:RUN|CIRCUIT|WIRE|CONDUCTOR|ONE[-\s]WAY)\s+LENGTH\s*[:=]?\s*(\d{1,4}(?:\.\d)?)\s*(?:FT\b|FEET\b|')/gi)].map((m) => Number(m[1])),
    ...[...text.matchAll(/\b(\d{1,4}(?:\.\d)?)\s*(?:FT\b|FEET\b|')\s*(?:ONE[-\s]WAY|RUN\b)/gi)].map((m) => Number(m[1])),
  ],
};

const same = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.005);

function snapshotNumber(project: ProjectRecord, key: string): number | null {
  const raw = project.parserSnapshot?.[key];
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const nums = String(raw).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/g);
  // One number means one number; "200A (Note 3)" is not 2003 (see codeReviewRules.parseRating).
  if (!nums) return null;
  const withUnit = String(raw).match(/-?\d+(?:\.\d+)?(?=\s*(?:A\b|AMPS?\b|V\b|VOLTS?\b|°|FT\b|FEET\b|'|%))/gi);
  const pick = nums.length === 1 ? nums[0] : withUnit && new Set(withUnit).size === 1 ? withUnit[0] : null;
  const value = pick == null ? null : Number.parseFloat(pick);
  return value != null && Number.isFinite(value) ? value : null;
}

/**
 * One sizing input: the parser's value, confirmed when the sheets state the same value under the
 * input's label. With no parser value, ONE distinct stated value is used (document-stated); two
 * distinct values on the sheets are a conflict for a human, not a pick.
 */
function readInput(project: ProjectRecord, sheetText: string, key: ElectricalSizingInputKey): ElectricalSizingInput | null {
  const parsed = snapshotNumber(project, key);
  const stated = READERS[key]?.(sheetText) ?? [];
  if (parsed != null) return { key, value: parsed, documentStated: stated.some((v) => same(v, parsed)) };
  const distinct = [...new Set(stated)];
  return distinct.length === 1 ? { key, value: distinct[0], documentStated: true } : null;
}

const fmt = (n: number, d = 2): string => String(Math.round(n * 10 ** d) / 10 ** d);
const tag = (i: ElectricalSizingInput): string => (i.documentStated ? "" : " (parser)");
const severityOf = (inputs: ElectricalSizingInput[]): ReviewerFinding["severity"] =>
  inputs.every((i) => i.documentStated) ? "blocker" : "warning";
const provenance = (inputs: ElectricalSizingInput[]): string => {
  const parserOnly = inputs.filter((i) => !i.documentStated).map((i) => i.key);
  return parserOnly.length
    ? ` Values marked (parser) were read by the parser but not found stated on the sheets (${parserOnly.join(", ")}); confirm them before treating this as a rejection.`
    : " Every value above is stated on the plan set's own sheets.";
};

function finding(input: Omit<ReviewerFinding, "category" | "installerCallout">): ReviewerFinding {
  return { ...input, category: "electrical", installerCallout: true };
}

// --- which conductor the PV breaker protects ----------------------------------------------------

// A conductor callout on the sheets: "#8 AWG THWN-2", "#12 CU", "10 AWG". A bare "#2" is a note
// marker unless a size word or a material/insulation follows it closely.
const CONDUCTOR_MENTION = /(?:#\s*([1-4]\s*\/\s*0|14|12|10|8|6|4|3|2|1)\b(?=\s*AWG\b|[^#;\n]{0,16}?\b(?:CU|AL|COPPER|ALUMINUM|THWN|THHN|XHHW|USE|RHW|PV\s*WIRE|THW|UF|NM-B|TW)\b)|\b([1-4]\s*\/\s*0|14|12|10|8|6|4|3|2|1)\s*AWG\b)/gi;
const conductorSizesIn = (text: string): string[] =>
  [...text.matchAll(CONDUCTOR_MENTION)].map((m) => (m[1] ?? m[2]).replace(/\s/g, ""));
// The circuit the PV breaker protects, by its label on the SLD / wire schedule. A BRANCH circuit
// (an Enphase combiner's #12 / 20 A branches) is never it, even when the line also names the PV.
const OUTPUT_CIRCUIT_LABEL = /\b(?:(?:INVERTER|PV|SOLAR|AC|COMBINER)\s+(?:AC\s+)?OUTPUT(?:\s+CIRCUIT)?|BACK\s*-?\s*FEED(?:ING)?|(?:PV|SOLAR)\s+(?:BREAKER|OCPD)|INTERCONNECTION\s+CONDUCTORS?)\b/i;

/**
 * Is `conductor` stated on the sheets AS the PV output circuit's conductor? Finding the string
 * somewhere is not enough (Helm's review of #152): on a micro system with a combiner, two #12 /
 * 20 A branches and a 40 A backfeed on #8, the parser's acConductor pairing of the breaker with
 * the #12 is a parser judgement, and a parser judgement may only ever warn (#141). So:
 *   - one distinct conductor size on the whole package -> there is no other circuit to confuse
 *     it with: stated when it appears;
 *   - more than one -> stated only on a segment (a line or schedule row) that carries an output-
 *     circuit / PV-breaker label, names no branch, and names no other conductor size.
 */
export function conductorStatedAsOutputCircuit(conductor: ParsedConductor, sheetText: string): boolean {
  const sizes = new Set(conductorSizesIn(sheetText));
  if (!sizes.has(conductor.size)) return false;
  if (sizes.size === 1) return true;
  return sheetText.split(/[\n;]|\.(?=\s|$)/).some((segment) => {
    if (!OUTPUT_CIRCUIT_LABEL.test(segment) || /\bBRANCH/i.test(segment)) return false;
    const here = new Set(conductorSizesIn(segment));
    return here.size === 1 && here.has(conductor.size);
  });
}

export interface ElectricalSizingOptions {
  /** Per-document texts (one per uploaded document); the snapshot's sheet text is read too. */
  documentTexts?: DesignTextSource[];
  /** The interconnection classifies as LOAD side — only then is 705.12(B)(3)(2) the test. */
  loadSide?: boolean;
  /** city.elec.load-side-over-120 already reported this busbar on the breaker rating; a second
   *  blocker for the same violation is noise. */
  skipBusbar?: boolean;
  /** The jurisdiction's adopted-edition citation resolver (codeReviewRules' `cite`). */
  cite?: (code: string, fallback: CodeReference) => CodeReference;
}

/**
 * The inverter output circuit's continuous current: per-unit output current x quantity.
 * Returns the inputs it used so severity can follow their provenance.
 */
function outputCurrent(project: ProjectRecord, sheetText: string, micro: boolean): { amps: number; inputs: ElectricalSizingInput[]; calc: string } | null {
  const unit = readInput(project, sheetText, micro ? "pvMicroOutputW" : "invOutputW");
  // PLAUSIBILITY (baselineRules' xcheck-pv-breaker-125): a per-unit "current" above 100 A is a
  // watt rating in the amps field. Silence beats a confident calculation on a unit error.
  if (!unit || !(unit.value > 0) || unit.value > 100) return null;
  const qtyKey = micro ? "pvMicroQty" : "invQty";
  const qtyParsed = snapshotNumber(project, qtyKey);
  const qty = qtyParsed ?? (micro ? null : 1);
  if (qty == null || !(qty > 0)) return null;
  const amps = unit.value * qty;
  if (amps > 400) return null;
  const inputs = [unit];
  if (qty !== 1) {
    // A quantity is stated when the sheets print it against the unit's model: "(20) ENPHASE IQ8M-72-2-US".
    const model = String(project.parserSnapshot?.[micro ? "pvMicroModel" : "invModel"] ?? "").trim().split(/\s+/)[0] ?? "";
    const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const qtyStated = escaped.length >= 3 && new RegExp(String.raw`(?:\(\s*${qty}\s*\)|\b${qty}\s*(?:X\b|PCS\b)?)\s*(?:NEW\s+)?(?:[A-Z][\w.&-]*\s+){0,2}${escaped}`, "i").test(sheetText);
    inputs.push({ key: qtyKey, value: qty, documentStated: qtyStated });
  }
  const calc = qty === 1 ? `${fmt(unit.value)} A${tag(unit)}` : `${qty}${tag(inputs[1])} x ${fmt(unit.value)} A${tag(unit)} = ${fmt(amps)} A`;
  return { amps, inputs, calc };
}

export function evaluateElectricalSizingFindings(project: ProjectRecord, opts: ElectricalSizingOptions = {}): ReviewerFinding[] {
  const out: ReviewerFinding[] = [];
  const cite = opts.cite ?? ((_code: string, fallback: CodeReference) => fallback);
  const sheetText = sheetTextSources(project, opts.documentTexts ?? []).map((s) => s.text).join("\n");
  const missing: string[] = [];
  const input = (key: ElectricalSizingInputKey) => readInput(project, sheetText, key);
  // Topology the way iowaPvWorksheet reads it: a micro make/model wins (parser.html also copies a
  // micro's make/model/amps into the inv* fields), otherwise an inv* make/model is a string inverter.
  const snap = (key: string): string => String(project.parserSnapshot?.[key] ?? "").trim();
  const micro = Boolean(snap("pvMicroMake") || snap("pvMicroModel"));
  const stringInverter = !micro && Boolean(snap("invMake") || snap("invModel"));
  const current = outputCurrent(project, sheetText, micro);

  // (a) 705.12(B)(3)(2): 125 % of the inverter output current + the main OCPD <= 120 % of the bus.
  if (opts.loadSide && !opts.skipBusbar && current) {
    const bus = input("busRating");
    const main = input("mainBreaker");
    if (bus && main && bus.value > 0) {
      const lhs = current.amps * 1.25 + main.value;
      const allowance = bus.value * 1.2;
      if (lhs > allowance + 1e-9) {
        const used = [...current.inputs, bus, main];
        out.push(finding({
          id: "city.elec.sizing-busbar-120",
          severity: severityOf(used),
          title: "Busbar over 120 percent with the inverter's actual output current",
          message: `705.12(B)(3)(2): inverter output current ${current.calc}; 1.25 x ${fmt(current.amps)} A = ${fmt(current.amps * 1.25)} A + ${fmt(main.value)} A main${tag(main)} = ${fmt(lhs)} A, above 120 % of the ${fmt(bus.value)} A${tag(bus)} busbar (1.2 x ${fmt(bus.value)} = ${fmt(allowance)} A) by ${fmt(lhs - allowance)} A.${provenance(used)}`,
          cityFeedback: "The load-side connection exceeds the 120 percent busbar allowance using the inverter's own output current. Revise: de-rate the main, connect supply side, upgrade the service panel, or provide another 705.12(B)(3) compliant method.",
          designTeamAction: "Correct the interconnection and show the 705.12(B)(3)(2) calculation with the inverter output current on the SLD.",
          evidenceNeeded: ["Busbar rating", "Main breaker rating", "Inverter maximum continuous output current and quantity", "705.12(B)(3) calculation"],
          codeReferences: [cite("NEC", busbarRef)],
        }));
      }
    }
  }

  // (b) The inverter output circuit: OCPD >= 1.25 x Imax, and OCPD <= the conductor's ampacity.
  const breaker = input("pvBreaker");
  const conductorRaw = snap("acConductor");
  const conductor = conductorRaw ? parseConductor(conductorRaw) : null;
  if (breaker && current) {
    const minOcpd = current.amps * 1.25;
    if (breaker.value < minOcpd - 0.01) {
      const used = [breaker, ...current.inputs];
      out.push(finding({
        id: "city.elec.sizing-ocpd-under-125",
        severity: severityOf(used),
        title: "Inverter output OCPD below 125 percent of the output current",
        message: `690.9(B): inverter output current ${current.calc}; 1.25 x ${fmt(current.amps)} A = ${fmt(minOcpd)} A minimum OCPD (next standard size ${nextStandardOcpd(minOcpd) ?? "> 400"} A), but the PV breaker is ${fmt(breaker.value)} A${tag(breaker)}.${provenance(used)}`,
        cityFeedback: "The PV output circuit overcurrent device is smaller than 125 percent of the inverter's continuous output current. Resize the OCPD (and the conductors with it) and update the SLD.",
        designTeamAction: "Resize the PV breaker to at least 1.25 x the inverter output current (next standard size), re-check the conductor and the busbar screen with the new size.",
        evidenceNeeded: ["Inverter maximum continuous output current and quantity", "PV breaker / OCPD rating", "Conductor size"],
        codeReferences: [cite("NEC", ocpdRef)],
      }));
    }
  }
  if (breaker && conductor) {
    const high = input("siteHighTempC");
    const count = input("acConductorCount");
    const column = conductor.column ?? 90; // unnamed insulation: the FAVOURABLE assumption
    const base = AMPACITY[conductor.material][conductor.size][COLUMN_INDEX[column]];
    const ambient = high ? Math.min(1, ambientFactor(high.value, column)) : 1;
    const fill = count ? fillAdjustment(count.value) : 1;
    const derated = base * ambient * fill;
    // 110.14(C): terminations at 75 C (60 C for NM-B/UF) cap the usable ampacity.
    const terminal = AMPACITY[conductor.material][conductor.size][COLUMN_INDEX[column === 60 ? 60 : 75]];
    const ampacity = Math.min(derated, terminal);
    const small = SMALL_CONDUCTOR_MAX[conductor.material][conductor.size];
    const nextUp = nextStandardOcpd(ampacity) ?? Infinity;
    const maxOcpd = Math.min(nextUp, small ?? Infinity);
    if (breaker.value > maxOcpd + 1e-9) {
      const used: ElectricalSizingInput[] = [breaker, { key: "acConductor", value: 0, documentStated: conductorStatedAsOutputCircuit(conductor, sheetText) }];
      if (high) used.push(high);
      if (count) used.push(count);
      const steps = [
        `#${conductor.size} ${conductor.material}${conductor.insulation ? ` ${conductor.insulation}` : " (insulation not stated; 90 C column assumed)"}${tag(used[1])}: ${base} A (Table 310.16, ${column} C)`,
        high ? `x ${fmt(ambient)} ambient at ${fmt(high.value, 1)} C${tag(high)}` : "x 1.00 ambient (no design high stated; 30 C assumed)",
        count ? `x ${fmt(fill)} for ${count.value} current-carrying conductors${tag(count)}` : "x 1.00 fill (count not stated; 3 or fewer assumed)",
        ampacity < derated ? `= ${fmt(derated)} A, limited to ${fmt(ampacity)} A by ${column === 60 ? 60 : 75} C terminations (110.14(C))` : `= ${fmt(derated)} A`,
      ];
      out.push(finding({
        id: "city.elec.sizing-ocpd-over-ampacity",
        severity: severityOf(used),
        title: "Inverter output OCPD larger than the conductor's corrected ampacity",
        message: `310.15 / 240.4: ${steps.join(" ")}; largest permitted OCPD ${fmt(maxOcpd)} A${small != null && small <= nextUp ? ` (240.4(D) small-conductor limit)` : nextUp > ampacity + 1e-9 ? " (240.4(B) next standard size up)" : ""}, but the PV breaker is ${fmt(breaker.value)} A${tag(breaker)}.${provenance(used)}`,
        cityFeedback: "The PV output circuit conductors are not protected by the overcurrent device shown once ambient and conduit-fill corrections are applied. Upsize the conductors or show the correction basis that supports them.",
        designTeamAction: "Upsize the inverter output circuit conductors (or reduce the OCPD if 1.25 x output current allows) and show the ampacity calculation on the SLD/wire schedule.",
        evidenceNeeded: ["Conductor size, material and insulation", "Current-carrying conductors per raceway", "Design high ambient temperature", "PV breaker / OCPD rating"],
        codeReferences: [cite("NEC", ocpdRef)],
      }));
    }
  }
  if ((current || conductor) && !(breaker && current && conductor)) {
    const need = [
      !breaker ? "PV breaker / output circuit OCPD rating" : "",
      !current ? "inverter maximum continuous output current (per unit) and quantity" : "",
      !conductor ? "inverter output circuit conductor size, material and insulation" : "",
    ].filter(Boolean);
    missing.push(`OCPD and conductor sizing (690.9 / 310.15): ${need.join("; ")}`);
  }

  // (c) 690.7: the coldest-morning string voltage against the inverter's maximum DC input and the
  // 600 V dwelling ceiling. Optimizer systems answer to 690.7(B) (the listed DC-DC system), not this.
  const optimizer = dcDcConverterEvidence(project.parserSnapshot ?? {}, stringInverter).present;
  const voc = input("moduleVoc");
  const low = input("siteLowTempC");
  const perString = micro ? null : input("modulesPerString");
  if (!optimizer && (stringInverter || micro)) {
    const betaInput = input("moduleVocTempCoeff");
    // A coefficient outside 0.05-1 %/C is a broken read (iowaPvWorksheet's bound): use the table.
    const beta = betaInput && Math.abs(betaInput.value) >= 0.05 && Math.abs(betaInput.value) <= 1 ? betaInput : null;
    const series = micro ? 1 : perString?.value ?? null;
    if (voc && low && series != null && series > 0) {
      const factor = beta ? 1 + (Math.abs(beta.value) / 100) * (25 - low.value) : table6907AFactor(low.value);
      if (factor != null) {
        const maxV = voc.value * Math.max(1, factor) * series;
        const limitInput = input(micro ? "pvMicroMaxDcInputV" : "invMaxDcInputV");
        const limits: Array<{ v: number; what: string; input?: ElectricalSizingInput }> = [];
        if (!micro) limits.push({ v: 600, what: "limit for one- and two-family dwellings (690.7)" });
        if (limitInput && limitInput.value > 0) limits.push({ v: limitInput.value, what: `${micro ? "microinverter" : "inverter"} maximum DC input${tag(limitInput)}`, input: limitInput });
        const exceeded = limits.filter((l) => maxV > l.v + 1e-9).sort((a, b) => a.v - b.v);
        if (exceeded.length) {
          // Severity follows the inputs of the LOWEST limit exceeded — if only the inverter limit
          // is crossed, the inverter's rating is an input; the 600 V ceiling is code, not an input.
          const governing = exceeded.find((l) => !l.input) ?? exceeded[0];
          const used = [voc, low, ...(beta ? [beta] : []), ...(perString ? [perString] : []), ...(governing.input ? [governing.input] : [])];
          const factorText = beta
            ? `(1 + ${fmt(Math.abs(beta.value), 3)} %/C${tag(beta)} x (25 - (${fmt(low.value, 1)})) C) = ${fmt(factor, 4)}`
            : `Table 690.7(A) factor ${factor} at ${fmt(low.value, 1)} C`;
          out.push(finding({
            id: "city.elec.sizing-string-voc",
            severity: severityOf(used),
            title: micro ? "Module cold-weather Voc above the microinverter's maximum DC input" : "String voltage at the design low temperature exceeds the limit",
            message: `690.7(A): ${fmt(voc.value)} V Voc${tag(voc)} x ${factorText}${micro ? "" : ` x ${fmt(series, 0)} modules in series${tag(perString as ElectricalSizingInput)}`} = ${fmt(maxV, 1)} V at ${fmt(low.value, 1)} C${tag(low)}, above the ${exceeded.map((l) => `${fmt(l.v, 0)} V ${l.what}`).join(" and the ")}.${provenance(used)}`,
            cityFeedback: micro
              ? "The module's cold-weather open-circuit voltage exceeds the microinverter's maximum DC input. Pair a compatible module and microinverter."
              : "The PV source circuit's maximum voltage at the design low temperature exceeds the permitted limit. Shorten the strings and show the 690.7 calculation on the SLD.",
            designTeamAction: micro
              ? "Confirm the module/microinverter pairing against both datasheets at the site's design low temperature."
              : "Re-string with fewer modules in series so the 690.7 corrected Voc stays under 600 V and the inverter's maximum DC input; update the string table.",
            evidenceNeeded: ["Module Voc and Voc temperature coefficient (datasheet)", "Site extreme minimum design temperature", micro ? "Microinverter maximum DC input voltage" : "Modules per string and inverter maximum DC input voltage"],
            codeReferences: [cite("NEC", maxVoltageRef)],
          }));
        }
      }
    }
    if ((voc || low || perString) && !(voc && low && (micro || perString))) {
      const need = [
        !voc ? "module Voc (datasheet)" : "",
        !low ? "site extreme minimum design temperature" : "",
        !micro && !perString ? "modules in series per string" : "",
      ].filter(Boolean);
      missing.push(`Maximum system voltage (690.7): ${need.join("; ")}`);
    }
  }

  // (d) Voltage drop on the inverter output circuit — advisory, and only on a STATED run length.
  const run = input("acRunLengthFt");
  if (run && run.value > 0 && conductor && current) {
    const r = RESISTANCE[conductor.material][conductor.size];
    const voltsRaw = snap("serviceVoltage");
    const volts = /\b208\b/.test(voltsRaw) ? 208 : 240;
    const drop = (2 * run.value * current.amps * r) / 1000;
    const pct = (drop / volts) * 100;
    if (pct > 3) {
      const used = [run, ...current.inputs];
      out.push(finding({
        id: "city.elec.sizing-voltage-drop",
        severity: "callout",
        title: "Inverter output circuit voltage drop above 3 percent (advisory)",
        message: `Voltage drop: 2 x ${fmt(run.value, 0)} ft${tag(run)} x ${current.calc.includes("=") ? `${fmt(current.amps)} A (${current.calc})` : current.calc} x ${r} ohm/kft (#${conductor.size} ${conductor.material}, Chapter 9 Table 8) / 1000 = ${fmt(drop)} V; ${fmt(drop)} / ${volts} V${voltsRaw ? "" : " (assumed)"} = ${fmt(pct)} %, above the 3 % the NEC informational notes recommend.${provenance(used)}`,
        cityFeedback: "The inverter output circuit's voltage drop exceeds 3 percent on the stated run length. Many reviewers ask for a larger conductor or a voltage-drop justification; inverters may also trip on high grid voltage.",
        designTeamAction: "Upsize the conductor or show the voltage-drop calculation and the inverter's voltage window on the SLD.",
        evidenceNeeded: ["Run length", "Conductor size", "Voltage-drop calculation"],
        codeReferences: [cite("NEC", voltageDropRef)],
      }));
    }
  }

  if (missing.length) {
    out.push(finding({
      id: "city.elec.sizing-inputs-missing",
      severity: "callout",
      title: "SLD does not state every value the sizing checks need",
      message: `The electrical sizing could not be recomputed in full. Missing: ${missing.join(". ")}.`,
      cityFeedback: "State on the SLD / wire schedule the values a plan checker recomputes: inverter output current and quantity, OCPD ratings, conductor size/material/insulation and count per raceway, module Voc and string length, and the site design temperatures.",
      designTeamAction: "Add the missing values to the SLD so the sizing can be checked before submittal.",
      evidenceNeeded: missing,
      codeReferences: [cite("NEC", ocpdRef), cite("NEC", maxVoltageRef)],
    }));
  }
  return out;
}
