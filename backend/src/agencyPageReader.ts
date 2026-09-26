// OUR OWN PAGE READ (lookup-recall-2, 2026-09-26). The per-job lookup's pages came back as the
// model's server-side web_fetch returns them: TEXT WITHOUT LINK TARGETS (Carlsbad's SolarAPP+ page
// says "Customer Self Service", Tigard's Permit Center says "Community Development Hub" — the hrefs
// were invisible, so the portal was never resolved) or not at all (fee schedules: url_not_allowed /
// url_not_accessible). This module reads a page ITSELF, the way a person's browser would, and hands
// back what the model could not see: every anchor's words -> its absolute target, and a PDF's text.
//
// POLITE BY CONSTRUCTION (memory: go gently on Cloudflare sites — same IP as the production bot):
//   - ONE TRY per URL (no browser escalation: fetchPublicDocument with allowBrowser:false);
//   - >= 10 s between requests to one host, serialised per host across every reader in the process
//     (three concurrent lookups on aca-prod.accela.com still queue);
//   - a host that refuses once (401/403/429, a wall, a challenge, a "no automated access" notice)
//     is BACKED OFF for an hour (BACK_OFF_MS) — not asked again; a 404 / 410 is a missing page, not
//     a refusal (isRefusal);
//   - a size cap, a timeout, a per-lookup read budget;
//   - NEVER A LOGIN: a URL whose path names a sign-in / register / OAuth step is not fetched, and a
//     page that lands on one is not read. No cookies are kept (plain fetch, no jar), no credential is
//     ever attached (fetchPublicDocument refuses a URL carrying one).
// Nothing here writes anything anywhere; what it read is DATA for the lookup's doors, never an
// instruction.
import { load } from "cheerio";
import { fetchPublicDocument, documentFetchDisabled } from "./documentFetch";
import { looksBotBlocked } from "./runAbort";
import { portalHostOf } from "./portalChannel";

export interface PageLink {
  /** The anchor's words: its text, its title / aria-label, and any image alt inside it. */
  text: string;
  /** Absolute target (resolved against the page's final URL / <base>; Outlook safelinks unwrapped). */
  href: string;
}
export interface ReadPage {
  url: string;
  finalUrl: string;
  ok: boolean;
  status: number;
  kind: "html" | "pdf" | "json" | "other" | "none";
  reason: string;
  title: string;
  /** Visible text (HTML) or the text rows (PDF), capped. */
  text: string;
  links: PageLink[];
  /** Raw HTML head (capped) — for platform markers only. */
  html?: string;
  json?: unknown;
}
/** The raw transport: one GET, no cookies. Injected in tests (saved pages, no network). */
export type RawFetch = (url: string, opts: { headers?: Record<string, string>; json?: boolean; timeoutMs: number; maxBytes: number }) => Promise<{
  ok: boolean; status: number; contentType: string; bytes?: Uint8Array; text?: string; finalUrl: string; reason: string;
}>;

export const PAGE_READ_MIN_GAP_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;
const TEXT_CAP = 120_000;
const HTML_CAP = 400_000;

/** A sign-in / registration / OAuth step. Never fetched, never read. */
const LOGIN_PATH = /(?:^|[/._-])(?:log-?in|sign-?in|sign-?on|register|registration|oauth2?|authorize|openid|saml|sso|account\/(?:login|register))(?:[/._?#-]|$)/i;
export function isLoginUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return LOGIN_PATH.test(u.pathname) || /(?:^|\.)identity\.|tylerportico\.com$|login\.microsoftonline\.com$|okta\.com$|auth0\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
/** The production transport: pages through fetchPublicDocument (its refusal classifier, no browser);
 *  a JSON API call (the EnerGov public menu needs its tenant headers) through a plain GET. */
export const defaultRawFetch: RawFetch = async (url, opts) => {
  if (!opts.headers && !opts.json) {
    const d = await fetchPublicDocument(url, { allowBrowser: false, timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes });
    // A FALSE WALL ON A PAGE WE HOLD (measured 2026-09-26: Lee County's ACA Default.aspx answered
    // HTTP 200 with the real 88 KB page, and the shared wall predicate matched "Storage access denied"
    // inside one of its <script>s). Same predicate (looksBotBlocked), asked of the page's VISIBLE words
    // instead of its source; a challenge or a "no automated access" notice is never overridden.
    if (!d.ok && d.status >= 200 && d.status < 300 && d.text && /html/i.test(d.contentType) && /refused an ordinary HTTP client/i.test(d.reason)) {
      const visible = parseHtml(d.text, d.finalUrl || url).text;
      if (visible.length > 500 && !looksBotBlocked(visible)) {
        return { ok: true, status: d.status, contentType: d.contentType, text: d.text, finalUrl: d.finalUrl || url, reason: `HTTP ${d.status} (a script's words tripped the wall check; the visible page is not a wall)` };
      }
    }
    return { ok: d.ok, status: d.status, contentType: d.contentType, bytes: d.bytes, text: d.text, finalUrl: d.finalUrl || url, reason: d.reason };
  }
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: { "user-agent": UA, accept: "application/json, text/plain, */*", "accept-language": "en-US,en;q=0.9", ...(opts.headers ?? {}) },
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > opts.maxBytes) return { ok: false, status: res.status, contentType: "", finalUrl: res.url || url, reason: `over the ${opts.maxBytes}-byte cap` };
    const contentType = res.headers.get("content-type") || "";
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const refused = res.status === 401 || res.status === 403 || res.status === 429 || (text.length < 100_000 && !/json/i.test(contentType) && looksBotBlocked(text));
    return { ok: res.ok && !refused, status: res.status, contentType, bytes, text, finalUrl: res.url || url, reason: refused ? `HTTP ${res.status} — refused` : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, contentType: "", finalUrl: url, reason: `No usable response: ${err instanceof Error ? err.message : String(err)}` };
  }
};

// ── Politeness state, process-wide (every reader shares it) ─────────────────────────────
const hostChain = new Map<string, Promise<unknown>>();
const hostLast = new Map<string, number>();
const backedOff = new Map<string, { reason: string; at: number }>();
/** A refusal backs a host off for an hour (the server is long-running: one transient 429 must not
 *  silence a host for the life of the process), then it may be asked again — once. */
export const BACK_OFF_MS = 60 * 60 * 1000;
const isBackedOff = (host: string) => {
  const b = backedOff.get(host);
  if (b && Date.now() - b.at > BACK_OFF_MS) backedOff.delete(host);
  return backedOff.has(host);
};
/** Tests only: forget the process-wide host state. */
export function _resetPoliteness(): void { hostChain.clear(); hostLast.clear(); backedOff.clear(); }
const REFUSED_REASON = /refus|challenge|captcha|no automated|robots|wall|HTTP 40[13]\b|HTTP 429\b/i;
/** A REFUSAL backs a host off; a MISSING PAGE does not (close F7: an Apache 404 on a county's site was
 *  classed "refused an ordinary HTTP client" and silenced the host for an hour — its permit-packets
 *  page was then never read). 401 / 403 / 429 always refuse; a challenge / wall / "no automated
 *  access" notice refuses unless the server said the page is not there (404 / 410). */
export function isRefusal(status: number, reason: string): boolean {
  if ([401, 403, 429].includes(status)) return true;
  if (status === 404 || status === 410) return false;
  return REFUSED_REASON.test(String(reason ?? ""));
}

export interface PageReader {
  read(url: string, opts?: { headers?: Record<string, string>; json?: boolean }): Promise<ReadPage>;
  /** Every read attempted, in order — for the run log and the eval. */
  readonly log: Array<{ url: string; ok: boolean; reason: string; kind: ReadPage["kind"] }>;
  readsLeft(): number;
}

export function createPageReader(opts: { fetch?: RawFetch; maxReads?: number; minGapMs?: number; timeoutMs?: number; maxBytes?: number; sleep?: (ms: number) => Promise<void> } = {}): PageReader {
  const raw = opts.fetch ?? defaultRawFetch;
  const minGap = opts.minGapMs ?? PAGE_READ_MIN_GAP_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let left = opts.maxReads ?? 14;
  const cache = new Map<string, Promise<ReadPage>>();
  const log: PageReader["log"] = [];
  const none = (url: string, reason: string): ReadPage => ({ url, finalUrl: url, ok: false, status: 0, kind: "none", reason, title: "", text: "", links: [] });

  const readOnce = async (url: string, o: { headers?: Record<string, string>; json?: boolean }): Promise<ReadPage> => {
    const host = portalHostOf(url);
    if (!host) return none(url, "not an http(s) URL");
    if (isLoginUrl(url)) return none(url, "a sign-in / registration page — never read");
    if (!opts.fetch && documentFetchDisabled()) return none(url, "document downloads are off on this installation (DOCUMENT_FETCH=off)");
    if (isBackedOff(host)) return none(url, `${host} refused an earlier read (${backedOff.get(host)?.reason}) — backed off, not asked again`);
    if (left <= 0) return none(url, "the lookup's page-read budget is spent");
    left--;
    // ONE HOST AT A TIME, >= minGap apart — chained per host, process-wide.
    const prev = hostChain.get(host) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
      const wait = (hostLast.get(host) ?? 0) + minGap - Date.now();
      if (wait > 0 && minGap > 0) await sleep(wait);
      if (isBackedOff(host)) return null;
      try {
        return await raw(url, { headers: o.headers, json: o.json, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES });
      } finally {
        hostLast.set(host, Date.now());
      }
    });
    hostChain.set(host, run);
    const got = await run;
    if (!got) return none(url, `${host} refused an earlier read — backed off`);
    // A redirect onto another host (an agency link landing on a vendor) starts THAT host's gap clock too.
    const landed = portalHostOf(got.finalUrl);
    if (landed && landed !== host) hostLast.set(landed, Date.now());
    if (!got.ok) {
      if (isRefusal(got.status, got.reason)) backedOff.set(host, { reason: got.reason.slice(0, 120), at: Date.now() });
      return { ...none(url, got.reason), status: got.status, finalUrl: got.finalUrl || url };
    }
    const finalUrl = got.finalUrl || url;
    if (isLoginUrl(finalUrl)) return { ...none(url, "the page redirected to a sign-in page — not read"), status: got.status, finalUrl };
    return parseFetched(url, finalUrl, got.status, got.contentType, got.bytes, got.text, o.json === true);
  };

  return {
    log,
    readsLeft: () => left,
    async read(url, o = {}) {
      const key = `${url}\u0000${o.json ? "json" : ""}`;
      if (!cache.has(key)) cache.set(key, readOnce(url, o).then((p) => { log.push({ url, ok: p.ok, reason: p.reason, kind: p.kind }); return p; }));
      return cache.get(key)!;
    },
  };
}

async function parseFetched(url: string, finalUrl: string, status: number, contentType: string, bytes: Uint8Array | undefined, text: string | undefined, wantJson: boolean): Promise<ReadPage> {
  const base: ReadPage = { url, finalUrl, ok: true, status, kind: "other", reason: `HTTP ${status}`, title: "", text: "", links: [] };
  const isPdf = /pdf/i.test(contentType) || (bytes && bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);
  if (isPdf && bytes) {
    try {
      return { ...base, kind: "pdf", text: (await pdfText(bytes)).slice(0, TEXT_CAP) };
    } catch (err) {
      return { ...base, ok: false, kind: "pdf", reason: `PDF text could not be read: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const body = text ?? (bytes ? new TextDecoder("utf-8", { fatal: false }).decode(bytes) : "");
  if (wantJson || /json/i.test(contentType)) {
    try { return { ...base, kind: "json", json: JSON.parse(body), text: body.slice(0, TEXT_CAP) }; } catch { if (wantJson) return { ...base, ok: false, kind: "json", reason: "not JSON" }; }
  }
  if (/html|xml/i.test(contentType) || /^\s*</.test(body)) return { ...base, kind: "html", ...parseHtml(body, finalUrl) };
  return { ...base, text: body.slice(0, TEXT_CAP) };
}

/** A PDF's text as lines (one per baseline row, cells joined by two spaces), through the repo's
 *  own PDF reader (pdfTables). */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const { extractPdfRows } = await import("./pdfTables");
  const rows = await extractPdfRows(bytes, { maxPages: 150 });
  return rows.map((r) => r.cells.join("  ")).join("\n");
}

/** Outlook safelinks wrap the real target in ?url= — the page's author meant that target. */
function unwrap(href: string): string {
  try {
    const u = new URL(href);
    if (/safelinks\.protection\.outlook\.com$/i.test(u.hostname) && u.searchParams.get("url")) return u.searchParams.get("url")!;
  } catch { /* not a URL */ }
  return href;
}

/** The page's title, visible text, and every link (anchor words -> absolute target; a frame's src
 *  is a link too — Columbus's portal page is a frame around the ACA Welcome page). */
export function parseHtml(html: string, pageUrl: string): { title: string; text: string; links: PageLink[]; html: string } {
  const $ = load(html);
  let base = pageUrl;
  const baseHref = String($("base[href]").first().attr("href") || "").trim();
  if (baseHref) { try { base = new URL(baseHref, pageUrl).toString(); } catch { /* keep the page URL */ } }
  const links: PageLink[] = [];
  const seen = new Set<string>();
  const push = (rawHref: string, text: string) => {
    const r = String(rawHref || "").trim();
    if (!r || r.startsWith("#") || /^(?:javascript|mailto|tel|data):/i.test(r)) return;
    let href: string;
    try { href = unwrap(new URL(r, base).toString()); } catch { return; }
    if (!/^https?:\/\//i.test(href)) return;
    const t = text.replace(/\s+/g, " ").trim().slice(0, 200);
    const key = `${href}\u0000${t}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ text: t, href });
  };
  $("a[href], area[href]").each((_i, el) => {
    const a = $(el);
    const words = [a.text(), a.attr("title") ?? "", a.attr("aria-label") ?? "", ...a.find("img[alt]").map((_j, img) => $(img).attr("alt") ?? "").get()]
      .map((s) => String(s).replace(/\s+/g, " ").trim()).filter(Boolean);
    // An Outlook safelinks tooltip ("Original URL: … Click or tap if you trust this link.") is the
    // mail client's words, not the page author's.
    push(String(a.attr("href")), [...new Set(words)].join(" ").replace(/Original URL:.*?(?:trust this link\.?|$)/i, "").trim());
  });
  $("iframe[src], frame[src]").each((_i, el) => { push(String($(el).attr("src")), `(frame) ${$(el).attr("title") ?? $(el).attr("name") ?? ""}`.trim()); });
  const title = $("title").first().text().replace(/\s+/g, " ").trim();
  // The page's OWN words: site navigation / header / footer menus are every page's furniture (and
  // run together into one line), so they are dropped from the text — their links were kept above.
  $("script, style, noscript, svg, template, nav, header, footer, [role=navigation], [role=banner], [role=contentinfo]").remove();
  // A TABLE ROW IS ONE LINE, its cells apart (close F4: "<td>Solar Installation</td><td>$50</td>"
  // read as "Solar Installation$50", so the fee row the model quoted was "not on the page"). Block
  // elements end a line. (Links were collected above, before the rows are flattened.)
  $("br").replaceWith("\n");
  $("tr").each((_i, el) => {
    const cells = $(el).children("td, th").map((_j, c) => $(c).text().replace(/\s+/g, " ").trim()).get().filter(Boolean);
    if (cells.length) $(el).text(`\n${cells.join(" | ")}\n`);
  });
  $("p, li, div, h1, h2, h3, h4, h5, h6, dt, dd, table, section, article, blockquote").each((_i, el) => { $(el).append("\n"); });
  const text = $("body").text().replace(/[ \t\f\v\r]+/g, " ").replace(/\s*\n\s*/g, "\n").split("\n").filter((l) => l.length <= 600).join("\n").trim().slice(0, TEXT_CAP);
  return { title, text, links, html: html.slice(0, HTML_CAP) };
}

/** Normalised for a quote check: lower case, one space, no punctuation but digits' own. */
export function normaliseForQuote(s: string): string {
  return String(s ?? "").toLowerCase().replace(/[‘’“”]/g, "'").replace(/[–—]/g, "-")
    .replace(/[^a-z0-9$.%/-]+/g, " ").replace(/\s+/g, " ").trim();
}
/** THE QUOTE IS ON THE PAGE WE READ: every ellipsis-separated segment (>= 2 words) of the quote
 *  occurs in the page text after normalisation. A quote we cannot find there is the model's word. */
export function quoteOnPage(quote: string, pageText: string): boolean {
  const page = normaliseForQuote(pageText);
  // A checklist quoted item by item ("☐ Site Plan • Roof Plan"): each item is its own segment — a
  // PDF's cells interleave other words between items (a link label "info" after each), so the list
  // is never contiguous on the page, while every item still is.
  const segs = String(quote ?? "").split(/\.{3}|…|\s\|\s|[☐☑☒□■▪•●◦·]/).map(normaliseForQuote).filter((s) => s.split(" ").length >= 2 || /\d/.test(s));
  if (!segs.length || !page) return false;
  // ONE ROW (close F4): a table row's words split across cells ("Solar Installation | Residential |
  // $50", a PDF row's columns) — the segment's tokens in order within ONE short line, each a whole
  // token, so an amount must be printed on that same row (never a number from another row).
  // A ROW is a line whose cells are apart: " | " (an HTML table row, parseHtml) or a run of spaces (a
  // PDF row, pdfText). A prose line is never loosened.
  const rows = String(pageText ?? "").split("\n").filter((l) => /\s\|\s|\S {2,}\S/.test(l)).map(normaliseForQuote).filter((l) => l && l.length <= 300).map((l) => l.split(" "));
  const inOneRow = (seg: string) => {
    const toks = seg.replace(/\.$/, "").split(" ").filter(Boolean);
    // Once the segment's words have started matching, a NUMBER on the row that is not the segment's
    // next token ends the match: on "Solar Residential $168 Solar Commercial $331" the words
    // "Solar Residential" own $168, never $331.
    return rows.some((row) => {
      for (let s = 0; s < row.length; s++) {
        if (row[s] !== toks[0]) continue;
        let i = 1;
        for (let j = s + 1; j < row.length && i < toks.length; j++) {
          if (row[j] === toks[i]) i++;
          else if (/\d/.test(row[j])) break;
        }
        if (i === toks.length) return true;
      }
      return false;
    });
  };
  return segs.every((s) => page.includes(s) || page.includes(s.replace(/\.$/, "")) || inOneRow(s));
}
