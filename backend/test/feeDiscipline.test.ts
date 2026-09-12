// ONE ROOFTOP, TWO PERMITS, AND THE QUOTE THAT ONLY MENTIONED ONE.
//
// Measured on a live project this session. A Coos Bay solar job owes the CITY
// $200 for the structural permit (Resolution 26-30, p.8) and COOS COUNTY $160
// for the electrical permit (county schedule eff. 1/1/26, §F, at 5.01–15 kVA).
// Both were researched, both stored, and `fee-sheet.ts` printed:
//
//     JURISDICTION FEES   $200.00
//     PROJECT TOTAL       $200.00
//
// 44% short, with every number on the page correct and sourced. fee_schedules
// was unique on (profile_key, track) and "permit" is one slot, so the county's
// table simply had nowhere to be seen from a city project.
//
//   MUST PASS    — the split totals BOTH permits, itemised, each naming the
//                  authority that actually collects it;
//                  a discipline-bearing track ("electrical" / "building") is
//                  answered with THAT permit's fee and no other.
//   MUST EXCLUDE — an undifferentiated row is the whole answer (no double
//                  count); a hop that lands nowhere reads as unresolved, never
//                  as $0; a pointer chain does not loop; ONE unreadable line
//                  makes the TOTAL unreadable rather than smaller (an
//                  under-quote that looks confident is the bug); a row cannot
//                  delegate to itself; and the fuzzy name fallback never
//                  crosses disciplines.
//
// The kill test for the whole file: give both Coos rows discipline '' (which is
// what the schema could express before v22) and the split cases fail — the
// second permit becomes unreachable again.
//
//   npx tsx backend/test/feeDiscipline.test.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-discipline-test-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  const { openDatabase } = await import("../src/db");
  const {
    saveFeeSchedule, feeForProject, feeLinesForProject, findFeeScheduleForProject,
    getFeeSchedule, getFeeSchedulesForKey, feeScheduleProfileKey, lookupPublishedFee,
    markFeeScheduleVerified,
  } = await import("../src/feeSchedules");
  type Finding = import("../src/feeSchedules").FeeScheduleFinding;
  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   ${name}`);
  };

  const finding = (over: Partial<Finding>): Finding => ({
    found: true, reason: "", basis: "flat", brackets: [], notes: "",
    sourceUrl: "https://example.gov/fees", sourceQuote: "A sentence a person could go back and read.",
    sourceKind: "official", ...over,
  });

  // The real Coos numbers, because a fixture that invents them proves nothing
  // about the failure it is named after.
  const CITY = { state: "OR", ahj: "City of Coos Bay", track: "permit" as const };
  const COUNTY = { state: "OR", ahj: "Coos County", track: "permit" as const };
  const cityKey = feeScheduleProfileKey(CITY, "permit");
  const countyKey = feeScheduleProfileKey(COUNTY, "permit");

  // A 4.55 kW-AC job — deliberately in the county's LOWEST bracket ($135), so a
  // test that passed by echoing the middle bracket would be visible.
  const project = {
    state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power",
    systemSizeAcKw: 4.55, systemSizeDcKw: 6.2, parserSnapshot: null,
  } as never;

  // ---------------------------------------------------------------------
  // 0. The migration actually widened the key.
  // ---------------------------------------------------------------------
  const cols = db.query<{ name: string }>("PRAGMA table_info(fee_schedules)").map((c) => c.name);
  check("v22 added discipline + collected_by_profile_key",
    cols.includes("discipline") && cols.includes("collected_by_profile_key"), cols.join(","));
  const idx = db.query<{ name: string; unique: number }>("PRAGMA index_list(fee_schedules)");
  check("the unique key is now (profile_key, track, discipline)",
    idx.some((i) => i.name === "idx_fee_schedules_profile_track_discipline" && Number(i.unique) === 1),
    idx.map((i) => i.name).join(","));
  check("and the OLD two-column unique index is gone (it would forbid the second permit)",
    !idx.some((i) => i.name === "idx_fee_schedules_profile_track"),
    idx.map((i) => i.name).join(","));

  // ---------------------------------------------------------------------
  // 1. Two permits under one AHJ key, which the old schema could not hold.
  // ---------------------------------------------------------------------
  saveFeeSchedule(db, { ...CITY, discipline: "structural" }, finding({
    basis: "flat",
    brackets: [{ feeUsd: 200, label: "Prescriptive path system (includes plan review)" }],
    sourceUrl: "https://www.coosbayor.gov/home/showpublisheddocument/570/639239531899170000",
    sourceQuote: "Solar Permit (when required) – Prescriptive Path System, fee includes plan review | $200.00",
    paymentMethod: "portal",
  }));
  saveFeeSchedule(db, { ...COUNTY, discipline: "electrical" }, finding({
    basis: "system_kw",
    brackets: [
      { maxKw: 5, feeUsd: 135, label: "5 KVA or less" },
      { minKw: 5.01, maxKw: 15, feeUsd: 160, label: "5.01 KVA to 15 KVA" },
      { minKw: 15.01, maxKw: 25, feeUsd: 265, label: "15.01 KVA to 25 KVA" },
    ],
    sourceUrl: "https://co.coos.or.us/files/f9b20f31d/community_development_fees_-_effective_1_1_26.pdf",
    sourceQuote: "5.01 KVA to 15 KVA | $160.00",
    paymentMethod: "portal",
  }));
  saveFeeSchedule(db, { ...COUNTY, discipline: "structural" }, finding({
    basis: "flat",
    brackets: [{ feeUsd: 258, label: "Solar Permit – Prescriptive Path System, fee includes plan review" }],
    sourceUrl: "https://co.coos.or.us/files/f9b20f31d/community_development_fees_-_effective_1_1_26.pdf",
    sourceQuote: "Solar Permit – Prescriptive Path System, fee includes plan review | $258.00",
  }));
  const countyRows = getFeeSchedulesForKey(db, countyKey, "permit");
  check("one AHJ now holds BOTH its permits (the $258 structural the harvester had to drop into a notes paragraph)",
    countyRows.length === 2 && countyRows.some((r) => r.discipline === "electrical") && countyRows.some((r) => r.discipline === "structural"),
    countyRows.map((r) => `${r.discipline}:${r.brackets[0]?.feeUsd}`).join(","));

  // ---------------------------------------------------------------------
  // 2. The hop: the city does not charge for electrical, the county does.
  // ---------------------------------------------------------------------
  const hop = saveFeeSchedule(db, { ...CITY, discipline: "electrical" }, finding({
    basis: "other",
    brackets: [],
    collectedByProfileKey: countyKey,
    sourceUrl: "https://www.coosbayor.gov/home/showpublisheddocument/570/639239531899170000",
    sourceQuote: "Solar Structural Installation Permits – separate Electrical Permit application may also be required through the county",
  }));
  check("a delegation row stores (it has no fee to evaluate, and still had to be sourced)", hop.saved, hop.reason);

  const lines = feeLinesForProject(db, project, "permit");
  const byDiscipline = Object.fromEntries(lines.map((l) => [l.discipline, l]));
  check("the Coos Bay project now itemises TWO permits, not one",
    lines.length === 2, lines.map((l) => `${l.discipline}=${l.feeUsd}`).join(","));
  check("  city structural = $200",
    byDiscipline.structural?.feeUsd === 200, String(byDiscipline.structural?.feeUsd));
  check("  county electrical = $135 at 4.55 kW-AC (the bracket the project is actually in)",
    byDiscipline.electrical?.feeUsd === 135, `${byDiscipline.electrical?.feeUsd} / ${byDiscipline.electrical?.bracketLabel}`);
  check("  and the electrical line names COOS COUNTY as the authority, not the city",
    byDiscipline.electrical?.authority === "Coos County" && byDiscipline.electrical?.hoppedFrom === "City of Coos Bay",
    `${byDiscipline.electrical?.authority} (from ${byDiscipline.electrical?.hoppedFrom})`);
  check("  carrying the COUNTY's own document, so the quote on screen is the one that says $135",
    /co\.coos\.or\.us/.test(String(byDiscipline.electrical?.sourceUrl)), String(byDiscipline.electrical?.sourceUrl));

  const total = feeForProject(db, project, "permit");
  check("THE HEADLINE: the permit total is $335, not the $200 the fee sheet printed",
    total?.feeUsd === 335, String(total?.feeUsd));
  check("  and the total carries its own itemisation", (total?.lines ?? []).length === 2);

  // ---------------------------------------------------------------------
  // 3. A track that names its permit is answered with THAT permit.
  // ---------------------------------------------------------------------
  const electrical = feeForProject(db, project, "electrical");
  check("an ELECTRICAL stage is quoted the county's $135, alone",
    electrical?.feeUsd === 135 && electrical?.lines.length === 1, `${electrical?.feeUsd} across ${electrical?.lines.length} line(s)`);
  const building = feeForProject(db, project, "building");
  check("a BUILDING stage is quoted the city's $200, alone",
    building?.feeUsd === 200 && building?.lines.length === 1, `${building?.feeUsd} across ${building?.lines.length} line(s)`);
  // mpu is an electrical filing (portalChannel.recipeDisciplineForTrack) — the
  // mapping is imported, not re-stated, so this pins that it stays imported.
  check("an MPU stage files electrical, so it is quoted electrical", feeForProject(db, project, "mpu")?.feeUsd === 135);

  // The staging gate's seam sees the same split.
  const staged = lookupPublishedFee(db, {
    track: "electrical", state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", bracketKw: 4.55,
  });
  check("lookupPublishedFee (the staging gate) resolves the electrical stage to the county's $135",
    staged?.feeUsd === 135 && /Coos County/.test(String(staged?.jurisdictionName)), `${staged?.feeUsd} / ${staged?.jurisdictionName}`);
  const stagedBoth = lookupPublishedFee(db, {
    track: "permit", state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", bracketKw: 4.55,
  });
  check("and an undisciplined 'permit' stage is quoted the whole $335",
    stagedBoth?.feeUsd === 335, String(stagedBoth?.feeUsd));

  // ---------------------------------------------------------------------
  // 4. MUST EXCLUDE — the ways a split could quote a wrong number confidently.
  // ---------------------------------------------------------------------
  const PLAIN = { state: "OR", ahj: "City of Springfield", track: "permit" as const };
  saveFeeSchedule(db, PLAIN, finding({ basis: "flat", brackets: [{ feeUsd: 175, label: "Solar permit" }] }));
  const plainProject = { ...(project as object), ahj: "City of Springfield" } as never;
  check("MUST EXCLUDE: an undifferentiated row is the WHOLE answer — one line, no double count",
    feeLinesForProject(db, plainProject, "permit").length === 1 && feeForProject(db, plainProject, "permit")?.feeUsd === 175);
  check("  and it still answers a discipline-specific ask (every row written before v22 carries '')",
    feeForProject(db, plainProject, "electrical")?.feeUsd === 175);

  const DANGLING = { state: "OR", ahj: "City of Nowhere", track: "permit" as const };
  saveFeeSchedule(db, { ...DANGLING, discipline: "electrical" }, finding({
    basis: "other", brackets: [], collectedByProfileKey: "or|county that has no row|unknown",
  }));
  const dangling = feeForProject(db, { ...(project as object), ahj: "City of Nowhere" } as never, "electrical");
  check("MUST EXCLUDE: a hop that lands nowhere is UNRESOLVED, never $0",
    dangling != null && dangling.feeUsd == null && /no schedule is stored for that authority/i.test(dangling.reason),
    `${dangling?.feeUsd} / ${dangling?.reason}`);

  const A = { state: "OR", ahj: "City of Ping", track: "permit" as const };
  const B = { state: "OR", ahj: "City of Pong", track: "permit" as const };
  saveFeeSchedule(db, { ...A, discipline: "electrical" }, finding({ basis: "other", brackets: [], collectedByProfileKey: feeScheduleProfileKey(B, "permit") }));
  saveFeeSchedule(db, { ...B, discipline: "electrical" }, finding({ basis: "other", brackets: [], collectedByProfileKey: feeScheduleProfileKey(A, "permit") }));
  const pingPong = feeForProject(db, { ...(project as object), ahj: "City of Ping" } as never, "electrical");
  check("MUST EXCLUDE: two rows pointing at each other resolve to a reason, not a hang",
    pingPong != null && pingPong.feeUsd == null && /chain of pointers/i.test(pingPong.reason), pingPong?.reason);

  const selfRef = saveFeeSchedule(db, { ...PLAIN, discipline: "electrical" }, finding({
    basis: "other", brackets: [], collectedByProfileKey: feeScheduleProfileKey(PLAIN, "permit"),
  }));
  check("MUST EXCLUDE: a row cannot delegate its fee to itself", !selfRef.saved && /itself/i.test(selfRef.reason), selfRef.reason);

  // One unreadable line must sink the TOTAL. A 40 kW system is outside every
  // county bracket stored above, so the electrical line cannot evaluate — and
  // reporting "$200" for that project is exactly the confident under-quote.
  const bigProject = { ...(project as object), systemSizeAcKw: 40, systemSizeDcKw: 52 } as never;
  const bigTotal = feeForProject(db, bigProject, "permit");
  check("MUST EXCLUDE: one unreadable line makes the TOTAL unreadable, not smaller",
    bigTotal != null && bigTotal.feeUsd == null && /outside every published bracket/i.test(bigTotal.reason),
    `${bigTotal?.feeUsd} / ${bigTotal?.reason}`);
  check("  and the readable line is still itemised, so a person can see what IS known",
    (bigTotal?.lines ?? []).some((l) => l.feeUsd === 200));

  // A fuzzy name match that crosses disciplines quotes a real fee for the wrong
  // permit — the same class of error as quoting the wrong jurisdiction.
  // "Coos" is the operator short name the fuzzy fallback exists for (it scores 65
  // against "Coos County", over the 60 threshold) — and the county holds BOTH a
  // structural and an electrical row, so an indifferent fuzzy match has a real
  // chance to return the wrong permit's fee.
  const shortName = { state: "OR", ahj: "Coos", utility: "", systemSizeAcKw: 4.55, systemSizeDcKw: 6.2, parserSnapshot: null } as never;
  const fuzzyElec = findFeeScheduleForProject(db, shortName, "permit", "electrical");
  check("MUST EXCLUDE: the fuzzy name fallback does not cross disciplines",
    fuzzyElec?.discipline === "electrical" && fuzzyElec?.brackets.length === 3,
    `matched ${fuzzyElec?.discipline || "(none)"} with ${fuzzyElec?.brackets.length ?? 0} bracket(s)`);
  check("  and it still finds the structural one when THAT is what was asked for",
    findFeeScheduleForProject(db, shortName, "permit", "structural")?.brackets[0]?.feeUsd === 258,
    String(findFeeScheduleForProject(db, shortName, "permit", "structural")?.brackets[0]?.feeUsd));

  // ---------------------------------------------------------------------
  // 5. Hard rule 3 still holds per discipline.
  // ---------------------------------------------------------------------
  markFeeScheduleVerified(db, countyKey, "permit", "an operator", "electrical");
  const refused = saveFeeSchedule(db, { ...COUNTY, discipline: "electrical" }, finding({
    basis: "system_kw", brackets: [{ minKw: 5.01, maxKw: 15, feeUsd: 999, label: "wrong" }],
  }));
  check("a human-verified ELECTRICAL row is not overwritten by research",
    !refused.saved && refused.refusedVerified && getFeeSchedule(db, countyKey, "permit", "electrical")?.brackets[1]?.feeUsd === 160);
  check("  and verifying one discipline does NOT verify the other",
    getFeeSchedule(db, countyKey, "permit", "structural")?.confidence === "seeded");

  // Close before deleting the scratch DB — Windows holds the open handle as a
  // file lock (EBUSY).
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0
    ? "\nfeeDiscipline: all checks passed."
    : `\nfeeDiscipline: ${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
