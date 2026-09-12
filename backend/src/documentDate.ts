import { logger } from "./logger";

// ---------------------------------------------------------------------------
// A form is a DATED artifact.
//
// Coos County's own solar page links an electrical permit application that
// prints the renewable-energy fee table on page 1 — "5 kva or less $79.00 |
// 5.01 kva to 15 kva $94.00 | 15.01 kva to 25 kva $156.00" — under the line
// "Revised 12/23/2022". The adopted schedule for those same brackets is
// $135/$160/$265. The form is not wrong, it is OLD, and an operator filling it
// has no way to know unless the store keeps what the document says about
// ITSELF. These functions read that line and nothing else.
//
// THE FAILURE MODE HERE IS GUESSING. A filename with a year in it, a copyright
// footer, an example date printed in an instructions box — each one looks like
// a date and none of them is the revision. A wrong date is strictly worse than
// no date, because "" reads as "unknown, go look" while a wrong one makes a
// stale form look current. So a date counts ONLY when the document labels it:
// a revision/effective qualifier immediately in front of a full month-day-year.
// Everything else returns "".
// ---------------------------------------------------------------------------

/** Beyond this, a form is worth re-checking against the AHJ's current page —
 *  and if it carried a fee table, worth re-checking against the adopted
 *  schedule. Two years is the Coos County distance almost exactly. */
export const DOCUMENT_DATE_STALE_DAYS = 730;

const DOC_DATE_MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

// The qualifier is the gate. It must sit immediately in front of the date —
// only whitespace, a colon, or one of a few connectives may come between —
// so "Revised 12/23/2022" matches and "Inspection scheduled 12/23/2022" does
// not, and neither does a bare date anywhere else on the page.
//
// The separator is BACK-REFERENCED (\3) and surrounded by \s*, which is the
// same lesson the fee reader learned the hard way: a PDF text layer splits
// runs wherever it likes, so "Revised 12/23/2022" can arrive as
// "Revised 12 / 23 / 2022". Item-by-item reading loses it; tolerating the gap
// while insisting both separators MATCH keeps "12/23/2022" a date and stops
// "12/23-2022" being one.
const DOC_DATE_RE = new RegExp(
  String.raw`\b((?:last\s+)?(?:revised|revision|rev|updated|effective|eff|adopted))\b\.?\s*(?:on|as\s+of|dated|date)?\s*:?\s*` +
    String.raw`(?:(\d{1,2})\s*([/\-.])\s*(\d{1,2})\s*\3\s*(\d{4}|\d{2})(?!\d)` +
    String.raw`|([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})(?!\d))`,
  "gi",
);

const pad2 = (n: number): string => String(n).padStart(2, "0");

// Turn month/day/year numbers into an ISO date, or "" if they are not a real
// date. Rejects everything implausible rather than coercing it: a form revised
// in 1974 or in 2099 is a misread, not a finding.
function isoFromDateParts(monthRaw: number, dayRaw: number, yearRaw: number, now: Date): string {
  let month = monthRaw;
  let day = dayRaw;
  let year = yearRaw;
  if (!Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(year)) return "";
  // A first number above 12 with a valid second is day-first (some AHJs, and
  // any form a consultant re-typed abroad). Only ever a rescue — an ambiguous
  // pair like 06/11 stays month-first, which is what a US permit form means.
  if (month > 12 && day <= 12) [month, day] = [day, month];
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  const nowYear = now.getUTCFullYear();
  if (year < 100) year = 2000 + year <= nowYear + 1 ? 2000 + year : 1900 + year;
  if (year < 1980 || year > nowYear + 5) return "";
  const d = new Date(Date.UTC(year, month - 1, day));
  // Calendar check: 02/31 parses as March 3 without it, which would invent a
  // revision date the document never carried.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return "";
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export interface DocumentDateFinding {
  /** The document's own words, whitespace-squashed: "Revised 12/23/2022". */
  phrase: string;
  /** The same date as YYYY-MM-DD, for comparing. */
  iso: string;
}

/** Every labelled self-description in the text, latest first. A form often
 *  carries an old footer stamp beside a newer one; the LATEST is the revision
 *  this copy actually is. */
export function findDocumentDates(text: string, now = new Date()): DocumentDateFinding[] {
  const out: DocumentDateFinding[] = [];
  const haystack = String(text || "");
  if (!haystack) return out;
  for (const m of haystack.matchAll(DOC_DATE_RE)) {
    const iso = m[6]
      ? isoFromDateParts(DOC_DATE_MONTHS[m[6].toLowerCase()] ?? 0, Number(m[7]), Number(m[8]), now)
      : isoFromDateParts(Number(m[2]), Number(m[4]), Number(m[5]), now);
    if (!iso) continue;
    // Squash the run of whitespace a PDF text layer leaves behind, then close
    // the gaps the same layer opened inside the date itself, so the stored
    // phrase reads the way the page reads.
    const phrase = m[0].replace(/\s+/g, " ").trim().replace(/(\d)\s*([/\-.])\s*(\d)/g, "$1$2$3").slice(0, 60);
    out.push({ phrase, iso });
  }
  return out.sort((a, b) => (a.iso < b.iso ? 1 : a.iso > b.iso ? -1 : 0));
}

/**
 * What the document says about itself — "Revised 12/23/2022", "Rev. 06/11/2019",
 * "Effective 7-1-25", "eff. 01/01/26" — or "" when it says nothing.
 *
 * Returns the document's PHRASE, not a normalised timestamp, because the
 * qualifier is half the meaning: an "Effective" date in the future means the
 * form is the current one, while a "Revised" date two years back means it is
 * aging. isoForDocumentDate() recovers the comparable date from the phrase, so
 * there is one parser and not two to drift apart.
 *
 * NEVER guesses. A copyright line, a filename with a year in it, or a bare date
 * with nothing labelling it all return "".
 */
export function extractDocumentDate(text: string, now = new Date()): string {
  return findDocumentDates(text, now)[0]?.phrase || "";
}

/** The comparable date inside a stored document_date phrase, or "". */
export function isoForDocumentDate(documentDate: string, now = new Date()): string {
  return findDocumentDates(documentDate, now)[0]?.iso || "";
}

/** How old the document says it is, in days, or null when it does not say.
 *  Negative for a future effective date — which is not stale, it is pending. */
export function documentDateAgeDays(documentDate: string, now = new Date()): number | null {
  const iso = isoForDocumentDate(documentDate, now);
  if (!iso) return null;
  const then = Date.parse(`${iso}T00:00:00.000Z`);
  if (!Number.isFinite(then)) return null;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

/** Worth re-checking against the AHJ's current forms page. A document that
 *  never dated itself is NOT stale — it is unknown, which is a different
 *  message and a different action. */
export function isDocumentDateStale(documentDate: string, now = new Date()): boolean {
  const age = documentDateAgeDays(documentDate, now);
  return age != null && age > DOCUMENT_DATE_STALE_DAYS;
}

/** Read a blank PDF's own revision line. Page 1 is where a revision stamp
 *  lives; four pages is a cheap ceiling that still catches a footer stamped on
 *  the last page of a short application. Row-grouped rather than item-by-item
 *  for the same reason the fee reader is: a split run must still read as one
 *  line. Never throws — a PDF we cannot read is a form with no stated date. */
export async function documentDateForPdf(bytes: Uint8Array, now = new Date()): Promise<string> {
  try {
    const { extractPdfRows } = await import("./pdfTables");
    const rows = await extractPdfRows(bytes, { maxPages: 4 });
    return extractDocumentDate(rows.map((r) => r.cells.join(" ")).join("\n"), now);
  } catch (err) {
    logger.warn("ahj-forms", "could not read a blank form's own revision date", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

/** Provenance as an operator reads it. One place, so the API listing and any
 *  other surface cannot disagree about what "stale" means. */
export interface TemplateProvenance {
  sourceUrl: string;
  documentDate: string;
  retrievedAt: string;
  feeTableFound: boolean;
  /** "" when the document never dated itself. */
  documentDateIso: string;
  documentAgeDays: number | null;
  stale: boolean;
}

export function templateProvenance(
  row: { source_url?: unknown; document_date?: unknown; retrieved_at?: unknown; fee_table_found?: unknown },
  now = new Date(),
): TemplateProvenance {
  const documentDate = String(row.document_date ?? "");
  return {
    sourceUrl: String(row.source_url ?? ""),
    documentDate,
    retrievedAt: String(row.retrieved_at ?? ""),
    feeTableFound: Number(row.fee_table_found ?? 0) === 1,
    documentDateIso: isoForDocumentDate(documentDate, now),
    documentAgeDays: documentDateAgeDays(documentDate, now),
    stale: isDocumentDateStale(documentDate, now),
  };
}
