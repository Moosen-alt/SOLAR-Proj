// THE LADDER IS THE MEASUREMENT, SO THE LADDER IS WHAT MUST NOT DRIFT.
//
// "Does the learn work on an arbitrary portal?" was answered all session by throwaway
// scripts, so every figure came with no way to reproduce or compare it — and a target like
// 95% is unverifiable in that state. The benchmark exists to keep the number.
//
// Which makes the scorer the load-bearing part: if it quietly gets more generous, the number
// improves while the bot does not. Every rung here is scored from a REAL outcome observed
// during the live trial on 2026-09-04 (Tyler EnerGov, SmartGov, eTRAKiT, Momentum, ComEd,
// Ameren), so the ladder is pinned to things that actually happened rather than to shapes
// invented to make it pass.
//
// Browser-free. Run: tsx backend/test/learnBenchmark.test.ts
import assert from "node:assert/strict";
import { LEARN_RUNGS, compareRuns, isMeasured, scoreLearnOutcome, summarize, type BenchmarkRow } from "../src/learnBenchmark";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------
// Each rung, from a real run.
// ---------------------------------------------------------------------------
check("unreachable: the portal never loaded", () => {
  const s = scoreLearnOutcome({ status: "threw", message: "page.goto: net::ERR_NAME_NOT_RESOLVED" });
  assert.equal(s.rung, "unreachable");
  assert.equal(s.owner, "portal");
});

check("login_failed / credential: a refused password is the OPERATOR's to fix", () => {
  // eTRAKiT, Shoreline WA — verbatim.
  const s = scoreLearnOutcome({
    status: "failed",
    message: "Still on the login form after submitting — the stored username/password was likely rejected.",
    events: [{ type: "login", status: "still_on_login" }],
  });
  assert.equal(s.rung, "login_failed");
  assert.equal(s.owner, "credential", "a stale password is not an engine defect");
});

check("login_failed / credential: no stored login at all", () => {
  // City of Portland DevHub — no credential exists for that host.
  const s = scoreLearnOutcome({ status: "failed", events: [{ type: "login", status: "no_credential" }] });
  assert.equal(s.rung, "login_failed");
  assert.equal(s.owner, "credential");
});

check("login_failed / ENGINE: a login we could not recognise is OURS", () => {
  // Tyler EnerGov, Wilsonville OR. Same rung, different owner — that distinction is the
  // whole reason the scorer records an owner at all.
  const s = scoreLearnOutcome({
    status: "failed",
    message: "Could not find a login form or any signed-in signal on this portal",
    events: [{ type: "login", status: "login_form_unrecognized" }],
  });
  assert.equal(s.rung, "login_failed");
  assert.equal(s.owner, "engine");
});

check("authenticated: signed in, but no way into an application", () => {
  // Momentum, before the collapsed-nav fix.
  const s = scoreLearnOutcome({
    status: "failed",
    pageCount: 0,
    message: "Auto-learn found nothing fillable",
    events: [{ type: "login", status: "logged_in" }, { type: "application_entry_pass", ok: false }],
  });
  assert.equal(s.rung, "authenticated");
  assert.equal(s.owner, "engine");
});

check("entered_application: the entry was followed", () => {
  const s = scoreLearnOutcome({
    status: "failed", pageCount: 0,
    events: [{ type: "login", status: "logged_in" }, { type: "application_entry_pass", ok: true }],
  });
  assert.equal(s.rung, "entered_application");
});

check("reached_form: pages walked but nothing recorded", () => {
  // Momentum after the fixes: 10 pages, stuck on the record-type gate.
  const s = scoreLearnOutcome({
    status: "failed", pageCount: 10, steps: 0,
    message: "Auto-learn found nothing fillable on 10 page(s); no steps recorded",
    events: [{ type: "login", status: "logged_in" }, { type: "application_entry_pass", ok: true }],
  });
  assert.equal(s.rung, "reached_form");
  assert.equal(s.index, 4);
});

check("recorded_steps: a recipe exists but review was never reached", () => {
  // ComEd after the drawer fix: 7 fills, 10 steps, no review screen.
  const s = scoreLearnOutcome({ status: "failed", pageCount: 2, steps: 10, message: "filled fields but never reached the portal's review screen" });
  assert.equal(s.rung, "recorded_steps");
  assert.equal(s.index, 5);
});

check("reached_review: the top rung, and nobody owes anything", () => {
  // Ameren Illinois: 75 steps to the fee invoice.
  const s = scoreLearnOutcome({ status: "complete", pageCount: 9, steps: 75, reachedReview: true });
  assert.equal(s.rung, "reached_review");
  assert.equal(s.index, 6);
  assert.equal(s.owner, "none");
});

// ---------------------------------------------------------------------------
// A BENCHMARK THAT BLAMES THE ENGINE FOR A DEAD HOST SENDS THE NEXT DAY'S WORK ASTRAY.
//
// The first baseline scored three portals "the login form was not recognised", owner engine.
// Probing them found one timed out, one returned 403 to a headless browser, and one has no
// login at all. Only the third was ours — a 3-in-5 "engine problem" that was really 1-in-5.
// ---------------------------------------------------------------------------
check("a portal that never responded is the PORTAL's problem", () => {
  const s = scoreLearnOutcome({ status: "failed", message: "page.goto: net::ERR_TIMED_OUT at https://www4.citizenserve.com/..." });
  assert.equal(s.rung, "unreachable");
  assert.equal(s.owner, "portal", "a dead host must not be counted as a detector defect");
});

check("a WAF/bot block is the PORTAL's problem too", () => {
  const s = scoreLearnOutcome({ status: "failed", message: "403 Forbidden" });
  assert.equal(s.rung, "unreachable");
  assert.equal(s.owner, "portal");
});

check("...but a page we DID receive and could not read stays ours", () => {
  const s = scoreLearnOutcome({
    status: "failed",
    message: "Could not find a login form or any signed-in signal on this portal",
    events: [{ type: "login", status: "login_form_unrecognized" }],
  });
  assert.equal(s.owner, "engine");
});

check("a portal with NO LOGIN is not a login failure", () => {
  // Gilbert, AZ publishes its permit request as a plain form: eight fields, no password.
  const s = scoreLearnOutcome({ events: [{ type: "login", status: "no_login_required" }] });
  assert.equal(s.rung, "authenticated");
  assert.ok(/no login exists/i.test(s.reason));
});

check("a benchmark TIME CAP is scored on what was reached, not as a portal failure", () => {
  // A capped run that had already walked pages keeps that credit — the harness must never
  // blame a portal for its own impatience.
  const partial = scoreLearnOutcome({ status: "timeout", pageCount: 6, steps: 3, message: "benchmark cap: the learn exceeded 480s on this portal" });
  assert.equal(partial.rung, "recorded_steps");
  // And one capped before it got anywhere is ours, not the portal's.
  const nothing = scoreLearnOutcome({ status: "timeout", message: "benchmark cap: the learn exceeded 480s on this portal" });
  assert.equal(nothing.owner, "engine");
});

// ---------------------------------------------------------------------------
// A RUN THE HARNESS KILLED IS NOT A MEASUREMENT OF THE PORTAL.
//
// Both of these were sitting in real scorecards, scored 0 and attributed to the PORTAL.
// The 11-portal run reported "1 usable, mean 0.55" when eight of its rows were its own
// browser dying; the 12-portal run before it blamed four jurisdictions for our
// concurrency lease. Twelve rows of "the portal is broken" that were nothing of the kind.
// ---------------------------------------------------------------------------
check("THE REGRESSION: a dead browser is the harness's, not the portal's", () => {
  // Verbatim from data/learn-benchmark/2026-09-04T06-37-14.json, eight times over.
  const s = scoreLearnOutcome({
    status: "threw",
    message: "Auto-learn login failed: browserType.launchPersistentContext: Target page, context or browser has been closed",
  });
  assert.equal(s.owner, "harness", "this was our browser going away, not a portal refusing");
  assert.equal(s.measured, false);
  assert.equal(isMeasured(s), false);
});

check("...and so is our own concurrency lease refusing to start", () => {
  const s = scoreLearnOutcome({ status: "failed", message: "A learn for this portal is already running. Recipes are shared between clients." });
  assert.equal(s.owner, "harness");
  assert.equal(isMeasured(s), false);
});

check("a run that died holding real progress KEEPS that progress", () => {
  // The credit is earned before the browser goes away; only a run that reached nothing
  // becomes a non-measurement.
  const s = scoreLearnOutcome({ pageCount: 3, steps: 12, message: "Target page, context or browser has been closed" });
  assert.equal(s.rung, "recorded_steps");
  assert.equal(isMeasured(s), true);
});

check("an unmeasured row is EXCLUDED from the headline, not counted as a zero", () => {
  const mixed: BenchmarkRow[] = [
    { portal: "real1", platform: "X", score: scoreLearnOutcome({ pageCount: 9, steps: 75, reachedReview: true }) },
    { portal: "real2", platform: "Y", score: scoreLearnOutcome({ pageCount: 2, steps: 10 }) },
    { portal: "dead", platform: "Z", score: scoreLearnOutcome({ message: "browserType.launchPersistentContext: Target page, context or browser has been closed" }) },
  ];
  const s = summarize(mixed);
  assert.equal(s.total, 3, "every attempted portal is still reported");
  assert.equal(s.measured, 2);
  assert.equal(s.notMeasured, 1);
  // 2 of 2, not 2 of 3. Averaging in a portal nobody tried is how 3 real results
  // turned into "9% usable".
  assert.equal(s.usablePct, 100);
  assert.equal(s.meanIndex, 5.5);
});

check("PHANTOM IMPROVEMENTS: a real run is not compared against a killed one", () => {
  // latest.json held eight portals at index 0 purely because the run was interrupted.
  // Without this, the next honest run announces eight wins it did not earn.
  const killed: BenchmarkRow[] = [{ portal: "a", platform: "X", score: scoreLearnOutcome({ message: "browserType.launchPersistentContext: Target page, context or browser has been closed" }) }];
  const real: BenchmarkRow[] = [{ portal: "a", platform: "X", score: scoreLearnOutcome({ pageCount: 4 }) }];
  const diff = compareRuns(killed, real);
  assert.equal(diff.improved.length, 0, "climbing out of a non-measurement is not an improvement");
  assert.equal(diff.regressed.length, 0);
});

check("...and being interrupted is never reported as a regression", () => {
  const real: BenchmarkRow[] = [{ portal: "a", platform: "X", score: scoreLearnOutcome({ pageCount: 9, steps: 75, reachedReview: true }) }];
  const killed: BenchmarkRow[] = [{ portal: "a", platform: "X", score: scoreLearnOutcome({ message: "Target page, context or browser has been closed" }) }];
  assert.equal(compareRuns(real, killed).regressed.length, 0);
});

check("a RESET SOCKET stays a real result — it is usually the portal dropping us", () => {
  // The tempting token to add to the harness list, and the wrong one: filing this as
  // "not measured" would hide a genuine portal finding behind the guard built to stop
  // exactly that kind of misattribution.
  const s = scoreLearnOutcome({ status: "threw", message: "page.goto: net::ERR_CONNECTION_RESET at https://example.gov/" });
  assert.equal(s.owner, "portal");
  assert.equal(isMeasured(s), true);
});

check("OLD SCORECARDS ON DISK are read correctly though they predate the flag", () => {
  // The poisoned rows were written before `measured` existed, so their reason text is
  // the only evidence there is. compareRuns has to read it, or the file keeps lying.
  assert.equal(isMeasured({ reason: "Could not learn the portal automatically: Auto-learn login failed: browserType.launchPersistentContext: Target page, context or browser has been closed" }), false);
  assert.equal(isMeasured({ reason: "A learn for this portal is already running. Recipes are shared" }), false);
  assert.equal(isMeasured({ reason: "the portal's login form was not recognised" }), true);
  assert.equal(isMeasured({ reason: "the portal did not respond" }), true, "a genuinely dead host IS a measurement");
});

// ---------------------------------------------------------------------------
// The ladder must stay ordered and honest.
// ---------------------------------------------------------------------------
check("the rungs are strictly ordered, worst to best", () => {
  const seen = LEARN_RUNGS.map((_, i) => i);
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6]);
});

check("EVIDENCE ORDER: a recorded recipe outranks a discouraging message", () => {
  // The message is prose assembled at the end; steps and pages are facts recorded as they
  // happened. A scorer that trusted the prose would under-report real progress.
  const s = scoreLearnOutcome({ status: "failed", pageCount: 3, steps: 12, message: "Could not learn the portal automatically" });
  assert.equal(s.rung, "recorded_steps");
});

check("...and a run that got nowhere is not flattered by a hopeful message", () => {
  const s = scoreLearnOutcome({ status: "failed", pageCount: 0, steps: 0, message: "Auto-learn found nothing fillable" });
  assert.ok(s.index <= 1, `scored ${s.index} (${s.rung}) with no pages and no steps`);
});

// ---------------------------------------------------------------------------
// The headline number, and the split that stops it being read as one problem.
// ---------------------------------------------------------------------------
const rows: BenchmarkRow[] = [
  { portal: "a", platform: "X", score: scoreLearnOutcome({ pageCount: 9, steps: 75, reachedReview: true }) },
  { portal: "b", platform: "Y", score: scoreLearnOutcome({ pageCount: 2, steps: 10 }) },
  { portal: "c", platform: "Z", score: scoreLearnOutcome({ events: [{ type: "login", status: "still_on_login" }] }) },
  { portal: "d", platform: "W", score: scoreLearnOutcome({ message: "net::ERR_NAME_NOT_RESOLVED" }) },
];

check("the headline counts USABLE recipes, not runs that merely started", () => {
  const s = summarize(rows);
  assert.equal(s.total, 4);
  assert.equal(s.usableRecipes, 2, "only the review + recorded-steps runs produced something replayable");
  assert.equal(s.usablePct, 50);
});

check("the mean rung moves before the headline does", () => {
  // (6 + 5 + 1 + 0) / 4 — a portal climbing from login_failed to authenticated shows here
  // long before it shows in the pass rate, which is what makes progress visible early.
  assert.equal(summarize(rows).meanIndex, 3);
});

check("outcomes are split by WHO CAN ACT — engine, credential, portal", () => {
  const s = summarize(rows);
  assert.equal(s.byOwner.credential, 1, "a stale password must not be counted as an engine failure");
  assert.equal(s.byOwner.portal, 1);
  assert.equal(s.byOwner.none, 1);
});

// ---------------------------------------------------------------------------
// Regressions are the point of keeping the number.
// ---------------------------------------------------------------------------
check("a portal that FELL a rung is reported as a regression", () => {
  const before: BenchmarkRow[] = [{ portal: "a", platform: "X", score: scoreLearnOutcome({ pageCount: 9, steps: 75, reachedReview: true }) }];
  const after: BenchmarkRow[] = [{ portal: "a", platform: "X", score: scoreLearnOutcome({ events: [{ type: "login", status: "still_on_login" }] }) }];
  const diff = compareRuns(before, after);
  assert.equal(diff.regressed.length, 1);
  assert.equal(diff.regressed[0].from, "reached_review");
  assert.equal(diff.regressed[0].to, "login_failed");
  assert.equal(diff.improved.length, 0);
});

check("...and a climb is reported as an improvement, not silence", () => {
  const before: BenchmarkRow[] = [{ portal: "m", platform: "Momentum", score: scoreLearnOutcome({ events: [{ type: "login", status: "logged_in" }, { type: "application_entry_pass", ok: false }] }) }];
  const after: BenchmarkRow[] = [{ portal: "m", platform: "Momentum", score: scoreLearnOutcome({ pageCount: 10, events: [{ type: "login", status: "logged_in" }, { type: "application_entry_pass", ok: true }] }) }];
  const diff = compareRuns(before, after);
  assert.equal(diff.improved.length, 1);
  assert.equal(diff.improved[0].from, "authenticated");
  assert.equal(diff.improved[0].to, "reached_form");
});

check("a portal absent from the previous run is neither a win nor a regression", () => {
  const diff = compareRuns([], [{ portal: "new", platform: "X", score: scoreLearnOutcome({ pageCount: 1 }) }]);
  assert.equal(diff.regressed.length, 0);
  assert.equal(diff.improved.length, 0);
  assert.equal(diff.unchanged, 0);
});

if (failures) { console.error(`\n${failures} learn-benchmark check(s) FAILED.`); process.exit(1); }
console.log("\nAll learn-benchmark checks passed.");
process.exit(0);
