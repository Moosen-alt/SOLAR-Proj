// Autopilot AHJ overlay fill: a vision-mapped (labeled) overlay field snaps to
// the form's real text-layer baseline (fixes "off a bit"); an UNLABELED field
// (hand-tuned registry style) draws at its exact stored x/y unchanged; a label
// that isn't found falls back to x/y. Guards the fillLoadedForm overlay path.
// Run: tsx backend/test/ahjFormFill.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { fillLoadedForm, type AhjFormDefinition, type OverlayField } from "../src/ahjForms";
import { extractLabels } from "../src/formTextLayer";

let passed = 0;
const ok = (n: string) => { passed++; console.log(`ok   ${n}`); };

// Minimal fill context: resolveSource("project.homeownerName") reads project.
const ctx: unknown = { project: { homeownerName: "Jane Doe" }, client: {}, snapshot: {} };

async function makeFlatPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Property owner name:", { x: 46, y: 594, size: 11, font });
  // Filler labels so hasTextLayer() (needs >= 8 items) passes.
  for (let i = 0; i < 9; i++) page.drawText(`Filler label ${i}:`, { x: 46, y: 500 - i * 14, size: 11, font });
  return doc.save();
}

const def = (overlayFields: OverlayField[]): AhjFormDefinition => ({
  id: "tmpl-test", formName: "Test refund", matchJurisdictions: [], sourceUrl: "",
  version: "stored", status: "verified", fillMode: "overlay", textFields: {}, overlayFields,
});

async function drawnY(outPath: string, value: string): Promise<number | null> {
  const items = await extractLabels(new Uint8Array(fs.readFileSync(outPath)));
  const it = items.find((i) => i.str.includes(value));
  return it ? it.y : null;
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ahjfill-"));
  const pdf = await makeFlatPdf();

  // 1) Labeled field → anchored to the label's real baseline (594), NOT the
  //    deliberately-wrong stored y (700). This is the "off a bit" fix.
  const outA = path.join(dir, "a.pdf");
  await fillLoadedForm(def([{ source: "project.homeownerName", page: 0, x: 300, y: 700, label: "Property owner name:" }]), pdf, ctx as never, outA);
  const yA = await drawnY(outA, "Jane Doe");
  assert.ok(yA !== null && Math.abs(yA - 594) < 3, `labeled should anchor to ~594, got ${yA}`);
  ok("labeled overlay field anchors to the label's real baseline");

  // 2) UNLABELED field (hand-tuned registry style) → exact stored y (500),
  //    untouched. Proves hand-tuned forms are unaffected.
  const outB = path.join(dir, "b.pdf");
  await fillLoadedForm(def([{ source: "project.homeownerName", page: 0, x: 120, y: 500 }]), pdf, ctx as never, outB);
  const yB = await drawnY(outB, "Jane Doe");
  assert.ok(yB !== null && Math.abs(yB - 500) < 3, `no-label should stay at 500, got ${yB}`);
  ok("unlabeled field draws at exact stored y (hand-tuned unaffected)");

  // 3) Label present but not on the form → fall back to stored y (480).
  const outC = path.join(dir, "c.pdf");
  await fillLoadedForm(def([{ source: "project.homeownerName", page: 0, x: 120, y: 480, label: "Nonexistent Field:" }]), pdf, ctx as never, outC);
  const yC = await drawnY(outC, "Jane Doe");
  assert.ok(yC !== null && Math.abs(yC - 480) < 3, `label-not-found should fall back to 480, got ${yC}`);
  ok("label-not-found falls back to stored x/y");

  // 4) THE VALUATION DEFAULT (operator ruling 2026-09-21: the formula fills the
  //    valuation field on EVERY AHJ form, mapped or not). AcroForm with three
  //    fields: an UNMAPPED job-value field (fills from the formula), a mapped
  //    field bound to computed.declaredValuation (now the FORMULA, not the raw
  //    contract), and "Valuation Date" (the tight name match must skip it).
  const valuationDoc = await PDFDocument.create();
  valuationDoc.addPage([612, 792]);
  const acro = valuationDoc.getForm();
  acro.createTextField("Estimated Job Value including materials and labor").addToPage(valuationDoc.getPage(0), { x: 60, y: 700, width: 120, height: 16 });
  acro.createTextField("Mapped Valuation").addToPage(valuationDoc.getPage(0), { x: 60, y: 660, width: 120, height: 16 });
  acro.createTextField("Valuation Date").addToPage(valuationDoc.getPage(0), { x: 60, y: 620, width: 120, height: 16 });
  const valuationPdf = await valuationDoc.save();
  const valuationCtx: unknown = { project: { homeownerName: "Jane Doe", systemSizeDcKw: 7.04 }, client: {}, snapshot: { jobValue: "29066.02" } };
  const valuationDef: AhjFormDefinition = {
    id: "tmpl-valuation", formName: "Valuation default test", matchJurisdictions: [], sourceUrl: "",
    version: "stored", status: "verified", fillMode: "acroform", preserveInteractive: true,
    textFields: { "Mapped Valuation": "computed.declaredValuation" },
  };
  const outD = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ahjfill-val-")), "d.pdf");
  await fillLoadedForm(valuationDef, valuationPdf, valuationCtx as never, outD);
  const outDoc = await PDFDocument.load(fs.readFileSync(outD));
  const outForm = outDoc.getForm();
  const text = (n: string) => outForm.getTextField(n).getText() ?? "";
  // 40% of $29,066.02 = $11,626 (rounded) — the operator formula, both lanes.
  assert.equal(text("Estimated Job Value including materials and labor"), "11626", "unmapped valuation field must fill from the formula");
  ok("MUST PASS: an UNMAPPED job-value field fills from the operator formula by default");
  assert.equal(text("Mapped Valuation"), "11626", "declaredValuation must now be the formula, not the raw contract");
  ok("computed.declaredValuation is the FORMULA (11626), never the raw contract (29066)");
  assert.equal(text("Valuation Date"), "", "'Valuation Date' must never catch the default");
  ok("MUST EXCLUDE: 'Valuation Date' stays empty — the name match is tight");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nahjFormFill: all ${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
