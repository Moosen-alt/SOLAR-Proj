// A REPLAY'S HEAL PATCHES THE ONE STEP IT HEALED, ON THE VERSION IT HEALED — OR NOTHING.
//
// The old writer (repository.ts, "SELF-HEALED STEPS") matched heals by (action, note) and rewrote
// EVERY step sharing them: one heal re-pointed all six "No" radios of a policy page at the same
// control. It read the row with no version check, so a re-learn landing mid-replay got the old
// run's heals merged into it. The auto-submit disarm sat inside the same try as the step write,
// so a throwing save left the healed recipe armed. (It was also dead code: the adapter reports
// heals on the fill step's data, and the writer read only the result's top level.)
//
// Every case drives the REAL prepareSubmission with only the browser stubbed.
//
// KILL TESTS:
//   K1 portalRecipes.persistHealedSteps: match by (action, note) instead of stepIndex → (a) fails.
//   K2 drop the `Number(row.version) !== expectedVersion` check AND the `AND version = ?`
//      predicate → (b) fails.
//   K3 move the disarm UPDATE after the step write inside the try → (c) fails.
//   K4 repository.ts: read only result.healedSteps (not the steps' data) → (a) fails.
//
// Run: npx tsx backend/test/healPersistence.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import type { RecipeStep } from "../../shared/src/types";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("heal-persistence");
const { db, repo } = fx;

const CITY_STEPS: RecipeStep[] = [
  { action: "fill", selector: { name: "city_1" }, field: "projectCity", value: "Portland", note: "City" } as RecipeStep,
  { action: "fill", selector: { name: "city_2" }, field: "projectCity", value: "Portland", note: "City" } as RecipeStep,
  fx.REVIEW, fx.FINAL,
];

/** An adapter result that staged to review and reports these heals on the fill step's data —
 *  exactly where recipeAdapter puts them. */
const okWithHeals = (heals: unknown[]) => ({
  portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null,
  steps: [
    { ok: true, message: "Opened stub portal." },
    { ok: true, message: "Replayed 2 steps.", data: { healedSteps: heals } },
    { ok: true, message: "Human review required. AUTOMATION HAS STOPPED.", data: { finalSubmitClicked: false } },
  ],
});
const heal = (stepIndex: number, recipeVersion: number, extra: Record<string, unknown> = {}) => ({
  stepIndex, recipeVersion, action: "fill", note: "City", selector: { name: `healed_city_${stepIndex}` }, performed: true, ...extra,
});
const stepsOf = (recipeId: string): RecipeStep[] => JSON.parse(String(fx.recipeRow(recipeId).steps_json));
const auditsFor = (action: string, runId: unknown) => fx.audits(action).filter((a) => JSON.parse(a.details).runId === runId);

await check("(a) a heal at stepIndex 1 rewrites step 1 ONLY — its twin with the same (action, note) is untouched", async () => {
  const recipe = fx.completeRecipe(CITY_STEPS);
  const projectId = fx.newProject();
  fx.stubRunner(async () => okWithHeals([heal(1, recipe.version)]));
  await repo.prepareSubmission(db, projectId);
  const steps = stepsOf(recipe.id);
  assert.equal((steps[1].selector as { name?: string }).name, "healed_city_1", "the healed step was not patched (is the writer reading the steps' data?)");
  assert.deepEqual((steps[1].selector as { fallbacks?: unknown[] }).fallbacks, [{ name: "city_2" }], "the old selector was not kept as the fallback");
  assert.equal((steps[0].selector as { name?: string }).name, "city_1", "the heal re-pointed a DIFFERENT step that merely shares its (action, note)");
  assert.equal(Number(fx.recipeRow(recipe.id).version), recipe.version, "a heal must not bump the version");
  assert.equal(fx.recipeRow(recipe.id).status, "complete");
});

await check("(b) the recipe re-recorded DURING the replay: no step of the new version changes; the discard is audited", async () => {
  const recipe = fx.completeRecipe(CITY_STEPS);
  const projectId = fx.newProject();
  fx.stubRunner(async () => {
    fx.completeRecipe(CITY_STEPS); // a re-learn lands mid-replay → version + 1
    return okWithHeals([heal(1, recipe.version)]);
  });
  await repo.prepareSubmission(db, projectId);
  const steps = stepsOf(recipe.id);
  assert.equal((steps[1].selector as { name?: string }).name, "city_2", "an old run's heal was merged into the NEW recipe version");
  const run = fx.latestRun(projectId)!;
  const discarded = auditsFor("recipe.heal_discarded", run.id);
  assert.equal(discarded.length, 1, "the discarded heal left no audit row");
  assert.match(JSON.parse(discarded[0].details).reason, /changed during replay/);
});

await check("(c) a heal write that THROWS still leaves the recipe disarmed", async () => {
  const recipe = fx.completeRecipe(CITY_STEPS);
  // Precondition only (not the thing under test): an armed legacy row, as production had
  // (e965c645, 6282e671). No route arms any more — that is exactly why it is set directly.
  db.run("UPDATE portal_recipes SET auto_submit_enabled = 1 WHERE id = ?", [recipe.id]);
  const projectId = fx.newProject();
  // FAULT INJECTION: the healed selector refuses to serialize the FIRST time it is asked — which is
  // the heal's own step write — and behaves afterwards (the run row serializes the result later).
  let serializations = 0;
  const poisoned = { name: "x", toJSON() { serializations += 1; if (serializations === 1) throw new Error("injected heal-write failure"); return { name: "x" }; } };
  fx.stubRunner(async () => okWithHeals([heal(1, recipe.version, { selector: poisoned })]));
  await repo.prepareSubmission(db, projectId);
  assert.equal(Number(fx.recipeRow(recipe.id).auto_submit_enabled), 0, "the failed heal write left the healed recipe ARMED");
  const run = fx.latestRun(projectId)!;
  assert.equal(auditsFor("recipe.heal_discarded", run.id).length, 1, "the failed write was swallowed without a record");
});

await check("(d) a heal that never PERFORMED, or was read from another version, is not persisted", async () => {
  const recipe = fx.completeRecipe(CITY_STEPS);
  const projectId = fx.newProject();
  fx.stubRunner(async () => okWithHeals([
    heal(0, recipe.version, { performed: false }),
    heal(1, recipe.version - 1),
  ]));
  await repo.prepareSubmission(db, projectId);
  const steps = stepsOf(recipe.id);
  assert.equal((steps[0].selector as { name?: string }).name, "city_1", "a heal that resolved but never ran was persisted");
  assert.equal((steps[1].selector as { name?: string }).name, "city_2", "a heal measured against another version was persisted");
});

await check("(e) a heal whose index points at a step with a different action is refused", async () => {
  const recipe = fx.completeRecipe(CITY_STEPS);
  const projectId = fx.newProject();
  fx.stubRunner(async () => okWithHeals([heal(2, recipe.version)])); // step 2 is stopForReview
  await repo.prepareSubmission(db, projectId);
  const steps = stepsOf(recipe.id);
  assert.equal(steps[2].action, "stopForReview");
  assert.equal((steps[2].selector as { name?: string }).name, undefined, "a fill heal overwrote the review marker's selector");
});

// ── trust skeptic M3: a human step edit mid-replay does not bump the version ────────────────
await check("(m3a) MUST-EXCLUDE: a step inserted through savePortalRecipeSteps (the PUT …/steps writer) mid-replay shifts every index — the heal is discarded, audited, never landed on the shifted step", async () => {
  const recipes = fx.recipes;
  const STEPS: RecipeStep[] = [
    { action: "fill", selector: { name: "owner" }, field: "homeownerName", value: "x", note: "Owner" } as RecipeStep,
    { action: "fill", selector: { name: "city" }, field: "projectCity", value: "Portland", note: "City" } as RecipeStep,
    fx.REVIEW, fx.FINAL,
  ];
  const recipe = fx.completeRecipe(STEPS);
  const projectId = fx.newProject();
  fx.stubRunner(async () => {
    // The operator inserts a new FIRST step through the real steps writer while the replay runs.
    const inserted = { action: "fill", selector: { name: "email" }, field: "homeownerEmail", value: "e", note: "Email" } as RecipeStep;
    recipes.savePortalRecipeSteps(db, recipe.id, [inserted, ...STEPS], { status: "complete" });
    return okWithHeals([{ stepIndex: 1, recipeVersion: recipe.version, action: "fill", note: "City", selector: { name: "healed_city" }, performed: true }]);
  });
  await repo.prepareSubmission(db, projectId);
  const row = fx.recipeRow(recipe.id);
  assert.equal(Number(row.version), recipe.version, "premise: the steps writer does not bump the version (that is why the shape is compared)");
  const steps = stepsOf(recipe.id);
  assert.equal((steps[1].selector as { name?: string }).name, "owner", "the City heal overwrote the Owner step of the human-edited recipe");
  assert.equal((steps[2].selector as { name?: string }).name, "city", "the heal landed on the shifted City step — it was measured against the OLD steps");
  const run = fx.latestRun(projectId)!;
  const discarded = auditsFor("recipe.heal_discarded", run.id);
  assert.equal(discarded.length, 1, "the discarded heal left no audit row");
  assert.match(JSON.parse(discarded[0].details).reason, /steps were edited/);
});

await check("(m3b) MUST-PASS: a run that heals step 1 and then drifts at a later step still demotes — its own heal is not 'the recipe changed'", async () => {
  const recipe = fx.completeRecipe(CITY_STEPS);
  const projectId = fx.newProject();
  fx.stubRunner(async () => ({
    portalName: "stub", ok: false, finalSubmitClicked: false, pauseReason: null,
    steps: [
      { ok: true, message: "Opened stub portal.", data: { healedSteps: [heal(1, recipe.version)] } },
      { ok: false, message: "Recipe step failed (fill — inverter quantity): locator.fill: Timeout 8000ms exceeded." },
    ],
  }));
  await repo.prepareSubmission(db, projectId);
  const row = fx.recipeRow(recipe.id);
  assert.equal((stepsOf(recipe.id)[1].selector as { name?: string }).name, "healed_city_1", "the heal was not persisted");
  assert.equal(row.status, "needs_rerecord", "the run's own heal spared its drift (the demotion was measured against the steps the run started with, not what its own heal wrote)");
});

// ── close M3-selectors (probe P2a): a human re-points ONE selector mid-replay ─────────────────
// Same action, field and note — only the selector moves — so a shape that leaves selectors out
// cannot see it. KILL: repository/portalRecipes compare recipeShapeSignature-style (selector-free)
// again, or drop the steps comparison in persistHealedSteps → the heal overwrites the human's fix.
await check("(m3c) MUST-EXCLUDE (P2a): a heal measured on the OLD selector never lands on a step a human re-pointed mid-replay; discarded with a recipe.heal_discarded audit row", async () => {
  const recipes = fx.recipes;
  const STEPS: RecipeStep[] = [
    { action: "fill", selector: { name: "owner" }, field: "homeownerName", value: "x", note: "Owner" } as RecipeStep,
    { action: "fill", selector: { name: "city_old" }, field: "projectCity", value: "Portland", note: "City" } as RecipeStep,
    fx.REVIEW, fx.FINAL,
  ];
  const recipe = fx.completeRecipe(STEPS);
  const projectId = fx.newProject();
  fx.stubRunner(async () => {
    const edited = STEPS.map((st, i) => (i === 1 ? { ...st, selector: { name: "city_fixed_by_human" } } : st));
    recipes.savePortalRecipeSteps(db, recipe.id, edited as RecipeStep[], { status: "complete" });
    return okWithHeals([{ stepIndex: 1, recipeVersion: recipe.version, action: "fill", note: "City", selector: { name: "healed_from_old" }, performed: true }]);
  });
  await repo.prepareSubmission(db, projectId);
  assert.equal(Number(fx.recipeRow(recipe.id).version), recipe.version, "premise: the steps writer does not bump the version");
  const steps = stepsOf(recipe.id);
  assert.equal((steps[1].selector as { name?: string }).name, "city_fixed_by_human", `the heal overwrote the human's edited selector: ${JSON.stringify(steps[1].selector)}`);
  const run = fx.latestRun(projectId)!;
  const discarded = auditsFor("recipe.heal_discarded", run.id);
  assert.equal(discarded.length, 1, "the discarded heal left no audit row");
  assert.match(JSON.parse(discarded[0].details).reason, /steps were edited/);
  assert.equal(auditsFor("recipe.self_healed", run.id).length, 0, "a heal was recorded as applied");
});

repo.setRecipeStageRunnerForTests(null);
finish("heal-persistence");
