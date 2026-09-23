// LLM-5: autonomous research dedupe under a synchronous burst, and hostnames are not AHJs.
//   · ensureCodeProfilesResearched called 5x synchronously for one fresh state/AHJ enqueues
//     exactly ONE code_research job per layer. Production: 24 jobs for 8 keys, 4-5 identical
//     rows in the same millisecond — the DB dedupe could not see an enqueue still behind the
//     lazy import.
//   · ensureFeeSchedulesResearched called 5x concurrently enqueues ONE fee_research job per
//     researchKey. Pinned, not fixed: its loop runs synchronously after a single await, so each
//     concurrent caller finishes (and its rows land) before the next resumes.
//   · an AHJ that is a hostname ("Benchmark bsaonline.com") gets no AHJ-layer research; the
//     state layer still does. mustPass and mustExclude both checked.
// Run: tsx backend/test/researchDedupe.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "research-dedupe-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.JOB_WORKER_INTERVAL_MS = "3600000";
delete process.env.ANTHROPIC_API_KEY; // stub LLM: any kicked research job spends nothing
delete process.env.SKIP_CODE_RESEARCH;
delete process.env.FEE_RESEARCH;

const { openDatabase } = await import("../src/db");
const { ensureCodeProfilesResearched, ahjLooksLikeHostname, codeProfileKey } = await import("../src/codeProfiles");
const { ensureFeeSchedulesResearched } = await import("../src/feeSchedules");
const { startJobWorker } = await import("../src/jobQueue");

const db = await openDatabase();

let failures = 0;
const run = async (label: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    console.log(`  ok   - ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`);
  }
};
const settle = () => new Promise((r) => setTimeout(r, 150));
const jobsFor = (jobType: string, needle: string) =>
  db.query<{ payload: string }>("SELECT payload FROM job_queue WHERE job_type = ?", [jobType])
    .filter((j) => j.payload.includes(needle)).length;

await run("code research: 5 synchronous calls -> exactly 1 job per layer", async () => {
  const stateKey = codeProfileKey({ state: "ZQ", ahj: "" });
  const ahjKey = codeProfileKey({ state: "ZQ", ahj: "City of Burstville" });
  for (let i = 0; i < 5; i++) ensureCodeProfilesResearched(db, "ZQ", "City of Burstville");
  await settle();
  assert.equal(jobsFor("code_research", `"profileKey":"${stateKey}"`), 1, "state layer");
  assert.equal(jobsFor("code_research", `"profileKey":"${ahjKey}"`), 1, "AHJ layer");
  // And a later call (jobs now in the table) still adds nothing.
  ensureCodeProfilesResearched(db, "ZQ", "City of Burstville");
  await settle();
  assert.equal(jobsFor("code_research", `"profileKey":"${ahjKey}"`), 1);
});

await run("hostname AHJ: mustExclude — hostnames / portal hosts are not jurisdictions", () => {
  for (const s of [
    "Benchmark bsaonline.com", "benchmark.bsaonline.com", "bsaonline", "https://aca-prod.accela.com/X",
    "www.cityofx.gov", "cityofx.gov", "permits.example.org/solar", "X Township (bsaonline)",
    "aca-prod.accela.com", "example.energov.us",
  ]) assert.equal(ahjLooksLikeHostname(s), true, `should reject "${s}"`);
});

await run("hostname AHJ: mustPass — real jurisdiction names are kept", () => {
  for (const s of [
    "City of Coos Bay", "Elmore County, ID", "St. Johns County", "Ft. Myers", "Washington D.C.",
    "City of St. Louis", "Mt. Pleasant Township", "Unincorporated Clark Co.", "Town of Gov. Mifflin",
    "City of Commerce", "Coronado", "Village of Orland Park", "",
  ]) assert.equal(ahjLooksLikeHostname(s), false, `should keep "${s}"`);
});

await run("hostname AHJ: no AHJ-layer research, state layer still queued", async () => {
  const ahjKey = codeProfileKey({ state: "ZH", ahj: "Benchmark bsaonline.com" });
  const stateKey = codeProfileKey({ state: "ZH", ahj: "" });
  ensureCodeProfilesResearched(db, "ZH", "Benchmark bsaonline.com");
  await settle();
  assert.equal(jobsFor("code_research", `"profileKey":"${ahjKey}"`), 0, "a hostname became a research job");
  assert.equal(jobsFor("code_research", `"profileKey":"${stateKey}"`), 1, "the state layer must still be researched");
});

await run("fee research: 5 concurrent calls -> exactly 1 job per researchKey (no race to fix)", async () => {
  const timer = startJobWorker(db); // ensureFeeSchedulesResearched enqueues only where a worker runs
  clearInterval(timer);
  const project = { id: "", state: "ZF", ahj: "City of Feeburst", utility: "Feeburst Electric" };
  const tracks = ["building", "electrical", "nem"];
  await Promise.all(Array.from({ length: 5 }, () => ensureFeeSchedulesResearched(db, project, tracks)));
  await settle();
  const rows = db.query<{ payload: string }>("SELECT payload FROM job_queue WHERE job_type = 'fee_research'")
    .map((r) => JSON.parse(r.payload) as { researchKey: string; state: string })
    .filter((p) => p.state === "ZF");
  const perKey = new Map<string, number>();
  for (const p of rows) perKey.set(p.researchKey, (perKey.get(p.researchKey) ?? 0) + 1);
  assert.ok(perKey.size >= 2, `expected several research targets, got ${[...perKey.keys()].join(", ")}`);
  for (const [k, n] of perKey) assert.equal(n, 1, `${k} enqueued ${n}x`);
});

console.log(failures ? `\n${failures} FAILED` : "\nall research-dedupe tests passed");
process.exit(failures ? 1 : 0);
