// v47 HEALS A DB THAT RAN AN EARLIER v47 (#198; Helm's review of #218 at 0116f98a, Low).
//
// v47 (structural_letter_confirmations) was edited in place while #218 was open: a branch DB that
// ran an earlier v47 has the table without voided_at / void_reason, and project_documents without
// page_texts_json / source_document_id — and then throws on the first upload (saveProjectDocument
// stamps the void, the splitter writes the cut's source). db.healStructuralLetterColumns adds the
// columns at the end of v47 AND after the versioned migrations on every boot, so:
//   REPLAY   schema_meta rows >= 47 deleted (v47 re-runs) on the older column set: healed;
//   STAMPED  v47 left stamped on the older column set (v47 does NOT re-run): healed too;
// and in both, an old confirmation row survives and an upload to the structural slot works.
// Synthetic data only. Run: tsx backend/test/structuralLetterMigrationHeal.test.ts
import "./_isolate"; // FIRST: temp cwd + temp DB
import { PDFDocument } from "pdf-lib";

process.env.SEED_TEST_INSTALLER = "false";
process.env.ANTHROPIC_API_KEY = "";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.CODE_RESEARCH = "off";
process.env.SKIP_CODE_RESEARCH = "1";
process.env.DOCUMENT_FETCH = "off";
process.env.AHJ_FORM_DOWNLOADS = "off";
process.env.PORTAL_AUTOMATION = "off";
process.env.PORTAL_AUTOSEED = "0";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`  FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`  ok   - ${name}`);
};

const { openDatabase } = await import("../src/db");
type Db = Awaited<ReturnType<typeof openDatabase>>;
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { saveProjectDocument } = await import("../src/projectDocuments");

let db: Db = await openDatabase();
const client = createClient(db, {
  companyName: "Heal Solar LLC", legalBusinessName: "Heal Solar LLC", ccbLicenseNumber: "240137",
  electricalLicenseNumber: "C1236", businessEmail: "ops@heal.test", businessPhone: "(503) 555-0144",
});
const pid = createProject(db, {
  clientId: client.id, owner: "Heal Owner", street: "2 Example St", zip: "84000", city: "Testville", state: "UT",
  ahj: "City of Testville", utility: "Example Power",
}).project.id;
const onePagePdf = async (): Promise<Buffer> => { const d = await PDFDocument.create(); d.addPage([612, 792]); return Buffer.from(await d.save()); };

const cols = (table: string): string[] => db.query<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);

/** Put the DB back into the shape an EARLIER v47 left: the confirmations table without voided_*,
 *  project_documents without page_texts_json / source_document_id, and one standing confirmation. */
function toOlderV47(): void {
  db.exec("DROP TABLE IF EXISTS structural_letter_confirmations");
  db.exec(`
    CREATE TABLE structural_letter_confirmations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      page INTEGER NOT NULL DEFAULT 0,
      confirmed_by TEXT NOT NULL,
      confirmed_by_user_id TEXT NOT NULL DEFAULT '',
      confirmed_at TEXT NOT NULL,
      withdrawn_by TEXT NOT NULL DEFAULT '',
      withdrawn_at TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
  `);
  for (const c of ["source_document_id", "page_texts_json"]) {
    if (cols("project_documents").includes(c)) db.exec(`ALTER TABLE project_documents DROP COLUMN ${c}`);
  }
  db.run(
    "INSERT INTO structural_letter_confirmations (id, project_id, document_id, content_sha256, page, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [`old-${Math.random().toString(36).slice(2)}`, pid, "gone-doc", "0".repeat(64), 1, "Jane Example", "2026-10-01T00:00:00.000Z"],
  );
}
const healed = (): boolean => ["voided_at", "void_reason"].every((c) => cols("structural_letter_confirmations").includes(c))
  && ["page_texts_json", "source_document_id"].every((c) => cols("project_documents").includes(c));

for (const mode of ["REPLAY", "STAMPED"] as const) {
  toOlderV47();
  check(`${mode} fixture: the older v47 column set is in place`, !healed(), JSON.stringify([cols("structural_letter_confirmations"), cols("project_documents")]));
  if (mode === "REPLAY") db.run("DELETE FROM schema_meta WHERE version >= 47");
  db = await openDatabase();
  check(`${mode}: reopening heals the columns`, healed(), JSON.stringify([cols("structural_letter_confirmations"), cols("project_documents")]));
  check(`${mode}: v47 is stamped once`, (db.get<{ n: number }>("SELECT COUNT(*) AS n FROM schema_meta WHERE version = 47")?.n ?? 0) === 1);
  check(`${mode}: the older confirmation rows survive`,
    (db.get<{ n: number }>("SELECT COUNT(*) AS n FROM structural_letter_confirmations WHERE project_id = ? AND voided_at = '' AND void_reason = ''", [pid])?.n ?? 0) >= 1);
  let thrown = "";
  try {
    saveProjectDocument(db, pid, { docType: "structural", filename: "letter.pdf", contentType: "application/pdf", buffer: await onePagePdf(), source: "upload" });
    saveProjectDocument(db, pid, { docType: "structural", filename: "cut.pdf", contentType: "application/pdf", buffer: await onePagePdf(), source: "split", sourceDocumentId: "plan-x" });
  } catch (e) { thrown = e instanceof Error ? e.message : String(e); }
  check(`${mode}: an upload and a split cut to the structural slot work (the standing confirmation's void is stamped)`,
    !thrown && (db.get<{ n: number }>("SELECT COUNT(*) AS n FROM structural_letter_confirmations WHERE project_id = ? AND voided_at <> ''", [pid])?.n ?? 0) >= 1, thrown);
}

if (failures) {
  console.error(`structuralLetterMigrationHeal: ${failures} FAILED`);
  process.exit(1);
}
console.log("structuralLetterMigrationHeal: all checks passed");
process.exit(0);
