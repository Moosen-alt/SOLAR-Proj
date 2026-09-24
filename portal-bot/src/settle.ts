// WAIT FOR THE PAGE TO SETTLE — BY WHAT THE PAGE IS DOING, NOT BY A LOAD EVENT.
//
// An ASP.NET UpdatePanel postback (Accela, most county portals) never fires a load event: it is
// an XHR that Sys.WebForms.PageRequestManager brackets with beginRequest / endRequest and then
// replaces a region of the DOM. waitForLoadState() returns immediately through it, and
// "networkidle" — used ~100 times in this bot, and discouraged by Playwright itself — is a
// guess about quiet that a long-poll never gives and a 0ms setTimeout slips through.
//
// So this module answers "is the page still working?" from inside the page:
//   - PageRequestManager begin/endRequest (hooked lazily — Sys arrives after our init script,
//     and there is no instance at all when partial rendering is off; every touch is guarded)
//     plus get_isInAsyncPostBack() at each read;
//   - a "postback began" flag set by __doPostBack and form submission, so a postback whose
//     PRM hook is not installed yet (or a full-page postback) still reads as busy;
//   - an in-flight fetch / XHR counter (requests older than maxRequestAgeMs — long-polls,
//     heartbeats — stop counting, or they would never let a page settle);
//   - a DOM-mutation quiet window.
// The quiet window is measured from the START of the wait as well as from the last activity:
// an autopostback control commonly defers its postback with setTimeout(…, 0), so right after a
// commit NOTHING is in flight yet. Requiring quietMs of stillness after the commit is what
// catches that gap.
//
// OVERLAPPING POSTBACKS ARE LAST-WINS: PageRequestManager aborts the in-flight request when a
// new one starts, and the first control's cascade is lost. Fill autopostback fields ONE AT A
// TIME and settle between them — commitField() does exactly that for one field.
//
// locator.fill() fires `input` only — no `change`, no blur — so a portal that saves or cascades
// on change never hears the value. commitField() blurs (Tab as the fallback), which fires the
// change, and then waits for whatever that started.
import type { Locator, Page } from "playwright";

/** Everything the page-side probe does. A plain string (not a serialized function) so it needs
 *  no __name shim and survives any bundler. Idempotent: a second install is a no-op. */
export const SETTLE_PROBE_SOURCE = String.raw`(function () {
  var g = globalThis;
  if (g.__settleProbe) return;
  var now = function () { return (g.performance && performance.now) ? performance.now() : Date.now(); };
  var st = {
    doc: String(Math.random()).slice(2), prmInFlight: 0, postbackAt: -1, lastActivity: now(), net: new Map(), seq: 0,
    saw: { prm: 0, postback: 0, net: 0, mutation: 0 },
    hooked: { prm: false, doPostBack: false }
  };
  var touch = function (kind) { st.lastActivity = now(); if (kind) st.saw[kind]++; };

  // --- PageRequestManager (guarded: Sys may never exist; getInstance may throw or be null) ---
  var hookPrm = function () {
    try {
      if (typeof Sys === "undefined" || !Sys.WebForms || !Sys.WebForms.PageRequestManager) return;
      var prm = Sys.WebForms.PageRequestManager.getInstance();
      if (!prm || prm.__settleHooked) { if (prm) st.hooked.prm = true; return; }
      prm.__settleHooked = true;
      st.hooked.prm = true;
      prm.add_beginRequest(function () { st.prmInFlight++; st.postbackAt = -1; touch("prm"); });
      prm.add_endRequest(function () { st.prmInFlight = Math.max(0, st.prmInFlight - 1); touch("prm"); });
    } catch (e) { /* a portal's own Sys object that is not ASP.NET AJAX */ }
  };
  var prmBusy = function () {
    try {
      if (typeof Sys === "undefined" || !Sys.WebForms || !Sys.WebForms.PageRequestManager) return st.prmInFlight > 0;
      var prm = Sys.WebForms.PageRequestManager.getInstance();
      return st.prmInFlight > 0 || !!(prm && typeof prm.get_isInAsyncPostBack === "function" && prm.get_isInAsyncPostBack());
    } catch (e) { return st.prmInFlight > 0; }
  };

  // --- "postback began": __doPostBack and form submission ---
  var markPostback = function () { st.postbackAt = now(); touch("postback"); };
  var wrapDoPostBack = function () {
    try {
      var f = g.__doPostBack;
      if (typeof f !== "function" || f.__settleWrapped) return;
      var wrapped = function () { markPostback(); return f.apply(this, arguments); };
      wrapped.__settleWrapped = true;
      g.__doPostBack = wrapped;
      st.hooked.doPostBack = true;
    } catch (e) { /* non-writable on this page */ }
  };
  try {
    var origSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () { markPostback(); return origSubmit.apply(this, arguments); };
  } catch (e) { /* locked prototype */ }
  try { document.addEventListener("submit", function () { markPostback(); }, true); } catch (e) {}

  // --- in-flight fetch / XHR ---
  var netStart = function () { var id = ++st.seq; st.net.set(id, now()); touch("net"); return id; };
  var netEnd = function (id) { if (st.net.delete(id)) touch("net"); };
  try {
    var origFetch = g.fetch;
    if (typeof origFetch === "function") {
      g.fetch = function () {
        var id = netStart();
        try {
          var p = origFetch.apply(this, arguments);
          return p.then(function (r) { netEnd(id); return r; }, function (e) { netEnd(id); throw e; });
        } catch (e) { netEnd(id); throw e; }
      };
    }
  } catch (e) {}
  try {
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      var id = netStart();
      try { this.addEventListener("loadend", function () { netEnd(id); }); } catch (e) {}
      try { return origSend.apply(this, arguments); } catch (e) { netEnd(id); throw e; }
    };
  } catch (e) {}

  // --- DOM mutations (structure, text, and the attributes that gate a control) ---
  var observe = function () {
    try {
      new MutationObserver(function () { touch("mutation"); }).observe(document, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ["disabled", "hidden", "readonly", "aria-busy", "aria-disabled"]
      });
    } catch (e) {}
  };
  observe();

  // Sys and __doPostBack arrive with the page's own scripts, after this runs — and a
  // PageRequestManager re-assigns __doPostBack when it initialises. Re-check cheaply.
  var poll = function () { hookPrm(); wrapDoPostBack(); };
  poll();
  try { document.addEventListener("DOMContentLoaded", poll); g.addEventListener("load", poll); } catch (e) {}
  setInterval(poll, 150);

  g.__settleProbe = {
    /** Start a wait: reset the "seen" tallies and return the page clock. */
    begin: function () { st.saw = { prm: 0, postback: 0, net: 0, mutation: 0 }; poll(); return now(); },
    snapshot: function (maxRequestAgeMs, postbackGraceMs) {
      poll();
      var t = now();
      var net = 0;
      st.net.forEach(function (started) { if (t - started < maxRequestAgeMs) net++; });
      var pending = st.postbackAt >= 0 && t - st.postbackAt < postbackGraceMs;
      var busy = [];
      if (prmBusy()) busy.push("async postback in flight");
      if (pending) busy.push("postback began");
      if (net > 0) busy.push(net + " request(s) in flight");
      return { doc: st.doc, now: t, busy: busy, lastActivity: st.lastActivity, saw: st.saw, hooked: st.hooked };
    }
  };
})();`;

const installed = new WeakSet<object>();

/** Install the probe on this page: for every future document (init script, once per page) and
 *  for the one already loaded. Never throws. */
export async function installSettleProbe(page: Page): Promise<void> {
  if (!page) return;
  if (!installed.has(page)) {
    installed.add(page);
    await page.addInitScript({ content: SETTLE_PROBE_SOURCE }).catch(() => null);
  }
  await page.evaluate(SETTLE_PROBE_SOURCE).catch(() => null);
}

export interface SettleOptions {
  /** Give up after this long. Default 10000. */
  timeoutMs?: number;
  /** Required stillness — no postback, no request, no mutation — measured from the later of
   *  the wait's start and the last activity. Default 300 (> a setTimeout-0 deferral). */
  quietMs?: number;
  /** Poll interval. Default 50. */
  pollMs?: number;
  /** A request older than this stops counting (long-poll, heartbeat). Default 5000. */
  maxRequestAgeMs?: number;
  /** How long a "postback began" mark keeps the page busy without a PRM beginRequest (a full
   *  page postback navigates within this). Default 2000. */
  postbackGraceMs?: number;
}

export interface SettleResult {
  settled: boolean;
  waitedMs: number;
  /** Why it returned: what was seen, or what was still busy at the timeout. */
  reason: string;
}

interface Snapshot {
  /** Per-document token: performance.now() restarts with every document, so a new token
   *  restarts the quiet clock. */
  doc: string;
  now: number;
  busy: string[];
  lastActivity: number;
  saw: { prm: number; postback: number; net: number; mutation: number };
  hooked: { prm: boolean; doPostBack: boolean };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the page has been still for quietMs: no async postback in flight (PageRequestManager),
 * no postback just begun, no young fetch/XHR, no DOM mutation. Returns {settled:false} on timeout
 * rather than throwing — the caller decides whether an unsettled page is fatal.
 */
export async function waitForSettled(page: Page, opts: SettleOptions = {}): Promise<SettleResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const quietMs = opts.quietMs ?? 300;
  const pollMs = opts.pollMs ?? 50;
  const maxRequestAgeMs = opts.maxRequestAgeMs ?? 5_000;
  const postbackGraceMs = opts.postbackGraceMs ?? 2_000;
  const started = Date.now();
  let pageStart: number | null = null;
  let last: Snapshot | null = null;
  let navigations = 0;
  let doc = "";

  while (Date.now() - started < timeoutMs) {
    let snap: Snapshot | null = null;
    try {
      snap = await page.evaluate(
        ([age, grace, fresh]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const p = (globalThis as any).__settleProbe;
          if (!p) return null;
          const s = p.snapshot(age, grace);
          if (fresh) s.pageStart = p.begin();
          return s;
        },
        [maxRequestAgeMs, postbackGraceMs, pageStart === null] as const,
      ) as (Snapshot & { pageStart?: number }) | null;
      if (snap === null) {
        // A document without the probe (navigated, or never installed): install and restart the clock.
        await page.evaluate(SETTLE_PROBE_SOURCE).catch(() => null);
        pageStart = null;
      } else if (pageStart === null || snap.doc !== doc) {
        // First read, or a NEW document (a full postback navigated): its clock starts over.
        if (pageStart !== null) navigations++;
        pageStart = (snap as Snapshot & { pageStart?: number }).pageStart ?? snap.now;
        doc = snap.doc;
      }
    } catch {
      // Evaluate throws while a navigation swaps the document: that is activity, not quiet.
      navigations++;
      pageStart = null;
    }
    if (snap && pageStart !== null) {
      last = snap;
      const quietSince = Math.max(pageStart, snap.lastActivity);
      if (snap.busy.length === 0 && snap.now - quietSince >= quietMs) {
        const seen = Object.entries(snap.saw).filter(([, n]) => n > 0).map(([k, n]) => `${k}×${n}`);
        return {
          settled: true,
          waitedMs: Date.now() - started,
          reason: `quiet ${quietMs}ms${seen.length ? ` after ${seen.join(", ")}` : " (nothing happened)"}` +
            `${navigations ? `, ${navigations} navigation read(s)` : ""}` +
            `${snap.hooked.prm ? "" : " [no PageRequestManager on this page]"}`,
        };
      }
    }
    await sleep(pollMs);
  }
  return {
    settled: false,
    waitedMs: Date.now() - started,
    reason: `timeout after ${timeoutMs}ms: ${last ? (last.busy.length ? last.busy.join("; ") : "DOM still changing") : "page never readable"}`,
  };
}

/**
 * Commit a filled field the way a person does — leave it — and wait for what that started.
 * Blur fires `change` (Playwright's fill() fires only `input`); Tab is the fallback for a control
 * that refuses a programmatic blur. Then waitForSettled. Never throws.
 */
export async function commitField(locator: Locator, opts: SettleOptions = {}): Promise<SettleResult> {
  const page = locator.page();
  await installSettleProbe(page);
  let committed = await locator.blur({ timeout: 2_000 }).then(() => true).catch(() => false);
  if (!committed) committed = await page.keyboard.press("Tab").then(() => true).catch(() => false);
  const res = await waitForSettled(page, opts);
  return committed ? res : { ...res, reason: `could not blur the field; ${res.reason}` };
}
