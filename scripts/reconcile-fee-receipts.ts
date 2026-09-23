// PAID RECEIPTS AGAINST THE SEEDED FEE SCHEDULES (L5).
//
//   npx tsx scripts/reconcile-fee-receipts.ts [--db <path>] [--apply]
//
// Dry run (default) opens the database READ-ONLY — no migration, no write — and prints, per fee
// schedule that has receipts at its jurisdiction, whether those receipts corroborate it, need the
// 12% Oregon state surcharge the schedule does not hold, or contradict it outright.
//
// --apply OPENS THE DATABASE THROUGH openDatabase(), WHICH RUNS PENDING MIGRATIONS (v33 llm_calls
// included) before anything else — pointed at production, it moves the schema ahead of the server.
// It then raises ONE deduped operator review item per disagreeing schedule key
// (raiseReceiptContradictionReviews). It NEVER changes a schedule (hard rule 3); a person does
// that from the fee sheet. Receipt and permit numbers are never printed or stored in the note.
import "dotenv/config";
import Database from "better-sqlite3";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const dbArg = argv.indexOf("--db") >= 0 ? argv[argv.indexOf("--db") + 1] : "";
const dbPath = dbArg || process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";
process.env.AUTOPILOT_DB_PATH = dbPath;

const { AppDb, openDatabase } = await import("../backend/src/db");
const { reconcileReceiptsWithSchedules, raiseReceiptContradictionReviews } = await import("../backend/src/feeSchedules");

const db = apply ? await openDatabase() : new AppDb(new Database(dbPath, { readonly: true, fileMustExist: true }));
const report = reconcileReceiptsWithSchedules(db);
const short = (id: string | null) => (id ? id.slice(0, 8) : "(none)");

console.log(`\nFee schedules vs paid receipts${apply ? "" : "   (dry run — read-only, nothing written)"}\n`);
for (const r of report.results) {
  console.log(`${r.verdict.toUpperCase().padEnd(31)} ${r.profileKey} [${r.discipline || "undifferentiated"}] (${r.confidence})${r.likelyCause ? ` — ${r.likelyCause}` : ""}`);
  for (const x of r.receipts) {
    console.log(`    receipt $${x.authorityAmountUsd.toFixed(2).padStart(8)} (${x.jurisdiction}, labelled ${x.discipline}, project ${short(x.projectId)}): ${x.explainedBy || "NOT explained by any total this schedule can produce"}`);
  }
}
const count = (v: string) => report.results.filter((r) => r.verdict === v).length;
console.log(`\nschedules considered ${report.schedulesConsidered} (skipped: ${report.schedulesSkipped} conflicted/delegation/empty)`);
console.log(`  with receipts ${report.results.length}: corroborated ${count("corroborated")}, missing surcharge ${count("corroborated_missing_surcharge")}, contradicted ${count("contradicted")}`);
console.log(`  without receipts ${report.schedulesWithoutReceipts}`);
console.log(`receipts read ${report.receiptsRead}; at a jurisdiction with no schedule ${report.receiptsWithoutSchedule}`);

if (apply) {
  for (const o of raiseReceiptContradictionReviews(db, report)) {
    console.log(`review item ${o.action.padEnd(9)} ${o.profileKey} (project ${short(o.projectId)})`);
  }
} else {
  const keys = new Set(report.results.filter((r) => r.verdict !== "corroborated").map((r) => r.profileKey));
  console.log(`\n--apply would raise at most ${keys.size} review item(s): ${[...keys].join(", ") || "(none)"}`);
}
