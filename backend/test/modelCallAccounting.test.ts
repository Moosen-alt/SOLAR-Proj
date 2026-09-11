// "REPLAY DID THE HEAVY LIFTING" WAS A SENTENCE, NOT A NUMBER.
//
// The outside review's acceptance criterion for a published workflow is "stage a
// different project ... and ZERO model calls". Nothing measured it: production injects
// an LLM gap-fill planner into every staged replay (repository.ts), the benchmark
// mirrors it with --gap-fill, and a replay that quietly spent five planner calls
// printed the same `replayed_clean` as one that ran on its recorded steps alone.
//
// The replay benchmark now windows llm.ts's own call log around each attempt —
// snapshot Date.now() before, query at-or-after it when the attempt ends — and this
// test pins the two ways that window can lie:
//   • THE BOUNDARY: a call made before the snapshot must not be billed to the attempt.
//     The log is module-global; without the boundary every attempt inherits the whole
//     process history, and the first attempt's planner calls appear on every later
//     attempt's bill.
//   • THE CLASSIFICATION: under --expect-zero-model, ONE model call is enough to keep
//     a clean run off the clean rungs — measured, never forbidden.
//
// Uses the REAL record/query surface from llm.ts, not a mock: the benchmark computes
// its number from exactly that pair, and a test against a fake log would prove the fake.
//
// Browser-free, no network, no DB. Run: tsx backend/test/modelCallAccounting.test.ts
import assert from "node:assert/strict";
import { recordLlmCall, getRecentLlmCalls } from "../src/llm";
import { accountModelCalls, applyZeroModelExpectation, summarizeLabels, MODEL_HELP_RUNG } from "../src/replayModelAccounting";
import { scoreReplayOutcome, summarizeReliability } from "../src/replayBenchmark";
import type { ReplayScore } from "../src/replayBenchmark";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------
// The window. Synthetic epoch stamps far in the past — no real call in this process
// can collide with them, and the arithmetic is exact.
// ---------------------------------------------------------------------------
recordLlmCall({ at: 1_000, label: "beforeWindow", ms: 500, inTok: 100, outTok: 10 });
const WINDOW_START = 2_000; // the benchmark's Date.now() snapshot, taken before the attempt
recordLlmCall({ at: 3_000, label: "portalFieldPlan", ms: 1_200, inTok: 900, outTok: 150 });
recordLlmCall({ at: 4_000, label: "portalFieldPlan", ms: 800, inTok: 700, outTok: 50 });

check("the window sees exactly the calls made inside it, with their labels", () => {
  const acct = accountModelCalls(getRecentLlmCalls(WINDOW_START));
  assert.equal(acct.modelCalls, 2);
  assert.deepEqual(acct.labels, ["portalFieldPlan", "portalFieldPlan"]);
  assert.deepEqual(acct.modelTokens, { in: 1_600, out: 200 });
  assert.equal(acct.modelMs, 2_000);
});

check("a call recorded BEFORE the snapshot is not billed to the attempt", () => {
  const acct = accountModelCalls(getRecentLlmCalls(WINDOW_START));
  assert.ok(!acct.labels.includes("beforeWindow"),
    "the previous attempt's call leaked into this attempt's bill");
});

check("KILL-TEST: break the snapshot boundary and the before-call bleeds in", () => {
  // What the exactly-2 assertion above is standing on. A window with no floor is the
  // broken form of this accounting — and it visibly counts THREE calls, beforeWindow
  // included. If the boundary in getRecentLlmCalls (`at >= since`) is ever loosened,
  // the first check goes red for the same reason this one goes green.
  const acct = accountModelCalls(getRecentLlmCalls(0));
  assert.equal(acct.modelCalls, 3);
  assert.ok(acct.labels.includes("beforeWindow"));
});

check("a call stamped AT the snapshot millisecond belongs to the attempt", () => {
  // llm.ts stamps `at` at call START and the benchmark snapshots before the adapter is
  // invoked, so a call the attempt starts in that same millisecond is the attempt's —
  // the boundary is >=, not >. Recorded here, AFTER the exact-count checks above ran.
  recordLlmCall({ at: 2_000, label: "atBoundary", ms: 1 });
  const acct = accountModelCalls(getRecentLlmCalls(WINDOW_START));
  assert.ok(acct.labels.includes("atBoundary"));
});

check("a FAILED call still counts — it was made and paid for in latency", () => {
  // instrument() records errored calls with no usage fields at all.
  const acct = accountModelCalls([{ label: "portalFieldPlan", ms: 1_455 }]);
  assert.equal(acct.modelCalls, 1);
  assert.deepEqual(acct.modelTokens, { in: 0, out: 0 });
  assert.equal(acct.modelMs, 1_455);
});

// ---------------------------------------------------------------------------
// The classification. One call flips the outcome; nothing is ever hard-failed.
// ---------------------------------------------------------------------------
const CLEAN: ReplayScore = scoreReplayOutcome({
  ok: true, executed: 79, recorded: 79, reviewFieldsSeen: 22, reviewFieldsConfirmed: 4, reviewMismatches: [],
});
assert.equal(CLEAN.rung, "verified_accurate"); // the fixture is what it claims to be
const ONE_CALL = accountModelCalls([{ label: "portalFieldPlan", ms: 1_200, inTok: 900, outTok: 150 }]);
const NO_CALLS = accountModelCalls([]);

check("ZERO model calls under --expect-zero-model: the verified score stands", () => {
  const s = applyZeroModelExpectation(CLEAN, NO_CALLS, true);
  assert.equal(s.rung, "verified_accurate");
  assert.equal(s.index, 5);
});

check("THE FLIP: ONE model call keeps a clean run off the clean rungs", () => {
  const s = applyZeroModelExpectation(CLEAN, ONE_CALL, true);
  assert.equal(s.rung, MODEL_HELP_RUNG, "replayed_with_model_help is NOT replayed_clean");
  assert.ok(s.index < 4, "reliability counts clean as index >= 4 — a paid replay must sit below it");
  assert.equal(s.owner, "recipe", "who can act: whoever extends the recipe to cover the paid fields");
  assert.match(s.reason, /portalFieldPlan/, "the operator must see WHICH operation needed paid help");
});

check("...and the run is still MEASURED — the flag measures, it does not forbid", () => {
  const s = applyZeroModelExpectation(CLEAN, ONE_CALL, true);
  assert.notEqual(s.measured, false);
});

check("flag OFF: the same call is reported but moves nothing", () => {
  const s = applyZeroModelExpectation(CLEAN, ONE_CALL, false);
  assert.equal(s.rung, "verified_accurate");
  assert.equal(s.index, 5);
});

check("a run that already failed keeps its failure rung — the abort is the headline", () => {
  const failed = scoreReplayOutcome({ ok: false, executed: 41, recorded: 79, message: "Recipe step failed (click): selector unresolved" });
  const s = applyZeroModelExpectation(failed, ONE_CALL, true);
  assert.equal(s.rung, "steps_failed", "re-labelling a failure as model-help would hide the drift");
  assert.match(s.reason, /model call/, "but the bill is still on the reason");
});

check("the reliability table does not count a model-helped replay as clean", () => {
  // The integration meaning of the flip: summarizeReliability keys clean on index >= 4,
  // so the demotion must actually reach it.
  const helped = applyZeroModelExpectation(CLEAN, ONE_CALL, true);
  const rel = summarizeReliability([{ portal: "p", profileKey: "k", score: helped as ReplayScore }]);
  assert.equal(rel[0].clean, 0);
  assert.equal(rel[0].issues[0]?.rung, MODEL_HELP_RUNG);
});

check("labels fold to counts, so a chatty planner reads as one operation", () => {
  assert.equal(summarizeLabels(["portalFieldPlan", "portalFieldPlan", "verifyPortalFillVision"]),
    "portalFieldPlan x2, verifyPortalFillVision");
});

if (failures) { console.error(`\n${failures} model-call accounting check(s) FAILED.`); process.exit(1); }
console.log("\nAll model-call accounting checks passed.");
process.exit(0);
