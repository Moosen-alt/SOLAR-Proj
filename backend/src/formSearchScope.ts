// THE FORM SEARCH IS SCOPED TO THE AHJ'S STATE (issue #162).
//
// Owner's live run, 2026-10-04: findAhjFormUrl for the City of Monroe, Oregon (Benton County) spent its
// whole three-search budget on Monroe MI, Monroe CT and Monroe OH — "Search quota was exhausted before
// any City of Monroe, OREGON page could be retrieved" — and Stage then failed for want of the
// prescriptive application. Nothing in the queries or in the result handling said which Monroe.
// Two halves, both here so the prompt and the filter agree on what "this state" means:
//   - stateScopedFormQueries: every query the search is told to run carries the state's full name AND
//     its two-letter abbreviation;
//   - outOfStateResultState: a result whose host or title names a same-named place in ANOTHER state is
//     discarded before anything downstream (the forms-page read, the candidate downloads, the portal
//     the research teaches) can spend a request on it.
// Only ever REMOVES: a result that names no state, or names this one, is kept.
import { STATE_NAMES, hostStateOf, nameKeys } from "./permitPlatformCatalog";
import { portalHostOf, registrableDomain } from "./portalChannel";

/** "OR" / "or" / "Oregon" -> { code: "or", abbr: "OR", name: "Oregon" }; null for anything else. */
export function stateScopeOf(state: string | null | undefined): { code: string; abbr: string; name: string } | null {
  const raw = String(state ?? "").trim().toLowerCase();
  if (!raw) return null;
  const code = STATE_NAMES[raw] ? raw : Object.keys(STATE_NAMES).find((c) => STATE_NAMES[c] === raw.replace(/\s+/g, " "));
  if (!code) return null;
  const name = STATE_NAMES[code].replace(/\b[a-z]/g, (ch) => ch.toUpperCase()).replace(/\bOf\b/, "of");
  return { code, abbr: code.toUpperCase(), name };
}

/** The search queries the form search starts from: each names the AHJ, the state's full name and its
 *  abbreviation ("City of Monroe" Oregon OR building permit application pdf). [] for an unknown state. */
export function stateScopedFormQueries(ahj: string, state: string, formType = "permit_application"): string[] {
  const s = stateScopeOf(state);
  const name = String(ahj ?? "").trim();
  if (!s || !name) return [];
  const where = `"${name}" ${s.name} ${s.abbr}`;
  const wants = formType === "electrical_application"
    ? ["electrical permit application pdf", "building department forms applications"]
    : formType === "solar_checklist"
      ? ["solar photovoltaic permit checklist", "building department forms applications"]
      : ["building permit application pdf", "electrical permit application pdf", "building department forms applications"];
  return wants.map((w) => `${where} ${w}`);
}

/** The AHJ's place name without its type ("City of Monroe" -> "monroe", "Monroe Township" -> "monroe"). */
function placeOf(ahj: string): string {
  return String(ahj ?? "").toLowerCase()
    .replace(/,.*$/, "")
    .replace(/^\s*(?:the\s+)?(?:city|town|township|village|borough|county)\s+of\s+/, "")
    .replace(/\s+(?:city|town|township|twp|village|borough|county)\s*$/, "")
    .replace(/[^a-z\s'-]+/g, " ").replace(/\s+/g, " ").trim();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Type words that may sit between a place's name and its state ("Monroe Township, OH"). */
const TYPE_AFTER = "(?:\\s+(?:charter\\s+township|township|city|town|twp|village|borough|county)\\b)?";

/** The OTHER state a title places the AHJ's name in ("City of Monroe, MI", "Monroe, Michigan",
 *  "Monroe Township (OH)"), or "". An uppercase two-letter abbreviation only — "Monroe in the news" is
 *  not Indiana — and never in an all-caps title, where every word looks like one. */
function titleOtherState(title: string, place: string, target: string): string {
  const t = String(title ?? "");
  if (!t || !place) return "";
  const allCaps = t === t.toUpperCase();
  const found = new Set<string>();
  const re = new RegExp(`\\b${escapeRe(place).replace(/\\? /g, "[\\s-]+")}\\b${TYPE_AFTER}`, "gi");
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40);
    for (const [code, full] of Object.entries(STATE_NAMES)) {
      if (new RegExp(`^\\s*[,(]?\\s*${escapeRe(full).replace(/ /g, "\\s+")}\\b`, "i").test(after)) found.add(code);
      else if (!allCaps && new RegExp(`^\\s*(?:,|\\(|\\s)\\s*${code.toUpperCase()}\\b(?!['’])`).test(after)) found.add(code);
    }
  }
  // A title naming BOTH (a comparison page) is not evidence it is the wrong one.
  if (found.has(target)) return "";
  return [...found][0] ?? "";
}

/** The OTHER state a host names beside the AHJ's own name (monroemi.gov, monroe-ct.gov,
 *  monroetwpoh.org, cityofmonroemichigan.org), or a host on another state's locality / .gov domain
 *  (ci.monroe.mi.us, michigan.gov — permitPlatformCatalog.hostStateOf), or "". "co" alone is never read
 *  as Colorado: it is the usual abbreviation for county (monroeco.org). */
function hostOtherState(host: string, keys: string[], target: string): string {
  const h = String(host ?? "").toLowerCase().replace(/^www\./, "");
  if (!h) return "";
  const hs = hostStateOf(h);
  if (hs && hs.state !== target) return hs.state;
  const label = registrableDomain(h).split(".")[0].replace(/-/g, "");
  for (const key of keys) {
    const i = label.indexOf(key);
    if (i < 0) continue;
    const before = label.slice(0, i).replace(/^(?:cityof|townof|villageof|townshipof|countyof|ci|city|town|village)$/, "");
    if (before) continue; // something else precedes the name: not "<place><state>"
    const rest = label.slice(i + key.length).replace(/^(?:city|town|township|twp|village|borough|county)/, "");
    if (!rest || rest === target || rest === "co") continue;
    if (rest.length === 2 && STATE_NAMES[rest]) return rest;
    const full = Object.keys(STATE_NAMES).find((c) => STATE_NAMES[c].replace(/ /g, "") === rest);
    if (full && full !== target) return full;
  }
  return "";
}

/**
 * THE OTHER STATE a search result is about, when it names one for a place sharing the AHJ's name — its
 * host (monroemi.gov, ci.monroe.mi.us, michigan.gov) or its title ("City of Monroe, MI") — else "".
 * "" whenever the state is unknown: this only ever removes a result it can show is elsewhere.
 */
export function outOfStateResultState(result: { url: string; title?: string }, ahj: string, state: string): string {
  const s = stateScopeOf(state);
  if (!s) return "";
  const place = placeOf(ahj);
  const keys = nameKeys([place]);
  const fromHost = hostOtherState(portalHostOf(result.url), keys, s.code);
  if (fromHost) return fromHost;
  return titleOtherState(String(result.title ?? ""), place, s.code);
}

/** Split search results into this state's (or unplaced) and another state's same-named place's. */
export function scopeResultsToState<T extends { url: string; title?: string }>(results: T[], ahj: string, state: string): { kept: T[]; discarded: Array<T & { state: string }> } {
  const kept: T[] = [];
  const discarded: Array<T & { state: string }> = [];
  for (const r of results) {
    const other = outOfStateResultState(r, ahj, state);
    if (other) discarded.push({ ...r, state: other.toUpperCase() });
    else kept.push(r);
  }
  return { kept, discarded };
}
