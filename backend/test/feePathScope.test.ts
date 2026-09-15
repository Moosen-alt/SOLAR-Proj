// THE FEE-SIDE TWIN OF THE INVERTED PRESCRIPTIVE GATE.
//
// Measured on Ann Marineau's live project (1fb3dc39, City of Coos Bay, 8.36 kW DC /
// 7.68 kW AC, structural stuck on Accela "Intake Requirements Needed" since Sep 3).
// ONE page said two opposite things:
//
//   blocker panel  "Non-prescriptive path: the AHJ requires an original PE stamp on
//                   the structural sheets and a sealed engineering letter"
//   fee card       $360.00  =  $160 Coos County electrical
//                            +  $200 City of Coos Bay STRUCTURAL, off the row titled
//                               "Solar Permit (when required) – PRESCRIPTIVE PATH
//                               System, fee includes plan review"
//
// and that $200 row's OWN stored notes read: "NONPRESCRIPTIVE (engineered) installs
// are charged from the Structural Permit Fee table by valuation, and that valuation
// excludes solar electrical equipment — a different number this row does not cover."
//
// The document half knew she was engineered. The fee half had never heard of the
// permit path at all: evaluateSchedule bracketed on size and valuation and nothing
// else, so a prescriptive-only line was the answer to every Coos Bay project. The
// quote was sourced, citable, confident, and for the wrong path — the same class of
// error as formApplicationKind testing /prescriptive/ before /non-prescriptive/,
// seen from the money side.
//
//   MUST PASS    — the permit path is an INPUT to fee selection, resolved by the SAME
//                  resolver the document gate uses;
//                  an engineered project is refused a prescriptive-only line, with a
//                  reason that leads with what to do and names the row's own words;
//                  the refusal makes the TOTAL unreadable, never smaller;
//                  the quote falls to the labelled estimate carrying that reason,
//                  never to the prescriptive number;
//                  where a table holds BOTH paths, the engineered project is handed
//                  the ENGINEERED line — this is SELECTION, not a veto;
//                  "Non-Prescriptive" classifies ENGINEERED (the ordering that is the
//                  whole correctness of the classifier), tested in both directions.
//   MUST EXCLUDE — Ivy (3.072 kW AC, prescriptive) still totals exactly $335.00 off
//                  the same two rows: the prescriptive row is HIS row;
//                  NOTES ARE NEVER CLASSIFIED — the live row's notes are full of
//                  engineered words and it is a PRESCRIPTIVE row; a classifier over
//                  that blob inverts this gate and hands Ann the $200 again;
//                  an UNKNOWN path contradicts nothing and quotes as it did before;
//                  the ELECTRICAL permit never moves (the path decides which
//                  STRUCTURAL application you file — the electrical permit is the
//                  same permit on either path);
//                  a NEM schedule is untouched, whatever words its lines carry;
//                  and Ivy's uncovered-fee-bracket FLAG still fires — that flag is
//                  the honest half and silencing it would be a new bug.
//
// THE KILL TEST for this file: in feeSchedules.ts make bracketsForPath() return
// `schedule.brackets` unconditionally (the pre-fix behaviour). Checks 3a/3b/3c/4 go
// red — the engineered project is quoted $200 / $360 again — while every
// MUST-EXCLUDE check stays green, because those are the behaviours the fix must not
// touch. That difference IS the finding.
//
//   npx tsx backend/test/feePathScope.test.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-path-scope-test-"));
  // Before anything imports ../src/db.
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  process.env.AUTOPILOT_LOG_FILE = "";
  process.env.SUBMISSION_SERVICE_FEE_USD = "100";

  const { openDatabase } = await import("../src/db");
  const { saveFeeSchedule, feeForProject, feeScheduleProfileKey } = await import("../src/feeSchedules");
  const { resolvePermitPath, pathWordingScope, pathWordingContradicts } = await import("../src/permitPath");
  const { createClient } = await import("../src/clients");
  const { getProjectDetail } = await import("../src/repository");
  const { buildPaymentQuote } = await import("../src/submissionFees");
  const { feeBracketQuantityFields } = await import("../src/feeBracketFields");
  const { feeBracketCoverage } = await import("../../portal-bot/src/feeBracketQuantity");
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

  const STATE = "OR";
  const CITY = { state: STATE, ahj: "City of Coos Bay", track: "permit" as const };
  const COUNTY = { state: STATE, ahj: "Coos County", track: "permit" as const };
  const countyKey = feeScheduleProfileKey(COUNTY, "permit");

  // -------------------------------------------------------------------------
  // THE ROWS, COPIED FROM THE LIVE TABLE. Labels, fees, brackets and the notes
  // paragraph are verbatim from backend/data/autopilot.sqlite — a fixture that
  // paraphrases them proves nothing about the projects this is named after, and
  // the notes in particular ARE one of the traps under test.
  // -------------------------------------------------------------------------
  const CITY_STRUCTURAL_LABEL = "Solar Permit (when required) – Prescriptive Path System, fee includes plan review";
  const CITY_STRUCTURAL_NOTES =
    "Prescriptive path only. NONPRESCRIPTIVE (engineered) installs are charged from the Structural Permit Fee "
    + "table by valuation, and that valuation excludes solar electrical equipment (collector panels and inverters) "
    + "— a different number this row does not cover. | Structural Plan Review is 65% of permit fee where a separate "
    + "plan review applies.";

  saveFeeSchedule(db, { ...CITY, discipline: "structural" }, finding({
    basis: "other",
    brackets: [{ feeUsd: 200, label: CITY_STRUCTURAL_LABEL }],
    notes: CITY_STRUCTURAL_NOTES,
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
  // The city→county hop for electrical, exactly as the live table holds it.
  saveFeeSchedule(db, { ...CITY, discipline: "electrical" }, finding({
    basis: "other", brackets: [], collectedByProfileKey: countyKey,
    sourceUrl: "https://www.coosbayor.gov/home/showpublisheddocument/570/639239531899170000",
    sourceQuote: "a separate Electrical Permit application may also be required through the county",
  }));

  // -------------------------------------------------------------------------
  // THE PROJECTS. Snapshots carry the parser text the live rows carry, so the
  // path is DERIVED here exactly as it is in production — not stipulated.
  // -------------------------------------------------------------------------
  const client = createClient(db, { companyName: "Path Solar", billingMode: "per_submission", serviceFeeUsd: "100" });
  const now = new Date().toISOString();

  /** A real projects row, READ BACK through getProjectDetail. buildPaymentQuote
   *  writes submission_payments, which carries an FK to projects — but the bigger
   *  reason is that the snapshot then round-trips through the column and the
   *  reader production uses, rather than being handed to the evaluator as a
   *  literal the DB never saw. */
  const mkProject = (id: string, ahj: string, acKw: number, dcKw: number, snapshot: Record<string, unknown>) => {
    db.run(
      `INSERT INTO projects (id, client_id, homeowner_name, state, ahj, utility, system_size_ac_kw, system_size_dc_kw, status, parser_json, created_at, updated_at)
       VALUES (?, ?, 'Test Owner', ?, ?, 'Pacific Power', ?, ?, 'ready_to_stage', ?, ?, ?)`,
      [id, client.id, STATE, ahj, acKw, dcKw, JSON.stringify(snapshot), now, now],
    );
    return getProjectDetail(db, id).project;
  };

  // Ann: the parser's verbatim finding. "No PE stamp/seal shown …" routes engineered.
  const ANN = mkProject("proj-ann", "City of Coos Bay", 7.68, 8.36, {
    stampRecommendation: "No PE stamp/seal shown (title block 'Signature with Seal' is blank); AHJ may require stamped structural for 2x4 @16\" rafters",
  });

  // Ivy: a microinverter roof mount that clears the structural screen — prescriptive.
  const IVY = mkProject("proj-ivy", "City of Coos Bay", 3.072, 3.52, {
    mounting: "Roof mount", pvMicroMake: "Enphase", pvMicroModel: "IQ8PLUS-72-2-US",
  });

  // No structural inputs at all: the path is genuinely unconfirmed.
  const UNKNOWN = mkProject("proj-unknown", "City of Coos Bay", 7.68, 8.36, {});

  // -------------------------------------------------------------------------
  // 0. FIXTURE PREMISES. If these drift the rest of the file means nothing.
  // -------------------------------------------------------------------------
  check("premise: Ann resolves ENGINEERED from the parser's own stamp sentence",
    resolvePermitPath(ANN).path === "engineered", resolvePermitPath(ANN).path);
  check("premise: Ivy resolves PRESCRIPTIVE (microinverter roof mount clearing the screen)",
    resolvePermitPath(IVY).path === "prescriptive", resolvePermitPath(IVY).path);
  check("premise: the no-inputs project resolves UNKNOWN",
    resolvePermitPath(UNKNOWN).path === "unknown", resolvePermitPath(UNKNOWN).path);

  // -------------------------------------------------------------------------
  // 1. THE CLASSIFIER'S ORDERING — tested in BOTH directions, because a filter
  //    list fails both ways: one that rejects the target reads as a portal bug,
  //    one that accepts everything reads as no filter at all.
  // -------------------------------------------------------------------------
  const mustBeEngineered = [
    "Structural (Non-Prescriptive) Permit Application",
    "NONPRESCRIPTIVE structural permit",
    "non prescriptive path, by valuation",
    "Engineered system — plan review required",
  ];
  for (const label of mustBeEngineered) {
    check(`  "${label.slice(0, 40)}" classifies ENGINEERED`,
      pathWordingScope(label) === "engineered", pathWordingScope(label));
  }
  const mustBePrescriptive = [CITY_STRUCTURAL_LABEL, "Solar Permit – Prescriptive Path System"];
  for (const label of mustBePrescriptive) {
    check(`  "${label.slice(0, 40)}" classifies PRESCRIPTIVE`,
      pathWordingScope(label) === "prescriptive", pathWordingScope(label));
  }
  // MUST EXCLUDE: a line that names no path must claim none — "" is compatible
  // with both, and widening it would refuse every ordinary fee row in the table.
  for (const label of ["5.01 KVA to 15 KVA | $160.00", "Solar Permit (when required)", "", "Building permit, by valuation"]) {
    check(`  "${label.slice(0, 40) || "(empty)"}" claims NO path`,
      pathWordingScope(label) === "", pathWordingScope(label));
  }
  check("an unknown path contradicts nothing (same rule as formContradictsPath)",
    !pathWordingContradicts("prescriptive", "unknown") && !pathWordingContradicts("engineered", "unknown"));
  check("a no-claim line contradicts nothing",
    !pathWordingContradicts("", "engineered") && !pathWordingContradicts("", "prescriptive"));

  // -------------------------------------------------------------------------
  // 2. MUST EXCLUDE — IVY IS UNCHANGED. His path is prescriptive, so the
  //    prescriptive row is HIS row, and $335.00 is the honest number.
  // -------------------------------------------------------------------------
  const ivy = feeForProject(db, IVY, "permit")!;
  const ivyByDiscipline = Object.fromEntries(ivy.lines.map((l) => [l.discipline, l]));
  check("Ivy still totals exactly $335.00",
    ivy.feeUsd === 335, `${ivy.feeUsd} (${ivy.lines.map((l) => `${l.discipline}=${l.feeUsd}`).join(",")})`);
  check("  Ivy's city STRUCTURAL line is still the $200 prescriptive row, label intact",
    ivyByDiscipline.structural?.feeUsd === 200 && ivyByDiscipline.structural?.bracketLabel === CITY_STRUCTURAL_LABEL,
    `${ivyByDiscipline.structural?.feeUsd} / ${ivyByDiscipline.structural?.bracketLabel}`);
  check("  Ivy's county ELECTRICAL line is still $135 (his 0–5 kVA bracket)",
    ivyByDiscipline.electrical?.feeUsd === 135, String(ivyByDiscipline.electrical?.feeUsd));
  check("  and no line carries a refusal reason",
    ivy.lines.every((l) => !l.reason), ivy.lines.map((l) => l.reason).join(" | "));

  // THE NOTES TRAP, STATED AS ITS OWN CHECK. The row Ivy was just priced from
  // carries "NONPRESCRIPTIVE (engineered) installs are charged from…" in its
  // notes. A classifier pointed at notes rather than at the bracket LABEL reads
  // that row as engineered, refuses Ivy, and hands Ann the $200 — this bug,
  // rebuilt. The row's notes really do say it here, so the trap is armed.
  check("the trap is armed: the prescriptive row's notes are full of engineered words",
    /nonprescriptive/i.test(ivyByDiscipline.structural?.notes ?? "")
    && pathWordingScope(ivyByDiscipline.structural?.notes) === "engineered",
    (ivyByDiscipline.structural?.notes ?? "").slice(0, 80));

  // -------------------------------------------------------------------------
  // 3. MUST PASS — ANN IS REFUSED THE PRESCRIPTIVE ROW.
  // -------------------------------------------------------------------------
  const ann = feeForProject(db, ANN, "permit")!;
  const annByDiscipline = Object.fromEntries(ann.lines.map((l) => [l.discipline, l]));
  const annStructural = annByDiscipline.structural;

  check("3a. Ann's STRUCTURAL line quotes nothing",
    annStructural?.feeUsd === null, String(annStructural?.feeUsd));
  check("  and it is explicitly NOT the $200 prescriptive number",
    annStructural?.feeUsd !== 200, String(annStructural?.feeUsd));
  check("3b. the reason LEADS with what is missing and what to do",
    /^NO ENGINEERED FEE HELD/.test(annStructural?.reason ?? ""), (annStructural?.reason ?? "").slice(0, 120));
  check("  it names the stored line in the jurisdiction's own words",
    (annStructural?.reason ?? "").includes(CITY_STRUCTURAL_LABEL), (annStructural?.reason ?? "").slice(0, 300));
  check("  it hands over the row's own account of the engineered table (the repair)",
    /Structural Permit Fee table by valuation/i.test(annStructural?.reason ?? ""), (annStructural?.reason ?? "").slice(-200));
  check("  and it is NOT dressed as a two-document conflict (nothing disagrees; a number is absent)",
    !/UNRESOLVED FEE CONFLICT/.test(annStructural?.reason ?? ""), (annStructural?.reason ?? "").slice(0, 80));
  check("  the quoted notes are bounded — a 1,500-char research paragraph must not bury the headline",
    (annStructural?.reason ?? "").length < 900, String((annStructural?.reason ?? "").length));

  check("3c. Ann's ELECTRICAL line is untouched at $160 — the path decides the STRUCTURAL permit only",
    annByDiscipline.electrical?.feeUsd === 160, String(annByDiscipline.electrical?.feeUsd));
  check("  and the TOTAL is unreadable, not smaller (an under-quote that looks confident is the bug)",
    ann.feeUsd === null, String(ann.feeUsd));
  check("  the total is neither the old $360 nor a bare $160",
    ann.feeUsd !== 360 && ann.feeUsd !== 160, String(ann.feeUsd));

  // -------------------------------------------------------------------------
  // 4. THE PRODUCTION SEAM. buildPaymentQuote is where the customer's number
  //    comes from; a fix that only moved feeForProject would be invisible here.
  // -------------------------------------------------------------------------
  const annQuote = buildPaymentQuote(db, ANN, "permit");
  check("4. Ann's QUOTE is no longer sourced to the published schedule",
    annQuote.permitFeeSource !== "published_schedule", annQuote.permitFeeSource);
  check("  and it is neither $360 nor $200",
    annQuote.permitFeeUsd !== 360 && annQuote.permitFeeUsd !== 200, String(annQuote.permitFeeUsd));
  check("  the refusal travels with the quote, so the operator can act on it",
    /NO ENGINEERED FEE HELD/.test(annQuote.permitFeeBasis), annQuote.permitFeeBasis.slice(0, 200));
  check("  the fallback is LABELLED an estimate, not presented as the schedule's answer",
    annQuote.permitFeeConfidence !== "verified" && /Rough estimate/i.test(annQuote.permitFeeBasis),
    `${annQuote.permitFeeConfidence} / ${annQuote.permitFeeBasis.slice(0, 80)}`);
  check("  confidence is untouched — nothing here writes 'verified' (hard rule 3)",
    db.query<{ n: number }>("SELECT COUNT(*) AS n FROM fee_schedules WHERE confidence = 'verified'")[0]?.n === 0);

  const ivyQuote = buildPaymentQuote(db, IVY, "permit");
  check("  MUST EXCLUDE: Ivy's quote still comes FROM the schedule, at $335.00",
    ivyQuote.permitFeeUsd === 335 && ivyQuote.permitFeeSource === "published_schedule",
    `${ivyQuote.permitFeeUsd} / ${ivyQuote.permitFeeSource}`);

  // -------------------------------------------------------------------------
  // 5. MUST EXCLUDE — AN UNKNOWN PATH CONTRADICTS NOTHING. We have not decided,
  //    so we cannot claim the row is wrong. (lookupPublishedFee's seam has no
  //    parser snapshot at all and lands here, which is why this matters.)
  // -------------------------------------------------------------------------
  const unknown = feeForProject(db, UNKNOWN, "permit")!;
  check("5. an unconfirmed path quotes exactly as it did before the gate existed ($360.00)",
    unknown.feeUsd === 360, `${unknown.feeUsd} (${unknown.lines.map((l) => `${l.discipline}=${l.feeUsd}`).join(",")})`);

  // -------------------------------------------------------------------------
  // 6. MUST PASS — SELECTION, NOT A VETO. A jurisdiction that publishes BOTH
  //    paths in one table must hand the engineered project the ENGINEERED line.
  //    Refusing there would be the opposite failure: a number we hold, withheld.
  // -------------------------------------------------------------------------
  const BOTH = { state: STATE, ahj: "City of Twopath", track: "permit" as const };
  saveFeeSchedule(db, { ...BOTH, discipline: "structural" }, finding({
    basis: "system_kw",
    brackets: [
      { minKw: 0, maxKw: 25, feeUsd: 200, label: "Solar permit, prescriptive path — flat" },
      { minKw: 0, maxKw: 25, feeUsd: 640, label: "Solar permit, non-prescriptive (engineered) path — includes structural plan review" },
    ],
    sourceUrl: "https://twopath.example.gov/fees",
    sourceQuote: "Solar permit, prescriptive path — flat | $200.00",
  }));
  const twoPathEng = feeForProject(db, { ...ANN, ahj: "City of Twopath" }, "permit")!;
  check("6. an engineered project is handed the ENGINEERED line ($640), not refused and not the $200",
    twoPathEng.feeUsd === 640, `${twoPathEng.feeUsd} / ${twoPathEng.bracketLabel} / ${twoPathEng.reason}`);
  const twoPathPresc = feeForProject(db, { ...IVY, ahj: "City of Twopath" }, "permit")!;
  check("  and a prescriptive project on the same table still gets the $200 line",
    twoPathPresc.feeUsd === 200, `${twoPathPresc.feeUsd} / ${twoPathPresc.bracketLabel}`);

  // -------------------------------------------------------------------------
  // 7. MUST EXCLUDE — THE ELECTRICAL PERMIT NEVER MOVES. The prescriptive /
  //    engineered split decides which STRUCTURAL application you file; the
  //    electrical permit is the same permit on either path, and a rafter that
  //    failed a structural screen must not change what the county bills.
  // -------------------------------------------------------------------------
  const ELEC = { state: STATE, ahj: "City of Elecword", track: "permit" as const };
  saveFeeSchedule(db, { ...ELEC, discipline: "electrical" }, finding({
    basis: "flat",
    brackets: [{ feeUsd: 145, label: "Renewable energy electrical permit, prescriptive installation" }],
    sourceUrl: "https://elecword.example.gov/fees",
    sourceQuote: "Renewable energy electrical permit, prescriptive installation | $145.00",
  }));
  const elecEng = feeForProject(db, { ...ANN, ahj: "City of Elecword" }, "permit")!;
  check("7. an ELECTRICAL row whose label says 'prescriptive' still prices an ENGINEERED project",
    elecEng.feeUsd === 145, `${elecEng.feeUsd} / ${elecEng.reason}`);

  // -------------------------------------------------------------------------
  // 8. MUST EXCLUDE — NEM IS UNTOUCHED. An interconnection schedule is free to
  //    say "engineering study" about a utility review, and letting that word veto
  //    a NEM fee would be a new bug wearing this one's clothes.
  // -------------------------------------------------------------------------
  saveFeeSchedule(db, { state: STATE, utility: "Pacific Power", track: "nem" }, finding({
    basis: "system_kw",
    brackets: [
      { minKw: 0, maxKw: 25, feeUsd: 0, label: "Tier 1 Net Metering Interconnection Review — no fee" },
      { minKw: 25.01, maxKw: 2000, feeUsd: 100, label: "Tier 4 — engineered system impact study application" },
    ],
    sourceUrl: "https://secure.sos.state.or.us/oard/860-039-0045",
    sourceQuote: "Tier 1 Net Metering Interconnection Review — no fee | $0.00",
  }));
  const annNem = feeForProject(db, ANN, "nem")!;
  check("8. Ann's NEM fee is still $0.00 — the permit path says nothing about interconnection",
    annNem.feeUsd === 0, `${annNem.feeUsd} / ${annNem.reason}`);
  // The sharp one: a PRESCRIPTIVE-path project landing on a NEM line whose own
  // label says "engineered". On the permit track that pairing is a contradiction
  // and is refused; on the interconnection track the word describes a utility
  // study and means nothing about the building application, so $100 must stand.
  const bigPrescriptive = { ...IVY, systemSizeAcKw: 40, systemSizeDcKw: 44 };
  const bigNem = feeForProject(db, bigPrescriptive, "nem")!;
  check("  a NEM line whose own label says \"engineered\" still prices a PRESCRIPTIVE-path project at $100",
    bigNem.feeUsd === 100, `${bigNem.feeUsd} / ${bigNem.reason}`);

  // -------------------------------------------------------------------------
  // 9. MUST EXCLUDE — IVY'S UNCOVERED-BRACKET FLAG STILL FIRES. The handoff notes
  //    him as flagged because Coos Bay's recorded Accela recipe has no box for the
  //    0–5 kVA row his job falls in. That flag is the HONEST half of this screen
  //    and rides feeForProject(…, "electrical"); a structural refusal that took it
  //    down with it would trade one silent under-bill for another.
  // -------------------------------------------------------------------------
  const ivyFields = feeBracketQuantityFields(db, IVY);
  check("9. Ivy's fee-bracket boxes still compute, with 0–5 kVA ticked",
    ivyFields["feeBracketQuantity:0-5"] === "1" && ivyFields["feeBracketQuantity:5.01-15"] === "0",
    JSON.stringify(ivyFields));
  const recordedSteps = [
    { action: "fill", field: "feeBracketQuantity:5.01-15" },
    { action: "fill", field: "feeBracketQuantity:15.01-25" },
  ] as never;
  const coverage = feeBracketCoverage(recordedSteps, ivyFields);
  check("  and the recipe-has-no-box-for-this-bracket FLAG still fires for him",
    coverage?.uncovered === true && coverage?.needed === "feeBracketQuantity:0-5",
    JSON.stringify(coverage));
  const annFields = feeBracketQuantityFields(db, ANN);
  check("  MUST EXCLUDE: the engineered project's ELECTRICAL boxes compute too (5.01–15 ticked)",
    annFields["feeBracketQuantity:5.01-15"] === "1", JSON.stringify(annFields));

  console.log(failures ? `\nFAILED ${failures} check(s)` : "\nfeePathScope.test.ts: all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
