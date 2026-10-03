// FLAT FORMS: A VERIFIED MAP IS DRAWN EXACTLY AS RELEASE #11 DREW IT (issue #39, hard rule 3).
//
// PR #37 (issue #10) taught the overlay to read caption cells, side lines, underscore blanks,
// checkboxes and sideways pages, and to shrink-then-withhold a value wider than its maxWidth. Some of
// that ran on human-VERIFIED maps too: glyphs turned on a sideways page (and the value re-anchored in
// the turned frame), a caption highlight's edges dropped from the rules a verified point-row reads
// (a contact name on Valencia's agent row moved 470pt right), and maxWidth shrinking to 6pt instead
// of release #11's plain cut — the last also under FLAT_FORM_ROW_SNAP=0, so "=0" was not a revert.
//
// Every page.drawText the overlay makes is recorded (text, x, y, size, glyph angle — which fixes each
// glyph box) and compared with the PRE-#37 ledger below, captured by running this same set of fills
// on the parent of 4c04768 (release #11 + the row snap of #22). Marks are included. Covered:
//   - each public fixture (Yamhill, Valencia, ABQ upright, ABQ laid on its side) with a VERIFIED map,
//     row snap on and FLAT_FORM_ROW_SNAP=0;
//   - each fixture with an UNVERIFIED map under FLAT_FORM_ROW_SNAP=0 (the full revert).
// Every value is fictional; the maps are shaped like the live ones, with a few maxWidths tight enough
// to cut.
//
//   npx tsx backend/test/flatFormVerifiedParity.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, PDFPage, StandardFonts, degrees } from "pdf-lib";
import { REPO } from "./_isolate";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flat-form-verified-parity-"));
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

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Every drawText on any page: [text, x, y, size, glyph angle in degrees].
type Call = [string, number, number, number, number];
const ledger: Call[] = [];
const drawText = PDFPage.prototype.drawText;
PDFPage.prototype.drawText = function (this: PDFPage, text: string, options?: Parameters<PDFPage["drawText"]>[1]) {
  const rot = options?.rotate as { angle?: number } | undefined;
  ledger.push([text, options?.x ?? 0, options?.y ?? 0, options?.size ?? 0, rot?.angle ?? 0]);
  return drawText.call(this, text, options);
};
const r3 = (n: number) => Math.round(n * 1000) / 1000;

const ctx: Ctx = {
  project: {
    id: "p-fictional", homeownerName: "Avery Quill", projectAddress: "1200 Example Orchard Rd", city: "Fictionville", state: "NM", zip: "87000",
    ahj: "Example County", systemSizeDcKw: 10.25, systemSizeAcKw: 8, utility: "Example Power",
  } as unknown as Ctx["project"],
  client: {
    installerCompanyName: "Sunward Example Solar LLC", installerContactName: "Jordan Sample", installerStreet: "55 Sample Industrial Way",
    installerCityStateZip: "Testburg, NM 87001", installerPhone: "(505) 555-0142", installerEmail: "permits@sunward.example",
    stateContractorLicense: "999001", ccbLicenseNumber: "999001",
  },
  snapshot: {
    parcelNumber: "R4400-00-12345", homeownerPhone: "(505) 555-0199", homeownerEmail: "avery@example.com", legalDescription: "Lot 7, Example Subdivision",
    moduleQuantity: "25", roofMounted: "yes", mountType: "roof",
  },
};
const P = (source: string, x: number, y: number, label: string, maxWidth?: number) => ({ source, page: 0, x, y, size: 9, ...(maxWidth ? { maxWidth } : {}), label });
const defOf = (placements: ReturnType<typeof P>[], verified: boolean): Def => ({
  id: "tmpl-parity-test", formName: "Verified parity test form", state: "NM", matchJurisdictions: ["example county"], sourceUrl: "", version: "stored",
  status: "verified", fillMode: "overlay", textFields: {}, checkboxes: {}, overlayFields: placements, signatureFields: [], unverifiedMap: !verified, formTrack: "building",
});
const fixture = (f: string) => new Uint8Array(fs.readFileSync(path.join(REPO, "backend", "test", "fixtures", f)));

const YAMHILL = [
  P("lit:X", 47, 663, "Type of work: Addition/alteration"),
  P("lit:X", 302, 663, "Replacement Dwelling? No"),
  P("project.projectAddress", 91, 575, "Job site address:", 257),
  P("computed.cityStateZip", 91, 561, "City/State/Zip:", 257),
  P("snapshot.homeownerPhone", 83, 403, "Property Owner - Phone:", 104),
  P("snapshot.homeownerEmail", 230, 403, "Property Owner - E-mail:", 129),
  P("client.installerCompanyName", 83, 322, "Contractor - Name:", 263),
  // Tight maxWidths: release #11 cuts to a 1-2 character stub at the map's size.
  P("client.ccbLicenseNumber", 92, 249, "CCB lic:", 12),
  P("project.homeownerName", 83, 446, "Property Owner - Name:", 10),
];
const VALENCIA = [
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
const ABQ = [
  P("project.projectAddress", 170, 494, "CONSTRUCTION ADDRESS:"),
  P("snapshot.legalDescription", 135, 478, "LEGAL DESCRIPTION:"),
  P("project.homeownerName", 80, 363, "OWNER: NAME"),
  P("project.zip", 80, 341, "OWNER: ZIP"),
  P("snapshot.homeownerPhone", 262, 341, "OWNER: PHONE"),
  P("client.stateContractorLicense", 216, 133, "NM STATE LICENSE #"),
  P("lit:X", 514, 451, "TYPE OF APPLICATION: RESIDENTIAL"),
  P("lit:X", 390, 89, "DESCRIPTION OF WORK: SINGLE FAMILY RESIDENCE"),
];
const abq = fixture("abq-eplan-application.pdf");
// The ABQ page laid on its side on an upright 612×792 page (/Rotate 0), as flatFormCellsSideways builds it.
async function sidewaysBlank(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const [embedded] = await doc.embedPdf(abq, [0]);
  doc.addPage([612, 792]).drawPage(embedded, { x: 612, y: 0, rotate: degrees(90) });
  await doc.embedFont(StandardFonts.Helvetica);
  return doc.save();
}
const SIDEWAYS = ABQ.map((p) => ({ ...p, x: 612 - p.y, y: p.x }));

// THE PRE-#37 LEDGER: every drawText of each fill below on the parent of 4c04768 (coordinates to 0.001pt).
const PRE_37: Record<string, Call[]> = {
  "yamhill|verified|snap=1": [
    ["X", 47, 663, 9, 0],
    ["X", 302, 663, 9, 0],
    ["1200 Example Orchard Rd", 114.707, 577.66, 9, 0],
    ["Fictionville, NM 87000", 103.223, 563.38, 9, 0],
    ["(505) 555-0199", 83, 405.63, 9, 0],
    ["avery@example.com", 230, 405.63, 9, 0],
    ["Sunward Example Solar LLC", 83, 325.69, 9, 0],
    ["999001", 79.238, 254.69, 9, 0],
    ["Avery Quill", 83, 448.35, 9, 0],
  ],
  "yamhill|verified|snap=0": [
    ["X", 47, 663, 9, 0],
    ["X", 302, 663, 9, 0],
    ["1200 Example Orchard Rd", 114.707, 578.14, 9, 0],
    ["Fictionville, NM 87000", 103.223, 563.86, 9, 0],
    ["(505) 555-0199", 83, 403, 9, 0],
    ["avery@example.com", 230, 403, 9, 0],
    ["Sunward Example Solar LLC", 83, 322, 9, 0],
    ["99", 79.238, 255.29, 9, 0],
    ["A", 83, 446, 9, 0],
  ],
  "yamhill|unverified|snap=0": [
    ["X", 47, 663, 9, 0],
    ["X", 302, 663, 9, 0],
    ["1200 Example Orchard Rd", 114.707, 578.14, 9, 0],
    ["Fictionville, NM 87000", 103.223, 563.86, 9, 0],
    ["(505) 555-0199", 83, 403, 9, 0],
    ["avery@example.com", 230, 403, 9, 0],
    ["Sunward Example Solar LLC", 83, 322, 9, 0],
    ["99", 79.238, 255.29, 9, 0],
    ["A", 83, 446, 9, 0],
  ],
  "valencia|verified|snap=1": [
    ["1200 Example Orchard Rd", 20.16, 633.7, 7.972, 0],
    ["Install roof-mounted photovoltaic solar system, 10.25 kW DC.", 259.85, 633.7, 7.972, 0],
    ["Avery Quill", 165.29, 607.3, 9, 0],
    ["(505) ", 406.9, 607.66, 9, 0],
    ["1200 Example Orchard Rd", 20.16, 579.58, 6.472, 0],
    ["Fictionville", 312.67, 579.58, 9, 0],
    ["NM", 438.7, 579.58, 9, 0],
    ["87000", 510.72, 579.58, 9, 0],
    ["Jordan Sample", 50, 521, 9, 0],
    ["(505) 555-0142", 406.9, 607.66, 9, 0],
    ["Sunward Example Solar L", 519.622, 520.63, 6, 0],
    ["X", 345, 648, 9, 0],
  ],
  "valencia|verified|snap=0": [
    ["1200 Example Orchard Rd", 20.16, 634.06, 9, 0],
    ["Install roof-mount", 259.85, 634.06, 9, 0],
    ["Avery Quill", 165.29, 607.66, 9, 0],
    ["(505) ", 406.9, 607.66, 9, 0],
    ["1200 Example O", 20.16, 579.94, 9, 0],
    ["Fictionville", 312.67, 579.94, 9, 0],
    ["NM", 438.7, 579.94, 9, 0],
    ["87000", 510.72, 579.94, 9, 0],
    ["Jordan Sample", 50, 521, 9, 0],
    ["(505) 555-0142", 406.9, 607.66, 9, 0],
    ["Sunward Example Solar LLC", 388, 521, 9, 0],
    ["X", 345, 648, 9, 0],
  ],
  "valencia|unverified|snap=0": [
    ["1200 Example Orchard Rd", 20.16, 634.06, 9, 0],
    ["Install roof-mount", 259.85, 634.06, 9, 0],
    ["Avery Quill", 165.29, 607.66, 9, 0],
    ["(505) ", 406.9, 607.66, 9, 0],
    ["1200 Example O", 20.16, 579.94, 9, 0],
    ["Fictionville", 312.67, 579.94, 9, 0],
    ["NM", 438.7, 579.94, 9, 0],
    ["87000", 510.72, 579.94, 9, 0],
    ["Jordan Sample", 50, 521, 9, 0],
    ["(505) 555-0142", 406.9, 607.66, 9, 0],
    ["Sunward Example Solar LLC", 388, 521, 9, 0],
    ["X", 345, 648, 9, 0],
  ],
  "abq|verified|snap=1": [
    ["1200 Example Orchard Rd", 170.153, 495.48, 9, 0],
    ["Lot 7, Example Subdivision", 136.424, 479.28, 9, 0],
    ["Avery Quill", 80, 363, 9, 0],
    ["87000", 80, 341.721, 9, 0],
    ["(505) 555-0199", 262, 341.721, 9, 0],
    ["999001", 215.433, 134.04, 9, 0],
    ["X", 514, 451, 9, 0],
    ["X", 390, 89, 9, 0],
  ],
  "abq|verified|snap=0": [
    ["1200 Example Orchard Rd", 170.153, 495.48, 9, 0],
    ["Lot 7, Example Subdivision", 136.424, 479.28, 9, 0],
    ["Avery Quill", 80, 363, 9, 0],
    ["87000", 80, 341, 9, 0],
    ["(505) 555-0199", 262, 341, 9, 0],
    ["999001", 215.433, 134.04, 9, 0],
    ["X", 514, 451, 9, 0],
    ["X", 390, 89, 9, 0],
  ],
  "abq|unverified|snap=0": [
    ["1200 Example Orchard Rd", 170.153, 495.48, 9, 0],
    ["Lot 7, Example Subdivision", 136.424, 479.28, 9, 0],
    ["Avery Quill", 80, 363, 9, 0],
    ["87000", 80, 341, 9, 0],
    ["(505) 555-0199", 262, 341, 9, 0],
    ["999001", 215.433, 134.04, 9, 0],
    ["X", 514, 451, 9, 0],
    ["X", 390, 89, 9, 0],
  ],
  "abqSide|verified|snap=1": [
    ["1200 Example Orchard Rd", 239.633, 47.04, 9, 0],
    ["Lot 7, Example Subdivision", 234.584, 34.56, 9, 0],
    ["Avery Quill", 249, 80, 9, 0],
    ["87000", 271, 80, 9, 0],
    ["(505) 555-0199", 271, 262, 9, 0],
    ["999001", 571.593, 121.8, 9, 0],
    ["X", 161, 514, 9, 0],
    ["X", 523, 390, 9, 0],
  ],
  "abqSide|verified|snap=0": [
    ["1200 Example Orchard Rd", 239.633, 47.04, 9, 0],
    ["Lot 7, Example Subdivision", 234.584, 34.56, 9, 0],
    ["Avery Quill", 249, 80, 9, 0],
    ["87000", 271, 80, 9, 0],
    ["(505) 555-0199", 271, 262, 9, 0],
    ["999001", 571.593, 121.8, 9, 0],
    ["X", 161, 514, 9, 0],
    ["X", 523, 390, 9, 0],
  ],
  "abqSide|unverified|snap=0": [
    ["1200 Example Orchard Rd", 239.633, 47.04, 9, 0],
    ["Lot 7, Example Subdivision", 234.584, 34.56, 9, 0],
    ["Avery Quill", 249, 80, 9, 0],
    ["87000", 271, 80, 9, 0],
    ["(505) 555-0199", 271, 262, 9, 0],
    ["999001", 571.593, 121.8, 9, 0],
    ["X", 161, 514, 9, 0],
    ["X", 523, 390, 9, 0],
  ],
};

const forms: Array<[string, Uint8Array, ReturnType<typeof P>[]]> = [
  ["yamhill", fixture("yamhill-building-application.pdf"), YAMHILL],
  ["valencia", fixture("valencia-multi-purpose-permit-application.pdf"), VALENCIA],
  ["abq", abq, ABQ],
  ["abqSide", await sidewaysBlank(), SIDEWAYS],
];
const runs: Array<{ verified: boolean; snap: "1" | "0"; what: string }> = [
  { verified: true, snap: "1", what: "a VERIFIED map, row snap on" },
  { verified: true, snap: "0", what: "a VERIFIED map, FLAT_FORM_ROW_SNAP=0" },
  { verified: false, snap: "0", what: "an UNVERIFIED map, FLAT_FORM_ROW_SNAP=0 (the full revert)" },
];
let k = 0;
for (const [name, blank, placements] of forms) {
  for (const run of runs) {
    const key = `${name}|${run.verified ? "verified" : "unverified"}|snap=${run.snap}`;
    await check(`${name}, ${run.what}: every value and mark drawn exactly as before #37 (text, x, y, size, glyph angle)`, async () => {
      process.env.FLAT_FORM_ROW_SNAP = run.snap;
      ledger.length = 0;
      try {
        const res = await fillLoadedForm(defOf(placements, run.verified), blank, ctx, path.join(tmpDir, `filled-${++k}.pdf`));
        assert.equal(res.status, "filled", `fill failed: ${res.message}`);
      } finally {
        delete process.env.FLAT_FORM_ROW_SNAP;
      }
      const got = ledger.map(([t, x, y, s, a]) => [t, r3(x), r3(y), r3(s), a]);
      const want = PRE_37[key];
      assert.ok(want && want.length, `fixture: no pre-#37 ledger for ${key}`);
      assert.ok(want.some((c) => c[0] === "X"), `fixture: ${key} draws no mark`);
      assert.deepEqual(got, want);
    });
  }
}

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) {
  console.error(`flatFormVerifiedParity: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log(`flatFormVerifiedParity: all ${passed} checks passed — verified maps and FLAT_FORM_ROW_SNAP=0 draw exactly what release #11 drew`);
