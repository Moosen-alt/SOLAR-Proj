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
const { touchProjectMetrics, getKpiReport, requestNoticedAt, utilityDeficiencyCureDays } = await import("../src/kpi");
const { extractStatusDate } = await import("../src/permitMonitor");
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

// ── #58 (1): a portal reading with no notice date passed is dated by the status date it prints ──
const now = new Date("2026-10-04T12:00:00Z");
check("a labelled ISO status date is read", extractStatusDate("Record Status: Additional Info Required Status Date: 2026-09-28", now) === "2026-09-28");
check("a labelled US status date is read", extractStatusDate("Application Status: Deficient. Status Updated: 9/28/2026", now) === "2026-09-28");
check("a labelled month-name status date is read", extractStatusDate("Last Updated: Sept 28, 2026 — Revise and resubmit", now) === "2026-09-28");
check("an UNLABELLED date is not the notice's (filing / expiration dates ride the same page)",
  extractStatusDate("Record Status: Issued Expiration Date: 2026-09-28 Filed 2026-09-01", now) === null);
check("a date the calendar does not have is no date", extractStatusDate("Status Date: 02/30/2026", now) === null);
check("a status date after now is no date", extractStatusDate("Status Date: 2026-12-01", now) === null);
check("a word that is not a month is no date", extractStatusDate("Status Updated: Today 12, 2026", now) === null);
const r = makeProject("Filing Track Three", "Pacific Gas and Electric");
seedSubmission(r, "interconnection", "nem", iso(12));
const rTarget = R.createPermitCheckTarget(db, r, { jurisdiction: "Pacific Gas and Electric", applicationNumber: "NEM-TEST-3", targetType: "nem" })
  .permitCheckTargets.find((t) => t.targetType === "nem")!;
const printedDate = iso(6).slice(0, 10);
await R.recordPermitStatusCheck(db, r, {
  targetId: rTarget.id, source: "portal",
  rawStatusText: `Application Status: Deficient. Status Date: ${printedDate}. Correction required: revise and resubmit the single-line diagram.`,
});
const rRow = corrections(r)[0];
check("the portal reading's correction carries the page's status date as noticed_at",
  String(rRow?.noticed_at ?? "").slice(0, 10) === printedDate, String(rRow?.noticed_at));
check("…and its cure clock starts there, not at ingestion",
  rRow?.due_at === new Date(Date.parse(printedDate) + Number(rRow?.sla_days) * DAY).toISOString().slice(0, 10), `${rRow?.due_at} sla ${rRow?.sla_days}`);
const s3 = makeProject("Filing Track Four", "Testville Municipal Utility");
await R.recordPermitStatusCheck(db, s3, {
  targetId: R.createPermitCheckTarget(db, s3, { jurisdiction: "Testville Municipal Utility", applicationNumber: "NEM-TEST-4", targetType: "nem" })
    .permitCheckTargets.find((t) => t.targetType === "nem")!.id,
  source: "portal", rawStatusText: "Application deficient: correction required. Revise and resubmit the single-line diagram.",
});
check("no printed status date: noticed_at stays null (the clock falls back to created_at)", corrections(s3)[0]?.noticed_at == null, String(corrections(s3)[0]?.noticed_at));

// ── #58 (2): ONE overdue clock — the readers count from the notice's date like breachedSla does ──
const o = makeProject("Filing Track Overdue", "Testville Municipal Utility");
const unstamped = (cid: string, noticedAt: string | null, createdAt: string) => db.run(
  `INSERT INTO corrections (id, project_id, source, correction_text, source_text, correction_bucket, root_cause, required_action,
     assigned_to, draft_response, human_approved, resubmitted, new_rule_recommended, created_at, closed_at,
     track, submission_id, notice_id, noticed_at, sla_days, due_at)
   VALUES (?, ?, 'manual', 'Synthetic item.', '', 'other', '', '', '', '', 0, 0, 0, ?, NULL, '', NULL, ?, ?, 5, NULL)`,
  [cid, o, createdAt, cid, noticedAt, ],
);
unstamped("corr-old-notice", iso(10), iso(0)); // noticed 10 days ago, typed today: overdue
unstamped("corr-new-notice", iso(1), iso(10)); // typed 10 days ago, noticed yesterday: not yet
const overdueIds = R.listOverdueCorrections(db).map((c) => c.id);
check("listOverdueCorrections starts an unstamped row's clock at noticed_at (overdue)", overdueIds.includes("corr-old-notice"), overdueIds.join(","));
check("…and not at created_at (a fresh notice typed late is not overdue)", !overdueIds.includes("corr-new-notice"), overdueIds.join(","));
const mapped = (cid: string) => R.mapCorrection(db.get<Row>("SELECT * FROM corrections WHERE id = ?", [cid])!).isOverdue;
check("mapCorrection agrees on both rows", mapped("corr-old-notice") === true && mapped("corr-new-notice") === false);
const report = getKpiReport(db);
check("the KPI report's overdue count is the same clock as listOverdueCorrections",
  report.overdueCorrections === overdueIds.length, `${report.overdueCorrections} vs ${overdueIds.length}`);

// ── #58 (5): the route's notice date — absent is null, an unparseable one is a 400 ──
check("requestNoticedAt: absent / blank is null", requestNoticedAt(undefined) === null && requestNoticedAt(null) === null && requestNoticedAt("  ") === null);
check("requestNoticedAt: a date passes", requestNoticedAt("2026-09-28") === "2026-09-28");
for (const bad of ["not a date", "2026-13-45", 20260928, { at: "2026-09-28" }]) {
  let status = 0;
  try { requestNoticedAt(bad); } catch (err) { status = Number((err as { status?: number }).status); }
  check(`requestNoticedAt: ${JSON.stringify(bad)} is a 400`, status === 400, String(status));
}

// ── #58 (4): the boot seed never lands in a human-verified row, and an explicit 0 is never re-seeded ──
check("precondition: the PG&E spellings below are PG&E to the seed",
  kb.seededDeficiencyCureDays("CA", "PG&E") === 10 && kb.seededDeficiencyCureDays("CA", "Pacific Gas & Electric Co") === 10);
utilityRow("PG&E", 0); // a person cleared the window
utilityRow("Pacific Gas & Electric Co", null);
db.run("UPDATE permit_utility_knowledge SET verified_at = ?, verified_by = 'synthetic reviewer' WHERE profile_key = ?",
  [iso(1), kb.knowledgeProfileKey({ state: "CA", ahj: "", utility: "Pacific Gas & Electric Co" })]);
check("a cleared (0) window on the utility's record takes the default, not the seed",
  utilityDeficiencyCureDays(db, { state: "CA", utility: "PG&E" }) === 5, String(utilityDeficiencyCureDays(db, { state: "CA", utility: "PG&E" })));

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
const daysOf = (utility: string) => db.get<Row>("SELECT deficiency_cure_days AS d FROM permit_utility_knowledge WHERE profile_key = ?",
  [kb.knowledgeProfileKey({ state: "CA", ahj: "", utility })])?.d;
check("rule 3: the boot seed left the human-verified PG&E row's window empty", daysOf("Pacific Gas & Electric Co") == null, String(daysOf("Pacific Gas & Electric Co")));
check("the boot seed did not re-seed the cleared (0) window", Number(daysOf("PG&E")) === 0 && daysOf("PG&E") != null, String(daysOf("PG&E")));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall kpi filing-track checks passed");
process.exit(0);
