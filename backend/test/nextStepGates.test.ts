// THE GATES THE NEXT STEP READS — each fix pinned by a check that FAILS without it.
//
//   S2  canApprove is no longer "no reviewer blockers" alone: a draft with required fields the
//       project has no data for, or a document ITS OWN track's filing owes, refuses it, in words.
//       Asked per TRACK of the awaiting draft: a failed sibling track (project stage_detail
//       staging_failed), a failed RE-run on the same track, or another lane's missing document
//       does not.
//   S3  the autopilot phase is evaluated LIVE: an old job that ended blocked no longer pins
//       BLOCKED on a project whose gate is clean (the job's result is `lastRun`, history).
//   S4  lane summary: the LATEST check per target; reviewed_by_ahj is "in review", never
//       "NEM approved"; a track isTrackDone reads done.
//   S5  isBlocked (list AND detail) is true for an overdue correction whatever the status.
//   S6  permit_status readings do not gate QC / staging — and a real QC review item still does.
//   S7  the submit gate says submitted_tracking only when EVERY required track is filed.
//   S8  canStage + stageDisabledReason on the autopilot state — including a submit gate that
//       blocks the tracks it would stage (and not one only an already-staged track answers to).
//   T1a trackAlreadyStaged compares track FAMILIES ('permit' ≡ 'combo', 'structural' ≡ 'building').
//   T1b reopenCorrectionOnPortal forwards the runner's driftWarnings (result + audit payload).
//
//   npx tsx backend/test/nextStepGates.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so filled/ docs/ page-images never land in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "next-step-gates-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
delete process.env.SMTP_HOST;
delete process.env.CLIENT_NOTIFICATIONS;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { saveProjectDocument } = await import("../src/projectDocuments");
const {
  createProject, getProjectList, getProjectDetail, getSubmitGateReport, prepareSubmission, setProjectStatusByOperator,
  addManualCorrection, createPermitCheckTarget, recordPermitStatusCheck, captureConfirmation, reopenCorrectionOnPortal,
  computeLaneStatusSummary, stagingMissingDocuments,
} = await import("../src/repository");
const { documentInventory } = await import("../src/requiredDocuments");
const { getAutopilotState, trackAlreadyStaged, tracksToStage } = await import("../src/autopilot");
const { requiredTracks } = await import("../src/submittalTracks");
const { HttpError } = await import("../src/httpError");
const { markSubmissionPaid } = await import("../src/submissionFees");
type PermitStatusCheck = import("../../shared/src/types").PermitStatusCheck;

const db = await openDatabase();
let failures = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> => Promise.resolve()
  .then(fn)
  .then(() => { console.log(`  ok   - ${label}`); })
  .catch((err) => { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); });

const createdIds: string[] = [];
const client = createClient(db, {
  companyName: "Gate Truth Solar LLC", legalBusinessName: "Gate Truth Solar LLC", ccbLicenseNumber: "240135",
  electricalLicenseNumber: "C1234", businessEmail: "ops@gatetruth.test", businessPhone: "(503) 555-0142",
});
// The smoke's own fixture (backend/src/smoke.ts): proven to clear QC, the document gate and the reviewer gate.
const FIXTURE: Record<string, string> = {
  street: "123 Solar Way", city: "Portland", state: "OR", zip: "97201", ahj: "Portland", utility: "PGE",
  account: "1234567890", meter: "987654321", dcKw: "8.6", acKw: "6.5", exportKw: "6.5", moduleMake: "Qcells",
  moduleModel: "Q.TRON BLK M-G2.C1+/AC", moduleWattage: "430", moduleQty: "20", invModel: "IQ8M", invQty: "20", invOutputW: "325",
  interco: "Load-side breaker", busRating: "200", mainBreaker: "200", pvBreaker: "40", permitPath: "PRESCRIPTIVE",
  roofRafterSpacing: "24", roofRafterSpan: "10", snow: "25", deadLoad: "3.2", wind: "B",
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
let seq = 0;
const mkProject = (over: Record<string, string> = {}): string => {
  const d = createProject(db, { clientId: client.id, owner: `Gate Owner ${++seq}`, ...FIXTURE, ...over });
  createdIds.push(d.project.id);
  saveProjectDocument(db, d.project.id, {
    docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% gate truth plan set\n", "utf8"), source: "upload",
  });
  return d.project.id;
};
/** A portal_run in the shape prepareSubmission writes (the submitSeam fixture's helper). */
const mkRun = (pid: string, status: string, permitType: string, startedAt: string, result: Record<string, unknown> = { actor: "RecipeAdapter", ok: true }): string => {
  const runId = `run-${++seq}`;
  db.run(
    `INSERT INTO portal_runs (id, project_id, portal_profile_id, run_type, status, started_at, error_message,
       human_action_required, screenshots_path, logs_path, result_json, permit_type)
     VALUES (?, ?, NULL, 'prepare_submit', ?, ?, ?, 0, '', '', ?, ?)`,
    [runId, pid, status, startedAt, status === "failed" ? "login form not found" : "", JSON.stringify(result), permitType],
  );
  return runId;
};
const park = (pid: string, stageDetail = "staged_for_review"): void => {
  db.run("UPDATE projects SET status = 'awaiting_human_submit', stage_detail = ? WHERE id = ?", [stageDetail, pid]);
};

// ── S2 ─────────────────────────────────────────────────────────────────────────────────
await check("S2 control: a clean staged draft is approvable", () => {
  const pid = mkProject();
  park(pid);
  mkRun(pid, "awaiting_human_submit", "nem", "2026-09-20T10:00:00.000Z");
  const s = getAutopilotState(db, pid);
  assert.equal(s.phase, "awaiting_approval");
  assert.equal(s.canApprove, true, `refused: ${s.approveDisabledReason}`);
  assert.equal(s.approveDisabledReason, null);
});

/** What prepareSubmission's write path does when an adapter FAILS: it inserts the failed run and
 *  overwrites the PROJECT's stage_detail with `staging_failed`, leaving status at its pre-run
 *  value (repository.ts, the `adapterFailed ? "staging_failed"` UPDATE) — for whichever track ran. */
const failStage = (pid: string, permitType: string, startedAt: string): string => {
  const runId = mkRun(pid, "failed", permitType, startedAt);
  db.run("UPDATE projects SET stage_detail = 'staging_failed' WHERE id = ?", [pid]);
  return runId;
};

await check("S2 MUST NOT: a failed SIBLING track (project stage_detail staging_failed) does not refuse this track's draft — it is said", () => {
  // 7ec74634: NEM staged, then a building/electrical run failed and wrote staging_failed.
  const pid = mkProject();
  park(pid);
  mkRun(pid, "awaiting_human_submit", "nem", "2026-09-20T10:00:00.000Z");
  failStage(pid, "combo", "2026-09-20T11:00:00.000Z");
  assert.equal(getProjectDetail(db, pid).project.stageDetail, "staging_failed", "precondition: the project-level flag is set by the sibling's failure");
  const s = getAutopilotState(db, pid);
  assert.equal(s.canApprove, true, `a good NEM draft refused over a failed combo run: ${s.approveDisabledReason}`);
  assert.equal(s.approveDisabledReason, null);
  assert.match(s.message, /Staging failed for combo/i, "the failed sibling track is still named");
});

// The plan set's roof-framing sheet is not in it: the structural detail is REQUIRED and missing —
// a permit-lane document, so the project gate blocks on document-inventory (and only there)
// while the NEM filing owes nothing.
const mkPermitDocMissing = (): string => {
  const pid = mkProject({ splitPagesText: FIXTURE.splitPagesText.replace(/^03 Roof framing and racking attachment detail: pages 4-5$\n?/m, "") });
  const gate = getSubmitGateReport(db, pid);
  const docs = gate.checks.find((c) => c.id === "document-inventory")!;
  assert.equal(gate.decision, "blocked", `precondition: the gate blocks (${gate.decision})`);
  assert.equal(docs.status, "blocker", "precondition: on the document check");
  assert.deepEqual(gate.checks.filter((c) => c.status === "blocker").map((c) => c.id), ["document-inventory"], `precondition: ONLY the document check (${gate.checks.filter((c) => c.status === "blocker").map((c) => `${c.id}: ${c.nextAction}`).join(" | ")})`);
  assert.equal(stagingMissingDocuments(documentInventory(db, getProjectDetail(db, pid).project), "nem").length, 0, "precondition: the NEM filing owes no missing document");
  assert.ok(stagingMissingDocuments(documentInventory(db, getProjectDetail(db, pid).project), "combo").length > 0, "precondition: the permit filing does");
  return pid;
};

await check("S2 MUST NOT: a NEM draft is not refused over a PERMIT-lane missing document (29cd57b5)", () => {
  const pid = mkPermitDocMissing();
  park(pid);
  mkRun(pid, "awaiting_human_submit", "nem", "2026-09-20T10:00:00.000Z");
  const s = getAutopilotState(db, pid);
  assert.equal(s.canApprove, true, `NEM draft refused over the permit lane's document: ${s.approveDisabledReason}`);
});

await check("S2 MUST STILL REFUSE: the PERMIT draft on the same project is refused, naming the document", () => {
  const pid = mkPermitDocMissing();
  park(pid);
  mkRun(pid, "awaiting_human_submit", "combo", "2026-09-20T10:00:00.000Z");
  const s = getAutopilotState(db, pid);
  assert.equal(s.canApprove, false, "a permit draft missing its own required document read as approvable");
  assert.match(String(s.approveDisabledReason), /submit gate is blocked: .*combo filing: .*structural/i, String(s.approveDisabledReason));
});

await check("S2: a staged draft with required fields the project has no data for → not approvable", () => {
  const pid = mkProject();
  park(pid);
  mkRun(pid, "awaiting_human_submit", "nem", "2026-09-20T10:00:00.000Z", {
    actor: "RecipeAdapter", ok: true, steps: [{ ok: true, data: { gapFill: { reportedMissing: ["Utility account holder"] } } }],
  });
  const s = getAutopilotState(db, pid);
  assert.equal(s.canApprove, false);
  assert.match(String(s.approveDisabledReason), /no project data/);
});

await check("S2 MUST NOT: a failed RE-run behind a staged draft on the SAME track does not refuse the draft", () => {
  const pid = mkProject();
  park(pid);
  mkRun(pid, "awaiting_human_submit", "nem", "2026-09-20T10:00:00.000Z");
  mkRun(pid, "failed", "nem", "2026-09-20T11:00:00.000Z");
  const s = getAutopilotState(db, pid);
  assert.equal(s.canApprove, true, `refused: ${s.approveDisabledReason}`);
});

// ── S3 ─────────────────────────────────────────────────────────────────────────────────
const insertAutopilotJob = (pid: string, status: string, result: unknown, finishedAt: string, error = ""): void => {
  db.run(
    `INSERT INTO job_queue (id, job_type, payload, status, priority, project_id, created_at, progress, progress_total, retry_count, max_retries, org_id, result, finished_at, error)
     VALUES (?, 'autopilot', '{"origin":"operator"}', ?, 5, ?, ?, 0, 0, 0, 0, 'default', ?, ?, ?)`,
    [`job-${++seq}`, status, pid, finishedAt, result == null ? null : JSON.stringify(result), finishedAt, error],
  );
};

await check("S3: a job that ended BLOCKED no longer pins BLOCKED once the gate is clean — it is history", () => {
  const pid = mkProject();
  assert.equal(getSubmitGateReport(db, pid).decision, "ready_to_stage", "precondition: the fixture's gate is clean");
  insertAutopilotJob(pid, "done", { blocked: true, blockers: [{ code: "qc_fail", detail: "combo: 2 QC failure(s) must be resolved." }], message: "blocked on QC" }, "2026-09-19T10:00:00.000Z");
  const s = getAutopilotState(db, pid);
  assert.equal(s.phase, "idle", `phase ${s.phase} — the old job result is being replayed as the live state`);
  assert.deepEqual(s.blockers, []);
  assert.equal(s.lastRun?.blocked, true, "the old outcome is kept as history");
  assert.match(s.message, /nothing blocks it now/);
});

await check("S3: a LIVE blocker (the operator's block) reads blocked even with no autopilot job at all", () => {
  const pid = mkProject();
  setProjectStatusByOperator(db, pid, "blocked", "waiting on the customer's signature", "test operator");
  const s = getAutopilotState(db, pid);
  assert.equal(s.phase, "blocked");
  assert.ok(s.blockers.some((b) => b.code === "operator_blocked"), JSON.stringify(s.blockers));
});

await check("S3: the per-submission PAYMENT gate (the 402) is re-derived live — never 'nothing blocks it now'", () => {
  const payClient = createClient(db, { companyName: "PerSub Gate Solar", legalBusinessName: "PerSub Gate Solar", billingMode: "per_submission", serviceFeeUsd: "175", ccbLicenseNumber: "240136" });
  const d = createProject(db, { clientId: payClient.id, owner: "Pay Owner", ...FIXTURE });
  const pid = d.project.id;
  createdIds.push(pid);
  saveProjectDocument(db, pid, { docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%\n", "utf8"), source: "upload" });
  insertAutopilotJob(pid, "done", { blocked: true, blockers: [{ code: "payment_required", detail: "Payment required before staging" }], message: "402" }, "2026-09-19T10:00:00.000Z");
  const s = getAutopilotState(db, pid);
  assert.equal(s.phase, "blocked", `phase ${s.phase}: an unpaid per-submission project read as clear`);
  assert.ok(s.blockers.some((b) => b.code === "payment_required"), JSON.stringify(s.blockers));
  assert.equal(s.nextStep.key, "payment_due");
  for (const t of ["permit", "nem"]) markSubmissionPaid(db, getProjectDetail(db, pid).project, t, { paymentReference: `INV-${t}` });
  const after = getAutopilotState(db, pid);
  assert.ok(!after.blockers.some((b) => b.code === "payment_required"), `still blocked on payment after mark-paid: ${JSON.stringify(after.blockers)}`);
  assert.notEqual(after.nextStep.key, "payment_due");
});

await check("S3: a last-run blocker no live check can re-derive is KEPT (marked as the last run's), not called clear", () => {
  const pid = mkProject();
  insertAutopilotJob(pid, "done", { blocked: true, blockers: [{ code: "blocked", detail: "The nem track was staged to the portal by another run while this one was preparing." }], message: "409" }, "2026-09-19T10:00:00.000Z");
  const s = getAutopilotState(db, pid);
  assert.equal(s.phase, "blocked");
  assert.ok(s.blockers.some((b) => /Last autopilot run: .*another run/.test(b.detail)), JSON.stringify(s.blockers));
});

// 3b9ce10c: the only live blocker was a failed staging run and Stage portals was ENABLED — the
// retry is the fix, yet the phase read BLOCKED. It reads the failure now; the reason is kept.
await check("S3: a failed staging run is the ONLY live blocker and Stage portals is on → phase 'failed' (retry), never 'blocked'", () => {
  const pid = mkProject();
  failStage(pid, "combo", "2026-09-20T11:00:00.000Z");
  const s = getAutopilotState(db, pid);
  assert.equal(s.canStage, true, `precondition: re-staging is allowed (${s.stageDisabledReason})`);
  assert.deepEqual(s.blockers.map((b) => b.code), ["stage_failed"], "precondition: the failed run is the only live blocker");
  assert.equal(s.phase, "failed", `phase ${s.phase} beside an enabled Stage portals — restaging is the fix`);
  assert.match(s.blockers[0].detail, /combo: login form not found/, "the failure reason is still carried for the rail's reason line");
  assert.equal(s.message, s.nextStep.headline, "the rail and the banner say the same sentence");
});

await check("S3 MUST STILL BLOCK: a failed staging run PLUS another live blocker (operator block / owed document) reads blocked", () => {
  const held = mkProject();
  failStage(held, "combo", "2026-09-20T11:00:00.000Z");
  setProjectStatusByOperator(db, held, "blocked", "waiting on the customer", "test operator");
  const a = getAutopilotState(db, held);
  assert.equal(a.phase, "blocked", `operator-held: ${a.phase}`);
  const docs = mkPermitDocMissing();
  failStage(docs, "nem", "2026-09-20T11:00:00.000Z");
  const b = getAutopilotState(db, docs);
  assert.ok(b.blockers.some((x) => x.code === "stage_failed"), `precondition: ${JSON.stringify(b.blockers)}`);
  assert.equal(b.phase, "blocked", `an owed document beside the failed run: ${b.phase}`);
});

// The two cases above also have Stage portals DISABLED, so they would still read blocked if the
// retry rule forgot to require that EVERY live blocker is the failed run. An unpaid per-submission
// charge does not disable Stage portals (canStage stays true) but IS a live blocker: the retry
// would run straight into the 402. This is the case that pins `.every` and `&& canStage` apart.
await check("S3 MUST STILL BLOCK: a failed staging run beside an unpaid per-submission charge (Stage portals still enabled) reads blocked", () => {
  const payClient = createClient(db, { companyName: "PerSub Retry Solar", legalBusinessName: "PerSub Retry Solar", billingMode: "per_submission", serviceFeeUsd: "175", ccbLicenseNumber: "240137" });
  const d = createProject(db, { clientId: payClient.id, owner: "Retry Pay Owner", ...FIXTURE });
  const pid = d.project.id;
  createdIds.push(pid);
  saveProjectDocument(db, pid, { docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%\n", "utf8"), source: "upload" });
  failStage(pid, "combo", "2026-09-20T11:00:00.000Z");
  const s = getAutopilotState(db, pid);
  assert.deepEqual(s.blockers.map((b) => b.code).sort(), ["payment_required", "stage_failed"], `precondition: exactly these two live blockers: ${JSON.stringify(s.blockers)}`);
  assert.equal(s.canStage, true, `precondition: Stage portals is enabled (${s.stageDisabledReason}) — otherwise this case does not reach the retry rule`);
  assert.equal(s.phase, "blocked", `phase ${s.phase}: an unpaid charge beside the failed run read as a plain retry`);
});

// …and the other half of the rule: the failed run IS the only live blocker, but Stage portals is
// DISABLED (a staging job for this project is already queued — the autopilot job itself is not in
// flight, so the rail does not short-circuit to 'running'). A "re-stage" phase beside a disabled
// button is the 3b9ce10c confusion in reverse; it keeps BLOCKED, with the failure still printed.
await check("S3 MUST STILL BLOCK: a failed staging run as the only live blocker, with Stage portals DISABLED, reads blocked", () => {
  const pid = mkProject();
  failStage(pid, "combo", "2026-09-20T11:00:00.000Z");
  db.run(
    `INSERT INTO job_queue (id, job_type, payload, status, priority, project_id, created_at, progress, progress_total, retry_count, max_retries, org_id)
     VALUES (?, 'prepare_submission', '{}', 'pending', 5, ?, ?, 0, 0, 0, 0, 'default')`,
    [`job-${++seq}`, pid, "2026-09-20T11:05:00.000Z"],
  );
  const s = getAutopilotState(db, pid);
  assert.deepEqual([...new Set(s.blockers.map((b) => b.code))], ["stage_failed"], `precondition: the failed run is the only live blocker: ${JSON.stringify(s.blockers)}`);
  assert.equal(s.canStage, false, "precondition: Stage portals is disabled while a staging job is queued");
  assert.equal(s.phase, "blocked", `phase ${s.phase} beside a DISABLED Stage portals`);
  db.run("DELETE FROM job_queue WHERE project_id = ?", [pid]);
});

// ── S8 ─────────────────────────────────────────────────────────────────────────────────
await check("S8: canStage — true on a clean pre-stage project, false with a reason when blocked / past Submit / all staged", () => {
  const fresh = mkProject();
  const a = getAutopilotState(db, fresh);
  assert.equal(a.canStage, true, String(a.stageDisabledReason));
  assert.equal(a.stageDisabledReason, null);

  const held = mkProject();
  setProjectStatusByOperator(db, held, "blocked", "hold", "test operator");
  const b = getAutopilotState(db, held);
  assert.equal(b.canStage, false);
  assert.match(String(b.stageDisabledReason), /operator/i);

  const past = mkProject();
  setProjectStatusByOperator(db, past, "issued", "filed by hand", "test operator");
  const c = getAutopilotState(db, past);
  assert.equal(c.canStage, false);
  assert.match(String(c.stageDisabledReason), /past Submit/);

  const allStaged = mkProject();
  for (const t of requiredTracks(getProjectDetail(db, allStaged).project)) mkRun(allStaged, "awaiting_human_submit", t, "2026-09-20T10:00:00.000Z");
  park(allStaged);
  const d = getAutopilotState(db, allStaged);
  assert.equal(d.canStage, false);
  assert.match(String(d.stageDisabledReason), /already staged or filed/);
});

await check("S8: a blocked submit gate for the tracks it would stage switches Stage portals OFF, saying why (e6b3afde)", () => {
  // Project-wide blocker (a QC review item) — every track is held.
  const qc = mkProject({ locateCalloutText: "" });
  assert.equal(getSubmitGateReport(db, qc).decision, "blocked", "precondition: the gate blocks");
  const a = getAutopilotState(db, qc);
  assert.equal(a.canStage, false, "Stage portals enabled while the submit gate refuses every track");
  assert.match(String(a.stageDisabledReason), /submit gate holds back the nem, combo filing/);
  assert.doesNotMatch(String(a.stageDisabledReason), /can be staged on their own/, "a project-wide blocker leaves no track free");
  // A document the PERMIT filing owes, with the permit still to stage.
  const docs = mkPermitDocMissing();
  const b = getAutopilotState(db, docs);
  assert.equal(b.canStage, false);
  assert.match(String(b.stageDisabledReason), /holds back the combo filing\(s\): .*combo filing: .*structural/i, String(b.stageDisabledReason));
  assert.match(String(b.stageDisabledReason), /The nem track\(s\) can be staged on their own/, "the track the gate does not hold is named as stageable");
});

await check("S8 MUST NOT: a document only an ALREADY-STAGED track owes does not hold back staging the other track", () => {
  const pid = mkPermitDocMissing();
  mkRun(pid, "awaiting_human_submit", "combo", "2026-09-20T10:00:00.000Z");
  park(pid);
  const s = getAutopilotState(db, pid);
  assert.equal(s.canStage, true, `NEM staging held by the permit lane's document: ${s.stageDisabledReason}`);
});

// ── T1a ────────────────────────────────────────────────────────────────────────────────
await check("T1a: a trackless 'permit' draft IS the combo track; a 'structural' draft IS the building track", () => {
  const pid = mkProject();
  mkRun(pid, "awaiting_human_submit", "permit", "2026-09-20T10:00:00.000Z");
  assert.equal(trackAlreadyStaged(db, pid, "combo"), true, "a 'permit' draft was invisible to the combo re-check — a second draft of the same application");
  assert.equal(trackAlreadyStaged(db, pid, "permit"), true);
  assert.ok(!tracksToStage(db, getProjectDetail(db, pid).project).includes("combo"), "Segment A would stage combo again");
  mkRun(pid, "awaiting_human_submit", "structural", "2026-09-20T10:00:00.000Z");
  assert.equal(trackAlreadyStaged(db, pid, "building"), true);
  assert.equal(trackAlreadyStaged(db, pid, "electrical"), false, "MUST NOT: another discipline is not staged by it");
});

// ── S4 ─────────────────────────────────────────────────────────────────────────────────
const chk = (over: Partial<PermitStatusCheck>): PermitStatusCheck => ({
  id: `chk-${++seq}`, projectId: "p", targetId: "t1", targetType: "nem", source: "portal", rawStatusText: "", statusLabel: "",
  outcome: "waiting", confidence: 0.8, correctionId: null, reviewedByAhj: false, readyForIssue: false, issueFeeDue: false,
  applicationNumber: "", permitNumber: "", message: "", createdAt: "2026-09-20T10:00:00.000Z", ...over,
} as PermitStatusCheck);

await check("S4: reviewed_by_ahj on the NEM target is IN REVIEW, never 'NEM approved'", () => {
  const s = computeLaneStatusSummary("submitted", [chk({ outcome: "reviewed_by_ahj", reviewedByAhj: true })], []);
  assert.equal(s.nemApproved, false);
  assert.equal(computeLaneStatusSummary("submitted", [chk({ outcome: "nem_approved" })], []).nemApproved, true);
});

await check("S4: the LATEST check per target speaks — an older ready_for_issue behind a newer correction is not ready", () => {
  const checks = [
    chk({ targetId: "p1", targetType: "permit", outcome: "correction_flagged", createdAt: "2026-09-21T00:00:00.000Z" }),
    chk({ targetId: "p1", targetType: "permit", outcome: "ready_for_issue", readyForIssue: true, createdAt: "2026-09-10T00:00:00.000Z" }),
  ];
  assert.equal(computeLaneStatusSummary("submitted", checks, []).readyForIssue, false);
});

await check("S4: a track isTrackDone calls done reads done even when its newest reading moved on (finaled)", () => {
  const checks = [chk({ targetId: "n1", targetType: "nem", outcome: "needs_human_review" })];
  assert.equal(computeLaneStatusSummary("submitted", checks, [], { permit: false, nem: true }).nemApproved, true);
});

// ── S5 ─────────────────────────────────────────────────────────────────────────────────
await check("S5: an OVERDUE correction marks the project blocked on the list AND the detail, whatever its status", () => {
  const pid = mkProject();
  addManualCorrection(db, pid, "The AHJ asks for a revised single-line diagram showing the PV breaker location.");
  // The monitor rewrites status every sweep — a correction open for days sits at `submitted`.
  setProjectStatusByOperator(db, pid, "submitted", "the monitor's view", "test operator");
  db.run("UPDATE corrections SET due_at = '2020-01-01' WHERE project_id = ?", [pid]);
  const row = getProjectList(db, { limit: 500 }).projects.find((p) => p.id === pid)!;
  assert.equal(row.overdueCorrections, 1);
  assert.equal(row.isBlocked, true, "the list's isBlocked missed an overdue correction");
  assert.equal(row.nextStep.urgency, "overdue");
  assert.equal(getProjectDetail(db, pid).isBlocked, true, "the detail's isBlocked missed an overdue correction");
});

// ── S6 ─────────────────────────────────────────────────────────────────────────────────
const qcGateStatus = (pid: string): string => getSubmitGateReport(db, pid).checks.find((c) => c.id === "qc-human-review")!.status;
const stagingQcRefusal = async (pid: string): Promise<number | null> => {
  try {
    await prepareSubmission(db, pid);
    return null;
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) {
      const d = (err.details ?? {}) as Record<string, unknown>;
      return Number(d.pendingCount ?? 0);
    }
    throw err;
  }
};

await check("S6: a pending permit_status reading (the monitor's real write path) does NOT hold the QC gate or staging", async () => {
  const pid = mkProject();
  const target = createPermitCheckTarget(db, pid, { jurisdiction: "Portland", applicationNumber: "999-26-000777-STR", targetType: "permit", permitType: "combo" }).permitCheckTargets[0];
  await recordPermitStatusCheck(db, pid, { targetId: target.id, source: "portal", rawStatusText: "Record Status: Intake Requirements Needed. Submitted 09/02/2026." });
  const pending = getProjectDetail(db, pid).humanReviewItems.filter((i) => i.status === "pending" && i.fieldName === "permit_status");
  assert.equal(pending.length, 1, "precondition: the monitor filed a permit_status review item");
  assert.notEqual(qcGateStatus(pid), "blocker", "a portal reading turned the QC gate red");
  const refusal = await stagingQcRefusal(pid);
  assert.ok(!refusal, `prepareSubmission refused on ${refusal} pending review item(s) — a portal reading gated staging`);
});

await check("S6 MUST STILL BLOCK: a real QC review item (Required locates) holds the gate AND staging", async () => {
  const pid = mkProject({ locateCalloutText: "" });
  const pending = getProjectDetail(db, pid).humanReviewItems.filter((i) => i.status === "pending" && i.fieldName === "locates");
  assert.equal(pending.length, 1, "precondition: QC filed the locates review item");
  assert.equal(qcGateStatus(pid), "blocker");
  const refusal = await stagingQcRefusal(pid);
  assert.ok(refusal && refusal >= 1, `prepareSubmission did not refuse a pending QC item (refusal=${refusal})`);
});

// ── S7 ─────────────────────────────────────────────────────────────────────────────────
await check("S7: NEM filed, permit not → the gate does NOT say submitted_tracking, and names what is still to file", () => {
  const pid = mkProject();
  const runId = mkRun(pid, "awaiting_human_submit", "nem", "2026-09-20T10:00:00.000Z");
  // The submissions row prepareSubmission writes beside its run; captureConfirmation promotes it.
  db.run(
    `INSERT INTO submissions (id, project_id, submission_type, status, permit_type, created_at)
     VALUES (?, ?, 'interconnection', 'awaiting_human_submit', 'nem', ?)`,
    [`sub-${++seq}`, pid, "2026-09-20T10:00:00.000Z"],
  );
  captureConfirmation(db, runId, { applicationNumber: "APP-424242", confirmationNumber: "C-1", submittedBy: "test operator" });
  assert.ok(getProjectDetail(db, pid).submissions.some((s) => s.status === "submitted"), "precondition: NEM is filed");
  const gate = getSubmitGateReport(db, pid);
  assert.notEqual(gate.decision, "submitted_tracking", "one filed track read as 'Submitted/tracking' while the permit is unfiled");
  const closeout = gate.checks.find((c) => c.id === "closeout-approvals")!;
  assert.ok(closeout.evidence.some((e) => /Still to file: combo/.test(e)), JSON.stringify(closeout.evidence));
});

await check("S7: a numbered tracking target is filing evidence — both permits tracked + NEM filed reads submitted_tracking", () => {
  const pid = mkProject();
  db.run(
    `INSERT INTO submissions (id, project_id, submission_type, status, permit_type, created_at, submitted_at)
     VALUES (?, ?, 'interconnection', 'submitted', 'nem', ?, ?)`,
    [`sub-${++seq}`, pid, "2026-09-20T10:00:00.000Z", "2026-09-20T10:00:00.000Z"],
  );
  assert.notEqual(getSubmitGateReport(db, pid).decision, "submitted_tracking", "precondition: the permit is still owed");
  createPermitCheckTarget(db, pid, { jurisdiction: "Portland", applicationNumber: "999-26-000888-PV", targetType: "permit", permitType: "combo" });
  assert.equal(getSubmitGateReport(db, pid).decision, "submitted_tracking",
    "a permit the monitor tracks by its application number is on file — the gate must not invite staging it again");
});

await check("S7 MUST NOT: a project moved past Submit with NO filing recorded anywhere keeps the status's word (no Prepare on a filed job)", () => {
  const pid = mkProject();
  setProjectStatusByOperator(db, pid, "issued", "filed and issued outside the system", "test operator");
  const gate = getSubmitGateReport(db, pid);
  assert.equal(gate.decision, "submitted_tracking");
  assert.equal(gate.canPrepareSubmission, false, "the trackless Prepare Submittal would open a duplicate draft of a filed application");
});

// ── T1b ────────────────────────────────────────────────────────────────────────────────
await check("T1b: reopenCorrectionOnPortal forwards the runner's driftWarnings — result AND audit payload", async () => {
  const pid = mkProject({ ahj: "City of Coos Bay", utility: "Pacific Power", city: "Coos Bay" });
  db.run(
    `INSERT INTO submissions (id, project_id, submission_type, status, application_number, permit_type, created_at)
     VALUES (?, ?, 'nem', 'submitted', 'APP-888001', 'nem', ?)`,
    [`sub-${++seq}`, pid, new Date().toISOString()],
  );
  createPermitCheckTarget(db, pid, { targetType: "nem", permitType: "nem", applicationNumber: "APP-888001", portalName: "Pacific Power", portalUrl: "https://nem.example-utility.test/app", checkFrequencyDays: 14 });
  const corrected = addManualCorrection(db, pid, "The utility suspended the interconnection: provide a photo of the meter face.");
  const warnings = ["could not attach sld to \"One-line diagram\": file input rejected the upload — attach it by hand"];
  const runner = (async () => ({
    ok: true, needsHuman: false, finalSubmitClicked: false, finalSubmitClickedByAutomation: false,
    reopenedForm: "Interconnection Correction Form", attachedDocs: 1, browserLeftOpen: false, message: "", offeredForms: [],
    driftWarnings: warnings,
  })) as never;
  const result = await reopenCorrectionOnPortal(db, corrected.corrections[0].id, { runner });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.driftWarnings, warnings, "the result dropped the runner's driftWarnings");
  const audit = db.get<{ details: string }>("SELECT details FROM audit_logs WHERE project_id = ? AND action = 'correction.reopened_on_portal' ORDER BY created_at DESC LIMIT 1", [pid]);
  assert.deepEqual(JSON.parse(String(audit?.details)).driftWarnings, warnings, "the audit payload dropped them");
});

// ── S8 / S2 — a form the system FILLS ITSELF at staging is not the operator's to attach ────────
// 29cd57b5 / 8f4ca8dd: the prescriptive checklist's template was on file, the filled PDF not yet
// produced. prepareSubmission fills (prepareOfficialDocuments) BEFORE its own document count, so
// staging would succeed — but canStage read the pre-fill inventory and said "attach … checklist".
const { storeAhjFormTemplate } = await import("../src/ahjFormAuto");
const { gateBlockersForTracks } = await import("../src/autopilot");
const SALEM = { ahj: "City of Salem", city: "Salem", zip: "97301" };
const permitSideMissing = (pid: string): string[] => {
  const inv = documentInventory(db, getProjectDetail(db, pid).project);
  return [...new Set(requiredTracks(getProjectDetail(db, pid).project).filter((t) => t !== "nem")
    .flatMap((t) => stagingMissingDocuments(inv, t).map((d) => d.docType)))];
};
const storeSalemChecklist = (): void => {
  // The REAL write path (acquisition / upload store through it), not a raw INSERT.
  storeAhjFormTemplate(db, {
    ahjName: "City of Salem", state: "OR", formType: "solar_checklist",
    filename: "Oregon BCD 5952 Prescriptive Solar Installation Checklist.pdf",
    bytes: new Uint8Array(Buffer.from("%PDF-1.4\n% checklist blank\n", "utf8")),
    map: { formName: "Oregon BCD 5952 Prescriptive Solar Installation Checklist", fillMode: "acroform", textFields: { "Owner Name": "project.owner" }, checkboxes: {} } as never,
    applicationKind: "prescriptive",
  });
};

await check("S8/S2: the checklist's template is ON FILE but not yet filled (29cd57b5) → Stage portals ON, Approve not refused over it", () => {
  const pid = mkProject(SALEM);
  assert.deepEqual(permitSideMissing(pid), ["solar_checklist"], "precondition: the permit side owes exactly the prescriptive checklist");
  const before = getAutopilotState(db, pid);
  assert.equal(before.canStage, false, "precondition: with no template on file the checklist genuinely holds staging");
  assert.match(String(before.stageDisabledReason), /prescriptive checklist/i);

  storeSalemChecklist();
  assert.deepEqual(permitSideMissing(pid), ["solar_checklist"], "precondition: the filled form is NOT produced yet — only the fill at staging makes it");
  const s = getAutopilotState(db, pid);
  assert.equal(s.canStage, true, `staging disabled over a form the staging-time fill produces: ${s.stageDisabledReason}`);
  assert.equal(s.stageDisabledReason, null);

  // The same scoping on Approve: a building draft already went through the fill.
  mkRun(pid, "awaiting_human_submit", "building", "2026-09-20T10:00:00.000Z");
  park(pid);
  const a = getAutopilotState(db, pid);
  assert.doesNotMatch(String(a.approveDisabledReason), /checklist/i, `Approve refused over a form the system fills itself: ${a.approveDisabledReason}`);
  assert.equal(a.canApprove, true, String(a.approveDisabledReason));
});

// ONE QUESTION, ONE PREDICATE: the submit gate's own document check asks what the operator OWES,
// the same answer Stage / Approve read. Before, the gate still counted the fill-produced checklist,
// so nextStep rule 7 said "The submit gate is blocked: attach … checklist" and the autopilot phase
// read BLOCKED beside an ENABLED Stage portals (29cd57b5, e6b3afde).
const docCheck = (pid: string) => getSubmitGateReport(db, pid).checks.find((c) => c.id === "document-inventory")!;
await check("ONE PREDICATE: checklist template on file, form not yet filled → no gate document blocker, no gate_blocked banner, phase not blocked", () => {
  storeSalemChecklist(); // idempotent — this check stands alone
  const pid = mkProject(SALEM);
  assert.deepEqual(permitSideMissing(pid), ["solar_checklist"], "precondition: the raw inventory still says the filled checklist is not on disk");
  const doc = docCheck(pid);
  const s = getAutopilotState(db, pid);
  // Every surface is asked, and every disagreement reported — one assert would hide the rest.
  const wrong = [
    doc.status === "blocker" ? `gate document check is a blocker: ${doc.nextAction}` : "",
    /Attach or split out/i.test(doc.nextAction) ? `gate asks to attach: ${doc.nextAction}` : "",
    doc.evidence.some((e) => /MISSING \(required\): .*checklist/i.test(e)) ? "gate evidence lists the checklist as MISSING" : "",
    !doc.evidence.some((e) => /^Filled at staging: .*checklist/i.test(e)) ? `the held-out row is not SAID on the panel: ${JSON.stringify(doc.evidence)}` : "",
    s.nextStep.key === "gate_blocked" ? `banner: ${s.nextStep.headline}` : "",
    s.phase === "blocked" ? `autopilot phase blocked: ${JSON.stringify(s.blockers)}` : "",
    s.canStage !== true ? `Stage portals off: ${s.stageDisabledReason}` : "",
  ].filter(Boolean);
  assert.deepEqual(wrong, [], wrong.join("\n         "));
});

await check("ONE PREDICATE MUST STILL BLOCK: a genuinely missing upload-only document (PE letter) blocks the gate, the banner and the phase", () => {
  storeSalemChecklist();
  const eng = mkProject({ ...SALEM, permitPath: "ENGINEERED" });
  const doc = docCheck(eng);
  assert.equal(doc.status, "blocker");
  assert.match(doc.nextAction, /PE-stamped/);
  const s = getAutopilotState(db, eng);
  assert.equal(s.nextStep.key, "gate_blocked", `banner: ${s.nextStep.key} ${s.nextStep.headline}`);
  assert.equal(s.phase, "blocked");
  assert.equal(s.canStage, false);
});

// The packet screen (assembleApplicationDocumentPackage → pkg.missingDocuments) and the QC
// early-warning rows read documentInventory RAW, so both still said the prescriptive checklist was
// "NOT in the packet" / "not attached — staging will refuse without it" beside a gate that said
// "Filled at staging" (e6b3afde, 29cd57b5). Same answer everywhere now: held out, and named.
const { getApplicationDocumentPackage } = await import("../src/repository");
const qcDocRows = (pid: string) => db.query<{ rule_id: string; qc_status: string; message: string }>(
  "SELECT rule_id, qc_status, message FROM qc_results WHERE project_id = ? AND rule_id LIKE 'docs.%'", [pid]);
await check("ONE PREDICATE: the packet screen and QC do not call a fill-produced form missing — they name it 'filled at staging'", () => {
  storeSalemChecklist();
  const pid = mkProject(SALEM); // createProject runs QC — AFTER the template is on file
  assert.deepEqual(permitSideMissing(pid), ["solar_checklist"], "precondition: the raw inventory still says the filled checklist is not on disk");
  const pkg = getApplicationDocumentPackage(db, pid);
  const rows = qcDocRows(pid);
  const wrong = [
    pkg.missingDocumentsStatus !== "resolved" ? `packet inventory unresolved: ${pkg.missingDocumentsError}` : "",
    (pkg.missingDocuments || []).some((d) => d.docType === "solar_checklist") ? "packet lists the checklist as MISSING" : "",
    !(pkg.filledAtStagingDocuments || []).some((d) => d.docType === "solar_checklist") ? `packet does not name it as filled at staging: ${JSON.stringify(pkg.filledAtStagingDocuments)}` : "",
    rows.some((r) => r.rule_id === "docs.solar_checklist" && r.qc_status === "warning") ? "QC warns the checklist is not attached" : "",
    !rows.some((r) => r.rule_id === "docs.solar_checklist" && r.qc_status === "pass" && /filled at staging/i.test(r.message)) ? `QC does not say it is filled at staging: ${JSON.stringify(rows)}` : "",
  ].filter(Boolean);
  assert.deepEqual(wrong, [], wrong.join("\n         "));
});

await check("ONE PREDICATE MUST STILL WARN: a document only a person can supply (PE letter) stays missing on the packet AND a QC warning", () => {
  storeSalemChecklist();
  const eng = mkProject({ ...SALEM, permitPath: "ENGINEERED" });
  const pkg = getApplicationDocumentPackage(db, eng);
  assert.ok((pkg.missingDocuments || []).some((d) => d.docType === "structural_letter"), `packet: ${JSON.stringify(pkg.missingDocuments)}`);
  assert.ok(!(pkg.filledAtStagingDocuments || []).some((d) => d.docType === "structural_letter"), "a PE letter read as filled at staging");
  assert.ok(qcDocRows(eng).some((r) => r.rule_id === "docs.structural_letter" && r.qc_status === "warning"), JSON.stringify(qcDocRows(eng)));
});

await check("ONE PREDICATE: the packet card renders the held-out form as 'filled at staging', never 'NOT in the packet'", () => {
  // The REAL documentVerdictHtml (+ the esc / plural it closes over), lifted out of dashboard.js.
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "../../frontend/dashboard.js"), "utf8");
  const cut = (name: string): string => {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at > -1, `${name} is gone from dashboard.js`);
    let depth = 0;
    for (let j = src.indexOf("{", at); j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) return src.slice(at, j + 1);
    }
    throw new Error(`unbalanced braces reading ${name}`);
  };
  // eslint-disable-next-line no-new-func
  const verdict = new Function(`${[cut("esc"), cut("plural"), cut("documentVerdictHtml")].join("\n\n")}\nreturn documentVerdictHtml;`)() as (pkg: unknown) => string;
  const held = [{ docType: "solar_checklist", label: "Solar prescriptive checklist, <b>filled</b>", lane: "permit", why: "" }];
  const html = verdict({ missingFields: [], missingDocumentsStatus: "resolved", missingDocuments: [], filledAtStagingDocuments: held });
  assert.match(html, /1 required form filled at staging/, html);
  assert.match(html, /Solar prescriptive checklist, &lt;b&gt;filled/, "the held-out form is named (esc()'d)");
  assert.doesNotMatch(html, /NOT in the packet/, "a form staging fills read as missing");
  // MUST STILL: an owed document beside it is still named as missing.
  const both = verdict({ missingFields: [], missingDocumentsStatus: "resolved", missingDocuments: [{ docType: "structural_letter", label: "PE-stamped structural letter", lane: "permit", why: "engineered" }], filledAtStagingDocuments: held });
  assert.match(both, /1 required document NOT in the packet/);
  assert.match(both, /filled at staging/);
});

await check("ONE PREDICATE: only a PERMIT-lane row is ever held out as 'filled at staging' (the fill never runs on the NEM lane)", async () => {
  storeSalemChecklist();
  const { owedMissingDocuments } = await import("../src/requiredDocuments");
  const project = getProjectDetail(db, mkProject(SALEM)).project;
  const inv = documentInventory(db, project);
  const row = inv.missingBlocking.find((d) => d.docType === "solar_checklist")!;
  assert.ok(row, "precondition: the checklist row is missing");
  assert.deepEqual(owedMissingDocuments(db, project, inv).owed, [], "control: the permit-lane checklist is held out");
  const nemRow = { ...row, lane: "nem" as const };
  const asNem = { ...inv, missingBlocking: [nemRow] };
  assert.deepEqual(owedMissingDocuments(db, project, asNem).owed, [nemRow], "a NEM-lane row was cleared by a fill that never runs there");
});

await check("S8 MUST STILL HOLD: an upload-only document (PE-stamped letter) is named; the fill-produced checklist never is", () => {
  storeSalemChecklist(); // idempotent (dedupes on ahj/state/form_type) — this check stands alone
  // Engineered path: the sealed structural letter is owed and NOTHING fills it.
  const eng = mkProject({ ...SALEM, permitPath: "ENGINEERED" });
  assert.ok(permitSideMissing(eng).includes("structural_letter"), `precondition: the PE letter is owed (${permitSideMissing(eng).join(", ")})`);
  const e = getAutopilotState(db, eng);
  assert.equal(e.canStage, false, "Stage portals enabled while a document only a person can supply is missing");
  assert.match(String(e.stageDisabledReason), /PE-stamped/);
  // Prescriptive, checklist template on file, AND a genuinely missing plan-set sheet: still held,
  // and the reason asks only for the sheet — never for the form the system fills.
  const mixed = mkProject({ ...SALEM, splitPagesText: FIXTURE.splitPagesText.replace(/^03 Roof framing and racking attachment detail: pages 4-5$\n?/m, "") });
  assert.deepEqual(permitSideMissing(mixed).sort(), ["solar_checklist", "structural"], `precondition: ${permitSideMissing(mixed).join(", ")}`);
  const m = getAutopilotState(db, mixed);
  assert.equal(m.canStage, false);
  assert.match(String(m.stageDisabledReason), /roof framing/i);
  assert.doesNotMatch(String(m.stageDisabledReason), /checklist/i, `the reason asks the operator to attach a form the system fills: ${m.stageDisabledReason}`);
});

await check("S8 MUST STILL HOLD: an OFF-PATH template (a STRUCTURAL application on a prescriptive project) is not 'filled at staging'", () => {
  // Coos Bay: separate BLD + ELE permits, so the path-chosen building application blocks. The fill
  // skips a structural blank on the prescriptive path (formAllowedForPath), so it cannot clear the row.
  const COOS = { ahj: "City of Coos Bay", city: "Coos Bay", zip: "97420", utility: "Pacific Power" };
  const pid = mkProject(COOS);
  assert.ok(permitSideMissing(pid).includes("building_application"), `precondition: the building application is owed (${permitSideMissing(pid).join(", ")})`);
  storeAhjFormTemplate(db, {
    ahjName: "City of Coos Bay", state: "OR", formType: "building_application",
    filename: "Structural Permit Application.pdf",
    bytes: new Uint8Array(Buffer.from("%PDF-1.4\n% structural blank\n", "utf8")),
    map: { formName: "Structural (Non-Prescriptive) Permit Application", fillMode: "acroform", textFields: { "Owner Name": "project.owner" }, checkboxes: {} } as never,
    applicationKind: "structural",
  });
  const s = getAutopilotState(db, pid);
  assert.equal(s.canStage, false, "an off-path structural blank read as producing the prescriptive application");
  assert.match(String(s.stageDisabledReason), /Prescriptive solar permit application/i, String(s.stageDisabledReason));
});

// ── permit-path is a PERMIT-side blocker (prepareSubmission asks it only off the NEM lane) ─────
await check("gateBlockersForTracks: a permit-path blocker holds the permit tracks, never NEM", () => {
  const project = getProjectDetail(db, mkProject()).project;
  const gate = { decision: "blocked", blockers: [{ id: "permit-path", title: "Permit path", nextAction: "Confirm the permit path." }] } as never;
  const held = gateBlockersForTracks(db, project, gate, ["nem", "building", "electrical"]);
  assert.deepEqual(held.map((b) => [b.id, b.tracks]), [["permit-path", ["building", "electrical"]]], JSON.stringify(held));
  assert.deepEqual(gateBlockersForTracks(db, project, gate, ["nem"]), [], "NEM staging held by the permit path");
  // Control: a project-wide blocker holds every track, NEM included.
  const qc = { decision: "blocked", blockers: [{ id: "qc-human-review", title: "QC", nextAction: "Resolve QC." }] } as never;
  assert.deepEqual(gateBlockersForTracks(db, project, qc, ["nem"]).map((b) => b.tracks), [["nem"]]);
});

// ── the gate's document evidence keeps every line that NAMES a document state ──────────────────
// submitGateCheck capped each check's evidence at 6 lines, and the document check writes the
// count line and up to 4 present-document lines FIRST — so on a project with 4+ documents present
// (e6b3afde) its "Missing (advisory): …" line was cut on the server, the check read WARNING, and
// its nextAction ("Confirm the advisory document(s)…") named none: the advisory doc was named
// nowhere. The state-naming lines (Filled at staging / MISSING (required) / Missing (advisory))
// are never capped; only the rest is.
await check("gate evidence: 'Missing (advisory): …' survives beside 4+ present documents (never capped away)", () => {
  // No label schedule anywhere → TWO advisory rows (labels + the filled checklist) beside 6 present.
  const NL = String.fromCharCode(10);
  const pid = mkProject({ labelsText: "", splitPagesText: FIXTURE.splitPagesText.split(NL).filter((l) => !/label/i.test(l)).join(NL) });
  const doc = getSubmitGateReport(db, pid).checks.find((c) => c.id === "document-inventory")!;
  const presentCount = Number(/^(\d+)\/\d+ required documents present/.exec(doc.evidence[0] ?? "")?.[1] ?? 0);
  assert.ok(presentCount >= 4, `precondition: 4+ present documents (their lines filled the old cap): ${JSON.stringify(doc.evidence)}`);
  assert.equal(doc.status, "warning", `precondition: the advisory documents make the check a warning: ${doc.status}`);
  for (const name of [/label/i, /checklist/i]) {
    assert.ok(doc.evidence.some((e) => e.startsWith("Missing (advisory): ") && name.test(e)), `advisory ${name} is named nowhere: ${JSON.stringify(doc.evidence)}`);
  }
  assert.ok(doc.evidence.some((e) => e.startsWith("✓ ")), `the present lines still share the rest of the cap: ${JSON.stringify(doc.evidence)}`);
  const namedCount = doc.evidence.filter((e) => /^(Filled at staging:|MISSING \(required\):|Missing \(advisory\):)/.test(e)).length;
  assert.ok(doc.evidence.length - namedCount <= Math.max(0, 6 - namedCount), `the other lines share what the named ones leave of the 6-line cap: ${JSON.stringify(doc.evidence)}`);
});

for (const pid of createdIds) fs.rmSync(path.resolve("backend/data/filled", pid), { recursive: true, force: true });

if (failures) {
  console.error(`\nnextStepGates: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nnextStepGates: all checks passed");
