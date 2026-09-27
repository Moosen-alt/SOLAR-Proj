// ISSUING-AGENCY FORMS (operator finding 2026-09-27, Michael Sheridan — City of Jefferson / Marion
// County / Pacific Power: "still only just pulling that one doc"). The per-job lookup said Marion
// County ISSUES both permits and cited the county's B-01S; the packet held only the BCD 5952.
//
// Pins, with real public blanks (backend/test/fixtures/marion-*.pdf, fetched once 2026-09-27) and
// no network / no model:
//   A. ONE predicate, every door — formAuthorityFor; loadStoredTemplates hands a city job the
//      issuing agency's applications (exact identity, never name containment); the staging-time
//      fill forecast and the fill itself see them. A verified city form is never displaced.
//   B. ACQUISITION — the agency's curated seed / the lookup-cited PDF, fetched once, stored under the
//      AGENCY (provenance: source URL, retrieved-at, sha); a non-fillable cited PDF is stored and
//      never reported "filled"; a county form is never stored as the city's; verified maps kept.
//   C. THE PACKET — the required set, the packet list and the job's own list (docs.complete) name the
//      agency's applications + the state checklist + the city prerequisite; a job whose lookup names
//      no agency keeps today's list.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "issuing-agency-forms-"));
process.env.AUTOPILOT_DB_PATH = path.join(temp, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.PROJECT_DOCS_DIR = path.join(temp, "docs");
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { savePermitProcessLookup } = await import("../src/permitProcess");
const agencyMod = await import("../src/applicationDocsAgency");
const { formAuthorityFor, issuingAgencyDocumentList } = agencyMod;
const forms = await import("../src/ahjForms");
const auto = await import("../src/ahjFormAuto");
const reqDocs = await import("../src/requiredDocuments");
const { buildApplicationDocumentPackage, findApplicationProfile } = await import("../src/applicationDocs");
const { extractLabels } = await import("../src/formTextLayer");

const db = await openDatabase();
const noModel = new Proxy({}, { get() { throw new Error("known public forms must not call a model"); } }) as never;
const B01S_URL = "https://www.co.marion.or.us/PW/BuildingInspection/Documents/B-01S%20Solar%20Prescriptive%20Installation%20Application%20Filleable.pdf";
const E01_URL = "https://www.co.marion.or.us/PW/BuildingInspection/Documents/E-01%20Renewable%20Energy%20Permit%20Application.pdf";
const B5952_URL = "https://www.oregon.gov/bcd/Formslibrary/5952.pdf";
const fixture = (name: string) => fs.readFileSync(path.join("backend/test/fixtures", name));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let passed = 0;
const check = (name: string, cond: unknown, detail = ""): void => {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
};

// The Jefferson lookup's shape (permit_process_lookups 'or|city of jefferson' on the .backup copy).
const cited = (value: string | null, sourceUrl: string, quote: string) => ({ value, sourceUrl, quote, origin: "lookup" as const });
const notFound = (why: string) => ({ value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: why });
function saveCountyLookup(ahj: string, agency: string, buildingSource: string, extra: Record<string, unknown> = {}): void {
  const r = savePermitProcessLookup(db, {
    state: "OR", ahj, lookedUpAt: new Date().toISOString(),
    issuingAgency: notFound("not stated at the top level"),
    permitStructure: cited("separate", "https://jeffersonoregon.org/planning-committee/", "Structural permits must be submitted to City Hall first before going to the County. All Electrical and Plumbing permits are submitted to Marion County Building"),
    permits: [
      {
        discipline: "structural", label: "Solar PV (Prescriptive) / Structural Permit",
        issuingAgency: cited(agency, buildingSource, `Prescriptive Solar Photovoltaic Installation Permit Application · ${agency} Public Works`),
        portalUrl: notFound("none"), recordType: notFound("none"),
        documents: { ...notFound("no list"), sourceUrl: "https://jeffersonoregon.org/planning-committee/", quote: "Structural permits must be submitted to City Hall first before going to the County." },
        fee: notFound("none"),
      },
      {
        discipline: "electrical", label: "Electrical Permit",
        issuingAgency: cited(agency, "https://jeffersonoregon.org/planning-committee/", `All Electrical and Plumbing permits are submitted to ${agency} Building and those forms can be found here.`),
        portalUrl: notFound("none"), recordType: notFound("none"), documents: notFound("no list"), fee: notFound("none"),
      },
    ],
    notes: [],
    ...extra,
  } as never);
  assert.equal(r.saved, true);
}
saveCountyLookup("City of Jefferson", "Marion County", B01S_URL);
// A city that issues its OWN permits (the lookup names the city's own department).
savePermitProcessLookup(db, {
  state: "OR", ahj: "City of Salem", lookedUpAt: new Date().toISOString(),
  issuingAgency: cited("City of Salem Permit Center", "https://www.cityofsalem.net/business/building-permits", "City of Salem Permit Center issues building and electrical permits"),
  permitStructure: notFound("n/a"), permits: [], notes: [],
} as never);

const jefferson = {
  id: "jefferson-fixture", ahj: "City of Jefferson", state: "OR", city: "Jefferson", zip: "97352", utility: "Pacific Power",
  homeownerName: "Fixture Owner", projectAddress: "1 Fixture Rd SE, Jefferson, OR, 97352", systemSizeDcKw: 15.91, systemSizeAcKw: 12.9,
  parserSnapshot: { permitPathOverride: "prescriptive", homeownerPhone: "4580000000", mounting: "Roof Mount", structureDescription: "Single-family dwelling",
    snow: 20, wind: "C", windSpeed: "110", deadLoad: 1.28, lightFrame: "yes", roofRafterSpacing: "24", framingType: "truss", moduleQuantity: "37", moduleModel: "Q.TRON BLK M-G2.C1+/AC",
    // Michael Sheridan's stated facts (the .backup copy), which answer every 5952 row but height.
    gravityWindDesign: "yes", manufacturerInstallation: "yes", roofMaterial: "Composition Shingle", roofLayers: "1",
    attachmentToFraming: "yes", attachmentSpacingIn: 48, attachmentsOutsideEdgeZone: "yes" },
} as never;

// Serve the public fixtures for their real URLs; count every download.
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

try {
  // ── A. ONE PREDICATE ────────────────────────────────────────────────────────────────────
  const bAuth = formAuthorityFor(jefferson, "building_application");
  check("A1 the building-side application of a Jefferson job is Marion County's", bAuth.issuedByOther && bAuth.name === "Marion County", JSON.stringify(bAuth));
  check("A1 so is the generic permit_application slot", formAuthorityFor(jefferson, "permit_application").name === "Marion County");
  check("A1 and the electrical application", formAuthorityFor(jefferson, "electrical_application").name === "Marion County");
  check("A1 the state checklist stays the AHJ's", !formAuthorityFor(jefferson, "solar_checklist").issuedByOther && formAuthorityFor(jefferson, "solar_checklist").name === "City of Jefferson");
  check("A2 a city whose lookup names its own department keeps its own forms", !formAuthorityFor({ ahj: "City of Salem", state: "OR" }, "building_application").issuedByOther);
  check("A2 a job whose lookup names no agency keeps its own forms", !formAuthorityFor({ ahj: "City of Nolookup", state: "OR" }, "electrical_application").issuedByOther);
  check("A2 identity is exact: a Jefferson County row is not Marion County's", !agencyMod.rowBelongsToAuthority("Jefferson County", "Marion County") && !agencyMod.rowBelongsToAuthority("Marion", "Marion County") && agencyMod.rowBelongsToAuthority("MARION COUNTY", "Marion County"));

  // ── B. ACQUISITION ──────────────────────────────────────────────────────────────────────
  // A county form is never stored as the city's (the curated seed is keyed to the agency).
  const asCity = await auto.acquireFromBytes(db, noModel, { ahj: "City of Jefferson", state: "OR", formType: "building_application", formName: "B-01S", bytes: fixture("marion-b-01s.pdf"), sourceUrl: B01S_URL });
  check("B0 the B-01S offered under the CITY's name is refused (belongs to another jurisdiction)", asCity.status === "needs_manual" && !db.get("SELECT 1 AS x FROM ahj_form_templates WHERE lower(ahj_name) = 'city of jefferson'"), JSON.stringify(asCity));

  downloads = [];
  const ensured = await auto.ensureAhjFormsForProject(db, noModel, jefferson, { allowResearch: false });
  const byType = new Map(ensured.results.map((r) => [r.formType, r]));
  check("B1 the needed set is the county's two applications + the state checklist", ["building_application", "electrical_application", "solar_checklist"].every((t) => byType.has(t)), JSON.stringify(ensured.neededTypes));
  check("B1 all three acquired", ensured.results.every((r) => r.status === "acquired"), JSON.stringify(ensured.results.map((r) => [r.formType, r.status, r.message])));
  check("B1 one download per PDF, no research", downloads.length === 3 && [B01S_URL, E01_URL, B5952_URL].every((u) => downloads.includes(u)), downloads.join(", "));
  const rows = db.query<{ ahj_name: string; form_type: string; source_url: string; retrieved_at: string; field_map: string }>("SELECT ahj_name, form_type, source_url, retrieved_at, field_map FROM ahj_form_templates ORDER BY form_type");
  const marionB = rows.find((r) => r.form_type === "building_application");
  const marionE = rows.find((r) => r.form_type === "electrical_application");
  check("B1 the B-01S is stored under Marion County with provenance", marionB?.ahj_name === "Marion County" && marionB.source_url === B01S_URL && Boolean(marionB.retrieved_at) && JSON.parse(marionB.field_map).sourceHash === sha(fixture("marion-b-01s.pdf")), JSON.stringify({ ...marionB, field_map: undefined }));
  check("B1 stamped the PRESCRIPTIVE application", JSON.parse(marionB!.field_map).applicationKind === "prescriptive");
  check("B1 the E-01 is stored under Marion County with provenance", marionE?.ahj_name === "Marion County" && marionE.source_url === E01_URL && JSON.parse(marionE.field_map).sourceHash === sha(fixture("marion-e-01.pdf")));
  check("B1 the checklist stays the city's", rows.find((r) => r.form_type === "solar_checklist")?.ahj_name === "City of Jefferson");
  check("B1 no county form under the city's name", !rows.some((r) => r.ahj_name === "City of Jefferson" && r.form_type !== "solar_checklist"));
  downloads = [];
  const again = await auto.ensureAhjFormsForProject(db, noModel, jefferson, { allowResearch: false });
  check("B2 a second pass downloads nothing and reports exists", downloads.length === 0 && again.results.every((r) => r.status === "exists"), JSON.stringify(again.results.map((r) => r.status)));
  // Every other city Marion County issues for gets the same forms with no download.
  saveCountyLookup("City of Gates", "Marion County", B01S_URL);
  const gates = { ...(jefferson as object), id: "gates-fixture", ahj: "City of Gates", city: "Gates" } as never;
  check("B2 another city the county issues for loads the county's forms", forms.loadStoredTemplates(db, "City of Gates", "OR").filter((t) => t.issuedBy === "Marion County").length === 2);
  const engineered = { ...(jefferson as object), parserSnapshot: { ...(jefferson as { parserSnapshot: object }).parserSnapshot, permitPathOverride: "engineered" } } as never;
  downloads = [];
  const eng = await auto.ensureAhjFormTemplate(db, noModel, engineered, "building_application", { allowResearch: false });
  check("B3 an ENGINEERED job never takes the prescriptive B-01S", eng.status === "not_found" && /Marion County/.test(eng.message) && downloads.length === 0, JSON.stringify(eng));

  // ── A (doors) — the loader, the staging-time forecast, the fill ─────────────────────────
  const loaded = forms.loadStoredTemplates(db, "City of Jefferson", "OR");
  const loadedB = loaded.find((t) => t.formType === "building_application");
  const loadedE = loaded.find((t) => t.formType === "electrical_application");
  check("A3 the Jefferson loader holds the county's two applications, marked as the county's", loadedB?.issuedBy === "Marion County" && loadedE?.issuedBy === "Marion County" && loadedB.authority === "Marion County");
  check("A3 and the city's own checklist", loaded.some((t) => t.formType === "solar_checklist" && !t.issuedBy && t.authority === "City of Jefferson"));
  check("A4 a city that issues its own permits never loads the county's", !forms.loadStoredTemplates(db, "City of Salem", "OR").some((t) => t.authority === "Marion County"));
  check("A4 a job whose lookup names no agency never loads them", forms.loadStoredTemplates(db, "City of Nolookup", "OR").length === 0);
  check("A4 ownOnly answers for the authority alone", !forms.loadStoredTemplates(db, "City of Jefferson", "OR", { ownOnly: true }).some((t) => t.issuedBy));

  const inv = reqDocs.documentInventory(db, jefferson);
  const owed = reqDocs.owedMissingDocuments(db, jefferson, inv);
  check("A5 the staging-time forecast counts the county's applications as filled at staging", ["building_application", "electrical_application", "solar_checklist"].every((t) => owed.filledAtStaging.some((d) => d.docType === t))
    && !owed.owed.some((d) => reqDocs.APPLICATION_DOC_TYPES.has(d.docType)),
    JSON.stringify({ owed: owed.owed.map((d) => d.docType), atStaging: owed.filledAtStaging.map((d) => d.docType) }));

  const pkg = await forms.buildFilledFormsForProject(db, { ...(jefferson as object), id: `jefferson-fill-${Date.now()}` } as never);
  const filledB = pkg.forms.find((f) => f.templateId === loadedB!.templateId);
  const filledE = pkg.forms.find((f) => f.templateId === loadedE!.templateId);
  check("A6 the fill produces the county's B-01S", filledB?.status === "filled" && /Marion County's own application/.test(filledB.message || ""), JSON.stringify(filledB));
  check("A6 and its E-01", filledE?.status === "filled" && /Marion County's own application/.test(filledE.message || ""), JSON.stringify(filledE));
  const b01sOut = await PDFDocument.load(fs.readFileSync(filledB!.outputPath!));
  check("A6 the B-01S carries the project's values", b01sOut.getForm().getTextField("Owner name").getText() === "Fixture Owner" && b01sOut.getForm().getTextField("Owner phone number").getText() === "(458) 000-0000");
  check("A6 roof-mounted Yes; the city's zoning groups untouched", b01sOut.getForm().getRadioGroup("undefined_3").getSelected() === "Yes_3" && b01sOut.getForm().getRadioGroup("undefined").getSelected() === undefined && b01sOut.getForm().getRadioGroup("undefined_2").getSelected() === undefined);
  check("A6 the structure row (single-family) and the prescriptive attestation (every checklist row Yes) ticked Yes",
    b01sOut.getForm().getRadioGroup("undefined_4").getSelected() === "Yes_4" && b01sOut.getForm().getRadioGroup("undefined_5").getSelected() === "Yes_5");
  const e01Out = await PDFDocument.load(fs.readFileSync(filledE!.outputPath!));
  check("A6 the E-01 ticks the kVA bracket the AC size falls in", e01Out.getForm().getTextField("501 to 15 kva").getText() === "1" && !e01Out.getForm().getTextField("5 kva or less").getText());
  check("A6 the E-01 description wraps across its two rows", Boolean(e01Out.getForm().getTextField("DESCRIPTION OF WORKRow2").getText()));
  check("A6 the E-01 never signs the owner-installation line", !(await extractLabels(fs.readFileSync(filledE!.outputPath!))).some((l) => /Fixture Owner/.test(l.str) && l.y < 330 && l.y > 310));

  // A verified CITY application of the same track is never displaced by the county's automatic one.
  const vId = auto.storeAhjFormTemplate(db, { ahjName: "City of Jefferson", state: "OR", formType: "electrical_application", filename: "City electrical.pdf", bytes: fixture("marion-e-01.pdf"),
    map: { formName: "City of Jefferson electrical application", sourceUrl: "", fillMode: "acroform", textFields: { Name: "project.homeownerName" }, checkboxes: {}, notes: "" } });
  const vRow = db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE id = ?", [vId])!;
  db.run("UPDATE ahj_form_templates SET field_map = ? WHERE id = ?", [JSON.stringify({ ...JSON.parse(vRow.field_map), verified: true }), vId]);
  const withVerified = forms.loadStoredTemplates(db, "City of Jefferson", "OR").filter((t) => t.formType === "electrical_application");
  check("A7 a person-verified city form stays; the county's is not added beside it", withVerified.length === 1 && withVerified[0].templateId === vId);
  db.run("UPDATE ahj_form_templates SET field_map = ? WHERE id = ?", [vRow.field_map, vId]);
  const withUnverified = forms.loadStoredTemplates(db, "City of Jefferson", "OR").filter((t) => t.formType === "electrical_application");
  check("A7 an unverified city form of the same track gives way to the issuing agency's", withUnverified.length === 1 && withUnverified[0].issuedBy === "Marion County");
  db.run("DELETE FROM ahj_form_templates WHERE id = ?", [vId]);

  // Verified agency maps are never overwritten.
  db.run("UPDATE ahj_form_templates SET field_map = json_set(field_map, '$.verified', json('true')) WHERE ahj_name = 'Marion County' AND form_type = 'building_application'");
  const before = db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE ahj_name = 'Marion County' AND form_type = 'building_application'")!.field_map;
  const reacq = await auto.acquireFromBytes(db, noModel, { ahj: "Marion County", state: "OR", formType: "building_application", formName: "B-01S", bytes: fixture("marion-b-01s.pdf"), sourceUrl: B01S_URL });
  check("B5 a verified county map is retained", reacq.status === "exists" && db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE ahj_name = 'Marion County' AND form_type = 'building_application'")!.field_map === before);

  // ── B4. A cited, NON-FILLABLE agency PDF: stored, listed, never "filled" ────────────────
  const flat = await PDFDocument.create();
  const page = flat.addPage([612, 792]);
  page.drawText("Fixture County Solar Permit Application — flat scan, no fields", { x: 40, y: 740, size: 12, font: await flat.embedFont(StandardFonts.Helvetica) });
  const flatBytes = Buffer.from(await flat.save());
  const FLAT_URL = "https://www.co.fixture.or.us/forms/Solar%20Photovoltaic%20Permit%20Application.pdf";
  served.set(FLAT_URL, flatBytes);
  saveCountyLookup("City of Fixtureville", "Fixture County", FLAT_URL);
  const fixtureville = { ...(jefferson as object), id: "fixtureville", ahj: "City of Fixtureville", city: "Fixtureville" } as never;
  check("B4 the lookup-cited PDF is named as the county's application", agencyMod.agencyApplicationForms(fixtureville, "building_application", "prescriptive").some((f) => f.origin === "cited" && f.sourceUrl === FLAT_URL));
  downloads = [];
  const flatRes = await auto.ensureAhjFormTemplate(db, noModel, fixtureville, "building_application", { allowResearch: false });
  check("B4 fetched once, stored under the county as a blank to complete by hand", flatRes.status === "needs_manual" && downloads.length === 1
    && db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ahj_form_templates WHERE ahj_name = 'Fixture County' AND source_url = ?", [FLAT_URL])!.n === 1, JSON.stringify(flatRes));
  const flatPkg = await forms.buildFilledFormsForProject(db, fixtureville);
  const flatForm = flatPkg.forms.find((f) => /Fixture County/.test(f.message || ""));
  check("B4 the fill lists it as needs_manual — never filled", flatForm?.status === "needs_manual" && !flatPkg.forms.some((f) => f.status === "filled" && f.formName === flatForm.formName), JSON.stringify(flatPkg.forms.map((f) => [f.formName, f.status])));
  const flatInv = reqDocs.documentInventory(db, fixtureville);
  const flatRow = flatInv.presence.find((p) => p.docType === "building_application")!;
  check("B4 the required row stays blocking and says to complete + attach it", flatRow.blocking && !flatRow.present && /completed by hand and attached/.test(flatRow.label), JSON.stringify(flatRow));
  check("B4 the staging forecast does not pretend it will be filled", !reqDocs.owedMissingDocuments(db, fixtureville, flatInv).filledAtStaging.some((d) => d.docType === "building_application"));

  // ── C. THE PACKET ───────────────────────────────────────────────────────────────────────
  const jInv = reqDocs.documentInventory(db, jefferson);
  const bRow = jInv.presence.find((p) => p.docType === "building_application")!;
  const eRow = jInv.presence.find((p) => p.docType === "electrical_application")!;
  check("C1 the building row names Marion County's B-01S and blocks", /Marion County/.test(bRow.label) && /B-01S/.test(bRow.label) && bRow.blocking && /Marion County's own application/.test(bRow.why), JSON.stringify(bRow));
  check("C1 the electrical row names Marion County's E-01 and blocks (not portal entry)", /E-01/.test(eRow.label) && eRow.blocking && !/entered in the portal/.test(eRow.label), JSON.stringify(eRow));
  const packet = buildApplicationDocumentPackage(jefferson);
  const list = packet.profile.requiredDocuments.join("\n");
  check("C2 the packet lists the county's B-01S", /Marion County.*B-01S/.test(list), list);
  check("C2 the packet lists the county's E-01", /Marion County.*E-01/.test(list));
  check("C2 the packet lists the state checklist", /BCD 440-5952/.test(list));
  check("C2 the packet lists the city prerequisite", /City of Jefferson zoning approval/.test(list));
  check("C2 no generic portal-entry line", !/portal entry/i.test(list));
  const job = reqDocs.requiredListCheck(db, jefferson, jInv);
  check("C3 docs.complete reads the job's own list", job.source === "lookup" && /Marion County/.test(job.sourceLabel) && job.items.length === 4, JSON.stringify(job.items.map((i) => i.text)));
  check("C3 the prerequisite is open until the operator answers", job.missing.some((m) => /zoning approval/.test(m.text)));
  const answered = { ...(jefferson as object), parserSnapshot: { ...(jefferson as { parserSnapshot: object }).parserSnapshot, zoningApproval: "Not required" } } as never;
  check("C3 and settled by the zoning answer", !reqDocs.requiredListCheck(db, answered, reqDocs.documentInventory(db, answered)).missing.some((m) => /zoning approval/.test(m.text)));
  const plain = { ...(jefferson as object), id: "plain", ahj: "City of Nolookup", city: "Nolookup" } as never;
  check("C4 a job whose lookup names no agency keeps today's packet list", issuingAgencyDocumentList(plain) === null
    && JSON.stringify(buildApplicationDocumentPackage(plain).profile.requiredDocuments) === JSON.stringify(findApplicationProfile(plain).requiredDocuments));
  check("C4 and today's required rows (no agency named)", !reqDocs.documentInventory(db, plain).presence.some((p) => /County/.test(p.label)));

  // ── D. THE BCD 5952 ON AN AGENCY-ISSUED JOB (Michael Sheridan's "janky" checklist) ─────────
  // A checklist row stored BEFORE this change (unverified): the AHJ on "Building department:",
  // the parser's bare phone digits, no value size (the blank's auto-size set 14-pt values).
  const stored5952 = forms.loadStoredTemplates(db, "City of Jefferson", "OR").find((t) => t.formType === "solar_checklist")!;
  check("D0 a new 5952 acquisition maps the department to the issuing agency and sizes its values", stored5952.def.overlayFields?.[0]?.source === "computed.buildingDepartment"
    && stored5952.def.textFields["Phone number"] === "computed.homeownerPhone" && stored5952.def.fieldFontSizes?.["Property owner name"] === 10);
  const oldDef = {
    ...stored5952.def,
    textFields: { ...stored5952.def.textFields, "Phone number": "snapshot.homeownerPhone" },
    overlayFields: [{ source: "project.ahj", page: 0, x: 270, y: 693.82, size: 10 }],
    fieldFontSizes: undefined,
    recoverPrescriptiveCheckboxes: true,
  };
  const ctx5952 = forms.buildContext(db, jefferson);
  const out5952 = path.join(temp, "old-5952.pdf");
  await forms.fillLoadedForm(oldDef as never, stored5952.bytes, ctx5952, out5952);
  const l5952 = await extractLabels(fs.readFileSync(out5952));
  const dept = l5952.find((l) => l.page === 0 && Math.abs(l.y - 693.8) < 2 && l.x >= 269);
  check("D1 'Building department:' names the agency that reviews the permit, not the city", dept?.str === "Marion County", JSON.stringify(dept));
  check("D1 the owner's phone reads as a phone", l5952.some((l) => l.str === "(458) 000-0000") && !l5952.some((l) => l.str === "4580000000"));
  const ownerValue = l5952.find((l) => l.str === "Fixture Owner");
  check("D1 values print at the checklist's 10 pt, not the blank's 14-pt auto size", ownerValue != null && Math.abs(ownerValue.height - 10) < 0.6, JSON.stringify(ownerValue));
  // Too wide for its box at 10 pt -> the blank's own fit, never clipped at the box edge.
  const longName = "Fixture Contractor With An Exceptionally Long Registered Business Name Incorporated";
  const out5952b = path.join(temp, "long-5952.pdf");
  await forms.fillLoadedForm(stored5952.def, stored5952.bytes, { ...ctx5952, client: { ...ctx5952.client, installerCompanyName: longName } }, out5952b);
  const longItem = (await extractLabels(fs.readFileSync(out5952b))).find((l) => l.str === longName);
  check("D2 a value too wide at 10 pt keeps the fit size and stays inside its 270-pt box", longItem != null && longItem.height < 10 && longItem.width <= 270, JSON.stringify(longItem));
  // The county application's prescriptive attestation reads the SAME answers the checklist prints.
  check("D3 attestation Yes when every checklist row is Yes (height assumed Yes, as the 5952 prints it)", forms.resolveSource("computed.checklistAllYes", ctx5952) === "yes");
  const tall = { ...(jefferson as object), parserSnapshot: { ...(jefferson as { parserSnapshot: object }).parserSnapshot, moduleHeightAboveRoof: "24" } } as never;
  check("D3 attestation blank when the checklist's height row says No", forms.resolveSource("computed.checklistAllYes", forms.buildContext(db, tall)) === "");
  check("D3 the structure row: single-family yes, a duplex blank (area/height unknown)", forms.resolveSource("computed.structureSfdOrAccessory", ctx5952) === "yes"
    && forms.resolveSource("computed.structureSfdOrAccessory", { ...ctx5952, snapshot: { ...ctx5952.snapshot, structureDescription: "Two-family dwelling (duplex)" } }) === "");
  const noLookup = { ...(jefferson as object), id: "nolookup-5952", ahj: "City of Nolookup" } as never;
  check("D4 a job whose lookup names no agency keeps its own name on the department line", forms.resolveSource("computed.buildingDepartment", forms.buildContext(db, noLookup)) === "City of Nolookup");

  console.log(`issuingAgencyForms: ${passed} checks passed — one predicate at every door, agency-keyed acquisition with provenance, non-fillable never filled, packet names the issuing agency's forms, the 5952 names the reviewing department`);
} finally {
  globalThis.fetch = realFetch;
  db.close();
  assert.equal(path.dirname(temp), os.tmpdir());
  fs.rmSync(temp, { recursive: true, force: true });
}
