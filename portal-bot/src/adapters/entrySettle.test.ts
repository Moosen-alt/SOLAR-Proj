// THE ENTRY FINDER'S SETTLE BUDGET IS READ WHEN IT IS SPENT, NOT WHEN THE MODULE LOADS.
//
// findApplicationEntryDeep keeps re-reading a page for ENTRY_SETTLE_MS (30 s by default)
// before it concludes the portal has no "start an application" control — a live dashboard
// can paint its nav seconds after login. That budget is right live and ruinous on a fake page
// that will never grow an entry: autoLearnAdapter.test.ts spent it on every review-bound walk
// and took ~20 minutes (#6). The suite sets ENTRY_SETTLE_MS=0, but it can only do so in a
// statement, and an ES module's static imports run first — a constant captured at import
// never saw it. This pins both halves: a budget set after import is honoured, and a non-zero
// budget is still spent in full (the live behaviour is unchanged).
//
// Browser-free. Run: npx tsx portal-bot/src/adapters/entrySettle.test.ts
import assert from "node:assert/strict";
import { findApplicationEntryDeep } from "./applicationEntry";

let failures = 0;
const check = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// A logged-in page with no entry control, no collapsed nav and no modules: the finder can
// only settle and give up. waitForTimeout records each poll and sleeps a short real interval
// (whatever was asked), so a spent budget shows up as polls and wall time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emptyDashboard(polls: number[]): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page: any = {
    url: () => "https://portal.example/dashboard",
    frames: () => [page],
    waitForLoadState: async () => undefined,
    waitForTimeout: async (ms: number) => { polls.push(ms); await new Promise((r) => setTimeout(r, 50)); },
    evaluate: async () => { throw new Error("no DOM on a fake page"); },
    locator: () => ({ first: () => ({ count: async () => 0, isVisible: async () => false }) }),
  };
  return page;
}

await check("ENTRY_SETTLE_MS set after import: zero means one look, no settle polling", async () => {
  process.env.ENTRY_SETTLE_MS = "0";
  const polls: number[] = [];
  const t0 = Date.now();
  const found = await findApplicationEntryDeep(emptyDashboard(polls));
  assert.equal(found, null);
  const reReads = polls.filter((ms) => ms === 1500).length;
  assert.equal(reReads, 0, `${reReads} settle re-read(s) with a zero budget`);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms; the 30 s default was used`);
});

await check("a non-zero budget is still spent in full before giving up", async () => {
  process.env.ENTRY_SETTLE_MS = "600";
  const polls: number[] = [];
  const t0 = Date.now();
  const found = await findApplicationEntryDeep(emptyDashboard(polls));
  assert.equal(found, null);
  assert.ok(polls.filter((ms) => ms === 1500).length >= 3, `only ${polls.length} settle re-read(s) in a 600 ms budget`);
  assert.ok(Date.now() - t0 >= 600, "gave up before the budget was spent");
});

if (failures) { console.error(`\n${failures} entry-settle check(s) FAILED.`); process.exit(1); }
console.log("\nAll entry-settle checks passed.");
process.exit(0);
