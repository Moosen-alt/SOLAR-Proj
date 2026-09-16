import type { ProjectRecord } from "../../shared/src/types";
import type { AppDb } from "./db";
import { filledFormsByDocType } from "./ahjForms";
import { resolvePermitPath } from "./permitPath";
import { projectDocsByType } from "./projectDocuments";

/** One selection policy for learning and replay. An explicitly uploaded document
 * takes precedence over a generated form of the same type. Generated forms are
 * filtered against the current project path before merging. */
export function submissionDocumentsByType(db: AppDb, project: ProjectRecord): Record<string, string> {
  return {
    ...filledFormsByDocType(db, project.id, resolvePermitPath(project).path),
    ...projectDocsByType(db, project.id),
  };
}
