// PORTAL TRUTH (2026-09-28). A real filing (City of Corvallis OR) went to the WRONG portal: the
// per-job lookup found the city's own portal (www.corvallispermits.com, which lands on the city's
// own Accela tenant) and DROPPED it for want of attestation; the knowledge-base row held an Oregon
// BCD HELP page as its portal; staging fell to the STATEWIDE fallback (Oregon ePermitting), where
// Corvallis files no building permits ("No Building services were returned for this address");
// the learner saved a recipe keyed to Corvallis on that host; the track card said "Oregon
// ePermitting (Accela)". Every fix is an engine invariant for ANY state and ANY AHJ — every
// jurisdiction below is FICTIONAL, and each fix has a test that goes red without it.
//
//   D1 permitProcess.statewidePortalFor: the statewide fallback only on evidence the AHJ files there;
//      a portal the lookup NAMED (kept or not), a KB row / recipe / login naming its own tenant, or
//      any "files elsewhere" withholds it; nothing at all is "unknown, a person confirms".
//
// KILL TESTS (each disabled by hand and seen red — see the report for the banners):
//   K1 statewidePortalFor: an "elsewhere" item no longer withholds             → (d1-e1), (d1-p4) fail.
//   K2 statewidePortalFor: no evidence falls back to the state rule again       → (d1-e2), (d1-p5) fail.
//   K3 claimedPortalOf: the legacy "the portal <url> was never returned" parse off → (d1-e1), (d1-p1) fail.
//   K4 statewideEvidence: the issuing agency's own evidence not collected        → (d1-e3) fails.
//
// Run: npx tsx backend/test/portalTruth.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import type { CitedFact, RecipeStep } from "../../shared/src/types";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("portal-truth");
const { db, repo, recipes } = fx;
const pp = await import("../src/permitProcess");
const kb = await import("../src/knowledgeBase");
const evidence = await import("../src/statewideEvidence");

const ACA_OREGON = "https://aca-oregon.accela.com/oregon/";
const nf = (why = "not searched"): CitedFact<string> => ({ value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: why });
const cite = (value: string, sourceUrl: string, quote: string): CitedFact<string> => ({ value, sourceUrl, quote, origin: "lookup" });

// The donor every borrow case would reach for: a complete structural recipe learned for ANOTHER
// Oregon city on the statewide portal (the shape the statewide fallback used to lend).
const accelaSteps = (recordType: string): RecipeStep[] => [
  { action: "goto", value: `${ACA_OREGON}Dashboard.aspx`, note: "entry url" },
  { action: "fill", selector: { name: "f1" }, field: "streetNumber", note: "work location: street number" },
  { action: "check", selector: { label: recordType }, note: `record type: ${recordType}` },
  { action: "click", selector: { text: "Continue Application »" }, note: "record type: continue" },
  { action: "stopForReview", selector: {} } as RecipeStep,
];
const donor = (() => {
  const r = recipes.startPortalRecording(db, {
    scopeType: "ahj", state: "OR", ahj: "City of Donorvale", utility: "Pacific Power", portalUrl: ACA_OREGON,
    discipline: "structural", portalPlatform: "accela", createdBy: "test",
  });
  return recipes.savePortalRecipeSteps(db, r.id, accelaSteps("Residential - Structural"), { status: "complete" });
})();

/** Stage one fictional AHJ's BUILDING track; report whether any recipe drove the run and the audits. */
async function stageBuilding(ahj: string, city: string) {
  let replayed: string | null = null;
  fx.stubRunner(async (recipe) => { replayed = recipe.id; return { ok: true, finalSubmitClicked: false, steps: [{ ok: true, message: "reached review" }] }; });
  const projectId = fx.newProject({ ahj, city, zip: "97330", utility: "Pacific Power" });
  await repo.prepareSubmission(db, projectId, "building");
  const withheld = fx.audits("portal.statewide_withheld").find((x) => x.project_id === projectId);
  const taken = fx.audits("portal.statewide_taken").find((x) => x.project_id === projectId);
  return { projectId, replayed: replayed as string | null, withheld: withheld ? JSON.parse(withheld.details) as { reason: string } : null, taken: taken ? JSON.parse(taken.details) as { basis: string } : null };
}

// ── D1: pure ────────────────────────────────────────────────────────────────────────────────
await check("(d1-p1) the legacy refused-portal row names its claim: claimedPortalOf reads the door's own words, and the structured field", () => {
  assert.equal(pp.claimedPortalOf({ value: null, notFound: "the portal https://www.fernhollowpermits.example was never returned by the search, opened by the lookup, or linked by a page we read — not kept" }), "https://www.fernhollowpermits.example");
  assert.equal(pp.claimedPortalOf({ value: null, claimed: "https://permits.fernhollow.example/" }), "https://permits.fernhollow.example/");
  // MUST-EXCLUDE: an information page / a utility portal refusal names no claim; a kept value is not a claim.
  assert.equal(pp.claimedPortalOf({ value: null, notFound: "https://www.oregon.gov/bcd/epermitting/help/x.aspx is an information page, not an application portal — not kept" }), "");
  assert.equal(pp.claimedPortalOf({ value: "https://x.example/", notFound: "" }), "");
});
await check("(d1-p2) isStatewidePortalUrl: the statewide host and its aliases — never a city's own Accela tenant, never outside the state", () => {
  for (const u of [ACA_OREGON, "https://aca.oregon.gov/CitizenAccess/", "https://epermitting.oregon.gov/", "https://aca-oregon.accela.com/oregon/Cap/CapDetail.aspx?agencyCode=MARION_CO"]) assert.equal(pp.isStatewidePortalUrl("OR", u), true, u);
  for (const u of ["https://aca-prod.accela.com/CORVALLIS/Default.aspx", "https://www.corvallispermits.com", "https://www.oregon.gov/bcd/epermitting/help/records/pages/permit-for-solar.aspx"]) assert.equal(pp.isStatewidePortalUrl("OR", u), false, u);
  assert.equal(pp.isStatewidePortalUrl("WA", ACA_OREGON), false, "a state without a statewide rule has no statewide portal");
});
await check("(d1-p3) classifyChannelWords: MUST-PASS the state's e-permitting words; MUST-EXCLUDE another system, two channels, a bare 'Accela'", () => {
  for (const t of ["OR E-permitting", "e-permitting", "E-PERMITTING", "OR E Permitting", "Epermitting accela", "e-permitting (accela) for K Cty submit", "Oregon ePermitting (Accela)"]) {
    assert.equal(pp.classifyChannelWords("OR", t), "statewide", t);
  }
  assert.equal(pp.classifyChannelWords("OR", "Oregon City / ePermitting", ["oregon city"]), "statewide", "the AHJ's own name is not another channel");
  for (const t of ["Corvallis portal", "Tualatin Portal / OR E-Permitting", "Clackamas (EP) / OR E-Permitting (BP)", "https://aca-prod.accela.com/albany/Default.aspx",
    "Accela (e-permitting) Email for city submit", "EMAIL / https://hillsboro-or-us-projectdoxwebui.avolvecloud.com/User/Index", "OR E-permitting / WA Co Portal", "ACCELA for elec usps submit for struc"]) {
    assert.equal(pp.classifyChannelWords("OR", t), "elsewhere", t);
  }
  for (const t of ["Accela", "accela", "Beaverton", "", "see WA County for submit after land use approval"]) assert.equal(pp.classifyChannelWords("OR", t), "neutral", t);
  assert.equal(pp.classifyChannelWords("WA", "e-permitting"), "neutral", "no statewide rule, no statewide answer");
});
await check("(d1-p4) MUST-EXCLUDE: any 'elsewhere' withholds, even beside a statewide signal (negative outranks positive)", () => {
  const d = pp.statewidePortalFor({ state: "OR", ahj: "City of Nowhere Pure" }, "building", {
    processProfileMethod: "OR E-permitting",
    evidence: [{ kind: "elsewhere", source: "stored login", detail: "a stored login names aca-prod.accela.com/NOWHERE, City of Nowhere Pure's own tenant" }],
  });
  assert.equal(d?.url, null);
  assert.match(String(d?.withheld), /NOWHERE/);
});
await check("(d1-p5) MUST-EXCLUDE: nothing either way is 'unknown' — never the state rule; MUST-PASS: a seeded 'OR E-permitting' is evidence", () => {
  const none = pp.statewidePortalFor({ state: "OR", ahj: "City of Blank Pure" }, "building", {});
  assert.equal(none?.url, null);
  assert.match(String(none?.withheld), /^Unknown: nothing on file says City of Blank Pure files on Oregon ePermitting/);
  const seeded = pp.statewidePortalFor({ state: "OR", ahj: "City of Seeded Pure" }, "building", { processProfileMethod: "OR E-permitting" });
  assert.equal(seeded?.url, ACA_OREGON);
  assert.equal(pp.statewidePortalFor({ state: "WA", ahj: "City of Anywhere" }, "building", {}), null, "no statewide rule → null (not withheld)");
});

// ── D1: end to end through prepareSubmission ────────────────────────────────────────────────
await check("(d1-e1) MUST-EXCLUDE (Corvallis's shape): the lookup NAMED the city's own portal and did not keep it → the statewide portal is withheld, the reason names that portal, no borrow", async () => {
  const ahj = "City of Fernhollow";
  const page = "https://www.fernhollow.example.gov/ds/page/structural-building-permit";
  const named: CitedFact<string> = { value: null, sourceUrl: page, quote: "Apply online at www.fernhollowpermits.example.", origin: "lookup",
    notFound: "the portal https://www.fernhollowpermits.example was never returned by the search, opened by the lookup, or linked by a page we read — not kept" };
  pp.savePermitProcessLookup(db, {
    state: "OR", ahj, lookedUpAt: new Date().toISOString(),
    issuingAgency: nf("not stated"), permitStructure: nf(),
    permits: (["structural", "electrical"] as const).map((d) => ({ discipline: d, label: d, issuingAgency: nf(), portalUrl: named, recordType: nf(), documents: nf(), fee: nf() })),
  } as never);
  const r = await stageBuilding(ahj, "Fernhollow");
  assert.equal(r.replayed, null, "a recipe learned for another city on the statewide portal drove the run");
  assert.equal(r.taken, null, "the statewide portal was taken");
  assert.ok(r.withheld, "the withheld fallback is audited");
  assert.match(r.withheld!.reason, /fernhollowpermits\.example/, r.withheld!.reason);
  assert.match(r.withheld!.reason, /A person confirms City of Fernhollow's portal/);
});
await check("(d1-e2) MUST-EXCLUDE: no evidence at all (no lookup, no profile, no row) → unknown, a person confirms — never the statewide portal", async () => {
  const r = await stageBuilding("City of Quietmoor", "Quietmoor");
  assert.equal(r.replayed, null);
  assert.equal(r.taken, null);
  assert.match(String(r.withheld?.reason), /^Unknown: nothing on file says City of Quietmoor files on Oregon ePermitting/);
});
await check("(d1-e3) MUST-PASS (Jefferson / Marion County's shape): the city's permits are issued by a county whose own knowledge-base row files on the statewide portal → taken, borrowed", async () => {
  const ahj = "City of Wrenfield";
  const county = "Wrenfield County";
  const agency = cite(county, "https://www.wrenfield.example.or.us/building", `All building and electrical permits are submitted to ${county}`);
  pp.savePermitProcessLookup(db, {
    state: "OR", ahj, lookedUpAt: new Date().toISOString(), issuingAgency: agency, permitStructure: nf(),
    permits: (["structural", "electrical"] as const).map((d) => ({ discipline: d, label: d, issuingAgency: agency, portalUrl: nf("no portal named"), recordType: nf(), documents: nf(), fee: nf() })),
  } as never);
  // The county's own row, written through the real research write path (seeded).
  kb.saveResearchedAhjProfile(db, { state: "OR", ahj: county }, {
    provider: "claude", portalName: "", portalPlatform: "Accela", portalUrl: "https://aca-oregon.accela.com/oregon/Cap/CapDetail.aspx?Module=Building&agencyCode=WRENFIELD_CO",
    submissionMethod: "online portal", requiredDocuments: [], commonCorrections: [], tips: [], submissionSteps: [], confidence: "medium",
    needsHumanVerification: true, notes: "", webGrounded: true,
  } as never);
  const ev = evidence.statewideEvidenceFor(db, { state: "OR", ahj, city: "Wrenfield" }, "building");
  assert.ok(ev.some((e) => e.kind === "statewide" && /issuing agency Wrenfield County/.test(e.detail)), JSON.stringify(ev));
  const r = await stageBuilding(ahj, "Wrenfield");
  assert.equal(r.withheld, null, `withheld: ${r.withheld?.reason}`);
  assert.ok(r.taken, "the statewide portal is taken on the county's evidence");
  assert.equal(r.replayed, donor.id, "the statewide donor recipe drove the run");
});
await check("(d1-e4) MUST-EXCLUDE: a stored login naming the AHJ's own tenant on a shared instance withholds the statewide portal", async () => {
  const creds = await import("../src/portalCredentials");
  process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "portal-truth-test-key-0123456789abcdef";
  creds.createPortalCredential(db, fx.client.id, { portalType: "accela_birchmoor", portalUrl: "https://aca-prod.accela.com/BIRCHMOOR/Default.aspx", username: "ops", password: "not-a-real-secret" });
  const ev = evidence.statewideEvidenceFor(db, { state: "OR", ahj: "City of Birchmoor", city: "Birchmoor", clientId: fx.client.id }, "building");
  assert.ok(ev.some((e) => e.kind === "elsewhere" && /BIRCHMOOR/.test(e.detail)), JSON.stringify(ev));
  const d = pp.statewidePortalFor({ state: "OR", ahj: "City of Birchmoor" }, "building", { processProfileMethod: "OR E-permitting", evidence: ev });
  assert.equal(d?.url, null, "the city's own tenant outranks a seeded 'OR E-permitting'");
});

finish("portal-truth");
