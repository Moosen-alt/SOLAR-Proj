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

function isTimeout(err: unknown): boolean {
  return err instanceof Error && /timeout|TimeoutError/i.test(err.message);
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
}

// Run a single critical/optional action with retry. Classifies the outcome:
//   - required field that fails  -> { ok:false, ... }  (caller must surface it)
//   - optional field that fails  -> { ok:true, message } (tolerated, noted)
// Never logs values; `label` must be a non-PII field name supplied by the caller.
export async function safeAction(
  label: string,
  action: () => Promise<void>,
  opts: { required?: boolean; onRetry?: (attempt: number) => Promise<void> } = {},
): Promise<SafeActionResult> {
  try {
    await withRetry(action, opts.onRetry);
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
  "/mfa",
  "/2fa",
  "/otp",
  "verify",
];

// Visible challenge text fallback (covers no-iframe MFA prompts).
const CHALLENGE_TEXT = /captcha|i'?m not a robot|two.factor|2fa|authenticat|verify your|verification code|one.time (code|password)/i;

// STRUCTURALLY detect a CAPTCHA/MFA challenge on the page. Returns a short reason
// string if a challenge is present (so the caller can stop for a human), else null.
// Inspects every iframe's src/url for known challenge hosts, then falls back to
// visible challenge text. Never throws — detection failure returns null only after
// best effort.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function detectChallengeFrame(page: any): Promise<string | null> {
  if (!page) return null;
  try {
    // 1) Inspect frame URLs (the structural signal — works even with no visible text).
    const frames: any[] = typeof page.frames === "function" ? page.frames() : [];
    for (const frame of frames) {
      let url = "";
      try {
        url = typeof frame.url === "function" ? String(frame.url() ?? "") : "";
      } catch {
        url = "";
      }
      const lower = url.toLowerCase();
      const hit = CHALLENGE_FRAME_HOSTS.find((h) => lower.includes(h));
      if (hit) return `challenge frame detected (${hit})`;
    }

    // 2) Inspect iframe element src attributes (catches frames not yet navigated).
    try {
      const srcs: string[] = await page
        .locator("iframe")
        .evaluateAll((els: Element[]) => els.map((el) => (el as HTMLIFrameElement).getAttribute("src") || ""))
        .catch(() => []);
      for (const src of srcs) {
        const lower = String(src).toLowerCase();
        const hit = CHALLENGE_FRAME_HOSTS.find((h) => lower.includes(h));
        if (hit) return `challenge iframe src detected (${hit})`;
      }
    } catch {
      // ignore — fall through to text check
    }

    // 3) Visible challenge text fallback.
    try {
      const textHits = await page.getByText(CHALLENGE_TEXT).count().catch(() => 0);
      if (textHits > 0) return "challenge text detected on page";
    } catch {
      // ignore
    }
    return null;
  } catch {
    return null;
  }
}
