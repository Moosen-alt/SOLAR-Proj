// THE RATE CARD IS ARITHMETIC, AND ARITHMETIC GETS PINNED.
//
// Operator + Mark 2026-09-29: $100 per permit, $50 per interconnection, $75 for an interconnection
// filed on its own, never more than $200 a project — for the project's LIFETIME, not per month;
// duplicate capture rows of one filing bill once; corrections are $0; a founding rate or a volume
// tier scales every line. scripts/billing/rateCard.ts is the one place that knows this.
//
//   npx tsx backend/test/billingRateCard.test.ts
import assert from "node:assert/strict";
import { LIST_RATE_CARD, dedupeFilings, monthBounds, monthLines, priceProject, type Filing } from "../../scripts/billing/rateCard";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ok  ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${(e as Error).message}`); }
}
const f = (projectId: string, kind: "permit" | "interconnection", permitType: string, number: string, submittedAt: string): Filing =>
  ({ projectId, kind, permitType, number, submittedAt, note: "" });
const billed = (lines: Array<{ billedUsd: number }>): number[] => lines.map((l) => l.billedUsd);

check("the normal job: building + electrical + interconnection = 100 + 100 + 0 (cap 200)", () => {
  const lines = priceProject([f("p", "permit", "building", "B-1", "2026-09-02"), f("p", "permit", "electrical", "E-1", "2026-09-02"), f("p", "interconnection", "", "NEM-1", "2026-09-03")], LIST_RATE_CARD);
  assert.deepEqual(billed(lines), [100, 100, 0]);
  assert.equal(lines[2].listUsd, 50, "the IA's list price is the bundled $50");
  assert.equal(lines[2].runningUsd, 200);
});
check("combo permit + interconnection = 150", () => {
  assert.deepEqual(billed(priceProject([f("p", "permit", "combo", "C-1", "2026-09-02"), f("p", "interconnection", "", "NEM-1", "2026-09-03")], LIST_RATE_CARD)), [100, 50]);
});
check("interconnection on its own = 75 (the hardest filing, not a discount)", () => {
  assert.deepEqual(billed(priceProject([f("p", "interconnection", "", "NEM-1", "2026-09-03")], LIST_RATE_CARD)), [75]);
});
check("MUST-EXCLUDE: the cap is per project for its LIFETIME — permits in September, the IA in October adds 0", () => {
  const all = [f("p", "permit", "building", "B-1", "2026-09-02T10:00:00Z"), f("p", "permit", "electrical", "E-1", "2026-09-02T11:00:00Z"), f("p", "interconnection", "", "NEM-1", "2026-10-03T10:00:00Z")];
  const sep = monthBounds("2026-09");
  const oct = monthBounds("2026-10");
  assert.deepEqual(billed(monthLines(all, LIST_RATE_CARD, sep.start, sep.end)), [100, 100]);
  assert.deepEqual(billed(monthLines(all, LIST_RATE_CARD, oct.start, oct.end)), [0], "October's line is on the statement at $0, so the client sees the filing under the cap");
});
check("the IA rate is decided by the whole project: a permit filed LATER still makes September's IA the bundled 50, not 75", () => {
  const all = [f("p", "interconnection", "", "NEM-1", "2026-09-03T10:00:00Z"), f("p", "permit", "combo", "C-1", "2026-10-01T10:00:00Z")];
  const sep = monthBounds("2026-09");
  assert.deepEqual(billed(monthLines(all, LIST_RATE_CARD, sep.start, sep.end)), [50]);
});
check("MUST-EXCLUDE: two capture rows of one filing (same type + number) bill ONCE, on the earliest capture", () => {
  const rows = [f("p", "interconnection", "", "PGENM-1", "2026-09-28T22:57:24Z"), f("p", "interconnection", "", "pgenm-1", "2026-09-28T22:57:24Z"), f("p", "interconnection", "", "PGENM-1", "2026-09-28T23:10:00Z")];
  assert.equal(dedupeFilings(rows).length, 1);
  assert.deepEqual(billed(priceProject(rows, LIST_RATE_CARD)), [75]);
});
check("different numbers are different filings; a row with no number is its own filing", () => {
  assert.equal(dedupeFilings([f("p", "permit", "building", "B-1", "2026-09-02"), f("p", "permit", "building", "B-2", "2026-09-02"), f("p", "permit", "electrical", "", "2026-09-02")]).length, 3);
});
check("a founding rate scales every line and the cap (x0.75: 75 + 75 + 0, cap 150)", () => {
  const card = { ...LIST_RATE_CARD, multiplier: 0.75 };
  const lines = priceProject([f("p", "permit", "building", "B-1", "2026-09-02"), f("p", "permit", "electrical", "E-1", "2026-09-02"), f("p", "interconnection", "", "NEM-1", "2026-09-03")], card);
  assert.deepEqual(billed(lines), [75, 75, 0]);
  assert.equal(lines[2].runningUsd, 150);
});
check("an MPU filed as its own permit is a permit line, under the same cap", () => {
  assert.deepEqual(billed(priceProject([f("p", "permit", "building", "B-1", "2026-09-02"), f("p", "permit", "electrical", "E-1", "2026-09-02"), f("p", "permit", "mpu", "M-1", "2026-09-02")], LIST_RATE_CARD)), [100, 100, 0]);
});
check("projects are priced independently (one project's cap never touches another)", () => {
  const all = [f("a", "permit", "building", "B-1", "2026-09-02"), f("a", "permit", "electrical", "E-1", "2026-09-02"), f("b", "permit", "combo", "C-1", "2026-09-05"), f("b", "interconnection", "", "NEM-2", "2026-09-06")];
  const sep = monthBounds("2026-09");
  assert.equal(monthLines(all, LIST_RATE_CARD, sep.start, sep.end).reduce((s, l) => s + l.billedUsd, 0), 350);
});
check("monthBounds is UTC and half-open", () => {
  const { start, end } = monthBounds("2026-09");
  assert.equal(start, "2026-09-01T00:00:00.000Z");
  assert.equal(end, "2026-10-01T00:00:00.000Z");
  assert.throws(() => monthBounds("Sept 2026"));
});

console.log(failed ? `\nbillingRateCard: ${failed} FAILED` : "\nbillingRateCard: all checks passed");
process.exit(failed ? 1 : 0);
