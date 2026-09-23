// DEMO RUNNER — a VISIBLE browser replaying a learned portal recipe, for screen recording.
//
// Opens a real Chrome window and files a real application on a real utility portal from a
// recorded recipe: no LLM in the loop, every field bound from project data. It stops at the
// review screen and NEVER clicks submit (safety rule 1), which is itself the point worth
// showing — the machine does the typing, a human signs off.
//
//   npm run demo:replay -- <target>        one window
//   npm run demo:replay -- list            what is available
//
// Targets are recipes that have been learned AND verified against the portal.
// Each run creates a new draft application on that portal — fine for a demo, worth
// clearing afterwards.
import path from "node:path";
import url from "node:url";
import type { PortalRecipe } from "../../shared/src/types";

const CLIENT = "tml-international-llc";

// Every target is an interconnection (NEM) filing, so it may only ever resolve a UTILITY recipe.
// Rule 5: a permit track never resolves a utility portal and vice versa. Matching on
// `r.utility || r.ahj` let "pacificorp" pick an AHJ PERMIT recipe (an Accela recipe whose
// utility column names Pacific Power, because the profile key carries the project's utility)
// and replay it against a real homeowner's project as if it were the NEM filing.
export interface DemoTarget { key: string; title: string; blurb: string; projectId: string; scope: "utility"; match: (utility: string) => boolean }
type Target = DemoTarget;

/** The recipe a demo target replays: COMPLETE, of the target's own scope (track), matched on
 *  the column that scope is keyed by. A utility target never sees an AHJ recipe, whatever its
 *  utility column says — and never falls back to matching the AHJ name. */
export function pickDemoRecipe(
  recipes: Array<Pick<PortalRecipe, "scopeType" | "utility" | "ahj" | "status">>,
  target: Pick<DemoTarget, "scope" | "match">,
): number {
  return recipes.findIndex((r) =>
    r.status === "complete" && r.scopeType === target.scope && target.match(r.utility || ""));
}

export const TARGETS: Target[] = [
  {
    key: "ameren", title: "Ameren Illinois — interconnection (NEM)",
    blurb: "61 recorded steps: terms, application level, applicant, account number, installer, generator specs, acknowledgements, DocuSign.",
    projectId: "il-test-ameren", scope: "utility", match: (u) => /ameren/i.test(u),
  },
  {
    key: "pge", title: "Portland General Electric — net metering",
    blurb: "A proven PGE NEM recipe replayed against a real Oregon project.",
    projectId: "8f4ca8dd", scope: "utility", match: (u) => /portland general|pge/i.test(u),
  },
  {
    key: "pacificorp", title: "Pacific Power (PacifiCorp) — net metering",
    blurb: "A proven PacifiCorp NEM recipe replayed against a real Oregon project.",
    projectId: "b0ab5169", scope: "utility", match: (u) => /pacific power|pacificorp/i.test(u),
  },
];

const bar = (s: string) => console.log(`\n${"═".repeat(74)}\n${s}\n${"═".repeat(74)}`);

async function main(): Promise<void> {
  // Loaded here, not at module top, so importing pickDemoRecipe (tests) reads no .env.
  await import("dotenv/config");
  process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";
  const key = (process.argv[2] || "").toLowerCase();
  const { openDatabase } = await import("../../backend/src/db");
  const { getProjectDetail } = await import("../../backend/src/repository");
  const { listPortalRecipes, resolveRecipeFieldValues } = await import("../../backend/src/portalRecipes");
  const { getDecryptedCredentialByUrl } = await import("../../backend/src/portalCredentials");
  const { stageWithRecipe } = await import("./index");
  const db = await openDatabase();

  const recipes = listPortalRecipes(db).filter((r) => r.status === "complete");
  if (!key || key === "list") {
    console.log("\nAvailable demos (learned + verified recipes):\n");
    for (const t of TARGETS) {
      const r = recipes[pickDemoRecipe(recipes, t)];
      console.log(`  ${t.key.padEnd(12)} ${r ? `${String(r.steps.length).padStart(3)} steps` : "  (no recipe)"}  ${t.title}`);
    }
    console.log("\n  npm run demo:replay -- ameren\n");
    return;
  }

  const t = TARGETS.find((x) => x.key === key);
  if (!t) { console.error(`Unknown demo "${key}". Try: ${TARGETS.map((x) => x.key).join(", ")}`); return; }
  const recipe = recipes[pickDemoRecipe(recipes, t)];
  if (!recipe) { console.error(`No complete ${t.scope} (NEM) recipe for ${t.key} yet — learn that portal first.`); return; }

  const row = db.get<{ id: string }>("SELECT id FROM projects WHERE id LIKE ?", [`${t.projectId}%`]);
  if (!row) { console.error(`Demo project ${t.projectId} not found.`); return; }
  const detail = getProjectDetail(db, row.id);
  const scope = recipe.scopeType === "utility" ? "utility" : "AHJ";
  const fieldValues = resolveRecipeFieldValues(db, detail.project, scope);
  const cred = getDecryptedCredentialByUrl(db, CLIENT, recipe.portalUrl || "") ?? undefined;

  bar(`▶  ${t.title}`);
  console.log(t.blurb);
  console.log(`\n   portal      ${recipe.portalUrl}`);
  console.log(`   project     ${detail.project.homeownerName} — ${detail.project.projectAddress}, ${detail.project.city} ${detail.project.state}`);
  console.log(`   system      ${detail.project.systemSizeDcKw} kW DC`);
  console.log(`   recipe      ${recipe.steps.length} recorded steps, v${recipe.version}`);
  console.log(`   data bound  ${Object.keys(fieldValues).length} project fields`);
  console.log(`\n   The browser window is about to open. Nothing is submitted.\n`);

  const started = Date.now();
  const result = await stageWithRecipe(recipe, detail.project, fieldValues, {}, [], {
    credential: cred,
    headless: false,              // VISIBLE — this is the whole point
    autoSubmit: false,            // never submits
    userDataDir: path.join(process.cwd(), "portal-profiles", CLIENT, `demo_${t.key}`),
  } as never).catch((e) => { console.error(`\n   run error: ${(e as Error).message.slice(0, 200)}`); return null; });

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  if (!result) return;
  const r = result as Record<string, unknown>;
  const steps = (r.steps as Array<Record<string, unknown>> | undefined) ?? [];
  const detailStep = steps.find((s) => typeof s.message === "string" && /Replayed \d+ recorded step/.test(String(s.message)));
  const executed = (detailStep?.data as { executed?: number } | undefined)?.executed ?? 0;
  const failedSteps = steps.filter((s) => s.ok === false);

  bar(`✔  ${t.title}`);
  console.log(`   ${executed} steps replayed in ${secs}s${failedSteps.length ? ` — ${failedSteps.length} failed` : " — no failures"}`);
  console.log(`   final submit: ${r.finalSubmitClicked ? "CLICKED (unexpected!)" : "recorded, NOT clicked — waiting for a human"}`);
  console.log(`   ${String((steps[steps.length - 1]?.message ?? "")).slice(0, 200)}`);
  for (const f of failedSteps.slice(0, 6)) console.log(`   ! ${String(f.message ?? "").slice(0, 160)}`);
  console.log("");
}

// Run only as a script (`npm run demo:replay`), so pickDemoRecipe can be imported by a test
// without opening a database or a browser.
const samePath = (a: string, b: string): boolean =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; // Windows paths are case-insensitive
const invokedDirectly = Boolean(process.argv[1]) && samePath(path.resolve(process.argv[1]), url.fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
