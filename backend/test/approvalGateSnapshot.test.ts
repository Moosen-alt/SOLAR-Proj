// THE APPROVER SAW THE GATE AS IT WAS AT THE CLICK (issue #226; hard rule 1).
//
// Approve & auto-submit records the run approval and then queues prepare_submission. A stage_step
// job (whose reviewer-gate step runs the vision pass) may run beside it, and after #214 a verdict it
// caches relaxes a blocker on every reader. So a verdict written AFTER the click could be what let
// that run's final submit through: the approver was shown a blocker that no longer held when the run
// reached the gate. Now a final-submit run reads the gate a second time with only the verdicts cached
// before the approval's created_at; a blocker relaxed now but not then makes automaticSubmitRefusals
// refuse, and the run stages like an ordinary run and stops at review. Staging and Approve also write
// one `reviewer_gate.vision_relaxed_at_stage` audit row when they go past a vision-relaxed blocker.
//
// Fixtures are SYNTHETIC (the stage fixture's Portland/PGE job, a one-page pdf-lib plan set).
// Verdicts are written by the PRODUCTION writer: the real vision pass with a fake LLM, as the
// stage_step chain does. The final submit is decided by the REAL prepareSubmission; the bot is stubbed
// and only reports what it was allowed.
//
//   MUST-STOP    a verdict cached after the approval relaxes the only blocker → the run stages,
//                autoSubmit is false, the decline names the finding, the approval is still burned.
//   MUST-PASS    the same verdict cached BEFORE the approval → the run is allowed (no outage).
//   ORDINARY     a run that asked for no final submit is unchanged: it stages past the relaxed blocker.
//   AUDIT        staging and Approve past a relaxed blocker write the row (finding id, question hash,
//                page, confidence, run id); staging with nothing relaxed writes none.
//
// Run: npx tsx backend/test/approvalGateSnapshot.test.ts
import "./_isolate"; // FIRST: generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("approval-gate-snapshot");
const { db, repo } = fx;
const { PDFDocument, StandardFonts } = await import("pdf-lib");
const docs = await import("../src/projectDocuments");
const { findPlanSetPdf } = await import("../src/pageImages");
const { applyVisionToReviewerReport, visionQuestionFor } = await import("../src/reviewerVision");
const { runAutopilotApproval } = await import("../src/autopilot");

const RSD = "city.elec.rapid-shutdown-missing"; // presence rule on a plan topic: vision may relax it
// The fixture names rapid shutdown in three fields and runs micro-inverters (RSD only a warning).
// Without the words and with a string inverter RSD is a text BLOCKER.
const RSD_BLOCKER = {
  electricalCalcText: "NEC 705.12 load-side calculation: 200A bus x 120 percent = 240A, 200A main + 40A PV breaker = 240A.",
  labelsText: "PV label schedule includes service power source directory, disconnect labels, and backfed breaker warning.",
  splitPagesText: "01 Site/Roof Plan and PV layout with fire pathway: pages 1-2\n02 SLD 3-Line Diagram with NEC 705.12 calculation: page 3\n03 Roof framing and racking attachment detail: pages 4-5\n04 Module spec UL 61730: pages 6-8\n05 Inverter spec UL 1741 SB: pages 9-11\n06 Label schedule and placards: page 12",
  invModel: "Sunny Boy SB7.7-1SP-US-41", invQty: "1",
};

/** A vision model that confirms every item it is asked about, with high confidence. */
const fakeVision = {
  async visionExtract(input: { prompt: string }): Promise<Record<string, unknown>> {
    if (/Read the DIMENSIONS/.test(input.prompt)) return { confidence: "low" };
    return { present: true, confidence: "high", observed: "synthetic sheet shows the item", missing: "" };
  },
} as never;

async function planSetPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  ["PV-1 SITE PLAN", "ROOF MOUNTED PV ARRAY", "E-1 SINGLE LINE DIAGRAM"].forEach((line, i) =>
    page.drawText(line, { x: 40, y: 740 - i * 18, size: 11, font }));
  return Buffer.from(await pdf.save());
}

/** A project held only by relaxable text blockers (RSD, and the label schedule's missing RSD label),
 *  judged on a real plan-set PDF. Returns the blocker ids. */
let BLOCKERS: string[] = [];
async function rsdProject(): Promise<string> {
  const id = fx.newProject(RSD_BLOCKER as never);
  const doc = docs.saveProjectDocument(db, id, {
    docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf", buffer: await planSetPdf(), source: "upload",
  });
  const stored = db.get<{ stored_path: string }>("SELECT stored_path FROM project_documents WHERE id = ?", [doc.id])!.stored_path;
  db.run("UPDATE project_documents SET uploaded_at = '2000-01-01T00:00:00.000Z' WHERE project_id = ? AND id <> ?", [id, doc.id]);
  assert.equal(findPlanSetPdf(db, id), stored, "setup: the gate would judge the placeholder plan set");
  const deadline = Date.now() + 20_000;
  while (db.get("SELECT 1 FROM project_documents WHERE project_id = ? AND content_type LIKE '%pdf%' AND extracted_text = ''", [id])) {
    if (Date.now() > deadline) throw new Error("plan-set text extraction did not land within 20 s");
    await new Promise((r) => setTimeout(r, 50));
  }
  const blockers = repo.reviewerGateReportFor(db, repo.getProjectDetail(db, id).project).findings.filter((f) => f.severity === "blocker").map((f) => f.id);
  assert.ok(blockers.includes(RSD), `setup: RSD should be a blocker, got ${blockers.join(", ")}`);
  BLOCKERS = blockers.sort();
  return id;
}

/** The vision pass a stage_step runs: caches a present/high verdict for every blocker, which relaxes
 *  them all. Returns the question RSD's verdict answers. */
async function visionPass(projectId: string): Promise<string> {
  const raw = repo.buildReviewerReportFor(db, repo.getProjectDetail(db, projectId).project);
  await applyVisionToReviewerReport(db, fakeVision, raw);
  const gate = repo.reviewerGateReportFor(db, repo.getProjectDetail(db, projectId).project);
  assert.deepEqual(gate.findings.filter((f) => f.severity === "blocker").map((f) => f.id), [], "setup: the vision verdicts left a blocker");
  assert.equal(gate.findings.find((f) => f.id === RSD)?.severity, "callout", "setup: the vision verdict did not relax RSD");
  return visionQuestionFor(raw.findings.find((f) => f.id === RSD)!);
}

/** Wait until the ISO clock has moved on, so "before" and "after" are different instants. */
const tick = async () => { const t = new Date().toISOString(); while (new Date().toISOString() === t) await new Promise((r) => setTimeout(r, 2)); };

type Seen = { autoSubmit?: boolean; runId?: string };
async function stage(projectId: string, opts: { approvalId?: string | null; final: boolean }) {
  process.env.PORTAL_ALLOW_FINAL_SUBMIT = "1";
  let seen: Seen | null = null;
  fx.stubRunner(async (_r, _p, _f, _d, _files, options) => {
    seen = { autoSubmit: options?.autoSubmit, runId: options?.runId };
    return { portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, steps: [{ ok: true, message: "staged" }] };
  });
  try {
    await repo.prepareSubmission(db, projectId, undefined, opts.final ? true : undefined, undefined, opts.approvalId ?? null);
  } finally {
    delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  }
  assert.ok(seen, "the run never reached the bot");
  return seen as unknown as Seen;
}
const approve = (projectId: string) => repo.createRunApproval(db, { projectId, track: "permit", approver: "A. Person", approverUserId: null });
const auditsFor = (action: string, projectId: string) =>
  fx.audits(action).filter((a) => a.project_id === projectId).map((a) => JSON.parse(String(a.details)) as Record<string, unknown>);

const findingOf = (row: Record<string, unknown>, findingId: string) =>
  (row.findings as Array<Record<string, unknown>>).find((f) => f.findingId === findingId);

console.log("approval gate snapshot: the approver saw the gate as it was at the click (#226)");

fx.completeRecipe(); // [...fills, stopForReview, final submit click]

await check("1. MUST-STOP a verdict cached after the approval relaxes the blocker → staged, final submit refused, approval burned", async () => {
  const projectId = await rsdProject();
  const approval = approve(projectId);
  await tick();
  const question = await visionPass(projectId); // the concurrent stage_step, after the click
  const seen = await stage(projectId, { approvalId: approval.id, final: true });
  assert.equal(seen.autoSubmit, false, "a verdict cached after the approval let the run's final submit through");
  const declined = auditsFor("portal.auto_submit_declined", projectId);
  assert.equal(declined.length, 1, "no decline was recorded");
  assert.match((declined[0].reasons as string[]).join(" | "), /after the approval relaxed .*city\.elec\.rapid-shutdown-missing/);
  const consumed = db.get<{ consumed_at: string | null }>("SELECT consumed_at FROM portal_run_approvals WHERE id = ?", [approval.id]);
  assert.ok(consumed?.consumed_at, "the approval survived its refused run");
  const rows = auditsFor("reviewer_gate.vision_relaxed_at_stage", projectId);
  assert.equal(rows.length, 1, "staging past the relaxed blocker wrote no audit row");
  assert.equal(rows[0].runId, approval.id);
  assert.deepEqual((rows[0].writtenAfterApproval as string[]).sort(), BLOCKERS);
  assert.equal(findingOf(rows[0], RSD)?.question, question);
});

await check("2. MUST-PASS the same verdict cached BEFORE the approval → the run is allowed", async () => {
  const projectId = await rsdProject();
  await visionPass(projectId);
  await tick();
  const approval = approve(projectId);
  const seen = await stage(projectId, { approvalId: approval.id, final: true });
  assert.equal(seen.autoSubmit, true, "an approval that saw the relaxed gate was refused — a gate nothing passes is an outage");
  assert.equal(auditsFor("portal.auto_submit_declined", projectId).length, 0);
  const rows = auditsFor("reviewer_gate.vision_relaxed_at_stage", projectId);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].writtenAfterApproval, []);
});

let ordinaryId = "";
await check("3. ORDINARY a run that asked for no final submit stages past the relaxed blocker, and the stage is audited", async () => {
  ordinaryId = await rsdProject();
  const question = await visionPass(ordinaryId);
  const seen = await stage(ordinaryId, { final: false });
  assert.equal(seen.autoSubmit, false);
  assert.equal(auditsFor("portal.auto_submit_declined", ordinaryId).length, 0, "an ordinary run recorded a final-submit decision");
  const rows = auditsFor("reviewer_gate.vision_relaxed_at_stage", ordinaryId);
  assert.equal(rows.length, 1, "staging past the relaxed blocker wrote no audit row");
  assert.equal(rows[0].via, "stage");
  assert.equal(rows[0].runId, seen.runId, "the row names a different run");
  assert.equal("writtenAfterApproval" in rows[0], false);
  assert.deepEqual((rows[0].findings as Array<{ findingId: string }>).map((f) => f.findingId).sort(), BLOCKERS);
  assert.deepEqual(findingOf(rows[0], RSD), { findingId: RSD, question, page: 1, confidence: "high" });
});

await check("4. AUDIT Approve past the relaxed blocker writes the row, naming the staged run", async () => {
  assert.ok(ordinaryId, "setup failed");
  const run = fx.latestRun(ordinaryId)!;
  await runAutopilotApproval(db, ordinaryId, { approverName: "A. Person", approverUserId: null });
  const rows = auditsFor("reviewer_gate.vision_relaxed_at_stage", ordinaryId).filter((r) => r.via === "approve");
  assert.equal(rows.length, 1, "Approve past the relaxed blocker wrote no audit row");
  assert.equal(rows[0].runId, String(run.id));
  assert.ok(findingOf(rows[0], RSD), "the Approve row does not name RSD");
});

await check("5. AUDIT staging with nothing relaxed writes no row", async () => {
  const projectId = fx.newProject();
  await stage(projectId, { final: false });
  assert.equal(auditsFor("reviewer_gate.vision_relaxed_at_stage", projectId).length, 0, "a stage that relied on no vision read was audited as one");
});

await check("6. the one door: automaticSubmitRefusals refuses relaxedSinceApproval on its own", () => {
  const recipe = fx.completeRecipe();
  const ok = { recipeId: recipe.id, runApproval: { approver: "A. Person", runId: "r1" }, runId: "r1", env: { PORTAL_ALLOW_FINAL_SUBMIT: "1" } };
  assert.deepEqual(repo.automaticSubmitRefusals(db, { ...ok, relaxedSinceApproval: [] }), [], "setup: the clean inputs must pass");
  assert.equal(repo.automaticSubmitRefusals(db, { ...ok, relaxedSinceApproval: [RSD] }).length, 1);
  assert.equal(repo.maySubmitAutomatically(db, { ...ok, relaxedSinceApproval: [RSD] }), false);
});

finish("approvalGateSnapshot");
