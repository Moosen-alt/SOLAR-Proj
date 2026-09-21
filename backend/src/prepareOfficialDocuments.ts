import type { AppDb } from "./db";
import type { ProjectRecord } from "../../shared/src/types";
import { buildFilledFormsForProject } from "./ahjForms";
import { materializeGeneratedDocs } from "./generatedDocFiles";
import { ensureAhjFormsForProject } from "./ahjFormAuto";
import { createLLMProvider } from "./llm";
import { resolvePermitPath } from "./permitPath";
import { logger } from "./logger";

/** Prepare actual applications before learn/stage assembles upload paths. Shared
 * AHJ/path cooldown is persisted and claimed before awaiting network work, so
 * retries and simultaneous projects do not amplify paid research. Manual Find
 * official form remains an explicit retry that bypasses this automatic cooldown. */
export async function prepareOfficialDocuments(db: AppDb, project: ProjectRecord): Promise<void> {
  const permitPath = resolvePermitPath(project).path;
  if (permitPath === "unknown") return;
  if (process.env.AHJ_FORM_DOWNLOADS !== "off") {
    db.exec(`CREATE TABLE IF NOT EXISTS ahj_form_acquisition_attempts (
      scope_key TEXT PRIMARY KEY, attempted_at INTEGER NOT NULL)`);
    const key = `${project.state}|${project.ahj}|${permitPath}`.trim().toLowerCase();
    const prior = db.get<{ attempted_at: number }>("SELECT attempted_at FROM ahj_form_acquisition_attempts WHERE scope_key = ?", [key]);
    if (!prior || Date.now() - prior.attempted_at >= 24 * 60 * 60 * 1000) {
      db.run("INSERT INTO ahj_form_acquisition_attempts(scope_key, attempted_at) VALUES (?, ?) ON CONFLICT(scope_key) DO UPDATE SET attempted_at = excluded.attempted_at", [key, Date.now()]);
      try { await ensureAhjFormsForProject(db, createLLMProvider(), project,
        { allowResearch: process.env.AHJ_FORM_RESEARCH !== "off" && Boolean(process.env.ANTHROPIC_API_KEY) }); }
      catch { logger.warn("official-documents", "Form acquisition failed; filling available stored templates. Missing-document gates remain active.", { projectId: project.id }); }
    }
  }
  await buildFilledFormsForProject(db, project);
  // And the generated application package (transfer sheet, worksheets, prescriptive
  // application) becomes FILES the upload paths can attach — see generatedDocFiles.ts.
  // Additive: a render failure logs and staging proceeds on filled forms + uploads as before.
  await materializeGeneratedDocs(db, project);
}
