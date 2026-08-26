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
const { startPortalRecording, savePortalRecipeSteps, appendHumanPatchSteps, getPortalRecipe, finishPortalRecipe } = await import("../src/portalRecipes");

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

run("submit/pay CLICKS are dropped at merge (defense in depth)", () => {
  const recipe = mkRecipe(baseSteps);
  const before = getPortalRecipe(db, recipe.id).steps.length;
  appendHumanPatchSteps(db, recipe.id, [
    { action: "click", selector: { css: "#btn-final" }, note: "human-patch: Submit" },
    { action: "click", selector: { role: "button", name: "Pay Now" }, note: "human-patch: Pay Now" },
    { action: "fill", selector: { label: "Meter location" }, value: "left side", note: "human-patch: Meter location" },
  ], {});
  const updated = getPortalRecipe(db, recipe.id);
  assert.equal(updated.steps.length, before + 1, "only the fill survives");
  assert.ok(
    !updated.steps.some((st) => st.action === "click" && (st.note || "").startsWith("human-patch") && /submit|pay now/i.test(`${st.note} ${JSON.stringify(st.selector || {})}`)),
    "no human-patch submit/pay click merged",
  );
});

run("SENSITIVE literals never persist — bound on match, stripped regardless", () => {
  // The capture ships the typed secret in-memory only (payloadToStep keeps it so the
  // merge can bind it); THIS is the boundary where it must die. Two cases: a literal
  // matching project data binds to the field key; one matching nothing still strips.
  const recipe = mkRecipe(baseSteps);
  appendHumanPatchSteps(db, recipe.id, [
    { action: "fill", selector: { label: "Account Number" }, value: "ACCT-9876543", sensitive: true, note: "human-patch: Account Number — SENSITIVE, bound at replay (no value stored)" },
    { action: "fill", selector: { label: "Meter Number" }, value: "MTR-UNMATCHED-1", sensitive: true, note: "human-patch: Meter Number — SENSITIVE, bound at replay (no value stored)" },
  ], { accountNumber: "ACCT-9876543" });
  const raw = String(db.get<{ steps_json?: string }>("SELECT steps_json FROM portal_recipes WHERE id = ?", [recipe.id])?.steps_json);
  assert.ok(!raw.includes("ACCT-9876543"), "matched secret must not land in steps_json");
  assert.ok(!raw.includes("MTR-UNMATCHED-1"), "UNMATCHED secret must not land in steps_json either");
  const updated = getPortalRecipe(db, recipe.id);
  const acct = updated.steps.find((s) => (s.note || "").includes("Account Number"))!;
  assert.equal(acct.field, "accountNumber", "matched secret bound to its project field key");
  assert.equal(acct.value, undefined, "no literal on the persisted step");
});

run("finishPortalRecipe promotes recording → complete; empty recording refuses", () => {
  const recipe = mkRecipe(baseSteps);
  const done = finishPortalRecipe(db, recipe.id, "test");
  assert.equal(done.status, "complete");
  assert.equal(finishPortalRecipe(db, recipe.id).status, "complete", "idempotent");
  const empty = mkRecipe([]);
  assert.throws(() => finishPortalRecipe(db, empty.id), /no captured steps/i);
});

fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} human-patch test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll human-patch tests passed.");
process.exit(0);
