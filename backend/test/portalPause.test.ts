// Per-portal kill-switch: pausing a jurisdiction (or platform) makes isPortalPaused true,
// resuming clears it, and the pause key lines up with the recipe routing key. Exercises
// the v2 migration (portal_pauses table) on a fresh temp DB.
// Run: tsx backend/test/portalPause.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const dbPath = path.resolve(process.cwd(), "backend/data/portal-pause-test.sqlite");
fs.rmSync(dbPath, { force: true });
fs.rmSync(`${dbPath}-wal`, { force: true });
fs.rmSync(`${dbPath}-shm`, { force: true });
process.env.AUTOPILOT_DB_PATH = dbPath;
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { isPortalPaused, pausePortal, resumePortal, listPortalPauses } = await import("../src/portalPause");

let failures = 0;
const run = (label: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ok   - ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`);
  }
};

const db = await openDatabase();
const ahjId = { scopeType: "ahj" as const, state: "OR", ahj: "City of Bend", utility: "Pacific Power" };
const utilId = { scopeType: "utility" as const, state: "OR", utility: "Portland General Electric" };

run("portal starts un-paused", () => {
  assert.equal(isPortalPaused(db, ahjId), false);
});

run("profile pause makes that jurisdiction paused (and only it)", () => {
  pausePortal(db, { kind: "profile", identity: ahjId, reason: "C&D received", pausedBy: "op" });
  assert.equal(isPortalPaused(db, ahjId), true);
  assert.equal(isPortalPaused(db, utilId), false, "an unrelated portal stays live");
});

run("platform pause halts every jurisdiction on that platform", () => {
  pausePortal(db, { kind: "platform", platform: "powerclerk", reason: "platform-wide notice", pausedBy: "op" });
  assert.equal(isPortalPaused(db, { ...utilId, platform: "PowerClerk" }), true, "platform match is case-insensitive");
  assert.equal(isPortalPaused(db, { ...utilId, platform: "accela" }), false, "other platforms unaffected");
});

run("resume clears the profile pause", () => {
  const pauses = listPortalPauses(db);
  const profilePause = pauses.find((p) => p.kind === "profile");
  assert.ok(profilePause, "profile pause exists");
  assert.equal(resumePortal(db, profilePause!.id).resumed, true);
  assert.equal(isPortalPaused(db, ahjId), false);
});

run("pause is idempotent on its key (no duplicate rows)", () => {
  const before = listPortalPauses(db).filter((p) => p.kind === "platform").length;
  pausePortal(db, { kind: "platform", platform: "powerclerk", reason: "again", pausedBy: "op2" });
  const after = listPortalPauses(db).filter((p) => p.kind === "platform").length;
  assert.equal(after, before, "re-pausing the same key updates, not duplicates");
});

// Close before deleting — Windows holds the open handle as a file lock (EBUSY).
db.close();
fs.rmSync(dbPath, { force: true });
fs.rmSync(`${dbPath}-wal`, { force: true });
fs.rmSync(`${dbPath}-shm`, { force: true });

if (failures) {
  console.error(`\n${failures} portal-pause test(s) failed.`);
  process.exit(1);
}
console.log("\nAll portal-pause tests passed.");
