// ---------------------------------------------------------------------------
// THE TRUST GATE HAD FOUR BACK DOORS, AND THEY ARE WHY "complete" COULD NOT BE TRUSTED.
//
// One gate grants trust (evaluateTrustGate). Four paths reached 'complete' without passing
// it, and each is fixed and pinned here:
//
//   1. the gate itself      — must block a run with a required field left blank, and must
//                             still PASS a clean run (a gate nothing can pass is not safety,
//                             it is a different outage).
//   2. the stale sweep      — restoreRecipeSnapshotIfAbandoned promoted ANY parked steps to
//                             'complete' because a run died. Live proof: the Ameren Illinois
//                             NEM recipe is 'complete' with "Required field(s) left blank"
//                             and "restored the previous working recipe" in the same notes.
//   3. the save default     — savePortalRecipeSteps defaulted to 'complete', so any caller
//                             that forgot the argument published the recipe.
//   4. the notes writer     — the sweep overwrote the notes column, destroying the failure
//                             taxonomy ("Auto-learn paused: mfa_captcha") the next session
//                             needs to know why a portal stopped where it did.
//
// Plus the two invariants that make "learn once, replay forever" survivable:
//   5. a shallower unverified run must not bury a deeper draft;
//   6. a TRANSIENT failure (outage, credential, MFA, one-session collision) must not demote
//      a verified recipe — only a failure attributable to the RECIPE may.
//
// KILL TEST (each fix, one at a time — the fixture MUST fail with the fix disabled):
//   1. autoLearn.evaluateTrustGate: delete the `requiredFieldMisses.length` blocker.
//   2. portalRecipes.restoreRecipeSnapshotIfAbandoned: force `const proven = true`.
//   3. portalRecipes.savePortalRecipeSteps: restore `options.status ?? (steps.length ? "complete" : "recording")`.
//   4. jobQueue.recoverStalePortalRecordings: replace mergeRecipeNotes(...) with the bare string.
//   5. portalRecipes.savePortalRecipeSteps: force `const shallower = false`.
//   6. portalRecipes.markPortalRecipeForRerecord: drop the replayFailureBlamesRecipe guard.
//
// Browser-free, scratch DB. Run: tsx backend/test/trustGate.test.ts
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RecipeStep } from "../../shared/src/types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-gate-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
// Make the 2h abandonment threshold instant so the sweep sees fresh rows as stale.
process.env.RECIPE_RECORDING_STALE_MS = "0";

const { openDatabase } = await import("../src/db");
const {
  startPortalRecording, savePortalRecipeSteps, getPortalRecipe,
  markPortalRecipeForRerecord, replayFailureBlamesRecipe, mergeRecipeNotes,
} = await import("../src/portalRecipes");
const { recoverStalePortalRecordings } = await import("../src/jobQueue");
const { evaluateTrustGate } = await import("../src/autoLearn");
const db = await openDatabase();

// The live DB must never be touched by a test (CLAUDE.md).
assert.ok(!/autopilot\.sqlite$/.test(String(process.env.AUTOPILOT_DB_PATH)), "tests must run on a scratch DB");

let failures = 0;
const run = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const fills = (n: number, tag = "f"): RecipeStep[] =>
  Array.from({ length: n }, (_, i) => ({ action: "fill", selector: { name: `${tag}${i}` }, field: "homeownerName", value: "Jane Doe" } as RecipeStep));
const reviewEnd: RecipeStep = { action: "stopForReview", selector: {} };

let scopeSeq = 0;
const freshScope = () => ({ scopeType: "ahj" as const, state: "OR", ahj: `City of Gate ${++scopeSeq}`, utility: "PGE" });

// ===========================================================================
// 1. THE GATE ITSELF — blocks a required-field miss, and PASSES a clean run.
// ===========================================================================
const CLEAN_RUN = {
  reachedReview: true,
  filledSomething: true,
  reviewReadable: true,
  verificationAccurate: true,
  textContradicts: false,
  requiredFieldMisses: [] as string[],
  missingRequiredDocs: [] as string[],
  validationBlocks: [] as string[],
  ambiguousLiteralCount: 0,
  deadBindings: [] as string[],
  pageCount: 8,
  substantiveFills: 40,
  formPurposeMismatch: false,
};

run("a run with a required field left blank is NOT trusted", () => {
  const verdict = evaluateTrustGate({ ...CLEAN_RUN, requiredFieldMisses: ["Email", "Docket Number"] });
  assert.equal(verdict.trusted, false, "a known-blank required field must never reach 'complete'");
  assert.match(verdict.blockers.join(" | "), /required field\(s\) left blank.*Email/i, "and the gate must SAY which fields");
});

// THE OVER-CORRECTION GUARD. Without this, every fix above could be "raise the bar until
// nothing passes" and the fleet would quietly stop learning anything, which looks identical
// to safety from the outside.
run("a clean run IS trusted — the gate is reachable", () => {
  const verdict = evaluateTrustGate(CLEAN_RUN);
  assert.equal(verdict.trusted, true, `the gate must still pass a clean run; blocked by: ${verdict.blockers.join("; ")}`);
  assert.deepEqual(verdict.blockers, []);
});

run("every other condition in the bar blocks on its own", () => {
  const cases: Array<[string, Partial<typeof CLEAN_RUN>]> = [
    ["never reached review", { reachedReview: false }],
    ["filled nothing", { filledSomething: false }],
    ["review screen unreadable", { reviewReadable: false }],
    ["verifier not accurate", { verificationAccurate: false }],
    ["text contradiction", { textContradicts: true }],
    ["missing required document", { missingRequiredDocs: ["Site Plan"] }],
    ["portal validation block", { validationBlocks: ["Enter a valid ZIP"] }],
    ["ambiguous literal", { ambiguousLiteralCount: 1 }],
    ["dead binding", { deadBindings: ["descriptionOfService"] }],
    ["too few pages", { pageCount: 2 }],
    ["too few fills", { substantiveFills: 4 }],
    ["wrong form", { formPurposeMismatch: true }],
  ];
  for (const [label, patch] of cases) {
    assert.equal(evaluateTrustGate({ ...CLEAN_RUN, ...patch }).trusted, false, `${label} must block promotion`);
  }
});

// ===========================================================================
// 2. THE STALE SWEEP — a recording that died is not evidence of success.
// ===========================================================================
run("a stale 3-step recording with a required-blank finding does NOT become complete", () => {
  const scope = freshScope();
  // A never-verified draft: three steps, and the sweep's own required-blank finding in its notes.
  const draft = startPortalRecording(db, { ...scope, portalUrl: "https://gate.example/apply" });
  savePortalRecipeSteps(db, draft.id, [...fills(2), reviewEnd], {
    status: "recording",
    notes: "Auto-learned but NOT verified. Required field(s) left blank/unselected — fill before trusting: Email, Street, Docket Number.",
  });
  // A later learn resets the row (parking those three steps in prev_steps_json) and then dies.
  startPortalRecording(db, scope);
  recoverStalePortalRecordings(db);

  const swept = getPortalRecipe(db, draft.id);
  assert.notEqual(swept.status, "complete", "a recording that died must never be promoted to a replayable recipe");
  assert.equal(swept.status, "needs_rerecord");
  assert.equal(swept.steps.length, 3, "its steps are still restored — depth is information, it just is not trust");
  assert.match(swept.notes, /Required field\(s\) left blank/i, "and the finding that condemns it survives the sweep");
});

run("an abandoned re-record keeps the DEEPER of its capture and the unproven snapshot", () => {
  // Live: the Lynn MA row (28d1cd81) was one sweep away from having its 4-fill capture
  // overwritten by the 3-fill snapshot underneath it. Neither replays; the only thing at
  // stake is how much of the portal we still have a record of.
  const scope = freshScope();
  const row = startPortalRecording(db, { ...scope, portalUrl: "https://gate.example/apply" });
  savePortalRecipeSteps(db, row.id, fills(3), { status: "recording", notes: "Auto-learned but NOT verified." });
  startPortalRecording(db, scope);                                   // snapshot = 3 fills, unproven
  savePortalRecipeSteps(db, row.id, fills(4, "live"), { status: "recording" }); // this attempt got further
  recoverStalePortalRecordings(db);

  const swept = getPortalRecipe(db, row.id);
  assert.equal(swept.status, "needs_rerecord");
  assert.equal(swept.steps.length, 4, "the deeper capture is what survives");
  assert.equal(swept.steps[0].selector?.name, "live0");
});

run("a PROVEN recipe abandoned mid-re-record still comes back as complete", () => {
  // The legitimate case this rollback exists for must keep working, or a crashed re-record
  // strands a working portal with no recipe at all.
  const scope = freshScope();
  const proven = startPortalRecording(db, { ...scope, portalUrl: "https://gate.example/apply" });
  savePortalRecipeSteps(db, proven.id, [...fills(6), reviewEnd], { status: "complete", notes: "Auto-learned and verified (high confidence) on 9 page(s)." });
  startPortalRecording(db, scope); // re-record starts, then the run dies
  recoverStalePortalRecordings(db);

  const restored = getPortalRecipe(db, proven.id);
  assert.equal(restored.status, "complete", "a previously PROVEN recipe is handed back — nothing new is being trusted");
  assert.equal(restored.steps.length, 7);
});

// ===========================================================================
// 3. THE SAVE DEFAULT — forgetting the argument must not publish a recipe.
// ===========================================================================
run("savePortalRecipeSteps with NO status does not produce 'complete'", () => {
  const scope = freshScope();
  const stub = startPortalRecording(db, { ...scope, portalUrl: "https://gate.example/apply" });
  const saved = savePortalRecipeSteps(db, stub.id, [...fills(9), reviewEnd]);
  assert.notEqual(saved.status, "complete", "a save is not a verdict — it must not promote");
  assert.equal(saved.status, "recording", "the recipe keeps the status it already had");
  assert.equal(saved.steps.length, 10, "the steps are still saved");
});

run("savePortalRecipeSteps with NO status does not DEMOTE a complete recipe either", () => {
  // repository.ts's self-heal writer saves repaired selectors with no status and means
  // "same recipe, fixed anchors". The safe default must not silently unpublish it.
  const scope = freshScope();
  const stub = startPortalRecording(db, { ...scope, portalUrl: "https://gate.example/apply" });
  savePortalRecipeSteps(db, stub.id, [...fills(6), reviewEnd], { status: "complete" });
  const healed = savePortalRecipeSteps(db, stub.id, [...fills(6, "healed"), reviewEnd], { notes: "Self-healed 2 drifted step(s)." });
  assert.equal(healed.status, "complete", "a complete recipe stays complete across a self-heal save");
  assert.equal(healed.steps[0].selector?.name, "healed0", "and the healed selectors are what got written");
});

// ===========================================================================
// 4. THE NOTES WRITER — the failure taxonomy must survive the sweep.
// ===========================================================================
run("'Auto-learn paused: mfa_captcha' survives the stale sweep", () => {
  const scope = freshScope();
  const paused = startPortalRecording(db, { ...scope, portalUrl: "https://gate.example/apply" });
  savePortalRecipeSteps(db, paused.id, fills(1), {
    status: "recording",
    notes: "Auto-learn paused: mfa_captcha. Resume manually.",
  });
  recoverStalePortalRecordings(db); // no snapshot on this row — the plain sweep branch

  const swept = getPortalRecipe(db, paused.id);
  assert.equal(swept.status, "needs_rerecord");
  assert.match(swept.notes, /Auto-learn paused: mfa_captcha/, "the reason the run stopped is the whole reason to keep notes");
  assert.match(swept.notes, /recording interrupted/i, "and the sweep still says what it did");
});

run("a sweep that ticks repeatedly does not re-append its own sentence", () => {
  const scope = freshScope();
  const row = startPortalRecording(db, { ...scope, portalUrl: "https://gate.example/apply" });
  savePortalRecipeSteps(db, row.id, fills(1), { status: "recording", notes: "Auto-learn paused: mfa_captcha." });
  recoverStalePortalRecordings(db);
  const once = getPortalRecipe(db, row.id).notes;
  // Put it back to 'recording' and sweep again — the merge must dedupe by SEGMENT.
  db.run("UPDATE portal_recipes SET status = 'recording' WHERE id = ?", [row.id]);
  recoverStalePortalRecordings(db);
  const twice = getPortalRecipe(db, row.id).notes;
  assert.equal(twice.split("recording interrupted").length - 1, 1, "the same segment must not accumulate");
  assert.ok(twice.length <= once.length + 4, "notes must not grow on every tick (the runaway-notes bug)");
});

run("mergeRecipeNotes merges by segment, not by blob", () => {
  assert.equal(mergeRecipeNotes("a | b", "b | c"), "a | b | c");
  assert.equal(mergeRecipeNotes("", "only"), "only");
  assert.equal(mergeRecipeNotes("keep", ""), "keep");
});

// ===========================================================================
// 5. DEPTH — a 60-step draft is not replaced by a 4-step untrusted run.
// ===========================================================================
run("a 60-step draft survives a later 4-step run that fails the trust gate", () => {
  const scope = freshScope();
  const deep = startPortalRecording(db, { ...scope, portalUrl: "https://gate.example/apply" });
  savePortalRecipeSteps(db, deep.id, [...fills(60), reviewEnd], { status: "recording", notes: "Auto-learned but NOT verified — 60 fields across 12 pages." });
  assert.equal(getPortalRecipe(db, deep.id).steps.length, 61);

  // The next run resets the row and comes back with four fills and no trust.
  startPortalRecording(db, scope);
  const gate = evaluateTrustGate({ ...CLEAN_RUN, pageCount: 2, substantiveFills: 4 });
  assert.equal(gate.trusted, false, "precondition: this run does not earn trust");
  const after = savePortalRecipeSteps(db, deep.id, fills(4), {
    status: "recording",
    notes: "Auto-learned but NOT verified — the harness cut this run off.",
  });

  assert.equal(after.steps.length, 61, "the 60-fill draft must still be there");
  assert.equal(after.status, "recording");
  assert.match(after.notes, /kept the deeper recording/i, "and the row must say why the shallow save did not land");
});

run("a DEEPER run still replaces a shallower draft — progress is not blocked", () => {
  const scope = freshScope();
  const shallow = startPortalRecording(db, { ...scope, portalUrl: "https://gate.example/apply" });
  savePortalRecipeSteps(db, shallow.id, fills(4), { status: "recording" });
  startPortalRecording(db, scope);
  const after = savePortalRecipeSteps(db, shallow.id, [...fills(30, "deep"), reviewEnd], { status: "recording" });
  assert.equal(after.steps.length, 31, "a run that got further must be allowed to win");
  assert.equal(after.steps[0].selector?.name, "deep0");
});

run("a verified re-record may legitimately SHORTEN a recipe", () => {
  const scope = freshScope();
  const long = startPortalRecording(db, { ...scope, portalUrl: "https://gate.example/apply" });
  savePortalRecipeSteps(db, long.id, [...fills(40), reviewEnd], { status: "complete" });
  startPortalRecording(db, scope);
  const after = savePortalRecipeSteps(db, long.id, [...fills(6, "lean"), reviewEnd], { status: "complete" });
  assert.equal(after.steps.length, 7, "'complete' is a verdict about THESE steps — the portal got simpler");
});

// ===========================================================================
// 6. TRANSIENT FAILURES MUST NOT DEMOTE A VERIFIED RECIPE.
// ===========================================================================
run("the classifier separates portal/environment failures from recipe drift", () => {
  const notTheRecipe = [
    "Recipe step failed (goto — portal home): net::ERR_CONNECTION_REFUSED",
    "Recipe step failed (click — Continue): 503 Service Unavailable",
    "Recipe step failed (fill — username): still on the login form; username/password was likely rejected",
    "Recipe step failed: a verification code was sent to your phone (MFA)",
    "Recipe step failed: you are already logged in from another session",
    "Recipe step failed: Target page, context or browser has been closed",
    "Recipe step failed: Attention Required! | Cloudflare — you have been blocked",
    "Recipe step failed (goto): page.goto timeout 30000ms exceeded",
  ];
  for (const text of notTheRecipe) {
    assert.equal(replayFailureBlamesRecipe(text).blamesRecipe, false, `must NOT blame the recipe: ${text}`);
  }
  const theRecipe = [
    "Recipe step failed (fill — inverter quantity): waiting for selector \"#inv_qty\" timed out",
    "Recipe step failed (select — Manufacturer): option not found in list",
    "Recipe step failed (page drift): recorded control is no longer on this page",
  ];
  for (const text of theRecipe) {
    assert.equal(replayFailureBlamesRecipe(text).blamesRecipe, true, `must blame the recipe: ${text}`);
  }
});

run("a portal outage does not demote a verified recipe", () => {
  const scope = freshScope();
  const good = startPortalRecording(db, { ...scope, portalUrl: "https://gate.example/apply" });
  savePortalRecipeSteps(db, good.id, [...fills(30), reviewEnd], { status: "complete", notes: "Auto-learned and verified (high confidence) on 11 page(s)." });

  const after = markPortalRecipeForRerecord(db, good.id, {
    failureText: "Recipe step failed (goto — application) | net::ERR_NAME_NOT_RESOLVED at https://gate.example/apply",
  });
  assert.equal(after.status, "complete", "the portal being unreachable says nothing about the recipe");
  assert.match(after.notes, /kept trusted/i, "and the refusal is recorded so nobody thinks the check silently passed");
  assert.match(after.notes, /Auto-learned and verified/, "the original verification note survives");
});

run("real selector drift DOES demote a verified recipe", () => {
  const scope = freshScope();
  const good = startPortalRecording(db, { ...scope, portalUrl: "https://gate.example/apply" });
  savePortalRecipeSteps(db, good.id, [...fills(30), reviewEnd], { status: "complete" });
  const after = markPortalRecipeForRerecord(db, good.id, {
    failureText: "Recipe step failed (fill — inverter quantity): waiting for selector \"#inv_qty\" timed out after 15000ms",
  });
  assert.equal(after.status, "needs_rerecord", "drift is exactly what this check is for");
});

run("an operator's explicit mark-for-re-record still works with no evidence", () => {
  const scope = freshScope();
  const good = startPortalRecording(db, { ...scope, portalUrl: "https://gate.example/apply" });
  savePortalRecipeSteps(db, good.id, [...fills(30), reviewEnd], { status: "complete" });
  assert.equal(markPortalRecipeForRerecord(db, good.id).status, "needs_rerecord", "a deliberate human act needs no proof");
});

if (failures) {
  console.error(`\n${failures} trust-gate test(s) failed.`);
  process.exit(1);
}
console.log("\nAll trust-gate tests passed.");
