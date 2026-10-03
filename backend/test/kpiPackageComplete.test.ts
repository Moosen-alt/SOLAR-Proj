// WHEN DID THE CLIENT HAND US A COMPLETE PACKAGE? (#48)
//
// "Days from complete package received → submitted" is Keelix's own turnaround SLA, and nothing
// recorded when the package became complete. project_metrics.package_complete_at is the LATER of
// (a) every required intake document present and (b) QC passed — derived by touchProjectMetrics
// from the documents and the audit log. A replaced document or a QC re-run after a failure moves
// it to the new completion; nothing ever moves it earlier. All data here is synthetic.
import "./_isolate"; // FIRST: temp cwd + PROJECT_DOCS_DIR
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kpi-package-complete-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { touchProjectMetrics, getKpiReport } = await import("../src/kpi");
const { id } = await import("../src/ids");

const db = await openDatabase();
let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`ok   - ${label}`); return; }
  failures += 1;
  console.log(`FAIL - ${label}${detail ? ` — ${detail}` : ""}`);
};

const day = (n: number, hh = "10"): string => `2026-01-0${n}T${hh}:00:00.000Z`;
const docsDir = path.join(dir, "docs");
fs.mkdirSync(docsDir, { recursive: true });

// A document row with a real (distinct) file behind it, uploaded at a synthetic moment.
const attach = (projectId: string, docType: string, at: string): string => {
  const docId = id();
  const stored = path.join(docsDir, `${docId}.pdf`);
  fs.writeFileSync(stored, `%PDF-1.4 synthetic ${docType} ${docId}`);
  db.run(
    `INSERT INTO project_documents (id, project_id, doc_type, original_filename, stored_path, content_type, size_bytes, source, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, 'application/pdf', 64, 'upload', 'test', ?)`,
    [docId, projectId, docType, `${docType}.pdf`, stored, at],
  );
  return docId;
};
const qcEvent = (projectId: string, to: "qc_passed" | "qc_failed", at: string): void => {
  db.run(
    `INSERT INTO audit_logs (id, project_id, actor_type, actor_name, action, details, created_at)
     VALUES (?, ?, 'system', 'qc gate', 'project.qc_status_written', ?, ?)`,
    [id(), projectId, JSON.stringify({ from: to === "qc_passed" ? "qc_failed" : "qc_passed", to }), at],
  );
};
const stamp = (projectId: string): string | null => {
  const v = db.get<{ t: string | null }>("SELECT package_complete_at AS t FROM project_metrics WHERE project_id = ?", [projectId])?.t;
  return v == null ? null : String(v);
};
const newProject = (clientId: string, owner: string): string => createProject(db, {
  clientId, owner, street: "1 Synthetic Way", city: "Testville", state: "OR", ahj: "City of Testville",
  utility: "Test Power Co", dcKw: "6", acKw: "5", mounting: "Roof mount", permitPath: "prescriptive",
} as never).project.id;
// The intake set the baseline asks for (the plan-set family + the two spec sheets).
const INTAKE_DAY1 = ["plan_set", "site_plan"];
const INTAKE_DAY2 = ["sld", "structural"];
const INTAKE_DAY3 = ["module_spec", "inverter_spec"];

const clientA = createClient(db, { companyName: "Alpha Synthetic Solar" });
const clientB = createClient(db, { companyName: "Beta Synthetic Solar" });

console.log("\n0. A REAL QC STATUS WRITE LEAVES ITS FACT IN THE AUDIT LOG");
const p1 = newProject(clientA.id, "Synthetic Owner One");
{
  const written = db.query<{ details: string }>(
    "SELECT details FROM audit_logs WHERE project_id = ? AND action = 'project.qc_status_written'", [p1]);
  check("0a. createProject's QC run recorded the status it wrote", written.length >= 1, `${written.length} row(s)`);
  // From here on the timeline is synthetic: drop the real run's facts so only the days below count.
  db.run("DELETE FROM audit_logs WHERE project_id = ? AND action IN ('project.qc_status_written','project.qc_completed','project.qc_rerun')", [p1]);
}

console.log("\n1. DOCUMENTS OVER THREE DAYS, QC PASSING ON DAY 2 → THE LAST DOCUMENT'S DAY");
{
  for (const t of INTAKE_DAY1) attach(p1, t, day(1));
  for (const t of INTAKE_DAY2) attach(p1, t, day(2));
  qcEvent(p1, "qc_passed", day(2, "12"));
  touchProjectMetrics(db, p1);
  check("1a. two of three days in: not complete yet", stamp(p1) === null, String(stamp(p1)));
  for (const t of INTAKE_DAY3) attach(p1, t, day(3));
  touchProjectMetrics(db, p1);
  check("1b. stamp = day 3 (last document), not day 2 (QC)", stamp(p1) === day(3), String(stamp(p1)));
}

console.log("\n2. A DOCUMENT REPLACED ON DAY 5 MOVES THE STAMP; IT NEVER MOVES BACK");
let replacement = "";
{
  replacement = attach(p1, "module_spec", day(5));
  touchProjectMetrics(db, p1);
  check("2a. stamp moves to day 5", stamp(p1) === day(5), String(stamp(p1)));
  attach(p1, "site_photo", day(5, "18"));
  touchProjectMetrics(db, p1);
  check("2b. a non-required upload does not move it", stamp(p1) === day(5), String(stamp(p1)));
  db.run("DELETE FROM project_documents WHERE id = ?", [replacement]);
  touchProjectMetrics(db, p1);
  check("2c. removing the replacement does not move it earlier", stamp(p1) === day(5), String(stamp(p1)));
}

console.log("\n3. QC LATER THAN THE DOCUMENTS; A FAIL THEN A RE-PASS MOVES IT LATER");
const p2 = newProject(clientB.id, "Synthetic Owner Two");
{
  db.run("DELETE FROM audit_logs WHERE project_id = ? AND action IN ('project.qc_status_written','project.qc_completed','project.qc_rerun')", [p2]);
  for (const t of [...INTAKE_DAY1, ...INTAKE_DAY2, ...INTAKE_DAY3]) attach(p2, t, day(1));
  qcEvent(p2, "qc_failed", day(1, "12"));
  touchProjectMetrics(db, p2);
  check("3a. documents complete but QC failing: no stamp", stamp(p2) === null, String(stamp(p2)));
  qcEvent(p2, "qc_passed", day(4));
  touchProjectMetrics(db, p2);
  check("3b. stamp = QC pass on day 4", stamp(p2) === day(4), String(stamp(p2)));
  qcEvent(p2, "qc_failed", day(6));
  touchProjectMetrics(db, p2);
  check("3c. a later QC failure keeps the stamp (never earlier, never erased)", stamp(p2) === day(4), String(stamp(p2)));
  qcEvent(p2, "qc_passed", day(7));
  touchProjectMetrics(db, p2);
  check("3d. the re-pass on day 7 moves it to day 7", stamp(p2) === day(7), String(stamp(p2)));
}

console.log("\n4. SUBMITTED ON DAY 6 → 1.0 DAYS, OVERALL AND PER CLIENT; READS WRITE NOTHING");
{
  // SUBMITTED = a person sent it (#47): a submissions row with submitted_at, not a staged run.
  db.run(
    `INSERT INTO portal_runs (id, project_id, run_type, status, started_at) VALUES (?, ?, 'prepare_submit', 'staged', ?)`,
    [id(), p2, day(6)],
  );
  db.run(
    `INSERT INTO submissions (id, project_id, submission_type, status, submitted_at, submitted_by, created_at)
     VALUES (?, ?, 'permit', 'submitted', ?, 'Synthetic Operator', ?)`,
    [id(), p1, day(6), day(6)],
  );
  touchProjectMetrics(db, p2);
  touchProjectMetrics(db, p1);
  check("4a. submitted stamp read back", String(db.get<{ t: string }>("SELECT submitted_at AS t FROM project_metrics WHERE project_id = ?", [p1])?.t) === day(6));
  // A replacement after submission is the correction cycle, not the intake SLA: frozen.
  attach(p1, "inverter_spec", day(8));
  touchProjectMetrics(db, p1);
  check("4b. a document after submission does not move the stamp", stamp(p1) === day(5), String(stamp(p1)));

  const fingerprint = (): string => JSON.stringify({
    m: db.query("SELECT * FROM project_metrics ORDER BY project_id"),
    a: db.get("SELECT COUNT(*) AS n FROM audit_logs"),
  });
  const before = fingerprint();
  const r = getKpiReport(db, { startDate: "2026-01-01", endDate: "2026-01-31" });
  check("4c. getKpiReport wrote nothing", fingerprint() === before);
  const p = r.packageToSubmitDays;
  check("4d. packageToSubmitDays = { median 1, p90 1, n 1 }", p.median === 1 && p.p90 === 1 && p.n === 1, JSON.stringify(p));
  const a = r.byClient.find((c) => c.clientId === clientA.id);
  check("4e. client A carries the same cycle with its n", a?.packageToSubmitDays.median === 1 && a?.packageToSubmitDays.n === 1, JSON.stringify(a));
  const b = r.byClient.find((c) => c.clientId === clientB.id);
  check("4f. client B has no cycle (not submitted): n 0, median null", b?.packageToSubmitDays.n === 0 && b?.packageToSubmitDays.median === null, JSON.stringify(b));
  check("4g. the unsubmitted complete package is counted as awaiting submit, aged past N days",
    r.packageAwaitingSubmit.n === 1 && r.packageAwaitingSubmit.overAge === 1 && r.packageAwaitingSubmit.olderThanDays > 0,
    JSON.stringify(r.packageAwaitingSubmit));
  check("4g'. a staged portal run is not a submission: client B's project is still awaiting",
    stamp(p2) === day(7) && db.get<{ t: string | null }>("SELECT submitted_at AS t FROM project_metrics WHERE project_id = ?", [p2])?.t == null);
  check("4h. and per client", b?.awaitingSubmit.n === 1 && a?.awaitingSubmit.n === 0, JSON.stringify({ a: a?.awaitingSubmit, b: b?.awaitingSubmit }));
}

console.log("\n5. LEGACY PASS: AT qc_passed WITH NO PASS FACT → THE LATEST QC RUN");
{
  const p3 = newProject(clientA.id, "Synthetic Owner Three");
  db.run("DELETE FROM audit_logs WHERE project_id = ? AND action IN ('project.qc_status_written','project.qc_completed','project.qc_rerun')", [p3]);
  for (const t of [...INTAKE_DAY1, ...INTAKE_DAY2, ...INTAKE_DAY3]) attach(p3, t, day(1));
  const runs = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM qc_results WHERE project_id = ?", [p3])?.n ?? 0);
  check("5a. createProject's QC run left qc_results rows", runs > 0, `${runs}`);
  db.run("UPDATE qc_results SET created_at = ? WHERE project_id = ?", [day(2), p3]);
  // A pass through a door that writes no fact (updateProject / a workflow / humanVerify).
  db.run("UPDATE projects SET status = 'qc_failed' WHERE id = ?", [p3]);
  touchProjectMetrics(db, p3);
  check("5b. not at qc_passed, no pass fact: no stamp", stamp(p3) === null, String(stamp(p3)));
  db.run("UPDATE projects SET status = 'qc_passed' WHERE id = ?", [p3]);
  touchProjectMetrics(db, p3);
  check("5c. at qc_passed with no fact: stamp = latest qc_results run (day 2)", stamp(p3) === day(2), String(stamp(p3)));
  // A recorded failure AFTER that run: the run cannot be the pass that followed it.
  const p4 = newProject(clientA.id, "Synthetic Owner Four");
  db.run("DELETE FROM audit_logs WHERE project_id = ? AND action IN ('project.qc_status_written','project.qc_completed','project.qc_rerun')", [p4]);
  for (const t of [...INTAKE_DAY1, ...INTAKE_DAY2, ...INTAKE_DAY3]) attach(p4, t, day(1));
  db.run("UPDATE qc_results SET created_at = ? WHERE project_id = ?", [day(2), p4]);
  qcEvent(p4, "qc_failed", day(3));
  db.run("UPDATE projects SET status = 'qc_passed' WHERE id = ?", [p4]);
  touchProjectMetrics(db, p4);
  check("5d. a QC run older than the last recorded failure is not the pass", stamp(p4) === null, String(stamp(p4)));
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
