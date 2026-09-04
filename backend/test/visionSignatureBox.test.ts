// A VISION-MAPPED SIGNATURE LANDED A FULL BOX BELOW ITS OWN LINE.
//
// The vision prompt asks the model for the BOTTOM-LEFT corner of the signature area, in
// coordinates normalized from the top of the page. Flipping that — (1 - ny) * pageHeight —
// already yields the box's bottom in PDF space, which is what pdf-lib anchors an image on.
//
// The conversion subtracted the box height as well, on the stated reasoning that this made
// the image "sit just above the printed line". Subtracting moves ink DOWN. Every vision-mapped
// signature therefore landed a full box-height BELOW its rule: with the default heightFrac of
// 0.04 on US Letter that is 32pt of ink hanging under the line, across roughly two rows on a
// form whose rules sit 9-20pt apart.
//
// It survived because the one form anyone had inspected closely — Portland's electrical
// application — is hand-tuned in the registry and never passes through this conversion. Every
// AHJ we learn automatically did.
//
// Browser-free. Run: tsx backend/test/visionSignatureBox.test.ts
import assert from "node:assert/strict";
import { MAX_SIGNATURE_BOX_PT, MIN_SIGNATURE_BOX_PT, visionSignatureBox } from "../src/ahjFormAuto";

const LETTER_H = 792;

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

check("THE REGRESSION: the box bottom is the flipped ny, with nothing subtracted", () => {
  // A signature line 25% down the page: ny = 0.25 -> PDF y = 0.75 * 792 = 594.
  const box = visionSignatureBox(0.25, 0.02, LETTER_H);
  assert.equal(box.y, 594, "subtracting the height again would put this at 578");
});

check("...so the ink sits ABOVE the rule, where a pen would leave it", () => {
  // pdf-lib draws upward from y, and drawSignatures adds a small lift inside the box.
  // Ink therefore occupies [y, y + height] — entirely above the reported line.
  const box = visionSignatureBox(0.5, 0.02, LETTER_H);
  const inkBottom = box.y;
  const inkTop = box.y + box.height;
  assert.ok(inkBottom >= 396 - 1 && inkTop > inkBottom, `ink ${inkBottom}..${inkTop} should start at the line`);
});

check("a line near the page bottom stays on the page", () => {
  const box = visionSignatureBox(0.95, 0.02, LETTER_H);
  assert.ok(box.y >= 0 && box.y <= LETTER_H, `y=${box.y} is off the page`);
});

// ---------------------------------------------------------------------------
// The clamp. heightFrac defaults to 0.04 — 32pt on Letter, taller than any row.
// ---------------------------------------------------------------------------
check("THE CLAMP: the default heightFrac no longer exceeds a real signature row", () => {
  const box = visionSignatureBox(0.5, 0.04, LETTER_H);
  assert.ok(box.height <= MAX_SIGNATURE_BOX_PT, `height ${box.height} exceeds the ${MAX_SIGNATURE_BOX_PT}pt cap`);
});

check("an absurd heightFrac is clamped rather than trusted", () => {
  assert.equal(visionSignatureBox(0.5, 0.5, LETTER_H).height, MAX_SIGNATURE_BOX_PT);
});

check("a vanishing heightFrac still leaves something visible", () => {
  assert.equal(visionSignatureBox(0.5, 0.0001, LETTER_H).height, MIN_SIGNATURE_BOX_PT);
});

check("a missing/NaN heightFrac degrades to the minimum instead of NaN", () => {
  const box = visionSignatureBox(0.5, Number.NaN, LETTER_H);
  assert.ok(Number.isFinite(box.height) && box.height === MIN_SIGNATURE_BOX_PT);
  assert.ok(Number.isFinite(box.y), "a NaN height must not poison the y coordinate");
});

check("a modest heightFrac passes through untouched", () => {
  // 0.02 * 792 = 15.84 -> 16, comfortably inside the clamp and typical of a real row.
  assert.equal(visionSignatureBox(0.3, 0.02, LETTER_H).height, 16);
});

check("the cap is tighter than the registry's own sanity limit", () => {
  // signaturePlacement.test.ts refuses any registry box over 40pt; generated boxes are held
  // to a stricter bar, since nobody eyeballs them before they are used.
  assert.ok(MAX_SIGNATURE_BOX_PT < 40);
});

if (failures) { console.error(`\n${failures} vision-signature-box check(s) FAILED.`); process.exit(1); }
console.log("\nAll vision-signature-box checks passed.");
process.exit(0);
