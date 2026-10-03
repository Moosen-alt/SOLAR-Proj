// ISSUE #31 — NEM research named PowerClerk but kept the utility's own program page as the portal
// (owner live run: PNM, www.pnm.com/customer-solar-program1 instead of PNM's PowerClerk tenant).
// Pins (rule 5, the NEM-track half of the one predicate):
//   (p)  hostFitsTrackAndEntity's `namedPlatform` option: a source that names an interconnection
//        platform pins the host to that platform's domain — off it, the URL is UNCONFIRMED; no
//        platform named → unchanged; a person's verified portal is never second-guessed;
//   (T1/T2) door B, the utility filing lookup: an off-platform URL is dropped (name kept, card says
//        "tenant URL unconfirmed, verify"); the tenant's own *.powerclerk.com login is kept;
//   (T3/T4) door A, cold-start research through the REAL provider parse (only the HTTP call is
//        stubbed, so research.notes is the provider's real fixed sentence and the test cannot lean on
//        the notes regex): the off-platform URL is never portal_url and never launched; the tenant
//        login is saved;
//   (g)  the "research says unconfirmed" guard can fire in production: `portalUrlConfirmed: false`
//        reaches the notes, and a disclaimer in tips counts;
//   (k)  the KB read door: a stored row that names PowerClerk beside an off-platform URL is not launched;
//   (s)  the seeded PNM tenant (seeded, never verified — rule 3) and its credential alias pair.
// Synthetic utilities everywhere except the seeded PNM row. No network.
//
// KILL TESTS (each run red by hand before the fix):
//   K1 hostFitsTrackAndEntity ignores opts.namedPlatform              → (p2), (T1), (T3), (k1) fail.
//   K2 llm.ts drops the portalUrlConfirmed note                       → (g1) fails.
//   K3 no PNM seed                                                    → (s1), (s2) fail.
//
// Run: npx tsx backend/test/namedPlatformHost.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("named-platform-host");
const { db, repo } = fx;
const chan = await import("../src/portalChannel");
const ufl = await import("../src/utilityFilingLookup");
const rpu = await import("../src/researchedPortalUrl");
const creds = await import("../src/portalCredentials");
const llm = await import("../src/llm");

const STATE = "NM";
const INFO_URL = "https://www.mesquite-electric.test/customer-solar-program1";      // synthetic: a program page, no info-path word
const PC_LOGIN = "https://mesquiteinterconnect.powerclerk.com/MvcAccount/Login";      // synthetic tenant
const CUSTOM_URL = "https://apply.sagebrush-power.test/start";                         // synthetic, no platform named

// ── stub the provider's HTTP only: researchUtilityRequirements' own parse + notes run for real ──
let webAnswer: Record<string, unknown> = {};
const proto = (llm as unknown as { ClaudeLLMProvider: { prototype: Record<string, unknown> } }).ClaudeLLMProvider.prototype;
proto.runOnce = async () => { throw new Error("network disabled in test"); };
proto.askWithWebSearch = async () => ({
  text: JSON.stringify({ requiredDocuments: ["One-line diagram"], submissionMethod: "online portal", confidence: "medium", ...webAnswer }),
  searches: 1, groundedSearches: 1, fetches: 0, fetchedUrls: [], stopReason: "end_turn", resultUrls: [INFO_URL], resultTitles: {}, model: "stub",
});
const withKey = async <T>(fn: () => Promise<T>): Promise<T> => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-dummy";
  try { return await fn(); } finally { delete process.env.ANTHROPIC_API_KEY; }
};
const kbRow = (key: string) => db.get<Record<string, string>>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [key])!;
const notSaved = (url: string) => fx.audits("knowledge.researched_url_not_saved").map((x) => JSON.parse(x.details)).filter((d) => d.url === url);

// ── (p) the one predicate ─────────────────────────────────────────────────────────────────
await check("(p1) namedPlatformHostRefusal: (PowerClerk, info URL) refuses; (PowerClerk, PC login) and (no platform, info URL) do not", () => {
  assert.match(chan.namedPlatformHostRefusal("PowerClerk", INFO_URL), /not on PowerClerk's domain/);
  assert.match(chan.namedPlatformHostRefusal(["Customer Generation", "PowerClerk (Clean Power Research)"], INFO_URL), /PowerClerk/);
  assert.equal(chan.namedPlatformHostRefusal("PowerClerk", PC_LOGIN), "");
  assert.equal(chan.namedPlatformHostRefusal("", INFO_URL), "");
  assert.equal(chan.namedPlatformHostRefusal("Customer Generation online application", INFO_URL), "");
  // A white-label tenant the codebase knows stays on its platform.
  assert.equal(chan.namedPlatformHostRefusal("ConnectTheGrid", "https://interconnect.comed.com/Account/Login"), "");
});
await check("(p2) MUST-EXCLUDE: hostFitsTrackAndEntity(nem, PowerClerk named, off-platform URL) → platform_unconfirmed", () => {
  const fit = chan.hostFitsTrackAndEntity("nem", null, INFO_URL, "research", { namedPlatform: ["PowerClerk"] });
  assert.equal(fit.fits, false);
  assert.equal(fit.code, "platform_unconfirmed", fit.reason);
});
await check("(p3) MUST-PASS: the PC login fits with or without the platform named; no platform named → unchanged", () => {
  assert.equal(chan.hostFitsTrackAndEntity("nem", null, PC_LOGIN, "research").fits, true);
  assert.equal(chan.hostFitsTrackAndEntity("nem", null, PC_LOGIN, "research", { namedPlatform: ["PowerClerk"] }).fits, true);
  assert.equal(chan.hostFitsTrackAndEntity("nem", null, INFO_URL, "research").fits, true);
  assert.equal(chan.hostFitsTrackAndEntity("nem", null, INFO_URL, "research", { namedPlatform: [] }).fits, true);
});
await check("(p4) a person's verified portal is never second-guessed by a named platform (rule 3); the permit track is untouched", () => {
  const entity = { scope: "utility" as const, state: STATE, name: "Mesquite Electric", ownPortals: [INFO_URL], verifiedPortals: [INFO_URL], otherClaims: [] };
  assert.equal(chan.hostFitsTrackAndEntity("nem", entity, INFO_URL, "kb", { namedPlatform: ["PowerClerk"] }).fits, true);
  assert.equal(chan.hostFitsTrackAndEntity("building", null, "https://permits.example.gov/apply", "research", { namedPlatform: ["PowerClerk"] }).fits, true);
  // …and the platform option never opens a door: PowerClerk on a permit track is still refused.
  assert.equal(chan.hostFitsTrackAndEntity("building", null, PC_LOGIN, "research", { namedPlatform: ["PowerClerk"] }).code, "track_conflict");
});

// ── door B: the utility filing lookup ─────────────────────────────────────────────────────
const answer = (url: string | null, name = "PowerClerk", quote = "Submit your interconnection application through our PowerClerk portal.") =>
  JSON.stringify({ filing: { value: { name, url }, sourceUrl: INFO_URL, quote }, program: { value: null, notFound: "n/a" } });
await check("(T1) MUST-EXCLUDE (lookup): PowerClerk named, URL on the utility's own page → url dropped, name kept, audited in dropped", () => {
  const parsed = ufl.parseUtilityFilingAnswer(answer(INFO_URL), [INFO_URL]);
  assert.equal(parsed.filing.value?.url, null);
  assert.equal(parsed.filing.value?.name, "PowerClerk");
  assert.ok(parsed.dropped.some((d) => d.includes(INFO_URL) && /PowerClerk/.test(d)), parsed.dropped.join(" / "));
  // The quote alone naming PowerClerk pins it too, and the nameless filing is filed under the platform.
  const viaQuote = ufl.parseUtilityFilingAnswer(answer(INFO_URL, ""), [INFO_URL]);
  assert.equal(viaQuote.filing.value?.url, null);
  assert.equal(viaQuote.filing.value?.name, "PowerClerk");
  assert.equal(ufl.acceptFilingUrl(INFO_URL, [INFO_URL], ["PowerClerk"]).url, null);
});
await check("(T1b) the stored lookup's card says \"PowerClerk — tenant URL unconfirmed, verify\" and carries no portal URL", async () => {
  const stub = { webLookup: async () => ({ text: answer(INFO_URL), groundedSearches: 1, stopReason: null, resultUrls: [INFO_URL], pagesRead: 0, fetchedUrls: [] }) };
  const run = await ufl.runUtilityFilingLookup(db, stub as never, { state: STATE, utility: "Mesquite Electric" });
  assert.equal(run.lookup?.filing.value?.url, null);
  const card = ufl.utilityTrackPresentation(db, { state: STATE, utility: "Mesquite Electric" } as never);
  assert.match(card.channel, /^PowerClerk — tenant URL unconfirmed, verify/, card.channel);
  assert.equal(card.portalUrl, "");
});
await check("(T2) MUST-PASS (lookup): the tenant's own *.powerclerk.com login, attested by the search, is kept", () => {
  const parsed = ufl.parseUtilityFilingAnswer(answer(PC_LOGIN, "PowerClerk", "Apply online at mesquiteinterconnect.powerclerk.com (PowerClerk)."), [INFO_URL, PC_LOGIN]);
  assert.equal(parsed.filing.value?.url, PC_LOGIN);
  // No platform named → an ordinary utility-hosted portal is unchanged.
  const own = ufl.parseUtilityFilingAnswer(JSON.stringify({ filing: { value: { name: "Sagebrush Interconnection Portal", url: CUSTOM_URL }, sourceUrl: CUSTOM_URL, quote: "Apply at apply.sagebrush-power.test" } }), [CUSTOM_URL]);
  assert.equal(own.filing.value?.url, CUSTOM_URL);
});

// ── door A: cold-start research, through the provider's real parse ────────────────────────
await check("(T3) MUST-EXCLUDE (research): PowerClerk named beside the utility's program page → not portal_url, a reference link, audited", async () => {
  webAnswer = { portalName: "PowerClerk", portalPlatform: "PowerClerk", portalUrl: INFO_URL, portalUrlConfirmed: true };
  const { research, profileKey } = await withKey(() => repo.researchAndSaveUtility(db, { utility: "Mesquite Electric", state: STATE }));
  // The provider's REAL notes: the fixed sentence, which the notes regex does not catch.
  assert.equal(rpu.researchSaysPortalUnconfirmed(research.notes), false, research.notes);
  assert.equal(research.portalUrl, INFO_URL);
  const row = kbRow(profileKey!);
  assert.equal(row.portal_url, "");
  assert.match(row.notes, /Reference link \(not confirmed as the application portal\): https:\/\/www\.mesquite-electric\.test\/customer-solar-program1/);
  assert.equal(notSaved(INFO_URL)[0]?.code, "platform_unconfirmed", JSON.stringify(notSaved(INFO_URL)));
});
await check("(T3b) MUST-EXCLUDE (launch): prepareSubmission(nem) never launches the off-platform research URL", async () => {
  const projectId = fx.newProject({ state: STATE, ahj: "City of Mesquite Flats", city: "Mesquite Flats", zip: "87002", utility: "Mesquite Launch Electric" });
  let ran = false;
  fx.stubRunner(async () => { ran = true; return { ok: true, finalSubmitClicked: false, steps: [] } as never; });
  await withKey(() => repo.prepareSubmission(db, projectId, "nem").catch((e) => e));
  assert.equal(ran, false, "no browser run");
  const a = fx.audits("portal.url_research_conflict").filter((x) => x.project_id === projectId).map((x) => JSON.parse(x.details));
  assert.equal(a[0]?.code, "platform_unconfirmed", JSON.stringify(a));
  assert.equal(fx.audits("portal.url_researched").filter((x) => x.project_id === projectId).length, 0);
});
await check("(T4) MUST-PASS (research): the tenant's PowerClerk login, confirmed, is saved as portal_url", async () => {
  webAnswer = { portalName: "PowerClerk", portalPlatform: "PowerClerk", portalUrl: PC_LOGIN, portalUrlConfirmed: true };
  const { research, profileKey } = await withKey(() => repo.researchAndSaveUtility(db, { utility: "Mesquite Tenant Electric", state: STATE }));
  assert.equal(rpu.researchSaysPortalUnconfirmed(research.notes), false, research.notes);
  assert.equal(kbRow(profileKey!).portal_url, PC_LOGIN);
});

// ── (g) the unconfirmed guard fires in production ─────────────────────────────────────────
await check("(g1) portalUrlConfirmed:false in the research JSON reaches the notes → the URL is not saved (code unconfirmed)", async () => {
  webAnswer = { portalName: "Sagebrush Interconnection Portal", portalPlatform: "custom", portalUrl: CUSTOM_URL, portalUrlConfirmed: false };
  const { research, profileKey } = await withKey(() => repo.researchAndSaveUtility(db, { utility: "Sagebrush Power", state: STATE }));
  assert.ok(research.notes.includes(rpu.RESEARCH_PORTAL_UNCONFIRMED_NOTE), research.notes);
  assert.equal(rpu.researchSaysPortalUnconfirmed(rpu.RESEARCH_PORTAL_UNCONFIRMED_NOTE), true);
  assert.equal(kbRow(profileKey!).portal_url, "");
  assert.equal(notSaved(CUSTOM_URL)[0]?.code, "unconfirmed");
});
await check("(g2) a disclaimer in tips counts; a confirmed custom portal with no platform named is saved", async () => {
  const url2 = "https://apply.juniper-coop.test/start";
  webAnswer = { portalName: "Juniper Apply", portalPlatform: "custom", portalUrl: url2, portalUrlConfirmed: true, tips: ["The portal login URL could not be confirmed; call the utility."] };
  const tipped = await withKey(() => repo.researchAndSaveUtility(db, { utility: "Juniper Coop", state: STATE }));
  assert.equal(kbRow(tipped.profileKey!).portal_url, "");
  webAnswer = { portalName: "Juniper Apply", portalPlatform: "custom", portalUrl: url2, portalUrlConfirmed: true };
  const ok = await withKey(() => repo.researchAndSaveUtility(db, { utility: "Juniper Coop Two", state: STATE }));
  assert.equal(kbRow(ok.profileKey!).portal_url, url2);
});

// ── (k) the KB read door ───────────────────────────────────────────────────────────────────
await check("(k1) MUST-EXCLUDE: a stored NEM row naming PowerClerk beside an off-platform URL is not resolved for the NEM stage", () => {
  db.run(`INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, portal_name, portal_url, portal_platform, confidence, notes, first_seen_at, last_learned_at, updated_at)
          VALUES ('kb-cholla', 'nm||cholla electric', 'NM', '', 'Cholla Electric', 'PowerClerk', 'https://www.cholla-electric.test/solar-interconnection', 'PowerClerk', 'seeded', '', datetime('now'), datetime('now'), datetime('now'))`);
  const projectId = fx.newProject({ state: STATE, ahj: "City of Cholla", city: "Cholla", zip: "87003", utility: "Cholla Electric" });
  const sp = repo.resolveStagePortal(db, { projectId, project: repo.getProjectDetail(db, projectId).project, track: "nem", portalType: "mock", isRealPortal: false });
  assert.equal(sp.utilityPortalUrl, "");
});

// ── (s) the seeded PNM tenant ─────────────────────────────────────────────────────────────
await check("(s1) the PNM tenant is SEEDED (never verified): NM / PNM / PowerClerk / pnminterconnect.powerclerk.com, citing pnm.com", () => {
  const row = db.get<Record<string, string | null>>("SELECT * FROM permit_utility_knowledge WHERE state = 'NM' AND ahj = '' AND utility = 'PNM'");
  assert.ok(row, "seed row exists");
  assert.equal(row!.portal_url, "https://pnminterconnect.powerclerk.com/MvcAccount/Login");
  assert.equal(row!.portal_platform, "PowerClerk");
  assert.equal(row!.confidence, "seeded");
  assert.equal(row!.verified_at ?? null, null);
  assert.match(String(row!.sources_json), /pnm\.com\/customer-solar-program1/);
});
await check("(s2) MUST-PASS: a PNM project's NEM stage resolves the PowerClerk tenant; the credential alias pair links pnm.com", () => {
  const projectId = fx.newProject({ state: STATE, ahj: "City of Albuquerque", city: "Albuquerque", zip: "87102", utility: "PNM" });
  const sp = repo.resolveStagePortal(db, { projectId, project: repo.getProjectDetail(db, projectId).project, track: "nem", portalType: "mock", isRealPortal: false });
  assert.equal(sp.utilityPortalUrl, "https://pnminterconnect.powerclerk.com/MvcAccount/Login");
  assert.ok(creds.hostAliasesOf("pnm.com").includes("pnminterconnect.powerclerk.com"));
  assert.ok(creds.hostAliasesOf("pnminterconnect.powerclerk.com").includes("www.pnm.com"));
});

finish("named platform pins the NEM portal host (#31)");
