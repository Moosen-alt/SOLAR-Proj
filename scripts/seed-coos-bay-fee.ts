// COOS BAY'S SOLAR PERMIT FEE, READ OUT OF THE CITY'S OWN FEE SCHEDULE.
//
// The automated researcher reported found:false for Coos Bay and was RIGHT to — it could not
// retrieve the document. The reason turned out not to be that the schedule is obscure (the
// operator found it in seconds) but that coosbayor.gov sits behind Akamai and returns 403 to
// every programmatic client: WebFetch, curl with a browser UA, and even headless Playwright.
// A HEADED browser gets 200. The researcher's browser fallback (see feeSchedules.ts) is the
// general fix; this script records the finding that fallback was built to reach.
//
// Extracted with COORDINATES, not reading order. The PDF's text stream interleaves the value
// column with the description column, and a reading-order pairing puts "65% of permit fee"
// against "Plan Review" when the row actually reads "Structural Plan Review | 65% of permit
// fee". Same-row pairing is the only honest way to read a fee table.
//
// Source: City of Coos Bay Fee Schedule (Resolution 26-30), Exhibit A, BUILDING FEES, page 8.
//   https://www.coosbayor.gov/home/showpublisheddocument/570/639239531899170000
// The rows, verbatim, same-row paired:
//   "Solar Permit (when required) – Prescriptive Path System, fee includes plan review" | "$200.00"
//   "Solar Installation, nonprescriptive path system" | "Fee as per Structural Permit Fee table by
//    valuation to include the solar panels, racking, mounting elements, rails and the cost of
//    labor to install. Solar electrical equipment including collector panels and inverters shall
//    be excluded from the Structural Permit valuation."
//   "Structural Plan Review" | "65% of permit fee"
// And, confirming what the researcher deduced independently:
//   "Solar Structural Installation Permits – separate Electrical Permit application may also be
//    required through the county"
//
// Lands as SEEDED, like any research. A human promotes it with markFeeScheduleVerified.
//
//   npx tsx scripts/seed-coos-bay-fee.ts [--dry-run]
import "dotenv/config";
process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";

const dryRun = process.argv.includes("--dry-run");
const { openDatabase } = await import("../backend/src/db");
const { saveFeeSchedule, getFeeSchedule, feeScheduleProfileKey } = await import("../backend/src/feeSchedules");

const db = await openDatabase();

const SOURCE_URL = "https://www.coosbayor.gov/home/showpublisheddocument/570/639239531899170000";
const QUOTE =
  'Solar Permit (when required) – Prescriptive Path System, fee includes plan review | $200.00  '
  + '[City of Coos Bay Fee Schedule, Resolution 26-30, Exhibit A, BUILDING FEES, p.8; row read by '
  + 'coordinate pairing, not reading order]';

const input = { state: "OR", ahj: "City of Coos Bay", track: "permit" as const };

const finding = {
  found: true,
  reason: "",
  // FLAT, not bracketed: the prescriptive path — which is what a residential rooftop retrofit
  // files, and what this system's parser records as permitPath — is a single $200 fee that
  // already includes plan review. The NONPRESCRIPTIVE path is valuation-based, and its
  // valuation deliberately EXCLUDES panels and inverters, so it cannot be modelled as a
  // system-kW bracket either. A project on that path resolves to null and gets asked, which is
  // the honest answer rather than quoting $200 for an engineered install.
  basis: "flat" as const,
  brackets: [{ feeUsd: 200, label: "Prescriptive path system (includes plan review)" }],
  notes: [
    "Prescriptive path only. NONPRESCRIPTIVE (engineered) installs are charged from the Structural Permit Fee table by valuation, and that valuation excludes solar electrical equipment (collector panels and inverters) — a different number this row does not cover.",
    "Structural Plan Review is 65% of permit fee where a separate plan review applies.",
    "ELECTRICAL IS NOT THE CITY: the schedule states a separate Electrical Permit application may be required through the COUNTY. Coos County's electrical fee schedule — which carries the bracketed 'Renewable energy for electrical systems 5.01kva through 15kva' line the recipe freezes — is still unknown.",
    "Retrieved through a headed browser: coosbayor.gov returns 403 to WebFetch, curl and headless Playwright (Akamai).",
  ].join(" | "),
  sourceUrl: SOURCE_URL,
  sourceQuote: QUOTE,
  sourceKind: "official",
};

const key = feeScheduleProfileKey(input, input.track);
const existing = getFeeSchedule(db, key, input.track);
console.log(`\nCoos Bay solar permit fee -> ${key} [${input.track}]`);
console.log(`  existing row: ${existing ? `${existing.confidence}, ${existing.brackets.length} bracket(s)` : "(none)"}`);
console.log(`  finding: $200.00 flat, prescriptive path, source ${SOURCE_URL}`);

if (dryRun) {
  console.log("\n--dry-run: nothing written.\n");
  process.exit(0);
}

const outcome = saveFeeSchedule(db, input, finding);
console.log(`\n  saved=${outcome.saved} refusedVerified=${outcome.refusedVerified}${outcome.reason ? ` reason=${outcome.reason}` : ""}`);
const after = getFeeSchedule(db, key, input.track);
console.log(`  stored: ${after ? `${after.confidence} — $${after.brackets[0]?.feeUsd?.toFixed(2)} (${after.brackets[0]?.label})` : "(nothing)"}`);
console.log(`\n  Verify it with markFeeScheduleVerified once a human has checked the PDF.\n`);
