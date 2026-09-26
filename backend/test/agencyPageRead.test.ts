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

await check("(p1) politeness: one host is read >= the gap apart, other hosts are not held up; a refusal backs the host off (never asked again); a sign-in URL is never fetched and a redirect onto one is not read", async () => {
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

console.log(failures ? `\n${failures} agency page read test(s) FAILED` : "\nAll agency page read tests passed.");
process.exit(failures ? 1 : 0);
