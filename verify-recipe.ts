// POST-LEARN VERIFICATION. Before replaying a freshly learned recipe, prove three things —
// otherwise a replay can silently test the OLD recipe while you believe you are testing the
// new one (protectComplete keeps the existing row when a learn comes out `draft`).
//
//   npx tsx verify-recipe.ts <recipeIdPrefix> <projectIdPrefix>
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const [recipeArg, projectArg] = process.argv.slice(2);
if (!recipeArg || !projectArg) { console.error("usage: verify-recipe.ts <recipeIdPrefix> <projectIdPrefix>"); process.exit(2); }

const { openDatabase } = await import("./backend/src/db");
const { getPortalRecipe, resolveRecipeFieldValues, deadFieldBindings } = await import("./backend/src/portalRecipes");
const { getProjectDetail } = await import("./backend/src/repository");

const db = await openDatabase();
const row = db.get<{ id: string; status: string; version: number; profile_key: string; utility: string; ahj: string }>(
  "SELECT id, status, version, profile_key, utility, ahj FROM portal_recipes WHERE id LIKE ?", [`${recipeArg}%`]);
if (!row) { console.error(`no recipe ${recipeArg}`); process.exit(1); }
const recipe = getPortalRecipe(db, row.id);
const project = getProjectDetail(db, db.get<{ id: string }>("SELECT id FROM projects WHERE id LIKE ?", [`${projectArg}%`])!.id, null).project;
const replayFields = resolveRecipeFieldValues(db, project, "powerclerk");

console.log(`recipe   ${row.id.slice(0, 8)} v${row.version}  status=${row.status}  ${recipe.steps.length} steps  key=${row.profile_key}`);
console.log(`learned against ${project.homeownerName}\n`);

let bad = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { bad++; console.error(`  FAIL - ${label}${detail ? `\n         ${detail}` : ""}`); }
};

// 1) Is it actually trusted/complete? A `draft` means protectComplete kept the OLD recipe.
check(`recipe is complete/trusted (status=${row.status})`, row.status === "complete");

// 2) No step can be dead on replay.
const dead = deadFieldBindings(recipe.steps, replayFields);
check(`no step binds a field the replay cannot resolve`, dead.length === 0, dead.join("; "));

// 3) No select recorded with neither a field nor a value — it can never fill.
const emptySelects = recipe.steps
  .map((s, i) => ({ s, i }))
  .filter(({ s }) => (s.action === "select" || s.action === "fill") && !s.field && !String(s.value ?? "").trim() && !s.sensitive)
  .map(({ s, i }) => `#${i} ${String(s.note ?? s.action).slice(0, 44)}`);
check(`no fill/select recorded with neither a binding nor a value`, emptySelects.length === 0, emptySelects.join("; "));

// 4) Selectors that cannot survive a new project: raw per-render ids with no fallback.
const fragile = recipe.steps
  .map((s, i) => ({ s, i }))
  .filter(({ s }) => {
    const css = String(s.selector?.css ?? "");
    const hasAlt = Boolean(s.selector?.label || s.selector?.role || s.selector?.placeholder || (s.selector?.fallbacks ?? []).length);
    return /^#[A-Za-z0-9]+(Input(_\d+)?)?$/.test(css) && !hasAlt;
  })
  .map(({ s, i }) => `#${i} ${String(s.selector?.css)} (${String(s.note ?? "").slice(0, 32)})`);
check(`no step relies on a per-render id with no label/role fallback`, fragile.length === 0, fragile.slice(0, 6).join("; "));

// 5) Did the new bindableFields guard actually fire during this learn? Proof the mechanism
//    runs live, which no unit test exercises.
const runs = fs.existsSync("data/learn-runs") ? fs.readdirSync("data/learn-runs").sort().reverse() : [];
let refused = 0; let bundle = "";
for (const r of runs.slice(0, 3)) {
  const ev = path.join("data/learn-runs", r, "events.jsonl");
  if (!fs.existsSync(ev)) continue;
  const hits = fs.readFileSync(ev, "utf8").split("\n").filter((l) => l.includes("unbindable_field_refused"));
  if (hits.length) { refused = hits.length; bundle = r; break; }
}
console.log(`  info - bindableFields guard fired ${refused} time(s)${bundle ? ` in ${bundle}` : ""} (0 is fine — it only fires when the planner picks an unresolvable key)`);

console.log(`\nbound fields (${new Set(recipe.steps.filter((s) => s.field).map((s) => s.field)).size}): ` +
  [...new Set(recipe.steps.filter((s) => s.field).map((s) => s.field))].sort().join(", "));
db.close();
if (bad) { console.error(`\n${bad} precondition(s) FAILED — replaying this recipe would not prove what you think.`); process.exit(1); }
console.log("\nAll preconditions met — this recipe is worth replaying against a different project.");
process.exit(0);
