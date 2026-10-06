// #206 — THE PER-JOB PROCESS LOOKUP'S WALL TIME. Live (a never-seen Utah city, 2026-10-06) it took
// ~15 min: the process step was allowed 8 searches, spent its whole 300 s budget on them, aborted and
// was retried; documents/fees waited for the portal's catalog reads; the permit-track fee research
// was queued only after the whole lookup landed; and the log said neither how many searches a step
// used nor whether its answer counted.
//
// The model is stubbed (no network, no key); everything after it is the real code.
//
// KILL TESTS (each verified red by hand):
//   K1 process step back to maxSearches 8 (LOOKUP_SEARCH_CAP gone)        → (s1) fails.
//   K2 documents/fees asked after the catalog reads again                 → (c2) fails.
//   K3 no onIssuerKnown call / no early delegation write                  → (i1), (j1) fail.
//   K4 fee_research job without the "already priced" re-check             → (g1) fails.
//   K5 no per-step log line                                               → (l1) fails.
//   K6 fee_research does not wait for a running lookup of the same agency → (g2) fails.
//
// Run: npx tsx backend/test/permitProcessLookupLatency.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebLookupResult } from "../../shared/src/types";
import type { PageReader, ReadPage } from "../src/agencyPageReader";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppl-latency-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SKIP_CODE_RESEARCH = "1";
delete process.env.FEE_RESEARCH;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.PERMIT_PROCESS_LOOKUP_TIMEOUT_MS;

const db = await (await import("../src/db")).openDatabase();
const ppl = await import("../src/permitProcessLookup");
const pp = await import("../src/permitProcess");
const fees = await import("../src/feeSchedules");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Synthetic jurisdiction: a city whose permits a county issues (the delegation case).
const COUNTY = "https://www.co.marion.or.us/building/solar";
const FEES = "https://docs.example-countyfees.org/2026-fee-schedule.pdf";
const ACA = "https://aca-oregon.accela.com/oregon/";
const processAnswer = () => JSON.stringify({
  issuingAgency: { value: "Marion County", sourceUrl: COUNTY, quote: "Marion County Building Inspection serves unincorporated areas and cities that do not have building inspection programs, including Quillmere" },
  permitStructure: { value: "separate", sourceUrl: COUNTY, quote: "Solar installations require a structural permit and a separate electrical permit" },
  permits: [
    { discipline: "structural", label: "Residential Structural", portalUrl: { value: ACA, sourceUrl: COUNTY, quote: "Apply online through Oregon ePermitting (aca-oregon.accela.com)" } },
    { discipline: "electrical", label: "Residential Electrical", portalUrl: { value: ACA, sourceUrl: COUNTY, quote: "Apply online through Oregon ePermitting (aca-oregon.accela.com)" } },
  ],
});
const grounded = (text: string): WebLookupResult => ({ text, groundedSearches: 3, searches: 3, stopReason: "end_turn", resultUrls: [COUNTY, FEES, ACA], pagesRead: 0 });
const empty: WebLookupResult = { text: "{}", groundedSearches: 1, searches: 1, stopReason: "end_turn", resultUrls: [COUNTY], pagesRead: 0 };
type Ask = { label: string; user: string; maxSearches?: number; timeoutMs?: number; readPages?: boolean };

// ── (s1) THE SEARCH CAP ──────────────────────────────────────────────────────────────────────
await check("(s1) a searcher that never answers stops at the per-step cap (≤ LOOKUP_SEARCH_CAP, below the time budget): ONE process attempt, no abort and retry; non-grounded ⇒ nothing stored, no delegation, nobody told the issuer", async () => {
  assert.equal(typeof ppl.LOOKUP_SEARCH_CAP, "number", "a named per-step search cap exists");
  assert.ok(ppl.LOOKUP_SEARCH_CAP <= 5, `cap ${ppl.LOOKUP_SEARCH_CAP}`);
  // The server's max_uses, modelled: the searcher runs every search it is allowed and never finds
  // an answer. Each search costs the LIVE pace (the 300 s budget / 8 searches it burned ≈ 37.5 s,
  // virtual — nothing sleeps). Reaching the call's own timeout is an abort, exactly as askWithWebSearch
  // reports it; stopping at the cap first returns what it has: model memory, no visible result.
  const PACE_MS = 37_500;
  const asked: Ask[] = [];
  const virtualMs: number[] = [];
  const llm = {
    webLookup: async (i: Ask): Promise<WebLookupResult> => {
      asked.push(i);
      const searches = i.maxSearches ?? 5;
      const spent = searches * PACE_MS;
      virtualMs.push(Math.min(spent, i.timeoutMs ?? Infinity));
      if (spent >= (i.timeoutMs ?? Infinity)) return { text: "", groundedSearches: 0, searches, stopReason: null, resultUrls: [], pagesRead: 0, error: "Request was aborted.", timedOut: true };
      // A confident answer FROM MEMORY (no result block): never kept.
      return { text: processAnswer(), groundedSearches: 0, searches, stopReason: "end_turn", resultUrls: [], pagesRead: 0 };
    },
  };
  let told = 0;
  await assert.rejects(
    ppl.runPermitProcessLookup(db, llm, { state: "OR", ahj: "City of Neverfound", reader: null, onIssuerKnown: () => { told++; } }),
    /no part was grounded/,
  );
  for (const a of asked) assert.ok((a.maxSearches ?? 99) <= ppl.LOOKUP_SEARCH_CAP, `${a.label} allowed ${a.maxSearches} searches`);
  const processCalls = asked.filter((a) => a.label.endsWith(".process"));
  assert.equal(processCalls.length, 1, "the first attempt landed (an 8-search step aborted at the budget and was retried)");
  const budget = processCalls[0].timeoutMs ?? 300_000;
  assert.ok(virtualMs[0] <= budget * 0.7, `the process step stopped at ${virtualMs[0]} ms of a ${budget} ms budget`);
  assert.equal(pp.getPermitProcessLookup(db, "OR", "City of Neverfound"), null, "nothing stored");
  assert.equal(fees.getFeeSchedule(db, fees.feeScheduleProfileKey({ state: "OR", ahj: "City of Neverfound" }, "permit"), "permit", "structural"), null, "no delegation row from memory");
  assert.equal(told, 0, "an ungrounded part one names no issuer");
});

// ── (c1) (c2) CONCURRENCY ────────────────────────────────────────────────────────────────────
// A reader whose every read is refused at once, except the portal page: the Accela catalog's first
// read, slow (the polite per-host gap made it seconds-to-minutes live).
const UNIT = 300;
const events: Array<{ t: number; what: string }> = [];
let t0 = Date.now();
const mark = (what: string) => events.push({ t: Date.now() - t0, what });
const slowPortalReader = (): PageReader => {
  const log: PageReader["log"] = [];
  return {
    log,
    readsLeft: () => 99,
    async read(url: string): Promise<ReadPage> {
      const slow = url === ACA;
      if (slow) { mark("read-start:portal"); await sleep(UNIT); mark("read-end:portal"); }
      log.push({ url, ok: false, reason: "refused (test)", kind: "other" as ReadPage["kind"] });
      return { url, finalUrl: url, ok: false, status: 403, reason: "refused (test)", kind: "other", title: "", text: "", html: "", links: [] } as unknown as ReadPage;
    },
  };
};

await check("(c1) the portal and documents/fees steps run concurrently after the process step: three 1-unit steps finish in ~2 units, not ~3", async () => {
  const llm = {
    webLookup: async (i: Ask): Promise<WebLookupResult> => {
      await sleep(UNIT);
      if (i.label.endsWith(".process")) return grounded(processAnswer());
      return empty;
    },
  };
  const start = Date.now();
  await ppl.runPermitProcessLookup(db, llm, { state: "OR", ahj: "City of Twostep", reader: null });
  const ms = Date.now() - start;
  assert.ok(ms < UNIT * 2.6, `took ${ms} ms for steps of ${UNIT} ms (serial would be ≥ ${UNIT * 3})`);
});

await check("(c2) documents/fees is asked BEFORE the portal catalog is read (it needs only the agency and our pages), so the slow catalog read no longer delays the long-pole step", async () => {
  events.length = 0;
  t0 = Date.now();
  const llm = {
    webLookup: async (i: Ask): Promise<WebLookupResult> => {
      const part = i.label.replace(/^permitProcessLookup\./, "");
      mark(`ask:${part}`);
      if (part === "process") return grounded(processAnswer());
      await sleep(part === "documentsFees" ? UNIT * 2 : UNIT);
      return empty;
    },
  };
  await ppl.runPermitProcessLookup(db, llm, { state: "OR", ahj: "City of Catalogue", reader: slowPortalReader() });
  const at = (what: string) => events.findIndex((e) => e.what === what);
  const lastIndex = (what: string, before: number) => { let k = -1; events.forEach((e, idx) => { if (e.what === what && idx < before) k = idx; }); return k; };
  const docs = at("ask:documentsFees");
  const portalAsk = at("ask:portal");
  assert.ok(docs >= 0, `documents/fees asked: ${JSON.stringify(events)}`);
  // The catalog read is the portal-page read that ends just before the portal step is asked (or,
  // with no portal step, the last one).
  const catalogEnd = lastIndex("read-end:portal", portalAsk >= 0 ? portalAsk : events.length);
  assert.ok(catalogEnd >= 0, `the catalog read the portal page: ${JSON.stringify(events)}`);
  assert.ok(docs < catalogEnd, `documents/fees was asked at ${events[docs].t} ms, after the catalog read ended at ${events[catalogEnd].t} ms: ${JSON.stringify(events)}`);
});

// ── (i1) THE ISSUER IS KNOWN AFTER PART ONE ─────────────────────────────────────────────────
await check("(i1) onIssuerKnown fires once, right after a grounded part one and BEFORE the portal and documents/fees steps are asked, with the delegation row (city → county) already written", async () => {
  const asked: string[] = [];
  let seen: { at: string[]; delegation: string | null; agency: string | null; disciplines: string[] } | null = null;
  let told = 0;
  const llm = {
    webLookup: async (i: Ask): Promise<WebLookupResult> => {
      asked.push(i.label);
      return i.label.endsWith(".process") ? grounded(processAnswer()) : empty;
    },
  };
  const cityKey = fees.feeScheduleProfileKey({ state: "OR", ahj: "City of Quillmere" }, "permit");
  const run = await ppl.runPermitProcessLookup(db, llm, {
    state: "OR", ahj: "City of Quillmere", reader: null,
    onIssuerKnown: (x) => {
      told++;
      seen = { at: [...asked], delegation: fees.getFeeSchedule(db, cityKey, "permit", "structural")?.collectedByProfileKey ?? null, agency: x.issuingAgency, disciplines: [...x.disciplines] };
    },
  });
  assert.equal(run.saved, true, run.reason);
  assert.equal(told, 1);
  assert.ok(seen, "called");
  const s = seen as unknown as { at: string[]; delegation: string | null; agency: string | null; disciplines: string[] };
  assert.deepEqual(s.at, ["permitProcessLookup.process"], "only the process step had been asked");
  assert.equal(s.agency, "Marion County");
  assert.deepEqual(s.disciplines.sort(), ["electrical", "structural"]);
  assert.equal(s.delegation, fees.feeScheduleProfileKey({ state: "OR", ahj: "Marion County" }, "permit"), "the delegation row was written before the caller was told");
  // Landing writes the same delegation again: still one row, still pointing at the county.
  const rows = db.query<{ n: number }>("SELECT COUNT(*) AS n FROM fee_schedules WHERE profile_key = ? AND track = 'permit' AND discipline = 'structural'", [cityKey]);
  assert.equal(rows[0].n, 1);
});

await check("(i2) a process part that errored tells nobody (the run throws, as before)", async () => {
  let told = 0;
  const aborted: WebLookupResult = { text: "", groundedSearches: 0, stopReason: null, resultUrls: [], pagesRead: 0, error: "Request was aborted." };
  await assert.rejects(ppl.runPermitProcessLookup(db, { webLookup: async (i: Ask) => (i.label.endsWith(".process") ? aborted : empty) }, { state: "OR", ahj: "City of Erroria", reader: null, onIssuerKnown: () => { told++; } }), /the process part errored/);
  assert.equal(told, 0);
});

// ── (l1) ONE LOG LINE PER STEP ───────────────────────────────────────────────────────────────
await check("(l1) every step logs its searches used of the cap and whether its answer was grounded; the run's calls carry the same (searchCap, ms)", async () => {
  const lines: string[] = [];
  const ol = console.log, ow = console.warn, oi = console.info;
  const grab = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.log = grab; console.warn = grab; console.info = grab;
  let run;
  try {
    run = await ppl.runPermitProcessLookup(db, { webLookup: async (i: Ask) => (i.label.endsWith(".process") ? grounded(processAnswer()) : empty) }, { state: "OR", ahj: "City of Loglands", reader: null });
  } finally { console.log = ol; console.warn = ow; console.info = oi; }
  const processLine = lines.find((l) => /permitProcessLookup\.process City of Loglands/.test(l));
  assert.ok(processLine, `a process line: ${JSON.stringify(lines)}`);
  assert.match(processLine!, new RegExp(`searches=3/${ppl.LOOKUP_SEARCH_CAP}\\b`));
  assert.match(processLine!, /grounded=true/);
  assert.ok(lines.some((l) => /permitProcessLookup\.documentsFees City of Loglands.*searches=1\/\d+.*grounded=true/.test(l)), JSON.stringify(lines));
  const p = run!.calls.find((c) => c.part === "process")!;
  assert.equal(p.searchCap, ppl.LOOKUP_SEARCH_CAP);
  assert.equal(typeof p.ms, "number");
});

// ── (j1) (g1) THE JOB: FEE RESEARCH QUEUED WHEN THE ISSUER IS KNOWN ─────────────────────────
const { createProject } = await import("../src/repository");
const jq = await import("../src/jobQueue");
const llmMod = await import("../src/llm");

// A city that issues its own permits: the research targets are its own fee rows.
const OWN = "https://www.quillbrook.example.gov/building/solar";
const ownProcessAnswer = () => JSON.stringify({
  issuingAgency: { value: "City of Quillbrook", sourceUrl: OWN, quote: "The City of Quillbrook Building Division issues all building and electrical permits within city limits" },
  permitStructure: { value: "separate", sourceUrl: OWN, quote: "Solar installations require a structural permit and a separate electrical permit" },
  permits: [],
});

await check("(j1) the permit_process_lookup job queues the permit-track fee research while the documents/fees step is still running (not after the lookup lands); landing queues no duplicate; the job lands 'done'", async () => {
  // Created BEFORE the worker flag is on, so the project's own birth trigger queues nothing.
  const project = createProject(db, {
    owner: "Latency Test", street: "1 Test Way", city: "Quillbrook", state: "OR", zip: "97301", ahj: "City of Quillbrook",
    utility: "", account: "1", meter: "1", dcKw: "7.2", acKw: "6.0",
  } as never).project;
  await sleep(50);
  clearInterval(jq.startJobWorker(db)); // jobWorkerRunning() — no tick ever runs
  const feeJobs = () => db.query<{ id: string; payload: string }>("SELECT id, payload FROM job_queue WHERE job_type = 'fee_research' AND project_id = ?", [project.id]);
  let feeJobsWhileDocsRan = -1;
  const proto = llmMod.StubLLMProvider.prototype as unknown as { webLookup: (i: Ask) => Promise<WebLookupResult> };
  const original = proto.webLookup;
  proto.webLookup = async (i: Ask) => {
    if (i.label.endsWith(".process")) return { ...grounded(ownProcessAnswer()), resultUrls: [OWN] };
    if (i.label.endsWith(".documentsFees")) { await sleep(50); feeJobsWhileDocsRan = feeJobs().length; }
    return { ...empty, resultUrls: [OWN] };
  };
  try {
    // A past scheduled_at: no instant kick, so this test's own processNextJob claims it.
    const job = jq.enqueueJob(db, "permit_process_lookup", { state: "OR", ahj: "City of Quillbrook", utility: "" }, { projectId: project.id, scheduledAt: new Date(Date.now() - 1000).toISOString(), maxRetries: 1 });
    db.run("UPDATE job_queue SET status = 'failed' WHERE job_type <> 'permit_process_lookup' AND status = 'pending'");
    // The worker claims the highest-priority pending job; ours is the only permit_process_lookup.
    for (let k = 0; k < 5 && jq.getJob(db, job.id)?.status === "pending"; k++) await jq.processNextJob(db);
    assert.equal(jq.getJob(db, job.id)?.status, "done", `the lookup job landed: ${jq.getJob(db, job.id)?.error ?? ""}`);
    assert.ok(feeJobsWhileDocsRan > 0, `fee research was queued before documents/fees answered (${feeJobsWhileDocsRan} jobs then)`);
    await sleep(50);
    const keys = feeJobs().map((r) => JSON.parse(r.payload).researchKey as string);
    assert.equal(new Set(keys).size, keys.length, `no duplicate target: ${JSON.stringify(keys)}`);
    assert.ok(keys.length > 0 && keys.every((k) => /quillbrook/i.test(k)), `researched against the issuer the lookup named: ${JSON.stringify(keys)}`);
  } finally {
    proto.webLookup = original;
    db.run("UPDATE job_queue SET status = 'failed' WHERE status IN ('pending','running')");
  }
});

await check("(g1) a fee_research job whose target was priced after it was queued (the lookup's documents/fees landed it) skips WITHOUT researching; an unpriced one still researches", async () => {
  const key = fees.feeScheduleProfileKey({ state: "OR", ahj: "Pricedcounty" }, "permit");
  fees.saveFeeSchedule(db, { state: "OR", ahj: "Pricedcounty", track: "permit", discipline: "structural" }, {
    found: true, reason: "", basis: "flat", brackets: [{ feeUsd: 75, label: "Solar PV" }], sourceUrl: FEES, sourceQuote: "Solar PV $75.00", sourceKind: "official", notes: "test",
  });
  assert.ok(fees.getFeeSchedule(db, key, "permit", "structural"), "fixture row saved");
  const priced = jq.enqueueJob(db, "fee_research", { state: "OR", ahj: "Pricedcounty", utility: "", track: "permit", discipline: "structural", profileKey: key, researchKey: `permit|${key}|structural`, role: "issuer" }, { scheduledAt: new Date(Date.now() - 1000).toISOString() });
  const unpricedKey = fees.feeScheduleProfileKey({ state: "OR", ahj: "Harrowgate Township" }, "permit");
  const unpriced = jq.enqueueJob(db, "fee_research", { state: "OR", ahj: "Harrowgate Township", utility: "", track: "permit", discipline: "structural", profileKey: unpricedKey, researchKey: `permit|${unpricedKey}|structural`, role: "issuer" }, { scheduledAt: new Date(Date.now() - 1000).toISOString() });
  for (let k = 0; k < 6 && [priced, unpriced].some((j) => jq.getJob(db, j.id)?.status === "pending"); k++) await jq.processNextJob(db);
  const pr = jq.getJob(db, priced.id)!;
  assert.equal(pr.status, "done");
  assert.equal((pr.result as Record<string, unknown>)?.skipped, true, `skipped: ${JSON.stringify(pr.result)}`);
  const ur = jq.getJob(db, unpriced.id)!;
  assert.equal(ur.status, "done");
  assert.notEqual((ur.result as Record<string, unknown>)?.skipped, true, `researched (keyless here, so found nothing): ${JSON.stringify(ur.result)}`);
});

await check("(g2) review of #223: while a permit_process_lookup for the SAME agency is running (its documents/fees may be pricing this row), a permit-track fee_research job re-pends a minute later without researching or spending a retry; a job for another agency, or a NEM job, is not held; once the lookup is done it runs", async () => {
  db.run("UPDATE job_queue SET status = 'failed' WHERE status IN ('pending','running')");
  const past = () => new Date(Date.now() - 1000).toISOString();
  const lookup = jq.enqueueJob(db, "permit_process_lookup", { state: "OR", ahj: "City of Holdbrook" }, { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
  db.run("UPDATE job_queue SET status = 'running' WHERE id = ?", [lookup.id]); // a lookup mid-run (no handler is executing it here)
  const key = fees.feeScheduleProfileKey({ state: "OR", ahj: "City of Holdbrook" }, "permit");
  const held = jq.enqueueJob(db, "fee_research", { state: "OR", ahj: "City of Holdbrook Building Division", utility: "", track: "permit", discipline: "electrical", profileKey: key, researchKey: `permit|${key}|electrical`, role: "issuer" }, { scheduledAt: past(), maxRetries: 2 });
  const otherKey = fees.feeScheduleProfileKey({ state: "OR", ahj: "City of Elsewhereton" }, "permit");
  const other = jq.enqueueJob(db, "fee_research", { state: "OR", ahj: "City of Elsewhereton", utility: "", track: "permit", discipline: "electrical", profileKey: otherKey, researchKey: `permit|${otherKey}|electrical`, role: "issuer" }, { scheduledAt: past() });
  const nem = jq.enqueueJob(db, "fee_research", { state: "OR", ahj: "City of Holdbrook", utility: "Holdbrook Light", track: "nem", discipline: "", profileKey: "nem-test", researchKey: "nem|nem-test|", role: "issuer" }, { scheduledAt: past() });
  for (let k = 0; k < 6; k++) await jq.processNextJob(db);
  const h = db.get<{ status: string; scheduled_at: string; retry_count: number; payload: string; result: string | null }>("SELECT status, scheduled_at, retry_count, payload, result FROM job_queue WHERE id = ?", [held.id])!;
  assert.equal(h.status, "pending", "held back while the lookup runs");
  assert.ok(Date.parse(h.scheduled_at) > Date.now() + 30_000, `re-scheduled about a minute out: ${h.scheduled_at}`);
  assert.equal(h.retry_count, 0, "a deferral is not a retry");
  assert.equal(JSON.parse(h.payload).deferredForLookup, 1);
  assert.equal(h.result, null, "no research ran");
  assert.equal(jq.getJob(db, other.id)?.status, "done", "another agency's job is not held");
  assert.equal(jq.getJob(db, nem.id)?.status, "done", "a NEM job is not held (the lookup never prices NEM)");
  // The lookup lands: the held job runs on its next claim.
  db.run("UPDATE job_queue SET status = 'done' WHERE id = ?", [lookup.id]);
  db.run("UPDATE job_queue SET scheduled_at = ? WHERE id = ?", [past(), held.id]);
  await jq.processNextJob(db);
  assert.equal(jq.getJob(db, held.id)?.status, "done");
});

if (failures) { console.error(`\n${failures} permitProcessLookupLatency test(s) failed.`); process.exit(1); }
console.log("\nall permitProcessLookupLatency tests passed");
process.exit(0);
