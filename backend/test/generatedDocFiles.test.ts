// "BUILD DOCS" BUILT DOCUMENTS THE SUBMISSION COULD NOT CARRY.
//
// The application-document package (transfer sheet, worksheets, prescriptive application)
// existed only as markdown strings feeding the print packet — no file, no docsByType key, so
// every upload step the bot has was blind to it. The operator's ruling (2026-09-21): "ensure
// the bot can see the build docs for submitting permits — it can attach them all for us."
//
// The precedence section is the one that guards real money: a generated WORKSHEET must never
// shadow the jurisdiction's own FILLED official form, and a human upload outranks both.
import "./_isolate"; // FIRST: runs in a temp cwd so filled/ docs/ page-images never land in the repo's backend/data
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-docs-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { materializeGeneratedDocs, generatedDocFilesByType } = await import("../src/generatedDocFiles");
const { submissionDocumentsByType } = await import("../src/submissionDocuments");

const db = await openDatabase();
let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

const client = createClient(db, { companyName: "Gen Docs Solar", ccbLicenseNumber: "445566" });
const { project } = createProject(db, {
  clientId: client.id, owner: "Gen Owner", street: "1 Gen St", city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
});

console.log("\n1. THE PACKAGE BECOMES REAL PDF FILES");
{
  const made = await materializeGeneratedDocs(db, project);
  const keys = Object.keys(made);
  check("1a. something materialized", keys.length > 0, JSON.stringify(keys));
  const anyFile = Object.values(made)[0];
  check("1b. the files exist on disk", !!anyFile && fs.existsSync(anyFile), String(anyFile));
  const bytes = fs.readFileSync(anyFile);
  check("1c. and they are ACTUAL PDFs, not renamed markdown", bytes.subarray(0, 5).toString() === "%PDF-",
    bytes.subarray(0, 8).toString());
  check("1d. multi-doc: the package renders more than one artifact",
    fs.readdirSync(path.dirname(anyFile)).filter((f) => f.endsWith(".pdf")).length >= 2);

  const readBack = generatedDocFilesByType(project.id);
  check("1e. the read half finds what the write half wrote, keyed by docType",
    Object.keys(readBack).length > 0 && Object.values(readBack).every((p) => fs.existsSync(p)),
    JSON.stringify(Object.keys(readBack)));
  check("1f. a project that never materialized reads EMPTY, never throws",
    Object.keys(generatedDocFilesByType("no-such-project")).length === 0);
}

console.log("\n2. PRECEDENCE — GENERATED NEVER SHADOWS OFFICIAL, HUMAN OUTRANKS BOTH");
{
  const merged = submissionDocumentsByType(db, project);
  const generated = generatedDocFilesByType(project.id);
  check("2a. the merged map now carries the generated docs", Object.keys(generated).every((k) => k in merged),
    JSON.stringify({ generated: Object.keys(generated), merged: Object.keys(merged) }));

  // A human upload with a docType the package also produces must WIN.
  const sharedKey = Object.keys(generated)[0];
  const humanFile = path.join(dir, "human-upload.pdf");
  fs.writeFileSync(humanFile, "%PDF-1.4 human upload");
  db.run(
    `INSERT INTO project_documents (id, project_id, doc_type, original_filename, stored_path, source, uploaded_at)
     VALUES (?, ?, ?, ?, ?, 'upload', ?)`,
    [`up-${sharedKey}`, project.id, sharedKey, "human.pdf", humanFile, new Date().toISOString()],
  );
  const merged2 = submissionDocumentsByType(db, project);
  check(`2b. THE RULE: a human upload of '${sharedKey}' outranks the generated file`,
    merged2[sharedKey] === humanFile, `${merged2[sharedKey]} vs ${generated[sharedKey]}`);
  check("2c. and the OTHER generated docs are still there — the upload displaced one key, not the family",
    Object.keys(generated).filter((k) => k !== sharedKey).every((k) => merged2[k] === generated[k]));
}

console.log("\n3. A RENDER FAILURE IS ADDITIVE-SAFE");
{
  // A project id that cannot resolve a package must return {} and never throw — the whole
  // module is additive capability; staging proceeds on filled forms + uploads without it.
  const out = await materializeGeneratedDocs(db, { ...project, id: "00000000-dead-beef-0000-000000000000" } as never);
  check("3a. an unresolvable project materializes nothing and does not throw", Object.keys(out).length === 0);
}

console.log(failures ? `\ngeneratedDocFiles: ${failures} check(s) FAILED` : "\ngeneratedDocFiles: all checks passed");
db.close();
fs.rmSync(dir, { recursive: true, force: true });
if (failures) process.exit(1);
