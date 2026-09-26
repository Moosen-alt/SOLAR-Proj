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

/** A 705.12(B) subsection the plan itself cites ("705.12(B)(3)(2)", "705.12(B)(2)(3)(b)" in
 *  2017 numbering is not mapped) -> the worksheet row id, or "". */
export function citedLoadSideRow(text: string): { row: string; quote: string } {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const m = /705\.12\s*\(B\)\s*\(([123])\)(?:\s*\(([1-6a-b])\))?/i.exec(t);
  if (m) {
    const quote = t.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).trim();
    if (m[1] === "1" && /^[ab]$/i.test(m[2] ?? "")) return { row: `B1${m[2].toLowerCase()}`, quote };
    if (m[1] === "2" && !m[2]) return { row: "B2", quote };
    if (m[1] === "3" && /^[1-6]$/.test(m[2] ?? "")) return { row: `B3${m[2]}`, quote };
  }
  const pct = /\b120\s*%\s*(?:rule|busbar|of (?:the )?bus)|\bbus(?:bar)?\s*(?:rating\s*)?x\s*1\.2\b|\bx\s*120\s*%/i.exec(t);
  if (pct) return { row: "B32", quote: t.slice(Math.max(0, pct.index - 30), pct.index + pct[0].length + 30).trim() };
  return { row: "", quote: "" };
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
  if (oriented.length) {
    list = oriented;
    const keys = new Set((list as unknown[]).map((a) => {
      const o = (a ?? {}) as Record<string, unknown>;
      return `${firstNumber(o.tilt) ?? "?"}/${firstNumber(o.azimuth) ?? "?"}`;
    }));
    return { count: keys.size, basis: `pvArrays lists ${oriented.length} oriented array(s) on ${keys.size} distinct tilt/azimuth plane(s)` };
  }
  const az = String(snapshot.azimuth ?? "").trim();
  const tilt = String(snapshot.tilt ?? "").trim();
  if (az || tilt) {
    const azs = az ? az.split(/[\/,;&]|\band\b/).map((s) => s.trim()).filter(Boolean) : [];
    const tilts = tilt ? tilt.split(/[\/,;&]|\band\b/).map((s) => s.trim()).filter(Boolean) : [];
    const n = Math.max(azs.length, tilts.length, 1);
    return { count: n, basis: `azimuth "${az}" / tilt "${tilt}" -> ${n} plane(s)` };
  }
  return { count: null, basis: "no azimuth/tilt or per-array breakdown parsed" };
}

export function iowaPvWorksheetValues(project: ProjectRecord): IowaPvWorksheet {
  const s = (project.parserSnapshot ?? {}) as Record<string, unknown>;
  const str = (k: string) => String(s[k] ?? "").trim();
  const n = (k: string) => firstNumber(s[k]);
  const amps = (k: string) => { const v = str(k); return v ? parseRating(v) : null; };
  const values: Record<string, string> = {};
  const basis: Record<string, string> = {};
  const questions: WorksheetQuestion[] = [];
  const set = (id: string, v: string, why: string) => { values[id] = v; basis[id] = why; };
  const ask = (key: string, label: string, options: string[] = []) => {
    if (!questions.some((q) => q.key === key)) questions.push({ key, label, options, kind: "form-fact" });
  };
  const text = [str("electricalCalcText"), str("labelsText"), str("planSetExtractedText"), str("projectDescriptionText")].join("\n");

  // ── topology ───────────────────────────────────────────────────────────────────────────
  const micro = Boolean(str("pvMicroMake") || str("pvMicroModel"));
  const stringInv = !micro && Boolean(str("invMake") || str("invModel"));
  const optimizer = /optimi[sz]er|\bTS4-A-O\b/i.test(`${str("invModel")} ${text}`) || (stringInv && /solaredge/i.test(str("invMake")));
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
  const planes = mountingPlaneCount(s);
  set("p2.arrays", planes.count != null ? String(planes.count) : "", planes.basis);
  if (planes.count == null) ask("iaPvArrayCount", "How many arrays (distinct mounting planes) does this system have? (not the module count)");

  // ── inverters, battery, DC-DC ─────────────────────────────────────────────────────────
  const unitQty = micro ? n("pvMicroQty") : n("invQty");
  set("p2.numInverters", unitQty != null ? String(unitQty) : "", micro ? `pvMicroQty "${str("pvMicroQty")}"` : `invQty "${str("invQty")}"`);
  const battery = Boolean(str("batteryMake") || str("batteryModel") || (n("batteryQty") ?? 0) > 0);
  set("p2.battery", battery ? "Y" : "N", battery ? `battery listed (${str("batteryMake")} ${str("batteryModel")})`.trim() : "derived: no battery/ESS in the parsed plan set");
  set("p2.dcdc", micro && !optimizer ? "N/A" : optimizer ? "Yes" : "", micro && !optimizer ? "derived: microinverter system, no DC-DC converter (optimizer) listed"
    : optimizer ? "derived: DC-DC converters (optimizers) on the plan set" : "no inverter topology parsed");

  // ── circuit current ────────────────────────────────────────────────────────────────────
  const unitA = micro ? amps("pvMicroOutputW") : amps("invOutputW");
  let circuitA: number | null = null;
  let circuitCalc = "";
  if (unitQty != null && unitA != null && unitQty > 0 && unitA > 0 && unitA < 100) {
    circuitA = unitQty * unitA;
    circuitCalc = `${unitQty} x ${fmt(unitA)} A = ${fmt(circuitA)} A`;
    // AC-coupled ESS on a micro system: its inverter's output adds to the circuit current.
    if (micro && battery) {
      const essA = str("invOutputW") && (str("invMake") || str("invModel")) ? amps("invOutputW")
        : n("batteryOutputKw") != null ? (n("batteryOutputKw")! * 1000) / 240 : null;
      if (essA != null && essA > 0 && essA < 100) {
        circuitA += essA;
        circuitCalc = `${unitQty} x ${fmt(unitA)} A + ESS ${fmt(essA)} A = ${fmt(circuitA)} A`;
      } else {
        circuitA = null; circuitCalc = "";
        ask("iaPvEssOutputA", "What is the ESS (battery) inverter's rated continuous output current, in amps?");
      }
    }
  }
  if (circuitA == null && !questions.some((q) => q.key === "iaPvEssOutputA")) ask("iaPvUnitOutputA", "What is each inverter's rated continuous AC output current (amps, from its datasheet)?");
  set("p2.maxCircuitCurrent", circuitA != null ? `${fmt(circuitA)}A` : "", circuitA != null ? `derived: ${circuitCalc} (qty x per-unit rated output current)` : "per-unit output current or quantity not parsed");

  // ── min PV OCPD ────────────────────────────────────────────────────────────────────────
  const minOcpd = circuitA != null ? nextStandardOcpd(circuitA * 1.25) : null;
  const pvBreaker = amps("pvBreaker");
  set("p2.minPvOcpd", minOcpd != null ? `${minOcpd}A` : pvBreaker != null ? `${pvBreaker}A` : "",
    minOcpd != null ? `derived: ${fmt(circuitA!)} A x 1.25 = ${fmt(circuitA! * 1.25)} A -> ${minOcpd} A standard size (NEC 240.6(A))${pvBreaker != null ? `; plan PV breaker ${pvBreaker} A` : ""}`
      : pvBreaker != null ? `pvBreaker "${str("pvBreaker")}" (no circuit current to check it against)` : "no PV breaker or circuit current parsed");

  // ── interconnection ────────────────────────────────────────────────────────────────────
  const side = interconnectionSide(`${project.interconnectionMethod ?? ""}\n${str("interco")}`);
  set("p2.lineside", side === "supply" ? "X" : "", `interco "${str("interco")}" -> ${side}`);
  set("p2.loadside", side === "load" ? "X" : "", `interco "${str("interco")}" -> ${side}`);
  if (side === "both" || side === "unknown") {
    ask("iaPvInterconnection", `Is the PV connection line side (705.11) or load side (705.12)? The plan set reads "${str("interco") || "nothing"}".`, ["Line side (705.11)", "Load side (705.12)"]);
  }
  const volts = String(str("serviceVoltage") || str("voltage")).match(/\d{3}/g);
  set("p2.serviceVoltage", volts ? volts[volts.length - 1] : "", `serviceVoltage "${str("serviceVoltage") || str("voltage")}"`);
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
    const cited = citedLoadSideRow(text);
    const main = amps("mainBreaker") ?? service;
    const intercoText = str("interco").toLowerCase();
    if (cited.row) {
      set(`p2.lsc.${cited.row}`, "X", `the plan's own method: "${cited.quote}"`);
    } else if (/feeder|sub.?panel/.test(intercoText)) {
      ask("iaPvFeederRow", "The PV connects on a feeder: which 705.12(B)(1) item applies — (a) or (b)?", ["705.12(B)(1)(a)", "705.12(B)(1)(b)"]);
    } else if (/\btap\b/.test(intercoText)) {
      set("p2.lsc.B2", "X", `interco "${str("interco")}" is a load-side tap -> 705.12(B)(2)`);
    } else if (bus != null && main != null && circuitA != null) {
      const need = 1.25 * circuitA;
      if (need + main <= bus + 1e-9) {
        set("p2.lsc.B31", "X", `derived: 1.25 x ${fmt(circuitA)} A + ${main} A main = ${fmt(need + main)} A <= ${bus} A bus (705.12(B)(3)(1), 100% rule)`);
      } else if (bus * 1.2 - main >= Math.max(need, pvBreaker ?? 0) - 1e-9) {
        set("p2.lsc.B32", "X", `derived: ${bus} A x 1.2 - ${main} A = ${fmt(bus * 1.2 - main)} A >= ${pvBreaker != null ? `${pvBreaker} A PV breaker` : `${fmt(need)} A`} (705.12(B)(3)(2), 120% rule — PV breaker at the opposite end of the busbar from the main; confirm on the one-line)`);
      } else {
        basis["p2.lsc.B32"] = `neither busbar rule holds: 1.25 x ${fmt(circuitA)} + ${main} = ${fmt(need + main)} > ${bus}; ${bus} x 1.2 - ${main} = ${fmt(bus * 1.2 - main)} < ${fmt(Math.max(need, pvBreaker ?? 0))}`;
        ask("iaPvLoadSideRow", "Neither the 100% nor the 120% busbar rule holds with the parsed ratings. Which 705.12(B)(3) subsection does the design use?");
      }
    } else {
      ask("iaPvLoadSideRow", "Which 705.12(B) subsection does the load-side connection use? Bus, main or PV breaker ratings were not all parsed.");
    }
  }

  // ── page 3: location ───────────────────────────────────────────────────────────────────
  const units = n("dwellingUnits");
  const cat = str("constructionCategory");
  const oneTwo = (units != null && units >= 1 && units <= 2) || /\bR-?3\b|single[-\s]?family|two[-\s]?family|duplex/i.test(cat);
  set("p3.loc12fam", onBuilding && oneTwo ? "X" : "", oneTwo ? `derived: ${units != null ? `${units} dwelling unit(s)` : `occupancy "${cat}"`}` : "dwelling units / occupancy not parsed");
  set("p3.locOther", "", "");
  set("p3.locNotBuilding", ground && !roof ? "X" : "", ground && !roof ? "derived: ground mount" : "");
  if (onBuilding && !oneTwo) ask("dwellingUnits", "How many dwelling units are in the building the array is on?", ["1", "2", "3 or more"]);

  // ── Part A: 690.7 maximum voltage ──────────────────────────────────────────────────────
  for (const id of ["p3.A1", "p3.A2", "p3.A3", "p3.B1", "p3.B2"]) set(id, "", "");
  const voc = n("moduleVoc");
  const beta = n("moduleVocTempCoeff");
  const low = n("siteLowTempC");
  const perString = micro ? 1 : n("modulesPerString");
  const microMaxDc = n("pvMicroMaxDcInputV");
  let maxV: number | null = null;
  let partA = "";
  if (optimizer) {
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
    if (maxV != null && micro && microMaxDc != null) partA += ` per micro input (<= ${fmt(microMaxDc)} V micro max DC input${maxV > microMaxDc ? " — EXCEEDS the micro's max input" : ""})`;
  } else if (micro && microMaxDc != null && voc == null) {
    maxV = microMaxDc;
    partA = `Microinverter listed maximum DC input ${fmt(microMaxDc)} V (module Voc not parsed; the micro's listing bounds each input)`;
  }
  if (!optimizer) {
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
