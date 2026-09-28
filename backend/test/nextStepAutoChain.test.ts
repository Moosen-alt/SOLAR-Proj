// THE AUTOMATIC CHAIN IS AUTOMATION RUNNING (operator 2026-09-28, a real Newberg job).
//
// The project page said "Blocked — Site / plot plan … attach it or split it out of the plan set;
// Electrical one-line …; PV module spec sheet …; Prescriptive solar permit application — find the
// official form" and the operator asked "can we just not have it do this automatically?". It was:
// the stage_step chain splits the plan set, reads the bill, runs QC and finds/fills the official
// forms, and it was still running. While a FRESH chain job is queued or running, the next step is
// automation_running with the chain's own wording; a STALE one (stuck behind a dead worker) never
// hides the real blockers.
//
//   npx tsx backend/test/nextStepAutoChain.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nextstep-autochain-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.BACKUP_DIR = path.join(tmp, "backups");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const { computeNextStep, AUTO_CHAIN_FRESH_MS } = await import("../src/nextStep");
const { enqueueJob } = await import("../src/jobQueue");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const newProject = (owner: string): string => R.createProject(db, {
  owner, state: "OR", dcKw: "8.6", acKw: "5.8", permitPath: "prescriptive",
  street: "100 Example St", city: "Newberg", zip: "97132", ahj: "City of Newberg", utility: "Portland General Electric",
} as never).project.id;
const step = async (pid: string) => (await computeNextStep(db, R.getProjectDetail(db, pid).project));

const pid = newProject("Chain Owner");
const before = await step(pid);
await check("baseline: with no chain job the next step is not automation_running", () => {
  assert.notEqual(before.key, "automation_running", before.headline);
});

// The real enqueue door (the parser save / document upload routes call enqueueStageSteps).
enqueueJob(db, "stage_step", { projectId: pid }, { projectId: pid, priority: 4 });
await check("MUST-PASS: a fresh queued chain reads as automation running, with the chain's own wording", async () => {
  const s = await step(pid);
  assert.equal(s.key, "automation_running", s.headline);
  assert.equal(s.who, "nobody");
  assert.match(s.headline, /Preparing this project automatically/);
});

db.run("UPDATE job_queue SET status = 'running', started_at = ? WHERE project_id = ? AND job_type = 'stage_step'", [new Date().toISOString(), pid]);
await check("MUST-PASS: a running chain reads as automation running", async () => {
  assert.equal((await step(pid)).key, "automation_running");
});

// A chain stuck behind a dead worker: older than the freshness window. (Only the timestamps are
// aged here — the row itself came through the real enqueue.)
const stale = new Date(Date.now() - AUTO_CHAIN_FRESH_MS - 60_000).toISOString();
db.run("UPDATE job_queue SET status = 'pending', started_at = NULL, created_at = ? WHERE project_id = ? AND job_type = 'stage_step'", [stale, pid]);
await check("MUST-EXCLUDE: a stale queued chain never hides the real next step", async () => {
  const s = await step(pid);
  assert.notEqual(s.key, "automation_running", s.headline);
  assert.equal(s.key, before.key, `stale chain changed the answer: ${s.key} vs ${before.key}`);
});
db.run("UPDATE job_queue SET status = 'running', started_at = ? WHERE project_id = ? AND job_type = 'stage_step'", [stale, pid]);
await check("MUST-EXCLUDE: a chain running for longer than the window never hides the real next step", async () => {
  assert.notEqual((await step(pid)).key, "automation_running");
});
db.run("UPDATE job_queue SET status = 'done', finished_at = ? WHERE project_id = ? AND job_type = 'stage_step'", [new Date().toISOString(), pid]);
await check("MUST-EXCLUDE: a finished chain is not automation running", async () => {
  assert.equal((await step(pid)).key, before.key);
});

// Staging in flight keeps its own wording even with a chain queued beside it.
const pid2 = newProject("Autopilot Owner");
enqueueJob(db, "autopilot", { projectId: pid2 }, { projectId: pid2, priority: 3 });
enqueueJob(db, "stage_step", { projectId: pid2 }, { projectId: pid2, priority: 4 });
await check("MUST-PASS: autopilot in flight keeps its own wording beside a queued chain", async () => {
  const s = await step(pid2);
  assert.equal(s.key, "automation_running");
  assert.match(s.headline, /^Autopilot is running/);
});

if (failures) { console.error(`\n${failures} auto-chain next-step check(s) FAILED.`); process.exit(1); }
console.log("\nAll auto-chain next-step checks passed.");
process.exit(0);
