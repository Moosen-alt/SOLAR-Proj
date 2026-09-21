// THE DESIGNER WAIT, AND THE HUMAN WORD THAT ENDS IT.
//
// `waiting_on_designer` was labeled on the board, bannered with operator instructions, worded
// for the customer's status page and offered as a filter — with NOTHING anywhere able to write
// it. A `B_designer_fix` correction (structural, plan set, calcs) means the package cannot go
// back out until the design team sends a revision, and the one screen the operator lives on
// could not say so: after applying the triage the project read "QC failed", because the re-QC
// inside updateProject had just overwritten the correction state.
//
// WHAT THIS FILE REFUSES TO LET REGRESS:
//
//   MUST WRITE     — applying a DESIGN-bucket triage parks the project at `waiting_on_designer`
//                    with stage_detail `awaiting_design_revision`. Read from the DATABASE, never
//                    from a return value.
//   MUST SURVIVE QC— the write is guarded on the status BEFORE updateProject runs, because
//                    runQcForProject rewrites status + stage_detail unconditionally. Measured:
//                    a project at `correction_triaged` comes back from an apply reading
//                    `qc_failed`. The proposals branch is the one that proves this, since it is
//                    the branch that actually re-runs QC.
//   MUST BE REACHABLE — a design correction usually proposes NO field change (the fix is a
//                    revised plan set), and apply used to 409 on an empty proposal set. A writer
//                    unreachable for exactly the corrections it exists for is not a writer.
//   MUST EXIT BY A HUMAN — `waiting_on_designer` is left ONLY by the operator's explicit
//                    "Revisions received" action. Asserted as a MUST-EXCLUDE against the
//                    tempting inference: attaching a revised PDF moves NOTHING.
//   MUST NOT SUBMIT / MUST NOT CLOSE — neither apply nor "revisions received" writes a
//                    submission, a portal run, or closed_at. The correction closes when the
//                    resubmission actually goes out (that is the resubmit event's job).
//   MUST NOT OVER-REACH — an A-bucket apply must not land on `waiting_on_designer`, and an
//                    apply on a project that has moved on (a filing already submitted) must not
//                    drag it back into a designer wait.
//   MUST NOT STRAND — an operator who closes the correction by hand while the project waits
//                    must still be able to end the wait; the guard is the PROJECT's status, not
//                    the correction's closed_at.
//
//   npx tsx backend/test/correctionDesignerWait.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "correction-designer-wait-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
// Regex classifier only — no agent job, no LLM. The BUCKET under test is written by the real
// classifier from the correction's own words, not by a fixture.
process.env.ANTHROPIC_API_KEY = "";
// createProject kicks a self-starting autopilot job; left on it would stage in the background
// and write the very columns asserted here.
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { saveProjectDocument } = await import("../src/projectDocuments");
const {
  createProject, addManualCorrection, applyCorrectionProposals, recordDesignRevisionsReceived,
  resolveCorrection, setProjectStatusByOperator, getProjectDetail,
} = await import("../src/repository");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> => Promise.resolve()
  .then(fn)
  .then(() => { console.log(`  ok   - ${label}`); })
  .catch((err) => { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); });

// EVERY ASSERTION READS THE ROW. A function can return a tidy detail while writing nothing.
const statusOf = (p: string) => String(db.get<{ status?: string }>("SELECT status FROM projects WHERE id = ?", [p])?.status ?? "");
const detailOf = (p: string) => String(db.get<{ stage_detail?: string }>("SELECT stage_detail FROM projects WHERE id = ?", [p])?.stage_detail ?? "");
const stageOf = (p: string) => String(db.get<{ current_stage?: string }>("SELECT current_stage FROM projects WHERE id = ?", [p])?.current_stage ?? "");
const countIn = (table: string, p: string) => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, [p])?.n ?? 0);
const closedAtOf = (c: string) => db.get<{ closed_at?: string | null }>("SELECT closed_at FROM corrections WHERE id = ?", [c])?.closed_at ?? null;
const auditCount = (p: string, action: string) => Number(db.get<{ n: number }>(
  "SELECT COUNT(*) AS n FROM audit_logs WHERE project_id = ? AND action = ?", [p, action])?.n ?? 0);
const autopilotJobs = (p: string) => Number(db.get<{ n: number }>(
  "SELECT COUNT(*) AS n FROM job_queue WHERE project_id = ? AND job_type = 'autopilot'", [p])?.n ?? 0);

const refusal = (fn: () => unknown): { status: number; message: string } => {
  try { fn(); return { status: 0, message: "no error thrown" }; }
  catch (err) {
    const e = err as { status?: number; message?: string };
    return { status: Number(e.status ?? 0), message: String(e.message ?? "") };
  }
};

const newProject = (owner: string, street: string) => createProject(db, {
  owner, address: street, city: "Portland", state: "OR", zip: "97201",
  ahj: "City of Portland", utility: "PGE", dcKw: "6.0",
}).project.id;

// The triage payload the correction AGENT writes into the linked review item's notes
// (correctionAgent.persistTriage; parseCorrectionProposals only matches this exact shape, and
// applyCorrectionProposals reads it back through that parser — a malformed blob here would 409,
// not pass). Only the PROPOSALS are fixtured; the bucket under test is the correction row's own,
// written by the real classifier.
const seedProposals = (projectId: string, correctionId: string, proposals: Array<Record<string, string>>) => {
  const item = db.query<{ id: string; notes: string }>(
    "SELECT id, notes FROM human_review_items WHERE project_id = ? AND field_name = 'correction' AND status = 'pending'", [projectId],
  ).find((i) => { try { return JSON.parse(String(i.notes).slice(13)).correctionId === correctionId; } catch { return false; } });
  assert.ok(item, "fixture: no pending review item is linked to this correction");
  db.run("UPDATE human_review_items SET notes = ? WHERE id = ?", [
    `agent-triage:${JSON.stringify({ correctionId, bucket: "B_designer_fix", proposals, actions: ["Send the revised sheets to the designer."] })}`,
    item!.id,
  ]);
};

// The operator's own words, classified by the REAL classifier (corrections.ts): "plan set" and
// "structural" are what make this a designer's problem, not a fixture field.
const DESIGN_TEXT = "Revise the plan set: the structural rafter span table and the stamped calculations are missing.";
const DATA_TEXT = "The account number on the application does not match the utility bill; correct it and upload the bill.";

// ═══════════════════════════════════════════════════════════════════════════════════════
// PART 1 — THE WRITER.
// ═══════════════════════════════════════════════════════════════════════════════════════

const zeroId = newProject("Zero Proposal Owner", "1 Designer Way");
const zeroCorrection = addManualCorrection(db, zeroId, DESIGN_TEXT).corrections[0];

await check("fixture precondition: the REAL classifier buckets this correction as a designer fix", () => {
  assert.equal(zeroCorrection.correctionBucket, "B_designer_fix",
    `the classifier read "${DESIGN_TEXT}" as ${zeroCorrection.correctionBucket} — the rest of this file tests the wrong leg`);
  assert.equal(statusOf(zeroId), "correction_triaged", "a new correction must park the project in the correction flow");
});

await check("A DESIGN CORRECTION WITH NO DATA PROPOSALS CAN BE APPLIED — and lands on the designer", () => {
  // The whole point of the bucket: the fix is a revised plan set, so there is no field to
  // change. Refusing this apply (as the endpoint did for every bucket) left the card with no
  // action at all and made `waiting_on_designer` unreachable for exactly the corrections it
  // exists for.
  applyCorrectionProposals(db, zeroCorrection.id);
  assert.equal(statusOf(zeroId), "waiting_on_designer",
    `applied a designer-fix triage and the project reads "${statusOf(zeroId)}" — the board cannot say whose move it is`);
  assert.equal(detailOf(zeroId), "awaiting_design_revision", `stage_detail is "${detailOf(zeroId)}"`);
  assert.equal(stageOf(zeroId), "Correction triage applied — waiting on revised design.");
  assert.equal(auditCount(zeroId, "correction.waiting_on_designer"), 1, "the transition left no audit row");
});

await check("MUST NOT SUBMIT, MUST NOT CLOSE — applying data files nothing and ends nothing", () => {
  assert.equal(closedAtOf(zeroCorrection.id), null,
    "apply CLOSED the correction — closing is the resubmit event, and nothing has gone back out");
  assert.equal(Number(db.get<{ human_approved?: number }>("SELECT human_approved FROM corrections WHERE id = ?", [zeroCorrection.id])?.human_approved ?? 0), 1,
    "the correction was not recorded as human-approved");
  assert.equal(countIn("submissions", zeroId), 0, "apply wrote a submission row");
  assert.equal(countIn("portal_runs", zeroId), 0, "apply started a portal run");
  assert.equal(autopilotJobs(zeroId), 0, "apply enqueued an autopilot run");
});

const withDataId = newProject("Proposals Owner", "2 Designer Way");
const withDataCorrection = addManualCorrection(db, withDataId, DESIGN_TEXT).corrections[0];
seedProposals(withDataId, withDataCorrection.id, [
  { field: "city", currentValue: "Portland", proposedValue: "Tigard", basis: "The correction letter names the Tigard address." },
]);

await check("THE RE-QC DOES NOT WIN — the designer wait survives the status rewrite inside updateProject", () => {
  // This branch actually calls updateProject, and runQcForProject rewrites status AND
  // stage_detail unconditionally (measured: `correction_triaged` → `qc_failed`). If the guard
  // read the status AFTER the apply it would always see a QC verdict and never fire.
  applyCorrectionProposals(db, withDataCorrection.id);
  assert.equal(getProjectDetail(db, withDataId).project.city, "Tigard", "the proposed data update did not apply");
  assert.equal(statusOf(withDataId), "waiting_on_designer",
    `the re-QC left the project reading "${statusOf(withDataId)}" — the designer wait was overwritten by a QC verdict`);
  assert.equal(detailOf(withDataId), "awaiting_design_revision", `stage_detail is "${detailOf(withDataId)}"`);
  assert.equal(countIn("submissions", withDataId), 0, "apply wrote a submission row");
  assert.equal(countIn("portal_runs", withDataId), 0, "apply started a portal run");
});

await check("MUST-EXCLUDE: an A-bucket apply must NOT land on the designer wait", () => {
  const dataId = newProject("Data Fix Owner", "3 Designer Way");
  const dataCorrection = addManualCorrection(db, dataId, DATA_TEXT).corrections[0];
  assert.equal(dataCorrection.correctionBucket, "A_we_fix", "fixture: this text must classify as a data fix");
  seedProposals(dataId, dataCorrection.id, [
    { field: "accountNumber", currentValue: "", proposedValue: "1234567890", basis: "Utility bill." },
  ]);
  applyCorrectionProposals(db, dataCorrection.id);
  // NOT assert.equal(status, "correction_triaged"): the re-QC legitimately rewrites it to its
  // own verdict here, and "fixing" production to satisfy that would be the real regression.
  assert.notEqual(statusOf(dataId), "waiting_on_designer",
    "an operator-fixable correction parked the job on the designer — nobody is waiting on a designer");
  assert.notEqual(detailOf(dataId), "awaiting_design_revision", `stage_detail is "${detailOf(dataId)}"`);
  console.log(`         (recorded: an A-bucket apply leaves status="${statusOf(dataId)}" stage_detail="${detailOf(dataId)}" — the re-QC's own verdict)`);
});

await check("MUST-EXCLUDE: an apply must not drag a project that has MOVED ON back into a designer wait", () => {
  // The live PacifiCorp APP-111681 shape: the filing is on file and an operator has already
  // moved the row to `submitted` by hand. Applying the correction's data must not rewind it.
  const movedId = newProject("Moved On Owner", "4 Designer Way");
  const movedCorrection = addManualCorrection(db, movedId, DESIGN_TEXT).corrections[0];
  seedProposals(movedId, movedCorrection.id, [
    { field: "zip", currentValue: "97201", proposedValue: "97223", basis: "Correction letter." },
  ]);
  setProjectStatusByOperator(db, movedId, "submitted", "Corrected and resubmitted by hand in the portal.", "operator@keelix.test");
  applyCorrectionProposals(db, movedCorrection.id);
  assert.notEqual(statusOf(movedId), "waiting_on_designer",
    `a project at "submitted" was dragged back to a designer wait by an apply`);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// PART 2 — THE EXIT, AND THE INFERENCE THAT MUST NEVER BE MADE.
// ═══════════════════════════════════════════════════════════════════════════════════════

await check("MUST-EXCLUDE: ATTACHING THE REVISED PLAN SET MOVES NOTHING", () => {
  // The tempting automation, and the ruling that forbids it: an upload is not evidence the
  // revisions are complete. Designers attach a partial sheet, a preview, the stamped page
  // ahead of the calcs. Driven through the REAL document write path.
  const before = { status: statusOf(withDataId), detail: detailOf(withDataId) };
  assert.equal(before.status, "waiting_on_designer", "fixture precondition");
  saveProjectDocument(db, withDataId, {
    docType: "plan_set", filename: "revised-plan-set.pdf", contentType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% revised design\n", "utf8"), source: "upload",
  });
  assert.equal(countIn("project_documents", withDataId), 1, "fixture: the document did not save");
  assert.equal(statusOf(withDataId), before.status,
    `a document upload moved the project to "${statusOf(withDataId)}" — an attached file is not evidence the revisions are done`);
  assert.equal(detailOf(withDataId), before.detail, "a document upload moved the sub-stage");
});

await check("THE HUMAN WORD ENDS THE WAIT — 'Revisions received' releases the project to re-stage", () => {
  const detail = recordDesignRevisionsReceived(db, withDataCorrection.id, "operator@keelix.test");
  assert.equal(statusOf(withDataId), "ready_to_resubmit",
    `the operator said the revisions are in and the project reads "${statusOf(withDataId)}"`);
  assert.equal(detail.project.status, "ready_to_resubmit", "the returned detail is stale — the UI would re-render the old status");
  assert.equal(detailOf(withDataId), "design_revisions_received", `stage_detail is "${detailOf(withDataId)}"`);
  assert.equal(stageOf(withDataId), "Revised design received — ready to re-stage.");
  assert.equal(auditCount(withDataId, "correction.design_revisions_received"), 1, "the exit left no audit row");
  assert.equal(String(db.get<{ actor_name?: string }>(
    "SELECT actor_name FROM audit_logs WHERE project_id = ? AND action = 'correction.design_revisions_received'", [withDataId])?.actor_name ?? ""),
    "operator@keelix.test", "the audit row does not name the operator who said it");
});

await check("…and it neither files anything, closes the correction, nor kicks a run", () => {
  assert.equal(closedAtOf(withDataCorrection.id), null,
    "'Revisions received' closed the correction — the package has not gone back out yet");
  assert.equal(countIn("submissions", withDataId), 0, "a submission row appeared");
  assert.equal(countIn("portal_runs", withDataId), 0, "a portal run started");
  assert.equal(autopilotJobs(withDataId), 0,
    "an autopilot run was enqueued — the ready_to_resubmit banner asks the OPERATOR to click 3 · Prepare Submittal");
});

await check("MUST REFUSE: 'Revisions received' on a project that is not waiting on a designer — 409, nothing moves", () => {
  const before = { status: statusOf(withDataId), detail: detailOf(withDataId) };
  const again = refusal(() => recordDesignRevisionsReceived(db, withDataCorrection.id, "operator@keelix.test"));
  assert.equal(again.status, 409, `a second click was accepted (${again.status}: ${again.message})`);
  assert.match(again.message, /waiting on a designer/i, `the refusal does not explain itself: ${again.message}`);
  assert.equal(statusOf(withDataId), before.status, "the refused action still moved the status");
  assert.equal(detailOf(withDataId), before.detail, "the refused action still moved the sub-stage");

  // A correction that never went to a designer at all.
  const neverId = newProject("Never Waited Owner", "5 Designer Way");
  const neverCorrection = addManualCorrection(db, neverId, DATA_TEXT).corrections[0];
  const out = refusal(() => recordDesignRevisionsReceived(db, neverCorrection.id, "operator@keelix.test"));
  assert.equal(out.status, 409, `a designer wait was INVENTED for a project that never had one (${out.status}: ${out.message})`);
  assert.equal(statusOf(neverId), "correction_triaged", "the refused action still moved the status");
});

await check("MUST REFUSE: an unknown correction id — 404, before anything is written", () => {
  const out = refusal(() => recordDesignRevisionsReceived(db, "no-such-correction", "operator@keelix.test"));
  assert.equal(out.status, 404, `expected 404, got ${out.status}: ${out.message}`);
});

await check("MUST NOT STRAND: closing the correction by hand does not take the exit away", () => {
  // resolveCorrection releases only `correction_received` / `correction_triaged`, so a project
  // parked on the designer stays parked when its correction is closed by hand. Guarding the
  // exit on the correction's closed_at would leave the audited override as the only way out.
  assert.equal(statusOf(zeroId), "waiting_on_designer", "fixture precondition");
  resolveCorrection(db, zeroCorrection.id, { resubmitted: false });
  assert.equal(statusOf(zeroId), "waiting_on_designer",
    `closing the correction moved the project to "${statusOf(zeroId)}" on its own`);
  recordDesignRevisionsReceived(db, zeroCorrection.id, "operator@keelix.test");
  assert.equal(statusOf(zeroId), "ready_to_resubmit",
    "a project whose correction was closed by hand can no longer leave the designer wait");
  assert.equal(detailOf(zeroId), "design_revisions_received");
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// PART 3 — THE ROUTE AND THE CARD. Structural: a writer the product cannot reach is the bug.
// ═══════════════════════════════════════════════════════════════════════════════════════

const server = fs.readFileSync(path.resolve(process.cwd(), "backend/src/server.ts"), "utf8");
const dashboard = fs.readFileSync(path.resolve(process.cwd(), "frontend/dashboard.js"), "utf8");

await check("the exit is reachable over HTTP, under the guarded /api/corrections/:id prefix", () => {
  assert.match(server, /app\.post\("\/api\/corrections\/:id\/revisions-received"/,
    "POST /api/corrections/:id/revisions-received is not registered — the repository function has no production caller");
  assert.match(server, /app\.use\("\/api\/corrections\/:id",\s*childScopeGuard\(/,
    "the /api/corrections/:id child scope guard is gone, so the route no longer inherits tenancy scoping");
  // No new TOP-LEVEL path: a route moved out from under the guarded prefix would still work,
  // still pass this file, and silently lose its tenant scoping (CLAUDE.md rule 6).
  assert.ok(!/app\.(post|get|patch|delete)\("\/api\/revisions/.test(server),
    "the designer-wait exit was given its own top-level path");
  // The refusals live with the write, so a second caller cannot reach the UPDATE without them.
  const handler = server.slice(server.indexOf('app.post("/api/corrections/:id/revisions-received"'));
  assert.ok(!/waiting_on_designer/.test(handler.slice(0, 500)),
    "the status refusal has leaked into the route handler — it belongs with the write");
});

await check("ONE apply path, and the triage output is on the correction card itself", () => {
  const applyRoutes = server.match(/app\.post\("\/api\/corrections\/:id\/apply"/g) || [];
  assert.equal(applyRoutes.length, 1, `there are ${applyRoutes.length} apply routes — the card must reuse the existing one`);
  const panel = dashboard.slice(dashboard.indexOf("function correctionTriage("), dashboard.indexOf("function renderPortalRuns"));
  assert.ok(panel.includes("data-apply-correction"),
    "the corrections panel still offers no apply action — the agent's proposals stay buried in the human-review panel");
  assert.ok(panel.includes("/apply"), "the corrections panel does not post to the existing apply endpoint");
  assert.ok(panel.includes("data-revisions-received") && panel.includes("/revisions-received"),
    "the corrections panel offers no 'Revisions received' action");
  // The proposals come from an LLM and go into innerHTML.
  for (const field of ["p.field", "p.currentValue", "p.proposedValue", "p.basis"]) {
    assert.ok(panel.includes(`esc(${field}`), `${field} reaches innerHTML without esc()`);
  }
});

console.log(failures === 0 ? "\ncorrectionDesignerWait: all checks passed" : `\ncorrectionDesignerWait: ${failures} FAILED`);
try { db.close(); } catch { /* fire-and-forget PDF text extraction may still hold the handle */ }
process.exit(failures === 0 ? 0 : 1);
