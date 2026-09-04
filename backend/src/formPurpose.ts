// ---------------------------------------------------------------------------
// REACHING A REVIEW SCREEN IS NOT THE SAME AS FILING THE RIGHT THING.
//
// The learn benchmark's ladder tops out at "reached the portal's review screen", and on
// 2026-09-04 exactly one portal of eleven got there: Gilbert, AZ. It filled eight fields
// and reached review on a page titled
//
//     "Neumo: Permit Extension Request"
//
// from the stored URL gilbertaz.seamlessdocs.com/f/permitext. A PERMIT EXTENSION — not a
// solar permit application. The engine did everything asked of it, perfectly, on the wrong
// form, and scored 6 out of 6 for it.
//
// Two guards already exist against this mistake in its other costumes: PROGRAM_EXCLUDE
// refuses a rebate programme, and the record-type pass refuses a type contradicting the
// filing's discipline. Both act when there is a CHOICE. Here there was none — one form,
// reached directly from a URL that was wrong before the run started — so nothing looked.
//
// So this looks at the form we actually landed on and asks whether it announces itself as
// a different transaction. It cannot know the right form; it can know a wrong one, which is
// the half worth automating.
//
// IT FLAGS, IT DOES NOT REFUSE. The run has already happened by the time this is asked, and
// the captured fill is evidence a person may want. What it does is keep the recipe out of
// TRUSTED, which is the state that matters: a trusted recipe replays unattended on every
// future project in that jurisdiction, and a trusted recipe for a permit extension would
// file permit extensions for real customers.
// ---------------------------------------------------------------------------

/**
 * Transactions that are never a new permit or interconnection application. Anchored on word
 * boundaries after PROGRAM_EXCLUDE was found rejecting "Renewable Energy Interconnection"
 * on a bare `renew` — the same list-shaped mistake, and it fails in the direction that
 * looks like someone else's problem.
 */
const WRONG_PURPOSE: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /\bpermit\s+extension\b|\bextension\s+request\b|\bextend\s+(a\s+|my\s+|an\s+)?permit\b/i, what: "a permit EXTENSION" },
  { pattern: /\brenew(al|als)?\s+(of\s+)?(a\s+|my\s+|an\s+|the\s+)?(permit|licen[cs]e|application)\b|\bpermit\s+renewal\b/i, what: "a permit RENEWAL" },
  { pattern: /\brequest\s+(an?\s+)?inspection\b|\binspection\s+request\b|\bschedule\s+(an?\s+)?inspection\b/i, what: "an INSPECTION request" },
  { pattern: /\bcomplaint\b|\bcode\s+enforcement\b|\breport\s+a\s+violation\b/i, what: "a COMPLAINT / code-enforcement report" },
  { pattern: /\bappeal\b|\bvariance\s+request\b/i, what: "an APPEAL or variance" },
  { pattern: /\bpay\s+(your\s+|my\s+|an?\s+)?(fee|invoice|bill)\b|\bmake\s+a\s+payment\b/i, what: "a PAYMENT" },
  { pattern: /\brebate\b|\bincentive\s+application\b/i, what: "a REBATE / incentive claim" },
  { pattern: /\bwithdraw(al)?\s+(a\s+|my\s+|an\s+|the\s+)?(permit|application)\b/i, what: "a WITHDRAWAL" },
  { pattern: /\brefund\s+request\b/i, what: "a REFUND request" },
  { pattern: /\bpre[\s-]?application\s+meeting\b|\bconsultation\s+request\b/i, what: "a pre-application MEETING request" },
];

/** URL fragments that give the same answer before a single field is read. */
const WRONG_PURPOSE_URL: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /permitext|permit[-_]?ext(ension)?\b/i, what: "a permit EXTENSION (from the URL)" },
  { pattern: /\brenewal?\b(?!able)/i, what: "a RENEWAL (from the URL)" },
  { pattern: /inspection[-_]?request|request[-_]?inspection/i, what: "an INSPECTION request (from the URL)" },
  { pattern: /complaint|codeenforce/i, what: "a COMPLAINT (from the URL)" },
];

export interface PurposeVerdict {
  /** True when the landed form announces itself as something other than a new application. */
  mismatch: boolean;
  /** Operator-facing sentence naming what was seen and where. Empty when clean. */
  reason: string;
}

/**
 * Does the form this run landed on announce itself as the wrong transaction?
 *
 * `texts` are things the form said about itself — page title, review-screen body, headings.
 * `urls` are the addresses it was reached at. Both are checked because either alone misses:
 * Gilbert's page title says "Permit Extension Request" AND its URL says /f/permitext, but a
 * portal can easily have only one of the two.
 *
 * Pure and browser-free, so the rule is testable without touching a portal — which matters,
 * because a rule that blocks trust must not drift.
 */
export function formPurposeMismatch(texts: Array<string | undefined>, urls: Array<string | undefined> = []): PurposeVerdict {
  // THE TITLE IS WHAT A FORM ANNOUNCES ITSELF AS; THE BODY IS WHAT IT TALKS ABOUT.
  //
  // That distinction is the whole guard. A permit form mentions extensions and inspections
  // constantly — "this permit may be extended once", a nav bar linking to "Request
  // Inspection" — and a rule that tripped on those would block every good recipe and be
  // switched off within a week. An earlier attempt here used "is the phrase near the top of
  // the text" as a proxy for "is it the subject", and a nav bar 40 characters in defeated
  // it immediately. Titles are the honest signal.
  const title = (texts.find((t) => t && t.trim()) || "").replace(/\s+/g, " ").slice(0, 300);
  const body = texts.filter(Boolean).join(" \n ").replace(/\s+/g, " ").slice(0, 4000);
  // A page that says anywhere that it IS a new application gets the benefit of the doubt on
  // anything its body merely mentions.
  const NEW_APPLICATION = /\bnew\s+(permit\s+)?application\b|\bapply\s+for\s+a\s+(new\s+)?permit\b|\binterconnection\s+application\b|\bnet[\s-]?meter/i;
  const saysNewApplication = NEW_APPLICATION.test(body);
  const found: string[] = [];

  for (const { pattern, what } of WRONG_PURPOSE) {
    // Named in the title: that is what this form is, and no amount of body text argues.
    if (pattern.test(title)) { found.push(what); continue; }
    // Only in the body: an aside, unless nothing here claims to be a new application.
    if (pattern.test(body) && !saysNewApplication) found.push(what);
  }

  for (const url of urls) {
    if (!url) continue;
    for (const { pattern, what } of WRONG_PURPOSE_URL) {
      if (pattern.test(url) && !found.includes(what)) found.push(what);
    }
  }

  if (!found.length) return { mismatch: false, reason: "" };
  return {
    mismatch: true,
    reason:
      `The form this recipe was learned on announces itself as ${found.slice(0, 3).join(", and ")}` +
      ` — not a new permit or interconnection application. Filing here would submit the wrong` +
      ` thing for every future project in this jurisdiction, so the recipe is NOT trusted.` +
      ` Check the stored portal URL for this jurisdiction before re-recording.`,
  };
}
