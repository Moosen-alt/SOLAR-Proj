// KPI REPORT (#49): first-pass rate, cycles by cause, per-AHJ p50/p90, NEM deficiency + cure,
// reviewer-gate misses, human minutes per filing, human queue age, open past p90 — every number
// with its n and denominator, rates on fewer than 10 filings flagged smallN (shown greyed).
// getKpiReport is a READ: it writes nothing (the nextStep invariant).
//
// Synthetic data only. Run: npx tsx backend/test/kpiReport.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kpi-report-"));
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
const { knowledgeProfileKey } = await import("../src/knowledgeBase");
const { getKpiReport, kpiRate } = await import("../src/kpi");
const db = await openDatabase();

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   - ${name}`);
};
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();
const plus = (at: string, days: number) => new Date(Date.parse(at) + days * DAY).toISOString();
let seq = 0;

function project(ahj: string): string {
  return R.createProject(db, {
    owner: `Synthetic Owner ${++seq}`, street: "1 Test St", city: ahj, state: "CA", zip: "90000", ahj,
    utility: "Synthetic Power", dcKw: "5", acKw: "4",
  } as never).project.id;
}
/** One sent filing and its filing_metrics row (finished = issued / approved, null = open). */
function filing(pid: string, track: string, submittedAt: string, finishedAt: string | null, notices = 0): string {
  const sid = `sub-${++seq}`;
  db.run(
    `INSERT INTO submissions (id, project_id, submission_type, permit_type, status, submitted_at, submitted_by, created_at)
     VALUES (?, ?, ?, ?, 'submitted', ?, 'operator', ?)`,
    [sid, pid, track === "nem" ? "interconnection" : "permit", track, submittedAt, submittedAt],
  );
  db.run(
    `INSERT INTO filing_metrics (submission_id, project_id, track, submitted_at, finished_at, notice_count, item_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [sid, pid, track, submittedAt, finishedAt, notices, notices, iso(0)],
  );
  return sid;
}
function correction(pid: string, sid: string, track: string, bucket: string, noticeId: string, noticedAt: string, closedAt: string | null, slaDays = 5): void {
  db.run(
    `INSERT INTO corrections (id, project_id, source, correction_text, correction_bucket, created_at, closed_at,
       track, submission_id, notice_id, noticed_at, sla_days, due_at)
     VALUES (?, ?, 'manual', 'Synthetic item.', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`c-${++seq}`, pid, bucket, noticedAt, closedAt, track, sid, noticeId, noticedAt, slaDays, plus(noticedAt, slaDays).slice(0, 10)],
  );
}
function sample(pid: string, key: string, track: string, startAt: string, days: number): void {
  db.run(
    `INSERT INTO permit_timeline_samples (id, project_id, profile_key, track, milestone, start_at, end_at, days, created_at)
     VALUES (?, ?, ?, ?, 'issued', ?, ?, ?, ?)`,
    [`s-${++seq}`, pid, key, track, startAt, plus(startAt, days), days, iso(0)],
  );
}
function audit(pid: string, action: string, details: Record<string, unknown>, at: string): void {
  db.run(
    `INSERT INTO audit_logs (id, project_id, actor_type, actor_name, action, details, created_at) VALUES (?, ?, 'system', 'test', ?, ?, ?)`,
    [`a-${++seq}`, pid, action, JSON.stringify(details), at],
  );
}

const testvilleKey = knowledgeProfileKey({ state: "CA", ahj: "Testville", utility: "Synthetic Power" });

// ── Permits: Testville building ×3, Otherville electrical ×1 ──
const p1 = project("Testville");
const f1 = filing(p1, "building", iso(40), iso(30));          // issued, zero notices: first pass
sample(p1, testvilleKey, "building", iso(40), 10);
const p2 = project("Testville");
const f2 = filing(p2, "building", iso(35), iso(15), 2);       // issued after two notices
sample(p2, testvilleKey, "building", iso(35), 20);
correction(p2, f2, "building", "A_we_fix", "n-a", iso(30), iso(28));
correction(p2, f2, "building", "A_we_fix", "n-a", iso(30), iso(28));   // same notice, second item
correction(p2, f2, "building", "B_designer_fix", "n-b", iso(25), iso(22));
const p3 = project("Testville");
const f3 = filing(p3, "building", iso(60), null, 2);          // still open, 60 days > Testville p90 (20)
correction(p3, f3, "building", "C_reviewer_clarification", "n-c", iso(50), null);
correction(p3, f3, "building", "", "n-u", iso(45), null);     // unclassified: never the AHJ's share
const p4 = project("Otherville");
filing(p4, "electrical", iso(20), iso(10));

// ── NEM: one deficiency cured in 14 days against a 10-day window (a breach), one clean approval ──
const n1 = filing(p1, "nem", iso(50), iso(20), 1);
correction(p1, n1, "nem", "B_designer_fix", "d-1", iso(40), iso(26), 10);
filing(p2, "nem", iso(30), iso(18));

// ── Reviewer gate: p2's gate said nothing before its bucket-A notice (a miss); p3's gate blocked
//    and an operator overrode it (a false positive). ──
audit(p2, "reviewer_report.generated", { blockerCount: 0, warningCount: 0 }, iso(36));
audit(p3, "reviewer_report.generated", { blockerCount: 2, warningCount: 1 }, iso(62));
audit(p3, "project.status_overridden", { from: "qc_passed", to: "ready_to_stage", reason: "operator judged the blockers moot" }, iso(61));

// ── Human minutes, seeded through the write path: recordPortalRun finishes the prepare_submit run
//    and INSERTs the awaiting_human_submit row in one transaction; captureConfirmation then UPDATEs
//    that row in place AND overwrites the run's finished_at with the submit time. p1's building
//    filing was staged 90 minutes before a person sent it. ──
const MIN = 60_000;
function stagedThenSent(pid: string, track: string, stagedAt: string, sentAt: string, by: string, sid = `sub-${++seq}`): string {
  db.run(
    `INSERT INTO portal_runs (id, project_id, run_type, status, started_at, finished_at, permit_type)
     VALUES (?, ?, 'prepare_submit', 'running', ?, NULL, ?)`,
    [`run-${sid}`, pid, new Date(Date.parse(stagedAt) - 5 * MIN).toISOString(), track],
  );
  db.run("UPDATE portal_runs SET status = 'awaiting_human_submit', finished_at = ? WHERE id = ?", [stagedAt, `run-${sid}`]);
  db.run(
    `INSERT INTO submissions (id, project_id, submission_type, permit_type, status, created_at)
     VALUES (?, ?, ?, ?, 'awaiting_human_submit', ?) ON CONFLICT(id) DO UPDATE SET status = 'awaiting_human_submit', created_at = excluded.created_at, submitted_at = NULL`,
    [sid, pid, track === "nem" ? "interconnection" : "permit", track, stagedAt],
  );
  db.run("UPDATE portal_runs SET status = 'submitted', finished_at = ? WHERE id = ?", [sentAt, `run-${sid}`]);
  db.run("UPDATE submissions SET status = 'submitted', submitted_at = ?, submitted_by = ? WHERE id = ?", [sentAt, by, sid]);
  return sid;
}
stagedThenSent(p1, "building", new Date(Date.parse(iso(40)) - 90 * MIN).toISOString(), iso(40), "operator", f1);
// Approve & auto-submit (autopilot.ts) and automation's own click took no human minutes.
stagedThenSent(p4, "electrical", iso(21), iso(20.5), "Pat Approver (approved autopilot)");
stagedThenSent(p2, "combo", iso(22), iso(21.9), "automation (final submit approved by Pat Approver)");
// ── Human queue: two filings waiting on a person, 3 days and 1 day ──
for (const [pid, age] of [[p4, 3], [p3, 1]] as const) {
  db.run(
    `INSERT INTO submissions (id, project_id, submission_type, permit_type, status, created_at)
     VALUES (?, ?, 'permit', 'combo', 'awaiting_human_submit', ?)`,
    [`q-${++seq}`, pid, iso(age)],
  );
}
// ── Another org's filing: never in the default tenant's numbers ──
db.run("INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES ('org-other', 'Other Synthetic Org', ?)", [iso(0)]);
const px = project("Testville");
db.run("UPDATE projects SET org_id = 'org-other' WHERE id = ?", [px]);
filing(px, "building", iso(10), iso(5));

// ── The report, trapped: a read writes nothing ──
const writes: string[] = [];
const saved = { run: db.run, exec: db.exec, transaction: db.transaction };
db.run = ((sql: string) => { writes.push(sql.trim().slice(0, 60)); }) as typeof db.run;
db.exec = ((sql: string) => { writes.push(sql.trim().slice(0, 60)); }) as typeof db.exec;
db.transaction = (<T>(f: () => T): T => { writes.push("transaction"); return f(); }) as typeof db.transaction;
let report: ReturnType<typeof getKpiReport>;
let across: ReturnType<typeof getKpiReport>;
try {
  report = getKpiReport(db, {});
  across = getKpiReport(db, { orgId: null });
} finally {
  Object.assign(db, saved);
}
check("getKpiReport writes nothing", writes.length === 0, writes.join(" | "));
const k = report.filings;

// 1. First pass
check("first pass: 2 of 4 permits issued with zero notices", k.firstPass.overall.n === 2 && k.firstPass.overall.of === 4, JSON.stringify(k.firstPass.overall));
check("first pass: 4 filings is small-n (greyed)", k.firstPass.overall.smallN === true && k.firstPass.overall.rate === 50);
const building = k.firstPass.byTrack.find((t) => t.key === "building");
check("first pass per track: building 1 of 3", building?.n === 1 && building?.of === 3, JSON.stringify(k.firstPass.byTrack));
const testville = k.firstPass.byAhj.find((a) => a.key === "Testville");
check("first pass per AHJ: Testville 1 of 3", testville?.n === 1 && testville?.of === 3, JSON.stringify(k.firstPass.byAhj));
check("the small-n rule: 10 filings is not small", kpiRate(9, 10).smallN === false && kpiRate(1, 9).smallN === true);
check("NEM filings are not permits", !k.firstPass.byTrack.some((t) => t.key === "nem"));

// 2. Cycles by cause
const cause = (c: string) => k.correctionCycles.byCause.find((x) => x.cause === c);
check("cycles: a two-item notice is ONE Keelix-catchable cycle", cause("keelix_catchable")?.notices === 1, JSON.stringify(k.correctionCycles.byCause));
check("cycles: design 1, AHJ discretionary 1", cause("design")?.notices === 1 && cause("ahj_discretionary")?.notices === 1);
check("cycles: unclassified reported on its own line", cause("unclassified")?.notices === 1);
check("cycles: per-permit denominator is the 4 permits", k.correctionCycles.permits === 4 && cause("design")?.perPermit === 0.25);
check("cycles: the NEM deficiency is not a permit cycle", k.correctionCycles.byCause.reduce((s, c) => s + c.notices, 0) === 4);
const trendNotices = k.correctionCycles.keelixPer100ByMonth.reduce((s, m) => s + m.notices, 0);
const trendPermits = k.correctionCycles.keelixPer100ByMonth.reduce((s, m) => s + m.permits, 0);
check("Keelix-catchable per 100 permits: monthly, 1 over 4 permits", trendNotices === 1 && trendPermits === 4, JSON.stringify(k.correctionCycles.keelixPer100ByMonth));

// 4. Submitted → issued, per AHJ from the timeline samples
const tvIssued = k.submitToIssued.byAhj.find((a) => a.key === testvilleKey);
check("submit→issued per AHJ: the KB's median (15) and p90 (20), n 2", tvIssued?.median === 15 && tvIssued?.p90 === 20 && tvIssued?.n === 2, JSON.stringify(k.submitToIssued));
check("submit→issued overall n counts only closed permits (3 of 4)", k.submitToIssued.overall.n === 3, JSON.stringify(k.submitToIssued.overall));

// 5. Interconnection
check("NEM deficiency rate: 1 of 2", k.interconnection.deficiencyRate.n === 1 && k.interconnection.deficiencyRate.of === 2, JSON.stringify(k.interconnection.deficiencyRate));
check("NEM cure days: 14, n 1", k.interconnection.cureDays.median === 14 && k.interconnection.cureDays.n === 1, JSON.stringify(k.interconnection.cureDays));
check("NEM breach: 14 days against a 10-day window", k.interconnection.cureBreaches.n === 1 && k.interconnection.cureBreaches.of === 1);
check("NEM submitted→approved: n 2 (30 and 12 days)", k.interconnection.submitToApproved.n === 2 && k.interconnection.submitToApproved.p90 === 30, JSON.stringify(k.interconnection.submitToApproved));

// 6. Reviewer gate
check("gate false negative: the A notice after a silent gate", k.reviewerGate.falseNegatives.n === 1 && k.reviewerGate.falseNegatives.of === 1, JSON.stringify(k.reviewerGate));
check("gate false positive: the override of a blocking gate", k.reviewerGate.falsePositives.n === 1 && k.reviewerGate.falsePositives.of === 1);

// 7. Human minutes
check("human minutes per filing: 90, n 1 (from the row, not the overwritten run finish)", k.humanMinutes.median === 90 && k.humanMinutes.n === 1, JSON.stringify(k.humanMinutes));
check("human minutes: autopilot-approved and automation filings left out", k.humanMinutes.n === 1);
check("blanks the human filled come from stagingQuality", k.blanksFilledPerRun.of === report.stagingQuality.measured);

// 8. Human queue
check("human queue: 2 waiting, oldest 3 days, 1 over 2 days",
  k.humanQueue.n === 2 && k.humanQueue.oldestDays === 3 && k.humanQueue.overAge === 1, JSON.stringify(k.humanQueue));

// 9. Open past p90
check("open past p90: the 60-day Testville filing", k.openPastP90.n === 1 && k.openPastP90.items[0]?.submissionId === f3, JSON.stringify(k.openPastP90));
check("open past p90: carries its AHJ's p90", k.openPastP90.items[0]?.p90Days === 20);

// Org scope
check("org scope: another org's filing stays out of the default tenant", k.firstPass.overall.of === 4);
check("org scope: null reads across orgs", across.filings.firstPass.overall.of === 5, JSON.stringify(across.filings.firstPass.overall));
check("rule 2: no correction text in the report", !JSON.stringify(report).includes("Synthetic item"));
void f1;

fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall kpiReport checks passed");
