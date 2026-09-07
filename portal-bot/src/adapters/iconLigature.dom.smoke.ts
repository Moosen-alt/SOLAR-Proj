// ICON FONTS PUT THEIR LIGATURE TEXT INSIDE THE CONTROL'S NAME.
//
// Oregon ePermitting's dashboard renders its navigation with Material Icons, so the links
// read "check_circleApply", "searchSearch", "eventSchedule", "descriptionResources". A recipe
// recorded against "Apply" matches none of them by role+name — while a DISABLED decorative
// pill elsewhere on the page carries the bare word "Apply" and matches perfectly.
//
// Both Coos Bay recipes died on step 1 because of that pair: every selector level missed the
// real control and landed on the disabled one, and the click spent its full 30 seconds on a
// button that can never be clicked. Rejecting the disabled level was necessary and not
// sufficient — there has to be something to fall through TO.
//
// Material Icons are used across government portals, so this is a fleet shape, not a quirk.
// The stripping rule is deliberately narrow: a lowercase ligature run glued directly to a
// capitalised label, which is exactly how these render and is not how English words join.
//   npx tsx portal-bot/src/adapters/iconLigature.dom.smoke.ts
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

// The dashboard, reduced: a disabled namesake and the real icon-prefixed control.
const PAGE = `<!doctype html><html><head><style>
  body { font: 14px sans-serif; padding: 18px; }
  .nav a { display:inline-block; padding:10px 16px; background:#c60; color:#fff; text-decoration:none; }
</style></head><body>
  <h2 id="heading">Dashboard</h2>
  <!-- The decorative pill that carries the bare word and can never be clicked. -->
  <button id="pill" disabled class="dropbtn1" onclick="alert('Button was clicked!');">Apply</button>
  <div class="nav">
    <!-- The real control. The icon ligature is rendered text, so the accessible name
         becomes "check_circleApply" — which is why role+name "Apply" found nothing. -->
    <a id="real" href="#go">check_circleApply</a>
    <a id="search" href="#s">searchSearch</a>
  </div>
  <div id="page2" style="display:none"><h3>Review</h3></div>
  <script>
    document.getElementById('real').addEventListener('click', function (e) {
      e.preventDefault();
      window.__applied = true;
      document.getElementById('heading').textContent = 'Review';
      document.getElementById('page2').style.display = 'block';
    });
  </script>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const recipe = {
  id: "il1", scopeType: "ahj", profileKey: "or|city of coos bay|x", state: "OR", ahj: "City of Coos Bay", utility: "",
  portalPlatform: "accela", portalUrl: url, status: "complete", version: 1,
  steps: [
    // Exactly the recorded shape from the live recipe.
    // `exact` reproduces the live shape: the recorded text matches the disabled namesake and
    // ONLY it, so preferVisible has a single candidate to collapse to and never gets to
    // prefer anything. Without this the substring match would find the real link by accident
    // and the test would pass while exercising nothing.
    { action: "click", phase: "open", selector: { text: "Apply", exact: true, fallbacks: [{ role: "link", name: "Apply", exact: true }] }, note: "application entry: Apply" },
  ] as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(url);

const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: false });
(adapter as unknown as { page: unknown }).page = page;

const res = await adapter.fillApplication({} as never);
const data = (res as unknown as { data?: { driftWarnings?: string[]; skipped?: string[] } }).data ?? {};
const applied = await page.evaluate(() => (window as unknown as { __applied?: boolean }).__applied === true);
console.log(`   drift: ${JSON.stringify((data.driftWarnings ?? []).slice(0, 2))}`);

check("THE REGRESSION: the icon-prefixed control is clicked, not the disabled namesake", () => {
  assert.equal(applied, true,
    "replay clicked the disabled pill (or nothing) instead of the real Apply link");
});

check("...and the recovery says why, so the recipe can be re-recorded properly", () => {
  assert.ok((data.driftWarnings ?? []).some((w) => /by name|ligature/i.test(w)),
    JSON.stringify(data.driftWarnings));
});

check("the step is not reported as skipped", () => {
  assert.ok(!(data.skipped ?? []).some((s) => /application entry/i.test(s)), JSON.stringify(data.skipped));
});

check("the run completes", () => {
  assert.equal(res.ok, true, String(res.message ?? "").slice(0, 200));
});

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} icon-ligature check(s) FAILED.`); process.exit(1); }
console.log("\nAll icon-ligature checks passed (real Chromium).");
process.exit(0);
