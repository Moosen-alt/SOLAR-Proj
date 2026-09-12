// ---------------------------------------------------------------------------
// recipe:bind-fee-brackets — bind an ALREADY-RECORDED fee-bracket box to the
// bracket it is asking about, without re-learning the portal.
//
// The binding pass that does this (convertLiteralsToBoundFields) runs at LEARN
// time, and the recipe with the bug in it — City of Coos Bay ELECTRICAL, 53
// steps, profile_key "or|city of coos bay|pacific power" — was recorded before
// the pass knew about fee brackets. Re-recording a 53-step Accela permit
// application to fix one text box is not a repair an operator should have to
// make, and every re-record spends a real portal session. So the same
// deterministic pass is applied to the stored steps in place.
//
// It is NOT idempotent-by-luck: a step that already carries a field binding is
// skipped by the pass (it only converts unbound literals), and the literal is
// deliberately KEPT on the ones it does convert, so running this twice changes
// nothing the second time and a recipe it has touched still replays exactly as
// before on any project whose jurisdiction has no fee schedule on file.
//
// Usage (from the repo root):
//   npm run recipe:bind-fee-brackets -- --list
//   npm run recipe:bind-fee-brackets -- --id <recipeId> [--apply]
//   npm run recipe:bind-fee-brackets -- --all [--apply]
//
// DRY RUN BY DEFAULT. Without --apply it prints what it would bind and writes
// nothing: a pass that edits shared recipes (portal_recipes is pooled across
// every tenant — CLAUDE.md) should have to be asked twice.
// ---------------------------------------------------------------------------

import type { RecipeStep } from "../../shared/src/types";
import { openDatabase } from "./db";
import { feeBracketFieldForLabel } from "./feeBracketFields";
import { getPortalRecipe, listPortalRecipes, savePortalRecipeSteps, upsertRecipeNote } from "./portalRecipes";
import type { PortalRecipeStatus } from "../../shared/src/types";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export interface BracketBindPlan {
  /** Index of the step in the recipe, so an operator can find it. */
  index: number;
  label: string;
  value: string;
  field: string;
}

/** What this pass WOULD do to one recipe's steps. Pure, so the dry run and the
 *  write can never describe two different things. */
export function planFeeBracketBindings(steps: RecipeStep[]): BracketBindPlan[] {
  const out: BracketBindPlan[] = [];
  (steps ?? []).forEach((step, index) => {
    if (step.action !== "fill") return;
    // Already bound (by an earlier run of this pass, or by a learn that knew
    // about brackets) — leave it exactly as it is.
    if (step.field) return;
    if (!String(step.value ?? "").trim()) return;
    if (step.sensitive) return;
    const label = `${step.selector?.label ?? ""} ${step.note ?? ""}`;
    const field = feeBracketFieldForLabel(label);
    if (!field) return;
    out.push({ index, label: String(step.selector?.label ?? step.note ?? "").trim(), value: String(step.value), field });
  });
  return out;
}

/** Apply the plan. The literal is KEPT — see convertLiteralsToBoundFields: the
 *  kept literal is the fallback for a project whose jurisdiction has no stored
 *  fee schedule, and dropping it would turn "no schedule on file" into a blank
 *  fee box. */
export function applyFeeBracketBindings(steps: RecipeStep[], plan: BracketBindPlan[]): RecipeStep[] {
  const byIndex = new Map(plan.map((p) => [p.index, p.field]));
  return (steps ?? []).map((step, index) => {
    const field = byIndex.get(index);
    return field ? { ...step, field } : step;
  });
}

async function main(): Promise<void> {
  const db = await openDatabase();
  const apply = flag("apply");
  const recipes = flag("all")
    ? listPortalRecipes(db)
    : (arg("id") ? [getPortalRecipe(db, String(arg("id")))] : []);

  if (flag("list") || !recipes.length) {
    const all = listPortalRecipes(db);
    console.log(`Portal recipes (${all.length}) — pass --id <recipeId> or --all:`);
    for (const r of all) {
      const plan = planFeeBracketBindings(getPortalRecipe(db, r.id).steps);
      console.log(
        `  ${r.id}  [${r.status}]  ${r.state || "-"} / ${r.ahj || r.utility || "-"}`
        + `  discipline=${r.discipline || "-"}  steps=${(r.steps ?? []).length}`
        + `  fee-bracket boxes bindable: ${plan.length}`,
      );
    }
    return;
  }

  let touched = 0;
  for (const recipe of recipes) {
    const full = getPortalRecipe(db, recipe.id);
    const plan = planFeeBracketBindings(full.steps);
    if (!plan.length) continue;
    console.log(`\n${full.id}  ${full.state || "-"} / ${full.ahj || full.utility || "-"}  (${full.discipline || "no discipline"})`);
    for (const p of plan) {
      console.log(`  step ${p.index}: "${p.label}"`);
      console.log(`      recorded literal ${JSON.stringify(p.value)}  ->  field ${p.field} (literal kept as the no-schedule fallback)`);
    }
    if (!apply) continue;
    const next = applyFeeBracketBindings(full.steps, plan);
    // savePortalRecipeSteps REPLACES the notes body with whatever it is handed
    // (`options.notes || current.notes`), and a recipe's notes carry the failure
    // taxonomy everything downstream reasons from — so the new segment is
    // upserted into the existing ones, never written over them.
    savePortalRecipeSteps(db, full.id, next, {
      status: full.status as PortalRecipeStatus,
      notes: upsertRecipeNote(
        full.notes,
        "fee-brackets",
        `[fee-brackets] bound ${plan.length} fee-bracket quantity box(es) to feeBracketQuantity:* — the recorded quantity was the learn project's bracket`,
      ),
    });
    touched++;
  }

  console.log(apply
    ? `\nBound fee-bracket boxes in ${touched} recipe(s).`
    : "\nDry run — nothing written. Re-run with --apply to bind these.");
}

// Only run the CLI when this file IS the entry point; the two pure functions
// above are imported by the unit test.
const invokedDirectly = process.argv[1] ? process.argv[1].replace(/\\/g, "/").endsWith("bindFeeBrackets.ts") : false;
if (invokedDirectly) void main();
