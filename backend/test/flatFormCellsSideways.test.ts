// FLAT FORMS: CAPTION CELLS, LINES RIGHT OF THEIR LABELS, SIDEWAYS PAGES, CHECKBOXES (issue #10).
//
// Two live fills came back unusable (owner, 2026-10-01/02):
//  - City of Albuquerque "E-PLAN APPLICATION": every writing line STARTS right of its label, so the row
//    snap found no row and the value was drawn at the map's guess (a ZIP on the ADDRESS line above,
//    CONSTRUCTION ADDRESS twice); the owner's copy is the form laid on its side on an upright page,
//    so "right of the label" ran perpendicular to the line and glyphs were drawn upright; every
//    check mark sat a line off.
//  - Valencia County "MULTI-PURPOSE PERMIT APPLICATION": every caption sits top-left in a ruled cell
//    under a yellow highlight; the highlights were read as section headers (PHONE / STATE "no room"),
//    CITY / ZIP were written on the row above, a phone was printed over TOTAL SQ FT, the agent row
//    ("NAME ____ PHONE ____ Company ____", ONE text item) lost NAME/PHONE and squeezed Company right.
//
// Fixtures: both PUBLIC blanks (backend/test/fixtures/abq-eplan-application.pdf — AcroForm flattened,
// metadata stripped; valencia-multi-purpose-permit-application.pdf — page 1, metadata stripped) and a
// SIDEWAYS copy built here (the ABQ page embedded turned 90° on a 612×792 page, /Rotate 0). The maps
// are shaped like the live ones (printed labels, sources, a vision map's drift); every value is
// fictional.
//
// Positions are read back off the FILLED PDF's text layer, in the page's reading frame, and checked
// against the blank's own drawing. POSITIVE CONTROL: FLAT_FORM_ROW_SNAP=0 (release #11's placement)
// must fail the same predicates.
//
//   npx tsx backend/test/flatFormCellsSideways.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { REPO } from "./_isolate";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flat-form-cells-sideways-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.DOCUMENT_FETCH = "off";
process.env.AHJ_FORM_DOWNLOADS = "off";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.FLAT_FORM_ROW_SNAP;
delete process.env.OVERLAY_NUDGE_X;
delete process.env.OVERLAY_NUDGE_Y;

const { fillLoadedForm, resolveSource } = await import("../src/ahjForms");
type Def = Parameters<typeof fillLoadedForm>[0];
type Ctx = Parameters<typeof fillLoadedForm>[2];
const { extractLabels, splitBlankRuns } = await import("../src/formTextLayer");
type Item = Awaited<ReturnType<typeof extractLabels>>[number];
const { extractPageGeometry, pageFrame, itemsInFrame, captionHighlights, headerBands, cut, rowSnapPlacement } = await import("../src/formRowGeometry");
type Geo = Awaited<ReturnType<typeof extractPageGeometry>>[number];

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------------------------
// A fictional job.
// ---------------------------------------------------------------------------------------------
const ctx: Ctx = {
  project: {
    id: "p-fictional", homeownerName: "Avery Quill", projectAddress: "1200 Example Orchard Rd", city: "Fictionville", state: "NM", zip: "87000",
    ahj: "Example County", systemSizeDcKw: 10.25, systemSizeAcKw: 8, utility: "Example Power",
  } as unknown as Ctx["project"],
  client: {
    installerCompanyName: "Sunward Example Solar LLC", installerContactName: "Jordan Sample", installerStreet: "55 Sample Industrial Way",
    installerCityStateZip: "Testburg, NM 87001", installerPhone: "(505) 555-0142", installerEmail: "permits@sunward.example",
    stateContractorLicense: "999001",
  },
  snapshot: {
    homeownerPhone: "(505) 555-0199", homeownerEmail: "avery@example.com", legalDescription: "Lot 7, Example Subdivision",
    moduleQuantity: "25", moduleModel: "Example Mono 410W", roofMounted: "yes", mountType: "roof",
  },
};
const v = (source: string) => resolveSource(source, ctx).replace(/\s+/g, " ").trim();

let n = 0;
async function fill(def: Def, blank: Uint8Array, env: Record<string, string> = {}): Promise<{ bytes: Uint8Array; operatorItems: string[] }> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, val] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = val; }
  try {
    const out = path.join(tmpDir, `filled-${++n}.pdf`);
    const res = await fillLoadedForm(def, blank, ctx, out);
    assert.equal(res.status, "filled", `fill failed: ${res.message}`);
    return { bytes: new Uint8Array(fs.readFileSync(out)), operatorItems: res.operatorItems ?? [] };
  } finally {
    for (const [k, val] of Object.entries(saved)) { if (val === undefined) delete process.env[k]; else process.env[k] = val; }
  }
}
const P = (source: string, x: number, y: number, label: string, maxWidth?: number) => ({ source, page: 0, x, y, size: 9, ...(maxWidth ? { maxWidth } : {}), label });
const defOf = (id: string, formName: string, placements: ReturnType<typeof P>[]): Def => ({
  id, formName, state: "NM", matchJurisdictions: ["example county"], sourceUrl: "", version: "stored", status: "verified", fillMode: "overlay",
  textFields: {}, checkboxes: {}, overlayFields: placements, signatureFields: [], unverifiedMap: true, formTrack: "building",
});

// ---------------------------------------------------------------------------------------------
// Reading a filled page back, in its reading frame.
// ---------------------------------------------------------------------------------------------
interface Line { text: string; x: number; y: number; size: number; x1: number; angle: number }
type Rect = { x0: number; y0: number; x1: number; y1: number };
interface Blank { bytes: Uint8Array; raw: Item[]; items: Item[]; geo: Geo; angle: number; width: number; height: number }
async function readBlank(bytes: Uint8Array): Promise<Blank> {
  const raw = await extractLabels(bytes);
  const page = (await PDFDocument.load(bytes)).getPage(0);
  const frame = pageFrame(raw, 0, page.getWidth(), page.getHeight());
  const items = splitBlankRuns(itemsInFrame(raw, frame)).filter((i) => i.page === 0);
  const geo = (await extractPageGeometry(bytes, frame.angle ? { 0: frame.angle } : {}))[0];
  return { bytes, raw, items, geo, angle: frame.angle, width: page.getWidth(), height: page.getHeight() };
}
async function drawnLines(filled: Uint8Array, blank: Blank): Promise<Line[]> {
  const key = (i: Item) => `${i.page}|${i.str}|${Math.round(i.x)}|${Math.round(i.y)}`;
  const printed = new Set(blank.raw.map(key));
  const raw = (await extractLabels(filled)).filter((i) => i.page === 0 && !printed.has(key(i)));
  const drawn = itemsInFrame(raw, { page: 0, angle: blank.angle, width: blank.width, height: blank.height })
    .map((it, k) => ({ it, angle: raw[k].angle ?? 0 }));
  const lines: Line[] = [];
  for (const { it, angle } of drawn.sort((a, b) => (b.it.y - a.it.y) || (a.it.x - b.it.x))) {
    const last = lines.find((l) => Math.abs(l.y - it.y) < 0.5 && it.x - l.x1 < 6 && it.x >= l.x - 1);
    if (last) { last.text = `${last.text}${it.x - last.x1 > 1 ? " " : ""}${it.str}`.replace(/\s+/g, " "); last.x1 = it.x + it.width; continue; }
    lines.push({ text: it.str.trim(), x: it.x, y: it.y, size: it.height || 9, x1: it.x + it.width, angle });
  }
  return lines.map((l) => ({ ...l, text: l.text.trim() })).filter((l) => l.text);
}
const glyph = (l: Line): Rect => ({ x0: l.x, y0: l.y - 0.22 * l.size, x1: l.x1, y1: l.y + 0.72 * l.size });
/** An X has no descender: its ink is baseline to cap height. */
const ink = (l: Line): Rect => (l.text === "X" ? { x0: l.x, y0: l.y, x1: l.x1, y1: l.y + 0.72 * l.size } : glyph(l));
const printedBox = (i: Item): Rect => ({ x0: i.x, y0: i.y - 0.22 * (i.height || 9), x1: i.x + i.width, y1: i.y + 0.72 * (i.height || 9) });
/** Overlap deeper than the 0.3pt the glyph-box estimate is worth. */
const overlaps = (a: Rect, b: Rect) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.3 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.3;
const inside = (a: Rect, b: Rect) => a.x0 >= b.x0 && a.x1 <= b.x1 && a.y0 >= b.y0 && a.y1 <= b.y1;
const caption = (b: Blank, str: string, near: number, xNear?: number): Item => {
  const it = b.items.filter((i) => i.str.trim() === str && (xNear == null || Math.abs(i.x - xNear) < 20)).sort((a, c) => Math.abs(a.y - near) - Math.abs(c.y - near))[0];
  assert.ok(it, `fixture: no printed "${str}" near y=${near}`);
  return it;
};

/** Every value a map here binds, whole: a 2-letter state is a value, not a stub. */
const WHOLE_VALUES = new Set(["project.state", "project.zip"].map((src) => v(src)));
/** The rules every predicate shares: nothing drawn over another drawn value or the blank's printed
 *  words, no stub of a longer value, every glyph drawn in the printed text's direction. */
function commonViolations(b: Blank, lines: Line[]): string[] {
  const out: string[] = [];
  for (const [i, a] of lines.entries()) {
    for (const c of lines.slice(i + 1)) if (overlaps(ink(a), ink(c))) out.push(`overprint: "${a.text}" and "${c.text}"`);
    const hit = b.items.find((p) => !p.blank && overlaps(ink(a), printedBox(p)));
    if (hit) out.push(`"${a.text}" is drawn over the form's printed "${hit.str}"`);
    if (a.text !== "X" && a.text.length < 3 && !WHOLE_VALUES.has(a.text)) out.push(`"${a.text}" is a stub (under 3 characters) of a longer value`);
    if (a.angle !== b.angle) out.push(`"${a.text}" is drawn at ${a.angle}° on a page whose text runs at ${b.angle}°`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 1. VALENCIA COUNTY — caption-in-cell grid, highlights, the one-item agent row.
// ---------------------------------------------------------------------------------------------
const valencia = await readBlank(new Uint8Array(fs.readFileSync(path.join(REPO, "backend", "test", "fixtures", "valencia-multi-purpose-permit-application.pdf"))));
const VALENCIA_PLACEMENTS = [
  P("project.projectAddress", 22, 610, "PROJECT LOCATION / SITE ADDRESS"),
  P("computed.descriptionOfWork", 262, 610, "PROPOSED PROJECT", 70),
  P("project.homeownerName", 167, 582, "PROPERTY OWNER NAME", 95),
  P("snapshot.homeownerPhone", 409, 582, "PHONE", 25),
  P("project.projectAddress", 22, 555, "MAILING ADDRESS", 70),
  P("project.city", 314, 555, "CITY"),
  P("project.state", 440, 555, "STATE", 20),
  P("project.zip", 512, 555, "ZIP"),
  P("client.installerContactName", 50, 521, "NAME"),
  P("client.installerPhone", 226, 521, "PHONE"),
  P("client.installerCompanyName", 388, 521, "Company"),
  P("lit:X", 345, 648, "RESIDENTIAL"),
];
const valenciaDef = defOf("tmpl-valencia-test", "Valencia County Permit Application (CD Permit Application)", VALENCIA_PLACEMENTS);
/** The cell a caption heads, read off the blank's drawing: the rules over and under it, the dividers left and right. */
function cellOf(b: Blank, cap: Item): Rect {
  const g = b.geo;
  const covers = (r: { x0: number; x1: number }) => r.x0 - 2 <= cap.x + 1 && r.x1 + 2 >= cap.x + 1;
  const rules = g.hRules.filter((r) => !r.band && covers(r));
  const top = rules.filter((r) => r.yBottom > cap.y).sort((p, q) => p.yBottom - q.yBottom)[0];
  const bottom = rules.filter((r) => r.yTop < cap.y - 8).sort((p, q) => q.yTop - p.yTop)[0];
  assert.ok(top && bottom, `fixture: no cell around "${cap.str}"`);
  const mid = (top.yBottom + bottom.yTop) / 2;
  const crossing = g.vRules.filter((r) => r.y0 <= mid && r.y1 >= mid);
  const left = crossing.filter((r) => r.x <= cap.x).sort((p, q) => q.x - p.x)[0];
  const right = crossing.filter((r) => r.x >= cap.x + cap.width).sort((p, q) => p.x - q.x)[0];
  assert.ok(left, `fixture: no divider left of "${cap.str}"`);
  return { x0: left.x, y0: bottom.yTop, x1: right ? right.x : bottom.x1, y1: top.yBottom };
}
const VALENCIA_CELLS = [
  { label: "PROJECT LOCATION / SITE ADDRESS:", near: 623, value: v("project.projectAddress") },
  // An 84-character description in a 161 × 14pt cell: three lines at 8pt would need ~22pt, so it is
  // wrapped WHOLE onto two lines at the largest size that fits (7.25pt) — never cut to three words.
  { label: "PROPOSED PROJECT", near: 623, value: v("computed.descriptionOfWork"), minSize: 7 },
  { label: "PROPERTY OWNER NAME", near: 596.6, value: v("project.homeownerName") },
  { label: "PHONE", near: 596.6, value: v("snapshot.homeownerPhone") },
  { label: "MAILING ADDRESS", near: 568.9, value: v("project.projectAddress"), minSize: 8 },
  { label: "CITY", near: 568.9, value: v("project.city") },
  { label: "STATE", near: 568.9, value: v("project.state") },
  { label: "ZIP", near: 568.9, value: v("project.zip") },
];
const VALENCIA_AGENT = [
  { label: "NAME", value: v("client.installerContactName"), next: "PHONE" },
  { label: "PHONE", value: v("client.installerPhone"), next: "Company" },
  { label: "Company", value: v("client.installerCompanyName"), next: null },
];
function valenciaViolations(lines: Line[]): string[] {
  const b = valencia;
  const out = commonViolations(b, lines);
  for (const e of VALENCIA_CELLS) {
    const cap = caption(b, e.label, e.near);
    const cell = cellOf(b, cap);
    const capBottom = cap.y - 0.22 * (cap.height || 9);
    const mine = lines.filter((l) => l.y > cell.y0 && l.y < capBottom && l.x >= cell.x0 - 1 && l.x < cell.x1).sort((p, q) => q.y - p.y);
    const text = mine.map((l) => l.text).join(" ");
    if (text !== e.value) {
      const elsewhere = lines.filter((l) => e.value.startsWith(l.text) || l.text.startsWith(e.value.slice(0, 12))).map((l) => `${l.text}@${l.x.toFixed(1)},${l.y.toFixed(1)}`);
      out.push(`${e.label}: its cell [${cell.x0.toFixed(1)}..${cell.x1.toFixed(1)} × ${cell.y0.toFixed(1)}..${cell.y1.toFixed(1)}] holds ${JSON.stringify(text)}, not ${JSON.stringify(e.value)} (drawn: ${JSON.stringify(elsewhere)})`);
      continue;
    }
    for (const l of mine) {
      const box = glyph(l);
      if (!(box.x0 > cell.x0 && box.x1 < cell.x1 && box.y0 > cell.y0 && box.y1 < capBottom)) out.push(`${e.label}: "${l.text}" is not strictly inside its cell, under its caption`);
      if (e.minSize && l.size < e.minSize - 0.01) out.push(`${e.label}: "${l.text}" is drawn at ${l.size.toFixed(2)}pt (under ${e.minSize})`);
    }
    const hl = captionHighlights(b.geo, b.items).find((h) => cap.y >= h.y0 - 1 && cap.y <= h.y1 && cap.x >= h.x0 - 2 && cap.x < h.x1);
    if (e.minSize && hl && !mine.some((l) => l.x1 > hl.x1 + 8)) out.push(`${e.label}: the value is confined to the caption's highlight (ends ≤ ${hl.x1.toFixed(1)} + 8)`);
  }
  for (const e of VALENCIA_AGENT) {
    const cap = caption(b, e.label, 523.8);
    const next = e.next ? caption(b, e.next, 523.8) : null;
    const end = next ? next.x : 520;
    const hit = lines.find((l) => l.text === e.value);
    if (!hit) { out.push(`agent ${e.label}: ${JSON.stringify(e.value)} is not drawn`); continue; }
    const start = hit.x - (cap.x + cap.width);
    if (Math.abs(hit.y - cap.y) > 3 || start < 0 || start > 8) out.push(`agent ${e.label}: "${hit.text}" starts ${start.toFixed(1)}pt right of its caption at baseline ${hit.y.toFixed(1)} (caption ${cap.y.toFixed(1)})`);
    if (hit.x1 > end) out.push(`agent ${e.label}: "${hit.text}" runs to ${hit.x1.toFixed(1)}, past ${e.next ?? "the row's end"} (${end.toFixed(1)})`);
  }
  const res = caption(b, "RESIDENTIAL", 649.2);
  const blank = b.items.find((i) => i.blank && Math.abs(i.y - res.y) < 0.6 && i.x > res.x)!;
  const x = lines.filter((l) => l.text === "X");
  if (x.length !== 1 || !(x[0].x >= blank.x && x[0].x1 <= blank.x + blank.width && Math.abs(x[0].y - res.y) < 3)) out.push(`RESIDENTIAL: the X is not on its blank: ${JSON.stringify(x)}`);
  return out;
}

await check("fixture: the Valencia blank is BLANK, its captions are highlighted cells, and the agent row is ONE printed item split into captions and blanks", () => {
  for (const name of ["Avery", "Sunward", "Fictionville", "Jordan"]) assert.ok(!valencia.raw.some((i) => i.str.includes(name)), name);
  assert.ok(valencia.raw.some((i) => /^NAME _+ PHONE _+ Company _+$/.test(i.str.trim())), "the agent row is one text item on the blank");
  const segs = valencia.items.filter((i) => Math.abs(i.y - 523.8) < 0.5);
  assert.deepEqual(segs.map((i) => (i.blank ? "_" : i.str)), ["NAME", "_", "PHONE", "_", "Company", "_"]);
  // Where each part starts, read with pdftotext -bbox off the same file (poppler's own glyph metrics).
  const truth = [20.16, 45.70, 223.82, 252.49, 386.50, 419.60];
  segs.forEach((s, k) => assert.ok(Math.abs(s.x - truth[k]) < 1, `${s.str} at ${s.x.toFixed(2)}, printed at ${truth[k]}`));
  assert.ok(captionHighlights(valencia.geo, valencia.items).length >= 8, "the yellow caption highlights");
  assert.equal(headerBands(valencia.geo, valencia.items).filter((h) => h.y0 > 500).length, 0, "no caption highlight is a section header");
  // The lone "R" on the owner row is the BLANK's own print (18pt, in the first cell), not a fill.
  assert.ok(valencia.raw.some((i) => i.str === "R" && Math.abs(i.x - 20.2) < 0.5 && Math.abs(i.y - 587.5) < 0.5), "the printed R");
});
const vFilled = await fill(valenciaDef, valencia.bytes);
const vLines = await drawnLines(vFilled.bytes, valencia);
await check("THE FIX (Valencia, unverified map): each value strictly inside its own cell under its caption, owner phone in the PHONE cell, City/State/ZIP in the MAILING row, agent NAME/PHONE/Company on their blanks, no overprint, no stub, the RESIDENTIAL X on its blank", () => {
  const bad = valenciaViolations(vLines);
  assert.deepEqual(bad, [], bad.join("\n         "));
});
await check("POSITIVE CONTROL (Valencia): FLAT_FORM_ROW_SNAP=0 fails the same predicate — the live symptoms", async () => {
  const off = await fill(valenciaDef, valencia.bytes, { FLAT_FORM_ROW_SNAP: "0" });
  const bad = valenciaViolations(await drawnLines(off.bytes, valencia));
  assert.ok(bad.length >= 5, `release #11's placement passed: ${bad.join(" | ")}`);
  assert.ok(bad.some((x) => /^CITY: /.test(x)) && bad.some((x) => /^ZIP: /.test(x)), bad.join("\n"));
});

// ---------------------------------------------------------------------------------------------
// 2. ABQ E-PLAN, upright — writing lines that start right of their labels; checkboxes.
// ---------------------------------------------------------------------------------------------
const abqBytes = new Uint8Array(fs.readFileSync(path.join(REPO, "backend", "test", "fixtures", "abq-eplan-application.pdf")));
const abq = await readBlank(abqBytes);
// The vision map's shape: labels as printed (section-qualified where repeated), its points a few
// points off, and every check mark a line LOW (in the next row's box), as on the owner's fill.
const ABQ_PLACEMENTS = [
  P("project.projectAddress", 170, 494, "CONSTRUCTION ADDRESS:"),
  P("snapshot.legalDescription", 135, 478, "LEGAL DESCRIPTION:"),
  P("project.homeownerName", 80, 363, "OWNER: NAME"),
  P("project.projectAddress", 80, 352, "OWNER: ADDRESS"),
  P("project.zip", 80, 341, "OWNER: ZIP"),
  P("snapshot.homeownerPhone", 262, 341, "OWNER: PHONE"),
  P("client.installerCompanyName", 80, 166, "CONTRACTOR: NAME"),
  P("client.installerStreet", 80, 155, "CONTRACTOR: ADDRESS"),
  P("client.installerCityStateZip", 80, 144, "CONTRACTOR: ZIP"),
  P("client.installerPhone", 262, 144, "CONTRACTOR: PHONE"),
  P("client.stateContractorLicense", 216, 133, "NM STATE LICENSE #"),
  P("lit:X", 514, 451, "TYPE OF APPLICATION: RESIDENTIAL"),
  P("lit:X", 514, 373, "TYPE OF APPLICATION: OTHER"),
  P("lit:X", 514, 384, "TYPE OF APPLICATION: FOUNDATION FOR MOVED BUILDING"),
  P("lit:X", 390, 89, "DESCRIPTION OF WORK: SINGLE FAMILY RESIDENCE"),
  P("lit:X", 505, 352, "OWNERSHIP: PRIVATE"),
];
const abqDef = (placements = ABQ_PLACEMENTS): Def => defOf("tmpl-abq-test", "E-Plan Application — City of Albuquerque", placements);
const ABQ_LINES = [
  { label: "CONSTRUCTION ADDRESS:", near: 495.5, value: v("project.projectAddress") },
  { label: "NAME", near: 364.8, value: v("project.homeownerName") },
  { label: "ADDRESS", near: 353.0, value: v("project.projectAddress") },
  { label: "ZIP", near: 342.5, value: v("project.zip") },
  { label: "PHONE", near: 341.9, value: v("snapshot.homeownerPhone") },
  { label: "NAME", near: 168.1, value: v("client.installerCompanyName") },
  { label: "ADDRESS", near: 156.4, value: v("client.installerStreet") },
  { label: "ZIP", near: 145.2, value: v("client.installerCityStateZip") },
  { label: "PHONE", near: 145.8, value: v("client.installerPhone") },
  { label: "NM STATE LICENSE #", near: 134.0, value: v("client.stateContractorLicense") },
];
const ABQ_MARKS = [
  { label: "RESIDENTIAL", near: 462.6 },
  { label: "OTHER", near: 384.5 },
  { label: "FOUNDATION FOR MOVED BUILDING", near: 395.6 },
  { label: "SINGLE FAMILY RESIDENCE", near: 100.7 },
  { label: "PRIVATE", near: 363.7 },
];
function abqViolations(b: Blank, lines: Line[]): string[] {
  const out = commonViolations(b, lines);
  for (const e of ABQ_LINES) {
    const cap = caption(b, e.label, e.near);
    const end = cap.x + cap.width;
    const line = b.geo.hRules.filter((r) => !r.band && r.x0 >= end - 2 && r.x0 <= end + 14 && r.y <= cap.y && r.y >= cap.y - 7).sort((p, q) => p.x0 - q.x0)[0];
    assert.ok(line, `fixture: no writing line right of "${e.label}" at ${e.near}`);
    const on = lines.filter((l) => l.y > line.y && l.y < line.y + 8 && l.x >= line.x0 - 1 && l.x < line.x1);
    const hit = on.find((l) => l.text === e.value);
    if (!hit) { out.push(`${e.label} (${e.near}): its line [${line.x0.toFixed(1)}..${line.x1.toFixed(1)} @ ${line.y.toFixed(1)}] holds ${JSON.stringify(on.map((l) => l.text))}, not ${JSON.stringify(e.value)}`); continue; }
    if (on.length !== 1) out.push(`${e.label} (${e.near}): its line holds ${on.length} values: ${JSON.stringify(on.map((l) => l.text))}`);
    if (hit.y < line.y + 2 - 0.05 || hit.y > line.y + 3 + 0.05) out.push(`${e.label}: baseline ${hit.y.toFixed(2)} is not 2-3pt above its line (${line.y.toFixed(2)})`);
    if (hit.x < line.x0 || hit.x1 > line.x1) out.push(`${e.label}: "${hit.text}" runs ${hit.x.toFixed(1)}..${hit.x1.toFixed(1)}, off its line ${line.x0.toFixed(1)}..${line.x1.toFixed(1)}`);
  }
  const address = lines.filter((l) => l.text === v("project.projectAddress") && l.y > 480);
  if (address.length !== 1) out.push(`CONSTRUCTION ADDRESS is drawn ${address.length} times near its line`);
  const marks = lines.filter((l) => l.text === "X");
  if (marks.length !== ABQ_MARKS.length) out.push(`${marks.length} check marks drawn, ${ABQ_MARKS.length} expected`);
  for (const e of ABQ_MARKS) {
    const cap = caption(b, e.label, e.near);
    const mid = cap.y + 0.3 * (cap.height || 9);
    const box = b.geo.boxes.filter((x) => x.x1 <= cap.x + 1 && cap.x - x.x1 <= 24 && Math.abs((x.y0 + x.y1) / 2 - mid) < 5).sort((p, q) => q.x1 - p.x1)[0];
    assert.ok(box, `fixture: no checkbox beside "${e.label}"`);
    if (!marks.some((m) => inside(ink(m), box))) out.push(`${e.label}: no X inside its box [${box.x0.toFixed(1)},${box.y0.toFixed(1)}] — marks at ${JSON.stringify(marks.map((m) => [+m.x.toFixed(1), +m.y.toFixed(1)]))}`);
  }
  return out;
}

await check("fixture: the ABQ blank is BLANK, prints its lines right of the labels, and its checkboxes are read off the drawing (6-14pt boxes kept, not discarded)", () => {
  for (const name of ["Avery", "Sunward", "Fictionville"]) assert.ok(!abq.raw.some((i) => i.str.includes(name)), name);
  const ca = caption(abq, "CONSTRUCTION ADDRESS:", 495.5);
  assert.ok(Math.abs(ca.x - 47) < 0.5 && Math.abs(ca.x + ca.width - 165.1) < 0.5, JSON.stringify(ca));
  assert.ok(abq.geo.hRules.some((r) => Math.abs(r.y - 492.3) < 0.2 && Math.abs(r.x0 - 169) < 0.3 && Math.abs(r.x1 - 470.3) < 0.3), "the CONSTRUCTION ADDRESS line");
  // YES/NO, 3 application kinds, 12 work types, 2 ownership, 8 descriptions of work.
  assert.equal(abq.geo.boxes.length, 27, `checkboxes read: ${abq.geo.boxes.length}`);
  assert.ok(abq.geo.boxes.every((x) => x.x1 - x.x0 >= 6 && x.x1 - x.x0 <= 14), "box sides 6-14pt");
  // "FA" after ABQ. BUSINESS REG. # is the blank's own print.
  assert.ok(abq.raw.some((i) => i.str === "FA"), "the printed FA");
});
const aFilled = await fill(abqDef(), abq.bytes);
const aLines = await drawnLines(aFilled.bytes, abq);
await check("THE FIX (ABQ upright): CONSTRUCTION ADDRESS once on its own line (x ≥ 169, baseline 2-3pt above 492.3, ≤ 470.3); each ZIP on its ZIP line, never the ADDRESS line above; every X inside the box beside its caption; no overprint", () => {
  const bad = abqViolations(abq, aLines);
  assert.deepEqual(bad, [], bad.join("\n         "));
  const ca = aLines.find((l) => l.text === v("project.projectAddress") && l.y > 480)!;
  assert.ok(ca.x >= 169 && ca.y >= 494.3 - 0.05 && ca.y <= 495.3 + 0.05 && ca.x1 <= 470.3, JSON.stringify(ca));
});
await check("REFUSAL: a found label with no row (LEGAL DESCRIPTION:, nothing to write on) is NOT drawn — it is named for the operator", () => {
  assert.ok(!aLines.some((l) => l.text === v("snapshot.legalDescription")), JSON.stringify(aLines.filter((l) => l.text.startsWith("Lot"))));
  assert.ok(aFilled.operatorItems.some((i) => /^LEGAL DESCRIPTION:? \(no row for it could be found on the form — complete it by hand\)/.test(i)), JSON.stringify(aFilled.operatorItems));
});
await check("POSITIVE CONTROL (ABQ upright): FLAT_FORM_ROW_SNAP=0 fails the same predicate (marks a line off, the legal description drawn at the map's guess)", async () => {
  const off = await fill(abqDef(), abq.bytes, { FLAT_FORM_ROW_SNAP: "0" });
  const lines = await drawnLines(off.bytes, abq);
  const bad = abqViolations(abq, lines);
  assert.ok(bad.some((x) => /no X inside its box/.test(x)), bad.join("\n"));
  assert.ok(lines.some((l) => l.text === v("snapshot.legalDescription")), "release #11 drew the unplaceable value");
});
await check("CHECK MARK WITHHELD: a mark whose caption has no box beside it on an unverified map is not drawn at the map's point — it is named", async () => {
  const f = await fill(abqDef([P("lit:X", 60, 300, "PERSON WHO WILL UPLOAD ELECTRONIC PLANS: NAME")]), abq.bytes);
  assert.deepEqual((await drawnLines(f.bytes, abq)).map((l) => l.text), []);
  assert.ok(f.operatorItems.some((i) => /no box for it could be found on the form — tick it by hand/.test(i)), JSON.stringify(f.operatorItems));
});

// ---------------------------------------------------------------------------------------------
// 3. ABQ E-PLAN, SIDEWAYS — the same page laid on its side on an upright page (/Rotate 0).
// ---------------------------------------------------------------------------------------------
async function sidewaysBlank(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const [embedded] = await doc.embedPdf(abqBytes, [0]);
  const page = doc.addPage([612, 792]);
  // Turned 90° counter-clockwise about (612, 0): the form's (u, v) lands on the page at (612 - v, u).
  page.drawPage(embedded, { x: 612, y: 0, rotate: degrees(90) });
  await doc.embedFont(StandardFonts.Helvetica);
  return doc.save();
}
const side = await readBlank(await sidewaysBlank());
const turn = (x: number, y: number) => ({ x: 612 - y, y: x });
// The same map as the vision pass reads it off the sideways page: page coordinates.
const SIDE_PLACEMENTS = ABQ_PLACEMENTS.map((p) => ({ ...p, ...turn(p.x, p.y) }));
await check("fixture: the sideways page is 612×792 with /Rotate 0, every label printed at 90°, and reads back (in its reading frame) where the upright form prints it", async () => {
  const doc = await PDFDocument.load(side.bytes);
  const pg = doc.getPage(0);
  assert.deepEqual([pg.getWidth(), pg.getHeight(), pg.getRotation().angle], [612, 792, 0]);
  const labels = side.raw.filter((i) => i.str.trim().length > 1);
  assert.ok(labels.every((i) => i.angle === 90), `angles: ${[...new Set(labels.map((i) => i.angle))].join(",")}`);
  assert.equal(side.angle, 90);
  const ca = side.raw.find((i) => i.str === "CONSTRUCTION ADDRESS:")!;
  assert.ok(Math.abs(ca.x - (612 - 495.5)) < 0.6 && Math.abs(ca.y - 47) < 0.6, `page position ${ca.x},${ca.y}`);
  const read = caption(side, "CONSTRUCTION ADDRESS:", 495.5);
  assert.ok(Math.abs(read.x - 47) < 0.6 && Math.abs(read.y - 495.5) < 0.6, `reading frame ${read.x},${read.y}`);
  assert.ok(side.geo.hRules.some((r) => Math.abs(r.y - 492.3) < 0.3 && Math.abs(r.x0 - 169) < 0.5), "its writing lines read as rows");
  assert.equal(side.geo.boxes.length, abq.geo.boxes.length, "its checkboxes");
});
const sFilled = await fill(defOf("tmpl-abq-side-test", "E-Plan Application — City of Albuquerque (sideways)", SIDE_PLACEMENTS), side.bytes);
const sLines = await drawnLines(sFilled.bytes, side);
await check("THE FIX (ABQ sideways): the same predicate holds in the reading frame — every value on its line, every X in its box, every glyph drawn at the labels' 90°", () => {
  const bad = abqViolations(side, sLines);
  assert.deepEqual(bad, [], bad.join("\n         "));
});
await check("THE FIX (ABQ sideways): room is measured along the text direction — each value sits where the upright fill put it (within 0.6pt)", () => {
  const key = (l: Line) => l.text;
  for (const l of aLines) {
    const s = sLines.find((x) => key(x) === key(l) && Math.abs(x.y - l.y) < 0.6 && Math.abs(x.x - l.x) < 0.6);
    assert.ok(s, `"${l.text}" at ${l.x.toFixed(1)},${l.y.toFixed(1)} upright has no twin sideways: ${JSON.stringify(sLines.filter((x) => key(x) === key(l)))}`);
  }
  assert.equal(sLines.length, aLines.length);
});
await check("POSITIVE CONTROL (ABQ sideways): FLAT_FORM_ROW_SNAP=0 fails — upright glyphs, values off their lines", async () => {
  const off = await fill(defOf("tmpl-abq-side-test", "E-Plan Application (sideways)", SIDE_PLACEMENTS), side.bytes, { FLAT_FORM_ROW_SNAP: "0" });
  const bad = abqViolations(side, await drawnLines(off.bytes, side));
  assert.ok(bad.some((x) => /drawn at 0° on a page whose text runs at 90°/.test(x)), bad.join("\n"));
  assert.ok(bad.some((x) => /its line .* holds/.test(x)), bad.join("\n"));
});

// ---------------------------------------------------------------------------------------------
// 4. The one-glyph rule.
// ---------------------------------------------------------------------------------------------
const helv = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
const widthOf = (t: string, s: number) => helv.widthOfTextAtSize(t, s);
await check("ONE-GLYPH RULE: a cut never leaves under 3 characters of a longer value (refused instead); a short value stays whole", () => {
  assert.equal(cut("Sunward Example Solar LLC", 9, 9, widthOf), "");
  assert.equal(cut("Sunward Example Solar LLC", 40, 9, widthOf).length >= 3, true);
  assert.equal(cut("NM", 40, 9, widthOf), "NM");
  // A row with room for a single glyph is refused, not filled with "R".
  const g: Geo = { page: 0, width: 612, height: 792, vRules: [{ page: 0, x: 66, y0: 690, y1: 710 }], bands: [], boxes: [], hRules: [
    { page: 0, y: 690, yTop: 690.35, yBottom: 689.65, x0: 20, x1: 300 }, { page: 0, y: 710, yTop: 710.35, yBottom: 709.65, x0: 20, x1: 300 },
  ] };
  const items: Item[] = [{ page: 0, str: "Owner:", x: 22, y: 693, width: 26, height: 9 }];
  const snap = rowSnapPlacement({ geometry: g, items, label: items[0], point: { x: 50, y: 693 }, text: "Roberta Example-Longname", size: 9, widthOf });
  assert.ok(!snap || snap.lines.every((l) => l.text.length >= 3), JSON.stringify(snap));
});
await check("ONE-GLYPH RULE (maxWidth path): a value wider than its box shrinks first; one that still does not fit is withheld and named, never drawn as a stub", async () => {
  const blankDoc = await PDFDocument.create();
  blankDoc.addPage([612, 792]);
  const blank = await blankDoc.save();
  const def = { ...defOf("tmpl-maxwidth", "Unlabelled placements", [
    { source: "client.installerCompanyName", page: 0, x: 100, y: 700, size: 9, maxWidth: 110 },
    { source: "client.installerCompanyName", page: 0, x: 100, y: 650, size: 9, maxWidth: 8 },
  ]) };
  const f = await fill(def, blank);
  const drawn = (await extractLabels(f.bytes)).map((i) => i.str.trim()).filter(Boolean).join(" | ");
  assert.equal(drawn, v("client.installerCompanyName"), "the first fits at a smaller size, whole; the second is not drawn");
  assert.ok(f.operatorItems.some((i) => /^placement 2 \(the value does not fit its box on the form/.test(i)), JSON.stringify(f.operatorItems));
});

console.log("");
if (failures) {
  console.error(`flatFormCellsSideways: ${failures} FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`flatFormCellsSideways: all ${passed} checks passed — caption cells, lines right of labels, sideways pages and checkboxes placed from the page's own drawing; no overprint, no stubs, unplaceable values withheld`);
process.exit(0);
