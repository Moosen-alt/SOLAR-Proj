// ---------------------------------------------------------------------------
// READ THE RECORD NUMBER OFF THE COMPLETION PAGE.
//
// After a filing is submitted, the portal prints the number the whole rest of the product
// keys on: permit tracking, status checks, correspondence, the client page. Today a PERSON
// reads it off the screen and types it into a form — about 258 interruptions per 100
// projects, the single largest avoidable cost measured in the supervision audit
// (2026-09-22), and the one that happens on literally every filing.
//
// The scraping itself already existed inside recipeAdapter.captureSubmissionConfirmation,
// but only on the path where the BOT submits. When the human clicks submit in the open
// browser — which is the normal case, and required by hard rule 1 — nothing was reading
// the resulting page. This module is that logic, lifted out so both paths use one
// implementation rather than a second copy that drifts.
//
// A WRONG NUMBER IS WORSE THAN NO NUMBER. Everything downstream keys on it: a mistyped or
// mis-scraped record number silently tracks the wrong filing forever. So this reports its
// CONFIDENCE and the caller is expected to write only a confident read and otherwise leave
// the operator's manual form alone. "I could not tell" is a supported answer here.
// ---------------------------------------------------------------------------

export interface RecordNumberRead {
  /** The number, or "" when nothing trustworthy was found. */
  value: string;
  /** Which shape matched — useful in logs and for the operator's confirmation prompt. */
  source: "accela" | "powerclerk" | "labelled" | "none";
  /** Only a `high` read may be written without a human looking at it. */
  confidence: "high" | "low";
  /** Why, in one line, for the run log. */
  reason: string;
}

const NONE: RecordNumberRead = { value: "", source: "none", confidence: "low", reason: "No record number found on the page." };

/** Page text that proves a submission actually completed. */
const SUBMITTED_RE = /successfully submitted|application has been submitted|your application (?:was|has been) received|submission (?:is )?complete|record (?:number|#)|confirmation (?:number|#)|thank you for your (?:application|submission)/i;

// Accela-style record number: 517-26-000274-STR. Oregon city numbers take the same shape
// (187-26-000328-STR), which is why this one leads.
const ACCELA_RE = /\b\d{2,4}-\d{2}-\d{4,7}-?[A-Z]{0,4}\b/;
// PowerClerk assigns APP-######.
const POWERCLERK_RE = /\bAPP-\d{4,8}\b/;
// Anything explicitly LABELLED as the record/permit/application/confirmation number. Global:
// every labelled match is a candidate, in page order, and a candidate must carry a DIGIT.
// Case-insensitive, the token class also matches plain WORDS — a completion page headed
// "Application Received" above "Record Number: BLD-26-00123" was read as record "Received"
// (the first match won), and "Permit Application" as "Application". A record number always
// carries a digit; a word never is one (item 8 of portal-run-close, approvedFinalSubmit smoke).
const LABELLED_RE = /\b(?:record|permit|application|confirmation)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{5,})\b/gi;

// Shapes that are NEVER a record number, however they are labelled. A completion page is
// full of numbers — phone, ZIP+4, dates, dollar amounts, tracking of other kinds — and the
// labelled pattern is loose enough to catch them next to the wrong word.
const NOT_A_RECORD = [
  /^\d{3}-\d{3}-\d{4}$/,            // phone
  /^\(\d{3}\)/,                      // phone
  /^\d{5}-\d{4}$/,                   // ZIP+4
  /^\d{4}-\d{2}-\d{2}$/,             // ISO date
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,     // US date
  /^[0-9]+$/,                        // a bare run of digits with no structure at all
];

function disqualified(candidate: string): boolean {
  return NOT_A_RECORD.some((re) => re.test(candidate));
}

/**
 * Find the filing's record number in a completion page's visible text.
 *
 * Confidence is `high` only when the page also SAYS a submission completed — a number
 * scraped from a page that never claimed success is exactly the case where a human should
 * look, because it is usually a draft or a search result rather than a filed application.
 */
export function extractRecordNumber(bodyText: string): RecordNumberRead {
  const text = String(bodyText || "");
  if (!text.trim()) return NONE;
  const submitted = SUBMITTED_RE.test(text);

  const candidates: Array<{ value: string; source: RecordNumberRead["source"] }> = [];
  const accela = text.match(ACCELA_RE);
  if (accela) candidates.push({ value: accela[0], source: "accela" });
  const pc = text.match(POWERCLERK_RE);
  if (pc) candidates.push({ value: pc[0], source: "powerclerk" });
  for (const m of text.matchAll(LABELLED_RE)) {
    if (m[1] && /\d/.test(m[1])) candidates.push({ value: m[1], source: "labelled" });
  }

  for (const candidate of candidates) {
    const value = candidate.value.trim();
    if (!value || disqualified(value)) continue;
    return {
      value,
      source: candidate.source,
      // A structured portal-specific shape on a page that announces success is the only
      // combination trusted without a human. Everything else is reported for confirmation.
      confidence: submitted && candidate.source !== "labelled" ? "high" : "low",
      reason: submitted
        ? candidate.source === "labelled"
          ? "Found beside a record/permit label on a completion page — the shape is not portal-specific, so a person should confirm it."
          : `Matched the ${candidate.source} record-number shape on a page that confirms the submission completed.`
        : "A number matching a record shape was found, but the page does not say the submission completed — likely a draft or a list, so a person should confirm.",
    };
  }
  return NONE;
}

/** Did this page actually announce a completed submission? Exported for the callers that
 *  need the fact without the number (a filing can complete and show its number later). */
export function pageConfirmsSubmission(bodyText: string): boolean {
  return SUBMITTED_RE.test(String(bodyText || ""));
}
