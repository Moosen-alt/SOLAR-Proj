// Segment A staging honesty. prepareSubmission RESOLVES (returns ProjectDetail) even when
// the adapter failed or paused mid-run — the outcome lives in the portal_runs row it wrote.
// segmentAOutcomeFromRun() is the pure mapping runAutopilotSegmentA applies after the call
// so a failed stage is reported blocked instead of "Segment A complete — staged to review"
// (the live Salem learn runs logged "complete" for stages that never left the address page).
// Also pins the NO-RELAUNCH invariant: maybeResumeAutopilot re-enqueues Segment A when a
// run ended blocked on a GATE (a clearing event fixes gates), but a stage_failed /
// paused_for_human outcome is a portal-run result, not a gate — auto-resuming it would
// drive an unattended live browser run (and, on a pause, a second browser while the
// paused one still sits at its MFA/CAPTCHA challenge).
// Browser-free. Run: tsx backend/test/autopilotStageOutcome.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-outcome-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

import { segmentAOutcomeFromRun, maybeResumeAutopilot } from "../src/autopilot";
import { openDatabase } from "../src/db";

let failures = 0;
const run = (label: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ok   - ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}`);
    console.error(`         ${err instanceof Error ? err.message : String(err)}`);
  }
};

run("a staged run (awaiting_human_submit) reports complete (null)", () => {
  assert.equal(segmentAOutcomeFromRun({ status: "awaiting_human_submit" }), null);
});

run("an operator-authorized submitted run reports complete (null)", () => {
  assert.equal(segmentAOutcomeFromRun({ status: "submitted" }), null);
});

run("a failed run blocks with the run's own error message", () => {
  const out = segmentAOutcomeFromRun({ status: "failed", error_message: "Nothing was staged — never reached review." });
  assert.ok(out);
  assert.equal(out!.code, "stage_failed");
  assert.match(out!.detail, /never reached review/i);
});

run("a failed run with no message still blocks with a pointer to the bundle", () => {
  const out = segmentAOutcomeFromRun({ status: "failed", error_message: "" });
  assert.ok(out);
  assert.equal(out!.code, "stage_failed");
  assert.match(out!.detail, /debug bundle/i);
});

run("a paused run blocks with the pause reason", () => {
  const out = segmentAOutcomeFromRun({ status: "paused_for_human", pause_reason: "mfa_captcha" });
  assert.ok(out);
  assert.equal(out!.code, "paused_for_human");
  assert.match(out!.detail, /mfa_captcha/);
});

run("no run row at all is not treated as a failure (legacy/mock paths)", () => {
  assert.equal(segmentAOutcomeFromRun(null), null);
  assert.equal(segmentAOutcomeFromRun(undefined), null);
});

// ── maybeResumeAutopilot: gates resume, portal-run outcomes never do ─────────────────
const db = await openDatabase();
const now = new Date().toISOString();
const seed = (pid: string, blockerCode: string) => {
  db.run("INSERT INTO projects (id, status, parser_json, created_at, updated_at) VALUES (?, 'ready_to_stage', '{}', ?, ?)", [pid, now, now]);
  db.run(
    `INSERT INTO job_queue (id, job_type, payload, status, priority, project_id, created_at, progress, progress_total, retry_count, max_retries, org_id, result)
     VALUES (?, 'autopilot', '{}', 'done', 5, ?, ?, 0, 0, 0, 0, 'default', ?)`,
    [`job-${pid}`, pid, now, JSON.stringify({ blocked: true, blockers: [{ code: blockerCode, detail: "x" }] })],
  );
};
const autopilotJobs = (pid: string): number =>
  Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_queue WHERE project_id = ? AND job_type = 'autopilot'", [pid])?.n ?? 0);
// The enqueue happens behind a dynamic import — give the microtask/macrotask chain time.
const flush = () => new Promise((r) => setTimeout(r, 250));

seed("p-gate", "missing_document");
maybeResumeAutopilot(db, "p-gate");
await flush();
run("a gate-blocked run IS auto-resumed by a clearing event", () => {
  assert.equal(autopilotJobs("p-gate"), 2, "a fresh autopilot job was enqueued");
});

seed("p-fail", "stage_failed");
maybeResumeAutopilot(db, "p-fail");
seed("p-pause", "paused_for_human");
maybeResumeAutopilot(db, "p-pause");
await flush();
run("a stage_failed run is NEVER auto-resumed (no unattended live relaunch)", () => {
  assert.equal(autopilotJobs("p-fail"), 1, "no new job for a failed portal stage");
});
run("a paused_for_human run is NEVER auto-resumed (no second browser at the challenge)", () => {
  assert.equal(autopilotJobs("p-pause"), 1, "no new job for a paused portal stage");
});

// Best-effort teardown: the instant-kicked worker may still hold the handle briefly.
try { db.close(); } catch { /* worker mid-claim - exit below ends it */ }
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* leave to OS */ }

if (failures) {
  console.error(`\n${failures} autopilot stage-outcome test(s) failed.`);
  process.exit(1);
}
console.log("\nAll autopilot stage-outcome tests passed.");
// Hard exit: the resumed p-gate job may have instant-kicked the in-process worker;
// don't let its background run (on the scratch DB) keep the test process alive.
process.exit(0);
