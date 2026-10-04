// ISSUE #86 — a STATE AGENCY'S LANDING PAGE was not an information page. New Mexico CID's own page
// (www.rld.nm.gov/construction-industries/, also STATE_PERMIT_RULES.NM.stateTradeIssuer's sourceUrl)
// matched no help/guide/library segment and no document extension, so
// hostFitsTrackAndEntity("building", null, thatUrl, "research").fits was TRUE: a per-job process
// lookup that cited it as portalUrl had only attestation and the quote's "apply online" words left
// between it and a launch. CID's real apply links are on nmrld.my.site.com (owner's evidence, #60).
//
// Pins (rule 5's information-page clause — an information page is never a portal on either track;
// the ONE predicate, hostFitsTrackAndEntity → isInformationalPageUrl):
//   (x)  MUST-EXCLUDE: a STATE agency's landing / content page — a <st>.gov / <state>.gov /
//        state.<st>.us host whose host and path name no application, login, portal or account and
//        carry no query or app route — is an information page, and fits NEITHER track
//        (not_a_portal). CID's landing page, its forms and fees pages, other state divisions' pages;
//   (u)  MUST-EXCLUDE (unchanged, #31): PNM's program page never fits the permit track, and never
//        fits the NEM track beside a named PowerClerk;
//   (p)  MUST-PASS: every application portal stays a portal — a PowerClerk login, an Accela
//        aca-prod tenant, an EnerGov citizen self-service URL, nmrld.my.site.com/MHD/s, and the
//        government-hosted portals this codebase already knows (aca.oregon.gov/CitizenAccess,
//        portal.columbus.gov's Cap pages, apps.<city>.gov/citizen, energovweb.<city>.gov,
//        a bare portal host, a /login page);
//   (n)  never widens what counts as a portal: no URL that was informational before is a portal now;
//        a city's / county's own .gov page and a commercial page are judged exactly as before.
// Synthetic URLs except the public agency / platform URLs the issue names. No network.
//
// KILL TEST (run red by hand before the fix):
//   K1 drop the agency-landing-page rule from isInformationalPageUrl → (x1), (x2) fail.
//
// Run: npx tsx backend/test/portalChannelAgencyLandingPage.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";

const chan = await import("../src/portalChannel");
const { isInformationalPageUrl, hostFitsTrackAndEntity } = chan;

let failed = 0;
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok   - ${label}`);
  } catch (err) {
    failed++;
    console.log(`FAIL - ${label}\n       ${(err as Error).message}`);
  }
}

const CID_LANDING = "https://www.rld.nm.gov/construction-industries/";
const AGENCY_PAGES = [
  CID_LANDING,
  "https://www.rld.nm.gov/construction-industries",
  "https://rld.nm.gov/construction-industries/",
  "https://www.rld.nm.gov/construction-industries/forms/",
  "https://www.rld.nm.gov/construction-industries/construction-industries-forms/",
  "https://www.rld.nm.gov/construction-industries/fees/",
  "https://www.rld.nm.gov/manufactured-housing/",
  "https://www.oregon.gov/BCD",
  "https://www.texas.gov/business/licenses-permits.html",
  "https://www.dli.mn.gov/business/electrical-contractors",
  "https://www.bcd.state.or.us/building",
];
// A city's / county's own .gov site is NOT this rule: it can host its own permit system or a
// municipal utility's interconnection page at a plain path (MUST-PASS pins in perJobPermitProcess
// and portalHostFit), so a local host is judged exactly as before.
const LOCAL_GOV_PAGES = [
  "https://www.cityofexample.gov/building/permits",
  "https://utilities.cityofexample.gov/solar-interconnection",
  "https://loslunasnm.gov/995/Building-Permits",
  "https://www.ci.example-town.or.us/building",
];
const PNM_PROGRAM = "https://www.pnm.com/customer-solar-program1";

const POWERCLERK_LOGIN = "https://pnminterconnect.powerclerk.com/MvcAccount/Login";
const ACCELA_ACA_PROD = "https://aca-prod.accela.com/ABQ/Default.aspx";
const ENERGOV_CSS = "https://albuquerquenm-energovweb.tylerhost.net/apps/SelfService#/home";
const NMRLD_MHD = "https://nmrld.my.site.com/MHD/s";
const PERMIT_PORTALS = [
  ACCELA_ACA_PROD,
  ENERGOV_CSS,
  NMRLD_MHD,
  "https://nmrld.my.site.com/s/electrical-permits",
  "https://aca.oregon.gov/CitizenAccess/",
  "https://portal.columbus.gov/Permits/Cap/CapHome.aspx?module=Building",
  "https://portal.columbus.gov/permits/Dashboard.aspx",
  "https://apps.lakestevenswa.gov/citizen/Home/LIVE/PERMIT",
  "https://energovweb.capecoral.gov/energovprod/selfservice#/home",
  "https://devhub.portlandoregon.gov/",
  "https://permits.example.gov/login",
  "https://www.example.gov/account/login",
  "https://www.example-city.gov/apply",
  "https://www.example-city.gov/building/permit-portal",
  "https://www.example-city.gov/CitizenAccess/",
  "https://www.example-city.gov/eservices/permits",
  "https://www.example-city.gov/building/solar?tab=apply",
  "https://epermits.example-city.gov/residential-solar",
  // a state's own application paths stay portals
  "https://www.rld.nm.gov/construction-industries/apply-online",
  "https://www.oregon.gov/bcd/epermitting/app/",
  "https://secure.sos.state.or.us/oard/view.action?ruleNumber=918-050-0180",
];

await check("(x1) MUST-EXCLUDE: a STATE agency's landing / content page is an information page (CID's landing page first)", () => {
  for (const u of AGENCY_PAGES) assert.equal(isInformationalPageUrl(u), true, u);
});
await check("(x2) MUST-EXCLUDE: the issue's repro — CID's landing page fits NEITHER track, from any source (not_a_portal)", () => {
  for (const u of AGENCY_PAGES) {
    for (const track of ["building", "electrical", "nem"]) {
      for (const source of ["research", "kb", "statewide"] as const) {
        const fit = hostFitsTrackAndEntity(track, null, u, source);
        assert.equal(fit.fits, false, `${track}/${source}: ${u}`);
        assert.equal(fit.code, "not_a_portal", `${track}/${source}: ${u} → ${fit.code}`);
      }
    }
  }
});
await check("(u1) MUST-EXCLUDE (unchanged, #31): PNM's program page never fits the permit track, nor the NEM track beside a named PowerClerk", () => {
  assert.equal(hostFitsTrackAndEntity("building", null, PNM_PROGRAM, "research").fits, false);
  const nem = hostFitsTrackAndEntity("nem", null, PNM_PROGRAM, "research", { namedPlatform: "PowerClerk" });
  assert.equal(nem.fits, false);
  assert.equal(nem.code, "platform_unconfirmed");
});
await check("(p1) MUST-PASS: a PowerClerk login is a portal, and fits the NEM track (named or not) but never a permit track", () => {
  assert.equal(isInformationalPageUrl(POWERCLERK_LOGIN), false);
  assert.equal(hostFitsTrackAndEntity("nem", null, POWERCLERK_LOGIN, "research").fits, true);
  assert.equal(hostFitsTrackAndEntity("nem", null, POWERCLERK_LOGIN, "research", { namedPlatform: "PowerClerk" }).fits, true);
  assert.equal(hostFitsTrackAndEntity("building", null, POWERCLERK_LOGIN, "research").code, "track_conflict");
});
await check("(p2) MUST-PASS: Accela aca-prod, EnerGov self-service, nmrld.my.site.com/MHD/s and the government-hosted portals stay portals and fit the permit track", () => {
  for (const u of PERMIT_PORTALS) {
    assert.equal(isInformationalPageUrl(u), false, u);
    const fit = hostFitsTrackAndEntity("building", null, u, "research");
    assert.equal(fit.fits, true, `${u} → ${fit.code}: ${fit.reason}`);
  }
});
await check("(n1) never widens a portal: help pages, documents and SharePoint pages on .gov hosts are still information pages; a bare host is still not one", () => {
  for (const u of [
    "https://www.oregon.gov/bcd/epermitting/help/records/pages/permit-for-solar.aspx",
    "https://www.oregon.gov/bcd/codes-stand/pages/electrical.aspx",
    "https://www.rld.nm.gov/wp-content/uploads/2021/01/permit-application.pdf",
  ]) assert.equal(isInformationalPageUrl(u), true, u);
  for (const u of ["https://www.rld.nm.gov/", "https://rld.nm.gov", "https://www.example-city.gov/"]) assert.equal(isInformationalPageUrl(u), false, u);
});
await check("(n2) the rule is the STATE agency's own site only: a local government page or a commercial page with the same shape is judged as before", () => {
  for (const u of LOCAL_GOV_PAGES) assert.equal(isInformationalPageUrl(u), false, u);
  // Not a government host → not this rule (PNM's page stays the #31 named-platform case).
  assert.equal(isInformationalPageUrl(PNM_PROGRAM), false);
  assert.equal(isInformationalPageUrl("https://www.example-installer.test/construction-industries/"), false);
  // A plain ".us" domain is not government: a utility's own interconnection site there is untouched.
  assert.equal(isInformationalPageUrl("https://interconnect.example-coop.us/solar-start"), false);
  assert.equal(hostFitsTrackAndEntity("nem", null, "https://interconnect.example-coop.us/solar-start", "research").fits, true);
});

if (failed) {
  console.log(`\n${failed} check(s) FAILED — agency landing page (#86)`);
  process.exit(1);
}
console.log("\nagency landing page is an information page (#86): all checks passed");
