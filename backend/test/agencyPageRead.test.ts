// OUR OWN PAGE READ + PLATFORM CATALOGS for the per-job lookup (lookup-recall-2, 2026-09-26).
// An UNKNOWN AHJ: the lookup reads the agency's own pages itself (links included), resolves the
// application portal from them, reads the portal's public catalog for the solar record types, and
// quotes prerequisites / code editions from what it read. Saved pages only — no network.
//
// MUST-PASS / MUST-EXCLUDE, each killed mechanically (.probe/lookup-recall-2/kill.cjs):
//   K1 no vendor-link acceptance              → (r2) fails.
//   K2 own-domain link accepted without markers → (r3) fails.
//   K3 no one-hop follow                        → (r2) fails.
//   K4 candidatesOn without rule 5 / doc refusal → (r4) fails.
//   K5 no commercial / non-PV filter            → (c1) fails.
//   K6 EnerGov menu without tenant headers      → (c2) fails.
//   K7 ACA modules from anchors only            → (c3) fails.
//   K8 acceptPortal without the self-citation door → (d1) fails.
//   K9 docs/fees without the quote-on-page door → (f1) fails.
//   K10 no per-host gap                         → (p1) fails.
//   K11 contractor prerequisite without the contractor word → (n1) fails.
//   K12 lookup without the reader wiring        → (i1) fails.
//   K13 platform markers read from a page's links (no same-host rule) → (r5) fails.
//   K14 a documents/fees answer resting only on our pages read as ungrounded → (i1) fails.
//   K15 a bulleted checklist quote must be contiguous → (f2) fails. K16 any submittal guide read as a checklist → (f2) fails.
//
// Run: npx tsx backend/test/agencyPageRead.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO } from "./_isolate";
import type { WebLookupResult } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "apr-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

const db = await (await import("../src/db")).openDatabase();
const reader = await import("../src/agencyPageReader");
const cat = await import("../src/permitPlatformCatalog");
const ppl = await import("../src/permitProcessLookup");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};
const FIX = path.join(REPO, "backend", "test", "fixtures", "agency-pages");
const fixture = (f: string) => fs.readFileSync(path.join(FIX, f), "utf8");

type Served = { status?: number; contentType?: string; text?: string; finalUrl?: string; needHeaders?: string };
/** A fake transport over saved pages: url -> what the server sends. Records every request. */
function site(pages: Record<string, Served | ((h?: Record<string, string>) => Served)>) {
  const requests: Array<{ url: string; at: number; headers?: Record<string, string> }> = [];
  const fetch: import("../src/agencyPageReader").RawFetch = async (url, opts) => {
    requests.push({ url, at: Date.now(), headers: opts.headers });
    const entry = pages[url] ?? pages[url.replace(/#.*$/, "")];
    const s = typeof entry === "function" ? entry(opts.headers) : entry;
    if (!s) return { ok: false, status: 404, contentType: "text/html", finalUrl: url, reason: "HTTP 404" };
    const status = s.status ?? 200;
    const ok = status >= 200 && status < 300;
    return { ok, status, contentType: s.contentType ?? "text/html", text: s.text ?? "", bytes: new TextEncoder().encode(s.text ?? ""), finalUrl: s.finalUrl ?? url, reason: ok ? `HTTP ${status}` : `HTTP ${status} — refused` };
  };
  return { fetch, requests };
}
const newReader = (fetch: import("../src/agencyPageReader").RawFetch, minGapMs = 0) => { reader._resetPoliteness(); return reader.createPageReader({ fetch, minGapMs, maxReads: 20 }); };

const CITY = "https://www.alderbrook-or.gov";
const CENTER = `${CITY}/your-government/community-development/permit-center`;
const HUB = `${CITY}/your-government/community-development/community-development-hub`;
const PORTAL = "https://alderbrookor-energovweb.tylerhost.net/apps/SelfService#/home";

console.log("agency page read: links, portal, catalogs, doors");

await check("(r1) parseHtml: anchor words from text / title / img alt, <base> resolution, safelinks unwrapped, a frame's src is a link; menus are not page text", () => {
  const p = reader.parseHtml(fixture("agency-permit-center.html"), CENTER);
  const hub = p.links.find((l) => /Community Development Hub$/.test(l.text));
  assert.equal(hub?.href, HUB, "a relative href resolves against <base>");
  const h2 = reader.parseHtml(fixture("agency-hub.html"), HUB);
  const portal = h2.links.find((l) => /launch/i.test(l.text));
  assert.equal(portal?.href, PORTAL, "the safelinks wrapper is unwrapped to the author's target");
  assert.ok(!/Original URL/i.test(portal!.text), "the mail client's tooltip is not the page's words");
  const img = reader.parseHtml(`<a href="https://aca-prod.accela.com/CEDARCO/Default.aspx" title="eConnect Portal"><img alt="eConnect"></a>`, "https://www.cedarco.gov/dcd");
  assert.match(img.links[0].text, /eConnect Portal/);
  const frame = reader.parseHtml(fixture("aca-frame-wrapper.html"), "https://portal.example-city.gov/Permits/Default.aspx");
  assert.ok(frame.links.some((l) => /\/Permits\/Welcome\.aspx$/.test(l.href) && /frame/.test(l.text)));
  assert.ok(!/Transparency Portal/.test(p.text), "the header/nav menu is not the page's own words");
  assert.match(p.text, /1-2 business days/);
});

const resolveOn = async (pages: Record<string, Served>, start: string[]) => {
  const s = site(pages);
  const r = newReader(s.fetch);
  const read = await Promise.all(start.map((u) => r.read(u)));
  return { res: await cat.resolvePortalFromPages(r, read), requests: s.requests };
};

await check("(r2) MUST-PASS: the portal is RESOLVED from the agency's own page — its words name the portal, one hop to the own-domain page that links the vendor-hosted tenant", async () => {
  const { res } = await resolveOn({ [CENTER]: { text: fixture("agency-permit-center.html") }, [HUB]: { text: fixture("agency-hub.html") } }, [CENTER]);
  assert.ok(res, "resolved");
  assert.equal(res!.url, PORTAL);
  assert.equal(res!.platform, "energov");
  assert.equal(res!.sourceUrl, HUB, "cited to the page that links it (our read)");
  assert.match(res!.quote, /launch the Community Development Hub Portal/);
});

await check("(r3) MUST-EXCLUDE: an own-domain link named 'Online Permit Portal' is NOT a portal on its words alone — our read of it must show a platform; MUST-PASS: the same shape whose target redirects onto a platform page with ACA markers is", async () => {
  const PAGE = "https://www.birchport.gov/building";
  const bad = await resolveOn({ [PAGE]: { text: fixture("lookalike-page.html") }, "https://www.birchport.gov/online-permit-portal": { text: fixture("lookalike-target.html") } }, [PAGE]);
  assert.equal(bad.res, null, `nothing resolved (got ${bad.res?.url})`);
  const good = await resolveOn({
    [PAGE]: { text: fixture("lookalike-page.html") },
    "https://www.birchport.gov/online-permit-portal": { text: fixture("aca-frame-wrapper.html"), finalUrl: "https://portal.birchport.gov/Permits/Default.aspx" },
  }, [PAGE]);
  assert.equal(good.res?.url, "https://portal.birchport.gov/Permits/Default.aspx");
  assert.equal(good.res?.platform, "accela", "platform by the page's own markers, not its host");
});

await check("(r4) MUST-EXCLUDE: look-alikes never resolve and are never even read — a utility interconnection portal, a help/guide page, a transparency portal, a PDF, a video", async () => {
  const PAGE = "https://www.birchport.gov/building";
  const { res, requests } = await resolveOn({ [PAGE]: { text: fixture("lookalike-page.html") } }, [PAGE]);
  assert.equal(res, null);
  const read = requests.map((r) => r.url);
  for (const never of ["powerclerk", "/help/", "transparency", ".pdf", "youtu"]) assert.ok(!read.some((u) => u.includes(never)), `never read: ${never} (${read.join(", ")})`);
  const { res: r2 } = await resolveOn({ [CENTER]: { text: fixture("agency-permit-center.html") } }, [CENTER]);
  assert.ok(!r2 || !/powerclerk|youtu|help/.test(r2.url), `no look-alike from the city page (${r2?.url})`);
});

await check("(r5) MUST-EXCLUDE: an own-domain page that merely LINKS a platform (an ACA record search, an eConnect link) is not itself the platform — the vendor tenant it links is the portal", async () => {
  const PAGE = "https://www.cedarco.gov/dcd";
  const ONLINE = "https://www.cedarco.gov/dcd/online-permitting";
  const { res } = await resolveOn({
    [PAGE]: { text: `<main><a href="${ONLINE}">Online Permit Portal</a></main>` },
    [ONLINE]: { text: fixture("links-to-aca.html") },
  }, [PAGE]);
  assert.ok(res, "resolved");
  assert.equal(res!.url, "https://aca-prod.accela.com/CEDARCO/Default.aspx", `the vendor tenant, not the page linking it (${res!.url})`);
  assert.equal(cat.detectPlatform({ ...reader.parseHtml(fixture("links-to-aca.html"), ONLINE), ok: true, finalUrl: ONLINE }), null, "its markers are its own, not its links'");
});

await check("(c1) MUST-PASS/EXCLUDE: the EnerGov public menu -> the RESIDENTIAL solar types in the portal's own labels, each with its condition; commercial / non-PV types are not candidates; the plan path picks, else the operator is asked", () => {
  const types = cat.parseEnerGovMenu(JSON.parse(fixture("energov-menu.json")));
  assert.ok(types.length >= 5);
  const cands = cat.solarRecordTypeCandidates({ platform: "energov", sourceUrl: "https://x.tylerhost.net/apps/SelfService/api/Home/Menu", types });
  assert.deepEqual(cands.map((c) => c.label).sort(), ["Residential Renewable Energy - Non Prescriptive", "Residential Renewable Energy - Prescriptive"]);
  assert.equal(cands.find((c) => /Non/.test(c.label))!.path, "engineered");
  assert.equal(cands.find((c) => !/Non/.test(c.label))!.path, "prescriptive");
  assert.equal(cat.chooseRecordType(cands, "prescriptive").chosen?.label, "Residential Renewable Energy - Prescriptive");
  assert.equal(cat.chooseRecordType(cands, "engineered").chosen?.label, "Residential Renewable Energy - Non Prescriptive");
  const unsure = cat.chooseRecordType(cands, "unknown");
  assert.equal(unsure.chosen, null);
  assert.match(unsure.question, /Prescriptive.*Non Prescriptive|Non Prescriptive.*Prescriptive/);
  // SolarAPP+ vs standard: both returned, SolarAPP+ tagged by its condition.
  const sa = cat.solarRecordTypeCandidates({ platform: "energov", sourceUrl: "u", types: [
    { label: "BLDG Solar APP+ Permit (Residential < 38.4 Kwh)", description: "CONTRACTORS ONLY.", category: "Building" },
    { label: "BLDG Residential – Solar/Photovoltaic", description: "Installing solar/photovoltaic/battery systems on residential property.", category: "Building" },
    { label: "BLDG Commercial – Solar/Photovoltaic", description: "", category: "Building" },
    { label: "Solar Pool Heater", description: "", category: "Building" },
    { label: "Residential Deck", description: "", category: "Building" },
  ] });
  assert.deepEqual(sa.map((c) => c.path).sort(), ["solarapp", "standard"]);
});

await check("(c2) MUST-PASS: the EnerGov catalog is read with the tenant headers the portal's own page sends (without them the public menu answers nothing)", async () => {
  const base = "https://alderbrookor-energovweb.tylerhost.net/apps/SelfService";
  const s = site({
    [`${base}/api/Home/GetTenants`]: { contentType: "application/json", text: JSON.stringify({ Result: [{ TenantID: 1, TenantName: "Community Development Hub", TenantUrl: "home" }] }) },
    [`${base}/api/Home/Menu`]: (h) => (h?.tenantId === "1" && h?.tenantName === "Community Development Hub"
      ? { contentType: "application/json", text: fixture("energov-menu.json") }
      : { contentType: "application/json", text: JSON.stringify({ Result: null, Success: false, ErrorMessage: "Object reference not set to an instance of an object." }) }),
  });
  const c = await cat.readEnerGovCatalog(newReader(s.fetch), PORTAL);
  assert.ok(c && c.types.length >= 5, `types read (${c?.problem})`);
  assert.equal(c!.sourceUrl, `${base}/api/Home/Menu`);
});

await check("(c3) MUST-PASS: ACA — the module is found in the tab bar's SCRIPT data (not an anchor), and the public search form's record types are read in the portal's labels", async () => {
  const entry = "https://aca-prod.accela.com/CEDARCO/Default.aspx";
  const s = site({ [entry]: { text: fixture("aca-default.html") }, "https://aca-prod.accela.com/CEDARCO/Cap/CapHome.aspx?module=Permitting&TabName=Home": { text: fixture("aca-caphome.html") } });
  const c = await cat.readAccelaCatalog(newReader(s.fetch), entry);
  assert.ok(c && c.types.some((t) => t.label === "Solar" && t.value === "Permitting/Solar/NA/NA"), `types (${c?.problem})`);
  const cands = cat.solarRecordTypeCandidates(c!);
  assert.deepEqual(cands.map((x) => x.label), ["Solar"], "commercial, pool-heater and revision types are not the job's");
  assert.equal(cat.chooseRecordType(cands, undefined).chosen?.label, "Solar");
});

await check("(d1) MUST-PASS: a platform page citing ITSELF with its menu words is kept when OUR READ shows its markers; MUST-EXCLUDE: without that read, and never a utility portal or a help page even so", () => {
  const url = "https://portal.example-city.gov/Permits/Default.aspx";
  const raw = { value: url, sourceUrl: url, quote: "Building Application Engineering Application Right-of-Way Permit Utilities Permit Zoning Application" };
  assert.equal(ppl.acceptPortal(raw, [url]).value, null, "the model's quote alone does not state a portal");
  assert.equal(ppl.acceptPortal(raw, [url], [url]).value, url, "our read of the page attests what it is");
  const util = "https://city-energy.powerclerk.com/MvcProjects";
  assert.equal(ppl.acceptPortal({ value: util, sourceUrl: util, quote: "Create a new project" }, [util], [util]).value, null, "rule 5: never a utility portal");
  const help = "https://portal.example-city.gov/help/how-to-apply";
  assert.equal(ppl.acceptPortal({ value: help, sourceUrl: help, quote: "How to apply" }, [help], [help]).value, null, "never a help page");
  const other = "https://aca-prod.accela.com/OTHERCO/Default.aspx";
  assert.equal(ppl.acceptPortal({ value: other, sourceUrl: other, quote: "Welcome" }, [other], ["https://aca-prod.accela.com/CEDARCO/Default.aspx"]).value, null, "another tenant on a shared host is not attested");
});

await check("(f1) MUST-PASS/EXCLUDE: a fee cited to a page WE READ is kept only when its words are on that page and every amount is printed; a paraphrase or a computed amount is refused", () => {
  const FEES = "https://www.alderbrook-or.gov/home/showpublisheddocument/27129/639";
  const texts = new Map([[ppl.pageKey(FEES), fixture("fee-schedule.txt")]]);
  const answer = (quote: string, amount: number) => JSON.stringify({ permits: [{ discipline: "combo", documents: { value: null }, fee: { value: { amountUsd: amount, basis: "flat per permit", lines: [{ label: "Solar - SolarApp+ Residential", amountUsd: amount }] }, sourceUrl: FEES, quote } }] });
  const on = ppl.parseDocsFeesPart(answer("1048 Solar - SolarApp+ Residential per permit [1] $ 199", 199), [FEES], "end_turn", texts).byDiscipline.get("combo")!.fee;
  assert.equal(on.value?.amountUsd, 199, `kept (${on.notFound})`);
  const para = ppl.parseDocsFeesPart(answer("SolarAPP+ residential permits cost $199 per permit", 199), [FEES], "end_turn", texts).byDiscipline.get("combo")!.fee;
  assert.equal(para.value, null, "a paraphrase is not on the page");
  assert.match(String(para.notFound), /not on the fee's source page/);
  const computed = ppl.parseDocsFeesPart(answer("1049 Solar - Residential (Up to 15 kW) per permit [2],[4] $ 312", 333), [FEES], "end_turn", texts).byDiscipline.get("combo")!.fee;
  assert.equal(computed.value, null, "an amount the quote does not print is refused");
});

await check("(f2) a checklist quoted item by item is on the page though a PDF interleaves other words between items; an item the page does not print is not; only a SOLAR checklist is read as one", () => {
  const pdfText = "Residential permit application (B-1), signed and dated by the contractor or property owner  info\nProperty owner consent form if application filed by contractor (B-13A)\nBuilding Plans (three sets):\nSite Plan  info\nRoof Plan  info";
  assert.ok(reader.quoteOnPage("☐ Residential permit application (B-1), signed and dated by the contractor or property owner ☐ Property owner consent form if application filed by contractor (B-13A) • Site Plan • Roof Plan", pdfText));
  assert.ok(!reader.quoteOnPage("☐ Residential permit application (B-1) ☐ Structural calculations stamped by an engineer", pdfText), "an item not on the page");
  assert.equal(cat.classifyDocument("Deck Submittal Guide", "https://www.x.gov/home/showpublisheddocument/14/1"), null);
  assert.equal(cat.classifyDocument("Solar PV Submittal Checklist", "https://www.x.gov/home/showpublisheddocument/99/1"), "checklist");
  assert.equal(cat.classifyDocument("Master Fee Schedule", "https://www.x.gov/fees"), "fees");
});

await check("(p1) politeness: one host is read >= the gap apart, other hosts are not held up; a refusal backs the host off (never asked again within the back-off hour); a sign-in URL is never fetched and a redirect onto one is not read", async () => {
  const s = site({
    "https://a.example.gov/1": { text: "<p>one</p>" }, "https://a.example.gov/2": { text: "<p>two</p>" }, "https://b.example.gov/1": { text: "<p>b</p>" },
    "https://c.example.gov/1": { status: 403 }, "https://c.example.gov/2": { text: "<p>c2</p>" },
    "https://d.example.gov/start": { text: "<p>x</p>", finalUrl: "https://d.example.gov/Account/Login.aspx?ReturnUrl=%2f" },
  });
  const r = newReader(s.fetch, 300);
  await Promise.all([r.read("https://a.example.gov/1"), r.read("https://a.example.gov/2"), r.read("https://b.example.gov/1")]);
  const a = s.requests.filter((q) => q.url.startsWith("https://a.")).map((q) => q.at);
  assert.ok(a[1] - a[0] >= 290, `same host ${a[1] - a[0]} ms apart`);
  const b = s.requests.find((q) => q.url.startsWith("https://b."))!.at;
  assert.ok(b - a[0] < 200, "another host is not queued behind it");
  assert.equal((await r.read("https://c.example.gov/1")).ok, false);
  const c2 = await r.read("https://c.example.gov/2");
  assert.equal(c2.ok, false);
  assert.match(c2.reason, /backed off/);
  assert.ok(!s.requests.some((q) => q.url === "https://c.example.gov/2"), "never asked again");
  const login = await r.read("https://e.example.gov/Account/Login.aspx");
  assert.equal(login.ok, false);
  assert.ok(!s.requests.some((q) => q.url.includes("e.example.gov")), "a sign-in page is never fetched");
  assert.equal((await r.read("https://d.example.gov/start")).ok, false, "a page that lands on a sign-in page is not read");
  assert.ok(reader.isLoginUrl("https://identity.tylerportico.com/oauth2/default/v1/authorize?client_id=x"));
});

await check("(n1) prerequisites and codes quoted from a page we read: account approval with its lead time, a contractor licence/registration the application needs, the adopted editions — never a pet licence", () => {
  const p = reader.parseHtml(fixture("agency-permit-center.html"), CENTER);
  const page = { ok: true, finalUrl: CENTER, text: p.text };
  const pre = cat.extractPrerequisites(page);
  const acct = pre.find((x) => x.kind === "Portal account approval");
  assert.ok(acct, "account approval found");
  assert.match(acct!.value, /1-2 business days/);
  assert.ok(pre.some((x) => x.kind === "Contractor licence / registration" && /contractor licensed/.test(x.quote)));
  assert.ok(!pre.some((x) => /pet|dog/i.test(x.quote)), `no pet licence (${pre.map((x) => x.quote).join(" | ")})`);
  const codes = cat.extractCodeEditions(page);
  assert.deepEqual(codes?.editions.sort(), ["2021 International Residential Code", "2023 National Electrical Code"]);
});

// ── lookup-recall-2-close (the skeptic's BROKEN verdict, 2026-09-26) ─────────────────────
// Real agency pages saved once (scripts / styles / unused attributes stripped): Waltham's
// Applications page (paper-only; its one vendor link is iWorQ "Report a Concern"), Scottsdale's
// Permit Services page (SPUR on tylerhost), Carlsbad's SolarAPP page, Iowa City's Building
// Inspection page, Lee County's DCD page, Waltham's Electrical Permit Fees table.
const resolveNamed = async (pages: Record<string, Served>, start: string[], names: string[]) => {
  const s = site(pages);
  const r = newReader(s.fetch);
  const read = await Promise.all(start.map((u) => r.read(u)));
  return { res: await cat.resolvePortalFromPages(r, read, { names }), requests: s.requests };
};
const synthetic = (body: string) => `<html><head><title>Building</title></head><body><main>${body}</main></body></html>`;

await check("(m1) MUST-EXCLUDE (close MF1/MF2): a vendor link is not the portal on its host alone — Waltham's paper-only page with a 'Report a Concern' iWorQ link, a 'Powered by Accela' footer, OpenGov marketing, a 311 request portal, a parcel viewer, SolarAPP+'s root, another township's tenant, a county page listing its cities' tenants", async () => {
  const W = "https://www.city.waltham.ma.us/1289/Applications";
  const waltham = await resolveNamed({ [W]: { text: fixture("waltham-applications.html") } }, [W], ["Waltham City", "City of Waltham"]);
  assert.equal(waltham.res, null, `Waltham: no portal (got ${waltham.res?.url} ${waltham.res?.quote})`);
  const CITY_PAGE = "https://www.examplecity.gov/building";
  const shapes: Array<[string, string]> = [
    ["Powered by Accela", `<p>Solar permits must be dropped off in person at City Hall.</p><div><a href="https://www.accela.com/">Powered by Accela</a></div>`],
    ["OpenGov marketing", `<a href="https://www.opengov.com/">OpenGov</a>`],
    ["311 request portal", `<p>Applications must be dropped off.</p><a href="https://user.govoutreach.com/examplecity/support.php?cmd=shell">Citizen Request Portal</a>`],
    ["parcel viewer", `<a href="https://www.mapsonline.net/examplecity/index.html">Online Property Viewer</a>`],
    ["SolarAPP+ root", `<p>Email your application.</p><a href="https://gosolarapp.org/">SolarAPP+</a>`],
    ["another township's tenant", `<a href="https://othertownship.portal.iworq.net/OTHERTOWNSHIP/permits/600">Other Township online permit portal</a>`],
    ["concern form on the city's own tenant", `<a href="https://examplecity.portal.iworq.net/portalhome/examplecity">Report a Concern</a>`],
    // One door each (a kill of any one door turns its shape green):
    ["the city's own tenant, words and target naming no portal", `<a href="https://examplecity.portal.iworq.net/portalhome/examplecity">Examplecity eNotices</a>`],
    ["a complaint module on the city's own ACA tenant", `<a href="https://aca-prod.accela.com/EXAMPLECITY/Cap/CapHome.aspx?module=Enforcement">Report a Concern</a>`],
    ["the vendor's root, named like a portal", `<a href="https://www.accela.com/">Accela Citizen Access</a>`],
    ["a shared host with no tenant", `<a href="https://aca-prod.accela.com/">Citizen Access portal</a>`],
    ["a 311 CRM named like self-service", `<a href="https://user.govoutreach.com/examplecity/support.php">Citizen Self Service</a>`],
    ["SolarAPP+ (an approval, not the city's portal)", `<a href="https://app.gosolarapp.org/examplecity/apply">Apply online with SolarAPP+</a>`],
    // Caught by the WORDS alone (the tenant is the city's, the target path names the portal):
    ["a 311 request portal on the city's own OpenGov tenant", `<a href="https://examplecity.portal.opengov.com/">Citizen Request Portal (311)</a>`],
    ["the assessor's parcel search on the city's own ACA tenant", `<a href="https://aca-prod.accela.com/EXAMPLECITY/Cap/CapHome.aspx?module=Building">Assessor Parcel Search</a>`],
    ["county page listing its cities' tenants",`<h2>Inside a city? Apply with your city</h2><ul><li><a href="https://aca-prod.accela.com/CITYA/Default.aspx">City A permit portal</a></li><li><a href="https://aca-prod.accela.com/CITYB/Default.aspx">City B permit portal</a></li></ul><h2>Unincorporated</h2><p><a href="https://aca-prod.accela.com/COUNTYX/Default.aspx">Apply online - County permit portal</a></p>`],
  ];
  for (const [what, body] of shapes) {
    for (const names of [["City of Examplecity"], []]) {
      const { res } = await resolveNamed({ [CITY_PAGE]: { text: synthetic(body) } }, [CITY_PAGE], names);
      assert.equal(res, null, `${what} (names ${JSON.stringify(names)}): no portal (got ${res?.url})`);
    }
  }
});

await check("(m2) MUST-PASS: the portal from the agency's own page — Scottsdale SPUR (EnerGov on tylerhost, named by its target and tenant), Lee's eConnect (ACA tenant LEECO), Carlsbad's CSS and Iowa City's portal (own-domain link, read), Columbus's portal (own-domain frame, read), a unique unnamed tenant, and a tenant our read shows is this agency's", async () => {
  const S = "https://www.scottsdaleaz.gov/planning-development/permit-services";
  const sc = await resolveNamed({ [S]: { text: fixture("scottsdale-permit-services.html") } }, [S], ["City of Scottsdale"]);
  assert.equal(sc.res?.url, "https://cityofscottsdaleaz-energovweb.tylerhost.net/apps/selfservice#/home", `Scottsdale (${sc.res?.url})`);
  assert.equal(sc.res?.platform, "energov");
  const L = "https://www.leegov.com/dcd";
  const lee = await resolveNamed({ [L]: { text: fixture("lee-dcd.html") } }, [L], ["Lee County"]);
  assert.equal(lee.res?.url, "https://aca-prod.accela.com/LEECO/Default.aspx", `Lee (${lee.res?.url})`);
  const C = "https://www.carlsbadca.gov/departments/community-development/building/solarapp";
  const carlsbad = await resolveNamed({ [C]: { text: fixture("carlsbad-solarapp.html") }, "https://eg.carlsbadca.gov/EnerGov_Prod/selfservice/CarlsbadCAProd": { text: fixture("energov-css-shell.html") } }, [C], ["City of Carlsbad"]);
  assert.equal(carlsbad.res?.url, "https://eg.carlsbadca.gov/EnerGov_Prod/selfservice/CarlsbadCAProd#/home", `Carlsbad (${carlsbad.res?.url})`);
  assert.equal(carlsbad.res?.platform, "energov");
  const I = "https://www.icgov.org/business/building-inspection-services";
  const ic = await resolveNamed({ [I]: { text: fixture("iowacity-building.html") }, "https://www.icgov.org/business/business-permit-portal": { text: fixture("energov-css-shell.html"), finalUrl: "https://egov.iowa-city.org/energovprod/selfservice" } }, [I], ["Iowa City"]);
  assert.equal(ic.res?.url, "https://egov.iowa-city.org/energovprod/selfservice", `Iowa City (${ic.res?.url})`);
  const CO = "https://www.columbus.gov/Business-Development/Building-Zoning-Services/Frequently-Asked-Questions";
  const CAP = "https://www.columbus.gov/Business-Development/Citizen-Access-Portal";
  const col = await resolveNamed({ [CO]: { text: synthetic(`<p>Apply through the <a href="${CAP}">Citizen Access Portal</a>.</p>`) }, [CAP]: { text: fixture("aca-frame-wrapper.html"), finalUrl: "https://portal.columbus.gov/Permits/Default.aspx" } }, [CO], ["City of Columbus"]);
  assert.equal(col.res?.url, "https://portal.columbus.gov/Permits/Default.aspx", `Columbus (${col.res?.url})`);
  assert.equal(col.res?.platform, "accela");
  const SD = "https://www.sandiegocounty.gov/pds/bldg";
  const unique = await resolveNamed({ [SD]: { text: synthetic(`<p><a href="https://aca-prod.accela.com/SANDAG/Default.aspx">Apply online</a> for building permits.</p>`) } }, [SD], ["County of San Diego"]);
  assert.equal(unique.res?.url, "https://aca-prod.accela.com/SANDAG/Default.aspx", "the only tenant the page links as its portal");
  assert.equal(cat.tenantNamesAgency("https://aca-prod.accela.com/SANDAG/Default.aspx", ["County of San Diego"]), false, "a 3-letter key never names a longer tenant");
  assert.equal(cat.tenantNamesAgency("https://aca-prod.accela.com/LEECO/Default.aspx", ["Lee County"]), true);
  const TWO = "https://www.examplecity.gov/building";
  const aca = (agency: string) => `<html><head><title>Accela Citizen Access</title></head><body><main><h1>${agency} Online Permits</h1><p>Welcome to the ${agency} permit portal.</p></main></body></html>`;
  const read = await resolveNamed({
    [TWO]: { text: synthetic(`<a href="https://aca-prod.accela.com/ABC/Default.aspx">Permit portal</a> <a href="https://aca-prod.accela.com/XYZ/Default.aspx">Permit portal (new)</a>`) },
    "https://aca-prod.accela.com/ABC/Default.aspx": { text: aca("City of Othertown") },
    "https://aca-prod.accela.com/XYZ/Default.aspx": { text: aca("City of Examplecity") },
  }, [TWO], ["City of Examplecity"]);
  assert.equal(read.res?.url, "https://aca-prod.accela.com/XYZ/Default.aspx", `the tenant whose page names this agency (${read.res?.url})`);
  assert.equal(read.res?.via, "vendor link (tenant read)");
});

await check("(o1) isOfficialAgencyHost (close F2): .gov / a US locality .us / the agency's own domain are official; a directory, a code publisher, a vendor, an ISP, another borough's site are not", () => {
  const pass: Array<[string, string[]]> = [["www.icgov.org", ["Iowa City"]], ["www.leegov.com", ["Lee County"]], ["www.city.waltham.ma.us", ["Waltham City"]], ["www.santafecountynm.gov", ["Santa Fe County"]],
    ["www.cityofevanston.org", ["City of Evanston"]], ["www.tigard-or.gov", ["City of Tigard"]], ["www.clarkcountynv.gov", ["Clark County"]], ["www.co.marion.or.us", ["Marion County"]], ["www.cityofvenus.org", ["Town of Venus"]]];
  for (const [h, n] of pass) assert.equal(cat.isOfficialAgencyHost(h, n), true, `official: ${h}`);
  const fail: Array<[string, string[]]> = [["www.countyoffice.org", ["Examplecity"]], ["codepublishing.com", ["Examplecity"]], ["www.citybizlist.com", ["Examplecity"]], ["www.cityfeet.com", ["Examplecity"]],
    ["www.govpilot.com", ["Examplecity"]], ["comcast.com", ["Examplecity"]], ["library.municode.com", ["Examplecity"]], ["www.pattonboro.com", ["Northern Cambria Borough"]], ["public.mygov.us", ["Town of Venus"]],
    ["www.solarreviews.com", ["Examplecity"]], ["www.waltham-news.com", ["Waltham City"]], ["www.govoutreach.com", ["Examplecity"]]];
  for (const [h, n] of fail) assert.equal(cat.isOfficialAgencyHost(h, n), false, `not official: ${h}`);
  // The state: another state's same-named place is not this agency; initials after "cityof".
  assert.equal(cat.isOfficialAgencyHost("www.leecova.org", ["Lee County"], "FL"), false, "Lee County, Virginia is not Lee County, Florida");
  assert.equal(cat.isOfficialAgencyHost("www.leegov.com", ["Lee County"], "FL"), true);
  assert.equal(cat.isOfficialAgencyHost("www.clarkcountynv.gov", ["Clark County"], "NV"), true);
  assert.equal(cat.isOfficialAgencyHost("www.co.marion.or.us", ["Marion County"], "IA"), false, "another state's locality domain");
  assert.equal(cat.isOfficialAgencyHost("www.cityofgp.com", ["City of Grand Prairie"], "TX"), true, "initials after cityof");
  assert.equal(cat.isOfficialAgencyHost("www.gp.com", ["City of Grand Prairie"], "TX"), false, "bare initials name nobody");
  assert.equal(cat.isOfficialAgencyHost("www.gpco.com", ["City of Grand Prairie"], "TX"), false, "initials after a non-official affix name nobody");
  assert.equal(cat.isOfficialAgencyHost("tigard.prod.govaccess.org", ["City of Tigard"], "OR"), false, "a CMS vendor's staging host");
});

await check("(c4) MUST-EXCLUDE (close F3): record-type look-alikes are not PV — solar hot water, a solar screen, remove-and-reinstall, panel removal, a wind turbine, a pool heater; MUST-PASS: the PV types beside them", () => {
  const C = (labels: string[]) => ({ platform: "energov" as const, sourceUrl: "https://x-energovweb.tylerhost.net/apps/selfservice/api/Home/Menu", types: labels.map((l) => ({ label: l, description: "", category: "Building" })) });
  for (const l of ["Residential Solar Hot Water", "Solar Water Heating", "Solar Screen Installation", "Residential Solar - Remove and Reinstall", "Residential Solar Panel Removal", "Residential Renewable Energy - Wind Turbine", "Solar Pool Heater"]) {
    assert.deepEqual(cat.solarRecordTypeCandidates(C([l, "Residential Deck"])).map((c) => c.label), [], `not PV: ${l}`);
  }
  const pv = ["Residential Solar", "Residential Electrical - Solar", "PV Solar", "BLDG Residential – Solar/Photovoltaic", "BLDG Solar APP+ Permit (Residential < 38.4 Kwh)", "Residential Renewable Energy - Prescriptive", "Residential Photovoltaic/Battery System"];
  for (const l of pv) assert.deepEqual(cat.solarRecordTypeCandidates(C([l, "Residential Solar Hot Water", "Residential Solar - Remove and Reinstall"])).map((c) => c.label), [l], `PV: ${l}`);
});

await check("(c5) MUST-PASS (close F5): with 2+ candidates and no deciding plan path, a CITED record type naming one candidate chooses it; MUST-EXCLUDE: one naming none (or several) leaves the operator question", () => {
  const catalog = { platform: "energov" as const, sourceUrl: "https://eg.example.gov/selfservice/api/Home/Menu", types: [
    { label: "BLDG Solar APP+ Permit (Residential < 38.4 Kwh)", description: "", category: "Building" },
    { label: "BLDG Residential – Solar/Photovoltaic", description: "", category: "Building" },
  ] };
  const named = ppl.recordTypeFromCatalog(catalog, "combo", undefined, "Residential – Solar/Photovoltaic");
  assert.equal(named.recordType?.value, "BLDG Residential – Solar/Photovoltaic", `chosen (${named.recordType?.notFound})`);
  assert.equal(named.question, "");
  const none = ppl.recordTypeFromCatalog(catalog, "combo", undefined, "Residential Deck");
  assert.equal(none.recordType?.value, null);
  assert.match(none.question, /Which record type/);
  const both = ppl.recordTypeFromCatalog(catalog, "combo", undefined, "BLDG");
  assert.equal(both.recordType?.value, null, "a word both labels carry names neither");
});

await check("(f3) fee sources (close F4): an archived / prior-year / superseded schedule or another permit kind's is not this job's; the current year's solar / building schedule ranks first; a year inside a document id is not a year", () => {
  assert.equal(cat.classifyDocument("2019 Fee Schedule (archived)", "https://www.x.gov/DocumentCenter/View/1/2019-fee-schedule"), null);
  assert.equal(cat.classifyDocument("Fee Schedule FY 2023-24", "https://www.x.gov/fees"), null, "a prior fiscal year");
  assert.equal(cat.classifyDocument("Superseded Master Fee Schedule", "https://www.x.gov/fees"), null);
  assert.equal(cat.classifyDocument("Trench Permit Fee Schedule", "https://www.city.waltham.ma.us/1307/Trench-Permit-Fee-Schedule"), null);
  assert.equal(cat.classifyDocument("Right-of-Way Permit Fees", "https://www.x.gov/row-fees"), null);
  assert.equal(cat.classifyDocument("Master Fee Schedule FY2026", "https://www.x.gov/DocumentCenter/View/2"), "fees");
  assert.equal(cat.classifyDocument("Permit Fees", "https://www.x.gov/DocumentCenter/View/2019/Permit-Fees"), "fees", "/View/2019/ is an id");
  assert.equal(cat.classifyDocument("Building Permit Fee Schedule FY 2026-27", "https://www.x.gov/x.pdf"), "fees");
  assert.deepEqual(cat.yearsNamed("Master Fee Schedule FY 2026-27 (PDF)", "https://www.x.gov/home/showpublisheddocument/27129/639"), [2027]);
  assert.deepEqual(cat.yearsNamed("", "https://www.scottsdaleaz.gov/docs/fees-fy25-26/permit-fee-schedule---miscellaneous.pdf"), [2026]);
  assert.equal(cat.staleOrOtherFeeSource("", "https://www.pattonboro.com/wp-content/uploads/2017/01/2018-Building-Permit-Fee-Schedule.pdf", 2026), "a prior-year schedule (2018)");
  assert.equal(cat.staleOrOtherFeeSource("", "https://www.x.gov/wp-content/uploads/2018/01/2018-Building-Permit-Application.pdf", 2026), null, "an application form's year does not date a schedule");
  const P = "https://www.x.gov/building";
  const pg = { url: P, finalUrl: P, ok: true, status: 200, kind: "html" as const, reason: "", ...reader.parseHtml(synthetic(`<a href="/master-fees.pdf">Master Fee Schedule</a> <a href="/solar-fees-fy2027.pdf">Solar Permit Fee Schedule FY 2026-27</a> <a href="/fees-2019.pdf">2019 Fee Schedule</a>`), P) };
  assert.deepEqual(cat.documentLinks([pg], ["Examplecity"]).map((d) => d.text), ["Solar Permit Fee Schedule FY 2026-27", "Master Fee Schedule"]);
});

await check("(f4) MUST-PASS (close F4): Waltham's '$50 Solar Installation' — a table row whose words and amount are in different cells — is on the page; MUST-EXCLUDE: an amount another row prints, an unprinted amount, and prose words spread across a sentence", () => {
  const F = "https://www.city.waltham.ma.us/2102/Electrical-Permit-Fees";
  const p = reader.parseHtml(fixture("waltham-electrical-fees.html"), F);
  assert.ok(reader.quoteOnPage("Residential ... Solar Installation $50", p.text), "the quoted row is on the page");
  assert.ok(reader.quoteOnPage("Solar Installation | $50", p.text));
  assert.ok(!reader.quoteOnPage("Solar Installation $25", p.text), "$25 is another row's amount");
  assert.ok(!reader.quoteOnPage("Solar Installation $75", p.text), "$75 is printed nowhere on that row");
  assert.ok(reader.quoteOnPage("Solar Installation $50", "Electrical\nSolar Installation  Residential  $50\nService  $75"), "a PDF row's columns apart");
  const multi = "Miscellaneous\nSolar Residential  $168  Solar Commercial  $331  Solar Water Heaters  $90";
  assert.ok(!reader.quoteOnPage("Solar Residential $331", multi), "a multi-fee row: $331 belongs to Solar Commercial, not to Solar Residential");
  assert.ok(reader.quoteOnPage("Solar Commercial $331", multi));
  assert.ok(reader.quoteOnPage("Solar Residential $168", multi));
  assert.ok(!reader.quoteOnPage("site plan required", "A site plan showing the array location and setbacks is required for review."), "prose is never loosened");
  const texts = new Map([[ppl.pageKey(F), p.text]]);
  const ans = JSON.stringify({ permits: [{ discipline: "electrical", documents: { value: null }, fee: { value: { amountUsd: 50, basis: "flat", lines: [{ label: "Solar Installation", amountUsd: 50 }] }, sourceUrl: F, quote: "Residential ... Solar Installation $50" } }] });
  const fee = ppl.parseDocsFeesPart(ans, [F], "end_turn", texts).byDiscipline.get("electrical")!.fee;
  assert.equal(fee.value?.amountUsd, 50, `kept (${fee.notFound})`);
});

await check("(f5) MUST-EXCLUDE (close F4): a fee cited to a schedule that is GONE now (404 when read), to an archived / prior-year schedule, or to another permit kind's schedule is not kept; MUST-PASS: the same fee cited to a current page is", () => {
  const ans = (url: string) => JSON.stringify({ permits: [{ discipline: "combo", documents: { value: null }, fee: { value: { amountUsd: 168, basis: "flat", lines: [{ label: "Solar Residential", amountUsd: 168 }] }, sourceUrl: url, quote: "Solar Residential · $168 · Solar Commercial · $331" } }] });
  const GONE = "https://www.scottsdaleaz.gov/docs/fees-fy25-26/permit-fee-schedule---miscellaneous.pdf?sfvrsn=8c6543cc_4";
  const fee = (url: string, gone: string[] = []) => ppl.parseDocsFeesPart(ans(url), [url], "end_turn", new Map(), gone).byDiscipline.get("combo")!.fee;
  assert.equal(fee(GONE, [ppl.pageKey(GONE)]).value, null, "gone");
  assert.match(String(fee(GONE, [ppl.pageKey(GONE)]).notFound), /no longer there/);
  assert.equal(fee("https://www.x.gov/files/2019-fee-schedule-archived.pdf").value, null, "archived");
  assert.equal(fee("https://www.x.gov/1307/Trench-Permit-Fee-Schedule").value, null, "another kind");
  assert.equal(fee(GONE).value?.amountUsd, 168, "not known gone -> kept (status quo)");
  assert.equal(fee("https://www.x.gov/files/fees-fy26-27/building-fee-schedule.pdf").value?.amountUsd, 168);
});

await check("(p2) politeness (close F7): a 404 is a missing page, not a refusal — the host is asked again; 401/403/429 and a challenge still back it off; the per-lookup read budget holds", async () => {
  const s = site({ "https://f.example.gov/missing": { status: 404 }, "https://f.example.gov/ok": { text: "<p>ok</p>" }, "https://g.example.gov/x": { status: 429 }, "https://g.example.gov/y": { text: "<p>y</p>" } });
  const r = newReader(s.fetch);
  assert.equal((await r.read("https://f.example.gov/missing")).status, 404);
  assert.equal((await r.read("https://f.example.gov/ok")).ok, true, "a 404 does not back the host off");
  await r.read("https://g.example.gov/x");
  assert.match((await r.read("https://g.example.gov/y")).reason, /backed off/, "a 429 does");
  assert.equal(reader.isRefusal(404, "HTTP 404 from x.gov — the site refused an ordinary HTTP client"), false);
  assert.equal(reader.isRefusal(410, "HTTP 410"), false);
  assert.equal(reader.isRefusal(403, "HTTP 403"), true);
  assert.equal(reader.isRefusal(503, "x.gov answered with a human-verification challenge (HTTP 503)"), true);
  assert.equal(reader.isRefusal(200, "the site refused an ordinary HTTP client"), true);
  reader._resetPoliteness();
  const s2 = site({ "https://h.example.gov/1": { text: "<p>1</p>" }, "https://h2.example.gov/2": { text: "<p>2</p>" }, "https://h3.example.gov/3": { text: "<p>3</p>" } });
  const small = reader.createPageReader({ fetch: s2.fetch, minGapMs: 0, maxReads: 2 });
  await small.read("https://h.example.gov/1"); await small.read("https://h2.example.gov/2");
  assert.match((await small.read("https://h3.example.gov/3")).reason, /budget is spent/);
  assert.equal(s2.requests.length, 2, "the third URL is never fetched");
});

// ── The lookup, end to end, with a stubbed model and saved pages ──────────────────────────
const g = (text: string, urls: string[], over: Partial<WebLookupResult> = {}): WebLookupResult => ({ text, groundedSearches: 3, searches: 3, stopReason: "end_turn", resultUrls: urls, pagesRead: 0, ...over });

await check("(i1) the lookup READS the agency's page: the portal from its link, the record type in the PORTAL'S label (plan path decides), the portal model step skipped, the fee schedule handed to documents/fees, prerequisites + pages read saved", async () => {
  const base = "https://alderbrookor-energovweb.tylerhost.net/apps/SelfService";
  const FEES = `${CITY}/home/showpublisheddocument/27129/639`;
  const s = site({
    [CENTER]: { text: fixture("agency-permit-center.html") }, [HUB]: { text: fixture("agency-hub.html") },
    [`${CITY}/departments/finance/master-fee-schedule`]: { text: `<main><a href="${FEES}">Master Fee Schedule FY 2026-27 (PDF)</a></main>` },
    [FEES]: { contentType: "text/plain", text: fixture("fee-schedule.txt") },
    [`${base}/api/Home/GetTenants`]: { contentType: "application/json", text: JSON.stringify({ Result: [{ TenantID: 1, TenantName: "Community Development Hub", TenantUrl: "home" }] }) },
    [`${base}/api/Home/Menu`]: { contentType: "application/json", text: fixture("energov-menu.json") },
  });
  const process1 = JSON.stringify({
    issuingAgency: { value: "City of Alderbrook", sourceUrl: CENTER, quote: "The City of Alderbrook Permit Center issues building and electrical permits." },
    permitStructure: { value: "combo", sourceUrl: CENTER, quote: "One permit covers the structural and electrical work (a combined permit)." },
    permits: [{ discipline: "combo", label: "Residential solar", portalUrl: { value: null, notFound: "the page names the Community Development Hub but no URL" }, recordType: { value: null } }],
  });
  const asked: string[] = [];
  let docsUser = "";
  const llm = { webLookup: async (i: { label: string; user: string }) => {
    asked.push(i.label);
    if (i.label.endsWith(".process")) return g(process1, [CENTER]);
    if (i.label.endsWith(".documentsFees")) {
      docsUser = i.user;
      return g(JSON.stringify({ permits: [{ discipline: "combo", documents: { value: null }, fee: { value: { amountUsd: 312, basis: "flat per permit (up to 15 kW)", lines: [{ label: "Solar - Residential (Up to 15 kW)", amountUsd: 312 }] }, sourceUrl: FEES, quote: "1049 Solar - Residential (Up to 15 kW) per permit [2],[4] $ 312" } }] }), [], { groundedSearches: 0, searches: 0 }); // answered from the pages WE read, no search
    }
    return g(JSON.stringify({ permits: [] }), []);
  } };
  const r = newReader(s.fetch);
  const run = await ppl.runPermitProcessLookup(db, llm, { state: "OR", ahj: "City of Alderbrook", dcKw: "8.0", acKw: "7.6", permitPath: "prescriptive", reader: r });
  const p = run.lookup!.permits[0];
  assert.equal(p.portalUrl.value, PORTAL, `portal (${p.portalUrl.notFound})`);
  assert.equal(p.portalUrl.sourceUrl, HUB);
  assert.equal(p.recordType.value, "Residential Renewable Energy - Prescriptive", `record type (${p.recordType.notFound})`);
  assert.equal(p.recordType.sourceUrl, `${base}/api/Home/Menu`);
  assert.equal(p.recordTypeCandidates?.length, 2, "both candidates kept with their conditions");
  assert.ok(!asked.some((l) => l.endsWith(".portal")), `portal model step skipped (${asked.join(", ")})`);
  assert.match(docsUser, /Pages already read for you/);
  assert.match(docsUser, /1049 Solar - Residential \(Up to 15 kW\)/);
  assert.equal(p.fee.value?.amountUsd, 312, `fee (${p.fee.notFound})`);
  assert.ok((run.lookup!.prerequisites ?? []).some((x) => /1-2 business days/.test(String(x.value))), "account lead time is a cited prerequisite");
  assert.ok((run.lookup!.pagesRead ?? []).some((x) => x.url === HUB && x.ok));
  assert.deepEqual(run.lookup!.codes?.value?.slice().sort(), ["2021 International Residential Code", "2023 National Electrical Code"]);
});

await check("(i2) MUST-EXCLUDE: no reader (no model key / page reading off) -> nothing is fetched and the lookup behaves as before", async () => {
  assert.equal(ppl.defaultLookupReader(), null, "no model key -> no default reader");
  const llm = { webLookup: async (i: { label: string }) => (i.label.endsWith(".process") ? g(JSON.stringify({ issuingAgency: { value: null }, permitStructure: { value: null }, permits: [] }), [CENTER]) : g(JSON.stringify({ permits: [] }), [])) };
  const run = await ppl.runPermitProcessLookup(db, llm, { state: "OR", ahj: "City of Cedarton" });
  assert.equal(run.lookup?.pagesRead, undefined);
  assert.equal(run.reads, undefined);
});

await check("(i3) end to end (close F5/F6/F4): the page-read portal goes only to the permits its publisher issues (the State's electrical permit is not given the city's portal); a CITED record type naming one of 2 catalog candidates is kept; a fee cited to a schedule that 404s now is not", async () => {
  const base = "https://alderbrookor-energovweb.tylerhost.net/apps/SelfService";
  const OLD_FEES = `${CITY}/home/showpublisheddocument/555/1`;
  const STATE = "https://www.oregon.gov/bcd/electrical-permits";
  const menu = { Result: { Menus: [
    { Label: "BLDG Solar APP+ Permit (Residential < 38.4 Kwh)", Description: "", CategoryName: "Building", CaseTypeInfo: {} },
    { Label: "BLDG Residential – Solar/Photovoltaic", Description: "", CategoryName: "Building", CaseTypeInfo: {} },
  ] } };
  const s = site({
    [CENTER]: { text: fixture("agency-permit-center.html") }, [HUB]: { text: fixture("agency-hub.html") },
    [`${base}/api/Home/GetTenants`]: { contentType: "application/json", text: JSON.stringify({ Result: [{ TenantID: 1, TenantName: "Community Development Hub", TenantUrl: "home" }] }) },
    [`${base}/api/Home/Menu`]: { contentType: "application/json", text: JSON.stringify(menu) },
  });
  const process1 = JSON.stringify({
    issuingAgency: { value: "City of Alderbrook", sourceUrl: CENTER, quote: "The City of Alderbrook Permit Center issues building permits." },
    permitStructure: { value: "separate", sourceUrl: CENTER, quote: "Solar needs a building permit and a separate electrical permit." },
    permits: [
      { discipline: "structural", label: "Building", portalUrl: { value: null }, recordType: { value: "Residential – Solar/Photovoltaic", sourceUrl: CENTER, quote: "Solar systems are filed under Residential – Solar/Photovoltaic." } },
      { discipline: "electrical", label: "Electrical", issuingAgency: { value: "Oregon Building Codes Division", sourceUrl: STATE, quote: "The Oregon Building Codes Division issues electrical permits in Alderbrook." }, portalUrl: { value: null }, recordType: { value: null } },
    ],
  });
  const asked: Array<{ label: string; user: string }> = [];
  const llm = { webLookup: async (i: { label: string; user: string }) => {
    asked.push(i);
    if (i.label.endsWith(".process")) return g(process1, [CENTER, STATE]);
    if (i.label.endsWith(".documentsFees")) {
      return g(JSON.stringify({ permits: [{ discipline: "structural", documents: { value: null }, fee: { value: { amountUsd: 199, basis: "flat", lines: [{ label: "Solar - SolarApp+ Residential", amountUsd: 199 }] }, sourceUrl: OLD_FEES, quote: "Solar - SolarApp+ Residential per permit $ 199" } }] }), [OLD_FEES]);
    }
    return g(JSON.stringify({ permits: [] }), []);
  } };
  const run = await ppl.runPermitProcessLookup(db, llm, { state: "OR", ahj: "City of Alderbrook", dcKw: "8.0", acKw: "7.6", force: true, reader: newReader(s.fetch) });
  const st = run.lookup!.permits.find((p) => p.discipline === "structural")!;
  const el = run.lookup!.permits.find((p) => p.discipline === "electrical")!;
  assert.equal(st.portalUrl.value, PORTAL, `structural: the city's page-read portal (${st.portalUrl.notFound})`);
  assert.notEqual(el.portalUrl.value, PORTAL, "electrical: the State issues it — not the city's portal");
  assert.ok(asked.some((a) => a.label.endsWith(".portal") && /Permits: electrical/.test(a.user)), `the portal step asks for the electrical permit (${asked.map((a) => a.label).join(", ")})`);
  assert.equal(st.recordType.value, "BLDG Residential – Solar/Photovoltaic", `the cited type names one candidate (${st.recordType.notFound})`);
  assert.equal(st.recordType.sourceUrl, `${base}/api/Home/Menu`, "in the portal's own label, cited to its catalog");
  assert.ok(!(run.lookup!.notes ?? []).some((n) => /Operator question/.test(n)), "no question when the cited type decides it");
  assert.equal(st.fee.value, null, "the cited schedule 404s now");
  assert.match(String(st.fee.notFound), /no longer there/);
  assert.ok(s.requests.some((q) => q.url === OLD_FEES), "the cited schedule was read once");
});

await check("(i5) (Y10) the verify-read of cited fee schedules is bounded: three permits citing three unread schedules -> at most two are read", async () => {
  const F = (n: number) => `${CITY}/home/showpublisheddocument/${n}/1`;
  const s = site({ [CENTER]: { text: fixture("agency-permit-center.html") }, [F(1)]: { status: 404 }, [F(2)]: { status: 404 }, [F(3)]: { status: 404 } });
  const fee = (n: number) => ({ value: { amountUsd: 10 * n, basis: "flat", lines: [{ label: "Solar", amountUsd: 10 * n }] }, sourceUrl: F(n), quote: `Solar $ ${10 * n}` });
  const process1 = JSON.stringify({ issuingAgency: { value: "City of Alderbrook", sourceUrl: CENTER, quote: "The City of Alderbrook Permit Center issues building permits." }, permitStructure: { value: null },
    permits: [{ discipline: "structural", label: "B", portalUrl: { value: null }, recordType: { value: null } }, { discipline: "electrical", label: "E", portalUrl: { value: null }, recordType: { value: null } }, { discipline: "other", label: "O", portalUrl: { value: null }, recordType: { value: null } }] });
  const llm = { webLookup: async (i: { label: string }) => {
    if (i.label.endsWith(".process")) return g(process1, [CENTER]);
    if (i.label.endsWith(".documentsFees")) return g(JSON.stringify({ permits: [{ discipline: "structural", documents: { value: null }, fee: fee(1) }, { discipline: "electrical", documents: { value: null }, fee: fee(2) }, { discipline: "other", documents: { value: null }, fee: fee(3) }] }), [F(1), F(2), F(3)]);
    return g(JSON.stringify({ permits: [] }), []);
  } };
  await ppl.runPermitProcessLookup(db, llm, { state: "OR", ahj: "City of Alderbrook", force: true, reader: newReader(s.fetch) });
  const feeReads = s.requests.filter((q) => /showpublisheddocument\/[123]\//.test(q.url));
  assert.equal(feeReads.length, 2, `Y10: ${feeReads.length} cited schedules read (${feeReads.map((q) => q.url).join(", ")})`);
});

// ── lookup-close-2 (the second skeptic's BROKEN verdict, 2026-09-26): MF1 / MF2 / MF3, the quote
// door's recall, the landing-page rules, and the reviewer's untested kills (Y2-Y6, Y9). ───────
// Real page texts: Fairfax County's solar-residential page (documents as ' - ' items), Hollis NH's
// solar-requirements PDF ("8 ½” x 11”", "Current Codes 2020 NEC") and building-fees PDF ("Solar
// Arrays" header over "Roof Top Solar Array … $75.00").
const CITY2 = "https://www.examplecity.gov";
const PAGE2 = `${CITY2}/building`;

await check("(m3) MUST-EXCLUDE (close-2 MF2): a same-named OTHER jurisdiction — a City of Marion page linking 'Marion County Online Permits' (aca-prod/MARIONCOUNTY), a Marion County page linking 'City of Marion permit portal' (CITYOFMARION); MUST-PASS: the county's portal on the city page when the county ISSUES the city's permits; the type word never reads 'co' (LEECO)", async () => {
  const v1 = await resolveNamed({ "https://www.cityofmarion.org/building": { text: synthetic(`<p>Building permits for properties inside city limits are issued at City Hall on paper.</p><p>For unincorporated property: <a href="https://aca-prod.accela.com/MARIONCOUNTY/Default.aspx">Marion County Online Permits</a></p>`) } }, ["https://www.cityofmarion.org/building"], ["City of Marion"]);
  assert.equal(v1.res, null, `V1: the county's tenant is not the city's portal (got ${v1.res?.url})`);
  const v2 = await resolveNamed({ "https://www.co.marion.in.us/building": { text: synthetic(`<p>Inside the City of Marion? <a href="https://aca-prod.accela.com/CITYOFMARION/Default.aspx">City of Marion permit portal</a></p><p>Unincorporated: apply in person at the County Building.</p>`) } }, ["https://www.co.marion.in.us/building"], ["Marion County"]);
  assert.equal(v2.res, null, `V2: the city's tenant is not the county's portal (got ${v2.res?.url})`);
  // Only the TENANT betrays it: "Apply Online" -> MARIONCOUNTY, the one tenant on the city's page (door 2).
  const v1b = await resolveNamed({ "https://www.cityofmarion.org/building": { text: synthetic(`<p>Permits for property outside city limits: <a href="https://aca-prod.accela.com/MARIONCOUNTY/Default.aspx">Apply Online</a></p>`) } }, ["https://www.cityofmarion.org/building"], ["City of Marion"]);
  assert.equal(v1b.res, null, `V1b: the county's tenant, unnamed in the words, is not the city's portal (got ${v1b.res?.url})`);
  const v1c = await resolveNamed({ "https://www.cityofmarion.org/building": { text: synthetic(`<p><a href="https://aca-prod.accela.com/CITYOFMARION/Default.aspx">Apply Online</a></p>`) } }, ["https://www.cityofmarion.org/building"], ["City of Marion"]);
  assert.equal(v1c.res?.url, "https://aca-prod.accela.com/CITYOFMARION/Default.aspx", "MUST-PASS: the city's own tenant");
  // The Jefferson shape: the AHJ is the city, the COUNTY issues its permits (both names are the lookup's).
  const ok = await resolveNamed({ "https://www.cityofmarion.org/building": { text: synthetic(`<p>Marion County issues our building permits: <a href="https://aca-prod.accela.com/MARIONCOUNTY/Default.aspx">Marion County Online Permits</a></p>`) } }, ["https://www.cityofmarion.org/building"], ["City of Marion", "Marion County"]);
  assert.equal(ok.res?.url, "https://aca-prod.accela.com/MARIONCOUNTY/Default.aspx", `the issuing county's portal is the city's (${ok.res?.url})`);
  assert.equal(cat.tenantContradictsAgency("https://aca-prod.accela.com/MARIONCOUNTY/Default.aspx", ["City of Marion"]), true);
  assert.equal(cat.tenantContradictsAgency("https://aca-prod.accela.com/CITYOFMARION/Default.aspx", ["Marion County"]), true);
  assert.equal(cat.tenantContradictsAgency("https://aca-prod.accela.com/LEECO/Default.aspx", ["City of Lee"]), false, "'co' is never a type word");
  assert.equal(cat.tenantContradictsAgency("https://cityofscottsdaleaz-energovweb.tylerhost.net/apps/selfservice", ["City of Scottsdale"]), false);
  assert.equal(cat.tenantContradictsAgency("https://aca-prod.accela.com/MARIONCOUNTY/Default.aspx", ["Marion"]), false, "an AHJ name with no type word contradicts nothing");
  assert.equal(cat.wordsNameAnotherJurisdiction("Marion County Online Permits", ["City of Marion"]), true);
  assert.equal(cat.wordsNameAnotherJurisdiction("Marion County Online Permits", ["Marion County"]), false);
  assert.equal(cat.wordsNameAnotherJurisdiction("City of Marion permit portal", ["Marion County"]), true);
  assert.equal(cat.wordsNameAnotherJurisdiction("Iowa City permit portal", ["Iowa City"]), false);
  assert.equal(cat.wordsNameAnotherJurisdiction("Fairfax County permit portal (PLUS)", ["Fairfax County"]), false);
  assert.deepEqual([...cat.jurisdictionTypes(["City of Fernhill", "Marion County"])].sort(), ["city", "county"]);
});

await check("(c6) MUST-EXCLUDE (close-2 MF3): the description door — 'Residential Mechanical … solar water heating systems', 'Residential Re-Roof … if solar panels must be removed and reinstalled', a commercial-only solar type — offer no PV candidate; MUST-PASS: a description naming photovoltaic / solar panels does, and a real PV type beside a look-alike wins outright", () => {
  const C = (types: Array<[string, string?]>) => ({ platform: "energov" as const, sourceUrl: "https://x-energovweb.tylerhost.net/apps/selfservice/api/Home/Menu", types: types.map(([l, d]) => ({ label: l, description: d ?? "", category: "Building" })) });
  const labels = (types: Array<[string, string?]>) => cat.solarRecordTypeCandidates(C(types)).map((c) => c.label);
  assert.deepEqual(labels([["Residential Mechanical", "Furnace, AC, heat pumps and solar water heating systems"]]), []);
  assert.deepEqual(labels([["Residential Re-Roof", "Re-roofing. If solar panels must be removed and reinstalled, note it in the description."]]), []);
  assert.deepEqual(labels([["Commercial Solar Photovoltaic"], ["Residential Electrical"]]), [], "a residential job never files the commercial type");
  assert.deepEqual(labels([["Residential Solar Photovoltaic"], ["Residential Mechanical", "includes solar water heating"]]), ["Residential Solar Photovoltaic"]);
  assert.deepEqual(labels([["Residential Building Permit", "Installing solar/photovoltaic/battery systems on residential property."], ["Residential Deck"]]), ["Residential Building Permit"], "a PV description supports the type");
  assert.deepEqual(labels([["Residential Accessory", "Sheds, fences and solar panels (rooftop PV) on a dwelling"]]), ["Residential Accessory"]);
  assert.equal(cat.descriptionNamesPv("Furnace, AC, heat pumps and solar water heating systems"), false);
  assert.equal(cat.descriptionNamesPv("Rooftop solar panels and photovoltaic arrays"), true);
  for (const l of ["Solar Module Repair / Replacement", "Solar Decommissioning", "Solar Lighting", "Solar Powered Sign", "Solar Attic Fan", "Solar Ready Construction", "Solar Farm"]) assert.deepEqual(labels([[l]]), [], `not PV: ${l}`);
});

await check("(f6) MUST-PASS (close-2 item 4): quotes that ARE on a page we read — Hollis's documents with '8 1/2\"' for the PDF's '8 ½”' (and with curly quotes), Hollis's fee row with its 'Solar Arrays' header joined, Fairfax's documents as ' - ' items; MUST-EXCLUDE: an amount not printed on that row, an item not on the page, the same quote against another page", () => {
  const hollisSolar = fixture("hollis-solar-requirements.txt");
  const hollisFees = fixture("hollis-building-fees.txt");
  const fairfax = fixture("fairfax-solar-residential.txt");
  const docsQ = '1. Building permit application. 2. (2) 11" x 17" sets of detailed installation plans... 3. (2) 8 1/2" x 11" NH Stamped Engineer statement... 4. (2) Detailed roof plan layouts of solar panels with any setbacks & pathway measurements clearly marked.';
  assert.ok(reader.quoteOnPage(docsQ, hollisSolar), "ASCII fraction and straight quotes");
  assert.ok(reader.quoteOnPage(docsQ.replace(/(\d)"/g, "$1”").replace("8 1/2", "8½"), hollisSolar), "curly quotes, attached fraction");
  assert.ok(!reader.quoteOnPage(docsQ, fairfax), "the same words are not on another page");
  assert.ok(!reader.quoteOnPage('1. Building permit application. 2. (2) 8 1/2" x 11" structural calculations stamped by a NH engineer', hollisSolar), "an item the page does not print");
  const feeQ = "Solar Arrays / Roof Top Solar Array (excludes electrical fee)  $75.00  $200.00";
  assert.ok(reader.quoteOnPage(feeQ, hollisFees), "the row with its section header joined");
  assert.ok(reader.quoteOnPage("Roof Top Solar Array (excludes electrical fee)  $75.00  $200.00", hollisFees), "the row alone");
  assert.ok(reader.quoteOnPage("Solar Arrays / Roof Top Solar Array (excludes electrical fee) $75", hollisFees), "$75 == $75.00");
  assert.ok(!reader.quoteOnPage("Solar Arrays / Roof Top Solar $75", hollisFees), "a paraphrase that drops the row's words is not the row");
  assert.ok(!reader.quoteOnPage("Solar Arrays / Roof Top Solar Array (excludes electrical fee) $85.00", hollisFees), "an amount not printed");
  assert.ok(!reader.quoteOnPage("Solar Arrays / Roof Top Solar Array $50.00", hollisFees), "$50 is another row's amount");
  assert.ok(!reader.quoteOnPage(feeQ, hollisSolar), "not on another page");
  const fairfaxQ = "First Submission - Fairfax Coversheet - Architectural/Structural Drawings - House Location Plat or Grading Plan Submission Record Number - Permit Authorization - Property Ownership Affidavit - License Exemption Affidavit";
  assert.ok(reader.quoteOnPage(fairfaxQ, fairfax), "each ' - ' item is on the page");
  assert.ok(reader.quoteOnPage(fairfaxQ.replace(/ - /g, " – "), fairfax), "en-dash items");
  assert.ok(!reader.quoteOnPage(`${fairfaxQ} - Structural Calculations Stamped by an Engineer`, fairfax), "an item not on the page");
  assert.ok(!reader.quoteOnPage(fairfaxQ, hollisSolar), "not on another page");
  assert.ok(!reader.quoteOnPage("Solar - $50", "Fees\nSolar Installation | $25\nFence | $50"), "a dash beside an amount keeps the amount with its words");
  // Through the real docs/fees door, cited to the pages we read.
  const SOLAR_PDF = "https://www.hollisnh.gov/DocumentCenter/View/398/Solarpermitrequirements-PDF";
  const FEES_PDF = "https://www.hollisnh.gov/DocumentCenter/View/455/Building-Fees-PDF";
  const texts = new Map([[ppl.pageKey(SOLAR_PDF), hollisSolar], [ppl.pageKey(FEES_PDF), hollisFees]]);
  const ans = JSON.stringify({ permits: [{ discipline: "structural",
    documents: { value: ["Building permit application", "(2) 11x17 sets of detailed installation plans", "(2) 8 1/2 x 11 NH stamped engineer statement", "(2) roof plan layouts with setbacks and pathways"], sourceUrl: SOLAR_PDF, quote: docsQ },
    fee: { value: { amountUsd: 75, basis: "flat, residential roof-top solar array (excludes electrical fee)", lines: [{ label: "Roof Top Solar Array (excludes electrical fee)", amountUsd: 75 }] }, sourceUrl: FEES_PDF, quote: feeQ } }] });
  const r = ppl.parseDocsFeesPart(ans, [SOLAR_PDF, FEES_PDF], "end_turn", texts).byDiscipline.get("structural")!;
  assert.equal(r.documents.value?.length, 4, `documents kept (${r.documents.notFound})`);
  assert.equal(r.fee.value?.amountUsd, 75, `fee kept (${r.fee.notFound})`);
  const bad = JSON.parse(ans); bad.permits[0].fee.quote = "Solar Arrays / Roof Top Solar Array (excludes electrical fee) $85.00"; bad.permits[0].fee.value.amountUsd = 85; bad.permits[0].fee.value.lines[0].amountUsd = 85;
  assert.equal(ppl.parseDocsFeesPart(JSON.stringify(bad), [SOLAR_PDF, FEES_PDF], "end_turn", texts).byDiscipline.get("structural")!.fee.value, null, "an unprinted amount is still refused");
});

await check("(f7) MUST-EXCLUDE (close-2 item 4): the row door matches a segment's words CONTIGUOUSLY inside a cell — 'Solar Installation $50' is not on 'Solar Hot Water Installation | Residential | $50', 'Solar $50' not on 'Solar Water Heater | $50'; MUST-PASS: the same words with a cell between them", () => {
  assert.equal(reader.quoteOnPage("Solar Installation $50", "Fees\nSolar Hot Water Installation | Residential | $50\n"), false);
  assert.equal(reader.quoteOnPage("Solar $50", "Fees\nSolar Water Heater | $50\n"), false);
  assert.equal(reader.quoteOnPage("Solar Installation $50", "Fees\nSolar Installation | $25 | $50\n"), false, "$25 is between them");
  assert.equal(reader.quoteOnPage("Solar Installation $50", "Fees\nSolar Installation | Residential | $50\n"), true);
  assert.equal(reader.quoteOnPage("Solar Installation $500", "Fees\nSolar Installation | $50\n"), false);
});

await check("(f8) MUST-EXCLUDE (close-3 MF1): an amount belongs to the words right before it — a table row the model copied as two LINES ('Solar Residential\\n$331', CRLF too), a list-dash split ('Solar PV - Residential $75' where the page prints 'Deck - Residential | $75'), a bullet / bar split, a dropped one-word label ('Solar - Residential $75'), a lone amount, and a line-join ('Solar Thermal' / '$50 Fence') are all refused, through quoteOnPage AND the real docs/fees door; MUST-PASS: each row on its own words, the ellipsis-split Waltham row, the Hollis header-joined row, the Unicode-fraction documents and the ' - ' document list", () => {
  const feePage = "Building Permit Fees\nSolar Residential | $168\nSolar Commercial | $331\nDeck - Residential | $75\nSolar PV - Residential | $150\nSolar PV - Commercial | $300\n";
  const q = (quote: string) => reader.quoteOnPage(quote, feePage);
  assert.equal(q("Solar Residential $168"), true, "A1 its own row");
  assert.equal(q("Solar PV - Residential $150"), true, "A9 its own row, dash and all");
  assert.equal(q("Solar Residential | $168"), true, "its own row quoted with the cell bar");
  assert.equal(q("Solar Residential\n$168"), true, "its own row copied as two lines");
  assert.equal(q("Solar Residential $331"), false, "A2 another row's amount");
  assert.equal(q("Solar Residential\n$331"), false, "A3 a newline between label and amount");
  assert.equal(q("Solar Residential\r\n$331"), false, "A4 CRLF");
  assert.equal(q("Solar PV - Residential $75"), false, "A5 dash split: $75 is the deck row's");
  assert.equal(q("Solar PV – Residential $75"), false, "A6 en dash");
  assert.equal(q("Solar - Residential $75"), false, "A7 a one-word label piece is not dropped");
  assert.equal(q("Solar Residential • $331"), false, "A8 bullet split");
  assert.equal(q("Solar Residential | $331"), false, "bar split");
  assert.equal(q("Solar Residential ... $331"), false, "a lone amount after an ellipsis rejoins its label");
  assert.equal(q("$331"), false, "a lone amount never matches on its own");
  assert.equal(q("Solar Photovoltaic $75"), false, "A14");
  assert.equal(reader.quoteOnPage("Solar Thermal $50", "Fees\nSolar Thermal\n$50 Fence permit\nSolar PV $150\n"), false, "A16 line-join: the amount is on the next line");
  assert.equal(reader.quoteOnPage("Solar Thermal $50", "Fees\nSolar Thermal $50\nFence permit $25\n"), true, "the same words on one line");
  assert.deepEqual(reader.quoteSegments("Solar PV - Residential $75"), ["solar pv residential $75"]);
  assert.deepEqual(reader.quoteSegments("Residential ... Solar Installation $50"), ["solar installation $50"], "an ellipsis stands; a lone word attests nothing");
  assert.deepEqual(reader.quoteSegments("Site Plan - Roof Plan - Plat"), ["site plan", "roof plan"], "list items each their own segment; a lone word is not one");
  // Through the REAL docs/fees door (the reviewer's A10 / A11 / A12).
  const FEES = "https://www.examplecity.gov/DocumentCenter/View/9/Fee-Schedule-PDF";
  const texts = new Map([[ppl.pageKey(FEES), feePage]]);
  const ans = (quote: string, amt: number) => JSON.stringify({ permits: [{ discipline: "structural", documents: { value: null }, fee: { value: { amountUsd: amt, basis: "flat", lines: [{ label: "Solar Residential", amountUsd: amt }] }, sourceUrl: FEES, quote } }] });
  const door = (quote: string, amt: number) => ppl.parseDocsFeesPart(ans(quote, amt), [FEES], "end_turn", texts).byDiscipline.get("structural")!.fee;
  assert.equal(door("Solar Residential\n$331", 331).value, null, "A10 refused");
  assert.match(String(door("Solar Residential\n$331", 331).notFound), /not on the fee's source page/);
  assert.equal(door("Solar PV - Residential $75", 75).value, null, "A11 refused");
  assert.equal(door("Solar Residential • $331", 331).value, null, "A8 refused at the door");
  assert.equal(door("Solar Residential $168", 168).value?.amountUsd, 168, "A12 kept");
  assert.equal(door("Solar PV - Residential | $150", 150).value?.amountUsd, 150, "its own row, bar and dash, kept");
  // The MUST-PASS shapes of earlier rounds hold: Waltham's ellipsis row, Hollis's header-joined row and fraction documents, Fairfax's ' - ' list.
  const waltham = reader.parseHtml(fixture("waltham-electrical-fees.html"), "https://www.city.waltham.ma.us/1290/Electrical-Fees").text;
  assert.equal(reader.quoteOnPage("Residential ... Solar Installation $50", waltham), true, "Waltham");
  assert.equal(reader.quoteOnPage("Solar Installation | $50", waltham), true, "Waltham with the cell bar");
  assert.equal(reader.quoteOnPage("Solar Installation\n$50", waltham), true, "Waltham copied as two lines: the row door finds it");
  assert.equal(reader.quoteOnPage("Solar Installation $25", waltham), false, "another row's amount");
  assert.equal(reader.quoteOnPage("Solar Arrays / Roof Top Solar Array (excludes electrical fee)  $75.00  $200.00", fixture("hollis-building-fees.txt")), true, "Hollis header-joined row");
  assert.equal(reader.quoteOnPage('1. Building permit application. 2. (2) 11" x 17" sets of detailed installation plans... 3. (2) 8½” x 11” NH Stamped Engineer statement... 4. (2) Detailed roof plan layouts of solar panels with any setbacks & pathway measurements clearly marked.', fixture("hollis-solar-requirements.txt")), true, "Hollis documents");
  assert.equal(reader.quoteOnPage("First Submission - Fairfax Coversheet - Architectural/Structural Drawings - House Location Plat or Grading Plan Submission Record Number - Permit Authorization - Property Ownership Affidavit - License Exemption Affidavit", fixture("fairfax-solar-residential.txt")), true, "Fairfax ' - ' list");
});

await check("(r6) MUST-EXCLUDE (close-2 item 5): an own-domain link is judged by where it LANDS — a Click2Gov utility-billing page, iWorQ's concern-form landing (/portalhome), a MapsOnline viewer, the vendor's root (Y2), SolarAPP+ (Y3); a Business-License module deep link (V8); a link naming another jurisdiction is never read (Y4); MUST-PASS: a landing whose path names the permit portal, and an ACA tenant landing", async () => {
  const own = (words: string, href: string, landing: Served) => resolveNamed({ [PAGE2]: { text: synthetic(`<p>Building permit applications are accepted in person only.</p><a href="${href}">${words}</a>`) }, [href]: landing }, [PAGE2], ["City of Examplecity"]);
  const v5 = await own("Online Services", `https://secure.examplecity.gov/Click2GovCX/`, { text: `<html><head><title>Click2Gov Utility Billing - Customer Portal</title></head><body><h1>Pay your water bill</h1></body></html>` });
  assert.equal(v5.res, null, `V5 Click2Gov billing (got ${v5.res?.url})`);
  assert.equal(cat.detectPlatform({ ok: true, finalUrl: "https://secure.examplecity.gov/Click2GovCX/", title: "Click2Gov Utility Billing - Customer Portal", text: "Pay your water bill", links: [], html: "" }), null, "Click2Gov is not a permit platform");
  const v6 = await own("Online Portal", `${CITY2}/portal`, { finalUrl: "https://examplecity.portal.iworq.net/portalhome/examplecity", text: `<html><head><title>iWorQ Portal</title></head><body><a href="/EXAMPLECITY/concern/1">Report a Concern</a></body></html>` });
  assert.equal(v6.res, null, `V6 iWorQ concern landing (got ${v6.res?.url})`);
  const v7 = await own("Online Portal", `${CITY2}/online-portal`, { finalUrl: "https://www.mapsonline.net/examplecity/index.html", text: `<html><head><title>MapsOnline</title></head><body>Parcel viewer</body></html>` });
  assert.equal(v7.res, null, `V7 parcel viewer (got ${v7.res?.url})`);
  const y2 = await own("Online Portal", `${CITY2}/apply-online`, { finalUrl: "https://www.accela.com/", text: `<html><head><title>Accela Citizen Access</title></head><body>Accela — Government software</body></html>` });
  assert.equal(y2.res, null, `Y2 vendor root landing (got ${y2.res?.url})`);
  const y3 = await own("Apply online", `${CITY2}/solar-apply`, { finalUrl: "https://app.gosolarapp.org/examplecity/apply", text: `<html><head><title>SolarAPP+</title></head><body>Apply</body></html>` });
  assert.equal(y3.res, null, `Y3 SolarAPP+ landing (got ${y3.res?.url})`);
  // A MapsOnline (PeopleGIS) link under portal words: the viewer, not a permit page (Y1).
  for (const viewer of ["https://www.mapsonline.net/examplecity/index.html", "https://examplecity.mapsonline.net/index.html"]) {
    const y1 = await resolveNamed({ [PAGE2]: { text: synthetic(`<p>Paper only.</p><a href="${viewer}">Apply Online</a>`) } }, [PAGE2], ["City of Examplecity"]);
    assert.equal(y1.res, null, `Y1 a MapsOnline viewer under portal words (got ${y1.res?.url})`);
  }
  const v8 = await resolveNamed({ [`${CITY2}/finance`]: { text: synthetic(`<a href="https://aca-prod.accela.com/EXAMPLECITY/Cap/CapHome.aspx?module=Licenses">Apply for a Business License Online</a>`) } }, [`${CITY2}/finance`], ["City of Examplecity"]);
  assert.equal(v8.res, null, `V8 licence-module deep link (got ${v8.res?.url})`);
  const v8b = await resolveNamed({ [`${CITY2}/finance`]: { text: synthetic(`<a href="https://aca-prod.accela.com/EXAMPLECITY/Cap/CapHome.aspx?module=Licenses">Apply Online</a>`) } }, [`${CITY2}/finance`], ["City of Examplecity"]);
  assert.equal(v8b.res, null, `V8b the same deep link under portal words (got ${v8b.res?.url})`);
  const v8c = await resolveNamed({ [PAGE2]: { text: synthetic(`<a href="https://aca-prod.accela.com/EXAMPLECITY/Cap/CapHome.aspx?module=Building">Apply Online</a>`) } }, [PAGE2], ["City of Examplecity"]);
  assert.equal(v8c.res?.url, "https://aca-prod.accela.com/EXAMPLECITY/Cap/CapHome.aspx?module=Building", "MUST-PASS: the Building module deep link");
  // A vendor's OTHER product on the city's own domain: its title carries the vendor's name and the
  // landing path names no portal (OpenGov's budget / transparency product beside its permitting one).
  const og = await own("Online Services", `${CITY2}/online-services`, { finalUrl: "https://secure.examplecity.gov/transparency/budget", text: `<html><head><title>OpenGov Budget & Transparency</title></head><body><h1>Where the money goes</h1></body></html>` });
  assert.equal(og.res, null, `a vendor title on a non-portal landing path (got ${og.res?.url})`);
  const y4 = await resolveNamed({ [PAGE2]: { text: synthetic(`<p>Paper only.</p><a href="${CITY2}/othertown-portal">City of Othertown online permit portal</a>`) }, [`${CITY2}/othertown-portal`]: { text: fixture("aca-frame-wrapper.html"), finalUrl: "https://portal.othertown.gov/Permits/Default.aspx" } }, [PAGE2], ["City of Examplecity"]);
  assert.equal(y4.res, null, `Y4 another jurisdiction's own-domain link (got ${y4.res?.url})`);
  assert.ok(!y4.requests.some((q) => q.url.includes("othertown-portal")), "Y4: never read");
  // MUST-PASS
  const iw = await own("Apply online", `${CITY2}/apply`, { finalUrl: "https://examplecity.portal.iworq.net/EXAMPLECITY/permits/600", text: `<html><head><title>iWorQ Portal</title></head><body>Building Permit Application</body></html>` });
  assert.equal(iw.res?.url, "https://examplecity.portal.iworq.net/EXAMPLECITY/permits/600", `an iWorQ permits landing (${iw.res?.url})`);
  assert.equal(iw.res?.via, "redirect onto a vendor host");
  const aca = await own("Online Permits", `${CITY2}/online-permits`, { finalUrl: "https://aca-prod.accela.com/EXAMPLECITY/Default.aspx", text: `<html><head><title>Welcome</title></head><body>Online permits</body></html>` });
  assert.equal(aca.res?.url, "https://aca-prod.accela.com/EXAMPLECITY/Default.aspx", `an ACA tenant landing (${aca.res?.url})`);
  const direct = await resolveNamed({ [PAGE2]: { text: synthetic(`<a href="https://portal.iworq.net/EXAMPLECITY/permits/600">Apply for a Building Permit Online</a>`) } }, [PAGE2], ["City of Examplecity"]);
  assert.equal(direct.res?.url, "https://portal.iworq.net/EXAMPLECITY/permits/600", "V11: a direct iWorQ permit link");
});

await check("(r7) MUST-EXCLUDE (close-2 MF1): the page-read portal never goes to a permit whose cited issuing agency differs from the lookup's — the State CID's electrical permit cited on the COUNTY's own FAQ (F6b); MUST-PASS: the county's own permit gets it (F6a)", async () => {
  const CO = "https://www.santafe-examplecounty.gov";
  const PG = `${CO}/building/residential`;
  const ACA = "https://aca-prod.accela.com/SFEXCO/Default.aspx";
  const s = site({ [PG]: { text: `<html><head><title>Residential Development</title></head><body><main><p>The County issues the Development Permit. Electrical permits and inspections are issued by the State Construction Industries Division (CID).</p><p><a href="${ACA}">Apply online - County permit portal</a></p></main></body></html>` } });
  const process1 = JSON.stringify({
    issuingAgency: { value: "Examplecounty", sourceUrl: PG, quote: "The County issues the Development Permit." },
    permitStructure: { value: "separate", sourceUrl: PG, quote: "Electrical permits and inspections are issued by the State Construction Industries Division (CID)." },
    permits: [
      { discipline: "structural", label: "Development", portalUrl: { value: null }, recordType: { value: null } },
      { discipline: "electrical", label: "Electrical", issuingAgency: { value: "State Construction Industries Division", sourceUrl: PG, quote: "Electrical permits and inspections are issued by the State Construction Industries Division (CID)." }, portalUrl: { value: null }, recordType: { value: null } },
    ],
  });
  const llm = { webLookup: async (i: { label: string }) => (i.label.endsWith(".process") ? g(process1, [PG]) : g(JSON.stringify({ permits: [] }), [])) };
  const run = await ppl.runPermitProcessLookup(db, llm, { state: "NM", ahj: "Examplecounty", dcKw: "7", acKw: "6", force: true, reader: newReader(s.fetch) });
  const st = run.lookup!.permits.find((p) => p.discipline === "structural")!;
  const el = run.lookup!.permits.find((p) => p.discipline === "electrical")!;
  assert.equal(st.portalUrl.value, ACA, `F6a: the county's permit gets the county portal (${st.portalUrl.notFound})`);
  assert.notEqual(el.portalUrl.value, ACA, "F6b: the State's permit does not, though cited on the county's page");
});

await check("(p3) politeness (Y5 / Y6): a redirect onto another host starts THAT host's gap; the false-wall override holds a 2xx HTML page only when its visible words are long and not a wall", async () => {
  const s = site({ "https://a.example.gov/go": { text: "<p>landed</p>", finalUrl: "https://b.example.gov/landing" }, "https://b.example.gov/other": { text: "<p>b</p>" } });
  const r = newReader(s.fetch, 300);
  await r.read("https://a.example.gov/go");
  const t0 = Date.now();
  await r.read("https://b.example.gov/other");
  assert.ok(Date.now() - t0 >= 280, `Y5: b.example.gov was asked ${Date.now() - t0} ms after the redirect landed on it (>= 300 expected)`);
  const long = `<html><body><main>${"<p>The Building Division issues permits for residential solar photovoltaic systems.</p>".repeat(12)}</main></body></html>`;
  const refused = (text: string, status = 200, contentType = "text/html", reason = "x.gov refused an ordinary HTTP client (wall)") => ({ ok: false, status, contentType, text, finalUrl: "https://x.gov/p", reason });
  assert.ok(reader.falseWallOverride(refused(long), "https://x.gov/p")?.ok, "MUST-PASS: a real page behind a script's wall words is held");
  assert.equal(reader.falseWallOverride(refused("<html><body><p>Access denied. Please verify you are human to continue.</p></body></html>"), "https://x.gov/p"), null, "a short page is never held");
  assert.equal(reader.falseWallOverride(refused(`<html><body><main><p>${"Checking your browser before accessing this site. Please verify you are human by completing the challenge. ".repeat(8)}</p></main></body></html>`), "https://x.gov/p"), null, "a wall in the visible words is never held");
  assert.equal(reader.falseWallOverride(refused(long, 403), "https://x.gov/p"), null, "a 403 is never held");
  assert.equal(reader.falseWallOverride(refused(long, 200, "text/html", "HTTP 200"), "https://x.gov/p"), null, "only the transport's own wall reading is overridden");
});

await check("(y9) MUST-EXCLUDE (Y9): a CITED fee document that is a prior year's / archived is never read; MUST-PASS: a current one is; (Y8) a fee link on another STATE's locality domain is not this agency's; (Y13) a tenant read that shows the agency's name but no platform is not the portal; (Y7) a cited type naming a PATH picks the one candidate on it", async () => {
  const IA_FEES = "https://www.co.marion.ia.us/files/fee-schedule.pdf";
  const s = site({ [PAGE2]: { text: synthetic(`<p>Apply in person.</p><a href="${IA_FEES}">Fee Schedule</a>`) }, [`${CITY2}/files/fee-schedule-fy2027.pdf`]: { contentType: "text/plain", text: "Building Permit Fees\nSolar  $75.00" }, [`${CITY2}/files/2018-fee-schedule.pdf`]: { contentType: "text/plain", text: "Solar  $10.00" }, [IA_FEES]: { contentType: "text/plain", text: "Solar  $99.00" } });
  const r = newReader(s.fetch);
  await ppl.readAgencyEvidence(r, { ahj: "City of Examplecity", state: "OR", agencyNames: [], citedUrls: [PAGE2, `${CITY2}/files/2018-fee-schedule.pdf`, `${CITY2}/files/fee-schedule-fy2027.pdf`], resultUrls: [], proposedPortals: [] });
  const read = s.requests.map((q) => q.url);
  assert.ok(!read.some((u) => u.includes("2018-fee-schedule")), `Y9: the 2018 schedule was read (${read.join(", ")})`);
  assert.ok(read.some((u) => u.includes("fee-schedule-fy2027")), `the current schedule was read (${read.join(", ")})`);
  assert.ok(!read.includes(IA_FEES), `Y8: an Oregon lookup read another state's locality-domain schedule (${read.join(", ")})`);
  // Y8: the job's state decides whose locality domain is official.
  const M = "https://www.co.marion.or.us/building";
  const pg = { url: M, finalUrl: M, ok: true, status: 200, kind: "html" as const, reason: "", ...reader.parseHtml(synthetic(`<a href="https://www.co.marion.ia.us/files/fee-schedule.pdf">Fee Schedule</a> <a href="https://www.co.marion.or.us/files/permit-fees.pdf">Permit Fees</a>`), M) };
  assert.deepEqual(cat.documentLinks([pg], ["Marion County"], "OR").map((d) => d.text), ["Permit Fees"], "Y8: Iowa's Marion County schedule is not Oregon's");
  assert.equal(cat.documentLinks([pg], ["Marion County"]).length, 2, "with no state known, either locality domain is official");
  // Y13: two tenants, the read of one names the agency but shows no platform markers.
  const TWO = `${CITY2}/permits`;
  const plain = (agency: string) => `<html><head><title>Welcome</title></head><body><main><h1>${agency} Online Permits</h1></main></body></html>`;
  const t = await resolveNamed({
    [TWO]: { text: synthetic(`<a href="https://aca-prod.accela.com/ABC/Default.aspx">Permit portal</a> <a href="https://aca-prod.accela.com/XYZ/Default.aspx">Permit portal (new)</a>`) },
    "https://aca-prod.accela.com/ABC/Default.aspx": { text: plain("City of Othertown") },
    "https://aca-prod.accela.com/XYZ/Default.aspx": { text: plain("City of Examplecity") },
  }, [TWO], ["City of Examplecity"]);
  assert.equal(t.res, null, `Y13: a read without platform markers attests nothing (got ${t.res?.url})`);
  // Y7: the cited type names a path, not a label.
  const cands = cat.solarRecordTypeCandidates({ platform: "energov", sourceUrl: "u", types: [
    { label: "BLDG Solar APP+ Permit (Residential < 38.4 Kwh)", description: "", category: "Building" },
    { label: "BLDG Residential – Solar/Photovoltaic", description: "", category: "Building" },
  ] });
  assert.equal(cat.candidateNamedBy(cands, "Apply through SolarAPP+")?.path, "solarapp", "Y7: the path the cited type names");
  assert.equal(cat.candidateNamedBy(cands, "the prescriptive path"), null, "no candidate on that path");
});

await check("(i4) end to end (close-2 item 4): the code editions are quoted from a PDF we read ('Current Codes 2020 NEC' in a town's solar-requirements sheet), and documents quoted from it with '8 1/2\"' are kept", async () => {
  const TOWN = "https://www.hollis-example.gov";
  const BLDG = `${TOWN}/1268/Building-Code-Enforcement`;
  const PDF = `${TOWN}/DocumentCenter/View/398/Solarpermitrequirements-PDF`;
  const s = site({
    [BLDG]: { text: synthetic(`<p>All building permit applications shall be submitted to the Building Department in person.</p><a href="${PDF}">Solar Permit Requirements (PDF)</a>`) },
    [PDF]: { contentType: "text/plain", text: fixture("hollis-solar-requirements.txt") },
  });
  const process1 = JSON.stringify({
    issuingAgency: { value: "Town of Hollis-example", sourceUrl: BLDG, quote: "All building permit applications shall be submitted to the Hollis-example Building Department in person." },
    permitStructure: { value: null }, permits: [{ discipline: "structural", label: "Building", portalUrl: { value: null }, recordType: { value: null } }],
  });
  const docsQ = '1. Building permit application. 2. (2) 11" x 17" sets of detailed installation plans... 3. (2) 8 1/2" x 11" NH Stamped Engineer statement... 4. (2) Detailed roof plan layouts of solar panels with any setbacks & pathway measurements clearly marked.';
  const llm = { webLookup: async (i: { label: string }) => {
    if (i.label.endsWith(".process")) return g(process1, [BLDG]);
    if (i.label.endsWith(".documentsFees")) return g(JSON.stringify({ permits: [{ discipline: "structural", documents: { value: ["Building permit application", "(2) 11x17 installation plans", "(2) 8 1/2 x 11 NH stamped engineer statement", "(2) roof plan layouts"], sourceUrl: PDF, quote: docsQ }, fee: { value: null } }] }), [], { groundedSearches: 0, searches: 0 });
    return g(JSON.stringify({ permits: [] }), []);
  } };
  const run = await ppl.runPermitProcessLookup(db, llm, { state: "NH", ahj: "Town of Hollis-example", force: true, reader: newReader(s.fetch) });
  assert.ok(run.lookup!.codes?.value?.includes("2020 NEC"), `codes from the PDF (${JSON.stringify(run.lookup!.codes)})`);
  assert.equal(run.lookup!.codes?.sourceUrl, PDF);
  const st = run.lookup!.permits.find((p) => p.discipline === "structural")!;
  assert.equal(st.documents.value?.length, 4, `documents kept (${st.documents.notFound})`);
});

console.log(failures ? `\n${failures} agency page read test(s) FAILED` : "\nAll agency page read tests passed.");
process.exit(failures ? 1 : 0);
