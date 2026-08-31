// STRESS TEST for the concurrent job drain.
//
// The drain used to be strictly serial, which made the job claim's correctness moot. Now
// that JOB_CONCURRENCY can exceed 1, the claim is load-bearing: if two concurrent callers
// could both believe they won the same row, the app would run the same job twice — and
// these jobs stage real filings to live portals, which is not an idempotent thing to do
// twice.
//
// The detection is structural rather than a spy: with N queued jobs and N concurrent
// workers, every job must end 'done'. If two workers ever claimed the SAME row, one row
// would go unclaimed and be left 'pending' — so a full sweep with nothing left behind is
// proof that every claim went to exactly one caller.
//
// Browser-free. Run: tsx backend/test/jobConcurrency.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-concurrency-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
// Drive the drain hard: more concurrency than jobs, and a tick budget big enough to take
// the whole queue in one pass.
process.env.JOB_CONCURRENCY = "8";
process.env.MAX_JOBS_PER_TICK = "100";

const { openDatabase } = await import("../src/db");
const { enqueueJob, drainPendingJobs, processNextJob } = await import("../src/jobQueue");
const db = await openDatabase();

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

const counts = () => ({
  pending: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_queue WHERE status = 'pending'")?.n ?? 0,
  running: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_queue WHERE status = 'running'")?.n ?? 0,
  done: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_queue WHERE status = 'done'")?.n ?? 0,
  failed: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_queue WHERE status = 'failed'")?.n ?? 0,
});

// "stress_noop" is not a known job type, so the dispatcher's final else marks it done
// without side effects — the queue mechanics are what is under test, not a handler.
const QUEUE_SIZE = 40;
for (let i = 0; i < QUEUE_SIZE; i++) {
  enqueueJob(db, "stress_noop" as never, { i }, { priority: (i % 3) + 4, maxRetries: 0 });
}
const before = counts();
check(`queued ${QUEUE_SIZE} jobs`, before.pending === QUEUE_SIZE, JSON.stringify(before));

const started = Date.now();
const processed = await drainPendingJobs(db);
const after = counts();

check("every queued job reached 'done'", after.done === QUEUE_SIZE, JSON.stringify(after));
check("nothing was left pending — no row was claimed by two workers at once", after.pending === 0, JSON.stringify(after));
check("nothing was left stuck in 'running'", after.running === 0, JSON.stringify(after));
check("no job failed", after.failed === 0, JSON.stringify(after));
check("the drain reported what it actually completed", processed === QUEUE_SIZE, `reported ${processed} of ${QUEUE_SIZE}`);
console.log(`         (drained ${QUEUE_SIZE} jobs in ${Date.now() - started}ms at JOB_CONCURRENCY=${process.env.JOB_CONCURRENCY})`);

// A SECOND drain over an empty queue must be a clean no-op, not a hang or an error — the
// worker tick calls this every 30s forever.
const empty = await drainPendingJobs(db);
check("draining an empty queue is a no-op", empty === 0, `reported ${empty}`);

// OVERLAPPING DRAINS. The worker tick and an enqueue kick can both fire; drainBusy exists
// to stop them stacking. Prove that (a) they do not double-process, and (b) drainBusy is
// released afterwards so the queue keeps draining forever.
for (let i = 0; i < 12; i++) enqueueJob(db, "stress_noop" as never, { i }, { maxRetries: 0 });
const [d1, d2] = await Promise.all([drainPendingJobs(db), drainPendingJobs(db)]);
const afterOverlap = counts();
check("two overlapping drains process each job exactly once", d1 + d2 === 12, `${d1} + ${d2}`);
check("overlapping drains leave nothing pending", afterOverlap.pending === 0, JSON.stringify(afterOverlap));

for (let i = 0; i < 3; i++) enqueueJob(db, "stress_noop" as never, { i }, { maxRetries: 0 });
const afterBusy = await drainPendingJobs(db);
check("drainBusy is released — a later drain still works", afterBusy === 3, `reported ${afterBusy}`);

// Direct concurrent processNextJob calls (the enqueue-kick path) must also each take a
// different job.
for (let i = 0; i < 6; i++) enqueueJob(db, "stress_noop" as never, { i }, { maxRetries: 0 });
const results = await Promise.all(Array.from({ length: 6 }, () => processNextJob(db)));
const claimed = results.filter(Boolean).length;
const afterDirect = counts();
check("6 concurrent processNextJob calls claim 6 DIFFERENT jobs", claimed === 6 && afterDirect.pending === 0,
  `claimed=${claimed} ${JSON.stringify(afterDirect)}`);

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} job-concurrency check(s) FAILED.`); process.exit(1); }
console.log("\nAll job-concurrency stress checks passed.");
process.exit(0);
