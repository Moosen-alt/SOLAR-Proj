// FEES (new-AHJ e2e, 2026-09-26, GAP 8). Fees were 0/7 fully right.
//   K  a per-kW formula whose parts are all printed resolves (FirstEnergy Level 2 "$250.00 + $1.00
//      per kW" read "unknown" on the fee sheet); a formula whose threshold is not printed still refuses.
//   M  a schedule hosted by ANOTHER municipality is refused (Halifax Township's schedule was stored
//      as Corry's); the AHJ's own document, a neutral host, a state host and a delegation are not.
//   Z  a utility's published $0 reaches the fee sheet as $0, not "unknown" (Eversource).
//
//   npx tsx backend/test/e2eGapFees.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-gap-fees-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.FEE_RESEARCH = "off";
process.env.CODE_RESEARCH = "off";
process.env.PERMIT_PROCESS_LOOKUP = "off";
delete process.env.NEM_FEE_ESTIMATE_USD;

const { openDatabase } = await import("../src/db");
const FS = await import("../src/feeSchedules");
const { buildProjectFeeSheet } = await import("../src/submissionFees");
const { createProject, getProjectDetail } = await import("../src/repository");
type ProjectRecord = import("../../shared/src/types").ProjectRecord;
type FeeScheduleFinding = import("../src/feeSchedules").FeeScheduleFinding;

const db = await openDatabase();
let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const finding = (over: Partial<FeeScheduleFinding>): FeeScheduleFinding => ({
  found: true, reason: "", basis: "flat", brackets: [], notes: "", sourceUrl: "", sourceQuote: "", sourceKind: "official", ...over,
});
const project = (over: Partial<ProjectRecord>): ProjectRecord => ({
  id: "fee-test", state: "PA", ahj: "Northern Cambria Borough", utility: "FirstEnergy", systemSizeAcKw: 8, systemSizeDcKw: 9.6,
  parserSnapshot: {}, clientId: "", status: "qc_passed", ...over,
} as unknown as ProjectRecord);

// ── K ──────────────────────────────────────────────────────────────────────────────────
const L2 = "Level 2 - $250.00 + $1.00 per kW";
check("K1 MUST-PASS: FirstEnergy Level 2 '$250.00 + $1.00 per kW' on an 8 kW job resolves to $258.00", () => {
  const r = FS.saveFeeSchedule(db, { state: "PA", utility: "FirstEnergy", track: "nem" }, finding({
    basis: "system_kw",
    brackets: [
      { minKw: 0, maxKw: 5, feeUsd: 100, label: "Level 1 - $100.00" },
      { minKw: 5.01, maxKw: 2000, feeUsd: 250, label: L2 },
    ],
    sourceUrl: "https://www.firstenergycorp.com/interconnection/pa-fees.html",
    sourceQuote: "Level 1 - $100.00; Level 2 - $250.00 + $1.00 per kW",
  }));
  assert.equal(r.saved, true, r.reason);
  const res = FS.feeForProject(db, project({}), "nem");
  assert.ok(res, "no resolution");
  assert.equal(res!.lines[0].feeUsd, 258, `fee: ${res!.lines[0].feeUsd} — ${res!.lines[0].reason}`);
  assert.match(res!.lines[0].bracketLabel, /computed on 8 kW/);
  const small = FS.feeForProject(db, project({ systemSizeAcKw: 4 }), "nem");
  assert.equal(small!.lines[0].feeUsd, 100, "control: Level 1 is still its flat $100");
});

check("K2 MUST-PASS: '$250.00 for first 25 kVA plus $6.25 per kVA' charges only the kVA over 25", () => {
  const f = FS.parseKwRateFormula({ feeUsd: 250, label: "$250.00 for first 25kva plus $6.25 per kva" });
  assert.ok(f);
  assert.equal(FS.evaluateKwRateFormula(f!, 30), 281.25);
  assert.equal(FS.evaluateKwRateFormula(f!, 20), 250);
});

check("K3 MUST-EXCLUDE: a rate on 'additional' units with no printed threshold, or a stored RATE, still refuses", () => {
  assert.equal(FS.parseKwRateFormula({ feeUsd: 265, label: "$265 + $10 per add'l kva up to 100 kva" }), null, "Coos County: above what?");
  assert.equal(FS.parseKwRateFormula({ feeUsd: 1, label: L2 }), null, "the stored number is the rate, not the base");
  assert.equal(FS.parseKwRateFormula({ feeUsd: 15.52, label: "Each kva over 25.012 up to 100 kva | $15.52" }), null, "Portland's rate row");
  FS.saveFeeSchedule(db, { state: "OR", utility: "Test Coast Power", track: "nem" }, finding({
    basis: "system_kw", brackets: [{ minKw: 0, maxKw: 100, feeUsd: 265, label: "$265 + $10 per add'l kva up to 100 kva" }],
    sourceUrl: "https://testcoastpower.example.com/fees", sourceQuote: "$265 + $10 per add'l kva up to 100 kva",
  }));
  const res = FS.feeForProject(db, project({ state: "OR", ahj: "Coos County", utility: "Test Coast Power", systemSizeAcKw: 40 }), "nem");
  assert.equal(res!.lines[0].feeUsd, null, "an unreadable formula was quoted");
  assert.match(res!.lines[0].reason, /FORMULA/);
});

// ── M ──────────────────────────────────────────────────────────────────────────────────
const HALIFAX = "https://www.hfxtwppa.gov/files/fee-schedule-2025.pdf";
check("M1 MUST-EXCLUDE: Halifax Township's schedule (hfxtwppa.gov) is refused for Corry — with and without the retrieved document", () => {
  const f = finding({ basis: "valuation", brackets: [{ feeUsd: 200, label: "Residential Solar Panels 1.5% of cost, min $200, max $1,000" }], sourceUrl: HALIFAX, sourceQuote: "Residential Solar Panels 1.5% of cost, min $200, max $1,000" });
  const noLedger = FS.saveFeeSchedule(db, { state: "PA", ahj: "Corry City", track: "permit" }, f);
  assert.equal(noLedger.saved, false, "saved another township's fee");
  assert.match(noLedger.reason, /never names Corry City/);
  const ledger = FS.newFeeDocumentLedger();
  ledger.evidence.push({ url: HALIFAX, via: "http", status: 200, kind: "pdf", bytes: 1000, handed: 10 });
  ledger.corpus.push("HALIFAX TOWNSHIP, DAUPHIN COUNTY — FEE SCHEDULE 2025 | Residential Solar Panels 1.5% of cost, min $200, max $1,000");
  const withLedger = FS.saveFeeSchedule(db, { state: "PA", ahj: "Corry City", track: "permit" }, f, { corroborateAgainst: ledger });
  assert.equal(withLedger.saved, false);
  assert.equal(FS.findFeeScheduleForProject(db, { state: "PA", ahj: "Corry City", utility: "" }, "permit"), null, "a row landed for Corry");
});

check("M2 MUST-PASS: the AHJ's own schedule saves — its name in the host, in the retrieved document, or a neutral host", () => {
  const waltham = FS.saveFeeSchedule(db, { state: "MA", ahj: "Waltham City", track: "permit" }, finding({
    brackets: [{ feeUsd: 50, label: "Minimum Fee $50" }], sourceUrl: "https://www.city.waltham.ma.us/building-department/fees",
    sourceQuote: "$12 per Thousand of construction cost, Minimum Fee $50",
  }));
  assert.equal(waltham.saved, true, waltham.reason);
  const doc = "https://cms.example-cdn.com/files/fee-schedule.pdf";
  const ledger = FS.newFeeDocumentLedger();
  ledger.evidence.push({ url: doc, via: "http", status: 200, kind: "pdf", bytes: 1000, handed: 10 });
  ledger.corpus.push("TOWN OF VENUS, TEXAS — BUILDING PERMIT FEES | Solar Panel Permit (R) | $160.00");
  const venus = FS.saveFeeSchedule(db, { state: "TX", ahj: "Town of Venus", track: "permit" }, finding({
    brackets: [{ feeUsd: 160, label: "Solar Panel Permit (R) | $160.00" }], sourceUrl: doc, sourceQuote: "Solar Panel Permit (R) | $160.00",
  }), { corroborateAgainst: ledger });
  assert.equal(venus.saved, true, venus.reason);
  const iowa = FS.saveFeeSchedule(db, { state: "IA", ahj: "Iowa City", track: "permit" }, finding({
    brackets: [{ feeUsd: 78, label: "Residential Electrical - Solar | $78.00" }], sourceUrl: "https://www.icgov.org/fees", sourceQuote: "Residential Electrical - Solar | $78.00",
  }));
  assert.equal(iowa.saved, true, `a neutral host refused on silence: ${iowa.reason}`);
});

check("M2b MUST-PASS: a township hosting its OWN schedule under an abbreviated host saves when the retrieved document names it", () => {
  const ledger = FS.newFeeDocumentLedger();
  ledger.evidence.push({ url: HALIFAX, via: "http", status: 200, kind: "pdf", bytes: 1000, handed: 10 });
  ledger.corpus.push("HALIFAX TOWNSHIP, DAUPHIN COUNTY — FEE SCHEDULE 2025 | Residential Solar Panels | $200.00");
  const r = FS.saveFeeSchedule(db, { state: "PA", ahj: "Halifax Township", track: "permit" }, finding({
    brackets: [{ feeUsd: 200, label: "Residential Solar Panels | $200.00" }], sourceUrl: HALIFAX, sourceQuote: "Residential Solar Panels | $200.00",
  }), { corroborateAgainst: ledger });
  assert.equal(r.saved, true, r.reason);
});

check("M3 MUST-PASS: a state government host and a delegation are exempt", () => {
  const nm = FS.saveFeeSchedule(db, { state: "NM", ahj: "Santa Fe County", track: "permit" }, finding({
    brackets: [{ feeUsd: 125, label: "Photovoltaic permit | $125" }], sourceUrl: "https://www.rld.nm.gov/construction-industries/fees/",
    sourceQuote: "Photovoltaic permit | $125",
  }));
  assert.equal(nm.saved, true, nm.reason);
  const hop = FS.saveFeeSchedule(db, { state: "PA", ahj: "Test Borough", track: "permit" }, finding({
    basis: "other", brackets: [], sourceUrl: "https://www.somecogtwp.example.gov/members", sourceQuote: "Member municipalities: Test Borough",
    collectedByProfileKey: FS.feeScheduleProfileKey({ state: "PA", ahj: "Some COG" }, "permit"),
  }));
  assert.equal(hop.saved, true, hop.reason);
});

check("M4 MUST-EXCLUDE: municipalityCore never reduces a city to its state's name", () => {
  assert.equal(FS.municipalityCore("Iowa City"), "iowa city");
  assert.equal(FS.municipalityCore("Corry City"), "corry");
  assert.equal(FS.municipalityCore("Town of Venus"), "venus");
  assert.equal(FS.municipalityCore("Northern Cambria Borough"), "northern cambria");
});

// ── Z ──────────────────────────────────────────────────────────────────────────────────
check("Z1 MUST-PASS: Eversource's published $0 is $0 on the fee sheet, not unknown", () => {
  const r = FS.saveFeeSchedule(db, { state: "MA", utility: "Eversource", track: "nem" }, finding({
    basis: "flat", brackets: [{ feeUsd: 0, label: "No application fee for Simplified Process (≤ 15 kW)" }],
    sourceUrl: "https://www.eversource.com/content/residential/about/doing-business-with-us/interconnections",
    sourceQuote: "There is no application fee for the Simplified Process", paymentMethod: "none",
  }));
  assert.equal(r.saved, true, r.reason);
  const d = createProject(db, { owner: "Fee Owner", street: "1 Test St", city: "Waltham", state: "MA", zip: "02451", ahj: "Waltham City", utility: "Eversource", dcKw: "7.2", acKw: "6" });
  const sheet = buildProjectFeeSheet(db, getProjectDetail(db, d.project.id).project);
  const nem = sheet.lines.find((l) => l.track === "nem")!;
  assert.equal(nem.feeUsd, 0, `NEM fee: ${nem.feeUsd} (${nem.basis})`);
  assert.equal(nem.known, true);
});

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows keeps the sqlite handle */ }
if (failures) {
  console.error(`\ne2eGapFees: ${failures} FAILED`);
  process.exit(1);
}
console.log("\ne2eGapFees: all checks passed");
