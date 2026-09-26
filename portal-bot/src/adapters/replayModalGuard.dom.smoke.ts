// THE OVERLAY DISMISSER MAY NOT ANSWER A FILING OR PAYING DIALOG (hard rule 1).
//
// dismissPageModals runs before every click/goto/check step of a replay and on every retry, and
// at the top of every learner page. Its list reaches `[role="dialog"] button` (the FIRST button
// of any dialog) and a bare `:text-is("OK")`. The replay skeptic's local fixture (modal-probe.log):
// a Bootstrap confirm whose first button is "Submit Application", and a confirm "You are about to
// submit your application" whose button is a bare OK — each FILED four times with
// PORTAL_ALLOW_FINAL_SUBMIT unset and no approval, because the dismisser clicked outside
// guardAction.
//
// MUST-EXCLUDE: both dialogs (and a pay-worded one) -> 0 POSTs, a named refusal, in replay AND
//   when the learner-side dismisser (no chokepoint callback) runs on its own.
// MUST-PASS: a cookie dialog's OK and a "What's new?" popover's Got it are still dismissed, and the
//   recipe advances past them.
//
// Run: npx tsx portal-bot/src/adapters/replayModalGuard.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";
import { dismissPageModals } from "./autoLearnAdapter";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const posts: string[] = [];
const probeBox = (cls: string, role: string, text: string, btn: string, via: string) =>
  `<div class="${cls}" ${role ? `role="${role}"` : ""} style="display:block;position:fixed;top:10px;left:10px;background:#fff;border:1px solid #000;padding:10px;z-index:99">
     <p>${text}</p>
     <form method="post" action="/submit?via=${via}"><button type="submit">${btn}</button></form>
     <button type="button" onclick="this.parentElement.remove()">Cancel</button></div>`;
const box =`class="modal show" role="dialog" style="display:block;position:fixed;top:10px;left:10px;width:420px;background:#fff;border:1px solid #000;padding:10px;z-index:50"`;
const MAT = (handler: string) => `<div class="modal open" style="display:block;position:fixed;top:10px;left:10px;background:#fff;border:1px solid #000;padding:10px;z-index:99">
  <div class="modal-content"><h4>Confirm</h4><p>Submit your application to the city?</p></div>
  <div class="modal-footer"><a href="#!" class="modal-close waves-effect btn-flat" id="agree">Agree</a></div></div>
  <form id="ff" method="post" action="/apply/42"><input type="hidden" name="x" value="1"></form>
  <script>document.getElementById('agree').addEventListener('click', async function(){ fetch('/clicked?via=mat'); this.closest('.modal').remove(); ${handler} });</script>`;
const MAT_CLOSE = (label: string) => `<div class="modal open" style="display:block;position:fixed;top:10px;left:10px;background:#fff;border:1px solid #000;padding:10px;z-index:99">
  <div class="modal-content"><h4>Confirm</h4><p>Submit your application to the city?</p></div>
  <div class="modal-footer"><a href="#!" class="modal-close waves-effect btn-flat" id="cl">${label}</a></div></div>
  <script>document.getElementById('cl').addEventListener('click', function(){ this.closest('.modal').remove(); });</script>`;
const clicks: string[] = [];
const MODALS: Record<string, string> = {
  // A Bootstrap confirm whose FIRST button files.
  dialogSubmit: `<div ${box}><p>Ready to file this application with the city?</p>
     <form method="post" action="/submit?via=dialogSubmit"><button type="submit">Submit Application</button></form>
     <button type="button" onclick="this.closest('.modal').remove()">Cancel</button></div>`,
  // A confirm whose button is a bare OK.
  dialogOk: `<div ${box}><p>You are about to submit your application. This cannot be undone.</p>
     <form method="post" action="/submit?via=dialogOk"><button type="submit">OK</button></form>
     <button type="button" onclick="this.closest('.modal').remove()">Cancel</button></div>`,
  // A fee confirm answered by Yes.
  dialogPay: `<div ${box}><p>A plan review charge of $120.00 is due. Proceed to payment?</p>
     <form method="post" action="/submit?via=dialogPay"><button type="submit">Yes</button></form></div>`,
  // THE CLOSE-MUSTFIX CHECKER'S FOUR SHAPES (bypassModal.probe.ts, verbatim markup): each is an
  // answer-shaped control in a container no word list recognised, and each FILED (or paid) on
  // replay and in the learner before the dismisser refused what it could not identify.
  panelOk: probeBox("confirm-panel", "", "You are about to submit your application. This cannot be undone.", "OK", "panelOk"),
  dialogSendYes: probeBox("modal show", "dialog", "Are you ready to send your application to the city?", "Yes", "dialogSendYes"),
  dialogChargeOk: probeBox("confirm", "dialog", "Your card will be charged $450.00 for the permit.", "OK", "dialogChargeOk"),
  panelAccept: probeBox("notice-bar", "", "By accepting you certify the application is complete and it will be sent to the Building Division.", "Accept", "panelAccept"),
  // MUST-PASS: a cookie notice whose OK only closes it.
  cookieOk: `<div ${box}><p>This site uses cookies to remember your preferences.</p>
     <button type="button" onclick="this.closest('.modal').remove()">OK</button></div>`,
  // MUST-PASS: a consent framework's banner (Osano/cookieconsent's cc-window), identified by its
  // own attributes alone — its text never says "cookie".
  consentFramework: `<div id="cc-banner" class="cc-window cc-banner" style="position:fixed;bottom:0;left:0;right:0;background:#eee;padding:8px;z-index:50">
     <p>We use technologies to personalise content and measure traffic.</p>
     <button type="button" onclick="document.getElementById('cc-banner').remove()">Accept</button></div>`,
  // MUST-PASS: a close icon (.btn-close, no text) on an unknown dialog.
  closeIcon: `<div ${box}><p>Your session will expire in 5 minutes.</p>
     <button type="button" class="btn-close" aria-label="Close" onclick="this.closest('.modal').remove()"></button></div>`,
  // MUST-PASS: an announcement popover.
  gotIt: `<div class="popover" style="position:fixed;top:10px;left:10px;background:#fff;border:1px solid #999;padding:10px;z-index:50">
     <strong>What's new?</strong> You can now submit documents faster. <button type="button" onclick="this.closest('.popover').remove()">Got it</button></div>`,
  // CLOSE2-SAFETY (skepticNew.probe.ts, verbatim): MATERIALIZE's documented modal gives the ANSWER
  // "Agree" class modal-close. A class token must never make an answer close-only. The delayed
  // variants await a 900 ms GET and then post — past the dismisser's 600 ms window.
  matForm: MAT("document.getElementById('ff').submit();"),
  matFetch: MAT("fetch('/api/apply/42', {method:'POST', body:'x=1'});"),
  matDelayed: MAT("await fetch('/validate'); document.getElementById('ff').submit();"),
  matDelayedXhr: MAT("await fetch('/validate'); fetch('/api/apply/42', {method:'POST', body:'x=1'});"),
  // MUST-PASS: Materialize's Close / Cancel carrying class modal-close (close-only BY LABEL), even
  // on the filing question; PowerClerk's cookie banner dismiss icon (#cpr-banner-dimiss-btn, no
  // label — the id token decides for an icon); a bare .btn-close icon with no aria-label.
  matClose: MAT_CLOSE("Close"),
  matCancel: MAT_CLOSE("Cancel"),
  cprBanner: `<div id="cpr-banner" class="shadow-lg border" style="position:fixed;top:10px;left:10px;right:10px;background:#fff;padding:8px;z-index:99">
     <span>This website uses cookies to improve your experience.</span>
     <button id="cpr-banner-dimiss-btn" type="button" class="btn" style="width:28px;height:28px" onclick="document.getElementById('cpr-banner').remove()"><i class="fa fa-times"></i></button></div>`,
  btnCloseBare: `<div ${box}><p>Your session will expire in 5 minutes.</p>
     <button type="button" class="btn-close" style="width:24px;height:24px" onclick="this.closest('.modal').remove()"></button></div>`,
  // ONE CELL PER DISMISSER RULE, each caught by THAT rule alone (the checker's K1a-K1d kills were
  // all green: every earlier cell was also caught by a text veto). A click is observed by the GET
  // /clicked each control fires (a GET passes the backstop).
  // K1a — the submitter rule: a positively identified cookie banner whose OK is a form's submit.
  k1aCookieSubmit: `<div class="cookie-banner" style="position:fixed;top:10px;left:10px;background:#fff;padding:8px;z-index:99"><p>This site uses cookies.</p>
     <form method="post" action="/submit?via=k1a"><button type="submit" onclick="fetch('/clicked?via=k1a')">OK</button></form></div>`,
  // K1b — no container at all: a question in plain flow whose text no veto knows.
  k1bNoContainer: `<div style="margin:10px"><p>Ready?</p><button type="button" onclick="fetch('/clicked?via=k1b')">OK</button></div>`,
  // K1c — a dialog that is not a known cookie / consent / announcement banner, no veto word.
  k1cUnknownDialog: `<div ${box}><p>Please confirm to continue.</p><button type="button" onclick="fetch('/clicked?via=k1c')">OK</button></div>`,
  // K1d — a label that is neither close nor an answer, in a positively identified consent banner.
  k1dNonAnswer: `<div role="dialog" class="cookie-consent" style="position:fixed;top:10px;left:10px;background:#fff;padding:8px;z-index:99"><p>We use cookies.</p>
     <button type="button" onclick="fetch('/clicked?via=k1d')">Manage preferences</button></div>`,
  none: "",
};
// Which rule each K1 / Materialize cell must be refused BY (its own reason, not any reason).
const REASON: Record<string, RegExp> = {
  matForm: /answers a question about filing/, matFetch: /answers a question about filing/, matDelayed: /answers a question about filing/, matDelayedXhr: /answers a question about filing/,
  k1aCookieSubmit: /submit button in a form/, k1bNoContainer: /outside any container/, k1cUnknownDialog: /not a known cookie/, k1dNonAnswer: /neither a close control/,
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "POST") {
    posts.push(url.searchParams.get("via") || url.pathname);
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body><h1>Submitted</h1><p>Record Number: FER-26-000999-ELE</p></body></html>");
    return;
  }
  if (url.pathname === "/clicked") { clicks.push(url.searchParams.get("via") || "?"); res.writeHead(204); res.end(); return; }
  if (url.pathname === "/validate") { setTimeout(() => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); }, 900); return; }
  if (url.pathname === "/next") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body><h1>Step 4: Additional Information</h1><input id='x' aria-label='Notes'></body></html>");
    return;
  }
  const m = url.searchParams.get("modal") || "none";
  res.writeHead(200, { "content-type": "text/html" });
  // The Next link sits well below the dialog: the dialog is not in the way of the click, so a
  // refusal costs nothing and the recipe advances.
  res.end(`<!doctype html><html><head><title>Portal</title></head><body><h1>Step 3: Contacts</h1>
    <label for="nm">Contact Name</label><input id="nm">
    <div style="margin-top:420px"><a id="next" href="/next">Next</a></div>${MODALS[m] ?? ""}</body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const recipe = (m: string): PortalRecipe => ({
  id: "modal-guard", scopeType: "ahj", profileKey: "or|x|", state: "OR", ahj: "X", utility: "",
  portalPlatform: "fixture", portalUrl: `${base}/form?modal=${m}`, status: "complete", version: 1, createdBy: "s", createdAt: "", updatedAt: "", notes: "",
  steps: [
    { action: "goto", value: `${base}/form?modal=${m}`, note: "open" },
    { action: "click", selector: { css: "#next", role: "link", name: "Next" }, note: "advance: Next" } as RecipeStep,
    { action: "stopForReview" },
  ],
} as unknown as PortalRecipe);

const browser = await chromium.launch();
try {
  // ---- REPLAY (the dismisser's clicks go through guardAction) ----
  const MUST_PASS = new Set(["cookieOk", "gotIt", "consentFramework", "closeIcon", "matClose", "matCancel", "cprBanner", "btnCloseBare"]);
  const NEW_EXCLUDE = ["matForm", "matFetch", "matDelayed", "matDelayedXhr", "k1aCookieSubmit", "k1bNoContainer", "k1cUnknownDialog", "k1dNonAnswer"];
  const OVERLAYS = ".modal, .popover, #cc-banner, #cpr-banner";
  for (const m of ["dialogSubmit", "dialogOk", "dialogPay", "panelOk", "dialogSendYes", "dialogChargeOk", "panelAccept", "cookieOk", "gotIt", "consentFramework", "closeIcon",
    "matClose", "matCancel", "cprBanner", "btnCloseBare", ...NEW_EXCLUDE]) {
    const ctx = await browser.newContext();
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    const adapter = new RecipeAdapter(recipe(m), {}, {}, {} as never);
    (adapter as unknown as { page: unknown }).page = page;
    posts.length = 0;
    clicks.length = 0;
    let ok = false;
    let msg = "";
    try { const r = await adapter.fillApplication({} as ProjectRecord); ok = r.ok; msg = String(r.message).slice(0, 160); }
    catch (e) { msg = `threw ${String(e).slice(0, 160)}`; }
    const onNext = /\/next$/.test(page.url());
    const modalLeft = await page.locator(OVERLAYS).count().catch(() => -1);
    await page.waitForTimeout(NEW_EXCLUDE.includes(m) ? 1500 : 0); // a delayed post lands
    await ctx.close();
    const refusals = adapter.guardRefusals.join(" | ");
    if (MUST_PASS.has(m)) {
      check(`MUST-PASS replay/${m}: the overlay is dismissed, no POST, and the recipe advances`,
        posts.length === 0 && ok && onNext && modalLeft === 0,
        `posts=${posts.length} ok=${ok} onNext=${onNext} overlaysLeft=${modalLeft} refusals=${refusals} ${msg}`);
    } else {
      check(`MUST-EXCLUDE replay/${m}: no filing/paying POST`, posts.length === 0, `POSTs=[${posts.join(",")}] ${msg}`);
      check(`MUST-EXCLUDE replay/${m}: the refusal is named in the run's refusals`,
        /dismisser refused/.test(refusals) && (REASON[m] ?? /(submit|filing|pay|cannot identify|not a known|navigat)/i).test(refusals), `refusals=${refusals || "(none)"}`);
      if (REASON[m]) check(`MUST-EXCLUDE replay/${m}: the control was never clicked`, clicks.length === 0, `clicks=[${clicks.join(",")}]`);
      check(`replay/${m}: the recipe still advances (the dialog was not in the way)`, ok && onNext, `ok=${ok} onNext=${onNext} ${msg}`);
    }
  }

  // ---- LEARNER-SIDE (no chokepoint callback: the in-page predicate alone) ----
  for (const m of ["dialogSubmit", "dialogOk", "dialogPay", "panelOk", "dialogSendYes", "dialogChargeOk", "panelAccept", "cookieOk", "consentFramework", "closeIcon",
    "matClose", "matCancel", "cprBanner", "btnCloseBare", ...NEW_EXCLUDE]) {
    const ctx = await browser.newContext();
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    await page.goto(`${base}/form?modal=${m}`);
    posts.length = 0;
    clicks.length = 0;
    const r = await dismissPageModals(page);
    await page.waitForTimeout(NEW_EXCLUDE.includes(m) ? 2000 : 800);
    const left = await page.locator(OVERLAYS).count().catch(() => -1);
    await ctx.close();
    if (MUST_PASS.has(m)) {
      check(`MUST-PASS learner/${m}: dismissed with no POST`, posts.length === 0 && left === 0 && r.dismissed.length > 0,
        `posts=${posts.length} left=${left} dismissed=${r.dismissed.join(",")} refused=${r.refused.join(" | ")}`);
    } else {
      check(`MUST-EXCLUDE learner/${m}: 0 POSTs and a named refusal`, posts.length === 0 && r.refused.some((x) => (REASON[m] ?? /(submit|filing|pay|cannot identify|not a known|navigat)/i).test(x)),
        `POSTs=[${posts.join(",")}] refused=${r.refused.join(" | ") || "(none)"}`);
      if (REASON[m]) check(`MUST-EXCLUDE learner/${m}: the control was never clicked`, clicks.length === 0, `clicks=[${clicks.join(",")}]`);
    }
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} replay-modal-guard check(s) FAILED.`); process.exit(1); }
console.log("\nAll replay-modal-guard checks passed (real Chromium).");
process.exit(0);
