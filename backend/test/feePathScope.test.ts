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
//                  an UNDECIDED path refuses every path-SCOPED line and still prices
//                  every line that claims no path — a visible PARTIAL, never a
//                  confident total (section 5, and see its own header);
//                  "Non-Prescriptive" classifies ENGINEERED (the ordering that is the
//                  whole correctness of the classifier), tested in both directions.
//   MUST EXCLUDE — Ivy (3.072 kW AC, prescriptive) still totals exactly $335.00 off
//                  the same two rows: the prescriptive row is HIS row;
//                  NOTES ARE NEVER CLASSIFIED — the live row's notes are full of
//                  engineered words and it is a PRESCRIPTIVE row; a classifier over
//                  that blob inverts this gate and hands Ann the $200 again;
//                  an undecided path does NOT take the un-scoped lines down with it
//                  (over-exclusion is the mirror-image bug and just as silent);
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
// THE NARROWER KILL TEST, for the UNDECIDED half (section 5): in pathUndecidedGate
// put back `return path === "unresolved";`. Section 5 goes red with the exact
// pre-fix numbers — feeUsd 360, structural $200 — and NOTHING ELSE MOVES: Ivy's
// $335, Ann's refusal, 5b's un-scoped $160 and the seam checks all stay green. Run
// it that way round before believing this file covers the undecided path; the wider
// kill test above cannot tell the two halves apart.
//
// ---------------------------------------------------------------------------
// SECTIONS 10–12: THE SAME GATE, AT THE SEAM THAT HOLDS NO PROJECT.
//
// feeSchedules' lookupPublishedFee builds a synthetic project carrying
// `parserSnapshot: null` — it is handed jurisdiction names and a system size, never
// a plan set — so the permit path there was never merely undecided, it was never
// asked. It used to resolve that empty snapshot to "unknown", "unknown" switched the
// gate off, and the seam handed an ENGINEERED Coos Bay job $200 off the row titled
// "…Prescriptive Path System" — measured on a copy of the live database:
//
//   lookupPublishedFee({track:"permit",  state:"OR", ahj:"City of Coos Bay", bracketKw:7.68})
//     → feeUsd 360   ($160 county electrical + $200 city PRESCRIPTIVE structural)
//   lookupPublishedFee({track:"building",state:"OR", ahj:"City of Coos Bay", bracketKw:7.68})
//     → feeUsd 200   label "Solar Permit (when required) – Prescriptive Path System…"
//
// AND IT HAS ZERO PRODUCTION CALLERS — submissionFees' loader takes the FIRST name
// in `LOOKUP_EXPORTS = ["feeForProject", "lookupPublishedFee"]`, and feeForProject
// is always exported. That fact is why the round that fixed only this seam left the
// live defect standing on feeForProject, and why these sections deliberately do NOT
// carry the gate's real coverage: the decided-path behaviour is proved on
// feeForProject (sections 2, 3, 6) and the undecided-path behaviour in section 5,
// because those are the calls production makes. What is left here is the seam's own
// question — what a lookup that holds no project may say.
//
// The `permitPath` ARGUMENT this seam briefly accepted is gone. Nothing in
// production ever set it, so it was a switch only tests could throw, and a switch
// that silences a refusal without performing the check is worse than no switch.
//
//   MUST PASS    — the seam REFUSES every path-scoped line, and says "PERMIT PATH
//                  NOT CHECKED" rather than the jurisdiction-blaming "NO … FEE HELD"
//                  (different fact, different repair) or the project-blaming
//                  "PERMIT PATH UNDECIDED" (nobody here ever looked at a project);
//                  it names the repair a CALLER can perform — quote through
//                  feeForProject;
//                  archived state reaches ProjectRecord and is SAID on the quote.
//   MUST EXCLUDE — the refusal is about the MISSING PROJECT, not about the row: Ivy
//                  still gets his $200 / $335 through feeForProject, which is the
//                  call that has his plan set;
//                  ELECTRICAL and NEM are untouched;
//                  a row whose lines claim NO path still quotes with no project;
//                  an archived project's AMOUNT is unchanged — it is labelled, not
//                  suppressed, and the stored fee_basis column stays clean.
//
// THE KILL TEST for sections 10–11: in feeSchedules.lookupPublishedFee change
// `permitPath: "unresolved"` to `pathForProject(project, track)` (which returns
// "unknown" for its empty snapshot). 10b goes red — the refusal starts blaming a
// project this call never held. For section 12: drop `archivedAt` from
// repository.mapProject.
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
  const { saveFeeSchedule, feeForProject, feeScheduleProfileKey, lookupPublishedFee } = await import("../src/feeSchedules");
  const { resolvePermitPath, pathWordingScope, pathWordingContradicts } = await import("../src/permitPath");
  const { createClient } = await import("../src/clients");
  const { getProjectDetail } = await import("../src/repository");
  const { buildPaymentQuote, buildProjectFeeSheet } = await import("../src/submissionFees");
  const { archiveProject, unarchiveProject } = await import("../src/projectArchive");
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
    // OPERATOR GROUND TRUTH (2026-09-21): Salem's ISSUED permit 26-108868-DW approved the
    // very roof whose parse said "AHJ *may require* stamped structural" as PRESCRIPTIVE with
    // no stamp — a hedge is a question, not a routing fact, and it no longer forces
    // engineered. This fixture keeps the ENGINEERED arm alive with AFFIRMATIVE language.
    stampRecommendation: "Requires PE-stamped structural plans and a sealed engineering letter — spans exceed the prescriptive tables",
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
  check("premise: Ann resolves ENGINEERED from an AFFIRMATIVE stamp sentence (a hedge no longer routes — see the hedged premise below)",
    resolvePermitPath(ANN).path === "engineered", resolvePermitPath(ANN).path);
  check("premise: Ivy resolves PRESCRIPTIVE (microinverter roof mount clearing the screen)",
    resolvePermitPath(IVY).path === "prescriptive", resolvePermitPath(IVY).path);
  check("premise: the no-inputs project resolves UNKNOWN",
    resolvePermitPath(UNKNOWN).path === "unknown", resolvePermitPath(UNKNOWN).path);
  // THE HEDGE, pinned from the real Reavis/Salem case: "may require" plus no measured facts
  // leaves the path honestly UNDECIDED; the same hedge with a passing screen (2x4 @ 24" OC,
  // snow 36, exposure C) resolves PRESCRIPTIVE — the screen answers, never the wording.
  const HEDGED_BARE = mkProject("proj-hedge-bare", "City of Coos Bay", 5.9, 7.3, {
    stampRecommendation: "No PE stamp or seal present; AHJ may require stamped structural documentation for the 2x4 truss roof",
  });
  check("premise: a HEDGED stamp sentence alone leaves the path UNDECIDED, not engineered",
    resolvePermitPath(HEDGED_BARE).path === "unknown", resolvePermitPath(HEDGED_BARE).path);
  const HEDGED_CLEAN = mkProject("proj-hedge-clean", "City of Salem", 5.9, 7.3, {
    permitPath: "prescriptive", mounting: "Roof mount",
    stampRecommendation: "No PE stamp or seal present; AHJ may require stamped structural documentation for the 2x4 truss roof",
    framingType: "truss", roofRafterSpacing: "24", snow: "36", wind: "C", windSpeed: "95", deadLoad: "2.6",
  });
  check("premise: the SAME hedge with a passing prescriptive screen resolves PRESCRIPTIVE — Salem 26-108868-DW made real",
    resolvePermitPath(HEDGED_CLEAN).path === "prescriptive", JSON.stringify(resolvePermitPath(HEDGED_CLEAN)));
  // THE MEMBRANE ROOF, pinned from the real Simmons/Coos Bay case: TPO with every numeric
  // inside the limits still routes ENGINEERED — "In Oregon, a PV solar installation on a
  // TPO roof is automatically a non-prescriptive project... we had to get stamps for them"
  // (operator, 2026-09-21). His real filing: 187-26-000328-STR, a structural permit.
  const TPO_CLEAN = mkProject("proj-tpo-clean", "City of Coos Bay", 7.04, 6.08, {
    mounting: "Roof mount", roofMaterial: "TPO",
    framingType: "rafter", roofRafterSpacing: "24", roofRafterSpan: "10", snow: "16", wind: "C", windSpeed: "110", deadLoad: "2.64",
  });
  check("premise: MUST PASS — a TPO roof with clean numerics is ENGINEERED (Simmons 187-26-000328-STR made real)",
    resolvePermitPath(TPO_CLEAN).path === "engineered", JSON.stringify(resolvePermitPath(TPO_CLEAN)));
  const SHINGLE_CLEAN = mkProject("proj-shingle-clean", "City of Coos Bay", 7.04, 6.08, {
    mounting: "Roof mount", roofMaterial: "Composition Shingle",
    framingType: "rafter", roofRafterSpacing: "24", roofRafterSpan: "10", snow: "16", wind: "C", windSpeed: "110", deadLoad: "2.64",
  });
  check("premise: MUST EXCLUDE — the SAME numerics on composition shingle stay PRESCRIPTIVE (the material rule must not over-fire)",
    resolvePermitPath(SHINGLE_CLEAN).path === "prescriptive", JSON.stringify(resolvePermitPath(SHINGLE_CLEAN)));

  // ---------------------------------------------------------------------------
  // THE SCREEN IS OREGON'S. Every limit below step 3 of the ladder is ORSC / BCD
  // 440-5952, so it may not judge a project in another state. Audited 2026-09-22:
  // a Columbus, Ohio roof came back "prescriptive — meets prescriptive code, no
  // plan review, reduced fee" with no Ohio rule ever consulted.
  // ---------------------------------------------------------------------------
  const otherState = (state: string, snapshot: Record<string, unknown> = {}) => ({
    ...SHINGLE_CLEAN,
    state,
    parserSnapshot: { ...(SHINGLE_CLEAN as { parserSnapshot: Record<string, unknown> }).parserSnapshot, ...snapshot },
  });
  for (const state of ["FL", "OH", "IA"]) {
    const out = resolvePermitPath(otherState(state));
    check(`MUST PASS: numerics that clear OREGON's screen resolve UNKNOWN in ${state}, never "prescriptive"`,
      out.path === "unknown", JSON.stringify(out.path));
  }
  check("...and the basis SAYS the screen was Oregon's rather than going quiet",
    /Oregon|ORSC|440-5952/i.test(resolvePermitPath(otherState("FL")).basis.join(" ")),
    resolvePermitPath(otherState("FL")).basis.join(" ").slice(0, 120));
  check("a project with NO state on file is treated as unknown, not as Oregon",
    resolvePermitPath(otherState("")).path === "unknown");

  // The jurisdiction-neutral signals above the screen must still rule everywhere —
  // gating the screen must not deafen the resolver to the plan set's own verdict.
  check("MUST EXCLUDE: a Florida plan set that says ENGINEERED still routes engineered",
    resolvePermitPath(otherState("FL", { permitPath: "engineered" })).path === "engineered");
  check("MUST EXCLUDE: an operator override still wins in Florida",
    resolvePermitPath(otherState("FL", { permitPathOverride: "prescriptive" })).path === "prescriptive");
  check("MUST EXCLUDE: affirmative stamp language still routes engineered in Florida",
    resolvePermitPath(otherState("FL", { stampRecommendation: "Requires PE-stamped structural plans and a sealed engineering letter" })).path === "engineered");

  // ---------------------------------------------------------------------------
  // AND THE JURISDICTION'S OWN RESEARCHED LIMITS DECIDE IT. "unknown" is a holding
  // answer, not a destination: touching an un-profiled jurisdiction queues code
  // research, and once its prescriptive block lands the path resolves from THAT
  // jurisdiction's published rule.
  // ---------------------------------------------------------------------------
  const FL = (snapshot: Record<string, unknown> = {}) => otherState("FL", snapshot);
  const flLimits = { hasPrescriptivePath: true, maxRafterSpacingIn: 24, allowedWindExposures: ["B", "C", "D"], maxWindSpeedMphExpC: 165 };

  check("a jurisdiction that publishes NO prescriptive path routes ENGINEERED, citing itself",
    resolvePermitPath(FL(), { limits: { hasPrescriptivePath: false, sourceUrl: "https://floridabuilding.org/" } }).path === "engineered");
  check("MUST PASS: with the jurisdiction's OWN limits on file, a compliant project resolves PRESCRIPTIVE",
    resolvePermitPath(FL(), { limits: flLimits }).path === "prescriptive");
  check("...and a breach of THAT jurisdiction's cap routes engineered, quoting its number not Oregon's",
    /165 mph/.test(resolvePermitPath(FL({ windSpeed: "175" }), { limits: flLimits }).basis.join(" ")),
    resolvePermitPath(FL({ windSpeed: "175" }), { limits: flLimits }).basis.join(" ").slice(0, 120));
  check("MUST EXCLUDE: exposure D is legal under Florida's own limits — Oregon's B/C must not fail it",
    resolvePermitPath(FL({ wind: "D" }), { limits: flLimits }).path === "prescriptive");
  check("MUST EXCLUDE: an absent limit is SKIPPED, never borrowed from Oregon (no snow cap on file)",
    resolvePermitPath(FL({ snow: "90" }), { limits: flLimits }).path === "prescriptive",
    "90 psf exceeds Oregon's 70 but Florida published no snow limit");
  check("MUST EXCLUDE: the Oregon membrane-roof rule does not fire outside Oregon",
    resolvePermitPath(FL({ roofMaterial: "TPO" }), { limits: flLimits }).path === "prescriptive");
  check("...while a TPO roof in OREGON still routes engineered (the Simmons ruling holds)",
    resolvePermitPath(otherState("OR", { roofMaterial: "TPO" })).path === "engineered");

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
  // 5. MUST PASS — AN UNDECIDED PATH BUYS A PATH-SCOPED LINE NOTHING.
  //
  //    THIS SECTION ASSERTED THE OPPOSITE AND WAS CHANGED, because the old
  //    assertion encoded the bug. It read "an unconfirmed path quotes exactly as it
  //    did before the gate existed ($360.00)", on the reasoning that an unknown path
  //    contradicts no row. That reasoning is true (check 1 still pins
  //    pathWordingContradicts saying exactly that) and it is not the question. NOT
  //    CONTRADICTING A ROW IS NOT QUALIFYING FOR IT.
  //
  //    The consequence was that the gate was OFF precisely when the system knew
  //    least: a Coos Bay job whose plan set carried no structural inputs — no screen
  //    run, no operator decision, nothing behind it — was handed $200 off the row
  //    titled "…Prescriptive Path System" inside a sourced, citable $335 total. Ann
  //    was refused that row for being engineered while a project nobody had screened
  //    at all was charged it. That is the same shape as the empty-Set staleness bug:
  //    one value meaning both "fine" and "we could not check".
  //
  //    MEASURED HONESTLY: 0 of the 13 Oregon projects on the live database were in
  //    that state when this was fixed (9 engineered, 4 prescriptive), so no live row
  //    was being mis-quoted that day. UNKNOWN is a state resolvePermitPath reaches
  //    deliberately — step 5, "No structural inputs were parsed" — for any plan set
  //    that parses without them, which is why this is fixed in the mechanism and
  //    proved on a project built to be in it rather than on a row that happened to be.
  //
  //    THE HONEST ANSWER IS A PARTIAL, and it is the shape the split already had for
  //    any other unreadable line (feeDiscipline's "one unreadable line makes the
  //    TOTAL unreadable, not smaller"): what is NOT path-scoped still prices, what IS
  //    comes back unresolved carrying its reason, and the total is null because it is
  //    incomplete. Not a confident $360, and not nothing.
  // -------------------------------------------------------------------------
  const unknown = feeForProject(db, UNKNOWN, "permit")!;
  const unknownByDiscipline = Object.fromEntries(unknown.lines.map((l) => [l.discipline, l]));
  check("5a. an undecided path is no longer quoted the $360 total",
    unknown.feeUsd === null, `${unknown.feeUsd} (${unknown.lines.map((l) => `${l.discipline}=${l.feeUsd}`).join(",")})`);
  check("  and it is explicitly neither the old $360 nor the bare $200 prescriptive row",
    unknown.feeUsd !== 360 && unknown.feeUsd !== 200, String(unknown.feeUsd));

  // THE MIRROR-IMAGE BUG, GUARDED. Over-excluding reads to an operator as a broken
  // gate: the county's electrical row claims NO path, prices the job on either one,
  // and needs no decision. Taking it down over a missing decision it never needed
  // would turn one silent under-quote into a different silent blank.
  check("5b. MUST EXCLUDE: the county ELECTRICAL line claims no path and still prices at $160",
    unknownByDiscipline.electrical?.feeUsd === 160 && !unknownByDiscipline.electrical?.reason,
    `${unknownByDiscipline.electrical?.feeUsd} / ${unknownByDiscipline.electrical?.reason}`);
  check("  so the PARTIAL is visible: the known half is itemised beside the unresolved half",
    /Coos County electrical: \$160\.00/.test(unknown.bracketLabel) && /structural: unresolved/.test(unknown.bracketLabel),
    unknown.bracketLabel);

  const unknownStructural = unknownByDiscipline.structural;
  check("5c. the path-SCOPED structural line refuses — it is not priced and not dropped",
    unknownStructural != null && unknownStructural.feeUsd === null, String(unknownStructural?.feeUsd));
  check("  and leads with PERMIT PATH UNDECIDED",
    /^PERMIT PATH UNDECIDED/.test(unknownStructural?.reason ?? ""), (unknownStructural?.reason ?? "").slice(0, 140));
  // THREE REFUSALS, THREE REPAIRS. Borrowing either sibling's sentence here sends a
  // person to the wrong place: "NO … FEE HELD" blames a table that is perfectly fine
  // and sends them hunting a fee that is sitting right there, and "PERMIT PATH NOT
  // CHECKED" is a developer's repair (pass a project) handed to an operator whose
  // actual repair is to confirm the path.
  check("  NOT the jurisdiction-blaming sentence — this city's table is fine, the project is not screened",
    !/FEE HELD/.test(unknownStructural?.reason ?? ""), (unknownStructural?.reason ?? "").slice(0, 140));
  check("  NOT the never-asked sentence either — resolvePermitPath DID run, against a real snapshot",
    !/NOT CHECKED/.test(unknownStructural?.reason ?? ""), (unknownStructural?.reason ?? "").slice(0, 140));
  check("  and it names the repair an OPERATOR can actually perform: confirm the path",
    /confirm this project's permit path/i.test(unknownStructural?.reason ?? ""), (unknownStructural?.reason ?? "").slice(0, 200));
  check("  it is not dressed as a two-document conflict (nothing disagrees; a decision is missing)",
    !/UNRESOLVED FEE CONFLICT/.test(unknownStructural?.reason ?? ""), (unknownStructural?.reason ?? "").slice(0, 80));
  // ACTIONABLE CLAUSE FIRST IS A LOAD-BEARING RULE, NOT A STYLE NOTE:
  // submissionFees.normalizeScheduleResult slices `reason` to 400 characters on its
  // way to the quote's basis line, and resolutionFrom joins several lines' reasons
  // before that. So the test is not "the string is short" — it is that the headline
  // and the repair SURVIVE THE SLICE, with only the trailing quote of the stored
  // line lost, exactly as its two siblings behave.
  const keptByTheQuote = (unknownStructural?.reason ?? "").slice(0, 400);
  check("  the headline and the repair survive the 400 characters submissionFees keeps of it",
    /^PERMIT PATH UNDECIDED/.test(keptByTheQuote) && /confirm this project's permit path/i.test(keptByTheQuote),
    `${(unknownStructural?.reason ?? "").length} chars: ${keptByTheQuote.slice(-60)}`);
  check("  and the whole reason is still bounded — a research paragraph must not bury it",
    (unknownStructural?.reason ?? "").length < 900, String((unknownStructural?.reason ?? "").length));

  // THE PRODUCTION SEAM FOR THE UNDECIDED CASE. buildPaymentQuote is where the
  // customer's number comes from, and a refusal that never reached it would be
  // invisible: the quote must fall to the LABELLED estimate carrying the reason,
  // never to the prescriptive number wearing a citation.
  const unknownQuote = buildPaymentQuote(db, UNKNOWN, "permit");
  check("5d. the undecided project's QUOTE is not sourced to the published schedule",
    unknownQuote.permitFeeSource !== "published_schedule", unknownQuote.permitFeeSource);
  check("  it is neither $360 nor $200",
    unknownQuote.permitFeeUsd !== 360 && unknownQuote.permitFeeUsd !== 200, String(unknownQuote.permitFeeUsd));
  check("  and the refusal travels with it, so the operator sees what to decide",
    /PERMIT PATH UNDECIDED/.test(unknownQuote.permitFeeBasis) && /Rough estimate/i.test(unknownQuote.permitFeeBasis),
    unknownQuote.permitFeeBasis.slice(0, 200));

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

  // -------------------------------------------------------------------------
  // 10. MUST PASS — A LOOKUP THAT HOLDS NO PROJECT SAYS SO. lookupPublishedFee has
  //     no parser snapshot and no argument that could carry a path, so it says "we
  //     never looked" — never borrowing "we looked and are undecided" (section 5's
  //     fact, about a project) and never "this jurisdiction holds no fee for you"
  //     (section 3's fact, about a table).
  //
  //     Ann's OWN numbers go through it — state, AHJ, AC kW — because that is the
  //     call a future wirer writes, and it is the call that returned $360.
  // -------------------------------------------------------------------------
  const seamArgs = (over: Record<string, unknown> = {}) => ({
    track: "permit", state: STATE, ahj: "City of Coos Bay", utility: "Pacific Power",
    bracketKw: ANN.systemSizeAcKw, systemSizeAcKw: ANN.systemSizeAcKw, systemSizeDcKw: ANN.systemSizeDcKw,
    ...over,
  }) as never;

  const seamNoPath = lookupPublishedFee(db, seamArgs())!;
  check("10a. the seam given NO permit path quotes NOTHING (it used to answer $360)",
    seamNoPath.feeUsd === null, `${seamNoPath.feeUsd} / ${seamNoPath.bracketLabel}`);
  check("  and it is explicitly neither the old $360 total nor the $200 prescriptive row",
    seamNoPath.feeUsd !== 360 && seamNoPath.feeUsd !== 200, String(seamNoPath.feeUsd));
  // THE TWO REFUSALS ARE DIFFERENT FACTS WITH DIFFERENT REPAIRS. "NO ENGINEERED FEE
  // HELD" blames the jurisdiction's table and sends a person to the published
  // schedule; here the table is fine and the CALL is short an input. Printing the
  // first sentence for the second situation sends somebody hunting a fee that is
  // sitting right there, so the wording is pinned, not just the null.
  check("10b. it says the PATH was never checked — not that the jurisdiction holds no fee",
    /PERMIT PATH NOT CHECKED/.test(seamNoPath.basis) && !/FEE HELD/.test(seamNoPath.basis),
    seamNoPath.basis.slice(0, 200));
  check("  nor that the PROJECT is undecided — there is no project here to be undecided about",
    !/PERMIT PATH UNDECIDED/.test(seamNoPath.basis), seamNoPath.basis.slice(0, 200));
  check("  and it names the repair a caller can perform: quote through feeForProject",
    /feeForProject/.test(seamNoPath.basis), seamNoPath.basis.slice(0, 300));

  // The single-line shape: a "building" stage names the structural permit, and
  // this is the call that returned a bare $200 off the prescriptive row.
  const seamBuilding = lookupPublishedFee(db, seamArgs({ track: "building" }))!;
  check("10c. a BUILDING stage through the seam is no longer handed the $200 prescriptive row",
    seamBuilding.feeUsd === null && seamBuilding.bracketLabel !== CITY_STRUCTURAL_LABEL,
    `${seamBuilding.feeUsd} / ${seamBuilding.bracketLabel}`);

  // THE DECIDED-PATH BEHAVIOUR IS PROVED ON feeForProject, NOT HERE, AND THAT IS THE
  // POINT OF THIS BLOCK. It used to be proved by handing this seam a `permitPath`
  // argument — an input NOTHING IN PRODUCTION EVER SET, so the checks that looked
  // like coverage of the gate were coverage of a switch only they could throw. The
  // argument is gone; the same questions are asked of the call production actually
  // makes, which is the one that has a plan set to resolve a path from.
  const annBuilding = feeForProject(db, ANN, "building")!;
  check("10d. ENGINEERED, through the caller production uses: refused, with the jurisdiction reason",
    annBuilding.feeUsd === null && /NO ENGINEERED FEE HELD/.test(annBuilding.reason),
    `${annBuilding.feeUsd} / ${annBuilding.reason.slice(0, 120)}`);
  check("  and never the $200 prescriptive row",
    annBuilding.feeUsd !== 200 && annBuilding.bracketLabel !== CITY_STRUCTURAL_LABEL,
    `${annBuilding.feeUsd} / ${annBuilding.bracketLabel}`);

  // -------------------------------------------------------------------------
  // 11. MUST EXCLUDE — THE REFUSAL IS ABOUT THE MISSING PROJECT, NOT ABOUT THE ROW.
  //     Over-exclusion here would be the opposite failure and just as silent:
  //     every Coos Bay job stops quoting and the prescriptive ones were right.
  // -------------------------------------------------------------------------
  const ivyBuilding = feeForProject(db, IVY, "building")!;
  check("11a. Ivy, PRESCRIPTIVE, is still quoted his legitimate $200 structural line, label intact",
    ivyBuilding.feeUsd === 200 && ivyBuilding.bracketLabel === CITY_STRUCTURAL_LABEL,
    `${ivyBuilding.feeUsd} / ${ivyBuilding.bracketLabel}`);
  check("  and his permit total is still exactly $335.00 — the same two rows, one of them path-scoped to HIM",
    feeForProject(db, IVY, "permit")?.feeUsd === 335, String(feeForProject(db, IVY, "permit")?.feeUsd));

  // THE SEAM'S REFUSAL IS UNIFORM BECAUSE ITS IGNORANCE IS UNIFORM: it never holds a
  // project, so it cannot tell Ivy from Ann and must not pretend to. Feeding it
  // Ivy's numbers is the check that it refuses him the same way — a seam that
  // quoted him would be quoting whoever asked with a small enough kW.
  const seamIvyNumbers = lookupPublishedFee(db, seamArgs({
    track: "building", bracketKw: IVY.systemSizeAcKw,
    systemSizeAcKw: IVY.systemSizeAcKw, systemSizeDcKw: IVY.systemSizeDcKw,
  }))!;
  check("11b. the same seam call with IVY's numbers also refuses — it cannot tell him from Ann",
    seamIvyNumbers.feeUsd === null && /PERMIT PATH NOT CHECKED/.test(seamIvyNumbers.basis),
    `${seamIvyNumbers.feeUsd} / ${seamIvyNumbers.basis.slice(0, 120)}`);

  // The electrical permit is the same permit on either path, so a call with no
  // project does not move it. (Ann's 7.68 kVA sits in the 5.01–15 bracket: $160.)
  check("11c. the ELECTRICAL stage is untouched at $160 with no project supplied",
    lookupPublishedFee(db, seamArgs({ track: "electrical" }))?.feeUsd === 160,
    String(lookupPublishedFee(db, seamArgs({ track: "electrical" }))?.feeUsd));
  check("  and untouched at $160 for the ENGINEERED project through feeForProject",
    feeForProject(db, ANN, "electrical")?.feeUsd === 160,
    String(feeForProject(db, ANN, "electrical")?.feeUsd));
  // NEM: the building path says nothing about interconnection.
  check("11d. the NEM track is untouched at $0.00 with no path supplied",
    lookupPublishedFee(db, seamArgs({ track: "nem" }))?.feeUsd === 0,
    String(lookupPublishedFee(db, seamArgs({ track: "nem" }))?.feeUsd));

  // THE SHARPEST MUST-EXCLUDE: the filter is over lines that CLAIM a path, not over
  // every line. A jurisdiction whose rows name no path prices both paths and needs
  // no decision — refusing there would take the whole table down over a missing
  // input it never needed.
  saveFeeSchedule(db, { state: STATE, ahj: "City of Nopathwords", track: "permit" }, finding({
    basis: "flat",
    brackets: [{ feeUsd: 310, label: "Solar photovoltaic installation permit" }],
    sourceUrl: "https://nopathwords.example.gov/fees",
    sourceQuote: "Solar photovoltaic installation permit | $310.00",
  }));
  check("11e. a schedule whose lines claim NO path still quotes $310 with no path supplied",
    lookupPublishedFee(db, seamArgs({ ahj: "City of Nopathwords" }))?.feeUsd === 310,
    String(lookupPublishedFee(db, seamArgs({ ahj: "City of Nopathwords" }))?.feeUsd));

  // -------------------------------------------------------------------------
  // 12. AN ARCHIVED PROJECT IS QUOTED, AND SAID TO BE ARCHIVED.
  //
  //     Archiving hides a job from the CLIENT portal and deletes nothing, and
  //     projectArchive.ts is explicit that operator surfaces keep showing it. So
  //     the fee is NOT suppressed — a suppressed fee reaches the sheet through the
  //     same `known:false` channel as "we have no schedule", which is an amount we
  //     know re-rendered as an unknown. What was missing is that archived_at never
  //     reached ProjectRecord, so nothing built on a record could say it.
  //
  //     Driven through the REAL write path (archiveProject → the column →
  //     getProjectDetail → mapProject), not by stipulating a field on a literal.
  // -------------------------------------------------------------------------
  const liveIvyQuote = buildPaymentQuote(db, IVY, "permit");
  const arch = archiveProject(db, IVY.id, "Superseded pass — the certified run is proj-ivy-2");
  check("12. archiveProject wrote the column through its own API", arch.archived, arch.reason);

  const archivedIvy = getProjectDetail(db, IVY.id).project;
  check("  archived_at now travels ON THE RECORD (it was stored and never mapped)",
    !!String(archivedIvy.archivedAt || "").trim(), JSON.stringify(archivedIvy.archivedAt));
  check("  and so does the reason, which is the only thing that explains it later",
    /Superseded pass/.test(String(archivedIvy.archivedReason || "")), String(archivedIvy.archivedReason));

  const archivedQuote = buildPaymentQuote(db, archivedIvy, "permit");
  check("12a. the quote SAYS the project is archived, on the sentence already drawn beside the amount",
    /^ARCHIVED PROJECT/.test(archivedQuote.permitFeeBasis), archivedQuote.permitFeeBasis.slice(0, 120));
  check("  and hands over the reason, so it is actionable rather than just a scold",
    /Superseded pass/.test(archivedQuote.permitFeeBasis), archivedQuote.permitFeeBasis.slice(0, 220));
  check("12b. MUST EXCLUDE: the AMOUNT is unchanged — labelled, never suppressed",
    archivedQuote.permitFeeUsd === liveIvyQuote.permitFeeUsd && archivedQuote.permitFeeUsd === 335,
    `${archivedQuote.permitFeeUsd} vs ${liveIvyQuote.permitFeeUsd}`);
  check("  and the basis it labels is still the schedule's own account of the number",
    /published fee schedule/i.test(archivedQuote.permitFeeBasis), archivedQuote.permitFeeBasis.slice(-200));
  const archivedSheet = buildProjectFeeSheet(db, archivedIvy);
  check("12c. the FEE SHEET carries it too — one chokepoint, both screens",
    /^ARCHIVED PROJECT/.test(archivedSheet.lines[0].basis) && archivedSheet.lines[0].known,
    archivedSheet.lines[0].basis.slice(0, 80));

  // A DISPLAY VALUE, NOT A STORED ONE. The archive is reversible, so a notice baked
  // into submission_payments.fee_basis would outlive the fact it reports.
  const storedBasis = String(db.query<{ fee_basis: string }>(
    "SELECT fee_basis FROM submission_payments WHERE project_id = ? AND track = 'permit'", [IVY.id],
  )[0]?.fee_basis || "");
  check("12d. the STORED fee_basis column is untouched — the notice is computed per quote",
    storedBasis.length > 0 && !/ARCHIVED PROJECT/.test(storedBasis), storedBasis.slice(0, 100));

  unarchiveProject(db, IVY.id);
  const revived = getProjectDetail(db, IVY.id).project;
  check("12e. MUST EXCLUDE: un-archiving clears the notice — nothing had to be scrubbed",
    !String(revived.archivedAt || "").trim()
    && !/ARCHIVED PROJECT/.test(buildPaymentQuote(db, revived, "permit").permitFeeBasis));

  console.log(failures ? `\nFAILED ${failures} check(s)` : "\nfeePathScope.test.ts: all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
