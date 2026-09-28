// THE TRACK CARD ASKS THE RECIPE RESOLVER STAGING USES, AND ONE UTILITY IS ONE UTILITY
// (dry run 2026-09-28, B9 — "they just look blank").
//
// The plan set said "UTILITY: PACIFICORP"; the KB and every recipe say "Pacific Power". Staging found
// the Coos Bay recipes anyway (findComplete/AnyRecipeForProject fall back to the AHJ-name alias), but
// the building and electrical cards asked their own raw `profile_key = ?` query and showed "No bot
// recipe yet" beside runs that replayed v16 / v9 — and, with no discipline filter, the electrical card
// would have shown the STRUCTURAL recipe. The NEM learn's resolver scored "PacifiCorp" vs "Pacific
// Power" 0 and the recorder's own exact-key lookup inserted a duplicate SHARED recipe.
//
//   A  THE CARD — findComplete/AnyRecipeForProject (staging's order, discipline-scoped); a run's own
//      fact first (the recipe it used, or the recipe it BORROWED).
//   B  THE IDENTITY — utilityIdentity.sameUtilityEntity, state-gated, in the recipe alias and the KB
//      fuzzy; the learn writes the row it resolved (startPortalRecording existingRecipeId).
//
// KILLS (verified by hand, see the commit): the card's raw profile_key query -> A1, A2, A4 FAIL;
// findRecipeByNameAlias without sameUtilityEntity -> B2, A4 FAIL; findKnowledgeByName without it -> B3
// FAILS; autoLearn not passing existingRecipeId -> B5 FAILS; startPortalRecording taking any resolved
// row without the scope/state/discipline guard -> B4' FAILS; a UTILITY-scope resolved row taken
// without the identity/same-name guard -> B4'' FAILS; the guard without its identity arm -> B4,
// B4''', B5 FAIL.
//
//   npx tsx backend/test/trackCardRecipe.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import type { RecipeStep } from "../../shared/src/types";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("track-card-recipe");
const { db, repo, recipes } = fx;
const tracksMod = await import("../src/submittalTracks");
const identity = await import("../src/utilityIdentity");
const kb = await import("../src/knowledgeBase");
const autoLearn = await import("../src/autoLearn");

const ACA_OREGON = "https://aca-oregon.accela.com/oregon/";
const PACIFICORP_NM = "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login";
const fill = (i: number): RecipeStep => ({ action: "fill", selector: { name: `f${i}` }, field: "homeownerName", note: `Field ${i}` } as RecipeStep);
const REVIEW = { action: "stopForReview", selector: {} } as RecipeStep;
// The shared-portal-reuse test's Accela shape (so a Salem stage can borrow one of these).
const steps = (recordType: string): RecipeStep[] => [
  { action: "goto", value: `${ACA_OREGON}Dashboard.aspx`, note: "entry url" } as RecipeStep,
  { action: "fill", selector: { name: "f1" }, field: "streetNumber", note: "Field 1" } as RecipeStep,
  { action: "check", selector: { label: recordType }, note: `record type: ${recordType}` } as RecipeStep,
  { action: "click", selector: { text: "Continue Application »" }, note: "record type: continue" } as RecipeStep,
  fill(2), fill(3), REVIEW,
];
const ahjRecipe = (ahj: string, utility: string, discipline: string, recordType: string) => {
  const r = recipes.startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj, utility, portalUrl: ACA_OREGON, discipline, portalPlatform: "accela", createdBy: "test" });
  return recipes.savePortalRecipeSteps(db, r.id, steps(recordType), { status: "complete" });
};
const cards = (projectId: string) => tracksMod.getSubmittalTracks(db, repo.getProjectDetail(db, projectId).project);
const card = (projectId: string, type: string) => cards(projectId).find((t) => t.type === type);

// The world, through the real writers: Coos Bay's two AHJ recipes keyed under "Pacific Power", the
// structural one re-recorded so it carries the HIGHER version (the raw query's ORDER BY version DESC
// then hands it to every card of the AHJ).
const coosElectrical = ahjRecipe("City of Coos Bay", "Pacific Power", "electrical", "Residential - Electrical");
ahjRecipe("City of Coos Bay", "Pacific Power", "structural", "Residential - Structural");
const coosStructural = ahjRecipe("City of Coos Bay", "Pacific Power", "structural", "Residential - Structural");
assert.ok(coosStructural.version > coosElectrical.version, "setup: structural carries the higher version");

// ── A. THE CARD ────────────────────────────────────────────────────────────────────────────
await check("(A1) THE POINT: a 'PacifiCorp' Coos Bay project's building card shows the Coos Bay STRUCTURAL recipe staging replays", () => {
  const pid = fx.newProject({ ahj: "City of Coos Bay", city: "Coos Bay", zip: "97420", utility: "PacifiCorp" });
  const types = cards(pid).map((t) => t.type);
  const building = card(pid, "building") ?? card(pid, "combo") ?? card(pid, "permit");
  assert.ok(building, `setup: no permit card (${types.join(",")})`);
  assert.equal(building!.hasRecipe, true, `the card looks blank: ${JSON.stringify({ types, hasRecipe: building!.hasRecipe })}`);
  // Staging's own resolver, asked the same question — the card must agree with it.
  const staging = recipes.findCompleteRecipeForProject(db, { scopeType: "ahj", state: "OR", ahj: "City of Coos Bay", utility: "PacifiCorp", discipline: building!.type === "building" ? "structural" : "combo" });
  assert.equal(building!.recipeId, staging?.id, "the card and staging answer differently");
});

await check("(A2) the electrical card shows the ELECTRICAL recipe, never the higher-versioned structural one", () => {
  const pid = fx.newProject({ ahj: "City of Coos Bay", city: "Coos Bay", zip: "97420", utility: "Pacific Power" });
  const electrical = card(pid, "electrical");
  assert.ok(electrical, `setup: Coos Bay files a separate electrical permit — cards: ${cards(pid).map((t) => t.type).join(",")}`);
  assert.equal(electrical!.recipeId, coosElectrical.id, `electrical card shows ${electrical!.recipeId}`);
  assert.equal(card(pid, "building")?.recipeId, coosStructural.id);
});

await check("(A3) MUST-EXCLUDE: an AHJ with no recipe anywhere still reads 'no recipe' (the resolver does not borrow by itself)", () => {
  const pid = fx.newProject({ ahj: "City of Nowhereton", city: "Nowhereton", zip: "97999", utility: "Pacific Power" });
  for (const t of cards(pid).filter((c) => c.category === "permit")) {
    assert.equal(t.hasRecipe, false, `${t.type} claims a recipe`);
    assert.equal(t.borrowedRecipe ?? null, null);
  }
});

await check("(A5) a run that BORROWED shows the borrow — even beside the AHJ's own draft; a COMPLETE own recipe then wins (what the next stage replays)", async () => {
  // Salem files on the same statewide portal (verified), with its own per-job lookup — the
  // shared-portal-reuse world, through the real writers.
  kb.saveVerifiedAhjProfile(db, { state: "OR", ahj: "City of Salem", portalUrl: ACA_OREGON, portalPlatform: "accela", verifiedBy: "test" });
  const pp = await import("../src/permitProcess");
  pp.savePermitProcessLookup(db, {
    state: "OR", ahj: "City of Salem", lookedUpAt: new Date().toISOString(),
    issuingAgency: { value: "City of Salem", sourceUrl: "https://salem.example.gov/permits", quote: "The City of Salem issues building permits", origin: "lookup" },
    permitStructure: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "not searched" },
    permits: [],
  } as never);
  fx.stubRunner(async () => ({ ok: true, finalSubmitClicked: false, steps: [{ ok: true, message: "reached review" }] }) as never);
  const pid = fx.newProject({ ahj: "City of Salem", city: "Salem", zip: "97301" });
  await repo.prepareSubmission(db, pid, "building");
  const borrowedFrom = JSON.parse(String(fx.latestRun(pid)?.result_json ?? "{}")).borrowedRecipe?.recipeId;
  assert.equal(borrowedFrom, coosStructural.id, "setup: the Salem stage did not borrow the Coos Bay recipe");
  // Salem's own draft appears after the run (a learn that did not verify).
  const own = ahjRecipe("City of Salem", "PGE", "structural", "Residential - Structural");
  recipes.savePortalRecipeSteps(db, own.id, steps("Residential - Structural"), { status: "needs_rerecord" });
  const building = card(pid, "building") ?? card(pid, "combo") ?? card(pid, "permit");
  assert.equal(building?.borrowedRecipe?.recipeId, coosStructural.id, `the borrow is hidden: ${JSON.stringify({ hasRecipe: building?.hasRecipe, recipeId: building?.recipeId, borrowed: building?.borrowedRecipe })}`);
  assert.equal(building?.hasRecipe, false);
  // MUST-PASS: once Salem's own recipe is COMPLETE, that is what the next stage replays — and what the card says.
  recipes.savePortalRecipeSteps(db, own.id, steps("Residential - Structural"), { status: "complete" });
  const after = card(pid, "building") ?? card(pid, "combo") ?? card(pid, "permit");
  assert.equal(after?.recipeId, own.id, "a stale borrow outranked the AHJ's own complete recipe");
  assert.equal(after?.borrowedRecipe ?? null, null);
});

// ── B. ONE UTILITY IS ONE UTILITY ──────────────────────────────────────────────────────────
await check("(B1) sameUtilityEntity: state-gated, anchored — MUST-PASS and MUST-EXCLUDE", () => {
  assert.equal(identity.sameUtilityEntity("OR", "PacifiCorp", "Pacific Power"), true);
  assert.equal(identity.sameUtilityEntity("Oregon", "PACIFICORP", "Pacific Power"), true);
  assert.equal(identity.sameUtilityEntity("UT", "Rocky Mountain Power", "PacifiCorp"), true);
  assert.equal(identity.sameUtilityEntity("OR", "PGE", "Portland General Electric"), true, "the predicate is generic, not PacifiCorp-only");
  assert.equal(identity.sameUtilityEntity("CA", "Pacific Gas and Electric", "Pacific Power"), false, "PG&E is not PacifiCorp");
  assert.equal(identity.sameUtilityEntity("CA", "PGE", "Portland General Electric"), false, "'PGE' outside Oregon is PG&E's spelling");
  assert.equal(identity.sameUtilityEntity("TX", "PacifiCorp", "Pacific Power"), false, "a state PacifiCorp does not serve");
  assert.equal(identity.sameUtilityEntity("", "PacifiCorp", "Pacific Power"), false, "an unknown state proves nothing");
  assert.equal(identity.sameUtilityEntity("WA", "Pacific County PUD", "Pacific Power"), false);
  assert.equal(identity.sameUtilityEntity("OR", "Idaho Power", "Idaho Power"), false, "unknown to the identity: the fuzzy scorer's question, not this one");
  // Its flip side: provably different only when the identity KNOWS BOTH sides and they differ
  // (a name it does not know is the fuzzy scorer's call — utilityIdentityBridges.test.ts I5).
  assert.equal(identity.provablyDifferentUtility("CA", "Pacific Gas and Electric", "Pacific Power"), true);
  assert.equal(identity.provablyDifferentUtility("OR", "PacifiCorp", "Pacific Power"), false);
  assert.equal(identity.provablyDifferentUtility("OR", "Idaho Power", "Umatilla Electric"), false, "neither known: not this predicate's call");
  assert.equal(identity.provablyDifferentUtility("", "Pacific Gas and Electric", "Pacific Power"), false, "an unknown state proves nothing");
});

const nemRecipe = (() => {
  const r = recipes.startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "Pacific Power", portalUrl: PACIFICORP_NM, portalPlatform: "powerclerk", createdBy: "test" });
  return recipes.savePortalRecipeSteps(db, r.id, [{ action: "goto", value: PACIFICORP_NM } as RecipeStep, fill(1), fill(2), REVIEW], { status: "needs_rerecord" });
})();

await check("(B2) THE POINT: a 'PacifiCorp' Oregon project resolves the 'Pacific Power' NEM recipe; PG&E and a non-served state do not", () => {
  assert.equal(recipes.findAnyRecipeForProject(db, { scopeType: "utility", state: "OR", utility: "PacifiCorp" })?.id, nemRecipe.id);
  assert.equal(recipes.findAnyRecipeForProject(db, { scopeType: "utility", state: "OR", utility: "Pacific Power" })?.id, nemRecipe.id, "MUST-PASS: the exact key");
  assert.equal(recipes.findAnyRecipeForProject(db, { scopeType: "utility", state: "CA", utility: "Pacific Gas and Electric" }), null);
  assert.equal(recipes.findAnyRecipeForProject(db, { scopeType: "utility", state: "TX", utility: "PacifiCorp" }), null);
});

await check("(A4) the NEM card of a 'PacifiCorp' project shows that recipe (it was blank)", () => {
  const pid = fx.newProject({ ahj: "City of Coos Bay", city: "Coos Bay", zip: "97420", utility: "PacifiCorp" });
  const nem = card(pid, "nem");
  assert.ok(nem, "setup: no NEM card");
  assert.equal(nem!.recipeId, nemRecipe.id);
  assert.equal(nem!.recipeStatus, "needs_rerecord");
});

await check("(B3) the KB fuzzy asks the same identity: a 'PacifiCorp' learn finds the 'Pacific Power' utility row", () => {
  // Washington and California: no project in this file ever stored "PacifiCorp" there, so there is
  // no exact-key row (Oregon has one — createProject's learnFromProject writes the project's own
  // spelling; that fork is reported, not fixed here) and the fuzzy branch is what answers.
  kb.saveVerifiedUtilityProfile(db, { state: "WA", utility: "Pacific Power", portalUrl: PACIFICORP_NM, portalPlatform: "powerclerk", verifiedBy: "test" });
  kb.saveVerifiedUtilityProfile(db, { state: "CA", utility: "Pacific Power", portalUrl: PACIFICORP_NM, portalPlatform: "powerclerk", verifiedBy: "test" });
  const hit = kb.findKnowledgeForLearn(db, { state: "WA", utility: "PacifiCorp" }).utility;
  assert.ok(hit && /pacific power/i.test(hit.utility) && /wa/i.test(String(hit.state)), `found ${hit?.utility ?? "nothing"} (${hit?.state ?? ""})`);
  const pge = kb.findKnowledgeForLearn(db, { state: "CA", utility: "Pacific Gas and Electric" }).utility;
  assert.ok(!pge || !/pacific power/i.test(pge.utility), `MUST-EXCLUDE: PG&E resolved to ${pge?.utility}`);
});

await check("(B4) startPortalRecording resets the row the caller resolved — no duplicate shared recipe", () => {
  const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_recipes")!.n;
  const reset = recipes.startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "PacifiCorp", portalUrl: PACIFICORP_NM, existingRecipeId: nemRecipe.id });
  assert.equal(reset.id, nemRecipe.id, "a new row was inserted beside the resolved one");
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_recipes")!.n, before);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_recipes WHERE profile_key = 'or|unknown|pacificorp'")!.n, 0);
  // Put the recipe back the way the learn below expects it (a draft with steps).
  recipes.savePortalRecipeSteps(db, nemRecipe.id, [{ action: "goto", value: PACIFICORP_NM } as RecipeStep, fill(1), REVIEW], { status: "needs_rerecord" });
});

await check("(B4') MUST-EXCLUDE: a resolved row of another scope / state / discipline is ignored (a wrong-row reset is worse than a duplicate)", () => {
  const coosStructuralBefore = fx.recipeRow(coosStructural.id);
  const other = recipes.startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", discipline: "electrical", portalUrl: ACA_OREGON, existingRecipeId: coosStructural.id });
  assert.notEqual(other.id, coosStructural.id, "an electrical recording reset the structural row");
  assert.equal(fx.recipeRow(coosStructural.id).version, coosStructuralBefore.version);
  const wrongState = recipes.startPortalRecording(db, { scopeType: "utility", state: "WA", utility: "Pacific Power", portalUrl: PACIFICORP_NM, existingRecipeId: nemRecipe.id });
  assert.notEqual(wrongState.id, nemRecipe.id, "a Washington recording reset the Oregon row");
  // Restore the electrical recipe's steps (the reset above wiped them).
  recipes.savePortalRecipeSteps(db, other.id, steps("Residential - Electrical"), { status: "complete" });
  // Another AGENCY's row (a county's, handed over for a city of a similar name) is not this AHJ's slot.
  const county = ahjRecipe("Marion County", "Pacific Power", "structural", "Residential - Structural");
  const city = recipes.startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj: "City of Marion", utility: "Pacific Power", discipline: "structural", portalUrl: ACA_OREGON, existingRecipeId: county.id });
  assert.notEqual(city.id, county.id, "a City of Marion recording reset Marion County's recipe");
  assert.equal(fx.recipeRow(county.id).version, county.version);
  // MUST-PASS: the same agency under a short spelling IS the slot ("Coos Bay" is "City of Coos Bay").
  const short = recipes.startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj: "Coos Bay", utility: "PacifiCorp", discipline: "structural", portalUrl: ACA_OREGON, existingRecipeId: coosStructural.id });
  assert.equal(short.id, coosStructural.id, "the same agency's resolved row was not reused");
  recipes.savePortalRecipeSteps(db, coosStructural.id, steps("Residential - Structural"), { status: "complete" });
});

// A UTILITY recipe row the fuzzy alias hands over is ANOTHER utility's whenever the names only
// contain each other ("Massachusetts Electric" is inside "Western Massachusetts Electric", 82).
// Fictional portal URLs; real-shaped utility names (the collision is in the names).
const utilityRecipe = (state: string, utility: string, portalUrl: string) => {
  const r = recipes.startPortalRecording(db, { scopeType: "utility", state, utility, portalUrl, portalPlatform: "powerclerk", createdBy: "test" });
  return recipes.savePortalRecipeSteps(db, r.id, [{ action: "goto", value: portalUrl } as RecipeStep, fill(1), fill(2), REVIEW], { status: "complete" });
};
const ownKey = (state: string, utility: string) => recipes.recipeProfileKey({ scopeType: "utility", state, utility });

await check("(B4'') MUST-EXCLUDE: a UTILITY learn never resets a fuzzy neighbour's recipe (Western Massachusetts Electric vs Massachusetts Electric; Penn Power vs West Penn Power)", () => {
  for (const [state, onFile, learning, onFileUrl, learnUrl] of [
    ["MA", "Massachusetts Electric", "Western Massachusetts Electric", "https://ma-electric.example.test/apply", "https://western-ma.example.test/apply"],
    ["PA", "West Penn Power", "Penn Power", "https://west-penn.example.test/apply", "https://penn-power.example.test/apply"],
  ] as const) {
    const neighbour = utilityRecipe(state, onFile, onFileUrl);
    const before = { ...fx.recipeRow(neighbour.id) };
    // The resolver really hands the neighbour's row over (fuzzy containment 82) — else this proves nothing.
    const resolved = recipes.findAnyRecipeForProject(db, { scopeType: "utility", state, utility: learning });
    assert.equal(resolved?.id, neighbour.id, `setup: the alias did not resolve ${learning} to ${onFile}`);
    const learned = recipes.startPortalRecording(db, { scopeType: "utility", state, utility: learning, portalUrl: learnUrl, createdBy: "test", existingRecipeId: resolved!.id });
    assert.notEqual(learned.id, neighbour.id, `a ${learning} learn reset ${onFile}'s recipe`);
    const after = fx.recipeRow(neighbour.id);
    assert.equal(after.version, before.version, `${onFile}'s version moved`);
    assert.equal(after.portal_url, onFileUrl, `${onFile}'s portal URL was overwritten`);
    assert.equal(after.steps_json, before.steps_json, `${onFile}'s steps were wiped`);
    assert.equal(after.status, "complete");
    // Base behaviour: the learning utility's OWN row, at its own key.
    const own = db.get<{ id: string; portal_url: string }>("SELECT id, portal_url FROM portal_recipes WHERE profile_key = ?", [ownKey(state, learning)]);
    assert.equal(own?.id, learned.id, `no row of ${learning}'s own was written`);
    assert.equal(own?.portal_url, learnUrl);
  }
});

await check("(B4''') MUST-PASS: the same utility under a short / brand name still reuses its row (identity or the same normalized name)", () => {
  const rmp = utilityRecipe("UT", "Rocky Mountain Power", PACIFICORP_NM);
  const n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_recipes WHERE scope_type = 'utility'")!.n;
  for (const alias of ["RMP", "Rocky Mtn Power", "PacifiCorp"]) {
    const v = Number(fx.recipeRow(rmp.id).version);
    const resolved = recipes.findAnyRecipeForProject(db, { scopeType: "utility", state: "UT", utility: alias });
    assert.equal(resolved?.id, rmp.id, `setup: ${alias} did not resolve the Rocky Mountain Power recipe`);
    const reset = recipes.startPortalRecording(db, { scopeType: "utility", state: "UT", utility: alias, portalUrl: PACIFICORP_NM, existingRecipeId: resolved!.id });
    assert.equal(reset.id, rmp.id, `${alias}: a duplicate row was inserted beside the resolved one`);
    assert.equal(Number(fx.recipeRow(rmp.id).version), v + 1);
  }
  // The same name, differently cased / punctuated, is the same slot too.
  const same = recipes.startPortalRecording(db, { scopeType: "utility", state: "UT", utility: "ROCKY MOUNTAIN POWER.", portalUrl: PACIFICORP_NM, existingRecipeId: rmp.id });
  assert.equal(same.id, rmp.id);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_recipes WHERE scope_type = 'utility'")!.n, n, "a utility row was added");
});

await check("(B5) THE LEARN DOOR: a real autoLearnPortal for a 'PacifiCorp' project writes the 'Pacific Power' row, inserts no 'pacificorp' recipe", async () => {
  autoLearn.setAutoLearnSeamsForTests({
    learnPortal: (async () => ({ ok: false, portalName: "stub", steps: [], reviewScreen: { fields: [], bodyTextSnippet: "" }, finalSubmitRecorded: false, pageCount: 0, pauseReason: null, message: "stub learn: nothing walked" })) as never,
  });
  // A resolved row with NO steps — so the learn's failure path reaches the recorder (a deeper
  // existing draft would be kept and nothing written, proving nothing).
  recipes.startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "Pacific Power", portalUrl: PACIFICORP_NM });
  const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_recipes WHERE scope_type = 'utility'")!;
  const versionBefore = Number(fx.recipeRow(nemRecipe.id).version);
  const pid = fx.newProject({ ahj: "City of Coos Bay", city: "Coos Bay", zip: "97420", utility: "PacifiCorp" });
  try {
    await autoLearn.autoLearnPortal(db, pid, { scope: "utility", portalUrl: PACIFICORP_NM, createdBy: "operator" });
  } catch { /* a refused / failed learn is fine — what it WROTE is the question */ }
  const forked = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_recipes WHERE profile_key = 'or|unknown|pacificorp'")!.n;
  const after = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_recipes WHERE scope_type = 'utility'")!.n;
  assert.equal(forked, 0, "the learn inserted a duplicate 'or|unknown|pacificorp' shared recipe");
  assert.equal(after, before.n, "a utility recipe row was added");
  // The learn DID reach the recorder, and the recorder reset THIS row (a refused or kept-draft learn
  // would leave the version alone and prove nothing).
  assert.equal(Number(fx.recipeRow(nemRecipe.id).version), versionBefore + 1, "the learn did not write the resolved 'Pacific Power' row");
  autoLearn.setAutoLearnSeamsForTests({ learnPortal: null });
});

finish("track-card-recipe");
