// One-off driver: LIVE REPLAY of a trusted NEM recipe — the deterministic path that runs
// for every project once a portal is learned. No planner calls, no learning, no writes to
// the recipe. Mirrors what repository.ts assembles for the production RecipeAdapter path
// (credential, per-client browser profile, login URL, client licensing overlay, split
// docs), minus the submission bookkeeping, so a watched run creates no project state.
//
// autoSubmit is NEVER passed: the replay stops at the review screen exactly like staging.
//
//   npx tsx live-nem-replay.ts pge [projectId]
//   npx tsx live-nem-replay.ts pacificorp [projectId]
//
// Delete this file after the session.
import "dotenv/config";
import path from "node:path";

const { openDatabase } = await import("./backend/src/db");
const { findCompleteRecipeForProject, resolveRecipeFieldValues } = await import("./backend/src/portalRecipes");
const { getDecryptedCredentialByUrl } = await import("./backend/src/portalCredentials");
const { clientStagingOverlay } = await import("./backend/src/clients");
const { projectDocsByType } = await import("./backend/src/projectDocuments");
const { getProjectDetail } = await import("./backend/src/repository");
const { stageWithRecipe } = await import("./portal-bot/src/index");

const which = (process.argv[2] || "pge").toLowerCase();
const DEFAULT_PROJECT: Record<string, string> = {
  pge: "cf1c56aa-aeb0-44d5-b797-f663436463a7",         // Daniel Daly, Salem
  pacificorp: "9c63ae75-45b5-473f-a4ea-794fb973586d",  // Wynema Wright, Coos Bay
};
const projectId = process.argv[3] || DEFAULT_PROJECT[which];
if (!projectId) {
  console.error(`unknown target ${JSON.stringify(which)} — use "pge" or "pacificorp", or pass a project id`);
  process.exit(2);
}

const db = await openDatabase();
const detail = getProjectDetail(db, projectId, null);
const project = detail.project;
const portalType = which === "pacificorp" ? "powerclerk_pacificorp_nem_portal" : "powerclerk_pge_nem_portal";

// The SAME lookup staging uses — utility-scoped, so a permit recipe can never be picked up.
const recipe = findCompleteRecipeForProject(db, {
  scopeType: "utility", state: project.state, utility: project.utility, discipline: "",
});
if (!recipe) {
  console.error(`no COMPLETE utility recipe for ${project.utility} (${project.state}) — nothing to replay.`);
  process.exit(1);
}

// Client licensing overlay, exactly as staging applies it, so the contractor identity that
// replays is the authoritative one rather than whatever the plan set said.
const overlay = clientStagingOverlay(db, project.clientId, portalType);
const stagedProject = Object.keys(overlay).length > 0
  ? { ...project, parserSnapshot: { ...project.parserSnapshot, ...overlay } }
  : project;

const fieldValues = resolveRecipeFieldValues(db, stagedProject, portalType);
const docsByType = projectDocsByType(db, projectId);
const credential = project.clientId
  ? (getDecryptedCredentialByUrl(db, project.clientId, recipe.portalUrl) ?? undefined)
  : undefined;
const profileBase = process.env.PORTAL_PROFILES_DIR || path.join(process.cwd(), "portal-profiles");
const userDataDir = project.clientId
  ? path.join(profileBase, project.clientId, portalType)
  : path.join(profileBase, portalType);

console.log(`=== LIVE REPLAY: ${project.utility} ===`);
console.log(`recipe   ${recipe.id.slice(0, 8)} v${recipe.version} — ${recipe.steps.length} steps, ${recipe.status}`);
console.log(`project  ${project.homeownerName} — ${project.projectAddress}`);
console.log(`portal   ${recipe.portalUrl}`);
console.log(`bound    ${new Set(recipe.steps.filter((s) => s.field).map((s) => s.field)).size} field(s); credential ${credential ? "resolved" : "NOT FOUND"}; ${Object.keys(docsByType).length} split doc(s)`);
console.log("Deterministic replay — no planner calls. Stops at the review screen; never submits.\n");

// LLM GAP-FILL, exactly as repository.ts supplies it to the production replay path. Without
// it this driver was testing a WEAKER replay than production actually runs: RecipeAdapter
// calls runGapFill after each page's fills, and that is what covers a required field the
// recorded steps missed (a portal that renders a different spec template for this project,
// a control the recipe's selector no longer reaches). Secrets are stripped inside
// buildPortalPlanner and never reach the model.
let gapFillPlanner;
let gapFillFields;
try {
  const { buildPortalPlanner } = await import("./backend/src/autoLearn");
  const built = buildPortalPlanner(db, stagedProject, { portalType, scopeType: "utility" });
  gapFillPlanner = built.planner;
  gapFillFields = built.projectFields;
} catch (err) {
  console.log(`(no gap-fill planner: ${err instanceof Error ? err.message : String(err)})`);
}
console.log(`gapfill  ${gapFillPlanner ? `enabled (${Object.keys(gapFillFields ?? {}).length} project fields)` : "NOT available"}`);

const t0 = Date.now();
const result = await stageWithRecipe(recipe, stagedProject, fieldValues, docsByType, [], {
  headless: false, // operator convention: headed, browser left open at review
  credential,
  userDataDir,
  loginUrl: recipe.portalUrl,
  gapFillPlanner,
  gapFillFields,
}) as Record<string, unknown>;
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

// stageWithRecipe returns the runner's summary; the RecipeAdapter's own counters ride in
// `data` on the failing step result.
const data = (result.data as Record<string, unknown> | undefined) ?? result;
const steps = (result.steps as Array<{ ok?: boolean; message?: string; note?: string; data?: Record<string, unknown> }> | undefined) ?? [];
const detailData = (steps.find((x) => x.ok === false && x.data)?.data) ?? data;
const failed = steps.filter((s) => s.ok === false);
console.log("=== RESULT ===");
console.log(JSON.stringify({
  ok: result.ok,
  pauseReason: result.pauseReason,
  finalSubmitClicked: result.finalSubmitClicked,
  elapsedSeconds: Number(elapsed),
  stepsRun: steps.length,
  stepsFailed: failed.length,
  // A recipe step whose selector does not resolve is SKIPPED, not failed — so a replay can
  // march through most of a 99-step recipe doing nothing at all and only surface when an
  // upload (which throws) is reached. These two counts are the real health signal.
  recipeStepsExecuted: detailData.executed,
  recipeStepsSkipped: ((detailData.skipped as unknown[]) ?? []).length,
  failedStepIndex: detailData.failedStepIndex,
  healedSteps: ((detailData.healedSteps as unknown[]) ?? []).length,
  driftWarnings: ((detailData.driftWarnings as unknown[]) ?? []).length,
  message: String(result.message || "").slice(0, 1200),
}, null, 1));
const trace = (detailData.trace as Array<{ i: number; action: string; note: string; outcome: string; page: string; resolved?: string; shot?: string }> | undefined) ?? [];
if (trace.length) {
  console.log("\nstep trace (step -> the wizard page it acted on):");
  let lastPage = "";
  for (const t of trace) {
    const marker = t.page && t.page !== lastPage ? `  << ${t.page}` : "";
    if (t.page) lastPage = t.page;
    if (t.outcome !== "ok" || marker) {
      console.log(`  ${String(t.i).padStart(3)} ${t.action.padEnd(7)} ${t.outcome.padEnd(8)} ${t.note.padEnd(52)}${marker}`);
      if (t.resolved) console.log(`      resolved to: ${t.resolved}`);
      if (t.shot) console.log(`      page:${t.shot}`);
    }
  }
}
const drift = (detailData.driftWarnings as string[] | undefined) ?? [];
if (drift.length) {
  console.log(`
self-repairs applied (${drift.length}):`);
  for (const d of drift) console.log(`  - ${String(d).slice(0, 120)}`);
}
const skippedNotes = (detailData.skipped as string[] | undefined) ?? [];
if (skippedNotes.length) {
  console.log(`\nskipped steps (${skippedNotes.length}) — these did NOTHING on the live portal:`);
  for (const sk of skippedNotes.slice(0, 30)) console.log(`  - ${String(sk).slice(0, 110)}`);
  if (skippedNotes.length > 30) console.log(`  … and ${skippedNotes.length - 30} more`);
}
if (failed.length) {
  console.log("\nfailed steps:");
  // Print the failure message WHOLE — it now carries the page context (url, title, the
  // portal's own visible controls, screenshot path) that makes a live failure diagnosable.
  for (const f of failed.slice(0, 20)) {
    console.log(`  - ${String(f.note ?? "(step)")}`);
    console.log(`    ${String(f.message ?? "").split("\n").join("\n    ")}`);
  }
}
process.exit(result.ok === true ? 0 : 1);
