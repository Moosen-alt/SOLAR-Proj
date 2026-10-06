// SPEC SHEETS NAMED ONLY IN THE COVER'S SHEET INDEX (#199).
// An image-only datasheet page whose text layer is only the title block and its sheet number
// ("S-1") names nothing; its name, "SPEC SHEET", is on the cover's sheet index. Before, the split
// filed it nowhere and did not report it undecided, so the page-index read (#79) never saw it and the
// gate held the packet for a module and inverter spec it contained. Now the index names it.
// Pins:
//   - MUST-PASS: cover "S-1 SPEC SHEET … S-3 SPEC SHEET", image-only S-1..S-3 → the fake read is shown
//     exactly those three pages; module_spec / inverter_spec parts filled; the gate no longer owes them;
//   - the sheet index in COLUMNS ("SHEET # … S-1 … S-3 SHEET NAME … SPEC SHEET SPEC SHEET …");
//   - CUT / DATA / SPECIFICATION SHEET, an equipment word or not, S1 / S 1.1 numbering;
//   - MUST-EXCLUDE: "S-1 STRUCTURAL CALCS", "PV-4 SITE PHOTOS" are not spec pages, and no read runs;
//   - a page the index cannot name stays listed (unclassifiedPages), never undecided by guess;
//   - RULE 2: an index-named page that reads as a bill or meter is never sent;
//   - no undecided page → no call (the #79 budget rule).
// A fake LLM records every page it was shown — no spend. Synthetic data only.
// Run: tsx backend/test/docSplitterIndexSpec.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so docs never land in the repo's backend/data
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-splitter-index-spec-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { createProject } = await import("../src/repository");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { buildUtilityPackage, reconcileSplitParts, indexSpecSheets } = await import("../src/docSplitter");
const { documentInventory } = await import("../src/requiredDocuments");

const db = await openDatabase();

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};
const json = (v: unknown) => JSON.stringify(v);

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
const projects = new Map<string, ReturnType<typeof createProject>["project"]>();
const projectWith = async (sheets: Sheet[]) => {
  const p = createProject(db, {
    owner: `Index Owner ${++n}`, street: `${n} Index Way`, city: "Los Lunas", state: "NM", zip: "87031",
    ahj: "Village of Fixture", utility: "PNM", dcKw: "7.2",
  }).project;
  saveProjectDocument(db, p.id, {
    docType: "plan_set", filename: `index-plan-set-${n}.pdf`, contentType: "application/pdf",
    buffer: await mkPdf(sheets), source: "upload",
  });
  projects.set(p.id, p);
  return p.id;
};

/** A fake page-index reader: `labels` maps a 1-based page to what it "sees" there. */
function fakeLlm(labels: Record<number, string>) {
  const shown: number[][] = [];
  return {
    shown,
    async classifyPlanPages(input: { pageImages: Array<{ page: number; base64: string; mimeType: string }> }) {
      shown.push(input.pageImages.map((p) => p.page));
      return { pages: input.pageImages.map((p) => ({ page: p.page, sheet: "", title: "", kind: labels[p.page] ?? "other" })) };
    },
  };
}

const COMPANY = "SYNTH SOLAR CO  123 FIXTURE RD";
// The cover's sheet index, one row per sheet. The pages it names carry only their sheet number.
const COVER_ROWS: Sheet = { lines: ["COVER SHEET", "SHEET INDEX", "CS-1 COVER SHEET", "E-1 ELECTRICAL LINE DIAGRAM", "S-1 SPEC SHEET", "S-2 SPEC SHEET", "S-3 SPEC SHEET", "SHEET NUMBER: CS-1"] };
// The same index in columns, as a two-column table's text layer joins it.
const COVER_COLUMNS: Sheet = { lines: ["SHEET INDEX", "SHEET #", "CS-1", "E-1", "S-1", "S-2", "S-3", "SHEET NAME", "COVER SHEET", "ELECTRICAL LINE DIAGRAM", "SPEC SHEET", "SPEC SHEET", "SPEC SHEET"] };
const SLD: Sheet = { lines: [COMPANY, "SHEET NAME: ELECTRICAL LINE DIAGRAM", "SHEET NUMBER: E-1", "MICROINVERTER BRANCH CIRCUIT"] };
const TITLE_ONLY = (sheet: string): Sheet => ({ lines: [COMPANY, sheet], image: true });
const SET = (cover: Sheet): Sheet[] => [cover, SLD, TITLE_ONLY("S-1"), TITLE_ONLY("S-2"), TITLE_ONLY("S-3")];
const MODULE = 3, INVERTER = 4, RACKING = 5;
const LABELS = { [MODULE]: "module_spec", [INVERTER]: "inverter_spec", [RACKING]: "racking_spec" };

// ---------------------------------------------------------------------------
console.log("\n1. MUST-PASS: cover index S-1..S-3 SPEC SHEET, title-block-only pages, read labels them");
for (const [layout, cover] of [["rows", COVER_ROWS], ["columns", COVER_COLUMNS]] as const) {
  console.log(`  [index in ${layout}]`);
  const pid = await projectWith(SET(cover));
  const llm = fakeLlm(LABELS);
  const result = await buildUtilityPackage(db, pid, "permit", { llm });
  const pages = (t: string) => result.parts.find((p) => p.docType === t)?.pages ?? [];
  const parts = json(result.parts.map((p) => [p.docType, p.pages]));
  run("one page-index call, shown exactly S-1..S-3", json(llm.shown) === json([[MODULE, INVERTER, RACKING]]), json(llm.shown));
  run("module_spec part is S-1 only", json(pages("module_spec")) === json([MODULE]), parts);
  run("inverter_spec part is S-2 only", json(pages("inverter_spec")) === json([INVERTER]), parts);
  run("MUST-EXCLUDE: the racking sheet (S-3) is in neither spec part",
    !pages("module_spec").includes(RACKING) && !pages("inverter_spec").includes(RACKING), parts);
  run("module and inverter spec are no longer missing from the split",
    !result.missingSheetTypes.includes("module_spec") && !result.missingSheetTypes.includes("inverter_spec"), json(result.missingSheetTypes));
  run("nothing is left undecided", result.undecidedSpecPages.length === 0, json(result.undecidedSpecPages));
  const inv = documentInventory(db, projects.get(pid)!);
  const owed = inv.missingBlocking.map((d) => d.docType);
  const specRows = inv.presence.filter((d) => d.docType === "module_spec" || d.docType === "inverter_spec");
  run("the gate requires both spec sheets (the check below is not vacuous)", specRows.length === 2, json(specRows.map((d) => d.docType)));
  run("THE POINT: the gate no longer reports the module or inverter spec missing",
    !owed.includes("module_spec") && !owed.includes("inverter_spec") && specRows.every((d) => d.present), json(owed));
  const reconciled = await reconcileSplitParts(db, pid);
  run("the next reconcile pass withdraws neither part (#77)", reconciled.withdrawn.length === 0, json(reconciled.withdrawn));
}

// ---------------------------------------------------------------------------
console.log("\n2. WITHOUT A READ: the index-named pages are reported undecided, not dropped");
{
  const pid = await projectWith(SET(COVER_ROWS));
  const result = await buildUtilityPackage(db, pid, "permit");
  run("S-1..S-3 are undecided spec pages", json(result.undecidedSpecPages) === json([MODULE, INVERTER, RACKING]), json(result.undecidedSpecPages));
  run("…and in no spec part", !result.parts.some((p) => p.docType === "module_spec" || p.docType === "inverter_spec"), json(result.parts.map((p) => p.docType)));
}

// ---------------------------------------------------------------------------
console.log("\n3. WHAT THE INDEX CALLS A SPEC SHEET");
{
  const index = (...rows: string[]) => indexSpecSheets(["SHEET INDEX " + rows.join(" ")]);
  const named = (rows: string[], key: string) => index(...rows).spec.has(key);
  for (const name of ["SPEC SHEET", "CUT SHEET", "DATA SHEET", "DATASHEET", "SPECIFICATION SHEET", "MODULE SPEC SHEET", "INVERTER DATA SHEET", "EQUIPMENT SPECIFICATION", "SPEC SHEETS"]) {
    run(`"S-1 ${name}" names S-1 a spec sheet`, named([`S-1 ${name}`, "PV-2 SITE PLAN"], "S1"));
  }
  run("S1 and S 1.1 numbering", named(["S1 SPEC SHEET", "S 1.1 CUT SHEET"], "S1") && named(["S1 SPEC SHEET", "S 1.1 CUT SHEET"], "S1.1"));
  run("MUST-EXCLUDE: S-1 STRUCTURAL CALCS", !named(["S-1 STRUCTURAL CALCS", "S-2 SPEC SHEET"], "S1"));
  run("MUST-EXCLUDE: PV-4 SITE PHOTOS", !named(["PV-4 SITE PHOTOS", "S-2 SPEC SHEET"], "PV4"));
  run("MUST-EXCLUDE: a calculations sheet whatever its name says", !named(["S-1 MODULE DATA SHEET CALCULATIONS"], "S1"));
  run("the last row's name is its first words, not the notes after it",
    !named(["PV-4 SITE PHOTOS", "1. ALL WORK SHALL COMPLY WITH THE MODULE DATA SHEET"], "PV4"));
  run("a page that is not a sheet index names nothing", !indexSpecSheets(["S-1 SPEC SHEET"]).spec.has("S1"));
  run("columns: two same-size groups name nothing (no guessing which)",
    index("SHEET # E-1 E-2 S-1 S-2 SHEET NAME LINE DIAGRAM SPEC SHEET SPEC SHEET").spec.size === 0);
  // #212 review: in columns the names stop at the notes / project-data block after the table.
  const cols = "SHEET # PV-1 PV-2 PV-3 S-1 S-2 SHEET NAME ROOF PLAN SITE PLAN LAYOUT SPEC SHEET SPEC SHEET";
  for (const tail of ["NOTES: SEE MODULE SPEC FOR RATINGS", "PROJECT DATA MODULE SPEC QTRON 400W"]) {
    const r = index(`${cols} ${tail}`);
    run(`columns + "${tail}": S-1, S-2 only (not PV-1..PV-3, not nothing)`, json([...r.spec].sort()) === json(["S1", "S2"]), json([...r.spec]));
  }
  run("columns: a sheet NAMED GENERAL NOTES does not end the names",
    json([...index("SHEET # CS-1 G-1 S-1 S-2 SHEET NAME COVER GENERAL NOTES SPEC SHEET SPEC SHEET").spec].sort()) === json(["S1", "S2"]));
  run("OF 2 / REV 1 / QTY 24 are not sheet numbers", json([...index("SHEET 1 OF 2 S-1 SPEC SHEET REV 1 QTY 24").listed]) === json(["S1"]),
    json([...index("SHEET 1 OF 2 S-1 SPEC SHEET REV 1 QTY 24").listed]));
  run("columns: a count no group has names nothing",
    index("SHEET # CS-1 S-1 S-2 S-3 SHEET NAME COVER SPEC SHEET SPEC SHEET").spec.size === 0);
}

// ---------------------------------------------------------------------------
console.log("\n4. MUST-EXCLUDE: STRUCTURAL CALCS / SITE PHOTOS pages are not spec pages, and no read runs");
{
  const cover: Sheet = { lines: ["SHEET INDEX", "CS-1 COVER SHEET", "PV-4 SITE PHOTOS", "S-1 STRUCTURAL CALCS"] };
  const pid = await projectWith([cover, SLD, TITLE_ONLY("PV-4"), TITLE_ONLY("S-1")]);
  const llm = fakeLlm({});
  const result = await buildUtilityPackage(db, pid, "permit", { llm });
  run("no undecided page", result.undecidedSpecPages.length === 0, json(result.undecidedSpecPages));
  run("no page-index call (the #79 budget rule)", llm.shown.length === 0, json(llm.shown));
  run("both pages are still listed, as unclassified", json(result.unclassifiedPages) === json([1, 3, 4]), json(result.unclassifiedPages));
}

// ---------------------------------------------------------------------------
console.log("\n5. A PAGE THE INDEX CANNOT NAME IS LISTED, NOT GUESSED");
{
  // S-9 is not in the index; the S-1 page also cites S-2, with no labelled SHEET NUMBER to decide.
  const cover: Sheet = { lines: ["SHEET INDEX", "S-1 SPEC SHEET", "S-2 SPEC SHEET"] };
  const pid = await projectWith([cover, SLD, TITLE_ONLY("S-9"), { lines: [COMPANY, "S-1", "SEE S-2"], image: true }]);
  const llm = fakeLlm({});
  const result = await buildUtilityPackage(db, pid, "permit", { llm });
  run("neither page is undecided", result.undecidedSpecPages.length === 0, json(result.undecidedSpecPages));
  run("no call", llm.shown.length === 0, json(llm.shown));
  run("both are listed as unclassified", json(result.unclassifiedPages) === json([1, 3, 4]), json(result.unclassifiedPages));
  // A labelled SHEET NUMBER decides it.
  const pid2 = await projectWith([cover, SLD, { lines: [COMPANY, "SHEET NUMBER: S-1", "SEE S-2"], image: true }]);
  const r2 = await buildUtilityPackage(db, pid2, "permit");
  run("a labelled SHEET NUMBER: S-1 page citing S-2 is S-1's spec sheet", json(r2.undecidedSpecPages) === json([3]), json(r2.undecidedSpecPages));
  const pid4 = await projectWith([cover, SLD, { lines: [COMPANY, "SHEET NUMBER: PV-11", "SEE S-1"], image: true }]);
  const r4 = await buildUtilityPackage(db, pid4, "permit");
  run("a labelled SHEET NUMBER: PV-11 page citing S-1 is not S-1's spec sheet", r4.undecidedSpecPages.length === 0 && json(r4.unclassifiedPages) === json([1, 3]), json(r4));
  // No index at all.
  const pid3 = await projectWith([SLD, TITLE_ONLY("S-1")]);
  const r3 = await buildUtilityPackage(db, pid3, "permit");
  run("no index: the title-only page is listed as unclassified", json(r3.unclassifiedPages) === json([2]) && r3.undecidedSpecPages.length === 0, json(r3));
}

// ---------------------------------------------------------------------------
console.log("\n6. RULE 2: an index-named page that reads as a bill or meter is never sent");
{
  const BILL: Sheet = { lines: [COMPANY, "S-3", "ACCOUNT NUMBER: 0000000-000", "AMOUNT DUE  BILLING PERIOD"], image: true };
  const pid = await projectWith([COVER_ROWS, SLD, TITLE_ONLY("S-1"), TITLE_ONLY("S-2"), BILL]);
  const llm = fakeLlm(LABELS);
  const result = await buildUtilityPackage(db, pid, "permit", { llm });
  run("the bill page was index-named (the screen is what kept it out)", json(result.specPagesWithheld) === json([RACKING]), json(result.specPagesWithheld));
  run("MUST-EXCLUDE: only S-1 and S-2 were sent", json(llm.shown.flat()) === json([MODULE, INVERTER]), json(llm.shown));
  run("the withheld page stays undecided for a person", json(result.undecidedSpecPages) === json([RACKING]), json(result.undecidedSpecPages));
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
