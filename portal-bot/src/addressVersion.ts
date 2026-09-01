// WHICH VERSION OF AN ADDRESS IS THIS PROJECT'S?
//
// Permit portals disambiguate a street address with a grid: the same house appears once per
// issuing jurisdiction ("City Applications", "COUNTY APPLICATIONS", "DEQ Applications"), each
// row a DIFFERENT parcel with its own owner of record, and the permit types on offer differ
// per row. Two ways to get this wrong, both unrecoverable once filed:
//
//   - pick the wrong jurisdiction and the permit type you need is not offered (live: DEQ
//     issues onsite/septic and nothing else, and the run sat on "No Building services were
//     returned for this address");
//   - pick a row for a different property entirely — the street search is loose enough that
//     "119 7th" returns Milton Freewater, Portland, Corvallis and Pendleton.
//
// So: rows for another city or ZIP are REJECTED outright, never merely ranked low. Among the
// versions of this property, order is a hint and never a filter, because the operator's rule
// is that a single record often carries BOTH disciplines.
//
// Lives outside any one adapter: the auto-learn engine is the first-line path for these
// portals (it outranks the hand-coded adapters), so the discipline has to be reachable from
// there too, and the generic engine must not import a portal adapter to get it.

export interface AddressVersion { index: number; text: string; score: number; ownerHit: boolean }

export function rankAddressVersions(
  rowTexts: string[],
  opts: { city?: string; zip?: string; homeownerName?: string; isElectrical: boolean },
): { ranked: AddressVersion[]; rejected: string[] } {
  const cityUpper = (opts.city || "").toUpperCase();
  const zip = (opts.zip || "").trim();
  const surname = (opts.homeownerName || "").trim().split(/\s+/).pop() || "";
  const preferred = opts.isElectrical ? /COUNTY APPLICATIONS/i : /CITY APPLICATIONS/i;
  const ranked: AddressVersion[] = [];
  const rejected: string[] = [];
  for (let index = 0; index < rowTexts.length; index++) {
    const text = (rowTexts[index] || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const upper = text.toUpperCase();
    if (!((cityUpper && upper.includes(cityUpper)) || (zip && text.includes(zip)))) { rejected.push(text.slice(0, 60)); continue; }
    // Owner of record is the strongest signal available — each version can be a different
    // parcel — so a surname hit outranks the jurisdiction convention. DEQ ranks last: it
    // issues onsite/septic permits, never a residential structural or electrical one.
    const ownerHit = surname.length >= 3 && upper.includes(surname.toUpperCase());
    const score = (ownerHit ? 4 : 0) + (preferred.test(text) ? 2 : 0) + (/DEQ/i.test(text) ? -3 : 0);
    ranked.push({ index, text, score, ownerHit });
  }
  ranked.sort((a, b) => b.score - a.score);
  return { ranked, rejected };
}
