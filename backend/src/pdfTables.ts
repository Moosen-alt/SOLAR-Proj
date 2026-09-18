// ---------------------------------------------------------------------------
// PDF TABLES — read a fee schedule the way a human reads it: BY ROW.
//
// A PDF has no rows. It has a stream of text-showing operators, and the order
// they appear in is the order the generator happened to emit them — which in a
// two-column fee table is routinely NOT the order the eye reads. Measured on
// the City of Coos Bay fee schedule (Resolution 26-30, Exhibit A, p.8): reading
// the text stream in order pairs
//       "Plan Review"            | "65% of permit fee"
// where the printed row actually says
//       "Structural Plan Review" | "65% of permit fee"
// because "Structural" was emitted before the row above it and "Plan Review"
// after. Same stream, two different facts. The same scramble is what turns
//       "Solar Permit (when required) - Prescriptive Path System" | "$200.00"
// into a fee attached to the wrong line — and a fee attributed to the wrong
// line goes onto a customer quote. Coordinates are not a formatting nicety
// here; they are the difference between a quote and a rumour.
//
// So: group text items by their baseline (transform[5]) within a tolerance,
// sort each group by x (transform[4]), and return the cells in VISUAL order.
// That is all extractPdfRows does — pure geometry, no fee semantics — so the
// pairing can be tested on its own, which is the only way to know it works.
//
// WHAT THIS MODULE REFUSES TO DO
//   - Guess a dollar amount. parseMoney matches a WHOLE cell or returns null:
//     "65% of permit fee" and "2,001 to 3,600 square-feet" are not money, and
//     no amount of digits in them makes them money. A sourced $0.00 IS money
//     (0, never null) — "no fee" is a finding, "we don't know" is not.
//   - Guess a bracket boundary. See parseBracketRow: an exclusive phrasing is
//     reported unparsed rather than converted to an invented epsilon.
//   - Return [] when it cannot read the file. extractLabels (formTextLayer.ts)
//     swallows failures and returns [] because an unanchorable form just falls
//     back to raw coordinates. Here an empty result reads as "this schedule has
//     no solar fee", which is a lie a corrupt download must never be allowed to
//     tell. Failures THROW. The caller decides what a failure means.
//
// NOTE ON PAGE NUMBERS: `page` here is 1-BASED — the number printed in a PDF
// reader, because the input to this module is a human saying "the fee table is
// on page 8". formTextLayer's LabelItem.page is 0-based. Don't mix them.
// ---------------------------------------------------------------------------

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** One text item with its position, in PDF points, y measured from the bottom. */
export interface PdfTextItem {
  page: number; // 1-based
  str: string;
  x: number; // transform[4] — left edge
  y: number; // transform[5] — baseline
  width: number;
  height: number;
}

/** One VISUAL row: the cells that share a baseline, left to right. */
export interface PdfTextRow {
  page: number; // 1-based
  /** Baseline of the topmost item in the row. */
  y: number;
  /** Cell text, in visual (left-to-right) order. Never empty, never blank. */
  cells: string[];
  /** Left edge of each cell — same length and order as `cells`. Columns live
   *  here: the value column of a fee table is an x, not an index. */
  xs: number[];
  /** Tallest glyph height in the row. Line spacing and gutters are judged
   *  against this so the module works at any point size. */
  height: number;
}

export interface ExtractPdfRowsOptions {
  /** 1-based page numbers to read. Omit for every page. */
  pages?: number[];
  /** Cap on pages read when `pages` is omitted. */
  maxPages?: number;
  /** Baselines within this many points are the same row. Default 3 — the
   *  measured slop on a real schedule's table row. This number is load-bearing:
   *  widen it and rows merge, which scrambles the column pairing all over
   *  again (pdfTables.test.ts proves exactly that). */
  yTolerance?: number;
  /** Horizontal white space that separates two CELLS rather than two words.
   *  Default 2 x the row's glyph height — far wider than any word space
   *  (~0.25 x height) and far narrower than a table gutter (hundreds of
   *  points). Tables with tighter columns than that must pass their own. */
  cellGap?: number;
}

const asPlainBytes = (bytes: Uint8Array | ArrayBuffer): Uint8Array =>
  bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes);

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Every non-blank text item with its coordinates, in the PDF's own STREAM
 *  order — deliberately unsorted, because proving that stream order is not row
 *  order requires being able to see stream order. */
export async function extractPdfTextItems(
  bytes: Uint8Array | ArrayBuffer,
  opts: Pick<ExtractPdfRowsOptions, "pages" | "maxPages"> = {},
): Promise<PdfTextItem[]> {
  const doc = await getDocument({ data: asPlainBytes(bytes), useSystemFonts: true }).promise;
  const wanted = opts.pages?.length
    ? opts.pages.filter((n) => Number.isInteger(n) && n >= 1 && n <= doc.numPages)
    : Array.from({ length: Math.min(doc.numPages, opts.maxPages ?? doc.numPages) }, (_, i) => i + 1);

  const out: PdfTextItem[] = [];
  for (const n of wanted) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    for (const it of content.items as Array<{ str?: string; transform?: number[]; width?: number; height?: number }>) {
      // pdfjs synthesises a zero-height " " item to span the gap between two
      // items it saw on one line. It is spacing, not content — dropping it is
      // what keeps a gutter reading as a gutter.
      if (!it.str || !it.str.trim() || !it.transform) continue;
      out.push({
        page: n,
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        width: it.width || 0,
        height: it.height || 0,
      });
    }
  }
  return out;
}

/** Items sharing a baseline, merged into cells and ordered left to right. */
export async function extractPdfRows(
  bytes: Uint8Array | ArrayBuffer,
  opts: ExtractPdfRowsOptions = {},
): Promise<PdfTextRow[]> {
  return groupItemsIntoRows(await extractPdfTextItems(bytes, opts), opts);
}

/** The grouping itself, over items already extracted. Separated so it can be
 *  exercised without a PDF and so extractPdfRows has nothing else in it. */
export function groupItemsIntoRows(items: PdfTextItem[], opts: ExtractPdfRowsOptions = {}): PdfTextRow[] {
  const tol = opts.yTolerance ?? 3;
  // Descending y: a PDF's y grows upward, so the top of the page is the LARGEST
  // y. Clusters are anchored on the first (topmost) item rather than chained
  // item-to-item, so a column of tightly-spaced lines cannot creep into one row
  // a few points at a time.
  // Only page and baseline here. x ordering belongs to the row, and doing it in
  // one place is what lets a test kill it: a tiebreak here would quietly sort
  // the cells too, and the sabotage of the row sort would pass anyway.
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y);

  const clusters: PdfTextItem[][] = [];
  let current: PdfTextItem[] = [];
  let anchor: PdfTextItem | null = null;
  for (const it of sorted) {
    if (!anchor || it.page !== anchor.page || anchor.y - it.y > tol) {
      if (current.length) clusters.push(current);
      current = [];
      anchor = it;
    }
    current.push(it);
  }
  if (current.length) clusters.push(current);

  return clusters.map((cluster) => {
    const byX = [...cluster].sort((a, b) => a.x - b.x || b.y - a.y);
    const height = Math.max(...byX.map((i) => i.height), 0) || 10;
    const gutter = opts.cellGap ?? height * 2;

    const cells: string[] = [];
    const xs: number[] = [];
    let endX = -Infinity;
    for (const it of byX) {
      const gap = it.x - endX;
      if (cells.length && gap <= gutter) {
        // Same cell. A gap of roughly zero is a split token ("$" + "200.00")
        // and joins tight; anything else was a space in the source line.
        const joiner = gap >= 0 && gap <= height * 0.2 ? "" : " ";
        cells[cells.length - 1] = `${cells[cells.length - 1]}${joiner}${it.str}`;
      } else {
        cells.push(it.str);
        xs.push(it.x);
      }
      endX = Math.max(endX, it.x + it.width);
    }

    return {
      page: cluster[0].page,
      y: Math.round(cluster[0].y * 100) / 100,
      cells: cells.map(squash),
      xs,
      height,
    };
  }).filter((row) => row.cells.some((c) => c.length > 0));
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** A dollar amount, or null. Matches the WHOLE cell on purpose.
 *
 *  "65% of permit fee" is not $65, "2,001 to 3,600 square-feet" is not $2,001,
 *  and "200 amp service" is not $200 — each one is a description that happens
 *  to carry digits, and each one is a wrong customer quote if a looser matcher
 *  pulls the number out of it. Whole-cell matching is also what makes the bare
 *  "200" form (a fee table with the $ sign only in the header) safe to accept.
 *
 *  "$0.00" returns 0, never null: a sourced zero fee is a finding. */
export function parseMoney(cell: string): number | null {
  const s = squash(String(cell ?? ""));
  if (!s) return null;
  if (s.includes("%")) return null;
  const m = /^\$\s*-?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$|^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const whole = (m[1] ?? m[3]) as string;
  const frac = m[2] ?? m[4];
  const value = Number(whole.replace(/,/g, "")) + (frac ? Number(`0.${frac}`) : 0);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

export interface MoneyCell {
  /** Index into the row's `cells`. */
  index: number;
  text: string;
  amountUsd: number;
  /** Left edge — the value COLUMN, which is what pairs a fee to a row. */
  x: number;
}

/** Which cells of a row are dollar amounts. */
export function findMoneyCells(row: Pick<PdfTextRow, "cells" | "xs">): MoneyCell[] {
  const out: MoneyCell[] = [];
  row.cells.forEach((text, index) => {
    const amountUsd = parseMoney(text);
    if (amountUsd != null) out.push({ index, text, amountUsd, x: row.xs[index] ?? 0 });
  });
  return out;
}

/** Split a row into the jurisdiction's WORDING and the value column.
 *
 *  A fee table's value column does not stop being the value column when what it
 *  holds is not a number: "Structural Plan Review | 65% of permit fee" is a
 *  label and a value, and folding that value into the label would report the
 *  line's name as "Structural Plan Review 65% of permit fee" — wording no
 *  application ever asks for. With no dollar amount to go on, the rightmost
 *  cell is the value by geometry, which is the same thing the eye uses. */
function splitRow(row: Pick<PdfTextRow, "cells" | "xs">): { labelCells: string[]; valueText: string; money: MoneyCell[] } {
  const money = findMoneyCells(row);
  if (money.length) {
    return {
      labelCells: row.cells.filter((_, i) => !money.some((m) => m.index === i)),
      valueText: money.map((m) => m.text).join(" "),
      money,
    };
  }
  if (row.cells.length >= 2) return { labelCells: row.cells.slice(0, -1), valueText: row.cells[row.cells.length - 1], money };
  return { labelCells: [...row.cells], valueText: "", money };
}

// ---------------------------------------------------------------------------
// Fee rows
// ---------------------------------------------------------------------------

/** The brief's five. Pass `keywords` to REPLACE this list, not extend it. */
export const DEFAULT_FEE_KEYWORDS = ["solar", "photovoltaic", "renewable", "kva", "kw"];

export interface FindFeeRowsOptions {
  keywords?: string[];
  /** A wrapped line sits within this many line-heights of the row it belongs
   *  to. Default 2.2 x the parent row's glyph height. */
  lineGap?: number;
}

export interface FeeRowMatch {
  row: PdfTextRow;
  /** Which keywords hit. */
  matched: string[];
  /** The description column (see splitRow) plus any wrapped continuation lines,
   *  joined. This is the jurisdiction's own wording for the line — what a permit
   *  application's fee-quantity field is asking for, verbatim. */
  label: string;
  money: MoneyCell[];
  /** Wrapped lines folded into `label`. Empty when the row is one line. */
  continuations: string[];
  /** The nearest heading ABOVE this row: the last matched row on this page that
   *  carried no dollar amount. A fee table says which technology a bracket
   *  belongs to ONCE, in a heading, and then prints sizes underneath it —
   *  "Wind Generation Systems greater than 25 kva" followed by two size rows,
   *  then "Solar Generation Systems greater than 25 kva" followed by one. The
   *  size rows never repeat the word, so a row read on its own cannot say what
   *  it is a fee FOR. Empty when no heading precedes the row. */
  section: string;
  /** Set when the row cannot be read as one description + one fee. Never
   *  silently dropped: an ambiguous row is reported, not guessed at. */
  note?: string;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A line whose DESCRIPTION says it is a proportion of some other fee. Measured
 *  on the real Coos County land-use schedule, which prints
 *      "Community Development Fee *(% of Land Use application fee)" | "$" "0.05"
 *  — a multiplier sitting in a dollar-formatted column. parseMoney reads that
 *  cell as $0.05 and it is not wrong to: the cell IS a number. The percentage
 *  lives in the label, so that is where it has to be caught, or a 5% fee is
 *  quoted as a nickel. Symmetric with refusing "65% of permit fee" as money
 *  when the percent sign is in the value cell instead. */
const PROPORTION_RE = /%\s*(?:of|\bper\b)|\bpercent(?:age)?\s+of\b/i;

/** Word-ish match: "kva" hits "5.01kva" (digit before) but not "kvahr", and
 *  "kw" never hits "kwh". Digits are not letters, which is the whole trick. */
const keywordRe = (kw: string): RegExp => new RegExp(`(?<![a-z])${escapeRe(kw.toLowerCase())}(?![a-z])`, "i");

/** Is `child` a wrapped continuation of the row `head` (whose last line so far
 *  is `prev`)?
 *
 *  The discriminator is COLUMNS, not emptiness. "Structural Plan Review | 65%
 *  of permit fee" carries no dollar amount, so a "no money cell" test would
 *  happily glue it onto the fee row above it and mislabel that fee — the exact
 *  failure this module exists to kill. A continuation never reaches the value
 *  column. Vertical adjacency is the second condition, not the first, and it is
 *  measured against the line immediately above so a three-line label chains. */
function isContinuationOf(child: PdfTextRow, head: PdfTextRow, prev: PdfTextRow, lineGap?: number): boolean {
  if (child.page !== head.page || child.page !== prev.page) return false;
  // A new technology heading is not a wrapped tail of the preceding wind fee.
  if (child.cells.length === 1 && /^(?:solar generation|wind generation|photovoltaic\s*\(PV\)|renewable electrical energy|electrical inspections|limited energy\s*\()/i.test(child.cells[0])) return false;
  // A row with a single cell gives us no column to be left of; refusing to
  // attach is the honest answer (it may be a paragraph, not a wrapped label).
  if (head.cells.length < 2 || !child.cells.length) return false;
  if (Math.max(...child.xs) >= Math.max(...head.xs) - 1) return false;
  if (findMoneyCells(child).length) return false;
  if (Math.abs(child.xs[0] - head.xs[0]) > head.height * 3) return false;
  const drop = prev.y - child.y;
  return drop > 0 && drop <= (lineGap ?? head.height * 2.2);
}

/** Rows whose text is about solar/renewable generation, with their dollar
 *  amounts identified and their wrapped lines folded back in. */
export function findFeeRows(rows: PdfTextRow[], opts: FindFeeRowsOptions = {}): FeeRowMatch[] {
  const keywords = (opts.keywords?.length ? opts.keywords : DEFAULT_FEE_KEYWORDS).map((k) => k.trim()).filter(Boolean);
  const res = keywords.map((k) => ({ kw: k, re: keywordRe(k) }));

  const ordered = [...rows].sort((a, b) => a.page - b.page || b.y - a.y);

  // Resolve wrapping FIRST, so a continuation is never also reported as a row
  // in its own right and its words are never lost from the row they belong to.
  const continuationOf = new Map<number, number>(); // child index -> head index
  for (let i = 1; i < ordered.length; i++) {
    const headIdx = continuationOf.get(i - 1) ?? i - 1;
    if (isContinuationOf(ordered[i], ordered[headIdx], ordered[i - 1], opts.lineGap)) {
      continuationOf.set(i, headIdx);
    }
  }

  const out: FeeRowMatch[] = [];
  // THE HEADING A ROW SITS UNDER, carried down the page. A heading is a row that
  // matched the vocabulary and printed no amount — "Renewable Energy", "Wind
  // Generation Systems greater than 25 kva". It is scoped to its page, because a
  // heading does not reach across a page break, and it is deliberately NOT
  // interpreted here: this module reports geometry and leaves what a section
  // MEANS to the caller, the same way it reports money without deciding whose
  // fee it is.
  let section = "";
  let sectionPage = -1;
  ordered.forEach((row, i) => {
    if (continuationOf.has(i)) return;
    const continuations: string[] = [];
    for (let j = i + 1; j < ordered.length && continuationOf.get(j) === i; j++) {
      continuations.push(ordered[j].cells.join(" "));
    }

    const { labelCells, valueText, money } = splitRow(row);
    const label = squash([...labelCells, ...continuations].join(" "));
    const haystack = `${label} ${row.cells.join(" ")}`;
    if (row.page !== sectionPage) { section = ""; sectionPage = row.page; }
    const matched = res.filter((r) => r.re.test(haystack)).map((r) => r.kw);
    // The first priced row under an explicit PV heading often just says
    // "Plan Review & Admin Fees". Carry the heading only across this adjacent
    // row, never across unrelated tables or another page.
    const prev = ordered[i - 1];
    if (!matched.length && money.length === 1 && prev?.page === row.page && prev.cells.length === 1
      && /photovoltaic.*solar.*(?:fees|system)/i.test(prev.cells[0]) && prev.y - row.y <= row.height * 2.2) {
      matched.push("photovoltaic");
    }
    if (!matched.length) return;

    const note = money.length === 0
      ? `No dollar amount in this row — its value column reads "${valueText || "(nothing)"}".`
      : money.length > 1
        ? `${money.length} dollar amounts share this visual row — the column pairing is ambiguous and a human must read it.`
        : PROPORTION_RE.test(label)
          ? `The label says this line is a proportion of another fee, so "${valueText}" is a multiplier, not dollars.`
          : undefined;

    if (row.page !== sectionPage) { section = ""; sectionPage = row.page; }
    out.push({ row, matched, label, money, continuations, section, ...(note ? { note } : {}) });
    // Set AFTER pushing: a heading's own `section` is the one above it, not itself.
    if (money.length === 0) section = label;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Brackets
// ---------------------------------------------------------------------------

export interface BracketRowParse {
  minKw?: number;
  maxKw?: number;
  feeUsd?: number;
  label: string;
  /** Set when this row must NOT be stored as a fee bracket, with the reason.
   *  Reported rather than guessed — a bracket off by one row bills a 20 kW job
   *  in the 15 kVA tier on a field that looks perfectly answered. */
  unparsed?: string;
  /** Set when the row read cleanly — one description, one amount, no complaint —
   *  and still carries NO size bounds. That is fine for a flat fee and is a hole
   *  in a table that brackets on size: the row has no size KEY, so nothing can
   *  decide whether a 20 kW job is in it. Returning it with no comment at all
   *  made "read fine" and "has no size key" the same answer, which is how a
   *  boundless row reached a bracket list in the first place. Advisory, not
   *  fatal: `unparsed` says do not store this, `note` says store it knowing it
   *  answers no size question. The caller is the one that can see whether the
   *  rest of the table is bracketed (readFeeTableFromPdf drops these when it is;
   *  matchBracket in feeSchedules.ts skips them if one gets through). */
  note?: string;
}

const NUM = String.raw`\d{1,3}(?:,\d{3})*(?:\.\d+)?`;
const UNIT = String.raw`(?:kva|kw|kilowatts?|kilovolt-?amp(?:ere)?s?)`;
const n = (s: string): number => Number(s.replace(/,/g, ""));

// "5.01kva through 15kva", "5.01 to 15 kVA", "5.01 - 15 kW". A unit is
// REQUIRED, which is what keeps "2,001 to 3,600 square-feet" out.
const RANGE_RE = new RegExp(String.raw`(${NUM})\s*${UNIT}?\s*(?:through|thru|to|–|—|-)\s*(${NUM})\s*${UNIT}`, "i");
const MIN_OPEN_RE = new RegExp(String.raw`(${NUM})\s*${UNIT}\s*(?:and|or)\s*(?:above|over|greater|more|higher|up)`, "i");
const MAX_RE = new RegExp(String.raw`(?:up to and including|up to|not (?:more than|exceeding)|through|maximum of)\s*(${NUM})\s*${UNIT}`, "i");
const FIRST_RE = new RegExp(String.raw`(?:first|initial)\s*(${NUM})\s*${UNIT}`, "i");
// Strictly-exclusive phrasings. Deliberately NOT converted to a bound.
const EXCLUSIVE_RE = new RegExp(
  String.raw`(?:less than|under|below|fewer than|more than|greater than|over|exceeding|above)\s*(${NUM})\s*${UNIT}`,
  "i",
);

// THE BOUND WORD CAN COME AFTER THE NUMBER, AND EVERY PATTERN ABOVE ASSUMES IT
// COMES BEFORE. RANGE/MIN_OPEN/MAX/FIRST all read "up to 5 kVA", "5 kVA and
// above", "first 25 kVA" — so the one phrasing that opens practically every
// renewable-energy table, "5 KVA or less", fell through all of them. Measured on
// the real Coos County renewable-energy schedule, whose FIRST printed row is
//      "5 KVA or less" | "$135.00"
// this returned a fee, no bounds, and no complaint: the bracket every small
// residential job lands in, silently missing its size key.
//
// Read INCLUSIVELY, which is the convention the rest of this module and
// matchBracket() already share: "5 KVA or less" is maxKw 5, taken verbatim, with
// nothing invented. A UNIT is REQUIRED, which is what keeps "Photovoltaic modules
// weigh 5 psf or less" (a real line off the same schedule's checklist) from
// becoming a 5 kVA bracket.
//
// Only the INCLUSIVE trailing phrasings. The strictly-exclusive ones this module
// deliberately refuses ("greater than 25 KVA") are not re-admitted through the
// back door — inventing an epsilon is the thing parseBracketRow declines to do,
// and reaching the first row of the table is no reason to overrule it.
const OR_LESS_RE = new RegExp(String.raw`(${NUM})\s*${UNIT}\s*(?:or|and)\s*(?:less|under|below|fewer)\b`, "i");

/** The inclusive maximum a trailing-bound label prints ("5 KVA or less" -> 5), or
 *  null. Exported because jurisdictionHarvest reads the same phrasing off the
 *  same rows and a second copy of this regex would be a second answer waiting to
 *  disagree. */
export function inclusiveMaxFromLabel(label: string): number | null {
  const m = OR_LESS_RE.exec(String(label || ""));
  if (!m) return null;
  const v = n(m[1]);
  return Number.isFinite(v) ? v : null;
}

/** Read one visual row as a fee bracket.
 *
 *  BOUNDARY CONVENTION: both bounds INCLUSIVE, taken verbatim from the printed
 *  numbers. The schedules encode the exclusion in the numbers themselves —
 *  "5.01kva through 15kva" then "15.01kva through 25kva" — so 15.00 belongs to
 *  the first row and 15.01 to the second with no re-interpretation at all.
 *  Treating a printed bound as exclusive would shift it twice and open a hole
 *  between 15.00 and 15.01 where no row applies. It is also the convention
 *  matchBracket() in feeSchedules.ts already evaluates on ("Bounds are
 *  INCLUSIVE at both ends"), and a parser that disagreed with the one evaluator
 *  would be a silent disagreement — the worst kind.
 *
 *  Which is why an explicitly EXCLUSIVE phrase ("less than 5 kW", "above 15
 *  kVA") comes back `unparsed` instead of 4.99 or 15.01: the schedule did not
 *  print a granularity and this module does not invent one. */
export function parseBracketRow(input: PdfTextRow | FeeRowMatch): BracketRowParse {
  const row: PdfTextRow = "cells" in input ? input : input.row;
  const split = splitRow(row);
  // A match has already folded in its wrapped lines; a bare row has not.
  const money = "cells" in input ? split.money : input.money;
  const label = "cells" in input ? squash(split.labelCells.join(" ")) : input.label;

  const out: BracketRowParse = { label };
  const reasons: string[] = [];

  if (money.length === 1 && PROPORTION_RE.test(label)) {
    // Deliberately no feeUsd: 0.05 in the value column of a line labelled
    // "% of Land Use application fee" is five percent, and a caller that
    // ignores `unparsed` should get nothing rather than a five-cent fee.
    reasons.push(`the label makes this line a proportion of another fee, so "${split.valueText}" is a multiplier and not dollars`);
  } else if (money.length === 1) out.feeUsd = money[0].amountUsd;
  else if (money.length === 0) reasons.push(`no dollar amount in this row (its value column reads "${split.valueText || "nothing"}")`);
  else reasons.push(`${money.length} dollar amounts in one visual row — which column is the fee is ambiguous`);

  const range = RANGE_RE.exec(label);
  if (range) {
    out.minKw = n(range[1]);
    out.maxKw = n(range[2]);
  } else {
    const minOpen = MIN_OPEN_RE.exec(label);
    const max = MAX_RE.exec(label) ?? FIRST_RE.exec(label);
    if (minOpen) out.minKw = n(minOpen[1]);
    if (max) out.maxKw = n(max[1]);
    // Last, and only if nothing above printed a maximum: the trailing-bound
    // phrasing ("5 KVA or less"). See OR_LESS_RE — a leading pattern that already
    // matched is the schedule's own wording and wins.
    if (out.maxKw == null) {
      const trailingMax = inclusiveMaxFromLabel(label);
      if (trailingMax != null) out.maxKw = trailingMax;
    }
  }

  const exclusive = EXCLUSIVE_RE.exec(label);
  if (exclusive && out.minKw == null && out.maxKw == null) {
    reasons.push(
      `"${squash(exclusive[0])}" is a strictly-exclusive bound; the schedule prints no granularity for it, `
      + `and this parser will not invent one (a bracket convention of inclusive/inclusive cannot express it)`,
    );
  }

  if (out.minKw != null && out.maxKw != null && out.minKw > out.maxKw) {
    reasons.push(`bounds read backwards (${out.minKw} > ${out.maxKw}) — the row was probably mis-grouped`);
  }

  if (reasons.length) out.unparsed = reasons.join("; ");
  // A CLEAN READ WITH NO BOUNDS IS NOT THE SAME ANSWER AS A CLEAN READ. Said only
  // when there is nothing else to say: a row that already came back `unparsed`
  // (an exclusive phrase, a proportion, an ambiguous column) has been told not to
  // store it at all, and firing both channels would make neither mean anything.
  else if (out.feeUsd != null && out.minKw == null && out.maxKw == null) {
    out.note = `this row carries a fee but no size bounds — fine as a flat fee, `
      + `but in a table bracketed on system size it has no size key and cannot answer "which bracket is this job in?"`;
  }
  return out;
}
