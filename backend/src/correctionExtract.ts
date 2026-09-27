// ---------------------------------------------------------------------------
// THE CORRECTION ITSELF, READ OFF THE PAGE IT WAS PRINTED ON.
//
// A correction the permit monitor opens from a portal reading used to store the WHOLE scraped
// record page as its text. A Coos Bay record (production 1fb3dc39; operator note 2026-09-27, "a bit
// cluttered"): 3,712 characters — record header, licensed professionals, the project description,
// "Documents Upload/View ... Silverlight", "Loading...", the valuation calculator — around ONE
// Accela Condition, "Outstanding permit ... expired prior to final". The card printed all of it,
// and the keyword classifier read the chrome ("Residential Structural Record") as a design issue.
//
// What is read, in order:
//   1. CONDITIONS — Accela's Conditions list rows. Every row ends in "Status | Severity | Date"
//      ("Applied | Notice | 12/13/2019"), which is the one reliable split point on a page whose
//      markup was stripped and whose words are glued ("PERMIT OUTSTANDINGOutstanding permit").
//      A page that names a condition but prints no row falls back to the monitor's own reader,
//      recordConditionOf — ONE predicate answers "does this page carry a condition", so the
//      correction and the status message can never disagree about it.
//   2. REVIEW COMMENTS — a labelled comment block ("Plan Review Comments:", "Corrections
//      Required:", "Additional Information Needed:" ...) on EnerGov / other record pages. The
//      label needs its colon: Accela's own application field "Additional Comments:" and its
//      "In Review/Addl Info Needed" status are NOT reviewer comments and never match.
//   3. NOTHING FOUND — the whole text stands as the correction, and the reading says so
//      (method "whole_text"). Nothing is ever discarded: the caller keeps the full text as
//      evidence (corrections.source_text) whichever way this goes.
//
// Pure: text in, reading out. No DB, no network, no LLM.
// ---------------------------------------------------------------------------
import { recordConditionOf } from "./permitMonitor";

export type PageCorrectionMethod = "items" | "whole_text";

export interface PageCorrectionReading {
  /** "items": the correction is the conditions/comments below. "whole_text": none was found and
   *  the whole text stands — a caller showing it must say so. */
  method: PageCorrectionMethod;
  /** One line per condition row, in page order. */
  conditions: string[];
  /** One entry per labelled review-comment block, in page order. */
  comments: string[];
  /** What to store as the correction's text: the items one per line (plus an honest count when
   *  the page lists more than it printed), or the whole text on the fallback. */
  text: string;
}

// Accela condition statuses, longest first so "Condition Met" is not read as "Met".
const ROW_STATUS = "Condition Met|Not Applied|Not Met|Applied|Met|Resolved|Released|Waived|Satisfied|Pending|Active";
// THE ROW TERMINATOR. No leading word boundary: the status is glued to the description before it
// ("expired prior to final.Applied |", "loaded by scriptApplied |").
const ROW_END = new RegExp(`(${ROW_STATUS})\\s*\\|\\s*([A-Za-z][A-Za-z ]{0,24}?)\\s*\\|\\s*(\\d{1,2}/\\d{1,2}/\\d{2,4})`, "g");
const LIST_START = /Conditions?\s+Showing\s+\d+\s*-\s*\d+\s+of\s+(\d+)/i;
const TOTAL_HEADER = /Total\s+Conditions:\s*(\d+)(?:\s*\([^)]*\))?(?:\s*View\s+Condition)?/i;
// "Parcel Notifications - 1 ", "Building Conditions - 1 " — the group header ahead of its rows.
const GROUP_HEADER = /^[A-Z][A-Za-z/&]*(?:\s+[A-Za-z/&]+){0,4}\s+-\s+\d+\s+/;
const LEADING_STATUS = new RegExp(`^(?:${ROW_STATUS})\\s+`);
// A row whose body runs past this is not a row — the terminator matched something else.
const MAX_ROW_BODY = 600;

/** The condition names the record header prints ("Condition: PERMIT OUTSTANDINGSeverity: Notice"). */
function headerConditionNames(page: string): string[] {
  const names: string[] = [];
  const re = /Condition:\s*([^|]{1,140})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(page))) {
    const name = m[1].split(/Severity\s*:|Total\s+Conditions|View\s+Condition/i)[0].trim();
    if (name.length >= 3 && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Split a row body into the condition's name and its description. */
function nameAndDescription(body: string, headerNames: string[]): { name: string; description: string } {
  // (a) A name the header printed, found in this row — the description follows its FIRST
  //     occurrence, skipping only a repeat printed back to back right after it (Ivy's row prints
  //     "Sewer Recovery Sewer Recovery" before the description). NOT the last occurrence: a
  //     description that repeats the name ("Sewer Recovery fee of $1,200 …; see Sewer Recovery
  //     ordinance 12.4.") lost the fee and the requirement (correction-card skeptic MF2).
  for (const name of headerNames) {
    const at = body.indexOf(name);
    if (at < 0) continue;
    let end = at + name.length;
    for (;;) {
      const rest = body.slice(end);
      const lead = rest.length - rest.trimStart().length;
      if (!rest.trimStart().startsWith(name)) break;
      end += lead + name.length;
    }
    return { name, description: body.slice(end).trim() };
  }
  // (b) A phrase printed twice in a row (condition type and name are often the same words).
  const twice = /(?:^|\s)((?:[A-Za-z0-9&/'(),-]+\s){0,5}[A-Za-z0-9&/'(),-]+)\s\1/.exec(body);
  if (twice && twice[1].length >= 4) {
    return { name: twice[1], description: body.slice(twice.index + twice[0].length).trim() };
  }
  // (c) An ALL-CAPS name glued to a capitalised description ("FLOODPLAIN DEVELOPMENTFloodplain ...").
  const caps = /(?:^|\s)([A-Z][A-Z0-9&/'-]+(?:\s+[A-Z0-9&/'-]+)*?)(?=[A-Z][a-z])/.exec(body);
  if (caps) {
    const start = caps.index + caps[0].length - caps[1].length;
    return { name: caps[1], description: body.slice(start + caps[1].length).trim() };
  }
  return { name: "", description: body.trim() };
}

/** Accela's Conditions list rows, formatted "NAME - Severity: S - description Status | S | date". */
function accelaConditionRows(page: string): { rows: string[]; total: number } {
  const list = LIST_START.exec(page);
  const header = TOTAL_HEADER.exec(page);
  const total = Math.max(Number(list?.[1] ?? 0), Number(header?.[1] ?? 0));
  const start = list ? list.index + list[0].length : header ? header.index + header[0].length : -1;
  if (start < 0) return { rows: [], total };
  const names = headerConditionNames(page);
  const rows: string[] = [];
  const re = new RegExp(ROW_END.source, "g");
  re.lastIndex = start;
  let from = start;
  let m: RegExpExecArray | null;
  while ((m = re.exec(page))) {
    let body = page.slice(from, m.index).trim();
    // Past the list, a terminator belongs to something else - so a long body ends the list. But the
    // FIRST row, on a page whose header says it lists conditions, is that condition however long it
    // is: a ~780-character floodplain requirement was dropped for the header's one-liner (skeptic MF3).
    if (body.length > MAX_ROW_BODY && !(rows.length === 0 && total >= 1)) break;
    body = body.replace(GROUP_HEADER, "").replace(LEADING_STATUS, "").trim();
    const [, status, severity, date] = m;
    const { name, description } = nameAndDescription(body, names);
    const desc = description && !/[.!?]$/.test(description) ? `${description}.` : description;
    const head = [name, `Severity: ${severity.trim()}`, desc].filter(Boolean).join(" - ");
    rows.push(`${head} ${status} | ${severity.trim()} | ${date}`);
    from = m.index + m[0].length;
  }
  return { rows, total };
}

// A reviewer's comment block, by its label. The colon is required (see the header note).
const COMMENT_LABEL = new RegExp(
  "(?:plan\\s+review\\s+comments?|review\\s+comments?|reviewer(?:'s)?\\s+comments?|comments?\\s+from\\s+(?:the\\s+)?reviewer"
  + "|corrections?\\s+(?:required|needed|requested)|required\\s+corrections?|correction\\s+comments?|deficienc(?:y|ies)(?:\\s+list)?"
  + "|additional\\s+info(?:rmation)?\\s+(?:needed|required|requested)|information\\s+requested|items?\\s+needed)\\s*:",
  "gi",
);
// Where a comment block ends on a flattened record page: the next section heading (case-sensitive,
// headings are capitalised) — else a length cap.
const SECTION_BOUNDARY = /\s(?:Work Location|Record Details|Licensed Professional|Project Description|Owner:|More Details|Additional Information|Application Information|Parcel Information|Fees|Inspections|Documents|Related Records|Processing Status|Attachments|Valuation Calculator|Payments|Record Info|Contacts?\b|Conditions)\b/;
const MAX_COMMENT = 600;

function reviewComments(page: string): string[] {
  const out: string[] = [];
  const re = new RegExp(COMMENT_LABEL.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(page))) {
    let body = page.slice(m.index + m[0].length, m.index + m[0].length + MAX_COMMENT + 1);
    // A section word is a HEADING only when it is not the start of a numbered item ("3. Documents
    // must be wet-stamped") and not followed by prose (a lowercase word): those are the reviewer's
    // own sentences, and cutting there lost items 3 and 4 while the reading still said "items"
    // (correction-card skeptic MF1). The tab strip after the block ("Inspections Fees Attachments")
    // is still cut.
    const boundary = new RegExp(SECTION_BOUNDARY.source, "g");
    let cut: RegExpExecArray | null;
    while ((cut = boundary.exec(body))) {
      const before = body.slice(0, cut.index);
      const after = body.slice(cut.index + cut[0].length);
      if (/\d+[.)]\s*$/.test(before) || /^\s+[a-z]/.test(after)) continue;
      break;
    }
    if (cut) body = body.slice(0, cut.index);
    body = body.trim();
    if (body.length > MAX_COMMENT) body = `${body.slice(0, MAX_COMMENT).trimEnd()}…`;
    if (body.length >= 3 && !out.includes(body)) out.push(body);
  }
  return out;
}

export function extractCorrectionFromPage(pageText: string): PageCorrectionReading {
  const page = String(pageText ?? "").trim();
  const { rows, total } = accelaConditionRows(page);
  // No row printed: the monitor's reader decides whether the page carries a condition at all.
  const fallbackCondition = rows.length ? "" : recordConditionOf(page);
  const conditions = rows.length ? rows : fallbackCondition ? [fallbackCondition] : [];
  const comments = reviewComments(page);
  if (!conditions.length && !comments.length) return { method: "whole_text", conditions, comments, text: page };
  const lines = [...conditions, ...comments];
  // The header's one-liner is a NAME, not the condition's text: the correction says so on its own
  // line - never a silent one-liner (correction-card skeptic MF3).
  if (!rows.length && fallbackCondition) {
    lines.splice(1, 0, "(The condition's full text could not be read here — see the portal record text.)");
  }
  // A DENOMINATOR: the page lists more conditions than it printed (a paged list).
  if (rows.length && total > rows.length) {
    lines.push(`(The page lists ${total} conditions; ${rows.length} were read — the rest are on the portal record.)`);
  }
  return { method: "items", conditions, comments, text: lines.join("\n") };
}
