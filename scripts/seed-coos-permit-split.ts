// THE TWO PERMITS A COOS BAY ROOFTOP ACTUALLY DRAWS.
//
// The City of Coos Bay issues the STRUCTURAL solar permit ($200 flat, prescriptive path).
// Coos County issues the ELECTRICAL one (the kVA bracket table, $135/$160/$265). Both are on
// file and both are correct; until migration v22 the table could hold only one row per
// (AHJ, track), so a Coos Bay project resolved to $200 and the county's fee was invisible —
// a customer quote 44% short with every number on it right.
//
// This moves the two existing rows onto the disciplines they were always about, adds the
// county's own structural row (which the harvester had to abandon in a notes paragraph for
// exactly the same reason), and records the city-to-county hop as sourced data.
//
// NOTHING HERE IS GUESSWORK ABOUT WHICH PERMIT A ROW IS. Both rows already say so in their
// own notes, in their own words:
//   city:   "ELECTRICAL IS A DIFFERENT AUTHORITY: the city's schedule itself says the
//            separate Electrical Permit application 'may also be required through the
//            [county]' ... the electrical/renewable-energy kVA bracket fee is NOT a City of
//            Coos Bay fee"
//   county: "the county building department runs electrical and plumbing for all of Coos
//            County except the City of Lakeside ... so for a rooftop in Coos Bay or North
//            Bend the STRUCTURAL permit comes from that city, while this county electrical
//            table still applies"
// A third witness sits in the recording itself: the Accela field the recipe fills is
// ctl00_PlaceHolderMain_AppSpecB42EAF26Edit_COOS_CO_txt_0_28 — COOS_CO, filed from a City of
// Coos Bay project.
//
// The MOVE is an UPDATE of the discipline column, not a copy: the row keeps its id, its
// first-seen date, its notes and its confidence. A copy would leave the original sitting at
// discipline '' — which reads as "this jurisdiction publishes ONE undifferentiated permit
// schedule" and would shadow both disciplines, silently undoing the whole point.
//
//   npx tsx scripts/seed-coos-permit-split.ts [--dry-run]
import "dotenv/config";
process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";

// --dry-run RUNS AGAINST A COPY, rather than asking each write to behave.
//
// The first version guarded only the UPDATE and let saveFeeSchedule through, so its "dry
// run" wrote two rows to the live database and then reported that nothing had been written.
// A flag that every call site has to remember is a flag that one of them will not: pointing
// the whole process at a scratch file is the version that cannot be got wrong.
const dryRun = process.argv.includes("--dry-run");
if (dryRun) {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const live = process.env.AUTOPILOT_DB_PATH!;
  const scratch = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "coos-split-dry-")), "copy.sqlite");
  fs.copyFileSync(live, scratch);
  process.env.AUTOPILOT_DB_PATH = scratch;
  console.log(`
--dry-run: working on a copy of ${live}; the live database is not opened.`);
}
const { openDatabase } = await import("../backend/src/db");
const {
  saveFeeSchedule, getFeeSchedule, getFeeSchedulesForKey, feeScheduleProfileKey, feeLinesForProject,
} = await import("../backend/src/feeSchedules");
type FeeDiscipline = import("../backend/src/feeSchedules").FeeDiscipline;

const db = await openDatabase();

const CITY = { state: "OR", ahj: "City of Coos Bay", track: "permit" as const };
const COUNTY = { state: "OR", ahj: "Coos County", track: "permit" as const };
const cityKey = feeScheduleProfileKey(CITY, "permit");
const countyKey = feeScheduleProfileKey(COUNTY, "permit");

const CITY_SCHEDULE_URL = "https://www.coosbayor.gov/home/showpublisheddocument/570/639239531899170000";
const COUNTY_SCHEDULE_URL = "https://co.coos.or.us/files/f9b20f31d/community_development_fees_-_effective_1_1_26.pdf";

/** Move a row onto its discipline, in place. Refuses rather than clobbering. */
function retag(key: string, discipline: FeeDiscipline, what: string): void {
  const undifferentiated = getFeeSchedule(db, key, "permit", "");
  if (!undifferentiated) {
    const already = getFeeSchedule(db, key, "permit", discipline);
    console.log(`  ${what}: already filed as ${discipline}${already ? "" : " — and nothing is stored at all"}.`);
    return;
  }
  if (getFeeSchedule(db, key, "permit", discipline)) {
    console.log(`  ${what}: REFUSED — a ${discipline} row already exists beside the untagged one. A person should compare them.`);
    return;
  }
  console.log(`  ${what}: ${key} [permit] '' -> '${discipline}'  (${undifferentiated.brackets.length} line(s), ${undifferentiated.confidence})`);
  db.run("UPDATE fee_schedules SET discipline = ? WHERE id = ?", [discipline, undifferentiated.id]);
}

console.log("\nCoos Bay / Coos County — one job, two permits\n");
console.log("1. Move the existing rows onto the permit each one is actually about");
retag(cityKey, "structural", "City of Coos Bay ($200 flat, prescriptive structural)");
retag(countyKey, "electrical", "Coos County (kVA brackets, renewable-energy electrical)");

console.log("\n2. The county's OWN structural permit — a real fee the old key had nowhere to put");
const countyStructural = saveFeeSchedule(db, { ...COUNTY, discipline: "structural" }, {
  found: true,
  reason: "",
  basis: "flat",
  brackets: [{ feeUsd: 258, label: "Solar Permit – Prescriptive Path System, fee includes plan review" }],
  notes: [
    "The COUNTY's structural solar permit, for addresses whose structural permit the county issues. The county building department runs structural for all of Coos County EXCEPT Lakeside, Coos Bay and North Bend — those three cities issue their own, so a Coos Bay rooftop pays the CITY's $200 here and this row does not apply to it.",
    "Rose from $250.00 (schedule eff. 7/1/25) to $258.00 (eff. 1/1/26). Non-prescriptive (engineered) installs are priced off the Structural Permit Fee valuation table instead, with collector panels and inverters EXCLUDED from that valuation — a different number this row does not cover.",
    "Recovered from the notes of the electrical row, where the one-permit-per-AHJ key had forced it; migration v22 gave it somewhere to live.",
  ].join(" | "),
  sourceUrl: COUNTY_SCHEDULE_URL,
  sourceQuote: "Solar Permit – Prescriptive Path System, fee includes plan review | $258.00  [Coos County Community Development Fee Schedule, Effective 1/1/2026, Order # CJ 2025-0956, p.3, 'Solar Structural Installation Permits – separate Electrical Permit application may also be required']",
  sourceKind: "official",
  paymentMethod: "portal",
});
console.log(`  saved=${countyStructural.saved}${countyStructural.reason ? ` (${countyStructural.reason})` : ""}`);

console.log("\n3. The hop: a Coos Bay address files its ELECTRICAL permit with the county");
const delegation = saveFeeSchedule(db, { ...CITY, discipline: "electrical" }, {
  found: true,
  reason: "",
  basis: "other",
  brackets: [],
  collectedByProfileKey: countyKey,
  notes: [
    "NOT A CITY FEE. The City of Coos Bay issues structural and mechanical permits; every electrical permit for a Coos Bay address is issued by Coos County Community Development (60 E 2nd St, Coquille, 541-396-7770). The kVA-bracketed renewable-energy fee is read off the COUNTY's schedule, and this row exists only to point at it.",
    "Corroborated by the recording: the Accela field the Coos Bay recipe fills is ctl00_PlaceHolderMain_AppSpecB42EAF26Edit_COOS_CO_txt_0_28 — COOS_CO, on a City of Coos Bay project.",
    "One caveat a person should close: a City FAQ page instead names the Oregon BCD Coos Bay field office as the electrical authority. The city's own adopted fee schedule and its Building Permits page both say county, which is why this points at the county — but it is seeded, not verified, and that disagreement is the thing to check first.",
  ].join(" | "),
  sourceUrl: CITY_SCHEDULE_URL,
  sourceQuote: "Solar Structural Installation Permits – separate Electrical Permit application may also be required through the county  [City of Coos Bay Fee Schedule, Resolution 26-30, Exhibit A, BUILDING FEES, p.8]",
  sourceKind: "official",
});
console.log(`  saved=${delegation.saved}${delegation.reason ? ` (${delegation.reason})` : ""}`);

console.log("\n4. What is on file now");
for (const [label, key] of [["City of Coos Bay", cityKey], ["Coos County", countyKey]] as const) {
  for (const row of getFeeSchedulesForKey(db, key, "permit")) {
    const money = row.collectedByProfileKey
      ? `-> collected by ${row.collectedByProfileKey}`
      : row.brackets.map((b) => `$${b.feeUsd.toFixed(2)}`).join(" / ");
    console.log(`  ${label.padEnd(18)} ${(row.discipline || "(untagged)").padEnd(12)} ${row.confidence.padEnd(8)} ${money}`);
  }
}

console.log("\n5. What a real Coos Bay job is quoted (4.55 kW AC / 6.2 kW DC)");
const sample = { state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", systemSizeAcKw: 4.55, systemSizeDcKw: 6.2, parserSnapshot: null } as never;
let total = 0;
let unresolved = false;
for (const line of feeLinesForProject(db, sample, "permit")) {
  const who = line.hoppedFrom ? `${line.authority} (filed via ${line.hoppedFrom})` : line.authority;
  console.log(`  ${line.discipline.padEnd(12)} ${line.feeUsd == null ? "unresolved".padEnd(10) : `$${line.feeUsd.toFixed(2)}`.padEnd(10)} ${who} — ${line.bracketLabel || line.reason}`);
  if (line.feeUsd == null) unresolved = true; else total += line.feeUsd;
}
console.log(`  ${"TOTAL".padEnd(12)} ${unresolved ? "unresolved (one line could not be read)" : `$${total.toFixed(2)}`}`);

if (dryRun) console.log("\n--dry-run: every write above landed in the scratch copy; the live database is untouched.\n");
else console.log("\nAll seeded. A person promotes a row with markFeeScheduleVerified(db, key, track, who, discipline).\n");
