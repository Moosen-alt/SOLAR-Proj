// AUTO-MAPPED FORMS: THE STREET LINE, THE OWNER'S MAILING ADDRESS, AND EVERY UNSIGNED LINE NAMED.
//
// #72 — Valencia County's printed row "MAILING ADDRESS | CITY | STATE | ZIP" (an unverified vision
// map) took the full one-line site address in its MAILING ADDRESS cell, so city, state and ZIP
// printed twice on that row. A street cell whose row has its own CITY / STATE / ZIP cells takes the
// street only; a lone SITE ADDRESS keeps the full address; an owner MAILING address reads the
// owner-mailing source (the install address unless the project records another — a recorded one
// wins). One engine rule for both mappers (sanitizeAcroMap, placements included) and for maps
// already stored (the flat fill, unverified maps only — a verified map is never rebound, hard rule 3).
//
// #73 — the same form's applicant signature line was left blank (correct: automation never invents
// a signature, hard rule 1) and named nowhere; only licence-holder lines got "Left unsigned". Every
// signature line left unsigned is named, whatever its role; its date line too.
//
// Synthetic names and addresses only.
//
//   npx tsx backend/test/addressRowAndUnsignedLines.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, PDFPage, StandardFonts } from "pdf-lib";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "address-row-unsigned-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.DOCUMENT_FETCH = "off";
process.env.AHJ_FORM_DOWNLOADS = "off";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.FLAT_FORM_ROW_SNAP;

const { fillLoadedForm, resolveSource } = await import("../src/ahjForms");
const { addressRowRebinds, placementRect, sanitizePlacements } = await import("../src/formFieldChecks");
const { AVAILABLE_FIELD_SOURCES } = await import("../src/ahjFormAuto");
const { createCanvas } = await import("@napi-rs/canvas");
type Def = Parameters<typeof fillLoadedForm>[0];
type Ctx = Parameters<typeof fillLoadedForm>[2];

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Every value the overlay draws, by the y it was drawn at.
const drawn: Array<{ text: string; x: number; y: number }> = [];
const drawText = PDFPage.prototype.drawText;
PDFPage.prototype.drawText = function (this: PDFPage, text: string, options?: Parameters<PDFPage["drawText"]>[1]) {
  drawn.push({ text, x: options?.x ?? 0, y: options?.y ?? 0 });
  return drawText.call(this, text, options);
};

// A synthetic flat blank: a lone SITE ADDRESS row, the Valencia-shaped owner row, and a signature row.
async function blank(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const label = (t: string, x: number, y: number) => page.drawText(t, { x, y, size: 7, font });
  label("PROJECT LOCATION / SITE ADDRESS", 22, 640);
  label("MAILING ADDRESS", 22, 580);
  label("CITY", 314, 580);
  label("STATE", 440, 580);
  label("ZIP", 512, 580);
  label("Signature", 22, 200);
  label("Date", 330, 200);
  return doc.save();
}

const P = (source: string, x: number, y: number, label: string, maxWidth?: number) => ({ source, page: 0, x, y, size: 9, ...(maxWidth ? { maxWidth } : {}), label });
// The stored map's shape (cbf69a52): the mailing cell bound to the site's one-line address.
const PLACEMENTS = [
  P("project.projectAddress", 22, 628, "PROJECT LOCATION / SITE ADDRESS", 400),
  P("project.projectAddress", 22, 568, "MAILING ADDRESS", 280),
  P("project.city", 314, 568, "CITY", 110),
  P("project.state", 440, 568, "STATE", 60),
  P("project.zip", 512, 568, "ZIP", 80),
];
type Sig = { role: string; page: number; x: number; y: number; width: number; height: number; label?: string; dateX?: number; dateY?: number };
const defOf = (verified: boolean, signatureFields: Sig[] = []): Def => ({
  id: "tmpl-address-row-test", formName: "Synthetic county permit application", state: "NM", matchJurisdictions: ["example county"], sourceUrl: "",
  version: "stored", status: verified ? "verified" : "unverified", fillMode: "overlay", textFields: {}, checkboxes: {}, overlayFields: PLACEMENTS,
  signatureFields, unverifiedMap: !verified, formTrack: "building",
});

const ctxOf = (snapshot: Record<string, unknown> = {}, signatures: Ctx["signatures"] = {}): Ctx => ({
  project: {
    id: "p-fictional", homeownerName: "Avery Quill", projectAddress: "1200 Example Orchard Rd, Fictionville, NM 87000", city: "Fictionville", state: "NM", zip: "87000",
    ahj: "Example County", systemSizeDcKw: 7.2, systemSizeAcKw: 6, utility: "Example Power",
  } as unknown as Ctx["project"],
  client: { installerCompanyName: "Sunward Example Solar LLC", installerPhone: "(505) 555-0142" },
  snapshot: { homeownerPhone: "5055550199", ...snapshot },
  signatures,
});

const blankBytes = await blank();
const fill = async (def: Def, ctx: Ctx, name: string) => {
  drawn.length = 0;
  const result = await fillLoadedForm(def, blankBytes, ctx, path.join(tmpDir, `${name}.pdf`));
  return { result, values: drawn.map((d) => ({ ...d })) };
};
// The value drawn on a row (within a few points of the placement's baseline), left to right.
const onRow = (values: Array<{ text: string; x: number; y: number }>, y: number) => values.filter((v) => Math.abs(v.y - y) < 8).sort((a, b) => a.x - b.x);
const leftmost = (values: Array<{ text: string; x: number; y: number }>, y: number) => onRow(values, y).filter((v) => v.x < 200).map((v) => v.text).join(" ");

// ---------------------------------------------------------------------------------------------
// #72 — the rule itself, the mappers' sanitisation, and the fill of a map already stored.
// ---------------------------------------------------------------------------------------------
await check("#72 rule: a MAILING ADDRESS cell with its own CITY / STATE / ZIP cells reads the owner's mailing street, and its row's parts the mailing parts", () => {
  const cells = PLACEMENTS.map((p, i) => ({ key: String(i), caption: p.label, source: p.source, page: p.page, rect: placementRect(p) }));
  const out = addressRowRebinds(cells);
  assert.equal(out.get("1")?.source, "computed.homeownerMailingStreet");
  assert.equal(out.get("2")?.source, "computed.homeownerMailingCity");
  assert.equal(out.get("3")?.source, "computed.homeownerMailingState");
  assert.equal(out.get("4")?.source, "computed.homeownerMailingZip");
  assert.equal(out.has("0"), false, "a lone SITE ADDRESS cell keeps the full address");
});

await check("#72 rule: a plain ADDRESS cell with its own CITY / STATE / ZIP cells takes the street only; a contractor's address is never touched", () => {
  const row = [
    { key: "a", caption: "Job Address", source: "computed.fullAddress", page: 0, rect: { x: 20, y: 400, width: 200, height: 14 } },
    { key: "c", caption: "City", source: "project.city", page: 0, rect: { x: 240, y: 401, width: 100, height: 14 } },
    { key: "k", caption: "Contractor Address", source: "client.installerStreet", page: 0, rect: { x: 20, y: 300, width: 200, height: 14 } },
    { key: "kc", caption: "City", source: "client.installerCityStateZip", page: 0, rect: { x: 240, y: 300, width: 100, height: 14 } },
    { key: "n", caption: "Address", source: "project.projectAddress", page: 1, rect: { x: 20, y: 400, width: 200, height: 14 } },
  ];
  const out = addressRowRebinds(row);
  assert.equal(out.get("a")?.source, "computed.streetAddress");
  assert.equal(out.has("c"), false, "a site City cell on a site row stands");
  assert.equal(out.has("k"), false, "a contractor's address is the contractor's");
  assert.equal(out.has("n"), false, "a City cell on ANOTHER page is not this row's");
});

await check("#72 mappers: a fresh vision map passes the same rule (sanitizePlacements → sanitizeAcroMap) and names what it rebound", () => {
  const checked = sanitizePlacements({ widgets: [], items: [], state: "NM", textFields: {}, checkboxes: {}, placements: PLACEMENTS });
  assert.deepEqual(checked.placements.map((p) => p.source), [
    "project.projectAddress", "computed.homeownerMailingStreet", "computed.homeownerMailingCity", "computed.homeownerMailingState", "computed.homeownerMailingZip",
  ]);
  assert.ok(checked.notes.some((n) => /MAILING ADDRESS.*rebound to computed\.homeownerMailingStreet/.test(n)), checked.notes.join(" | "));
});

await check("#72 mappers: both are OFFERED the street-only, owner-mailing and formatted-phone sources", () => {
  const offered = AVAILABLE_FIELD_SOURCES.map((s) => s.split(/\s{2,}/)[0]);
  for (const s of ["computed.streetAddress", "computed.homeownerMailingStreet", "computed.homeownerMailingCity", "computed.homeownerMailingState",
    "computed.homeownerMailingZip", "computed.homeownerMailingCityStateZip", "computed.homeownerMailingFullAddress", "computed.homeownerPhone"]) {
    assert.ok(offered.includes(s), `${s} is not offered`);
  }
  assert.ok(!offered.includes("snapshot.homeownerPhone"), "the raw phone is offered beside the formatted one");
  assert.equal(resolveSource("computed.homeownerPhone", ctxOf()), "(505) 555-0199");
});

await check("#72 fill (stored unverified map): the MAILING ADDRESS cell draws the street only; SITE ADDRESS keeps the full address", async () => {
  const { values } = await fill(defOf(false), ctxOf(), "unverified-default");
  assert.equal(leftmost(values, 568), "1200 Example Orchard Rd", `mailing row: ${JSON.stringify(onRow(values, 568))}`);
  assert.deepEqual(onRow(values, 568).map((v) => v.text), ["1200 Example Orchard Rd", "Fictionville", "NM", "87000"]);
  assert.equal(leftmost(values, 628), "1200 Example Orchard Rd, Fictionville, NM 87000", "the lone site cell keeps the full address");
});

await check("#72 fill: a RECORDED owner mailing address wins on the mailing row — street and its City / State / ZIP alike", async () => {
  const { values } = await fill(defOf(false), ctxOf({ homeownerMailingAddress: "PO Box 77", homeownerMailingCityStateZip: "Otherton, NM 87002" }), "unverified-recorded");
  assert.deepEqual(onRow(values, 568).map((v) => v.text), ["PO Box 77", "Otherton", "NM", "87002"]);
  assert.match(leftmost(values, 628), /^1200 Example Orchard Rd/, "the site cell is still the site");
});

await check("#72 MUST-EXCLUDE (hard rule 3): a VERIFIED map's binding is drawn as a person verified it", async () => {
  const { values } = await fill(defOf(true), ctxOf({ homeownerMailingAddress: "PO Box 77", homeownerMailingCityStateZip: "Otherton, NM 87002" }), "verified");
  assert.match(leftmost(values, 568), /^1200 Example Orchard Rd, Fictionville/, `verified mailing cell was rebound: ${JSON.stringify(onRow(values, 568))}`);
  assert.ok(onRow(values, 568).some((v) => v.text === "Fictionville"), "the verified City cell stays the site's city");
});

// ---------------------------------------------------------------------------------------------
// #73 — a signature line left unsigned is named, whatever its role.
// ---------------------------------------------------------------------------------------------
const inkPng = (): Uint8Array => {
  const c = createCanvas(160, 48);
  const g = c.getContext("2d");
  g.strokeStyle = "#000"; g.lineWidth = 3;
  g.beginPath(); g.moveTo(8, 38); g.bezierCurveTo(40, 4, 80, 44, 150, 10); g.stroke();
  return new Uint8Array(c.toBuffer("image/png"));
};
const APPLICANT: Sig = { role: "applicant", page: 0, x: 60, y: 196, width: 150, height: 16, label: "Signature", dateX: 360, dateY: 200 };
const OWNER: Sig = { role: "owner", page: 0, x: 60, y: 150, width: 150, height: 16, label: "Owner Signature" };

await check("#73: an APPLICANT line with no signature on file is left unsigned AND named — in the blanks and the \"Left unsigned:\" message, with its date line", async () => {
  const { result, values } = await fill(defOf(false, [APPLICANT]), ctxOf(), "applicant-unsigned");
  const item = (result.unmappedRequested ?? []).find((l) => /Signature \(applicant\)/.test(l)) ?? "";
  assert.match(item, /no applicant signature on file; the line is left unsigned \(sign it by hand, or add an applicant signature under Signatures and rebuild\)/, JSON.stringify(result.unmappedRequested));
  assert.match(item, /date line is left blank too/);
  assert.match(String(result.message), /Left unsigned: Signature \(applicant\)/);
  assert.ok(!values.some((v) => Math.abs(v.y - 200) < 2 && v.x > 300), "hard rule 1: a date was written on an unsigned line");
});

await check("#73: an OWNER line is never signed automatically — and is named, even with an applicant signature on file", async () => {
  const sigs = { applicant: { bytes: inkPng(), mime: "image/png", widthPx: 160, heightPx: 48, name: "Ada Submitter" } } as Ctx["signatures"];
  const { result } = await fill(defOf(false, [APPLICANT, OWNER]), ctxOf({}, sigs), "owner-named");
  const items = result.unmappedRequested ?? [];
  assert.ok(items.some((l) => /^Owner Signature \(owner\) — the property owner signs this line by hand/.test(l)), JSON.stringify(items));
  assert.ok(!items.some((l) => /\(applicant\)/.test(l)), "MUST-PASS: the applicant signed — nothing owed on that line");
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) { console.error(`addressRowAndUnsignedLines: ${failures} check(s) FAILED`); process.exit(1); }
console.log(`addressRowAndUnsignedLines: all ${passed} checks passed`);
