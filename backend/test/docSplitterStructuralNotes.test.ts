// An electrical NOTES sheet ("E 1.2 NOTES") routinely carries a "STRUCTURAL NOTES" block (design
// loads, rafter spacing). The bare /STRUCTURAL/ pattern and the roof vocabulary used to score that
// page structural, and with no electrical pattern naming E 1.2 it was filed into the `structural`
// split part — a non-structural page inflating the structural upload (#33). On a page whose sheet
// number is electrical (E x.x) only a structural sheet NAME counts; the real S 1.1 sheet still
// classifies structural.
// Browser-free. Run: tsx backend/test/docSplitterStructuralNotes.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so filled/ docs/ page-images never land in the repo's backend/data
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-splitter-structural-notes-test-"));
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
  // 1: the structural sheet — wins on its names (S 1.1, MOUNT DETAIL).
  ["S 1.1 MOUNT DETAIL", "LAG SCREW INTO RAFTER", "STRUCTURAL ATTACHMENT PER MANUFACTURER"],
  // 2: the electrical notes sheet with a STRUCTURAL NOTES block that names rafters and trusses.
  ["E 1.2 NOTES", "ELECTRICAL NOTES: 1. ALL CONDUCTORS COPPER UNLESS NOTED.",
    "STRUCTURAL NOTES: 1. ROOF LIVE LOAD = 20 PSF. 2. RAFTER SPACING 24 IN O.C.",
    "3. TRUSS CAPACITY VERIFIED BY CONTRACTOR. 4. STRUCTURAL ENGINEER NOT REQUIRED."],
  // 3: the SLD, so the package has a second electrical sheet.
  ["E 1.1 ELECTRICAL LINE DIAGRAM", "MICROINVERTER BRANCH CIRCUIT"],
];
const NOTES_PAGE = 2, STRUCT_PAGE = 1;

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (const lines of SHEETS) {
  const page = pdf.addPage([792, 612]);
  lines.forEach((line, i) => page.drawText(line, { x: 40, y: 560 - i * 28, size: 10, font }));
}

const detail = createProject(db, {
  owner: "Notes Test", street: "12 Notes Way", city: "Salem", state: "OR", zip: "97301",
  ahj: "City of Notes", utility: "PGE", dcKw: "6.6",
});
saveProjectDocument(db, detail.project.id, {
  docType: "plan_set", filename: "notes-plan-set.pdf", contentType: "application/pdf",
  buffer: Buffer.from(await pdf.save()), source: "upload",
});

const result = await buildUtilityPackage(db, detail.project.id, "all");
const pages = (t: string) => result.parts.find((p) => p.docType === t)?.pages ?? [];

run("the E 1.2 NOTES page is not in the structural part", !pages("structural").includes(NOTES_PAGE), JSON.stringify(result.parts));
run("the S 1.1 MOUNT DETAIL page is still in the structural part", pages("structural").includes(STRUCT_PAGE), JSON.stringify(pages("structural")));
run("the E 1.2 NOTES page is unclassified (no electrical category names it)", result.unclassifiedPages.includes(NOTES_PAGE), JSON.stringify(result.unclassifiedPages));
run("the SLD still splits", pages("sld").includes(3), JSON.stringify(pages("sld")));

// Close before deleting the scratch DB - Windows holds the open handle as a file lock (EBUSY).
db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} doc-splitter-structural-notes test(s) FAILED.`); process.exit(1); }
console.log("\nAll doc-splitter-structural-notes tests passed.");
process.exit(0);
