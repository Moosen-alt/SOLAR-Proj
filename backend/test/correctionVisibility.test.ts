// A SUSPENDED FILING HAS TO LOOK SUSPENDED.
//
// PacifiCorp suspended Finley Mockdata' interconnection (APP-111681) the morning after it was
// filed, with ten business days to answer before the request may be withdrawn. The project
// moved to correction_triaged — and the dashboard board card showed nothing. No chip, no
// overlay. isBlockedStatus was `status === "blocked"` and nothing else, so the most urgent
// state in the system rendered identically to a project ticking along normally.
//
// This pins the display signal, and pins that it stays a DISPLAY signal: isBlocked feeds the
// board chip and the stage overlay only. Widening it must not move a project's stage, and
// must not start reporting healthy projects as needing a person.
//
// Browser-free. Run: tsx backend/test/correctionVisibility.test.ts
import assert from "node:assert/strict";
import { isBlockedStatus, stageForStatus } from "../src/projectStage";
import type { ProjectStatus } from "../../shared/src/types";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

check("THE REGRESSION: a triaged correction reads as needing a human", () => {
  assert.equal(isBlockedStatus("correction_triaged"), true);
});

check("...and so does one that has only just arrived", () => {
  assert.equal(isBlockedStatus("correction_received"), true);
});

check("the explicit blocked status still reads as blocked", () => {
  assert.equal(isBlockedStatus("blocked"), true);
});

// The whole point is that it discriminates. A signal that fires on everything is no signal.
const healthy: ProjectStatus[] = [
  "parsed",
  "qc_passed",
  "ready_to_stage",
  "awaiting_human_submit",
  "submitted",
  "ready_for_issue",
  "issued",
  "approved",
  "nem_approved",
  "handoff_ready",
];
for (const status of healthy) {
  check(`no false alarm: ${status} is not flagged`, () => {
    assert.equal(isBlockedStatus(status), false);
  });
}

check("it stays a DISPLAY signal — a correction keeps its real stage, it is not moved", () => {
  // `blocked` is the one status with no lifecycle position of its own (it falls back to qc).
  // A correction DOES have one: it belongs to Submit, where the fix and resubmit happen.
  // If widening the blocked flag had moved it, the corrections card would render inside a
  // locked accordion and become unreachable — the opposite of calling it out.
  assert.equal(stageForStatus("correction_triaged").key, "submit");
  assert.equal(stageForStatus("correction_received").key, "submit");
});

check("the corrections stage is the one the operator is already looking at", () => {
  // Submit is stage index 2 (index 3 before the 6→5 stage collapse of 2026-09-19 removed
  // the always-already-complete Intake stage) — rendered as the ACTIVE accordion for these
  // statuses, so the correction text, bucket and required action are on screen without a click.
  assert.equal(stageForStatus("correction_triaged").index, 2);
});

if (failures) { console.error(`\n${failures} correction-visibility check(s) FAILED.`); process.exit(1); }
console.log("\nAll correction-visibility checks passed.");
process.exit(0);
