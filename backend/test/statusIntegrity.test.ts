// FOUR WAYS A PROJECT'S STATUS WENT BACKWARD, OR SAID MORE THAN WAS TRUE.
//
// Measured on a scratch copy of the demo kit, each reproduced here through the real write
// paths (createProject, prepareSubmission against the mock portal, markTrackSubmitted,
// recordPermitStatusCheck source 'manual', humanVerify, updateProject, rerunQc) — no raw SQL
// sets up a status this file then asserts on.
//
//   1. QC REWIND. runQcForProject wrote qc_passed/qc_failed at ANY status, so a filed project
//      (ready_for_issue here) re-QC'd by Run QC, an edit, the workflow view, or — the live door —
//      approving a "Permit monitor status review" item, dropped to board column 2.
//   2. TRACKLESS RESTAGE. prepareSubmission with no track (the dashboard's Prepare Submittal)
//      skipped the already-filed guard and restaged a filed project: a duplicate application.
//   3. WAITING REWIND. A NEM / other-permit "still in review" reading recorded after the building
//      permit reached ready_for_issue rewrote the project to submitted.
//   4. FEES-DUE READ AS ISSUED. A ready_for_issue outcome made the track read "issued", not
//      outstanding, while the project said fees were due.
//
// And the repair round's additions:
//   3e. SCENARIO D. Only a PERMIT target's progress may hold a permit status against a rewind.
//   1h-1j. A staged-never-filed project that took a correction re-stages from ready_to_resubmit.
//   5a-5f. LNK-5: an operator's `blocked` survives every QC door, and staging/resume refuse it.
//   8a-8d. LNK-8: a passing re-QC never demotes ready_to_stage nor resets its stage_detail.
//
//   npx tsx backend/test/statusIntegrity.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "status-integrity-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
// The mock portal, selected exactly as smoke.ts / stageDetail.test.ts select it.
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
delete process.env.PORTAL_AUTOMATION;
// Nothing leaves the machine and nothing runs in the background behind the assertions.
process.env.CLIENT_NOTIFICATIONS = "off";
process.env.BACKGROUND_WORKERS = "off";
process.env.DOCUMENT_FETCH = "off";
process.env.DOCUMENT_FETCH_BROWSER = "0";
process.env.AHJ_FORM_DOWNLOADS = "off";
process.env.AHJ_FORM_RESEARCH = "off";
process.env.FEE_RESEARCH = "off";
process.env.PORTAL_URL_RESEARCH = "off";
process.env.RUN_TRIAGE = "off";
process.env.AUTO_RELEARN_STALE = "0";
process.env.PORTAL_ALLOW_FINAL_SUBMIT = "false";
delete process.env.SMTP_HOST;
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { saveProjectDocument } = await import("../src/projectDocuments");
const R = await import("../src/repository");
const { markTrackSubmitted, getSubmittalTracks, requiredTracks } = await import("../src/submittalTracks");
const { stageForStatus } = await import("../src/projectStage");
const { runQcForProject } = await import("../src/qc");
const { maybeResumeAutopilot } = await import("../src/autopilot");

const db = await openDatabase();
const createdIds: string[] = [];

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

interface Row { [k: string]: unknown }
const row = (pid: string): Row => db.get<Row>("SELECT status, stage_detail, current_stage FROM projects WHERE id = ?", [pid])!;
const statusOf = (pid: string): string => String(row(pid).status ?? "");
const count = (sql: string, params: unknown[]): number => Number(db.get<{ n: number }>(sql, params as never)?.n ?? 0);
const targetFor = (pid: string, track: string): string => {
  const t = db.get<Row>("SELECT id FROM permit_check_targets WHERE project_id = ? AND permit_type = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1", [pid, track]);
  assert.ok(t, `no tracking target for the ${track} track — markTrackSubmitted should have created one`);
  return String(t!.id);
};
const readStatus = (pid: string, track: string, text: string) =>
  R.recordPermitStatusCheck(db, pid, { targetId: targetFor(pid, track), source: "manual", rawStatusText: text });
const refusalOf = async (fn: () => Promise<unknown>): Promise<{ status: number; message: string; details: Row } | null> => {
  try { await fn(); return null; }
  catch (err) {
    const e = err as { status?: number; message?: string; details?: Row };
    return { status: Number(e.status ?? 0), message: String(e.message ?? ""), details: e.details ?? {} };
  }
};

const READY_FOR_ISSUE = "Approved pending payment. Permit is ready to issue; issuance fees are due.";
const IN_REVIEW = "Engineering Review";
const ELECTRICAL_IN_REVIEW = "Plans assigned to reviewer - electrical plan review in progress.";
const ISSUED = "Permit issued. Download permit card from the portal.";

const client = createClient(db, {
  companyName: "Status Integrity Solar LLC",
  legalBusinessName: "Status Integrity Solar LLC",
  ccbLicenseNumber: "240136",
  electricalLicenseNumber: "C1235",
  businessEmail: "ops@statusintegrity.test",
  businessPhone: "(503) 555-0143",
});

// stageDetail.test.ts's fixture, field for field: a Portland / PGE prescriptive job PROVEN to
// clear QC, the document gate and the reviewer gate, so the mock stage actually runs.
const FIXTURE = {
  street: "123 Solar Way", city: "Portland", state: "OR", zip: "97201", ahj: "Portland", utility: "PGE",
  account: "1234567890", meter: "987654321", dcKw: "8.6", acKw: "6.5", exportKw: "6.5",
  moduleMake: "Qcells", moduleModel: "Q.TRON BLK M-G2.C1+/AC", moduleWattage: "430", moduleQty: "20",
  invModel: "IQ8M", invQty: "20", invOutputW: "325", interco: "Load-side breaker", busRating: "200",
  mainBreaker: "200", pvBreaker: "40", permitPath: "PRESCRIPTIVE", roofRafterSpacing: "24", roofRafterSpan: "10",
  snow: "25", deadLoad: "3.2", wind: "B",
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

const passingProject = (owner: string): string => {
  const pid = R.createProject(db, { clientId: client.id, owner, ...FIXTURE } as never).project.id;
  createdIds.push(pid);
  saveProjectDocument(db, pid, {
    docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% status integrity plan set\n", "utf8"), source: "upload",
  });
  return pid;
};

/** Stage every required track (mock), then record each as filed — the operator's two doors. */
const stageAndFile = async (pid: string): Promise<string[]> => {
  const tracks = requiredTracks(R.getProjectDetail(db, pid).project);
  for (const t of tracks) await R.prepareSubmission(db, pid, t, false, false);
  for (const t of tracks) {
    markTrackSubmitted(db, R.getProjectDetail(db, pid).project, t, {
      applicationNumber: `SI-${t.toUpperCase()}-0001`, submittedBy: "status integrity test",
    });
  }
  return tracks;
};

try {
  // ═══════════════════════════════════════════════════════════════════════════════════════
  // FIXTURE P1 — a Portland project staged, filed, and read ready_for_issue by the monitor.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  const p1 = passingProject("Filed Owner");
  await check("fixture: the passing project clears QC (so every gate below is the one under test)", () => {
    assert.equal(statusOf(p1), "qc_passed");
  });
  const p1Tracks = await stageAndFile(p1);
  await check("fixture: staged + filed through the real doors reads 'submitted'", () => {
    assert.deepEqual(p1Tracks, ["nem", "combo"], "Portland/PGE requires nem + combo");
    assert.equal(statusOf(p1), "submitted");
  });
  await readStatus(p1, "combo", READY_FOR_ISSUE);
  await check("fixture: the monitor's ready-for-issue reading moves it to 'ready_for_issue'", () => {
    assert.equal(statusOf(p1), "ready_for_issue");
    assert.equal(stageForStatus("ready_for_issue").key, "track");
  });

  // ── BUG 4: a fees-due track is not an issued track ─────────────────────────────────────
  await check("4a. a ready_for_issue outcome makes the track read 'ready_for_issue', NOT 'issued'", () => {
    const combo = getSubmittalTracks(db, R.getProjectDetail(db, p1).project).find((t) => t.type === "combo")!;
    assert.equal(combo.status, "ready_for_issue", `combo track status=${combo.status}`);
    assert.equal(combo.outstanding, true, "the fee is still owed — the track is outstanding");
    assert.doesNotMatch(combo.nextAction, /^Done/, `nextAction="${combo.nextAction}"`);
  });

  // ── BUG 1: re-running QC on a filed project must not rewind it ──────────────────────────
  const before = row(p1);
  R.rerunQc(db, p1);
  await check("1a. Run QC on a ready_for_issue project records results but leaves status + stage_detail", () => {
    assert.equal(statusOf(p1), "ready_for_issue");
    assert.equal(String(row(p1).stage_detail), String(before.stage_detail));
    assert.ok(count("SELECT COUNT(*) AS n FROM qc_results WHERE project_id = ?", [p1]) > 0, "QC still records its verdicts");
  });
  R.updateProject(db, p1, { jobValue: "30900" });
  await check("1b. a project edit (updateProject re-runs QC) leaves a filed project where it is", () => {
    assert.equal(statusOf(p1), "ready_for_issue");
  });
  R.runProjectWorkflow(db, p1);
  await check("1c. the workflow view (runProjectWorkflow re-runs QC) leaves it too", () => {
    assert.equal(statusOf(p1), "ready_for_issue");
  });
  // THE LIVE DOOR: the monitor files a status-review item on the filed project; approving it
  // runs humanVerify → runQcForProject.
  await readStatus(p1, "nem", "Intake Requirements Needed");
  const item = db.get<Row>(
    "SELECT id FROM human_review_items WHERE project_id = ? AND field_name = 'permit_status' AND status = 'pending' ORDER BY created_at DESC LIMIT 1", [p1]);
  await check("fixture: the monitor filed a 'Permit monitor status review' item on the filed project", () => {
    assert.ok(item, "no permit_status review item was filed");
  });
  if (item) R.humanVerify(db, p1, { reviewItemId: String(item.id), action: "approve" });
  await check("1d. approving the monitor's status-review item does NOT drop the filing to column 2", () => {
    assert.equal(statusOf(p1), "ready_for_issue", `status=${statusOf(p1)} (column ${stageForStatus(statusOf(p1) as never).key})`);
  });

  // ── BUG 2: trackless Prepare Submittal on a fully filed project ─────────────────────────
  const runsBefore = count("SELECT COUNT(*) AS n FROM portal_runs WHERE project_id = ?", [p1]);
  const subsBefore = count("SELECT COUNT(*) AS n FROM submissions WHERE project_id = ?", [p1]);
  const allFiled = await refusalOf(() => R.prepareSubmission(db, p1));
  await check("2a. trackless staging of a project whose every track is filed is refused outright (409)", () => {
    assert.ok(allFiled, "prepareSubmission(no track) RESOLVED on a fully filed project — a duplicate application");
    assert.equal(allFiled!.status, 409);
    assert.match(allFiled!.message, /^Every required track is already filed: /);
    assert.match(allFiled!.message, /nem track is already filed as SI-NEM-0001/);
    assert.match(allFiled!.message, /combo track is already filed as SI-COMBO-0001/);
    assert.match(allFiled!.message, /duplicate application/);
  });
  await check("2b. …and wrote nothing: no portal run, no submission, status unchanged", () => {
    assert.equal(count("SELECT COUNT(*) AS n FROM portal_runs WHERE project_id = ?", [p1]), runsBefore);
    assert.equal(count("SELECT COUNT(*) AS n FROM submissions WHERE project_id = ?", [p1]), subsBefore);
    assert.equal(statusOf(p1), "ready_for_issue");
  });

  // Bug 4, the other half: issuance moves the track to issued.
  await readStatus(p1, "combo", ISSUED);
  await check("4b. MUST PASS: an issued reading still moves the track to 'issued' (not outstanding)", () => {
    const combo = getSubmittalTracks(db, R.getProjectDetail(db, p1).project).find((t) => t.type === "combo")!;
    assert.equal(combo.status, "issued");
    assert.equal(combo.outstanding, false);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // P2 — one track filed, the other not: trackless refuses and names what is left.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  const p2 = passingProject("Half Filed Owner");
  await R.prepareSubmission(db, p2, "nem", false, false);
  markTrackSubmitted(db, R.getProjectDetail(db, p2).project, "nem", { applicationNumber: "SI-NEM-0002", submittedBy: "status integrity test" });
  const p2Runs = count("SELECT COUNT(*) AS n FROM portal_runs WHERE project_id = ?", [p2]);
  const partial = await refusalOf(() => R.prepareSubmission(db, p2));
  await check("2c. trackless staging with ONE track filed is refused with the per-track message shape", () => {
    assert.ok(partial, "prepareSubmission(no track) RESOLVED with the nem track already filed");
    assert.equal(partial!.status, 409);
    assert.match(partial!.message, /^The nem track is already filed as SI-NEM-0002 on \d{4}-\d{2}-\d{2}\. Staging again would open a duplicate application/);
    assert.equal(partial!.details.track, "nem");
    assert.equal(partial!.details.permitNumber, "SI-NEM-0002");
    assert.deepEqual(partial!.details.remaining, ["combo"], "the refusal names the track still to stage");
    assert.equal(count("SELECT COUNT(*) AS n FROM portal_runs WHERE project_id = ?", [p2]), p2Runs, "no run was recorded");
  });
  await check("2d. MUST PASS: the per-track call for the unfiled track still stages", async () => {
    await R.prepareSubmission(db, p2, "combo", false, false);
    assert.equal(statusOf(p2), "awaiting_human_submit");
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // P3 — the untouched path: a fresh project stages trackless; a second trackless call does not
  // open a second draft beside the first.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  const p3 = passingProject("Fresh Owner");
  await check("2e. MUST PASS: trackless staging of a fresh project still stages (the dashboard button works)", async () => {
    await R.prepareSubmission(db, p3);
    assert.equal(statusOf(p3), "awaiting_human_submit");
  });
  const p3Runs = count("SELECT COUNT(*) AS n FROM portal_runs WHERE project_id = ?", [p3]);
  const again = await refusalOf(() => R.prepareSubmission(db, p3));
  await check("2f. a second trackless stage is refused — its first run is still staged on the portal", () => {
    assert.ok(again, "a second trackless stage RESOLVED: a second portal draft beside the first");
    assert.equal(again!.status, 409);
    assert.match(again!.message, /already staged and awaiting a human submit/);
    assert.equal(count("SELECT COUNT(*) AS n FROM portal_runs WHERE project_id = ?", [p3]), p3Runs);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // P4 — pre-stage QC still moves status, and the correction loop back to re-stage still works.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  const p4 = passingProject("Correction Owner");
  await check("1e. MUST PASS: QC still writes status on a pre-stage project", () => {
    assert.equal(statusOf(p4), "qc_passed");
    db.run("DELETE FROM qc_results WHERE project_id = ?", [p4]);
    R.rerunQc(db, p4);
    assert.equal(statusOf(p4), "qc_passed");
    assert.equal(String(row(p4).stage_detail), "qc_passed");
  });
  const triaged = R.addManualCorrection(db, p4, "Please revise the one-line diagram to show the AC disconnect location.");
  const open = triaged.corrections.find((c) => !c.closedAt)!;
  R.resolveCorrection(db, open.id, { resubmitted: false });
  await check("fixture: resolving the correction with nothing on file lands on ready_to_resubmit", () => {
    assert.equal(statusOf(p4), "ready_to_resubmit");
  });
  R.rerunQc(db, p4);
  await check("1f. QC on ready_to_resubmit keeps it in the Submit column (no rewind to column 2)", () => {
    assert.equal(statusOf(p4), "ready_to_resubmit");
  });
  const restage = await refusalOf(() => R.prepareSubmission(db, p4));
  await check("1g/2g. MUST PASS: re-staging from ready_to_resubmit is not refused as a duplicate", () => {
    assert.ok(!restage || !/already (filed|staged)/.test(restage.message),
      `nothing is on file, yet staging was refused as a duplicate: ${restage?.message}`);
    if (!restage) assert.equal(statusOf(p4), "awaiting_human_submit");
    console.log(`         (ready_to_resubmit → prepareSubmission: ${restage ? `${restage.status} ${restage.message.slice(0, 110)}` : "staged"})`);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // P5 — BUG 3: separate building + electrical permits (Salem) plus NEM.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  const p5 = R.createProject(db, {
    clientId: client.id, owner: "Salem Owner", street: "905 Quarry Bend", city: "Salem", state: "OR", zip: "97301",
    ahj: "City of Salem", utility: "Portland General Electric", dcKw: "8.6", acKw: "5.8", permitPath: "prescriptive",
  } as never).project.id;
  createdIds.push(p5);
  const p5Tracks = requiredTracks(R.getProjectDetail(db, p5).project);
  await check("fixture: Salem files nem + building + electrical", () => {
    assert.deepEqual(p5Tracks, ["nem", "building", "electrical"]);
  });
  for (const t of p5Tracks) {
    markTrackSubmitted(db, R.getProjectDetail(db, p5).project, t, { applicationNumber: `SI-SLM-${t}`, submittedBy: "status integrity test" });
  }
  await readStatus(p5, "building", READY_FOR_ISSUE);
  await check("fixture: the building permit's reading puts the project at ready_for_issue", () => {
    assert.equal(statusOf(p5), "ready_for_issue");
  });
  await readStatus(p5, "nem", IN_REVIEW);
  await check("3a. a NEM 'in review' reading does not rewind the building permit's ready_for_issue", () => {
    assert.equal(statusOf(p5), "ready_for_issue", `status=${statusOf(p5)}`);
  });
  await readStatus(p5, "electrical", ELECTRICAL_IN_REVIEW);
  await check("3b. the ELECTRICAL permit's 'in review' does not rewind it either (same target_type, other track)", () => {
    assert.equal(statusOf(p5), "ready_for_issue", `status=${statusOf(p5)}`);
  });
  await check("4c. the building track reads ready_for_issue while electrical reads in review", () => {
    const tracks = getSubmittalTracks(db, R.getProjectDetail(db, p5).project);
    assert.equal(tracks.find((t) => t.type === "building")!.status, "ready_for_issue");
    assert.equal(tracks.find((t) => t.type === "electrical")!.status, "in_review");
  });
  await readStatus(p5, "building", IN_REVIEW);
  await check("3c. MUST PASS: the SAME filing regressing to 'in review' still moves the project to submitted", () => {
    assert.equal(statusOf(p5), "submitted", `status=${statusOf(p5)}`);
  });
  await readStatus(p5, "nem", IN_REVIEW);
  await check("3d. MUST PASS: an ordinary submitted project stays submitted on a waiting read", () => {
    assert.equal(statusOf(p5), "submitted");
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // P6 — SCENARIO D (skeptic): a NEM target's OWN "ready to issue" text must not pin the
  // permit's ready_for_issue when the permit filing that earned it regresses.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  const p6 = passingProject("Scenario D Owner");
  await stageAndFile(p6);
  await readStatus(p6, "nem", READY_FOR_ISSUE);
  await check("fixture: a NEM reading of 'ready to issue' text never WRITES the permit status", () => {
    assert.equal(statusOf(p6), "submitted");
    const nemOutcome = db.get<Row>("SELECT latest_outcome FROM permit_check_targets WHERE id = ?", [targetFor(p6, "nem")]);
    assert.equal(String(nemOutcome?.latest_outcome), "ready_for_issue", "the NEM target itself holds ready_for_issue");
  });
  await readStatus(p6, "combo", READY_FOR_ISSUE);
  await check("fixture: the combo permit's reading puts the project at ready_for_issue", () => {
    assert.equal(statusOf(p6), "ready_for_issue");
  });
  await readStatus(p6, "combo", IN_REVIEW);
  await check("3e. the combo permit regressing to 'Engineering Review' returns the project to submitted — a NEM target's outcome does not hold a permit status", () => {
    assert.equal(statusOf(p6), "submitted", `status=${statusOf(p6)}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // P7/P8 — staged, never filed, then corrected: 'Prepare Submittal' must RE-STAGE from
  // ready_to_resubmit (trackless and per-track), not refuse the superseded draft as a duplicate.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  const p7 = passingProject("Restage Trackless Owner");
  await R.prepareSubmission(db, p7);
  await check("fixture: a trackless stage leaves the project staged, not filed", () => {
    assert.equal(statusOf(p7), "awaiting_human_submit");
    assert.equal(count("SELECT COUNT(*) AS n FROM submissions WHERE project_id = ? AND status = 'submitted'", [p7]), 0);
  });
  const c7 = R.addManualCorrection(db, p7, "Please revise the one-line diagram to show the AC disconnect location.");
  R.resolveCorrection(db, c7.corrections.find((c) => !c.closedAt)!.id, { resubmitted: false });
  await check("fixture: resolving that correction lands on ready_to_resubmit", () => {
    assert.equal(statusOf(p7), "ready_to_resubmit");
  });
  const p7Runs = count("SELECT COUNT(*) AS n FROM portal_runs WHERE project_id = ?", [p7]);
  const r7 = await refusalOf(() => R.prepareSubmission(db, p7));
  await check("1h. trackless 'Prepare Submittal' from ready_to_resubmit RE-STAGES the corrected project (the pre-correction draft is superseded)", () => {
    assert.equal(r7, null, `refused: ${r7?.status} ${r7?.message}`);
    assert.equal(statusOf(p7), "awaiting_human_submit");
    assert.equal(count("SELECT COUNT(*) AS n FROM portal_runs WHERE project_id = ?", [p7]), p7Runs + 1, "a fresh stage run was recorded");
  });
  const r7b = await refusalOf(() => R.prepareSubmission(db, p7));
  await check("1i. MUST PASS: a second trackless click right after the re-stage is still refused (the fresh draft is protected)", () => {
    assert.ok(r7b, "a second trackless stage RESOLVED: a second draft beside the re-staged one");
    assert.equal(r7b!.status, 409);
    assert.match(r7b!.message, /already staged and awaiting a human submit/);
  });

  const p8 = passingProject("Restage Per Track Owner");
  await R.prepareSubmission(db, p8, "combo", false, false);
  const c8 = R.addManualCorrection(db, p8, "Please revise the one-line diagram to show the AC disconnect location.");
  R.resolveCorrection(db, c8.corrections.find((c) => !c.closedAt)!.id, { resubmitted: false });
  const r8 = await refusalOf(() => R.prepareSubmission(db, p8, "combo", false, false));
  await check("1j. MUST PASS: per-track 'Stage combo' from ready_to_resubmit re-stages too", () => {
    assert.equal(r8, null, `refused: ${r8?.status} ${r8?.message}`);
    assert.equal(statusOf(p8), "awaiting_human_submit");
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // P9 — LNK-5: an operator's `blocked` survives every QC door, and staging refuses it.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  const p9 = passingProject("Blocked Owner");
  const BLOCK_REASON = "Homeowner cancelled - contract dispute pending";
  R.setProjectStatusByOperator(db, p9, "blocked", BLOCK_REASON, "ops@statusintegrity.test");
  const q9 = runQcForProject(db, p9);
  await check("5a. QC on a blocked project records its verdict but writes no status (statusWritten false)", () => {
    assert.equal(q9.statusWritten, false);
    assert.equal(statusOf(p9), "blocked");
  });
  R.rerunQc(db, p9);
  R.updateProject(db, p9, { jobValue: "31000" });
  R.runProjectWorkflow(db, p9);
  await check("5b. Run QC, a project edit and the workflow view all leave the block in place", () => {
    assert.equal(statusOf(p9), "blocked", `status=${statusOf(p9)}`);
  });
  // A FAILING edit is news QC would normally write (qc_failed) — still not over an operator hold.
  R.updateProject(db, p9, { account: "" });
  const item9 = db.get<Row>(
    "SELECT id FROM human_review_items WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1", [p9]);
  await check("5c. a QC-FAILING edit on a blocked project still leaves it blocked", () => {
    assert.ok(count("SELECT COUNT(*) AS n FROM qc_results WHERE project_id = ? AND qc_status = 'fail'", [p9]) > 0, "fixture: the edit must fail QC");
    assert.equal(statusOf(p9), "blocked", `status=${statusOf(p9)}`);
    assert.ok(item9, "fixture: the failing edit filed a review item for humanVerify to act on");
  });
  if (item9) R.humanVerify(db, p9, { reviewItemId: String(item9.id), action: "edit", fieldValue: "1234567890" });
  await check("5d. humanVerify (the review queue) leaves the block in place", () => {
    assert.equal(statusOf(p9), "blocked", `status=${statusOf(p9)}`);
  });
  // The auto-resume: a prior OPERATOR-started autopilot run that ended blocked on a gate, then a
  // clearing event. The resume path is switched on for this check only.
  db.run(
    `INSERT INTO job_queue (id, job_type, payload, status, priority, project_id, created_at, progress, progress_total, retry_count, max_retries, org_id, result)
     VALUES (?, 'autopilot', '{"origin":"operator"}', 'done', 5, ?, ?, 0, 0, 0, 0, 'default', ?)`,
    [`job-${p9}`, p9, new Date().toISOString(), JSON.stringify({ blocked: true, blockers: [{ code: "missing_document", detail: "x" }] })],
  );
  delete process.env.AUTOPILOT_AUTO_START;
  maybeResumeAutopilot(db, p9, "a document was uploaded");
  await new Promise((r) => setTimeout(r, 400));
  process.env.AUTOPILOT_AUTO_START = "0";
  await check("5f. a clearing event does NOT resume autopilot on a blocked project", () => {
    assert.equal(count("SELECT COUNT(*) AS n FROM job_queue WHERE project_id = ? AND job_type = 'autopilot'", [p9]), 1);
  });
  const p9Runs = count("SELECT COUNT(*) AS n FROM portal_runs WHERE project_id = ?", [p9]);
  const r9 = await refusalOf(() => R.prepareSubmission(db, p9));
  const r9t = await refusalOf(() => R.prepareSubmission(db, p9, "combo", false, false));
  await check("5e. prepareSubmission refuses a blocked project (trackless AND per-track) with the operator's reason, and opens nothing", () => {
    for (const r of [r9, r9t]) {
      assert.ok(r, "a blocked project was STAGED");
      assert.equal(r!.status, 409);
      assert.equal(r!.details.operatorBlocked, true);
      assert.ok(r!.message.includes(BLOCK_REASON), `the refusal must name the operator's reason: ${r!.message}`);
    }
    assert.equal(count("SELECT COUNT(*) AS n FROM portal_runs WHERE project_id = ?", [p9]), p9Runs);
    assert.equal(statusOf(p9), "blocked");
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // P10 — LNK-8: a pass never DEMOTES ready_to_stage, and leaves stage_detail alone.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  const p10 = passingProject("Ready To Stage Owner");
  R.getApplicationDocumentPackage(db, p10);
  R.getReviewerReport(db, p10);
  const ready = row(p10);
  await check("fixture: the docs builder and the reviewer gate put the project at ready_to_stage, reviewer-approved", () => {
    assert.equal(String(ready.status), "ready_to_stage");
    assert.equal(String(ready.stage_detail), "reviewer_gate_approved");
  });
  R.rerunQc(db, p10);
  R.updateProject(db, p10, { jobValue: "30500" });
  R.runProjectWorkflow(db, p10);
  await check("8a. a passing re-QC (Run QC, edit, workflow view; Segment A's rerunQc is the same call) keeps ready_to_stage AND its stage_detail", () => {
    assert.equal(statusOf(p10), "ready_to_stage", `status=${statusOf(p10)}`);
    assert.equal(String(row(p10).stage_detail), "reviewer_gate_approved", `stage_detail=${row(p10).stage_detail}`);
    assert.equal(String(row(p10).current_stage), String(ready.current_stage));
  });
  R.updateProject(db, p10, { account: "" });
  await check("8b. MUST PASS: a FAILING re-QC on ready_to_stage still drops it to qc_failed", () => {
    assert.equal(statusOf(p10), "qc_failed");
    assert.equal(String(row(p10).stage_detail), "qc_failed");
  });
  const unchanged = runQcForProject(db, p10);
  await check("8d. an unchanged verdict (still failing) writes nothing — the row is left exactly as it was", () => {
    assert.equal(unchanged.statusWritten, false);
    assert.equal(statusOf(p10), "qc_failed");
  });
  R.updateProject(db, p10, { account: "1234567890" });
  await check("8c. MUST PASS: fixing it moves qc_failed back to qc_passed", () => {
    assert.equal(statusOf(p10), "qc_passed");
    assert.equal(String(row(p10).stage_detail), "qc_passed");
  });
} finally {
  console.log(failures ? `\nstatusIntegrity: ${failures} check(s) FAILED, ${passed} passed` : `\nstatusIntegrity: all ${passed} checks passed`);
  db.close();
  // Filled forms resolve off process.cwd() (ahjForms FILLED_DIR); remove ours so nothing is
  // left under the repo's backend/data.
  for (const pid of createdIds) {
    fs.rmSync(path.resolve(process.cwd(), "backend/data/filled", pid), { recursive: true, force: true });
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
if (failures) process.exit(1);
process.exit(0);
