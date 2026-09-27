// THE ISSUING AGENCY'S FORMS, FOR ANY AHJ (agency-apps-close, 2026-09-27 — operator: "THIS NEEDS TO
// BE UNIVERSAL"). The skeptic's three findings on the issuing-agency round, pinned with synthetic
// lookups (no network, no model) and the public Marion / BCD blanks:
//
//   MF1 WHOSE FORM A CITED PDF IS — a PDF is the agency's only on the AGENCY'S OWN domain (the
//       lookup's own ownership predicate, isAgencyOwnUrl: isAgencyOwnDomain + tenantContradictsAgency);
//       another entity's .gov / .<st>.us host never qualifies, the AHJ's own domain never does, and a
//       document host (a CDN) only when it IS the lookup's citation for that permit's agency. The
//       top-level agency answer's source counts only for a track that same agency issues.
//   MF2 SPLIT AGENCIES — the agency list replaces the city's lines only for the TRACK the agency
//       issues; the city's own lines stay; the county's zoning prerequisite only when the county
//       issues the building permit.
//   MF3 A LINE'S STATUS IS THE INVENTORY'S — "filled" only when a fill exists; "on file (fill
//       pending)", "held, not fillable", "not yet on file" otherwise; no claim at all without it.
//   HELD-OUT — three AHJs in three other states (FL town / county, IA city issuing its own, TX
//       unincorporated / county): routed to the right agency's domain and packet, foreign PDFs refused.
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
type PermitSpec = { discipline: "structural" | "electrical" | "combo"; agency: string | null; src: string; quote?: string; docsSrc?: string; feeSrc?: string };
function saveLookup(state: string, ahj: string, permits: PermitSpec[], top: unknown = notFound("not stated at the top level")): void {
  const r = savePermitProcessLookup(db, {
    state, ahj, lookedUpAt: new Date().toISOString(), issuingAgency: top,
    permitStructure: cited("separate", permits[0]?.src || "https://example.gov/p", "separate building and electrical permits"),
    permits: permits.map((p) => ({
      discipline: p.discipline, label: `${p.discipline} permit`,
      issuingAgency: p.agency ? cited(p.agency, p.src, p.quote ?? `${p.agency} issues ${p.discipline} permits for ${ahj}`) : notFound("no agency named", p.src),
      portalUrl: notFound("none"), recordType: notFound("none"),
      documents: notFound("no list", p.docsSrc ?? ""), fee: notFound("none", p.feeSrc ?? ""),
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

  // MF1f: a document host (a CDN) qualifies ONLY as the lookup's own citation for that permit's agency.
  const CDN_PDF = "https://cdnsm5-hosted.civiclive.com/UserFiles/Servers/Server_14/File/Building/Solar%20Photovoltaic%20Permit%20Application.pdf";
  saveLookup("OR", "City of Lakeside", [{ discipline: "structural", agency: "Coos County", src: CDN_PDF, quote: "Coos County Building Codes — Solar Photovoltaic Permit Application" }]);
  check("MF1f a CDN PDF the lookup cites AS the agency's own words for that permit is the agency's", urlsOf(job("lk-1", "OR", "City of Lakeside"), "building_application").includes(CDN_PDF));
  saveLookup("OR", "City of Bandon", [{ discipline: "structural", agency: "Coos County", src: "https://www.co.coos.or.us/building", docsSrc: CDN_PDF, feeSrc: "https://library.municode.com/or/coos_county/Building%20Permit%20Application.pdf" }]);
  const bandonUrls = urlsOf(job("bd-1", "OR", "City of Bandon"), "building_application");
  check("MF1f the same CDN PDF on another answer (not the agency's citation) is not", !bandonUrls.includes(CDN_PDF), JSON.stringify(bandonUrls));
  check("MF1f a code publisher's PDF is never an agency's application", !bandonUrls.some((u) => /municode/.test(u)));

  // Positive: the agency's own .or.us host still qualifies (the round's Fixture County shape).
  const OWN_PDF = "https://www.co.fixture.or.us/forms/Solar%20Photovoltaic%20Permit%20Application.pdf";
  saveLookup("OR", "City of Owntown", [{ discipline: "structural", agency: "Fixture County", src: OWN_PDF }]);
  check("MF1g the agency's own host still qualifies", urlsOf(job("own-1", "OR", "City of Owntown"), "building_application").includes(OWN_PDF));
  // Michael's shape keeps both curated county applications.
  saveLookup("OR", "City of Jefferson", [
    { discipline: "structural", agency: "Marion County", src: B01S_URL, quote: "Prescriptive Solar Photovoltaic Installation Permit Application · Marion County Public Works" },
    { discipline: "electrical", agency: "Marion County", src: "https://jeffersonoregon.org/planning-committee/", quote: "All Electrical and Plumbing permits are submitted to Marion County Building and those forms can be found here." },
  ]);
  const jefferson = job("jeff-u", "OR", "City of Jefferson");
  check("MF1g Michael's shape: the B-01S and E-01 are Marion County's", urlsOf(jefferson, "building_application").includes(B01S_URL) && urlsOf(jefferson, "electrical_application", null).includes(E01_URL));

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
  check("MF2 and ADDS Coos County's electrical application", coosPacket.some((l) => /^Coos County \(issues the electrical permit\): Electrical Permit Application/.test(l)), JSON.stringify(coosPacket));
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
  saveLookup("OR", "City of Flatville", [{ discipline: "structural", agency: "Flat County", src: FLAT_URL }]);
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
  saveLookup("FL", "Town of Glen Ridge", [
    { discipline: "structural", agency: "Palm Beach County", src: PBC_B, quote: "Palm Beach County Building Division — Solar Photovoltaic Permit Application", docsSrc: PBG_PDF, feeSrc: MUNI_PDF },
    { discipline: "electrical", agency: "Palm Beach County", src: PBC_E, quote: "Palm Beach County Building Division — Electrical Permit Application" },
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
  saveLookup("TX", "Cypress", [{ discipline: "structural", agency: "Harris County", src: HC_B, quote: "Harris County Engineering Department — Residential Solar Permit Application (unincorporated Harris County)", docsSrc: HOU_PDF }]);
  const cypress = job("cy-1", "TX", "Cypress");
  const cyUrls = urlsOf(cypress, "building_application", null);
  check("HELD-OUT TX: the county's own PDF (harriscountytx.gov) is Harris County's application; the City of Houston's is refused", cyUrls.includes(HC_B) && !cyUrls.includes(HOU_PDF), JSON.stringify(cyUrls));
  downloads = [];
  await auto.ensureAhjFormTemplate(db, noModel, cypress, "building_application", { allowResearch: false });
  check("HELD-OUT TX: stored under Harris County, the Houston PDF never fetched", rowsWithSource(HC_B).join() === "Harris County" && !downloads.includes(HOU_PDF), JSON.stringify({ downloads, rows: rowsWithSource(HC_B) }));
  const cyPacket = packetList(cypress);
  check("HELD-OUT TX: the packet names Harris County's application; no city zoning step for an unincorporated AHJ", cyPacket.some((l) => /^Harris County \(issues the structural \(building\) permit\): Residential Solar Permit Application/.test(l)) && !cyPacket.some((l) => /zoning approval/.test(l)), JSON.stringify(cyPacket));

  assert.equal(failed.length, 0, `${failed.length} check(s) failed: ${failed.join(" | ")}`);
  console.log(`agencyFormsUniversal: ${passed} checks passed — a cited PDF is the agency's only on its own domain, split agencies keep the city's own lines, every line's status is the inventory's, and three held-out AHJs (FL / IA / TX) route to the right agency`);
} finally {
  globalThis.fetch = realFetch;
  db.close();
  for (const id of filledDirs) fs.rmSync(path.resolve("backend/data/filled", id), { recursive: true, force: true });
  assert.equal(path.dirname(temp), os.tmpdir());
  fs.rmSync(temp, { recursive: true, force: true });
}
