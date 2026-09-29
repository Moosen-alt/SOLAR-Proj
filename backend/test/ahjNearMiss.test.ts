// AN AHJ NAME THAT IS A NEAR-MISS OF THE ADDRESS CITY IS A QUESTION, NOT A PASS (intake test
// 2026-09-29: "AHJ: CITY OF SMONROE" for an address in Monroe, OR — copied faithfully by the parser,
// QC passed, a permit-process lookup was queued for a jurisdiction that does not exist, and the
// project reached ready_to_stage with nothing pending).
//
// ONE predicate (ahjNearMiss.ts) answers "is the AHJ a near-miss of the city": strip the
// jurisdiction prefix/suffix, fold St./Saint-style abbreviations and case/punctuation, then edit
// distance 1–2 but not equal, a county never compared, a name the shared KB knows on someone's
// authority never a typo. QC's critical.ahj row becomes a WARNING that files a pending
// human_review_items row on the ahj field (AHJ_NEAR_MISS_ISSUE_TYPE) naming both values; the
// existing gate holds on it (isCriticalReviewItem). The value itself stays what the plan set says.
//
//   A  MUST-PASS     Smonroe/Monroe through createProject + runQcForProject; the gate holds; the
//                    birth-learned KB row does not quiet it; a corrected AHJ resolves the item on
//                    re-run; a Save Edit as-is confirms it and a re-run does not reopen it.
//   B  MUST-EXCLUDE  county AHJs, equal-modulo-prefix, blanks, a real different jurisdiction, KB-known
//                    names (reference seed, verified KB row, verified code profile), case/punctuation/
//                    whitespace, St./Saint, Ft/Fort, Mt/Mount, Borough of / Township, a short name.
//   C  LOOKUP SKIP   no permit_process_lookup job for the near-miss name; queued once it is corrected;
//                    the chain's acquire_forms step waits for the answer.
//   D  KILL          with the predicate disabled (AHJ_NEAR_MISS_CHECK=off) the must-pass case files
//                    nothing — the fixture depends on the fix.
//
// KILLS (by hand): ahjCityNearMiss returning null -> A1 fails; learned rows counted as known ->
// A2 fails; the near-miss placed outside the critical.ahj row -> A2's re-run auto-approves it.
//
//   npx tsx backend/test/ahjNearMiss.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ahj-near-miss-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmpDir, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
process.env.CODE_RESEARCH = "off";
process.env.FEE_RESEARCH = "off";
process.env.AHJ_FORM_DOWNLOADS = "off";
for (const k of ["PERMIT_PROCESS_LOOKUP", "ANTHROPIC_API_KEY", "SMTP_HOST", "CLIENT_NOTIFICATIONS", "AUTO_STAGE_STEPS", "AHJ_NEAR_MISS_CHECK"]) delete process.env[k];

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject, getProjectDetail, getSubmitGateReport, isCriticalReviewItem, updateProject, humanVerify, rerunQc, prepareSubmission } = await import("../src/repository");
const { runQcForProject, AHJ_NEAR_MISS_ISSUE_TYPE } = await import("../src/qc");
const { ahjCityNearMiss, knownJurisdictionName, boundedEditDistance } = await import("../src/ahjNearMiss");
const { saveVerifiedAhjProfile } = await import("../src/knowledgeBase");
const { saveVerifiedCodeProfile, saveResearchedCodeProfile } = await import("../src/codeProfiles");
const { processStageStep } = await import("../src/autoStageSteps");

const db = await openDatabase();
let failures = 0;
let passed = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> => Promise.resolve()
  .then(fn)
  .then(() => { passed++; console.log(`  ok   - ${label}`); })
  .catch((err) => { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); });
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const client = createClient(db, {
  companyName: "Near Miss Test Solar LLC", legalBusinessName: "Near Miss Test Solar LLC", ccbLicenseNumber: "",
  electricalLicenseNumber: "", businessEmail: "ops@nearmiss.test", businessPhone: "(541) 555-0100",
});

// A plan set's own fields (the shape the intake test used); AHJ / city / state / utility per case.
const PLAN: Record<string, string> = {
  street: "1 Test St", city: "Monroe", state: "OR", zip: "97456", ahj: "City Of Smonroe", utility: "Pacific Power",
  dcKw: "8.0", acKw: "6.4", exportKw: "6.4", moduleMake: "Qcells", moduleModel: "Q.PEAK DUO BLK ML-G10+ 400", moduleWattage: "400",
  moduleQty: "20", invModel: "IQ8PLUS-72-2-US", invQty: "20", invOutputW: "290", interco: "Load-side breaker", busRating: "200",
  mainBreaker: "200", pvBreaker: "30", permitPath: "PRESCRIPTIVE", locateCalloutText: "Roof mount, no excavation.", mounting: "roof",
};
let seq = 0;
const mk = (over: Record<string, string> = {}): string =>
  createProject(db, { clientId: client.id, owner: `Near Miss Owner ${++seq}`, ...PLAN, ...over }).project.id;
const ahjItems = (pid: string) => getProjectDetail(db, pid).humanReviewItems.filter((i) => i.fieldName === "ahj");
const pendingAhj = (pid: string) => ahjItems(pid).filter((i) => i.status === "pending");
const ahjRow = (pid: string) => getProjectDetail(db, pid).qcResults.find((r) => r.ruleId === "critical.ahj")!;
const status = (pid: string): string => String(getProjectDetail(db, pid).project.status);
const rowSeverity = (pid: string): string => String(db.get<{ severity: string }>("SELECT severity FROM qc_results WHERE project_id = ? AND rule_id = 'critical.ahj'", [pid])?.severity);
const noQuestion = (label: string, over: Record<string, string>): Promise<void> => check(`MUST-EXCLUDE: ${label}`, () => {
  const pid = mk(over);
  assert.deepEqual(ahjItems(pid).map((i) => i.issueType), [], `an ahj review item was filed: ${JSON.stringify(ahjItems(pid).map((i) => i.issueType))}`);
  assert.equal(ahjRow(pid).qcStatus, "pass", `critical.ahj: ${ahjRow(pid).qcStatus} — ${ahjRow(pid).message}`);
  assert.equal(status(pid), "qc_passed");
});

console.log("\nA. MUST-PASS — Smonroe / Monroe asks, through the real write path");
let p1 = "";
let p2 = "";
await check("A1 createProject('City Of Smonroe', Monroe OR) files ONE pending review item on ahj naming both values; QC passes with a warning row, not a failure", async () => {
  p1 = mk();
  const items = ahjItems(p1);
  assert.equal(items.length, 1, `ahj items: ${items.length}`);
  const item = items[0];
  assert.equal(item.status, "pending");
  assert.equal(item.issueType, AHJ_NEAR_MISS_ISSUE_TYPE);
  assert.equal(item.parserValue, "City Of Smonroe", "the item shows the value as read");
  assert.match(item.notes, /City Of Smonroe/);
  assert.match(item.notes, /"Monroe"/);
  assert.match(item.notes, /\?/, "the message asks; it never corrects");
  assert.equal(getProjectDetail(db, p1).project.ahj, "City Of Smonroe", "the plan-set value is kept as read");
  assert.equal(status(p1), "qc_passed", "a near-miss is a question, not a QC failure");
  assert.equal(ahjRow(p1).qcStatus, "warning");
  assert.equal(rowSeverity(p1), "warning", "the row is badged warning, not blocker");
  assert.match(ahjRow(p1).message, /Smonroe/);
  assert.ok(isCriticalReviewItem(item), "the pending question holds staging through the EXISTING predicate");
  const gate = getSubmitGateReport(db, p1);
  const qcCheck = gate.checks.find((c) => c.id === "qc-human-review")!;
  assert.equal(qcCheck.status, "blocker", qcCheck.nextAction);
  assert.ok(qcCheck.evidence.some((e) => e.includes(AHJ_NEAR_MISS_ISSUE_TYPE)), qcCheck.evidence.join(" | "));
  assert.equal(gate.canPrepareSubmission, false);
  await assert.rejects(prepareSubmission(db, p1, "building" as never), /staging blocked/i);
});

await check("A2 the birth-learned KB row for the typo does NOT quiet the question: rerunQc right after create (utility set, and utility blank) keeps the item pending", () => {
  p2 = mk();
  const noUtility = mk({ utility: "" }); // the learn keys the AHJ-only row `or|city of smonroe|unknown` — the exact AHJ key
  const learned = db.query<{ profile_key: string }>("SELECT profile_key FROM permit_utility_knowledge WHERE profile_key LIKE 'or|city of smonroe|%'");
  assert.ok(learned.some((r) => r.profile_key === "or|city of smonroe|unknown"), `createProject's birth learn wrote a row under the typo's own key (the trap this pins): ${JSON.stringify(learned)}`);
  assert.equal(knownJurisdictionName(db, "OR", "City Of Smonroe"), false, "a learned row is not a known jurisdiction");
  for (const pid of [p1, p2, noUtility]) {
    runQcForProject(db, pid);
    rerunQc(db, pid);
    assert.equal(pendingAhj(pid).length, 1, `${pid}: pending ahj items after two re-runs`);
    assert.equal(ahjItems(pid).length, 1, "still ONE item on the field (deduped), not a new one per run");
    assert.equal(ahjRow(pid).qcStatus, "warning");
  }
});

await check("A3 correcting the AHJ through updateProject (PUT /api/projects/:id) resolves the item: QC passes, the item is auto-approved, nothing pending", () => {
  updateProject(db, p1, { ahj: "City of Monroe" });
  assert.equal(getProjectDetail(db, p1).project.ahj, "City of Monroe");
  assert.equal(pendingAhj(p1).length, 0);
  const item = ahjItems(p1)[0];
  assert.equal(item.status, "approved");
  assert.match(item.notes, /Auto-resolved: QC check passed/);
  assert.equal(ahjRow(p1).qcStatus, "pass");
  assert.equal(getSubmitGateReport(db, p1).checks.find((c) => c.id === "qc-human-review")!.status !== "blocker", true);
});

await check("A4 confirming as-is (Save Edit with the unchanged value) marks the item edited; a further re-run does not reopen it and the gate no longer holds on it", () => {
  const item = pendingAhj(p2)[0];
  humanVerify(db, p2, { reviewItemId: item.id, action: "edit", fieldValue: "City Of Smonroe" });
  assert.equal(getProjectDetail(db, p2).project.ahj, "City Of Smonroe", "confirming keeps the value");
  assert.equal(ahjItems(p2)[0].status, "edited");
  rerunQc(db, p2);
  assert.equal(pendingAhj(p2).length, 0, "a warning never reopens an answered item");
  assert.equal(ahjItems(p2).length, 1);
  assert.equal(ahjRow(p2).qcStatus, "warning", "the row still says what it sees; the answered item is what clears the gate");
  const qcCheck = getSubmitGateReport(db, p2).checks.find((c) => c.id === "qc-human-review")!;
  assert.notEqual(qcCheck.status, "blocker", qcCheck.nextAction);
});

await check("A5 the pure predicate: Prospr/Prosper, Albuqerque/Albuquerque, Lake Osweg/Lake Oswego fire; a known name (callback) does not; Monroe OR is known from the reference seed", () => {
  assert.deepEqual(ahjCityNearMiss("City of Prospr", "Prosper", "TX"), { ahjCore: "prospr", cityCore: "prosper", distance: 1 });
  assert.equal(ahjCityNearMiss("City of Albuqerque", "Albuquerque", "NM")?.distance, 1);
  assert.equal(ahjCityNearMiss("City of Lake Osweg", "Lake Oswego", "OR")?.distance, 1);
  assert.equal(ahjCityNearMiss("Smonroe", "Monroe", "OR")?.distance, 1);
  assert.equal(ahjCityNearMiss("City of Prospr", "Prosper", "TX", () => true), null, "a KB-known name is never a typo");
  const asked: string[] = [];
  ahjCityNearMiss("City of Prospr", "Prosper", "TX", (n) => { asked.push(n); return false; });
  assert.deepEqual(asked, ["City of Prospr", "prospr"], "the KB is asked about the name as typed AND its stripped core");
  assert.equal(knownJurisdictionName(db, "OR", "Monroe"), true, "reference seed (sanitized_reference)");
  assert.equal(knownJurisdictionName(db, "OR", "City of Monroe"), false, "exact keys: the prefixed form is not itself seeded (the predicate probes the core)");
  assert.equal(boundedEditDistance("smonroe", "monroe", 2), 1);
  assert.equal(boundedEditDistance("portland", "lakeoswego", 2), null);
});

console.log("\nB. MUST-EXCLUDE — no question on these");
await noQuestion("a county AHJ with a city address (Yamhill County / Newberg)", { ahj: "Yamhill County", city: "Newberg", zip: "97132" });
await noQuestion("a county AHJ with a city address (Marion County / Salem)", { ahj: "Marion County", city: "Salem", zip: "97301" });
await noQuestion("AHJ equal to the city modulo prefix (City of Monroe / Monroe)", { ahj: "City of Monroe" });
await noQuestion("AHJ equal to the city modulo prefix (Town of Prosper / Prosper, TX)", { ahj: "Town of Prosper", city: "Prosper", state: "TX", zip: "75078", utility: "Oncor" });
await noQuestion("AHJ equal to the city modulo prefix (City of Beaverton / Beaverton)", { ahj: "City of Beaverton", city: "Beaverton", zip: "97005" });
await check("MUST-EXCLUDE: a blank AHJ is the blank check's (plain 'AHJ' blocker item), not a near-miss", () => {
  const pid = mk({ ahj: "" });
  assert.deepEqual(ahjItems(pid).map((i) => i.issueType), ["AHJ"]);
  assert.equal(ahjRow(pid).qcStatus, "fail");
});
await noQuestion("a blank city (other checks own blanks)", { city: "" });
await noQuestion("a real different jurisdiction that is not a near-miss (City of Lake Oswego / Portland)", { ahj: "City of Lake Oswego", city: "Portland", zip: "97219" });
await noQuestion("a name the reference seed knows, even one letter from the city (Monroe / Monro)", { ahj: "Monroe", city: "Monro" });
await check("MUST-EXCLUDE: a name a HUMAN verified in the KB (saveVerifiedAhjProfile), one letter from the city", () => {
  saveVerifiedAhjProfile(db, { state: "OR", ahj: "City of Rowanmere", verifiedBy: "test-operator" });
  assert.equal(knownJurisdictionName(db, "OR", "City of Rowanmere"), true);
  const pid = mk({ ahj: "City of Rowanmere", city: "Rowanmer" });
  assert.deepEqual(ahjItems(pid).map((i) => i.issueType), []);
  assert.equal(ahjRow(pid).qcStatus, "pass");
});
await check("MUST-EXCLUDE: a name whose code profile a HUMAN verified (saveVerifiedCodeProfile), one letter from the city", () => {
  saveVerifiedCodeProfile(db, {
    key: "", state: "OR", ahj: "Thistlemere", confidence: "seeded",
    adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  }, "test-operator");
  assert.equal(knownJurisdictionName(db, "OR", "Thistlemere"), true, "the verified code-profile key (the predicate probes the stripped core)");
  assert.equal(knownJurisdictionName(db, "OR", "City of Thistlemere"), false, "exact keys only");
  const pid = mk({ ahj: "City of Thistlemere", city: "Thistlemer" });
  assert.deepEqual(ahjItems(pid).map((i) => i.issueType), []);
  assert.equal(ahjRow(pid).qcStatus, "pass");
});
await check("MUST-PASS (guard): a code profile the product RESEARCHED for the typo (seeded, provenance) is not a known name — the question still fires", () => {
  saveResearchedCodeProfile(db, {
    key: "", state: "OR", ahj: "City Of Smonroe", confidence: "seeded",
    adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
    researchProvenance: { webGrounded: true, method: "web_search" },
  } as never);
  assert.ok(db.get("SELECT 1 AS one FROM jurisdiction_code_profiles WHERE profile_key = 'or|city of smonroe|unknown' AND confidence = 'seeded'"), "the research wrote its seeded row under the typo key");
  assert.equal(knownJurisdictionName(db, "OR", "City Of Smonroe"), false);
  const pid = mk();
  assert.deepEqual(ahjItems(pid).map((i) => i.issueType), [AHJ_NEAR_MISS_ISSUE_TYPE]);
});
await noQuestion("case, punctuation and whitespace only (CITY OF  MONROE. / Monroe)", { ahj: "CITY OF  MONROE.", city: "Monroe" });
await noQuestion("case only (city of monroe / MONROE)", { ahj: "city of monroe", city: "MONROE" });
await noQuestion("St. / Saint (St. Helens / Saint Helens)", { ahj: "St. Helens", city: "Saint Helens", zip: "97051" });
await noQuestion("Saint / St. with a prefix (City of Saint Helens / St. Helens)", { ahj: "City of Saint Helens", city: "St. Helens", zip: "97051" });
await noQuestion("Ft / Fort (Ft Worth / Fort Worth, TX)", { ahj: "Ft Worth", city: "Fort Worth", state: "TX", zip: "76102", utility: "Oncor" });
await noQuestion("Mt / Mount (Mt Angel / Mount Angel)", { ahj: "Mt Angel", city: "Mount Angel", zip: "97362" });
await noQuestion("Borough of X / X (PA)", { ahj: "Borough of Ridgemere", city: "Ridgemere", state: "PA", zip: "16407", utility: "FirstEnergy" });
await noQuestion("X Township / X (PA)", { ahj: "Ridgemere Township", city: "Ridgemere", state: "PA", zip: "16407", utility: "FirstEnergy" });
await noQuestion("a short name two edits away is a different word, not a slip (Bend / Bern)", { ahj: "City of Bern", city: "Bend", zip: "97701" });

console.log("\nC. LOOKUP SKIP — a near-miss name is not looked up while the question is pending");
await check("C1 no permit_process_lookup job is queued for the near-miss name; correcting the AHJ queues one", async () => {
  const jq = await import("../src/jobQueue");
  clearInterval(jq.startJobWorker(db)); // the worker flag stays; no tick ever runs
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  // The enqueue's instant kick claims and runs the queued lookup in-process: point the SDK at a
  // closed local port so the fake key never reaches the real API (ECONNREFUSED, no 401s sent).
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
  const jobs = (frag: string) => db.query<{ id: string; status: string; payload: string }>(
    "SELECT id, status, payload FROM job_queue WHERE job_type = 'permit_process_lookup' AND payload LIKE ? ORDER BY created_at", [`%${frag}%`]);
  try {
    // A pair with no reference process profile (a known profile short-circuits the lookup on its own).
    const pid = mk({ ahj: "City Of Srowanmere", city: "Rowanmere", zip: "97456" });
    assert.equal(pendingAhj(pid).length, 1, "the fixture is a near-miss");
    await tick();
    assert.equal(jobs("srowanmere").length, 0, "no lookup for a jurisdiction that may not exist");
    updateProject(db, pid, { ahj: "City of Rowanmere" });
    assert.equal(pendingAhj(pid).length, 0);
    await tick();
    assert.equal(jobs('"lookupKey":"or|city of rowanmere"').length, 1, `queued once the name is confirmed: ${JSON.stringify(jobs("rowanmere").map((j) => j.payload))}`);
    assert.equal(jobs("srowanmere").length, 0);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    db.run("UPDATE job_queue SET status = 'failed' WHERE job_type = 'permit_process_lookup' AND status IN ('pending','running')");
  }
});

await check("C2 the chain's acquire_forms step waits for the answer (build_docs still runs); a project without the question acquires", async () => {
  process.env.AUTO_STAGE_STEPS = "1";
  try {
    const asking = mk();
    const out = await processStageStep(db, asking);
    assert.ok(!out.ran.includes("acquire_forms"), `ran: ${out.ran.join(", ")}`);
    assert.ok(out.ran.some((s) => s.startsWith("build_docs")), `build_docs must still run: ${out.ran.join(", ")}`);
    const plain = mk({ ahj: "City of Monroe" });
    const out2 = await processStageStep(db, plain);
    assert.ok(out2.ran.includes("acquire_forms"), `ran: ${out2.ran.join(", ")}`);
  } finally {
    delete process.env.AUTO_STAGE_STEPS;
  }
});

console.log("\nD. KILL — with the predicate disabled the must-pass case files nothing (the fixture depends on the fix)");
await check("D1 AHJ_NEAR_MISS_CHECK=off: Smonroe / Monroe passes silently — exactly the live defect A1 would catch", () => {
  process.env.AHJ_NEAR_MISS_CHECK = "off";
  try {
    const pid = mk();
    assert.deepEqual(ahjItems(pid).map((i) => i.issueType), [], "without the predicate no item is filed (A1's assertion would FAIL here)");
    assert.equal(ahjRow(pid).qcStatus, "pass");
  } finally {
    delete process.env.AHJ_NEAR_MISS_CHECK;
  }
});

console.log(`\nahjNearMiss.test: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
