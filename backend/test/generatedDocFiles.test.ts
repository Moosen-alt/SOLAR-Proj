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
const { materializeGeneratedDocs, generatedDocFilesByType, GENERATED_DOC_KEYS, generatedDocKey } = await import("../src/generatedDocFiles");
const { submissionDocumentsByType } = await import("../src/submissionDocuments");
const { resolvePermitPath } = await import("../src/permitPath");
const { APPLICATION_DOC_TYPES } = await import("../src/requiredDocuments");
const { UPLOAD_LABEL_PATTERNS, exactUploadDocType } = await import("../../portal-bot/src/adapters/autoLearnAdapter");
const pathOf = (p: Parameters<typeof resolvePermitPath>[0]): string => resolvePermitPath(p).path;

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

  const readBack = generatedDocFilesByType(project.id, pathOf(project));
  check("1e. the read half finds what the write half wrote, keyed by docType",
    Object.keys(readBack).length > 0 && Object.values(readBack).every((p) => fs.existsSync(p)),
    JSON.stringify(Object.keys(readBack)));
  check("1f. a project that never materialized reads EMPTY, never throws",
    Object.keys(generatedDocFilesByType("no-such-project", "prescriptive")).length === 0);
}

console.log("\n2. PRECEDENCE — GENERATED NEVER SHADOWS OFFICIAL, HUMAN OUTRANKS BOTH");
{
  const merged = submissionDocumentsByType(db, project);
  const generated = generatedDocFilesByType(project.id, pathOf(project));
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

// ---------------------------------------------------------------------------------------------
// 4. A GENERATED WORKSHEET NEVER IMPERSONATES AN OFFICIAL FORM, AND A RENDER IS ONE SET
//    (docs-audit PLAN D2; operator decision OD-3).
//
// The reader used to key files by FILENAME — electrical.pdf → electrical_application,
// structural.pdf → building_application, prescriptive-application.pdf → permit_application — so a
// portal slot named "<X> Permit Application" received this product's internal worksheet whenever
// no official form was held. And nothing pruned: 6a1c2127 carries structural.pdf (09-21 14:03)
// beside a prescriptive render (14:41); ec5c36d3 carries prescriptive-application.pdf (14:44)
// beside an engineered render (22:37). Both were being packaged.
//
// KILLS: restore keyForDocId (filename keys) → (4a) FAILS; drop the prune → (4c)(4d) FAIL.
// ---------------------------------------------------------------------------------------------
console.log("\n4. OWN KEYS, ONE RENDER, PATH-SCOPED (PLAN D2)");
{
  const OFFICIAL = ["electrical_application", "building_application", "permit_application", "solar_checklist", "pv_worksheet", "structural_letter"];
  const genDirOf = (pid: string) => path.join(process.cwd(), "backend", "data", "filled", pid, "generated");
  const mkCoos = (permitPathOverride: string, n: string) => createProject(db, {
    clientId: client.id, owner: `Gen Owner ${n}`, street: `${n} Gen St`, city: "Coos Bay",
    state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4", permitPathOverride,
  }).project;

  // (4a) MUST-PASS, Michael-shaped (OR, SEPARATE building + electrical permits, PRESCRIPTIVE, no
  // official form held): every generated worksheet is packaged under its OWN key.
  const michael = mkCoos("prescriptive", "4a");
  await materializeGeneratedDocs(db, michael);
  const pkg4a = submissionDocumentsByType(db, michael);
  const generated4a = Object.entries(pkg4a).filter(([, f]) => f.includes(`${path.sep}generated${path.sep}`));
  check("4a. MUST-PASS: no generated file sits under an official application key",
    generated4a.every(([k]) => !OFFICIAL.includes(k)), JSON.stringify(generated4a.map(([k, f]) => `${k} <- ${path.basename(f)}`)));
  check("4a. …and the worksheets are held under their own generated_* keys",
    ["generated_electrical_worksheet", "generated_prescriptive_worksheet"].every((k) => pkg4a[k]?.includes(`${path.sep}generated${path.sep}`)),
    JSON.stringify(Object.keys(pkg4a)));
  check("4a. …so the official electrical application reads ABSENT, as the gate says it is",
    pkg4a.electrical_application === undefined && pkg4a.permit_application === undefined && pkg4a.building_application === undefined,
    JSON.stringify({ ele: pkg4a.electrical_application, permit: pkg4a.permit_application, bld: pkg4a.building_application }));
  check("4a. …while the two 2026-09-21 ruling slots keep their files (transfer sheet, NEM worksheet)",
    Boolean(pkg4a.application_transfer_sheet || pkg4a.portal_entry_worksheet) && Boolean(pkg4a.utility_application),
    JSON.stringify(Object.keys(pkg4a)));

  // (4b) THE TABLE: no generated key is an official application key, an exact-upload type, or any
  // upload slot's docType except the two slots the ruling opened.
  const keys = [...Object.values(GENERATED_DOC_KEYS), generatedDocKey("ahj-worksheet", true), generatedDocKey("some-new-doc", false)];
  check("4b. no generated key is in APPLICATION_DOC_TYPES",
    keys.every((k) => !APPLICATION_DOC_TYPES.has(k)), JSON.stringify(keys.filter((k) => APPLICATION_DOC_TYPES.has(k))));
  const slotTypes = new Set(UPLOAD_LABEL_PATTERNS.map((p) => p.docType));
  check("4b. …and only the transfer sheet and the NEM worksheet name an upload slot's docType",
    keys.filter((k) => slotTypes.has(k)).sort().join(",") === "application_transfer_sheet,utility_application",
    JSON.stringify(keys.filter((k) => slotTypes.has(k))));
  check("4b. …an unknown builder id gets its own generated_ key, never an official one",
    generatedDocKey("some-new-doc", false) === "generated_some_new_doc");
  check("4b. …and an 'Electrical Permit Application' slot is still an exact-type slot the worksheet cannot fill",
    exactUploadDocType("Electrical Permit Application") === "electrical_application");

  // (4c) MUST-EXCLUDE, 6a1c2127-shaped: an ENGINEERED render's structural.pdf is on disk when the
  // project renders PRESCRIPTIVE. The official fill one level up must survive the prune.
  const six = mkCoos("prescriptive", "4c");
  fs.mkdirSync(genDirOf(six.id), { recursive: true });
  const staleStructural = path.join(genDirOf(six.id), "structural.pdf");
  const staleEngineered = path.join(genDirOf(six.id), "engineered-docs.pdf");
  const officialFill = path.join(genDirOf(six.id), "..", "tmpl-official-fill.pdf");
  fs.writeFileSync(staleStructural, "%PDF-1.4 stale structural worksheet from an engineered render");
  fs.writeFileSync(staleEngineered, "%PDF-1.4 stale engineered collection");
  fs.writeFileSync(officialFill, "%PDF-1.4 the jurisdiction's own filled form");
  await materializeGeneratedDocs(db, six);
  check("4c. MUST-EXCLUDE: the stale structural.pdf is DELETED by the prescriptive render", !fs.existsSync(staleStructural));
  check("4c. …and the stale engineered-docs.pdf with it", !fs.existsSync(staleEngineered));
  check("4c. …and neither is packaged",
    !Object.values(submissionDocumentsByType(db, six)).some((f) => /structural\.pdf$|engineered-docs\.pdf$/.test(f)),
    JSON.stringify(Object.values(submissionDocumentsByType(db, six)).map((f) => path.basename(f))));
  check("4c. …while the official fill in filled/<pid>/ is untouched (the prune stays inside generated/)", fs.existsSync(officialFill));

  // (4d) MUST-EXCLUDE, ec5c36d3-shaped: a PRESCRIPTIVE render's prescriptive-application.pdf is on
  // disk when the project renders ENGINEERED.
  const ec5 = mkCoos("engineered", "4d");
  fs.mkdirSync(genDirOf(ec5.id), { recursive: true });
  const stalePrescriptive = path.join(genDirOf(ec5.id), "prescriptive-application.pdf");
  fs.writeFileSync(stalePrescriptive, "%PDF-1.4 stale prescriptive worksheet");
  await materializeGeneratedDocs(db, ec5);
  check("4d. MUST-EXCLUDE: the stale prescriptive-application.pdf is DELETED by the engineered render", !fs.existsSync(stalePrescriptive));
  check("4d. …and the engineered render's own structural worksheet is held under its own key",
    Boolean(submissionDocumentsByType(db, ec5).generated_structural_worksheet), JSON.stringify(Object.keys(submissionDocumentsByType(db, ec5))));

  // (4e) PATH-SCOPED READ: the permit path moves and nothing re-renders — the old render is stale
  // and packages nothing (the next staging/learn re-renders it before reading).
  const flip = mkCoos("prescriptive", "4e");
  await materializeGeneratedDocs(db, flip);
  const flipped = { ...flip, parserSnapshot: { ...flip.parserSnapshot, permitPathOverride: "engineered" } };
  db.run("UPDATE projects SET parser_json = ? WHERE id = ?", [JSON.stringify(flipped.parserSnapshot), flip.id]);
  check("4e. a render made on another permit path is not packaged",
    Object.keys(generatedDocFilesByType(flip.id, pathOf(flipped))).length === 0 && pathOf(flipped) === "engineered",
    JSON.stringify(generatedDocFilesByType(flip.id, pathOf(flipped))));
  check("4e. …and a directory with no manifest (rendered before manifests) packages nothing",
    (() => { fs.rmSync(path.join(genDirOf(flip.id), "manifest.json"), { force: true }); return Object.keys(generatedDocFilesByType(flip.id, "prescriptive")).length === 0; })());

  // (4f) A FAILED RENDER LEAVES NOTHING READABLE: the previous render's manifest is cleared.
  const failing = mkCoos("prescriptive", "4f");
  await materializeGeneratedDocs(db, failing);
  const before = Object.keys(generatedDocFilesByType(failing.id, pathOf(failing))).length;
  // The package build now throws: the project row is gone (FKs off only for this scratch delete).
  db.exec("PRAGMA foreign_keys = OFF");
  db.run("DELETE FROM projects WHERE id = ?", [failing.id]);
  db.exec("PRAGMA foreign_keys = ON");
  await materializeGeneratedDocs(db, failing);
  check("4f. a render that fails clears the previous render instead of leaving it to be packaged",
    before > 0 && Object.keys(generatedDocFilesByType(failing.id, pathOf(failing))).length === 0,
    JSON.stringify({ before }));
}

console.log(failures ? `\ngeneratedDocFiles: ${failures} check(s) FAILED` : "\ngeneratedDocFiles: all checks passed");
db.close();
fs.rmSync(dir, { recursive: true, force: true });
if (failures) process.exit(1);
