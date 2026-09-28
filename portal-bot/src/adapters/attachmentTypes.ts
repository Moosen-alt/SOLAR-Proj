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
const NEVER = /homeowner\s*acknowledg|owner.?builder|contractor\s*responsibility/i;
const PLACEHOLDER = /^\s*(-+\s*)?(select|choose|please\s+select)\b/i;

export function attachmentTypeFor(docType: string, options: string[]): string | null {
  const usable = options.map((o) => String(o ?? "").replace(/\s+/g, " ").trim()).filter((o) => o && !PLACEHOLDER.test(o) && !NEVER.test(o));
  const find = (re: RegExp): string | null => usable.find((o) => re.test(o)) ?? null;
  const other = (): string | null => find(/^other\b/i);
  const t = String(docType || "").toLowerCase();
  if (/_application$/.test(t)) return find(/\bapplication\b/i) ?? other();
  if (t === "solar_checklist" || /checklist/.test(t)) return find(/\bchecklist\b/i) ?? other();
  if (/authori[sz]ation/.test(t)) return find(/\bauthori[sz]ation\b/i) ?? other();
  if (/^(structural_letter|structural_calcs?|pe_letter|engineer_letter)$/.test(t)) return find(/structural\s*calc/i);
  if (/_spec(s|_sheet)?$/.test(t) || t === "spec_sheet") return find(/\bspecifications?\b/i);
  if (t === "site_plan") return find(/site\s*plan/i);
  return null;
}
