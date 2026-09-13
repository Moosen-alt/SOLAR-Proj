// THE AUTHORITY ALREADY TELLS US WHAT THE PERMIT COST, AND NOBODY WAS READING IT.
//
// The quote ladder's top two rungs are `actual` and `learned_history`. Both were EMPTY on the
// live database — permit_fee_history had 0 rows and no submission_payment carried an actual — so
// every quote fell through to a published schedule or 1.5% of valuation. Meanwhile Portland
// issues a "Billing Summary" PDF for every permit, those PDFs were already being attached to
// projects and text-extracted, and the total sat unread in a column.
//
// Measured on two real ones (validated against the operator's own PDFs, reproduced here in the
// same shape with invented addresses and permit numbers):
//
//   the original    8 fee lines, TOTAL $1,175.83 — of which our fee schedule knows ONE line,
//                   the $283.00 electrical permit. 24% of the bill.
//   a revision      2 fee lines, TOTAL $302.00, carrying only its own charges.
//
// No bracket table reaches $1,175.83, because the cost is a LIST of components and only one is
// size-bracketed: two 12% state surcharges, a zoning inspection, a development services fee, a
// land use plan review and a processing fee. Reading the summary sidesteps the modelling problem
// entirely — the authority has done the arithmetic already.
//
//   MUST READ    — both real shapes, every line, the grand total that sits on the line AFTER the
//                  word TOTAL, and a revision recognised as one.
//   MUST REFUSE  — an ordinary document. This runs over EVERY document a project has, so a plan
//                  set full of dollar amounts must not be read as a bill.
//   MUST NOT     — double-count. Extraction re-fires whenever a document's text is missing, and
//                  recording one bill twice inflates this project AND the AHJ median every other
//                  project inherits. A revision has its own permit number, so it ADDS.
//
//   npx tsx backend/test/feeSummary.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-summary-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { parseFeeSummary, recordFeeSummary } = await import("../src/feeSummary");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// The real layout, line for line, as coordinate extraction yields it. Note the grand total is on
// the line AFTER the word TOTAL — that is how the PDF prints it, and a reader that only looks at
// the word's own line finds nothing.
const ORIGINAL = `CITY OF
PORTLAND, OREGON
PORTLAND PERMITTING & DEVELOPMENT
Billing Summary Today's Date:7/31/2026
Site Address: IVR Number: 5264273
1 EXAMPLE ST
EXAMPLE SOLAR
Permit Number: 26-041592-000-00-RS Residential 1 & 2 Family Permit
APPLICANT EXAMPLE SOLAR LLC Phone: (555) 555-0100
Fee Code Fee Description Fee Amount Paid To Date Balance
141 Building Permit St. Sur. $31.94
171 Building Permit RS $266.15
Bill #5603832 Sub Total $298.09 $0.00 $298.09
144 Electrical Permit St Sur $33.96
173 Electrical Permit RS $283.00
Bill #5603833 Sub Total $316.96 $0.00 $316.96
120 Zoning Inspection Fee $119.00
2468 Development Services Fee - RS $51.78
Bill #5603834 Sub Total $170.78 $0.00 $170.78
* 244 Land Use Plan Review Res $217.00
* 2485 Bldg Plan Rvw/Processing RS/MI/MP $173.00
Bill #5603835 Sub Total $390.00 $0.00 $390.00
TOTAL
$1,175.83 $0.00 $1,175.83
* Fees marked with an asterisk are due at application.`;

const REVISION = `CITY OF
PORTLAND, OREGON
Billing Summary Today's Date:8/18/2026
Permit Number: 26-050978-REV-01-RS Residential 1 & 2 Family Permit
Fee Code Fee Description Fee Amount Paid To Date Balance
* 701 Fire - Plan Review $50.00
Bill #5610729 Sub Total $50.00 $0.00 $50.00
* 2485 Bldg Plan Rvw/Processing RS/MI/MP $252.00
Bill #5610730 Sub Total $252.00 $0.00 $252.00
TOTAL
$302.00 $0.00 $302.00`;

const original = parseFeeSummary(ORIGINAL);
const revision = parseFeeSummary(REVISION);

check("THE HEADLINE: the grand total is read, and it is the whole bill", () => {
  assert.ok(original, "the summary did not parse at all");
  assert.equal(original!.totalUsd, 1175.83,
    "this is the number a quote should use — the fee schedule knows only the $283 electrical line");
});

check("every fee line is read, with the authority's own fee codes", () => {
  assert.equal(original!.lines.length, 8, JSON.stringify(original!.lines.map((l) => l.code)));
  const byCode = Object.fromEntries(original!.lines.map((l) => [l.code, l.amountUsd]));
  assert.equal(byCode["173"], 283.00, "the electrical permit line");
  assert.equal(byCode["171"], 266.15, "the building permit line");
  assert.equal(byCode["141"], 31.94, "the building state surcharge");
  assert.equal(byCode["2485"], 173.00, "plan review/processing");
});

check("the lines reconcile to the printed total, so nothing was lost in extraction", () => {
  const sum = Math.round(original!.lines.reduce((a, l) => a + l.amountUsd, 0) * 100) / 100;
  assert.equal(sum, 1175.83, "a line went missing and the reader did not notice");
  assert.equal(original!.reconciliation, "", `unexpected reconciliation note: ${original!.reconciliation}`);
});

check("MUST EXCLUDE: a subtotal is never counted as a fee line", () => {
  // Portland's subtotals read "Bill #5603832 Sub Total $298.09 $0.00 $298.09" and are excluded by
  // the fee-line pattern itself, which wants a leading fee CODE and one trailing amount. So for
  // this format the explicit skip is belt-and-braces — measured: disable the skip and nothing
  // changes, which is what a vacuous check looks like.
  //
  // The skip earns its place on the format below, where the subtotal leads with a number SHORT
  // enough to pass for a fee code. A 7-digit bill number does not (the code pattern caps at 5),
  // which is why the first two attempts at this case also proved nothing.
  // Counting one would bill the same permit twice, and the reconciliation check above is the only
  // thing that would notice.
  assert.ok(!original!.lines.some((l) => /sub\s*total/i.test(l.description)),
    JSON.stringify(original!.lines.map((l) => l.description)));

  const codeLedSubtotal = parseFeeSummary(`Billing Summary
Permit Number: 26-000001-000-00-RS
Fee Code Fee Description Fee Amount Paid To Date Balance
171 Building Permit RS $100.00
1234 Sub Total $100.00
TOTAL
$100.00 $0.00 $100.00`);
  assert.ok(codeLedSubtotal, "the variant did not parse");
  assert.equal(codeLedSubtotal!.lines.length, 1,
    `a number-led subtotal was counted as a fee: ${JSON.stringify(codeLedSubtotal!.lines)}`);
  assert.equal(codeLedSubtotal!.totalUsd, 100.00, "and the total must not double either");
});

check("the permit number, its base and its date are read", () => {
  assert.equal(original!.permitNumber, "26-041592-000-00-RS");
  assert.equal(original!.basePermitNumber, "26-041592");
  assert.equal(original!.revision, "", "the original is not a revision");
  assert.equal(original!.issuedAt.slice(0, 10), "2026-07-31");
  assert.equal(original!.authority, "City of Portland", "printed in caps on the letterhead");
});

check("a REVISION is recognised as one, and carries only its own charges", () => {
  assert.ok(revision, "the revision did not parse");
  assert.equal(revision!.totalUsd, 302.00);
  assert.equal(revision!.revision, "REV-01");
  assert.equal(revision!.basePermitNumber, "26-050978", "a revision groups with its original");
  assert.equal(revision!.lines.length, 2);
});

check("MUST REFUSE: an ordinary document is not a bill", () => {
  // This runs over EVERY document a project has. A plan set quoting equipment prices, a utility
  // bill, a spec sheet — none may be read as what the AHJ charged.
  for (const notABill of [
    "PV MODULE SPECIFICATION SHEET\nMax Power 400W\nMSRP $215.00 per module\nTOTAL SYSTEM 8.4 kW",
    "PACIFIC POWER\nAmount Due $136.01\nService Address 1 Example St\nTotal Current Charges $130.26",
    "STRUCTURAL CALCULATIONS\nDead Load 4.5 psf\nTotal Load 27.0 psf",
    "",
  ]) {
    assert.equal(parseFeeSummary(notABill), null, `read as a fee summary: ${notABill.slice(0, 40)}`);
  }
});

// ── recording ────────────────────────────────────────────────────────────────────────────
const now = new Date().toISOString();
db.run(
  `INSERT INTO projects (id, homeowner_name, state, ahj, utility, system_size_dc_kw, system_size_ac_kw, status, parser_json, created_at, updated_at)
   VALUES ('fs-1', 'Fee Summary Test', 'OR', 'City of Portland', 'PGE', 10.9, 8.376, 'submitted', '{}', ?, ?)`,
  [now, now],
);
const project = { id: "fs-1", state: "OR", ahj: "City of Portland", utility: "PGE" } as never;

check("recording puts a REAL fee on file, which is the ladder's top tier", () => {
  const out = recordFeeSummary(db, project, original!);
  assert.equal(out.recorded, true, out.reason);
  assert.equal(out.totalForPermitUsd, 1175.83);
  const n = db.query<{ n: number }>("SELECT COUNT(*) AS n FROM permit_fee_history WHERE project_id = 'fs-1'")[0]?.n;
  assert.equal(Number(n), 1);
});

check("MUST NOT double-count: re-reading the same summary changes nothing", () => {
  // Text extraction re-fires for any document whose text is missing, and a project view can
  // trigger it. Recording twice inflates this project AND the AHJ median every later project
  // inherits through the learned tier.
  const again = recordFeeSummary(db, project, original!);
  assert.equal(again.recorded, false);
  assert.match(again.reason, /already recorded/i);
  assert.equal(again.totalForPermitUsd, 1175.83, "the total moved on a re-read");
  const n = db.query<{ n: number }>("SELECT COUNT(*) AS n FROM permit_fee_history WHERE project_id = 'fs-1'")[0]?.n;
  assert.equal(Number(n), 1, "a second history row was written");
});

check("a REVISION ADDS to its original rather than replacing it", () => {
  // The real pair demonstrates this: the revision's summary carries only the revision's charges,
  // so what the job costs is the sum across summaries.
  const out = recordFeeSummary(db, project, revision!);
  assert.equal(out.recorded, true, out.reason);
  assert.equal(out.totalForPermitUsd, 1477.83, "1175.83 + 302.00");
  assert.equal(out.contributing.length, 2, JSON.stringify(out.contributing));
});

check("MUST EXCLUDE: a summary with no readable total records nothing", () => {
  const headless = { ...original!, totalUsd: null } as never;
  const out = recordFeeSummary(db, project, headless);
  assert.equal(out.recorded, false);
  assert.match(out.reason, /no readable TOTAL/i);
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\nfeeSummary: all checks passed."
  : `\nfeeSummary: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
