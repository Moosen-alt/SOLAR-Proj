// ---------------------------------------------------------------------------
// RETRIEVE A PUBLIC DOCUMENT THE WAY A PERSON WOULD.
//
// The fee researcher reported found:false for the City of Coos Bay and gave an honest
// refusal — it could not retrieve the fee schedule. The operator then found it in their
// browser in seconds. The researcher was right that the document was hard to REACH and
// wrong about why: coosbayor.gov sits behind Akamai (Server: AkamaiGHost) and returns 403
// to EVERY programmatic client — WebFetch, curl with a real browser User-Agent, and even
// headless Playwright. A HEADED Chromium with --disable-blink-features=AutomationControlled
// gets 200, and fetching the PDF THROUGH that page context (same cookies, same TLS
// fingerprint) returns the 1.2 MB application/pdf that curl was refused.
//
// So this module is a ladder, cheapest rung first, because a browser launch costs 1-2s and
// the overwhelming majority of jurisdictions need none of it:
//
//   1. plain fetch with a real browser User-Agent;
//   2. on 401/403/429 — or a 200 that is really a bot wall — a HEADED Chromium: warm the
//      session on the document's ORIGIN first (that is when the WAF sets its cookie), then
//      retrieve the document from inside the page;
//   3. give up with a REASON that names what blocked it — status and Server header — never
//      a silent "".
//
// WHAT THIS IS NOT:
//
// * PUBLIC DOCUMENTS ONLY. No credential is ever attached: there is no options field for a
//   cookie, a header, a token or a password, and a URL carrying user:pass@ is refused
//   outright. Nothing here logs in, and it must never be pointed at a portal we hold an
//   account on — that is what portal-bot is for, with its stored credentials, its profile
//   locks and its human gates. A fee schedule is a public PDF; keep it that way.
//
// * NOT A CAPTCHA SOLVER. CLAUDE.md rule 1 is that automation never solves CAPTCHA/MFA, and
//   nothing we could learn from a fee schedule is worth approaching that line. A response
//   that is an interactive human-verification puzzle ends the ladder with ok:false and the
//   challenge named — we do not escalate INTO it and we do not retry it.
//
// * A ROBOTS-STYLE REFUSAL IS HONOURED. A 403 whose body is plainly a "no automated access"
//   notice is the site telling us its terms, not a WAF guessing at our browser. Those are
//   reported refused and the ladder STOPS — a headed window would be a way around a decision
//   rather than around a misdetection. The distinction is the whole reason the two are
//   classified separately below.
//
// * BOUNDED: every rung has a timeout, one browser runs at a time, and the session is closed
//   in a finally whatever happens.
//
// The WAF vocabulary is NOT redefined here. looksBotBlocked lives in runAbort.ts because the
// same concept once lived in three places and the copies drifted; this is the fourth caller,
// not a fourth definition.
// ---------------------------------------------------------------------------
import pLimit from "p-limit";
import { logger } from "./logger";
import { looksBotBlocked } from "./runAbort";

export type FetchVia = "http" | "browser";

export interface FetchedDocument {
  ok: boolean;
  /** HTTP status of the attempt we are reporting on. 0 when nothing was ever sent. */
  status: number;
  contentType: string;
  bytes?: Uint8Array;
  /** Decoded body, set only when the content is text-ish (html, xml, json, plain). */
  text?: string;
  via: FetchVia;
  /** ALWAYS populated, success or failure. On a refusal it names what blocked us. */
  reason: string;
  /** The URL the bytes actually came from, after redirects — resolve links against this. */
  finalUrl: string;
}

export interface DocumentLink {
  text: string;
  href: string;
}

/**
 * The narrow slice of a browser this module needs. Kept to three methods so a test can
 * supply a fake and never launch Chromium — and so every decision about WHEN to escalate,
 * what counts as a wall, and what the reason says stays here rather than in the launcher.
 */
export interface DocumentBrowserSession {
  /** Navigate a real page. Used to warm the session on the origin, and to read rendered HTML. */
  visit(url: string, timeoutMs?: number): Promise<{ status: number | null; html: string; url?: string }>;
  /** Retrieve a URL from INSIDE the page context — same cookies, same TLS fingerprint. */
  fetchInPage(url: string, timeoutMs?: number): Promise<{ status: number; contentType: string; bytes: Uint8Array; url?: string }>;
  close(): Promise<void>;
}

export type DocumentBrowserLauncher = (opts: { timeoutMs: number }) => Promise<DocumentBrowserSession>;

export interface FetchPublicDocumentOptions {
  /** Budget for the plain-HTTP rung. Default 20s. */
  timeoutMs?: number;
  /** Budget for the whole browser rung — launch, warm and retrieve. Default 45s. */
  browserTimeoutMs?: number;
  /** Set false to forbid the browser rung entirely (also DOCUMENT_FETCH_BROWSER=0). */
  allowBrowser?: boolean;
  /** Take the page's RENDERED DOM instead of the raw bytes. What link discovery wants. */
  render?: boolean;
  /** Refuse anything larger. Default 32 MB — a fee schedule is ~1 MB. */
  maxBytes?: number;
  /** Injected for tests. Production uses the headed-Chromium launcher below. */
  launcher?: DocumentBrowserLauncher;
  userAgent?: string;
}

// A current desktop Chrome. The point of the first rung is to look like what a person uses;
// Node's default "undici" User-Agent is refused by a good number of government CDNs on its
// own, before any fingerprinting is involved.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_BROWSER_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
/** Past this, a body is a document, not a block page — never classify it as a wall. */
const WALL_BODY_MAX = 100_000;

// ONE BROWSER AT A TIME. A research sweep over forty jurisdictions that escalated on ten of
// them would otherwise open ten headed windows at once on somebody's laptop.
const browserGate = pLimit(1);

// An INTERACTIVE human-verification puzzle. Not a thing we get past, by policy and by taste.
const CAPTCHA =
  /recaptcha|hcaptcha|cf-turnstile|turnstile|captcha|press (and|&) hold|verify (that )?you are (a )?human|i'?m not a robot|are you a human|complete the (security )?challenge/i;

// The site stating its TERMS rather than guessing at our browser. A headed window would be a
// way around a decision, so this rung of the ladder stops here.
const ROBOTS_REFUSAL =
  /automated (access|requests?|queries|traffic|tools?)[^.]{0,40}(is|are)? ?(not (permitted|allowed)|prohibited|disallowed|forbidden|blocked)|no bots?\b|bots? (are|is) not (permitted|allowed|welcome)|(scraping|crawling|data mining)[^.]{0,30}(prohibited|not permitted|not allowed)|(disallowed by|violates?|see) (our )?robots\.txt|robots\.txt (disallows?|forbids)|terms of (use|service)[^.]{0,40}(prohibit|forbid)/i;

type Refusal = "captcha" | "robots" | "wall" | "none";

/**
 * What KIND of refusal is this, if any? Order matters and is the policy:
 * a puzzle is never escalated into, a stated refusal is never worked around, and only a
 * generic wall — the Akamai/Cloudflare "Access Denied" aimed at whatever client we are —
 * earns a real window.
 */
function classifyRefusal(status: number, contentType: string, body: string | undefined): Refusal {
  const textish = isTextish(contentType);
  const snippet = textish && body && body.length <= WALL_BODY_MAX ? body : "";
  // A FILTER LIST FAILS BOTH WAYS, so these two regexes only get to speak about a page that
  // is ALREADY refusing us. /home/showpublisheddocument is CivicPlus — the platform Coos Bay
  // itself runs — and those sites load reCAPTCHA for their own contact and search widgets and
  // carry a "use of automated tools is prohibited" line in the footer. Run unguarded, the
  // classifier reads that furniture as a wall and refuses the very document search this
  // module exists to read, with a reason ("a human-verification challenge") the researcher
  // would then pass on as fact. A genuine 200 interstitial still classifies, because
  // "checking your browser" / "verify you are human" / perimeterx trip looksBotBlocked on
  // their own — a block page says it is one.
  const refusing = status === 401 || status === 403 || status === 429 || (snippet !== "" && looksBotBlocked(snippet));
  if (snippet && refusing) {
    if (CAPTCHA.test(snippet)) return "captcha";
    if (ROBOTS_REFUSAL.test(snippet)) return "robots";
  }
  // A refusal aimed at the CLIENT. Status alone is enough: an Akamai 403 can come with an
  // empty body, and "403 with no explanation" is exactly the Coos Bay case.
  if (status === 401 || status === 403 || status === 429) return "wall";
  // A 200 (or a 503) that is really a block page. Only the body can say so, and only
  // looksBotBlocked gets to decide — see the header.
  if (snippet && looksBotBlocked(snippet)) return "wall";
  return "none";
}

function isTextish(contentType: string): boolean {
  return /text\/|json|xml|html|javascript|^$/i.test(contentType.split(";")[0].trim());
}

/** A public http(s) URL with nothing that could carry a credential. */
function validateUrl(raw: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `Not a URL: ${String(raw).slice(0, 120)}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: `Refused: ${url.protocol} is not a public web URL — this fetcher only speaks http(s).` };
  }
  if (url.username || url.password) {
    // The one hard line this module draws about itself, drawn in code rather than in prose.
    return { error: "Refused: the URL carries credentials. This fetcher retrieves PUBLIC documents and never authenticates." };
  }
  return { url };
}

function describeStatus(status: number, server: string): string {
  const who = server ? ` (server: ${server})` : "";
  return `HTTP ${status}${who}`;
}

function decodeText(bytes: Uint8Array, contentType: string): string | undefined {
  if (!isTextish(contentType)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** A peek at the body for classification, even when the body is not the document's real type. */
function peekText(bytes: Uint8Array, contentType: string): string | undefined {
  if (!isTextish(contentType)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, WALL_BODY_MAX));
  } catch {
    return undefined;
  }
}

interface HttpAttempt {
  status: number;
  contentType: string;
  server: string;
  bytes: Uint8Array;
  finalUrl: string;
  networkError?: string;
}

async function httpAttempt(url: string, opts: { timeoutMs: number; userAgent: string; maxBytes: number }): Promise<HttpAttempt> {
  const blank: HttpAttempt = { status: 0, contentType: "", server: "", bytes: new Uint8Array(0), finalUrl: url };
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs),
      // NO cookies, NO authorization, NO credentials of any kind. A plain public GET.
      headers: {
        "user-agent": opts.userAgent,
        accept: "text/html,application/xhtml+xml,application/pdf,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    const contentType = res.headers.get("content-type") || "";
    const server = res.headers.get("server") || "";
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared && declared > opts.maxBytes) {
      return { ...blank, status: res.status, contentType, server, finalUrl: res.url || url, networkError: `document is ${declared} bytes, over the ${opts.maxBytes}-byte cap` };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > opts.maxBytes) {
      return { ...blank, status: res.status, contentType, server, finalUrl: res.url || url, networkError: `document is ${bytes.length} bytes, over the ${opts.maxBytes}-byte cap` };
    }
    return { status: res.status, contentType, server, bytes, finalUrl: res.url || url };
  } catch (err) {
    return { ...blank, networkError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Retrieve a PUBLIC document, escalating from a plain fetch to a real window only when the
 * far end refuses the plain one. Never throws: every outcome is a FetchedDocument whose
 * `reason` says what happened.
 */
export async function fetchPublicDocument(url: string, opts: FetchPublicDocumentOptions = {}): Promise<FetchedDocument> {
  const checked = validateUrl(url);
  if ("error" in checked) {
    return { ok: false, status: 0, contentType: "", via: "http", reason: checked.error, finalUrl: url };
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const userAgent = opts.userAgent || BROWSER_UA;

  const attempt = await httpAttempt(checked.url.toString(), { timeoutMs, userAgent, maxBytes });

  if (attempt.networkError) {
    // A dead host, a DNS failure or a timeout says nothing about robots, and a headed
    // browser cannot fix any of them — the same discipline runAbort.ts applies to portals.
    return {
      ok: false,
      status: attempt.status,
      contentType: attempt.contentType,
      via: "http",
      reason: `No usable response from ${checked.url.host}: ${attempt.networkError}`,
      finalUrl: attempt.finalUrl,
    };
  }

  const peek = peekText(attempt.bytes, attempt.contentType);
  const refusal = classifyRefusal(attempt.status, attempt.contentType, peek);

  if (attempt.status >= 200 && attempt.status < 300 && refusal === "none") {
    return {
      ok: true,
      status: attempt.status,
      contentType: attempt.contentType,
      bytes: attempt.bytes,
      text: decodeText(attempt.bytes, attempt.contentType),
      via: "http",
      reason: `${describeStatus(attempt.status, attempt.server)} — ${attempt.bytes.length} bytes of ${attempt.contentType || "unknown type"}`,
      finalUrl: attempt.finalUrl,
    };
  }

  if (refusal === "captcha") {
    return {
      ok: false,
      status: attempt.status,
      contentType: attempt.contentType,
      text: peek,
      via: "http",
      reason: `${checked.url.host} answered with a human-verification challenge (${describeStatus(attempt.status, attempt.server)}). `
        + "Automation never solves CAPTCHAs — a person must retrieve this one.",
      finalUrl: attempt.finalUrl,
    };
  }

  if (refusal === "robots") {
    return {
      ok: false,
      status: attempt.status,
      contentType: attempt.contentType,
      text: peek,
      via: "http",
      reason: `${checked.url.host} refuses automated clients by its own notice (${describeStatus(attempt.status, attempt.server)}). `
        + "Not escalated: that is a stated policy, not a misdetected browser.",
      finalUrl: attempt.finalUrl,
    };
  }

  if (refusal !== "wall") {
    // An ordinary HTTP failure: 404, 500, a redirect loop. Nothing a window changes.
    return {
      ok: false,
      status: attempt.status,
      contentType: attempt.contentType,
      text: peek,
      via: "http",
      reason: `${describeStatus(attempt.status, attempt.server)} from ${checked.url.host}`,
      finalUrl: attempt.finalUrl,
    };
  }

  const blocked = `${describeStatus(attempt.status, attempt.server)} from ${checked.url.host} — the site refused an ordinary HTTP client`;
  const browserAllowed = opts.allowBrowser !== false && process.env.DOCUMENT_FETCH_BROWSER !== "0";
  if (!browserAllowed) {
    return {
      ok: false,
      status: attempt.status,
      contentType: attempt.contentType,
      text: peek,
      via: "http",
      reason: `${blocked}, and the browser fallback is switched off (DOCUMENT_FETCH_BROWSER=0 / allowBrowser:false).`,
      finalUrl: attempt.finalUrl,
    };
  }

  logger.info("document-fetch", "plain fetch was refused — retrying with a real window", {
    host: checked.url.host,
    status: attempt.status,
    server: attempt.server || undefined,
  });

  return browserGate(() => browserAttempt(checked.url, {
    launcher: opts.launcher || headedChromiumLauncher,
    timeoutMs: opts.browserTimeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS,
    maxBytes,
    render: opts.render === true,
    blocked,
    httpStatus: attempt.status,
  }));
}

async function browserAttempt(
  url: URL,
  cfg: { launcher: DocumentBrowserLauncher; timeoutMs: number; maxBytes: number; render: boolean; blocked: string; httpStatus: number },
): Promise<FetchedDocument> {
  const deadline = Date.now() + cfg.timeoutMs;
  const remaining = (): number => Math.max(1_000, deadline - Date.now());
  const fail = (reason: string, status = cfg.httpStatus): FetchedDocument =>
    ({ ok: false, status, contentType: "", via: "browser", reason, finalUrl: url.toString() });

  let session: DocumentBrowserSession | null = null;
  try {
    try {
      session = await cfg.launcher({ timeoutMs: cfg.timeoutMs });
    } catch (err) {
      // A headed launch on a machine with no display is a real and common outcome. Say so
      // plainly rather than reporting it as the site blocking us.
      return fail(`${cfg.blocked}. The headed-browser fallback could not start (no display, or Chromium is not installed): `
        + `${err instanceof Error ? err.message : String(err)}`);
    }

    // RENDERED MODE: the page itself is the answer (this is what link discovery wants), so
    // navigating IS the retrieval and the DOM after scripts have run is the honest body.
    if (cfg.render) {
      const visited = await session.visit(url.toString(), remaining());
      const status = visited.status ?? 200;
      const html = visited.html || "";
      const refusal = classifyRefusal(status, "text/html", html);
      if (refusal === "captcha") return fail(`${cfg.blocked}. A real window reached a human-verification challenge; automation stops there.`, status);
      if (refusal === "robots") return fail(`${cfg.blocked}. A real window reached the site's own "no automated access" notice.`, status);
      if (refusal === "wall" || status >= 400) {
        return fail(`${cfg.blocked}, and a real window was refused too (${describeStatus(status, "")}).`, status);
      }
      const bytes = new TextEncoder().encode(html);
      return {
        ok: true, status, contentType: "text/html", bytes, text: html, via: "browser",
        reason: `${cfg.blocked}; a headed browser rendered it (HTTP ${status}, ${bytes.length} bytes).`,
        finalUrl: visited.url || url.toString(),
      };
    }

    // WARM THE SESSION ON THE ORIGIN FIRST. This is the step that made Coos Bay work: the
    // WAF hands its cookie to a page load, and the document request then carries it (and the
    // browser's TLS fingerprint) instead of arriving cold.
    try {
      await session.visit(url.origin, remaining());
    } catch (err) {
      logger.debug("document-fetch", "origin warm-up failed; trying the document anyway", {
        host: url.host, error: err instanceof Error ? err.message : String(err),
      });
    }

    let got: { status: number; contentType: string; bytes: Uint8Array; url?: string };
    try {
      got = await session.fetchInPage(url.toString(), remaining());
    } catch (err) {
      return fail(`${cfg.blocked}. The in-page retrieval failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (got.bytes.length > cfg.maxBytes) {
      return fail(`${cfg.blocked}. A real window got the document, but it is ${got.bytes.length} bytes, over the ${cfg.maxBytes}-byte cap.`, got.status);
    }

    const peek = peekText(got.bytes, got.contentType);
    const refusal = classifyRefusal(got.status, got.contentType, peek);
    if (refusal === "captcha") {
      return fail(`${cfg.blocked}. A real window was answered with a human-verification challenge; automation never solves those — a person must retrieve this one.`, got.status);
    }
    if (refusal === "robots") {
      return fail(`${cfg.blocked}. A real window reached the site's own "no automated access" notice.`, got.status);
    }
    if (refusal === "wall" || got.status < 200 || got.status >= 300) {
      // ONE escalation, not a loop: the ladder has no rung above a real window.
      return fail(`${cfg.blocked}, and a real window was refused too (${describeStatus(got.status, "")}).`, got.status);
    }

    return {
      ok: true,
      status: got.status,
      contentType: got.contentType,
      bytes: got.bytes,
      text: decodeText(got.bytes, got.contentType),
      via: "browser",
      reason: `${cfg.blocked}; a headed browser retrieved it (HTTP ${got.status}, ${got.bytes.length} bytes of ${got.contentType || "unknown type"}).`,
      finalUrl: got.url || url.toString(),
    };
  } finally {
    if (session) {
      try { await session.close(); } catch { /* a browser we could not close is not a result */ }
    }
  }
}

/**
 * Load a page the same escalating way and return its links, filtered.
 *
 * This is what turns "the jurisdiction's document search" into "the fee schedule PDF": the
 * Coos Bay search page lists "Fee Schedule - Resolution 26-30" as an ordinary anchor
 * pointing at /home/showpublisheddocument/570/..., and the whole trick is being able to READ
 * that page at all. Hrefs come back absolute, resolved against the FINAL url after redirects.
 */
export async function findDocumentLinks(
  url: string,
  opts: FetchPublicDocumentOptions = {},
  match: (link: DocumentLink) => boolean = () => true,
): Promise<DocumentLink[]> {
  const page = await fetchPublicDocument(url, { ...opts, render: true });
  if (!page.ok || !page.text) return [];
  const { load } = await import("cheerio");
  const $ = load(page.text);
  const base = page.finalUrl || url;
  const seen = new Set<string>();
  const out: DocumentLink[] = [];
  $("a[href]").each((_i, el) => {
    const raw = String($(el).attr("href") || "").trim();
    if (!raw || raw.startsWith("#") || /^(javascript|mailto|tel):/i.test(raw)) return;
    let href: string;
    try {
      href = new URL(raw, base).toString();
    } catch {
      return;
    }
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const link: DocumentLink = { text, href };
    if (!match(link)) return;
    const key = `${href} ${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(link);
  });
  return out;
}

// ---------------------------------------------------------------------------
// The production launcher: a REAL window.
//
// Headless is detected and refused — measured, not assumed: on coosbayor.gov headless
// Playwright got the same 403 as curl, and a headed Chromium got 200. Playwright is imported
// lazily so that nothing on the plain-fetch path (which is nearly every fetch) pays for it,
// and so the unit test stays browser-free.
// ---------------------------------------------------------------------------

// Same shim as portal-bot/src/browser.ts NAME_SHIM, and for the same reason: under tsx,
// esbuild's keepNames wraps named functions in a `__name(fn, "...")` call, which is undefined
// inside the page. A serialized function that hits it throws a ReferenceError that a catch
// turns into a silent "the site blocked us". Duplicated rather than imported so this module
// does not drag the portal machinery in behind it.
const NAME_SHIM = "globalThis.__name = globalThis.__name || function (fn) { return fn; };";

const CHROMIUM_ARGS = [
  // The flag that does the work. Chromium advertises navigator.webdriver and a handful of
  // other automation tells; a WAF that scores them is exactly what refused us on rung one.
  "--disable-blink-features=AutomationControlled",
  "--window-size=1440,900",
  "--disable-dev-shm-usage",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-extensions",
  "--disable-features=TranslateUI,AutofillAddressProfileSavePrompt,AutofillServerCommunication",
  "--disable-save-password-bubble",
];

export const headedChromiumLauncher: DocumentBrowserLauncher = async ({ timeoutMs }) => {
  const { chromium } = await import("playwright");
  // Chromium does not inherit HTTPS_PROXY from the environment — it must be wired
  // explicitly, exactly as portal-bot/src/browser.ts does it.
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const proxy = httpsProxy
    ? { server: httpsProxy, bypass: ["127.0.0.1", "localhost", "[::1]", process.env.PORTAL_PROXY_BYPASS || ""].filter(Boolean).join(",") }
    : undefined;

  const browser = await chromium.launch({ headless: false, args: CHROMIUM_ARGS, proxy });
  try {
    // No storage state, no stored cookies, no credentials: a fresh anonymous window every
    // time, which is all a public document needs.
    const context = await browser.newContext({ viewport: null, proxy });
    await context.addInitScript({ content: NAME_SHIM });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    return buildSession(browser, context, page, timeoutMs);
  } catch (err) {
    // Setup failed after a successful launch: the caller never receives a session and so can
    // never close it. Tear the browser down here or the process leaks a window.
    await browser.close().catch(() => {});
    throw err;
  }
};

type PwBrowser = Awaited<ReturnType<Awaited<typeof import("playwright")>["chromium"]["launch"]>>;
type PwContext = Awaited<ReturnType<PwBrowser["newContext"]>>;
type PwPage = Awaited<ReturnType<PwContext["newPage"]>>;

function buildSession(browser: PwBrowser, context: PwContext, page: PwPage, timeoutMs: number): DocumentBrowserSession {
  return {
    async visit(url: string, ms?: number) {
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: ms ?? timeoutMs });
      // A WAF challenge sets its cookie and redirects a beat after DOMContentLoaded. Waiting
      // for the network to settle is what makes the warm-up worth doing; failing to settle is
      // not itself an error.
      await page.waitForLoadState("networkidle", { timeout: Math.min(8_000, ms ?? timeoutMs) }).catch(() => {});
      return { status: res ? res.status() : null, html: await page.content(), url: page.url() };
    },
    async fetchInPage(url: string, ms?: number) {
      // Bytes do not survive the evaluate boundary, so they come back base64 in chunks small
      // enough for String.fromCharCode.apply. NOTHING in here may be a named inner function
      // (see NAME_SHIM), and the abort signal is created IN THE PAGE because page.evaluate
      // has no timeout of its own — a hung fetch would otherwise hang forever.
      const got = await page.evaluate(
        async (arg: { url: string; timeoutMs: number }) => {
          const res = await fetch(arg.url, {
            credentials: "include",
            redirect: "follow",
            signal: AbortSignal.timeout(arg.timeoutMs),
          });
          const view = new Uint8Array(await res.arrayBuffer());
          let binary = "";
          for (let i = 0; i < view.length; i += 0x8000) {
            binary += String.fromCharCode.apply(null, Array.from(view.subarray(i, i + 0x8000)));
          }
          return {
            status: res.status,
            contentType: res.headers.get("content-type") || "",
            url: res.url,
            base64: btoa(binary),
          };
        },
        { url, timeoutMs: ms ?? timeoutMs },
      );
      return {
        status: got.status,
        contentType: got.contentType,
        bytes: new Uint8Array(Buffer.from(got.base64, "base64")),
        url: got.url,
      };
    },
    async close() {
      try { await context.close(); } catch { /* best effort */ }
      try { await browser.close(); } catch { /* best effort */ }
    },
  };
}
