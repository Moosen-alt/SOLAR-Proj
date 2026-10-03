// FLAT FORMS: A CHOICE MARK ON A LABEL THAT CARRIES ITS OWN BLANKS (issue #55).
//
// Owner's Los Lunas run, 2026-10-03 (Valencia County Permit Application, unverified map): two marks
// were withheld with "no checkbox found for the mark":
//  - "RESIDENTIAL ____ / COMMERCIAL ____": ONE label naming two options, each ticked on the blank
//    after it. The mark path resolved no single caption, so it found neither blank.
//  - "BP/DP(50.00)": a fee-line choice printed as two items ("BP/DP", "(50.00)") followed by its
//    blank; a map point on its own caption (x=345) resolved no caption the label names, and the
//    caption-tail fallback reached only "(50.00)" from within 40pt of it.
// The X goes on the blank of the CHOSEN option (the one the map's point is on), never on its
// neighbour's; a mark whose caption has neither a box nor a blank is still withheld, and the operator
// item names which shapes were looked for.
//
// Fixture: the PUBLIC Valencia blank (backend/test/fixtures/valencia-multi-purpose-permit-application.pdf,
// Rev 1-2020; the owner's Rev 7-2020 has the same grid). Every value is fictional.
//
//   npx tsx backend/test/flatFormChoiceBlanks.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO } from "./_isolate";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flat-form-choice-blanks-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.DOCUMENT_FETCH = "off";
process.env.AHJ_FORM_DOWNLOADS = "off";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.FLAT_FORM_ROW_SNAP;
delete process.env.OVERLAY_NUDGE_X;
delete process.env.OVERLAY_NUDGE_Y;

const { fillLoadedForm } = await import("../src/ahjForms");
type Def = Parameters<typeof fillLoadedForm>[0];
type Ctx = Parameters<typeof fillLoadedForm>[2];
const { extractLabels, splitBlankRuns } = await import("../src/formTextLayer");
type Item = Awaited<ReturnType<typeof extractLabels>>[number];

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const ctx: Ctx = {
  project: { id: "p-fictional", homeownerName: "Avery Quill", projectAddress: "1200 Example Orchard Rd", city: "Fictionville", state: "NM", zip: "87000", ahj: "Example County" } as unknown as Ctx["project"],
  client: { installerCompanyName: "Sunward Example Solar LLC" },
  snapshot: {},
};
const blankBytes = new Uint8Array(fs.readFileSync(path.join(REPO, "backend", "test", "fixtures", "valencia-multi-purpose-permit-application.pdf")));
const printed = (await extractLabels(blankBytes)).filter((i) => i.page === 0);
const items = splitBlankRuns(printed);

const P = (x: number, y: number, label: string, verified = false): Def => ({
  id: "tmpl-valencia-choice-test", formName: "Valencia County Permit Application (test)", state: "NM", matchJurisdictions: ["example county"],
  sourceUrl: "", version: "stored", status: "verified", fillMode: "overlay", textFields: {}, checkboxes: {}, signatureFields: [], formTrack: "building",
  overlayFields: [{ source: "lit:X", page: 0, x, y, size: 9, label }], ...(verified ? {} : { unverifiedMap: true }),
});
let n = 0;
/** Fill one placement; the X's drawn on page 1 (anything the blank did not print) and the operator items. */
async function fill(def: Def): Promise<{ marks: Item[]; operatorItems: string[] }> {
  const out = path.join(tmpDir, `filled-${++n}.pdf`);
  const res = await fillLoadedForm(def, blankBytes, ctx, out);
  assert.equal(res.status, "filled", `fill failed: ${res.message}`);
  const key = (i: Item) => `${i.str}|${Math.round(i.x)}|${Math.round(i.y)}`;
  const seen = new Set(printed.map(key));
  const drawn = (await extractLabels(new Uint8Array(fs.readFileSync(out)))).filter((i) => i.page === 0 && !seen.has(key(i)));
  return { marks: drawn, operatorItems: res.operatorItems ?? [] };
}
/** The blank printed right after a caption on its line. */
const blankAfter = (str: string): Item => {
  const cap = items.find((i) => !i.blank && i.str.trim() === str);
  assert.ok(cap, `fixture: no printed "${str}"`);
  const b = items.filter((i) => i.blank && Math.abs(i.y - cap.y) < 0.6 && i.x >= cap.x + cap.width - 1).sort((a, c) => a.x - c.x)[0];
  assert.ok(b, `fixture: no blank after "${str}"`);
  return b;
};
const onBlank = (m: Item, b: Item) => m.str.trim() === "X" && m.x >= b.x && m.x + m.width <= b.x + b.width && Math.abs(m.y - b.y) < 3;

const RES = blankAfter("RESIDENTIAL");
const COM = blankAfter("/ COMMERCIAL");
const FEE = blankAfter("(50.00)");

await check("fixture: the Valencia blank prints RESIDENTIAL ____ / COMMERCIAL ____ and BP/DP (50.00) ___ as captions and blanks", () => {
  assert.ok(RES.x + RES.width < COM.x, "two distinct blanks on the RESIDENTIAL / COMMERCIAL line");
  assert.ok(items.some((i) => i.str === "BP/DP" && Math.abs(i.y - FEE.y) < 0.6), "BP/DP on the fee line");
  assert.ok(!printed.some((i) => /Avery|Sunward/.test(i.str)), "the blank is blank");
});

await check("RESIDENTIAL chosen (the map's point on RESIDENTIAL): the X lands inside the RESIDENTIAL blank, not COMMERCIAL's", async () => {
  const f = await fill(P(345, 648, "RESIDENTIAL ____ / COMMERCIAL ____"));
  assert.equal(f.marks.length, 1, `one X drawn: ${JSON.stringify(f.marks)} / ${JSON.stringify(f.operatorItems)}`);
  assert.ok(onBlank(f.marks[0], RES), `the X at ${f.marks[0].x.toFixed(1)},${f.marks[0].y.toFixed(1)} is not on the RESIDENTIAL blank [${RES.x.toFixed(1)}..${(RES.x + RES.width).toFixed(1)}]`);
  assert.ok(!onBlank(f.marks[0], COM), "the X is on COMMERCIAL's blank");
  assert.deepEqual(f.operatorItems.filter((i) => /RESIDENTIAL/.test(i)), [], "nothing withheld");
});

await check("COMMERCIAL chosen (the map's point on COMMERCIAL): the X follows the chosen option onto COMMERCIAL's blank", async () => {
  const f = await fill(P(470, 648, "RESIDENTIAL ____ / COMMERCIAL ____"));
  assert.equal(f.marks.length, 1, `one X drawn: ${JSON.stringify(f.operatorItems)}`);
  assert.ok(onBlank(f.marks[0], COM) && !onBlank(f.marks[0], RES), `the X at ${f.marks[0].x.toFixed(1)} is not on the COMMERCIAL blank`);
});

await check("FEE-LINE CHOICE \"BP/DP(50.00)\": the caption printed as two items reaches its blank — the X is on BP/DP's blank, not MHP's or FP's", async () => {
  const f = await fill(P(345, 664, "BP/DP(50.00)"));
  assert.equal(f.marks.length, 1, `one X drawn: ${JSON.stringify(f.operatorItems)}`);
  assert.ok(onBlank(f.marks[0], FEE), `the X at ${f.marks[0].x.toFixed(1)},${f.marks[0].y.toFixed(1)} is not on the BP/DP blank [${FEE.x.toFixed(1)}..${(FEE.x + FEE.width).toFixed(1)}]`);
});

await check("NEITHER OPTION CHOSEN (the map's point on neither option's caption or blank): no X is guessed onto either blank — withheld and named", async () => {
  const f = await fill(P(150, 648, "RESIDENTIAL ____ / COMMERCIAL ____"));
  assert.deepEqual(f.marks.map((m) => m.str), [], "nothing drawn");
  assert.ok(f.operatorItems.some((i) => /^RESIDENTIAL ____ \/ COMMERCIAL ____ \(no box for it could be found/.test(i)), JSON.stringify(f.operatorItems));
});

await check("NO BOX, NO BLANK: a mark whose caption has neither is withheld (nothing drawn), and the operator item names the shapes looked for", async () => {
  const f = await fill(P(262, 622, "PROPOSED PROJECT"));
  assert.deepEqual(f.marks.map((m) => m.str), [], "nothing drawn");
  const item = f.operatorItems.find((i) => /^PROPOSED PROJECT \(/.test(i));
  assert.ok(item, JSON.stringify(f.operatorItems));
  assert.match(item, /no box for it could be found on the form — tick it by hand/);
  assert.match(item, /checkbox/i, "names the checkbox it looked for");
  assert.match(item, /____ blank/, "names the blank it looked for");
});

await check("VERIFIED MAP untouched: the same combined label on a verified map is drawn exactly where release #11 draws it (FLAT_FORM_ROW_SNAP=0)", async () => {
  const def = P(345, 648, "RESIDENTIAL ____ / COMMERCIAL ____", true);
  const now = await fill(def);
  process.env.FLAT_FORM_ROW_SNAP = "0";
  try {
    const release11 = await fill(def);
    assert.deepEqual(now.marks.map((m) => [m.str, m.x, m.y]), release11.marks.map((m) => [m.str, m.x, m.y]));
    assert.equal(now.marks.length, 1);
  } finally { delete process.env.FLAT_FORM_ROW_SNAP; }
});

console.log("");
if (failures) {
  console.error(`flatFormChoiceBlanks: ${failures} FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`flatFormChoiceBlanks: all ${passed} checks passed — a choice mark lands on its chosen option's blank; a caption with no box and no blank is withheld and says what was looked for`);
process.exit(0);
