import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { fillLoadedForm, loadStoredTemplates, type AhjFormDefinition, type FillContext } from "../src/ahjForms";
import { checkboxPlacement, extractLabels } from "../src/formTextLayer";
import { recoverBcd5952Checklist } from "../src/prescriptiveChecklist";

const bytes = fs.readFileSync("backend/test/fixtures/bcd-5952-2024.pdf");
const items = await extractLabels(bytes);
const recovered = recoverBcd5952Checklist(await PDFDocument.load(bytes), items);
assert.equal(recovered.recognized, true);
assert.equal(recovered.overlays.length, 8, "four independent rows, two possible answers each");
assert.equal(checkboxPlacement(items, { page: 0, anchor: "Yes" }), null, "ambiguous page-wide anchor must refuse");
const changed = items.map((i) => ({ ...i, str: i.str.replace("70 pounds", "50 pounds") }));
assert.equal(recoverBcd5952Checklist(await PDFDocument.load(bytes), changed).overlays.length, 6,
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
    assert.equal(marks.length, expected.filter(Boolean).length, name);
    expected.forEach((answer, row) => {
      const pair = recovered.overlays.slice(row * 2, row * 2 + 2);
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
  assert.equal(flatMarks.length, 4, "a truly flat blank also recovers all four supported answers");
  for (const mark of flatMarks) {
    assert.ok(recovered.overlays.some((f) => f.source.endsWith("Yes") && Math.abs(mark.x - f.x) < 1.5 && Math.abs(mark.y - f.y) < 1.5),
      "flat fallback must land inside the same row's Yes box");
  }
  await fillLoadedForm(verified, bytes, ctx(passing), path.join(dir, "verified.pdf"));
  const verifiedText = await extractLabels(fs.readFileSync(path.join(dir, "verified.pdf")));
  assert.equal(verifiedText.filter((i) => i.str === "X").length, 0, "verified map stays unchanged");
  for (const isVerified of [false, true]) {
    const fakeDb = { query: () => [{ id: "fixture", ahj_name: "Tigard", state: "OR", pdf_blob: bytes,
      field_map: JSON.stringify({ ...def, verified: isVerified }), original_filename: "5952.pdf" }] };
    assert.equal(loadStoredTemplates(fakeDb as never, "Tigard", "OR")[0].def.recoverPrescriptiveCheckboxes, !isVerified);
  }
  console.log(`prescriptiveChecklist: all ${checks} answer cases, geometry, changed-threshold, and verified-map checks passed`);
} finally {
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  fs.rmSync(dir, { recursive: true, force: true });
}
