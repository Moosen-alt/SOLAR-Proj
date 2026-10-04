// AN ABORTED PLACEMENT HALF IS NOT AN ANSWER (#69).
//
// Live run: the design-criteria job's criteria half finished (web-grounded, found nothing) and its
// placement-rules half hit the 240 s timeout ("Request was aborted."). The job counted as a complete
// lookup, so fire setbacks / local PV amendments stayed "not researched" for the 30-day window with
// no retry. Fixtures are SYNTHETIC (an invented village, example .gov URLs); the LLM is a stub;
// nothing reaches the network.
//
// WHAT THIS FILE REFUSES TO LET REGRESS:
//   R1 an aborted placement half is retried after DESIGN_RESEARCH_RETRY_MS, as a placement-only job;
//      the retry does not re-ask the criteria half, and its checklist keeps the criteria answer.
//   R2 a grounded placement half that found no rule is an answer: nothing is queued.
//   R3 no retry inside the backoff, none past the cap, none when the row's criteria are answered by
//      a lookup whose placement half answered.
//   R4 nothing is written as verified.
//
//   npx tsx backend/test/placementLookupRetry.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DesignCriteriaResearchResult, LLMProvider, WebLookupResult } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "placement-lookup-retry-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.CODE_RESEARCH;
delete process.env.SKIP_CODE_RESEARCH;
delete process.env.PORTAL_AUTOSEED;
process.env.ANTHROPIC_API_KEY = "sk-ant-test-never-called";

const { openDatabase } = await import("../src/db");
const CP = await import("../src/codeProfiles");
const { enqueueJob } = await import("../src/jobQueue");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
};

const ST = "NM";
const keyOf = (ahj: string): string => CP.codeProfileKey({ state: ST, ahj });
CP.setDesignResearchEnqueuerForTests((d, payload) => { enqueueJob(d, "design_criteria_research", payload, { priority: 3, maxRetries: 2 }); });

/** A stub provider: the criteria half answers "none found" (grounded); the placement half returns `web`. */
let criteriaAsks = 0;
const stub = (web: Partial<WebLookupResult>): LLMProvider => ({
  async researchDesignCriteria(): Promise<DesignCriteriaResearchResult> { criteriaAsks++; return { provider: "claude", webGrounded: true, values: [], notes: "" }; },
  async webLookup(): Promise<WebLookupResult> { return { text: "", groundedSearches: 0, stopReason: "end_turn", resultUrls: [], pagesRead: 0, fetchedUrls: [], ...web }; },
} as unknown as LLMProvider);
const ABORTED: Partial<WebLookupResult> = { error: "Request was aborted." };
const GROUNDED_NONE: Partial<WebLookupResult> = { text: JSON.stringify({ rules: [] }), groundedSearches: 3 };

const designJobs = (ahj: string) => db.query<{ id: string; status: string; payload: string }>(
  "SELECT id, status, payload FROM job_queue WHERE job_type = 'design_criteria_research' AND payload LIKE ? ORDER BY created_at", [`%"profileKey":"${keyOf(ahj)}"%`],
);
const pending = (ahj: string) => designJobs(ahj).filter((j) => j.status === "pending");
/** Queue (via the gate), run the pending job with `llm`, and stamp it done `agoMs` in the past. */
const runPending = async (ahj: string, llm: LLMProvider, agoMs: number): Promise<{ payload: Record<string, unknown>; result: Record<string, unknown> }> => {
  const [job] = pending(ahj);
  assert.ok(job, `no pending design job for ${ahj}`);
  const payload = JSON.parse(job.payload) as Record<string, unknown>;
  const result = await CP.runDesignCriteriaResearch(db, payload, llm);
  const at = new Date(Date.now() - agoMs).toISOString();
  db.run("UPDATE job_queue SET status = 'done', result = ?, finished_at = ?, created_at = ? WHERE id = ?", [JSON.stringify(result), at, at, job.id]);
  return { payload, result };
};
const review = (ahj: string): number => { CP.resetResearchMarkersForTests(); return CP.ensureDesignCriteriaResearched(db, ST, ahj); };
const PAST_BACKOFF = CP.DESIGN_RESEARCH_RETRY_MS + 60_000;
const itemsOf = (result: Record<string, unknown>) => new Map((result.checklist as Array<{ item: string; status: string }>).map((i) => [i.item, i.status]));

// ─── R1 ──────────────────────────────────────────────────────────────────────────────────────────
const LUNA = "Village of Synthluna";
await check("R1: the first lookup: criteria grounded (none found), placement aborted -> fire setbacks not researched", async () => {
  assert.equal(review(LUNA), 1, "the first review did not queue a lookup");
  const { result } = await runPending(LUNA, stub(ABORTED), PAST_BACKOFF);
  assert.equal(result.webGrounded, true);
  assert.equal((result.placement as Record<string, unknown>).error, "Request was aborted.");
  assert.equal(itemsOf(result).get("fireSetbacks"), "not_researched");
  assert.equal(itemsOf(result).get("groundSnowLoad"), "not_found");
});

await check("R1 MUST-PASS: a review past the backoff queues a PLACEMENT-ONLY retry", () => {
  const queued = review(LUNA);
  const p = pending(LUNA);
  assert.equal(queued, 1, "no retry queued for an aborted placement half");
  assert.equal(p.length, 1);
  assert.equal(JSON.parse(p[0].payload).placementOnly, true, `not placement-only: ${p[0].payload}`);
});

await check("R1: the retry does not re-ask the criteria half, and keeps the earlier criteria answer", async () => {
  const before = criteriaAsks;
  const { result } = await runPending(LUNA, stub(GROUNDED_NONE), PAST_BACKOFF);
  assert.equal(criteriaAsks, before, "the criteria half was re-asked");
  assert.equal(result.placementOnly, true);
  const items = itemsOf(result);
  assert.equal(items.get("fireSetbacks"), "not_found", "a grounded placement half that found nothing is an answer");
  assert.equal(items.get("localPvAmendments"), "not_found");
  assert.equal(items.get("groundSnowLoad"), "not_found", "the criteria answer was lost to 'not researched'");
  assert.equal(items.get("windSpeed"), "not_found");
});

await check("R2 MUST-EXCLUDE: once the placement half answered (grounded, none found), nothing more is queued", () => {
  assert.equal(review(LUNA), 0);
  assert.equal(pending(LUNA).length, 0);
  const prog = CP.readDesignLookupProgress(db, ST, LUNA);
  assert.equal(prog?.status, "landed");
});

// ─── R2 ──────────────────────────────────────────────────────────────────────────────────────────
const MESA = "Village of Synthmesa";
await check("R2 MUST-EXCLUDE: a grounded placement half with 0 rules on the first lookup queues nothing", async () => {
  assert.equal(review(MESA), 1);
  await runPending(MESA, stub(GROUNDED_NONE), PAST_BACKOFF);
  assert.equal(review(MESA), 0);
  assert.equal(pending(MESA).length, 0);
});

// ─── R3 ──────────────────────────────────────────────────────────────────────────────────────────
const VALLE = "Village of Synthvalle";
await check("R3: an aborted placement half inside the backoff queues nothing yet", async () => {
  assert.equal(review(VALLE), 1);
  await runPending(VALLE, stub(ABORTED), 60_000);
  assert.equal(review(VALLE), 0, "retried inside the backoff");
});

await check("R3: aborted placement halves stop retrying at DESIGN_RESEARCH_MAX_INCOMPLETE", async () => {
  db.run("UPDATE job_queue SET finished_at = ?, created_at = ? WHERE payload LIKE ?", [new Date(Date.now() - PAST_BACKOFF).toISOString(), new Date(Date.now() - PAST_BACKOFF).toISOString(), `%"profileKey":"${keyOf(VALLE)}"%`]);
  let attempts = 1;
  while (review(VALLE) === 1) {
    await runPending(VALLE, stub(ABORTED), PAST_BACKOFF);
    attempts++;
    assert.ok(attempts <= CP.DESIGN_RESEARCH_MAX_INCOMPLETE, "the retry was not capped");
  }
  assert.equal(attempts, CP.DESIGN_RESEARCH_MAX_INCOMPLETE);
});

await check("R3: a row whose criteria are answered is still not re-queued when its placement half answered", async () => {
  const VERDE = "Village of Synthverde";
  const answers: LLMProvider = {
    ...stub(GROUNDED_NONE),
    async researchDesignCriteria(): Promise<DesignCriteriaResearchResult> {
      return { provider: "claude", webGrounded: true, notes: "", values: [
        { criterion: "groundSnowLoadPsf", value: 10, sourceUrl: "https://synthverde.example.gov/design", quote: "Pg = 10 psf" },
        { criterion: "windSpeedMph", value: 105, sourceUrl: "https://synthverde.example.gov/design", quote: "Vult = 105 mph" },
      ] };
    },
  } as unknown as LLMProvider;
  assert.equal(review(VERDE), 1);
  await runPending(VERDE, answers, PAST_BACKOFF);
  assert.equal(review(VERDE), 0);
  // Control: the same answered row whose placement half was aborted IS retried, placement-only.
  const ROJO = "Village of Synthrojo";
  assert.equal(review(ROJO), 1);
  await runPending(ROJO, { ...answers, webLookup: stub(ABORTED).webLookup } as LLMProvider, PAST_BACKOFF);
  assert.equal(review(ROJO), 1, "an answered row with an aborted placement half was not retried");
  assert.equal(JSON.parse(pending(ROJO)[0].payload).placementOnly, true);
});

// ─── R4 ──────────────────────────────────────────────────────────────────────────────────────────
await check("R4: nothing is written as verified", () => {
  for (const ahj of [LUNA, MESA, VALLE, "Village of Synthverde", "Village of Synthrojo"]) {
    const row = db.get<{ confidence: string }>("SELECT confidence FROM jurisdiction_code_profiles WHERE profile_key = ?", [keyOf(ahj)]);
    assert.ok(!row || row.confidence === "seeded", `${ahj}: ${row?.confidence}`);
  }
  assert.equal(CP.ownCodeProfileRow(db, ST, "Village of Synthverde")?.profile.confidence, "seeded", "control: the answered row exists, seeded");
});

CP.setDesignResearchEnqueuerForTests(null);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows keeps the sqlite handle */ }
if (failures) {
  console.error(`\nplacementLookupRetry: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nplacementLookupRetry: all checks passed");
process.exit(0);
