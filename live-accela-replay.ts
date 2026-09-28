// LIVE REPLAY of a recorded AHJ (permit) recipe — and the experiment that decides the
// economics of Accela: Oregon ePermitting is ONE portal serving MANY jurisdictions, but
// recipes are keyed PER AHJ (or|city of coos bay|pacific power). If a recipe learned for
// one city replays for another — the jurisdiction is chosen by the ADDRESS SEARCH, not a
// hardcoded step — then one learn covers every Oregon ePermitting city instead of 100+.
//
//   npx tsx live-accela-replay.ts <projectId> [--discipline structural|electrical]
//   npx tsx live-accela-replay.ts <projectId> --recipe <recipeIdPrefix>   # force cross-AHJ
//
// Stops at review. Never submits, never pays. Delete this file after the session.
import "dotenv/config";
import path from "node:path";

const { openDatabase } = await import("./backend/src/db");
const { findCompleteRecipeForProject, resolveRecipeFieldValues, getPortalRecipe } = await import("./backend/src/portalRecipes");
const { getDecryptedCredentialByUrl } = await import("./backend/src/portalCredentials");
const { clientStagingOverlay } = await import("./backend/src/clients");
const { projectDocsByType } = await import("./backend/src/projectDocuments");
const { getProjectDetail } = await import("./backend/src/repository");
const { stageWithRecipe } = await import("./portal-bot/src/index");

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const projectId = argv.filter((a) => !a.startsWith("--"))[0];
const discipline = flag("discipline") || "structural";
const forceRecipe = flag("recipe");
if (!projectId) { console.error("pass a projectId"); process.exit(2); }

const db = await openDatabase();
const detail = getProjectDetail(db, projectId, null);
const project = detail.project;
const portalType = "oregon_epermitting_accela";

let recipe = forceRecipe
  ? getPortalRecipe(db, db.get<{ id: string }>("SELECT id FROM portal_recipes WHERE id LIKE ?", [`${forceRecipe}%`])!.id)
  : findCompleteRecipeForProject(db, { scopeType: "ahj", state: project.state, ahj: project.ahj, utility: project.utility, discipline });
if (!recipe) {
  console.error(`no COMPLETE ${discipline} recipe for ${project.ahj} (${project.state}).`);
  console.error(`This AHJ has never been learned. Either learn it, or pass --recipe <id> to test whether`);
  console.error(`another jurisdiction's recipe generalises (the Oregon ePermitting question).`);
  process.exit(1);
}

const licenceTrack = discipline === "electrical" ? "electrical" : "building";
const overlay = clientStagingOverlay(db, project.clientId, portalType, { state: String(project.state ?? ""), track: licenceTrack });
const stagedProject = Object.keys(overlay).length > 0
  ? { ...project, parserSnapshot: { ...project.parserSnapshot, ...overlay } }
  : project;
const fieldValues = resolveRecipeFieldValues(db, stagedProject, portalType, licenceTrack);
const docsByType = projectDocsByType(db, projectId);
const credential = project.clientId
  ? (getDecryptedCredentialByUrl(db, project.clientId, recipe.portalUrl) ?? undefined)
  : undefined;
const profileBase = process.env.PORTAL_PROFILES_DIR || path.join(process.cwd(), "portal-profiles");
const userDataDir = project.clientId ? path.join(profileBase, project.clientId, portalType) : path.join(profileBase, portalType);

let gapFillPlanner; let gapFillFields;
try {
  const { buildPortalPlanner } = await import("./backend/src/autoLearn");
  const built = buildPortalPlanner(db, stagedProject, { portalType, scopeType: "ahj", permitType: discipline === "electrical" ? "electrical" : "structural" });
  gapFillPlanner = built.planner; gapFillFields = built.projectFields;
} catch { /* stage with recorded fills only */ }

const crossAhj = String(recipe.ahj || "").toLowerCase() !== String(project.ahj || "").toLowerCase();
console.log(`=== LIVE ACCELA REPLAY (${discipline}) ===`);
console.log(`recipe   ${recipe.id.slice(0, 8)} v${recipe.version} — ${recipe.steps.length} steps, learned for ${JSON.stringify(recipe.ahj)}`);
console.log(`project  ${project.homeownerName} — ${project.projectAddress}`);
console.log(`ahj      ${JSON.stringify(project.ahj)}${crossAhj ? "   <== CROSS-JURISDICTION TEST (recipe learned for a DIFFERENT city)" : ""}`);
console.log(`portal   ${recipe.portalUrl}`);
console.log(`docs     ${Object.keys(docsByType).length} split doc(s); credential ${credential ? "resolved" : "NOT FOUND"}; gapfill ${gapFillPlanner ? "on" : "off"}`);
console.log("Stops at review. Never submits, never pays.\n");

const t0 = Date.now();
const result = await stageWithRecipe(recipe, stagedProject, fieldValues, docsByType, [], {
  headless: false, credential, userDataDir, loginUrl: recipe.portalUrl, gapFillPlanner, gapFillFields,
}) as Record<string, unknown>;
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const steps = (result.steps as Array<{ ok?: boolean; message?: string; note?: string; data?: Record<string, unknown> }> | undefined) ?? [];
const d = (steps.find((x) => x.data && ("executed" in (x.data ?? {}) || "skipped" in (x.data ?? {})))?.data)
  ?? (steps.find((x) => x.ok === false && x.data)?.data) ?? ((result.data as Record<string, unknown>) ?? result);
console.log("=== RESULT ===");
console.log(JSON.stringify({
  ok: result.ok, pauseReason: result.pauseReason, finalSubmitClicked: result.finalSubmitClicked,
  elapsedSeconds: Number(elapsed), crossJurisdiction: crossAhj,
  recipeStepsExecuted: d.executed, recipeStepsSkipped: ((d.skipped as unknown[]) ?? []).length,
  failedStepIndex: d.failedStepIndex, driftWarnings: ((d.driftWarnings as unknown[]) ?? []).length,
}, null, 1));
const trace = (d.trace as Array<{ i: number; action: string; note: string; outcome: string; page: string; resolved?: string }> | undefined) ?? [];
if (trace.length) {
  console.log("\nstep trace:");
  let last = "";
  for (const t of trace) {
    const mark = t.page && t.page !== last ? `  << ${t.page}` : "";
    if (t.page) last = t.page;
    if (t.outcome !== "ok" || mark) console.log(`  ${String(t.i).padStart(3)} ${t.action.padEnd(7)} ${t.outcome.padEnd(8)} ${t.note.padEnd(46)}${mark}`);
    if (t.resolved) console.log(`      resolved to: ${t.resolved}`);
  }
}
for (const [label, key] of [["skipped", "skipped"], ["self-repairs", "driftWarnings"]] as const) {
  const list = (d[key] as string[] | undefined) ?? [];
  if (list.length) { console.log(`\n${label} (${list.length}):`); for (const x of list.slice(0, 20)) console.log(`  - ${String(x).slice(0, 118)}`); }
}
for (const f of steps.filter((s) => s.ok === false)) console.log(`\nFAILED: ${String(f.message ?? "").slice(0, 700)}`);
process.exit(result.ok === true ? 0 : 1);
