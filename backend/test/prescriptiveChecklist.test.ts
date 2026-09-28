import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { fillLoadedForm, loadStoredTemplates, type AhjFormDefinition, type FillContext } from "../src/ahjForms";
import { checkboxPlacement, extractLabels } from "../src/formTextLayer";
import { recoverBcd5952Checklist } from "../src/prescriptiveChecklist";
import { bcdChecklistAnswers } from "../src/bcdChecklistFacts";
import { supplementStructuralIntake, planTextForExtraction } from "../src/structuralIntake";

const bytes = fs.readFileSync("backend/test/fixtures/bcd-5952-2024.pdf");
const items = await extractLabels(bytes);
const recovered = recoverBcd5952Checklist(await PDFDocument.load(bytes), items);
assert.equal(recovered.recognized, true);
assert.equal(recovered.overlays.length, 22, "nine independent rows plus four subchoices");
assert.equal(checkboxPlacement(items, { page: 0, anchor: "Yes" }), null, "ambiguous page-wide anchor must refuse");
const changed = items.map((i) => ({ ...i, str: i.str.replace("70 pounds", "50 pounds") }));
assert.equal(recoverBcd5952Checklist(await PDFDocument.load(bytes), changed).overlays.length, 20,
  "a different printed snow threshold cannot inherit the old answer");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bcd-checklist-"));
const rafter = "Rafters are spaced less than or equal to 24 inches oc and framing complies with R32441 Exception 14";
const def: AhjFormDefinition = {
  id: "bcd-test", formName: "BCD 5952", matchJurisdictions: [], sourceUrl: "", version: "stored",
  status: "verified", fillMode: "acroform", recoverPrescriptiveCheckboxes: true,
  textFields: { "State  Oregon": "project.state", "Installation address": "project.projectAddress",
    [rafter]: "computed.prescRafterSpacingAnswer", "Listing agency": "lit:UL" },
};
const passing = { snow: 20, wind: "C", lightFrame: "yes", deadLoad: 2.42, roofRafterSpacing: 24 };
const ctx = (snapshot: Record<string, unknown>): FillContext => ({
  project: { parserSnapshot: snapshot, city: "Tigard", state: "OR", zip: "97223", projectAddress: "1 Test Lane, Tigard, OR, 97223" } as never,
  client: {}, snapshot,
  // Stale cached evaluation and AHJ limits must not override this printed form.
  prescriptive: [{ key: "snowLoad", answer: "No", label: "cached", detail: "" }],
  prescriptiveLimits: { maxGroundSnowPsf: 10 },
});
let checks = 0;
try {
  const parsed = supplementStructuralIntake({ provider: "stub", fields: {}, lowConfidenceFields: [], notes: "" },
    '2" X 4" TRUSS @ 24" O.C. PANELS WILL NOT MOUNT HIGHER THAN 12 INCHES ABOVE THE SURFACE OF THE ROOF. '
    + 'SOLAR PANELS ARE TO BE MOUNTED TO THE ROOFFRAMING. NEW PV ATTACHMENTS AT 4\'-0" O.C. '
    + 'ROOF ATTACHMENTS SHALL BE SPACED NOGREATER THAN 24 IN. OC IN ANY DIRECTIONWHERE LOCATED WITHIN 3FT. OF A ROOFEDGE, HIP, EAVE OR RIDGE.');
  assert.equal(parsed.fields.framingType.value, "truss");
  assert.equal(parsed.fields.attachmentSpacingIn.value, 48);
  assert.equal(parsed.fields.attachmentEdgeSpacingIn.value, 24);
  assert.equal(parsed.fields.moduleHeightAboveRoof.value, 12);
  assert.equal(parsed.fields.roofLayers, undefined, "a roof material/diagram cannot invent layers");
  const wrongMetal = { provider: "stub", fields: { roofMaterial: { value: "Metal", confidence: 0.8 } }, lowConfidenceFields: [], notes: "" };
  assert.equal(supplementStructuralIntake(wrongMetal,
    "ROOF MATERIAL:COMPOSITE SHINGLE. Metal rail and roof hook.").fields.roofMaterial.value, "Composition Shingle");
  assert.equal(supplementStructuralIntake({ ...wrongMetal, fields: {} },
    "ROOF MATERIAL:COMPOSITE SHINGLE. ROOF MATERIAL:METAL.").fields.roofMaterial, undefined, "conflicting explicit materials require review");
  assert.ok(parsed.fields.framingType.evidence?.excerpt.includes("TRUSS"));
  assert.equal(planTextForExtraction("a".repeat(25000) + "later structural notes").endsWith("later structural notes"), true);
  const complete = { ...passing, ...Object.fromEntries(Object.entries(parsed.fields).map(([k, v]) => [k, v.value])),
    windSpeed: 110, gravityWindDesign: "yes", manufacturerInstallation: "yes", roofMaterial: "composition shingles",
    roofLayers: 2, moduleFiguresCompliant: "yes" };
  const answers = (s: Record<string, unknown>) => bcdChecklistAnswers(ctx(s).project);
  assert.equal(answers(complete).attachments, "Yes", "48 in away from edges + 24 in at edges is supported");
  assert.equal(answers({ ...complete, moduleFiguresCompliant: "" }).heightFigures, "Yes", "an unknown figure-compliance fact is assumed Yes (operator ruling 2026-09-27), never a blank row");
  assert.equal(answers({ ...complete, moduleFiguresCompliant: "no" }).heightFigures, "No", "an explicit No still answers No");
  assert.equal(answers({ ...complete, moduleHeightAboveRoof: 20 }).heightFigures, "No", "a stated height over 18 in still answers No");
  assert.equal(answers({ ...complete, roofLayers: "" }).roofing, "");
  assert.equal(answers({ ...complete, roofLayers: 3 }).roofing, "No");
  assert.notEqual(answers({ ...complete, windSpeed: 111 }).attachments, "Yes", "C exposure attachment cap is 110, not generic 120");
  assert.equal(answers({ ...complete, framingType: "rafter", rafterExceptionCompliant: "" }).framing, "");
  const allOut = path.join(dir, "all-nine.pdf");
  await fillLoadedForm(def, bytes, ctx(complete), allOut);
  const allMarks = (await extractLabels(fs.readFileSync(allOut))).filter(i => i.str === "X");
  assert.equal(allMarks.length, 11, "all nine answers plus truss and Method 1 selections render independently");
  for (const row of recovered.overlays.filter(f => f.source.endsWith("Yes") && !/bcd(Truss|Rafter|Method)/.test(f.source))) {
    assert.ok(allMarks.some(i => i.page === row.page && Math.abs(i.x-row.x)<1 && Math.abs(i.y-row.y)<1), row.source);
  }
  for (const [name, snapshot, expected] of [
    ["yes", passing, ["Yes", "Yes", "Yes", "Yes"]],
    ["no", { snow: 80, wind: "D", lightFrame: "no", deadLoad: 6 }, ["No", "No", "No", "No"]],
    ["mixed", { snow: 20, wind: "D", deadLoad: 2 }, ["Yes", "No", "", "Yes"]],
    ["unknown", {}, ["", "", "", ""]],
  ] as const) {
    const out = path.join(dir, `${name}.pdf`);
    const result = await fillLoadedForm(def, bytes, ctx(snapshot), out);
    assert.equal(result.formName, "Oregon BCD 5952 - Prescriptive Solar PV Installation Checklist");
    const filled = await PDFDocument.load(fs.readFileSync(out));
    assert.equal(filled.getForm().getFields().length, 0, "production output remains flattened");
    const text = await extractLabels(fs.readFileSync(out));
    const marks = text.filter((i) => i.str === "X");
    // +1: the module-height row is assumed Yes whenever nothing states otherwise (operator ruling 2026-09-27).
    assert.equal(marks.length, expected.filter(Boolean).length + 1, `${name} (incl. the assumed-Yes height row)`);
    expected.forEach((answer, row) => {
      const simple = recovered.overlays.filter(f => f.source.startsWith("computed.presc"));
      const pair = simple.slice(row * 2, row * 2 + 2);
      const actual = marks.filter((i) => i.page === pair[0].page && Math.abs(i.y - pair[0].y) < 1);
      assert.equal(actual.length, answer ? 1 : 0, `${name}: row ${row}`);
      if (answer) assert.ok(Math.abs(actual[0].x - pair[answer === "Yes" ? 0 : 1].x) < 1);
    });
    assert.ok(text.some((i) => i.str === "Tigard"), "City contains the city, not OR");
    assert.ok(text.some((i) => i.str === "1 Test Lane"), "street field excludes duplicated city/state/zip");
    assert.ok(!text.some((i) => i.str === "UL"), "listing agency must not be guessed");
    assert.ok(result.unmappedRequested?.includes(rafter), "compound framing requirement remains for a human");
    checks++;
  }
  const verified = { ...def, recoverPrescriptiveCheckboxes: false };
  const flat = await PDFDocument.load(bytes);
  flat.getForm().flatten();
  await fillLoadedForm({ ...def, fillMode: "overlay", textFields: {}, overlayFields: [] }, await flat.save(), ctx(passing), path.join(dir, "flat.pdf"));
  const flatMarks = (await extractLabels(fs.readFileSync(path.join(dir, "flat.pdf")))).filter((i) => i.str === "X");
  // 5 = the four supported answers + the module-height row, assumed Yes (operator ruling 2026-09-27).
  assert.equal(flatMarks.length, 5, "a truly flat blank also recovers all four supported answers plus the assumed-Yes height row");
  for (const mark of flatMarks) {
    assert.ok(recovered.overlays.some((f) => f.source.endsWith("Yes") && Math.abs(mark.x - f.x) < 1.5 && Math.abs(mark.y - f.y) < 1.5),
      "flat fallback must land inside the same row's Yes box");
  }
  await fillLoadedForm(verified, bytes, ctx(passing), path.join(dir, "verified.pdf"));
  const verifiedText = await extractLabels(fs.readFileSync(path.join(dir, "verified.pdf")));
  assert.equal(verifiedText.filter((i) => i.str === "X").length, 0, "a definition with recovery OFF (registry forms) draws no answers — the fill honours the flag");
  // B6 (dry-run 2026-09-28): marking a stored 5952 VERIFIED no longer switches its answer recovery off
  // — recovery only adds rows the map does not answer, so a verified map keeps every mapped field.
  for (const isVerified of [false, true]) {
    const fakeDb = { query: () => [{ id: "fixture", ahj_name: "Tigard", state: "OR", pdf_blob: bytes,
      field_map: JSON.stringify({ ...def, verified: isVerified }), original_filename: "5952.pdf" }] };
    assert.equal(loadStoredTemplates(fakeDb as never, "Tigard", "OR")[0].def.recoverPrescriptiveCheckboxes, true,
      `a ${isVerified ? "verified" : "unverified"} stored 5952 still recovers its answers`);
  }
  console.log(`prescriptiveChecklist: all ${checks} answer cases, geometry, changed-threshold, and verified-map checks passed`);
} finally {
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  fs.rmSync(dir, { recursive: true, force: true });
}
