// THE OTHER HALF OF THE PROMISE, WHICH HAD NO MEASUREMENT AT ALL.
//
// "Learn once, replay forever" was half-measured: a learn benchmark existed, a replay one did
// not. Worse, replay was not checking anything — it reported `Replayed 98 recorded step(s)`
// without ever reading the review screen (fixed in cfdcca5), so "it ran" has never been
// evidence that the filing was right.
//
// That is why the top rung here is not "every step executed". A drifted selector executes
// perfectly into the wrong field, and that exact failure reached a live PowerClerk filing:
// Charles Bitton of TML INTERNATIONAL replaced by the homeowner's name in the preparer
// block. Every step ran. Nothing was blank. The filing was wrong.
//
// Most of this test is therefore about what must NOT reach the top rung.
//
// Browser-free. Run: tsx backend/test/replayBenchmark.test.ts
import assert from "node:assert/strict";
import { REPLAY_RUNGS, scoreReplayOutcome, summarizeReplay, type ReplayRow } from "../src/replayBenchmark";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------
// The top rung, and everything that must fall short of it.
// ---------------------------------------------------------------------------
check("verified_accurate: ran clean AND the review screen matches the project", () => {
  const s = scoreReplayOutcome({ ok: true, executed: 98, recorded: 98, reviewFieldsSeen: 22, reviewMismatches: [] });
  assert.equal(s.rung, "verified_accurate");
  assert.equal(s.index, 5);
  assert.equal(s.owner, "none");
});

check("THE REGRESSION: a clean run whose review screen was NEVER READ is not verified", () => {
  // This is the state every replay was in before cfdcca5 — and "we could not check" must
  // never score the same as "we checked and it was right".
  const s = scoreReplayOutcome({ ok: true, executed: 98, recorded: 98, reviewFieldsSeen: 0 });
  assert.equal(s.rung, "replayed_clean");
  assert.equal(s.index, 4, "an unverified filing cannot hold the top rung");
  assert.match(s.reason, /UNVERIFIED/);
});

check("...and a clean run that CONTRADICTS the project is not verified either", () => {
  // The live incident's shape: every step ran, nothing blank, wrong name on the screen.
  const s = scoreReplayOutcome({
    ok: true, executed: 98, recorded: 98, reviewFieldsSeen: 22,
    reviewMismatches: [{ field: "homeownerName", expected: "Wynema Wright", found: "Charles Bitton" }],
  });
  assert.equal(s.index, 4);
  assert.equal(s.owner, "recipe");
  assert.match(s.reason, /DO NOT SUBMIT/);
  assert.match(s.reason, /Charles Bitton/);
});

// ---------------------------------------------------------------------------
// Gaps. A tidy summary is not a whole run.
// ---------------------------------------------------------------------------
check("a required field left blank is a gap, however clean the message reads", () => {
  const s = scoreReplayOutcome({ ok: true, executed: 98, recorded: 98, requiredStillEmpty: ["Inverter Model"] });
  assert.equal(s.rung, "replayed_with_gaps");
  assert.match(s.reason, /Inverter Model/);
});

check("a HEALED selector is a gap — the recipe is drifting even though it worked", () => {
  // Self-healing keeps a filing alive and hides the drift; the benchmark must not.
  const s = scoreReplayOutcome({ ok: true, executed: 98, recorded: 98, healedSteps: [{}, {}] });
  assert.equal(s.rung, "replayed_with_gaps");
  assert.match(s.reason, /re-anchored|drifting/);
});

check("skipped steps count as a gap", () => {
  const s = scoreReplayOutcome({ ok: true, executed: 90, recorded: 98, skipped: ["a", "b"] });
  assert.equal(s.rung, "replayed_with_gaps");
});

// ---------------------------------------------------------------------------
// Failure, and whose it is. The owner split is what makes the number actionable.
// ---------------------------------------------------------------------------
check("a replay that aborts part-way is the RECIPE's problem, and says where", () => {
  const s = scoreReplayOutcome({ ok: false, executed: 41, recorded: 98, message: "Recipe step failed (click): selector unresolved" });
  assert.equal(s.rung, "steps_failed");
  assert.equal(s.owner, "recipe");
  assert.match(s.reason, /41 of 98/);
});

check("a refused password is the OPERATOR's, not the recipe's", () => {
  const s = scoreReplayOutcome({ ok: false, message: "Still on the login form after submitting — the stored username/password was likely rejected." });
  assert.equal(s.owner, "credential");
});

check("a CAPTCHA is the PORTAL's — automation never solves one", () => {
  const s = scoreReplayOutcome({ ok: false, pauseReason: "mfa_captcha", message: "Login paused: challenge frame detected" });
  assert.equal(s.rung, "login_failed");
  assert.equal(s.owner, "portal");
});

check("a dead host and a WAF block are both the portal's", () => {
  assert.equal(scoreReplayOutcome({ ok: false, message: "page.goto: net::ERR_TIMED_OUT" }).owner, "portal");
  assert.equal(scoreReplayOutcome({ ok: false, message: "Attention Required! | Cloudflare" }).owner, "portal");
});

check("a run OUR harness killed is not a measurement of the recipe", () => {
  const s = scoreReplayOutcome({ ok: false, message: "browserType.launchPersistentContext: Target page, context or browser has been closed" });
  assert.equal(s.owner, "harness");
  assert.equal(s.measured, false);
});

// ---------------------------------------------------------------------------
// The headline, and the ladder's shape.
// ---------------------------------------------------------------------------
check("the rungs are strictly ordered, worst to best", () => {
  assert.deepEqual(REPLAY_RUNGS.map((_, i) => i), [0, 1, 2, 3, 4, 5]);
});

check("the headline counts only VERIFIED replays, not clean ones", () => {
  const rows: ReplayRow[] = [
    { portal: "a", profileKey: "k1", score: scoreReplayOutcome({ ok: true, executed: 9, recorded: 9, reviewFieldsSeen: 12, reviewMismatches: [] }) },
    { portal: "b", profileKey: "k2", score: scoreReplayOutcome({ ok: true, executed: 9, recorded: 9, reviewFieldsSeen: 0 }) },
    { portal: "c", profileKey: "k3", score: scoreReplayOutcome({ ok: false, message: "Recipe step failed (fill)" }) },
    { portal: "d", profileKey: "k4", score: scoreReplayOutcome({ ok: false, message: "Target page, context or browser has been closed" }) },
  ];
  const s = summarizeReplay(rows);
  assert.equal(s.total, 4);
  assert.equal(s.measured, 3, "the harness death is not in the sample");
  assert.equal(s.submittable, 1, "only the verified one is submittable — the unread review screen is not");
  assert.equal(s.submittablePct, 33.3);
});

check("...and the harness death is excluded from the mean too", () => {
  const rows: ReplayRow[] = [
    { portal: "a", profileKey: "k", score: scoreReplayOutcome({ ok: true, executed: 9, recorded: 9, reviewFieldsSeen: 5, reviewMismatches: [] }) },
    { portal: "b", profileKey: "k", score: scoreReplayOutcome({ ok: false, message: "Target closed" }) },
  ];
  assert.equal(summarizeReplay(rows).meanIndex, 5);
});

if (failures) { console.error(`\n${failures} replay-benchmark check(s) FAILED.`); process.exit(1); }
console.log("\nAll replay-benchmark checks passed.");
process.exit(0);
