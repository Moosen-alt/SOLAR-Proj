import fs from "node:fs";
import path from "node:path";
import type { AppDb } from "./db";
import { HttpError } from "./httpError";
import { id } from "./ids";
import { nowIso } from "./time";
import { text as s } from "./json";
import { extractPdfText } from "./batchImport";
import { sniffFileKind, looksLikeCad, isImageKind, describeKind, type SniffedKind } from "./fileTypes";

type Row = Record<string, unknown>;

// Doc types whose text is design/plan evidence for the reviewer gate.
const PLAN_TEXT_DOC_TYPES = new Set(["plan_set", "sld", "site_plan", "structural", "structural_letter", "stamped_plans", "engineering_letter", "electrical", "inverter_spec", "module_spec", "labels"]);
const MAX_PLAN_TEXT_CHARS = 150_000;

function isPdfDoc(row: Row): boolean {
  return /pdf/i.test(s(row.content_type)) || /\.pdf$/i.test(s(row.stored_path)) || /\.pdf$/i.test(s(row.original_filename));
}

// Extract + store PDF text for one document row. Fire-and-forget from upload and
// from the lazy backfill — a failed extraction stores a marker so we don't retry
// the same broken file on every project view.
async function extractDocumentText(db: AppDb, docId: string, storedPath: string): Promise<void> {
  let extracted = "";
  try {
    extracted = (await extractPdfText(storedPath, 40)).slice(0, MAX_PLAN_TEXT_CHARS);
  } catch { /* fall through to marker */ }
  db.run("UPDATE project_documents SET extracted_text = ? WHERE id = ?", [extracted || "[no text layer]", docId]);
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
  "permit_application", "building_application", "electrical_application", "solar_checklist",
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
  const row = db.get<Row>("SELECT stored_path FROM project_documents WHERE id = ? AND project_id = ?", [docId, projectId]);
  if (!row) throw new HttpError(404, "Document not found.");
  const stored = s(row.stored_path);
  if (stored && fs.existsSync(stored)) { try { fs.unlinkSync(stored); } catch { /* ignore */ } }
  db.run("DELETE FROM project_documents WHERE id = ?", [docId]);
  return { deleted: true };
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

const DOC_TYPE_ALIASES: Record<string, string[]> = {
  structural_letter: ["stamped_plans", "engineering_letter"],
  plan_set: ["combined_plan_set", "full_plan_set", "plan", "plan_pdf"],
};
