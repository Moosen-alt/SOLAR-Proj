// A FILING NOBODY POLLS IS A FILING NOBODY IS TRACKING.
//
// captureConfirmation — the door a human uses to say "I clicked the portal's submit and
// here is the number" — created NO permit_check_targets row. So the monitor never looked
// at that filing again, and the operator closed the hole by hand every single time.
// The live audit trail is the proof, three for three on project 1fb3dc39:
//
//   16:42:00  submission.confirmation_captured  187-26-000309-STR
//   16:43:05  permit_target.created             (operator, by hand, 65s later)
//   19:10:07  submission.confirmation_captured  194-26-001482-ELEC
//   19:10:16  permit_target.created             (9s later)
//   23:02:11  submission.confirmation_captured  APP-111667
//   23:03:47  permit_target.created             (96s later)
//
// Three filings, three manual re-entries of a number the confirmation form had already
// collected. Every one of those re-entries is a chance to mistype the number the poller
// searches by, or to forget entirely.
//
// AND RE-CONFIRMING MUST NOT APPEND. The same live database records portal run b364128a
// (project ec5c36d3) captured TWICE, five minutes apart — 00:43:50 and 00:48:30.
// That is not hypothetical: a second target for one filing polls the same application
// twice, and the two rows can then disagree about its status.
//
// WHAT THIS FILE PINS
//   1. confirm            → ONE active target, DUE on the next sweep (the poller's own
//                           due predicate, not just "a row exists").
//   2. confirm twice      → still ONE target. Re-running an action supersedes, never appends.
//   3. two real tracks    → TWO targets (must-exclude: the dedupe must not collapse a
//                           project's building permit and its NEM application into one).
//   4. no number at all   → NO target invented, AND the project says so where an operator
//                           looks (stage_detail chip + a named audit action). An unknown
//                           must never read as reassurance.
//   5. boot               → a sweep runs without waiting a full MONITOR_INTERVAL_MINUTES,
//                           and is still disabled by BOTH existing env gates.
//   6. THE LIVE SHAPE     → a SYNTHETIC project shaped like the operator's real rows (three
//                           hand-added targets) replayed through ensureCheckTarget: 3 stay 3.
//                           The replay against a copy of the real database is a separate
//                           probe (scripts/trackingTruth.live-probe.ts) — a unit test must
//                           never depend on production rows.
//
// Browser-free and offline: the monitor fixture has no portal URL, no recipe and no portal
// profile, so runDuePermitChecks takes its own "gathered nothing" branch and the only thing
// that moves is last_checked_at.
//
//   npx tsx backend/test/trackingTruth.test.ts
import "./_isolate"; // FIRST: temp cwd; this file then points AUTOPILOT_DB_PATH at its own temp DB
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracking-truth-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.PORTAL_PROFILES_DIR = path.join(tmpDir, "portal-profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.ANTHROPIC_API_KEY = "";
// Left at its default (enabled) on purpose: the monitor's "a check that read nothing is not
// a status" branch is reached only when auto-seed is NOT disabled, and that branch is the
// offline observable this file's boot-sweep checks read.
delete process.env.PORTAL_AUTOSEED;

const { openDatabase } = await import("../src/db");
const { createProject, captureConfirmation, createPermitCheckTarget, getProjectDetail } = await import("../src/repository");
const { ensureCheckTarget, markTrackSubmitted } = await import("../src/submittalTracks");
const { startMonitorScheduler } = await import("../src/scheduler");

const db = await openDatabase();

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

interface Row { [k: string]: unknown }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let n = 0;
const mk = (owner: string) => createProject(db, {
  owner, address: `${++n} Tracking Way`, city: "Coos Bay", state: "OR", zip: "97420",
  ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "7.4",
}).project;

/** A staged filing exactly as the portal path leaves it: a run plus a submissions row
 *  awaiting the human's own final click. Raw SQL is fixture SETUP; captureConfirmation —
 *  the function the route handler calls — is what is under test. */
const stage = (projectId: string, permitType: string, runId: string): string => {
  const ts = new Date().toISOString();
  db.run(
    "INSERT INTO portal_runs (id, project_id, run_type, status, started_at, permit_type) VALUES (?, ?, 'prepare_submit', 'awaiting_human_submit', ?, ?)",
    [runId, projectId, ts, permitType],
  );
  db.run(
    "INSERT INTO submissions (id, project_id, submission_type, permit_type, status, created_at) VALUES (?, ?, ?, ?, 'awaiting_human_submit', ?)",
    [`sub-${runId}`, projectId, permitType === "nem" ? "interconnection" : "permit", permitType, ts],
  );
  return runId;
};

const targetsOf = (projectId: string): Row[] =>
  db.query<Row>("SELECT * FROM permit_check_targets WHERE project_id = ? ORDER BY created_at ASC", [projectId]);

/** The poller's OWN due predicate (runDuePermitChecks), not a hand-read of a column: a row
 *  that exists but is not due is a filing nobody is checking this week either. */
const dueTargetsOf = (projectId: string): Row[] => db.query<Row>(
  `SELECT * FROM permit_check_targets
    WHERE project_id = ? AND active = 1 AND (next_check_at IS NULL OR next_check_at <= ?)`,
  [projectId, new Date().toISOString()],
);

const stageDetailOf = (projectId: string): string =>
  String(db.get<Row>("SELECT stage_detail FROM projects WHERE id = ?", [projectId])?.stage_detail ?? "");

const auditActions = (projectId: string): string[] =>
  db.query<Row>("SELECT action FROM audit_logs WHERE project_id = ? ORDER BY created_at ASC", [projectId])
    .map((r) => String(r.action));

console.log("trackingTruth: the confirmation seam, the dedupe, the leading tick, and the live rows.\n");

// ---------------------------------------------------------------------------
// 1. THE HEADLINE — a confirmed filing is scheduled for checking.
// ---------------------------------------------------------------------------
await check("A CONFIRMED FILING IS SCHEDULED FOR CHECKING — one active, DUE target", () => {
  const p = mk("Three-filing Owner");
  assert.equal(targetsOf(p.id).length, 0, "fixture premise: a staged project has no tracking target yet");
  captureConfirmation(db, stage(p.id, "building", `run-bld-${p.id}`), {
    applicationNumber: "187-26-000309-STR", permitNumber: "187-26-000309-STR", submittedBy: "operator",
  });

  const targets = targetsOf(p.id);
  assert.equal(targets.length, 1,
    `the human confirmed a filing and ${targets.length} tracking target(s) exist — the monitor will never look at this filing again`);
  const t = targets[0];
  assert.equal(Number(t.active), 1, "the target must be active or the poller skips it");
  assert.equal(String(t.application_number), "187-26-000309-STR", "the poller searches by this number");
  assert.equal(String(t.target_type), "permit");
  assert.equal(String(t.permit_type), "building", "discipline must come from the run's own permit_type");
  assert.equal(dueTargetsOf(p.id).length, 1,
    "the target exists but is not DUE — the filing that just went in waits out a whole check window before its first read");
  assert.ok(auditActions(p.id).includes("permit_target.created"),
    "the target's creation must be on the audit trail the operator can read");
});

// ---------------------------------------------------------------------------
// 2. THE LIVE DOUBLE-CAPTURE — b364128a, confirmed twice, five minutes apart.
// ---------------------------------------------------------------------------
await check("CONFIRM TWICE → STILL ONE TARGET (the live b364128a double-capture)", () => {
  const p = mk("Double-capture Owner");
  const runId = stage(p.id, "nem", `run-nem-${p.id}`);
  captureConfirmation(db, runId, { applicationNumber: "APP-111681", confirmationNumber: "APP-111681", submittedBy: "operator" });
  assert.equal(targetsOf(p.id).length, 1, "premise: the first capture created exactly one target");

  // The identical second capture the live database records, 5 minutes later.
  captureConfirmation(db, runId, { applicationNumber: "APP-111681", confirmationNumber: "APP-111681", submittedBy: "operator" });
  const targets = targetsOf(p.id);
  assert.equal(targets.length, 1,
    `re-confirming the same run left ${targets.length} targets — two rows polling one application can report two different statuses for it`);
  assert.equal(String(targets[0].application_number), "APP-111681");
  assert.equal(String(targets[0].target_type), "nem", "a NEM confirmation must not be tracked as a permit");
});

await check("…and a RE-STAGED track confirmed again supersedes rather than appends", () => {
  // 720b05f3's live history: one track staged four times, each staging appending another
  // awaiting_human_submit row. Whichever run the operator confirms, there is ONE filing.
  const p = mk("Restaged Owner");
  captureConfirmation(db, stage(p.id, "electrical", `run-ele-a-${p.id}`), { applicationNumber: "194-26-001471-ELEC" });
  captureConfirmation(db, stage(p.id, "electrical", `run-ele-b-${p.id}`), { applicationNumber: "194-26-001471-ELEC" });
  assert.equal(targetsOf(p.id).length, 1, "two staged runs for ONE electrical filing must not produce two targets");
});

// ---------------------------------------------------------------------------
// 3. MUST-EXCLUDE — the dedupe must not collapse distinct filings.
// ---------------------------------------------------------------------------
await check("MUST-EXCLUDE: two real tracks stay TWO targets (the 1fb3dc39 / 720b05f3 shape)", () => {
  const p = mk("Two-track Owner");
  captureConfirmation(db, stage(p.id, "building", `run-2b-${p.id}`), { applicationNumber: "187-26-000305-STR", permitNumber: "187-26-000305-STR" });
  captureConfirmation(db, stage(p.id, "nem", `run-2n-${p.id}`), { applicationNumber: "APP-111651" });
  const targets = targetsOf(p.id);
  assert.equal(targets.length, 2,
    `a permit filing and a utility interconnection collapsed into ${targets.length} target(s) — one of the two filings is now unpolled`);
  assert.deepEqual(
    targets.map((t) => String(t.target_type)).sort(),
    ["nem", "permit"],
    "the two targets must be the permit and the NEM application, not two of the same",
  );
});

await check("MUST-EXCLUDE: a separate building and electrical permit stay two targets", () => {
  // Coos Bay files these apart — 1fb3dc39 carries 187-26-000309-STR and 194-26-001482-ELEC live.
  const p = mk("Split-permit Owner");
  captureConfirmation(db, stage(p.id, "building", `run-sb-${p.id}`), { applicationNumber: "187-26-000309-STR" });
  captureConfirmation(db, stage(p.id, "electrical", `run-se-${p.id}`), { applicationNumber: "194-26-001482-ELEC" });
  assert.equal(targetsOf(p.id).length, 2,
    "two permit disciplines share target_type 'permit'; deduping on that alone would lose one of them");
});

// ---------------------------------------------------------------------------
// 4. THE UNKNOWN — a confirmation with no number invents nothing, and says so.
// ---------------------------------------------------------------------------
await check("NO APPLICATION NUMBER → NO TARGET IS INVENTED", () => {
  const p = mk("Numberless Owner");
  captureConfirmation(db, stage(p.id, "combo", `run-none-${p.id}`), { submittedBy: "operator", confirmationNumber: "RECEIPT-42" });
  assert.equal(targetsOf(p.id).length, 0,
    "a target with no number is polled forever, reads nothing, and its honest 'no status available' classifies as needs_human_review");
  assert.equal(
    db.get<Row>("SELECT status FROM projects WHERE id = ?", [p.id])?.status, "submitted",
    "the confirmation itself must still land — refusing to invent a target is not refusing the capture",
  );
});

await check("…AND THE UNTRACKED STATE IS VISIBLE — chip and audit action, not silence", () => {
  const p = mk("Numberless Visible Owner");
  captureConfirmation(db, stage(p.id, "combo", `run-vis-${p.id}`), { submittedBy: "operator" });
  assert.equal(stageDetailOf(p.id), "submitted_untracked",
    `the sub-stage chip says "${stageDetailOf(p.id)}" — an operator reading it has no way to learn nobody is watching this filing`);
  assert.notEqual(stageDetailOf(p.id), "submitted_all",
    "MUST-EXCLUDE: an untracked filing must not read as 'every track is in' — that is reassurance the record does not support");
  assert.ok(auditActions(p.id).includes("submission.confirmed_untracked"),
    "the audit panel renders the action NAME and nothing else; without a named action the fact disappears the moment the chip is overwritten");
  assert.ok(!auditActions(p.id).includes("permit_target.created"),
    "MUST-EXCLUDE: nothing may claim a target was created when none was");
  assert.match(
    String(db.get<Row>("SELECT current_stage FROM projects WHERE id = ?", [p.id])?.current_stage),
    /NOT being tracked/,
    "the recorded stage line must name the gap too",
  );
});

await check("A PERMIT NUMBER ALONE IS ENOUGH — the poller searches by both columns", () => {
  const p = mk("Permit-number-only Owner");
  captureConfirmation(db, stage(p.id, "combo", `run-pn-${p.id}`), { permitNumber: "BLD-2026-0042" });
  const targets = targetsOf(p.id);
  assert.equal(targets.length, 1, "a confirmation carrying only a permit number is still trackable");
  assert.equal(String(targets[0].permit_number), "BLD-2026-0042");
  assert.equal(stageDetailOf(p.id), "submitted_all", "…and it must NOT be flagged untracked");
});

// ---------------------------------------------------------------------------
// 5. THE OTHER TWO DOORS — reconciled, not a third pattern.
// ---------------------------------------------------------------------------
await check("THE OPERATOR'S HAND-ADD IS THE SAME ROW — live order: confirm, then add by hand", () => {
  // Exactly what the operator did three times on 1fb3dc39: captured the confirmation, then went
  // to Permit/NEM Checks and typed the number in again 65 seconds later.
  const p = mk("Hand-add-after Owner");
  captureConfirmation(db, stage(p.id, "building", `run-ha-${p.id}`), { applicationNumber: "187-26-000309-STR" });
  createPermitCheckTarget(db, p.id, {
    jurisdiction: "City of Coos Bay", portalName: "Oregon ePermitting (Accela)",
    applicationNumber: "187-26-000309-STR", targetType: "permit", permitType: "building",
  });
  assert.equal(targetsOf(p.id).length, 1,
    "the operator's habitual hand-add now duplicates the target the confirmation already made");
  assert.ok(auditActions(p.id).includes("permit_target.updated"),
    "auditing 'created' for an update is a lie — the two actions must be distinguishable");
});

await check("…and the reverse order too: hand-added first, confirmed second", () => {
  const p = mk("Hand-add-before Owner");
  createPermitCheckTarget(db, p.id, {
    jurisdiction: "City of Coos Bay", applicationNumber: "187-26-000777-STR", targetType: "permit", permitType: "building",
  });
  captureConfirmation(db, stage(p.id, "building", `run-hb-${p.id}`), { applicationNumber: "187-26-000777-STR" });
  assert.equal(targetsOf(p.id).length, 1, "the confirmation must adopt the target the operator already added");
});

await check("markTrackSubmitted keeps its own dedupe — one live filing per track", () => {
  // The extraction must not change this door's answer: re-marking a track with a CORRECTED
  // number updates the row rather than leaving a sibling polling the dead application.
  const p = mk("Mark-submitted Owner");
  markTrackSubmitted(db, getProjectDetail(db, p.id).project, "electrical", { applicationNumber: "194-26-000001-ELEC" });
  assert.equal(targetsOf(p.id).length, 1, "premise: marking a track submitted creates its target");
  markTrackSubmitted(db, getProjectDetail(db, p.id).project, "electrical", { applicationNumber: "194-26-000002-ELEC" });
  const targets = targetsOf(p.id);
  assert.equal(targets.length, 1, "a corrected number for the SAME track must update, not append");
  assert.equal(String(targets[0].application_number), "194-26-000002-ELEC", "…and the corrected number must be the one polled");
});

// ---------------------------------------------------------------------------
// 6. THE MONITOR'S LEADING TICK.
// ---------------------------------------------------------------------------
// Every pre-existing target is retired first so the sweep below is deterministic and has
// nothing with a URL to fetch. A sweep that wandered into another check's fixture would
// make this section's result depend on the order the file happens to run in.
db.run("UPDATE permit_check_targets SET active = 0");

/** A due target with NO portal URL, NO recipe and NO portal profile — runDuePermitChecks
 *  gathers nothing, takes its skip-and-reschedule branch, and the only visible move is
 *  last_checked_at. Entirely offline. */
const dueTarget = (owner: string): { projectId: string; targetId: string } => {
  const p = mk(owner);
  const targetId = `tgt-${p.id}`;
  const past = new Date(Date.now() - 86_400_000).toISOString();
  db.run(
    `INSERT INTO permit_check_targets
       (id, project_id, jurisdiction, portal_name, portal_url, application_number, permit_number,
        check_frequency_days, active, last_checked_at, next_check_at, latest_outcome, latest_status_label,
        notes, target_type, permit_type, portal_platform, tracking_url, created_at, updated_at)
     VALUES (?, ?, 'City of Coos Bay', 'Oregon ePermitting (Accela)', '', '', '', 7, 1, NULL, ?, NULL, '', '', 'permit', 'building', 'unknown', '', ?, ?)`,
    [targetId, p.id, past, past, past],
  );
  return { projectId: p.id, targetId };
};
const lastCheckedAt = (targetId: string): string | null => {
  const v = db.get<Row>("SELECT last_checked_at FROM permit_check_targets WHERE id = ?", [targetId])?.last_checked_at;
  return v == null ? null : String(v);
};

await check("BOOT → A SWEEP RUNS without waiting a full MONITOR_INTERVAL_MINUTES", async () => {
  const { targetId } = dueTarget("Boot Sweep Owner");
  assert.equal(lastCheckedAt(targetId), null, "fixture premise: this filing has never been checked");
  process.env.MONITOR_INTERVAL_MINUTES = "15";
  process.env.MONITOR_BOOT_DELAY_MS = "25";
  delete process.env.BACKGROUND_WORKERS;
  startMonitorScheduler(db);
  await sleep(600);
  assert.ok(lastCheckedAt(targetId),
    "nothing was checked after boot — with setInterval alone the first sweep is 15 minutes away, and a process that restarts more often than that never sweeps at all");
});

await check("GATE 1 — MONITOR_INTERVAL_MINUTES <= 0 still disables it, boot sweep included", async () => {
  const { targetId } = dueTarget("Interval-off Owner");
  process.env.MONITOR_INTERVAL_MINUTES = "0";
  process.env.MONITOR_BOOT_DELAY_MS = "25";
  delete process.env.BACKGROUND_WORKERS;
  startMonitorScheduler(db);
  await sleep(600);
  assert.equal(lastCheckedAt(targetId), null,
    "MONITOR_INTERVAL_MINUTES=0 means the monitor is OFF — a leading tick that fires anyway is a sweep the operator switched off");
});

await check("GATE 2 — BACKGROUND_WORKERS=off still disables it, boot sweep included", async () => {
  const { targetId } = dueTarget("Workers-off Owner");
  process.env.MONITOR_INTERVAL_MINUTES = "15";
  process.env.MONITOR_BOOT_DELAY_MS = "25";
  process.env.BACKGROUND_WORKERS = "off";
  startMonitorScheduler(db);
  await sleep(600);
  assert.equal(lastCheckedAt(targetId), null,
    "BACKGROUND_WORKERS=off must mean no background work at all, including the sweep that now runs at boot");
  delete process.env.BACKGROUND_WORKERS;
});

// ---------------------------------------------------------------------------
// 7. THE LIVE SHAPE — a synthetic project shaped like the operator's real rows.
//
// Every fixture above builds a project parked neatly where the code expects it. The rows that
// matter were built by the operator's hand over several days (1fb3dc39 and 720b05f3 carry three
// each): Accela numbers duplicated across application_number AND permit_number, a PowerClerk
// number in application_number alone, and a target added with no permit_type at all. Replaying
// ensureCheckTarget over rows of that shape must create ZERO rows and match each filing to its
// OWN row.
//
// This used to open a copy of backend/data/autopilot.sqlite and assert on real rows, so the unit
// chain went red whenever the operator's data moved (a fourth target on 1fb3dc39 failed it) and
// passed or skipped depending on the machine. The replay against real rows now lives in
// scripts/trackingTruth.live-probe.ts, run on demand against a read-only backup.
// ---------------------------------------------------------------------------
await check("THE LIVE SHAPE — three hand-added targets (Accela both columns, PowerClerk app-only, no permit_type) stay 3 on replay", () => {
  const p = mk("Live-shape Owner");
  // Written through the operator's own door, the way the real rows were.
  createPermitCheckTarget(db, p.id, {
    jurisdiction: "City of Coos Bay", portalName: "Oregon ePermitting (Accela)", targetType: "permit", permitType: "building",
    applicationNumber: "187-26-000901-STR", permitNumber: "187-26-000901-STR",
  });
  createPermitCheckTarget(db, p.id, {
    jurisdiction: "City of Coos Bay", portalName: "Oregon ePermitting (Accela)", targetType: "permit",
    applicationNumber: "194-26-000902-ELEC", permitNumber: "194-26-000902-ELEC",
  });
  createPermitCheckTarget(db, p.id, {
    jurisdiction: "Pacific Power", portalName: "PowerClerk", targetType: "nem",
    portalUrl: "https://pacificorpnetmetering.powerclerk.com/MvcProjects/ProjectDetails", applicationNumber: "APP-100903",
  });
  const before = targetsOf(p.id);
  assert.equal(before.length, 3, "fixture premise: three targets");
  assert.ok(before.some((t) => String(t.permit_type) === ""), "fixture premise: one row carries no permit_type, as a hand-added row can");
  const record = getProjectDetail(db, p.id).project;
  for (const t of before) {
    const result = ensureCheckTarget(db, record, {
      targetType: String(t.target_type) === "nem" ? "nem" : "permit",
      permitType: String(t.permit_type ?? ""),
      applicationNumber: String(t.application_number ?? ""),
      permitNumber: String(t.permit_number ?? ""),
    });
    assert.equal(result.created, false,
      `replaying filing ${String(t.application_number)} CREATED a new target — a re-confirmation would duplicate it`);
    assert.equal(result.targetId, String(t.id),
      `filing ${String(t.application_number)} matched target ${result.targetId}, not its own row ${String(t.id)} — the wrong filing would be updated`);
  }
  assert.equal(targetsOf(p.id).length, 3, "duplicate target(s) were created by the replay");
});

try { db.close(); } catch { /* best effort */ }
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\ntrackingTruth: all checks passed."
  : `\ntrackingTruth: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
