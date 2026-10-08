// THE AHJ'S OWN DESIGN-CRITERIA PAGE IS READ FIRST (#210).
//
// A city that publishes a plain "Design Criteria" page on its own (CivicPlus) site got "looked up,
// no jurisdiction-wide value found" from the web-search lookup: the search never reached the page.
// The lookup now probes the issuer's own host first (issuerDesignCriteria.ts) — generic across CMS
// platforms, no AHJ names or URLs in src — and grounds on what it reads. This pins:
//   1. a CivicPlus-style HTML table (shaped like Saratoga Springs UT's /213/Design-Criteria page,
//      reached through the CMS's own site search) lands roof snow 30, ground snow 31, wind 103 /
//      exposure "B or C", seismic D2, frost 30, weathering severe, termite, soil bearing — seeded,
//      cited to the page — and the fake LLM sees NO search call;
//   2. a non-CivicPlus layout (a WordPress building page linking a PDF "Requirements to be Shown on
//      Drawings" sheet) lands the same way, and its "Floor, Sleeping 30 psf" row is no roof snow;
//   3. a candidate page whose table does not parse: the web round runs grounded on that page, and
//      the record and the reviewer say "candidate page found, not parsed: <url>", never "no
//      jurisdiction-wide value";
//   4. a city site with no such page, and an AHJ with no host on file, behave exactly as before;
//   5. rule 3: a human-verified row is never touched by what the probe read;
//   6. the label binding: "Floor, Sleeping 30 pounds" / "Roof live load" are not roof snow, and
//      "103 [51] exposure B or C" stores wind 103 and exposure "B or C" (never one picked letter).
// NO LIVE NETWORK: every page is served by a fake transport (_isolate also refuses any other fetch).
//
//   npx tsx backend/test/issuerDesignCriteriaPage.test.ts
import "./_isolate"; // FIRST: temp cwd, off the network
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { DesignCriteriaResearchResult, LLMProvider, PermitProcessLookup } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "issuer-design-criteria-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CODE_RESEARCH;
delete process.env.SKIP_CODE_RESEARCH;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const CP = await import("../src/codeProfiles");
const { enqueueJob } = await import("../src/jobQueue");
const { createPageReader } = await import("../src/agencyPageReader");
const { savePermitProcessLookup } = await import("../src/permitProcess");
const { parseDesignCriteriaLookup } = await import("../src/llm");
const P = await import("../src/issuerDesignCriteria");
const db = await openDatabase();

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
};

// ── Fixtures ────────────────────────────────────────────────────────────────────────────
type Served = { status?: number; contentType: string; text?: string; bytes?: Uint8Array };
const site = new Map<string, Served>();
const html = (body: string, head = "") => `<!doctype html><html><head><title>${/<h1>(.*?)<\/h1>/.exec(body)?.[1] ?? "City"}</title>${head}</head><body>${body}</body></html>`;
const serve = (url: string, s: Served) => site.set(url, s);
const fetched: string[] = [];
const fakeFetch = async (url: string) => {
  fetched.push(url);
  const s = site.get(url);
  if (!s) return { ok: false, status: 404, contentType: "text/html", text: "Not found", finalUrl: url, reason: "HTTP 404" };
  return { ok: true, status: s.status ?? 200, contentType: s.contentType, text: s.text, bytes: s.bytes, finalUrl: url, reason: `HTTP ${s.status ?? 200}` };
};
const reader = () => createPageReader({ fetch: fakeFetch, minGapMs: 0, maxReads: P.ISSUER_PROBE_MAX_READS });

// 1. CIVICPLUS: a city's own Design Criteria page, shaped like Saratoga Springs UT's
// (https://www.saratogasprings-ut.gov/213/Design-Criteria, fetched 2026-10-06) under a synthetic city
// name and host — the real city carries a reference-data row of its own, which this must not lean on.
const SS = { state: "UT", ahj: "City of Cedar Bluffs" };
const SS_HOST = "https://www.cedarbluffs-ut.gov";
const SS_PAGE = `${SS_HOST}/213/Design-Criteria`;
const CIVICPLUS_HEAD = `<link rel="stylesheet" href="/Assets/Styles/civicplus.css"><script src="/Common/Controls/CivicEngage.js"></script>`;
serve(`${SS_HOST}/`, { contentType: "text/html", text: html(`<h1>Cedar Bluffs, UT</h1><nav><a href="/150/Building">Building</a></nav><a href="/AgendaCenter">Agendas</a><a href="/DocumentCenter/View/12">Budget</a>`, CIVICPLUS_HEAD) });
serve(`${SS_HOST}/Search?searchPhrase=design%20criteria`, { contentType: "text/html", text: html(`<h1>Search Results</h1><ol><li><a href="/213/Design-Criteria">Design Criteria</a> Roof snow, ground snow, wind speed</li><li><a href="/208/Applications-Forms">Applications &amp; Forms</a></li></ol>`, CIVICPLUS_HEAD) });
serve(SS_PAGE, { contentType: "text/html", text: html(`<h1>Design Criteria</h1>
<p>The following design criteria apply to all construction within the City.</p>
<table>
<tr><td>Roof Snow Load</td><td>30 pounds</td></tr>
<tr><td>Ground Snow Load</td><td>31 pounds</td></tr>
<tr><td>Wind Speed</td><td>103 [51] exposure B or C</td></tr>
<tr><td>Seismic Design Category</td><td>D2</td></tr>
<tr><td>Frost Line Depth</td><td>30 inches</td></tr>
<tr><td>Weathering</td><td>Severe</td></tr>
<tr><td>Termite</td><td>Slight to Moderate</td></tr>
<tr><td>Decay</td><td>None to Slight</td></tr>
<tr><td>Winter Design Temperature</td><td>5 degrees F</td></tr>
<tr><td>Floor, Sleeping</td><td>30 pounds</td></tr>
<tr><td>Floor, Living</td><td>40 pounds</td></tr>
<tr><td>Soil Bearing</td><td>1,500 psf (assumed; exception: one subdivision, 1,200 psf)</td></tr>
</table>`, CIVICPLUS_HEAD) });

// 2. WORDPRESS: a building page that links a PDF criteria sheet (synthetic town).
const WP = { state: "CO", ahj: "Town of Examplefield" };
const WP_HOST = "https://www.examplefieldco.gov";
const WP_PDF = `${WP_HOST}/wp-content/uploads/2025/01/drawing-requirements.pdf`;
const WP_HEAD = `<link rel="stylesheet" href="/wp-content/themes/town/style.css"><script src="/wp-includes/js/jquery.js"></script>`;
serve(`${WP_HOST}/`, { contentType: "text/html", text: html(`<h1>Town of Examplefield</h1><main><a href="/departments/building/">Building Department</a><a href="/news/">News</a></main>`, WP_HEAD) });
serve(`${WP_HOST}/departments/building/`, { contentType: "text/html", text: html(`<h1>Building Department</h1><p>Plans must show the town's criteria.</p><a href="${WP_PDF}">Requirements to be Shown on Drawings (PDF)</a>`, WP_HEAD) });
const pdfSheet = async (rows: Array<[string, string]>): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("REQUIREMENTS TO BE SHOWN ON DRAWINGS", { x: 50, y: 740, size: 12, font });
  page.drawText("Climatic and Geographic Design Criteria", { x: 50, y: 720, size: 10, font });
  rows.forEach(([label, value], i) => {
    page.drawText(label, { x: 50, y: 690 - i * 20, size: 10, font });
    page.drawText(value, { x: 320, y: 690 - i * 20, size: 10, font });
  });
  return doc.save();
};
serve(WP_PDF, { contentType: "application/pdf", bytes: await pdfSheet([
  ["Ground Snow Load", "40 psf"],
  ["Ultimate Design Wind Speed", "115 mph"],
  ["Wind Exposure", "C"],
  ["Seismic Design Category", "B"],
  ["Frost Line Depth", "36 inches"],
  ["Floor, Sleeping", "30 psf"],
  ["Roof Live Load", "20 psf"],
]) });

// 3. A CANDIDATE THAT DOES NOT PARSE: the table is an image (synthetic city).
const UN = { state: "ID", ahj: "City of Testbrook" };
const UN_HOST = "https://www.testbrook.gov";
const UN_PAGE = `${UN_HOST}/building/design-criteria`;
serve(`${UN_HOST}/`, { contentType: "text/html", text: html(`<h1>City of Testbrook</h1><a href="/building/design-criteria">Design Criteria</a>`) });
serve(UN_PAGE, { contentType: "text/html", text: html(`<h1>Design Criteria</h1><p>The City's design criteria are shown in the table below.</p><img src="/images/criteria-table.png" alt="criteria table">`) });

// 4. A CITY SITE WITH NO SUCH PAGE (synthetic city).
const NO = { state: "NV", ahj: "City of Plainview" };
const NO_HOST = "https://www.plainviewnv.gov";
serve(`${NO_HOST}/`, { contentType: "text/html", text: html(`<h1>City of Plainview</h1><a href="/parks/">Parks</a><a href="/news/">News</a>`) });

/** The issuer host on file: the AHJ's permit-process lookup cites its own page. */
const seedProcess = (who: { state: string; ahj: string }, agencyUrl: string) => {
  const r = savePermitProcessLookup(db, {
    state: who.state, ahj: who.ahj, lookedUpAt: new Date().toISOString(), permits: [],
    issuingAgency: { value: who.ahj, sourceUrl: agencyUrl, quote: "Building permits are issued by the City", origin: "lookup" },
    permitStructure: { value: "combo", sourceUrl: agencyUrl, quote: "one combination permit", origin: "lookup" },
  } as unknown as Omit<PermitProcessLookup, "profileKey" | "confidence">);
  assert.equal(r.saved, true, r.reason);
};
seedProcess(SS, `${SS_HOST}/150/Building`);
seedProcess(WP, `${WP_HOST}/departments/building/`);
seedProcess(UN, `${UN_HOST}/`);
seedProcess(NO, `${NO_HOST}/`);

/** A fake LLM that records every design lookup call (each one is a web-search round). */
const calls: Array<{ ahj: string; state: string; issuerPage?: { url: string; text: string } }> = [];
const fakeLlm = (result: DesignCriteriaResearchResult = { provider: "claude", webGrounded: true, values: [], notes: "Web-grounded lookup." }): LLMProvider =>
  ({ researchDesignCriteria: async (input: { ahj: string; state: string; issuerPage?: { url: string; text: string } }) => { calls.push(input); return result; } } as unknown as LLMProvider);
const ownRow = (who: { state: string; ahj: string }) => CP.ownCodeProfileRow(db, who.state, who.ahj);
const citationFor = (who: { state: string; ahj: string }, field: string) =>
  ownRow(who)?.profile.citations.filter((c) => c.field === `designCriteria.${field}`).pop();

// ── 1. CivicPlus ────────────────────────────────────────────────────────────────────────
console.log("1. a CivicPlus Design Criteria table, found through the CMS's own search");

await check("the issuer host on file is the city's own site (not a state or publisher host)", () => {
  assert.equal(P.issuerHostFor(db, SS.state, SS.ahj), "www.cedarbluffs-ut.gov");
  assert.equal(P.issuerHostFor(null, "UT", "City of Rowcite", ["https://library.municode.com/ut/rowcite", "https://www.rowciteut.gov/DocumentCenter/View/9/Title-18"]), "www.rowciteut.gov",
    "the code profile's own citations name the host too");
  assert.equal(P.isIssuerHost("up.codes", SS.ahj, SS.state), false, "a code publisher is not the city's site");
  assert.equal(P.isIssuerHost("dopl.utah.gov", SS.ahj, SS.state), false, "a state agency is not the city's site");
});

await check("the lookup stores every value from the city's own table, seeded and cited — with NO web-search round", async () => {
  calls.length = 0;
  const r = await CP.runDesignCriteriaResearch(db, SS, fakeLlm(), reader());
  assert.equal(calls.length, 0, `a web-search round was spent: ${JSON.stringify(calls)}`);
  assert.deepEqual(r.issuerPage, { url: SS_PAGE, parsed: true });
  const row = ownRow(SS);
  assert.ok(row, "no profile row");
  assert.equal(row!.profile.confidence, "seeded");
  const dc = row!.profile.designCriteria;
  assert.deepEqual({ ...dc, sourceUrl: undefined }, {
    roofSnowLoadPsf: 30, groundSnowLoadPsf: 31, windSpeedMph: 103, windExposure: "B or C", seismicDesignCategory: "D2",
    frostDepthIn: 30, weathering: "severe", termite: "Slight to Moderate", soilBearingPsf: 1500, sourceUrl: undefined,
  });
  assert.equal(dc.sourceUrl, SS_PAGE);
  for (const f of ["roofSnowLoadPsf", "groundSnowLoadPsf", "windSpeedMph", "windExposure", "seismicDesignCategory", "frostDepthIn"]) {
    assert.equal(citationFor(SS, f)?.sourceUrl, SS_PAGE, `${f} not cited to the page`);
  }
  assert.match(String(citationFor(SS, "roofSnowLoadPsf")?.quote), /^Roof Snow Load 30 pounds$/);
  const items = Object.fromEntries((r.checklist as Array<{ item: string; status: string }>).map((i) => [i.item, i.status]));
  assert.equal(items.groundSnowLoad, "found");
  assert.equal(items.windSpeed, "found");
  assert.equal(items.windExposure, "found");
});

await check("the probe went through the CMS's own site search (CivicPlus) and read no off-site page", () => {
  assert.ok(fetched.includes(`${SS_HOST}/Search?searchPhrase=design%20criteria`), fetched.join(", "));
  assert.ok(fetched.every((u) => new URL(u).hostname.endsWith(".gov")));
});

// ── 2. WordPress + PDF ──────────────────────────────────────────────────────────────────
console.log("2. a PDF criteria sheet linked from a WordPress building page");

await check("the PDF sheet's values land seeded and cited, no search call; 'Floor, Sleeping 30 psf' is not roof snow", async () => {
  calls.length = 0;
  const r = await CP.runDesignCriteriaResearch(db, WP, fakeLlm(), reader());
  assert.equal(calls.length, 0, "a web-search round was spent");
  assert.deepEqual(r.issuerPage, { url: WP_PDF, parsed: true });
  const dc = ownRow(WP)!.profile.designCriteria;
  assert.equal(dc.groundSnowLoadPsf, 40);
  assert.equal(dc.windSpeedMph, 115);
  assert.equal(dc.windExposure, "C");
  assert.equal(dc.seismicDesignCategory, "B");
  assert.equal(dc.frostDepthIn, 36);
  assert.equal(dc.roofSnowLoadPsf, undefined, "a floor or roof LIVE load became roof snow");
  assert.equal(citationFor(WP, "groundSnowLoadPsf")?.sourceUrl, WP_PDF);
  assert.equal(ownRow(WP)!.profile.confidence, "seeded");
});

await check("the WordPress site was detected and probed with its own search form", async () => {
  const home = await reader().read(`${WP_HOST}/`);
  assert.equal(P.detectSitePlatform(home), "wordpress");
  assert.ok(fetched.includes(`${WP_HOST}/?s=design+criteria`), "WordPress search not tried");
});

// ── 3. A candidate that does not parse ──────────────────────────────────────────────────
console.log("3. a candidate page found but not parsed");

const HELD = "9999-12-31T00:00:00.000Z";
CP.setCodeResearchEnqueuerForTests((d, payload) => { enqueueJob(d, "code_research", payload as unknown as Record<string, unknown>, { priority: 3, maxRetries: 2, scheduledAt: HELD }); });
CP.setDesignResearchEnqueuerForTests((d, payload) => { enqueueJob(d, "design_criteria_research", payload, { priority: 3, maxRetries: 2, scheduledAt: HELD }); });

await check("the web round runs GROUNDED on the candidate page, and the record says 'candidate page found, not parsed: <url>'", async () => {
  calls.length = 0;
  const r = await CP.runDesignCriteriaResearch(db, UN, fakeLlm(), reader());
  assert.equal(calls.length, 1, "the web round did not run");
  assert.equal(calls[0].issuerPage?.url, UN_PAGE, "the model was not handed the city's own page");
  assert.match(String(calls[0].issuerPage?.text), /design criteria are shown in the table below/);
  assert.deepEqual(r.issuerPage, { url: UN_PAGE, parsed: false });
  const snow = (r.checklist as Array<{ item: string; status: string; note?: string; sourceUrl?: string }>).find((i) => i.item === "groundSnowLoad")!;
  assert.equal(snow.status, "candidate_unparsed");
  assert.equal(snow.note, `candidate page found, not parsed: ${UN_PAGE}`);
  assert.equal(snow.sourceUrl, UN_PAGE);
  assert.doesNotMatch(JSON.stringify(r), /no jurisdiction-wide value/);
});

await check("the reviewer says 'candidate page found, not parsed' with the URL, never 'no jurisdiction-wide value'", async () => {
  const key = CP.codeProfileKey(UN);
  const pid = R.createProject(db, {
    owner: "Synthetic Owner", state: UN.state, dcKw: "8.4", acKw: "7.7", street: "1 Test Way", city: "Testbrook", zip: "83000",
    ahj: UN.ahj, utility: "Test Power",
  } as never).project.id;
  db.run("UPDATE projects SET status = 'ready_to_stage' WHERE id = ?", [pid]);
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-never-called";
  try {
    R.getReviewerReport(db, pid);
    db.run("UPDATE job_queue SET status = 'done', result = '{}', finished_at = ? WHERE status IN ('pending','running') AND job_type != 'design_criteria_research'", [new Date().toISOString()]);
    CP.resetResearchMarkersForTests();
    CP.ensureDesignCriteriaResearched(db, UN.state, UN.ahj);
    const job = db.query<{ id: string }>("SELECT id FROM job_queue WHERE job_type = 'design_criteria_research' AND status = 'pending' AND payload LIKE ?", [`%"profileKey":"${key}"%`])[0];
    assert.ok(job, "no design lookup queued");
    db.run("UPDATE job_queue SET status = 'done', result = '{}', finished_at = ? WHERE status IN ('pending','running') AND id != ?", [new Date().toISOString(), job.id]);
    const result = await CP.runDesignCriteriaResearch(db, { ...UN, profileKey: key }, fakeLlm(), reader());
    const at = new Date().toISOString();
    db.run("UPDATE job_queue SET status = 'done', result = ?, finished_at = ?, created_at = ? WHERE id = ?", [JSON.stringify(result), at, at, job.id]);
    const f = R.buildReviewerReportFor(db, R.getProjectDetail(db, pid).project).findings.find((x) => x.id === "city.struct.design-criteria-unknown");
    assert.ok(f, "no design-criteria-unknown finding");
    assert.match(f!.title, /candidate page found, not parsed/);
    assert.ok(f!.message.includes(`candidate page found, not parsed: ${UN_PAGE}`), f!.message);
    assert.doesNotMatch(`${f!.title} ${f!.message}`, /no jurisdiction-wide/);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

// ── 4. No such page / no host: exactly as before ────────────────────────────────────────
console.log("4. a city site with no such page, and an AHJ with no host on file");

await check("a city site with no design-criteria page: the web round runs as today (no issuer page), 'not found' as today", async () => {
  calls.length = 0;
  const r = await CP.runDesignCriteriaResearch(db, NO, fakeLlm(), reader());
  assert.deepEqual(calls, [{ state: NO.state, ahj: NO.ahj }], "the web round's input changed");
  assert.equal(r.issuerPage, undefined);
  const snow = (r.checklist as Array<{ item: string; status: string; note?: string }>).find((i) => i.item === "groundSnowLoad")!;
  assert.deepEqual(snow, { item: "groundSnowLoad", status: "not_found", note: "no jurisdiction-wide value found on an official page" });
});

await check("an AHJ with no issuer host on file: no page is read at all, and the web round runs as today", async () => {
  calls.length = 0;
  const rd = reader();
  const who = { state: "WY", ahj: "City of Nohostville" };
  await CP.runDesignCriteriaResearch(db, who, fakeLlm(), rd);
  assert.equal(rd.log.length, 0, `pages were read: ${rd.log.map((l) => l.url).join(", ")}`);
  assert.deepEqual(calls, [who]);
});

// ── 5. Rule 3 ───────────────────────────────────────────────────────────────────────────
console.log("5. rule 3: a verified row is never touched");

await check("a human-verified row stays exactly as the person left it, whatever the city's page says", async () => {
  const V = SS;
  CP.saveVerifiedCodeProfile(db, { key: "", state: V.state, ahj: V.ahj, confidence: "verified", adoptedCodes: [], amendments: [], designCriteria: { frostDepthIn: 30 }, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "" }, "operator");
  const before = JSON.stringify(ownRow(V)!.profile);
  calls.length = 0;
  const r = await CP.runDesignCriteriaResearch(db, V, fakeLlm(), reader());
  assert.equal(r.saved, false);
  assert.match(String(r.reason), /human-verified/);
  assert.equal(JSON.stringify(ownRow(V)!.profile), before, "the verified row changed");
  assert.equal(ownRow(V)!.profile.confidence, "verified");
});

// ── 6. Label binding (pure) ─────────────────────────────────────────────────────────────
console.log("6. the label binding");

const parse = (text: string) => Object.fromEntries(parseDesignCriteriaLookup(P.extractCriteriaTable(text, "https://www.testcity.gov/design-criteria"), true, false, { ahj: "City of Testcity", state: "UT" })
  .values.map((v) => [v.criterion + (v.qualifier === "pg_asd" ? "/asd" : ""), v.value]));

await check("'Floor, Sleeping 30 pounds' and a roof LIVE load never become roof snow", () => {
  assert.deepEqual(parse("Floor, Sleeping | 30 pounds\nFloor, Living | 40 pounds"), {});
  assert.deepEqual(parse("Roof Live Load | 20 psf\nRoof Dead Load | 15 psf"), {});
  assert.deepEqual(parse("Roof Snow Load | 30 pounds\nFloor, Sleeping | 40 pounds"), { roofSnowLoadPsf: 30 });
});

await check("'103 [51] exposure B or C' stores wind 103 and exposure 'B or C' — never one letter picked from the list", () => {
  assert.deepEqual(parse("Wind Speed | 103 [51] exposure B or C"), { windSpeedMph: 103, windExposure: "B or C" });
  assert.deepEqual(parseDesignCriteriaLookup({ windExposure: { value: "C", sourceUrl: "https://www.testcity.gov/x", quote: "Wind exposure B or C" } }, true).values, [], "a letter picked from a list was kept");
  const merged = CP.mergeResearchedDesignCriteria(db, { state: "UT", ahj: "City of Listville" }, parseDesignCriteriaLookup({ windExposure: { value: "B or C", sourceUrl: "https://www.listvilleut.gov/dc", quote: "Wind Speed 103 [51] exposure B or C" } }, true, false, { ahj: "City of Listville", state: "UT" }));
  assert.deepEqual(merged.filled, ["windExposure"]);
  assert.equal(ownRow({ state: "UT", ahj: "City of Listville" })!.profile.designCriteria.windExposure, "B or C");
});

await check("other layouts: a horizontal R301.2 table and 'Label: value' prose bind each number to its own column / label", () => {
  assert.deepEqual(parse("GROUND SNOW LOAD | WIND SPEED (mph) | SEISMIC DESIGN CATEGORY | FROST LINE DEPTH\n25 | 115 | C | 24 inches"),
    { groundSnowLoadPsf: 25, windSpeedMph: 115, seismicDesignCategory: "C", frostDepthIn: 24 });
  assert.deepEqual(parse("Ground snow load: 35 psf; Roof snow load: 25 psf"), { groundSnowLoadPsf: 35, roofSnowLoadPsf: 25 });
  assert.deepEqual(parse("Ground Snow Load | 20-25 psf"), {}, "a range is not a value");
});

await check("universality: no AHJ name or URL lives in the probe's source", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "issuerDesignCriteria.ts"), "utf8");
  assert.doesNotMatch(src, /saratoga|https?:\/\/(?!\$\{)[a-z0-9.-]+\.[a-z]{2,}/i);
});

// ── 7. #250 follow-ups ──────────────────────────────────────────────────────────────────
console.log("7. ASD-only snow is not an answer; the hub budget; the no-host diagnostic (#250)");

// govAccess (Granicus) site whose page gives ONLY the allowable-stress pg(asd), plus wind (synthetic).
const ASD = { state: "MT", ahj: "City of Larchmesa" };
const ASD_HOST = "https://www.larchmesamt.gov";
const ASD_PAGE = `${ASD_HOST}/departments/building/design-criteria`;
const GOVACCESS_HEAD = `<script src="/Project/Contents/Main/_gfx/granicus.js"></script>`;
serve(`${ASD_HOST}/`, { contentType: "text/html", text: html(`<h1>City of Larchmesa</h1><a href="/departments/building/design-criteria">Design Criteria</a><a href="/Home/ShowDocument?id=4">Budget</a>`, GOVACCESS_HEAD) });
serve(ASD_PAGE, { contentType: "text/html", text: html(`<h1>Design Criteria</h1><table>
<tr><td>Ground Snow Load, pg(asd)</td><td>35 psf</td></tr>
<tr><td>Ultimate Design Wind Speed</td><td>110 mph</td></tr>
<tr><td>Seismic Design Category</td><td>C</td></tr>
</table>`, GOVACCESS_HEAD) });
// Revize site whose page gives the STRENGTH-LEVEL pg, plus wind (synthetic).
const PG = { state: "ID", ahj: "City of Birchford" };
const PG_HOST = "https://www.birchfordid.gov";
const PG_PAGE = `${PG_HOST}/building/design-criteria`;
const REVIZE_HEAD = `<link rel="stylesheet" href="/revize/plugins/style.css">`;
serve(`${PG_HOST}/`, { contentType: "text/html", text: html(`<h1>City of Birchford</h1><a href="/building/design-criteria">Design Criteria</a>`, REVIZE_HEAD) });
serve(PG_PAGE, { contentType: "text/html", text: html(`<h1>Design Criteria</h1><table>
<tr><td>Ground Snow Load, Pg</td><td>50 psf</td></tr>
<tr><td>Ultimate Design Wind Speed</td><td>115 mph</td></tr>
</table>`, REVIZE_HEAD) });
// A site with two hubs whose links NAME the table but lead nowhere: no candidate page exists (synthetic).
const HB = { state: "OR", ahj: "City of Fernhollow" };
const HB_HOST = "https://www.fernhollowor.gov";
serve(`${HB_HOST}/`, { contentType: "text/html", text: html(`<h1>City of Fernhollow</h1><a href="/building">Building</a><a href="/permits">Permits</a>`) });
const deadLinks = (n: number, from: string) => Array.from({ length: n }, (_, i) => `<a href="/${from}/snow-load-${i}">Snow Load Notice ${i}</a>`).join("");
serve(`${HB_HOST}/building`, { contentType: "text/html", text: html(`<h1>Building</h1>${deadLinks(3, "building")}`) });
serve(`${HB_HOST}/permits`, { contentType: "text/html", text: html(`<h1>Permits</h1>${deadLinks(3, "permits")}`) });
seedProcess(ASD, `${ASD_HOST}/`);
seedProcess(PG, `${PG_HOST}/`);
seedProcess(HB, `${HB_HOST}/`);

await check("MUST-PASS: a page giving only pg(asd) plus wind still runs the web round (grounded on the page), and the pg(asd) lands seeded", async () => {
  calls.length = 0;
  const r = await CP.runDesignCriteriaResearch(db, ASD, fakeLlm(), reader());
  assert.equal(calls.length, 1, "an ASD-only page skipped the web round: the strength-level pg was never looked for");
  assert.equal(calls[0].issuerPage?.url, ASD_PAGE);
  assert.deepEqual(r.issuerPage, { url: ASD_PAGE, parsed: false });
  const row = ownRow(ASD)!;
  assert.equal(row.profile.confidence, "seeded");
  assert.equal(row.profile.designCriteria.groundSnowLoadAsdPsf, 35);
  assert.equal(row.profile.designCriteria.groundSnowLoadPsf, undefined, "the pg(asd) was stored as the strength pg");
  assert.equal(row.profile.designCriteria.windSpeedMph, 110);
});

await check("MUST-EXCLUDE: a page giving the strength-level pg plus wind spends no web round and no model call", async () => {
  calls.length = 0;
  const r = await CP.runDesignCriteriaResearch(db, PG, fakeLlm(), reader());
  assert.equal(calls.length, 0, `a web-search round was spent: ${JSON.stringify(calls)}`);
  assert.deepEqual(r.issuerPage, { url: PG_PAGE, parsed: true });
  const row = ownRow(PG)!;
  assert.equal(row.profile.confidence, "seeded");
  assert.equal(row.profile.designCriteria.groundSnowLoadPsf, 50);
  assert.equal(row.profile.designCriteria.windSpeedMph, 115);
});

await check("no candidate page before the hubs: the hub phase gets the smaller budget, and the job result says so", async () => {
  calls.length = 0;
  const rd = reader();
  const r = await CP.runDesignCriteriaResearch(db, HB, fakeLlm(), rd);
  const max = 3 + P.ISSUER_PROBE_HUB_READS; // home + site search + common page name, then the hub phase
  assert.ok(rd.log.length <= max && rd.log.length < P.ISSUER_PROBE_MAX_READS, `the probe read ${rd.log.length} pages: ${rd.log.map((l) => l.url).join(", ")}`);
  assert.equal(r.issuerPage, undefined);
  assert.deepEqual(calls, [HB], "the web round's input changed");
  assert.match(String(r.issuerProbe), new RegExp(`no design-criteria page found \\(${rd.log.length} pages read on www\\.fernhollowor\\.gov; hub reads capped at ${P.ISSUER_PROBE_HUB_READS}\\)`));
});

await check("a hub that links the table still reaches it inside the hub budget (WordPress: one hub, then its PDF)", async () => {
  const probe = await P.probeIssuerDesignCriteria(reader(), { host: "www.examplefieldco.gov", ahj: WP.ahj, state: WP.state });
  assert.equal(probe.candidateUrl, WP_PDF);
  assert.equal(probe.hubBudget, 3, "the hub budget is three reads (a literal: the constant alone would pass vacuously)");
});

// ── 8. #258: one hub at a time; the strength-level pg ───────────────────────────────────
console.log("8. the hubs are visited one at a time; ASD-only is not answered on file either (#258)");

// Two hubs; the first links a bare "Snow Load Map" and THEN the "Design Criteria" table. Reading
// both hubs back to back left one read, which the snow-load map spent. On two platforms (synthetic).
const twoHubSite = (origin: string, head: string, hubPaths: [string, string]) => {
  serve(`${origin}/`, { contentType: "text/html", text: html(`<h1>City Home</h1><a href="${hubPaths[0]}">Building</a><a href="${hubPaths[1]}">Permits</a>`, head) });
  serve(`${origin}${hubPaths[0]}`, { contentType: "text/html", text: html(`<h1>Building</h1><a href="${hubPaths[0]}/snow-load-map">Snow Load Map</a><a href="${hubPaths[0]}/criteria-table">Design Criteria</a>`, head) });
  serve(`${origin}${hubPaths[1]}`, { contentType: "text/html", text: html(`<h1>Permits</h1><a href="${hubPaths[1]}/fees">Permit Fees</a>`, head) });
  serve(`${origin}${hubPaths[0]}/snow-load-map`, { contentType: "text/html", text: html(`<h1>Snow Load Map</h1><img src="/images/snow-map.png" alt="map">`, head) });
  serve(`${origin}${hubPaths[0]}/criteria-table`, { contentType: "text/html", text: html(`<h1>Design Criteria</h1><table>
<tr><td>Ground Snow Load, Pg</td><td>45 psf</td></tr>
<tr><td>Ultimate Design Wind Speed</td><td>105 mph</td></tr>
</table>`, head) });
  return `${origin}${hubPaths[0]}/criteria-table`;
};
const TH1 = { state: "UT", ahj: "City of Ashgrove" };
const TH1_PAGE = twoHubSite("https://www.ashgroveut.gov", CIVICPLUS_HEAD, ["/150/Building", "/160/Permits"]);
const TH2 = { state: "WA", ahj: "City of Quillmont" };
const TH2_PAGE = twoHubSite("https://www.quillmontwa.gov", GOVACCESS_HEAD, ["/departments/building", "/departments/permits"]);
seedProcess(TH1, "https://www.ashgroveut.gov/");
seedProcess(TH2, "https://www.quillmontwa.gov/");

await check("MUST-PASS: two hubs, \"Snow Load Map\" then \"Design Criteria\": the table is reached inside the 3-read hub budget (CivicPlus and govAccess)", async () => {
  for (const [who, host, page] of [[TH1, "www.ashgroveut.gov", TH1_PAGE], [TH2, "www.quillmontwa.gov", TH2_PAGE]] as const) {
    const probe = await P.probeIssuerDesignCriteria(reader(), { host, ahj: who.ahj, state: who.state });
    assert.equal(probe.candidateUrl, page, `${host}: read ${probe.pagesRead.map((r) => r.url).join(", ")}`);
    assert.equal(probe.hubBudget, 3);
    assert.ok(probe.pagesRead.length <= 3 + 3, `${host}: the probe read ${probe.pagesRead.length} pages`);
    assert.ok(!probe.pagesRead.some((r) => /\/permits$/i.test(r.url)), `${host}: the second hub was read though the first one's candidate answered`);
    assert.equal(P.probeAnswered(probe.raw), true);
  }
  calls.length = 0;
  const r = await CP.runDesignCriteriaResearch(db, TH1, fakeLlm(), reader());
  assert.equal(calls.length, 0, `a web-search round was spent: ${JSON.stringify(calls)}`);
  assert.deepEqual(r.issuerPage, { url: TH1_PAGE, parsed: true });
  const row = ownRow(TH1)!;
  assert.equal(row.profile.confidence, "seeded");
  assert.equal(row.profile.designCriteria.groundSnowLoadPsf, 45);
  assert.equal(row.profile.designCriteria.windSpeedMph, 105);
});

// The home page links an image-only "Snow Load Map" AND a Building hub; the hub links the table.
// The map is found before the hubs, and the first hub must still be read (Helm's #263 review).
const mapThenHubSite = (origin: string, head: string, hub: string) => {
  serve(`${origin}/`, { contentType: "text/html", text: html(`<h1>City Home</h1><a href="/snow-load-map">Snow Load Map</a><a href="${hub}">Building</a>`, head) });
  serve(`${origin}/snow-load-map`, { contentType: "text/html", text: html(`<h1>Snow Load Map</h1><img src="/images/snow-map.png" alt="map">`, head) });
  serve(`${origin}${hub}`, { contentType: "text/html", text: html(`<h1>Building</h1><a href="${hub}/criteria">Design Criteria</a>`, head) });
  serve(`${origin}${hub}/criteria`, { contentType: "text/html", text: html(`<h1>Design Criteria</h1><table>
<tr><td>Ground Snow Load, Pg</td><td>60 psf</td></tr>
<tr><td>Ultimate Design Wind Speed</td><td>100 mph</td></tr>
</table>`, head) });
  return `${origin}${hub}/criteria`;
};
const MH1 = { state: "UT", ahj: "City of Mosspoint" };
const MH1_PAGE = mapThenHubSite("https://www.mosspointut.gov", CIVICPLUS_HEAD, "/150/Building");
const MH2 = { state: "CO", ahj: "Town of Wrenfield" };
const MH2_PAGE = mapThenHubSite("https://www.wrenfieldco.gov", WP_HEAD, "/departments/building");
seedProcess(MH1, "https://www.mosspointut.gov/");
seedProcess(MH2, "https://www.wrenfieldco.gov/");

await check("MUST-PASS: a snow-load map found before the hubs does not skip the first hub; its table is read with no web round (CivicPlus and WordPress)", async () => {
  for (const [who, page] of [[MH1, MH1_PAGE], [MH2, MH2_PAGE]] as const) {
    calls.length = 0;
    const r = await CP.runDesignCriteriaResearch(db, who, fakeLlm(), reader());
    assert.equal(calls.length, 0, `${who.ahj}: a web-search round was spent: ${JSON.stringify(calls)}`);
    assert.deepEqual(r.issuerPage, { url: page, parsed: true });
    const row = ownRow(who)!;
    assert.equal(row.profile.confidence, "seeded");
    assert.equal(row.profile.designCriteria.groundSnowLoadPsf, 60);
    assert.equal(row.profile.designCriteria.windSpeedMph, 100);
  }
});

// The home page links an image-only "Snow Load Map", "Building" and "Permits"; the table is under
// PERMITS. The unparsed map is not "found", so the second hub is still read (Helm's #263 re-review).
const mapTwoHubSite = (origin: string, head: string, hubs: [string, string]) => {
  serve(`${origin}/`, { contentType: "text/html", text: html(`<h1>City Home</h1><a href="/snow-load-map">Snow Load Map</a><a href="${hubs[0]}">Building</a><a href="${hubs[1]}">Permits</a>`, head) });
  serve(`${origin}/snow-load-map`, { contentType: "text/html", text: html(`<h1>Snow Load Map</h1><img src="/images/snow-map.png" alt="map">`, head) });
  serve(`${origin}${hubs[0]}`, { contentType: "text/html", text: html(`<h1>Building</h1><a href="${hubs[0]}/inspections">Schedule an Inspection</a>`, head) });
  serve(`${origin}${hubs[1]}`, { contentType: "text/html", text: html(`<h1>Permits</h1><a href="${hubs[1]}/criteria">Design Criteria</a>`, head) });
  serve(`${origin}${hubs[1]}/criteria`, { contentType: "text/html", text: html(`<h1>Design Criteria</h1><table>
<tr><td>Ground Snow Load, Pg</td><td>55 psf</td></tr>
<tr><td>Ultimate Design Wind Speed</td><td>95 mph</td></tr>
</table>`, head) });
  return `${origin}${hubs[1]}/criteria`;
};
const MP1 = { state: "UT", ahj: "City of Hazelrock" };
const MP1_PAGE = mapTwoHubSite("https://www.hazelrockut.gov", CIVICPLUS_HEAD, ["/150/Building", "/160/Permits"]);
const MP2 = { state: "WA", ahj: "City of Sprucedale" };
const MP2_PAGE = mapTwoHubSite("https://www.sprucedalewa.gov", GOVACCESS_HEAD, ["/departments/building", "/departments/permits"]);
seedProcess(MP1, "https://www.hazelrockut.gov/");
seedProcess(MP2, "https://www.sprucedalewa.gov/");

await check("MUST-PASS: an unparsed snow-load map does not skip the second hub; the table under it is read with no web round (CivicPlus and govAccess)", async () => {
  for (const [who, page] of [[MP1, MP1_PAGE], [MP2, MP2_PAGE]] as const) {
    calls.length = 0;
    const rd = reader();
    const r = await CP.runDesignCriteriaResearch(db, who, fakeLlm(), rd);
    assert.equal(calls.length, 0, `${who.ahj}: a web-search round was spent (read ${rd.log.map((l) => l.url).join(", ")})`);
    assert.deepEqual(r.issuerPage, { url: page, parsed: true });
    const row = ownRow(who)!;
    assert.equal(row.profile.confidence, "seeded");
    assert.equal(row.profile.designCriteria.groundSnowLoadPsf, 55);
    assert.equal(row.profile.designCriteria.windSpeedMph, 95);
  }
});

// The home page links an ASD-only table that has MORE rows first, then a strength-level one. The
// probe stops on the second; it must return that one, not the first (Helm's #263 review).
const asdThenPgSite = (origin: string, head: string) => {
  serve(`${origin}/`, { contentType: "text/html", text: html(`<h1>City Home</h1><a href="/design-criteria-asd">Design Criteria</a><a href="/climatic-table">Climatic and Geographic Design Criteria</a>`, head) });
  serve(`${origin}/design-criteria-asd`, { contentType: "text/html", text: html(`<h1>Design Criteria</h1><table>
<tr><td>Ground Snow Load, pg(asd)</td><td>30 psf</td></tr>
<tr><td>Ultimate Design Wind Speed</td><td>110 mph</td></tr>
<tr><td>Seismic Design Category</td><td>C</td></tr>
<tr><td>Frost Line Depth</td><td>24 inches</td></tr>
</table>`, head) });
  serve(`${origin}/climatic-table`, { contentType: "text/html", text: html(`<h1>Climatic and Geographic Design Criteria</h1><table>
<tr><td>Ground Snow Load, Pg</td><td>42 psf</td></tr>
<tr><td>Ultimate Design Wind Speed</td><td>110 mph</td></tr>
</table>`, head) });
  return `${origin}/climatic-table`;
};
const AP1_PAGE = asdThenPgSite("https://www.oakvaleid.gov", REVIZE_HEAD);
const AP2_PAGE = asdThenPgSite("https://www.elmcrestmt.gov", GOVACCESS_HEAD);

await check("when the probe stops early, the page it returns answers (strength-level pg + wind), not an earlier ASD-only page with more rows (Revize and govAccess)", async () => {
  for (const [host, ahj, state, page] of [["www.oakvaleid.gov", "City of Oakvale", "ID", AP1_PAGE], ["www.elmcrestmt.gov", "City of Elmcrest", "MT", AP2_PAGE]] as const) {
    const probe = await P.probeIssuerDesignCriteria(reader(), { host, ahj, state });
    assert.equal(probe.candidateUrl, page, `${host}: returned ${probe.candidateUrl}`);
    assert.equal(P.probeAnswered(probe.raw), true, `${host}: the probe stopped but its page does not answer`);
  }
});

await check("a link naming the table is read before a bare snow-load link (stable otherwise)", () => {
  const words = new Map([["a", "Snow Load Map"], ["b", "Climatic and Geographic Design Criteria"], ["c", "Ground Snow Loads"], ["d", "R301.2 table"]]);
  assert.deepEqual(P.rankedCandidates(["a", "b", "c", "d"], words), ["b", "d", "a", "c"]);
});

await check("probeAnswered needs the strength-level pg: an ASD-only pg plus wind is not an answer", () => {
  assert.equal(P.probeAnswered({ groundSnowLoadAsdPsf: { value: 35 }, windSpeedMph: { value: 110 } }), false);
  assert.equal(P.probeAnswered({ groundSnowLoadPsf: { value: 50 }, windSpeedMph: { value: 115 } }), true);
  assert.equal(P.probeAnswered({ groundSnowLoadPsf: { value: 50 }, groundSnowLoadAsdPsf: { value: 30 } }), false, "no wind");
});

await check("MUST-PASS: a row holding only the ASD pg plus wind runs the lookup again for the strength-level pg", async () => {
  const dc = ownRow(ASD)!.profile.designCriteria;
  assert.equal(dc.groundSnowLoadAsdPsf, 35);
  assert.equal(dc.groundSnowLoadPsf, undefined);
  calls.length = 0;
  const r = await CP.runDesignCriteriaResearch(db, ASD, fakeLlm(), reader());
  assert.notEqual(r.reason, "design criteria already on file");
  assert.equal(calls.length, 1, "an ASD-only row read as answered: the strength-level pg is never looked for");
});

await check("MUST-EXCLUDE: a row holding the strength-level pg plus wind is answered (no probe, no model call)", async () => {
  calls.length = 0;
  const rd = reader();
  const r = await CP.runDesignCriteriaResearch(db, PG, fakeLlm(), rd);
  assert.equal(r.reason, "design criteria already on file");
  assert.equal(calls.length, 0);
  assert.equal(rd.log.length, 0, "the issuer site was read for an answered row");
});

await check("no issuer host on file: the job result says \"no issuer host on file\"", async () => {
  const who = { state: "WY", ahj: "City of Nohostburg" };
  const r = await CP.runDesignCriteriaResearch(db, who, fakeLlm(), reader());
  assert.equal(r.issuerProbe, "no issuer host on file");
});

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nall issuer design-criteria page checks passed");
