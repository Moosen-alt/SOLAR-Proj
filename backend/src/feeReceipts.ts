import { createHash } from "node:crypto";
import type { PaidFeeReceipt } from "../../shared/src/types";
import type { AppDb } from "./db";
import { nowIso } from "./time";

const dollars = (s: string | undefined): number | null => {
  if (!s) return null;
  const n = Number(s.replace(/[,$\s]/g, ""));
  return Number.isFinite(n) && n >= 0 && n < 1e7 ? n : null;
};
const money = "([\\d,]+\\.\\s*\\d{2})";
const grab = (t: string, pattern: string) => new RegExp(pattern, "i").exec(t)?.[1];

/** Narrow receipt formats with explicit payment proof and a unique identifier.
 * Invoices, quotes, bundled orders and service-fee-only emails are not totals. */
export function parsePaidFeeReceipt(raw: string): PaidFeeReceipt | null {
  const t = raw.replace(/\s+/g, " ");
  let jurisdiction = "", permitNumber = "", receiptNumber = "", paidAt = "";
  let unmatchedPermit = false;
  let amount: number | null = null, processing = 0, total: number | null = null;
  if (/Transaction Receipt/i.test(t) && /Fees Paid/i.test(t)) {
    if (!/\bOR\s+\d{5}\b|State of Oregon/i.test(t)) return null;
    const permits = [...t.matchAll(/Record ID:\s*([A-Z0-9-]+)/gi)];
    if (permits.length !== 1) return null;
    permitNumber = permits[0][1];
    receiptNumber = grab(t, "Receipt Number:\\s*(\\d+)") || "";
    paidAt = grab(t, "Receipt Date:\\s*([0-9/]+)") || "";
    const issuer = /Receipt Date:\s*[0-9/]+\s+(.+?)\s+(?:\d{2,5}\s|Community Development Dept|PO Box)/i.exec(t)?.[1] || "";
    jurisdiction = issuer.replace(/\s+(?:Building Department|Building Codes Division)$/i, "").trim();
    total = dollars(grab(t, `Receipt Total:\\s*\\$${money}`));
    amount = total;
  } else if (/City of Tigard/.test(t) && /Transaction type:\s*Purchase/i.test(t)) {
    const permits = [...t.matchAll(/Permit:\s*([A-Z0-9-]+)/gi)];
    if (permits.length !== 1) return null;
    jurisdiction = "City of Tigard"; permitNumber = permits[0][1];
    receiptNumber = grab(t, "Confirmation number:\\s*([A-Z0-9]+)") || "";
    paidAt = grab(t, "Date:\\s*([A-Za-z]+ \\d{1,2}, \\d{4})") || "";
    amount = dollars(grab(t, `Subtotal\\s*\\$${money}`));
    processing = dollars(grab(t, `Processing fee\\s*\\$${money}`)) ?? 0;
    total = dollars(grab(t, `(?<![a-z])Total\\s*\\$${money}`));
  } else if (/City of Newberg, OR/.test(t) && /Total paid/i.test(t)) {
    const permits = [...new Set([...t.matchAll(/\b(BLD-\d{2}-\d+)\b/g)].map(m => m[1]))];
    if (permits.length !== 1 || !/No processing fees/i.test(t)) return null;
    jurisdiction = "City of Newberg"; permitNumber = permits[0];
    // The extractor may render "Receipt number # 2895" with a space after the
    // hash — same printed receipt, different text-run spacing.
    receiptNumber = grab(t, "Receipt number\\s*#\\s*(\\d+)") || "";
    paidAt = grab(t, "([A-Za-z]+ \\d{1,2}, \\d{4})") || "";
    amount = total = dollars(grab(t, `Total paid\\s*\\$${money}`));
  } else if (/permits\.cityofsalem\.net/.test(t) && /Payment Receipt/i.test(t)) {
    const permits = [...new Set([...t.matchAll(/(?<!\d)(\d{2}-\d{6}-\d{2}-(?:DW|E))\b/g)].map(m => m[1]))];
    if (permits.length !== 1) return null;
    jurisdiction = "City of Salem"; permitNumber = permits[0];
    receiptNumber = /\b(\d{8})\s+[A-Za-z]+ \d{1,2}, \d{4}/.exec(t)?.[1] || "";
    paidAt = grab(t, "([A-Za-z]+ \\d{1,2}, \\d{4})") || "";
    amount = total = dollars(grab(t, `Total Paid\\s*:\\s*(?:Please Note:\\s*)?\\$${money}`));
  } else if (/washingtoncountyor\.gov/.test(t) && /Your application has been submitted/i.test(t)) {
    jurisdiction = "Washington County";
    permitNumber = grab(t, "Request Number:\\s*([A-Z0-9-]+)") || "";
    receiptNumber = grab(t, "Approval #:\\s*(\\d+)") || "";
    paidAt = grab(t, "Signature Date:\\s*([0-9/]+)") || "";
    amount = total = dollars(grab(t, `Amount:\\s*\\$${money}`));
  } else if (/Your payment has been approved/i.test(t) && /Total of all charges and fees/i.test(t)
    && /Profile Name CITY OF BEAVERTON PERMITS Transaction Type/i.test(t)) {
    // Some exports bundle a processor-only email before the actual payment.
    // Read the authority transaction, never the first dollar amount in the PDF.
    const main = t.slice(t.search(/Profile Name CITY OF BEAVERTON PERMITS Transaction Type/i));
    jurisdiction = "City of Beaverton";
    receiptNumber = grab(main, "(?<!Fee )Transaction ID\\s*([A-Z0-9-]+)") || "";
    // A transaction ID that wraps across lines arrives, after whitespace
    // normalisation, as "050526C1C-BC3ACA70-84CC-45F1- 9C11- 2E9019ED21CD".
    // A chunk ending in "-" is a wrap point, not the end of the identity — and
    // this string is the dedupe key, so it must not depend on where the PDF
    // happened to break the line. Continuations join case-SENSITIVELY and must
    // carry a digit, so a following heading ("Approval Code") is never swallowed.
    if (receiptNumber.endsWith("-")) {
      const run = /(?<!Fee )Transaction ID\s*((?:[A-Z\d-]+ )*[A-Z\d-]+(?![a-z]))/.exec(main)?.[1];
      if (run && run.startsWith(receiptNumber)) {
        for (const chunk of run.split(" ").slice(1)) {
          if (!receiptNumber.endsWith("-") || !/\d/.test(chunk)) break;
          receiptNumber += chunk;
        }
      }
    }
    paidAt = grab(main, "(?<!Fee )Transaction Date/Time\\s*([0-9/]+)") || "";
    amount = dollars(grab(main, `(?<![a-z])Amount\\s*\\$${money}`));
    processing = dollars(grab(main, `Service Fee\\s*\\$${money}`)) ?? 0;
    total = dollars(grab(main, `Total of all charges and fees\\s*\\$${money}`));
    // Printed Application ID values such as "1"/"1234" are not a permit
    // identity. Keep the payment unlinked until an operator reconciles it.
    unmatchedPermit = true;
  } else return null;
  if (!jurisdiction || (!permitNumber && !unmatchedPermit) || !receiptNumber || !paidAt || amount == null || total == null
    || Math.abs(amount + processing - total) > 0.015) return null;
  const discipline = /(?:-ELEC|-E)$|^REP/i.test(permitNumber) ? "electrical"
    : /(?:-STR|-DW)$|^BLD/i.test(permitNumber) ? "building" : "unknown";
  return { jurisdiction, permitNumber, receiptNumber, discipline, authorityAmountUsd: amount,
    processingFeeUsd: processing, totalPaidUsd: total, paidAt };
}

/** Store components under a source namespace excluded from whole-filing quotes.
 * Stable jurisdiction/receipt/permit identity deduplicates differently named PDFs.
 * No customer name, address, payment instrument or raw receipt text is shared. */
export function recordPaidFeeReceipt(db: AppDb, receipt: PaidFeeReceipt, projectId: string | null = null) {
  const key = createHash("sha256").update(`${receipt.jurisdiction.toLowerCase()}|${receipt.receiptNumber}|${receipt.permitNumber}`).digest("hex");
  const id = `receipt-${key}`;
  const source = `receipt_component:${JSON.stringify(receipt)}`;
  const prior = db.get<{ source: string }>("SELECT source FROM permit_fee_history WHERE id = ?", [id]);
  if (prior) return { recorded: false, reason: prior.source === source ? "duplicate receipt" : "conflicting receipt; review required" };
  const amounts = [receipt.authorityAmountUsd, receipt.processingFeeUsd, receipt.otherFeeUsd ?? 0, receipt.totalPaidUsd];
  if (!receipt.jurisdiction || !receipt.receiptNumber || !receipt.paidAt || amounts.some(n => !Number.isFinite(n) || n < 0)
    || Math.abs(amounts[0] + amounts[1] + amounts[2] - amounts[3]) > 0.015) throw new Error("Receipt amounts or identity are inconsistent.");
  db.run("INSERT INTO permit_fee_history(id,state,ahj,utility,track,fee_usd,source,project_id,recorded_at) VALUES(?, 'OR', ?, '', 'permit', ?, ?, ?, ?)",
    [id, receipt.jurisdiction, receipt.authorityAmountUsd, source, projectId, nowIso()]);
  // L5: a paid receipt is evidence about the seeded schedule for its jurisdiction. Hold it up
  // against that schedule and, where they disagree, raise ONE deduped operator review item —
  // never a schedule change (rule 3). Lazy import (feeSchedules is heavy and sits in a cycle-
  // prone neighbourhood); best-effort, a receipt is recorded whatever the comparison says.
  void import("./feeSchedules").then((fees) => {
    const report = fees.reconcileReceiptsWithSchedules(db);
    const touched = report.results.filter((r) => r.receipts.some((x) => x.jurisdiction === receipt.jurisdiction.replace(/\s+/g, " ").trim()));
    fees.raiseReceiptContradictionReviews(db, { ...report, results: touched });
  }).catch(() => null);
  return { recorded: true, reason: "Paid component recorded; excluded from whole-filing estimates." };
}

export function paidFeeReceiptsForProject(db: AppDb, projectId: string): PaidFeeReceipt[] {
  return db.query<{ source: string }>("SELECT source FROM permit_fee_history WHERE project_id = ? AND source LIKE 'receipt_component:%' ORDER BY recorded_at", [projectId])
    .flatMap(row => { try { return [JSON.parse(row.source.slice(18)) as PaidFeeReceipt]; } catch { return []; } });
}
