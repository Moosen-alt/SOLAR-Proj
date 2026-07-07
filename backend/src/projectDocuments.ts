import fs from "node:fs";
import path from "node:path";
import type { AppDb } from "./db";
import { HttpError } from "./httpError";
import { id } from "./ids";
import { nowIso } from "./time";
import { text as s } from "./json";
import { extractPdfText } from "./batchImport";

type Row = Record<string, unknown>;

// Doc types whose text is design/plan evidence for the reviewer gate.
const PLAN_TEXT_DOC_TYPES = new Set(["plan_set", "sld", "site_plan", "structural", "electrical", "inverter_spec", "module_spec", "labels"]);
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

const DOCS_DIR = path.resolve(process.cwd(), process.env.PROJECT_DOCS_DIR || "backend/data/project-documents");

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
  if (/pdf/i.test(s(input.contentType)) || /\.pdf$/i.test(input.filename)) {
    void extractDocumentText(db, docId, stored);
  }
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
  return out;
}
