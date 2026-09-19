// A FILING IS ITS CHARGES, AND A PARTIAL TOTAL MUST SAY SO.
//
// THE DEFECT, IN THE OPERATOR'S OWN WORDS: "fees for PDX look messed up still …
// they can get upward of like 1300$ sometimes."
//
// GROUND TRUTH — the operator's own PAID City of Portland receipt, 3915 N Kiska
// St, IVR 5269491, paid 2026-09-18, for a 3.520 kW DC / 3.072 kW AC prescriptive
// rooftop PV system. It is FOUR SEPARATE BILLS FROM THREE BUREAUS, $762.93:
//
//   Bill 5612247  Fire - Plan Review                        $50.00
//   Bill 5612248  Electrical Permit RS                     $201.00
//                 Electrical Permit St Sur                  $24.12   (12% of 201.00)
//   Bill 5612245  Land Use Plan Review Res                 $217.00
//                 Bldg Plan Rvw/Processing RS/MI/MP         $99.45   (65% of 153.00)
//   Bill 5612249  Building Permit RS                       $153.00
//                 Building Permit St. Sur                   $18.36   (12% of 153.00)
//
// TWO of those seven charges are permits. The table could hold a permit line and
// nothing else, so the other five were never held, so no quote built from it could
// reach a real total — and what it DID reach printed as a sourced, citable,
// confident number. That is the shape this file exists to make impossible: an
// unknown must never read as reassurance, and a filing missing one of its charges
// is not a cheaper filing.
//
//   MUST PASS    — a Portland prescriptive job whose schedule holds all four
//                  bureaus' charges RECONCILES TO THE RECEIPT: $762.93, and every
//                  one of the seven charges is itemised at the receipt's own amount;
//                  the 12% surcharge is taken on the PERMIT ONLY (24.12 / 18.36) —
//                  never on the plan reviews, which is $48.86 of invented money;
//                  the 65% processing charge is EVALUATED from the stored
//                  percentage against the base permit fee, not read back as a
//                  stored product;
//                  the same job with FIRE REVIEW CONDITIONAL and unanswered returns
//                  a PARTIAL — total null, the charge carried with amountUsd null
//                  and a reason that names it, the other six charges still priced
//                  and still on screen — never a smaller confident number;
//                  the fee sheet NAMES the missing charge in `unknowns` rather than
//                  reporting only "the permit fee is unknown", which would send an
//                  operator hunting a permit fee that is sitting right there;
//                  the CLI renderer and the dashboard card both ITEMISE, and both
//                  say INCOMPLETE rather than printing a sum that omits a charge.
//
//   MUST EXCLUDE — THE OVER-CORRECTION GUARD. Christopher Ivy's fully-published
//                  Coos pair still totals exactly $335.00, with no charges beyond
//                  its two permits, no new unresolved-ness, and NO itemisation
//                  block on either renderer: a jurisdiction whose data is complete
//                  must be untouched by this, and every one of the 12 live fee rows
//                  is that jurisdiction today;
//                  ancillary charges from an UNTRUSTED save (no retrieval ledger —
//                  scripts/apply-fee-findings.ts replaying a JSON file, or raw model
//                  output) are STRIPPED, exactly as `corroboration` and
//                  `stateSurcharge` are, so a plausible invented "Plan Review — 65%
//                  of permit fee" cannot reach a customer's total;
//                  the ancillary charges never move the PERMIT LINE's own amount —
//                  a form's fee-quantity field and a portal's permit-fee box still
//                  get the permit fee;
//                  research still lands as 'seeded' and nothing here writes
//                  'verified' (hard rule 3).
//
// THE KILL TESTS — run these before believing this file covers anything.
//   (a) In feeSchedules.resolutionFrom, drop the `extra` term from `total` (sum the
//       lines only, as it did before this round). Section 2 goes red: the receipt
//       reconciles to $396.48 instead of $762.93.
//   (b) In feeSchedules.resolutionFrom, drop `|| unpricedCharges.length` from the
//       total gate. Section 4 goes red: the partial returns a confident $712.93 —
//       a real filing quoted $50 short, with nothing on screen to say so.
//   Both were run by hand during development and their output is quoted in the
//   round notes. Neither is a hypothetical: (b) is the exact under-quote shape.
//
//   npx tsx backend/test/feeFilingCharges.test.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-filing-charges-"));
  // Before anything imports ../src/db.
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  process.env.AUTOPILOT_LOG_FILE = "";
  process.env.SUBMISSION_SERVICE_FEE_USD = "100";
  delete process.env.PERMIT_FEE_ESTIMATE_RATE;
  delete process.env.PERMIT_FEE_ESTIMATE_MIN_USD;
  delete process.env.PERMIT_FEE_ESTIMATE_MAX_USD;

  const { openDatabase } = await import("../src/db");
  const {
    saveFeeSchedule, feeForProject, corroborateAncillaryCharges, attachAncillaryCharges, newFeeDocumentLedger,
  } = await import("../src/feeSchedules");
  const { createClient } = await import("../src/clients");
  const { getProjectDetail } = await import("../src/repository");
  const { buildProjectFeeSheet } = await import("../src/submissionFees");
  // The CLI renderer an operator actually reads. Driving it is what "the fee sheet
  // itemises" means for a terminal.
  const { buildFeeSheetPresentation, renderFeeLine } = await import("../../scripts/fee-sheet");
  type Finding = import("../src/feeSchedules").FeeScheduleFinding;
  type Ledger = import("../src/feeSchedules").FeeDocumentLedger;

  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   ${name}`);
  };

  // -------------------------------------------------------------------------
  // THE RECEIPT, AS A DOCUMENT WE RETRIEVED.
  //
  // Every charge below has to be found PRINTED in this corpus before the storage
  // boundary will keep it — that is the trust rule, and a fixture that bypassed it
  // by writing brackets_json directly would prove nothing about the path production
  // uses. The surcharge sentence is the live City of Portland one, verbatim, and it
  // is what makes corroborateBrackets attach the 12%.
  // -------------------------------------------------------------------------
  const PDX_URL = "https://www.portland.gov/ppd/documents/fee-schedule/download";
  const PDX_CORPUS = [
    "City of Portland | Permit Fee Schedule | Effective July 10, 2026",
    "Electrical Permit RS | $201.00",
    "Building Permit RS | $153.00",
    "Fire - Plan Review | $50.00",
    "Land Use Plan Review Res | $217.00",
    "Bldg Plan Rvw/Processing RS/MI/MP | 65% of the building permit fee",
    "A 12% surcharge fee as mandated by the State Building Codes Division is applied to all permit fees.",
  ].join("\n");

  const ledger = (): Ledger => {
    const l = newFeeDocumentLedger();
    l.evidence.push({ url: PDX_URL, via: "http", status: 200, kind: "pdf", bytes: PDX_CORPUS.length, handed: 7 });
    l.corpus.push(PDX_CORPUS);
    return l;
  };

  const finding = (over: Partial<Finding>): Finding => ({
    found: true, reason: "", basis: "flat", brackets: [], notes: "",
    sourceUrl: PDX_URL, sourceQuote: "A sentence a person could go back and read.",
    sourceKind: "official", paymentMethod: "portal", ...over,
  });

  /** The charges as the researcher reports them — RAW, untrusted, exactly the shape
   *  that arrives off model output. They reach a bracket only through
   *  corroborateAncillaryCharges, which is the production step that checks each one
   *  against the bytes we read. `fireConditional` flips the one charge whose trigger
   *  nobody has answered. */
  const reportedCharges = (fireConditional: boolean): unknown[] => ([
    {
      // THE STORED LABEL IS THE WHOLE PRINTED ROW, separator and all — which is what
      // the live rows actually hold ("5.01 KVA to 15 KVA | $160.00"). It is here on
      // purpose: " | " is the note SEGMENT separator, so a reason quoting this label
      // raw would be shredded the first time somebody filed it into a row's notes.
      label: "Fire - Plan Review | $50.00", kind: "fire_review", amountUsd: 50, percentOf: "",
      conditional: fireConditional,
      condition: fireConditional ? "Fire Bureau review applies to some residential alterations and not others" : "",
      appliesTo: "structural", quote: "Fire - Plan Review | $50.00",
    },
    {
      label: "Land Use Plan Review Res", kind: "land_use_review", amountUsd: 217, percentOf: "",
      conditional: false, condition: "", appliesTo: "structural", quote: "Land Use Plan Review Res | $217.00",
    },
    {
      label: "Bldg Plan Rvw/Processing RS/MI/MP", kind: "processing", percent: 65,
      percentOf: "the building permit fee", conditional: false, condition: "",
      appliesTo: "structural", quote: "Bldg Plan Rvw/Processing RS/MI/MP | 65% of the building permit fee",
    },
  ]);

  /** Save Portland's two rows through the REAL write path: corroborate the reported
   *  charges against the retrieved corpus, hang the survivors on the brackets the way
   *  the researcher does, and hand saveFeeSchedule the same ledger. */
  const savePortland = (fireConditional: boolean): { held: number; dropped: string[] } => {
    const structuralFinding = finding({
      basis: "flat",
      brackets: [{ feeUsd: 153, label: "Building Permit RS" }],
      sourceQuote: "Building Permit RS | $153.00",
    });
    const l = ledger();
    const ancillary = corroborateAncillaryCharges(reportedCharges(fireConditional), structuralFinding, l);
    // The production attach step, not a hand-rolled assignment: it is what refuses
    // to bill a surcharge that is already folded into the bracket's own fee, and a
    // fixture that set the field directly would step over that rail.
    attachAncillaryCharges(structuralFinding.brackets, ancillary.held);
    saveFeeSchedule(db, { state: "OR", ahj: "City of Portland", track: "permit", discipline: "structural" },
      structuralFinding, { corroborateAgainst: l });
    saveFeeSchedule(db, { state: "OR", ahj: "City of Portland", track: "permit", discipline: "electrical" },
      finding({
        basis: "system_kw",
        brackets: [{ minKw: 0, maxKw: 5, feeUsd: 201, label: "Electrical Permit RS" }],
        sourceQuote: "Electrical Permit RS | $201.00",
      }), { corroborateAgainst: ledger() });
    return ancillary;
  };

  const corroborated = savePortland(false);

  // -------------------------------------------------------------------------
  // THE OVER-CORRECTION GUARD'S ROWS — Christopher Ivy's live Coos pair, verbatim.
  // No ancillary charges anywhere, which is every row in the live table today.
  // -------------------------------------------------------------------------
  saveFeeSchedule(db, { state: "OR", ahj: "City of Coos Bay", track: "permit", discipline: "structural" }, finding({
    basis: "other",
    brackets: [{ feeUsd: 200, label: "Solar Permit (when required) – Prescriptive Path System, fee includes plan review" }],
    sourceUrl: "https://www.coosbayor.gov/home/showpublisheddocument/570/639239531899170000",
    sourceQuote: "Solar Permit (when required) – Prescriptive Path System, fee includes plan review | $200.00",
  }));
  saveFeeSchedule(db, { state: "OR", ahj: "City of Coos Bay", track: "permit", discipline: "electrical" }, finding({
    basis: "system_kw",
    brackets: [{ minKw: 0, maxKw: 5, feeUsd: 135, label: "5 KVA or less | $135.00" }],
    sourceUrl: "https://co.coos.or.us/files/f9b20f31d/community_development_fees_-_effective_1_1_26.pdf",
    sourceQuote: "5 KVA or less | $135.00",
  }));

  const client = createClient(db, { companyName: "Charge Solar", billingMode: "per_submission", serviceFeeUsd: "100" });
  const now = new Date().toISOString();
  const mkProject = (id: string, ahj: string, acKw: number, dcKw: number, snapshot: Record<string, unknown>) => {
    db.run(
      `INSERT INTO projects (id, client_id, homeowner_name, state, ahj, utility, system_size_ac_kw, system_size_dc_kw, status, parser_json, created_at, updated_at)
       VALUES (?, ?, 'Test Owner', 'OR', ?, 'Portland General Electric', ?, ?, 'ready_to_stage', ?, ?, ?)`,
      [id, client.id, ahj, acKw, dcKw, JSON.stringify(snapshot), now, now],
    );
    return getProjectDetail(db, id).project;
  };

  // The receipt's own job: 3.520 kW DC / 3.072 kW AC, roof mounted, PRESCRIPTIVE —
  // the path is DERIVED from this snapshot by the production resolver, not stipulated.
  const PRESCRIPTIVE_SNAPSHOT = { mounting: "Roof mount", pvMicroMake: "Enphase", pvMicroModel: "IQ8PLUS-72-2-US" };
  const KISKA = mkProject("proj-kiska", "City of Portland", 3.072, 3.52, PRESCRIPTIVE_SNAPSHOT);
  const IVY = mkProject("proj-ivy", "City of Coos Bay", 3.072, 3.52, PRESCRIPTIVE_SNAPSHOT);

  // =========================================================================
  // 1. THE FIXTURE'S OWN PREMISES. If these drift the rest means nothing.
  // =========================================================================
  check("1a. every reported charge was found PRINTED in the retrieved document",
    corroborated.held.length === 3 && corroborated.dropped.length === 0,
    `held=${corroborated.held.length} dropped=${JSON.stringify(corroborated.dropped)}`);
  const stored = feeForProject(db, KISKA, "permit");
  check("1b. both Portland rows resolve for this project", !!stored && stored.lines.length === 2,
    `lines=${stored?.lines.length}`);
  check("1c. research landed as SEEDED — code never writes 'verified' (hard rule 3)",
    stored?.confidence === "seeded", String(stored?.confidence));

  // =========================================================================
  // 2. THE RECEIPT RECONCILES. This is the whole round in one number.
  // =========================================================================
  const RECEIPT_TOTAL = 762.93;
  check("2a. the filing totals the receipt's own $762.93",
    stored?.feeUsd === RECEIPT_TOTAL, `got ${stored?.feeUsd}`);

  const byLabel = new Map((stored?.charges ?? []).map((c) => [c.label, c]));
  const EXPECTED: Array<[string, number, boolean]> = [
    ["Electrical Permit RS", 201, true],
    ["State surcharge (12% of the permit fee)", 24.12, true],
    ["Building Permit RS", 153, true],
    ["Fire - Plan Review | $50.00", 50, false],
    ["Land Use Plan Review Res", 217, false],
    ["Bldg Plan Rvw/Processing RS/MI/MP", 99.45, false],
  ];
  // The surcharge charge appears once per permit line and both are $-different, so
  // it is checked separately below; here the list is checked for the four uniquely
  // labelled charges plus the two permits.
  for (const [label, amount, partOfLine] of EXPECTED) {
    if (label.startsWith("State surcharge")) continue;
    const c = byLabel.get(label);
    check(`2b. "${label}" is itemised at $${amount.toFixed(2)}`,
      !!c && c.amountUsd === amount && c.partOfLineFee === partOfLine,
      c ? `amount=${c.amountUsd} partOfLineFee=${c.partOfLineFee}` : "charge absent from the itemisation");
  }

  // THE SURCHARGE IS ON THE PERMIT, NOT ON THE BILL. 12% of $762.93 is $91.55;
  // 12% of the two permits is $42.48. Surcharging the plan reviews would invent
  // $48.86 the city never charged, and the receipt is the proof it does not.
  const electrical = stored?.lines.find((l) => l.discipline === "electrical");
  const structural = stored?.lines.find((l) => l.discipline === "structural");
  check("2c. the electrical surcharge is 12% of the PERMIT ($24.12), not of the filing",
    electrical?.stateSurchargeUsd === 24.12, String(electrical?.stateSurchargeUsd));
  check("2d. the building surcharge is 12% of the PERMIT ($18.36), not of the filing",
    structural?.stateSurchargeUsd === 18.36, String(structural?.stateSurchargeUsd));
  check("2e. no ancillary charge carries a surcharge of its own",
    (stored?.charges ?? []).filter((c) => c.kind === "state_surcharge").every((c) => c.amountUsd === 24.12 || c.amountUsd === 18.36),
    JSON.stringify((stored?.charges ?? []).filter((c) => c.kind === "state_surcharge").map((c) => c.amountUsd)));

  // THE PERCENTAGE IS EVALUATED, NOT STORED. $99.45 is 65% of $153.00 — the same
  // 65% on a bigger permit is a different number, so storing the product would be
  // wrong for every other job in the city.
  const processing = byLabel.get("Bldg Plan Rvw/Processing RS/MI/MP");
  check("2f. the 65% processing charge is computed from the BASE permit fee",
    processing?.amountUsd === Math.round(153 * 65) / 100, String(processing?.amountUsd));
  check("2g. its evidence states the percentage and what it was taken of",
    /65% of the building permit fee \(\$153\.00\)/.test(processing?.quote ?? ""), processing?.quote ?? "");

  // THE PERMIT LINE ITSELF NEVER MOVED. A form's fee-quantity field and a portal's
  // permit-fee box ask for the permit fee, not for the filing's total.
  check("2h. the electrical LINE is still the permit + its surcharge ($225.12)",
    electrical?.feeUsd === 225.12, String(electrical?.feeUsd));
  check("2i. the structural LINE is still the permit + its surcharge ($171.36)",
    structural?.feeUsd === 171.36, String(structural?.feeUsd));

  // NO PUBLISHED LINE STATES A SUM. The citation beside a six-charge total would be
  // a quote for a number its document never mentions.
  check("2j. a multi-charge total carries no single-line citation",
    stored?.bracketQuote === "", stored?.bracketQuote ?? "");

  // =========================================================================
  // 3. THE OVER-CORRECTION GUARD — Ivy's complete data is untouched.
  // =========================================================================
  const ivy = feeForProject(db, IVY, "permit");
  check("3a. Ivy's fully-published Coos pair still totals exactly $335.00",
    ivy?.feeUsd === 335, String(ivy?.feeUsd));
  check("3b. Ivy's filing has NO charge beyond its two permits",
    (ivy?.charges ?? []).length === 2 && (ivy?.charges ?? []).every((c) => c.partOfLineFee && c.kind === "permit"),
    JSON.stringify((ivy?.charges ?? []).map((c) => `${c.kind}:${c.label.slice(0, 20)}`)));
  const ivySheet = buildProjectFeeSheet(db, IVY);
  const ivyPermitLine = ivySheet.lines.find((l) => l.track === "permit");
  // Scoped to the PERMIT track: Coos Bay has no stored interconnection schedule, so
  // the NEM line is unknown here exactly as it is on the live database, and that is
  // a different (pre-existing, correct) gap. What this guards is that no unknown was
  // INVENTED on the permit side by this round's work.
  check("3c. Ivy's permit fee stays KNOWN and no new unknown appears on that track",
    ivyPermitLine?.known === true && ivyPermitLine?.feeUsd === 335
    && !ivySheet.unknowns.some((u) => /Permit fee|charge/i.test(u)),
    JSON.stringify(ivySheet.unknowns));

  // =========================================================================
  // 4. THE PARTIAL. A conditional charge nobody answered leaves the total
  //    UNRESOLVED and keeps every other charge on screen.
  // =========================================================================
  savePortland(true);
  const partial = feeForProject(db, KISKA, "permit");
  check("4a. the total is UNRESOLVED, not a smaller confident number",
    partial?.feeUsd == null, String(partial?.feeUsd));
  // 712.93 is what silently dropping the charge produces. Asserted by NAME because
  // it is the exact under-quote this section exists to refuse.
  check("4b. and specifically NOT $712.93 — the receipt minus the charge nobody answered",
    partial?.feeUsd !== RECEIPT_TOTAL - 50, String(partial?.feeUsd));
  const fire = (partial?.charges ?? []).find((c) => c.label.startsWith("Fire - Plan Review"));
  check("4c. the unpriced charge KEEPS its place in the itemisation",
    !!fire && fire.amountUsd == null && fire.conditional === true,
    fire ? `amount=${fire.amountUsd} conditional=${fire.conditional}` : "the charge was dropped from the list");
  check("4d. its reason NAMES the charge and the repair, and carries no ' | ' to shred a note",
    /CONDITIONAL CHARGE UNRESOLVED/.test(fire?.reason ?? "")
    && /Fire - Plan Review/.test(fire?.reason ?? "")
    && !(fire?.reason ?? "").includes(" | ")
    // The 400-character slice submissionFees applies on the way to the quote's
    // basis line: a reason that does not FIT arrives truncated mid-word, which is
    // how a repair instruction stops being one.
    && (fire?.reason ?? "").length <= 400, `${(fire?.reason ?? "").length} chars: ${fire?.reason ?? ""}`);
  // The same guard on a charge whose label is the whole printed row, separator and
  // all — which is what the storage side actually holds for most of them.
  const piped = (partial?.charges ?? []).find((c) => c.label.includes(" | "));
  check("4d2. no stored charge label leaks the note separator into a reason",
    !piped || !piped.reason.includes(" | "), piped?.reason ?? "(no piped label in this fixture)");
  check("4e. the resolution's own reason carries it up to the operator",
    /Fire - Plan Review/.test(partial?.reason ?? ""), (partial?.reason ?? "").slice(0, 120));
  // Seven charges on this filing: two permits, their two surcharges, and three
  // ancillary charges. Six of them still carry a number.
  const stillPriced = (partial?.charges ?? []).filter((c) => c.amountUsd != null);
  check("4f. the other six charges are still priced — a partial, not a blank",
    stillPriced.length === 6 && (partial?.charges ?? []).length === 7,
    `${stillPriced.length} priced of ${(partial?.charges ?? []).length}`);
  check("4g. the electrical permit line is untouched at $225.12",
    partial?.lines.find((l) => l.discipline === "electrical")?.feeUsd === 225.12,
    String(partial?.lines.find((l) => l.discipline === "electrical")?.feeUsd));

  // THE SHEET NAMES THE MISSING CHARGE. "The permit fee is unknown" would send an
  // operator hunting a permit fee that is sitting right there at $153.
  const sheet = buildProjectFeeSheet(db, KISKA);
  check("4h. the fee sheet's `unknowns` names the charge, not just 'the permit fee'",
    sheet.unknowns.some((u) => /Fire - Plan Review/.test(u)), JSON.stringify(sheet.unknowns).slice(0, 300));

  // =========================================================================
  // 5. PRESENTATION — the CLI the operator reads.
  // =========================================================================
  const view = buildFeeSheetPresentation(db, KISKA);
  const permitLine = view.sheet.lines.find((l) => l.track === "permit");
  const rendered = renderFeeLine(permitLine!, view.schedules.permit, view.agreements.permit, view.sheet.billingRequired);
  // SHOW_FEE_SHEET=1 prints the operator's actual screen. The assertions below are
  // regexes over a rendering nobody looks at unless it is printed, and a partial
  // that is technically correct and unreadable is still a partial nobody acts on.
  if (process.env.SHOW_FEE_SHEET) console.log(`<<<RENDER>>>\n${rendered}\n<<<END>>>`);
  check("5a. the CLI itemises every charge on the filing",
    /Charges/.test(rendered)
    && /Fire - Plan Review/.test(rendered)
    && /Land Use Plan Review Res/.test(rendered)
    && /Bldg Plan Rvw\/Processing/.test(rendered), rendered.slice(0, 400));
  check("5b. the unpriced charge prints UNRESOLVED and the block says INCOMPLETE",
    /UNRESOLVED\s+Fire - Plan Review/.test(rendered) && /INCOMPLETE/.test(rendered),
    rendered.slice(0, 600));
  check("5c. it never prints a sum that omits a charge",
    !/\$712\.93/.test(rendered), rendered.slice(0, 600));
  const ivyView = buildFeeSheetPresentation(db, IVY);
  const ivyRendered = renderFeeLine(
    ivyView.sheet.lines.find((l) => l.track === "permit")!,
    ivyView.schedules.permit, ivyView.agreements.permit, ivyView.sheet.billingRequired,
  );
  check("5d. OVER-CORRECTION GUARD: Ivy's complete filing grows no itemisation block",
    !/charges on this filing/i.test(ivyRendered) && /\$335\.00/.test(ivyRendered), ivyRendered.slice(0, 400));

  // =========================================================================
  // 6. PRESENTATION — the dashboard fee card, driven from its own source.
  //
  // frontend/dashboard.js is a browser script with no exports, so the function is
  // lifted OUT OF THE SHIPPED FILE and run here with the two helpers it closes
  // over. That is deliberately not a copy of the renderer: a copy would go on
  // passing after somebody changed the real one.
  // =========================================================================
  // Read with the line ending the file actually has — a `\n}\n` search silently
  // finds nothing in a CRLF checkout, which reads as "the renderer is missing".
  const dashboardSrc = fs.readFileSync(path.join(process.cwd(), "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
  const start = dashboardSrc.indexOf("function renderFeeCharges(line) {");
  const end = dashboardSrc.indexOf("\n}\n", start);
  check("6a. renderFeeCharges is present in the shipped dashboard", start >= 0 && end > start,
    `start=${start} end=${end}`);
  check("6b. the fee card CALLS it — a renderer nothing calls is the bug this repo keeps finding",
    /\$\{renderFeeCharges\(line\)\}/.test(dashboardSrc));
  const escCalls: string[] = [];
  const renderFeeCharges = new Function("esc", "feeMoney", `return (${dashboardSrc.slice(start, end + 2)});`)(
    // A recording esc(): what it is handed is what the card is proved to escape.
    (v: unknown) => { escCalls.push(String(v ?? "")); return String(v ?? "").replace(/[&<>"']/g, "_"); },
    (v: unknown) => (v == null ? "UNKNOWN" : `$${Number(v).toFixed(2)}`),
  ) as (line: { charges: unknown[] }) => string;

  const cardHtml = renderFeeCharges({ charges: permitLine!.charges });
  check("6c. the card itemises the charges",
    /Fire - Plan Review/.test(cardHtml) && /Land Use Plan Review Res/.test(cardHtml), cardHtml.slice(0, 300));
  check("6d. the unpriced charge reads UNRESOLVED and the block reads INCOMPLETE",
    /UNRESOLVED/.test(cardHtml) && /INCOMPLETE/.test(cardHtml), cardHtml.slice(0, 500));
  check("6e. it never renders a sum that omits a charge", !/712\.93/.test(cardHtml));
  // esc() EVERYTHING: charge labels, quotes and reasons are research output.
  check("6f. every charge label and reason went through esc()",
    escCalls.includes("Fire - Plan Review | $50.00")
    && escCalls.includes("Land Use Plan Review Res")
    && escCalls.some((v) => /CONDITIONAL CHARGE UNRESOLVED/.test(v)),
    JSON.stringify(escCalls.slice(0, 8)));
  const injected = renderFeeCharges({
    charges: [
      { label: "<img src=x onerror=alert(1)>", kind: "other", amountUsd: null, partOfLineFee: false, conditional: true, reason: "<script>alert(2)</script>", quote: "", sourceUrl: "" },
      { label: "Permit", kind: "permit", amountUsd: 10, partOfLineFee: true, conditional: false, reason: "", quote: "", sourceUrl: "" },
    ],
  });
  check("6g. markup in a charge label or reason cannot reach innerHTML",
    !/<img/.test(injected) && !/<script/.test(injected), injected.slice(0, 300));
  check("6h. OVER-CORRECTION GUARD: a filing with no charge beyond its permits draws nothing",
    renderFeeCharges({ charges: ivyPermitLine!.charges }) === "",
    renderFeeCharges({ charges: ivyPermitLine!.charges }).slice(0, 200));

  // =========================================================================
  // 7. THE TRUST RULE — an untrusted save loses the charges entirely.
  //
  // Same finding, same charges, NO LEDGER: scripts/apply-fee-findings.ts replaying a
  // hand-edited JSON file, or raw model output. A plausible invented review is
  // exactly the shape a reader would not question, so it may not reach storage down
  // any path that cannot show the bytes it read.
  // =========================================================================
  const untrusted = finding({
    basis: "flat",
    brackets: [{
      feeUsd: 153,
      label: "Building Permit RS",
      ancillaryCharges: corroborated.held.map((c) => ({ ...c })),
    }],
    sourceQuote: "Building Permit RS | $153.00",
  });
  const out = saveFeeSchedule(db, { state: "OR", ahj: "City of Gresham", track: "permit", discipline: "structural" }, untrusted);
  check("7a. the row still SAVES — this is a strip, not a refusal", out.saved === true, out.reason);
  const gresham = mkProject("proj-gresham", "City of Gresham", 3.072, 3.52, PRESCRIPTIVE_SNAPSHOT);
  const greshamFee = feeForProject(db, gresham, "permit");
  check("7b. but every ancillary charge was STRIPPED — the quote is the permit alone",
    greshamFee?.feeUsd === 153 && (greshamFee?.charges ?? []).every((c) => c.partOfLineFee),
    `fee=${greshamFee?.feeUsd} charges=${JSON.stringify((greshamFee?.charges ?? []).map((c) => c.label))}`);
  check("7c. and it is still seeded", greshamFee?.confidence === "seeded", String(greshamFee?.confidence));

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
