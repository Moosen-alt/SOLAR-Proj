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
  // quoteOnPage's own same-line rule is symmetric now: a LEADING amount stays on its line too.
  assert.equal(reader.quoteOnPage("$75 Solar Residential", amountFirst), false, "N1 at quoteOnPage");
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

if (failures) { console.error(`\n${failures} lookupDoors test(s) failed.`); process.exit(1); }
console.log("\nAll lookupDoors tests passed.");
process.exit(0);
