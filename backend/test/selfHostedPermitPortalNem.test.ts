// RULE 5: A CITY'S SELF-HOSTED PERMIT PORTAL NEVER OPENS ON THE NEM TRACK (#128, P0).
//
// The track check knew permit portals only by VENDOR domain (PERMIT_PLATFORM_HOSTS). Provo runs
// CityView on its own host — its seeded process row names cvportal.provo.gov/CityViewPortal — so on
// a fresh DB hostFitsTrackAndEntity("nem", <a UT utility>, that URL) answered "fits the NEM track".
// Now the NEM track also refuses (a) a self-hosted install of permit software (its install
// signature) and (b) any portal an AHJ row — seeded or verified KB row, AHJ recipe — names as the
// city's permit portal (PortalEntity.permitPortals). The ONE carve-out is unchanged: the utility's
// OWN human-VERIFIED record naming that host AND tenant; never host-wide, never a seeded row, never
// the AHJ's row. An information page is never a portal, whoever names it.
//
// Synthetic data only: the utility and the second city are invented; Provo's row is the seeded
// reference data every fresh DB carries. Nothing reaches the network.
//
//   npx tsx backend/test/selfHostedPermitPortalNem.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "selfhosted-permit-nem-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.PORTAL_AUTOSEED;

const { openDatabase } = await import("../src/db");
const { portalEntityEvidence } = await import("../src/portalRecipes");
const { hostFitsTrackAndEntity, trackSafeUrl, isPermitPlatformUrl, isSelfHostedPermitPortalUrl, isVendorDomain, portalUrlsInText } = await import("../src/portalChannel");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
};

const ST = "UT";
const UTILITY = "Example Municipal Power"; // synthetic: no utility row exists for it
const PROVO = "https://cvportal.provo.gov/CityViewPortal";
const VENDOR = "https://aca-prod.accela.com/EXAMPLEUT/Default.aspx";
// A self-hosted portal with NO install signature: only an AHJ row naming it makes it a permit portal.
const PLAIN = "https://permits.examplecity.gov/apply";
const SOURCES = ["kb", "research", "recipe", "operator", "learn"] as const;
const now = new Date().toISOString();
const utility = () => portalEntityEvidence(db, { scope: "utility", state: ST, name: UTILITY });
const kbRow = (id: string, ahj: string, util: string, url: string, verified: boolean) => db.run(
  `INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, portal_url, confidence, first_seen_at, last_learned_at, updated_at, verified_at, verified_by)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, `${ST.toLowerCase()}|${ahj.toLowerCase()}|${util.toLowerCase()}|${id}`, ST, ahj, util, url, verified ? "verified" : "seeded", now, now, now, verified ? now : null, verified ? "synthetic.reviewer@example.com" : ""],
);
const refusedOnNem = (entity: ReturnType<typeof utility>, url: string, what: string) => {
  for (const source of SOURCES) {
    const fit = hostFitsTrackAndEntity("nem", entity, url, source);
    assert.equal(fit.fits, false, `${what}: ${url} (${source}) opened on the NEM track: ${fit.reason}`);
    assert.equal(fit.code, "track_conflict", `${what}: ${url} (${source}) refused for the wrong reason: ${fit.reason}`);
  }
};

await check("the seeded Provo row names its self-hosted CityView portal in free text; the reader finds it", () => {
  const row = db.query<{ portal_name: string }>("SELECT portal_name FROM permit_utility_knowledge WHERE state = 'UT' AND ahj = 'Provo'")[0];
  assert.ok(row && /cvportal\.provo\.gov/.test(row.portal_name), "the seeded Provo row no longer names cvportal.provo.gov — re-pin this test");
  assert.deepEqual(portalUrlsInText(row.portal_name), [PROVO]);
  assert.deepEqual(portalUrlsInText("see e.g. the U.S. code; apply at https://x.example.gov/a/b."), ["https://x.example.gov/a/b"]);
});

await check("#128: cvportal.provo.gov is refused on the NEM track with no verified utility record (every source, and with no entity)", () => {
  const entity = utility();
  assert.ok(entity);
  assert.deepEqual(entity!.verifiedPermitPlatformPortals, []);
  assert.ok(entity!.permitPortals!.includes(PROVO), "the evidence does not carry the portal Provo's seeded row names");
  refusedOnNem(entity, PROVO, "with evidence");
  refusedOnNem(entity, `${PROVO}/Account/Logon`, "a page of the portal");
  refusedOnNem(null, PROVO, "no entity (install signature alone)");
  assert.equal(trackSafeUrl("nem", PROVO), "", "trackSafeUrl let the self-hosted permit portal onto the NEM track");
  assert.equal(isSelfHostedPermitPortalUrl(PROVO), true);
  // Not a vendor: the permit-side lookups' vendor-domain question is unchanged.
  assert.equal(isPermitPlatformUrl(PROVO), false);
  assert.equal(isVendorDomain("cvportal.provo.gov"), false);
});

await check("control: the same portal still fits Provo's permit track", () => {
  const ahj = portalEntityEvidence(db, { scope: "ahj", state: ST, name: "Provo" });
  assert.equal(trackSafeUrl("building", PROVO), PROVO);
  const fit = hostFitsTrackAndEntity("building", ahj, PROVO, "research");
  assert.equal(fit.fits, true, fit.reason);
});

await check("vendor-hosted control: an Accela tenant is refused on the NEM track and fits the permit track", () => {
  refusedOnNem(utility(), VENDOR, "vendor-hosted");
  assert.equal(hostFitsTrackAndEntity("building", portalEntityEvidence(db, { scope: "ahj", state: ST, name: "Provo" }), VENDOR, "research").fits, true);
});

await check("a portal with no install signature becomes a permit portal for the NEM track once an AHJ row (seeded) names it", () => {
  assert.equal(isSelfHostedPermitPortalUrl(PLAIN), false);
  assert.equal(hostFitsTrackAndEntity("nem", utility(), PLAIN, "research").fits, true, "precondition: nothing names it yet");
  kbRow("kb-examplecity-ahj", "Example City", "", PLAIN, false);
  refusedOnNem(utility(), PLAIN, "seeded AHJ row");
  // Another path on the city's host that the AHJ row does not name stays open (not host-wide).
  assert.equal(hostFitsTrackAndEntity("nem", utility(), "https://permits.examplecity.gov/utilities/net-metering", "research").fits, true);
});

await check("a mis-keyed AHJ row naming a utility interconnection portal makes it no permit portal", () => {
  const powerclerk = "https://examplemuni.powerclerk.com/MvcAccount/Login";
  kbRow("kb-examplecity-miskeyed", "Example Town", "", powerclerk, false);
  assert.ok(!utility()!.permitPortals!.includes(powerclerk));
  assert.equal(hostFitsTrackAndEntity("nem", utility(), powerclerk, "research").code !== "track_conflict", true);
});

await check("the AHJ's own VERIFIED row never opens its portal on the NEM track; a SEEDED utility row never does", () => {
  db.run("UPDATE permit_utility_knowledge SET confidence = 'verified', verified_at = ?, verified_by = 'synthetic.reviewer@example.com' WHERE state = 'UT' AND ahj = 'Provo'", [now]);
  refusedOnNem(utility(), PROVO, "verified AHJ row");
  kbRow("kb-example-muni", "", UTILITY, PROVO, false);
  assert.deepEqual(utility()!.verifiedPermitPlatformPortals, []);
  assert.ok(!utility()!.ownPortals.includes(PROVO), "a seeded utility row made a permit portal the utility's own");
  refusedOnNem(utility(), PROVO, "seeded utility row");
});

await check("carve-out: the utility's own VERIFIED record naming the self-hosted portal opens exactly that host and tenant", () => {
  db.run("UPDATE permit_utility_knowledge SET confidence = 'verified', verified_at = ?, verified_by = 'synthetic.reviewer@example.com' WHERE id = 'kb-example-muni'", [now]);
  const verified = utility();
  assert.deepEqual(verified!.verifiedPermitPlatformPortals, [PROVO]);
  const fit = hostFitsTrackAndEntity("nem", verified, PROVO, "kb");
  assert.equal(fit.fits, true, fit.reason);
  // Never host-wide: another tenant on the same host stays refused.
  refusedOnNem(verified, "https://cvportal.provo.gov/OtherPortal", "another tenant on the verified host");
  // Never another utility: the carve-out is this utility's record only.
  refusedOnNem(portalEntityEvidence(db, { scope: "utility", state: ST, name: "Other Example Power" }), PROVO, "another utility");
  // The same holds for a portal only an AHJ row makes a permit portal.
  kbRow("kb-example-muni-plain", "", UTILITY, PLAIN, true);
  assert.equal(hostFitsTrackAndEntity("nem", utility(), PLAIN, "kb").fits, true);
});

await check("an information page is never a portal, even on the verified host", () => {
  for (const url of [`${PROVO}/help/net-metering-guide.pdf`, "https://cvportal.provo.gov/CityViewPortal/Help"]) {
    const fit = hostFitsTrackAndEntity("nem", utility(), url, "kb");
    assert.equal(fit.fits, false, `${url} opened: ${fit.reason}`);
    assert.equal(fit.code, "not_a_portal");
  }
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall self-hosted permit portal (NEM) checks passed");
process.exit(0);
