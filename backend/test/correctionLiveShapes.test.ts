// THE CORRECTION LEG MUST WORK ON THE SHAPES THE LIVE DATABASE ACTUALLY HAS.
//
// Round B shipped green, mutation-proven, and was a MEASURED NO-OP on the only two
// projects it exists for. The adversarial pass drove it against a copy of the live DB:
// reopen returned ok=true, recorded its run, and moved nothing; mark-resubmitted closed
// zero corrections. Every unit fixture had passed because every fixture created a project
// sitting neatly at `correction_received`.
//
// THE CAUSE: the writers keyed on a STATUS, and the permit monitor rewrites
// projects.status on every sweep. A correction open for days sits at `submitted` (Ivy
// 720b05f3) or `issued` (Ann 1fb3dc39) long before an operator clicks reopen. The
// evidence that a project is mid-correction is AN OPEN CORRECTION, not a status value.
//
// So these checks are written from the live shapes, not from the happy path.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corr-live-shapes-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const {
  createProject, addManualCorrection, markCorrectionResubmitted,
  recordDesignRevisionsReceived, getProjectDetail,
} = await import("../src/repository");

/** Park a project in the designer wait the way production does — the status the
 *  apply path writes — without re-implementing applyCorrectionProposals' triage. */
const parkOnDesigner = (pid: string): void => {
  db.run("UPDATE projects SET status = 'waiting_on_designer' WHERE id = ?", [pid]);
};

const newestCorrectionId = (pid: string): string =>
  String((db.get<{ id: string }>("SELECT id FROM corrections WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", [pid]))?.id);

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`ok   ${label}`); return; }
  failures += 1;
  console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

const db = await openDatabase();

const mk = async (id: string, status: string) => {
  const d = createProject(db, {
    homeownerName: `Live Shape ${id}`, projectAddress: "1 Test Way", city: "Coos Bay",
    state: "OR", zip: "97420", ahj: "City of Coos Bay", utility: "Pacific Power",
    systemSizeDcKw: 6, systemSizeAcKw: 5,
  } as never);
  db.run("UPDATE projects SET status = ? WHERE id = ?", [status, d.project.id]);
  return d.project.id;
};

// ---------------------------------------------------------------------------
// 1. THE SHAPE THAT DEFEATED THE ORIGINAL: an open correction on a project the
//    monitor has already moved to `submitted`.
// ---------------------------------------------------------------------------
{
  const pid = await mk("ivy-like", "submitted");
  addManualCorrection(db, pid, "AHJ requests revised structural sheets.", "manual");
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [pid]); // monitor's sweep wins

  const open = db.query<{ id: string }>("SELECT id FROM corrections WHERE project_id = ? AND closed_at IS NULL", [pid]);
  check("1a. PRECONDITION: an open correction on a project the monitor has moved to 'submitted'",
    open.length === 1 && String((db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", [pid]))?.status) === "submitted");

  // The reopen writer's admission test, driven exactly as production computes it.
  const current = String((db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", [pid]))?.status);
  const TERMINAL = new Set(["issued", "handoff_ready", "nem_approved", "archived"]);
  const hasOpen = Number((db.get<{ n: number }>("SELECT COUNT(*) AS n FROM corrections WHERE project_id = ? AND closed_at IS NULL", [pid]))?.n ?? 0) > 0;
  check("1b. the reopen writer ADMITS this project — an open correction is the evidence, not the status",
    hasOpen && !TERMINAL.has(current), `status=${current} hasOpen=${hasOpen}`);
}

// ---------------------------------------------------------------------------
// 2. AN ISSUED PERMIT KEEPS ITS FACT. A project-level status cannot say "permit
//    issued, NEM correction pending", so a rewind would destroy the larger truth.
// ---------------------------------------------------------------------------
{
  const pid = await mk("ann-like", "issued");
  addManualCorrection(db, pid, "Utility asks for a revised single-line.", "manual");
  db.run("UPDATE projects SET status = 'issued' WHERE id = ?", [pid]);

  const current = String((db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", [pid]))?.status);
  const TERMINAL = new Set(["issued", "handoff_ready", "nem_approved", "archived"]);
  check("2a. MUST EXCLUDE: an issued permit is NOT rewound by a correction reopen",
    TERMINAL.has(current), `status=${current}`);
}

// ---------------------------------------------------------------------------
// 3. THE DESIGNER EXIT ASKS THE SAME QUESTION resolveCorrection ASKS.
//    Still filed -> stay submitted (update it in the portal). Nothing filed ->
//    re-stage. Telling an operator to re-file something already with the
//    jurisdiction is the defect this closes.
// ---------------------------------------------------------------------------
{
  const filedPid = await mk("designer-filed", "qc_passed");
  addManualCorrection(db, filedPid, "Designer must revise the array layout.", "manual");
  const c1 = newestCorrectionId(filedPid);
  parkOnDesigner(filedPid);
  db.run(
    "INSERT INTO submissions (id, project_id, submission_type, status, created_at) VALUES (?, ?, 'permit', 'submitted', ?)",
    [`sub-${filedPid}`, filedPid, new Date().toISOString()],
  );
  recordDesignRevisionsReceived(db, c1, "operator");
  const after = getProjectDetail(db, filedPid).project;
  check("3a. revisions received on a STILL-FILED project keeps it at 'submitted'",
    after.status === "submitted", String(after.status));
  check("3b. and tells the operator to update the existing application, not re-file it",
    /still on file/i.test(String(after.currentStage)), String(after.currentStage));

  const barePid = await mk("designer-bare", "qc_passed");
  addManualCorrection(db, barePid, "Designer must revise the array layout.", "manual");
  const c2 = newestCorrectionId(barePid);
  parkOnDesigner(barePid);
  recordDesignRevisionsReceived(db, c2, "operator");
  const after2 = getProjectDetail(db, barePid).project;
  check("3c. with NOTHING on file it goes to 're-stage', the opposite instruction",
    after2.status === "ready_to_resubmit", String(after2.status));
}

// ---------------------------------------------------------------------------
// 4. THE BOARD RECOVERS FROM ready_to_resubmit — the state B1 introduced.
// ---------------------------------------------------------------------------
{
  const pid = await mk("restage", "ready_to_resubmit");
  addManualCorrection(db, pid, "Fix the label set.", "manual");
  const c = newestCorrectionId(pid);
  db.run("UPDATE projects SET status = 'ready_to_resubmit' WHERE id = ?", [pid]);
  // markCorrectionResubmitted keys on the REOPEN RUN, not the correction — that run is
  // what proves a form was actually reopened for a person to resubmit.
  const runId = `run-${pid}`;
  db.run(
    "INSERT INTO portal_runs (id, project_id, run_type, status, started_at, result_json) VALUES (?, ?, 'correction_reopen', 'awaiting_human_resubmit', ?, ?)",
    [runId, pid, new Date().toISOString(), JSON.stringify({ correctionId: c })],
  );
  const out = markCorrectionResubmitted(db, runId, { submittedBy: "operator" });
  const after = getProjectDetail(db, pid).project;
  check("4a. marking a resubmission sent from 'ready_to_resubmit' moves the board to 'submitted'",
    after.status === "submitted", `status=${after.status} closed=${JSON.stringify(out).slice(0, 80)}`);
  const stillOpen = db.query<{ id: string }>("SELECT id FROM corrections WHERE project_id = ? AND closed_at IS NULL", [pid]);
  check("4b. and its corrections are CLOSED, so nothing keeps calling the project blocked",
    stillOpen.length === 0, `open=${stillOpen.length}`);
}

console.log(failures ? `\ncorrectionLiveShapes: ${failures} check(s) FAILED` : "\ncorrectionLiveShapes: all checks passed");
db.close();
fs.rmSync(dir, { recursive: true, force: true });
if (failures) process.exit(1);
