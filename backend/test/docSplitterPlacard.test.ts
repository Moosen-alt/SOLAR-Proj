// THE PLACARD / DIRECTORY SHEET IS SPLIT INTO THE LABELS PART (#67).
//
// A plan set's PV-9 sheet named "PLACARD" (body: "LABELING NOTES", "DIRECTORY PERMANENT PLAQUE OR
// DIRECTORY …", NEC 690.56 and 705.10) scored 0 in every category, so it was left unclassified and
// the labels part shipped with the LABELS sheet alone. PLACARD now counts toward labels as a
// `words` hit. What it must not do: pull in the sheet-index cover that lists "PV-9 PLACARD", an SLD
// or site plan whose notes mention a placard (they tie at best; the tie goes to the earlier
// category), or an electrical NOTES sheet (E 1.2) that says "PROVIDE PLACARD" (#33 rule).
// Synthetic plan set, browser-free. Run: tsx backend/test/docSplitterPlacard.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so filled/ docs/ page-images never land in the repo's backend/data
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-splitter-placard-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0"; // deterministic tests — no background autopilot
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { createProject } = await import("../src/repository");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { buildUtilityPackage } = await import("../src/docSplitter");

const db = await openDatabase();

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

// Synthetic plan set, one sheet per page (1-based page numbers in the comments).
const SHEETS: string[][] = [
  // 1: the sheet-index cover; it lists every sheet name, PLACARD included.
  ["PV-0 Sheet Name COVER SHEET", "SHEET INDEX: PV-1 SITE PLAN, PV-4 ONE-LINE DIAGRAM, PV-8 LABELS, PV-9 PLACARD"],
  // 2: a site plan whose notes mention the placard.
  ["PV-1 Sheet Name SITE PLAN", "NOTE: PROVIDE PLACARD AT MAIN SERVICE PER NEC 705.10"],
  // 3: an SLD whose notes mention the placard and the directory plaque.
  ["PV-4 Sheet Name ONE-LINE DIAGRAM", "PLACARD NOTE: PERMANENT PLAQUE OR DIRECTORY PER NEC 690.56"],
  // 4: the LABELS sheet.
  ["PV-8 Sheet Name LABELS", "WARNING LABELS", "LABEL LOCATION: MAIN SERVICE PANEL"],
  // 5: the PLACARD sheet — the directory plaque.
  ["PV-9 Sheet Name PLACARD", "LABELING NOTES",
    "DIRECTORY PERMANENT PLAQUE OR DIRECTORY PROVIDING THE LOCATION OF THE SERVICE DISCONNECTING MEANS",
    "PER NEC 690.56(B) AND 705.10"],
  // 6: an electrical notes sheet that says to provide a placard.
  ["E 1.2 Sheet Name NOTES", "1. PROVIDE PLACARD AT POINT OF INTERCONNECTION PER NEC 705.10."],
];
const COVER = 1, SITE = 2, SLD = 3, LABELS = 4, PLACARD = 5, NOTES = 6;

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (const lines of SHEETS) {
  const page = pdf.addPage([792, 612]);
  lines.forEach((line, i) => page.drawText(line, { x: 40, y: 560 - i * 28, size: 10, font }));
}

const detail = createProject(db, {
  owner: "Placard Test", street: "9 Placard Way", city: "Salem", state: "OR", zip: "97301",
  ahj: "City of Placards", utility: "PGE", dcKw: "6.6",
});
saveProjectDocument(db, detail.project.id, {
  docType: "plan_set", filename: "placard-plan-set.pdf", contentType: "application/pdf",
  buffer: Buffer.from(await pdf.save()), source: "upload",
});

const result = await buildUtilityPackage(db, detail.project.id, "all");
const pages = (t: string) => result.parts.find((p) => p.docType === t)?.pages ?? [];
const parts = JSON.stringify(result.parts.map((p) => [p.docType, p.pages]));

run("THE POINT: the PLACARD sheet is in the labels part", pages("labels").includes(PLACARD), parts);
run("the LABELS sheet is still in the labels part", pages("labels").includes(LABELS), parts);
run("the labels part is exactly the LABELS and PLACARD sheets", JSON.stringify(pages("labels")) === JSON.stringify([LABELS, PLACARD]), parts);
run("the sheet-index cover listing PV-9 PLACARD stays unclassified", result.unclassifiedPages.includes(COVER), JSON.stringify(result.unclassifiedPages));
run("a site plan whose notes mention a placard stays the site plan", pages("site_plan").includes(SITE) && !pages("labels").includes(SITE), parts);
run("an SLD whose notes mention a placard / directory plaque stays the SLD", pages("sld").includes(SLD) && !pages("labels").includes(SLD), parts);
run("an E 1.2 NOTES sheet that says PROVIDE PLACARD stays unclassified", result.unclassifiedPages.includes(NOTES), JSON.stringify(result.unclassifiedPages));

// Close before deleting the scratch DB - Windows holds the open handle as a file lock (EBUSY).
db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} doc-splitter-placard test(s) FAILED.`); process.exit(1); }
console.log("\nAll doc-splitter-placard tests passed.");
process.exit(0);
