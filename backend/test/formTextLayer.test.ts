// Text-layer anchoring: extract labels from a PDF's text layer, resolve a value's
// placement to a label's real baseline (fixes vision float), and auto-place a data
// bag by matching field synonyms to labels. Uses a synthetic PDF with known label
// positions. Run: tsx backend/test/formTextLayer.test.ts
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractLabels, hasTextLayer, findLabel, anchorPlacement, autoPlaceFromData, sideForLabel } from "../src/formTextLayer";

let passed = 0;
const ok = (n: string) => { passed++; console.log(`ok   ${n}`); };

// Draw labels at known baselines so we can assert anchoring lands on them.
async function makeLabeledPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const draw = (s: string, x: number, y: number) => page.drawText(s, { x, y, size: 11, font });
  draw("Property owner name:", 46, 594);
  draw("Installation address:", 46, 574);
  draw("City:", 46, 555);
  draw("State:", 300, 555);
  draw("ZIP:", 400, 555);
  draw("Phone number:", 406, 594);
  draw("Email address:", 46, 479);
  draw("BCD license #:", 46, 460);
  draw("CCB license #:", 406, 460);
  return doc.save();
}

async function main(): Promise<void> {
  const bytes = await makeLabeledPdf();
  const items = await extractLabels(bytes);

  assert.ok(items.length >= 6, `expected labels, got ${items.length}`);
  assert.equal(hasTextLayer(items), true);
  ok("extractLabels reads the text layer");

  const owner = findLabel(items, "Property owner name:", 0);
  assert.ok(owner, "should find the owner label");
  assert.ok(Math.abs(owner!.y - 594) < 2, `owner baseline ~594, got ${owner!.y}`);
  ok("findLabel locates a label at its real baseline");

  // Anchor: value sits to the RIGHT of the label, on the SAME baseline (no float).
  const p = anchorPlacement(items, { page: 0, label: "Property owner name:", side: "right" });
  assert.ok(p, "should anchor");
  assert.ok(Math.abs(p!.y - 594) < 2, `value baseline must equal the label's (~594), got ${p!.y}`);
  assert.ok(p!.x > 46, `value must be right of the label's left edge, got ${p!.x}`);
  ok("anchorPlacement puts the value on the label baseline, to its right");

  // A wrong/absent label anchors to nothing rather than guessing.
  assert.equal(anchorPlacement(items, { page: 0, label: "Nonexistent field:", side: "right" }), null);
  ok("anchorPlacement returns null for an unknown label");

  // Auto-place a data bag: each key matches its label via synonyms and lands on it.
  const placements = autoPlaceFromData(items, {
    name: "Katie Tully", street: "1801 35th St", city: "Bellingham", state: "WA", zip: "98229", phone: "360-555-0100",
  });
  const byKey = Object.fromEntries(placements.map((p2) => [p2.key, p2]));
  assert.ok(byKey.name && Math.abs(byKey.name.y - 594) < 2, "name anchors to owner label baseline");
  assert.ok(byKey.city && Math.abs(byKey.city.y - 555) < 2, "city anchors to city row");
  assert.ok(byKey.state && byKey.state.x > 300, "state anchors to the State: label (right side of row)");
  assert.equal(byKey.name.text, "Katie Tully");
  ok("autoPlaceFromData matches synonyms and anchors each value");

  // Caption-vs-inline: "LABEL:" takes value to the right; a bare caption takes it
  // ABOVE (on the line over the caption, e.g. Jackson County's "Print Name").
  assert.equal(sideForLabel("PROPERTY ADDRESS:"), "right");
  assert.equal(sideForLabel("PERMIT #"), "right");
  assert.equal(sideForLabel("Print Name"), "above");
  ok("sideForLabel picks right for LABEL:/# and above for a caption");

  const above = anchorPlacement(items, { page: 0, label: "City:", side: "above" });
  const cityLbl = findLabel(items, "City:", 0)!;
  assert.ok(above && above.y > cityLbl.y, "above-placement sits on the line above the caption");
  ok("anchorPlacement 'above' draws over the caption");

  console.log(`\nformTextLayer: all ${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
