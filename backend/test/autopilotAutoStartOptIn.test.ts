// LIVE STAGING IS A PERSON'S ACTION UNLESS SOMEONE OPTED IN (LNK-2).
//
// createProject used to enqueue an autopilot Segment A job — a LIVE portal browser under the
// operator's credentials — on every new project unless AUTOPILOT_AUTO_START=0. The operator's
// stated contract (autoStageSteps.ts header, 2026-09-21) is the opposite: the local chain stops
// at ready_to_stage and staging waits for a person. Production had unattended live portal runs.
// Auto-start is now OPT-IN: only AUTOPILOT_AUTO_START === "1" enqueues it.
//
//   npx tsx backend/test/autopilotAutoStartOptIn.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-autostart-optin-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
// The opt-in run below must never reach a real portal: mock adapter, nothing outbound.
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
delete process.env.PORTAL_AUTOMATION;
process.env.CLIENT_NOTIFICATIONS = "off";
process.env.BACKGROUND_WORKERS = "off";
process.env.DOCUMENT_FETCH = "off";
process.env.DOCUMENT_FETCH_BROWSER = "0";
process.env.AHJ_FORM_DOWNLOADS = "off";
process.env.AHJ_FORM_RESEARCH = "off";
process.env.FEE_RESEARCH = "off";
process.env.PORTAL_URL_RESEARCH = "off";
process.env.RUN_TRIAGE = "off";
process.env.AUTO_RELEARN_STALE = "0";
process.env.PORTAL_ALLOW_FINAL_SUBMIT = "false";
delete process.env.SMTP_HOST;
delete process.env.ANTHROPIC_API_KEY;
// THE CASE UNDER TEST: the variable is simply not set, as on a default install.
delete process.env.AUTOPILOT_AUTO_START;

const { openDatabase } = await import("../src/db");
const { createProject } = await import("../src/repository");
const db = await openDatabase();

let failures = 0;
let passed = 0;
const check = (label: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const autopilotJobs = (pid: string): { payload: string }[] =>
  db.query<{ payload: string }>("SELECT payload FROM job_queue WHERE project_id = ? AND job_type = 'autopilot'", [pid]);
// The enqueue sits behind a dynamic import() — give it time to land, or a count of zero would
// prove nothing (it would read zero with the old default-ON code too).
const flush = () => new Promise((r) => setTimeout(r, 500));
// A bare project: QC fails, so even the opt-in Segment A (which the worker self-kicks) blocks
// on its gates long before any portal.
const bare = (owner: string) => createProject(db, {
  owner, address: "1 Opt In Way", city: "Portland", state: "OR", zip: "97201",
  ahj: "City of Portland", utility: "PGE", dcKw: "6.0",
} as never).project.id;

try {
  const unset = bare("Default Install Owner");
  await flush();
  check("AUTOPILOT_AUTO_START unset: creating a project enqueues NO autopilot (live staging) job", () => {
    assert.equal(autopilotJobs(unset).length, 0, "a new project started a live staging run nobody asked for");
  });

  process.env.AUTOPILOT_AUTO_START = "0";
  const off = bare("Explicitly Off Owner");
  await flush();
  check("AUTOPILOT_AUTO_START=0: still no autopilot job", () => {
    assert.equal(autopilotJobs(off).length, 0);
  });

  process.env.AUTOPILOT_AUTO_START = "1";
  const optedIn = bare("Opted In Owner");
  await flush();
  check("MUST PASS: AUTOPILOT_AUTO_START=1 opts in — exactly one autopilot job, tagged origin auto_start", () => {
    const jobs = autopilotJobs(optedIn);
    assert.equal(jobs.length, 1, "the opt-in no longer starts autopilot");
    assert.equal(JSON.parse(jobs[0].payload).origin, "auto_start", "the chain's root must say no person started it");
  });
  // Stop the opt-in from spreading to anything the kicked worker does next.
  process.env.AUTOPILOT_AUTO_START = "0";
  // The self-kicked worker runs the opted-in Segment A, which builds the packet en route and
  // writes filled forms under the cwd-relative backend/data/filled/<projectId>. Let it settle,
  // then remove what it wrote so nothing is left in the repo.
  const settleBy = Date.now() + 20_000;
  while (Date.now() < settleBy && Number(db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM job_queue WHERE job_type = 'autopilot' AND status IN ('pending','running')",
  )?.n ?? 0) > 0) await flush();
  for (const pid of [unset, off, optedIn]) {
    try { fs.rmSync(path.resolve(process.cwd(), "backend/data/filled", pid), { recursive: true, force: true }); } catch { /* best effort */ }
  }
} finally {
  console.log(failures ? `\nautopilotAutoStartOptIn: ${failures} check(s) FAILED, ${passed} passed` : `\nautopilotAutoStartOptIn: all ${passed} checks passed`);
  try { db.close(); } catch { /* the kicked worker may still hold the handle */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* leave to the OS */ }
}
process.exit(failures ? 1 : 0);
