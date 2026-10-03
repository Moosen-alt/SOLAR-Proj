// A DESIGN LOOKUP THAT THROWS MUST NOT HOLD ITS AHJ (#38).
//
// `inFlightDesignResearch` (codeProfiles.ts) marks "this process just queued a lookup for this AHJ"
// and was cleared only when `runDesignCriteriaResearch` RETURNED. A lookup that threw (an API error,
// a timeout) left it set: the worker marked the job failed, the gate said "incomplete — retrying"
// after the backoff, and `ensureDesignCriteriaResearched` returned 0 for that AHJ until the process
// restarted — "retrying" with nothing queued. The gate test hid it by resetting the markers before
// every call; this file never resets them and drives the REAL worker (processNextJob).
//
// Also pins the worker's landing hook for BOTH job types (design_criteria_research and
// code_research): when the job leaves 'running' — done or failed for good — pre-stage projects in
// that AHJ are re-judged. Fixtures are SYNTHETIC; the LLM is the stub; nothing reaches the network.
//
//   npx tsx backend/test/designLookupMarker.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "design-lookup-marker-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CODE_RESEARCH;
delete process.env.SKIP_CODE_RESEARCH;
delete process.env.PORTAL_AUTOSEED;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const CP = await import("../src/codeProfiles");
const { enqueueJob, processNextJob } = await import("../src/jobQueue");
const { StubLLMProvider } = await import("../src/llm");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
};

const KEY = "sk-ant-test-never-called";
const ST = "NM";
const keyOf = (ahj: string): string => CP.codeProfileKey({ state: ST, ahj });
const jobsOf = (type: string, ahj: string) => db.query<{ id: string; status: string; retry_count: number }>(
  "SELECT id, status, retry_count FROM job_queue WHERE job_type = ? AND payload LIKE ? ORDER BY created_at, rowid", [type, `%"profileKey":"${keyOf(ahj)}"%`],
);
const gateRuns = (projectId: string, trigger: string): number =>
  Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE project_id = ? AND action = 'reviewer_report.generated' AND details LIKE ?", [projectId, `%${trigger}%`])?.n ?? 0);
/** A pre-stage project in the AHJ whose gate has run once — the re-judge only picks those. The gate
 *  runs with research switched off so it sets NO in-process marker (this file never resets them). */
const judgedProject = (ahj: string): string => {
  const id = R.createProject(db, {
    owner: "Synthetic Owner", state: ST, dcKw: "8.4", acKw: "7.7", street: "1 Test Way", city: "Testville", zip: "87000",
    ahj, utility: "Test Power",
  } as never).project.id;
  db.run("UPDATE projects SET status = 'ready_to_stage' WHERE id = ?", [id]);
  process.env.SKIP_CODE_RESEARCH = "1";
  try { R.getReviewerReport(db, id); } finally { delete process.env.SKIP_CODE_RESEARCH; }
  return id;
};
/** Run the worker with the stub provider (no key), then restore the key the enqueue side needs. */
const work = async (): Promise<boolean> => {
  delete process.env.ANTHROPIC_API_KEY;
  try { return await processNextJob(db); } finally { process.env.ANTHROPIC_API_KEY = KEY; }
};

// Enqueue WITHOUT running (the real path kicks the worker at once); the test runs it.
CP.setCodeResearchEnqueuerForTests((d, payload) => { enqueueJob(d, "code_research", payload as unknown as Record<string, unknown>, { priority: 3, maxRetries: 2 }); });
CP.setDesignResearchEnqueuerForTests((d, payload) => { enqueueJob(d, "design_criteria_research", payload, { priority: 3, maxRetries: 2 }); });

await check("a lookup that THROWS: failed for good -> 'retrying' after the backoff -> the next gate DOES queue a new lookup", async () => {
  const ahj = "Throwton County";
  const P = judgedProject(ahj);
  process.env.ANTHROPIC_API_KEY = KEY;
  const original = StubLLMProvider.prototype.researchDesignCriteria;
  StubLLMProvider.prototype.researchDesignCriteria = async () => { throw new Error("synthetic: lookup API unavailable"); };
  try {
    assert.equal(CP.ensureDesignCriteriaResearched(db, ST, ahj), 1, "the first gate did not queue a lookup");
    const [job] = jobsOf("design_criteria_research", ahj);
    // First throw: the worker re-queues it (maxRetries 2 = one retry); make the retry due now.
    assert.equal(await work(), true);
    assert.deepEqual([jobsOf("design_criteria_research", ahj)[0].status, jobsOf("design_criteria_research", ahj)[0].retry_count], ["pending", 1]);
    assert.equal(CP.ensureDesignCriteriaResearched(db, ST, ahj), 0, "queued a second lookup while the first awaits its retry");
    db.run("UPDATE job_queue SET scheduled_at = ? WHERE id = ?", [new Date(Date.now() - 1000).toISOString(), job.id]);
    // Second throw: failed for good — and the worker's landing hook re-judges the AHJ's project.
    const before = gateRuns(P, "design_criteria_research_landed");
    assert.equal(await work(), true);
    assert.equal(jobsOf("design_criteria_research", ahj)[0].status, "failed");
    assert.equal(gateRuns(P, "design_criteria_research_landed"), before + 1, "a lookup that failed for good did not re-judge the AHJ's project");
  } finally {
    StubLLMProvider.prototype.researchDesignCriteria = original;
  }
  // Inside the backoff: no retry yet (the job row is the backoff marker).
  assert.equal(CP.ensureDesignCriteriaResearched(db, ST, ahj), 0, "retried inside the backoff");
  // After the backoff: the gate says "retrying" — and a retry IS queued (not held by the process marker).
  db.run("UPDATE job_queue SET finished_at = ? WHERE job_type = 'design_criteria_research' AND status = 'failed'",
    [new Date(Date.now() - CP.DESIGN_RESEARCH_RETRY_MS - 60_000).toISOString()]);
  assert.equal(CP.readDesignLookupProgress(db, ST, ahj)?.status, "retrying");
  assert.equal(CP.ensureDesignCriteriaResearched(db, ST, ahj), 1, "the progress read 'retrying' but the thrown lookup's marker held the AHJ: nothing was queued");
  const jobs = jobsOf("design_criteria_research", ahj);
  assert.deepEqual(jobs.map((j) => j.status), ["failed", "pending"]);
  assert.equal(CP.readDesignLookupProgress(db, ST, ahj)?.status, "queued");
});

await check("a lookup that RETURNS still clears the marker (control): an incomplete stub answer is retried after the backoff", async () => {
  const ahj = "Returnton County";
  judgedProject(ahj);
  process.env.ANTHROPIC_API_KEY = KEY;
  assert.equal(CP.ensureDesignCriteriaResearched(db, ST, ahj), 1);
  assert.equal(await work(), true);
  assert.equal(jobsOf("design_criteria_research", ahj)[0].status, "done");
  db.run("UPDATE job_queue SET finished_at = ? WHERE id = ?",
    [new Date(Date.now() - CP.DESIGN_RESEARCH_RETRY_MS - 60_000).toISOString(), jobsOf("design_criteria_research", ahj)[0].id]);
  assert.equal(CP.readDesignLookupProgress(db, ST, ahj)?.status, "retrying");
  assert.equal(CP.ensureDesignCriteriaResearched(db, ST, ahj), 1, "a returned (ungrounded) lookup held the AHJ");
});

await check("code_research landing hook: the worker re-judges the AHJ's pre-stage project when the full research lands", async () => {
  const ahj = "Codeton County";
  const P = judgedProject(ahj);
  enqueueJob(db, "code_research", { state: ST, ahj, profileKey: keyOf(ahj), reason: "test" }, { priority: 3, maxRetries: 2 });
  const before = gateRuns(P, "code_research_landed");
  assert.equal(await work(), true);
  assert.equal(jobsOf("code_research", ahj)[0].status, "done");
  assert.equal(gateRuns(P, "code_research_landed"), before + 1, "the worker did not re-judge after code_research landed");
});

CP.setCodeResearchEnqueuerForTests(null);
CP.setDesignResearchEnqueuerForTests(null);
delete process.env.ANTHROPIC_API_KEY;

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall design-lookup marker checks passed");
process.exit(0);
