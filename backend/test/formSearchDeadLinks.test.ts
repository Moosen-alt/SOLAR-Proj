// FOUND, DEAD LINK (issue #205).
//
// Owner's live log, 2026-10-06 (a Utah city, the #154 pass): the AHJ form search returned two city
// DocumentCenter links, both answered HTTP 404, and the run was reported as "not found" — it started
// the 24h cooldown, so the next project in the same city got only the no-research pass, and the search
// never used the two submittal documents the per-job process lookup had already named, nor its portal.
//   1. a found blank that 404s is `dead_link` (the URL kept; the card and the gate name it);
//   2. one retry in the same run: the issuer's forms listing page, and — only when the process lookup
//      names documents — one more search for them by name, on the issuer's host, in the AHJ's state;
//   3. a run that ended only in dead links does not start the 24h cooldown (the next project may search
//      once); a genuine not_found does (existing behaviour);
//   4. where the lookup says the application is taken in the AHJ's portal and names no PDF blank, no
//      missing-blank hold.
// No network: a LOCAL http fixture server answers every request (unknown paths 404). No model: the
// research result is injected. Synthetic jurisdictions only.
//
//   npx tsx backend/test/formSearchDeadLinks.test.ts
import "./_isolate"; // FIRST: temp cwd, off the network
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { AhjFormUrlResult, LLMProvider } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "form-dead-links-"));
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
const plan = await import("../src/formAcquisitionPlan");
const reqDocs = await import("../src/requiredDocuments");
const scope = await import("../src/formSearchScope");
const { savePermitProcessLookup } = await import("../src/permitProcess");
const { createPageReader } = await import("../src/agencyPageReader");
const { prepareOfficialDocuments } = await import("../src/prepareOfficialDocuments");

const db = await openDatabase();

let passed = 0;
const failed: string[] = [];
const check = (name: string, cond: unknown, detail = ""): void => {
  if (cond) { passed++; console.log(`ok   - ${name}`); return; }
  failed.push(name);
  console.error(`FAIL - ${name}${detail ? `\n         ${detail.slice(0, 900)}` : ""}`);
};

// ── the local fixture server: "<host>/<path>" -> a response; anything else is a 404 ────────────────
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
const page = (title: string, links: Array<[string, string]>) => `<!DOCTYPE html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><ul>
${links.map(([href, text]) => `<li><a href="${href}">${text}</a></li>`).join("\n")}</ul></main></body></html>`;

// ── the injected model ────────────────────────────────────────────────────────────────────────────
type Call = { ahj: string; formType?: string; knownContext?: string; documentNames?: string[]; issuerHost?: string };
let calls: Call[] = [];
/** Per AHJ: the first search's result, and the retry's (a call carrying documentNames). */
const firstFor = new Map<string, Partial<AhjFormUrlResult>>();
const retryFor = new Map<string, Partial<AhjFormUrlResult>>();
const llm = {
  async findAhjFormUrl(input: Call) {
    calls.push(input);
    const r = (input.documentNames?.length ? retryFor.get(input.ahj) : firstFor.get(input.ahj)) ?? {};
    return { provider: "claude", formName: "", candidateUrls: [], formType: input.formType || "permit_application", confidence: "medium", notes: "", ...r };
  },
  async mapAcroFormFields() { return { provider: "claude", textFields: { "Owner name": "project.homeownerName" }, checkboxes: {}, notes: "fixture map" }; },
  async mapFlatFormOverlay() { return { provider: "claude", fields: [], signatures: [], notes: "" }; },
} as unknown as LLMProvider;
const fp = () => ({ reader: createPageReader({ minGapMs: 0 }), minGapMs: 0 });
const deps = () => ({ llm, research: true, formsPage: fp() });

const cited = (value: string, sourceUrl: string, quote: string) => ({ value, sourceUrl, quote, origin: "lookup" as const });
const notFound = (why: string) => ({ value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: why });
function saveLookup(ahj: string, permits: Array<{ discipline: "structural" | "electrical" | "combo"; portal?: string; docs?: string[]; docsSrc?: string }>, structure: "separate" | "combo") {
  const r = savePermitProcessLookup(db, {
    state: "UT", ahj, lookedUpAt: new Date().toISOString(), issuingAgency: notFound("none"),
    permitStructure: cited(structure, "https://example.gov/structure", structure === "separate" ? "separate building and electrical permits" : "one combined permit"),
    permits: permits.map((p) => ({
      discipline: p.discipline, label: `${p.discipline} permit`, issuingAgency: notFound("none"),
      portalUrl: p.portal ? cited(p.portal, p.portal, "apply online in the portal") : notFound("none"),
      recordType: notFound("none"),
      documents: p.docs ? { value: p.docs, sourceUrl: p.docsSrc ?? "", quote: "submittal documents", origin: "lookup" as const } : notFound("no list"),
      fee: notFound("none"),
    })),
    notes: [],
  } as never);
  assert.equal(r.saved, true, `lookup for ${ahj}`);
}
let n = 0;
const mkJob = (ahj: string, city: string) => repo.createProject(db, {
  owner: `Fixture Owner ${++n}`, street: `${n} Fixture Rd`, city, state: "UT", zip: "84000", ahj, utility: "Rocky Mountain Power", dcKw: "8.1", acKw: "7.6",
  permitPathOverride: "engineered", mounting: "Roof Mount", structureDescription: "Single-family dwelling",
} as never).project;
const keyOf = (ahj: string) => `ut|${ahj.toLowerCase()}|engineered`;
const cooldownRow = (ahj: string) => db.get<{ attempted_at: number }>("SELECT attempted_at FROM ahj_form_acquisition_attempts WHERE scope_key = ?", [keyOf(ahj)]);

try {
  // ═══ UNIT — the retry's queries name the documents, the state and the issuer's host ════════════
  const qs: string[] = (scope as { documentNameQueries?: typeof scope.documentNameQueries }).documentNameQueries?.("City of Fixtureville", "UT", ["Plan Submittal Checklist", "Electrical Permit Application"], "www.fixtureville.gov") ?? [];
  check("documentNameQueries: one query per document, each naming the state (full + abbr) and site:<issuer host>",
    qs.length === 2 && qs.every((q) => /Utah UT/.test(q) && /site:www\.fixtureville\.gov$/.test(q)) && qs[0].includes('"Plan Submittal Checklist"'), JSON.stringify(qs));
  check("documentNameQueries: an unknown state gives no query (no unscoped search)", (scope.documentNameQueries?.("City of Fixtureville", "", ["X application"]) ?? ["unfixed"]).length === 0);

  // ═══ 1 + 3. DEAD LINK, NO LOOKUP NAMES — dead_link, listing page only, no cooldown ═══════════════
  const A = "City of Fixtureville";
  const deadA = "https://www.fixtureville.gov/DocumentCenter/View/152/Solar-Application-PDF";
  firstFor.set(A, { candidateUrls: [deadA] });
  serveHtml("https://www.fixtureville.gov/DocumentCenter", page("Document Center", [["/DocumentCenter/View/7/Parks-Brochure", "Parks Brochure"]]));
  calls = []; requested = [];
  const p1 = mkJob(A, "Fixtureville");
  const out1 = await prepareOfficialDocuments(db, p1, deps());
  const r1 = out1.results.find((r) => r.status === "dead_link");
  check("a found blank that answers 404 is `dead_link`, not not_found", Boolean(r1) && !out1.results.some((r) => r.status === "not_found"), JSON.stringify(out1.results));
  check("the dead_link result keeps the dead URL", Boolean(r1?.deadLinks?.includes(deadA)), JSON.stringify(r1));
  check("its card text names it as a dead link, with the URL", /dead link/i.test(r1?.message || "") && (r1?.message || "").includes(deadA), r1?.message);
  check("without lookup document names: no second search (one findAhjFormUrl call per slot, none carrying documentNames)",
    calls.length >= 1 && !calls.some((c) => c.documentNames?.length), JSON.stringify(calls.map((c) => c.documentNames)));
  check("the retry read the issuer's DocumentCenter listing page", requested.some((u) => u === "https://www.fixtureville.gov/DocumentCenter"), requested.join(" "));
  check("a dead-link-only run leaves NO cooldown row (the 24h not_found cooldown was not started)", !cooldownRow(A), JSON.stringify(cooldownRow(A)));
  check("... and says the retry is open", out1.deadLinkRetryOpen === true);
  check("... and records dead_link with the URLs", plan.formDeadLinkRecord?.(db, keyOf(A))?.urls.includes(deadA) === true);
  check("the gate's research line names the dead link (stageAcquiresForm carries it)",
    plan.stageAcquiresForm(db, p1, "permit_application", null, { ...plan.stageAcquisitionFor(db, p1), research: true, researchOpen: true })?.deadLinks?.includes(deadA) === true);
  check("the gate's owed-document action names the dead URL", reqDocs.owedDocumentAction({ docType: "building_application", lane: "permit" } as never, plan.formDeadLinks?.(db, p1) ?? []).includes(deadA));

  // A second project in the same AHJ inside 24h MAY search once …
  calls = [];
  const p2 = mkJob(A, "Fixtureville");
  const out2 = await prepareOfficialDocuments(db, p2, deps());
  check("a second project in the AHJ after a dead-link run searches (acquisition full, the search ran)", out2.acquisition === "full" && calls.length >= 1, `${out2.acquisition} calls=${calls.length}`);
  check("… and, dead again, that was the one retry: the cooldown now holds", Boolean(cooldownRow(A)) && !out2.deadLinkRetryOpen);
  calls = [];
  const out3 = await prepareOfficialDocuments(db, mkJob(A, "Fixtureville"), deps());
  check("a third project inside 24h does not search (within-cooldown, no research call)", out3.acquisition === "within-cooldown" && calls.length === 0, `${out3.acquisition} calls=${calls.length}`);

  // ═══ 3. GENUINE not_found keeps the cooldown (existing behaviour) ══════════════════════════════
  const B = "Town of Plainview";
  firstFor.set(B, { candidateUrls: [], notes: "No downloadable form on the town site." });
  calls = [];
  const outB = await prepareOfficialDocuments(db, mkJob(B, "Plainview"), deps());
  check("a genuine not_found run is not dead_link and keeps its cooldown row", outB.results.every((r) => r.status !== "dead_link") && Boolean(cooldownRow(B)), JSON.stringify(outB.results.map((r) => r.status)));
  calls = [];
  const outB2 = await prepareOfficialDocuments(db, mkJob(B, "Plainview"), deps());
  check("after a genuine not_found the next project in the AHJ may NOT search", outB2.acquisition === "within-cooldown" && calls.length === 0, `${outB2.acquisition} calls=${calls.length}`);

  // ═══ 2. WITH LOOKUP DOCUMENT NAMES — the retry carries them and the issuer host; finds the blank ═══
  const C = "City of Lookupton";
  const deadC = "https://www.lookupton.gov/DocumentCenter/View/5922/Building-Permit-Application";
  const liveC = "https://www.lookupton.gov/DocumentCenter/View/9001/Electrical-Permit-Application-for-Roof-Mounted-Solar-PV";
  const offHost = "https://www.otherplace.gov/forms/Electrical-Permit-Application.pdf";
  saveLookup(C, [{ discipline: "combo", docs: ["Electrical Permit Application for Roof-Mounted Solar PV", "Plan Submittal Checklist", "Site plan"], docsSrc: "https://www.lookupton.gov/150/Solar-Permits" }], "combo");
  serveHtml("https://www.lookupton.gov/150/Solar-Permits", page("Solar Permits", [["/1/Contact", "Contact us"]]));
  servePdf(liveC, await acroPdf("Electrical Permit Application for Roof-Mounted Solar PV"));
  firstFor.set(C, { candidateUrls: [deadC] });
  retryFor.set(C, { candidateUrls: [offHost, liveC] });
  calls = []; requested = [];
  const outC = await auto.ensureAhjFormTemplate(db, llm, mkJob(C, "Lookupton"), "permit_application", { formsPage: fp(), searchPass: {} });
  const retry = calls.find((c) => c.documentNames?.length);
  check("with lookup document names on file, the retry search carries them", Boolean(retry?.documentNames?.includes("Electrical Permit Application for Roof-Mounted Solar PV")) && Boolean(retry?.documentNames?.includes("Plan Submittal Checklist")) && !retry?.documentNames?.includes("Site plan"), JSON.stringify(retry));
  check("… and the issuer's host", retry?.issuerHost === "lookupton.gov" && /site:lookupton\.gov/.test(retry?.knownContext || ""), JSON.stringify(retry));
  check("… and tells the search the dead URL is dead", (retry?.knownContext || "").includes(deadC));
  check("exactly one retry (two findAhjFormUrl calls in all)", calls.length === 2, String(calls.length));
  check("the retry read the lookup's cited documents page first", requested.includes("https://www.lookupton.gov/150/Solar-Permits"), requested.join(" "));
  check("the blank the retry found on the issuer's host is acquired", outC.status === "acquired" && outC.sourceUrl === liveC, JSON.stringify({ status: outC.status, sourceUrl: outC.sourceUrl, message: outC.message }));
  check("an off-host link from the retry is never requested (scoped to the issuer's host)", !requested.includes(offHost), requested.join(" "));

  // ═══ 2b. A SECOND SITE PLATFORM (owner ruling: universal, not per-AHJ) — a WordPress-style site with
  // opaque upload paths and no document center: the lookup's cited forms page is the listing, and the
  // link that names the lookup's document by its own title is taken. No second search is paid for.
  const auto2 = auto as typeof auto & { deadLinkListingPage?: (d: string[], s: string) => string };
  check("deadLinkListingPage: the lookup's cited documents page wins, on any platform",
    auto2.deadLinkListingPage?.(["https://www.x.gov/wp-content/uploads/a.pdf"], "https://www.x.gov/building/forms/") === "https://www.x.gov/building/forms/");
  check("deadLinkListingPage: a document-center file's own listing when the lookup cites none",
    auto2.deadLinkListingPage?.(["https://www.x.gov/DocumentCenter/View/1/A"], "") === "https://www.x.gov/DocumentCenter");
  check("deadLinkListingPage: an unknown platform with no cited page guesses nothing",
    auto2.deadLinkListingPage?.(["https://www.x.gov/wp-content/uploads/a.pdf"], "") === "");
  const W = "Village of Fixturebrook";
  const deadW = "https://www.fixturebrook.gov/wp-content/uploads/2023/02/solar-application.pdf";
  const liveW = "https://www.fixturebrook.gov/wp-content/uploads/2026/01/ep-2026.pdf";
  saveLookup(W, [{ discipline: "combo", docs: ["Electrical Permit Application for Roof-Mounted Solar PV"], docsSrc: "https://www.fixturebrook.gov/building/forms/" }], "combo");
  serveHtml("https://www.fixturebrook.gov/building/forms/", page("Building Forms", [["/wp-content/uploads/2026/01/ep-2026.pdf", "Electrical Permit Application for Roof-Mounted Solar PV"], ["/wp-content/uploads/2026/01/dog-license.pdf", "Dog License Form"]]));
  servePdf(liveW, await acroPdf("Electrical Permit Application for Roof-Mounted Solar PV"));
  firstFor.set(W, { candidateUrls: [deadW] });
  calls = []; requested = [];
  const outW = await auto.ensureAhjFormTemplate(db, llm, mkJob(W, "Fixturebrook"), "permit_application", { formsPage: fp(), searchPass: {} });
  check("second platform: the dead link's retry reads the lookup's forms page", requested.includes("https://www.fixturebrook.gov/building/forms/"), requested.join(" "));
  check("second platform: the link titled as the lookup's document (opaque URL) is acquired", outW.status === "acquired" && outW.sourceUrl === liveW, JSON.stringify({ status: outW.status, sourceUrl: outW.sourceUrl, message: outW.message }));
  check("second platform: the listing page found it, so no second search ran", calls.length === 1, String(calls.length));
  check("second platform: an unrelated form on the page is never requested", !requested.some((u) => /dog-license/.test(u)), requested.join(" "));

  // ═══ 4. PORTAL-ONLY AHJ — no missing-blank hold ════════════════════════════════════════════════
  const D = "City of Portalia";
  saveLookup(D, [
    { discipline: "structural", portal: "https://portalia.cityworks.example/PublicAccess", docs: ["Electrical Permit Application for Roof-Mounted Solar PV", "Site plan"] },
    { discipline: "electrical", portal: "https://portalia.cityworks.example/PublicAccess", docs: ["Single-line diagram"] },
  ], "separate");
  const pD = mkJob(D, "Portalia");
  const rowsD = reqDocs.requiredApplicationDocs(pD, reqDocs.applicationDocContext(pD)).filter((d) => d.docType === "building_application" || d.docType === "electrical_application");
  check("portal-only AHJ (lookup cites a portal, names no PDF): the application rows exist", rowsD.length === 2, JSON.stringify(rowsD.map((d) => d.docType)));
  check("portal-only AHJ: no missing-blank hold (rows do not block)", rowsD.length > 0 && rowsD.every((d) => !d.blocking), JSON.stringify(rowsD.map((d) => [d.docType, d.blocking])));
  check("portal-only AHJ: the row says the application is taken in the portal, no PDF blank expected", rowsD.every((d) => /no PDF blank expected/.test(d.why) && d.why.includes("portalia.cityworks.example")), rowsD.map((d) => d.why).join(" | "));
  // The same on another portal platform (an Accela-hosted portal).
  const F = "Town of Accelaville";
  saveLookup(F, [
    { discipline: "structural", portal: "https://aca-prod.accela.com/FIXTUREACCELA/Default.aspx" },
    { discipline: "electrical", portal: "https://aca-prod.accela.com/FIXTUREACCELA/Default.aspx" },
  ], "separate");
  const pF = mkJob(F, "Accelaville");
  const rowsF = reqDocs.requiredApplicationDocs(pF, reqDocs.applicationDocContext(pF)).filter((d) => d.docType === "building_application" || d.docType === "electrical_application");
  check("portal-only on a second portal platform: no missing-blank hold", rowsF.length === 2 && rowsF.every((d) => !d.blocking && /no PDF blank expected/.test(d.why)), JSON.stringify(rowsF.map((d) => [d.docType, d.blocking])));
  // … unless the lookup names a PDF blank: the hold stays.
  const E = "City of Pdfton";
  saveLookup(E, [
    { discipline: "structural", portal: "https://pdfton.cityworks.example/PublicAccess", docs: ["Building Permit Application (PDF)"] },
    { discipline: "electrical", portal: "https://pdfton.cityworks.example/PublicAccess", docs: ["Electrical Permit Application Form"] },
  ], "separate");
  const pE = mkJob(E, "Pdfton");
  const rowsE = reqDocs.requiredApplicationDocs(pE, reqDocs.applicationDocContext(pE)).filter((d) => d.docType === "building_application" || d.docType === "electrical_application");
  check("a portal AHJ whose lookup also names a PDF blank keeps the hold", rowsE.length === 2 && rowsE.every((d) => d.blocking), JSON.stringify(rowsE.map((d) => [d.docType, d.blocking])));
  // The acquisition card for a portal-only slot with nothing found says so too.
  firstFor.set(D, { candidateUrls: [] });
  const outD = await auto.ensureAhjFormTemplate(db, llm, pD, "building_application", { formsPage: fp(), searchPass: {} });
  check("portal-only AHJ: the acquisition card says no PDF blank expected", /no PDF blank expected/.test(outD.message), outD.message);
} finally {
  globalThis.fetch = realFetch;
  server.close();
}

if (failed.length) {
  console.error(`\n${failed.length} check(s) failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\nformSearchDeadLinks: all ${passed} checks passed`);
process.exit(0);
