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
// Kill: mayClickFinalSubmit -> true (or finalSubmitRefusals -> []) turns the MUST-EXCLUDE env /
// approval / shape cases red.
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
  if (mode === "captcha") {
    return `${summary}<iframe title="reCAPTCHA" src="/recaptcha/api2/anchor?k=fixture" width="304" height="78"></iframe>
      <form method="post" action="/m/captcha/apply/submit"><button type="submit" id="btnSubmit">Submit Application</button></form>`;
  }
  if (mode === "payControl") {
    return `${summary}<form method="post" action="/m/payControl/apply/submit"><button type="submit" id="btnPay">Pay and Submit</button></form>`;
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
  if (req.method === "POST" && rest === "apply/submit") {
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
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

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

const RUN = "run-approved-1";
const APPROVAL = { approver: "A. Operator", runId: RUN };
interface Outcome { r: Record<string, unknown>; posts: Array<{ method: string; path: string }>; ms: number }
async function stage(mode: string, env: string | undefined, opts: { runApproval?: { approver: string; runId: string } | null; runId?: string }, steps?: RecipeStep[]): Promise<Outcome> {
  // The switch is set on THIS process only, for this one run, and restored after.
  const prev = process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  if (env === undefined) delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; else process.env.PORTAL_ALLOW_FINAL_SUBMIT = env;
  const before = requests.length;
  const t0 = Date.now();
  try {
    const r = await stageWithRecipe(recipeFor(mode, steps), { id: `p-${mode}` } as ProjectRecord, {}, {}, [], {
      autoSubmit: true, runApproval: opts.runApproval === undefined ? APPROVAL : opts.runApproval, runId: opts.runId ?? RUN, headless: true,
    });
    await new Promise((res) => setTimeout(res, 300)); // a late request is still counted
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
  { name: "approval naming no approver", env: "1", opts: { runApproval: { approver: "  ", runId: RUN } } },
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

server.close();
if (failures) { console.error(`\n${failures} approved-final-submit check(s) FAILED.`); process.exit(1); }
console.log("\nAll approved-final-submit checks passed (real Chromium, local fixture, the real stage path).");
process.exit(0);
