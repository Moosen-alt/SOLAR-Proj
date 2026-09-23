// AN ORPHANED FILL IS NOT AN APPLICATION.
//
// filledApplicationForms reads backend/data/filled/<projectId>/*.pdf. A `tmpl-<id>.pdf` is a
// stored template filled for this project; its docType comes from that template's row. When
// the row did not exist, the file fell through to the registry branch, found no registry def,
// and was counted as a nameless `permit_application` — which the building-side row accepts
// as an alias. Measured on the demo kit (2026-09-23): seven tmpl-*.pdf files carrying
// PRODUCTION template ids with no row in the kit's database, one of which turned Coos Bay's
// blocking prescriptive application "present" and passed docs.complete.
//
// DB-backed, real write paths (createProject, storeAhjFormTemplate, project_documents rows
// pointing at real files). Runs in its own temp cwd: FILLED_DIR is resolved off process.cwd()
// at module load, so nothing here touches the repo's backend/data.
//
// Run: tsx backend/test/orphanFilledForms.test.ts
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-filled-"));
process.chdir(dir);
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { documentInventory } = await import("../src/requiredDocuments");
const { filledApplicationForms } = await import("../src/ahjForms");
const { storeAhjFormTemplate } = await import("../src/ahjFormAuto");

const db = await openDatabase();
let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

const FILLED_ROOT = path.join(dir, "backend", "data", "filled");
const client = createClient(db, { companyName: "Orphan Fill Solar", ccbLicenseNumber: "445566" });
let n = 0;
const mk = () => createProject(db, {
  clientId: client.id, owner: `Orphan Owner ${++n}`, street: `${n} Bay St`, city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
  permitPathOverride: "prescriptive",
} as never).project;

const attach = (pid: string, docType: string): void => {
  const file = path.join(dir, `${pid}-${docType}.pdf`);
  fs.writeFileSync(file, "%PDF-1.4 test fixture");
  db.run(
    `INSERT INTO project_documents (id, project_id, doc_type, original_filename, stored_path, source, uploaded_at)
     VALUES (?, ?, ?, ?, ?, 'upload', ?)`,
    [`${pid}-${docType}`, pid, docType, `${docType}.pdf`, file, new Date().toISOString()],
  );
};
const place = (pid: string, fileBase: string): void => {
  fs.mkdirSync(path.join(FILLED_ROOT, pid), { recursive: true });
  fs.writeFileSync(path.join(FILLED_ROOT, pid, `${fileBase}.pdf`), "%PDF-1.4 filled");
};
// Everything a Coos Bay prescriptive filing needs EXCEPT the building-side application.
const EVERYTHING_BUT_BUILDING = ["plan_set", "site_plan", "sld", "structural", "module_spec", "inverter_spec", "labels", "electrical_application", "solar_checklist"];
const blockingOf = (p: unknown): string[] => documentInventory(db, p as never).missingBlocking.map((d) => d.docType);

console.log("\n0. PRECONDITION — with no application on disk, the building-side row blocks");
const bare = mk();
for (const d of EVERYTHING_BUT_BUILDING) attach(bare.id, d);
check("0a. building_application is the (only) blocking row", JSON.stringify(blockingOf(bare)) === JSON.stringify(["building_application"]), JSON.stringify(blockingOf(bare)));

console.log("\n1. A tmpl-*.pdf WHOSE TEMPLATE ROW DOES NOT EXIST COUNTS FOR NOTHING");
const orphaned = mk();
for (const d of EVERYTHING_BUT_BUILDING) attach(orphaned.id, d);
const ghostId = crypto.randomUUID();
place(orphaned.id, `tmpl-${ghostId}`);
{
  const forms = filledApplicationForms(db, orphaned.id);
  check("1a. filledApplicationForms does not list the orphan", forms.length === 0, JSON.stringify(forms.map((f) => `${f.docType}:${path.basename(f.filePath)}`)));
  check("1b. MUST STILL BLOCK: the orphan does not satisfy the building-side application row",
    blockingOf(orphaned).includes("building_application"), JSON.stringify(blockingOf(orphaned)));
}

console.log("\n2. SAME RULE FOR A NON-TEMPLATE FILE NAMING NO REGISTRY FORM");
const unknownReg = mk();
for (const d of EVERYTHING_BUT_BUILDING) attach(unknownReg.id, d);
place(unknownReg.id, "no-such-registry-form");
check("2a. an id the registry does not carry is not an application",
  filledApplicationForms(db, unknownReg.id).length === 0 && blockingOf(unknownReg).includes("building_application"),
  JSON.stringify(blockingOf(unknownReg)));

console.log("\n3. COUNTER-FIXTURE — a fill whose template row EXISTS still satisfies the row");
const real = mk();
for (const d of EVERYTHING_BUT_BUILDING) attach(real.id, d);
const templateId = storeAhjFormTemplate(db, {
  ahjName: "City of Orphanville", state: "OR", formType: "building_application",
  filename: "Prescriptive Solar Building Permit Application.pdf",
  bytes: new Uint8Array(Buffer.from("%PDF-1.4 blank")), applicationKind: "prescriptive",
  map: { formName: "Prescriptive Solar Building Permit Application", sourceUrl: "", fillMode: "acroform", textFields: {}, checkboxes: {}, notes: "" },
} as never);
place(real.id, `tmpl-${templateId}`);
{
  const forms = filledApplicationForms(db, real.id);
  check("3a. listed, with the docType its template row carries",
    forms.length === 1 && forms[0].docType === "building_application", JSON.stringify(forms.map((f) => f.docType)));
  check("3b. and nothing blocks", blockingOf(real).length === 0, JSON.stringify(blockingOf(real)));
}

console.log("\n4. THE ORPHAN BESIDE A REAL FILL — only the real one is listed");
place(real.id, `tmpl-${crypto.randomUUID()}`);
check("4a. still exactly one form", filledApplicationForms(db, real.id).length === 1, String(filledApplicationForms(db, real.id).length));

console.log(failures ? `\norphanFilledForms: ${failures} FAILED` : "\norphanFilledForms: all passed");
process.exit(failures ? 1 : 0);
