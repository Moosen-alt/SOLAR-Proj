// KPI: "SUBMITTED" IS THE FILING A PERSON SENT, AND EVERY CORRECTION KNOWS ITS FILING (#47).
//
// touchProjectMetrics took "submitted" from the first portal run's START (staging began), so every
// cycle number was early by however long the filing sat in awaiting_human_submit. Corrections were
// per PROJECT with no track: a utility deficiency counted as a permit correction, a notice with
// three items counted as three cycles, and every cure window was 5 days from ingestion.
//
// Synthetic data only. Run: npx tsx backend/test/kpiFilingTrack.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kpi-filing-track-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.CLIENT_NOTIFICATIONS = "off";
process.env.BACKGROUND_WORKERS = "off";
process.env.DOCUMENT_FETCH = "off";
process.env.AHJ_FORM_DOWNLOADS = "off";
process.env.AHJ_FORM_RESEARCH = "off";
process.env.FEE_RESEARCH = "off";
process.env.PORTAL_URL_RESEARCH = "off";
process.env.RUN_TRIAGE = "off";
delete process.env.SMTP_HOST;
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const kb = await import("../src/knowledgeBase");
const { touchProjectMetrics } = await import("../src/kpi");
let db = await openDatabase();

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   - ${name}`);
};

const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();
type Row = Record<string, unknown>;

function makeProject(owner: string, utility: string): string {
  const { project } = R.createProject(db, {
    owner, street: "1 Test St", city: "Testville", state: "CA", zip: "90000", ahj: "Testville", utility, dcKw: "5", acKw: "4",
  } as never);
  return project.id;
}
function seedSubmission(projectId: string, submissionType: string, permitType: string, submittedAt: string): string {
  const sid = `sub-${Math.random().toString(36).slice(2, 10)}`;
  db.run(
    `INSERT INTO submissions (id, project_id, submission_type, permit_type, status, submitted_at, created_at)
     VALUES (?, ?, ?, ?, 'submitted', ?, ?)`,
    [sid, projectId, submissionType, permitType, submittedAt, submittedAt],
  );
  return sid;
}
const corrections = (projectId: string) =>
  db.query<Row>("SELECT * FROM corrections WHERE project_id = ? ORDER BY created_at", [projectId]);
const filing = (submissionId: string) => db.get<Row>("SELECT * FROM filing_metrics WHERE submission_id = ?", [submissionId]);

// ── one project, a building filing and a NEM filing; staging STARTED long before either was sent ──
const p = makeProject("Filing Track One", "Pacific Gas and Electric");
const buildingSentAt = iso(20);
const nemSentAt = iso(8);
const building = seedSubmission(p, "permit", "building", buildingSentAt);
const nem = seedSubmission(p, "interconnection", "nem", nemSentAt);
db.run(
  `INSERT INTO portal_runs (id, project_id, run_type, status, started_at) VALUES ('run-early', ?, 'prepare_submit', 'staged', ?)`,
  [p, iso(30)],
);

// A permit notice with THREE items: one notice, three rows sharing its notice id.
const noticeDate = iso(5);
for (const item of ["Add fire setback dimensions.", "Show attachment spacing.", "Provide the rafter span table."]) {
  R.addManualCorrection(db, p, item, "manual", { noticeId: "notice-permit-1", noticedAt: noticeDate, submissionId: building });
}

// A NEM deficiency read on the utility's own tracking target, dated by the message it came in.
const nemTarget = R.createPermitCheckTarget(db, p, { jurisdiction: "Pacific Gas and Electric", applicationNumber: "NEM-TEST-1", targetType: "nem" })
  .permitCheckTargets.find((t) => t.targetType === "nem")!;
const deficiencyDate = iso(3);
await R.recordPermitStatusCheck(db, p, {
  targetId: nemTarget.id, source: "manual", noticedAt: deficiencyDate,
  rawStatusText: "Application deficient: correction required. Revise and resubmit the single-line diagram.",
});

// A note typed with no filing named, on a project with two filings: unknown, never guessed.
R.addManualCorrection(db, p, "Call the homeowner about the panel location.");
touchProjectMetrics(db, p);

const rows = corrections(p);
const permitRows = rows.filter((r) => r.notice_id === "notice-permit-1");
check("the three permit items carry the building track and the building filing",
  permitRows.length === 3 && permitRows.every((r) => r.track === "building" && r.submission_id === building), JSON.stringify(permitRows.map((r) => [r.track, r.submission_id])));
check("the permit items keep the notice's own date", permitRows.length === 3 && permitRows.every((r) => r.noticed_at === noticeDate), String(permitRows[0]?.noticed_at));
const nemRow = rows.find((r) => r.track === "nem");
check("the deficiency read on the NEM target is tagged nem, on the NEM filing", nemRow?.submission_id === nem, JSON.stringify(nemRow && { track: nemRow.track, sub: nemRow.submission_id }));
check("the NEM cure window is the utility's (10 days for PG&E), not the 5-day default", Number(nemRow?.sla_days) === 10, String(nemRow?.sla_days));
check("the cure clock starts on the notice's date", nemRow?.noticed_at === deficiencyDate
  && nemRow?.due_at === new Date(Date.parse(deficiencyDate) + 10 * DAY).toISOString().slice(0, 10), `${nemRow?.noticed_at} ${nemRow?.due_at}`);
check("each permit item keeps the 5-day default", permitRows.length === 3 && permitRows.every((r) => Number(r.sla_days) === 5), JSON.stringify(permitRows.map((r) => r.sla_days)));
const unknown = rows.find((r) => String(r.correction_text).includes("panel location"));
check("a correction naming no filing on a two-filing project is unknown ('')", unknown?.track === "" && unknown?.submission_id == null, JSON.stringify(unknown && [unknown.track, unknown.submission_id]));
check("…and it is its own notice", Boolean(unknown?.notice_id) && unknown?.notice_id !== "notice-permit-1", String(unknown?.notice_id));

const metrics = db.get<Row>("SELECT * FROM project_metrics WHERE project_id = ?", [p]);
check("project submitted_at is the earliest submissions.submitted_at, not the portal run's start",
  metrics?.submitted_at === buildingSentAt, `${metrics?.submitted_at} vs ${buildingSentAt}`);

const bf = filing(building);
check("building filing: 1 cycle / 3 items", Number(bf?.notice_count) === 1 && Number(bf?.item_count) === 3, JSON.stringify(bf));
check("building filing: submitted_at and first notice from its own rows",
  bf?.track === "building" && bf?.submitted_at === buildingSentAt && bf?.first_notice_at === noticeDate, JSON.stringify(bf));
const nf = filing(nem);
check("NEM filing: 1 deficiency", nf?.track === "nem" && Number(nf?.notice_count) === 1 && Number(nf?.item_count) === 1, JSON.stringify(nf));
check("NEM filing submitted_at is the NEM submission's", nf?.submitted_at === nemSentAt, String(nf?.submitted_at));
check("rule 2: no notice text in a metrics row", !JSON.stringify([bf, nf, metrics]).match(/setback|single-line|homeowner/i));

// ── a utility with no cure window on its record keeps the 5-day default ──
const q = makeProject("Filing Track Two", "Testville Municipal Utility");
const qNem = seedSubmission(q, "interconnection", "nem", iso(4));
const qTarget = R.createPermitCheckTarget(db, q, { jurisdiction: "Testville Municipal Utility", applicationNumber: "NEM-TEST-2", targetType: "nem" })
  .permitCheckTargets.find((t) => t.targetType === "nem")!;
await R.recordPermitStatusCheck(db, q, {
  targetId: qTarget.id, source: "manual",
  rawStatusText: "Application deficient: correction required. Revise and resubmit the single-line diagram.",
});
const qRow = corrections(q)[0];
check("another utility's deficiency: nem track, 5-day default", qRow?.track === "nem" && Number(qRow?.sla_days) === 5, JSON.stringify(qRow && [qRow.track, qRow.sla_days]));

// …and a window on the utility's own record (its state|—|utility row) is the one used.
const utilityRow = (utility: string, days: number | null) => db.run(
  `INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, deficiency_cure_days, first_seen_at, last_learned_at, updated_at)
   VALUES (?, ?, 'CA', '', ?, ?, ?, ?, ?)`,
  [`kb-${utility.length}-${days}`, kb.knowledgeProfileKey({ state: "CA", ahj: "", utility }), utility, days, iso(0), iso(0), iso(0)],
);
utilityRow("Testville Municipal Utility", 7);
R.addManualCorrection(db, q, "Provide the signed interconnection agreement.", "manual", { submissionId: qNem });
const qRecord = corrections(q).find((r) => String(r.correction_text).includes("interconnection agreement"));
check("a cure window on the utility's record wins over the default", qRecord?.track === "nem" && Number(qRecord?.sla_days) === 7, JSON.stringify(qRecord && [qRecord.track, qRecord.sla_days]));
let threw = false;
try { R.addManualCorrection(db, q, "Wrong filing.", "manual", { submissionId: building }); } catch { threw = true; }
check("naming another project's filing is refused", threw);

// ── replaying migration v43 is idempotent and keeps what it stamped ──
utilityRow("Pacific Gas and Electric", null); // a PG&E utility row with no window yet
db.run("DELETE FROM schema_meta WHERE version >= 43");
db.close?.();
db = await openDatabase();
check("v43 re-applied", Boolean(db.get<Row>("SELECT version FROM schema_meta WHERE version = 43")));
check("replay kept the stamped rows", corrections(p).filter((r) => r.notice_id === "notice-permit-1").length === 3);
const cols = db.query<{ name: string }>("PRAGMA table_info(permit_utility_knowledge)").map((c) => c.name);
check("permit_utility_knowledge carries deficiency_cure_days", cols.includes("deficiency_cure_days"), cols.join(","));
const pgeDays = db.get<Row>("SELECT deficiency_cure_days AS d FROM permit_utility_knowledge WHERE profile_key = ?",
  [kb.knowledgeProfileKey({ state: "CA", ahj: "", utility: "Pacific Gas and Electric" })])?.d;
check("the boot seed stamped PG&E's utility record with its 10-day window", Number(pgeDays) === 10, String(pgeDays));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall kpi filing-track checks passed");
process.exit(0);
