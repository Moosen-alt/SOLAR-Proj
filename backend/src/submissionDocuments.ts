import type { ProjectRecord } from "../../shared/src/types";
import type { AppDb } from "./db";
import { filledFormsByDocType, formContradictsPath } from "./ahjForms";
import { resolvePermitPath } from "./permitPath";
import { projectDocsByType } from "./projectDocuments";

/** One selection policy for learning and replay. An explicitly uploaded document
 * takes precedence over a generated form of the same type. Generated forms are
 * filtered against the current project path before merging. */
export function submissionDocumentsByType(db: AppDb, project: ProjectRecord): Record<string, string> {
  return {
    ...filledFormsByDocType(db, project.id, resolvePermitPath(project).path),
    ...uploadedSubmissionDocuments(db, project),
  };
}

/** Explicit wrong-path uploads cannot override a compatible generated form.
 * Generic applications remain valid; arbitrary body prose is not a title. */
export function uploadedSubmissionDocuments(db: AppDb, project: ProjectRecord): Record<string, string> {
  const docs = projectDocsByType(db, project.id);
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
