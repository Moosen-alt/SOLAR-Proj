// ---------------------------------------------------------------------------
// HIDE IT FROM THE CLIENT. DO NOT DESTROY IT.
//
// The per-client portal's first render against the live database showed TML fifteen cards for
// about eight real jobs — four passes at 1075 Flanagan Ave, three at 990 17th St NE, two at
// 15622 SE Vivian Way, plus a fixture whose homeowner is "Test Testerson".
//
// Deleting them was the obvious move and the wrong one:
//
//   · portal-bot/src/demoReplay.ts reads the LIVE database and names il-test-ameren, 8f4ca8dd
//     and b0ab5169 by id. A delete breaks the demo.
//   · HANDOFF.md cites 29cd57b5 and 8f4ca8dd as certified staging runs, and the superseded
//     passes carry real submission and QC history that is the record of how those runs went.
//   · il-test-comed's Salem address under an Evanston/ComEd identity is not a typo to correct.
//     It is the preserved evidence of the snapshot-identity bug that once pointed an Illinois
//     project at PGE's real portal (see repository.ts on updateProject, projectIdentity.test.ts).
//
// So visibility is the thing that changes, and nothing else. The client stops seeing our
// workshop; every row, document, submission and check stays exactly where it was.
//
// REVERSIBLE ON PURPOSE. An archive you cannot undo is a delete with extra steps, so
// unarchiveProject exists and is tested.
//
// SCOPE: this hides projects from the CLIENT-FACING portal only. The operator dashboard still
// shows everything, deliberately — an operator hunting for "that Flanagan run from August" must
// still be able to find it, and hiding work from the people doing it is how a cleanup becomes a
// second problem.
// ---------------------------------------------------------------------------
import type { AppDb } from "./db";
import { nowIso } from "./time";
import { logger } from "./logger";

export interface ArchiveOutcome {
  archived: boolean;
  reason: string;
}

/**
 * Take a project off the client's portal, keeping everything about it.
 *
 * `why` is not optional in spirit: six months from now the only thing that explains why a job
 * vanished from a client's list is the sentence written here.
 */
export function archiveProject(db: AppDb, projectId: string, why: string): ArchiveOutcome {
  const row = db.get<{ id?: string; archived_at?: string }>(
    "SELECT id, archived_at FROM projects WHERE id = ?", [projectId],
  );
  if (!row?.id) return { archived: false, reason: `No such project: ${projectId}` };
  if (String(row.archived_at || "")) {
    return { archived: false, reason: `Already archived: ${projectId}` };
  }
  db.run(
    "UPDATE projects SET archived_at = ?, archived_reason = ? WHERE id = ?",
    [nowIso(), String(why || "").trim() || "archived without a stated reason", projectId],
  );
  logger.info("projects", "archived a project — hidden from the client portal, nothing deleted", { projectId, why });
  return { archived: true, reason: "" };
}

/** Put it back. Tested, because an archive that cannot be undone is a delete. */
export function unarchiveProject(db: AppDb, projectId: string): ArchiveOutcome {
  const row = db.get<{ id?: string }>("SELECT id FROM projects WHERE id = ?", [projectId]);
  if (!row?.id) return { archived: false, reason: `No such project: ${projectId}` };
  db.run("UPDATE projects SET archived_at = '', archived_reason = '' WHERE id = ?", [projectId]);
  logger.info("projects", "unarchived a project — visible on the client portal again", { projectId });
  return { archived: true, reason: "" };
}

export interface ArchivedProject {
  id: string;
  address: string;
  archivedAt: string;
  reason: string;
}

export function listArchivedProjects(db: AppDb): ArchivedProject[] {
  return db
    .query<Record<string, unknown>>(
      `SELECT id, project_address, archived_at, archived_reason FROM projects
        WHERE archived_at != '' ORDER BY archived_at DESC`,
    )
    .map((r) => ({
      id: String(r.id),
      address: String(r.project_address || ""),
      archivedAt: String(r.archived_at || ""),
      reason: String(r.archived_reason || ""),
    }));
}
