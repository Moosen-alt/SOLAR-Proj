// EXTRACTED PDF TEXT CAN KEEP ITS LINES (#260) — WITHOUT MOVING ANY ONE-LINE READER.
// batchImport joined a page's pdf.js text items with " ", so a sheet came out as one line. The
// line-preserving extractors (extractPdfTextLines / extractPdfPageLines) put "\n" after the item
// pdf.js marks hasEOL. They are OPT-IN: the #260 review measured what moving every reader to lines
// costs on ordinary CAD layouts (wrapped FIRE / SETBACK became a false fire-path blocker, a wrapped
// ATTACHMENT / DETAIL title lost its sheet name, a period-free schedule filled the design digest to
// its cap), so extractPdfText / extractPdfPages stay byte-for-byte the one-line text.
// Pins:
//   - MUST-PASS: a two-line title block extracts as two lines (the line extractors); items on one
//     line still join with a space; a page break is a blank line; batch import (the one reader moved
//     to lines) learns a correction PDF's numbered items;
//   - MUST-EXCLUDE: the one-line extractors keep one line per page on three plan sets (two design
//     platforms and the review's wrap layouts), and on the wrap layouts every consumer reads what
//     main read: no fire-path blocker, the structural sheet name, framing evidence, an empty digest;
//   - RULE 2: a meter number split by a line break is scrubbed (digits, and a short literal secret
//     wrapped at its space), and the vision prompt carries no meter digits when a label sits on the
//     line above them;
//   - the digest's "within 10" topic is not "WITHIN 1000'".
// Synthetic data only. Run: tsx backend/test/pdfTextLineBreaks.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so docs never land in the repo's backend/data
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { platformAPlanSet, platformBPlanSet, wrapLayoutPlanSet, SYNTHETIC_METER } from "./_planSetPlatforms";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-text-line-breaks-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { createProject, getProjectDetail, buildReviewerReportFor } = await import("../src/repository");
const { saveProjectDocument, planSetTextForProject } = await import("../src/projectDocuments");
const { extractPdfText, extractPdfPages, extractPdfTextLines, extractPdfPageLines, pageTextFromItems, scanFolder } = await import("../src/batchImport");
const { scorePage } = await import("../src/docSplitter");
const { roofFramingFacts } = await import("../src/projectEvidence");
const { designNotesDigest, redactSecretValues } = await import("../src/autoLearn");
const { applyVisionToReviewerReport } = await import("../src/reviewerVision");

const db = await openDatabase();

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};
const json = (v: unknown) => JSON.stringify(v);
const METER_DIGITS = /80\D{0,4}000\D{0,4}1234/;

let n = 0;
async function write(bytes: Buffer | Uint8Array, name = `doc-${++n}.pdf`, dir = tmpDir): Promise<string> {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}
async function pdfOf(pages: string[][]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = pdf.addPage([612, 792]);
    lines.forEach((l, i) => page.drawText(l, { x: 54, y: 700 - i * 16, size: 10, font }));
  }
  return pdf.save();
}
/** A project whose plan set is `bytes`, with its text extracted and stored. */
async function projectWith(bytes: Buffer, meterNumber = SYNTHETIC_METER) {
  const p = createProject(db, {
    owner: `Line Owner ${++n}`, street: `${n} Line Way`, city: "Anytown", state: "OR", zip: "97000",
    ahj: "Line City", utility: "Line Power", dcKw: "8.4", meterNumber,
  }).project;
  saveProjectDocument(db, p.id, { docType: "plan_set", filename: `plan-set-${n}.pdf`, contentType: "application/pdf", buffer: bytes, source: "upload" });
  for (let i = 0; i < 400 && !planSetTextForProject(db, p.id); i++) await new Promise((r) => setTimeout(r, 25));
  return getProjectDetail(db, p.id).project;
}

// --- MUST-PASS: the line extractors keep a two-line title block as two lines --------------------
{
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText("PROJECT: SYNTHETIC RESIDENCE", { x: 54, y: 700, size: 10, font });
  page.drawText("SHEET PV-1 COVER", { x: 54, y: 686, size: 10, font });
  page.drawText("LEFT", { x: 54, y: 600, size: 10, font });
  page.drawText("RIGHT", { x: 300, y: 600, size: 10, font });
  pdf.addPage([612, 792]).drawText("SECOND PAGE", { x: 54, y: 700, size: 10, font });
  const file = await write(await pdf.save());
  const text = await extractPdfTextLines(file);
  const [first] = await extractPdfPageLines(file);
  run("extractPdfTextLines: the title block's two rows are two lines", text.split("\n").slice(0, 2).join("|") === "PROJECT: SYNTHETIC RESIDENCE|SHEET PV-1 COVER", json(text));
  run("extractPdfPageLines: the same two lines", first.split("\n").slice(0, 2).join("|") === "PROJECT: SYNTHETIC RESIDENCE|SHEET PV-1 COVER", json(first));
  run("items on ONE line still join with a space", /^LEFT {1,2}RIGHT$/m.test(text), json(text));
  run("a page break is a blank line; no trailing spaces", /RIGHT\n\nSECOND PAGE$/.test(text) && !/ \n/.test(text), json(text));
  const oneLine = await extractPdfText(file);
  run("extractPdfText keeps one line per page, as before", oneLine === "PROJECT: SYNTHETIC RESIDENCE SHEET PV-1 COVER LEFT  RIGHT\nSECOND PAGE", json(oneLine));
}
run("pageTextFromItems: hasEOL → \\n, otherwise a space",
  pageTextFromItems([{ str: "A", hasEOL: false }, { str: "B", hasEOL: true }, { str: "C" }, { str: "", hasEOL: true }, { str: "D" }]) === "A B\nC \nD");

// --- MUST-PASS: batch import (moved to lines) learns a correction PDF's numbered items ----------
{
  const dir = fs.mkdtempSync(path.join(tmpDir, "scan-"));
  const folder = path.join(dir, "Synthetic Customer - Anytown, OR");
  fs.mkdirSync(folder);
  await write(await pdfOf([["PLAN CHECK CORRECTION LIST", "PERMIT NUMBER: EX-0000",
    "1. Provide the rafter size, spacing and clear span on the structural sheet.",
    "2. Show the 36 inch fire access pathway dimensioned on the roof plan."]]), "Synthetic Customer - Anytown, OR correction.pdf", folder);
  const org = db.get<{ id: string }>("SELECT id FROM orgs LIMIT 1")?.id ?? "default";
  const summary = await scanFolder(db, dir, { orgId: org });
  run("batch import learns the correction PDF's numbered items (one line per page found none)",
    summary.byType.correction === 1 && summary.correctionsLearned === 1, json({ byType: summary.byType, learned: summary.correctionsLearned }));
}

// --- MUST-EXCLUDE: the one-line extractors and their readers stay as they were -----------------
const PLATFORMS: Array<{ name: string; build: () => Promise<Buffer>; sheets: string[][] }> = [
  { name: "platform A (right-column title block)", build: platformAPlanSet, sheets: [[], ["site_plan"], ["structural"], ["sld"], ["labels"], ["module_spec"], ["inverter_spec"]] },
  { name: "platform B (bottom-strip title block)", build: platformBPlanSet, sheets: [[], ["site_plan"], ["structural"], ["sld"], ["labels"], ["module_spec"], ["inverter_spec"]] },
  { name: "wrap layouts", build: wrapLayoutPlanSet, sheets: [["site_plan"], [], ["structural"], [], ["sld"]] },
];
for (const platform of PLATFORMS) {
  const file = await write(await platform.build());
  const pages = await extractPdfPages(file, 80);
  const text = await extractPdfText(file, 40);
  run(`${platform.name}: extractPdfPages is one line per page`, pages.every((p) => !p.includes("\n")));
  run(`${platform.name}: extractPdfText breaks only between pages`, (text.match(/\n/g) ?? []).length === pages.length - 1);
  run(`${platform.name}: the line extractor does see the lines`, (await extractPdfPageLines(file, 80)).every((p) => p.includes("\n")));
  run(`${platform.name}: splitter files each sheet as before`,
    json(pages.map((p) => scorePage(p).docTypes)) === json(platform.sheets), json(pages.map((p) => scorePage(p).docTypes)));
}

// The review's wrap layouts, read the way main reads them (each regressed when the stored text had lines).
{
  const bytes = await wrapLayoutPlanSet();
  const pages = await extractPdfPages(await write(bytes), 80);
  run("wrap: a two-line ATTACHMENT / DETAIL title still files by its sheet NAME", scorePage(pages[2]).byPattern === true, json(pages[2]));
  const project = await projectWith(bytes);
  const ids = buildReviewerReportFor(db, project).findings.map((f) => `${f.id}:${f.severity}`);
  run("wrap: FIRE / SETBACK wrapped across lines raises no fire-path finding", !ids.some((id) => id.startsWith("reviewer.plan.fire-path")), json(ids));
  run("wrap: a framing table (header over values) and RAFTERS: over its value are framing evidence", roofFramingFacts(project).present);
  run("wrap: a period-free schedule adds nothing to the design digest (LLM cost flat)", designNotesDigest(project, 1200) === "", json(designNotesDigest(project, 1200)));
}

// --- RULE 2 ----------------------------------------------------------------------------------
run("redactSecretValues: digits split by a newline are scrubbed",
  redactSecretValues("UTILITY METER #80 000\n1234 ON THE EAST WALL", [SYNTHETIC_METER]) === "UTILITY METER #[redacted] ON THE EAST WALL");
run("redactSecretValues: a short literal secret wrapped at its space is scrubbed",
  redactSecretValues("METER AB\n1234 ON THE WALL", ["AB 1234"]) === "METER [redacted] ON THE WALL");
{
  // The label sits on the line ABOVE the digits, so an evidence excerpt can start at the digits and
  // land in a finding's text. Every vision prompt is recorded; none may carry them.
  const project = await projectWith(await wrapLayoutPlanSet());
  const report = buildReviewerReportFor(db, project);
  const carrying = report.findings.filter((f) => METER_DIGITS.test([f.title, f.message, f.cityFeedback, ...(f.evidenceNeeded ?? [])].join(" ")));
  const prompts: string[] = [];
  const recorder = {
    async visionExtract(input: { prompt: string }) { prompts.push(input.prompt); return { present: false, confidence: "low", observed: "", missing: "" }; },
  };
  await applyVisionToReviewerReport(db, recorder as never, report);
  run("setup: a finding the vision pass reads quotes the meter digits", carrying.length > 0 && prompts.length > 0, json({ carrying: carrying.map((f) => f.id), prompts: prompts.length }));
  run("the vision prompt carries no meter digits", prompts.every((p) => !METER_DIGITS.test(p)), json(prompts.filter((p) => METER_DIGITS.test(p)).map((p) => p.slice(0, 400))));
}

// --- the digest's "within 10" topic ----------------------------------------------------------
{
  const p = createProject(db, {
    owner: "Topic Owner", street: "9 Topic Way", city: "Anytown", state: "OR", zip: "97000",
    ahj: "Line City", utility: "Line Power", dcKw: "5",
  }).project;
  const digest = designNotesDigest({ ...p, parserSnapshot: { ...(p.parserSnapshot || {}),
    sitePlanNotesText: "SITE IS WITHIN 1000' OF A FORMER LANDFILL\nPV AC SWITCH WITHIN 10 FT OF THE UTILITY METER" } }, 1200);
  run("digest: 'within 10 ft' is a topic, 'WITHIN 1000'' is not", /WITHIN 10 FT/.test(digest) && !/1000/.test(digest), json(digest));
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\npdfTextLineBreaks: all checks passed");
process.exit(0);
