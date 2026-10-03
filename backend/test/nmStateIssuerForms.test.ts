// A STATE ISSUER'S APPLICATION (issue #53, after #45 routed NM trade permits to the state CID).
// Valencia County / the Village of Los Lunas only review zoning and the site plan; the state
// Construction Industries Division issues the building AND electrical permits on ONE application.
// The document gate demanded two CID forms the finder never looked for on the state's site, and
// dropped the county's own review application. Pins, synthetic project, no network, no model:
//   - the required set = the LOCAL review application (the AHJ's own, the prerequisite step) + ONE
//     CID application that satisfies both the building and the electrical requirement — never two;
//   - the form finder looks for CID's form on the ISSUER's site (rld.nm.gov), and a not_found names
//     the issuer and the reason; no fabricated URL (the state rule's form is seeded, url "");
//   - Albuquerque (a full-service city) is unchanged.
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
const { stateIssuerFormFor, stateRulesFor } = await import("../src/permitProcess");
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

await check("Valencia County: ONE CID application, satisfying both the building and the electrical requirement", () => {
  const cid = rows(valencia).filter((r) => CID.test(r.label));
  assert(cid.length === 1, `CID rows: ${JSON.stringify(cid.map((r) => r.label))}`);
  const docTypes = [cid[0].docType, ...(cid[0].altDocTypes ?? [])];
  assert(docTypes.includes("building_application") && docTypes.includes("electrical_application"), JSON.stringify(docTypes));
  assert(!docTypes.includes("permit_application"), "the local review's generic slot must not satisfy CID's application");
  assert(!rows(valencia).some((r) => r.docType === "electrical_application"), "a second (electrical) CID row was demanded");
  assert(cid[0].blocking, "CID's application is still owed (blocking)");
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
await check("the job's own list names ONE CID application (never two) and the county's review application", () => {
  const items = issuingAgencyDocumentList(valencia)?.items ?? [];
  const cid = items.filter((i) => i.role === "application" && CID.test(String(i.agency)));
  assert(cid.length === 1, JSON.stringify(items.map((i) => i.text)));
  assert(cid[0].docTypes.includes("building_application") && cid[0].docTypes.includes("electrical_application"), JSON.stringify(cid[0].docTypes));
  assert(items.some((i) => i.docTypes.includes("permit_application") && /Valencia County/.test(i.text)), JSON.stringify(items.map((i) => i.text)));
});
await check("the state rule's form is seeded on the state site with NO fabricated URL (rule 3)", () => {
  const form = stateIssuerFormFor(valencia);
  assert(form, "no state issuer form");
  assert(form!.url === "", `a form URL was set without confirmation: ${form!.url}`);
  assert(/^https:\/\/www\.rld\.nm\.gov\//.test(form!.searchUrl) && /^https:\/\/www\.rld\.nm\.gov\//.test(form!.sourceUrl), form!.searchUrl);
  assert(form!.origin === "state_rule" && /CID form URL not confirmed/.test(form!.notFound), form!.notFound);
  assert(form!.tracks.includes("building") && form!.tracks.includes("electrical"), JSON.stringify(form!.tracks));
  assert(stateRulesFor("NM").stateTradeIssuer?.issuerForm?.url === "", "seed carries a URL");
});

const db = await openDatabase();
const noModel = new Proxy({}, { get() { throw new Error("a state issuer's form must not call a model"); } }) as never;
await check("find-ahj-form for CID's slot looks on the ISSUER's site; not_found names CID and the reason", async () => {
  const res = await auto.ensureAhjFormTemplate(db, noModel, valencia, "building_application", { allowResearch: false });
  assert(res.status === "not_found", JSON.stringify(res));
  assert(CID.test(res.message) && /rld\.nm\.gov/.test(res.message) && /CID form URL not confirmed/.test(res.message), res.message);
  assert(!res.sourceUrl, `a URL was attempted: ${res.sourceUrl}`);
  const urls = res.message.match(/https?:\/\/[^\s),;]+/g) ?? [];
  assert(urls.every((u) => /^https:\/\/www\.rld\.nm\.gov\//.test(u)), `a non-state URL in the message: ${urls.join(", ")}`);
});
await check("the pass asks for the local application + ONE CID application, never a second CID form", async () => {
  const pass = await auto.ensureAhjFormsForProject(db, noModel, valencia, { allowResearch: false });
  assert(pass.neededTypes.includes("permit_application") && pass.neededTypes.includes("building_application"), JSON.stringify(pass.neededTypes));
  assert(!pass.neededTypes.includes("electrical_application"), JSON.stringify(pass.neededTypes));
});
await check("a manufactured home (MHD) carries no CID form", () => {
  assert(stateIssuerFormFor(project("Valencia County", "Los Lunas", { structureTypeOverride: "manufactured" })) === null, "MHD got CID's form");
});
await check("Albuquerque (full-service city): unchanged — no state form, no CID row, the generic slot is the city's", () => {
  const abq = project("Albuquerque", "Albuquerque");
  assert(stateIssuerFormFor(abq) === null, "state form for Albuquerque");
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
  const cid = inv.presence.find((d) => CID.test(d.label));
  return { local, cid, all: inv.presence.filter((d) => reqDocs.APPLICATION_DOC_TYPES.has(d.docType)).map((d) => `${d.docType}:${d.present}:${d.via}`) };
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
  await check("the county's building_application-typed fill satisfies the LOCAL row and never CID's", () => {
    const { local, cid, all } = presence();
    assert(local?.present === true, `local: ${JSON.stringify(all)}`);
    assert(cid && cid.present === false, `CID counted present off the county's fill: ${JSON.stringify(all)}`);
  });
  await check("the job's list: the county line filled, CID's line not on file", () => {
    const status = reqDocs.agencyListStatusResolver(db, job);
    const items = issuingAgencyDocumentList(job, status)?.items ?? [];
    const cidLine = items.find((i) => i.role === "application" && CID.test(String(i.agency)));
    const localLine = items.find((i) => i.docTypes.includes("permit_application") && /Valencia County/.test(i.text));
    assert(localLine?.status === "filled", `local line: ${JSON.stringify(localLine)}`);
    assert(cidLine && cidLine.status !== "filled" && cidLine.status !== "on_file", `CID line: ${JSON.stringify(cidLine)}`);
  });
  await check("acquisition: the local slot counts the county's own blank as held (no re-acquire)", async () => {
    const res = await auto.ensureAhjFormTemplate(db, noModel, job, "permit_application", { allowResearch: false });
    assert(res.status === "exists", JSON.stringify(res));
  });
  await check("acquisition: CID's slot is NOT satisfied by the county's building_application blank", async () => {
    const res = await auto.ensureAhjFormTemplate(db, noModel, job, "building_application", { allowResearch: false });
    assert(res.status === "not_found" && CID.test(res.message), JSON.stringify(res));
  });

  // A person uploads CID's blank (no source URL — the upload route stores none) and it is filled.
  const cidId = auto.storeAhjFormTemplate(db, { ahjName: CID_NAME, state: "NM", formType: "building_application", filename: "CID Permit Application.pdf",
    bytes: await acroPdf("CID Permit Application"), map: mapFor("CID Permit Application") } as never);
  await check("a CID upload never displaces the county's own row from the fill list", () => {
    const loaded = forms.loadStoredTemplates(db, "Valencia County", "NM").map((t) => t.templateId);
    assert(loaded.includes(countyId) && loaded.includes(cidId), JSON.stringify(loaded));
  });
  await writeFill(cidId);
  await check("after CID's blank is uploaded and filled: the local row AND CID's row are present", () => {
    const { local, cid, all } = presence();
    assert(local?.present === true && cid?.present === true, JSON.stringify(all));
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
