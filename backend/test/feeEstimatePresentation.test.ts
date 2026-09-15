// AN ESTIMATE MUST PRESENT AS AN ESTIMATE — the flags, not only the words.
//
// Measured on the live database (2026-09-14): Bren Trask's City of Portland
// permit (88647deb…) is quoted $450.00 — source valuation_estimate, basis
// "Rough estimate: 1.5% of contract value … Enter the portal-calculated fee to
// true it up" — while the fee SHEET said `known: true` and `unknowns: []`. The
// sentence was honest; the machine-readable flags claimed nothing was unknown,
// which is the unknown-rendering-as-reassurance defect this series keeps
// finding. The estimate itself is NOT the bug — an operator quoting a customer
// needs it — so the number stays and the flags stop lying:
//
//   - the estimated line is `known: false` (an estimate is not knowledge);
//   - `unknowns` NAMES the gap ("no published fee schedule resolved for …");
//   - the sheet grades its TOTAL by the weakest line summed into it
//     (`totalConfidence`), and the CLI renderer marks an estimated total
//     "≈ … (ESTIMATE)" with a caveat — same pattern the dashboard fee card uses.
//
// MUST EXCLUDE — the mirror-image defect: Christopher Ivy's fully-published
// $335.00 (the live Coos pair, rebuilt verbatim below) keeps `known: true`, an
// empty unknowns list, and a total with NO estimate caveat. A published number
// presenting as a guess is as wrong as a guess presenting as a fact.
// (Ann's engineered partial — feeForProject total null, structural unresolved —
// is feePathScope.test.ts's guard; nothing here touches that grain.)
//
// KILL TEST: in buildProjectFeeSheet, put `known: quote.permitFeeUsd != null`
// back, drop the estimated-unknowns branch and `totalConfidence`. Checks 2a,
// 2b, 2d and 3a go red (verified by reverting the file during development).
//
//   npx tsx backend/test/feeEstimatePresentation.test.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-estimate-presentation-"));
  // Before anything imports ../src/db.
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  process.env.AUTOPILOT_LOG_FILE = "";
  process.env.SUBMISSION_SERVICE_FEE_USD = "100";
  delete process.env.NEM_FEE_ESTIMATE_USD;
  delete process.env.PERMIT_FEE_ESTIMATE_RATE;
  delete process.env.PERMIT_FEE_ESTIMATE_MIN_USD;
  delete process.env.PERMIT_FEE_ESTIMATE_MAX_USD;
  delete process.env.PERMIT_VALUATION_PER_WATT;

  const { openDatabase } = await import("../src/db");
  const { saveFeeSchedule, feeScheduleProfileKey } = await import("../src/feeSchedules");
  const { createClient } = await import("../src/clients");
  const { getProjectDetail } = await import("../src/repository");
  const { buildPaymentQuote, buildProjectFeeSheet, recordActualPermitFee } = await import("../src/submissionFees");
  // The CLI renderer is the production render path the operator reads; driving
  // it here is what "renders with the caveat" means for a terminal test.
  const { buildFeeSheetPresentation, renderFeeSheet } = await import("../../scripts/fee-sheet");
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

  // -------------------------------------------------------------------------
  // THE ROWS — Ivy's live Coos pair verbatim (city structural + county
  // electrical + the city→county hop), a $0 NEM tariff for each utility, and
  // DELIBERATELY NOTHING for City of Portland's permit: that absence is what
  // produces Trask's estimate on the live database.
  // -------------------------------------------------------------------------
  const CITY = { state: "OR", ahj: "City of Coos Bay", track: "permit" as const };
  const COUNTY = { state: "OR", ahj: "Coos County", track: "permit" as const };
  const CITY_STRUCTURAL_LABEL = "Solar Permit (when required) – Prescriptive Path System, fee includes plan review";
  saveFeeSchedule(db, { ...CITY, discipline: "structural" }, finding({
    basis: "other",
    brackets: [{ feeUsd: 200, label: CITY_STRUCTURAL_LABEL }],
    sourceUrl: "https://www.coosbayor.gov/home/showpublisheddocument/570/639239531899170000",
    sourceQuote: `${CITY_STRUCTURAL_LABEL} | $200.00`,
    paymentMethod: "portal",
  }));
  saveFeeSchedule(db, { ...COUNTY, discipline: "electrical" }, finding({
    basis: "system_kw",
    brackets: [
      { minKw: 0, maxKw: 5, feeUsd: 135, label: "5 KVA or less | $135.00" },
      { minKw: 5.01, maxKw: 15, feeUsd: 160, label: "5.01 KVA to 15 KVA | $160.00" },
      { minKw: 15.01, maxKw: 25, feeUsd: 265, label: "15.01 KVA to 25 KVA | $265.00" },
    ],
    notes: "kVA on a solar row rates the INVERTER AC output, so these brackets read AC kW.",
    sourceUrl: "https://co.coos.or.us/files/f9b20f31d/community_development_fees_-_effective_1_1_26.pdf",
    paymentMethod: "portal",
  }));
  saveFeeSchedule(db, { ...CITY, discipline: "electrical" }, finding({
    basis: "other", brackets: [], collectedByProfileKey: feeScheduleProfileKey(COUNTY, "permit"),
    sourceUrl: "https://www.coosbayor.gov/home/showpublisheddocument/570/639239531899170000",
    sourceQuote: "a separate Electrical Permit application may also be required through the county",
  }));
  for (const utility of ["PGE", "Pacific Power"]) {
    saveFeeSchedule(db, { state: "OR", utility, track: "nem" }, finding({
      basis: "system_kw",
      brackets: [{ minKw: 0, maxKw: 25, feeUsd: 0, label: "Tier 1 (25 kW or less) — no application fee" }],
      sourceUrl: "https://secure.sos.state.or.us/oard/view.action?ruleNumber=860-039-0045",
      sourceQuote: "No application fee applies to Tier 1 net metering facilities (OAR 860-039-0045).",
    }));
  }

  // -------------------------------------------------------------------------
  // THE PROJECTS — Trask's live shape (jobValue 30000 → 1.5% = $450.00) and
  // Ivy's (3.072 kW AC prescriptive microinverter roof mount → $200 + $135).
  // Round-tripped through the projects table and getProjectDetail, the reader
  // production uses — not stipulated as literals.
  // -------------------------------------------------------------------------
  const client = createClient(db, { companyName: "Estimate Solar", billingMode: "per_submission", serviceFeeUsd: "100" });
  const now = new Date().toISOString();
  const mkProject = (id: string, name: string, ahj: string, utility: string, acKw: number, dcKw: number, snapshot: Record<string, unknown>) => {
    db.run(
      `INSERT INTO projects (id, client_id, homeowner_name, state, ahj, utility, system_size_ac_kw, system_size_dc_kw, status, parser_json, created_at, updated_at)
       VALUES (?, ?, ?, 'OR', ?, ?, ?, ?, 'ready_to_stage', ?, ?, ?)`,
      [id, client.id, name, ahj, utility, acKw, dcKw, JSON.stringify(snapshot), now, now],
    );
    return getProjectDetail(db, id).project;
  };
  const TRASK = mkProject("proj-trask", "Bren Trask", "City of Portland", "PGE", 8.376, 10.32, { jobValue: 30000 });
  const IVY = mkProject("proj-ivy", "Christopher Ivy", "City of Coos Bay", "Pacific Power", 3.072, 3.52, {
    mounting: "Roof mount", pvMicroMake: "Enphase", pvMicroModel: "IQ8PLUS-72-2-US",
  });

  // -------------------------------------------------------------------------
  // 1. FIXTURE PREMISES — the live shapes, reproduced. If these drift, the
  //    rest of the file is testing something else.
  // -------------------------------------------------------------------------
  const traskQuote = buildPaymentQuote(db, TRASK, "permit");
  check("premise: Trask quotes $450.00 from the valuation heuristic (no Portland schedule held)",
    traskQuote.permitFeeUsd === 450 && traskQuote.permitFeeSource === "valuation_estimate" && traskQuote.permitFeeConfidence === "estimated",
    `${traskQuote.permitFeeUsd} / ${traskQuote.permitFeeSource} / ${traskQuote.permitFeeConfidence}`);
  const ivyQuote = buildPaymentQuote(db, IVY, "permit");
  check("premise: Ivy quotes $335.00 from the published schedule",
    ivyQuote.permitFeeUsd === 335 && ivyQuote.permitFeeSource === "published_schedule" && ivyQuote.permitFeeConfidence === "seeded",
    `${ivyQuote.permitFeeUsd} / ${ivyQuote.permitFeeSource} / ${ivyQuote.permitFeeConfidence}`);
  check("premise: nothing here wrote confidence 'verified' (hard rule 3)",
    db.query<{ n: number }>("SELECT COUNT(*) AS n FROM fee_schedules WHERE confidence = 'verified'")[0]?.n === 0);

  // -------------------------------------------------------------------------
  // 2. THE FLAGS — Trask's sheet stops claiming knowledge it does not have.
  // -------------------------------------------------------------------------
  const trask = buildProjectFeeSheet(db, TRASK);
  const traskPermit = trask.lines.find((l) => l.track === "permit")!;
  const traskNem = trask.lines.find((l) => l.track === "nem")!;

  check("2a. the estimated line is known:false — an estimate is not knowledge",
    traskPermit.known === false && traskPermit.feeUsd === 450 && traskPermit.confidence === "estimated",
    `known=${traskPermit.known} fee=${traskPermit.feeUsd} conf=${traskPermit.confidence}`);
  const namedUnknown = trask.unknowns.find((u) => u.includes("City of Portland"));
  check("2b. unknowns NAMES the gap — no published fee schedule, this AHJ, this discipline",
    !!namedUnknown && /no published fee schedule/i.test(namedUnknown) && /\(permit\)/.test(namedUnknown)
    && /ESTIMATE/.test(namedUnknown) && namedUnknown.includes("$450.00"),
    JSON.stringify(trask.unknowns));
  check("  and the honest basis sentence still travels with it",
    !!namedUnknown && /Rough estimate/i.test(namedUnknown), (namedUnknown || "").slice(0, 200));
  check("2c. MUST EXCLUDE: the estimate is KEPT — the total still states the best current answer",
    trask.totalUsd === 650 && trask.jurisdictionFeesUsd === 450 && trask.serviceFeesUsd === 200,
    `${trask.totalUsd} / ${trask.jurisdictionFeesUsd} / ${trask.serviceFeesUsd}`);
  check("2d. the TOTAL says what it contains: totalConfidence is 'estimated'",
    trask.totalConfidence === "estimated", String(trask.totalConfidence));
  check("2e. the sourced $0 NEM line stays knowledge — a known $0 is known",
    traskNem.known === true && traskNem.feeUsd === 0 && traskNem.confidence === "seeded",
    `known=${traskNem.known} fee=${traskNem.feeUsd} conf=${traskNem.confidence}`);

  // -------------------------------------------------------------------------
  // 3. THE RENDER — the CLI fee sheet (same structure the dashboard draws).
  // -------------------------------------------------------------------------
  const traskText = renderFeeSheet(buildFeeSheetPresentation(db, TRASK));
  check("3a. the rendered total is marked an estimate, not flat fact",
    /PROJECT TOTAL\s+≈ \$650\.00\s+\(ESTIMATE\)/.test(traskText) && traskText.includes("INCLUDES AN ESTIMATE"),
    traskText.split("\n").filter((l) => /PROJECT TOTAL|INCLUDES/.test(l)).join(" | "));
  check("3b. the estimate banner renders (the house PROVISIONAL pattern)",
    /1 fee\(s\) above are ESTIMATES/.test(traskText) && /STILL UNKNOWN/.test(traskText),
    traskText.split("\n").filter((l) => /ESTIMATES|STILL UNKNOWN/.test(l)).join(" | "));

  // -------------------------------------------------------------------------
  // 4. MUST EXCLUDE — Ivy's fully-published sheet carries NO estimate caveat.
  //    A published number presenting as a guess is the mirror-image defect.
  // -------------------------------------------------------------------------
  const ivy = buildProjectFeeSheet(db, IVY);
  check("4a. Ivy's published line keeps known:true at $335.00",
    ivy.lines[0].known === true && ivy.lines[0].feeUsd === 335, `known=${ivy.lines[0].known} fee=${ivy.lines[0].feeUsd}`);
  check("4b. Ivy's sheet has NO unknowns and a graded, non-estimated total",
    ivy.unknowns.length === 0 && ivy.totalUsd === 535 && ivy.totalConfidence === "seeded",
    `${JSON.stringify(ivy.unknowns)} / ${ivy.totalUsd} / ${ivy.totalConfidence}`);
  const ivyText = renderFeeSheet(buildFeeSheetPresentation(db, IVY));
  check("4c. Ivy's render carries no estimate caveat anywhere",
    !ivyText.includes("INCLUDES AN ESTIMATE") && !ivyText.includes("≈") && !/are ESTIMATES/.test(ivyText)
    && /PROJECT TOTAL\s+\$535\.00/.test(ivyText),
    ivyText.split("\n").filter((l) => /PROJECT TOTAL|ESTIMATE/.test(l)).join(" | "));

  // -------------------------------------------------------------------------
  // 5. THE FLAG LIFECYCLE — the portal's real figure retires the estimate, the
  //    named unknown, and the total's caveat, through the production true-up.
  // -------------------------------------------------------------------------
  recordActualPermitFee(db, TRASK, "permit", "418.00", "portal_review");
  const trued = buildProjectFeeSheet(db, TRASK);
  const truedPermit = trued.lines.find((l) => l.track === "permit")!;
  check("5a. the recorded fee is knowledge: known:true, confidence actual",
    truedPermit.known === true && truedPermit.feeUsd === 418 && truedPermit.confidence === "actual",
    `known=${truedPermit.known} fee=${truedPermit.feeUsd} conf=${truedPermit.confidence}`);
  check("5b. the named unknown is gone and the total sheds its estimate grade",
    trued.unknowns.length === 0 && trued.totalUsd === 618 && trued.totalConfidence === "seeded",
    `${JSON.stringify(trued.unknowns)} / ${trued.totalUsd} / ${trued.totalConfidence}`);
  const truedText = renderFeeSheet(buildFeeSheetPresentation(db, TRASK));
  check("5c. the render drops the caveat once the number is real",
    !truedText.includes("INCLUDES AN ESTIMATE") && /PROJECT TOTAL\s+\$618\.00/.test(truedText),
    truedText.split("\n").filter((l) => /PROJECT TOTAL|INCLUDES/.test(l)).join(" | "));

  // Close before deleting the scratch DB - Windows holds the open handle as a file lock (EBUSY).
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log("\nfeeEstimatePresentation: all checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
