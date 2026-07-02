// PATCH-BY-DEMONSTRATION merge (appendHumanPatchSteps): human fixes captured at the
// review handoff must land in the recipe BEFORE its terminal steps (stopForReview /
// isFinalSubmit) — replay stops at those markers, so a step after them never replays.
// Literals matching the patching project's data must convert to field bindings.
// Browser-free. Run: tsx backend/test/humanPatch.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RecipeStep } from "../../shared/src/types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "human-patch-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { startPortalRecording, savePortalRecipeSteps, appendHumanPatchSteps, getPortalRecipe } = await import("../src/portalRecipes");

const db = await openDatabase();

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

function mkRecipe(steps: RecipeStep[], status: "recording" | "complete" = "recording") {
  const stub = startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj: `Patchville-${Math.random().toString(36).slice(2, 8)}`, portalUrl: "https://portal.test/apply", createdBy: "test" });
  return savePortalRecipeSteps(db, stub.id, steps, { status });
}

const baseSteps: RecipeStep[] = [
  { action: "goto", phase: "open", value: "https://portal.test/apply" },
  { action: "fill", selector: { label: "Owner Name" }, field: "homeownerName" },
  { action: "click", selector: { role: "button", name: "Next" }, note: "advance: Next" },
  { action: "click", selector: { role: "button", name: "Submit Application" }, isFinalSubmit: true, note: "final submit — recorded, never clicked" } as RecipeStep,
  { action: "stopForReview", phase: "review", note: "Stop at review." },
];

run("patch steps land BEFORE the terminal tail (isFinalSubmit + stopForReview)", () => {
  const recipe = mkRecipe(baseSteps);
  appendHumanPatchSteps(db, recipe.id, [
    { action: "select", selector: { label: "Schedule" }, value: "Schedule 7", note: "human-patch: Schedule" },
  ], {});
  const updated = getPortalRecipe(db, recipe.id);
  const actions = updated.steps.map((s) => s.action);
  assert.deepEqual(actions, ["goto", "fill", "click", "select", "click", "stopForReview"], actions.join(","));
  const tail = updated.steps.slice(-2) as Array<RecipeStep & { isFinalSubmit?: boolean }>;
  assert.equal(tail[0].isFinalSubmit, true, "final submit stays terminal");
  assert.equal(tail[1].action, "stopForReview", "stopForReview stays last");
});

run("literal values matching project data are bound to fields", () => {
  const recipe = mkRecipe(baseSteps);
  appendHumanPatchSteps(db, recipe.id, [
    { action: "fill", selector: { label: "Installer Email" }, value: "ops@example-solar.test", note: "human-patch: Installer Email" },
  ], { installerEmail: "ops@example-solar.test" });
  const updated = getPortalRecipe(db, recipe.id);
  const patched = updated.steps.find((s) => (s.note || "").includes("Installer Email"))!;
  assert.equal(patched.field, "installerEmail", "literal bound to installerEmail");
});

run("recipe status is preserved and the notes marker is idempotent across streamed steps", () => {
  const recipe = mkRecipe(baseSteps, "recording");
  appendHumanPatchSteps(db, recipe.id, [{ action: "check", selector: { label: "Battery installed" }, note: "human-patch: Battery installed" }], {});
  appendHumanPatchSteps(db, recipe.id, [{ action: "fill", selector: { label: "Battery kWh" }, value: "13.5", note: "human-patch: Battery kWh" }], {});
  const updated = getPortalRecipe(db, recipe.id);
  assert.equal(updated.status, "recording", "status unchanged");
  const markers = (updated.notes || "").match(/\[human-patch:/g) || [];
  assert.equal(markers.length, 1, `exactly one notes marker (notes: ${updated.notes})`);
  assert.ok((updated.notes || "").includes("2 step(s)"), `marker carries the total (notes: ${updated.notes})`);
});

run("recipe with no terminal tail just appends at the end", () => {
  const recipe = mkRecipe(baseSteps.slice(0, 3));
  appendHumanPatchSteps(db, recipe.id, [{ action: "check", selector: { label: "Terms" }, note: "human-patch: Terms" }], {});
  const updated = getPortalRecipe(db, recipe.id);
  assert.equal(updated.steps[updated.steps.length - 1].action, "check");
});

run("empty patch list is a no-op", () => {
  const recipe = mkRecipe(baseSteps);
  const before = getPortalRecipe(db, recipe.id).steps.length;
  appendHumanPatchSteps(db, recipe.id, [], {});
  assert.equal(getPortalRecipe(db, recipe.id).steps.length, before);
});

fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} human-patch test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll human-patch tests passed.");
process.exit(0);
