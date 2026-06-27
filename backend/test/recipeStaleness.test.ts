// recipeStructureSignature: a structural fingerprint that is stable across filled
// VALUES but changes when the step structure (action / selector / field) drifts.
// Browser-free. Run: tsx backend/test/recipeStaleness.test.ts
import assert from "node:assert/strict";
import type { RecipeStep } from "../../shared/src/types";
import { recipeStructureSignature } from "../src/portalRecipes";

let failures = 0;
const run = (label: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ok   - ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`);
  }
};

const base: RecipeStep[] = [
  { action: "fill", selector: { name: "owner_name" }, field: "homeownerName", value: "Jane Doe" },
  { action: "select", selector: { name: "utility" }, field: "utility", value: "PGE" },
  { action: "click", selector: { text: "Continue" } },
];

run("identical structure → identical signature", () => {
  assert.equal(recipeStructureSignature(base), recipeStructureSignature([...base.map((s) => ({ ...s }))]));
});

run("different VALUES, same structure → same signature", () => {
  const other: RecipeStep[] = [
    { action: "fill", selector: { name: "owner_name" }, field: "homeownerName", value: "DIFFERENT PERSON" },
    { action: "select", selector: { name: "utility" }, field: "utility", value: "Pacific Power" },
    { action: "click", selector: { text: "Continue" } },
  ];
  assert.equal(recipeStructureSignature(other), recipeStructureSignature(base));
});

run("changed selector → different signature (drift detected)", () => {
  const drifted: RecipeStep[] = [
    { action: "fill", selector: { name: "owner_full_name" }, field: "homeownerName", value: "Jane Doe" },
    ...base.slice(1),
  ];
  assert.notEqual(recipeStructureSignature(drifted), recipeStructureSignature(base));
});

run("added step → different signature", () => {
  const longer: RecipeStep[] = [...base, { action: "click", selector: { text: "Submit" } }];
  assert.notEqual(recipeStructureSignature(longer), recipeStructureSignature(base));
});

run("empty recipe → stable signature, no throw", () => {
  assert.equal(recipeStructureSignature([]), recipeStructureSignature([]));
});

if (failures) {
  console.error(`\n${failures} recipe-staleness test(s) failed.`);
  process.exit(1);
}
console.log("\nAll recipe-staleness tests passed.");
