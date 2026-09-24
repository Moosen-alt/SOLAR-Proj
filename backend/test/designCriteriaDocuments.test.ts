// A DESIGN-CRITERIA BLOCKER NEEDS TWO DOCUMENTS — through the real write path.
//
// buildReviewerReportFor hands the reviewer one text per STORED document (newest per doc_type,
// project_documents.extracted_text). Before that wiring, every document was merged into one
// snapshot blob, so a plan set disagreeing with the engineer's letter was "one source" and the
// real blocker only appeared when the parser's narrative summary was (wrongly) counted as a
// second document. Pages the splitter cut out of the plan set (source 'split') are the plan set.
//
// Fixtures are SYNTHETIC PDFs built with pdf-lib, saved with saveProjectDocument (which runs the
// real text extraction). No names, no network, no LLM.
//
// Run: npx tsx backend/test/designCriteriaDocuments.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "design-criteria-docs-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";
process.env.SKIP_CODE_RESEARCH = "1";

const { openDatabase } = await import("../src/db");
const { createProject, getProjectDetail, buildReviewerReportFor } = await import("../src/repository");
const { saveProjectDocument } = await import("../src/projectDocuments");

const db = await openDatabase();

let failures = 0;
const check = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

async function pdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  lines.forEach((line, i) => page.drawText(line, { x: 40, y: 740 - i * 18, size: 10, font }));
  return Buffer.from(await doc.save());
}

async function save(projectId: string, docType: string, lines: string[], source = "upload"): Promise<void> {
  const saved = saveProjectDocument(db, projectId, { docType, filename: `${docType}.pdf`, contentType: "application/pdf", buffer: await pdf(lines), source });
  // saveProjectDocument extracts in the background; wait for the real extraction to land.
  for (let i = 0; i < 200; i++) {
    const row = db.get<{ extracted_text: string | null }>("SELECT extracted_text FROM project_documents WHERE id = ?", [saved.id]);
    if (row?.extracted_text) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`extraction never landed for ${docType}`);
}

function newProject(n: number): string {
  return createProject(db, {
    owner: `Criteria Test ${n}`, street: `${n} Test Way`, city: "Testport", state: "OR", zip: "97000",
    ahj: "City of Testport", utility: "Test Power", dcKw: "6.6",
  }).project.id;
}

const conflictOf = (projectId: string) => {
  const project = getProjectDetail(db, projectId).project;
  return buildReviewerReportFor(db, project).findings.find((f) => f.id === "city.struct.design-criteria-conflict");
};

const PLAN = ["STRUCTURAL NOTES:", "1. GROUND SNOW LOAD = 20 PSF", "2. WIND SPEED = 110 MPH", "3. EXPOSURE CATEGORY = C", "ROOF MOUNT PV ARRAY"];
const LETTER = ["Structural analysis for the rooftop PV array.", "Design wind speed, Vult: 95 mph (3-sec gust)", "Wind exposure category: B", "Ground snow load, Pg : 28 psf"];

await check("MUST-PASS: plan set (110 / C / Pg 20) vs structural letter (95 / B / Pg 28), each a stored document -> BLOCKER naming both", async () => {
  const id = newProject(1);
  await save(id, "plan_set", PLAN);
  await save(id, "structural_letter", LETTER);
  const f = conflictOf(id);
  assert.ok(f, "conflict must fire");
  assert.equal(f!.severity, "blocker", f!.message);
  assert.match(f!.message, /Plan set/);
  assert.match(f!.message, /Structural letter/);
});

await check("MUST-EXCLUDE: an internally inconsistent plan set + a split-out copy of its structural page -> WARNING (the split is the plan set)", async () => {
  const id = newProject(2);
  await save(id, "plan_set", [...PLAN, "SHEET S-2 CALCULATION: Vult = 95 mph"]);
  // The splitter's page is not a byte-exact substring of the plan-set text (page boundaries),
  // exactly as measured on production: modelled by a sheet caption the plan text lacks.
  await save(id, "structural", ["SHEET S-1 (split)", "2. WIND SPEED = 110 MPH"], "split");
  const f = conflictOf(id);
  assert.ok(f, "the plan set's own inconsistency is still reported");
  assert.equal(f!.severity, "warning", f!.message);
});

await check("MUST-EXCLUDE: a single stored plan set that agrees with itself -> no conflict", async () => {
  const id = newProject(3);
  await save(id, "plan_set", PLAN);
  assert.equal(conflictOf(id), undefined);
});

// A split row never CLAIMS its doc type: a newer split "structural" page must not hide an older,
// operator-uploaded structural calculation (the newest-per-type rule is for real documents).
await check("MUST-PASS: an older uploaded structural calc (95 / Pg 28) is still read when a newer SPLIT 'structural' page exists -> BLOCKER", async () => {
  const id = newProject(4);
  await save(id, "plan_set", PLAN);
  await save(id, "structural", ["Structural calculation", "Design wind speed, Vult: 95 mph (3-sec gust)", "Ground snow load, Pg : 28 psf"], "upload");
  await new Promise((r) => setTimeout(r, 25));
  await save(id, "structural", ["SHEET S-1", "2. WIND SPEED = 110 MPH"], "split");
  const f = conflictOf(id);
  assert.ok(f, "the plan set vs the uploaded calculation must conflict");
  assert.equal(f!.severity, "blocker", f!.message);
  assert.match(f!.message, /28 psf/);
});

if (failures) {
  console.error(`\n${failures} design-criteria document check(s) FAILED`);
  process.exit(1);
}
console.log("\nall design-criteria document checks passed");
process.exit(0);
