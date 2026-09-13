// A ROW THAT DESCRIBES A FORMULA CANNOT ANSWER WITH A SINGLE NUMBER.
//
// Measured while pricing Portland as a brand-new AHJ on 2026-09-13. Its schedule's top solar row
// reads "Solar Generation System Over 25 KVA (Plan Review Required) — Each kva over 25.012 up to
// 100 kva | $15.52", and the researcher stored feeUsd 15.52 — the RATE. matchBracket then hands a
// 40 kVA job $15.52, where the real fee is $391 for the first 25 plus $15.52 x ~15, about $624.
// A 40x under-quote: sourced, quotable, and completely confident.
//
// The three jurisdictions priced so far each store this shape DIFFERENTLY, which is the whole
// argument for refusing rather than inferring:
//
//   Portland      "Each kva over 25.012 up to 100 kva"           stored the RATE   $15.52
//   Lincoln City  "$250.00 for first 25kva plus $6.25 per kva"   stored the BASE   $250
//   Coos County   "$265 + $10 per add'l kva up to 100 kva"       stored the FLOOR  $265
//
// Nothing in the row says which of the three it is. A single stored number plus prose is not a
// formula, and guessing costs a customer real money.
//
//   MUST REFUSE — every formula row above, with a reason naming the label, and feeUsd null so
//                 the quote ladder falls through instead of quoting a rate.
//   MUST KEEP   — every ordinary bracket. A guard that eats real fees is worse than the gap it
//                 closes, because every jurisdiction has ordinary rows and only some have formulas.
//
//   npx tsx backend/test/feeFormulaBracket.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-formula-bracket-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { saveFeeSchedule, feeForProject, bracketDescribesFormula } = await import("../src/feeSchedules");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// The real labels, verbatim.
const FORMULA_ROWS = [
  "Solar Generation System Over 25 KVA (Plan Review Required) — Each kva over 25.012 up to 100 kva",
  "Renewable energy - solar generation over 25kva | $250.00 for first 25kva plus $6.25 per kva over 25kva, – maximum fee at 100kva",
  "Solar >25 KVA: $265 + $10 per additional kVA to 100 kVA — FORMULA, not flat; verify before quoting",
  "$4,001 - $25,000 | $104 + $13.34 for each add’l $1000 over $4,000",
  "$100,001 and up | $961.89 + $5.59 for each add’l $1000 over $100,000",
];
const ORDINARY_ROWS = [
  "5.01 KVA to 15 KVA",
  "Renewable Energy: Installation, alteration or relocation — 5.01 to 15 kva",
  "Renewable energy for electrical systems- 5.01kva through 15kva | $150.00",
  "Prescriptive path system (includes plan review)",
  "5 KVA or less",
  "Solar Permit – Prescriptive Path System, fee includes plan review",
  "$1 - $4,000 | $104 Minimum",
];

check("MUST REFUSE: every formula row the three real schedules carry", () => {
  const missed = FORMULA_ROWS.filter((l) => !bracketDescribesFormula(l));
  assert.deepEqual(missed, [], `these would still quote one part of a formula as the whole fee: ${JSON.stringify(missed)}`);
});

check("MUST KEEP: every ordinary bracket still answers", () => {
  const eaten = ORDINARY_ROWS.filter((l) => bracketDescribesFormula(l));
  assert.deepEqual(eaten, [], `the guard would refuse real fees: ${JSON.stringify(eaten)}`);
});

// Portland's schedule as the researcher actually stored it, verbatim.
saveFeeSchedule(db, { state: "OR", ahj: "City of Portland", track: "permit", discipline: "electrical" }, {
  found: true, reason: "", basis: "system_kw",
  brackets: [
    { minKw: 0, maxKw: 5, feeUsd: 212, label: "Renewable Energy: Installation, alteration or relocation — 5 kva or less" },
    { minKw: 5.01, maxKw: 15, feeUsd: 298, label: "Renewable Energy: Installation, alteration or relocation — 5.01 to 15 kva" },
    { minKw: 15.01, maxKw: 25, feeUsd: 391, label: "Renewable Energy: Installation, alteration or relocation — 15.01 to 25 kva" },
    { minKw: 25.012, maxKw: 100, feeUsd: 15.52, label: "Solar Generation System Over 25 KVA (Plan Review Required) — Each kva over 25.012 up to 100 kva" },
  ],
  notes: "", sourceUrl: "https://www.portland.gov/ppd/documents/electrical-permit-fee-schedule-city-portland-effective-july-10-2026/download",
  sourceQuote: "Each kva over 25.012 up to 100 kva | $ | 15.52",
  sourceKind: "official",
} as never);

const now = new Date().toISOString();
const mkProject = (id: string, acKw: number) => {
  db.run(
    `INSERT INTO projects (id, homeowner_name, state, ahj, utility, system_size_dc_kw, system_size_ac_kw, status, parser_json, created_at, updated_at)
     VALUES (?, 'Formula Test', 'OR', 'City of Portland', 'PGE', ?, ?, 'ready_to_stage', '{}', ?, ?)`,
    [id, acKw * 1.3, acKw, now, now],
  );
  return { id, state: "OR", ahj: "City of Portland", utility: "PGE", systemSizeDcKw: acKw * 1.3, systemSizeAcKw: acKw, parserSnapshot: {} } as never;
};

check("THE HEADLINE: a 40 kVA job is NOT quoted the $15.52 per-kva rate", () => {
  const r = feeForProject(db, mkProject("ff-40", 40), "electrical");
  assert.ok(r, "a schedule is on file, so there should be a resolution to read");
  assert.equal(r!.feeUsd, null,
    `quoted $${r!.feeUsd} — the real fee is about $624 ($391 for the first 25 plus $15.52 x ~15)`);
  assert.match(r!.reason, /FORMULA/i, `the refusal must say why: ${r!.reason}`);
  assert.match(r!.reason, /Each kva over 25\.012/, `and name the label it read: ${r!.reason}`);
});

check("MUST KEEP: an ordinary bracket on the SAME schedule still prices", () => {
  // 8.376 kVA — the real Portland project. One formula row must not poison the whole table.
  const r = feeForProject(db, mkProject("ff-8", 8.376), "electrical");
  assert.equal(r?.feeUsd, 298, `an ordinary row stopped answering: ${JSON.stringify(r?.reason)}`);
});

check("the refusal reaches the QUOTE as unresolved, not as a number", () => {
  // feeUsd null is what makes submissionFees fall through to the tier below instead of putting a
  // rate in front of a customer. Pinned because "returns null" is the entire safety property.
  const r = feeForProject(db, mkProject("ff-60", 60), "electrical");
  assert.equal(r?.feeUsd, null);
  assert.equal((r?.lines ?? []).filter((l) => l.feeUsd != null).length, 0,
    "no line may carry a number when the bracket that matched is a formula");
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\nfeeFormulaBracket: all checks passed."
  : `\nfeeFormulaBracket: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
