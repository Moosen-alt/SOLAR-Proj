// A STATE ISSUER'S APPLICATIONS (issue #53, after #45 routed NM trade permits to the state CID).
// Valencia County / the Village of Los Lunas only review zoning and the site plan; the state
// Construction Industries Division issues the building AND electrical permits, each on its OWN
// application (a Multi-Purpose State Building Application and an Electrical Permit Application —
// Helm's decision on PR #64, from worker-local's evidence on #60). Pins, synthetic project, no
// network, no model:
//   - the required set = the LOCAL review application (the AHJ's own, the prerequisite step) + CID's
//     building application + CID's electrical application: three rows, each CID row satisfied only
//     by a CID form of that type (no altDocTypes between them);
//   - the form finder looks for CID's forms on the ISSUER's forms page (rld.nm.gov), and a not_found
//     names CID, the page and that the form is a Word document filled by hand until #60; no
//     fabricated URL (the state rule's forms are seeded, url "");
//   - a manufactured home (MHD) has no CID rows; Albuquerque (a full-service city) is unchanged.
//   npx tsx backend/test/nmStateIssuerForms.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nm-state-issuer-forms-"));
process.env.AUTOPILOT_DB_PATH = path.join(temp, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.PROJECT_DOCS_DIR = path.join(temp, "docs");
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { requiredApplicationDocs, applicationDocContext } = await import("../src/requiredDocuments");
const { formAuthorityFor, issuingAgencyDocumentList } = await import("../src/applicationDocsAgency");
const { stateIssuerFormsFor, stateRulesFor } = await import("../src/permitProcess");
const auto = await import("../src/ahjFormAuto");
import type { ProjectRecord } from "../../shared/src/types";

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const assert = (cond: unknown, msg: string): void => { if (!cond) throw new Error(msg); };

const project = (ahj: string, city: string, snapshot: Record<string, unknown> = {}): ProjectRecord =>
  ({
    id: `p-${city.toLowerCase().replace(/\W+/g, "-")}`, homeownerName: "Example Owner", projectAddress: "100 Example Rd", city, state: "NM", zip: "87000", ahj,
    utility: "Example Utility", parserSnapshot: { projectDescriptionText: "Install roof-mounted PV system, 12 modules.", ...snapshot },
  }) as unknown as ProjectRecord;
const CID = /Construction Industries Division/;
const valencia = project("Valencia County", "Los Lunas");
const rows = (p: ProjectRecord) => requiredApplicationDocs(p, applicationDocContext(p));

await check("Valencia County: THREE rows — the local review + CID building + CID electrical", () => {
  const all = rows(valencia).filter((r) => r.docType === "permit_application" || CID.test(r.label));
  assert(all.length === 3, JSON.stringify(all.map((r) => r.label)));
  const cid = all.filter((r) => CID.test(r.label));
  const building = cid.find((r) => r.docType === "building_application");
  const electrical = cid.find((r) => r.docType === "electrical_application");
  assert(cid.length === 2 && building && electrical, `CID rows: ${JSON.stringify(cid.map((r) => [r.docType, r.label]))}`);
  assert(/Multi-Purpose State Building Application/.test(building!.label), building!.label);
  assert(/Electrical Permit Application/.test(electrical!.label), electrical!.label);
  for (const r of cid) {
    assert(!r.altDocTypes?.length, `${r.docType} carries altDocTypes ${JSON.stringify(r.altDocTypes)} — no row may be satisfied by another type`);
    assert(r.blocking, `${r.docType}: CID's application is owed (blocking)`);
  }
  assert(rows(valencia).filter((r) => r.docType === "building_application").length === 1, "a second building row");
  assert(rows(valencia).filter((r) => r.docType === "electrical_application").length === 1, "a second electrical row");
});
await check("Valencia County: the county's own review application stays required, under the prerequisite step", () => {
  const local = rows(valencia).filter((r) => r.docType === "permit_application");
  assert(local.length === 1, JSON.stringify(rows(valencia).map((r) => r.label)));
  assert(/Valencia County/.test(local[0].label) && !CID.test(local[0].label), local[0].label);
  assert(/zoning|site/i.test(local[0].label) && /before|first/i.test(local[0].why), `${local[0].label} / ${local[0].why}`);
  assert(local[0].blocking, "the local review application is blocking as before #45");
});
await check("whose forms: the generic slot is the AHJ's (local review), the building/electrical slots CID's", () => {
  assert(formAuthorityFor(valencia, "permit_application").name === "Valencia County", formAuthorityFor(valencia, "permit_application").name);
  assert(CID.test(formAuthorityFor(valencia, "building_application").name), "building slot");
  assert(CID.test(formAuthorityFor(valencia, "electrical_application").name), "electrical slot");
});
await check("the job's own list names CID's two applications (one per track) and the county's review application once", () => {
  const items = issuingAgencyDocumentList(valencia)?.items ?? [];
  const cid = items.filter((i) => i.role === "application" && CID.test(String(i.agency)));
  assert(cid.length === 2, JSON.stringify(items.map((i) => i.text)));
  assert(cid.some((i) => JSON.stringify(i.docTypes) === JSON.stringify(["building_application"]) && /Multi-Purpose State Building Application/.test(i.text)), JSON.stringify(cid));
  assert(cid.some((i) => JSON.stringify(i.docTypes) === JSON.stringify(["electrical_application"]) && /Electrical Permit Application/.test(i.text)), JSON.stringify(cid));
  assert(items.filter((i) => i.docTypes.includes("permit_application") && /Valencia County/.test(i.text)).length === 1, JSON.stringify(items.map((i) => i.text)));
});
await check("the state rule's two forms are seeded on CID's forms page with NO fabricated URL (rules 3, 5)", () => {
  const issuer = stateIssuerFormsFor(valencia);
  assert(issuer, "no state issuer forms");
  assert(JSON.stringify(issuer!.tracks) === JSON.stringify(["building", "electrical"]), JSON.stringify(issuer!.tracks));
  for (const f of issuer!.forms) {
    assert(f.url === "", `a form URL was set: ${f.url}`);
    assert(f.searchUrl === "https://www.rld.nm.gov/construction-industries/forms-and-applications/" && f.sourceUrl === f.searchUrl, f.searchUrl);
    assert(f.origin === "state_rule", `${f.track}: origin ${f.origin} (seeded, never verified)`);
    assert(/Word document; download and fill by hand until #60 lands/.test(f.notFound), f.notFound);
  }
  assert((stateRulesFor("NM").stateTradeIssuer?.issuerForms ?? []).every((f) => f.url === ""), "seed carries a URL");
});

const db = await openDatabase();
const noModel = new Proxy({}, { get() { throw new Error("a state issuer's form must not call a model"); } }) as never;
for (const [formType, formName] of [["building_application", "Multi-Purpose State Building Application"], ["electrical_application", "Electrical Permit Application"]] as const) {
  await check(`find-ahj-form for CID's ${formType} looks on CID's forms page; not_found names CID, the page and the Word note`, async () => {
    const res = await auto.ensureAhjFormTemplate(db, noModel, valencia, formType, { allowResearch: false });
    assert(res.status === "not_found", JSON.stringify(res));
    assert(CID.test(res.message) && res.message.includes(formName), res.message);
    assert(res.message.includes("rld.nm.gov/construction-industries/forms-and-applications/"), res.message);
    assert(/CID application is a Word document; download and fill by hand until #60 lands/.test(res.message), res.message);
    assert(!res.sourceUrl, `a URL was attempted: ${res.sourceUrl}`);
    const urls = res.message.match(/https?:\/\/[^\s),;]+/g) ?? [];
    assert(urls.every((u) => /^https:\/\/www\.rld\.nm\.gov\//.test(u)), `a non-state URL in the message: ${urls.join(", ")}`);
  });
}
await check("the pass asks for the local application + CID's building AND electrical applications", async () => {
  const pass = await auto.ensureAhjFormsForProject(db, noModel, valencia, { allowResearch: false });
  for (const t of ["permit_application", "building_application", "electrical_application"]) assert(pass.neededTypes.includes(t), JSON.stringify(pass.neededTypes));
});
await check("a manufactured home (MHD): no CID forms and no CID rows", () => {
  const mhd = project("Valencia County", "Los Lunas", { structureTypeOverride: "manufactured" });
  assert(stateIssuerFormsFor(mhd) === null, "MHD got CID's forms");
  assert(!rows(mhd).some((r) => CID.test(r.label)), JSON.stringify(rows(mhd).map((r) => r.label)));
});
await check("Albuquerque (full-service city): unchanged — no state form, no CID row, the generic slot is the city's", () => {
  const abq = project("Albuquerque", "Albuquerque");
  assert(stateIssuerFormsFor(abq) === null, "state forms for Albuquerque");
  assert(!rows(abq).some((r) => CID.test(r.label)), JSON.stringify(rows(abq)));
  assert(formAuthorityFor(abq, "permit_application").name === "Albuquerque", "authority");
  assert(issuingAgencyDocumentList(abq) === null, "agency list for Albuquerque");
});


// ── THE REALISTIC STORED STATE (Helm's review of PR #64) ────────────────────────────────────────────
// The pre-#45 pass asked Valencia County for `building_application`, and classifyFormType keeps the
// caller's fallback for "…Multi-Purpose Permit Application.pdf" — so the county's OWN blank (and its
// fill) is stored as building_application. Whose slot a template fills is its AUTHORITY, never its
// form_type: the county's row is the local review application; only a CID-authored row fills CID's.
const { PDFDocument, StandardFonts } = await import("pdf-lib");
const repo = await import("../src/repository");
const forms = await import("../src/ahjForms");
const reqDocs = await import("../src/requiredDocuments");
async function acroPdf(title: string): Promise<Buffer> {
  const d = await PDFDocument.create();
  const pg = d.addPage([612, 792]);
  pg.drawText(title, { x: 40, y: 740, size: 12, font: await d.embedFont(StandardFonts.Helvetica) });
  d.getForm().createTextField("Owner name").addToPage(pg, { x: 40, y: 600, width: 200, height: 18 });
  return Buffer.from(await d.save());
}
const mapFor = (formName: string) => ({ formName, sourceUrl: "", fillMode: "acroform", textFields: { "Owner name": "project.homeownerName" }, checkboxes: {}, notes: "" });
// Read off #45's issuer answer (on main too), so a pre-fix run fails these checks on BEHAVIOUR.
const { stateTradeIssuerFor } = await import("../src/permitProcess");
const CID_NAME = String(stateTradeIssuerFor(valencia)?.value ?? "");
const job = repo.createProject(db, {
  owner: "Example Owner", street: "100 Example Rd", city: "Los Lunas", state: "NM", zip: "87031", ahj: "Valencia County", utility: "Example Utility",
  dcKw: "8.2", acKw: "7.6", homeownerPhone: "5050000000", mounting: "Roof Mount", structureDescription: "Single-family dwelling",
} as never).project as ProjectRecord;
const filledDir = path.resolve(process.cwd(), "backend/data/filled", job.id);
const writeFill = async (templateId: string) => {
  fs.mkdirSync(filledDir, { recursive: true });
  fs.writeFileSync(path.join(filledDir, `tmpl-${templateId}.pdf`), await acroPdf("filled"));
};
const presence = () => {
  const inv = reqDocs.documentInventory(db, job);
  const local = inv.presence.find((d) => d.docType === "permit_application");
  const cidBuilding = inv.presence.find((d) => CID.test(d.label) && d.docType === "building_application");
  const cidElectrical = inv.presence.find((d) => CID.test(d.label) && d.docType === "electrical_application");
  return { local, cidBuilding, cidElectrical, all: inv.presence.filter((d) => reqDocs.APPLICATION_DOC_TYPES.has(d.docType)).map((d) => `${d.docType}:${d.present}:${d.via}`) };
};
try {
  const countyId = auto.storeAhjFormTemplate(db, { ahjName: "Valencia County", state: "NM", formType: "building_application", filename: "Valencia County Multi-Purpose Permit Application.pdf",
    bytes: await acroPdf("Valencia County Multi-Purpose Permit Application"), map: mapFor("Valencia County Multi-Purpose Permit Application") } as never);
  await check("setup: the county's own blank is stored typed building_application (the pre-#45 pass)", () => {
    const t = db.get<{ form_type: string }>("SELECT form_type FROM ahj_form_templates WHERE id = ?", [countyId]);
    assert(t?.form_type === "building_application", JSON.stringify(t));
  });
  await check("before the fill: the staging forecast fills the LOCAL row off the county's blank, never CID's", () => {
    const inv = reqDocs.documentInventory(db, job);
    const rowsOf = inv.presence.filter((d) => d.docType === "permit_application" || CID.test(d.label)).map((d) => ({ ...d, present: false }));
    const forecast = reqDocs.missingFilledAtStaging(db, { ...job, parserSnapshot: { ...(job.parserSnapshot ?? {}), permitPathOverride: "engineered" } } as ProjectRecord, rowsOf);
    const local = [...forecast].some((d) => d.docType === "permit_application");
    const cid = [...forecast].some((d) => CID.test(d.label));
    assert(local && !cid, JSON.stringify({ local, cid, rows: rowsOf.map((d) => d.docType) }));
  });
  await writeFill(countyId);
  await check("the county's building_application-typed fill satisfies the LOCAL row only — neither CID row", () => {
    const { local, cidBuilding, cidElectrical, all } = presence();
    assert(local?.present === true, `local: ${JSON.stringify(all)}`);
    assert(cidBuilding && cidBuilding.present === false, `CID building counted present off the county's fill: ${JSON.stringify(all)}`);
    assert(cidElectrical && cidElectrical.present === false, `CID electrical counted present off the county's fill: ${JSON.stringify(all)}`);
  });
  await check("the job's list: the county line filled, both CID lines not on file", () => {
    const status = reqDocs.agencyListStatusResolver(db, job);
    const items = issuingAgencyDocumentList(job, status)?.items ?? [];
    const cidLines = items.filter((i) => i.role === "application" && CID.test(String(i.agency)));
    const localLine = items.find((i) => i.docTypes.includes("permit_application") && /Valencia County/.test(i.text));
    assert(localLine?.status === "filled", `local line: ${JSON.stringify(localLine)}`);
    assert(cidLines.length === 2 && cidLines.every((l) => l.status !== "filled" && l.status !== "on_file"), `CID lines: ${JSON.stringify(cidLines)}`);
  });
  await check("acquisition: the local slot counts the county's own blank as held (no re-acquire)", async () => {
    const res = await auto.ensureAhjFormTemplate(db, noModel, job, "permit_application", { allowResearch: false });
    assert(res.status === "exists", JSON.stringify(res));
  });
  await check("acquisition: CID's slots are NOT satisfied by the county's building_application blank", async () => {
    for (const formType of ["building_application", "electrical_application"]) {
      const res = await auto.ensureAhjFormTemplate(db, noModel, job, formType, { allowResearch: false });
      assert(res.status === "not_found" && CID.test(res.message), `${formType}: ${JSON.stringify(res)}`);
    }
  });

  // A person uploads CID's BUILDING blank (no source URL — the upload route stores none) and it is filled.
  const cidId = auto.storeAhjFormTemplate(db, { ahjName: CID_NAME, state: "NM", formType: "building_application", filename: "CID Multi-Purpose State Building Application.pdf",
    bytes: await acroPdf("CID Multi-Purpose State Building Application"), map: mapFor("CID Multi-Purpose State Building Application") } as never);
  await check("a CID upload never displaces the county's own row from the fill list", () => {
    const loaded = forms.loadStoredTemplates(db, "Valencia County", "NM").map((t) => t.templateId);
    assert(loaded.includes(countyId) && loaded.includes(cidId), JSON.stringify(loaded));
  });
  await writeFill(cidId);
  await check("a CID-authority building form fills CID's BUILDING row only (local kept, electrical still owed)", async () => {
    const { local, cidBuilding, cidElectrical, all } = presence();
    assert(local?.present === true && cidBuilding?.present === true, JSON.stringify(all));
    assert(cidElectrical?.present === false, `CID's building form satisfied the electrical row: ${JSON.stringify(all)}`);
    const res = await auto.ensureAhjFormTemplate(db, noModel, job, "electrical_application", { allowResearch: false });
    assert(res.status === "not_found" && CID.test(res.message), `electrical acquisition: ${JSON.stringify(res)}`);
  });
  // CONTRAST (fails on main on behaviour, not an import): the SAME building_application-typed own blank
  // keys to the city's own building row in Albuquerque (unchanged) and to the local review slot only
  // where a state agency issues the trade permits.
  await check("Albuquerque control vs Valencia: an own building_application fill stays building in Albuquerque, local review in Valencia", async () => {
    const abq = repo.createProject(db, {
      owner: "Example Owner", street: "200 Example Ave", city: "Albuquerque", state: "NM", zip: "87102", ahj: "Albuquerque", utility: "Example Utility",
      dcKw: "8.2", acKw: "7.6", homeownerPhone: "5050000000", mounting: "Roof Mount", structureDescription: "Single-family dwelling",
    } as never).project as ProjectRecord;
    const abqId = auto.storeAhjFormTemplate(db, { ahjName: "Albuquerque", state: "NM", formType: "building_application", filename: "Albuquerque Building Permit Application.pdf",
      bytes: await acroPdf("Albuquerque Building Permit Application"), map: mapFor("Albuquerque Building Permit Application") } as never);
    const dir = path.resolve(process.cwd(), "backend/data/filled", abq.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `tmpl-${abqId}.pdf`), await acroPdf("filled"));
    try {
      const filled = forms.filledApplicationForms(db, abq.id);
      assert(filled.length === 1 && filled[0].docType === "building_application", JSON.stringify(filled));
      const county = forms.filledApplicationForms(db, job.id).find((f) => f.filePath.endsWith(`tmpl-${countyId}.pdf`));
      assert(county?.docType === "permit_application", `Valencia's own fill keyed ${county?.docType}`);
      assert(forms.loadStoredTemplates(db, "Albuquerque", "NM").some((t) => t.templateId === abqId), "city row loaded");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
} finally {
  fs.rmSync(filledDir, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} NM state-issuer form check(s) FAILED.`); process.exit(1); }
console.log("\nAll NM state-issuer form checks passed.");
process.exit(0);
