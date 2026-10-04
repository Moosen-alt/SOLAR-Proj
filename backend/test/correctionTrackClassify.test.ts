// A CORRECTION POINTING AT THE WRONG PORTAL IS WORSE THAN AN UNCLASSIFIED ONE.
//
// Live defect this file exists for: Drew Example's only open correction (cb3cf605 on
// project 720b05f3) is a scrape of the Accela PERMIT record 187-26-000305-STR whose one
// item is a parcel-level "Sewer Recovery" notice. The old discriminator,
//   /nem|net.?meter|interconnection|pto|utility|meter|account|powerclerk|inverter|1741/i
// pasted at three sites, classified it as a NEM correction — on the words "load-side
// breaker INTERCONNECTION", "within 10 ft of the UTILITY METER" and "microINVERTERs",
// every one of which is the plan set describing the system, not a utility filing.
//
// Measured on a copy of the live database: Ivy tracks THREE active filings — two Accela
// permits (194-26-001471-ELEC, 187-26-000305-STR) and one PowerClerk NEM application
// (APP-111651). The old classifier scoped the reopen to the single NEM target, so the
// reopen bound the permit notice to the utility portal and would have driven a browser
// at pacificorpnetmetering.powerclerk.com — the exact shape hard rule 5 forbids.
//
// THE FIXTURE IS THE LIVE TEXT. Homeowner name, owner-of-record and street addresses are
// replaced with placeholders (this file is committed; that row is real customer data), and
// every technical token that drove the misclassification is kept verbatim. The first
// assertion proves the fixture is still the hard case by checking those ambient words are
// present — a fixture that quietly lost them would pass without the fix.
//
// Run: tsx backend/test/correctionTrackClassify.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "correction-track-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";
process.env.MONITOR_INTERVAL_MINUTES = "0";

const { openDatabase } = await import("../src/db");
const {
  classifyCorrectionTrack, correctionOnTrack, createProject, addManualCorrection,
  reopenCorrectionOnPortal, getProjectDetail,
} = await import("../src/repository");
const { ensureCheckTarget } = await import("../src/submittalTracks");

let failures = 0;
const check = (name: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ok   - ${name}`); })
    .catch((err: Error) => { failures++; console.error(`  FAIL - ${name}\n         ${err.message}`); });

// ---------------------------------------------------------------------------
// The live row, personal identifiers replaced. Everything else is verbatim.
// ---------------------------------------------------------------------------
const IVY_PERMIT_SCRAPE =
  "Record 187-26-000305-STR: Residential Structural Record Status: App Submitted Expiration Date: 02/28/2027 "
  + "Create a New Collection *Name: Description: spell check Add Cancel A notice was added to this record on "
  + "08/31/2026.Condition: Sewer RecoverySeverity: NoticeTotal Conditions: 1 (Notice: 1)View Condition Conditions "
  + "Showing 1-1 of 1 Parcel Notifications - 1 Applied Sewer Recovery Sewer Recoveryloaded by scriptApplied | Notice "
  + "| 08/31/2026 Work Location [SITE ADDRESS] COOS BAY OR 97420 * Record Details Applicant: [APPLICANT] "
  + "Licensed Professional:TML INTERNATIONAL LLC 223690 CCB 223690 View Additional Licensed Professionals "
  + "Project Description:[HOMEOWNER] Install 3.52 kW DC / 3.072 kW AC roof-mounted photovoltaic system: (8) ZNShine "
  + "Solar ZXM7-UHLD108-440/N 440W modules with (4) AP Systems DS3-L microinverters, composite shingle roof, "
  + "load-side breaker interconnection with lockable AC disconnect within 10 ft of the utility meter. "
  + "Owner:[OWNER OF RECORD] More Details Related Contacts Site Contact information [HOMEOWNER] Additional "
  + "Information Job Value($):$21,383.55Number of Buildings:1Construction Type:1 Application Information GENERAL "
  + "Replacement Dwelling: No STRUCTURAL Category of Construction: Other Other Category of Construction: Solar "
  + "Type of Work: New Building Height - Feet: 15 Number of Stories: 1 # of Dwelling Units: 1 Record Link: "
  + "https://aca-oregon.accela.com/oregon/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=26CAP&capID2=00000&capID3=000GY&agencyCode=COOS_BAY "
  + "ROOFING New Roof: No Re-Roof: No POST DISASTER Post Disaster Permit: No Additional Comments: Roof-mounted "
  + "residential solar PV system: 3.52 kW DC / 3.072 kW AC, (8) ZNShine 440W modules with (4) AP Systems DS3-L "
  + "microinverters on existing composite shingle roof. Parcel Information Parcel Number:25S13W20CCTL0250300 "
  + "Print/View Summary Fees Loading... Inspections Click here to view a list of the Oregon Standard Model "
  + "Inspection Codes. Documents Upload/View Valuation Calculator Occupancy Type Quantity Unit Unit Cost Job Value "
  + "No records found. Right Of Way Management No ROWM data available at this time.";

const IVY_ROOT_CAUSE =
  "The captured \"correction\" is a scrape of the Accela record detail page for 187-26-000305-STR, not a "
  + "plan-review comment. The only item on the record is a parcel-level condition, \"Sewer Recovery,\" severity "
  + "Notice, auto-applied by script on 08/31/2026 to the parcel (25S13W20CCTL0250300).";

const IVY_REQUIRED_ACTION =
  "No design or package change. Confirm with Coos Bay that the Sewer Recovery notice is a parcel notice requiring "
  + "no response on a solar structural permit. Continue monitoring the record for actual plan-review comments.";

// A genuine NEM correction, in the live shape of the other correction on this database
// (Finley Mockdata bb73adc4, a PacifiCorp interconnection message).
const REAL_NEM_CORRECTION =
  "PacifiCorp / Pacific Power — APP-111681 (received 2026-09-03, 10 business day review). Your net metering "
  + "interconnection application is incomplete: upload the signed customer generation agreement and the meter photo "
  + "in PowerClerk before the review clock restarts.";

// The honest middle: a real correction whose words name neither filing.
const AMBIGUOUS_CORRECTION =
  "Please provide the signed authorization page and a legible copy of the site plan. Resubmit the complete package "
  + "when both are attached.";

// The OLD regex, kept here as the counterfactual the fixture must trip.
const OLD_DISCRIMINATOR = /nem|net.?meter|interconnection|pto|utility|meter|account|powerclerk|inverter|1741/i;

// ═══════════════════════════════════════════════════════════════════════════════
// 1. THE CLASSIFIER
// ═══════════════════════════════════════════════════════════════════════════════

await check("the fixture is still the hard case — the ambient words that misled the old regex are present", () => {
  for (const word of ["interconnection", "utility meter", "microinverters"]) {
    assert.ok(IVY_PERMIT_SCRAPE.toLowerCase().includes(word),
      `the live scrape no longer contains "${word}" — the fixture has drifted into a happy path and would pass without the fix`);
  }
  assert.ok(OLD_DISCRIMINATOR.test(IVY_PERMIT_SCRAPE),
    "the old discriminator no longer matches the fixture, so this file would prove nothing about the defect");
});

await check("a permit-record scrape is classified PERMIT, not NEM", () => {
  assert.equal(classifyCorrectionTrack(IVY_PERMIT_SCRAPE, IVY_ROOT_CAUSE, IVY_REQUIRED_ACTION), "permit");
});

await check("a real utility filing is still classified NEM", () => {
  assert.equal(classifyCorrectionTrack(REAL_NEM_CORRECTION, "", ""), "nem");
});

await check("a correction whose words name neither filing is UNCLASSIFIED, not guessed", () => {
  assert.equal(classifyCorrectionTrack(AMBIGUOUS_CORRECTION, "", ""), "unclassified");
  assert.equal(classifyCorrectionTrack("", "", ""), "unclassified");
});

await check("ambient solar vocabulary alone decides nothing", () => {
  // Every one of these appears on every plan set. None of them is a filing.
  for (const ambient of [
    "The inverter is a UL 1741 SB listed microinverter.",
    "Lockable AC disconnect within 10 ft of the utility meter.",
    "Load-side breaker interconnection on the existing service.",
    "Account and meter numbers are on the attached bill.",
  ]) {
    assert.equal(classifyCorrectionTrack(ambient, "", ""), "unclassified",
      `"${ambient}" decided a track on its own`);
    assert.ok(OLD_DISCRIMINATOR.test(ambient), `"${ambient}" did not trip the old regex — wrong counterexample`);
  }
});

await check("a text naming BOTH a permit record and a utility filing is unclassified", () => {
  assert.equal(
    classifyCorrectionTrack("Record 187-26-000305-STR plan review comment: the PowerClerk interconnection application must be approved first.", "", ""),
    "unclassified");
});

await check("AN UNKNOWN IS NOT AN ALL-CLEAR — an unclassified correction shows on BOTH lanes", () => {
  assert.equal(correctionOnTrack("nem", AMBIGUOUS_CORRECTION, "", ""), true);
  assert.equal(correctionOnTrack("permit", AMBIGUOUS_CORRECTION, "", ""), true);
  // …while a classified one shows on exactly its own lane.
  assert.equal(correctionOnTrack("nem", IVY_PERMIT_SCRAPE, IVY_ROOT_CAUSE, IVY_REQUIRED_ACTION), false);
  assert.equal(correctionOnTrack("permit", IVY_PERMIT_SCRAPE, IVY_ROOT_CAUSE, IVY_REQUIRED_ACTION), true);
  assert.equal(correctionOnTrack("nem", REAL_NEM_CORRECTION, "", ""), true);
  assert.equal(correctionOnTrack("permit", REAL_NEM_CORRECTION, "", ""), false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. THE REOPEN BIND — built from Ivy's real target shape (2 permits + 1 NEM)
// ═══════════════════════════════════════════════════════════════════════════════

const db = await openDatabase();
const { project } = createProject(db, {
  owner: "Track Test Owner", street: "1 Track Way", city: "Coos Bay", state: "OR", zip: "97420",
  ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "3.52", acKw: "3.072",
});
const record = getProjectDetail(db, project.id).project;

// The real write path, not raw SQL — a fixture that INSERTs its own rows proves the
// column exists, not that anything can write it.
ensureCheckTarget(db, record, {
  targetType: "permit", permitType: "electrical", applicationNumber: "194-26-001471-ELEC",
  portalName: "Oregon ePermitting (Accela)", portalUrl: "https://aca-oregon.accela.com/oregon/",
});
ensureCheckTarget(db, record, {
  targetType: "permit", permitType: "building", applicationNumber: "187-26-000305-STR",
  portalName: "Oregon ePermitting (Accela)", portalUrl: "https://aca-oregon.accela.com/oregon/",
});
ensureCheckTarget(db, record, {
  targetType: "nem", permitType: "nem", applicationNumber: "APP-111651",
  portalName: "Pacific Power NEM portal (PowerClerk)",
  portalUrl: "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login",
});

const correctionIdFor = (text: string): string => {
  const detail = addManualCorrection(db, project.id, text, "portal");
  return detail.corrections[0].id;
};

// A stub runner: the reopen must never open a browser in a unit test, and what we care
// about is WHICH filing it bound, which arrives as the runner's input.
// Signature: runCorrectionReopen(recipe, applicationNumber, docsByType, opts).
const capture = { url: "", app: "" };
const runner = (async (recipe: { portalUrl?: string }, applicationNumber: string) => {
  capture.url = String(recipe?.portalUrl ?? "");
  capture.app = String(applicationNumber ?? "");
  return { ok: false, needsHuman: true, message: "stub runner", offeredForms: [] };
}) as never;

await check("the permit scrape binds to the permit record it quotes — never to the NEM portal", async () => {
  capture.url = ""; capture.app = "";
  const id = correctionIdFor(IVY_PERMIT_SCRAPE);
  await reopenCorrectionOnPortal(db, id, { runner });
  assert.ok(!/powerclerk/i.test(capture.url),
    `the reopen opened a UTILITY portal for a permit-record correction: ${capture.url}`);
  assert.match(capture.url, /accela/i, `expected the Accela permit portal, got: ${capture.url}`);
  assert.equal(capture.app, "187-26-000305-STR",
    `expected the quoted permit record, got ${JSON.stringify(capture.app)}`);
});

await check("a correction that names no filing asks a human, listing every candidate", async () => {
  capture.url = ""; capture.app = "";
  const id = correctionIdFor(AMBIGUOUS_CORRECTION);
  const res = await reopenCorrectionOnPortal(db, id, { runner });
  assert.equal(res.needsHuman, true, `expected needsHuman, got ${JSON.stringify(res)}`);
  assert.equal(capture.url, "", "a browser run was started for a correction whose track is unknown");
  assert.equal(res.candidates?.length, 3, `expected all three filings offered, got ${JSON.stringify(res.candidates)}`);
  assert.match(res.message, /does not say which filing/i, res.message);
});

await check("a genuine NEM correction still binds to the NEM filing", async () => {
  capture.url = ""; capture.app = "";
  const id = correctionIdFor("Your net metering interconnection application is incomplete — upload the signed customer generation agreement in PowerClerk.");
  await reopenCorrectionOnPortal(db, id, { runner });
  assert.match(capture.url, /powerclerk/i, `expected the NEM portal, got: ${capture.url}`);
  assert.equal(capture.app, "APP-111651");
});

// ═══════════════════════════════════════════════════════════════════════════════

if (failures) {
  console.error(`\ncorrectionTrackClassify: ${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log("\ncorrectionTrackClassify: all checks passed.");
