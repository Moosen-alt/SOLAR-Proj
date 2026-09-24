// A BATTERY ON AN ELECTRICAL PERMIT BILLS ONE "SERVICES OR FEEDERS: 200 AMPS OR
// LESS" LINE — on the portal's fee-item box, on the electrical PDF, and on the fee
// sheet, and nowhere else.
//
// Operator rule, 2026-09-24, verbatim: "for battery jobs, when on an elec permit,
// it will count as 'Services/feeders 200 amps or less'".
//
//   MUST PASS
//     1. The label recogniser binds every spelling a portal or form prints the line
//        in (Oregon schedule wording, Accela ASI flattened labels, pdf.js squashed
//        text) to ONE key — and the kVA label still binds to its bracket.
//     2. The battery predicate agrees with the portal's own battery declaration
//        (portalRecipes energySource) on every snapshot shape.
//     3. Portal replay: the box is recomputed PER PROJECT. A recipe learned on a
//        PV-only roof ("0") replays "1" for a battery job; one learned on a battery
//        roof ("1") replays "0" for a PV-only job; an unknown battery replays BLANK,
//        never the learn project's literal.
//     4. Fee sheet: a battery job on an electrical filing carries the services line
//        priced from the schedule, with its own quote and source and its surcharge,
//        and the total includes it.
//     5. PDF: Tigard's (overlay) and Coos County's (AcroForm) electrical
//        applications fill the <=200A quantity and total, and the whole-application
//        subtotal/surcharge/total include the line.
//     6. A schedule that does not record the amount says so, by name, on the fee
//        sheet — the line is carried unpriced, the total is UNRESOLVED, and nothing
//        prices it at $0. The PDF leaves every whole-application figure blank.
//
//   MUST EXCLUDE
//     - 201-400 / 401-600 amp service rows, temporary services, the PV kVA rows,
//       branch circuits "with purchase of a service or feeder fee", "service or
//       feeder not included", manufactured-home service/feeder, a main-service
//       RATING question.
//     - No battery: no services line on the fee sheet, qty blank on the PDF, "0" in
//       the portal box.
//     - Battery on a BUILDING/structural filing or an NEM application: no line.
//
// THE KILL TESTS (each run by hand; each turns this file red):
//   (a) feeSchedules.serviceFeederCharges: `return [];` at the top.
//   (b) feeBracketFields.feeBracketFieldForLabel: drop the isServiceFeeder200Label line.
//   (c) feeBracketFields.feeBracketQuantityFields: drop ...serviceFeederQuantityFields.
//   (d) batteryServiceFeeder.feeFilingIsElectrical: `return true;`.
//   (e) ahjForms computed(): drop `if (svc.applies && !svc.priced) return "";`.
//   (f) feeSchedules.ancillaryCharges: drop the battery skip — the stored conditional
//       charge then ALSO lists, unanswered, and nulls a total that is known.
//   (g) submissionFees.buildProjectFeeSheet: make the battery-note condition false —
//       a battery job with no schedule that evaluates loses every mention of the line.
//
//   npx tsx backend/test/batteryServiceFeeder.test.ts
import { REPO } from "./_isolate";
import fs from "node:fs";
import path from "node:path";

async function main(): Promise<void> {
  process.env.SEED_TEST_INSTALLER = "false";
  process.env.AUTOPILOT_AUTO_START = "0";
  process.env.SUBMISSION_SERVICE_FEE_USD = "0";

  const { openDatabase } = await import("../src/db");
  const {
    saveFeeSchedule, feeForProject, corroborateAncillaryCharges, attachAncillaryCharges, newFeeDocumentLedger,
  } = await import("../src/feeSchedules");
  const { feeBracketQuantityFields, feeBracketFieldForLabel } = await import("../src/feeBracketFields");
  const {
    SERVICE_FEEDER_200A_FIELD, SERVICE_FEEDER_CHARGE_KIND, SERVICE_FEEDER_STATE_SURCHARGE_KIND,
    batteryStatus, feeFilingIsElectrical,
  } = await import("../src/batteryServiceFeeder");
  const { FEE_BRACKET_FIELD_PREFIX } = await import("../../portal-bot/src/feeBracketQuantity");
  const { convertLiteralsToBoundFields, deadFieldBindings, resolveRecipeFieldValues } = await import("../src/portalRecipes");
  const { planFeeBracketBindings } = await import("../src/bindFeeBrackets");
  const { createProject, getProjectDetail } = await import("../src/repository");
  const { buildProjectFeeSheet, recordActualPermitFee } = await import("../src/submissionFees");
  const { resolveSource, fillLoadedForm } = await import("../src/ahjForms");
  const { curatedFormMap } = await import("../src/curatedAhjForms");
  const { extractLabels } = await import("../src/formTextLayer");
  const { PDFDocument } = await import("pdf-lib");
  type Finding = import("../src/feeSchedules").FeeScheduleFinding;
  type Ledger = import("../src/feeSchedules").FeeDocumentLedger;
  type RecipeStep = import("../../shared/src/types").RecipeStep;
  type ProjectRecord = import("../../shared/src/types").ProjectRecord;

  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   ${name}`);
  };

  // =========================================================================
  // 1. THE LABEL — must-pass and must-exclude, through the binder's own door.
  // =========================================================================
  const MUST_PASS = [
    "Services or feeders: 200 amps or less",
    "Service/Feeder - 200 amps or less",
    "Services/feeders 200 amp or less",
    "SERVICES OR FEEDERS 200 AMPS OR LESS:",
    // Accela ASI: section heading and row flattened into one label.
    "Services or Feeders (installation, alteration, relocation) 200 amps or less",
    "SERVICES OR FEEDERS - INSTALLATION, ALTERATION OR RELOCATION - 200 AMPS OR LESS (QTY)",
    // City of Tigard electrical application, heading + row.
    "Services or feeders installation, alteration, and/or relocation 200 amps or less",
    // pdf.js squashes Coos County's text layer.
    "Servicesorfeeders(installation,alteration,relocation)200ampsorless",
    "Service or Feeder: up to 200 amps",
    "Services/Feeders 200A or less",
    // SKEPTIC MUST-FIX A (2026-09-24). Both binders hand this recogniser the
    // selector label AND the step note, joined. A neighbouring-line word that is
    // only a substring ("solar" in a note, "panel", "rating" inside "operating")
    // must not unbind the box — an unbound box replays the LEARN project's
    // literal with no key and no warning, which is the under-bill this exists
    // to stop.
    "Services or feeders: 200 amps or less qty for the solar + battery electrical permit",
    "Services or feeders: 200 amps or less (includes panel)",
    "Services or feeders 200 amps or less - operating",
    "Services or feeders: 200 amps or less (panel upgrade included)",
    // SKEPTIC MUST-FIX B: a printed dollar amount is not an amperage tier ...
    "Services or feeders: 200 amps or less $401.00",
    "Services or feeders: 200 amps or less | $1,001.00",
    // ... and the "<=" spelling (squash used to strip "=", so this branch was dead).
    "Service/Feeder <= 200A",
  ];
  for (const label of MUST_PASS) {
    check(`MUST PASS label binds: ${JSON.stringify(label)}`,
      feeBracketFieldForLabel(label) === SERVICE_FEEDER_200A_FIELD, feeBracketFieldForLabel(label));
  }
  const MUST_EXCLUDE = [
    "Services or feeders: 201 amps to 400 amps",
    "Services or feeders 201 to 400 amps",
    "Service/Feeder 401-600 amps",
    "Services or feeders: 401 amps to 600 amps",
    "Services or feeders: 601 amps to 1,000 amps",
    "Services or feeders: 1,200 amps or less",
    "Service or feeder 400 amps or more",
    "Temporary services or feeders: 200 amps or less",
    "Temp. services or feeders (installation, alteration, relocation) 200ampsorless",
    "Fee for branch circuits with purchase of a service or feeder fee: Each branch circuit",
    "Fee for branch circuits without purchase of a service or feeder fee: First branch circuit",
    "Branch circuits, new, each",
    "Miscellaneous (service or feeder not included)",
    "Each manufactured home or modular dwelling service or feeder",
    "Main service/feeder rating (amps) 200 or less",
    "Main service rating (amps)",
    "Services or feeders: reconnect only",
    // SKEPTIC MUST-FIX A: still excluded after the neighbouring-line list is
    // narrowed and "rating" is anchored.
    "Main service rating (amps) 200 or less",
    "Main Service Entrance Rating (Amps)",
    "Main service/feeder rating: 200 amps or less",
    "MainService/FeederRating200ampsorless",
    "Renewable energy for electrical systems- 5.01kva through 15kva:",
    // SKEPTIC MUST-FIX B: a heading that lists every tier. squash() turned
    // "201-400" into "201400", which defeated the tier guard's digit lookarounds,
    // so this BOUND — and "1" would be typed into the 201-400 row too.
    "Services or feeders: 200 amps or less / 201-400 amps / 401-600 amps",
    "Services or feeders 200 amps or less, 201-400 amps",
    "Servicesorfeeders200ampsorless/201-400amps/401-600amps",
    // NEM / building vocabulary — no fee item of this kind exists there.
    "Energy Storage",
    "Does the system include battery storage?",
    "Battery manufacturer",
    "Declared job valuation",
  ];
  for (const label of MUST_EXCLUDE) {
    check(`MUST EXCLUDE label: ${JSON.stringify(label)}`,
      feeBracketFieldForLabel(label) !== SERVICE_FEEDER_200A_FIELD, feeBracketFieldForLabel(label));
  }
  check("the PV kVA label still binds to ITS bracket, never to the services line",
    feeBracketFieldForLabel("Renewable energy for electrical systems- 5.01kva through 15kva:") === `${FEE_BRACKET_FIELD_PREFIX}5.01-15`);

  // =========================================================================
  // 2. THE BATTERY PREDICATE agrees with the portal's own battery declaration.
  // =========================================================================
  const created = createProject(db, {
    state: "OR", ahj: "City of Tigard", utility: "Portland General Electric",
    homeownerName: "Test Owner", projectAddress: "1 Test St", city: "Tigard", zip: "97223", dcKw: 10,
  } as never);
  const baseProject = getProjectDetail(db, created.project.id).project as ProjectRecord;
  const withSnapshot = (snapshot: Record<string, unknown> | null, over: Partial<ProjectRecord> = {}): ProjectRecord =>
    ({ ...baseProject, systemSizeAcKw: 9, systemSizeDcKw: 10, parserSnapshot: snapshot as never, ...over });

  const BATTERY = { hasBattery: "Yes", batteryModel: "Powerwall 3", batteryQuantity: "1" };
  const NO_BATTERY = { hasBattery: "No" };
  const shapes: Array<[string, Record<string, unknown> | null]> = [
    ["hasBattery Yes", { hasBattery: "Yes" }],
    ["batteryModel only (never normalised)", { batteryModel: "IQ Battery 5P" }],
    ["batteryQty only (raw parser key)", { batteryQty: "2" }],
    ["hasBattery No", NO_BATTERY],
    ["empty snapshot", {}],
  ];
  for (const [name, snap] of shapes) {
    const portal = resolveRecipeFieldValues(db, withSnapshot(snap), "powerclerk").energySource === "Solar PV and Battery";
    check(`battery predicate agrees with the portal's energySource: ${name}`,
      (batteryStatus(snap) === "yes") === portal, `${batteryStatus(snap)} vs ${portal}`);
  }
  check("an EXPLICIT no is 'no'; silence is 'unknown', never 'no'",
    batteryStatus(NO_BATTERY) === "no" && batteryStatus({}) === "unknown" && batteryStatus(null) === "unknown");
  check("the filing predicate: electrical/combo/mpu/undifferentiated yes; structural/building/NEM no",
    feeFilingIsElectrical("permit", "electrical") && feeFilingIsElectrical("permit", "combo")
      && feeFilingIsElectrical("mpu", "") && feeFilingIsElectrical("permit", "")
      && !feeFilingIsElectrical("permit", "structural") && !feeFilingIsElectrical("building", "")
      && !feeFilingIsElectrical("nem", "") && !feeFilingIsElectrical("permit", "building"));

  // =========================================================================
  // 3. PORTAL REPLAY — recomputed per project, never carried from the learn.
  // =========================================================================
  const BOX_LABEL = "Services or feeders: 200 amps or less";
  const recorded = (value: string): RecipeStep => ({
    action: "fill", selector: { label: BOX_LABEL, id: "ctl00_ASI_SERVICES_200" }, value, note: BOX_LABEL,
  } as RecipeStep);

  const pvOnlyLearn = convertLiteralsToBoundFields([recorded("0")], resolveRecipeFieldValues(db, withSnapshot(NO_BATTERY), "accela"));
  const boundStep = pvOnlyLearn.steps[0];
  check("the post-learn binder binds the recorded services box to the per-project key",
    boundStep.field === SERVICE_FEEDER_200A_FIELD, String(boundStep.field));
  const batteryReplay = resolveRecipeFieldValues(db, withSnapshot(BATTERY), "accela");
  check("learned on a PV-only roof ('0'), replayed for a BATTERY job -> '1'",
    batteryReplay[String(boundStep.field)] === "1", JSON.stringify(batteryReplay[String(boundStep.field)]));

  const batteryLearn = convertLiteralsToBoundFields([recorded("1")], batteryReplay);
  const pvReplay = resolveRecipeFieldValues(db, withSnapshot(NO_BATTERY), "accela");
  check("learned on a battery roof ('1'), replayed for a PV-only job -> '0'",
    batteryLearn.steps[0].field === SERVICE_FEEDER_200A_FIELD && pvReplay[SERVICE_FEEDER_200A_FIELD] === "0",
    JSON.stringify(pvReplay[SERVICE_FEEDER_200A_FIELD]));
  const unknownReplay = resolveRecipeFieldValues(db, withSnapshot({}), "accela");
  check("an UNKNOWN battery is a DEFINED empty key (typed blank), never absent (which replays the learn literal)",
    Object.prototype.hasOwnProperty.call(unknownReplay, SERVICE_FEEDER_200A_FIELD) && unknownReplay[SERVICE_FEEDER_200A_FIELD] === "");
  check("feeBracketQuantityFields emits it with no fee schedule on file at all",
    feeBracketQuantityFields(db, withSnapshot(BATTERY, { ahj: "City of Nowhere", state: "WA" }))[SERVICE_FEEDER_200A_FIELD] === "1");
  check("a bound services step is never a dead binding",
    deadFieldBindings([boundStep], unknownReplay).length === 0);
  check("recipe:bind-fee-brackets binds an already-recorded services box too",
    planFeeBracketBindings([recorded("0")])[0]?.field === SERVICE_FEEDER_200A_FIELD);
  // MUST-FIX A through the REAL concatenation both binders perform (label + " " +
  // note): a bare services label whose step note mentions the solar job.
  const notedStep = {
    action: "fill", selector: { label: BOX_LABEL, id: "ctl00_ASI_SERVICES_200" }, value: "0",
    note: "qty for the solar + battery electrical permit",
  } as RecipeStep;
  check("post-learn binder: a note mentioning 'solar' does not unbind the services box",
    convertLiteralsToBoundFields([notedStep], pvReplay).steps[0].field === SERVICE_FEEDER_200A_FIELD,
    String(convertLiteralsToBoundFields([notedStep], pvReplay).steps[0].field));
  check("recipe:bind-fee-brackets: a note mentioning 'solar' does not unbind the services box",
    planFeeBracketBindings([notedStep])[0]?.field === SERVICE_FEEDER_200A_FIELD,
    JSON.stringify(planFeeBracketBindings([notedStep])));

  // =========================================================================
  // 4-6. FEE SHEET AND PDF.
  //
  // Stored through the REAL write path: research reports the services line as a
  // second charge on the electrical filing, corroborateAncillaryCharges finds it
  // printed in the retrieved corpus, and saveFeeSchedule re-derives the surcharge
  // from the same document. Research writes it CONDITIONAL — "when the job
  // includes a service" — which is exactly the question the battery rule answers.
  // =========================================================================
  const TIGARD_URL = "https://www.tigard-or.gov/electrical-fees.pdf";
  const TIGARD_CORPUS = [
    "Renewable energy 5 kva or less | $100.70",
    "Renewable energy 5.01 to 15 kva | $133.56",
    "Services or feeders: 200 amps or less | $100.70",
    "Note: A 12% surcharge fee as mandated by the State Building Codes Division is applied to all permit fees, investigation fees and inspection fees listed.",
  ].join("\n");
  const ledgerFor = (url: string, corpus: string): Ledger => {
    const l = newFeeDocumentLedger();
    l.evidence.push({ url, via: "http", status: 200, kind: "pdf", bytes: corpus.length, handed: 4 });
    l.corpus.push(corpus);
    return l;
  };
  const finding = (over: Partial<Finding>): Finding => ({
    found: true, reason: "", basis: "system_kw", brackets: [], notes: "",
    sourceUrl: TIGARD_URL, sourceQuote: "Renewable energy 5.01 to 15 kva | $133.56",
    sourceKind: "official", paymentMethod: "portal", ...over,
  });

  const tigardElectrical = finding({
    brackets: [
      { maxKw: 5, feeUsd: 100.70, label: "Renewable energy 5 kva or less" },
      { minKw: 5.01, maxKw: 15, feeUsd: 133.56, label: "Renewable energy 5.01 to 15 kva" },
    ],
  });
  const tigardLedger = ledgerFor(TIGARD_URL, TIGARD_CORPUS);
  const held = corroborateAncillaryCharges([{
    label: "Services or feeders: 200 amps or less", kind: "other", amountUsd: 100.70, percentOf: "",
    conditional: true, condition: "charged when the job installs, alters or relocates a service or feeder",
    appliesTo: "electrical", quote: "Services or feeders: 200 amps or less | $100.70",
  }], tigardElectrical, tigardLedger);
  check("fixture: the services charge survives corroboration (real write path)", held.held.length === 1, JSON.stringify(held.dropped));
  attachAncillaryCharges(tigardElectrical.brackets, held.held);
  saveFeeSchedule(db, { state: "OR", ahj: "City of Tigard", track: "permit", discipline: "electrical" }, tigardElectrical, { corroborateAgainst: tigardLedger });
  const STRUCT_URL = "https://www.tigard-or.gov/building-fees.pdf";
  saveFeeSchedule(db, { state: "OR", ahj: "City of Tigard", track: "permit", discipline: "structural" }, finding({
    basis: "flat", brackets: [{ feeUsd: 180, label: "Residential solar permit" }],
    sourceUrl: STRUCT_URL, sourceQuote: "Residential solar permit | $180.00",
  }), { corroborateAgainst: ledgerFor(STRUCT_URL, "Residential solar permit | $180.00") });

  const tigardBattery = withSnapshot(BATTERY);
  const tigardPv = withSnapshot(NO_BATTERY);

  // ---- 4. priced ----------------------------------------------------------
  const elecBattery = feeForProject(db, tigardBattery, "electrical")!;
  const svc = elecBattery.charges.find((c) => c.kind === SERVICE_FEEDER_CHARGE_KIND);
  const svcSur = elecBattery.charges.find((c) => c.kind === SERVICE_FEEDER_STATE_SURCHARGE_KIND);
  check("battery + electrical filing: the services line is its own charge, priced from the schedule",
    svc?.amountUsd === 100.7 && svc.partOfLineFee === false, JSON.stringify(svc));
  check("  with its own quote and source", !!svc?.quote && /200 amps or less/i.test(svc.quote) && svc.sourceUrl === TIGARD_URL, JSON.stringify(svc));
  check("  and the schedule's 12% surcharge on it", svcSur?.amountUsd === 12.08, JSON.stringify(svcSur));
  check("  listed ONCE — the stored conditional charge is not also held open as a question",
    elecBattery.charges.filter((c) => /200 amps or less/i.test(c.label)).length === 1,
    JSON.stringify(elecBattery.charges.map((c) => c.label)));
  check("  the electrical total includes it: 133.56 + 16.03 + 100.70 + 12.08 = 262.37",
    elecBattery.feeUsd === 262.37, String(elecBattery.feeUsd));
  check("  and the kVA PERMIT LINE's own amount is untouched (what the kVA box asks for)",
    elecBattery.lines[0].feeUsd === 149.59 && elecBattery.lines[0].baseFeeUsd === 133.56);

  const sheetBattery = buildProjectFeeSheet(db, tigardBattery);
  const permitLine = sheetBattery.lines.find((l) => l.track === "permit")!;
  check("fee sheet: battery job's permit total = structural 180 + electrical 262.37",
    permitLine.feeUsd === 442.37 && permitLine.source === "published_schedule", `${permitLine.feeUsd} ${permitLine.source}`);
  check("fee sheet: the services line is itemised with its amount",
    (permitLine.charges ?? []).some((c) => c.kind === SERVICE_FEEDER_CHARGE_KIND && c.amountUsd === 100.7));

  // ---- MUST EXCLUDE: building / NEM / no battery ---------------------------
  const bldgBattery = feeForProject(db, tigardBattery, "building")!;
  check("MUST EXCLUDE: battery on the BUILDING filing — no services line",
    !bldgBattery.charges.some((c) => c.kind.startsWith(SERVICE_FEEDER_CHARGE_KIND)) && bldgBattery.feeUsd === 180,
    JSON.stringify(bldgBattery.charges.map((c) => c.kind)));
  const allBattery = feeForProject(db, tigardBattery, "permit")!;
  check("MUST EXCLUDE: on the whole-project quote it rides the ELECTRICAL line only",
    allBattery.lines.find((l) => l.discipline === "structural")!.charges.every((c) => !c.kind.startsWith(SERVICE_FEEDER_CHARGE_KIND))
      && allBattery.lines.find((l) => l.discipline === "electrical")!.charges.some((c) => c.kind === SERVICE_FEEDER_CHARGE_KIND));
  saveFeeSchedule(db, { state: "OR", utility: "Portland General Electric", track: "nem" }, finding({
    basis: "flat", brackets: [{ feeUsd: 0, label: "No application fee for Level 1" }],
    sourceUrl: "https://portlandgeneral.com/nem.pdf", sourceQuote: "No application fee for Level 1",
  }));
  const nemBattery = feeForProject(db, tigardBattery, "nem");
  check("MUST EXCLUDE: battery on the NEM application — no services line",
    !!nemBattery && !nemBattery.charges.some((c) => c.kind.startsWith(SERVICE_FEEDER_CHARGE_KIND)), JSON.stringify(nemBattery?.charges));
  const elecPv = feeForProject(db, tigardPv, "electrical")!;
  check("MUST EXCLUDE: no battery — no battery services line",
    !elecPv.charges.some((c) => c.kind.startsWith(SERVICE_FEEDER_CHARGE_KIND)), JSON.stringify(elecPv.charges.map((c) => c.kind)));
  const elecUnknown = feeForProject(db, withSnapshot({}), "electrical")!;
  check("MUST EXCLUDE: unknown battery status adds no line (it claims nothing)",
    !elecUnknown.charges.some((c) => c.kind.startsWith(SERVICE_FEEDER_CHARGE_KIND)));

  // ---- 6. the gap ----------------------------------------------------------
  const GAP_URL = "https://gapville.example.gov/electrical-fees.pdf";
  saveFeeSchedule(db, { state: "OR", ahj: "City of Gapville", track: "permit", discipline: "electrical" }, finding({
    brackets: [{ minKw: 0, maxKw: 15, feeUsd: 150, label: "Solar 15 kva or less" }],
    sourceUrl: GAP_URL, sourceQuote: "Solar 15 kva or less | $150.00",
  }), { corroborateAgainst: ledgerFor(GAP_URL, "Solar 15 kva or less | $150.00") });
  const gapBattery = withSnapshot(BATTERY, { ahj: "City of Gapville", city: "Gapville" });
  const gapElec = feeForProject(db, gapBattery, "electrical")!;
  const gapCharge = gapElec.charges.find((c) => c.kind === SERVICE_FEEDER_CHARGE_KIND);
  check("GAP: a schedule without the line carries it UNPRICED — never $0, never omitted",
    !!gapCharge && gapCharge.amountUsd === null, JSON.stringify(gapCharge));
  check("GAP: the reason says what is missing and why",
    /SERVICES\/FEEDERS <=200A AMOUNT MISSING/.test(gapCharge?.reason ?? "") && /does not\s+record that line's amount/.test(gapCharge?.reason ?? "")
      && (gapCharge?.reason.length ?? 999) <= 400 && !(gapCharge?.reason ?? "").includes(" | "),
    gapCharge?.reason);
  check("GAP: the electrical total is UNRESOLVED rather than the $150 kVA line alone",
    gapElec.feeUsd === null && gapElec.lines[0].feeUsd === 150, String(gapElec.feeUsd));
  const gapSheet = buildProjectFeeSheet(db, gapBattery);
  const gapPermit = gapSheet.lines.find((l) => l.track === "permit")!;
  check("GAP: the fee sheet names the missing line in its unknowns",
    gapSheet.unknowns.some((u) => /Services or feeders: 200 amps or less/.test(u) && /AMOUNT MISSING/.test(u)), JSON.stringify(gapSheet.unknowns));
  check("GAP: the fee sheet does not claim the permit fee is known, and nothing prices the line at $0",
    gapPermit.known === false && (gapPermit.charges ?? []).every((c) => c.kind !== SERVICE_FEEDER_CHARGE_KIND || c.amountUsd === null),
    JSON.stringify({ known: gapPermit.known, fee: gapPermit.feeUsd, source: gapPermit.source }));
  // SKEPTIC SHOULD-FIX F: the permit line's estimate sentence must not deny the
  // schedule the same sheet just itemised.
  const gapPermitUnknown = gapSheet.unknowns.find((u) => /^Permit fee for City of Gapville/.test(u)) ?? "";
  check("F MUST PASS: schedule evaluated, only an unpriced charge nulled the total — the sentence says so",
    gapPermit.source === "valuation_estimate" && /published fee schedule WAS read/.test(gapPermitUnknown)
      && /one charge on it is\s+not priced/.test(gapPermitUnknown) && !/no published fee schedule resolved/.test(gapPermitUnknown),
    gapPermitUnknown);
  check("GAP: the charge's own unknown carries it — no second, generic battery note on top",
    !gapSheet.unknowns.some((u) => /^Battery\/ESS job: /.test(u)), JSON.stringify(gapSheet.unknowns));

  // No schedule that EVALUATES: nothing on file at all, or a basis a person has to
  // read. The evaluator carries no line there, so the fee sheet says it itself.
  const nowhereBattery = withSnapshot(BATTERY, { ahj: "City of Nowhere", city: "Nowhere" });
  const nowhereSheet = buildProjectFeeSheet(db, nowhereBattery);
  check("GAP (no schedule on file): the fee sheet still names the battery's services line",
    nowhereSheet.unknowns.some((u) => /^Battery\/ESS job: .*Services or feeders: 200 amps or less/.test(u)), JSON.stringify(nowhereSheet.unknowns));
  check("F MUST EXCLUDE: no schedule on file at all keeps 'no published fee schedule resolved'",
    nowhereSheet.unknowns.some((u) => /^Permit fee for City of Nowhere .*no published fee schedule resolved/.test(u))
      && !nowhereSheet.unknowns.some((u) => /schedule WAS read/.test(u)),
    JSON.stringify(nowhereSheet.unknowns));
  check("MUST EXCLUDE (no schedule on file): a PV-only job gets no such note",
    !buildProjectFeeSheet(db, withSnapshot(NO_BATTERY, { ahj: "City of Nowhere" })).unknowns.some((u) => /200 amps or less/.test(u)));
  // A DISPUTED schedule refuses before any bracket is read, so the evaluator itemises
  // nothing — the shape of every "a person has to read this" refusal.
  saveFeeSchedule(db, { state: "OR", ahj: "City of Readme", track: "permit", discipline: "electrical" }, finding({
    status: "conflicted",
    brackets: [
      { minKw: 0, maxKw: 15, feeUsd: 95, label: "Solar 15 kva or less" },
      { minKw: 0, maxKw: 15, feeUsd: 120, label: "Solar 15 kva or less" },
    ],
    sourceUrl: "https://readme.example.gov/fees.pdf", sourceQuote: "Solar 15 kva or less | $95.00",
  } as Partial<Finding>));
  const readmeSheet = buildProjectFeeSheet(db, withSnapshot(BATTERY, { ahj: "City of Readme" }));
  check("GAP (schedule that refuses to evaluate): the battery's services line is still named",
    readmeSheet.unknowns.some((u) => /^Battery\/ESS job: .*Services or feeders: 200 amps or less/.test(u)), JSON.stringify(readmeSheet.unknowns));

  // SKEPTIC SHOULD-FIX D: an operator-entered ACTUAL is the portal's own total and
  // already contains the services line. The sheet must not then say "the total
  // stays UNRESOLVED" beside a known total — the no-schedule note already stops at
  // an actual; the charge's own unknown must agree. Each project here has its OWN
  // id, because the actual is stored per project and would leak into the shared one.
  const ownProject = (ahj: string, snapshot: Record<string, unknown>): ProjectRecord => {
    const c = createProject(db, {
      state: "OR", ahj, utility: "Portland General Electric",
      homeownerName: "Test Owner", projectAddress: "1 Test St", city: ahj.replace(/^City of /, ""), zip: "97223", dcKw: 10,
    } as never);
    return { ...(getProjectDetail(db, c.project.id).project as ProjectRecord), systemSizeAcKw: 9, systemSizeDcKw: 10, parserSnapshot: snapshot as never };
  };
  const SVC_GAP_RE = /Services or feeders: 200 amps or less.*(not priced|UNRESOLVED|AMOUNT MISSING)/;
  const gapActual = ownProject("City of Gapville", BATTERY);
  recordActualPermitFee(db, gapActual, "permit", 180, "operator");
  const gapActualSheet = buildProjectFeeSheet(db, gapActual);
  const gapActualPermit = gapActualSheet.lines.find((l) => l.track === "permit")!;
  check("D MUST PASS: a battery job with an operator ACTUAL shows no 'not priced / UNRESOLVED' services unknown",
    gapActualPermit.source === "actual" && gapActualPermit.known === true && !gapActualSheet.unknowns.some((u) => SVC_GAP_RE.test(u)),
    JSON.stringify({ source: gapActualPermit.source, unknowns: gapActualSheet.unknowns }));
  check("D MUST EXCLUDE: the same job with NO actual keeps it",
    buildProjectFeeSheet(db, ownProject("City of Gapville", BATTERY)).unknowns.some((u) => SVC_GAP_RE.test(u)));
  // A conditional review charge (Portland's fire review shape) is a different
  // question — did this filing incur it? — and an actual does not answer it here.
  const FIRE_URL = "https://firetown.example.gov/electrical-fees.pdf";
  const FIRE_CORPUS = ["Solar 15 kva or less | $150.00", "Fire plan review | $75.00"].join("\n");
  const fireFinding = finding({
    brackets: [{ minKw: 0, maxKw: 15, feeUsd: 150, label: "Solar 15 kva or less" }],
    sourceUrl: FIRE_URL, sourceQuote: "Solar 15 kva or less | $150.00",
  });
  const fireLedger = ledgerFor(FIRE_URL, FIRE_CORPUS);
  const fireHeld = corroborateAncillaryCharges([{
    label: "Fire plan review", kind: "other", amountUsd: 75, percentOf: "",
    conditional: true, condition: "charged when the fire marshal reviews the plans",
    appliesTo: "electrical", quote: "Fire plan review | $75.00",
  }], fireFinding, fireLedger);
  check("fixture: the fire review charge survives corroboration", fireHeld.held.length === 1, JSON.stringify(fireHeld.dropped));
  attachAncillaryCharges(fireFinding.brackets, fireHeld.held);
  saveFeeSchedule(db, { state: "OR", ahj: "City of Firetown", track: "permit", discipline: "electrical" }, fireFinding, { corroborateAgainst: fireLedger });
  const fireActual = ownProject("City of Firetown", BATTERY);
  recordActualPermitFee(db, fireActual, "permit", 260, "operator");
  const fireSheet = buildProjectFeeSheet(db, fireActual);
  check("D MUST EXCLUDE: a conditional fire-review charge with an actual KEEPS its unknown",
    fireSheet.unknowns.some((u) => /Fire plan review/.test(u) && /not priced/.test(u)),
    JSON.stringify(fireSheet.unknowns));
  check("D: ... while that same sheet's battery services line is not held open under the actual",
    !fireSheet.unknowns.some((u) => SVC_GAP_RE.test(u)), JSON.stringify(fireSheet.unknowns));

  check("GAP: the same schedule for a PV-only job still quotes $150 exactly as before",
    feeForProject(db, withSnapshot(NO_BATTERY, { ahj: "City of Gapville" }), "electrical")!.feeUsd === 150);

  // Undifferentiated row: the whole project's permit, which includes the electrical filing.
  saveFeeSchedule(db, { state: "OR", ahj: "City of Onetown", track: "permit" }, finding({
    brackets: [{ minKw: 0, maxKw: 25, feeUsd: 210, label: "Solar 25 kva or less" }],
    sourceUrl: "https://onetown.example.gov/fees.pdf", sourceQuote: "Solar 25 kva or less | $210.00",
  }));
  const oneBattery = withSnapshot(BATTERY, { ahj: "City of Onetown", city: "Onetown" });
  check("undifferentiated row, whole-project ask: the battery line is carried",
    feeForProject(db, oneBattery, "permit")!.charges.some((c) => c.kind === SERVICE_FEEDER_CHARGE_KIND));
  check("undifferentiated row, BUILDING ask: no battery line",
    !feeForProject(db, oneBattery, "building")!.charges.some((c) => c.kind === SERVICE_FEEDER_CHARGE_KIND));

  // ---- 5. PDF --------------------------------------------------------------
  const ctxFor = (project: ProjectRecord, snapshot: Record<string, unknown>) => ({
    project, client: {}, snapshot, publishedFeeLines: feeForProject(db, project, "permit")?.lines,
  });
  const cBattery = ctxFor(tigardBattery, BATTERY);
  const cPv = ctxFor(tigardPv, NO_BATTERY);
  const cGap = ctxFor(gapBattery, BATTERY);
  check("PDF computed: battery qty 1 / total 100.70; PV-only qty blank",
    resolveSource("computed.servicesFeeders200Qty", cBattery as never) === "1"
      && resolveSource("computed.servicesFeeders200Total", cBattery as never) === "100.70"
      && resolveSource("computed.servicesFeeders200Qty", cPv as never) === "");
  check("PDF computed: whole-application figures include the services line",
    resolveSource("computed.electricalSubtotal", cBattery as never) === "234.26"
      && resolveSource("computed.electricalStateSurcharge", cBattery as never) === "28.11"
      && resolveSource("computed.electricalTotalFee", cBattery as never) === "262.37",
    ["electricalSubtotal", "electricalStateSurcharge", "electricalTotalFee"].map((n) => resolveSource(`computed.${n}`, cBattery as never)).join(" "));
  check("PDF computed: the kVA row's own base is unchanged on a battery job",
    resolveSource("computed.electricalBaseFee", cBattery as never) === "133.56");
  check("PDF computed: PV-only job's totals exactly as before",
    resolveSource("computed.electricalSubtotal", cPv as never) === "133.56" && resolveSource("computed.electricalTotalFee", cPv as never) === "149.59");
  check("PDF computed GAP: qty 1, and every whole-application figure BLANK (never a renewable-only total)",
    resolveSource("computed.servicesFeeders200Qty", cGap as never) === "1"
      && ["servicesFeeders200Total", "electricalSubtotal", "electricalStateSurcharge", "electricalTotalFee", "coosElectricalTotal"]
        .every((n) => resolveSource(`computed.${n}`, cGap as never) === ""));

  // Real fills of the two curated electrical applications.
  const tigardBytes = fs.readFileSync(path.join(REPO, "backend/test/fixtures/tigard-electrical.pdf"));
  const tigardMap = curatedFormMap(tigardBytes, TIGARD_URL)!.map;
  const fillTigard = async (ctx: unknown, name: string) => {
    const out = path.join(process.cwd(), `${name}.pdf`);
    const result = await fillLoadedForm({ ...tigardMap, id: name, notes: [], status: "verified", matchJurisdictions: ["tigard"], version: "test" } as never, tigardBytes, ctx as never, out);
    return { result, labels: await extractLabels(fs.readFileSync(out)) };
  };
  const at = (labels: Array<{ page: number; str: string; x: number; y: number }>, str: string, page: number, x: number, y: number) =>
    labels.some((l) => l.page === page && l.str === str && Math.abs(l.x - x) < 8 && Math.abs(l.y - y) < 4);
  const tb = await fillTigard(cBattery, "tigard-battery");
  check("Tigard PDF (battery): qty 1 in the services <=200A row, page 1",
    at(tb.labels, "1", 0, 485, 434), JSON.stringify(tb.labels.filter((l) => l.page === 0 && Math.abs(l.y - 434) < 6)));
  check("Tigard PDF (battery): 100.70 in that row's Total column", at(tb.labels, "100.70", 0, 542, 434));
  check("Tigard PDF (battery): page-1 subtotal and total include the services line",
    at(tb.labels, "234.26", 0, 537, 95) && at(tb.labels, "262.37", 0, 537, 60));
  check("Tigard PDF (battery): page-2 renewable subtotal stays the kVA line alone",
    at(tb.labels, "133.56", 1, 541, 456));
  const tp = await fillTigard(cPv, "tigard-pv");
  // The blank itself prints "100.70" (Each column, x=513) and "2" (x=581) on this row,
  // so the check is on the two cells this map writes, not on the whole row.
  check("Tigard PDF (PV-only): nothing written in the services row's Qty or Total cells",
    !tp.labels.some((l) => l.page === 0 && Math.abs(l.y - 434) < 4 && (Math.abs(l.x - 485) < 8 || Math.abs(l.x - 542) < 8)),
    JSON.stringify(tp.labels.filter((l) => l.page === 0 && Math.abs(l.y - 434) < 4)));
  check("Tigard PDF (PV-only): page-1 subtotal and total exactly as before",
    at(tp.labels, "133.56", 0, 537, 95) && at(tp.labels, "149.59", 0, 537, 60));
  const tg = await fillTigard(cGap, "tigard-gap");
  check("Tigard PDF (GAP): qty 1, no grand total, and the missing total is REPORTED",
    at(tg.labels, "1", 0, 485, 434) && !tg.labels.some((l) => l.page === 0 && Math.abs(l.x - 537) < 8 && Math.abs(l.y - 60) < 4)
      && (tg.result.unmappedRequested ?? []).includes("electrical fee including required surcharges"),
    JSON.stringify(tg.result.unmappedRequested));

  const coosBytes = fs.readFileSync(path.join(REPO, "backend/test/fixtures/coos-electrical.pdf"));
  const coosMap = curatedFormMap(coosBytes, "https://co.coos.or.us/files/5bb0a81e5/electrical_permit.pdf")!.map;
  check("Coos map: the <=200A row's AcroForm fields are mapped (and not the temp/MD rows)",
    coosMap.textFields["200 AMPS QTY"] === "computed.servicesFeeders200Qty"
      && coosMap.textFields["200 AMPS TOTAL"] === "computed.servicesFeeders200Total"
      && !Object.keys(coosMap.textFields).some((k) => /temp|MD SERVICE|400 AMP/i.test(k)));
  const fillCoos = async (ctx: unknown, name: string) => {
    const out = path.join(process.cwd(), `${name}.pdf`);
    await fillLoadedForm({ ...coosMap, id: name, notes: [], status: "verified", matchJurisdictions: ["coos bay"], version: "test" } as never, coosBytes, ctx as never, out);
    const form = (await PDFDocument.load(fs.readFileSync(out))).getForm();
    return (field: string) => form.getTextField(field).getText() ?? "";
  };
  const coosProject = { ...tigardBattery, ahj: "City of Coos Bay" };
  const cb = await fillCoos({ ...cBattery, project: coosProject }, "coos-battery");
  check("Coos PDF (battery): 200 AMPS QTY = 1, TOTAL = 100.70, subtotal includes it",
    cb("200 AMPS QTY") === "1" && cb("200 AMPS TOTAL") === "100.70" && cb("Subtotal add ALL fees  minimum fee") === "234.26",
    `${cb("200 AMPS QTY")} ${cb("200 AMPS TOTAL")} ${cb("Subtotal add ALL fees  minimum fee")}`);
  check("Coos PDF (battery): MUST EXCLUDE — temp 200 amps and the 201-400 row stay empty",
    cb("temp 200 amps qty") === "" && cb("400 AMP QTY") === "");
  const cp = await fillCoos({ ...cPv, project: { ...tigardPv, ahj: "City of Coos Bay" } }, "coos-pv");
  check("Coos PDF (PV-only): 200 AMPS QTY empty", cp("200 AMPS QTY") === "" && cp("200 AMPS TOTAL") === "");

  db.close();
  console.log(failures === 0
    ? "\nbatteryServiceFeeder: all checks passed."
    : `\nbatteryServiceFeeder: ${failures} check(s) FAILED.`);
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
