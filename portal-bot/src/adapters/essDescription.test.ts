// THE OREGON ACCELA DESCRIPTION OF WORK ASKS THE ONE BATTERY QUESTION (#246). It printed
// "Battery / ESS scope includes N/A." for any non-empty battery model, so a PV-only filing told the
// AHJ it had storage. It now gates on the shared batteryStatus() / isPlaceholderBatteryModel().
// Synthetic project data only.
//
// KILL TEST: gate the sentence on `batteryModel || essKwh` again → the MUST-EXCLUDE fails.
//
// Run: npx tsx portal-bot/src/adapters/essDescription.test.ts
import assert from "node:assert/strict";
import type { ProjectRecord } from "../../../shared/src/types";
import { buildDescriptionOfWork } from "./oregonEPermitting";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const project = (snap: Record<string, unknown>): ProjectRecord => ({
  id: "ess-desc", systemSizeDcKw: 6, systemSizeAcKw: 5,
  parserSnapshot: { moduleQuantity: "12", moduleModel: "EX-400", ...snap },
}) as unknown as ProjectRecord;

check("MUST-EXCLUDE: a placeholder battery model never reaches the description of work", () => {
  for (const model of ["N/A", "None", "No ESS", "Not included", "-"]) {
    const text = buildDescriptionOfWork(project({ batteryModel: model, hasBattery: "No" }));
    assert.doesNotMatch(text, /Battery|ESS/, `"${model}": ${text}`);
  }
});
check("MUST-PASS: a real battery model is described; a real model outranks a bare hasBattery 'No'", () => {
  assert.match(buildDescriptionOfWork(project({ batteryModel: "EX-13", batteryQuantity: "1", hasBattery: "Yes" })), /Battery \/ ESS scope includes 1 EX-13\./);
  assert.match(buildDescriptionOfWork(project({ batteryModel: "EX-13", hasBattery: "No" })), /Battery \/ ESS scope includes EX-13\./);
});
check("MUST-PASS: a battery with a placeholder model but a quantity is still described, without the placeholder", () => {
  const text = buildDescriptionOfWork(project({ batteryModel: "N/A", batteryQuantity: "2" }));
  assert.match(text, /Battery \/ ESS scope includes 2/);
  assert.doesNotMatch(text, /N\/A/);
});

if (failures) { console.error(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log("\nAll ESS description checks passed.");
process.exit(0);
