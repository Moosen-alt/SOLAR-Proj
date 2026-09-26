// GATE CHECKS FROM IOWA CITY'S REAL CORRECTION THEMES.
//
// 217 residential solar permits, 40% re-submitted; the STATE PV WORKSHEET is the top theme (8
// permits), then OCPD/conductor sizing, the one-line. On five text worksheets checked against
// their own plan sets (.probe/kin/ia/corpus/report.md): max system voltage entered as 240 (AC)
// on micro systems 3/5; interconnection wrong/blank/ambiguous 3/5 ("This is a line side
// connection, not loadside connection"; one ticked FOUR 705.12 rows); circuit current as ONE
// micro's 1.35 A (should be 40.5) 1/5; arrays = module count 1/5; a worksheet stale after a
// revision (the plan now shows a 40 A load breaker, the worksheet still says line side) 1/5.
// Roesler's response letter: the one-line's MSP rating had to be corrected 100/100 -> 200/200 to
// match the existing gear, because the 705.12 math depends on it.
//
// Each finding compares what the FILED worksheet says (read by position off its own text
// layer — readFiledPvWorksheet) with what the plan set and iowaPvWorksheetValues derive, and
// quotes both. NONE fires when the numbers agree; an unreadable worksheet raises nothing here
// (the requirement row already says whether one is owed).
//
// 2017 -> 2020 NEC numbering is mapped (705.12(A) supply side -> 705.11; 705.12(B)(2)(3)(a/b/c)
// -> (B)(3)(1/2/3)) because both editions' texts are settled. The 2023-edition worksheet in
// circulation is known only from a handwritten scan (an installer wrote "705.12(B)(5)" and a note
// that the form's sections are not the 2023 NEC he uses); no 2023 row map is encoded from memory.
// A plan citation that is not a 2020 row is reported as exactly that — for a person to map.
import type { CodeReference, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { citedLoadSideRow, interconnectionSide, iowaPvWorksheetAnchorMisses, iowaPvWorksheetValues, mountingPlaneCount } from "./iowaPvWorksheet";

export interface FiledWorksheetReading {
  /** Text read in each value zone of the filed worksheet ("" when blank). */
  values: Record<string, string>;
  /** 705.12(B) rows marked on the filed worksheet (row ids, e.g. "B32"). */
  lscRows: string[];
}

const LSC_ROWS: Array<[string, number]> = [["B1a", 183], ["B1b", 168], ["B2", 152], ["B31", 137], ["B32", 122], ["B33", 107], ["B34", 91], ["B35", 76], ["B36", 61]];
const MARK = /^\s*[xX✓✔√]\s*$/;

/** Read a FILED Iowa SFM worksheet (2020 edition) by position. null when the PDF is not that
 *  edition (anchors missing/moved) — never a guess from another layout. */
export async function readFiledPvWorksheet(bytes: Uint8Array): Promise<FiledWorksheetReading | null> {
  const { extractLabels } = await import("./formTextLayer");
  const labels = await extractLabels(bytes);
  if (!labels.length || iowaPvWorksheetAnchorMisses(labels).length) return null;
  return readFromLabels(labels);
}

export function readFromLabels(labels: Array<{ page: number; str: string; x: number; y: number }>): FiledWorksheetReading {
  const zone = (page: number, x0: number, x1: number, y: number, tol = 5) => labels
    .filter((l) => l.page === page && l.x >= x0 && l.x < x1 && Math.abs(l.y - y) <= tol)
    .sort((a, b) => a.x - b.x).map((l) => l.str.trim()).filter(Boolean).join(" ");
  const box = (page: number, x0: number, x1: number, y: number) => MARK.test(zone(page, x0, x1, y, 5)) ? "X" : "";
  const values: Record<string, string> = {
    "p2.arrays": zone(1, 60, 105, 540, 6),
    "p2.maxSystemVoltage": zone(1, 225, 325, 401),
    "p2.maxCircuitCurrent": zone(1, 225, 325, 379),
    "p2.numInverters": zone(1, 225, 325, 357),
    "p2.battery": zone(1, 225, 325, 336),
    "p2.minPvOcpd": zone(1, 225, 325, 313),
    "p2.dcdc": zone(1, 225, 325, 291),
    "p2.lineside": box(1, 470, 530, 402),
    "p2.loadside": box(1, 470, 530, 380),
    "p2.serviceVoltage": zone(1, 470, 612, 357),
    "p2.serviceAmps": zone(1, 470, 612, 337),
    "p2.busRating": zone(1, 470, 612, 313),
    "p2.serviceConductor": zone(1, 470, 612, 291),
  };
  const lscRows = LSC_ROWS.filter(([, y]) => MARK.test(zone(1, 100, 181, y + 1, 5))).map(([id]) => id);
  return { values, lscRows };
}

const num = (s: string) => { const m = String(s ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };
const ROW_NAME: Record<string, string> = {
  B1a: "705.12(B)(1)(a)", B1b: "705.12(B)(1)(b)", B2: "705.12(B)(2)", B31: "705.12(B)(3)(1)", B32: "705.12(B)(3)(2)",
  B33: "705.12(B)(3)(3)", B34: "705.12(B)(3)(4)", B35: "705.12(B)(3)(5)", B36: "705.12(B)(3)(6)",
};

/** A plan citation in 2017 numbering, mapped to the 2020 row the Iowa worksheet prints. */
export function map2017LoadSideRow(text: string): { row: string; quote: string } {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const m = /705\.12\s*\(B\)\s*\(2\)\s*\(3\)\s*\(([abc])\)/i.exec(t);
  if (!m) return { row: "", quote: "" };
  return { row: ({ a: "B31", b: "B32", c: "B33" } as const)[m[1].toLowerCase() as "a" | "b" | "c"], quote: t.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).trim() };
}

/** A 705.12 citation in the plan text that is NOT a 2020-edition row (e.g. "705.12(B)(5)"). */
export function nonEdition2020Citation(text: string): string {
  const t = String(text ?? "");
  for (const m of t.matchAll(/705\.12\s*\(B\)\s*\((\d)\)(?:\s*\((\w)\))?(?:\s*\((\w)\))?/gi)) {
    const [whole, a, b, c] = m;
    const ok = (a === "1" && /^[ab]$/i.test(b ?? "") && !c) || (a === "2" && !b) || (a === "3" && /^[1-6]$/.test(b ?? "") && !c)
      || (a === "2" && b === "3" && /^[abc]$/i.test(c ?? "")); // 2017, mapped above
    if (!ok) return whole.replace(/\s+/g, "");
  }
  return "";
}

const pvwsRef: CodeReference = {
  code: "NEC 2020 (as adopted by the State of Iowa)",
  section: "690.7, 690.8, 690.9, 705.11, 705.12",
  title: "Iowa State Fire Marshal PV worksheet",
  adoptionScope: "Iowa electrical inspection (State Fire Marshal Electrical Bureau worksheet, 2020 NEC edition).",
  sourceUrl: "",
  note: "Worksheet pages 2-3; the filer attests on page 4 that they are complete and accurate.",
};

function finding(id: string, severity: ReviewerFinding["severity"], title: string, message: string, action: string, evidence: string[]): ReviewerFinding {
  return {
    id, severity, category: "electrical", title, message,
    cityFeedback: message, designTeamAction: action, evidenceNeeded: evidence,
    codeReferences: [pvwsRef], installerCallout: true,
  };
}

export interface PvWorksheetGateInput {
  reading: FiledWorksheetReading | null;
  /** When the filed worksheet and the newest plan set were uploaded (ISO). */
  worksheetUploadedAt?: string;
  newestPlanUploadedAt?: string;
  /** The plan set's own words (for its cited 705.12 method). */
  planText?: string;
}

export function pvWorksheetFindings(project: ProjectRecord, input: PvWorksheetGateInput): ReviewerFinding[] {
  const out: ReviewerFinding[] = [];
  const r = input.reading;
  if (!r) return out;
  const derived = iowaPvWorksheetValues(project);
  const d = derived.values;
  const s = (project.parserSnapshot ?? {}) as Record<string, unknown>;
  const v = r.values;

  // 1. CIRCUIT CURRENT = qty x per-unit A (+ ESS).
  const stated = num(v["p2.maxCircuitCurrent"]);
  const want = num(d["p2.maxCircuitCurrent"]);
  if (stated != null && want != null && Math.abs(stated - want) > Math.max(0.5, want * 0.03)) {
    const unitA = num(String(s.pvMicroOutputW ?? s.invOutputW ?? ""));
    const isc = num(String(s.moduleIsc ?? ""));
    const why = unitA != null && Math.abs(stated - unitA) < 0.05 ? " — that is ONE inverter's output current, not the circuit's"
      : isc != null && Math.abs(stated - isc) < 0.05 ? " — that is the module's DC Isc, not the inverter output circuit current" : "";
    out.push(finding("city.elec.pvws-circuit-current", "blocker", "Worksheet circuit current does not match the plan's inverters",
      `The worksheet's Maximum Circuit Current reads "${v["p2.maxCircuitCurrent"]}"${why}. The plan set gives ${derived.basis["p2.maxCircuitCurrent"].replace(/^derived: /, "")}.`,
      "Enter the inverter output circuit current (quantity x per-unit rated output current, plus any AC-coupled ESS inverter) and carry it through Part B and Part C.",
      ["Inverter datasheet output current", "Inverter quantity per circuit", "Part B / Part C calculations"]));
  }

  // 2. MAX SYSTEM VOLTAGE: never the AC service voltage; the 690.7 value when derivable.
  const statedV = num(v["p2.maxSystemVoltage"]);
  const serviceV = num(String(s.serviceVoltage ?? s.voltage ?? ""));
  const wantV = num(d["p2.maxSystemVoltage"]);
  if (statedV != null && (/\bAC\b/i.test(v["p2.maxSystemVoltage"]) || (serviceV != null && statedV === serviceV) || [120, 208, 240].includes(statedV))) {
    out.push(finding("city.elec.pvws-max-voltage-ac", "blocker", "Worksheet max system voltage is the AC service voltage",
      `The worksheet's Maximum System Voltage reads "${v["p2.maxSystemVoltage"]}" — the ${serviceV ?? statedV} V AC service. NEC 690.7 asks for the maximum PV DC voltage: module Voc corrected to the site's lowest temperature${wantV != null ? ` (${d["p2.maxSystemVoltage"]}: ${derived.basis["p2.maxSystemVoltage"].replace(/^derived: /, "")})` : ""}.`,
      "Enter the 690.7 maximum DC voltage (per micro input, or x modules in series on a string) and show the Part A calculation.",
      ["Module datasheet Voc and temperature coefficient", "Site extreme low temperature", "Part A calculation"]));
  } else if (statedV != null && wantV != null && Math.abs(statedV - wantV) > Math.max(1, wantV * 0.05)) {
    out.push(finding("city.elec.pvws-max-voltage", "warning", "Worksheet max system voltage differs from the 690.7 calculation",
      `The worksheet's Maximum System Voltage reads "${v["p2.maxSystemVoltage"]}"; the plan set's module gives ${d["p2.maxSystemVoltage"]} (${derived.basis["p2.maxSystemVoltage"].replace(/^derived: /, "")}). An uncorrected STC Voc, or another module's Voc, reads this way.`,
      "Use the installed module's datasheet Voc, corrected per 690.7(A).", ["Module datasheet", "Part A calculation"]));
  }

  // 3. EXACTLY ONE interconnection method, consistent with the plan.
  const line = v["p2.lineside"] === "X";
  const load = v["p2.loadside"] === "X";
  const planSide = interconnectionSide(`${project.interconnectionMethod ?? ""}\n${String(s.interco ?? "")}`);
  const planWords = String(s.interco ?? project.interconnectionMethod ?? "").trim();
  if (line && load) {
    out.push(finding("city.elec.pvws-interconnection-both", "blocker", "Worksheet marks both line side and load side",
      `The worksheet marks both "Lineside Connect 705.11" and "Loadside Connect 705.12"; the plan set reads "${planWords}". Exactly one applies.`,
      "Mark the one interconnection the one-line shows.", ["One-line point of interconnection"]));
  } else if (!line && !load) {
    out.push(finding("city.elec.pvws-interconnection-none", "blocker", "Worksheet marks no interconnection method",
      `Neither "Lineside Connect 705.11" nor "Loadside Connect 705.12" is marked; the plan set reads "${planWords || "nothing"}".`,
      "Mark the interconnection the one-line shows.", ["One-line point of interconnection"]));
  } else {
    const wsSide = line ? "supply" : "load";
    if ((planSide === "supply" || planSide === "load") && planSide !== wsSide) {
      out.push(finding("city.elec.pvws-interconnection-contradicts-plan", "blocker", "Worksheet interconnection contradicts the plan",
        `The worksheet marks ${line ? "LINE side (705.11)" : "LOAD side (705.12)"}, but the plan set reads "${planWords}" — a ${planSide === "supply" ? "line-side (705.11)" : "load-side (705.12)"} connection. A worksheet not updated after a revision reads this way.`,
        "Update the worksheet to the interconnection the current one-line shows.", ["Current one-line", "Worksheet page 2"]));
    }
    if (line && r.lscRows.length) {
      out.push(finding("city.elec.pvws-interconnection-line-side-row", "blocker", "Line-side connection with a load-side row marked",
        `The worksheet marks line side (705.11) and ALSO the load-side row(s) ${r.lscRows.map((x) => ROW_NAME[x]).join(", ")}. "This is a line side connection, not loadside connection" (Iowa City reviewer).`,
        "Clear the 705.12(B) rows on a line-side connection.", ["Worksheet page 2"]));
    }
    if (load && r.lscRows.length !== 1) {
      out.push(finding("city.elec.pvws-interconnection-rows", "blocker", r.lscRows.length ? "More than one 705.12(B) row marked" : "Load-side connection with no 705.12(B) row",
        r.lscRows.length
          ? `The worksheet marks ${r.lscRows.length} load-side rows (${r.lscRows.map((x) => ROW_NAME[x]).join(", ")}); the form asks for the ONE code section used.${d[`p2.lsc.B32`] === "X" || d["p2.lsc.B31"] === "X" ? ` The plan's ratings give ${ROW_NAME[Object.keys(ROW_NAME).find((k) => d[`p2.lsc.${k}`] === "X")!]}.` : ""}`
          : `The worksheet marks load side but leaves the 705.12(B) section blank.${Object.keys(ROW_NAME).some((k) => d[`p2.lsc.${k}`] === "X") ? ` The plan's ratings give ${ROW_NAME[Object.keys(ROW_NAME).find((k) => d[`p2.lsc.${k}`] === "X")!]}: ${derived.basis[`p2.lsc.${Object.keys(ROW_NAME).find((k) => d[`p2.lsc.${k}`] === "X")}`]}.` : ""}`,
        "Mark the one 705.12(B) subsection the design uses.", ["Busbar calculation on the one-line"]));
    }
    if (load && r.lscRows.length === 1) {
      const planText = input.planText ?? "";
      const cited = citedLoadSideRow(planText).row ? citedLoadSideRow(planText) : map2017LoadSideRow(planText);
      if (cited.row && cited.row !== r.lscRows[0]) {
        out.push(finding("city.elec.pvws-interconnection-row-differs", "warning", "Worksheet 705.12(B) row differs from the plan's method",
          `The worksheet marks ${ROW_NAME[r.lscRows[0]]}; the plan set's own method is ${ROW_NAME[cited.row]} ("${cited.quote}").`,
          "Mark the subsection the one-line's calculation uses.", ["Busbar calculation on the one-line"]));
      }
    }
  }
  const odd = nonEdition2020Citation(input.planText ?? "");
  if (odd) {
    out.push(finding("city.elec.pvws-code-edition", "callout", "Plan cites a 705.12 section that is not a 2020 NEC row",
      `The plan set cites "${odd}", which is not a 705.12 subsection in the 2020 NEC the Iowa worksheet prints (it may be another edition's numbering). No automatic edition map is applied — confirm which 2020 row it corresponds to.`,
      "State the 2020-NEC subsection on the worksheet (the edition Iowa adopted), or note the edition the design used.", ["Code edition on the one-line"]));
  }

  // 4. ARRAYS = mounting planes, never the module count.
  const statedArrays = num(v["p2.arrays"]);
  const planes = mountingPlaneCount(s);
  const moduleQty = num(String(s.moduleQty ?? ""));
  if (statedArrays != null && planes.count != null && statedArrays !== planes.count) {
    out.push(finding("city.elec.pvws-arrays", "warning", statedArrays === moduleQty ? "Worksheet counts modules as arrays" : "Worksheet array count differs from the plan",
      `The worksheet says ${statedArrays} array(s)${statedArrays === moduleQty ? ` — the module count (${moduleQty})` : ""}; the plan set shows ${planes.count} mounting plane(s) (${planes.basis}).`,
      "Enter the number of arrays (distinct mounting planes).", ["Roof plan / array schedule"]));
  }

  // 5. NOT OLDER THAN THE NEWEST PLAN REVISION.
  if (input.worksheetUploadedAt && input.newestPlanUploadedAt && input.worksheetUploadedAt < input.newestPlanUploadedAt) {
    out.push(finding("city.elec.pvws-stale", "warning", "Worksheet predates the newest plan set",
      `The PV worksheet was attached ${input.worksheetUploadedAt.slice(0, 10)}, before the newest plan set (${input.newestPlanUploadedAt.slice(0, 10)}). Iowa City bounced a worksheet that still said line side after the plan moved to a load breaker.`,
      "Re-check (or regenerate) the worksheet against the current plan set before filing.", ["Current plan set", "Updated worksheet"]));
  }
  return out;
}


// ── THE ONE-LINE'S SERVICE RATINGS AGREE WITH THE REST OF THE SET ──────────────────────────
// Roesler's correction: "MSP rating updated 100/100 A to 200/200 A". Each KIND of statement is
// compared only with its own kind — a panel ("200A MSP"), a busbar ("225A BUS", "BUS RATING
// 225A") and a main breaker ("200A MAIN BREAKER") are different ratings, and a 225 A bus under a
// 200 A main is ordinary. More than one distinct value of the SAME kind is a finding. A statement
// marked new ("(N)", "NEW") is not the existing gear, and a set that upgrades the service (MPU)
// legitimately carries two panel ratings, so it is not checked. Applies in any state.
export interface RatingStatement { amps: number; quote: string }
export function serviceRatingStatements(text: string): { panel: RatingStatement[]; bus: RatingStatement[]; main: RatingStatement[] } {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const out = { panel: [] as RatingStatement[], bus: [] as RatingStatement[], main: [] as RatingStatement[] };
  const take = (kind: keyof typeof out, re: RegExp) => {
    for (const m of t.matchAll(re)) {
      const i = m.index ?? 0;
      const before = t.slice(Math.max(0, i - 14), i);
      if (/\(N\)\s*$|\bNEW\s*$/i.test(before) || /^\(N\)|\bNEW\b/i.test(m[0])) continue;
      const amps = Number(m.slice(1).find((g) => g) ?? NaN);
      if (amps >= 60 && amps <= 800) out[kind].push({ amps, quote: t.slice(Math.max(0, i - 25), i + m[0].length + 25).trim() });
    }
  };
  take("panel", /\b(?:MSP|MAIN SERVICE PANEL|MAIN PANEL(?:BOARD)?)\s*(?:RATING)?\s*[:=]?\s*(?:\(E\)\s*)?(\d{2,3})\s*A(?:MPS?)?\b|\b(?:\(E\)\s*)?(\d{2,3})\s*A(?:MPS?)?\s+(?:\(E\)\s*)?(?:MSP|MAIN SERVICE PANEL)\b/gi);
  take("bus", /\bBUS(?:BAR)?\s*(?:RATING)?\s*[:=]?\s*(\d{2,3})\s*A\b|\b(\d{2,3})\s*A(?:MPS?)?\s+BUS(?:BAR)?\b/gi);
  take("main", /\bMAIN\s+(?:BREAKER|DISCONNECT|OCPD)\s*(?:RATING)?\s*[:=]?\s*(?:\(E\)\s*)?(\d{2,3})\s*A\b|\b(\d{2,3})\s*A\s*(?:\/?\s*2P\s*)?MAIN\s+(?:BREAKER|DISCONNECT)\b/gi);
  return out;
}

const SERVICE_UPGRADE = /\bMPU\b|\b(?:MAIN\s+)?(?:PANEL|SERVICE|MSP)\s+UPGRADE|\bUPGRADE(?:D)?\s+(?:THE\s+)?(?:EXISTING\s+)?(?:MSP|MAIN|SERVICE|PANEL)|\bREPLAC\w*\s+(?:THE\s+)?(?:EXISTING\s+|\(E\)\s*)?(?:MSP|MAIN SERVICE PANEL|MAIN PANEL)/i;

export function serviceRatingConsistencyFindings(project: ProjectRecord, planText: string): ReviewerFinding[] {
  const out: ReviewerFinding[] = [];
  if (SERVICE_UPGRADE.test(planText)) return out;
  const st = serviceRatingStatements(planText);
  for (const [what, list] of [["main service panel rating", st.panel], ["busbar rating", st.bus], ["main breaker rating", st.main]] as const) {
    const distinct = [...new Set(list.map((x) => x.amps))];
    if (distinct.length < 2) continue;
    const s = (project.parserSnapshot ?? {}) as Record<string, unknown>;
    out.push(finding("city.elec.service-rating-mismatch", "blocker", `The set states more than one ${what}`,
      `The plan set states the existing ${what} as ${distinct.map((a) => `${a} A ("${list.find((x) => x.amps === a)!.quote}")`).join(" and ")}. The one-line reads bus ${String(s.busRating ?? "?")} / main ${String(s.mainBreaker ?? "?")}; the 705.12 busbar math depends on the real existing gear.`,
      "Make the one-line's service ratings match the existing equipment and the rest of the set, then re-run the busbar calculation.",
      ["Photo or label of the existing service panel rating", "One-line service ratings", "705.12 calculation"]));
  }
  return out;
}
