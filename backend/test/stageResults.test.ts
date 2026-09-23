// THE CHAIN RAN; THE PAGE SAID IT HADN'T.
//
// Demo feedback (2026-09-23): "the auto build not going after qc and verify". The stage-step
// chain HAD built the docs and run the reviewer gate server-side — the project page just never
// loaded those results, so every panel read "not run". readStageResults is the page-load read.
// Its whole contract is that it WRITES NOTHING: the plain reviewer-report GET records a
// text-only verdict, and calling that on every page view would overwrite the vision verdict.
//
// Section 3 is the manifest: a "←" in its copy threw inside pdf-lib's WinAnsi encoder and the
// renderer's per-doc catch dropped the whole document from every prescriptive package.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-results-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject, readStageResults, getApplicationDocumentPackage, getReviewerReport, getHistoricalFailureReport } = await import("../src/repository");
const { materializeGeneratedDocs } = await import("../src/generatedDocFiles");

const db = await openDatabase();
let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

const client = createClient(db, { companyName: "Stage Results Solar", ccbLicenseNumber: "112233" });
const { project } = createProject(db, {
  clientId: client.id, owner: "Stage Owner", street: "1 Stage St", city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
  // Enough structure for the permit path to RESOLVE prescriptive — only a resolved path puts
  // the "← UPLOAD THIS ONE" line in the manifest (section 3's precondition).
  mounting: "Roof mount", permitPath: "prescriptive", framingType: "rafter", roofRafterSpacing: "24",
  roofRafterSpan: "11", roofMaterial: "Composition Shingle", snow: "16", wind: "C", windSpeed: "110", deadLoad: "2.8",
} as never);

const fingerprint = (): string => JSON.stringify({
  audit: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE project_id = ?", [project.id])?.n,
  row: db.get("SELECT status, stage_detail, updated_at FROM projects WHERE id = ?", [project.id]),
});

console.log("\n1. A STEP THAT NEVER RAN STILL READS 'NOT RUN'");
{
  const before = fingerprint();
  const r = await readStageResults(db, project.id);
  check("1a. no docs, no reviewer report, no historical report before any of them ran",
    r.applicationDocs === null && r.reviewerReport === null && r.historicalReport === null, JSON.stringify(Object.keys(r)));
  check("1b. and reading wrote nothing", fingerprint() === before, `${before} -> ${fingerprint()}`);
}

console.log("\n2. AFTER THE CHAIN'S STEPS RAN, THE READ SHOWS THEM — AND STILL WRITES NOTHING");
{
  getApplicationDocumentPackage(db, project.id);
  getReviewerReport(db, project.id);
  getHistoricalFailureReport(db, project.id);
  const before = fingerprint();
  const r = await readStageResults(db, project.id);
  check("2a. the built package comes back", !!r.applicationDocs && r.applicationDocs.docs.length > 0);
  check("2b. the reviewer report comes back", !!r.reviewerReport && Array.isArray(r.reviewerReport.findings));
  check("2c. the historical report comes back", !!r.historicalReport);
  check("2d. THE CONTRACT: no audit row, no status/stage_detail/updated_at change", fingerprint() === before,
    `${before} -> ${fingerprint()}`);
}

console.log("\n3. EVERY PACKAGE DOCUMENT RENDERS — INCLUDING THE MANIFEST WITH ITS ARROW");
{
  const pkg = getApplicationDocumentPackage(db, project.id);
  const manifest = pkg.docs.find((d) => d.documentType === "manifest");
  check("3a. precondition: this package's manifest carries a non-WinAnsi character",
    !!manifest && /[^\x00-\xff]/.test(manifest.markdown.replace(/[—–’“”•…]/g, "")),
    manifest ? "manifest has only WinAnsi text — the test no longer exercises the fold" : "no manifest");
  const made = await materializeGeneratedDocs(db, project);
  const genDir = path.dirname(Object.values(made)[0] ?? "");
  const files = fs.existsSync(genDir) ? fs.readdirSync(genDir).filter((f) => f.endsWith(".pdf")) : [];
  check("3b. one PDF per package document — none dropped", files.length === pkg.docs.length,
    `${files.length} files for ${pkg.docs.length} docs`);
  check("3c. the manifest specifically is on disk", "application_manifest" in made, JSON.stringify(Object.keys(made)));
}

console.log(failures ? `\nstageResults: ${failures} FAILURE(S)` : "\nstageResults: all checks passed");
process.exit(failures ? 1 : 0);
