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
// last 4 chars: "4036870000" -> "******0000". Short values are fully masked.
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
    await page.waitForFunction(
      () => {
        const vis = (el: Element): boolean => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const st = window.getComputedStyle(el as HTMLElement);
          return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
        };
        const controls = Array.from(document.querySelectorAll(
          "input:not([type=hidden]):not([disabled]):not([readonly]), select:not([disabled]), textarea:not([disabled]), [role=radio], [role=checkbox]",
        ));
        return controls.some(vis);
      },
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
  "verify",
];

// Page titles that signal a challenge screen (checked before scraping body text).
const CHALLENGE_TITLE = /captcha|verify|two.factor|2fa|authenticat|identity check|security check|are you human/i;

// Visible challenge text fallback (covers no-iframe MFA prompts).
const CHALLENGE_TEXT = /captcha|i'?m not a robot|two.factor|2fa|authenticat|verify your identity|verification code|one.time (code|password)|enter the code|approve the sign.in/i;

// STRUCTURALLY detect a CAPTCHA/MFA challenge on the page. Returns a short reason
// string if a challenge is present (so the caller can stop for a human), else null.
// Checks in order: page title (fast), frame URLs (structural), iframe src attributes,
// visible body text. Never throws — detection failure returns null only after best effort.
export async function detectChallengeFrame(page: Page | null | undefined): Promise<string | null> {
  if (!page) return null;
  try {
    // 0) Page title — the fastest check; challenge pages almost always have a distinctive title.
    try {
      const title = typeof (page as { title?: () => Promise<string> }).title === "function"
        ? await (page as { title: () => Promise<string> }).title().catch(() => "")
        : "";
      if (CHALLENGE_TITLE.test(title)) return `challenge page title detected ("${title.slice(0, 40)}")`;
    } catch { /* ignore */ }

    // 1) Inspect frame URLs (the structural signal — works even with no visible text).
    const frames: Array<{ url: () => string }> = typeof (page as { frames?: () => unknown[] }).frames === "function"
      ? ((page as { frames: () => Array<{ url: () => string }> }).frames())
      : [];
    for (const frame of frames) {
      let url = "";
      try { url = typeof frame.url === "function" ? String(frame.url() ?? "") : ""; } catch { url = ""; }
      const lower = url.toLowerCase();
      const hit = CHALLENGE_FRAME_HOSTS.find((h) => lower.includes(h));
      if (hit) return `challenge frame detected (${hit})`;
    }

    // 2) Inspect iframe element src attributes (catches frames not yet navigated).
    try {
      const srcs: string[] = await (page as { locator: (s: string) => { evaluateAll: (fn: (e: Element[]) => string[]) => Promise<string[]> } })
        .locator("iframe")
        .evaluateAll((els: Element[]) => els.map((el) => (el as HTMLIFrameElement).getAttribute("src") || ""))
        .catch(() => [] as string[]);
      for (const src of srcs) {
        const lower = String(src).toLowerCase();
        const hit = CHALLENGE_FRAME_HOSTS.find((h) => lower.includes(h));
        if (hit) return `challenge iframe src detected (${hit})`;
      }
    } catch { /* ignore */ }

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
