// ONE PROJECT, ONE PORTAL EFFECT AT A TIME — ENFORCED AT THE CLAIM.
//
// Production, 2026-09-21: three autopilot jobs for one project were claimed by three worker
// slots and drove three live Segment A runs at once. Deduping each ENQUEUE path is necessary
// but not sufficient: /autopilot/start can race a resume, and a manual Stage
// (prepare_submission) or "Learn this portal" (auto_learn) can race either. So the claim
// itself refuses a pending portal-effect job whose project already has a RUNNING
// portal-effect job, and refuses a second concurrent stage_step chain on one project. The
// refused job stays PENDING and is claimed once the project frees.
//
// Drives claimNextJob directly (the synchronous claim processNextJob uses), with
// JOB_CONCURRENCY>1 so the scenario is the one where several slots claim back to back.
// Browser-free. Run: tsx backend/test/jobClaimProjectBusy.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-claim-busy-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.ANTHROPIC_API_KEY = "";
process.env.JOB_CONCURRENCY = "4";

const { openDatabase } = await import("../src/db");
const { claimNextJob } = await import("../src/jobQueue");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

type Row = Record<string, unknown>;
const now = Date.now();
let n = 0;
// Rows inserted directly (not through enqueueJob) ON PURPOSE: enqueueJob's instant kick would
// run a drain and the handlers, and this test is about the claim alone. The columns are the
// ones enqueueJob writes.
const job = (id: string, jobType: string, projectId: string | null, status: string, priority = 5): void => {
  db.run(
    `INSERT INTO job_queue (id, job_type, payload, status, priority, project_id, created_at, started_at,
       progress, progress_total, retry_count, max_retries, org_id)
     VALUES (?, ?, '{}', ?, ?, ?, ?, ?, 0, 0, 0, 0, 'default')`,
    [id, jobType, status, priority, projectId, new Date(now + (n++) * 10).toISOString(), status === "running" ? new Date(now).toISOString() : null],
  );
};
const statusOf = (id: string): string => String(db.get<Row>("SELECT status FROM job_queue WHERE id = ?", [id])?.status);
const claimAll = (): string[] => {
  const out: string[] = [];
  for (let i = 0; i < 10; i++) { const j = claimNextJob(db); if (!j) break; out.push(j.id); }
  return out;
};

// ---------------------------------------------------------------------------
// Portal-effect types: autopilot, prepare_submission, auto_learn.
// ---------------------------------------------------------------------------
job("P-running-autopilot", "autopilot", "proj-P", "running");
// Higher priority than everything else on purpose: a waiting job must not hide lower ones.
job("P-pending-stage", "prepare_submission", "proj-P", "pending", 9);
job("P-pending-autopilot", "autopilot", "proj-P", "pending", 9);
job("P-pending-learn", "auto_learn", "proj-P", "pending", 9);
job("P-pending-local", "code_research", "proj-P", "pending", 3);
job("Q-pending-autopilot", "autopilot", "proj-Q", "pending", 5);
job("noproj-pending", "stress_noop", null, "pending", 1);

const firstWave = claimAll();
check("no portal-effect job is claimed for a project that already has one RUNNING", () => {
  for (const id of ["P-pending-stage", "P-pending-autopilot", "P-pending-learn"]) {
    assert.equal(statusOf(id), "pending", `${id} was claimed (${statusOf(id)}) while P's autopilot runs`);
  }
});
check("...while other projects' portal jobs, P's non-portal work and project-less jobs still run", () => {
  assert.deepEqual([...firstWave].sort(), ["P-pending-local", "Q-pending-autopilot", "noproj-pending"].sort());
});
check("...and a blocked high-priority job does not hide the lower-priority runnable ones", () => {
  assert.ok(firstWave.includes("Q-pending-autopilot"));
});

// Two concurrent slots: with P's run still going and Q's run now RUNNING too, a second
// pending autopilot for Q must wait as well — the claim sees the row it just marked running.
job("Q-pending-autopilot-2", "autopilot", "proj-Q", "pending", 9);
check("a job claimed a moment ago counts as running for the next claim (back-to-back slots)", () => {
  assert.equal(claimNextJob(db), null);
  assert.equal(statusOf("Q-pending-autopilot-2"), "pending");
});

// The project frees: exactly ONE of P's waiting portal jobs is claimed, never two.
db.run("UPDATE job_queue SET status = 'done' WHERE id = 'P-running-autopilot'");
const secondWave = claimAll();
check("once the project frees, exactly one of its waiting portal jobs is claimed", () => {
  const pClaimed = secondWave.filter((id) => id.startsWith("P-"));
  assert.equal(pClaimed.length, 1, `claimed ${JSON.stringify(secondWave)}`);
  const stillPending = ["P-pending-stage", "P-pending-autopilot", "P-pending-learn"].filter((id) => statusOf(id) === "pending");
  assert.equal(stillPending.length, 2);
});

// ---------------------------------------------------------------------------
// stage_step: one local chain per project at a time.
// ---------------------------------------------------------------------------
job("S-running-chain", "stage_step", "proj-S", "running");
job("S-pending-chain", "stage_step", "proj-S", "pending", 9);
job("T-pending-chain", "stage_step", "proj-T", "pending", 4);
const chainWave = claimAll();
check("a second stage_step chain on the same project waits while the first runs", () => {
  assert.equal(statusOf("S-pending-chain"), "pending");
  assert.ok(chainWave.includes("T-pending-chain"), `claimed ${JSON.stringify(chainWave)}`);
});
db.run("UPDATE job_queue SET status = 'done' WHERE id = 'S-running-chain'");
check("...and is claimed once the first finishes", () => {
  assert.equal(claimNextJob(db)?.id, "S-pending-chain");
});

if (failures) { console.error(`\n${failures} job-claim-busy check(s) FAILED.`); process.exit(1); }
console.log("\nAll job-claim-busy checks passed.");
process.exit(0);
