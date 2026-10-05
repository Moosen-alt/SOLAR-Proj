// UNDECIDED EQUIPMENT SPECIFICATION PAGES, DECIDED BY THE PAGE-INDEX READ (#79).
// After #66/#75 a title-only "EQUIPMENT SPECIFICATION" cut-sheet is reported undecided rather than
// guessed, so module_spec / inverter_spec showed missing and a person uploaded them. With an LLM,
// buildUtilityPackage now labels those pages with the existing page-index read
// (scannedPlanSet.readUndecidedSpecPages) and files the module / inverter datasheets from the label.
// Pins:
//   - pages labelled module_spec, other_spec, racking_spec → a module_spec part holding the first
//     page only, and none of the three in inverter_spec (issue acceptance);
//   - an AC-module datasheet carrying its integrated micro's ratings + UL 1741 lands in BOTH parts;
//     combiner and racking sheets in neither;
//   - no undecided page → no page-index call (and no llm_calls row);
//   - RULE 2: only equipment-datasheet page images are sent — an undecided page that reads as a
//     bill or meter record is never rendered or sent;
//   - the read stays under the per-read image budget;
//   - the next reconcile pass (#77) does not withdraw the part the read cut.
// A fake LLM records every page it was shown — no spend. Synthetic data only.
// Run: tsx backend/test/docSplitterSpecVision.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so docs never land in the repo's backend/data
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-splitter-spec-vision-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { createProject } = await import("../src/repository");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { buildUtilityPackage, reconcileSplitParts } = await import("../src/docSplitter");
const scan = await import("../src/scannedPlanSet");

const db = await openDatabase();

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

const titleBlock = (sheet: string, name: string) => ["SYNTH SOLAR CO  123 FIXTURE RD", `SHEET NAME: ${name}`, `SHEET NUMBER: ${sheet}`];
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
    owner: `Vision Owner ${++n}`, street: `${n} Vision Way`, city: "Los Lunas", state: "NM", zip: "87031",
    ahj: "Village of Fixture", utility: "PNM", dcKw: "7.2",
  }).project;
  saveProjectDocument(db, p.id, {
    docType: "plan_set", filename: `vision-plan-set-${n}.pdf`, contentType: "application/pdf",
    buffer: await mkPdf(sheets), source: "upload",
  });
  return p.id;
};

/** A fake page-index reader: `labels` maps a 1-based page to what it "sees" there. */
function fakeLlm(labels: Record<number, { kind: string; integratedInverter?: boolean }>) {
  const shown: number[][] = [];
  const bytes: number[] = [];
  return {
    shown, bytes,
    async classifyPlanPages(input: { pageImages: Array<{ page: number; base64: string; mimeType: string }> }) {
      shown.push(input.pageImages.map((p) => p.page));
      bytes.push(input.pageImages.reduce((s, p) => s + Buffer.from(p.base64, "base64").length, 0));
      return { pages: input.pageImages.map((p) => ({ page: p.page, sheet: "", title: "EQUIPMENT SPECIFICATION", ...(labels[p.page] ?? { kind: "other" }) })) };
    },
  };
}
const llmCallRows = () => Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM llm_calls")?.n ?? 0);

const SLD: Sheet = { lines: [...titleBlock("PV-6", "ELECTRICAL LINE DIAGRAM"), "MICROINVERTER BRANCH CIRCUIT"] };
const EQUIP = (sheet: string): Sheet => ({ lines: titleBlock(sheet, "EQUIPMENT SPECIFICATION"), image: true });
// A utility bill that ended up in the plan set under an EQUIPMENT SPECIFICATION title block —
// synthetic labels only, no real account or meter number.
const BILL: Sheet = { lines: [...titleBlock("PV-14", "EQUIPMENT SPECIFICATION"), "ACCOUNT NUMBER: 0000000-000", "AMOUNT DUE  BILLING PERIOD"], image: true };
const METER: Sheet = { lines: [...titleBlock("PV-15", "EQUIPMENT SPECIFICATION"), "METER NUMBER: X0000000"], image: true };
const SET: Sheet[] = [SLD, EQUIP("PV-11"), EQUIP("PV-12"), EQUIP("PV-13")];
const MODULE = 2, COMBINER = 3, RACKING = 4;

// ---------------------------------------------------------------------------
console.log("\n1. ACCEPTANCE: module_spec, other_spec, racking_spec → module_spec holds the first page only");
for (const target of ["all", "permit"] as const) {
  console.log(`  [target=${target}]`);
  const pid = await projectWith(SET);
  const llm = fakeLlm({ [MODULE]: { kind: "module_spec" }, [COMBINER]: { kind: "other_spec" }, [RACKING]: { kind: "racking_spec" } });
  const result = await buildUtilityPackage(db, pid, target, { llm });
  const pages = (t: string) => result.parts.find((p) => p.docType === t)?.pages ?? [];
  const parts = JSON.stringify(result.parts.map((p) => [p.docType, p.pages]));
  run("one page-index call, shown exactly the three undecided pages", JSON.stringify(llm.shown) === JSON.stringify([[MODULE, COMBINER, RACKING]]), JSON.stringify(llm.shown));
  run("MUST-PASS: module_spec part is the first undecided page only", JSON.stringify(pages("module_spec")) === JSON.stringify([MODULE]), parts);
  run("MUST-EXCLUDE: none of the three is in inverter_spec",
    ![MODULE, COMBINER, RACKING].some((p) => pages("inverter_spec").includes(p)), parts);
  run("the decided pages are no longer undecided", (result.undecidedSpecPages ?? []).length === 0, JSON.stringify(result.undecidedSpecPages));
  run("what the read decided is reported",
    JSON.stringify(result.specPagesByVision) === JSON.stringify({ [MODULE]: "module_spec", [COMBINER]: "other_spec", [RACKING]: "racking_spec" }), JSON.stringify(result.specPagesByVision));
  run("module_spec is no longer missing", !result.missingSheetTypes.includes("module_spec"), JSON.stringify(result.missingSheetTypes));
  const reconciled = await reconcileSplitParts(db, pid);
  run("the next reconcile pass does not withdraw the part the read cut (#77)", !reconciled.withdrawn.includes("module_spec"), JSON.stringify(reconciled.withdrawn));
  const live = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM project_documents WHERE project_id = ? AND doc_type = 'module_spec'", [pid])?.n ?? 0;
  run("…and the module_spec document is still on file", Number(live) === 1, String(live));
}

// ---------------------------------------------------------------------------
console.log("\n2. AN AC MODULE carrying the integrated micro's ratings + UL 1741 counts as both");
{
  const pid = await projectWith(SET);
  const llm = fakeLlm({ [MODULE]: { kind: "module_spec", integratedInverter: true }, [COMBINER]: { kind: "other_spec" }, [RACKING]: { kind: "racking_spec" } });
  const result = await buildUtilityPackage(db, pid, "all", { llm });
  const pages = (t: string) => result.parts.find((p) => p.docType === t)?.pages ?? [];
  const parts = JSON.stringify(result.parts.map((p) => [p.docType, p.pages]));
  run("the AC module is in module_spec", JSON.stringify(pages("module_spec")) === JSON.stringify([MODULE]), parts);
  run("…and in inverter_spec", JSON.stringify(pages("inverter_spec")) === JSON.stringify([MODULE]), parts);
  run("MUST-EXCLUDE: combiner and racking land in neither spec part",
    ![COMBINER, RACKING].some((p) => pages("module_spec").includes(p) || pages("inverter_spec").includes(p)), parts);
  // The flag on a non-module page is ignored (normalizePageIndex never trusts the model's shape).
  const idx = scan.normalizePageIndex({ pages: [{ page: 1, kind: "other_spec", integratedInverter: true }, { page: 2, kind: "module_spec", integratedInverter: "yes" }] }, [1, 2]);
  run("integratedInverter is kept only on a module_spec page, and only when true", idx.pages.every((p) => !p.integratedInverter), JSON.stringify(idx.pages));
}

// ---------------------------------------------------------------------------
console.log("\n3. NO UNDECIDED PAGE → NO VISION CALL");
{
  const pid = await projectWith([SLD,
    { lines: titleBlock("PV-9", "PV MODULE SPECIFICATION SHEET"), image: true },
    { lines: titleBlock("PV-10", "MICROINVERTER SPECIFICATIONS"), image: true }]);
  const llm = fakeLlm({});
  const before = llmCallRows();
  const result = await buildUtilityPackage(db, pid, "all", { llm });
  run("there were no undecided pages", (result.undecidedSpecPages ?? []).length === 0, JSON.stringify(result.undecidedSpecPages));
  run("MUST-EXCLUDE: the page-index read was not called", llm.shown.length === 0, JSON.stringify(llm.shown));
  run("llm_calls is unchanged", llmCallRows() === before, `${before} → ${llmCallRows()}`);
  run("no vision report", result.specPagesByVision === undefined, JSON.stringify(result.specPagesByVision));
  const direct = fakeLlm({});
  await scan.readUndecidedSpecPages(direct, new Uint8Array(await mkPdf([SLD])), [], [""]);
  run("readUndecidedSpecPages with no pages calls nothing", direct.shown.length === 0);
}

// ---------------------------------------------------------------------------
console.log("\n4. RULE 2: a bill or meter page in the undecided set is never sent");
{
  const pid = await projectWith([...SET, BILL, METER]);
  const llm = fakeLlm({ [MODULE]: { kind: "module_spec" }, [COMBINER]: { kind: "other_spec" }, [RACKING]: { kind: "racking_spec" }, 5: { kind: "module_spec" }, 6: { kind: "inverter_spec" } });
  const result = await buildUtilityPackage(db, pid, "all", { llm });
  const sent = llm.shown.flat();
  run("the bill and meter pages were in the undecided set (the guard is what kept them out)",
    JSON.stringify(result.specPagesWithheld) === JSON.stringify([5, 6]), JSON.stringify(result.specPagesWithheld));
  run("MUST-EXCLUDE: the bill page (5) was never sent", !sent.includes(5), JSON.stringify(llm.shown));
  run("MUST-EXCLUDE: the meter page (6) was never sent", !sent.includes(6), JSON.stringify(llm.shown));
  run("only the datasheet pages were sent", JSON.stringify(sent) === JSON.stringify([MODULE, COMBINER, RACKING]), JSON.stringify(sent));
  run("the withheld pages stay undecided for a person", JSON.stringify(result.undecidedSpecPages) === JSON.stringify([5, 6]), JSON.stringify(result.undecidedSpecPages));
  const pages = (t: string) => result.parts.find((p) => p.docType === t)?.pages ?? [];
  run("…and are in no spec part", ![5, 6].some((p) => pages("module_spec").includes(p) || pages("inverter_spec").includes(p)), JSON.stringify(result.parts.map((p) => [p.docType, p.pages])));

  const onlyBill = await projectWith([SLD, BILL]);
  const llm2 = fakeLlm({ 2: { kind: "module_spec" } });
  const r2 = await buildUtilityPackage(db, onlyBill, "all", { llm: llm2 });
  run("MUST-EXCLUDE: an undecided set of only a bill page makes no call at all", llm2.shown.length === 0, JSON.stringify(llm2.shown));
  run("…and it stays undecided", JSON.stringify(r2.undecidedSpecPages) === JSON.stringify([2]), JSON.stringify(r2.undecidedSpecPages));
  run("bill/meter screen does not catch a plain datasheet title block", !scan.looksLikeBillOrMeterPage(titleBlock("PV-11", "EQUIPMENT SPECIFICATION").join(" ")));
}

// ---------------------------------------------------------------------------
console.log("\n5. THE READ STAYS UNDER THE PER-READ IMAGE BUDGET");
{
  const bytes = new Uint8Array(await mkPdf(SET));
  const texts = SET.map((s) => s.lines.join(" "));
  const full = fakeLlm({});
  await scan.readUndecidedSpecPages(full, bytes, [MODULE, COMBINER, RACKING], texts);
  const one = Math.ceil(full.bytes[0] / 3) + 10; // room for about one thumbnail
  const tight = fakeLlm({});
  await scan.readUndecidedSpecPages(tight, bytes, [MODULE, COMBINER, RACKING], texts, { maxBytes: one });
  run("a tightened budget sends fewer pages, under the budget",
    tight.shown.length === 1 && tight.shown[0].length < 3 && tight.bytes[0] <= one, JSON.stringify({ shown: tight.shown, bytes: tight.bytes, one }));
  const huge = fakeLlm({});
  await scan.readUndecidedSpecPages(huge, bytes, [MODULE], texts, { maxBytes: Number.MAX_SAFE_INTEGER });
  run("a caller cannot raise the budget past MAX_VISION_BYTES", huge.bytes[0] <= scan.MAX_VISION_BYTES);
  const none = fakeLlm({});
  const r = await scan.readUndecidedSpecPages(none, bytes, [MODULE], texts, { maxBytes: 1 });
  run("no image fits → no call, and the pages stay undecided", none.shown.length === 0 && Object.keys(r.decided).length === 0, JSON.stringify(r));
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
