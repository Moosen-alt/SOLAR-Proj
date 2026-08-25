// Adapter-selection precedence (universal-first + self-seed). Pins three pure functions that
// prepareSubmission() routes on, so the contract can't drift from the live dispatch:
//   1. selectAdapterActor()      — PLATFORM identity used for field validation (recipe → platform → mock).
//   2. selectStagingActor()      — which actor actually RUNS: a recorded recipe replays first-line;
//                                  otherwise the universal learner SEEDS one (AutoLearnAdapter) on
//                                  this stage; the hand-coded Accela/PowerClerk adapters run ONLY
//                                  as the legacy fallback when auto-seed is disabled.
//   3. seedOutcomeToStageResult() — maps an auto-learn outcome onto the staging-result contract.
// Browser-free. Run: tsx backend/test/adapterPrecedence.test.ts
import assert from "node:assert/strict";
import { selectAdapterActor, selectStagingActor, seedOutcomeToStageResult, resolvePortalChannel } from "../src/repository";

let failures = 0;
const ok = (label: string) => console.log(`  ok   - ${label}`);
const run = (label: string, fn: () => void) => {
  try {
    fn();
    ok(label);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}`);
    console.error(`         ${err instanceof Error ? err.message : String(err)}`);
  }
};

// ── selectAdapterActor: PLATFORM identity (drives field validation) ───────────────────────────
// [hasRecipe, isAccela, isPowerClerk] -> expected platform actor name.
const platformCases: Array<[boolean, boolean, boolean, string, string]> = [
  // Recipe present → universal replay leads, regardless of the platform flags.
  [true, false, true, "RecipeAdapter", "recipe + PowerClerk → recipe leads (NEM inversion)"],
  [true, true, false, "RecipeAdapter", "recipe + Accela → recipe leads"],
  [true, false, false, "RecipeAdapter", "recipe + generic portal → recipe"],
  [true, true, true, "RecipeAdapter", "recipe wins even if both platform flags are set"],
  // No recipe → the platform name (used by validatePortalFields to pick the required-field set).
  [false, false, true, "PowerClerkAdapter", "no recipe + PowerClerk → PowerClerk platform identity"],
  [false, true, false, "OregonEPermittingAdapter", "no recipe + Accela → Accela platform identity"],
  [false, false, false, "MockPortalAdapter", "no recipe + unknown platform → mock"],
];
for (const [hasRecipe, isAccela, isPowerClerk, expected, label] of platformCases) {
  run(`selectAdapterActor: ${label}`, () => {
    assert.equal(selectAdapterActor(hasRecipe, isAccela, isPowerClerk), expected);
  });
}

// ── selectStagingActor: which actor actually RUNS (universal-first + self-seed) ────────────────
// Recipe always wins; with auto-seed ON, a real portal with no recipe SEEDS (AutoLearnAdapter);
// with auto-seed OFF, a real portal with no recipe falls back to the hand-coded platform adapter.
const dispatchCases: Array<[Parameters<typeof selectStagingActor>[0], string, string]> = [
  // Recipe present → first-line replay, regardless of platform or the seed flag.
  [{ hasRecipe: true, isRealPortal: true, isAccela: false, isPowerClerk: true, autoSeedEnabled: true }, "RecipeAdapter", "recipe → replay first-line (seed on)"],
  [{ hasRecipe: true, isRealPortal: true, isAccela: true, isPowerClerk: false, autoSeedEnabled: false }, "RecipeAdapter", "recipe → replay first-line (seed off)"],
  // No recipe + real portal + seed ON → SEED it, even on PowerClerk/Accela.
  [{ hasRecipe: false, isRealPortal: true, isAccela: false, isPowerClerk: true, autoSeedEnabled: true }, "AutoLearnAdapter", "no recipe + PowerClerk + seed on → self-seed"],
  [{ hasRecipe: false, isRealPortal: true, isAccela: true, isPowerClerk: false, autoSeedEnabled: true }, "AutoLearnAdapter", "no recipe + Accela + seed on → self-seed"],
  [{ hasRecipe: false, isRealPortal: true, isAccela: false, isPowerClerk: false, autoSeedEnabled: true }, "AutoLearnAdapter", "no recipe + generic real portal + seed on → self-seed"],
  // No recipe + real portal + seed OFF → legacy hand-coded fallback by platform.
  [{ hasRecipe: false, isRealPortal: true, isAccela: false, isPowerClerk: true, autoSeedEnabled: false }, "PowerClerkAdapter", "no recipe + PowerClerk + seed off → hand-coded fallback"],
  [{ hasRecipe: false, isRealPortal: true, isAccela: true, isPowerClerk: false, autoSeedEnabled: false }, "OregonEPermittingAdapter", "no recipe + Accela + seed off → hand-coded fallback"],
  // No real portal → mock, regardless of the seed flag.
  [{ hasRecipe: false, isRealPortal: false, isAccela: false, isPowerClerk: false, autoSeedEnabled: true }, "MockPortalAdapter", "mock portal + seed on → mock (no live learn in dev)"],
  // A REAL portal with seed off and no hand-coded adapter must SURFACE, never
  // simulate: the mock's fake "staged to review" moved real filings to
  // awaiting_human_submit and the approve path then fabricated MOCK-/CONF- numbers.
  [{ hasRecipe: false, isRealPortal: true, isAccela: false, isPowerClerk: false, autoSeedEnabled: false }, "NoAdapter", "REAL portal + seed off + no hand-coded adapter → surface, never mock"],
  [{ hasRecipe: false, isRealPortal: true, isAccela: false, isPowerClerk: false, autoSeedEnabled: false, simulationEnabled: true }, "MockPortalAdapter", "explicit MOCK_PORTAL=1 → simulation allowed (smoke/rehearsal only)"],
  [{ hasRecipe: false, isRealPortal: false, isAccela: true, isPowerClerk: false, autoSeedEnabled: false }, "MockPortalAdapter", "mock portal + seed off → mock"],
];
for (const [opts, expected, label] of dispatchCases) {
  run(`selectStagingActor: ${label}`, () => {
    assert.equal(selectStagingActor(opts), expected);
  });
}

// ── seedOutcomeToStageResult: map auto-learn outcome → staging-result contract ─────────────────
// The learner NEVER clicks final submit, so finalSubmitClicked is ALWAYS false.
run("seedOutcomeToStageResult: trusted → ok + stop-at-review", () => {
  const r = seedOutcomeToStageResult({ status: "trusted", pauseReason: null, message: "learned + verified" });
  assert.equal(r.ok, true);
  assert.equal(r.finalSubmitClicked, false);
  assert.equal(r.pauseReason, null);
});
run("seedOutcomeToStageResult: draft → ok + stop-at-review (re-seeds next stage)", () => {
  const r = seedOutcomeToStageResult({ status: "draft", pauseReason: null, message: "learned, needs verify" });
  assert.equal(r.ok, true);
  assert.equal(r.finalSubmitClicked, false);
  assert.equal(r.pauseReason, null);
});
run("seedOutcomeToStageResult: paused → not-ok + carries pauseReason (paused_for_human)", () => {
  const r = seedOutcomeToStageResult({ status: "paused", pauseReason: "mfa", message: "MFA challenge" });
  assert.equal(r.ok, false);
  assert.equal(r.finalSubmitClicked, false);
  assert.equal(r.pauseReason, "mfa");
});
run("seedOutcomeToStageResult: failed → not-ok + no pause + failing step (stop & surface)", () => {
  const r = seedOutcomeToStageResult({ status: "failed", pauseReason: null, message: "could not learn" });
  assert.equal(r.ok, false);
  assert.equal(r.finalSubmitClicked, false);
  assert.equal(r.pauseReason, null);
  assert.ok(Array.isArray(r.steps) && (r.steps as unknown[]).length === 1, "surfaces a failing step for the operator");
});

// ── resolvePortalChannel: the capability registry over the scrape channels ─────────────────────
// No-regression: with the API tier reserved (apiAvailable=false) and no kill-switch
// (portalPaused=false), the resolver's adapterLabel must equal selectStagingActor for
// EVERY dispatch case above — the indirection is behaviour-preserving.
let registryChecks = 0;
for (const [opts, expected, label] of dispatchCases) {
  run(`resolvePortalChannel: matches selectStagingActor — ${label}`, () => {
    const decision = resolvePortalChannel(opts);
    assert.equal(decision.adapterLabel, expected);
    assert.equal(decision.blocked, false);
  });
  registryChecks++;
}
// Channel labels map correctly off the adapter name.
run("resolvePortalChannel: recipe → channel 'recipe'", () => {
  const d = resolvePortalChannel({ hasRecipe: true, isRealPortal: true, isAccela: false, isPowerClerk: false, autoSeedEnabled: true });
  assert.equal(d.channel, "recipe");
});
run("resolvePortalChannel: self-seed → channel 'autolearn'", () => {
  const d = resolvePortalChannel({ hasRecipe: false, isRealPortal: true, isAccela: false, isPowerClerk: false, autoSeedEnabled: true });
  assert.equal(d.channel, "autolearn");
});
run("resolvePortalChannel: seed-off real portal → channel 'handcoded'", () => {
  const d = resolvePortalChannel({ hasRecipe: false, isRealPortal: true, isAccela: true, isPowerClerk: false, autoSeedEnabled: false });
  assert.equal(d.channel, "handcoded");
});
// Kill-switch wins over everything: a paused portal is a manual handoff, blocked.
run("resolvePortalChannel: portalPaused → channel 'manual' + blocked (overrides recipe)", () => {
  const d = resolvePortalChannel({ hasRecipe: true, isRealPortal: true, isAccela: false, isPowerClerk: false, autoSeedEnabled: true, portalPaused: true });
  assert.equal(d.channel, "manual");
  assert.equal(d.adapterLabel, "ManualHandoff");
  assert.equal(d.blocked, true);
});
// Reserved API tier: selectable only when apiAvailable is set (no caller does this yet).
run("resolvePortalChannel: apiAvailable → reserved 'api' tier", () => {
  const d = resolvePortalChannel({ hasRecipe: false, isRealPortal: true, isAccela: false, isPowerClerk: false, autoSeedEnabled: true, apiAvailable: true });
  assert.equal(d.channel, "api");
});
const registryExtra = 5;

const total = platformCases.length + dispatchCases.length + 4 + registryChecks + registryExtra;
if (failures) {
  console.error(`\n${failures} of ${total} precedence test(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${total} adapter-precedence tests passed.`);
