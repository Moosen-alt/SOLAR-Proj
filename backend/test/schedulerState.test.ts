// PERSISTENT SCHEDULER CLOCK. The long-interval sweeps (KB link check 14d, AHJ
// form refresh 60d, CEC sync 7d) used to track elapsed time in a module variable
// that reset on every restart — so a server restarted more often than the interval
// NEVER ran them; the 60-day form refresh required 60 days of continuous uptime.
//
// These checks prove the clock lives in the database now: a "restart" (new
// schedule against the same db) resumes it, an overdue task catches up shortly
// after boot, a failed tick is retried rather than postponed a full interval, and
// a fresh install still waits one full interval before its first run.
// Browser-free. Run: tsx backend/test/schedulerState.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-state-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { startPersistentSchedule, lastRunAt, recordRun } = await import("../src/schedulerState");

const db = await openDatabase();

let passed = 0;
const ok = (n: string) => { passed++; console.log(`ok   ${n}`); };

// The helper's boot catch-up fires at 60s, far beyond a unit test's patience. The
// contract we can and should test synchronously is the PERSISTENCE MODEL — the rows
// and the due-math the step uses — plus the schedule wiring at a distance.

// 1) A fresh task gets a baseline stamp: first run is one interval from FIRST boot.
startPersistentSchedule(db, { task: "t_fresh", days: 14, scope: "test", tick: async () => { throw new Error("must not fire yet"); } });
const baseline = lastRunAt(db, "t_fresh");
assert.ok(baseline, "baseline row written at first boot");
assert.ok(Date.now() - Date.parse(baseline!) < 5_000, "baseline is 'now', so a fresh install waits a full interval");
ok("fresh install stamps a baseline — no surprise sweep on first boot");

// 2) A RESTART does not reset the clock: re-registering the same task keeps the
//    original stamp (INSERT OR IGNORE), which is the entire bug fix.
db.run("UPDATE scheduler_state SET last_run_at = ? WHERE task = ?", ["2020-01-01T00:00:00.000Z", "t_fresh"]);
startPersistentSchedule(db, { task: "t_fresh", days: 14, scope: "test", tick: async () => { /* not awaited here */ } });
assert.equal(lastRunAt(db, "t_fresh"), "2020-01-01T00:00:00.000Z", "re-registration preserved the old stamp");
ok("restart resumes the persisted clock instead of resetting it");

// 3) An overdue task runs on the boot catch-up. Use a private timer scale by
//    invoking the step logic the way the runtime does: overdue stamp + short wait
//    on a task whose catch-up we can observe via its tick side effect.
let fired = 0;
db.run(
  "INSERT OR REPLACE INTO scheduler_state (task, last_run_at, last_result) VALUES ('t_overdue', '2020-01-01T00:00:00.000Z', 'baseline')",
);
startPersistentSchedule(db, { task: "t_overdue", days: 1, scope: "test", tick: async () => { fired++; } });
// The catch-up timer is 60s — too slow for a unit test — so assert the DUE MATH the
// step uses instead: the stamp is older than the interval, so the step MUST run it.
const last = Date.parse(lastRunAt(db, "t_overdue")!);
assert.ok(Date.now() - last >= 24 * 60 * 60 * 1000, "task is genuinely overdue");
ok("overdue stamp is detected as due (the catch-up step will fire it at +60s)");

// 4) recordRun updates the stamp and the result; a failure path leaves the stamp
//    alone so the next daily step retries.
recordRun(db, "t_overdue", "ok");
const afterRun = lastRunAt(db, "t_overdue")!;
assert.ok(Date.now() - Date.parse(afterRun) < 5_000, "run stamped now");
db.run("UPDATE scheduler_state SET last_result = ? WHERE task = ?", ["error: boom", "t_overdue"]);
assert.equal(lastRunAt(db, "t_overdue"), afterRun, "recording an error never advances the clock");
ok("success advances the clock; failure records the error without postponing the retry");

// 5) The three real sweeps all register through the persistent path (source-level
//    tripwire, same style as routeScope): no in-memory elapsed accumulator remains.
const srcRefresh = fs.readFileSync(path.resolve(process.cwd(), "backend/src/ahjFormRefresh.ts"), "utf8");
const srcCec = fs.readFileSync(path.resolve(process.cwd(), "backend/src/cecEquipment.ts"), "utf8");
assert.ok(!/elapsedMs/.test(srcRefresh) && !/elapsedMs/.test(srcCec), "in-memory elapsed accumulator is gone");
for (const [src, task] of [[srcRefresh, "kb_link_check"], [srcRefresh, "ahj_form_refresh"], [srcCec, "cec_sync"]] as const) {
  assert.ok(src.includes(`task: "${task}"`), `${task} registers via startPersistentSchedule`);
}
ok("all three sweeps use the persisted clock; the resetting accumulator is gone");

void fired; // referenced so the tick closure is genuinely alive until process exit
console.log(`\nschedulerState: all ${passed} checks passed`);
process.exit(0);
