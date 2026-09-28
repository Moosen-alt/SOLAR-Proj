// A FILING ANNOUNCES ITSELF AS A NEW ROW IN THE ACCOUNT'S LIST — ON EVERY PORTAL.
//
// After a human clicks the final submit we need two things back: the record number the
// portal just issued, and a link that reaches that record later. The obvious way to get
// them is to read the confirmation page, and that is what the Accela path does — it
// matches /\d{2,4}-\d{2}-\d{4,7}-?[A-Z]{0,4}/ against the completion text. That regex is
// Accela's numbering scheme. PowerClerk, ConnectTheGrid, EnerGov and OpenGov all number
// differently, and half of them never render a "completion page" at all: the drawer closes
// and the application simply appears in the list. A confirmation-page regex is therefore a
// per-portal patch, and per-portal patches are exactly what this engine must not accumulate.
//
// The invariant that holds everywhere: a portal that accepted a filing SHOWS it in the
// account's application list, keyed by the number it issued, linked to the record. So we
// snapshot that list before the human submits and read it again after. The row that is
// there the second time and was not there the first time IS the filing — whatever the
// portal calls it, however it numbers it, with no knowledge of the platform required.
//
// The read runs inside the page (page.evaluate), so it must be self-contained. The diff
// and the scoring run in Node.

export interface LedgerEntry {
  /** The record identifier exactly as the portal prints it. */
  id: string;
  /** Absolute link to the record, when the list links it (portals almost always do). */
  href: string;
  /** The row's visible text, capped — used only to match a row to the right project. */
  row: string;
}

export function readApplicationLedgerInPage(): LedgerEntry[] {
  // A record identifier carries digits and is long enough not to be an ordinal. Beyond
  // that we cannot assume a scheme: "517-26-000274-STR", "PC-0042198", "2026-1174" and
  // "8830012" are all real. So the shape is permissive and the REJECTS carry the weight —
  // a list page is full of dates, phone numbers, money and zips that would otherwise pass.
  const RECORD_ID = /^(?=.*\d)[A-Za-z0-9][A-Za-z0-9\-/_.]{4,29}$/;
  const REJECT = [
    /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/, // 8/27/26, 08-27-2026
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/, // 2026-08-27
    /^\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}$/, // phone
    /^\$?[\d,]+\.\d{1,2}$/, // money / decimals
    /^\d{5}(-\d{4})?$/, // zip / zip+4
    /^\d{1,4}$/, // short ordinals, row counters
    /^(19|20)\d{2}$/, // a bare year
  ];

  const isRecordId = (raw: string): boolean => {
    const t = raw.trim();
    if (t.length < 6 || t.length > 30 || !RECORD_ID.test(t)) return false;
    for (const r of REJECT) if (r.test(t)) return false;
    // Require real identifier density: either a letter/digit mix, or a run of >=5 digits.
    // "Schedule 4" and "Roof 1" die here; "PC-0042198" and "8830012" survive.
    const digits = (t.match(/\d/g) || []).length;
    const letters = (t.match(/[A-Za-z]/g) || []).length;
    return (letters > 0 && digits >= 2) || digits >= 5;
  };

  // The row a value sits in — the thing an operator would point at and call "the
  // application". Table rows are explicit; card/list layouts are approximated by the
  // nearest ancestor that is big enough to be a row and small enough not to be the list.
  const rowOf = (el: Element): Element => {
    let box: Element | null = el;
    for (let up = 0; up < 6 && box; up++) {
      if (/^(TR|LI)$/.test(box.tagName)) return box;
      if (box.getAttribute("role") === "row") return box;
      const parent: Element | null = box.parentElement;
      if (!parent) break;
      if ((parent.textContent || "").length > 600) break;
      box = parent;
    }
    return box || el;
  };

  const textOf = (el: Element): string => ((el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ").trim();

  // Site chrome numbers things too (version strings, phone numbers in a footer, a
  // "1-800-..." support link). Nothing in nav/header/footer is an application.
  const inChrome = (el: Element): boolean => Boolean(el.closest("nav, header, footer, [role='navigation'], [role='banner'], [role='contentinfo']"));

  const found = new Map<string, LedgerEntry>();
  const add = (id: string, href: string, row: string): void => {
    const key = id.trim();
    const prior = found.get(key);
    // A later pass may supply a link the earlier one lacked; never lose a link we had.
    if (prior && (prior.href || !href)) return;
    found.set(key, { id: key, href, row: row.slice(0, 240) });
  };

  // PASS 1 — the record number rendered as its own link. This is how every list portal
  // we have met presents a filing, and it hands us the id and the tracking link together.
  for (const a of Array.from(document.querySelectorAll("a[href]"))) {
    if (inChrome(a)) continue;
    const label = textOf(a);
    if (!isRecordId(label)) continue;
    add(label, (a as HTMLAnchorElement).href || "", textOf(rowOf(a)));
  }

  // PASS 2 — the number is plain text in a row that links elsewhere (a "View" button, or
  // the address is the link). Only rows are considered, so a record id in a paragraph of
  // prose is not mistaken for a filing.
  for (const row of Array.from(document.querySelectorAll("tr, li, [role='row']"))) {
    if (inChrome(row)) continue;
    const rowText = textOf(row);
    if (!rowText || rowText.length > 600) continue;
    const cells = Array.from(row.querySelectorAll("td, th, [role='cell'], [role='gridcell']"));
    const parts = cells.length ? cells.map(textOf) : rowText.split(/\s{2,}|\s\|\s/);
    for (const part of parts) {
      if (!isRecordId(part)) continue;
      const link = row.querySelector("a[href]");
      add(part, link ? (link as HTMLAnchorElement).href || "" : "", rowText);
      break; // one identifier per row — the first is the record, later ones are dates/fees
    }
  }

  return Array.from(found.values());
}

// ---------------------------------------------------------------------------
// Node side: the diff, and choosing between candidates.
// ---------------------------------------------------------------------------

/** Rows present after the submit that were not present before it. */
export function newLedgerEntries(before: LedgerEntry[], after: LedgerEntry[]): LedgerEntry[] {
  const seen = new Set(before.map((e) => e.id.trim().toUpperCase()));
  return after.filter((e) => !seen.has(e.id.trim().toUpperCase()));
}

/**
 * Choose which new row is THIS project's filing.
 *
 * Usually there is exactly one and this is trivial. It stops being trivial when the
 * account files for several homes in a day, or when a portal creates a numbered draft
 * alongside the submitted record — so a wrong pick would attach another customer's
 * permit number to this project. Hints (address, homeowner) break the tie; when nothing
 * scores and there is more than one candidate we return null rather than guess, and the
 * caller falls back to asking the human.
 */
export function pickFiledRecord(fresh: LedgerEntry[], hints: string[]): LedgerEntry | null {
  if (fresh.length === 0) return null;
  if (fresh.length === 1) return fresh[0] ?? null;

  const tokens = hints
    .flatMap((h) => h.toLowerCase().split(/[^a-z0-9]+/))
    .filter((t) => t.length >= 3);
  if (tokens.length === 0) return null;

  let best: LedgerEntry | null = null;
  let bestScore = 0;
  let tied = false;
  for (const entry of fresh) {
    const row = entry.row.toLowerCase();
    const score = tokens.reduce((n, t) => (row.includes(t) ? n + 1 : n), 0);
    if (score > bestScore) { best = entry; bestScore = score; tied = false; }
    else if (score === bestScore && score > 0) tied = true;
  }
  return bestScore > 0 && !tied ? best : null;
}

/**
 * Drop session-scoped material from a record link so it is safe to store and still works
 * when clicked weeks later. Accela embeds capId + an auth ticket in the query string;
 * keeping those persists session material in the DB and yields a dead link anyway.
 * Query parameters that IDENTIFY the record (not the session) are kept.
 */
export function cleanRecordLink(raw: string): string {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    // agencyCode and TabName are NOT session material — they identify which agency's record
    // and which tab to render, and Accela's public CapDetail view needs them. Dropping them
    // produced a link that only works while logged in: the monitor's anonymous fetch came
    // back with Accela's "An error has occurred. We are experiencing technical difficulties",
    // so a permit that was already ISSUED tracked as "needs human review".
    // publicPermitStatus.fetchAccelaStatus says the same thing at its Strategy 1.
    // IsToShowInspection is the inspections view toggle Accela puts on the record link the
    // operator actually copies out of the browser. Inspections are the phase AFTER issuance,
    // so it is worth carrying rather than filtering away.
    // PowerClerk's ProjectId / ProgramId / FormId identify the record too (dryrun-0928 B11): a bare
    // /MvcProjects/EditProject reaches nothing. ONE list — recipeAdapter.captureSubmissionConfirmation
    // and the draft reference (draftReferenceFromUrl) read links through this function.
    const KEEP = /^(capid|capid1|capid2|capid3|module|tabname|agencycode|istoshowinspection|id|recordid|permitnumber|applicationid|appid|caseid|number|projectid|programid|formid)$/i;
    const kept = new URLSearchParams();
    u.searchParams.forEach((v, k) => { if (KEEP.test(k)) kept.append(k, v); });
    const q = kept.toString();
    return `${u.origin}${u.pathname}${q ? `?${q}` : ""}`;
  } catch {
    return raw;
  }
}

/** Query parameters that NAME a specific application (never a page, a tab, an agency or a flag). */
const DRAFT_ID_PARAM = /^(projectid|capid|recordid|applicationid|appid|caseid|permitnumber)$/i;
/** Accela spreads its record key over capID1..3 — joined, it is the temporary record's key. */
const ACCELA_CAP_PARTS = ["capid1", "capid2", "capid3"];

/**
 * THE DRAFT A STAGING RUN LEFT, AS THE PORTAL NAMES IT (dryrun-0928 B11) — read off the review
 * page's own URL, never by navigating the open review window anywhere (it is the one a person
 * submits in). `link` is the URL through cleanRecordLink (identifiers only, never session material);
 * `id` is the application's own key when the URL carries one — PowerClerk's ProjectId, an Accela
 * capID1-3 — and "" otherwise. An Accela wizard page (CapEdit.aspx?stepNumber=…&Module=Building)
 * carries none: its draft is found by host, account, time and run, and nothing claims otherwise.
 */
export function draftReferenceFromUrl(raw: string): { link: string; id: string } {
  const link = cleanRecordLink(String(raw ?? ""));
  if (!/^https?:/i.test(link)) return { link: "", id: "" };
  let id = "";
  try {
    const u = new URL(link);
    const params = new Map<string, string>();
    u.searchParams.forEach((v, k) => { if (!params.has(k.toLowerCase())) params.set(k.toLowerCase(), v.trim()); });
    const cap = ACCELA_CAP_PARTS.map((k) => params.get(k) ?? "").filter(Boolean);
    if (cap.length === ACCELA_CAP_PARTS.length) id = cap.join("-");
    if (!id) for (const [k, v] of params) { if (DRAFT_ID_PARAM.test(k) && v) { id = v; break; } }
  } catch { /* an unparseable link carries no key */ }
  return { link, id: id.slice(0, 80) };
}
