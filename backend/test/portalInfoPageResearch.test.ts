// ISSUE #8 — cold-start research accepted a utility's information page as the portal, and the NEM
// result leaked onto the permit track (owner live run: City of Albuquerque / PNM). Pins:
//   (i)   the one predicate (hostFitsTrackAndEntity → isInformationalPageUrl) refuses a reference /
//         library / resources page on BOTH tracks, and PNM's own host on the permit track (rule 5);
//   (ii)  the research write door never SAVES an information page, or a URL the research itself
//         says it did not confirm, as portal_url — it is kept as a reference link, audited;
//   (iii) NEM research is saved on the UTILITY's own row (ahj ""), so the permit track — its stage
//         resolver and its Submittal Tracks card — never reads it, while the NEM track still does;
//   (iv)  end-to-end: NEM research returns a utility URL, AHJ research returns nothing → the permit
//         stage launches nothing, runs its OWN AHJ research, and its message names the AHJ.
// No network: the Claude provider is constructed with a dummy key and every request is stubbed.
//
// KILL TESTS (each run red by hand before the fix):
//   K1 drop library/reference/resources from isInformationalPageUrl        → (a1), (b1) fail.
//   K2 saveResearchedUtilityProfile keyed on the caller's AHJ again         → (c1), (c2), (c3), (d1) fail.
//   K3 researchWithFittedUrl ignores the research's "not confirmed" notes   → (b2) fails.
//
// Run: npx tsx backend/test/portalInfoPageResearch.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("portal-info-page-research");
const { db, repo } = fx;
const chan = await import("../src/portalChannel");
const tracks = await import("../src/submittalTracks");
const llm = await import("../src/llm");

const PNM_LIBRARY = "https://www.pnm.com/solarreferencelibrary";
const STATE = "NM";
const AHJ = "City of Mesa Arroyo";            // synthetic
const UTILITY = "Arroyo Valley Electric";      // synthetic, on no host list
const UTILITY_URL = "https://interconnect.arroyovalley-electric.test/apply"; // synthetic, fits NEM

// ── stub the provider: no request ever leaves the process ─────────────────────────────────
type Research = Record<string, unknown>;
let utilityResearch: Research | null = null;
let ahjResearch: Research | null = null;
let ahjResearchCalls = 0;
const proto = (llm as unknown as { ClaudeLLMProvider: { prototype: Record<string, unknown> } }).ClaudeLLMProvider.prototype;
proto.runOnce = async () => { throw new Error("network disabled in test"); };
proto.researchUtilityRequirements = async () => ({ ...baseResearch(), ...(utilityResearch ?? {}) });
proto.researchAhjRequirements = async () => { ahjResearchCalls++; return { ...baseResearch(), ...(ahjResearch ?? {}) }; };
function baseResearch(): Research {
  return {
    provider: "claude", portalName: "", portalPlatform: "", portalUrl: "", submissionMethod: "",
    requiredDocuments: ["One-line diagram"], smartInverterSettings: "", meterAggregation: "", acDisconnectRule: "",
    exportLimitNote: "", commonCorrections: [], tips: [], submissionSteps: [], confidence: "low",
    needsHumanVerification: true, notes: "", webGrounded: true,
  };
}
const withKey = async <T>(fn: () => Promise<T>): Promise<T> => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-dummy";
  try { return await fn(); } finally { delete process.env.ANTHROPIC_API_KEY; }
};
const kbRow = (key: string) => db.get<Record<string, string>>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [key])!;

// ── (a) the one predicate ──────────────────────────────────────────────────────────────────
await check("(a1) a reference-library / resources page is not a portal on EITHER track (not_a_portal)", () => {
  for (const u of [PNM_LIBRARY, "https://www.example-utility.test/solar/resources", "https://www.example-utility.test/solar-resources",
    "https://www.example.gov/building/library/solar", "https://www.example.gov/documentlibrary/solar"]) {
    assert.equal(chan.isInformationalPageUrl(u), true, u);
    for (const track of ["building", "nem"]) assert.equal(chan.hostFitsTrackAndEntity(track, null, u, "research").code, "not_a_portal", `${track} ${u}`);
  }
  // Not over-reaching: portals and a preferences page are not libraries; a platform's own pages never are.
  for (const u of ["https://permits.example.gov/CitizenAccess/Default.aspx", "https://www.example.gov/account/preferences",
    "https://www.example.gov/user-preference", "https://examplenm.powerclerk.com/resources"]) {
    assert.equal(chan.isInformationalPageUrl(u), false, u);
  }
});
await check("(a2) MUST-EXCLUDE: PNM's own host never fits a permit track, whatever the path (rule 5)", () => {
  const fit = chan.hostFitsTrackAndEntity("building", null, "https://www.pnm.com/interconnection", "research");
  assert.equal(fit.code, "track_conflict", fit.reason);
});

// ── (b) the research write door ────────────────────────────────────────────────────────────
await check("(b1) utility research returning PNM's library: portal_url NOT saved, kept as a reference link, audited", async () => {
  utilityResearch = { portalName: "PowerClerk", portalPlatform: "PowerClerk", portalUrl: PNM_LIBRARY };
  const { profileKey } = await withKey(() => repo.researchAndSaveUtility(db, { utility: "Library Test Electric", state: STATE, ahj: AHJ }));
  const row = kbRow(profileKey!);
  assert.equal(row.portal_url, "");
  assert.match(row.notes, /Reference link \(not confirmed as the application portal\): https:\/\/www\.pnm\.com\/solarreferencelibrary/);
  const a = fx.audits("knowledge.researched_url_not_saved").map((x) => JSON.parse(x.details)).find((d) => d.url === PNM_LIBRARY);
  assert.equal(a?.code, "not_a_portal");
});
await check("(b2) research whose own notes say the portal URL was NOT confirmed: not saved as the portal", async () => {
  utilityResearch = {
    portalUrl: "https://apply.confirmtest-electric.test/start",
    notes: "The specific portal login URL was not confirmed in this research, so no exact deep link is asserted.",
  };
  const { profileKey } = await withKey(() => repo.researchAndSaveUtility(db, { utility: "Confirm Test Electric", state: STATE }));
  const row = kbRow(profileKey!);
  assert.equal(row.portal_url, "");
  assert.match(row.notes, /Reference link \(not confirmed as the application portal\): https:\/\/apply\.confirmtest-electric\.test\/start/);
  const a = fx.audits("knowledge.researched_url_not_saved").map((x) => JSON.parse(x.details)).find((d) => d.url === "https://apply.confirmtest-electric.test/start");
  assert.equal(a?.code, "unconfirmed");
});

// ── (c) NEM research never reaches the permit track ────────────────────────────────────────
utilityResearch = { portalName: "Arroyo Interconnect", portalUrl: UTILITY_URL };
const nemSaved = await withKey(() => repo.researchAndSaveUtility(db, { utility: UTILITY, state: STATE, ahj: AHJ }));
await check("(c1) NEM research is saved on the UTILITY's own row (ahj empty), with its URL", () => {
  const row = kbRow(nemSaved.profileKey!);
  assert.equal(row.ahj, "");
  assert.equal(row.utility, UTILITY);
  assert.equal(row.portal_url, UTILITY_URL);
});
const projectId = fx.newProject({ state: STATE, ahj: AHJ, city: "Mesa Arroyo", zip: "87001", utility: UTILITY });
const project = () => repo.getProjectDetail(db, projectId).project;
const stagePortal = (track: "building" | "combo" | "nem") => repo.resolveStagePortal(db, { projectId, project: project(), track, portalType: "mock", isRealPortal: false });
await check("(c2) MUST-EXCLUDE: the permit track's stage resolver resolves NO portal from the NEM research", () => {
  for (const track of ["building", "combo"] as const) {
    const sp = stagePortal(track);
    assert.equal(sp.ahjPortalUrl, "", track);
    assert.equal(sp.ownPortalUrl, "", track);
    assert.ok(!JSON.stringify(sp).includes("arroyovalley-electric"), `${track}: ${JSON.stringify(sp).slice(0, 400)}`);
  }
});
await check("(c3) MUST-EXCLUDE: the permit tracks' Submittal Tracks payload never carries the utility URL; it says unknown — verify", () => {
  const permit = tracks.getSubmittalTracks(db, project()).filter((t) => t.type !== "nem");
  assert.ok(permit.length > 0);
  for (const t of permit) {
    // Neither utility's research (this project's, nor (b1)'s PNM library — the owner's "Link on file:
    // pnm.com/solarreferencelibrary") reaches a permit card, as its portal OR its link on file.
    for (const leak of ["arroyovalley-electric", "pnm.com"]) assert.ok(!JSON.stringify(t).includes(leak), `${leak}: ${JSON.stringify(t).slice(0, 600)}`);
    assert.equal(t.portalUrl ?? "", "", t.type);
    assert.match(t.channel, /verify/i, t.channel);
  }
});
await check("(c4) MUST-PASS: the NEM track still resolves the utility's researched portal", () => {
  assert.equal(stagePortal("nem").utilityPortalUrl, UTILITY_URL);
});

// ── (d) end-to-end: the permit stage runs its OWN AHJ research and names the AHJ ─────────────
await check("(d1) prepareSubmission(building): AHJ research finds nothing → the permit track runs its OWN research, launches no URL, and names the AHJ as unconfirmed", async () => {
  let ran = false;
  fx.stubRunner(async () => { ran = true; return { ok: true, finalSubmitClicked: false, steps: [] }; });
  ahjResearch = { portalUrl: "" };
  const before = ahjResearchCalls;
  await withKey(() => repo.prepareSubmission(db, projectId, "building").catch((e) => e));
  assert.equal(ran, false, "no recipe/browser run");
  assert.ok(ahjResearchCalls > before, "the permit track ran its own AHJ research");
  assert.equal(fx.audits("portal.url_researched").filter((a) => a.project_id === projectId).length, 0);
  const unconfirmed = fx.audits("portal.url_unconfirmed").filter((a) => a.project_id === projectId).map((a) => JSON.parse(a.details));
  assert.equal(unconfirmed.length, 1, JSON.stringify(unconfirmed));
  assert.equal(unconfirmed[0].entity, AHJ);
  assert.match(unconfirmed[0].message, new RegExp(`Portal not confirmed for ${AHJ}`));
  const text = JSON.stringify(fx.latestRun(projectId) ?? {});
  assert.ok(!text.includes("arroyovalley-electric"), text.slice(0, 600));
});
await check("(d2) prepareSubmission(building): AHJ research returning PNM's library → refused, audited portal.url_research_conflict", async () => {
  ahjResearch = { portalUrl: PNM_LIBRARY };
  await withKey(() => repo.prepareSubmission(db, projectId, "building").catch((e) => e));
  const a = fx.audits("portal.url_research_conflict").filter((x) => x.project_id === projectId).map((x) => JSON.parse(x.details)).find((d) => d.url === PNM_LIBRARY);
  assert.equal(a?.code, "not_a_portal", JSON.stringify(a));
  assert.equal(fx.audits("portal.url_researched").filter((x) => x.project_id === projectId).length, 0);
});

finish("portal info-page research (#8)");
