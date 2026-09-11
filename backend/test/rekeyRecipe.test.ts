// THE VERIFIED RECIPE MUST LAND ON THE KEY PRODUCTION RESOLVES — AND NOWHERE WORSE.
//
// The live Ameren pair this reproduces: the benchmark banked its verified recipe (v21, 79
// steps, "Auto-learned and verified") under the AHJ key "il|benchmark
// amerenillinoisinterconnect powerclerk com|ameren illinois", while a real NEM project
// resolves "il|unknown|ameren illinois" — occupied by v6 (75 steps, complete but
// "Auto-learned but NOT verified"). scripts/rekey-recipe.ts moves the verified row onto the
// production key; this pins the move AND the refusals that keep it from making things worse:
//   - without --demote-existing, a worse complete occupant refuses the move entirely;
//   - a permit-portal recipe is never re-keyed onto a utility key (safety rule 5);
//   - a BETTER occupant (more steps, or an affirmative "verified" note) refuses even
//     WITH --demote-existing (CLAUDE.md rule 3's spirit);
//   - discipline must be CLEARED on the move — repository.ts:5355 looks up NEM recipes
//     with no discipline, so a moved row keeping "electrical" sits on the right key and
//     is STILL invisible (kill-tested via findCompleteRecipeForProject by row id).
//
// Browser-free, scratch DB. Run: tsx backend/test/rekeyRecipe.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rekey-recipe-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { findCompleteRecipeForProject } = await import("../src/portalRecipes");
const { rekeyRecipe, notesSayVerified } = await import("../../scripts/rekey-recipe");

const db = await openDatabase();

let passed = 0;
const ok = (n: string): void => { passed++; console.log(`ok   ${n}`); };

type Row = Record<string, unknown>;
const stepsJson = (n: number): string =>
  JSON.stringify(Array.from({ length: n }, (_, i) => ({ action: i % 3 === 0 ? "click" : "fill", selector: `#f${i}`, note: `step ${i}` })));

const seedRecipe = (r: {
  id: string; scopeType: string; profileKey: string; state: string; ahj: string; utility: string;
  portalUrl: string; status: string; version: number; steps: number; notes: string; discipline: string;
}): void => {
  db.run(
    `INSERT INTO portal_recipes (id, scope_type, profile_key, state, ahj, utility, portal_platform, portal_url,
       status, version, steps_json, created_by, created_at, updated_at, notes, discipline)
     VALUES (?, ?, ?, ?, ?, ?, 'auto-learned', ?, ?, ?, ?, 'test', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', ?, ?)`,
    [r.id, r.scopeType, r.profileKey, r.state, r.ahj, r.utility, r.portalUrl, r.status, r.version, stepsJson(r.steps), r.notes, r.discipline],
  );
};
const getRow = (id: string): Row => db.get<Row>("SELECT * FROM portal_recipes WHERE id = ?", [id])!;

// --- the real Ameren pair, shape for shape --------------------------------------------
const VERIFIED_ID = "07370f52-test-verified";
const OCCUPANT_ID = "da3544a8-test-occupant";
seedRecipe({
  id: VERIFIED_ID, scopeType: "ahj",
  profileKey: "il|benchmark amerenillinoisinterconnect powerclerk com|ameren illinois",
  state: "IL", ahj: "Benchmark amerenillinoisinterconnect.powerclerk.com", utility: "Ameren Illinois",
  portalUrl: "https://amerenillinoisinterconnect.powerclerk.com/MvcAccount/Login",
  status: "complete", version: 21, steps: 79,
  notes: "Auto-learned and verified (medium confidence) on 8 page(s). Final submit recorded for the trusted-submit allowlist; never clicked.",
  // The live v21 row carries discipline "electrical" from its benchmark AHJ learn. The NEM
  // lookup passes NO discipline, so the move must clear this or the row stays invisible.
  discipline: "electrical",
});
seedRecipe({
  id: OCCUPANT_ID, scopeType: "utility",
  profileKey: "il|unknown|ameren illinois",
  state: "IL", ahj: "", utility: "Ameren Illinois",
  portalUrl: "https://amerenillinoisinterconnect.powerclerk.com/MvcAccount/Login",
  status: "complete", version: 6, steps: 75,
  notes: "Auto-learned but NOT verified — review the captured fill and confirm before trusting.",
  discipline: "",
});

// --- notesSayVerified: the word "verified" appears in BOTH rows' notes ------------------
assert.equal(notesSayVerified("Auto-learned and verified (medium confidence) on 8 page(s)."), true);
assert.equal(notesSayVerified("Auto-learned but NOT verified — review the captured fill."), false);
assert.equal(notesSayVerified("unverified draft"), false);
assert.equal(notesSayVerified(""), false);
ok("notesSayVerified reads the claim, not the letters — 'NOT verified' is not 'verified'");

// --- before anything: production resolves the UNVERIFIED occupant -----------------------
{
  const hit = findCompleteRecipeForProject(db, { scopeType: "utility", state: "IL", utility: "Ameren Illinois" });
  assert.equal(hit?.id, OCCUPANT_ID, "precondition: production resolution must find the v6 occupant before the re-key");
  ok("precondition: production resolution finds the unverified v6, not the verified v21");
}

// --- MUST REFUSE: worse occupant without --demote-existing ------------------------------
{
  const res = rekeyRecipe(db, { recipeId: VERIFIED_ID, toState: "IL", toUtility: "Ameren Illinois" });
  assert.equal(res.action, "refused");
  assert.match(String(res.reason), /--demote-existing/);
  const verified = getRow(VERIFIED_ID);
  const occupant = getRow(OCCUPANT_ID);
  assert.equal(verified.profile_key, "il|benchmark amerenillinoisinterconnect powerclerk com|ameren illinois", "refusal must not move the row");
  assert.equal(occupant.status, "complete", "refusal must not demote the occupant");
  ok("a worse complete occupant REFUSES the move until --demote-existing is spelled out");
}

// --- dry-run: evaluates everything, writes nothing --------------------------------------
{
  const res = rekeyRecipe(db, { recipeId: VERIFIED_ID, toState: "IL", toUtility: "Ameren Illinois", demoteExisting: true, dryRun: true });
  assert.equal(res.action, "dry-run");
  assert.equal(getRow(VERIFIED_ID).scope_type, "ahj", "dry-run must not move the row");
  assert.equal(getRow(OCCUPANT_ID).status, "complete", "dry-run must not demote the occupant");
  ok("--dry-run reports the plan and writes nothing");
}

// --- THE MOVE: --demote-existing re-keys v21 and retires v6 -----------------------------
{
  const res = rekeyRecipe(db, { recipeId: VERIFIED_ID, toState: "IL", toUtility: "Ameren Illinois", demoteExisting: true });
  assert.equal(res.action, "moved");
  assert.deepEqual(res.demoted, [OCCUPANT_ID]);

  const verified = getRow(VERIFIED_ID);
  assert.equal(verified.profile_key, "il|unknown|ameren illinois");
  assert.equal(verified.scope_type, "utility");
  assert.equal(verified.ahj, "", "the benchmark's fake AHJ must be cleared");
  assert.equal(verified.discipline, "", "discipline must be cleared — the NEM lookup only matches ''");
  assert.match(String(verified.notes), /Re-keyed from "il\|benchmark/, "the move must say where the row came from and why");
  assert.match(String(verified.notes), /Auto-learned and verified/, "re-keying must not erase the existing notes");
  assert.ok(String(verified.updated_at) > "2026-09-01T00:00:00.000Z", "updated_at must be bumped");

  const occupant = getRow(OCCUPANT_ID);
  assert.equal(occupant.status, "needs_rerecord", "the unverified v6 is retired, not deleted");
  // portal_recipes has UNIQUE(profile_key, discipline) — one row per slot — so the demoted
  // occupant is moved ASIDE to an out-of-grammar retired key, keeping its steps as evidence.
  assert.ok(String(occupant.profile_key).startsWith("il|unknown|ameren illinois|retired "),
    `demoted occupant must sit on a retired key no lookup ever computes, got "${occupant.profile_key}"`);
  assert.match(String(occupant.notes), /Demoted to needs_rerecord and retired off/);
  ok("the verified v21 moves onto the production key; the unverified v6 is marked needs_rerecord on a retired key, steps preserved");
}

// --- THE POINT: production's own lookup now finds the verified row ----------------------
{
  const hit = findCompleteRecipeForProject(db, { scopeType: "utility", state: "IL", utility: "Ameren Illinois" });
  assert.equal(hit?.id, VERIFIED_ID,
    "a real NEM project's resolution (scopeType utility, no discipline) must now find the verified recipe by id — "
    + "if this fails with the row on the right key, the discipline/ahj clear regressed");
  assert.equal(hit?.steps.length, 79);
  ok("findCompleteRecipeForProject — the exact production lookup — now returns the verified recipe");
}

// --- a second run is a no-op ------------------------------------------------------------
{
  const before = JSON.stringify([getRow(VERIFIED_ID), getRow(OCCUPANT_ID)]);
  const res = rekeyRecipe(db, { recipeId: VERIFIED_ID, toState: "IL", toUtility: "Ameren Illinois", demoteExisting: true });
  assert.equal(res.action, "noop");
  assert.equal(JSON.stringify([getRow(VERIFIED_ID), getRow(OCCUPANT_ID)]), before, "a no-op must not touch either row");
  ok("a second run is a no-op — both rows byte-identical");
}

// --- MUST REFUSE: a permit-URL recipe never lands on a utility key (rule 5) -------------
{
  const PERMIT_ID = "permit-url-recipe";
  seedRecipe({
    id: PERMIT_ID, scopeType: "ahj",
    profileKey: "or|benchmark aca oregon gov|portland general electric",
    state: "OR", ahj: "Benchmark aca.oregon.gov", utility: "Portland General Electric",
    // An Accela PERMIT portal — utility-shaped identity, permit-shaped URL.
    portalUrl: "https://aca-prod.accela.com/oregon/Default.aspx",
    status: "complete", version: 3, steps: 40, notes: "Auto-learned and verified.", discipline: "structural",
  });
  const res = rekeyRecipe(db, { recipeId: PERMIT_ID, toState: "OR", toUtility: "Portland General Electric", demoteExisting: true });
  assert.equal(res.action, "refused");
  assert.match(String(res.reason), /NOT a utility platform/i);
  const row = getRow(PERMIT_ID);
  assert.equal(row.scope_type, "ahj", "the permit recipe must be untouched");
  assert.equal(row.profile_key, "or|benchmark aca oregon gov|portland general electric");
  ok("rule 5: a recipe whose portal_url is a PERMIT portal is refused a utility key");
}

// --- MUST REFUSE: a BETTER occupant is never displaced, even with --demote-existing -----
{
  // (a) occupant with MORE steps
  const MOVER_A = "comed-mover"; const BETTER_A = "comed-better-occupant";
  seedRecipe({
    id: MOVER_A, scopeType: "ahj", profileKey: "il|benchmark interconnect comed com|comed",
    state: "IL", ahj: "Benchmark interconnect.comed.com", utility: "ComEd",
    portalUrl: "https://interconnect.comed.com/login", status: "complete", version: 4, steps: 30,
    notes: "Auto-learned and verified.", discipline: "electrical",
  });
  seedRecipe({
    id: BETTER_A, scopeType: "utility", profileKey: "il|unknown|comed",
    state: "IL", ahj: "", utility: "ComEd",
    portalUrl: "https://interconnect.comed.com/login", status: "complete", version: 9, steps: 60,
    notes: "Auto-learned but NOT verified.", discipline: "",
  });
  const resA = rekeyRecipe(db, { recipeId: MOVER_A, toState: "IL", toUtility: "ComEd", demoteExisting: true });
  assert.equal(resA.action, "refused", "an occupant with MORE steps must refuse even with --demote-existing");
  assert.match(String(resA.reason), /better row/i);
  assert.equal(getRow(BETTER_A).status, "complete", "the better occupant must not be demoted");
  assert.equal(getRow(MOVER_A).scope_type, "ahj", "the mover must not move");

  // (b) occupant with FEWER steps but an affirmative "verified" note
  const MOVER_B = "peco-mover"; const BETTER_B = "peco-verified-occupant";
  seedRecipe({
    id: MOVER_B, scopeType: "ahj", profileKey: "pa|benchmark peco connectthegrid com|peco",
    state: "PA", ahj: "Benchmark peco.connectthegrid.com", utility: "PECO",
    portalUrl: "https://peco.connectthegrid.com/applications", status: "complete", version: 12, steps: 80,
    notes: "Auto-learned and verified.", discipline: "electrical",
  });
  seedRecipe({
    id: BETTER_B, scopeType: "utility", profileKey: "pa|unknown|peco",
    state: "PA", ahj: "", utility: "PECO",
    portalUrl: "https://peco.connectthegrid.com/applications", status: "complete", version: 2, steps: 20,
    notes: "Auto-learned and verified by the operator on 2026-08-14.", discipline: "",
  });
  const resB = rekeyRecipe(db, { recipeId: MOVER_B, toState: "PA", toUtility: "PECO", demoteExisting: true });
  assert.equal(resB.action, "refused", "a human-VERIFIED occupant must refuse regardless of step count");
  assert.match(String(resB.reason), /verified/i);
  assert.equal(getRow(BETTER_B).status, "complete");
  ok("a BETTER occupant (more steps, or a genuinely verified note) refuses the move even with --demote-existing");
}

// --- MUST REFUSE: the row's own identity must match the target key ----------------------
{
  const res = rekeyRecipe(db, { recipeId: VERIFIED_ID, toState: "IL", toUtility: "ComEd", demoteExisting: true });
  assert.equal(res.action, "refused", "an Ameren recipe must never be filed under ComEd's key by typo");
  assert.match(String(res.reason), /own state\/utility/);
  assert.equal(getRow(VERIFIED_ID).profile_key, "il|unknown|ameren illinois", "the typo attempt must not move the row");
  ok("a target key the row's own state/utility do not resolve is refused — no cross-utility typos");
}

console.log(`\nAll ${passed} rekey-recipe checks passed.`);
