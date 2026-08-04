// ---------------------------------------------------------------------------
// Real-engagement rehearsal harness — drives ONE realistic solar project through
// the entire backend pipeline the way a real job flows, then runs the autonomous
// autopilot to the human-approval gate and through the post-approval submit.
//
// Two modes:
//   - simulated (live:false): MockPortalAdapter, deterministic, CI-safe. Proves the
//     whole intake → stage → approve → submit loop, including the autopilot state
//     machine, without touching a real portal.
//   - live (live:true): same chain against the real portal, staged to review only,
//     autoSubmit hard-disabled — a manual dress rehearsal (see rehearsal.live.smoke.ts).
//
// This is the repeatable "as if a real engagement" test the project was missing.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openDatabase, type AppDb } from "../src/db";
import { createClient } from "../src/clients";
import { saveProjectDocument } from "../src/projectDocuments";
import { createProject, getProjectDetail, getReviewerReport } from "../src/repository";
import { runAutopilotSegmentA, runAutopilotApproval, getAutopilotState } from "../src/autopilot";

export interface RehearsalOptions {
  live?: boolean;
  dbPath?: string;
}

export interface RehearsalResult {
  projectId: string;
  finalStatus: string;
  approvedState: ReturnType<typeof getAutopilotState>;
  submitted: boolean;
}

// A realistic City-of-Portland / PGE engagement. Mirrors the field set the parser
// produces and the QC/reviewer/document gates require — synthetic PII only.
const FIXTURE_PROJECT = {
  owner: "Rehearsal Homeowner",
  street: "742 Evergreen Terrace",
  city: "Portland",
  state: "OR",
  zip: "97201",
  ahj: "Portland",
  utility: "PGE",
  account: "2200334455",
  meter: "M55443322",
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

export async function rehearse(options: RehearsalOptions = {}): Promise<RehearsalResult> {
  const live = Boolean(options.live);
  const dbPath = options.dbPath || path.resolve(process.cwd(), "backend/data/rehearsal.sqlite");
  fs.rmSync(dbPath, { force: true });
  process.env.AUTOPILOT_DB_PATH = dbPath;
process.env.AUTOPILOT_AUTO_START = "0"; // deterministic tests — no background autopilot

  const db: AppDb = await openDatabase();

  // 1. Onboard the submitting contractor (the CCB gate needs a real license number).
  const client = createClient(db, {
    companyName: "Rehearsal Solar LLC",
    legalBusinessName: "Rehearsal Solar LLC",
    ccbLicenseNumber: "240135",
    electricalLicenseNumber: "C1234",
    businessEmail: "ops@rehearsalsolar.test",
    businessPhone: "(503) 555-0142",
  });

  // 2. Intake → parse → QC (createProject runs QC automatically).
  const detail = createProject(db, { clientId: client.id, ...FIXTURE_PROJECT });
  assert.equal(detail.project.status, "qc_passed", `expected qc_passed after intake, got ${detail.project.status}`);
  const projectId = detail.project.id;

  // 3. Attach the plan-set file so the document-presence gate is satisfied.
  const planSetPath = path.resolve(process.cwd(), "backend/test/fixtures/rehearsal/plan-set.pdf");
  const planSet = fs.existsSync(planSetPath)
    ? fs.readFileSync(planSetPath)
    : Buffer.from("%PDF-1.4\n% rehearsal plan set\n", "utf8");
  saveProjectDocument(db, projectId, { docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf", buffer: planSet, source: "upload" });

  // 4. Reviewer gate must be blocker-free before the autopilot will stage.
  const reviewer = getReviewerReport(db, projectId);
  const blockers = reviewer.findings.filter((f) => f.severity === "blocker");
  assert.equal(blockers.length, 0, `reviewer gate has blockers: ${blockers.map((b) => b.title).join("; ")}`);

  // 5. AUTOPILOT Segment A — autonomous run to the approval gate.
  const segA = await runAutopilotSegmentA(db, projectId);
  assert.equal(segA.blocked, false, `autopilot blocked unexpectedly: ${segA.blockers.map((b) => b.detail).join("; ")}`);
  const staged = getProjectDetail(db, projectId);
  assert.equal(staged.project.status, "awaiting_human_submit", `expected awaiting_human_submit, got ${staged.project.status}`);

  const gateState = getAutopilotState(db, projectId);
  assert.equal(gateState.phase, "awaiting_approval", `expected awaiting_approval, got ${gateState.phase}`);
  assert.equal(gateState.canApprove, true, "expected the approval gate to be open (zero blockers)");

  // The staged run must NOT have clicked final submit — automation stops at the gate.
  const stagedRun = staged.portalRuns?.[0];
  assert.ok(stagedRun, "expected a portal run row from staging");
  assert.notEqual(stagedRun?.status, "submitted", "staging must not auto-submit before approval");

  if (live) {
    // Live dress rehearsal stops here: a human reviews the staged portal application
    // and clicks Approve & Submit in the dashboard. Nothing is filed by the harness.
    return { projectId, finalStatus: staged.project.status, approvedState: gateState, submitted: false };
  }

  // 6. HUMAN GATE → Segment B. Simulated mode submits autonomously via the mock so the
  // full approval loop is asserted end-to-end.
  const approved = await runAutopilotApproval(db, projectId, { approverName: "Rehearsal Approver", approverUserId: null });
  const final = getProjectDetail(db, projectId);
  const submitted = approved.phase === "submitted";
  assert.equal(approved.phase, "submitted", `expected submitted after approval, got ${approved.phase}`);
  assert.equal(final.project.status, "submitted", `expected project submitted, got ${final.project.status}`);

  // Confirmation must have been captured from the (mock) portal completion page.
  const submission = final.submissions?.find((s) => s.status === "submitted");
  assert.ok(submission, "expected a submitted submission record after approval");
  assert.ok(submission?.permitNumber, "expected a captured permit/record number after autonomous submit");

  return { projectId, finalStatus: final.project.status, approvedState: approved, submitted };
}
