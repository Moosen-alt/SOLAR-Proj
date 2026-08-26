// Job watchdog / double-submit guard: a `running` job past the runtime watchdog
// is reclaimed as orphaned — UNLESS it is still in-flight in this process, in
// which case reclaiming it would re-run a live portal submission (double-submit).
// Startup reclaim ignores the in-flight set (fresh process).
//
// PORTAL-EFFECTING jobs (prepare_submission / auto_learn / autopilot) are never
// auto-rerun at all: an interrupted run may already have staged a live application,
// so the watchdog fails them for a human instead of re-queuing, and enqueueJob pins
// their retry budget to 0 no matter what the caller asked for. Run:
//   tsx backend/test/jobWatchdog.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-watchdog-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { enqueueJob, getJob, recoverOrphanedJobs } = await import("../src/jobQueue");
const db = await openDatabase();

let passed = 0;
const ok = (name: string) => { passed++; console.log(`ok   ${name}`); };

// human_review_items FK-references projects, so escalation needs real rows.
const now = new Date().toISOString();
for (const pid of ["proj-orphan", "proj-live", "proj-midrun", "proj-poison", "proj-pin"]) {
  db.run(
    "INSERT INTO projects (id, status, parser_json, created_at, updated_at) VALUES (?, 'parsed', '{}', ?, ?)",
    [pid, now, now],
  );
}

// Helper: put a job into `running` with a started_at well past the 30-min watchdog.
function makeStaleRunning(jobType: "prepare_submission" | "mbox_import" | "folder_scan", projectId: string, maxRetries?: number): string {
  const job = enqueueJob(db, jobType, {}, { projectId, maxRetries });
  const longAgo = new Date(Date.now() - 60 * 60_000).toISOString(); // 1h ago
  db.run("UPDATE job_queue SET status = 'running', started_at = ? WHERE id = ?", [longAgo, job.id]);
  return job.id;
}

// 1) A stale running NON-portal job not in-flight is reclaimed to pending (genuine orphan).
const orphanId = makeStaleRunning("mbox_import", "proj-orphan");
const reclaimed = recoverOrphanedJobs(db, { inFlight: () => false });
assert.equal(reclaimed, 1, "one orphan should be reclaimed");
assert.equal(getJob(db, orphanId)?.status, "pending", "orphan must be re-queued to pending");
ok("stale running job (not in-flight) is reclaimed");

// 2) A stale running job that IS in-flight is NOT reclaimed (double-submit guard).
const liveId = makeStaleRunning("prepare_submission", "proj-live");
const reclaimed2 = recoverOrphanedJobs(db, { inFlight: (id) => id === liveId });
assert.equal(reclaimed2, 0, "an in-flight job must never be reclaimed mid-run");
assert.equal(getJob(db, liveId)?.status, "running", "in-flight job must stay running");
ok("in-flight job is NOT reclaimed mid-run (double-submit guard)");

// 3) Startup reclaim ignores the in-flight set — a fresh process owns nothing — but a
//    stranded PORTAL job is failed for a human, never re-queued: its browser may have
//    already staged a live application before the process died.
const startupReclaimed = recoverOrphanedJobs(db, { startup: true, inFlight: (id) => id === liveId });
assert.ok(startupReclaimed >= 1, "startup reclaim should pick up the stranded row");
const strandedPortal = getJob(db, liveId);
assert.equal(strandedPortal?.status, "failed", "an interrupted portal run must FAIL for a human, not silently re-run");
assert.match(String(strandedPortal?.error), /not auto-rerun/, "the error must say why it was not re-queued");
const reviewItem = db.get<Record<string, unknown>>(
  "SELECT * FROM human_review_items WHERE project_id = 'proj-live' AND status = 'pending'",
);
assert.ok(reviewItem, "the interruption must land in the operator's review queue");
ok("interrupted portal run fails to a human instead of re-running (startup reclaim)");

// 4) Same policy mid-run: a portal job past the watchdog that is NOT in-flight
//    (e.g. its process died while another lives) fails rather than re-queues.
const midRunPortal = makeStaleRunning("prepare_submission", "proj-midrun");
recoverOrphanedJobs(db, { inFlight: () => false });
assert.equal(getJob(db, midRunPortal)?.status, "failed", "mid-run portal orphan must fail, not re-queue");
ok("interrupted portal run fails to a human instead of re-running (mid-run reclaim)");

// 5) Retry budget is respected for ordinary jobs: at the last retry it fails, not re-queues.
const lastTry = makeStaleRunning("folder_scan", "proj-poison", 1);
recoverOrphanedJobs(db, { inFlight: () => false });
assert.equal(getJob(db, lastTry)?.status, "failed", "exhausted-retry orphan must fail, not loop");
ok("exhausted retry budget fails the orphan");

// 6) enqueueJob pins portal-effecting jobs to 0 retries regardless of the caller's ask —
//    the generic /api/jobs route must not be able to give a live browser run a retry timer.
const pinned = enqueueJob(db, "prepare_submission", {}, { projectId: "proj-pin", maxRetries: 3 });
assert.equal(pinned.maxRetries, 0, "portal job maxRetries must be pinned to 0 at enqueue");
const ordinary = enqueueJob(db, "folder_scan", {}, { projectId: "proj-pin", maxRetries: 3 });
assert.equal(ordinary.maxRetries, 3, "non-portal jobs keep their requested budget");
ok("portal-effecting jobs are pinned to maxRetries 0 at enqueue");

console.log(`\njobWatchdog: all ${passed} checks passed`);
