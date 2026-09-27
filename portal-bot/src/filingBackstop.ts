// THE NETWORK BACKSTOP (hard rule 1): a click or key the bot makes WITHOUT a named human
// approval may never be the one that files, submits or pays.
//
// Every gate before this one reads WORDS — a control's label, a dialog's text, a form's buttons —
// and a word list loses to the next wording (the close-mustfix checker filed through four dialog
// shapes and three Enter shapes that each gate's list did not know). This layer does not care
// which control fired or what it said. It watches the requests themselves, for the whole of a
// learn or replay run — EVERY request that is not GET/HEAD/OPTIONS, from EVERY frame (the main
// frame, an iframe, a popup the context owns) and of EVERY resource type (a document navigation,
// a form posted into an iframe, XHR, fetch, a beacon) — and aborts:
//
//   1. PAYMENT RULE: a request whose URL reads as a fee payment (isPayRequestUrl). Always, in any
//      frame, of any type, even under a named approval: automation never pays.
//   2. FILING-URL RULE: a request whose URL — for a form POST, the form's action — reads as a
//      filing (isFilingOrPaymentRequest, the same predicate the demo recorder's abort asks). A
//      named approval admits ONE state-changing request in a short window after THE approved
//      final-submit click (each approved click — the submit, its confirm dialog's OK — one).
//      (close2-safety checker: this rule once held for main-frame navigations only, and an
//      iframe's "Continue", a form targeted at an iframe and a fetch POST each reached the server
//      — iframePay, iframeSubmit, targetFramePay, xhrFile, xhrPay.) KNOWN COST, fail-closed: a
//      legitimate mid-flow XHR whose URL happens to contain "submit" or "invoice" is aborted too,
//      and the run stops NAMED — never silently.
//   3. WINDOW RULE (the invariant part): ANY state-changing request fired while a bot action with
//      no legitimate reason to change server state is in flight: an overlay DISMISSER click, and a
//      bot Enter press on a page classified review/terminal. The window opens before the action
//      and closes a short grace after it, BEFORE the caller's next action (so a following recipe
//      click's ASP.NET postback is never caught in it).
//   4. REVIEW-PAGE LOCKDOWN: at review nothing legitimate needs to post, so EVERY state-changing
//      request is aborted (a) once the run has locked the page (replay's stopForReview step, the
//      learner's atReview), and (b) whenever the page the request comes from is classified
//      terminal by the SHARED in-page predicate (terminalPageInPage — the same one replay's click
//      gate asks), read at the moment of the request (a navigation request — a form POST — by
//      the page's reading at its last load, since a navigating page cannot be asked), so a page
//      script that posts a second after the review page loads is caught however fast the run
//      is. Lifted only by the approved
//      final submit's window (non-payment URLs) and by dispose() — the hand-off to a person.
//
// Every abort is recorded (origin + path only — never a query string, which can carry a
// customer's data) so the run reports it; a filing, payment or lockdown abort also stops the run,
// named (replay: backstopStop; learner: at the next page boundary and in its result).
//
// Installed at the CONTEXT level when the page has one, so a filing that opens in a popup is
// covered too, and handed on with route.fallback() — never continue() — so a smoke's own
// context.route fixture server still answers what this layer lets through.
//
// Known cost: Playwright disables the browser's HTTP cache while any route is installed.
import { isFilingOrPaymentRequest, isPaymentWordedText, isPayRequestUrl, PORTAL_SAFETY_GLOBAL, PORTAL_SAFETY_IN_PAGE_SOURCE } from "../../shared/src/portalSafety";

export type BackstopRule = "filing-url" | "dismisser-window" | "enter-window" | "review-lockdown";

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
  openWindow(rule: "dismisser-window" | "enter-window", why: string): () => void;
  /** THE approved final submit only: open ONE slot, bound to the clicked page, that lets ONE
   *  state-changing request through — a FILING url, and past the review lockdown — within `ms`.
   *  Payment never. The slot closes when that request goes, when the clicked page's main frame
   *  starts a navigation of its own (a GET: the click's own request was not state-changing, so
   *  there is nothing to admit) or loads a new document, or when `ms` runs out. Every later
   *  state-changing request (a page script's second POST, the completion page's on-load POST)
   *  meets the ordinary rules. While the slot is open a native confirm()/alert/beforeunload on the
   *  clicked page whose text speaks of no payment is ACCEPTED; a prompt, or a payment-worded
   *  dialog, is dismissed and recorded. Outside a slot there is no dialog handler at all
   *  (Playwright dismisses every dialog, as before). */
  allowApprovedFiling(ms: number, opts?: { page?: unknown }): void;
  /** Is an approved slot open and unused right now? */
  approvedSlotOpen(): boolean;
  /** Close the approved slot now (the filing request has gone, or a caller is done with it). */
  closeApprovedSlot(): void;
  /** Where (origin + path) each request the approved window admitted went, in order. */
  readonly approvedRequests: string[];
  /** Each admitted request: was it a NAVIGATION of the clicked page (a form submission — the
   *  click's own request) or another state-changing request fired inside the approved window? */
  readonly approvedAdmissions: Array<{ where: string; navigation: boolean }>;
  /** The clicked page navigated (a GET document request) while the slot was open: a request DID
   *  reach the server even though nothing state-changing was admitted. origin + path. */
  readonly approvedNavigations: string[];
  /** Every native dialog seen while a slot's dialog handler was installed, and what was done. */
  readonly approvedDialogs: Array<{ type: string; message: string; action: "accepted" | "dismissed"; why: string }>;
  /** The run is at review: abort every state-changing request until dispose() hands the page to
   *  a person. Sticky. */
  lockReview(why: string): void;
  /** Aborts that stop the run: filing, payment, review lockdown. */
  stoppingAborts(): BackstopAbort[];
  dispose(): Promise<void>;
}

/** The rules whose abort stops the run by name (a window abort is reported, and the run goes on:
 *  nothing was sent, and the dismissal / Enter was not a step of the recipe). */
export const isStoppingAbort = (a: BackstopAbort): boolean => a.rule === "filing-url" || a.rule === "review-lockdown";

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
export async function withBackstopWindow<T>(page: unknown, rule: "dismisser-window" | "enter-window", why: string, fn: () => Promise<T>, graceMs = 600): Promise<T> {
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

/** How long the lockdown waits for the requesting page to answer "are you terminal?". A page
 *  blocked in a SYNCHRONOUS XHR cannot answer until this handler lets that XHR go — the timeout
 *  breaks that wait. Unknown then falls back to the sticky lock (and the filing/payment rules,
 *  which need no page read). */
const TERMINAL_READ_TIMEOUT_MS = 1500;

/** Read the shared terminal-page predicate in a page's main frame: true / false, or null when it
 *  cannot be read (a navigating or blocked page). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mainFrameIsTerminal(main: any): Promise<boolean | null> {
  if (!main || typeof main.evaluate !== "function") return null;
  const read = (async (): Promise<boolean | null> => {
    await main.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE).catch(() => null);
    const r = await main.evaluate((g: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ps = (globalThis as any)[g];
      if (!ps || typeof ps.terminalPageInPage !== "function") return null;
      const t = ps.terminalPageInPage();
      return typeof t.terminal === "boolean" ? t.terminal : null;
    }, PORTAL_SAFETY_GLOBAL).catch(() => null);
    return typeof r === "boolean" ? r : null;
  })();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((r) => { timer = setTimeout(() => r(null), TERMINAL_READ_TIMEOUT_MS); });
  try { return await Promise.race([read, timeout]); } finally { if (timer) clearTimeout(timer); }
}

/** The page a request came from (its frame's page), or null (a service-worker request). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pageOfRequest(request: any): any {
  try {
    const frame = request.frame();
    return frame && typeof frame.page === "function" ? frame.page() : null;
  } catch { return null; }
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
  const windows = new Map<number, { rule: "dismisser-window" | "enter-window"; why: string }>();
  let nextWindow = 1;
  // ONE REQUEST PER APPROVED CLICK. The window used to admit EVERY non-payment state-changing
  // request for 20 s, so a page script's second POST fired in the approved click's window reached
  // the server as if a person had approved it too (portal-run-close 8, approvedFinalSubmit smoke
  // 'extraPost'). A named approval covers the click's own request and nothing else. KNOWN COST,
  // fail-closed: a script POST that fires BEFORE the click's own request takes the slot and the
  // filing itself is aborted (named, nothing filed).
  //
  // THE SLOT IS BOUND TO THE CLICK (portal-run-close-2 M4). It was consumed by ANY first
  // state-changing request, so when the click's own request was NOT state-changing (a form
  // method=GET to the completion page; a button setting location.href) the completion page's
  // on-load fetch(POST …/track/completed) took the slot, reached the server, and was reported as
  // "the approved click's request" (skeptic getSubmit / jsNav). Now the slot admits a request
  // only from the CLICKED page (any of its frames), and closes as soon as that page's main frame
  // starts a GET navigation or loads a new document — the click's navigation is over, and
  // whatever the next document posts is not what the person approved. Deliberately NOT
  // framenavigated: Playwright fires it on pushState, and an SPA that pushes state and then
  // posts the filing would lose its slot (a new false stop on a legitimate filing).
  type Slot = { page: unknown; until: number; open: boolean; timer: ReturnType<typeof setTimeout> | null; detach: () => void };
  let slot: Slot | null = null;
  const approvedRequests: string[] = [];
  const approvedAdmissions: Array<{ where: string; navigation: boolean }> = [];
  const approvedNavigations: string[] = [];
  const approvedDialogs: Array<{ type: string; message: string; action: "accepted" | "dismissed"; why: string }> = [];
  const slotLive = (): boolean => !!slot && slot.open && Date.now() < slot.until;
  const closeSlot = (): void => {
    const s = slot;
    if (!s) return;
    s.open = false;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.detach();
  };
  let locked = "";
  let disposed = false;
  // A NAVIGATION REQUEST (a form POST) CANNOT BE ASKED LIVE: evaluating the page it is navigating
  // waits for that navigation, which waits for this handler — every Accela postback stalled the
  // full read timeout (measured: 9 postbacks x 1.5 s on the Accela replica). So each page's
  // classification is also read on every load and on every live read, and a navigation request
  // is judged by the page's last reading. A server-rendered page's review text is there at load;
  // an SPA's posts are fetch/XHR, which are read live.
  const lastReading = new WeakMap<object, boolean>();
  const unwatch: Array<() => void> = [];
  const watched = new WeakSet<object>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refresh = (pg: any): void => {
    if (disposed || !pg || typeof pg.mainFrame !== "function") return;
    void mainFrameIsTerminal(pg.mainFrame()).then((v) => { if (typeof v === "boolean") lastReading.set(pg, v); }).catch(() => null);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const watch = (pg: any): void => {
    if (!pg || typeof pg !== "object" || watched.has(pg) || typeof pg.on !== "function") return;
    watched.add(pg);
    const onLoad = (): void => refresh(pg);
    pg.on("domcontentloaded", onLoad);
    pg.on("load", onLoad);
    unwatch.push(() => { try { pg.off("domcontentloaded", onLoad); pg.off("load", onLoad); } catch { /* page gone */ } });
    refresh(pg);
  };
  try {
    if (ctx && typeof ctx.pages === "function" && typeof ctx.on === "function") {
      for (const p of ctx.pages()) watch(p);
      const onPage = (p: unknown): void => watch(p);
      ctx.on("page", onPage);
      unwatch.push(() => { try { ctx.off("page", onPage); } catch { /* context gone */ } });
    } else watch(page);
  } catch { /* no events (a double): live reads only */ }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = async (route: any, request: any): Promise<void> => {
    let method = "";
    let url = "";
    try { method = String(request.method() || "").toUpperCase(); url = String(request.url() || ""); } catch { /* unreadable: fall through as not-GET */ }
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      // The clicked page's main frame navigating by GET ends the approved click's slot: its own
      // request was that navigation (nothing state-changing to admit), and the next document's
      // posts are not the click's. The navigation itself reached the server — recorded.
      if (method === "GET" && slotLive()) {
        try {
          const pg = pageOfRequest(request);
          if (request.isNavigationRequest() && pg && pg === slot!.page && request.frame() === pg.mainFrame()) {
            approvedNavigations.push(whereOf(url));
            closeSlot();
          }
        } catch { /* unreadable: the slot keeps its other closers */ }
      }
      await route.fallback().catch(() => null);
      return;
    }
    let resourceType = "";
    try { resourceType = String(request.resourceType() || ""); } catch { /* keep "" */ }
    const abort = async (rule: BackstopRule, why: string): Promise<void> => {
      aborts.push({ rule, method: method || "?", where: whereOf(url), why, resourceType });
      await route.abort("blockedbyclient").catch(() => null);
    };
    // 1. PAYMENT: never, in any frame, any type, whatever was approved.
    if (isPayRequestUrl(url)) { await abort("filing-url", "a fee-payment endpoint — automation never pays"); return; }
    // The approved click's ONE request takes the slot (checked after the payment rule: a payment
    // never uses it) — and only a request from the clicked page.
    let approved = false;
    if (slotLive()) {
      const pg = pageOfRequest(request);
      if (!slot!.page || pg === slot!.page) {
        let navigation = false;
        try { navigation = !!request.isNavigationRequest(); } catch { /* unknown: not a navigation */ }
        approved = true;
        approvedRequests.push(whereOf(url));
        approvedAdmissions.push({ where: whereOf(url), navigation });
        closeSlot();
      }
    }
    // 2. FILING URL: only inside THE approved final submit's window.
    if (isFilingOrPaymentRequest(method || "POST", url) && !approved) {
      await abort("filing-url", `a filing endpoint, and no named approval covers this request (${label})`);
      return;
    }
    // 3. WINDOW RULE: any state-changing request while a dismisser click / terminal Enter is in flight.
    const open = [...windows.values()];
    if (open.length) {
      const w = open[open.length - 1];
      await abort(w.rule, w.why);
      return;
    }
    // 4. REVIEW-PAGE LOCKDOWN: the run locked it, or the requesting page reads as terminal now.
    if (!approved) {
      if (locked) { await abort("review-lockdown", locked); return; }
      const pg = pageOfRequest(request);
      let navigation = true;
      try { navigation = !!request.isNavigationRequest(); } catch { /* unknown: treat as navigation (no live read) */ }
      let terminal: boolean | null = null;
      if (navigation) terminal = pg ? lastReading.get(pg) ?? null : null;
      else if (pg) {
        terminal = await mainFrameIsTerminal(pg.mainFrame());
        if (typeof terminal === "boolean") lastReading.set(pg, terminal);
      }
      if (terminal === true && !disposed) {
        await abort("review-lockdown", `the page this request came from is the review/terminal page (${label})`);
        return;
      }
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
    approvedRequests,
    approvedAdmissions,
    approvedNavigations,
    approvedDialogs,
    allowApprovedFiling(ms: number, opts?: { page?: unknown }) {
      // Reset, never added: each approved click (the submit, a confirm dialog's OK) covers one.
      closeSlot();
      if (disposed) return;
      const clicked = opts && opts.page && typeof opts.page === "object" ? opts.page : null;
      const span = Math.max(0, Math.min(ms, 60_000));
      const detachers: Array<() => void> = [];
      const s: Slot = { page: clicked, until: Date.now() + span, open: true, timer: null, detach: () => { for (const d of detachers.splice(0)) d(); } };
      slot = s;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pg: any = clicked;
      if (pg && typeof pg.on === "function" && typeof pg.off === "function") {
        // A NEW DOCUMENT on the clicked page ends the click's slot (the belt to the GET-navigation
        // braces above: a navigation the route never saw, e.g. a bfcache restore).
        const onLoad = (): void => { if (slot === s) closeSlot(); };
        pg.on("domcontentloaded", onLoad);
        detachers.push(() => { try { pg.off("domcontentloaded", onLoad); } catch { /* page gone */ } });
        // NATIVE DIALOGS DURING THE APPROVED CLICK (portal-run-close-2 M3). With no listener,
        // Playwright DISMISSES every dialog: a Submit whose onclick is `return confirm('File this
        // application now?')` cancelled its own form and the approved run never filed (skeptic
        // confirmNative). While a listener is registered Playwright no longer auto-answers, so
        // this handler answers EVERY dialog it sees: accept a confirm / alert / beforeunload whose
        // text speaks of no payment, while the slot is open and unused; dismiss a prompt (it asks
        // for input nobody approved) and any payment-worded dialog (automation never pays) — the
        // adapter reads approvedDialogs and pauses fee_payment.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const onDialog = async (dialog: any): Promise<void> => {
          let type = "";
          let message = "";
          try { type = String(dialog.type() || ""); message = String(dialog.message() || ""); } catch { /* unreadable: dismissed below */ }
          let why = "";
          if (type === "prompt") why = "a prompt asks for input nobody approved";
          else if (isPaymentWordedText(message)) why = "it speaks of a payment — automation never pays";
          else if (!(slot === s && slotLive())) why = "outside the approved click's slot";
          else if (!/^(confirm|alert|beforeunload)$/.test(type)) why = `an unknown dialog type "${type}"`;
          const accept = !why;
          approvedDialogs.push({ type, message: message.slice(0, 200), action: accept ? "accepted" : "dismissed", why: accept ? "the approved click's own confirmation" : why });
          try { if (accept) await dialog.accept(); else await dialog.dismiss(); } catch { /* already answered / page gone */ }
        };
        pg.on("dialog", onDialog);
        detachers.push(() => { try { pg.off("dialog", onDialog); } catch { /* page gone */ } });
      }
      s.timer = setTimeout(() => { if (slot === s) closeSlot(); }, span);
    },
    approvedSlotOpen() { return slotLive(); },
    closeApprovedSlot() { closeSlot(); },
    lockReview(why: string) {
      if (!locked) locked = `the run is at review (${String(why || label).slice(0, 100)}) — nothing legitimate posts from here until a person takes the page`;
    },
    stoppingAborts() { return aborts.filter(isStoppingAbort); },
    async dispose() {
      disposed = true;
      closeSlot();
      if (REGISTRY.get(page) === bs) REGISTRY.delete(page);
      if (target !== page && REGISTRY.get(target) === bs) REGISTRY.delete(target);
      windows.clear();
      locked = "";
      for (const u of unwatch.splice(0)) u();
      await target.unroute("**/*", handler).catch(() => null);
    },
  };
  REGISTRY.set(page, bs);
  if (target !== page) REGISTRY.set(target, bs);
  return bs;
}

/** One line per abort, for a run's warnings. */
export function describeBackstopAbort(a: BackstopAbort): string {
  const what = a.rule === "filing-url" ? a.why
    : a.rule === "review-lockdown" ? `REVIEW-PAGE LOCKDOWN — ${a.why}`
      : `fired while ${a.rule === "dismisser-window" ? "an overlay dismisser click" : "a bot Enter on a review/terminal page"} was in flight (${a.why})`;
  return `BACKSTOP ABORTED ${a.method} ${a.where} (${a.resourceType || "request"}): ${what}`;
}
