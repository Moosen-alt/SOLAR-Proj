// WHICH "TYPE" AN ATTACHMENT ROW TAKES (docs plan D7, operator decision OD-2, 2026-09-27).
//
// A generic attachment widget (Accela's "Add" → Description + Type → Save) asks one Type per file, from
// the portal's OWN list. The Type is chosen by the DOCUMENT, never by the permit: a Marion County B-01S
// on the building permit is an application ("Other" on Oregon ePermitting's list, which has no
// "Application" option), not "Plans - Structural". Read against the row's LIVE options; null = no option
// fits, and the document is then named NOT ATTACHED rather than filed under a guess.
//
// NEVER chosen for any document: the owner-builder path ("Homeowner Acknowledgement") and the
// contractor-responsibility form — each is a legal statement the document is not.
//
// ONE QUESTION, ONE PREDICATE (2026-09-28, City of Corvallis): "is this select a DOCUMENT-TYPE list?" was
// answered by three copies of one regex (the learner's accelaAttachmentSavePass and the replay's
// typeOptionsOf / pendingAttachmentRow). Corvallis numbers its Types — "01 Plans", "02 Specifications or
// Engineering", "03 Other Documents" — the "01 " defeated every copy, the learner never chose a Type, the
// Save was refused ("Your documents are not yet saved") and a person picked it by hand. The answer lives
// here now, for every door: isDocumentTypeList reads each option with its leading ordinal/code stripped,
// and attachmentTypeFor maps on that stripped text but returns the portal's own option text.
const NEVER = /homeowner\s*acknowledg|owner.?builder|contractor\s*responsibility/i;
const PLACEHOLDER = /^\s*(-+\s*)?(select|choose|please\s+select)\b/i;

const collapse = (o: unknown): string => String(o ?? "").replace(/\s+/g, " ").trim();

/** A LEADING ORDINAL OR CODE is numbering, not meaning: "01 Plans", "1. Plans", "1) Plans", "(1) Plans",
 *  "1.2 Plans", "A. Plans", "A- Plans", "A) Plans" all read "Plans". A number needs whitespace or
 *  punctuation after it; a single LETTER needs punctuation ("Plans - Structural" keeps its P). Stripped
 *  once, never repeatedly. */
export function stripOptionCode(text: string): string {
  const t = collapse(text);
  const m = t.match(/^[([]?\d{1,3}(?:\.\d{1,3})*(?:\s*[)\].:\-–—]\s*|\s+)(?=\S)/)
    ?? t.match(/^[([]?[a-z]\s*[)\].:\-–—]\s*(?=\S)/i);
  return m ? t.slice(m[0].length) : t;
}

// A STRONG word names a document-type list on its own. The first two are the three copies' own tests,
// kept verbatim (a strict superset: nothing recognised before stops being recognised); the rest is the
// document vocabulary a numbered list reads as once its code is stripped. Bare "Engineering" / "Structural"
// are NOT here — a department list (Building / Engineering / Planning / Fire) is not a document list;
// "Specifications or Engineering" is caught by "Specifications", "Structural Calculations" below.
const STRONG: RegExp[] = [
  /plans?\s*[-–—]/i,
  /^(plans|calculations|photos?|forms?)\b/i,
  /^(plan|drawings?)(\s*sets?)?(\s*[-–—:(]|\s+(and|or|&)\s|$)/i,
  /^(site|construction|building|architectural|electrical|structural|mechanical|plumbing|civil|landscape|floor|roof|framing|foundation)\s+(plans?|drawings?)\b/i,
  /^specifications?\b/i,
  /^spec(ification)?\s*sheets?\b/i,
  /^(data|cut)\s*sheets?\b/i,
  /^(structural|engineering|engineer'?s?)\s+(calculations?|calcs|letters?|reports?|documents?|drawings?|plans?)\b/i,
  /^calcs\b/i,
  /^photo(graph)?s?\b/i,
  /^(other|supporting|additional|miscellaneous|misc\.?)\s+documents?\b/i,
];
// A WEAK word is document vocabulary that also names other things ("Application Received" is a status,
// "New Application" an application type). Weak words count by CATEGORY and a list needs two different
// ones — so a status list or an "Application Type" list (one kind of word, perhaps beside "Other") stays
// out. "Other" never counts at all (skeptic 13985c6 S5: a Category of Construction offers "Other" too).
const WEAK: Array<[string, RegExp]> = [
  ["application", /\bapplications?\b/i],
  ["checklist", /\bchecklists?\b/i],
  ["authorization", /\bauthori[sz]ations?\b/i],
  ["worksheet", /\bworksheets?\b/i],
];

/** IS THIS SELECT A DOCUMENT-TYPE LIST? The one answer for the learner (accelaAttachmentSavePass) and the
 *  replay (typeOptionsOf, pendingAttachmentRow). At least two real (non-placeholder) options — an "also
 *  attach to" select offering only "--Select--" is never one — and either a strong document word, or two
 *  weak categories of document word, read on each option as written AND with its ordinal stripped. */
export function isDocumentTypeList(options: string[]): boolean {
  const usable = (options ?? []).map(collapse).filter((o) => o && !PLACEHOLDER.test(o));
  if (usable.length < 2) return false;
  const readings = usable.map((o) => [o, stripOptionCode(o)]);
  if (readings.some((rs) => rs.some((r) => STRONG.some((re) => re.test(r))))) return true;
  const cats = new Set<string>();
  for (const rs of readings) for (const [cat, re] of WEAK) if (rs.some((r) => re.test(r))) cats.add(cat);
  return cats.size >= 2;
}

/** The plan-set family of docTypes (docDiscipline.ts's aliases): the document an attachment row's
 *  recorded upload most often carries. */
export function isPlanSetDocType(docType: string): boolean {
  return /^(plan_set|combined_plan_set|full_plan_set|plan|plans|plan_pdf|stamped_plans)$/i.test(String(docType || "").trim());
}

/** THE TYPE THIS DOCUMENT TAKES on this list: the portal's option text (whitespace collapsed — what a
 *  select-by-label matches), chosen by the document's meaning on the option's CODE-STRIPPED text.
 *  `discipline` ("structural" | "electrical", docDiscipline.ts's vocabulary; anything not electrical is
 *  structural, the learner's own convention) picks the plan set's "Plans - <trade>" where the list splits
 *  plans by trade. Every KNOWN document family falls back to the list's "Other" when nothing fits better;
 *  a document of no known family returns null — it is never guessed. */
export function attachmentTypeFor(docType: string, options: string[], opts: { discipline?: string } = {}): string | null {
  const usable = (options ?? []).map(collapse).filter((o) => o && !PLACEHOLDER.test(o) && !NEVER.test(o));
  const items = usable.map((exact) => ({ exact, norm: stripOptionCode(exact) })).filter((i) => i.norm && !NEVER.test(i.norm));
  const first = (...res: RegExp[]): string | null => {
    for (const re of res) { const hit = items.find((i) => re.test(i.norm)); if (hit) return hit.exact; }
    return null;
  };
  const other = (): string | null => first(/^other\b/i, /^(supporting|additional|miscellaneous|misc\.?)\s+documents?\b/i);
  const FORMS = /^forms?\b/i;
  // Plans with no trade named: "Plans" / "Drawings" / "Plan Set" alone, "Plans and Specifications",
  // "Construction Plans". Unqualified beats the first "Plans - <sub>" on purpose.
  const plansGeneric = (): string | null => first(
    /^(plans?|drawings?|plan\s*sets?)$/i,
    /^(plans?|drawings?)\s+(and|or|&)\s/i,
    /^(construction|building|permit|project|complete|full)\s+(plans?|drawings?|plan\s*sets?)\b/i,
  );
  const t = String(docType || "").toLowerCase();
  if (isPlanSetDocType(t)) {
    const trade = /elec/i.test(String(opts.discipline ?? "")) ? "electrical" : "structural";
    return first(new RegExp(`^plans?\\s*[-–—:]?\\s*${trade}\\b`, "i"), new RegExp(`^${trade}\\s+(plans?|drawings?)\\b`, "i"))
      ?? plansGeneric()
      // Anything else that names plans — the learner's last resort before this module existed.
      ?? first(/\bplans?\b/i, /\bdrawings?\b/i)
      ?? other();
  }
  if (/_application$/.test(t)) return first(/\bapplications?\b/i, FORMS) ?? other();
  if (t === "solar_checklist" || /checklist/.test(t)) return first(/\bchecklists?\b/i, FORMS) ?? other();
  if (/authori[sz]ation/.test(t)) return first(/\bauthori[sz]ations?\b/i, FORMS) ?? other();
  if (/^(structural_letter|structural_calcs?|structural_calculations?|pe_letter|engineer_letter|engineering_letter|calcs|calculations)$/.test(t)) {
    return first(/structural\s*calc/i, /\bengineering\b/i, /^(calculations?|calcs)\b/i) ?? other();
  }
  if (/_spec(s|_sheet)?$/.test(t) || t === "spec_sheet") {
    return first(/\bspecifications?\b/i, /\bspec(ification)?\s*sheets?\b/i, /\b(data|cut)\s*sheets?\b/i) ?? other();
  }
  if (t === "site_plan") return first(/site\s*plan/i) ?? plansGeneric() ?? other();
  return null;
}
