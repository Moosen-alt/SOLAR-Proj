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
//
// THE ISSUING AGENCY DECIDES THE ROW WHEN IT IS KNOWN (production 2026-09-27, City of Jefferson
// OR). CITY-for-structural / COUNTY-for-electrical is Coos Bay's convention — Coos Bay issues its
// own building permits. Jefferson's are issued by MARION COUNTY, so the convention would take the
// city's row for a structural filing: the wrong agency. The per-job lookup's issuing agency for the
// track (backend permitProcess.issuingAgencyFor) now decides; the convention applies only when the
// agency is unknown, is neither a city nor a county, names both, or names no row this grid offers
// — and in every one of those cases the preference SAYS so (`note`), rather than silently
// reverting. No row is ever "matched" to an agency its own text does not name: the county row
// counts as Marion County's only because it reads "COUNTY APPLICATIONS … MARION …".
//
// ONE predicate for every door that clicks a row: the learner (autoLearnAdapter
// chooseProjectAddressRow, siteIdentity.issuingAgency), the replay (recipeAdapter
// pickAddressVersionLive, fieldValues.issuingAgency), the hand-coded Oregon adapter, and the
// backend's decision to lend a recipe across agencies (recipeReplayBinding imports issuingAgencyRow).

export interface AddressVersion {
  index: number;
  text: string;
  score: number;
  ownerHit: boolean;
  /** "county" / "city" when the row carries that jurisdiction marker, else "". */
  kind: "county" | "city" | "";
  /** The row names the issuing agency (its kind AND its place). */
  agencyHit: boolean;
}

/** Who and where the project is, for choosing between versions of an address. Not fill data. */
export interface SiteIdentity {
  city?: string;
  zip?: string;
  homeownerName?: string;
  isElectrical?: boolean;
  /** The agency the per-job lookup says issues THIS track's permit ("Marion County"). */
  issuingAgency?: string | null;
}

/** The issuing agency, read as the jurisdiction row it files under. */
export interface AgencyRow {
  /** "county" / "city"; "" when the name is empty, is neither, or names both (ambiguous). */
  kind: "county" | "city" | "";
  /** The place the agency is named for, upper-case ("MARION", "COOS BAY"); "" when kind is "". */
  place: string;
  /** Names BOTH a city and a county ("City of Jefferson / Marion County") — never guessed between. */
  ambiguous: boolean;
}

export interface AddressRowPreference {
  /** What decided the +2: the issuing agency, or the discipline convention. */
  basis: "agency" | "discipline";
  /** An issuing agency was supplied and no row of this property names it. */
  agencyUnmatched: boolean;
  /** ...and the top-ranked row is positively the OTHER kind of jurisdiction (a CITY row for a
   *  county agency, or the reverse). A door about to file must not click it. */
  contradicts: boolean;
  /** One operator-readable line; "" when no agency was supplied. */
  note: string;
}

// Words that follow the place in an agency's name and are not part of it.
const AGENCY_TAIL = /\s+(?:building|planning|permit(?:s|ting)?|community|development|department|dept\.?|division|office|services?|inspections?|codes?|safety|government|commission|board|hall|zoning)\b.*$/i;
const placeOf = (s: string): string => s.replace(/\s+/g, " ").replace(AGENCY_TAIL, "").replace(/^the\s+/i, "").replace(/[\s,.;:()'-]+$/g, "").trim().toUpperCase();

/** "Marion County" → county MARION; "City of Coos Bay" → city COOS BAY; a bare name equal to the
 *  project's city → that city; a name carrying both → ambiguous; anything else → "". */
export function issuingAgencyRow(name: string | null | undefined, opts: { city?: string | null } = {}): AgencyRow {
  const n = String(name ?? "").replace(/\s+/g, " ").trim();
  const none: AgencyRow = { kind: "", place: "", ambiguous: false };
  if (!n) return none;
  const countyOf = /\bcounty of\s+([A-Za-z][A-Za-z .'-]*)/i.exec(n);
  const countyNamed = /([A-Za-z][A-Za-z .'-]*?)\s+county\b/i.exec(n);
  const cityOf = /\b(?:city|town|village) of\s+([A-Za-z][A-Za-z .'-]*)/i.exec(n);
  const cityHall = /([A-Za-z][A-Za-z .'-]*?)\s+city hall\b/i.exec(n);
  const cityNamed = cityHall ? null : /([A-Za-z][A-Za-z .'-]*?\s+city)\b/i.exec(n); // "Oregon City"
  const county = countyOf ? placeOf(countyOf[1]) : countyNamed ? placeOf(countyNamed[1]) : "";
  const city = cityOf ? placeOf(cityOf[1]) : cityHall ? placeOf(cityHall[1]) : cityNamed ? placeOf(cityNamed[1]) : "";
  if (county && city) return { kind: "", place: "", ambiguous: true };
  if (county) return { kind: "county", place: county, ambiguous: false };
  if (city) return { kind: "city", place: city, ambiguous: false };
  const projectCity = placeOf(String(opts.city ?? ""));
  const bare = placeOf(n);
  if (projectCity && bare === projectCity) return { kind: "city", place: bare, ambiguous: false };
  return none;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasPhrase = (upper: string, phrase: string) => Boolean(phrase) && new RegExp(`(^|[^A-Z0-9])${escapeRe(phrase)}([^A-Z0-9]|$)`).test(upper);
const COUNTY_ROW = /\bCOUNTY APPLICATIONS\b/i;
const CITY_ROW = /\bCITY APPLICATIONS\b/i;

/** The jurisdiction marker a row carries ("" when none, or both). */
function rowKind(upper: string): "county" | "city" | "" {
  const county = COUNTY_ROW.test(upper);
  const city = CITY_ROW.test(upper);
  return county && !city ? "county" : city && !county ? "city" : "";
}

/** The row names the agency: its jurisdiction kind AND its place ("COUNTY APPLICATIONS … MARION"),
 *  or the agency's own name ("MARION COUNTY", "CITY OF COOS BAY"). */
function rowNamesAgency(upper: string, agency: AgencyRow): boolean {
  const p = agency.place;
  if (!p) return false;
  if (agency.kind === "county") return (COUNTY_ROW.test(upper) && hasPhrase(upper, p)) || hasPhrase(upper, `${p} COUNTY`) || hasPhrase(upper, `COUNTY OF ${p}`);
  if (agency.kind === "city") {
    return (CITY_ROW.test(upper) && hasPhrase(upper, p))
      || ["CITY", "TOWN", "VILLAGE"].some((w) => hasPhrase(upper, `${w} OF ${p}`));
  }
  return false;
}

const conventionLabel = (isElectrical: boolean) => (isElectrical ? "COUNTY APPLICATIONS" : "CITY APPLICATIONS");

/** The row label to aim at when there is no grid to rank (a single result, no identity): the
 *  agency's kind when the agency is a city or a county, else the discipline convention. */
export function preferredRowLabel(opts: { issuingAgency?: string | null; city?: string | null; isElectrical: boolean }): "CITY APPLICATIONS" | "COUNTY APPLICATIONS" {
  const a = issuingAgencyRow(opts.issuingAgency, { city: opts.city });
  if (a.kind === "county") return "COUNTY APPLICATIONS";
  if (a.kind === "city") return "CITY APPLICATIONS";
  return conventionLabel(opts.isElectrical);
}

export function rankAddressVersions(
  rowTexts: string[],
  opts: { city?: string; zip?: string; homeownerName?: string; isElectrical: boolean; issuingAgency?: string | null },
): { ranked: AddressVersion[]; rejected: string[]; preference: AddressRowPreference } {
  const cityUpper = (opts.city || "").toUpperCase();
  const zip = (opts.zip || "").trim();
  const surname = (opts.homeownerName || "").trim().split(/\s+/).pop() || "";
  const convention = opts.isElectrical ? COUNTY_ROW : CITY_ROW;
  const agencyName = String(opts.issuingAgency ?? "").replace(/\s+/g, " ").trim();
  const agency = issuingAgencyRow(agencyName, { city: opts.city });
  const candidates: Array<{ index: number; text: string; upper: string }> = [];
  const rejected: string[] = [];
  for (let index = 0; index < rowTexts.length; index++) {
    const text = (rowTexts[index] || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const upper = text.toUpperCase();
    if (!((cityUpper && upper.includes(cityUpper)) || (zip && text.includes(zip)))) { rejected.push(text.slice(0, 60)); continue; }
    candidates.push({ index, text, upper });
  }
  // The agency decides only when a row of this property NAMES it; otherwise no row is invented.
  const agencyHits = agency.kind ? candidates.map((c) => rowNamesAgency(c.upper, agency)) : candidates.map(() => false);
  const byAgency = agencyHits.some(Boolean);
  const ranked: AddressVersion[] = candidates.map((c, i) => {
    // Owner of record is the strongest signal available — each version can be a different
    // parcel — so a surname hit outranks the jurisdiction preference. DEQ ranks last: it
    // issues onsite/septic permits, never a residential structural or electrical one.
    const ownerHit = surname.length >= 3 && c.upper.includes(surname.toUpperCase());
    const preferred = byAgency ? agencyHits[i] : convention.test(c.text);
    const score = (ownerHit ? 4 : 0) + (preferred ? 2 : 0) + (/DEQ/i.test(c.text) ? -3 : 0);
    return { index: c.index, text: c.text, score, ownerHit, kind: rowKind(c.upper), agencyHit: agencyHits[i] };
  });
  ranked.sort((a, b) => b.score - a.score);

  const conv = `${conventionLabel(opts.isElectrical)} for ${opts.isElectrical ? "electrical" : "structural"}`;
  let note = "";
  let agencyUnmatched = false;
  let contradicts = false;
  if (agencyName) {
    if (byAgency) {
      note = `ranked by the issuing agency ${agencyName}: the ${agency.kind.toUpperCase()} row naming ${agency.place}`;
    } else if (agency.ambiguous) {
      note = `the issuing agency "${agencyName}" names both a city and a county — ranked by the discipline convention (${conv})`;
    } else if (!agency.kind) {
      note = `the issuing agency ${agencyName} is neither a city nor a county — ranked by the discipline convention (${conv})`;
    } else {
      agencyUnmatched = true;
      const top = ranked[0];
      contradicts = Boolean(top && top.kind && top.kind !== agency.kind);
      note = `the issuing agency ${agencyName} names none of this property's ${candidates.length} version(s) (no ${agency.kind.toUpperCase()} row naming ${agency.place}) — no row invented; ranked by the discipline convention (${conv})`
        + (contradicts ? `, whose pick is a ${top!.kind.toUpperCase()} row while ${agencyName} is a ${agency.kind}` : "");
    }
  }
  return { ranked, rejected, preference: { basis: byAgency ? "agency" : "discipline", agencyUnmatched, contradicts, note } };
}
