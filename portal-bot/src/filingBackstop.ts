// THE NETWORK BACKSTOP (hard rule 1): a click or key the bot makes WITHOUT a named human
// approval may never be the one that files, submits or pays.
//
// Every gate before this one reads WORDS — a control's label, a dialog's text, a form's buttons —
// and a word list loses to the next wording (the close-mustfix checker filed through four dialog
// shapes and three Enter shapes that each gate's list did not know). This layer does not care
// which control fired or what it said. It watches the requests themselves, for the whole of a
// learn or replay run, and aborts:
//
//   1. FILING-URL RULE: any top-level (main-frame) NAVIGATION whose method is not GET/HEAD/OPTIONS
//      and whose URL — for a form POST, the form's action — reads as a filing or a fee payment
//      (isFilingOrPaymentRequest, the same predicate the demo recorder's abort asks). A named
//      approval opens a short window for a filing URL around THE approved final-submit click
//      only; a payment URL is never allowed.
//   2. WINDOW RULE (the invariant part): ANY request that is not GET/HEAD/OPTIONS — any URL, any
//      frame, XHR and fetch included — fired while a bot action with no legitimate reason to
//      change server state is in flight: an overlay DISMISSER click, and a bot Enter press on a
//      page classified review/terminal. The window opens before the action and closes a short
//      grace after it, BEFORE the caller's next action (so a following recipe click's ASP.NET
//      postback is never caught in it).
//
// Every abort is recorded (origin + path only — never a query string, which can carry a
// customer's data) so the run reports it; a filing-URL abort also stops a replay, named.
//
// Installed at the CONTEXT level when the page has one, so a filing that opens in a popup is
// covered too, and handed on with route.fallback() — never continue() — so a smoke's own
// context.route fixture server still answers what this layer lets through.
//
// Known cost: Playwright disables the browser's HTTP cache while any route is installed.
import { isFilingOrPaymentRequest, isPayRequestUrl } from "../../shared/src/portalSafety";

export type BackstopRule = "filing-url" | "dismisser-window" | "enter-window";

export interface BackstopAbort {
  rule: BackstopRule;
  method: string;
  /** origin + pathname only. */
  where: string;
  /** What was in flight (the window's reason), or the filing-URL rule's reason. */
  why: string;
  resourceType: string;
}

export interface FilingBackstop {
  readonly aborts: BackstopAbort[];
  /** Open a window in which every state-changing request is aborted. Returns its closer. */
  openWindow(rule: Exclude<BackstopRule, "filing-url">, why: string): () => void;
  /** THE approved final submit only: let a FILING url through for `ms`. Payment never. */
  allowApprovedFiling(ms: number): void;
  dispose(): Promise<void>;
}

const REGISTRY = new WeakMap<object, FilingBackstop>();

/** The backstop installed on this page's run, or null (a page no run owns: human capture). */
export function backstopFor(page: unknown): FilingBackstop | null {
  if (!page || typeof page !== "object") return null;
  const own = REGISTRY.get(page as object);
  if (own) return own;
  // A TAB THE RUN ADOPTED (a popup the learner switches this.page to) shares the context the
  // backstop was installed on — its windows must still open, or the window rule is silently off.
  try {
    const ctx = typeof (page as { context?: unknown }).context === "function" ? (page as { context: () => unknown }).context() : null;
    return ctx && typeof ctx === "object" ? REGISTRY.get(ctx as object) ?? null : null;
  } catch { return null; }
}

const whereOf = (url: string): string => {
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return String(url || "").split(/[?#]/)[0].slice(0, 200); }
};

/** Run `fn` inside a window on this page's backstop (if one is installed), closing it `graceMs`
 *  after `fn` settles — before the caller's next action. */
export async function withBackstopWindow<T>(page: unknown, rule: Exclude<BackstopRule, "filing-url">, why: string, fn: () => Promise<T>, graceMs = 600): Promise<T> {
  const bs = backstopFor(page);
  if (!bs) return fn();
  const close = bs.openWindow(rule, why);
  try {
    return await fn();
  } finally {
    await new Promise((r) => setTimeout(r, graceMs));
    close();
  }
}

/** Install the backstop for one learn/replay run. null when the page cannot route (a unit-test
 *  double) — the word gates still run; nothing claims a backstop that is not there. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function installFilingBackstop(page: any, label = "run"): Promise<FilingBackstop | null> {
  if (!page || typeof page !== "object") return null;
  const existing = REGISTRY.get(page);
  if (existing) return existing;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ctx: any = null;
  try { ctx = typeof page.context === "function" ? page.context() : null; } catch { ctx = null; }
  const target = ctx && typeof ctx.route === "function" && typeof ctx.unroute === "function" ? ctx
    : typeof page.route === "function" && typeof page.unroute === "function" ? page : null;
  if (!target) return null;

  const aborts: BackstopAbort[] = [];
  const windows = new Map<number, { rule: Exclude<BackstopRule, "filing-url">; why: string }>();
  let nextWindow = 1;
  let approvedFilingUntil = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = async (route: any, request: any): Promise<void> => {
    let method = "";
    let url = "";
    try { method = String(request.method() || "").toUpperCase(); url = String(request.url() || ""); } catch { /* unreadable: fall through as not-GET */ }
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") { await route.fallback().catch(() => null); return; }
    let resourceType = "";
    try { resourceType = String(request.resourceType() || ""); } catch { /* keep "" */ }
    // 2. WINDOW RULE: any state-changing request while a dismisser click / terminal Enter is in flight.
    const open = [...windows.values()];
    if (open.length) {
      const w = open[open.length - 1];
      aborts.push({ rule: w.rule, method: method || "?", where: whereOf(url), why: w.why, resourceType });
      await route.abort("blockedbyclient").catch(() => null);
      return;
    }
    // 1. FILING-URL RULE: a top-level navigation that files or pays.
    let topLevelNavigation = false;
    try {
      const frame = request.frame();
      topLevelNavigation = !!request.isNavigationRequest() && !!frame && typeof frame.parentFrame === "function" && frame.parentFrame() === null;
    } catch { topLevelNavigation = resourceType === "document"; }
    if (topLevelNavigation && isFilingOrPaymentRequest(method || "POST", url)) {
      const pay = isPayRequestUrl(url);
      if (!pay && Date.now() < approvedFilingUntil) { await route.fallback().catch(() => null); return; }
      aborts.push({
        rule: "filing-url", method: method || "?", where: whereOf(url), resourceType,
        why: pay ? "a fee-payment endpoint — automation never pays" : `a filing endpoint, and no named approval covers this request (${label})`,
      });
      await route.abort("blockedbyclient").catch(() => null);
      return;
    }
    await route.fallback().catch(() => null);
  };

  await target.route("**/*", handler);
  const bs: FilingBackstop = {
    aborts,
    openWindow(rule, why) {
      const id = nextWindow++;
      windows.set(id, { rule, why: String(why || "").slice(0, 120) });
      return () => { windows.delete(id); };
    },
    allowApprovedFiling(ms: number) {
      approvedFilingUntil = Math.max(approvedFilingUntil, Date.now() + Math.max(0, Math.min(ms, 60_000)));
    },
    async dispose() {
      if (REGISTRY.get(page) === bs) REGISTRY.delete(page);
      if (target !== page && REGISTRY.get(target) === bs) REGISTRY.delete(target);
      windows.clear();
      await target.unroute("**/*", handler).catch(() => null);
    },
  };
  REGISTRY.set(page, bs);
  if (target !== page) REGISTRY.set(target, bs);
  return bs;
}

/** One line per abort, for a run's warnings. */
export function describeBackstopAbort(a: BackstopAbort): string {
  return `BACKSTOP ABORTED ${a.method} ${a.where} (${a.resourceType || "request"}): ${a.rule === "filing-url" ? a.why : `fired while ${a.rule === "dismisser-window" ? "an overlay dismisser click" : "a bot Enter on a review/terminal page"} was in flight (${a.why})`}`;
}
