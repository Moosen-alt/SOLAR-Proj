// TWO RUNS, ONE LOGIN: a portal profile must be held by one run at a time.
//
// A Chromium persistent profile is a single-holder OS lock keyed by (client, portal), never
// by run. Serial job draining hid that; with JOB_CONCURRENCY > 1 two runs for the same
// client and portal would race and the loser would die at launch with an error advising the
// operator to kill Chrome — mid-flight, that kills a live submission.
//
// These tests drive openPortal/closePortal against a REAL Chromium with real profile
// directories: the same code path a live run takes, minus the portal.
// Run: npx tsx portal-bot/src/profileQueue.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openPortal, closePortal } from "./browser";

let failures = 0;
const check = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "profile-queue-test-"));
const profileA = path.join(tmp, "clientA-portal1");
const profileB = path.join(tmp, "clientA-portal2");

await check("two runs on the SAME profile serialise — the second waits, neither fails", async () => {
  const order: string[] = [];
  const runOne = async (tag: string, holdMs: number) => {
    const opened = await openPortal({ userDataDir: profileA, headless: true });
    order.push(`${tag}:start`);
    await new Promise((r) => setTimeout(r, holdMs));
    order.push(`${tag}:end`);
    await closePortal(opened);
  };
  // Launch both at once. Without the queue the second throws "profile is still locked".
  await Promise.all([runOne("first", 1200), runOne("second", 200)]);
  // The proof is non-overlap: the first must fully finish before the second starts.
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"],
    `runs overlapped or failed — got ${JSON.stringify(order)}`);
});

await check("two runs on DIFFERENT profiles overlap — concurrency is not lost", async () => {
  const marks: string[] = [];
  const runOne = async (tag: string, dir: string) => {
    const opened = await openPortal({ userDataDir: dir, headless: true });
    marks.push(`${tag}:start`);
    await new Promise((r) => setTimeout(r, 900));
    marks.push(`${tag}:end`);
    await closePortal(opened);
  };
  await Promise.all([runOne("a", profileA), runOne("b", profileB)]);
  // Interleaved starts prove they ran together rather than one-after-another.
  const bothStartedFirst = marks[0].endsWith(":start") && marks[1].endsWith(":start");
  assert.ok(bothStartedFirst, `different profiles must run concurrently — got ${JSON.stringify(marks)}`);
});

await check("a crashed run still releases the profile for the next one", async () => {
  const opened = await openPortal({ userDataDir: profileA, headless: true });
  // Simulate a run that blows up mid-flight but still tears down in its finally.
  try { throw new Error("boom"); } catch { /* the run's own error handling */ }
  finally { await closePortal(opened); }
  // The next run must not be stuck behind the dead one.
  const after = await openPortal({ userDataDir: profileA, headless: true });
  assert.ok(after.page, "profile should be free after the previous run closed");
  await closePortal(after);
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} profile-queue test(s) FAILED.`); process.exit(1); }
console.log("\nAll profile-queue tests passed (real Chromium).");
process.exit(0);
