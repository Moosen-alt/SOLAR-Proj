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

// THE PORTAL'S OWN WORDS, FROM THE BANNER FAMILIES THE GENERIC VALIDATION READER DOES NOT KNOW.
//
// Live run 99baa5d0 (Oregon ePermitting, 2026-09-27): the page said "An error has occurred. Please
// select at least 1 electrical service for purchase" in Accela's message bar
// (#messageSpan > .ACA_Message_Error > #messageSpanContent) and the run reported "The portal gave
// no visible reason". collectValidationErrorsFrom (autoLearnAdapter) reads the MVC/Bootstrap
// families — [class*="error-message"] is case-sensitive and never matches ACA_Message_Error — so
// this reads the ASP.NET WebForms / Accela ones beside it: the message bar, the per-field
// ACA_ErrorMessageLabel spans (empty unless the field failed), the validation summary, and the
// role=alert family again for portals that use it. Case-INSENSITIVE on the class families.
//
// The generic heading ("An error has occurred.") is dropped when a specific line follows it, so
// the failure reads "The portal says: Please select at least 1 electrical service for purchase"
// and not the heading alone. Hidden elements are never read (Accela renders empty, hidden error
// indicators beside every field).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function collectPortalErrorBanner(page: any): Promise<string[]> {
  if (!page || typeof page.evaluate !== "function") return [];
  try {
    const raw = await page.evaluate((): string[] => {
      const out: string[] = [];
      const visible = (el: Element): boolean => {
        const h = el as HTMLElement;
        if (!h) return false;
        const st = window.getComputedStyle(h);
        if (st.display === "none" || st.visibility === "hidden") return false;
        const r = h.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const sels = [
        "#messageSpanContent", ".ACA_Message_Error", "[class*='Message_Error' i]", "[class*='MessageError' i]",
        ".ACA_ErrorMessageLabel", "[class*='ErrorMessageLabel' i]", "[id*='ValidationSummary' i]", "[class*='validation-summary' i]",
        "[class*='ErrorMessage' i]:not([class*='Label' i])", "[role='alert']", "[aria-live='assertive']", ".alert-danger", ".error-summary",
      ];
      const seen = new Set<Element>();
      for (const sel of sels) {
        let els: Element[] = [];
        try { els = Array.from(document.querySelectorAll(sel)); } catch { continue; }
        for (const el of els) {
          if (seen.has(el) || !visible(el)) continue;
          // An outer container whose text is only its inner banner would duplicate it; keep the
          // innermost element that carries the text.
          seen.add(el);
          const t = ((el as HTMLElement).innerText || "").replace(/\r/g, "").trim();
          if (t) out.push(t);
        }
      }
      return out.slice(0, 40);
    }) as string[];
    const lines: string[] = [];
    const seen = new Set<string>();
    const GENERIC = /^(an )?error has occurred\.?$|^error:?$|^please correct the (following )?errors?\.?:?$/i;
    for (const block of raw) {
      for (const line of String(block).split(/\n+/)) {
        const t = line.replace(/\s+/g, " ").trim();
        if (!t || t.length < 4 || t.length > 400) continue;
        const key = t.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(t);
      }
    }
    const specific = lines.filter((l) => !GENERIC.test(l));
    return (specific.length ? specific : lines).slice(0, 20);
  } catch {
    return [];
  }
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

// ---------------------------------------------------------------------------
// A CHALLENGE IS NEVER A PASSWORD STEP — one predicate, three classes (production 2026-09-27,
// City of Tigard OR: three supervised learns stopped in ~10 s at Okta's "Verify with your
// password" page as "challenge frame detected (okta.com)", and the browser closed on the person).
//
//   CAPTCHA  — a widget a person must solve (reCAPTCHA / hCaptcha / Turnstile / Arkose frames, the
//              "I'm not a robot" box, a "captcha" / "are you human" / "security check" reading).
//              Always a challenge, whatever else the page holds: a password typed under an
//              unsolved CAPTCHA is still a CAPTCHA the bot would be working around.
//   MFA      — a second-factor frame or path (Duo, microsoft.com/mfa, /mfa /2fa /otp /verify) or a
//              second-factor READING (title / visible text: "verify", "authenticat", "two-factor",
//              "verification code", "enter the code", "approve the sign-in"…). A challenge ONLY
//              where no login box is showing: a visible password box — or a visible identifier
//              (username / email) box with no one-time-code box beside it — means THIS PAGE IS THE
//              LOGIN, whatever its title, host or "Verify" wording says. Okta's password step is
//              headed "Verify with your password" and titled "… | Verify with your password";
//              identity hosts title every page "… Authentication".
//   IDP HOST — okta.com, auth0.com, microsoftonline.com, pingone / ping.identity. NEVER a challenge
//              by host, in ANY frame. The LOGIN lives there. Okta's sign-in widget serves every
//              page (identifier, password, factor) with a hidden account-chooser frame at
//              login.okta.com/discovery/iframe.html — also on a CUSTOM identity domain
//              (identity.tylerportico.com is Okta: Tyler Portico fronts every EnerGov self-service
//              portal on tylerhost.net and many city-hosted ones). Counting the host in a child
//              frame stopped every such login at the password step before the password was typed.
//              An IdP's second-factor page is recognised by what the page SAYS and HOLDS
//              (detectSecondFactor below, and the MFA readings here), never by whose host it is.
//
// Every caller (the login flow, the learner's walk gate, the replay's final-submit check, the
// hand-coded adapters) asks this one predicate, so they cannot disagree about a login page.
// ---------------------------------------------------------------------------
const CAPTCHA_FRAME_HOSTS = [
  "recaptcha",
  "hcaptcha",
  "turnstile",
  "challenges.cloudflare.com",
  "arkoselabs",
  "funcaptcha",
];
const MFA_FRAME_HOSTS = ["duosecurity", "duo.com", "microsoft.com/mfa"];
// Read on the frame's path (+ hash route), never its query: an OAuth authorize URL routinely
// carries a redirect_uri or state holding "/verify" or "/otp", and that is a sign-in page.
const MFA_PATH_FRAGMENT = /\/(mfa|2fa|otp)/i;
// "verify" as a PATH SEGMENT. Okta Classic's factor pages are /signin/verify/…, which this catches.
const VERIFY_PATH = /(^|\/)verify(\/|$)/i;

type ChallengeClass = "captcha" | "mfa";

/** Is this frame URL a challenge, and of which class? Identity-provider hosts never are. */
function challengeUrlHit(rawUrl: string): { cls: ChallengeClass; hit: string } | null {
  const raw = String(rawUrl || "");
  if (!raw) return null;
  let hostPath = raw.toLowerCase();
  let path = "";
  try {
    const u = new URL(raw, "http://frame.invalid/");
    hostPath = `${u.host}${u.pathname}${u.hash}`.toLowerCase();
    path = `${u.pathname}${u.hash}`;
  } catch { /* not a URL — read the raw string */ }
  const captcha = CAPTCHA_FRAME_HOSTS.find((h) => hostPath.includes(h));
  if (captcha) return { cls: "captcha", hit: captcha };
  const mfa = MFA_FRAME_HOSTS.find((h) => hostPath.includes(h));
  if (mfa) return { cls: "mfa", hit: mfa };
  const frag = path.match(MFA_PATH_FRAGMENT);
  if (frag) return { cls: "mfa", hit: frag[0].toLowerCase() };
  if (VERIFY_PATH.test(path.split("#")[0] ?? "")) return { cls: "mfa", hit: "verify" };
  return null;
}

// Page titles that signal a challenge screen, by class.
const CAPTCHA_TITLE = /captcha|security check|are you human/i;
const MFA_TITLE = /verify|two.factor|2fa|authenticat|identity check/i;

// Visible challenge text (covers no-iframe prompts), by class.
const CAPTCHA_TEXT = /captcha|i'?m not a robot/i;
const MFA_TEXT = /two.factor|2fa|authenticat|verify your identity|verification code|one.time (code|password)|enter the code|approve the sign.in/i;

/**
 * IS A LOGIN BOX SHOWING? true = a visible password box in any frame, or a visible identifier
 * (username / email) box with no visible one-time-code box in any frame. null = the page could
 * not answer (a test double, a frame mid-navigation) — the caller then keeps the challenge
 * (fail closed: an unreadable page never waves an MFA reading through). Reads only.
 */
export async function loginBoxShowing(page: Page | null | undefined): Promise<boolean | null> {
  if (!page || typeof (page as { frames?: unknown }).frames !== "function") return null;
  try {
    let answered = false;
    let identifier = false;
    let code = false;
    for (const frame of page.frames()) {
      const r = await Promise.race([
        frame.evaluate(() => {
          // Fully inline — no named helper (the __name note in waitForInteractiveControls).
          let password = false;
          let ident = false;
          let otp = false;
          for (const el of Array.from(document.querySelectorAll("input")) as HTMLInputElement[]) {
            const rect = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            if (!(rect.width > 2 && rect.height > 2 && st.visibility !== "hidden" && st.display !== "none")) continue;
            const type = (el.getAttribute("type") || "text").toLowerCase();
            if (type === "password") { password = true; continue; }
            if (!["text", "email", "tel", ""].includes(type)) continue;
            const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
            const hay = [el.name, el.id, ac, el.getAttribute("aria-label"), el.getAttribute("placeholder")].filter(Boolean).join(" ");
            if (/one-time-code|passcode|\botp\b|verification.?code|security.?code|mfa.?code|\bcode\b/i.test(hay)) { otp = true; continue; }
            const key = `${el.name || ""} ${el.id || ""}`.toLowerCase().replace(/[^a-z ]/g, "");
            if (ac === "username" || ac === "email" || type === "email"
              || /(^| )(user ?name|userid|username|identifier|login ?(id|name)?|e?mail ?(address)?)( |$)/.test(key)) ident = true;
          }
          return { password, ident, otp };
        }),
        new Promise<null>((res) => setTimeout(() => res(null), 2500)),
      ]).catch(() => null);
      if (!r) continue;
      answered = true;
      if (r.password) return true;
      if (r.ident) identifier = true;
      if (r.otp) code = true;
    }
    if (!answered) return null;
    return identifier && !code;
  } catch {
    return null;
  }
}

// STRUCTURALLY detect a CAPTCHA/MFA challenge on the page. Returns a short reason
// string if a challenge is present (so the caller can stop for a human), else null.
// CAPTCHA first (frames, iframe srcs, title, visible text), then MFA — the MFA class only where
// no login box is showing (see the note above). Never throws — detection failure returns null
// only after best effort.
//
// opts.structuralOnly skips the READINGS (title, visible text) and asks only the frame URLs /
// iframe srcs. The login flow uses it on a page that still shows a password box, where a reading
// is the password step talking but a CAPTCHA frame is still a CAPTCHA.
//
// Reason strings are read by callers: a text reading starts "challenge text detected" (the
// learner's walk gate tolerates it on a field-rich page); a frame names what it hit.
export async function detectChallengeFrame(
  page: Page | null | undefined,
  opts: { structuralOnly?: boolean } = {},
): Promise<string | null> {
  if (!page) return null;
  try {
    // 1) Frame URLs (the structural signal — works even with no visible text) and iframe src
    //    attributes (catches frames not yet navigated). Collected once, classified below.
    const urls: Array<{ url: string; kind: "frame" | "iframe src" }> = [];
    const frames: Array<{ url: () => string }> = typeof (page as { frames?: () => unknown[] }).frames === "function"
      ? ((page as { frames: () => Array<{ url: () => string }> }).frames())
      : [];
    for (const frame of frames) {
      let url = "";
      try { url = typeof frame.url === "function" ? String(frame.url() ?? "") : ""; } catch { url = ""; }
      if (url) urls.push({ url, kind: "frame" });
    }
    try {
      const srcs: string[] = await (page as { locator: (s: string) => { evaluateAll: (fn: (e: Element[]) => string[]) => Promise<string[]> } })
        .locator("iframe")
        .evaluateAll((els: Element[]) => els.map((el) => (el as HTMLIFrameElement).getAttribute("src") || ""))
        .catch(() => [] as string[]);
      for (const src of srcs) if (src) urls.push({ url: String(src), kind: "iframe src" });
    } catch { /* ignore */ }
    const hits = urls.map((u) => ({ ...u, h: challengeUrlHit(u.url) })).filter((u) => u.h);
    const say = (u: { kind: string; h: { hit: string } | null }) => `challenge ${u.kind} detected (${u.h!.hit})`;

    // 2) CAPTCHA — always a challenge.
    const captchaFrame = hits.find((u) => u.h!.cls === "captcha");
    if (captchaFrame) return say(captchaFrame);
    const title = opts.structuralOnly ? "" : await (async () => {
      try {
        return typeof (page as { title?: () => Promise<string> }).title === "function"
          ? String(await (page as { title: () => Promise<string> }).title().catch(() => "") ?? "")
          : "";
      } catch { return ""; }
    })();
    if (title && CAPTCHA_TITLE.test(title)) return `challenge page title detected ("${title.slice(0, 40)}")`;
    if (!opts.structuralOnly && await visibleText(page, CAPTCHA_TEXT)) return "challenge text detected on page (captcha)";

    // 3) MFA — a challenge only where no login box is showing. Asked lazily: most pages have no
    //    MFA-class hit at all, and the login-box read walks every frame.
    let loginBox: boolean | null | undefined;
    const isLoginStep = async (): Promise<boolean> => {
      if (loginBox === undefined) loginBox = await loginBoxShowing(page);
      return loginBox === true;
    };
    const mfaFrame = hits.find((u) => u.h!.cls === "mfa");
    if (mfaFrame && !(await isLoginStep())) return say(mfaFrame);
    if (opts.structuralOnly) return null;
    if (title && MFA_TITLE.test(title) && !(await isLoginStep())) return `challenge page title detected ("${title.slice(0, 40)}")`;
    // Visible challenge text fallback — only count a match that is actually VISIBLE. A hidden
    // template / tooltip / aria string containing a keyword (e.g. "verification") on a normal
    // application form must NOT trigger a false MFA stop. Real no-iframe MFA prompts render
    // their challenge text visibly.
    if (await visibleText(page, MFA_TEXT) && !(await isLoginStep())) return "challenge text detected on page";

    return null;
  } catch {
    return null;
  }
}

/** Is a match of `re` VISIBLE on the page (main document)? Never throws. */
async function visibleText(page: Page, re: RegExp): Promise<boolean> {
  try {
    const loc = (page as unknown as {
      getByText: (r: RegExp) => {
        count: () => Promise<number>;
        nth: (i: number) => { isVisible: () => Promise<boolean> };
      };
    }).getByText(re);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 6); i++) {
      if (await loc.nth(i).isVisible().catch(() => false)) return true;
    }
  } catch { /* ignore */ }
  return false;
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
