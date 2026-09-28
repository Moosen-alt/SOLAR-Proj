// A SERVICE UPGRADE IS A SERVICE LINE — on the portal's fee-item box, on the electrical PDF,
// and on the fee sheet, from ONE count.
//
// Live City of Corvallis (Accela) "Electrical" record, 2026-09-28: the Installation Specifics
// page prints "Service 0-200 amps (qty)", "Service 201-400 amps (qty)", … beside "Renewable
// Energy 5_kva or less (qty)". The plan set upgrades the interior panel to a new 225 A bus with a
// 200 A main breaker, and the service box stayed 0: the label recogniser demanded "feeder" in the
// label, and the quantity counted battery jobs only.
//
//   MUST PASS
//     1. "Service 0-200 amps (qty)" binds to the <=200A key; "Service 201-400 amps (qty)" binds to
//        its OWN 201-400 key (and the Oregon wording "Services or feeders: 201 amps to 400 amps"
//        with it) — through feeBracketFieldForLabel, the binder's door.
//     2. The count: MPU to a 200 A main (225 A bus) → 1 in the 0-200 tier; MPU to a 400 A main →
//        1 in the 201-400 tier; a battery → 1 (unchanged); battery + MPU 200 → 2; PV-only → 0/0;
//        unparsed → ""; MPU whose size nobody knows (a 225 A bus only) → "".
//     3. The learn: a planner that leaves the service box alone gets it typed and BOUND; a replay
//        of a recipe learned on a PV-only roof types THIS project's count.
//     4. The PDF services row and the fee sheet read the SAME count, and a line whose amount is not
//        on file leaves the totals UNRESOLVED (never a smaller total).
//
//   MUST EXCLUDE
//     - temporary service, reconnect only, manufactured dwelling, the higher tiers, the kVA rows,
//       a heading listing several tiers, a main-service RATING question, and a bare "Service 0-200
//       amps" that asks for no quantity.
//     - "derate" is not an upgrade.
//
// KILLS (each run by hand; each turns this file red):
//   (a) batteryServiceFeeder.isServiceLineLabel: drop the quantity branch (require "feeder" again).
//   (b) batteryServiceFeeder.serviceLineQuantities: `const upgrade = false;`.
//   (c) serviceScope.serviceAmps: drop step 3's `rating !== bus` guard (225 bus reads as a 225 service).
//   (d) feeBracketFields.feeBracketFieldForLabel: drop the isServiceFeeder400Label line.
//   (e) autoLearn.buildPortalPlanner: drop the service-line loop.
//
//   npx tsx backend/test/serviceLineQuantity.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-line-qty-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmpDir, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.AUTOPILOT_TEST_SEAMS = "1";
process.env.SUBMISSION_SERVICE_FEE_USD = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE", "UTILITY_FILING_LOOKUP"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

async function main(): Promise<void> {
  const { openDatabase } = await import("../src/db");
  const {
    SERVICE_FEEDER_200A_FIELD, SERVICE_FEEDER_400A_FIELD, SERVICE_FEEDER_CHARGE_KIND, SERVICE_FEEDER_400A_CHARGE_KIND,
    SERVICE_FEEDER_UPGRADE_UNBILLED_KIND, serviceLineQuantities, isServiceFeeder200Label, isServiceFeeder400Label,
  } = await import("../src/batteryServiceFeeder");
  const { hasMpuScope, serviceAmps } = await import("../src/serviceScope");
  const { feeBracketFieldForLabel, feeBracketQuantityFields } = await import("../src/feeBracketFields");
  const { convertLiteralsToBoundFields, resolveRecipeFieldValues } = await import("../src/portalRecipes");
  const { saveFeeSchedule, feeForProject, corroborateAncillaryCharges, attachAncillaryCharges, newFeeDocumentLedger } = await import("../src/feeSchedules");
  const { buildProjectFeeSheet } = await import("../src/submissionFees");
  const { resolveSource } = await import("../src/ahjForms");
  const { createProject, getProjectDetail } = await import("../src/repository");
  const { buildPortalPlanner, setAutoLearnSeamsForTests } = await import("../src/autoLearn");
  type RecipeStep = import("../../shared/src/types").RecipeStep;
  type ProjectRecord = import("../../shared/src/types").ProjectRecord;
  type Finding = import("../src/feeSchedules").FeeScheduleFinding;

  const db = await openDatabase();
  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   ${name}`);
  };

  // =========================================================================
  // 1. LABELS — through the binder's own door.
  // =========================================================================
  const CORVALLIS = {
    le200: "Service 0-200 amps (qty)",
    t400: "Service 201-400 amps (qty)",
    t600: "Service 401-600 amps (qty)",
    t1000: "Service 601-1,000 amps (qty)",
    over: "Service over 1,000 amps or volts (qty)",
    reconnect: "Service Reconnect Only (qty)",
    temp200: "Temporary Service 0-200 amps (qty)",
    temp400: "Temporary Service 201-400 amps (qty)",
    temp600: "Temporary Service 401-600 amps (qty)",
    mfd: "Manufactured Dwelling Service or Feeder (qty)",
    kva: "Renewable Energy 5_kva or less (qty)",
  };
  const MUST_PASS_200 = [
    CORVALLIS.le200,
    "SERVICE0-200AMPS(QTY)", // Accela ASI flattened
    "Service 0 - 200 amps (quantity)",
    "Service 0 to 200 A #",
    "Number of services 0-200 amps",
    // the Oregon wording is untouched
    "Services or feeders: 200 amps or less",
    // Oregon ePermitting's Marion County services page (fieldname attributes, live capture 2026-09-27)
    "Services 200 amps or less",
  ];
  for (const l of MUST_PASS_200) check(`MUST PASS <=200A: ${JSON.stringify(l)}`, feeBracketFieldForLabel(l) === SERVICE_FEEDER_200A_FIELD, feeBracketFieldForLabel(l));
  const MUST_PASS_400 = [
    CORVALLIS.t400,
    "SERVICE201-400AMPS(QTY)",
    "Services or feeders: 201 amps to 400 amps",
    "Services or feeders 201 to 400 amps",
    "Service/Feeder 201-400A",
    "Services 201 to 400 amps", // Marion County's row
  ];
  for (const l of MUST_PASS_400) check(`MUST PASS 201-400A (its OWN key): ${JSON.stringify(l)}`, feeBracketFieldForLabel(l) === SERVICE_FEEDER_400A_FIELD, feeBracketFieldForLabel(l));
  const MUST_EXCLUDE_BOTH = [
    CORVALLIS.t600, CORVALLIS.t1000, CORVALLIS.over, CORVALLIS.reconnect, CORVALLIS.temp200, CORVALLIS.temp400,
    CORVALLIS.temp600, CORVALLIS.mfd, CORVALLIS.kva,
    // a main-service RATING question, however it is spelled
    "Main service rating (amps) 0-200 (qty)",
    "Service rating: 201-400 amps (qty)",
    "Main Service Entrance Rating (Amps)",
    // "service" alone with no quantity asked is a site fact, not a fee item
    "Service 0-200 amps",
    "Service 201-400 amps",
    "Existing service size 200 amps or less",
    // a heading listing several tiers
    "Service 0-200 amps / 201-400 amps / 401-600 amps (qty)",
    "Services or feeders: 200 amps or less / 201-400 amps / 401-600 amps",
    "Service or feeder 400 amps or more",
    // Marion County's other rows on the same page
    "Services 401 to 599 amps", "Services 600 amps", "Services 601 amps to 1,000 amps", "Services over 1,000 amps or volts",
    "Temp services 200 amps or less", "Temp services 201 amps to 400 amps", "Service reconnect only",
    "Each manufactured home or modular dwelling service", "Branch circuits with service or feeder each circuit",
    // a plural that is still a site fact
    "Services size 200 amps or less", "Services (existing) 200 amps or less",
  ];
  for (const l of MUST_EXCLUDE_BOTH) {
    const k = feeBracketFieldForLabel(l);
    check(`MUST EXCLUDE (both service keys): ${JSON.stringify(l)}`, k !== SERVICE_FEEDER_200A_FIELD && k !== SERVICE_FEEDER_400A_FIELD, k);
  }
  check("the two recognisers are disjoint on the Corvallis page",
    Object.values(CORVALLIS).every((l) => !(isServiceFeeder200Label(l) && isServiceFeeder400Label(l))));
  check("the kVA row is never a service box", ![SERVICE_FEEDER_200A_FIELD, SERVICE_FEEDER_400A_FIELD].includes(feeBracketFieldForLabel(CORVALLIS.kva)), feeBracketFieldForLabel(CORVALLIS.kva));

  // =========================================================================
  // 2. THE COUNT.
  // =========================================================================
  // Fictional plan-set wording in the shape the Corvallis SLD printed.
  const MPU_200 = {
    hasBattery: "No", busRating: "225A", mainBreaker: "200A", mainServiceRating: "225A",
    scopeText: "MAIN SERVICE PANEL UPGRADE: UPGRADE THE EXISTING INTERIOR PANEL TO A NEW 225A MAIN BUS WITH A 200A MAIN BREAKER",
  };
  const MPU_400 = { hasBattery: "No", busRating: "400A", mainBreaker: "400A", scopeText: "Service upgrade to 400A meter-main." };
  const MPU_320 = { hasBattery: "No", scopeText: "MPU: new 320A main breaker, 400A bus" };
  const MPU_UNKNOWN = { hasBattery: "No", busRating: "225", mainServiceRating: "225", scopeText: "Main panel upgrade per SLD." };
  const MPU_BUS_200 = { hasBattery: "No", busRating: "200", scopeText: "Main panel upgrade per SLD." };
  const MPU_FROM_TO = { hasBattery: "No", mainBreaker: "100A", scopeText: "Service upgrade: replace the 100A main breaker with a 200A main breaker." };
  const BATTERY = { hasBattery: "Yes", batteryModel: "Test Battery 10", batteryQuantity: "1" };
  const BATTERY_MPU_200 = { ...MPU_200, hasBattery: "Yes", batteryModel: "Test Battery 10", batteryQuantity: "1" };
  const PV_ONLY = { hasBattery: "No", busRating: "200A", mainBreaker: "200A" };
  const DERATE = { hasBattery: "No", busRating: "200A", mainBreaker: "175A", scopeText: "Derate the main breaker to 175A per 705.12." };
  const cases: Array<[string, Record<string, unknown>, string, string]> = [
    ["MPU to a 200 A main on a 225 A bus (Corvallis shape) → 0-200 tier", MPU_200, "1", "0"],
    ["MPU to a 400 A main → 201-400 tier", MPU_400, "0", "1"],
    ["MPU to a 320 A main → 201-400 tier (the sentence's own amps)", MPU_320, "0", "1"],
    ["MPU, 'from 100A … to 200A main breaker' → the LAST stated main (200)", MPU_FROM_TO, "1", "0"],
    ["battery, no service work → 1 (operator rule, unchanged)", BATTERY, "1", "0"],
    ["battery + MPU 200 A → 2 (the battery's line and the service's)", BATTERY_MPU_200, "2", "0"],
    ["PV-only, parsed → 0 / 0", PV_ONLY, "0", "0"],
    ["derate is not an upgrade → 0 / 0", DERATE, "0", "0"],
    ["MPU whose size nobody knows (a 225 A bus is not a 225 A service) → blank / blank", MPU_UNKNOWN, "", ""],
    ["MPU on a 200 A bus with no main on file → the main cannot exceed the bus → 1", MPU_BUS_200, "1", "0"],
    ["unparsed snapshot → blank / blank (an unknown claims nothing)", {}, "", ""],
  ];
  for (const [name, snap, le200, t400] of cases) {
    const q = serviceLineQuantities(snap);
    check(`count: ${name}`, q.le200 === le200 && q.t201to400 === t400, JSON.stringify(q));
  }
  check("the ONE MPU predicate reads the scope, and never 'derate'",
    hasMpuScope({ parserSnapshot: MPU_200 }) && !hasMpuScope({ parserSnapshot: DERATE }) && !hasMpuScope({ parserSnapshot: PV_ONLY }));
  check("serviceAmps is the MAIN, not the bus", serviceAmps(MPU_200) === 200 && serviceAmps(MPU_UNKNOWN) === null, `${serviceAmps(MPU_200)} ${serviceAmps(MPU_UNKNOWN)}`);

  // =========================================================================
  // 3. THE PORTAL KEY — resolver, learn, replay.
  // =========================================================================
  const created = createProject(db, {
    state: "OR", ahj: "City of Tigard", utility: "Portland General Electric",
    homeownerName: "Test Owner", projectAddress: "1 Test St", city: "Tigard", zip: "97223", dcKw: 10,
  } as never);
  const base = getProjectDetail(db, created.project.id).project as ProjectRecord;
  const withSnapshot = (snapshot: Record<string, unknown>, over: Partial<ProjectRecord> = {}): ProjectRecord =>
    ({ ...base, systemSizeAcKw: 3.84, systemSizeDcKw: 3.96, parserSnapshot: snapshot as never, ...over });

  const mpuFields = feeBracketQuantityFields(db, withSnapshot(MPU_200, { ahj: "City of Nowhere", state: "WA" }));
  check("resolver: an MPU-200 job's <=200A key is '1' with no fee schedule on file", mpuFields[SERVICE_FEEDER_200A_FIELD] === "1" && mpuFields[SERVICE_FEEDER_400A_FIELD] === "0", JSON.stringify(mpuFields));
  const unknownFields = feeBracketQuantityFields(db, withSnapshot({}));
  check("resolver: both service keys are DEFINED (blank) when unknown, never absent",
    Object.prototype.hasOwnProperty.call(unknownFields, SERVICE_FEEDER_400A_FIELD) && unknownFields[SERVICE_FEEDER_400A_FIELD] === "" && unknownFields[SERVICE_FEEDER_200A_FIELD] === "");

  // The learn: the planner fills the kVA row and leaves the service boxes (what the live planner did).
  setAutoLearnSeamsForTests({
    llm: () => ({
      planPortalFields: async () => ({ fills: [{ index: 2, value: "1", field: "feeBracketQuantity:0-5" }], atReview: false, confidence: "high", notes: "" }),
    }) as never,
  });
  try {
    const { planner } = buildPortalPlanner(db, withSnapshot(MPU_200), { portalType: "accela", scopeType: "ahj", permitType: "electrical" });
    const plan = await planner({
      url: "https://aca.example.gov/Cap/CapEdit.aspx", pageTitle: "Installation Specifics", bodyText: "", alreadyFilledLabels: [],
      fields: [
        { selector: { label: CORVALLIS.le200 }, label: CORVALLIS.le200, fieldType: "text" },
        { selector: { label: CORVALLIS.t400 }, label: CORVALLIS.t400, fieldType: "text" },
        { selector: { label: CORVALLIS.kva }, label: CORVALLIS.kva, fieldType: "text" },
        { selector: { label: CORVALLIS.temp200 }, label: CORVALLIS.temp200, fieldType: "text" },
      ],
    } as never);
    const at = (i: number) => plan.fills.find((f) => f.selectorIndex === i);
    check("learn: the 0-200 box the planner left is typed '1', BOUND to the <=200A key", at(0)?.value === "1" && at(0)?.field === SERVICE_FEEDER_200A_FIELD, JSON.stringify(at(0)));
    check("learn: the 201-400 box is typed '0', bound to ITS key", at(1)?.value === "0" && at(1)?.field === SERVICE_FEEDER_400A_FIELD, JSON.stringify(at(1)));
    check("learn: the planner's own kVA fill is untouched", at(2)?.field === "feeBracketQuantity:0-5", JSON.stringify(at(2)));
    check("learn MUST EXCLUDE: the temporary-service box is never answered", !at(3), JSON.stringify(at(3)));
  } finally {
    setAutoLearnSeamsForTests({ llm: null });
  }

  // A recipe learned on a PV-only roof, the box recorded "0" as a literal, replays THIS project's count.
  const recorded: RecipeStep = { action: "fill", selector: { label: CORVALLIS.le200, id: "ctl00_ASI_SVC_0_200" } as never, value: "0", note: CORVALLIS.le200 };
  const pvLearn = convertLiteralsToBoundFields([recorded], resolveRecipeFieldValues(db, withSnapshot(PV_ONLY), "accela", "electrical"));
  check("post-learn binder: the recorded 'Service 0-200 amps (qty)' binds to the <=200A key", pvLearn.steps[0].field === SERVICE_FEEDER_200A_FIELD, String(pvLearn.steps[0].field));
  const mpuReplay = resolveRecipeFieldValues(db, withSnapshot(MPU_200), "accela", "electrical");
  check("replay: learned PV-only ('0'), replayed for an MPU-200 job → '1'", mpuReplay[String(pvLearn.steps[0].field)] === "1", JSON.stringify(mpuReplay[SERVICE_FEEDER_200A_FIELD]));

  // =========================================================================
  // 4. THE PDF AND THE FEE SHEET read the same count.
  // =========================================================================
  const TIGARD_URL = "https://www.tigard-or.gov/electrical-fees.pdf";
  const CORPUS = [
    "Renewable energy 5 kva or less | $100.70",
    "Services or feeders: 200 amps or less | $100.70",
    "Note: A 12% surcharge fee as mandated by the State Building Codes Division is applied to all permit fees, investigation fees and inspection fees listed.",
  ].join("\n");
  const ledger = newFeeDocumentLedger();
  ledger.evidence.push({ url: TIGARD_URL, via: "http", status: 200, kind: "pdf", bytes: CORPUS.length, handed: 3 });
  ledger.corpus.push(CORPUS);
  const finding: Finding = {
    found: true, reason: "", basis: "system_kw", notes: "", sourceUrl: TIGARD_URL, sourceQuote: "Renewable energy 5 kva or less | $100.70",
    sourceKind: "official", paymentMethod: "portal",
    brackets: [{ maxKw: 5, feeUsd: 100.70, label: "Renewable energy 5 kva or less" }],
  } as Finding;
  const held = corroborateAncillaryCharges([{
    label: "Services or feeders: 200 amps or less", kind: "other", amountUsd: 100.70, percentOf: "",
    conditional: true, condition: "charged when the job installs, alters or relocates a service or feeder",
    appliesTo: "electrical", quote: "Services or feeders: 200 amps or less | $100.70",
  }], finding, ledger);
  check("fixture: the services charge survives corroboration (real write path)", held.held.length === 1, JSON.stringify(held.dropped));
  attachAncillaryCharges(finding.brackets, held.held);
  saveFeeSchedule(db, { state: "OR", ahj: "City of Tigard", track: "permit", discipline: "electrical" }, finding, { corroborateAgainst: ledger });

  const mpu = withSnapshot(MPU_200);
  const elec = feeForProject(db, mpu, "electrical")!;
  const svc = elec.charges.find((c) => c.kind === SERVICE_FEEDER_CHARGE_KIND);
  check("fee sheet: an MPU-200 job carries ONE priced <=200A services line, named for the upgrade",
    svc?.amountUsd === 100.7 && /service upgrade/i.test(svc.label) && !/battery/i.test(svc.label), JSON.stringify(svc));
  check("fee sheet: the electrical total includes it (100.70 + 12.08 + 100.70 + 12.08 = 225.56)", elec.feeUsd === 225.56, String(elec.feeUsd));
  const ctx = (project: ProjectRecord, snapshot: Record<string, unknown>) => ({ project, client: {}, snapshot, publishedFeeLines: feeForProject(db, project, "permit")?.lines });
  check("PDF: the services row reads the same count and the same amount (qty 1, total 100.70)",
    resolveSource("computed.servicesFeeders200Qty", ctx(mpu, MPU_200) as never) === "1"
      && resolveSource("computed.servicesFeeders200Total", ctx(mpu, MPU_200) as never) === "100.70",
    `${resolveSource("computed.servicesFeeders200Qty", ctx(mpu, MPU_200) as never)} ${resolveSource("computed.servicesFeeders200Total", ctx(mpu, MPU_200) as never)}`);
  check("PDF: the whole-application total agrees with the fee sheet (225.56)",
    resolveSource("computed.electricalTotalFee", ctx(mpu, MPU_200) as never) === "225.56", resolveSource("computed.electricalTotalFee", ctx(mpu, MPU_200) as never));

  const both = withSnapshot(BATTERY_MPU_200);
  const bothElec = feeForProject(db, both, "electrical")!;
  const bothSvc = bothElec.charges.find((c) => c.kind === SERVICE_FEEDER_CHARGE_KIND);
  check("battery + MPU 200: TWO lines, one schedule amount each (201.40), and the PDF row says 2 / 201.40",
    bothSvc?.amountUsd === 201.4 && resolveSource("computed.servicesFeeders200Qty", ctx(both, BATTERY_MPU_200) as never) === "2"
      && resolveSource("computed.servicesFeeders200Total", ctx(both, BATTERY_MPU_200) as never) === "201.40",
    JSON.stringify(bothSvc));

  const big = withSnapshot(MPU_400);
  const bigElec = feeForProject(db, big, "electrical")!;
  const bigSvc = bigElec.charges.find((c) => c.kind === SERVICE_FEEDER_400A_CHARGE_KIND);
  check("MPU 400: the 201-400 line is listed UNPRICED (no amount on file), the total UNRESOLVED — never a smaller total",
    !!bigSvc && bigSvc.amountUsd === null && /201-400A AMOUNT MISSING/.test(bigSvc.reason) && bigElec.feeUsd === null, JSON.stringify({ bigSvc, fee: bigElec.feeUsd }));
  check("MPU 400 MUST EXCLUDE: no <=200A line and no <=200A qty on the PDF",
    !bigElec.charges.some((c) => c.kind === SERVICE_FEEDER_CHARGE_KIND) && resolveSource("computed.servicesFeeders200Qty", ctx(big, MPU_400) as never) === "");
  check("MPU 400: the PDF's whole-application total is BLANK (the 201-400 line is not priced)",
    resolveSource("computed.electricalTotalFee", ctx(big, MPU_400) as never) === "");

  const unk = withSnapshot(MPU_UNKNOWN);
  const unkElec = feeForProject(db, unk, "electrical")!;
  check("MPU of unknown size: an UNPRICED upgrade line holds the total unresolved",
    unkElec.charges.some((c) => c.kind === SERVICE_FEEDER_UPGRADE_UNBILLED_KIND && c.amountUsd === null) && unkElec.feeUsd === null,
    JSON.stringify(unkElec.charges.map((c) => [c.kind, c.amountUsd])));

  const pv = withSnapshot(PV_ONLY);
  const pvElec = feeForProject(db, pv, "electrical")!;
  check("PV-only MUST EXCLUDE: no services line of either tier", !pvElec.charges.some((c) => /^service_feeder_/.test(c.kind)), JSON.stringify({ fee: pvElec.feeUsd, kinds: pvElec.charges.map((c) => c.kind) }));
  check("MUST EXCLUDE: the building filing never carries a services line for an MPU",
    !feeForProject(db, mpu, "building")?.charges.some((c) => /^service_feeder_/.test(c.kind)));

  const nowhere = buildProjectFeeSheet(db, withSnapshot(MPU_200, { ahj: "City of Nowhere", city: "Nowhere" }));
  check("no schedule on file: the fee sheet names the service upgrade's line", nowhere.unknowns.some((u) => /^Service upgrade job: .*Services or feeders: 200 amps or less/.test(u)), JSON.stringify(nowhere.unknowns));
  check("no schedule on file, PV-only MUST EXCLUDE: no service-upgrade note",
    !buildProjectFeeSheet(db, withSnapshot(PV_ONLY, { ahj: "City of Nowhere", city: "Nowhere" })).unknowns.some((u) => /Service upgrade job/.test(u)));

  db.close();
  console.log(failures === 0 ? "\nserviceLineQuantity: all checks passed." : `\nserviceLineQuantity: ${failures} check(s) FAILED.`);
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
