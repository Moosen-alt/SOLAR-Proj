import type { ProjectRecord } from "../../shared/src/types";
import type { AppDb } from "./db";
import { filledFormsByDocType, formContradictsPath } from "./ahjForms";
import { generatedDocFilesByType } from "./generatedDocFiles";
import { resolvePermitPath } from "./permitPath";
import { projectDocsByType } from "./projectDocuments";
import { createHash } from "node:crypto";
import fs from "node:fs";

/** One selection policy for learning and replay. An explicitly uploaded document
 * takes precedence over a filled form of the same type. Filled official forms are
 * filtered against the current permit path before merging (filledFormsByDocType), and
 * the generated package is read from its last render's manifest only when that render
 * was made on the current permit path (generatedDocFilesByType) — its worksheets carry
 * their own generated_* keys and never occupy an official form's key. */
export function submissionDocumentsByType(db: AppDb, project: ProjectRecord): Record<string, string> {
  // Layering is one-directional and load-bearing (operator ruling 2026-09-21, "the bot can
  // attach them all"): the GENERATED package (transfer sheet, worksheets — rendered by
  // generatedDocFiles.ts) is the floor, the jurisdiction's own FILLED official forms outrank
  // it on any shared docType, and anything a person UPLOADED by hand outranks both.
  const permitPath = resolvePermitPath(project).path;
  return {
    ...generatedDocFilesByType(project.id, permitPath),
    ...filledFormsByDocType(db, project.id, permitPath),
    ...uploadedSubmissionDocuments(db, project),
  };
}

/** Explicit wrong-path uploads cannot override a compatible generated form.
 * Generic applications remain valid; arbitrary body prose is not a title. */
// THE SAME FILE IS NEVER TWO DOCUMENTS. City of Jefferson's inverter_spec upload was byte-identical
// to its module_spec (1,051,462 bytes): an intake mis-slot the staging would have attached twice as
// two different documents. The first doc type in DUPLICATE_PRECEDENCE keeps the file; the later one
// is dropped from the upload set and reported, so the inventory can say "same file as …".
const DUPLICATE_PRECEDENCE = ["plan_set", "sld", "site_plan", "structural", "structural_letter", "stamped_plans", "module_spec", "inverter_spec",
  "racking_spec", "battery_spec", "labels", "utility_bill", "meter_photo"];
export function duplicateUploads(docs: Record<string, string>): Array<{ docType: string; sameAs: string }> {
  const rank = (t: string) => { const i = DUPLICATE_PRECEDENCE.indexOf(t); return i < 0 ? DUPLICATE_PRECEDENCE.length : i; };
  const hashes = new Map<string, string>();
  const out: Array<{ docType: string; sameAs: string }> = [];
  for (const [type, file] of Object.entries(docs).sort((a, b) => rank(a[0]) - rank(b[0]))) {
    let digest = "";
    try { digest = createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { continue; }
    const first = hashes.get(digest);
    if (first && first !== type) out.push({ docType: type, sameAs: first });
    else hashes.set(digest, type);
  }
  return out;
}

export function uploadedSubmissionDocuments(db: AppDb, project: ProjectRecord): Record<string, string> {
  const docs = projectDocsByType(db, project.id);
  for (const dup of duplicateUploads(docs)) delete docs[dup.docType];
  const permitPath = resolvePermitPath(project).path;
  const rows = db.query<{ doc_type: string; stored_path: string; original_filename: string }>(
    "SELECT doc_type, stored_path, original_filename FROM project_documents WHERE project_id = ?", [project.id]);
  for (const row of rows) {
    if (!/^(building_application|permit_application|solar_checklist)$/.test(row.doc_type)) continue;
    if (docs[row.doc_type] !== row.stored_path) continue;
    if ((row.doc_type === "solar_checklist" && permitPath === "engineered")
      || formContradictsPath(row.original_filename, permitPath)) delete docs[row.doc_type];
  }
  return docs;
}

/** Re-read project + selected file immediately before each actual upload. A path
 * change or replacement during a long browser run must stop the old payload. */
export function uploadDocumentGuard(db: AppDb, projectId: string, permitLane: boolean): (docType: string, file: string) => void {
  return (docType, file) => {
    const row = db.get<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", [projectId]);
    if (!row) throw new Error("Project no longer exists; upload stopped.");
    const project = { id: projectId, state: row.state, ahj: row.ahj,
      parserSnapshot: JSON.parse(String(row.parser_json || "{}")) } as ProjectRecord;
    if (permitLane && resolvePermitPath(project).path === "unknown") throw new Error("Permit path changed or is unknown; upload stopped.");
    if (submissionDocumentsByType(db, project)[docType] !== file) throw new Error(`The ${docType} document changed or no longer matches this permit path. Rebuild and restart the run.`);
  };
}
