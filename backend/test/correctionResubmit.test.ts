// CORRECTION FLOW MUST HAVE AN EXIT. correction_received / correction_triaged are not
// pre-stage statuses, so autopilot (and its execution-time re-stage guard) refuses to
// touch a project sitting in them — and closing a correction used to leave the status
// untouched, stranding the project there forever (the declared ready_to_resubmit leg
// was never implemented). Resolving the LAST open correction now returns the project
// to "parsed" so the normal QC → gates → stage path can run again.
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
process.env.SEED_TEST_INSTALLER = "false";
process.env.ANTHROPIC_API_KEY = ""; // regex classifier only — no agent job
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { createProject, addManualCorrection, resolveCorrection } = await import("../src/repository");
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

// 2) Resolving the last open correction returns the project to a PRE-STAGE status —
//    the fix for the dead-end. "parsed" re-enters the normal QC → gates → stage path.
resolveCorrection(db, correctionId, { resubmitted: false });
const row = db.get<{ status?: string; current_stage?: string }>("SELECT status, current_stage FROM projects WHERE id = ?", [projectId]);
assert.equal(row?.status, "parsed", "project must leave the correction state when its last correction closes");
assert.match(String(row?.current_stage), /ready to re-stage/i);
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
  "parsed",
  "closing the LAST open correction releases the project",
);
ok("the project is released only when the last open correction closes");

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

console.log(`\ncorrectionResubmit: all ${passed} checks passed`);
