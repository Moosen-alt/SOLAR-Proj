import type { AppDb } from "./db";
import type { ProjectRecord } from "../../shared/src/types";
import { buildFilledFormsForProject } from "./ahjForms";
import { materializeGeneratedDocs } from "./generatedDocFiles";
import { ensureAhjFormsForProject } from "./ahjFormAuto";
import { createLLMProvider } from "./llm";
import { resolvePermitPath } from "./permitPath";
import { logger } from "./logger";

const COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** What Stage's acquisition did, for the caller that wants to say so (every current caller may
 *  ignore it). `acquisition`:
 *   - "full"            the AHJ/path cooldown was open and is now claimed: research as configured;
 *   - "within-cooldown" the AHJ was prepared < 24h ago: the FREE pass only (see below);
 *   - "failed"          acquisition threw — the fill still ran on whatever is stored;
 *   - "off"             AHJ_FORM_DOWNLOADS=off;
 *   - "unknown-path"    the permit path is not confirmed: nothing acquired or filled. */
export interface OfficialDocumentsPreparation {
  acquisition: "full" | "within-cooldown" | "failed" | "off" | "unknown-path";
  /** sourceUrl: the PDF a download was attempted from, when one was. */
  results: Array<{ formType: string; status: string; message: string; sourceUrl?: string }>;
}

/** Prepare actual applications before learn/stage assembles upload paths.
 *
 * THE COOLDOWN THROTTLES PAID RESEARCH, NEVER THE FORMS THIS JOB OWES (live 2026-09-27: Michael
 * Sheridan's Marion B-01S / E-01 were not on file at Stage because the City of Jefferson had been
 * prepared earlier that day, on a version before issuing-agency forms existed, and Stage skipped
 * acquisition for 24 hours). The shared AHJ/path cooldown is persisted and claimed before awaiting
 * network work, so retries and simultaneous projects do not amplify paid research (the web search,
 * the utility filing lookup). Inside it, Stage still runs the FREE pass — allowResearch:false — which
 * for every form this job's required set names:
 *   - answers "exists" off a held form with no download (everything on file = no fetch);
 *   - fetches the issuing agency's curated seed, the PDF this job's lookup cites for the agency, and
 *     the AHJ's own curated seed / state checklist — free downloads, model-free maps;
 *   - a failed curated fetch stays a named not_found (agency-contain C2: no cited fallthrough).
 * It never claims or extends the cooldown. A cited agency PDF is mapped by the model only when
 * research is allowed on this process (allowMapping): mapping it once is not repeated research, and
 * storing it unmapped would leave a hand-complete blank that no later pass re-maps.
 * Manual "Find official form" remains an explicit retry that bypasses the cooldown altogether. */
export async function prepareOfficialDocuments(db: AppDb, project: ProjectRecord): Promise<OfficialDocumentsPreparation> {
  const permitPath = resolvePermitPath(project).path;
  if (permitPath === "unknown") return { acquisition: "unknown-path", results: [] };
  let acquisition: OfficialDocumentsPreparation["acquisition"] = "off";
  let results: OfficialDocumentsPreparation["results"] = [];
  if (process.env.AHJ_FORM_DOWNLOADS !== "off") {
    db.exec(`CREATE TABLE IF NOT EXISTS ahj_form_acquisition_attempts (
      scope_key TEXT PRIMARY KEY, attempted_at INTEGER NOT NULL)`);
    const key = `${project.state}|${project.ahj}|${permitPath}`.trim().toLowerCase();
    const prior = db.get<{ attempted_at: number }>("SELECT attempted_at FROM ahj_form_acquisition_attempts WHERE scope_key = ?", [key]);
    const research = process.env.AHJ_FORM_RESEARCH !== "off" && Boolean(process.env.ANTHROPIC_API_KEY);
    const open = !prior || Date.now() - prior.attempted_at >= COOLDOWN_MS;
    if (open) db.run("INSERT INTO ahj_form_acquisition_attempts(scope_key, attempted_at) VALUES (?, ?) ON CONFLICT(scope_key) DO UPDATE SET attempted_at = excluded.attempted_at", [key, Date.now()]);
    acquisition = open ? "full" : "within-cooldown";
    try {
      const out = await ensureAhjFormsForProject(db, createLLMProvider(), project,
        open ? { allowResearch: research } : { allowResearch: false, allowMapping: research });
      results = out.results.map((r) => ({ formType: r.formType, status: r.status, message: r.message, ...(r.sourceUrl ? { sourceUrl: r.sourceUrl } : {}) }));
    } catch {
      acquisition = "failed";
      logger.warn("official-documents", "Form acquisition failed; filling available stored templates. Missing-document gates remain active.", { projectId: project.id });
    }
    // SAY WHAT IS STILL MISSING. The live incident was a Stage that quietly went on without the
    // county's forms; the required-document gates still block, and the log names which ones. Inside
    // the cooldown a not_found with no source is "nothing free to fetch, research is throttled" — not
    // a failure to act on (its message's "use Find official form" is the manual retry), so it is info.
    const stillMissing = results.filter((r) => r.status === "not_found" || r.status === "needs_manual");
    const actionable = acquisition === "within-cooldown" ? stillMissing.filter((r) => r.status === "needs_manual" || r.sourceUrl) : stillMissing;
    if (stillMissing.length) {
      logger[actionable.length ? "warn" : "info"]("official-documents", `Official form(s) not on file after ${acquisition === "full" ? "acquisition" : "the no-research pass (inside the 24h cooldown)"}: ${stillMissing.map((r) => `${r.formType}: ${r.status}`).join("; ")}`,
        { projectId: project.id, detail: stillMissing.map((r) => r.message).join(" | ").slice(0, 1200) });
    }
  }
  await buildFilledFormsForProject(db, project);
  // And the generated application package (transfer sheet, worksheets, prescriptive
  // application) becomes FILES the upload paths can attach — see generatedDocFiles.ts.
  // Additive: a render failure logs and staging proceeds on filled forms + uploads as before.
  // The return value is not needed here: the render's own manifest is what every reader
  // (submissionDocumentsByType) reads, keyed by the builder's doc id — never by filename.
  await materializeGeneratedDocs(db, project);
  return { acquisition, results };
}
