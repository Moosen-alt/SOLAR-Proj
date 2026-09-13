// ---------------------------------------------------------------------------
// THE PORTAL ALREADY TELLS US WHAT THE PERMIT COST. READ IT.
//
// The quote ladder's top two rungs are `actual` (a figure a person typed off the portal's fee
// screen) and `learned_history` (the median of real fees seen for this AHJ). Both were EMPTY —
// permit_fee_history has 0 rows and no submission_payment carries an actual — so every quote
// fell to a published schedule or, worse, 1.5% of valuation. Meanwhile Portland issues a
// "Billing Summary" PDF for every permit, and those PDFs were already being attached to projects
// and text-extracted. The number was sitting in the database the whole time, unread.
//
// MEASURED ON TWO REAL ONES:
//
//   26-041592-000-00-RS   2026-07-31   TOTAL $1,175.83
//     141  Building Permit St. Sur.              $31.94     <- 12.0% of the line above it
//     171  Building Permit RS                   $266.15
//     144  Electrical Permit St Sur              $33.96     <- 12.0% again
//     173  Electrical Permit RS                 $283.00     <- the only line our schedule knows
//     120  Zoning Inspection Fee                $119.00
//     2468 Development Services Fee - RS         $51.78
//     244  Land Use Plan Review Res             $217.00
//     2485 Bldg Plan Rvw/Processing RS/MI/MP    $173.00
//
// We would have quoted $283 — 24% of the bill. No bracket table reaches $1,175.83, because the
// cost is a LIST of components and only one of them is size-bracketed. Reading the summary
// sidesteps the whole modelling problem: the authority has already done the arithmetic.
//
// A REVISION IS ADDITIONAL, NOT A REPLACEMENT. The second real summary is
// 26-050978-REV-01-RS, $302.00, carrying only its own two lines (Fire Plan Review, Bldg Plan
// Rvw/Processing). The original permit's summary is a separate document with its own total, so
// what the job costs is the SUM across summaries for one permit — which is why each is recorded
// under its own permit number and why re-reading one cannot double-count it.
// ---------------------------------------------------------------------------
import type { AppDb } from "./db";
import type { ProjectRecord } from "../../shared/src/types";
import { id } from "./ids";
import { text } from "./json";
import { nowIso } from "./time";
import { logger } from "./logger";

export interface FeeSummaryLine {
  /** The authority's own fee code ("173"), which is how they will discuss it on the phone. */
  code: string;
  description: string;
  amountUsd: number;
}

export interface FeeSummary {
  authority: string;
  /** As printed, revision suffix and all: "26-050978-REV-01-RS". */
  permitNumber: string;
  /** The permit without its revision/sequence tail, so revisions group with their original. */
  basePermitNumber: string;
  /** "REV-01" when this is a revision's own bill, else "". */
  revision: string;
  /** The summary's own date, ISO, or "" when it did not print one. */
  issuedAt: string;
  lines: FeeSummaryLine[];
  totalUsd: number | null;
  balanceUsd: number | null;
  /** Non-empty when the printed TOTAL does not match the line items — a question, not a fact. */
  reconciliation: string;
}

const MONEY = /\$\s*([\d,]+\.\d{2})/;
const money = (s: string): number | null => {
  const m = MONEY.exec(s);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Does this text look like an authority's billing summary at all? Deliberately strict: a plan
 *  set full of dollar amounts must not be mistaken for a bill. */
function looksLikeFeeSummary(t: string): boolean {
  const hasHeading = /\b(billing|fee)\s+summary\b/i.test(t);
  const hasFeeTable = /fee\s*code\s+fee\s*description/i.test(t) || /\bsub\s*total\b/i.test(t);
  const hasTotal = /\btotal\b/i.test(t);
  return hasHeading && hasFeeTable && hasTotal;
}

/**
 * Parse an authority's billing summary out of extracted PDF text. Returns null when the document
 * is not one — that refusal is load-bearing, because this runs over every document a project has.
 */
export function parseFeeSummary(raw: string): FeeSummary | null {
  const t = String(raw ?? "");
  if (!looksLikeFeeSummary(t)) return null;

  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const permitNumber = (/permit\s*number:\s*([A-Za-z0-9][A-Za-z0-9\-.]*)/i.exec(t) || [])[1] || "";
  // "26-050978-REV-01-RS" -> base "26-050978", revision "REV-01". The tail after the base is a
  // sequence/type code the authority uses; grouping on the base is what makes a revision add to
  // its original rather than look like a different permit.
  const baseMatch = /^(\d{2}-\d{4,8})/.exec(permitNumber);
  const basePermitNumber = baseMatch ? baseMatch[1] : permitNumber;
  const revMatch = /(REV-?\d+)/i.exec(permitNumber);
  const revision = revMatch ? revMatch[1].toUpperCase() : "";

  const dateStr = (/today'?s\s*date:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(t) || [])[1] || "";
  let issuedAt = "";
  if (dateStr) {
    const [mm, dd, yyyy] = dateStr.split("/").map((x) => Number(x));
    if (yyyy && mm && dd) issuedAt = new Date(Date.UTC(yyyy, mm - 1, dd)).toISOString();
  }

  // The authority's name, from the header block. Portland prints "CITY OF / PORTLAND, OREGON".
  let authority = "";
  const cityIdx = lines.findIndex((l) => /^city of$/i.test(l));
  if (cityIdx >= 0 && lines[cityIdx + 1]) {
    // Printed in caps on the letterhead ("PORTLAND, OREGON"); title-cased so it matches the way
    // the AHJ is written everywhere else and fuzzy name matching has a fair chance.
    const name = String(lines[cityIdx + 1]).replace(/,.*$/, "").trim().toLowerCase()
      .replace(/\b[a-z]/g, (c) => c.toUpperCase());
    authority = `City of ${name}`;
  }
  if (!authority) authority = (/^(city|county|town|village)\s+of\s+[A-Za-z .'-]+/im.exec(t) || [])[0] || "";

  // FEE LINES: "<code> <description> $<amount>". Subtotals and the grand total are excluded —
  // adding a subtotal to its own components is how a bill doubles.
  const items: FeeSummaryLine[] = [];
  for (const line of lines) {
    if (/\bsub\s*total\b/i.test(line) || /^\**\s*total\b/i.test(line)) continue;
    const m = /^\**\s*(\d{2,5})\s+(.+?)\s*\$\s*([\d,]+\.\d{2})\s*$/.exec(line);
    if (!m) continue;
    const amount = Number(m[3].replace(/,/g, ""));
    if (!Number.isFinite(amount)) continue;
    items.push({ code: m[1], description: m[2].trim(), amountUsd: amount });
  }

  // THE GRAND TOTAL, and it is usually not on the same line as the word. Coordinate extraction
  // puts "TOTAL" on its own row and the three figures beneath it, so look at the word's line
  // first and then the next one.
  let totalUsd: number | null = null;
  let balanceUsd: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\**\s*total\b/i.test(lines[i])) continue;
    const here = lines[i].replace(/^\**\s*total\b/i, "");
    const candidates = [here, lines[i + 1] ?? ""].join(" ");
    const all = candidates.match(/\$\s*[\d,]+\.\d{2}/g) || [];
    if (!all.length) continue;
    totalUsd = money(all[0] ?? "");
    balanceUsd = money((all.length >= 3 ? all[2] : all[all.length - 1]) ?? "");
    break;
  }

  let reconciliation = "";
  if (totalUsd != null && items.length) {
    const sum = round2(items.reduce((a, b) => a + b.amountUsd, 0));
    if (sum !== round2(totalUsd)) {
      reconciliation = `The printed TOTAL is $${totalUsd.toFixed(2)} and the ${items.length} fee lines add up to `
        + `$${sum.toFixed(2)}. The TOTAL is what the authority says is owed; the difference usually means a `
        + `line did not survive text extraction, so check the PDF before treating the breakdown as complete.`;
    }
  }

  if (totalUsd == null && !items.length) return null;   // shaped like a bill, but nothing readable in it
  return { authority, permitNumber, basePermitNumber, revision, issuedAt, lines: items, totalUsd, balanceUsd, reconciliation };
}

/** How a recorded summary is labelled in permit_fee_history, and how re-reading stays idempotent. */
export function feeSummarySource(summary: FeeSummary): string {
  return `fee_summary:${summary.permitNumber || summary.basePermitNumber || "unknown"}`;
}

export interface RecordFeeSummaryOutcome {
  recorded: boolean;
  reason: string;
  /** Everything counted for this permit, revisions included. */
  totalForPermitUsd: number;
  contributing: string[];
}

/**
 * Record a parsed summary as a REAL fee for this project, so the quote ladder's learned tier
 * starts answering from money that actually changed hands.
 *
 * IDEMPOTENT BY PERMIT NUMBER. Documents are re-extracted whenever text is missing, and a
 * project view can fire that; recording the same bill twice would inflate both this project's
 * fee and the AHJ median every other project inherits. A revision has its own permit number, so
 * it ADDS — which is the behaviour the real pair demonstrates.
 */
export function recordFeeSummary(
  db: AppDb,
  project: Pick<ProjectRecord, "id" | "state" | "ahj" | "utility">,
  summary: FeeSummary,
  track: "permit" | "nem" = "permit",
): RecordFeeSummaryOutcome {
  const total = summary.totalUsd;
  if (total == null) {
    return { recorded: false, reason: "The summary carries no readable TOTAL.", totalForPermitUsd: 0, contributing: [] };
  }
  const source = feeSummarySource(summary);
  const already = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM permit_fee_history WHERE project_id = ? AND source = ?",
    [project.id, source],
  );
  if (Number(already?.n) > 0) {
    const rows = db.query<{ fee_usd: number; source: string }>(
      "SELECT fee_usd, source FROM permit_fee_history WHERE project_id = ? AND source LIKE 'fee_summary:%'",
      [project.id],
    );
    return {
      recorded: false,
      reason: `Already recorded (${source}).`,
      totalForPermitUsd: round2(rows.reduce((a, r) => a + Number(r.fee_usd || 0), 0)),
      contributing: rows.map((r) => r.source),
    };
  }

  db.run(
    `INSERT INTO permit_fee_history (id, state, ahj, utility, track, fee_usd, source, project_id, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id(), text(project.state), text(project.ahj), text(project.utility), track, total, source, project.id,
      summary.issuedAt || nowIso()],
  );

  const rows = db.query<{ fee_usd: number; source: string }>(
    "SELECT fee_usd, source FROM permit_fee_history WHERE project_id = ? AND source LIKE 'fee_summary:%'",
    [project.id],
  );
  const totalForPermitUsd = round2(rows.reduce((a, r) => a + Number(r.fee_usd || 0), 0));

  logger.info("fees", "recorded a fee summary the authority issued", {
    projectId: project.id, ahj: text(project.ahj), permitNumber: summary.permitNumber,
    thisSummaryUsd: total, totalForPermitUsd, lines: summary.lines.length,
  });
  return { recorded: true, reason: "", totalForPermitUsd, contributing: rows.map((r) => r.source) };
}
