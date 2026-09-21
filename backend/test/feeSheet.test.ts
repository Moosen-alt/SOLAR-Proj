// The fee ladder with published schedules in it, and the project fee sheet.
//
// What this guards:
//  - PRECEDENCE: actual > learned_history > published_schedule > valuation_estimate
//    > unknown, each tier winning in turn and each losing to the one above.
//  - BRACKETS: the schedule is bracketed to THIS project's size. The question
//    bank caught Coos Bay's Accela recipe replaying a frozen
//    "Renewable energy ... 5.01kva through 15kva = 1" — a 20 kW job billed at
//    the 15 kVA rate. A bracket that follows the project is the fix.
//  - NEM: $0-with-a-source is a real answer and must read differently from
//    "we have no idea"; a mailed-check fee says so (Ameren Illinois Level 1).
//  - THE SHEET: never reports a total when any component is unknown.
//  - DEGRADATION: no schedule module, or a broken one, quotes like it always did.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ProjectRecord, PublishedFeeResult } from "../../shared/src/types";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-sheet-test-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  process.env.SUBMISSION_SERVICE_FEE_USD = "100";
  delete process.env.NEM_FEE_ESTIMATE_USD;
  const { openDatabase } = await import("../src/db");
  const { createClient } = await import("../src/clients");
  const {
    buildPaymentQuote, buildProjectFeeSheet, recordActualPermitFee, registerFeeScheduleLookup,
  } = await import("../src/submissionFees");
  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   ${name}`);
  };

  const client = createClient(db, { companyName: "PerSub Solar", billingMode: "per_submission", serviceFeeUsd: "175" });
  const monthly = createClient(db, { companyName: "Monthly Solar", billingMode: "monthly" });

  const now = new Date().toISOString();
  interface ProjectSpec {
    id: string; clientId: string; state: string; ahj: string; utility: string;
    dcKw: number | null; acKw: number | null;
  }
  const mkProject = (spec: ProjectSpec): ProjectRecord => {
    db.run(
      `INSERT INTO projects (id, client_id, homeowner_name, state, ahj, utility, system_size_dc_kw, system_size_ac_kw, status, parser_json, created_at, updated_at)
       VALUES (?, ?, 'Test Owner', ?, ?, ?, ?, ?, 'ready_to_stage', '{}', ?, ?)`,
      [spec.id, spec.clientId, spec.state, spec.ahj, spec.utility, spec.dcKw, spec.acKw, now, now],
    );
    return {
      id: spec.id, clientId: spec.clientId, state: spec.state, ahj: spec.ahj, utility: spec.utility,
      systemSizeDcKw: spec.dcKw, systemSizeAcKw: spec.acKw, totalExportKw: null, parserSnapshot: {},
    } as unknown as ProjectRecord;
  };

  // --- A fake published-schedule module -------------------------------------
  // Stands in for backend/src/feeSchedules.ts so this test stays pure: no web
  // search, no schedule tables, no dependence on another author's file landing.
  const bracketLabelFor = (kw: number | null): string =>
    kw == null ? "unbracketed" : kw <= 5 ? "0 through 5 kVA" : kw <= 15 ? "5.01 kVA through 15 kVA" : "15.01 kVA through 25 kVA";
  const bracketFeeFor = (kw: number | null): number =>
    kw == null ? 150 : kw <= 5 ? 150 : kw <= 15 ? 300 : 525;

  // The stub takes feeSchedules.feeForProject's exact signature, so the seam the
  // test drives is the same call production makes.
  type Answer = (project: ProjectRecord) => PublishedFeeResult | null;
  let lastProject: ProjectRecord | null = null;
  let permitAnswer: Answer | null = null;
  let nemAnswer: Answer | null = null;
  let lookupThrows = false;
  const installLookup = (): void => {
    registerFeeScheduleLookup((_db, proj, track) => {
      lastProject = proj;
      if (lookupThrows) throw new Error("schedule lookup exploded");
      return (track === "nem" ? nemAnswer : permitAnswer)?.(proj) ?? null;
    });
  };
  const bracketedPermit: Answer = (proj) => {
    // Brackets are inverter-rated, so the stub reads AC the way the real
    // module's systemRatingKw does.
    const kw = proj.systemSizeAcKw ?? proj.systemSizeDcKw;
    return {
      feeUsd: bracketFeeFor(kw),
      bracketLabel: bracketLabelFor(kw),
      sourceUrl: "https://example.gov/fee-schedule-2026.pdf",
      confidence: "seeded",
      paymentMethod: "portal",
    };
  };

  // =========================================================================
  // 1. Ladder precedence, bottom to top, on one AHJ.
  // =========================================================================
  registerFeeScheduleLookup(null);
  const p1 = mkProject({ id: "fee-1", clientId: client.id, state: "OR", ahj: "City of Astoria", utility: "Pacific Power", dcKw: 25, acKw: 20 });

  // unknown: a project with no size carries no valuation to guess from.
  const sizeless = mkProject({ id: "fee-0", clientId: client.id, state: "OR", ahj: "City of Nowhere", utility: "Pacific Power", dcKw: null, acKw: null });
  const qUnknown = buildPaymentQuote(db, sizeless, "permit");
  check("no size, no schedule, no history -> unknown (not zero)",
    qUnknown.permitFeeSource === "unknown" && qUnknown.permitFeeUsd === null && qUnknown.totalUsd === null,
    `${qUnknown.permitFeeSource} ${qUnknown.permitFeeUsd}`);
  check("unknown carries no fake confidence", qUnknown.permitFeeConfidence === "unknown" && qUnknown.paymentMethod === "unknown");

  // valuation_estimate: 25 kW DC x $3/W = $75,000 x 1.5% = $1,125, clamped to $900.
  const qEstimate = buildPaymentQuote(db, p1, "permit");
  check("valuation estimate wins when nothing better exists",
    qEstimate.permitFeeSource === "valuation_estimate" && qEstimate.permitFeeUsd === 450, // 1.5% of 40%-of-contract (operator formula 2026-09-21); was 900 when contract was conflated with valuation
    `${qEstimate.permitFeeSource} ${qEstimate.permitFeeUsd}`);
  check("estimate is labelled 'estimated', with no bracket and no citation",
    qEstimate.permitFeeConfidence === "estimated" && qEstimate.permitFeeBracketLabel === null && qEstimate.permitFeeSourceUrl === null);

  // published_schedule BEATS valuation_estimate.
  permitAnswer = bracketedPermit;
  installLookup();
  const qPublished = buildPaymentQuote(db, p1, "permit");
  check("published schedule beats the valuation guess",
    qPublished.permitFeeSource === "published_schedule" && qPublished.permitFeeUsd === 525,
    `${qPublished.permitFeeSource} ${qPublished.permitFeeUsd}`);
  check("published schedule carries its citation and confidence",
    qPublished.permitFeeSourceUrl === "https://example.gov/fee-schedule-2026.pdf" && qPublished.permitFeeConfidence === "seeded"
    && qPublished.paymentMethod === "portal");

  // learned_history BEATS published_schedule.
  db.run(
    `INSERT INTO permit_fee_history (id, state, ahj, utility, track, fee_usd, source, project_id, recorded_at)
     VALUES ('hist-1', 'OR', 'Astoria', '', 'permit', 610, 'operator', NULL, ?)`,
    [now],
  );
  const qLearned = buildPaymentQuote(db, p1, "permit");
  check("observed history beats the published schedule",
    qLearned.permitFeeSource === "learned_history" && qLearned.permitFeeUsd === 610,
    `${qLearned.permitFeeSource} ${qLearned.permitFeeUsd}`);
  check("a learned fee still shows the schedule's citation to check against",
    qLearned.permitFeeSourceUrl === "https://example.gov/fee-schedule-2026.pdf");

  // actual BEATS learned_history.
  const qActual = recordActualPermitFee(db, p1, "permit", "648.25", "portal_review");
  check("the operator's portal-calculated fee beats everything",
    qActual.permitFeeSource === "actual" && qActual.permitFeeUsd === 648.25 && qActual.permitFeeConfidence === "actual",
    `${qActual.permitFeeSource} ${qActual.permitFeeUsd}`);

  // =========================================================================
  // 2. The bracket follows THIS project's size (the Coos Bay bug).
  // =========================================================================
  const small = mkProject({ id: "fee-small", clientId: client.id, state: "OR", ahj: "City of Bandon", utility: "Pacific Power", dcKw: 12, acKw: 10 });
  const big = mkProject({ id: "fee-big", clientId: client.id, state: "OR", ahj: "City of Bandon", utility: "Pacific Power", dcKw: 25, acKw: 20 });
  const qSmall = buildPaymentQuote(db, small, "permit");
  const qBig = buildPaymentQuote(db, big, "permit");
  check("10 kW AC lands in the 5.01-15 kVA bracket",
    qSmall.permitFeeBracketLabel === "5.01 kVA through 15 kVA" && qSmall.permitFeeUsd === 300,
    `${qSmall.permitFeeBracketLabel} ${qSmall.permitFeeUsd}`);
  check("20 kW AC lands in the NEXT bracket, not the frozen one",
    qBig.permitFeeBracketLabel === "15.01 kVA through 25 kVA" && qBig.permitFeeUsd === 525,
    `${qBig.permitFeeBracketLabel} ${qBig.permitFeeUsd}`);
  check("the whole project reaches the schedule, so it can bracket on AC not DC",
    lastProject?.systemSizeAcKw === 20 && lastProject?.systemSizeDcKw === 25 && lastProject?.ahj === "City of Bandon",
    JSON.stringify({ ac: lastProject?.systemSizeAcKw, dc: lastProject?.systemSizeDcKw }));

  // =========================================================================
  // 3. NEM is a real answer: $0-with-a-source != unknown; mailed check says so.
  // =========================================================================
  const nemNothing = mkProject({ id: "fee-nem-0", clientId: client.id, state: "OR", ahj: "City of Bandon", utility: "Portland General Electric", dcKw: 12, acKw: 10 });
  const qNemUnknown = buildPaymentQuote(db, nemNothing, "nem");
  check("NEM with no schedule is UNKNOWN, not a confident $0",
    qNemUnknown.permitFeeSource === "unknown" && qNemUnknown.permitFeeUsd === null && qNemUnknown.totalUsd === null,
    `${qNemUnknown.permitFeeSource} ${qNemUnknown.permitFeeUsd}`);

  nemAnswer = () => ({
    feeUsd: 0,
    sourceUrl: "https://portlandgeneral.example/net-metering-tariff",
    confidence: "seeded",
    basis: "Schedule 144 net metering: no application fee for residential systems.",
  });
  const qNemFree = buildPaymentQuote(db, nemNothing, "nem");
  check("NEM $0 from a schedule is an ANSWER, distinct from unknown",
    qNemFree.permitFeeSource === "published_schedule" && qNemFree.permitFeeUsd === 0 && qNemFree.totalUsd === 175,
    `${qNemFree.permitFeeSource} ${qNemFree.permitFeeUsd} ${qNemFree.totalUsd}`);
  check("a known $0 has nothing to pay and somewhere to check it",
    qNemFree.paymentMethod === "none" && qNemFree.permitFeeSourceUrl === "https://portlandgeneral.example/net-metering-tariff");

  // Ameren Illinois Level 1: $50, paid by MAILED CHECK within 15 business days.
  const ameren = mkProject({ id: "fee-ameren", clientId: client.id, state: "IL", ahj: "Village of Normal", utility: "Ameren Illinois", dcKw: 12, acKw: 10 });
  nemAnswer = () => ({
    feeUsd: 50,
    sourceUrl: "https://ameren.example/level-1-interconnection",
    confidence: "verified",
    paymentMethod: "mailed_check",
    bracketLabel: "Level 1 (<= 25 kW inverter-based)",
    basis: "Level 1 interconnection application fee, paid by check within 15 business days of submission.",
  });
  const qAmeren = buildPaymentQuote(db, ameren, "nem");
  check("Ameren Illinois NEM resolves to $50, not the global no-fee guess",
    qAmeren.permitFeeUsd === 50 && qAmeren.permitFeeSource === "published_schedule" && qAmeren.permitFeeConfidence === "verified",
    `${qAmeren.permitFeeSource} ${qAmeren.permitFeeUsd}`);
  check("a mailed-check fee says so on the quote", qAmeren.paymentMethod === "mailed_check");

  // The payment METHOD belongs to the jurisdiction, not to the winning tier.
  const qAmerenActual = recordActualPermitFee(db, ameren, "nem", "50", "operator");
  check("payment method survives a higher tier winning the amount",
    qAmerenActual.permitFeeSource === "actual" && qAmerenActual.paymentMethod === "mailed_check",
    `${qAmerenActual.permitFeeSource} ${qAmerenActual.paymentMethod}`);

  // =========================================================================
  // 4. The fee sheet: one answer, and no total built on an unknown.
  // =========================================================================
  permitAnswer = bracketedPermit;
  nemAnswer = () => null;
  const sheetProj = mkProject({ id: "fee-sheet-1", clientId: client.id, state: "OR", ahj: "City of Sheridan", utility: "Portland General Electric", dcKw: 12, acKw: 10 });
  const partial = buildProjectFeeSheet(db, sheetProj);
  check("sheet covers both tracks", partial.lines.length === 2 && partial.lines[0].track === "permit" && partial.lines[1].track === "nem");
  check("an unknown NEM fee nulls the total rather than summing as zero",
    partial.totalUsd === null && partial.jurisdictionFeesUsd === null,
    `${partial.totalUsd} ${partial.jurisdictionFeesUsd}`);
  check("the sheet names what it does not know",
    partial.unknowns.length === 1 && partial.unknowns[0].includes("Portland General Electric"),
    JSON.stringify(partial.unknowns));
  check("the known permit line is still fully reported",
    partial.lines[0].known === true && partial.lines[0].feeUsd === 300 && partial.lines[0].bracketLabel === "5.01 kVA through 15 kVA"
    && partial.lines[0].sourceUrl === "https://example.gov/fee-schedule-2026.pdf");
  check("an unknown line is marked unknown, not zero", partial.lines[1].known === false && partial.lines[1].feeUsd === null);

  nemAnswer = () => ({ feeUsd: 0, sourceUrl: "https://pge.example/tariff", confidence: "seeded" });
  const complete = buildProjectFeeSheet(db, sheetProj);
  check("with every component known the sheet totals up",
    complete.jurisdictionFeesUsd === 300 && complete.serviceFeesUsd === 350 && complete.totalUsd === 650,
    `${complete.jurisdictionFeesUsd} ${complete.serviceFeesUsd} ${complete.totalUsd}`);
  check("a complete sheet has no unknowns left", complete.unknowns.length === 0);

  // A mailed check is the human's job — the sheet has to say it out loud.
  nemAnswer = () => ({ feeUsd: 50, sourceUrl: "https://ameren.example/level-1", paymentMethod: "mailed_check", confidence: "verified" });
  const amerenSheet = buildProjectFeeSheet(db, mkProject({ id: "fee-sheet-il", clientId: client.id, state: "IL", ahj: "Village of Normal", utility: "Ameren Illinois", dcKw: 12, acKw: 10 }));
  check("the sheet flags fees no portal can take",
    amerenSheet.outOfPortalPayments.length === 1 && amerenSheet.outOfPortalPayments[0].includes("MAILED CHECK")
    && amerenSheet.outOfPortalPayments[0].includes("50.00"),
    JSON.stringify(amerenSheet.outOfPortalPayments));

  // A monthly client is not billed per submission, so no service fee is added.
  const monthlyProj = mkProject({ id: "fee-sheet-monthly", clientId: monthly.id, state: "OR", ahj: "City of Sheridan", utility: "Portland General Electric", dcKw: 12, acKw: 10 });
  nemAnswer = () => ({ feeUsd: 0, sourceUrl: "https://pge.example/tariff" });
  const monthlySheet = buildProjectFeeSheet(db, monthlyProj);
  check("monthly billing adds no per-submission service fee",
    monthlySheet.billingRequired === false && monthlySheet.serviceFeesUsd === 0 && monthlySheet.totalUsd === 300,
    `${monthlySheet.serviceFeesUsd} ${monthlySheet.totalUsd}`);

  // =========================================================================
  // 5. Degrade, never break: no module, a throwing module, a junk result.
  // =========================================================================
  lookupThrows = true;
  const degradeProj = mkProject({ id: "fee-degrade", clientId: client.id, state: "OR", ahj: "City of Dallas", utility: "Pacific Power", dcKw: 12, acKw: 10 });
  const qThrew = buildPaymentQuote(db, degradeProj, "permit");
  check("a throwing schedule lookup falls back instead of breaking the quote",
    qThrew.permitFeeSource === "valuation_estimate" && qThrew.permitFeeUsd === 216, // 1.5% of 40%-of-(12kW×$3/W=$36,000)=$14,400 → $216 (operator formula 2026-09-21)
    `${qThrew.permitFeeSource} ${qThrew.permitFeeUsd}`);
  lookupThrows = false;

  // Junk the producer must not be able to put on a quote.
  permitAnswer = () => ({ feeUsd: -25, sourceUrl: "javascript:alert(1)" } as PublishedFeeResult);
  const qNegative = buildPaymentQuote(db, degradeProj, "permit");
  check("a negative published fee is refused", qNegative.permitFeeSource === "valuation_estimate", qNegative.permitFeeSource);
  permitAnswer = () => ({ feeUsd: 275, sourceUrl: "javascript:alert(1)", confidence: "totally-legit", paymentMethod: "crypto" } as unknown as PublishedFeeResult);
  const qJunk = buildPaymentQuote(db, degradeProj, "permit");
  check("a junk URL and novel enums are scrubbed, the fee still lands",
    qJunk.permitFeeUsd === 275 && qJunk.permitFeeSourceUrl === null && qJunk.permitFeeConfidence === "seeded" && qJunk.paymentMethod === "unknown",
    `${qJunk.permitFeeSourceUrl} ${qJunk.permitFeeConfidence} ${qJunk.paymentMethod}`);

  // A schedule that is FOUND but does not evaluate hands the amount down the
  // ladder and keeps its reason — "no system size yet" is a fixable answer where
  // a bare guess hides the problem.
  permitAnswer = () => ({ feeUsd: null, reason: "Schedule brackets on system size, but this project has no system size yet.", sourceUrl: "https://example.gov/fees", matchedName: "City of Dallas" });
  const qUnresolved = buildPaymentQuote(db, degradeProj, "permit");
  check("an unresolved schedule falls through but says why",
    qUnresolved.permitFeeSource === "valuation_estimate"
    && qUnresolved.permitFeeBasis.includes("did not resolve")
    && qUnresolved.permitFeeBasis.includes("no system size yet")
    && qUnresolved.permitFeeBracketLabel === null,
    qUnresolved.permitFeeBasis);

  // A mailed-check process stated in the schedule's own quoted text is read out
  // of it, because feeSchedules does not (yet) carry a paymentMethod field.
  nemAnswer = () => ({
    feeUsd: 50,
    sourceUrl: "https://ameren.example/level-1",
    confidence: "verified",
    sourceQuote: "A $50 application fee must be paid by check within 15 business days of submission.",
  });
  const qSniffed = buildPaymentQuote(db, mkProject({ id: "fee-sniff", clientId: client.id, state: "IL", ahj: "Village of Normal", utility: "Ameren Illinois", dcKw: 12, acKw: 10 }), "nem");
  check("a mailed-check process stated in the published line is carried",
    qSniffed.paymentMethod === "mailed_check" && qSniffed.permitFeeUsd === 50, qSniffed.paymentMethod);
  nemAnswer = () => ({ feeUsd: 0, sourceUrl: "https://pge.example/tariff", sourceQuote: "No application fee applies; no check is required." });
  const qNoSniff = buildPaymentQuote(db, mkProject({ id: "fee-sniff-2", clientId: client.id, state: "OR", ahj: "City of Sheridan", utility: "Portland General Electric", dcKw: 12, acKw: 10 }), "nem");
  check("a $0 line is not read as a mailed check", qNoSniff.paymentMethod === "none", qNoSniff.paymentMethod);

  registerFeeScheduleLookup(null);
  const qNoModule = buildPaymentQuote(db, degradeProj, "permit");
  check("with no stored schedule the ladder is exactly as it was",
    qNoModule.permitFeeSource === "valuation_estimate" && qNoModule.permitFeeUsd === 216, // same $216 as the throwing-lookup case above — one formula, every degrade path
    `${qNoModule.permitFeeSource} ${qNoModule.permitFeeUsd}`);

  // =========================================================================
  // 6. INTEGRATION: the real feeSchedules module, through the real seam.
  //    registerFeeScheduleLookup(null) above put the loader back on whatever is
  //    on disk, so this proves the wiring, not the stub.
  // =========================================================================
  let schedules: typeof import("../src/feeSchedules") | null = null;
  try { schedules = await import("../src/feeSchedules"); } catch { schedules = null; }
  if (!schedules) {
    console.log("skip backend/src/feeSchedules.ts is not present — integration checks skipped");
  } else {
    const coos = mkProject({ id: "fee-live", clientId: client.id, state: "OR", ahj: "Coos Bay", utility: "Pacific Power", dcKw: 25, acKw: 20 });
    const saved = schedules.saveFeeSchedule(
      db,
      { state: "OR", ahj: "City of Coos Bay", track: "permit" },
      {
        found: true,
        reason: "",
        basis: "system_kw",
        brackets: [
          { minKw: 0, maxKw: 5, feeUsd: 150, label: "Renewable energy for electrical systems- up to 5kva" },
          { minKw: 5.01, maxKw: 15, feeUsd: 300, label: "Renewable energy for electrical systems- 5.01kva through 15kva" },
          { minKw: 15.01, maxKw: 25, feeUsd: 525, label: "Renewable energy for electrical systems- 15.01kva through 25kva" },
        ],
        notes: "",
        sourceUrl: "https://coosbay.example/fee-schedule",
        sourceQuote: "Renewable energy for electrical systems- 15.01kva through 25kva ... $525",
        sourceKind: "official",
      },
    );
    check("INTEGRATION: the schedule saved", saved.saved === true, saved.reason);

    const qLive = buildPaymentQuote(db, coos, "permit");
    check("INTEGRATION: a stored schedule reaches the ladder through the real module",
      qLive.permitFeeSource === "published_schedule" && qLive.permitFeeUsd === 525,
      `${qLive.permitFeeSource} ${qLive.permitFeeUsd}`);
    check("INTEGRATION: the 20 kW job bills the 15.01-25 kVA line, not the frozen 5.01-15",
      qLive.permitFeeBracketLabel === "Renewable energy for electrical systems- 15.01kva through 25kva",
      String(qLive.permitFeeBracketLabel));
    check("INTEGRATION: the citation survives to the operator",
      qLive.permitFeeSourceUrl === "https://coosbay.example/fee-schedule" && qLive.permitFeeConfidence === "seeded");
    const liveSheet = buildProjectFeeSheet(db, coos);
    check("INTEGRATION: the sheet reports the permit line and chases the NEM one",
      liveSheet.lines[0].feeUsd === 525 && liveSheet.totalUsd === null && liveSheet.unknowns.length === 1,
      `${liveSheet.lines[0].feeUsd} ${liveSheet.totalUsd}`);
  }

  // Close before deleting the scratch DB - Windows holds the open handle as a file lock (EBUSY).
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log("\nfeeSheet: all checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
