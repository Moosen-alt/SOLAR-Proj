import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {PDFDocument} from "pdf-lib";
import {CURATED_AHJ_FORMS, curatedFormSource, curatedFormMap} from "../src/curatedAhjForms";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "curated-forms-"));
process.env.AUTOPILOT_DB_PATH = path.join(temp, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
const {openDatabase} = await import("../src/db");
const {acquireFromBytes, ensureAhjFormTemplate, ensureAhjFormsForProject} = await import("../src/ahjFormAuto");
const {loadStoredTemplates, fillLoadedForm} = await import("../src/ahjForms");
const {extractLabels} = await import("../src/formTextLayer");
const db = await openDatabase();
const llm = new Proxy({}, {get(){throw new Error("Known public forms must not call a model");}}) as never;
try {
  for (const [index, filename] of ["tigard-building.pdf", "tigard-electrical.pdf", "coos-electrical.pdf"].entries()) {
    const source = CURATED_AHJ_FORMS[index];
    const bytes = fs.readFileSync(path.join("backend/test/fixtures", filename));
    assert.equal(curatedFormSource({ahj:`City of ${source.ahj}`, state:"OR"}, source.formType), source);
    assert.equal(curatedFormSource({ahj:source.ahj, state:"WA"}, source.formType), undefined);
    assert.equal(curatedFormMap(Buffer.concat([bytes,Buffer.from("revision")]), source.url), null);
    const input = {ahj:source.ahj, state:source.state, formType:"solar_checklist", formName:"Misclassified checklist", bytes, sourceUrl:source.url};
    assert.equal((await acquireFromBytes(db,llm,{...input,ahj:"Other City"})).status,"needs_manual");
    assert.equal((await acquireFromBytes(db,llm,input)).status,"acquired");
    const stored = loadStoredTemplates(db, source.ahj, source.state).find(t=>t.def.formName===source.formName)!;
    assert.ok(stored);
    if (filename === "tigard-electrical.pdf") assert.equal(stored.documentStale,true,"Printed old revision must display its age warning");
    const row = db.get<{field_map:string;form_type:string}>("SELECT field_map, form_type FROM ahj_form_templates WHERE id=?",[stored.templateId])!;
    assert.equal(row.form_type, source.formType, "Actual PDF determines its discipline");
    if (source.ahj === "coos bay") {
      const pdfFields = new Set((await PDFDocument.load(bytes)).getForm().getFields().map(f=>f.getName()));
      for (const key of [...Object.keys(stored.def.textFields), ...Object.keys(stored.def.checkboxes || {})]) assert.ok(pdfFields.has(key),key);
    }
    for (const owner of ["Fixture Alice", "Fixture Bob"]) {
      const output = path.join(temp,`${index}-${owner}.pdf`);
      const project = {homeownerName:owner, projectAddress:"12 Example Way",city:"Example",state:"OR",zip:"97000",systemSizeDcKw:8,systemSizeAcKw:7};
      const client = {installerCompanyName:"Fixture Installer",electricalLicenseNumber:"ELE123",electricianLicenseNumber:"SUP456",ccbLicenseNumber:"CCB789"};
      await fillLoadedForm(stored.def,bytes,{project,client,snapshot:{constructionCategory:'Single Family',jobValue:24000,buildingStories:2,parcelNumber:'TEST-PARCEL'}} as never,output);
      const result = fs.readFileSync(output);
      const filledDoc = await PDFDocument.load(result);
      const widgetText = filledDoc.getForm().getFields().filter(f=>'getText' in f).map(f=>(f as any).getText()).join(' ');
      const text = (await extractLabels(result)).map(i=>i.str).join(" ") + ' ' + widgetText;
      if (source.ahj === 'coos bay') assert.equal(filledDoc.getForm().getTextField('Name').getText(),owner,'Keep canonical AcroForm values editable for missing particulars');
      assert.ok(text.includes(owner),`${filename}: owner must fill`);
      assert.ok(!text.includes(owner==="Fixture Alice"?"Fixture Bob":"Fixture Alice"),"No cached customer data");
      assert.ok(text.includes("Fixture Installer"));
      if (source.formType === 'building_application') {
        const positions=await extractLabels(result);
        assert.ok(positions.some(l=>l.str==='24000'&&l.page===2&&l.y>599&&l.y<604&&l.x>480),'Declared valuation belongs on the valuation rule, not instruction text');
        assert.ok(positions.some(l=>l.str==='TEST-PARCEL'&&l.page===2&&l.y>423&&l.y<428),'Parcel belongs on tax/parcel rule');
      }
      if (source.formType === "electrical_application") assert.ok(text.includes("ELE123"),"Use existing client license keys");
      assert.equal((await PDFDocument.load(result)).getPageCount(),(await PDFDocument.load(bytes)).getPageCount());
    }
    const verified = JSON.stringify({...JSON.parse(row.field_map),verified:true});
    db.run("UPDATE ahj_form_templates SET field_map=? WHERE id=?",[verified,stored.templateId]);
    assert.equal((await acquireFromBytes(db,llm,input)).status,"exists");
    assert.equal(db.get<{field_map:string}>("SELECT field_map FROM ahj_form_templates WHERE id=?",[stored.templateId])!.field_map,verified);
  }
  assert.equal((await ensureAhjFormTemplate(db,llm,{ahj:"Unknown City",state:"OR"} as never,"electrical_application",{allowResearch:false})).status,"not_found");
  // Exercise the production acquisition entry point with exact public PDF fixtures,
  // no model, no network. Changed bytes must not inherit a trusted coordinate map.
  db.run("DELETE FROM ahj_form_templates",[]);
  const realFetch = globalThis.fetch;
  const project = {ahj:"City of Tigard",state:"OR",parserSnapshot:{permitPathOverride:"prescriptive"}} as never;
  let calls = 0;
  try {
    globalThis.fetch = async () => new Response(fs.readFileSync("backend/test/fixtures/tigard-electrical.pdf"),{headers:{"Content-Type":"application/pdf"}});
    assert.equal((await ensureAhjFormTemplate(db,llm,project,"building_application",{allowResearch:false})).status,"needs_manual","A different known PDF is not the requested revision");
    globalThis.fetch = async (url) => {
      calls++;
      const filename = String(url).includes("/42/") ? "tigard-building.pdf" : String(url).includes("/44/") ? "tigard-electrical.pdf" : String(url).endsWith("/5952.pdf") ? "bcd-5952-2024.pdf" : "";
      assert.ok(filename,`Unexpected download ${String(url)}`);
      return new Response(fs.readFileSync(path.join("backend/test/fixtures",filename)),{headers:{"Content-Type":"application/pdf"}});
    };
    const result = await ensureAhjFormsForProject(db,llm,project,{allowResearch:false});
    assert.deepEqual(new Set(result.neededTypes),new Set(["building_application","electrical_application","solar_checklist"]));
    assert.ok(result.results.every(r=>r.status==="acquired"),JSON.stringify(result));
    assert.equal(calls,3);
    assert.ok((await ensureAhjFormsForProject(db,llm,project,{allowResearch:false})).results.every(r=>r.status==="exists"));
    assert.equal(calls,3,"Stored forms must not download or research again");
  } finally { globalThis.fetch = realFetch; }
  console.log("curatedAhjForms: exact revisions, jurisdiction, actual discipline, dynamic owner/license fill, page preservation, verified protection and offline fallback passed");
} finally {
  db.close();
  assert.equal(path.dirname(temp),os.tmpdir());
  fs.rmSync(temp,{recursive:true,force:true});
}
