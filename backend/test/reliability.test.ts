// WHAT "95% OF THE TIME IT WON'T HAVE AN ISSUE" ACTUALLY MEASURES.
//
// The fleet number reported earlier in this project was assembled from each recipe's BEST
// run across DIFFERENT builds -- a number no operator could ever experience, because no
// single build ever behaved that way. The correction is not a better average. It is a
// different question: one build, one portal, repeated trials, k of N.
//
// These are the properties of that arithmetic that can silently rot.
//   npx tsx backend/test/reliability.test.ts
import assert from "node:assert/strict";
import { summarizeReliability, type ReplayRow } from "../src/replayBenchmark";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const row = (key: string, index: number, rung: string, owner: string): ReplayRow =>
  ({ portal: key, profileKey: key, score: { rung, index, owner, reason: "" } } as unknown as ReplayRow);

// ---------------------------------------------------------------------------
check("k-of-N is per portal, not pooled across the fleet", () => {
  const rel = summarizeReliability([
    row("a", 5, "verified_accurate", "none"), row("a", 4, "replayed_clean", "none"),
    row("b", 2, "steps_failed", "recipe"), row("b", 2, "steps_failed", "recipe"),
  ]);
  const a = rel.find((r) => r.profileKey === "a");
  const b = rel.find((r) => r.profileKey === "b");
  assert.equal(a?.clean, 2); assert.equal(a?.pct, 100);
  assert.equal(b?.clean, 0); assert.equal(b?.pct, 0);
});

check("rung 4 and rung 5 both count as clean -- a staged filing is the bar, not a review screen", () => {
  const rel = summarizeReliability([row("a", 4, "replayed_clean", "none"), row("a", 5, "verified_accurate", "none")]);
  assert.equal(rel[0].clean, 2);
});

check("rung 3 does NOT count -- replayed_with_gaps is an issue the operator would feel", () => {
  const rel = summarizeReliability([row("a", 3, "replayed_with_gaps", "recipe"), row("a", 4, "replayed_clean", "none")]);
  assert.equal(rel[0].clean, 1);
  assert.equal(rel[0].pct, 50);
});

// THE ONE THAT WILL BE ARGUED WITH. A portal being down is not the recipe's fault, and the
// temptation is to exclude it so the number looks like a statement about our software. But
// the operator asked whether pointing the tool at a portal works, and a portal that is down
// is a portal you cannot file on today. It counts against the rate; the OWNER is what tells
// them it was not us.
check("a portal-owned failure still counts against the rate, but is named as portal-owned", () => {
  const rel = summarizeReliability([
    row("a", 4, "replayed_clean", "none"), row("a", 0, "unreachable", "portal"),
  ]);
  assert.equal(rel[0].pct, 50, "a portal outage was quietly excluded from the denominator");
  assert.deepEqual(rel[0].issues, [{ rung: "unreachable", owner: "portal", n: 1 }]);
});

check("issues are tallied by kind, so one flaky cause is not read as many", () => {
  const rel = summarizeReliability([
    row("a", 2, "steps_failed", "recipe"), row("a", 2, "steps_failed", "recipe"),
    row("a", 1, "login_failed", "credential"),
  ]);
  assert.deepEqual(rel[0].issues, [
    { rung: "steps_failed", owner: "recipe", n: 2 },
    { rung: "login_failed", owner: "credential", n: 1 },
  ], JSON.stringify(rel[0].issues));
});

// THE WHOLE POINT OF SORTING WORST-FIRST. An operator does not meet the fleet; they meet one
// portal. A 95% average over five portals is compatible with one portal failing every
// other run, and that portal is the one they will call about.
check("the worst portal sorts first, because a fleet average hides it", () => {
  const rel = summarizeReliability([
    row("good", 5, "verified_accurate", "none"), row("good", 5, "verified_accurate", "none"),
    row("bad", 2, "steps_failed", "recipe"), row("bad", 5, "verified_accurate", "none"),
  ]);
  assert.equal(rel[0].profileKey, "bad", `sorted best-first: ${rel.map((r) => r.profileKey).join(",")}`);
});

check("no rows is 0%, not a division by zero reported as NaN%", () => {
  assert.deepEqual(summarizeReliability([]), []);
});

if (failures) { console.error(`\n${failures} reliability check(s) FAILED.`); process.exit(1); }
console.log("\nAll reliability checks passed.");
