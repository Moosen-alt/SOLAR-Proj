// ONE CLEARING BURST, ONE RESUME — AND ONLY FOR A CHAIN SOMEBODY STARTED.
//
// Production, 2026-09-21: one upload burst on one project fired three clearing events in the
// same tick. maybeResumeAutopilot checked "is an autopilot job pending/running?" synchronously
// but enqueued after an async import(), so all three passed the check and three Segment A runs
// started live portal browsers on the same project at the same moment. Two later failed as
// "portal run was interrupted", which then poisoned every later resume on that project.
//
// Pinned here:
//   (1) three back-to-back resumes on a blocked project -> exactly ONE new pending job;
//   (3) Segment A re-checks trackAlreadyStaged at the moment of staging, not only at start;
//   (4) Segment A refuses a project an operator set to 'blocked' (code operator_blocked),
//       and such a run is never auto-resumed;
//   (5) a resume carries the chain's ORIGIN forward and refuses a chain with no origin; an
//       auto_start chain resumes only while AUTOPILOT_AUTO_START=1.
//
// Browser-free, offline (PORTAL_AUTOMATION=off, no API key). Run:
//   tsx backend/test/autopilotResumeConcurrency.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-resume-concurrency-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.ANTHROPIC_API_KEY = "";
process.env.PORTAL_AUTOMATION = "off";
process.env.AUTO_STAGE_STEPS = "0";
// Projects are created with auto-start OFF so createProject enqueues no autopilot job of its
// own (a stray pending row would make the dedupe test pass for the wrong reason).
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { createProject } = await import("../src/repository");
const { maybeResumeAutopilot, runAutopilotSegmentA } = await import("../src/autopilot");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const checkAsync = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

type Row = Record<string, unknown>;
let seq = 0;
// SELF-CONTAINED: whatever createProject's auto-start default is (it has changed before), the
// project is created with auto-start forced OFF, and any autopilot row its creation left is
// cleared — each scenario below seeds exactly the chain it is about. Callers flush() before
// seeding so a deferred enqueue cannot land after the clear.
const mkProject = (status = "parsed"): string => {
  const prior = process.env.AUTOPILOT_AUTO_START;
  process.env.AUTOPILOT_AUTO_START = "0";
  let id: string;
  try {
    id = createProject(db, {
      owner: `Concurrency Test ${++seq}`, address: `${seq} Race Way`, city: "Portland", state: "OR", zip: "97201",
      ahj: "City of Portland", utility: "PGE", dcKw: "6.0",
    } as never).project.id;
  } finally {
    if (prior === undefined) delete process.env.AUTOPILOT_AUTO_START; else process.env.AUTOPILOT_AUTO_START = prior;
  }
  db.run("UPDATE projects SET status = ? WHERE id = ?", [status, id]);
  return id;
};
const clearAutopilot = (projectId: string): void => {
  db.run("DELETE FROM job_queue WHERE project_id = ? AND job_type = 'autopilot'", [projectId]);
};
const seedJob = (projectId: string, payload: Record<string, unknown>, result: unknown): void => {
  clearAutopilot(projectId);
  db.run(
    `INSERT INTO job_queue (id, project_id, job_type, payload, status, result, created_at, priority, progress, progress_total, retry_count, max_retries, org_id)
     VALUES (?, ?, 'autopilot', ?, 'done', ?, ?, 6, 0, 0, 0, 0, 'default')`,
    [`seed-${projectId}-${seq}`, projectId, JSON.stringify(payload), JSON.stringify(result), new Date(Date.now() - 60_000).toISOString()],
  );
};
const autopilotJobs = (projectId: string): Row[] =>
  db.query<Row>("SELECT id, status, payload FROM job_queue WHERE project_id = ? AND job_type = 'autopilot' ORDER BY created_at", [projectId]);
const pendingAutopilot = (projectId: string): number =>
  autopilotJobs(projectId).filter((j) => j.status === "pending").length;
const gateBlocked = { blocked: true, blockers: [{ code: "missing_document", detail: "x" }] };
const flush = () => new Promise((r) => setTimeout(r, 300));

// From here on the default (unset) is in force: auto-start is opt-in, operator resumes work.
delete process.env.AUTOPILOT_AUTO_START;

// ---------------------------------------------------------------------------
// (1) THE REGRESSION: one burst, three clearing events, one resume.
// ---------------------------------------------------------------------------
const burst = mkProject();
await flush(); // let any async side effect of createProject settle before we look
seedJob(burst, { origin: "operator" }, gateBlocked);
maybeResumeAutopilot(db, burst, "a document was uploaded");
maybeResumeAutopilot(db, burst, "a document was uploaded");
maybeResumeAutopilot(db, burst, "a document was uploaded");
// Asserted SYNCHRONOUSLY: enqueueJob self-kicks on a setTimeout, so after a flush the job may
// already have run. Right now, nothing has had a chance to run.
check("THE REGRESSION: three back-to-back resumes enqueue exactly ONE new pending job", () => {
  assert.equal(pendingAutopilot(burst), 1, `expected 1 pending autopilot job, saw ${pendingAutopilot(burst)}`);
});
await flush();
check("...and after the event loop turns, still exactly one resumed job exists (seed + 1)", () => {
  assert.equal(autopilotJobs(burst).length, 2, `expected 2 autopilot rows, saw ${autopilotJobs(burst).length}`);
});

// ---------------------------------------------------------------------------
// (5) ORIGIN: a chain with no origin is not resumed; origin is carried forward.
// ---------------------------------------------------------------------------
const noOrigin = mkProject();
await flush();
seedJob(noOrigin, {}, gateBlocked);
maybeResumeAutopilot(db, noOrigin, "a document was uploaded");
check("a blocked chain with NO origin is never resumed (nobody is known to have started it)", () => {
  assert.equal(autopilotJobs(noOrigin).length, 1, "no new job expected");
});

const operatorChain = mkProject();
await flush();
seedJob(operatorChain, { origin: "operator", track: "nem" }, gateBlocked);
maybeResumeAutopilot(db, operatorChain, "a payment was marked paid");
check("an OPERATOR chain resumes with AUTOPILOT_AUTO_START unset, and carries origin + track", () => {
  const jobs = autopilotJobs(operatorChain);
  assert.equal(jobs.length, 2, `expected a resumed job, saw ${jobs.length} rows`);
  const payload = JSON.parse(String(jobs[1].payload));
  assert.equal(payload.origin, "operator");
  assert.equal(payload.track, "nem");
});
check("...and the resume audit names the chain's origin", () => {
  const row = db.get<Row>("SELECT details FROM audit_logs WHERE project_id = ? AND action = 'autopilot.auto_resumed'", [operatorChain]);
  assert.match(String(row?.details), /"origin":"operator"/);
});

const autoChain = mkProject();
await flush();
seedJob(autoChain, { origin: "auto_start" }, gateBlocked);
maybeResumeAutopilot(db, autoChain, "a document was uploaded");
check("an AUTO_START chain is NOT resumed while auto-start is not opted in", () => {
  assert.equal(autopilotJobs(autoChain).length, 1);
});
process.env.AUTOPILOT_AUTO_START = "1";
maybeResumeAutopilot(db, autoChain, "a document was uploaded");
delete process.env.AUTOPILOT_AUTO_START;
check("...and IS resumed when AUTOPILOT_AUTO_START=1, carrying origin auto_start", () => {
  const jobs = autopilotJobs(autoChain);
  assert.equal(jobs.length, 2, `expected a resumed job, saw ${jobs.length} rows`);
  assert.equal(JSON.parse(String(jobs[1].payload)).origin, "auto_start");
});

const killSwitch = mkProject();
await flush();
seedJob(killSwitch, { origin: "operator" }, gateBlocked);
process.env.AUTOPILOT_AUTO_START = "0";
maybeResumeAutopilot(db, killSwitch, "a document was uploaded");
delete process.env.AUTOPILOT_AUTO_START;
check("AUTOPILOT_AUTO_START=0 still stops every resume, operator chains included", () => {
  assert.equal(autopilotJobs(killSwitch).length, 1);
});

// ---------------------------------------------------------------------------
// (4) THE OPERATOR'S BLOCK.
// ---------------------------------------------------------------------------
const opBlocked = mkProject("blocked");
await flush();
await checkAsync("Segment A refuses a project an operator blocked, with code operator_blocked", async () => {
  const seg = await runAutopilotSegmentA(db, opBlocked, "nem");
  assert.equal(seg.blocked, true);
  assert.equal(seg.blockers[0]?.code, "operator_blocked", JSON.stringify(seg.blockers));
});
check("...and nothing started: no segment_a_started audit, status still 'blocked'", () => {
  const started = db.get<Row>("SELECT id FROM audit_logs WHERE project_id = ? AND action = 'autopilot.segment_a_started'", [opBlocked]);
  assert.ok(!started, "no start was audited");
  assert.equal(String(db.get<Row>("SELECT status FROM projects WHERE id = ?", [opBlocked])?.status), "blocked");
});

const wasBlocked = mkProject();
await flush();
seedJob(wasBlocked, { origin: "operator" }, { blocked: true, blockers: [{ code: "operator_blocked", detail: "x" }] });
maybeResumeAutopilot(db, wasBlocked, "a document was uploaded");
check("a run refused by the operator's block is never auto-resumed after the block is lifted", () => {
  assert.equal(autopilotJobs(wasBlocked).length, 1);
});

// ---------------------------------------------------------------------------
// (3) RE-CHECK AT THE MOMENT OF STAGING. The track is NOT staged when Segment A computes its
// work list, and becomes staged (another run reached the portal) before the loop reaches it.
// Deterministic seam: a db view whose first trackAlreadyStaged read returns the real (empty)
// answer and then lands an awaiting_human_submit run for that track.
// ---------------------------------------------------------------------------
const raced = mkProject();
await flush();
let stagedReads = 0;
const STAGED_READ = /FROM portal_runs[\s\S]*'awaiting_human_submit', 'submitted', 'paused_for_human'/;
const racingDb = new Proxy(db, {
  get(target, prop, receiver) {
    if (prop === "get") {
      return (sql: string, params?: unknown[]) => {
        const out = target.get(sql as never, params as never);
        if (STAGED_READ.test(sql) && Array.isArray(params) && params[0] === raced && ++stagedReads === 1) {
          target.run(
            `INSERT INTO portal_runs (id, project_id, portal_profile_id, run_type, status, started_at, error_message,
               human_action_required, screenshots_path, logs_path, result_json, permit_type)
             VALUES (?, ?, NULL, 'prepare_submit', 'awaiting_human_submit', ?, '', 0, '', '', '{}', 'nem')`,
            [`run-other-${raced}`, raced, new Date().toISOString()],
          );
        }
        return out;
      };
    }
    const v = Reflect.get(target, prop, receiver);
    return typeof v === "function" ? v.bind(target) : v;
  },
}) as typeof db;
await checkAsync("a track that reached the portal while the run was under way is NOT re-staged", async () => {
  const seg = await runAutopilotSegmentA(racingDb, raced, "nem");
  assert.ok(stagedReads >= 2, `the loop must re-read the staged state (reads: ${stagedReads})`);
  assert.equal(seg.blocked, true);
  assert.equal(seg.blockers[0]?.code, "not_pre_stage", JSON.stringify(seg.blockers));
  assert.match(seg.message, /while this run was under way/);
});
check("...prepareSubmission was never reached: one portal run (the other one), no gate audit", () => {
  const runs = db.query<Row>("SELECT id FROM portal_runs WHERE project_id = ?", [raced]);
  assert.equal(runs.length, 1, `expected only the other run, saw ${runs.length}`);
  const gate = db.get<Row>("SELECT id FROM audit_logs WHERE project_id = ? AND action = 'autopilot.blocked'", [raced]);
  assert.ok(!gate, "prepareSubmission's gates must not have been consulted for a staged track");
  const skip = db.get<Row>("SELECT id FROM audit_logs WHERE project_id = ? AND action = 'autopilot.track_already_staged'", [raced]);
  assert.ok(skip, "the skip is audited");
});

if (failures) { console.error(`\n${failures} autopilot-resume-concurrency check(s) FAILED.`); process.exit(1); }
console.log("\nAll autopilot-resume-concurrency checks passed.");
process.exit(0);
