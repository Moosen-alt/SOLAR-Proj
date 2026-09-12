// A DISPUTED FEE, AND THE FALL-THROUGH THAT USED TO BE THE ONLY THING STOPPING US QUOTING IT.
//
// Coos County publishes its adopted schedule — $135 / $160 / $265, "Effective 7-1-25" — and
// links, from its own solar page, a permit application still printing 2022 fees — $79 / $94 /
// $156, "Revised 12/23/2022". Every row is uniformly 1.70x apart: one blanket increase, not
// two different fee types. jurisdictionHarvest.ts detects that and stores both candidates.
//
// THE BUG THIS FILE EXISTS FOR IS NOT THE DETECTION. It is how the refusal was ACHIEVED. The
// harvester could not edit feeSchedules.ts, so it reached "do not answer" by storing the row
// as basis "other" with >= 2 brackets — the one shape that falls past every branch of
// evaluateSchedule to `miss("Schedule basis \"other\" needs a human to read it")`. Its author
// wrote the coupling down in as many words: "if basis 'other' with multiple brackets ever
// becomes evaluable, conflicted schedules silently start answering with one of the two
// disputed numbers." A safety property resting on a fall-through nobody reading the evaluator
// would recognise as load-bearing, and no test would have gone red.
//
//   MUST PASS    — the conflict is QUERYABLE (fee_schedules.status), not only prose in notes;
//                  a conflicted row refuses BOTH disputed numbers;
//                  the refusal survives a future where basis-"other"-with-many-brackets
//                  becomes evaluable — proved by conflicting rows whose shape the evaluator
//                  ANSWERS when the status is cleared (tests 3a/3b are the whole point);
//                  each source carries its own document date, conflicted or not;
//                  the quote SAYS "conflict" and names both numbers and both dates.
//   MUST EXCLUDE — a human 'verified' stamp does not make a disputed row quotable;
//                  an automated re-save cannot answer the question by winning the race;
//                  a conflict does not BLOCK the filing (the estimate tier still quotes);
//                  and a jurisdiction with no schedule at all does not read as a conflict.
//
// The kill test for this file: delete the `schedule.status === "conflicted"` branch at the top
// of evaluateSchedule. Tests 3a and 3b go red — the conflicted flat row answers $135 and the
// conflicted system_kw row answers $160 — while the basis-"other" checks stay green, because
// that is the accident still working. That difference IS the finding.
//
//   npx tsx backend/test/feeConflict.test.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-conflict-test-"));
  // Before anything imports ../src/db.
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  process.env.AUTOPILOT_LOG_FILE = "";
  process.env.SUBMISSION_SERVICE_FEE_USD = "100";

  const { openDatabase } = await import("../src/db");
  const {
    saveFeeSchedule, feeForProject, lookupPublishedFee, getFeeSchedule, markFeeScheduleVerified,
    feeScheduleProfileKey, conflictSummary, FEE_CONFLICT_MARKER,
  } = await import("../src/feeSchedules");
  const { createClient } = await import("../src/clients");
  const { buildPaymentQuote } = await import("../src/submissionFees");
  type Finding = import("../src/feeSchedules").FeeScheduleFinding;
  type Source = import("../src/feeSchedules").FeeScheduleSource;

  let db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   ${name}`);
  };

  const STATE = "OR";
  const url = "https://co.coos.or.us/sites/default/files/fee-schedule.pdf";

  // The REAL numbers, from the two real documents. A fixture that invents them proves
  // nothing about the jurisdiction this was measured on.
  const APPLICATION_2022 = [
    { minKw: null, maxKw: 5, feeUsd: 79, label: "5 kva or less" },
    { minKw: 5.01, maxKw: 15, feeUsd: 94, label: "5.01 kva to 15 kva" },
    { minKw: 15.01, maxKw: 25, feeUsd: 156, label: "15.01 kva to 25 kva" },
  ];
  const ADOPTED_2025 = [
    { minKw: null, maxKw: 5, feeUsd: 135, label: "Renewable energy 5 KVA or less" },
    { minKw: 5.01, maxKw: 15, feeUsd: 160, label: "Renewable energy 5.01 KVA to 15 KVA" },
    { minKw: 15.01, maxKw: 25, feeUsd: 265, label: "Renewable energy 15.01 KVA to 25 KVA" },
  ];

  const source = (tag: string, documentDate: string, brackets: typeof ADOPTED_2025): Source => ({
    tag, name: `Coos County document ${tag}`, sourceUrl: `${url}#${tag}`,
    sourceQuote: `"${brackets[0].label}" | "$${brackets[0].feeUsd.toFixed(2)}"`,
    documentDate, documentDateIso: "", brackets,
  });

  /** Exactly what buildConflictFinding produces: basis "other", both candidates' brackets
   *  tagged, status 'conflicted', and each source kept whole alongside. */
  const conflictFinding = (over: Partial<Finding> = {}): Finding => ({
    found: true, reason: "", basis: "other",
    status: "conflicted",
    documentDate: "Effective 7-1-25",
    brackets: [
      ...APPLICATION_2022.map((b) => ({ ...b, label: `[S1] ${b.label}` })),
      ...ADOPTED_2025.map((b) => ({ ...b, label: `[S2] ${b.label}` })),
    ],
    sources: [source("S1", "Revised 12/23/2022", APPLICATION_2022), source("S2", "Effective 7-1-25", ADOPTED_2025)],
    notes: `${FEE_CONFLICT_MARKER} recorded 2026-09-12: 5 kva or less: S1=$79.00 vs S2=$135.00`,
    sourceUrl: url, sourceQuote: '"Renewable energy 5 KVA or less" | "$135.00"', sourceKind: "official",
    ...over,
  });

  const project = (ahj: string, clientId: string, id: string): never => ({
    id, clientId, state: STATE, ahj, utility: "Pacific Power",
    systemSizeAcKw: 10, systemSizeDcKw: 10.12, parserSnapshot: {},
  }) as never;

  // -------------------------------------------------------------------------
  // 1. THE CONFLICT IS A COLUMN, NOT A SENTENCE.
  // -------------------------------------------------------------------------
  const COOS = "Coos County";
  const coosKey = feeScheduleProfileKey({ state: STATE, ahj: COOS }, "permit");
  const saved = saveFeeSchedule(db, { state: STATE, ahj: COOS, track: "permit" }, conflictFinding());
  check("a conflicted finding is stored", saved.saved === true, saved.reason);

  let stored = getFeeSchedule(db, coosKey, "permit")!;
  check("the row's status is 'conflicted'", stored.status === "conflicted", stored.status);

  const byStatus = db.query<{ profile_key: string }>(
    "SELECT profile_key FROM fee_schedules WHERE status = 'conflicted' AND track = 'permit'",
  );
  check("…and it is QUERYABLE — one SELECT lists every open fee question",
    byStatus.length === 1 && byStatus[0].profile_key === coosKey, JSON.stringify(byStatus));

  // The point of a column. Notes are " | "-joined segments with a cap; a marker inside one
  // is one mergeNotes away from being pushed out, and nothing downstream would notice.
  db.run("UPDATE fee_schedules SET notes = '' WHERE profile_key = ?", [coosKey]);
  stored = getFeeSchedule(db, coosKey, "permit")!;
  check("the status does NOT depend on the prose — blanking notes leaves it conflicted",
    stored.status === "conflicted" && stored.notes === "", `${stored.status} / ${stored.notes}`);

  // -------------------------------------------------------------------------
  // 2. IT REFUSES, AND IT REFUSES WITH BOTH NUMBERS NAMED.
  // -------------------------------------------------------------------------
  const client = createClient(db, { companyName: "Conflict Solar", billingMode: "per_submission", serviceFeeUsd: "175" });
  const now = new Date().toISOString();
  const mkProject = (id: string, ahj: string): void => {
    db.run(
      `INSERT INTO projects (id, client_id, homeowner_name, state, ahj, utility, system_size_ac_kw, system_size_dc_kw, status, parser_json, created_at, updated_at)
       VALUES (?, ?, 'Test Owner', ?, ?, 'Pacific Power', 10, 10.12, 'ready_to_stage', '{}', ?, ?)`,
      [id, client.id, STATE, ahj, now, now],
    );
  };
  mkProject("proj-coos", COOS);

  const resolved = feeForProject(db, project(COOS, client.id, "proj-coos"), "permit")!;
  check("feeForProject finds the schedule but answers NEITHER disputed number",
    resolved != null && resolved.feeUsd === null, JSON.stringify(resolved?.feeUsd));
  check("…and the refusal names the marker", resolved.reason.includes(FEE_CONFLICT_MARKER), resolved.reason);
  check("…and both candidates' own numbers, so a person can settle it",
    resolved.reason.includes("$94.00") && resolved.reason.includes("$160.00"), resolved.reason);
  check("…and the currency comparison that actually decides it",
    resolved.reason.includes("Revised 12/23/2022") && resolved.reason.includes("Effective 7-1-25"), resolved.reason);

  const seam = lookupPublishedFee(db, { track: "permit", state: STATE, ahj: COOS, utility: "", bracketKw: 10 })!;
  check("the quote-ladder seam refuses too, rather than picking one", seam != null && seam.feeUsd === null, JSON.stringify(seam));
  check("…and hands the ladder the conflict, not a shrug", seam.basis.includes(FEE_CONFLICT_MARKER), seam.basis);

  // -------------------------------------------------------------------------
  // 3. THE REFUSAL DOES NOT DEPEND ON THE basis-"other" FALL-THROUGH.
  //
  // These two rows are conflicted AND shaped so that evaluateSchedule would answer them
  // instantly if the status branch were not there: a flat single bracket hits `hit()` on
  // the very next line, and a system_kw table hits matchBracket. Each is proved evaluable
  // first — with the identical finding minus `status` — so a green refusal below cannot be
  // the fixture quietly being unreadable for some other reason.
  // -------------------------------------------------------------------------
  const FLAT = "Flat County";
  const flatKey = feeScheduleProfileKey({ state: STATE, ahj: FLAT }, "permit");
  const flatFinding = (over: Partial<Finding>): Finding => ({
    found: true, reason: "", basis: "flat",
    brackets: [{ minKw: null, maxKw: null, feeUsd: 135, label: "Solar permit, flat" }],
    sources: [source("S1", "Effective 7-1-25", ADOPTED_2025)],
    notes: "", sourceUrl: url, sourceQuote: '"Solar permit" | "$135.00"', sourceKind: "official", ...over,
  });
  mkProject("proj-flat", FLAT);
  const flatProject = project(FLAT, client.id, "proj-flat");

  saveFeeSchedule(db, { state: STATE, ahj: FLAT, track: "permit" }, flatFinding({}));
  check("CONTROL: a flat single-bracket schedule is evaluated — this shape ANSWERS",
    feeForProject(db, flatProject, "permit")!.feeUsd === 135, JSON.stringify(feeForProject(db, flatProject, "permit")));

  saveFeeSchedule(db, { state: STATE, ahj: FLAT, track: "permit" },
    flatFinding({ status: "conflicted", resolvesConflict: true }));
  const flatConflicted = feeForProject(db, flatProject, "permit")!;
  check("3a. a CONFLICTED flat single-bracket row still refuses — the fall-through cannot explain this",
    flatConflicted.feeUsd === null && flatConflicted.reason.includes(FEE_CONFLICT_MARKER),
    `${flatConflicted.feeUsd} / ${flatConflicted.reason}`);

  const KW = "Bracketed County";
  const kwFinding = (over: Partial<Finding>): Finding => ({
    found: true, reason: "", basis: "system_kw", brackets: ADOPTED_2025,
    sources: [source("S1", "Effective 7-1-25", ADOPTED_2025)],
    notes: "", sourceUrl: url, sourceQuote: '"Renewable energy 5.01 KVA to 15 KVA" | "$160.00"', sourceKind: "official", ...over,
  });
  mkProject("proj-kw", KW);
  const kwProject = project(KW, client.id, "proj-kw");

  saveFeeSchedule(db, { state: STATE, ahj: KW, track: "permit" }, kwFinding({}));
  check("CONTROL: a system_kw bracket table is evaluated — a 10 kVA job is $160",
    feeForProject(db, kwProject, "permit")!.feeUsd === 160, JSON.stringify(feeForProject(db, kwProject, "permit")));

  saveFeeSchedule(db, { state: STATE, ahj: KW, track: "permit" },
    kwFinding({ status: "conflicted", resolvesConflict: true }));
  const kwConflicted = feeForProject(db, kwProject, "permit")!;
  check("3b. a CONFLICTED system_kw table still refuses, with the bracket sitting right there",
    kwConflicted.feeUsd === null && kwConflicted.reason.includes(FEE_CONFLICT_MARKER),
    `${kwConflicted.feeUsd} / ${kwConflicted.reason}`);
  check("…and the bracket label is withheld too — a labelled line reads as an answer",
    kwConflicted.bracketLabel === "", kwConflicted.bracketLabel);

  // -------------------------------------------------------------------------
  // 4. THE DOCUMENT DATE RIDES WITH EACH SOURCE.
  // -------------------------------------------------------------------------
  check("the row records each source separately, unflattened", stored.sources.length === 2, JSON.stringify(stored.sources.map((s) => s.tag)));
  check("each source keeps the document's OWN words about its currency",
    stored.sources[0].documentDate === "Revised 12/23/2022" && stored.sources[1].documentDate === "Effective 7-1-25",
    JSON.stringify(stored.sources.map((s) => s.documentDate)));
  check("…and the comparable date, derived by documentDate.ts's single parser",
    stored.sources[0].documentDateIso === "2022-12-23" && stored.sources[1].documentDateIso === "2025-07-01",
    JSON.stringify(stored.sources.map((s) => s.documentDateIso)));
  check("each source keeps the brackets IT printed, not the merged list",
    stored.sources[0].brackets.map((b) => b.feeUsd).join() === "79,94,156"
    && stored.sources[1].brackets.map((b) => b.feeUsd).join() === "135,160,265",
    JSON.stringify(stored.sources.map((s) => s.brackets.map((b) => b.feeUsd))));
  check("the row itself carries a document date, where notes used to be the only home",
    stored.documentDate === "Effective 7-1-25" && stored.documentDateIso === "2025-07-01",
    `${stored.documentDate} / ${stored.documentDateIso}`);

  const kwStored = getFeeSchedule(db, feeScheduleProfileKey({ state: STATE, ahj: KW }, "permit"), "permit")!;
  check("an ORDINARY schedule explains itself the same way — one source, dated",
    kwStored.sources.length === 1 && kwStored.sources[0].documentDateIso === "2025-07-01",
    JSON.stringify(kwStored.sources));

  check("conflictSummary reads as one sentence a person can act on",
    /S1 \(Revised 12\/23\/2022\) says \$79\.00 \/ \$94\.00 \/ \$156\.00 vs S2 \(Effective 7-1-25\) says \$135\.00/.test(conflictSummary(stored)),
    conflictSummary(stored));

  // -------------------------------------------------------------------------
  // 5. A 'VERIFIED' STAMP IS NOT A PICK (hard rule 3 cuts both ways).
  // -------------------------------------------------------------------------
  markFeeScheduleVerified(db, coosKey, "permit", "the lead");
  stored = getFeeSchedule(db, coosKey, "permit")!;
  check("verifying a conflicted row marks it verified", stored.confidence === "verified", stored.confidence);
  check("…and does NOT clear the conflict — verifying that we hold two numbers is not picking one",
    stored.status === "conflicted", stored.status);
  check("…so it still refuses to price a job",
    feeForProject(db, project(COOS, client.id, "proj-coos"), "permit")!.feeUsd === null);

  // -------------------------------------------------------------------------
  // 6. AN AUTOMATED PASS CANNOT ANSWER THE QUESTION BY WINNING THE RACE.
  // -------------------------------------------------------------------------
  const RACE = "Race County";
  const raceKey = feeScheduleProfileKey({ state: STATE, ahj: RACE }, "permit");
  saveFeeSchedule(db, { state: STATE, ahj: RACE, track: "permit" }, conflictFinding());
  const overwrite = saveFeeSchedule(db, { state: STATE, ahj: RACE, track: "permit" }, kwFinding({}));
  check("a plain research write over an open conflict is REFUSED",
    overwrite.saved === false && overwrite.refusedConflicted === true, `${overwrite.saved} / ${overwrite.reason}`);
  check("…and the refusal says what the two candidates are and how to close it",
    overwrite.reason.includes("$79.00") && overwrite.reason.includes("--resolve-conflicts"), overwrite.reason);
  let race = getFeeSchedule(db, raceKey, "permit")!;
  check("…the row did not move", race.status === "conflicted" && race.basis === "other" && race.brackets.length === 6,
    `${race.status} / ${race.basis} / ${race.brackets.length}`);
  check("…and the finding it refused is on the row, not thrown away",
    race.notes.includes("NOT applied") && race.notes.includes(FEE_CONFLICT_MARKER), race.notes);

  const picked = saveFeeSchedule(db, { state: STATE, ahj: RACE, track: "permit" }, kwFinding({ resolvesConflict: true }));
  check("a human's pick DOES go through", picked.saved === true, picked.reason);
  race = getFeeSchedule(db, raceKey, "permit")!;
  check("…and closes the conflict", race.status === "ok" && race.basis === "system_kw", `${race.status} / ${race.basis}`);
  mkProject("proj-race", RACE);
  check("…so the jurisdiction prices again", feeForProject(db, project(RACE, client.id, "proj-race"), "permit")!.feeUsd === 160);

  // -------------------------------------------------------------------------
  // 7. THE DECISION: A CONFLICT IS VISIBLE, IT DOES NOT BLOCK.
  //
  // The amount still degrades to the labelled valuation estimate — the portal's own number
  // trues it up later, automation never pays a fee (hard rule 1), and this runs inside the
  // staging gate whose contract is never to break a submission. What changes is that the
  // quote no longer renders "we hold two contradictory published numbers" identically to
  // "we have no schedule", which is the one fact on that screen a person can act on.
  // -------------------------------------------------------------------------
  const quote = buildPaymentQuote(db, project(COOS, client.id, "proj-coos"), "permit");
  check("the filing is NOT blocked — the estimate tier still quotes an amount",
    quote.permitFeeUsd === 455.4 && quote.permitFeeSource === "valuation_estimate",
    `${quote.permitFeeUsd} / ${quote.permitFeeSource}`);
  // "Leads" means BEFORE the estimate's own sentence, not literally first: resolutionFrom
  // prefixes the authority ("Coos County: UNRESOLVED FEE CONFLICT: …"), which is the right
  // first word on a screen that may be showing several jurisdictions.
  check("the quote LEADS with the conflict, ahead of the estimate's own prose",
    quote.permitFeeBasis.indexOf(FEE_CONFLICT_MARKER) >= 0
    && quote.permitFeeBasis.indexOf(FEE_CONFLICT_MARKER) < quote.permitFeeBasis.indexOf("Rough estimate"),
    quote.permitFeeBasis);
  check("…names both disputed numbers",
    quote.permitFeeBasis.includes("$94.00") && quote.permitFeeBasis.includes("$160.00"), quote.permitFeeBasis);
  check("…names both documents' dates",
    quote.permitFeeBasis.includes("Revised 12/23/2022") && quote.permitFeeBasis.includes("Effective 7-1-25"), quote.permitFeeBasis);
  check("…and says plainly that the amount shown is not either of them",
    /THE AMOUNT QUOTED IS NOT FROM THAT SCHEDULE/.test(quote.permitFeeBasis), quote.permitFeeBasis);
  check("…and no bracket label rides along to make the guess look bracketed",
    quote.permitFeeBracketLabel === null, String(quote.permitFeeBracketLabel));

  // The contrast that makes the change mean something: the same amount, from the same tier,
  // for a jurisdiction we simply know nothing about.
  mkProject("proj-nowhere", "Nowhere County");
  const blank = buildPaymentQuote(db, project("Nowhere County", client.id, "proj-nowhere"), "permit");
  check("a jurisdiction with NO schedule quotes the same amount…",
    blank.permitFeeUsd === 455.4 && blank.permitFeeSource === "valuation_estimate",
    `${blank.permitFeeUsd} / ${blank.permitFeeSource}`);
  check("…but must NOT read as a conflict — the two facts are now distinguishable",
    !blank.permitFeeBasis.includes(FEE_CONFLICT_MARKER), blank.permitFeeBasis);

  // -------------------------------------------------------------------------
  // 8. THE MIGRATION PROTECTS ROWS THAT PREDATE IT.
  //
  // A conflict recorded before v23 carries the marker in its notes and would default to
  // status 'ok' — i.e. protected by nothing but the fall-through the column exists to
  // replace, still armed, on the one jurisdiction we have actually measured.
  // -------------------------------------------------------------------------
  const LEGACY = "Legacy County";
  const legacyKey = feeScheduleProfileKey({ state: STATE, ahj: LEGACY }, "permit");
  saveFeeSchedule(db, { state: STATE, ahj: LEGACY, track: "permit" }, conflictFinding());
  // Wind it back to exactly what a pre-v23 row looks like: the marker in notes, no status.
  db.run("UPDATE fee_schedules SET status = 'ok' WHERE profile_key = ?", [legacyKey]);
  check("SETUP: the legacy row now looks pre-v23 — marker in notes, status 'ok'",
    getFeeSchedule(db, legacyKey, "permit")!.status === "ok"
    && getFeeSchedule(db, legacyKey, "permit")!.notes.includes(FEE_CONFLICT_MARKER));
  db.run("DELETE FROM schema_meta WHERE version >= 23");
  db.close();

  db = await openDatabase();
  const legacy = getFeeSchedule(db, legacyKey, "permit")!;
  check("replaying v23 backfills the status from the marker it finds in notes",
    legacy.status === "conflicted", legacy.status);
  mkProject("proj-legacy", LEGACY);
  check("…so a conflict recorded before the column existed refuses too",
    feeForProject(db, project(LEGACY, client.id, "proj-legacy"), "permit")!.feeUsd === null);

  db.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the handle */ }

  console.log(failures === 0 ? "\nfeeConflict: all checks passed\n" : `\nfeeConflict: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
