// UPLOAD SIZE CAP in the splitter (buildUtilityPackage): a multi-page category split that
// exceeds the portal's per-file cap is trimmed to its LEAD page so a portal-acceptable
// file always exists per docType. The cap honors PORTAL_UPLOAD_MAX_MB (same knob the
// portal-bot upload resolver uses) — the test sets a tiny cap so a small synthetic plan
// set exercises the trim without generating a real >5MB PDF.
// Browser-free. Run: tsx backend/test/docSplitterCap.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-splitter-cap-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
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

// Build a synthetic 3-page plan set: two pages whose text classifies as inverter_spec
// (dedicated spec-sheet title), one classified as SLD. Page 2 carries a fat text payload
// so the 2-page inverter_spec split exceeds the tiny test cap while page 1 alone fits.
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const addPage = (title: string, padKb = 0) => {
  const page = doc.addPage([612, 792]);
  page.drawText(title, { x: 40, y: 740, size: 14, font });
  if (padKb > 0) {
    // Incompressible-ish padding: many distinct short lines (pdf-lib writes content
    // streams uncompressed, so this reliably inflates the page's byte size).
    for (let i = 0; i < padKb; i++) {
      page.drawText(`PAD-${i}-${"x".repeat(120)}`, { x: 40, y: 700 - (i % 600), size: 4, font });
    }
  }
};
addPage("INVERTER SPECIFICATION SHEET — lead cut-sheet page");
addPage("INVERTER SPECIFICATION SHEET — vendor manual scan tail page", 400);
addPage("ONE-LINE DIAGRAM E 1.1");
const planBytes = Buffer.from(await doc.save());

const detail = createProject(db, {
  owner: "Cap Test", street: "3 Cap Way", city: "Salem", state: "OR", zip: "97301",
  ahj: "City of Cap", utility: "PGE", dcKw: "6.6",
});
saveProjectDocument(db, detail.project.id, {
  docType: "plan_set", filename: "cap-plan-set.pdf", contentType: "application/pdf",
  buffer: planBytes, source: "upload",
});

// Cap far below the padded 2-page split but above a single lead page.
const leadOnly = await PDFDocument.create();
const [lead] = await leadOnly.copyPages(doc, [0]);
leadOnly.addPage(lead);
const leadSize = Buffer.from(await leadOnly.save()).length;
const twoPageSize = planBytes.length; // upper bound reference
process.env.PORTAL_UPLOAD_MAX_MB = String((leadSize + 8 * 1024) / (1024 * 1024));

try {
  const result = await buildUtilityPackage(db, detail.project.id, "nem");
  const invPart = result.parts.find((p) => p.docType === "inverter_spec");
  run("inverter_spec split produced", !!invPart, JSON.stringify(result.parts));
  run("splitter saw both inverter_spec pages", (invPart?.pages.length ?? 0) === 2, `pages: ${JSON.stringify(invPart?.pages)}`);

  const row = db.get<{ stored_path: string }>(
    "SELECT stored_path FROM project_documents WHERE id = ?", [invPart?.documentId ?? ""],
  );
  const savedSize = row?.stored_path && fs.existsSync(row.stored_path) ? fs.statSync(row.stored_path).size : -1;
  const cap = Number(process.env.PORTAL_UPLOAD_MAX_MB) * 1024 * 1024;
  run("oversize split trimmed to a file under the cap", savedSize > 0 && savedSize <= cap, `saved=${savedSize}B cap=${Math.round(cap)}B fullDoc=${twoPageSize}B`);

  const saved = await PDFDocument.load(fs.readFileSync(row!.stored_path));
  run("trimmed split is the single LEAD page", saved.getPageCount() === 1, `pages=${saved.getPageCount()}`);

  // Control: with the default (5 MB) cap this small split is untouched — both pages kept.
  delete process.env.PORTAL_UPLOAD_MAX_MB;
  const result2 = await buildUtilityPackage(db, detail.project.id, "nem");
  const invPart2 = result2.parts.find((p) => p.docType === "inverter_spec");
  const row2 = db.get<{ stored_path: string }>("SELECT stored_path FROM project_documents WHERE id = ?", [invPart2?.documentId ?? ""]);
  const saved2 = await PDFDocument.load(fs.readFileSync(row2!.stored_path));
  run("under the default cap both pages are kept", saved2.getPageCount() === 2, `pages=${saved2.getPageCount()}`);
} finally {
  delete process.env.PORTAL_UPLOAD_MAX_MB;
}

fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} doc-splitter-cap test(s) FAILED.`); process.exit(1); }
console.log("\nAll doc-splitter-cap tests passed.");
process.exit(0);
