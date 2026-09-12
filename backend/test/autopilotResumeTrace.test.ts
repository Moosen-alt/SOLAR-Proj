// AN AUTONOMOUS RUN THAT CANNOT EXPLAIN ITSELF LOOKS LIKE A BUG.
//
// The report was "I never clicked the autopilot button" — and that was true. What had
// happened was correct by design: an earlier autopilot run stopped on a gate, a document was
// then uploaded to the project, and the event-driven resume relaunched Segment A because the
// upload might have cleared the blocker. Careful design, working exactly as intended.
//
// But it left no trace an operator could read. The only record was a server log line, so the
// project showed a run nobody started, with no cause. Explaining it needed a code read.
//
// The resume rules themselves are deliberately narrow and are pinned here too, because they
// are what make the autonomy safe: only a run that ended BLOCKED is resumed, a failed run is
// never silently relaunched, and a stage that failed or paused mid-run is never re-driven
// (that would start a second live browser against a portal already sitting at an MFA prompt).
//
// Browser-free. Run: tsx backend/test/autopilotResumeTrace.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-resume-trace-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.ANTHROPIC_API_KEY = "";
process.env.AUTOPILOT_AUTO_START = "1";

const { openDatabase } = await import("../src/db");
const { createProject } = await import("../src/repository");
const { maybeResumeAutopilot } = await import("../src/autopilot");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const mkProject = (): string => createProject(db, {
  owner: "Resume Test", address: "1 Trace Way", city: "Portland", state: "OR", zip: "97201",
  ahj: "City of Portland", utility: "PGE", dcKw: "6.0",
} as never).project.id;

const seedJob = (projectId: string, result: unknown, status = "done"): void => {
  db.run("DELETE FROM job_queue WHERE project_id = ? AND job_type = 'autopilot'", [projectId]);
  db.run(
    `INSERT INTO job_queue (id, project_id, job_type, payload, status, result, created_at)
     VALUES (?, ?, 'autopilot', '{}', ?, ?, ?)`,
    // THE ID IS THE PROJECT'S OWN, not a hash of it. This used to be the SUM of the
    // project id's character codes — which is order-insensitive, so any two generated
    // UUIDs that are character-anagrams of each other produced the SAME job id and the
    // insert died on "UNIQUE constraint failed: job_queue.id". The DELETE above could not
    // save it either: it clears this project's jobs, and the colliding row belongs to a
    // different project. Measured once in a full-chain run, which then stopped there and
    // silently skipped every suite after it.
    [`job-${projectId}-${status}`, projectId, status, JSON.stringify(result), new Date().toISOString()],
  );
};

const resumeAudits = (projectId: string): Array<{ details?: string }> =>
  db.query<{ details?: string }>(
    "SELECT details FROM audit_logs WHERE project_id = ? AND action = 'autopilot.auto_resumed'", [projectId],
  );

// ---------------------------------------------------------------------------
// The regression: a resume must say what triggered it.
// ---------------------------------------------------------------------------
const blocked = mkProject();
db.run("UPDATE projects SET status = 'parsed' WHERE id = ?", [blocked]);
seedJob(blocked, { blocked: true, blockers: [{ code: "missing_document" }] });
maybeResumeAutopilot(db, blocked, "a document was uploaded");
// The enqueue and its audit entry happen inside a dynamic import() — repository statically
// imports jobQueue, so anything reaching back the other way must defer (the circular-import
// guard). Let that settle before asserting.
await new Promise((r) => setTimeout(r, 200));

check("THE REGRESSION: the auto-resume writes an audit entry naming its trigger", () => {
  const rows = resumeAudits(blocked);
  assert.equal(rows.length, 1, "expected exactly one autopilot.auto_resumed audit entry");
  assert.match(String(rows[0].details), /a document was uploaded/);
});

check("...and says WHY a resume was possible, not just that one happened", () => {
  assert.match(String(resumeAudits(blocked)[0].details), /stopped on a gate/i);
});

check("...and a fresh Segment A job really was enqueued alongside the original", () => {
  // Not asserted as 'pending': enqueueJob self-kicks, so by now the queue may already have
  // run it (and re-blocked, which is the documented harmless outcome of a premature resume).
  // What matters is that a SECOND autopilot job now exists beyond the seeded one.
  const jobs = db.query<{ id: string; status?: string }>(
    "SELECT id, status FROM job_queue WHERE project_id = ? AND job_type = 'autopilot'", [blocked],
  );
  assert.ok(jobs.length >= 2, `expected the seeded job plus a resumed one, saw ${jobs.length}`);
});

check("the resumed job carries the trigger in its payload, not just the audit log", () => {
  const rows = db.query<{ payload?: string }>(
    "SELECT payload FROM job_queue WHERE project_id = ? AND job_type = 'autopilot' AND payload LIKE '%resumeTrigger%'", [blocked],
  );
  assert.ok(rows.length >= 1, "the run itself should know why it exists");
  assert.match(String(rows[0].payload), /a document was uploaded/);
});

// ---------------------------------------------------------------------------
// The narrow rules that make the autonomy safe.
// ---------------------------------------------------------------------------
const notBlocked = mkProject();
db.run("UPDATE projects SET status = 'parsed' WHERE id = ?", [notBlocked]);
seedJob(notBlocked, { blocked: false, blockers: [], message: "Staged; awaiting approval." });
maybeResumeAutopilot(db, notBlocked, "a document was uploaded");

check("a run that did NOT end blocked is never resumed", () => {
  assert.equal(resumeAudits(notBlocked).length, 0);
});

const failed = mkProject();
db.run("UPDATE projects SET status = 'parsed' WHERE id = ?", [failed]);
seedJob(failed, { blocked: true, blockers: [{ code: "stage_failed" }] });
maybeResumeAutopilot(db, failed, "a document was uploaded");

check("a stage that FAILED mid-run is never re-driven — that needs a person", () => {
  assert.equal(resumeAudits(failed).length, 0);
});

const paused = mkProject();
db.run("UPDATE projects SET status = 'parsed' WHERE id = ?", [paused]);
seedJob(paused, { blocked: true, blockers: [{ code: "paused_for_human" }] });
maybeResumeAutopilot(db, paused, "a document was uploaded");

check("a run PAUSED at an MFA/CAPTCHA challenge is never relaunched into a second browser", () => {
  assert.equal(resumeAudits(paused).length, 0);
});

const never = mkProject();
db.run("UPDATE projects SET status = 'parsed' WHERE id = ?", [never]);
db.run("DELETE FROM job_queue WHERE project_id = ? AND job_type = 'autopilot'", [never]);
maybeResumeAutopilot(db, never, "a document was uploaded");

check("a project whose autopilot was NEVER started is not started by an upload", () => {
  // This is the heart of "I never clicked the button": a clearing event resumes work the
  // operator began, it does not begin work on its own.
  assert.equal(resumeAudits(never).length, 0);
});

const submitted = mkProject();
db.run("UPDATE projects SET status = 'awaiting_human_submit' WHERE id = ?", [submitted]);
seedJob(submitted, { blocked: true, blockers: [{ code: "missing_document" }] });
maybeResumeAutopilot(db, submitted, "a document was uploaded");

check("a project at the human approval gate is never resumed past it", () => {
  assert.equal(resumeAudits(submitted).length, 0);
});

// ---------------------------------------------------------------------------
// The global off switch still wins.
// ---------------------------------------------------------------------------
const offSwitch = mkProject();
db.run("UPDATE projects SET status = 'parsed' WHERE id = ?", [offSwitch]);
seedJob(offSwitch, { blocked: true, blockers: [{ code: "missing_document" }] });
process.env.AUTOPILOT_AUTO_START = "0";
maybeResumeAutopilot(db, offSwitch, "a document was uploaded");
process.env.AUTOPILOT_AUTO_START = "1";

check("AUTOPILOT_AUTO_START=0 stops the resume entirely", () => {
  assert.equal(resumeAudits(offSwitch).length, 0);
});

if (failures) { console.error(`\n${failures} autopilot-resume-trace check(s) FAILED.`); process.exit(1); }
console.log("\nAll autopilot-resume-trace checks passed.");
process.exit(0);
