// A FINAL SUBMIT HAPPENS ONLY IN A RUN A NAMED PERSON APPROVED — NEVER ON A STANDING ARM.
//
// Operator ruling (2026-09-24): automation may click the portal's final submit ONLY right after a
// named person approved THAT exact run (Approve & Submit), with PORTAL_ALLOW_FINAL_SUBMIT=1 and a
// valid recipe shape (one terminal isFinalSubmit click right after stopForReview). There is no
// standing per-recipe arm: auto_submit_enabled is never authority, and every recipe writer clears
// it. Before this, resolution read ONLY portal_recipes.auto_submit_enabled — no status, no
// environment switch, no approver — and production had two armed rows (e965c645 "NOT verified",
// and 6282e671 while needs_rerecord).
//
// Every case drives the REAL prepareSubmission; the approval is written by createRunApproval (the
// Approve & Submit route's writer). The stub adapter records the options the bot would receive.
//
// KILL TESTS:
//   K1 repository.automaticSubmitRefusals: drop the finalSubmitEnvAllows check → (b) (c) fail.
//   K2 resolve from auto_submit_enabled instead (the old code) → (a) fails.
//   K3 drop the recipe-shape / flagged-step checks → (e) fails.
//   K4 claimRunApproval: do not consume (drop the UPDATE) → (h) fails.
//
// Run: npx tsx backend/test/autoSubmitTrust.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import type { RecipeStep } from "../../shared/src/types";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("auto-submit-trust");
const { db, repo, recipes } = fx;

type Seen = { autoSubmit?: boolean; runApproval?: { approver: string; runId: string } | null; runId?: string; allowFinalSubmit?: boolean };
/** Stage once with autoSubmit requested, handing in the approval THIS request minted (the job
 *  payload's approvalId — trust skeptic M1: a run claims the approval it was started with, never
 *  "the newest live one"); return what the bot was handed and the run row. */
async function stageAsking(projectId: string, opts: { env?: string | null; fail?: boolean; approvalId?: string | null } = {}) {
  if (opts.env === null || opts.env === undefined) delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  else process.env.PORTAL_ALLOW_FINAL_SUBMIT = opts.env;
  let seen: Seen | null = null;
  fx.stubRunner(async (_r, _p, _f, _d, _files, options) => {
    seen = { autoSubmit: options?.autoSubmit, runApproval: options?.runApproval ?? null, runId: options?.runId, allowFinalSubmit: options?.allowFinalSubmit };
    // Staged to review; nothing clicked — the question here is only what the bot was ALLOWED.
    if (opts.fail) return fx.failingStep("Recipe step failed (fill — x): locator.fill: Target page, context or browser has been closed");
    return { portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, steps: [{ ok: true, message: "staged" }] };
  });
  await repo.prepareSubmission(db, projectId, undefined, /* autoSubmit */ true, undefined, opts.approvalId ?? null);
  delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  const run = fx.latestRun(projectId)!;
  assert.equal(JSON.parse(String(run.result_json)).actor, "RecipeAdapter", "setup: the stage did not take the recipe branch");
  return { seen: seen as unknown as Seen, run };
}
const approve = (projectId: string, approver = "A. Person") =>
  repo.createRunApproval(db, { projectId, track: "permit", approver, approverUserId: null });
const declined = (projectId: string) => fx.audits("portal.auto_submit_declined").filter((a) => a.project_id === projectId);

await check("(g) MUST-PASS: a named approval of THIS run + PORTAL_ALLOW_FINAL_SUBMIT=1 + a complete, well-shaped recipe → allowed, and the approval names this run", async () => {
  fx.completeRecipe(); // [...fills, stopForReview, final submit click]
  const projectId = fx.newProject();
  const approval = approve(projectId);
  const { seen, run } = await stageAsking(projectId, { env: "1", approvalId: approval.id });
  assert.equal(seen.autoSubmit, true, "a fully approved run was not allowed to submit — a gate nothing can pass is an outage");
  assert.deepEqual(seen.runApproval, { approver: "A. Person", runId: approval.id });
  assert.equal(seen.runId, approval.id, "the bot was told a different run id than the approval names");
  assert.equal(run.id, approval.id, "the run row does not carry the approved run's id");
  const row = db.get<{ consumed_at: string | null }>("SELECT consumed_at FROM portal_run_approvals WHERE id = ?", [approval.id]);
  assert.ok(row?.consumed_at, "the approval was not consumed by its run");
});

await check("(a) an ARMED recipe with no approval is NOT allowed — the arm is not authority", async () => {
  const recipe = fx.completeRecipe();
  // Precondition (not the thing under test): a legacy armed row, as production had.
  db.run("UPDATE portal_recipes SET auto_submit_enabled = 1 WHERE id = ?", [recipe.id]);
  const projectId = fx.newProject();
  const { seen } = await stageAsking(projectId, { env: "1" });
  assert.equal(seen.autoSubmit, false, "a standing per-recipe arm let a run submit with nobody's approval");
  assert.equal(seen.runApproval, null);
  assert.match(JSON.parse(declined(projectId)[0].details).reasons.join(" | "), /no named person approved this run/);
});

await check("(b) an approval with PORTAL_ALLOW_FINAL_SUBMIT unset is NOT allowed", async () => {
  fx.completeRecipe();
  const projectId = fx.newProject();
  const approval = approve(projectId);
  const { seen } = await stageAsking(projectId, { env: null, approvalId: approval.id });
  assert.equal(seen.autoSubmit, false);
  assert.equal(seen.runApproval, null, "the bot was handed an approval the process switch forbids");
  assert.match(JSON.parse(declined(projectId)[0].details).reasons.join(" | "), /PORTAL_ALLOW_FINAL_SUBMIT/);
});

await check("(c) PORTAL_ALLOW_FINAL_SUBMIT=true (not exactly 1) is NOT allowed", async () => {
  fx.completeRecipe();
  const projectId = fx.newProject();
  const approval = approve(projectId);
  const { seen } = await stageAsking(projectId, { env: "true", approvalId: approval.id });
  assert.equal(seen.autoSubmit, false);
});

await check("(d) an approval for ANOTHER project is not this run's approval", async () => {
  fx.completeRecipe();
  const other = fx.newProject();
  const othersApproval = approve(other);
  const projectId = fx.newProject();
  // Even handed the other project's approval id, the claim is refused: the id alone is not the check.
  const { seen } = await stageAsking(projectId, { env: "1", approvalId: othersApproval.id });
  assert.equal(seen.autoSubmit, false);
  const left = db.get<{ consumed_at: string | null }>("SELECT consumed_at FROM portal_run_approvals WHERE project_id = ?", [other]);
  assert.equal(left?.consumed_at ?? null, null, "a run consumed another project's approval");
});

await check("(e) a recipe with TWO flagged submits, or a flagged step that is not terminal, or none — NOT allowed", async () => {
  const bad: RecipeStep[][] = [
    [...fx.fills(2), fx.REVIEW, fx.FINAL, fx.FINAL],
    [...fx.fills(2), fx.REVIEW, fx.FINAL, ...fx.fills(1)],
    [...fx.fills(2), fx.FINAL],
    [...fx.fills(2), fx.REVIEW],
  ];
  for (const steps of bad) {
    fx.completeRecipe(steps);
    const projectId = fx.newProject();
    const approval = approve(projectId);
    const { seen } = await stageAsking(projectId, { env: "1", approvalId: approval.id });
    assert.equal(seen.autoSubmit, false, `allowed a click on an invalid shape: ${steps.map((st) => st.action + (st.isFinalSubmit ? "*" : "")).join(",")}`);
  }
});

await check("(f) a blank approver is refused at the approval itself — 'dashboard' is not a person", () => {
  const projectId = fx.newProject();
  assert.throws(() => approve(projectId, "   "), /named approver/);
  assert.equal(db.query("SELECT id FROM portal_run_approvals WHERE project_id = ?", [projectId]).length, 0);
});

await check("(h) an approval is SINGLE USE — the next run of the same track is an ordinary run", async () => {
  fx.completeRecipe();
  const projectId = fx.newProject();
  const approval = approve(projectId);
  // The approved run dies (our browser closed) — nothing staged, so the track can be re-run.
  const first = await stageAsking(projectId, { env: "1", fail: true, approvalId: approval.id });
  assert.equal(first.seen.autoSubmit, true, "setup: the first (approved) run was not allowed");
  // The re-run carries the SAME id (a retry of the approved request): consumed, so refused.
  const second = await stageAsking(projectId, { env: "1", approvalId: approval.id });
  assert.equal(second.seen.autoSubmit, false, "one approval covered a SECOND run");
  assert.equal(second.seen.runApproval, null);
  assert.notEqual(second.run.id, first.run.id);
});

await check("(i) an EXPIRED approval is never honoured", async () => {
  fx.completeRecipe();
  const projectId = fx.newProject();
  const approval = approve(projectId);
  // Time passing (not the thing under test): age the approval past its window.
  db.run("UPDATE portal_run_approvals SET expires_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", approval.id]);
  const { seen } = await stageAsking(projectId, { env: "1", approvalId: approval.id });
  assert.equal(seen.autoSubmit, false, "a stale approval let a run submit");
});

await check("(j) the decision re-reads the recipe: a recipe that is not complete, or no recipe at all, is refused", () => {
  const recipe = fx.completeRecipe();
  const runId = "run-j";
  const ok = { recipeId: recipe.id, runApproval: { approver: "A. Person", runId }, runId, env: { PORTAL_ALLOW_FINAL_SUBMIT: "1" } };
  assert.equal(repo.maySubmitAutomatically(db, ok), true, "setup: the same inputs on a complete recipe must pass");
  recipes.markPortalRecipeForRerecord(db, recipe.id, { actor: "test" });
  assert.equal(repo.maySubmitAutomatically(db, ok), false, "a needs_rerecord recipe may submit");
  assert.equal(repo.maySubmitAutomatically(db, { ...ok, recipeId: null }), false, "a run with no recipe (hand-coded / self-seed) may submit");
  assert.equal(repo.maySubmitAutomatically(db, { ...ok, runApproval: { approver: "A. Person", runId: "another-run" } }), false, "an approval for another run was accepted");
});

// ── M1 (trust skeptic): the approval is bound to the request that minted it ─────────────────
await check("(m1) MUST-EXCLUDE: an approval whose run was refused at a gate BEFORE the claim is consumed, and a later nameless request never claims it", async () => {
  fx.completeRecipe();
  const projectId = fx.newProject();
  // Request 1: Alice approves. Her run is refused at a staging gate (no CCB on the client).
  const approval = approve(projectId, "Alice");
  const clientId = String(db.get<{ client_id: string }>("SELECT client_id FROM projects WHERE id = ?", [projectId])!.client_id);
  const ccb = String(db.get<{ ccb_license_number: string }>("SELECT ccb_license_number FROM clients WHERE id = ?", [clientId])!.ccb_license_number);
  db.run("UPDATE clients SET ccb_license_number = '' WHERE id = ?", [clientId]);
  process.env.PORTAL_ALLOW_FINAL_SUBMIT = "1";
  await assert.rejects(repo.prepareSubmission(db, projectId, undefined, true, undefined, approval.id), /CCB/, "setup: the gate did not refuse");
  db.run("UPDATE clients SET ccb_license_number = ? WHERE id = ?", [ccb, clientId]);
  const afterGate = db.get<{ consumed_at: string | null }>("SELECT consumed_at FROM portal_run_approvals WHERE id = ?", [approval.id]);
  assert.ok(afterGate?.consumed_at, "a run refused at a gate left its approval live for the next request");
  assert.ok(fx.audits("portal.run_approval_claimed").some((a) => a.project_id === projectId && JSON.parse(a.details).approvalId === approval.id),
    "the claim of a gate-refused run is invisible — nothing tells the operator why Approve & Submit stopped");
  // Request 2: autoSubmit asked for with NO approval of its own (the route enqueues such a
  // request with autoSubmit=false; a direct caller with no id gets the same answer).
  const { seen } = await stageAsking(projectId, { env: "1" });
  assert.equal(seen.autoSubmit, false, "a request nobody approved was allowed to click final submit on Alice's stale approval");
  assert.equal(seen.runApproval, null);
});

await check("(m1b) MUST-EXCLUDE: a nameless run started before a named approval was minted never claims it — the claim is by id, never 'the newest live one'", async () => {
  fx.completeRecipe();
  const projectId = fx.newProject();
  const live = approve(projectId, "Bob"); // minted, unconsumed, unexpired — and NOT this request's
  const { seen } = await stageAsking(projectId, { env: "1" }); // no id in hand
  assert.equal(seen.autoSubmit, false, "a run with no approval of its own claimed the newest live approval");
  const row = db.get<{ consumed_at: string | null }>("SELECT consumed_at FROM portal_run_approvals WHERE id = ?", [live.id]);
  assert.equal(row?.consumed_at ?? null, null, "Bob's approval was consumed by a run he did not approve");
  // MUST-PASS: a request carrying its own id is allowed (a fresh project: the first stage
  // above staged this one's track, and a staged track is not re-staged).
  const second = fx.newProject();
  const bobs = approve(second, "Bob");
  const own = await stageAsking(second, { env: "1", approvalId: bobs.id });
  assert.equal(own.seen.autoSubmit, true);
  assert.deepEqual(own.seen.runApproval, { approver: "Bob", runId: bobs.id });
});

await check("(m1c) the job handler's path: the approval id rides in the running prepare_submission job's payload (the route's writer), and only that job's id is claimed", async () => {
  const jobs = await import("../src/jobQueue");
  fx.completeRecipe();
  const projectId = fx.newProject();
  const approval = approve(projectId, "Cara");
  const stray = approve(projectId, "Dan"); // newer, live — must NOT be the one taken
  // What the route enqueues for a request that minted an approval — and for one that did not.
  const payload = repo.finalSubmitJobPayload({ track: "permit", autoSubmit: true, allowFinalSubmit: false, approval });
  assert.deepEqual(payload, { track: "permit", autoSubmit: true, allowFinalSubmit: false, approvalId: approval.id });
  assert.deepEqual(repo.finalSubmitJobPayload({ track: "permit", autoSubmit: true, allowFinalSubmit: true, approval: null }),
    { track: "permit", autoSubmit: false, allowFinalSubmit: false, approvalId: null }, "a request that minted nothing must not carry the final-submit flag");
  // The job the route enqueued, claimed (status running) the way the worker claims it.
  jobs.enqueueJob(db, "prepare_submission", payload, { projectId, priority: 7, maxRetries: 0 });
  const claimed = jobs.claimNextJob(db);
  assert.equal(claimed?.projectId, projectId, "setup: the job was not claimed");
  try {
    const { seen } = await stageAsking(projectId, { env: "1" }); // the handler passes no id: the running job carries it
    assert.deepEqual(seen.runApproval, { approver: "Cara", runId: approval.id }, "the running job's approval was not the one claimed");
    assert.equal(seen.autoSubmit, true);
    const dan = db.get<{ consumed_at: string | null }>("SELECT consumed_at FROM portal_run_approvals WHERE id = ?", [stray.id]);
    assert.equal(dan?.consumed_at ?? null, null, "the newer approval was taken instead of the job's own");
  } finally {
    db.run("UPDATE job_queue SET status = 'done' WHERE id = ?", [String(claimed?.id)]);
  }
});

await check("(k) every recipe writer clears a legacy arm", () => {
  const arm = (rid: string) => db.run("UPDATE portal_recipes SET auto_submit_enabled = 1 WHERE id = ?", [rid]);
  const armed = (rid: string) => Number(fx.recipeRow(rid).auto_submit_enabled);
  const recipe = fx.completeRecipe();
  arm(recipe.id); recipes.savePortalRecipeSteps(db, recipe.id, [...fx.fills(3), fx.REVIEW, fx.FINAL]);
  assert.equal(armed(recipe.id), 0, "savePortalRecipeSteps left the arm");
  arm(recipe.id); recipes.markPortalRecipeForRerecord(db, recipe.id, { actor: "test" });
  assert.equal(armed(recipe.id), 0, "markPortalRecipeForRerecord left the arm");
  arm(recipe.id); recipes.startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj: "Portland", utility: "PGE", createdBy: "test" });
  assert.equal(armed(recipe.id), 0, "startPortalRecording left the arm");
  recipes.savePortalRecipeSteps(db, recipe.id, [...fx.fills(3), fx.REVIEW, fx.FINAL], { status: "recording" });
  arm(recipe.id); recipes.finishPortalRecipe(db, recipe.id, "test");
  assert.equal(armed(recipe.id), 0, "finishPortalRecipe left the arm");
});

await check("(l) a project that received an Approve & Submit can still be deleted (its approvals go with it)", () => {
  const projectId = fx.newProject();
  approve(projectId);
  // A consumed one too: the approval table carries a foreign key to projects.
  const consumed = approve(projectId);
  db.run("UPDATE portal_run_approvals SET consumed_at = ? WHERE id = ?", [new Date().toISOString(), consumed.id]);
  repo.deleteProject(db, projectId);
  assert.equal(db.get("SELECT id FROM projects WHERE id = ?", [projectId]), null, "the project was not deleted");
  assert.equal(db.query("SELECT id FROM portal_run_approvals WHERE project_id = ?", [projectId]).length, 0, "approvals outlived their project");
});

repo.setRecipeStageRunnerForTests(null);
finish("auto-submit-trust");
