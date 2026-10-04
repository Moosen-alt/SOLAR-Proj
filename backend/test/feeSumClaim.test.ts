// AN ITEMISATION MAY NOT CLAIM TO BE THE TOTAL OF A NUMBER IT DID NOT PRODUCE.
//
// THE DEFECT, MEASURED. An operator files the Portland job, reads the portal's own
// fee screen, and types the real number in: $812.40. The published schedule holds
// seven charges for that filing summing to $762.93. Both renderers then printed,
// directly beneath "Fee  $812.40":
//
//   Charges  7 charges on this filing — the fee above is their total
//            $762.93  = the sum of every charge above
//
// Both sentences are false. The quote ladder prefers an operator-entered portal
// ACTUAL over the schedule (submissionFees.buildPaymentQuote), and prefers a
// learned median over it too — but the charge itemisation is resolved from the
// schedule for EVERY quote, on purpose, because what a Portland filing is MADE OF
// is a fact about the jurisdiction and not about which tier won the amount. The two
// are simply different measurements of one filing, and the $49.47 between them is
// the expected result of preferring the better one. Asserting the smaller number is
// the sum of the bigger one turns that into an arithmetic error the reader will go
// hunting for — or, worse, into a reason to distrust the $812.40 they read off the
// portal with their own eyes.
//
//   MUST PASS    — SCHEDULE TIER: the fee came from the published schedule, so the
//                  claim is TRUE and both renderers still make it, word for word
//                  ("the fee above is their total" / "= the sum of every charge
//                  above" / "Sum of every charge");
//                  HIGHER TIER: an operator's $812.40 portal actual over the same
//                  schedule — the claim is WITHDRAWN from both renderers, the seven
//                  charges are STILL itemised, the schedule's $762.93 is still
//                  printed and labelled as the schedule's own figure, and the
//                  difference is stated to be expected rather than an error;
//                  the same withdrawal on the LEARNED-HISTORY tier, which proves
//                  the switch is the tier and not the word "actual";
//                  the MULTI-PERMIT sentence ("N separate permits — the fee above is
//                  their total") is the same claim and is withdrawn on the same
//                  condition;
//                  esc() still covers every label and reason in the WITHDRAWN path —
//                  it is a different branch of the card and markup must not reach
//                  innerHTML through it either.
//
//   MUST EXCLUDE — the INCOMPLETE behaviour from the previous round is untouched: a
//                  filing with one unpriced charge claims NO sum under ANY tier, and
//                  this change must never turn an incomplete set into a confident
//                  one. Checked on both renderers, and checked BEFORE the tier
//                  question so the ordering of the two guards is pinned;
//                  a complete schedule-tier filing keeps the claim it has earned —
//                  withdrawing it everywhere would be the over-correction.
//
// THE REVERT PROOF (run by hand; output quoted in the round notes). Each renderer's
// conditional was reverted ALONE, because a combined revert cannot tell you whether
// the other renderer's checks bite:
//   (a) scripts/fee-sheet.ts — force `feeIsTheSchedule = true`. Section 3 goes red:
//       "3a. … the CLI no longer claims the schedule's sum is the fee above" and
//       "3b/3c" fail with the false sentences back in the output.
//   (b) frontend/dashboard.js — force `feeIsTheSchedule = true`. Section 3's card
//       checks go red: the card reads "Sum of every charge" beneath $812.40 again.
//
// BOTH RENDERERS ARE DRIVEN, NOT COPIED. The CLI's renderFeeLine is imported from
// scripts/fee-sheet.ts and the whole script is additionally SPAWNED through its real
// CLI entry; the dashboard's renderFeeCharges is lifted out of the shipped
// frontend/dashboard.js at runtime. A copy of either would go on passing after
// somebody changed the real one.
//
//   npx tsx backend/test/feeSumClaim.test.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-sum-claim-"));
  const dbPath = path.join(dir, "test.db");
  // Before anything imports ../src/db.
  process.env.AUTOPILOT_DB_PATH = dbPath;
  process.env.AUTOPILOT_LOG_FILE = "";
  process.env.SUBMISSION_SERVICE_FEE_USD = "100";
  delete process.env.PERMIT_FEE_ESTIMATE_RATE;
  delete process.env.PERMIT_FEE_ESTIMATE_MIN_USD;
  delete process.env.PERMIT_FEE_ESTIMATE_MAX_USD;

  const { openDatabase } = await import("../src/db");
  const {
    saveFeeSchedule, corroborateAncillaryCharges, attachAncillaryCharges, newFeeDocumentLedger,
  } = await import("../src/feeSchedules");
  const { createClient } = await import("../src/clients");
  const { getProjectDetail } = await import("../src/repository");
  const { recordActualPermitFee } = await import("../src/submissionFees");
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
  // THE FIXTURE — Portland's real charges, saved through the real write path.
  //
  // Every charge is corroborated against a retrieved corpus before storage, the way
  // production does it; a fixture that wrote brackets_json directly would prove
  // nothing about the path a live row travels.
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

  const reportedCharges = (fireConditional: boolean): unknown[] => ([
    {
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

  const savePortland = (fireConditional: boolean): number => {
    const structuralFinding = finding({
      basis: "flat",
      brackets: [{ feeUsd: 153, label: "Building Permit RS" }],
      sourceQuote: "Building Permit RS | $153.00",
    });
    const l = ledger();
    const ancillary = corroborateAncillaryCharges(reportedCharges(fireConditional), structuralFinding, l);
    attachAncillaryCharges(structuralFinding.brackets, ancillary.held);
    saveFeeSchedule(db, { state: "OR", ahj: "City of Portland", track: "permit", discipline: "structural" },
      structuralFinding, { corroborateAgainst: l });
    saveFeeSchedule(db, { state: "OR", ahj: "City of Portland", track: "permit", discipline: "electrical" },
      finding({
        basis: "system_kw",
        brackets: [{ minKw: 0, maxKw: 5, feeUsd: 201, label: "Electrical Permit RS" }],
        sourceQuote: "Electrical Permit RS | $201.00",
      }), { corroborateAgainst: ledger() });
    return ancillary.held.length;
  };

  // TWO PERMITS AND NOTHING ELSE — the shape that exercises the "N separate permits
  // — the fee above is their total" sentence, which carries the same claim and needs
  // the same gate. Drew Example's live Coos pair, verbatim.
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

  const heldCharges = savePortland(false);

  const client = createClient(db, { companyName: "Claim Solar", billingMode: "per_submission", serviceFeeUsd: "100" });
  const now = new Date().toISOString();
  const PRESCRIPTIVE_SNAPSHOT = { mounting: "Roof mount", pvMicroMake: "Enphase", pvMicroModel: "IQ8PLUS-72-2-US" };
  const mkProject = (id: string, ahj: string) => {
    db.run(
      `INSERT INTO projects (id, client_id, homeowner_name, state, ahj, utility, system_size_ac_kw, system_size_dc_kw, status, parser_json, created_at, updated_at)
       VALUES (?, ?, ?, 'OR', ?, 'Portland General Electric', 3.072, 3.52, 'ready_to_stage', ?, ?, ?)`,
      [id, client.id, `Owner ${id}`, ahj, JSON.stringify(PRESCRIPTIVE_SNAPSHOT), now, now],
    );
    return getProjectDetail(db, id).project;
  };
  const KISKA = mkProject("proj-kiska", "City of Portland");
  const IVY = mkProject("proj-ivy", "City of Coos Bay");

  // The dashboard's card, lifted OUT OF THE SHIPPED FILE. Not a copy: a copy would
  // go on passing after somebody changed the real renderer.
  const dashboardSrc = fs.readFileSync(path.join(process.cwd(), "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
  const start = dashboardSrc.indexOf("function renderFeeCharges(line) {");
  const end = dashboardSrc.indexOf("\n}\n", start);
  const escSeen: string[] = [];
  const card = new Function("esc", "feeMoney", `return (${dashboardSrc.slice(start, end + 2)});`)(
    (v: unknown) => { escSeen.push(String(v ?? "")); return String(v ?? "").replace(/[&<>"']/g, "_"); },
    (v: unknown) => (v == null ? "UNKNOWN" : `$${Number(v).toFixed(2)}`),
  ) as (line: unknown) => string;
  check("0a. the shipped dashboard renderer was lifted, not copied",
    start >= 0 && end > start && typeof card === "function", `start=${start} end=${end}`);
  check("0b. the fee card still CALLS it with the whole line — `source` must reach it",
    /\$\{renderFeeCharges\(line\)\}/.test(dashboardSrc));

  /** The CLI line an operator actually reads, and the card, for one project. */
  const draw = (projectId: string) => {
    const project = getProjectDetail(db, projectId).project;
    const view = buildFeeSheetPresentation(db, project);
    const line = view.sheet.lines.find((l) => l.track === "permit")!;
    return {
      line,
      cli: renderFeeLine(line, view.schedules.permit, view.agreements.permit, view.sheet.billingRequired),
      html: card(line),
    };
  };

  // THE TWO SENTENCES THIS FILE EXISTS TO POLICE, as literals. Asserting their
  // ABSENCE is what makes the revert fail loudly — new wording being present proves
  // only that something was added.
  const CLI_CLAIM = "the fee above is their total";
  const CLI_SUM_CLAIM = "= the sum of every charge above";
  const CARD_CLAIM = "Sum of every charge";

  // =========================================================================
  // 1. THE FIXTURE'S OWN PREMISES.
  // =========================================================================
  check("1a. all three ancillary charges were found printed and stored", heldCharges === 3, String(heldCharges));

  // =========================================================================
  // 2. SCHEDULE TIER — the claim is TRUE here and must survive untouched.
  //    Withdrawing it everywhere would be the over-correction.
  // =========================================================================
  const scheduleTier = draw("proj-kiska");
  check("2a. PRECONDITION: the published schedule produced this fee",
    scheduleTier.line.source === "published_schedule" && scheduleTier.line.feeUsd === 762.93,
    `source=${scheduleTier.line.source} fee=${scheduleTier.line.feeUsd}`);
  check("2b. the CLI still says the fee above is the charges' total",
    scheduleTier.cli.includes(CLI_CLAIM) && scheduleTier.cli.includes(CLI_SUM_CLAIM),
    scheduleTier.cli.slice(0, 500));
  check("2c. and the sum it states is the fee it sits under",
    /\$762\.93\s+= the sum of every charge above/.test(scheduleTier.cli), scheduleTier.cli.slice(0, 700));
  check("2d. the card still says Sum of every charge",
    scheduleTier.html.includes(CARD_CLAIM) && scheduleTier.html.includes("$762.93")
    && !scheduleTier.html.includes("did NOT come from the published schedule"),
    scheduleTier.html.slice(0, 400));

  // THE MULTI-PERMIT SENTENCE, same claim, schedule tier: Coos Bay's two permits and
  // no ancillary charges.
  const coosSchedule = draw("proj-ivy");
  check("2e. PRECONDITION: Coos is two permits, schedule-sourced, no ancillary charges",
    coosSchedule.line.source === "published_schedule" && coosSchedule.line.feeUsd === 335
    && coosSchedule.line.charges.every((c) => c.partOfLineFee),
    `source=${coosSchedule.line.source} fee=${coosSchedule.line.feeUsd}`);
  check("2f. the CLI says the two permits total the fee above",
    /2 separate permits — the fee above is their total/.test(coosSchedule.cli), coosSchedule.cli.slice(0, 500));

  // =========================================================================
  // 3. HIGHER TIER — the operator's $812.40 portal actual. THE CLAIM GOES;
  //    the itemisation stays.
  // =========================================================================
  recordActualPermitFee(db, KISKA, "permit", 812.4, "operator");
  const higherTier = draw("proj-kiska");
  check("3a. PRECONDITION: the portal actual won the amount, and it is not the schedule's",
    higherTier.line.source === "actual" && higherTier.line.feeUsd === 812.4,
    `source=${higherTier.line.source} fee=${higherTier.line.feeUsd}`);
  check("3b. the CLI no longer claims the charges total the fee above",
    !higherTier.cli.includes(CLI_CLAIM), higherTier.cli.slice(0, 900));
  check("3c. nor that the figure below them is the sum of the fee above",
    !higherTier.cli.includes(CLI_SUM_CLAIM), higherTier.cli.slice(0, 900));
  check("3d. it presents the list as what the PUBLISHED SCHEDULE holds",
    /PUBLISHED SCHEDULE holds them/.test(higherTier.cli), higherTier.cli.slice(0, 900));
  check("3e. the schedule's own $762.93 is still printed, and named as NOT the fee above",
    /\$762\.93\s+= what the published schedule holds for this filing — NOT the \$812\.40 above\./.test(higherTier.cli),
    higherTier.cli.slice(0, 900));
  check("3f. and the difference is stated to be expected, not an error",
    /outranks the published schedule/.test(higherTier.cli) && /is not an error in either/.test(higherTier.cli),
    higherTier.cli.slice(0, 900));
  check("3g. EVERY CHARGE IS STILL ITEMISED — the withdrawal removes a claim, not the list",
    /Fire - Plan Review/.test(higherTier.cli) && /Land Use Plan Review Res/.test(higherTier.cli)
    && /Bldg Plan Rvw\/Processing/.test(higherTier.cli) && /Electrical Permit RS/.test(higherTier.cli)
    && /State surcharge/.test(higherTier.cli), higherTier.cli.slice(0, 900));

  check("3h. the card no longer says Sum of every charge", !higherTier.html.includes(CARD_CLAIM),
    higherTier.html.slice(0, 600));
  check("3i. it labels the figure as what the published schedule holds",
    higherTier.html.includes("What the published schedule holds") && higherTier.html.includes("$762.93"),
    higherTier.html.slice(0, 600));
  check("3j. and says the fee above did NOT come from the schedule, so a difference is expected",
    /did NOT come from the published schedule/.test(higherTier.html)
    && /is not an error in either/.test(higherTier.html), higherTier.html.slice(0, 900));
  check("3k. the card still itemises every charge",
    /Fire - Plan Review/.test(higherTier.html) && /Land Use Plan Review Res/.test(higherTier.html)
    && /Bldg Plan Rvw\/Processing/.test(higherTier.html), higherTier.html.slice(0, 600));

  // =========================================================================
  // 4. IT IS THE TIER, NOT THE WORD "actual". A second Portland project now reads
  //    the median of real fees seen here before — also above the schedule.
  // =========================================================================
  mkProject("proj-kiska2", "City of Portland");
  const learnedTier = draw("proj-kiska2");
  check("4a. PRECONDITION: this one is sourced from learned history, not the schedule",
    learnedTier.line.source === "learned_history" && learnedTier.line.feeUsd === 812.4,
    `source=${learnedTier.line.source} fee=${learnedTier.line.feeUsd}`);
  check("4b. the claim is withdrawn on that tier too",
    !learnedTier.cli.includes(CLI_CLAIM) && !learnedTier.cli.includes(CLI_SUM_CLAIM)
    && !learnedTier.html.includes(CARD_CLAIM),
    learnedTier.cli.slice(0, 700));
  check("4c. and the itemisation survives it",
    /Land Use Plan Review Res/.test(learnedTier.cli) && /Land Use Plan Review Res/.test(learnedTier.html));

  // THE MULTI-PERMIT SENTENCE ON A HIGHER TIER.
  recordActualPermitFee(db, IVY, "permit", 400, "operator");
  const coosActual = draw("proj-ivy");
  check("4d. PRECONDITION: Coos now quotes the operator's $400 portal actual",
    coosActual.line.source === "actual" && coosActual.line.feeUsd === 400,
    `source=${coosActual.line.source} fee=${coosActual.line.feeUsd}`);
  check("4e. the two permits are still listed, but no longer claimed to total the fee above",
    /2 separate permits/.test(coosActual.cli) && !coosActual.cli.includes(CLI_CLAIM),
    coosActual.cli.slice(0, 700));

  // =========================================================================
  // 5. THE PREVIOUS ROUND'S GUARD IS UNTOUCHED — an unpriced charge claims NO sum
  //    under ANY tier. This change must not turn an incomplete set into a confident
  //    one, and the incomplete branch must stay AHEAD of the tier question.
  // =========================================================================
  savePortland(true); // the fire review becomes conditional and nobody has answered it
  const incompleteHigher = draw("proj-kiska"); // still carrying the $812.40 actual
  check("5a. PRECONDITION: a charge is unpriced while a HIGHER tier owns the amount",
    incompleteHigher.line.source === "actual"
    && incompleteHigher.line.charges.some((c) => c.amountUsd == null),
    `source=${incompleteHigher.line.source} unpriced=${incompleteHigher.line.charges.filter((c) => c.amountUsd == null).length}`);
  check("5b. the CLI claims no sum at all — INCOMPLETE, not a schedule figure",
    /INCOMPLETE — 1 of 7 charge\(s\) unpriced/.test(incompleteHigher.cli)
    && !incompleteHigher.cli.includes(CLI_SUM_CLAIM)
    && !/what the published schedule holds for this filing —/.test(incompleteHigher.cli),
    incompleteHigher.cli.slice(0, 900));
  check("5c. and the card reads INCOMPLETE with no total label of any kind",
    /INCOMPLETE/.test(incompleteHigher.html)
    && /No total — a charge above is unpriced/.test(incompleteHigher.html)
    && !incompleteHigher.html.includes(CARD_CLAIM)
    && !incompleteHigher.html.includes("What the published schedule holds"),
    incompleteHigher.html.slice(0, 700));
  check("5d. it never prints the partial sum that omits the unpriced charge",
    !/712\.93/.test(incompleteHigher.cli) && !/712\.93/.test(incompleteHigher.html));

  // The same guard on the SCHEDULE tier, which is where the previous round left it.
  const incompleteSchedule = draw("proj-kiska2");
  check("5e. PRECONDITION: schedule tier cannot own an unpriced filing — it falls through",
    incompleteSchedule.line.source !== "published_schedule", incompleteSchedule.line.source);
  check("5f. and it still claims nothing", /INCOMPLETE/.test(incompleteSchedule.cli)
    && !incompleteSchedule.cli.includes(CLI_SUM_CLAIM), incompleteSchedule.cli.slice(0, 500));

  savePortland(false); // restore the priced fixture for the CLI-entry run below

  // =========================================================================
  // 6. esc() STILL COVERS THE WITHDRAWN PATH. It is a different branch of the card,
  //    and a charge label is research output whichever branch draws it.
  // =========================================================================
  escSeen.length = 0;
  const injected = card({
    source: "actual",
    feeUsd: 812.4,
    charges: [
      { label: "<img src=x onerror=alert(1)>", kind: "other", amountUsd: 217, partOfLineFee: false, conditional: true, reason: "<script>alert(2)</script>", quote: "", sourceUrl: "" },
      { label: "Permit", kind: "permit", amountUsd: 10, partOfLineFee: true, conditional: false, reason: "", quote: "", sourceUrl: "" },
    ],
  });
  check("6a. PRECONDITION: this is the complete, higher-tier branch",
    injected.includes("What the published schedule holds") && !injected.includes(CARD_CLAIM),
    injected.slice(0, 300));
  check("6b. markup in a charge label cannot reach innerHTML through it",
    !/<img/.test(injected) && !/<script/.test(injected), injected.slice(0, 400));
  check("6c. the label went through esc()", escSeen.includes("<img src=x onerror=alert(1)>"),
    JSON.stringify(escSeen.slice(0, 6)));
  // `source` is the field this whole change reads, so it is the field most likely to
  // be echoed into the withdrawn wording by whoever edits it next. It is a server
  // enum today; it is still a string arriving over HTTP, and the card has no business
  // trusting it. This fails the moment somebody names the source in that sentence
  // without esc() around it.
  const injectedSource = card({
    source: "<img src=x onerror=alert(3)>",
    feeUsd: 812.4,
    charges: [
      { label: "Land Use Plan Review Res", kind: "land_use_review", amountUsd: 217, partOfLineFee: false, conditional: false, reason: "", quote: "", sourceUrl: "" },
      { label: "Permit", kind: "permit", amountUsd: 10, partOfLineFee: true, conditional: false, reason: "", quote: "", sourceUrl: "" },
    ],
  });
  check("6d. PRECONDITION: an unrecognised source takes the withdrawn branch",
    injectedSource.includes("What the published schedule holds") && !injectedSource.includes(CARD_CLAIM),
    injectedSource.slice(0, 300));
  check("6e. and the source itself cannot reach innerHTML through that wording",
    !/<img/.test(injectedSource), injectedSource.slice(0, 500));

  db.close();

  // =========================================================================
  // 7. THE REAL CLI ENTRY. Section 3 drove the exported renderer; this drives the
  //    SCRIPT, argv and all, because that is what an operator types.
  // =========================================================================
  const cliRun = spawnSync("npx", ["tsx", "scripts/fee-sheet.ts", "--project", "proj-kiska", "--db", dbPath], {
    cwd: process.cwd(), encoding: "utf8", shell: process.platform === "win32", timeout: 180_000,
    env: { ...process.env, AUTOPILOT_DB_PATH: dbPath, AUTOPILOT_LOG_FILE: "" },
  });
  const stdout = String(cliRun.stdout ?? "");
  check("7a. the CLI entry ran and priced the project",
    cliRun.status === 0 && /1 project\(s\) priced/.test(stdout),
    `status=${cliRun.status} stderr=${String(cliRun.stderr ?? "").slice(0, 400)}`);
  if (process.env.SHOW_FEE_SHEET) console.log(`<<<CLI>>>\n${stdout}\n<<<END>>>`);
  check("7b. and its output makes no false claim about the $812.40 it prints",
    stdout.includes("$812.40") && !stdout.includes(CLI_CLAIM) && !stdout.includes(CLI_SUM_CLAIM),
    stdout.slice(0, 1200));
  check("7c. while still itemising the filing as the published schedule holds it",
    /PUBLISHED SCHEDULE holds them/.test(stdout) && /\$762\.93/.test(stdout)
    && /Land Use Plan Review Res/.test(stdout), stdout.slice(0, 1200));

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
