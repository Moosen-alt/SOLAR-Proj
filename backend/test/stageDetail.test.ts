// THE SUB-STAGE WAS A SENTENCE, AND THE ONLY WAY OUT OF A WRONG STATUS WAS SQL.
//
// Two defects, one column, one route.
//
//   1. `projects.current_stage` is free text in every one of its writers — "PGE staged. Human
//      must verify and submit manually.", "QC passed: ready to stage" — and the permit monitor
//      OVERWRITES it with a raw portal message while changing no status at all. Nothing could
//      filter on it and nothing could render from it, so the dashboard rendered the status enum
//      instead and the sub-stage simply wasn't shown. `stage_detail` is the machine half,
//      written ALONGSIDE the prose (a stored label is a matching key — not one of those eleven
//      strings is rewritten by the change this file guards).
//
//   2. `updateProject` deliberately excludes `status` (a re-parse must never un-submit a
//      filing), so a drifted status had NO recovery path. Live: PacifiCorp APP-111681 was
//      corrected and resubmitted inside PowerClerk and the row had to be fixed by hand with
//      SQL against production. `setProjectStatusByOperator` is the audited door.
//
// WHAT THIS FILE REFUSES TO LET REGRESS:
//
//   MUST WRITE    — stage_detail on the real writer paths: QC (runQcForProject), STAGING
//                   (prepareSubmission against the mock portal, the smoke's own recipe), and
//                   HANDOFF (recordPermitStatusCheck driving issued + nem_approved through
//                   triggerHandoffIfReady). Read back from the DATABASE, never from a return
//                   value — a function can return a tidy record while writing nothing.
//   MUST DISTINGUISH — staged / paused / failed. A paused and a failed run BOTH leave the
//                   status at its pre-run value, so before this column the difference between
//                   "finish the MFA challenge in the browser that is still open" and "the
//                   adapter died, retry" existed only inside a sentence.
//   MUST NOT WRITE — the permit monitor's needs_human_review stomp. It overwrites current_stage
//                   with a raw portal message and changes no status; letting it touch
//                   stage_detail would re-import the exact bug the column exists to escape.
//   MUST AUDIT    — every override, with actor, reason, and from/to. A status that moved with
//                   no record of who or why is how drift becomes unexplainable.
//   MUST REFUSE   — an override with no reason (400), an override to a status that isn't one
//                   (400 — free text in projects.status is the disease, not the cure), and an
//                   override to `handoff_ready` (409). handoff_ready is COMPUTED: forcing it
//                   publishes an installer handoff checklist and drops the job off the board
//                   for a permit that may not exist.
//   MUST NOT LOSE — the prose. Every current_stage string this round touched is asserted
//                   byte-for-byte against the string production wrote before the column landed.
//   MUST CLEAR    — a stale stage_detail on override. A project moved out of
//                   awaiting_human_submit while the detail still read `staged_for_review` would
//                   keep claiming a filing sits on a portal review screen.
//
// The HTTP half of the override (tenancy 404, the route's own 400/409) is in tenancy.test.ts,
// where two real orgs and a booted server already exist: a foreign-tenant 404 asserted alone
// proves nothing, because a route that does not exist 404s too. That file asserts the PAIR —
// the same request succeeding on your own project and 404ing on someone else's.
//
//   npx tsx backend/test/stageDetail.test.ts
import { REPO } from "./_isolate"; // FIRST: runs in a temp cwd so filled/ docs/ page-images never land in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-detail-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
// createProject enqueues a self-kicking autopilot job. Left on, that job stages in the
// background and writes the very column this file asserts — every check here would pass for
// the wrong reason, or flake.
process.env.AUTOPILOT_AUTO_START = "0";
// The mock portal is the simulated portal here, exactly as backend/src/smoke.ts declares it:
// auto-seed OFF (a real portal with no recipe must surface a blocker, not silently mock) plus
// the EXPLICIT simulation opt-in. Both are required — MOCK_PORTAL alone is not a fallback.
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
delete process.env.SMTP_HOST;
delete process.env.CLIENT_NOTIFICATIONS;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { saveProjectDocument } = await import("../src/projectDocuments");
const {
  createProject, prepareSubmission, createPermitCheckTarget, recordPermitStatusCheck,
  setProjectStatusByOperator, getProjectDetail, getProjectList,
} = await import("../src/repository");
const { runQcForProject } = await import("../src/qc");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> => Promise.resolve()
  .then(fn)
  .then(() => { console.log(`  ok   - ${label}`); })
  .catch((err) => { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); });

// EVERY ASSERTION READS THE ROW. The payload is checked separately and on purpose: a column
// that is written but never mapped is invisible to the dashboard, and a payload field computed
// in the mapper is a lie if the column behind it is empty.
const detailOf = (projectId: string): string => String(
  db.get<{ stage_detail?: string }>("SELECT stage_detail FROM projects WHERE id = ?", [projectId])?.stage_detail ?? "",
);
const stageOf = (projectId: string): string => String(
  db.get<{ current_stage?: string }>("SELECT current_stage FROM projects WHERE id = ?", [projectId])?.current_stage ?? "",
);
const statusOf = (projectId: string): string => String(
  db.get<{ status?: string }>("SELECT status FROM projects WHERE id = ?", [projectId])?.status ?? "",
);
const overrideAudits = (projectId: string) => db.query<{ actor_name: string; details: string }>(
  "SELECT actor_name, details FROM audit_logs WHERE project_id = ? AND action = 'project.status_overridden' ORDER BY created_at",
  [projectId],
);

// The submitting contractor: the CCB gate refuses to stage without one.
const client = createClient(db, {
  companyName: "Stage Detail Solar LLC",
  legalBusinessName: "Stage Detail Solar LLC",
  ccbLicenseNumber: "240135",
  electricalLicenseNumber: "C1234",
  businessEmail: "ops@stagedetail.test",
  businessPhone: "(503) 555-0142",
});

// The smoke's own fixture, field for field (backend/src/smoke.ts): a Portland / PGE
// prescriptive job that is PROVEN to clear QC, the document gate and the reviewer gate. A
// hand-rolled project fails one of those three and the failure reads like a stage_detail bug.
const FIXTURE = {
  owner: "Stage Detail Owner",
  street: "123 Solar Way",
  city: "Portland",
  state: "OR",
  zip: "97201",
  ahj: "Portland",
  utility: "PGE",
  account: "1234567890",
  meter: "987654321",
  dcKw: "8.6",
  acKw: "6.5",
  exportKw: "6.5",
  moduleMake: "Qcells",
  moduleModel: "Q.TRON BLK M-G2.C1+/AC",
  moduleWattage: "430",
  moduleQty: "20",
  invModel: "IQ8M",
  invQty: "20",
  invOutputW: "325",
  interco: "Load-side breaker",
  busRating: "200",
  mainBreaker: "200",
  pvBreaker: "40",
  permitPath: "PRESCRIPTIVE",
  roofRafterSpacing: "24",
  roofRafterSpan: "10",
  snow: "25",
  deadLoad: "3.2",
  wind: "B",
  locateCalloutText: "No locate-triggering scope found.",
  sitePlanNotesText: "Roof plan shows fire access pathway, ridge/eave setbacks, array dimensions, service equipment, and PV layout.",
  roofPlanNotesText: "Roof framing: 2x6 rafters at 24 inches on center, 10 ft clear span, roof slope 5:12. Racking attachment detail shows flashed standoffs lagged to rafters.",
  structuralCalcText: "Oregon prescriptive rooftop PV worksheet complete. Dead load 3.2 psf, ground snow 25 psf, wind exposure B, rafter span checked.",
  electricalCalcText: "NEC 705.12 load-side calculation: 200A bus x 120 percent = 240A, 200A main + 40A PV breaker = 240A. NEC 690.12 rapid shutdown shown.",
  labelsText: "PV label schedule includes rapid shutdown label, service power source directory, disconnect labels, and backfed breaker warning.",
  splitPagesText: "01 Site/Roof Plan and PV layout with fire pathway: pages 1-2\n02 SLD 3-Line Diagram with NEC 705.12 calculation and rapid shutdown: page 3\n03 Roof framing and racking attachment detail: pages 4-5\n04 Module spec UL 61730: pages 6-8\n05 Inverter spec UL 1741 SB: pages 9-11\n06 Label schedule and placards: page 12",
  utilityDownloadChecklistText: "PGE package includes SLD/3-line, site/plot plan, module spec, inverter spec, utility bill, meter data, and account data.",
  packetReadinessText: "READY - Plan set\nREADY - Utility bill\nREADY - Module spec\nREADY - Inverter spec",
};

// ═══════════════════════════════════════════════════════════════════════════════════════
// PART 1 — THE WRITE PATHS. Real production functions only; the assertions are column reads.
// ═══════════════════════════════════════════════════════════════════════════════════════

const passing = createProject(db, { clientId: client.id, ...FIXTURE });
const passingId = passing.project.id;

await check("QC PASS writes stage_detail — through runQcForProject, the only QC writer", () => {
  assert.equal(statusOf(passingId), "qc_passed", `fixture did not clear QC: ${statusOf(passingId)}`);
  assert.equal(detailOf(passingId), "qc_passed",
    `QC passed and stage_detail is "${detailOf(passingId)}" — the QC gate is writing status and prose `
    + "but not the enum, so nothing downstream can tell a passed project from an unchecked one");
  // THE PROSE IS UNTOUCHED. This is the exact string production wrote before the column landed.
  assert.equal(stageOf(passingId), "QC passed: ready to stage",
    "current_stage was rewritten — a stored label is a matching key and this round does not move one");
});

await check("QC FAIL writes the other verdict, and the two never disagree", () => {
  // A project with nothing in it fails QC. Its own row, so the passing one is untouched.
  const failing = createProject(db, { clientId: client.id, owner: "No Data Owner", street: "9 Empty Way", city: "Portland", state: "OR", ahj: "Portland", utility: "PGE" });
  const failingId = failing.project.id;
  assert.equal(statusOf(failingId), "qc_failed", `expected qc_failed, got ${statusOf(failingId)}`);
  assert.equal(detailOf(failingId), "qc_failed", `stage_detail is "${detailOf(failingId)}"`);
  assert.equal(stageOf(failingId), "QC failed: human review required", "current_stage prose moved");

  // Re-running QC is the real path an operator takes after fixing data; it must rewrite both.
  runQcForProject(db, failingId);
  assert.equal(detailOf(failingId), "qc_failed", "a re-run left a stale stage_detail behind");
});

// The document-presence gate wants the real file, not just the parsed sheet map.
saveProjectDocument(db, passingId, {
  docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf",
  buffer: Buffer.from("%PDF-1.4\n% stage detail plan set\n", "utf8"), source: "upload",
});

await check("STAGING writes staged_for_review — through prepareSubmission, the real staging writer", async () => {
  const staged = await prepareSubmission(db, passingId);
  // If this is not the mock, the env pins above failed and a REAL adapter was selected. Say so
  // here rather than letting the stage_detail assertion below take the blame.
  const run = staged.portalRuns?.[0];
  assert.ok(run, "prepareSubmission recorded no portal run");
  assert.equal(statusOf(passingId), "awaiting_human_submit",
    `expected awaiting_human_submit after a mock stage, got ${statusOf(passingId)} — check PORTAL_AUTOSEED/MOCK_PORTAL`);
  assert.equal(detailOf(passingId), "staged_for_review",
    `staged, and stage_detail is "${detailOf(passingId)}" — the one state hard rule 1 exists to `
    + "protect (a human must verify and click submit) is the one the board cannot see");
  assert.match(stageOf(passingId), /staged\. Human must verify and submit manually\.$/,
    "the staging prose was rewritten");
});

await check("stage_detail SHIPS on both payloads — the list and the detail, from one mapper", () => {
  const detail = getProjectDetail(db, passingId);
  assert.equal(detail.project.stageDetail, "staged_for_review",
    "the detail payload drops stage_detail — a column no payload carries is a column the dashboard cannot render");
  const listed = getProjectList(db, { limit: 500 }).projects.find((p) => p.id === passingId);
  assert.ok(listed, "the staged project fell out of the project list");
  assert.equal(listed!.stageDetail, "staged_for_review", "the LIST payload drops stage_detail");
});

await check("AN UNKNOWN STAYS UNKNOWN — a pre-column row reads \"\", never a value that implies progress", () => {
  // Exactly what every one of the sixteen live projects looks like the moment the migration
  // runs: the column exists and no writer has spoken for the row yet.
  const legacy = createProject(db, { clientId: client.id, ...FIXTURE, owner: "Legacy Row Owner", street: "5 Before Way" });
  db.run("UPDATE projects SET stage_detail = '' WHERE id = ?", [legacy.project.id]);
  assert.equal(detailOf(legacy.project.id), "", "setup failed");
  const payload = getProjectDetail(db, legacy.project.id).project.stageDetail;
  assert.equal(payload, "",
    `an unwritten stage_detail reached the payload as "${payload}" — a renderer would draw a chip `
    + "for it and announce progress no writer ever reported");
});

await check("HANDOFF writes handoff_ready — through recordPermitStatusCheck → triggerHandoffIfReady", async () => {
  const withTargets = createProject(db, { clientId: client.id, ...FIXTURE, owner: "Handoff Owner", street: "7 Done Way" });
  const handoffId = withTargets.project.id;
  createPermitCheckTarget(db, handoffId, {
    jurisdiction: "Portland", applicationNumber: "187-26-000309-STR", targetType: "permit", permitType: "building",
  });
  const after = createPermitCheckTarget(db, handoffId, {
    jurisdiction: "PGE", applicationNumber: "APP-111681", targetType: "nem", permitType: "nem",
  });
  const permitTarget = after.permitCheckTargets.find((t) => t.applicationNumber === "187-26-000309-STR")!;
  const nemTarget = after.permitCheckTargets.find((t) => t.applicationNumber === "APP-111681")!;

  // The real status strings, classified offline — the same fixtures statusHistoryTransitions uses.
  await recordPermitStatusCheck(db, handoffId, {
    targetId: permitTarget.id, source: "portal",
    rawStatusText: "Record Status: Issued. Permit issued 09/09/2026. Download permit card.",
  });
  assert.equal(detailOf(handoffId), "permit_issued",
    `the permit issued and stage_detail is "${detailOf(handoffId)}"`);

  await recordPermitStatusCheck(db, handoffId, {
    targetId: nemTarget.id, source: "portal",
    rawStatusText: "Interconnection application approved. Permission to operate granted.",
  });
  assert.equal(statusOf(handoffId), "handoff_ready", `expected handoff_ready, got ${statusOf(handoffId)}`);
  assert.equal(detailOf(handoffId), "handoff_ready",
    `permit issued AND NEM approved, and stage_detail is "${detailOf(handoffId)}" — the handoff `
    + "writer moved the status and left the sub-stage describing something that already happened");
  assert.equal(stageOf(handoffId), "Permit issued + NEM approved. Ready for installer handoff.",
    "the handoff prose was rewritten");
});

await check("THE MONITOR'S STOMP STAYS OUT — needs_human_review moves prose and NOTHING else", async () => {
  const stomped = createProject(db, { clientId: client.id, ...FIXTURE, owner: "Stomped Owner", street: "11 Noise Way" });
  const stompedId = stomped.project.id;
  const target = createPermitCheckTarget(db, stompedId, {
    jurisdiction: "Portland", applicationNumber: "999-26-000001-STR", targetType: "permit", permitType: "building",
  }).permitCheckTargets[0];

  const before = { status: statusOf(stompedId), detail: detailOf(stompedId) };
  assert.equal(before.detail, "qc_passed", "setup: expected the QC verdict to be the last thing written");

  // The operator's own live Coos Bay string. It classifies `needs_human_review` — the city is
  // waiting on US — and that is the branch that overwrites current_stage with the raw message
  // and changes no status. This is repository.ts's stomp, reached through the real monitor.
  await recordPermitStatusCheck(db, stompedId, {
    targetId: target.id, source: "portal",
    rawStatusText: "Record Status: Intake Requirements Needed. Submitted 09/02/2026.",
  });

  assert.equal(statusOf(stompedId), before.status, "the stomp changed the status — it never did before");
  assert.equal(detailOf(stompedId), before.detail,
    `the stomp wrote stage_detail ("${detailOf(stompedId)}", was "${before.detail}") — the enum now `
    + "carries the same ambiguity as the prose it was built to escape: a raw portal note masquerading "
    + "as a pipeline position");
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// PART 2 — THE OPERATOR OVERRIDE. The audited door out of a drifted status.
// ═══════════════════════════════════════════════════════════════════════════════════════

const drifted = createProject(db, { clientId: client.id, ...FIXTURE, owner: "Drifted Owner", street: "3 Stuck Way" });
const driftedId = drifted.project.id;

await check("the override moves the status AND records who, why, and from where", () => {
  const before = statusOf(driftedId);
  const result = setProjectStatusByOperator(db, driftedId, "submitted", "Resubmitted by hand in PowerClerk (APP-111681).", "operator@keelix.test");

  assert.equal(statusOf(driftedId), "submitted", `the status did not move: ${statusOf(driftedId)}`);
  assert.equal(result.project.status, "submitted", "the returned detail is stale — the UI would re-render the old status");

  const audits = overrideAudits(driftedId);
  assert.equal(audits.length, 1, `expected exactly one audit row, got ${audits.length}`);
  assert.equal(audits[0].actor_name, "operator@keelix.test", `the audit row names "${audits[0].actor_name}"`);
  const payload = JSON.parse(String(audits[0].details || "{}"));
  assert.equal(payload.from, before, `audit says from=${payload.from}, row was ${before}`);
  assert.equal(payload.to, "submitted", `audit says to=${payload.to}`);
  assert.match(String(payload.reason), /PowerClerk/,
    "the reason is missing from the audit row — without it the row says a human changed the status and nothing else, "
    + "which is the same dead end the hand-written SQL left behind");
});

await check("the override CLEARS a stale sub-stage instead of letting it lie", () => {
  // The drifted project above was staged at creation time? No — it was not, so seed the exact
  // hazard: a detail that describes a filing sitting on a portal review screen.
  db.run("UPDATE projects SET status = 'awaiting_human_submit', stage_detail = 'staged_for_review' WHERE id = ?", [driftedId]);
  setProjectStatusByOperator(db, driftedId, "blocked", "Homeowner paused the job pending an HOA decision.", "operator@keelix.test");
  assert.equal(statusOf(driftedId), "blocked", "blocked is unreachable — it has no other writer anywhere");
  assert.equal(detailOf(driftedId), "operator_override",
    `stage_detail survived the move as "${detailOf(driftedId)}" — the project now says a filing is `
    + "waiting on a portal review screen while its status says the job is blocked");
});

await check("…and the override is also the way BACK OUT of blocked", () => {
  setProjectStatusByOperator(db, driftedId, "submitted", "HOA approved; the filing is still on file.", "operator@keelix.test");
  assert.equal(statusOf(driftedId), "submitted", "a blocked project cannot be un-blocked");
});

const refusal = (fn: () => unknown): { status: number; message: string } => {
  try { fn(); return { status: 0, message: "no error thrown" }; }
  catch (err) {
    const e = err as { status?: number; message?: string };
    return { status: Number(e.status ?? 0), message: String(e.message ?? "") };
  }
};

await check("MUST REFUSE: an override with no reason — 400, and nothing moves", () => {
  const before = statusOf(driftedId);
  for (const reason of ["", "   ", "\n\t "]) {
    const out = refusal(() => setProjectStatusByOperator(db, driftedId, "issued", reason, "operator@keelix.test"));
    assert.equal(out.status, 400, `reason ${JSON.stringify(reason)} was accepted (${out.status}: ${out.message})`);
  }
  assert.equal(statusOf(driftedId), before, "a refused override still moved the status");
});

await check("MUST REFUSE: handoff_ready — it is computed from two approvals, never typed", () => {
  const before = { status: statusOf(driftedId), detail: detailOf(driftedId) };
  const out = refusal(() => setProjectStatusByOperator(db, driftedId, "handoff_ready", "Customer says it's done.", "operator@keelix.test"));
  assert.equal(out.status, 409,
    `handoff_ready was ACCEPTED (${out.status}: ${out.message}) — an operator can now publish an installer `
    + "handoff checklist and drop a job off the board for a permit that may not exist");
  assert.match(out.message, /computed/i, `the refusal does not explain itself: ${out.message}`);
  assert.equal(statusOf(driftedId), before.status, "the refused override still moved the status");
  assert.equal(detailOf(driftedId), before.detail, "the refused override still moved the sub-stage");
  assert.equal(overrideAudits(driftedId).length, 3, "a refused override wrote an audit row as if it had happened");
});

await check("MUST REFUSE: a status that is not one — free text never reaches projects.status", () => {
  const before = statusOf(driftedId);
  // The third is the point: a status REMOVED from the union (zero writers, dead vocabulary)
  // must not be reachable through the one route that writes status by hand.
  for (const bogus of ["", "banana", "submit_staging", "SUBMITTED", "issued; DROP TABLE projects"]) {
    const out = refusal(() => setProjectStatusByOperator(db, driftedId, bogus, "a real reason", "operator@keelix.test"));
    assert.equal(out.status, 400, `"${bogus}" was accepted (${out.status}: ${out.message})`);
  }
  assert.equal(statusOf(driftedId), before, "a refused override still moved the status");
});

await check("MUST REFUSE: an unknown project id — 404, before anything is written", () => {
  const out = refusal(() => setProjectStatusByOperator(db, "no-such-project", "submitted", "a real reason", "operator@keelix.test"));
  assert.equal(out.status, 404, `expected 404, got ${out.status}: ${out.message}`);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// PART 3 — THE ROUTE IS REGISTERED WHERE THE GUARD CAN REACH IT.
//
// tenancy.test.ts proves the scoping over real HTTP (own project 200 / foreign project 404).
// This is the cheap structural half: the route must live UNDER /api/projects/:id, because that
// is the mounted prefix the tenancy guard is registered on. A route moved to a new top-level
// path would still work, still pass its own tests, and silently lose its tenant scoping.
// ═══════════════════════════════════════════════════════════════════════════════════════

await check("the override route sits under the guarded /api/projects/:id prefix", () => {
  const server = fs.readFileSync(path.resolve(REPO, "backend/src/server.ts"), "utf8");
  assert.match(server, /app\.post\("\/api\/projects\/:id\/status"/,
    "POST /api/projects/:id/status is not registered — the repository function has no production caller");
  assert.match(server, /app\.use\("\/api\/projects\/:id",\s*scopeGuard\(/,
    "the /api/projects/:id scope guard is gone, so the override route no longer inherits tenancy scoping");
  // The refusals must live in the repository function, not the handler: a second caller
  // (a job, a script, a future route) must not be able to reach the UPDATE without them.
  const repo = fs.readFileSync(path.resolve(REPO, "backend/src/repository.ts"), "utf8");
  assert.match(repo, /export function setProjectStatusByOperator/, "the override writer is not exported");
  assert.ok(!/handoff_ready/.test(server.slice(server.indexOf('app.post("/api/projects/:id/status"'), server.indexOf('app.post("/api/projects/:id/status"') + 900)),
    "the handoff_ready refusal has leaked into the route handler — it belongs with the write");
});

console.log(failures === 0 ? "\nstageDetail: all checks passed" : `\nstageDetail: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
