// CORRECTION FLOW MUST HAVE AN EXIT. correction_received / correction_triaged are not in
// PRE_STAGE_STATUSES, so the auto-resume fired by the resolve route refuses to re-drive a
// project sitting in them — and closing a correction used to leave the status untouched,
// stranding the project there forever.
//
// WHERE IT EXITS TO DEPENDS ON WHETHER ANYTHING IS STILL ON FILE:
//   still filed  → "submitted"           (corrected IN the portal; nothing to re-stage)
//   nothing filed→ "ready_to_resubmit"   (the corrected package must be staged and filed again)
//
// The not-filed leg wrote "parsed" until Round B1. That REWOUND a corrected project to
// stage 0 (QC / Verify) on the board — a job that had been filed, bounced and fixed looked
// like a plan set that had just been read. "ready_to_resubmit" maps to the Submit stage and
// had a label, a banner and client-facing text but zero writers. MUST-EXCLUDE, asserted
// below: "parsed" must not be written on the resolve leg by either branch.
//
// Also covers the autopilot-panel pause pinning: a historical pause_reason on the
// latest portal_run must stop reading as "paused for MFA" once the run is no longer
// paused or the project has moved on. Browser-free. Run:
//   tsx backend/test/correctionResubmit.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "correction-resubmit-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.PORTAL_PROFILES_DIR = path.join(tmpDir, "portal-profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.ANTHROPIC_API_KEY = ""; // regex classifier only — no agent job
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const {
  createProject, addManualCorrection, resolveCorrection, applyCorrectionProposals, getProjectDetail,
  reopenCorrectionOnPortal, markCorrectionResubmitted, captureConfirmation, createPermitCheckTarget,
  setProjectStatusByOperator, syncOperationsPlan,
} = await import("../src/repository");
const { getAutopilotState } = await import("../src/autopilot");
const db = await openDatabase();

let passed = 0;
const ok = (n: string) => { passed++; console.log(`ok   ${n}`); };

const detail = createProject(db, {
  owner: "Test Owner", address: "1 Test Way", city: "Portland", state: "OR", zip: "97201",
  ahj: "City of Portland", utility: "PGE", dcKw: "6.0",
});
const projectId = detail.project.id;

// 1) A manual correction classifies and moves the project into correction_triaged.
const afterCorrection = addManualCorrection(db, projectId, "Please revise the one-line diagram to show the AC disconnect location.");
assert.equal(afterCorrection.project.status, "correction_triaged");
const correctionId = afterCorrection.corrections[0].id;
ok("manual correction lands the project in correction_triaged");

// 2) Resolving the last open correction on a project with NOTHING on file releases it to
//    "ready_to_resubmit" — the Submit-stage state, not the stage-0 rewind "parsed" was.
resolveCorrection(db, correctionId, { resubmitted: false });
const row = db.get<{ status?: string; current_stage?: string; stage_detail?: string }>(
  "SELECT status, current_stage, stage_detail FROM projects WHERE id = ?", [projectId],
);
assert.equal(row?.status, "ready_to_resubmit", "project must leave the correction state when its last correction closes");
assert.notEqual(row?.status, "parsed", "MUST-EXCLUDE: the resolve leg must never rewind a corrected project to the QC stage");
// The prose is a MATCHING KEY — byte-identical, never rewritten to follow the status.
assert.equal(row?.current_stage, "Correction resolved — ready to re-stage.");
assert.equal(row?.stage_detail, "correction_resolved_restage", "the machine-readable half must name the nothing-on-file leg");
ok("resolving the last correction makes the project re-stageable");

// 3) With ANOTHER correction still open, resolving one must NOT release the project.
addManualCorrection(db, projectId, "Correction A: label the inverter OCPD rating.");
const two = addManualCorrection(db, projectId, "Correction B: provide the module spec sheet.");
assert.equal(two.project.status, "correction_triaged");
const [newer, older] = two.corrections.filter((c) => !c.closedAt);
resolveCorrection(db, older.id, { resubmitted: false });
assert.equal(
  db.get<{ status?: string }>("SELECT status FROM projects WHERE id = ?", [projectId])?.status,
  "correction_triaged",
  "one of two open corrections closed — the project must stay put",
);
resolveCorrection(db, newer.id, { resubmitted: false });
assert.equal(
  db.get<{ status?: string }>("SELECT status FROM projects WHERE id = ?", [projectId])?.status,
  "ready_to_resubmit",
  "closing the LAST open correction releases the project",
);
ok("the project is released only when the last open correction closes");

// 3b) A STILL-FILED project goes back to "submitted", not "ready to re-stage".
//     "Ready to re-stage" assumes the fix happens here and the application is sent
//     afterwards. A suspended filing is usually corrected IN the portal — the utility
//     reopens the original application, the operator edits and resubmits, and the filing
//     never stopped existing. Announcing "ready to re-stage" there invites a re-stage that
//     prepareSubmission refuses with a 409 anyway. Live: PacifiCorp APP-111681 was corrected
//     and resubmitted in PowerClerk, and its status had to be put back by hand.
const filedProject = createProject(db, {
  owner: "Filed Owner", address: "2 Filed Way", city: "Coos Bay", state: "OR", zip: "97420",
  ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "7.2",
});
const filedId = filedProject.project.id;
db.run(
  `INSERT INTO submissions (id, project_id, submission_type, status, application_number, permit_type, created_at)
   VALUES ('sub-filed', ?, 'nem', 'submitted', 'APP-111681', 'nem', ?)`,
  [filedId, new Date().toISOString()],
);
const filedCorrection = addManualCorrection(db, filedId, "Provide a photo of the face of the meter; the image received is an electric bill.");
assert.equal(filedCorrection.project.status, "correction_triaged");
resolveCorrection(db, filedCorrection.corrections[0].id, { resubmitted: true });
const filedRow = db.get<{ status?: string; current_stage?: string; stage_detail?: string }>(
  "SELECT status, current_stage, stage_detail FROM projects WHERE id = ?", [filedId],
);
assert.equal(filedRow?.status, "submitted", "a project whose filing is still submitted must not be sent back to re-stage");
assert.match(String(filedRow?.current_stage), /resubmitted/i);
// MUST-EXCLUDE (over-correction guard): B1 changed the NOT-FILED leg only. The filed leg keeps
// its status, its prose AND its stage_detail — `ready_to_resubmit` here would announce work
// that is already done and invite a re-stage prepareSubmission refuses with a 409.
assert.notEqual(filedRow?.status, "ready_to_resubmit", "MUST-EXCLUDE: a still-filed project must not be released to re-stage");
assert.notEqual(filedRow?.status, "parsed", "MUST-EXCLUDE: the resolve leg never writes the stage-0 rewind");
assert.equal(filedRow?.stage_detail, "correction_resolved", "the still-filed leg keeps its own stage_detail");
ok("a correction closed on a STILL-FILED project returns it to submitted, not re-stage");

// 4) Pause pinning: a HISTORICAL pause_reason on the latest run must not pin the
//    autopilot panel at "paused for human" once the run isn't paused any more.
const now = new Date().toISOString();
db.run(
  `INSERT INTO portal_runs (id, project_id, run_type, status, started_at, pause_reason, permit_type)
   VALUES ('run-hist', ?, 'prepare_submit', 'failed', ?, 'mfa', 'permit')`,
  [projectId, now],
);
const state = getAutopilotState(db, projectId);
assert.notEqual(state.phase, "paused_for_human", "a non-paused run's old pause_reason must not pin the panel");
ok("historical pause_reason on a finished run no longer pins the panel");

// 5) A run that IS currently paused still reports paused_for_human.
db.run(
  `INSERT INTO portal_runs (id, project_id, run_type, status, started_at, pause_reason, permit_type)
   VALUES ('run-live', ?, 'prepare_submit', 'paused_for_human', ?, 'captcha', 'permit')`,
  [projectId, new Date(Date.now() + 1000).toISOString()],
);
const paused = getAutopilotState(db, projectId);
assert.equal(paused.phase, "paused_for_human", "a live pause must still surface");
assert.equal(paused.pauseReason, "captcha");
ok("a live paused run still reports paused_for_human");

// Two simultaneous corrections must retain separate proposals and review state.
const isolated = createProject(db, { owner: "Proposal Test", address: "2 Test Way", city: "Portland", state: "OR", zip: "97201", ahj: "City of Portland", utility: "PGE", dcKw: "6" });
const pid = isolated.project.id;
const first = addManualCorrection(db, pid, "Correct city on the application.").corrections[0];
const second = addManualCorrection(db, pid, "Correct ZIP on the application.").corrections.find(c => c.id !== first.id)!;
const items = db.query<{ id: string; notes: string }>("SELECT id, notes FROM human_review_items WHERE project_id = ? AND field_name = 'correction'", [pid]);
const linked = (cid: string) => items.find(i => JSON.parse(i.notes.slice(13)).correctionId === cid)!;
for (const [c, field, value] of [[first, "city", "Tigard"], [second, "zip", "97223"]] as const) {
  db.run("UPDATE human_review_items SET notes = ? WHERE id = ?", [`agent-triage:${JSON.stringify({ correctionId: c.id, proposals: [{ field, currentValue: "", proposedValue: value, basis: "Fixture correction" }], actions: [] })}`, linked(c.id).id]);
}
applyCorrectionProposals(db, first.id);
assert.equal(getProjectDetail(db, pid).project.city, "Tigard");
assert.equal(getProjectDetail(db, pid).project.zip, "97201", "the other correction's ZIP must not apply");
assert.throws(() => applyCorrectionProposals(db, first.id), /No unique pending/);
resolveCorrection(db, first.id);
assert.equal(db.get<{ status: string }>("SELECT status FROM human_review_items WHERE id = ?", [linked(second.id).id])?.status, "pending");
assert.throws(() => applyCorrectionProposals(db, second.id, []), /no selected data updates/);
applyCorrectionProposals(db, second.id);
assert.equal(getProjectDetail(db, pid).project.zip, "97223");
ok("correction approval and resolution target only their linked review, and empty/repeated approvals fail");

// ---------------------------------------------------------------------------
// ROUND B2 — THE REOPEN LEG. Two measured defects, both of them silence.
//
//   (1) reopenCorrectionOnPortal recorded a portal_runs row and NOTHING ELSE. A successful
//       reopen — the suspended filing's own correction form open on the portal, revised docs
//       staged through the attach gate — left projects.status at `correction_triaged`, so the
//       board showed the same "an outside party stopped this filing" chip it showed before
//       anyone touched it. `awaiting_human_resubmit` existed in the union, labeled and
//       bannered, with zero writers.
//   (2) NOTHING CLOSED A CORRECTION ON THIS PATH. resolveOpenCorrectionsOnResubmit fires only
//       from captureConfirmation, which the reopen path never reaches, so a reopened AND
//       resubmitted correction stayed open until a human hit /resolve by hand — and every
//       open-correction surface (syncOperationsPlan's openCorrectionCount, both lanes, the
//       action queue) went on calling the job blocked.
//
// MUST-EXCLUDE, both asserted below:
//   · a reopened + resubmitted correction still counted OPEN by the production surface;
//   · the reopen ALONE closing a correction — opening a form is not evidence anything was
//     filed (ruling: auto-close attaches to the RESUBMIT event only).
//   · a reopen overwriting a status it did not set.
//
// Browser-free: reopenCorrectionOnPortal takes an injectable `runner`, so the adapter contract
// is stubbed and nothing launches Chromium.
const reopenRunner = (outcome: Record<string, unknown>) => (async () => outcome) as never;
const okReopen = reopenRunner({
  ok: true, needsHuman: false, finalSubmitClicked: false, finalSubmitClickedByAutomation: false,
  reopenedForm: "Interconnection Correction Form", attachedDocs: 2, browserLeftOpen: false,
  message: "", offeredForms: [],
});

// A suspended NEM filing, tracked, with an open correction — the PacifiCorp APP-111681 shape.
const reopenProject = createProject(db, {
  owner: "Reopen Owner", address: "3 Reopen Way", city: "Coos Bay", state: "OR", zip: "97420",
  ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8.4",
});
const reopenId = reopenProject.project.id;
db.run(
  `INSERT INTO submissions (id, project_id, submission_type, status, application_number, permit_type, created_at)
   VALUES ('sub-reopen', ?, 'nem', 'submitted', 'APP-777001', 'nem', ?)`,
  [reopenId, new Date().toISOString()],
);
createPermitCheckTarget(db, reopenId, {
  targetType: "nem", permitType: "nem", applicationNumber: "APP-777001",
  portalName: "Pacific Power", portalUrl: "https://nem.example-utility.test/app", checkFrequencyDays: 14,
});
const reopenTargetId = String(db.get<{ id: string }>(
  "SELECT id FROM permit_check_targets WHERE project_id = ?", [reopenId],
)?.id);
// The monitor schedules the next read a full frequency window out (recordPermitStatusCheck
// writes nextCheckIso(frequency)). Simulate that window so "refreshed" is a measurable move
// and not an artifact of the row being newly created.
const farFuture = new Date(Date.now() + 14 * 86400000).toISOString();
db.run("UPDATE permit_check_targets SET next_check_at = ?, last_checked_at = ? WHERE id = ?", [farFuture, farFuture, reopenTargetId]);

const reopenCorrection = addManualCorrection(db, reopenId, "The utility suspended the interconnection: provide a photo of the meter face; the image received is an electric bill.");
assert.equal(reopenCorrection.project.status, "correction_triaged");
const reopenCorrectionId = reopenCorrection.corrections[0].id;

const reopened = await reopenCorrectionOnPortal(db, reopenCorrectionId, { runner: okReopen });
assert.equal(reopened.ok, true, `reopen stub must succeed: ${reopened.message}`);
const reopenRunId = String(reopened.runId);
const afterReopen = db.get<{ status?: string; current_stage?: string; stage_detail?: string }>(
  "SELECT status, current_stage, stage_detail FROM projects WHERE id = ?", [reopenId],
);
assert.equal(afterReopen?.status, "awaiting_human_resubmit", "a successful reopen must move the project — the board showed nothing before");
assert.equal(afterReopen?.stage_detail, "correction_reopened", "the machine-readable half must name the reopened-awaiting-human state");
assert.match(String(afterReopen?.current_stage), /reopened/i);
assert.equal(
  db.get<{ status?: string }>("SELECT status FROM portal_runs WHERE id = ?", [reopenRunId])?.status,
  "awaiting_human_resubmit",
  "the run itself still records awaiting_human_resubmit (never awaiting_human_submit — that status is what the auto-submit path selects by)",
);
ok("a successful reopen writes awaiting_human_resubmit on the project");

// MUST-EXCLUDE: the reopen must not close anything. Reopening a form is not evidence a filing
// went out — the operator has not clicked the portal's resubmit yet.
assert.equal(
  Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM corrections WHERE project_id = ? AND closed_at IS NULL AND resubmitted = 0", [reopenId])?.n),
  1,
  "MUST-EXCLUDE: reopening the form must NOT close the correction — auto-close attaches to the resubmit event only",
);
assert.equal(
  syncOperationsPlan(db, reopenId).steps.find((step) => step.phaseKey === "correction_management")?.status,
  "blocked",
  "MUST-EXCLUDE: the production open-correction surface must still call the job blocked after a reopen alone",
);
ok("a reopen alone closes nothing — the correction stays open and the job stays blocked");

// MUST-EXCLUDE: a reopen never overwrites a status it did not set. The permit monitor or an
// operator can move a project while a correction is still open; the reopen is evidence about
// the correction, not about the permit.
const movedProject = createProject(db, {
  owner: "Moved Owner", address: "4 Moved Way", city: "Salem", state: "OR", zip: "97301",
  ahj: "City of Salem", utility: "PGE", dcKw: "5.5",
});
const movedId = movedProject.project.id;
createPermitCheckTarget(db, movedId, {
  targetType: "permit", permitType: "combo", applicationNumber: "BLD-2026-0042",
  portalName: "Salem Permits", portalUrl: "https://permits.example-ahj.test/portal", checkFrequencyDays: 7,
});
const movedCorrectionId = addManualCorrection(db, movedId, "Label the inverter OCPD rating on the one-line.").corrections[0].id;
// The audited operator door, not raw SQL: a fixture that fakes the write proves nothing about
// what production can actually put in that column.
setProjectStatusByOperator(db, movedId, "issued", "the permit came back issued while this correction was still open", "test-operator");
const movedResult = await reopenCorrectionOnPortal(db, movedCorrectionId, { runner: okReopen });
assert.equal(movedResult.ok, true);
assert.equal(
  db.get<{ status?: string }>("SELECT status FROM projects WHERE id = ?", [movedId])?.status,
  "issued",
  "MUST-EXCLUDE: a reopen must never clobber a status it did not set",
);
assert.ok(
  db.get<{ id?: string }>("SELECT id FROM audit_logs WHERE project_id = ? AND action = 'correction.reopen_status_unchanged'", [movedId]),
  "the skipped status write must be AUDITED — a status that refused to move must never be invisible",
);
ok("a reopen on an unrelated status leaves it alone, and says so on the audit trail");

// "MARK RESUBMITTED" — the human's own record that the portal's resubmit was clicked.
const marked = markCorrectionResubmitted(db, reopenRunId, { submittedBy: "test-operator", confirmationNumber: "RESUB-9001" });
assert.equal(marked.closedCorrections, 1, "the ONE existing closer must close the correction this resubmission answers");
assert.equal(marked.correctionsStillOpen, 0);
assert.equal(marked.checkTargetRefreshed, true);
const closedRow = db.get<{ closed_at?: string; resubmitted?: number }>(
  "SELECT closed_at, resubmitted FROM corrections WHERE id = ?", [reopenCorrectionId],
);
assert.ok(closedRow?.closed_at, "closed_at must be set — the cycle-time KPI reads it");
assert.equal(Number(closedRow?.resubmitted), 1, "resubmitted=1 is what every open-correction surface filters on");
const afterMark = db.get<{ status?: string; stage_detail?: string }>(
  "SELECT status, stage_detail FROM projects WHERE id = ?", [reopenId],
);
assert.equal(afterMark?.status, "submitted", "a recorded resubmission returns the project to submitted");
assert.equal(afterMark?.stage_detail, "correction_resubmitted");
assert.equal(
  db.get<{ status?: string }>("SELECT status FROM portal_runs WHERE id = ?", [reopenRunId])?.status,
  "submitted",
  "the reopen run is finished once its resubmission is recorded",
);
ok("marking a reopened correction resubmitted closes it and returns the project to submitted");

// THE MEASURED DEFECT, asserted through the PRODUCTION surface rather than a hand-rolled
// count: syncOperationsPlan's openCorrectionCount is what told the operator to "resolve AHJ
// corrections before resubmittal" on a job that had already been resubmitted.
const planAfterMark = syncOperationsPlan(db, reopenId).steps.find((step) => step.phaseKey === "correction_management");
assert.notEqual(planAfterMark?.status, "blocked", "MUST-EXCLUDE: a reopened + resubmitted correction must not still be counted open");
assert.equal(planAfterMark?.status, "done");
ok("the open-correction surfaces stop calling a resubmitted job blocked");

// The monitor has to READ the resubmitted filing, not wait out the rest of its window.
const refreshedTarget = db.get<{ next_check_at?: string; last_checked_at?: string }>(
  "SELECT next_check_at, last_checked_at FROM permit_check_targets WHERE id = ?", [reopenTargetId],
);
assert.ok(
  new Date(String(refreshedTarget?.next_check_at)).getTime() <= Date.now() + 1000,
  `next_check_at must be pulled forward to the next sweep, got ${refreshedTarget?.next_check_at}`,
);
assert.notEqual(refreshedTarget?.next_check_at, farFuture, "the 14-day window must not survive a resubmission");
// NOTHING WAS CHECKED. Stamping last_checked_at here would age a reading that never happened.
assert.equal(refreshedTarget?.last_checked_at, farFuture, "a refresh must not claim the filing was read");
assert.equal(
  Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permit_check_targets WHERE project_id = ?", [reopenId])?.n),
  1,
  "the refresh must REUSE the existing target — creating a second one is Round C's seam, not a duplicate here",
);
ok("the resubmitted filing's tracking check is pulled forward, and no duplicate target is created");

// THE TWO DOORS STAY SEPARATE. captureConfirmation stamps a submissions row and, finding no
// awaiting row for an already-filed application, falls back to the newest FAILED staging row —
// blanking its numbers and minting a second 'submitted' submission that resolveCorrection's own
// still-filed check then reads. It must refuse this run type outright.
assert.throws(
  () => captureConfirmation(db, reopenRunId, { applicationNumber: "APP-777001" }),
  /correction-reopen run/i,
  "captureConfirmation must refuse a correction_reopen run",
);
assert.throws(
  () => markCorrectionResubmitted(db, "run-hist", {}),
  /not a correction reopen/i,
  "mark-resubmitted must refuse a run that is not a correction reopen",
);
assert.throws(
  () => markCorrectionResubmitted(db, reopenRunId, {}),
  /already been recorded/i,
  "a second mark-resubmitted on the same run must refuse, not close a later correction",
);
ok("capture-confirmation and mark-resubmitted each refuse the other's run type");

console.log(`\ncorrectionResubmit: all ${passed} checks passed`);
db.close();
