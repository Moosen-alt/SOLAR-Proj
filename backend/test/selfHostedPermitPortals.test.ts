// RULE 5: SELF-HOSTED CITYWORKS PUBLIC ACCESS AND SMARTGOV INSTALLS ARE PERMIT PORTALS (#237, P1).
//
// isSelfHostedPermitPortalUrl knew CityView, EnerGov, eTRAKiT and Accela CitizenAccess installs on a
// city's own host (#128), but not Trimble Cityworks Public Access (PLL) or Granicus SmartGov. So
// cityworks.<city>.gov/PublicAccess/… and smartgov.<county>.gov/application/ fit the NEM (utility
// interconnection) track whenever no entity evidence was supplied. Now both carry an install
// signature in the same table (a cityworks. / smartgov. first host label, a /PublicAccess,
// /Cityworks…, /SmartGov first path segment), so isPermitPortalUrl is true and the ONE predicate,
// hostFitsTrackAndEntity, answers track_conflict on the NEM track. The Utah carve-out is unchanged:
// the utility's OWN human-VERIFIED record naming the same host AND tenant opens it; a seeded row
// never does. An information page on such a host stays an information page.
//
// Probes pinned here (decisions, not accidents):
//   - a help / FAQ page on a cityworks. host is not_a_portal on BOTH tracks (step 0 wins);
//   - a /PublicAccess segment on an unrelated host (a library catalogue) IS read as a permit portal:
//     the signal only refuses on the NEM track (fail closed), and the permit track is untouched;
//   - Click2Gov (utility billing) and a bare /SelfService segment are NOT signatures: a municipal
//     utility's own customer portal lives there.
//
// Synthetic hosts only (example*.gov / example.org). Nothing reaches the network.
//
//   npx tsx backend/test/selfHostedPermitPortals.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "selfhosted-permit-portals-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.PORTAL_AUTOSEED;

const { openDatabase } = await import("../src/db");
const { portalEntityEvidence } = await import("../src/portalRecipes");
const { hostFitsTrackAndEntity, trackSafeUrl, isPermitPortalUrl, isSelfHostedPermitPortalUrl, isPermitPlatformUrl, isInformationalPageUrl } = await import("../src/portalChannel");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
};

const ST = "UT";
const UTILITY = "Example City Power"; // synthetic municipal utility
const SOURCES = ["kb", "research", "recipe", "operator", "learn"] as const;
// The issue's three URLs (synthetic hosts).
const CW_LOWER = "https://cityworks.examplecity-ut.gov/publicaccess/login";
const CW_TEMPLATE = "https://cityworks.examplecity.gov/PublicAccess/template/login.aspx";
const SMARTGOV = "https://smartgov.examplecounty.gov/application/";
const ISSUE_URLS = [CW_LOWER, CW_TEMPLATE, SMARTGOV];
const now = new Date().toISOString();
const utility = () => portalEntityEvidence(db, { scope: "utility", state: ST, name: UTILITY });
const kbRow = (id: string, util: string, url: string, verified: boolean) => db.run(
  `INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, portal_url, confidence, first_seen_at, last_learned_at, updated_at, verified_at, verified_by)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, `${ST.toLowerCase()}||${util.toLowerCase()}|${id}`, ST, "", util, url, verified ? "verified" : "seeded", now, now, now, verified ? now : null, verified ? "synthetic.reviewer@example.com" : ""],
);
const refusedOnNem = (entity: ReturnType<typeof utility> | null, url: string, what: string) => {
  for (const source of SOURCES) {
    const fit = hostFitsTrackAndEntity("nem", entity, url, source);
    assert.equal(fit.fits, false, `${what}: ${url} (${source}) opened on the NEM track: ${fit.reason}`);
    assert.equal(fit.code, "track_conflict", `${what}: ${url} (${source}) refused for the wrong reason: ${fit.reason}`);
  }
  assert.equal(trackSafeUrl("nem", url), "", `${what}: trackSafeUrl let ${url} onto the NEM track`);
};
const fitsPermit = (url: string, what: string) => {
  for (const track of ["building", "electrical"]) {
    const fit = hostFitsTrackAndEntity(track, null, url, "research");
    assert.equal(fit.fits, true, `${what}: ${url} no longer fits the ${track} track: ${fit.reason}`);
  }
  assert.equal(trackSafeUrl("building", url), url);
};

await check("#237: the issue's three URLs are permit portals and refused on the NEM track (no entity, every source)", () => {
  for (const url of ISSUE_URLS) {
    assert.equal(isPermitPortalUrl(url), true, `${url} is not a permit portal`);
    assert.equal(isSelfHostedPermitPortalUrl(url), true, `${url} has no self-hosted signature`);
    // A city's own host is not a VENDOR's: the permit-side vendor question is unchanged.
    assert.equal(isPermitPlatformUrl(url), false, `${url} became a vendor domain`);
    refusedOnNem(null, url, "no entity");
  }
});

await check("#237: refused on the NEM track with a utility's evidence that names nothing", () => {
  const entity = utility();
  assert.ok(entity);
  assert.deepEqual(entity!.verifiedPermitPlatformPortals, []);
  for (const url of ISSUE_URLS) refusedOnNem(entity, url, "with evidence");
});

await check("#237: the same URLs still fit the permit track", () => {
  for (const url of ISSUE_URLS) fitsPermit(url, "issue URL");
});

await check("each signature on its own: host label alone, path segment alone", () => {
  for (const url of [
    "https://cityworks.examplecity.gov/",                          // host label, no path
    "https://cityworks.examplecity.gov/pll/apply",                 // host label, other path
    "https://smartgov.examplecounty.gov/",                         // host label, no path
    "https://permits.examplecity.gov/PublicAccess/",               // path segment on a plain host
    "https://apps.examplecity.gov/Cityworks/PublicAccess/login",   // /Cityworks first segment
    "https://apps.examplecity.gov/CityworksPublicAccess/",         // one-word install folder
    "https://online.examplecounty.gov/SmartGov/application/",      // /SmartGov first segment
  ]) {
    assert.equal(isPermitPortalUrl(url), true, `${url} is not a permit portal`);
    refusedOnNem(utility(), url, "single signature");
    fitsPermit(url, "single signature");
  }
});

await check("controls: the existing signatures and vendor hosts still refuse on NEM", () => {
  for (const url of [
    "https://permits.examplecity.gov/CitizenAccess/Default.aspx",
    "https://cvportal.examplecity.gov/CityViewPortal",
    "https://energov.examplecity.gov/EnerGov_Prod/SelfService",
    "https://etrakit.examplecity.gov/eTRAKiT3/",
    "https://examplecity.portal.iworq.net/portalhome",
    "https://www.citizenserve.com/Portal/PortalController?Action=showHomePage&ctzPagePrefix=Portal_&installationID=999",
    "https://www.mygovernmentonline.org/permits/",
    "https://examplecity.viewpointcloud.com/",
    "https://aca-prod.accela.com/EXAMPLE/Default.aspx",
    "https://examplecounty.smartgovcommunity.com/ApplicationPublic/",
  ]) {
    assert.equal(isPermitPortalUrl(url), true, `${url} is not a permit portal`);
    refusedOnNem(utility(), url, "control");
  }
});

await check("controls: a utility's own pages and a city's plain host are not self-hosted permit portals", () => {
  for (const url of [
    "https://utilities.examplecity.gov/solar-interconnection",
    "https://examplemuni.powerclerk.com/MvcAccount/Login",
    "https://www.examplecity.gov/",
  ]) {
    assert.equal(isSelfHostedPermitPortalUrl(url), false, `${url} became a self-hosted permit portal`);
  }
  // "cityworks" / "smartgov" inside a longer label is not the install label (exact label only).
  assert.equal(isSelfHostedPermitPortalUrl("https://mycityworksblog.example.org/post"), false);
  assert.equal(isSelfHostedPermitPortalUrl("https://smartgovernment.example.org/"), false);
});

await check("probe: Click2Gov and a bare /SelfService segment stay open to a municipal utility (not signatures)", () => {
  for (const url of [
    "https://billing.examplecity.gov/Click2GovCX/",
    "https://utilities.examplecity.gov/SelfService/",
  ]) {
    assert.equal(isSelfHostedPermitPortalUrl(url), false, `${url} became a self-hosted permit portal`);
    assert.equal(hostFitsTrackAndEntity("nem", utility(), url, "research").code !== "track_conflict", true, `${url} refused on the NEM track`);
  }
});

await check("probe: a help / FAQ page on a cityworks. host is an information page on BOTH tracks", () => {
  for (const url of [
    "https://cityworks.examplecity.gov/help/faq",
    "https://cityworks.examplecity.gov/PublicAccess/Help/",
    "https://cityworks.examplecity.gov/PublicAccess/docs/submittal-guide.pdf",
    "https://smartgov.examplecounty.gov/faq",
  ]) {
    // The host IS a self-hosted permit portal — the information page wins anyway (step 0 first).
    assert.equal(isSelfHostedPermitPortalUrl(url), true, `${url} lost its install signature`);
    assert.equal(isInformationalPageUrl(url), true, `${url} is not an information page`);
    for (const track of ["nem", "building"]) {
      const fit = hostFitsTrackAndEntity(track, track === "nem" ? utility() : null, url, "kb");
      assert.equal(fit.fits, false, `${url} opened on ${track}: ${fit.reason}`);
      assert.equal(fit.code, "not_a_portal", `${url} on ${track}: ${fit.reason}`);
    }
  }
});

await check("probe: /PublicAccess on an unrelated host (library catalogue) is refused on NEM, untouched on the permit track", () => {
  const LIBRARY = "https://catalog.examplelibrary.org/PublicAccess/search";
  assert.equal(isPermitPortalUrl(LIBRARY), true);
  refusedOnNem(utility(), LIBRARY, "library catalogue");
  fitsPermit(LIBRARY, "library catalogue");
});

await check("carve-out: a SEEDED utility row naming the Cityworks portal never opens it on the NEM track", () => {
  kbRow("kb-example-city-power-cw", UTILITY, "https://cityworks.examplecity-ut.gov/PublicAccess/", false);
  const entity = utility();
  assert.deepEqual(entity!.verifiedPermitPlatformPortals, []);
  assert.ok(!entity!.ownPortals.some((p) => /cityworks\./.test(p)), "a seeded utility row made the Cityworks portal the utility's own");
  refusedOnNem(entity, CW_LOWER, "seeded utility row");
});

await check("carve-out: the utility's own VERIFIED record naming the same Cityworks host + tenant opens it (exactly that)", () => {
  db.run("UPDATE permit_utility_knowledge SET confidence = 'verified', verified_at = ?, verified_by = 'synthetic.reviewer@example.com' WHERE id = 'kb-example-city-power-cw'", [now]);
  const entity = utility();
  assert.deepEqual(entity!.verifiedPermitPlatformPortals, ["https://cityworks.examplecity-ut.gov/PublicAccess/"]);
  const fit = hostFitsTrackAndEntity("nem", entity, CW_LOWER, "kb");
  assert.equal(fit.fits, true, fit.reason);
  assert.equal(fit.code, "ok");
  // Never host-wide: another tenant on the same host stays refused.
  refusedOnNem(entity, "https://cityworks.examplecity-ut.gov/OtherApp/login", "another tenant on the verified host");
  // Never another host: the other city's Cityworks install stays refused.
  refusedOnNem(entity, CW_TEMPLATE, "another Cityworks host");
  // Never another utility.
  refusedOnNem(portalEntityEvidence(db, { scope: "utility", state: ST, name: "Other Example Power" }), CW_LOWER, "another utility");
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall self-hosted permit portal (#237) checks passed");
process.exit(0);
