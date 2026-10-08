import fs from "node:fs";
import path from "node:path";
import type { AppDb } from "./db";
import { HttpError } from "./httpError";
import { addAuditLog } from "./audit";
import { id } from "./ids";
import { nowIso } from "./time";
import { text as s } from "./json";
import { extractPdfText } from "./batchImport";
import { parseFeeSummary, recordFeeSummary } from "./feeSummary";
import { parsePaidFeeReceipt, recordPaidFeeReceipt } from "./feeReceipts";
import { logger } from "./logger";
import { sniffFileKind, looksLikeCad, isImageKind, describeKind, type SniffedKind } from "./fileTypes";

type Row = Record<string, unknown>;

// Doc types whose text is design/plan evidence for the reviewer gate.
export const PLAN_TEXT_DOC_TYPES = new Set(["plan_set", "sld", "site_plan", "structural", "structural_letter", "stamped_plans", "engineering_letter", "electrical", "inverter_spec", "module_spec", "labels", "ground_footing", "trench_detail"]);
const MAX_PLAN_TEXT_CHARS = 150_000;

function isPdfDoc(row: Row): boolean {
  return /pdf/i.test(s(row.content_type)) || /\.pdf$/i.test(s(row.stored_path)) || /\.pdf$/i.test(s(row.original_filename));
}

// Extract + store PDF text for one document row. Fire-and-forget from upload and
// from the lazy backfill — a failed extraction stores a marker so we don't retry
// the same broken file on every project view.
// Documents whose text extraction is ALREADY running. planSetTextForProject is called on
// every getProjectDetail (i.e. every project view, every reviewer-gate build), and it used
// to fire a fresh fire-and-forget extraction each time a document had no stored text yet —
// so ten views of one project meant ten concurrent parses of the same multi-megabyte plan
// set, each racing to write the same row. One in-flight extraction per document.
const extractionsInFlight = new Set<string>();

async function extractDocumentText(db: AppDb, docId: string, storedPath: string): Promise<void> {
  if (extractionsInFlight.has(docId)) return;
  extractionsInFlight.add(docId);
  let extracted = "";
  try {
    extracted = (await extractPdfText(storedPath, 40)).slice(0, MAX_PLAN_TEXT_CHARS);
  } catch { /* fall through to marker */ } finally {
    extractionsInFlight.delete(docId);
  }
  db.run("UPDATE project_documents SET extracted_text = ? WHERE id = ?", [extracted || "[no text layer]", docId]);
  if (extracted) recordFeeSummaryIfPresent(db, docId, extracted);
  if (extracted && /PHOTOVOLTAIC WORKSHEET/i.test(extracted) && /PV SYSTEM OVERVIEW/i.test(extracted)) await recordFiledWorksheetReading(db, docId, storedPath);
}

/** A filed Iowa SFM PV worksheet, read by position, for the gate (pvWorksheetGate). Only the
 *  2020 edition's layout is read; anything else stores nothing. */
async function recordFiledWorksheetReading(db: AppDb, docId: string, storedPath: string): Promise<void> {
  try {
    const { readFiledPvWorksheet } = await import("./pvWorksheetGate");
    const reading = await readFiledPvWorksheet(new Uint8Array(fs.readFileSync(storedPath)));
    if (reading) db.run("UPDATE project_documents SET form_reading_json = ? WHERE id = ?", [JSON.stringify(reading), docId]);
  } catch { /* best effort: no reading, no worksheet findings */ }
}

// THE AUTHORITY ALREADY DID THE ARITHMETIC; READ IT WHILE THE TEXT IS IN HAND.
//
// The quote ladder's top two rungs are `actual` and `learned_history`, and both were EMPTY —
// permit_fee_history had 0 rows — so every quote fell to a published schedule or 1.5% of
// valuation. Meanwhile Portland issues a "Billing Summary" PDF per permit, those PDFs were
// already being attached and text-extracted, and the total was sitting unread in a column.
// Measured on a real one: $1,175.83 across 8 fee lines, where our schedule knows only the
// $283.00 electrical line — 24% of the bill.
//
// Runs HERE rather than at upload because this is the one place the text exists and is fresh,
// and it covers documents attached before the reader did. Everything it does is idempotent by
// permit number (see recordFeeSummary), which matters because extraction re-fires for any
// document whose text is missing.
//
// Never throws: a document is not worth less because a bill inside it was unreadable.
function recordFeeSummaryIfPresent(db: AppDb, docId: string, extracted: string): void {
  try {
    const receipt = parsePaidFeeReceipt(extracted);
    if (receipt) {
      const doc = db.get<{ project_id: string }>("SELECT project_id FROM project_documents WHERE id = ?", [docId]);
      if (doc) recordPaidFeeReceipt(db, receipt, doc.project_id);
      return;
    }
    const summary = parseFeeSummary(extracted);
    if (!summary || summary.totalUsd == null) return;
    const row = db.get<Row>(
      `SELECT p.id AS id, p.state AS state, p.ahj AS ahj, p.utility AS utility
         FROM project_documents d JOIN projects p ON p.id = d.project_id WHERE d.id = ?`,
      [docId],
    );
    if (!row?.id) return;
    const outcome = recordFeeSummary(db, {
      id: s(row.id), state: s(row.state), ahj: s(row.ahj), utility: s(row.utility),
    } as never, summary);
    if (outcome.recorded) {
      logger.info("documents", "a fee summary was attached, so the real permit fee is now on file", {
        projectId: s(row.id), permitNumber: summary.permitNumber, totalForPermitUsd: outcome.totalForPermitUsd,
      });
    }
  } catch (err) {
    logger.warn("documents", "could not read a fee summary out of a document", {
      docId, err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Concatenated extracted text of the project's plan-set-family documents (latest per
 * doc_type). Used by the reviewer gate so evidence checks see the actual plan sheets.
 * Kicks off a background extraction for any PDF that hasn't been extracted yet, so
 * the text is available on the next report build.
 */
export function planSetTextForProject(db: AppDb, projectId: string): string {
  const rows = db.query<Row>(
    "SELECT id, doc_type, stored_path, content_type, original_filename, extracted_text FROM project_documents WHERE project_id = ? ORDER BY uploaded_at DESC",
    [projectId],
  );
  const parts: string[] = [];
  const seenTypes = new Set<string>();
  for (const row of rows) {
    const docType = s(row.doc_type);
    if (!PLAN_TEXT_DOC_TYPES.has(docType) || seenTypes.has(docType)) continue;
    seenTypes.add(docType);
    const extracted = s(row.extracted_text);
    if (extracted && extracted !== "[no text layer]") {
      parts.push(extracted);
    } else if (!extracted && isPdfDoc(row) && fs.existsSync(s(row.stored_path))) {
      void extractDocumentText(db, s(row.id), s(row.stored_path));
    }
  }
  return parts.join("\n").slice(0, MAX_PLAN_TEXT_CHARS);
}

// Uploaded files live OUTSIDE the SQLite database, so anything that backs the system
// up has to know where they are. Exported for backup.ts — the two must never drift.
export const DOCS_DIR = path.resolve(process.cwd(), process.env.PROJECT_DOCS_DIR || "backend/data/project-documents");

export interface ProjectDocumentView {
  id: string;
  projectId: string;
  docType: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  source: string;
  uploadedBy: string;
  uploadedAt: string;
}

function mapDoc(row: Row): ProjectDocumentView {
  return {
    id: s(row.id),
    projectId: s(row.project_id),
    docType: s(row.doc_type),
    originalFilename: s(row.original_filename),
    contentType: s(row.content_type),
    sizeBytes: Number(row.size_bytes ?? 0),
    source: s(row.source),
    uploadedBy: s(row.uploaded_by),
    uploadedAt: s(row.uploaded_at),
  };
}

// Keep a stored filename safe and unique on disk.
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "file";
}

// Slots whose contents we later PARSE (split into sheets, extract text, hand to a
// portal file input). Anything that isn't a real PDF in one of these is not a
// degraded upload — it is an upload that cannot work, and every downstream step
// will fail confusingly instead of here.
const PDF_REQUIRED_DOC_TYPES = new Set([
  "plan_set", "plan", "plan_pdf", "combined_plan_set", "full_plan_set",
  "sld", "site_plan", "structural", "structural_letter", "stamped_plans",
  "engineering_letter", "electrical", "module_spec", "inverter_spec", "labels",
  "permit_application", "building_application", "electrical_application", "solar_checklist", "pv_worksheet",
  "ground_footing", "trench_detail", "zoning_approval",
]);

// Slots that hold a photo or a scan. A PDF is fine here too — people scan the meter
// tag and the utility bill to PDF constantly.
const IMAGE_OR_PDF_DOC_TYPES = new Set(["meter_photo", "site_photo", "roof_photo", "utility_bill", "photo"]);

// Where a native CAD file is allowed to live: as reference material an operator can
// download, never as something the pipeline will try to read.
export const CAD_REFERENCE_DOC_TYPE = "cad_source";

/**
 * Reject an upload that cannot serve the slot it was given, with a message that says
 * what to do about it. Returns the sniffed kind so the caller can record it.
 */
function assertUploadUsable(docType: string, filename: string, buffer: Buffer): SniffedKind {
  const kind = sniffFileKind(buffer);
  const isCad = looksLikeCad(filename, kind);

  if (isCad && docType !== CAD_REFERENCE_DOC_TYPE) {
    throw new HttpError(
      415,
      `"${filename}" is a CAD drawing, not a submittable document. AHJ and utility portals only accept PDFs, ` +
        `and we cannot read sheets, sizes, or structural data out of a CAD file. Export the plan set to PDF and ` +
        `upload that. To keep the source drawing on the project for reference, upload it with document type "${CAD_REFERENCE_DOC_TYPE}".`,
    );
  }

  if (PDF_REQUIRED_DOC_TYPES.has(docType) && kind !== "pdf") {
    const what = describeKind(kind, filename);
    const extra = isImageKind(kind)
      ? " Scans and photos of plan sheets can't be split or read — print or export to PDF instead."
      : "";
    throw new HttpError(415, `"${filename}" is ${what}, but the "${docType}" slot needs a PDF.${extra}`);
  }

  if (IMAGE_OR_PDF_DOC_TYPES.has(docType) && kind !== "pdf" && !isImageKind(kind)) {
    throw new HttpError(415, `"${filename}" is ${describeKind(kind, filename)}, but the "${docType}" slot needs a photo or a PDF.`);
  }

  return kind;
}

export function listProjectDocuments(db: AppDb, projectId: string): ProjectDocumentView[] {
  return db
    .query<Row>("SELECT * FROM project_documents WHERE project_id = ? ORDER BY uploaded_at DESC", [projectId])
    .map(mapDoc);
}

/**
 * Wrap a photo in a single-page PDF.
 *
 * The meter photo arrives from the field as a JPEG, but portals that accept "documents"
 * commonly reject a bare image — the upload control wants a PDF like every other
 * attachment. Fitted to Letter (orientation chosen by the photo's own aspect) rather than
 * left at native pixel size, so a 2048x1536 phone photo does not become a 28-inch page.
 */
export async function imageToSinglePagePdf(buffer: Buffer, contentType: string): Promise<Buffer> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const img = /png/i.test(contentType) ? await doc.embedPng(buffer) : await doc.embedJpg(buffer);
  const landscape = img.width >= img.height;
  const pageW = landscape ? 792 : 612;
  const pageH = landscape ? 612 : 792;
  const scale = Math.min(pageW / img.width, pageH / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const page = doc.addPage([pageW, pageH]);
  page.drawImage(img, { x: (pageW - w) / 2, y: (pageH - h) / 2, width: w, height: h });
  return Buffer.from(await doc.save());
}

export function saveProjectDocument(
  db: AppDb,
  projectId: string,
  input: { docType?: string; filename: string; contentType?: string; buffer: Buffer; source?: string; uploadedBy?: string },
): ProjectDocumentView {
  const project = db.get<Row>("SELECT id FROM projects WHERE id = ?", [projectId]);
  if (!project) throw new HttpError(404, "Project not found.");
  if (!input.buffer || input.buffer.length === 0) throw new HttpError(400, "Empty file.");
  const kind = assertUploadUsable(s(input.docType), input.filename, input.buffer);
  const docId = id();
  const dir = path.join(DOCS_DIR, projectId);
  fs.mkdirSync(dir, { recursive: true });
  const stored = path.join(dir, `${docId}-${safeName(input.filename)}`);
  fs.writeFileSync(stored, input.buffer);
  db.run(
    `INSERT INTO project_documents
      (id, project_id, doc_type, original_filename, stored_path, content_type, size_bytes, source, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [docId, projectId, s(input.docType), s(input.filename), stored, s(input.contentType), input.buffer.length, input.source || "upload", s(input.uploadedBy), nowIso()],
  );
  // Extract PDF text in the background so the reviewer gate can check the actual sheets.
  // Keyed off the sniffed bytes, not the filename — a plan set saved as "plans" with no
  // extension is still a PDF we can read.
  if (kind === "pdf") void extractDocumentText(db, docId, stored);
  return mapDoc(db.get<Row>("SELECT * FROM project_documents WHERE id = ?", [docId])!);
}

export function getProjectDocumentFile(db: AppDb, projectId: string, docId: string): { path: string; filename: string; contentType: string } {
  const row = db.get<Row>("SELECT * FROM project_documents WHERE id = ? AND project_id = ?", [docId, projectId]);
  if (!row) throw new HttpError(404, "Document not found.");
  const stored = s(row.stored_path);
  if (!stored || !fs.existsSync(stored)) throw new HttpError(404, "Document file is missing on disk.");
  return { path: stored, filename: s(row.original_filename) || "document", contentType: s(row.content_type) || "application/octet-stream" };
}

export function deleteProjectDocument(db: AppDb, projectId: string, docId: string): { deleted: boolean } {
  const row = db.get<Row>("SELECT stored_path, doc_type FROM project_documents WHERE id = ? AND project_id = ?", [docId, projectId]);
  if (!row) throw new HttpError(404, "Document not found.");
  const stored = s(row.stored_path);
  if (stored && fs.existsSync(stored)) { try { fs.unlinkSync(stored); } catch { /* ignore */ } }
  db.run("DELETE FROM project_documents WHERE id = ?", [docId]);
  // A removal is a document change too (documentsChangedAt) — and a deleted row leaves no
  // timestamp of its own behind, so the fact is written where the audit trail keeps facts. The
  // doc type only: a filename can carry a homeowner's name.
  addAuditLog(db, projectId, "system", "documents", DOCUMENT_DELETED_ACTION, { docType: s(row.doc_type) });
  return { deleted: true };
}

const DOCUMENT_DELETED_ACTION = "project.document_deleted";

/**
 * WITHDRAW A PART THE SPLITTER WROTE (#77) — the splitter taking back its own cut, not a person's
 * ruling. Refuses anything but a `source = 'split'` row: a document a person uploaded is never
 * removed here. Recorded under its OWN audit action so documentTypesDeletedSince (a PERSON's
 * deletion, which forbids a re-cut) does not read it, while documentsChangedAt still does — a
 * verdict that counted the withdrawn part is stale.
 */
export function withdrawSplitPart(db: AppDb, projectId: string, docId: string): boolean {
  const row = db.get<Row>("SELECT stored_path, doc_type, source FROM project_documents WHERE id = ? AND project_id = ?", [docId, projectId]);
  if (!row || s(row.source) !== "split") return false;
  const stored = s(row.stored_path);
  if (stored && fs.existsSync(stored)) { try { fs.unlinkSync(stored); } catch { /* ignore */ } }
  db.run("DELETE FROM project_documents WHERE id = ? AND source = 'split'", [docId]);
  addAuditLog(db, projectId, "system", "documents", SPLIT_PART_WITHDRAWN_ACTION, { docType: s(row.doc_type) });
  return true;
}

const SPLIT_PART_WITHDRAWN_ACTION = "project.split_part_withdrawn";

/**
 * WHEN THIS PROJECT'S DOCUMENTS LAST CHANGED — the newest upload/split/generated row, or the
 * newest removal (a person's deletion, or the splitter withdrawing a stale part), whichever is
 * later (null when nothing was ever on file). THE one answer to "has the document set changed since X?": a verdict computed FROM the documents (QC's
 * "Required document … not attached … Staging will refuse without it" rows, the bill-on-file
 * wait) is stale once this is newer than the verdict, and is re-judged (autoStageSteps STEP 1).
 */
export function documentsChangedAt(db: AppDb, projectId: string): string | null {
  const uploaded = s(db.get<Row>("SELECT MAX(uploaded_at) AS t FROM project_documents WHERE project_id = ?", [projectId])?.t);
  const removed = s(db.get<Row>(
    "SELECT MAX(created_at) AS t FROM audit_logs WHERE project_id = ? AND action IN (?, ?)",
    [projectId, DOCUMENT_DELETED_ACTION, SPLIT_PART_WITHDRAWN_ACTION])?.t);
  const newest = uploaded > removed ? uploaded : removed;
  return newest || null;
}

/** Doc types a person deleted from this project at or after `since` (the audit facts above). */
export function documentTypesDeletedSince(db: AppDb, projectId: string, since: string): Set<string> {
  const out = new Set<string>();
  for (const row of db.query<Row>(
    "SELECT details FROM audit_logs WHERE project_id = ? AND action = ? AND created_at >= ?",
    [projectId, DOCUMENT_DELETED_ACTION, since],
  )) {
    try { const t = s(JSON.parse(s(row.details)).docType); if (t) out.add(t); } catch { /* unreadable fact: skip */ }
  }
  return out;
}

// docType -> stored file path map for a project (latest per type), for the submittal
// package and the portal bot to attach the right files.
export function projectDocsByType(db: AppDb, projectId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of db.query<Row>("SELECT doc_type, stored_path FROM project_documents WHERE project_id = ? ORDER BY uploaded_at DESC", [projectId])) {
    const t = s(row.doc_type);
    const p = s(row.stored_path);
    if (t && p && !out[t] && fs.existsSync(p)) out[t] = p;
  }
  // The same physical document arrives under several names depending on which upload
  // path produced it (the parser's structural-letter slot, a batch import that called it
  // stamped plans, an operator picking "engineering letter"). Everything downstream —
  // the submittal package and the portal bot's upload-slot matcher — asks for the
  // canonical type, so fill it in from an alias rather than making each consumer guess.
  for (const [canonical, aliases] of Object.entries(DOC_TYPE_ALIASES)) {
    if (out[canonical]) continue;
    const hit = aliases.find((a) => out[a]);
    if (hit) out[canonical] = out[hit];
  }
  return out;
}

export const DOC_TYPE_ALIASES: Record<string, string[]> = {
  structural_letter: ["stamped_plans", "engineering_letter"],
  plan_set: ["combined_plan_set", "full_plan_set", "plan", "plan_pdf"],
};
