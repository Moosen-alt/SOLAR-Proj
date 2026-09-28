// FIND THE FORM (live 2026-09-28, City of Waltham, MA — "didn't seem to find the info for the AHJ on
// the permit applications"). Waltham's Residential Application is public: its CivicPlus Applications
// page links "Residential Application" -> /DocumentCenter/View/4313/Residential-Application, which
// serves application/pdf. The product never took it:
//   A1 Stage's one search ABORTED at its 180s budget and was reported as "No downloadable PDF form
//      was found" — and the 24h cooldown it had claimed held research shut for a day;
//   A2 the only candidates were the model's own list (empty): the forms page the search named was
//      never read, the raw search results were thrown away, and the prompt asked for ".pdf" links;
//   A3 the "why" was dropped: the find audit kept the status only, the KB lost "Forms page: <url>".
// For ANY AHJ (no city is special-cased in the code under test):
//   MUST-PASS    the residential application is found on the AHJ's own forms page and stored; a
//                search result of that shape on the AHJ's own site is taken; the forms page is kept
//                as its own KB note segment (a verified row's facts are not overwritten); a search
//                that could not run is reported as such and the cooldown is released; the audit
//                keeps the message; a download from a host just read waits the polite gap.
//   MUST-EXCLUDE a fee schedule, an agenda, a checklist, a commercial-only / tax application, an
//                off-site link, a utility host and an HTML page that is not a PDF are never stored
//                (and the excluded links are never even requested); a completed empty search keeps
//                the cooldown.
// No network: a LOCAL http fixture server answers every request (the fetch stub forwards each
// URL's host + path to it and records the URL). No model: the research result is injected.
//
//   npx tsx backend/test/formsFindPage.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so filled/ docs/ never land in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { AhjFormUrlResult, LLMProvider } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forms-find-page-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmp, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmp, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE", "PERMIT_PROCESS_LOOKUP", "UTILITY_FILING_LOOKUP"]) process.env[k] = "off";
for (const k of ["DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "ANTHROPIC_API_KEY"]) delete process.env[k];
process.env.DOCUMENT_FETCH_BROWSER = "0"; // never a headed browser

const { openDatabase } = await import("../src/db");
const repo = await import("../src/repository");
const auto = await import("../src/ahjFormAuto");
const catalog = await import("../src/permitPlatformCatalog");
const { createPageReader } = await import("../src/agencyPageReader");
const { prepareOfficialDocuments } = await import("../src/prepareOfficialDocuments");
const kb = await import("../src/knowledgeBase");

const db = await openDatabase();

// Every check runs (a kill shows WHICH pins fall); the banner prints only when none failed.
let passed = 0;
const failed: string[] = [];
const check = (name: string, cond: unknown, detail = ""): void => {
  if (cond) { passed++; return; }
  failed.push(name);
  console.error(`  FAIL - ${name}${detail ? `\n         ${detail.slice(0, 900)}` : ""}`);
};

// ── the local fixture server: "<host>/<path>" -> a response ─────────────────────────────────────
const routes = new Map<string, { type: string; body: Buffer | string }>();
const server = http.createServer((req, res) => {
  const key = decodeURIComponent(String(req.url || "")).replace(/^\//, "");
  const r = routes.get(key);
  if (!r) { res.writeHead(404, { "content-type": "text/html" }); res.end("<html><body>Page not found</body></html>"); return; }
  res.writeHead(200, { "content-type": r.type });
  res.end(r.body);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const realFetch = globalThis.fetch;
let requested: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  requested.push(u.toString());
  const r = await realFetch(`${base}/${u.host}${u.pathname}${u.search}`, { signal: init?.signal ?? undefined });
  // A fresh Response (url ""), so the fetchers resolve links against the URL they asked for.
  return new Response(await r.arrayBuffer(), { status: r.status, headers: { "content-type": r.headers.get("content-type") || "" } });
}) as typeof fetch;
const serveHtml = (url: string, html: string) => routes.set(url.replace(/^https?:\/\//, ""), { type: "text/html; charset=utf-8", body: html });
const servePdf = (url: string, bytes: Buffer) => routes.set(url.replace(/^https?:\/\//, ""), { type: "application/pdf", body: bytes });
async function acroPdf(title: string): Promise<Buffer> {
  const d = await PDFDocument.create();
  const p = d.addPage([612, 792]);
  p.drawText(title, { x: 40, y: 740, size: 12, font: await d.embedFont(StandardFonts.Helvetica) });
  d.getForm().createTextField("Owner name").addToPage(p, { x: 40, y: 600, width: 200, height: 18 });
  return Buffer.from(await d.save());
}
/** A CivicPlus-shaped page: site navigation / footer furniture around a list of links. */
const civicPage = (title: string, links: Array<[string, string]>) => `<!DOCTYPE html><html><head><title>${title} | Official Website</title></head><body>
<header><nav><a href="/">Home</a><a href="/1289/Applications">Applications</a><a href="/AgendaCenter">Agendas &amp; Minutes</a><a href="https://translate.google.com/translate?u=x">Translate</a></nav></header>
<main><h1>${title}</h1><p>Download the application for your project below.</p><ul>
${links.map(([href, text]) => `<li><a href="${href}">${text}</a></li>`).join("\n")}
</ul></main><footer><a href="mailto:bldg@example.gov">Contact</a></footer></body></html>`;

// ── the injected model: a research result per AHJ, a fixture field map ────────────────────────
const researchFor = new Map<string, Partial<AhjFormUrlResult>>();
let researchCalls: string[] = [];
const llm = {
  async findAhjFormUrl(input: { ahj: string; formType?: string }) {
    researchCalls.push(input.ahj);
    return { provider: "claude", formName: "", candidateUrls: [], formType: input.formType || "permit_application", confidence: "medium", notes: "", ...(researchFor.get(input.ahj) ?? {}) };
  },
  async mapAcroFormFields() { return { provider: "claude", textFields: { "Owner name": "project.homeownerName" }, checkboxes: {}, notes: "fixture map" }; },
  async mapFlatFormOverlay() { return { provider: "claude", fields: [], signatures: [], notes: "" }; },
} as unknown as LLMProvider;
const fp = () => ({ reader: createPageReader({ minGapMs: 0 }), minGapMs: 0 });

const projectIds: string[] = [];
const mkJob = (ahj: string, city: string) => {
  const p = repo.createProject(db, {
    owner: "Fixture Owner", street: "1 Fixture Rd", city, state: "MA", zip: "02451", ahj, utility: "Eversource", dcKw: "8.1", acKw: "7.6",
    permitPathOverride: "engineered", mounting: "Roof Mount", structureDescription: "Single-family dwelling",
  } as never).project;
  projectIds.push(p.id);
  return p;
};
const rows = (ahj: string) => db.query<{ form_type: string; source_url: string; original_filename: string }>("SELECT form_type, source_url, original_filename FROM ahj_form_templates WHERE ahj_name = ?", [ahj]);
const cooldownRow = (ahj: string) => db.get<{ attempted_at: number }>("SELECT attempted_at FROM ahj_form_acquisition_attempts WHERE scope_key = ?", [`ma|${ahj.toLowerCase()}|engineered`]);

try {
  // ═══ UNIT — the classifier (a filter list fails both ways: MUST-PASS and MUST-EXCLUDE) ══════════
  const dc = (slug: string) => `https://www.somewhere.ma.us/DocumentCenter/View/1/${slug}`;
  const pass: Array<[string, string, string]> = [
    ["Residential Application", dc("Residential-Application"), "general"],
    ["Building Permit Application", "https://www.somewhere.gov/files/Building-Permit-Application.pdf", "building"],
    ["Electrical Permit Application", "https://www.somewhere.gov/files/elec.pdf", "electrical"],
    ["Solar PV Permit Application", "https://www.somewhere.gov/home/showpublisheddocument/123", "general"],
    ["Building, Plumbing & Gas Permit Application", dc("Combined"), "building"],
    ["Building/Electrical Permit Application", dc("Combo"), "combined"],
    ["", dc("Residential-Building-Permit-Application"), "building"],
    ["Application for Building Permit - Residential and Commercial", dc("App"), "building"],
    // A form that names who may pull it is still the form ("licen[cs]" once excluded every "Licensed").
    ["Building Permit Application – Licensed Contractors", dc("Licensed"), "building"],
  ];
  for (const [words, href, discipline] of pass) {
    const got = catalog.classifyApplicationDocument(words, href);
    check(`UNIT MUST-PASS "${words || href}" is a ${discipline} application`, got?.discipline === discipline, JSON.stringify(got));
  }
  const exclude: Array<[string, string]> = [
    ["Building Permit Application Fee Schedule", dc("Fees")],
    ["Solar Permit Application Checklist", dc("Checklist")],
    ["Solar Permit Application Guide", dc("Guide")],
    ["Building Permit Applications - Agenda", dc("Agenda-09-28")],
    ["Planning Board Minutes - Permit Applications", dc("Minutes")],
    ["Building Department Newsletter: permit applications", dc("News")],
    ["Residential Application", "https://www.somewhere.ma.us/1289/Applications"], // a page, not a document
    ["Residential Exemption Application", dc("Residential-Exemption-Application")],
    ["Solar Interconnection Application", dc("Interconnection")],
    ["Plumbing Permit Application", dc("Plumbing")],
    ["Sign Permit Application", dc("Sign")],
    ["Commercial Building Permit Application", dc("Commercial")],
    ["Construction Supervisor License Application", dc("CSL")],
    ["Application Instructions", dc("Instructions")],
  ];
  for (const [words, href] of exclude) {
    const got = catalog.classifyApplicationDocument(words, href);
    check(`UNIT MUST-EXCLUDE "${words}" is not the application`, got === null, JSON.stringify(got));
  }
  check("UNIT a residential application outranks a generic one", (catalog.classifyApplicationDocument("Residential Application", dc("R"))?.score ?? 0) > (catalog.classifyApplicationDocument("Permit Application", dc("P"))?.score ?? 0));
  check("UNIT the electrical-only application never fills the building-side / generic slot; the electrical slot takes only an electrical one",
    !auto.disciplineFitsSlot("electrical", "permit_application") && !auto.disciplineFitsSlot("electrical", "building_application")
    && auto.disciplineFitsSlot("electrical", "electrical_application") && !auto.disciplineFitsSlot("general", "electrical_application") && auto.disciplineFitsSlot("general", "permit_application"));
  check("UNIT two towns' <town>.<st>.us hosts are two sites (\"ma.us\" is a public suffix); a 4-label locality and a .co.us county keep theirs",
    catalog.registrableDomain("www.offsite.ma.us") === "offsite.ma.us" && catalog.registrableDomain("neighbortown.ma.us") === "neighbortown.ma.us"
    && catalog.registrableDomain("www.city.waltham.ma.us") === "city.waltham.ma.us" && catalog.registrableDomain("www.douglas.co.us") === "douglas.co.us",
    JSON.stringify([catalog.registrableDomain("www.offsite.ma.us"), catalog.registrableDomain("www.city.waltham.ma.us")]));
  check("UNIT a state's own site is not an AHJ's forms site; the AHJ's own is; another state's never",
    !catalog.isAhjFormsSite("www.oregon.gov", ["City of Waltham"], "MA") && catalog.isAhjFormsSite("www.city.waltham.ma.us", ["City of Waltham"], "MA")
    && !catalog.isAhjFormsSite("www.tigard-or.gov", ["City of Waltham"], "MA") && !catalog.isAhjFormsSite("www.pge.com", ["City of Waltham"], "MA"));

  // ═══ S1 MUST-PASS — the Waltham shape: the forms page is read, the residential application stored ═══
  const W = "https://www.city.waltham.ma.us";
  const W_PAGE = `${W}/1289/Applications`;
  const W_APP = `${W}/DocumentCenter/View/4313/Residential-Application`;
  const W_BAD = {
    fee: `${W}/DocumentCenter/View/4310/Building-Permit-Application-Fee-Schedule`,
    checklist: `${W}/DocumentCenter/View/4311/Solar-Permit-Application-Checklist`,
    commercial: `${W}/DocumentCenter/View/4312/Commercial-Application`,
    exemption: `${W}/DocumentCenter/View/4314/Residential-Exemption-Application`,
    agenda: `${W}/DocumentCenter/View/4315/Agenda-Building-Permit-Applications`,
    offsite: "https://www.neighbortown.ma.us/DocumentCenter/View/77/Residential-Building-Permit-Application",
    utility: "https://www.pge.com/DocumentCenter/View/88/Residential-Solar-Permit-Application",
  };
  serveHtml(W_PAGE, civicPage("Applications", [
    [W_BAD.fee.slice(W.length), "Building Permit Application Fee Schedule"],
    [W_BAD.agenda.slice(W.length), "Building Board Agenda - Permit Applications"],
    [W_BAD.checklist.slice(W.length), "Solar Permit Application Checklist"],
    [W_BAD.offsite, "Residential Building Permit Application (Neighbortown)"],
    [W_BAD.utility, "Residential Solar Permit Application"],
    [W_BAD.commercial.slice(W.length), "Commercial Application"],
    [W_APP.slice(W.length), "Residential Application"],
    [W_BAD.exemption.slice(W.length), "Residential Exemption Application"],
    ["https://waltham.patriotproperties.com/", "Assessor Records"],
  ]));
  servePdf(W_APP, await acroPdf("CITY OF WALTHAM Residential Application"));
  for (const [k, u] of Object.entries(W_BAD)) servePdf(u, await acroPdf(`bad ${k}`)); // every bad link WOULD download
  researchFor.set("City of Waltham", { formsPageUrl: W_PAGE, submissionMethod: "in-person" });
  const waltham = mkJob("City of Waltham", "Waltham");
  requested = [];
  const s1 = await auto.ensureAhjFormTemplate(db, llm, waltham, "permit_application", { formsPage: fp() });
  check("S1 MUST-PASS the residential application is found on the AHJ's forms page and stored", s1.status === "acquired" && s1.sourceUrl === W_APP
    && JSON.stringify(rows("City of Waltham").map((r) => [r.form_type, r.source_url])) === JSON.stringify([["permit_application", W_APP]]),
    JSON.stringify({ s1, rows: rows("City of Waltham"), requested }));
  check("S1 it is stored under the AHJ's own link words", rows("City of Waltham")[0]?.original_filename === "Residential Application.pdf", JSON.stringify(rows("City of Waltham")));
  check("S1 exactly two requests: the forms page once, then the one application", JSON.stringify(requested) === JSON.stringify([W_PAGE, W_APP]), JSON.stringify(requested));
  for (const [k, u] of Object.entries(W_BAD)) check(`S1 MUST-EXCLUDE the ${k} link is never requested`, !requested.includes(u), JSON.stringify(requested));
  const wKb = kb.findKnowledgeForLearn(db, { state: "MA", ahj: "City of Waltham", utility: "" }).ahj;
  check("S1 A3 the KB keeps 'Forms page: <url>' as its own note segment", String(wKb?.notes || "").split(" | ").includes(`Forms page: ${W_PAGE}`), String(wKb?.notes));
  const audit = auto.formFindAuditDetails("City of Waltham", s1, [{ formType: "electrical_application", status: "not_found", message: "no electrical form linked" }]);
  check("A3 the find audit keeps the message, the source and the additional messages", audit.message === s1.message && audit.sourceUrl === W_APP
    && JSON.stringify(audit.additionalMessages) === JSON.stringify(["electrical_application: no electrical form linked"]) && audit.lookupFailed === false, JSON.stringify(audit));

  // ═══ S2 MUST-PASS — a search result of that shape on the AHJ's own site is taken ═══════════════
  const B = "https://www.brookfield.ma.us";
  const B_APP = `${B}/DocumentCenter/View/701/Residential-Application`;
  const B_FEE = `${B}/DocumentCenter/View/700/Building-Permit-Application-Fee-Schedule`;
  const B_OFF = "https://www.neighbortown.ma.us/DocumentCenter/View/78/Residential-Building-Permit-Application";
  servePdf(B_APP, await acroPdf("BROOKFIELD Residential Application"));
  servePdf(B_FEE, await acroPdf("BROOKFIELD fee schedule"));
  servePdf(B_OFF, await acroPdf("NEIGHBORTOWN residential building permit application"));
  researchFor.set("City of Brookfield", { searchResults: [
    { url: B_FEE, title: "Building Permit Application Fee Schedule" },
    { url: B_OFF, title: "Residential Building Permit Application" },
    { url: `${B}/1200/Building-Permits`, title: "Building Permits | Brookfield, MA" },
    { url: B_APP, title: "Residential Application | Brookfield, MA" },
  ] });
  requested = [];
  const s2 = await auto.ensureAhjFormTemplate(db, llm, mkJob("City of Brookfield", "Brookfield"), "permit_application", { formsPage: fp() });
  check("S2 MUST-PASS the search result on the AHJ's own site is downloaded and stored", s2.status === "acquired" && s2.sourceUrl === B_APP && rows("City of Brookfield").length === 1,
    JSON.stringify({ s2, requested }));
  check("S2 MUST-EXCLUDE the fee schedule and another town's application (a search returns both) are never requested", !requested.includes(B_FEE) && !requested.includes(B_OFF), JSON.stringify(requested));

  // ═══ E1 MUST-EXCLUDE — a fee schedule, on the page AND as the model's candidate ═══════════════
  const F = "https://www.feeburg.ma.us";
  const F_PAGE_FEE = `${F}/DocumentCenter/View/501/Building-Permit-Application-Fee-Schedule`;
  const F_MODEL_FEE = `${F}/DocumentCenter/View/502/Building-Permit-Fee-Schedule`;
  serveHtml(`${F}/forms`, civicPage("Forms", [[F_PAGE_FEE.slice(F.length), "Building Permit Application Fee Schedule"]]));
  servePdf(F_PAGE_FEE, await acroPdf("fee schedule 1"));
  servePdf(F_MODEL_FEE, await acroPdf("fee schedule 2"));
  researchFor.set("Town of Feeburg", { formsPageUrl: `${F}/forms`, candidateUrls: [F_MODEL_FEE] });
  requested = [];
  const e1 = await auto.ensureAhjFormTemplate(db, llm, mkJob("Town of Feeburg", "Feeburg"), "permit_application", { formsPage: fp() });
  check("E1 MUST-EXCLUDE a fee schedule is never stored", e1.status === "not_found" && rows("Town of Feeburg").length === 0, JSON.stringify({ e1, requested }));
  check("E1 the page's fee schedule is never requested", !requested.includes(F_PAGE_FEE), JSON.stringify(requested));
  check("E1 the model's fee-schedule candidate is never requested", !requested.includes(F_MODEL_FEE), JSON.stringify(requested));
  check("E1 the not-found says the page was read and linked no application", /Read the forms page .*no permit application document is linked/.test(e1.message), e1.message);

  // ═══ E2 MUST-EXCLUDE — an agenda / a checklist handout ═════════════════════════════════════════
  const G = "https://www.agendale.ma.us";
  const G_AGENDA = `${G}/DocumentCenter/View/601/Agenda`;
  const G_LIST = `${G}/DocumentCenter/View/602/Solar-PV-Application-Checklist`;
  serveHtml(`${G}/forms`, civicPage("Forms", [[G_AGENDA.slice(G.length), "Building Permit Applications - Agenda"], [G_LIST.slice(G.length), "Solar PV Application Checklist"]]));
  servePdf(G_AGENDA, await acroPdf("agenda"));
  servePdf(G_LIST, await acroPdf("checklist"));
  researchFor.set("Town of Agendale", { formsPageUrl: `${G}/forms` });
  requested = [];
  const e2 = await auto.ensureAhjFormTemplate(db, llm, mkJob("Town of Agendale", "Agendale"), "permit_application", { formsPage: fp() });
  check("E2 MUST-EXCLUDE an agenda and a checklist handout are never requested or stored", e2.status === "not_found" && rows("Town of Agendale").length === 0
    && !requested.includes(G_AGENDA) && !requested.includes(G_LIST), JSON.stringify({ e2, requested }));

  // ═══ E3 MUST-EXCLUDE — an off-site link (another town's form) on the AHJ's page ═══════════════
  const O = "https://www.offsite.ma.us";
  const O_OFF = "https://www.neighbortown.ma.us/DocumentCenter/View/79/Residential-Building-Permit-Application";
  serveHtml(`${O}/forms`, civicPage("Forms", [[O_OFF, "Residential Building Permit Application"]]));
  servePdf(O_OFF, await acroPdf("neighbortown app"));
  researchFor.set("Town of Offsite", { formsPageUrl: `${O}/forms` });
  requested = [];
  const e3 = await auto.ensureAhjFormTemplate(db, llm, mkJob("Town of Offsite", "Offsite"), "permit_application", { formsPage: fp() });
  check("E3 MUST-EXCLUDE another town's application linked from the AHJ's page is never requested or stored", e3.status === "not_found" && rows("Town of Offsite").length === 0 && !requested.includes(O_OFF),
    JSON.stringify({ e3, requested }));

  // ═══ E4 MUST-EXCLUDE — a utility host (rule 5): as the forms page, the model's link, a search result ═══
  const U_PAGE = "https://www.pge.com/solar/permit-applications";
  const U_MODEL = "https://www.pge.com/DocumentCenter/View/90/Residential-Solar-Permit-Application";
  const U_SEARCH = "https://www.pge.com/DocumentCenter/View/91/Residential-Permit-Application";
  serveHtml(U_PAGE, civicPage("Solar permits", [[U_MODEL, "Residential Solar Permit Application"]]));
  servePdf(U_MODEL, await acroPdf("utility app 1"));
  servePdf(U_SEARCH, await acroPdf("utility app 2"));
  researchFor.set("Town of Gridley", { formsPageUrl: U_PAGE, candidateUrls: [U_MODEL], searchResults: [{ url: U_SEARCH, title: "Residential Permit Application" }] });
  requested = [];
  const e4 = await auto.ensureAhjFormTemplate(db, llm, mkJob("Town of Gridley", "Gridley"), "permit_application", { formsPage: fp() });
  check("E4 MUST-EXCLUDE nothing on a utility host is requested or stored on the permit track", e4.status === "not_found" && rows("Town of Gridley").length === 0
    && !requested.some((u) => u.includes("pge.com")), JSON.stringify({ e4, requested }));
  check("E4 the not-found says the named forms page is not the AHJ's own site", /is not on Town of Gridley's own site, so it was not read/.test(e4.message), e4.message);

  // ═══ E5 MUST-EXCLUDE — an HTML page that is not a PDF (a CMS 200 on a document link) ═══════════
  const H = "https://www.htmlton.ma.us";
  const H_APP = `${H}/DocumentCenter/View/6000/Residential-Application`;
  serveHtml(`${H}/forms`, civicPage("Forms", [[H_APP.slice(H.length), "Residential Application"]]));
  serveHtml(H_APP, "<html><body><h1>Document Center</h1><p>This document is not available.</p></body></html>");
  researchFor.set("Town of Htmlton", { formsPageUrl: `${H}/forms` });
  requested = [];
  const e5 = await auto.ensureAhjFormTemplate(db, llm, mkJob("Town of Htmlton", "Htmlton"), "permit_application", { formsPage: fp() });
  check("E5 MUST-EXCLUDE an HTML answer is refused by fetchPdf and never stored", e5.status === "not_found" && rows("Town of Htmlton").length === 0 && requested.includes(H_APP)
    && /none returned a valid PDF/.test(e5.message), JSON.stringify({ e5, requested }));

  // ═══ E6 THE SLOT — an electrical-only application is never the generic / building-side blank ═════
  const EL = "https://www.voltham.ma.us";
  const EL_APP = `${EL}/DocumentCenter/View/950/Electrical-Permit-Application`;
  serveHtml(`${EL}/forms`, civicPage("Forms", [[EL_APP.slice(EL.length), "Electrical Permit Application"]]));
  servePdf(EL_APP, await acroPdf("VOLTHAM Electrical Permit Application"));
  researchFor.set("Town of Voltham", { formsPageUrl: `${EL}/forms` });
  const elJob = mkJob("Town of Voltham", "Voltham");
  requested = [];
  const e6 = await auto.ensureAhjFormTemplate(db, llm, elJob, "permit_application", { formsPage: fp() });
  check("E6 MUST-EXCLUDE the electrical application is not stored as the generic permit application", e6.status === "not_found" && rows("Town of Voltham").length === 0 && !requested.includes(EL_APP),
    JSON.stringify({ e6, requested, rows: rows("Town of Voltham") }));
  const e6b = await auto.ensureAhjFormTemplate(db, llm, elJob, "electrical_application", { formsPage: fp() });
  check("E6 MUST-PASS ...and it IS stored in the electrical slot", e6b.status === "acquired" && JSON.stringify(rows("Town of Voltham").map((r) => [r.form_type, r.source_url])) === JSON.stringify([["electrical_application", EL_APP]]),
    JSON.stringify({ e6b, rows: rows("Town of Voltham") }));

  // ═══ E7 THE KIND — where the split applies, the other of the two building-side applications is not
  // this one. (The kind is passed as the required set passes it; an unknown Oregon AHJ is portal-only
  // in the reference profiles, so the mechanism is pinned on a jurisdiction that publishes PDFs.)
  const K = "https://www.kindville.ma.us";
  const K_STRUCT = `${K}/DocumentCenter/View/960/Residential-Structural-Building-Permit-Application`;
  const K_PRESC = `${K}/DocumentCenter/View/961/Prescriptive-Solar-PV-Permit-Application`;
  serveHtml(`${K}/forms`, civicPage("Forms", [[K_STRUCT.slice(K.length), "Residential Structural Building Permit Application"], [K_PRESC.slice(K.length), "Prescriptive Solar PV Permit Application"]]));
  servePdf(K_STRUCT, await acroPdf("KINDVILLE structural application"));
  servePdf(K_PRESC, await acroPdf("KINDVILLE prescriptive application"));
  researchFor.set("City of Kindville", { formsPageUrl: `${K}/forms` });
  const kJob = mkJob("City of Kindville", "Kindville");
  requested = [];
  const e7 = await auto.ensureAhjFormTemplate(db, llm, kJob, "building_application", { applicationKind: "prescriptive", formsPage: fp() });
  check("E7 a prescriptive job's building-side slot takes the PRESCRIPTIVE application, never the structural one (ranked higher)", e7.status === "acquired" && e7.sourceUrl === K_PRESC
    && !requested.includes(K_STRUCT), JSON.stringify({ e7, requested }));

  // ═══ F1 MUST-EXCLUDE — ANOTHER jurisdiction's site is never "the AHJ's own" (skeptic F1) ═══════════
  // What the harvest finds is stored in the SHARED ahj_form_templates under THIS AHJ's name and its
  // forms page written into THIS AHJ's shared KB notes. "Any .gov / any same-state .<st>.us" took a
  // neighbouring town's application: another town's .gov, the state's own .gov, a same-state town's
  // .ma.us. Each is served as a real forms page linking a real "Residential Application" PDF (so a
  // door that admits it WOULD store it), and named both as the forms page and as search results.
  const NEIGHBOURS = {
    townGov: "https://www.newtonma.gov",
    stateGov: "https://www.mass.gov",
    townMaUs: "https://www.ci.newton.ma.us",
  };
  const nApp = (base: string) => `${base}/DocumentCenter/View/4400/Residential-Application`;
  for (const [k, base] of Object.entries(NEIGHBOURS)) {
    serveHtml(`${base}/forms`, civicPage("Applications", [[nApp(base).slice(base.length), "Residential Application"]]));
    servePdf(nApp(base), await acroPdf(`NEIGHBOUR ${k} Residential Application`));
  }
  check("F1 UNIT MUST-EXCLUDE another town's .gov, the state's .gov and a same-state town's .ma.us are not the AHJ's forms site",
    Object.values(NEIGHBOURS).every((b) => !catalog.isAhjFormsSite(new URL(b).host, ["City of Lexfield"], "MA")),
    JSON.stringify(Object.values(NEIGHBOURS).map((b) => [b, catalog.isAhjFormsSite(new URL(b).host, ["City of Lexfield"], "MA")])));
  check("F1 UNIT MUST-PASS the AHJ's own .gov and its own .ma.us are its forms site",
    catalog.isAhjFormsSite("www.lexfieldma.gov", ["City of Lexfield"], "MA") && catalog.isAhjFormsSite("www.ci.lexfield.ma.us", ["City of Lexfield"], "MA")
    && catalog.isAhjFormsSite("www.city.waltham.ma.us", ["City of Waltham"], "MA"));
  const neighbourAhj: Record<string, string> = { townGov: "City of Lexfield", stateGov: "Town of Ashbury", townMaUs: "City of Corwin" };
  for (const [k, base] of Object.entries(NEIGHBOURS)) {
    const ahj = neighbourAhj[k];
    researchFor.set(ahj, { formsPageUrl: `${base}/forms`, submissionMethod: "in-person",
      searchResults: Object.values(NEIGHBOURS).map((b) => ({ url: nApp(b), title: "Residential Application" })) });
    requested = [];
    const f1 = await auto.ensureAhjFormTemplate(db, llm, mkJob(ahj, "Lexfield"), "permit_application", { formsPage: fp() });
    const hosts = Object.values(NEIGHBOURS).map((b) => new URL(b).host);
    check(`F1 MUST-EXCLUDE (${k} as the forms page) nothing on another jurisdiction's site is requested`, !requested.some((u) => hosts.includes(new URL(u).host)), JSON.stringify(requested));
    check(`F1 MUST-EXCLUDE (${k}) nothing is stored under ${ahj}`, f1.status === "not_found" && rows(ahj).length === 0, JSON.stringify({ f1, rows: rows(ahj) }));
    check(`F1 (${k}) the not-found says the named forms page is not the AHJ's own site`, new RegExp(`is not on ${ahj}'s own site, so it was not read`).test(f1.message), f1.message);
    const nKb = kb.findKnowledgeForLearn(db, { state: "MA", ahj, utility: "" }).ahj;
    check(`F1 MUST-EXCLUDE (${k}) no KB note carries another jurisdiction's forms page`, Boolean(nKb) && !hosts.some((h) => String(nKb?.notes || "").includes(h)) && !/Forms page:/.test(String(nKb?.notes || "")),
      String(nKb?.notes));
  }

  // ═══ G1 GO GENTLY — the download from a host we just read waits the polite gap ═══════════════════
  const GE = "https://www.gentleton.ma.us";
  const GE_APP = `${GE}/DocumentCenter/View/801/Residential-Application`;
  serveHtml(`${GE}/forms`, civicPage("Forms", [[GE_APP.slice(GE.length), "Residential Application"]]));
  servePdf(GE_APP, await acroPdf("GENTLETON Residential Application"));
  researchFor.set("Town of Gentleton", { formsPageUrl: `${GE}/forms` });
  const sleeps: number[] = [];
  requested = [];
  const g1 = await auto.ensureAhjFormTemplate(db, llm, mkJob("Town of Gentleton", "Gentleton"), "permit_application",
    { formsPage: { reader: createPageReader({ minGapMs: 0 }), minGapMs: 10_000, sleep: async (ms: number) => { sleeps.push(ms); } } });
  check("G1 the application is acquired after one wait of ~10s following the page read", g1.status === "acquired" && sleeps.length === 1 && sleeps[0] > 9_000 && sleeps[0] <= 10_000,
    JSON.stringify({ g1: g1.status, sleeps, requested }));
  // The model's own link on the host whose forms page was just read waits the gap too.
  const GM = "https://www.gentlemodel.ma.us";
  const GM_APP = `${GM}/DocumentCenter/View/802/Residential-Application`;
  serveHtml(`${GM}/forms`, civicPage("Forms", []));
  servePdf(GM_APP, await acroPdf("GENTLEMODEL Residential Application"));
  researchFor.set("Town of Gentlemodel", { formsPageUrl: `${GM}/forms`, candidateUrls: [GM_APP] });
  const sleeps2: number[] = [];
  const g2 = await auto.ensureAhjFormTemplate(db, llm, mkJob("Town of Gentlemodel", "Gentlemodel"), "permit_application",
    { formsPage: { reader: createPageReader({ minGapMs: 0 }), minGapMs: 10_000, sleep: async (ms: number) => { sleeps2.push(ms); } } });
  check("G1 the model's own link on the just-read host also waits ~10s", g2.status === "acquired" && sleeps2.length === 1 && sleeps2[0] > 9_000 && sleeps2[0] <= 10_000,
    JSON.stringify({ g2: g2.status, sleeps2 }));

  // ═══ T1 A SEARCH THAT COULD NOT RUN — reported as such, and the cooldown claim is released ═══════
  const T = "https://www.timeoutville.ma.us";
  const T_APP = `${T}/DocumentCenter/View/901/Residential-Application`;
  serveHtml(`${T}/forms`, civicPage("Forms", [[T_APP.slice(T.length), "Residential Application"]]));
  servePdf(T_APP, await acroPdf("TIMEOUTVILLE Residential Application"));
  researchFor.set("City of Timeoutville", { lookupFailed: true, lookupError: "Request was aborted." });
  const tJob = mkJob("City of Timeoutville", "Timeoutville");
  researchCalls = [];
  const t1 = await prepareOfficialDocuments(db, tJob, { llm, research: true, formsPage: fp() });
  const t1r = t1.results.find((r) => r.formType === "permit_application") ?? t1.results[0];
  check("T1 the Stage ran the full pass and its search was asked", t1.acquisition === "full" && researchCalls.includes("City of Timeoutville"), JSON.stringify({ t1, researchCalls }));
  check("T1 MUST-PASS the result is 'could not run' — not a finding about the AHJ", t1r?.status === "not_found" && t1r.lookupFailed === true
    && /The form search could not run: Request was aborted\. — not a finding about City of Timeoutville/.test(t1r.message) && !/No downloadable PDF form was found/.test(t1r.message),
    JSON.stringify(t1r));
  check("T1 MUST-PASS the 24h cooldown claim is released (no row: there was no prior attempt)", t1.cooldownReleased === true && cooldownRow("City of Timeoutville") == null,
    JSON.stringify({ released: t1.cooldownReleased, row: cooldownRow("City of Timeoutville") }));
  // The next Stage searches again — and this time the search runs and the form is found.
  researchFor.set("City of Timeoutville", { formsPageUrl: `${T}/forms` });
  researchCalls = [];
  const t1b = await prepareOfficialDocuments(db, tJob, { llm, research: true, formsPage: fp() });
  check("T1 the next Stage is the full pass again, searches, and acquires the form", t1b.acquisition === "full" && researchCalls.includes("City of Timeoutville")
    && t1b.results.some((r) => r.status === "acquired") && rows("City of Timeoutville").some((r) => r.source_url === T_APP), JSON.stringify({ t1b, researchCalls }));
  check("T1 ...and that completed pass keeps its claim", cooldownRow("City of Timeoutville") != null, JSON.stringify(cooldownRow("City of Timeoutville")));
  // A prior attempt older than 24h is restored, not erased.
  const tJob2 = mkJob("City of Oldclaim", "Oldclaim");
  const old = Date.now() - 25 * 60 * 60 * 1000;
  db.run("INSERT INTO ahj_form_acquisition_attempts(scope_key, attempted_at) VALUES (?, ?)", ["ma|city of oldclaim|engineered", old]);
  researchFor.set("City of Oldclaim", { lookupFailed: true, lookupError: "Request timed out." });
  const t2 = await prepareOfficialDocuments(db, tJob2, { llm, research: true, formsPage: fp() });
  check("T1 a released claim restores the prior attempt's time", t2.acquisition === "full" && t2.cooldownReleased === true && cooldownRow("City of Oldclaim")?.attempted_at === old,
    JSON.stringify({ t2: t2.cooldownReleased, row: cooldownRow("City of Oldclaim"), old }));

  // ═══ T2 MUST-EXCLUDE — a completed search that found nothing KEEPS the cooldown ═══════════════════
  researchFor.set("City of Emptyville", { notes: "" });
  const eJob = mkJob("City of Emptyville", "Emptyville");
  researchCalls = [];
  const t3 = await prepareOfficialDocuments(db, eJob, { llm, research: true, formsPage: fp() });
  const t3r = t3.results[0];
  check("T2 a completed empty search is a not_found with no 'could not run'", t3.acquisition === "full" && t3r?.status === "not_found" && !t3r.lookupFailed && !/could not run/.test(t3r.message),
    JSON.stringify(t3));
  check("T2 MUST-EXCLUDE the cooldown claim is kept", !t3.cooldownReleased && cooldownRow("City of Emptyville") != null, JSON.stringify({ t3: t3.cooldownReleased, row: cooldownRow("City of Emptyville") }));
  researchCalls = [];
  const t3b = await prepareOfficialDocuments(db, eJob, { llm, research: true, formsPage: fp() });
  check("T2 the next Stage is inside the cooldown and does not search again", t3b.acquisition === "within-cooldown" && researchCalls.length === 0, JSON.stringify({ t3b, researchCalls }));

  // ═══ V1 A VERIFIED KB ROW — its facts are never overwritten; the forms page merges as a segment ════
  const V = "https://www.verifield.ma.us";
  kb.saveVerifiedAhjProfile(db, { state: "MA", ahj: "City of Verifield", portalUrl: `${V}/permits/portal`, portalPlatform: "Other", submissionMethod: "online portal", notes: "Operator: file online.", verifiedBy: "tester" });
  serveHtml(`${V}/forms`, civicPage("Forms", []));
  researchFor.set("City of Verifield", { formsPageUrl: `${V}/forms`, submittalPortalUrl: "https://www.verifield.ma.us/other-portal", portalPlatform: "Email", submissionMethod: "email" });
  const vJob = mkJob("City of Verifield", "Verifield");
  await auto.ensureAhjFormTemplate(db, llm, vJob, "permit_application", { formsPage: fp() });
  await auto.ensureAhjFormTemplate(db, llm, vJob, "permit_application", { formsPage: fp() });
  const vRow = db.get<{ portal_url: string; portal_platform: string; submission_method: string; notes: string; verified_at: string | null }>(
    "SELECT portal_url, portal_platform, submission_method, notes, verified_at FROM permit_utility_knowledge WHERE lower(ahj) = 'city of verifield'");
  check("V1 the verified row's portal / platform / method are not overwritten (rule 3)", vRow?.portal_url === `${V}/permits/portal` && vRow.portal_platform === "Other" && vRow.submission_method === "online portal" && Boolean(vRow.verified_at),
    JSON.stringify(vRow));
  check("V1 the forms page lands once, as its own segment, beside the operator's note", String(vRow?.notes || "").split(" | ").filter((s) => s === `Forms page: ${V}/forms`).length === 1
    && String(vRow?.notes || "").includes("Operator: file online."), String(vRow?.notes));

  // ═══ A4 FIND / STAGE TRIGGER THE PER-AHJ PROCESS LOOKUP (the QC trigger, deduped) ════════════════
  // Waltham had no permit_process_lookups row: the lookup shipped after its one QC, and QC was the
  // only trigger. Armed exactly as the server is (a worker flag, its interval cleared — no job runs)
  // with a fake key; the injected model has no webLookup and the reader is injected, so nothing here
  // can reach the network. LAST in the file: the key is removed in `finally`.
  // (The projects are created BEFORE the key is set, so nothing but the form pass can queue a lookup.)
  const lookJob = mkJob("Town of Lookupton", "Lookupton");
  const lookJob2 = mkJob("Town of Lookupton", "Lookupton");
  const noJob = mkJob("Town of Noresearch", "Noresearch");
  const lookupJobs = (key: string) => db.query<{ id: string }>("SELECT id FROM job_queue WHERE job_type = 'permit_process_lookup' AND payload LIKE ?", [`%${key}%`]);
  // A queued job is kicked at once (enqueueJob's instant drain) — and with the fake key it would RUN.
  // Test-only, on the scratch DB: a queued lookup lands as already done, so nothing can claim it (the
  // trigger's 24h dedupe still counts it). No lookup, and no model call, ever runs here.
  db.exec("CREATE TRIGGER forms_find_test_hold AFTER INSERT ON job_queue WHEN NEW.job_type = 'permit_process_lookup' BEGIN UPDATE job_queue SET status = 'done' WHERE id = NEW.id; END;");
  const jq = await import("../src/jobQueue");
  clearInterval(jq.startJobWorker(db));
  delete process.env.PERMIT_PROCESS_LOOKUP;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  check("A4 (setup) nothing queued a lookup for these AHJs before the form pass", lookupJobs("lookupton").length === 0 && lookupJobs("noresearch").length === 0);
  researchFor.set("Town of Lookupton", {});
  await auto.ensureAhjFormTemplate(db, llm, lookJob, "permit_application", { formsPage: fp() });
  for (let i = 0; i < 50 && !lookupJobs("lookupton").length; i++) await new Promise((r) => setTimeout(r, 20));
  check("A4 MUST-PASS a Find/Stage pass for an AHJ with no process lookup queues ONE lookup", lookupJobs("lookupton").length === 1, JSON.stringify(lookupJobs("lookupton")));
  await auto.ensureAhjFormTemplate(db, llm, lookJob2, "permit_application", { formsPage: fp() });
  await new Promise((r) => setTimeout(r, 300));
  check("A4 ...deduped: a second pass does not queue another", lookupJobs("lookupton").length === 1, JSON.stringify(lookupJobs("lookupton")));
  await auto.ensureAhjFormTemplate(db, llm, noJob, "permit_application", { allowResearch: false, formsPage: fp() });
  await new Promise((r) => setTimeout(r, 300));
  check("A4 MUST-EXCLUDE the no-research pass (inside the cooldown) queues nothing", lookupJobs("noresearch").length === 0, JSON.stringify(lookupJobs("noresearch")));
  check("A4 no job ran (none claimed, no model call attempted)", db.query("SELECT id FROM job_queue WHERE status NOT IN ('done')").length === 0
    && db.query("SELECT id FROM llm_calls").length === 0, JSON.stringify(db.query("SELECT job_type, status FROM job_queue")));

  assert.equal(failed.length, 0, `${failed.length} check(s) failed: ${failed.join(" | ")}`);
  console.log(`formsFindPage: ${passed} checks passed — the AHJ's own forms page and its own search results yield its residential application (never a fee schedule, agenda, checklist, commercial/tax form, off-site link, utility host or HTML page); a search that could not run says so and releases the Stage cooldown, a completed empty one keeps it; the find audit and the KB keep the why; a verified row is not overwritten`);
} finally {
  delete process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = realFetch;
  server.close();
  db.close();
  for (const id of projectIds) fs.rmSync(path.resolve("backend/data/filled", id), { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}
// The armed job worker's drain leaves a bounded wait timer behind (jobQueue.drainPendingJobs); the
// other worker-arming tests end the same way (lookupDoors, feeResearchTrigger). Reached only when
// every check passed — a failure has already thrown.
process.exit(0);
