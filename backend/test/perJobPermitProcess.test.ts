// PER-JOB PERMIT PROCESS — B1 (tracks), B2 (portal), B3 (first-time borrow on a shared statewide
// portal), and the NEM-inside-a-permit-portal carve-out (operator ruling 2026-09-25).
//
// Engine invariants, never a jurisdiction patch: every case below uses a FICTIONAL Oregon AHJ the
// product has no row for ("City of Alderbrook"), because the bug was "an Oregon AHJ nobody has
// seen yet": one combo track, a help page taken for a portal, and no borrow.
//
// Everything is written through the real writers (savePermitProcessLookup, startPortalRecording +
// savePortalRecipeSteps, saveVerifiedUtilityProfile / saveResearchedUtilityProfile), and the
// end-to-end cases drive the real prepareSubmission with only the browser stubbed.
//
// KILL TESTS (each verified red by hand before the fix landed — the test was written first):
//   K1 applicationDocs.permitStructureWithBasis: drop the cited state rule   → (t1) fails.
//   K2 portalChannel.hostFitsTrackAndEntity: drop the not_a_portal check      → (p2), (p3) fail.
//   K3 repository: statewide fallback still gated on a seeded process profile → (p3) fails.
//   K4 portalRecipes.findBorrowableRecipe: ignore the looked-up record type   → (b2) fails.
//   K5 hostFitsTrackAndEntity: carve-out by HOST instead of host+tenant, or
//      from any verified row instead of the utility's own                     → (n3)/(n4) fail.
//
// Run: npx tsx backend/test/perJobPermitProcess.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import type { RecipeStep } from "../../shared/src/types";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("per-job-permit-process");
const { db, repo, recipes } = fx;
const kb = await import("../src/knowledgeBase");
const chan = await import("../src/portalChannel");
const pp = await import("../src/permitProcess");
const tracks = await import("../src/submittalTracks");
const appDocs = await import("../src/applicationDocs");

const ACA_OREGON = "https://aca-oregon.accela.com/oregon/";
const BCD_HELP = "https://www.oregon.gov/bcd/epermitting/help/records/pages/permit-for-solar.aspx";
const AHJ = "City of Alderbrook";

const REVIEW = { action: "stopForReview", selector: {} } as RecipeStep;
const accelaSteps = (recordType: string): RecipeStep[] => [
  { action: "goto", value: `${ACA_OREGON}Dashboard.aspx`, note: "entry url" },
  { action: "fill", selector: { name: "f1" }, field: "streetNumber", note: "work location: street number" },
  { action: "check", selector: { label: recordType }, note: `record type: ${recordType}` },
  { action: "click", selector: { text: "Continue Application »" }, note: "record type: continue" },
  REVIEW,
];
function ahjRecipe(input: { ahj: string; portalUrl: string; discipline: string; steps: RecipeStep[]; status?: "complete" | "needs_rerecord" }) {
  const r = recipes.startPortalRecording(db, {
    scopeType: "ahj", state: "OR", ahj: input.ahj, utility: "Pacific Power", portalUrl: input.portalUrl,
    discipline: input.discipline, portalPlatform: "accela", createdBy: "test",
  });
  return recipes.savePortalRecipeSteps(db, r.id, input.steps, { status: input.status ?? "complete" });
}
const project = (ahj: string, state = "OR") => ({ id: "p", clientId: null, state, ahj, city: ahj, utility: "Pacific Power", parserSnapshot: {} }) as never;

// ── B1: tracks ──────────────────────────────────────────────────────────────────────────
await check("(t1) MUST-PASS: an Oregon AHJ with no row files NEM + STRUCTURAL + ELECTRICAL, cited to OAR 918-050-0180", () => {
  assert.deepEqual(tracks.requiredTracks(project(AHJ)), ["nem", "building", "electrical"]);
  const basis = appDocs.permitStructureWithBasis(project(AHJ)).basis;
  assert.match(basis, /918-050-0180/, basis);
});
await check("(t2) MUST-EXCLUDE: outside Oregon (no cited state rule) an unknown AHJ keeps one permit track", () => {
  assert.deepEqual(tracks.requiredTracks(project("City of Alderbrook", "WA")), ["nem", "combo"]);
});
await check("(t3) MUST-EXCLUDE: the AHJ's own looked-up answer outranks the state rule (combo stays combo)", () => {
  pp.savePermitProcessLookup(db, {
    state: "OR", ahj: "City of Combo Falls", lookedUpAt: new Date().toISOString(),
    issuingAgency: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "not searched" },
    permitStructure: { value: "combo", sourceUrl: "https://combofalls.example.gov/solar", quote: "one combination permit covers building and electrical", origin: "lookup" },
    permits: [],
  });
  assert.deepEqual(tracks.requiredTracks(project("City of Combo Falls")), ["nem", "combo"]);
});
await check("(t4) a lookup never overwrites a person's verified answer (hard rule 3)", () => {
  const base = {
    state: "OR", ahj: "City of Verified Grove", lookedUpAt: new Date().toISOString(),
    issuingAgency: { value: "Verified County", sourceUrl: "https://v.example.gov", quote: "q", origin: "operator" as const },
    permitStructure: { value: "separate" as const, sourceUrl: "https://v.example.gov", quote: "q", origin: "operator" as const },
    permits: [],
  };
  assert.equal(pp.savePermitProcessLookup(db, { ...base, confidence: "verified" }, { verifiedBy: "user-1" }).saved, true);
  const second = pp.savePermitProcessLookup(db, { ...base, permitStructure: { ...base.permitStructure, value: "combo" } });
  assert.equal(second.saved, false);
  assert.match(second.reason, /verified/);
  assert.equal(pp.permitProcessFor(project("City of Verified Grove"))?.permitStructure.value, "separate");
});
await check("(t5) MUST-EXCLUDE: the name match is exact — 'City of Jefferson' never reads 'Jefferson County' answers", () => {
  pp.savePermitProcessLookup(db, {
    state: "OR", ahj: "Jefferson County", lookedUpAt: new Date().toISOString(),
    issuingAgency: { value: "Jefferson County", sourceUrl: "https://example.gov", quote: "q", origin: "lookup" },
    permitStructure: { value: "combo", sourceUrl: "https://example.gov", quote: "q", origin: "lookup" },
    permits: [],
  });
  assert.equal(pp.permitProcessFor(project("City of Jefferson")), null);
  assert.equal(pp.permitProcessFor(project("Jefferson County, OR"))?.issuingAgency.value, "Jefferson County");
});

// ── B2: an information page is never a portal ─────────────────────────────────────────────
await check("(p1) the portal predicate: help pages, PDFs and SharePoint content pages are not portals; portals are", () => {
  for (const u of [BCD_HELP, "https://www.co.marion.or.us/PW/BuildingInspection/Pages/ApplicationsandBrochures.aspx",
    "https://www.oregon.gov/bcd/Formslibrary/5952.pdf", "https://www.cityofexample.gov/building/faq/solar"]) {
    assert.equal(chan.isInformationalPageUrl(u), true, u);
  }
  for (const u of [ACA_OREGON, "https://aca-prod.accela.com/CHINO/Default.aspx", "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login",
    "https://devhub.portlandoregon.gov/", "https://permits.cityofexample.gov/CitizenAccess/Default.aspx", "https://www.cityofexample.gov/building/permits"]) {
    assert.equal(chan.isInformationalPageUrl(u), false, u);
  }
  const fit = chan.hostFitsTrackAndEntity("building", null, BCD_HELP, "kb");
  assert.equal(fit.code, "not_a_portal");
});

// The world for p2/p3/b*: Coos Bay learned structural + electrical on the statewide portal; a
// junk draft for Alderbrook was saved on BCD's help page (the shape of recipe 8da3e644).
const coosStructural = ahjRecipe({ ahj: "City of Coos Bay", portalUrl: ACA_OREGON, discipline: "structural", steps: accelaSteps("Residential - Structural") });
ahjRecipe({ ahj: "City of Coos Bay", portalUrl: ACA_OREGON, discipline: "electrical", steps: accelaSteps("Residential - Electrical") });
const junk = ahjRecipe({ ahj: AHJ, portalUrl: BCD_HELP, discipline: "structural", status: "needs_rerecord", steps: [{ action: "goto", value: BCD_HELP, note: "entry url" }] });

await check("(p2) MUST-EXCLUDE: a junk recipe saved on a help page does not make that page the AHJ's own portal", () => {
  const ent = recipes.portalEntityEvidence(db, { scope: "ahj", state: "OR", name: AHJ })!;
  assert.deepEqual(ent.ownPortals, [], JSON.stringify(ent.ownPortals));
  assert.equal(recipes.recipeHostFit("building", ent, junk).code, "not_a_portal");
});

await check("(p3) MUST-PASS end-to-end: a first-time Oregon AHJ's STRUCTURAL stage resolves the statewide portal and replays the Coos Bay structural recipe (never the help page)", async () => {
  let replayed: string | null = null;
  fx.stubRunner(async (recipe) => { replayed = recipe.id; return { ok: true, finalSubmitClicked: false, steps: [{ ok: true, message: "reached review" }] }; });
  const projectId = fx.newProject({ ahj: AHJ, city: "Alderbrook", zip: "97350", utility: "Pacific Power" });
  assert.deepEqual(tracks.requiredTracks(repo.getProjectDetail(db, projectId).project), ["nem", "building", "electrical"]);
  await repo.prepareSubmission(db, projectId, "building");
  assert.equal(replayed, coosStructural.id, "the Coos Bay structural recipe drove the run");
  const result = JSON.parse(String(fx.latestRun(projectId)!.result_json));
  assert.equal(result.borrowedRecipe?.recordType, "Residential - Structural");
  const stage = db.get<{ current_stage: string }>("SELECT current_stage FROM projects WHERE id = ?", [projectId])!.current_stage;
  assert.match(stage, /Filled from the City of Coos Bay structural recipe \(record type "Residential - Structural"/);
});

// ── B3: the per-job lookup's record type is a precondition of the borrow ──────────────────
const decide = (track: string, ahj: string, targetRecordType = "") => recipes.findBorrowableRecipe(db, {
  track, state: "OR", ahj, targetPortalUrl: ACA_OREGON, targetSource: "statewide", targetRecordType,
  entity: recipes.portalEntityEvidence(db, { scope: "ahj", state: "OR", name: ahj }),
});
await check("(b1) MUST-PASS: the looked-up record type matching the donor's ('Residential Structural' ≈ 'Residential - Structural') lends", () => {
  assert.equal(decide("building", "City of Birchport", "Residential Structural").choice?.recipe.id, coosStructural.id);
});
await check("(b2) MUST-EXCLUDE: a looked-up record type that differs from the donor's refuses the borrow with a named reason", () => {
  const d = decide("building", "City of Birchport", "Commercial Structural");
  assert.equal(d.choice, null);
  assert.ok(d.rejected.some((r) => /per-job lookup found/.test(r.why)), JSON.stringify(d.rejected));
});

// ── NEM inside a permit portal: only via the utility's own VERIFIED record ─────────────────
const CS_SPANISH_FORK = "https://www.citizenserve.com/Portal/PortalController?Action=showHomePage&installationID=301";
const CS_OTHER_TENANT = "https://www.citizenserve.com/Portal/PortalController?Action=showHomePage&installationID=999";
const nemFit = (utility: string, url: string) =>
  chan.hostFitsTrackAndEntity("nem", recipes.portalEntityEvidence(db, { scope: "utility", state: "UT", name: utility }), url, "kb");
const research = (portalUrl: string) => ({
  provider: "claude" as const, portalName: "", portalPlatform: "", portalUrl, submissionMethod: "online portal",
  requiredDocuments: [], commonCorrections: [], tips: [], submissionSteps: [], confidence: "medium" as const,
  needsHumanVerification: true as const, notes: "", webGrounded: true,
});
await check("(n1) MUST-EXCLUDE: a SEEDED Spanish Fork utility row naming its citizenserve portal is refused, with the named reason", () => {
  kb.saveResearchedUtilityProfile(db, { state: "UT", utility: "Spanish Fork City Power" }, research(CS_SPANISH_FORK) as never);
  const f = nemFit("Spanish Fork City Power", CS_SPANISH_FORK);
  assert.equal(f.fits, false);
  assert.match(f.reason, /human-VERIFIED record names that exact portal/);
});
await check("(n2) MUST-EXCLUDE: the AHJ's verified PERMIT row for that portal does not unlock the NEM track", () => {
  kb.saveVerifiedAhjProfile(db, { state: "UT", ahj: "Spanish Fork", utility: "Spanish Fork City Power", portalUrl: CS_SPANISH_FORK, verifiedBy: "test" });
  assert.equal(nemFit("Spanish Fork City Power", CS_SPANISH_FORK).fits, false);
});
await check("(n3) MUST-PASS: the utility's own VERIFIED row naming the citizenserve portal opens it on the NEM track", () => {
  kb.saveVerifiedUtilityProfile(db, { state: "UT", utility: "Spanish Fork City Power", portalUrl: CS_SPANISH_FORK, portalPlatform: "citizenserve", verifiedBy: "test" });
  const f = nemFit("Spanish Fork City Power", CS_SPANISH_FORK);
  assert.equal(f.fits, true, f.reason);
  // …the same host, another TENANT, stays shut.
  assert.equal(nemFit("Spanish Fork City Power", CS_OTHER_TENANT).fits, false);
});
await check("(n4) MUST-EXCLUDE: a verified row for a DIFFERENT utility on that host unlocks nothing for this one", () => {
  kb.saveVerifiedUtilityProfile(db, { state: "UT", utility: "Lehi City Power", portalUrl: CS_OTHER_TENANT, verifiedBy: "test" });
  assert.equal(nemFit("Provo City Power", CS_OTHER_TENANT).fits, false);
  assert.equal(nemFit("Provo City Power", CS_SPANISH_FORK).fits, false);
  // Spanish Fork's own verification names tenant 301 — Lehi's verified tenant 999 stays shut to it.
  assert.equal(nemFit("Spanish Fork City Power", CS_OTHER_TENANT).fits, false);
});
await check("(n5) MUST-EXCLUDE: aca-oregon on a Pacific Power NEM track is still refused", () => {
  const f = chan.hostFitsTrackAndEntity("nem", recipes.portalEntityEvidence(db, { scope: "utility", state: "OR", name: "Pacific Power" }), ACA_OREGON, "kb");
  assert.equal(f.fits, false);
  assert.equal(f.code, "track_conflict");
});
await check("(n6) a permit track never gains the mirror carve-out (rule 5)", () => {
  const f = chan.hostFitsTrackAndEntity("building", recipes.portalEntityEvidence(db, { scope: "ahj", state: "OR", name: AHJ }), "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login", "kb");
  assert.equal(f.code, "track_conflict");
});

// ── The permit planner's KB context never names the utility's portal (item 10) ──────────────
await check("(k1) MUST-EXCLUDE: an AHJ row carrying the utility's PowerClerk is not handed to the PERMIT planner as its portal", async () => {
  const autoLearn = await import("../src/autoLearn");
  kb.saveResearchedAhjProfile(db, { state: "OR", ahj: "City of Pinecrest", utility: "Pacific Power" }, research("https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login") as never);
  const ctx = autoLearn.buildLearnKbContext(db, project("City of Pinecrest") as never, { scopeType: "ahj", permitType: "structural" });
  assert.doesNotMatch(ctx, /powerclerk/i, ctx.slice(0, 400));
  kb.saveResearchedAhjProfile(db, { state: "OR", ahj: "City of Larchmont" }, research(ACA_OREGON) as never);
  assert.match(autoLearn.buildLearnKbContext(db, project("City of Larchmont") as never, { scopeType: "ahj", permitType: "structural" }), /aca-oregon/, "MUST-PASS: the AHJ's own portal is named");
});

finish("per-job-permit-process");
