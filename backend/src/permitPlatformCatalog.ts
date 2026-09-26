// THE PORTAL FROM THE AGENCY'S OWN PAGE, AND THE RECORD TYPE FROM THE PORTAL'S OWN CATALOG
// (lookup-recall-2, 2026-09-26). Invariants for an UNKNOWN AHJ — no city is named in this file:
//
//   1. PORTAL RESOLVED FROM A PAGE WE READ. An agency page (official: a .gov/.us host, a gov/city/
//      county domain, or the agency's own name in its domain) links an application portal. A link
//      counts when its target is on a permit-software VENDOR's host (accela.com, tylerhost.net, …)
//      — the link on the agency's own page attests the tenant — or on the agency's OWN domain AND
//      our read of that target shows a permit platform (its markers, or a redirect onto a vendor
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
import { hostFitsTrackAndEntity, isPermitPlatformUrl, portalHostOf, portalTenantKey, portalTenantOf } from "./portalChannel";

export type PermitPlatform = "energov" | "accela" | "other";

/** The organisation's domain of a host (co.marion.or.us keeps four labels, x.co.uk three). */
export function registrableDomain(host: string): string {
  const labels = String(host ?? "").toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1];
  if (tld === "us" && labels.length >= 4 && /^[a-z]{2}$/.test(labels[labels.length - 2])) return labels.slice(-4).join(".");
  if (/^[a-z]{2}$/.test(tld) && /^(?:co|com|gov|org|net|ac|govt)$/.test(labels[labels.length - 2])) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

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
 *     city / county / town / twp / boro / gov / co / ci, and a state's two letters), the label is exactly
 *     one of the name's distinctive keys, or its initials with a "gov" affix: cityofevanston.org,
 *     clarkcountynv.gov, leegov.com (lee + gov), icgov.org (Iowa City's initials + gov), tigard-or.gov.
 * A vendor's host, a directory, a news or code-publishing site is not.
 */
export function isOfficialAgencyHost(host: string, names: string[]): boolean {
  const h = String(host ?? "").toLowerCase().replace(/^www\./, "");
  if (!h || isPermitPlatformUrl(`https://${h}/`)) return false;
  if (/\.(?:gov|mil)$/.test(h)) return true;
  const us = /\.([a-z]{2})\.us$/.exec(h);
  if (us && US_STATES.has(us[1])) return true;
  const label = registrableDomain(h).split(".")[0].replace(/-/g, "");
  const keys = nameKeys(names);
  const initials = names.map(initialsOf).filter(Boolean);
  // Strip affixes step by step; every intermediate form is a candidate for "the name itself".
  const forms = new Set<string>([label]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of [...forms]) {
      const next: string[] = [];
      const pre = /^(cityof|townof|countyof|villageof|boroughof|townshipof|city|county|town|gov|co|ci)(.+)$/.exec(f);
      if (pre) next.push(pre[2]);
      const suf = /^(.+?)(city|county|town|township|twp|borough|boro|village|gov)$/.exec(f);
      if (suf) next.push(suf[1]);
      const st = /^(.+?)([a-z]{2})$/.exec(f);
      if (st && US_STATES.has(st[2]) && st[1].length >= 3) next.push(st[1]);
      for (const n of next) if (n.length >= 2 && !forms.has(n)) { forms.add(n); changed = true; }
    }
  }
  if ([...forms].some((f) => keys.includes(f))) return true;
  // Initials only with an explicit "gov" affix (icgov.org) — two letters alone name nobody.
  const govStripped = /^(.+?)gov$|^gov(.+)$/.exec(label);
  const core = govStripped ? (govStripped[1] ?? govStripped[2]) : "";
  return Boolean(core) && initials.includes(core);
}

// ── Platform markers ──────────────────────────────────────────────────────────────────────
// Markers of the PAGE ITSELF — never of a page it links: an agency page linking an EnerGov tenant
// (".../energovweb.tylerhost.net/apps/SelfService") or an ACA record search is not that platform, so
// href values are removed before the markers are read, and ACA's own navigation counts only when it
// is on the page's own host.
const ACA_TITLE = /Accela Citizen Access/i;
const ACA_SOURCE = /\bagencyCode\s*[=:]|ACA_Config|\bAccelaCitizenAccess\b/i;
const ENERGOV_SOURCE = /SelfService Public Site|tyler-main-menu/i;
const OTHER_PLATFORM_MARKERS = /eTRAKiT|Citizenserve|ViewPoint Cloud|OpenGov|SmartGov|CityView Portal|MyGovernmentOnline|iWorQ|Cloudpermit|Click2Gov|Clariti/i;
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
const NOT_PORTAL_WORDS = /transparen|pay (?:a |your )?(?:bill|utility|invoice)|utility bill|job|employ|career|parks?\b|librar|\bgis\b|\bmaps?\b|open data|records request|public records|agenda|video|youtube|how[- ]to|tutorial|guide|faq|help|creating an account|translate|facebook|twitter|instagram|linkedin|nextdoor|newsletter|concern|complain|\b311\b|request|report (?:a|an)\b|code enforcement|property (?:viewer|search|information|lookup)|parcel|assessor|powered by/i;
const PLATFORMISH_PATH = /selfservice|citizenaccess|citizen-access|energov|\/aca\b|etrakit|\/cap\/|permits?portal|epermit/i;
/** A link TARGET whose path (never its host: "<city>.portal.iworq.net/portalhome" is iWorQ's
 *  landing for a concern form) names an application portal. */
const PORTAL_TARGET_PATH = /selfservice|citizen-?access|\/energov|etrakit|\/cap\/|e-?permit|\/permits?(?:[/_.-]|$)|\/apply\b|\/applications?\b/i;
/** Hosts on the vendor list that are never an AHJ's APPLICATION portal as a page link: a 311 / CRM
 *  (GovOutreach), a parcel GIS viewer (PeopleGIS MapsOnline, unless the words name permits), and
 *  SolarAPP+ (where an approval is obtained; the permit is then filed in the city's own portal). */
const NEVER_PAGE_PORTAL_HOST = /(?:^|\.)(?:govoutreach\.com|gosolarapp\.org|solarapp\.nrel\.gov)$/i;
/** Hosts where ONE instance serves many agencies and the tenant is the first path segment. */
const PATH_TENANT_HOST = /(?:^|\.)(?:accela\.com|citizenserve\.com|mygovernmentonline\.org)$/i;
/** Subdomain labels that name the vendor's product, not the tenant. */
const GENERIC_TENANT_LABEL = /^(?:www|portal|portals|aca|aca-?prod|aca-?[a-z]+|energovweb|energov|css|selfservice|permits?|apps?|online|public|citizen|prod|web|secure)$/i;

/** The vendor's own site — its bare / www host (www.accela.com, opengov.com, gosolarapp.org), a
 *  marketing subdomain — or a shared instance with no tenant in the path (aca-prod.accela.com/). */
export function isVendorRootOrMarketing(href: string): boolean {
  const host = portalHostOf(href);
  if (!host) return true;
  if (host === registrableDomain(host)) return true;
  if (/^(?:info|go|learn|blog|support|help|community|developers?|docs|marketing|resources|investors?|status|news)\./i.test(host)) return true;
  if (PATH_TENANT_HOST.test(host) && !portalTenantOf(href)) return true;
  return false;
}
/** The tenant a vendor URL names, as letters: the path tenant on a shared instance (LEECO), else the
 *  subdomain's own labels ("cityofscottsdaleaz-energovweb" -> "cityofscottsdaleaz"). */
export function vendorTenantToken(href: string): string {
  const host = portalHostOf(href);
  if (!host) return "";
  if (PATH_TENANT_HOST.test(host)) return portalTenantOf(href).replace(/[^a-z]/g, "");
  const sub = host.slice(0, Math.max(0, host.length - registrableDomain(host).length - 1));
  return sub.split(/[.]/).flatMap((l) => l.split(/-(?=energov|css|portal|selfservice|web|prod)/i)).filter((l) => l && !GENERIC_TENANT_LABEL.test(l)).join("").replace(/[^a-z]/gi, "").toLowerCase();
}
/** The tenant NAMES this agency: it contains one of the name's distinctive keys (a key under 5
 *  letters must BE the tenant, give or take an official affix / a state's letters: "leeco",
 *  "cityoflee" — "san" never names "sandag"). */
export function tenantNamesAgency(href: string, names: string[]): boolean {
  const t = vendorTenantToken(href);
  if (!t) return false;
  return nameKeys(names).some((k) => (k.length >= 5 ? t.includes(k) : new RegExp(`^(?:cityof|townof|countyof|villageof|co|ci)?${k}(?:co|county|city|town|twp|gov|[a-z]{2})?$`).test(t)));
}
/** The link's words name ANOTHER jurisdiction ("Other Township online permit portal", "City of
 *  Hampton permits" on a county page listing its cities' portals). */
export function wordsNameAnotherJurisdiction(text: string, names: string[]): boolean {
  const own = new Set(names.flatMap((n) => String(n ?? "").toLowerCase().split(/[^a-z]+/)).filter(Boolean));
  const found: string[] = [];
  for (const m of String(text ?? "").matchAll(/\b(?:city|town|township|county|borough|village|parish) of ((?:[A-Z][a-zA-Z'.-]+)(?: [A-Z][a-zA-Z'.-]+)?)/gi)) found.push(m[1]);
  for (const m of String(text ?? "").matchAll(/\b((?:[A-Z][a-zA-Z'.-]+)(?: [A-Z][a-zA-Z'.-]+)?) (?:Township|County|City|Borough|Village|Parish)\b/g)) found.push(m[1]);
  const generic = /^(?:the|our|your|this|a|an|apply|online|permit|permits|portal|building|residential|commercial|unincorporated|inside|outside|citizen|public|new|search|for|in|of)$/i;
  return found.some((f) => {
    const ws = f.toLowerCase().split(/[^a-z]+/).filter((w) => w && !generic.test(w));
    return ws.length > 0 && !ws.some((w) => own.has(w));
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
function candidatesOn(page: ReadPage, names: string[]): Candidate[] {
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
      let path = "";
      try { path = new URL(link.href).pathname; } catch { /* keep "" */ }
      const targetNamed = PORTAL_TARGET_PATH.test(path) || (/(?:^|\.)accela\.com$/i.test(host) && Boolean(portalTenantOf(link.href)));
      if (!named && !targetNamed) continue;
      if (wordsNameAnotherJurisdiction(link.text, names)) continue;
      out.push({ link, page, vendor: true, score: (named ? 2 : 0) + (targetNamed ? 1 : 0) + (/selfservice\/[^/#?]+|accela\.com\/[^/]+\//i.test(link.href) ? 1 : 0) });
    } else if (ownDomain && (named || (host !== portalHostOf(page.finalUrl) && PLATFORMISH_PATH.test(link.href)))) {
      if (wordsNameAnotherJurisdiction(link.text, names)) continue;
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
 */
export async function resolvePortalFromPages(reader: PageReader, pages: ReadPage[], opts: { maxVerify?: number; names?: string[] } = {}): Promise<PortalResolution | null> {
  let verifyLeft = opts.maxVerify ?? 4;
  const names = (opts.names ?? []).filter(Boolean);
  const vendorHit = (c: Candidate, hop: boolean, via?: PortalResolution["via"], portalPage?: ReadPage): PortalResolution =>
    ({ url: c.link.href, platform: platformOfUrl(c.link.href) ?? (portalPage ? detectPlatform(portalPage) : null) ?? "other", sourceUrl: c.page.finalUrl, quote: quoteOf(c.link), via: via ?? (hop ? "one hop" : "vendor link"), ...(portalPage ? { portalPage } : {}) });
  const tryCandidates = async (cands: Candidate[], hop: boolean): Promise<PortalResolution | null> => {
    const byScore = (a: Candidate, b: Candidate) => b.score - a.score;
    const vendors = cands.filter((c) => c.vendor).sort(byScore);
    const named = vendors.find((c) => tenantNamesAgency(c.link.href, names));
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
      // The agency's own link landing on a vendor host attests that tenant — unless it landed on the
      // vendor's own site or a host that is never an application portal (a 311 CRM, SolarAPP+).
      if (isPermitPlatformUrl(target.finalUrl) && !isVendorRootOrMarketing(target.finalUrl) && !NEVER_PAGE_PORTAL_HOST.test(portalHostOf(target.finalUrl)) && hostFitsTrackAndEntity("building", null, target.finalUrl, "research").fits) {
        return { url: target.finalUrl, platform: platformOfUrl(target.finalUrl) ?? detectPlatform(target) ?? "other", sourceUrl: c.page.finalUrl, quote: quoteOf(c.link, target.finalUrl), via: "redirect onto a vendor host", portalPage: target };
      }
      const platform = detectPlatform(target);
      if (platform && hostFitsTrackAndEntity("building", null, target.finalUrl, "research").fits) {
        return { url: target.finalUrl, platform, sourceUrl: c.page.finalUrl, quote: quoteOf(c.link, target.finalUrl), via: hop ? "one hop" : "own-domain portal (markers read)", portalPage: target };
      }
      // ONE HOP: an own-domain page the link's words name as the portal, which in turn links it.
      if (!hop && PORTAL_LINK_WORDS.test(c.link.text)) {
        const next = await tryCandidates(candidatesOn(target, names).filter((n) => n.vendor || portalHostOf(n.link.href) !== portalHostOf(target.finalUrl)), true);
        if (next) return next;
      }
    }
    return null;
  };
  return tryCandidates(pages.flatMap((p) => candidatesOn(p, names)), false);
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
const NOT_A_PV_APPLICATION = /pool|water heat|hot water|solar water|thermal|screen|shade|remov|re-?install|detach|re-?set\b|\br ?& ?r\b|wind|turbine|geothermal|revision|renewal|extension|re-?inspection|inspection trip|deferred|violation|complaint|enforcement|plan review only/i;
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
  let hits = catalog.types.filter((t) => (SOLAR_TYPE.test(t.label) || (SOLAR_TYPE.test(t.description) && /photo-?voltaic|solar/i.test(t.description) && /residential/i.test(t.label))) && !NOT_A_PV_APPLICATION.test(t.label));
  if (hits.some((t) => !/commercial|multi-?family/i.test(t.label))) hits = hits.filter((t) => !/commercial|multi-?family/i.test(t.label));
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
export function documentLinks(pages: ReadPage[], names: string[]): Array<{ href: string; text: string; kind: "fees" | "checklist" }> {
  const out: Array<{ href: string; text: string; kind: "fees" | "checklist" }> = [];
  for (const page of pages) {
    if (!page.ok || page.kind !== "html") continue;
    const dom = registrableDomain(portalHostOf(page.finalUrl));
    for (const l of page.links) {
      const host = portalHostOf(l.href);
      if (!host || (registrableDomain(host) !== dom && !isOfficialAgencyHost(host, names))) continue;
      if (/translate|facebook|twitter|mailto|[?&]splash=|isexternal/i.test(l.href)) continue;
      const kind = classifyDocument(l.text, l.href);
      if (kind && !out.some((o) => o.href === l.href)) out.push({ href: l.href, text: l.text, kind });
    }
  }
  return out.sort((a, b) => Number(b.kind === "fees") - Number(a.kind === "fees") || (a.kind === "fees" ? feeRank(b.text, b.href) - feeRank(a.text, a.href) : 0));
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
