/**
 * Network-level portal recipe recorder (Path B — bypass the DOM).
 *
 * PowerClerk / Accela are server-rendered apps: their SPA front-end POSTs every
 * field to backend endpoints with the session cookie + an anti-forgery token.
 * Driving the custom dropdowns via the DOM is brittle (it produced blank PGE
 * drafts). Instead we CAPTURE the save requests the page fires while a form is
 * filled once, infer which values map to project fields, redact secrets, and
 * emit a portable NetworkRecipe. The replay engine (separate module) re-fires
 * those requests headless with a fresh token and each project's own values.
 *
 * SECURITY:
 *   - Credential / PII values (password, account#, meter#) are NEVER stored in
 *     the recipe. They are detected in the body and replaced with a redaction
 *     placeholder; replay rehydrates them from the encrypted credential store.
 *   - The anti-forgery token VALUE is never trusted from the recording; replay
 *     always re-scrapes a live token. We only record WHERE the token lives.
 *   - Final-submit / fee requests are flagged, never auto-fired by replay.
 */

import type {
  NetworkFieldBinding,
  NetworkRecipe,
  NetworkRequestRecord,
} from "../../shared/src/types";

// Header / body keys ASP.NET MVC (PowerClerk) and common stacks use for CSRF.
const CSRF_HEADER_RE = /^(requestverificationtoken|x-csrf-token|x-xsrf-token|x-anti-forgery)$/i;
const CSRF_BODY_KEY_RE = /__RequestVerificationToken|csrf_token|authenticity_token/i;

// Request URLs we never record: analytics, telemetry, asset/font/image fetches,
// and PowerClerk's own polling/heartbeat noise. Keeps the recipe to real saves.
const IGNORE_URL_RE = new RegExp(
  [
    "google-analytics", "googletagmanager", "doubleclick", "segment\\.io",
    "sentry", "newrelic", "hotjar", "fullstory", "/ping", "/heartbeat",
    "\\.(png|jpe?g|gif|svg|woff2?|ttf|css|js|ico|map)(\\?|$)",
  ].join("|"),
  "i",
);

// Only these methods mutate server state — the ones worth replaying.
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Request URL/body signals that this is a final submit or a fee payment. Flagged
// so replay STOPS before them (guided-manual) and never auto-pays.
// No trailing \b: portal endpoints concatenate words ("SubmitApplication",
// "CompleteApplication") so a word boundary after the keyword would miss them.
const FINAL_SUBMIT_RE = /(submit|finalize|completeapplication|fileapplication)/i;
const PAY_FEE_RE = /(payment|checkout|invoice|paymentus|payfee)/i;

export interface CaptureInput {
  /** NON-sensitive project/client field values, keyed by field name. Used to
   *  infer bindings (value-in-body → field) so replay substitutes new values. */
  fieldValues: Record<string, string>;
  /** SENSITIVE values (account#, meter#, password) keyed by field name. Detected
   *  in bodies and REDACTED — never written to the recipe. */
  sensitiveValues?: Record<string, string>;
}

// A value is worth binding only if it's distinctive enough that finding it in a
// request body is meaningful (avoids "OR", "1", "Yes" matching everything).
function isBindable(value: string): boolean {
  const v = value.trim();
  if (v.length < 3) return false;
  if (/^(yes|no|true|false|on|off|n\/a|none)$/i.test(v)) return false;
  return true;
}

/**
 * Redact every sensitive value found in a body, replacing each with a stable
 * placeholder token, and emit a sensitive binding for each. Pure — no I/O.
 * Returns the redacted body plus the sensitive bindings discovered.
 */
export function redactSensitive(
  body: string,
  sensitiveValues: Record<string, string>,
): { body: string; bindings: NetworkFieldBinding[] } {
  let out = body;
  const bindings: NetworkFieldBinding[] = [];
  for (const [field, value] of Object.entries(sensitiveValues)) {
    if (!value || value.length < 2) continue;
    if (!out.includes(value)) continue;
    const placeholder = `__REDACTED:${field}__`;
    out = out.split(value).join(placeholder);
    bindings.push({ field, sensitive: true, recordedValue: undefined });
  }
  return { body: out, bindings };
}

/**
 * Infer NON-sensitive field bindings by locating each known field value in the
 * (already sensitive-redacted) body. Pure — no I/O. Replay does a literal
 * recordedValue → newValue replacement, so we store the recorded value.
 */
export function inferBindings(
  body: string,
  fieldValues: Record<string, string>,
): NetworkFieldBinding[] {
  const bindings: NetworkFieldBinding[] = [];
  for (const [field, value] of Object.entries(fieldValues)) {
    if (!value || !isBindable(value)) continue;
    if (!body.includes(value)) continue;
    bindings.push({ field, recordedValue: value });
  }
  return bindings;
}

/** Pull the CSRF header name (if present) from a request's headers. */
export function findCsrfHeader(headers: Record<string, string>): string | undefined {
  for (const key of Object.keys(headers)) {
    if (CSRF_HEADER_RE.test(key)) return key;
  }
  return undefined;
}

/** Pull the CSRF body key (if the token is carried in the form body). */
export function findCsrfBodyKey(body: string): string | undefined {
  const m = body.match(CSRF_BODY_KEY_RE);
  return m ? m[0] : undefined;
}

/** Decide whether a request should be captured at all. */
export function shouldCapture(method: string, url: string, resourceType: string): boolean {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return false;
  if (IGNORE_URL_RE.test(url)) return false;
  // Only app data calls — xhr/fetch. Navigations (document) are replayed as gotos
  // by the path-param templating, not as raw requests.
  if (resourceType && !["xhr", "fetch"].includes(resourceType)) return false;
  return true;
}

export class NetworkRecorder {
  private requests: NetworkRequestRecord[] = [];
  private seq = 0;
  private input: CaptureInput;
  // Map of seq → request, so the response handler can stamp the observed status.
  private bySeq = new Map<number, NetworkRequestRecord>();
  // Correlate Playwright request objects to our seq across the request/response pair.
  private requestSeq = new WeakMap<object, number>();

  constructor(input: CaptureInput) {
    this.input = input;
  }

  /**
   * Attach capture listeners to a Playwright page. Safe to call once per page.
   * eslint-disable for `any` because we keep portal-bot Playwright-version-agnostic
   * (the adapters all type page as `any`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attach(page: any): void {
    page.on("request", (request: any) => {
      try {
        this.onRequest(request);
      } catch {
        // never let capture instrumentation break the recording session
      }
    });
    page.on("response", (response: any) => {
      try {
        const req = response.request();
        const seq = this.requestSeq.get(req);
        if (seq == null) return;
        const rec = this.bySeq.get(seq);
        if (rec) rec.responseStatus = response.status();
      } catch {
        // ignore
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onRequest(request: any): void {
    const method = String(request.method() ?? "GET");
    const url = String(request.url() ?? "");
    const resourceType = String(request.resourceType?.() ?? "");
    if (!shouldCapture(method, url, resourceType)) return;

    const headers: Record<string, string> = request.headers ? request.headers() : {};
    const rawBody = typeof request.postData === "function" ? (request.postData() ?? "") : "";

    // Redact secrets FIRST, then infer non-sensitive bindings on the redacted body.
    const { body: redactedBody, bindings: sensitiveBindings } = redactSensitive(
      rawBody,
      this.input.sensitiveValues ?? {},
    );
    const valueBindings = inferBindings(redactedBody, this.input.fieldValues);

    const seq = this.seq++;
    const isFinal = FINAL_SUBMIT_RE.test(url) || PAY_FEE_RE.test(url);
    const rec: NetworkRequestRecord = {
      seq,
      method: method.toUpperCase(),
      url,
      resourceType,
      contentType: headers["content-type"] ?? headers["Content-Type"],
      bodyRaw: redactedBody || undefined,
      csrfHeaderName: findCsrfHeader(headers),
      csrfBodyKey: redactedBody ? findCsrfBodyKey(redactedBody) : undefined,
      bindings: [...sensitiveBindings, ...valueBindings],
      isFinalSubmit: isFinal || undefined,
      note: isFinal ? "Flagged final-submit/fee — replay never auto-fires this." : undefined,
    };
    this.requests.push(rec);
    this.bySeq.set(seq, rec);
    this.requestSeq.set(request, seq);
  }

  /** How many save requests have been captured so far (for live progress). */
  count(): number {
    return this.requests.length;
  }

  /** Assemble the final recipe. `pathParamKeys` lets the caller record the
   *  per-project ids (ProjectId/FormId/ProgramId) seen in the recording URLs. */
  build(meta: {
    scopeType: "ahj" | "utility";
    profileKey: string;
    state: string;
    ahj: string;
    utility: string;
    portalPlatform: string;
    portalUrl: string;
    createdBy: string;
    nowIso: string;
    pathParamKeys?: { programId?: string; projectId?: string; formId?: string };
    notes?: string;
  }): NetworkRecipe {
    return {
      id: `net_${meta.profileKey.replace(/[^a-z0-9]+/gi, "_")}_${this.requests.length}`,
      scopeType: meta.scopeType,
      profileKey: meta.profileKey,
      state: meta.state,
      ahj: meta.ahj,
      utility: meta.utility,
      portalPlatform: meta.portalPlatform,
      portalUrl: meta.portalUrl,
      status: "complete",
      version: 1,
      pathParamKeys: meta.pathParamKeys,
      requests: this.requests.slice(),
      createdBy: meta.createdBy,
      createdAt: meta.nowIso,
      updatedAt: meta.nowIso,
      notes: meta.notes ?? "",
    };
  }
}

/** Extract PowerClerk-style per-project path params from a recording URL.
 *  e.g. .../PrintViewProject?ProgramId=JYE..&ProjectId=NPA..&FormId=6FJ..  */
export function extractPathParamKeys(url: string): { programId?: string; projectId?: string; formId?: string } {
  const get = (k: string): string | undefined => {
    const m = url.match(new RegExp(`[?&]${k}=([^&]+)`, "i"));
    return m ? decodeURIComponent(m[1]) : undefined;
  };
  const out: { programId?: string; projectId?: string; formId?: string } = {};
  const programId = get("ProgramId");
  const projectId = get("ProjectId");
  const formId = get("FormId");
  if (programId) out.programId = programId;
  if (projectId) out.projectId = projectId;
  if (formId) out.formId = formId;
  return out;
}
