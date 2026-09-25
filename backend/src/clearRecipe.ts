// ---------------------------------------------------------------------------
// recipe:clear — invalidate (or delete) a learned portal recipe so the next
// "Prepare Submittal" / auto-learn RE-LEARNS it from scratch instead of replaying
// a stale/buggy recipe. Staging only replays a recipe whose status is "complete",
// so marking it "needs_rerecord" (the default here) is enough to force a fresh
// self-seed while keeping the old row + steps for reference. --delete removes it.
//
// Usage (run from the repo root):
//   npm run recipe:clear -- --list
//   npm run recipe:clear -- --scope utility --state OR --utility "Pacific Power"
//   npm run recipe:clear -- --scope ahj --state OR --ahj "City of Portland"
//   npm run recipe:clear -- --id <recipeId> [--delete]
//   npm run recipe:clear -- --scope utility --utility "PGE" --delete
// ---------------------------------------------------------------------------

import { openDatabase } from "./db";
import {
  listPortalRecipes,
  findAnyRecipeForProject,
  getPortalRecipe,
  markPortalRecipeForRerecord,
  deletePortalRecipe,
} from "./portalRecipes";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const db = await openDatabase();

  if (flag("list")) {
    const all = listPortalRecipes(db);
    if (!all.length) { console.log("No portal recipes recorded."); return; }
    console.log(`Portal recipes (${all.length}):`);
    for (const r of all) {
      console.log(`  ${r.id}  [${r.status}]  scope=${r.scopeType}  state=${r.state || "-"}  ahj=${r.ahj || "-"}  utility=${r.utility || "-"}  url=${r.portalUrl || "-"}`);
    }
    return;
  }

  const hard = flag("delete");
  const id = arg("id");
  let recipe = id ? getPortalRecipe(db, id) : null;

  if (!recipe) {
    const scopeArg = (arg("scope") || "").toLowerCase();
    const scopeType: "ahj" | "utility" = scopeArg === "utility" || scopeArg === "nem" ? "utility" : "ahj";
    const state = arg("state");
    const ahj = arg("ahj");
    const utility = arg("utility");
    if (!ahj && !utility) {
      console.error("Specify a recipe to clear: --id <id>, or --scope ahj --ahj <name> [--state XX], or --scope utility --utility <name>. Use --list to see them.");
      process.exit(2);
    }
    recipe = findAnyRecipeForProject(db, { scopeType, state, ahj, utility });
    if (!recipe) {
      console.error(`No recipe found for scope=${scopeType} state=${state || "-"} ahj=${ahj || "-"} utility=${utility || "-"}. Use --list.`);
      process.exit(1);
    }
  }

  const desc = `${recipe.id} [${recipe.status}] scope=${recipe.scopeType} ahj=${recipe.ahj || "-"} utility=${recipe.utility || "-"}`;
  if (hard) {
    deletePortalRecipe(db, recipe.id);
    console.log(`DELETED recipe ${desc}. The next stage will self-seed a fresh recipe.`);
  } else {
    markPortalRecipeForRerecord(db, recipe.id, { actor: "recipe:clear CLI", reason: "invalidated from the command line" });
    console.log(`Invalidated (status -> needs_rerecord) recipe ${desc}. The next stage will RE-LEARN it. (Use --delete to remove the row entirely.)`);
  }
}

main().catch((err) => {
  console.error("recipe:clear failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
