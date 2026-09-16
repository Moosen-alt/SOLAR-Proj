// FEE RESEARCH IS TRIGGERED, NOT REMEMBERED. The researcher (researchFeeSchedule)
// existed with no production caller: a project landing at an AHJ we hold no fee
// row for kept quoting the 1.5%-of-valuation guess forever, because nothing ever
// went looking for the published schedule. The trigger now lives at QC — the same
// day-the-plan-set-lands moment the document demands moved to — and enqueues a
// fee_research background job (never a synchronous LLM call on a request path).
//
// What this file drives is the PRODUCTION path end to end, on a scratch DB:
//   createProject → runQcForProject → ensureFeeSchedulesResearched → enqueueJob →
//   (instant kick) processNextJob's fee_research handler → researchFeeSchedule →
//   saveFeeSchedule. No API key is set, so the researcher answers through its own
//   stub seam ("No ANTHROPIC_API_KEY configured…") — the sanctioned no-network
//   stand-in — and the handler must store NOTHING for it.
//
// The invariants pinned here, in order:
//   1. A process with no job worker enqueues NOTHING (the smoke, every other unit
//      test, and one-off scripts all run QC under a dotenv'd real key — an
//      enqueue's instant kick there would spend a multi-minute web LLM pass).
//   2. A project at a fee-less AHJ enqueues exactly ONE fee_research job carrying
//      the track and DISCIPLINE the project actually files (combo here).
//   3. A second project at the same AHJ — and a QC re-run of the first — does NOT
//      enqueue a duplicate (dedupe key track|profileKey|discipline + backoff).
//   4. An AHJ that already has a row (reachable through the production lookup,
//      undifferentiated fallback included) enqueues nothing.
//   5. A job whose research returns nothing stores NO fee row (an empty row would
//      block future auto-research), records the attempt in the audit log, and the
//      fee sheet keeps its honest miss (valuation estimate, not published_schedule).
//   6. Split tracks ask per-discipline: building→structural, electrical/mpu→
//      electrical (deduped), nem→undifferentiated.
//   7. Hard rule 3 driven through the REAL guard, not a mock: research lands
//      'seeded'; a human-verified row is never overwritten — a later research
//      pass refuses and appends to notes; the keyless handler is equally inert
//      against it.
//   8. Combo acquisition accepts both split schedules after backoff expires;
//      incomplete split coverage researches only the missing discipline. Fuzzy
//      names and delegation use the production lookup, and other states lose.
//
// Run: tsx backend/test/feeResearchTrigger.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// BEFORE any src import: no key (the researcher's stub seam), scratch DB, and no
// background noise (autopilot auto-start, code research) polluting job counts.
delete process.env.ANTHROPIC_API_KEY;
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SKIP_CODE_RESEARCH = "1";
delete process.env.FEE_RESEARCH; // the trigger must be ON by default

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-research-trigger-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const { openDatabase } = await import("../src/db");
  const { createProject, getProjectDetail } = await import("../src/repository");
  const { runQcForProject } = await import("../src/qc");
  const {
    ensureFeeSchedulesResearched, feeResearchNeedsForTracks, feeScheduleProfileKey,
    saveFeeSchedule, researchFeeSchedule, markFeeScheduleVerified, getFeeSchedule,
  } = await import("../src/feeSchedules");
  const { startJobWorker, jobWorkerRunning, enqueueJob, processNextJob } = await import("../src/jobQueue");
  const { buildPaymentQuote } = await import("../src/submissionFees");
  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   ${name}`);
  };

  interface JobRow { id: string; status: string; payload: string; result: string | null; project_id: string | null }
  const feeJobs = (ahjLike: string): Array<JobRow & { p: Record<string, unknown> }> =>
    db.query<JobRow>(
      "SELECT id, status, payload, result, project_id FROM job_queue WHERE job_type = 'fee_research' AND payload LIKE ? ORDER BY created_at",
      [`%${ahjLike}%`],
    ).map((r) => ({ ...r, p: JSON.parse(r.payload) as Record<string, unknown> }));

  // The enqueue rides a dynamic-import microtask chain off runQcForProject, and
  // the instant kick then runs the job — poll with a bounded deadline.
  const waitFor = async (pred: () => boolean, ms = 8000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return true;
      await sleep(50);
    }
    return pred();
  };

  const mkProject = (ahj: string, extra: Record<string, string> = {}) =>
    createProject(db, {
      owner: "Fee Trigger Test", street: "1 Test Way", city: ahj.replace(/^City of\s+/i, ""),
      state: "ID", zip: "83701", ahj, utility: "", account: "1", meter: "1",
      dcKw: "8.6", acKw: "6.5",
      ...extra,
    } as never);

  // -------------------------------------------------------------------------
  // 1) NO WORKER, NO ENQUEUE — the property that keeps the smoke / unit tests /
  //    scripts (all of which run QC, often under a real dotenv key) from ever
  //    spending autonomous research as a side effect.
  // -------------------------------------------------------------------------
  check("1a. precondition: this process runs no job worker yet", jobWorkerRunning() === false);
  const p0 = mkProject("City of Noworker");
  await sleep(500); // let any (wrongly) fired enqueue settle
  check("1b. QC in a worker-less process enqueued nothing", feeJobs("Noworker").length === 0,
    JSON.stringify(feeJobs("Noworker").map((j) => j.p)));
  check("1c. …and no fee row appeared either", !getFeeSchedule(db, feeScheduleProfileKey({ state: "ID", ahj: "City of Noworker" }, "permit"), "permit", "combo"));

  // From here on this process IS the worker process — exactly what the server
  // does at boot (start the worker; we clear its interval, the flag stays).
  clearInterval(startJobWorker(db));
  check("1d. worker started — enqueues now allowed", jobWorkerRunning() === true);

  // -------------------------------------------------------------------------
  // 2) A fee-less AHJ enqueues EXACTLY ONE job, with the discipline the project
  //    files (unknown permit structure defaults to one combo permit; no utility
  //    → no NEM need).
  // -------------------------------------------------------------------------
  const p1 = mkProject("City of Feeville");
  await waitFor(() => feeJobs("Feeville").length >= 1);
  const j1 = feeJobs("Feeville");
  check("2a. exactly one fee_research job", j1.length === 1, `got ${j1.length}: ${JSON.stringify(j1.map((j) => j.p))}`);
  check("2b. it targets the permit track", j1[0]?.p.track === "permit", String(j1[0]?.p.track));
  check("2c. it carries the COMBO discipline (the permit this project files)", j1[0]?.p.discipline === "combo", String(j1[0]?.p.discipline));
  const expectedKey = feeScheduleProfileKey({ state: "ID", ahj: "City of Feeville" }, "permit");
  check("2d. dedupe key = track|profileKey|discipline", j1[0]?.p.researchKey === `permit|${expectedKey}|combo`, String(j1[0]?.p.researchKey));
  check("2e. job is project-scoped (audit + org attribution)", j1[0]?.project_id === p1.project.id);

  // -------------------------------------------------------------------------
  // 3) The keyless (stub) handler ran via the production worker path and stored
  //    NOTHING — and wrote the attempt to the audit log.
  // -------------------------------------------------------------------------
  await waitFor(() => feeJobs("Feeville").every((j) => j.status === "done" || j.status === "failed"));
  const j1After = feeJobs("Feeville")[0];
  check("3a. job completed (not stuck/retrying)", j1After?.status === "done", j1After?.status);
  const result = j1After?.result ? JSON.parse(j1After.result) as Record<string, unknown> : {};
  check("3b. handler reported saved:false (stub — no API key)", result.saved === false && /ANTHROPIC_API_KEY/.test(String(result.reason)), JSON.stringify(result));
  check("3c. NO fee row was stored for the empty result (an empty row would block future auto-research)",
    !getFeeSchedule(db, expectedKey, "permit", "combo") && !getFeeSchedule(db, expectedKey, "permit", ""));
  const audit = db.query<{ action: string }>(
    "SELECT action FROM audit_logs WHERE project_id = ? AND action = 'fees.research_no_result'", [p1.project.id]);
  check("3d. the attempt is on the audit log", audit.length === 1, `got ${audit.length}`);

  // The fee sheet keeps its honest miss: the labelled valuation estimate, never
  // a published schedule it does not hold.
  const missQuote = buildPaymentQuote(db, getProjectDetail(db, p1.project.id).project, "permit");
  check("3e. quote source is the estimate, not published_schedule", missQuote.permitFeeSource === "valuation_estimate", String(missQuote.permitFeeSource));
  check("3f. the estimate presents as an estimate", /Rough estimate/i.test(missQuote.permitFeeBasis), missQuote.permitFeeBasis.slice(0, 120));

  // -------------------------------------------------------------------------
  // 4) DEDUPE: a QC re-run and a second project at the same AHJ enqueue nothing
  //    new — the finished attempt inside the backoff window is the marker.
  // -------------------------------------------------------------------------
  runQcForProject(db, p1.project.id);
  await sleep(500);
  check("4a. QC re-run did not re-enqueue", feeJobs("Feeville").length === 1, `got ${feeJobs("Feeville").length}`);
  mkProject("City of Feeville");
  await sleep(500);
  check("4b. a second project at the same AHJ did not re-enqueue", feeJobs("Feeville").length === 1, `got ${feeJobs("Feeville").length}`);

  // -------------------------------------------------------------------------
  // 5) An AHJ we already hold a row for enqueues nothing at all. The row is
  //    undifferentiated (discipline "") — the production lookup's fallback must
  //    satisfy the combo need, or every single-schedule jurisdiction would be
  //    re-researched per discipline.
  // -------------------------------------------------------------------------
  const rowvilleSave = saveFeeSchedule(db, { state: "ID", ahj: "City of Rowville", track: "permit" }, {
    found: true, reason: "", basis: "flat",
    brackets: [{ feeUsd: 250, label: "Residential solar PV permit" }],
    notes: "", sourceUrl: "https://rowville.example.test/fees", sourceQuote: "Residential solar PV permit: $250 flat.", sourceKind: "official",
  });
  check("5a. seed row saved through the production path, confidence seeded", rowvilleSave.saved && rowvilleSave.schedule?.confidence === "seeded", rowvilleSave.reason);
  mkProject("City of Rowville");
  await sleep(500);
  check("5b. an AHJ with an existing row enqueues nothing", feeJobs("Rowville").length === 0,
    JSON.stringify(feeJobs("Rowville").map((j) => j.p)));

  // -------------------------------------------------------------------------
  // 6) DISCIPLINE-AWARE: split tracks ask for their own rows; mpu collapses into
  //    electrical; nem is undifferentiated. Driven through the same production
  //    helper QC calls, with the track set a split jurisdiction derives.
  // -------------------------------------------------------------------------
  check("6a. needs mapping: building→structural, electrical/mpu→electrical (deduped), nem→\"\"",
    JSON.stringify(feeResearchNeedsForTracks(["nem", "building", "electrical", "mpu"])) ===
    JSON.stringify([{ track: "nem", discipline: "" }, { track: "permit", discipline: "structural" }, { track: "permit", discipline: "electrical" }]));
  const enqueuedSplit = await ensureFeeSchedulesResearched(
    db,
    { id: p1.project.id, state: "ID", ahj: "City of Splitburg", utility: "Splitburg Electric" } as never,
    ["nem", "building", "electrical", "mpu"],
  );
  check("6b. three targets enqueued for the split set", enqueuedSplit === 3, `got ${enqueuedSplit}`);
  await waitFor(() => feeJobs("Splitburg").length >= 3);
  const splitDisciplines = feeJobs("Splitburg").map((j) => `${j.p.track}|${j.p.discipline}`).sort();
  check("6c. the jobs carry structural + electrical + nem, and nothing for mpu separately",
    JSON.stringify(splitDisciplines) === JSON.stringify(["nem|", "permit|electrical", "permit|structural"]),
    JSON.stringify(splitDisciplines));

  // A COMBO RESEARCH REQUEST IS NOT A REQUIREMENT FOR A COMBO DATABASE ROW.
  // These rows model an AHJ publishing split schedules, including a structural
  // formula that cannot yet produce a quote. Holding that formula is coverage;
  // a quote limitation must not become a perpetual twelve-turn research bill.
  const seedSplit = (ahj: string, discipline: "electrical" | "structural", state = "ID") =>
    saveFeeSchedule(db, { state, ahj, track: "permit", discipline }, {
      found: true, reason: "", basis: "flat",
      brackets: [{ feeUsd: discipline === "electrical" ? 160 : 100,
        label: discipline === "electrical" ? "Electrical permit" : "$100 plus $5 per kW" }],
      notes: "", sourceUrl: "https://split.example.test/fees",
      sourceQuote: "Electrical permit $160. Structural fee $100 plus $5 per kW.", sourceKind: "official",
    });
  check("6d. both split schedules saved", seedSplit("City of Splitcovered", "electrical").saved &&
    seedSplit("City of Splitcovered", "structural").saved);
  const coveredKey = feeScheduleProfileKey({ state: "ID", ahj: "City of Splitcovered" }, "permit");
  markFeeScheduleVerified(db, coveredKey, "permit", "test operator", "structural");
  const splitRowsBefore = JSON.stringify(db.query("SELECT * FROM fee_schedules WHERE profile_key = ? ORDER BY discipline", [coveredKey]));
  const oldAttempt = enqueueJob(db, "fee_research", {
    state: "ID", ahj: "City of Splitcovered", utility: "", track: "permit", discipline: "combo",
    profileKey: coveredKey, researchKey: `permit|${coveredKey}|combo`,
  }, { projectId: p1.project.id, scheduledAt: "2000-01-01T00:00:00.000Z" });
  db.run("UPDATE job_queue SET status = 'done', created_at = ?, finished_at = ? WHERE id = ?",
    ["2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", oldAttempt.id]);
  mkProject("City of Splitcovered");
  await sleep(500);
  check("6e. QC with split coverage does not re-research after the backoff expired", feeJobs("Splitcovered").length === 1,
    JSON.stringify(feeJobs("Splitcovered").map((j) => j.p)));
  const fuzzyCovered = await ensureFeeSchedulesResearched(db,
    { id: p1.project.id, state: "ID", ahj: "Splitcovered", utility: "" } as never, ["combo"]);
  check("6f. fuzzy name resolves both split schedules without research", fuzzyCovered === 0, `got ${fuzzyCovered}`);
  check("6g. acquisition left split schedules byte-identical, including the verified formula row",
    JSON.stringify(db.query("SELECT * FROM fee_schedules WHERE profile_key = ? ORDER BY discipline", [coveredKey])) === splitRowsBefore);

  check("6h. electrical-only coverage seeded", seedSplit("City of Partialcovered", "electrical").saved);
  const missingStructural = await ensureFeeSchedulesResearched(db,
    { id: p1.project.id, state: "ID", ahj: "City of Partialcovered", utility: "" } as never, ["combo", "building"]);
  check("6i. combo plus building needs enqueue only one missing structural job",
    missingStructural === 1 && feeJobs("Partialcovered").length === 1 && feeJobs("Partialcovered")[0]?.p.discipline === "structural",
    JSON.stringify(feeJobs("Partialcovered").map((j) => j.p)));
  const partialAgain = await ensureFeeSchedulesResearched(db,
    { id: p1.project.id, state: "ID", ahj: "City of Partialcovered", utility: "" } as never, ["combo"]);
  check("6j. missing split discipline retains its dedupe/backoff", partialAgain === 0 && feeJobs("Partialcovered").length === 1);

  check("6k. structural-only coverage seeded", seedSplit("City of Structurecovered", "structural").saved);
  const missingElectrical = await ensureFeeSchedulesResearched(db,
    { id: p1.project.id, state: "ID", ahj: "City of Structurecovered", utility: "" } as never, ["combo"]);
  check("6l. structural-only coverage researches electrical", missingElectrical === 1 &&
    feeJobs("Structurecovered")[0]?.p.discipline === "electrical");
  const wrongState = await ensureFeeSchedulesResearched(db,
    { id: p1.project.id, state: "WA", ahj: "City of Splitcovered", utility: "" } as never, ["combo"]);
  check("6m. split rows from another state do not suppress new combo research", wrongState === 1 &&
    feeJobs("Splitcovered").some((j) => j.p.state === "WA" && j.p.discipline === "combo"));

  // A known delegation without its target is a modelling repair, not a gap to
  // rediscover for every project. Preserve the trigger's existing treatment.
  const delegated = saveFeeSchedule(db, { state: "ID", ahj: "City of Delegatecovered", track: "permit", discipline: "structural" }, {
    found: true, reason: "", basis: "flat", brackets: [], notes: "",
    collectedByProfileKey: "ID|county of missingtarget",
    sourceUrl: "https://delegate.example.test/fees", sourceQuote: "County collects structural fees.", sourceKind: "official",
  });
  check("6n. unresolved structural delegation and electrical row saved", delegated.saved && seedSplit("City of Delegatecovered", "electrical").saved);
  const unresolvedDelegation = await ensureFeeSchedulesResearched(db,
    { id: p1.project.id, state: "ID", ahj: "City of Delegatecovered", utility: "" } as never, ["combo"]);
  check("6o. an unresolved delegation does not trigger repeated combo research", unresolvedDelegation === 0);

  // -------------------------------------------------------------------------
  // 7) HARD RULE 3, through the REAL guard. Research lands seeded; a human
  //    verifies; later research may not touch the row — it refuses and appends
  //    its finding to notes. Nothing in this file (or the handler) writes
  //    'verified' — only markFeeScheduleVerified, the human gesture, does.
  // -------------------------------------------------------------------------
  const quotevilleKey = feeScheduleProfileKey({ state: "ID", ahj: "City of Quoteville" }, "permit");
  const researcherStub = (feeUsd: number) => async () => ({
    found: true, reason: "", basis: "flat" as const,
    brackets: [{ feeUsd, label: "Solar PV combination permit" }],
    notes: "", sourceUrl: "https://quoteville.example.test/fees",
    sourceQuote: `Solar PV combination permit: $${feeUsd} flat.`, sourceKind: "official",
  });
  const saved = await researchFeeSchedule(db, { state: "ID", ahj: "City of Quoteville", track: "permit", discipline: "combo" }, { researcher: researcherStub(321) });
  check("7a. researched row saved as seeded, carrying the asked discipline",
    saved.saved && saved.schedule?.confidence === "seeded" && saved.schedule?.discipline === "combo",
    JSON.stringify({ saved: saved.saved, confidence: saved.schedule?.confidence, discipline: saved.schedule?.discipline, reason: saved.reason }));

  // The fee sheet now quotes it — seeded and saying so (operator visibility).
  const p5 = mkProject("City of Quoteville");
  await sleep(500);
  check("7b. an AHJ satisfied by the researched row enqueues nothing", feeJobs("Quoteville").length === 0);
  const quote = buildPaymentQuote(db, getProjectDetail(db, p5.project.id).project, "permit");
  check("7c. quote source flips to published_schedule at $321", quote.permitFeeSource === "published_schedule" && quote.permitFeeUsd === 321,
    JSON.stringify({ source: quote.permitFeeSource, fee: quote.permitFeeUsd }));
  check("7d. confidence seeded, and the sentence says not human-verified",
    quote.permitFeeConfidence === "seeded" && /not yet human-verified/.test(quote.permitFeeBasis), quote.permitFeeBasis.slice(0, 160));

  // A human verifies (the only path to 'verified'), then research disagrees.
  markFeeScheduleVerified(db, quotevilleKey, "permit", "test operator", "combo");
  const clash = await researchFeeSchedule(db, { state: "ID", ahj: "City of Quoteville", track: "permit", discipline: "combo" }, { researcher: researcherStub(999) });
  const verifiedRow = getFeeSchedule(db, quotevilleKey, "permit", "combo");
  check("7e. research against a human-verified row REFUSES", clash.refusedVerified === true && clash.saved === false, JSON.stringify({ refusedVerified: clash.refusedVerified, saved: clash.saved }));
  check("7f. the row is untouched: still verified, still $321", verifiedRow?.confidence === "verified" && verifiedRow?.brackets[0]?.feeUsd === 321,
    JSON.stringify({ confidence: verifiedRow?.confidence, fee: verifiedRow?.brackets[0]?.feeUsd }));
  check("7g. the disagreement went to notes, visibly", /NOT applied — row is human-verified/.test(verifiedRow?.notes || ""), (verifiedRow?.notes || "").slice(0, 200));

  // The keyless HANDLER is equally inert against it: run a fee_research job for
  // this target through the production worker and confirm nothing moved.
  enqueueJob(db, "fee_research", {
    state: "ID", ahj: "City of Quoteville", utility: "", track: "permit", discipline: "combo",
    profileKey: quotevilleKey, researchKey: `permit|${quotevilleKey}|combo`,
  }, { priority: 3, maxRetries: 2, projectId: p5.project.id, scheduledAt: new Date(Date.now() - 1000).toISOString() });
  await waitFor(() => feeJobs("Quoteville").length >= 1 && feeJobs("Quoteville").every((j) => j.status === "done"), 8000)
    || await processNextJob(db);
  await waitFor(() => feeJobs("Quoteville").every((j) => j.status === "done" || j.status === "failed"));
  const rowAfterJob = getFeeSchedule(db, quotevilleKey, "permit", "combo");
  check("7h. the worker-path job left the verified row untouched", rowAfterJob?.confidence === "verified" && rowAfterJob?.brackets[0]?.feeUsd === 321,
    JSON.stringify({ confidence: rowAfterJob?.confidence, fee: rowAfterJob?.brackets[0]?.feeUsd }));
  const verifiedCount = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM fee_schedules WHERE confidence = 'verified'");
  check("7i. exactly two 'verified' rows exist — the human-marked ones; research wrote none", Number(verifiedCount?.n) === 2, String(verifiedCount?.n));

  db.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file locks — scratch dir, best-effort */ }
  if (failures) { console.error(`\nfeeResearchTrigger: ${failures} failure(s)`); process.exit(1); }
  console.log("\nfeeResearchTrigger: all checks passed");
  // EXPLICIT EXIT, after the banner. Importing repository (as every repository-
  // driving test in this suite does) leaves live handles behind; this file also
  // runs real worker drains whose deferred kicks ride timers. Every assertion has
  // already run and printed — a process left waiting on stray handles would hang
  // the `&&` test chain, which is worse than an explicit exit.
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
