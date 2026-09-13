// A FEE HARDCODED FROM A FORM GOES STALE EVERY JULY, AND THIS ONE HAD.
//
// ahjForms' renewableFee carried the ladder printed on the Portland renewable-energy permit
// application we hold (rev 7/1/2025): 5.01-15 kVA = $283. Running the fee researcher at Portland
// as a brand-new AHJ on 2026-09-13 turned up the CURRENT schedule — "Electrical Permit Fee
// Schedule, City of Portland, Effective Date: July 10, 2026" — where that row is $298. Every row
// had moved by ~5.3%: an annual increase.
//
// It is not one number. renewableFee feeds the bracket line, the subtotal, the 12% state
// surcharge and the TOTAL PERMIT FEE, so one stale constant is four wrong figures on a document
// that goes to the city.
//
//   MUST PASS    — a published size-bracketed schedule on file WINS, so a researched fee year
//                  reaches the PDF without anybody retyping a constant.
//   MUST EXCLUDE — no schedule leaves today's printed ladder exactly as it was; a FLAT or
//                  VALUATION schedule is a different question and must not be substituted; and
//                  the bracket boundary is inclusive at both ends, the way matchBracket reads it.
//
//   npx tsx backend/test/portlandFormFee.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portland-form-fee-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { buildContext, resolveSource } = await import("../src/ahjForms");
const { saveFeeSchedule } = await import("../src/feeSchedules");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const now = new Date().toISOString();
const mkProject = (id: string, ahj: string, acKw: number) => {
  db.run(
    `INSERT INTO projects (id, homeowner_name, state, ahj, utility, system_size_dc_kw, system_size_ac_kw, status, parser_json, created_at, updated_at)
     VALUES (?, 'Fee Test', 'OR', ?, 'PGE', ?, ?, 'ready_to_stage', '{}', ?, ?)`,
    [id, ahj, acKw * 1.3, acKw, now, now],
  );
  return { id, state: "OR", ahj, utility: "PGE", systemSizeDcKw: acKw * 1.3, systemSizeAcKw: acKw, parserSnapshot: {} } as never;
};

// Through resolveSource, the seam the overlay fields actually use — not a test-only export.
const feeFor = (project: never): number => Number(resolveSource("computed.renewableFee", buildContext(db, project)));

// 8.376 kW AC — the real Portland project this was measured on, in the 5.01–15 row.
const noSchedule = mkProject("pf-1", "City of Nowhere OR", 8.376);
check("MUST EXCLUDE: with no schedule on file, the printed ladder is unchanged ($283)", () => {
  assert.equal(feeFor(noSchedule), 283, "the fallback must be exactly today's behaviour");
});

// The schedule the researcher actually found, verbatim.
saveFeeSchedule(db, { state: "OR", ahj: "City of Portland", track: "permit", discipline: "electrical" }, {
  found: true, reason: "", basis: "system_kw",
  brackets: [
    { maxKw: 5, feeUsd: 212, label: "5 kva or less" },
    { minKw: 5.01, maxKw: 15, feeUsd: 298, label: "5.01 to 15 kva" },
    { minKw: 15.01, maxKw: 25, feeUsd: 391, label: "15.01 to 25 kva" },
  ],
  notes: "", sourceUrl: "https://www.portland.gov/ppd/documents/electrical-permit-fee-schedule-city-portland-effective-july-10-2026/download",
  sourceQuote: "Renewable Energy: Installation, alteration or relocation / 5.01 to 15 kva | $ | 298.00",
  sourceKind: "official",
} as never);

const portland = mkProject("pf-2", "City of Portland", 8.376);
check("THE FIX: a published schedule on file wins, so the form carries $298 not $283", () => {
  assert.equal(feeFor(portland), 298,
    "the PDF would print last year's fee onto an application that goes to the city");
});

check("the bracket boundary is inclusive at both ends, like matchBracket", () => {
  assert.equal(feeFor(mkProject("pf-3", "City of Portland", 5)), 212, "5.00 belongs to the first row");
  assert.equal(feeFor(mkProject("pf-4", "City of Portland", 5.01)), 298, "5.01 belongs to the second");
  assert.equal(feeFor(mkProject("pf-5", "City of Portland", 15)), 298, "15.00 belongs to the second");
  assert.equal(feeFor(mkProject("pf-6", "City of Portland", 15.01)), 391, "15.01 belongs to the third");
});

check("MUST EXCLUDE: a FLAT schedule is a different question and is not substituted", () => {
  // City of Coos Bay's solar permit is $200 FLAT on the prescriptive path — a real schedule, and
  // not an answer to "which kVA bracket does this box want". Substituting it would put a
  // structural flat fee on an electrical bracket line.
  saveFeeSchedule(db, { state: "OR", ahj: "City of Flatfee", track: "permit", discipline: "electrical" }, {
    found: true, reason: "", basis: "flat",
    brackets: [{ feeUsd: 200, label: "Prescriptive path system" }],
    notes: "", sourceUrl: "https://example.gov/fees", sourceQuote: "Solar Permit | $200.00", sourceKind: "official",
  } as never);
  assert.equal(feeFor(mkProject("pf-7", "City of Flatfee", 8.376)), 283,
    "a flat schedule must fall back to the printed ladder, not answer the bracket");
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\nportlandFormFee: all checks passed."
  : `\nportlandFormFee: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
