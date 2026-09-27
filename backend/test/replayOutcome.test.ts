// A STAGE RUN'S OUTCOME IS WHAT THE ADAPTER REPORTS HAPPENED — AND ITS ROW EXISTS BEFORE THE BROWSER.
//
// Production (bot-plan B3): runs 08909df6 and 5864e8ef on one project both reported
// finalSubmitClicked and were recorded 'failed' with NO submissions row, so the duplicate guard
// (which read only submissions 'submitted') let the second automated filing through. Runs
// ff90c10a / cb9a5f88 / 6aff4df6 said "After the submit click the page neither confirmed nor
// rejected" with finalSubmitClicked=false. And the run row was written only after the adapter
// returned: 4 of 7 interrupted jobs left no record, and a re-stage opened a duplicate draft.
//
// Every case drives the REAL prepareSubmission (browser stubbed via setRecipeStageRunnerForTests).
//
// KILL TESTS:
//   K1 repository.derivePortalRunOutcome: drop the click branch (status from ok/pause only)
//      → (a) (a3) fail.
//   K2 repository.prepareSubmission filedOn: back to submissions status = 'submitted' only
//      → (b) (b2) fail.
//   K3 move insertRunningPortalRun after the dispatch → (c) fails.
//   K4 remove the dispatch try/catch → (d) fails (the throw escapes; the row stays 'running').
//
// Run: npx tsx backend/test/replayOutcome.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("replay-outcome");
const { db, repo } = fx;

const clickedResult = (verdict: "accepted" | "rejected" | "unknown", ok = true) => ({
  portalName: "stub", ok, finalSubmitClicked: true, finalSubmitClickedByAutomation: true, pauseReason: null,
  steps: [
    { ok: true, message: "Opened stub portal." },
    { ok: true, message: "Replayed 6 recorded step(s) and clicked the approved final submit.", data: { finalSubmitClicked: true } },
    { ok: true, message: "the approved final submit was CLICKED", data: { finalSubmitClicked: true, finalSubmitOutcome: { verdict, evidence: null } } },
  ],
});
const submissionsOf = (projectId: string) => db.query<{ status: string; permit_type: string }>(
  "SELECT status, permit_type FROM submissions WHERE project_id = ? ORDER BY created_at", [projectId]);
const projectStatus = (projectId: string) => String(db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", [projectId])?.status);
const refusal = async (fn: () => Promise<unknown>): Promise<{ status: number; message: string } | null> => {
  try { await fn(); return null; } catch (err) { return { status: Number((err as { status?: number }).status ?? 0), message: String((err as Error).message) }; }
};

await check("(a) a click the portal did not confirm → submitted_unconfirmed, a submissions row, never 'failed', project NOT marked submitted", async () => {
  fx.completeRecipe();
  const projectId = fx.newProject();
  const before = projectStatus(projectId);
  fx.stubRunner(async () => clickedResult("unknown"));
  await repo.prepareSubmission(db, projectId);
  const run = fx.latestRun(projectId)!;
  assert.equal(run.status, "submitted_unconfirmed", `a clicked run recorded as ${run.status}`);
  const subs = submissionsOf(projectId);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].status, "submitted_unconfirmed", "the click left no submissions row the duplicate guard can see");
  assert.equal(projectStatus(projectId), before, "an UNCONFIRMED click moved the project to a status that claims a filing");
  assert.ok(fx.audits("portal.auto_submitted").some((a) => a.project_id === projectId), "no portal.auto_submitted audit row");
});

await check("(a2) a click the portal CONFIRMED → submitted, and the project is submitted", async () => {
  fx.completeRecipe();
  const projectId = fx.newProject();
  fx.stubRunner(async () => clickedResult("accepted"));
  await repo.prepareSubmission(db, projectId);
  assert.equal(fx.latestRun(projectId)!.status, "submitted");
  assert.equal(submissionsOf(projectId)[0].status, "submitted");
  assert.equal(projectStatus(projectId), "submitted");
});

await check("(a3) a FAILED step that only exists after the click (legacy shape, finalSubmitClicked=false) is still a click", async () => {
  fx.completeRecipe();
  const projectId = fx.newProject();
  fx.stubRunner(async () => fx.failingStep("Recipe step failed (click — final submit: Submit (recorded, NOT clicked)): After the submit click the page neither confirmed nor rejected the filing — human must verify."));
  await repo.prepareSubmission(db, projectId);
  assert.equal(fx.latestRun(projectId)!.status, "submitted_unconfirmed", "a run that clicked was recorded failed — the duplicate guard would let the next filing through");
  assert.equal(submissionsOf(projectId)[0].status, "submitted_unconfirmed");
});

await check("(a4) MUST-EXCLUDE: 'Final submit needs a human … stopped without clicking' is NOT a click", async () => {
  fx.completeRecipe();
  const projectId = fx.newProject();
  fx.stubRunner(async () => fx.failingStep("Recipe step failed (click — final submit): Final submit needs a human: CAPTCHA. Automation stopped without clicking."));
  await repo.prepareSubmission(db, projectId);
  assert.equal(fx.latestRun(projectId)!.status, "failed");
  assert.equal(submissionsOf(projectId)[0].status, "failed");
});

await check("(b) a second stage of a track automation already clicked is REFUSED as a duplicate", async () => {
  fx.completeRecipe();
  const projectId = fx.newProject();
  fx.stubRunner(async () => clickedResult("unknown"));
  await repo.prepareSubmission(db, projectId);
  let reached = false;
  fx.stubRunner(async () => { reached = true; return clickedResult("unknown"); });
  const r = await refusal(() => repo.prepareSubmission(db, projectId));
  assert.ok(r, "the second stage of an automation-clicked track was NOT refused");
  assert.equal(r!.status, 409);
  assert.match(r!.message, /duplicate|already filed/i);
  assert.equal(reached, false, "the browser was reached for a duplicate filing");
});

await check("(b2) a LEGACY run that clicked but was recorded 'failed' with no submission still blocks the track", async () => {
  fx.completeRecipe();
  const projectId = fx.newProject();
  // Legacy data (not the thing under test): the exact shape 08909df6/5864e8ef left in production —
  // no code path writes it any more, which is why it is inserted directly.
  db.run(
    `INSERT INTO portal_runs (id, project_id, run_type, status, started_at, finished_at, result_json, permit_type)
     VALUES (?, ?, 'prepare_submit', 'failed', ?, ?, ?, 'permit')`,
    [`legacy-${projectId.slice(0, 8)}`, projectId, "2026-09-02T01:30:00.000Z", "2026-09-02T01:38:57.438Z",
      JSON.stringify({ ok: true, finalSubmitClicked: true, finalSubmitClickedByAutomation: true, actor: "RecipeAdapter" })],
  );
  let reached = false;
  fx.stubRunner(async () => { reached = true; return clickedResult("unknown"); });
  const r = await refusal(() => repo.prepareSubmission(db, projectId));
  assert.ok(r && r.status === 409, "a track automation already clicked on was staged again");
  assert.equal(reached, false);
});

await check("(c) the run row exists — 'running', with the recipe version and its runner — BEFORE the browser opens", async () => {
  const recipe = fx.completeRecipe();
  const projectId = fx.newProject();
  let seen: Record<string, unknown> | null = null;
  fx.stubRunner(async () => {
    seen = fx.latestRun(projectId);
    return { portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, steps: [{ ok: true, message: "staged" }] };
  });
  await repo.prepareSubmission(db, projectId);
  assert.ok(seen, "no portal_runs row existed while the adapter ran — an interrupted run would leave no record");
  const s = seen as unknown as Record<string, unknown>;
  assert.equal(s.status, "running");
  assert.equal(s.recipe_id, recipe.id);
  assert.equal(Number(s.recipe_version), recipe.version);
  assert.ok(String(s.runner).length > 0, "the running row does not say which process drives it");
  const final = fx.latestRun(projectId)!;
  assert.equal(final.id, s.id, "the finished run is a different row from the one written at start");
  assert.equal(final.status, "awaiting_human_submit");
  assert.equal(db.query("SELECT id FROM portal_runs WHERE project_id = ?", [projectId]).length, 1, "the run was recorded twice");
});

await check("(d) an adapter that THROWS leaves a failed run, never a 'running' row", async () => {
  fx.completeRecipe();
  const projectId = fx.newProject();
  fx.stubRunner(async () => { throw new Error("chromium crashed"); });
  await repo.prepareSubmission(db, projectId);
  const run = fx.latestRun(projectId)!;
  assert.equal(run.status, "failed", `a thrown adapter left the run ${run.status}`);
  assert.match(String(run.error_message), /Portal run errored: chromium crashed/);
});

await check("(e) while a run is in flight a second stage is refused; when its runner is gone it is recovered as 'interrupted'", async () => {
  fx.completeRecipe();
  const projectId = fx.newProject();
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fx.stubRunner(async () => { await gate; return { portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, steps: [{ ok: true, message: "staged" }] }; });
  const first = repo.prepareSubmission(db, projectId);
  // Let the first call reach its adapter (it awaits the gate there).
  for (let i = 0; i < 200 && fx.latestRun(projectId)?.status !== "running"; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(fx.latestRun(projectId)?.status, "running", "setup: the first run never reached its adapter");
  const second = await refusal(() => repo.prepareSubmission(db, projectId));
  assert.ok(second && second.status === 409 && /still running/.test(second.message), `a second stage ran beside a live one: ${JSON.stringify(second)}`);
  // The process that owned it "died": recovery retires the row, audited.
  const recovered = repo.recoverInterruptedPortalRuns(db, { projectId, isAlive: () => false });
  assert.equal(recovered.length, 1);
  assert.equal(fx.latestRun(projectId)!.status, "interrupted");
  assert.match(String(fx.latestRun(projectId)!.error_message), /Check the portal/);
  assert.ok(fx.audits("portal.run_interrupted").some((a) => a.project_id === projectId));
  release!();
  await first;
});

await check("(e2) a 'running' row whose runner pid is alive (maybe reused) holds the track only for 6 hours — then recovery retires it", async () => {
  fx.completeRecipe();
  const projectId = fx.newProject();
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fx.stubRunner(async () => { await gate; return { portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, steps: [{ ok: true, message: "staged" }] }; });
  const first = repo.prepareSubmission(db, projectId);
  for (let i = 0; i < 200 && fx.latestRun(projectId)?.status !== "running"; i++) await new Promise((r) => setTimeout(r, 25));
  const runId = String(fx.latestRun(projectId)!.id);
  // The row now claims a LIVE process on this host that is not this one (our parent is alive —
  // exactly what a dead runner's reused pid looks like to the OS).
  const os = await import("node:os");
  db.run("UPDATE portal_runs SET runner = ? WHERE id = ?", [`${os.hostname()}|${process.ppid}|other-boot`, runId]);
  assert.equal(repo.recoverInterruptedPortalRuns(db, { projectId }).length, 0, "a fresh run with a live runner was retired");
  // Time passing (not the thing under test): the run is now seven hours old.
  db.run("UPDATE portal_runs SET started_at = ? WHERE id = ?", [new Date(Date.now() - 7 * 3600_000).toISOString(), runId]);
  const recovered = repo.recoverInterruptedPortalRuns(db, { projectId });
  assert.equal(recovered.length, 1, "a seven-hour-old 'running' row with a live (reused) pid held the track forever");
  assert.equal(fx.latestRun(projectId)!.status, "interrupted");
  release!();
  await first;
});

await check("(f) a replay that STOPPED BEFORE the review page is paused_for_human in its own words — never awaiting_human_submit, never 'a challenge, nothing was staged'", async () => {
  // Live run 191e45c8: Accela's attachments step recorded awaiting_human_submit ("stopped at review").
  fx.completeRecipe();
  const projectId = fx.newProject();
  const before = projectStatus(projectId);
  const stopped = 'Replayed 5 recorded step(s); STOPPED on "Step 2: Services > Attachments" — NOT the review page (the page does not read as the portal\'s review step, and none of the project\'s values are on it), so the application is NOT staged at review.';
  fx.stubRunner(async () => ({
    portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: "stopped_before_review",
    steps: [{ ok: true, message: "Opened stub portal." }, { ok: true, message: stopped, pauseReason: "stopped_before_review" }],
  }));
  await repo.prepareSubmission(db, projectId);
  const run = fx.latestRun(projectId)!;
  assert.equal(run.status, "paused_for_human", `a stop before review was recorded ${run.status}`);
  assert.equal(run.pause_reason, "stopped_before_review");
  assert.match(String(run.error_message), /STOPPED on "Step 2: Services > Attachments" — NOT the review page/, "the run card does not say where it stopped");
  const detail = String(db.get<{ stage_detail: string; current_stage: string }>("SELECT current_stage FROM projects WHERE id = ?", [projectId])?.current_stage);
  assert.doesNotMatch(detail, /challenge|nothing was staged/i, `the stage line calls a stop before review a challenge: ${detail}`);
  assert.match(detail, /STOPPED on "Step 2: Services > Attachments"/);
  assert.equal(projectStatus(projectId), before, "a run that did not reach review advanced the project");
  // THE OPERATOR FINISHES IT BY HAND, THEN RECORDS IT: Capture Confirmation (the route's own
  // function) must take the paused run — that record is what starts tracking the filing.
  repo.captureConfirmation(db, String(run.id), { applicationNumber: "BLD-26-000123", submittedBy: "operator" });
  assert.equal(fx.latestRun(projectId)!.status, "submitted", "the paused run was not recorded as filed");
  const subs = db.query<{ status: string; application_number: string }>("SELECT status, application_number FROM submissions WHERE project_id = ?", [projectId]);
  assert.ok(subs.some((s) => s.status === "submitted" && s.application_number === "BLD-26-000123"), `no submitted row carries the number: ${JSON.stringify(subs)}`);
  const target = db.get<{ permit_number: string; active: number }>("SELECT permit_number, active FROM permit_check_targets WHERE project_id = ? AND active = 1", [projectId]);
  assert.ok(target, "capturing the paused run's filing started no tracking target");
  // ...and an MFA/CAPTCHA pause keeps its own sentence (it did stage nothing).
  assert.match(repo.pausedRunSentence("mfa_captcha", {}), /verification challenge \(MFA\/CAPTCHA\) — nothing was staged/);
});

repo.setRecipeStageRunnerForTests(null);
finish("replay-outcome");
