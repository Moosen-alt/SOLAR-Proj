import type { ProjectRecord, SubmittalTrackType } from "../../shared/src/types";
import type { AppDb } from "./db";
import { filledFormsByDocType, formContradictsPath } from "./ahjForms";
import { generatedDocFilesByType } from "./generatedDocFiles";
import { resolvePermitPath } from "./permitPath";
import { projectDocsByType } from "./projectDocuments";
import { docDisciplineFor, docFitsTrack } from "./docDiscipline";
// A deliberate import cycle: requiredDocuments imports this module's uploadedSubmissionDocuments /
// duplicateUploads, and this module asks requiredDocuments's requiredListCheck which utility
// documents an AHJ names (OD-4). Both use each other only inside function bodies, so ESM
// instantiation resolves it (function declarations are bound before either module evaluates).
import { requiredListCheck } from "./requiredDocuments";
import { createHash } from "node:crypto";
import fs from "node:fs";

/** One selection policy for learning and replay. An explicitly uploaded document
 * takes precedence over a filled form of the same type. Filled official forms are
 * filtered against the current permit path before merging (filledFormsByDocType), and
 * the generated package is read from its last render's manifest only when that render
 * was made on the current permit path (generatedDocFilesByType) — its worksheets carry
 * their own generated_* keys and never occupy an official form's key.
 *
 * AND IT IS SCOPED TO THE TRACK (docs-audit PLAN D3). `track` is REQUIRED: the filing this
 * run makes ("building", "electrical", "combo", "mpu", "permit" or "nem"), or an explicit
 * `null` for a legacy trackless stage that files everything. A run is handed only its own
 * track's documents plus the shared plan-set family — the ONE table in docDiscipline.ts, the
 * same one the staging gate reads — so an electrical run no longer carries the BCD 5952, the
 * building application, the utility bill or the meter photo (Michael 53266857: 16 keys). An AHJ
 * track takes a utility document only when that AHJ's own required list names it (OD-4).
 * Omitting the track throws rather than failing open: callers tsc cannot see (tests, scripts)
 * must say which filing they assemble. */
export function submissionDocumentsByType(db: AppDb, project: ProjectRecord, track: SubmittalTrackType | null): Record<string, string> {
  if (track === undefined) {
    throw new Error("submissionDocumentsByType: name the track this run files (null = every track) — an omitted track would hand a run every document the project holds.");
  }
  // Layering is one-directional and load-bearing (operator ruling 2026-09-21, "the bot can
  // attach them all"): the GENERATED package (transfer sheet, worksheets — rendered by
  // generatedDocFiles.ts) is the floor, the jurisdiction's own FILLED official forms outrank
  // it on any shared docType, and anything a person UPLOADED by hand outranks both.
  const permitPath = resolvePermitPath(project).path;
  const all: Record<string, string> = {
    ...generatedDocFilesByType(project.id, permitPath),
    ...filledFormsByDocType(db, project.id, permitPath),
    ...uploadedSubmissionDocuments(db, project),
  };
  if (track === null) return all;
  // Only an AHJ track holding a utility document needs to ask the AHJ's list.
  const needsAhjList = track !== "nem" && Object.keys(all).some((t) => docDisciplineFor(t).lane === "nem");
  const ahjNamed = needsAhjList ? utilityDocsNamedByAhj(db, project) : new Set<string>();
  return Object.fromEntries(Object.entries(all).filter(([docType]) => docFitsTrack(docType, track, ahjNamed)));
}

/**
 * The utility-lane docTypes this project's AHJ's OWN required list names — the job's cited
 * per-job lookup, else its shipped/seeded profile list (requiredListCheck: the same list the
 * packet's "required list" row reads). An item the list itself marks as entered in the portal or
 * as the other permit path's does not count. No list, or any failure reading it, names nothing:
 * the utility bill carries the account number, so the answer fails CLOSED (OD-4).
 */
function utilityDocsNamedByAhj(db: AppDb, project: ProjectRecord): Set<string> {
  const named = new Set<string>();
  try {
    const list = requiredListCheck(db, project, { required: [], presence: [], missingBlocking: [], missingAdvisory: [] });
    if (list.source === "unknown") return named;
    for (const item of list.items) {
      if (item.skipped) continue;
      for (const t of item.docTypes) if (docDisciplineFor(t).lane === "nem") named.add(t);
    }
  } catch { /* fail closed */ }
  return named;
}

/** Explicit wrong-path uploads cannot override a compatible generated form.
 * Generic applications remain valid; arbitrary body prose is not a title. */
// THE SAME FILE IS NEVER TWO DOCUMENTS. City of Jefferson's inverter_spec upload was byte-identical
// to its module_spec (1,051,462 bytes): an intake mis-slot the staging would have attached twice as
// two different documents. The first doc type in DUPLICATE_PRECEDENCE keeps the file; the later one
// is dropped from the upload set and reported, so the inventory can say "same file as …".
const DUPLICATE_PRECEDENCE = ["plan_set", "sld", "site_plan", "structural", "structural_letter", "stamped_plans", "module_spec", "inverter_spec",
  "racking_spec", "battery_spec", "ess_detail", "labels", "utility_bill", "meter_photo"];
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
 * change or replacement during a long browser run must stop the old payload.
 *
 * `scope` names the filing. `{ track }` compares against the SAME track-scoped map the run
 * was handed (docs-audit PLAN D3), so an attach of a document outside the track throws —
 * defense in depth behind the scoped payload. The legacy boolean (true = an AHJ run, false =
 * the utility run) still compares against the every-track map, exactly as before; its callers
 * are handed a scoped payload already and move to `{ track }` in their own files' rounds. */
export function uploadDocumentGuard(
  db: AppDb,
  projectId: string,
  scope: boolean | { track: SubmittalTrackType | null },
): (docType: string, file: string) => void {
  const track = typeof scope === "boolean" ? null : scope.track;
  const permitLane = typeof scope === "boolean" ? scope : track !== "nem";
  return (docType, file) => {
    const row = db.get<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", [projectId]);
    if (!row) throw new Error("Project no longer exists; upload stopped.");
    const project = { id: projectId, state: row.state, ahj: row.ahj, city: row.city, utility: row.utility,
      parserSnapshot: JSON.parse(String(row.parser_json || "{}")) } as ProjectRecord;
    if (permitLane && resolvePermitPath(project).path === "unknown") throw new Error("Permit path changed or is unknown; upload stopped.");
    if (submissionDocumentsByType(db, project, track)[docType] !== file) {
      // The leading words are a matching key: portalRecipes' run-failure attribution reads
      // "document changed or no longer matches" as a DOCUMENT gate, never the recipe's fault.
      throw new Error(`The ${docType} document changed or no longer matches this permit path${track ? ` or the ${track} filing` : ""}. Rebuild and restart the run.`);
    }
  };
}
