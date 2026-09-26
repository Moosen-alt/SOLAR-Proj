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
import { hostFitsTrackAndEntity, isPermitPlatformUrl, portalHostOf } from "./portalChannel";

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

const GENERIC_NAME_WORDS = new Set(["city", "county", "town", "village", "the", "of", "and", "department", "division", "building", "services", "community", "development", "public", "works", "inspection", "inspections", "permit", "permits", "office", "unincorporated", "township", "borough", "parish"]);
/** An AGENCY'S OWN page: a government TLD, a gov/city/county word in the domain, or a distinctive
 *  word of the agency's / AHJ's name in it. A blog, a vendor's marketing site or a directory is not. */
export function isOfficialAgencyHost(host: string, names: string[]): boolean {
  const h = String(host ?? "").toLowerCase();
  if (!h || isPermitPlatformUrl(`https://${h}/`)) return false;
  if (/\.(?:gov|us|mil)$/.test(h)) return true;
  const dom = registrableDomain(h).split(".")[0];
  if (/gov|^cityof|^countyof|^co[a-z]{2,}|city|county/.test(dom)) return true;
  const distinctive = names.flatMap((n) => String(n ?? "").toLowerCase().split(/[^a-z]+/)).filter((w) => w.length >= 4 && !GENERIC_NAME_WORDS.has(w));
  return distinctive.some((w) => dom.includes(w));
}

// ── Platform markers ──────────────────────────────────────────────────────────────────────
const ACA_MARKERS = /Accela Citizen Access|\/Cap\/CapHome\.aspx|CapApplyDisclaimer\.aspx|agencyCode\s*[=:'"]/i;
const ENERGOV_MARKERS = /SelfService Public Site|tyler-main-menu|EnerGov/i;
const OTHER_PLATFORM_MARKERS = /eTRAKiT|Citizenserve|ViewPoint Cloud|OpenGov|SmartGov|CityView Portal|MyGovernmentOnline|iWorQ|Cloudpermit|Click2Gov|Clariti/i;
/** Which permit platform a page we READ is, by its own markers (URL shape as a tie-breaker). */
export function detectPlatform(page: Pick<ReadPage, "ok" | "html" | "text" | "title" | "finalUrl" | "links">): PermitPlatform | null {
  if (!page.ok) return null;
  const hay = `${page.title}\n${page.html ?? page.text}`;
  if (ACA_MARKERS.test(hay) || page.links.some((l) => /\/Cap\/CapHome\.aspx\?module=/i.test(l.href))) return "accela";
  if (ENERGOV_MARKERS.test(hay) && /selfservice/i.test(`${page.finalUrl} ${hay}`)) return "energov";
  if (OTHER_PLATFORM_MARKERS.test(page.title) || OTHER_PLATFORM_MARKERS.test(String(page.html ?? "").slice(0, 20000))) return "other";
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
/** Words that name something ELSE (a transparency / payment / GIS / records portal, a video, a guide). */
const NOT_PORTAL_WORDS = /transparen|pay (?:a |your )?(?:bill|utility|invoice)|utility bill|job|employ|career|parks?\b|librar|\bgis\b|\bmaps?\b|open data|records request|public records|agenda|video|youtube|how[- ]to|tutorial|guide|faq|help|creating an account|translate|facebook|twitter|instagram|linkedin|nextdoor|newsletter/i;
const PLATFORMISH_PATH = /selfservice|citizenaccess|citizen-access|energov|\/aca\b|etrakit|\/cap\/|permits?portal|epermit/i;

export interface PortalResolution {
  url: string;
  platform: PermitPlatform;
  /** The agency page that LINKS the portal (our read). */
  sourceUrl: string;
  /** "<the link's words>" -> <its target>, as that page prints it. */
  quote: string;
  via: "vendor link" | "own-domain portal (markers read)" | "redirect onto a vendor host" | "one hop";
  /** The portal page itself, when we read it (platform markers). */
  portalPage?: ReadPage;
}
interface Candidate { link: PageLink; page: ReadPage; score: number; vendor: boolean }

function candidatesOn(page: ReadPage): Candidate[] {
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
      // SolarAPP+ is where an approval is obtained, not (usually) the city's application portal —
      // kept, ranked last.
      const solarApp = /gosolarapp\.org$/i.test(host);
      out.push({ link, page, vendor: true, score: (solarApp ? 0 : 4) + (named ? 2 : 0) + (/selfservice\/[^/#?]+|accela\.com\/[^/]+\//i.test(link.href) ? 1 : 0) });
    } else if (ownDomain && (named || (host !== portalHostOf(page.finalUrl) && PLATFORMISH_PATH.test(link.href)))) {
      out.push({ link, page, vendor: false, score: (named ? 2 : 0) + (host !== portalHostOf(page.finalUrl) ? 1 : 0) + (PLATFORMISH_PATH.test(link.href) ? 1 : 0) });
    }
  }
  return out;
}
const quoteOf = (link: PageLink) => `"${link.text || "(link)"}" -> ${link.href}`.slice(0, 300);

/**
 * Resolve the application portal from the agency's own pages (already read). Reads (politely) the
 * own-domain candidates to confirm a platform, following one hop. Returns null when no page we
 * read links one — never a guess.
 */
export async function resolvePortalFromPages(reader: PageReader, pages: ReadPage[], opts: { maxVerify?: number } = {}): Promise<PortalResolution | null> {
  let verifyLeft = opts.maxVerify ?? 4;
  const tryCandidates = async (cands: Candidate[], hop: boolean): Promise<PortalResolution | null> => {
    const sorted = [...cands].sort((a, b) => b.score - a.score);
    for (const c of sorted) {
      if (c.vendor) {
        return { url: c.link.href, platform: platformOfUrl(c.link.href) ?? "other", sourceUrl: c.page.finalUrl, quote: quoteOf(c.link), via: hop ? "one hop" : "vendor link" };
      }
      if (verifyLeft <= 0) break;
      verifyLeft--;
      const target = await reader.read(c.link.href);
      if (!target.ok) continue;
      if (isPermitPlatformUrl(target.finalUrl) && hostFitsTrackAndEntity("building", null, target.finalUrl, "research").fits) {
        return { url: target.finalUrl, platform: platformOfUrl(target.finalUrl) ?? detectPlatform(target) ?? "other", sourceUrl: c.page.finalUrl, quote: quoteOf(c.link), via: "redirect onto a vendor host", portalPage: target };
      }
      const platform = detectPlatform(target);
      if (platform && hostFitsTrackAndEntity("building", null, target.finalUrl, "research").fits) {
        return { url: target.finalUrl, platform, sourceUrl: c.page.finalUrl, quote: quoteOf(c.link), via: hop ? "one hop" : "own-domain portal (markers read)", portalPage: target };
      }
      // ONE HOP: an own-domain page the link's words name as the portal, which in turn links it.
      if (!hop && PORTAL_LINK_WORDS.test(c.link.text)) {
        const next = await tryCandidates(candidatesOn(target).filter((n) => n.vendor || portalHostOf(n.link.href) !== portalHostOf(target.finalUrl)), true);
        if (next) return next;
      }
    }
    return null;
  };
  return tryCandidates(pages.flatMap(candidatesOn), false);
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
  for (const l of entry.links) {
    const mm = /\/Cap\/Cap(?:Home|ApplyDisclaimer)\.aspx\?(?:[^#]*&)?module=([^&#]+)/i.exec(l.href);
    if (mm && !modules.has(mm[1].toLowerCase())) modules.set(mm[1].toLowerCase(), l.href.replace(/CapApplyDisclaimer\.aspx/i, "CapHome.aspx"));
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
const NOT_A_PV_APPLICATION = /pool|water heat|thermal|revision|renewal|extension|re-?inspection|inspection trip|deferred|violation|complaint|enforcement|plan review only/i;
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
  { kind: "Portal account approval", re: /\baccount\b[^.]{0,120}\b(?:approv|verif|activat)|\b(?:approv|verif|activat)\w*[^.]{0,60}\baccount\b/i },
  { kind: "Contractor licence / registration linked to the account", re: /(?:licen[cs]e|registration|registered)[^.]{0,120}\b(?:account|profile|must|required|will need)|\b(?:add|link|associate)\b[^.]{0,60}(?:licen[cs]e|registration)/i },
  { kind: "Approval before the permit", re: /\b(?:plans? (?:approval|examination|review)|solar ?app\+?[^.]{0,40}approv|approval id)[^.]{0,160}\b(?:before|prior to|first|then|after)\b|\b(?:after|once)\b[^.]{0,80}\b(?:approv\w*|issued)\b[^.]{0,80}\b(?:apply|permit|pull)/i },
];
export interface CitedNote { kind: string; value: string; sourceUrl: string; quote: string }
export function extractPrerequisites(page: Pick<ReadPage, "ok" | "finalUrl" | "text">): CitedNote[] {
  if (!page.ok) return [];
  const out: CitedNote[] = [];
  for (const s of sentences(page.text)) {
    if (!/\b(?:must|required|requires|need|needs|will need|only|before|prior|first|approv|allow)/i.test(s)) continue;
    const k = PREREQ_KINDS.find((x) => x.re.test(s));
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
/** The fee schedule / checklist links on the agency's own pages (own domain or a document host it
 *  links), fee schedules first. */
export function documentLinks(pages: ReadPage[], names: string[]): Array<{ href: string; text: string; kind: "fees" | "checklist" }> {
  const out: Array<{ href: string; text: string; kind: "fees" | "checklist" }> = [];
  for (const page of pages) {
    if (!page.ok || page.kind !== "html") continue;
    const dom = registrableDomain(portalHostOf(page.finalUrl));
    for (const l of page.links) {
      const host = portalHostOf(l.href);
      if (!host || (registrableDomain(host) !== dom && !isOfficialAgencyHost(host, names))) continue;
      if (/translate|facebook|twitter|mailto/i.test(l.href)) continue;
      const kind = FEE_LINK.test(l.text) ? "fees" : CHECKLIST_LINK.test(l.text) && /\.pdf\b|showpublisheddocument|document|checklist|solar/i.test(`${l.href} ${l.text}`) ? "checklist" : null;
      if (kind && !out.some((o) => o.href === l.href)) out.push({ href: l.href, text: l.text, kind });
    }
  }
  return out.sort((a, b) => Number(b.kind === "fees") - Number(a.kind === "fees"));
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
