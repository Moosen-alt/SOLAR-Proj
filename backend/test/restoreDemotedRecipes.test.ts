// THE RESTORE SCRIPT UNDOES ONLY A RUN'S DEMOTION THAT THE CURRENT CLASSIFIER WOULD NOT HAVE MADE.
//
// scripts/restore-demoted-recipes.ts (operator ruling 2026-09-24: restore the demoted NEM recipes
// once keep-and-flag lands). It must read the record — a portal_recipe.demoted audit row, or the
// legacy stale-flagged run that demoted the recipe — never guess, and must never touch a recipe a
// human marked for re-record, a recipe a sweep demoted, or one the classifier still blames.
//
// LEGACY STATE IS DATA, NOT THE THING UNDER TEST. Before the fix a demotion wrote no audit row and
// set only the run's recipeStale flag; no current code path can produce that shape, so the legacy
// cases insert exactly what production holds (705ef471 / b03fe9c5) and flip the status the way the
// old unaudited UPDATE did. The NEW-path case demotes through the real prepareSubmission.
//
// KILL TESTS:
//   K1 planRecipeRestores: drop the human-mark refusal → (d) fails.
//   K2 planRecipeRestores: skip the classifier (restore every run-demoted recipe) → (c) fails.
//   K3 planRecipeRestores: drop the notes-marker refusal → (e2) fails.
//
// Run: npx tsx backend/test/restoreDemotedRecipes.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("restore-demoted");
const { db, repo, recipes } = fx;
const { planRecipeRestores, applyRecipeRestores } = await import("../../scripts/restore-demoted-recipes");

let seq = 0;
/** A complete UTILITY recipe (a NEM recipe, as the named production cases are). */
function utilityRecipe(utility: string) {
  const r = recipes.startPortalRecording(db, { scopeType: "utility", state: "OR", utility, portalUrl: `https://${utility.toLowerCase().replace(/\W+/g, "")}.powerclerk.example/`, portalPlatform: "auto-learned", createdBy: "test" });
  return recipes.savePortalRecipeSteps(db, r.id, [...fx.fills(3), fx.REVIEW, fx.FINAL], { status: "complete", notes: "Auto-learned and verified (high confidence)." });
}
/** What the pre-fix code left behind: a failed RecipeAdapter NEM run with recipeStale, and the
 *  recipe flipped to needs_rerecord with no audit row. */
function legacyDemotion(recipe: { id: string; utility: string }, failingMessage: string) {
  seq += 1;
  const projectId = fx.newProject();
  const runId = `legacy-run-${seq}`;
  // After the recipe was created (it replayed it), before anything the test does next (a later
  // human mark must read as later).
  const at = new Date().toISOString();
  db.run(
    `INSERT INTO portal_runs (id, project_id, run_type, status, started_at, finished_at, result_json, permit_type)
     VALUES (?, ?, 'prepare_submit', 'failed', ?, ?, ?, 'nem')`,
    [runId, projectId, at, at, JSON.stringify({
      portalName: `Recipe: ${recipe.utility} (auto-learned)`, ok: false, recipeStale: true, actor: "RecipeAdapter",
      steps: [{ ok: true, message: "Opened." }, { ok: false, message: failingMessage }, { ok: true, message: "Human review required. Handle any MFA/fee." }],
    })],
  );
  db.run("UPDATE portal_recipes SET status = 'needs_rerecord', updated_at = ? WHERE id = ?", [at, recipe.id]);
  return { runId, projectId, at };
}
const decisionFor = (recipeId: string) => planRecipeRestores(db).find((d) => d.recipeId === recipeId)!;

const closed = utilityRecipe("Portland General Electric");
const closedRun = legacyDemotion(closed, "Recipe step failed (fill — Email): locator.fill: Target page, context or browser has been closed [url=https://pgenm.powerclerk.com/x]");
const gated = utilityRecipe("Pacific Power");
legacyDemotion(gated, "Recipe step failed (upload — upload site_plan: Please upload your site plan): The site_plan document changed or no longer matches this permit path. Rebuild and restart the run.");
const drifted = utilityRecipe("Idaho Power");
legacyDemotion(drifted, "Recipe step failed (fill — inverter quantity): locator.fill: Timeout 8000ms exceeded.");
const humanMarked = utilityRecipe("Avista");
legacyDemotion(humanMarked, "Recipe step failed (fill — Email): locator.fill: Target page, context or browser has been closed");
recipes.markPortalRecipeForRerecord(db, humanMarked.id, { actor: "A. Operator", reason: "portal redesigned" });
const swept = utilityRecipe("Umatilla Electric");
db.run("UPDATE portal_recipes SET status = 'needs_rerecord', notes = notes || ' | [recording interrupted — no activity since x; marked for re-record]' WHERE id = ?", [swept.id]);
const sweptAfterRun = utilityRecipe("Central Lincoln");
legacyDemotion(sweptAfterRun, "Recipe step failed (fill — Email): locator.fill: Target page, context or browser has been closed");
db.run("UPDATE portal_recipes SET notes = notes || ' | [recording interrupted — no activity since y; marked for re-record]' WHERE id = ?", [sweptAfterRun.id]);
const unknown = utilityRecipe("Emerald PUD");
legacyDemotion(unknown, "Portal run errored: Cannot read properties of undefined (reading 'value')");

await check("(a) a legacy demotion on a CLOSED BROWSER is restored — decided from the run it names", () => {
  const d = decisionFor(closed.id);
  assert.equal(d.restore, true, d.reason);
  assert.equal(d.event?.runId, closedRun.runId, "the decision is not tied to the run that demoted it");
  assert.equal(d.attribution, "not_recipe");
});

await check("(b) a legacy demotion on a DOCUMENT GATE is restored", () => {
  assert.equal(decisionFor(gated.id).restore, true, decisionFor(gated.id).reason);
});

await check("(c) a legacy demotion on real DRIFT stays demoted", () => {
  const d = decisionFor(drifted.id);
  assert.equal(d.restore, false, "a drift demotion was restored — the classifier was not consulted");
  assert.match(d.reason, /still blames the recipe/);
});

await check("(d) a recipe a HUMAN marked for re-record after the run is never restored", () => {
  const d = decisionFor(humanMarked.id);
  assert.equal(d.restore, false, "the script undid a person's re-record decision");
  assert.match(d.reason, /A\. Operator/);
});

await check("(e) a SWEEP-demoted recording with no demoting run is never restored (the e9efa4a3 shape)", () => {
  assert.equal(decisionFor(swept.id).restore, false);
  assert.match(decisionFor(swept.id).reason, /no run demoted it/);
});

await check("(e2) a run-demoted recipe re-recorded/swept since is never restored", () => {
  const d = decisionFor(sweptAfterRun.id);
  assert.equal(d.restore, false);
  assert.match(d.reason, /re-record or stale-recording sweep/);
});

await check("(f) the NEW path's demotion (real prepareSubmission, audited) on drift stays demoted", async () => {
  const recipe = fx.completeRecipe();
  const projectId = fx.newProject();
  fx.stubRunner(async () => fx.failingStep("Recipe step failed (fill — x): locator.fill: Timeout 8000ms exceeded."));
  await repo.prepareSubmission(db, projectId);
  assert.equal(fx.recipeRow(recipe.id).status, "needs_rerecord", "setup: the drift did not demote");
  const d = decisionFor(recipe.id);
  assert.equal(d.event?.source, "audit", "the audited demotion was not found");
  assert.equal(d.restore, false);
});

await check("(g) DRY RUN writes nothing; --apply restores exactly the approved rows, disarmed, audited, and flags the unattributed one", () => {
  const before = db.query<{ id: string; status: string }>("SELECT id, status FROM portal_recipes ORDER BY id");
  const plan = planRecipeRestores(db);
  assert.deepEqual(db.query("SELECT id, status FROM portal_recipes ORDER BY id"), before, "planning wrote to the database");
  const approved = plan.filter((p) => p.restore).map((p) => p.recipeId).sort();
  assert.deepEqual(approved, [closed.id, gated.id, unknown.id].sort(), `unexpected restore set: ${JSON.stringify(plan.filter((p) => p.restore).map((p) => p.label))}`);
  const restored = applyRecipeRestores(db, plan, "test");
  assert.deepEqual(restored.sort(), approved);
  for (const rid of approved) {
    const row = fx.recipeRow(rid);
    assert.equal(row.status, "complete");
    assert.equal(Number(row.auto_submit_enabled), 0);
    assert.ok(fx.audits("portal_recipe.restored").some((a) => JSON.parse(a.details).recipeId === rid), "a restore wrote no audit row");
  }
  assert.ok(String(fx.recipeRow(unknown.id).flag_reason).length > 0, "an unattributed-failure restore was not flagged for a human");
  assert.equal(String(fx.recipeRow(closed.id).flag_reason ?? ""), "", "an attributable (harness) restore was flagged");
  for (const rid of [drifted.id, humanMarked.id, swept.id, sweptAfterRun.id]) {
    assert.equal(fx.recipeRow(rid).status, "needs_rerecord", "a refused recipe was restored");
  }
  // Idempotent: a second apply finds nothing left to restore.
  assert.deepEqual(applyRecipeRestores(db, planRecipeRestores(db), "test"), []);
});

repo.setRecipeStageRunnerForTests(null);
finish("restore-demoted-recipes");
