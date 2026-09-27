// ---------------------------------------------------------------------------
// THE PORTAL'S OWN FEE, READ OFF THE PAGE — one parser for every door that sees a fee.
//
// Two doors read a portal page that can print fees, and they must not disagree about what a
// fee is, so both call this module (shared/, so the backend monitor and the portal-bot review
// scraper import the same code):
//
//   1. THE FILED RECORD (the permit monitor). An Accela Citizen Access record detail page
//      (CapDetail.aspx) carries a Fees section: "Outstanding:" and "Paid:" invoice tables
//      (Date | Invoice Number | Amount) with "Total outstanding fees: $x" / "Total paid fees:
//      $y". It loads BY SCRIPT — the captured Coos Bay page reads "Print/View Summary Fees
//      Loading..." — so a plain HTTP fetch sees the placeholder and a browser must wait for it.
//   2. THE REVIEW SCREEN of a staging run, where some portals print the fee before submit.
//
// WHAT THIS NEVER DOES: turn "we could not read a fee" into a fee. Three different absences come
// back as three refusals, never as $0:
//   - not_loaded     the section is there and still says "Loading..." (a plain fetch);
//   - none_invoiced  the section loaded and lists no fee yet — an Accela record whose fees are
//                    assessed at issuance is NOT a free permit;
//   - no_fee_section / unreadable — nothing to read, or a shape we do not know.
// An unknown must not read as reassurance: $0.00 is an answer, and none of these is one.
//
// Read-only by construction: it parses text it is handed. Reading a fee is not paying it
// (hard rule 1), and nothing here can reach a portal.
//
// FIXTURE PROVENANCE (say it plainly): the Accela "Outstanding:/Paid:/Total … fees:" wording is
// ACA's documented record-detail Fees section; the LOADED markup of a Coos Bay record has not
// been captured (the one capture on file shows the Loading placeholder). A differently worded
// live section fails CLOSED here (unreadable / no_fee_section), never into a number.
// ---------------------------------------------------------------------------

export type PortalFeeLineStatus = "paid" | "outstanding" | "invoiced";

export interface PortalFeeLine {
  /** What the page calls it — "Invoice ****" on an Accela invoice row, the field label on a
   *  review screen. Digit runs masked. */
  label: string;
  amountUsd: number;
  status: PortalFeeLineStatus;
  /** As printed ("09/05/2026"), or "". */
  date: string;
}

export interface PortalFeeReading {
  lines: PortalFeeLine[];
  /** What the page says has been paid / is still owed; null when it does not say. */
  paidUsd: number | null;
  outstandingUsd: number | null;
  /** Everything invoiced so far: paid + outstanding (or, on a review screen, the printed total).
   *  Always > 0 — a reading of nothing is a refusal, not a zero. */
  totalUsd: number;
  /** The fee section itself, whitespace-collapsed, long digit runs masked, capped. Never the
   *  whole page: a record page carries the homeowner's name and address. */
  excerpt: string;
}

export type PortalFeeRefusal = "no_fee_section" | "not_loaded" | "none_invoiced" | "unreadable";

export type PortalFeeReadResult =
  | { ok: true; reading: PortalFeeReading }
  | { ok: false; reason: PortalFeeRefusal; detail: string };

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** "$1,234.56" / "$ 360.00" → 1234.56. Cents REQUIRED: a record number or a year is never a
 *  fee, and a bare integer on a record page is far more often one of those. */
const MONEY = /\$\s?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})\b/;
function money(s: string): number | null {
  const m = MONEY.exec(s);
  if (!m) return null;
  const n = Number(`${m[1].replace(/,/g, "")}.${m[2]}`);
  return Number.isFinite(n) && n >= 0 && n < 1e7 ? n : null;
}

/** Mask digit runs of 6+ (invoice, receipt, account and parcel-style numbers) — the same rule
 *  the portal-bot applies to status snippets. Dates keep their slashes, so they survive. */
export function maskLongDigits(s: string): string {
  return s.replace(/\d[\d-]{4,}\d/g, (run) => (run.replace(/\D/g, "").length >= 6 ? "****" : run));
}

const flat = (s: string): string => String(s ?? "").replace(/\s+/g, " ").trim();

// The next section heading on an ACA record page after Fees — where the fee section ends.
const ACA_NEXT_SECTION = /\b(?:Inspections|Upload\/View|Valuation Calculator|Related Records|Processing Status|Right Of Way Management|Record Details|Attachments)\b/;
const ACA_FEE_START = /Print\/View Summary Fees|\bFees\s+Outstanding:|\bOutstanding:\s*Date\b|\bTotal (?:outstanding|paid) fees:/i;
const ACA_NOTHING = /\b(?:there are no (?:outstanding |paid )?fees|no fees (?:have been|are) (?:assessed|invoiced)|no records found)\b/i;

/**
 * Read an Accela Citizen Access record page's Fees section out of the page's visible text.
 * Works on newline-separated innerText and on whitespace-collapsed text alike.
 */
export function readAccelaFeeSection(pageText: string): PortalFeeReadResult {
  const t = flat(pageText);
  const start = t.search(ACA_FEE_START);
  if (start < 0) return { ok: false, reason: "no_fee_section", detail: "The page has no Fees section." };
  const rest = t.slice(start);
  // Skip past the heading itself before looking for where the section ends.
  const headLen = Math.min(rest.length, 24);
  const endRel = rest.slice(headLen).search(ACA_NEXT_SECTION);
  const section = (endRel < 0 ? rest.slice(0, 4000) : rest.slice(0, headLen + endRel)).trim();
  const hasTables = /\b(?:Outstanding|Paid):/i.test(section) || /\bTotal (?:outstanding|paid) fees:/i.test(section);
  if (!hasTables && /\bLoading\b/i.test(section)) {
    return { ok: false, reason: "not_loaded", detail: "The Fees section is loaded by the page's script and had not loaded (\"Loading...\") — a plain fetch cannot see it." };
  }

  // Each "Outstanding:" / "Paid:" block runs to the next block (or the end of the section).
  const marks = [...section.matchAll(/\b(Outstanding|Paid):/gi)].map((m) => ({ kind: m[1].toLowerCase() as "outstanding" | "paid", at: m.index ?? 0 }));
  const lines: PortalFeeLine[] = [];
  const blockSum: Record<"outstanding" | "paid", number | null> = { outstanding: null, paid: null };
  marks.forEach((mark, i) => {
    const block = section.slice(mark.at, i + 1 < marks.length ? marks[i + 1].at : section.length);
    for (const row of block.matchAll(/(\d{1,2}\/\d{1,2}\/\d{4})\s+(\S+)\s+\$\s?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})\b/g)) {
      const amount = Number(`${row[3].replace(/,/g, "")}.${row[4]}`);
      if (!Number.isFinite(amount) || amount < 0) continue;
      lines.push({ label: maskLongDigits(`Invoice ${row[2]}`), amountUsd: round2(amount), status: mark.kind, date: row[1] });
      blockSum[mark.kind] = round2((blockSum[mark.kind] ?? 0) + amount);
    }
  });

  // The portal's own totals win over our addition of its rows — they are ITS arithmetic.
  const printed = (kind: "outstanding" | "paid"): number | null => {
    const m = new RegExp(`Total ${kind} fees:\\s*(\\$\\s?[\\d,]+\\.\\d{2})`, "i").exec(section);
    return m ? money(m[1]) : null;
  };
  const outstandingUsd = printed("outstanding") ?? blockSum.outstanding;
  const paidUsd = printed("paid") ?? blockSum.paid;
  const totalUsd = round2((outstandingUsd ?? 0) + (paidUsd ?? 0));

  if (outstandingUsd == null && paidUsd == null) {
    // Only the page's OWN words make it "nothing invoiced". Headings with rows we could not read
    // are a shape we do not know — the same refusal to price, but not the same message.
    if (ACA_NOTHING.test(section)) {
      return { ok: false, reason: "none_invoiced", detail: "The Fees section loaded and lists no fee yet — fees may be assessed later (often at issuance). Not a $0 fee." };
    }
    return { ok: false, reason: "unreadable", detail: "A Fees section is present but in a shape this reader does not know." };
  }
  if (totalUsd <= 0) {
    return { ok: false, reason: "none_invoiced", detail: "The Fees section totals $0.00 invoiced so far — fees may be assessed later (often at issuance). Not a $0 fee." };
  }
  return {
    ok: true,
    reading: { lines: lines.slice(0, 24), paidUsd, outstandingUsd, totalUsd, excerpt: maskLongDigits(section).slice(0, 600) },
  };
}

// Labels that carry money and are NOT a fee: the job's valuation is the loudest dollar figure
// on most permit pages, and reading it as a fee would quote a customer $21,383.55.
const NOT_A_FEE_LABEL = /valuation|job value|value of (?:the )?work|construction (?:cost|value)|contract|project cost|system cost|price|deposit/i;
const FEE_LABEL = /\bfees?\b|amount due|total due|balance due|payment due|total amount/i;
const TOTAL_LABEL = /\btotal\b|amount due|balance due/i;
const BODY_TOTAL = /\b(?:Total Fees?|Fee Total|Total Amount Due|Amount Due|Balance Due|Total Due)\s*:?\s*(\$\s?[\d,]+\.\d{2})/i;

/**
 * Read the fees a staging run's REVIEW SCREEN prints, from the review scraper's label/value
 * pairs and the page text. The printed total wins; otherwise the fee lines are summed.
 */
export function readReviewScreenFees(
  fields: Array<{ label: string; value: string }>,
  bodyText = "",
): PortalFeeReadResult {
  const lines: PortalFeeLine[] = [];
  let printedTotal: number | null = null;
  for (const f of fields ?? []) {
    const label = flat(f?.label ?? "");
    const value = flat(f?.value ?? "");
    if (!label || !FEE_LABEL.test(label) || NOT_A_FEE_LABEL.test(label)) continue;
    const amount = money(value);
    if (amount == null) continue;
    if (TOTAL_LABEL.test(label)) { printedTotal = printedTotal ?? amount; continue; }
    if (!lines.some((l) => l.label === label && l.amountUsd === amount)) {
      lines.push({ label: maskLongDigits(label).slice(0, 120), amountUsd: round2(amount), status: "invoiced", date: "" });
    }
  }
  if (printedTotal == null) {
    const m = BODY_TOTAL.exec(flat(bodyText));
    if (m) printedTotal = money(m[1]);
  }
  const summed = lines.length ? round2(lines.reduce((s, l) => s + l.amountUsd, 0)) : null;
  const totalUsd = printedTotal ?? summed;
  if (totalUsd == null) return { ok: false, reason: "no_fee_section", detail: "The review screen prints no fee." };
  if (totalUsd <= 0) return { ok: false, reason: "none_invoiced", detail: "The review screen prints $0.00 — recorded as no fee shown, not as a $0 fee." };
  const excerpt = [...lines.map((l) => `${l.label}: $${l.amountUsd.toFixed(2)}`), printedTotal != null ? `Total: $${printedTotal.toFixed(2)}` : ""].filter(Boolean).join(" · ");
  return { ok: true, reading: { lines: lines.slice(0, 24), paidUsd: null, outstandingUsd: null, totalUsd: round2(totalUsd), excerpt: excerpt.slice(0, 600) } };
}
