// THE SUBMIT SEAM: APPROVAL IS RECORDED, THE FILING IS NOT PERFORMED.
//
// On a REAL portal, Approve & Submit writes an `autopilot.approved_manual_submit` audit row and
// returns. It submits only when the staged run recorded that MockPortalAdapter staged it. Until
// this round the real branch left NO state a renderer could see: the project stayed
// `awaiting_human_submit` (correctly — nothing is filed), and the panel went straight back to
// "Click Approve & Submit to file". An approved-but-unfiled filing was indistinguishable from
// one nobody had touched.
//
// WRITTEN FROM THE LIVE SHAPES, NOT THE HAPPY PATH. Measured on a copy of
// backend/data/autopilot.sqlite (2026-09-20, schema v28, 16 projects, 95 portal_runs):
//   * 7 projects sit at `awaiting_human_submit`.
//   * ZERO portal_runs anywhere were staged by MockPortalAdapter. The actor histogram is
//     AutoLearnAdapter 59 / RecipeAdapter 33 / NoAdapter 3 — so EVERY live approval takes the
//     real-portal branch this round is about.
//   * Their `current_stage` prose is frequently NOT the tidy "staged, awaiting human" sentence:
//     Trask 88647deb reads "COMBO City of Portland (permit portal) run failed — not staged…"
//     while the project sits at `awaiting_human_submit` with one awaiting run AND one later
//     failed run. That is the fixture below.
//   * Project status and run status disagree in live data (Daly cf1c56aa: `qc_passed` with NINE
//     awaiting runs) — covered as its own case.
//
// Browser-free. Run: tsx backend/test/submitSeam.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "submit-seam-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";

const { openDatabase } = await import("../src/db");
const { createProject, getApplicationDocumentPackage, getReviewerReport } = await import("../src/repository");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { runAutopilotApproval, getAutopilotState } = await import("../src/autopilot");

const here = path.dirname(url.fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`ok   ${label}`); return; }
  failures += 1;
  console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

const db = await openDatabase();
const ts = new Date().toISOString();

type Row = Record<string, unknown>;
const projectRow = (pid: string) =>
  db.get<Row>("SELECT status, current_stage, stage_detail FROM projects WHERE id = ?", [pid])!;

// A project complete enough that the REVIEWER GATE has zero blockers — the same field set and
// plan-set attachment the rehearsal harness uses, because the approval this test is about
// refuses to run while any reviewer blocker stands. A thinner fixture would never reach the
// seam at all (measured: 13 blockers, starting at "Critical project field missing").
const COMPLETE_PROJECT = {
  street: "742 Evergreen Terrace", city: "Portland", state: "OR", zip: "97201",
  account: "2200334455", meter: "M55443322",
  dcKw: "8.6", acKw: "6.5", exportKw: "6.5",
  moduleMake: "Qcells", moduleModel: "Q.TRON BLK M-G2.C1+/AC", moduleWattage: "430", moduleQty: "20",
  invModel: "IQ8M", invQty: "20", invOutputW: "325",
  interco: "Load-side breaker", busRating: "200", mainBreaker: "200", pvBreaker: "40",
  permitPath: "PRESCRIPTIVE",
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

const mkProject = (name: string, ahj: string, utility: string): string => {
  const d = createProject(db, { ...COMPLETE_PROJECT, owner: name, ahj, utility } as never);
  // The plan-set document the reviewer's package-exists check needs.
  saveProjectDocument(db, d.project.id, {
    docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% submit-seam fixture plan set\n", "utf8"), source: "upload",
  });
  return d.project.id;
};

/** Park a project exactly as the live rows are parked: staged status, stomped prose. */
const parkAwaiting = (pid: string, prose: string): void => {
  db.run("UPDATE projects SET status = 'awaiting_human_submit', current_stage = ?, stage_detail = 'staged_for_review' WHERE id = ?", [prose, pid]);
};

/** A portal_run in the shape prepareSubmission writes. `actor` is what the approve gate reads. */
const mkRun = (
  runId: string, pid: string, status: string, startedAt: string,
  result: Record<string, unknown>, permitType = "nem",
): void => {
  db.run(
    `INSERT INTO portal_runs (id, project_id, portal_profile_id, run_type, status, started_at, error_message,
       human_action_required, screenshots_path, logs_path, result_json, permit_type)
     VALUES (?, ?, NULL, 'prepare_submit', ?, ?, '', 0, '', '', ?, ?)`,
    [runId, pid, status, startedAt, JSON.stringify(result), permitType],
  );
};

const auditActions = (pid: string): string[] =>
  db.query<Row>("SELECT action FROM audit_logs WHERE project_id = ? ORDER BY created_at", [pid]).map((r) => String(r.action));
const submissionCount = (pid: string): number =>
  Number(db.get<Row>("SELECT COUNT(*) AS n FROM submissions WHERE project_id = ?", [pid])?.n ?? 0);

// ===========================================================================
// 1. THE LIVE SHAPE — Trask-class: awaiting_human_submit, prose already stomped
//    by an unrelated failure, a RecipeAdapter awaiting run, and a LATER failed run.
// ===========================================================================
const TRASK_PROSE = "COMBO City of Portland (permit portal) run failed — not staged. Could not reach review.";
const trask = mkProject("Bren Trask (live shape)", "City of Portland", "Portland General Electric");
parkAwaiting(trask, TRASK_PROSE);
mkRun("run-trask-awaiting", trask, "awaiting_human_submit", "2026-09-03T15:17:02.780Z",
  { actor: "RecipeAdapter", ok: true, finalSubmitClicked: false, portalName: "DevHub" });
mkRun("run-trask-failed", trask, "failed", "2026-09-03T15:26:30.771Z",
  { actor: "RecipeAdapter", ok: false, finalSubmitClicked: false });

const traskBefore = projectRow(trask);
check("1a. PRECONDITION: the live shape is built — staged status, prose stomped by a failure message",
  traskBefore.status === "awaiting_human_submit" && traskBefore.current_stage === TRASK_PROSE,
  JSON.stringify(traskBefore));

let traskApproveError = "";
try {
  await runAutopilotApproval(db, trask, { approverName: "Operator Under Test", approverUserId: null });
} catch (err) {
  traskApproveError = err instanceof Error ? err.message : String(err);
}
check("1b. approval on a real-adapter run completes (no blocker 409)", traskApproveError === "", traskApproveError);

const traskAfter = projectRow(trask);
check("1c. THE WRITE: stage_detail becomes 'approved_awaiting_filing'",
  traskAfter.stage_detail === "approved_awaiting_filing", String(traskAfter.stage_detail));
check("1d. MUST EXCLUDE: the project status is UNCHANGED — nothing has been filed",
  traskAfter.status === "awaiting_human_submit", String(traskAfter.status));
check("1e. MUST EXCLUDE: the recorded current_stage prose is byte-identical (a stored label is a matching key)",
  traskAfter.current_stage === TRASK_PROSE, String(traskAfter.current_stage));
check("1f. MUST EXCLUDE: no submission row was created by the approval",
  submissionCount(trask) === 0, String(submissionCount(trask)));
check("1g. MUST EXCLUDE: no 'autopilot.submitted' audit row — automation clicked nothing",
  !auditActions(trask).includes("autopilot.submitted"), auditActions(trask).join(","));
check("1h. the approval IS on the audit trail, with the approver",
  auditActions(trask).includes("autopilot.approved") && auditActions(trask).includes("autopilot.approved_manual_submit"),
  auditActions(trask).join(","));
check("1i. MUST EXCLUDE: the staged portal run still awaits a human submit",
  String(db.get<Row>("SELECT status FROM portal_runs WHERE id = 'run-trask-awaiting'")?.status) === "awaiting_human_submit");

// The panel must stop inviting an approval that has already been given.
const traskState = getAutopilotState(db, trask);
check("1j. the autopilot panel names the pending FILING instead of re-inviting the approval",
  /open the portal/i.test(traskState.message) && !/Click Approve & Submit/i.test(traskState.message),
  traskState.message);
check("1k. and the approve button stays available (a later track still needs it)", traskState.canApprove === true);

// ===========================================================================
// 2. CAPTURE CLEARS IT. The banner retires itself when the human records the filing.
// ===========================================================================
{
  const { captureConfirmation } = await import("../src/repository");
  captureConfirmation(db, "run-trask-awaiting", {
    permitNumber: "", confirmationNumber: "CONF-LIVE-1",
    submittedBy: "Operator Under Test", notes: "Filed by hand in the portal.",
  } as never);
  const after = projectRow(trask);
  check("2a. capturing the confirmation moves stage_detail off 'approved_awaiting_filing'",
    after.stage_detail !== "approved_awaiting_filing", String(after.stage_detail));
  check("2b. and THAT is what moves the project to 'submitted'",
    after.status === "submitted", String(after.status));
}

// ===========================================================================
// 3. COUNTER-FIXTURE — the mock submit path is test scaffolding and must be intact.
// ===========================================================================
{
  const pid = mkProject("Mock Scaffolding", "City of Coos Bay", "Pacific Power");
  parkAwaiting(pid, "NEM Pacific Power (NEM portal) staged. Human must verify and submit manually.");
  mkRun("run-mock", pid, "awaiting_human_submit", "2026-09-10T00:00:00.000Z",
    { actor: "MockPortalAdapter", ok: true, finalSubmitClicked: false });
  let err = "";
  try { await runAutopilotApproval(db, pid, { approverName: "Operator Under Test", approverUserId: null }); }
  catch (e) { err = e instanceof Error ? e.message : String(e); }
  const after = projectRow(pid);
  check("3a. a MockPortalAdapter run still submits autonomously (scaffolding untouched)",
    err === "" && after.status === "submitted", `${err} status=${after.status}`);
  check("3b. and it does NOT leave the real-portal 'approved_awaiting_filing' state",
    after.stage_detail !== "approved_awaiting_filing", String(after.stage_detail));
}

// ===========================================================================
// 4. COUNTER-FIXTURE — a LEGACY run with no `actor` key must fall to the manual path.
//    This pins the claim the strict gate's comment makes: no inference fallbacks.
// ===========================================================================
{
  const pid = mkProject("Legacy No Actor", "City of Coos Bay", "Pacific Power");
  parkAwaiting(pid, "NEM Pacific Power (NEM portal) staged. Human must verify and submit manually.");
  mkRun("run-legacy", pid, "awaiting_human_submit", "2026-09-10T00:00:00.000Z",
    { ok: true, finalSubmitClicked: false });
  await runAutopilotApproval(db, pid, { approverName: "Operator Under Test", approverUserId: null });
  const after = projectRow(pid);
  check("4a. MUST EXCLUDE: a run with no recorded actor is NOT treated as a mock — it does not submit",
    after.status === "awaiting_human_submit" && submissionCount(pid) === 0, `${after.status} subs=${submissionCount(pid)}`);
  check("4b. it lands in the filing-pending state like any other real run",
    after.stage_detail === "approved_awaiting_filing", String(after.stage_detail));
}

// ===========================================================================
// 5. LIVE SHAPE — Daly cf1c56aa: `qc_passed` with awaiting runs underneath.
//    The approval gate refuses; nothing is written.
// ===========================================================================
{
  const pid = mkProject("Daly Split Status", "City of Salem", "Portland General Electric");
  db.run("UPDATE projects SET status = 'qc_passed', stage_detail = 'qc_passed' WHERE id = ?", [pid]);
  mkRun("run-daly-1", pid, "awaiting_human_submit", "2026-08-27T01:38:51.048Z", { actor: "AutoLearnAdapter", ok: true, finalSubmitClicked: false });
  mkRun("run-daly-2", pid, "awaiting_human_submit", "2026-08-27T02:03:20.780Z", { actor: "AutoLearnAdapter", ok: true, finalSubmitClicked: false }, "permit");
  let err = "";
  try { await runAutopilotApproval(db, pid, { approverName: "Operator Under Test", approverUserId: null }); }
  catch (e) { err = e instanceof Error ? e.message : String(e); }
  const after = projectRow(pid);
  check("5a. approval on a project whose STATUS never reached the gate is refused", /not awaiting approval/i.test(err), err);
  check("5b. MUST EXCLUDE: the refusal writes nothing — stage_detail untouched",
    after.stage_detail === "qc_passed" && after.status === "qc_passed", JSON.stringify(after));
}

// ===========================================================================
// 6. `ready_to_stage` GETS ITS WRITER — build-docs completion, and ONLY from qc_passed.
// ===========================================================================
{
  const pid = mkProject("Docs Builder", "City of Portland", "Portland General Electric");
  db.run("UPDATE projects SET status = 'qc_passed', current_stage = 'QC passed: ready to stage', stage_detail = 'qc_passed' WHERE id = ?", [pid]);
  const pkg = getApplicationDocumentPackage(db, pid);
  const after = projectRow(pid);
  check("6a. PRECONDITION: the package actually produced documents", pkg.docs.length > 0, String(pkg.docs.length));
  check("6b. THE WRITER: building the AHJ/NEM docs from qc_passed moves the project to 'ready_to_stage'",
    after.status === "ready_to_stage", String(after.status));
  check("6c. and says so in the stage prose",
    /documents built/i.test(String(after.current_stage)), String(after.current_stage));
  check("6d. it is audited",
    auditActions(pid).includes("project.ready_to_stage"), auditActions(pid).join(","));

  // The one-way edge: re-fetching the package on a project past qc_passed writes NOTHING.
  const staged = mkProject("Docs Builder Staged", "City of Portland", "Portland General Electric");
  parkAwaiting(staged, "NEM PGE (NEM portal) staged. Human must verify and submit manually.");
  db.run("UPDATE projects SET stage_detail = 'approved_awaiting_filing' WHERE id = ?", [staged]);
  const before = projectRow(staged);
  getApplicationDocumentPackage(db, staged);
  const afterStaged = projectRow(staged);
  check("6e. MUST EXCLUDE: fetching the packet on a STAGED project changes nothing (status, prose and sub-stage all identical)",
    JSON.stringify(before) === JSON.stringify(afterStaged), `${JSON.stringify(before)} -> ${JSON.stringify(afterStaged)}`);
}

// ===========================================================================
// 7. THE REVIEWER GATE RECORDS ITS VERDICT IN stage_detail — never in a status.
// ===========================================================================
{
  const pid = mkProject("Reviewer Gate", "City of Portland", "Portland General Electric");
  db.run("UPDATE projects SET status = 'ready_to_stage', current_stage = 'docs built', stage_detail = 'qc_passed' WHERE id = ?", [pid]);
  const report = getReviewerReport(db, pid);
  const after = projectRow(pid);
  check("7a. PRECONDITION: this fixture's reviewer gate really is blocker-free",
    !report.findings.some((f) => f.severity === "blocker"),
    report.findings.filter((f) => f.severity === "blocker").map((f) => f.id).join(","));
  check("7b. a CLEAN reviewer report records 'reviewer_gate_approved'",
    after.stage_detail === "reviewer_gate_approved", String(after.stage_detail));
  check("7c. MUST EXCLUDE: the reviewer gate never moves the status",
    after.status === "ready_to_stage", String(after.status));

  // A BLOCKERED gate must never read as an approval — and must RETRACT a stale one. A
  // write-only recorder would leave "reviewer gate approved" standing on a packet the gate
  // had just rejected (getReviewerReportWithVision runs the text pass first, and vision can
  // confirm a blocker afterwards).
  const bare = createProject(db, { owner: "Bare Packet", street: "9 Nowhere", city: "Portland", state: "OR", zip: "97201", ahj: "City of Portland", utility: "Portland General Electric" } as never).project.id;
  db.run("UPDATE projects SET status = 'ready_to_stage', stage_detail = 'reviewer_gate_approved' WHERE id = ?", [bare]);
  const bareReport = getReviewerReport(db, bare);
  check("7e. PRECONDITION: a packet with nothing attached really does raise reviewer blockers",
    bareReport.findings.some((f) => f.severity === "blocker"));
  check("7f. MUST EXCLUDE: blockers RETRACT a stale 'reviewer_gate_approved' rather than leaving it standing",
    projectRow(bare).stage_detail === "", String(projectRow(bare).stage_detail));

  // And it must never relabel a filing that is waiting on a person.
  const filing = mkProject("Reviewer Gate On A Pending Filing", "City of Portland", "Portland General Electric");
  parkAwaiting(filing, "NEM PGE (NEM portal) staged. Human must verify and submit manually.");
  db.run("UPDATE projects SET stage_detail = 'approved_awaiting_filing' WHERE id = ?", [filing]);
  getReviewerReport(db, filing);
  check("7d. MUST EXCLUDE: re-running the reviewer gate never overwrites 'approved_awaiting_filing'",
    projectRow(filing).stage_detail === "approved_awaiting_filing", String(projectRow(filing).stage_detail));
}

// ===========================================================================
// 8. THE CENSUS — who can write projects.status at all.
//
// The round's bar was phrased "no code path moves a project to 'submitted' without
// captureConfirmation". THAT CLAIM IS FALSE AS STATED and must not be asserted as if it were
// true: Round B deliberately added human-gesture writers (markCorrectionResubmitted,
// resolveCorrection on a still-filed project, recordDesignRevisionsReceived, the manual track
// capture in submittalTracks, the audited operator override), and the permit monitor's
// `waiting` branch promotes awaiting_human_submit -> submitted with NO human gesture at all
// (repository.ts updateProjectForPermitOutcome — reported, out of this round's file set).
//
// So this pins the two things that ARE true and that this seam owns:
//   * autopilot.ts — the approve seam's own file — writes NO project status, ever. Its only
//     route to `submitted` is the mock branch's call to captureConfirmation.
//   * the number of status writers in the backend is FIXED. A new one fails this test until
//     someone counts it and classifies its human gesture, exactly as routeScope.test.ts does
//     for new route paths. A count with no denominator is what let the last three slip by.
// ===========================================================================
{
  // `\b…=` on purpose: a bare prefix also matches `UPDATE projects SET status_share_token`
  // (clientNotifier.ts), which is not a status writer at all.
  const STATUS_WRITE = /UPDATE projects SET status\b\s*=/g;
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
  const perFile = new Map<string, number>();
  let total = 0;
  for (const f of files) {
    const n = (fs.readFileSync(path.join(srcDir, f), "utf8").match(STATUS_WRITE) || []).length;
    if (n > 0) { perFile.set(f, n); total += n; }
  }
  // Classified 2026-09-20 against HEAD ffbb5ed:
  //   qc.ts            1  — the QC verdict (automatic, pre-stage only)
  //   repository.ts   13  — override(769) · correction triage(4555) · designer wait(4705) ·
  //                         revisions received(4769) · correction resolved filed(4836) /
  //                         restage(4861) · reopen(5192) · permit monitor(5577) ·
  //                         handoff(5661) · prepareSubmission tail(6874) ·
  //                         captureConfirmation(7136) · markCorrectionResubmitted(7298)
  //   submittalTracks  1  — manual track capture
  const EXPECTED: Record<string, number> = { "qc.ts": 1, "repository.ts": 13, "submittalTracks.ts": 1 };
  check("8a. autopilot.ts — the approve seam — writes NO project status anywhere",
    !perFile.has("autopilot.ts"), `autopilot.ts has ${perFile.get("autopilot.ts") ?? 0}`);
  check("8b. the project-status writer census is unchanged (15 across 3 files); a new writer must be classified here",
    total === 15 && JSON.stringify([...perFile].sort()) === JSON.stringify(Object.entries(EXPECTED).sort()),
    `total=${total} ${JSON.stringify([...perFile].sort())}`);

  // And the seam file cannot acquire a submit/pay/withdraw click by accident.
  const autopilotSrc = fs.readFileSync(path.join(srcDir, "autopilot.ts"), "utf8");
  check("8c. MUST EXCLUDE: autopilot.ts calls no pay / withdraw / cancel-filing action",
    !/\b(payFee|payPortalFee|withdrawApplication|cancelFiling|clickPay)\b/.test(autopilotSrc));
}

// ===========================================================================
// 9. THE BANNER — the half of this seam the operator actually sees.
//
// The stage_detail above is only useful if something renders it, and a banner with no
// regression test is a banner that quietly stops rendering. renderNextStep touches exactly one
// element, so the real functions can be lifted out of frontend/dashboard.js and run in plain
// Node against a stub — no Chromium, so this lives in the backend chain rather than the
// hour-long DOM suite.
// ===========================================================================
{
  const dashboard = fs.readFileSync(path.join(here, "..", "..", "frontend", "dashboard.js"), "utf8");
  /** Lift a top-level `function NAME(` / `const NAME =` block out by brace balance. */
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
  const bundle = [
    cut("function", "esc"), cut("function", "humanize"),
    cut("const", "NEXT_STEPS"), cut("function", "nextStepFor"),
    cut("function", "filingPortalLabel"), cut("function", "approvedAwaitingFilingGuide"),
    cut("function", "renderNextStep"),
  ].join("\n\n");

  const render = (project: Record<string, unknown>, portalRuns: Array<Record<string, unknown>>) => {
    const banner = { hidden: true, className: "", innerHTML: "", querySelector: () => null };
    const $ = (id: string) => (id === "nextStepBanner" ? banner : null);
    const state = { detail: { project, portalRuns } };
    // eslint-disable-next-line no-new-func
    (new Function("$", "state", `${bundle}\nreturn renderNextStep;`)($, state) as () => void)();
    return banner;
  };

  const approved = render(
    { status: "awaiting_human_submit", stageDetail: "approved_awaiting_filing", ahj: "City of Portland", utility: "Portland General Electric" },
    [{ id: "r1", status: "awaiting_human_submit", permitType: "combo" }],
  );
  check("9a. the banner renders for an approved-but-unfiled project", approved.hidden === false);
  check("9b. it says plainly that the filing is NOT submitted", /NOT submitted/.test(approved.innerHTML), approved.innerHTML.slice(0, 140));
  check("9c. it NAMES the portal — the AHJ, for a permit-track run", /City of Portland/.test(approved.innerHTML));
  check("9d. it spells out the operator's OWN submit click", /click its submit yourself/i.test(approved.innerHTML));
  check("9e. it names the capture action", /Capture Confirmation/.test(approved.innerHTML));
  check("9f. it chains to the capture form", /data-go-capture/.test(approved.innerHTML));
  check("9g. it reads as a warning, not as routine progress", / is-warn/.test(approved.className), approved.className);

  const nem = render(
    { status: "awaiting_human_submit", stageDetail: "approved_awaiting_filing", ahj: "City of Coos Bay", utility: "Pacific Power" },
    [{ id: "r1", status: "awaiting_human_submit", permitType: "nem" }],
  );
  check("9h. a NEM run names the UTILITY, never the AHJ (hard rule 5 in the copy too)",
    /Pacific Power/.test(nem.innerHTML) && !/Coos Bay/.test(nem.innerHTML), nem.innerHTML.slice(0, 160));

  const staged = render(
    { status: "awaiting_human_submit", stageDetail: "staged_for_review", ahj: "City of Portland", utility: "PGE" },
    [{ id: "r1", status: "awaiting_human_submit", permitType: "combo" }],
  );
  check("9i. MUST EXCLUDE: a staged-but-unapproved project keeps the ORIGINAL banner",
    /Staged and ready/.test(staged.innerHTML) && !/data-go-capture/.test(staged.innerHTML), staged.innerHTML.slice(0, 140));

  const hostile = render(
    { status: "awaiting_human_submit", stageDetail: "approved_awaiting_filing", ahj: "<img src=x onerror=alert(1)>", utility: "PGE" },
    [{ id: "r1", status: "awaiting_human_submit", permitType: "combo" }],
  );
  check("9j. MUST EXCLUDE: the portal name is esc()'d into innerHTML",
    !/<img/.test(hostile.innerHTML) && /&lt;img/.test(hostile.innerHTML), hostile.innerHTML.slice(0, 200));

  const bare = render({ status: "awaiting_human_submit", stageDetail: "approved_awaiting_filing", ahj: "", utility: "" }, []);
  check("9k. with no run and no names it still says WHERE to go, generically — never a blank",
    /the AHJ's portal|the utility's portal/.test(bare.innerHTML), bare.innerHTML.slice(0, 160));
}

console.log(failures === 0
  ? `\nSUBMIT SEAM: all checks passed.`
  : `\nSUBMIT SEAM: ${failures} check(s) FAILED.`);
assert.equal(failures, 0, `${failures} submit-seam check(s) failed`);
