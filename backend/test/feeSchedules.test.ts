// Fee schedules: a schedule is a FUNCTION, not a price.
//
// Pins the four things that make a stored schedule trustworthy enough to drive a
// permit application's fee-BRACKET field (the Coos Bay failure: a frozen
// "5.01kva through 15kva" answer replayed onto a 20 kW job):
//   1. the right bracket is picked, and the BOUNDARY is exact;
//   2. a human-'verified' row survives a research pass that disagrees, and the
//      disagreement lands in notes instead of silently rewriting the row;
//   3. a fee with no source quote is refused, not stored;
//   4. "this utility charges nothing" (sourced flat $0) stays distinguishable
//      from "we could not find out" (found:false).
// No network: the researcher is injected.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-schedules-test-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  const { openDatabase } = await import("../src/db");
  const {
    researchFeeSchedule, feeForProject, getFeeSchedule, feeScheduleProfileKey,
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
    sourceUrl: "https://example.gov/fees", sourceQuote: "Solar photovoltaic permit fee: $175.00.",
    sourceKind: "official", ...over,
  });
  const researcherOf = (f: Finding) => async () => f;

  // 0. The migration landed a real table with the (profile_key, track) unique key.
  const cols = db.query<{ name: string }>("PRAGMA table_info(fee_schedules)").map((c) => c.name);
  check("migration created fee_schedules", cols.includes("brackets_json") && cols.includes("source_quote") && cols.includes("confidence"), cols.join(","));
  const idx = db.query<{ name: string; unique: number }>("PRAGMA index_list(fee_schedules)");
  check("unique index on (profile_key, track)", idx.some((i) => i.name === "idx_fee_schedules_profile_track" && Number(i.unique) === 1));

  // ---------------------------------------------------------------------
  // 1. A bracketed permit schedule, and the boundary that is the whole point.
  // ---------------------------------------------------------------------
  const coosBayBrackets = [
    { minKw: 0, maxKw: 5, feeUsd: 120, label: "Renewable energy for electrical systems- up to 5kva" },
    { minKw: 5.01, maxKw: 15, feeUsd: 175, label: "Renewable energy for electrical systems- 5.01kva through 15kva" },
    { minKw: 15.01, maxKw: 25, feeUsd: 260, label: "Renewable energy for electrical systems- 15.01kva through 25kva" },
    { minKw: 25.01, maxKw: null, feeUsd: 400, label: "Renewable energy for electrical systems- over 25kva" },
  ];
  const coos = await researchFeeSchedule(
    db,
    { state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", track: "permit" },
    { researcher: researcherOf(finding({
      basis: "system_kw", brackets: coosBayBrackets,
      notes: "Combined building + electrical solar permit.",
      sourceUrl: "https://www.coosbay.org/fees",
      sourceQuote: "Renewable energy for electrical systems- 5.01kva through 15kva ... $175.00",
    })) },
  );
  check("bracketed schedule saved as seeded", coos.saved && coos.schedule?.confidence === "seeded", `${coos.saved} ${coos.reason}`);
  check("schedule keeps all four bracket rows in order", coos.schedule?.brackets.length === 4 && coos.schedule.brackets[0].feeUsd === 120);
  // Permit schedules key on (state, ahj) — NOT the utility, or the same city
  // under two utilities would file two schedules and every lookup would miss.
  check(
    "permit profile key ignores the utility",
    feeScheduleProfileKey({ state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power" }, "permit")
      === feeScheduleProfileKey({ state: "OR", ahj: "City of Coos Bay", utility: "PGE" }, "permit"),
  );

  const proj = (kw: number, ahj = "City of Coos Bay") => ({
    state: "OR", ahj, utility: "Pacific Power",
    systemSizeAcKw: kw, systemSizeDcKw: kw, parserSnapshot: {},
  }) as never;

  const small = feeForProject(db, proj(5.67), "permit");
  check("5.67 kW resolves to the 5.01–15 bracket", small?.feeUsd === 175 && small.bracketLabel.includes("5.01kva through 15kva"), JSON.stringify(small));
  const big = feeForProject(db, proj(20), "permit");
  check("20 kW resolves to the 15.01–25 bracket, NOT the frozen one", big?.feeUsd === 260 && big.bracketLabel.includes("15.01kva through 25kva"), JSON.stringify(big));

  // KILL-TEST: the boundary itself. 15.00 is the last kW of the lower bracket
  // and 15.01 the first of the next — an off-by-one here bills the wrong tier
  // on exactly the systems that sit on a bracket edge.
  const atBoundary = feeForProject(db, proj(15), "permit");
  check("exactly 15.00 kW stays in the LOWER bracket", atBoundary?.feeUsd === 175, JSON.stringify(atBoundary?.feeUsd));
  const overBoundary = feeForProject(db, proj(15.01), "permit");
  check("15.01 kW crosses into the UPPER bracket", overBoundary?.feeUsd === 260, JSON.stringify(overBoundary?.feeUsd));
  const huge = feeForProject(db, proj(60), "permit");
  check("open-ended top bracket catches 60 kW", huge?.feeUsd === 400, JSON.stringify(huge?.feeUsd));
  check("resolution carries the source back to the caller", small?.sourceUrl === "https://www.coosbay.org/fees" && small.confidence === "seeded");

  // Fuzzy fallback: the project spells it "Coos Bay", the schedule "City of Coos Bay".
  const fuzzy = feeForProject(db, proj(20, "Coos Bay"), "permit");
  check("fuzzy AHJ name still finds the schedule", fuzzy?.feeUsd === 260 && fuzzy.matchedName === "City of Coos Bay", JSON.stringify(fuzzy));
  // A like-named city in another state must NOT match.
  const wrongState = feeForProject(db, { state: "CA", ahj: "Coos Bay", utility: "PGE", systemSizeAcKw: 20, systemSizeDcKw: 20, parserSnapshot: {} } as never, "permit");
  check("state mismatch loses (no cross-state schedule)", wrongState === null);

  // ---------------------------------------------------------------------
  // 2. Flat schedules, and "no fee" as a real finding.
  // ---------------------------------------------------------------------
  const ameren = await researchFeeSchedule(
    db,
    { state: "IL", utility: "Ameren Illinois", track: "nem" },
    { researcher: researcherOf(finding({
      basis: "flat",
      brackets: [{ feeUsd: 50, label: "Level 1 interconnection application fee" }],
      notes: "Paid by MAILED CHECK within 15 business days — automation never pays it.",
      sourceUrl: "https://www.ameren.com/illinois/interconnection",
      sourceQuote: "A $50 application fee must be submitted by check within 15 business days.",
    })) },
  );
  check("flat NEM schedule saved", ameren.saved && ameren.schedule?.basis === "flat");
  const amerenProj = { state: "IL", ahj: "City of Decatur", utility: "Ameren Illinois", systemSizeAcKw: 9.6, systemSizeDcKw: 11.2, parserSnapshot: {} } as never;
  const amerenFee = feeForProject(db, amerenProj, "nem");
  check("flat schedule resolves flat regardless of size", amerenFee?.feeUsd === 50 && amerenFee.bracketLabel.includes("Level 1"), JSON.stringify(amerenFee));
  // NEM keys on (state, utility): the AHJ must not change the answer.
  const amerenOtherAhj = feeForProject(db, { ...(amerenProj as object), ahj: "Village of Forsyth" } as never, "nem");
  check("nem schedule is utility-grained, not AHJ-grained", amerenOtherAhj?.feeUsd === 50);

  // A sourced ZERO is a finding. It must read as $0, not as "unknown".
  const pge = await researchFeeSchedule(
    db,
    { state: "OR", utility: "Portland General Electric", track: "nem" },
    { researcher: researcherOf(finding({
      basis: "flat", brackets: [{ feeUsd: 0, label: "No application fee" }],
      sourceUrl: "https://portlandgeneral.com/net-metering",
      sourceQuote: "There is no application fee for residential net metering.",
    })) },
  );
  const pgeFee = feeForProject(db, { state: "OR", ahj: "City of Coos Bay", utility: "Portland General Electric", systemSizeAcKw: 7, systemSizeDcKw: 8, parserSnapshot: {} } as never, "nem");
  check("sourced $0 stores as a real schedule", pge.saved && pge.found);
  check("sourced $0 resolves to 0, not null", pgeFee !== null && pgeFee.feeUsd === 0, JSON.stringify(pgeFee));

  // ...and "could not find out" stores NOTHING, so the caller sees null.
  const unknownUtil = await researchFeeSchedule(
    db,
    { state: "WA", utility: "Cowlitz PUD", track: "nem" },
    { researcher: researcherOf(finding({ found: false, reason: "No published interconnection fee located on the utility's site." })) },
  );
  check("found:false is not saved", unknownUtil.saved === false && unknownUtil.found === false && unknownUtil.reason.includes("No published"));
  const unknownFee = feeForProject(db, { state: "WA", ahj: "City of Kelso", utility: "Cowlitz PUD", systemSizeAcKw: 7, systemSizeDcKw: 8, parserSnapshot: {} } as never, "nem");
  check("no stored schedule resolves to null (NOT $0)", unknownFee === null);
  check("stored $0 and found:false are distinguishable", pgeFee?.feeUsd === 0 && unknownFee === null);

  // ---------------------------------------------------------------------
  // 3. A fee with no quote is a rumour — refused.
  // ---------------------------------------------------------------------
  const noQuote = await researchFeeSchedule(
    db,
    { state: "ID", ahj: "Elmore County", track: "permit" },
    { researcher: researcherOf(finding({ basis: "flat", brackets: [{ feeUsd: 250, label: "Solar permit" }], sourceUrl: "https://elmorecounty.org/fees", sourceQuote: "" })) },
  );
  check("unquoted fee is refused", noQuote.saved === false && noQuote.found === false && noQuote.reason.toLowerCase().includes("source"), noQuote.reason);
  check("unquoted fee stored nothing", getFeeSchedule(db, feeScheduleProfileKey({ state: "ID", ahj: "Elmore County" }, "permit"), "permit") === null);
  const noUrl = await researchFeeSchedule(
    db,
    { state: "ID", ahj: "Elmore County", track: "permit" },
    { researcher: researcherOf(finding({ basis: "flat", brackets: [{ feeUsd: 250 }], sourceUrl: "", sourceQuote: "Solar permit fee is $250." })) },
  );
  check("fee with a quote but no URL is refused too", noUrl.saved === false && noUrl.found === false);

  // ---------------------------------------------------------------------
  // 4. Human-verified is never auto-overwritten (hard rule 3) — but 'seeded'
  //    MUST still update, or the guard is just a wall (a filter that rejects
  //    everything passes a one-sided test).
  // ---------------------------------------------------------------------
  const coosKey = feeScheduleProfileKey({ state: "OR", ahj: "City of Coos Bay" }, "permit");
  const reseeded = await researchFeeSchedule(
    db,
    { state: "OR", ahj: "City of Coos Bay", track: "permit" },
    { researcher: researcherOf(finding({
      basis: "system_kw",
      brackets: coosBayBrackets.map((b) => ({ ...b, feeUsd: b.feeUsd + 10 })),
      sourceUrl: "https://www.coosbay.org/fees", sourceQuote: "2027 schedule: 5.01kva through 15kva ... $185.00",
    })) },
  );
  check("a SEEDED row is updated by a later pass", reseeded.saved === true && reseeded.refusedVerified === false);
  check("seeded update actually moved the number", feeForProject(db, proj(5.67), "permit")?.feeUsd === 185);

  const verified = markFeeScheduleVerified(db, coosKey, "permit", "operator@example.com");
  check("verify marks the row", verified?.confidence === "verified" && verified.verifiedBy === "operator@example.com");
  const frozenBrackets = db.get<{ brackets_json: string }>("SELECT brackets_json FROM fee_schedules WHERE profile_key = ? AND track = 'permit'", [coosKey])!.brackets_json;

  const overwrite = await researchFeeSchedule(
    db,
    { state: "OR", ahj: "City of Coos Bay", track: "permit" },
    { researcher: researcherOf(finding({
      basis: "flat", brackets: [{ feeUsd: 999, label: "Solar permit (bogus)" }],
      sourceUrl: "https://random-blog.example.com/or-solar-fees",
      sourceQuote: "Coos Bay charges $999 for a solar permit.",
      sourceKind: "third_party",
    })) },
  );
  // KILL-TEST for the guard: bytes unchanged, confidence unchanged, AND the
  // finding must be visible in notes — a guard that drops the finding on the
  // floor hides the disagreement instead of surfacing it.
  check("verified row refuses the research pass", overwrite.saved === false && overwrite.refusedVerified === true, overwrite.reason);
  const after = getFeeSchedule(db, coosKey, "permit")!;
  const afterBrackets = db.get<{ brackets_json: string }>("SELECT brackets_json FROM fee_schedules WHERE profile_key = ? AND track = 'permit'", [coosKey])!.brackets_json;
  check("verified row's brackets are byte-identical afterwards", afterBrackets === frozenBrackets);
  check("verified row keeps its confidence and basis", after.confidence === "verified" && after.basis === "system_kw");
  check("verified row still resolves the verified number", feeForProject(db, proj(5.67), "permit")?.feeUsd === 185);
  check("the disagreeing finding landed in notes", after.notes.includes("999") && after.notes.toLowerCase().includes("not applied"), after.notes);
  check("notes stay ' | '-joined segments", after.notes.split(" | ").length >= 2, after.notes);

  // ---------------------------------------------------------------------
  // 5. A schedule that cannot be evaluated says so — it never reads as $0.
  // ---------------------------------------------------------------------
  await researchFeeSchedule(
    db,
    { state: "OR", ahj: "City of Albany", track: "permit" },
    { researcher: researcherOf(finding({
      basis: "valuation",
      brackets: [
        { minValuationUsd: 0, maxValuationUsd: 25000, feeUsd: 200 },
        { minValuationUsd: 25000.01, maxValuationUsd: null, feeUsd: 450 },
      ],
      sourceUrl: "https://www.cityofalbany.net/fees",
      sourceQuote: "Valuation $0–$25,000: $200.00; over $25,000: $450.00.",
    })) },
  );
  const albany = feeForProject(db, { state: "OR", ahj: "City of Albany", utility: "PGE", systemSizeAcKw: 10, systemSizeDcKw: 10.12, parserSnapshot: {} } as never, "permit");
  check("valuation schedule resolves from the project's valuation", albany?.feeUsd === 450, JSON.stringify(albany));
  const noSize = feeForProject(db, { state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", systemSizeAcKw: null, systemSizeDcKw: null, parserSnapshot: {} } as never, "permit");
  check("size-bracketed schedule with no system size reports unresolved, not $0", noSize !== null && noSize.feeUsd === null && noSize.reason.includes("system size"), JSON.stringify(noSize));

  // ---------------------------------------------------------------------
  // 6. The seam submissionFees.ts loads by name. Its loader is SILENT when the
  //    export is missing (it warns only on a require error), so a rename here
  //    would make the whole published-schedule tier vanish without a word.
  // ---------------------------------------------------------------------
  const { lookupPublishedFee } = await import("../src/feeSchedules");
  check("the seam export exists under the name the consumer loads", typeof lookupPublishedFee === "function");
  // The Coos Bay row is VERIFIED by now and holds the +10 brackets.
  const seamBracketed = lookupPublishedFee(db, { track: "permit", state: "OR", ahj: "Coos Bay", utility: "Pacific Power", bracketKw: 20, systemSizeAcKw: 20, systemSizeDcKw: 22, valuationUsd: null });
  check("seam resolves the bracket from bracketKw", seamBracketed?.feeUsd === 270 && (seamBracketed.bracketLabel || "").includes("15.01kva through 25kva"), JSON.stringify(seamBracketed));
  check("seam reports the jurisdiction's own name and a human basis", seamBracketed?.jurisdictionName === "City of Coos Bay" && seamBracketed.basis.startsWith("Published fee schedule"), JSON.stringify(seamBracketed?.basis));
  check("seam carries the verified confidence through", seamBracketed?.confidence === "verified");
  const seamZero = lookupPublishedFee(db, { track: "nem", state: "OR", ahj: "City of Coos Bay", utility: "Portland General Electric", bracketKw: 7 });
  check("seam returns a sourced $0 as 0, not null", seamZero?.feeUsd === 0, JSON.stringify(seamZero));
  const seamNone = lookupPublishedFee(db, { track: "nem", state: "WA", ahj: "City of Kelso", utility: "Cowlitz PUD", bracketKw: 7 });
  check("seam returns null when nothing is stored", seamNone === null);
  // A valuation-keyed schedule gets no parser snapshot here: without valuationUsd
  // it must say it cannot answer, and the ladder falls through rather than $0.
  const seamNoValuation = lookupPublishedFee(db, { track: "permit", state: "OR", ahj: "City of Albany", utility: "PGE", bracketKw: 10 });
  check("seam with no valuation reports unresolved, not $0", seamNoValuation !== null && seamNoValuation.feeUsd === null && seamNoValuation.basis.includes("valuation"), JSON.stringify(seamNoValuation));
  const seamValuation = lookupPublishedFee(db, { track: "permit", state: "OR", ahj: "City of Albany", utility: "PGE", bracketKw: 10, valuationUsd: 20000 });
  check("seam brackets on the valuation it is handed", seamValuation?.feeUsd === 200, JSON.stringify(seamValuation));

  // ---------------------------------------------------------------------
  // 6. THE RESEARCH CLOCK. Not a schedule fact — a fact about whether we ever
  //    get one. The live researcher takes 62-82s against the jurisdictions we
  //    actually file in; a ceiling under that aborts every real call, and an
  //    abort returns found:false, the SAME channel as "this jurisdiction
  //    publishes nothing". So a too-tight constant turns the whole feature off
  //    and reports it as an absence of fees. Both halves are pinned here: the
  //    default may not drop back under the client's own timeout, and a run that
  //    ran out of clock must SAY so rather than pass for a finding.
  // ---------------------------------------------------------------------
  const { feeResearchTimeoutMs, FEE_RESEARCH_CLIENT_TIMEOUT_MS, claudeFeeScheduleResearcher } = await import("../src/feeSchedules");
  const savedTimeout = process.env.FEE_RESEARCH_TIMEOUT_MS;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.FEE_RESEARCH_TIMEOUT_MS;
  check("default research ceiling is the client's own timeout, not a tighter budget",
    feeResearchTimeoutMs() === FEE_RESEARCH_CLIENT_TIMEOUT_MS && FEE_RESEARCH_CLIENT_TIMEOUT_MS >= 240000,
    `${feeResearchTimeoutMs()} vs ${FEE_RESEARCH_CLIENT_TIMEOUT_MS}`);
  check("a live call would outlast the 62-82s the real jurisdictions took", feeResearchTimeoutMs() > 120000, `${feeResearchTimeoutMs()}ms`);
  process.env.FEE_RESEARCH_TIMEOUT_MS = "45000";
  check("an operator's override still wins", feeResearchTimeoutMs() === 45000, `${feeResearchTimeoutMs()}`);

  // No network: a 1ms ceiling aborts before the request is ever made.
  process.env.FEE_RESEARCH_TIMEOUT_MS = "1";
  process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key-this-call-is-aborted-first";
  const timedOut = await claudeFeeScheduleResearcher({ state: "OR", ahj: "Timeout Probe City", track: "permit" });
  check("a timed-out run is not reported as a finding", timedOut.found === false);
  check("a timed-out run SAYS it timed out, not 'Request was aborted'",
    /timed out/i.test(timedOut.reason) && /NOT a finding/i.test(timedOut.reason), timedOut.reason);
  check("and names the knob that fixes it", timedOut.reason.includes("FEE_RESEARCH_TIMEOUT_MS"), timedOut.reason);
  check("a timed-out run stores nothing", (await researchFeeSchedule(db, { state: "OR", ahj: "Timeout Probe City", track: "permit" })).saved === false);
  check("…and leaves no row behind to read as a $0", getFeeSchedule(db, feeScheduleProfileKey({ state: "OR", ahj: "Timeout Probe City" }, "permit"), "permit") === null);
  if (savedTimeout === undefined) delete process.env.FEE_RESEARCH_TIMEOUT_MS; else process.env.FEE_RESEARCH_TIMEOUT_MS = savedTimeout;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;

  // Close before deleting the scratch DB - Windows holds the open handle as a file lock (EBUSY).
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log("\nfeeSchedules: all checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
