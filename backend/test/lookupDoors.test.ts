// THE THREE DOORS OF THE PER-JOB LOOKUP, EACH ONE FUNCTION (lookup-close-4, 2026-09-26). Four
// patch rounds closed one path at a time and each skeptic found the sibling path without the
// guard. Now:
//   D1 acceptPortalForPermit — ONE portal door at the ONE place a permit's portalUrl is assigned
//      (finalPortal), whatever the source: rule 5, attestation, the ISSUER's jurisdiction type, and
//      the source named in the saved notes.
//   D2 salesforceTenantKind / hostFitsTrackAndEntity — a Salesforce site fits the permit track only
//      on the government allowlist or a human-VERIFIED KB row (no word scoring).
//   D3 feeLinePrintedTogether — a (label, amount) pair is printed together on one line, label-first
//      and amount-first alike; the total is a tied amount or the sum of tied lines.
//   F-b NOT ASKED is not NOT FOUND — an aborted part leaves "not asked", and the row is re-asked.
// MUST-PASS / MUST-EXCLUDE lists carry every shape from every prior probe (lookup-recall-2-v,
// lookup-close-2-v, lookup-close-3-v probes 1-3). Kills: .probe/lookup-close-4/kill.cjs.
//
// Run: npx tsx backend/test/lookupDoors.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO } from "./_isolate";
import type { WebLookupResult } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doors-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

const db = await (await import("../src/db")).openDatabase();
const reader = await import("../src/agencyPageReader");
const cat = await import("../src/permitPlatformCatalog");
const ppl = await import("../src/permitProcessLookup");
const pp = await import("../src/permitProcess");
const channel = await import("../src/portalChannel");
const kb = await import("../src/knowledgeBase");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};
const FIX = path.join(REPO, "backend", "test", "fixtures", "agency-pages");
const fixture = (f: string) => fs.readFileSync(path.join(FIX, f), "utf8");
const g = (text: string, urls: string[], over: Partial<WebLookupResult> = {}): WebLookupResult => ({ text, groundedSearches: 3, searches: 3, stopReason: "end_turn", resultUrls: urls, pagesRead: 0, ...over });
type Served = { status?: number; contentType?: string; text?: string; finalUrl?: string };
function site(pages: Record<string, Served>) {
  const fetch: import("../src/agencyPageReader").RawFetch = async (url) => {
    const s = pages[url] ?? pages[url.replace(/#.*$/, "")];
    if (!s) return { ok: false, status: 404, contentType: "text/html", finalUrl: url, reason: "HTTP 404" };
    const status = s.status ?? 200; const ok = status >= 200 && status < 300;
    return { ok, status, contentType: s.contentType ?? "text/html", text: s.text ?? "", bytes: new TextEncoder().encode(s.text ?? ""), finalUrl: s.finalUrl ?? url, reason: ok ? `HTTP ${status}` : `HTTP ${status} — refused` };
  };
  return { fetch };
}
const newReader = (fetch: import("../src/agencyPageReader").RawFetch) => { reader._resetPoliteness(); return reader.createPageReader({ fetch, minGapMs: 0, maxReads: 20 }); };
const html = (body: string, title = "Building") => `<html><head><title>${title}</title></head><body><main>${body}</main></body></html>`;
const P = (run: { lookup: { permits: Array<{ discipline: string }> } | null }, d: string) => run.lookup!.permits.find((p) => p.discipline === d)! as never as { portalUrl: { value: string | null; notFound?: string }; fee: { value: unknown; notFound?: string }; documents: { value: unknown; notFound?: string } };

// The B1 process shape: a city that issues building (paper) while the county issues electrical.
const shapeFor = (city: string, PG: string, top: string | null, structural: string, electrical: string) => JSON.stringify({
  issuingAgency: top ? { value: top, sourceUrl: PG, quote: `${top} issues building permits for properties inside city limits.` } : { value: null },
  permitStructure: { value: "separate", sourceUrl: PG, quote: `Electrical permits are issued by ${electrical}.` },
  permits: [
    { discipline: "structural", label: "Building", issuingAgency: { value: structural, sourceUrl: PG, quote: `${structural} issues building permits for properties inside city limits.` }, portalUrl: { value: null }, recordType: { value: null } },
    { discipline: "electrical", label: "Electrical", issuingAgency: { value: electrical, sourceUrl: PG, quote: `Electrical permits are issued by ${electrical}.` }, portalUrl: { value: null }, recordType: { value: null } },
  ],
});
const runCity = async (name: string, state: string, p1: string, PG: string, pageHtml: string | null, portalAnswer?: { text: string; urls: string[] }) => {
  const llm = { webLookup: async (i: { label: string }) => (i.label.endsWith(".process") ? g(p1, [PG]) : (portalAnswer && i.label.includes("portal")) ? g(portalAnswer.text, portalAnswer.urls) : g(JSON.stringify({ permits: [] }), [])) };
  return ppl.runPermitProcessLookup(db, llm, { state, ahj: name, dcKw: "7", acKw: "6", force: true, reader: pageHtml == null ? null : newReader(site({ [PG]: { text: pageHtml } }).fetch) });
};

console.log("lookup doors: D1 portal, D2 Salesforce, D3 fee tie, F-b not asked");

// ───────────────────────────── D1 — the one portal door ─────────────────────────────
await check("(d1) MUST-EXCLUDE (close-3-v MF2: M5 / M5b): a same-named other-type tenant cited for the AHJ's OWN permit is refused whoever cites it — the PORTAL STEP (grounded search returned CORWINCOUNTY) and the PROCESS PART (DENBYCOUNTY, no reader) — with the refusal named in the notes; MUST-PASS (M6): the city's own tenant cited by the portal step", async () => {
  const PG = "https://www.cityofcorwin.org/building";
  const ACA_CO = "https://aca-prod.accela.com/CORWINCOUNTY/Default.aspx";
  const portal = { text: JSON.stringify({ permits: [{ discipline: "structural", portalUrl: { value: ACA_CO, sourceUrl: ACA_CO, quote: "Corwin County Online Permits — Building Permit" }, recordType: { value: null } }] }), urls: [ACA_CO] };
  const m5 = await runCity("City of Corwin", "IN", shapeFor("Corwin", PG, "City of Corwin", "City of Corwin", "Corwin County"), PG,
    html(`<p>Building permits for properties inside city limits are issued at City Hall on paper. Electrical permits are issued by Corwin County.</p><p><a href="${ACA_CO}">Corwin County Online Permits</a></p>`), portal);
  assert.equal(P(m5, "structural").portalUrl.value, null, `M5: ${P(m5, "structural").portalUrl.value}`);
  assert.match(String(P(m5, "structural").portalUrl.notFound), /another jurisdiction's portal/);
  assert.ok((m5.lookup!.notes ?? []).some((n) => /^Portal refused \(structural\): .*CORWINCOUNTY.*portal step/.test(n)), JSON.stringify(m5.lookup!.notes));
  const PG2 = "https://www.cityofdenby.org/building";
  const DENBY = "https://aca-prod.accela.com/DENBYCOUNTY/Default.aspx";
  const p1 = JSON.parse(shapeFor("Denby", PG2, "City of Denby", "City of Denby", "Denby County"));
  p1.permits[0].portalUrl = { value: DENBY, sourceUrl: PG2, quote: "Denby County Online Permits" };
  const llm = { webLookup: async (i: { label: string }) => (i.label.endsWith(".process") ? g(JSON.stringify(p1), [PG2, DENBY]) : g(JSON.stringify({ permits: [] }), [])) };
  const m5b = await ppl.runPermitProcessLookup(db, llm, { state: "IN", ahj: "City of Denby", dcKw: "7", acKw: "6", force: true, reader: null });
  assert.equal(P(m5b, "structural").portalUrl.value, null, `M5b: ${P(m5b, "structural").portalUrl.value}`);
  assert.ok((m5b.lookup!.notes ?? []).some((n) => /^Portal refused \(structural\): .*DENBYCOUNTY.*process part/.test(n)), JSON.stringify(m5b.lookup!.notes));
  // M6 MUST-PASS: the city's own tenant.
  const PG3 = "https://www.cityofelston.org/building";
  const ACA = "https://aca-prod.accela.com/CITYOFELSTON/Default.aspx";
  const own = { text: JSON.stringify({ permits: [{ discipline: "structural", portalUrl: { value: ACA, sourceUrl: ACA, quote: "City of Elston Online Permits — Building Permit" }, recordType: { value: null } }] }), urls: [ACA] };
  const m6 = await runCity("City of Elston", "IN", shapeFor("Elston", PG3, "City of Elston", "City of Elston", "Elston County"), PG3, html(`<p>Building permits are issued at City Hall. Electrical permits are issued by Elston County.</p>`), own);
  assert.equal(P(m6, "structural").portalUrl.value, ACA);
  assert.ok((m6.lookup!.notes ?? []).some((n) => /^Portal \(structural\): .*CITYOFELSTON.* — from the portal step; attested by its tenant on the shared host .*; jurisdiction type judged against City of Elston$/.test(n)), JSON.stringify(m6.lookup!.notes));
});

await check("(d2) the issuer decides the type set: a permit ANOTHER cited agency issues may take THAT agency's portal (the county's tenant on the county-issued electrical permit) and never the AHJ's own-type tenant; with the county lifted (Jefferson) both permits take the county's tenant; an own-DOMAIN label contradicts like a tenant (permits.marioncounty.gov for the city); Madison's own-host ACA (elam.cityofmadison.com) and Fairfax PLUS pass", async () => {
  const seen = ["https://www.cityofmarion.org/building"];
  const door = (url: string, quote: string, typeNames: string[], names = typeNames) => ppl.acceptPortalForPermit({ value: url, sourceUrl: seen[0], quote }, "portal step", { seenUrls: [...seen, url], names, typeNames });
  const CO = "https://aca-prod.accela.com/MARIONCOUNTY/Default.aspx";
  assert.equal(door(CO, "Marion County Online Permits", ["City of Marion"], ["City of Marion", "Marion County"]).fact.value, null, "the city's own permit: refused");
  assert.equal(door(CO, "Marion County Online Permits", ["Marion County"], ["City of Marion", "Marion County"]).fact.value, CO, "the county-issued permit: the county's tenant");
  assert.equal(door("https://aca-prod.accela.com/CITYOFMARION/Default.aspx", "City of Marion Online Permits", ["Marion County"], ["City of Marion", "Marion County"]).fact.value, null, "the county-issued permit never takes the city's tenant");
  assert.equal(door(CO, "Marion County Online Permits", ["City of Jefferson", "Marion County"]).fact.value, CO, "the Jefferson lift: the issuing county in the type set");
  assert.equal(door("https://permits.marioncounty.gov/apply", "Apply online at permits.marioncounty.gov", ["City of Marion"]).fact.value, null, "an own-domain label contradicts like a tenant");
  assert.equal(door("https://aca-prod.accela.com/MARIONCOUNTY/Default.aspx", "Apply online — City of Hampton permits", ["City of Marion"]).fact.value, null, "the quote's words name another jurisdiction");
  const madison = "https://elam.cityofmadison.com/CitizenAccess/Cap/CapHome.aspx?module=Permitting&TabName=Home";
  assert.equal(ppl.acceptPortalForPermit({ value: madison, sourceUrl: madison, quote: "Citizen Access — City of Madison Licenses and permits portal" }, "portal step", { seenUrls: [madison], names: ["City of Madison"], typeNames: ["City of Madison"] }).fact.value, madison, "Madison");
  const plus = "https://plus.fairfaxcounty.gov/CitizenAccess/Welcome.aspx";
  assert.equal(ppl.acceptPortalForPermit({ value: plus, sourceUrl: "https://www.fairfaxcounty.gov/landdevelopment/permits", quote: `Apply online in PLUS (${plus})` }, "process part", { seenUrls: ["https://www.fairfaxcounty.gov/landdevelopment/permits"], names: ["Fairfax County"], typeNames: ["Fairfax County"] }).fact.value, plus, "Fairfax PLUS (own-domain link)");
  // Every prior MUST-PASS tenant against its own AHJ through the door: no type contradiction.
  for (const [name, url] of [
    ["City of Scottsdale", "https://cityofscottsdaleaz-energovweb.tylerhost.net/apps/selfservice#/home"], ["Lee County", "https://aca-prod.accela.com/LEECO/Default.aspx"],
    ["City of Carlsbad", "https://www.carlsbadca.gov/services/departments/community-development/building-permits/customer-self-service"], ["Iowa City", "https://aca-prod.accela.com/IOWACITY/Default.aspx"],
    ["City of Columbus", "https://portal.columbus.gov/Permits/Welcome.aspx"], ["City of Bemidji", "https://ci-bemidji-mn.smartgovcommunity.com/Public/Home"],
    ["City of Georgetown", "https://georgetowntx-energovweb.tylerhost.net/apps/selfservice"], ["Town of Hillsborough", "https://aca-prod.accela.com/HILLSBOROUGH/Default.aspx"],
  ] as Array<[string, string]>) {
    const r = ppl.acceptPortalForPermit({ value: url, sourceUrl: url, quote: `${name} online permit portal` }, "portal step", { seenUrls: [url], names: [name], typeNames: [name] });
    assert.equal(r.fact.value, url, `${name}: ${r.fact.notFound}`);
  }
});

await check("(d3) the door's other three questions on every source: rule 5 (a PowerClerk / Salesforce utility tenant / help page from the page-read source is refused too), attestation (a page WE read linking the URL attests it — the resolver's kind — while an agency page's 'apply online' quote does not), and the source named", async () => {
  const PG = "https://www.exampleville.gov/building";
  const ctx = (agencyLinks: Array<{ page: string; href: string }> = [], seenUrls = [PG]) => ({ seenUrls, agencyLinks, names: ["City of Exampleville"], typeNames: ["City of Exampleville"] });
  const words = "Apply online through the portal";
  assert.match(String(ppl.acceptPortalForPermit({ value: "https://pacificpower.powerclerk.com/MvcAccount/Login", sourceUrl: PG, quote: words }, "agency page (our read)", ctx([{ page: PG, href: "https://pacificpower.powerclerk.com/MvcAccount/Login" }])).fact.notFound), /utility interconnection portal/);
  assert.match(String(ppl.acceptPortalForPermit({ value: "https://entergy.my.site.com/s/", sourceUrl: PG, quote: words }, "agency page (our read)", ctx([{ page: PG, href: "https://entergy.my.site.com/s/" }])).fact.notFound), /rule 5 fails closed/);
  assert.match(String(ppl.acceptPortalForPermit({ value: "https://www.oregon.gov/bcd/epermitting/help/records/pages/permit-for-solar.aspx", sourceUrl: PG, quote: words }, "agency page (our read)", ctx([{ page: PG, href: "https://www.oregon.gov/bcd/epermitting/help/records/pages/permit-for-solar.aspx" }])).fact.notFound), /information page/);
  const madeUp = "https://aca-prod.accela.com/EXAMPLEVILLE/Default.aspx";
  const quoteOnly = ppl.acceptPortalForPermit({ value: madeUp, sourceUrl: PG, quote: `Apply online (${madeUp})` }, "process part", ctx());
  assert.equal(quoteOnly.fact.value, null); assert.match(String(quoteOnly.fact.notFound), /never returned by the search, opened by the lookup, or linked by a page we read/);
  const linked = ppl.acceptPortalForPermit({ value: madeUp, sourceUrl: PG, quote: `Apply online (${madeUp})` }, "process part", ctx([{ page: PG, href: madeUp }]));
  assert.equal(linked.fact.value, madeUp); assert.match(String(linked.attestedBy), /a page we read links it/);
  assert.equal(ppl.acceptPortalForPermit({ value: madeUp, sourceUrl: PG, quote: words }, "portal step", ctx([], [PG, "https://aca-prod.accela.com/exampleville/Cap/CapHome.aspx"])).attestedBy, "its tenant on the shared host was a search result / a page opened or read");
  assert.equal(ppl.acceptPortalForPermit({ value: madeUp, sourceUrl: PG, quote: words }, "portal step", ctx([], [PG, "https://aca-prod.accela.com/OTHER/Default.aspx"])).fact.value, null, "another tenant on the shared host attests nothing");
  // V8b through the door (close-2): a model-cited deep link into the tenant's Licenses module is not the permit portal; the Building / Permitting module is.
  const licences = "https://aca-prod.accela.com/EXAMPLEVILLE/Cap/CapHome.aspx?module=Licenses";
  const v8 = ppl.acceptPortalForPermit({ value: licences, sourceUrl: PG, quote: words }, "portal step", ctx([], [PG, licences]));
  assert.equal(v8.fact.value, null, "V8b: a Licenses-module deep link");
  assert.match(String(v8.fact.notFound), /another module/);
  for (const m of ["Building", "Permitting"]) {
    const u = `https://aca-prod.accela.com/EXAMPLEVILLE/Cap/CapHome.aspx?module=${m}&TabName=Home`;
    assert.equal(ppl.acceptPortalForPermit({ value: u, sourceUrl: PG, quote: words }, "portal step", ctx([], [PG, u])).fact.value, u, `the ${m} module is the portal`);
  }
  assert.equal(cat.linksAnotherModule(licences), true);
  assert.equal(cat.linksAnotherModule("https://elam.cityofmadison.com/CitizenAccess/Cap/CapHome.aspx?module=Permitting&TabName=Home"), false, "Madison's Permitting module");
});

// ───────────────────────────── D2 — Salesforce, through the real lookup ─────────────────────────────
await check("(s1) MUST-EXCLUDE: a Salesforce tenant off the allowlist (cityofsantafe) cited by the portal step for the city's permit is refused with the fail-closed rule named — with no KB row, with a SEEDED row naming it (the KB seam strips it), and with a person's verified row naming a DIFFERENT portal (rule 3: the verified portal outranks the researched one, through the real writer); MUST-PASS: a verified row naming that host and tenant opens it and the note names the record — SETUP BY RAW SQL, because knowledgeBase's write seam cannot yet store a human-verified Salesforce URL on an AHJ row (open issue)", async () => {
  const PG = "https://www.santafenm.gov/building";
  const SF = "https://cityofsantafe.my.site.com/s/permits";
  const portal = { text: JSON.stringify({ permits: [{ discipline: "structural", portalUrl: { value: SF, sourceUrl: SF, quote: "City of Santa Fe Permits portal — apply online" }, recordType: { value: null } }] }), urls: [SF] };
  const p1 = shapeFor("Santa Fe", PG, "City of Santa Fe", "City of Santa Fe", "City of Santa Fe");
  const before = await runCity("City of Santa Fe", "NM", p1, PG, null, portal);
  assert.equal(P(before, "structural").portalUrl.value, null);
  assert.match(String(P(before, "structural").portalUrl.notFound), /rule 5 fails closed/);
  kb.importSeededAhjKnowledge(db, { state: "NM", ahj: "City of Santa Fe", portalName: "Santa Fe permits", portalUrl: "https://cityofsantafe.my.site.com/s/", notes: "import", sourceLabel: "test" });
  const seeded = await runCity("City of Santa Fe", "NM", p1, PG, null, portal);
  assert.equal(P(seeded, "structural").portalUrl.value, null, "a seeded row never opens it");
  // The real writer: a person verifies the city's OWN-domain portal — the researched Salesforce tenant is not it.
  const OWN = "https://permits.santafenm.gov/CitizenAccess/";
  kb.saveVerifiedAhjProfile(db, { state: "NM", ahj: "City of Santa Fe", portalUrl: OWN, verifiedBy: "user-verify1" });
  const ent1 = await ppl.lookupPortalEntity(db, "NM", "City of Santa Fe");
  assert.deepEqual(ent1?.verifiedPortals, [OWN], JSON.stringify(ent1));
  const other = await runCity("City of Santa Fe", "NM", p1, PG, null, portal);
  assert.equal(P(other, "structural").portalUrl.value, null, "a verified different portal: the researched one is not launched");
  assert.match(String(P(other, "structural").portalUrl.notFound), /rule 5 fails closed|not the portal a person verified/);
  const ownStep = { text: JSON.stringify({ permits: [{ discipline: "structural", portalUrl: { value: OWN, sourceUrl: PG, quote: `Apply online at ${OWN}` }, recordType: { value: null } }] }), urls: [PG] };
  const kept = await runCity("City of Santa Fe", "NM", p1, PG, null, ownStep);
  assert.equal(P(kept, "structural").portalUrl.value, OWN, `the verified own-domain portal, cited: ${P(kept, "structural").portalUrl.notFound}`);
  // SETUP BY RAW SQL (not the writer): the person's verified row names the Salesforce host and tenant.
  const key = kb.knowledgeProfileKey({ state: "NM", ahj: "City of Santa Fe", utility: "" });
  db.run("UPDATE permit_utility_knowledge SET portal_url = ? WHERE profile_key = ?", ["https://cityofsantafe.my.site.com/s/", key]);
  const ent2 = await ppl.lookupPortalEntity(db, "NM", "City of Santa Fe");
  assert.deepEqual(ent2?.verifiedPortals, ["https://cityofsantafe.my.site.com/s/"], JSON.stringify(ent2));
  const after = await runCity("City of Santa Fe", "NM", p1, PG, null, portal);
  assert.equal(P(after, "structural").portalUrl.value, SF, `verified: ${P(after, "structural").portalUrl.notFound}`);
  assert.ok((after.lookup!.notes ?? []).some((n) => /^Portal \(structural\): .*cityofsantafe/.test(n)), JSON.stringify(after.lookup!.notes));
  // Another AHJ's verified row opens nothing for this one; a seeded row is never "verified".
  assert.equal((await ppl.lookupPortalEntity(db, "NM", "City of Espanola"))?.verifiedPortals.length, 0);
  db.run("UPDATE permit_utility_knowledge SET verified_at = NULL WHERE profile_key = ?", [key]);
  assert.equal((await ppl.lookupPortalEntity(db, "NM", "City of Santa Fe"))?.verifiedPortals.length, 0, "verified_at cleared: not verified (isVerifiedKnowledge)");
});

// ───────────────────────────── D3 — the fee tie ─────────────────────────────
await check("(t1) MUST-EXCLUDE: every prior wrong-row shape through ONE function — amount-first line-join (N1/N1b), ellipsis bridging (N11/N12), newline / dash / bullet splits (A10/A11/A16), a total borrowed from the next row (N3) — through feeLinePrintedTogether AND the real docs/fees door; MUST-PASS: Waltham both ways, Hollis header-joined, Fairfax '$ 0.00', Madison's two electrical lines, the quote-tie of the Jefferson / Corry / Northern Cambria paraphrased labels", () => {
  const tie = reader.feeLinePrintedTogether;
  const feePage = "Building Permit Fees\nSolar Residential | $168\nSolar Commercial | $331\nDeck - Residential | $75\nSolar PV - Residential | $150\nSolar PV - Commercial | $300\n";
  const amountFirst = "Fees\nDeck | $75\nSolar Residential | $150\n";
  assert.equal(tie("Solar Residential", 75, amountFirst), false, "N1");
  assert.equal(tie("Solar Residential", 75, "Fees\nDeck permit fee: $75\nSolar Residential permit fee: $150\n"), false, "N1b");
  assert.equal(tie("Solar Residential", 331, feePage), false, "N11 / A10 / N3");
  assert.equal(tie("Solar Residential", 300, feePage), false, "N12");
  assert.equal(tie("Solar Residential", 75, feePage), false, "A11");
  assert.equal(tie("Solar Thermal", 50, "Fees\nSolar Thermal\n$50 Fence permit\nSolar PV $150\n"), false, "A16");
  assert.equal(tie("Solar Residential", 168, feePage), true, "A12");
  assert.equal(tie("Solar Installation", 50, "Fees\n$25 | Deck\n$50 | Solar Installation\n"), true, "amount-first row");
  assert.equal(tie("Solar Installation", 25, "Fees\n$25 | Deck\n$50 | Solar Installation\n"), false, "amount-first, the deck's amount");
  const waltham = reader.parseHtml(fixture("waltham-electrical-fees.html"), "https://www.city.waltham.ma.us/1290/Electrical-Fees").text;
  assert.equal(tie("Solar Installation", 50, waltham), true, "Waltham");
  assert.equal(tie("Solar Installation", 25, waltham), false, "Waltham, another row's amount");
  assert.equal(tie("Roof Top Solar Array (excludes electrical fee)", 75, fixture("hollis-building-fees.txt")), true, "Hollis");
  assert.equal(tie("Solar Energy (Ch. 61-1-3(d)23)", 0, "I-A Standard Fees\n10.Solar Energy (Ch. 61-1-3(d)23)  $ 0.00\n11.Other  $ 25.00\n"), true, "Fairfax $ 0.00");
  const madison = "Miscellaneous Fees\nSolar panels or collector system | $21.00 ea. Permit\nInspection Fees Existing Buildings\nNew or Altered electrical openings | $25.00 first ten (10) openings $1.00 each additional opening\n";
  assert.equal(tie("Solar panels or collector system — $21.00 ea. Permit", 21, madison), true, "Madison $21");
  assert.equal(tie("New or Altered electrical openings — $25.00 first ten (10) openings", 25, madison), true, "Madison $25");
  assert.equal(tie("New or Altered electrical openings — $1.00 each additional opening", 1, madison), true, "Madison $1");
  assert.equal(tie("Solar panels or collector system", 25, madison), false, "Madison: the electrical row's amount on the solar label");
  // The quote as the text (no page held): the model's "..." is a line break; a paraphrased label ties on the words the quote prints.
  assert.equal(tie("Prescriptive solar PV", 67.25, "Solar Photovoltaic Systems installed using the prescriptive path $67.25 (includes application fee and one inspection)"), true);
  assert.equal(tie("F. Renewable Electrical Energy — 5.01 to 15 kva", 94, "F.  Renewable Electrical Energy    5 kva or less $79.00 3 5.01 to 15 kva $94.00 3 15.01 to 25 kva $156.00 3"), true, "Jefferson");
  assert.equal(tie("Residential Solar Panels — 1.5% of cost (minimum charge)", 200, "Residential Solar Panels   1.5% of cost min-$200.00   $ 4.50 / min-$200.00; max-$1,000.00"), true, "Corry");
  assert.equal(tie("Minimum permit fee (alterations/renovations to existing structures)", 75, "This declared cost is then multiplied by the permit fee multiplier of .0095. The minimum permit fee is $75.00. *(This is"), true, "Northern Cambria");
  assert.equal(tie("Solar permit", 1250, "Solar permit $1,250.00"), true, "grouping comma");
  assert.equal(tie("Solar Residential", 331, "Solar Residential\nCommercial $331"), false, "N11 in a quote (ellipsis -> newline)");
  assert.equal(tie("Solar Commercial", 331, "Residential ... Solar Commercial $331".replace(/\.{3}/g, "\n")), true, "N10: the commercial line's own label on the amount's line");
  assert.equal(tie("Solar Commercial", 331, "Solar Residential ... Commercial $331".replace(/\.{3}/g, "\n")), false, "a label split across the model's elision is not printed together");
  assert.equal(tie("Nothing printed", 331, feePage), false, "a label the text never prints ties nothing");
  // Through the REAL docs/fees door, with the page held.
  const FEES = "https://www.examplecity.gov/DocumentCenter/View/9/Fee-Schedule-PDF";
  const door = (page: string, quote: string, amt: number, label: string, total = amt) => {
    const texts = new Map([[ppl.pageKey(FEES), page]]);
    const ans = JSON.stringify({ permits: [{ discipline: "structural", documents: { value: null }, fee: { value: { amountUsd: total, basis: "flat", lines: [{ label, amountUsd: amt }] }, sourceUrl: FEES, quote } }] });
    return ppl.parseDocsFeesPart(ans, [FEES], "end_turn", texts).byDiscipline.get("structural")!.fee;
  };
  assert.equal(door(amountFirst, "$75 Solar Residential", 75, "Solar Residential").value, null, "N1-DOOR");
  assert.equal(door(feePage, "Solar Residential ... Commercial $331", 331, "Solar Residential").value, null, "N11-DOOR");
  assert.match(String(door(feePage, "Solar Residential ... Commercial $331", 331, "Solar Residential").notFound), /not printed beside its label/);
  assert.equal(door(feePage, "Solar Residential ... PV - Commercial $300", 300, "Solar Residential").value, null, "N12-DOOR");
  assert.equal(door(feePage, "Solar Residential $168 $331", 168, "Solar Residential", 331).value, null, "N3-DOOR: a total borrowed from the next row (the quote itself is not on one row)");
  assert.equal(door(feePage, "Solar Residential $168\nSolar Commercial $331", 168, "Solar Residential", 331).value, null, "N3/N5-DOOR: two rows quoted, the next row's amount as the total");
  assert.match(String(door(feePage, "Solar Residential $168\nSolar Commercial $331", 168, "Solar Residential", 331).notFound), /neither a printed line of this fee nor the sum/);
  assert.equal(door(feePage, "Solar Residential $168\nSolar Commercial $331", 168, "Solar Residential", 168).value?.amountUsd, 168, "the same quote with its own line's total is kept");
  assert.equal(door("Fees\n$25 | Deck\n$50 | Solar Installation\n", "$50 Solar Installation", 50, "Solar Installation").value?.amountUsd, 50, "N1c-DOOR");
  assert.equal(door(feePage, "Residential ... Solar Commercial $331", 331, "Solar Commercial").value?.amountUsd, 331, "N10-DOOR");
  assert.equal(door(feePage, "Solar Residential $168", 168, "Solar Residential").value?.amountUsd, 168, "A12-DOOR");
  // No page held: the quote is the text — the ellipsis shape is refused there too.
  const noPage = (quote: string, amt: number, label: string) => ppl.parseDocsFeesPart(JSON.stringify({ permits: [{ discipline: "structural", documents: { value: null }, fee: { value: { amountUsd: amt, basis: "flat", lines: [{ label, amountUsd: amt }] }, sourceUrl: FEES, quote } }] }), [FEES], "end_turn").byDiscipline.get("structural")!.fee;
  assert.equal(noPage("Solar Residential ... Commercial $331", 331, "Solar Residential").value, null, "N11 with no page held");
  assert.equal(noPage("Solar Residential $168", 168, "Solar Residential").value?.amountUsd, 168);
  // ONE PREDICATE (close-5 MF3): quoteOnPage answers only "are the words on the page" — N1 and N1c
  // read alike there; the amount-beside-label question is the tie's alone (N1-DOOR / N1c-DOOR above).
  assert.equal(reader.quoteOnPage("$75 Solar Residential", amountFirst), true, "N1 at quoteOnPage: the words are on the page; the tie refuses it");
  assert.equal(reader.quoteOnPage("$50 Solar Installation", "Fees\n$25 | Deck\n$50 | Solar Installation\n"), true, "N1c at quoteOnPage");
  assert.equal(reader.quoteOnPage("Solar Residential $168 Solar Commercial $331", feePage), true, "N2: two rows in one segment still pass");
});

// ───────────────────────────── F-b — not asked is not not found ─────────────────────────────
await check("(f1) MUST-PASS (F-b): a run whose PROCESS part was grounded while the portal + documents/fees parts ABORTED is saved with those answers marked NOT ASKED (never all-not-found), runPermitProcessLookup re-asks that row without force, ensurePermitProcessLookedUp re-queues it (bounded by the 24 h dedupe), and a later answer clears the mark; a part that RAN and found nothing is not re-asked", async () => {
  const COUNTY = "https://www.co.example-county.or.us/building/solar";
  const empty: WebLookupResult = { text: "{}", groundedSearches: 3, searches: 3, stopReason: "end_turn", resultUrls: [COUNTY], pagesRead: 0 };
  const aborted: WebLookupResult = { text: "", groundedSearches: 0, stopReason: null, resultUrls: [], pagesRead: 0, error: "Request was aborted." };
  const run = await ppl.runPermitProcessLookup(db, { webLookup: async (i: { label: string }) => (i.label.endsWith(".process") ? empty : aborted) }, { state: "OR", ahj: "City of Restaborted" });
  assert.equal(run.saved, true, run.reason);
  const row = pp.getPermitProcessLookup(db, "OR", "City of Restaborted")!;
  for (const p of row.permits) {
    assert.match(String(p.documents.notFound), /^not asked — the documents lookup did not run/, p.discipline);
    assert.match(String(p.fee.notFound), /^not asked — the fee lookup/, p.discipline);
    assert.match(String(p.portalUrl.notFound), /^not asked — the portal lookup/, p.discipline);
  }
  assert.equal(ppl.lookupHasUnaskedPart(row), true);
  // Re-asked without force; the answer clears the mark.
  const feesAnswer = JSON.stringify({ permits: [{ discipline: "structural", documents: { value: ["plan set"], sourceUrl: COUNTY, quote: "Submit a plan set" }, fee: { value: { amountUsd: 75, basis: "flat", lines: [{ label: "Solar", amountUsd: 75 }] }, sourceUrl: COUNTY, quote: "Solar $75.00" } }] });
  const again = await ppl.runPermitProcessLookup(db, { webLookup: async (i: { label: string }) => (i.label.endsWith(".process") ? empty : i.label.endsWith(".documentsFees") ? g(feesAnswer, [COUNTY]) : empty) }, { state: "OR", ahj: "City of Restaborted" });
  assert.equal(again.saved, true, `re-asked: ${again.reason}`);
  const row2 = pp.getPermitProcessLookup(db, "OR", "City of Restaborted")!;
  assert.equal(row2.permits.find((p) => p.discipline === "structural")!.fee.value?.amountUsd, 75);
  assert.equal(ppl.lookupHasUnaskedPart(row2), false, JSON.stringify(row2.permits.map((p) => [p.documents.notFound, p.fee.notFound, p.portalUrl.notFound])));
  const third = await ppl.runPermitProcessLookup(db, { webLookup: async () => empty }, { state: "OR", ahj: "City of Restaborted" });
  assert.equal(third.saved, false, "nothing unasked: not re-run without force");
  assert.match(third.reason, /already looked up/);
  // The trigger: an unasked row is queued; a ran-and-found-nothing row is not.
  const jq = await import("../src/jobQueue");
  clearInterval(jq.startJobWorker(db));
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  try {
    await ppl.runPermitProcessLookup(db, { webLookup: async (i: { label: string }) => (i.label.endsWith(".process") ? empty : aborted) }, { state: "OR", ahj: "City of Quietmere" });
    const jobs = (ahj: string) => db.query<{ id: string; status: string }>("SELECT id, status FROM job_queue WHERE job_type = 'permit_process_lookup' AND payload LIKE ? ORDER BY created_at", [`%${ahj.toLowerCase().replace(/^city of /, "")}%`]);
    assert.equal(await ppl.ensurePermitProcessLookedUp(db, { id: "no-such-project", state: "OR", ahj: "City of Quietmere", parserSnapshot: {} }), true, "an unasked row is re-queued");
    assert.equal(jobs("City of Quietmere").length, 1);
    db.run("UPDATE job_queue SET status = 'done' WHERE id = ?", [jobs("City of Quietmere")[0].id]);
    assert.equal(await ppl.ensurePermitProcessLookedUp(db, { id: "no-such-project", state: "OR", ahj: "City of Quietmere", parserSnapshot: {} }), true, "within 24 h: deduped, not queued again");
    assert.equal(jobs("City of Quietmere").length, 1, "bounded: once per 24 h");
    await ppl.runPermitProcessLookup(db, { webLookup: async () => empty }, { state: "OR", ahj: "City of Stillwater-example" });
    assert.equal(await ppl.ensurePermitProcessLookedUp(db, { id: "no-such-project", state: "OR", ahj: "City of Stillwater-example", parserSnapshot: {} }), false, "ran and found nothing: not re-asked");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    db.run("UPDATE job_queue SET status = 'failed' WHERE job_type = 'permit_process_lookup' AND status IN ('pending','running')");
  }
});

// ───────────────────────────── lookup-close-5: the skeptic's four must-fixes ─────────────────────────────
// A shared-host ACA tenant fixture: the tenant's entry page links its Building module, whose public
// search form lists the record types (readAccelaCatalog).
const acaSite = (tenant: string, types: Array<[string, string]>) => {
  const ROOT = `https://aca-prod.accela.com/${tenant}/Default.aspx`;
  const MOD = `https://aca-prod.accela.com/${tenant}/Cap/CapHome.aspx?module=Building&TabName=Building`;
  return {
    ROOT, MOD,
    pages: {
      [ROOT]: { text: `<html><head><title>Accela Citizen Access</title></head><body><a href="/${tenant}/Cap/CapHome.aspx?module=Building&amp;TabName=Building">Building</a><p>Welcome to Citizen Access</p></body></html>` },
      [MOD]: { text: `<html><head><title>Accela Citizen Access</title></head><body><form><select id="ctl00_PlaceHolderMain_generalSearchForm_ddlGSPermitType"><option value="">--Select--</option>${types.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></form></body></html>` },
    } as Record<string, Served>,
  };
};
const SOLAR_TYPES: Array<[string, string]> = [["Building/Solar Photovoltaic/Residential/NA", "Building Solar Photovoltaic Residential"], ["Building/Deck/NA/NA", "Building Deck"]];
const stepAsked: string[] = [];
const llmWithStep = (p1: unknown, urls: string[]) => ({ webLookup: async (i: { label: string; user: string }) => { if (i.label.includes("portal")) stepAsked.push(i.user.split("\n").pop() ?? ""); return i.label.endsWith(".process") ? g(JSON.stringify(p1), urls) : g(JSON.stringify({ permits: [] }), []); } });
type Saved = { portalUrl: { value: string | null; notFound?: string }; issuingAgency: { value: string | null }; recordType: { value: string | null; sourceUrl: string }; recordTypeCandidates?: unknown[] };
const saved = (run: { lookup: { permits: Array<{ discipline: string }> } | null }, d: string) => run.lookup!.permits.find((p) => p.discipline === d)! as never as Saved;

await check("(m1) MF1 MUST-EXCLUDE (P1 / P1b): part one cites the COUNTY's ACA tenant for the CITY's own structural permit, with a reader — the door refuses it (type) BEFORE the catalog read and the portal step: the county tenant's 'Building Solar Photovoltaic Residential' is NOT saved as the city's record type, no recordTypeCandidates come from it, the refused tenant's pages are never fetched, and the portal step is still asked for the structural permit; MUST-PASS: the city's OWN tenant cited by part one is judged, its catalog read, and the step NOT asked", async () => {
  const PG = "https://www.cityofdenby.org/building";
  const denby = acaSite("DENBYCOUNTY", SOLAR_TYPES);
  const p1 = JSON.parse(shapeFor("Denby", PG, "City of Denby", "City of Denby", "Denby County"));
  p1.permits[0].portalUrl = { value: denby.ROOT, sourceUrl: PG, quote: "Denby County Online Permits — apply online" };
  // The close-5 skeptic's S1a: part one ALSO cites the record type read off that tenant's module page (a
  // search result). With it, "is a portal still needed" is decided by the JUDGED portal alone (kill V1:
  // needPortal on the raw cited portal + this cited type = the structural permit never re-asked).
  p1.permits[0].recordType = { value: "Building Solar Photovoltaic Residential", sourceUrl: denby.MOD, quote: "Building Solar Photovoltaic Residential" };
  const pages = { ...denby.pages, [PG]: { text: html(`<p>Building permits for properties inside city limits are issued at City Hall on paper. Electrical permits are issued by Denby County.</p>`) } };
  stepAsked.length = 0;
  const r = await ppl.runPermitProcessLookup(db, llmWithStep(p1, [PG, denby.ROOT, denby.MOD]), { state: "IN", ahj: "City of Denby", dcKw: "7", acKw: "6", force: true, reader: newReader(site(pages).fetch) });
  const s = saved(r, "structural");
  assert.equal(s.portalUrl.value, null, `P1: the county tenant is refused (${s.portalUrl.value})`);
  assert.match(String(s.portalUrl.notFound), /another jurisdiction's portal/);
  assert.equal(s.recordType.value, null, `P1 / S1a: the county tenant's type must not be the city's record type (${s.recordType.value} @ ${s.recordType.sourceUrl})`);
  assert.match(String(s.recordType.notFound), /no portal was kept/, `S1a: the reason names the one predicate (${s.recordType.notFound})`);
  assert.doesNotMatch(String(s.recordType.sourceUrl), /DENBYCOUNTY/i);
  assert.equal(s.recordTypeCandidates, undefined, `P1: no candidates from the refused tenant's catalog (${JSON.stringify(s.recordTypeCandidates)})`);
  assert.ok(!(r.reads ?? []).some((x) => /DENBYCOUNTY/i.test(x.url)), `P1: the refused tenant's pages were fetched: ${(r.reads ?? []).map((x) => x.url).join(", ")}`);
  assert.ok(stepAsked.some((u) => /structural/.test(u)), `P1b: the portal step must still be asked for the structural permit (asked: ${JSON.stringify(stepAsked)})`);
  // MUST-PASS: the city's own tenant, cited by part one and returned by the search — judged, its catalog read, the step not asked.
  const PG2 = "https://www.cityofelston.org/building";
  const own = acaSite("CITYOFELSTON", SOLAR_TYPES);
  const p2 = JSON.parse(shapeFor("Elston", PG2, "City of Elston", "City of Elston", "Elston County"));
  p2.permits[0].portalUrl = { value: own.ROOT, sourceUrl: PG2, quote: "City of Elston Online Permits — apply online" };
  const pages2 = { ...own.pages, [PG2]: { text: html(`<p>Building permits are applied for online. Electrical permits are issued by Elston County.</p>`) } };
  stepAsked.length = 0;
  const r2 = await ppl.runPermitProcessLookup(db, llmWithStep(p2, [PG2, own.ROOT]), { state: "IN", ahj: "City of Elston", dcKw: "7", acKw: "6", force: true, reader: newReader(site(pages2).fetch) });
  const s2 = saved(r2, "structural");
  assert.equal(s2.portalUrl.value, own.ROOT, `the own tenant is kept (${s2.portalUrl.notFound})`);
  assert.equal(s2.recordType.value, "Building Solar Photovoltaic Residential", `its catalog names the type (${s2.recordType.value})`);
  assert.match(s2.recordType.sourceUrl, /CITYOFELSTON/);
  assert.ok(!stepAsked.some((u) => /structural/.test(u)), `the portal step is not asked for a permit whose portal and type are known (asked: ${JSON.stringify(stepAsked)})`);
  assert.ok((r2.lookup!.notes ?? []).some((n) => /^Portal \(structural\): .*CITYOFELSTON.* — from the process part; attested by its tenant on the shared host/.test(n)), JSON.stringify(r2.lookup!.notes));
});

await check("(m4) lookup-close-6 MF1 — ONE record-type predicate (recordTypeBelongsToPortal) decides EVERY source: MUST-EXCLUDE the close-5 skeptic's S1b (the PORTAL STEP cites the refused county tenant plus a type from its module page: nothing saved), S1d (the merge carries an earlier type cited to ANOTHER tenant's page beside this run's own portal: not carried; nor a portal-less earlier type), and a cited type beside NO saved portal; MUST-PASS: the issuing agency's OWN page naming the type beside the saved portal, and the portal's own public record", async () => {
  // S1b: the portal step cites the county tenant with a record type from it; part one had nothing.
  const PG = "https://www.cityofcorwinb.org/building"; const co = acaSite("CORWINBCOUNTY", SOLAR_TYPES);
  const p1 = JSON.parse(shapeFor("Corwinb", PG, "City of Corwinb", "City of Corwinb", "Corwinb County"));
  const step = { text: JSON.stringify({ permits: [{ discipline: "structural", portalUrl: { value: co.ROOT, sourceUrl: co.ROOT, quote: "Corwinb County Online Permits — Building Permit" }, recordType: { value: "Building Solar Photovoltaic Residential", sourceUrl: co.MOD, quote: "Building Solar Photovoltaic Residential" } }] }), urls: [co.ROOT, co.MOD] };
  const llmOf = (x: unknown, urls: string[], st?: { text: string; urls: string[] }) => ({ webLookup: async (i: { label: string }) => (i.label.endsWith(".process") ? g(JSON.stringify(x), urls) : st && i.label.includes("portal") ? g(st.text, st.urls) : g(JSON.stringify({ permits: [] }), [])) });
  const r = await ppl.runPermitProcessLookup(db, llmOf(p1, [PG], step), { state: "IN", ahj: "City of Corwinb", dcKw: "7", acKw: "6", force: true, reader: newReader(site({ ...co.pages, [PG]: { text: html("<p>Building permits for properties inside city limits are issued at City Hall on paper. Electrical permits are issued by Corwinb County.</p>") } }).fetch) });
  const s = saved(r, "structural");
  assert.equal(s.portalUrl.value, null, `S1b: the county tenant is refused (${s.portalUrl.value})`);
  assert.equal(s.recordType.value, null, `S1b: the step's type from the refused tenant is not the city's record type (${s.recordType.value} @ ${s.recordType.sourceUrl})`);
  assert.equal(s.recordTypeCandidates, undefined, JSON.stringify(s.recordTypeCandidates));
  // S1d: the earlier row had NO portal and a type cited to MERGDCOUNTY's page; this run saves the city's own tenant (no solar type in its catalog).
  const PG2 = "https://www.cityofmergd.org/building"; const own = acaSite("CITYOFMERGD", [["Building/Deck/NA/NA", "Building Deck"]]);
  const p1a = JSON.parse(shapeFor("Mergd", PG2, "City of Mergd", "City of Mergd", "City of Mergd"));
  const countyModule = "https://aca-prod.accela.com/MERGDCOUNTY/Cap/CapHome.aspx?module=Building";
  p1a.permits[0].recordType = { value: "Building Solar Photovoltaic Residential", sourceUrl: countyModule, quote: "Building Solar Photovoltaic Residential" };
  const ra = await ppl.runPermitProcessLookup(db, llmOf(p1a, [PG2, countyModule]), { state: "IN", ahj: "City of Mergd", dcKw: "7", acKw: "6", force: true, reader: null });
  assert.equal(saved(ra, "structural").recordType.value, null, `a cited type beside NO saved portal is not kept (${saved(ra, "structural").recordType.value})`);
  assert.match(String(saved(ra, "structural").recordType.notFound), /no portal was kept/);
  // …and even when an older door HAD saved it, the merge does not carry it beside this run's own portal; nor an
  // earlier-only permit's type that had no portal (the combo row), while that permit itself is still carried.
  const cm = (value: string | null, sourceUrl = PG2, quote = "City of Mergd issues building permits") => ({ value, sourceUrl, quote, origin: "lookup" as const, ...(value ? {} : { notFound: "x" }) });
  pp.savePermitProcessLookup(db, { ...ra.lookup!, permits: [...ra.lookup!.permits.map((p) => (p.discipline === "structural" ? { ...p, recordType: { value: "Building Solar Photovoltaic Residential", sourceUrl: countyModule, quote: "Building Solar Photovoltaic Residential", origin: "lookup" } } : p)),
    { discipline: "combo", label: "Solar (combo)", issuingAgency: cm("City of Mergd"), portalUrl: cm(null), recordType: cm("Building Solar Photovoltaic Residential", countyModule, "Building Solar Photovoltaic Residential"), documents: cm(null), fee: cm(null) }] } as never);
  const p1b = JSON.parse(shapeFor("Mergd", PG2, "City of Mergd", "City of Mergd", "City of Mergd"));
  p1b.permits[0].portalUrl = { value: own.ROOT, sourceUrl: PG2, quote: "City of Mergd Online Permits — apply online" };
  // This run's part one ALSO cites the county-page type beside the city's own portal: it is no record type, so the
  // portal step is still asked for the structural permit (the "is a record type still needed" question asks the one
  // predicate; the catalog of CITYOFMERGD lists no solar type).
  p1b.permits[0].recordType = { value: "Building Solar Photovoltaic Residential", sourceUrl: countyModule, quote: "Building Solar Photovoltaic Residential" };
  stepAsked.length = 0;
  const rb = await ppl.runPermitProcessLookup(db, llmWithStep(p1b, [PG2, own.ROOT, countyModule]), { state: "IN", ahj: "City of Mergd", dcKw: "7", acKw: "6", force: true, reader: newReader(site({ ...own.pages, [PG2]: { text: html("<p>Building permits are applied for online.</p>") } }).fetch) });
  const sb = saved(rb, "structural");
  assert.equal(sb.portalUrl.value, own.ROOT, `this run's own portal (${sb.portalUrl.notFound})`);
  assert.equal(sb.recordType.value, null, `S1d: the earlier type cited to MERGDCOUNTY's page is not carried beside CITYOFMERGD (${sb.recordType.value} @ ${sb.recordType.sourceUrl})`);
  assert.ok(stepAsked.some((u) => /structural/.test(u)), `a type cited to another tenant's page leaves the record type still needed — the step is asked (asked: ${JSON.stringify(stepAsked)})`);
  const combo = saved(rb, "combo");
  assert.ok(combo, "the earlier-only combo permit is still carried (never forgets)");
  assert.equal(combo.recordType.value, null, `an earlier-only permit's portal-less record type is not carried (${combo.recordType.value})`);
  assert.match(String(combo.recordType.notFound), /had no portal/);
  // MUST-PASS: the issuing agency's own page names the type beside the saved portal — kept, cited to that page; the
  // portal's own public record too; another jurisdiction's .gov page, or the vendor's other tenant, never.
  const belongs = ppl.recordTypeBelongsToPortal;
  const ctx = { names: ["City of Mergd"], typeNames: ["City of Mergd"], state: "IN" };
  assert.equal(belongs({ value: "Residential Solar", sourceUrl: PG2, quote: "select Residential Solar in the portal" }, own.ROOT, ctx), true, "the agency's own page");
  assert.equal(belongs({ value: "Residential Solar", sourceUrl: "https://aca-prod.accela.com/CITYOFMERGD/Cap/CapDetail.aspx?capID1=1", quote: "Residential Solar" }, own.ROOT, ctx), true, "a public record on the portal's own tenant");
  assert.equal(belongs({ value: "Residential Solar", sourceUrl: "https://permits.mergdcounty.gov/solar", quote: "select Residential Solar" }, own.ROOT, ctx), false, "another jurisdiction's own domain");
  assert.equal(belongs({ value: "Residential Solar", sourceUrl: PG2, quote: "Mergd County: select Residential Solar" }, own.ROOT, ctx), false, "the agency's page, but the words name another jurisdiction");
  assert.equal(belongs({ value: "Residential Solar", sourceUrl: countyModule, quote: "Residential Solar" }, own.ROOT, ctx), false, "the vendor's other tenant");
  assert.equal(belongs({ value: "Residential Solar", sourceUrl: PG2, quote: "select Residential Solar" }, null, ctx), false, "no portal saved");
  assert.equal(belongs({ value: "Residential Solar", sourceUrl: "https://www.accela.com/solutions", quote: "Residential Solar" }, own.ROOT, ctx), false, "the vendor's site");
  const p1c = JSON.parse(shapeFor("Mergd", PG2, "City of Mergd", "City of Mergd", "City of Mergd"));
  p1c.permits[0].portalUrl = { value: own.ROOT, sourceUrl: PG2, quote: "City of Mergd Online Permits — apply online" };
  p1c.permits[0].recordType = { value: "Residential Solar", sourceUrl: PG2, quote: "Choose the Residential Solar record when applying online" };
  const rc = await ppl.runPermitProcessLookup(db, llmOf(p1c, [PG2, own.ROOT]), { state: "IN", ahj: "City of Mergd", dcKw: "7", acKw: "6", force: true, reader: newReader(site({ ...own.pages, [PG2]: { text: html("<p>Building permits are applied for online. Choose the Residential Solar record when applying online.</p>") } }).fetch) });
  assert.equal(saved(rc, "structural").recordType.value, "Residential Solar", `MUST-PASS: the agency's own words about its portal (${saved(rc, "structural").recordType.notFound})`);
  assert.equal(saved(rc, "structural").recordType.sourceUrl, PG2);
  // A CITED TYPE STEERS THE CATALOG'S CHOICE ONLY WHEN IT BELONGS (close F5's candidateNamedBy): the city's own
  // tenant lists two solar types and no plan path decides; a "Solar Prescriptive" cited to the COUNTY's module page
  // must not pick one (the operator question stays), the same words on the city's own page do.
  const PG3 = "https://www.cityofsteerx.org/building"; const two = acaSite("CITYOFSTEERX", [["Building/Solar/Prescriptive/NA", "Solar Prescriptive"], ["Building/Solar/Engineered/NA", "Solar Non Prescriptive"]]);
  const countyMod3 = "https://aca-prod.accela.com/STEERXCOUNTY/Cap/CapHome.aspx?module=Building";
  const steer = async (rtSource: string, rtQuote: string) => {
    const p = JSON.parse(shapeFor("Steerx", PG3, "City of Steerx", "City of Steerx", "City of Steerx"));
    p.permits[0].portalUrl = { value: two.ROOT, sourceUrl: PG3, quote: "City of Steerx Online Permits — apply online" };
    p.permits[0].recordType = { value: "Solar Prescriptive", sourceUrl: rtSource, quote: rtQuote };
    const r = await ppl.runPermitProcessLookup(db, llmOf(p, [PG3, two.ROOT, countyMod3]), { state: "IN", ahj: "City of Steerx", dcKw: "7", acKw: "6", force: true, reader: newReader(site({ ...two.pages, [PG3]: { text: html(`<p>Building permits are applied for online. ${rtQuote}</p>`) } }).fetch) });
    return { s: saved(r, "structural"), notes: r.lookup!.notes ?? [] };
  };
  const foreign = await steer(countyMod3, "Solar Prescriptive");
  assert.equal(foreign.s.recordType.value, null, `a type cited to the county's module page must not choose among the city's candidates (${foreign.s.recordType.value})`);
  assert.equal((foreign.s.recordTypeCandidates ?? []).length, 2, "the city's own candidates stay");
  assert.ok(foreign.notes.some((n) => /^Operator question: Which record type/.test(n)), `the operator question stays ${JSON.stringify(foreign.notes)}`);
  const own3 = await steer(PG3, "Choose Solar Prescriptive for a prescriptive-path system");
  assert.equal(own3.s.recordType.value, "Solar Prescriptive", `MUST-PASS: the agency's own words decide (${own3.s.recordType.notFound})`);
  assert.match(own3.s.recordType.sourceUrl, /CITYOFSTEERX/, "in the PORTAL's words (its catalog's label and page)");
});

await check("(v1) lookup-close-6 MF4 — the door asks the ONE 'is this the vendor's own site' predicate (isVendorRootOrMarketing, the page-read resolver's): MUST-EXCLUDE the portal step citing www.tylertech.com/products/… / www.cityview.com/solutions/permitting / clariti / govwelltech / tylerportico.com (the search returned the page, the quote says 'online permit portal') and a shared instance naming no tenant; MUST-PASS a tenant URL on the same vendors (tylerhost.net EnerGov, <city>.portal.opengov.com, bsaonline ?uid=, mapsonline /<town>/) is kept", async () => {
  const stepRun = async (ahj: string, PG: string, portal: string, portalSrc: string, quote: string, stepUrls: string[]) => {
    const p1 = JSON.parse(shapeFor(ahj.replace(/^City of /, ""), PG, ahj, ahj, ahj));
    const step = { text: JSON.stringify({ permits: [{ discipline: "structural", portalUrl: { value: portal, sourceUrl: portalSrc, quote }, recordType: { value: null } }, { discipline: "electrical", portalUrl: { value: portal, sourceUrl: portalSrc, quote }, recordType: { value: null } }] }), urls: stepUrls };
    const r = await runCity(ahj, "IN", JSON.stringify(p1), PG, html(`<p>Building permits are issued by the ${ahj}.</p>`), step);
    return { s: saved(r, "structural"), notes: r.lookup!.notes ?? [] };
  };
  const marketing = ["https://www.tylertech.com/products/enterprise-permitting-licensing", "https://www.cityview.com/solutions/permitting", "https://www.clariti.com/permitting-software", "https://www.govwelltech.com/permitting", "https://www.tylerportico.com/", "https://www.accela.com/solutions/civic-platform", "https://aca-prod.accela.com/", "https://portal.iworq.net/", "https://bsaonline.com/"];
  for (const [i, u] of marketing.entries()) {
    const PG = `https://www.cityofvend${i}.org/building`;
    const { s } = await stepRun(`City of Vend${i}`, PG, u, u, "Apply online — online permit portal, citizen self service", [PG, u]);
    assert.equal(s.portalUrl.value, null, `${u} is the vendor's own site, not a portal (kept as ${s.portalUrl.value})`);
    // The parse-time door refuses it outright, so the saved not-found carries the reason (the notes list only a
    // claim that reached finalPortal — the same as a rule-5 refusal at parse time).
    assert.match(String(s.portalUrl.notFound), /vendor's own site/, `${u}: ${s.portalUrl.notFound}`);
    assert.equal(channel.isVendorRootOrMarketing(u), true, u);
    assert.equal(ppl.acceptPortalForPermit({ value: u, sourceUrl: u, quote: "online permit portal" }, "portal step", { seenUrls: [u] }).code, "vendor", u);
  }
  const tenants = ["https://tulsaok-energovweb.tylerhost.net/apps/selfservice", "https://salemma.portal.opengov.com/", "https://bsaonline.com/?uid=413", "https://www.mapsonline.net/westonma/online_permits/", "https://permiteyes.us/concord/loginuser.php", "https://portal.iworq.net/EAGLE/permits/600", "https://www.citizenserve.com/Portal/PortalController?Action=showHomePage&installationID=123", "https://www.mygovernmentonline.org/?agency=marion"];
  for (const [i, u] of tenants.entries()) {
    const PG = `https://www.cityoftenant${i}.org/building`;
    const { s } = await stepRun(`City of Tenant${i}`, PG, u, PG, "Apply online for a building permit through the online permit portal", [PG, u]);
    assert.equal(s.portalUrl.value, u, `MUST-PASS: a tenant on the vendor's host is kept (${s.portalUrl.notFound})`);
    assert.equal(channel.isVendorRootOrMarketing(u), false, u);
  }
});

await check("(m2) MF2 MUST-EXCLUDE (P5a-d): ONE definition of a path-tenanted host and of a vendor's domain (portalChannel.isPathTenantedHost / isVendorDomain) — another tenant's search result on public.mygov.us / mygovernmentonline.org attests nothing, and a vendor's marketing page on geocivix.com / bsaonline.com is never 'the agency's own page quoting a link on its own domain'; MUST-PASS: the same tenants when the search returned THEM", async () => {
  assert.equal(channel.isPathTenantedHost("public.mygov.us"), true); assert.equal(channel.isPathTenantedHost("www.mygovernmentonline.org"), true);
  assert.equal(channel.isPathTenantedHost("aca-prod.accela.com"), true); assert.equal(channel.isPathTenantedHost("egcss.charleston-sc.gov"), false);
  // lookup-close-6 MF3: the real shared hosts the one definition lacked — iWorQ's bare shared instance (path), BS&A
  // (?uid=), PermitEyes (/<town>/), PeopleGIS MapsOnline (/<town>/, ?client=) — as INSTANCE hosts: a subdomain-tenanted
  // iWorQ instance (<tenant>.portal.iworq.net) and the vendors' own www hosts are not path-tenanted.
  for (const h of ["portal.iworq.net", "bsaonline.com", "www.bsaonline.com", "permiteyes.us", "www.mapsonline.net", "www.citizenserve.com", "aca-oregon.accela.com", "aca3.accela.com"]) assert.equal(channel.isPathTenantedHost(h), true, h);
  for (const h of ["hanover.portal.iworq.net", "eagle_permit.portal.iworq.net", "www.iworq.net", "www.accela.com", "accela.com", "tylerhost.net", "x-energovweb.tylerhost.net", "salemma.portal.opengov.com"]) assert.equal(channel.isPathTenantedHost(h), false, h);
  assert.notEqual(channel.portalTenantKey("https://bsaonline.com/?uid=413"), channel.portalTenantKey("https://bsaonline.com/?uid=2695"), "?uid= names the BS&A tenant");
  assert.notEqual(channel.portalTenantKey("https://www.mapsonline.net/simplicity/building_permits.php?client=melrosema"), channel.portalTenantKey("https://www.mapsonline.net/simplicity/building_permits.php?client=westonma"), "?client= names the MapsOnline tenant");
  {
    // R1 / R2 through the real resolver (the close-5 skeptic's probe5v-real): the portal step writes a sibling
    // tenant attested only by another tenant's search result — not kept; the tenant itself returned — kept.
    const stepRun = async (ahj: string, PG: string, portal: string, quote: string, stepUrls: string[]) => {
      const p1 = JSON.parse(shapeFor(ahj.replace(/^(?:City|Town) of /, ""), PG, ahj, ahj, ahj));
      const step = { text: JSON.stringify({ permits: [{ discipline: "structural", portalUrl: { value: portal, sourceUrl: PG, quote }, recordType: { value: null } }, { discipline: "electrical", portalUrl: { value: portal, sourceUrl: PG, quote }, recordType: { value: null } }] }), urls: stepUrls };
      return saved(await runCity(ahj, "IN", JSON.stringify(p1), PG, html(`<p>Building permits are issued by the ${ahj}.</p>`), step), "structural");
    };
    const PGx = "https://www.townofmarionx.org/building";
    const r1 = await stepRun("Town of Marionx", PGx, "https://portal.iworq.net/MARIONX/permits/600", "Apply online for a building permit", [PGx, "https://portal.iworq.net/PLAINFIELD/permits/600"]);
    assert.equal(r1.portalUrl.value, null, `R1: PLAINFIELD's tenant attests nothing for MARIONX (${r1.portalUrl.value})`);
    assert.match(String(r1.portalUrl.notFound), /that tenant on the shared host/);
    const PGy = "https://www.townofmariony.org/building";
    assert.equal((await stepRun("Town of Mariony", PGy, "https://portal.iworq.net/MARIONY/permits/600", "Apply online for a building permit", [PGy, "https://portal.iworq.net/MARIONY/permits/600"])).portalUrl.value, "https://portal.iworq.net/MARIONY/permits/600", "R1 mirror");
    const PGb = "https://www.cityofbsax.org/building";
    const r2 = await stepRun("City of Bsax", PGb, "https://bsaonline.com/?uid=9999", "Apply online for a building permit through BS&A Online", [PGb, "https://bsaonline.com/?uid=413"]);
    assert.equal(r2.portalUrl.value, null, `R2: Otsego County's ?uid=413 attests nothing for ?uid=9999 (${r2.portalUrl.value})`);
    assert.equal((await stepRun("City of Bsay", PGb, "https://bsaonline.com/?uid=9999", "Apply online for a building permit through BS&A Online", [PGb, "https://bsaonline.com/SiteSearch/BuildingDepartmentRecordSearch?uid=9999"])).portalUrl.value, "https://bsaonline.com/?uid=9999", "R2 MUST-PASS: a deeper page of the same BS&A tenant (the query names it; the path is a page) attests it");
    assert.equal((await stepRun("City of Bsaz", PGb, "https://bsaonline.com/?uid=9999", "Apply online for a building permit through BS&A Online", [PGb, "https://bsaonline.com/?uid=9999"])).portalUrl.value, "https://bsaonline.com/?uid=9999", "R2 mirror");
    const PGp = "https://www.townofpermx.org/building";
    assert.equal((await stepRun("Town of Permx", PGp, "https://permiteyes.us/permx/loginuser.php", "Apply online for a building permit", [PGp, "https://permiteyes.us/concord/loginuser.php"])).portalUrl.value, null, "PermitEyes: Concord's tenant attests nothing for permx");
    assert.equal((await stepRun("Town of Permy", PGp, "https://www.mapsonline.net/permyma/online_permits/", "Apply online for a building permit", [PGp, "https://www.mapsonline.net/westonma/online_permits/"])).portalUrl.value, null, "MapsOnline: Weston's tenant attests nothing for permyma");
  }
  for (const v of ["geocivix.com", "bsaonline.com", "aca-prod.accela.com", "tylertech.com", "powerclerk.com"]) assert.equal(channel.isVendorDomain(v), true, v);
  for (const own of ["charleston-sc.gov", "cityofmarion.org", "co.marion.or.us"]) assert.equal(channel.isVendorDomain(own), false, own);
  const names = ["City of Marion"];
  const door = (value: string, sourceUrl: string, quote: string, seenUrls: string[]) => ppl.acceptPortalForPermit({ value, sourceUrl, quote }, "portal step", { seenUrls, names, typeNames: names });
  const P = "https://www.cityofmarion.org/building";
  const mygov = "https://public.mygov.us/marion_in/";
  assert.equal(door(mygov, P, "Apply online through MyGov", [P, "https://public.mygov.us/othercity_in/"]).fact.value, null, "P5a: another tenant on public.mygov.us attests nothing");
  assert.equal(door(mygov, P, "Apply online through MyGov", [P, mygov]).fact.value, mygov, "P5a mirror: the tenant itself was returned");
  const mgo = "https://www.mygovernmentonline.org/?agency=marion";
  assert.equal(door(mgo, P, "Apply online through MyGovernmentOnline", [P, "https://www.mygovernmentonline.org/?agency=other"]).fact.value, null, "P5b: another agency on mygovernmentonline.org attests nothing");
  assert.equal(door(mgo, P, "Apply online through MyGovernmentOnline", [P, mgo]).fact.value, mgo, "P5b mirror");
  const geo = "https://marion.geocivix.com/";
  const geoMarketing = "https://www.geocivix.com/customers";
  assert.equal(door(geo, geoMarketing, `Apply online at marion.geocivix.com`, [P, geoMarketing]).fact.value, null, "P5c: a vendor's marketing page is not the agency's own page");
  assert.equal(door(geo, geoMarketing, `Apply online at marion.geocivix.com`, [P, geoMarketing, geo]).fact.value, geo, "P5c mirror: the tenant was returned");
  const bsa = "https://marion.bsaonline.com/";
  assert.equal(door(bsa, "https://www.bsaonline.com/", "Apply online at marion.bsaonline.com", [P, "https://www.bsaonline.com/"]).fact.value, null, "P5d");
  assert.equal(door(bsa, "https://www.bsaonline.com/", "Apply online at marion.bsaonline.com", [P, "https://www.bsaonline.com/", bsa]).fact.value, bsa, "P5d mirror");
  // The own-domain rule still passes a real own-domain link (Fairfax PLUS) and refuses a vendor tenant written into an agency page's quote.
  const plus = "https://plus.fairfaxcounty.gov/CitizenAccess/Welcome.aspx";
  assert.equal(ppl.acceptPortalForPermit({ value: plus, sourceUrl: "https://www.fairfaxcounty.gov/landdevelopment/permits", quote: `Apply online in PLUS (${plus})` }, "process part", { seenUrls: ["https://www.fairfaxcounty.gov/landdevelopment/permits"], names: ["Fairfax County"], typeNames: ["Fairfax County"] }).fact.value, plus);
  assert.equal(door("https://marion-energovweb.tylerhost.net/apps/selfservice", P, "Apply online at marion-energovweb.tylerhost.net", [P]).fact.value, null, "a vendor tenant in an agency page's quote is the model's word");
});

await check("(t2) MF3: ONE predicate for 'is the amount printed beside its label' — quoteOnPage answers only whether the words are on the page (N1, N11, N12 pass it), the fee tie refuses them at the door with its own reason; a total with NO printed line (the hole the quote door's old amount rule covered) is refused at the tie too", () => {
  const feePage = "Building Permit Fees\nSolar Residential | $168\nSolar Commercial | $331\nDeck - Residential | $75\nSolar PV - Residential | $150\nSolar PV - Commercial | $300\n";
  const amountFirst = "Fees\nDeck | $75\nSolar Residential | $150\n";
  assert.equal(reader.quoteOnPage("Solar Residential ... Commercial $331", feePage), true, "N11: the words are on the page");
  assert.equal(reader.quoteOnPage("Solar Residential ... PV - Commercial $300", feePage), true, "N12: the words are on the page");
  assert.equal(reader.quoteOnPage("$75 Solar Residential", amountFirst), true, "N1: the words are on the page");
  const FEES = "https://www.examplecity.gov/DocumentCenter/View/9/Fee-Schedule-PDF";
  const door = (page: string, quote: string, total: number, lines: Array<{ label: string; amountUsd: number }>) => {
    const texts = new Map([[ppl.pageKey(FEES), page]]);
    const ans = JSON.stringify({ permits: [{ discipline: "structural", documents: { value: null }, fee: { value: { amountUsd: total, basis: "flat", lines }, sourceUrl: FEES, quote } }] });
    return ppl.parseDocsFeesPart(ans, [FEES], "end_turn", texts).byDiscipline.get("structural")!.fee;
  };
  const proseLines = "Fees\nDeck permit fee: $75\nSolar Residential permit fee: $150\n";
  assert.equal(reader.quoteOnPage("$75 Solar Residential", proseLines), true, "N1b: the words are on the page");
  for (const [page, quote, total] of [[feePage, "Solar Residential ... Commercial $331", 331], [feePage, "Solar Residential ... PV - Commercial $300", 300], [amountFirst, "$75 Solar Residential", 75], [proseLines, "$75 Solar Residential", 75]] as Array<[string, string, number]>) {
    const f = door(page, quote, total, [{ label: "Solar Residential", amountUsd: total }]);
    assert.equal(f.value, null, `${quote}: refused at the door`);
    assert.match(String(f.notFound), /not printed beside its label/, `${quote}: by the tie`);
  }
  // A16 through the door: the words pass the quote door, the tie refuses the line-join.
  const a16 = door("Fees\nSolar Thermal\n$50 Fence permit\nSolar PV $150\n", "Solar Thermal $50", 50, [{ label: "Solar Thermal", amountUsd: 50 }]);
  assert.equal(a16.value, null); assert.match(String(a16.notFound), /not printed beside its label/);
  // LINE-LESS: a total with no line and no tier has no pair to tie.
  const bare = door(amountFirst, "$75 Solar Residential", 75, []);
  assert.equal(bare.value, null, "a line-less total on a line-join is refused");
  assert.match(String(bare.notFound), /no printed line/);
  assert.equal(door(feePage, "Solar Residential $168", 168, []).value, null, "a line-less total is refused even when printed beside the words (no pair)");
  assert.equal(door(feePage, "Solar Residential $168", 168, [{ label: "Solar Residential", amountUsd: 168 }]).value?.amountUsd, 168, "with its line: kept");
});

await check("(a1) MF4: ONE predicate 'is this cited agency the AHJ itself' (sameAgencyName) sees through a department suffix and trailing punctuation — the Charleston shape ('City of Charleston Permit Center /' for City of Charleston) saves NO fee delegation row and the electrical permit takes the SAME portal as the structural one, its agency saved as 'City of Charleston'; MUST-PASS: a genuine delegation (the county issues the city's permits — the Jefferson lift) still lands a collected-by row", async () => {
  const same = ppl.sameAgencyName;
  for (const [a, b] of [["City of Charleston Permit Center /", "City of Charleston"], ["City of Charleston Building Inspections Division", "City of Charleston"], ["Charleston Permit Center", "City of Charleston"], ["the City of Charleston, SC", "City of Charleston"],
    ["Marion County Public Works Building Inspection Division", "Marion County"], ["Hollis", "Town of Hollis"], ["Waltham Wires Department", "Waltham City"], ["Iowa City Building Department", "Iowa City"], ["Examplecity Development Services", "City of Examplecity"],
    ["City of Venus", "Town of Venus"], ["Village of Elm", "Town of Elm"], ["City of Scottsdale Planning and", "City of Scottsdale"], ["Santa Fe County Building and", "Santa Fe County"],
    // lookup-close-6 MF5: "<Type> of X" is "X <Type>" (a county site styles itself "County of Marin"; the product's AHJ is
    // "Marin County"), and a consolidated "City and County of X" is X.
    ["County of Marin", "Marin County"], ["County of Marin Community Development Agency", "Marin County"], ["Marin County", "County of Marin"], ["Township of Cherry Hill", "Cherry Hill Township"], ["Parish of Jefferson", "Jefferson Parish"],
    ["Borough of State College", "State College Borough"], ["City and County of Denver", "Denver"], ["Denver", "City and County of Denver"], ["City and County of San Francisco", "San Francisco"], ["City and County of Denver Community Planning and Development", "Denver"],
    ["City of Iowa City", "Iowa City"], ["Parish of Jefferson Department of Inspection & Code Enforcement", "Jefferson Parish"],
    // MF6: the identity key sees through a department phrase joined by a connector.
    ["City of Los Angeles Department of Building and Safety", "City of Los Angeles"], ["Santa Fe County Building and Zoning", "Santa Fe County"]]) {
    assert.equal(same(a, b), true, `${a} ~ ${b}`);
  }
  for (const [a, b] of [["Charleston County", "City of Charleston"], ["Marion County", "City of Jefferson"], ["State of MN", "City of Bemidji"], ["State Construction Industries Division", "Examplecounty"], ["City of Hampton", "City of Marion"], ["", "City of Marion"], ["Building Inspections Division", "City of Charleston"],
    ["Marion Township", "Town of Marion"], ["Marion Township", "Marion County"], ["Marion Parish", "City of Marion"],
    // MUST-PASS delegations stay two agencies: a city vs its county of the same name (either styling), the Jefferson lift, Bemidji's state electrical, Idaho's DBS.
    ["City of Marion", "Marion County"], ["Marion County", "City of Marion"], ["County of Marion", "City of Marion"], ["Marion County", "Marion Township"], ["Idaho Division of Building Safety", "City of Eagle"], ["Oregon Building Codes Division", "City of Jefferson"]]) {
    assert.equal(same(a, b), false, `${a} !~ ${b}`);
  }
  assert.equal(ppl.agencyNameKey("City of Charleston Permit Center / Building Inspections Division"), "charleston city");
  assert.equal(ppl.agencyNameKey("County of Marin Community Development Agency"), "marin county");
  assert.equal(ppl.agencyNameKey("City and County of Denver"), "denver");
  assert.equal(ppl.agencyNameKey("Idaho Division of Building Safety"), "idaho");
  // MF6 (fba1e45's regression): the saved NAME is never truncated past a connector — "Idaho Division of Building Safety"
  // (a genuine state delegation) and "City of Los Angeles Department of Building and Safety" stay whole; a dangling
  // trailing connector ("Planning and") is a truncation and goes with the department words; a name made only of
  // department words and connectors names nobody.
  const nameOf = (v: string) => {
    const PG = "https://www.example.gov/permits";
    return ppl.parseProcessPart(JSON.stringify({ issuingAgency: { value: v, sourceUrl: PG, quote: `${v} issues electrical permits for this jurisdiction` }, permitStructure: { value: null }, permits: [] }), [PG], "end_turn").issuingAgency.value;
  };
  for (const [v, want] of [["Idaho Division of Building Safety", "Idaho Division of Building Safety"], ["City of Los Angeles Department of Building and Safety", "City of Los Angeles Department of Building and Safety"], ["Department of Building and Safety", null], ["Building Inspections Division", null],
    ["City of Charleston Permit Center /", "City of Charleston"], ["City of Scottsdale Planning and", "City of Scottsdale"], ["Santa Fe County Building and", "Santa Fe County"], ["Minnesota Department of Labor and Industry", "Minnesota Department of Labor and Industry"],
    ["State Electrical Board", "State Electrical Board"], ["Fort Collins Utilities", "Fort Collins Utilities"], ["Marion County Public Works Building Inspection Division", "Marion County"], ["Waltham Wires Department", "Waltham"], ["Oregon Building Codes Division", "Oregon"]] as Array<[string, string | null]>) {
    assert.equal(nameOf(v), want, `"${v}" -> ${JSON.stringify(nameOf(v))}`);
  }
  // R5 through the real lookup: Idaho DBS issues the electrical permit — saved whole, the delegation keyed on the whole name.
  const fees = await import("../src/feeSchedules");
  {
    const PG = "https://www.cityofeaglex.org/building";
    const p1 = JSON.parse(shapeFor("Eaglex", PG, null, "City of Eaglex", "Idaho Division of Building Safety"));
    const r = await runCity("City of Eaglex", "ID", JSON.stringify(p1), PG, html("<p>City of Eaglex issues building permits for properties inside city limits. Electrical permits are issued by Idaho Division of Building Safety.</p>"));
    assert.equal(saved(r, "electrical").issuingAgency.value, "Idaho Division of Building Safety");
    const rows = fees.getFeeSchedulesForKey(db, fees.feeScheduleProfileKey({ state: "ID", ahj: "City of Eaglex" }, "permit"), "permit");
    assert.deepEqual(rows.filter((x) => x.collectedByProfileKey).map((x) => `${x.discipline} -> ${x.collectedByProfileKey}`), ["electrical -> id|idaho division of building safety|unknown"], JSON.stringify(rows.map((x) => [x.discipline, x.collectedByProfileKey])));
  }
  // R4 through the real lookup (MF5): Marin County, both permits citing "County of Marin Community Development Agency" — no phantom delegation.
  {
    const PG = "https://www.marincounty.gov/departments/cda/building";
    const p1 = JSON.parse(shapeFor("Marin", PG, null, "County of Marin Community Development Agency", "County of Marin Community Development Agency"));
    const r = await runCity("Marin County", "CA", JSON.stringify(p1), PG, html("<p>County of Marin Community Development Agency issues building permits for properties inside city limits. Electrical permits are issued by County of Marin Community Development Agency.</p>"));
    assert.equal(saved(r, "structural").issuingAgency.value, "County of Marin");
    assert.equal(r.lookup!.issuingAgency.value, "County of Marin", "MF7: the agreeing agencies are lifted through sameAgencyName");
    const rows = fees.getFeeSchedulesForKey(db, fees.feeScheduleProfileKey({ state: "CA", ahj: "Marin County" }, "permit"), "permit");
    assert.deepEqual(rows.filter((x) => x.collectedByProfileKey).map((x) => `${x.discipline} -> ${x.collectedByProfileKey}`), [], "R4: no phantom delegation from Marin County to County of Marin");
  }
  // MF7: liftAgreedAgency and agenciesToAsk decide sameness with the one predicate.
  {
    const cited = (value: string) => ({ value, sourceUrl: "https://www.example.gov/permits", quote: `${value} issues permits`, origin: "lookup" as const });
    const nf = { value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: "x" };
    const permits = [{ discipline: "structural", issuingAgency: cited("City of Venus") }, { discipline: "electrical", issuingAgency: cited("Town of Venus") }] as never;
    assert.equal(ppl.liftAgreedAgency(nf, permits).value, "City of Venus", "City of Venus + Town of Venus agree");
    assert.deepEqual(ppl.agenciesToAsk("Town of Venus", nf, permits, ["structural", "electrical"]).map((x) => [x.agency, x.disciplines]), [["City of Venus", ["structural", "electrical"]]], "one group");
    const charleston = [{ discipline: "structural", issuingAgency: cited("City of Charleston Building Inspections Division") }, { discipline: "electrical", issuingAgency: cited("Charleston Permit Center") }] as never;
    assert.equal(ppl.liftAgreedAgency(nf, charleston).value, "City of Charleston Building Inspections Division");
    assert.equal(ppl.agenciesToAsk("City of Charleston", nf, charleston, ["structural", "electrical"]).length, 1);
    const split = [{ discipline: "structural", issuingAgency: cited("City of Jefferson") }, { discipline: "electrical", issuingAgency: cited("Marion County") }] as never;
    assert.equal(ppl.liftAgreedAgency(nf, split).value, null, "two agencies: no lift");
    assert.equal(ppl.agenciesToAsk("City of Jefferson", nf, split, ["structural", "electrical"]).length, 2);
  }
  // The Charleston shape through the real lookup (a reader resolving the city's own portal from its page).
  const CITY = "https://www.charleston-example.gov";
  const PG = `${CITY}/856/Permit-Center`;
  const APP = `${CITY}/DocumentCenter/View/35198/Permit-Application--Electrical`;
  const ACA = "https://aca-prod.accela.com/CHARLESTONEXAMPLE/Default.aspx";
  const p1 = {
    issuingAgency: { value: "City of Charleston-example Building Inspections Division (Permit Center)", sourceUrl: PG, quote: "Building Inspections Division for building, mechanical, electrical, plumbing and fuel-gas inspections" },
    permitStructure: { value: "separate", sourceUrl: PG, quote: "A separate Electrical Trade Permit - Electrical Sub permit" },
    permits: [
      { discipline: "structural", label: "Solar Panel permit", issuingAgency: { value: "City of Charleston-example Building Inspections Division (Permit Center)", sourceUrl: PG, quote: "Building Inspections Division for building, mechanical, electrical, plumbing and fuel-gas inspections" }, portalUrl: { value: null }, recordType: { value: null } },
      { discipline: "electrical", label: "Electrical Trade (Sub) Permit", issuingAgency: { value: "City of Charleston-example Permit Center / Building Inspections Division", sourceUrl: APP, quote: "ELECTRICAL TRADE PERMIT APPLICATION City of Charleston-example Permit Center 2 George St" }, portalUrl: { value: null }, recordType: { value: null } },
    ],
  };
  const pages = { [PG]: { text: html(`<p>Building Inspections Division for building, mechanical, electrical, plumbing and fuel-gas inspections.</p><p><a href="${ACA}">Apply online - Customer Self Service</a></p>`, "Permit Center") } };
  const llm = { webLookup: async (i: { label: string }) => (i.label.endsWith(".process") ? g(JSON.stringify(p1), [PG, APP]) : g(JSON.stringify({ permits: [] }), [])) };
  const r = await ppl.runPermitProcessLookup(db, llm, { state: "SC", ahj: "City of Charleston-example", dcKw: "7", acKw: "6", force: true, reader: newReader(site(pages).fetch) });
  assert.equal(r.saved, true, r.reason);
  const st = saved(r, "structural"); const el = saved(r, "electrical");
  assert.equal(el.issuingAgency.value, "City of Charleston-example", `the department suffix and the stray "/" are not the agency's name (${el.issuingAgency.value})`);
  assert.equal(st.portalUrl.value, ACA, `structural: the city's own portal (${st.portalUrl.notFound})`);
  assert.equal(el.portalUrl.value, ACA, `electrical: the SAME portal — the cited agency is the city itself (${el.portalUrl.notFound})`);
  assert.ok((r.lookup!.notes ?? []).some((n) => /^Portal \(electrical\): .*CHARLESTONEXAMPLE.*jurisdiction type judged against City of Charleston-example$/.test(n)), JSON.stringify(r.lookup!.notes));
  // The TYPELESS form ("Charleston-example Permit Center", as an application form prints it) is the city too.
  const p1b = { ...p1, permits: [p1.permits[0], { ...p1.permits[1], issuingAgency: { value: "Charleston-example Permit Center", sourceUrl: APP, quote: "ELECTRICAL TRADE PERMIT APPLICATION Charleston-example Permit Center 2 George St" } }] };
  // Its OWN key (state NC): over the SC row just saved, mergeWithEarlier ("a re-run never forgets a
  // cited answer") carried the electrical portal forward, so this case passed with the publisher
  // predicate killed (close-5 kill K25 stayed green). A fresh row answers only from this run.
  const rb = await ppl.runPermitProcessLookup(db, { webLookup: async (i: { label: string }) => (i.label.endsWith(".process") ? g(JSON.stringify(p1b), [PG, APP]) : g(JSON.stringify({ permits: [] }), [])) }, { state: "NC", ahj: "City of Charleston-example", dcKw: "7", acKw: "6", force: true, reader: newReader(site(pages).fetch) });
  assert.equal(saved(rb, "electrical").issuingAgency.value, "Charleston-example");
  assert.equal(saved(rb, "electrical").portalUrl.value, ACA, `typeless: the same portal (${saved(rb, "electrical").portalUrl.notFound})`);
  assert.ok((rb.lookup!.notes ?? []).some((n) => /^Portal \(electrical\): .*CHARLESTONEXAMPLE.* — from the agency page \(our read\);/.test(n)), `typeless: THIS run took the publisher's portal for the electrical permit ${JSON.stringify(rb.lookup!.notes)}`);
  const cityKey = fees.feeScheduleProfileKey({ state: "SC", ahj: "City of Charleston-example" }, "permit");
  const rows = fees.getFeeSchedulesForKey(db, cityKey, "permit");
  assert.deepEqual(rows.filter((x) => x.collectedByProfileKey).map((x) => `${x.discipline} -> ${x.collectedByProfileKey}`), [], "MUST-EXCLUDE: no phantom delegation row for the city's own fee");
  // The same through applyLookupFees on the stored Charleston shape (the live run's saved values, verbatim).
  const stored = { ...r.lookup!, ahj: "City of Charleston", state: "SC", permits: r.lookup!.permits.map((p) => ({ ...p, issuingAgency: p.discipline === "electrical" ? { ...p.issuingAgency, value: "City of Charleston Permit Center /" } : { ...p.issuingAgency, value: null } })) };
  const out = ppl.applyLookupFees(db, stored as never);
  assert.deepEqual(out.filter((x) => /delegation/.test(x.discipline)), [], JSON.stringify(out));
  assert.deepEqual(fees.getFeeSchedulesForKey(db, fees.feeScheduleProfileKey({ state: "SC", ahj: "City of Charleston" }, "permit"), "permit").filter((x) => x.collectedByProfileKey), []);
  // MUST-PASS: the Jefferson lift — Marion County issues the City of Jefferson's permits — is a delegation.
  const jefferson = { ...r.lookup!, ahj: "City of Jefferson", state: "OR", issuingAgency: { value: "Marion County", sourceUrl: "https://www.co.marion.or.us/PW/Building", quote: "Marion County Building Inspection issues permits for the City of Jefferson", origin: "lookup" as const },
    permits: r.lookup!.permits.map((p) => ({ ...p, issuingAgency: { value: "Marion County Public Works Building Inspection Division", sourceUrl: "https://www.co.marion.or.us/PW/Building", quote: "Marion County Building Inspection issues permits", origin: "lookup" as const } })) };
  const outJ = ppl.applyLookupFees(db, jefferson as never);
  assert.ok(outJ.some((x) => /delegation/.test(x.discipline) && x.saved), JSON.stringify(outJ));
  const jRows = fees.getFeeSchedulesForKey(db, fees.feeScheduleProfileKey({ state: "OR", ahj: "City of Jefferson" }, "permit"), "permit");
  assert.ok(jRows.length && jRows.every((x) => x.collectedByProfileKey === fees.feeScheduleProfileKey({ state: "OR", ahj: "Marion County Public Works Building Inspection Division" }, "permit")), JSON.stringify(jRows.map((x) => [x.discipline, x.collectedByProfileKey])));
});

await check("(m3) the merge sibling of MF1 MUST-EXCLUDE: a re-run's mergeWithEarlier ('never forgets a cited answer') neither restores a portal THIS run's door refuses outright (an older door saved the county tenant DENBYCOUNTY as the City's structural portal) nor its record type, nor carries the city's portal beside the COUNTY this run names as the electrical issuer; MUST-PASS: the same issuer and nothing found this run keeps the earlier portal and record type", async () => {
  // B: the earlier row an older door saved.
  const CITY = "https://www.cityofmergeby.example.gov"; const PG = `${CITY}/building`;
  const DC = "https://aca-prod.accela.com/MERGEBYCOUNTY/Default.aspx";
  const cited = (value: string | null, sourceUrl = PG, quote = "The City of Mergeby Building Department issues building permits") => ({ value, sourceUrl, quote, origin: "lookup" as const, ...(value ? {} : { notFound: "x" }) });
  pp.savePermitProcessLookup(db, { state: "IN", ahj: "City of Mergeby", lookedUpAt: "2026-09-01T00:00:00.000Z", issuingAgency: cited("City of Mergeby"), permitStructure: cited("separate") as never, notes: [],
    permits: [{ discipline: "structural", label: "Solar", issuingAgency: cited("City of Mergeby"), portalUrl: cited(DC, DC, "Apply online"), recordType: cited("Building Solar Photovoltaic Residential", DC, "Building Solar Photovoltaic Residential"), documents: cited(null), fee: cited(null) }] as never });
  const pages = { [PG]: { text: html(`<p>The City of Mergeby Building Department issues building permits for solar installations.</p>`) } };
  const p1 = { issuingAgency: { value: "City of Mergeby", sourceUrl: PG, quote: "The City of Mergeby Building Department issues building permits" }, permitStructure: { value: "separate", sourceUrl: PG, quote: "issues building permits" },
    permits: [{ discipline: "structural", label: "Solar", issuingAgency: { value: "City of Mergeby", sourceUrl: PG, quote: "The City of Mergeby Building Department issues building permits" }, portalUrl: { value: DC, sourceUrl: DC, quote: "Apply online" }, recordType: { value: null } }] };
  const llmOf = (x: unknown, urls: string[]) => ({ webLookup: async (i: { label: string }) => (i.label.endsWith(".process") ? g(JSON.stringify(x), urls) : g(JSON.stringify({ permits: [] }), [])) });
  const rb = await ppl.runPermitProcessLookup(db, llmOf(p1, [PG, DC]), { state: "IN", ahj: "City of Mergeby", dcKw: "7", acKw: "6", force: true, reader: newReader(site(pages).fetch) });
  const sb = saved(rb, "structural");
  assert.equal(sb.portalUrl.value, null, `the earlier row's county tenant is not restored (${sb.portalUrl.value})`);
  assert.match(String(sb.portalUrl.notFound), /earlier row's .*MERGEBYCOUNTY.*another jurisdiction's portal/, String(sb.portalUrl.notFound));
  assert.equal(sb.recordType.value, null, `nor the county tenant's record type (${sb.recordType.value})`);
  // A: the earlier row's electrical portal is the city's; this run names the COUNTY as the issuer.
  const C2 = "https://www.merge-harbor.gov"; const PG2 = `${C2}/856/Permit-Center`; const APP2 = `${C2}/DocumentCenter/View/1/Electrical`;
  const ACA2 = "https://aca-prod.accela.com/MERGEHARBOR/Default.aspx"; const CO2 = "https://www.mergeharborcounty.gov/building";
  const pages2 = { [PG2]: { text: html(`<p>Building Inspections Division for building, mechanical, electrical, plumbing and fuel-gas inspections.</p><p><a href="${ACA2}">Apply online - Customer Self Service</a></p>`, "Permit Center") },
    [CO2]: { text: html(`<p>Merge Harbor County Building Services issues electrical permits for the City of Merge Harbor.</p>`, "Building Services") } };
  const ag = (value: string, sourceUrl: string, quote: string) => ({ value, sourceUrl, quote });
  const topA = ag("City of Merge Harbor Building Inspections Division", PG2, "Building Inspections Division for building, mechanical, electrical, plumbing and fuel-gas inspections");
  const firstA = { issuingAgency: topA, permitStructure: { value: "separate", sourceUrl: PG2, quote: "A separate Electrical Trade Permit" },
    permits: [{ discipline: "structural", label: "Solar", issuingAgency: topA, portalUrl: { value: null }, recordType: { value: null } },
      { discipline: "electrical", label: "Electrical", issuingAgency: ag("City of Merge Harbor Permit Center", APP2, "ELECTRICAL TRADE PERMIT APPLICATION City of Merge Harbor Permit Center"), portalUrl: { value: null }, recordType: { value: null } }] };
  const input = { state: "SC", ahj: "City of Merge Harbor", dcKw: "7", acKw: "6", force: true };
  const r1 = await ppl.runPermitProcessLookup(db, llmOf(firstA, [PG2, APP2, CO2]), { ...input, reader: newReader(site(pages2).fetch) });
  assert.equal(saved(r1, "electrical").portalUrl.value, ACA2, "control: the city issues it -> the city's portal");
  const countyA = { ...firstA, permits: [firstA.permits[0], { ...firstA.permits[1], issuingAgency: ag("Merge Harbor County Building Services", CO2, "Merge Harbor County Building Services issues electrical permits for the City of Merge Harbor") }] };
  const r2 = await ppl.runPermitProcessLookup(db, llmOf(countyA, [PG2, APP2, CO2]), { ...input, reader: newReader(site(pages2).fetch) });
  assert.equal(saved(r2, "electrical").issuingAgency.value, "Merge Harbor County");
  assert.equal(saved(r2, "electrical").portalUrl.value, null, `the city's portal is not carried beside the county's name (${saved(r2, "electrical").portalUrl.value})`);
  // MUST-PASS: the city again, and this run's page no longer links a portal — the earlier cited answer is kept.
  const r3 = await ppl.runPermitProcessLookup(db, llmOf(firstA, [PG2, APP2, CO2]), { ...input, reader: newReader(site(pages2).fetch) });
  assert.equal(saved(r3, "electrical").portalUrl.value, ACA2, "re-established by this run (control)");
  const bare = { [PG2]: { text: html(`<p>Building Inspections Division for building, mechanical, electrical, plumbing and fuel-gas inspections.</p>`, "Permit Center") } };
  const r4 = await ppl.runPermitProcessLookup(db, llmOf(firstA, [PG2, APP2]), { ...input, reader: newReader(site(bare).fetch) });
  assert.ok(!(r4.lookup!.notes ?? []).some((n) => /^Portal \(electrical\): .*MERGEHARBOR/.test(n)), "this run did not find it itself");
  assert.equal(saved(r4, "electrical").portalUrl.value, ACA2, `the same issuer, nothing found this run: the earlier portal is KEPT (${saved(r4, "electrical").portalUrl.notFound})`);
  assert.equal(saved(r4, "structural").portalUrl.value, ACA2, "structural too");
  // C: a permit ONLY the earlier row lists (combo, the county tenant) is carried through the same door;
  // MUST-PASS: an earlier-only permit whose portal the door does not refuse outright is carried whole.
  const C3 = "https://www.cityofcombeby.example.gov"; const PG3 = `${C3}/building`;
  const CC = "https://aca-prod.accela.com/COMBEBYCOUNTY/Default.aspx"; const OWN = "https://aca-prod.accela.com/COMBEBY/Default.aspx";
  const q3 = "The City of Combeby Building Department issues building permits";
  const c3 = (value: string | null, sourceUrl = PG3, quote = q3) => ({ value, sourceUrl, quote, origin: "lookup" as const, ...(value ? {} : { notFound: "x" }) });
  pp.savePermitProcessLookup(db, { state: "IN", ahj: "City of Combeby", lookedUpAt: "2026-09-01T00:00:00.000Z", issuingAgency: c3("City of Combeby"), permitStructure: c3("combo") as never, notes: [],
    permits: [
      { discipline: "combo", label: "Solar", issuingAgency: c3("City of Combeby"), portalUrl: c3(CC, CC, "Apply online"), recordType: c3("Building Solar Photovoltaic Residential", CC, "Building Solar Photovoltaic Residential"), recordTypeCandidates: [{ label: "Building Solar Photovoltaic Residential", condition: "", sourceUrl: CC, quote: "Building Solar Photovoltaic Residential" }], documents: c3(null), fee: c3(null) },
      { discipline: "electrical", label: "Electrical", issuingAgency: c3("City of Combeby"), portalUrl: c3(OWN, OWN, "Apply online"), recordType: c3("Electrical Residential", OWN, "Electrical Residential"), documents: c3(null), fee: c3(null) },
    ] as never });
  const pages3 = { [PG3]: { text: html(`<p>${q3} for solar installations.</p>`) } };
  const p3 = { issuingAgency: { value: "City of Combeby", sourceUrl: PG3, quote: q3 }, permitStructure: { value: "separate", sourceUrl: PG3, quote: "issues building permits" },
    permits: [{ discipline: "structural", label: "Solar", issuingAgency: { value: "City of Combeby", sourceUrl: PG3, quote: q3 }, portalUrl: { value: null }, recordType: { value: null } }] };
  const rc = await ppl.runPermitProcessLookup(db, llmOf(p3, [PG3]), { state: "IN", ahj: "City of Combeby", dcKw: "7", acKw: "6", force: true, reader: newReader(site(pages3).fetch) });
  const combo = saved(rc, "combo");
  assert.ok(combo, "the earlier-only permit is still carried (never forgets)");
  assert.equal(combo.portalUrl.value, null, `its county tenant is not carried (${combo.portalUrl.value})`);
  assert.match(String(combo.portalUrl.notFound), /earlier row's .*COMBEBYCOUNTY.*another jurisdiction's portal/);
  assert.equal(combo.recordType.value, null, "nor the county tenant's record type");
  assert.equal((combo.recordTypeCandidates ?? []).length, 0, "nor its candidates");
  assert.equal(saved(rc, "electrical").portalUrl.value, OWN, "MUST-PASS: an earlier-only permit the door does not refuse is carried");
  assert.equal(saved(rc, "electrical").recordType.value, "Electrical Residential", "with its record type");
});

// ───────────────────────────── lookup-close-7: the close-6 skeptic's three residues ─────────────────────────────
await check("(r7) lookup-close-7 — R1 the record type's official arm is THIS agency's own domain (isAgencyOwnDomain), never any .gov: MUST-EXCLUDE a type cited to another town's .gov page (A1 part one, A6 the portal step) or to the STATE's page for a city-issued permit (A2); MUST-PASS the agency's own page (A3), the Camden live case (camdenmaine.gov citing 'Building' / 'Electrical Permit' beside its iWorQ tenant), and a state-issued permit's type on the state's own domain. R2 a query-tenanted instance URL with no tenant parameter is the vendor's shared site (F3 bsaonline.com/MunicipalDirectory/) while F2 (SiteSearch/Permits?uid=413) is kept. R3 the vendors' MARKETING domains are on the one list (iworq.com, bsasoftware.com, centralsquare.com, peoplegis.com, avolvesoftware.com, fullcircletech.com) and only an ACA ('aca' label) host is an accela.com instance (success.accela.com is Accela's own site) — refused through the real resolver; MUST-PASS the tenant forms", async () => {
  // ── R1 through the real lookup ──
  const rtRun = async (tag: string, rtSource: string, rtQuote: string, viaStep = false) => {
    const PG = `https://www.cityofdenby${tag}.gov/building`; const PORTAL = `https://cityofdenby${tag}.portal.opengov.com/`;
    const p1 = JSON.parse(shapeFor(`Denby${tag}`, PG, `City of Denby${tag}`, `City of Denby${tag}`, `City of Denby${tag}`));
    const rt = { value: "Residential Solar PV", sourceUrl: rtSource, quote: rtQuote };
    const portal = { value: PORTAL, sourceUrl: PG, quote: `Apply online at ${PORTAL} — online permit portal` };
    if (!viaStep) { p1.permits[0].portalUrl = portal; p1.permits[0].recordType = rt; }
    const step = viaStep ? { text: JSON.stringify({ permits: [{ discipline: "structural", portalUrl: portal, recordType: rt }] }), urls: [PG, PORTAL, rtSource] } : undefined;
    const llm = { webLookup: async (i: { label: string }) => (i.label.endsWith(".process") ? g(JSON.stringify(p1), viaStep ? [PG] : [PG, PORTAL, rtSource]) : step && i.label.includes("portal") ? g(step.text, step.urls) : g(JSON.stringify({ permits: [] }), [])) };
    const r = await ppl.runPermitProcessLookup(db, llm, { state: "IN", ahj: `City of Denby${tag}`, dcKw: "7", acKw: "6", force: true, reader: newReader(site({ [PG]: { text: html(`<p>City of Denby${tag} issues building permits for properties inside city limits. Electrical permits are issued by City of Denby${tag}.</p>`) } }).fetch) });
    return saved(r, "structural");
  };
  const a1 = await rtRun("xa", "https://www.cityofplainfieldz.gov/building-permits", "Select Residential Solar PV when applying online");
  assert.equal(a1.portalUrl.value, "https://cityofdenbyxa.portal.opengov.com/", "A1 control: the city's own portal is saved");
  assert.equal(a1.recordType.value, null, `A1: another city's .gov page is not the city's record type (${a1.recordType.value} @ ${a1.recordType.sourceUrl})`);
  const a2 = await rtRun("xb", "https://www.in.gov/dhs/fire-and-building-safety/permits/", "Residential Solar PV");
  assert.equal(a2.recordType.value, null, `A2: the STATE's page for a city-issued permit (${a2.recordType.value} @ ${a2.recordType.sourceUrl})`);
  const a6 = await rtRun("xf", "https://www.plainfieldz.gov/building-permits", "Residential Solar PV", true);
  assert.equal(a6.portalUrl.value, "https://cityofdenbyxf.portal.opengov.com/", "A6 control: the step's portal is saved");
  assert.equal(a6.recordType.value, null, `A6: the portal step's type cited to another town's .gov page (${a6.recordType.value} @ ${a6.recordType.sourceUrl})`);
  const a3 = await rtRun("xc", "https://www.cityofdenbyxc.gov/permits", "Select Residential Solar PV when applying online");
  assert.equal(a3.recordType.value, "Residential Solar PV", `A3 MUST-PASS: the agency's own page (${(a3.recordType as { notFound?: string }).notFound})`);
  // The Camden live case (lookup-close-6-v held-out, Town of Camden ME): the town's own page camdenmaine.gov names
  // the portal's permit types beside its iWorQ SUBDOMAIN tenant — the domain is the town's name + the state's name.
  {
    const DEPT = "https://www.camdenmaine.gov/departments/planning___code_enforcement/index.php";
    const IWQ = "https://camdenmepermit.portal.iworq.net/portalhome/camdenmepermit";
    const Q = "Camden Permit Portal (Permit types include Building, Certificate of Occupancy, Electrical Permit, Home Occupation, Plumbing, Site Plan Review, Subdivision Amendment";
    const p1 = {
      issuingAgency: { value: null }, permitStructure: { value: "separate", sourceUrl: DEPT, quote: Q },
      permits: [
        { discipline: "structural", label: "Building", issuingAgency: { value: null }, portalUrl: { value: IWQ, sourceUrl: DEPT, quote: `${Q} — online permit portal` }, recordType: { value: "Building", sourceUrl: DEPT, quote: Q } },
        { discipline: "electrical", label: "Electrical", issuingAgency: { value: null }, portalUrl: { value: IWQ, sourceUrl: DEPT, quote: `${Q} — online permit portal` }, recordType: { value: "Electrical Permit", sourceUrl: DEPT, quote: Q } },
      ],
    };
    const llm = { webLookup: async (i: { label: string }) => (i.label.endsWith(".process") ? g(JSON.stringify(p1), [DEPT, IWQ]) : g(JSON.stringify({ permits: [] }), [])) };
    const r = await ppl.runPermitProcessLookup(db, llm, { state: "ME", ahj: "Town of Camden", dcKw: "7", acKw: "6", force: true, reader: null });
    for (const [d, want] of [["structural", "Building"], ["electrical", "Electrical Permit"]] as const) {
      const s = saved(r, d);
      assert.equal(s.portalUrl.value, IWQ, `Camden ${d}: the iWorQ subdomain tenant (${s.portalUrl.notFound})`);
      assert.equal(s.recordType.value, want, `Camden MUST-PASS ${d}: the town's own page names the type (${(s.recordType as { notFound?: string }).notFound})`);
      assert.equal(s.recordType.sourceUrl, DEPT);
    }
  }
  // The predicate: the own-domain question on every TLD, with the name, the name + state, initials on .gov, a
  // locality .us name label, and the state's own domains only for a name that IS the state.
  const own = cat.isAgencyOwnDomain;
  for (const [h, n, st] of [["www.camdenmaine.gov", "Town of Camden", "ME"], ["www.austintexas.gov", "City of Austin", "TX"], ["www.cityofdenby.gov", "City of Denby", "IN"], ["www.boston.gov", "City of Boston", "MA"], ["www.nyc.gov", "New York City", "NY"], ["www.ci.waltham.ma.us", "City of Waltham", "MA"], ["www.co.marion.or.us", "Marion County", "OR"], ["dli.mn.gov", "Minnesota Department of Labor and Industry", "MN"], ["www.oregon.gov", "Oregon Building Codes Division", "OR"], ["www.clarkcountynv.gov", "Clark County", "NV"], ["www.cityofevanston.org", "City of Evanston", "IL"]] as const) {
    assert.equal(own(h, [n], st), true, `own domain: ${h} for ${n}`);
  }
  for (const [h, n, st] of [["www.cityofplainfieldz.gov", "City of Denby", "IN"], ["www.plainfieldz.gov", "City of Denby", "IN"], ["www.in.gov", "City of Denby", "IN"], ["www.iowa.gov", "City of Iowa City", "IA"], ["www.kansas.gov", "Kansas City", "KS"], ["www.ci.newton.ma.us", "City of Waltham", "MA"], ["www.co.marion.or.us", "Marion County", "IA"], ["www.camdenmaine.gov", "Town of Camden", "NJ"], ["www.maine.com", "Maine Electricians' Examining Board", "ME"], ["www.accela.com", "City of Accela", "CA"]] as const) {
    assert.equal(own(h, [n], st), false, `not own domain: ${h} for ${n} (${st})`);
  }
  const belongs = ppl.recordTypeBelongsToPortal;
  const ctx = { names: ["City of Denby"], typeNames: ["City of Denby"], state: "IN" };
  const OWNP = "https://cityofdenby.portal.opengov.com/";
  assert.equal(belongs({ value: "Residential Solar PV", sourceUrl: "https://www.cityofplainfieldz.gov/building-permits", quote: "Residential Solar PV" }, OWNP, ctx), false, "A1 at the predicate");
  assert.equal(belongs({ value: "Residential Solar PV", sourceUrl: "https://www.in.gov/dhs/permits/", quote: "Residential Solar PV" }, OWNP, ctx), false, "A2 at the predicate");
  assert.equal(belongs({ value: "Residential Solar PV", sourceUrl: "https://www.cityofdenby.gov/permits", quote: "Residential Solar PV" }, OWNP, ctx), true, "A3 at the predicate");
  // A state-issued permit: the state's own domain is its own page (the portal on another state host).
  const stCtx = { names: ["City of Bemidjiq", "Minnesota Department of Labor and Industry"], typeNames: ["Minnesota Department of Labor and Industry"], state: "MN" };
  assert.equal(belongs({ value: "Solar PV Electrical", sourceUrl: "https://www.dli.mn.gov/business/electrical-contractors/electrical-permits", quote: "select Solar PV Electrical" }, "https://secure.doli.state.mn.us/epermits/", stCtx), true, "MUST-PASS: the issuing state's own page");

  // ── R2 / R3 through the real resolver (the portal step cites the URL; the search returned it) ──
  const stepRun = async (ahj: string, PG: string, portal: string, portalSrc: string, quote: string, stepUrls: string[]) => {
    const p1 = JSON.parse(shapeFor(ahj.replace(/^City of /, ""), PG, ahj, ahj, ahj));
    const step = { text: JSON.stringify({ permits: [{ discipline: "structural", portalUrl: { value: portal, sourceUrl: portalSrc, quote }, recordType: { value: null } }, { discipline: "electrical", portalUrl: { value: portal, sourceUrl: portalSrc, quote }, recordType: { value: null } }] }), urls: stepUrls };
    return saved(await runCity(ahj, "IN", JSON.stringify(p1), PG, html(`<p>Building permits are issued by the ${ahj}.</p>`), step), "structural");
  };
  const vendorSites = [
    "https://bsaonline.com/MunicipalDirectory/", // F3
    "https://www.citizenserve.com/Portal/PortalController?Action=showHomePage&ctzPagePrefix=Portal_", // no installationID
    "https://www.mygovernmentonline.org/apply/", // MGO's own page, no agency / JID
    "https://www.mapsonline.net/simplicity/building_permits.php", // the shared app, no client
    "https://iworq.com/permit-software/", // G4
    "https://www.bsasoftware.com/solutions/community-development/", // G5
    "https://www.centralsquare.com/products/etrakit", // G6
    "https://success.accela.com/s/article/permits", // G2
    "https://developer.accela.com/docs/permits",
    "https://www.peoplegis.com/products",
    "https://www.avolvesoftware.com/projectdox/",
    "https://www.fullcircletech.com/permiteyes/",
    "https://help.opengov.com/hc/en-us/articles/permits", // G0 (a marketing subdomain of a hosting domain)
    "https://support.citizenserve.com/portal/", // G1
  ];
  for (const [i, u] of vendorSites.entries()) {
    const PG = `https://www.cityofvendr${i}.org/building`;
    const s = await stepRun(`City of Vendr${i}`, PG, u, u, "Apply online — online permit portal, citizen self service", [PG, u]);
    assert.equal(s.portalUrl.value, null, `${u} is the vendor's own site, not a portal (kept as ${s.portalUrl.value})`);
    assert.match(String(s.portalUrl.notFound), /vendor's own site/, `${u}: ${s.portalUrl.notFound}`);
    assert.equal(channel.isVendorRootOrMarketing(u), true, u);
  }
  const tenants = [
    "https://bsaonline.com/SiteSearch/Permits?uid=413", // F2
    "https://www.citizenserve.com/Portal/PortalController?Action=showHomePage&ctzPagePrefix=Portal_&installationID=301",
    "https://www6.citizenserve.com/Portal/PortalController?Action=showPermit&ctzPagePrefix=Portal_&installationID=211",
    "https://www.mapsonline.net/simplicity/building_permits.php?client=melrosema",
    "https://www.mapsonline.net/peopleforms/mo4/index.php?site_id=587",
    "https://www.mapsonline.net/westonma/online_permits/",
    "https://cityofvendq-energovweb.tylerhost.net/apps/selfservice#/home", // G8
    "https://salemvendq.portal.opengov.com/", // G9
    "https://aca-prod.accela.com/VENDQ/Default.aspx", // G10
    "https://aca-oregon.accela.com/VENDR/Default.aspx",
    "https://aca.oregon.accela.com/VENDS/Default.aspx",
    "https://aca3.accela.com/VENDT/Default.aspx",
    "https://camdenmepermit.portal.iworq.net/portalhome/camdenmepermit",
  ];
  for (const [i, u] of tenants.entries()) {
    const PG = `https://www.cityoftenr${i}.org/building`;
    const s = await stepRun(`City of Tenr${i}`, PG, u, PG, "Apply online for a building permit through the online permit portal", [PG, u]);
    assert.equal(s.portalUrl.value, u, `MUST-PASS: a tenant on the vendor's host is kept (${s.portalUrl.notFound})`);
    assert.equal(channel.isVendorRootOrMarketing(u), false, u);
  }
  // The one definition: 'aca' instance hosts only; a query-tenanted instance's path is no tenant.
  for (const h of ["aca-prod.accela.com", "aca-oregon.accela.com", "aca.oregon.accela.com", "aca3.accela.com", "aca.accela.com"]) assert.equal(channel.isPathTenantedHost(h), true, h);
  for (const h of ["success.accela.com", "developer.accela.com", "www.accela.com", "citizenaccess.accela.com"]) assert.equal(channel.isPathTenantedHost(h), false, h);
  assert.equal(channel.portalTenantKey("https://bsaonline.com/MunicipalDirectory/"), channel.portalTenantKey("https://bsaonline.com/"), "no uid = no tenant");
  assert.equal(channel.portalTenantKey("https://bsaonline.com/SiteSearch/Permits?uid=413"), channel.portalTenantKey("https://bsaonline.com/?uid=413"), "the uid alone names the tenant");
  assert.notEqual(channel.portalTenantKey("https://www.mapsonline.net/westonma/online_permits/"), channel.portalTenantKey("https://www.mapsonline.net/"), "a MapsOnline path tenant");
  for (const v of ["iworq.com", "bsasoftware.com", "centralsquare.com", "peoplegis.com", "avolvesoftware.com", "fullcircletech.com"]) assert.equal(channel.isVendorDomain(v), true, v);
});

if (failures) { console.error(`\n${failures} lookupDoors test(s) failed.`); process.exit(1); }
console.log("\nAll lookupDoors tests passed.");
process.exit(0);
