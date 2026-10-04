// THE GATE WAITS FOR THE DESIGN-CRITERIA LOOKUP (#30).
//
// Live run, a county AHJ never seen before: the lookup was queued at 00:36:53, the reviewer gate
// ran at 00:40 and said "Jurisdiction design criteria not on file — stated values unchecked", the
// lookup landed at 00:43 — and nothing judged the project again. Fixtures are SYNTHETIC (invented
// counties, example .gov URLs); the LLM is a stub; nothing reaches the network.
//
// WHAT THIS FILE REFUSES TO LET REGRESS:
//   AC1 the first judgement in a new AHJ says the lookup is IN PROGRESS (queued / running), same id.
//   AC2 when the lookup lands, pre-stage projects in that AHJ are re-judged by the worker: a new
//       reviewer_report.generated audit row; other AHJs and post-stage projects are left alone.
//   AC3 a lookup that ran and found nothing says so (with the site-specific page when there is
//       one); its checklist reaches the KB card even with no AHJ row.
//   AC4 an incomplete lookup (failed / cut off / ungrounded) is retried after a short backoff, not
//       held 30 days; the gate says "incomplete — retrying"; retries are capped.
//   AC5 a "… County" lookup also searches the state's Table R301.2 amendments + the county page,
//       and a banded table comes back as site_specific (official pages only).
//   AC6 the progress read writes nothing; values the lookup stores stay seeded.
//   AC7 a STATE-layer code_research (no AHJ) landing re-judges every pre-stage project in that
//       state (#107): a plan stating another edition now carries city.code.basis-mismatch; other
//       states are untouched; no vision call; a state + AHJ landing in one tick re-judge once.
//
//   npx tsx backend/test/designLookupGate.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DesignCriteriaResearchResult, LLMProvider } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "design-lookup-gate-"));
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
const { parseDesignCriteriaLookup, designCriteriaLookupUserMessage } = await import("../src/llm");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
};

const KEY = "sk-ant-test-never-called";
const ST = "NM";
const UNKNOWN = "city.struct.design-criteria-unknown";
const fakeProvider = (result: DesignCriteriaResearchResult): LLMProvider => ({ researchDesignCriteria: async () => result } as unknown as LLMProvider);
const mkProject = (ahj: string, status = "ready_to_stage"): string => {
  const id = R.createProject(db, {
    owner: "Synthetic Owner", state: ST, dcKw: "8.4", acKw: "7.7", street: "1 Test Way", city: "Testville", zip: "87000",
    ahj, utility: "Test Power",
  } as never).project.id;
  db.run("UPDATE projects SET status = ? WHERE id = ?", [status, id]);
  return id;
};
const unknownFinding = (projectId: string) =>
  R.buildReviewerReportFor(db, R.getProjectDetail(db, projectId).project).findings.find((f) => f.id === UNKNOWN);
const gateRuns = (projectId: string): number =>
  Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE project_id = ? AND action = 'reviewer_report.generated'", [projectId])?.n ?? 0);
const keyOf = (ahj: string): string => CP.codeProfileKey({ state: ST, ahj });
const designJobs = (ahj: string) => db.query<{ id: string; status: string }>(
  "SELECT id, status FROM job_queue WHERE job_type = 'design_criteria_research' AND payload LIKE ? ORDER BY created_at", [`%"profileKey":"${keyOf(ahj)}"%`],
);
const finishJob = (id: string, result: Record<string, unknown> | null, status = "done", agoMs = 0): void => {
  const at = new Date(Date.now() - agoMs).toISOString();
  db.run("UPDATE job_queue SET status = ?, result = ?, finished_at = ?, created_at = ? WHERE id = ?", [status, result ? JSON.stringify(result) : null, at, at, id]);
};
const finishAllPending = (exceptId = ""): void => {
  db.run("UPDATE job_queue SET status = 'done', result = '{}', finished_at = ? WHERE status IN ('pending','running') AND id != ?", [new Date().toISOString(), exceptId]);
};
/** The AHJ's one pending design lookup, queued by its gate (directly, or once the full code research
 *  that asks for the same criteria has finished). Everything else pending is finished. */
const pendingDesignLookup = (ahj: string): string => {
  db.run("UPDATE job_queue SET status = 'done', result = '{}', finished_at = ? WHERE status IN ('pending','running') AND job_type != 'design_criteria_research'", [new Date().toISOString()]);
  CP.resetResearchMarkersForTests();
  CP.ensureDesignCriteriaResearched(db, ST, ahj);
  const pending = designJobs(ahj).filter((j) => j.status === "pending");
  assert.equal(pending.length, 1, `expected one pending design lookup for ${ahj}`);
  finishAllPending(pending[0].id);
  return pending[0].id;
};

// Enqueue WITHOUT running (the real path kicks the worker at once, which would reach the network).
CP.setCodeResearchEnqueuerForTests((d, payload) => { enqueueJob(d, "code_research", payload as unknown as Record<string, unknown>, { priority: 3, maxRetries: 2 }); });
CP.setDesignResearchEnqueuerForTests((d, payload) => { enqueueJob(d, "design_criteria_research", payload, { priority: 3, maxRetries: 2 }); });

// ─── AC1: in progress, not "not on file" ─────────────────────────────────────────────────────────
const P1 = mkProject("Testvale County");
const P1_SUBMITTED = mkProject("Testvale County", "submitted");
const P_OTHER = mkProject("Otherplace County");

await check("AC1: no lookup at all -> the plain 'not on file' wording (control)", () => {
  const f = unknownFinding(P1);
  assert.ok(f, "no unknown finding for a jurisdiction with no criteria");
  assert.match(f!.title, /not on file/);
});

await check("AC1: the first gate in a new AHJ queues research and says the lookup is IN PROGRESS (same id, callout)", () => {
  process.env.ANTHROPIC_API_KEY = KEY;
  CP.resetResearchMarkersForTests();
  const report = R.getReviewerReport(db, P1);
  const f = report.findings.find((x) => x.id === UNKNOWN);
  assert.ok(f, "the finding disappeared");
  assert.equal(f!.severity, "callout");
  assert.match(f!.title, /lookup in progress/i);
  assert.doesNotMatch(f!.title, /not on file/);
  assert.match(f!.message, /being looked up now \(lookup queued/);
  assert.match(f!.message, /re-judges automatically/);
});

await check("AC1: the design lookup itself queued, then running -> 'queued' then 'running'", () => {
  const id = pendingDesignLookup("Testvale County");
  assert.match(unknownFinding(P1)!.message, /lookup queued/);
  db.run("UPDATE job_queue SET status = 'running', started_at = ? WHERE id = ?", [new Date().toISOString(), id]);
  const f = unknownFinding(P1)!;
  assert.match(f.title, /lookup in progress/i);
  assert.match(f.message, /lookup running/);
});

// ─── AC6: the progress read is a read ────────────────────────────────────────────────────────────
await check("AC6: reading the lookup's progress (code context, page-load stage results) writes nothing", async () => {
  const count = (t: string) => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)?.n ?? 0);
  const projectsStamp = () => String(db.get<{ m: string }>("SELECT MAX(updated_at) AS m FROM projects")?.m ?? "");
  const before = [count("job_queue"), count("audit_logs"), count("jurisdiction_code_profiles"), count("projects"), projectsStamp()];
  const ctx = CP.resolveEffectiveCodeContext(db, ST, "Testvale County");
  assert.equal(ctx.designLookup?.status, "running");
  CP.readDesignLookupProgress(db, ST, "Testvale County");
  CP.listRowlessDesignLookups(db);
  await R.readStageResults(db, P1);
  assert.deepEqual([count("job_queue"), count("audit_logs"), count("jurisdiction_code_profiles"), count("projects"), projectsStamp()], before);
});

// ─── AC2: the lookup lands with values -> the worker re-judges ──────────────────────────────────
await check("AC2: values landed -> pre-stage projects in that AHJ are re-judged (new audit row); others are not", async () => {
  const job = designJobs("Testvale County")[0];
  const result = await CP.runDesignCriteriaResearch(db, { state: ST, ahj: "Testvale County", profileKey: keyOf("Testvale County") }, fakeProvider({
    provider: "claude", webGrounded: true, notes: "",
    values: [
      { criterion: "groundSnowLoadPsf", value: 30, sourceUrl: "https://testvalecounty.example.gov/design", quote: "Ground snow load Pg = 30 psf" },
      { criterion: "windSpeedMph", value: 115, sourceUrl: "https://testvalecounty.example.gov/design", quote: "Vult = 115 mph" },
    ],
  }));
  finishJob(job.id, result);
  const before = [gateRuns(P1), gateRuns(P1_SUBMITTED), gateRuns(P_OTHER)];
  R.getReviewerReport(db, P_OTHER); // P_OTHER's gate has run, but in ANOTHER AHJ
  const rejudged = await R.rejudgeReviewerGatesAfterLookup(db, { state: ST, ahj: "Testvale County" }, "design_criteria_research_landed");
  assert.deepEqual(rejudged, [P1]);
  assert.equal(gateRuns(P1), before[0] + 1, "no new reviewer_report.generated row");
  assert.equal(gateRuns(P1_SUBMITTED), before[1], "a post-stage project was re-judged");
  assert.equal(gateRuns(P_OTHER), before[2] + 1, "another AHJ's project: expected only its own explicit gate run (+1) — the re-judge must not touch it");
  assert.equal(unknownFinding(P1), undefined, "the criteria landed but the gate still says they are unknown");
  // Hard rule 3: the lookup's values land SEEDED.
  assert.equal(CP.ownCodeProfileRow(db, ST, "Testvale County")?.profile.confidence, "seeded");
});

await check("AC2: the WORKER re-judges after the job leaves 'running' (stub LLM, no network)", async () => {
  const P4 = mkProject("Workerton County");
  R.getReviewerReport(db, P4);
  pendingDesignLookup("Workerton County");
  const before = gateRuns(P4);
  delete process.env.ANTHROPIC_API_KEY; // the worker builds the stub provider
  assert.equal(await processNextJob(db), true);
  assert.equal(designJobs("Workerton County")[0].status, "done");
  assert.equal(gateRuns(P4), before + 1, "the worker did not re-judge the AHJ's project");
  const row = db.get<{ action: string; details: string }>("SELECT action, details FROM audit_logs WHERE project_id = ? AND action = 'reviewer_report.generated' ORDER BY rowid DESC LIMIT 1", [P4]);
  assert.match(String(row?.details), /design_criteria_research_landed/);
  // Stub = not web-grounded = incomplete; with no key nothing will retry.
  const f = unknownFinding(P4)!;
  assert.match(f.title, /lookup incomplete — verify with the AHJ/);
  assert.doesNotMatch(f.message, /being looked up now/, "the re-judge ran while the job still read as running");
});

// ─── AC4: an incomplete lookup is retried, not held 30 days ─────────────────────────────────────
await check("AC4: truncated / failed (threw) / ungrounded -> 'incomplete — retrying', re-queued after the backoff, capped", async () => {
  // No marker resets here (#38): every lookup runs through runDesignCriteriaResearch, which must
  // clear this process's in-flight marker however it ends — a lookup that THROWS included.
  process.env.ANTHROPIC_API_KEY = KEY;
  const ahj = "Retryton County";
  const P5 = mkProject(ahj);
  R.getReviewerReport(db, P5);
  const run = (provider: LLMProvider) => CP.runDesignCriteriaResearch(db, { state: ST, ahj, profileKey: keyOf(ahj) }, provider);
  const first = pendingDesignLookup(ahj);
  // 1) cut off: a retry is due only after the backoff
  const cut = await run(fakeProvider({ provider: "claude", webGrounded: true, truncated: true, values: [], notes: "" }));
  finishJob(first, cut);
  assert.match(unknownFinding(P5)!.title, /lookup incomplete — retrying/);
  assert.equal(CP.ensureDesignCriteriaResearched(db, ST, ahj), 0, "retried inside the backoff");
  finishJob(first, cut, "done", CP.DESIGN_RESEARCH_RETRY_MS + 60_000);
  assert.equal(CP.ensureDesignCriteriaResearched(db, ST, ahj), 1, "an incomplete lookup was held by the 30-day window");
  // 2) the lookup THROWS: failed, and still retried after the backoff (not held by the marker)
  const second = designJobs(ahj)[1];
  const throwing = { researchDesignCriteria: async () => { throw new Error("synthetic: lookup API unavailable"); } } as unknown as LLMProvider;
  await assert.rejects(run(throwing), /synthetic/);
  finishJob(second.id, null, "failed", CP.DESIGN_RESEARCH_RETRY_MS + 30_000);
  assert.equal(CP.readDesignLookupProgress(db, ST, ahj)?.status, "retrying");
  // The next gate queues the retry itself, and says so — not "retrying" with nothing queued.
  assert.match(unknownFinding(P5)!.title, /lookup in progress/, "a lookup that threw held its AHJ: 'retrying' with nothing queued");
  assert.deepEqual(designJobs(ahj).map((j) => j.status), ["done", "failed", "pending"]);
  // 3) ungrounded: the cap stops the retries
  const ungrounded = await run(fakeProvider({ provider: "claude", webGrounded: false, values: [], notes: "" }));
  finishJob(designJobs(ahj)[2].id, ungrounded, "done", CP.DESIGN_RESEARCH_RETRY_MS + 10_000);
  assert.equal(CP.ensureDesignCriteriaResearched(db, ST, ahj), 0, `retried past the cap of ${CP.DESIGN_RESEARCH_MAX_INCOMPLETE}`);
  assert.match(unknownFinding(P5)!.title, /lookup incomplete — verify with the AHJ/);
  // Control: a COMPLETE lookup still holds the 30-day window.
  const done = "Doneton County";
  const doneId = pendingDesignLookup(done);
  const complete = await CP.runDesignCriteriaResearch(db, { state: ST, ahj: done, profileKey: keyOf(done) }, fakeProvider({ provider: "claude", webGrounded: true, values: [], notes: "" }));
  finishJob(doneId, complete, "done", CP.DESIGN_RESEARCH_RETRY_MS * 5);
  assert.equal(CP.ensureDesignCriteriaResearched(db, ST, done), 0, "a complete lookup was re-queued inside 30 days");
});

// ─── AC3 + AC5: ran, found nothing jurisdiction-wide; site-specific; KB card ────────────────────
const EMPTY = "Emptyvale County";
const BANDED: DesignCriteriaResearchResult = parseDesignCriteriaLookup({
  siteSpecific: [
    { criterion: "groundSnowLoadPsf", sourceUrl: "https://emptyvalecounty.example.gov/snow-by-elevation", note: "ground snow varies by elevation band" },
    { criterion: "windSpeedMph", sourceUrl: "https://someblog.example.com/wind", note: "a blog" },
    { criterion: "bogus", sourceUrl: "https://emptyvalecounty.example.gov/x", note: "" },
  ],
  notes: "No county-wide table.",
}, true, false, { ahj: EMPTY, state: ST });

await check("AC5: a county lookup also searches the state's Table R301.2 amendments and the county building page; a city's does not", () => {
  const county = designCriteriaLookupUserMessage({ ahj: EMPTY, state: ST });
  assert.match(county, /Table R301\.2 amendments/);
  assert.match(county, /building department/);
  assert.match(county, /siteSpecific/);
  assert.equal(designCriteriaLookupUserMessage({ ahj: "City of Testburg", state: ST }), `Jurisdiction: City of Testburg\nState: ${ST}`);
});

await check("AC5: siteSpecific parses from official pages only, one per real criterion -> checklist site_specific with the URL", () => {
  assert.deepEqual(BANDED.siteSpecific, [{ criterion: "groundSnowLoadPsf", sourceUrl: "https://emptyvalecounty.example.gov/snow-by-elevation", note: "ground snow varies by elevation band" }]);
  const ungrounded = parseDesignCriteriaLookup({ siteSpecific: [{ criterion: "groundSnowLoadPsf", sourceUrl: "https://emptyvalecounty.example.gov/s", note: "" }] }, false, false, { ahj: EMPTY, state: ST });
  assert.equal(ungrounded.siteSpecific, undefined, "an ungrounded answer named a site-specific page");
  const rec = CP.buildDesignCriteriaChecklist(null, BANDED, true);
  const snow = rec.items.find((i) => i.item === "groundSnowLoad")!;
  assert.equal(snow.status, "site_specific");
  assert.equal(snow.sourceUrl, "https://emptyvalecounty.example.gov/snow-by-elevation");
  assert.equal(rec.items.find((i) => i.item === "windSpeed")!.status, "not_found");
});

await check("AC3: landed with nothing -> 'looked up — no jurisdiction-wide value found', with the site-specific page; no row created", async () => {
  process.env.ANTHROPIC_API_KEY = KEY;
  const P6 = mkProject(EMPTY);
  R.getReviewerReport(db, P6);
  const jobId = pendingDesignLookup(EMPTY);
  const result = await CP.runDesignCriteriaResearch(db, { state: ST, ahj: EMPTY, profileKey: keyOf(EMPTY) }, fakeProvider(BANDED));
  finishJob(jobId, result);
  assert.equal(CP.ownCodeProfileRow(db, ST, EMPTY), null, "a lookup that found nothing created an AHJ row");
  const f = unknownFinding(P6)!;
  assert.match(f.title, /looked up — no jurisdiction-wide value found/);
  assert.match(f.message, /A lookup on \d{4}-\d{2}-\d{2} found no jurisdiction-wide ground snow load and design wind speed/);
  assert.match(f.message, /ground snow load is published per site \(ground snow varies by elevation band\) — https:\/\/emptyvalecounty\.example\.gov\/snow-by-elevation/);
});

await check("AC3: the KB card shows 'not found (lookup <date>)' and the site-specific page for a county with NO AHJ row", () => {
  const rowless = CP.listRowlessDesignLookups(db).find((l) => l.ahj === EMPTY);
  assert.ok(rowless, "the rowless lookup's checklist is not listed for the card");
  assert.equal(rowless!.designCriteriaLookup.items.find((i) => i.item === "windSpeed")?.status, "not_found");
  assert.ok(!CP.listRowlessDesignLookups(db).some((l) => l.ahj === "Testvale County"), "a lookup whose AHJ has a row was listed as rowless");
  assert.ok(!CP.listRowlessDesignLookups(db).some((l) => l.ahj === "Retryton County"), "an incomplete lookup was listed as a result");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dashboard = fs.readFileSync(path.join(here, "..", "..", "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
  const cut = (kind: "function" | "const", name: string): string => {
    const re = kind === "function" ? new RegExp(`^function ${name}\\(`, "m") : new RegExp(`^const ${name} = `, "m");
    const m = re.exec(dashboard);
    if (!m) throw new Error(`dashboard.js: could not find ${kind} ${name}`);
    let depth = 0, end = -1;
    for (let j = dashboard.indexOf("{", m.index); j < dashboard.length; j++) {
      if (dashboard[j] === "{") depth++;
      else if (dashboard[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    return dashboard.slice(m.index, end) + (kind === "const" ? ";" : "");
  };
  const bundle = [cut("function", "esc"), cut("function", "codeProfileForKb"), cut("const", "KB_CRITERIA_LABELS"), cut("const", "KB_OBSERVED_LABELS"), cut("function", "kbDesignCriteriaHtml")].join("\n\n");
  // eslint-disable-next-line no-new-func
  const fns = new Function(`${bundle}\nreturn { codeProfileForKb, kbDesignCriteriaHtml };`)() as {
    codeProfileForKb: (kb: unknown, rows: unknown[], lookups: unknown[]) => unknown;
    kbDesignCriteriaHtml: (p: unknown) => string;
  };
  const html = fns.kbDesignCriteriaHtml(fns.codeProfileForKb({ state: ST, ahj: EMPTY }, [], CP.listRowlessDesignLookups(db)));
  const day = rowless!.designCriteriaLookup.at.slice(0, 10);
  assert.match(html, new RegExp(`Design wind speed \\(ultimate\\): <span class="badge badge-warning">not found \\(lookup ${day}\\) — verify`));
  assert.match(html, new RegExp(`Ground snow load: <span class="badge badge-warning">site-specific \\(lookup ${day}\\) — verify</span> <span class="muted">ground snow varies by elevation band — https://emptyvalecounty\\.example\\.gov/snow-by-elevation`));
  // The criteria the lookup answered are not "not researched" (the placement half did not run here).
  assert.doesNotMatch(html, /(?:Ground snow load|Design wind speed \(ultimate\)|Wind exposure|Seismic design category|Frost depth): <span class="badge badge-warning">not researched/);
  assert.equal(fns.codeProfileForKb({ state: ST, ahj: "Nowhere County" }, [], CP.listRowlessDesignLookups(db)), null);
});

// ─── AC7: a STATE-layer code lookup lands -> the state's pre-stage projects are re-judged (#107) ──
await check("AC7: a state-layer code_research landing re-judges the state's projects (basis-mismatch); other states untouched; no vision call", async () => {
  // A state with no shipped reference data: until its own research lands, nothing records an edition.
  const ST2 = "KS";
  const AHJ2 = "Stateland County";
  const BASIS = "city.code.basis-mismatch";
  const PK = R.createProject(db, {
    owner: "Synthetic Owner", state: ST2, dcKw: "8.4", acKw: "7.7", street: "2 Test Way", city: "Testburg", zip: "66000",
    ahj: AHJ2, utility: "Test Power",
  } as never).project.id;
  db.run("UPDATE projects SET status = 'ready_to_stage' WHERE id = ?", [PK]);
  db.run(
    "INSERT INTO project_documents (id, project_id, doc_type, original_filename, source, uploaded_at, extracted_text) VALUES (?, ?, 'plan_set', 'plan_set.pdf', 'upload', ?, ?)",
    [`doc-${PK}`, PK, new Date().toISOString(), "COVER SHEET GOVERNING CODES ALL WORK SHALL CONFORM TO 2021 IRC 2020 NEC ROOF MOUNT PV ARRAY"],
  );
  const basisOf = (id: string) => R.buildReviewerReportFor(db, R.getProjectDetail(db, id).project).findings.find((f) => f.id === BASIS);
  delete process.env.ANTHROPIC_API_KEY; // the worker builds the stub provider: nothing reaches the network
  R.getReviewerReport(db, PK);
  assert.equal(basisOf(PK), undefined, "control: no state editions on file, yet a basis finding");
  finishAllPending();
  enqueueJob(db, "code_research", { state: ST2, ahj: "", profileKey: CP.codeProfileKey({ state: ST2, ahj: "" }) }, { priority: 3, maxRetries: 2 });
  // The research's landing: its editions are stored (seeded, cited) before its row leaves 'running'.
  CP.saveResearchedCodeProfile(db, {
    key: "", state: ST2, ahj: "", confidence: "seeded", amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
    adoptedCodes: [{ code: "IRC", edition: "2018", family: "residential", sourceUrl: "https://codes.example.gov/ks", quote: "The state has adopted the 2018 International Residential Code." }],
    researchProvenance: { webGrounded: true, method: "web_search", notes: "synthetic", at: new Date().toISOString(), searches: 2, groundedSearches: 2 },
  } as never);
  // Vision calls only: an earlier check's enqueue kicks a background drain whose calls land here too.
  const llmCalls = () => Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM llm_calls WHERE label LIKE '%vision%'")?.n ?? 0);
  const visionPasses = () => Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'reviewer_report.vision_pass'")?.n ?? 0);
  const before = { pk: gateRuns(PK), other: gateRuns(P1), llm: llmCalls(), vision: visionPasses() };
  assert.equal(await processNextJob(db), true);
  const stateKey = CP.codeProfileKey({ state: ST2, ahj: "" });
  assert.equal(db.get<{ status: string }>("SELECT status FROM job_queue WHERE job_type = 'code_research' AND payload LIKE ?", [`%"profileKey":"${stateKey}"%`])?.status, "done");
  assert.equal(gateRuns(PK), before.pk + 1, "the state landing did not re-judge the state's pre-stage project");
  const row = db.get<{ details: string }>("SELECT details FROM audit_logs WHERE project_id = ? AND action = 'reviewer_report.generated' ORDER BY rowid DESC LIMIT 1", [PK]);
  assert.match(String(row?.details), /code_research_landed/);
  const f = basisOf(PK);
  assert.ok(f, "the plan states IRC 2021 against the state's 2018, but no basis finding");
  assert.match(f!.message, /IRC 2021/);
  assert.equal(gateRuns(P1), before.other, "a project in another state was re-judged");
  assert.equal(llmCalls(), before.llm, "the re-judge made a vision call");
  assert.equal(visionPasses(), before.vision, "the re-judge ran a vision pass");

  // Same tick: a state and an AHJ landing that both landed before either re-judge -> one re-judge.
  const stateLanded = R.lookupLandingMark();
  const ahjLanded = R.lookupLandingMark();
  const n = gateRuns(PK);
  assert.deepEqual(await R.rejudgeReviewerGatesAfterLookup(db, { state: ST2, ahj: "", scope: "state" }, "code_research_landed", { landedMark: stateLanded }), [PK]);
  assert.deepEqual(await R.rejudgeReviewerGatesAfterLookup(db, { state: ST2, ahj: AHJ2 }, "design_criteria_research_landed", { landedMark: ahjLanded }), []);
  assert.equal(gateRuns(PK), n + 1, "two landings in one tick re-judged twice");
  // A landing AFTER that re-judge started is new data: it re-judges.
  assert.deepEqual(await R.rejudgeReviewerGatesAfterLookup(db, { state: ST2, ahj: "", scope: "state" }, "code_research_landed", { landedMark: R.lookupLandingMark() }), [PK]);
  // The AHJ arm is unchanged: an empty AHJ without the state scope re-judges nothing.
  assert.deepEqual(await R.rejudgeReviewerGatesAfterLookup(db, { state: ST2, ahj: "" }, "design_criteria_research_landed"), []);
});

CP.setCodeResearchEnqueuerForTests(null);
CP.setDesignResearchEnqueuerForTests(null);
delete process.env.ANTHROPIC_API_KEY;

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall design-lookup gate checks passed");
process.exit(0);
