// LEARNED TIMELINES MEASURE TURNAROUND, NOT POLLING (L2).
//
// The KB's average_timeline_days used to be a running average folded in on EVERY status check,
// measured from the project's first submissions row of ANY track (falling back to created_at).
// Production read Coos Bay 5.6 days and Hood River County 0.0 — the monitor's cadence, not the
// AHJ's. Now one sample per (project, track, milestone), on the FIRST reading, from that track's
// own submitted_at, and the KB fields are derived (median + n) from the samples table.
//
// Drives the real write path: createProject → createPermitCheckTarget → recordPermitStatusCheck.
// Only the submissions rows are seeded directly, because the thing under test is where the
// START time comes from, and a real captureConfirmation cannot back-date a filing.
// Run: npx tsx backend/test/timelineSamples.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "timeline-samples-"));
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
const db = await openDatabase();

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   ${name}`);
};

const DAY = 86400000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const AHJ = "Timelineton";
const UTILITY = "Pacific Power";

function makeProject(owner: string): string {
  const { project } = R.createProject(db, {
    owner, street: "1 Test St", city: AHJ, state: "OR", zip: "97000", ahj: AHJ, utility: UTILITY, dcKw: "5", acKw: "4",
  } as never);
  return project.id;
}
function seedSubmission(projectId: string, submissionType: string, permitType: string, status: string, createdAt: string, submittedAt: string | null): void {
  db.run(
    `INSERT INTO submissions (id, project_id, submission_type, permit_type, status, submitted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [`sub-${Math.random().toString(36).slice(2, 10)}`, projectId, submissionType, permitType, status, submittedAt, createdAt],
  );
}
const samples = (projectId: string) =>
  db.query<{ track: string; milestone: string; start_at: string; end_at: string; days: number; profile_key: string }>(
    "SELECT track, milestone, start_at, end_at, days, profile_key FROM permit_timeline_samples WHERE project_id = ? ORDER BY milestone", [projectId],
  );
const permitKey = kb.knowledgeProfileKey({ state: "OR", ahj: AHJ, utility: UTILITY });
const utilityKey = kb.knowledgeProfileKey({ state: "OR", ahj: "", utility: UTILITY });
const kbRow = (key: string) =>
  db.get<{ average_timeline_days: number | null; timeline_sample_count: number; timeline_notes_json: string }>(
    "SELECT average_timeline_days, timeline_sample_count, timeline_notes_json FROM permit_utility_knowledge WHERE profile_key = ?", [key],
  );

// ── 1. days are measured from THIS track's submitted_at — not a failed staging row, not the
//       other track's filing, not created_at — and a re-check of an issued permit is a look ──
const p1 = makeProject("Timeline One");
const submittedAt = iso(10 * DAY);
seedSubmission(p1, "interconnection", "nem", "submitted", iso(40 * DAY), iso(40 * DAY)); // other track, earlier
seedSubmission(p1, "permit", "combo", "failed", iso(30 * DAY), null);                      // staging row, earlier
seedSubmission(p1, "permit", "combo", "submitted", iso(12 * DAY), submittedAt);            // the filing
const t1 = R.createPermitCheckTarget(db, p1, { jurisdiction: AHJ, applicationNumber: "APP-1", permitType: "combo" })
  .permitCheckTargets.find((t) => t.targetType === "permit")!;

await R.recordPermitStatusCheck(db, p1, { targetId: t1.id, source: "manual", rawStatusText: "Plan review in progress." });
check("a 'waiting' reading earns no sample", samples(p1).length === 0, JSON.stringify(samples(p1)));

await R.recordPermitStatusCheck(db, p1, { targetId: t1.id, source: "manual", rawStatusText: "Permit issued. Download permit card." });
const firstIssued = samples(p1).find((s) => s.milestone === "issued");
check("the issued reading wrote one sample on the combo track", Boolean(firstIssued) && firstIssued!.track === "combo", JSON.stringify(samples(p1)));
check("start_at is the track's own submitted_at (not the failed row, not the NEM filing, not created_at)",
  firstIssued?.start_at === submittedAt, `${firstIssued?.start_at} vs ${submittedAt}`);
check("days measured from submitted_at (~10.0)", Math.abs(Number(firstIssued?.days) - 10) <= 0.1, String(firstIssued?.days));
check("permit sample keys to the permit profile", firstIssued?.profile_key === permitKey, String(firstIssued?.profile_key));

await new Promise((r) => setTimeout(r, 15));
await R.recordPermitStatusCheck(db, p1, { targetId: t1.id, source: "manual", rawStatusText: "Permit issued. Download permit card." });
await R.recordPermitStatusCheck(db, p1, { targetId: t1.id, source: "manual", rawStatusText: "Status: Issued" });
const issuedAfter = samples(p1).filter((s) => s.milestone === "issued");
check("re-checking an issued permit twice keeps ONE sample", issuedAfter.length === 1, JSON.stringify(issuedAfter));
check("…and it is the FIRST reading's (end_at unchanged)", issuedAfter[0]?.end_at === firstIssued?.end_at, `${issuedAfter[0]?.end_at} vs ${firstIssued?.end_at}`);

const row1 = kbRow(permitKey);
check("KB timeline = median of issued samples", Math.abs(Number(row1?.average_timeline_days) - 10) <= 0.1, String(row1?.average_timeline_days));
check("KB sample count = number of filings, not number of looks", row1?.timeline_sample_count === 1, String(row1?.timeline_sample_count));
const notes1 = JSON.parse(String(row1?.timeline_notes_json || "[]")) as string[];
check("no per-poll notes ('issued: …', 'waiting: …') on the profile", !notes1.some((n) => /^(issued|waiting): /.test(n)), JSON.stringify(notes1));
check("a derived median + n note", notes1.some((n) => /^Measured turnaround \(submitted to issued \/ approved\): median 10\.0 day\(s\), n=1$/.test(n)), JSON.stringify(notes1));

// ── 2. a filing with no submitted_at teaches nothing (never created_at) ─────────────────────
const p2 = makeProject("Timeline Two");
seedSubmission(p2, "permit", "combo", "awaiting_human_submit", iso(5 * DAY), null);
const t2 = R.createPermitCheckTarget(db, p2, { jurisdiction: AHJ, applicationNumber: "APP-2", permitType: "combo" })
  .permitCheckTargets.find((t) => t.targetType === "permit")!;
await R.recordPermitStatusCheck(db, p2, { targetId: t2.id, source: "manual", rawStatusText: "Permit issued." });
check("no submitted_at → no sample", samples(p2).length === 0, JSON.stringify(samples(p2)));
check("…and the KB count is unchanged", kbRow(permitKey)?.timeline_sample_count === 1, String(kbRow(permitKey)?.timeline_sample_count));

// ── 3. milestones stay apart; NEM keys to the UTILITY profile ───────────────────────────────
const p3 = makeProject("Timeline Three");
seedSubmission(p3, "permit", "combo", "submitted", iso(20 * DAY), iso(20 * DAY));
seedSubmission(p3, "interconnection", "nem", "submitted", iso(6 * DAY), iso(6 * DAY));
const d3 = R.createPermitCheckTarget(db, p3, { jurisdiction: AHJ, applicationNumber: "APP-3", permitType: "combo" });
const t3 = d3.permitCheckTargets.find((t) => t.targetType === "permit")!;
const n3 = R.createPermitCheckTarget(db, p3, { jurisdiction: UTILITY, applicationNumber: "NEM-3", targetType: "nem" })
  .permitCheckTargets.find((t) => t.targetType === "nem")!;
// Each target is first seen in review — a milestone is a TRANSITION the monitor observed (§6).
await R.recordPermitStatusCheck(db, p3, { targetId: t3.id, source: "manual", rawStatusText: "Plan review in progress." });
await R.recordPermitStatusCheck(db, p3, { targetId: n3.id, source: "manual", rawStatusText: "Application received. Engineering review in progress." });
await R.recordPermitStatusCheck(db, p3, { targetId: t3.id, source: "manual", rawStatusText: "Review comments: correction required, revise and resubmit the fire setback plan." });
await R.recordPermitStatusCheck(db, p3, { targetId: n3.id, source: "manual", rawStatusText: "PTO granted. Permission to operate." });
const s3 = samples(p3);
check("the correction is its own milestone", s3.some((s) => s.milestone === "correction_flagged" && s.track === "combo"), JSON.stringify(s3));
const nemSample = s3.find((s) => s.track === "nem");
check("NEM approval is the nem track's 'issued' milestone", nemSample?.milestone === "issued", JSON.stringify(s3));
check("NEM sample measured from the NEM filing (~6.0), not the permit's", Math.abs(Number(nemSample?.days) - 6) <= 0.1, String(nemSample?.days));
check("NEM sample keys to the utility-only profile", nemSample?.profile_key === utilityKey, String(nemSample?.profile_key));
check("the correction milestone did not enter the issuance median", Math.abs(Number(kbRow(permitKey)?.average_timeline_days) - 10) <= 0.1 && kbRow(permitKey)?.timeline_sample_count === 1,
  `${kbRow(permitKey)?.average_timeline_days} n=${kbRow(permitKey)?.timeline_sample_count}`);

// ── 4. deleting a project drops its samples, and the derived figure with them ───────────────
R.deleteProject(db, p1);
check("deleteProject removed the project's samples", samples(p1).length === 0);
const after = kbRow(permitKey);
check("…and the rebuilt KB timeline no longer counts it", after?.timeline_sample_count === 0 && after?.average_timeline_days == null,
  `${after?.average_timeline_days} n=${after?.timeline_sample_count}`);

// ── 5. the operator backfill clears a LEGACY polling timeline, keeps seeded notes ─────────────
// Raw SQL is the only way to produce the old code's state (the writer no longer exists).
const { backfillTimelineSamples } = await import("../src/timelineSamples");
const legacyKey = kb.knowledgeProfileKey({ state: "OR", ahj: "Legacy River", utility: UTILITY });
db.run(
  `INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, average_timeline_days, timeline_sample_count,
     timeline_notes_json, confidence, sources_json, notes, first_seen_at, last_learned_at, updated_at)
   VALUES ('kb-legacy', ?, 'OR', 'Legacy River', ?, 0.0, 4, ?, 'learned', '[]', '', ?, ?, ?)`,
  [legacyKey, UTILITY, JSON.stringify(["issued: Permit issued after 0.0 day(s)", "waiting: In review", "Reference timeline: 3 weeks"]), iso(0), iso(0), iso(0)],
);
const result = backfillTimelineSamples(db);
const legacy = kbRow(legacyKey);
const legacyNotes = JSON.parse(String(legacy?.timeline_notes_json || "[]")) as string[];
check("backfill recomputed the legacy row", result.profilesRecomputed.includes(legacyKey), JSON.stringify(result.profilesRecomputed));
check("a polling average with no samples behind it is cleared (null, n=0)", legacy?.average_timeline_days == null && legacy?.timeline_sample_count === 0,
  `${legacy?.average_timeline_days} n=${legacy?.timeline_sample_count}`);
check("per-poll notes dropped, the seeded 'Reference timeline' note kept", JSON.stringify(legacyNotes) === JSON.stringify(["Reference timeline: 3 weeks"]), JSON.stringify(legacyNotes));
const before = samples(p3).length;
backfillTimelineSamples(db);
check("the backfill is idempotent (replaying history adds no samples)", samples(p3).length === before, `${before} -> ${samples(p3).length}`);

// ── 6. THE FIRST TRANSITION, NOT THE LOOK THAT HAPPENED TO WRITE IT (skeptic PROBE B) ──────────
// The permit issued while the filing had no submitted_at yet (no sample possible). The operator
// records the filing date afterwards; the next routine re-poll of the same "issued" text then
// found no sample and wrote one ending AT THE RE-POLL — turnaround measured to whenever we
// happened to look again. end_at is the target's FIRST recorded reading of the milestone.
const p6 = makeProject("Timeline Six");
db.run(
  `INSERT INTO submissions (id, project_id, submission_type, permit_type, status, submitted_at, created_at)
   VALUES ('sub-p6', ?, 'permit', 'combo', 'awaiting_human_submit', NULL, ?)`,
  [p6, iso(20 * DAY)],
);
const t6 = R.createPermitCheckTarget(db, p6, { jurisdiction: AHJ, applicationNumber: "APP-6", permitType: "combo" })
  .permitCheckTargets.find((t) => t.targetType === "permit")!;
await R.recordPermitStatusCheck(db, p6, { targetId: t6.id, source: "manual", rawStatusText: "Plan review in progress." });
await R.recordPermitStatusCheck(db, p6, { targetId: t6.id, source: "manual", rawStatusText: "Permit issued. Download permit card." });
check("SETUP: issued with no submitted_at wrote no sample", samples(p6).length === 0, JSON.stringify(samples(p6)));
const firstIssuedAt6 = db.get<{ c: string }>("SELECT MIN(created_at) AS c FROM permit_status_checks WHERE target_id = ? AND outcome = 'issued'", [t6.id])!.c;
db.run("UPDATE submissions SET submitted_at = ?, status = 'submitted' WHERE id = 'sub-p6'", [iso(15 * DAY)]);
await new Promise((r) => setTimeout(r, 40));
await R.recordPermitStatusCheck(db, p6, { targetId: t6.id, source: "manual", rawStatusText: "Permit issued. Download permit card." });
const s6 = samples(p6).find((s) => s.milestone === "issued");
check("the late sample ends at the FIRST issued reading, not the re-poll", s6?.end_at === firstIssuedAt6, `${s6?.end_at} vs first issued ${firstIssuedAt6}`);

// ── 7. a target first seen ALREADY at the milestone never observed the transition ─────────────
// Tracking added after issuance: the first-ever reading says "issued". When it happened is
// unknown — the reading's time is only when we first looked — so it is not a turnaround sample.
const p7 = makeProject("Timeline Seven");
seedSubmission(p7, "permit", "combo", "submitted", iso(9 * DAY), iso(9 * DAY));
const t7 = R.createPermitCheckTarget(db, p7, { jurisdiction: AHJ, applicationNumber: "APP-7", permitType: "combo" })
  .permitCheckTargets.find((t) => t.targetType === "permit")!;
await R.recordPermitStatusCheck(db, p7, { targetId: t7.id, source: "manual", rawStatusText: "Permit issued. Download permit card." });
check("first-ever reading already issued → no issued sample", !samples(p7).some((s) => s.milestone === "issued"), JSON.stringify(samples(p7)));
backfillTimelineSamples(db);
check("…and the backfill does not write one either", !samples(p7).some((s) => s.milestone === "issued"), JSON.stringify(samples(p7)));
// An unreadable page before it observed nothing either — the production shape (Coos Bay, Coos
// County): a portal error page / "No status text available", then the first real read is "issued".
const p8 = makeProject("Timeline Eight");
seedSubmission(p8, "permit", "combo", "submitted", iso(9 * DAY), iso(9 * DAY));
const t8 = R.createPermitCheckTarget(db, p8, { jurisdiction: AHJ, applicationNumber: "APP-8", permitType: "combo" })
  .permitCheckTargets.find((t) => t.targetType === "permit")!;
await R.recordPermitStatusCheck(db, p8, { targetId: t8.id, source: "manual", rawStatusText: "No status text available. Manual AHJ/utility portal check required." });
check("SETUP: the first reading is unreadable (needs_human_review)",
  db.get<{ o: string }>("SELECT outcome AS o FROM permit_status_checks WHERE target_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1", [t8.id])?.o === "needs_human_review");
await R.recordPermitStatusCheck(db, p8, { targetId: t8.id, source: "manual", rawStatusText: "Permit issued. Download permit card." });
check("unreadable → issued is not an observed transition → no issued sample", !samples(p8).some((s) => s.milestone === "issued"), JSON.stringify(samples(p8)));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\ntimelineSamples: all checks passed");
