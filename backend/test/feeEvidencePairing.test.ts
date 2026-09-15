// THE QUOTE BESIDE THE NUMBER, AND WHETHER ANYTHING CHECKED IT.
//
// Two defects with one root: `source_quote` is stored at ROW grain and was
// displayed as the evidence for a BRACKET-grain claim. A bracketed schedule has
// N rows and exactly one stored quote, so that quote could corroborate at most
// ONE bracket and silently contradicted the other N-1.
//
// MEASURED ON THE LIVE ROW (or|coos county…, permit/electrical, seeded). Its
// brackets are correct and complete — the published Coos County schedule really
// does charge $135 for "5 KVA or less" — and its source_quote is the $160 row:
//
//     3.072 kVA → charged $135.00, evidence contained "$135.00"?  FALSE
//     8     kVA → charged $160.00, evidence contained "$160.00"?  TRUE
//    20     kVA → charged $265.00, evidence contained "$265.00"?  FALSE
//
// Three of four brackets shipped contradicting evidence and only the
// coincidentally-quoted one looked right, so "blank the quote when there is more
// than one line" would have fixed nothing: the SINGLE-line path is broken too.
//
// THE FIX IS NOT TO MOVE THE BRACKET. $135 for a 3.072 kVA AC system is the
// right number, confirmed against the published schedule; a change that shifted
// the amount to agree with the quote would invent a real under/over-quote where
// there was only a mis-grained citation. The mustExclude arms below pin that.
//
// The second half is the dimension that makes the citation checkable at all:
// per-bracket CORROBORATION — a machine went back to the cited document and
// found this bracket's LABEL and its FEE on one coordinate-paired printed line.
// It is a sibling of `confidence`, exactly as FeeScheduleStatus is, and it can
// never become 'verified': that word belongs to a person (hard rule 3).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-evidence-pairing-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  process.env.SUBMISSION_SERVICE_FEE_USD = "100";
  delete process.env.NEM_FEE_ESTIMATE_USD;
  const { openDatabase } = await import("../src/db");
  const {
    saveFeeSchedule, getFeeSchedule, feeScheduleProfileKey, markFeeScheduleVerified,
    lookupPublishedFee, feeLinesForProject, feeForProject, researchFeeSchedule,
    corroborateBrackets, newFeeDocumentLedger, quotedAmounts, FEE_CONFLICT_MARKER,
  } = await import("../src/feeSchedules");
  type Finding = import("../src/feeSchedules").FeeScheduleFinding;
  type Bracket = import("../src/feeSchedules").FeeBracket;
  const { createClient } = await import("../src/clients");
  const { buildPaymentQuote } = await import("../src/submissionFees");
  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   ${name}`);
  };

  const finding = (over: Partial<Finding>): Finding => ({
    found: true, reason: "", basis: "flat", brackets: [], notes: "",
    sourceUrl: "https://co.coos.or.us/files/community_development_fees.pdf",
    sourceQuote: "", sourceKind: "official", ...over,
  });

  // =========================================================================
  // THE LIVE ROW, verbatim. Coos County's published Renewable Energy table
  // (Effective 1/1/2026, Order # CJ 2025-0956, p.8 section F) and the stored
  // quote it actually carries — ONE row of four.
  // =========================================================================
  const COUNTY_URL = "https://co.coos.or.us/files/f9b20f31d/community_development_fees_-_effective_1_1_26.pdf";
  const LIVE_QUOTE = "5.01 KVA to 15 KVA | $160.00 [Coos County Community Development Fee Schedule, "
    + "Effective 1/1/2026, Order # CJ 2025-0956, p.8, section F Renewable Energy]";
  const countyBrackets: Bracket[] = [
    { minKw: 0, maxKw: 5, feeUsd: 135, label: "5 KVA or less | $135.00" },
    { minKw: 5.01, maxKw: 15, feeUsd: 160, label: "5.01 KVA to 15 KVA | $160.00" },
    { minKw: 15.01, maxKw: 25, feeUsd: 265, label: "15.01 KVA to 25 KVA | $265.00" },
    { minKw: 25.01, maxKw: 100, feeUsd: 265, label: "25 KVA rate plus each additional KVA | $265.00 + $10 per add'l kva up to a maximum of 100 kva" },
  ];
  const county = { state: "OR", ahj: "Coos County", track: "permit" as const, discipline: "electrical" };
  const countySave = saveFeeSchedule(db, county, finding({
    basis: "system_kw", brackets: countyBrackets, sourceUrl: COUNTY_URL, sourceQuote: LIVE_QUOTE,
    notes: "Section F, Renewable Energy.",
  }));
  check("the live four-bracket county row saved", countySave.saved, countySave.reason);

  const countyKey = feeScheduleProfileKey(county, "permit");
  // The electrical submittal track names the electrical permit, which is how the
  // real single-line path reaches this row.
  const seam = (kw: number) => lookupPublishedFee(db, {
    track: "electrical", state: "OR", ahj: "Coos County", utility: "", bracketKw: kw,
  });

  // --- the bug, single line -------------------------------------------------
  const small = seam(3.072);
  check("3.072 kVA is still charged $135.00 — MUST EXCLUDE: the bracket did not move",
    small?.feeUsd === 135, JSON.stringify(small));
  check("…and its evidence names $135, the amount actually charged",
    quotedAmounts(small?.bracketQuote).includes(135), small?.bracketQuote);
  check("…and NO LONGER names $160, a bracket this job was not charged",
    !quotedAmounts(small?.bracketQuote).includes(160), small?.bracketQuote);

  const mid = seam(8);
  check("8 kVA is still charged $160.00 — the coincidentally-quoted bracket is unchanged",
    mid?.feeUsd === 160, JSON.stringify(mid));
  check("…and its evidence names $160", quotedAmounts(mid?.bracketQuote).includes(160), mid?.bracketQuote);

  const large = seam(20);
  check("20 kVA is still charged $265.00 — MUST EXCLUDE: the bracket did not move",
    large?.feeUsd === 265, JSON.stringify(large));
  check("…and its evidence names $265, not $160",
    quotedAmounts(large?.bracketQuote).includes(265) && !quotedAmounts(large?.bracketQuote).includes(160),
    large?.bracketQuote);

  // THE INVARIANT, stated once and checked directly: a quote shown beside an
  // amount must be about that amount.
  for (const kw of [3.072, 8, 20]) {
    const r = seam(kw);
    const named = quotedAmounts(r?.bracketQuote);
    check(`INVARIANT @ ${kw} kVA: the displayed evidence never names a fee other than the one charged`,
      r?.feeUsd != null && (!named.length || named.includes(r.feeUsd)),
      `${r?.feeUsd} vs ${JSON.stringify(named)}`);
  }

  // The ROW's own citation is untouched: it is the pointer back to the document,
  // and submissionFees reads it with MAILED_CHECK_RE as a signal about how the
  // money moves. Narrowing it would have been a different regression.
  check("the row's own citation is still carried, unchanged, as provenance",
    (small?.sourceQuote || "").includes("Order # CJ 2025-0956"), small?.sourceQuote);
  check("the stored row itself is untouched — all four brackets, seeded",
    getFeeSchedule(db, countyKey, "permit", "electrical")?.brackets.length === 4
    && getFeeSchedule(db, countyKey, "permit", "electrical")?.confidence === "seeded");

  // --- the bug, two lines ---------------------------------------------------
  // A City of Coos Bay rooftop owes the CITY $200 for the structural permit and
  // the COUNTY $135 for the electrical one. No document anywhere prints $335.
  const city = { state: "OR", ahj: "City of Coos Bay", track: "permit" as const };
  saveFeeSchedule(db, { ...city, discipline: "structural" }, finding({
    basis: "flat",
    brackets: [{ feeUsd: 200, label: "Solar Permit (when required) - Prescriptive Path System | $200.00" }],
    sourceUrl: "https://www.coosbay.org/fee-schedule",
    sourceQuote: "Solar Permit (when required) - Prescriptive Path System, fee includes plan review | $200.00 [Resolution 26-30, Exhibit A, BUILDING FEES, p.8]",
  }));
  saveFeeSchedule(db, { ...city, discipline: "electrical" }, finding({
    basis: "other", brackets: [], collectedByProfileKey: countyKey,
    sourceUrl: "https://www.coosbay.org/fee-schedule",
    sourceQuote: "Solar Structural Installation Permits - separate Electrical Permit application may also be required through the county",
  }));

  // THE SNAPSHOT IS LOAD-BEARING, DO NOT STRIP IT BACK TO {}. The city's $200 line is
  // titled "…Prescriptive Path System", and a line whose own label scopes it to one of
  // the two mutually exclusive permit paths only prices a project KNOWN to be on that
  // path (feeSchedules.bracketsForPath). With an empty snapshot the path resolves
  // UNDECIDED and that line correctly refuses — right behaviour, wrong subject for a
  // file about pairing evidence to amounts. A microinverter roof mount clearing the
  // structural screen is the real shape of the job, and it resolves prescriptive
  // through resolvePermitPath's own rules rather than by stipulation.
  const project = {
    state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power",
    systemSizeAcKw: 3.072, systemSizeDcKw: 4.2,
    parserSnapshot: { mounting: "Roof mount", pvMicroMake: "Enphase", pvMicroModel: "IQ8PLUS-72-2-US" },
  } as never;
  const split = feeForProject(db, project, "permit");
  check("the split still totals $335.00 — MUST EXCLUDE: neither amount moved",
    split?.feeUsd === 335, JSON.stringify(split?.feeUsd));
  check("NO SINGLE QUOTE IS OFFERED AS EVIDENCE FOR A TWO-PERMIT TOTAL",
    split?.bracketQuote === "", `"${split?.bracketQuote}"`);

  const lines = feeLinesForProject(db, project, "permit");
  check("the split is two lines", lines.length === 2, JSON.stringify(lines.map((l) => l.discipline)));
  for (const line of lines) {
    const named = quotedAmounts(line.bracketQuote);
    check(`each line carries its OWN evidence: ${line.discipline} $${line.feeUsd}`,
      line.feeUsd != null && named.includes(line.feeUsd),
      `${line.feeUsd} vs "${line.bracketQuote}"`);
  }
  check("…and the hopped electrical line is the county's $135, not the city's $200",
    lines.find((l) => l.discipline === "electrical")?.feeUsd === 135,
    JSON.stringify(lines.map((l) => [l.discipline, l.feeUsd])));

  // =========================================================================
  // (b) EVIDENCE THAT DISAGREES WITH THE CHARGE IS A CONFLICT, NOT A QUOTE.
  //
  // A row whose stored line names $500 while the bracket matched charges $250 is
  // not a schedule anybody can act on: one of the two numbers is wrong and this
  // screen cannot say which. It degrades exactly the way a two-document conflict
  // already does — refuse the amount, lead with the disagreement.
  // =========================================================================
  const bogus = { state: "OR", ahj: "City of Mismatch", track: "permit" as const, discipline: "electrical" };
  saveFeeSchedule(db, bogus, finding({
    basis: "system_kw",
    brackets: [{ minKw: 0, maxKw: 25, feeUsd: 250, label: "Solar PV up to 25 kVA | $500.00" }],
    sourceUrl: "https://example.gov/fees",
    sourceQuote: "Solar PV up to 25 kVA | $500.00",
  }));
  const mismatch = lookupPublishedFee(db, {
    track: "electrical", state: "OR", ahj: "City of Mismatch", utility: "", bracketKw: 8,
  });
  check("a line whose evidence names a different amount REFUSES to price",
    mismatch !== null && mismatch.feeUsd === null, JSON.stringify(mismatch));
  check("…and says so with the conflict marker the fee seam already recognises",
    (mismatch?.basis || "").includes(FEE_CONFLICT_MARKER), mismatch?.basis);
  check("…naming BOTH numbers, so it is resolvable rather than just alarming",
    (mismatch?.basis || "").includes("$500.00") && (mismatch?.basis || "").includes("$250.00"),
    mismatch?.basis);
  check("…and the ROW's status is untouched: 'conflicted' means two DOCUMENTS disagree",
    getFeeSchedule(db, feeScheduleProfileKey(bogus, "permit"), "permit", "electrical")?.status === "ok");

  const client = createClient(db, { companyName: "Evidence Solar", billingMode: "per_submission", serviceFeeUsd: "100" });
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO projects (id, client_id, homeowner_name, state, ahj, utility, system_size_dc_kw, system_size_ac_kw, status, parser_json, created_at, updated_at)
     VALUES ('fee-evidence-1', ?, 'Test Owner', 'OR', 'City of Mismatch', 'Pacific Power', 10, 8, 'ready_to_stage', '{}', ?, ?)`,
    [client.id, now, now],
  );
  const quote = buildPaymentQuote(db, {
    id: "fee-evidence-1", clientId: client.id, state: "OR", ahj: "City of Mismatch", utility: "Pacific Power",
    systemSizeDcKw: 10, systemSizeAcKw: 8, totalExportKw: null, parserSnapshot: {},
  } as never, "permit");
  check("THE OPERATOR IS TOLD: the conflict leads the fee basis on the quote screen",
    quote.permitFeeBasis.includes(FEE_CONFLICT_MARKER), quote.permitFeeBasis);
  check("…and the amount is NOT quoted from that schedule",
    quote.permitFeeSource !== "published_schedule"
    && quote.permitFeeBasis.includes("THE AMOUNT QUOTED IS NOT FROM THAT SCHEDULE"),
    `${quote.permitFeeSource} ${quote.permitFeeBasis}`);

  // =========================================================================
  // CORROBORATION: the machine check, and the two things it must never be.
  // =========================================================================
  const ledgerWith = (...bodies: string[]) => {
    const l = newFeeDocumentLedger();
    for (const body of bodies) {
      l.evidence.push({ url: COUNTY_URL, via: "http", status: 200, kind: "pdf", bytes: 1234, handed: 10 });
      l.corpus.push(body);
    }
    return l;
  };
  // Exactly the shape openFeeDocument hands back: cells sharing a printed line,
  // left to right, joined " | ", prefixed with the page.
  const COUNTY_PAGE = [
    "8 page(s). Rows are read BY COORDINATE — cells sharing a printed line, left to right, joined \" | \".",
    "p8  F. Renewable Energy",
    "p8  5 KVA or less | $135.00",
    "p8  5.01 KVA to 15 KVA | $160.00",
    "p8  15.01 KVA to 25 KVA | $265.00",
    "p8  Solar Generation greater than 25 KVA",
    "p8  Wind Generation greater than 25 KVA",
    "p8  25.01 KVA to 50 KVA | $346.00",
    "p8  50.01 KVA to 100 KVA | $796.00",
  ].join("\n");

  const corroborated = corroborateBrackets(
    finding({ basis: "system_kw", brackets: countyBrackets.slice(0, 3), sourceUrl: COUNTY_URL }),
    ledgerWith(COUNTY_PAGE),
  );
  check("every real bracket is corroborated off its own printed row",
    corroborated.every((b) => b.corroboration?.corroborated === true),
    JSON.stringify(corroborated.map((b) => [b.feeUsd, b.corroboration?.matchedLine])));
  check("…and the matched line is kept VERBATIM, fee and label together",
    corroborated[0].corroboration?.matchedLine === "p8  5 KVA or less | $135.00",
    corroborated[0].corroboration?.matchedLine);
  check("…recording which document it was read from, and how",
    corroborated[0].corroboration?.sourceUrl === COUNTY_URL && corroborated[0].corroboration?.via === "http",
    JSON.stringify(corroborated[0].corroboration));

  // THE WIND-ROW TRAP. $346 and $796 really are printed on page 8 — on the WIND
  // GENERATION rows. "Does $346 appear in the document?" says yes and is how a
  // third-party summary once reported them as SOLAR brackets. Corroboration must
  // require the fee and the LABEL on ONE line.
  const wind = corroborateBrackets(
    finding({
      basis: "system_kw",
      brackets: [
        { minKw: 25.01, maxKw: 50, feeUsd: 346, label: "Solar Generation 25.01 KVA to 50 KVA" },
        { minKw: 50.01, maxKw: 100, feeUsd: 796, label: "Solar Generation 50.01 KVA to 100 KVA" },
      ],
      sourceUrl: COUNTY_URL,
    }),
    ledgerWith(COUNTY_PAGE),
  );
  check("A FEE PRINTED ON THE WIND ROW DOES NOT CORROBORATE A SOLAR BRACKET",
    wind.every((b) => !b.corroboration), JSON.stringify(wind.map((b) => [b.feeUsd, !!b.corroboration])));

  // A MODEL MUST NEVER BE ABLE TO CORROBORATE ITSELF.
  const selfClaimed = corroborateBrackets(
    finding({
      basis: "flat",
      brackets: [{
        feeUsd: 999, label: "Solar permit, invented",
        corroboration: { corroborated: true, matchedLine: "I read it, honest", sourceUrl: COUNTY_URL, checkedAt: now, via: "http" },
      }],
      sourceUrl: COUNTY_URL,
    }),
    ledgerWith(COUNTY_PAGE),
  );
  check("a bracket that ARRIVES claiming corroboration has it stripped and re-derived",
    !selfClaimed[0].corroboration, JSON.stringify(selfClaimed[0].corroboration));

  const persisted = { state: "OR", ahj: "City of Corroborated", track: "permit" as const, discipline: "electrical" };
  // THE TRUSTED PATH, WHOLE. saveFeeSchedule stores corroboration only for a
  // caller that hands over the LEDGER it was derived from — the bytes this
  // process retrieved — and it re-derives from that ledger rather than believing
  // the brackets. Passing it here is what researchFeeSchedule does on every real
  // pass; feeCorroborationTrust.test.ts pins the other side (no ledger, and a
  // hand-written claim is stripped).
  const persistSave = saveFeeSchedule(db, persisted, finding({
    basis: "system_kw",
    brackets: corroborateBrackets(
      finding({ basis: "system_kw", brackets: countyBrackets.slice(0, 3) }),
      ledgerWith(COUNTY_PAGE),
    ),
    sourceUrl: COUNTY_URL, sourceQuote: LIVE_QUOTE,
  }), { corroborateAgainst: ledgerWith(COUNTY_PAGE) });
  const persistedRow = getFeeSchedule(db, feeScheduleProfileKey(persisted, "permit"), "permit", "electrical");
  // (c) A CORROBORATED SEEDED ROW GAINS CORROBORATION AND NOTHING ELSE.
  check("corroboration survives the save → read round trip, inside brackets_json",
    persistSave.saved && persistedRow?.brackets.every((b) => b.corroboration?.corroborated === true),
    JSON.stringify(persistedRow?.brackets.map((b) => b.corroboration?.matchedLine)));
  check("…and the row is STILL 'seeded' — corroboration is not a promotion (hard rule 3)",
    persistedRow?.confidence === "seeded", persistedRow?.confidence);
  check("…nothing about it was written as 'verified'",
    persistedRow?.verifiedAt === "" && persistedRow?.verifiedBy === "",
    `${persistedRow?.verifiedAt}/${persistedRow?.verifiedBy}`);

  // The corroborated PRINTED ROW is now what a project sees beside its amount —
  // better evidence than the label, and by construction about the right money.
  const corroboratedSeam = lookupPublishedFee(db, {
    track: "electrical", state: "OR", ahj: "City of Corroborated", utility: "", bracketKw: 3.072,
  });
  // Stored through the module's one `clean()`, like every other string it keeps,
  // so runs of white space are folded — the CELLS and the fee are what must
  // survive, and they do.
  check("a corroborated line shows the PRINTED ROW as its evidence",
    corroboratedSeam?.bracketQuote === "p8 5 KVA or less | $135.00", corroboratedSeam?.bracketQuote);
  check("…and the seam reports corroboration as its own dimension, still 'seeded'",
    corroboratedSeam?.corroborated === true && corroboratedSeam?.confidence === "seeded",
    JSON.stringify([corroboratedSeam?.corroborated, corroboratedSeam?.confidence]));

  // =========================================================================
  // (a) A HUMAN-VERIFIED ROW IS NOT TOUCHED BY ANY OF THIS.
  //     Hard rule 3, and the kill-test is byte equality, not a spot check.
  // =========================================================================
  const humanKey = feeScheduleProfileKey({ state: "OR", ahj: "City of Verified" }, "permit");
  saveFeeSchedule(db, { state: "OR", ahj: "City of Verified", track: "permit" }, finding({
    basis: "system_kw", brackets: countyBrackets.slice(0, 3),
    sourceUrl: COUNTY_URL, sourceQuote: LIVE_QUOTE,
  }));
  markFeeScheduleVerified(db, humanKey, "permit", "operator@example.com");
  const frozen = db.get<{ brackets_json: string; source_quote: string; confidence: string }>(
    "SELECT brackets_json, source_quote, confidence FROM fee_schedules WHERE profile_key = ? AND track = 'permit' AND discipline = ''",
    [humanKey],
  )!;
  check("the row is human-verified before the pass", frozen.confidence === "verified");

  const corroboratingResearcher = async (): Promise<Finding> => finding({
    basis: "system_kw",
    brackets: corroborateBrackets(
      finding({ basis: "system_kw", brackets: countyBrackets.slice(0, 3) }),
      ledgerWith(COUNTY_PAGE),
    ),
    sourceUrl: COUNTY_URL, sourceQuote: "5 KVA or less | $135.00",
  });
  const against = await researchFeeSchedule(
    db, { state: "OR", ahj: "City of Verified", track: "permit" },
    { researcher: corroboratingResearcher },
  );
  const after = db.get<{ brackets_json: string; source_quote: string; confidence: string }>(
    "SELECT brackets_json, source_quote, confidence FROM fee_schedules WHERE profile_key = ? AND track = 'permit' AND discipline = ''",
    [humanKey],
  )!;
  check("a corroboration pass against a human-verified row is REFUSED", against.refusedVerified && !against.saved, against.reason);
  check("…brackets_json is byte-identical: no corroboration was written into it",
    after.brackets_json === frozen.brackets_json, after.brackets_json.slice(0, 200));
  check("…the stored quote is byte-identical", after.source_quote === frozen.source_quote);
  check("…and the row is still 'verified', never re-graded by a machine", after.confidence === "verified");
  check("…the finding is still visible in notes, so the disagreement is not lost",
    (getFeeSchedule(db, humanKey, "permit")?.notes || "").toLowerCase().includes("not applied"),
    getFeeSchedule(db, humanKey, "permit")?.notes);

  // NOTHING THIS WORK PRODUCES MAY CALL A MACHINE CHECK "VERIFIED". The word on
  // the operator's screen is CORROBORATED.
  const corroboratedProject = {
    state: "OR", ahj: "City of Corroborated", utility: "Pacific Power",
    systemSizeAcKw: 3.072, systemSizeDcKw: 4.2, parserSnapshot: {},
  } as never;
  const corroboratedBasis = feeForProject(db, corroboratedProject, "electrical");
  db.run(
    `INSERT INTO projects (id, client_id, homeowner_name, state, ahj, utility, system_size_dc_kw, system_size_ac_kw, status, parser_json, created_at, updated_at)
     VALUES ('fee-evidence-2', ?, 'Test Owner', 'OR', 'City of Corroborated', 'Pacific Power', 4.2, 3.072, 'ready_to_stage', '{}', ?, ?)`,
    [client.id, now, now],
  );
  const corroboratedQuote = buildPaymentQuote(db, {
    id: "fee-evidence-2", clientId: client.id, state: "OR", ahj: "City of Corroborated", utility: "Pacific Power",
    systemSizeDcKw: 4.2, systemSizeAcKw: 3.072, totalExportKw: null, parserSnapshot: {},
  } as never, "permit");
  check("the quote screen says CORROBORATED, never 'verified', for a machine check",
    corroboratedQuote.permitFeeBasis.includes("CORROBORATED")
    && !/\bhuman-verified\)/.test(corroboratedQuote.permitFeeBasis.replace("not human-verified", "")),
    corroboratedQuote.permitFeeBasis);
  check("…and the evidence it prints is the printed row for the amount it charges",
    corroboratedQuote.permitFeeUsd === 135
    && corroboratedQuote.permitFeeBasis.includes("5 KVA or less | $135.00")
    && !corroboratedQuote.permitFeeBasis.includes("$160.00"),
    corroboratedQuote.permitFeeBasis);
  check("…the resolution still reports 'seeded' confidence",
    corroboratedBasis?.confidence === "seeded", corroboratedBasis?.confidence);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log("\nfeeEvidencePairing: all checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
