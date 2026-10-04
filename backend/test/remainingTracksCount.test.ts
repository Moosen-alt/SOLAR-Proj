// "ARE ALL TRACKS IN?" IS A QUESTION ABOUT TRACKS, NOT ABOUT ROWS.
//
// Re-staging a track APPENDS another awaiting_human_submit submission row rather than
// superseding the previous one. Measured on the live database: Drew Example
// (720b05f3) carries 5 such rows for 2 real tracks — 4x interconnection/nem plus
// 1x permit/building — and Blake Fixture (cf1c56aa) carries 9 rows for a single nem track.
//
// Both captureConfirmation and markCorrectionResubmitted gate on "no OTHER track still
// awaits a human submit". Counting ROWS made that gate unsatisfiable on every project
// that had ever been re-staged: the correction closer waited forever on filings that do
// not exist, and the board never advanced.
//
// This pins the rule at the seam an operator actually feels it: the closer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "track-count-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { createProject, addManualCorrection, markCorrectionResubmitted, getProjectDetail } =
  await import("../src/repository");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`ok   ${label}`); return; }
  failures += 1;
  console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

const db = await openDatabase();

const project = createProject(db, {
  homeownerName: "Retry Restage", projectAddress: "1 Retry Way", city: "Coos Bay",
  state: "OR", zip: "97420", ahj: "City of Coos Bay", utility: "Pacific Power",
  systemSizeDcKw: 3.52, systemSizeAcKw: 3.072,
} as never).project.id;

// IVY'S EXACT SHAPE: one nem track staged four times, one building track staged once.
// Every row is a legitimate product of re-staging — none of them is corrupt, and none
// may be deleted to make the arithmetic work.
const stage = (n: number, type: string, permitType: string, at: string): void => {
  db.run(
    "INSERT INTO submissions (id, project_id, submission_type, status, permit_type, created_at) VALUES (?, ?, ?, 'awaiting_human_submit', ?, ?)",
    [`sub-${n}`, project, type, permitType, at],
  );
};
stage(1, "interconnection", "nem", "2026-09-01T18:55:59.367Z");
stage(2, "permit", "building", "2026-09-01T21:26:36.352Z");
stage(3, "interconnection", "nem", "2026-09-01T23:14:35.105Z");
stage(4, "interconnection", "nem", "2026-09-02T00:17:32.119Z");
stage(5, "interconnection", "nem", "2026-09-02T00:26:14.543Z");

const rows = db.query<{ id: string }>(
  "SELECT id FROM submissions WHERE project_id = ? AND status = 'awaiting_human_submit'", [project],
).length;
const tracks = db.query<{ n: number }>(
  "SELECT COUNT(*) AS n FROM (SELECT DISTINCT submission_type, COALESCE(permit_type,'') FROM submissions WHERE project_id = ? AND status = 'awaiting_human_submit')",
  [project],
)[0]?.n;
check("1a. PRECONDITION: 5 rows but only 2 real tracks — the live shape, reproduced",
  rows === 5 && Number(tracks) === 2, `rows=${rows} tracks=${tracks}`);

// Retire both tracks the way a real submission does, leaving ZERO tracks outstanding
// while FOUR superseded rows remain on file.
db.run("UPDATE submissions SET status = 'submitted' WHERE id IN ('sub-5','sub-2')", []);
const rowsLeft = db.query<{ id: string }>(
  "SELECT id FROM submissions WHERE project_id = ? AND status = 'awaiting_human_submit'", [project],
).length;
check("1b. three superseded rows still sit at awaiting_human_submit — they are history, not garbage",
  rowsLeft === 3, `rowsLeft=${rowsLeft}`);

addManualCorrection(db, project, "AHJ asks for a revised single-line.", "manual");
const correctionId = String(
  (db.get<{ id: string }>("SELECT id FROM corrections WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", [project]))?.id,
);
db.run("UPDATE projects SET status = 'awaiting_human_resubmit' WHERE id = ?", [project]);
const runId = `run-${project}`;
db.run(
  "INSERT INTO portal_runs (id, project_id, run_type, status, started_at, result_json) VALUES (?, ?, 'correction_reopen', 'awaiting_human_resubmit', ?, ?)",
  [runId, project, new Date().toISOString(), JSON.stringify({ correctionId })],
);

const out = markCorrectionResubmitted(db, runId, { submittedBy: "operator" });
check("2a. the closer sees ZERO tracks outstanding — the superseded rows do not count",
  out.remainingTracks === 0, `remainingTracks=${out.remainingTracks}`);
check("2b. so the correction actually CLOSES instead of waiting on a filing that does not exist",
  out.closedCorrections === 1, JSON.stringify(out).slice(0, 140));
check("2c. and the board advances",
  getProjectDetail(db, project).project.status === "submitted",
  String(getProjectDetail(db, project).project.status));

console.log(failures ? `\nremainingTracksCount: ${failures} check(s) FAILED` : "\nremainingTracksCount: all checks passed");
db.close();
fs.rmSync(dir, { recursive: true, force: true });
if (failures) process.exit(1);
