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
import { spawnSync } from "node:child_process";
import path from "node:path";
import Database from "better-sqlite3";
import { REPO } from "./_isolate";
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
// Restorable rows the M6/M7 cases add (the (g) apply must account for them).
let probevilleElectricalId = "";
let rivalLoneId = "";

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

// ── trust skeptic M6: legacy matching honours the discipline ─────────────────────────────────
await check("(m6) MUST-EXCLUDE: a structural recipe demoted on DRIFT is not restored on the electrical sibling's closed-browser run; MUST-PASS: the electrical sibling is", () => {
  const mk = (discipline: string) => {
    const r = recipes.startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj: "City of Probeville", portalUrl: "https://aca.example/", portalPlatform: "accela", createdBy: "t", discipline });
    return recipes.savePortalRecipeSteps(db, r.id, [...fx.fills(3), fx.REVIEW, fx.FINAL], { status: "complete", notes: "verified" });
  };
  const structural = mk("structural");
  const electrical = mk("electrical");
  assert.notEqual(structural.id, electrical.id, "setup: one row");
  const legacyAhjRun = (permitType: string, failing: string, at: string) => {
    seq += 1;
    const projectId = fx.newProject({ ahj: "City of Probeville" });
    db.run(
      `INSERT INTO portal_runs (id, project_id, run_type, status, started_at, finished_at, result_json, permit_type)
       VALUES (?, ?, 'prepare_submit', 'failed', ?, ?, ?, ?)`,
      [`legacy-run-${seq}`, projectId, at, at, JSON.stringify({ portalName: "Recipe: City of Probeville (accela)", ok: false, recipeStale: true, actor: "RecipeAdapter", steps: [{ ok: true, message: "Opened." }, { ok: false, message: failing }] }), permitType],
    );
  };
  const t1 = new Date(Date.now() + 1_000).toISOString(); // after both recipes' created_at
  legacyAhjRun("building", "Recipe step failed (fill — inverter quantity): locator.fill: Timeout 8000ms exceeded.", t1);
  db.run("UPDATE portal_recipes SET status = 'needs_rerecord', updated_at = ? WHERE id = ?", [t1, structural.id]);
  const t2 = new Date(Date.now() + 2_000).toISOString();
  legacyAhjRun("electrical", "Recipe step failed (fill — Email): locator.fill: Target page, context or browser has been closed", t2);
  db.run("UPDATE portal_recipes SET status = 'needs_rerecord', updated_at = ? WHERE id = ?", [t2, electrical.id]);
  const d = decisionFor(structural.id);
  assert.equal(d.restore, false, "the structural recipe (demoted on drift) is restored on the ELECTRICAL recipe's closed-browser run");
  assert.match(d.reason, /still blames the recipe/, `the structural decision read the wrong run: ${d.reason}`);
  const e = decisionFor(electrical.id);
  assert.equal(e.restore, true, e.reason);
  // A trackless legacy run beside disciplined siblings is ambiguous: it matches neither.
  const t3 = new Date(Date.now() + 3_000).toISOString();
  legacyAhjRun("permit", "Recipe step failed (fill — Email): locator.fill: Target page, context or browser has been closed", t3);
  assert.equal(decisionFor(structural.id).restore, false, "a trackless run was guessed onto the structural recipe");
  assert.match(decisionFor(structural.id).reason, /still blames the recipe/, "the trackless run displaced the structural recipe's own demoting run");
  probevilleElectricalId = electrical.id;
});

// ── trust skeptic M7: the rival-key refusal ──────────────────────────────────────────────────
await check("(m7) the rival-key state cannot exist: the schema's UNIQUE (profile_key, discipline) index forbids a second row on the key (the refusal in the script is defence in depth); MUST-PASS: a demoted recipe with no rival is restored", () => {
  const lone = utilityRecipe("Rival Power");
  legacyDemotion(lone, "Recipe step failed (fill — Email): locator.fill: Target page, context or browser has been closed");
  assert.equal(decisionFor(lone.id).restore, true, decisionFor(lone.id).reason);
  // The skeptic's MUST-EXCLUDE ("another complete recipe holds the same profile_key and discipline")
  // names a state no migrated database can hold: idx_portal_recipes_profile_discipline (db.ts,
  // migration that lifted the one-recipe-per-AHJ ceiling) is UNIQUE on (profile_key, discipline),
  // and every writer goes through startPortalRecording, which resets the existing row. So the
  // script's rival refusal cannot be reached, and no test can turn red by removing it. What CAN be
  // proven — and what would make the refusal load-bearing if it ever changed — is the index itself.
  const row = fx.recipeRow(lone.id);
  assert.throws(() => db.run(
    `INSERT INTO portal_recipes (id, scope_type, profile_key, state, ahj, utility, portal_platform, portal_url, status, version, steps_json, created_by, created_at, updated_at, notes, discipline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'complete', 1, ?, 'legacy', ?, ?, '', ?)`,
    ["rival-legacy-row", row.scope_type, row.profile_key, row.state, row.ahj, row.utility, row.portal_platform, row.portal_url, row.steps_json, String(row.created_at), String(row.updated_at), row.discipline],
  ), /UNIQUE constraint failed: portal_recipes\.profile_key, portal_recipes\.discipline/,
    "a second complete recipe landed on the same key and discipline — the rival refusal in restore-demoted-recipes is now load-bearing and needs its own kill test");
  assert.equal(db.query("SELECT id FROM portal_recipes WHERE profile_key = ?", [String(row.profile_key)]).length, 1);
  rivalLoneId = lone.id;
});

// ── trust skeptic M5: the dry run writes NOTHING at the database level ───────────────────────
await check("(m5) MUST-EXCLUDE: the CLI dry run on a copy at an OLDER schema leaves MAX(schema_meta.version), every row count and the knowledge table byte-identical; --apply refuses it; MUST-PASS: --apply on the migrated copy restores with audit rows", () => {
  const copy = path.join(path.dirname(String(process.env.AUTOPILOT_DB_PATH)), "restore-cli-copy.sqlite");
  db.backupTo(copy);
  const signature = () => {
    const c = new Database(copy, { readonly: true });
    const tables = (c.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    const out = {
      maxVersion: (c.prepare("SELECT MAX(version) AS v FROM schema_meta").get() as { v: number }).v,
      counts: Object.fromEntries(tables.map((t) => [t, (c.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n])),
      knowledge: JSON.stringify(c.prepare("SELECT * FROM permit_utility_knowledge ORDER BY rowid").all()),
      recipes: JSON.stringify(c.prepare("SELECT id, status, version, flag_reason FROM portal_recipes ORDER BY id").all()),
    };
    c.close();
    return out;
  };
  // An older schema: the newest migration row removed (what a production .backup taken under the
  // older pinned server looks like to this code).
  const lower = new Database(copy);
  const newest = (lower.prepare("SELECT MAX(version) AS v FROM schema_meta").get() as { v: number }).v;
  const removed = lower.prepare("SELECT * FROM schema_meta WHERE version = ?").get(newest) as { version: number; name: string; applied_at: string };
  lower.prepare("DELETE FROM schema_meta WHERE version = ?").run(newest);
  lower.close();
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "scripts/restore-demoted-recipes.ts"), ...args], {
    env: { ...process.env, AUTOPILOT_DB_PATH: copy, ANTHROPIC_API_KEY: "" }, cwd: REPO, encoding: "utf8",
  });
  const before = signature();
  assert.equal(before.maxVersion, newest - 1, "setup: the copy was not lowered");
  const dry = run();
  assert.equal(dry.status, 0, `dry run failed:\n${dry.stdout}\n${dry.stderr}`);
  assert.match(dry.stdout, /DRY RUN/);
  assert.match(dry.stdout, /RESTORE/, "the dry run did not plan the restores the in-process plan makes");
  assert.deepEqual(signature(), before, "the DRY RUN wrote to the database (a migration, a seed, or a restore)");
  const refused = run("--apply");
  assert.equal(refused.status, 2, `--apply on an older schema was not refused:\n${refused.stdout}\n${refused.stderr}`);
  assert.match(refused.stderr, /Refusing --apply/);
  assert.deepEqual(signature(), before, "a refused --apply wrote to the database");
  // MUST-PASS: on the migrated copy, --apply restores exactly the planned rows, audited.
  const restoreRow = new Database(copy);
  restoreRow.prepare("INSERT INTO schema_meta (version, name, applied_at) VALUES (?, ?, ?)").run(removed.version, removed.name, removed.applied_at);
  restoreRow.close();
  const applied = run("--apply");
  assert.equal(applied.status, 0, `--apply failed:\n${applied.stdout}\n${applied.stderr}`);
  const after = new Database(copy, { readonly: true });
  const restored = (after.prepare("SELECT id FROM portal_recipes WHERE id IN (?, ?) AND status = 'complete'").all(closed.id, gated.id) as Array<{ id: string }>).map((r) => r.id).sort();
  assert.deepEqual(restored, [closed.id, gated.id].sort(), "the CLI --apply did not restore the closed-browser and document-gate recipes");
  const audits = (after.prepare("SELECT details FROM audit_logs WHERE action = 'portal_recipe.restored'").all() as Array<{ details: string }>).map((a) => JSON.parse(a.details).recipeId);
  assert.ok(audits.includes(closed.id) && audits.includes(gated.id), "the CLI --apply wrote no portal_recipe.restored audit rows");
  assert.equal((after.prepare("SELECT MAX(version) AS v FROM schema_meta").get() as { v: number }).v, newest, "--apply migrated the database");
  assert.equal((after.prepare("SELECT status FROM portal_recipes WHERE id = ?").get(drifted.id) as { status: string }).status, "needs_rerecord");
  after.close();
});

await check("(g) DRY RUN writes nothing; --apply restores exactly the approved rows, disarmed, audited, and flags the unattributed one", () => {
  const before = db.query<{ id: string; status: string }>("SELECT id, status FROM portal_recipes ORDER BY id");
  const plan = planRecipeRestores(db);
  assert.deepEqual(db.query("SELECT id, status FROM portal_recipes ORDER BY id"), before, "planning wrote to the database");
  const approved = plan.filter((p) => p.restore).map((p) => p.recipeId).sort();
  assert.deepEqual(approved, [closed.id, gated.id, unknown.id, probevilleElectricalId, rivalLoneId].sort(), `unexpected restore set: ${JSON.stringify(plan.filter((p) => p.restore).map((p) => p.label))}`);
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
