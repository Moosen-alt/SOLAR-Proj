// THE PORTAL FROM THE AGENCY'S OWN PAGE, AND THE RECORD TYPE FROM THE PORTAL'S OWN CATALOG
// (lookup-recall-2, 2026-09-26). Invariants for an UNKNOWN AHJ — no city is named in this file:
//
//   1. PORTAL RESOLVED FROM A PAGE WE READ. An agency page (official: isOfficialAgencyHost — .gov,
//      a <x>.<st>.us locality, or the agency's own domain) links an application portal. A link counts
//      when its target is on a permit-software VENDOR's host (accela.com, tylerhost.net, …), its words
//      or target path NAME an application portal (never a concern / 311 / parcel-viewer link, a
//      vendor's own site, SolarAPP+), AND its tenant is this agency's (named by the tenant, the only
//      one on the pages, or our read shows it) — or on the agency's OWN domain AND our read of that
//      target shows a permit platform (its markers, or a redirect onto a vendor
//      host). A same-domain page whose words name the portal ("Community Development Hub", "online
//      portal") is followed ONE hop. Every candidate passes rule 5 (hostFitsTrackAndEntity on the
//      permit track: never a utility / interconnection portal, never a help page or a document).
//   2. PLATFORM BY THE PAGE'S OWN MARKERS, not only its host: an Accela Citizen Access tenant on a
//      city's own domain is still ACA ("Accela Citizen Access", Cap/CapHome.aspx, agencyCode).
//   3. THE PORTAL'S OWN CATALOG, logged out, read-only: Tyler EnerGov CSS publishes every apply-able
//      type through its public tenant menu (api/Home/Menu, with the tenant headers its own page
//      sends); Accela ACA lists record types in its public search form (ddlGSPermitType). The solar
//      types are chosen by the PORTAL'S labels; several (SolarAPP+ vs standard, Prescriptive vs Non
//      Prescriptive) are all returned with the condition that selects each — the plan path decides,
//      and when it cannot, the operator is asked. Nothing is kept from a type the catalog did not list.
//   4. PREREQUISITES AND CODES FROM THE WORDS ON A PAGE WE READ — each a sentence quoted verbatim.
import type { PermitProcessDiscipline } from "../../shared/src/types";
import type { PageLink, PageReader, ReadPage } from "./agencyPageReader";
import { hostFitsTrackAndEntity, isPathTenantedHost, isPermitPlatformUrl, isUtilityPlatformUrl, isVendorRootOrMarketing, portalHostOf, portalTenantKey, portalTenantOf, registrableDomain } from "./portalChannel";
// registrableDomain and isVendorRootOrMarketing live in portalChannel (lookup-close-6 MF4: the
// lookup's portal door asks "is this the vendor's own site?" too, so the ONE predicate sits beside
// the host lists); re-exported here for the callers that import them from the catalog.
export { isVendorRootOrMarketing, registrableDomain };

export type PermitPlatform = "energov" | "accela" | "other";

const GENERIC_NAME_WORDS = new Set(["city", "county", "town", "village", "the", "of", "and", "department", "division", "building", "services", "community", "development", "public", "works", "inspection", "inspections", "permit", "permits", "office", "unincorporated", "township", "borough", "parish", "state", "government", "planning", "code", "codes", "enforcement", "regional", "agency"]);
/** The distinctive keys of an agency's / AHJ's names: each non-generic word (>= 3 letters) and the
 *  run-together name ("santafe", "northerncambria"). "Lee County" -> ["lee"]. */
export function nameKeys(names: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    const ws = String(n ?? "").toLowerCase().replace(/[^a-z\s-]+/g, " ").split(/[\s-]+/).filter((w) => w && !GENERIC_NAME_WORDS.has(w));
    for (const w of ws) if (w.length >= 3) out.add(w);
    if (ws.length > 1 && ws.join("").length >= 5) out.add(ws.join(""));
  }
  return [...out];
}
/** The initials of a name without its leading "City of" ("Iowa City" -> "ic"). */
function initialsOf(name: string): string {
  const ws = String(name ?? "").toLowerCase().replace(/^\s*(?:the\s+)?(?:city|town|county|village|borough|township)\s+of\s+/, "").split(/[^a-z]+/).filter((w) => w && !["of", "the", "and"].includes(w));
  return ws.length >= 2 ? ws.map((w) => w[0]).join("") : "";
}
const US_STATES = new Set("al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc".split(" "));
/**
 * An AGENCY'S OWN page (close F2 — no /city|county|gov/ substring or ^co shortcut: countyoffice.org,
 * codepublishing.com, citybizlist.com, cityfeet.com, govpilot.com and comcast.com all passed those):
 *   - a government TLD (.gov / .mil), or a US locality domain (<x>.<st>.us: city.waltham.ma.us,
 *     co.marion.or.us) — never a bare .us (mygov.us is a vendor);
 *   - or the AGENCY'S OWN DOMAIN: once its official affixes are removed (cityof / townof / countyof /
 *     city / county / town / twp / boro / gov / co / ci, and THIS job's state's two letters), the label
 *     is exactly one of the name's distinctive keys, or its initials after a "gov" / "cityof" affix:
 *     cityofevanston.org, clarkcountynv.gov, leegov.com (lee + gov), icgov.org (Iowa City's initials +
 *     gov), cityofgp.com, tigard-or.gov. A same-named place in another state (leecova.org for Lee
 *     County, FL) is not.
 * A vendor's host, a directory, a news or code-publishing site is not.
 */
export function isOfficialAgencyHost(host: string, names: string[], state?: string): boolean {
  const h = String(host ?? "").toLowerCase().replace(/^www\./, "");
  if (!h || isPermitPlatformUrl(`https://${h}/`)) return false;
  if (/\.(?:gov|mil)$/.test(h)) return true;
  const us = /\.([a-z]{2})\.us$/.exec(h);
  if (us && US_STATES.has(us[1])) return !state || us[1] === String(state).toLowerCase();
  return isAgencyOwnDomain(h, names, state);
}
const STATE_NAMES: Record<string, string> = { al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado", ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey", nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina", sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming", dc: "district of columbia" };
/** A name that IS the state (its agency): "State of Minnesota", "Minnesota Department of Labor and
 *  Industry", "Oregon Building Codes Division" — never a place named after it ("Iowa City", "Kansas
 *  City", "Nevada County", "Washington Township": the state's name followed by a jurisdiction type). */
function namesTheState(names: string[], st2: string): boolean {
  const full = STATE_NAMES[st2];
  if (!full) return false;
  return names.some((n) => {
    const s = String(n ?? "").toLowerCase().replace(/[^a-z\s]+/g, " ").replace(/\s+/g, " ").trim().replace(/^(?:the )?(?:state|commonwealth) of /, "");
    if (s !== full && !s.startsWith(`${full} `)) return false;
    return !/^(?:city|county|town|township|twp|village|borough|boro|parish)\b/.test(s.slice(full.length).trim());
  });
}
/** A domain label that IS a state's own ("oregon", "wa", "newyork") — the state code, or "". */
function stateCodeOfLabel(label: string): string {
  const l = String(label ?? "").toLowerCase().replace(/-/g, "");
  return Object.keys(STATE_NAMES).find((c) => l === c || l === STATE_NAMES[c].replace(/ /g, "")) ?? "";
}
/** A `.us` locality domain's labels before `.<st>.us` name the STATE itself (bcd.state.or.us). */
const isStateLocalityLabel = (label: string): boolean => label === "state" || label.endsWith("state");

// ── WHICH STATE A HOST / AN AGENCY NAMES (agency-contain C3) ──────────────────────────────────────
// Read ONLY to REMOVE an anchor site (applicationDocsAgency.agencyAnchorSites) — a name never creates one.
const STATE_NAMES_LONGEST_FIRST: Array<[string, string]> = Object.entries(STATE_NAMES)
  .map(([c, n]) => [c, n.replace(/ /g, "")] as [string, string]).sort((a, b) => b[1].length - a[1].length);
/** What may precede a state's name in a label that is a PLACE named for the state, not the state: the
 *  City of Washington (cityofwashington), Port Washington, Fort / Mount / Lake / New / North … */
const PLACE_PREFIX = /(?:of|port|fort|ft|mount|mt|lake|new|north|south|east|west)$/;
/**
 * WHICH STATE A HOST NAMES — read from the host's STRUCTURE, never from a guess about a place — and
 * whether it is that state's OWN site:
 *   - a US locality domain `<…>.<st>.us` (co.jefferson.or.us, douglas.co.us); the state's own site when
 *     the label before the state is "state" (bcd.state.or.us);
 *   - a .gov / .mil whose registrable label IS a state (oregon.gov; lni.wa.gov and dli.mn.gov by their
 *     registrable wa.gov / mn.gov): the state's own site;
 *   - a .gov label ending in a hyphenated state code (tigard-or, elbertcounty-co), a jurisdiction type +
 *     a state code (harriscountytx, washingtoncountyor), or a state's full name after a place name
 *     (bendoregon, polkcountyiowa) — never after "…of" or a place prefix (cityofwashington,
 *     portwashington: places named for a state).
 * null when the host names no state (bouldercounty.gov, pbcgov.org, houstontx.gov, deschutes.org,
 * jeffco.us) — the safe answer, since this only ever removes.
 */
export function hostStateOf(host: string): { state: string; stateSite: boolean } | null {
  const h = String(host ?? "").toLowerCase().replace(/^www\./, "");
  if (!h) return null;
  const us = /\.([a-z]{2})\.us$/.exec(h);
  if (us && US_STATES.has(us[1])) {
    return { state: us[1], stateSite: isStateLocalityLabel(h.slice(0, h.length - us[0].length).split(".").slice(-2).join("")) };
  }
  if (!/\.(?:gov|mil)$/.test(h)) return null;
  const raw = registrableDomain(h).split(".")[0];
  const label = raw.replace(/-/g, "");
  const own = stateCodeOfLabel(label);
  if (own) return { state: own, stateSite: true };
  const hyphen = /-([a-z]{2})$/.exec(raw);
  if (hyphen && US_STATES.has(hyphen[1])) return { state: hyphen[1], stateSite: false };
  const typed = /(?:county|city|parish|township|twp|town|borough|boro|village)([a-z]{2})$/.exec(label);
  if (typed && US_STATES.has(typed[1])) return { state: typed[1], stateSite: false };
  for (const [code, name] of STATE_NAMES_LONGEST_FIRST) {
    if (label.length > name.length && label.endsWith(name) && !PLACE_PREFIX.test(label.slice(0, label.length - name.length))) return { state: code, stateSite: false };
  }
  return null;
}
/** What follows a state's name when the name is a PLACE named for the state (Colorado Springs, Virginia
 *  Beach, Iowa Falls), not the state's agency. */
const PLACE_CONTINUATION = /^(?:springs?|beach|falls|heights|park|hills?|valley|lakes?|junction|center|centre|grove|harbou?r|point|rapids|creek|gap|bluffs?|mills?|landing|ridge|shores?)\b/;
/**
 * The state an agency's name IS — its own agency ("Oregon Building Codes Division", "Washington State
 * Department of Labor & Industries", "State of Minnesota") — as a state code, or "" (namesTheState over
 * every state). Never a jurisdiction (a type word anywhere: "Iowa City", "Nevada County") nor a place
 * named for the state ("Colorado Springs Development Services", "Virginia Beach Permits").
 */
export function stateAgencyOf(name: string): string {
  const n = String(name ?? "");
  if (!n.trim() || jurisdictionTypes([n]).size) return "";
  const s = n.toLowerCase().replace(/[^a-z\s]+/g, " ").replace(/\s+/g, " ").trim().replace(/^the /, "").replace(/^(?:state|commonwealth) of /, "");
  for (const code of Object.keys(STATE_NAMES)) {
    if (!namesTheState([s], code)) continue;
    if (PLACE_CONTINUATION.test(s.slice(STATE_NAMES[code].length).trim())) continue;
    return code;
  }
  return "";
}
/**
 * THE AGENCY'S OWN DOMAIN (lookup-close-7 R1) — whose page it is, never merely "a government page":
 * the organisation's domain label, once its official affixes are removed (cityof / townof / countyof /
 * city / county / town / twp / boro / gov / co / ci, and THIS job's state's two letters or full name),
 * is exactly one of the name's distinctive keys, or its initials after a "gov" / "cityof" affix — on
 * EVERY TLD (.gov too: cityofplainfield.gov is not the City of Denby's). On a .gov host initials of
 * three letters or more stand alone (nyc.gov). A US locality domain (ci.waltham.ma.us,
 * co.marion.or.us) is judged by its name label, in this job's state. A state's own label (in.gov,
 * mn.gov, oregon.gov, maine.gov) belongs only to a name that IS the state, and only on .gov / a
 * state.<st>.us host — never to a city named after it (iowa.gov is not Iowa City's).
 *   cityofevanston.org, clarkcountynv.gov, leegov.com (lee + gov), icgov.org, cityofgp.com,
 *   tigard-or.gov, camdenmaine.gov, austintexas.gov. A same-named place in another state
 *   (leecova.org for Lee County, FL) is not.
 */
export function isAgencyOwnDomain(host: string, names: string[], state?: string): boolean {
  const h = String(host ?? "").toLowerCase().replace(/^www\./, "");
  if (!h || isPermitPlatformUrl(`https://${h}/`)) return false;
  const st2 = String(state ?? "").toLowerCase();
  const gov = /\.(?:gov|mil)$/.test(h);
  let label: string;
  const us = /\.([a-z]{2})\.us$/.exec(h);
  if (us && US_STATES.has(us[1])) {
    if (st2 && us[1] !== st2) return false;
    // <affix>.<name>.<st>.us: the labels before the state ("ci.waltham" -> "ciwaltham", "state").
    label = h.slice(0, h.length - us[0].length).split(".").slice(-2).join("");
    if (isStateLocalityLabel(label)) return namesTheState(names, us[1]);
  } else {
    label = registrableDomain(h).split(".")[0];
  }
  label = label.replace(/-/g, "");
  // A state's own label: only the state, only on a government host.
  const stateCode = stateCodeOfLabel(label);
  if (stateCode) return gov && (!st2 || st2 === stateCode) && namesTheState(names, stateCode);
  const keys = nameKeys(names);
  const initials = names.map(initialsOf).filter(Boolean);
  // A state's letters / name are stripped only when they are THIS job's state (leecova.org is Lee
  // County, Virginia — not Lee County, Florida); with no state known, any state's.
  const isStateSuffix = (s: string) => (st2 ? s === st2 : US_STATES.has(s));
  const stateNames = (st2 ? [STATE_NAMES[st2] ?? ""] : Object.values(STATE_NAMES)).filter(Boolean).map((s) => s.replace(/ /g, ""));
  // Strip affixes step by step; every intermediate form is a candidate for "the name itself".
  const forms = new Set<string>([label]);
  const official = new Set<string>(); // forms reached by removing an official affix (cityof / gov …)
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of [...forms]) {
      const next: Array<[string, boolean]> = [];
      const pre = /^(cityof|townof|countyof|villageof|boroughof|townshipof|city|county|town|gov|co|ci)(.+)$/.exec(f);
      if (pre) next.push([pre[2], /of$|gov/.test(pre[1])]);
      const suf = /^(.+?)(city|county|town|township|twp|borough|boro|village|gov|co)$/.exec(f);
      if (suf) next.push([suf[1], suf[2] === "gov"]);
      const st = /^(.+?)([a-z]{2})$/.exec(f);
      if (st && isStateSuffix(st[2]) && st[1].length >= 3) next.push([st[1], false]);
      for (const sn of stateNames) if (f.endsWith(sn) && f.length - sn.length >= 3) next.push([f.slice(0, f.length - sn.length), false]);
      for (const [n, off] of next) {
        if (off || official.has(f)) official.add(n);
        if (n.length >= 2 && !forms.has(n)) { forms.add(n); changed = true; }
      }
    }
  }
  if ([...forms].some((f) => keys.includes(f))) return true;
  // Initials only after an explicit "gov" / "cityof" affix (icgov.org, cityofgp.com) — two letters
  // alone name nobody; on a .gov host three or more stand alone (nyc.gov).
  if ([...official].some((f) => initials.includes(f))) return true;
  return gov && [...forms].some((f) => f.length >= 3 && initials.includes(f));
}

// ── Platform markers ──────────────────────────────────────────────────────────────────────
// Markers of the PAGE ITSELF — never of a page it links: an agency page linking an EnerGov tenant
// (".../energovweb.tylerhost.net/apps/SelfService") or an ACA record search is not that platform, so
// href values are removed before the markers are read, and ACA's own navigation counts only when it
// is on the page's own host.
const ACA_TITLE = /Accela Citizen Access/i;
const ACA_SOURCE = /\bagencyCode\s*[=:]|ACA_Config|\bAccelaCitizenAccess\b/i;
const ENERGOV_SOURCE = /SelfService Public Site|tyler-main-menu/i;
// Click2Gov is CentralSquare's UTILITY-BILLING / payments product (close-2 V5): a city's "Online
// Services" landing on Click2GovCX is where a water bill is paid, never where a permit is filed.
const OTHER_PLATFORM_MARKERS = /eTRAKiT|Citizenserve|ViewPoint Cloud|OpenGov|SmartGov|CityView Portal|MyGovernmentOnline|iWorQ|Cloudpermit|Clariti/i;
/** Which permit platform a page we READ is, by its own markers (never by what it links). */
export function detectPlatform(page: Pick<ReadPage, "ok" | "html" | "text" | "title" | "finalUrl" | "links">): PermitPlatform | null {
  if (!page.ok) return null;
  const source = String(page.html ?? "").replace(/\b(?:href|src|action)\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
  const host = portalHostOf(page.finalUrl);
  if (ACA_TITLE.test(page.title) || ACA_SOURCE.test(source)
    || page.links.some((l) => portalHostOf(l.href) === host && /\/Cap\/Cap(?:Home|ApplyDisclaimer)\.aspx\?(?:[^#]*&)?module=/i.test(l.href))) return "accela";
  if (ENERGOV_SOURCE.test(`${page.title}\n${source}`)) return "energov";
  if (OTHER_PLATFORM_MARKERS.test(page.title)) return "other";
  return null;
}
/** Platform from a vendor URL alone (no read): ACA and EnerGov have unmistakable URL shapes. */
export function platformOfUrl(url: string): PermitPlatform | null {
  const u = String(url ?? "");
  if (/accela\.com/i.test(portalHostOf(u))) return "accela";
  if (/\/selfservice\b/i.test(u) && /energov|tylerhost/i.test(u)) return "energov";
  return isPermitPlatformUrl(u) ? "other" : null;
}

// ── Link words ────────────────────────────────────────────────────────────────────────────
/** Words that NAME an application portal. */
export const PORTAL_LINK_WORDS = /apply online|apply for (?:a |your )?(?:building )?permits?|online (?:permit|portal|application|services|submittal)|customer self[- ]?service|citizen'?s? (?:access|portal|self[- ]?service)|self[- ]?service|permit(?:ting)? (?:portal|system)|e-?permit|e-?connect|development hub|online portal|\bportal\b|citizen ?access|accela|energov|etrakit|citizenserve/i;
/** Words that name something ELSE (a transparency / payment / GIS / records portal, a 311 / request /
 *  concern system, a property viewer, a video, a guide, the vendor's own credit line). */
const NOT_PORTAL_WORDS = /transparen|pay (?:a |your )?(?:bill|utility|invoice)|utility bill|job|employ|career|parks?\b|librar|\bgis\b|\bmaps?\b|open data|records request|public records|agenda|video|youtube|how[- ]to|tutorial|guide|faq|help|creating an account|translate|facebook|twitter|instagram|linkedin|nextdoor|newsletter|concern|complain|\b311\b|request|report (?:a|an)\b|code enforcement|property (?:viewer|search|information|lookup)|parcel|assessor|powered by|business licen|licen[cs]e renewal|dog licen|pet licen/i;
const PLATFORMISH_PATH = /selfservice|citizenaccess|citizen-access|energov|\/aca\b|etrakit|\/cap\/|permits?portal|epermit/i;
/** A link TARGET whose path (never its host: "<city>.portal.iworq.net/portalhome" is iWorQ's
 *  landing for a concern form) names an application portal. */
const PORTAL_TARGET_PATH = /selfservice|citizen-?access|\/energov|etrakit|\/cap\/|e-?permit|\/permits?(?:[/_.-]|$)|\/apply\b|\/applications?\b/i;
/** A DEEP LINK into another module of the agency's own platform tenant (close-2 V8: "Apply for a
 *  Business License Online" -> the city's ACA tenant, module=Licenses) is not the permit portal. */
const NOT_PORTAL_PATH = /[?&]module=(?:licens\w*|enforcement|complaints?|business\w*|fire\w*|utilit\w*|tax\w*|animal\w*|health\w*|events?)\b/i;
/** ONE predicate for "a deep link into another module of the agency's own tenant" — the resolver
 *  (a page's link, a landing) and the portal door (a model-cited URL) both ask it (lookup-close-4:
 *  a model citing the Licenses module was the door's sibling path without this guard). */
export function linksAnotherModule(href: string): boolean {
  return NOT_PORTAL_PATH.test(String(href ?? ""));
}
/** The path of a link target names an application portal (PORTAL_TARGET_PATH, or an ACA tenant
 *  on the shared host) and no other module. */
function targetPathNamesPortal(href: string): boolean {
  let path = "";
  try { path = new URL(href).pathname; } catch { return false; }
  if (linksAnotherModule(href)) return false;
  return PORTAL_TARGET_PATH.test(path) || (/(?:^|\.)accela\.com$/i.test(portalHostOf(href)) && Boolean(portalTenantOf(href)));
}
/** Hosts on the vendor list that are never an AHJ's APPLICATION portal as a page link: a 311 / CRM
 *  (GovOutreach), a parcel GIS viewer (PeopleGIS MapsOnline, unless the words name permits), and
 *  SolarAPP+ (where an approval is obtained; the permit is then filed in the city's own portal). */
const NEVER_PAGE_PORTAL_HOST = /(?:^|\.)(?:govoutreach\.com|gosolarapp\.org|solarapp\.nrel\.gov)$/i;
// Hosts where ONE instance serves many agencies (the tenant in the path or a query parameter):
// portalChannel.isPathTenantedHost — the ONE definition (lookup-close-5 MF2).
/** Subdomain labels that name the vendor's product, not the tenant. */
const GENERIC_TENANT_LABEL = /^(?:www|portal|portals|aca|aca-?prod|aca-?[a-z]+|energovweb|energov|css|selfservice|permits?|apps?|online|public|citizen|prod|web|secure)$/i;

/** The tenant a vendor URL names, as letters: the path tenant on a shared instance (LEECO), else the
 *  subdomain's own labels ("cityofscottsdaleaz-energovweb" -> "cityofscottsdaleaz"). */
export function vendorTenantToken(href: string): string {
  const host = portalHostOf(href);
  if (!host) return "";
  if (isPathTenantedHost(host)) return portalTenantOf(href).replace(/[^a-z]/g, "");
  const sub = host.slice(0, Math.max(0, host.length - registrableDomain(host).length - 1));
  return sub.split(/[.]/).flatMap((l) => l.split(/-(?=energov|css|portal|selfservice|web|prod)/i)).filter((l) => l && !GENERIC_TENANT_LABEL.test(l)).join("").replace(/[^a-z]/gi, "").toLowerCase();
}
/** The tenant NAMES this agency: it contains one of the name's distinctive keys (a key under 5
 *  letters must BE the tenant, give or take an official affix / a state's letters: "leeco",
 *  "cityoflee" — "san" never names "sandag"). */
export function tenantNamesAgency(href: string, names: string[], typeNames: string[] = names): boolean {
  const t = vendorTenantToken(href);
  if (!t || tenantContradictsAgency(href, names, typeNames)) return false;
  return nameKeys(names).some((k) => (k.length >= 5 ? t.includes(k) : new RegExp(`^(?:cityof|townof|countyof|villageof|co|ci)?${k}(?:co|county|city|town|twp|gov|[a-z]{2})?$`).test(t)));
}
// ── A SAME-NAMED OTHER JURISDICTION (close-2 MF2) ─────────────────────────────────────────
// A city and its county often share a name (City of Marion / Marion County), and a city page
// linking the county's portal "for unincorporated property" is common. The name alone cannot tell
// them apart; the JURISDICTION-TYPE word can: a type word in the link's words or the tenant token
// that contradicts every type the AHJ's own names carry is another jurisdiction. "co" is never read
// as a type (LEECO is Lee County's tenant and would be "City of Lee"'s too).
// WHOSE TYPES (close-3 MF2): `typeNames` is the AHJ's OWN name and the agency that issues ITS
// permits as a whole (the top-level / lifted agency) — never the cited agency of ONE permit. A city
// page saying "electrical permits are issued by Marion County" must not widen the City of Marion to
// {city, county} and admit MARIONCOUNTY as the city's own portal: the county's portal belongs to
// the county's permit alone (issuedByPublisher). `names` (every name, for the distinctive keys)
// and `typeNames` (for the types) are therefore separate inputs; a caller with one set passes it
// for both.
const TYPE_WORD = /\b(township|twp|county|city|town|borough|boro|village|parish)\b/gi;
const canonType = (w: string) => ({ twp: "township", boro: "borough" }[w.toLowerCase()] ?? w.toLowerCase());
/** The jurisdiction types the AHJ's (and its issuing agencies') names carry: {"city"} for
 *  "City of Marion" / "Iowa City", {"county"} for "Marion County" / "County of San Diego". */
export function jurisdictionTypes(names: string[]): Set<string> {
  const out = new Set<string>();
  for (const n of names) for (const m of String(n ?? "").matchAll(TYPE_WORD)) out.add(canonType(m[1]));
  return out;
}
const typesContradict = (found: Iterable<string>, own: Set<string>): boolean => {
  const f = new Set([...found].map(canonType));
  return f.size > 0 && own.size > 0 && ![...f].some((t) => own.has(t));
};
/** The vendor tenant token names another TYPE of jurisdiction than the AHJ ("marioncounty" for
 *  City of Marion, "cityofmarion" for Marion County). The AHJ's own distinctive keys are taken out
 *  of the run-together token first (close-3, the reviewer's E1): "georgetowntx" is Georgetown's
 *  tenant, not a town's; "middletown", "foxborough", "hillsborough" name no type. */
/** The name a portal URL carries: the vendor tenant on a vendor host; on any other host the
 *  organisation's own domain label with its subdomain labels ("elam.cityofmadison.com" ->
 *  "elamcityofmadison", "permits.marioncounty.gov" -> "permitsmarioncounty", "co.marion.or.us" ->
 *  "co") — so a same-named other jurisdiction's OWN domain reads like its vendor tenant
 *  (lookup-close-4 D1c). */
export function portalNameToken(href: string): string {
  const host = portalHostOf(href);
  if (!host) return "";
  if (isPermitPlatformUrl(href) || isPathTenantedHost(host)) return vendorTenantToken(href);
  const dom = registrableDomain(host);
  const sub = host.slice(0, Math.max(0, host.length - dom.length - 1)).split(".").filter((l) => l && !GENERIC_TENANT_LABEL.test(l));
  return [...sub, dom.split(".")[0]].join("").replace(/[^a-z]/gi, "").toLowerCase();
}
/**
 * THE AGENCY'S OWN PAGE OR DOCUMENT — whose URL it is, asked ONE way (agency-apps-close MF1): its
 * host is the agency's own domain by name (isAgencyOwnDomain — any .gov / .<st>.us is not enough)
 * AND its domain / tenant names no other TYPE of jurisdiction (tenantContradictsAgency:
 * cityofmarion.org carries Marion County's name key but is the City of Marion's). Read by the lookup's
 * record-type door (permitProcessLookup.recordTypeBelongsToPortal). NOT by the issuing agency's cited
 * application PDFs: a name cannot tell deschutes.org from pbcgov.org, so those are confirmed only on a
 * site where the lookup cited a page for the agency (applicationDocsAgency.agencyAnchorSites).
 */
export function isAgencyOwnUrl(url: string, names: string[], state?: string, typeNames: string[] = names): boolean {
  const host = portalHostOf(url);
  return Boolean(host) && isAgencyOwnDomain(host, names, state) && !tenantContradictsAgency(url, names, typeNames);
}
export function tenantContradictsAgency(href: string, names: string[], typeNames: string[] = names): boolean {
  let t = portalNameToken(href);
  if (!t) return false;
  for (const k of nameKeys(names).sort((a, b) => b.length - a.length)) t = t.split(k).join(" ");
  const found: string[] = [];
  for (const m of t.matchAll(/(township|twp|county|city|town|borough|boro|village|parish)/g)) found.push(m[1]);
  return typesContradict(found, jurisdictionTypes(typeNames));
}
/** The link's words name ANOTHER jurisdiction ("Other Township online permit portal", "City of
 *  Hampton permits" on a county page listing its cities' portals) — or the same name with another
 *  TYPE ("Marion County Online Permits" on the City of Marion's page). */
export function wordsNameAnotherJurisdiction(text: string, names: string[], typeNames: string[] = names): boolean {
  const own = new Set(names.flatMap((n) => String(n ?? "").toLowerCase().split(/[^a-z]+/)).filter(Boolean));
  const ownTypes = jurisdictionTypes(typeNames);
  const found: Array<{ name: string; type: string }> = [];
  for (const m of String(text ?? "").matchAll(/\b(city|town|township|county|borough|village|parish) of ((?:[A-Z][a-zA-Z'.-]+)(?: [A-Z][a-zA-Z'.-]+)?)/gi)) found.push({ name: m[2], type: m[1] });
  for (const m of String(text ?? "").matchAll(/\b((?:[A-Z][a-zA-Z'.-]+)(?: [A-Z][a-zA-Z'.-]+)?) (Township|County|City|Borough|Village|Parish)\b/gi)) found.push({ name: m[1], type: m[2] });
  const generic = /^(?:the|our|your|this|a|an|apply|online|permit|permits|portal|building|residential|commercial|unincorporated|inside|outside|citizen|public|new|search|for|in|of|with|to|at|and|or)$/i;
  return found.some((f) => {
    const ws = f.name.toLowerCase().split(/[^a-z]+/).filter((w) => w && !generic.test(w));
    if (!ws.length) return false;
    if (!ws.some((w) => own.has(w))) return true;
    return typesContradict([f.type], ownTypes);
  });
}

export interface PortalResolution {
  url: string;
  platform: PermitPlatform;
  /** The agency page that LINKS the portal (our read). */
  sourceUrl: string;
  /** "<the link's words>" -> <its target>, as that page prints it. */
  quote: string;
  via: "vendor link" | "vendor link (tenant read)" | "own-domain portal (markers read)" | "redirect onto a vendor host" | "one hop";
  /** The portal page itself, when we read it (platform markers). */
  portalPage?: ReadPage;
}
interface Candidate { link: PageLink; page: ReadPage; score: number; vendor: boolean }

/**
 * THE LINKS ON A PAGE WE READ THAT MAY BE ITS APPLICATION PORTAL (close MF1/MF2). A link to a
 * permit-software vendor's host is a candidate ONLY when
 *   - its words name an application portal (PORTAL_LINK_WORDS) or its target's PATH does (an EnerGov
 *     /selfservice, an ACA tenant, an iWorQ /permits page — never "portal" in a host name);
 *   - its words do not name something else (a concern / 311 / request form, a parcel viewer, a
 *     "Powered by" credit, GIS, transparency) nor another jurisdiction;
 *   - it is not the vendor's own site (www.accela.com, www.opengov.com, a tenant-less shared host) nor
 *     a host that is never an application portal (GovOutreach 311, SolarAPP+, a MapsOnline viewer).
 * Whether the TENANT is this agency's is decided in resolvePortalFromPages.
 */
function candidatesOn(page: ReadPage, names: string[], typeNames: string[] = names): Candidate[] {
  if (!page.ok || page.kind !== "html") return [];
  const pageDom = registrableDomain(portalHostOf(page.finalUrl));
  const out: Candidate[] = [];
  for (const link of page.links) {
    const host = portalHostOf(link.href);
    if (!host || NOT_PORTAL_WORDS.test(link.text)) continue;
    if (!hostFitsTrackAndEntity("building", null, link.href, "research").fits) continue; // rule 5 + no help page / document
    const vendor = isPermitPlatformUrl(link.href);
    const ownDomain = !vendor && registrableDomain(host) === pageDom;
    const named = PORTAL_LINK_WORDS.test(link.text);
    if (vendor) {
      if (isVendorRootOrMarketing(link.href) || NEVER_PAGE_PORTAL_HOST.test(host)) continue;
      if (/(?:^|\.)mapsonline\.net$/i.test(host) && !/permit/i.test(`${link.text} ${link.href}`)) continue;
      const targetNamed = targetPathNamesPortal(link.href);
      if (!named && !targetNamed) continue;
      // A deep link into another module of the tenant (module=Licenses) is not the permit portal,
      // whatever its words say.
      if (linksAnotherModule(link.href)) continue;
      if (tenantContradictsAgency(link.href, names, typeNames)) continue;
      if (wordsNameAnotherJurisdiction(link.text, names, typeNames)) continue;
      out.push({ link, page, vendor: true, score: (named ? 2 : 0) + (targetNamed ? 1 : 0) + (/selfservice\/[^/#?]+|accela\.com\/[^/]+\//i.test(link.href) ? 1 : 0) });
    } else if (ownDomain && (named || (host !== portalHostOf(page.finalUrl) && PLATFORMISH_PATH.test(link.href)))) {
      if (wordsNameAnotherJurisdiction(link.text, names, typeNames)) continue;
      out.push({ link, page, vendor: false, score: (named ? 2 : 0) + (host !== portalHostOf(page.finalUrl) ? 1 : 0) + (PLATFORMISH_PATH.test(link.href) ? 1 : 0) });
    }
  }
  return out;
}
const quoteOf = (link: PageLink, landed?: string) => `"${link.text || "(link)"}" -> ${link.href}${landed && landed !== link.href ? ` (opens ${landed})` : ""}`.slice(0, 300);
/** A platform page we read that names this agency in its own title / words. */
function pageNamesAgency(page: ReadPage, names: string[]): boolean {
  const words = ` ${`${page.title} ${page.text}`.toLowerCase().replace(/[^a-z]+/g, " ")} `;
  const run = words.replace(/ /g, "");
  return nameKeys(names).some((k) => (k.length >= 5 ? run.includes(k) : words.includes(` ${k} `)));
}

/**
 * Resolve the application portal from the agency's own pages (already read). Reads (politely) the
 * own-domain candidates to confirm a platform, following one hop. Returns null when no page we
 * read links one — never a guess.
 *
 * A VENDOR-HOSTED TENANT IS THIS AGENCY'S only when (in this order):
 *   1. its tenant / subdomain names the agency (tenantNamesAgency: "cityofscottsdaleaz-energovweb",
 *      aca-prod.accela.com/LEECO for Lee County); or
 *   2. [after the own-domain candidates, whose read attests them] it is the ONLY tenant the pages we
 *      read link as a portal; or
 *   3. we read it and it shows the platform's markers AND this agency's name.
 * Otherwise it is not the portal (a county page listing its cities' tenants resolves nothing).
 * `names`: the AHJ's and the issuing agency's names ([] = only doors 2 and the own-domain read).
 * `typeNames`: the names whose jurisdiction TYPES a tenant / link must not contradict (close-3 MF2:
 * the AHJ and the agency issuing its permits as a whole — never one permit's cited agency); `names`
 * when omitted.
 */
export async function resolvePortalFromPages(reader: PageReader, pages: ReadPage[], opts: { maxVerify?: number; names?: string[]; typeNames?: string[] } = {}): Promise<PortalResolution | null> {
  let verifyLeft = opts.maxVerify ?? 4;
  const names = (opts.names ?? []).filter(Boolean);
  const typeNames = (opts.typeNames ?? names).filter(Boolean);
  const vendorHit = (c: Candidate, hop: boolean, via?: PortalResolution["via"], portalPage?: ReadPage): PortalResolution =>
    ({ url: c.link.href, platform: platformOfUrl(c.link.href) ?? (portalPage ? detectPlatform(portalPage) : null) ?? "other", sourceUrl: c.page.finalUrl, quote: quoteOf(c.link), via: via ?? (hop ? "one hop" : "vendor link"), ...(portalPage ? { portalPage } : {}) });
  const tryCandidates = async (cands: Candidate[], hop: boolean): Promise<PortalResolution | null> => {
    const byScore = (a: Candidate, b: Candidate) => b.score - a.score;
    const vendors = cands.filter((c) => c.vendor).sort(byScore);
    const named = vendors.find((c) => tenantNamesAgency(c.link.href, names, typeNames));
    if (named) return vendorHit(named, hop);
    const own = await tryOwnDomain(cands.filter((c) => !c.vendor).sort(byScore), hop);
    if (own) return own;
    const tenants = new Set(vendors.map((c) => portalTenantKey(c.link.href)));
    if (tenants.size === 1) return vendorHit(vendors[0], hop);
    // Several tenants, none named: read them (budget) — the platform's markers AND this agency's name.
    const tried = new Set<string>();
    for (const c of vendors) {
      const key = portalTenantKey(c.link.href);
      if (tried.has(key) || verifyLeft <= 0 || !names.length) continue;
      tried.add(key);
      verifyLeft--;
      const t = await reader.read(c.link.href);
      if (t.ok && detectPlatform(t) && pageNamesAgency(t, names) && hostFitsTrackAndEntity("building", null, t.finalUrl, "research").fits) return vendorHit(c, hop, "vendor link (tenant read)", t);
    }
    return null;
  };
  const tryOwnDomain = async (sorted: Candidate[], hop: boolean): Promise<PortalResolution | null> => {
    for (const c of sorted) {
      if (verifyLeft <= 0) break;
      verifyLeft--;
      const target = await reader.read(c.link.href);
      if (!target.ok) continue;
      // THE LANDING PAGE IS JUDGED, NOT THE LINK (close-2 item 5): an own-domain link that redirects
      // is judged by where it LANDS, under the same words / path / host rules as a direct vendor
      // link. The agency's own link landing on a vendor host attests that tenant — unless it landed
      // on the vendor's own site, a host that is never an application portal (a 311 CRM, SolarAPP+),
      // a parcel viewer, another module (module=Licenses), a same-named other jurisdiction's tenant,
      // or a landing whose path names no portal (<city>.portal.iworq.net/portalhome is iWorQ's
      // concern-form landing; a title that merely names the vendor is not a portal).
      const landedPlatform = detectPlatform(target);
      if (isPermitPlatformUrl(target.finalUrl)) {
        // A vendor-host landing has this ONE door: the vendor's own root or marketing site (its
        // title says "Accela Citizen Access" too) never falls through to the markers door below.
        const landedHost = portalHostOf(target.finalUrl);
        const landingOk = !isVendorRootOrMarketing(target.finalUrl) && !NEVER_PAGE_PORTAL_HOST.test(landedHost) && hostFitsTrackAndEntity("building", null, target.finalUrl, "research").fits
          && !linksAnotherModule(target.finalUrl)
          && !(/(?:^|\.)mapsonline\.net$/i.test(landedHost) && !/permit/i.test(`${c.link.text} ${target.finalUrl}`))
          && !tenantContradictsAgency(target.finalUrl, names, typeNames)
          && (targetPathNamesPortal(target.finalUrl) || landedPlatform === "accela" || landedPlatform === "energov");
        if (landingOk) return { url: target.finalUrl, platform: platformOfUrl(target.finalUrl) ?? landedPlatform ?? "other", sourceUrl: c.page.finalUrl, quote: quoteOf(c.link, target.finalUrl), via: "redirect onto a vendor host", portalPage: target };
        continue;
      }
      // Markers read on the landing page: ACA / EnerGov by their source; another platform by its
      // title only when the landing PATH names a portal too (a "Click2Gov" or "iWorQ" title on a
      // billing or concern page is that vendor's product, not the permit portal).
      const platform = landedPlatform && (landedPlatform !== "other" || targetPathNamesPortal(target.finalUrl) || PLATFORMISH_PATH.test(target.finalUrl)) ? landedPlatform : null;
      if (platform && !linksAnotherModule(target.finalUrl) && hostFitsTrackAndEntity("building", null, target.finalUrl, "research").fits) {
        return { url: target.finalUrl, platform, sourceUrl: c.page.finalUrl, quote: quoteOf(c.link, target.finalUrl), via: hop ? "one hop" : "own-domain portal (markers read)", portalPage: target };
      }
      // ONE HOP: an own-domain page the link's words name as the portal, which in turn links it.
      if (!hop && PORTAL_LINK_WORDS.test(c.link.text)) {
        const next = await tryCandidates(candidatesOn(target, names, typeNames).filter((n) => n.vendor || portalHostOf(n.link.href) !== portalHostOf(target.finalUrl)), true);
        if (next) return next;
      }
    }
    return null;
  };
  return tryCandidates(pages.flatMap((p) => candidatesOn(p, names, typeNames)), false);
}

// ── Catalogs ──────────────────────────────────────────────────────────────────────────────
export interface CatalogType {
  label: string;
  description: string;
  category: string;
  /** ACA's record-type path ("Permitting/Solar/NA/NA"); EnerGov's per-type wizard flags. */
  value?: string;
  flags?: Record<string, boolean>;
}
export interface PortalCatalog {
  platform: PermitPlatform;
  /** What we read (the public API / the public search page). */
  sourceUrl: string;
  types: CatalogType[];
  problem?: string;
}

/** The EnerGov CSS base (".../selfservice") and the tenant path segment after it, if any. */
export function energovBase(url: string): { base: string; tenantSeg: string } | null {
  const m = /^(https?:\/\/[^/#?]+\/(?:[^#?]*?\/)?selfservice)(?:\/([^/#?]+))?/i.exec(String(url ?? ""));
  return m ? { base: m[1], tenantSeg: m[2] ?? "" } : null;
}
/** EnerGov's public menu JSON -> its apply-able types (entries that open a permit/plan wizard). */
export function parseEnerGovMenu(json: unknown): CatalogType[] {
  const menus = (json as { Result?: { Menus?: unknown[] } } | null)?.Result?.Menus;
  if (!Array.isArray(menus)) return [];
  const out: CatalogType[] = [];
  const walk = (list: unknown[]) => {
    for (const m of list as Array<Record<string, unknown>>) {
      if (!m || typeof m !== "object") continue;
      const info = m.CaseTypeInfo as Record<string, unknown> | undefined;
      if ((info || m.PackageData) && typeof m.Label === "string" && !m.IsHidden) {
        const flags: Record<string, boolean> = {};
        for (const k of ["DescriptionRequired", "ValuationRequired", "SignatureRequired", "AllowOnlyOneLocation", "EReviewsEnabled", "SquareFootageRequired"]) if (typeof info?.[k] === "boolean") flags[k] = info[k] as boolean;
        out.push({ label: m.Label.trim(), description: String(m.Description ?? "").trim(), category: String(m.CategoryName ?? "").trim(), flags });
      }
      if (Array.isArray(m.SubMenus)) walk(m.SubMenus);
    }
  };
  walk(menus);
  return out;
}
export async function readEnerGovCatalog(reader: PageReader, portalUrl: string): Promise<PortalCatalog | null> {
  const b = energovBase(portalUrl);
  if (!b) return null;
  const tenantsUrl = `${b.base}/api/Home/GetTenants`;
  const t = await reader.read(tenantsUrl, { json: true });
  const tenants = ((t.json as { Result?: Array<Record<string, unknown>> } | undefined)?.Result ?? []).filter((x) => x && typeof x === "object");
  if (!t.ok || !tenants.length) return { platform: "energov", sourceUrl: tenantsUrl, types: [], problem: `the portal's public tenant list could not be read (${t.reason})` };
  const tenant = tenants.find((x) => String(x.TenantUrl ?? "").toLowerCase() === b.tenantSeg.toLowerCase()) ?? (tenants.length === 1 ? tenants[0] : tenants.find((x) => String(x.TenantUrl ?? "").toLowerCase() === "home") ?? tenants[0]);
  const menuUrl = `${b.base}/api/Home/Menu`;
  // The headers the portal's own page sends for its public menu (tenant id / name / url) — no
  // credential, no cookie.
  const m = await reader.read(menuUrl, { json: true, headers: { tenantId: String(tenant.TenantID ?? ""), tenantName: String(tenant.TenantName ?? ""), "Tyler-TenantUrl": String(tenant.TenantUrl ?? ""), "Tyler-Tenant-Culture": "en-US" } });
  const types = m.ok ? parseEnerGovMenu(m.json) : [];
  return { platform: "energov", sourceUrl: menuUrl, types, ...(types.length ? {} : { problem: `the portal's public menu listed no types (${m.reason})` }) };
}

/** ACA's public search form: the record-type dropdown's options (label = what the portal shows). */
export function parseAccelaRecordTypes(html: string): CatalogType[] {
  const out: CatalogType[] = [];
  const sel = /<select[^>]*(?:id|name)="[^"]*PermitType[^"]*"[^>]*>([\s\S]*?)<\/select>/i.exec(String(html ?? ""));
  if (!sel) return out;
  const opt = /<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/gi;
  let m: RegExpExecArray | null;
  const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
  while ((m = opt.exec(sel[1]))) {
    const value = decode(m[1]);
    const label = decode(m[2]);
    if (!value || /^--\s*select/i.test(label)) continue;
    out.push({ label, description: "", category: value.split("/")[0] ?? "", value });
  }
  return out;
}
const ACA_MODULE_PRIORITY = /^(?:building|permitting|permits?|bld|buildingpermits?|construction)$/i;
export async function readAccelaCatalog(reader: PageReader, portalUrl: string, portalPage?: ReadPage): Promise<PortalCatalog | null> {
  const entry = portalPage?.ok ? portalPage : await reader.read(portalUrl);
  if (!entry.ok) return { platform: "accela", sourceUrl: portalUrl, types: [], problem: `the portal page could not be read (${entry.reason})` };
  const modules = new Map<string, string>();
  const addModule = (href: string) => {
    const mm = /\/Cap\/Cap(?:Home|ApplyDisclaimer)\.aspx\?(?:[^#'"]*&)?module=([^&#'"]+)/i.exec(href);
    if (mm && !modules.has(mm[1].toLowerCase())) modules.set(mm[1].toLowerCase(), href.replace(/CapApplyDisclaimer\.aspx/i, "CapHome.aspx"));
  };
  for (const l of entry.links) addModule(l.href);
  // ACA's tab bar is built by script from a data array (['URL','/<AGENCY>/Cap/CapHome.aspx?module=…']),
  // so the module links are in the page source, not in anchors.
  for (const m of String(entry.html ?? "").matchAll(/['"]((?:\/[^'"\s]*)?\/Cap\/Cap(?:Home|ApplyDisclaimer)\.aspx\?[^'"\s]*module=[^'"\s]+)['"]/gi)) {
    try { addModule(new URL(m[1].replace(/&amp;/g, "&"), entry.finalUrl).toString()); } catch { /* not a URL */ }
  }
  const ordered = [...modules.entries()].sort(([a], [b]) => Number(ACA_MODULE_PRIORITY.test(b)) - Number(ACA_MODULE_PRIORITY.test(a)) || Number(/build|permit/i.test(b)) - Number(/build|permit/i.test(a)));
  const picked = ordered.filter(([k]) => ACA_MODULE_PRIORITY.test(k) || /build|permit/i.test(k)).slice(0, 2);
  const types: CatalogType[] = [];
  let sourceUrl = portalUrl;
  let problem = picked.length ? "" : "the portal page names no Building / Permitting module";
  for (const [, href] of picked) {
    const p = await reader.read(href);
    const t = p.ok ? parseAccelaRecordTypes(p.html ?? "") : [];
    if (t.length && types.length === 0) sourceUrl = p.finalUrl;
    types.push(...t);
    if (!t.length) problem = `the public search page listed no record types (${p.reason})`;
  }
  return { platform: "accela", sourceUrl, types, ...(types.length ? {} : { problem }) };
}

export async function readPortalCatalog(reader: PageReader, portal: PortalResolution): Promise<PortalCatalog | null> {
  if (portal.platform === "energov") return readEnerGovCatalog(reader, portal.url);
  if (portal.platform === "accela") return readAccelaCatalog(reader, portal.url, portal.portalPage);
  return null;
}

// ── The solar record types, and which one this job files ─────────────────────────────────
const SOLAR_TYPE = /solar|photo-?voltaic|\bpv\b|renewable energy/i;
// Record-type LOOK-ALIKES (close F3): a solar water heater, a solar screen, taking an array off and
// putting it back, a wind turbine, a pool heater — each carries "solar" / "renewable energy" in its
// label and none is a PV installation. A catalog whose only solar types are these offers none.
const NOT_A_PV_APPLICATION = /pool|water heat|hot water|solar water|thermal|screen|shade|remov|re-?install|detach|re-?set\b|\br ?& ?r\b|wind|turbine|geothermal|revision|renewal|extension|re-?inspection|inspection trip|deferred|violation|complaint|enforcement|plan review only|decommission|lighting|\blights?\b|powered sign|\bsigns?\b|attic fan|solar[- ]ready|\bfarm\b|repair/i;
// THE DESCRIPTION'S SOLAR CLAUSE (close-2 MF3): a type whose LABEL names no solar work is a PV
// candidate on its description only when a clause of it names PV — photovoltaic / PV / solar
// panels, arrays, modules, electric — and that clause is not itself a look-alike ("Furnace, AC,
// heat pumps and solar water heating systems"; "If solar panels must be removed and reinstalled").
const PV_CLAUSE = /photo-?voltaic|\bpv\b|solar (?:panels?|arrays?|modules?|electric\w*|energy systems?|pv)\b|rooftop solar/i;
export function descriptionNamesPv(description: string): boolean {
  return String(description ?? "").split(/[,;.:()]|\s\/\s|\b(?:and|or|if|including|includes|with)\b/i)
    .some((clause) => PV_CLAUSE.test(clause) && !NOT_A_PV_APPLICATION.test(clause));
}
export interface RecordTypeCandidate {
  label: string;
  /** The condition that selects this type ("prescriptive path", "SolarAPP+ approval …"). */
  condition: string;
  path: "solarapp" | "prescriptive" | "engineered" | "standard";
  discipline: PermitProcessDiscipline | null;
  sourceUrl: string;
  quote: string;
}
export function solarRecordTypeCandidates(catalog: PortalCatalog): RecordTypeCandidate[] {
  // A RESIDENTIAL job never files a commercial / multi-family type: a catalog whose only solar type
  // is commercial offers none (the operator is told, never handed the wrong type).
  const hits = catalog.types.filter((t) => (SOLAR_TYPE.test(t.label) || (/residential/i.test(t.label) && descriptionNamesPv(t.description)))
    && !NOT_A_PV_APPLICATION.test(t.label) && !/commercial|multi-?family/i.test(t.label));
  const seen = new Set<string>();
  return hits.filter((t) => !seen.has(t.label.toLowerCase()) && seen.add(t.label.toLowerCase())).map((t) => {
    const path: RecordTypeCandidate["path"] = /solar ?app/i.test(t.label) ? "solarapp"
      : /non[- ]?prescriptive|engineered|non[- ]?standard/i.test(t.label) ? "engineered"
        : /prescriptive|standard plan|expedited/i.test(t.label) ? "prescriptive" : "standard";
    const condition = path === "solarapp" ? "SolarAPP+ path: an eligible system with a SolarAPP+ approval (obtained outside this portal)"
      : path === "engineered" ? "engineered (non-prescriptive) plan path"
        : path === "prescriptive" ? "prescriptive plan path (the structural criteria are met)"
          : "standard application";
    // A type whose label names the electrical trade serves the electrical permit; any other solar
    // type (one record carrying both scopes) serves every permit the job needs.
    const discipline: PermitProcessDiscipline | null = /electric/i.test(t.label) ? "electrical" : null;
    const quote = `${t.label}${t.description ? ` — ${t.description}` : ""}${t.value ? ` (${t.value})` : ""}`.replace(/\s+/g, " ").slice(0, 300);
    return { label: t.label, condition, path, discipline, sourceUrl: catalog.sourceUrl, quote };
  });
}
/** The ONE candidate a cited record type names (close F5): the label equals it, or one contains the
 *  other; the path it names ("SolarAPP+", "prescriptive") when exactly one candidate is on that path.
 *  None or several -> null. */
export function candidateNamedBy(cands: RecordTypeCandidate[], cited: string | null | undefined): RecordTypeCandidate | null {
  const v = String(cited ?? "").trim();
  if (!v || !cands.length) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[–—]/g, "-").replace(/[^a-z0-9+]+/g, " ").trim();
  const m = norm(v);
  const byName = cands.filter((c) => { const l = norm(c.label); return l === m || (l.length >= 6 && m.includes(l)) || (m.length >= 6 && l.includes(m)); });
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return null;
  const tag = /solar ?app/i.test(v) ? "solarapp" : /non[- ]?prescriptive|engineered/i.test(v) ? "engineered" : /prescriptive/i.test(v) ? "prescriptive" : "";
  const byPath = tag ? cands.filter((c) => c.path === tag) : [];
  return byPath.length === 1 ? byPath[0] : null;
}
/** Which candidate THIS job files: the only one; or the one the plan path selects. Several and the
 *  path cannot decide -> null (the operator is asked, with every candidate and its condition). */
export function chooseRecordType(cands: RecordTypeCandidate[], permitPath: string | undefined): { chosen: RecordTypeCandidate | null; question: string } {
  if (!cands.length) return { chosen: null, question: "" };
  if (cands.length === 1) return { chosen: cands[0], question: "" };
  const p = String(permitPath ?? "").toLowerCase();
  const byPath = /engineer|non[- ]?prescriptive/.test(p) ? cands.filter((c) => c.path === "engineered")
    : /prescriptive/.test(p) ? cands.filter((c) => c.path === "prescriptive") : [];
  if (byPath.length === 1) return { chosen: byPath[0], question: "" };
  return { chosen: null, question: `Which record type does this job file? The portal lists ${cands.map((c) => `"${c.label}" (${c.condition})`).join("; ")} — the plan path${p ? ` (${p})` : ""} does not decide it.` };
}

// ── Prerequisites and codes, from the words on a page we read ────────────────────────────
function sentences(text: string): string[] {
  return String(text ?? "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/).map((s) => s.trim()).filter((s) => s.length >= 20 && s.length <= 400);
}
const PREREQ_KINDS: Array<{ kind: string; re: RegExp }> = [
  { kind: "Portal account approval", re: /\b(?:account|online access|log ?in|credentials)\b[^.]{0,120}\b(?:approv|verif|activat)|\b(?:approv|verif|activat)\w*[^.]{0,80}\b(?:account|online access|log ?in)\b/i },
  // A CONTRACTOR'S licence / registration the filing depends on (never a pet, a business or a
  // daycare licence): the sentence names a contractor / installer / electrician AND a licence or
  // registration, and (below) says it is required.
  { kind: "Contractor licence / registration", re: /\b(?:contractor|installer|electrician)s?\b[^.]{0,140}\b(?:licen[cs]\w*|regist\w*|certificate of competency)|\b(?:licen[cs]\w*|regist\w*)\b[^.]{0,100}\b(?:contractor|installer|electrician)s?\b/i },
  { kind: "Approval before the permit", re: /\b(?:plans? (?:approval|examination|review)|solar ?app\+?[^.]{0,40}approv|approval id)[^.]{0,160}\b(?:before|prior to|first|then|after)\b|\b(?:after|once)\b[^.]{0,80}\b(?:approv\w*|issued)\b[^.]{0,80}\b(?:apply|permit|pull)/i },
];
export interface CitedNote { kind: string; value: string; sourceUrl: string; quote: string }
export function extractPrerequisites(page: Pick<ReadPage, "ok" | "finalUrl" | "text">): CitedNote[] {
  if (!page.ok) return [];
  const out: CitedNote[] = [];
  for (const s of sentences(page.text)) {
    if (!/\b(?:must|required|requires|need|needs|will need|shall|only|before|prior|first|approv|takes)/i.test(s)) continue;
    const k = PREREQ_KINDS.find((x) => x.re.test(s));
    if (k?.kind === "Contractor licence / registration" && (!/\b(?:must|required|requires|shall|will need|only)\b/i.test(s) || !/\b(?:permits?|applications?|apply|portal|account|submit\w*)\b/i.test(s))) continue;
    if (k && out.filter((o) => o.kind === k.kind).length >= 2) continue;
    if (!k || out.some((o) => o.kind === k.kind && o.quote === s)) continue;
    const lead = /\b\d+\s*(?:-|–|to)\s*\d+\s+business days|\b\d+\s+business days/i.exec(s)?.[0];
    out.push({ kind: k.kind, value: `${k.kind}${lead ? ` (${lead})` : ""}: ${s}`.slice(0, 300), sourceUrl: page.finalUrl, quote: s.slice(0, 300) });
  }
  return out.slice(0, 6);
}
const CODE_EDITION = /\b(20\d\d)\s+(?:edition of the\s+)?((?:International (?:Building|Residential|Fire|Energy Conservation|Mechanical|Plumbing|Existing Building|Fuel Gas) Code)|National Electrical Code|NEC|IRC|IBC|IFC|IECC|(?:[A-Z][a-z]+ )?(?:Residential|Structural|Electrical|Building|Fire|Energy) (?:Specialty )?Code)/g;
export function extractCodeEditions(page: Pick<ReadPage, "ok" | "finalUrl" | "text">): { editions: string[]; quote: string; sourceUrl: string } | null {
  if (!page.ok) return null;
  const editions: string[] = [];
  const quotes: string[] = [];
  for (const s of sentences(page.text).concat(String(page.text ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length >= 12 && l.length <= 300))) {
    const found = [...s.matchAll(CODE_EDITION)].map((m) => `${m[1]} ${m[2]}`);
    if (!found.length || !/adopt|code|enforce|effective|current/i.test(s)) continue;
    for (const f of found) if (!editions.includes(f)) editions.push(f);
    if (!quotes.includes(s)) quotes.push(s);
  }
  if (!editions.length) return null;
  return { editions: editions.slice(0, 12), quote: quotes.join(" … ").slice(0, 300), sourceUrl: page.finalUrl };
}

// ── Documents worth reading for documents / fees ─────────────────────────────────────────
const FEE_LINK = /fee schedule|master fee|fees? (?:and|&) charges|permit fees?|fee resolution|fee table|schedule of fees/i;
const CHECKLIST_LINK = /checklist|submittal|solar|photovoltaic|\bpv\b|application requirements|required documents/i;
export const DOCUMENT_URL = /\.pdf(?:$|[?#])|showpublisheddocument|\/documentcenter\/view\/|\/weblink\/|\/edoc\//i;
/** A fee schedule, a solar checklist / submittal requirement, or neither — by the words naming it
 *  (a link's text or a search result's title) and, for a checklist, its being a document or naming
 *  a checklist (a "Solar" news page is neither). */
export function classifyDocument(words: string, href: string): "fees" | "checklist" | null {
  if (FEE_LINK.test(words)) return staleOrOtherFeeSource(words, href) ? null : "fees";
  // A checklist is a SOLAR one (a deck or fence submittal guide is another job's).
  if (CHECKLIST_LINK.test(words) && /solar|photo-?voltaic|\bpv\b/i.test(words) && (DOCUMENT_URL.test(href) || /checklist|submittal|requirement|guide/i.test(words))) return "checklist";
  return null;
}
// ── Which fee schedule is THIS job's (close F4) ─────────────────────────────────────────
/** The years a fee source names: in its words, and in its URL's path only inside a segment that has
 *  letters ("2019-fee-schedule", "fees-fy25-26" — never a document id like /View/2019/). A fiscal
 *  year counts as the year it ends ("FY25-26" -> 2026). */
export function yearsNamed(words: string, href: string): number[] {
  let path = "";
  try { path = decodeURIComponent(new URL(href).pathname); } catch { path = ""; }
  const segs = [String(words ?? ""), ...path.split("/").filter((s) => /[a-z]/i.test(s))];
  const out: number[] = [];
  for (const s of segs) {
    for (const m of s.matchAll(/\bfy\s*-?\s*'?(\d{4}|\d{2})(?!\d)(?:\s*[-/–]\s*'?(\d{4}|\d{2})(?!\d))?/gi)) {
      const end = m[2] ?? m[1];
      out.push(end.length === 2 ? 2000 + Number(end) : Number(end));
    }
    for (const m of s.replace(/\bfy\s*-?\s*'?(?:\d{4}|\d{2})(?!\d)(?:\s*[-/–]\s*'?(?:\d{4}|\d{2})(?!\d))?/gi, " ").matchAll(/(?<!\d)(20\d\d)(?:\s*[-/–]\s*(20\d\d|\d\d))?(?!\d)/g)) {
      const end = m[2] ? (m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2])) : Number(m[1]);
      out.push(end);
    }
  }
  return out.filter((y) => y >= 2000 && y <= 2100);
}
/** Another permit KIND's schedule (a trench, a right-of-way, a sign …) — not this job's unless its
 *  words also name the building / electrical / solar work. */
const OTHER_FEE_KIND = /trench|right[- ]of[- ]way|\brow\b|encroach|excavat|street|sidewalk|curb|driveway|sewer|water (?:service|meter|main|connection)|stormwater|utility (?:connection|billing)|\bsigns?\b|zoning|subdivision|land use|grading|fire (?:alarm|sprinkler|prevention|marshal|department)|business licen|alarm|animal|dog|parking|special event|food|liquor|tree|park(?:s|ing)?\b|recreation|cemetery|library|police/i;
const JOB_FEE_KIND = /building|electric|solar|photo-?voltaic|\bpv\b|construction|master fee/i;
/** An archived / prior-year / superseded schedule, or one for another permit kind — never the job's
 *  fee source. `now` is the current year (tests pass it). */
export function staleOrOtherFeeSource(words: string, href: string, now = new Date().getFullYear()): string | null {
  const both = `${words ?? ""} ${(() => { try { return decodeURIComponent(new URL(href).pathname).replace(/[-_/]+/g, " "); } catch { return ""; } })()}`;
  if (/archiv|supersed|obsolete|expired|rescinded|historical|previous|prior year|old fee|draft|proposed/i.test(both)) return "an archived / superseded / draft schedule";
  // A year dates a SCHEDULE (a fee / rate schedule); an application form's year does not.
  const years = /fee|schedule|rates?\b/i.test(both) ? yearsNamed(words, href) : [];
  if (years.length && Math.max(...years) < now) return `a prior-year schedule (${Math.max(...years)})`;
  if (OTHER_FEE_KIND.test(both) && !JOB_FEE_KIND.test(both)) return "a schedule for another permit kind";
  return null;
}
/** Current-year solar / building schedules first, then a master schedule, then the rest. */
function feeRank(words: string, href: string, now = new Date().getFullYear()): number {
  const years = yearsNamed(words, href);
  const both = `${words} ${href}`;
  return (years.some((y) => y >= now) ? 4 : 0) + (/solar|photo-?voltaic|\bpv\b|electric/i.test(both) ? 3 : /building|construction/i.test(both) ? 2 : /master/i.test(both) ? 1 : 0);
}

/** The fee schedule / checklist links on the agency's own pages (own domain or a document host it
 *  links), fee schedules first (the current year's solar / building schedule before the rest); an
 *  archived, prior-year or other-kind schedule is not one (classifyDocument). */
export function documentLinks(pages: ReadPage[], names: string[], state?: string): Array<{ href: string; text: string; kind: "fees" | "checklist" }> {
  const out: Array<{ href: string; text: string; kind: "fees" | "checklist" }> = [];
  for (const page of pages) {
    if (!page.ok || page.kind !== "html") continue;
    const dom = registrableDomain(portalHostOf(page.finalUrl));
    for (const l of page.links) {
      const host = portalHostOf(l.href);
      if (!host || (registrableDomain(host) !== dom && !isOfficialAgencyHost(host, names, state))) continue;
      if (/translate|facebook|twitter|mailto|[?&]splash=|isexternal/i.test(l.href)) continue;
      const kind = classifyDocument(l.text, l.href);
      if (kind && !out.some((o) => o.href === l.href)) out.push({ href: l.href, text: l.text, kind });
    }
  }
  return out.sort((a, b) => Number(b.kind === "fees") - Number(a.kind === "fees") || (a.kind === "fees" ? feeRank(b.text, b.href) - feeRank(a.text, a.href) : 0));
}

// ── The AHJ's own blank PERMIT APPLICATION on a page we read (form acquisition, 2026-09-28) ─────
// The sibling of classifyDocument / documentLinks for one more question: "which document the AHJ's
// own forms page links (or a search result on its own site) is the blank permit APPLICATION?" City
// of Waltham, MA: research named https://www.city.waltham.ma.us/1289/Applications, the page links
// "Residential Application" -> /DocumentCenter/View/4313/Residential-Application (application/pdf),
// and nothing read the page — the model's own list was empty, so Stage reported "no form found".
// The same predicates as the fee / checklist door: DOCUMENT_URL (a document, not a page), FEE_LINK
// (a fee schedule), OTHER_FEE_KIND / JOB_FEE_KIND (another permit kind, unless the words also name
// the building / electrical / solar work). Words are the link's (or result title's) words plus the
// document's own slug (its last path segment) — never the folders above it.
const APPLICATION_WORDS = /\bapplications?\b|\bpermit\s+(?:form|request)\b/i;
/** A document ABOUT applying (a checklist, a guide, instructions, a handout) or a publication —
 *  never the blank form itself. A checklist that names an application is still a checklist. */
const NOT_A_FORM = /checklist|guide|handout|brochure|\bfaqs?\b|instruction|how[- ]to|bulletin|newsletter|agenda|minutes|annual report|press release|polic(?:y|ies)|flyer|presentation|\bnotice\b|\bsample\b|\bexample\b/i;
/** An application, but not for a permit to build: tax / assessor forms ("Residential Exemption
 *  Application"), employment, boards and commissions, licences and registrations, rentals, bids —
 *  and a utility's interconnection / net-metering application (rule 5: never on a permit track). */
const NOT_A_BUILD_PERMIT = /assessor|abatement|exemption|\btax(?:es)?\b|excise|employment|\bjobs?\b|appointment|\bboards?\b|committee|commission|public records|records request|rental|vendor|\bbids?\b|\bgrants?\b|voter|raffle|yard sale|block party|hawker|peddler|\blicen[cs](?:e|es|ing)\b|registration|certificat|scholarship|volunteer|interconnect|net[- ]?meter|\butility\b/i;
/** Another TRADE's or activity's permit (beside OTHER_FEE_KIND's list) — rescued, like a fee
 *  schedule, when the words also name the building / electrical / solar work (JOB_FEE_KIND):
 *  "Building, Plumbing & Gas Permit Application" is this job's form, "Plumbing Permit Application" is not. */
const OTHER_TRADE = /plumbing|\bgas\b|mechanical|sheet ?metal|demolition|\bpools?\b|\bfences?\b|\btents?\b|dumpster|occupancy|variance|special permit|site plan|conservation|wetland|historic/i;
export type ApplicationDiscipline = "electrical" | "building" | "combined" | "general";
/** The words a document's own URL carries: its last path segment, extension and separators dropped
 *  ("/DocumentCenter/View/4313/Residential-Application" -> "Residential Application"). */
export function documentSlugWords(href: string): string {
  try {
    const seg = decodeURIComponent(new URL(href).pathname).split("/").filter(Boolean).pop() ?? "";
    return seg.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[-_+.]+/g, " ").trim();
  } catch {
    return "";
  }
}
/**
 * A blank permit APPLICATION document, by the words naming it and its URL — or null. `discipline`
 * says which permit it is for (an electrical-only application is never the building-side blank);
 * `score` ranks a residential / solar / building application above a generic one. Never a fee
 * schedule, a checklist / guide / handout, an agenda / minutes / newsletter, another permit kind's
 * application, a commercial-only one, a tax / licence / utility application, or a page.
 */
export function classifyApplicationDocument(words: string, href: string): { discipline: ApplicationDiscipline; score: number } | null {
  if (!DOCUMENT_URL.test(String(href ?? ""))) return null;
  const w = `${String(words ?? "")} ${documentSlugWords(href)}`.replace(/\s+/g, " ").trim();
  if (!APPLICATION_WORDS.test(w)) return null;
  if (FEE_LINK.test(w) || NOT_A_FORM.test(w) || NOT_A_BUILD_PERMIT.test(w)) return null;
  if ((OTHER_FEE_KIND.test(w) || OTHER_TRADE.test(w)) && !JOB_FEE_KIND.test(w)) return null;
  // A COMMERCIAL-only application is not a residential solar job's form (one naming both is).
  if (/commercial/i.test(w) && !/residential|dwelling/i.test(w)) return null;
  const electrical = /electric|\bele\b/i.test(w);
  const building = /building|structural|\bbld\b/i.test(w);
  const discipline: ApplicationDiscipline = electrical && building ? "combined" : electrical ? "electrical" : building ? "building" : "general";
  let score = 1;
  if (/residential|dwelling|single[- ]family|one[- ]?(?:and|&)[- ]?two[- ]family/i.test(w)) score += 3;
  if (/solar|photo-?voltaic|\bpv\b/i.test(w)) score += 3;
  if (/building|construction/i.test(w)) score += 2;
  if (/\bpermit\b/i.test(w)) score += 1;
  return { discipline, score };
}
/**
 * The permit APPLICATION documents an AHJ's OWN page links, best first. Only a page on the AHJ's
 * own site is read for them (isOfficialAgencyHost — the agency-page predicate documentLinks uses —
 * and never a state's own site for a local AHJ), and only a link on THAT page's registrable domain
 * is taken: an off-site link (another town's form, a vendor), and a utility host (rule 5), never.
 */
export function applicationFormLinks(pages: ReadPage[], names: string[], state?: string): Array<{ href: string; text: string; discipline: ApplicationDiscipline; score: number }> {
  const out: Array<{ href: string; text: string; discipline: ApplicationDiscipline; score: number }> = [];
  for (const page of pages) {
    if (!page.ok || page.kind !== "html") continue;
    const pageHost = portalHostOf(page.finalUrl);
    if (!isAhjFormsSite(pageHost, names, state)) continue;
    const dom = registrableDomain(pageHost);
    for (const l of page.links) {
      const host = portalHostOf(l.href);
      if (!host || registrableDomain(host) !== dom || isUtilityPlatformUrl(l.href)) continue;
      if (/translate|facebook|twitter|mailto|[?&]splash=|isexternal/i.test(l.href)) continue;
      const doc = classifyApplicationDocument(l.text, l.href);
      if (doc && !out.some((o) => o.href === l.href)) out.push({ href: l.href, text: l.text, ...doc });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
/** A site whose forms page may be read for THIS AHJ's application: an official agency host
 *  (isOfficialAgencyHost), never a permit / utility platform, and never a STATE's own site for a
 *  local AHJ (a state's forms are not the city's). */
export function isAhjFormsSite(host: string, names: string[], state?: string): boolean {
  if (!host || isUtilityPlatformUrl(`https://${host}/`) || !isOfficialAgencyHost(host, names, state)) return false;
  const hs = hostStateOf(host);
  if (hs && state && hs.state !== String(state).toLowerCase()) return false;
  return !(hs?.stateSite && !names.some((n) => stateAgencyOf(n)));
}
const FEE_LINE = /solar|photo-?voltaic|\bpv\b|renewable|\bkva\b|\bkw\b|surcharge|electrical permit|minor work/i;
const DOC_LINE = /required|submit|plan|site|diagram|spec|checklist|form|application|upload|attach|stamp|seal|engineer|calculation|drawing/i;
/** A compact excerpt of a page we read for the documents/fees question: the lines that price solar
 *  (± one line) for a fee document; the requirement lines for a checklist. */
export function excerptFor(page: ReadPage, kind: "fees" | "checklist", cap = 3500): string {
  const lines = String(page.text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const keep = new Set<number>();
  const re = kind === "fees" ? FEE_LINE : DOC_LINE;
  lines.forEach((l, i) => { if (re.test(l)) { keep.add(i); if (kind === "fees") { keep.add(i - 1); keep.add(i + 1); } } });
  let out = "";
  let last = -2;
  for (const i of [...keep].filter((i) => i >= 0 && i < lines.length).sort((a, b) => a - b)) {
    const piece = (i === last + 1 ? "" : "\n…\n") + lines[i] + "\n";
    if (out.length + piece.length > cap) break;
    out += piece;
    last = i;
  }
  return out.trim();
}
