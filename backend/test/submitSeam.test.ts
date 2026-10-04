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
//   * Project status and run status disagree in live data (Fixture cf1c56aa: `qc_passed` with NINE
//     awaiting runs) — covered as its own case.
//
// Browser-free. Run: tsx backend/test/submitSeam.test.ts
// FIRST: generated/filled documents land in a temp dir, never the live backend/data.
import "./_isolate";
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
// 5. LIVE SHAPE — Fixture cf1c56aa: `qc_passed` with awaiting runs underneath.
//    The approval gate refuses; nothing is written.
// ===========================================================================
{
  const pid = mkProject("Fixture Split Status", "City of Salem", "Portland General Electric");
  db.run("UPDATE projects SET status = 'qc_passed', stage_detail = 'qc_passed' WHERE id = ?", [pid]);
  mkRun("run-fixture-1", pid, "awaiting_human_submit", "2026-08-27T01:38:51.048Z", { actor: "AutoLearnAdapter", ok: true, finalSubmitClicked: false });
  mkRun("run-fixture-2", pid, "awaiting_human_submit", "2026-08-27T02:03:20.780Z", { actor: "AutoLearnAdapter", ok: true, finalSubmitClicked: false }, "permit");
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
    cut("function", "stageLabelFor"),
    cut("function", "renderNextStep"),
  ].join("\n\n") + "\nconst PROJECT_STAGES = [];";

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

// ===========================================================================
// 10. THE NEXT STEP IS THE SERVER'S — the banner, the board chip and the "Needs me" pills all
// render backend/src/nextStep.ts's ONE answer. Each check below was written against a defect
// the operator saw (a "Stage 3" banner over a Build project, "Your submit (0)" with five staged
// drafts, review items that appeared in no pill, a bare "0 document(s) staged" reopen toast,
// Stage portals clickable when the server says a run would duplicate a draft).
// ===========================================================================
{
  const { decideNextStep, NEXT_STEP_BUTTON_IDS } = await import("../src/nextStep");
  const { isCriticalReviewItem, NON_QC_REVIEW_FIELDS, trackStateSummary } = await import("../src/repository");
  const dashboard = fs.readFileSync(path.join(here, "..", "..", "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
  const repoSrc = fs.readFileSync(path.join(srcDir, "repository.ts"), "utf8");
  const typesSrc = fs.readFileSync(path.join(here, "..", "..", "shared", "src", "types.ts"), "utf8");

  /** Lift a top-level `[async] function NAME(` or `const NAME = ` by bracket balance ({ [ ( ). */
  const lift = (name: string): string => {
    const re = new RegExp(`^(?:async )?function ${name}\\(|^const ${name} = `, "m");
    const m = re.exec(dashboard);
    if (!m) throw new Error(`dashboard.js: could not find ${name}`);
    const isConst = m[0].startsWith("const");
    let i = isConst ? m.index + m[0].length : dashboard.indexOf("{", dashboard.indexOf(")", m.index));
    if (!isConst) { /* start at the body brace */ }
    else if (!"{[(".includes(dashboard[i])) { const semi = dashboard.indexOf(";\n", i); return dashboard.slice(m.index, semi + 1); }
    let depth = 0;
    for (; i < dashboard.length; i++) {
      const ch = dashboard[i];
      if (ch === "{" || ch === "[" || ch === "(") depth++;
      else if (ch === "}" || ch === "]" || ch === ")") { depth--; if (depth === 0) { i++; break; } }
    }
    return dashboard.slice(m.index, i) + (isConst ? ";" : "");
  };
  const NAMES = [
    "esc", "humanize", "PROJECT_STAGES", "NEXT_STEPS", "nextStepFor", "filingPortalLabel", "approvedAwaitingFilingGuide",
    "stageLabelFor", "NEXT_STEP_WHO", "NEXT_STEP_PROBLEM_KEYS", "nextStepBannerHtml", "currentNextStep", "NEXT_STEP_BUTTON_LABELS",
    "revealElement", "renderNextStep", "NEXT_STEP_CHIP", "WAITING_ON_LABEL",
    "nextStepChip", "boardAttention", "legacyBoardAttention", "NEEDS_ME_PILLS", "needsMeCounts",
    // The board's gate answers (boardGateTruth.test.ts covers them); lifted because boardAttention,
    // boardCardHtml and applyAutopilotState call them.
    "GATE_ANSWER_TTL_MS", "gateStampFor", "boardStepFor", "compactGateAnswer", "rememberGateAnswer", "BOARD_WHO_SHORT", "boardWhoHtml",
    "STATUS_LABELS", "statusLabel", "PRE_STAGE_STATUSES", "statusBoxView", "renderStatusBox",
    "NON_QC_REVIEW_FIELDS", "ADVISORY_REVIEW_ISSUE_TYPES", "reviewItemBuckets", "reopenResultMessage", "showSubmitBlockerNote",
    "applyAutopilotState", "startAutopilot", "fmtDate", "boardReviewCountChip", "boardCardHtml",
    "resetAutopilotRail", "AUTOPILOT_LOAD_FAILED_TEXT", "refreshAutopilot", "selectProject",
    "permitTargetKindLabel", "portalSaysFor", "renderPermitMonitor", "TRACK_STATE_WORDS", "trackStateWords", "kbConfidenceBadge",
    "permitTargetOptionLabel", "renderPermitStatusTargetPicker", "permitStatusTargetId", "recordPermitStatus", "handleStaleRecheckClick",
    "syncPermitForm",
    "plural", "statusBadge", "briefClass", "submitGateClass", "bandHead", "gateEvidenceSplit", "renderSubmitGate",
  ];
  const code = NAMES.map(lift).join("\n\n");
  const EXPORTS = NAMES.filter((n) => /^[a-zA-Z]/.test(n)).join(", ");

  type El = Record<string, any>;
  const mkEl = (id: string): El => ({
    id, disabled: false, title: "", hidden: true, textContent: "", className: "", innerHTML: "", dataset: {}, style: {}, kids: [] as unknown[],
    classList: { set: new Set<string>(), toggle(c: string, on?: boolean) { (on ?? !this.set.has(c)) ? this.set.add(c) : this.set.delete(c); }, add(c: string) { this.set.add(c); }, remove(c: string) { this.set.delete(c); }, contains(c: string) { return this.set.has(c); } },
    replaceChildren(...k: unknown[]) { this.kids = k; },
    querySelector: () => null, querySelectorAll: () => [],
  });
  const load = (els: Record<string, El>, state: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const $ = (id: string) => els[id] ?? null;
    const document = { createElement: () => ({ textContent: "" }), querySelectorAll: () => [], querySelector: () => null };
    const stubs = { safeRender: (_n: string, fn: () => void) => fn(), showMessage: () => {}, api: async () => ({}), pollAutopilot: async () => null, ...extra };
    // eslint-disable-next-line no-new-func
    return new Function("$", "state", "document", ...Object.keys(stubs), `${code}\nreturn { ${EXPORTS} };`)($, state, document, ...Object.values(stubs));
  };
  const lib = load({}, {});

  // 10a — every NextStepKey the server can emit has a chip row (a new server key cannot render blank).
  const unionBody = /export type NextStepKey =([\s\S]*?);/.exec(typesSrc)?.[1] ?? "";
  const serverKeys = [...unionBody.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const missingChip = serverKeys.filter((k) => !(k in lib.NEXT_STEP_CHIP));
  check("10a. every NextStepKey in shared/src/types.ts has a NEXT_STEP_CHIP row", serverKeys.length >= 20 && missingChip.length === 0, `missing: ${missingChip.join(", ")} (of ${serverKeys.length})`);
  const pillKeys = new Set((lib.NEEDS_ME_PILLS as Array<{ key: string }>).map((p) => p.key));
  const strayPill = Object.entries(lib.NEXT_STEP_CHIP as Record<string, { pill: string }>).filter(([, v]) => !pillKeys.has(v.pill)).map(([k]) => k);
  check("10a2. every chip row is counted under a pill that exists (the pills partition the keys)", strayPill.length === 0, strayPill.join(", "));
  const missingLabel = (NEXT_STEP_BUTTON_IDS as readonly string[]).filter((id) => !(id in lib.NEXT_STEP_BUTTON_LABELS));
  check("10a3. every button id the server can name has a label for the board's fallback answer", missingLabel.length === 0, missingLabel.join(", "));

  // 10b — the banner renders the SERVER's answer, and its stage label is the project's REAL stage.
  const renderWith = (state: Record<string, unknown>) => {
    const banner = mkEl("nextStepBanner");
    banner.querySelector = () => null;
    const els: Record<string, El> = { nextStepBanner: banner, startAutopilotBtn: mkEl("startAutopilotBtn"), portalRuns: mkEl("portalRuns") };
    load(els, state).renderNextStep();
    return banner;
  };
  const buildProject = { id: "p-build", status: "awaiting_human_submit", stageDetail: "staging_failed", ahj: "City of Tigard", utility: "PGE" };
  const serverAnswer = {
    key: "staging_failed", who: "me", urgency: "today", stageIndex: 2, gateChecked: true, since: "2026-09-21T10:00:00Z",
    headline: "Staging failed for the building permit — <b>fix</b> it.", why: [{ text: "building permit: <img src=x onerror=alert(1)>", fixTarget: "portalRuns" }],
    button: null,
  };
  const b1 = renderWith({ selectedProjectId: "p-build", detail: { project: buildProject, stageIndex: 1, portalRuns: [] }, nextStep: serverAnswer, nextStepProjectId: "p-build", projects: [] });
  check("10b. the banner shows the server's headline (source=server)", b1.dataset.nextSource === "server" && /Staging failed for the building permit/.test(b1.innerHTML), b1.innerHTML.slice(0, 200));
  check("10b2. the stage label is the project's REAL stage (2 · Build & Validate), never a table's \"Stage 3\"",
    /2 · Build &amp; Validate/.test(b1.innerHTML) && !/Stage 3/.test(b1.innerHTML) && !/3 · Submit/.test(b1.innerHTML), b1.innerHTML.slice(0, 160));
  check("10b3. MUST EXCLUDE: headline and why are esc()'d into innerHTML", !/<b>|<img/.test(b1.innerHTML) && /&lt;img/.test(b1.innerHTML));
  check("10b4. it says who acts, and links the why to its panel", /Who acts: <strong>You<\/strong>/.test(b1.innerHTML) && /data-fix-target="portalRuns"/.test(b1.innerHTML));
  // The old status-table path (server answer unavailable) must ALSO use the real stage.
  const b2 = renderWith({ selectedProjectId: "p-build", detail: { project: buildProject, stageIndex: 1, portalRuns: [{ status: "failed", permitType: "building", startedAt: "2026-09-21" }] }, nextStep: null, projects: [] });
  check("10b5. fallback banner (no server answer) still names the real stage and keeps its qualifier",
    b2.dataset.nextSource === "fallback" && /2 · Build &amp; Validate · Staging failed/.test(b2.innerHTML) && !/Stage 3/.test(b2.innerHTML), b2.innerHTML.slice(0, 160));
  // Another project's answer is never shown; the board's compact answer is used, marked provisional.
  const b3 = renderWith({
    selectedProjectId: "p-build", detail: { project: buildProject, stageIndex: 1, portalRuns: [] },
    nextStep: { ...serverAnswer, headline: "OTHER PROJECT" }, nextStepProjectId: "p-other",
    projects: [{ id: "p-build", nextStep: { key: "ready_to_stage", who: "me", urgency: "today", headline: "Next: stage the permit (the project page checks the submit gate first).", buttonId: "startAutopilotBtn", gateChecked: false } }],
  });
  check("10b6. MUST EXCLUDE: another project's full answer is never rendered", !/OTHER PROJECT/.test(b3.innerHTML), b3.innerHTML.slice(0, 160));
  check("10b7. the board's compact answer stands in, marked as not including the gate",
    b3.dataset.nextSource === "board" && /Next: stage the permit/.test(b3.innerHTML) && /submit gate is not included/.test(b3.innerHTML), b3.innerHTML.slice(0, 260));

  // 10c — board chip counts come from the SERVER's count (its headline), for real rule-table output.
  const track = (over: Record<string, unknown>) => ({ track: "nem", filed: false, filedAt: null, done: false, latestRun: null, onPortal: false, stagedRun: null, gapFillMissing: [], feeDue: false, paymentDue: false, ...over });
  const baseFacts = { projectId: "x", status: "ready_to_stage", stageDetail: "", archived: false, ahj: "City of X", utility: "Utility Y", operatorHold: null, openCorrections: [], jobInFlight: null, tracks: [], reopenPause: null, qcRan: true, qcFails: [], qcReview: [], portalReadings: 0, approvedRunIds: [] };
  const readings = decideNextStep({ ...baseFacts, status: "issued", tracks: [track({ filed: true })], portalReadings: 4 } as any);
  const readingsChip = lib.nextStepChip({ ...readings, buttonId: null });
  check("10c. portal readings: the chip's number is the server's (4), not the list's all-pending total",
    readings.key === "portal_readings" && /^4 /.test(readingsChip.label), `${readings.key} → ${readingsChip.label}`);
  const qcReview = decideNextStep({ ...baseFacts, status: "qc_passed", tracks: [track({})], qcReview: [{ issueType: "a", fieldName: "f1" }, { issueType: "b", fieldName: "f2" }, { issueType: "c", fieldName: "f3" }] } as any);
  check("10c2. QC review: the chip's number is the server's QC count (3)",
    qcReview.key === "qc_review_pending" && /^3 to review$/.test(lib.nextStepChip(qcReview).label), `${qcReview.key} → ${lib.nextStepChip(qcReview).label}`);

  // 10d — the pills PARTITION the board, and a staged draft is ALSO "Your submit".
  const rows = serverKeys.map((key, i) => ({ id: `r${i}`, status: "ready_to_stage", nextStep: { key, who: "me", urgency: "today", headline: "x", buttonId: null, gateChecked: false, hasStagedDraft: key === "staging_failed" } }));
  const { counts, total } = lib.needsMeCounts(rows);
  const sum = Object.values(counts as Record<string, number>).reduce((a, n) => a + n, 0);
  const drafts = rows.filter((r) => r.nextStep.hasStagedDraft && (lib.NEXT_STEP_CHIP[r.nextStep.key].pill !== "your_submit")).length;
  check("10d. every project is counted once, plus once more under Your submit for a staged draft (sum = total + drafts)", sum === total + drafts && drafts === 1, `sum ${sum} total ${total} drafts ${drafts}`);
  const failedStep = { key: "staging_failed", who: "me", urgency: "today", headline: "x", buttonId: null, gateChecked: false };
  const staged = lib.needsMeCounts([{ id: "s", status: "awaiting_human_submit", nextStep: { ...failedStep, hasStagedDraft: true } }]);
  check("10d2. a project with a staged draft whose chip says Staging failed is in BOTH pills (the old misfile)",
    staged.counts.staging_failed === 1 && staged.counts.your_submit === 1, JSON.stringify(staged.counts));
  // "Your submit" membership is the SERVER's hasStagedDraft, not the project status. Both
  // directions: a sibling track staged while the status is still ready_to_stage IS a draft; an
  // awaiting_human_submit project whose only staged track has since been filed is NOT.
  const byFlag = lib.needsMeCounts([{ id: "f", status: "ready_to_stage", nextStep: { ...failedStep, hasStagedDraft: true } }]);
  check("10d2b. MUST PASS: hasStagedDraft:true counts under Your submit whatever the status says", byFlag.counts.your_submit === 1, JSON.stringify(byFlag.counts));
  const filedDraft = lib.needsMeCounts([{ id: "g", status: "awaiting_human_submit", nextStep: { ...failedStep, hasStagedDraft: false } }]);
  check("10d2c. MUST EXCLUDE: awaiting_human_submit with hasStagedDraft:false is NOT counted under Your submit", filedDraft.counts.your_submit === 0 && filedDraft.counts.staging_failed === 1, JSON.stringify(filedDraft.counts));
  const legacy = lib.needsMeCounts([{ id: "l", status: "issued", pendingReviewCount: 0 }]);
  check("10d3. a row with no server answer still lands in a pill (the old guess is the fallback)", Object.values(legacy.counts as Record<string, number>).reduce((a, n) => a + n, 0) === 1);
  const prov = lib.nextStepChip({ key: "ready_to_stage", who: "me", urgency: "today", headline: "Next: stage", buttonId: "startAutopilotBtn", gateChecked: false, gateCanOverrule: true });
  const checked = lib.nextStepChip({ key: "ready_to_stage", who: "me", urgency: "today", headline: "Ready", gateChecked: true, gateCanOverrule: false });
  check("10d4. a list answer the submit gate could overrule is marked provisional on the board", prov.provisional === true && checked.provisional === false);
  // Provisional is the server's gateCanOverrule, not a client key list: the old list missed
  // resubmit_awaiting_me (rule 9 sits after the gate rule), and a key on the list is not
  // provisional when the server says the gate cannot come first.
  const provResubmit = lib.nextStepChip({ key: "resubmit_awaiting_me", who: "me", urgency: "today", headline: "Resubmit", gateChecked: false, gateCanOverrule: true });
  const notProv = lib.nextStepChip({ key: "ready_to_stage", who: "me", urgency: "today", headline: "Ready", gateChecked: false, gateCanOverrule: false });
  check("10d5. MUST PASS: gateCanOverrule:true marks resubmit_awaiting_me provisional", provResubmit.provisional === true);
  check("10d6. MUST EXCLUDE: gateCanOverrule:false is not provisional, whatever the key", notProv.provisional === false);

  // 10e — every pending review item lands in exactly ONE visible bucket, and QC = the server's predicate.
  const clientAdvisory = JSON.stringify([...(lib.ADVISORY_REVIEW_ISSUE_TYPES as string[])].sort());
  const serverAdvisory = JSON.stringify(JSON.parse(`[${/const ADVISORY_REVIEW_ISSUE_TYPES = new Set\(\[([^\]]*)\]\)/.exec(repoSrc)?.[1] ?? ""}]`).sort());
  check("10e. the client's advisory issue types mirror repository.ts exactly", clientAdvisory === serverAdvisory, `${clientAdvisory} vs ${serverAdvisory}`);
  check("10e2. the client's non-QC fields mirror repository.ts exactly",
    JSON.stringify([...(lib.NON_QC_REVIEW_FIELDS as string[])].sort()) === JSON.stringify([...NON_QC_REVIEW_FIELDS].sort()));
  const items = [
    ...["correction", "permit_status", "prepare_submission", "autopilot", "homeownerEmail", "systemSizeDc"].flatMap((fieldName) =>
      ["Run triage", "Background job failed", "Missing value", ""].map((issueType) => ({ status: "pending", fieldName, issueType }))),
    { status: "verified", fieldName: "systemSizeDc", issueType: "" },
  ];
  const bk = lib.reviewItemBuckets(items);
  const serverQc = items.filter((it) => isCriticalReviewItem(it)).length;
  check("10e3. the page's QC bucket is exactly the server's isCriticalReviewItem", bk.qc.length === serverQc, `${bk.qc.length} vs ${serverQc}`);
  check("10e4. every pending item is counted in exactly one bucket (nothing vanishes)",
    bk.qc.length + bk.reading.length + bk.notice.length === items.filter((i) => i.status === "pending").length);

  // 10f — the reopen toast carries the server's message and its drift warnings.
  const okDrift = lib.reopenResultMessage({ ok: true, message: "Reopened the correction form for APP-1.", attachedDocs: 0, driftWarnings: ["site_plan: upload refused (wrong type)"] });
  check("10f. a reopen that attached nothing SAYS why (driftWarnings) and reads as a warning",
    /upload refused/.test(okDrift.text) && /Reopened the correction form for APP-1/.test(okDrift.text) && okDrift.kind === "warning", okDrift.text);
  const okClean = lib.reopenResultMessage({ ok: true, message: "", reopenedForm: "Resubmittal", attachedDocs: 2, driftWarnings: [], browserLeftOpen: true });
  check("10f2. a clean reopen stays informational and still names the form + count", okClean.kind === "info" && /Resubmittal/.test(okClean.text) && /2 document/.test(okClean.text), okClean.text);
  const failDrift = lib.reopenResultMessage({ ok: false, needsHuman: false, message: "stopped", driftWarnings: ["x"] });
  check("10f3. a failed reopen keeps its drift warnings too", failDrift.kind === "error" && /stopped/.test(failDrift.text) && /x/.test(failDrift.text));

  // 10g — the red "must clear before this can be submitted" note defers to the server's answer.
  const blockedGate = { canPrepareSubmission: false, decision: "submitted_tracking", checks: [{ id: "document-inventory", status: "blocker" }] };
  check("10g. withheld when the server's full answer says everything is filed (portal readings)",
    lib.showSubmitBlockerNote(blockedGate, 1, { key: "portal_readings", gateChecked: true, allFiled: true }) === false);
  check("10g2. MUST PASS: still shown for a real gate block before filing",
    lib.showSubmitBlockerNote({ ...blockedGate, decision: "blocked" }, 1, { key: "gate_blocked", gateChecked: true, allFiled: false }) === true);
  check("10g3. MUST PASS: a list-tier (unchecked) answer cannot withhold it",
    lib.showSubmitBlockerNote({ ...blockedGate, decision: "blocked" }, 1, { key: "waiting_on_agency", gateChecked: false, allFiled: true }) === true);
  check("10g-auto. withheld while automation is doing it (the automatic chain splits the plan set / finds the forms)",
    lib.showSubmitBlockerNote({ ...blockedGate, decision: "blocked" }, 1, { key: "automation_running", gateChecked: true, allFiled: false }) === false);
  // The server's allFiled decides, not the key: ec5c36d3's shape (every filing made, answer
  // still ready_to_stage) withholds; a key from the old "all filed" list with allFiled:false does not.
  check("10g4. MUST PASS: allFiled:true withholds it whatever the key (ready_to_stage)",
    lib.showSubmitBlockerNote({ ...blockedGate, decision: "blocked" }, 1, { key: "ready_to_stage", gateChecked: true, allFiled: true }) === false);
  check("10g5. MUST EXCLUDE: allFiled:false keeps it, even for waiting_on_agency",
    lib.showSubmitBlockerNote({ ...blockedGate, decision: "blocked" }, 1, { key: "waiting_on_agency", gateChecked: true, allFiled: false }) === true);

  // 10h — Stage portals follows the server's canStage, with the reason as TEXT; Approve's reason too.
  const apEls: Record<string, El> = Object.fromEntries(["autopilotStatus", "approveSubmitBtn", "startAutopilotBtn", "autopilotOffReasons", "autopilotReason", "reviewMismatchBanner", "reviewMismatchList", "gapFillBanner", "gapFillList"].map((id) => [id, mkEl(id)]));
  const apState: Record<string, unknown> = { selectedProjectId: "p1", detail: { stageIndex: 1, project: { id: "p1" } } };
  const apLib = load(apEls, apState, { safeRender: () => {} });
  apLib.applyAutopilotState({ projectId: "p1", phase: "idle", canApprove: false, approveDisabledReason: "Nothing is staged.", canStage: false, stageDisabledReason: "Every required track is already staged or filed.", blockers: [] });
  const offText = (apEls.autopilotOffReasons.kids as Array<{ textContent: string }>).map((k) => k.textContent).join(" | ");
  check("10h. canStage:false switches Stage portals OFF", apEls.startAutopilotBtn.disabled === true);
  check("10h2. ...and says why as visible text (not only a tooltip)", apEls.autopilotOffReasons.hidden === false && /already staged or filed/.test(offText), offText);
  check("10h3. Approve & Submit's disabled reason is visible text too", /Approve & Submit is off: Nothing is staged/.test(offText), offText);
  apLib.applyAutopilotState({ projectId: "p1", phase: "idle", canApprove: false, canStage: true, stageDisabledReason: null, blockers: [] });
  check("10h4. MUST PASS: canStage:true switches it back ON", apEls.startAutopilotBtn.disabled === false);
  apLib.applyAutopilotState({ projectId: "p-other", phase: "idle", canApprove: true, canStage: false, blockers: [] });
  check("10h5. MUST EXCLUDE: a late state for another project does not repaint this one", apEls.startAutopilotBtn.disabled === false && apEls.approveSubmitBtn.disabled === true);
  // startAutopilot's `finally` must not blindly re-enable a button the server switched off.
  const saEls: Record<string, El> = { startAutopilotBtn: mkEl("startAutopilotBtn") };
  const saState: Record<string, unknown> = { selectedProjectId: "p1", autopilot: null };
  const saLib = load(saEls, saState, { pollAutopilot: async () => { saState.autopilot = { projectId: "p1", phase: "awaiting_approval", canStage: false, blockers: [] }; return saState.autopilot; } });
  await saLib.startAutopilot();
  check("10h6. after a run, Stage portals stays OFF when the newest state says canStage:false", saEls.startAutopilotBtn.disabled === true);

  // 10i — the board card: the assignee reads as an assignment (not a bare "● Sea" fragment), the
  // chip carries the server headline as its title, and a staged draft says so on the card.
  const card = lib.boardCardHtml(
    { id: "c1", status: "awaiting_human_submit", assignedUserId: "u1", pendingReviewCount: 3, projectAddress: "1 Main St",
      nextStep: { key: "staging_failed", who: "me", urgency: "today", headline: "Staging failed for the permit <x>", buttonId: null, gateChecked: false, hasStagedDraft: true } },
    { u1: { name: "Sea", color: "#123456" } });
  check("10i. the assignee is labelled (\"Assigned: Sea\"), with a title naming the assignment",
    /Assigned:<\/span> Sea/.test(card) && /title="Assigned to Sea"/.test(card), card.replace(/\s+/g, " ").slice(-260));
  check("10i2. the chip shows the server's answer and its escaped headline as the title",
    />Staging failed</.test(card) && /title="Staging failed for the permit &lt;x&gt;"/.test(card));
  check("10i3. a staged draft behind another answer says so on the card, and the review total is shown",
    /Draft staged/.test(card) && /3 review items/.test(card) && /data-attn-also="your_submit"/.test(card));

  // 10j — THE AUTOPILOT RAIL NEVER CARRIES ONE PROJECT'S VERDICT ONTO ANOTHER. selectProject
  // used to null state.autopilot only, so project A's ENABLED Stage portals, its badge, its
  // reason lines and its banners stayed painted on project B — for good when B's fetch failed.
  const RAIL_IDS = ["autopilotStatus", "approveSubmitBtn", "startAutopilotBtn", "autopilotOffReasons", "autopilotReason", "reviewMismatchBanner", "reviewMismatchList", "gapFillBanner", "gapFillList"];
  const projectAState = {
    projectId: "p1", phase: "awaiting_approval", stage: "A-STAGE", message: "A-MESSAGE",
    canApprove: false, approveDisabledReason: "A-APPROVE-REASON", canStage: true, stageDisabledReason: null,
    blockers: [{ detail: "A-BLOCKER" }], reviewMismatches: [{ field: "A-FIELD", expected: "x", found: "y" }], gapFillMissing: ["A-GAP"],
  };
  /** Everything of project A still visible on the rail (empty = neutral). */
  const railLeaks = (els: Record<string, El>, st: Record<string, unknown>): string[] => {
    const leaks: string[] = [];
    if (els.startAutopilotBtn.disabled !== true) leaks.push("Stage portals still enabled");
    if (els.startAutopilotBtn.title || els.startAutopilotBtn.dataset.disabledReason) leaks.push(`Stage title "${els.startAutopilotBtn.title}"`);
    if (els.approveSubmitBtn.disabled !== true) leaks.push("Approve still enabled");
    if (els.approveSubmitBtn.title || els.approveSubmitBtn.dataset.disabledReason) leaks.push(`Approve title "${els.approveSubmitBtn.title}"`);
    if (els.autopilotStatus.textContent !== "idle" || els.autopilotStatus.title) leaks.push(`badge "${els.autopilotStatus.textContent}"`);
    if (!els.autopilotOffReasons.hidden || (els.autopilotOffReasons.kids as unknown[]).length) leaks.push("off-reasons shown");
    if (!els.autopilotReason.hidden || els.autopilotReason.textContent) leaks.push(`reason "${els.autopilotReason.textContent}"`);
    if (els.reviewMismatchBanner.style.display !== "none" || els.reviewMismatchList.textContent) leaks.push("mismatch banner");
    if (els.gapFillBanner.style.display !== "none" || els.gapFillList.textContent) leaks.push("gap-fill banner");
    if (st.autopilot) leaks.push("state.autopilot kept");
    return leaks;
  };
  const paintA = (els: Record<string, El>, st: Record<string, unknown>) => {
    load(els, st, { safeRender: () => {} }).applyAutopilotState(projectAState);
    return railLeaks(els, st).length >= 9; // the fixture really painted A (else the test proves nothing)
  };
  {
    // (a) refreshAutopilot's own failure: B is selected, B's fetch rejects.
    const els: Record<string, El> = Object.fromEntries(RAIL_IDS.map((id) => [id, mkEl(id)]));
    const st: Record<string, unknown> = { selectedProjectId: "p1", detail: { stageIndex: 2, project: { id: "p1" } } };
    const painted = paintA(els, st);
    st.selectedProjectId = "p2";
    await load(els, st, { safeRender: () => {}, api: async () => { throw new Error("network down"); } }).refreshAutopilot();
    const leaks = railLeaks(els, st);
    check("10j. a failed autopilot fetch for project B leaves nothing of project A on the rail", painted && leaks.length === 0, `painted=${painted} leaks: ${leaks.join("; ")}`);
    // ...but a late failure for a project already left does not repaint the one now open.
    const els2: Record<string, El> = Object.fromEntries(RAIL_IDS.map((id) => [id, mkEl(id)]));
    const st2: Record<string, unknown> = { selectedProjectId: "p1", detail: { stageIndex: 2, project: { id: "p1" } } };
    paintA(els2, st2);
    const lib2 = load(els2, st2, { safeRender: () => {}, api: async () => { st2.selectedProjectId = "p3"; throw new Error("late"); } });
    await lib2.refreshAutopilot();
    check("10j2. MUST EXCLUDE: a failure that lands after the operator moved on does not touch the rail", els2.startAutopilotBtn.disabled === false);
  }
  {
    // (b) selectProject's own reset: switch A → B; renderDetail (which would refresh) is inert,
    // so only selectProject can put the rail back to neutral.
    const els: Record<string, El> = Object.fromEntries([...RAIL_IDS, "emptyState", "detailView"].map((id) => [id, mkEl(id)]));
    const st: Record<string, unknown> = { selectedProjectId: "p1", detail: { stageIndex: 2, project: { id: "p1" } } };
    const painted = paintA(els, st);
    const noop = async () => {};
    const loaders = Object.fromEntries(["loadKnowledgeBase", "loadOpsPlan", "loadSubmitGate", "loadRunbook", "loadHandoffPacket",
      "loadCommunicationDrafts", "loadLiveReadiness", "loadProjectTimeline", "loadProcessMap", "loadInstallerPacket", "loadProjectDocuments",
      "loadSubmittalTracks", "loadPaymentQuotes", "loadFeeSheet", "loadPortalQuestions", "loadStageResults", "loadCorrectionNotice", "loadStaleReadings", "loadNextStep"].map((n) => [n, noop]));
    const selLib = load(els, st, {
      safeRender: () => {}, api: async () => ({ project: { id: "p2" } }), clearMessage: () => {}, showPage: () => {},
      renderProjects: () => {}, renderOpsActions: () => {}, renderDetail: () => {}, window: { location: { hash: "" } }, ...loaders,
    });
    await selLib.selectProject("p2");
    const leaks = railLeaks(els, st);
    check("10j3. switching project A → B puts the rail back to neutral before B's answer (Stage off, no A reasons/banners)",
      painted && st.selectedProjectId === "p2" && leaks.length === 0, `painted=${painted} leaks: ${leaks.join("; ")}`);
  }
  {
    // (c) THE NEUTRAL RAIL SAYS WHY. A failed fetch turned Stage/Approve off with no visible
    // reason, which reads as "nothing to do here". One line says the state did not load.
    const LOAD_FAILED = "Autopilot state did not load — refresh the page";
    const ids = [...RAIL_IDS, "autopilotLoadFailed"];
    const els: Record<string, El> = Object.fromEntries(ids.map((id) => [id, mkEl(id)]));
    const st: Record<string, unknown> = { selectedProjectId: "p2", detail: { stageIndex: 1, project: { id: "p2" } } };
    await load(els, st, { safeRender: () => {}, api: async () => { throw new Error("network down"); } }).refreshAutopilot();
    check("10j4. a failed autopilot fetch shows the visible 'did not load' line on the rail",
      els.autopilotLoadFailed.hidden === false && els.autopilotLoadFailed.textContent === LOAD_FAILED && els.startAutopilotBtn.disabled === true,
      `hidden=${els.autopilotLoadFailed.hidden} text="${els.autopilotLoadFailed.textContent}"`);
    // A late state for ANOTHER project does not clear it; this project's state does.
    const lib4 = load(els, st, { safeRender: () => {} });
    lib4.applyAutopilotState({ projectId: "p-other", phase: "idle", canApprove: false, canStage: true, blockers: [] });
    check("10j5. MUST EXCLUDE: another project's late state leaves the line up", els.autopilotLoadFailed.hidden === false);
    lib4.applyAutopilotState({ projectId: "p2", phase: "idle", canApprove: false, canStage: true, blockers: [] });
    check("10j6. MUST PASS: this project's state arriving clears the line", els.autopilotLoadFailed.hidden === true && els.autopilotLoadFailed.textContent === "");
    // Switching project: the line was about the project left, so the reset clears it too.
    st.autopilot = null; // 10j6 left p2's state; without this the refresh below would (rightly) keep it and write nothing
    await load(els, st, { safeRender: () => {}, api: async () => { throw new Error("down"); } }).refreshAutopilot();
    const shownBefore = els.autopilotLoadFailed.hidden === false; // else the reset below proves nothing
    load(els, st, { safeRender: () => {} }).resetAutopilotRail();
    check("10j7. MUST EXCLUDE: the neutral reset on a project switch does not carry the line over",
      shownBefore && els.autopilotLoadFailed.hidden === true && els.autopilotLoadFailed.textContent === "", `shownBefore=${shownBefore}`);
    // A failure that lands after the operator moved on writes nothing.
    const els2: Record<string, El> = Object.fromEntries(ids.map((id) => [id, mkEl(id)]));
    const st2: Record<string, unknown> = { selectedProjectId: "p1", detail: { stageIndex: 2, project: { id: "p1" } } };
    await load(els2, st2, { safeRender: () => {}, api: async () => { st2.selectedProjectId = "p3"; throw new Error("late"); } }).refreshAutopilot();
    check("10j8. MUST EXCLUDE: a late failure for a project already left shows no line", els2.autopilotLoadFailed.hidden === true);
  }

  // 10l — WHICH FILING a pasted status is about. recordPermitStatus posted to the stale panel's
  // target or the FIRST target, so on a building + NEM project a pasted utility email could only
  // ever land on the building permit.
  {
    const t1 = { id: "t1", active: true, targetType: "permit", permitType: "building", applicationNumber: "DEMO-SLM-BUILDING-0001", permitNumber: "", portalName: "Salem ePermitting", jurisdiction: "Salem" };
    const t2 = { id: "t2", active: true, targetType: "nem", permitType: "nem", applicationNumber: "<img src=x onerror=alert(1)>", permitNumber: "", portalName: "PGE PowerClerk", jurisdiction: "" };
    const t3 = { id: "t3", active: false, targetType: "permit", permitType: "electrical", applicationNumber: "OLD-1", permitNumber: "", portalName: "", jurisdiction: "" };
    const pickEls = (): Record<string, El> => {
      const e: Record<string, El> = Object.fromEntries(["permitStatusTarget", "permitStatusTargetLabel", "permitStatusText", "permitApplicationNumber", "permitTrackingNumber"].map((id) => [id, mkEl(id)]));
      e.permitStatusTarget.value = "";
      e.permitStatusText.value = "Reviewed and approved.";
      e.permitApplicationNumber.value = "DEMO-SLM-BUILDING-0001"; // syncPermitForm fills these from the FIRST target
      e.permitTrackingNumber.value = "";
      return e;
    };
    const noop = async () => {};
    const loaders = { ...Object.fromEntries(["loadOpsPlan", "loadPmPackets", "loadLiveReadiness", "loadProjectTimeline", "loadProcessMap", "loadInstallerPacket", "loadStaleReadings", "loadProjects"].map((n) => [n, noop])), renderDetail: () => {} };
    let posted: Record<string, unknown> | null = null;
    const api = async (_url: string, opts: { body?: string } = {}) => { posted = JSON.parse(opts.body || "{}"); return { permitCheckTargets: [t1, t2, t3], permitStatusChecks: [] }; };
    const els = pickEls();
    const st: Record<string, unknown> = { selectedProjectId: "p1", recheckTargetId: null, detail: { permitCheckTargets: [t1, t2, t3] } };
    const pl = load(els, st, { api, ...loaders });
    pl.renderPermitStatusTargetPicker();
    const html = String(els.permitStatusTarget.innerHTML);
    check("10l. two active filings: the selector is shown and lists both (the inactive one is left out)",
      els.permitStatusTargetLabel.hidden === false && /Building · DEMO-SLM-BUILDING-0001/.test(html) && /Interconnection \(NEM\) · /.test(html) && !/OLD-1/.test(html), html);
    check("10l2. MUST EXCLUDE: option labels are esc()'d into innerHTML", !/<img/.test(html) && /&lt;img/.test(html));
    check("10l3. the default is the first filing", els.permitStatusTarget.value === "t1");
    els.permitStatusTarget.value = "t2";
    await pl.recordPermitStatus("manual");
    const body = (posted ?? {}) as Record<string, unknown>;
    check("10l4. selecting the SECOND filing posts the second target id", body.targetId === "t2", JSON.stringify(body));
    check("10l5. MUST EXCLUDE: the first filing's application number is not stamped on the second's check",
      body.applicationNumber === "" && body.permitNumber === "", JSON.stringify(body));
    // The first filing still carries the form's numbers — filled by the real syncPermitForm.
    const els1 = pickEls();
    els1.permitApplicationNumber.value = "";
    const st1: Record<string, unknown> = { selectedProjectId: "p1", recheckTargetId: null, detail: { project: { id: "p1", ahj: "Salem" }, permitCheckTargets: [t1, t2], submissions: [] } };
    const pl1 = load(els1, st1, { api, ...loaders });
    pl1.syncPermitForm();
    posted = null;
    await pl1.recordPermitStatus("manual");
    const body1 = (posted ?? {}) as Record<string, unknown>;
    check("10l6. MUST PASS: the first filing posts its own id and the form's application number",
      body1.targetId === "t1" && body1.applicationNumber === "DEMO-SLM-BUILDING-0001", JSON.stringify(body1));
    // The stale panel's pick is the default when set; a single filing hides the selector.
    const els3 = pickEls();
    const st3: Record<string, unknown> = { selectedProjectId: "p1", recheckTargetId: "t2", detail: { permitCheckTargets: [t1, t2] } };
    load(els3, st3, { api, ...loaders }).renderPermitStatusTargetPicker();
    check("10l7. the stale panel's re-check target is preselected", els3.permitStatusTarget.value === "t2");
    const els4 = pickEls();
    load(els4, { selectedProjectId: "p1", recheckTargetId: null, detail: { permitCheckTargets: [t1, t3] } }, { api, ...loaders }).renderPermitStatusTargetPicker();
    check("10l8. MUST EXCLUDE: one active filing hides the selector", els4.permitStatusTargetLabel.hidden === true);
    // An explicit target (the stale panel's public-URL re-check) still wins over the selector.
    const els5 = pickEls();
    const st5: Record<string, unknown> = { selectedProjectId: "p1", recheckTargetId: null, detail: { permitCheckTargets: [t1, t2] } };
    const pl5 = load(els5, st5, { api, ...loaders });
    pl5.renderPermitStatusTargetPicker();
    posted = null;
    await pl5.recordPermitStatus("public_url", "t2");
    check("10l9. MUST PASS: an explicit target id (stale-panel fetch) is posted as given",
      (posted as Record<string, unknown> | null)?.targetId === "t2");
    // The stale panel's "Paste a fresh status" (no portal URL) promises the paste is recorded
    // against ITS filing. The selector wins at POST time, so the panel must move the selector —
    // else the operator's paste goes to whatever the selector happened to show.
    class FakeEl {}
    const els6 = pickEls();
    els6.permitStatusText.focus = () => {};
    els6.permitStatusText.scrollIntoView = () => {};
    const st6: Record<string, unknown> = { selectedProjectId: "p1", recheckTargetId: null, detail: { permitCheckTargets: [t1, t2] } };
    const pl6 = load(els6, st6, { api, ...loaders, Element: FakeEl });
    pl6.renderPermitStatusTargetPicker();
    els6.permitStatusTarget.value = "t2"; // the operator had the NEM filing selected
    pl6.syncPermitForm(); // …so the number fields hold the NEM filing's numbers
    const beforeClick = els6.permitApplicationNumber.value;
    const clicked = Object.assign(new FakeEl(), { closest: () => ({ dataset: { recheckTarget: "t1", recheckSource: "manual" } }) });
    pl6.handleStaleRecheckClick({ target: clicked });
    // The re-check moved the selector to t1 — the number fields must follow it (the syncPermitForm()
    // call in handleStaleRecheckClick), or the form shows the NEM filing's number beside a selector
    // that names the building permit, and the paste posts that number with the building's check.
    const afterClick = `${els6.permitApplicationNumber.value}|${els6.permitTrackingNumber.value}`;
    posted = null;
    await pl6.recordPermitStatus("manual");
    check("10l10. the stale panel's manual re-check moves the selector to its filing, and the paste posts there",
      els6.permitStatusTarget.value === "t1" && (posted as Record<string, unknown> | null)?.targetId === "t1",
      `selector=${els6.permitStatusTarget.value} posted=${JSON.stringify(posted)}`);
    check("10l10b. ...and the number fields are refilled from THAT filing (never the one selected before the click)",
      beforeClick === t2.applicationNumber && afterClick === "DEMO-SLM-BUILDING-0001|"
        && (posted as Record<string, unknown> | null)?.applicationNumber === "DEMO-SLM-BUILDING-0001",
      `before=${beforeClick} after=${afterClick} posted=${JSON.stringify(posted)}`);

    // 10l11 — THE NUMBERS COME FROM THE SELECTED FILING ONLY. With the FIRST filing selected (no
    // permit number of its own), syncPermitForm fell back to "the first submission carrying a
    // permit number" — the SECOND filing's — and recordPermitStatus posted it with the first
    // filing's check; the server keeps a posted number over the target's own.
    const f1 = { id: "f1", active: true, targetType: "permit", permitType: "building", applicationNumber: "BLD-26-0001", permitNumber: "", portalName: "Salem ePermitting", jurisdiction: "Salem", checkFrequencyDays: 7 };
    const f2 = { id: "f2", active: true, targetType: "permit", permitType: "electrical", applicationNumber: "ELE-26-0002", permitNumber: "ELE-PERMIT-99", portalName: "Salem ePermitting", jurisdiction: "Salem", checkFrequencyDays: 7 };
    const numEls = (): Record<string, El> => {
      const e = pickEls();
      e.permitApplicationNumber.value = "";
      e.permitTrackingNumber.value = "";
      return e;
    };
    const detail11 = { project: { id: "p11", ahj: "Salem" }, permitCheckTargets: [f1, f2], submissions: [
      { submissionType: "permit", permitType: "electrical", applicationNumber: "ELE-26-0002", permitNumber: "ELE-PERMIT-99" },
    ] };
    const els11 = numEls();
    const st11: Record<string, unknown> = { selectedProjectId: "p11", recheckTargetId: null, detail: detail11 };
    const pl11 = load(els11, st11, { api, ...loaders });
    pl11.syncPermitForm();
    posted = null;
    await pl11.recordPermitStatus("manual");
    const body11 = (posted ?? {}) as Record<string, unknown>;
    check("10l11. MUST EXCLUDE: the FIRST filing selected, the form and the POST never carry the second filing's permit number",
      els11.permitStatusTarget.value === "f1" && body11.targetId === "f1" && !body11.permitNumber && els11.permitTrackingNumber.value === "",
      `selector=${els11.permitStatusTarget.value} field=${els11.permitTrackingNumber.value} posted=${JSON.stringify(body11)}`);
    check("10l12. MUST PASS: ...and the first filing's own application number is still posted", body11.applicationNumber === "BLD-26-0001", JSON.stringify(body11));
    // Picking the second filing re-fills the numbers from IT (the selector's change handler), and
    // picking the first again empties them — a leftover is another filing's number.
    // (A fresh page state: recordPermitStatus above replaced state.detail with the stub's reply.)
    const els13 = numEls();
    const pl13 = load(els13, { selectedProjectId: "p11", recheckTargetId: null, detail: detail11 }, { api, ...loaders });
    pl13.syncPermitForm();
    els13.permitStatusTarget.value = "f2";
    pl13.syncPermitForm();
    const onSecond = `${els13.permitApplicationNumber.value}|${els13.permitTrackingNumber.value}`;
    els13.permitStatusTarget.value = "f1";
    pl13.syncPermitForm();
    const backOnFirst = `${els13.permitApplicationNumber.value}|${els13.permitTrackingNumber.value}`;
    check("10l13. switching filings replaces the numbers with the selected filing's own (never carries the last one's)",
      onSecond === "ELE-26-0002|ELE-PERMIT-99" && backOnFirst === "BLD-26-0001|", `second=${onSecond} first=${backOnFirst}`);
  }

  // 10m — THE GATE PANEL NAMES EVERY DOCUMENT ITS CHECK NAMES. The document check writes a count
  // line and up to four "✓" lines first; the panel printed evidence.slice(0, 4), so the
  // "Filled at staging: …" line (index 5 on e6b3afde / 8f4ca8dd) — the only place the held-out
  // checklist is named when the check is a WARNING over an advisory — never reached the screen.
  {
    const docCheck = {
      id: "document-inventory", title: "Required documents attached", lane: "permit", status: "warning", ownerRole: "Permit Ops",
      source: "documents.inventory", requirement: "Every required submittal document must be attached.",
      nextAction: "Confirm the advisory document(s) are included in the plan set.",
      evidence: [
        "6/7 required documents present, 1 more filled from a stored template at staging.",
        "✓ Plan set (attached file)", "✓ Site plan (in plan set)", "✓ Single-line diagram (in plan set)", "✓ Module spec sheet (in plan set)",
        "Filled at staging: Solar prescriptive checklist, filled — the form's template is on file; staging fills it and offers it to any upload slot that asks for it (check the portal's attachment list before submitting)",
        "Missing (advisory): <img src=x onerror=alert(1)> Fire access plan",
      ],
    };
    const passCheck = { ...docCheck, id: "qc-human-review", title: "QC", status: "pass", nextAction: "Nothing to do.", evidence: ["a", "b", "c", "d", "e", "f"] };
    const gateEls: Record<string, El> = Object.fromEntries(["submitGate", "submitGateStatus", "copySubmitGateBtn", "prepareBtn"].map((id) => [id, mkEl(id)]));
    load(gateEls, { submitGate: { decision: "ready_to_stage", headline: "Ready", nextAction: "Stage it.", canPrepareSubmission: true, checks: [docCheck, passCheck], manualSubmitChecklist: [] }, detail: null },
      { ensureKeelixDetailStyles: () => {} }).renderSubmitGate();
    const html = String(gateEls.submitGate.innerHTML);
    const at = html.indexOf("Required documents attached");
    const visible = at < 0 ? "" : html.slice(at, html.indexOf('<details class="provenance">', at));
    check("10m. the document check's 'Filled at staging' line is shown under Next, outside the closed fold",
      /Filled at staging: Solar prescriptive checklist, filled/.test(visible), visible.slice(0, 400));
    check("10m2. ...and every other line that names a document's state (advisory / MISSING) is shown there too, esc()'d",
      /Missing \(advisory\): &lt;img/.test(visible) && !/<img/.test(html), visible.slice(0, 400));
    check("10m3. MUST EXCLUDE: the present-document ✓ lines stay in the fold (Next stays the act-on-it half)",
      !/✓ Plan set/.test(visible) && /✓ Module spec sheet/.test(html), visible.slice(0, 400));
    check("10m4. MUST PASS: no evidence line is dropped any more — a pass row's six lines all render in its fold",
      ["a", "b", "c", "d", "e", "f"].every((l) => html.includes(`<li>${l}</li>`)), html.slice(-600));
  }

  // 10k — the banner's "Show" for a portal run lands ON the run: revealElement opens the closed
  // "Earlier runs (N · M failed)" fold inside #portalRuns and lands on its failed card.
  {
    const flash = () => ({ set: new Set<string>(), add(c: string) { this.set.add(c); }, remove(c: string) { this.set.delete(c); } });
    let landed = "";
    const failCard = { tagName: "ARTICLE", classList: flash(), scrollIntoView: () => { landed = "failCard"; } };
    const fold = { tagName: "DETAILS", open: false, querySelector: (sel: string) => (sel === ".item.fail" ? failCard : null) };
    const runsEl = {
      tagName: "DIV", parentElement: null, classList: flash(), dataset: {},
      querySelector: (sel: string) => (sel === "details.runs-fold" ? fold : null),
      scrollIntoView: () => { landed = "portalRuns"; }, focus: () => {},
    };
    lib.revealElement(runsEl);
    check("10k. Show on a portal run opens the closed runs fold", fold.open === true);
    check("10k2. ...and lands on the failed run card inside it, not the list's closed summary line", landed === "failCard", `landed on ${landed}`);
  }
  // 10o — THE PERMIT / NEM METRIC READS EACH FILING'S STATE, NOT THE LANE ROLLUP. It read the
  // process map's permitStatus ("waiting" whenever any step waits) and so said "Permit Waiting"
  // beside a ready_for_issue permit. It reads the submittal tracks now, in the SAME words the
  // server's process-map headline uses (trackStateSummary) — pinned equal for every status.
  {
    const demo = [
      { type: "nem", category: "utility", status: "in_review" },
      { type: "building", category: "permit", status: "ready_for_issue" },
      { type: "electrical", category: "permit", status: "in_review" },
    ];
    const w = lib.trackStateWords(demo);
    check("10o. a ready_for_issue building permit reads 'fee due' on the metric, never 'waiting'", w?.permit === "building fee due, electrical in review" && w?.nem === "in review", JSON.stringify(w));
    check("10o2. no tracks loaded → null (the metric says 'Not checked', never a lane rollup)", lib.trackStateWords(null) === null && lib.trackStateWords([]) === null);
    const statuses = ["not_started", "staged", "submitted", "in_review", "correction", "ready_for_issue", "issued"];
    const drift: string[] = [];
    for (const st of statuses) {
      for (const set of [[{ type: "combo", category: "permit", status: st }, { type: "nem", category: "utility", status: st }],
        [{ type: "building", category: "permit", status: st }, { type: "electrical", category: "permit", status: "in_review" }]]) {
        const a = JSON.stringify(lib.trackStateWords(set)), b = JSON.stringify(trackStateSummary(set as never));
        if (a !== b) drift.push(`${st}: dashboard ${a} vs server ${b}`);
      }
    }
    check("10o3. ONE ANSWER: the dashboard's words equal the server headline's for every track status", drift.length === 0, drift.join("; "));
  }

  // 10p — THE KNOWLEDGE BADGE FOLLOWS THE LOCK. "mixed" rows were unlocked (only verified_at locks
  // a row now — hard rule 3), yet the KB list still badged them "mixed" exactly as before, a label
  // operators read as "a person checked this". "Verified" appears only when verifiedAt is set.
  {
    const verified = String(lib.kbConfidenceBadge({ confidence: "mixed", verifiedAt: "2026-09-19T12:00:00Z", verifiedBy: "operator ruling 2026-09-19" }));
    const mixed = String(lib.kbConfidenceBadge({ confidence: "mixed", verifiedAt: null, verifiedBy: "" }));
    const learnedVerified = String(lib.kbConfidenceBadge({ confidence: "learned", verifiedAt: "2026-09-19T12:00:00Z" }));
    const seeded = String(lib.kbConfidenceBadge({ confidence: "seeded", verifiedAt: null }));
    check("10p. verifiedAt set → a 'Verified' pass badge (whatever the confidence label)", />Verified</.test(verified) && /badge-pass/.test(verified) && />Verified</.test(learnedVerified), verified);
    check("10p2. MUST EXCLUDE: an unverified 'mixed' row never reads Verified, and reads as the plain merge", !/Verified</.test(mixed) && !/badge-pass/.test(mixed) && mixed.includes(">Learned + seeded<"), mixed);
    check("10p3. an unverified seeded row keeps its plain label", />Seeded</.test(seeded) && !/Verified</.test(seeded), seeded);
    check("10p4. the KB list card and the project's learned-requirements card both use it",
      dashboard.includes("${kbConfidenceBadge(profile)}") && dashboard.includes("${kbConfidenceBadge(learned)}")
        && !dashboard.includes("statusBadge(profile.confidence)") && !dashboard.includes("statusBadge(learned.confidence)"));
  }

  // 10n — THE TRACKING LIST NAMES THE FILING THE SAME WAY THE SELECTOR DOES. renderPermitMonitor
  // labelled every non-NEM target "(building permit)": an electrical filing read "Online portal
  // (building permit)" right beside a selector that called it Electrical. Both read ONE helper.
  {
    const targets = [
      { id: "t-e", active: true, targetType: "permit", permitType: "electrical", portalName: "Online portal", applicationNumber: "ELE-1", checkFrequencyDays: 7 },
      { id: "t-s", active: true, targetType: "permit", permitType: "structural", portalName: "Structural portal", applicationNumber: "STR-1", checkFrequencyDays: 7 },
      { id: "t-n", active: true, targetType: "nem", permitType: "", portalName: "PowerClerk", applicationNumber: "NEM-1", checkFrequencyDays: 7 },
    ];
    const els: Record<string, El> = { permitTargets: mkEl("permitTargets"), permitChecks: mkEl("permitChecks"), permitStatusTarget: mkEl("permitStatusTarget"), permitStatusTargetLabel: mkEl("permitStatusTargetLabel") };
    const st = { detail: { project: { id: "p-mon" }, permitCheckTargets: targets, permitStatusChecks: [], emailProjectMatches: [] } };
    load(els, st, { staleReadingPanel: () => "", statusLabel: (x: string) => x }).renderPermitMonitor();
    const html = String(els.permitTargets.innerHTML);
    const cards = html.split("<article").slice(1);
    const cardFor = (name: string) => cards.find((c) => c.includes(name)) ?? "";
    check("10n. MUST EXCLUDE: an electrical filing is never labelled a building permit", !/building permit/i.test(cardFor("Online portal")) && /Online portal · Electrical/.test(cardFor("Online portal")), cardFor("Online portal").slice(0, 220));
    check("10n2. a structural filing reads Building (the building track's family)", /Structural portal · Building/.test(cardFor("Structural portal")), cardFor("Structural portal").slice(0, 220));
    check("10n3. the NEM filing reads Interconnection (NEM)", /PowerClerk · Interconnection \(NEM\)/.test(cardFor("PowerClerk")), cardFor("PowerClerk").slice(0, 220));
    for (const t of targets) {
      check(`10n4. list and selector agree on the kind (${t.permitType || t.targetType})`, String(lib.permitTargetOptionLabel(t)).startsWith(`${lib.permitTargetKindLabel(t)} · `) && cardFor(t.portalName).includes(` · ${lib.permitTargetKindLabel(t)}`),
        `${lib.permitTargetOptionLabel(t)} vs ${cardFor(t.portalName).slice(0, 160)}`);
    }
  }
}

console.log(failures === 0
  ? `\nSUBMIT SEAM: all checks passed.`
  : `\nSUBMIT SEAM: ${failures} check(s) FAILED.`);
assert.equal(failures, 0, `${failures} submit-seam check(s) failed`);
