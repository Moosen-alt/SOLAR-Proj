// A READY-TO-STAGE PROJECT WHOSE GATE SAYS "can stage" OPENS ON SUBMIT, NOT A PADLOCK.
//
// Operator 2026-09-28 (Durwood): the Submit Gate read "0 blockers … can stage" while the stepper
// showed Submit locked "Not reached" — "Stage isn't even unlocked tho see". The server maps
// ready_to_stage to Build & Validate (it is also written before the reviewer gate passes, and
// QC's qcMayMoveStatus reads that map), so the step forward is the dashboard's, display only:
// dashboard stepperStageIndex, lifted from frontend/dashboard.js.
//
//   npx tsx backend/test/stepperStage.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ok  ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${(e as Error).message}`); }
}

const dashboard = fs.readFileSync(path.join(import.meta.dirname, "../../frontend/dashboard.js"), "utf8");
const start = dashboard.indexOf("function stepperStageIndex(");
assert.ok(start >= 0, "stepperStageIndex not found in dashboard.js");
const end = dashboard.indexOf("\n}\n", start);
const sandbox: Record<string, unknown> = {};
vm.runInNewContext(`${dashboard.slice(start, end + 2)}\nthis.stepperStageIndex = stepperStageIndex;`, sandbox);
type Detail = { stageIndex: number; project: { id: string; status: string } };
type Gate = { projectId: string; canPrepareSubmission: boolean } | null;
const stepperStageIndex = sandbox.stepperStageIndex as (d: Detail, g: Gate) => number;

const detail = (status: string, stageIndex: number): Detail => ({ stageIndex, project: { id: "p1", status } });
const gate = (canPrepareSubmission: boolean, projectId = "p1"): Gate => ({ projectId, canPrepareSubmission });

check("MUST PASS: ready_to_stage + this project's gate says can stage -> Submit (2) is current", () => {
  assert.equal(stepperStageIndex(detail("ready_to_stage", 1), gate(true)), 2);
});
check("MUST-EXCLUDE: ready_to_stage + a gate that says do not stage stays on Build & Validate", () => {
  assert.equal(stepperStageIndex(detail("ready_to_stage", 1), gate(false)), 1);
});
check("MUST-EXCLUDE: no gate loaded yet stays on Build & Validate", () => {
  assert.equal(stepperStageIndex(detail("ready_to_stage", 1), null), 1);
});
check("MUST-EXCLUDE: another project's gate (a stale load) never moves this stepper", () => {
  assert.equal(stepperStageIndex(detail("ready_to_stage", 1), gate(true, "p2")), 1);
});
check("MUST-EXCLUDE: qc_passed (docs not built) stays on Build & Validate even if a gate says can stage", () => {
  assert.equal(stepperStageIndex(detail("qc_passed", 1), gate(true)), 1);
});
check("later stages are the server's: awaiting_human_submit 2, submitted 3, handoff_ready 4", () => {
  assert.equal(stepperStageIndex(detail("awaiting_human_submit", 2), gate(true)), 2);
  assert.equal(stepperStageIndex(detail("submitted", 3), gate(true)), 3);
  assert.equal(stepperStageIndex(detail("handoff_ready", 4), gate(false)), 4);
});
check("earlier stages are the server's: parsed/qc_failed 0", () => {
  assert.equal(stepperStageIndex(detail("qc_failed", 0), gate(true)), 0);
});
check("wiring: applyStageState opens the stage stepperStageIndex answers, with the loaded gate", () => {
  const a = dashboard.indexOf("function applyStageState(");
  const body = dashboard.slice(a, dashboard.indexOf("\n}\n", a));
  assert.match(body, /const active = stepperStageIndex\(d, state\.submitGate\);/);
});

console.log(failed ? `\nstepperStage: ${failed} FAILED` : "\nstepperStage: all checks passed");
process.exit(failed ? 1 : 0);
