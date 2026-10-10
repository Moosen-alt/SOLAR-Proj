// ONE "NEWEST" RULE FOR PROJECT DOCUMENTS (#198; Helm's review of #218 at 0116f98a, Medium 2).
//
// The structural-letter gate (structuralLetterVoid) breaks a same-millisecond uploaded_at tie by
// rowid, but projectDocsByType (what the package and the portal bot ship), listProjectDocuments
// (the splitter's plan-set pick) and the plan-set text extraction read by uploaded_at alone — so on a
// tie the gate could credit one row while the package shipped another. All of them now order by
// uploaded_at DESC, rowid DESC: the row inserted last wins a tie, everywhere.
//
// Pinned on two same-millisecond pairs (plan_set, structural): every reader picks the later row,
// and the structural-letter candidate is the very row projectDocsByType ships.
// Synthetic PDFs only. Run: tsx backend/test/projectDocumentsNewestTie.test.ts
import "./_isolate"; // FIRST: temp cwd + temp DB
import { PDFDocument, StandardFonts } from "pdf-lib";

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
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const PD = await import("../src/projectDocuments");
const { structuralLetterCandidate } = await import("../src/structuralLetter");
const db = await openDatabase();

const client = createClient(db, {
  companyName: "Tie Break Solar LLC", legalBusinessName: "Tie Break Solar LLC", ccbLicenseNumber: "240136",
  electricalLicenseNumber: "C1235", businessEmail: "ops@tie.test", businessPhone: "(503) 555-0143",
});
const pid = createProject(db, {
  clientId: client.id, owner: "Tie Owner", street: "1 Example St", zip: "84000", city: "Testville", state: "UT",
  ahj: "City of Testville", utility: "Example Power",
}).project.id;

async function pdf(line: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText(line, { x: 40, y: 740, size: 10, font });
  return Buffer.from(await doc.save());
}
const save = async (docType: string, filename: string, line: string) =>
  PD.saveProjectDocument(db, pid, { docType, filename, contentType: "application/pdf", buffer: await pdf(line), source: "upload" });

const plan1 = await save("plan_set", "plan-1.pdf", "PLAN SET ONE");
const plan2 = await save("plan_set", "plan-2.pdf", "PLAN SET TWO");
const struct1 = await save("structural", "letter-1.pdf", "STRUCTURAL ONE");
const struct2 = await save("structural", "letter-2.pdf", "STRUCTURAL TWO");

// Let the background extraction finish, then pin each pair to ONE millisecond and give the plan sets
// distinct text (what the extraction query would hand the reviewer).
for (let i = 0; i < 200; i++) {
  const n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM project_documents WHERE project_id = ? AND COALESCE(extracted_text, '') = ''", [pid])?.n ?? 0;
  if (!n) break;
  await new Promise((r) => setTimeout(r, 25));
}
const TIE = "2026-10-09T00:00:00.000Z";
db.run("UPDATE project_documents SET uploaded_at = ? WHERE project_id = ?", [TIE, pid]);
db.run("UPDATE project_documents SET extracted_text = ? WHERE id = ?", ["PLAN-SET-MARKER-ONE", plan1.id]);
db.run("UPDATE project_documents SET extracted_text = ? WHERE id = ?", ["PLAN-SET-MARKER-TWO", plan2.id]);

const pathOf = (docId: string): string => String(db.get<{ p: string }>("SELECT stored_path AS p FROM project_documents WHERE id = ?", [docId])?.p);
const byType = PD.projectDocsByType(db, pid);
check("projectDocsByType: a same-millisecond plan_set tie ships the row inserted last", byType.plan_set === pathOf(plan2.id), byType.plan_set);
check("projectDocsByType: a same-millisecond structural tie ships the row inserted last", byType.structural === pathOf(struct2.id), byType.structural);
check("shippedPlanSetDocumentId agrees with projectDocsByType", PD.shippedPlanSetDocumentId(db, pid) === plan2.id, String(PD.shippedPlanSetDocumentId(db, pid)));
const listed = PD.listProjectDocuments(db, pid).map((d) => d.id);
check("listProjectDocuments: the later row of each tie is listed first",
  listed.indexOf(plan2.id) < listed.indexOf(plan1.id) && listed.indexOf(struct2.id) < listed.indexOf(struct1.id), JSON.stringify(listed));
const text = PD.planSetTextForProject(db, pid);
check("planSetTextForProject: the extraction reads the later plan set of a tie", text.includes("PLAN-SET-MARKER-TWO") && !text.includes("PLAN-SET-MARKER-ONE"), text.slice(0, 200));
const candidate = structuralLetterCandidate(db, pid);
check("the structural-letter candidate is the very row the package ships", candidate?.documentId === struct2.id && pathOf(candidate.documentId) === byType.structural,
  JSON.stringify(candidate));

if (failures) {
  console.error(`projectDocumentsNewestTie: ${failures} FAILED`);
  process.exit(1);
}
console.log("projectDocumentsNewestTie: all checks passed");
process.exit(0);
