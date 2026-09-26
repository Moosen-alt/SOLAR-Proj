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
    ["county page listing its cities' tenants", `<h2>Inside a city? Apply with your city</h2><ul><li><a href="https://aca-prod.accela.com/CITYA/Default.aspx">City A permit portal</a></li><li><a href="https://aca-prod.accela.com/CITYB/Default.aspx">City B permit portal</a></li></ul><h2>Unincorporated</h2><p><a href="https://aca-prod.accela.com/COUNTYX/Default.aspx">Apply online - County permit portal</a></p>`],
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

console.log(failures ? `\n${failures} agency page read test(s) FAILED` : "\nAll agency page read tests passed.");
process.exit(failures ? 1 : 0);
