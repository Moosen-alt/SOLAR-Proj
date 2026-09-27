// THE ISSUING AGENCY'S FORMS, FOR ANY AHJ (agency-apps-close, 2026-09-27 — operator: "THIS NEEDS TO
// BE UNIVERSAL"). The skeptic's three findings on the issuing-agency round, pinned with synthetic
// lookups (no network, no model) and the public Marion / BCD blanks:
//
//   MF1 WHOSE FORM A CITED PDF IS — superseded by RULE 1 below (agency-apps-close2): a PDF is the
//       agency's only on one of its ANCHOR SITES (a site where the lookup cited a PAGE for that agency);
//       a name match in the domain never qualifies it, another entity's host never does, the AHJ's own
//       domain never does, a document host (a CDN) never does. The top-level agency answer's source
//       counts only for a track that same agency issues.
//   MF2 SPLIT AGENCIES — the agency list replaces the city's lines only for the TRACK the agency
//       issues; the city's own lines stay; the county's zoning prerequisite only when the county
//       issues the building permit.
//   MF3 A LINE'S STATUS IS THE INVENTORY'S — "filled" only when a fill exists; "on file (fill
//       pending)", "held, not fillable", "not yet on file" otherwise; no claim at all without it.
//   HELD-OUT — three AHJs in three other states (FL town / county, IA city issuing its own, TX
//       unincorporated / county): routed to the right agency's domain and packet, foreign PDFs refused.
//   RULE 1 — ANCHOR SITES and RULE 2 — PER-FORM STATUS (agency-apps-close2): see their sections.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agency-forms-universal-"));
process.env.AUTOPILOT_DB_PATH = path.join(temp, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.PROJECT_DOCS_DIR = path.join(temp, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(temp, "profiles");
process.env.BACKUP_DIR = path.join(temp, "backups");
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { savePermitProcessLookup } = await import("../src/permitProcess");
const agencyMod = await import("../src/applicationDocsAgency");
const forms = await import("../src/ahjForms");
const auto = await import("../src/ahjFormAuto");
const reqDocs = await import("../src/requiredDocuments");
const { buildApplicationDocumentPackage, findApplicationProfile } = await import("../src/applicationDocs");
const repo = await import("../src/repository");

const db = await openDatabase();
const noModel = new Proxy({}, { get() { throw new Error("no model may be called"); } }) as never;
const fixture = (name: string) => fs.readFileSync(path.join("backend/test/fixtures", name));
const B01S_URL = "https://www.co.marion.or.us/PW/BuildingInspection/Documents/B-01S%20Solar%20Prescriptive%20Installation%20Application%20Filleable.pdf";
const E01_URL = "https://www.co.marion.or.us/PW/BuildingInspection/Documents/E-01%20Renewable%20Energy%20Permit%20Application.pdf";
const B5952_URL = "https://www.oregon.gov/bcd/Formslibrary/5952.pdf";

// Every check runs (a kill shows WHICH pins fall); the banner prints only when none failed.
let passed = 0;
const failed: string[] = [];
const check = (name: string, cond: unknown, detail = ""): void => {
  if (cond) { passed++; return; }
  failed.push(name);
  console.error(`  FAIL - ${name}${detail ? `\n         ${detail.slice(0, 700)}` : ""}`);
};

// ── lookups ───────────────────────────────────────────────────────────────────────────────
const cited = (value: string, sourceUrl: string, quote: string) => ({ value, sourceUrl, quote, origin: "lookup" as const });
const notFound = (why: string, sourceUrl = "", quote = "") => ({ value: null, sourceUrl, quote, origin: "lookup" as const, notFound: why });
// pageSrc: the page the lookup read for this permit's portal and found none (Michael's real lookup:
// portalUrl notFound, sourceUrl https://www.co.marion.or.us/PW/BuildingInspection). docs: the
// lookup's cited document list for the permit (its source is docsSrc, else src).
type PermitSpec = { discipline: "structural" | "electrical" | "combo"; agency: string | null; src: string; quote?: string; docsSrc?: string; feeSrc?: string; pageSrc?: string; docs?: string[] };
function saveLookup(state: string, ahj: string, permits: PermitSpec[], top: unknown = notFound("not stated at the top level")): void {
  const r = savePermitProcessLookup(db, {
    state, ahj, lookedUpAt: new Date().toISOString(), issuingAgency: top,
    permitStructure: cited("separate", permits[0]?.src || "https://example.gov/p", "separate building and electrical permits"),
    permits: permits.map((p) => ({
      discipline: p.discipline, label: `${p.discipline} permit`,
      issuingAgency: p.agency ? cited(p.agency, p.src, p.quote ?? `${p.agency} issues ${p.discipline} permits for ${ahj}`) : notFound("no agency named", p.src),
      portalUrl: p.pageSrc ? notFound("no online portal named", p.pageSrc, "Check permit status online and general information for individual permits") : notFound("none"),
      recordType: notFound("none"),
      documents: p.docs ? { value: p.docs, sourceUrl: p.docsSrc ?? p.src, quote: "application forms", origin: "lookup" as const } : notFound("no list", p.docsSrc ?? ""),
      fee: notFound("none", p.feeSrc ?? ""),
    })),
    notes: [],
  } as never);
  assert.equal((r as { saved?: boolean }).saved, true, `lookup for ${ahj}`);
}
const job = (id: string, state: string, ahj: string, extra: Record<string, unknown> = {}) => ({
  id, ahj, state, city: ahj.replace(/^(?:city|town|village) of /i, ""), zip: "00000", utility: "Pacific Power",
  homeownerName: `Owner ${id}`, projectAddress: `1 ${id} Rd`, systemSizeDcKw: 8, systemSizeAcKw: 7,
  parserSnapshot: { permitPathOverride: "prescriptive", mounting: "Roof Mount", ...extra },
}) as never;

// ── the network: public fixtures and synthetic blanks, every download counted ────────────────
async function acroPdf(title: string): Promise<Buffer> {
  const d = await PDFDocument.create();
  const p = d.addPage([612, 792]);
  p.drawText(title, { x: 40, y: 740, size: 12, font: await d.embedFont(StandardFonts.Helvetica) });
  d.getForm().createTextField("Owner name").addToPage(p, { x: 40, y: 600, width: 200, height: 18 });
  return Buffer.from(await d.save());
}
async function flatPdf(title: string): Promise<Buffer> {
  const d = await PDFDocument.create();
  d.addPage([612, 792]).drawText(title, { x: 40, y: 740, size: 12, font: await d.embedFont(StandardFonts.Helvetica) });
  return Buffer.from(await d.save());
}
const realFetch = globalThis.fetch;
let downloads: string[] = [];
const served = new Map<string, Buffer>([[B01S_URL, fixture("marion-b-01s.pdf")], [E01_URL, fixture("marion-e-01.pdf")], [B5952_URL, fixture("bcd-5952-2024.pdf")]]);
globalThis.fetch = (async (url: string | URL) => {
  const u = String(url);
  downloads.push(u);
  const body = served.get(u);
  if (!body) return new Response("not found", { status: 404 });
  return new Response(body, { headers: { "Content-Type": "application/pdf" } });
}) as typeof fetch;
const urlsOf = (p: never, formType: string, want: "prescriptive" | "structural" | null = "prescriptive") => agencyMod.agencyApplicationForms(p, formType, want).map((f) => f.sourceUrl);
const rowsWithSource = (url: string) => db.query<{ ahj_name: string }>("SELECT ahj_name FROM ahj_form_templates WHERE source_url = ?", [url]).map((r) => r.ahj_name);
const packetList = (p: never) => buildApplicationDocumentPackage(p).profile.requiredDocuments;
const jobList = (p: never) => reqDocs.requiredListCheck(db, p, reqDocs.documentInventory(db, p));
const filledDirs: string[] = [];

try {
  // ═══ MF1 — A CITED PDF IS THE AGENCY'S ONLY ON THE AGENCY'S OWN DOMAIN ════════════════════════
  // S3: the state issues electrical, the citation is a COUNTY's PDF on a .or.us host.
  const LINN_PDF = "https://www.co.linn.or.us/building/Electrical%20Permit%20Application.pdf";
  served.set(LINN_PDF, await acroPdf("Linn County Electrical Permit Application"));
  saveLookup("OR", "City of Stateville", [{ discipline: "electrical", agency: "Oregon Building Codes Division", src: LINN_PDF, quote: "All Electrical permits are submitted to Oregon Building Codes Division" }]);
  const sv = job("state-1", "OR", "City of Stateville");
  check("MF1a the state issues this electrical permit (authority unchanged)", agencyMod.formAuthorityFor(sv, "electrical_application").name === "Oregon Building Codes Division");
  check("MF1a a county's PDF on a .or.us host is not the state agency's application", !urlsOf(sv, "electrical_application", null).includes(LINN_PDF), JSON.stringify(urlsOf(sv, "electrical_application", null)));
  downloads = [];
  const svEns = await auto.ensureAhjFormTemplate(db, noModel, sv, "electrical_application", { allowResearch: false });
  check("MF1a acquisition never fetches it and stores nothing under the state agency", svEns.status === "not_found" && !downloads.includes(LINN_PDF) && rowsWithSource(LINN_PDF).length === 0, JSON.stringify({ status: svEns.status, downloads }));

  // S3b: the CITY's own .gov PDF cited on the county's permit.
  const CITY_PDF = "https://www.fixtureville.gov/forms/Building%20Permit%20Application.pdf";
  served.set(CITY_PDF, await acroPdf("City of Fixtureville Building Permit Application"));
  saveLookup("OR", "City of Fixtureville", [{ discipline: "structural", agency: "Fixture County", src: CITY_PDF }]);
  const fx = job("fx-1", "OR", "City of Fixtureville");
  check("MF1b the AHJ's own .gov PDF is never the county's application", !urlsOf(fx, "building_application").includes(CITY_PDF));
  downloads = [];
  await auto.ensureAhjFormTemplate(db, noModel, fx, "building_application", { allowResearch: false });
  check("MF1b nothing stored under Fixture County from the city's host", rowsWithSource(CITY_PDF).length === 0 && !downloads.includes(CITY_PDF), JSON.stringify(downloads));

  // S3c: the TOP-LEVEL answer is notFound; its source is a third town's .gov PDF.
  const THIRD_PDF = "https://www.thirdtown.gov/docs/Solar%20Permit%20Application.pdf";
  saveLookup("OR", "City of Topville", [{ discipline: "structural", agency: "Top County", src: "https://www.co.top.or.us/building" }],
    notFound("the page names no agency", THIRD_PDF, "Thirdtown solar permit application"));
  check("MF1c a notFound top-level answer's source is never an application", !urlsOf(job("tv-1", "OR", "City of Topville"), "building_application").includes(THIRD_PDF));

  // MF1d: the top-level answer names ANOTHER agency than the track's (the AHJ) — its PDF is not the
  // track agency's, even on that agency's own host; the same PDF under a top-level answer naming the
  // track's agency is.
  const TOP_PDF = "https://www.co.top.or.us/forms/Solar%20Permit%20Application.pdf";
  saveLookup("OR", "City of Topburg", [{ discipline: "structural", agency: "Top County", src: "https://www.co.top.or.us/building" }],
    cited("City of Topburg", TOP_PDF, "City of Topburg permits"));
  check("MF1d a top-level answer naming another agency lends its source to no track", !urlsOf(job("tb-1", "OR", "City of Topburg"), "building_application").includes(TOP_PDF));
  saveLookup("OR", "City of Topham", [{ discipline: "structural", agency: "Top County", src: "https://www.co.top.or.us/building" }],
    cited("Top County", TOP_PDF, "Top County issues building permits for the cities of Top County"));
  check("MF1d the same PDF under a top-level answer naming the track's agency is that agency's", urlsOf(job("th-1", "OR", "City of Topham"), "building_application").includes(TOP_PDF));

  // MF1e: a same-named CITY's domain (cityofmarion.org) is not Marion County's, though the name key matches.
  const CITY_MARION_PDF = "https://www.cityofmarion.org/forms/Solar%20Permit%20Application.pdf";
  saveLookup("OR", "City of Sublimity", [{ discipline: "structural", agency: "Marion County", src: "https://www.co.marion.or.us/PW/Building", docsSrc: CITY_MARION_PDF }]);
  check("MF1e a same-named city's domain is not the county's own", !urlsOf(job("sub-1", "OR", "City of Sublimity"), "building_application").includes(CITY_MARION_PDF));

  // MF1f: a document host (a CDN) never confirms — not even as the lookup's own citation for that
  // permit's agency: the rule would need the agency's own page to link it, and that link cannot be
  // verified offline, so it is refused (agency-apps-close2: the "CDN copy" must-exclude; the round
  // before accepted it).
  const CDN_PDF = "https://cdnsm5-hosted.civiclive.com/UserFiles/Servers/Server_14/File/Building/Solar%20Photovoltaic%20Permit%20Application.pdf";
  saveLookup("OR", "City of Lakeside", [{ discipline: "structural", agency: "Coos County", src: CDN_PDF, quote: "Coos County Building Codes — Solar Photovoltaic Permit Application" }]);
  check("MF1f a CDN PDF the lookup cites AS the agency's own words is NOT confirmed as the agency's", !urlsOf(job("lk-1", "OR", "City of Lakeside"), "building_application").includes(CDN_PDF));
  saveLookup("OR", "City of Lakeshore", [{ discipline: "structural", agency: "Coos County", src: CDN_PDF, quote: "Coos County Building Codes — Solar Photovoltaic Permit Application", pageSrc: "https://www.co.coos.or.us/building" }]);
  check("MF1f nor when the agency's own page is cited too (the page's link to the CDN copy is not verified offline)", !urlsOf(job("lk-2", "OR", "City of Lakeshore"), "building_application").includes(CDN_PDF)
    && agencyMod.unconfirmedAgencyApplicationForms(job("lk-2", "OR", "City of Lakeshore"), "building_application", "prescriptive").some((f) => f.sourceUrl === CDN_PDF));
  saveLookup("OR", "City of Bandon", [{ discipline: "structural", agency: "Coos County", src: "https://www.co.coos.or.us/building", docsSrc: CDN_PDF, feeSrc: "https://library.municode.com/or/coos_county/Building%20Permit%20Application.pdf" }]);
  const bandonUrls = urlsOf(job("bd-1", "OR", "City of Bandon"), "building_application");
  check("MF1f the same CDN PDF on another answer (not the agency's citation) is not", !bandonUrls.includes(CDN_PDF), JSON.stringify(bandonUrls));
  check("MF1f a code publisher's PDF is never an agency's application", !bandonUrls.some((u) => /municode/.test(u)));

  // Positive: the agency's own host qualifies when the lookup cited a PAGE of the agency's there (the
  // round's Fixture County shape, with the page a real lookup carries).
  const OWN_PDF = "https://www.co.fixture.or.us/forms/Solar%20Photovoltaic%20Permit%20Application.pdf";
  saveLookup("OR", "City of Owntown", [{ discipline: "structural", agency: "Fixture County", src: OWN_PDF, pageSrc: "https://www.co.fixture.or.us/building" }]);
  check("MF1g the agency's own host qualifies (a page of the agency's cited there)", urlsOf(job("own-1", "OR", "City of Owntown"), "building_application").includes(OWN_PDF));
  // Michael's shape (permit_process_lookups 'or|city of jefferson' on the .backup copy, portal page included)
  // keeps both curated county applications.
  saveLookup("OR", "City of Jefferson", [
    { discipline: "structural", agency: "Marion County", src: B01S_URL, quote: "Prescriptive Solar Photovoltaic Installation Permit Application · Marion County Public Works", pageSrc: "https://www.co.marion.or.us/PW/BuildingInspection", docsSrc: "https://jeffersonoregon.org/planning-committee/", feeSrc: "https://jeffersonoregon.org/planning-committee/" },
    { discipline: "electrical", agency: "Marion County", src: "https://jeffersonoregon.org/planning-committee/", quote: "All Electrical and Plumbing permits are submitted to Marion County Building and those forms can be found here.", pageSrc: "https://www.co.marion.or.us/PW/BuildingInspection", docsSrc: "https://jeffersonoregon.org/planning-committee/", feeSrc: "https://jeffersonoregon.org/planning-committee/" },
  ]);
  const jefferson = job("jeff-u", "OR", "City of Jefferson");
  check("MF1g Michael's shape: the B-01S and E-01 are Marion County's", urlsOf(jefferson, "building_application").includes(B01S_URL) && urlsOf(jefferson, "electrical_application", null).includes(E01_URL));
  check("MF1g Michael's anchor is co.marion.or.us — the lookup's own Marion page; the city's jeffersonoregon.org is never Marion County's", JSON.stringify(agencyMod.agencyAnchorSites(jefferson, "Marion County")) === JSON.stringify(["co.marion.or.us"]),
    JSON.stringify(agencyMod.agencyAnchorSites(jefferson, "Marion County")));

  // ═══ MF2 — SPLIT AGENCIES KEEP THE CITY'S OWN LINES ═══════════════════════════════════════════
  // Coos Bay: the city issues building itself, Coos County issues electrical.
  const COOS_E = "https://www.co.coos.or.us/sites/default/files/building/Electrical%20Permit%20Application.pdf";
  saveLookup("OR", "City of Coos Bay", [
    { discipline: "structural", agency: "City of Coos Bay", src: "https://www.coosbay.org/departments/community-development/building", quote: "City of Coos Bay issues structural permits" },
    { discipline: "electrical", agency: "Coos County", src: COOS_E, quote: "Electrical permits are issued by Coos County" },
  ]);
  const coos = job("coos-u", "OR", "City of Coos Bay");
  const base = findApplicationProfile(coos).requiredDocuments;
  check("MF2 the Coos Bay base profile names the city's building application", base.some((l) => /Solar application/.test(l)), JSON.stringify(base));
  const coosPacket = packetList(coos);
  check("MF2 the packet KEEPS the city's own building application", coosPacket.some((l) => /^Solar application — PRESCRIPTIVE or STRUCTURAL/.test(l)), JSON.stringify(coosPacket));
  // (The county's cited PDF has no county page beside it in this lookup, so it is listed as cited, to
  // confirm — agency-apps-close2 rule 1; the county's application line is what MF2 pins.)
  check("MF2 and ADDS Coos County's electrical application", coosPacket.some((l) => /^Coos County \(issues the electrical permit\): Coos County's electrical permit application/.test(l)), JSON.stringify(coosPacket));
  check("MF2 (rule 1) the county's PDF with no county page cited is listed to confirm, not as the county's form", coosPacket.some((l) => /^Coos County \(issues the electrical permit\): cited: Electrical Permit Application\.pdf — confirm it is Coos County's form before it is used/.test(l)), JSON.stringify(coosPacket));
  check("MF2 the city's generic electrical line is replaced by the county's", !coosPacket.includes("Renewable Energy (electrical) permit application"));
  check("MF2 one checklist line, not two", coosPacket.filter((l) => /checklist/i.test(l)).length === 1, JSON.stringify(coosPacket));
  check("MF2 the plan set line stays", coosPacket.includes("Plan set and specifications"));
  check("MF2 no county zoning prerequisite where the city issues its own building permit", !coosPacket.some((l) => /zoning approval before/.test(l)), JSON.stringify(coosPacket));
  const coosJob = jobList(coos);
  check("MF2 docs.complete's list keeps the city's building application", coosJob.items.some((i) => /^Solar application/.test(i.text) && i.docTypes.includes("building_application")), JSON.stringify(coosJob.items.map((i) => i.text)));
  check("MF2 and the county's electrical application", coosJob.items.some((i) => /^Coos County/.test(i.text) && i.docTypes.includes("electrical_application")));
  check("MF2 and no zoning prerequisite", !coosJob.items.some((i) => /zoning approval/.test(i.text)));
  check("MF2 the rows stay: the city's building row and the county's electrical row", (() => {
    const rows = reqDocs.documentInventory(db, coos).presence;
    const b = rows.find((r) => r.docType === "building_application");
    const e = rows.find((r) => r.docType === "electrical_application");
    return b && !/Coos County/.test(b.label) && e && /Coos County/.test(e.label);
  })());

  // The ENGINEERED path: the state checklist is not owed, and the city's checklist line does not
  // survive the split either (the prescriptive checklist is the upload the AHJ forbids there).
  const coosEng = job("coos-eng", "OR", "City of Coos Bay", { permitPathOverride: "engineered" });
  const coosEngPacket = packetList(coosEng);
  check("MF2 engineered split: the city's building application stays, no checklist line at all", coosEngPacket.some((l) => /^Solar application/.test(l)) && !coosEngPacket.some((l) => /checklist/i.test(l)), JSON.stringify(coosEngPacket));

  // Happy Valley: the city issues building, Clackamas County issues electrical.
  const CLACK_E = "https://www.clackamas.us/sites/default/files/building/Electrical%20Permit%20Application.pdf";
  saveLookup("OR", "City of Happy Valley", [
    { discipline: "structural", agency: "City of Happy Valley", src: "https://www.happyvalleyor.gov/services/building/", quote: "City of Happy Valley Building Division issues building permits" },
    { discipline: "electrical", agency: "Clackamas County", src: CLACK_E, quote: "Electrical permits are filed separately with Clackamas County" },
  ]);
  const hv = job("hv-u", "OR", "City of Happy Valley");
  const hvPacket = packetList(hv);
  check("MF2 Happy Valley keeps its own building application and adds Clackamas County's electrical", hvPacket.some((l) => /^Solar application/.test(l)) && hvPacket.some((l) => /^Clackamas County \(issues the electrical permit\)/.test(l)) && !hvPacket.some((l) => /zoning approval before/.test(l)), JSON.stringify(hvPacket));

  // The county issues BUILDING (the city its own electrical): the zoning step stays.
  saveLookup("OR", "City of Twoagency", [
    { discipline: "structural", agency: "Marion County", src: B01S_URL },
    { discipline: "electrical", agency: "City of Twoagency", src: "https://www.twoagency.gov/electrical", quote: "City of Twoagency issues electrical permits" },
  ]);
  const twoPacket = packetList(job("two-u", "OR", "City of Twoagency"));
  check("MF2 the county's zoning step stays where the county issues the building permit", twoPacket.some((l) => /City of Twoagency zoning approval before Marion County/.test(l)), JSON.stringify(twoPacket));

  // Michael (the county issues both): the list's shape is unchanged.
  const jPacket = packetList(jefferson);
  check("MF2 Michael's packet: B-01S, E-01, 5952, zoning step, plan set — in that order", jPacket.length === 5 && /^Marion County \(issues the structural \(building\) permit\): .*B-01S/.test(jPacket[0]) && /^Marion County \(issues the electrical permit\): .*E-01/.test(jPacket[1])
    && /^Oregon BCD 440-5952/.test(jPacket[2]) && /^City of Jefferson zoning approval before Marion County/.test(jPacket[3]) && jPacket[4] === "Plan set and specs", JSON.stringify(jPacket));
  check("MF2 Michael's job list keeps its four items", jobList(jefferson).items.length === 4, JSON.stringify(jobList(jefferson).items.map((i) => i.text)));

  // ═══ MF3 — A LINE'S STATUS IS THE INVENTORY'S ════════════════════════════════════════════════
  // The real write path and the real packet door (repository.getApplicationDocumentPackage).
  saveLookup("OR", "City of Aumsville", [
    { discipline: "structural", agency: "Marion County", src: B01S_URL },
    { discipline: "electrical", agency: "Marion County", src: "https://www.aumsville.us/building", quote: "Electrical permits are issued by Marion County" },
  ]);
  const created = repo.createProject(db, {
    owner: "Status Owner", street: "1 Status Rd", city: "Aumsville", state: "OR", zip: "97325", ahj: "City of Aumsville", utility: "Pacific Power", dcKw: "15.91", acKw: "12.9",
    permitPathOverride: "prescriptive", homeownerPhone: "4580000000", mounting: "Roof Mount", structureDescription: "Single-family dwelling",
    snow: "20", wind: "C", windSpeed: "110", deadLoad: "1.28", lightFrame: "yes", roofRafterSpacing: "24", framingType: "truss", moduleQuantity: "37",
    gravityWindDesign: "yes", manufacturerInstallation: "yes", roofMaterial: "Composition Shingle", roofLayers: "1", attachmentToFraming: "yes", attachmentSpacingIn: "48", attachmentsOutsideEdgeZone: "yes",
  } as never).project;
  filledDirs.push(created.id);
  const doorList = () => repo.getApplicationDocumentPackage(db, created.id).profile.requiredDocuments;
  const statusOf = (lines: string[], re: RegExp) => lines.find((l) => re.test(l)) ?? "";
  // MF2 AT THE DOOR: the project's birth learn wrote the base profile's lines to the KB, and the door
  // merges learned lines back in — a learned line for a track the county issues must not return.
  const doorPkg = repo.getApplicationDocumentPackage(db, created.id);
  const learnedLines = doorPkg.learnedRequirements?.requiredDocuments ?? [];
  check("MF2 (door fixture) the learned KB row carries the city's portal-entry and checklist lines", learnedLines.some((l) => /portal entry/i.test(l)) && learnedLines.some((l) => /checklist/i.test(l)), JSON.stringify(learnedLines));
  check("MF2 at the door: no learned line for a track the county issues comes back (no portal entry, one checklist)", !doorPkg.profile.requiredDocuments.some((l) => /portal entry/i.test(l)) && doorPkg.profile.requiredDocuments.filter((l) => /checklist/i.test(l)).length === 1, JSON.stringify(doorPkg.profile.requiredDocuments));
  check("MF2 at the door: learned lines that are no track's application stay", learnedLines.filter((l) => !agencyMod.agencyListReplacesLine(agencyMod.issuingAgencyDocumentList(created)!, l)).every((l) => doorPkg.profile.requiredDocuments.includes(l)));
  const before = doorList();
  check("MF3 before acquisition: the county's B-01S is 'not yet on file', never 'filled'", /— not yet on file/.test(statusOf(before, /B-01S/)) && !/— filled$/.test(statusOf(before, /B-01S/)), JSON.stringify(before));
  check("MF3 before acquisition: the E-01 likewise", /— not yet on file/.test(statusOf(before, /E-01/)));
  check("MF3 before acquisition: the 5952 is 'not yet on file'", /— not yet on file/.test(statusOf(before, /440-5952/)), statusOf(before, /440-5952/));
  const manifest = repo.getApplicationDocumentPackage(db, created.id).docs.find((d) => d.documentType === "manifest")?.markdown ?? "";
  check("MF3 the printed manifest carries the same status, never 'filled'", /B-01S[^\n]*— not yet on file/.test(manifest) && !/^- [^\n]*— filled$/m.test(manifest), manifest.slice(0, 600));
  const listBefore = reqDocs.requiredListCheck(db, created, reqDocs.documentInventory(db, created));
  check("MF3 docs.complete prints the same status", listBefore.items.some((i) => /B-01S.*— not yet on file/.test(i.text)) && !listBefore.items.some((i) => /— filled$/.test(i.text)), JSON.stringify(listBefore.items.map((i) => i.text)));

  downloads = [];
  const ens = await auto.ensureAhjFormsForProject(db, noModel, created, { allowResearch: false });
  check("MF3 (setup) the county's two applications and the 5952 acquired", ens.results.every((r) => r.status === "acquired" || r.status === "exists"), JSON.stringify(ens.results.map((r) => [r.formType, r.status])));
  const held = doorList();
  check("MF3 held and fillable, not yet filled: 'on file (fill pending)'", /— on file \(fill pending\)$/.test(statusOf(held, /B-01S/)) && /— on file \(fill pending\)$/.test(statusOf(held, /E-01/)) && /— on file \(fill pending\)$/.test(statusOf(held, /440-5952/)), JSON.stringify(held));
  const pkgFill = await forms.buildFilledFormsForProject(db, created);
  check("MF3 (setup) the fill ran", pkgFill.forms.filter((f) => f.status === "filled").length >= 3, JSON.stringify(pkgFill.forms.map((f) => [f.formName, f.status])));
  const filled = doorList();
  check("MF3 a fill on disk for this path: 'filled'", /— filled$/.test(statusOf(filled, /B-01S/)) && /— filled$/.test(statusOf(filled, /E-01/)) && /— filled$/.test(statusOf(filled, /440-5952/)), JSON.stringify(filled));
  const listAfter = reqDocs.requiredListCheck(db, created, reqDocs.documentInventory(db, created));
  check("MF3 docs.complete agrees: 'filled' lines are the present ones", listAfter.items.filter((i) => /— filled$/.test(i.text)).every((i) => i.present), JSON.stringify(listAfter.items.map((i) => [i.text.slice(0, 60), i.present])));
  // Off-path: the structural path makes the prescriptive B-01S not this job's — no "filled" for it.
  const engineered = { ...created, parserSnapshot: { ...created.parserSnapshot, permitPathOverride: "engineered" } } as never;
  const engList = reqDocs.requiredListCheck(db, engineered, reqDocs.documentInventory(db, engineered)).items.map((i) => i.text);
  check("MF3 an off-path fill never reads as 'filled' (engineered job, prescriptive B-01S on disk)", engList.some((t) => /^Marion County \(issues the structural/.test(t)) && !engList.some((t) => /^Marion County \(issues the structural/.test(t) && /— filled$/.test(t)), JSON.stringify(engList));

  // Held but NOT fillable (a flat scan): never "filled", before or after a fill run.
  const FLAT_URL = "https://www.co.flat.or.us/forms/Solar%20Photovoltaic%20Permit%20Application.pdf";
  served.set(FLAT_URL, await flatPdf("Flat County Solar Photovoltaic Permit Application"));
  saveLookup("OR", "City of Flatville", [{ discipline: "structural", agency: "Flat County", src: FLAT_URL, pageSrc: "https://www.co.flat.or.us/building" }]);
  const flatJob = repo.createProject(db, { owner: "Flat Owner", street: "1 Flat Rd", city: "Flatville", state: "OR", ahj: "City of Flatville", utility: "Pacific Power", dcKw: "8", acKw: "7", permitPathOverride: "prescriptive" } as never).project;
  filledDirs.push(flatJob.id);
  const flatBefore = repo.getApplicationDocumentPackage(db, flatJob.id).profile.requiredDocuments;
  check("MF3 a cited blank not yet fetched: 'not yet on file'", /— not yet on file/.test(statusOf(flatBefore, /^Flat County/)), JSON.stringify(flatBefore));
  const flatEns = await auto.ensureAhjFormTemplate(db, noModel, flatJob, "building_application", { allowResearch: false });
  check("MF3 (setup) stored as a blank to complete by hand", flatEns.status === "needs_manual", JSON.stringify(flatEns));
  await forms.buildFilledFormsForProject(db, flatJob);
  const flatAfter = repo.getApplicationDocumentPackage(db, flatJob.id).profile.requiredDocuments;
  check("MF3 held, not fillable: says so, never 'filled'", /— held, not fillable \(complete by hand and attach\)$/.test(statusOf(flatAfter, /^Flat County/)), JSON.stringify(flatAfter));

  // No inventory in hand (a packet built without the database): the line claims nothing.
  const bare = packetList(jefferson);
  check("MF3 without the inventory a line names the form and claims no status", !bare.some((l) => /— (?:filled|on file|not yet on file|held)/.test(l)), JSON.stringify(bare));

  // ═══ HELD-OUT — three AHJs in three states the builders never used ═══════════════════════════
  // FL: Palm Beach County issues building and electrical for the Town of Glen Ridge.
  const PBC_B = "https://discover.pbcgov.org/pzb/building/Forms/Solar%20Photovoltaic%20Permit%20Application.pdf";
  const PBC_E = "https://discover.pbcgov.org/pzb/building/Forms/Electrical%20Permit%20Application.pdf";
  const PBG_PDF = "https://www.pbgfl.gov/DocumentCenter/View/1/Solar-Permit-Application.pdf";
  const MUNI_PDF = "https://library.municode.com/fl/palm_beach_county/Building%20Permit%20Application.pdf";
  served.set(PBC_B, await acroPdf("Palm Beach County Solar Photovoltaic Permit Application"));
  served.set(PBC_E, await acroPdf("Palm Beach County Electrical Permit Application"));
  served.set(PBG_PDF, await acroPdf("City of Palm Beach Gardens Solar Permit Application"));
  // (agency-apps-close2: the county's building page is on the lookup — the page a real lookup cites, as
  // Michael's cites co.marion.or.us/PW/BuildingInspection. Without it the PDF is the county's only
  // citation, the deschutes.org shape, and is listed to confirm: pinned in RULE 1 below.)
  const PBC_PAGE = "https://discover.pbcgov.org/pzb/building/Pages/default.aspx";
  saveLookup("FL", "Town of Glen Ridge", [
    { discipline: "structural", agency: "Palm Beach County", src: PBC_B, quote: "Palm Beach County Building Division — Solar Photovoltaic Permit Application", docsSrc: PBG_PDF, feeSrc: MUNI_PDF, pageSrc: PBC_PAGE },
    { discipline: "electrical", agency: "Palm Beach County", src: PBC_E, quote: "Palm Beach County Building Division — Electrical Permit Application", pageSrc: PBC_PAGE },
  ]);
  const glen = job("glen-1", "FL", "Town of Glen Ridge");
  const glenB = urlsOf(glen, "building_application", null);
  check("HELD-OUT FL: the county's own PDF (pbcgov.org) is Palm Beach County's application", glenB.includes(PBC_B) && urlsOf(glen, "electrical_application", null).includes(PBC_E), JSON.stringify(glenB));
  check("HELD-OUT FL: another city's .gov PDF and a code publisher's PDF are refused", !glenB.includes(PBG_PDF) && !glenB.includes(MUNI_PDF));
  downloads = [];
  const glenEns = await auto.ensureAhjFormTemplate(db, noModel, glen, "building_application", { allowResearch: false });
  check("HELD-OUT FL: fetched once, stored under Palm Beach County with its source", ["acquired", "needs_manual"].includes(glenEns.status) && downloads.length === 1 && downloads[0] === PBC_B
    && rowsWithSource(PBC_B).join() === "Palm Beach County", JSON.stringify({ glenEns, downloads, rows: rowsWithSource(PBC_B) }));
  saveLookup("FL", "Town of Cloud Lake", [{ discipline: "structural", agency: "Palm Beach County", src: "https://discover.pbcgov.org/pzb/building/Pages/default.aspx" }]);
  const cloudHeld = [...forms.loadStoredTemplates(db, "Town of Cloud Lake", "FL").map((t) => t.sourceUrl), ...forms.heldUnfillableAgencyBlanks(db, { ahj: "Town of Cloud Lake", state: "FL" }).map((b) => b.sourceUrl)];
  check("HELD-OUT FL: another town the county issues for finds the same county form", cloudHeld.includes(PBC_B), JSON.stringify(cloudHeld));
  const glenPacket = packetList(glen);
  check("HELD-OUT FL: the packet names Palm Beach County's applications, no Oregon checklist", glenPacket.some((l) => /^Palm Beach County \(issues the structural \(building\) permit\): Solar Photovoltaic Permit Application/.test(l)) && glenPacket.some((l) => /^Palm Beach County \(issues the electrical permit\)/.test(l)) && !glenPacket.some((l) => /5952/.test(l)), JSON.stringify(glenPacket));

  // IA: the City of Ames issues its own building and electrical permits.
  const STORY_PDF = "https://www.storycountyiowa.gov/DocumentCenter/View/55/Building-Permit-Application.pdf";
  saveLookup("IA", "City of Ames", [
    { discipline: "structural", agency: "City of Ames Inspections Division", src: "https://www.cityofames.org/government/departments-divisions-i-z/inspections", docsSrc: STORY_PDF },
    { discipline: "electrical", agency: "City of Ames", src: "https://www.cityofames.org/government/departments-divisions-i-z/inspections/electrical" },
  ]);
  const ames = job("ames-1", "IA", "City of Ames");
  check("HELD-OUT IA: a city that issues its own keeps its own forms on both tracks", !agencyMod.formAuthorityFor(ames, "building_application").issuedByOther && !agencyMod.formAuthorityFor(ames, "electrical_application").issuedByOther);
  check("HELD-OUT IA: no agency list, no agency form — the county's PDF is never taken", agencyMod.issuingAgencyDocumentList(ames) === null && urlsOf(ames, "building_application", null).length === 0);
  auto.storeAhjFormTemplate(db, { ahjName: "Story County", state: "IA", formType: "building_application", filename: "Story County Building Permit Application.pdf", bytes: await acroPdf("Story County"),
    map: { formName: "Story County Building Permit Application", sourceUrl: STORY_PDF, fillMode: "acroform", textFields: { "Owner name": "project.homeownerName" }, checkboxes: {}, notes: "" } });
  auto.storeAhjFormTemplate(db, { ahjName: "City of Ames", state: "IA", formType: "building_application", filename: "City of Ames Building Permit Application.pdf", bytes: await acroPdf("Ames"),
    map: { formName: "City of Ames Building Permit Application", sourceUrl: "https://www.cityofames.org/home/showpublisheddocument/100", fillMode: "acroform", textFields: { "Owner name": "project.homeownerName" }, checkboxes: {}, notes: "" } });
  const amesLoaded = forms.loadStoredTemplates(db, "City of Ames", "IA").map((t) => t.authority);
  check("HELD-OUT IA: the loader holds the city's own form only", amesLoaded.length === 1 && amesLoaded[0] === "City of Ames", JSON.stringify(amesLoaded));
  check("HELD-OUT IA: the packet is the base profile's, unchanged", JSON.stringify(packetList(ames)) === JSON.stringify(findApplicationProfile(ames).requiredDocuments));

  // TX: Harris County issues the building permit in unincorporated Cypress.
  const HC_B = "https://engineering.harriscountytx.gov/Portals/0/Permits/Residential%20Solar%20Permit%20Application.pdf";
  const HOU_PDF = "https://www.houstontx.gov/planning/forms/Solar%20Permit%20Application.pdf";
  served.set(HC_B, await acroPdf("Harris County Residential Solar Permit Application"));
  served.set(HOU_PDF, await acroPdf("City of Houston Solar Permit Application"));
  const HC_PAGE = "https://engineering.harriscountytx.gov/Permits/Residential";
  saveLookup("TX", "Cypress", [{ discipline: "structural", agency: "Harris County", src: HC_B, quote: "Harris County Engineering Department — Residential Solar Permit Application (unincorporated Harris County)", docsSrc: HOU_PDF, pageSrc: HC_PAGE }]);
  const cypress = job("cy-1", "TX", "Cypress");
  const cyUrls = urlsOf(cypress, "building_application", null);
  check("HELD-OUT TX: the county's own PDF (harriscountytx.gov) is Harris County's application; the City of Houston's is refused", cyUrls.includes(HC_B) && !cyUrls.includes(HOU_PDF), JSON.stringify(cyUrls));
  downloads = [];
  await auto.ensureAhjFormTemplate(db, noModel, cypress, "building_application", { allowResearch: false });
  check("HELD-OUT TX: stored under Harris County, the Houston PDF never fetched", rowsWithSource(HC_B).join() === "Harris County" && !downloads.includes(HOU_PDF), JSON.stringify({ downloads, rows: rowsWithSource(HC_B) }));
  const cyPacket = packetList(cypress);
  check("HELD-OUT TX: the packet names Harris County's application; no city zoning step for an unincorporated AHJ", cyPacket.some((l) => /^Harris County \(issues the structural \(building\) permit\): Residential Solar Permit Application/.test(l)) && !cyPacket.some((l) => /zoning approval/.test(l)), JSON.stringify(cyPacket));

  // ═══ RULE 1 — ANCHOR SITES (agency-apps-close2; operator: "THIS NEEDS TO BE UNIVERSAL") ═══════════
  // A cited application PDF is agency A's ONLY when its site (registrable domain) is one where the
  // lookup cited a PAGE for A — A's permit's issuingAgency / portalUrl / documents / fee source, or the
  // top-level answer's when it names A. A PDF never anchors (not itself, not another PDF). No name
  // match creates an anchor; names only ever REMOVE one (the AHJ's own domain; a host naming another
  // type of jurisdiction). A document host (CDN, code publisher, mirror) never anchors. Everything
  // else the lookup cited is listed "cited: <file> — confirm it is <A>'s form before it is used":
  // not acquired, not filled, blocking only while the track's application is owed.
  const fileOf = (u: string) => decodeURIComponent(new URL(u).pathname.split("/").pop() || "");
  const unconfirmedOf = (p: never, ft: string, want: "prescriptive" | "structural" | null = "prescriptive") => agencyMod.unconfirmedAgencyApplicationForms(p, ft, want).map((f) => f.sourceUrl);
  const citedLine = (lines: string[], u: string, agency: string) => lines.find((l) => l.includes(`cited: ${fileOf(u)} — confirm it is ${agency}'s form before it is used`)) ?? "";
  async function refusedEverywhere(label: string, p: never, ft: string, u: string, agency: string): Promise<void> {
    const want = ft === "electrical_application" ? null : "prescriptive";
    check(`${label}: not ${agency}'s application`, !urlsOf(p, ft, want).includes(u), JSON.stringify(urlsOf(p, ft, want)));
    check(`${label}: listed as cited, to confirm`, unconfirmedOf(p, ft, want).includes(u) && Boolean(citedLine(packetList(p), u, agency)), JSON.stringify(packetList(p)));
    downloads = [];
    await auto.ensureAhjFormTemplate(db, noModel, p, ft, { allowResearch: false });
    check(`${label}: never fetched, never stored`, !downloads.includes(u) && rowsWithSource(u).length === 0, JSON.stringify({ downloads, rows: rowsWithSource(u) }));
  }

  // R1a THE PREVIOUS SKEPTIC'S OREGON SHAPES — a state-issued permit (or another county's) whose only
  // citation is a county's / a city's PDF, on hosts no ".gov" test catches.
  const OR_SHAPES: Array<[string, string, "structural" | "electrical", string]> = [
    ["City of Veneta", "Oregon Building Codes Division", "electrical", "https://www.lanecounty.org/UserFiles/Servers/Server_3585797/File/Electrical%20Permit%20Application.pdf"],
    ["City of Sisters", "Oregon Building Codes Division", "electrical", "https://www.deschutes.org/sites/default/files/fileattachments/community_development/page/Electrical%20Permit%20Application.pdf"],
    ["City of Scio", "Oregon Building Codes Division", "electrical", "https://www.co.linn.or.us/building/Electrical%20Permit%20Application.pdf"],
    ["City of Estacada", "Oregon Building Codes Division", "electrical", "https://www.clackamas.us/sites/default/files/building/Electrical%20Permit%20Application.pdf"],
    ["City of Maywood Park", "Oregon Building Codes Division", "electrical", "https://www.multco.us/file/Electrical%20Permit%20Application.pdf"],
    ["City of Culver", "Jefferson County", "structural", "https://jeffersonoregon.org/wp-content/uploads/Solar%20Permit%20Application.pdf"],
  ];
  for (const [ahj, agency, discipline, u] of OR_SHAPES) {
    served.set(u, await acroPdf(`${fileOf(u)} (${new URL(u).hostname})`));
    saveLookup("OR", ahj, [{ discipline, agency, src: u, quote: `All ${discipline} permits are submitted to ${agency}` }]);
    await refusedEverywhere(`R1a ${ahj} (${agency}, ${new URL(u).hostname})`, job(`r1a-${ahj}`, "OR", ahj), discipline === "electrical" ? "electrical_application" : "building_application", u, agency);
  }

  // R1b THE CITY OF BOULDER UNDER BOULDER COUNTY — the county's own page anchors bouldercounty.gov; the
  // city's bouldercolorado.gov and ci.boulder.co.us PDFs are never the county's.
  const BOCO_PAGE = "https://bouldercounty.gov/property-and-land/land-use/building/";
  const BOCO_OWN = "https://assets.bouldercounty.gov/wp-content/uploads/2024/01/Solar%20Photovoltaic%20Permit%20Application.pdf";
  const CITY_BOULDER = "https://bouldercolorado.gov/media/4411/download/Solar%20Permit%20Application.pdf";
  const CITY_BOULDER_OLD = "https://www.ci.boulder.co.us/files/PDS/forms/Electrical%20Permit%20Application.pdf";
  served.set(BOCO_OWN, await acroPdf("Boulder County Solar PV Permit Application"));
  served.set(CITY_BOULDER, await acroPdf("City of Boulder Solar Permit Application"));
  served.set(CITY_BOULDER_OLD, await acroPdf("City of Boulder Electrical Permit Application"));
  saveLookup("CO", "Town of Jamestown", [
    { discipline: "structural", agency: "Boulder County", src: BOCO_PAGE, docs: [CITY_BOULDER, BOCO_OWN] },
    { discipline: "electrical", agency: "Boulder County", src: BOCO_PAGE, docs: [CITY_BOULDER_OLD] },
  ]);
  const jt = job("r1b-jt", "CO", "Town of Jamestown");
  check("R1b the county's own PDF (assets.bouldercounty.gov, the page's site) is Boulder County's", JSON.stringify(urlsOf(jt, "building_application")) === JSON.stringify([BOCO_OWN]), JSON.stringify(urlsOf(jt, "building_application")));
  await refusedEverywhere("R1b the City of Boulder's bouldercolorado.gov PDF", jt, "building_application", CITY_BOULDER, "Boulder County");
  await refusedEverywhere("R1b the City of Boulder's ci.boulder.co.us PDF", jt, "electrical_application", CITY_BOULDER_OLD, "Boulder County");
  check("R1b only the county's own blank was stored under Boulder County", rowsWithSource(BOCO_OWN).join() === "Boulder County" && db.query<{ n: number }>("SELECT COUNT(*) AS n FROM ahj_form_templates WHERE ahj_name = 'Boulder County'")[0].n === 1);

  // R1c FAIRFAX: the City of Fairfax (fairfaxva.gov) under Fairfax County (fairfaxcounty.gov).
  const FFX_PAGE = "https://www.fairfaxcounty.gov/landdevelopment/building-permits";
  const FFX_CITY = "https://www.fairfaxva.gov/home/showpublisheddocument/1234/Residential%20Solar%20Building%20Permit%20Application.pdf";
  const FFX_CO = "https://www.fairfaxcounty.gov/landdevelopment/sites/landdevelopment/files/Assets/documents/pdf/Solar%20Building%20Permit%20Application.pdf";
  served.set(FFX_CITY, await acroPdf("City of Fairfax Residential Solar Building Permit Application"));
  served.set(FFX_CO, await acroPdf("Fairfax County Solar Building Permit Application"));
  saveLookup("VA", "Town of Vienna", [
    { discipline: "structural", agency: "Fairfax County", src: FFX_PAGE, docs: [FFX_CITY, FFX_CO] },
    { discipline: "electrical", agency: "Fairfax County", src: FFX_PAGE },
  ]);
  const vie = job("r1c-vie", "VA", "Town of Vienna");
  check("R1c Fairfax County's own PDF is its application", JSON.stringify(urlsOf(vie, "building_application")) === JSON.stringify([FFX_CO]), JSON.stringify(urlsOf(vie, "building_application")));
  await refusedEverywhere("R1c the City of Fairfax's fairfaxva.gov PDF", vie, "building_application", FFX_CITY, "Fairfax County");

  // R1d NAME-BLIND BOTH WAYS: the agency's PDF on a domain that NAMES the agency, with no page of the
  // agency's cited anywhere, is not confirmed either — a county (Harris) and a state agency (the BCD).
  const HC_ONLY = "https://engineering.harriscountytx.gov/Portals/0/Permits/Residential%20Solar%20Permit%20Application%202.pdf";
  served.set(HC_ONLY, await acroPdf("Harris County Residential Solar Permit Application"));
  saveLookup("TX", "Cypress Creek", [{ discipline: "structural", agency: "Harris County", src: HC_ONLY, quote: "Harris County Engineering Department — Residential Solar Permit Application" }]);
  await refusedEverywhere("R1d a county's PDF on its own-named domain, cited alone (the builder's TX shape without a page)", job("r1d-cc", "TX", "Cypress Creek"), "building_application", HC_ONLY, "Harris County");
  const BCD_E = "https://www.oregon.gov/bcd/Formslibrary/Electrical%20Permit%20Application.pdf";
  served.set(BCD_E, await acroPdf("BCD Electrical Permit Application"));
  saveLookup("OR", "City of Stateburg", [{ discipline: "electrical", agency: "Oregon Building Codes Division", src: BCD_E, quote: "Oregon Building Codes Division — Electrical Permit Application" }]);
  await refusedEverywhere("R1d a state agency's PDF on its own-named domain, cited alone", job("r1d-sb", "OR", "City of Stateburg"), "electrical_application", BCD_E, "Oregon Building Codes Division");
  saveLookup("OR", "City of Owntown Two", [{ discipline: "structural", agency: "Fixture County", src: OWN_PDF }]);
  check("R1d the round's Owntown PDF with no page cited is not confirmed", !urlsOf(job("r1d-ow", "OR", "City of Owntown Two"), "building_application").includes(OWN_PDF));

  // R1e NAMES ONLY REMOVE AN ANCHOR. (i) A page on the AHJ's OWN domain cited for the county never
  // anchors the county (the city's page saying "submit to the county"): the city's PDF beside it is
  // refused. (ii) A site the lookup cites for the AHJ's OWN permit is the AHJ's, whatever its name.
  // (iii) A host naming another TYPE of jurisdiction never anchors a state agency.
  const MB_PAGE = "https://www.millbrookoregon.gov/building";
  const MB_PDF = "https://www.millbrookoregon.gov/forms/Solar%20Permit%20Application.pdf";
  served.set(MB_PDF, await acroPdf("City of Millbrook Solar Permit Application"));
  saveLookup("OR", "City of Millbrook", [{ discipline: "structural", agency: "Fixture County", src: MB_PAGE, quote: "Structural permits are submitted to Fixture County", docs: [MB_PDF] }]);
  const mb = job("r1e-mb", "OR", "City of Millbrook");
  check("R1e(i) the AHJ's own-domain page is not the county's anchor", !agencyMod.agencyAnchorSites(mb, "Fixture County").includes("millbrookoregon.gov"), JSON.stringify(agencyMod.agencyAnchorSites(mb, "Fixture County")));
  await refusedEverywhere("R1e(i) the city's PDF beside the city's page", mb, "building_application", MB_PDF, "Fixture County");
  const BH_OWN_PAGE = "https://www.bayharbor-info.org/building";
  const BH_PDF = "https://www.bayharbor-info.org/files/Electrical%20Permit%20Application.pdf";
  served.set(BH_PDF, await acroPdf("Bay Harbor Electrical Permit Application"));
  saveLookup("OR", "City of Bay Harbor", [
    { discipline: "structural", agency: "City of Bay Harbor", src: BH_OWN_PAGE, quote: "City of Bay Harbor issues building permits" },
    { discipline: "electrical", agency: "Coos County", src: "https://www.bayharbor-info.org/electrical", quote: "Electrical permits are issued by Coos County", docs: [BH_PDF] },
  ]);
  const bh = job("r1e-bh", "OR", "City of Bay Harbor");
  check("R1e(ii) a site the lookup cites for the AHJ's own permit is not the county's anchor", !agencyMod.agencyAnchorSites(bh, "Coos County").includes("bayharbor-info.org"), JSON.stringify(agencyMod.agencyAnchorSites(bh, "Coos County")));
  await refusedEverywhere("R1e(ii) the AHJ-site PDF on the county's permit", bh, "electrical_application", BH_PDF, "Coos County");
  const SKAGIT_NET = "https://www.skagitcounty.net/PlanningAndPermit/Documents/Electrical%20Permit%20Application.pdf";
  const LNI_OWN = "https://lni.wa.gov/forms-publications/Electrical%20Permit%20Application%20F500-094-000.pdf";
  const LNI = "Washington State Department of Labor & Industries";
  served.set(SKAGIT_NET, await acroPdf("Skagit County Electrical Permit Application"));
  served.set(LNI_OWN, await acroPdf("LNI Electrical Work Permit Application"));
  saveLookup("WA", "City of Sedro-Woolley", [
    { discipline: "structural", agency: "City of Sedro-Woolley", src: "https://www.sedro-woolley.gov/building" },
    { discipline: "electrical", agency: LNI, src: "https://www.skagitcounty.net/PlanningAndPermit/electrical.htm", docs: [SKAGIT_NET, LNI_OWN] },
  ]);
  const sw = job("r1e-sw", "WA", "City of Sedro-Woolley");
  check("R1e(iii) a county-named host never anchors the state agency", agencyMod.agencyAnchorSites(sw, LNI).length === 0, JSON.stringify(agencyMod.agencyAnchorSites(sw, LNI)));
  await refusedEverywhere("R1e(iii) the county's PDF under the state agency", sw, "electrical_application", SKAGIT_NET, LNI);
  check("R1e(iii) and the state's own PDF is not confirmed by its name either (lni.wa.gov: no page there)", !urlsOf(sw, "electrical_application", null).includes(LNI_OWN) && unconfirmedOf(sw, "electrical_application", null).includes(LNI_OWN));

  // R1f MICHAEL'S REAL SHAPE, on an agency with no curated seed: the anchor is the lookup's own notFound
  // portal answer's page (co.fixture.or.us/building); the city's pages (docs, fee, the electrical
  // citation) are the city's.
  const RS_PDF = "https://www.co.fixture.or.us/PW/Documents/Solar%20Prescriptive%20Installation%20Application.pdf";
  const RS_CITY = "https://realshapeoregon.org/planning-committee/";
  saveLookup("OR", "City of Realshape", [
    { discipline: "structural", agency: "Fixture County", src: RS_PDF, quote: "Prescriptive Solar Photovoltaic Installation Permit Application · Fixture County Public Works", pageSrc: "https://www.co.fixture.or.us/PW/BuildingInspection", docsSrc: RS_CITY, feeSrc: RS_CITY },
    { discipline: "electrical", agency: "Fixture County", src: RS_CITY, quote: "All Electrical permits are submitted to Fixture County Building", pageSrc: "https://www.co.fixture.or.us/PW/BuildingInspection", docsSrc: RS_CITY, feeSrc: RS_CITY },
  ]);
  const rs = job("r1f-rs", "OR", "City of Realshape");
  check("R1f the anchor is exactly the county's site", JSON.stringify(agencyMod.agencyAnchorSites(rs, "Fixture County")) === JSON.stringify(["co.fixture.or.us"]), JSON.stringify(agencyMod.agencyAnchorSites(rs, "Fixture County")));
  check("R1f the county's cited PDF on it is the county's application", urlsOf(rs, "building_application").includes(RS_PDF));

  // R1g THE CITED LINE BLOCKS ONLY AS OWED: missing while the track's application is owed; set aside
  // (skipped, with why) once a CONFIRMED form of that track satisfies the slot; never "filled".
  const jtList = () => reqDocs.requiredListCheck(db, jt, reqDocs.documentInventory(db, jt)).items;
  const citedItem = (items: ReturnType<typeof jtList>, u: string) => items.find((i) => i.text.includes(`cited: ${fileOf(u)}`));
  check("R1g owed: the cited line is missing while no confirmed form fills the track", (() => { const i = citedItem(jtList(), CITY_BOULDER); return i && !i.present && !i.skipped; })(), JSON.stringify(jtList().map((i) => [i.text.slice(0, 90), i.present, i.skipped ?? ""])));
  auto.storeAhjFormTemplate(db, { ahjName: "Boulder County", state: "CO", formType: "building_application", filename: "Solar Photovoltaic Permit Application.pdf", bytes: await acroPdf("Boulder County Solar PV Permit Application"),
    map: { formName: "Solar Photovoltaic Permit Application", sourceUrl: BOCO_OWN, fillMode: "acroform", textFields: { "Owner name": "project.homeownerName" }, checkboxes: {}, notes: "" } });
  filledDirs.push("r1b-jt");
  await forms.buildFilledFormsForProject(db, jt);
  const jtAfter = jtList();
  const bocoLine = jtAfter.find((i) => /Boulder County \(issues the structural/.test(i.text) && !/cited:/.test(i.text));
  check("R1g the county's confirmed form is filled and present", Boolean(bocoLine && /— filled$/.test(bocoLine.text) && bocoLine.present), JSON.stringify(bocoLine));
  const setAside = citedItem(jtAfter, CITY_BOULDER);
  check("R1g the cited city PDF is set aside (skipped), never present, never 'filled'", Boolean(setAside && !setAside.present && setAside.skipped && !/filled/.test(setAside.text)), JSON.stringify(setAside));
  check("R1g the electrical track's cited PDF stays owed (nothing confirmed fills it)", (() => { const i = citedItem(jtAfter, CITY_BOULDER_OLD); return i && !i.present && !i.skipped; })());
  check("R1g the gate row for the electrical track still blocks", (() => { const r = reqDocs.documentInventory(db, jt).presence.find((p) => p.docType === "electrical_application"); return r && r.blocking && !r.present; })());

  // ═══ RULE 2 — PER-FORM STATUS (the skeptic's two-forms-one-track shape) ════════════════════════
  const T1 = "https://www.douglas.co.us/documents/Solar%20Photovoltaic%20Permit%20Application.pdf";
  const T2 = "https://www.douglas.co.us/documents/Building%20Permit%20Application.pdf";
  saveLookup("CO", "Town of Castle Pines Village", [{ discipline: "structural", agency: "Douglas County", src: "https://www.douglas.co.us/building-division/", docs: [T1, T2] }]);
  const cp = job("r2-cp", "CO", "Town of Castle Pines Village");
  const cpStatus = () => buildApplicationDocumentPackage(cp, null, { agencyStatus: reqDocs.agencyListStatusResolver(db, cp) }).profile.requiredDocuments;
  check("R2 (setup) both of Douglas County's applications are confirmed", urlsOf(cp, "building_application").length === 2, JSON.stringify(urlsOf(cp, "building_application")));
  auto.storeAhjFormTemplate(db, { ahjName: "Douglas County", state: "CO", formType: "building_application", filename: "Solar Photovoltaic Permit Application.pdf", bytes: await acroPdf("Douglas County Solar PV Permit Application"),
    map: { formName: "Solar Photovoltaic Permit Application", sourceUrl: T1, fillMode: "acroform", textFields: { "Owner name": "project.homeownerName" }, checkboxes: {}, notes: "" } });
  const cpHeld = cpStatus();
  check("R2 the held form: 'on file (fill pending)'; the other: 'not yet on file'", /— on file \(fill pending\)$/.test(statusOf(cpHeld, /: Solar Photovoltaic Permit Application/)) && /— not yet on file/.test(statusOf(cpHeld, /: Building Permit Application/)), JSON.stringify(cpHeld));
  filledDirs.push("r2-cp");
  await forms.buildFilledFormsForProject(db, cp);
  const cpFilled = cpStatus();
  check("R2 after the fill: the filled one 'filled', the other still 'not yet on file' (never the slot's word)", /— filled$/.test(statusOf(cpFilled, /: Solar Photovoltaic Permit Application/)) && /— not yet on file/.test(statusOf(cpFilled, /: Building Permit Application/)), JSON.stringify(cpFilled));
  const cpJob = reqDocs.requiredListCheck(db, cp, reqDocs.documentInventory(db, cp)).items;
  check("R2 docs.complete: the filled form present, the unheld one missing", cpJob.some((i) => /: Solar Photovoltaic Permit Application — filled$/.test(i.text) && i.present) && cpJob.some((i) => /: Building Permit Application — not yet on file/.test(i.text) && !i.present && !i.skipped), JSON.stringify(cpJob.map((i) => [i.text.slice(0, 100), i.present])));
  // A form NAME is a key only among the agency's own rows: the AHJ's own same-named application (held
  // because the agency holds none of this track) is not the agency's form.
  const ELB_B = "https://www.elbertcounty-co.gov/documents/Building%20Permit%20Application.pdf";
  saveLookup("CO", "Town of Kiowa", [{ discipline: "structural", agency: "Elbert County", src: "https://www.elbertcounty-co.gov/building", docs: [ELB_B] }]);
  const kiowa = job("r2-kiowa", "CO", "Town of Kiowa");
  auto.storeAhjFormTemplate(db, { ahjName: "Town of Kiowa", state: "CO", formType: "building_application", filename: "Building Permit Application.pdf", bytes: await acroPdf("Town of Kiowa Building Permit Application"),
    map: { formName: "Building Permit Application", sourceUrl: "https://www.townofkiowa.gov/forms/Building%20Permit%20Application.pdf", fillMode: "acroform", textFields: { "Owner name": "project.homeownerName" }, checkboxes: {}, notes: "" } });
  const kiowaList = buildApplicationDocumentPackage(kiowa, null, { agencyStatus: reqDocs.agencyListStatusResolver(db, kiowa) }).profile.requiredDocuments;
  check("R2 the AHJ's own same-named form is not the agency's: Elbert County's line stays 'not yet on file'", urlsOf(kiowa, "building_application").includes(ELB_B) && /^Elbert County \(issues the structural \(building\) permit\): Building Permit Application — not yet on file/.test(statusOf(kiowaList, /^Elbert County/)), JSON.stringify(kiowaList));
  // The lookup's RAW document entry for a PDF the agency list already carries (with its own status, or
  // its confirm warning) gives way to that line — a bare URL no slot can hold was missing forever.
  check("R2 docs.complete: no bare-URL line for a form the agency list carries", !cpJob.some((i) => i.text.includes(T1) || i.text.includes(T2)), JSON.stringify(cpJob.map((i) => i.text.slice(0, 100))));
  check("R2 the packet likewise", !cpFilled.some((l) => l.includes(T1) || l.includes(T2)) && !cpStatus().some((l) => l.includes(T1) || l.includes(T2)), JSON.stringify(cpStatus()));
  check("R1g the same for a cited-to-confirm PDF (the City of Boulder's): its bare URL line gives way to the confirm line", !jtList().some((i) => i.text.includes(CITY_BOULDER)) && !packetList(jt).some((l) => l.includes(CITY_BOULDER)), JSON.stringify(packetList(jt)));

  // ═══ CONTAINMENT (agency-contain; operator decision 2026-09-27) ════════════════════════════════════
  // A new AHJ's issuing-agency application is acquired FULLY AUTOMATICALLY, and the risk of a wrong
  // agency's form where the lookup's right and wrong attributions look identical offline is ACCEPTED.
  // Not accepted: the AMPLIFIER (one wrong row spreading to every city the agency issues for — C1), a
  // failed curated seed falling through to a cited neighbour (C2), another state's host / the state's site
  // for a county / a county's site for the state (C3), a notFound answer vouching for a page (C4).
  const catalog = await import("../src/permitPlatformCatalog");
  const BCD = "Oregon Building Codes Division";
  const stubMapper = {
    mapAcroFormFields: async () => ({ textFields: { "Owner name": "project.homeownerName" }, checkboxes: {}, notes: "stub mapper" }),
    mapFlatFormOverlay: async () => ({ fields: [], signatures: [], notes: "stub mapper" }),
  } as never;
  // What a real run with model mapping on does, minus the model: ensureIssuingAgencyForm with a mapper.
  const ensureAgency = async (p: never, ft: string) => {
    downloads = [];
    const a = agencyMod.formAuthorityFor(p, ft);
    const r = await auto.ensureIssuingAgencyForm(db, stubMapper, p, ft, a, ft === "electrical_application" ? null : "prescriptive", {});
    return { status: r.status, message: String(r.message), downloads: [...downloads] };
  };
  const pj = (p: never) => p as unknown as { ahj: string; state: string };
  const loaderUrls = (p: never) => forms.loadStoredTemplates(db, pj(p).ahj, pj(p).state).map((t) => t.sourceUrl);
  const loaderIds = (p: never) => forms.loadStoredTemplates(db, pj(p).ahj, pj(p).state).map((t) => t.templateId);
  const heldBlankUrls = (p: never) => forms.heldUnfillableAgencyBlanks(db, pj(p)).map((b) => b.sourceUrl);
  const statusList = (p: never) => buildApplicationDocumentPackage(p, null, { agencyStatus: reqDocs.agencyListStatusResolver(db, p) }).profile.requiredDocuments;
  const rowIdOf = (url: string) => db.get<{ id: string }>("SELECT id FROM ahj_form_templates WHERE source_url = ?", [url])?.id ?? "";
  const anchorsOf = (p: never, agency: string) => agencyMod.agencyAnchorSites(p, agency);
  const mappedMap = (formName: string, sourceUrl: string) => ({ formName, sourceUrl, fillMode: "acroform", textFields: { "Owner name": "project.homeownerName" }, checkboxes: {}, notes: "" });
  const blankMap = (formName: string, sourceUrl: string) => ({ formName, sourceUrl, fillMode: "acroform", textFields: {}, checkboxes: {}, notes: "" });
  const POLK_PAGE = "https://www.co.polk.or.us/cd/building";
  const POLK_E = "https://www.co.polk.or.us/sites/default/files/Electrical%20Permit%20Application.pdf";
  served.set(POLK_E, await acroPdf("POLK COUNTY Electrical Permit Application"));
  const KEST_PAGE = "https://www.co.kestrel.or.us/building";

  // ── C4 notFound NEVER VOUCHES (the skeptic's S3) ──────────────────────────────────────────────────
  // The structural permit's OWN issuer answer is notFound (its source: Polk County's page); the top-level
  // answer names Kestrel County on Kestrel's own page. The track is Kestrel's (formAuthorityFor, unchanged),
  // but a notFound answer cited no page FOR Kestrel: co.polk.or.us is not Kestrel's site.
  const POLK_B = "https://www.co.polk.or.us/sites/default/files/Solar%20Permit%20Application.pdf";
  served.set(POLK_B, await acroPdf("POLK COUNTY Solar Permit Application"));
  saveLookup("OR", "City of Southfix", [{ discipline: "structural", agency: null, src: POLK_PAGE, docs: [POLK_B] }],
    cited("Kestrel County", KEST_PAGE, "Kestrel County administers the building program for Southfix"));
  const sfx = job("c4-sfx", "OR", "City of Southfix");
  check("C4 (setup) the building track is Kestrel County's through the top-level answer", agencyMod.formAuthorityFor(sfx, "building_application").name === "Kestrel County");
  check("C4 a permit whose own issuer answer is notFound anchors nothing; the top-level answer's own page still does", JSON.stringify(anchorsOf(sfx, "Kestrel County")) === JSON.stringify(["co.kestrel.or.us"]), JSON.stringify(anchorsOf(sfx, "Kestrel County")));
  await refusedEverywhere("C4 Polk's PDF on the notFound permit", sfx, "building_application", POLK_B, "Kestrel County");

  // ── C3 NAMES ONLY REMOVE, INCLUDING STATE ─────────────────────────────────────────────────────────
  // (i) The host's STATE, read from its structure only: a .us locality (co.<x>.<st>.us, <x>.<st>.us), a
  // state's own .gov (oregon.gov, lni.wa.gov, bcd.state.or.us), a .gov label ending in a hyphenated code
  // (tigard-or), a type word + code (harriscountytx) or a state's full name (bendoregon) — never a place
  // named for a state (cityofwashington, portwashington, coloradosprings).
  const hostState = (h: string) => (catalog as unknown as { hostStateOf?: (h: string) => { state: string; stateSite: boolean } | null }).hostStateOf?.(h);
  const HOSTS: Array<[string, string | null, boolean]> = [
    ["co.jefferson.or.us", "or", false], ["www.jeffersoncountyor.gov", "or", false], ["www.madras-or.gov", "or", false], ["www.bendoregon.gov", "or", false],
    ["www.oregon.gov", "or", true], ["www.bcd.state.or.us", "or", true], ["lni.wa.gov", "wa", true], ["dli.mn.gov", "mn", true],
    ["douglas.co.us", "co", false], ["www.elbertcounty-co.gov", "co", false], ["engineering.harriscountytx.gov", "tx", false], ["www.washingtoncountyor.gov", "or", false],
    ["bouldercounty.gov", null, false], ["assets.bouldercounty.gov", null, false], ["jeffco.us", null, false], ["discover.pbcgov.org", null, false], ["www.houstontx.gov", null, false],
    ["www.cityofwashington.gov", null, false], ["www.portwashington.gov", null, false], ["coloradosprings.gov", null, false], ["www.fairfaxva.gov", null, false], ["www.deschutes.org", null, false],
  ];
  for (const [h, st, site] of HOSTS) {
    const got = hostState(h);
    check(`C3 host state of ${h}: ${st ?? "none"}${site ? " (the state's own site)" : ""}`, st === null ? got === null : Boolean(got && got.state === st && got.stateSite === site), JSON.stringify(got));
  }
  // (ii) Another state's locality host never anchors (the skeptic's S2b: Colorado's Jefferson County, an
  // Oregon county's site), nor a .gov carrying another state's name.
  const JOR_PAGE = "https://www.co.jefferson.or.us/building";
  const JOR_PDF = "https://www.co.jefferson.or.us/building/Solar%20Permit%20Application.pdf";
  served.set(JOR_PDF, await acroPdf("Jefferson County OREGON Solar Permit Application"));
  saveLookup("CO", "Town of Morrison", [{ discipline: "structural", agency: "Jefferson County", src: JOR_PAGE, quote: "Jefferson County Building issues solar permits", docs: [JOR_PDF] }]);
  const mor = job("c3-mor", "CO", "Town of Morrison");
  check("C3 an Oregon locality host never anchors Colorado's Jefferson County", !anchorsOf(mor, "Jefferson County").includes("co.jefferson.or.us"), JSON.stringify(anchorsOf(mor, "Jefferson County")));
  await refusedEverywhere("C3 the Oregon county's PDF for Colorado's Jefferson County", mor, "building_application", JOR_PDF, "Jefferson County");
  const JORG_PDF = "https://www.jeffersoncountyor.gov/building/Solar%20Photovoltaic%20Permit%20Application.pdf";
  served.set(JORG_PDF, await acroPdf("Jefferson County OR Solar PV Permit Application"));
  saveLookup("CO", "Town of Golden Two", [{ discipline: "structural", agency: "Jefferson County", src: "https://www.jeffersoncountyor.gov/building", docs: [JORG_PDF] }]);
  await refusedEverywhere("C3 a .gov carrying another state's letters (jeffersoncountyor.gov) for Colorado's Jefferson County", job("c3-gd2", "CO", "Town of Golden Two"), "building_application", JORG_PDF, "Jefferson County");
  // (iii) The state's own site never anchors a COUNTY's form (the skeptic's S4a / zzV4 s4a).
  saveLookup("OR", "City of Eastfix", [
    { discipline: "structural", agency: "Kestrel County", src: KEST_PAGE },
    { discipline: "electrical", agency: "Kestrel County", src: "https://www.oregon.gov/bcd/jurisdictions/pages/kestrel-county.aspx", quote: "Kestrel County is the building official for Eastfix", docs: [BCD_E] },
  ]);
  const efx = job("c3-efx", "OR", "City of Eastfix");
  check("C3 the state's site (oregon.gov) never anchors a county", JSON.stringify(anchorsOf(efx, "Kestrel County")) === JSON.stringify(["co.kestrel.or.us"]), JSON.stringify(anchorsOf(efx, "Kestrel County")));
  await refusedEverywhere("C3 the state's electrical application for Kestrel County", efx, "electrical_application", BCD_E, "Kestrel County");
  // (iv) A county's site never anchors a STATE agency — including a county site whose name carries no type
  // (the skeptic's S1 / zzV4: deschutes.org, clackamas.us, multco.us — the county's PAGE cited for the BCD).
  const S1_SHAPES: Array<[string, string, string]> = [
    ["City of Sisters Two", "https://www.deschutes.org/cd/page/electrical-permits", "https://www.deschutes.org/sites/default/files/fileattachments/community_development/page/Electrical%20Permit%20Application.pdf"],
    ["City of Estacada Two", "https://www.clackamas.us/building/electrical", CLACK_E],
    ["City of Maywood Park Two", "https://www.multco.us/building/electrical-permits", "https://www.multco.us/file/Electrical%20Permit%20Application.pdf"],
  ];
  for (const [ahj, page, pdf] of S1_SHAPES) {
    saveLookup("OR", ahj, [
      { discipline: "structural", agency: ahj, src: `https://www.${ahj.replace(/^City of /, "").toLowerCase().replace(/ /g, "")}oregon.gov/building` },
      { discipline: "electrical", agency: BCD, src: page, quote: `Electrical permits within ${ahj} are issued by the State of Oregon Building Codes Division`, docs: [pdf] },
    ]);
    const p = job(`c3-${ahj}`, "OR", ahj);
    check(`C3 ${new URL(page).hostname} (a county's site, no type in its name) never anchors the state agency`, anchorsOf(p, BCD).length === 0, JSON.stringify(anchorsOf(p, BCD)));
    await refusedEverywhere(`C3 the county's PDF under the BCD (${new URL(pdf).hostname})`, p, "electrical_application", pdf, BCD);
  }
  // Must-pass: the state agency on its OWN site; a place named for the state is not the state.
  saveLookup("OR", "City of Culver Three", [
    { discipline: "structural", agency: "City of Culver Three", src: "https://www.culverthree.gov/building" },
    { discipline: "electrical", agency: BCD, src: "https://www.oregon.gov/bcd/pages/electrical.aspx", quote: "The BCD issues electrical permits in Culver Three", docs: [BCD_E] },
  ]);
  const cu3 = job("c3-cu3", "OR", "City of Culver Three");
  check("C3 (must-pass) the BCD's own site anchors the BCD, and its PDF there is the BCD's application", JSON.stringify(anchorsOf(cu3, BCD)) === JSON.stringify(["oregon.gov"]) && urlsOf(cu3, "electrical_application", null).includes(BCD_E), JSON.stringify({ a: anchorsOf(cu3, BCD), u: urlsOf(cu3, "electrical_application", null) }));
  saveLookup("WA", "City of Burlington Two", [{ discipline: "electrical", agency: LNI, src: "https://lni.wa.gov/licensing-permits/electrical/electrical-permits-fees-and-inspections/", docs: [LNI_OWN] }]);
  check("C3 (must-pass) L&I's own site (lni.wa.gov) anchors L&I", urlsOf(job("c3-bur", "WA", "City of Burlington Two"), "electrical_application", null).includes(LNI_OWN), JSON.stringify(urlsOf(job("c3-bur", "WA", "City of Burlington Two"), "electrical_application", null)));
  const CS_PDF = "https://coloradosprings.gov/files/Solar%20Permit%20Application.pdf";
  saveLookup("CO", "Town of Manitou Two", [{ discipline: "structural", agency: "Colorado Springs Development Services", src: "https://coloradosprings.gov/development-services", docs: [CS_PDF] }]);
  check("C3 (must-pass) 'Colorado Springs …' is a city named for the state, not the state: its own site anchors it", urlsOf(job("c3-man", "CO", "Town of Manitou Two"), "building_application").includes(CS_PDF), JSON.stringify(anchorsOf(job("c3-man", "CO", "Town of Manitou Two"), "Colorado Springs Development Services")));

  // ── C1 THE AMPLIFIER ──────────────────────────────────────────────────────────────────────────────
  // A NON-curated agency row (acquired from a cited PDF — not a curated seed, not person-verified, not a
  // person's upload) applies to a job ONLY when that job's own lookup anchors the row's site.
  // C1a THE ACCEPTED RISK STAYS AUTOMATIC: Northkest's lookup cites a Polk County PAGE on Kestrel County's
  // electrical permit and Polk's PDF beside it (the skeptic's S2 — identical offline to a right one).
  saveLookup("OR", "City of Northkest", [
    { discipline: "structural", agency: "Kestrel County", src: KEST_PAGE },
    { discipline: "electrical", agency: "Kestrel County", src: KEST_PAGE, docsSrc: POLK_PAGE, docs: [POLK_E] },
  ]);
  const nk = job("c1-nk", "OR", "City of Northkest");
  const nkEns = await ensureAgency(nk, "electrical_application");
  check("C1a (the accepted risk) Northkest's cited PDF is acquired automatically and stored under Kestrel County", nkEns.status === "acquired" && nkEns.downloads.join() === POLK_E && rowsWithSource(POLK_E).join() === "Kestrel County", JSON.stringify({ nkEns, rows: rowsWithSource(POLK_E) }));
  check("C1a and it is Northkest's own form (its lookup anchors the row's site)", loaderUrls(nk).includes(POLK_E), JSON.stringify(loaderUrls(nk)));
  // C1b ANOTHER CITY KESTREL ISSUES FOR, whose lookup anchors only Kestrel's own site, never gets that row.
  const KEST_E = "https://www.co.kestrel.or.us/forms/Electrical%20Permit%20Application.pdf";
  saveLookup("OR", "City of Southkest", [
    { discipline: "structural", agency: "Kestrel County", src: KEST_PAGE },
    { discipline: "electrical", agency: "Kestrel County", src: KEST_PAGE, docs: [KEST_E] },
  ]);
  const sk = job("c1-sk", "OR", "City of Southkest");
  check("C1b the loader never hands Southkest a Kestrel row from a site its own lookup does not anchor", !loaderUrls(sk).includes(POLK_E), JSON.stringify(loaderUrls(sk)));
  const skLine = () => statusOf(statusList(sk), /^Kestrel County \(issues the electrical permit\): Electrical Permit Application/);
  check("C1b the status resolver's NAME match: Southkest's own same-named form is 'not yet on file', not the foreign row's 'on file'", /— not yet on file/.test(skLine()), skLine());
  const skEns = await ensureAgency(sk, "electrical_application"); // its own form is not served yet
  check("C1b acquisition never answers 'already stored' with the foreign row — it tries Southkest's own cited form", skEns.status !== "exists" && skEns.downloads.join() === KEST_E, JSON.stringify(skEns));
  filledDirs.push("c1-sk");
  const skFill = await forms.buildFilledFormsForProject(db, sk);
  const polkRow = rowIdOf(POLK_E);
  check("C1b the fill never fills the foreign row for Southkest", Boolean(polkRow) && !skFill.forms.some((f) => (f as { templateId?: string }).templateId === polkRow), JSON.stringify(skFill.forms.map((f) => [f.formName, f.status, (f as { templateId?: string }).templateId])));
  served.set(KEST_E, await acroPdf("KESTREL COUNTY Electrical Permit Application"));
  const skEns2 = await ensureAgency(sk, "electrical_application");
  check("C1b with its own form served, Southkest acquires and holds it", skEns2.status === "acquired" && loaderUrls(sk).includes(KEST_E) && !loaderUrls(sk).includes(POLK_E), JSON.stringify({ skEns2, loader: loaderUrls(sk) }));
  // C1c THE SKEPTIC'S zzV3 S1m: a Deschutes County blank under the BCD never reaches Culver Two, a BCD city
  // whose lookup cites only oregon.gov — neither as a held blank nor as a fillable form.
  const DES_E2 = "https://www.deschutes.org/sites/default/files/Electrical%20Permit%20Application.pdf";
  auto.storeAhjFormTemplate(db, { ahjName: BCD, state: "OR", formType: "electrical_application", filename: "Electrical Permit Application.pdf", bytes: await acroPdf("DESCHUTES COUNTY Electrical Permit Application"), map: blankMap("Electrical Permit Application", DES_E2) } as never);
  saveLookup("OR", "City of Culver Two", [
    { discipline: "structural", agency: "City of Culver Two", src: "https://www.culvertwo.gov/building" },
    { discipline: "electrical", agency: BCD, src: "https://www.oregon.gov/bcd/pages/electrical.aspx", quote: "The BCD issues electrical permits in Culver Two" },
  ]);
  const cu2 = job("c1-cu2", "OR", "City of Culver Two");
  const cu2Line = () => statusOf(statusList(cu2), /^Oregon Building Codes Division \(issues the electrical permit\)/);
  check("C1c (unfillable) the Deschutes blank is not Culver Two's held blank", !heldBlankUrls(cu2).includes(DES_E2), JSON.stringify(heldBlankUrls(cu2)));
  downloads = [];
  const cu2Ens = await auto.ensureAhjFormTemplate(db, noModel, cu2, "electrical_application", { allowResearch: false });
  check("C1c acquisition never calls it Culver Two's 'stored but not fillable' form", cu2Ens.status === "not_found" && !/is stored/.test(cu2Ens.message), JSON.stringify(cu2Ens));
  check("C1c the BCD line reads 'not yet on file', never 'held, not fillable'", /— not yet on file/.test(cu2Line()), cu2Line());
  check("C1c the gate row does not name it as the blank to complete by hand", !reqDocs.documentInventory(db, cu2).presence.some((r) => r.docType === "electrical_application" && /completed by hand/.test(r.label)), JSON.stringify(reqDocs.documentInventory(db, cu2).presence.filter((r) => r.docType === "electrical_application")));
  auto.storeAhjFormTemplate(db, { ahjName: BCD, state: "OR", formType: "electrical_application", filename: "Electrical Permit Application.pdf", bytes: await acroPdf("DESCHUTES COUNTY Electrical Permit Application"), map: mappedMap("Electrical Permit Application", DES_E2) } as never);
  check("C1c (fillable) the loader never hands it to Culver Two", !loaderUrls(cu2).includes(DES_E2), JSON.stringify(loaderUrls(cu2)));
  filledDirs.push("c1-cu2");
  const cu2Fill = await forms.buildFilledFormsForProject(db, cu2);
  check("C1c Culver Two's fill never fills it and its line never says 'filled' / 'on file'", !cu2Fill.forms.some((f) => f.status === "filled" && /Electrical/.test(f.formName)) && /— not yet on file/.test(cu2Line()), JSON.stringify({ fill: cu2Fill.forms.map((f) => [f.formName, f.status]), line: cu2Line() }));
  // C1d (must-pass) CURATED rows apply to every city the agency issues for — Michael's B-01S / E-01, for a
  // Marion city whose lookup anchors none of Marion's sites.
  saveLookup("OR", "City of Stayton Two", [
    { discipline: "structural", agency: "Marion County", src: "https://www.staytontwooregon.gov/building", quote: "Structural permits are submitted to Marion County" },
    { discipline: "electrical", agency: "Marion County", src: "https://www.staytontwooregon.gov/building", quote: "Electrical permits are submitted to Marion County" },
  ]);
  const st2 = job("c1-st2", "OR", "City of Stayton Two");
  check("C1d (must-pass) Marion County's curated B-01S and E-01 apply to a Marion city whose lookup anchors none of Marion's sites", anchorsOf(st2, "Marion County").length === 0 && loaderUrls(st2).includes(B01S_URL) && loaderUrls(st2).includes(E01_URL), JSON.stringify({ a: anchorsOf(st2, "Marion County"), l: loaderUrls(st2) }));
  const st2Ens = await ensureAgency(st2, "building_application");
  check("C1d (must-pass) and acquisition finds the B-01S already held (no download)", st2Ens.status === "exists" && st2Ens.downloads.length === 0, JSON.stringify(st2Ens));
  // C1e (must-pass) A PERSON's rows apply everywhere: a blank the operator VERIFIED, and one the operator
  // UPLOADED (the upload route stores no source URL; every automatic acquisition stores the URL it fetched).
  const OSP_OTHER = "https://www.osprey-archive.org/forms/Solar%20Permit%20Application.pdf";
  const ospRow = auto.storeAhjFormTemplate(db, { ahjName: "Osprey County", state: "OR", formType: "electrical_application", filename: "Electrical Permit Application.pdf", bytes: await acroPdf("Osprey County Electrical Permit Application"), map: mappedMap("Electrical Permit Application", OSP_OTHER) } as never);
  saveLookup("OR", "City of Ospreyville", [{ discipline: "electrical", agency: "Osprey County", src: "https://www.co.osprey.or.us/building" }]);
  const osp = job("c1-osp", "OR", "City of Ospreyville");
  check("C1e (setup) an unverified cited row on a site the job does not anchor does not apply", !loaderIds(osp).includes(ospRow), JSON.stringify(loaderIds(osp)));
  // The operator's PATCH /api/ahj-templates/:id/verify write (server.ts), as the route does it.
  const vmap = JSON.parse(db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE id = ?", [ospRow])!.field_map);
  vmap.verified = true; vmap.verifiedAt = new Date().toISOString();
  db.run("UPDATE ahj_form_templates SET field_map = ?, updated_at = ? WHERE id = ?", [JSON.stringify(vmap), new Date().toISOString(), ospRow]);
  check("C1e (must-pass) once a person VERIFIES it, it applies to every city Osprey issues for", loaderIds(osp).includes(ospRow), JSON.stringify(loaderIds(osp)));
  // The upload route's own call (server.ts POST /api/ahj-templates/upload): sourceUrl "".
  const upl = await auto.acquireFromBytes(db, stubMapper, { ahj: "Osprey County", state: "OR", formType: "building_application", formName: "Osprey County Solar Permit Application", bytes: await acroPdf("Osprey County Solar Permit Application"), sourceUrl: "" });
  const uplRow = db.get<{ id: string }>("SELECT id FROM ahj_form_templates WHERE ahj_name = 'Osprey County' AND form_type = 'building_application'")?.id ?? "";
  saveLookup("OR", "City of Ospreyton", [{ discipline: "structural", agency: "Osprey County", src: "https://www.ospreytonoregon.gov/building", quote: "Building permits are issued by Osprey County" }]);
  check("C1e (must-pass) a blank a person UPLOADED under the agency applies where no site is anchored", upl.status === "acquired" && Boolean(uplRow) && anchorsOf(job("c1-ot", "OR", "City of Ospreyton"), "Osprey County").length === 0 && loaderIds(job("c1-ot", "OR", "City of Ospreyton")).includes(uplRow), JSON.stringify({ upl, uplRow, l: loaderIds(job("c1-ot", "OR", "City of Ospreyton")) }));
  // C1f THE SKEPTIC'S zzV3 S7m: Polk County's application in Marion County's electrical slot (however it got
  // there — C2 closes the door it came through) is not a Jefferson-shaped job's: the curated E-01 is fetched.
  db.run("DELETE FROM ahj_form_templates WHERE ahj_name = 'Marion County' AND form_type = 'electrical_application'");
  auto.storeAhjFormTemplate(db, { ahjName: "Marion County", state: "OR", formType: "electrical_application", filename: "Electrical Permit Application.pdf", bytes: await acroPdf("POLK COUNTY Electrical Permit Application"), map: mappedMap("Electrical Permit Application", POLK_E) } as never);
  saveLookup("OR", "City of Jefferson Two", [
    { discipline: "structural", agency: "Marion County", src: B01S_URL, quote: "Prescriptive Solar Photovoltaic Installation Permit Application · Marion County Public Works", pageSrc: "https://www.co.marion.or.us/PW/BuildingInspection", docsSrc: "https://jeffersontwooregon.org/planning-committee/" },
    { discipline: "electrical", agency: "Marion County", src: "https://jeffersontwooregon.org/planning-committee/", quote: "All Electrical and Plumbing permits are submitted to Marion County Building", pageSrc: "https://www.co.marion.or.us/PW/BuildingInspection", docsSrc: "https://jeffersontwooregon.org/planning-committee/" },
  ]);
  const jf2 = job("c1-jf2", "OR", "City of Jefferson Two");
  check("C1f Polk's row in Marion County's slot is not Jefferson Two's (its lookup anchors co.marion.or.us)", !loaderUrls(jf2).includes(POLK_E), JSON.stringify(loaderUrls(jf2)));
  const jfE = await ensureAgency(jf2, "electrical_application");
  check("C1f acquisition fetches the curated E-01 instead of 'already holding' Polk's", jfE.status === "acquired" && jfE.downloads.join() === E01_URL, JSON.stringify(jfE));
  check("C1f and Jefferson Two's electrical application is the E-01", loaderUrls(jf2).includes(E01_URL) && !loaderUrls(jf2).includes(POLK_E), JSON.stringify(loaderUrls(jf2)));
  // C1g (must-pass) Boulder County's own bouldercounty.gov row applies to a town whose lookup cites a
  // bouldercounty.gov page — and not to one whose lookup anchors no Boulder County site.
  saveLookup("CO", "Town of Lyons Two", [{ discipline: "structural", agency: "Boulder County", src: BOCO_PAGE }]);
  check("C1g (must-pass) Boulder County's bouldercounty.gov row applies where the lookup cites a bouldercounty.gov page", loaderUrls(job("c1-ly2", "CO", "Town of Lyons Two")).includes(BOCO_OWN), JSON.stringify(loaderUrls(job("c1-ly2", "CO", "Town of Lyons Two"))));
  saveLookup("CO", "Town of Erie Two", [{ discipline: "structural", agency: "Boulder County", src: "https://www.erietwo.gov/building", quote: "Building permits in Erie Two are issued by Boulder County" }]);
  check("C1g and not where the lookup anchors no Boulder County site (a cited row, not curated or verified)", !loaderUrls(job("c1-er2", "CO", "Town of Erie Two")).includes(BOCO_OWN), JSON.stringify(loaderUrls(job("c1-er2", "CO", "Town of Erie Two"))));

  // ── C2 NO FALLTHROUGH (the skeptic's S7 / S7m: Aumsville, the E-01 404, Polk's PDF next) ─────────────
  db.run("DELETE FROM ahj_form_templates WHERE ahj_name = 'Marion County' AND form_type = 'electrical_application'");
  const e01Bytes = served.get(E01_URL)!;
  served.delete(E01_URL);
  saveLookup("OR", "City of Aumsville Two", [
    { discipline: "structural", agency: "Marion County", src: "https://www.co.marion.or.us/PW/BuildingInspection" },
    { discipline: "electrical", agency: "Marion County", src: "https://www.co.marion.or.us/PW/BuildingInspection", docsSrc: POLK_PAGE, docs: [POLK_E] },
  ]);
  const au2 = job("c2-au2", "OR", "City of Aumsville Two");
  check("C2 (setup) the seed and a cited neighbour are both candidates", JSON.stringify(agencyMod.agencyApplicationForms(au2, "electrical_application", null).map((f) => f.origin)) === JSON.stringify(["curated", "cited"]), JSON.stringify(agencyMod.agencyApplicationForms(au2, "electrical_application", null)));
  const auE = await ensureAgency(au2, "electrical_application");
  const marionElectrical = () => db.query<{ source_url: string }>("SELECT source_url FROM ahj_form_templates WHERE ahj_name = 'Marion County' AND form_type = 'electrical_application'").map((r) => r.source_url);
  check("C2 the seed's failed fetch is a NAMED failure — the agency, the form, the URL, retry", auE.status === "not_found" && auE.message.includes(`Marion County's Marion County Renewable Electrical Energy Permit Application (E-01) could not be downloaded from ${E01_URL}`) && /retry/i.test(auE.message), auE.message);
  check("C2 no cited candidate is tried in its place: Polk's PDF never fetched, nothing stored in Marion County's electrical slot", auE.downloads.join() === E01_URL && marionElectrical().length === 0, JSON.stringify({ auE, stored: marionElectrical() }));
  served.set(E01_URL, e01Bytes);
  const auE2 = await ensureAgency(au2, "electrical_application");
  check("C2 once the seed answers, the seed is acquired", auE2.status === "acquired" && auE2.downloads.join() === E01_URL && JSON.stringify(marionElectrical()) === JSON.stringify([E01_URL]), JSON.stringify({ auE2, stored: marionElectrical() }));

  assert.equal(failed.length, 0, `${failed.length} check(s) failed: ${failed.join(" | ")}`);
  console.log(`agencyFormsUniversal: ${passed} checks passed — a cited PDF is the agency's only on a site the lookup cited a page of the agency's on (no name creates an anchor), split agencies keep the city's own lines, every line's status is its own form's, three held-out AHJs (FL / IA / TX) route to the right agency, and containment holds (C1 a cited row applies only where the job's own lookup anchors its site; C2 a failed curated seed never falls through; C3 no other-state / state-for-county / county-for-state anchor; C4 notFound never vouches)`);
} finally {
  globalThis.fetch = realFetch;
  db.close();
  for (const id of filledDirs) fs.rmSync(path.resolve("backend/data/filled", id), { recursive: true, force: true });
  assert.equal(path.dirname(temp), os.tmpdir());
  fs.rmSync(temp, { recursive: true, force: true });
}
