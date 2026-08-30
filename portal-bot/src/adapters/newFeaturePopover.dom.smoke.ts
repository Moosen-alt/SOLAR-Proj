// AN ANNOUNCEMENT POPOVER MUST BE REMOVED BEFORE A CLICK, NOT CLICKED THROUGH.
//
// PowerClerk anchors a "What's new?" popover ON the toolbar button replay needs to press
// ("New Pacific Power Customer Generation Application"). A live PacifiCorp replay died at
// step 1 behind it, three failure screenshots over seven minutes, all showing the popover
// still standing — and the popover's own text announced the homepage redesign that had
// moved the button underneath it.
//
// Replay DID call dismissPageModals before the click, and dismissPageModals does have a
// "Got it" selector. That is exactly why this went unexplained for so long: the dismissal
// ran, reported no error, and changed nothing. PowerClerk's popover is a SEQUENCE of
// "Got it" steps, so clicking one advances the tour instead of closing it — which is what
// clearPageOverlays' own comment has said all along ("just remove it"). But replay only
// reached clearPageOverlays on the retry and advance-guard paths, never before the first
// click of a run.
//
// The fixture below therefore models the popover HONESTLY: its "Got it" advances a tour
// step and never closes anything. A fixture whose "Got it" closed the popover would pass
// with or without the fix and prove nothing.
//
// Run: npx tsx portal-bot/src/adapters/newFeaturePopover.dom.smoke.ts
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// The popover sits directly over the button, opaque and on top, the way a Bootstrap
// popover anchored to a toolbar control does. Playwright's actionability check refuses to
// click a control that cannot receive the pointer, so an un-cleared popover fails the step.
const page = (withPopover: boolean): string => `<!doctype html><html><body>
  <h2 id="heading">Home</h2>
  <div id="page1">
    <button id="newapp" type="button" style="position:absolute;top:60px;left:40px;width:320px;height:40px">
      New Pacific Power Customer Generation Application
    </button>
  </div>
  <div id="page2" style="display:none">
    <label for="first">Name</label><input id="first" type="text">
  </div>
  ${withPopover ? `
  <div class="popover new-feature-popper" id="tour"
       style="position:absolute;top:50px;left:30px;width:360px;height:120px;z-index:9999;background:#fff;border:1px solid #666">
    <div class="popover-header">What's new?</div>
    <div class="popover-body">
      <span id="tourstep">Your new homepage now shows recent projects.</span>
      <button id="gotit" type="button">Got it</button>
    </div>
  </div>` : ""}
  <script>
    window.__gotIt = 0;
    document.getElementById('newapp').addEventListener('click', function () {
      document.getElementById('page1').style.display = 'none';
      document.getElementById('page2').style.display = 'block';
      document.getElementById('heading').textContent = 'Preparer Information';
    });
    var g = document.getElementById('gotit');
    if (g) {
      // A SEQUENCE, not a close button — this is the real portal's behaviour.
      g.addEventListener('click', function () {
        window.__gotIt++;
        document.getElementById('tourstep').textContent = 'Tip ' + (window.__gotIt + 1) + ' of 4.';
      });
    }
  </script>
</body></html>`;

// Count page loads. THIS is the discriminator: without the pre-click overlay pass the
// click is intercepted, the step fails, and the retry path RELOADS and only then clears
// the overlay. The run still ends ok — so ok:true alone proves nothing. One load means
// the popover was cleared before the first click ever went out.
let loads = 0;
const server = http.createServer((q, r) => {
  loads++;
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(page(!String(q.url ?? "").startsWith("/clean")));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const mkRecipe = (url: string, steps: RecipeStep[]) => ({
  id: "nf1", scopeType: "utility", profileKey: "or||pacific power", state: "OR", ahj: "", utility: "Pacific Power",
  portalPlatform: "powerclerk", portalUrl: url, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

// Deliberately NOT noted as "advance": this is the navigate click that opens a new
// application, which is where the live run actually died.
const navigate: RecipeStep = {
  action: "click", phase: "fill", selector: { css: "#newapp" },
  note: "navigate to application: New Pacific Power Customer Generation",
} as RecipeStep;
const fillName: RecipeStep = {
  action: "fill", phase: "fill", selector: { css: "#first" }, value: "Randal", note: "Name",
} as RecipeStep;

const browser = await chromium.launch();
const context = await browser.newContext();
// Functions declared inside page.evaluate are compiled to __name(fn, "...") wrappers that
// do not exist in the browser; without this shim the throw is swallowed by a .catch and
// reads as "the overlay scan found nothing".
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

// CASE 1 — the popover is up, anchored over the button, and its "Got it" never closes it.
const blocked = await context.newPage();
await blocked.goto(`${base}/`);
const a1 = new RecipeAdapter(mkRecipe(`${base}/`, [navigate, fillName]), {}, {}, { autoSubmit: false });
(a1 as unknown as { page: unknown }).page = blocked;
const r1 = await a1.fillApplication({} as never);
const reached = await blocked.locator("#page2").isVisible();
const nameValue = await blocked.locator("#first").inputValue().catch(() => "");
const popoverGone = await blocked.evaluate(() => !document.querySelector(".new-feature-popper"));

check("the click lands despite the announcement popover", () => {
  assert.equal(r1.ok, true, `replay failed behind the popover: ${String(r1.message ?? "").slice(0, 240)}`);
});
check("the popover is REMOVED, not merely clicked through", () => {
  assert.equal(popoverGone, true, "the popover survived — clicking 'Got it' only advances its tour");
});
check("the click landed on the FIRST attempt — no failure/reload cycle", () => {
  assert.equal(loads, 1, `the page was served ${loads} times: the click was intercepted and only the retry-path reload cleared the popover`);
});
check("the run actually progressed to the next page", () => {
  assert.equal(reached, true, "never left the home page");
  assert.equal(nameValue, "Randal", `the next step did not run; got ${JSON.stringify(nameValue)}`);
});

// CASE 2 — OVER-FIRING GUARD. No popover at all: the extra overlay pass must be invisible
// and must not disturb an ordinary click. A fix that breaks working replays is not a fix.
loads = 0;
const clean = await context.newPage();
await clean.goto(`${base}/clean`);
const a2 = new RecipeAdapter(mkRecipe(`${base}/clean`, [navigate, fillName]), {}, {}, { autoSubmit: false });
(a2 as unknown as { page: unknown }).page = clean;
const r2 = await a2.fillApplication({} as never);
const reached2 = await clean.locator("#page2").isVisible();
const nameValue2 = await clean.locator("#first").inputValue().catch(() => "");

check("a page with no overlay is unaffected", () => {
  assert.equal(r2.ok, true, `a clean page was broken: ${String(r2.message ?? "").slice(0, 240)}`);
  assert.equal(reached2, true);
  assert.equal(nameValue2, "Randal", `got ${JSON.stringify(nameValue2)}`);
  assert.equal(loads, 1, `a clean page needed ${loads} loads — the extra pass caused a retry`);
});

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} new-feature-popover smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll new-feature-popover smoke tests passed (real Chromium).");
process.exit(0);
