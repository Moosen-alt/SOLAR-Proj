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
//                that could not run is reported as such and the 24h cooldown is shortened to a short
//                back-off; the audit keeps the message; every download waits the polite gap after the
//                LAST request to its host (on the real clock too); a generic slot is satisfied by the
//                building blank it was re-typed to (no re-search).
//   MUST-EXCLUDE a fee schedule, an agenda, a checklist, a commercial-only / tax application, an
//                off-site link, a utility host and an HTML page that is not a PDF are never stored
//                (and the excluded links are never even requested); another jurisdiction's site (another
//                town's .gov, the state's .gov, a same-state town's .ma.us) is never read, taken or
//                noted; any "<X> Permit Application" that does not name this job's work, and another
//                department's form whatever else it says, is never taken; a REFUSED forms page's site is
//                asked nothing more; a completed empty search keeps the cooldown, and a failing one is
//                not re-paid on every Stage.
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
const { prepareOfficialDocuments, LOOKUP_FAILED_RETRY_MS } = await import("../src/prepareOfficialDocuments");
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
const routes = new Map<string, { type: string; body: Buffer | string; status?: number }>();
const server = http.createServer((req, res) => {
  const key = decodeURIComponent(String(req.url || "")).replace(/^\//, "");
  const r = routes.get(key);
  if (!r) { res.writeHead(404, { "content-type": "text/html" }); res.end("<html><body>Page not found</body></html>"); return; }
  res.writeHead(r.status ?? 200, { "content-type": r.type });
  res.end(r.body);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const realFetch = globalThis.fetch;
let requested: string[] = [];
/** Every request with the REAL clock time it was made (the F3 real-clock gap check). */
const requestedAt: Array<{ url: string; at: number }> = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  requested.push(u.toString());
  requestedAt.push({ url: u.toString(), at: Date.now() });
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
  // ── F2 (skeptic): a POSITIVE test — the application must NAME this job's work ─────────────────────
  // Every "<X> Permit Application" a Massachusetts town's forms page lists beside the building one.
  // Each was "general" (and filled the building / generic slot) when only known-bad names were refused.
  const F2_PASS: Array<[string, string]> = [
    ["Residential Application", "general"],
    ["Solar PV Permit Application", "general"],
    ["Building Permit Application", "building"],
    ["Electrical Permit Application", "electrical"],
    ["Wiring Permit Application", "electrical"], // the electrical slot's — never the building / generic one
    ["Rooftop Solar PV Permit Application", "general"], // "roof" is not "roofing"
    ["Building, Electrical & Plumbing Permit Application", "combined"], // a multi-trade form keeps its building + electrical words
  ];
  for (const [name, discipline] of F2_PASS) {
    const got = catalog.classifyApplicationDocument(name, dc(name.replace(/[^A-Za-z]+/g, "-")));
    check(`F2 UNIT MUST-PASS "${name}" is a ${discipline} application`, got?.discipline === discipline, JSON.stringify(got));
  }
  check("F2 UNIT the wiring application never fits the building / generic slot, and fits the electrical one",
    !auto.disciplineFitsSlot(catalog.classifyApplicationDocument("Wiring Permit Application", dc("Wiring"))?.discipline ?? "general", "permit_application")
    && auto.disciplineFitsSlot(catalog.classifyApplicationDocument("Wiring Permit Application", dc("Wiring"))?.discipline ?? "general", "electrical_application"));
  const F2_EXCLUDE = ["Burn", "HVAC", "Roofing", "Deck", "Well", "Blasting", "Oil Burner", "Fire Protection", "Wood Stove", "Septic", "Title 5",
    "Elevator", "Hot Work", "Tank Removal", "Moving", "Earth Removal", "Home Occupation", "Plumbing", "Gas", "Mechanical", "Sheet Metal", "Demolition", "Sign", "Trench", "Driveway", "Pool", "Fence", "Shed",
    // Names on NO list — the positive test alone refuses them (an "<X>" nobody wrote down is still not this job's form).
    "Mooring", "Shellfish", "Beekeeping", "Kennel", "Floodplain"];
  for (const x of F2_EXCLUDE) {
    const name = `${x} Permit Application`;
    const got = catalog.classifyApplicationDocument(name, dc(name.replace(/[^A-Za-z0-9]+/g, "-")));
    check(`F2 UNIT MUST-EXCLUDE "${name}" is not the application`, got === null, JSON.stringify(got));
  }
  // "solar" / "residential" never override another department's or trade's word; a bare name says nothing.
  for (const name of ["Solar Fire Department Permit Application", "Residential Roofing Permit Application", "Residential Well Permit Application",
    "Solar Plumbing Permit Application", "Residential HVAC Permit Application", "Deck Building Permit Application", "Moving a Building Permit Application",
    "Permit Application", "Special Event Permit Application", "Street Opening Permit Application"]) {
    const got = catalog.classifyApplicationDocument(name, dc(name.replace(/[^A-Za-z]+/g, "-")));
    check(`F2 UNIT MUST-EXCLUDE "${name}" is not the application`, got === null, JSON.stringify(got));
  }
  check("F2 UNIT the Town of Wells' own residential application is not a water well's", catalog.classifyApplicationDocument("Wells Residential Building Permit Application", dc("Wells-Residential-Building-Permit-Application"))?.discipline === "building");
  check("UNIT a residential application outranks a generic one", (catalog.classifyApplicationDocument("Residential Building Permit Application", dc("R"))?.score ?? 0) > (catalog.classifyApplicationDocument("Building Permit Application", dc("P"))?.score ?? 0));
  check("UNIT the electrical-only application never fills the building-side / generic slot; the electrical slot takes only an electrical one",
    !auto.disciplineFitsSlot("electrical", "permit_application") && !auto.disciplineFitsSlot("electrical", "building_application")
    && auto.disciplineFitsSlot("electrical", "electrical_application") && !auto.disciplineFitsSlot("general", "electrical_application") && auto.disciplineFitsSlot("general", "permit_application"));
  check("UNIT two towns' <town>.<st>.us hosts are two sites (\"ma.us\" is a public suffix); a 4-label locality and a .co.us county keep theirs",
    catalog.registrableDomain("www.offsite.ma.us") === "offsite.ma.us" && catalog.registrableDomain("neighbortown.ma.us") === "neighbortown.ma.us"
    && catalog.registrableDomain("www.city.waltham.ma.us") === "city.waltham.ma.us" && catalog.registrableDomain("www.douglas.co.us") === "douglas.co.us",
    JSON.stringify([catalog.registrableDomain("www.offsite.ma.us"), catalog.registrableDomain("www.city.waltham.ma.us")]));
  // ── H (forms-find close): WHICH PERMIT is read on the HEAD phrase — never on the scope text after it ──
  // Real applications whose titles list their scope were MISSED once a department / trade word anywhere in
  // the title excluded them; a subject in the head ("Solar Rebate", "Right-of-Way Construction", "Sewer
  // Building") was TAKEN because a job word stood beside it.
  const H_PASS: Array<[string, string]> = [
    ["Residential Building Permit Application (includes solar, roofing, decks)", "building"],
    ["Electrical Permit Application - Solar PV", "electrical"],
    ["Building Permit Application: new construction, additions, alterations", "building"],
    ["Residential Building Permit Application (Additions, Alterations, Decks, Sheds)", "building"],
    ["Building Permit Application - Residential (New Homes, Additions, Decks, Pools)", "building"],
    ["Electrical Permit Application (Solar, Generators, Pools, Spas)", "electrical"],
    ["Building Permit Application - One & Two Family Dwellings (incl. re-roofing, siding)", "building"],
    ["Building Permit Application (Health Department sign-off required)", "building"],
    ["Residential Building Permit Application - Historic District", "building"],
    ["Electrical Permit Application for Solar and Fire Alarm", "electrical"],
    ["Application for Electrical Wiring Permit", "electrical"],
    // A town's own name before the head is not a subject ("Beach", "Park", "Services" are places / departments there).
    ["Palm Beach County Residential Building Permit Application", "building"],
    ["Oak Park Residential Application", "general"],
    ["Inspectional Services Building Permit Application", "building"],
    // A COMBINED building + electrical form is combined (the building side's — never the electrical slot's).
    ["Building & Wiring Permit Application", "combined"],
  ];
  for (const [name, discipline] of H_PASS) {
    const got = catalog.classifyApplicationDocument(name, dc(name.replace(/[^A-Za-z0-9]+/g, "-")));
    check(`H UNIT MUST-PASS "${name}" is a ${discipline} application`, got?.discipline === discipline, JSON.stringify(got));
  }
  for (const name of ["Solar Rebate Application", "Right-of-Way Construction Permit Application", "Sewer Building Permit Application", "Deck Building Permit Application",
    "Solar Fire Department Permit Application", "Residential Solar Rebate Application", "Solar Access Permit Application", "Building Demolition Permit Application",
    "Building Occupancy Permit Application", "Electric Service Application", "Application for Electric Service", "Street Construction Permit Application",
    "Sidewalk Construction Permit Application", "Driveway Construction Permit Application", "Stormwater Construction Permit Application",
    "Grading and Construction Permit Application", "Excavation Construction Permit Application", "Residential Transfer Station Permit Application",
    "Residential Mooring Permit Application", "Residential Beach Sticker Application", "Electric Vehicle Charging Station Permit Application",
    "Solar Easement Application", "Residential Solar Fee Waiver Application", "Solar Incentive Program Application",
    // Rule 5 reads the WHOLE name: a utility's form named in the scope is still never taken.
    "Electrical Permit Application - Utility Interconnection"]) {
    const got = catalog.classifyApplicationDocument(name, dc(name.replace(/[^A-Za-z0-9]+/g, "-")));
    check(`H UNIT MUST-EXCLUDE "${name}" is not the application`, got === null, JSON.stringify(got));
  }
  check("H UNIT a score boost never lifts an excluded head: the rebate application is refused, the building one taken, on one page",
    catalog.classifyApplicationDocument("Residential Solar Rebate Application", dc("Residential-Solar-Rebate-Application")) === null
    && catalog.classifyApplicationDocument("Building Permit Application", dc("Building-Permit-Application"))?.discipline === "building");
  // ── W (forms-find close): "wire" / "wiring" is ELECTRICAL only in a permit phrase; a COMBINED form is the building side's ──
  for (const name of ["Solar-PV-Sample-Wiring-Diagram.pdf", "wire-transfer-instructions.pdf", "Wire Transfer Authorization", "wire-fraud-notice",
    "https://www.somewhere.ma.us/files/Solar-PV-Sample-Wiring-Diagram.pdf"]) {
    check(`W UNIT MUST-EXCLUDE classifyFormType("${name}") is not the electrical application`, auto.classifyFormType(name, "permit_application") !== "electrical_application", auto.classifyFormType(name, "permit_application"));
  }
  for (const name of ["Wiring Permit Application", "Wiring-Permit-Application.pdf", "Application for Electrical Wiring Permit", "Electrical Permit Application - Building Department",
    "https://www.co.coos.or.us/sites/default/files/building/Electrical%20Permit%20Application.pdf"]) {
    check(`W UNIT MUST-PASS classifyFormType("${name}") is the electrical application`, auto.classifyFormType(name, "") === "electrical_application", auto.classifyFormType(name, ""));
  }
  for (const name of ["Building & Wiring Permit Application.pdf", "Building/Electrical Permit Application.pdf", "Building, Electrical & Plumbing Permit Application.pdf",
    "https://www.somewhere.ma.us/DocumentCenter/View/9/Building-and-Wiring-Permit-Application Building & Wiring Permit Application Building and Wiring Permit Application",
    "https://www.somewhere.ma.us/DocumentCenter/View/9/Building-Electrical-Permit-Application Building/Electrical Permit Application Building Electrical Permit Application"]) {
    check(`W UNIT a COMBINED form is the BUILDING side's, never electrical: classifyFormType("${name.slice(0, 80)}")`,
      auto.classifyFormType(name, "electrical_application") === "building_application", auto.classifyFormType(name, "electrical_application"));
  }
  check("W UNIT the combined form fits the building-side and generic slots, never the electrical one",
    auto.disciplineFitsSlot("combined", "permit_application") && auto.disciplineFitsSlot("combined", "building_application") && !auto.disciplineFitsSlot("combined", "electrical_application"));
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

  // ═══ F2 THE TOWN'S FORMS PAGE — every other "<X> Permit Application" is left alone (skeptic F2) ══════
  // A Massachusetts-shaped Applications page: the fire department's solar form, burn / well / roofing /
  // deck / HVAC / oil burner / septic / title 5 / moving / home occupation applications, and a Wiring
  // Permit Application. Every one of them is SERVED as a PDF (a door that admits it WOULD store it).
  const MA = "https://www.wireham.ma.us";
  const maLinks: Array<[string, string]> = [
    ["Solar Fire Department Permit Application", "Solar-Fire-Department-Permit-Application"],
    ["Burn Permit Application", "Burn-Permit-Application"],
    ["Well Permit Application", "Well-Permit-Application"],
    ["Residential Roofing Permit Application", "Residential-Roofing-Permit-Application"],
    ["Deck Permit Application", "Deck-Permit-Application"],
    ["HVAC Permit Application", "HVAC-Permit-Application"],
    ["Oil Burner Permit Application", "Oil-Burner-Permit-Application"],
    ["Septic / Title 5 Permit Application", "Title-5-Permit-Application"],
    ["Moving Permit Application", "Moving-Permit-Application"],
    ["Home Occupation Permit Application", "Home-Occupation-Permit-Application"],
    ["Wiring Permit Application", "Wiring-Permit-Application"],
  ];
  const maUrl = (slug: string) => `${MA}/DocumentCenter/View/${1000 + maLinks.findIndex((l) => l[1] === slug)}/${slug}`;
  const MA_WIRING = maUrl("Wiring-Permit-Application");
  serveHtml(`${MA}/forms`, civicPage("Applications", maLinks.map(([text, slug]) => [maUrl(slug).slice(MA.length), text])));
  for (const [text, slug] of maLinks) servePdf(maUrl(slug), await acroPdf(`WIREHAM ${text}`));
  researchFor.set("Town of Wireham", { formsPageUrl: `${MA}/forms` });
  const maJob = mkJob("Town of Wireham", "Wireham");
  requested = [];
  const f2 = await auto.ensureAhjFormTemplate(db, llm, maJob, "permit_application", { formsPage: fp() });
  check("F2 MUST-EXCLUDE no other department's / activity's application — nor the wiring one — fills the generic slot", f2.status === "not_found" && rows("Town of Wireham").length === 0,
    JSON.stringify({ f2, rows: rows("Town of Wireham"), requested }));
  check("F2 MUST-EXCLUDE ...and none of them is even requested", JSON.stringify(requested) === JSON.stringify([`${MA}/forms`]), JSON.stringify(requested));
  requested = [];
  const f2b = await auto.ensureAhjFormTemplate(db, llm, maJob, "electrical_application", { formsPage: fp() });
  check("F2 MUST-PASS the Wiring Permit Application IS the electrical slot's, and only it is requested", f2b.status === "acquired" && f2b.sourceUrl === MA_WIRING
    && JSON.stringify(rows("Town of Wireham").map((r) => [r.form_type, r.source_url])) === JSON.stringify([["electrical_application", MA_WIRING]])
    && JSON.stringify(requested.filter((u) => u !== `${MA}/forms`)) === JSON.stringify([MA_WIRING]), JSON.stringify({ f2b, rows: rows("Town of Wireham"), requested }));
  // A building application beside it: the generic pass takes the building one, and the wiring one rides
  // along as the ELECTRICAL extra (classifyFormType reads "Wiring" as electrical too) — never as a second
  // building-side blank.
  const MB = "https://www.wirefield.ma.us";
  const MB_BLD = `${MB}/DocumentCenter/View/1101/Residential-Building-Permit-Application`;
  const MB_WIR = `${MB}/DocumentCenter/View/1102/Wiring-Permit-Application`;
  serveHtml(`${MB}/forms`, civicPage("Applications", [[MB_BLD.slice(MB.length), "Residential Building Permit Application"], [MB_WIR.slice(MB.length), "Wiring Permit Application"]]));
  servePdf(MB_BLD, await acroPdf("WIREFIELD Residential Building Permit Application"));
  servePdf(MB_WIR, await acroPdf("WIREFIELD Wiring Permit Application"));
  researchFor.set("Town of Wirefield", { formsPageUrl: `${MB}/forms` });
  const f2c = await auto.ensureAhjFormTemplate(db, llm, mkJob("Town of Wirefield", "Wirefield"), "permit_application", { formsPage: fp() });
  const mbRows = rows("Town of Wirefield").map((r) => `${r.form_type}|${r.source_url}`).sort();
  check("F2 MUST-PASS the building application fills the building side and the wiring one the electrical slot", f2c.status === "acquired" && f2c.sourceUrl === MB_BLD
    && JSON.stringify(mbRows) === JSON.stringify([`building_application|${MB_BLD}`, `electrical_application|${MB_WIR}`].sort()), JSON.stringify({ f2c, mbRows }));

  // ═══ W1 A COMBINED "Building & Wiring" FORM is the building side's — the AHJ's electrical row is untouched ═══
  // (skeptic P11/P8/P8b) The generic slot's only candidate is a combined form: it was re-typed to
  // electrical_application at the store, replacing the AHJ's HUMAN-VERIFIED electrical application, and
  // left the building / generic slot unsatisfied — a paid re-search and re-download on every pass.
  const CW = "https://www.combiwire.ma.us";
  const CW_APP = `${CW}/DocumentCenter/View/1500/Building-and-Wiring-Permit-Application`;
  serveHtml(`${CW}/forms`, civicPage("Forms", [[CW_APP.slice(CW.length), "Building & Wiring Permit Application"]]));
  servePdf(CW_APP, await acroPdf("COMBIWIRE Building and Wiring Permit Application"));
  auto.storeAhjFormTemplate(db, { ahjName: "Town of Combiwire", state: "MA", formType: "electrical_application", filename: "Town of Combiwire Electrical Permit Application.pdf",
    bytes: await acroPdf("COMBIWIRE VERIFIED electrical"),
    map: { formName: "Town of Combiwire Electrical Permit Application", sourceUrl: `${CW}/verified-electrical.pdf`, fillMode: "acroform", textFields: { "Owner name": "project.homeownerName" }, checkboxes: {} } as never });
  db.run("UPDATE ahj_form_templates SET field_map = json_set(field_map, '$.verified', json('true')) WHERE ahj_name = ? AND form_type = 'electrical_application'", ["Town of Combiwire"]);
  const cwElec = () => db.query<{ source_url: string; field_map: string }>("SELECT source_url, field_map FROM ahj_form_templates WHERE ahj_name = ? AND form_type = 'electrical_application'", ["Town of Combiwire"])
    .map((r) => `${r.source_url}|${JSON.parse(r.field_map).verified === true}`);
  researchFor.set("Town of Combiwire", { formsPageUrl: `${CW}/forms` });
  const cwJob = mkJob("Town of Combiwire", "Combiwire");
  const w1 = await auto.ensureAhjFormTemplate(db, llm, cwJob, "permit_application", { formsPage: fp() });
  check("W1 MUST-PASS the combined form is stored as the BUILDING application", w1.status === "acquired"
    && rows("Town of Combiwire").some((r) => r.form_type === "building_application" && r.source_url === CW_APP), JSON.stringify({ w1, rows: rows("Town of Combiwire") }));
  check("W1 MUST-EXCLUDE the AHJ's electrical application (verified) is untouched", JSON.stringify(cwElec()) === JSON.stringify([`${CW}/verified-electrical.pdf|true`]), JSON.stringify(cwElec()));
  researchCalls = [];
  requested = [];
  const w1b = await auto.ensureAhjFormTemplate(db, llm, cwJob, "permit_application", { formsPage: fp() });
  check("W1 MUST-PASS the next generic pass answers 'exists' — no paid search, no request", w1b.status === "exists" && researchCalls.length === 0 && requested.length === 0,
    JSON.stringify({ w1b, researchCalls, requested }));
  const w1c = await auto.ensureAhjFormTemplate(db, llm, cwJob, "building_application", { formsPage: fp() });
  check("W1 MUST-PASS ...and the building slot is satisfied by it too", w1c.status === "exists" && researchCalls.length === 0, JSON.stringify({ w1c, researchCalls }));
  // A SAMPLE WIRING DIAGRAM the model lists after the application is never the electrical application.
  const DG = "https://www.diagramton.ma.us";
  const DG_APP = `${DG}/files/Residential-Application.pdf`;
  const DG_DIA = `${DG}/files/Solar-PV-Sample-Wiring-Diagram.pdf`;
  servePdf(DG_APP, await acroPdf("DIAGRAMTON Residential Application"));
  servePdf(DG_DIA, await acroPdf("DIAGRAMTON sample three-line wiring diagram"));
  researchFor.set("Town of Diagramton", { candidateUrls: [DG_APP, DG_DIA] });
  const w2 = await auto.ensureAhjFormTemplate(db, llm, mkJob("Town of Diagramton", "Diagramton"), "permit_application", { formsPage: fp() });
  check("W2 MUST-EXCLUDE a sample wiring diagram is never stored as the electrical application", w2.status === "acquired"
    && !rows("Town of Diagramton").some((r) => r.form_type === "electrical_application"), JSON.stringify({ w2, rows: rows("Town of Diagramton") }));

  // ═══ H1 THE HEAD PHRASE on a real forms page ═════════════════════════════════════════════════════════
  // A building application whose title lists its scope is taken; a rebate / sewer / right-of-way / electric
  // service application beside it is never requested — and never ranked above it by "solar" / "residential".
  const HP = "https://www.headville.ma.us";
  const hpLinks: Array<[string, string]> = [
    ["Residential Solar Rebate Application", "Residential-Solar-Rebate-Application"],
    ["Building Sewer Permit Application", "Building-Sewer-Permit-Application"],
    ["Right-of-Way Construction Permit Application", "Right-of-Way-Construction-Permit-Application"],
    ["Electric Service Application", "Electric-Service-Application"],
    ["Residential Building Permit Application (Additions, Alterations, Decks, Sheds)", "Residential-Building-Permit-Application"],
  ];
  const hpUrl = (slug: string) => `${HP}/DocumentCenter/View/${1600 + hpLinks.findIndex((l) => l[1] === slug)}/${slug}`;
  serveHtml(`${HP}/forms`, civicPage("Applications", hpLinks.map(([text, slug]) => [hpUrl(slug).slice(HP.length), text])));
  for (const [text, slug] of hpLinks) servePdf(hpUrl(slug), await acroPdf(`HEADVILLE ${text}`));
  researchFor.set("Town of Headville", { formsPageUrl: `${HP}/forms` });
  const hpJob = mkJob("Town of Headville", "Headville");
  requested = [];
  const h1 = await auto.ensureAhjFormTemplate(db, llm, hpJob, "permit_application", { formsPage: fp() });
  const HP_BLD = hpUrl("Residential-Building-Permit-Application");
  check("H1 MUST-PASS the building application whose title lists its scope is the one stored", h1.status === "acquired" && h1.sourceUrl === HP_BLD
    && JSON.stringify(rows("Town of Headville").map((r) => [r.form_type, r.source_url])) === JSON.stringify([["building_application", HP_BLD]]), JSON.stringify({ h1, rows: rows("Town of Headville") }));
  check("H1 MUST-EXCLUDE the rebate / sewer / right-of-way / electric-service applications are never requested",
    JSON.stringify(requested) === JSON.stringify([`${HP}/forms`, HP_BLD]), JSON.stringify(requested));
  requested = [];
  const h1e = await auto.ensureAhjFormTemplate(db, llm, hpJob, "electrical_application", { formsPage: fp() });
  check("H1 MUST-EXCLUDE a municipal utility's Electric Service Application never fills the electrical slot", h1e.status === "not_found"
    && !rows("Town of Headville").some((r) => r.form_type === "electrical_application") && !requested.includes(hpUrl("Electric-Service-Application")), JSON.stringify({ h1e, requested }));

  // ═══ R1 THE RE-TYPE LOOP — a slot is satisfied by the stored type its blank was re-typed to ═══════════
  // A "Building Permit Application" fetched for the GENERIC slot is stored as building_application (the
  // form's own name decides — storeAhjFormTemplate). A generic slot that accepted only
  // permit_application re-searched (paid) and re-downloaded it on every pass.
  const RT = "https://www.retypeton.ma.us";
  const RT_APP = `${RT}/DocumentCenter/View/1300/Building-Permit-Application`;
  serveHtml(`${RT}/forms`, civicPage("Forms", [[RT_APP.slice(RT.length), "Building Permit Application"]]));
  servePdf(RT_APP, await acroPdf("RETYPETON Building Permit Application"));
  researchFor.set("Town of Retypeton", { formsPageUrl: `${RT}/forms` });
  const rtJob = mkJob("Town of Retypeton", "Retypeton");
  const r1 = await auto.ensureAhjFormTemplate(db, llm, rtJob, "permit_application", { formsPage: fp() });
  check("R1 (setup) the building application fetched for the generic slot is stored RE-TYPED as building_application",
    r1.status === "acquired" && JSON.stringify(rows("Town of Retypeton").map((r) => [r.form_type, r.source_url])) === JSON.stringify([["building_application", RT_APP]]),
    JSON.stringify({ r1, rows: rows("Town of Retypeton") }));
  researchCalls = [];
  requested = [];
  const r1b = await auto.ensureAhjFormTemplate(db, llm, rtJob, "permit_application", { formsPage: fp() });
  check("R1 MUST-PASS the next pass answers 'exists' off the re-typed row — no paid search, no request", r1b.status === "exists" && researchCalls.length === 0 && requested.length === 0
    && rows("Town of Retypeton").length === 1, JSON.stringify({ r1b, researchCalls, requested }));
  check("R1 UNIT one answer for which stored types satisfy a slot: the generic slot takes a building blank unless the permits are SEPARATE; the electrical slot only its own",
    JSON.stringify(auto.storedTypesForSlot("permit_application", "unknown")) === JSON.stringify(["permit_application", "building_application"])
    && JSON.stringify(auto.storedTypesForSlot("permit_application", "combo")) === JSON.stringify(["permit_application", "building_application"])
    && JSON.stringify(auto.storedTypesForSlot("permit_application", "separate")) === JSON.stringify(["permit_application"])
    && JSON.stringify(auto.storedTypesForSlot("building_application", "separate")) === JSON.stringify(["building_application", "permit_application"])
    && JSON.stringify(auto.storedTypesForSlot("electrical_application", "unknown")) === JSON.stringify(["electrical_application"]));
  // MUST-EXCLUDE: the electrical slot is never satisfied by the building blank (it still searches).
  researchCalls = [];
  const r1c = await auto.ensureAhjFormTemplate(db, llm, rtJob, "electrical_application", { formsPage: fp() });
  check("R1 MUST-EXCLUDE the electrical slot is not satisfied by the stored building blank", r1c.status !== "exists" && researchCalls.length === 1, JSON.stringify({ r1c, researchCalls }));

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
  // A research result carrying NOTHING but another town's forms page writes no research profile into the
  // AHJ's KB row at all (the row the project itself created stays as it was).
  researchFor.set("Town of Barewick", { formsPageUrl: `${NEIGHBOURS.townGov}/forms` });
  await auto.ensureAhjFormTemplate(db, llm, mkJob("Town of Barewick", "Barewick"), "permit_application", { formsPage: fp() });
  const bareRow = db.get<{ notes: string }>("SELECT notes FROM permit_utility_knowledge WHERE lower(ahj) = 'town of barewick'");
  const bareResearched = db.query<{ id: string }>("SELECT id FROM knowledge_events WHERE event_type = 'ahj.ai_researched' AND details LIKE ?", ["%Town of Barewick%"]);
  check("F1 MUST-EXCLUDE a result carrying only another town's forms page writes no research profile for the AHJ",
    bareResearched.length === 0 && !String(bareRow?.notes || "").includes(new URL(NEIGHBOURS.townGov).host), JSON.stringify({ bareRow, bareResearched }));

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

  // ═══ F3 GO GENTLY ON THE REAL CLOCK — every request is measured from the LAST one to that host ═══════
  // G1/G2 inject a sleep that never advances Date.now(), so they cannot see WHICH request the gap was
  // measured from. Here the clock is real (no injected sleep, a 300 ms gap): the forms page is read, the
  // model's own link on that host is fetched and answers with HTML (no PDF — not "found"), then the
  // application the page links is fetched. Each request must wait the gap after the one BEFORE it —
  // not after the forms page read (skeptic F3: a failed model link was never recorded on its host).
  const RC = "https://www.realclockton.ma.us";
  const RC_MODEL = `${RC}/DocumentCenter/View/1200/Old-Form`;
  const RC_APP = `${RC}/DocumentCenter/View/1201/Residential-Application`;
  serveHtml(`${RC}/forms`, civicPage("Forms", [[RC_APP.slice(RC.length), "Residential Application"]]));
  serveHtml(RC_MODEL, "<html><body><h1>Document Center</h1><p>This document has been removed.</p></body></html>");
  servePdf(RC_APP, await acroPdf("REALCLOCKTON Residential Application"));
  researchFor.set("Town of Realclockton", { formsPageUrl: `${RC}/forms`, candidateUrls: [RC_MODEL] });
  const GAP = 300;
  requestedAt.length = 0;
  const f3 = await auto.ensureAhjFormTemplate(db, llm, mkJob("Town of Realclockton", "Realclockton"), "permit_application",
    { formsPage: { reader: createPageReader({ minGapMs: 0 }), minGapMs: GAP } });
  const rcAt = (u: string) => requestedAt.find((r) => r.url === u)?.at ?? NaN;
  const rcOrder = requestedAt.filter((r) => r.url.startsWith(RC)).map((r) => r.url);
  check("F3 (setup) the forms page, the model's link, then the application — in that order, and the application is stored",
    f3.status === "acquired" && f3.sourceUrl === RC_APP && JSON.stringify(rcOrder) === JSON.stringify([`${RC}/forms`, RC_MODEL, RC_APP]), JSON.stringify({ f3: f3.status, rcOrder }));
  check("F3 the model's link waited the gap after the forms page read (real clock)", rcAt(RC_MODEL) - rcAt(`${RC}/forms`) >= GAP - 10,
    JSON.stringify({ gapMs: rcAt(RC_MODEL) - rcAt(`${RC}/forms`) }));
  check("F3 MUST-PASS the application waited the gap after the model's FAILED link — the last request to that host", rcAt(RC_APP) - rcAt(RC_MODEL) >= GAP - 10,
    JSON.stringify({ gapMs: rcAt(RC_APP) - rcAt(RC_MODEL) }));

  // ═══ B1 A REFUSED FORMS PAGE — nothing the harvest found on that site is requested (go gently) ═══════
  // The forms page answers 403 with a challenge: the reader backs the host off, and the search results on
  // that site (which WOULD serve a PDF) are dropped rather than becoming the next requests to a host that
  // just refused us. A MISSING page (404) is not a refusal: its site's search results are still taken.
  const RF = "https://www.refuseton.ma.us";
  const RF_APP = `${RF}/DocumentCenter/View/1400/Residential-Application`;
  routes.set(`${RF}/forms`.replace(/^https?:\/\//, ""), { type: "text/html; charset=utf-8", status: 403, body: "<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing. Cloudflare Ray ID</body></html>" });
  servePdf(RF_APP, await acroPdf("REFUSETON Residential Application"));
  researchFor.set("Town of Refuseton", { formsPageUrl: `${RF}/forms`, searchResults: [{ url: RF_APP, title: "Residential Application | Refuseton, MA" }] });
  requested = [];
  const b1 = await auto.ensureAhjFormTemplate(db, llm, mkJob("Town of Refuseton", "Refuseton"), "permit_application", { formsPage: fp() });
  check("B1 MUST-EXCLUDE a refused forms page: the search result on that site is never requested or stored", b1.status === "not_found" && rows("Town of Refuseton").length === 0
    && JSON.stringify(requested) === JSON.stringify([`${RF}/forms`]), JSON.stringify({ b1, requested }));
  check("B1 the not-found says the page refused the read, and nothing else was asked of that site", /refused the read .*nothing else was requested from that site/.test(b1.message), b1.message);
  // B1c THE MODEL'S OWN LINK on the refused site is not requested either (skeptic P6b: it was, right after
  // a message saying nothing else was). It SERVES a PDF, so a door that admits it WOULD store it.
  const RM = "https://www.refusemodel.ma.us";
  const RM_MODEL = `${RM}/DocumentCenter/View/1402/Residential-Application`;
  routes.set(`${RM}/forms`.replace(/^https?:\/\//, ""), { type: "text/html; charset=utf-8", status: 403, body: "<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing. Cloudflare Ray ID</body></html>" });
  servePdf(RM_MODEL, await acroPdf("REFUSEMODEL Residential Application"));
  researchFor.set("Town of Refusemodel", { formsPageUrl: `${RM}/forms`, candidateUrls: [RM_MODEL] });
  requested = [];
  const b1c = await auto.ensureAhjFormTemplate(db, llm, mkJob("Town of Refusemodel", "Refusemodel"), "permit_application", { formsPage: fp() });
  check("B1c MUST-EXCLUDE the model's own link on the refused site is never requested or stored", b1c.status === "not_found" && rows("Town of Refusemodel").length === 0
    && JSON.stringify(requested) === JSON.stringify([`${RM}/forms`]), JSON.stringify({ b1c, requested }));
  check("B1c the message is true: nothing else was requested (the model's link named), and it does not report 'no form was found'",
    /nothing else was requested from that site/.test(b1c.message) && /1 other link\(s\) on that site .* were not requested either/.test(b1c.message)
    && !/No downloadable PDF form was found/.test(b1c.message), b1c.message);
  // MUST-PASS: the model's link on ANOTHER site is still requested and stored (only the refused site is spared).
  const RD = "https://www.refusedocs.ma.us";
  const RD_MODEL = `${RD}/DocumentCenter/View/1403/Residential-Application`;
  const RD_ELSE = "https://docs.refusedocsfiles.com/Residential-Application.pdf";
  routes.set(`${RD}/forms`.replace(/^https?:\/\//, ""), { type: "text/html; charset=utf-8", status: 403, body: "<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing. Cloudflare Ray ID</body></html>" });
  servePdf(RD_MODEL, await acroPdf("REFUSEDOCS Residential Application"));
  servePdf(RD_ELSE, await acroPdf("REFUSEDOCS2 Residential Application"));
  researchFor.set("Town of Refusedocs", { formsPageUrl: `${RD}/forms`, candidateUrls: [RD_MODEL, RD_ELSE] });
  requested = [];
  const b1d = await auto.ensureAhjFormTemplate(db, llm, mkJob("Town of Refusedocs", "Refusedocs"), "permit_application", { formsPage: fp() });
  check("B1c MUST-PASS a link on another site is still requested and stored", b1d.status === "acquired" && b1d.sourceUrl === RD_ELSE
    && JSON.stringify(requested) === JSON.stringify([`${RD}/forms`, RD_ELSE]), JSON.stringify({ b1d, requested }));
  const MS ="https://www.missington.ma.us";
  const MS_APP = `${MS}/DocumentCenter/View/1401/Residential-Application`;
  servePdf(MS_APP, await acroPdf("MISSINGTON Residential Application"));
  researchFor.set("Town of Missington", { formsPageUrl: `${MS}/forms-moved`, searchResults: [{ url: MS_APP, title: "Residential Application | Missington, MA" }] });
  requested = [];
  const b1b = await auto.ensureAhjFormTemplate(db, llm, mkJob("Town of Missington", "Missington"), "permit_application", { formsPage: fp() });
  check("B1 MUST-PASS a MISSING forms page (404) is not a refusal: the search result on that site is still taken", b1b.status === "acquired" && b1b.sourceUrl === MS_APP
    && requested.includes(MS_APP), JSON.stringify({ b1b, requested }));

  // ═══ T1 A SEARCH THAT COULD NOT RUN — reported as such; the 24h claim is SHORTENED to a short back-off ═══
  // Never kept for 24h ("we could not look" is not a day of "no form") and never released to zero (an AHJ
  // whose search keeps failing would pay for a search on EVERY Stage / learn / auto-stage — skeptic).
  const T = "https://www.timeoutville.ma.us";
  const T_APP = `${T}/DocumentCenter/View/901/Residential-Application`;
  const T_KEY = "ma|city of timeoutville|engineered";
  const DAY = 24 * 60 * 60 * 1000;
  serveHtml(`${T}/forms`, civicPage("Forms", [[T_APP.slice(T.length), "Residential Application"]]));
  servePdf(T_APP, await acroPdf("TIMEOUTVILLE Residential Application"));
  researchFor.set("City of Timeoutville", { lookupFailed: true, lookupError: "Request was aborted." });
  const tJob = mkJob("City of Timeoutville", "Timeoutville");
  researchCalls = [];
  const t1From = Date.now();
  const t1 = await prepareOfficialDocuments(db, tJob, { llm, research: true, formsPage: fp() });
  const t1To = Date.now();
  const t1r = t1.results.find((r) => r.formType === "permit_application") ?? t1.results[0];
  check("T1 the Stage ran the full pass and its search was asked", t1.acquisition === "full" && researchCalls.includes("City of Timeoutville"), JSON.stringify({ t1, researchCalls }));
  check("T1 MUST-PASS the result is 'could not run' — not a finding about the AHJ", t1r?.status === "not_found" && t1r.lookupFailed === true
    && /The form search could not run: Request was aborted\. — not a finding about City of Timeoutville/.test(t1r.message) && !/No downloadable PDF form was found/.test(t1r.message),
    JSON.stringify(t1r));
  const t1Row = cooldownRow("City of Timeoutville");
  check("T1 MUST-PASS the 24h claim is shortened to the short back-off (it reopens LOOKUP_FAILED_RETRY_MS after the claim)", t1.cooldownReleased === true && t1Row != null
    && t1Row.attempted_at >= t1From - DAY + LOOKUP_FAILED_RETRY_MS && t1Row.attempted_at <= t1To - DAY + LOOKUP_FAILED_RETRY_MS && LOOKUP_FAILED_RETRY_MS > 0 && LOOKUP_FAILED_RETRY_MS <= 2 * 60 * 60 * 1000,
    JSON.stringify({ released: t1.cooldownReleased, row: t1Row, t1From, LOOKUP_FAILED_RETRY_MS }));
  // MUST-EXCLUDE: never released to zero — a Stage inside the back-off (the search still failing) does not
  // pay for another search; it runs the free pass.
  researchCalls = [];
  const t1x = await prepareOfficialDocuments(db, tJob, { llm, research: true, formsPage: fp() });
  check("T1 MUST-EXCLUDE inside the back-off the next Stage does not search again (a persistently failing search is not paid for on every Stage)",
    t1x.acquisition === "within-cooldown" && researchCalls.length === 0, JSON.stringify({ t1x, researchCalls }));
  // After the back-off (the claim moved back past it, as time would), the next Stage searches again — and
  // this time the search runs and the form is found.
  db.run("UPDATE ahj_form_acquisition_attempts SET attempted_at = attempted_at - ? WHERE scope_key = ?", [LOOKUP_FAILED_RETRY_MS + 1000, T_KEY]);
  researchFor.set("City of Timeoutville", { formsPageUrl: `${T}/forms` });
  researchCalls = [];
  const t1bFrom = Date.now();
  const t1b = await prepareOfficialDocuments(db, tJob, { llm, research: true, formsPage: fp() });
  check("T1 after the back-off the next Stage is the full pass again, searches, and acquires the form", t1b.acquisition === "full" && researchCalls.includes("City of Timeoutville")
    && t1b.results.some((r) => r.status === "acquired") && rows("City of Timeoutville").some((r) => r.source_url === T_APP), JSON.stringify({ t1b, researchCalls }));
  check("T1 ...and that completed pass keeps its full 24h claim", (cooldownRow("City of Timeoutville")?.attempted_at ?? 0) >= t1bFrom && !t1b.cooldownReleased,
    JSON.stringify(cooldownRow("City of Timeoutville")));
  // A prior attempt older than 24h: the shortened claim is the back-off, never the prior's time (that
  // would reopen at once — the release-to-zero this replaces).
  const tJob2 = mkJob("City of Oldclaim", "Oldclaim");
  const old = Date.now() - 25 * 60 * 60 * 1000;
  db.run("INSERT INTO ahj_form_acquisition_attempts(scope_key, attempted_at) VALUES (?, ?)", ["ma|city of oldclaim|engineered", old]);
  researchFor.set("City of Oldclaim", { lookupFailed: true, lookupError: "Request timed out." });
  const t2From = Date.now();
  const t2 = await prepareOfficialDocuments(db, tJob2, { llm, research: true, formsPage: fp() });
  check("T1 a failed search after a prior attempt older than 24h holds the back-off, not the prior's time", t2.acquisition === "full" && t2.cooldownReleased === true
    && (cooldownRow("City of Oldclaim")?.attempted_at ?? 0) >= t2From - DAY + LOOKUP_FAILED_RETRY_MS, JSON.stringify({ t2: t2.cooldownReleased, row: cooldownRow("City of Oldclaim"), old }));

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
  console.log(`formsFindPage: ${passed} checks passed — the AHJ's own forms page and its own search results yield its residential application (never a fee schedule, agenda, checklist, commercial/tax form, off-site link, utility host or HTML page); never another jurisdiction's site or another department's "<X> Permit Application" (Wiring is electrical); every download waits the gap after the LAST request to its host, and a refused site is asked nothing more; a search that could not run says so and shortens the Stage cooldown to a short back-off (never zero), a completed empty one keeps it; a re-typed building blank satisfies the generic slot; the find audit and the KB keep the why; a verified row is not overwritten`);
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
