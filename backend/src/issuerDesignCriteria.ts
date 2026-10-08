// THE AHJ'S OWN DESIGN-CRITERIA PAGE, READ FIRST (#210).
//
// The design-criteria lookup (llm.researchDesignCriteria) asks a web-searching model to find an
// AHJ's Table R301.2 values. Measured 2026-10-06: a city that publishes a plain "Design Criteria"
// page on its own site (a CivicPlus page, linked only from its Applications & Forms page) got
// "looked up, no jurisdiction-wide value found" after 106 s and one grounded call. The search
// never reached the page. A page the jurisdiction ITSELF publishes beats every secondary source,
// and finding it does not need a model: this module probes the issuer's own host the way a
// person would.
//
//   1. THE ISSUER'S HOST: a host the AHJ's own records already cite (its permit-process lookup,
//      its code-profile citations) that NAMES the jurisdiction (isAgencyOwnDomain: a state agency's
//      or a code publisher's host is not the city's site). No host on file = no probe, and the
//      lookup runs exactly as before.
//   2. THE PROBE, generic across municipal CMS platforms (no AHJ names or URLs live here): the
//      home page (its links, and which CMS serves it), the CMS's own site search for "design
//      criteria" (CivicPlus /Search?searchPhrase=, govAccess / Granicus search results, Revize,
//      WordPress ?s=), and the common page names (/Design-Criteria, /building/design-criteria).
//      A link whose words or path name design criteria / climatic and geographic design criteria /
//      R301.2 / "Requirements to be Shown on Drawings" / snow load is a CANDIDATE; a building /
//      permits / applications-and-forms link is a HUB read only to find one. A CivicPlus
//      /NNN/Design-Criteria page id is unguessable, so it is reached through search or a hub.
//   3. THE TABLE: a candidate page (HTML or PDF) is read row by row (extractCriteriaTable) into
//      the lookup's own JSON shape, every value with the row's words as its quote, and then goes
//      through THE SAME parser the model's answer does (llm.parseDesignCriteriaLookup): a number
//      bound to its own label, never a range, an official page only. A page listing "Floor,
//      Sleeping 30 pounds" has no roof-snow row, so it stores no roof snow.
//
// POLITE AND BOUNDED like every read the lookups make: the agencyPageReader (one try per URL, >= 10
// s between reads to one host, an hour's back-off after a refusal, never a login page) with a
// small read budget (ISSUER_PROBE_MAX_READS). What it reads is DATA, never an instruction.
import type { AppDb } from "./db";
import type { PageLink, PageReader, ReadPage } from "./agencyPageReader";
import { isOfficialCodeSource } from "./llm";
import { logger } from "./logger";
import { getPermitProcessLookup } from "./permitProcess";
import { isAgencyOwnDomain } from "./permitPlatformCatalog";
import { isPermitPlatformUrl, portalHostOf, registrableDomain } from "./portalChannel";

/** Reads one probe may spend on the issuer's site (the home page, a site search, a hub, candidates). */
export const ISSUER_PROBE_MAX_READS = 8;
/** Reads left for the HUB PHASE (#250): when the home page, the site search and the common page
 *  names have named no candidate, the page most likely does not exist; the hubs and whatever they
 *  link get this much (one hub and its candidate fit), not the rest of the full budget (~10 s a read). */
export const ISSUER_PROBE_HUB_READS = 3;

// ── 1. The issuer's host ─────────────────────────────────────────────────────────────────

/** Every http(s) URL anywhere in a value (a stored lookup's citations), depth-bounded. */
export function urlsIn(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || v == null) return out;
  if (typeof v === "string") { if (/^https?:\/\//i.test(v.trim())) out.push(v.trim()); return out; }
  if (Array.isArray(v)) { for (const x of v) urlsIn(x, out, depth + 1); return out; }
  if (typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) urlsIn(x, out, depth + 1);
  return out;
}

/** Is this host the jurisdiction's OWN site: an official host (llm.isOfficialCodeSource) whose name
 *  is the jurisdiction's (isAgencyOwnDomain) — never a state agency's, a code publisher's, or a
 *  permit platform's. */
export function isIssuerHost(host: string, ahj: string, state: string): boolean {
  const h = String(host ?? "").toLowerCase();
  if (!h || isPermitPlatformUrl(`https://${h}/`)) return false;
  return isOfficialCodeSource(`https://${h}/`, { ahj, state }) && isAgencyOwnDomain(h, [ahj], state);
}

/**
 * THE ISSUER'S HOST from what is already on file for this AHJ: its permit-process lookup (the
 * issuing agency's own citation first) and any URLs the caller holds (the code profile's citations).
 * The host cited most often wins; "" when none of them is the jurisdiction's own site. Reads only.
 */
export function issuerHostFor(db: AppDb | null, state: string, ahj: string, extraUrls: string[] = []): string {
  const urls: string[] = [];
  const lookup = db ? getPermitProcessLookup(db, state, ahj) : null;
  if (lookup) {
    const agency = String(lookup.issuingAgency?.sourceUrl ?? "");
    if (agency) urls.push(agency, agency); // the agency's own citation counts double
    urlsIn({ ...lookup, issuingAgency: undefined }, urls);
  }
  urls.push(...extraUrls);
  const counts = new Map<string, number>();
  for (const u of urls) {
    // The host AS CITED (www. kept): the probe asks for the pages where the site serves them.
    let host = "";
    try { host = new URL(u).hostname.toLowerCase(); } catch { continue; }
    if (host && isIssuerHost(host, ahj, state)) counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

// ── 2. The probe ─────────────────────────────────────────────────────────────────────────

export type SitePlatform = "civicplus" | "govaccess" | "revize" | "wordpress" | "unknown";

/** Which municipal CMS serves a page, from its own markup (a home page's head and asset paths). */
export function detectSitePlatform(page: Pick<ReadPage, "html" | "links">): SitePlatform {
  const h = `${page.html ?? ""} ${(page.links ?? []).map((l) => l.href).join(" ")}`;
  if (/civicplus|civicengage|\/DocumentCenter\/View\/|\/AgendaCenter\b|\/Archive\.aspx/i.test(h)) return "civicplus";
  if (/govaccess|granicus|\/Home\/ShowDocument\?id=/i.test(h)) return "govaccess";
  if (/revize/i.test(h)) return "revize";
  if (/wp-content|wp-includes|wp-json/i.test(h)) return "wordpress";
  return "unknown";
}

const SEARCH_PHRASE = "design criteria";

/** The CMS's own site search for "design criteria" (the platform's usual search path), most likely first. */
export function siteSearchUrls(origin: string, platform: SitePlatform): string[] {
  const q = encodeURIComponent(SEARCH_PHRASE);
  const plus = SEARCH_PHRASE.replace(/\s+/g, "+");
  switch (platform) {
    case "civicplus": return [`${origin}/Search?searchPhrase=${q}`];
    case "govaccess": return [`${origin}/Search-Results?searchtext=${q}`, `${origin}/search?q=${q}`];
    case "revize": return [`${origin}/search.php?q=${plus}`, `${origin}/search?q=${q}`];
    case "wordpress": return [`${origin}/?s=${plus}`];
    default: return [`${origin}/?s=${plus}`, `${origin}/search?q=${q}`];
  }
}

/** The page names a design-criteria page is commonly published under (the CMS-independent slugs). */
export function commonCriteriaPaths(origin: string): string[] {
  return ["/Design-Criteria", "/design-criteria", "/building/design-criteria"].map((p) => `${origin}${p}`);
}

/** A link that names the TABLE itself (R301.2, climatic and geographic, design criteria, the
 *  drawing requirements), not only one of its loads: read before a bare "snow load" link (#258). */
const TABLE_NAME_WORDS = /design[\s_-]*criteria|climatic[\s_-]*(?:and|&)?[\s_-]*geographic|\bR301\.2\b|requirements?[\s_-]+to[\s_-]+be[\s_-]+shown[\s_-]+on[\s_-]+(?:the[\s_-]+)?(?:drawings|plans)|structural[\s_-]+design[\s_-]+(?:criteria|data|loads)/i;
/** A link (or page) that NAMES the design-criteria table, or one of its loads. */
const CRITERIA_WORDS = new RegExp(`${TABLE_NAME_WORDS.source}|snow[\\s_-]*loads?\\b`, "i");
/** A link to the department page that usually links it. */
const HUB_WORDS = /\bbuilding\b|applications?\s*(?:&|and)\s*forms|\bpermits?\b|development\s+services|community\s+development|\binspections?\b/i;
/** Links that are never the table: sign-in, calendars, agendas, news, social. */
const NOT_A_PAGE = /\b(?:log-?in|sign-?in|calendar|agenda|minutes|news|facebook|twitter|instagram|youtube|linkedin)\b/i;

function linkWords(l: PageLink): string {
  let path = "";
  try { path = decodeURIComponent(new URL(l.href).pathname); } catch { /* not a URL */ }
  return `${l.text} ${path.replace(/[/_-]+/g, " ")}`;
}
export function isCriteriaLink(l: PageLink): boolean { return CRITERIA_WORDS.test(linkWords(l)) && !NOT_A_PAGE.test(l.text); }
/** The candidates in reading order: those naming the table first, then the rest, each group as
 *  collected (a stable sort). `words` is each candidate's link words. */
export function rankedCandidates(candidates: string[], words: Map<string, string>): string[] {
  const rank = (u: string) => (TABLE_NAME_WORDS.test(words.get(u) ?? u) ? 0 : 1);
  return [...candidates].sort((a, b) => rank(a) - rank(b));
}
export function isHubLink(l: PageLink): boolean { return !isCriteriaLink(l) && HUB_WORDS.test(l.text) && !NOT_A_PAGE.test(linkWords(l)); }

/** The criterion labels a page's own text carries: two or more and it reads as a criteria table. */
const TABLE_LABELS = [/ground\s+snow/i, /roof\s+snow/i, /wind\s+(?:design|speed|exposure)|ultimate\s+design\s+wind/i, /seismic\s+design/i, /frost\s+(?:line|depth)/i, /weathering/i, /termite/i];
/** A site-search results page names the phrase it searched for; it is a list of links, not the table. */
const SEARCH_PAGE = /[?&](?:s|q|searchPhrase|searchtext)=|\/search(?:-results)?(?:[/?.]|$)/i;
/** A DESIGN-CRITERIA PAGE: its own text carries two or more of the table's labels, or its title /
 *  address names the table (a page whose table is an image is still the candidate — "found, not
 *  parsed", never "no value") — never a search results page. */
export function looksLikeCriteriaPage(page: Pick<ReadPage, "title" | "text" | "finalUrl">): boolean {
  if (SEARCH_PAGE.test(page.finalUrl)) return false;
  let path = "";
  try { path = decodeURIComponent(new URL(page.finalUrl).pathname).replace(/[/_-]+/g, " "); } catch { /* not a URL */ }
  return TABLE_LABELS.filter((re) => re.test(page.text)).length >= 2 || CRITERIA_WORDS.test(`${page.title} ${path}`);
}

export interface IssuerProbeResult {
  host: string;
  platform: SitePlatform;
  /** The best design-criteria page found on the issuer's site (whether or not it parsed). */
  candidateUrl?: string;
  /** The candidate's text as read (capped) — the grounding a model is handed when the table did not parse. */
  candidateText?: string;
  /** The lookup-shaped JSON the table yielded (extractCriteriaTable), for llm.parseDesignCriteriaLookup. */
  raw?: Record<string, unknown>;
  pagesRead: Array<{ url: string; ok: boolean; reason: string }>;
  /** Set when no candidate was named before the hub reads and the smaller hub budget applied (#250). */
  hubBudget?: number;
}

const CANDIDATE_TEXT_CAP = 12000;
/** Core criteria: the probe "answered" when the issuer's own table gives these. */
const CORE_KEYS = ["groundSnowLoadPsf", "groundSnowLoadAsdPsf", "windSpeedMph"] as const;
const coreCount = (raw: Record<string, unknown>) => CORE_KEYS.filter((k) => raw[k]).length;

/**
 * PROBE THE ISSUER'S OWN SITE for its design-criteria page. Never throws; a refused or missing page
 * is a page not read. Same-site links only (a candidate on another host is not the issuer's page).
 */
export async function probeIssuerDesignCriteria(reader: PageReader, input: { host: string; ahj: string; state: string }): Promise<IssuerProbeResult> {
  const origin = `https://${input.host}`;
  const site = registrableDomain(input.host);
  const onSite = (u: string) => { const h = portalHostOf(u); return Boolean(h) && registrableDomain(h) === site; };
  const out: IssuerProbeResult = { host: input.host, platform: "unknown", pagesRead: [] };
  // The probe's own cap (the reader's minus what the hub phase may not spend), see ISSUER_PROBE_HUB_READS.
  let capAt: number | null = null;
  const left = () => (capAt === null ? reader.readsLeft() : Math.min(reader.readsLeft(), capAt - out.pagesRead.length));
  const read = async (u: string): Promise<ReadPage | null> => {
    if (left() <= 0) return null;
    const pg = await reader.read(u);
    out.pagesRead.push({ url: u, ok: pg.ok, reason: String(pg.reason || "").slice(0, 160) });
    return pg.ok ? pg : null;
  };
  const seen = new Set<string>();
  const key = (u: string) => u.replace(/#.*$/, "").replace(/\/$/, "").toLowerCase();
  const candidates: string[] = [];
  const candidateWords = new Map<string, string>();
  const hubs: string[] = [];
  const collect = (pg: ReadPage) => {
    for (const l of pg.links) {
      if (!onSite(l.href) || seen.has(key(l.href))) continue;
      if (isCriteriaLink(l)) { if (!candidates.some((c) => key(c) === key(l.href))) { candidates.push(l.href); candidateWords.set(l.href, linkWords(l)); } }
      else if (isHubLink(l) && !hubs.some((c) => key(c) === key(l.href))) hubs.push(l.href);
    }
  };
  let best: { url: string; text: string; raw: Record<string, unknown> } | null = null;
  const consider = (pg: ReadPage): boolean => {
    if (!looksLikeCriteriaPage(pg)) return false;
    const raw = extractCriteriaTable(pg.text, pg.finalUrl || pg.url);
    if (!best || coreCount(raw) > coreCount(best.raw) || (coreCount(raw) === coreCount(best.raw) && Object.keys(raw).length > Object.keys(best.raw).length)) {
      best = { url: pg.finalUrl || pg.url, text: pg.text, raw };
    }
    return probeAnswered(raw);
  };
  const visit = async (u: string): Promise<boolean> => {
    if (seen.has(key(u))) return false;
    seen.add(key(u));
    const pg = await read(u);
    if (!pg) return false;
    if (consider(pg)) return true;
    if (pg.kind === "html") collect(pg);
    return false;
  };

  // The home page: which CMS, and the links it already shows.
  seen.add(key(`${origin}/`));
  const home = await read(`${origin}/`);
  if (home) { out.platform = detectSitePlatform(home); collect(home); }
  let done = false;
  const visitAll = async (urls: string[]): Promise<void> => {
    for (const u of urls) {
      if (done || left() <= 0) return;
      if (seen.has(key(u))) continue;
      done = await visit(u);
    }
  };
  // Candidates the home page links, then the CMS's own search, then the common page names (each
  // pass over the candidates the reads so far have named, the table's own names first).
  await visitAll(rankedCandidates(candidates, candidateWords));
  await visitAll(siteSearchUrls(origin, out.platform).slice(0, 1));
  await visitAll(rankedCandidates(candidates, candidateWords));
  await visitAll(commonCriteriaPaths(origin).slice(0, 1));
  if (!done && left() > 0 && !candidates.some((c) => !seen.has(key(c))) && hubs.length) {
    // Nothing has named the table yet: the hub phase runs on a smaller budget, and says so.
    capAt = out.pagesRead.length + ISSUER_PROBE_HUB_READS;
    out.hubBudget = Math.min(ISSUER_PROBE_HUB_READS, reader.readsLeft());
    logger.info("issuer-design-criteria", `no candidate page found on ${input.host} after ${out.pagesRead.length} read(s); hub reads capped at ${out.hubBudget}`);
    // ONE HUB AT A TIME (#258): a hub, then the candidates it named, and the next hub only when
    // nothing was found. Two hubs read back to back left one read for a candidate, and the first
    // criteria-looking link (a bare "Snow Load Map") spent it before the "Design Criteria" table.
    for (const hub of hubs.slice(0, 2)) {
      if (done || best || left() <= 0) break;
      await visitAll([hub]);
      await visitAll(rankedCandidates(candidates, candidateWords));
    }
  }
  await visitAll(rankedCandidates(candidates, candidateWords));
  const found = best as { url: string; text: string; raw: Record<string, unknown> } | null;
  if (found) {
    out.candidateUrl = found.url;
    out.candidateText = found.text.slice(0, CANDIDATE_TEXT_CAP);
    if (Object.keys(found.raw).length) out.raw = found.raw;
  }
  return out;
}

/** The probe answered the core criteria (the STRENGTH-LEVEL ground snow and wind speed) from the
 *  issuer's own table. An ASD-only pg is not an answer (#258): the probe keeps reading for a page
 *  that states the strength-level pg, as researchWithIssuerPage requires. */
export function probeAnswered(raw: Record<string, unknown> | undefined): boolean {
  return !!raw && Boolean(raw.groundSnowLoadPsf) && Boolean(raw.windSpeedMph);
}

// ── 3. The table ─────────────────────────────────────────────────────────────────────────

type CriterionKey = "groundSnowLoadPsf" | "groundSnowLoadAsdPsf" | "roofSnowLoadPsf" | "windSpeedMph" | "windExposure"
  | "seismicDesignCategory" | "frostDepthIn" | "riskCategory" | "weathering" | "termite" | "soilBearingPsf";

/** Which criterion a row's LABEL names (the words before its value), or null. Bound to the label
 *  only: "Floor, Sleeping" / "Roof live load" / "Decay" name none of them. */
export function criterionOfLabel(label: string): CriterionKey | null {
  const l = String(label ?? "").toLowerCase().replace(/\s+/g, " ");
  if (/roof\s+snow/.test(l)) return /sloped|\bp\s?s\b/.test(l) ? null : "roofSnowLoadPsf";
  if (/ground\s+snow|\bp\s?g\b/.test(l)) return /\basd\b|allowable/.test(l) ? "groundSnowLoadAsdPsf" : "groundSnowLoadPsf";
  if (/exposure/.test(l) && !/speed/.test(l)) return "windExposure";
  if (/\bwind\b|\bvult\b|ultimate\s+design/.test(l)) return "windSpeedMph";
  if (/seismic|\bsdc\b/.test(l)) return "seismicDesignCategory";
  if (/frost/.test(l)) return "frostDepthIn";
  if (/(?:risk|occupancy)\s+cat/.test(l)) return "riskCategory";
  if (/weathering/.test(l)) return "weathering";
  if (/termite/.test(l)) return "termite";
  if (/soil|bearing\s+capacity|allowable\s+bearing/.test(l)) return "soilBearingPsf";
  return null;
}

/** An exposure printed with a wind value ("103 [51] exposure B or C"), as published: one letter, or
 *  two joined by or / , / & / and (stored "B or C"). */
const EXPOSURE_IN_VALUE = /exp(?:osure|\.)?\s*(?:cat(?:egory|\.)?\s*)?[:=]?\s*([BCD](?:\s*(?:,|\/|&|\bor\b|\band\b)\s*[BCD])?)(?![A-Za-z0-9])/i;

/** The table's rows as (label, value) pairs: a cell row "Label | value" (an HTML table, parseHtml),
 *  a PDF row "Label  value" (pdfText), a "Label: value" line, or a label line followed by a
 *  value-only line; and a HORIZONTAL R301.2 table (a header row of labels over a row of values with
 *  the same number of cells), paired column by column. */
export function tableRows(text: string): Array<{ label: string; value: string }> {
  const lines = String(text ?? "").split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
  const cellsOf = (l: string) => l.split(/\s\|\s|\t| {2,}/).map((c) => c.trim()).filter(Boolean);
  const rows: Array<{ label: string; value: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const cells = cellsOf(lines[i]);
    // A header row of 3+ labels (no digits) over a value row of the same width.
    if (cells.length >= 3 && cells.every((c) => !/\d/.test(c)) && cells.filter((c) => criterionOfLabel(c)).length >= 2) {
      const next = lines.slice(i + 1, i + 3).map(cellsOf).find((c) => c.length === cells.length && c.some((x) => /\d/.test(x)));
      if (next) { cells.forEach((c, j) => rows.push({ label: c, value: next[j] })); continue; }
    }
    if (cells.length >= 2) { rows.push({ label: cells[0], value: cells.slice(1).join(" ") }); continue; }
    // One cell: "Label: value" segments (a ";" ends one), or the words before the first digit.
    for (const seg of lines[i].split(/;\s*/)) {
      const colon = seg.match(/^([^:]{3,80}):\s*(.+)$/);
      if (colon) { rows.push({ label: colon[1].trim(), value: colon[2].trim() }); continue; }
      const m = seg.match(/^(\D{3,80}?)\s*(\d.*)$/);
      if (m) { rows.push({ label: m[1].trim(), value: m[2].trim() }); continue; }
      // A label alone on its line, its value alone on the next (a PDF's wrapped cell).
      const after = lines[i + 1]?.trim() ?? "";
      if (criterionOfLabel(seg) && after && /^[\d(]|^(?:negligible|moderate|severe|slight|none|very\s+heavy|heavy|[A-F][012]?\b)/i.test(after) && !/[a-z]{3,}\s*,/i.test(after)) {
        rows.push({ label: seg.trim(), value: after });
        i++;
      }
    }
  }
  return rows;
}

/**
 * THE ISSUER'S TABLE -> THE LOOKUP'S JSON SHAPE (every value with its row's words as the quote and
 * the page as its source), for llm.parseDesignCriteriaLookup to bind and check exactly as it checks
 * the model's answer. The first row naming a criterion wins. Pure.
 */
export function extractCriteriaTable(text: string, sourceUrl: string): Record<string, unknown> {
  const out: Record<string, { value: number | string; sourceUrl: string; quote: string; sourceKind: string }> = {};
  const put = (key: CriterionKey, value: number | string, quote: string) => {
    if (out[key]) return;
    out[key] = { value, sourceUrl, quote: quote.replace(/\s+/g, " ").trim().slice(0, 240), sourceKind: "design_criteria_table" };
  };
  for (const { label, value } of tableRows(text)) {
    const key = criterionOfLabel(label);
    if (!key) continue;
    const quote = `${label} ${value}`;
    const num = (s: string) => { const m = s.replace(/(\d),(?=\d{3}(?!\d))/g, "$1").match(/(?<![\d.])\d+(?:\.\d+)?/); return m ? Number(m[0]) : Number.NaN; };
    switch (key) {
      case "windSpeedMph": {
        const n = num(value);
        if (Number.isFinite(n)) put(key, n, quote);
        const exp = value.match(EXPOSURE_IN_VALUE);
        if (exp) put("windExposure", exp[1].replace(/\s+/g, " ").trim(), quote);
        break;
      }
      case "windExposure": {
        const exp = `exposure ${value}`.match(EXPOSURE_IN_VALUE);
        if (exp) put(key, exp[1].replace(/\s+/g, " ").trim(), quote);
        break;
      }
      case "seismicDesignCategory": {
        const m = value.match(/(?<![A-Za-z0-9])(A|B|C|D[012]?|E|F)(?![A-Za-z0-9])/);
        if (m) put(key, m[1], quote);
        break;
      }
      case "riskCategory": {
        const m = value.match(/(?<![A-Za-z0-9])(IV|I{1,3}|[1-4])(?![A-Za-z0-9])/);
        if (m) put(key, m[1], quote);
        break;
      }
      case "weathering": {
        const m = value.match(/\b(negligible|moderate|severe)\b/i);
        if (m) put(key, m[1].toLowerCase(), quote);
        break;
      }
      case "termite": {
        const v = value.replace(/\s+/g, " ").trim();
        if (v && !/\d/.test(v) && v.length <= 120) put(key, v, quote);
        break;
      }
      default: {
        const n = num(value);
        if (Number.isFinite(n)) put(key, n, quote);
      }
    }
  }
  return out;
}
