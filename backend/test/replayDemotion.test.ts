// A FAILED REPLAY DEMOTES A RECIPE ONLY WHEN THE FAILURE POINTS AT THE RECIPE.
//
// Operator ruling (2026-09-24, docs/HANDOFF.md): a replay failure nobody can attribute KEEPS the
// recipe and FLAGS it for a human. Harness aborts (browser/context closed, our own profile
// lease), document-gate refusals, missing project data and challenges NEVER demote and never
// queue a re-learn. Only drift the classifier attributes to the recipe demotes.
//
// Why: repository.ts called markPortalRecipeForRerecord(db, recipe.id) with NO failure text on
// /recipe step failed/ over every step's message joined — the classifier never ran. Production:
//   - PGE 481c00f4 was demoted by run 705ef471 ("locator.fill: Target page, context or browser
//     has been closed") in the same second the run died;
//   - PacifiCorp 6282e671 by run b03fe9c5 ("The site_plan document changed or no longer matches
//     this permit path") — a document gate;
// and NEM replay went offline for every production utility. Feeding the JOINED text to the
// classifier fails the other way: the review step's boilerplate carries "MFA/fee", so every
// failure would read as an MFA wall and nothing would demote.
//
// Every case drives the REAL prepareSubmission (gates, run row, classifier, audit) with only the
// browser stubbed. The recipe is written through startPortalRecording + savePortalRecipeSteps.
//
// KILL TESTS (each must turn this file red):
//   K1 repository.ts: pass the joined stage text (stageFailureText(result)) instead of
//      extractStageFailureMessage(result)            → (c) fails (MFA boilerplate spares drift).
//   K2 repository.ts: pass "" as the failure text     → (a) fails (kept-with-reason becomes a flag).
//   K3 portalRecipes.demoteOnReplayFailure: demote unconditionally → (a) (b) (b2) (f) fail.
//   K4 runAbort.ts: drop "waiting for the portal profile to free up" → (f) fails.
//
// Run: npx tsx backend/test/replayDemotion.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("replay-demotion");
const { db, repo, recipes } = fx;

const BOILERPLATE_SPARING = "Human review required. Verify all fields and click submit manually. Handle any MFA/fee, then click submit manually.";

/** Stage once against a fresh complete recipe with the given failing-step message. */
async function stageFailingWith(message: string | undefined, extra: Record<string, unknown> = {}) {
  const recipe = fx.completeRecipe();
  const projectId = fx.newProject();
  fx.stubRunner(async () => {
    const r = fx.failingStep(message ?? "") as Record<string, unknown> & { steps: Array<Record<string, unknown>> };
    if (message === undefined) delete r.steps[1].message;
    return { ...r, ...extra };
  });
  await repo.prepareSubmission(db, projectId);
  const run = fx.latestRun(projectId)!;
  const result = JSON.parse(String(run.result_json));
  assert.equal(result.actor, "RecipeAdapter", `setup: the stage did not take the recipe branch (actor ${result.actor}) — the test would pass for the wrong reason`);
  return { recipe, projectId, run, result, row: fx.recipeRow(recipe.id) };
}

// The recipe ROW is shared across cases (one AHJ key, re-recorded each time) — so audit rows are
// matched by the RUN that wrote them wherever a case has one.
const auditFor = (action: string, recipeId: string, runId?: unknown) => fx.audits(action)
  .filter((a) => JSON.parse(a.details).recipeId === recipeId && (runId === undefined || JSON.parse(a.details).runId === runId));

// ── the classifier, on the messages production actually wrote ────────────────────────────────
await check("classifier: production messages land in the right family (MUST-PASS and MUST-EXCLUDE)", () => {
  const cases: Array<[string, "recipe" | "not_recipe" | "unknown"]> = [
    // not the recipe — harness / our lease / document gate / project data / the filing's outcome
    ["Recipe step failed (fill — Email): locator.fill: Target page, context or browser has been closed [url=https://pgenm.powerclerk.com/x]", "not_recipe"],
    ["Recipe step failed (upload — upload site_plan: Please upload your site plan): The site_plan document changed or no longer matches this permit path. Rebuild and restart the run.", "not_recipe"],
    ["Recipe login failed: Timed out after 900s waiting for the portal profile to free up: C:\\profiles\\x", "not_recipe"],
    ["Recipe step failed (click — final submit: Submit (recorded, NOT clicked)): After the submit click the page neither confirmed nor rejected the filing", "not_recipe"],
    ["Recipe step failed (click — final submit): Final submit clicked; outcome unknown — human must verify.", "not_recipe"],
    ["Recipe step failed (check — record type): Record type \"Residential - Structural\" is not offered here — refusing to pick another permit type.", "not_recipe"],
    ["Permit path changed or is unknown; upload stopped.", "not_recipe"],
    // the recipe — drift
    ["Recipe step failed (fill — Current meter number): locator.fill: Timeout 8000ms exceeded.", "recipe"],
    ["Recipe step failed (click — application entry: Apply): locator.click: Timeout 30000ms exceeded.", "recipe"],
    ["Recipe step failed (page drift): only 1 of 6 recorded fields for this section are on the current page", "recipe"],
    ["Recipe step failed (select — Manufacturer): option not found in list", "recipe"],
    // nobody can say
    ["Portal run errored: Cannot read properties of undefined (reading 'x')", "unknown"],
    ["", "unknown"],
    // ── trust skeptic M2 ──
    // MUST-EXCLUDE: text the PORTAL said about the PROJECT never demotes ("not found" / "does
    // not exist" are the portal's validation words here, not a vanished control).
    ['Recipe step failed (click — advance: Next): the portal did not advance (it refused "advance: Next"). The portal says: Service Account Number: Account not found', "not_recipe"],
    ['Recipe step failed (click — advance: Next): the portal did not advance (it refused "advance: Next"). The portal says: Meter number does not exist for this account', "not_recipe"],
    ['Recipe step failed (click — advance: Next): the portal did not advance (it refused "advance: Next"). The portal says: Meter Number: This field is required.', "not_recipe"],
    // MUST-EXCLUDE: the adapter's page-drift tripwire that itself blames a blank required field is unattributed (keep and flag), never 'recipe'.
    ['Recipe step failed (page drift): only 0 of 6 recorded fields for this section ("A", "B", "C"…) are on the current page — the replay is not on the page the recipe expects, most likely because an earlier required field was left blank and the portal refused to advance. Stopping rather than filling the wrong controls.', "unknown"],
    // MUST-PASS: real drift stays 'recipe' — and the captured page description after it (a /403/ in
    // the URL, a "Help: MFA setup" button, "DNS settings") must not steer the verdict.
    ["Recipe step failed (fill — inverter quantity): locator.fill: Timeout 8000ms exceeded.", "recipe"],
    ['Recipe step failed (click — Next): locator.click: Timeout 30000ms exceeded. [url=https://x.gov/Project/403/Edit | visible controls: "Help: MFA setup"]', "recipe"],
    ['Recipe step failed (fill — Customer Address): locator.fill: Timeout 30000ms exceeded. [url=https://aca-oregon.accela.com/x | visible controls: "DNS settings"]', "recipe"],
    ['Recipe step failed (fill — Email): locator.fill: Timeout 30000ms exceeded. [title="Session expired" | visible controls: "Log in"]', "recipe"],
    // A slow portal (a navigation wait) is not the recipe.
    ["Recipe step failed (fill — Email): page.waitForLoadState: Timeout 30000ms exceeded.", "not_recipe"],
    ["Recipe step failed (click — Next): page.waitForURL: Timeout 30000ms exceeded.", "not_recipe"],
  ];
  for (const [text, want] of cases) {
    assert.equal(recipes.replayFailureBlamesRecipe(text).attribution, want, `"${text.slice(0, 90)}" should be ${want}`);
  }
  // The boilerplate on its own must never read as a reason to spare drift: it is not a failure.
  assert.equal(recipes.replayFailureBlamesRecipe(`Recipe step failed (fill — x): locator.fill: Timeout 8000ms exceeded. | ${BOILERPLATE_SPARING}`).attribution,
    "not_recipe", "sanity: the JOINED text is exactly what spares drift — which is why the run path must never pass it");
});

// ── (a) a dead browser ────────────────────────────────────────────────────────────────────────
await check("(a) a closed browser KEEPS the recipe complete, unflagged, with no re-learn", async () => {
  const { recipe, result, row, run } = await stageFailingWith("Recipe step failed (fill — Email): locator.fill: Target page, context or browser has been closed [url=https://permits.portland.example/x]");
  assert.equal(row.status, "complete", "a dead browser demoted the recipe — PGE 481c00f4 all over again");
  assert.equal(String(row.flag_reason ?? ""), "", "a harness abort is attributable (to us) — it must not raise the human flag");
  assert.notEqual(result.recipeStale, true, "the re-learn / stale branch ran for a harness abort");
  const refused = auditFor("portal_recipe.demotion_refused", recipe.id, run.id);
  assert.equal(refused.length, 1, "no demotion_refused audit row");
  assert.equal(JSON.parse(refused[0].details).runId, run.id, "the audit row does not name the run");
  assert.match(JSON.parse(refused[0].details).reason, /browser or process went away/);
  assert.equal(run.status, "failed");
});

// ── (b) a document gate ──────────────────────────────────────────────────────────────────────
await check("(b) a document-gate refusal KEEPS the recipe", async () => {
  const { row, result } = await stageFailingWith("Recipe step failed (upload — upload site_plan: Please upload your site plan): The site_plan document changed or no longer matches this permit path. Rebuild and restart the run.");
  assert.equal(row.status, "complete", "a document gate demoted the recipe — PacifiCorp 6282e671 all over again");
  assert.notEqual(result.recipeStale, true);
});

await check("(b2) missing project data (a record type this AHJ does not offer) KEEPS the recipe", async () => {
  const { row } = await stageFailingWith("Recipe step failed (check — record type: Residential - Structural): Record type \"Residential - Structural\" is not offered here — refusing to pick another permit type.");
  assert.equal(row.status, "complete");
});

// ── (c) real drift, beside the MFA boilerplate ───────────────────────────────────────────────
await check("(c) a locator timeout whose sibling step carries the MFA boilerplate IS demoted", async () => {
  const { recipe, row, result, run } = await stageFailingWith("Recipe step failed (fill — inverter quantity): locator.fill: Timeout 8000ms exceeded.");
  assert.equal(row.status, "needs_rerecord", "drift was spared — the joined text (with its MFA boilerplate) reached the classifier");
  assert.equal(result.recipeStale, true, "the demoted branch (re-learn gate + stale message) did not run");
  const demoted = auditFor("portal_recipe.demoted", recipe.id, run.id);
  assert.equal(demoted.length, 1, "a demotion left no audit row — the restore script would have to guess again");
  const d = JSON.parse(demoted[0].details);
  assert.equal(d.runId, run.id);
  assert.match(d.failureText, /Timeout 8000ms/);
  assert.equal(d.expectedVersion, recipe.version);
});

// ── (d) nobody can say ───────────────────────────────────────────────────────────────────────
await check("(d) an unattributable failure KEEPS the recipe and FLAGS it for a human", async () => {
  const { recipe, row, result, run } = await stageFailingWith("Portal run errored: Cannot read properties of undefined (reading 'value')");
  assert.equal(row.status, "complete", "an unattributed failure demoted the recipe (the ruling is keep-and-flag)");
  assert.ok(String(row.flag_reason ?? "").length > 0, "kept, but no flag was raised — nobody will look");
  assert.ok(row.flagged_at, "flagged_at not stamped");
  assert.equal(recipes.recipeReviewFlag(db, recipe.id).reason, String(row.flag_reason));
  assert.notEqual(result.recipeStale, true, "an unattributed failure queued the re-learn branch");
  assert.equal(auditFor("portal_recipe.replay_failure_flagged", recipe.id, run.id).length, 1);
  assert.match(String(run.error_message), /flagged for a human/i, "the run's own message does not say the recipe was kept and flagged");
});

// ── (m4) the flag is VISIBLE and CLEARABLE (trust skeptic M4) ──────────────────────────────
await check("(m4) MUST-PASS: the flag a kept-and-flagged failure raised is returned with the recipe (the list route's reader); MUST-EXCLUDE: a kept not_recipe failure carries no flag; a human clears it, audited", async () => {
  const { recipe, row } = await stageFailingWith("Portal run errored: Cannot read properties of undefined (reading 'flag')");
  const listed = recipes.listPortalRecipes(db).find((r) => r.id === recipe.id)!;
  assert.ok(listed, "setup: the recipe is not listed");
  assert.equal(listed.flagReason, String(row.flag_reason), "the list does not carry the flag — nobody will see it");
  assert.ok(listed.flagReason.length > 0 && listed.flaggedAt, "an unattributed failure raised no visible flag");
  assert.equal(recipes.getPortalRecipe(db, recipe.id).flagReason, listed.flagReason);
  // A human clears it (the POST /api/portal-recipes/:id/clear-flag writer), audited with who.
  const cleared = recipes.clearPortalRecipeFlag(db, recipe.id, { actor: "A. Operator", note: "looked at the run: our own bug" });
  assert.equal(cleared.flagReason, "");
  assert.equal(cleared.flaggedAt, null);
  assert.equal(cleared.status, "complete", "clearing a flag must not touch the status");
  const audits = auditFor("portal_recipe.flag_cleared", recipe.id);
  assert.equal(audits.length, 1, "the clear left no audit row");
  assert.equal(audits[0].actor_name, "A. Operator");
  assert.match(JSON.parse(audits[0].details).flagReason, /could not be attributed/);
  // Idempotent: clearing again writes nothing.
  recipes.clearPortalRecipeFlag(db, recipe.id, { actor: "A. Operator" });
  assert.equal(auditFor("portal_recipe.flag_cleared", recipe.id).length, 1);
  // MUST-EXCLUDE: a kept (attributable) failure raises nothing to show.
  const kept = await stageFailingWith("Recipe step failed (fill — Email): locator.fill: Target page, context or browser has been closed");
  assert.equal(recipes.listPortalRecipes(db).find((r) => r.id === kept.recipe.id)!.flagReason, "", "a harness abort showed a flag");
});

await check("(e) a failing step with NO message is unattributable: kept and flagged, never demoted", async () => {
  const { row } = await stageFailingWith(undefined);
  assert.equal(row.status, "complete");
  assert.ok(String(row.flag_reason ?? "").length > 0);
});

// ── (f) our own lease ────────────────────────────────────────────────────────────────────────
await check("(f) our own profile lease refusing to start is a harness abort: kept, unflagged", async () => {
  const { recipe, row, run } = await stageFailingWith("Recipe login failed: Timed out after 900s waiting for the portal profile to free up: C:\\profiles\\client\\portal");
  assert.equal(row.status, "complete");
  // Kept for the RIGHT reason: our own lease — not "the stored login was refused", which the
  // words "login failed" would otherwise make it (and a credential verdict locks accounts out).
  const refused = auditFor("portal_recipe.demotion_refused", recipe.id, run.id);
  assert.equal(refused.length, 1);
  assert.match(JSON.parse(refused[0].details).reason, /profile lease|browser or process/, "profile contention was kept as a CREDENTIAL failure, not as ours");
  assert.equal(String(row.flag_reason ?? ""), "", "profile contention is ours — it should be kept with a reason, not flagged as unknown");
});

// ── (g) a pause is not a failure ─────────────────────────────────────────────────────────────
await check("(g) a run PAUSED at a challenge is judged by nobody: no demotion, no flag, no audit", async () => {
  const { recipe, row, run } = await stageFailingWith("MFA code required", { pauseReason: "mfa_captcha" });
  assert.equal(row.status, "complete");
  assert.equal(String(row.flag_reason ?? ""), "");
  for (const a of ["portal_recipe.demoted", "portal_recipe.demotion_refused", "portal_recipe.replay_failure_flagged"]) {
    assert.equal(auditFor(a, recipe.id, run.id).length, 0, `${a} written for a paused run`);
  }
});

// ── (h) the recipe changed under the replay ──────────────────────────────────────────────────
await check("(h) drift on a recipe that was re-recorded DURING the replay does not demote the new version", async () => {
  const recipe = fx.completeRecipe();
  const projectId = fx.newProject();
  fx.stubRunner(async () => {
    fx.completeRecipe(); // a re-learn lands while this replay is still running → version + 1
    return fx.failingStep("Recipe step failed (fill — inverter quantity): locator.fill: Timeout 8000ms exceeded.");
  });
  await repo.prepareSubmission(db, projectId);
  const row = fx.recipeRow(recipe.id);
  assert.equal(row.status, "complete", "the failure of the OLD version demoted the NEW one");
  assert.equal(Number(row.version), recipe.version + 1);
  assert.equal(auditFor("portal_recipe.demotion_skipped", recipe.id).length, 1, "the skipped demotion was not audited");
});

// ── (m3) trust skeptic M3: a human step edit mid-replay (no version bump) ────────────────────
await check("(m3) MUST-EXCLUDE: drift on the OLD steps does not demote a recipe a human edited through savePortalRecipeSteps during the replay", async () => {
  const recipe = fx.completeRecipe();
  const projectId = fx.newProject();
  fx.stubRunner(async () => {
    // The operator inserts a step through the real steps writer (the PUT …/steps route's) mid-run.
    const inserted = { action: "fill", selector: { name: "email" }, field: "homeownerEmail", value: "e", note: "Email" } as never;
    recipes.savePortalRecipeSteps(db, recipe.id, [inserted, ...recipe.steps], { status: "complete" });
    return fx.failingStep("Recipe step failed (fill — inverter quantity): locator.fill: Timeout 8000ms exceeded.");
  });
  await repo.prepareSubmission(db, projectId);
  const row = fx.recipeRow(recipe.id);
  assert.equal(Number(row.version), recipe.version, "premise: the steps writer does not bump the version");
  assert.equal(row.status, "complete", "drift measured against the OLD steps demoted the edited recipe");
  const run = fx.latestRun(projectId)!;
  const skipped = auditFor("portal_recipe.demotion_skipped", recipe.id, run.id);
  assert.equal(skipped.length, 1, "the skipped demotion was not audited");
  assert.match(JSON.parse(skipped[0].details).reason, /steps were edited/);
});

// ── close M3-selectors (probe P2b): a human re-points ONE selector mid-replay ─────────────────
// KILL: measure the demotion against a selector-free shape again → the fixed recipe is demoted.
await check("(m3s) MUST-EXCLUDE (P2b): drift on the OLD selector does not demote a recipe a human re-pointed (selector only) during the replay", async () => {
  const STEPS = [
    { action: "fill", selector: { name: "owner" }, field: "homeownerName", value: "x", note: "Owner" },
    { action: "fill", selector: { name: "city_old" }, field: "projectCity", value: "Portland", note: "City" },
    fx.REVIEW, fx.FINAL,
  ] as never[];
  const recipe = fx.completeRecipe(STEPS);
  const projectId = fx.newProject();
  fx.stubRunner(async () => {
    const edited = (STEPS as Array<Record<string, unknown>>).map((st, i) => (i === 1 ? { ...st, selector: { name: "city_fixed_by_human" } } : st));
    recipes.savePortalRecipeSteps(db, recipe.id, edited as never, { status: "complete" });
    return fx.failingStep("Recipe step failed (fill — City): locator.fill: Timeout 8000ms exceeded.");
  });
  await repo.prepareSubmission(db, projectId);
  const row = fx.recipeRow(recipe.id);
  assert.equal(Number(row.version), recipe.version, "premise: the steps writer does not bump the version");
  assert.equal(row.status, "complete", "drift measured on the OLD selector demoted the human-fixed recipe");
  const run = fx.latestRun(projectId)!;
  const skipped = auditFor("portal_recipe.demotion_skipped", recipe.id, run.id);
  assert.equal(skipped.length, 1, "the skipped demotion was not audited");
  assert.match(JSON.parse(skipped[0].details).reason, /steps were edited/);
  // MUST-PASS: the same drift with NO human edit still demotes (the fingerprint matches the DB).
  const untouched = fx.completeRecipe(STEPS);
  const p2 = fx.newProject();
  fx.stubRunner(async () => fx.failingStep("Recipe step failed (fill — City): locator.fill: Timeout 8000ms exceeded."));
  await repo.prepareSubmission(db, p2);
  assert.equal(fx.recipeRow(untouched.id).status, "needs_rerecord", "drift on an untouched recipe no longer demotes (the replay's fingerprint does not match the stored steps)");
});

// ── the human door stays separate ────────────────────────────────────────────────────────────
await check("the human's mark-for-re-record still demotes with no evidence, and is audited as a person's act", () => {
  const recipe = fx.completeRecipe();
  const after = recipes.markPortalRecipeForRerecord(db, recipe.id, { actor: "A. Operator", reason: "portal redesigned" });
  assert.equal(after.status, "needs_rerecord");
  const rows = auditFor("portal_recipe.marked_for_rerecord", recipe.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_name, "A. Operator");
});

repo.setRecipeStageRunnerForTests(null);
finish("replay-demotion");
