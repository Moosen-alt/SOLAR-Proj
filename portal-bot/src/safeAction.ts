import type { Page, Locator } from "playwright";

// Shared hardening helpers for portal adapters.
//
// These lift the retry + timeout + fallback pattern out of the recipe replay loop
// so the hand-coded Accela / PowerClerk adapters can route their critical
// fills/clicks through the same machinery:
//   - withRetry: re-run an action a few times on timeout, with backoff.
//   - safeAction: run an action and CLASSIFY the outcome (done / skipped / failed)
//     instead of silently swallowing every error. Required fields surface failures;
//     genuinely-optional fields stay tolerant.
//   - detectChallengeFrame: STRUCTURAL CAPTCHA/MFA detection (iframe src/url hosts),
//     so iframe-based challenges (reCAPTCHA, hCaptcha, Turnstile, MFA) are caught
//     before any final-submit click — even when they render no visible text yet.

export const RETRY_BACKOFF_MS = [2000, 5000, 10000];

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- PII redaction for returned result payloads -------------------------------
// The backend persists the whole adapter result, so adapters must never emit the
// homeowner name, full street address, account/meter numbers, or multi-thousand-
// char raw portal body dumps. These helpers cap and mask returned text.

const MAX_STATUS_SNIPPET = 320;

// Mask a sensitive identifier (account/meter/permit number), keeping only the
// last 4 chars: "9990001111" -> "******0000". Short values are fully masked.
export function maskId(value: string): string {
  const v = value.trim();
  if (v.length <= 4) return "*".repeat(v.length);
  return "*".repeat(v.length - 4) + v.slice(-4);
}

// Cap a status/portal-body string to a short snippet and mask any long digit runs
// (account / meter numbers leak into scraped portal text). Never returns more than
// MAX_STATUS_SNIPPET chars. Returns null for empty input.
export function redactStatusText(text: string | null | undefined): string | null {
  if (!text) return null;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  // Mask runs of 6+ digits (account/meter/phone-like) to their last 4.
  const masked = collapsed.replace(/\b(\d[\d\s-]{4,}\d)\b/g, (m) => {
    const digits = m.replace(/\D/g, "");
    return digits.length >= 6 ? maskId(digits) : m;
  });
  return masked.slice(0, MAX_STATUS_SNIPPET);
}

// Redact page text kept in a DIAGNOSTIC CAPTURE (a replay failure / review-miss file): every run
// of 6+ digits (account, meter, phone, parcel) masked to its last 4, every email address masked.
// Unlike redactStatusText it keeps the text's length budget large (a capture is read by a person
// debugging a page), and it never returns null. Idempotent.
export function redactCaptureText(text: string | null | undefined, max = 6000): string {
  const t = String(text ?? "");
  return t
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\d[\d\s().-]{4,}\d/g, (m) => {
      const digits = m.replace(/\D/g, "");
      return digits.length >= 6 ? maskId(digits) : m;
    })
    .slice(0, max);
}

// Read-only status scrape tail shared by the live adapters' checkStatus(): reads the page
// body text, finds the first known application/permit number, and returns a REDACTED,
// capped snippet around it (account/meter-like digit runs masked) — never a multi-thousand-
// char raw portal body dump. Falls back to a short redacted slice of the page head when no
// number matches. Callers own their own navigation + null-guards before calling this.
export async function scanStatusFromBody(page: Page, applicationNumbers: string[]): Promise<string | null> {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  for (const num of applicationNumbers) {
    if (!num) continue;
    const idx = bodyText.indexOf(num);
    if (idx === -1) continue;
    const snippet = redactStatusText(bodyText.slice(Math.max(0, idx - 80), idx + 320));
    if (snippet) return snippet;
  }
  return redactStatusText(bodyText.slice(0, 600));
}

// Strip a value to a bare decimal number (digits, optional single decimal, optional leading
// minus), dropping unit suffixes/symbols and thousands separators: "225A" -> "225",
// "8.6 kW" -> "8.6", "1,200" -> "1200". Returns "" when there is no number to extract, so
// callers can skip rather than blank a field.
export function toBareNumber(value: string): string {
  const match = String(value ?? "").match(/-?\d[\d,]*(?:\.\d+)?/);
  return match ? match[0].replace(/,/g, "") : "";
}

// True when a visible inline validation message near this field complains the value is not a
// valid number/decimal (e.g. PowerClerk's "Please enter a valid decimal number."). Walks a
// few ancestors so it catches the message whether it sits beside or below the input.
// Read-only; swallows its own errors.
export async function hasNumericValidationError(loc: Locator): Promise<boolean> {
  // Guard for test doubles / locators without a real evaluate(): treat as "no error".
  if (!loc || typeof (loc as { evaluate?: unknown }).evaluate !== "function") return false;
  return loc.evaluate((el: Element) => {
    let node: Element | null = el;
    for (let i = 0; i < 5 && node; i++) {
      const parent: Element | null = node.parentElement;
      if (!parent) break;
      const txt = (parent.textContent || "").toLowerCase();
      if (/valid (decimal|number)|enter a valid (decimal|number)|must be a (number|decimal)|not a valid number|numbers? only/.test(txt)) return true;
      node = parent;
    }
    return false;
  }).catch(() => false);
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && /timeout|TimeoutError/i.test(err.message);
}

// SPA-aware navigation wait. `networkidle` hangs indefinitely on portals that fire
// continuous background requests (React/Angular polling). This resolves on
// `domcontentloaded` (fast) and then races networkidle against a short ceiling so
// we never block more than ~extraMs on a busy SPA.
export async function smartWait(page: Page, extraMs = 2000): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => null);
  await Promise.race([
    page.waitForLoadState("networkidle", { timeout: extraMs }).catch(() => null),
    sleep(extraMs),
  ]);
}

// Wait for a locator to be attached and visible before interacting. More reliable
// than fill()/click() alone on portals that render fields progressively or animate
// them in. Falls back gracefully so callers never need to guard against nulls.
export async function waitForElement(loc: Locator | null | undefined, timeout = 10000): Promise<void> {
  if (!loc) return;
  await loc.waitFor({ state: "visible", timeout }).catch(() => null);
}

// Section-level render-readiness: poll until the SPA has MOUNTED at least one visible,
// interactive, fillable control — proof the section actually rendered. `networkidle` (or a
// plain visibility wait) is not enough on a Vue/React/ExtJS wizard: the page chrome and even
// the inputs can be present-but-unbound for a beat, so a fill fired too early sets the DOM
// value but it never commits to the JS model → a blank draft at review. Shared by the
// PowerClerk hand-coded adapter (waitForSectionReady) and the universal RecipeAdapter replay.
//
// Best-effort + NON-THROWING: a `false` return (no control mounted in time) must NEVER make a
// caller SKIP a section — callers fill regardless and the surrounding retry/reload recovers a
// genuine miss. On a page object without waitForFunction (the browser-free unit-test fakes)
// there is nothing to poll, so treat it as ready.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function waitForInteractiveControls(page: any, timeoutMs?: number): Promise<boolean> {
  if (!page || typeof page.waitForFunction !== "function") return true;
  const budget = timeoutMs
    || Number(process.env.PORTAL_SECTION_READY_MS)
    || Number(process.env.POWERCLERK_SECTION_READY_MS)
    || 12000;
  try {
    // NO NAMED FUNCTIONS INSIDE AN IN-PAGE PREDICATE. The bundler's keepNames transform
    // rewrites a named arrow (`const vis = (el) => ...`) as `__name((el) => ..., "vis")`,
    // and `__name` does not exist in the browser — the predicate threw
    // "ReferenceError: __name is not defined" on EVERY poll, so this gate could never
    // return true on any page of any portal and simply burned its full 12s budget each
    // time it was called (measured: 9/9 calls x 12s = 108s in one Accela run, and the
    // RecipeAdapter calls it after every goto and advancing click too). Keep the callback
    // anonymous and inline.
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll(
        "input:not([type=hidden]):not([disabled]):not([readonly]), select:not([disabled]), textarea:not([disabled]), [role=radio], [role=checkbox]",
      )).some((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const st = window.getComputedStyle(el as HTMLElement);
        return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
      }),
      undefined,
      { timeout: budget, polling: 250 },
    );
    return true;
  } catch {
    // No interactive control mounted within the budget — best-effort, never throw.
    return false;
  }
}

// Run `action` up to RETRY_BACKOFF_MS.length + 1 times. Only timeouts are retried;
// other errors fail fast. `onRetry` lets the caller recover stale page state
// (e.g. reload) between attempts. Re-throws the last error if every attempt fails.
export async function withRetry<T>(
  action: () => Promise<T>,
  onRetry?: (attempt: number) => Promise<void>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      return await action();
    } catch (err) {
      lastErr = err;
      if (!isTimeout(err) || attempt >= RETRY_BACKOFF_MS.length) break;
      await sleep(RETRY_BACKOFF_MS[attempt]);
      if (onRetry) await onRetry(attempt);
    }
  }
  throw lastErr;
}

export interface SafeActionResult {
  ok: boolean;
  // A short, already-redacted label for logs/results. NEVER pass PII here.
  field: string;
  message?: string;
  // True when a readback was performed AND the portal's value did not match the
  // `expected` value supplied by the caller. Only meaningful when both `readback`
  // and `expected` are passed; undefined otherwise.
  readbackMismatch?: boolean;
  // A redacted snippet of what the portal field actually contained after the fill,
  // included only when a mismatch was detected (for operator diagnostics). Already
  // run through redactStatusText — never raw PII.
  readbackValue?: string;
}

// Compare a portal read-back against the value we tried to fill. Normalizes both
// (lowercase, strip non-alphanumerics) so formatting differences ("$1,000" vs "1000",
// "7.5 kW" vs "7.5") don't register as mismatches. Empty expected = nothing to judge.
export function readbackMatches(actual: string, expected: string): boolean {
  const n = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  const a = n(actual);
  const e = n(expected);
  if (!e) return true; // no expected value to compare against
  if (!a) return false; // expected something, portal shows nothing
  return a === e || a.includes(e) || e.includes(a);
}

// Run a single critical/optional action with retry. Classifies the outcome:
//   - required field that fails  -> { ok:false, ... }  (caller must surface it)
//   - optional field that fails  -> { ok:true, message } (tolerated, noted)
// Never logs values; `label` must be a non-PII field name supplied by the caller.
// Pass `readback` + `expected` to verify the portal accepted the fill — `readback`
// returns the field's current value (e.g. `() => loc.inputValue()`) and it is compared
// against `expected`. A mismatch sets `readbackMismatch:true` but does NOT flip `ok` to
// false on its own (the caller decides how to treat mismatches).
export async function safeAction(
  label: string,
  action: () => Promise<void>,
  opts: {
    required?: boolean;
    onRetry?: (attempt: number) => Promise<void>;
    readback?: () => Promise<string>;
    expected?: string;
  } = {},
): Promise<SafeActionResult> {
  try {
    await withRetry(action, opts.onRetry);
    if (opts.readback) {
      try {
        const actual = await opts.readback();
        // Only judge a mismatch when the caller told us what to expect.
        if (opts.expected !== undefined && opts.expected !== "") {
          if (readbackMatches(actual, opts.expected)) {
            return { ok: true, field: label, readbackMismatch: false };
          }
          return { ok: true, field: label, readbackMismatch: true, readbackValue: redactStatusText(actual) ?? "" };
        }
        return { ok: true, field: label };
      } catch {
        // readback failure is non-fatal — the fill itself succeeded
        return { ok: true, field: label };
      }
    }
    return { ok: true, field: label };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.required) return { ok: false, field: label, message };
    return { ok: true, field: label, message: `optional, skipped: ${message}` };
  }
}

// Hosts/fragments that identify a CAPTCHA or MFA challenge iframe by src/URL.
const CHALLENGE_FRAME_HOSTS = [
  "recaptcha",
  "hcaptcha",
  "turnstile",
  "challenges.cloudflare.com",
  "arkoselabs",
  "funcaptcha",
  "duosecurity",
  "duo.com",
  "okta.com",
  "ping.identity",
  "pingone.com",
  "auth0.com",
  "microsoft.com/mfa",
  "microsoftonline.com",
  "/mfa",
  "/2fa",
  "/otp",
];

// IDENTITY-PROVIDER HOSTS ARE A CHALLENGE ONLY AS AN EMBEDDED FRAME, NEVER AS THE PAGE ITSELF.
//
// An Okta / Auth0 / Entra / Ping host in the MAIN frame is where an identifier-first login LIVES:
// page 1 (email + Next) and page 2 (password + Verify) are both served from it. Counting the host
// as a challenge there called a password page MFA before the password was typed, and the run
// stopped one field short of a login it could have finished. The second factor on such a host is
// recognised by what the PAGE says (detectSecondFactor), which also works on a custom identity
// domain (Tyler's identity.tylerportico.com is Okta with no okta.com anywhere in its URL).
const IDP_HOSTS = ["okta.com", "ping.identity", "pingone.com", "auth0.com", "microsoftonline.com"];

// "verify" as a PATH SEGMENT, not a substring of the whole URL. The bare substring matched any
// URL whose query carried the word — an OAuth authorize URL's redirect_uri or state routinely
// does — and read a sign-in page as an MFA stop. Okta Classic's factor pages are /signin/verify/…,
// which this still catches.
const VERIFY_PATH = /(^|\/)verify(\/|$)/i;

/** Is this frame URL a challenge? `isMain` = the top-level page (IdP hosts do not count there). */
function challengeUrlHit(rawUrl: string, isMain: boolean): string | null {
  const lower = String(rawUrl || "").toLowerCase();
  if (!lower) return null;
  const hit = CHALLENGE_FRAME_HOSTS.find((h) => lower.includes(h) && !(isMain && IDP_HOSTS.includes(h)));
  if (hit) return hit;
  try {
    const u = new URL(rawUrl, "http://frame.invalid/");
    if (VERIFY_PATH.test(u.pathname)) return "verify";
  } catch { /* not a URL */ }
  return null;
}

// Page titles that signal a challenge screen (checked before scraping body text).
const CHALLENGE_TITLE = /captcha|verify|two.factor|2fa|authenticat|identity check|security check|are you human/i;

// Visible challenge text fallback (covers no-iframe MFA prompts).
const CHALLENGE_TEXT = /captcha|i'?m not a robot|two.factor|2fa|authenticat|verify your identity|verification code|one.time (code|password)|enter the code|approve the sign.in/i;

// STRUCTURALLY detect a CAPTCHA/MFA challenge on the page. Returns a short reason
// string if a challenge is present (so the caller can stop for a human), else null.
// Checks in order: page title (fast), frame URLs (structural), iframe src attributes,
// visible body text. Never throws — detection failure returns null only after best effort.
//
// opts.structuralOnly skips the two READINGS (title, visible text) and asks only the frame URLs /
// iframe srcs. The login flow uses it on a page that still shows a password box, where a reading
// is the password step talking ("Verify with your password", an "… Authentication" title) but a
// CAPTCHA frame is still a CAPTCHA. Without it the title reading, checked first, returned before
// the frames were ever looked at and hid a real CAPTCHA frame behind itself.
export async function detectChallengeFrame(
  page: Page | null | undefined,
  opts: { structuralOnly?: boolean } = {},
): Promise<string | null> {
  if (!page) return null;
  try {
    // 0) Page title — the fastest check; challenge pages almost always have a distinctive title.
    if (!opts.structuralOnly) try {
      const title = typeof (page as { title?: () => Promise<string> }).title === "function"
        ? await (page as { title: () => Promise<string> }).title().catch(() => "")
        : "";
      if (CHALLENGE_TITLE.test(title)) return `challenge page title detected ("${title.slice(0, 40)}")`;
    } catch { /* ignore */ }

    // 1) Inspect frame URLs (the structural signal — works even with no visible text).
    const frames: Array<{ url: () => string }> = typeof (page as { frames?: () => unknown[] }).frames === "function"
      ? ((page as { frames: () => Array<{ url: () => string }> }).frames())
      : [];
    let mainFrame: unknown = null;
    try {
      mainFrame = typeof (page as { mainFrame?: () => unknown }).mainFrame === "function"
        ? (page as { mainFrame: () => unknown }).mainFrame()
        : null;
    } catch { mainFrame = null; }
    for (const frame of frames) {
      let url = "";
      try { url = typeof frame.url === "function" ? String(frame.url() ?? "") : ""; } catch { url = ""; }
      const hit = challengeUrlHit(url, mainFrame !== null && frame === mainFrame);
      if (hit) return `challenge frame detected (${hit})`;
    }

    // 2) Inspect iframe element src attributes (catches frames not yet navigated).
    try {
      const srcs: string[] = await (page as { locator: (s: string) => { evaluateAll: (fn: (e: Element[]) => string[]) => Promise<string[]> } })
        .locator("iframe")
        .evaluateAll((els: Element[]) => els.map((el) => (el as HTMLIFrameElement).getAttribute("src") || ""))
        .catch(() => [] as string[]);
      for (const src of srcs) {
        // An <iframe> element is never the top-level page, so every host counts here.
        const hit = challengeUrlHit(String(src), false);
        if (hit) return `challenge iframe src detected (${hit})`;
      }
    } catch { /* ignore */ }

    if (opts.structuralOnly) return null;

    // 3) Visible challenge text fallback — only count a match that is actually VISIBLE. A
    //    hidden template / tooltip / aria string containing a keyword (e.g. "verification")
    //    on a normal application form must NOT trigger a false MFA stop. Real no-iframe MFA
    //    prompts render their challenge text visibly.
    try {
      const loc = (page as {
        getByText: (r: RegExp) => {
          count: () => Promise<number>;
          nth: (i: number) => { isVisible: () => Promise<boolean> };
        };
      }).getByText(CHALLENGE_TEXT);
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 6); i++) {
        const visible = await loc.nth(i).isVisible().catch(() => false);
        if (visible) return "challenge text detected on page";
      }
    } catch { /* ignore */ }

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SECOND-FACTOR SCREEN — recognised by what the page SAYS and HOLDS, not by its host.
//
// Okta Identity Engine's factor screens ("Get a verification email" / "Send me an email", "Get a
// push notification", "Select an authenticator", "Enter a code") matched none of the challenge
// patterns above, and Tyler's Okta sits on its own domain (identity.tylerportico.com), so the host
// list never saw it either. The login poll then timed out into "the stored username/password was
// likely rejected", the backend marked a GOOD credential stale, and staging refused it as locked
// out (the portal-test-prep blocker B6).
//
// THE PASSWORD CLAUSE IS LOAD-BEARING. Okta's PASSWORD page carries "Verify with something else"
// and a "Verify" button too, so factor wording alone is not a second factor: any visible password
// box in any frame means this is still the password step (or a wrong-password re-render, which is
// a failed login, not MFA). A page is a second-factor challenge only when it has factor wording or
// a one-time-code field AND no password field at all. That is also what makes it safe to PARK on:
// a person waiting at a page with no password box can never be asked to type the password.
//
// Returns a short reason, or "" — never throws. Reads only; types nothing and clicks nothing.
// ---------------------------------------------------------------------------
export const SECOND_FACTOR_TEXT_SOURCE = [
  "select an authenticator", "choose an authenticator", "set up security methods",
  "verify it'?s you with a security method", "verify with your (e-?mail|phone)",
  "verify with something else", "send me an e-?mail", "get a verification e-?mail",
  "we sent (you )?(an e-?mail|a code|a verification)", "enter (a|the|your) (verification |security |one[- ]time )?code",
  "verification code", "one[- ]time (code|passcode|password)", "get a push notification",
  "push notification (has been )?sent", "okta verify", "google authenticator", "authenticator app",
  "security key or biometric", "answer (your|the) security question", "two[- ]factor", "2-step verification",
  "multi[- ]factor", "approve the sign[- ]in", "check your (e-?mail|phone) for a code",
].join("|");

export async function detectSecondFactor(page: Page | null | undefined): Promise<string> {
  if (!page || typeof (page as { frames?: unknown }).frames !== "function") return "";
  try {
    let wording = "";
    let codeField = false;
    for (const frame of page.frames()) {
      const r = await frame.evaluate((src: string) => {
        // Fully inline — no named helper (the __name note in waitForInteractiveControls).
        const inputs = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
        let password = false;
        let code = false;
        for (const el of inputs) {
          const rect = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          if (!(rect.width > 2 && rect.height > 2 && st.visibility !== "hidden" && st.display !== "none")) continue;
          const type = (el.getAttribute("type") || "text").toLowerCase();
          if (type === "password") { password = true; continue; }
          const hay = [el.name, el.id, el.getAttribute("autocomplete"), el.getAttribute("aria-label"), el.getAttribute("placeholder")]
            .filter(Boolean).join(" ");
          if (/one-time-code|passcode|\botp\b|verification.?code|security.?code|mfa.?code|credentials\.passcode/i.test(hay)) code = true;
        }
        const text = String((document.body && (document.body as HTMLElement).innerText) || "").replace(/\s+/g, " ").slice(0, 6000);
        const m = text.match(new RegExp(src, "i"));
        return { password, code, wording: m ? m[0] : "" };
      }, SECOND_FACTOR_TEXT_SOURCE).catch(() => null);
      if (!r) continue;
      if (r.password) return ""; // still the password step, in some frame — never a second factor
      if (r.code) codeField = true;
      if (r.wording && !wording) wording = r.wording;
    }
    if (wording) return `a second-factor screen ("${wording.slice(0, 50)}")${codeField ? " with a code field" : ""}`;
    if (codeField) return "a second-factor screen (a one-time-code field and no password field)";
    return "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Frame targeting — turn a recorded frame KEY into the frameLocator CSS both the
// learner and the recipe replay use to scope into a child <iframe>.
// Two key forms:
//   "<name-or-id>"        — the frame element's name or id attribute (stable, preferred).
//   "src:<path-fragment>" — the frame's src URL pathname, for frames with NO name/id
//                           (incl. cross-origin embeds). frameLocator matches by CSS on
//                           the PARENT document's <iframe src>, which Playwright can then
//                           drive regardless of the frame's origin.
// ---------------------------------------------------------------------------
export function frameSelectorFor(frameKey: string): string {
  const esc = (s: string) => s.replace(/["\\]/g, "\\$&");
  if (frameKey.startsWith("src:")) return `iframe[src*="${esc(frameKey.slice(4))}"]`;
  return `iframe[name="${esc(frameKey)}"], iframe[id="${esc(frameKey)}"]`;
}
