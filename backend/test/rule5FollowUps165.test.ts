// RULE 5 FOLLOW-UPS FROM #158 (#165). Three gaps in the one predicate, hostFitsTrackAndEntity:
//
//   3. (P1) A PowerClerk tenant whose LABEL names a known utility was nobody's: probing
//      rockymountainpower.powerclerk.com against the PGE (OR) utility answered "fits", because step 2b
//      only knew PacifiCorp's exact tenant host. Now a branded tenant label is that utility's, and a
//      known utility's only PowerClerk tenant is its own known one — foreign_entity otherwise, unless a
//      person verified it for this utility (rule 3).
//   2. A city's marketing page ("…/permit-solutions") passed isInformationalPageUrl.
//   1. PortalEntity.permitPortals took AHJ rows from EVERY state, and a row naming a city's bare web
//      domain made every page of that domain a permit portal on the NEM track.
//
// Synthetic hosts and names only (example.gov / invented tenants); the PGE / Pacific Power rows are
// the seeded reference data every fresh DB carries. Nothing reaches the network.
//
//   npx tsx backend/test/rule5FollowUps165.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rule5-165-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.PORTAL_AUTOSEED;

const { openDatabase } = await import("../src/db");
const { portalEntityEvidence } = await import("../src/portalRecipes");
const { hostFitsTrackAndEntity, isInformationalPageUrl } = await import("../src/portalChannel");
type Entity = NonNullable<ReturnType<typeof portalEntityEvidence>>;

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
};
const SOURCES = ["kb", "research", "recipe", "operator", "learn", "statewide"] as const;
const now = new Date().toISOString();
const bare = (state: string, name: string, extra: Partial<Entity> = {}): Entity => ({
  scope: "utility", state, name, ownPortals: [], verifiedPortals: [], otherClaims: [], sharedPortals: [], verifiedPermitPlatformPortals: [], permitPortals: [], ...extra,
});
const refused = (entity: Entity | null, url: string, code: string, what: string) => {
  for (const source of SOURCES) {
    const fit = hostFitsTrackAndEntity("nem", entity, url, source);
    assert.equal(fit.fits, false, `${what}: ${url} (${source}) fit: ${fit.reason}`);
    assert.equal(fit.code, code, `${what}: ${url} (${source}) refused for the wrong reason: ${fit.reason}`);
  }
};
const fits = (entity: Entity | null, url: string, what: string) => {
  const fit = hostFitsTrackAndEntity("nem", entity, url, "research");
  assert.equal(fit.fits, true, `${what}: ${url} was refused: ${fit.reason}`);
};
const kbRow = (id: string, state: string, ahj: string, url: string) => db.run(
  `INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, portal_url, confidence, first_seen_at, last_learned_at, updated_at, verified_at, verified_by)
   VALUES (?, ?, ?, ?, '', ?, 'seeded', ?, ?, ?, NULL, '')`,
  [id, `${state.toLowerCase()}|${ahj.toLowerCase()}||${id}`, state, ahj, url, now, now, now],
);

// ── 3. A branded PowerClerk tenant against another utility (P1) ──────────────────────────
const RMP_TENANT = "https://rockymountainpower.powerclerk.com/MvcAccount/Login";
await check("#165 item 3: a Rocky Mountain Power PowerClerk host is foreign_entity for PGE (OR) — DB evidence, every source", () => {
  for (const name of ["PGE", "Portland General Electric"]) {
    const pge = portalEntityEvidence(db, { scope: "utility", state: "OR", name });
    assert.ok(pge && pge.ownPortals.some((u) => u.includes("pgenm.powerclerk.com")), `precondition: the seeded ${name} row no longer names pgenm — re-pin`);
    refused(pge, RMP_TENANT, "foreign_entity", name);
    for (const u of ["https://rmp.powerclerk.com/", "https://pacificpower-nem.powerclerk.com/MvcAccount/Login", "https://rockymtnpowernetmetering.powerclerk.com/"]) refused(pge, u, "foreign_entity", `${name}, branded label`);
  }
});

await check("#165 item 3: the same with no DB evidence (pure entity); a known utility's only tenant is its own", () => {
  refused(bare("OR", "PGE"), RMP_TENANT, "foreign_entity", "pure PGE");
  // PGE files on pgenm and nowhere else on PowerClerk: an unbranded other tenant is not its portal.
  refused(bare("OR", "PGE"), "https://exampleutility.powerclerk.com/MvcAccount/Login", "foreign_entity", "PGE, other tenant");
  refused(bare("UT", "Rocky Mountain Power"), "https://exampleutility.powerclerk.com/MvcAccount/Login", "foreign_entity", "RMP, other tenant");
  // A utility the identity does not know is provably not PacifiCorp's tenant either.
  refused(bare("ID", "Example Idaho Electric"), RMP_TENANT, "foreign_entity", "unknown utility");
  // Portland General's branded label for a PacifiCorp utility.
  refused(bare("OR", "Pacific Power"), "https://portlandgeneral.powerclerk.com/", "foreign_entity", "Pacific Power vs portlandgeneral");
});

await check("controls: each utility fits its own known tenant; an unknown utility its own unbranded one; a verified record wins", () => {
  // Fail closed for the owner too: PacifiCorp files on ONE known tenant, so an unverified branded
  // label (an impostor, or a tenant nobody confirmed) is not Rocky Mountain Power's portal either.
  refused(bare("UT", "Rocky Mountain Power"), RMP_TENANT, "foreign_entity", "RMP on an unverified branded label");
  fits(bare("UT", "Rocky Mountain Power", { ownPortals: [RMP_TENANT], verifiedPortals: [RMP_TENANT] }), RMP_TENANT, "RMP, verified");
  fits(bare("UT", "RMP"), "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login", "RMP on PacifiCorp's tenant");
  fits(portalEntityEvidence(db, { scope: "utility", state: "OR", name: "PGE" }), "https://pgenm.powerclerk.com/MvcAccount/Login", "PGE on pgenm");
  fits(bare("CO", "Example Electric Coop"), "https://examplecoop.powerclerk.com/MvcAccount/Login", "unknown utility, its own tenant");
  // An unknown state is not provable (the name matches the brand): not refused as foreign.
  fits(bare("", "Rocky Mountain Power"), RMP_TENANT, "unknown state");
  // Rule 3: a person verified this tenant for PGE — nothing derived second-guesses it.
  const verified = bare("OR", "PGE", { ownPortals: ["https://exampleutility.powerclerk.com/MvcAccount/Login"], verifiedPortals: ["https://exampleutility.powerclerk.com/MvcAccount/Login"] });
  fits(verified, "https://exampleutility.powerclerk.com/MvcAccount/Login", "verified");
  // The bare "pge" label is PG&E's spelling as much as Portland General's: not read as a brand.
  fits(bare("CA", "Pacific Gas and Electric"), "https://pge.powerclerk.com/", "PG&E on a pge label");
});

// ── 2. Marketing / "permit-solutions" pages are information pages ────────────────────────
await check("#165 item 2: a city's permit-solutions / marketing page is an information page on both tracks", () => {
  for (const url of [
    "https://www.examplecity.gov/departments/sustainable-development/building-services/permit-solutions",
    "https://www.examplecity.gov/permit-solutions",
    "https://www.examplecity.gov/solutions/permitting",
    "https://www.exampleutility.com/products/solar",
    "https://www.examplevendor.com/permitting-software",
    "https://www.examplecity.gov/about-us",
  ]) {
    assert.equal(isInformationalPageUrl(url), true, `${url} is not an information page`);
    for (const track of ["building", "nem"]) {
      const fit = hostFitsTrackAndEntity(track, null, url, "research");
      assert.equal(fit.code, "not_a_portal", `${url} on ${track}: ${fit.reason}`);
    }
  }
});

await check("controls: application pages and plain city paths are not information pages", () => {
  for (const url of [
    "https://www.cityofexample.gov/building/permits",
    "https://utilities.cityofexample.gov/solar-interconnection",
    "https://permits.examplecity.gov/apply",
    "https://aca-prod.accela.com/EXAMPLE/Default.aspx",
    "https://exampleutility.powerclerk.com/MvcAccount/Login",
    "https://www.examplecity.gov/user-preferences",
  ]) assert.equal(isInformationalPageUrl(url), false, `${url} read as an information page`);
});

// ── 1. permitPortals: this state only; a bare city domain is not host-wide ───────────────
const UT_PORTAL = "https://permits.exampletownut.gov/apply";
await check("#165 item 1: an AHJ row's portal is a permit portal for utilities of ITS state only", () => {
  fits(portalEntityEvidence(db, { scope: "utility", state: "UT", name: "Example Muni Power" }), UT_PORTAL, "precondition: nothing names it");
  kbRow("kb-165-ut-town", "UT", "Example Town", UT_PORTAL);
  const ut = portalEntityEvidence(db, { scope: "utility", state: "UT", name: "Example Muni Power" })!;
  assert.ok(ut.permitPortals!.includes(UT_PORTAL));
  refused(ut, UT_PORTAL, "track_conflict", "UT utility");
  const or = portalEntityEvidence(db, { scope: "utility", state: "OR", name: "Example Oregon Power" })!;
  assert.ok(!or.permitPortals!.includes(UT_PORTAL), "a Utah city's portal became an Oregon utility's permit portal");
  fits(or, UT_PORTAL, "OR utility");
  // Fail closed: a utility with no readable state still sees every state's rows.
  const nostate = portalEntityEvidence(db, { scope: "utility", state: "", name: "Example Muni Power" })!;
  assert.ok(nostate.permitPortals!.includes(UT_PORTAL), "a utility with no state lost the refusal");
  // "Utah" spelled out is Utah.
  assert.ok(portalEntityEvidence(db, { scope: "utility", state: "Utah", name: "Example Muni Power" })!.permitPortals!.includes(UT_PORTAL));
});

await check("#165 item 1: a seeded row naming a city's BARE web domain covers that domain's root, never every page on it", () => {
  kbRow("kb-165-bare-city", "UT", "Example Bare City", "https://www.examplebarecity.gov/");
  const ut = portalEntityEvidence(db, { scope: "utility", state: "UT", name: "Example Muni Power" })!;
  assert.ok(ut.permitPortals!.includes("https://www.examplebarecity.gov/"));
  refused(ut, "https://www.examplebarecity.gov/", "track_conflict", "the bare root itself");
  refused(ut, "https://examplebarecity.gov/Default.aspx", "track_conflict", "a root page");
  fits(ut, "https://www.examplebarecity.gov/utilities/solar-interconnection", "the city site's utility page");
  // A bare DEDICATED host is the permit system's own: still host-wide.
  kbRow("kb-165-bare-dedicated", "UT", "Example Dedicated City", "https://permits.examplededicated.gov");
  refused(portalEntityEvidence(db, { scope: "utility", state: "UT", name: "Example Muni Power" }), "https://permits.examplededicated.gov/anything/apply", "track_conflict", "dedicated host");
  // A row naming a tenant path is matched by that tenant, as before.
  kbRow("kb-165-tenant", "UT", "Example Tenant City", "https://www.exampletenantcity.gov/eTRAKiT");
  refused(portalEntityEvidence(db, { scope: "utility", state: "UT", name: "Example Muni Power" }), "https://www.exampletenantcity.gov/etrakit/Search/permit.aspx", "track_conflict", "tenant path");
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall #165 rule 5 follow-up checks passed");
process.exit(0);
