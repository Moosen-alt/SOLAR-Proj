// The spec parts are matched by the title-block SHEET NAME only (#66). Two ways that broke:
//   - a WIRING CALCULATIONS sheet (PV-7) carries text tables headed "INVERTER SPECIFICATIONS" and
//     "PV MODULE SPECIFICATIONS"; the bare /INVERTER SPECIFICATIONS/ pattern matched the table
//     heading, it was the page's only hit, and the calcs sheet shipped as inverter_spec;
//   - "EQUIPMENT SPECIFICATION" pages (PV-11+) are image cut-sheets whose only text is the title
//     block. The AC-module datasheet, the combiner and the racking brochure all read the same, so
//     all three were filed as module_spec (and a tie-break kept them out of inverter_spec only by
//     array order).
// A title-only EQUIPMENT SPECIFICATION page cannot be told apart from its text, so the split must
// say it could not decide (undecidedSpecPages) rather than guess — and the dedicated, named spec
// sheets must still split.
// Browser-free. Run: tsx backend/test/docSplitterSpecSheets.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so filled/ docs/ page-images never land in the repo's backend/data
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-splitter-spec-sheets-test-"));
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

// The title block every sheet carries (synthetic contractor/site). An EQUIPMENT SPECIFICATION
// page has nothing else: its body is a raster datasheet, drawn here as a filled box.
// The text layer joins the title block's lines, so whether "SHEET NUMBER" lands right after the
// sheet name depends on the block's layout; `numberFirst` flips it so no check leans on that.
const titleBlock = (sheet: string, name: string, numberFirst = false) => numberFirst
  ? ["SYNTH SOLAR CO  123 FIXTURE RD", `SHEET NUMBER: ${sheet}`, `SHEET NAME: ${name}`]
  : ["SYNTH SOLAR CO  123 FIXTURE RD", `SHEET NAME: ${name}`, `SHEET NUMBER: ${sheet}`];
type Sheet = { lines: string[]; image?: boolean };
const mkPdf = async (sheets: Sheet[]): Promise<Buffer> => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const s of sheets) {
    const page = pdf.addPage([1224, 792]);
    if (s.image) page.drawRectangle({ x: 40, y: 120, width: 760, height: 620, color: rgb(0.85, 0.85, 0.85) });
    s.lines.forEach((line, i) => page.drawText(line, { x: 820, y: 740 - i * 20, size: 8, font }));
  }
  return Buffer.from(await pdf.save());
};
let n = 0;
const projectWith = async (sheets: Sheet[]) => {
  const p = createProject(db, {
    owner: `Spec Owner ${++n}`, street: `${n} Spec Way`, city: "Los Lunas", state: "NM", zip: "87031",
    ahj: "Village of Fixture", utility: "PNM", dcKw: "7.2",
  }).project;
  saveProjectDocument(db, p.id, {
    docType: "plan_set", filename: `spec-plan-set-${n}.pdf`, contentType: "application/pdf",
    buffer: await mkPdf(sheets), source: "upload",
  });
  return p.id;
};

// ---------------------------------------------------------------------------
console.log("\n1. A CALCS SHEET AND TITLE-ONLY EQUIPMENT SPECIFICATION PAGES (the reported set's shape)");
const SET: Sheet[] = [
  // 1: the SLD
  { lines: [...titleBlock("PV-6", "ELECTRICAL LINE DIAGRAM"), "MICROINVERTER BRANCH CIRCUIT"] },
  // 2: the wiring calcs sheet, with the spec TABLES in its body
  { lines: [...titleBlock("PV-7", "WIRING CALCULATIONS"), "ELECTRICAL NOTES",
    "(N) PV MODULE SPECIFICATIONS  PMAX 400 W  VOC 45.3 V", "INVERTER SPECIFICATIONS  MAX AC OUTPUT 315 VA  UL 1741",
    "MICROINVERTER SPECIFICATIONS  NOMINAL 240 V", "CONDUCTOR AMPACITY: 10 AWG THWN-2 @ 90C = 40 A"] },
  // 3: AC-module datasheet (carries the integrated micro's ratings) — title block only
  { lines: titleBlock("PV-11", "EQUIPMENT SPECIFICATION"), image: true },
  // 4: combiner datasheet — title block only
  { lines: titleBlock("PV-12", "EQUIPMENT SPECIFICATION"), image: true },
  // 5: racking brochure — title block only
  { lines: titleBlock("PV-13", "EQUIPMENT SPECIFICATION"), image: true },
];
const CALCS = 2, AC_MODULE = 3, COMBINER = 4, RACKING = 5;

for (const target of ["all", "nem"] as const) {
  const pid = await projectWith(SET);
  const result = await buildUtilityPackage(db, pid, target);
  const pages = (t: string) => result.parts.find((p) => p.docType === t)?.pages ?? [];
  const undecided = result.undecidedSpecPages ?? [];
  const parts = JSON.stringify(result.parts.map((p) => [p.docType, p.pages]));
  console.log(`  [target=${target}]`);
  run("MUST-EXCLUDE: the WIRING CALCULATIONS sheet is not in inverter_spec", !pages("inverter_spec").includes(CALCS), parts);
  run("MUST-EXCLUDE: the WIRING CALCULATIONS sheet is not in module_spec", !pages("module_spec").includes(CALCS), parts);
  run("MUST-EXCLUDE: the combiner and racking pages are not in inverter_spec",
    !pages("inverter_spec").includes(COMBINER) && !pages("inverter_spec").includes(RACKING), parts);
  run("the combiner and racking pages are not in module_spec",
    !pages("module_spec").includes(COMBINER) && !pages("module_spec").includes(RACKING), parts);
  run("MUST-PASS: the AC-module datasheet lands in inverter_spec, or the split reports it could not decide",
    pages("inverter_spec").includes(AC_MODULE) || undecided.includes(AC_MODULE), `${parts} undecided=${JSON.stringify(undecided)}`);
  run("every title-only EQUIPMENT SPECIFICATION page is reported undecided",
    JSON.stringify(undecided) === JSON.stringify([AC_MODULE, COMBINER, RACKING]), JSON.stringify(undecided));
  run("the SLD still splits", pages("sld").includes(1), parts);
  if (target === "nem") {
    run("nem: the inverter spec is reported missing, not shipped as the calcs sheet",
      result.missingSheetTypes.includes("inverter_spec") && result.missingDocTypes.includes("inverter_spec"),
      JSON.stringify({ missingSheetTypes: result.missingSheetTypes, missingDocTypes: result.missingDocTypes }));
    const zipPath = db.get<{ stored_path: string }>("SELECT stored_path FROM project_documents WHERE id = ?", [result.zipDocumentId])?.stored_path ?? "";
    const entries = zipPath ? new AdmZip(zipPath).getEntries().map((e) => e.entryName) : [];
    run("nem: the package zip carries no inverter_spec file", !entries.some((e) => e.startsWith("inverter_spec")), JSON.stringify(entries));
  }
}

// ---------------------------------------------------------------------------
console.log("\n2. A CALCS SHEET WHOSE SPEC-TABLE HEADING IS FOLLOWED BY THE WORD SHEET (title block after the body)");
{
  const pid = await projectWith([
    { lines: [...titleBlock("PV-6", "ELECTRICAL LINE DIAGRAM"), "MICROINVERTER BRANCH CIRCUIT"] },
    { lines: ["ELECTRICAL NOTES", "CONDUCTOR AMPACITY: 10 AWG THWN-2 @ 90C = 40 A", "PV MODULE / INVERTER SPECIFICATIONS",
      "INVERTER SPECIFICATIONS", ...titleBlock("PV-7", "WIRING CALCULATIONS")] },
    { lines: ["MICROINVERTER SPECIFICATIONS", ...titleBlock("PV-8", "ELECTRICAL CALCULATIONS")] },
  ]);
  const result = await buildUtilityPackage(db, pid, "all");
  const parts = JSON.stringify(result.parts.map((p) => [p.docType, p.pages]));
  run("MUST-EXCLUDE: neither calcs sheet is in a spec part", !result.parts.some((p) => (p.docType === "module_spec" || p.docType === "inverter_spec")), parts);
  run("a calcs sheet is not reported as an undecided spec page", (result.undecidedSpecPages ?? []).length === 0, JSON.stringify(result.undecidedSpecPages));
}

// ---------------------------------------------------------------------------
console.log("\n3. NAMED SPEC SHEETS STILL SPLIT, whatever the title-block layout (the sheet name is the signal)");
for (const numberFirst of [false, true]) {
  console.log(`  [${numberFirst ? "sheet number before name" : "sheet name before number"}]`);
  const pid = await projectWith([
    { lines: [...titleBlock("PV-6", "ELECTRICAL LINE DIAGRAM", numberFirst), "MICROINVERTER BRANCH CIRCUIT"] },
    { lines: titleBlock("PV-9", "PV MODULE SPECIFICATION SHEET", numberFirst), image: true },
    { lines: titleBlock("PV-10", "MICROINVERTER SPECIFICATIONS", numberFirst), image: true },
    { lines: titleBlock("PV-11", "INVERTER SPECIFICATIONS", numberFirst), image: true },
    { lines: titleBlock("PV-12", "PV MODULE / INV SPECIFICATION SHEET", numberFirst), image: true },
    { lines: titleBlock("PV-13", "EQUIPMENT SPECIFICATION", numberFirst), image: true },
  ]);
  const result = await buildUtilityPackage(db, pid, "all");
  const pages = (t: string) => result.parts.find((p) => p.docType === t)?.pages ?? [];
  const parts = JSON.stringify(result.parts.map((p) => [p.docType, p.pages]));
  run("PV MODULE SPECIFICATION SHEET -> module_spec", pages("module_spec").includes(2), parts);
  run("a bare-named MICROINVERTER SPECIFICATIONS sheet -> inverter_spec", pages("inverter_spec").includes(3), parts);
  run("a bare-named INVERTER SPECIFICATIONS sheet -> inverter_spec", pages("inverter_spec").includes(4), parts);
  run("the combined MODULE / INV SPECIFICATION SHEET -> both", pages("module_spec").includes(5) && pages("inverter_spec").includes(5), parts);
  run("only the title-only EQUIPMENT SPECIFICATION page is undecided", JSON.stringify(result.undecidedSpecPages) === JSON.stringify([6]), JSON.stringify(result.undecidedSpecPages));
  run("nothing spec-shaped is missing here", !result.missingSheetTypes.includes("module_spec") && !result.missingSheetTypes.includes("inverter_spec"), JSON.stringify(result.missingSheetTypes));
}

// ---------------------------------------------------------------------------
console.log("\n4. A SPEC-NAMED PAGE A STRAY HIT FILED ELSEWHERE IS STILL REPORTED UNDECIDED (#91)");
{
  // A racking brochure's vendor title block says STRUCTURAL: one `words` hit, so before #91 the
  // page was filed into the structural part and the split never said it was a spec-named page.
  const pid = await projectWith([
    { lines: [...titleBlock("PV-6", "ELECTRICAL LINE DIAGRAM"), "MICROINVERTER BRANCH CIRCUIT"] },
    { lines: [...titleBlock("PV-7", "WIRING CALCULATIONS"), "INVERTER SPECIFICATIONS  MAX AC OUTPUT 315 VA"] },
    { lines: [...titleBlock("PV-13", "EQUIPMENT SPECIFICATION"), "SYNTHRAIL STRUCTURAL MOUNTING SYSTEMS"], image: true },
    { lines: titleBlock("PV-14", "EQUIPMENT SPECIFICATION"), image: true },
    { lines: titleBlock("PV-9", "PV MODULE SPECIFICATION SHEET"), image: true },
  ]);
  const result = await buildUtilityPackage(db, pid, "all");
  const undecided = JSON.stringify({ pages: result.undecidedSpecPages, filedAs: result.undecidedSpecFiledAs });
  run("THE POINT: the EQUIPMENT SPECIFICATION page with a stray STRUCTURAL hit is reported undecided",
    (result.undecidedSpecPages ?? []).includes(3), undecided);
  run("…and the report says which category took it (structural)", result.undecidedSpecFiledAs?.["3"] === "structural", undecided);
  run("the title-only page is undecided with no category", (result.undecidedSpecPages ?? []).includes(4) && !result.undecidedSpecFiledAs?.["4"], undecided);
  run("MUST-EXCLUDE: the WIRING CALCULATIONS sheet is still not undecided", !(result.undecidedSpecPages ?? []).includes(2), undecided);
  run("MUST-EXCLUDE: the named spec sheet filed into module_spec is not undecided", !(result.undecidedSpecPages ?? []).includes(5), undecided);
  run("the page list is exactly [3, 4]", JSON.stringify(result.undecidedSpecPages) === "[3,4]", undecided);
}

// ---------------------------------------------------------------------------
console.log("\n5. A PAGE WHOSE WINNER CAME FROM A TITLE-BLOCK PATTERN IS NOT REPORTED UNDECIDED (#119)");
{
  // A dense SLD whose spec-callout block cites "INVERTER SPECIFICATIONS": the sheet name won sld
  // (a pattern hit), so the filing is right and reporting it is noise. The #91 brochure, whose
  // STRUCTURAL is a `words`-only hit, must still be reported.
  const pid = await projectWith([
    { lines: [...titleBlock("PV-6", "ELECTRICAL LINE DIAGRAM"), "MICROINVERTER BRANCH CIRCUIT",
      "INVERTER SPECIFICATIONS  MAX AC OUTPUT 315 VA  UL 1741", "PV MODULE  Q.TRON 400"] },
    { lines: [...titleBlock("PV-13", "EQUIPMENT SPECIFICATION"), "SYNTHRAIL STRUCTURAL MOUNTING SYSTEMS"], image: true },
  ]);
  const result = await buildUtilityPackage(db, pid, "all");
  const pages = (t: string) => result.parts.find((p) => p.docType === t)?.pages ?? [];
  const parts = JSON.stringify(result.parts.map((p) => [p.docType, p.pages]));
  const undecided = JSON.stringify({ pages: result.undecidedSpecPages, filedAs: result.undecidedSpecFiledAs });
  run("filing unchanged: the dense SLD is filed sld", pages("sld").includes(1), parts);
  run("filing unchanged: the dense SLD is not in inverter_spec", !pages("inverter_spec").includes(1), parts);
  run("THE POINT: the dense SLD is not in undecidedSpecPages", !(result.undecidedSpecPages ?? []).includes(1), undecided);
  run("…nor in undecidedSpecFiledAs", !result.undecidedSpecFiledAs?.["1"], undecided);
  run("the #91 words-only STRUCTURAL brochure is still reported, filed as structural",
    JSON.stringify(result.undecidedSpecPages) === "[2]" && result.undecidedSpecFiledAs?.["2"] === "structural", undecided);
}

// Close before deleting the scratch DB - Windows holds the open handle as a file lock (EBUSY).
db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} doc-splitter-spec-sheets test(s) FAILED.`); process.exit(1); }
console.log("\nAll doc-splitter-spec-sheets tests passed.");
process.exit(0);
