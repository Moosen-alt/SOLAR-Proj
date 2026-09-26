// THE NETWORK BACKSTOP, ON SHAPES THE WORD GATES PASS (hard rule 1).
//
// The close-mustfix checker's principle: a click or key the bot makes without a named approval
// may never be the one that files or pays, and word lists lose to the next wording — so back them
// with a network check that does not care which control fired. Every shape below is one the
// label/dialog/Enter gates ALLOW (a positively identified cookie banner's type=button OK, a
// "Next" link, an Enter in a box outside any form): only filingBackstop.ts can stop them, so
// removing it turns this smoke red.
//
// MUST-EXCLUDE (0 state-changing requests reach the server, every abort reported):
//   dismisserScript  — a cookie banner's OK whose onclick fires fetch POST /apply/42 (window rule)
//   terminalEnter    — Enter in a search box on a "Review and Submit" page whose keydown posts a
//                      form to /apply/42 a tick later (window rule)
//   scriptFiling     — a "Next" link whose onclick submits a hidden form to /SubmitApplication
//                      (filing-URL rule); the replay STOPS, named, ok=false
//   learner          — the learner's dismisser on the dismisserScript page, backstop installed
// MUST-PASS:
//   postback         — the same "Next" submitting to /Cap/CapEdit.aspx: the POST reaches the
//                      server and the run advances
//   cookie banner    — still clicked and gone (dismisserScript)
//   humanAfterRun    — after fillApplication returns, the route is gone: a person's own filing
//                      POST in the same page reaches the server (armSubmitWatch hands them it)
//
// Run: npx tsx portal-bot/src/filingBackstop.dom.smoke.ts
import "./smokeArtifactDirs";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../shared/src/types";
import { RecipeAdapter } from "./adapters/recipeAdapter";
import { dismissPageModals } from "./adapters/autoLearnAdapter";
import { installFilingBackstop } from "./filingBackstop";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const posts: string[] = [];
const PAGES: Record<string, string> = {
  dismisserScript: `<h1>Step 3: Contacts</h1><label for="nm">Contact Name</label><input id="nm">
    <div style="margin-top:420px"><a id="next" href="/next">Next</a></div>
    <div class="cookie-banner" style="position:fixed;top:0;left:0;right:0;background:#eee;padding:8px;z-index:99"><p>This site uses cookies.</p>
      <button type="button" onclick="setTimeout(function(){fetch('/apply/42',{method:'POST',body:'x=1'}).catch(function(){});},0);this.parentElement.remove()">OK</button></div>`,
  terminalEnter: `<h1>Step 5: Review and Submit</h1><p>Please review your application before submitting.</p>
    <label for="q">Search records</label><input id="q"
      onkeydown="if(event.key==='Enter'){setTimeout(function(){var f=document.createElement('form');f.method='post';f.action='/apply/42';document.body.appendChild(f);f.submit();},0);}">`,
  scriptFiling: `<h1>Step 3: Contacts</h1><label for="nm">Contact Name</label><input id="nm">
    <form id="hf" method="post" action="/SubmitApplication" style="display:none"><input name="a" value="1"></form>
    <a id="next" href="#" onclick="document.getElementById('hf').submit();return false;">Next</a>`,
  postback: `<h1>Step 3: Contacts</h1><label for="nm">Contact Name</label><input id="nm">
    <form id="hf" method="post" action="/Cap/CapEdit.aspx" style="display:none"><input name="a" value="1"></form>
    <a id="next" href="#" onclick="document.getElementById('hf').submit();return false;">Next</a>`,
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method !== "GET") {
    posts.push(url.pathname);
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body><h1>Step 4: Additional Information</h1><input id='x' aria-label='Notes'></body></html>");
    return;
  }
  if (url.pathname === "/next") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body><h1>Step 4: Additional Information</h1><input id='x' aria-label='Notes'></body></html>");
    return;
  }
  const m = url.searchParams.get("m") || "postback";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><head><title>Portal</title></head><body>${PAGES[m] ?? ""}</body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const recipe = (m: string, steps: RecipeStep[]): PortalRecipe => ({
  id: "backstop", scopeType: "ahj", profileKey: "or|x|", state: "OR", ahj: "X", utility: "",
  portalPlatform: "fixture", portalUrl: `${base}/form?m=${m}`, status: "complete", version: 1, createdBy: "s", createdAt: "", updatedAt: "", notes: "",
  steps: [{ action: "goto", value: `${base}/form?m=${m}`, note: "open" } as RecipeStep, ...steps, { action: "stopForReview" } as RecipeStep],
} as unknown as PortalRecipe);
const NEXT = { action: "click", selector: { css: "#next", role: "link", name: "Next" }, note: "advance: Next" } as RecipeStep;
const ENTER = { action: "press", selector: { css: "#q", label: "Search records" }, value: "Enter", note: "Search records" } as RecipeStep;

const browser = await chromium.launch();
try {
  const replay = async (m: string, steps: RecipeStep[], after?: (page: import("playwright").Page) => Promise<void>) => {
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(5000);
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    const adapter = new RecipeAdapter(recipe(m, steps), {}, {}, {} as never);
    (adapter as unknown as { page: unknown }).page = page;
    posts.length = 0;
    let ok = false;
    let msg = "";
    try { const r = await adapter.fillApplication({} as ProjectRecord); ok = r.ok; msg = String(r.message).slice(0, 400); }
    catch (e) { msg = `threw ${String(e).slice(0, 200)}`; }
    await page.waitForTimeout(500);
    const during = posts.slice();
    const url = page.url();
    const bannerLeft = await page.locator(".cookie-banner").count().catch(() => -1);
    if (after) await after(page);
    const afterPosts = posts.slice(during.length);
    await ctx.close().catch(() => null);
    return { ok, msg, during, afterPosts, url, bannerLeft, refusals: adapter.guardRefusals.join(" | ") };
  };

  {
    const r = await replay("dismisserScript", [NEXT]);
    check("MUST-EXCLUDE dismisserScript: the cookie OK's script POST never reaches the server", r.during.length === 0, `POSTs=[${r.during.join(",")}] ${r.msg}`);
    check("dismisserScript: the abort is reported (window rule, dismisser)", /BACKSTOP ABORTED POST .*\/apply\/42.*dismisser/.test(r.refusals), `refusals=${r.refusals || "(none)"}`);
    check("MUST-PASS dismisserScript: the cookie banner was still clicked away and the recipe advanced", r.ok && /\/next$/.test(r.url), `ok=${r.ok} url=${r.url} ${r.msg}`);
  }
  {
    const r = await replay("terminalEnter", [ENTER]);
    check("MUST-EXCLUDE terminalEnter: the review page's Enter-mapped POST never reaches the server", r.during.length === 0, `POSTs=[${r.during.join(",")}] ${r.msg}`);
    check("terminalEnter: the abort is reported (window rule, Enter on a review page)", /BACKSTOP ABORTED POST .*\/apply\/42.*Enter on a review/.test(r.refusals), `refusals=${r.refusals || "(none)"} ${r.msg}`);
  }
  {
    const r = await replay("scriptFiling", [NEXT]);
    check("MUST-EXCLUDE scriptFiling: the 'Next' link's hidden filing POST never reaches the server", r.during.length === 0, `POSTs=[${r.during.join(",")}] ${r.msg}`);
    check("scriptFiling: the replay STOPS, named, and does not report success", !r.ok && /STOPPED BY THE NETWORK BACKSTOP/.test(r.msg) && /SubmitApplication/.test(r.msg), `ok=${r.ok} ${r.msg}`);
  }
  {
    const r = await replay("postback", [NEXT], async (page) => {
      // The person's own filing, in the same page, after the run handed it over.
      await page.evaluate((u) => { const f = document.createElement("form"); f.method = "post"; f.action = u; document.body.appendChild(f); f.submit(); }, `${base}/SubmitApplication`);
      await page.waitForTimeout(1200);
    });
    check("MUST-PASS postback: an ordinary postback POST reaches the server and the run advances", r.during.join(",") === "/Cap/CapEdit.aspx" && r.ok, `POSTs=[${r.during.join(",")}] ok=${r.ok} ${r.msg}`);
    check("MUST-PASS humanAfterRun: after the run, the backstop is gone — the person's own filing POST goes through", r.afterPosts.join(",") === "/SubmitApplication", `after=[${r.afterPosts.join(",")}]`);
  }
  {
    // THE LEARNER'S DISMISSER (no chokepoint callback) with the learn run's backstop installed.
    const ctx = await browser.newContext();
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    await page.goto(`${base}/form?m=dismisserScript`);
    const bs = await installFilingBackstop(page, "learn run");
    posts.length = 0;
    const d = await dismissPageModals(page);
    await page.waitForTimeout(800);
    const left = await page.locator(".cookie-banner").count().catch(() => -1);
    const aborts = bs?.aborts.length ?? -1;
    await bs?.dispose();
    await ctx.close();
    check("MUST-EXCLUDE learner: the dismisser's script POST never reaches the server", posts.length === 0 && aborts >= 1, `POSTs=[${posts.join(",")}] aborts=${aborts}`);
    check("MUST-PASS learner: the cookie banner is still dismissed", left === 0 && d.dismissed.length > 0, `left=${left} dismissed=${d.dismissed.join(",")} refused=${d.refused.join(" | ")}`);
  }
  {
    // A TAB THE RUN ADOPTS (the learner switches this.page to a popup — PowerClerk opens its form
    // in a new tab): the backstop was installed for the ORIGINAL page, and its window rule must
    // still hold on the adopted one (backstopFor falls back to the shared context).
    const ctx = await browser.newContext();
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    await page.goto(`${base}/form?m=postback`);
    const bs = await installFilingBackstop(page, "learn run");
    const [popup] = await Promise.all([ctx.waitForEvent("page"), page.evaluate((u) => { window.open(u, "_blank"); }, `${base}/form?m=dismisserScript`)]);
    await popup.waitForLoadState("domcontentloaded");
    posts.length = 0;
    const d = await dismissPageModals(popup);
    await popup.waitForTimeout(800);
    const aborts = bs?.aborts.length ?? -1;
    await bs?.dispose();
    await ctx.close();
    check("MUST-EXCLUDE adopted popup: the dismisser's script POST in a tab the run adopted never reaches the server", posts.length === 0 && aborts >= 1 && d.dismissed.length > 0,
      `POSTs=[${posts.join(",")}] aborts=${aborts} dismissed=${d.dismissed.join(",")}`);
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} filing-backstop check(s) FAILED.`); process.exit(1); }
console.log("\nAll filing-backstop checks passed (real Chromium).");
process.exit(0);
