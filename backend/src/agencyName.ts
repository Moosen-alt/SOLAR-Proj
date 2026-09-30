// AGENCY-NAME IDENTITY — pure, no database, no lookup stack.
//
// Moved out of permitProcessLookup.ts unchanged (split-issuer, 2026-09-28) so permitProcess can ask
// "is this cited agency THAT agency itself" (sameAgencyName) for the per-track issuer without
// importing the lookup module back — permitProcessLookup imports permitProcess, and pulling it in
// would make a cycle through half the lookup stack. permitProcessLookup re-exports the two public
// helpers, so every existing importer keeps compiling.

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

// The DISTINCTIVE words of a name must be in the quote ("Marion" of "Marion County Public Works –
// Building Inspection Division"); the generic organisational words need not be.
export const GENERIC_ORG_WORDS = new Set(["public", "works", "building", "inspection", "inspections", "division", "department", "dept", "services", "service",
  "development", "community", "permit", "permits", "permitting", "office", "program", "codes", "code", "planning", "bureau", "agency", "government"]);
/** The words a DEPARTMENT adds to an agency's name ("Permit Center", "Building Inspections
 *  Division", "Development Services", "Planning & Zoning", "City Hall"): GENERIC_ORG_WORDS and the
 *  rest. ONE set, read by agencyName (the saved value) and agencyNameKey (the identity question). */
export const DEPARTMENT_WORDS = new Set([...GENERIC_ORG_WORDS, "center", "centre", "hall", "zoning", "land", "use", "engineering", "safety", "official", "officials", "inspector", "inspectors", "section", "unit", "team", "staff", "administration", "admin", "regulatory", "compliance", "review", "reviews", "enforcement", "wires", "wire", "electrical", "electric", "mechanical", "plumbing"]);
/** A connector joins a name to a department phrase ("Division OF Building Safety", "Building AND
 *  Safety"). The saved NAME pops through "and" / "&" only between two department words ("Planning
 *  and Development Services" is one phrase) and never through "of"; the identity KEY pops through any. */
export const CONNECTOR_WORDS = new Set(["of", "and", "&", "the", "for"]);
export const AND_WORDS = new Set(["and", "&"]);
export const JURISDICTION_TYPE_WORDS = "city|town|county|village|borough|township|parish";
/**
 * THE TRAILING DEPARTMENT PHRASE, ONE WAY (lookup-close-6 MF6 — fba1e45 popped "Idaho Division of
 * Building Safety" to "Idaho Division of" and saved it). A dangling trailing connector is a
 * truncation ("Santa Fe County Building and") and goes first; then the trailing department words go;
 * a result that ends in a connector popped INTO a department phrase ("Idaho Division of |Building
 * Safety|", "…Department of |Building and Safety|"):
 *   - the saved NAME pops on through "and" / "&" only when the word before it is a department word
 *     too ("Planning and Development Services" -> gone; "Regulation and Licensing" stays), never
 *     through "of", and otherwise keeps the unstripped name (never a dangling "of" / "and", never a
 *     state's bare name for its building division);
 *   - the identity KEY pops through any connector and the phrase before it (a department phrase is
 *     not identity: the City of Los Angeles Department of Building and Safety IS the City of Los
 *     Angeles).
 */
export function stripDepartmentPhrase(tokens: string[], through: boolean): string[] {
  const low = tokens.map((t) => t.toLowerCase());
  let end = low.length;
  while (end > 1 && CONNECTOR_WORDS.has(low[end - 1])) end--;
  const trimmed = end;
  for (;;) {
    while (end > 1 && DEPARTMENT_WORDS.has(low[end - 1])) end--;
    if (!(end > 1 && CONNECTOR_WORDS.has(low[end - 1]))) break;
    if (!through) {
      if (!(AND_WORDS.has(low[end - 1]) && end > 2 && DEPARTMENT_WORDS.has(low[end - 2]))) return tokens.slice(0, trimmed);
      end--;
      continue;
    }
    while (end > 1 && CONNECTOR_WORDS.has(low[end - 1])) end--;
  }
  return tokens.slice(0, end);
}
/** The identity key of an agency's name: lower case, punctuation gone, a leading "the" and a
 *  trailing ", XX" state gone, the trailing department phrase gone (stripDepartmentPhrase, through
 *  its connectors: "City of Charleston Permit Center /", "Marion County Public Works Building
 *  Inspection Division"), and the jurisdiction type in ONE form (lookup-close-6 MF5: a county site
 *  styles itself "County of Marin" and the product's AHJ is "Marin County"): "<type> of X" is
 *  "X <type>" ("county of marin" -> "marin county", "township of cherry hill" -> "cherry hill
 *  township", "city of iowa city" -> "iowa city"), and a consolidated "city and county of X" is X
 *  ("city and county of denver" -> "denver"). The type word stays: it is identity. */
export function agencyNameKey(name: unknown): string {
  const tokens = str(name).toLowerCase().replace(/,\s*[a-z]{2}\.?\s*$/, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  if (tokens[0] === "the") tokens.shift();
  let k = stripDepartmentPhrase(tokens, true).join(" ");
  k = k.replace(/^city and county of (.+)$/, "$1");
  const m = new RegExp(`^(${JURISDICTION_TYPE_WORDS}) of (.+)$`).exec(k);
  if (m) k = m[2].endsWith(` ${m[1]}`) ? m[2] : `${m[2]} ${m[1]}`;
  return k;
}
/** ONE predicate for "is this cited agency THAT agency itself" (lookup-close-5, MF4): the keys are
 *  equal (one form per jurisdiction type — agencyNameKey), or equal once the type word is removed
 *  when exactly ONE side carries one ("Charleston Permit Center" is the City of Charleston; a typeless
 *  name beside a typed one is that agency — the design's caveat: "Charleston Permit Center" beside
 *  "Charleston County" reads as the county too) or both carry a MUNICIPAL one (city / town / village /
 *  borough — a municipality is never two of these, so "City of Venus" for the Town of Venus is a
 *  spelling, not another agency). Two names typed county / township / parish against a different
 *  type are two agencies (Charleston County is not the City of Charleston; Marion County is not the
 *  City of Marion nor the City of Jefferson — the delegation the fee rows carry). Read by
 *  issuedByPublisher (whose portal a permit takes), liftAgreedAgency / agenciesToAsk (which agencies
 *  the parts ask), applyLookupFees (whether the AHJ's fee row delegates to another authority) and
 *  mergeWithEarlier — a department suffix, a stray "/" or "County of X" for "X County" must never
 *  turn the AHJ's own fee into a phantom delegation. */
export function sameAgencyName(a: unknown, b: unknown): boolean {
  const ka = agencyNameKey(a);
  const kb = agencyNameKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const typeOf = (k: string): string => new RegExp(`\\b(${JURISDICTION_TYPE_WORDS})$`).exec(k)?.[1] ?? "";
  const ta = typeOf(ka);
  const tb = typeOf(kb);
  if (!ta && !tb) return false;
  const municipal = /^(?:city|town|village|borough)$/;
  if (ta && tb && !(municipal.test(ta) && municipal.test(tb))) return false;
  const bare = (k: string) => k.replace(new RegExp(` (?:${JURISDICTION_TYPE_WORDS})$`), "");
  return bare(ka) === bare(kb);
}
