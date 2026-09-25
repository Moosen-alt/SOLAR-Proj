// STATEWIDE / SHARED-PORTAL REUSE — an engine rule, not an Accela patch (operator ruling 2026-09-24).
//
// When an entity has no complete recipe of its own, a COMPLETE recipe learned for ANOTHER entity
// on the SAME portal, for the SAME record type and discipline, may replay for it. Never across
// hosts (or tenants of a path-tenanted host), never across tracks, never across record types,
// never across states. The choice is recorded on the run and shown; a borrowed recipe is never
// demoted, flagged or healed by another entity's run; and it never clicks a final submit.
//
// Recipes are written through startPortalRecording + savePortalRecipeSteps; the AHJ's own portal
// through saveVerifiedAhjProfile; the end-to-end cases drive the real prepareSubmission with only
// the browser stubbed (setRecipeStageRunnerForTests).
//
// KILL TESTS (each turns this file red — verified by hand, see the commit):
//   K1 findBorrowableRecipe: drop the record-type-is-this-discipline check  → (r2) fails.
//   K2 findBorrowableRecipe: host-only match (ignore the tenant)             → (r5) fails.
//   K3 findBorrowableRecipe: skip the "donors disagree on the type" refusal  → (r4) fails.
//   K4 repository: persist heals for a borrowed recipe                      → (s2) fails.
//   K5 repository: run the demotion classifier on a borrowed failure         → (s3) fails.
//   K6 repository: no borrowedFrom refusal in automaticSubmitRefusals         → (s4) fails.
//   K7 repository: no borrow at all                                          → (s1) fails.
//
// Run: npx tsx backend/test/sharedPortalReuse.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import type { RecipeStep } from "../../shared/src/types";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("shared-portal-reuse");
const { db, repo, recipes } = fx;
const kb = await import("../src/knowledgeBase");

const ACA_OREGON = "https://aca-oregon.accela.com/oregon/";
const PGE_NM = "https://pgenm.powerclerk.com/MvcAccount/Login";
const PACIFICORP_NM = "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login";

const fill = (i: number, field = "homeownerName"): RecipeStep => ({ action: "fill", selector: { name: `f${i}` }, field, note: `Field ${i}` });
const REVIEW = { action: "stopForReview", selector: {} } as RecipeStep;
const accelaSteps = (recordType: string, portal = ACA_OREGON): RecipeStep[] => [
  { action: "goto", value: `${portal}Dashboard.aspx`, note: "entry url" },
  fill(1, "streetNumber"),
  { action: "check", selector: { label: recordType }, note: `record type: ${recordType}` },
  { action: "click", selector: { text: "Continue Application »" }, note: "record type: continue" },
  fill(2), fill(3), REVIEW,
];

function ahjRecipe(input: { state: string; ahj: string; portalUrl: string; discipline: string; steps: RecipeStep[]; status?: "complete" | "needs_rerecord" }) {
  const r = recipes.startPortalRecording(db, {
    scopeType: "ahj", state: input.state, ahj: input.ahj, utility: "Pacific Power", portalUrl: input.portalUrl,
    discipline: input.discipline, portalPlatform: "accela", createdBy: "test",
  });
  return recipes.savePortalRecipeSteps(db, r.id, input.steps, { status: input.status ?? "complete" });
}
/** The TARGET's own portal on file — through the real research writer (a seeded KB row), which is
 *  how a new AHJ's portal usually arrives. findBorrowableRecipe only ever matches a donor to the
 *  target's OWN portal. */
function ownPortal(state: string, ahj: string, portalUrl: string) {
  kb.saveResearchedAhjProfile(db, { state, ahj }, {
    provider: "claude", portalName: "", portalPlatform: "", portalUrl, submissionMethod: "online portal",
    requiredDocuments: ["Plan set"], commonCorrections: [], tips: [], submissionSteps: [], confidence: "medium",
    needsHumanVerification: true, notes: "", webGrounded: true,
  });
}
const decide = (track: string, state: string, ahj: string, portal: string) => recipes.findBorrowableRecipe(db, {
  track, state, ahj, targetPortalUrl: portal, entity: recipes.portalEntityEvidence(db, { scope: track === "nem" ? "utility" : "ahj", state, name: ahj }),
});

// The world: Coos Bay learned structural on aca-oregon; Salem's own portal is aca-oregon (verified).
const coosStructural = ahjRecipe({ state: "OR", ahj: "City of Coos Bay", portalUrl: ACA_OREGON, discipline: "structural", steps: accelaSteps("Residential - Structural") });
kb.saveVerifiedAhjProfile(db, { state: "OR", ahj: "City of Salem", portalUrl: ACA_OREGON, portalPlatform: "accela", verifiedBy: "test" });

await check("(r1) MUST-PASS: a Salem structural stage resolves the Coos Bay structural recipe on the shared portal", () => {
  const d = decide("building", "OR", "City of Salem", ACA_OREGON);
  assert.equal(d.choice?.recipe.id, coosStructural.id, d.reason);
  assert.equal(d.choice?.learnedFor, "City of Coos Bay");
  assert.equal(d.choice?.recordType, "Residential - Structural");
  assert.equal(d.choice?.discipline, "structural");
});

await check("(r2) MUST-EXCLUDE: a Salem ELECTRICAL stage never resolves a structural recipe — even one keyed electrical", () => {
  assert.equal(decide("electrical", "OR", "City of Salem", ACA_OREGON).choice, null, "no electrical recipe exists yet");
  // A row KEYED electrical whose recorded record type is structural is still a structural application.
  const miskeyed = ahjRecipe({ state: "OR", ahj: "City of Lincoln City", portalUrl: ACA_OREGON, discipline: "electrical", steps: accelaSteps("Residential - Structural") });
  const d = decide("electrical", "OR", "City of Salem", ACA_OREGON);
  assert.equal(d.choice, null, `must not lend ${miskeyed.id}: ${d.reason}`);
  assert.ok(d.rejected.some((r) => r.recipeId === miskeyed.id && /not a electrical application/.test(r.why)), JSON.stringify(d.rejected));
  // …and the real electrical one lends to electrical only.
  const coosElectrical = ahjRecipe({ state: "OR", ahj: "City of Coos Bay", portalUrl: ACA_OREGON, discipline: "electrical", steps: accelaSteps("Residential - Electrical") });
  assert.equal(decide("electrical", "OR", "City of Salem", ACA_OREGON).choice?.recipe.id, coosElectrical.id);
  assert.equal(decide("building", "OR", "City of Salem", ACA_OREGON).choice?.recipe.id, coosStructural.id);
});

await check("(r3) MUST-EXCLUDE: a PGE project never resolves a PacifiCorp recipe; NEM never borrows at all", () => {
  const r = recipes.startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "Pacific Power", portalUrl: PACIFICORP_NM, createdBy: "test" });
  recipes.savePortalRecipeSteps(db, r.id, [fill(1), { action: "click", selector: { text: "Net Metering" }, note: "application program: Net Metering" }, REVIEW], { status: "complete" });
  assert.equal(decide("nem", "OR", "PGE", PGE_NM).choice, null);
  assert.equal(decide("nem", "OR", "PGE", PACIFICORP_NM).choice, null, "even pointed at PacifiCorp's own host");
});

await check("(r4) MUST-EXCLUDE: a host shared by two utilities with different programs does not cross", () => {
  const SHARED = "https://interconnect.coop-shared.example/apply";
  for (const [utility, program] of [["Alpha Electric Cooperative", "Alpha Net Billing"], ["Beta Power District", "Beta Solar Choice"]]) {
    const r = recipes.startPortalRecording(db, { scopeType: "utility", state: "WA", utility, portalUrl: SHARED, createdBy: "test" });
    recipes.savePortalRecipeSteps(db, r.id, [fill(1), { action: "click", selector: { text: program }, note: `application program: ${program}` }, REVIEW], { status: "complete" });
  }
  assert.equal(decide("nem", "WA", "Gamma Rural Electric", SHARED).choice, null);
  // The permit analogue: two AHJs on one host that file DIFFERENT record types for the same
  // discipline — which one is the target's cannot be told, so nobody lends.
  const MGO = "https://www.mygovernmentonline.org/";
  ahjRecipe({ state: "TX", ahj: "City of Amarillo", portalUrl: MGO, discipline: "structural", steps: accelaSteps("Residential Structural - Solar", MGO) });
  ahjRecipe({ state: "TX", ahj: "City of Canyon", portalUrl: MGO, discipline: "structural", steps: accelaSteps("Building - Residential Structural", MGO) });
  ownPortal("TX", "City of Hereford", MGO);
  const d = decide("building", "TX", "City of Hereford", MGO);
  assert.equal(d.choice, null, d.reason);
  assert.match(d.reason, /different record types/);
});

await check("(r5) MUST-EXCLUDE: never across tenants of a path-tenanted host, never across states", () => {
  const CHINO = "https://aca-prod.accela.com/CHINO/";
  ahjRecipe({ state: "CA", ahj: "City of Chino", portalUrl: CHINO, discipline: "structural", steps: accelaSteps("Residential - Structural", CHINO) });
  ownPortal("CA", "City of San Diego", "https://aca-prod.accela.com/SANDIEGO/");
  ownPortal("CA", "City of Ontario", CHINO);
  assert.equal(decide("building", "CA", "City of San Diego", "https://aca-prod.accela.com/SANDIEGO/").choice, null, "another agency's tenant");
  assert.equal(decide("building", "CA", "City of Ontario", CHINO)?.choice?.learnedFor, "City of Chino", "MUST-PASS: the same tenant lends");
  assert.equal(decide("building", "WA", "City of Salem", ACA_OREGON).choice, null, "same host, another state");
});

await check("(r6) MUST-EXCLUDE: no recorded record type, a legacy '' discipline row, a flagged donor, a donor that leaves the portal", () => {
  const PORTAL = "https://permits.county-shared.example/";
  ownPortal("ID", "City of Cascade", PORTAL);
  ahjRecipe({ state: "ID", ahj: "City of Donnelly", portalUrl: PORTAL, discipline: "structural", steps: [fill(1), fill(2), REVIEW] });
  let d = decide("building", "ID", "City of Cascade", PORTAL);
  assert.equal(d.choice, null);
  assert.ok(d.rejected.some((r) => /never recorded which record type/.test(r.why)), JSON.stringify(d.rejected));
  ahjRecipe({ state: "ID", ahj: "City of McCall", portalUrl: PORTAL, discipline: "", steps: accelaSteps("Residential - Structural", PORTAL) });
  assert.equal(decide("building", "ID", "City of Cascade", PORTAL).choice, null, "a legacy '' row never lends");
  const leaves = ahjRecipe({ state: "ID", ahj: "City of New Meadows", portalUrl: PORTAL, discipline: "structural",
    steps: [...accelaSteps("Residential - Structural", PORTAL), { action: "goto", value: "https://elsewhere.example/x", note: "jump" }] });
  d = decide("building", "ID", "City of Cascade", PORTAL);
  assert.ok(d.rejected.some((r) => r.recipeId === leaves.id && /navigates off the portal/.test(r.why)), JSON.stringify(d.rejected));
  // Flagged for a human by the REAL replay-failure door (an unattributable failure keeps + flags).
  const flagged = ahjRecipe({ state: "ID", ahj: "City of Riggins", portalUrl: PORTAL, discipline: "structural", steps: accelaSteps("Residential - Structural", PORTAL) });
  recipes.demoteOnReplayFailure(db, flagged.id, "", flagged.version);
  d = decide("building", "ID", "City of Cascade", PORTAL);
  assert.ok(d.rejected.some((r) => r.recipeId === flagged.id && /flagged/.test(r.why)), JSON.stringify(d.rejected));
  assert.equal(d.choice, null);
});

await check("(r7) the target's own recorded record type wins over a donor's", () => {
  const PORTAL = "https://permits.state-shared.example/";
  ownPortal("NV", "City of Ely", PORTAL);
  ahjRecipe({ state: "NV", ahj: "City of Elko", portalUrl: PORTAL, discipline: "structural", steps: accelaSteps("Residential - Structural", PORTAL) });
  assert.equal(decide("building", "NV", "City of Ely", PORTAL).choice?.learnedFor, "City of Elko", "MUST-PASS with no own record");
  ahjRecipe({ state: "NV", ahj: "City of Ely", portalUrl: PORTAL, discipline: "structural", status: "needs_rerecord", steps: accelaSteps("Solar PV - Structural", PORTAL) });
  assert.equal(decide("building", "NV", "City of Ely", PORTAL).choice, null, "Ely files 'Solar PV - Structural', not Elko's type");
});

// ── end to end: the real prepareSubmission, browser stubbed ──────────────────────────────────
const salemProject = () => fx.newProject({ ahj: "City of Salem", city: "Salem", zip: "97301" });

await check("(s1) a Salem building stage replays the Coos Bay recipe, and the run records and shows whose it was", async () => {
  let replayed: string | null = null;
  fx.stubRunner(async (recipe) => { replayed = recipe.id; return { ok: true, finalSubmitClicked: false, steps: [{ ok: true, message: "reached review" }] }; });
  const projectId = salemProject();
  await repo.prepareSubmission(db, projectId, "building");
  assert.equal(replayed, coosStructural.id, "the Coos Bay structural recipe drove the run");
  const run = fx.latestRun(projectId)!;
  const result = JSON.parse(String(run.result_json));
  assert.equal(result.borrowedRecipe?.recipeId, coosStructural.id);
  assert.equal(result.borrowedRecipe?.learnedFor, "City of Coos Bay");
  assert.equal(result.borrowedRecipe?.recordType, "Residential - Structural");
  assert.ok(fx.audits("portal.recipe_borrowed").some((a) => a.project_id === projectId));
  const project = db.get<{ current_stage: string }>("SELECT current_stage FROM projects WHERE id = ?", [projectId])!;
  assert.match(project.current_stage, /Filled from the City of Coos Bay structural recipe/, "the operator sees it");
});

await check("(s2) heals on Salem's page are NOT written onto the Coos Bay recipe", async () => {
  const before = fx.recipeRow(coosStructural.id);
  fx.stubRunner(async () => ({
    ok: true, finalSubmitClicked: false,
    steps: [{ ok: true, message: "filled", data: { healedSteps: [{ stepIndex: 4, note: "Field 2", action: "fill", selector: { css: "#salem-only" }, performed: true }] } }],
  }));
  const projectId = salemProject();
  await repo.prepareSubmission(db, projectId, "building");
  const after = fx.recipeRow(coosStructural.id);
  assert.equal(after.steps_json, before.steps_json, "the donor's steps are untouched");
  assert.ok(fx.audits("portal.borrowed_recipe_heal_discarded").some((a) => a.project_id === projectId));
});

await check("(s3) drift on Salem's page stops the run and never demotes or flags the Coos Bay recipe", async () => {
  fx.stubRunner(async () => fx.failingStep("Recipe step failed (fill — Field 2): locator.fill: Timeout 15000ms exceeded. waiting for locator('#f2')"));
  const projectId = salemProject();
  await repo.prepareSubmission(db, projectId, "building");
  const row = fx.recipeRow(coosStructural.id);
  assert.equal(row.status, "complete");
  assert.equal(String(row.flag_reason ?? ""), "");
  assert.ok(fx.audits("portal.borrowed_recipe_failed").some((a) => a.project_id === projectId));
  assert.equal(fx.audits("portal_recipe.demoted").filter((a) => JSON.parse(a.details).recipeId === coosStructural.id).length, 0);
  assert.match(String(fx.latestRun(projectId)?.error_message), /was not changed/);
  // MUST-PASS (the control): the SAME failure on Coos Bay's own project would have demoted it.
  assert.equal(recipes.replayFailureBlamesRecipe("Recipe step failed (fill — Field 2): locator.fill: Timeout 15000ms exceeded. waiting for locator('#f2')").attribution, "recipe");
});

await check("(s4) a borrowed recipe never clicks a final submit, even with a named approval", () => {
  const withFinal = [...accelaSteps("Residential - Structural"), { action: "click", selector: { text: "Submit" }, isFinalSubmit: true, note: "final submit" } as RecipeStep];
  const donor = ahjRecipe({ state: "OR", ahj: "City of Newport", portalUrl: ACA_OREGON, discipline: "combo", steps: withFinal });
  const env = { PORTAL_ALLOW_FINAL_SUBMIT: "1" };
  const approval = { approver: "Dana Operator", runId: "run-1" };
  const own = repo.automaticSubmitRefusals(db, { recipeId: donor.id, runApproval: approval, runId: "run-1", env });
  const borrowedRun = repo.automaticSubmitRefusals(db, { recipeId: donor.id, runApproval: approval, runId: "run-1", env, borrowedFrom: "City of Newport" });
  assert.equal(own.some((r) => /borrowed/.test(r)), false, "MUST-PASS: the owner's own run is not refused for borrowing");
  assert.ok(borrowedRun.some((r) => /borrowed recipe always stops at review/.test(r)), JSON.stringify(borrowedRun));
});

finish("shared-portal-reuse");
