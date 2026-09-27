// THE PORTAL'S OWN FEE, READ AUTOMATICALLY OFF THE FILED RECORD (operator 2026-09-27).
//
// Ann Marineau's permit line read "$360.00 (provisional)" while her City of Coos Bay record
// 187-26-000309-STR sat on the portal with a Fees section the monitor never opened. This pins
// the read end to end on the REAL sweep (runDuePermitChecks), with both outside doors seamed
// (no portal is touched):
//
//   1. THE PARSER (shared/src/portalFeeItems.ts) on an Accela CapDetail Fees section built from
//      the captured Coos Bay page shape (the Ivy scrape, verbatim around it; amounts are fake):
//      invoices + the portal's own totals; "Loading...", "no fees" and a $0.00 total are
//      REFUSALS, never a $0 fee; the excerpt is the fee section only (no homeowner); the
//      review-screen reader sums fee fields and never reads the job valuation as a fee.
//   2. THE SWEEP: a two-record Coos-shaped permit track (city STR + county ELEC). One record
//      read = shown BESIDE the researched $360 (never in its place); the plain fetch's
//      "Loading..." falls back to the browser reader; both read = source "portal_record",
//      confidence "actual" (never "verified"), provenance "read from the portal records … on
//      …", both numbers and the difference; permit_fee_actual_usd (a person's column) and
//      fee_schedules untouched; learned history fed only once complete AND issued, and a median
//      holding a machine read is NOT "verified".
//   3. A lower-bound read (record in review, $99 invoiced < researched) does not lead the line.
//   4. An operator-entered actual stands over a disagreeing machine read, which is shown beside.
//   5. A page that does not name the target's record is refused (someone else's fees).
//   6. A schedule a person confirmed is untouched by a later automated read.
//   7. The dashboard's real renderer: "actual — read from the portal", provenance on the face,
//      both numbers and the gap, everything escaped, never "verified".
// Kill: the sweep's readAndRecordPortalFees call removed -> section 2 FAILS.
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO } from "./_isolate";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   ${name}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-fee-read-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
process.env.AUTOPILOT_TEST_SEAMS = "1";
process.env.SUBMISSION_SERVICE_FEE_USD = "0";
for (const k of ["BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH", "CLIENT_NOTIFICATIONS", "CODE_RESEARCH"]) process.env[k] = "off";
for (const k of ["SMTP_HOST", "SMTP_FROM", "ANTHROPIC_API_KEY", "PORTAL_FEE_READ", "PORTAL_FEE_BROWSER_READ"]) delete process.env[k];

const { readAccelaFeeSection, readReviewScreenFees } = await import("../../shared/src/portalFeeItems");
const { reviewScreenFees } = await import("../../portal-bot/src/reviewScreenScraper");

// ── fixtures ────────────────────────────────────────────────────────────────────────────────
// The captured Coos Bay record page (correctionTrackClassify.test's IVY_PERMIT_SCRAPE shape,
// identifiers fake), with its Fees section in the three states a monitor can meet it.
const STR = "187-26-000309-STR";
const ELEC = "194-26-001482-ELEC";
const head = (record: string, status: string) =>
  `Record ${record}: Residential Structural Record Status: ${status} Expiration Date: 02/28/2027 `
  + "Work Location 12 Example Lane COOS BAY OR 97420 * Record Details Applicant: Ann Example "
  + "Licensed Professional:TML INTERNATIONAL LLC 223690 CCB 223690 Project Description: Ann Example Install 8.36 kW DC roof-mounted photovoltaic system "
  + "Additional Information Job Value($):$21,383.55 Number of Buildings:1 Parcel Information Parcel Number:25S13W20CCTL0250300\n";
const TAIL = "\nInspections Click here to view a list of the Oregon Standard Model Inspection Codes. Documents Upload/View Valuation Calculator "
  + "Occupancy Type Quantity Unit Unit Cost Job Value No records found. Right Of Way Management No ROWM data available at this time.";
const LOADING = "Print/View Summary Fees Loading...";
const feesStr = [
  "Print/View Summary Fees", "Fees", "Outstanding:", "Date\tInvoice Number\tAmount", "09/05/2026\t1234567\t$56.00\tPay Fees",
  "Total outstanding fees: $56.00", "View Details", "Paid:", "Date\tInvoice Number\tAmount", "08/31/2026\t1234401\t$180.00",
  "Total paid fees: $180.00", "View Details",
].join("\n");
const feesStrIssued = ["Print/View Summary Fees", "Fees", "Paid:", "Date\tInvoice Number\tAmount", "08/31/2026\t1234401\t$180.00",
  "10/02/2026\t1236610\t$56.00", "Total paid fees: $236.00", "View Details"].join("\n");
const feesElec = ["Print/View Summary Fees", "Fees", "Paid:", "Date\tInvoice Number\tAmount", "09/02/2026\t2204118\t$179.20",
  "Total paid fees: $179.20", "View Details"].join("\n");
const page = (record: string, status: string, fees: string) => `${head(record, status)}${fees}${TAIL}`;

// ═══ 1. THE PARSER ═══════════════════════════════════════════════════════════════════════════
{
  const r = readAccelaFeeSection(page(STR, "In Review", feesStr));
  check("1a. a loaded Fees section reads: $56.00 outstanding + $180.00 paid = $236.00, two invoices",
    r.ok && r.reading.outstandingUsd === 56 && r.reading.paidUsd === 180 && r.reading.totalUsd === 236 && r.reading.lines.length === 2,
    JSON.stringify(r));
  check("1b. invoice numbers are masked and the excerpt is the fee section only (no homeowner, no address, no job value)",
    r.ok && !/1234567|1234401/.test(JSON.stringify(r.reading)) && !/Ann Example|Example Lane|21,383/.test(r.reading.excerpt), r.ok ? r.reading.excerpt : "");
  const flat = readAccelaFeeSection(page(STR, "In Review", feesStr).replace(/\s+/g, " "));
  check("1c. the same page whitespace-collapsed reads the same total", flat.ok && flat.reading.totalUsd === 236, JSON.stringify(flat));
  const captured = readAccelaFeeSection(page(STR, "In Review/Addl Info Needed", LOADING));
  check("1d. the captured Coos Bay page ('Print/View Summary Fees Loading...') is NOT a reading — not_loaded, no amount",
    !captured.ok && captured.reason === "not_loaded", JSON.stringify(captured));
  const none = readAccelaFeeSection(page(STR, "App Submitted", "Print/View Summary Fees Fees There are no outstanding fees."));
  check("1e. a loaded section with no fee invoiced is none_invoiced — never $0", !none.ok && none.reason === "none_invoiced", JSON.stringify(none));
  const zero = readAccelaFeeSection(page(STR, "App Submitted", "Print/View Summary Fees Fees Outstanding: Total outstanding fees: $0.00 Paid: Total paid fees: $0.00"));
  check("1f. a section totalling $0.00 is none_invoiced — never a $0 fee", !zero.ok && zero.reason === "none_invoiced", JSON.stringify(zero));
  const nothing = readAccelaFeeSection(head(STR, "App Submitted") + TAIL);
  check("1g. a page with no Fees section is no_fee_section", !nothing.ok && nothing.reason === "no_fee_section", JSON.stringify(nothing));
  const review = readReviewScreenFees([
    { label: "Permit Fee", value: "$200.00" }, { label: "Plan Review Fee", value: "$99.00" }, { label: "Job Value($)", value: "$21,383.55" },
    { label: "Total Fees", value: "$299.00" }, { label: "Applicant", value: "Ann Example" },
  ], "");
  check("1h. the review screen: fee fields read, the printed total wins, the job value is never a fee",
    review.ok && review.reading.totalUsd === 299 && review.reading.lines.length === 2 && !/21,383|Job Value/.test(JSON.stringify(review.reading)), JSON.stringify(review));
  const reviewZero = reviewScreenFees([{ label: "Total Fees", value: "$0.00" }], "");
  check("1i. the review scraper's export shares the parser, and a $0.00 review total is a refusal", !reviewZero.ok && reviewZero.reason === "none_invoiced", JSON.stringify(reviewZero));
  const reviewBody = reviewScreenFees([], "Step 5: Review ... Fee Total: $412.40 ... Submit Application");
  check("1j. …and a printed body total is read when no field carries it", reviewBody.ok && reviewBody.reading.totalUsd === 412.4, JSON.stringify(reviewBody));
}

// ═══ 2. THE SWEEP ════════════════════════════════════════════════════════════════════════════
const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const F = await import("../src/feeSchedules");
const PF = await import("../src/portalFeeReadings");
const { buildPaymentQuote, buildProjectFeeSheet, recordActualPermitFee } = await import("../src/submissionFees");
const { confirmPublishedFee } = await import("../src/feeConfirm");
type Finding = import("../src/feeSchedules").FeeScheduleFinding;
const db = await openDatabase();

const finding = (over: Partial<Finding>): Finding => ({
  found: true, reason: "", basis: "flat", brackets: [], notes: "", paymentMethod: "portal",
  sourceUrl: "https://example.gov/fees.pdf", sourceQuote: "A sentence a person could go back and read.", sourceKind: "official", ...over,
});
const seedSplit = (city: string, county: string): void => {
  const countyKey = F.feeScheduleProfileKey({ state: "OR", ahj: county }, "permit");
  F.saveFeeSchedule(db, { state: "OR", ahj: city, track: "permit", discipline: "structural" }, finding({ brackets: [{ feeUsd: 200, label: "Solar PV installation permit" }] }));
  F.saveFeeSchedule(db, { state: "OR", ahj: county, track: "permit", discipline: "electrical" }, finding({
    basis: "system_kw", brackets: [{ maxKw: 5, feeUsd: 135, label: "5 KVA or less" }, { minKw: 5.01, maxKw: 15, feeUsd: 160, label: "5.01 KVA to 15 KVA" }],
  }));
  F.saveFeeSchedule(db, { state: "OR", ahj: city, track: "permit", discipline: "electrical" }, finding({ basis: "other", brackets: [], collectedByProfileKey: countyKey }));
};
const mkProject = (ahj: string) => R.createProject(db, {
  owner: "Synthetic Owner", state: "OR", dcKw: "8.36", acKw: "7.68", street: "1 Test Way", city: "Testbay", zip: "97420", ahj, utility: "Test Power",
} as never).project;
const capUrl = (code: string, cap3: string) => `https://aca-oregon.accela.com/oregon/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=26CAP&capID2=00000&capID3=${cap3}&agencyCode=${code}`;
const mkTarget = (pid: string, record: string, jurisdiction: string, permitType: string, url: string): string => {
  const d = R.createPermitCheckTarget(db, pid, { targetType: "permit", permitType, jurisdiction, portalName: "Oregon ePermitting", portalUrl: url, applicationNumber: record, permitNumber: record });
  return (d as unknown as { permitCheckTargets: Array<{ id: string; applicationNumber: string }> }).permitCheckTargets.find((t) => t.applicationNumber === record)!.id;
};
const due = (tid: string, when = "2020-01-01T00:00:00.000Z") => db.run("UPDATE permit_check_targets SET next_check_at = ? WHERE id = ?", [when, tid]);
const snapshotSchedules = () => JSON.stringify(db.query("SELECT id, confidence, verified_by, verified_at, brackets_json, source_quote, updated_at FROM fee_schedules ORDER BY id"));

// Seamed doors: the status fetch returns the record's status; the fee reader's plain fetch and
// browser read return the pages below (url -> text).
const statusText = new Map<string, string>();
const plainPages = new Map<string, string>();
const browserPages = new Map<string, string>();
const browserCalls: string[] = [];
R.setStatusCheckSeamsForTests({ checkStatus: async () => null, publicCheck: async (url: string) => statusText.get(url) ?? null });
PF.setPortalFeeFetchForTests({
  plain: async (url) => plainPages.get(url) ?? null,
  browser: async (url) => { browserCalls.push(url); return browserPages.get(url) ?? null; },
});

seedSplit("City of Readbay", "Read County");
const ann = mkProject("City of Readbay");
const strUrl = capUrl("READBAY", "000H4");
const elecUrl = capUrl("READ_CO", "001HU");
const strTid = mkTarget(ann.id, STR, "City of Readbay", "building", strUrl);
const elecTid = mkTarget(ann.id, ELEC, "Read County", "electrical", elecUrl);
const permitQuote = () => buildPaymentQuote(db, R.getProjectDetail(db, ann.id).project, "permit");
const before = permitQuote();
check("2a. before any read: the researched $360.00 from the published schedule, no portal records",
  before.permitFeeSource === "published_schedule" && before.permitFeeUsd === 360 && before.portalFeeRecords === null, `${before.permitFeeSource} ${before.permitFeeUsd}`);
const schedulesBefore = snapshotSchedules();

// Sweep 1: only the city's STR record is due; its plain fetch shows the Loading placeholder.
statusText.set(strUrl, `Record ${STR}: Residential Structural Record Status: In Review Expiration Date: 02/28/2027`);
plainPages.set(strUrl, page(STR, "In Review", LOADING));
browserPages.set(strUrl, page(STR, "In Review", feesStr));
due(strTid);
due(elecTid, "2099-01-01T00:00:00.000Z");
await R.runDuePermitChecks(db, "permit");
const q1 = permitQuote();
check("2b. the plain fetch's 'Loading...' fell back to the browser reader, once, for the record's own URL",
  browserCalls.length === 1 && browserCalls[0] === strUrl, JSON.stringify(browserCalls));
check("2c. ONE of two records read: the amount stays the researched $360.00 (published schedule)",
  q1.permitFeeSource === "published_schedule" && q1.permitFeeUsd === 360, `${q1.permitFeeSource} ${q1.permitFeeUsd}`);
check("2d. …and the partial read is shown BESIDE it: $236.00 read so far, the county record named as not yet read",
  q1.portalFeeRecords?.complete === false && q1.portalFeeRecords?.totalUsd === 236 && q1.permitFeeComparison?.shown === "researched"
    && q1.permitFeeComparison?.portalUsd === 236 && /not yet read: 194-26-001482-ELEC/.test(q1.permitFeeComparison?.note ?? ""),
  JSON.stringify(q1.permitFeeComparison));

// Sweep 2: the county's ELEC record (issued) is due; its plain fetch is server-rendered.
statusText.set(elecUrl, `Record ${ELEC}: Residential Electrical Record Status: Issued Expiration Date: 03/01/2027`);
plainPages.set(elecUrl, page(ELEC, "Issued", feesElec));
due(elecTid);
await R.runDuePermitChecks(db, "permit");
const q2 = permitQuote();
check("2e. both records read: source portal_record, confidence 'actual' (never 'verified'), $415.20",
  q2.permitFeeSource === "portal_record" && q2.permitFeeConfidence === "actual" && q2.permitFeeUsd === 415.2, `${q2.permitFeeSource} ${q2.permitFeeConfidence} ${q2.permitFeeUsd}`);
const today = new Date().toISOString().slice(0, 10);
check("2f. provenance: 'read from the portal records 187-26-000309-STR on <date> and 194-26-001482-ELEC on <date>'",
  q2.permitFeeBasis.includes(`read from the portal records ${STR} on ${today} and ${ELEC} on ${today}`) && /no person has checked it/.test(q2.permitFeeBasis), q2.permitFeeBasis);
check("2g. …the STR record is still in review, so it says the fees may grow", /invoiced so far/.test(q2.permitFeeBasis), q2.permitFeeBasis);
check("2h. both numbers and the difference: researched $360.00 (published schedule), portal $415.20, +$55.20",
  q2.permitFeeComparison?.researchedUsd === 360 && q2.permitFeeComparison?.researchedSource === "published_schedule"
    && q2.permitFeeComparison?.portalUsd === 415.2 && q2.permitFeeComparison?.differenceUsd === 55.2 && q2.permitFeeComparison?.shown === "portal",
  JSON.stringify(q2.permitFeeComparison));
const pay = db.get<{ permit_fee_actual_usd: number | null; permit_fee_estimate_usd: number | null }>("SELECT permit_fee_actual_usd, permit_fee_estimate_usd FROM submission_payments WHERE project_id = ? AND track = 'permit'", [ann.id]);
check("2i. the person's column (permit_fee_actual_usd) is never written by a machine read; the estimate column keeps research",
  pay?.permit_fee_actual_usd == null && pay?.permit_fee_estimate_usd === 360, JSON.stringify(pay));
check("2j. fee_schedules untouched by the reads", snapshotSchedules() === schedulesBefore);
check("2k. not every record is issued: nothing fed to learned history yet",
  db.query("SELECT 1 FROM permit_fee_history WHERE project_id = ?", [ann.id]).length === 0);
const line2 = buildProjectFeeSheet(db, R.getProjectDetail(db, ann.id).project).lines.find((l) => l.track === "permit")!;
check("2l. the sheet line: known, confidence actual, not confirmable, portal records carried", line2.known && line2.confidence === "actual" && !line2.confirmable && line2.portalRecords?.complete === true);

// Sweep 3: the STR record is issued; its status moved, so it is re-read at once (no 20h wait).
statusText.set(strUrl, `Record ${STR}: Residential Structural Record Status: Issued Expiration Date: 02/28/2027`);
plainPages.set(strUrl, page(STR, "Issued", feesStrIssued));
due(strTid);
await R.runDuePermitChecks(db, "permit");
const q3 = permitQuote();
check("2m. issued and re-read: final — no 'invoiced so far' caveat, still $415.20", q3.permitFeeUsd === 415.2 && !/invoiced so far/.test(q3.permitFeeBasis) && q3.portalFeeRecords?.final === true, q3.permitFeeBasis);
const hist = db.query<{ fee_usd: number; source: string }>("SELECT fee_usd, source FROM permit_fee_history WHERE project_id = ?", [ann.id]);
check("2n. complete AND final: ONE learned-history row, source portal_record, the project total",
  hist.length === 1 && hist[0].source === "portal_record" && hist[0].fee_usd === 415.2, JSON.stringify(hist));
due(strTid);
await R.runDuePermitChecks(db, "permit");
check("2o. re-reading does not double-count it", db.query("SELECT 1 FROM permit_fee_history WHERE project_id = ?", [ann.id]).length === 1);
const neighbour = mkProject("City of Readbay");
const qn = buildPaymentQuote(db, neighbour, "permit");
check("2p. a neighbour learns from it — and a median holding a MACHINE read is NOT 'verified'",
  qn.permitFeeSource === "learned_history" && qn.permitFeeUsd === 415.2 && qn.permitFeeConfidence === "seeded" && /read automatically/.test(qn.permitFeeBasis),
  `${qn.permitFeeSource} ${qn.permitFeeUsd} ${qn.permitFeeConfidence} ${qn.permitFeeBasis}`);

// ═══ 3. A LOWER BOUND DOES NOT LEAD ══════════════════════════════════════════════════════════
F.saveFeeSchedule(db, { state: "OR", ahj: "City of Lowbay", track: "permit" }, finding({ brackets: [{ feeUsd: 300, label: "Solar PV permit" }] }));
const low = mkProject("City of Lowbay");
const lowUrl = capUrl("LOWBAY", "000L1");
const lowRecord = "187-26-000777-STR";
const lowTid = mkTarget(low.id, lowRecord, "City of Lowbay", "building", lowUrl);
statusText.set(lowUrl, `Record ${lowRecord}: Record Status: In Review`);
plainPages.set(lowUrl, page(lowRecord, "In Review", ["Print/View Summary Fees", "Fees", "Paid:", "Date\tInvoice Number\tAmount", "09/01/2026\t3300001\t$99.00", "Total paid fees: $99.00"].join("\n")));
due(lowTid);
await R.runDuePermitChecks(db, "permit");
const ql = buildPaymentQuote(db, R.getProjectDetail(db, low.id).project, "permit");
check("3a. a record in review with $99.00 invoiced (< researched $300.00) does not become the amount",
  ql.permitFeeSource === "published_schedule" && ql.permitFeeUsd === 300, `${ql.permitFeeSource} ${ql.permitFeeUsd}`);
check("3b. …it is shown beside it with the gap, marked not the amount",
  ql.permitFeeComparison?.shown === "researched" && ql.permitFeeComparison?.portalUsd === 99 && ql.permitFeeComparison?.differenceUsd === -201 && /more may be invoiced/.test(ql.permitFeeComparison?.note ?? ""),
  JSON.stringify(ql.permitFeeComparison));

// ═══ 4. A PERSON'S ENTRY STANDS ══════════════════════════════════════════════════════════════
recordActualPermitFee(db, R.getProjectDetail(db, ann.id).project, "permit", 400, "operator");
const q4 = permitQuote();
check("4a. an operator-entered actual stands over the machine read ($400.00, source actual)", q4.permitFeeSource === "actual" && q4.permitFeeUsd === 400, `${q4.permitFeeSource} ${q4.permitFeeUsd}`);
check("4b. …the disagreeing portal read is shown beside it", /portal records? read \$415\.20/.test(q4.permitFeeComparison?.note ?? "") && q4.portalFeeRecords?.totalUsd === 415.2, JSON.stringify(q4.permitFeeComparison));

// ═══ 5. NEVER SOMEONE ELSE'S RECORD ══════════════════════════════════════════════════════════
const other = mkProject("City of Lowbay");
const otherUrl = capUrl("LOWBAY", "000Z9");
const otherTid = mkTarget(other.id, "187-26-000888-STR", "City of Lowbay", "building", otherUrl);
statusText.set(otherUrl, "Record 187-26-000888-STR: Record Status: In Review");
plainPages.set(otherUrl, page("187-26-000999-STR", "In Review", feesStr));
due(otherTid);
await R.runDuePermitChecks(db, "permit");
const wrong = db.get<{ status: string; total_usd: number | null }>("SELECT status, total_usd FROM portal_fee_readings WHERE target_id = ?", [otherTid]);
check("5a. a page that names a different record is refused (wrong_record), with no amount", wrong?.status === "wrong_record" && wrong?.total_usd == null, JSON.stringify(wrong));

// ═══ 6. A CONFIRMED SCHEDULE IS UNTOUCHED BY A LATER READ ═══════════════════════════════════
seedSplit("City of Confirmread", "Confirmread County");
const conf = mkProject("City of Confirmread");
confirmPublishedFee(db, conf, "permit", "Jane Operator");
const frozen = JSON.stringify(db.query("SELECT id, confidence, verified_by, verified_at, brackets_json, updated_at FROM fee_schedules WHERE ahj IN ('City of Confirmread','Confirmread County') ORDER BY id"));
const confUrl = capUrl("CONFIRMREAD", "000C1");
const confTid = mkTarget(conf.id, "187-26-000555-STR", "City of Confirmread", "building", confUrl);
statusText.set(confUrl, "Record 187-26-000555-STR: Record Status: Issued");
plainPages.set(confUrl, page("187-26-000555-STR", "Issued", feesElec));
due(confTid);
await R.runDuePermitChecks(db, "permit");
const thawed = JSON.stringify(db.query("SELECT id, confidence, verified_by, verified_at, brackets_json, updated_at FROM fee_schedules WHERE ahj IN ('City of Confirmread','Confirmread County') ORDER BY id"));
check("6a. the fee read happened", db.query("SELECT 1 FROM portal_fee_readings WHERE target_id = ? AND status = 'read'", [confTid]).length === 1);
check("6b. …and the person-confirmed schedule rows are byte-identical, still verified by Jane Operator", thawed === frozen && /Jane Operator/.test(thawed), thawed.slice(0, 200));

// ═══ 7. THE DASHBOARD'S REAL RENDERER ════════════════════════════════════════════════════════
const dashboard = fs.readFileSync(process.env.DASHBOARD_JS_PATH || path.join(REPO, "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const lift = (name: string): string => {
  const m = new RegExp(`^(?:async )?function ${name}\\(|^const ${name} = `, "m").exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find ${name}`);
  const isConst = m[0].startsWith("const");
  let i = isConst ? m.index + m[0].length : dashboard.indexOf("{", dashboard.indexOf(")", m.index));
  let depth = 0;
  for (; i < dashboard.length; i++) {
    const ch = dashboard[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") { depth--; if (depth === 0) { i++; break; } }
  }
  return dashboard.slice(m.index, i) + (isConst ? ";" : "");
};
const NAMES = ["esc", "httpUrl", "portalHostname", "feeMoney", "FEE_SOURCE_TEXT", "FEE_CONFIDENCE", "feeConfidenceKey", "FEE_PAYMENT_METHOD", "renderFeeCharges", "feeFaceSourceHtml", "feeComparisonHtml", "feePortalRecordsHtml", "renderFeeSheetLine"];
// eslint-disable-next-line no-new-func
const lib = new Function("state", `${NAMES.map(lift).join("\n\n")}\nreturn { ${NAMES.join(", ")} };`)({ selectedProjectId: "p1" }) as Record<string, any>;
const face = (html: string): string => html.split("<details")[0];
const words = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const badge = (html: string): string => /<span class="badge [^"]*">([^<]*)<\/span>/.exec(face(html))?.[1] ?? "";
{
  const portalLine = buildProjectFeeSheet(db, R.getProjectDetail(db, neighbour.id).project).lines.find((l) => l.track === "permit")!;
  // The neighbour's line is learned_history; render ann's portal line as it stood after sweep 3.
  const annLine = { ...line2, feeUsd: 415.2, source: "portal_record", confidence: "actual", comparison: q3.permitFeeComparison, portalRecords: q3.portalFeeRecords };
  const html = lib.renderFeeSheetLine(annLine);
  check("7a. a portal-read amount is labelled 'actual — read from the portal', never 'verified'",
    badge(html) === "actual — read from the portal" && !/(?<!not )\bverified\b/i.test(badge(html)), badge(html));
  check("7b. its provenance is on the face", words(face(html)).includes(`The portal's own fee, read from the portal records ${STR} on ${today} and ${ELEC} on ${today}.`), words(face(html)).slice(0, 500));
  check("7c. both numbers and the gap are on the face", /Portal record, read automatically: \$415\.20 — \$55\.20 more than researched/.test(words(face(html))) && /Researched: \$360\.00/.test(words(face(html))), words(face(html)).slice(0, 600));
  check("7d. the records read are one click away, invoices masked", /Read from the portal: 2 of 2 filed records/.test(html) && !/1234401|2204118/.test(html));
  const evil = lib.renderFeeSheetLine({ ...annLine, portalRecords: { ...annLine.portalRecords, provenance: `read from the portal record <script>x</script>` }, comparison: { ...annLine.comparison, note: `<img src=x onerror=1>` } });
  check("7e. provenance and notes are escaped", !/<script>x/.test(evil) && !/<img src=x/.test(evil) && /&lt;script&gt;/.test(evil));
  const learned = lib.renderFeeSheetLine(portalLine);
  check("7f. the neighbour's learned-from-a-machine-read line is not labelled verified", !/(?<!not )\bverified\b/i.test(badge(learned)), badge(learned));
  const partial = lib.renderFeeSheetLine({ ...line2, feeUsd: 360, source: "published_schedule", confidence: "seeded", corroborated: false, comparison: q1.permitFeeComparison, portalRecords: q1.portalFeeRecords });
  check("7g. a partial read is drawn beside the researched amount and flagged as not the amount", /not the amount above/.test(face(partial)) && /\$360\.00/.test(face(partial)), words(face(partial)).slice(0, 500));
}

R.setStatusCheckSeamsForTests(null);
PF.setPortalFeeFetchForTests(null);
db.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp is reaped */ }
if (failures) { console.error(`\nportalFeeRead: ${failures} failure(s)`); process.exit(1); }
console.log("\nportalFeeRead: all checks passed");
