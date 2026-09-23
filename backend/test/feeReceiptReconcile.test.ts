// L5: paid receipts are held up against the seeded fee schedules — read-only — and a
// disagreement becomes ONE deduped operator review item, never a schedule change (rule 3).
//
// Shapes are the production ones (read from the live DB, amounts only):
//   · Tigard: electrical $133.56 + structural $180.00 + 12% OR surcharge = the $351.19 receipt
//     the parser labels "electrical". Neither schedule holds the surcharge -> both SHORT.
//   · Salem: $94 × 1.12 + $5 processing = $110.28. ($94 + $5) × 1.12 = $110.88 is NOT a bill.
//   · "Lincoln County" scores 65 against "City of Lincoln City" — over the fuzzy bar — and must
//     not be read as that city's receipt.
// Run: tsx backend/test/feeReceiptReconcile.test.ts
import "./_isolate";
import assert from "node:assert/strict";

process.env.SEED_TEST_INSTALLER = "false";
process.env.ANTHROPIC_API_KEY = "";
process.env.FEE_RESEARCH = "off";

const { openDatabase } = await import("../src/db");
const { recordPaidFeeReceipt } = await import("../src/feeReceipts");
const { createProject, isCriticalReviewItem } = await import("../src/repository");
const fees = await import("../src/feeSchedules");
const { reconcileReceiptsWithSchedules, raiseReceiptContradictionReviews, feeScheduleProfileKey, RECEIPT_REVIEW_ISSUE_TYPE, MISSING_OR_SURCHARGE_CAUSE } = fees;
import type { PaidFeeReceipt } from "../../shared/src/types";

const db = await openDatabase();
let failures = 0;
const run = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const tick = () => new Promise((r) => setTimeout(r, 100));

let seq = 0;
function schedule(ahj: string, discipline: string, basis: string, brackets: unknown[], extra: { status?: string } = {}): string {
  const key = feeScheduleProfileKey({ state: "OR", ahj }, "permit");
  const ts = new Date().toISOString();
  db.run(
    `INSERT INTO fee_schedules (id, profile_key, state, ahj, utility, track, basis, brackets_json, notes, source_url, source_quote,
       source_kind, confidence, first_seen_at, updated_at, verified_at, verified_by, payment_method, discipline, collected_by_profile_key,
       status, document_date, candidates_json)
     VALUES (?, ?, 'OR', ?, '', 'permit', ?, ?, '', 'https://example.gov/fees', '', 'official', 'seeded', ?, ?, '', '', '', ?, '', ?, '', '[]')`,
    [`fs-${++seq}`, key, ahj, basis, JSON.stringify(brackets), ts, ts, discipline, extra.status ?? "ok"],
  );
  return key;
}
function receipt(jurisdiction: string, amount: number, discipline: PaidFeeReceipt["discipline"] = "electrical"): PaidFeeReceipt {
  return {
    jurisdiction, permitNumber: `PERMNUM-${++seq}`, receiptNumber: `RCPTNUM${1000 + seq}`, discipline,
    authorityAmountUsd: amount, processingFeeUsd: 0, totalPaidUsd: amount, paidAt: "April 24, 2026",
  };
}
const processing5 = { label: "Processing fee", kind: "processing", amountUsd: 5, percentOf: "", conditional: false, condition: "", appliesTo: "", quote: "", sourceUrl: "https://example.gov/fees", matchedLine: "Processing fee $5.00" };
const surcharge12 = { label: "State surcharge (12% of permit fee)", kind: "surcharge", percent: 12, percentOf: "of permit fee", conditional: false, condition: "", appliesTo: "", quote: "", sourceUrl: "https://example.gov/fees", matchedLine: "State surcharge 12%" };

// --- schedules (production shapes) ---------------------------------------------------------
const tigard = "City of Testigard";
const tigardKey = schedule(tigard, "electrical", "system_kw", [
  { minKw: 0, maxKw: 5, feeUsd: 100.7, label: "5 kva or less" },
  { minKw: 5.01, maxKw: 15, feeUsd: 133.56, label: "5.01 to 15 kva" },
]);
schedule(tigard, "structural", "flat", [{ feeUsd: 180, label: "PV Plan Review & Admin Fees" }]);
const salemKey = schedule("City of Testsalem", "", "system_kw", [
  { minKw: 0, maxKw: 5, feeUsd: 79, label: "5 kVA or less", ancillaryCharges: [processing5] },
  { minKw: 5.01, maxKw: 15, feeUsd: 94, label: "5.01 to 15 kVA", ancillaryCharges: [processing5] },
]);
// Same table, but the only receipt is the WRONG order of operations: ($94 + $5) × 1.12.
schedule("City of Orderville", "", "system_kw", [{ minKw: 5.01, maxKw: 15, feeUsd: 94, label: "5.01 to 15 kVA", ancillaryCharges: [processing5] }]);
// Holds the 12% itself: base × 1.12 is a plain corroboration.
const heldKey = schedule("City of Heldsurch", "", "flat", [{ feeUsd: 200, label: "Solar permit", ancillaryCharges: [surcharge12] }]);
const lincolnKey = schedule("City of Lincoln City", "", "other", [{ feeUsd: 250, label: "Solar Permit — Prescriptive Path", ancillaryCharges: [surcharge12] }]);
// Douglas shape: a combo row AND an undifferentiated row with identical brackets. Adding them
// (2 × $79 × 1.12 = $176.96) would double-count one permit.
const douglasKey = schedule("Testdouglas County", "combo", "system_kw", [{ minKw: 0, maxKw: 5, feeUsd: 79, label: "5 KVA or less", ancillaryCharges: [surcharge12] }]);
schedule("Testdouglas County", "", "system_kw", [{ minKw: 0, maxKw: 5, feeUsd: 79, label: "5 KVA or less", ancillaryCharges: [surcharge12] }]);
// A conflicted row prices nothing and is not compared.
schedule("City of Conflictton", "", "flat", [{ feeUsd: 50, label: "Solar permit" }], { status: "conflicted" });

// --- receipts, through the real write path --------------------------------------------------
const tigardProject = createProject(db, { owner: "Receipt Test", address: "1 Test Way", city: "Testigard", state: "OR", zip: "97223", ahj: tigard, utility: "PGE", dcKw: "8", valuation: "20000" }).project;
const tigardReceipt = receipt(tigard, 351.19);
// Salem's and the others' receipts carry no project, as the imported production ones do.
for (const [j, amt, d] of [
  ["City of Testsalem", 110.28, "electrical"], ["City of Testsalem", 46.21, "building"],
  ["City of Orderville", 110.88, "electrical"],
  ["City of Heldsurch", 224, "unknown"],
  ["Lincoln City", 172.5, "electrical"], ["Lincoln County", 280, "electrical"],
  ["Testdouglas County", 176.96, "electrical"],
  ["City of Conflictton", 50, "building"],
] as const) recordPaidFeeReceipt(db, receipt(j, amt, d), null);

const schedulesBefore = JSON.stringify(db.query("SELECT * FROM fee_schedules ORDER BY id"));
const reviewsBefore = db.get<{ n: number }>("SELECT COUNT(*) n FROM human_review_items")!.n;
const report = reconcileReceiptsWithSchedules(db);
const verdictOf = (key: string, discipline = "") => report.results.find((r) => r.profileKey === key && r.discipline === discipline);

await run("Tigard: combined electrical + structural + 12% explains the 'electrical' receipt; both schedules are SHORT", () => {
  // The one receipt WITH a project is recorded here, after the snapshot above, so the hook test
  // below can attribute exactly one review item to it.
  const r = recordPaidFeeReceipt(db, tigardReceipt, tigardProject.id);
  assert.equal(r.recorded, true);
  const again = reconcileReceiptsWithSchedules(db);
  for (const disc of ["electrical", "structural"]) {
    const v = again.results.find((x) => x.profileKey === tigardKey && x.discipline === disc);
    assert.ok(v, `no result for tigard ${disc}`);
    assert.equal(v.verdict, "corroborated_missing_surcharge", `${disc}: ${v.verdict}`);
    assert.equal(v.likelyCause, MISSING_OR_SURCHARGE_CAUSE);
    assert.match(v.receipts[0].explainedBy, /133\.56.*180\.00.*12% OR state surcharge/);
  }
});

await run("Salem: surcharge on the permit line THEN the flat processing fee ($110.28) — SHORT, not contradicted", () => {
  const v = verdictOf(salemKey)!;
  assert.equal(v.verdict, "corroborated_missing_surcharge");
  const hit = v.receipts.find((x) => x.authorityAmountUsd === 110.28)!;
  assert.match(hit.explainedBy, /\$94\.00 \+ 12% OR state surcharge.*\+ \$5\.00 processing/);
  assert.equal(v.receipts.find((x) => x.authorityAmountUsd === 46.21)!.explainedBy, "", "the building receipt is not explained by an electrical table");
});

await run("order of operations: ($94 + $5) × 1.12 = $110.88 is not a total the schedule produces", () => {
  const v = verdictOf(feeScheduleProfileKey({ state: "OR", ahj: "City of Orderville" }, "permit"))!;
  assert.equal(v.verdict, "contradicted");
});

await run("a schedule that holds the 12% itself is plainly corroborated by base × 1.12", () => {
  assert.equal(verdictOf(heldKey)!.verdict, "corroborated");
});

await run("Lincoln City: mustPass its own receipt (contradicted), mustExclude the Lincoln County receipt", () => {
  const v = verdictOf(lincolnKey)!;
  assert.ok(v, "the Lincoln City receipt must reach the City of Lincoln City schedule");
  assert.deepEqual(v.receipts.map((x) => x.jurisdiction), ["Lincoln City"], "a county receipt was read as the city's");
  assert.equal(v.verdict, "contradicted");
  // $280 = $250 × 1.12 WOULD have corroborated it had the county receipt been admitted.
});

await run("a combo row is never added to an undifferentiated row (no double count)", () => {
  assert.equal(verdictOf(douglasKey, "combo")!.verdict, "contradicted");
  assert.equal(verdictOf(douglasKey, "")!.verdict, "contradicted");
});

await run("denominators: conflicted row skipped, unscheduled receipts counted", () => {
  assert.equal(report.schedulesSkipped, 1);
  assert.equal(report.receiptsWithoutSchedule, 2, "Lincoln County + Conflictton (its only schedule is conflicted)");
  assert.equal(report.receiptsRead, 8);
});

await run("reconcile is READ-ONLY: no schedule or review row changes", () => {
  assert.equal(JSON.stringify(db.query("SELECT * FROM fee_schedules ORDER BY id")), schedulesBefore);
  reconcileReceiptsWithSchedules(db);
  // Only the hook (which fired on the Tigard receipt) may have raised anything so far.
  const raisedByHook = db.query("SELECT field_name FROM human_review_items WHERE issue_type = ?", [RECEIPT_REVIEW_ISSUE_TYPE]).length;
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) n FROM human_review_items")!.n, reviewsBefore + raisedByHook);
});

await run("recording a receipt raises the review item for its jurisdiction (hook)", async () => {
  await tick();
  const items = db.query<{ project_id: string; field_name: string; notes: string }>(
    "SELECT project_id, field_name, notes FROM human_review_items WHERE issue_type = ?", [RECEIPT_REVIEW_ISSUE_TYPE]);
  assert.equal(items.length, 1, JSON.stringify(items.map((i) => i.field_name)));
  assert.equal(items[0].field_name, `fee_schedule:${tigardKey}`);
  assert.equal(items[0].project_id, tigardProject.id);
});

await run("the item is ADVISORY: it never holds the anchoring project's submission", () => {
  const item = db.get<{ status: string; field_name: string; issue_type: string }>(
    "SELECT status, field_name, issue_type FROM human_review_items WHERE issue_type = ?", [RECEIPT_REVIEW_ISSUE_TYPE])!;
  assert.equal(item.status, "pending");
  assert.equal(isCriticalReviewItem({ status: item.status, fieldName: item.field_name, issueType: item.issue_type }), false,
    "a shared-schedule disagreement would block this project's staging gate");
});

await run("raise: ONE item per key, deduped, amounts only (no receipt/permit numbers), anchored or no_anchor", () => {
  const first = raiseReceiptContradictionReviews(db, reconcileReceiptsWithSchedules(db));
  const second = raiseReceiptContradictionReviews(db, reconcileReceiptsWithSchedules(db));
  assert.equal(first.find((o) => o.profileKey === tigardKey)!.action, "unchanged", "the hook already raised it");
  assert.equal(first.find((o) => o.profileKey === salemKey)!.action, "no_anchor", "a project-less receipt has nowhere to land");
  assert.ok(!first.some((o) => o.profileKey === heldKey), "a corroborated schedule raises nothing");
  assert.ok(second.every((o) => o.action === "unchanged" || o.action === "no_anchor"));
  const items = db.query<{ notes: string }>("SELECT notes FROM human_review_items WHERE issue_type = ?", [RECEIPT_REVIEW_ISSUE_TYPE]);
  assert.equal(items.length, 1);
  assert.match(items[0].notes, /\$351\.19/);
  assert.match(items[0].notes, new RegExp(tigardKey.replace(/[|]/g, "\\|")));
  assert.doesNotMatch(items[0].notes, /PERMNUM|RCPTNUM/);
  // No schedule was touched by any of it.
  assert.equal(JSON.stringify(db.query("SELECT * FROM fee_schedules ORDER BY id")), schedulesBefore);
});

await run("raise: new evidence updates the pending item instead of adding a second one", () => {
  recordPaidFeeReceipt(db, receipt(tigard, 999.99), tigardProject.id);
  const outcome = raiseReceiptContradictionReviews(db, reconcileReceiptsWithSchedules(db)).find((o) => o.profileKey === tigardKey)!;
  assert.equal(outcome.action === "updated" || outcome.action === "unchanged", true, outcome.action);
  assert.equal(db.query("SELECT id FROM human_review_items WHERE issue_type = ?", [RECEIPT_REVIEW_ISSUE_TYPE]).length, 1);
});

db.close();
console.log(failures ? `\n${failures} FAILED` : "\nall fee-receipt reconciliation tests passed");
process.exit(failures ? 1 : 0);
