// ONE TWO-WAY PREDICATE: A PORTAL URL MUST FIT THE TRACK AND THE PROJECT'S OWN ENTITY.
//
// hostFitsTrackAndEntity (portalChannel) + portalEntityEvidence (portalRecipes) decide, for every
// URL a stage could launch and every recipe it could replay:
//   - rule 5 BOTH ways: a permit track never gets a utility interconnection portal, and a NEM
//     track never gets an AHJ permit portal (the NEM direction had no predicate at all);
//   - a URL or recipe for entity X is never used for entity Y (a ComEd project was staged with
//     the PGE recipe, fe12ed81);
//   - where a person VERIFIED the entity's portal, nothing stored or researched that disagrees is
//     launched (research resolved Tigard to Accela; Tigard's verified rows say EnerGov).
// Evidence is written through the REAL writers (startPortalRecording + savePortalRecipeSteps,
// saveVerifiedAhjProfile, saveResearchedAhjProfile); the end-to-end cases drive the real
// prepareSubmission with only the browser stubbed.
//
// KILL TESTS (each turns this file red — verified by hand, see the commit):
//   K1 portalChannel.trackSafeUrl: drop the NEM branch (return value)      → (p2) fails.
//   K2 portalRecipes.portalEntityEvidence: no alias merge (owner per exact
//      spelling)                                                         → (e2) fails.
//   K3 portalChannel.hostFitsTrackAndEntity: drop the verified-portal leg  → (e3) fails.
//   K4 repository.prepareSubmission: drop the recipe entity gate          → (s1) fails.
//   K5 portalRecipes.recipeHostFit: entry URL only (ignore goto steps)    → (s2) fails.
//
// Run: npx tsx backend/test/portalHostFit.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("portal-host-fit");
const { db, repo, recipes } = fx;
const channel = await import("../src/portalChannel");
const kb = await import("../src/knowledgeBase");
const { hostFitsTrackAndEntity, samePortal, trackSafeUrl } = channel;

// Production URLs (read from a copy of the live DB, 2026-09-24).
const PGE_NM = "https://pgenm.powerclerk.com/MvcAccount/Login";
const PACIFICORP_NM = "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login";
const COMED = "https://interconnect.comed.com/login";
const ACA_OREGON = "https://aca-oregon.accela.com/oregon/";
const TIGARD_ENERGOV = "https://tigardor-energovweb.tylerhost.net/apps/SelfService#/home";
const DOUGLAS_IWORQ = "https://douglascounty.portal.iworq.net/portalhome/douglascounty";

const REVIEW = { action: "stopForReview", selector: {} } as never;
const fill = (i: number) => ({ action: "fill", selector: { name: `f${i}` }, field: "homeownerName", note: `Field ${i}` }) as never;

function utilityRecipe(state: string, utility: string, portalUrl: string) {
  const r = recipes.startPortalRecording(db, { scopeType: "utility", state, utility, portalUrl, createdBy: "test" });
  return recipes.savePortalRecipeSteps(db, r.id, [fill(1), fill(2), REVIEW], { status: "complete" });
}
function ahjRecipe(state: string, ahj: string, portalUrl: string, discipline = "structural", extraSteps: never[] = []) {
  const r = recipes.startPortalRecording(db, { scopeType: "ahj", state, ahj, utility: "Pacific Power", portalUrl, discipline, createdBy: "test" });
  return recipes.savePortalRecipeSteps(db, r.id, [...extraSteps, fill(1), fill(2), REVIEW], { status: "complete" });
}
const entity = (scope: "ahj" | "utility", state: string, name: string) => recipes.portalEntityEvidence(db, { scope, state, name });

// ── the track half, both directions (pure) ───────────────────────────────────────────────────
await check("(p1) permit track: a utility interconnection portal never fits; permit portals do (MUST-EXCLUDE + MUST-PASS)", () => {
  for (const u of [PGE_NM, PACIFICORP_NM, COMED, "https://acme-utility.my.site.com/s/interconnection", "https://acme.force.com/nem"]) {
    assert.equal(hostFitsTrackAndEntity("building", null, u).code, "track_conflict", `${u} must not fit a permit track`);
    assert.equal(trackSafeUrl("electrical", u), "", u);
  }
  for (const u of [ACA_OREGON, TIGARD_ENERGOV, DOUGLAS_IWORQ, "https://www.cityofsalem.net/permits"]) {
    assert.equal(hostFitsTrackAndEntity("building", null, u).fits, true, `${u} must fit a permit track`);
  }
});

await check("(p2) NEM track: an AHJ permit portal never fits; utility portals and a municipal utility's .gov host do", () => {
  for (const u of [ACA_OREGON, TIGARD_ENERGOV, DOUGLAS_IWORQ, "https://aca-prod.accela.com/CHINO/Login.aspx", "https://salemma.portal.opengov.com/"]) {
    assert.equal(hostFitsTrackAndEntity("nem", null, u).code, "track_conflict", `${u} must not fit the NEM track`);
    assert.equal(trackSafeUrl("nem", u), "", u);
  }
  for (const u of [PGE_NM, COMED, "https://acme-utility.my.site.com/s/", "https://utilities.cityofexample.gov/solar-interconnection"]) {
    assert.equal(hostFitsTrackAndEntity("nem", null, u).fits, true, `${u} must fit the NEM track`);
  }
});

await check("(p2b) close-2 item 9: MyGov and Geocivix are permit platforms; a STATE agency's Salesforce Experience site (nmrld.my.site.com) fits the permit track, while a utility's Salesforce tenant (a utility word, a known brand, an interconnection path) is still refused there", () => {
  for (const u of ["https://public.mygov.us/venus_tx/", "https://santafecounty.geocivix.com/secure/", "https://nmrld.my.site.com/s/electrical-permits", "https://nmrld.force.com/apply"]) {
    assert.equal(hostFitsTrackAndEntity("building", null, u).fits, true, `${u} must fit a permit track`);
  }
  for (const u of ["https://public.mygov.us/venus_tx/", "https://santafecounty.geocivix.com/secure/"]) {
    assert.equal(hostFitsTrackAndEntity("nem", null, u).code, "track_conflict", `${u} is a permit platform: it must not fit the NEM track`);
  }
  for (const u of ["https://acme-utility.my.site.com/s/interconnection", "https://acme.force.com/nem", "https://pge.my.site.com/s/", "https://rockymountainpower.force.com/apply", "https://acme-electric.my.site.com/s/", "https://acme.my.site.com/s/net-metering-application"]) {
    assert.equal(hostFitsTrackAndEntity("building", null, u).code, "track_conflict", `${u} must not fit a permit track`);
    assert.equal(hostFitsTrackAndEntity("nem", null, u).fits, true, `${u} must fit the NEM track`);
  }
  assert.equal(channel.isPermitPlatformUrl("https://www.mygov.us/"), true);
  assert.equal(channel.isPermitPlatformUrl("https://nmrld.my.site.com/s/"), false, "a Salesforce site is no platform of either kind by default");
  assert.equal(channel.isUtilityPlatformUrl("https://nmrld.my.site.com/s/"), false);
});

await check("(p2c) MUST-EXCLUDE (close-3 caveat C, rule 5 fails closed): a Salesforce Experience site is NOT a permit portal by default — every plausible utility tenant, listed or not (entergy, eversource, dte, nationalgrid, fpl, srp, pnm, xcel, evergy, aep, tep …), and an unknown tenant are refused on the permit track; MUST-PASS: a tenant that positively names a government agency (nmrld, txtdlr, cityof…, …permits, a state's name) fits; the NEM track is unchanged", () => {
  const utilities = ["entergy", "eversource", "dte", "nationalgrid", "fpl", "srp", "pnm", "xcel", "evergy", "aep", "tep", "pge", "rockymountainpower", "duke-energy", "nvenergy", "dominionenergy", "acme-utility", "acme-electric", "buildingenergy", "coned", "pseg", "puget-sound-energy"];
  for (const t of utilities) {
    for (const u of [`https://${t}.my.site.com/s/`, `https://${t}.force.com/apply`, `https://${t}.my.salesforce-sites.com/`]) {
      assert.equal(channel.isUtilityPlatformUrl(u), true, `${u} is a utility host`);
      assert.equal(hostFitsTrackAndEntity("building", null, u, "research").code, "track_conflict", `${u} must not fit a permit track`);
      assert.equal(hostFitsTrackAndEntity("nem", null, u).fits, true, `${u} still fits the NEM track`);
    }
  }
  // Unknown tenants: no agency word, no utility word — refused (fails closed), with a reason that says so.
  for (const t of ["acme", "acidco", "portal-x", "customer-portal", "sfc", "abrld"]) {
    const u = `https://${t}.my.site.com/s/`;
    assert.equal(channel.salesforceTenantKind(u), "unknown", `${t} names nobody`);
    assert.equal(channel.isUtilityPlatformUrl(u), true, `${u} is refused on the permit track by default`);
    const fit = hostFitsTrackAndEntity("building", null, u, "research");
    assert.equal(fit.code, "track_conflict");
    assert.match(fit.reason, /names no government agency/, fit.reason);
    assert.equal(hostFitsTrackAndEntity("nem", null, u).fits, true);
  }
  // An interconnection path on any tenant, and a utility word beside an agency word, are utility.
  for (const u of ["https://cityofelm.my.site.com/s/interconnection", "https://nmpermits.force.com/net-metering-application", "https://cityofelm-utilities.my.site.com/s/", "https://austinenergy.my.site.com/s/"]) {
    assert.equal(channel.salesforceTenantKind(u), "utility", u);
    assert.equal(hostFitsTrackAndEntity("building", null, u, "research").code, "track_conflict", u);
  }
  // THE GOVERNMENT ALLOWLIST (lookup-close-4 D2): an explicit label (nmrld, txtdlr), a state code run
  // together with a state agency's abbreviation (nm-cid -> nmcid), or a label ending in permits / permitting.
  for (const u of ["https://nmrld.my.site.com/s/electrical-permits", "https://nmrld.force.com/apply", "https://txtdlr.my.site.com/s/", "https://nm-cid.my.site.com/s/", "https://orbcd.my.site.com/s/", "https://elmcountypermits.my.site.com/s/", "https://newmexico-permits.force.com/s/", "https://buildingpermits.my.site.com/s/", "https://elm-permitting.my.site.com/s/"]) {
    assert.equal(channel.salesforceTenantKind(u), "agency", u);
    assert.equal(channel.isUtilityPlatformUrl(u), false, u);
    assert.equal(hostFitsTrackAndEntity("building", null, u, "research").fits, true, `${u} must fit a permit track`);
    assert.equal(channel.isPermitPlatformUrl(u), false, "still no platform of either kind");
  }
  // NO WORD SCORING (close-3-v MF2): a city's / building / state / county word, an abbreviation with the state's
  // letters after it, or a utility word inside the run-together label names NO agency — refused, with the rule named.
  const notAllowlisted = ["bcdor", "cityofsantafe", "buildingsafety", "stateofnm", "countyofmarin", "cityoflasvegas", "cityoftallahassee", "cityofelm-water",
    "tricountyemc", "tri-county-emc", "jacksoncountyremc", "douglascountypud", "clallamcountypud", "snohomishcountypud", "dpl", "ohdpl", "newmexicogas", "texasgas", "washingtongas", "cityofelmgas", "cpsenergy", "ladwp", "smud", "lipa", "coned-permits", "abrld", "acidco"];
  for (const t of notAllowlisted) {
    const u = `https://${t}.my.site.com/s/`;
    assert.notEqual(channel.salesforceTenantKind(u), "agency", `${t} is not on the allowlist`);
    const fit = hostFitsTrackAndEntity("building", null, u, "research");
    assert.equal(fit.code, "track_conflict", `${t} must not fit a permit track`);
    assert.match(fit.reason, /rule 5 fails closed/, fit.reason);
    assert.equal(hostFitsTrackAndEntity("nem", null, u).fits, true, `${t} still fits the NEM track`);
  }
  for (const t of ["tricountyemc", "douglascountypud", "coned-permits", "cpsenergy", "cityofelm-utilities"]) assert.equal(channel.salesforceTenantKind(`https://${t}.my.site.com/s/`), "utility", `${t} names a utility`);
  for (const t of ["newmexicogas", "cityoflasvegas", "cityofsantafe", "dpl"]) assert.equal(channel.salesforceTenantKind(`https://${t}.my.site.com/s/`), "unknown", `${t}: no word scoring — unknown, refused with the rule named`);
  // D2b: a human-VERIFIED KB row for THIS AHJ naming that host and tenant opens it — a seeded row, another
  // AHJ's row, or another tenant on the host does not.
  const sfCity = "https://cityofsantafe.my.site.com/s/permits";
  const ahj = (verified: string[], own: string[] = verified): channel.PortalEntity => ({ scope: "ahj", state: "NM", name: "City of Santa Fe", ownPortals: own, verifiedPortals: verified, otherClaims: [] });
  assert.equal(hostFitsTrackAndEntity("building", ahj(["https://cityofsantafe.my.site.com/s/"]), sfCity, "research").fits, true, "verified row names the host and tenant");
  assert.match(hostFitsTrackAndEntity("building", ahj(["https://cityofsantafe.my.site.com/s/"]), sfCity, "research").reason, /human-verified record/);
  assert.equal(hostFitsTrackAndEntity("building", ahj([], ["https://cityofsantafe.my.site.com/s/"]), sfCity, "research").code, "track_conflict", "a seeded row does not open it");
  assert.equal(hostFitsTrackAndEntity("building", ahj(["https://cityofsantafe.my.site.com/other/"]), sfCity, "research").code, "track_conflict", "another tenant on the host does not");
  assert.equal(hostFitsTrackAndEntity("building", { ...ahj([sfCity]), scope: "utility" }, sfCity, "research").code, "track_conflict", "a utility-scoped entity never opens it on the permit track");
  assert.equal(hostFitsTrackAndEntity("building", ahj(["https://pge.my.site.com/s/"]), "https://pge.my.site.com/s/", "research").fits, true, "even a utility-worded tenant: a person said so (rule 3)");
  assert.equal(channel.salesforceTenantKind("https://aca-prod.accela.com/NMRLD/"), null, "not a Salesforce host");
  assert.equal(channel.isUtilityPlatformUrl("https://aca-prod.accela.com/ENTERGY/"), false, "the tenant rule is Salesforce-only");
});

await check("(p3) same portal: host, and the tenant of a path-tenanted host", () => {
  assert.equal(samePortal(ACA_OREGON, "https://aca-oregon.accela.com/OREGON/Cap/CapHome.aspx?module=Building"), true);
  assert.equal(samePortal("https://aca-prod.accela.com/CHINO/Login.aspx", "https://aca-prod.accela.com/SANDIEGO/Default.aspx"), false);
  assert.equal(samePortal("https://www.cityofsalem.net/", "https://cityofsalem.net/permits"), true, "the host root is compatible with any tenant");
  assert.equal(channel.sameHost("https://www.cityofsalem.net/x", "https://cityofsalem.net/y"), true, "www. is the same host");
  assert.equal(samePortal(PGE_NM, PACIFICORP_NM), false);
  assert.equal(samePortal("not a url", "not a url"), false);
});

// ── the entity half, on evidence written through the real writers ────────────────────────────
utilityRecipe("OR", "PGE", PGE_NM);
utilityRecipe("OR", "Portland General Electric", PGE_NM);
utilityRecipe("OR", "Pacific Power", PACIFICORP_NM);
utilityRecipe("IL", "Commonwealth Edison ComEd", COMED);

await check("(e1) fe12ed81: PGE's PowerClerk is foreign to a ComEd project; ComEd's own portal fits", () => {
  const comed = entity("utility", "IL", "Commonwealth Edison ComEd");
  const bad = hostFitsTrackAndEntity("nem", comed, PGE_NM, "recipe");
  assert.equal(bad.code, "foreign_entity", bad.reason);
  assert.equal(hostFitsTrackAndEntity("nem", comed, COMED, "recipe").fits, true);
});

await check("(e2) aliases are ONE owner: PGE and 'Portland General Electric' never make pgenm a shared portal for Pacific Power", () => {
  const pacific = entity("utility", "OR", "Pacific Power");
  const fit = hostFitsTrackAndEntity("nem", pacific, PGE_NM, "kb");
  assert.equal(fit.code, "foreign_entity", `pgenm must be foreign to Pacific Power, got ${fit.code}: ${fit.reason}`);
  // …and a PGE project, spelled either way, owns it.
  assert.equal(hostFitsTrackAndEntity("nem", entity("utility", "OR", "PGE"), PGE_NM).fits, true);
  assert.equal(hostFitsTrackAndEntity("nem", entity("utility", "OR", "Portland General Electric"), PGE_NM).fits, true);
});

await check("(e3) research resolved Tigard to Accela: a verified EnerGov row means the Accela URL is not launched", () => {
  kb.saveVerifiedAhjProfile(db, { state: "OR", ahj: "City of Tigard", portalUrl: TIGARD_ENERGOV, portalPlatform: "EnerGov", verifiedBy: "test" });
  const tigard = entity("ahj", "OR", "City of Tigard");
  const research = hostFitsTrackAndEntity("building", tigard, ACA_OREGON, "research");
  assert.equal(research.code, "platform_conflict", research.reason);
  assert.equal(hostFitsTrackAndEntity("building", tigard, TIGARD_ENERGOV, "research").fits, true);
  // MUST-PASS: an AHJ with no verified portal is not held to one.
  assert.equal(hostFitsTrackAndEntity("building", entity("ahj", "OR", "City of Lincoln City"), ACA_OREGON, "research").fits, true);
});

await check("(e4) a portal many entities share fits a new one; a portal one other AHJ owns does not", () => {
  ahjRecipe("OR", "City of Coos Bay", ACA_OREGON);
  kb.saveVerifiedAhjProfile(db, { state: "OR", ahj: "City of Salem", portalUrl: ACA_OREGON, portalPlatform: "accela", verifiedBy: "test" });
  const lincoln = entity("ahj", "OR", "City of Lincoln City");
  assert.equal(hostFitsTrackAndEntity("building", lincoln, "https://aca-oregon.accela.com/OREGON/Default.aspx", "kb").fits, true, "aca-oregon is shared");
  const tigardHost = hostFitsTrackAndEntity("building", lincoln, TIGARD_ENERGOV, "kb");
  assert.equal(tigardHost.code, "foreign_entity", tigardHost.reason);
  // The statewide fallback is a deliberate rule, not someone else's row.
  assert.equal(hostFitsTrackAndEntity("building", lincoln, TIGARD_ENERGOV, "statewide").fits, true);
});

await check("(e5) benchmark rows keyed on a hostname are no entity and claim nothing", () => {
  ahjRecipe("OR", "Benchmark cityofwilsonvilleor-energovweb.tylerhost.net", "https://cityofwilsonvilleor-energovweb.tylerhost.net/apps/selfservice", "electrical");
  const e = entity("ahj", "OR", "City of Wilsonville")!;
  assert.equal(e.otherClaims.some((c) => /wilsonville/.test(c.url)), false, JSON.stringify(e.otherClaims));
});

await check("(e6) a Tigard KB row carrying PGE's PowerClerk is no claim, and never fits Tigard's permit track", () => {
  kb.saveResearchedAhjProfile(db, { state: "OR", ahj: "City of Tigard", utility: "Portland General Electric" }, {
    provider: "claude", portalName: "PowerClerk (utility interconnection)", portalPlatform: "PowerClerk", portalUrl: PGE_NM,
    submissionMethod: "online", requiredDocuments: ["Plan set"], commonCorrections: [], tips: [], submissionSteps: [],
    confidence: "low", needsHumanVerification: true, notes: "", webGrounded: true,
  });
  const tigard = entity("ahj", "OR", "City of Tigard")!;
  assert.equal(tigard.ownPortals.some((u) => /powerclerk/.test(u)), false, "a utility URL on an AHJ row is not a claim");
  assert.equal(hostFitsTrackAndEntity("building", tigard, PGE_NM, "kb").code, "track_conflict");
});

// ── resolution skeptic MF4: junk KB entity names claim nothing ───────────────────────────────
await check("(e7) MF4: a reference import's junk AHJ names ('OR portal', '1 - 5 DAYS', …) own no portal — MUST-EXCLUDE Lincoln City is refused Roseburg's portal (it is Roseburg's, not shared); MUST-PASS Roseburg fits it, Medford fits its own", () => {
  // The rows production holds, written through the writer that let them in (the reference import).
  const ROSEBURG = "https://roseburgor.portal.opengov.com/";
  const MEDFORD = "https://medford-or-us.avolvecloud.com/ProjectDox/";
  const WASHCO = "https://pprmaca.co.washington.or.us/CitizenAccess/";
  const TUKWILA = "https://tukwilawa.portal.opengov.com/";
  const imported = (state: string, ahj: string, portalUrl: string) =>
    kb.importSeededAhjKnowledge(db, { state, ahj, portalUrl, sourceLabel: "reference sheet (e7)" });
  assert.equal(imported("OR", "ROSEBURG", ROSEBURG), "imported");
  assert.equal(imported("OR", "OR portal", ROSEBURG), "imported", "premise: the import lets the junk row in (that is why the evidence must judge it)");
  assert.equal(imported("OR", "1 - 5 DAYS", MEDFORD), "imported");
  assert.equal(imported("OR", "2-5 days / REV 3-8 days if resubmitted", WASHCO), "imported");
  assert.equal(imported("WA", "WA portal", TUKWILA), "imported");
  assert.equal(imported("WA", "Tukwila", TUKWILA), "imported");
  // MUST-EXCLUDE: Roseburg's portal has ONE owner — Roseburg — so Lincoln City is refused it.
  const lincoln = entity("ahj", "OR", "City of Lincoln City")!;
  const roseburgOwners = [...new Set(lincoln.otherClaims.filter((c) => /roseburgor/.test(c.url)).map((c) => c.owner))];
  assert.deepEqual(roseburgOwners, ["ROSEBURG (OR)"], `junk names count as owners: ${JSON.stringify(roseburgOwners)}`);
  const fit = hostFitsTrackAndEntity("building", lincoln, ROSEBURG, "kb");
  assert.equal(fit.code, "foreign_entity", `Lincoln City launched Roseburg's portal: ${fit.reason}`);
  assert.equal(lincoln.otherClaims.some((c) => /DAYS|days|portal \(/.test(c.owner)), false, `a turnaround or column header owns a portal: ${JSON.stringify(lincoln.otherClaims.map((c) => c.owner))}`);
  const tukwilaOwners = [...new Set(entity("ahj", "WA", "City of Kent")!.otherClaims.filter((c) => /tukwila/.test(c.url)).map((c) => c.owner))];
  assert.deepEqual(tukwilaOwners, ["Tukwila (WA)"]);
  // MUST-PASS: the real owners fit their own portals (aliases: "City of Roseburg" is "ROSEBURG").
  assert.ok(kb.knowledgeNameMatchScore("City of Roseburg", "ROSEBURG") >= 78, "the alias scorer does not merge the spellings (ENTITY_ALIAS_MIN_SCORE is 78)");
  const roseburg = entity("ahj", "OR", "City of Roseburg")!;
  assert.ok(roseburg.ownPortals.some((u) => /roseburgor/.test(u)), "Roseburg does not own its own portal");
  assert.equal(hostFitsTrackAndEntity("building", roseburg, ROSEBURG, "kb").fits, true);
  const medford = hostFitsTrackAndEntity("building", entity("ahj", "OR", "City of Medford"), MEDFORD, "kb");
  assert.equal(medford.fits, true, `Medford refused its own portal because a turnaround owned it: ${medford.reason}`);
  const washco = hostFitsTrackAndEntity("building", entity("ahj", "OR", "Washington County"), WASHCO, "kb");
  assert.equal(washco.fits, true, washco.reason);
  // A city that merely sounds like a duration is still an entity (no digit → not a turnaround).
  assert.equal(imported("OR", "Days Creek", "https://dayscreek.portal.example/"), "imported");
  const daysCreekOwners = [...new Set(entity("ahj", "OR", "City of Lincoln City")!.otherClaims.filter((c) => /dayscreek/.test(c.url)).map((c) => c.owner))];
  assert.deepEqual(daysCreekOwners, ["Days Creek (OR)"], "Days Creek is a jurisdiction, not a turnaround");
});

// ── close MF4-class: a spreadsheet SENTENCE in the AHJ column names no entity ────────────────
// Production aae50fab (AZ): 'FIRE PERMIT: 3 kW – 15 kW submit for permit via email NON SOLARAPP+
// SUBMITTALS:' on gosolarapp.org — masked today only because West Palm Beach's row also claims that
// host. On a host nobody else claims, the sentence was the SOLE owner (probe P3b) and a real AZ city
// was refused the portal as foreign_entity.
// KILL: drop the four shape rules from looksLikePortalJunkName → (e8) fails.
await check("(e8) MF4-class MUST-EXCLUDE: a sentence ('ELECTRICAL PERMIT: 3 kW – 15 kW submit … SUBMITTALS:') owns no host — Tucson is not refused it, and aae50fab's sentence owns gosolarapp.org with no West Palm Beach row; MUST-PASS: 'Tomball (emailed for link to portal)' and 'Village of Skokie, IL' still own theirs", () => {
  const imported = (state: string, ahj: string, portalUrl: string) =>
    kb.importSeededAhjKnowledge(db, { state, ahj, portalUrl, sourceLabel: "reference sheet (e8)" });
  const ownersOn = (who: ReturnType<typeof entity>, re: RegExp) => [...new Set((who?.otherClaims ?? []).filter((c) => re.test(c.url)).map((c) => c.owner))];
  // P3b: the sentence alone on a non-platform host.
  const HOST = "https://permits.examplecounty-az.gov/portal/";
  assert.equal(imported("AZ", "ELECTRICAL PERMIT: 3 kW – 15 kW submit for permit via email NON SOLARAPP+ SUBMITTALS:", HOST), "imported", "premise: the import lets the row in");
  const tucson = entity("ahj", "AZ", "City of Tucson");
  assert.deepEqual(ownersOn(tucson, /examplecounty-az/), [], "a spreadsheet sentence counts as the host's owner");
  const fit = hostFitsTrackAndEntity("building", tucson, HOST, "kb");
  assert.notEqual(fit.code, "foreign_entity", `Tucson was refused a host only a sentence claims: ${fit.reason}`);
  assert.equal(fit.fits, true, fit.reason);
  // aae50fab's own text on gosolarapp.org.
  const GOSOLAR = "https://www.gosolarapp.org/";
  assert.equal(imported("AZ", "FIRE PERMIT: 3 kW – 15 kW submit for permit via email NON SOLARAPP+ SUBMITTALS:", GOSOLAR), "imported");
  assert.equal(ownersOn(entity("ahj", "AZ", "City of Tucson"), /gosolarapp/).some((o) => /PERMIT|kW/.test(o)), false, "aae50fab's sentence is counted as an owner of gosolarapp.org");
  // ...and once West Palm Beach's row is gone (the seeded reference row that masks it on production;
  // SEED DATA, NOT THE THING UNDER TEST — removed so the sentence is the only claim left).
  db.run("DELETE FROM permit_utility_knowledge WHERE lower(ahj) LIKE '%west palm beach%' AND portal_url LIKE '%gosolarapp%'");
  const tucsonAgain = entity("ahj", "AZ", "City of Tucson");
  assert.deepEqual(ownersOn(tucsonAgain, /gosolarapp/), [], "aae50fab's sentence owns gosolarapp.org once nothing masks it");
  assert.equal(hostFitsTrackAndEntity("building", tucsonAgain, GOSOLAR, "kb").fits, true);
  // MUST-PASS: real names that carry a note, a comma or a state still own their hosts.
  const TOMBALL = "https://tomballtx.example-permits.com/";
  const SKOKIE = "https://www.bsaonline.com/?uid=skokie";
  assert.equal(imported("TX", "Tomball (emailed for link to portal)", TOMBALL), "imported");
  assert.equal(imported("IL", "Village of Skokie, IL", SKOKIE), "imported");
  const houston = entity("ahj", "TX", "City of Houston");
  assert.deepEqual(ownersOn(houston, /tomballtx/), ["Tomball (emailed for link to portal) (TX)"], "Tomball's note made it no entity");
  assert.equal(hostFitsTrackAndEntity("building", houston, TOMBALL, "kb").code, "foreign_entity", "Tomball's portal is not Tomball's");
  const evanston = entity("ahj", "IL", "City of Evanston");
  assert.deepEqual(ownersOn(evanston, /bsaonline/), ["Village of Skokie, IL (IL)"], "Skokie no longer owns its portal");
  // The shape rules, both ways, on the names themselves.
  for (const junk of ["FIRE PERMIT: 3 kW – 15 kW submit for permit via email NON SOLARAPP+ SUBMITTALS:", "Building Permit: see notes", "10 kW or less", "submittals via email only",
    "applications are accepted by the building division at the front counter only",
    "No permit required unless there is a derate, MPU, battery or demand manager. App"]) {
    assert.equal(recipes.looksLikePortalJunkName(junk), true, `not recognised as junk: ${junk}`);
  }
  for (const real of ["Tomball (emailed for link to portal)", "Village of Skokie, IL", "Days Creek", "City of Dayton", "Generic Oregon ePermitting AHJ",
    "Unified Government of Wyandotte County and Kansas City, Kansas", "Public Utility District No. 1 of Snohomish County", "Town of Mount Pleasant", "Consolidated City of Indianapolis and Marion County",
    "Pacific Gas & Electric", "Portland General Electric", "Commonwealth Edison (ComEd)", "ROSEBURG", "Washington County",
    "Cook County, IL (unincorporated) — Dept. of Building and Zoning", "Kane County, IL (unincorporated) — Development & Community Services",
    "Lake County, IL (unincorporated) — Department of Planning, Building and Development"]) {
    assert.equal(recipes.looksLikePortalJunkName(real), false, `a real name was rejected as junk: ${real}`);
  }
});

// ── end to end: the real prepareSubmission, browser stubbed ──────────────────────────────────
await check("(s1) a Portland recipe that drives Tigard's verified portal is not replayed, and is left untouched", async () => {
  // The fixture's AHJ (Portland) has a complete recipe whose entry is Tigard's EnerGov host.
  const r = recipes.startPortalRecording(db, {
    scopeType: "ahj", state: "OR", ahj: "Portland", utility: "PGE", portalUrl: TIGARD_ENERGOV, portalPlatform: "energov", createdBy: "test",
  });
  const recipe = recipes.savePortalRecipeSteps(db, r.id, [fill(1), fill(2), REVIEW], { status: "complete" });
  let runnerCalls = 0;
  fx.stubRunner(async () => { runnerCalls++; return { ok: true, finalSubmitClicked: false, steps: [] }; });
  const projectId = fx.newProject();
  await repo.prepareSubmission(db, projectId);
  assert.equal(runnerCalls, 0, "the browser must not open on another entity's portal");
  const row = fx.recipeRow(recipe.id);
  assert.equal(row.status, "complete", "the recipe is not demoted or flagged by a resolution refusal");
  assert.equal(Number(row.version), recipe.version);
  const audit = fx.audits("portal.recipe_entity_conflict").find((a) => JSON.parse(a.details).recipeId === recipe.id);
  assert.ok(audit, "the refusal is audited");
  assert.match(String(fx.latestRun(projectId)?.error_message), /Tigard|not the portal a person verified|portal/i);
  // MUST-PASS: the same AHJ with a recipe on a portal that is NOT anyone else's replays.
  const ok = recipes.startPortalRecording(db, {
    scopeType: "ahj", state: "OR", ahj: "Portland", utility: "PGE", portalUrl: "https://devhub.portlandoregon.gov/", createdBy: "test",
  });
  recipes.savePortalRecipeSteps(db, ok.id, [fill(1), fill(2), REVIEW], { status: "complete" });
  const projectB = fx.newProject();
  await repo.prepareSubmission(db, projectB);
  assert.equal(runnerCalls, 1, "Portland's own portal replays");
});

await check("(s2) a permit recipe whose goto leaves for a utility portal is refused at the track gate", async () => {
  const r = recipes.startPortalRecording(db, {
    scopeType: "ahj", state: "OR", ahj: "Portland", utility: "PGE", portalUrl: "https://devhub.portlandoregon.gov/", createdBy: "test",
  });
  const recipe = recipes.savePortalRecipeSteps(db, r.id,
    [{ action: "goto", value: PGE_NM, note: "entry url" } as never, fill(1), fill(2), REVIEW], { status: "complete" });
  let runnerCalls = 0;
  fx.stubRunner(async () => { runnerCalls++; return { ok: true, finalSubmitClicked: false, steps: [] }; });
  const projectId = fx.newProject();
  await repo.prepareSubmission(db, projectId);
  assert.equal(runnerCalls, 0, "a goto to PowerClerk on a permit track must not replay");
  assert.ok(fx.audits("portal.track_host_conflict").some((a) => JSON.parse(a.details).recipeId === recipe.id));
});

// ── resolution skeptic MF3: the status monitor and the correction reopen resolve through the
//    same two-way predicate — nothing opens a browser or fetches the other track's portal ──────
type ScrapeCall = { adapter: string; recipeId: string | null; loginUrl: string | null };
const scrapes: ScrapeCall[] = [];
const fetches: string[] = [];
repo.setStatusCheckSeamsForTests({
  checkStatus: (async (adapter: string, _apps: string[], opts: { recipe?: { id: string }; loginUrl?: string }) => {
    scrapes.push({ adapter, recipeId: opts?.recipe?.id ?? null, loginUrl: opts?.loginUrl ?? null });
    return null; // nothing read — the sweep falls through to the public fetch
  }) as never,
  publicCheck: (async (url: string) => { fetches.push(url); return null; }) as never,
});
const targetFor = (projectId: string, input: { targetType: "permit" | "nem"; portalUrl: string; applicationNumber: string; permitType?: string }) => {
  repo.createPermitCheckTarget(db, projectId, { ...input, jurisdiction: "x", portalName: "x", permitType: input.permitType ?? (input.targetType === "nem" ? "nem" : "building") });
  const row = db.get<{ id: string }>("SELECT id FROM permit_check_targets WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", [projectId])!;
  return row.id;
};
/** One sweep over exactly these targets (every other target retired; time, not the thing under test). */
const sweep = async (...targetIds: string[]) => {
  db.run("UPDATE permit_check_targets SET active = 0");
  for (const t of targetIds) db.run("UPDATE permit_check_targets SET active = 1, next_check_at = NULL WHERE id = ?", [t]);
  scrapes.length = 0; fetches.length = 0;
  await repo.runDuePermitChecks(db, "all");
};
const correctionFor = (projectId: string) => repo.addManualCorrection(db, projectId, "Correction: the application was returned for revision — please resubmit the corrected plan set.", "portal").corrections[0].id;
type ReopenRunner = NonNullable<Parameters<typeof repo.reopenCorrectionOnPortal>[2]>["runner"];
const reopenCalls: Array<{ recipeId: string; portalUrl: string; steps: number }> = [];
const reopenRunner = (async (recipe: { id: string; portalUrl: string; steps: unknown[] }) => {
  reopenCalls.push({ recipeId: recipe.id, portalUrl: recipe.portalUrl, steps: recipe.steps.length });
  return { ok: false, needsHuman: true, message: "stub reopen", offeredForms: [] };
}) as unknown as ReopenRunner;
const conflicts = (action: string, projectId: string) => fx.audits(action).filter((a) => a.project_id === projectId).map((a) => JSON.parse(a.details));

await check("(m3a) MUST-EXCLUDE: a PERMIT target bound to a utility host (production 99ea32c3) is neither scraped nor fetched; MUST-PASS: a Coos Bay permit target on aca-oregon is fetched", async () => {
  const project = fx.newProject({ ahj: "City of Coos Bay", city: "Coos Bay", zip: "97420" });
  // LEGACY DATA, NOT THE THING UNDER TEST: createPermitCheckTarget refuses a utility URL on a permit
  // target at the door today; production row 99ea32c3 predates that door, so it is inserted as held.
  const past = new Date(Date.now() - 86_400_000).toISOString();
  db.run(
    `INSERT INTO permit_check_targets (id, project_id, jurisdiction, portal_name, portal_url, application_number, permit_number, check_frequency_days, active, last_checked_at, next_check_at, latest_outcome, latest_status_label, notes, target_type, permit_type, portal_platform, tracking_url, created_at, updated_at)
     VALUES ('tgt-99ea32c3', ?, 'City of Coos Bay', 'PowerClerk', ?, 'APP-111667', '', 7, 1, NULL, ?, NULL, '', '', 'permit', 'building', 'powerclerk', '', ?, ?)`,
    [project, PACIFICORP_NM, past, past, past],
  );
  await sweep("tgt-99ea32c3");
  assert.deepEqual(fetches, [], `the permit target's utility URL was fetched: ${JSON.stringify(fetches)}`);
  assert.deepEqual(scrapes.filter((c) => c.loginUrl && /powerclerk/.test(c.loginUrl)), [], "the legacy adapter was pointed at the utility URL");
  assert.ok(conflicts("portal.track_host_conflict", project).some((d) => d.targetId === "tgt-99ea32c3"), "the conflict was not audited");
  // MUST-PASS: the same AHJ's permit target on its permit portal is fetched.
  const ok = fx.newProject({ ahj: "City of Coos Bay", city: "Coos Bay", zip: "97420" });
  const t = targetFor(ok, { targetType: "permit", portalUrl: ACA_OREGON, applicationNumber: "187-26-000305-STR" });
  await sweep(t);
  assert.ok(fetches.length >= 1 && fetches.every((u) => u === ACA_OREGON), `the Coos Bay permit target was not fetched (the sweep and the status resolver each fetch once): ${JSON.stringify(fetches)}`);
});

await check("(m3b) MUST-EXCLUDE: a permit target whose AHJ recipe drives a utility host is not handed to the scraper; MUST-PASS: a Pacific Power NEM target scrapes with the utility recipe (discipline '')", async () => {
  // A legacy '' discipline AHJ recipe for Portland that drives PowerClerk (the poisoned shape).
  const bad = recipes.startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj: "Portland", utility: "PGE", portalUrl: PGE_NM, createdBy: "test" });
  recipes.savePortalRecipeSteps(db, bad.id, [fill(1), fill(2), REVIEW], { status: "complete" });
  const project = fx.newProject(); // Portland / PGE
  const t = targetFor(project, { targetType: "permit", portalUrl: "", applicationNumber: "187-26-000999-STR" });
  await sweep(t);
  assert.deepEqual(scrapes.filter((c) => c.recipeId === bad.id), [], "the poisoned AHJ recipe was handed to checkStatusWithAdapter");
  assert.ok(conflicts("portal.track_host_conflict", project).some((d) => d.recipeId === bad.id && d.targetId === t), "the recipe conflict was not audited");
  // MUST-PASS: the utility recipe (discipline '') reaches the scraper for a NEM target.
  const pac = utilityRecipe("OR", "Pacific Power", PACIFICORP_NM);
  const nemProject = fx.newProject({ utility: "Pacific Power" });
  const nt = targetFor(nemProject, { targetType: "nem", portalUrl: PACIFICORP_NM, applicationNumber: "APP-222" });
  await sweep(nt);
  assert.ok(scrapes.some((c) => c.adapter === "recipe" && c.recipeId === pac.id), `the utility recipe was not scraped: ${JSON.stringify(scrapes)}`);
});

await check("(m3c) MUST-EXCLUDE: a NEM target / reopen bound to an AHJ permit platform (aca-oregon) stops before any browser, audited portal.track_host_conflict", async () => {
  const project = fx.newProject({ utility: "Pacific Power" });
  // The door does not guard this direction (createPermitCheckTarget: "the reverse is not guarded").
  const t = targetFor(project, { targetType: "nem", portalUrl: ACA_OREGON, applicationNumber: "APP-333" });
  await sweep(t);
  assert.deepEqual(fetches, [], `the NEM target's permit-platform URL was fetched: ${JSON.stringify(fetches)}`);
  assert.deepEqual(scrapes.filter((c) => c.loginUrl && /accela/.test(c.loginUrl)), []);
  assert.ok(conflicts("portal.track_host_conflict", project).some((d) => d.targetId === t), "the sweep's conflict was not audited");
  reopenCalls.length = 0;
  const result = await repo.reopenCorrectionOnPortal(db, correctionFor(project), { targetId: t, runner: reopenRunner });
  assert.equal(reopenCalls.length, 0, "the reopen opened a browser on the permit platform for a NEM filing");
  assert.equal(result.needsHuman, true);
  assert.match(result.message, /AHJ permit portal/);
  assert.ok(fx.audits("portal.track_host_conflict").filter((a) => a.project_id === project).some((a) => a.actor_name === "correction reopen"), "the reopen's conflict was not audited");
});

await check("(m3d) MUST-EXCLUDE: a reopen never replays a recipe whose host fit is platform_conflict / foreign_entity; MUST-PASS: the Pacific Power NEM reopen replays the utility recipe", async () => {
  // Tigard: a person verified EnerGov; a '' discipline Tigard recipe on aca-oregon is a platform conflict.
  kb.saveVerifiedAhjProfile(db, { state: "OR", ahj: "City of Tigard", portalUrl: TIGARD_ENERGOV, portalPlatform: "energov", verifiedBy: "test" });
  const stale = recipes.startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj: "City of Tigard", utility: "PGE", portalUrl: ACA_OREGON, createdBy: "test" });
  recipes.savePortalRecipeSteps(db, stale.id, [fill(1), fill(2), REVIEW], { status: "complete" });
  const tigard = fx.newProject({ ahj: "City of Tigard", city: "Tigard", zip: "97223" });
  const t = targetFor(tigard, { targetType: "permit", portalUrl: TIGARD_ENERGOV, applicationNumber: "BLD-2026-0101" });
  reopenCalls.length = 0;
  await repo.reopenCorrectionOnPortal(db, correctionFor(tigard), { targetId: t, runner: reopenRunner });
  assert.equal(reopenCalls.length, 1, "the reopen on Tigard's own verified portal did not run");
  assert.notEqual(reopenCalls[0].recipeId, stale.id, "the reopen replayed the recipe that drives aca-oregon against Tigard's verified EnerGov portal");
  assert.equal(reopenCalls[0].steps, 0, "steps of a misfit recipe were replayed");
  assert.equal(reopenCalls[0].portalUrl, TIGARD_ENERGOV);
  assert.ok(conflicts("portal.entity_host_conflict", tigard).some((d) => d.recipeId === stale.id && d.code === "platform_conflict"), "the recipe misfit was not audited");
  // MUST-PASS: the utility recipe reopens the NEM filing.
  const pac = recipes.findCompleteRecipeForProject(db, { scopeType: "utility", state: "OR", utility: "Pacific Power" })!;
  assert.ok(pac, "setup: the Pacific Power recipe from (m3b) is missing");
  const nemProject = fx.newProject({ utility: "Pacific Power" });
  const nt = targetFor(nemProject, { targetType: "nem", portalUrl: PACIFICORP_NM, applicationNumber: "APP-444" });
  reopenCalls.length = 0;
  await repo.reopenCorrectionOnPortal(db, correctionFor(nemProject), { targetId: nt, runner: reopenRunner });
  assert.deepEqual(reopenCalls.map((c) => c.recipeId), [pac.id], `the NEM reopen did not replay the utility recipe: ${JSON.stringify(reopenCalls)}`);
});

// ── close MF3e: the FETCH-TIME track gate in resolveStatusText ───────────────────────────────
// (m3a) goes through the sweep, whose own gate stops the target first — so it cannot see the gate
// at the fetch. A permit check recorded directly (POST /api/projects/:id/permit-checks with
// source 'public_url' and no status text → recordPermitStatusCheck) reaches resolveStatusText
// with nothing in front of it.
// KILL: resolveStatusText's `fetchUrl = text(target.portal_url)` → the utility host is fetched.
await check("(m3e) MUST-EXCLUDE: recordPermitStatusCheck {targetId: a permit target bound to pacificorpnetmetering.powerclerk.com, source:'public_url'} never calls the public fetch; MUST-PASS: a permit target on aca-oregon is fetched", async () => {
  const project = fx.newProject({ ahj: "City of Coos Bay", city: "Coos Bay", zip: "97420" });
  // LEGACY DATA, NOT THE THING UNDER TEST: the door (createPermitCheckTarget) refuses a utility URL
  // on a permit target today; production 99ea32c3 predates it, so the row is inserted as held.
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO permit_check_targets (id, project_id, jurisdiction, portal_name, portal_url, application_number, permit_number, check_frequency_days, active, last_checked_at, next_check_at, latest_outcome, latest_status_label, notes, target_type, permit_type, portal_platform, tracking_url, created_at, updated_at)
     VALUES ('tgt-mf3e-legacy', ?, 'City of Coos Bay', 'PowerClerk', ?, 'APP-111667', '', 7, 1, NULL, NULL, NULL, '', '', 'permit', 'building', 'powerclerk', '', ?, ?)`,
    [project, PACIFICORP_NM, now, now],
  );
  fetches.length = 0;
  await repo.recordPermitStatusCheck(db, project, { targetId: "tgt-mf3e-legacy", source: "public_url" });
  assert.deepEqual(fetches, [], `a PERMIT status check fetched the utility portal: ${JSON.stringify(fetches)}`);
  // MUST-PASS: a permit target on the AHJ's permit portal is fetched by the same call.
  const ok = fx.newProject({ ahj: "City of Coos Bay", city: "Coos Bay", zip: "97420" });
  const t = targetFor(ok, { targetType: "permit", portalUrl: ACA_OREGON, applicationNumber: "187-26-000306-STR" });
  fetches.length = 0;
  await repo.recordPermitStatusCheck(db, ok, { targetId: t, source: "public_url" });
  assert.deepEqual(fetches, [ACA_OREGON], `the aca-oregon permit target was not fetched: ${JSON.stringify(fetches)}`);
});

repo.setStatusCheckSeamsForTests(null);
finish("portal-host-fit");
