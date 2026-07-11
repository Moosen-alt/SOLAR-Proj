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
import { codeProfileKey, getCodeProfile, saveResearchedCodeProfile } from "./codeProfiles";
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
  out.push({ code: parsed.family || family, edition: parsed.edition, notes: "Imported from operator reference list — verify against the AHJ." });
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

    const key = codeProfileKey({ state, ahj });
    const existing = getCodeProfile(db, { state, ahj });
    if (existing && existing.confidence === "verified") { summary.skippedVerified++; continue; }

    if (summary.samples.length < 5) summary.samples.push(`${ahj} (${state}): ${adoptedCodes.map((c) => `${c.code} ${c.edition}`).join(", ") || "flags only"}`);
    if (opts.dryRun) { summary.imported++; continue; }

    // Merge onto any existing seeded profile so a second sheet (NEC after Polaris)
    // adds rather than replaces; a human-verified row was already skipped above.
    const merged: JurisdictionCodeProfile = {
      key,
      state,
      ahj,
      confidence: "seeded",
      adoptedCodes: dedupeCodes([...(existing?.adoptedCodes ?? []), ...adoptedCodes]),
      amendments: [...(existing?.amendments ?? []), ...amendments],
      designCriteria: { ...(existing?.designCriteria ?? {}), ...designCriteria },
      prescriptive: existing?.prescriptive ?? {},
      fireSetbacks: existing?.fireSetbacks?.length ? existing.fireSetbacks : fireSetbacks,
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
    if (/utilitycompanylist|^utilities$/.test(n)) {
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
