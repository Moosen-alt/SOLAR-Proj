// A RECIPE "PRESS ENTER" IS A CLICK ON THE FORM'S DEFAULT BUTTON (hard rule 1).
//
// guardedPress judged the FOCUSED box's label ("Parcel Number"), not the button Enter activates.
// The replay skeptic's fixture (enter-probe.log): fill + press Enter in a text box whose form's only
// button is "Submit Application" -> POST /submit with PORTAL_ALLOW_FINAL_SUBMIT unset and no
// approval, and the run reported ok=true. enterSubmit/enterSubmitGuard guard the LEARNER's walk,
// not a recorded replay press step.
//
// MUST-PASS: default button "Search" -> POST /search (the Enter is pressed).
// MUST-EXCLUDE: default button "Submit Application" / "Submit" / "File", and a button-less form
//   whose action is a filing endpoint -> no POST, a named refusal.
// Also the shared in-page question comboboxFill asks before its own Enter (MUST-PASS/EXCLUDE).
//
// CLOSE-MUSTFIX (checker's bypassEnter.probe.ts): an Enter is judged against EVERY control it can
// activate (enterRefusalInPage). MUST-EXCLUDE aspnetDefault / aspnetHiddenDefault (a declared
// WebForm_FireDefaultButton default), jsKeydown (a script maps Enter to the filing button: the
// conservative rule), reviewNoButton (any form on a page that names itself the review step).
// MUST-PASS accelaContinue (Accela's mid-flow Continue Application in the same whole-page form)
// and login (a Sign In form's Enter signs in).
//
// Run: npx tsx portal-bot/src/adapters/replayEnterGuard.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";
import { PORTAL_SAFETY_GLOBAL, PORTAL_SAFETY_IN_PAGE_SOURCE } from "../../../shared/src/portalSafety";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const posts: string[] = [];
const BUTTONS: Record<string, string> = {
  search: `<button type="submit" formaction="/search">Search</button>`,
  submitApplication: `<button type="submit" formaction="/submit">Submit Application</button>`,
  submit: `<input type="submit" formaction="/submit" value="Submit">`,
  file: `<button formaction="/submit">File</button>`,
  // No button at all: implicit submission posts to the form's own action.
  noButtonFilingAction: "",
};
// THE CLOSE-MUSTFIX CHECKER'S ENTER SHAPES (bypassEnter.probe.ts, verbatim) — each FILED on replay
// and the run reported ok=true "stopped at review" — plus the MUST-PASS pages the conservative
// rule must not break. Enter is pressed in #q on every page.
const FIRE_DEFAULT = `<script>function WebForm_FireDefaultButton(event, target) {
  if (event.keyCode == 13) { var src = event.srcElement || event.target;
    if (!src || (src.tagName.toLowerCase() != "textarea")) { var b = document.getElementById(target);
      if (b && typeof(b.click) != "undefined") { b.click(); event.cancelBubble = true; if (event.stopPropagation) event.stopPropagation(); return false; } } }
  return true; }</script>`;
const PAGES: Record<string, string> = {
  // (a) ASP.NET Panel DefaultButton: the FIRST submit is Search; the DECLARED default files.
  aspnetDefault: `<h1>Step 2: Project Details</h1>${FIRE_DEFAULT}
    <form method="post" action="/Cap/CapEdit.aspx"><div id="pnl" onkeypress="javascript:return WebForm_FireDefaultButton(event, 'ctl00_btnFile')">
      <label for="q">Parcel Number</label><input id="q" name="q">
      <input type="submit" name="btnSearch" value="Search" formaction="/search">
      <input type="submit" id="ctl00_btnFile" name="btnFile" value="Submit Application" formaction="/submit">
    </div></form>`,
  // (a') the same, with the declared default HIDDEN (WebForms pages often hide it): only the
  //      declared-default rule sees it — the conservative rule reads visible controls.
  aspnetHiddenDefault: `<h1>Step 2: Project Details</h1>${FIRE_DEFAULT}
    <form method="post" action="/Cap/CapEdit.aspx"><div id="pnl" onkeypress="javascript:return WebForm_FireDefaultButton(event, 'ctl00_btnFile')">
      <label for="q">Parcel Number</label><input id="q" name="q">
      <input type="submit" name="btnSearch" value="Search" formaction="/search">
      <input type="submit" id="ctl00_btnFile" name="btnFile" value="Submit Application" formaction="/submit" style="display:none">
    </div></form>`,
  // (b) a page script maps Enter to the filing button; the first submit is Search.
  jsKeydown: `<h1>Step 2: Project Details</h1>
    <form method="post" action="/other"><label for="q">Parcel Number</label>
      <input id="q" name="q" onkeydown="if(event.key==='Enter'){event.preventDefault();this.form.requestSubmit(document.getElementById('f'));}">
      <button type="submit" formaction="/search">Search</button><button id="f" type="submit" formaction="/submit">Submit Application</button></form>`,
  // (c) a page that names itself the review step; a one-box form with NO button, action not filing-worded.
  reviewNoButton: `<h1>Step 5: Review and Submit</h1><p>Please review your application before submitting.</p>
    <form method="post" action="/apply/42"><label for="q">Parcel Number</label><input id="q" name="q"></form>
    <a href="javascript:void(0)">Submit Application</a>`,
  // MUST-PASS: Accela's whole-page WebForms form carries the mid-flow "Continue Application"
  // (__doPostBack link) on a fillable, non-review page; Enter in the parcel box runs Search.
  accelaContinue: `<h1>Step 1: Work Location</h1>
    <script>function __doPostBack(t, a) { var f = document.forms[0]; f.__EVENTTARGET.value = t; f.submit(); }</script>
    <form method="post" action="/Cap/CapEdit.aspx"><input type="hidden" name="__EVENTTARGET">
      <label for="st">Street Name</label><input id="st" name="st">
      <label for="q">Parcel Number</label><input id="q" name="q"> <input type="submit" value="Search" formaction="/search">
      <a id="cont" href="javascript:__doPostBack('ctl00$PlaceHolderMain$actionBarBottom$btnContinue','')">Continue Application &raquo;</a>
    </form>`,
  // MUST-PASS: a login form's Enter still signs in.
  login: `<h1>Sign in to your account</h1>
    <form method="post" action="/Account/Login"><label for="q">User Name</label><input id="q" name="q">
      <label for="pw">Password</label><input id="pw" name="pw" type="password"><button type="submit">Sign In</button></form>`,
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "POST") {
    posts.push(url.pathname);
    res.writeHead(303, { location: "/done" });
    res.end();
    return;
  }
  if (url.pathname === "/done") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body><h1>Thank you</h1></body></html>");
    return;
  }
  const m = url.searchParams.get("m") || "search";
  if (PAGES[m]) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><head><title>Portal</title></head><body>${PAGES[m]}</body></html>`);
    return;
  }
  const action = m === "noButtonFilingAction" ? "/SubmitApplication" : "/other";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><head><title>Portal</title></head><body><h1>Step 2: Project Details</h1>
    <form method="post" action="${action}"><label for="q">Parcel Number</label><input id="q" name="q">${BUTTONS[m] ?? ""}</form>
    <form method="post" action="/submit"><div class="combo"><input type="search" id="cs" aria-label="Find a county"></div>
      <button type="submit">Submit Application</button></form>
    <form method="post" action="/lookup"><div class="combo"><input type="search" id="cs2" aria-label="Find a county"></div>
      <button type="submit">Look up</button></form></body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const boxLabel = (m: string): string => (m === "login" ? "User Name" : "Parcel Number");
const recipe = (m: string): PortalRecipe => ({
  id: "enter-guard", scopeType: "ahj", profileKey: "or|x|", state: "OR", ahj: "X", utility: "",
  portalPlatform: "fixture", portalUrl: `${base}/form?m=${m}`, status: "complete", version: 1, createdBy: "s", createdAt: "", updatedAt: "", notes: "",
  steps: [
    { action: "goto", value: `${base}/form?m=${m}`, note: "open" },
    { action: "fill", selector: { css: "#q", label: boxLabel(m) }, value: "12-34", note: boxLabel(m) } as RecipeStep,
    { action: "press", selector: { css: "#q", label: boxLabel(m) }, value: "Enter", note: boxLabel(m) } as RecipeStep,
    { action: "stopForReview" },
  ],
} as unknown as PortalRecipe);

const browser = await chromium.launch();
try {
  const MUST_PASS_POSTS: Record<string, string> = { search: "/search", accelaContinue: "/search", login: "/Account/Login" };
  for (const m of [...Object.keys(BUTTONS), ...Object.keys(PAGES)]) {
    const ctx = await browser.newContext();
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    const adapter = new RecipeAdapter(recipe(m), {}, {}, {} as never);
    (adapter as unknown as { page: unknown }).page = page;
    posts.length = 0;
    let ok = false;
    let msg = "";
    try { const r = await adapter.fillApplication({} as ProjectRecord); ok = r.ok; msg = String(r.message).slice(0, 200); }
    catch (e) { msg = `threw ${String(e).slice(0, 160)}`; }
    await ctx.close().catch(() => null);
    const refusals = adapter.guardRefusals.join(" | ");
    if (MUST_PASS_POSTS[m]) {
      check(`MUST-PASS ${m}: the Enter is pressed and posts ${MUST_PASS_POSTS[m]}`, posts.join(",") === MUST_PASS_POSTS[m], `POSTs=[${posts.join(",")}] refusals=${refusals || "(none)"} ${msg}`);
    } else {
      check(`MUST-EXCLUDE ${m}: no POST`, posts.length === 0, `POSTs=[${posts.join(",")}] ${msg}`);
      check(`MUST-EXCLUDE ${m}: a named refusal, and the run does not report success`,
        !ok && /(Enter|default button)/.test(refusals) && /replay safety gate refused/.test(msg), `ok=${ok} refusals=${refusals || "(none)"} msg=${msg}`);
    }
  }

  // The shared question comboboxFill asks before pressing Enter in a widget's search box.
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const page = await ctx.newPage();
  await page.goto(`${base}/form?m=search`);
  await page.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE);
  const ask = (sel: string) => page.locator(sel).evaluate((el, g) => (globalThis as unknown as Record<string, { implicitSubmitRefusalInPage: (e: Element) => string }>)[g].implicitSubmitRefusalInPage(el), PORTAL_SAFETY_GLOBAL);
  const inFiling = await ask("#cs");
  const inLookup = await ask("#cs2");
  await ctx.close();
  check("MUST-EXCLUDE combobox search box in a form whose default button is 'Submit Application': Enter refused", /submit-worded/.test(inFiling), `got ${JSON.stringify(inFiling)}`);
  check("MUST-PASS combobox search box in a form whose default button is 'Look up': Enter allowed", inLookup === "", `got ${JSON.stringify(inLookup)}`);
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} replay-enter-guard check(s) FAILED.`); process.exit(1); }
console.log("\nAll replay-enter-guard checks passed (real Chromium).");
process.exit(0);
