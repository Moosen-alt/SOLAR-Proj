// BACKUPS DESTROYED BACKUPS.
//
// This test exists because of a real loss, on this machine, on 2026-09-20. An agent starting a
// throwaway test server set `BACKUP_INTERVAL_HOURS=0` meaning "off". `Number("0" || 24)` is 0 —
// "0" is a truthy STRING, so the `||` default never fires — and `setInterval(tick, 0)` then wrote
// a snapshot roughly every two seconds. `BACKUP_KEEP=14`, so within a minute the fourteen junk
// snapshots it had just written had rotated every real restore point off the operator's backup
// drive. Four survived only because copies happened to exist somewhere else.
//
// Two separate failures, so two separate sections:
//   1. a non-positive interval must DISABLE the schedule (every other scheduler in this codebase
//      already reads <= 0 as "off"), while still taking the one startup snapshot;
//   2. rotation must only ever retire the AUTOMATIC series — a restore point a human named ahead
//      of something risky must survive any number of routine snapshots.
//
// Both are load-bearing on their own: with only #1, a runaway loop elsewhere still eats the pins;
// with only #2, an interval of 0 still churns the disk and rolls the automatic series in seconds.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "backup-rotation-"));
const backupDir = path.join(root, "backups");
const KEEP = 6;

process.env.AUTOPILOT_DB_PATH = path.join(root, "t.sqlite");
process.env.BACKUP_DIR = backupDir;
process.env.BACKUP_KEEP = String(KEEP);
// The exact value that caused the loss.
process.env.BACKUP_INTERVAL_HOURS = "0";
// Point the document + portal-session mirrors at empty temp trees. Left unset they resolve
// against the REAL backend/data tree and this test would copy the operator's live documents.
process.env.PROJECT_DOCS_DIR = path.join(root, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(root, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { runBackup, listBackups, startBackupScheduler, backupIntervalMs, isAutomaticSnapshot } =
  await import("../src/backup");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

const db = await openDatabase();
const snapshotsOnDisk = (): string[] =>
  fs.readdirSync(backupDir).filter((f) => f.startsWith("autopilot-") && f.endsWith(".sqlite"));

// ---------------------------------------------------------------------------
// 1. THE INTERVAL. "0" means off, not "continuously".
// ---------------------------------------------------------------------------
console.log("\n1. A NON-POSITIVE INTERVAL DISABLES THE SCHEDULE");
{
  check("1a. 0 hours is not an interval, it is OFF", backupIntervalMs(0) === null,
    `got ${String(backupIntervalMs(0))}`);
  check("1b. a negative interval is OFF too", backupIntervalMs(-1) === null,
    `got ${String(backupIntervalMs(-1))}`);
  check("1c. an unparseable BACKUP_INTERVAL_HOURS is OFF, not NaN milliseconds",
    backupIntervalMs(Number("nightly")) === null, `got ${String(backupIntervalMs(Number("nightly")))}`);
  // MUST PASS: turning the fix into "always off" would pass every check above.
  check("1d. MUST PASS: a real interval still schedules, in milliseconds",
    backupIntervalMs(24) === 86_400_000, `got ${String(backupIntervalMs(24))}`);
  check("1e. MUST PASS: a sub-hour interval is honoured, not rounded away",
    backupIntervalMs(0.25) === 900_000, `got ${String(backupIntervalMs(0.25))}`);

  // End to end, with the env var that caused the loss already set at the top of this file.
  startBackupScheduler(db);
  // Hold the event loop open long enough that a 0ms interval would fire hundreds of times. The
  // scheduler's own timer is .unref()'d, so only this await keeps the process alive — which is
  // precisely the window in which the real damage happened (a server process stays up for hours).
  await new Promise((resolve) => setTimeout(resolve, 400));
  const written = snapshotsOnDisk();
  check("1f. THE LOSS: 400ms at BACKUP_INTERVAL_HOURS=0 writes ONE snapshot, not a stream of them",
    written.length === 1, `wrote ${written.length} snapshots`);
  check("1g. and the one startup snapshot still ran — disabling backups keeps the state you disabled at",
    written.length >= 1, "no snapshot at all");
}

// ---------------------------------------------------------------------------
// 2. ROTATION. A pinned restore point is not rotation fodder.
// ---------------------------------------------------------------------------
console.log("\n2. ROTATION RETIRES THE AUTOMATIC SERIES ONLY");
{
  check("2a. an automatic snapshot is the one named with a stamp",
    isAutomaticSnapshot("autopilot-2026-09-20T15-34-23-000Z.sqlite"), "stamped name not recognised");
  for (const pinned of [
    "autopilot-manual-20260920T153423-preD.sqlite",
    "autopilot-pre-connie.sqlite",
    "autopilot-BEFORE-round2.sqlite",
  ]) {
    check(`2b. "${pinned}" is a pin, not part of the series`, !isAutomaticSnapshot(pinned));
  }

  // A backup drive as it actually looks: the rotating series, plus restore points someone
  // pinned before a risky change. KEEP is 6 and there are already more than 6 automatic ones.
  const pins = [
    "autopilot-manual-20260920T153423-preD.sqlite",
    "autopilot-pre-connie.sqlite",
    "autopilot-BEFORE-round2.sqlite",
  ];
  for (const pin of pins) fs.writeFileSync(path.join(backupDir, pin), "pinned restore point");
  for (let i = 0; i < KEEP + 3; i += 1) {
    const stamp = `2026-09-0${i % 9}T0${i % 9}-00-00-000Z`;
    fs.writeFileSync(path.join(backupDir, `autopilot-${stamp}.sqlite`), `auto ${i}`);
  }

  runBackup(db); // writes one more automatic snapshot, then prunes

  const after = snapshotsOnDisk();
  const survivingPins = pins.filter((p) => after.includes(p));
  check("2c. THE LOSS: every pinned restore point survives a rotation that overflowed KEEP",
    survivingPins.length === pins.length,
    `${survivingPins.length}/${pins.length} survived: kept ${survivingPins.join(", ") || "none"}`);

  const automatic = after.filter(isAutomaticSnapshot);
  check("2d. MUST PASS: the automatic series is still capped at KEEP — pins are not a leak in rotation",
    automatic.length === KEEP, `${automatic.length} automatic snapshots, KEEP=${KEEP}`);

  check("2e. and a pin is still LISTED, so an operator can actually restore from it",
    pins.every((p) => listBackups().some((b) => b.file === p)),
    `listBackups: ${listBackups().map((b) => b.file).join(", ")}`);
}

console.log(failures ? `\nbackupRotation: ${failures} check(s) FAILED` : "\nbackupRotation: all checks passed");
db.close();
fs.rmSync(root, { recursive: true, force: true });
if (failures) process.exit(1);
