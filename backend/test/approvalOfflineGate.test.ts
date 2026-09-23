// PORTAL_AUTOMATION=off REFUSES "APPROVE & SUBMIT", NOT ONLY "STAGE".
//
// prepareSubmission already stops before any browser when the installation is offline (the
// demo kit). runAutopilotApproval did not ask: a run staged by MockPortalAdapter went straight
// to submitStagedRun, the mock "clicked final submit", captureConfirmation stamped MOCK-/CONF-
// numbers and the project became `submitted` — on an install whose .env promises nothing is
// ever filed. The refusal must come BEFORE any adapter work and write NOTHING: no approval
// audit row, no submission, no status change.
//
// Fixture shapes copied from submitSeam.test.ts (reviewer-gate-clean project, parked
// `awaiting_human_submit`, a portal_run in the shape prepareSubmission writes).
//
// Browser-free. Run: tsx backend/test/approvalOfflineGate.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "approval-offline-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
// Fixture plan sets go to the temp dir, never the repo's real backend/data/project-documents.
process.env.PROJECT_DOCS_DIR = path.join(dir, "project-documents");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
delete process.env.PORTAL_AUTOMATION;

const { openDatabase } = await import("../src/db");
const { createProject } = await import("../src/repository");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { runAutopilotApproval } = await import("../src/autopilot");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

const db = await openDatabase();
type Row = Record<string, unknown>;

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

const mkProject = (name: string): string => {
  const d = createProject(db, { ...COMPLETE_PROJECT, owner: name, ahj: "City of Coos Bay", utility: "Pacific Power" } as never);
  saveProjectDocument(db, d.project.id, {
    docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% approval-offline fixture plan set\n", "utf8"), source: "upload",
  });
  db.run("UPDATE projects SET status = 'awaiting_human_submit', current_stage = ?, stage_detail = 'staged_for_review' WHERE id = ?",
    ["NEM Pacific Power (NEM portal) staged. Human must verify and submit manually.", d.project.id]);
  return d.project.id;
};
const mkRun = (runId: string, pid: string, actor: string): void => {
  db.run(
    `INSERT INTO portal_runs (id, project_id, portal_profile_id, run_type, status, started_at, error_message,
       human_action_required, screenshots_path, logs_path, result_json, permit_type)
     VALUES (?, ?, NULL, 'prepare_submit', 'awaiting_human_submit', ?, '', 0, '', '', ?, 'nem')`,
    [runId, pid, "2026-09-10T00:00:00.000Z", JSON.stringify({ actor, ok: true, finalSubmitClicked: false })],
  );
};
const snapshot = (pid: string, runId: string) => ({
  project: db.get<Row>("SELECT status, current_stage, stage_detail FROM projects WHERE id = ?", [pid]),
  run: db.get<Row>("SELECT status, result_json FROM portal_runs WHERE id = ?", [runId]),
  submissions: Number(db.get<Row>("SELECT COUNT(*) AS n FROM submissions WHERE project_id = ?", [pid])?.n ?? 0),
  audit: db.query<Row>("SELECT action FROM audit_logs WHERE project_id = ? ORDER BY created_at", [pid]).map((r) => String(r.action)),
});
const approve = async (pid: string): Promise<{ status?: number; message: string; details?: unknown }> => {
  try {
    await runAutopilotApproval(db, pid, { approverName: "Operator Under Test", approverUserId: null });
    return { message: "" };
  } catch (err) {
    const e = err as { status?: number; statusCode?: number; message?: string; details?: unknown; data?: unknown };
    return { status: e.status ?? e.statusCode, message: String(e.message || err), details: e.details ?? e.data };
  }
};

for (const actor of ["MockPortalAdapter", "RecipeAdapter"]) {
  console.log(`\n${actor === "MockPortalAdapter" ? 1 : 2}. PORTAL_AUTOMATION=off — ${actor}-staged run: REFUSED, NOTHING WRITTEN`);
  const pid = mkProject(`Offline ${actor}`);
  const runId = `run-offline-${actor}`;
  mkRun(runId, pid, actor);
  const before = snapshot(pid, runId);
  process.env.PORTAL_AUTOMATION = "off";
  const r = await approve(pid);
  delete process.env.PORTAL_AUTOMATION;
  const after = snapshot(pid, runId);
  check("a. refused with a 409", r.status === 409, `status=${r.status} message=${r.message.slice(0, 160)}`);
  check("b. the refusal says why (PORTAL_AUTOMATION=off) and carries the same machine flag staging does",
    /PORTAL_AUTOMATION=off/.test(r.message) && (r.details as Record<string, unknown> | undefined)?.portalAutomationDisabled === true,
    `${r.message.slice(0, 160)} details=${JSON.stringify(r.details)}`);
  check("c. MUST EXCLUDE: status unchanged (still awaiting_human_submit)",
    after.project?.status === "awaiting_human_submit", String(after.project?.status));
  // (captureConfirmation UPDATEs submissions rows rather than inserting, so a row count proves
  // nothing here; the staged run's own status is what a mock "submit" flips.)
  check("d. MUST EXCLUDE: the staged run was not marked submitted", after.run?.status === "awaiting_human_submit", String(after.run?.status));
  check("e. MUST EXCLUDE: no approval / submit audit row", !after.audit.some((a) => /^autopilot\.(approved|submitted)/.test(a)), JSON.stringify(after.audit));
  check("f. nothing about the project or its staged run changed at all", JSON.stringify(after) === JSON.stringify(before),
    `${JSON.stringify(before).slice(0, 200)} -> ${JSON.stringify(after).slice(0, 200)}`);
}

console.log("\n3. COUNTER-FIXTURE — same mock-staged shape with automation ON still approves (the gate is the switch, not the fixture)");
{
  const pid = mkProject("Online Mock");
  mkRun("run-online-mock", pid, "MockPortalAdapter");
  const r = await approve(pid);
  const after = snapshot(pid, "run-online-mock");
  check("3a. no refusal", r.message === "", r.message.slice(0, 200));
  check("3b. the mock path ran to submitted", after.project?.status === "submitted", String(after.project?.status));
}

console.log(failures ? `\napprovalOfflineGate: ${failures} FAILED` : "\napprovalOfflineGate: all passed");
process.exit(failures ? 1 : 0);
