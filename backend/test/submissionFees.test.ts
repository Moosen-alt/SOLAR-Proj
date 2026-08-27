// Per-submission payment gate: quote = permit fees (actual > learned history >
// valuation estimate) + client service fee; staging blocked (402) for
// per-submission clients until paid/waived; real fees teach future quotes.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "submission-fees-test-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  process.env.SUBMISSION_SERVICE_FEE_USD = "100";
  const { openDatabase } = await import("../src/db");
  const { createClient } = await import("../src/clients");
  const {
    buildPaymentQuote, markSubmissionPaid, waiveSubmissionPayment,
    assertSubmissionPaid, recordActualPermitFee,
  } = await import("../src/submissionFees");
  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   ${name}`);
  };

  const client = createClient(db, { companyName: "PerSub Solar", billingMode: "per_submission", serviceFeeUsd: "175" });
  const freeClient = createClient(db, { companyName: "Monthly Solar", billingMode: "monthly" });

  const now = new Date().toISOString();
  const mkProject = (id: string, clientId: string | null): void => {
    db.run(
      `INSERT INTO projects (id, client_id, homeowner_name, state, ahj, utility, system_size_dc_kw, status, parser_json, created_at, updated_at)
       VALUES (?, ?, 'Test Owner', 'OR', 'City of Woodburn', 'PGE', 10.12, 'ready_to_stage', '{}', ?, ?)`,
      [id, clientId, now, now],
    );
  };
  mkProject("proj-1", client.id);
  mkProject("proj-2", client.id);
  mkProject("proj-3", freeClient.id);
  const project = (id: string) => ({
    id, clientId: id === "proj-3" ? freeClient.id : client.id,
    state: "OR", ahj: "City of Woodburn", utility: "PGE",
    systemSizeDcKw: 10.12, parserSnapshot: {},
  }) as never;

  // 1. Quote: valuation estimate (10.12 kW × $3/W = $30,360 × 1.5% = $455.40) + $175 fee.
  const q1 = buildPaymentQuote(db, project("proj-1"), "permit");
  check("quote required for per-submission client", q1.required === true);
  check("permit fee from valuation estimate", q1.permitFeeSource === "valuation_estimate" && q1.permitFeeUsd === 455.4, JSON.stringify(q1.permitFeeUsd));
  check("client service fee used over env default", q1.serviceFeeUsd === 175);
  check("total = permit + service", q1.totalUsd === 630.4, JSON.stringify(q1.totalUsd));

  // 2. Gate blocks unpaid, then clears on mark-paid with the REAL portal fee.
  let blocked = false;
  try { assertSubmissionPaid(db, project("proj-1"), "permit"); } catch (err) {
    blocked = (err as { status?: number }).status === 402;
  }
  check("staging gate throws 402 while unpaid", blocked);
  const paidQuote = markSubmissionPaid(db, project("proj-1"), "permit", { paymentReference: "INV-1001", actualPermitFeeUsd: "287.50" });
  check("mark-paid uses actual fee", paidQuote.permitFeeSource === "actual" && paidQuote.permitFeeUsd === 287.5);
  check("paid total = actual + service", paidQuote.totalUsd === 462.5, JSON.stringify(paidQuote.totalUsd));
  check("payment row is paid with reference", paidQuote.payment?.status === "paid" && paidQuote.payment.paymentReference === "INV-1001");
  let passes = true;
  try { assertSubmissionPaid(db, project("proj-1"), "permit"); } catch { passes = false; }
  check("gate passes after payment", passes);

  // 3. The real fee teaches future quotes for the same AHJ (fuzzy name).
  db.run("UPDATE projects SET ahj = 'Woodburn' WHERE id = 'proj-2'");
  const q2 = buildPaymentQuote(db, { ...(project("proj-2") as object), ahj: "Woodburn" } as never, "permit");
  check("next project quotes from learned fee history", q2.permitFeeSource === "learned_history" && q2.permitFeeUsd === 287.5, `${q2.permitFeeSource} ${q2.permitFeeUsd}`);

  // 4. Waive clears the gate without payment; monthly clients are never gated.
  waiveSubmissionPayment(db, project("proj-2"), "permit");
  let waivedPasses = true;
  try { assertSubmissionPaid(db, project("proj-2"), "permit"); } catch { waivedPasses = false; }
  check("waive clears the gate", waivedPasses);
  const q3 = buildPaymentQuote(db, project("proj-3"), "permit");
  check("monthly client not gated", q3.required === false);
  let freePasses = true;
  try { assertSubmissionPaid(db, project("proj-3"), "permit"); } catch { freePasses = false; }
  check("monthly client passes gate", freePasses);

  // 5. NEM track quotes independently; record-fee true-up without paying.
  const nemQuote = buildPaymentQuote(db, project("proj-1"), "nem");
  check("nem track has its own quote", nemQuote.track === "nem" && nemQuote.payment?.status === "quoted");
  const trueUp = recordActualPermitFee(db, project("proj-1"), "nem", 50, "operator");
  check("nem true-up records actual without paying", trueUp.permitFeeUsd === 50 && trueUp.payment?.status === "quoted");

  // Close before deleting the scratch DB - Windows holds the open handle as a file lock (EBUSY).
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log("\nsubmissionFees: all checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
