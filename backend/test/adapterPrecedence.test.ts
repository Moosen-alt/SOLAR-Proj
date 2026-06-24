// Adapter-selection precedence (the recipe-first inversion). Asserts the pure
// selectAdapterActor() that prepareSubmission() routes on, so the hybrid contract is
// pinned: a recorded recipe is the FIRST-LINE adapter for EVERY portal (including PGE
// PowerClerk NEM and Accela), and the hand-coded adapters remain the FALLBACK when no
// recipe exists. Extracting the ternary into selectAdapterActor() keeps this test and the
// live dispatch from drifting apart. Browser-free. Run: tsx backend/test/adapterPrecedence.test.ts
import assert from "node:assert/strict";
import { selectAdapterActor } from "../src/repository";

// [hasRecipe, isAccela, isPowerClerk] -> expected adapter actor name.
const cases: Array<[boolean, boolean, boolean, string, string]> = [
  // Recipe present → universal replay leads, regardless of the platform flags.
  [true, false, true, "RecipeAdapter", "recipe + PowerClerk → recipe leads (NEM inversion)"],
  [true, true, false, "RecipeAdapter", "recipe + Accela → recipe leads"],
  [true, false, false, "RecipeAdapter", "recipe + generic portal → recipe"],
  [true, true, true, "RecipeAdapter", "recipe wins even if both platform flags are set"],
  // No recipe → fall back to the maintained hand-coded adapter for the platform.
  [false, false, true, "PowerClerkAdapter", "no recipe + PowerClerk → hand-coded fallback"],
  [false, true, false, "OregonEPermittingAdapter", "no recipe + Accela → hand-coded fallback"],
  // No recipe, no recognized platform → mock.
  [false, false, false, "MockPortalAdapter", "no recipe + unknown platform → mock"],
];

let failures = 0;
for (const [hasRecipe, isAccela, isPowerClerk, expected, label] of cases) {
  try {
    const actual = selectAdapterActor(hasRecipe, isAccela, isPowerClerk);
    assert.equal(actual, expected, `expected ${expected}, got ${actual}`);
    console.log(`  ok   - ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}`);
    console.error(`         ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (failures) {
  console.error(`\n${failures} precedence test(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} adapter-precedence tests passed.`);
