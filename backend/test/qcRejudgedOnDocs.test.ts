// A QC VERDICT THAT DEPENDS ON THE DOCUMENTS IS RE-JUDGED WHEN THE DOCUMENTS CHANGE (dry run
// 2026-09-28, B7).
//
// createProject runs QC inside the POST, before any upload lands, so every new project's document
// rows start out "Site plan is not attached … Staging will refuse without it". The local chain then
// split the plan set at qc_passed / ready_to_stage WITHOUT re-running QC (it re-ran only at parsed /
// qc_failed), so the rows stayed — badged FAIL on the QC panel and listed by the gate under a
// document check that itself passed. Staging then succeeded, so the message was false.
//
// Pinned:
//   2a THE POINT      — a split at qc_passed re-judges QC; no "Staging will refuse" row survives for a
//                       sheet the split filed.
//   2b MUST-PASS      — no document change, no re-run (the chain does not spin; autoStageSteps 2a).
//   2c REMOVAL        — deleting a filed sheet re-judges too ("attached" must not outlive the file).
//   2d THE NEWS IS REAL — a bill uploaded to a ready_to_stage project whose account number nobody
//                       could read re-judges to qc_failed and the chain stops there (qc.ts: "once a
//                       bill IS on file and the value is still missing, it is a real failure").
//
// KILLS (verified by hand): STEP 1 back to `parsed || qc_failed` only -> 2a, 2c, 2d FAIL;
// documentsChangedAt ignoring removals -> 2c FAILS.
//
//   npx tsx backend/test/qcRejudgedOnDocs.test.ts
import "./_isolate"; // FIRST: temp cwd, so filled/ docs/ never land in the repo's backend/data
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qc-rejudged-docs-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(dir, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(dir, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
delete process.env.AUTO_STAGE_STEPS;
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { saveProjectDocument, deleteProjectDocument } = await import("../src/projectDocuments");
const { processStageStep } = await import("../src/autoStageSteps");
const { PDFDocument, StandardFonts } = await import("pdf-lib");

const db = await openDatabase();
let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};
const tick = () => new Promise((r) => setTimeout(r, 15)); // ISO timestamps are ms-grained
const status = (pid: string): string => String(db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", [pid])?.status);
const refusing = (pid: string): Array<{ rule_id: string; message: string }> => db.query<{ rule_id: string; message: string }>(
  "SELECT rule_id, message FROM qc_results WHERE project_id = ? AND rule_id LIKE 'docs.%' AND message LIKE '%Staging will refuse%'", [pid]);
const refusingTypes = (pid: string): string[] => refusing(pid).map((r) => r.rule_id.replace(/^docs\./, "")).sort();

const mkPdf = async (titles: string[]): Promise<Buffer> => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const title of titles) {
    const page = pdf.addPage([612, 792]);
    page.drawText(title, { x: 60, y: 700, size: 22, font });
    page.drawText("SCALE: NTS — fixture sheet for the QC re-judge test", { x: 60, y: 660, size: 10, font });
  }
  return Buffer.from(await pdf.save());
};
const planSet = await mkPdf(["SITE PLAN", "ELECTRICAL LINE DIAGRAM"]);

const client = createClient(db, { companyName: "Rejudge Solar", ccbLicenseNumber: "112255" });

console.log("\n2. A SPLIT AT qc_passed RE-JUDGES THE DOCUMENT ROWS");
const p = createProject(db, {
  clientId: client.id, owner: "Rejudge Owner 1", street: "1 Rejudge St", city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
}).project;
const bornRefusing = refusingTypes(p.id);
check("setup: QC at create wrote 'not attached … Staging will refuse' rows for the site plan and SLD",
  bornRefusing.includes("site_plan") && bornRefusing.includes("sld"), JSON.stringify(bornRefusing));
db.run("UPDATE projects SET status = 'qc_passed' WHERE id = ?", [p.id]);
await tick();
saveProjectDocument(db, p.id, { filename: "plan-set.pdf", docType: "plan_set", contentType: "application/pdf", buffer: planSet, source: "upload" });
const out = await processStageStep(db, p.id);
const splitTypes = db.query<{ doc_type: string }>(
  "SELECT doc_type FROM project_documents WHERE project_id = ? AND source = 'split'", [p.id]).map((r) => r.doc_type);
const stale = refusingTypes(p.id).filter((t) => splitTypes.includes(t));
check("2a. THE POINT: the chain split AND re-judged QC — no 'Staging will refuse' row for a sheet the split filed",
  out.ran.some((r) => r.startsWith("split(")) && out.ran.includes("qc") && stale.length === 0 && splitTypes.includes("site_plan"),
  `ran=${JSON.stringify(out.ran)} split=${JSON.stringify(splitTypes)} stale=${JSON.stringify(stale)}`);

// This thin fixture may legitimately FAIL QC on its intake fields (qc_failed re-runs QC by design —
// that is a re-save's repair loop, not the document rule), so 2b judges from qc_passed.
const statusAfter2a = status(p.id);
db.run("UPDATE projects SET status = 'qc_passed' WHERE id = ?", [p.id]);
const again = await processStageStep(db, p.id);
check("2b. MUST-PASS: nothing changed since QC -> no re-run (the chain does not spin)", !again.ran.includes("qc"),
  `ran=${JSON.stringify(again.ran)} (status after 2a: ${statusAfter2a})`);

console.log("\n2c. A REMOVAL RE-JUDGES TOO");
const sitePlan = db.get<{ id: string }>("SELECT id FROM project_documents WHERE project_id = ? AND doc_type = 'site_plan' AND source = 'split'", [p.id]);
if (!["qc_passed", "ready_to_stage"].includes(status(p.id))) db.run("UPDATE projects SET status = 'qc_passed' WHERE id = ?", [p.id]);
await tick();
if (sitePlan) deleteProjectDocument(db, p.id, sitePlan.id);
const afterDelete = await processStageStep(db, p.id);
check("2c. THE POINT: deleting the split site plan re-judges QC and the 'not attached' row is back",
  Boolean(sitePlan) && afterDelete.ran.includes("qc") && refusingTypes(p.id).includes("site_plan"),
  `ran=${JSON.stringify(afterDelete.ran)} refusing=${JSON.stringify(refusingTypes(p.id))}`);

// The smoke's proven QC-clearing Portland job (the _stageFixture field set; fake identifiers).
const portlandJob = (n: number, account: string, meter: string) => createProject(db, {
  clientId: client.id, owner: `Rejudge Owner ${n}`, street: `${n} Rejudge St`, city: "Portland", state: "OR", zip: "97201",
  ahj: "Portland", utility: "PGE", account, meter,
  dcKw: "8.6", acKw: "6.5", exportKw: "6.5",
  moduleMake: "Qcells", moduleModel: "Q.TRON BLK M-G2.C1+/AC", moduleWattage: "430", moduleQty: "20",
  invModel: "IQ8M", invQty: "20", invOutputW: "325",
  interco: "Load-side breaker", busRating: "200", mainBreaker: "200", pvBreaker: "40",
  permitPath: "PRESCRIPTIVE", roofRafterSpacing: "24", roofRafterSpan: "10", snow: "25", deadLoad: "3.2", wind: "B",
} as never).project;

console.log("\n2e. A PASSING RE-JUDGE NEVER DEMOTES");
const r = portlandJob(3, "1234567890", "987654321");
check("setup: the Portland job clears QC at create", status(r.id) === "qc_passed", status(r.id));
db.run("UPDATE projects SET status = 'ready_to_stage' WHERE id = ?", [r.id]);
await tick();
saveProjectDocument(db, r.id, { filename: "module-spec.pdf", docType: "module_spec", contentType: "application/pdf", buffer: await mkPdf(["MODULE DATASHEET"]), source: "upload" });
const rOut = await processStageStep(db, r.id);
check("2e. MUST-EXCLUDE: a new document re-judges a ready_to_stage project, and a pass leaves it ready_to_stage (no rebuild, no demotion)",
  rOut.ran.includes("qc") && status(r.id) === "ready_to_stage" && !rOut.ran.some((x) => x.startsWith("build_docs")),
  `ran=${JSON.stringify(rOut.ran)} status=${status(r.id)}`);

console.log("\n2d. A BILL ON FILE WITH NO READABLE ACCOUNT NUMBER IS REAL NEWS");
const q = portlandJob(2, "", "");
const waiting = db.query<{ qc_status: string }>(
  "SELECT qc_status FROM qc_results WHERE project_id = ? AND rule_id IN (SELECT rule_id FROM qc_results WHERE project_id = ? AND message LIKE 'Waiting on the customer%')", [q.id, q.id]);
check("setup: with no bill on file the account number is a named WAIT, not a failure",
  waiting.length > 0 && waiting.every((r) => r.qc_status === "warning"), JSON.stringify(waiting));
db.run("UPDATE projects SET status = 'ready_to_stage' WHERE id = ?", [q.id]);
await tick();
saveProjectDocument(db, q.id, { filename: "bill.pdf", docType: "utility_bill", contentType: "application/pdf", buffer: await mkPdf(["UTILITY BILL"]), source: "upload" });
const billOut = await processStageStep(db, q.id);
check("2d. MUST-PASS: the chain re-judged QC and the missing account number is now a FAIL — it stops at qc_failed",
  billOut.ran.includes("qc") && billOut.stoppedAt === "qc_failed" && status(q.id) === "qc_failed",
  `ran=${JSON.stringify(billOut.ran)} stoppedAt=${billOut.stoppedAt} status=${status(q.id)}`);

// saveProjectDocument fires a void text extraction; let it land before db.close().
for (let i = 0; i < 40; i += 1) {
  const busy = Number(db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM project_documents WHERE project_id IN (?, ?, ?) AND source = 'upload' AND extracted_text = ''", [p.id, q.id, r.id])?.n ?? 0);
  if (busy === 0) break;
  await new Promise((r) => setTimeout(r, 100));
}

console.log(failures ? `\nqcRejudgedOnDocs: ${failures} check(s) FAILED` : "\nqcRejudgedOnDocs: all checks passed");
db.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
