// THE CORRECTION IS WHAT THE PORTAL ASKED FOR, NOT THE PAGE IT WAS PRINTED ON.
//
// Operator, 2026-09-27, on a Coos Bay record (production project 1fb3dc39, "In Review/Addl Info Needed"):
// "it does have corrections so we pulled that right. However it's a bit cluttered". The correction
// row's text was the ENTIRE scraped Accela CapDetail page — record header, licensed professionals,
// the project description, "Documents Upload/View ... Silverlight", "Loading...", the valuation
// calculator — 3,712 characters around ONE Accela Condition. And the page chrome decided who owned
// it: "Residential Structural Record" matched the design keywords, so the row said `designer`
// while the correction agent's own root cause said "Not a design or plan-set deficiency".
//
//   1. EXTRACTION — the Conditions rows (name, severity, description, status | severity | date),
//      labelled review-comment blocks on other platforms, else the whole text, SAID SO.
//   2. THE WRITE PATH — recordPermitStatusCheck stores the extracted text as correction_text,
//      keeps the page as source_text (never discarded), and classifies the extraction.
//   3. ONE DECISION — the agent's refined bucket moves the assignee with it.
//   4. THE BACKFILL — existing rows re-extracted from their stored text; idempotent.
//
//   npx tsx backend/test/correctionPageExtract.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "correction-page-extract-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const { extractCorrectionFromPage } = await import("../src/correctionExtract");
const { recordConditionOf } = await import("../src/permitMonitor");
const { classifyCorrection, assigneeForBucket, humanizeBucket } = await import("../src/corrections");
const { persistTriage } = await import("../src/correctionAgent");
const { planCorrectionTextBackfill, applyCorrectionTextBackfill } = await import("../../scripts/backfill-correction-text");

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------------------------
// FIXTURES
// ---------------------------------------------------------------------------------------------
// THE COOS BAY PAGE — built from the stored row (corrections 33cfb1be, source "portal") on a
// .backup copy of production. Homeowner, applicant and licensee names, every street address, the
// parcel / tax lot, licence numbers, record numbers and the capID are REPLACED with fakes;
// everything else — the glued markup, the Silverlight blurb, the "Loading..." panels — is verbatim.
const COOS_BAY_PAGE =
  "Record 187-26-000901-STR: Residential Structural Record Status: In Review/Addl Info Needed Expiration Date: 03/16/2027 "
  + "Create a New Collection *Name: Description: spell check Add Cancel A notice was added to this record on 12/13/2019."
  + "Condition: PERMIT OUTSTANDINGSeverity: NoticeTotal Conditions: 1 (Notice: 1)View Condition Conditions Showing 1-1 of 1 "
  + "Parcel Notifications - 1 Applied Parcel Other PERMIT OUTSTANDINGOutstanding permit 187-M16-901 expired prior to final."
  + "Applied | Notice | 12/13/2019 Work Location [SITE ADDRESS] COOS BAY OR 97420 * Record Details Applicant: [APPLICANT] "
  + "[BUSINESS ADDRESS] Vancouver, WA, 98683 Licensed Professional:[CONTRACTOR] [BUSINESS ADDRESS] VANCOUVER, WA, 98683 "
  + "CCB 000000 View Additional Licensed Professionals>>1)[LICENSEE] [LICENSEE ADDRESS] (S) Electrician, General Supervising "
  + "0000S 2)[CONTRACTOR] [BUSINESS ADDRESS] VANCOUVER, WA, 98683 (C) Electrical Contractor C0000 Project Description:"
  + "[SITE ADDRESS] - [TAX LOT] - Install 8.36 kW DC 7.68 kW AC roof-mounted residential solar PV system [SITE ADDRESS] - "
  + "[TAX LOT] - Install 8.36 kW DC / 7.68 kW AC roof-mounted residential solar PV system: (19) ZNShine Solar "
  + "ZXM7-UHLD108-440/N 440W modules with (10) APsystems DS3-L microinverters on composite shingle roof, with AC disconnect "
  + "and associated electrical work. Owner:[OWNER OF RECORD] *[SITE ADDRESS]COOS BAY OR 97420 More Details Additional "
  + "Information Job Value($):$41,046.94Number of Buildings:1Construction Type:1 Application Information GENERAL "
  + "Replacement Dwelling: No STRUCTURAL Category of Construction: Other Other Category of Construction: Solar Type of "
  + "Work: New New Building Area: 0 Existing Building Area: 1675 Building Height - Feet: 15 Building Height - Inches: 0 "
  + "Number of Stories: 1 Number of Buildings: 1 # of Dwelling Units: 1 Record Link: "
  + "https://aca-oregon.accela.com/oregon/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=26CAP&capID2=00000&capID3=00000&agencyCode=COOS_BAY "
  + "ROOFING New Roof: No Re-Roof: No Stripping: No Overlaying: No POST DISASTER Post Disaster Permit: No Additional "
  + "Comments: Roof-mounted residential solar PV system, 8.36 kW DC / 7.68 kW AC Parcel Information Parcel Number:[PARCEL] "
  + "*Block:--Lot:[LOT]Subdivision:-- Print/View Summary Fees Loading... Inspections Click here to view a list of the "
  + "Oregon Standard Model Inspection Codes.Modelo Estándar de Oregon Códigos de inspección Loading... Upcoming Schedule "
  + "or Request an Inspection You have not added any inspections. Click the link above to schedule or request one. "
  + "Completed There are no completed inspections on this record. Documents Upload/View File names should not contain "
  + "any special characters. Numbers, letters, dashes, underscores and spaces are acceptable. File names may not exceed "
  + "120 characters including the file extension (i.e. .pdf, .docx, .jpeg etc.) The maximum file size allowed is 80 MB. "
  + "ade;adp;bat;chm;cmd;com;cpl;exe;hta;htm;html;ins;isp;jar;js;jse;lib;lnk;mde;mht;mhtml;msc;msp;mst;php;pif;scr;sct;"
  + "shb;sys;vb;vbe;vbs;vxd;wsc;wsf;wsh are disallowed file types to upload. View People Attachments View Record "
  + "Attachments * Save Add To upload files, you will need to install Silverlight. Click the image below to start "
  + "Silverlight download. Remove All Custom Component Processing Status Loading... Loading... Related Records View "
  + "Entire Tree » Loading... Valuation Calculator Valuation calculator list Occupancy Type Quantity Unit Unit Cost Job "
  + "Value No records found. Right Of Way Management No ROWM data available at this time. Type Owner Contact Email "
  + "Address Start Date End Date Status ROWM Website";
const COOS_BAY_CONDITION =
  "PERMIT OUTSTANDING - Severity: Notice - Outstanding permit 187-M16-901 expired prior to final. Applied | Notice | 12/13/2019";

// Ivy's page (correctionTrackClassify.test.ts, production 720b05f3, identifiers replaced) — the
// second real Accela shape: a mixed-case name printed twice, a description glued to it.
const IVY_CONDITIONS =
  "Record 187-26-000305-STR: Residential Structural Record Status: App Submitted Expiration Date: 02/28/2027 "
  + "Create a New Collection *Name: Description: spell check Add Cancel A notice was added to this record on "
  + "08/31/2026.Condition: Sewer RecoverySeverity: NoticeTotal Conditions: 1 (Notice: 1)View Condition Conditions "
  + "Showing 1-1 of 1 Parcel Notifications - 1 Applied Sewer Recovery Sewer Recoveryloaded by scriptApplied | Notice "
  + "| 08/31/2026 Work Location [SITE ADDRESS] COOS BAY OR 97420 * Record Details Applicant: [APPLICANT] "
  + "Project Description:[HOMEOWNER] Install 3.52 kW DC / 3.072 kW AC roof-mounted photovoltaic system";

// SYNTHETIC: two conditions in the SAME glued shape as the real page (a second group, a second
// row). Accela lists conditions by group; no production page with two was on hand.
const TWO_CONDITIONS = COOS_BAY_PAGE
  .replace("Total Conditions: 1 (Notice: 1)", "Total Conditions: 2 (Notice: 1, Hold: 1)")
  .replace("Showing 1-1 of 1", "Showing 1-2 of 2")
  .replace("Applied | Notice | 12/13/2019 ", "Applied | Notice | 12/13/2019 Building Conditions - 1 Applied Building Other "
    + "FLOODPLAIN DEVELOPMENTFloodplain development permit required prior to issuance.Applied | Hold | 09/20/2026 ");
const FLOODPLAIN_CONDITION =
  "FLOODPLAIN DEVELOPMENT - Severity: Hold - Floodplain development permit required prior to issuance. Applied | Hold | 09/20/2026";

// SYNTHETIC: the pager shows 2 of 3 — the page lists more conditions than it printed.
const PAGED_CONDITIONS = TWO_CONDITIONS
  .replace("Total Conditions: 2 (Notice: 1, Hold: 1)", "Total Conditions: 3 (Notice: 1, Hold: 2)")
  .replace("Showing 1-2 of 2", "Showing 1-2 of 3");

// The header alone (structureListingsSpacing.test.ts's Lincoln City shape): no row printed.
const HEADER_ONLY = "Record 000-26-000000-STR: Residential Solar Record Status: In Review Expiration Date: 03/01/2027 "
  + "Add Cancel A notice was added to this record on 05/01/2026.Condition: FloodplainSeverity: NoticeTotal Conditions: 1 "
  + "(Notice: 1)View Condition Conditions Showing 1-1 of 1 Record Details";

// A labelled review-comment block (EnerGov / Tyler-style record text, synthetic).
const REVIEW_COMMENTS = "Permit BLD-2026-0412 Residential Solar Status: Corrections Required Plan Review Comments: "
  + "1. Provide the rafter span table for the array area. 2. Label the rapid shutdown initiator. Inspections Fees Documents";

// MUST-EXCLUDE: pages with NO condition row and NO review-comment block.
const TAB_STRIP = "Record 187-26-000999-STR: Residential Structural Record Status: In Review/Addl Info Needed Expiration Date: "
  + "03/16/2027 Record Info/Schedule Inspections Payments Conditions Processing Status Loading... Loading...";
const AIR_CONDITIONING = "New air conditioning condenser on pad. Conditions of approval attached.";
const PLAIN_CORRECTION = "Corrections required. Revise and resubmit the structural calculations.";
const ADDITIONAL_COMMENTS_ONLY = "Record 187-26-000999-STR: Record Status: In Review/Addl Info Needed Additional Comments: "
  + "Roof-mounted residential solar PV system, 8.36 kW DC / 7.68 kW AC Parcel Information Parcel Number:[PARCEL]";

// ---------------------------------------------------------------------------------------------
// 1. EXTRACTION
// ---------------------------------------------------------------------------------------------
await check("COOS BAY: the one PERMIT OUTSTANDING condition, and nothing of the page around it", () => {
  const r = extractCorrectionFromPage(COOS_BAY_PAGE);
  assert.equal(r.method, "items");
  assert.deepEqual(r.conditions, [COOS_BAY_CONDITION]);
  assert.deepEqual(r.comments, [], "Accela's application field 'Additional Comments: Roof-mounted...' read as a reviewer comment");
  assert.equal(r.text, COOS_BAY_CONDITION);
  for (const chrome of ["Silverlight", "Valuation", "Licensed Professional", "Loading", "OWNER OF RECORD", "Structural"]) {
    assert.ok(!r.text.includes(chrome), `the correction still carries page chrome: "${chrome}"`);
  }
});

await check("IVY: the second real shape — a mixed-case name printed twice, its description glued on", () => {
  const r = extractCorrectionFromPage(IVY_CONDITIONS);
  assert.equal(r.method, "items");
  assert.equal(r.conditions.length, 1, JSON.stringify(r.conditions));
  assert.match(r.conditions[0], /^Sewer Recovery - Severity: Notice - loaded by script\.? Applied \| Notice \| 08\/31\/2026$/);
});

await check("TWO CONDITIONS: both rows, in page order", () => {
  const r = extractCorrectionFromPage(TWO_CONDITIONS);
  assert.deepEqual(r.conditions, [COOS_BAY_CONDITION, FLOODPLAIN_CONDITION]);
  assert.equal(r.text, `${COOS_BAY_CONDITION}\n${FLOODPLAIN_CONDITION}`);
});

await check("A DENOMINATOR: a page that lists 3 conditions and prints 2 says so in the correction", () => {
  const r = extractCorrectionFromPage(PAGED_CONDITIONS);
  assert.equal(r.conditions.length, 2);
  assert.match(r.text, /lists 3 conditions; 2 were read/);
});

await check("HEADER ONLY: the condition the header names is still the correction", () => {
  const r = extractCorrectionFromPage(HEADER_ONLY);
  assert.equal(r.method, "items");
  assert.deepEqual(r.conditions, ["Condition: Floodplain"]);
});

await check("REVIEW COMMENTS: a labelled comment block on another platform is the correction", () => {
  const r = extractCorrectionFromPage(REVIEW_COMMENTS);
  assert.equal(r.method, "items");
  assert.deepEqual(r.conditions, []);
  assert.equal(r.comments.length, 1);
  assert.equal(r.comments[0], "1. Provide the rafter span table for the array area. 2. Label the rapid shutdown initiator.");
});

await check("NONE FOUND: the whole text stands as the correction, and the reading says it fell back", () => {
  for (const page of [TAB_STRIP, AIR_CONDITIONING, PLAIN_CORRECTION, ADDITIONAL_COMMENTS_ONLY]) {
    const r = extractCorrectionFromPage(page);
    assert.equal(r.method, "whole_text", `"${page.slice(0, 60)}" -> ${r.method}: ${JSON.stringify(r.conditions.concat(r.comments))}`);
    assert.equal(r.text, page.trim());
    assert.deepEqual(r.conditions.concat(r.comments), []);
  }
});

await check("ONE PREDICATE: the extractor finds a condition exactly where the monitor's recordConditionOf does", () => {
  const pages = { COOS_BAY_PAGE, IVY_CONDITIONS, TWO_CONDITIONS, PAGED_CONDITIONS, HEADER_ONLY, REVIEW_COMMENTS, TAB_STRIP, AIR_CONDITIONING, PLAIN_CORRECTION, ADDITIONAL_COMMENTS_ONLY };
  for (const [name, page] of Object.entries(pages)) {
    assert.equal(extractCorrectionFromPage(page).conditions.length > 0, recordConditionOf(page) !== "",
      `${name}: the extractor and the status message disagree on whether this page carries a condition`);
  }
});

// ---------------------------------------------------------------------------------------------
// 2. ONE DECISION — assignee is a function of the bucket
// ---------------------------------------------------------------------------------------------
await check("ONE MAP: every regex classification's assignee is assigneeForBucket(its bucket)", () => {
  for (const t of ["Provide stamped structural calculations.", "The account number does not match the bill.", "Please clarify the setback note?", "Something else entirely."]) {
    const c = classifyCorrection(t);
    assert.equal(c.assignedTo, assigneeForBucket(c.bucket), `${t} -> ${c.bucket} / ${c.assignedTo}`);
  }
  assert.equal(assigneeForBucket("A_we_fix"), "autopilot_operator");
  assert.equal(assigneeForBucket("B_designer_fix"), "designer");
  assert.equal(assigneeForBucket("C_reviewer_clarification"), "human_reviewer");
});

await check("PLAIN LABELS: the bucket reads as words, not an enum", () => {
  assert.equal(humanizeBucket("A_we_fix"), "We fix - operator");
  assert.equal(humanizeBucket("B_designer_fix"), "Designer fix");
  assert.equal(humanizeBucket("C_reviewer_clarification"), "Reviewer clarification");
});

// ---------------------------------------------------------------------------------------------
// 3. THE WRITE PATH — recordPermitStatusCheck, the permit monitor's production write
// ---------------------------------------------------------------------------------------------
const db = await openDatabase();
let seq = 0;
const mkProject = (): string => R.createProject(db, {
  homeownerName: `Extract Owner ${++seq}`, projectAddress: "1 Test Way", state: "OR",
  street: "1 Test Way", city: "Coos Bay", zip: "97420", ahj: "City of Coos Bay", utility: "Pacific Power",
} as never).project.id;
const mkTarget = (pid: string): string => {
  const detail = R.createPermitCheckTarget(db, pid, {
    jurisdiction: "City of Coos Bay", portalName: "Oregon ePermitting (Accela)",
    portalUrl: "https://aca-oregon.accela.com/oregon/Cap/CapDetail.aspx",
    applicationNumber: "187-26-000901-STR", permitType: "building", targetType: "permit",
  } as never);
  return String((detail as never as { permitCheckTargets: Array<{ id: string }> }).permitCheckTargets[0].id);
};
type CRow = { id: string; correction_text: string; source_text: string; correction_bucket: string; assigned_to: string };
const correctionOf = (pid: string): CRow => db.get<CRow>("SELECT * FROM corrections WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", [pid])!;

const coosBayPid = mkProject();
await R.recordPermitStatusCheck(db, coosBayPid, { targetId: mkTarget(coosBayPid), source: "public_url", rawStatusText: COOS_BAY_PAGE });
const coosBay = correctionOf(coosBayPid);

await check("STORED: correction_text is the condition; the page is kept whole as source_text", () => {
  assert.ok(coosBay, "the Addl Info Needed page opened no correction");
  assert.equal(coosBay.correction_text, COOS_BAY_CONDITION);
  assert.equal(coosBay.source_text, COOS_BAY_PAGE, "the page text the correction was read from was discarded");
});

await check("STORED: the review item's excerpt is the correction too (persistTriage's legacy match reads it)", () => {
  const item = db.get<{ source_excerpt: string }>(
    "SELECT source_excerpt FROM human_review_items WHERE project_id = ? AND field_name = 'correction'", [coosBayPid]);
  assert.equal(item?.source_excerpt, COOS_BAY_CONDITION.slice(0, 800));
});

await check("CLASSIFIED ON THE CORRECTION: 'Residential Structural Record' in the page header no longer makes it a designer fix", () => {
  assert.notEqual(coosBay.correction_bucket, "B_designer_fix");
  assert.notEqual(coosBay.assigned_to, "designer");
  assert.equal(coosBay.assigned_to, assigneeForBucket(coosBay.correction_bucket as never));
});

await check("THE RECORD: the detail says how the text was read, with the plain label", () => {
  const c = R.getProjectDetail(db, coosBayPid).corrections[0]!;
  assert.equal(c.extraction, "items");
  assert.equal(c.sourceText, COOS_BAY_PAGE);
  assert.equal(c.bucketLabel, humanizeBucket(c.correctionBucket));
});

await check("FALLBACK ON THE WRITE PATH: nothing to extract keeps the whole reading and reads 'whole_text'", async () => {
  const pid = mkProject();
  await R.recordPermitStatusCheck(db, pid, { targetId: mkTarget(pid), source: "public_url", rawStatusText: TAB_STRIP });
  const row = correctionOf(pid);
  assert.equal(row.correction_text, TAB_STRIP);
  assert.equal(row.source_text, TAB_STRIP);
  assert.equal(R.getProjectDetail(db, pid).corrections[0]!.extraction, "whole_text");
});

await check("A TYPED CORRECTION is stored as entered — no page, nothing extracted", () => {
  const pid = mkProject();
  R.addManualCorrection(db, pid, "Provide stamped structural calculations for the rafters.");
  const c = R.getProjectDetail(db, pid).corrections[0]!;
  assert.equal(c.correctionText, "Provide stamped structural calculations for the rafters.");
  assert.equal(c.sourceText, "");
  assert.equal(c.extraction, "not_extracted");
});

// ---------------------------------------------------------------------------------------------
// 4. THE AGENT'S REFINEMENT MOVES THE ASSIGNEE
// ---------------------------------------------------------------------------------------------
await check("REFINED BUCKET, REFINED OWNER: the agent's A_we_fix makes the row the operator's, never a stale keyword pick", () => {
  // Stand the row where production's was: the keyword pick said designer.
  db.run("UPDATE corrections SET correction_bucket = 'B_designer_fix', assigned_to = 'designer' WHERE id = ?", [coosBay.id]);
  persistTriage(db, { correctionId: coosBay.id, projectId: coosBayPid }, {
    bucket: "A_we_fix", rootCause: "Not a design or plan-set deficiency.", requiredAction: "Operator to contact the city.",
    draft: "", actions: [], proposals: [],
  });
  const row = correctionOf(coosBayPid);
  assert.equal(row.correction_bucket, "A_we_fix");
  assert.equal(row.assigned_to, "autopilot_operator", `bucket A_we_fix still assigned to ${row.assigned_to}`);
});

await check("NO BUCKET, NO MOVE: a triage that sets no bucket leaves bucket and owner as they were", () => {
  persistTriage(db, { correctionId: coosBay.id, projectId: coosBayPid }, { draft: "Thanks.", actions: [], proposals: [] });
  const row = correctionOf(coosBayPid);
  assert.equal(row.correction_bucket, "A_we_fix");
  assert.equal(row.assigned_to, "autopilot_operator");
});

// ---------------------------------------------------------------------------------------------
// 5. THE BACKFILL — rows older code wrote (the page AS correction_text, no source_text)
// ---------------------------------------------------------------------------------------------
// Inserted in the old shape directly: today's write path cannot produce one.
const legacyPid = mkProject();
await R.recordPermitStatusCheck(db, legacyPid, { targetId: mkTarget(legacyPid), source: "public_url", rawStatusText: COOS_BAY_PAGE });
const legacy = correctionOf(legacyPid);
db.run("UPDATE corrections SET correction_text = ?, source_text = '', correction_bucket = 'A_we_fix', assigned_to = 'designer' WHERE id = ?", [COOS_BAY_PAGE, legacy.id]);
db.run("UPDATE human_review_items SET source_excerpt = ? WHERE project_id = ? AND field_name = 'correction'", [COOS_BAY_PAGE.slice(0, 800), legacyPid]);
const emailPid = mkProject();
R.addManualCorrection(db, emailPid, PLAIN_CORRECTION, "email");

await check("BACKFILL PLAN: the legacy portal row is re-extracted; the email row is left alone", () => {
  const plan = planCorrectionTextBackfill(db);
  const mine = plan.find((p) => p.id === legacy.id);
  assert.ok(mine, "the legacy portal row is not in the plan");
  assert.equal(mine!.correctionText, COOS_BAY_CONDITION);
  assert.equal(mine!.method, "items");
  assert.equal(mine!.assignedTo, "autopilot_operator", "the stale designer assignee is not re-derived from the stored bucket");
  const emailRow = correctionOf(emailPid);
  assert.ok(!plan.some((p) => p.id === emailRow.id && p.correctionText !== emailRow.correction_text),
    "an email correction was re-extracted — its text is the email, not a portal page");
});

await check("BACKFILL APPLY: text, evidence, owner and excerpt; the page is never lost", () => {
  applyCorrectionTextBackfill(db, planCorrectionTextBackfill(db));
  const row = correctionOf(legacyPid);
  assert.equal(row.correction_text, COOS_BAY_CONDITION);
  assert.equal(row.source_text, COOS_BAY_PAGE);
  assert.equal(row.assigned_to, "autopilot_operator");
  const item = db.get<{ source_excerpt: string }>(
    "SELECT source_excerpt FROM human_review_items WHERE project_id = ? AND field_name = 'correction'", [legacyPid]);
  assert.equal(item?.source_excerpt, COOS_BAY_CONDITION);
});

await check("BACKFILL IDEMPOTENT: a second run has nothing to do", () => {
  const again = planCorrectionTextBackfill(db);
  assert.equal(again.length, 0, `second run would change ${again.length} row(s): ${again.map((p) => p.id.slice(0, 8)).join(" ")}`);
  assert.equal(applyCorrectionTextBackfill(db, again).corrections, 0);
});

if (failures) { console.error(`\n${failures} correction page-extract test(s) FAILED.`); process.exit(1); }
console.log("\nAll correction page-extract tests passed.");
try { db.close(); } catch { /* fire-and-forget work may still hold the handle */ }
process.exit(0);
