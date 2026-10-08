// EXTRACTED PDF TEXT KEEPS ITS LINES (#260).
// batchImport.withPdfPages joined a page's pdf.js text items with " ", so a whole sheet came out as
// one line and only page breaks were "\n". Now the item pdf.js marks as ending a line (hasEOL) is
// followed by "\n"; every other boundary is the " " it always was.
// Pins:
//   - MUST-PASS: a two-line title block extracts as two lines (extractPdfText and extractPdfPages);
//     items on one line still join with a space; no blank-line or trailing-space runs;
//   - MUST-EXCLUDE: on two synthetic plan sets laid out like two different design platforms
//     (_planSetPlatforms.ts), no consumer regresses: the splitter's categories and spec index,
//     classifyDoc, the stated design criteria, the permit path, and the design digest (which must
//     not grow: the LLM cost of the planner stays flat);
//   - RULE 2: a meter number that WRAPS across a line break is still scrubbed — by
//     redactSecretValues, and out of the design digest built from the real extractor's text.
// Synthetic data only. Run: tsx backend/test/pdfTextLineBreaks.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so docs never land in the repo's backend/data
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { platformAPlanSet, platformBPlanSet, SYNTHETIC_METER } from "./_planSetPlatforms";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-text-line-breaks-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { createProject, getProjectDetail } = await import("../src/repository");
const { saveProjectDocument, planSetTextForProject } = await import("../src/projectDocuments");
const { extractPdfText, extractPdfPages, classifyDoc, pageTextFromItems } = await import("../src/batchImport");
const { scorePage, indexSpecSheets } = await import("../src/docSplitter");
const { extractStatedDesignCriteria } = await import("../src/designCriteria");
const { resolvePermitPath } = await import("../src/permitPath");
const { designNotesDigest, redactSecretValues } = await import("../src/autoLearn");

const db = await openDatabase();

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};
const json = (v: unknown) => JSON.stringify(v);

async function pdfOf(draw: (page: import("pdf-lib").PDFPage, font: import("pdf-lib").PDFFont) => void): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  draw(pdf.addPage([612, 792]), font);
  const file = path.join(tmpDir, `p${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(file, await pdf.save());
  return file;
}
const write = async (name: string, bytes: Buffer) => { const f = path.join(tmpDir, name); fs.writeFileSync(f, bytes); return f; };

// --- MUST-PASS: a two-line title block is two lines -----------------------------------------
{
  const file = await pdfOf((page, font) => {
    page.drawText("PROJECT: SYNTHETIC RESIDENCE", { x: 54, y: 700, size: 10, font });
    page.drawText("SHEET PV-1 COVER", { x: 54, y: 686, size: 10, font });
    page.drawText("LEFT", { x: 54, y: 600, size: 10, font });
    page.drawText("RIGHT", { x: 300, y: 600, size: 10, font });
  });
  const text = await extractPdfText(file);
  const [page] = await extractPdfPages(file);
  run("extractPdfText: the title block's two rows are two lines", text.split("\n").slice(0, 2).join("|") === "PROJECT: SYNTHETIC RESIDENCE|SHEET PV-1 COVER", json(text));
  run("extractPdfPages: the same two lines", page.split("\n").slice(0, 2).join("|") === "PROJECT: SYNTHETIC RESIDENCE|SHEET PV-1 COVER", json(page));
  run("items on ONE line still join with a space (as before)", /^LEFT {1,2}RIGHT$/m.test(text), json(text));
  run("no trailing space before a break, no blank lines", !/ \n|\n\n/.test(text), json(text));
}
run("pageTextFromItems: hasEOL → \\n, otherwise a space",
  pageTextFromItems([{ str: "A", hasEOL: false }, { str: "B", hasEOL: true }, { str: "C" }, { str: "", hasEOL: true }, { str: "D" }]) === "A B\nC \nD");

// --- MUST-EXCLUDE: no consumer regresses on two platforms' plan sets -------------------------
// Expected values are what the extractor's consumers read off these sets BEFORE #260 (measured on
// main with the old " " join): the change must not move any of them. The digest bound is the old
// length — it may only shrink (it no longer glues the next sheet's title onto a note line).
const PLATFORMS: Array<{ name: string; build: () => Promise<Buffer>; digestBefore: number }> = [
  { name: "platform A (right-column title block)", build: platformAPlanSet, digestBefore: 324 },
  { name: "platform B (bottom-strip title block)", build: platformBPlanSet, digestBefore: 278 },
];
let n = 0;
for (const platform of PLATFORMS) {
  const bytes = await platform.build();
  const file = await write(`plan-set-${++n}.pdf`, bytes);
  const pages = await extractPdfPages(file, 80);
  const text = await extractPdfText(file, 40);
  run(`${platform.name}: pages carry their lines`, pages.every((p) => p.includes("\n")));
  run(`${platform.name}: splitter files each sheet as before`,
    json(pages.map((p) => scorePage(p).docTypes)) === json([[], ["site_plan"], ["structural"], ["sld"], ["labels"], ["module_spec"], ["inverter_spec"]]),
    json(pages.map((p) => scorePage(p).docTypes)));
  const idx = indexSpecSheets(pages);
  run(`${platform.name}: cover's sheet index names the same spec sheets`, json([...idx.spec].sort()) === json(["PV6", "PV7"]) && idx.listed.size === 7, json([...idx.spec]));
  run(`${platform.name}: classifyDoc unchanged`, classifyDoc("plan-set.pdf", text) === "sld");

  const p = createProject(db, {
    owner: `Line Owner ${n}`, street: `${n} Line Way`, city: "Anytown", state: "OR", zip: "97000",
    ahj: "Line City", utility: "Line Power", dcKw: "8.4", meterNumber: SYNTHETIC_METER,
  }).project;
  saveProjectDocument(db, p.id, { docType: "plan_set", filename: `plan-set-${n}.pdf`, contentType: "application/pdf", buffer: bytes, source: "upload" });
  planSetTextForProject(db, p.id);
  for (let i = 0; i < 200 && !planSetTextForProject(db, p.id); i++) await new Promise((r) => setTimeout(r, 25));
  const project = getProjectDetail(db, p.id).project;
  const planText = String(project.parserSnapshot.planSetExtractedText ?? "");
  run(`${platform.name}: stored plan text has its lines`, planText.includes("\n"));
  const criteria = extractStatedDesignCriteria(project).criteria.map((c) => [c.criterion, c.value]);
  run(`${platform.name}: stated design criteria unchanged`,
    json(criteria) === json([["windSpeedMph", 110], ["windExposure", "C"], ["groundSnowPsf", 25]]), json(criteria));
  run(`${platform.name}: permit path unchanged`, resolvePermitPath(project).path === "unknown");
  const digest = designNotesDigest(project, 1200);
  run(`${platform.name}: design digest does not grow (${digest.length} <= ${platform.digestBefore})`, digest.length > 0 && digest.length <= platform.digestBefore, json(digest));
  run(`${platform.name}: digest still carries the disconnect and rapid-shutdown notes`,
    /DISCONNECT LOCATED WITHIN 10 FT/.test(digest) && /RAPID SHUTDOWN PER NEC 690/.test(digest), json(digest));
  run(`${platform.name}: digest no longer glues a sheet title onto a note`, !/ONE-LINE DIAGRAM RAPID|SPECIFICATIONS EXAMPLE/.test(digest), json(digest));
}

// --- RULE 2: a secret that wraps across a line break is still scrubbed ------------------------
run("redactSecretValues: digits split by a newline are scrubbed",
  redactSecretValues("UTILITY METER #80 000\n1234 ON THE EAST WALL", [SYNTHETIC_METER]) === "UTILITY METER #[redacted] ON THE EAST WALL");
run("redactSecretValues: digits split by a newline and spaces are scrubbed",
  !/1234/.test(redactSecretValues("METER 80 000 \n 1234", [SYNTHETIC_METER])));
{
  // The real extractor's text: the meter number wraps onto the next line, inside a line the
  // digest's disconnect topic picks up — the City of Jefferson leak shape, now with a break in it.
  const file = await pdfOf((page, font) => {
    page.drawText("NEW PV AC DISCONNECT WITHIN 10 FT OF UTILITY METER #80 000", { x: 54, y: 700, size: 10, font });
    page.drawText("1234 ON THE EAST WALL OF THE GARAGE", { x: 54, y: 686, size: 10, font });
  });
  const text = await extractPdfText(file);
  run("the extracted meter digits really are split by a line break", /80 000\n1234/.test(text), json(text));
  const p = createProject(db, {
    owner: "Wrap Owner", street: "9 Wrap Way", city: "Anytown", state: "OR", zip: "97000",
    ahj: "Line City", utility: "Line Power", dcKw: "5", meterNumber: SYNTHETIC_METER,
  }).project;
  const project = { ...p, parserSnapshot: { ...(p.parserSnapshot || {}), planSetExtractedText: text } };
  const digest = designNotesDigest(project, 1200);
  run("digest keeps the disconnect line", /DISCONNECT WITHIN 10 FT/.test(digest), json(digest));
  run("digest carries no meter digits across the break", !/80\D{0,4}000\D{0,4}1234|1234/.test(digest), json(digest));
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\npdfTextLineBreaks: all checks passed");
process.exit(0);
