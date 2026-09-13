// AN ESTIMATE IS NOT AN INVOICE, AND ONLY OUR OWN MONEY IS RECOVERABLE.
//
// A per-project invoice states what the solar company owes us. Two kinds of money, kept
// apart because a bookkeeper treats them differently:
//   REIMBURSEMENT — a jurisdiction fee WE advanced ('keelix-pays') and re-bill at cost.
//   SERVICE       — our own per-submission fee. Revenue.
//
// The ways this goes wrong are all quiet ones, so each has a case here:
//
//   MUST PASS    — a recorded ACTUAL fee under a 'keelix-pays' agreement invoices, with the
//                  published schedule's per-authority split shown beneath it (one rooftop can
//                  owe a city and a county separately, and the sum is a number no schedule
//                  contains); a per-submission client is charged its service fee; the two
//                  totals are reported SEPARATELY.
//   MUST EXCLUDE — an ESTIMATE is never invoiced, and appears in notInvoiceable saying so;
//                  a fee the customer settled themselves is not ours to recover; an
//                  unrecorded agreement never defaults to reimbursable; a WAIVED submission
//                  invoices nothing; a monthly-billed client is not charged per submission;
//                  and asking for an invoice WRITES NOTHING.
//
//   npx tsx backend/test/projectInvoice.test.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ProjectRecord } from "../../shared/src/types";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-invoice-test-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  process.env.SUBMISSION_SERVICE_FEE_USD = "100";
  process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";
  const { openDatabase } = await import("../src/db");
  const { createClient } = await import("../src/clients");
  const { createPortalCredential } = await import("../src/portalCredentials");
  const { buildPaymentQuote, recordActualPermitFee, waiveSubmissionPayment } = await import("../src/submissionFees");
  const { buildProjectInvoice } = await import("../src/invoices");
  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   ${name}`);
  };

  const perSub = createClient(db, { companyName: "PerSub Solar", billingMode: "per_submission", serviceFeeUsd: "175" });
  const monthly = createClient(db, { companyName: "Monthly Solar", billingMode: "monthly", serviceFeeUsd: "175" });

  // The agreement lives on the credential. Only 'keelix-pays' means we advanced the money.
  const PORTAL = "https://aca-oregon.accela.com/oregon/";
  createPortalCredential(db, perSub.id, {
    portalUrl: PORTAL, username: "u", password: "p", feeResponsibility: "keelix-pays",
  });
  createPortalCredential(db, monthly.id, {
    portalUrl: PORTAL, username: "u", password: "p", feeResponsibility: "customer-pays",
  });

  const now = new Date().toISOString();
  let n = 0;
  const mkProject = (clientId: string, acKw: number | null): ProjectRecord => {
    const pid = `inv-${++n}`;
    db.run(
      `INSERT INTO projects (id, client_id, homeowner_name, state, ahj, utility, system_size_dc_kw, system_size_ac_kw, status, parser_json, created_at, updated_at)
       VALUES (?, ?, 'Test Owner', 'OR', 'City of Coos Bay', 'Pacific Power', ?, ?, 'ready_to_stage', '{}', ?, ?)`,
      [pid, clientId, acKw == null ? null : acKw * 1.3, acKw, now, now],
    );
    return {
      id: pid, clientId, state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power",
      systemSizeDcKw: acKw == null ? null : acKw * 1.3, systemSizeAcKw: acKw, totalExportKw: null,
      homeownerName: "Test Owner", parserSnapshot: {},
    } as unknown as ProjectRecord;
  };

  // ---------------------------------------------------------------------
  // 1. THE HEADLINE: an actual fee we advanced, invoiced with its split.
  // ---------------------------------------------------------------------
  const paid = mkProject(perSub.id, 9);
  recordActualPermitFee(db, paid, "permit", 360);
  const inv = buildProjectInvoice(db, paid);
  const reimb = inv.lines.filter((l) => l.kind === "reimbursement");
  const service = inv.lines.filter((l) => l.kind === "service");

  check("a recorded ACTUAL fee under 'keelix-pays' is invoiced at cost",
    reimb.length === 1 && reimb[0].amountUsd === 360,
    `${reimb.length} line(s): ${JSON.stringify(reimb.map((l) => l.amountUsd))}`);
  check("the agreement was STAMPED at record time, not read live",
    reimb.length === 1 && reimb[0].recordedAt !== "",
    "an invoice that resolves reimbursability from today's credential rewrites history");
  check("a per-submission client is charged its service fee",
    service.length === 1 && service[0].amountUsd === 175, JSON.stringify(service.map((l) => l.amountUsd)));
  check("THE SPLIT: reimbursement and service are separate totals, never one number",
    inv.reimbursementTotalUsd === 360 && inv.serviceTotalUsd === 175
    && !Object.prototype.hasOwnProperty.call(inv, "totalUsd"),
    `reimbursement=${inv.reimbursementTotalUsd} service=${inv.serviceTotalUsd}`);

  // ---------------------------------------------------------------------
  // 2. MUST EXCLUDE — the quiet ways an invoice goes wrong.
  // ---------------------------------------------------------------------
  // A JURISDICTION WITH NO PUBLISHED SCHEDULE, so this case cannot change meaning if somebody
  // reorders the file. Section 3b below saves a Coos Bay schedule; a Coos Bay project here would
  // then legitimately produce a PROVISIONAL line and this check would fail for a reason that has
  // nothing to do with what it is named after. The subject is the valuation heuristic, so the
  // fixture must be a place where the heuristic is the only number available.
  const estimated = mkProject(perSub.id, 9);
  db.run("UPDATE projects SET ahj = 'City of No Schedule' WHERE id = ?", [estimated.id]);
  (estimated as unknown as { ahj: string }).ahj = "City of No Schedule";
  buildPaymentQuote(db, estimated, "permit");   // a QUOTE, not a payment
  // THE ESTIMATE RULE MUST STAND ON ITS OWN. A quote row never carries an agreement (only
  // recording the real fee stamps one), so without this the "no agreement" guard catches the
  // row first and the estimate rule is never the thing under test — measured: sabotage the
  // estimate rule and this block stayed green, protected by a different rule entirely. Stamping
  // an agreement onto a row that still has no ACTUAL leaves the estimate rule as the only thing
  // between a quote and an invoice.
  db.run("UPDATE submission_payments SET fee_responsibility = 'keelix-pays' WHERE project_id = ?", [estimated.id]);
  const estInv = buildProjectInvoice(db, estimated);
  check("MUST EXCLUDE: an ESTIMATE is never invoiced, even WITH an agreement on file",
    estInv.reimbursementTotalUsd === 0 && !estInv.lines.some((l) => l.kind === "reimbursement"),
    `reimbursement total ${estInv.reimbursementTotalUsd} — billing an estimate charges a company for a number nobody paid`);
  check("  …and it is REPORTED as not invoiceable, not silently dropped",
    estInv.notInvoiceable.some((x) => /estimate/i.test(x.reason) && /record real fee|fee\/review screen/i.test(x.resolution)),
    JSON.stringify(estInv.notInvoiceable.map((x) => x.reason)));

  const theirs = mkProject(monthly.id, 9);
  recordActualPermitFee(db, theirs, "permit", 360);
  const theirsInv = buildProjectInvoice(db, theirs);
  check("MUST EXCLUDE: a fee the CUSTOMER settled is not ours to recover",
    theirsInv.reimbursementTotalUsd === 0,
    `invoiced $${theirsInv.reimbursementTotalUsd} of somebody else's money`);
  check("  …and the reason says who settled it",
    theirsInv.notInvoiceable.some((x) => /not advanced by us|customer/i.test(x.reason)),
    JSON.stringify(theirsInv.notInvoiceable.map((x) => x.reason)));
  check("MUST EXCLUDE: a MONTHLY-billed client is not charged a per-submission service fee",
    theirsInv.serviceTotalUsd === 0 && theirsInv.notInvoiceable.some((x) => /monthly/i.test(x.reason)),
    `service total ${theirsInv.serviceTotalUsd}`);

  // A client with NO agreement on file at all: the fee is real, the permission is not.
  const noAgreement = createClient(db, { companyName: "Unagreed Solar", billingMode: "per_submission", serviceFeeUsd: "175" });
  const unagreed = mkProject(noAgreement.id, 9);
  recordActualPermitFee(db, unagreed, "permit", 360);
  const unagreedInv = buildProjectInvoice(db, unagreed);
  check("MUST EXCLUDE: an unrecorded agreement NEVER defaults to reimbursable",
    unagreedInv.reimbursementTotalUsd === 0,
    `billed $${unagreedInv.reimbursementTotalUsd} under an agreement nobody made`);
  check("  …and it points at the credential (guide S3.7), which is where the answer goes",
    unagreedInv.notInvoiceable.some((x) => /S3\.7|credential/i.test(x.resolution)),
    JSON.stringify(unagreedInv.notInvoiceable.map((x) => x.resolution)));

  const waived = mkProject(perSub.id, 9);
  recordActualPermitFee(db, waived, "permit", 360);
  waiveSubmissionPayment(db, waived, "permit");
  const waivedInv = buildProjectInvoice(db, waived);
  check("MUST EXCLUDE: a WAIVED submission invoices nothing",
    waivedInv.reimbursementTotalUsd === 0 && waivedInv.serviceTotalUsd === 0
    && waivedInv.notInvoiceable.some((x) => /waiv/i.test(x.reason)),
    `reimb=${waivedInv.reimbursementTotalUsd} service=${waivedInv.serviceTotalUsd}`);

  // ---------------------------------------------------------------------
  // 3. ASKING MUST NOT WRITE. buildPaymentQuote persists a row as a side effect of being
  //    called; an invoice that did the same would conjure the thing it claims to report.
  // ---------------------------------------------------------------------
  const untouched = mkProject(perSub.id, 9);
  const before = db.query<{ n: number }>("SELECT COUNT(*) AS n FROM submission_payments")[0]?.n;
  const emptyInv = buildProjectInvoice(db, untouched);
  const after = db.query<{ n: number }>("SELECT COUNT(*) AS n FROM submission_payments")[0]?.n;
  check("MUST EXCLUDE: building an invoice writes NOTHING",
    Number(before) === Number(after), `rows went ${before} -> ${after}`);
  check("  …and a project with no payment row says so rather than reporting $0 owed",
    emptyInv.lines.length === 0 && emptyInv.notInvoiceable.some((x) => /no submission payment/i.test(x.reason)),
    JSON.stringify(emptyInv.notInvoiceable.map((x) => x.reason)));

  // ---------------------------------------------------------------------
  // 3b. A PUBLISHED SCHEDULE MAY BILL; A GUESS MAY NOT.
  //
  // Waiting for somebody to type the portal's figure means a company is not billed for weeks,
  // for money we already advanced. The jurisdiction's own schedule — bracketed to this project,
  // carrying the document it was read from — carries the line instead, marked PROVISIONAL. What
  // stays out is the rung below it in the quote ladder: 1.5% of contract value. On the live
  // project this was first run against, that heuristic said $435.99 where the county's schedule
  // says $360 — a 21% error on money being re-billed.
  // ---------------------------------------------------------------------
  const { saveFeeSchedule } = await import("../src/feeSchedules");
  saveFeeSchedule(db, { state: "OR", ahj: "City of Coos Bay", track: "permit", discipline: "structural" }, {
    found: true, reason: "", basis: "flat",
    brackets: [{ feeUsd: 200, label: "Prescriptive path system (includes plan review)" }],
    notes: "", sourceUrl: "https://www.coosbayor.gov/fees.pdf",
    sourceQuote: "Solar Permit (when required) – Prescriptive Path System | $200.00",
    sourceKind: "official",
  });

  const schedOnly = mkProject(perSub.id, 9);
  buildPaymentQuote(db, schedOnly, "permit");
  db.run("UPDATE submission_payments SET fee_responsibility = 'keelix-pays' WHERE project_id = ?", [schedOnly.id]);
  const schedInv = buildProjectInvoice(db, schedOnly);
  const provisional = schedInv.lines.filter((l) => l.kind === "reimbursement" && l.provisional);
  check("a PUBLISHED schedule carries the line when no portal figure is recorded yet",
    provisional.length === 1 && provisional[0].amountUsd === 200 && provisional[0].basis === "published",
    `${provisional.length} line(s): ${JSON.stringify(provisional.map((l) => [l.amountUsd, l.basis]))}`);
  check("  …and it is marked PROVISIONAL, carrying the document it was read from",
    provisional.length === 1 && provisional[0].provisional === true
    && provisional[0].composition.some((c) => /coosbayor\.gov/.test(c.sourceUrl)),
    JSON.stringify(provisional.map((l) => l.composition.map((c) => c.sourceUrl))));

  // THE GUESS. Same shape, but a jurisdiction with no schedule on file — so the only number
  // available is the valuation heuristic, which must not reach an invoice.
  const guessOnly = mkProject(perSub.id, 9);
  db.run("UPDATE projects SET ahj = 'City of Nowhere At All' WHERE id = ?", [guessOnly.id]);
  const guessProject = { ...(guessOnly as object), ahj: "City of Nowhere At All" } as unknown as ProjectRecord;
  buildPaymentQuote(db, guessProject, "permit");
  db.run("UPDATE submission_payments SET fee_responsibility = 'keelix-pays' WHERE project_id = ?", [guessOnly.id]);
  const guessInv = buildProjectInvoice(db, guessProject);
  check("MUST EXCLUDE: the VALUATION HEURISTIC never bills, even under an agreement",
    guessInv.reimbursementTotalUsd === 0,
    `billed $${guessInv.reimbursementTotalUsd} from a percentage that has never read a fee table`);
  check("  …and the reason says it is a heuristic, not that a fee is merely unrecorded",
    guessInv.notInvoiceable.some((x) => /heuristic/i.test(x.reason)),
    JSON.stringify(guessInv.notInvoiceable.map((x) => x.reason)));

  // A RECORDED FIGURE SUPERSEDES, never doubles.
  const trued = mkProject(perSub.id, 9);
  buildPaymentQuote(db, trued, "permit");
  db.run("UPDATE submission_payments SET fee_responsibility = 'keelix-pays' WHERE project_id = ?", [trued.id]);
  recordActualPermitFee(db, trued, "permit", 214.5);
  const truedInv = buildProjectInvoice(db, trued);
  const truedLines = truedInv.lines.filter((l) => l.kind === "reimbursement");
  check("a recorded figure SUPERSEDES the schedule — one line, not two",
    truedLines.length === 1 && truedLines[0].amountUsd === 214.5
    && truedLines[0].basis === "recorded" && truedLines[0].provisional === false,
    `${truedLines.length} line(s): ${JSON.stringify(truedLines.map((l) => [l.amountUsd, l.basis]))}`);
  check("  …and the difference from the schedule is REPORTED, not hidden",
    truedLines.length === 1 && /schedule adds up to \$200\.00/.test(truedLines[0].reconciliation),
    JSON.stringify(truedLines.map((l) => l.reconciliation)));

  // ---------------------------------------------------------------------
  // 3c. AN INVOICE NEEDS AN ADDRESSEE. The guide's S3.7 asks for one by name — "Billing
  //     contact: who receives Keelix invoices" — and migration v18 stores it in a column
  //     ClientRecord does not expose, so it was collected and never read.
  // ---------------------------------------------------------------------
  const billed = createClient(db, { companyName: "Billed Solar", billingMode: "per_submission", serviceFeeUsd: "175", businessEmail: "ops@general.test" });
  db.run("UPDATE clients SET billing_contact_email = ? WHERE id = ?", ["ap@accounts.test", billed.id]);
  const billedProject = mkProject(billed.id, 9);
  recordActualPermitFee(db, billedProject, "permit", 360);
  const billedInv = buildProjectInvoice(db, billedProject);
  check("the invoice is addressed to the BILLING CONTACT from the intake packet",
    billedInv.billTo === "ap@accounts.test" && billedInv.billToSource === "billing_contact",
    `${billedInv.billTo} (${billedInv.billToSource})`);

  const noBilling = createClient(db, { companyName: "No AP Solar", billingMode: "per_submission", serviceFeeUsd: "175", businessEmail: "ops@fallback.test" });
  const noBillingProject = mkProject(noBilling.id, 9);
  recordActualPermitFee(db, noBillingProject, "permit", 360);
  const fallbackInv = buildProjectInvoice(db, noBillingProject);
  check("  …and falls back to the business email, SAYING that is what it did",
    fallbackInv.billTo === "ops@fallback.test" && fallbackInv.billToSource === "business_email",
    `${fallbackInv.billTo} (${fallbackInv.billToSource})`);

  // ---------------------------------------------------------------------
  // 4. Both tracks reach the same invoice.
  // ---------------------------------------------------------------------
  const both = mkProject(perSub.id, 9);
  recordActualPermitFee(db, both, "permit", 360);
  recordActualPermitFee(db, both, "nem", 50);
  const bothInv = buildProjectInvoice(db, both);
  check("permit and NEM both appear, each as its own line",
    bothInv.reimbursementTotalUsd === 410
    && bothInv.lines.filter((l) => l.kind === "reimbursement").length === 2,
    `total ${bothInv.reimbursementTotalUsd} across ${bothInv.lines.length} line(s)`);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) { console.error(`\n${failures} project-invoice check(s) FAILED.`); process.exit(1); }
  console.log("\nprojectInvoice: all checks passed.");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
