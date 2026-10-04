// A STATUS CHECK KNOWS ITS OWN LANE.
//
// permit_check_targets are typed "permit" | "nem", and every status check descends from one.
// But hasNemSignal/hasPermitSignal classified a check by the WORDS on the scraped page — a
// heuristic that predates typed targets — and it misfiled live data:
//
//   Placeholder's ISSUED ELECTRICAL permit page mentions "utility"  ->  read as a NEM check
//   -> the NEM lane showed "Permit issued" -> "issued" is in the NEM-approved outcome list
//   -> the dashboard badged TWO live interconnection applications "NEM approved"
//
// PacifiCorp still lists both as submitted / under engineering review. An operator reading
// that board would think the utility had signed off and move the job toward PTO.
//
// The target's type is authoritative. The text sniff survives only for legacy rows recorded
// before targets carried one.
// Browser/DB-free. Run: tsx backend/test/laneSignal.test.ts
import assert from "node:assert/strict";
import type { PermitStatusCheck } from "../../shared/src/types";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// The predicates as repository.ts applies them.
const hasNemSignal = (c: Partial<PermitStatusCheck>): boolean => {
  if (c.targetType) return c.targetType === "nem";
  return /\b(nem|net.?meter|interconnection|pto|permission to operate|utility|powerclerk|pge|pacific power|pacificorp)\b/i
    .test(`${c.statusLabel} ${c.rawStatusText} ${c.message}`);
};
const hasPermitSignal = (c: Partial<PermitStatusCheck>): boolean => {
  if (c.targetType) return c.targetType === "permit";
  return /\b(permit|ahj|jurisdiction|city|county|building|electrical|inspection|issued|ready to issue)\b/i
    .test(`${c.statusLabel} ${c.rawStatusText} ${c.message}`);
};

// The real page text from Placeholder's issued electrical permit — note "utility".
const ELECTRICAL_PERMIT: Partial<PermitStatusCheck> = {
  targetType: "permit",
  statusLabel: "Permit issued",
  outcome: "issued",
  rawStatusText: "Record 194-26-001482-ELEC: Residential Electrical. Record Status: Permit Issued. "
    + "Coos County. Utility notified. Expiration 03/01/2027.",
  message: "",
};

const NEM_APPLICATION: Partial<PermitStatusCheck> = {
  targetType: "nem",
  statusLabel: "In review",
  outcome: "waiting",
  rawStatusText: "View/Edit: APP-111667. Status marked as PP - Application Submitted on 9/2/2026.",
  message: "",
};

check("THE REGRESSION: an issued ELECTRICAL permit is never counted as a NEM check", () => {
  assert.equal(hasNemSignal(ELECTRICAL_PERMIT), false, "it belongs to the permit lane");
  assert.equal(hasPermitSignal(ELECTRICAL_PERMIT), true);
});

check("...and without the type, the old sniff really does misfile it — this is the bug", () => {
  const { targetType: _drop, ...untyped } = ELECTRICAL_PERMIT;
  assert.equal(hasNemSignal(untyped), true, "the word 'Utility' alone flipped the lane");
});

check("a real NEM check still lands in the NEM lane", () => {
  assert.equal(hasNemSignal(NEM_APPLICATION), true);
  assert.equal(hasPermitSignal(NEM_APPLICATION), false);
});

check("the two lanes are mutually exclusive for every typed check", () => {
  for (const c of [ELECTRICAL_PERMIT, NEM_APPLICATION]) {
    assert.notEqual(hasNemSignal(c), hasPermitSignal(c), JSON.stringify(c.targetType));
  }
});

check("a legacy row with no target type keeps the old text behaviour", () => {
  const legacy: Partial<PermitStatusCheck> = { statusLabel: "PTO granted", rawStatusText: "interconnection approved", message: "" };
  assert.equal(hasNemSignal(legacy), true);
});

// The consequence the lane fix protects: nemApproved reads the NEM lane's outcomes.
check("nemApproved cannot be reached by a permit check's 'issued' outcome", () => {
  const APPROVED_OUTCOMES = ["reviewed_by_ahj", "ready_for_issue", "issued", "nem_approved"];
  const checks = [ELECTRICAL_PERMIT, NEM_APPLICATION];
  const nemApproved = checks.filter(hasNemSignal).some((c) => APPROVED_OUTCOMES.includes(String(c.outcome)));
  assert.equal(nemApproved, false, "the only 'issued' here is a PERMIT, and the NEM is still in review");
});

if (failures) { console.error(`\n${failures} lane-signal check(s) FAILED.`); process.exit(1); }
console.log("\nAll lane-signal checks passed.");
process.exit(0);
