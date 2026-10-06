// THE IOWA STATE FIRE MARSHAL PV WORKSHEET (2020 NEC), FILLED FROM THE PROJECT.
//
// Iowa City's EnerGov "Residential Electrical - Solar" application REQUIRES an attachment card
// "Standard or Micro-Inverter Array ..." — the SFM Electrical Bureau's PHOTOVOLTAIC WORKSHEET
// (pages 2-4: PV system information + overview, interconnection, the 690.7/690.8/690.9
// calculation sheet, the final submittal checklist). In the 217-permit Iowa City corpus
// (.probe/kin/ia/corpus) the WORKSHEET is the top correction theme (8 permits), and on the five
// text worksheets checked against their own plan sets the applicants got it wrong in the same
// few places: max system voltage entered as 240 (AC) on micro systems (3 of 5), the
// interconnection box wrong/blank/ambiguous (3 of 5), page-3 calcs contradicting page 2 (4 of 5),
// circuit current as ONE micro's amps, arrays = module count, a worksheet stale after a revision.
//
// Every value here is either a PARSED field, a DERIVATION written out (so a reviewer can check
// the arithmetic), or an OPERATOR QUESTION when no document states it. Nothing is guessed:
//   - MAX SYSTEM VOLTAGE is NEC 690.7(A): the module's Voc corrected to the site's extreme low
//     temperature — per micro input on a micro system, times modules-in-series on a string.
//     Voc, the temperature coefficient (or the 690.7(A)(2) table) and the site low are all
//     required; any missing -> blank + a question. It is NEVER the 240 V AC service voltage.
//   - CIRCUIT CURRENT is qty x per-unit rated output current (amps — invOutputW/pvMicroOutputW
//     carry amps end to end), plus the ESS inverter's where one is AC-coupled.
//   - MIN PV OCPD is that current x 1.25, up to the next NEC 240.6(A) standard size.
//   - the 705.12(B) SUBSECTION is the plan's own cited method when it cites one, else derived
//     from bus / main / PV breaker (100% rule first, then 120% opposite-end).
//   - page 4 items 3, 4 and 10 ("filled out completely and accurately", "accuracy of all
//     calculations") are the filer's ATTESTATION — ticking them unread is the error the fill key
//     found on the operator's own copy. They are left for the person who files.
// Field ids are the fill key's (.probe/kin/ia/roesler/worksheet-fill-key.json).
import type { ProjectRecord } from "../../shared/src/types";
import { parseRating } from "./codeReviewRules";
import { evidenceForTopic } from "./projectEvidence";
import { moduleLevelElectronicsEquipment } from "./moduleLevelElectronics";
import { structureAnswerOf, structureDescriptionOf, structureMeaningOf } from "./applicationDocsAgency";

export interface WorksheetQuestion { key: string; label: string; options: string[]; kind: "form-fact" }
export interface IowaPvWorksheet {
  /** Field id -> value. Checkboxes are "X" or "". "" on a text field = unknown (see questions). */
  values: Record<string, string>;
  /** Field id -> where the value came from (parsed field, derivation with its arithmetic, or why blank). */
  basis: Record<string, string>;
  questions: WorksheetQuestion[];
}

/** NEC 240.6(A) standard ampere ratings (to 400 A). */
export const STANDARD_OCPD_AMPS = [15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200, 225, 250, 300, 350, 400];
export function nextStandardOcpd(amps: number): number | null {
  if (!(amps > 0)) return null;
  return STANDARD_OCPD_AMPS.find((s) => s >= amps - 1e-9) ?? null;
}

/** NEC 690.7(A)(2) Table 690.7(A): crystalline/multicrystalline Voc correction by the lowest
 *  expected ambient temperature (°C, upper bound of each row, descending). */
const TABLE_690_7A: Array<[number, number]> = [
  [24, 1.02], [19, 1.04], [14, 1.06], [9, 1.08], [4, 1.10], [-1, 1.12], [-6, 1.14],
  [-11, 1.16], [-16, 1.18], [-21, 1.20], [-26, 1.21], [-31, 1.23], [-36, 1.25],
];
export function table6907AFactor(lowC: number): number | null {
  if (lowC > 25) return 1;
  if (lowC < -40) return null;
  let f: number | null = null;
  for (const [upper, factor] of TABLE_690_7A) if (lowC <= upper) f = factor;
  return f;
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const fmt = (n: number, d = 2) => String(round(n, d));

/** The first number in a field ("45.27 V" -> 45.27, "-0.27 %/°C" -> -0.27). */
function firstNumber(raw: unknown): number | null {
  const m = String(raw ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** The service's LINE-TO-LINE voltage from how a plan writes it: "120/240V", "240/120V",
 *  "120/240 1PH" -> 240; "120/208 3PH" -> 208; "277/480Y" -> 480. A split-phase or wye service is
 *  written low/high in either order, so the value is the HIGHEST plausible voltage (100-600),
 *  never the last number — "240/120V" filed 120 on the worksheet. A current ("200A") is not a
 *  voltage. null when nothing reads as a voltage. */
export function serviceVoltageOf(raw: unknown): number | null {
  const t = String(raw ?? "");
  const volts: number[] = [];
  for (const m of t.matchAll(/(?<![\d.])(\d{3})(?![\d.])(?!\s*A(?:MPS?)?\b)/gi)) {
    const v = Number(m[1]);
    if (v >= 100 && v <= 600) volts.push(v);
  }
  return volts.length ? Math.max(...volts) : null;
}

export type InterconnectionSide = "supply" | "load" | "both" | "unknown";
/** Supply (line) side = NEC 705.11; load side = 705.12. A bare "705.12(A)" is the 2017 NEC's
 *  supply-side section (a 2022 Iowa City set cited it for a line-side tap), so it is not
 *  load-side evidence by itself. */
export function interconnectionSide(text: string): InterconnectionSide {
  const t = String(text ?? "");
  const supply = /supply.?side|supply breaker|line.?side|705\.11|ahead of (?:the )?main|feed.?thr(?:u|ough) lug|service.entrance tap/i.test(t);
  const load = /load.?side|back.?fed|back.?feed|705\.12(?!\s*\(A\))/i.test(t);
  return supply && load ? "both" : supply ? "supply" : load ? "load" : "unknown";
}

// ── THE PLAN'S OWN 705.12(B) METHOD, READ THROUGH THE EDITION IT IS CITED UNDER ──────────────
// The worksheet prints the 2020 NEC rows. A plan's citation is mapped to one of them by its SHAPE
// when the shape exists in only one edition, and by the EDITION TAG printed right before it
// ("2023 NEC 705.12(B)(2)") when the shape means different things in different editions:
//   (B)(1)(a|b), (B)(3)(1..6)  -> 2020 rows by shape (feeder a/b; busbar methods 1..6)
//   (B)(2)(3)(a|b|c)           -> 2017 busbar methods -> 2020 (B)(3)(1/2/3) by shape — even when
//                                 tagged "2020 NEC" (a corpus plan prints exactly that)
//   bare (B)(2)                -> 2020: Taps (B2). 2023: the 120% busbar method (B32) — the ONE
//                                 2023 mapping encoded here: the operator task statement
//                                 (2026-09-26) and an Iowa City plan printing "2023 NEC
//                                 705.12(B)(2)" on the 120% "do not relocate this overcurrent
//                                 device" label on a backfed breaker. Untagged, it is read from the
//                                 plan's own interconnection facts: a tap -> B2; a backfed breaker /
//                                 120% / opposite-end / do-not-relocate -> B32; neither or both ->
//                                 not established.
//   anything else, and any other 2023-tagged shape -> NOT MAPPED (an operator question and the
//                                 gate's edition callout) — no other 2023 row is encoded from memory.
// The edition tag must be LOCAL (within a few words before the citation); a document-wide edition
// is never assumed — spec sheets say "NEC 2017 compliant". Several DISTINCT rows cited in one set
// (general notes listing (B)(3)(2) and (B)(3)(3)) establish nothing on their own.
export type LoadSideCitationStatus = "established" | "multiple" | "ambiguous" | "unmapped" | "none";
export interface LoadSideCitation {
  status: LoadSideCitationStatus;
  /** The established row (status "established"), else "". */
  row: string;
  /** Distinct established rows (status "multiple": more than one). */
  rows: string[];
  quote: string;
  /** Why a citation is not mapped, naming it (for the operator question / the gate callout). */
  unmapped: string[];
  ambiguous: string[];
}
const LOAD_SIDE_2023: Record<string, string> = { "2": "B32" };
const quoteAt = (t: string, i: number, len: number) => t.slice(Math.max(0, i - 30), i + len + 30).trim();

export function loadSideCitation(text: string, opts: { interco?: string; edition?: "2020" } = {}): LoadSideCitation {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const interco = String(opts.interco ?? "");
  const found: Array<{ row: string; quote: string }> = [];
  const unmapped: string[] = [];
  const ambiguous: string[] = [];
  for (const m of t.matchAll(/705\.12\s*\(\s*B\s*\)((?:\s*\(\s*\w{1,2}\s*\)){1,3})/gi)) {
    const i = m.index ?? 0;
    const parts = [...m[1].matchAll(/\(\s*(\w{1,2})\s*\)/g)].map((p) => p[1].toLowerCase());
    const cite = `705.12(B)${parts.map((p) => `(${p})`).join("")}`;
    const quote = quoteAt(t, i, m[0].length);
    const tag = opts.edition ?? (/(?:\b(20\d\d)\s*(?:NEC|N\.E\.C\.?|NATIONAL ELECTRICAL CODE)|\bNEC\s*\(?(20\d\d)\)?)\s*(?:ART(?:ICLE)?\.?\s*|SEC(?:TION)?\.?\s*|§\s*)?$/i.exec(t.slice(Math.max(0, i - 30), i))?.slice(1).find(Boolean) ?? "");
    const [a, b, c] = parts;
    let row = "";
    // A bare 2020 HEADING ("705.12(B)(3)" = Busbars, "(B)(1)" = Feeders) names a family, not a row:
    // it establishes nothing and is not an edition problem — the plan's ratings pick the row.
    if (tag !== "2023" && parts.length === 1 && (a === "1" || a === "3")) continue;
    if (tag === "2023") {
      row = parts.length === 1 ? LOAD_SIDE_2023[a] ?? "" : "";
      if (!row) { unmapped.push(`"2023 NEC ${cite}" — no 2023-to-2020 row map is encoded for it`); continue; }
    } else if (a === "1" && /^[ab]$/.test(b ?? "") && !c) row = `B1${b}`;
    else if (a === "3" && /^[1-6]$/.test(b ?? "") && !c) row = `B3${b}`;
    else if (a === "2" && b === "3" && /^[abc]$/.test(c ?? "")) row = ({ a: "B31", b: "B32", c: "B33" } as const)[c as "a" | "b" | "c"];
    else if (a === "2" && !b) {
      if (tag === "2020") row = "B2";
      else if (tag) { unmapped.push(`"${tag} NEC ${cite}" — not a 2020 row`); continue; }
      else {
        const near = t.slice(Math.max(0, i - 80), i + m[0].length + 80);
        const tapEv = /\btaps?\b/i.test(near) || /\btap\b/i.test(interco);
        const brkEv = /\b120\s*%|back.?fe(?:d|ed)|do not relocate|opposite end/i.test(near) || (!/\btap\b/i.test(interco) && /breaker|back.?fe/i.test(interco));
        if (tapEv !== brkEv) row = tapEv ? "B2" : "B32";
        else { ambiguous.push(`"${cite}" with no edition — 2020 (B)(2) is Taps, 2023 (B)(2) is the 120% busbar method, and the plan's interconnection does not settle which`); continue; }
      }
    } else {
      if (parts.length) unmapped.push(`"${tag ? `${tag} NEC ` : ""}${cite}" — not a 705.12(B) row in the 2020 NEC the worksheet prints`);
      continue;
    }
    found.push({ row, quote });
  }
  const rows = [...new Set(found.map((f) => f.row))];
  const base = { rows, unmapped, ambiguous };
  if (rows.length === 1) return { ...base, status: "established", row: rows[0], quote: found[0].quote };
  if (rows.length > 1) return { ...base, status: "multiple", row: "", quote: found.map((f) => f.quote).join(" | ") };
  if (ambiguous.length) return { ...base, status: "ambiguous", row: "", quote: "" };
  if (unmapped.length) return { ...base, status: "unmapped", row: "", quote: "" };
  // No citation at all: the plan's own 120% wording is its stated method.
  const pct = /\b120\s*%\s*(?:rule|busbar|of (?:the )?bus)|\bbus(?:bar)?\s*(?:rating\s*)?x\s*1\.2\b|\bx\s*120\s*%/i.exec(t);
  if (pct) return { ...base, rows: ["B32"], status: "established", row: "B32", quote: quoteAt(t, pct.index, pct[0].length) };
  return { ...base, status: "none", row: "", quote: "" };
}

/** The established row only ({row:"", ...} otherwise) — the single-answer view of loadSideCitation. */
export function citedLoadSideRow(text: string, opts: { interco?: string; edition?: "2020" } = {}): { row: string; quote: string } {
  const c = loadSideCitation(text, opts);
  return c.status === "established" ? { row: c.row, quote: c.quote } : { row: "", quote: "" };
}

/** Distinct mounting planes (tilt/azimuth pairs) — never the module count. null = unknown. */
export function mountingPlaneCount(snapshot: Record<string, unknown>): { count: number | null; basis: string } {
  const arrays = snapshot.pvArrays;
  let list: unknown = arrays;
  if (typeof arrays === "string") { try { list = JSON.parse(arrays); } catch { list = null; } }
  // An entry with neither tilt nor azimuth says nothing about planes (intake derives a single
  // quantity-only row from moduleQty) — only oriented entries count.
  const oriented = Array.isArray(list) ? list.filter((a) => {
    const o = (a ?? {}) as Record<string, unknown>;
    return firstNumber(o.tilt) != null || firstNumber(o.azimuth) != null;
  }) : [];
  const az = String(snapshot.azimuth ?? "").trim();
  const tilt = String(snapshot.tilt ?? "").trim();
  const azs = az ? az.split(/[\/,;&]|\band\b/).map((s) => s.trim()).filter(Boolean) : [];
  const tilts = tilt ? tilt.split(/[\/,;&]|\band\b/).map((s) => s.trim()).filter(Boolean) : [];
  const scalar = az || tilt ? Math.max(azs.length, tilts.length, 1) : null;
  // Both are plane evidence; intake can derive a single pvArrays row from a slashed scalar
  // ("180/ 90"), so the larger reading wins.
  if (oriented.length) {
    const keys = new Set(oriented.map((a) => {
      const o = (a ?? {}) as Record<string, unknown>;
      return `${firstNumber(o.tilt) ?? "?"}/${firstNumber(o.azimuth) ?? "?"}`;
    }));
    if (scalar != null && scalar > keys.size) return { count: scalar, basis: `azimuth "${az}" / tilt "${tilt}" -> ${scalar} plane(s)` };
    return { count: keys.size, basis: `pvArrays lists ${oriented.length} oriented array(s) on ${keys.size} distinct tilt/azimuth plane(s)` };
  }
  if (scalar != null) return { count: scalar, basis: `azimuth "${az}" / tilt "${tilt}" -> ${scalar} plane(s)` };
  return { count: null, basis: "no azimuth/tilt or per-array breakdown parsed" };
}

// ── DC-DC CONVERTERS (optimizers): read from the EQUIPMENT, never from prose ───────────────
// The equipment reading is moduleLevelElectronics.ts — the ONE predicate the rapid-shutdown rule
// also asks (#213). The worksheet adds one reading of its own: a SolarEdge string inverter (SE... /
// make SolarEdge) answers DC-DC "Yes" here, because its optimizers are part of the listed system
// and the 690.7(B) question is the safe side. That inverter alone does NOT soften a rapid-shutdown
// blocker — the reviewer asks for the optimizers themselves.
export function dcDcConverterEvidence(s: Record<string, unknown>, stringInverter: boolean): { present: boolean; basis: string } {
  const str = (k: string) => String(s[k] ?? "").trim();
  if (stringInverter && (/solaredge/i.test(str("invMake")) || /^SE\d/i.test(str("invModel")))) return { present: true, basis: `SolarEdge string inverter (${`${str("invMake")} ${str("invModel")}`.trim()})` };
  const t = [str("electricalCalcText"), str("labelsText"), str("planSetExtractedText")].join("\n");
  const hit = moduleLevelElectronicsEquipment(s, [{ label: "plan text", text: t }]);
  return { present: hit.present, basis: hit.basis };
}

// ── THE ESS INVERTER'S OWN OUTPUT CURRENT (AC-coupled battery on a micro system) ────────────
// parser.html puts a micro system's make / model / per-unit amps into invMake / invModel /
// invOutputW, and on a Tesla battery swaps in the Powerwall model while invOutputW keeps the
// micro's amps when no battery kW was read — "10 x 1.21 A + ESS 1.21 A" was filed for an Enphase
// IQ Battery 5P / a Powerwall 3. So the ESS current comes only from the operator's answer or ONE
// battery's rated kW; otherwise it is unknown and asked.
export function essOutputCurrent(s: Record<string, unknown>): { amps: number; source: string } | null {
  const str = (k: string) => String(s[k] ?? "").trim();
  const answered = str("iaPvEssOutputA") ? parseRating(str("iaPvEssOutputA")) : null;
  if (answered != null && answered > 0) return { amps: answered, source: `operator answer iaPvEssOutputA ${str("iaPvEssOutputA")}` };
  // ONE battery (or no count stated): its rated kW / 240 V. MORE THAN ONE is ambiguous — the count can be
  // expansion packs with no inverter (Powerwall 3 + DC expansion) or several inverters — so one unit's current
  // is never filed for all of them; it becomes the question (skeptic 2026-09-26: 2 x Powerwall 3 filed as one).
  const kw = firstNumber(s.batteryOutputKw);
  const qty = firstNumber(s.batteryQty);
  if (kw != null && kw > 0 && (qty == null || qty <= 1)) return { amps: (kw * 1000) / 240, source: `batteryOutputKw ${kw} kW / 240 V (one battery)` };
  // invOutputW is NEVER the ESS rating here: this current is only added on a MICRO system, and there
  // parser.html stores the MICRO's own per-unit amps in invOutputW (and keeps them when it swaps a Powerwall
  // into invMake/invModel). No guard on names or equal values made that safe (skeptic 2026-09-26), so the
  // field is not read at all — an unknown ESS rating is the operator question, never a guess.
  return null;
}

const LOAD_SIDE_ROW_IDS = ["B1a", "B1b", "B2", "B31", "B32", "B33", "B34", "B35", "B36"];
const LOAD_SIDE_ROW_OPTIONS = ["705.12(B)(1)(a)", "705.12(B)(1)(b)", "705.12(B)(2)", "705.12(B)(3)(1)", "705.12(B)(3)(2)", "705.12(B)(3)(3)", "705.12(B)(3)(4)", "705.12(B)(3)(5)", "705.12(B)(3)(6)"];

export function iowaPvWorksheetValues(project: ProjectRecord): IowaPvWorksheet {
  const s = (project.parserSnapshot ?? {}) as Record<string, unknown>;
  const str = (k: string) => String(s[k] ?? "").trim();
  const n = (k: string) => firstNumber(s[k]);
  const amps = (k: string) => { const v = str(k); return v ? parseRating(v) : null; };
  const values: Record<string, string> = {};
  const basis: Record<string, string> = {};
  const questions: WorksheetQuestion[] = [];
  const set = (id: string, v: string, why: string) => { values[id] = v; basis[id] = why; };
  // One- and two-family dwelling (page 3 location, and 690.7's 600 V ceiling for such dwellings).
  const units = firstNumber(s.dwellingUnits);
  // The parsed category, or the occupancy group when the category is blank ("R-3" is the one- and
  // two-family group — exactly this row).
  const cat = String(s.constructionCategory || s.occupancyType || "").trim();
  // The structure answer through the ONE structure predicate (structureMeaningOf, B5) — the
  // operator's portal-question answer lands in structureDescription, which this never read.
  const structure = structureMeaningOf(s);
  const catOneTwo = /\bR-?3\b|single[-\s]?family|two[-\s]?family|duplex/i.test(cat);
  const oneTwo = (units != null && units >= 1 && units <= 2) || catOneTwo
    || structure === "single_family" || structure === "two_family";
  const ask = (key: string, label: string, options: string[] = []) => {
    if (!questions.some((q) => q.key === key)) questions.push({ key, label, options, kind: "form-fact" });
  };
  const text = [str("electricalCalcText"), str("labelsText"), str("planSetExtractedText"), str("projectDescriptionText")].join("\n");

  // ── topology ───────────────────────────────────────────────────────────────────────────
  const micro = Boolean(str("pvMicroMake") || str("pvMicroModel"));
  const stringInv = !micro && Boolean(str("invMake") || str("invModel"));
  const dcdc = dcDcConverterEvidence(s, stringInv);
  const optimizer = dcdc.present;
  set("p2.standardString", stringInv ? "X" : "", stringInv ? "derived: a string inverter is listed and no microinverter" : micro ? "derived: microinverter system" : "no inverter parsed");
  set("p2.microArray", micro ? "X" : "", micro ? `derived: microinverters listed (${str("pvMicroMake")} ${str("pvMicroModel")})`.trim() : "derived: no microinverter listed");

  const mounting = str("mounting").toLowerCase();
  const roof = /roof/.test(mounting);
  const ground = /ground|pole/.test(mounting);
  set("p2.roofMount", roof && !ground ? "X" : "", `mounting "${str("mounting")}"`);
  set("p2.groundMount", ground && !roof ? "X" : "", `mounting "${str("mounting")}"`);
  set("p2.combination", roof && ground ? "X" : "", `mounting "${str("mounting")}"`);
  const onBuilding = roof || /building|carport|canopy/.test(mounting);
  set("p2.rsdYes", onBuilding ? "X" : "", onBuilding ? "derived: the array is on a building, so NEC 690.12 rapid shutdown applies" : "derived: no building-mounted array parsed");
  set("p2.rsdNo", ground && !roof ? "X" : "", ground && !roof ? "derived: ground-mounted array not on or in a building (690.12 scope) — verify no PV circuits run on/in a building" : "");

  // ── arrays ─────────────────────────────────────────────────────────────────────────────
  // An operator's answer (the question below, written onto the project) settles an unknown.
  const answeredArrays = n("iaPvArrayCount");
  const planes = answeredArrays != null && answeredArrays > 0 ? { count: answeredArrays, basis: `operator answer (iaPvArrayCount ${answeredArrays})` } : mountingPlaneCount(s);
  set("p2.arrays", planes.count != null ? String(planes.count) : "", planes.basis);
  if (planes.count == null) ask("iaPvArrayCount", "How many arrays (distinct mounting planes) does this system have? (not the module count)");

  // ── inverters, battery, DC-DC ─────────────────────────────────────────────────────────
  const unitQty = micro ? n("pvMicroQty") : n("invQty");
  set("p2.numInverters", unitQty != null ? String(unitQty) : "", micro ? `pvMicroQty "${str("pvMicroQty")}"` : `invQty "${str("invQty")}"`);
  const battery = Boolean(str("batteryMake") || str("batteryModel") || (n("batteryQty") ?? 0) > 0);
  set("p2.battery", battery ? "Y" : "N", battery ? `battery listed (${str("batteryMake")} ${str("batteryModel")})`.trim() : "derived: no battery/ESS in the parsed plan set");
  set("p2.dcdc", micro && !optimizer ? "N/A" : optimizer ? "Yes" : "", micro && !optimizer ? "derived: microinverter system, no DC-DC converter (optimizer) in the equipment"
    : optimizer ? `derived: DC-DC converters (optimizers) in the equipment — ${dcdc.basis}`
    : stringInv ? "string inverter; no DC-DC converter (optimizer) in the inverter/MLPE fields or an equipment-schedule line — confirm on the one-line" : "no inverter topology parsed");

  // ── circuit current ────────────────────────────────────────────────────────────────────
  const unitA = (micro ? amps("pvMicroOutputW") : amps("invOutputW")) ?? amps("iaPvUnitOutputA");
  let circuitA: number | null = null;
  let circuitCalc = "";
  let essSource = "";
  if (unitQty != null && unitA != null && unitQty > 0 && unitA > 0 && unitA < 100) {
    circuitA = unitQty * unitA;
    circuitCalc = `${unitQty} x ${fmt(unitA)} A = ${fmt(circuitA)} A`;
    // AC-coupled ESS on a micro system: its inverter's output adds to the circuit current.
    if (micro && battery) {
      const ess = essOutputCurrent(s);
      const essA = ess?.amps ?? null;
      if (ess && essA != null && essA > 0 && essA < 100) {
        circuitA += essA;
        circuitCalc = `${unitQty} x ${fmt(unitA)} A + ESS ${fmt(essA)} A = ${fmt(circuitA)} A`;
        essSource = `; ESS current from ${ess.source}`;
      } else {
        circuitA = null; circuitCalc = "";
        ask("iaPvEssOutputA", "What is the ESS (battery) inverter's rated continuous output current, in amps?");
      }
    }
  }
  if (circuitA == null && !questions.some((q) => q.key === "iaPvEssOutputA")) ask("iaPvUnitOutputA", "What is each inverter's rated continuous AC output current (amps, from its datasheet)?");
  set("p2.maxCircuitCurrent", circuitA != null ? `${fmt(circuitA)}A` : "", circuitA != null ? `derived: ${circuitCalc} (qty x per-unit rated output current${essSource})` : "per-unit output current or quantity not parsed");

  // ── min PV OCPD ────────────────────────────────────────────────────────────────────────
  const minOcpd = circuitA != null ? nextStandardOcpd(circuitA * 1.25) : null;
  const pvBreaker = amps("pvBreaker");
  set("p2.minPvOcpd", minOcpd != null ? `${minOcpd}A` : pvBreaker != null ? `${pvBreaker}A` : "",
    minOcpd != null ? `derived: ${fmt(circuitA!)} A x 1.25 = ${fmt(circuitA! * 1.25)} A -> ${minOcpd} A standard size (NEC 240.6(A))${pvBreaker != null ? `; plan PV breaker ${pvBreaker} A` : ""}`
      : pvBreaker != null ? `pvBreaker "${str("pvBreaker")}" (no circuit current to check it against)` : "no PV breaker or circuit current parsed");

  // ── interconnection ────────────────────────────────────────────────────────────────────
  // The operator's answer to the interconnection question settles an ambiguous plan set.
  const answer = str("iaPvInterconnection");
  const side: InterconnectionSide = /^line/i.test(answer) ? "supply" : /^load/i.test(answer) ? "load"
    : interconnectionSide(`${project.interconnectionMethod ?? ""}\n${str("interco")}`);
  set("p2.lineside", side === "supply" ? "X" : "", `interco "${str("interco")}" -> ${side}`);
  set("p2.loadside", side === "load" ? "X" : "", `interco "${str("interco")}" -> ${side}`);
  if (side === "both" || side === "unknown") {
    ask("iaPvInterconnection", `Is the PV connection line side (705.11) or load side (705.12)? The plan set reads "${str("interco") || "nothing"}".`, ["Line side (705.11)", "Load side (705.12)"]);
  }
  const serviceV = serviceVoltageOf(str("serviceVoltage") || str("voltage"));
  set("p2.serviceVoltage", serviceV != null ? String(serviceV) : "", `serviceVoltage "${str("serviceVoltage") || str("voltage")}"${serviceV != null ? ` -> ${serviceV} V line to line` : ""}`);
  const service = amps("mainServiceRating") ?? amps("mainBreaker");
  set("p2.serviceAmps", service != null ? String(service) : "", str("mainServiceRating") ? `mainServiceRating "${str("mainServiceRating")}"` : `mainBreaker "${str("mainBreaker")}"`);
  const bus = amps("busRating");
  set("p2.busRating", bus != null ? String(bus) : "", `busRating "${str("busRating")}"`);
  const conductor = str("serviceConductorSize");
  set("p2.serviceConductor", conductor, conductor ? "operator answer (serviceConductorSize)" : "not shown on the plan set — operator question");
  if (!conductor) ask("serviceConductorSize", "What is the existing service-entrance conductor size and material (e.g. 4/0 AL)? No plan set shows it.");

  // 705.12(B) subsection: exactly one row, only on a load-side connection.
  for (const r of ["B1a", "B1b", "B2", "B31", "B32", "B33", "B34", "B35", "B36"]) set(`p2.lsc.${r}`, "", side === "load" ? "" : "not a load-side connection");
  if (side === "load") {
    const cited = loadSideCitation(text, { interco: str("interco") });
    const main = amps("mainBreaker") ?? service;
    const intercoText = str("interco").toLowerCase();
    // The operator's answer is one of the worksheet's own (2020) row labels.
    const answeredRow = citedLoadSideRow(str("iaPvLoadSideRow"), { edition: "2020" }).row;
    // The busbar arithmetic from the plan's bus / main / PV breaker (100% rule, then 120%).
    const busbarRow = (): { row: string; why: string } | null => {
      if (bus == null || main == null || circuitA == null) return null;
      const need = 1.25 * circuitA;
      if (need + main <= bus + 1e-9) return { row: "B31", why: `derived: 1.25 x ${fmt(circuitA)} A + ${main} A main = ${fmt(need + main)} A <= ${bus} A bus (705.12(B)(3)(1), 100% rule)` };
      if (bus * 1.2 - main >= Math.max(need, pvBreaker ?? 0) - 1e-9) return { row: "B32", why: `derived: ${bus} A x 1.2 - ${main} A = ${fmt(bus * 1.2 - main)} A >= ${pvBreaker != null ? `${pvBreaker} A PV breaker` : `${fmt(need)} A`} (705.12(B)(3)(2), 120% rule — PV breaker at the opposite end of the busbar from the main; confirm on the one-line)` };
      return { row: "", why: `neither busbar rule holds: 1.25 x ${fmt(circuitA)} + ${main} = ${fmt(need + main)} > ${bus}; ${bus} x 1.2 - ${main} = ${fmt(bus * 1.2 - main)} < ${fmt(Math.max(need, pvBreaker ?? 0))}` };
    };
    const rowLabel = (r: string) => LOAD_SIDE_ROW_OPTIONS[LOAD_SIDE_ROW_IDS.indexOf(r)] ?? r;
    if (answeredRow) {
      set(`p2.lsc.${answeredRow}`, "X", `operator answer: ${str("iaPvLoadSideRow")}`);
    } else if (cited.status === "established") {
      set(`p2.lsc.${cited.row}`, "X", `the plan's own method: "${cited.quote}" -> ${rowLabel(cited.row)} (2020 NEC row)`);
    } else if (cited.status === "multiple") {
      const d = busbarRow();
      const names = cited.rows.map(rowLabel).join(", ");
      if (d?.row && cited.rows.includes(d.row)) {
        set(`p2.lsc.${d.row}`, "X", `${d.why} — one of the rows the plan cites (${names})`);
      } else {
        basis["p2.lsc.B32"] = `the plan cites several 705.12(B) rows (${names}) and its ratings do not single one out`;
        ask("iaPvLoadSideRow", `The plan set cites more than one 705.12(B) subsection (${names}). Which one does this connection use?`, LOAD_SIDE_ROW_OPTIONS);
      }
    } else if (cited.status === "ambiguous" || cited.status === "unmapped") {
      const why = [...cited.ambiguous, ...cited.unmapped].join("; ");
      basis["p2.lsc.B32"] = `the plan's citation is not mapped to a 2020 row: ${why}`;
      ask("iaPvLoadSideRow", `The plan cites ${why}. Which 2020-NEC 705.12(B) row does this connection use?`, LOAD_SIDE_ROW_OPTIONS);
    } else if (/feeder|sub.?panel/.test(intercoText) && /\(B\)\(1\)\(([ab])\)/.test(str("iaPvFeederRow"))) {
      const r = /\(B\)\(1\)\(([ab])\)/.exec(str("iaPvFeederRow"))![1];
      set(`p2.lsc.B1${r}`, "X", `operator answer: ${str("iaPvFeederRow")}`);
    } else if (/feeder|sub.?panel/.test(intercoText)) {
      ask("iaPvFeederRow", "The PV connects on a feeder: which 705.12(B)(1) item applies — (a) or (b)?", ["705.12(B)(1)(a)", "705.12(B)(1)(b)"]);
    } else if (/\btap\b/.test(intercoText)) {
      set("p2.lsc.B2", "X", `interco "${str("interco")}" is a load-side tap -> 705.12(B)(2)`);
    } else if (busbarRow()) {
      const d = busbarRow()!;
      if (d.row) set(`p2.lsc.${d.row}`, "X", d.why);
      else {
        basis["p2.lsc.B32"] = d.why;
        ask("iaPvLoadSideRow", "Neither the 100% nor the 120% busbar rule holds with the parsed ratings. Which 705.12(B)(3) subsection does the design use?", LOAD_SIDE_ROW_OPTIONS);
      }
    } else {
      ask("iaPvLoadSideRow", "Which 705.12(B) subsection does the load-side connection use? Bus, main or PV breaker ratings were not all parsed.", LOAD_SIDE_ROW_OPTIONS);
    }
  }

  // ── page 3: location ───────────────────────────────────────────────────────────────────
  // The structure named as the ONE predicate resolved it — a plan-set derivation (operator ruling
  // 2026-09-28) with the words that decided it.
  const structureWords = (): string => {
    const answer = structureAnswerOf(s);
    const d = structureDescriptionOf(s);
    return `structure "${answer}"${d.source === "plan" && d.value === answer ? ` (from the plan set: ${d.basis})` : ""}`;
  };
  set("p3.loc12fam", onBuilding && oneTwo ? "X" : "", oneTwo ? `derived: ${units != null ? `${units} dwelling unit(s)` : catOneTwo ? `occupancy "${cat}"` : structureWords()}` : "dwelling units / occupancy not parsed");
  set("p3.locOther", "", "");
  set("p3.locNotBuilding", ground && !roof ? "X" : "", ground && !roof ? "derived: ground mount" : "");
  if (onBuilding && !oneTwo) ask("dwellingUnits", "How many dwelling units are in the building the array is on?", ["1", "2", "3 or more"]);

  // ── Part A: 690.7 maximum voltage ──────────────────────────────────────────────────────
  for (const id of ["p3.A1", "p3.A2", "p3.A3", "p3.B1", "p3.B2"]) set(id, "", "");
  const voc = n("moduleVoc");
  const betaRaw = str("moduleVocTempCoeff");
  const betaRead = n("moduleVocTempCoeff");
  // SANITY BOUND: a crystalline or thin-film module's Voc coefficient is a few tenths of a percent
  // per degree C. A value in mV/°C, or outside 0.05-1 %/°C, is a broken read (a wrong unit, a
  // fraction, another column) — "-136 mV/C" computed and filed 3166 V for a micro input. It is
  // UNKNOWN and asked, never used, and never silently replaced by the Table 690.7(A) factor (that
  // path is for a datasheet that states no coefficient, not for one read wrong).
  const betaBroken = betaRead != null && (/m\s*V/i.test(betaRaw) || Math.abs(betaRead) > 1 || Math.abs(betaRead) < 0.05);
  const beta = betaBroken ? null : betaRead;
  const low = n("siteLowTempC");
  const perString = micro ? 1 : n("modulesPerString");
  const microMaxDc = n("pvMicroMaxDcInputV");
  let maxV: number | null = null;
  let partA = "";
  const dcdcAnswer = n("iaPvDcDcMaxVoltage");
  const maxVAnswer = n("iaPvMaxSystemVoltage");
  if (!optimizer && maxVAnswer != null && maxVAnswer > 0) {
    // The operator's answer to the bound question below settles it.
    set("p2.maxSystemVoltage", `${fmt(maxVAnswer, 1)} V DC`, `operator answer (iaPvMaxSystemVoltage ${str("iaPvMaxSystemVoltage")})`);
  } else if (!optimizer && betaBroken) {
    set("p2.maxSystemVoltage", "", `module Voc temperature coefficient "${betaRaw}" is outside the physical range (0.05-1 %/°C) — a broken read, not used; operator question`);
    ask("moduleVocTempCoeff", `The module's Voc temperature coefficient reads "${betaRaw}", outside the physical range (0.05-1 %/°C, e.g. -0.27 %/°C). What is it, in %/°C, from the module datasheet?`);
  } else if (optimizer && dcdcAnswer != null && dcdcAnswer > 0) {
    maxV = dcdcAnswer;
    set("p2.maxSystemVoltage", `${fmt(dcdcAnswer, 1)} V DC`, `operator answer: the DC-DC converter system's listed maximum (690.7(B)), ${str("iaPvDcDcMaxVoltage")}`);
  } else if (optimizer) {
    ask("iaPvDcDcMaxVoltage", "DC-DC converters (optimizers) are installed, so 690.7(B) governs: what is the maximum string voltage the converter/inverter system is listed to hold?");
    set("p2.maxSystemVoltage", "", "DC-DC converter system: 690.7(B)(1)/(2) — the converter system's listed maximum, operator question");
  } else if (voc != null && low != null && perString != null && perString > 0) {
    if (beta != null) {
      const f = 1 + (Math.abs(beta) / 100) * (25 - low);
      maxV = voc * f * perString;
      partA = `690.7(A)(1): ${fmt(voc)} V x (1 + ${fmt(Math.abs(beta), 3)}%/C x (25 - (${fmt(low, 1)}) C))${perString > 1 ? ` x ${perString} modules in series` : ""} = ${fmt(maxV, 1)} V`;
      set("p3.A1", "X", "derived: module datasheet temperature coefficient (690.7(A)(1))");
    } else {
      const f = table6907AFactor(low);
      if (f != null) {
        maxV = voc * f * perString;
        partA = `690.7(A)(2) Table 690.7(A): ${fmt(voc)} V x ${f}${perString > 1 ? ` x ${perString} modules in series` : ""} = ${fmt(maxV, 1)} V`;
        set("p3.A2", "X", `derived: no temperature coefficient parsed; Table 690.7(A) factor ${f} at ${low} C`);
      }
    }
    if (maxV != null && micro && microMaxDc != null) partA += ` per micro input (<= ${fmt(microMaxDc)} V micro max DC input)`;
  } else if (micro && microMaxDc != null && voc == null) {
    maxV = microMaxDc;
    partA = `Microinverter listed maximum DC input ${fmt(microMaxDc)} V (module Voc not parsed; the micro's listing bounds each input)`;
  }
  // SANITY BOUNDS on a computed value: above the micro's own maximum DC input (the module and micro
  // cannot be paired, or an input is misread) or above 600 V on a one-/two-family dwelling (690.7's
  // ceiling there) is never filed — it becomes a question naming the conflict.
  let conflict = "";
  if (!optimizer && maxV != null && micro && microMaxDc != null && maxV > microMaxDc + 1e-9) {
    conflict = `the 690.7 calculation gives ${fmt(maxV, 1)} V DC per micro input, ABOVE the microinverter's ${fmt(microMaxDc)} V maximum DC input (${partA})`;
  } else if (!optimizer && maxV != null && oneTwo && maxV > 600 + 1e-9) {
    conflict = `the 690.7 calculation gives ${fmt(maxV, 1)} V DC, ABOVE the 600 V maximum for PV systems on one- and two-family dwellings (690.7) (${partA})`;
  }
  if (conflict) {
    maxV = null; partA = "";
    set("p2.maxSystemVoltage", "", `not filed: ${conflict} — operator question`);
    for (const id of ["p3.A1", "p3.A2"]) set(id, "", "");
    ask("iaPvMaxSystemVoltage", `Max system voltage conflict: ${conflict}. Check the module Voc, temperature coefficient, site low temperature and the module/inverter pairing — what is the maximum system voltage (V DC)?`);
  }
  if (!optimizer && !conflict && !betaBroken && !(maxVAnswer != null && maxVAnswer > 0)) {
    if (maxV != null) set("p2.maxSystemVoltage", `${fmt(maxV, 1)} V DC`, `derived: ${partA}`);
    else {
      set("p2.maxSystemVoltage", "", "module Voc, temperature coefficient/table, site low temperature" + (micro ? "" : " or modules per string") + " not all known — never the AC service voltage");
      if (voc == null) ask("moduleVoc", "What is the module's open-circuit voltage Voc (V, STC) from its datasheet?");
      if (low == null) ask("siteLowTempC", "What is the site's extreme minimum design temperature (ASHRAE, °C)?");
      if (!micro && (perString == null || perString <= 0)) ask("modulesPerString", "How many modules are connected in series in the longest string?");
    }
  }
  if ((n("dcKw") ?? 0) >= 100) set("p3.A3", "X", "derived: dcKw >= 100");
  set("p3.A.calc", partA, partA ? "derived" : "Part A needs the corrected maximum voltage (see p2.maxSystemVoltage)");

  // ── Part B: 690.8 circuit current ──────────────────────────────────────────────────────
  for (const id of ["p3.B.a1", "p3.B.a2", "p3.B.b", "p3.B.c", "p3.B.d", "p3.B.A2"]) set(id, "", "");
  set("p3.B.e", circuitA != null ? "X" : "", circuitA != null ? "derived: inverter output circuit current (micro/string AC output)" : "");
  const isc = n("moduleIsc");
  let partB = circuitA != null ? `690.8(A)(1)(e) inverter output circuit: ${circuitCalc}` : "";
  if (stringInv && isc != null && !optimizer) {
    set("p3.B.a1", "X", "derived: string PV source circuit");
    partB += `${partB ? "; " : ""}690.8(A)(1)(a)(1) PV source circuit: ${fmt(isc)} A Isc x 1.25 = ${fmt(isc * 1.25)} A`;
  }
  set("p3.B.calc", partB, partB ? "derived" : "circuit current not derivable");

  // ── Part C: 690.9 OCPD ─────────────────────────────────────────────────────────────────
  set("p3.C.B", minOcpd != null ? "X" : "", minOcpd != null ? "derived: 690.9(B) overcurrent device rating" : "");
  set("p3.C.C", "", ""); set("p3.C.D", "", "");
  set("p3.C.calc", minOcpd != null ? `(${circuitCalc.replace(/ = [\d.]+ A$/, "")}) x 1.25 = ${fmt(circuitA! * 1.25)} A -> ${minOcpd} A OCPD (NEC 240.6(A))` : "", minOcpd != null ? "derived" : "circuit current not derivable");

  // ── page 4 checklist ───────────────────────────────────────────────────────────────────
  const tick = (id: string, on: boolean, why: string) => set(id, on ? "X" : "", why);
  tick("p4.1", roof || ground, `mounting "${str("mounting")}"`);
  tick("p4.2", values["p2.rsdYes"] === "X", "derived as p2.rsdYes");
  for (const id of ["p4.3", "p4.4", "p4.10"]) set(id, "", "the filer's attestation — ticked by the person who reviews and files, never auto-ticked");
  tick("p4.5", Boolean(str("moduleModel")) && /spec|datasheet|data sheet/i.test(text), "datasheet pages found in the plan text");
  let sld = false; let site = false;
  try { sld = evidenceForTopic(project, "sld").present; site = evidenceForTopic(project, "siteRoofPlan").present; } catch { /* no evidence text */ }
  tick("p4.6", sld, sld ? "one-line diagram present in the package (accuracy is the filer's check)" : "no one-line found");
  tick("p4.7", site, site ? "site plan present in the package" : "no site plan found");
  tick("p4.8", values["p2.lineside"] === "X" || Object.keys(values).some((k) => k.startsWith("p2.lsc.") && values[k] === "X"), "interconnection box and (load side) its 705.12(B) row are determined");
  tick("p4.9", /grounding electrode|\bGES\b|ground(?:ing)? rod|\bGEC\b/i.test(text), "grounding electrode system shown on the plan text");

  return { values, basis, questions };
}

// ── THE BLANK: recognised by its own text layer, never by a guessed URL ─────────────────────
// No public URL for the SFM blank has been retrieved, so there is no byte hash to pin. The form
// is instead recognised by ANCHORS — printed labels at the exact positions the 2020-NEC edition
// prints them (read off the operator's copy, 612x792, PDF points from the bottom-left). A blank
// whose anchors are missing or moved is a different revision — the corpus shows a 2023-NEC
// edition in circulation with different 705.12 rows — and is REFUSED, never filled with these
// coordinates.
export interface WorksheetAnchor { page: number; text: string; x: number; y: number }
export const IOWA_PV_WORKSHEET_ANCHORS: WorksheetAnchor[] = [
  { page: 0, text: "PHOTOVOLTAIC WORKSHEET", x: 161, y: 622 },
  { page: 0, text: "Article 690, 691, & 705 of the 2020", x: 72, y: 489 },
  { page: 1, text: "PV SYSTEM INFORMATION", x: 228, y: 567 },
  { page: 1, text: "PV SYSTEM OVERVIEW", x: 127, y: 427 },
  { page: 1, text: "Lineside Connect 705.11", x: 329, y: 405 },
  { page: 1, text: "LOADSIDE CONNECTIONS", x: 243, y: 198 },
  { page: 1, text: "NEC 705.12(B)(1)(a)", x: 181, y: 183 },
  { page: 1, text: "NEC 705.12(B)(3)(2)", x: 181, y: 122 },
  { page: 1, text: "NEC 705.12 (B)(3)(6)", x: 181, y: 61 },
  { page: 2, text: "CALCULATION SHEET", x: 217, y: 671 },
  { page: 2, text: "2020 NEC 690.7 Maximum Voltage.", x: 109, y: 502 },
  { page: 2, text: "690.7(A)(1)", x: 95, y: 472 },
  { page: 2, text: "2020 NEC 690.9 Overcurrent Protection.", x: 108, y: 164 },
  { page: 3, text: "FINAL PV SUBMITTAL CHECKLIST", x: 184, y: 657 },
];
const normLabel = (s: string) => s.replace(/[–—]/g, "-").replace(/[“”]/g, "\"").replace(/\s+/g, " ").trim();

/** Every anchor present at its position (±2.5 pt). Returns the anchors that failed. */
export function iowaPvWorksheetAnchorMisses(labels: Array<{ page: number; str: string; x: number; y: number }>): WorksheetAnchor[] {
  return IOWA_PV_WORKSHEET_ANCHORS.filter((a) => !labels.some((l) => l.page === a.page
    && normLabel(l.str).includes(normLabel(a.text)) && Math.abs(l.x - a.x) <= 2.5 && Math.abs(l.y - a.y) <= 2.5));
}

export const IOWA_PV_WORKSHEET_FORM_NAME = "Iowa SFM Electrical Bureau Photovoltaic Worksheet (2020 NEC)";
export const PV_WORKSHEET_DOC_TYPE = "pv_worksheet";

type Overlay = { source: string; page: number; x: number; y: number; size?: number; maxWidth?: number; onlyIf?: { source: string; equals?: string } };
/** The overlay map (the fill engine's stored-template shape). Every value is computed.iaPv.<id>. */
export function iowaPvWorksheetFieldMap(sourceUrl: string) {
  const f: Overlay[] = [];
  const text = (id: string, page: number, x: number, y: number, maxWidth: number, size = 9) => f.push({ source: `computed.iaPv.${id}`, page, x, y, size, maxWidth });
  const box = (id: string, page: number, x: number, y: number) => f.push({ source: "lit:X", page, x, y, size: 9, maxWidth: 10, onlyIf: { source: `computed.iaPv.${id}`, equals: "X" } });
  // page 2 (index 1): system information
  text("p2.arrays", 1, 78, 540, 22);
  box("p2.standardString", 1, 74, 512); box("p2.microArray", 1, 254, 512);
  box("p2.roofMount", 1, 74, 484); box("p2.groundMount", 1, 254, 484); box("p2.combination", 1, 398, 484);
  box("p2.rsdYes", 1, 73, 455); box("p2.rsdNo", 1, 109, 455);
  // overview column (values sit at x=242 on the operator's copy)
  text("p2.maxSystemVoltage", 1, 242, 401, 80); text("p2.maxCircuitCurrent", 1, 242, 379, 80);
  text("p2.numInverters", 1, 242, 357, 80); text("p2.battery", 1, 242, 336, 80);
  text("p2.minPvOcpd", 1, 242, 313, 80); text("p2.dcdc", 1, 242, 291, 80);
  // interconnection column (x=494)
  box("p2.lineside", 1, 494, 401); box("p2.loadside", 1, 494, 379);
  text("p2.serviceVoltage", 1, 494, 357, 70); text("p2.serviceAmps", 1, 494, 337, 70);
  text("p2.busRating", 1, 494, 313, 70); text("p2.serviceConductor", 1, 494, 291, 70);
  // 705.12(B) rows: the mark sits left of each "NEC 705.12(B)…" label (x=181). No filled sample
  // carries a row mark, so x=168 is the blank line's estimated position — preview before filing.
  for (const [id, y] of [["B1a", 183], ["B1b", 168], ["B2", 152], ["B31", 137], ["B32", 122], ["B33", 107], ["B34", 91], ["B35", 76], ["B36", 61]] as const) box(`p2.lsc.${id}`, 1, 168, y + 1);
  // page 3 (index 2): calculation sheet
  box("p3.loc12fam", 2, 74, 578); box("p3.locOther", 2, 74, 563); box("p3.locNotBuilding", 2, 74, 548);
  for (const [id, y] of [["A1", 472], ["A2", 457], ["A3", 442], ["B1", 427], ["B2", 412]] as const) box(`p3.${id}`, 2, 75, y + 1);
  text("p3.A.calc", 2, 90, 379, 440, 8);
  for (const [id, y] of [["a1", 318], ["a2", 288], ["b", 273], ["c", 243]] as const) box(`p3.B.${id}`, 2, 75, y + 1);
  box("p3.B.d", 2, 311, 311); box("p3.B.e", 2, 311, 266); box("p3.B.A2", 2, 311, 236);
  text("p3.B.calc", 2, 90, 197, 440, 8);
  for (const [id, y] of [["B", 134], ["C", 119], ["D", 104]] as const) box(`p3.C.${id}`, 2, 76, y + 1);
  text("p3.C.calc", 2, 90, 69, 440, 8);
  // page 4 (index 3): final checklist — 3, 4 and 10 are the filer's attestation (never computed "X")
  for (const [i, y] of [[1, 431], [2, 413], [3, 396], [4, 379], [5, 362], [6, 344], [7, 329], [8, 312], [9, 294], [10, 278]] as const) box(`p4.${i}`, 3, 116, y);
  return {
    formName: IOWA_PV_WORKSHEET_FORM_NAME, sourceUrl, fillMode: "overlay" as const,
    textFields: {} as Record<string, string>, checkboxes: {} as Record<string, { source: string; equals?: string }>,
    overlayFields: f, signatureFields: [],
    requiredFields: {
      "maximum system voltage (module Voc, temperature coefficient, site low temperature)": "computed.iaPv.p2.maxSystemVoltage",
      "maximum circuit current": "computed.iaPv.p2.maxCircuitCurrent",
      "number of arrays (mounting planes)": "computed.iaPv.p2.arrays",
      "service conductor size": "computed.iaPv.p2.serviceConductor",
      "interconnection (705.11 line side or 705.12 load side)": "computed.iaPv.p4.8",
    },
    notes: "Iowa SFM PV worksheet (2020 NEC) recognised by its printed labels at their exact positions. Values are the project's parsed fields and written-out derivations (iowaPvWorksheet.ts); unknowns stay blank and are listed as missing. Page 4 items 3, 4 and 10 are the filer's attestation and are left for the person who reviews and files. The 705.12(B) row mark position is estimated — preview before filing.",
  };
}

/** A blank whose text layer carries every anchor -> the field map; anything else -> null. */
export async function iowaPvWorksheetTemplate(bytes: Uint8Array, sourceUrl: string) {
  const { extractLabels } = await import("./formTextLayer");
  const labels = await extractLabels(bytes);
  if (!labels.length || iowaPvWorksheetAnchorMisses(labels).length) return null;
  return iowaPvWorksheetFieldMap(sourceUrl);
}

/** Required-document wording that names this worksheet (Iowa City's EnerGov card is "Standard or
 *  Micro-Inverter Array ..."). One predicate for the lookup's documents and the state rule. */
export function namesPvWorksheet(text: string): boolean {
  return /(?:standard|string)\s*(?:or|\/)\s*micro[-\s]*inverter\s+array|photovoltaic\s+(?:systems?\s+)?worksheet|\bpv\s+(?:system\s+)?worksheet/i.test(String(text ?? ""));
}
