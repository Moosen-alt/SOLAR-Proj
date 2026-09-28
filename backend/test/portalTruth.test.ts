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
//   D2 every KB portal_url write refuses an information page (isInformationalPageUrl); the generic
//      fallback profile never writes its portal into an AHJ's row; reads never return a legacy one.
//   D3 a named portal that REDIRECTS to the AHJ's own host is kept as the landing, with the evidence.
//   D4 the channel label is the resolved portal's HOST (permitChannelLabel), never free text.
//   D5 a portal saying "not served here" stops the learn / replay; nothing is kept under the AHJ.
//      (The browser half: portal-bot/src/adapters/notServed.dom.smoke.ts, K9/K10.)
//
// KILL TESTS (each disabled by hand and seen red):
//   K1 statewidePortalFor: an "elsewhere" item no longer withholds             → (d1-e1), (d1-p4), (d1-e4) fail.
//   K2 statewidePortalFor: no evidence falls back to the state rule again       → (d1-e2), (d1-p5), perJob (p3x) fail.
//   K3 claimedPortalOf: the legacy "the portal <url> was never returned" parse off → (d1-e1), (d1-p1) fail.
//   K4 statewideEvidence: the issuing agency's own evidence not collected        → (d1-e3) fails.
//   K5 upsertKnowledge: the information-page door off                           → (d2-w2) fails.
//   K6 portalFromProject: the fallback profile's portal fields written again      → (d2-w1) fails.
//   K7 saveVerified*: the loud 409 refusal off                                   → (d2-w3) fails.
//   K8 withoutInformationalPortal off (reads return the legacy help page)         → (d2-r1) fails.
//   K11 autoLearn: the not-served branch off                                     → (d5-l1), (d5-l2) fail.
//   K12 repository: the replay's not-served branch off (drift classifier instead) → (d5-r1) fails.
//   K13 portalEntityEvidence: a refused recipe still claims its host              → (d5-l1) fails.
//   K14 repository: a refused draft still lends its URL                          → (d5-l2) fails.
//   K15 recordPortalNotServed: flags the key's row on ANY host                   → (d5-l3) fails.
//   K16 lookup: the redirect is read but never kept                              → (d3-p1) fails.
//   K17 landingNamesJurisdiction always true                                     → (d3-x1) fails.
//   K18 lookup: a parse-time claim is not re-judged at the final door            → (d3-p1), (d3-x1), (d3-x3) fail.
//   K19 describePermitType: an Oregon profile's words earn "Oregon ePermitting"  → (d4-p2), (d4-e3) fail.
//   K20 permitChannelLabel: any accela.com host labelled statewide               → (d4-p1), (d4-p2), (d4-e1) fail.
//   K21 channelResolution: a person's verified portal no longer first            → (d4-e2) fails.
//   K22 the card's verified read filtered to utility-less rows (the live Corvallis row has one) → (d4-e1) fails.
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

// ── D2: an information page is never written — or read — as a portal ─────────────────────────
const BCD_HELP = "https://www.oregon.gov/bcd/epermitting/help/records/pages/permit-for-solar.aspx";
const kbRow = (ahj: string) => db.get<{ portal_url: string; portal_name: string; notes: string }>(
  "SELECT portal_url, portal_name, notes FROM permit_utility_knowledge WHERE ahj = ? AND state = 'OR' ORDER BY updated_at DESC LIMIT 1", [ahj]);
const research = (portalUrl: string) => ({
  provider: "claude" as const, portalName: "", portalPlatform: "", portalUrl, submissionMethod: "online portal",
  requiredDocuments: [], commonCorrections: [], tips: [], submissionSteps: [], confidence: "medium" as const,
  needsHumanVerification: true as const, notes: "", webGrounded: true,
});
await check("(d2-w1) MUST-EXCLUDE: a project saved for an Oregon AHJ with no profile of its own does not write the GENERIC fallback's portal name or help page into that AHJ's row", async () => {
  fx.newProject({ ahj: "City of Mossbank", city: "Mossbank", zip: "97330" });
  const row = kbRow("City of Mossbank");
  assert.ok(row, "the project's learn wrote the AHJ row");
  assert.equal(row!.portal_url, "", `portal_url: ${row!.portal_url}`);
  assert.doesNotMatch(row!.portal_name, /Oregon ePermitting/i, `portal_name: ${row!.portal_name}`);
});
await check("(d2-w2) MUST-EXCLUDE: research and the reference import never land a help page or a document as portal_url — the refused URL is kept as a note segment", () => {
  kb.saveResearchedAhjProfile(db, { state: "OR", ahj: "City of Larkspur Falls" }, research(BCD_HELP) as never);
  const r1 = kbRow("City of Larkspur Falls")!;
  assert.equal(r1.portal_url, "");
  assert.match(r1.notes, /Refused as a portal URL: https:\/\/www\.oregon\.gov\/bcd\/epermitting\/help/);
  kb.importSeededAhjKnowledge(db, { state: "OR", ahj: "City of Tamarack Bend", portalUrl: "https://www.tamarackbend.example.gov/files/solar-permit-application.pdf", sourceLabel: "test sheet" });
  assert.equal(kbRow("City of Tamarack Bend")!.portal_url, "");
});
await check("(d2-w3) MUST-EXCLUDE: a person's verified save naming a help page is refused out loud (409 not_a_portal); MUST-PASS: the AHJ's own portal saves verified", () => {
  assert.throws(() => kb.saveVerifiedAhjProfile(db, { state: "OR", ahj: "City of Quillmont", portalUrl: BCD_HELP, verifiedBy: "test" }), (e: unknown) => {
    const err = e as { status?: number; statusCode?: number; message?: string };
    return (err.status ?? err.statusCode) === 409 && /information page/.test(String(err.message));
  });
  assert.ok(!kbRow("City of Quillmont"), "nothing was written");
  kb.saveVerifiedAhjProfile(db, { state: "OR", ahj: "City of Quillmont", portalUrl: "https://aca-prod.accela.com/QUILLMONT/Default.aspx", verifiedBy: "test" });
  assert.equal(kbRow("City of Quillmont")!.portal_url, "https://aca-prod.accela.com/QUILLMONT/Default.aspx");
});
await check("(d2-r1) MUST-EXCLUDE: a row written BEFORE the door (a help page in portal_url) is never returned as a portal by findLearnedProfileForProject / findKnowledgeForLearn; the row itself is untouched", () => {
  const now = new Date().toISOString();
  db.run(`INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, portal_name, portal_url, required_documents_json, confidence, sources_json, notes, first_seen_at, last_learned_at, updated_at)
          VALUES (?, ?, 'OR', 'City of Oldrow', '', 'Oregon ePermitting', ?, '["Plan set"]', 'learned', '[]', '', ?, ?, ?)`,
    ["legacy-oldrow", kb.knowledgeProfileKey({ state: "OR", ahj: "City of Oldrow", utility: "" }), BCD_HELP, now, now, now]);
  const learned = kb.findLearnedProfileForProject(db, { state: "OR", ahj: "City of Oldrow" });
  assert.ok(learned, "the row still serves its documents");
  assert.equal(learned!.portalUrl, "");
  assert.equal(kb.findKnowledgeForLearn(db, { state: "OR", ahj: "City of Oldrow" }).ahj?.portalUrl, "");
  assert.equal(kbRow("City of Oldrow")!.portal_url, BCD_HELP, "reads never write");
});
await check("(d2-p1) MUST-PASS: a real portal writes through the same door unchanged", () => {
  kb.saveResearchedAhjProfile(db, { state: "OR", ahj: "City of Hazelmere" }, research("https://aca-prod.accela.com/HAZELMERE/Default.aspx") as never);
  assert.equal(kbRow("City of Hazelmere")!.portal_url, "https://aca-prod.accela.com/HAZELMERE/Default.aspx");
});

// ── D5: a portal that says "not served here" keeps nothing under the AHJ ───────────────────────
const notServed = await import("../../shared/src/portalNotServed");
const autoLearn = await import("../src/autoLearn");
const NOT_SERVED = "No Building services were returned for this address.";
await check("(d5-p1) the one predicate: MUST-PASS the refusals of THIS address / jurisdiction; MUST-EXCLUDE an empty search, a maintenance notice, a landing page's general words", () => {
  for (const t of [
    `Select a Record Type ${NOT_SERVED} Continue Application`,
    "No Electrical services were returned for this address.",
    "The address you entered is outside the City's jurisdiction.",
    "This parcel is not within our service area.",
    "Fernhollow is not a participating jurisdiction in this system.",
    "This jurisdiction does not participate in Oregon ePermitting.",
    "The county does not issue building permits for this address.",
    "This address is not served by this agency.",
  ]) assert.ok(notServed.portalSaysNotServed(t), `must refuse: ${t}`);
  assert.equal(notServed.portalSaysNotServed(`123 Test St results ${NOT_SERVED}`), NOT_SERVED, "the quote starts at the portal's words — never the text before them");
  for (const t of [
    "No records were returned for this search.", "No permits found for this record.", "Your search returned no results.",
    "Online services are not available between 11 PM and 1 AM.", "For addresses outside our jurisdiction, contact the county.",
    "This property is outside the floodplain boundary.", "Building Services | Planning Services | Contact us", "",
    "The city does not participate in the Wattsmart Battery program.", "No, I will not be participating in the battery program.",
  ]) assert.equal(notServed.portalSaysNotServed(t), null, `must NOT refuse: ${t}`);
});

let learnResult: Record<string, unknown> = {};
autoLearn.setAutoLearnSeamsForTests({ learnPortal: (async () => ({ ...learnResult })) as never });
const learnSteps = (): RecipeStep[] => [
  { action: "goto", value: `${ACA_OREGON}Dashboard.aspx`, note: "entry url" },
  { action: "fill", selector: { name: "sn" }, field: "streetNumber", value: "953", note: "work location: street number" },
  { action: "click", selector: { text: "Search" }, note: "work location: search" },
  { action: "click", selector: { css: "[data-al-row=\"ar0\"]" }, note: "address version: County Applications" },
];
const recipeRowsFor = (ahj: string) => db.query<{ id: string; portal_url: string; status: string; steps_json: string; flag_reason: string; discipline: string }>(
  "SELECT id, portal_url, status, steps_json, flag_reason, discipline FROM portal_recipes WHERE ahj = ?", [ahj]);
await check("(d5-l1) MUST-EXCLUDE (Corvallis's shape): a learn the statewide portal refused keeps NOTHING learned there — a refused row (no steps, flagged with the portal's words), never the AHJ's own portal, and the statewide fallback is withheld on it", async () => {
  const ahj = "City of Glenmarsh";
  learnResult = { ok: false, portalName: "stub", steps: learnSteps(), reviewScreen: { fields: [], bodyTextSnippet: "" }, finalSubmitRecorded: false, pageCount: 5, pauseReason: null,
    message: `Stopped: aca-oregon.accela.com says this address is not served there — "${NOT_SERVED}".`, notServed: NOT_SERVED, stopReason: "not_served" };
  const projectId = fx.newProject({ ahj, city: "Glenmarsh", zip: "97330", utility: "Pacific Power" });
  const res = await autoLearn.autoLearnPortal(db, projectId, { scope: "ahj", portalUrl: ACA_OREGON, urlSource: "statewide", createdBy: "auto-seed (staging)", permitType: "structural", discipline: "structural" });
  assert.equal(res.status, "failed");
  assert.match(res.message, /says this address is not served there/);
  const rows = recipeRowsFor(ahj);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0].steps_json, "[]", "no learned step is kept under the AHJ");
  assert.equal(rows[0].status, "needs_rerecord");
  assert.ok(rows[0].flag_reason.startsWith(notServed.NOT_SERVED_FLAG_PREFIX), rows[0].flag_reason);
  assert.match(rows[0].flag_reason, /No Building services were returned/);
  const ent = recipes.portalEntityEvidence(db, { scope: "ahj", state: "OR", name: ahj })!;
  assert.deepEqual(ent.ownPortals, [], "the refusing host is not the AHJ's own portal");
  const ev = evidence.statewideEvidenceFor(db, { state: "OR", ahj, city: "Glenmarsh" }, "building");
  assert.ok(ev.some((e) => e.kind === "elsewhere" && /not served there/.test(e.detail)), JSON.stringify(ev));
  // Even with a seeded "OR E-permitting", the portal's own refusal withholds the fallback.
  assert.equal(pp.statewidePortalFor({ state: "OR", ahj }, "building", { processProfileMethod: "OR E-permitting", evidence: ev })?.url, null);
});
await check("(d5-l2) MUST-EXCLUDE end to end: the next stage neither lends the refused host as a draft nor borrows onto it", async () => {
  const ahj = "City of Glenmarsh";
  // Positive evidence for the statewide portal on the lookup — the refusal must still win.
  pp.savePermitProcessLookup(db, {
    state: "OR", ahj, lookedUpAt: new Date().toISOString(), issuingAgency: cite(ahj, "https://glenmarsh.example.gov/permits", `The ${ahj} issues building permits`), permitStructure: nf(),
    permits: [{ discipline: "structural", label: "structural", issuingAgency: cite(ahj, "https://glenmarsh.example.gov/permits", `The ${ahj} issues building permits`),
      portalUrl: cite(ACA_OREGON, "https://glenmarsh.example.gov/permits", "Apply online through Oregon ePermitting (aca-oregon.accela.com)"), recordType: nf(), documents: nf(), fee: nf() }],
  } as never);
  const r = await stageBuilding(ahj, "Glenmarsh");
  assert.equal(r.replayed, null, "a recipe drove the run on the host that refused this AHJ");
  assert.equal(r.taken, null);
  assert.match(String(r.withheld?.reason), /not served there/);
});
await check("(d5-l3) MUST-EXCLUDE: a not-served learn never touches the AHJ's COMPLETE recipe on its own (other) portal", async () => {
  const ahj = "City of Kestrel Point";
  const own = recipes.startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj, utility: "Pacific Power", portalUrl: "https://aca-prod.accela.com/KESTRELPOINT/Default.aspx", discipline: "structural", portalPlatform: "accela", createdBy: "test" });
  recipes.savePortalRecipeSteps(db, own.id, accelaSteps("Residential - Structural"), { status: "complete" });
  learnResult = { ok: false, portalName: "stub", steps: learnSteps(), reviewScreen: { fields: [], bodyTextSnippet: "" }, finalSubmitRecorded: false, pageCount: 3, pauseReason: null, message: "stub", notServed: NOT_SERVED, stopReason: "not_served" };
  const projectId = fx.newProject({ ahj, city: "Kestrel Point", zip: "97330", utility: "Pacific Power" });
  await autoLearn.autoLearnPortal(db, projectId, { scope: "ahj", portalUrl: ACA_OREGON, urlSource: "statewide", createdBy: "operator", permitType: "structural", discipline: "structural" });
  const row = fx.recipeRow(own.id);
  assert.equal(row.status, "complete");
  assert.equal(String(row.flag_reason ?? ""), "");
  assert.notEqual(String(row.steps_json), "[]");
});
await check("(d5-r1) MUST-EXCLUDE: an own recipe whose REPLAY the portal refused is flagged refused (demoted, never replayed again) — not run through the drift classifier", async () => {
  const ahj = "City of Otterbrook";
  const own = recipes.startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj, utility: "Pacific Power", portalUrl: ACA_OREGON, discipline: "structural", portalPlatform: "accela", createdBy: "test" });
  recipes.savePortalRecipeSteps(db, own.id, accelaSteps("Residential - Structural"), { status: "complete" });
  let ran = 0;
  fx.stubRunner(async () => {
    ran++;
    return { ok: false, finalSubmitClicked: false, message: "Stopped: the portal says this address is not served there",
      steps: [{ ok: true, message: "Opened stub portal." }, { ok: false, message: `Stopped: the portal says this address is not served there — "${NOT_SERVED}".`, data: { notServed: NOT_SERVED } }] };
  });
  const projectId = fx.newProject({ ahj, city: "Otterbrook", zip: "97330", utility: "Pacific Power" });
  await repo.prepareSubmission(db, projectId, "building");
  assert.equal(ran, 1, "the own recipe replayed once");
  const row = fx.recipeRow(own.id);
  assert.ok(String(row.flag_reason).startsWith(notServed.NOT_SERVED_FLAG_PREFIX), String(row.flag_reason));
  assert.equal(row.status, "needs_rerecord");
  // The next stage never replays it (and never lends its host as a draft).
  const projectId2 = fx.newProject({ ahj, city: "Otterbrook", zip: "97330", utility: "Pacific Power" });
  await repo.prepareSubmission(db, projectId2, "building");
  assert.equal(ran, 1, "the refused recipe replayed again");
});

// ── D3: a named portal that REDIRECTS to the AHJ's own host is kept, with that evidence ─────────
const ppl = await import("../src/permitProcessLookup");
const pageReader = await import("../src/agencyPageReader");
type Served = { status?: number; text?: string; finalUrl?: string; redirects?: string[] };
const reads: string[] = [];
const readerOver = (pages: Record<string, Served>) => {
  pageReader._resetPoliteness();
  return pageReader.createPageReader({
    minGapMs: 0, maxReads: 30,
    fetch: async (url) => {
      reads.push(url);
      const sv = pages[url];
      if (!sv) return { ok: false, status: 404, contentType: "text/html", finalUrl: url, reason: "HTTP 404" };
      const status = sv.status ?? 200;
      return { ok: status < 300, status, contentType: "text/html", text: sv.text ?? "", bytes: new TextEncoder().encode(sv.text ?? ""), finalUrl: sv.finalUrl ?? url, reason: `HTTP ${status}`, ...(sv.redirects ? { redirects: sv.redirects } : {}) };
    },
  });
};
const grounded = (text: string, urls: string[]) => ({ text, groundedSearches: 3, searches: 3, stopReason: "end_turn", resultUrls: urls, pagesRead: 0 });
const page = (title: string, body: string) => `<html><head><title>${title}</title></head><body><main>${body}</main></body></html>`;
/** Run the per-job lookup for a fictional city whose own page says "Apply online at <named>", with
 *  <named> served as `landing` (a redirect when it differs). */
async function lookupWithNamedPortal(city: string, named: string, landing: Served) {
  const ahj = `City of ${city}`;
  const PG = `https://www.${city.toLowerCase()}oregon.gov/ds/page/structural-building-permit`;
  const bare = named.replace(/^https?:\/\//, "");
  const p1 = JSON.stringify({
    issuingAgency: { value: ahj, sourceUrl: PG, quote: `The ${ahj} issues building permits.` },
    permitStructure: { value: "separate", sourceUrl: PG, quote: "A separate electrical permit is required." },
    permits: (["structural", "electrical"] as const).map((d) => ({ discipline: d, label: d, issuingAgency: { value: null },
      portalUrl: { value: named, sourceUrl: PG, quote: `Apply online at ${bare}.` }, recordType: { value: null } })),
  });
  const llm = { webLookup: async (i: { label: string }) => (i.label.endsWith(".process") ? grounded(p1, [PG]) : grounded(JSON.stringify({ permits: [] }), [])) };
  reads.length = 0;
  const run = await ppl.runPermitProcessLookup(db, llm as never, { state: "OR", ahj, dcKw: "7", acKw: "6", force: true,
    reader: readerOver({ [PG]: { text: page(`Structural Building Permit | ${city}`, `<p>The ${ahj} issues building permits.</p><p>Apply online at ${bare}.</p>`) }, [named]: landing }) });
  const structural = run.lookup!.permits.find((p) => p.discipline === "structural")!;
  return { run, structural, notes: (run.lookup!.notes ?? []).join("\n") };
}
await check("(d3-p1) MUST-PASS (Corvallis's shape): the city's page names a portal host that REDIRECTS to the city's own Accela tenant → kept as the landing URL, with the named URL and the hops; read ONCE", async () => {
  const named = "https://www.brambletonpermits.com";
  const landing = "https://aca-prod.accela.com/brambleton/Default.aspx";
  const r = await lookupWithNamedPortal("Brambleton", named, { finalUrl: landing, redirects: [named, "https://aca-prod.accela.com/brambleton", landing], text: page("City of Brambleton - Permit System", "<p>Welcome to the permit system.</p>") });
  assert.equal(r.structural.portalUrl.value, landing, `${JSON.stringify(r.structural.portalUrl)}\n${r.notes}`);
  assert.deepEqual(r.structural.portalUrl.redirect, { from: named, finalUrl: landing, chain: [named, "https://aca-prod.accela.com/brambleton", landing], status: 200 });
  assert.match(r.notes, /named as https:\/\/www\.brambletonpermits\.com, which redirects there/);
  assert.equal(reads.filter((u) => u === named).length, 1, `the named portal is fetched once: ${JSON.stringify(reads)}`);
  // …and staging now resolves the city's OWN portal: the statewide fallback never comes up.
  const d = pp.statewidePortalFor({ state: "OR", ahj: "City of Brambleton" }, "building", {});
  assert.equal(d?.url, null);
  assert.match(String(d?.withheld), /aca-prod\.accela\.com\/brambleton/);
});
await check("(d3-x1) MUST-EXCLUDE: a named URL that redirects to ANOTHER city's tenant is not kept — the refusal says where it landed", async () => {
  const named = "https://www.thornburypermits.com";
  const r = await lookupWithNamedPortal("Thornbury", named, { finalUrl: "https://aca-prod.accela.com/SALEMTON/Default.aspx", text: page("City of Salemton - Permits", "<p>Welcome.</p>") });
  assert.equal(r.structural.portalUrl.value, null);
  assert.match(String(r.structural.portalUrl.notFound), /redirects to https:\/\/aca-prod\.accela\.com\/SALEMTON\/Default\.aspx, which names neither/);
  assert.equal(r.structural.portalUrl.claimed, named, "named, not kept — the claim stays on the row (D1 reads it)");
});
await check("(d3-x2) MUST-EXCLUDE: a named URL that redirects to the permit vendor's own site is not kept", async () => {
  const named = "https://www.wickhampermits.com";
  const r = await lookupWithNamedPortal("Wickham", named, { finalUrl: "https://www.accela.com/", text: page("Accela | Government Software", "<p>Civic platform.</p>") });
  assert.equal(r.structural.portalUrl.value, null);
  assert.ok(!r.structural.portalUrl.redirect);
});
await check("(d3-x3) MUST-EXCLUDE: a named URL whose redirect lands on a sign-in page is not read and not kept — the refusal says so", async () => {
  const named = "https://www.ashgrovepermits.com";
  const r = await lookupWithNamedPortal("Ashgrove", named, { finalUrl: "https://aca-prod.accela.com/ashgrove/Login.aspx", text: page("Login", "<p>Sign in</p>") });
  assert.equal(r.structural.portalUrl.value, null);
  assert.match(String(r.structural.portalUrl.notFound), /could not read|sign-in/);
});

// ── D4: the channel label is the RESOLVED portal's host, never free text ────────────────────────
const appDocs = await import("../src/applicationDocs");
const tracks = await import("../src/submittalTracks");
await check("(d4-p1) permitChannelLabel: 'Oregon ePermitting (Accela)' ONLY on the statewide host (and its aliases); an AHJ's own ACA tenant is its own portal; any other host has no platform label", () => {
  for (const u of [ACA_OREGON, "https://aca.oregon.gov/CitizenAccess/", "https://aca-oregon.accela.com/oregon/Cap/CapDetail.aspx?agencyCode=MARION_CO"]) {
    assert.equal(pp.permitChannelLabel("OR", "City of Wrenfield", u), "Oregon ePermitting (Accela)", u);
  }
  assert.equal(pp.permitChannelLabel("OR", "City of Corvallis", "https://aca-prod.accela.com/CORVALLIS/Default.aspx"), "Accela Citizen Access (City of Corvallis's own portal)");
  assert.equal(pp.permitChannelLabel("OR", "Washington County", "https://permits.washingtoncountyor.gov/CitizenAccess/Welcome.aspx"), "Accela Citizen Access (Washington County's own portal)");
  for (const u of ["https://www.corvallispermits.com", "https://devhub.portlandoregon.gov/", "https://www.accela.com/", "https://www.oregon.gov/bcd/epermitting/help/records/pages/permit-for-solar.aspx"]) {
    assert.equal(pp.permitChannelLabel("OR", "City of Corvallis", u), null, u);
  }
});
await check("(d4-p2) MUST-EXCLUDE: an Oregon profile's WORDS never earn the statewide label — the generic fallback is unknown, a seeded 'accela' is neutral; MUST-PASS: a seeded tenant URL is the AHJ's own portal", () => {
  const job = (ahj: string) => ({ id: "p", state: "OR", ahj, city: ahj.replace(/^City of /, ""), zip: "", utility: "", parserSnapshot: {} }) as never;
  const generic = appDocs.findApplicationProfile(job("City of Nowhere Falls"));
  assert.equal(generic.id, "oregon-generic-epermitting");
  assert.equal(appDocs.describePermitType(generic).submissionMethod, "Unknown — verify on the AHJ site");
  const benton = appDocs.describePermitType(appDocs.findApplicationProfile(job("Benton County"))).submissionMethod; // seeded "accela"
  assert.doesNotMatch(benton, /Oregon ePermitting/, benton);
  const albany = appDocs.describePermitType(appDocs.findApplicationProfile(job("Albany"))).submissionMethod; // seeded aca-prod.accela.com/albany URL
  assert.equal(albany, "Accela Citizen Access (Albany's own portal)");
  // MUST-PASS: a hand-written profile whose portal IS the statewide host keeps the statewide label.
  assert.equal(appDocs.describePermitType(appDocs.findApplicationProfile(job("Junction City"))).submissionMethod, "Oregon ePermitting (Accela)");
});
const cardFor = (projectId: string, type: string) => {
  const project = repo.getProjectDetail(db, projectId).project;
  return tracks.getSubmittalTracks(db, project).find((t) => t.type === type)!;
};
await check("(d4-e1) MUST-EXCLUDE (Corvallis's card): an Oregon city with a person's verified row on its own ACA tenant reads 'Accela Citizen Access (<city>'s own portal)', never 'Oregon ePermitting'", () => {
  const ahj = "City of Larchfield";
  // Keyed WITH the utility, exactly like the live Corvallis row ("or|city of corvallis|pacificorp").
  kb.saveVerifiedAhjProfile(db, { state: "OR", ahj, utility: "Pacific Power", portalUrl: "https://aca-prod.accela.com/LARCHFIELD/Default.aspx", portalName: "City of Larchfield Online Permitting", verifiedBy: "test" });
  const projectId = fx.newProject({ ahj, city: "Larchfield", zip: "97330", utility: "Pacific Power" });
  const card = cardFor(projectId, "building");
  assert.doesNotMatch(card.channel, /Oregon ePermitting/, card.channel);
  assert.match(card.channel, /^Accela Citizen Access \(City of Larchfield's own portal\): https:\/\/aca-prod\.accela\.com\/LARCHFIELD\/Default\.aspx \(verified by a person\)/, card.channel);
  assert.equal(card.channelKind, "portal");
});
await check("(d4-e2) MUST-PASS: a person's verified portal outranks the per-job lookup's (hard rule 3 — the card agrees with the stage)", () => {
  const ahj = "City of Moorcroft";
  pp.savePermitProcessLookup(db, {
    state: "OR", ahj, lookedUpAt: new Date().toISOString(), issuingAgency: nf(), permitStructure: nf(),
    permits: (["structural", "electrical"] as const).map((d) => ({ discipline: d, label: d, issuingAgency: nf(), portalUrl: cite("https://permits.moorcroft.example.gov/apply", "https://www.moorcroft.example.gov/building", "Apply online at permits.moorcroft.example.gov"), recordType: nf(), documents: nf(), fee: nf() })),
  } as never);
  kb.saveVerifiedAhjProfile(db, { state: "OR", ahj, portalUrl: "https://aca-prod.accela.com/MOORCROFT/Default.aspx", verifiedBy: "test" });
  const card = cardFor(fx.newProject({ ahj, city: "Moorcroft", zip: "97330", utility: "Pacific Power" }), "building");
  assert.match(card.channel, /aca-prod\.accela\.com\/MOORCROFT.*verified by a person/, card.channel);
});
await check("(d4-e3) MUST-PASS: a city whose lookup found its permits on the statewide portal reads 'Oregon ePermitting (Accela)' with that URL; MUST-EXCLUDE: a city with nothing on file reads unknown", () => {
  const ahj = "City of Fennick";
  const agency = cite(ahj, "https://www.fennick.example.gov/permits", `The ${ahj} issues building permits`);
  pp.savePermitProcessLookup(db, {
    state: "OR", ahj, lookedUpAt: new Date().toISOString(), issuingAgency: agency, permitStructure: nf(),
    permits: (["structural", "electrical"] as const).map((d) => ({ discipline: d, label: d, issuingAgency: agency, portalUrl: cite(ACA_OREGON, "https://www.fennick.example.gov/permits", "Apply online through Oregon ePermitting (aca-oregon.accela.com)"), recordType: nf(), documents: nf(), fee: nf() })),
  } as never);
  const card = cardFor(fx.newProject({ ahj, city: "Fennick", zip: "97330", utility: "Pacific Power" }), "building");
  assert.match(card.channel, /^Oregon ePermitting \(Accela\): https:\/\/aca-oregon\.accela\.com\/oregon\//, card.channel);
  assert.equal(card.channelKind, "portal");
  const blank = cardFor(fx.newProject({ ahj: "City of Emptyvale", city: "Emptyvale", zip: "97330", utility: "Pacific Power" }), "building");
  assert.doesNotMatch(blank.channel, /Oregon ePermitting/, blank.channel);
  assert.match(blank.channel, /^Unknown/, blank.channel);
});

finish("portal-truth");
