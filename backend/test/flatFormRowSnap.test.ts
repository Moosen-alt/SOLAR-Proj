// FLAT FORMS: A VALUE IS WRITTEN INSIDE ITS ROW (Yamhill County, live 2026-09-28).
//
// The stored "Building Permit Application — YAMHILL COUNTY" is a flat ruled table: a label, then the
// rest of its row, the row closed by a printed rule; section headers are shaded bands. Filled from its
// vision map it came back with the owner / contractor / applicant values drawn ON the rules (struck
// through), the applicant's name in the Address row, the job-site address over the shaded "JOB SITE
// INFORMATION AND LOCATION" band after a re-map, and the description of work written into
// "Tax map/parcel no" while the three DESCRIPTION OF WORK rows stayed blank.
//
// Fixtures: the county's own BLANK (backend/test/fixtures/yamhill-building-application.pdf — a public
// form, no customer data, author metadata stripped) filled from the live map's SHAPE (its labels,
// sources and coordinates, no project data), and a synthetic ruled page built here with pdf-lib, so
// the rule holds without the county file. Every project value is fictional.
//
// Positions are read back off the FILLED PDF's own text layer and checked against the blank's rules:
// every value's baseline strictly inside its label's row (2-3pt above the row's bottom rule, its top
// under the rule above), right of its label, never crossing a rule, never inside a header band.
//
// Kills: FLAT_FORM_ROW_SNAP=0 (the release #11 placement) is checked IN this file as the positive
// control — the same predicate must report violations; the parcel binding is killed by disabling
// captionSourceRule in resolveOverlay.
//
//   npx tsx backend/test/flatFormRowSnap.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { REPO } from "./_isolate";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flat-form-row-snap-"));
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
const { extractLabels, resolvePlacementLabel } = await import("../src/formTextLayer");
type Item = Awaited<ReturnType<typeof extractLabels>>[number];
const { extractPageGeometry, headerBands } = await import("../src/formRowGeometry");
type Geo = Awaited<ReturnType<typeof extractPageGeometry>>[number];
const { sanitizePlacements, captionSourceRule } = await import("../src/formFieldChecks");

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------------------------
// A fictional job.
// ---------------------------------------------------------------------------------------------
const ctxWith = (snapshot: Record<string, unknown> = {}): Ctx => ({
  project: {
    id: "p-fictional", homeownerName: "Avery Quill", projectAddress: "1200 Example Orchard Rd", city: "Fictionville", state: "OR", zip: "97000",
    ahj: "Example County", systemSizeDcKw: 10.25, systemSizeAcKw: 8, utility: "Example Power",
  } as unknown as Ctx["project"],
  client: {
    installerCompanyName: "Sunward Example Solar LLC", installerStreet: "55 Sample Industrial Way", installerCityStateZip: "Testburg, OR 97001",
    installerPhone: "(503) 555-0142", installerEmail: "permits@sunward.example", ccbLicenseNumber: "999001", stateContractorLicense: "999001",
  },
  snapshot: {
    parcelNumber: "R4400-00-12345", homeownerPhone: "(503) 555-0199", homeownerEmail: "avery@example.com",
    moduleQuantity: "25", moduleModel: "Example Mono 410W", roofMounted: "yes", mountType: "roof",
    ...snapshot,
  },
});

let n = 0;
async function fill(def: Def, blank: Uint8Array, ctx: Ctx, env: Record<string, string> = {}): Promise<{ bytes: Uint8Array; operatorItems: string[] }> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const out = path.join(tmpDir, `filled-${++n}.pdf`);
    const res = await fillLoadedForm(def, blank, ctx, out);
    assert.equal(res.status, "filled", `fill failed: ${res.message}`);
    return { bytes: new Uint8Array(fs.readFileSync(out)), operatorItems: res.operatorItems ?? [] };
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ---------------------------------------------------------------------------------------------
// Reading a filled page back: the drawn lines (the filled text layer minus the blank's), and the
// row predicate.
// ---------------------------------------------------------------------------------------------
interface Line { text: string; x: number; y: number; h: number; x1: number }
async function drawnLines(filled: Uint8Array, blankItems: Item[], page = 0): Promise<Line[]> {
  const key = (i: Item) => `${i.page}|${i.str}|${Math.round(i.x)}|${Math.round(i.y)}`;
  const printed = new Set(blankItems.map(key));
  const drawn = (await extractLabels(filled)).filter((i) => i.page === page && !printed.has(key(i)));
  const lines: Line[] = [];
  for (const it of drawn.sort((a, b) => (b.y - a.y) || (a.x - b.x))) {
    const last = lines.find((l) => Math.abs(l.y - it.y) < 0.5 && it.x - l.x1 < 6 && it.x >= l.x - 1);
    if (last) { last.text = `${last.text}${it.x - last.x1 > 1 ? " " : ""}${it.str}`.replace(/\s+/g, " "); last.x1 = it.x + it.width; continue; }
    lines.push({ text: it.str.trim(), x: it.x, y: it.y, h: it.height || 9, x1: it.x + it.width });
  }
  return lines.map((l) => ({ ...l, text: l.text.trim() })).filter((l) => l.text);
}

const coversX = (r: { x0: number; x1: number }, x: number) => r.x0 - 2 <= x && r.x1 + 2 >= x;
/** The row a printed label sits in: its bottom rule (tight under the baseline) and the rule over it. */
function rowOf(g: Geo, label: Item): { bottom: number; top: number } {
  const below = g.hRules.filter((r) => coversX(r, label.x + 1) && r.yTop <= label.y + 0.5 && r.yTop >= label.y - 7).sort((a, b) => b.yTop - a.yTop)[0];
  const above = g.hRules.filter((r) => coversX(r, label.x + 1) && r.yBottom >= label.y + 4 && r.yBottom <= label.y + 40).sort((a, b) => a.yBottom - b.yBottom)[0];
  assert.ok(below && above, `fixture: no row around "${label.str}" at y=${label.y.toFixed(1)}`);
  return { bottom: below.yTop, top: above.yBottom };
}
/** Violations of "inside its row": the one predicate every placement check below reads. */
function rowViolations(g: Geo, items: Item[], lines: Line[], expect: Array<{ label: string; near: number; value: string; xNear?: number }>): string[] {
  const out: string[] = [];
  const bands = headerBands(g, items);
  for (const e of expect) {
    const label = items.filter((i) => i.page === g.page && i.str.trim() === e.label && (e.xNear == null || Math.abs(i.x - e.xNear) < 20))
      .sort((a, b) => Math.abs(a.y - e.near) - Math.abs(b.y - e.near))[0];
    if (!label) { out.push(`fixture: no printed "${e.label}" near y=${e.near}`); continue; }
    const row = rowOf(g, label);
    const inRow = lines.filter((l) => l.y > row.bottom && l.y < row.top && l.x > label.x + label.width - 1 && l.x < label.x + label.width + 140);
    const hit = inRow.find((l) => l.text === e.value);
    if (!hit) { out.push(`"${e.label}" (y=${label.y.toFixed(1)}): its row [${row.bottom.toFixed(1)}, ${row.top.toFixed(1)}] does not hold "${e.value}" right of the label — holds ${JSON.stringify(inRow.map((l) => l.text))}`); continue; }
    if (hit.y < row.bottom + 1.5 || hit.y > row.bottom + 3.5) out.push(`"${e.label}": "${e.value}" baseline ${hit.y.toFixed(2)} is not 2-3pt above its row's rule (${row.bottom.toFixed(2)})`);
    if (hit.y + 0.72 * hit.h > row.top + 0.01) out.push(`"${e.label}": "${e.value}" crosses the rule above its row`);
  }
  for (const l of lines) {
    const box = { x0: l.x, y0: l.y - 0.22 * l.h, x1: l.x1, y1: l.y + 0.72 * l.h };
    if (bands.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) out.push(`"${l.text}" is drawn inside a shaded header band`);
    const mid = (l.x + l.x1) / 2;
    if (l.text.length > 2 && g.hRules.some((r) => coversX(r, mid) && r.yTop >= l.y - 0.3 && r.yBottom <= l.y + 0.72 * l.h)) out.push(`"${l.text}" (baseline ${l.y.toFixed(2)}) is drawn on / through a rule`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 1. The county blank, filled from the live map's shape.
// ---------------------------------------------------------------------------------------------
const yamhill = new Uint8Array(fs.readFileSync(path.join(REPO, "backend", "test", "fixtures", "yamhill-building-application.pdf")));
const yItems = await extractLabels(yamhill);
const yGeo = (await extractPageGeometry(yamhill))[0];
// The stored map as the vision pass + re-map left it (labels, sources, coordinates — no project data).
const P = (source: string, x: number, y: number, label: string, maxWidth?: number) => ({ source, page: 0, x, y, size: 9, ...(maxWidth ? { maxWidth } : {}), label });
const YAMHILL_PLACEMENTS = [
  P("lit:X", 47, 663, "Type of work: Addition/alteration"),
  P("lit:X", 302, 663, "Replacement Dwelling? No"),
  P("lit:X", 47, 620, "Category of construction: 1- and 2-family dwelling"),
  P("project.projectAddress", 91, 575, "Job site address:", 257),
  P("computed.cityStateZip", 91, 561, "City/State/Zip:", 257),
  P("snapshot.parcelNumber", 116, 532, "Tax map/parcel no.:", 233),
  P("computed.descriptionOfWork", 44, 504, "Description of work", 306),
  P("project.homeownerName", 83, 446, "Property Owner - Name:", 263),
  P("project.projectAddress", 89, 432, "Property Owner - Address:", 257),
  P("computed.cityStateZip", 91, 417, "Property Owner - City/State/Zip:", 257),
  P("snapshot.homeownerPhone", 83, 403, "Property Owner - Phone:", 104),
  P("snapshot.homeownerEmail", 230, 403, "Property Owner - E-mail:", 129),
  P("client.installerCompanyName", 83, 322, "Contractor - Name:", 263),
  P("client.installerStreet", 89, 307, "Contractor - Address:", 257),
  P("client.installerCityStateZip", 91, 293, "Contractor - City/State/Zip:", 257),
  P("client.installerPhone", 83, 278, "Contractor - Phone:", 257),
  P("client.installerEmail", 86, 264, "Contractor - E-mail:", 257),
  P("client.ccbLicenseNumber", 92, 249, "CCB lic:", 92),
  P("client.installerCompanyName", 83, 205, "Applicant - Name:", 263),
  P("client.installerStreet", 89, 191, "Applicant - Address:", 257),
  P("client.installerCityStateZip", 91, 176, "Applicant - City/State/Zip:", 257),
  P("client.installerPhone", 83, 162, "Applicant - Phone:", 104),
  P("client.installerEmail", 230, 162, "Applicant - E-mail:", 129),
  P("computed.estimatedJobValue", 428, 635, "Required data: Valuation:", 153),
];
const yamhillDef = (placements = YAMHILL_PLACEMENTS, verified = false): Def => ({
  id: "tmpl-yamhill-test", formName: "Building Permit Application — YAMHILL COUNTY", state: "OR", matchJurisdictions: ["example county"],
  sourceUrl: "", version: "stored", status: "verified", fillMode: "overlay", textFields: {}, checkboxes: {},
  overlayFields: placements, signatureFields: [], unverifiedMap: !verified, formTrack: "building",
});
const ctx = ctxWith();
const v = (source: string, c: Ctx = ctx) => resolveSource(source, c);
const YAMHILL_ROWS = [
  { label: "Job site address:", near: 578, value: v("project.projectAddress") },
  { label: "City/State/Zip:", near: 564, value: v("computed.cityStateZip") },
  { label: "Tax map/parcel no:", near: 535, value: v("snapshot.parcelNumber") },
  { label: "Name:", near: 449.5, value: v("project.homeownerName") },
  { label: "Address:", near: 435, value: v("project.projectAddress") },
  { label: "City/State/Zip:", near: 421, value: v("computed.cityStateZip") },
  { label: "Phone:", near: 407, value: v("snapshot.homeownerPhone") },
  { label: "Email:", near: 407, value: v("snapshot.homeownerEmail"), xNear: 200 },
  { label: "Name:", near: 327, value: v("client.installerCompanyName") },
  { label: "Address:", near: 312, value: v("client.installerStreet") },
  { label: "City/State/Zip:", near: 298, value: v("client.installerCityStateZip") },
  { label: "Phone:", near: 284, value: v("client.installerPhone") },
  { label: "E-mail:", near: 270, value: v("client.installerEmail") },
  { label: "CCB lic:", near: 255, value: v("client.ccbLicenseNumber") },
  { label: "Name:", near: 212.6, value: v("client.installerCompanyName") },
  { label: "Address:", near: 198, value: v("client.installerStreet") },
  { label: "City/State/Zip:", near: 184, value: v("client.installerCityStateZip") },
  { label: "Phone:", near: 170, value: v("client.installerPhone") },
  { label: "Email:", near: 170, value: v("client.installerEmail"), xNear: 200 },
  { label: "Valuation:", near: 635, value: v("computed.estimatedJobValue") },
];
/** The drawn lines in the blank rows under the DESCRIPTION OF WORK band, top first. */
function descriptionRows(lines: Line[]): { rows: number; text: string } {
  const header = yItems.find((i) => i.str.trim() === "DESCRIPTION OF WORK")!;
  const band = yGeo.bands.filter((b) => header.y >= b.y0 - 1 && header.y <= b.y1).sort((a, b) => a.y0 - b.y0)[0];
  const owner = yItems.find((i) => i.str.trim() === "PROPERTY OWNER")!;
  const inside = lines.filter((l) => l.y < band.y0 && l.y > owner.y + 10 && l.x < 355).sort((a, b) => b.y - a.y);
  return { rows: inside.length, text: inside.map((l) => l.text).join(" ") };
}

await check("fixture: the county blank is BLANK (no drawn text of ours) and prints the rows the checks read", () => {
  assert.ok(yItems.length > 100, `text layer: ${yItems.length}`);
  for (const name of ["Avery", "Sunward", "Example", "R4400"]) assert.ok(!yItems.some((i) => i.str.includes(name)), name);
  assert.ok(headerBands(yGeo, yItems).length >= 8, "the shaded section headers are read as header bands");
});

await check("resolvePlacementLabel: 'Applicant - Name:' at y=205 (drifted into the Address row) is the Name UNDER 'APPLICANT' (y=212.6), not Address (198.3)", () => {
  const L = resolvePlacementLabel(yItems, "Applicant - Name:", 0, { x: 83, y: 205 });
  assert.ok(L && L.str.trim() === "Name:" && Math.abs(L.y - 212.6) < 0.5, JSON.stringify(L));
  const owner = resolvePlacementLabel(yItems, "Property Owner - E-mail:", 0, { x: 230, y: 403 });
  assert.ok(owner && owner.str.trim() === "Email:" && Math.abs(owner.y - 407.1) < 0.5, `E-mail vs Email: ${JSON.stringify(owner)}`);
  const site = resolvePlacementLabel(yItems, "Job site address", 0, { x: 91, y: 575 });
  assert.equal(site?.str.trim(), "Job site address:", "a colon the map dropped is still the printed label");
  const valuation = resolvePlacementLabel(yItems, "Required data: Valuation:", 0, { x: 428, y: 635 });
  assert.ok(valuation && valuation.str.trim() === "Valuation:" && valuation.x > 360, JSON.stringify(valuation));
});

const yFilled = await fill(yamhillDef(), yamhill, ctx);
const yLines = await drawnLines(yFilled.bytes, yItems);
await check("THE FIX (county blank, unverified map): every value sits inside its label's row — 2-3pt above the row's rule, under the rule above, right of the label, never on a rule, never in a header band", () => {
  const bad = rowViolations(yGeo, yItems, yLines, YAMHILL_ROWS);
  assert.deepEqual(bad, [], bad.join("\n         "));
});
await check("THE FIX: the DESCRIPTION OF WORK header's blank rows carry the description of work, wrapped across them", () => {
  const d = descriptionRows(yLines);
  const want = v("computed.descriptionOfWork").replace(/\s+/g, " ").trim();
  assert.ok(want.length > 60, `fixture: a description long enough to wrap: ${want}`);
  assert.ok(d.rows >= 2, `wrapped over ${d.rows} row(s)`);
  assert.equal(d.text, want);
});
await check("THE FIX: the Tax map/parcel row holds the parcel number and nothing else — never the description", () => {
  const label = yItems.find((i) => i.str.trim() === "Tax map/parcel no:")!;
  const row = rowOf(yGeo, label);
  const inRow = yLines.filter((l) => l.y > row.bottom && l.y < row.top && l.x < 355);
  assert.deepEqual(inRow.map((l) => l.text), [v("snapshot.parcelNumber")]);
});
await check("MUST-EXCLUDE: a check mark (lit:X) is drawn exactly where release #11 drew it — in its box, not moved beside its caption", async () => {
  const off = await fill(yamhillDef(), yamhill, ctx, { FLAT_FORM_ROW_SNAP: "0" });
  const marks = (ls: Line[]) => ls.filter((l) => l.text === "X").map((l) => `${l.x.toFixed(1)},${l.y.toFixed(1)}`).sort();
  const offLines = await drawnLines(off.bytes, yItems);
  assert.equal(marks(yLines).length, 3, JSON.stringify(marks(yLines)));
  assert.deepEqual(marks(yLines), marks(offLines));
});
await check("POSITIVE CONTROL (the kill): with FLAT_FORM_ROW_SNAP=0 (release #11) the same predicate reports the live defects", async () => {
  const off = await fill(yamhillDef(), yamhill, ctx, { FLAT_FORM_ROW_SNAP: "0" });
  const offLines = await drawnLines(off.bytes, yItems);
  const bad = rowViolations(yGeo, yItems, offLines, YAMHILL_ROWS);
  assert.ok(bad.length >= 10, `the predicate must see the struck-through rows: ${bad.length}\n${bad.join("\n")}`);
  assert.ok(bad.some((b) => /on \/ through a rule/.test(b)), "struck-through values are seen");
  assert.notEqual(descriptionRows(offLines).text, v("computed.descriptionOfWork").replace(/\s+/g, " ").trim(), "release #11 left the description rows blank");
});

// A parcel box the map bound to the description (the pre-re-map map) takes the parcel number.
const parcelToDescription = YAMHILL_PLACEMENTS.map((p) => (p.label === "Tax map/parcel no.:" ? { ...p, source: "computed.descriptionOfWork" } : p));
await check("BINDING (unverified map): a 'Tax map/parcel no' placement bound to the description of work writes the PARCEL NUMBER there", async () => {
  const f = await fill(yamhillDef(parcelToDescription), yamhill, ctx);
  const lines = await drawnLines(f.bytes, yItems);
  const row = rowOf(yGeo, yItems.find((i) => i.str.trim() === "Tax map/parcel no:")!);
  const inRow = lines.filter((l) => l.y > row.bottom && l.y < row.top && l.x < 355).map((l) => l.text);
  assert.deepEqual(inRow, [v("snapshot.parcelNumber")]);
});
await check("BINDING: with no parcel number on the job the parcel row stays BLANK (and is named for the operator) — never the description", async () => {
  const noParcel = ctxWith({ parcelNumber: "" });
  const f = await fill(yamhillDef(parcelToDescription), yamhill, noParcel);
  const lines = await drawnLines(f.bytes, yItems);
  const row = rowOf(yGeo, yItems.find((i) => i.str.trim() === "Tax map/parcel no:")!);
  assert.deepEqual(lines.filter((l) => l.y > row.bottom && l.y < row.top && l.x < 355).map((l) => l.text), []);
  assert.ok(f.operatorItems.some((i) => /^Tax map\/parcel no/.test(i)), JSON.stringify(f.operatorItems));
});
await check("HARD RULE 3: on a VERIFIED map the person's binding stands (the description stays where they bound it) and the row snap only moves text within the cell the map's point names", async () => {
  const f = await fill(yamhillDef(parcelToDescription, true), yamhill, ctx);
  const lines = await drawnLines(f.bytes, yItems);
  const row = rowOf(yGeo, yItems.find((i) => i.str.trim() === "Tax map/parcel no:")!);
  const inRow = lines.filter((l) => l.y > row.bottom && l.y < row.top && l.x < 355).map((l) => l.text);
  assert.ok(!inRow.includes(v("snapshot.parcelNumber")) && inRow.some((t) => /^Install/.test(t)), `verified binding rebound: ${JSON.stringify(inRow)}`);
  // The owner's Name: the verified point (y=446) is ON the row's rule — the value moves up into that
  // row, and its x stays the map's (83).
  const nameRow = rowOf(yGeo, yItems.find((i) => i.str.trim() === "Name:" && Math.abs(i.y - 449.5) < 1)!);
  const name = lines.find((l) => l.text === v("project.homeownerName") && l.y > nameRow.bottom && l.y < nameRow.top);
  assert.ok(name, `verified owner name not inside its row: ${JSON.stringify(lines.filter((l) => l.text === v("project.homeownerName")))}`);
  assert.ok(Math.abs(name.x - 83) < 0.6, `verified x moved: ${name.x}`);
  assert.ok(name.y >= nameRow.bottom + 1.5, `still on the rule: ${name.y} vs ${nameRow.bottom}`);
});

// ---------------------------------------------------------------------------------------------
// 2. The binding rule at map time (sanitizePlacements — the same predicate as the fill).
// ---------------------------------------------------------------------------------------------
await check("captionSourceRule: parcel / tax lot / APN boxes take the parcel number; description boxes the description; size/area/address boxes and marks are left alone", () => {
  assert.equal(captionSourceRule("Tax map/parcel no.:", "computed.descriptionOfWork")?.source, "snapshot.parcelNumber");
  assert.equal(captionSourceRule("Map & Tax Lot", "project.projectAddress")?.source, "snapshot.parcelNumber");
  assert.equal(captionSourceRule("APN", "computed.cityStateZip")?.source, "snapshot.parcelNumber");
  assert.equal(captionSourceRule("DESCRIPTION OF WORK", "snapshot.parcelNumber")?.source, "computed.descriptionOfWork");
  assert.equal(captionSourceRule("Scope of work:", "project.projectAddress")?.source, "computed.descriptionOfWork");
  // MUST-EXCLUDE
  assert.equal(captionSourceRule("Tax map/parcel no:", "snapshot.parcelNumber"), null);
  assert.equal(captionSourceRule("Parcel size (acres)", "snapshot.lotAcres"), null);
  assert.equal(captionSourceRule("Site address or parcel #", "project.projectAddress"), null);
  assert.equal(captionSourceRule("Description of work", "computed.descriptionOfWorkLine1"), null);
  assert.equal(captionSourceRule("Description of work", "lit:Install roof-mounted photovoltaic system"), null);
  assert.equal(captionSourceRule("Parcel", "lit:X"), null);
  assert.equal(captionSourceRule("Name:", "project.homeownerName"), null);
});
await check("sanitizePlacements (acquisition): a parcel placement bound to the description is rebound to the parcel number, with a note", () => {
  const got = sanitizePlacements({
    widgets: [], items: yItems, state: "OR", textFields: {}, checkboxes: {},
    placements: [P("computed.descriptionOfWork", 116, 532, "Tax map/parcel no.:"), P("snapshot.parcelNumber", 44, 504, "Description of work")],
  });
  assert.deepEqual(got.placements.map((p) => p.source), ["snapshot.parcelNumber", "computed.descriptionOfWork"]);
  assert.ok(got.notes.some((t) => /parcel box takes/.test(t)), JSON.stringify(got.notes));
});

// ---------------------------------------------------------------------------------------------
// 3. A synthetic ruled page (no county file): labels, rules, shaded header bands, a cell divider.
// ---------------------------------------------------------------------------------------------
async function syntheticBlank(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const rule = (y: number, x0 = 36, x1 = 356) => page.drawRectangle({ x: x0, y: y - 0.35, width: x1 - x0, height: 0.7, color: rgb(0, 0, 0) });
  const band = (y0: number, text: string) => {
    page.drawRectangle({ x: 36, y: y0, width: 320, height: 14, color: rgb(0.85, 0.85, 0.85) });
    page.drawText(text, { x: 196 - bold.widthOfTextAtSize(text, 10) / 2, y: y0 + 3.5, size: 10, font: bold });
    rule(y0); rule(y0 + 14);
  };
  const label = (text: string, x: number, y: number) => page.drawText(text, { x, y, size: 9, font });
  // 18pt rows with the label centred in them (its baseline ~4.7pt over the rule): a value drawn on the
  // label's own baseline would float; the value belongs 2-3pt above the row's rule.
  band(704, "JOB SITE INFORMATION");
  label("Site address:", 40, 691); rule(686);
  label("Parcel no:", 40, 673); rule(668);
  band(654, "DESCRIPTION OF WORK");
  rule(640); rule(626); rule(612);
  band(598, "OWNER");
  label("Name:", 40, 589); rule(584);
  label("Phone:", 40, 571); label("Email:", 194, 571); rule(566);
  page.drawRectangle({ x: 189.65, y: 566, width: 0.7, height: 18, color: rgb(0, 0, 0) });
  // A few more printed words so the page reads as a text-layer form.
  for (const [i, t] of ["Example County", "Residential Building Permit Application", "Office use only"].entries()) label(t, 380, 760 - i * 14);
  return doc.save();
}
const syn = await syntheticBlank();
const sItems = await extractLabels(syn);
const sGeo = (await extractPageGeometry(syn))[0];
// A vision map's drift: every baseline 3.5pt low (ON the row's rule), a colon dropped, a section-
// qualified label, a header caption with no colon, the parcel box bound to the description.
const SYN_PLACEMENTS = [
  P("project.projectAddress", 100, 686.2, "Site address", 250),
  P("computed.descriptionOfWork", 90, 668.2, "Parcel no:", 250),
  P("computed.descriptionOfWork", 40, 676, "Description of work", 300),
  P("project.homeownerName", 80, 584.2, "OWNER - Name:", 250),
  P("snapshot.homeownerPhone", 80, 566.2, "OWNER - Phone:", 100),
  P("snapshot.homeownerEmail", 224, 566.2, "OWNER - E-mail:", 120),
];
const synDef = (verified = false): Def => ({ ...yamhillDef(SYN_PLACEMENTS, verified), id: "tmpl-synthetic", formName: "Synthetic ruled application" });
const SYN_ROWS = [
  { label: "Site address:", near: 691, value: v("project.projectAddress") },
  { label: "Parcel no:", near: 673, value: v("snapshot.parcelNumber") },
  { label: "Name:", near: 589, value: v("project.homeownerName") },
  { label: "Phone:", near: 571, value: v("snapshot.homeownerPhone") },
  { label: "Email:", near: 571, value: v("snapshot.homeownerEmail") },
];
await check("SYNTHETIC: header bands, rules and the cell divider are read off the drawing", () => {
  assert.equal(headerBands(sGeo, sItems).length, 3);
  assert.ok(sGeo.vRules.some((r) => Math.abs(r.x - 190) < 1), "the Phone | Email divider");
});
const sFilled = await fill(synDef(), syn, ctx);
const sLines = await drawnLines(sFilled.bytes, sItems);
await check("SYNTHETIC (unverified): every value inside its row, the phone stops at the cell divider, the parcel row holds the parcel number", () => {
  const bad = rowViolations(sGeo, sItems, sLines, SYN_ROWS);
  assert.deepEqual(bad, [], bad.join("\n         "));
  const phone = sLines.find((l) => l.text === v("snapshot.homeownerPhone"))!;
  assert.ok(phone.x1 <= 190, `the phone runs past the divider: ${phone.x1}`);
});
await check("SYNTHETIC: the description is wrapped across the blank rows under its header band, nothing in the bands", () => {
  const inside = sLines.filter((l) => l.y < 654 && l.y > 612).sort((a, b) => b.y - a.y);
  assert.equal(inside.map((l) => l.text).join(" "), v("computed.descriptionOfWork").replace(/\s+/g, " ").trim());
  assert.ok(inside.length >= 2, `rows used: ${inside.length}`);
  for (const l of inside) assert.ok([640, 626, 612].some((r) => l.y >= r + 0.35 + 1.5 && l.y <= r + 0.35 + 3.5), `description line baseline ${l.y} is not 2-3pt above a row rule`);
});
await check("SYNTHETIC POSITIVE CONTROL: FLAT_FORM_ROW_SNAP=0 fails the same predicate", async () => {
  const off = await fill(synDef(), syn, ctx, { FLAT_FORM_ROW_SNAP: "0" });
  const bad = rowViolations(sGeo, sItems, await drawnLines(off.bytes, sItems), SYN_ROWS);
  assert.ok(bad.length >= 2, `release #11 placement passed the predicate: ${bad.join(" | ")}`);
});
await check("SYNTHETIC (verified): a point ON a rule moves up into that row, x kept; the verified parcel binding stands", async () => {
  const f = await fill(synDef(true), syn, ctx);
  const lines = await drawnLines(f.bytes, sItems);
  const name = lines.find((l) => l.text === v("project.homeownerName"));
  assert.ok(name && name.y >= 584.35 + 1.5 && name.y <= 584.35 + 3.5 && Math.abs(name.x - 80) < 0.6, JSON.stringify(name));
  const parcelRow = lines.filter((l) => l.y > 668.35 && l.y < 685.65).map((l) => l.text);
  assert.ok(parcelRow.some((t) => /^Install/.test(t)), `verified binding rebound: ${JSON.stringify(parcelRow)}`);
});

console.log("");
if (failures) {
  console.error(`flatFormRowSnap: ${failures} FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`flatFormRowSnap: all ${passed} checks passed — flat-form values inside their rows (county blank + synthetic), header rows filled, parcel box = parcel number, verified maps keep their bindings`);
process.exit(0);
