// THE ALLOW SIDE OF HARD RULE 1, IN A REAL BROWSER (portal-run-close item 8).
//
// Operator ruling 2026-09-26 ("click submit when submit is clicked"): automation may click the
// portal's final submit ONLY when a named person approved exactly THIS run, PORTAL_ALLOW_FINAL_SUBMIT
// is 1 on the process, and the recipe carries ONE terminal isFinalSubmit click after stopForReview.
// Every filingBackstop* / *EnterGuard smoke deletes the switch and proves REFUSAL only — a filter
// list fails both ways, so this one proves the click also HAPPENS when it should, end to end:
//
//   stageWithRecipe (index.ts runAdapter — the real stage path) -> RecipeAdapter.login (openPortal,
//   its own Chromium) -> fillApplication with the NETWORK BACKSTOP installed -> the flagged click ->
//   the completion page read -> capturedPermitNumber / capturedConfirmationNumber / capturedRecordLink.
//
// A local fixture portal on 127.0.0.1 (never a real one). Every non-GET request it receives is
// counted, so "0 POSTs" is what the SERVER saw, not what the run claims.
//
//   MUST-PASS     plain: approval for THIS run + env 1 -> EXACTLY ONE filing POST, finalSubmitClicked,
//                 the record number captured (under an "Application Received" heading), recordLink.
//   MUST-PASS     extraNav / extraSpa: a page script's SECOND state-changing request in the approved
//                 click's window (the completion page's on-load POST; an SPA's follow-up POST after
//                 the filing XHR) is ABORTED by the backstop — one filing POST, 0 extra — and the run
//                 still reports the filing (never "Nothing was sent").
//   MUST-EXCLUDE  (each its own run, each 0 POSTs): env unset; env "0"; approval for another run;
//                 approval naming no approver; the flagged step not last; two flagged steps; a CAPTCHA
//                 on the review page (-> pause mfa_captcha); the flagged submit is itself "Pay and
//                 Submit" (-> pause fee_payment).
//   MUST-EXCLUDE  feePage: the approved submit lands on a fee page -> pause fee_payment, 0 PAYMENT
//                 POSTs (the one filing POST is the approved click's).
//
//   portal-run-close-2:
//   MUST-PASS     confirmNative (a native confirm() on the Submit is ACCEPTED in the approved slot -> one
//                 POST); confirmModal (a DOM modal's OK files once); getSubmit / jsNav (a GET-navigating
//                 Submit: the record is captured from the GET completion page).
//   MUST-EXCLUDE  confirmPay ('Pay $150 and submit?' dismissed -> 0 POSTs, pause fee_payment,
//                 finalSubmitClicked false); unapprovedDialog (a confirm in an UNapproved run is dismissed);
//                 getSubmit / jsNav (the completion page's on-load POSTs never take the slot -> 0 POSTs);
//                 postFilingModal (C3: a modal after the filing is not clicked); rejected (C2: one POST,
//                 never a re-click); burned (C1: one {approver, runId} files at most once per process,
//                 and a refused one never files later).
//
//   autosubmit-close (auto-submit ON for 2026-09-29):
//   MUST-PASS     beaconFirst (same-origin sendBeacon in onsubmit, GA4 form_submit) / beaconCross (a
//                 cross-origin beacon) / keepaliveClick (fetch keepalive no-cors to an analytics host in
//                 the Submit's onclick) / beaconModal (a beacon, then a DOM confirm): the form's filing
//                 POST files EXACTLY ONCE, the record captured, finalSubmitRequestSent true.
//   MUST-EXCLUDE  the same four: a beacon never takes the approved slot (every admitted request is the
//                 filing), and none reaches a server (the review lock aborts it).
//
// Kill: mayClickFinalSubmit -> true (or finalSubmitRefusals -> []) turns the MUST-EXCLUDE env /
// approval / shape cases red. filingBackstop slotAdmits -> true turns section 9 red.
//
//   npx tsx portal-bot/src/adapters/approvedFinalSubmit.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { stageWithRecipe } from "../index";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// ---------------------------------------------------------------------------------------------
// The fixture portal. /m/<mode>/review is the review page; every non-GET request is recorded.
// ---------------------------------------------------------------------------------------------
const requests: Array<{ mode: string; method: string; path: string }> = [];
let analyticsBase = "";
const RECORD = "BLD-26-00123";
const NAV = `<nav><a href="/account">My Account</a> <a href="/logout">Sign Out</a></nav>`;
const page = (title: string, body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${NAV}${body}</body></html>`;
const COMPLETION = page("Application Received", `<h1>Application Received</h1>
  <p>Thank you. Your application has been submitted.</p><p>Record Number: ${RECORD}</p><p><a href="/records/${RECORD}">View your record</a></p>`);

const reviewBody = (mode: string): string => {
  const summary = `<h1>Step 5: Review and Submit</h1><p>Please review your application before submitting.</p>
    <dl><dt>Applicant</dt><dd>Desmond Yarrowby</dd><dt>Scope</dt><dd>7.2 kW roof-mounted PV</dd></dl>`;
  if (mode === "extraSpa") {
    // The filing is an XHR; after its response the page script fires a SECOND POST, then renders
    // the completion text in place.
    return `${summary}<div id="out"></div><button type="button" id="btnSubmit">Submit Application</button>
      <script>
        document.getElementById("btnSubmit").addEventListener("click", async () => {
          const r = await fetch("/m/extraSpa/apply/submit", { method: "POST", body: "a=1" });
          const html = await r.text();
          fetch("/m/extraSpa/apply/audit", { method: "POST", body: "after=1" }).catch(() => null);
          document.getElementById("out").innerHTML = html;
        });
      </script>`;
  }
  // portal-run-close-2 M4: the flagged Submit's own request is a GET (a form method=GET; a button
  // setting location.href). The completion page's script POSTs on load and again 800 ms later.
  if (mode === "getSubmit") {
    return `${summary}<form method="get" action="/m/getSubmit/apply/done"><input type="hidden" name="go" value="1"><button type="submit" id="btnSubmit">Submit Application</button></form>`;
  }
  if (mode === "jsNav") {
    return `${summary}<button type="button" id="btnSubmit" onclick="location.href='/m/jsNav/apply/done'">Submit Application</button>`;
  }
  // portal-run-close-2 M3: a NATIVE confirm() on the Submit (Playwright dismisses dialogs by default).
  if (mode === "confirmNative") {
    return `${summary}<form method="post" action="/m/confirmNative/apply/submit"><button type="submit" id="btnSubmit" onclick="return confirm('File this application now?')">Submit Application</button></form>`;
  }
  if (mode === "confirmPay") {
    return `${summary}<form method="post" action="/m/confirmPay/apply/submit"><button type="submit" id="btnSubmit" onclick="return confirm('Pay $150 and submit?')">Submit Application</button></form>`;
  }
  // A DOM confirm modal (role=dialog) whose OK posts the form — answered with its own approved slot.
  if (mode === "confirmModal") {
    return `${summary}<form id="f" method="post" action="/m/confirmModal/apply/submit"></form>
      <button type="button" id="btnSubmit">Submit Application</button>
      <div id="dlg" role="dialog" style="display:none;border:1px solid #000;padding:12px"><p>Are you sure you want to submit this application?</p><button type="button" id="dlgCancel">Cancel</button> <button type="button" id="dlgOk">OK</button></div>
      <script>
        document.getElementById("btnSubmit").addEventListener("click", function(){ document.getElementById("dlg").style.display = "block"; });
        document.getElementById("dlgCancel").addEventListener("click", function(){ document.getElementById("dlg").style.display = "none"; });
        document.getElementById("dlgOk").addEventListener("click", function(){ document.getElementById("f").submit(); });
      </script>`;
  }
  if (mode === "captcha") {
    return `${summary}<iframe title="reCAPTCHA" src="/recaptcha/api2/anchor?k=fixture" width="304" height="78"></iframe>
      <form method="post" action="/m/captcha/apply/submit"><button type="submit" id="btnSubmit">Submit Application</button></form>`;
  }
  if (mode === "payControl") {
    return `${summary}<form method="post" action="/m/payControl/apply/submit"><button type="submit" id="btnPay">Pay and Submit</button></form>`;
  }
  // autosubmit-close MF-B: TELEMETRY fired by the Submit BEFORE the form's own POST.
  if (mode === "beaconFirst") {
    // GA4 form_submit shape: a same-origin sendBeacon in onsubmit, then the form's POST navigation.
    return `${summary}<form method="post" action="/m/beaconFirst/apply/submit" onsubmit="navigator.sendBeacon('/m/beaconFirst/collect', 'en=form_submit')"><button type="submit" id="btnSubmit">Submit Application</button></form>`;
  }
  if (mode === "beaconCross") {
    return `${summary}<form method="post" action="/m/beaconCross/apply/submit" onsubmit="navigator.sendBeacon('${analyticsBase}/g/collect?en=form_submit', 'x')"><button type="submit" id="btnSubmit">Submit Application</button></form>`;
  }
  if (mode === "keepaliveClick") {
    return `${summary}<form method="post" action="/m/keepaliveClick/apply/submit"><button type="submit" id="btnSubmit" onclick="fetch('${analyticsBase}/g/collect?en=click', { method: 'POST', keepalive: true, mode: 'no-cors', body: 'x' })">Submit Application</button></form>`;
  }
  if (mode === "beaconModal") {
    // The Submit beacons, then opens a DOM confirm whose OK posts the form.
    return `${summary}<form id="f" method="post" action="/m/beaconModal/apply/submit"></form>
      <button type="button" id="btnSubmit">Submit Application</button>
      <div id="dlg" role="dialog" style="display:none;border:1px solid #000;padding:12px"><p>Are you sure you want to submit this application?</p><button type="button" id="dlgCancel">Cancel</button> <button type="button" id="dlgOk">OK</button></div>
      <script>
        document.getElementById("btnSubmit").addEventListener("click", function(){ navigator.sendBeacon("${analyticsBase}/g/collect?en=click", "x"); document.getElementById("dlg").style.display = "block"; });
        document.getElementById("dlgOk").addEventListener("click", function(){ document.getElementById("f").submit(); });
      </script>`;
  }
  return `${summary}<form method="post" action="/m/${mode}/apply/submit"><button type="submit" id="btnSubmit">Submit Application</button></form>`;
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean); // m, <mode>, ...
  const mode = parts[0] === "m" ? parts[1] || "plain" : "";
  const rest = parts.slice(2).join("/");
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    requests.push({ mode, method: String(req.method), path: url.pathname });
  }
  const send = (html: string): void => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); };
  if (url.pathname.startsWith("/recaptcha/")) { send("<!doctype html><html><body>captcha widget</body></html>"); return; }
  if (!mode) { send(page("Portal", "<h1>Home</h1>")); return; }
  if (rest === "apply/done") {
    // A completion page reached by GET; its script posts on load and 800 ms later (M4).
    send(COMPLETION.replace("</body>", `<script>fetch("/m/${mode}/track/completed", { method: "POST", body: "r=1" }).catch(function(){}); setTimeout(function(){ fetch("/m/${mode}/track/late", { method: "POST", body: "r=2" }).catch(function(){}); }, 800);</script></body>`));
    return;
  }
  if (rest === "details") {
    // A mid-flow page whose Save asks a native confirm() before it posts (an UNapproved dialog).
    send(page("Step 2: Details", `<h1>Step 2: Details</h1><label for="jv">Job value</label><input id="jv" type="text">
      <button type="button" id="btnSave" onclick="if (confirm('Save your progress?')) { fetch('/m/${mode}/draft/save', { method: 'POST', body: 's=1' }); document.body.setAttribute('data-saved', '1'); }">Save progress</button>`));
    return;
  }
  if (req.method === "POST" && rest === "apply/submit") {
    if (mode === "postFilingModal") {
      // C3: the completion page opens a survey modal whose Continue would POST.
      send(COMPLETION.replace("</body>", `<div role="dialog" style="border:1px solid #000;padding:12px"><p>Help us improve: take a short survey?</p><button type="button" id="svy" onclick="fetch('/m/postFilingModal/survey', { method: 'POST', body: 'v=1' })">Continue</button></div></body>`));
      return;
    }
    if (mode === "rejected") {
      // C2: the portal refuses the filing with a banner naming a page, and offers Submit again.
      send(page("Review and Submit", `<div class="alert"><p>Unable to submit: fix the errors below.</p><a href="/m/rejected/review">Page 3</a></div>
        <h1>Step 5: Review and Submit</h1><form method="post" action="/m/rejected/apply/submit"><button type="submit" id="btnSubmit2">Submit</button></form>`));
      return;
    }
    if (mode === "feePage") {
      send(page("Fees Due", `<h1>Fees Due</h1><p>Permit fee: $150.00</p>
        <form method="post" action="/m/feePage/payment/charge"><label for="cc">Card number</label>
        <input id="cc" name="cardnumber" autocomplete="cc-number"><button type="submit" id="payNow">Pay Now</button></form>`));
      return;
    }
    if (mode === "extraNav") {
      // The completion page's own script posts on load — inside the approved click's window.
      send(COMPLETION.replace("</body>", `<script>fetch("/m/extraNav/track/completed", { method: "POST", body: "r=1" }).catch(() => null);</script></body>`));
      return;
    }
    if (mode === "extraSpa") { send(`<p>Thank you. Your application has been submitted.</p><p>Record Number: ${RECORD}</p>`); return; }
    send(COMPLETION);
    return;
  }
  if (rest === "review" || rest === "") { send(page("Review and Submit", reviewBody(mode))); return; }
  send(page("Not found", "<h1>Not found</h1>"));
});
// A second, CROSS-ORIGIN "analytics" host (localhost vs 127.0.0.1): every non-GET it receives is
// recorded too, under mode "analytics".
const analytics = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") requests.push({ mode: "analytics", method: String(req.method), path: `analytics:${url.pathname}` });
  res.writeHead(204, { "access-control-allow-origin": "*" });
  res.end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
await new Promise<void>((r) => analytics.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
analyticsBase = `http://localhost:${(analytics.address() as { port: number }).port}`;

// ---------------------------------------------------------------------------------------------
// Recipes and the run
// ---------------------------------------------------------------------------------------------
const flagged = (css = "#btnSubmit", note = "final submit: Submit Application"): RecipeStep => ({ action: "click", selector: { css }, note, isFinalSubmit: true } as RecipeStep);
const recipeFor = (mode: string, steps?: RecipeStep[]): PortalRecipe => ({
  id: `approved-final-submit-${mode}`, scopeType: "ahj", profileKey: "or|fernhollow|", state: "OR", ahj: "City of Fernhollow", utility: "",
  portalPlatform: "fixture", portalUrl: `${base}/m/${mode}/review`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
  steps: steps ?? [
    { action: "goto", value: `${base}/m/${mode}/review`, note: "open the review page" } as RecipeStep,
    { action: "stopForReview" } as RecipeStep,
    flagged(),
  ],
} as PortalRecipe);

// ONE APPROVAL, ONE RUN (portal-run-close-2 C1): an approval burns at the bot layer when its run
// clicks or is refused, so every stage gets its own runId (and, by default, an approval of it).
let runSeq = 0;
interface Outcome { r: Record<string, unknown>; posts: Array<{ method: string; path: string }>; ms: number }
async function stage(mode: string, env: string | undefined, opts: { runApproval?: { approver: string; runId: string } | null; runId?: string }, steps?: RecipeStep[], lateMs = 300): Promise<Outcome> {
  // The switch is set on THIS process only, for this one run, and restored after.
  const prev = process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  if (env === undefined) delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; else process.env.PORTAL_ALLOW_FINAL_SUBMIT = env;
  const before = requests.length;
  const t0 = Date.now();
  try {
    const runId = opts.runId ?? `run-${mode}-${++runSeq}`;
    const r = await stageWithRecipe(recipeFor(mode, steps), { id: `p-${mode}` } as ProjectRecord, {}, {}, [], {
      autoSubmit: true, runApproval: opts.runApproval === undefined ? { approver: "A. Operator", runId } : opts.runApproval, runId, headless: true,
    });
    await new Promise((res) => setTimeout(res, lateMs)); // a late request is still counted
    return { r, posts: requests.slice(before).map(({ method, path }) => ({ method, path })), ms: Date.now() - t0 };
  } finally {
    if (prev === undefined) delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; else process.env.PORTAL_ALLOW_FINAL_SUBMIT = prev;
  }
}
const msgOf = (r: Record<string, unknown>): string => {
  const steps = Array.isArray(r.steps) ? (r.steps as Array<{ message?: unknown }>) : [];
  return [String(r.message ?? ""), ...steps.map((s) => String(s?.message ?? ""))].filter(Boolean).join(" | ");
};
const brief = (o: Outcome): string => `posts=${JSON.stringify(o.posts)} ok=${String(o.r.ok)} clicked=${String(o.r.finalSubmitClicked)} pause=${String(o.r.pauseReason)} permit=${String(o.r.capturedPermitNumber)} ms=${o.ms} msg=${msgOf(o.r).slice(0, 420)}`;
const filingPosts = (o: Outcome): number => o.posts.filter((p) => /\/apply\/submit$/.test(p.path)).length;

const only = String(process.env.APPROVED_SUBMIT_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
const want = (name: string): boolean => !only.length || only.includes(name);

// ---------------------------------------------------------------------------------------------
console.log("\n1. MUST-PASS: a named approval of THIS run + PORTAL_ALLOW_FINAL_SUBMIT=1 files, once");
if (want("plain")) {
  const o = await stage("plain", "1", {});
  check("plain: EXACTLY ONE filing POST reaches the portal, and nothing else", filingPosts(o) === 1 && o.posts.length === 1, brief(o));
  check("plain: finalSubmitClicked true", o.r.finalSubmitClicked === true, brief(o));
  check("plain: the run is ok (the portal confirmed the filing)", o.r.ok === true, brief(o));
  check(`plain: the record number (${RECORD}) is captured into permitNumber AND confirmationNumber — not the page heading`,
    o.r.capturedPermitNumber === RECORD && o.r.capturedConfirmationNumber === RECORD, brief(o));
  check("plain: recordLink set (the completion page, origin + path)", /^http:\/\/127\.0\.0\.1:\d+\/m\/plain\/apply\/submit$/.test(String(o.r.capturedRecordLink ?? "")), `recordLink=${String(o.r.capturedRecordLink)}`);
  check("plain: not paused", !o.r.pauseReason, brief(o));
}

console.log("\n2. MUST-PASS: the backstop still aborts every OTHER state-changing request in the approved click's window");
for (const mode of ["extraNav", "extraSpa"]) {
  if (!want(mode)) continue;
  const o = await stage(mode, "1", {});
  const extras = o.posts.filter((p) => !/\/apply\/submit$/.test(p.path));
  check(`${mode}: exactly one filing POST, and the page script's second POST never reaches the portal`, filingPosts(o) === 1 && extras.length === 0, brief(o));
  check(`${mode}: finalSubmitClicked true and the record number captured`, o.r.finalSubmitClicked === true && o.r.capturedPermitNumber === RECORD, brief(o));
  const m = msgOf(o.r);
  check(`${mode}: the run says the backstop aborted the other request — never "Nothing was sent" about a filing that went`,
    /aborted 1 other state-changing request/.test(m) && !/Nothing was sent/.test(m), m.slice(0, 500));
}

console.log("\n3. MUST-EXCLUDE: each condition missing on its own -> the portal receives NOTHING");
const excludes: Array<{ name: string; env: string | undefined; opts: { runApproval?: { approver: string; runId: string } | null; runId?: string }; steps?: () => RecipeStep[] }> = [
  { name: "env unset", env: undefined, opts: {} },
  { name: "env '0'", env: "0", opts: {} },
  { name: "approval for a different run", env: "1", opts: { runApproval: { approver: "A. Operator", runId: "run-approved-0" } } },
  { name: "approval naming no approver", env: "1", opts: { runId: "run-no-approver", runApproval: { approver: "  ", runId: "run-no-approver" } } },
  { name: "no approval at all", env: "1", opts: { runApproval: null } },
  { name: "the flagged step is not last", env: "1", opts: {}, steps: () => [
    { action: "goto", value: `${base}/m/plain/review`, note: "open the review page" } as RecipeStep,
    { action: "stopForReview" } as RecipeStep,
    flagged(),
    { action: "click", selector: { css: "a[href='/account']" }, note: "My Account" } as RecipeStep,
  ] },
  { name: "two flagged steps", env: "1", opts: {}, steps: () => [
    { action: "goto", value: `${base}/m/plain/review`, note: "open the review page" } as RecipeStep,
    { action: "stopForReview" } as RecipeStep,
    flagged(),
    flagged(),
  ] },
];
for (const c of excludes) {
  if (!want(c.name)) continue;
  const o = await stage("plain", c.env, c.opts, c.steps?.());
  check(`MUST-EXCLUDE ${c.name}: 0 POSTs reach the portal`, o.posts.length === 0, brief(o));
  check(`MUST-EXCLUDE ${c.name}: finalSubmitClicked false, no record number`, o.r.finalSubmitClicked === false && !o.r.capturedPermitNumber, brief(o));
}

console.log("\n4. MUST-EXCLUDE: what automation never does even under the approval — CAPTCHA, fees");
if (want("captcha")) {
  const o = await stage("captcha", "1", {});
  check("captcha on the review page: 0 POSTs", o.posts.length === 0, brief(o));
  check("captcha on the review page: PAUSED mfa_captcha, nothing clicked", o.r.pauseReason === "mfa_captcha" && o.r.finalSubmitClicked === false, brief(o));
}
if (want("payControl")) {
  const o = await stage("payControl", "1", {}, [
    { action: "goto", value: `${base}/m/payControl/review`, note: "open the review page" } as RecipeStep,
    { action: "stopForReview" } as RecipeStep,
    flagged("#btnPay", "final submit: Pay and Submit"),
  ]);
  check("the flagged submit is 'Pay and Submit': 0 POSTs", o.posts.length === 0, brief(o));
  check("the flagged submit is 'Pay and Submit': PAUSED fee_payment, nothing clicked", o.r.pauseReason === "fee_payment" && o.r.finalSubmitClicked === false, brief(o));
}
if (want("feePage")) {
  const o = await stage("feePage", "1", {});
  const payments = o.posts.filter((p) => /payment|charge/.test(p.path));
  check("fee page after the approved submit: 0 PAYMENT POSTs (the Pay Now form is never sent)", payments.length === 0, brief(o));
  check("fee page after the approved submit: the approved click's one filing POST, nothing else", filingPosts(o) === 1 && o.posts.length === 1, brief(o));
  check("fee page after the approved submit: PAUSED fee_payment (the click is reported, never 'accepted')", o.r.pauseReason === "fee_payment" && o.r.finalSubmitClicked === true && o.r.ok === false, brief(o));
}

console.log("\n5. portal-run-close-2 M3: a NATIVE dialog on the approved click — accepted when it is the click's own confirmation, never a payment");
if (want("confirmNative")) {
  const o = await stage("confirmNative", "1", {});
  check("MUST-PASS confirmNative: confirm('File this application now?') is accepted — EXACTLY ONE filing POST, nothing else", filingPosts(o) === 1 && o.posts.length === 1, brief(o));
  check("MUST-PASS confirmNative: finalSubmitClicked, a request reached the portal, the record captured, not paused",
    o.r.finalSubmitClicked === true && o.r.finalSubmitRequestSent === true && o.r.capturedPermitNumber === RECORD && !o.r.pauseReason && o.r.ok === true, brief(o));
}
if (want("confirmPay")) {
  const o = await stage("confirmPay", "1", {});
  check("MUST-EXCLUDE confirmPay: confirm('Pay $150 and submit?') is dismissed — 0 POSTs reach the portal", o.posts.length === 0, brief(o));
  check("MUST-EXCLUDE confirmPay: PAUSED fee_payment, finalSubmitClicked false, finalSubmitRequestSent false (nothing downstream records a filing)",
    o.r.pauseReason === "fee_payment" && o.r.finalSubmitClicked === false && o.r.finalSubmitRequestSent === false && o.r.ok === false, brief(o));
  check("MUST-EXCLUDE confirmPay: the run says nothing was filed", /NOTHING was filed/.test(msgOf(o.r)), msgOf(o.r).slice(0, 400));
}
if (want("unapprovedDialog")) {
  // No approval, no final submit: a mid-flow Save opens confirm('Save your progress?'). Outside an
  // approved slot there is no dialog handler — Playwright dismisses it, as before this round.
  const o = await stage("unapprovedDialog", undefined, { runApproval: null }, [
    { action: "goto", value: `${base}/m/unapprovedDialog/details`, note: "open the details page" } as RecipeStep,
    { action: "click", selector: { css: "#btnSave" }, note: "Save progress" } as RecipeStep,
    { action: "stopForReview" } as RecipeStep,
  ]);
  check("MUST-EXCLUDE unapprovedDialog: a native confirm during an UNapproved run is dismissed — 0 POSTs", o.posts.length === 0 && o.r.finalSubmitClicked === false, brief(o));
}
if (want("confirmModal")) {
  const o = await stage("confirmModal", "1", {});
  check("MUST-PASS confirmModal: a DOM confirm modal's OK files — EXACTLY ONE filing POST, the record captured", filingPosts(o) === 1 && o.posts.length === 1 && o.r.capturedPermitNumber === RECORD && o.r.finalSubmitClicked === true, brief(o));
}

console.log("\n6. portal-run-close-2 M4: the approved slot is bound to the click — a GET-navigating Submit admits no page-script POST");
for (const mode of ["getSubmit", "jsNav"]) {
  if (!want(mode)) continue;
  const o = await stage(mode, "1", {}, undefined, 2500);
  check(`MUST-EXCLUDE ${mode}: 0 state-changing requests reach the portal (the completion page's on-load and late POSTs are aborted)`, o.posts.length === 0, brief(o));
  check(`MUST-PASS ${mode}: the record number is captured from the GET completion page, clicked, a request (the navigation) reached the portal`,
    o.r.capturedPermitNumber === RECORD && o.r.finalSubmitClicked === true && o.r.finalSubmitRequestSent === true, brief(o));
  const m = msgOf(o.r);
  check(`${mode}: the run never calls a page-script POST "the approved click's request"`, !/approved click's request/.test(m) && /navigated the page by GET/.test(m), m.slice(0, 500));
}

console.log("\n7. portal-run-close-2 C3 / C2: after the filing request, no dialog is answered and nothing is re-clicked");
if (want("postFilingModal")) {
  const o = await stage("postFilingModal", "1", {});
  const m = msgOf(o.r);
  const warn = JSON.stringify(o.r.steps ?? "");
  check("C3 postFilingModal: exactly the one filing POST — the survey's Continue sends nothing", filingPosts(o) === 1 && o.posts.length === 1, brief(o));
  check("C3 postFilingModal: the survey dialog after the filing is NOT clicked (named), the filing still accepted",
    /NOT clicked: the approved click's request already reached the portal/.test(warn) && !/clicked Continue/.test(warn) && o.r.capturedPermitNumber === RECORD, m.slice(0, 400));
}
if (want("rejected")) {
  const o = await stage("rejected", "1", {});
  check("C2 rejected: the portal refused — ONE filing POST, never a second click of an unrecorded Submit", filingPosts(o) === 1 && o.posts.length === 1, brief(o));
  check("C2 rejected: the run stops for a person (not ok), the portal's words reported", o.r.ok === false && /REFUSED/.test(msgOf(o.r)), brief(o));
}

console.log("\n8. portal-run-close-2 C1: one approval, one filing attempt — at the bot layer too");
if (want("burned")) {
  const approval = { approver: "A. Operator", runId: "run-burn-1" };
  const first = await stage("plain", "1", { runId: "run-burn-1", runApproval: approval });
  check("burned: the first approved run files once", filingPosts(first) === 1 && first.r.finalSubmitClicked === true, brief(first));
  const again = await stage("plain", "1", { runId: "run-burn-1", runApproval: approval });
  check("MUST-EXCLUDE burned: the SAME {approver, runId} re-passed after it filed — 0 POSTs, not clicked, named",
    again.posts.length === 0 && again.r.finalSubmitClicked === false && /already used in this process/.test(msgOf(again.r) + JSON.stringify(again.r.steps ?? "")), brief(again));
  const refusedApproval = { approver: "A. Operator", runId: "run-burn-2" };
  const refused = await stage("plain", undefined, { runId: "run-burn-2", runApproval: refusedApproval });
  const after = await stage("plain", "1", { runId: "run-burn-2", runApproval: refusedApproval });
  check("MUST-EXCLUDE burned: an approval refused once (env unset) does not file when re-passed with env 1 — 0 POSTs",
    refused.posts.length === 0 && after.posts.length === 0 && after.r.finalSubmitClicked === false, `${brief(refused)} || ${brief(after)}`);
}

console.log("\n9. autosubmit-close MF-B: telemetry fired by the Submit never takes the approved slot — the form's own request files");
for (const mode of ["beaconFirst", "beaconCross", "keepaliveClick", "beaconModal"]) {
  if (!want(mode)) continue;
  const o = await stage(mode, "1", {}, undefined, 800);
  const m = msgOf(o.r);
  check(`MUST-PASS ${mode}: the form's filing POST reaches the portal EXACTLY ONCE`, filingPosts(o) === 1, brief(o));
  check(`MUST-PASS ${mode}: finalSubmitClicked, finalSubmitRequestSent, the record captured, accepted (ok, not paused)`,
    o.r.finalSubmitClicked === true && o.r.finalSubmitRequestSent === true && o.r.capturedPermitNumber === RECORD && o.r.ok === true && !o.r.pauseReason, brief(o));
  const steps = Array.isArray(o.r.steps) ? (o.r.steps as Array<{ data?: Record<string, unknown> }>) : [];
  const admitted = steps.flatMap((s) => (Array.isArray(s?.data?.approvedRequests) ? (s.data!.approvedRequests as string[]) : []));
  check(`MUST-EXCLUDE ${mode}: the beacon never takes the slot — every admitted request is the filing, none is telemetry`,
    admitted.length > 0 && admitted.every((w) => /\/apply\/submit$/.test(w)) && !/collect/.test(m.replace(/BACKSTOP ABORTED[^|]*/g, "")), `admitted=${JSON.stringify(admitted)} ${m.slice(0, 400)}`);
  // The call made (named in filingBackstop.slotAdmits): outside the slot a beacon meets the ordinary
  // rules, and at review that is the sticky lock — aborted, reported, never a stop of the filing.
  check(`${mode}: the beacon met the review lock — no telemetry request reached any server during the run`,
    o.posts.every((p) => /\/apply\/submit$/.test(p.path)), brief(o));
}

server.close();
analytics.close();
if (failures) { console.error(`\n${failures} approved-final-submit check(s) FAILED.`); process.exit(1); }
console.log("\nAll approved-final-submit checks passed (real Chromium, local fixture, the real stage path).");
process.exit(0);
