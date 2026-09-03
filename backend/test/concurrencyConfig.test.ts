// CAN THESE CONCURRENCY NUMBERS ACTUALLY WORK TOGETHER?
//
// Runs sharing a client+portal profile serialise (PowerClerk permits one session per
// account), so N jobs claimed for the same client queue behind each other. If the last one's
// wait can exceed PORTAL_PROFILE_WAIT_MS it gives up — and portal jobs are pinned to
// maxRetries 0, so that is a PERMANENT failure and a human-review item for a filing that
// never started. At the shipped JOB_CONCURRENCY=1 it is unreachable; raising concurrency for
// throughput arms it silently, which is exactly what happened when this deployment was sized
// for 556 projects/month.
// Browser/DB-free. Run: tsx backend/test/concurrencyConfig.test.ts
import assert from "node:assert/strict";
import { checkConcurrencyConfig, readConcurrencyConfig, worstCaseProfileWaitMs } from "../src/concurrencyConfig";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const MIN = 60_000;
const cfg = (over: Partial<ReturnType<typeof readConcurrencyConfig>> = {}) => ({
  jobConcurrency: 1, portalRunMaxMs: 25 * MIN, profileWaitMs: 15 * MIN, maxConcurrentPortalRuns: 2, ...over,
});
const codes = (c: ReturnType<typeof cfg>) => checkConcurrencyConfig(c).map((w) => w.code);

check("the shipped default is safe — one job at a time never waits", () => {
  assert.equal(worstCaseProfileWaitMs(cfg()), 0);
  assert.deepEqual(codes(cfg()), []);
});

check("THE REGRESSION: raising concurrency to 4 without raising the wait is flagged", () => {
  // 3 runs ahead × 25 min ceiling = 75 min of possible wait against a 15 min give-up.
  const c = cfg({ jobConcurrency: 4, maxConcurrentPortalRuns: 4 });
  assert.equal(worstCaseProfileWaitMs(c), 75 * MIN);
  assert.ok(codes(c).includes("profile_wait_too_short"), JSON.stringify(codes(c)));
  // And the warning must say what to do about it, in minutes an operator can act on.
  const msg = checkConcurrencyConfig(c)[0].message;
  assert.match(msg, /75 min/);
  assert.match(msg, /PORTAL_PROFILE_WAIT_MS/);
});

check("even 2 slots is unsafe at the default wait — the ceiling alone outlasts it", () => {
  assert.ok(codes(cfg({ jobConcurrency: 2, maxConcurrentPortalRuns: 2 })).includes("profile_wait_too_short"));
});

check("raising the wait to cover the worst case clears it", () => {
  const c = cfg({ jobConcurrency: 4, maxConcurrentPortalRuns: 4, profileWaitMs: 90 * MIN });
  assert.deepEqual(codes(c), []);
});

check("lowering the run ceiling clears it too — the other lever", () => {
  // 3 ahead × 5 min = 15 min, which the 15 min wait exactly survives.
  const c = cfg({ jobConcurrency: 4, maxConcurrentPortalRuns: 4, portalRunMaxMs: 5 * MIN });
  assert.deepEqual(codes(c), []);
});

check("fewer browser slots than job slots is its own warning", () => {
  const c = cfg({ jobConcurrency: 4, maxConcurrentPortalRuns: 2, profileWaitMs: 90 * MIN });
  assert.deepEqual(codes(c), ["browser_slots_below_jobs"]);
});

check("both problems at once are both reported, not just the first", () => {
  const c = cfg({ jobConcurrency: 4, maxConcurrentPortalRuns: 2 });
  assert.deepEqual(codes(c).sort(), ["browser_slots_below_jobs", "profile_wait_too_short"]);
});

check("readConcurrencyConfig mirrors the defaults the code actually uses", () => {
  const d = readConcurrencyConfig({} as NodeJS.ProcessEnv);
  assert.equal(d.jobConcurrency, 1);            // jobQueue.ts
  assert.equal(d.portalRunMaxMs, 25 * MIN);     // portal-bot/index.ts
  assert.equal(d.profileWaitMs, 15 * MIN);      // portal-bot/browser.ts
  assert.equal(d.maxConcurrentPortalRuns, 2);   // portal-bot/index.ts
});

check("this deployment's own .env values pass", () => {
  // The numbers actually set for the 556/month target.
  const c = cfg({ jobConcurrency: 4, maxConcurrentPortalRuns: 4, profileWaitMs: 90 * MIN });
  assert.deepEqual(checkConcurrencyConfig(c), []);
});

if (failures) { console.error(`\n${failures} concurrency-config check(s) FAILED.`); process.exit(1); }
console.log("\nAll concurrency-config checks passed.");
process.exit(0);
