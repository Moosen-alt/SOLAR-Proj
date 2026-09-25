// ---------------------------------------------------------------------------
// Reference-spreadsheet importers. Bulk-load the operator's curated xlsx lists
// into the knowledge base as SEEDED data, never clobbering human-verified rows:
//   • AHJ adopted codes (Polaris / NEC_and_Inspection) → jurisdiction_code_profiles
//     (the reviewer gate's per-jurisdiction adopted editions + setbacks + stamps).
//   • Utility NEM knowledge (Lighthouse Utilities / Utility_Company_List) → utility
//     KB (submission instructions, disconnect/production-meter/HOI rules, notes).
//   • AHJ process/portal (Township_Restrictions) → AHJ KB (portals, emails, notes).
//
// SECURITY: utility credential columns (Username/Password) are never read.
// Only rows carrying real values are written; name+state-only rows are skipped.
// ---------------------------------------------------------------------------

import type { AppDb } from "./db";
import type { CodeEdition, FireSetbackRule, JurisdictionCodeAmendment, JurisdictionCodeProfile, JurisdictionDesignCriteria } from "../../shared/src/types";
import { readXlsx, pick, type SheetData } from "./xlsxRead";
import { codeProfileKey, getCodeProfile, listCodeProfiles, resolveCriteriaWriteRow, saveResearchedCodeProfile } from "./codeProfiles";
import { importSeededUtilityKnowledge, importSeededAhjKnowledge } from "./knowledgeBase";
import { logger } from "./logger";

export interface ImportSummary {
  dataset: string;
  imported: number;
  skippedVerified: number;
  skippedEmpty: number;
  dryRun: boolean;
  samples: string[];
}

// US state/province two-letter codes we accept as-is; a few sheet-name prefixes map on.
const STATE_CODES = new Set(["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"]);
const SHEET_STATE_HINT: Record<string, string> = { LI: "NY" }; // Long Island → NY

function stateFromSheetName(name: string): string {
  const prefix = name.split(/[-\s]/)[0].toUpperCase();
  if (STATE_CODES.has(prefix)) return prefix;
  if (SHEET_STATE_HINT[prefix]) return SHEET_STATE_HINT[prefix];
  return "";
}

function normState(v: string): string {
  const t = v.trim().toUpperCase();
  return STATE_CODES.has(t) ? t : t.slice(0, 2);
}

// Parse a code cell into edition + family. Handles "2020", "2021", "2018IBC",
// "2017 NEC", "7-16" (ASCE). Returns {edition} plus an optional embedded family.
function parseCode(cell: string): { edition: string; family?: string } | null {
  const s = cell.trim();
  if (!s || /^(n\/?a|none|tbd|unknown|-)$/i.test(s)) return null;
  // Drop prose placeholders ("Check AHJ Requirements", "See website", "Verify").
  if (/check|verify|see |contact|website|requirement|call|unknown|pending/i.test(s)) return null;
  // Year: no trailing \b so "2011NEC" / "2018IBC" parse to the year (NEC/IBC embed the
  // family with no separator). ASCE editions look like "7-16".
  const year = s.match(/(19|20)\d{2}/);
  const asce = s.match(/\b\d{1,2}-\d{2}\b/);
  const fam = s.match(/(NEC|IRC|IBC|IFC|IECC|IPC|IMC|ASCE|OESC|ORSC|CEC)/i);
  if (!year && !asce) return null; // no recognizable edition → skip (never store raw prose)
  return { edition: year ? year[0] : asce![0], family: fam ? fam[0].toUpperCase() : undefined };
}

function addEdition(out: CodeEdition[], family: string, cell: string): void {
  const parsed = parseCode(cell);
  if (!parsed) return;
  out.push({ code: parsed.family || family, edition: parsed.edition, notes: "Imported from operator reference list — verify against the AHJ.", origin: "import" });
}

// ---- AHJ adopted codes ----------------------------------------------------

/** Import a jurisdiction adopted-codes sheet (Polaris AHJ or NEC_and_Inspection Codes). */
export function importAhjCodesSheet(db: AppDb, sheet: SheetData, opts: { dryRun?: boolean } = {}): ImportSummary {
  const summary: ImportSummary = { dataset: `codes:${sheet.name}`, imported: 0, skippedVerified: 0, skippedEmpty: 0, dryRun: !!opts.dryRun, samples: [] };
  for (const row of sheet.rows) {
    const ahj = pick(row, "Name");
    const state = normState(pick(row, "State/Province", "State"));
    if (!ahj || !state) { summary.skippedEmpty++; continue; }

    const adoptedCodes: CodeEdition[] = [];
    addEdition(adoptedCodes, "NEC", pick(row, "NEC", "Electric Code", "Electrical Code"));
    addEdition(adoptedCodes, "IRC", pick(row, "IRC", "Residential Code"));
    addEdition(adoptedCodes, "IBC", pick(row, "IBC", "Building Code"));
    addEdition(adoptedCodes, "IFC", pick(row, "IFC", "Fire Code"));
    addEdition(adoptedCodes, "IECC", pick(row, "IECC"));
    addEdition(adoptedCodes, "ASCE", pick(row, "ASCE"));

    const setbacks = pick(row, "Set backs", "Setbacks");
    const fireSetbacks: FireSetbackRule[] = setbacks
      ? [{ id: "imported-setback", description: setbacks }]
      : [];

    const designCriteria: JurisdictionDesignCriteria = {};
    const wind = pick(row, "Required Windspeed", "Windspeed");
    const windNum = Number(wind.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(windNum) && windNum > 0) designCriteria.windSpeedMph = windNum;

    // Yes/No policy flags → amendments (visible to the reviewer, not code editions).
    const amendments: JurisdictionCodeAmendment[] = [];
    const flag = (label: string, ...names: string[]) => {
      const v = pick(row, ...names);
      if (v && /^(yes|y|required|true)/i.test(v)) amendments.push({ code: "AHJ", summary: `${label}: ${v}` });
    };
    flag("Structural stamp required", "Structural Stamp", "Structural Letter");
    flag("Electrical stamp required", "Electrical Stamp");
    flag("Load calculations required", "Load Calculations");
    const lineSide = pick(row, "Line Side Tap Allowed");
    if (lineSide) amendments.push({ code: "NEC", section: "705.11", summary: `Line-side tap allowed: ${lineSide}` });
    const pvMeter = pick(row, "PV Meter");
    if (pvMeter) amendments.push({ code: "AHJ", summary: `PV meter: ${pvMeter}` });

    if (!adoptedCodes.length && !fireSetbacks.length && !amendments.length && !designCriteria.windSpeedMph) {
      summary.skippedEmpty++;
      continue;
    }

    // THE AHJ'S OWN ROW, NEVER THE LAYERED READ. getCodeProfile folds the STATE row under every
    // lookup: merged onto it, a seeded city row saved the verified state's prescriptive block — the
    // 36/25 psf minimums — as its OWN seeded values, and a state-minimum BLOCKER on a 16 psf
    // prescriptive plan became a WARNING credited to the seeded city row. (With no city row at all,
    // the layered read answered with the state row: a verified state refused every new city.)
    // The row is the one every other writer of one AHJ's criteria resolves (resolveCriteriaWriteRow).
    const target = resolveCriteriaWriteRow(db, state, ahj);
    if (target?.kind === "blocked_verified") { summary.skippedVerified++; continue; }
    const existing = target && target.kind !== "create" ? target.profile : null;
    // A same-jurisdiction row under another label ("Coos Bay" for "City of Coos Bay") is the row
    // written, under its own name, so the import does not fork the jurisdiction into two rows.
    const rowAhj = existing?.ahj || ahj;
    const key = codeProfileKey({ state, ahj: rowAhj });

    if (summary.samples.length < 5) summary.samples.push(`${ahj} (${state}): ${adoptedCodes.map((c) => `${c.code} ${c.edition}`).join(", ") || "flags only"}`);
    if (opts.dryRun) { summary.imported++; continue; }

    // Merge onto any existing seeded profile so a second sheet (NEC after Polaris)
    // adds rather than replaces; a human-verified row was already skipped above.
    // The two LISTS a layered read takes whole from the AHJ row when it has any (adoptedCodes,
    // fireSetbacks — getCodeProfile) start from the state's when the AHJ row has none, as the
    // layered merge gave them before: a row saved with the sheet's "NEC 2023" alone would drop the
    // state's ORSC/OESC/IFC from every later read. Criteria, limits and amendments are never copied.
    // (Adopted codes no longer start from the state's: getCodeProfile now inherits them FAMILY BY
    // FAMILY at read time — inheritAdoptedCodes — and a copy froze the state's editions into the AHJ
    // row, so a later state update never reached it. fireSetbacks are still taken whole.)
    const stateLayer = getCodeProfile(db, { state, ahj: "" });
    const ownCodes = existing?.adoptedCodes ?? [];
    const ownSetbacks = existing?.fireSetbacks?.length ? existing.fireSetbacks : stateLayer?.fireSetbacks ?? [];
    const merged: JurisdictionCodeProfile = {
      key,
      state,
      ahj: rowAhj,
      confidence: "seeded",
      adoptedCodes: dedupeCodes([...ownCodes, ...adoptedCodes]),
      amendments: [...(existing?.amendments ?? []), ...amendments],
      designCriteria: { ...(existing?.designCriteria ?? {}), ...designCriteria },
      prescriptive: existing?.prescriptive ?? {},
      fireSetbacks: ownSetbacks.length ? ownSetbacks : fireSetbacks,
      citations: [...(existing?.citations ?? []), { label: `Operator reference list (${sheet.name})`, sourceUrl: "" }],
      updatedAt: new Date(0).toISOString(),
    };
    saveResearchedCodeProfile(db, merged);
    summary.imported++;
  }
  return summary;
}

function dedupeCodes(codes: CodeEdition[]): CodeEdition[] {
  const seen = new Map<string, CodeEdition>();
  for (const c of codes) if (!seen.has(c.code)) seen.set(c.code, c);
  return [...seen.values()];
}

// ---- Utility NEM ----------------------------------------------------------

/** Import a utility NEM sheet (Lighthouse "Utilities" or Utility_Company_List). */
export function importUtilityNemSheet(db: AppDb, sheet: SheetData, opts: { dryRun?: boolean } = {}): ImportSummary {
  const summary: ImportSummary = { dataset: `utility:${sheet.name}`, imported: 0, skippedVerified: 0, skippedEmpty: 0, dryRun: !!opts.dryRun, samples: [] };
  for (const row of sheet.rows) {
    const utility = pick(row, "Utility", "Name");
    const state = normState(pick(row, "Utility - State", "Utility Company State", "Market", "State"));
    if (!utility) { summary.skippedEmpty++; continue; }

    // Assemble notes from the operationally useful columns. Credentials are never read.
    const noteParts: string[] = [];
    const add = (label: string, ...names: string[]) => {
      const v = pick(row, ...names);
      if (v && !/^(n\/?a|none|unknown|-)$/i.test(v)) noteParts.push(`${label}: ${v.replace(/\s+/g, " ").slice(0, 240)}`);
    };
    add("Submit instructions", "Instructions to Submit 2.0", "Instructions to Submit");
    add("Special requirements", "Special Requirements");
    add("Design special requirements", "Design - Special Requirements");
    add("Requires interconnection approval (pre-install)", "Requires Interconnection Approval (Pre-Install)");
    add("Requires disconnect switch", "Requires Disconnect Switch");
    add("Requires production meter", "Requires Production Meter");
    add("Meter aggregation allowed", "Meter Aggregation Allowed");
    add("Green tag for scheduling", "Requires Green Tag for Scheduling");
    add("PV meter", "PV Meter");
    add("Line side tap allowed", "Line Side Tap Allowed");
    add("Est. NEM duration (days)", "Estimated Duration Days", "Actual NEM Duration");
    add("HOI required (Tier 1)", "Utility - HOI Required Tier 1");
    add("General notes", "General Notes");
    add("Battery notes", "Battery Notes");
    add("Contact", "Utility Contact");
    add("Phone", "Utility Phone");

    if (!noteParts.length) { summary.skippedEmpty++; continue; }
    if (summary.samples.length < 5) summary.samples.push(`${utility} (${state || "?"}): ${noteParts.length} field(s)`);
    if (opts.dryRun) { summary.imported++; continue; }

    const outcome = importSeededUtilityKnowledge(db, {
      state,
      utility,
      notes: noteParts.join(" | "),
      sourceLabel: `Operator reference list (${sheet.name})`,
    });
    if (outcome === "imported") summary.imported++;
    else if (outcome === "skipped_verified") summary.skippedVerified++;
    else summary.skippedEmpty++;
  }
  return summary;
}

// ---- AHJ process / portal -------------------------------------------------

/** Import a township-restrictions sheet (state derived from the sheet name). */
export function importAhjProcessSheet(db: AppDb, sheet: SheetData, opts: { dryRun?: boolean } = {}): ImportSummary {
  const summary: ImportSummary = { dataset: `ahj-process:${sheet.name}`, imported: 0, skippedVerified: 0, skippedEmpty: 0, dryRun: !!opts.dryRun, samples: [] };
  const state = stateFromSheetName(sheet.name);
  for (const row of sheet.rows) {
    const ahj = pick(row, "Municipality", "Township", "AHJ", "Name");
    if (!ahj || !state) { summary.skippedEmpty++; continue; }

    const portalUrl = pick(row, "Permit Search Website", "E File Website", "Online Permit Status", "Zoning Application L");
    const noteParts: string[] = [];
    const add = (label: string, ...names: string[]) => {
      const v = pick(row, ...names);
      if (v && !/^(n\/?a|none|unknown|-)$/i.test(v)) noteParts.push(`${label}: ${v.replace(/\s+/g, " ").slice(0, 200)}`);
    };
    add("Phone", "Phone #", "Phone");
    add("Permitting emails", "Permitting Emails");
    add("E-file", "E File");
    add("Special notes", "Special Notes");
    add("Roof restrictions", "Roof Restrictions");
    add("Ground mount restrictions", "Ground Mount Restrictions", "Ground Mount Restric");
    add("Zoning required", "Zoning Required");
    add("NOC email", "NOC Email Addresses");

    if (!portalUrl && !noteParts.length) { summary.skippedEmpty++; continue; }
    if (summary.samples.length < 5) summary.samples.push(`${ahj} (${state}): ${portalUrl ? "portal + " : ""}${noteParts.length} note(s)`);
    if (opts.dryRun) { summary.imported++; continue; }

    const outcome = importSeededAhjKnowledge(db, {
      state,
      ahj,
      portalUrl: /^https?:\/\//i.test(portalUrl) ? portalUrl : undefined,
      portalName: portalUrl && !/^https?:\/\//i.test(portalUrl) ? portalUrl.slice(0, 80) : undefined,
      notes: noteParts.join(" | "),
      sourceLabel: `Operator township-restrictions list (${sheet.name})`,
    });
    if (outcome === "imported") summary.imported++;
    else if (outcome === "skipped_verified") summary.skippedVerified++;
    else summary.skippedEmpty++;
  }
  return summary;
}

// ---- Stamp Requirements by AHJ -------------------------------------------

export interface StampSummaryRow {
  state: string;
  ahj: string;
  structural: "yes" | "no" | "";
  electrical: "yes" | "no" | "";
  notes: string;
}

/** Parse the operator's "Stamp Summary" sheet. The sheet opens with a totals
 *  block, so the REAL header ("State" / "AHJ / Jurisdiction" / "Structural
 *  Stamp" ...) is embedded a few rows down and the row keys are meaningless —
 *  find that row, learn which key carries which column, then read the rest
 *  positionally. Rows whose State cell is not a 2-letter code (footers,
 *  spacers) are dropped. Verified against v1.1: 572 rows parse and reconcile
 *  exactly with the sheet's own totals (331 structural / 148 electrical /
 *  136 both), zero duplicate state+AHJ keys. */
export function parseStampSummarySheet(sheet: SheetData): StampSummaryRow[] {
  let cols: Record<string, string> | null = null;
  const out: StampSummaryRow[] = [];
  const flag = (v: string): "yes" | "no" | "" => /^y(es)?$/i.test(v) ? "yes" : /^no?$/i.test(v) ? "no" : "";
  for (const row of sheet.rows) {
    if (!cols) {
      const vals = Object.values(row).map((v) => String(v).trim());
      if (vals.includes("State") && vals.some((v) => /structural stamp/i.test(v))) {
        cols = {};
        for (const [k, v] of Object.entries(row)) {
          const label = String(v).trim();
          if (label) cols[label] = k;
        }
      }
      continue;
    }
    const get = (label: string) => String(row[cols![label]] ?? "").trim();
    const state = get("State").toUpperCase();
    const ahj = get("AHJ / Jurisdiction");
    if (!/^[A-Z]{2}$/.test(state) || !ahj) continue;
    out.push({ state, ahj, structural: flag(get("Structural Stamp")), electrical: flag(get("Electrical Stamp")), notes: get("Special Notes") });
  }
  return out;
}

/** Import the stamp-requirements summary. Each row lands in TWO places, both
 *  seeded and both refusing to touch a human-verified row:
 *    · jurisdiction_code_profiles amendments — the SAME "Structural stamp
 *      required: Yes" vocabulary the codes importer writes, so the reviewer
 *      gate renders them identically. Yes-only on purpose: a "...: No" line
 *      would hand every text-matching consumer the words "stamp required" to
 *      misread (a filter list fails both ways).
 *    · a KB note segment carrying the FULL yes/no pair + the operator's note,
 *      where prose is read by humans, not matchers.
 *  Deliberately NOT set: prescriptive.engineerStampOverKwDc — a hard any-size
 *  stamp block is too strong a claim for a summary sheet whose own notes are
 *  conditional ("2x4 rafters need engineering"); routing stays with the
 *  project's resolved path and the AHJ's structured rules. */
export function importStampSummarySheet(db: AppDb, sheet: SheetData, opts: { dryRun?: boolean } = {}): ImportSummary {
  const summary: ImportSummary = { dataset: `stamps:${sheet.name}`, imported: 0, skippedVerified: 0, skippedEmpty: 0, dryRun: !!opts.dryRun, samples: [] };
  for (const row of parseStampSummarySheet(sheet)) {
    if (!row.structural && !row.electrical && !row.notes) { summary.skippedEmpty++; continue; }
    if (summary.samples.length < 5) summary.samples.push(`${row.ahj} (${row.state}): structural=${row.structural || "?"} electrical=${row.electrical || "?"}`);
    if (opts.dryRun) { summary.imported++; continue; }

    // KB note segment FIRST — its verified check is the veto for BOTH lanes. Where
    // the operator has recorded a human-verified ruling (Salem: no stamp on
    // prescriptive, stamp on engineered), the workbook's flat Yes must not land
    // ANYWHERE — a reviewer-visible "Structural stamp required: Yes" amendment
    // would silently contradict the ruling the KB just protected.
    const noteBits = [`Stamps (operator reference): structural ${row.structural || "unknown"}, electrical ${row.electrical || "unknown"}`];
    if (row.notes) noteBits.push(`Stamp notes: ${row.notes.slice(0, 200)}`);
    const outcome = importSeededAhjKnowledge(db, {
      state: row.state,
      ahj: row.ahj,
      notes: noteBits.join(" | "),
      sourceLabel: `Operator stamp-requirements list (${sheet.name})`,
    });
    if (outcome === "skipped_verified") { summary.skippedVerified++; continue; }

    // Codes profile: Yes flags + the note, merged onto any seeded profile.
    let landedProfile = false;
    let refusedVerified = false;
    const amendments: JurisdictionCodeAmendment[] = [];
    if (row.structural === "yes") amendments.push({ code: "AHJ", summary: "Structural stamp required: Yes" });
    if (row.electrical === "yes") amendments.push({ code: "AHJ", summary: "Electrical stamp required: Yes" });
    if (row.notes) amendments.push({ code: "AHJ", summary: `Stamp notes: ${row.notes.slice(0, 200)}` });
    if (amendments.length) {
      // THE EXACT ROW, NOT THE LAYERED VIEW. getCodeProfile folds the STATE default
      // under every lookup — Oregon's state row is verified, so a layered read would
      // refuse every new OR jurisdiction and, worse, copy state amendments onto the
      // new AHJ row. Import decisions are about the AHJ's own row only.
      const key = codeProfileKey({ state: row.state, ahj: row.ahj });
      const existing = listCodeProfiles(db).find((p) => p.key === key) ?? null;
      if (existing && existing.confidence === "verified") {
        refusedVerified = true;
      } else {
        const have = new Set((existing?.amendments ?? []).map((a) => a.summary));
        saveResearchedCodeProfile(db, {
          key,
          state: row.state,
          ahj: row.ahj,
          confidence: "seeded",
          adoptedCodes: existing?.adoptedCodes ?? [],
          amendments: [...(existing?.amendments ?? []), ...amendments.filter((a) => !have.has(a.summary))],
          designCriteria: existing?.designCriteria ?? {},
          prescriptive: existing?.prescriptive ?? {},
          fireSetbacks: existing?.fireSetbacks ?? [],
          citations: [...(existing?.citations ?? []), { label: `Operator stamp-requirements list (${sheet.name})`, sourceUrl: "" }],
          updatedAt: new Date(0).toISOString(),
        });
        landedProfile = true;
      }
    }

    // ONE verdict per ROW: landed anywhere → imported; refused only for verified →
    // skippedVerified; nothing anywhere (junk name AND no landing) → skippedEmpty.
    if (landedProfile || outcome === "imported") summary.imported++;
    else if (refusedVerified) summary.skippedVerified++;
    else summary.skippedEmpty++;
  }
  return summary;
}

// ---- workbook dispatch ----------------------------------------------------

/** Auto-detect a workbook's dataset by sheet names and import every matching sheet. */
export function importReferenceWorkbook(db: AppDb, buffer: Buffer, opts: { dryRun?: boolean } = {}): ImportSummary[] {
  const sheets = readXlsx(buffer);
  const out: ImportSummary[] = [];
  for (const sheet of sheets) {
    if (!sheet.rows.length) continue;
    const n = sheet.name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const hasCol = (...names: string[]) => names.some((x) => sheet.headers.some((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, "").startsWith(x.replace(/[^a-z0-9]+/g, ""))));

    // Precedence is by unambiguous sheet name first, then column heuristics.
    // Jurisdiction-codes and utility-list sheets both can carry IFC/IRC/IBC columns,
    // so the sheet name disambiguates them.
    if (/^stampsummary$/.test(n) || (hasCol("ahjengineeringstamprequirements") && sheet.rows.length > 3)) {
      out.push(importStampSummarySheet(db, sheet, opts));
    } else if (/utilitycompanylist|^utilities$/.test(n)) {
      out.push(importUtilityNemSheet(db, sheet, opts));
    } else if (/jurisdiction|authorityhaving|^codes$/.test(n)) {
      out.push(importAhjCodesSheet(db, sheet, opts));
    } else if (hasCol("utilitycontact") || hasCol("requiresgreentag") || hasCol("instructionstosubmit")) {
      out.push(importUtilityNemSheet(db, sheet, opts));
    } else if (hasCol("nec") && (hasCol("setbacks") || hasCol("asce"))) {
      out.push(importAhjCodesSheet(db, sheet, opts));
    } else if (hasCol("municipality") || hasCol("permittingemails") || hasCol("permitsearchwebsite")) {
      out.push(importAhjProcessSheet(db, sheet, opts));
    }
  }
  if (!out.length) logger.warn("reference-import", `No recognized dataset in workbook (sheets: ${sheets.map((s) => s.name).join(", ")})`);
  return out;
}
