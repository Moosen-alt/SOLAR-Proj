// COOS COUNTY'S ELECTRICAL RENEWABLE-ENERGY BRACKETS — THE TABLE THE RECIPE WAS FREEZING.
//
// Coos Bay's Accela recipe carries "Renewable energy for electrical systems- 5.01kva through
// 15kva = 1" as a FROZEN literal: the quantity ticked against one bracket row of a fee table,
// recorded from whatever project was learned, and replayed onto every later job. A 4.5 kVA
// system belongs in a different row, and a 20 kVA system in another again, so the frozen "1"
// bills the wrong bracket every time the system size changes.
//
// The City's own schedule says where the table lives: "Solar Structural Installation Permits –
// separate Electrical Permit application may also be required through the county". This is that
// county table.
//
// Source: Coos County Community Development Fee Schedule, effective 7-1-25, section F
// (Electrical Permit Fees), page 7, "Renewable Energy".
//   https://co.coos.or.us/files/e5faeb642/community_development_fees_7-1-25.pdf
// Verified identical in the proposed schedule effective 01/01/26 (same four rows, same
// amounts), so there is no supersession risk at the time of writing:
//   https://co.coos.or.us/files/fc345200c/proposed_fee_changes_effective_01_01_26.pdf
//
// READ BY COORDINATE PAIRING, and that is not a formality. A web-search summary of this very
// table returned $108 / $346 / $796 for the three solar brackets — it had taken the WIND
// GENERATION rows ($346 for 25.01-50 kVA, $796 for 50.01-100 kVA) and attached them to the
// solar brackets. The real numbers are $135 / $160 / $265. A row-misattributed fee is a
// customer quote that is wrong by more than double, and same-row pairing is the only thing
// that catches it.
//
//   npx tsx scripts/seed-coos-county-electrical-fee.ts [--dry-run]
import "dotenv/config";
process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";

const dryRun = process.argv.includes("--dry-run");
const { openDatabase } = await import("../backend/src/db");
const { saveFeeSchedule, getFeeSchedule, feeScheduleProfileKey } = await import("../backend/src/feeSchedules");

const db = await openDatabase();

const SOURCE_URL = "https://co.coos.or.us/files/e5faeb642/community_development_fees_7-1-25.pdf";

// The four rows, verbatim, same-row paired. kVA on a solar row rates the INVERTER output, so
// these bracket AC kW, which is what feeForProject reads first.
const QUOTE = [
  '"Renewable Energy"',
  '"5 KVA or less" | "$135.00"',
  '"5.01 KVA to 15 KVA" | "$160.00"',
  '"15.01 KVA to 25 KVA" | "$265.00"',
  '"Solar Generation greater than 25 KVA" / "25 KVA rate plus each additional KVA" | "$265.00 + $10 per add\'l kva up to a maximum of 100 kva"',
  "[Coos County Community Development Fee Schedule eff. 7-1-25, section F Electrical Permit Fees, p.7]",
].join("  ");

const input = { state: "OR", ahj: "Coos County", track: "permit" as const };

const finding = {
  found: true,
  reason: "",
  basis: "system_kw" as const,
  brackets: [
    { maxKw: 5, feeUsd: 135, label: "5 KVA or less" },
    { minKw: 5.01, maxKw: 15, feeUsd: 160, label: "5.01 KVA to 15 KVA" },
    { minKw: 15.01, maxKw: 25, feeUsd: 265, label: "15.01 KVA to 25 KVA" },
    // Above 25 kVA the fee is 265 + $10/kVA and is NOT a flat bracket. Stored at its floor
    // with the formula in the label so a resolver never quietly under-quotes a large system:
    // anything landing here should be read by a human until the formula is modelled.
    { minKw: 25.01, maxKw: 100, feeUsd: 265, label: "Solar >25 KVA: $265 + $10 per additional kVA to 100 kVA — FORMULA, not flat; verify before quoting" },
  ],
  notes: [
    "kVA on a solar row rates the INVERTER AC output, so these brackets read AC kW.",
    "Electrical Plan Review (when applicable) is 25% of the subtotal fees; additional plan review $160/hour, minimum one hour.",
    "This is the ELECTRICAL permit, issued by Coos COUNTY. The City of Coos Bay issues the separate STRUCTURAL solar permit ($200 flat, prescriptive path) — both may apply to one job.",
    "Identical in the schedule proposed effective 01/01/26, so no supersession risk as at 2026-09-12.",
    "Read by coordinate pairing: a web-search summary of this table mis-attributed the WIND rows ($346, $796) to the solar brackets.",
  ].join(" | "),
  sourceUrl: SOURCE_URL,
  sourceQuote: QUOTE,
  sourceKind: "official",
};

const key = feeScheduleProfileKey(input, input.track);
const existing = getFeeSchedule(db, key, input.track);
console.log(`\nCoos County electrical renewable-energy brackets -> ${key} [${input.track}]`);
console.log(`  existing: ${existing ? `${existing.confidence}, ${existing.brackets.length} bracket(s)` : "(none)"}`);
for (const b of finding.brackets) console.log(`    ${String(b.label).slice(0, 52).padEnd(52)} $${b.feeUsd.toFixed(2)}`);

if (dryRun) { console.log("\n--dry-run: nothing written.\n"); process.exit(0); }

const outcome = saveFeeSchedule(db, input, finding);
console.log(`\n  saved=${outcome.saved} refusedVerified=${outcome.refusedVerified}${outcome.reason ? ` reason=${outcome.reason}` : ""}`);
console.log(`  A human should verify the PDF and promote it with markFeeScheduleVerified.\n`);
