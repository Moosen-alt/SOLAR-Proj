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
import { REPLAY_RUNGS, mergeStepReport, scoreReplayOutcome, summarizeReplay, type ReplayRow } from "../src/replayBenchmark";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------
// The top rung, and everything that must fall short of it.
// ---------------------------------------------------------------------------
check("verified_accurate: ran clean AND the review screen matches the project", () => {
  const s = scoreReplayOutcome({ ok: true, executed: 98, recorded: 98, reviewFieldsSeen: 22, reviewFieldsConfirmed: 4, reviewMismatches: [] });
  assert.equal(s.rung, "verified_accurate");
  assert.equal(s.index, 5);
  assert.equal(s.owner, "none");
});

check("THE REGRESSION: a review screen READ but never CHECKED is not verified", () => {
  // Zero mismatches is not evidence. Every comparison returns early when the project has no
  // value to check with, so a page of boilerplate against a sparse project complains about
  // nothing while establishing nothing. A live run sat one fixture fix from claiming the top
  // rung on four fields: reviewFieldsSeen 4, zero mismatches, nothing confirmed.
  const s = scoreReplayOutcome({
    ok: true, executed: 98, recorded: 98,
    reviewFieldsSeen: 4, reviewFieldsConfirmed: 0, reviewMismatches: [],
  });
  assert.equal(s.rung, "replayed_clean");
  assert.equal(s.index, 4, "a filing nothing was confirmed on cannot hold the top rung");
  assert.match(s.reason, /too few to call the filing verified/);
});

check("...and one confirmed field is still too few to be coincidence-proof", () => {
  const s = scoreReplayOutcome({
    ok: true, executed: 98, recorded: 98,
    reviewFieldsSeen: 30, reviewFieldsConfirmed: 1, reviewMismatches: [],
  });
  assert.equal(s.index, 4);
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
    reviewMismatches: [{ field: "homeownerName", expected: "Avery Sample", found: "Charles Bitton" }],
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

check("THE SAFETY RULE IS NOT A DEFECT: the declined final submit is not a failed step", () => {
  // Automation never clicks final submit — the system's first hard rule. The recipe records
  // it, replay declines it, and it lands in `skipped` on EVERY run. Scoring that as a step
  // that "did not land" made the safety rule look like recipe drift, and on a live run where
  // nothing else had gone wrong it was the single thing pushing the owner to `recipe`.
  const s = scoreReplayOutcome({
    ok: true, executed: 97, recorded: 98, reviewFieldsSeen: 18, reviewFieldsConfirmed: 4, reviewMismatches: [],
    skipped: ["final submit: Submit (recorded, NOT clicked)"],
  });
  assert.equal(s.rung, "verified_accurate", `a clean verified run was demoted by the safety rule: ${s.reason}`);
});

check("...and it does not flip the owner on an otherwise data-only run", () => {
  const s = scoreReplayOutcome({
    ok: true, executed: 90, recorded: 98,
    skipped: ["upload sld: one-line drawing", "final submit: Submit (recorded, NOT clicked)"],
    unresolvedFields: ["upload sld: one-line drawing"],
  });
  assert.equal(s.owner, "data");
  assert.doesNotMatch(s.reason, /did not land/);
});

check("a step with NO VALUE to type is a data gap, not a drifted recipe", () => {
  // A live run reported eight skipped steps, of which four were things the throwaway project
  // never had: an account number, a meter number, and two plan-set documents. Blaming the
  // recipe sends someone to re-record one that is working perfectly.
  const s = scoreReplayOutcome({
    ok: true, executed: 90, recorded: 98,
    skipped: ["Customer's account number", "upload sld: one-line drawing"],
    unresolvedFields: ["Customer's account number", "upload sld: one-line drawing"],
  });
  assert.equal(s.rung, "replayed_with_gaps");
  assert.equal(s.owner, "data", "nothing here is the recipe's fault");
  assert.match(s.reason, /NO VALUE in the project/);
});

check("...but a step that TRIED and did not land is still the recipe's", () => {
  const s = scoreReplayOutcome({
    ok: true, executed: 90, recorded: 98,
    skipped: ["Total System Export (kW)", "Customer's account number"],
    unresolvedFields: ["Customer's account number"],
  });
  assert.equal(s.owner, "recipe");
  assert.match(s.reason, /did not land.*Total System Export/s);
  assert.match(s.reason, /NO VALUE in the project/, "and the data gap is still named");
});

check("THE REGRESSION: a 'successful' run that executed NOTHING is not clean", () => {
  // A live replay filled eight pages of PacifiCorp and reported executed:0, because the
  // harness read the adapter's report from the wrong level (`ok(msg, data)` puts it on the
  // STEP). This scorer only asked "ok, and nothing flagged?" — so "nothing happened" and
  // "everything happened correctly" produced the same number, 4.
  const s = scoreReplayOutcome({ ok: true, executed: 0, recorded: 98, reviewFieldsSeen: 0 });
  assert.equal(s.owner, "harness");
  assert.equal(s.measured, false);
  assert.match(s.reason, /executed 0 of 98/);
});

check("...but a recipe with no recorded steps is not accused of that", () => {
  const s = scoreReplayOutcome({ ok: true, executed: 0, recorded: 0, reviewFieldsSeen: 4, reviewMismatches: [] });
  assert.notEqual(s.owner, "harness");
});

check("THE REGRESSION: replay's OWN warnings are not allowed to be ignored", () => {
  // `driftWarnings` was declared on the outcome interface and never read, so the adapter
  // could report "held-check could read only 1 of 2 array row(s) — verify the arrays by eye
  // before submit" and the run still scored clean. The adapter pays to produce that warning
  // on the assumption someone acts on it.
  const s = scoreReplayOutcome({
    ok: true, executed: 98, recorded: 98, reviewFieldsSeen: 20, reviewFieldsConfirmed: 4, reviewMismatches: [],
    driftWarnings: ["held-check could read only 1 of 2 array row(s) — verify the arrays by eye before submit"],
  });
  assert.equal(s.rung, "replayed_with_gaps");
  assert.match(s.reason, /held-check|replay warned/);
});

check("the live PacifiCorp page: a portal-flagged blank cannot score clean", () => {
  // The run this benchmark scored `replayed_clean` on 2026-09-07. The portal was showing
  // "This field is required." under an empty module select and an empty required
  // "Total System Export (kW)"; the sweep that should have found them was blind, so the
  // scorer was handed an empty list and believed it. With the sweep fixed the evidence
  // arrives, and the verdict has to move.
  const s = scoreReplayOutcome({
    ok: true, executed: 98, recorded: 98, reviewFieldsSeen: 0,
    requiredStillEmpty: ["Model — the portal flagged this field", "Total System Export (kW)"],
  });
  assert.equal(s.index, 3);
  assert.match(s.reason, /Total System Export/);
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

check("THE REGRESSION: a portal that ends the session mid-run is not recipe drift", () => {
  // PowerClerk allows one session per user and ends the older one when a second login
  // appears — so a back-to-back sweep can kill its own run, and so can a human logging in to
  // look at something. The adapter says exactly this; the scorer used to answer "the recipe
  // no longer matches the portal" and blame the recipe for being interrupted.
  const s = scoreReplayOutcome({
    ok: false, executed: 55, recorded: 98,
    message: 'THE PORTAL ENDED THIS SESSION mid-run ("Session Ended") — commonly a concurrent login with the same account. Recipe step failed (click)',
  });
  assert.equal(s.owner, "portal");
  assert.equal(s.measured, false, "an interrupted run says nothing about the recipe");
  assert.doesNotMatch(s.reason, /no longer matches/);
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

check("THE REGRESSION: a silent failure with zero steps is the HARNESS, not the recipe", () => {
  // The first live run of this benchmark returned exactly this — ok:false, executed 0,
  // message "" — and was scored "the recipe no longer matches the portal", owner RECIPE.
  // The recipe was fine. The harness had handed the adapter a raw snake_case DB row, so it
  // bailed before opening a browser. That verdict was one report away from sending someone
  // to chase a drift that did not exist.
  const s = scoreReplayOutcome({ ok: false, executed: 0, recorded: 98, message: "" });
  assert.equal(s.owner, "harness");
  assert.equal(s.measured, false);
  assert.match(s.reason, /harness fault, not the recipe/);
});

check("...but a failure that SAYS something, at step zero, is still the recipe's", () => {
  // The distinction is whether we learned anything, not how far it got. A recipe whose very
  // first selector is gone has genuinely drifted.
  const s = scoreReplayOutcome({ ok: false, executed: 0, recorded: 98, message: "Recipe step failed (goto): net::ERR_ABORTED" });
  assert.notEqual(s.owner, "harness");
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
    { portal: "a", profileKey: "k1", score: scoreReplayOutcome({ ok: true, executed: 9, recorded: 9, reviewFieldsSeen: 12, reviewFieldsConfirmed: 4, reviewMismatches: [] }) },
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
    { portal: "a", profileKey: "k", score: scoreReplayOutcome({ ok: true, executed: 9, recorded: 9, reviewFieldsSeen: 5, reviewFieldsConfirmed: 3, reviewMismatches: [] }) },
    { portal: "b", profileKey: "k", score: scoreReplayOutcome({ ok: false, message: "Target closed" }) },
  ];
  assert.equal(summarizeReplay(rows).meanIndex, 5);
});

// ---------------------------------------------------------------------------
// "WHO CAN ACT" HAS TO NAME SOMEBODY WHO CAN.
//
// A blank is a data gap only when nobody gave us the value. Live on Ameren Illinois: Name,
// Company, Address, Email and Phone came back blank on all three attempts — every one of
// them present in the project — and the verdict read `data`, pointing the operator at their
// own record when the recipe has no steps for that section at all.
// ---------------------------------------------------------------------------
check("a blank the PROJECT HAS a value for is the recipe's gap, not the data's", () => {
  const s = scoreReplayOutcome({
    ok: true, executed: 70, recorded: 75,
    requiredStillEmpty: ["Name", "Company", "Address"],
    skipped: [], unresolvedFields: [], reviewFieldsSeen: 0,
  } as never);
  assert.equal(s.owner, "recipe",
    `five fields the project carries came back blank and the verdict blamed the data: ${s.reason}`);
});

check("...but a blank nobody gave us a value for is still DATA", () => {
  const s = scoreReplayOutcome({
    ok: true, executed: 70, recorded: 75,
    requiredStillEmpty: ["Please specify the size of the facility address' breaker panel: (A)"],
    skipped: ["Please specify the size of the facility address' breaker panel: (A)"],
    unresolvedFields: ["Please specify the size of the facility address' breaker panel: (A)"],
    reviewFieldsSeen: 0,
  } as never);
  assert.equal(s.owner, "data",
    `a field the project genuinely lacks was blamed on the recipe: ${s.reason}`);
});

// ---------------------------------------------------------------------------
// THE SPLIT, AND THE DIRECTION IT FAILS IN.
//
// driftWarnings was one list carrying four meanings -- a real defect, a human-must-look, a
// correct decision, and a successful self-heal -- and all four blocked a clean score. A
// portal with one stale recorded id could therefore never replay clean however correct the
// filing was, and the reliability number would have scored the engine's own repairs as
// failures.
//
// What keeps that split honest is the direction it fails in. Blocking is the DEFAULT: a
// message is benign only once someone has established it is, so a warning nobody has
// classified still stops the run being called clean. This is the test that says so, and it
// is also the answer to "did the scorer get tuned to flatter the number" -- it could not
// have been, because anything new fails closed.
// ---------------------------------------------------------------------------
const CLEAN = { ok: true, executed: 98, recorded: 98, reviewFieldsSeen: 22, reviewFieldsConfirmed: 4, reviewMismatches: [] };

check("THE FAIL-SAFE: an UNCLASSIFIED warning still blocks a clean score", () => {
  const s = scoreReplayOutcome({ ...CLEAN, driftWarnings: ["something nobody has triaged yet"] });
  assert.equal(s.rung, "replayed_with_gaps",
    "a warning no one has classified was treated as benign — the split fails OPEN");
});

check("a self-heal note does NOT block, because the filing is fine", () => {
  const s = scoreReplayOutcome({
    ...CLEAN,
    agingNotes: [`"Model" resolved by the portal's own test hook "inverter-model-select" — stabler than the recorded id`],
  });
  assert.equal(s.rung, "verified_accurate", s.reason);
});

check("...but the re-record signal survives declassification, on the row itself", () => {
  const s = scoreReplayOutcome({ ...CLEAN, agingNotes: [`"Model" resolved by SECTION "Inverter Clone System"`] });
  assert.match(s.reason, /re-recording|another route|route other than/i,
    `a clean row said nothing about the aging recipe: ${s.reason}`);
});

check("one blocking warning is enough, even beside a dozen benign ones", () => {
  const s = scoreReplayOutcome({
    ...CLEAN,
    agingNotes: Array.from({ length: 12 }, (_, i) => `resolved by test hook ${i}`),
    driftWarnings: ["a dropdown or date picker stayed open after two Escapes — verify it by eye"],
  });
  assert.equal(s.rung, "replayed_with_gaps", s.reason);
});

// ---------------------------------------------------------------------------
// THE HOP THAT SILENTLY DROPS THINGS. The adapter puts its run report in steps[].data, not
// on the top-level result, and every consumer -- benchmark and KPI both -- reads it back
// through here. A key that does not survive this trip does not error: it arrives as
// undefined, is coerced to zero or an empty list, and reports as a clean, empty, perfect
// nothing. That is how the fleet score came to be assembled from numbers nobody had
// checked reached the other side.
// ---------------------------------------------------------------------------
check("a new report key survives the trip from steps[].data", () => {
  const merged = mergeStepReport({
    ok: true,
    steps: [{ ok: true, message: "Replayed", data: { requiredFieldsSeen: ["Meter", "Model"], fieldsVerified: ["a"] } }],
  });
  assert.deepEqual(merged.requiredFieldsSeen, ["Meter", "Model"]);
  assert.deepEqual(merged.fieldsVerified, ["a"]);
});

check("a later empty list does not blank a real one collected earlier", () => {
  const merged = mergeStepReport({
    steps: [
      { ok: true, data: { requiredFieldsSeen: ["Meter"] } },
      { ok: true, data: { requiredFieldsSeen: [] } },
    ],
  });
  assert.deepEqual(merged.requiredFieldsSeen, ["Meter"],
    "a step that saw nothing erased what an earlier step did see");
});

check("steps[].data beats a stale top-level value of the same name", () => {
  const merged = mergeStepReport({
    requiredFieldsSeen: [],
    steps: [{ ok: true, data: { requiredFieldsSeen: ["Meter"] } }],
  });
  assert.deepEqual(merged.requiredFieldsSeen, ["Meter"]);
});

if (failures) { console.error(`\n${failures} replay-benchmark check(s) FAILED.`); process.exit(1); }
console.log("\nAll replay-benchmark checks passed.");
process.exit(0);
