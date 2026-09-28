// STAGE ALWAYS ACQUIRES THE OFFICIAL FORMS THIS JOB STILL OWES (live 2026-09-27, Michael Sheridan —
// City of Jefferson, Marion County issues both permits). After release, Michael's Marion B-01S / E-01
// were NOT on file until the operator clicked "Find missing official forms": Stage
// (prepareSubmission -> prepareOfficialDocuments) skipped acquisition inside the 24h per-AHJ cooldown,
// because the City of Jefferson had been prepared earlier the same day on the old version.
//
// The rule, for any AHJ: the cooldown throttles PAID research only. Inside it, Stage still runs the
// free pass — a held form answers "exists" with no download, the issuing agency's curated seed / the
// PDF this job's lookup cites / the state checklist are fetched — so what the job owes is on file
// before staging.
//
//   MUST-PASS     a job whose AHJ was prepared < 24h ago, with its agency's curated forms missing,
//                 gets them at Stage (stored under the agency, filled).
//   MUST-EXCLUDE  a job with everything on file makes no fetch; a failed curated fetch is a named
//                 not_found and no cited PDF is tried in its place (agency-contain C2).
//   The free pass never claims the cooldown, and never pays for a model it was not allowed.
//   N2 (go gently) inside the cooldown a curated/cited URL that failed < 6h ago is not fetched again —
//                 a named not_found "tried <when>, retry after <when>"; after 6h the next Stage fetches;
//                 the operator's "Find missing official forms" fetches now.
//
// No network (fetch stubbed, every download counted), no model (ANTHROPIC_API_KEY unset).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stage-acquires-forms-"));
process.env.AUTOPILOT_DB_PATH = path.join(temp, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.PROJECT_DOCS_DIR = path.join(temp, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(temp, "profiles");
process.env.BACKUP_DIR = path.join(temp, "backups");
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AHJ_FORM_DOWNLOADS;

const { openDatabase } = await import("../src/db");
const { savePermitProcessLookup } = await import("../src/permitProcess");
const forms = await import("../src/ahjForms");
const auto = await import("../src/ahjFormAuto");
const agencyMod = await import("../src/applicationDocsAgency");
const repo = await import("../src/repository");
const { prepareOfficialDocuments } = await import("../src/prepareOfficialDocuments");

const db = await openDatabase();
const fixture = (name: string) => fs.readFileSync(path.join("backend/test/fixtures", name));
const B01S_URL = "https://www.co.marion.or.us/PW/BuildingInspection/Documents/B-01S%20Solar%20Prescriptive%20Installation%20Application%20Filleable.pdf";
const E01_URL = "https://www.co.marion.or.us/PW/BuildingInspection/Documents/E-01%20Renewable%20Energy%20Permit%20Application.pdf";
const B5952_URL = "https://www.oregon.gov/bcd/Formslibrary/5952.pdf";
const MARION_PAGE = "https://www.co.marion.or.us/PW/BuildingInspection";
const POLK_PAGE = "https://www.co.polk.or.us/cd/building";
const POLK_E = "https://www.co.polk.or.us/sites/default/files/Electrical%20Permit%20Application.pdf";

// Every check runs (a kill shows WHICH pins fall); the banner prints only when none failed.
let passed = 0;
const failed: string[] = [];
const check = (name: string, cond: unknown, detail = ""): void => {
  if (cond) { passed++; return; }
  failed.push(name);
  console.error(`  FAIL - ${name}${detail ? `\n         ${detail.slice(0, 700)}` : ""}`);
};

// ── the per-job lookup (Michael's shape: permit_process_lookups 'or|city of jefferson') ───────────
const cited = (value: string, sourceUrl: string, quote: string) => ({ value, sourceUrl, quote, origin: "lookup" as const });
const notFound = (why: string, sourceUrl = "", quote = "") => ({ value: null, sourceUrl, quote, origin: "lookup" as const, notFound: why });
// pageSrc: the agency's own page the lookup read for this permit's portal (Michael's real lookup:
// portalUrl notFound, sourceUrl https://www.co.marion.or.us/PW/BuildingInspection) — the anchor site.
type PermitSpec = { discipline: "structural" | "electrical"; agency: string; src: string; quote?: string; docsSrc?: string; docs?: string[]; pageSrc: string };
function saveLookup(ahj: string, permits: PermitSpec[]): void {
  const r = savePermitProcessLookup(db, {
    state: "OR", ahj, lookedUpAt: new Date().toISOString(), issuingAgency: notFound("not stated at the top level"),
    permitStructure: cited("separate", permits[0].src, "separate building and electrical permits"),
    permits: permits.map((p) => ({
      discipline: p.discipline, label: `${p.discipline} permit`,
      issuingAgency: cited(p.agency, p.src, p.quote ?? `${p.agency} issues ${p.discipline} permits for ${ahj}`),
      portalUrl: notFound("no online portal named", p.pageSrc, "Check permit status online and general information for individual permits"),
      recordType: notFound("none"),
      documents: p.docs ? { value: p.docs, sourceUrl: p.docsSrc ?? p.src, quote: "application forms", origin: "lookup" as const } : notFound("no list", p.docsSrc ?? ""),
      fee: notFound("none"),
    })),
    notes: [],
  } as never);
  assert.equal((r as { saved?: boolean }).saved, true, `lookup for ${ahj}`);
}

// ── the network: public fixtures for their real URLs; nothing else answers ─────────────────────────
const realFetch = globalThis.fetch;
const realNow = Date.now;
const noModel = new Proxy({}, { get() { throw new Error("known public forms must not call a model"); } }) as never;
let downloads: string[] = [];
const served = new Map<string, Buffer>();
globalThis.fetch = (async (url: string | URL) => {
  const u = String(url);
  downloads.push(u);
  const body = served.get(u);
  if (!body) return new Response("not found", { status: 404 });
  return new Response(body, { headers: { "Content-Type": "application/pdf" } });
}) as typeof fetch;
async function acroPdf(title: string): Promise<Buffer> {
  const d = await PDFDocument.create();
  const p = d.addPage([612, 792]);
  p.drawText(title, { x: 40, y: 740, size: 12, font: await d.embedFont(StandardFonts.Helvetica) });
  d.getForm().createTextField("Owner name").addToPage(p, { x: 40, y: 600, width: 200, height: 18 });
  return Buffer.from(await d.save());
}

const filledDirs: string[] = [];
const mkJob = (ahj: string, city: string, owner: string) => {
  const p = repo.createProject(db, {
    owner, street: `1 ${owner} Rd`, city, state: "OR", zip: "97352", ahj, utility: "Pacific Power", dcKw: "15.91", acKw: "12.913",
    permitPathOverride: "prescriptive", homeownerPhone: "4580000000", mounting: "Roof Mount", structureDescription: "Single-family dwelling",
  } as never).project;
  filledDirs.push(p.id);
  return p;
};
const cooldownAt = (ahj: string): number | undefined =>
  db.get<{ attempted_at: number }>("SELECT attempted_at FROM ahj_form_acquisition_attempts WHERE scope_key = ?", [`or|${ahj.toLowerCase()}|prescriptive`])?.attempted_at;
const marionRows = (formType: string) => db.query<{ source_url: string }>("SELECT source_url FROM ahj_form_templates WHERE ahj_name = 'Marion County' AND form_type = ?", [formType]).map((r) => r.source_url);
const resultFor = (prep: unknown, formType: string) =>
  ((prep as { results?: Array<{ formType: string; status: string; message: string }> } | undefined)?.results ?? []).find((r) => r.formType === formType);

try {
  const michael = mkJob("City of Jefferson", "Jefferson", "Michael Fixture");

  // ═══ SETUP — the AHJ was prepared earlier today, on the OLD version ═════════════════════════════
  // (Michael's morning: a version before issuing-agency forms existed — nothing named Marion County as
  // the issuer yet, so the county's applications were never asked for, and never fetched; the state
  // checklist was. The real door claims the cooldown.)
  served.set(B5952_URL, fixture("bcd-5952-2024.pdf"));
  downloads = [];
  const first = await prepareOfficialDocuments(db, michael);
  const claimedAt = cooldownAt("City of Jefferson");
  check("setup: the first Stage claims the AHJ's cooldown", claimedAt != null && Date.now() - claimedAt < 60_000, String(claimedAt));
  check("setup: the county's B-01S and E-01 were never asked for and are NOT on file after it", !downloads.includes(B01S_URL) && !downloads.includes(E01_URL)
    && marionRows("building_application").length === 0 && marionRows("electrical_application").length === 0,
    JSON.stringify({ downloads, b: marionRows("building_application"), e: marionRows("electrical_application"), first }));
  // The per-job lookup (this release) names Marion County as the issuer of both permits.
  saveLookup("City of Jefferson", [
    { discipline: "structural", agency: "Marion County", src: B01S_URL, quote: "Prescriptive Solar Photovoltaic Installation Permit Application · Marion County Public Works", docsSrc: "https://jeffersonoregon.org/planning-committee/", pageSrc: MARION_PAGE },
    { discipline: "electrical", agency: "Marion County", src: "https://jeffersonoregon.org/planning-committee/", quote: "All Electrical and Plumbing permits are submitted to Marion County Building and those forms can be found here.", docsSrc: "https://jeffersonoregon.org/planning-committee/", pageSrc: MARION_PAGE },
  ]);

  // ═══ MUST-PASS — the next Stage, inside the cooldown, gets the county's forms ══════════════════
  served.set(B01S_URL, fixture("marion-b-01s.pdf"));
  served.set(E01_URL, fixture("marion-e-01.pdf"));
  downloads = [];
  const second = await prepareOfficialDocuments(db, michael);
  check("MUST-PASS the county's B-01S is fetched and stored under Marion County at Stage", JSON.stringify(marionRows("building_application")) === JSON.stringify([B01S_URL]),
    JSON.stringify({ rows: marionRows("building_application"), downloads, second }));
  check("MUST-PASS and its E-01", JSON.stringify(marionRows("electrical_application")) === JSON.stringify([E01_URL]), JSON.stringify({ rows: marionRows("electrical_application"), downloads }));
  check("MUST-PASS one download each, and the checklist already held is not fetched again", downloads.length === 2 && downloads.includes(B01S_URL) && downloads.includes(E01_URL), JSON.stringify(downloads));
  check("MUST-PASS Stage says which pass ran and what it got", (second as { acquisition?: string } | undefined)?.acquisition === "within-cooldown"
    && resultFor(second, "building_application")?.status === "acquired" && resultFor(second, "electrical_application")?.status === "acquired", JSON.stringify(second));
  const loaded = forms.loadStoredTemplates(db, "City of Jefferson", "OR").filter((t) => t.issuedBy === "Marion County");
  const filledPath = (templateId: string) => path.resolve("backend/data/filled", michael.id, `tmpl-${templateId}.pdf`);
  check("MUST-PASS both are FILLED at the same Stage (acquisition runs before the fill)", loaded.length === 2 && loaded.every((t) => fs.existsSync(filledPath(t.templateId))),
    JSON.stringify(loaded.map((t) => [t.formType, fs.existsSync(filledPath(t.templateId))])));
  check("the free pass does not claim (or extend) the cooldown", cooldownAt("City of Jefferson") === claimedAt, `${cooldownAt("City of Jefferson")} vs ${claimedAt}`);

  // ═══ MUST-EXCLUDE (a) — everything on file: no fetch ═══════════════════════════════════════════
  downloads = [];
  const third = await prepareOfficialDocuments(db, michael);
  check("MUST-EXCLUDE a job with everything on file makes no fetch", downloads.length === 0, JSON.stringify(downloads));
  check("MUST-EXCLUDE and reports each form as held", ["building_application", "electrical_application", "solar_checklist"].every((t) => resultFor(third, t)?.status === "exists"), JSON.stringify(third));
  const neighbour = mkJob("City of Jefferson", "Jefferson", "Neighbour Fixture");
  downloads = [];
  await prepareOfficialDocuments(db, neighbour);
  check("MUST-EXCLUDE another job under the same AHJ, forms on file: no fetch", downloads.length === 0, JSON.stringify(downloads));

  // ═══ MUST-EXCLUDE (b) — C2: a failed curated fetch is a named not_found, no cited fallthrough ═══
  // Stayton: Marion County issues both; the electrical permit ALSO cites a neighbour county's PDF (the
  // skeptic's S7 shape — Polk's application stored as Marion's when the E-01 404'd).
  db.run("DELETE FROM ahj_form_templates WHERE ahj_name = 'Marion County' AND form_type = 'electrical_application'");
  const e01Bytes = served.get(E01_URL)!;
  served.delete(E01_URL);
  served.set(POLK_E, await acroPdf("POLK COUNTY Electrical Permit Application"));
  saveLookup("City of Stayton", [
    { discipline: "structural", agency: "Marion County", src: MARION_PAGE, pageSrc: MARION_PAGE },
    { discipline: "electrical", agency: "Marion County", src: MARION_PAGE, docsSrc: POLK_PAGE, docs: [POLK_E], pageSrc: MARION_PAGE },
  ]);
  const stayton = mkJob("City of Stayton", "Stayton", "Stayton Fixture");
  check("C2 (setup) the county's seed and a cited neighbour are both candidates for Stayton's electrical application",
    JSON.stringify(agencyMod.agencyApplicationForms(stayton, "electrical_application", null).map((f) => f.origin)) === JSON.stringify(["curated", "cited"]),
    JSON.stringify(agencyMod.agencyApplicationForms(stayton, "electrical_application", null)));
  downloads = [];
  const c2 = await prepareOfficialDocuments(db, stayton); // the FULL pass: claims Stayton's cooldown
  check("C2 (setup) Stayton's first Stage is the full pass and claims its cooldown", cooldownAt("City of Stayton") != null && (c2 as { acquisition?: string }).acquisition === "full", JSON.stringify(c2));
  const c2E = resultFor(c2, "electrical_application");
  check("C2 the county's E-01 is fetched, and its failure is NAMED (agency, form, URL, retry)",
    c2E?.status === "not_found" && c2E.message.includes(`could not be downloaded from ${E01_URL} - retry`) && downloads.includes(E01_URL), JSON.stringify({ c2E, downloads }));
  check("C2 no cited PDF is tried in its place: Polk's never fetched, nothing stored in Marion County's electrical slot",
    !downloads.includes(POLK_E) && marionRows("electrical_application").length === 0 && db.query("SELECT 1 FROM ahj_form_templates WHERE source_url = ?", [POLK_E]).length === 0,
    JSON.stringify({ downloads, rows: marionRows("electrical_application") }));

  // ═══ N2 — GO GENTLY: inside the cooldown a URL that failed < 6h ago is not fetched again ═════════
  // (Every Stage re-fetched a walled/down curated or cited URL, and fetchPublicDocument may open a
  // HEADED browser for a walled one each time.) The operator's "Find missing official forms" bypasses.
  downloads = [];
  const n2 = await prepareOfficialDocuments(db, stayton);
  const n2E = resultFor(n2, "electrical_application");
  check("N2 MUST-PASS inside the cooldown the E-01 that failed < 6h ago is NOT fetched again", (n2 as { acquisition?: string }).acquisition === "within-cooldown" && !downloads.includes(E01_URL),
    JSON.stringify({ n2E, downloads }));
  check("N2 the skip is NAMED: not_found, the URL, 'tried <when>, retry after <when>'", n2E?.status === "not_found" && n2E.message.includes(E01_URL)
    && /tried \d{4}-\d\d-\d\d \d\d:\d\d UTC, retry after \d{4}-\d\d-\d\d \d\d:\d\d UTC/.test(n2E.message) && !n2E.message.includes("could not be downloaded from"), JSON.stringify(n2E));
  check("N2 the skipped seed is still a C2 stop: Polk's never fetched, nothing stored", !downloads.includes(POLK_E) && marionRows("electrical_application").length === 0, JSON.stringify(downloads));
  served.set(E01_URL, e01Bytes);
  downloads = [];
  const n2b = await prepareOfficialDocuments(db, stayton);
  check("N2 the memo is by time, not by the site: the site answers again, but < 6h after the failure Stage still does not fetch it",
    !downloads.includes(E01_URL) && resultFor(n2b, "electrical_application")?.status === "not_found", JSON.stringify({ downloads, n2b: resultFor(n2b, "electrical_application") }));
  // The operator's explicit click (server find-ahj-form -> ensureAhjFormsForProject with no memo flag).
  downloads = [];
  const op = await auto.ensureAhjFormsForProject(db, noModel, stayton);
  check("N2 MUST-PASS 'Find missing official forms' bypasses the memo: fetched now, and acquired", downloads.includes(E01_URL)
    && op.results.find((r) => r.formType === "electrical_application")?.status === "acquired" && JSON.stringify(marionRows("electrical_application")) === JSON.stringify([E01_URL]),
    JSON.stringify({ downloads, op: op.results.map((r) => [r.formType, r.status]) }));
  // A success clears the memo; a later failure starts a new 6h; once it has passed (still inside the
  // 24h cooldown) the next Stage fetches again and acquires.
  db.run("DELETE FROM ahj_form_templates WHERE ahj_name = 'Marion County' AND form_type = 'electrical_application'");
  served.delete(E01_URL);
  downloads = [];
  const n2c = await prepareOfficialDocuments(db, stayton);
  check("N2 a success cleared the memo: the next failure is fetched (and named) again", downloads.includes(E01_URL) && resultFor(n2c, "electrical_application")?.status === "not_found",
    JSON.stringify({ downloads, n2c: resultFor(n2c, "electrical_application") }));
  served.set(E01_URL, e01Bytes);
  Date.now = () => realNow() + 6 * 60 * 60 * 1000 + 60_000;
  check("(setup) six hours and a minute on, Stayton is still inside its 24h cooldown", Date.now() - (cooldownAt("City of Stayton") ?? 0) < 24 * 60 * 60 * 1000);
  downloads = [];
  const c2b = await prepareOfficialDocuments(db, stayton);
  check("C2/N2 once 6h have passed, the next Stage (still inside the cooldown) fetches the seed again and acquires it", (c2b as { acquisition?: string }).acquisition === "within-cooldown"
    && resultFor(c2b, "electrical_application")?.status === "acquired" && JSON.stringify(marionRows("electrical_application")) === JSON.stringify([E01_URL]) && downloads.join() === E01_URL, JSON.stringify({ c2b, downloads }));
  Date.now = realNow;

  // ═══ THE MODEL — the free pass may map ONE cited PDF only when research is allowed ═════════════
  // (Inside the cooldown with a key present, a cited agency PDF stored UNMAPPED would stay a
  // hand-complete blank forever: every later pass finds it held. allowMapping keeps the one mapping
  // call; without it the no-model mapper stores it, as before.)
  const KEST_PAGE = "https://www.co.kestrel.or.us/building";
  const KEST_E = "https://www.co.kestrel.or.us/forms/Electrical%20Permit%20Application.pdf";
  served.set(KEST_E, await acroPdf("Kestrel County Electrical Permit Application"));
  // (the county's own page cited beside the PDF makes co.kestrel.or.us the agency's anchor site)
  saveLookup("City of Kestrelton", [
    { discipline: "electrical", agency: "Kestrel County", src: KEST_E, quote: "Kestrel County Building — Electrical Permit Application", pageSrc: KEST_PAGE },
  ]);
  const kest = { id: "kest-1", ahj: "City of Kestrelton", state: "OR", city: "Kestrelton", zip: "00000", utility: "Pacific Power", homeownerName: "K", projectAddress: "1 K Rd", systemSizeDcKw: 8, systemSizeAcKw: 7,
    parserSnapshot: { permitPathOverride: "prescriptive", mounting: "Roof Mount" } } as never;

  // ═══ N2 at the other two doors: a CITED agency PDF, and the AHJ's own state checklist URL ════════
  // (the memo flag as prepareOfficialDocuments passes it inside the cooldown; no flag = the operator)
  const kestPdf = served.get(KEST_E)!;
  const b5952 = served.get(B5952_URL)!;
  served.delete(KEST_E);
  served.delete(B5952_URL);
  downloads = [];
  const citedFail = await auto.ensureAhjFormTemplate(db, noModel, kest, "electrical_application", { allowResearch: false });
  const listFail = await auto.ensureAhjFormTemplate(db, noModel, kest, "solar_checklist", { allowResearch: false });
  check("N2 (setup) the cited PDF and the checklist URL are fetched and fail", downloads.includes(KEST_E) && downloads.includes(B5952_URL) && citedFail.status === "not_found" && listFail.status === "not_found",
    JSON.stringify({ downloads, citedFail, listFail }));
  downloads = [];
  const citedSkip = await auto.ensureAhjFormTemplate(db, noModel, kest, "electrical_application", { allowResearch: false, skipRecentlyFailed: true });
  const listSkip = await auto.ensureAhjFormTemplate(db, noModel, kest, "solar_checklist", { allowResearch: false, skipRecentlyFailed: true });
  check("N2 inside the cooldown neither is fetched again, and each is named ('tried …, retry after …')", downloads.length === 0
    && citedSkip.status === "not_found" && /not fetched again: tried .* UTC, retry after .* UTC/.test(citedSkip.message) && citedSkip.message.includes(KEST_E)
    && listSkip.status === "not_found" && /tried .* UTC, retry after .* UTC/.test(listSkip.message) && listSkip.message.includes(B5952_URL),
    JSON.stringify({ downloads, citedSkip, listSkip }));
  served.set(KEST_E, kestPdf);
  served.set(B5952_URL, b5952);
  let mapCalls = 0;
  const countingModel = {
    mapAcroFormFields: async () => { mapCalls++; return { textFields: { "Owner name": "project.homeownerName" }, checkboxes: {}, notes: "fixture map" }; },
    mapFlatFormOverlay: async () => { mapCalls++; return { fields: [], signatures: [], notes: "" }; },
  } as never;
  check("MODEL (setup) the county's PDF is this job's cited candidate", agencyMod.agencyApplicationForms(kest, "electrical_application", null).some((f) => f.origin === "cited" && f.sourceUrl === KEST_E),
    JSON.stringify(agencyMod.agencyApplicationForms(kest, "electrical_application", null)));
  const noMap = await auto.ensureAhjFormTemplate(db, countingModel, kest, "electrical_application", { allowResearch: false });
  check("MODEL research off, mapping not allowed: the cited PDF is stored with no model call (unchanged)", mapCalls === 0 && noMap.status === "needs_manual", JSON.stringify({ noMap, mapCalls }));
  db.run("DELETE FROM ahj_form_templates WHERE ahj_name = 'Kestrel County'");
  const mapped = await auto.ensureAhjFormsForProject(db, countingModel, kest, { allowResearch: false, allowMapping: true });
  const mappedE = mapped.results.find((r) => r.formType === "electrical_application");
  check("MODEL research off, mapping allowed (threaded from the per-project pass): the cited PDF is mapped, and it is fillable", mapCalls >= 1 && mappedE?.status === "acquired", JSON.stringify({ mappedE, mapCalls }));

  assert.equal(failed.length, 0, `${failed.length} check(s) failed: ${failed.join(" | ")}`);
  console.log(`stageAcquiresMissingForms: ${passed} checks passed — inside the 24h cooldown Stage still fetches the official forms the job owes (the agency's curated seed, the cited PDF, the state checklist), makes no fetch when they are on file, names a failed seed without a cited fallthrough, and never claims the cooldown or pays for a model it was not allowed; a URL that failed < 6h ago is not re-fetched inside the cooldown (named; the operator's Find fetches now)`);
} finally {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  db.close();
  for (const id of filledDirs) fs.rmSync(path.resolve("backend/data/filled", id), { recursive: true, force: true });
  assert.equal(path.dirname(temp), os.tmpdir());
  fs.rmSync(temp, { recursive: true, force: true });
}
