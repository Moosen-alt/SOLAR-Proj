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

finish("portal-truth");
