// A STORED FORM WHOSE BLANK IS A HASH-LOCKED CODE TEMPLATE FILLS FROM THE CURRENT CODE MAP
// (dry-run 2026-09-28, B6).
//
// The BCD 5952 and the Coos County electrical application have maps written in code against one
// exact PDF (bcd5952Template.ts, curatedAhjForms.ts). The map is COPIED into the row when the form
// is stored, and acquisition answers "exists" for good after that — so a code fix never reached an
// older row: a 5952 stored on 09-19 still filled the owner phone from the old source at auto-size,
// and the Coos County row lacked the battery services line. The submit gate then asked a person to
// "Mark verified" those maps, and verifying would have locked the outdated copies in (hard rule 3);
// verifying a 5952 also switched off its answer recovery.
//
//   MUST-PASS    an UNVERIFIED row of a code-template blank reads the current code map, writes nothing
//   MUST-PASS    the gate does not ask a person to verify it; an automatically derived map still asks
//   MUST-PASS    a person's verify records the map they previewed, and the 5952 still draws its answers
//   MUST-EXCLUDE a VERIFIED row keeps exactly its stored map (hard rule 3)
//   MUST-EXCLUDE a different blank (another hash) keeps its stored map
//   MUST-EXCLUDE a curated blank stored under ANOTHER authority's name keeps its stored map
//
//   npx tsx backend/test/builtInFormMap.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so filled/ docs/ never land in the repo's backend/data
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "built-in-form-map-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE"]) process.env[k] = "off";
process.env.PORTAL_ALLOW_FINAL_SUBMIT = "false";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const repo = await import("../src/repository");
const { storeAhjFormTemplate } = await import("../src/ahjFormAuto");
const { loadStoredTemplates, fillLoadedForm, setStoredTemplateVerified } = await import("../src/ahjForms");
const { bcd5952Template } = await import("../src/bcd5952Template");
const { curatedFormMap } = await import("../src/curatedAhjForms");
const { extractLabels } = await import("../src/formTextLayer");

const db = await openDatabase();
let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log(`  ok   - ${name}`); };
const fieldMapOf = (id: string): string => db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE id = ?", [id])!.field_map;
const rowId = (ahj: string, formType: string): string =>
  db.get<{ id: string }>("SELECT id FROM ahj_form_templates WHERE ahj_name = ? AND form_type = ?", [ahj, formType])!.id;
const templateOf = (ahj: string, id: string) => loadStoredTemplates(db, ahj, "OR").find((t) => t.templateId === id)!;

try {
  const bcdBytes = fs.readFileSync(path.join(REPO, "backend/test/fixtures/bcd-5952-2024.pdf"));
  const coosBytes = fs.readFileSync(path.join(REPO, "backend/test/fixtures/coos-electrical.pdf"));
  const bcdUrl = "https://www.oregon.gov/bcd/Formslibrary/5952.pdf";
  const coosUrl = "https://co.coos.or.us/files/5bb0a81e5/electrical_permit.pdf";

  // THE OLD MAPS, as stored before the code maps moved on: the 5952's owner phone from the raw
  // snapshot, the department from project.ahj, no 10-pt sizes; the Coos County form without the
  // battery "200 amps or less" services line.
  const bcdNow = bcd5952Template(bcdBytes, bcdUrl)!;
  const bcdOld = {
    ...bcdNow,
    textFields: { ...bcdNow.textFields, "Phone number": "snapshot.homeownerPhone" },
    overlayFields: [{ ...bcdNow.overlayFields[0], source: "project.ahj" }],
    fieldFontSizes: undefined,
  };
  const coosNow = curatedFormMap(coosBytes, coosUrl)!.map;
  const coosOldText = { ...coosNow.textFields };
  delete coosOldText["200 AMPS QTY"];
  delete coosOldText["200 AMPS TOTAL"];
  const coosOld = { ...coosNow, textFields: coosOldText };
  assert.ok(coosNow.textFields["200 AMPS QTY"], "fixture sanity: the current Coos County map carries the services line");

  // Stored through the ONE store (storeAhjFormTemplate stamps sourceHash from the bytes, verified:false).
  storeAhjFormTemplate(db, { ahjName: "Fixture Town", state: "OR", formType: "solar_checklist", filename: "Oregon BCD 5952.pdf", bytes: bcdBytes, applicationKind: "prescriptive", map: bcdOld as never });
  storeAhjFormTemplate(db, { ahjName: "Coos Bay", state: "OR", formType: "electrical_application", filename: "Coos County Electrical Permit Application.pdf", bytes: coosBytes, map: coosOld as never });
  // The same Coos County PDF, harvested under an authority that does NOT hold that seed.
  storeAhjFormTemplate(db, { ahjName: "Fixture Town", state: "OR", formType: "electrical_application", filename: "Electrical Permit Application.pdf", bytes: coosBytes, map: coosOld as never });
  // A different blank (one byte-run appended): another hash, so no code map is its map.
  storeAhjFormTemplate(db, { ahjName: "Other Town", state: "OR", formType: "solar_checklist", filename: "Oregon BCD 5952.pdf", bytes: Buffer.concat([bcdBytes, Buffer.from("\n% revised\n")]), applicationKind: "prescriptive", map: bcdOld as never });

  const bcdId = rowId("Fixture Town", "solar_checklist");
  const coosId = rowId("Coos Bay", "electrical_application");
  const strangerId = rowId("Fixture Town", "electrical_application");
  const otherHashId = rowId("Other Town", "solar_checklist");

  await check("MUST-PASS: an unverified 5952 row reads the CURRENT code map (phone source, department, 10-pt sizes) and writes nothing", () => {
    const before = fieldMapOf(bcdId);
    const t = templateOf("Fixture Town", bcdId);
    assert.equal(t.builtInMap, true);
    assert.equal(t.verified, false);
    assert.equal(t.def.textFields?.["Phone number"], "computed.homeownerPhone");
    assert.equal(t.def.overlayFields?.[0]?.source, "computed.buildingDepartment");
    assert.equal(t.def.fieldFontSizes?.["Phone number"], 10);
    assert.equal(t.applicationKind, "prescriptive", "the stored application kind is kept");
    assert.equal(fieldMapOf(bcdId), before, "a read writes nothing");
    assert.match(before, /snapshot\.homeownerPhone/, "the row itself still holds its old copy");
  });

  await check("MUST-PASS: the Coos County row reads the current map, battery services line included", () => {
    const t = templateOf("Coos Bay", coosId);
    assert.equal(t.builtInMap, true);
    assert.equal(t.def.textFields?.["200 AMPS QTY"], "computed.servicesFeeders200Qty");
    assert.equal(t.def.textFields?.["200 AMPS TOTAL"], "computed.servicesFeeders200Total");
  });

  await check("MUST-EXCLUDE: the Coos County PDF stored under another authority keeps its stored map", () => {
    const t = templateOf("Fixture Town", strangerId);
    assert.equal(t.builtInMap, false);
    assert.equal(t.def.textFields?.["200 AMPS QTY"], undefined);
  });

  await check("MUST-EXCLUDE: a blank with another hash keeps its stored map", () => {
    const t = templateOf("Other Town", otherHashId);
    assert.equal(t.builtInMap, false);
    assert.equal(t.def.textFields?.["Phone number"], "snapshot.homeownerPhone");
  });

  await check("MUST-PASS: the submit gate does not ask to verify a built-in map; an automatically derived one still asks", async () => {
    // An automatically derived map beside it (an AcroForm read), for the same AHJ.
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    doc.getForm().createTextField("Owner name").addToPage(page, { x: 50, y: 700, width: 200, height: 18 });
    storeAhjFormTemplate(db, { ahjName: "Coos Bay", state: "OR", formType: "permit_application", filename: "Coos Bay Solar Supplement.pdf", bytes: await doc.save(),
      map: { formName: "Coos Bay Solar Supplement", sourceUrl: "", fillMode: "acroform", textFields: { "Owner name": "project.homeownerName" }, checkboxes: {} } as never });
    const pid = repo.createProject(db, {
      owner: "Test Owner", street: "1 Test Way", city: "Coos Bay", state: "OR", zip: "97420", ahj: "City of Coos Bay",
      utility: "Test Electric", account: "ACCT-TEST", meter: "M-TEST", dcKw: "6.6", acKw: "5.0",
    } as never).project.id;
    const gate = repo.getSubmitGateReport(db, pid).checks.find((c) => c.id === "ahj-form-mapping-verified")!;
    const evidence = gate.evidence.join(" | ");
    assert.equal(gate.status, "warning");
    assert.match(evidence, /Unverified mapping: Coos Bay Solar Supplement/);
    assert.doesNotMatch(evidence, /Coos County Electrical/, `a built-in map is not asked for verification: ${evidence}`);
    assert.doesNotMatch(gate.requirement, /AI-derived/);
  });

  await check("MUST-EXCLUDE: a VERIFIED row keeps exactly its stored map, even an outdated one (hard rule 3)", () => {
    // A row a person verified BEFORE this fix: the old route wrote verified onto the stored copy
    // as-is (the one raw write — the fixed route can no longer produce a verified outdated copy).
    const legacy = JSON.parse(fieldMapOf(coosId));
    db.run("UPDATE ahj_form_templates SET field_map = ? WHERE id = ?", [JSON.stringify({ ...legacy, verified: true, verifiedAt: "2026-09-01T00:00:00Z" }), coosId]);
    const t = templateOf("Coos Bay", coosId);
    assert.equal(t.verified, true);
    assert.equal(t.builtInMap, false);
    assert.equal(t.def.textFields?.["200 AMPS QTY"], undefined, "a verified row is never swapped for the code map");
    // Put it back to unverified through the real route's function (un-verify keeps the row's own map).
    assert.equal(setStoredTemplateVerified(db, coosId, false), true);
    assert.equal(templateOf("Coos Bay", coosId).builtInMap, true);
  });

  await check("MUST-PASS: a person's verify records the map they previewed — and the verified 5952 still draws its answers", async () => {
    assert.equal(setStoredTemplateVerified(db, bcdId, true), true);
    const saved = JSON.parse(fieldMapOf(bcdId));
    assert.equal(saved.verified, true);
    assert.equal(saved.textFields["Phone number"], "computed.homeownerPhone", "the current map (what the fill used) is what was verified");
    assert.equal(saved.fieldFontSizes["Phone number"], 10);
    const t = templateOf("Fixture Town", bcdId);
    assert.equal(t.verified, true);
    assert.equal(t.def.recoverPrescriptiveCheckboxes, true, "verifying a 5952 does not switch off its answer recovery");
    const snapshot = { snow: 20, wind: "C", deadLoad: 2, lightFrame: "yes", moduleMake: "Example", moduleModel: "Model A" };
    const project = { id: "fixture", homeownerName: "Test Owner", ahj: "Fixture Town", city: "Fixture", state: "OR", zip: "97000", projectAddress: "1 Test Way", parserSnapshot: snapshot };
    const out = path.join(tmpDir, "verified-5952.pdf");
    await fillLoadedForm(t.def, t.bytes, { project, client: {}, snapshot } as never, out);
    const marks = (await extractLabels(fs.readFileSync(out))).filter((i) => i.str === "X").length;
    assert.ok(marks >= 5, `the verified 5952 still draws the evidenced answers (got ${marks} X marks)`);
    assert.equal(setStoredTemplateVerified(db, "no-such-row", true), false);
  });

  await check("MUST-EXCLUDE: on a VERIFIED 5952 map, recovery adds the answer marks but repairs nothing a person confirmed", async () => {
    // A person's verified map with choices the unverified-map repairs would rewrite: the City box from
    // project.state, a literal listing agency, and a square filled with a word.
    const snapshot = { snow: 20, wind: "C", deadLoad: 2, lightFrame: "yes", framingType: "truss", roofRafterSpacing: 24 };
    const project = { id: "fixture", homeownerName: "Test Owner", ahj: "Fixture Town", city: "Fixture", state: "OR", zip: "97000", projectAddress: "1 Test Way", parserSnapshot: snapshot };
    const truss = "Preengineered trusses are spaced less than or equal to 24 inches on center oc or";
    const def = { id: "bcd-verified", formName: "BCD 5952", matchJurisdictions: [], sourceUrl: "", version: "stored", status: "verified",
      fillMode: "acroform", recoverPrescriptiveCheckboxes: true, unverifiedMap: false,
      textFields: { "State  Oregon": "project.state", "Listing agency": "lit:UL", [truss]: "lit:Y" } } as never;
    const out = path.join(tmpDir, "verified-map.pdf");
    const result = await fillLoadedForm(def, bcdBytes, { project, client: {}, snapshot } as never, out);
    const text = (await extractLabels(fs.readFileSync(out))).map((i) => i.str);
    assert.ok(text.includes("UL"), "the verified literal listing agency is kept");
    assert.ok(text.includes("OR") && !text.includes("Fixture"), "the verified City-box source is not re-sourced");
    assert.ok(text.includes("Y"), "the square the verified map fills is filled as written");
    assert.ok(!(result.unmappedRequested ?? []).includes(truss), "a verified map's own square is not dropped");
    assert.ok(text.filter((s) => s === "X").length >= 5, "the answers are still recovered");
  });

  console.log(`\nbuiltInFormMap: all ${passed} checks passed`);
} finally {
  db.close();
  assert.equal(path.dirname(path.resolve(tmpDir)), path.resolve(os.tmpdir()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
