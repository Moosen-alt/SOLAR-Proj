// Job watchdog / double-submit guard: a `running` job past the runtime watchdog
// is reclaimed as orphaned — UNLESS it is still in-flight in this process, in
// which case reclaiming it would re-run a live portal submission (double-submit).
// Startup reclaim ignores the in-flight set (fresh process). Run:
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

// Helper: put a job into `running` with a started_at well past the 30-min watchdog.
function makeStaleRunning(projectId: string): string {
  const job = enqueueJob(db, "prepare_submission", { track: "permit" }, { projectId });
  const longAgo = new Date(Date.now() - 60 * 60_000).toISOString(); // 1h ago
  db.run("UPDATE job_queue SET status = 'running', started_at = ? WHERE id = ?", [longAgo, job.id]);
  return job.id;
}

// 1) A stale running job NOT in-flight is reclaimed to pending (genuine orphan).
const orphanId = makeStaleRunning("proj-orphan");
const reclaimed = recoverOrphanedJobs(db, { inFlight: () => false });
assert.equal(reclaimed, 1, "one orphan should be reclaimed");
assert.equal(getJob(db, orphanId)?.status, "pending", "orphan must be re-queued to pending");
ok("stale running job (not in-flight) is reclaimed");

// 2) A stale running job that IS in-flight is NOT reclaimed (double-submit guard).
const liveId = makeStaleRunning("proj-live");
const reclaimed2 = recoverOrphanedJobs(db, { inFlight: (id) => id === liveId });
assert.equal(reclaimed2, 0, "an in-flight job must never be reclaimed mid-run");
assert.equal(getJob(db, liveId)?.status, "running", "in-flight job must stay running");
ok("in-flight job is NOT reclaimed mid-run (double-submit guard)");

// 3) Startup reclaim ignores the in-flight set — a fresh process owns nothing,
//    so every stranded `running` row (incl. the one above) is reclaimed.
const startupReclaimed = recoverOrphanedJobs(db, { startup: true, inFlight: (id) => id === liveId });
assert.ok(startupReclaimed >= 1, "startup reclaim should pick up the stranded row");
assert.equal(getJob(db, liveId)?.status, "pending", "startup reclaim ignores in-flight and re-queues");
ok("startup reclaim ignores in-flight set");

// 4) Retry budget is respected: a job at its last retry is failed, not re-queued.
const lastTry = enqueueJob(db, "prepare_submission", {}, { projectId: "proj-poison", maxRetries: 1 });
db.run("UPDATE job_queue SET status = 'running', started_at = ?, retry_count = 0 WHERE id = ?",
  [new Date(Date.now() - 60 * 60_000).toISOString(), lastTry.id]);
recoverOrphanedJobs(db, { inFlight: () => false });
assert.equal(getJob(db, lastTry.id)?.status, "failed", "exhausted-retry orphan must fail, not loop");
ok("exhausted retry budget fails the orphan");

console.log(`\njobWatchdog: all ${passed} checks passed`);
