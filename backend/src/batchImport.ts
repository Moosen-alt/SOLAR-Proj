import fs from "node:fs";
import path from "node:path";
import type { AppDb, SqlParam } from "./db";
import { createLLMProvider } from "./llm";

type Row = Record<string, SqlParam>;

// ---------------------------------------------------------------------------
// PDF text extraction (server-side via pdfjs-dist)
// ---------------------------------------------------------------------------

type PdfjsModule = {
  getDocument: (opts: { data: Uint8Array; useSystemFonts?: boolean; disableWorker?: boolean }) => { promise: Promise<PdfjsDoc> };
  GlobalWorkerOptions: { workerSrc: string };
};
type PdfjsDoc = { numPages: number; getPage: (n: number) => Promise<PdfjsPage> };
type PdfjsPage = { getTextContent: () => Promise<{ items: Array<{ str: string }> }> };

let _pdfjs: PdfjsModule | null = null;
async function getPdfjs(): Promise<PdfjsModule> {
  if (!_pdfjs) {
    const mod = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    // In Node.js we run the worker in-process — point workerSrc at the worker
    // file so pdfjs doesn't complain, then rely on disableWorker in getDocument.
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const workerPath = req.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
    mod.GlobalWorkerOptions.workerSrc = `file://${workerPath}`;
    _pdfjs = mod as unknown as PdfjsModule;
  }
  return _pdfjs;
}

export async function extractPdfText(filePath: string, maxPages = 30): Promise<string> {
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, disableWorker: true }).promise;
  const pages = Math.min(doc.numPages, maxPages);
  const parts: string[] = [];
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map((item) => item.str).join(" "));
  }
  return parts.join("\n").replace(/\s{3,}/g, "  ").trim();
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

export type DocType = "permit_application" | "sld" | "issued_permit" | "utility_bill" | "correction" | "unknown";

const FILE_PATTERNS: Array<{ pattern: RegExp; type: DocType }> = [
  { pattern: /sld|single[_\s-]?line|one[_\s-]?line|diagram|riser/i, type: "sld" },
  { pattern: /utility[_\s-]?bill|ub[_\s-]?\d|electric[_\s-]?bill|pge[_\s-]?bill|pac[_\s-]?bill|meter[_\s-]?read|statement/i, type: "utility_bill" },
  { pattern: /correction|plan[_\s-]?check|deficiency|revision[_\s-]?comment|noncompliance/i, type: "correction" },
  { pattern: /issued[_\s-]?permit|permit[_\s-]?card|final[_\s-]?permit|approved[_\s-]?permit/i, type: "issued_permit" },
  { pattern: /permit[_\s-]?app|application|app[_\s-]?\d|building[_\s-]?permit|solar[_\s-]?app|pv[_\s-]?app|nem[_\s-]?app|interconnect/i, type: "permit_application" },
];

const TEXT_SIGNALS: Array<{ pattern: RegExp; type: DocType; weight: number }> = [
  { pattern: /single[- ]line diagram|one[- ]line diagram|SLD/i, type: "sld", weight: 3 },
  { pattern: /AC\s*disconnect|DC\s*disconnect|rapid shutdown|main\s*service\s*panel|MSP|PV\s*system\s*output|inverter\s*model|module\s*model/i, type: "sld", weight: 2 },
  { pattern: /account\s*number|account\s*no|billing\s*period|kilowatt[\s-]?hour|kWh\s*used|meter\s*number|net\s*energy\s*metering|NEM\s*rate|E-NET|E-TOU/i, type: "utility_bill", weight: 3 },
  { pattern: /electric\s*service\s*provider|your\s*bill|amount\s*due|previous\s*balance|current\s*charges/i, type: "utility_bill", weight: 2 },
  { pattern: /permit\s*is\s*hereby\s*issued|approved\s*by\s*building|permit\s*number|inspection\s*card|certificate\s*of\s*occupancy/i, type: "issued_permit", weight: 3 },
  { pattern: /plan\s*check\s*correction|correction\s*list|deficiency\s*list|items?\s*requiring\s*correction|resubmit/i, type: "correction", weight: 3 },
  { pattern: /applicant|homeowner|property\s*owner|installation\s*address|system\s*description|solar\s*photovoltaic|PV\s*system/i, type: "permit_application", weight: 2 },
];

export function classifyDoc(filename: string, text: string): DocType {
  const scores: Record<DocType, number> = {
    permit_application: 0, sld: 0, issued_permit: 0, utility_bill: 0, correction: 0, unknown: 0,
  };

  for (const { pattern, type } of FILE_PATTERNS) {
    if (pattern.test(path.basename(filename, path.extname(filename)))) scores[type] += 3;
  }
  const sample = text.slice(0, 4000);
  for (const { pattern, type, weight } of TEXT_SIGNALS) {
    if (pattern.test(sample)) scores[type] += weight;
  }

  const best = (Object.entries(scores) as [DocType, number][])
    .filter(([t]) => t !== "unknown")
    .sort(([, a], [, b]) => b - a)[0];
  return best && best[1] > 0 ? best[0] : "unknown";
}

// ---------------------------------------------------------------------------
// Field extractors
// ---------------------------------------------------------------------------

interface PermitAppFields {
  homeownerName?: string;
  projectAddress?: string;
  city?: string;
  state?: string;
  zip?: string;
  ahj?: string;
  utility?: string;
  systemSizeDcKw?: number;
  systemSizeAcKw?: number;
  interconnectionMethod?: string;
  hasBattery?: boolean;
}

interface SldFields {
  systemSizeDcKw?: number;
  systemSizeAcKw?: number;
  moduleModel?: string;
  moduleCount?: number;
  inverterModel?: string;
  hasBattery?: boolean;
  interconnectionMethod?: string;
  rapidShutdown?: boolean;
}

interface UtilityBillFields {
  meterNumber?: string;          // stored — needed for NEM
  serviceAddress?: string;
  utilityName?: string;
  rateSchedule?: string;
  avgMonthlyKwh?: number;
  // account number intentionally NOT extracted — PII, not needed by platform
}

interface IssuedPermitFields {
  permitNumber?: string;
  issuedDate?: string;
  ahj?: string;
  expirationDate?: string;
}

interface CorrectionFields {
  correctionItems?: string[];
  ahj?: string;
  applicationNumber?: string;
}

async function llmExtract<T>(text: string, prompt: string): Promise<Partial<T>> {
  try {
    const llm = createLLMProvider();
    const result = await llm.extractFields({ text: text.slice(0, 6000), instruction: prompt });
    return result as Partial<T>;
  } catch {
    return {};
  }
}

// Regex fast-path extractors (no LLM cost for clear signals)
function quickExtractPermitApp(text: string): Partial<PermitAppFields> {
  const fields: Partial<PermitAppFields> = {};
  const dcMatch = text.match(/(?:dc\s*(?:system)?\s*size|total\s*dc\s*watts?|dc\s*capacity)[:\s]+([0-9.]+)\s*(kw|watts?)/i);
  if (dcMatch) fields.systemSizeDcKw = Number(dcMatch[1]) * (dcMatch[2].toLowerCase().startsWith("w") ? 0.001 : 1);
  const acMatch = text.match(/(?:ac\s*(?:system)?\s*size|ac\s*capacity|ac\s*output)[:\s]+([0-9.]+)\s*(kw|watts?)/i);
  if (acMatch) fields.systemSizeAcKw = Number(acMatch[1]) * (acMatch[2].toLowerCase().startsWith("w") ? 0.001 : 1);
  if (/battery|energy\s*storage|ess|bess/i.test(text)) fields.hasBattery = true;
  const methMatch = text.match(/(?:interconnection\s*method|interconnect\s*type|point\s*of\s*interconnect)[:\s]+(load[- ]side|line[- ]side|supply[- ]side)/i);
  if (methMatch) fields.interconnectionMethod = methMatch[1].toLowerCase().replace(/\s/g, "-");
  return fields;
}

function quickExtractSld(text: string): Partial<SldFields> {
  const fields: Partial<SldFields> = {};
  const dcMatch = text.match(/(?:total\s*dc|pv\s*system\s*output|dc\s*power)[:\s=]+([0-9.]+)\s*(kw|w\b)/i);
  if (dcMatch) fields.systemSizeDcKw = Number(dcMatch[1]) * (dcMatch[2].toLowerCase() === "w" ? 0.001 : 1);
  const acMatch = text.match(/(?:ac\s*output|inverter\s*output|ac\s*power)[:\s=]+([0-9.]+)\s*(kw|w\b)/i);
  if (acMatch) fields.systemSizeAcKw = Number(acMatch[1]) * (acMatch[2].toLowerCase() === "w" ? 0.001 : 1);
  const countMatch = text.match(/([0-9]+)\s*(?:x\s*)?(?:modules?|panels?|pv\s*modules?)/i);
  if (countMatch) fields.moduleCount = Number(countMatch[1]);
  const invMatch = text.match(/(?:inverter|micro[\s-]?inverter)[:\s]+([A-Z][A-Za-z0-9\s\-]+?)(?:\s*,|\s*\n|\s{2,}|$)/im);
  if (invMatch) fields.inverterModel = invMatch[1].trim().slice(0, 80);
  const modMatch = text.match(/(?:module|panel)[:\s]+([A-Z][A-Za-z0-9\s\-]+?)(?:\s*,|\s*\n|\s{2,}|$)/im);
  if (modMatch) fields.moduleModel = modMatch[1].trim().slice(0, 80);
  if (/battery|storage|ess|bess/i.test(text)) fields.hasBattery = true;
  if (/rapid\s*shutdown/i.test(text)) fields.rapidShutdown = true;
  const methMatch = text.match(/(load[- ]side|line[- ]side|supply[- ]side)\s*(?:tap|connection|interconnect)/i);
  if (methMatch) fields.interconnectionMethod = methMatch[1].toLowerCase().replace(/\s/g, "-");
  return fields;
}

function quickExtractUtilityBill(text: string): Partial<UtilityBillFields> {
  const fields: Partial<UtilityBillFields> = {};
  // Meter number: typically 8-12 digit numeric string labeled clearly — store this
  const meterMatch = text.match(/meter\s*(?:number|no\.?|#)[:\s]+([0-9A-Z]{6,14})/i);
  if (meterMatch) fields.meterNumber = meterMatch[1];
  // Rate schedule
  const rateMatch = text.match(/(?:rate\s*schedule|rate\s*code|tariff)[:\s]+([A-Z0-9\-]{2,20})/i);
  if (rateMatch) fields.rateSchedule = rateMatch[1];
  // Avg monthly usage
  const kwhMatch = text.match(/(?:total\s*usage|energy\s*used|kWh\s*used|total\s*kWh)[:\s]+([0-9,]+)\s*kWh/i);
  if (kwhMatch) fields.avgMonthlyKwh = Number(kwhMatch[1].replace(/,/g, ""));
  // Utility name from common patterns
  if (/pacific\s*gas|pg&e|pge/i.test(text)) fields.utilityName = "PG&E";
  else if (/pacific\s*power|pacificorp/i.test(text)) fields.utilityName = "Pacific Power";
  else if (/portland\s*general|pge/i.test(text.slice(0, 500))) fields.utilityName = "PGE";
  else if (/southern\s*california\s*edison|sce/i.test(text)) fields.utilityName = "SCE";
  else if (/san\s*diego\s*gas|sdg&e/i.test(text)) fields.utilityName = "SDG&E";
  else if (/puget\s*sound|pse/i.test(text)) fields.utilityName = "PSE";
  return fields;
}

function quickExtractIssuedPermit(text: string): Partial<IssuedPermitFields> {
  const fields: Partial<IssuedPermitFields> = {};
  const numMatch = text.match(/permit\s*(?:number|no\.?|#)[:\s]+([A-Z0-9\-]{4,20})/i);
  if (numMatch) fields.permitNumber = numMatch[1];
  const dateMatch = text.match(/(?:issued|issue\s*date|date\s*issued)[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\w+ \d{1,2},\s*\d{4})/i);
  if (dateMatch) fields.issuedDate = dateMatch[1];
  const expMatch = text.match(/(?:expir|valid\s*through|valid\s*until)[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\w+ \d{1,2},\s*\d{4})/i);
  if (expMatch) fields.expirationDate = expMatch[1];
  return fields;
}

function quickExtractCorrections(text: string): Partial<CorrectionFields> {
  const appMatch = text.match(/(?:application|app|record|permit)\s*(?:number|no\.?|#)[:\s]+([A-Z0-9\-]{4,20})/i);
  const lines = text.split(/\n/);
  // Numbered correction items
  const items = lines
    .filter((l) => /^\s*\d+[\.\)]\s+.{20,}/.test(l))
    .map((l) => l.replace(/^\s*\d+[\.\)]\s+/, "").trim())
    .slice(0, 20);
  return {
    applicationNumber: appMatch?.[1],
    correctionItems: items.length > 0 ? items : undefined,
  };
}

// ---------------------------------------------------------------------------
// Main folder scanner
// ---------------------------------------------------------------------------

export interface ScanResult {
  filePath: string;
  docType: DocType;
  status: "imported" | "skipped" | "error";
  message: string;
  projectId?: string;
  fields?: Record<string, unknown>;
}

export interface ScanSummary {
  scanned: number;
  imported: number;
  skipped: number;
  errors: number;
  byType: Record<DocType, number>;
  results: ScanResult[];
}

function walkPdfs(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkPdfs(full));
    else if (entry.isFile() && /\.(pdf)$/i.test(entry.name)) files.push(full);
  }
  return files;
}

// Find an existing project by address/name similarity (simple substring match)
function findProjectByAddress(db: AppDb, address: string): Row | null {
  if (!address || address.length < 6) return null;
  const normalized = address.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
  const words = normalized.split(/\s+/).filter((w) => w.length > 3);
  if (!words.length) return null;
  // Try to find by any significant word in the address
  for (const word of words.slice(0, 3)) {
    const row = db.get<Row>("SELECT * FROM projects WHERE LOWER(project_address) LIKE ?", [`%${word}%`]);
    if (row) return row;
  }
  return null;
}

export async function scanFolder(
  db: AppDb,
  folderPath: string,
  options: {
    defaultState?: string;
    defaultAhj?: string;
    defaultUtility?: string;
    useLlm?: boolean;
    onProgress?: (done: number, total: number, latest: string) => void;
  } = {},
): Promise<ScanSummary> {
  const allFiles = walkPdfs(folderPath);
  const summary: ScanSummary = {
    scanned: 0, imported: 0, skipped: 0, errors: 0,
    byType: { permit_application: 0, sld: 0, issued_permit: 0, utility_bill: 0, correction: 0, unknown: 0 },
    results: [],
  };

  for (let i = 0; i < allFiles.length; i++) {
    const filePath = allFiles[i];
    const filename = path.basename(filePath);
    options.onProgress?.(i, allFiles.length, filename);
    summary.scanned++;

    try {
      const text = await extractPdfText(filePath, 20);
      const docType = classifyDoc(filePath, text);
      summary.byType[docType]++;

      let result: ScanResult;

      if (docType === "permit_application") {
        result = await importPermitApplication(db, filePath, text, options);
      } else if (docType === "sld") {
        result = await importSld(db, filePath, text, options);
      } else if (docType === "utility_bill") {
        result = await importUtilityBill(db, filePath, text, options);
      } else if (docType === "issued_permit") {
        result = await importIssuedPermit(db, filePath, text, options);
      } else if (docType === "correction") {
        result = await importCorrectionDoc(db, filePath, text, options);
      } else {
        result = { filePath, docType, status: "skipped", message: "Could not classify document type." };
        summary.skipped++;
      }

      if (result.status === "imported") summary.imported++;
      else if (result.status === "error") summary.errors++;
      else summary.skipped++;
      summary.results.push(result);

    } catch (err) {
      summary.errors++;
      summary.results.push({ filePath, docType: "unknown", status: "error", message: String(err) });
    }
  }

  options.onProgress?.(allFiles.length, allFiles.length, "done");
  return summary;
}

// ---------------------------------------------------------------------------
// Per-type importers
// ---------------------------------------------------------------------------

async function importPermitApplication(
  db: AppDb,
  filePath: string,
  text: string,
  options: { defaultState?: string; defaultAhj?: string; defaultUtility?: string; useLlm?: boolean },
): Promise<ScanResult> {
  const quick = quickExtractPermitApp(text);

  let fields: Partial<PermitAppFields> = { ...quick };
  if (options.useLlm) {
    const llmFields = await llmExtract<PermitAppFields>(text,
      "Extract from this solar permit application: homeownerName, projectAddress (street), city, state, zip, ahj (authority having jurisdiction / city/county building dept), utility (electric utility company), systemSizeDcKw (number), systemSizeAcKw (number), interconnectionMethod ('load-side' or 'line-side'), hasBattery (true/false). Return JSON only.");
    fields = { ...llmFields, ...quick }; // quick regex wins on numeric fields
  }

  if (!fields.projectAddress && !fields.homeownerName) {
    return { filePath, docType: "permit_application", status: "skipped", message: "Could not extract address or name — may need LLM extraction (enable useLlm)." };
  }

  // Check if project already exists
  const existing = findProjectByAddress(db, fields.projectAddress || "");
  if (existing) {
    // Update specs if we got better data
    const updates: string[] = [];
    const params: (string | number | null)[] = [];
    if (fields.systemSizeDcKw && !existing.system_size_dc_kw) { updates.push("system_size_dc_kw = ?"); params.push(fields.systemSizeDcKw); }
    if (fields.systemSizeAcKw && !existing.system_size_ac_kw) { updates.push("system_size_ac_kw = ?"); params.push(fields.systemSizeAcKw); }
    if (fields.interconnectionMethod && !existing.interconnection_method) { updates.push("interconnection_method = ?"); params.push(fields.interconnectionMethod); }
    if (updates.length) {
      params.push(new Date().toISOString(), String(existing.id));
      db.run(`UPDATE projects SET ${updates.join(", ")}, updated_at = ? WHERE id = ?`, params);
    }
    return { filePath, docType: "permit_application", status: "imported", projectId: String(existing.id), message: `Merged specs into existing project ${existing.id}.`, fields: fields as Record<string, unknown> };
  }

  // Create new project record
  const projectId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO projects
      (id, homeowner_name, project_address, city, state, zip, ahj, utility,
       system_size_dc_kw, system_size_ac_kw, interconnection_method,
       status, current_stage, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'intake', 'Imported from batch scan', ?, ?)`,
    [
      projectId,
      fields.homeownerName || "Unknown",
      fields.projectAddress || "",
      fields.city || "",
      fields.state || options.defaultState || "",
      fields.zip || "",
      fields.ahj || options.defaultAhj || "",
      fields.utility || options.defaultUtility || "",
      fields.systemSizeDcKw ?? null,
      fields.systemSizeAcKw ?? null,
      fields.interconnectionMethod || "",
      now, now,
    ],
  );
  // Record the source PDF path in project notes
  db.run(
    `INSERT INTO project_notes (id, project_id, note_type, body, created_by, created_at)
     VALUES (?, ?, 'system_note', ?, 'batch_import', ?)`,
    [crypto.randomUUID(), projectId, `Imported from: ${filePath}`, now],
  );

  return { filePath, docType: "permit_application", status: "imported", projectId, message: `Created new project ${projectId}.`, fields: fields as Record<string, unknown> };
}

async function importSld(
  db: AppDb,
  filePath: string,
  text: string,
  options: { useLlm?: boolean },
): Promise<ScanResult> {
  const quick = quickExtractSld(text);
  let fields: Partial<SldFields> = { ...quick };
  if (options.useLlm) {
    const llmFields = await llmExtract<SldFields>(text,
      "Extract from this solar single-line diagram: systemSizeDcKw (number kW), systemSizeAcKw (number kW), moduleModel (string), moduleCount (integer), inverterModel (string), hasBattery (bool), interconnectionMethod ('load-side' or 'line-side'), rapidShutdown (bool). Return JSON only.");
    fields = { ...llmFields, ...quick };
  }

  if (!fields.systemSizeDcKw && !fields.inverterModel && !fields.moduleModel) {
    return { filePath, docType: "sld", status: "skipped", message: "No equipment specs extracted from SLD — may be a scanned image (OCR not available server-side)." };
  }

  // Try to match to a project by address in SLD text or filename
  const addrMatch = text.match(/(?:project|property|service|installation)\s*address[:\s]+([^\n]{10,80})/i);
  const existing = addrMatch ? findProjectByAddress(db, addrMatch[1].trim()) : null;
  const now = new Date().toISOString();

  if (existing) {
    // Update matched project specs from SLD
    const updates: string[] = [];
    const params: (string | number | null)[] = [];
    if (fields.systemSizeDcKw && !existing.system_size_dc_kw) { updates.push("system_size_dc_kw = ?"); params.push(fields.systemSizeDcKw); }
    if (fields.systemSizeAcKw && !existing.system_size_ac_kw) { updates.push("system_size_ac_kw = ?"); params.push(fields.systemSizeAcKw); }
    if (fields.interconnectionMethod && !existing.interconnection_method) { updates.push("interconnection_method = ?"); params.push(fields.interconnectionMethod); }
    if (updates.length) {
      params.push(now, String(existing.id));
      db.run(`UPDATE projects SET ${updates.join(", ")}, updated_at = ? WHERE id = ?`, params);
    }
    db.run(
      `INSERT INTO project_notes (id, project_id, note_type, body, created_by, created_at) VALUES (?, ?, 'system_note', ?, 'batch_import', ?)`,
      [crypto.randomUUID(), String(existing.id), `SLD imported: ${JSON.stringify(fields)}`, now],
    );
    return { filePath, docType: "sld", status: "imported", projectId: String(existing.id), message: `SLD specs merged into project ${existing.id}.`, fields: fields as Record<string, unknown> };
  }

  // No matching project — report extracted specs so user can match manually
  return { filePath, docType: "sld", status: "imported", message: "SLD specs extracted but no matching project found by address. Create the project first, then re-scan to link.", fields: fields as Record<string, unknown> };
}

async function importUtilityBill(
  db: AppDb,
  filePath: string,
  text: string,
  options: { defaultUtility?: string },
): Promise<ScanResult> {
  const fields = quickExtractUtilityBill(text);
  if (!fields.meterNumber && !fields.utilityName) {
    return { filePath, docType: "utility_bill", status: "skipped", message: "Could not extract meter number or utility name." };
  }

  // Try to match to an existing project by service address
  const addrMatch = text.match(/(?:service\s*address|property\s*address|installation\s*address)[:\s]+([^\n]{10,80})/i);
  const serviceAddress = addrMatch?.[1]?.trim();
  const existing = serviceAddress ? findProjectByAddress(db, serviceAddress) : null;

  if (existing && fields.meterNumber) {
    // Update meter number on the project (needed for NEM application)
    db.run("UPDATE projects SET meter_number = ?, updated_at = ? WHERE id = ? AND (meter_number IS NULL OR meter_number = '')",
      [fields.meterNumber, new Date().toISOString(), String(existing.id)]);
    if (fields.utilityName && !existing.utility) {
      db.run("UPDATE projects SET utility = ? WHERE id = ?", [fields.utilityName, String(existing.id)]);
    }
    return {
      filePath, docType: "utility_bill", status: "imported", projectId: String(existing.id),
      message: `Meter number ${fields.meterNumber} linked to project ${existing.id}. Account number intentionally not stored.`,
      fields: { meterNumber: fields.meterNumber, utilityName: fields.utilityName, rateSchedule: fields.rateSchedule, avgMonthlyKwh: fields.avgMonthlyKwh },
    };
  }

  return {
    filePath, docType: "utility_bill", status: "imported",
    message: `Extracted meter number${fields.meterNumber ? ` (${fields.meterNumber})` : " not found"}. No matching project found by address — add project first then re-scan to link.`,
    fields: { meterNumber: fields.meterNumber, utilityName: fields.utilityName, rateSchedule: fields.rateSchedule },
  };
}

async function importIssuedPermit(
  db: AppDb,
  filePath: string,
  text: string,
  _options: unknown,
): Promise<ScanResult> {
  const fields = quickExtractIssuedPermit(text);
  // Try to find project by permit number or address
  let existing: Row | null = null;
  if (fields.permitNumber) {
    // Check if permit number is already recorded on a check
    const checkRow = db.get<Row>("SELECT project_id FROM permit_status_checks WHERE permit_number = ? LIMIT 1", [fields.permitNumber]);
    if (checkRow) existing = db.get<Row>("SELECT * FROM projects WHERE id = ?", [String(checkRow.project_id)]);
  }
  if (!existing) {
    const addrMatch = text.match(/(?:project|property|installation|service)\s*address[:\s]+([^\n]{10,80})/i);
    if (addrMatch) existing = findProjectByAddress(db, addrMatch[1].trim());
  }

  if (existing && fields.issuedDate) {
    // Record an issued permit check against the project
    const now = new Date().toISOString();
    const issuedTs = fields.issuedDate ? new Date(fields.issuedDate).toISOString() : now;
    db.run(
      `INSERT INTO permit_status_checks
        (id, project_id, source, raw_status_text, status_label, outcome, confidence,
         permit_number, message, created_at)
       VALUES (?, ?, 'batch_import', ?, 'Permit issued', 'issued', 0.9, ?, ?, ?)`,
      [
        crypto.randomUUID(), String(existing.id),
        `Permit issued — imported from ${path.basename(filePath)}`,
        fields.permitNumber || "",
        `Permit ${fields.permitNumber || "(number unknown)"} issued${fields.issuedDate ? ` on ${fields.issuedDate}` : ""}.`,
        issuedTs,
      ],
    );
    db.run("UPDATE projects SET status = 'issued', updated_at = ? WHERE id = ? AND status NOT IN ('handoff_ready','nem_approved')",
      [now, String(existing.id)]);
    return { filePath, docType: "issued_permit", status: "imported", projectId: String(existing.id), message: `Permit ${fields.permitNumber || ""} recorded as issued on project ${existing.id}.`, fields: fields as Record<string, unknown> };
  }

  return { filePath, docType: "issued_permit", status: "skipped", message: `Permit ${fields.permitNumber || "(unknown)"} extracted but no matching project found. Create the project first.`, fields: fields as Record<string, unknown> };
}

async function importCorrectionDoc(
  db: AppDb,
  filePath: string,
  text: string,
  options: { defaultAhj?: string },
): Promise<ScanResult> {
  const fields = quickExtractCorrections(text);
  // Try to find project by application number
  let existing: Row | null = null;
  if (fields.applicationNumber) {
    const checkRow = db.get<Row>("SELECT project_id FROM permit_status_checks WHERE application_number = ? LIMIT 1", [fields.applicationNumber]);
    if (checkRow) existing = db.get<Row>("SELECT * FROM projects WHERE id = ?", [String(checkRow.project_id)]);
  }

  if (!existing) {
    return { filePath, docType: "correction", status: "skipped", message: "Could not match correction doc to a project. If this is a historical correction, create the project first.", fields: fields as Record<string, unknown> };
  }

  const now = new Date().toISOString();
  for (const item of fields.correctionItems || []) {
    db.run(
      `INSERT INTO corrections
        (id, project_id, correction_text, status, source, created_at)
       VALUES (?, ?, ?, 'open', 'batch_import', ?)`,
      [crypto.randomUUID(), String(existing.id), item.slice(0, 2000), now],
    );
  }

  return {
    filePath, docType: "correction", status: "imported", projectId: String(existing.id),
    message: `${fields.correctionItems?.length || 0} correction item(s) imported into project ${existing.id}.`,
    fields: { correctionCount: fields.correctionItems?.length, applicationNumber: fields.applicationNumber },
  };
}
