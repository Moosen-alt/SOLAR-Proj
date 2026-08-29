// A BLOCKED ADVANCE MUST STOP THE REPLAY, NOT BE MISTAKEN FOR PROGRESS.
//
// When a required field is left blank, a portal refuses the "Next" — but the CLICK still
// succeeds, because the button was there and was clicked. Replay believed that meant it had
// advanced, ran the next page's steps against the page it was still on, and every recorded
// id resolved onto whatever unrelated control happened to occupy it. Measured on a live
// PacifiCorp replay: 59 steps executed and 6 skipped past the desync before anything
// noticed, and the eventual failure pointed at an upload two pages later.
//
// waitForInteractiveControls cannot catch this — it is page-global and identity-free, so a
// page that never moved satisfies it instantly. Only a before/after page fingerprint can.
//
// The same bug hit a diagnostic probe from the other direction: an announcement modal ate
// every click and it sat on one page for fourteen iterations, so the overlay-retry below is
// not hypothetical either.
//
// Run: npx tsx portal-bot/src/adapters/advanceGuard.dom.smoke.ts
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

// A wizard page whose Next REFUSES while a required field is empty, exactly as PowerClerk
// behaves: the click lands, an inline validation message appears, the page does not move.
// Crucially the URL never changes — same-URL SPA wizards are the whole difficulty.
const PAGE = `<!doctype html><html><body>
  <h2 id="heading">Step 1: Service</h2>
  <div id="page1">
    <label for="meter">Meter Number</label><input id="meter" type="text">
    <div id="err" class="field-validation-error" style="display:none">Meter Number: This field is required.</div>
    <button id="next" type="button">Next</button>
  </div>
  <div id="page2" style="display:none">
    <label for="src">Energy Source</label>
    <select id="src"><option value="">Select...</option><option>Solar PV</option></select>
  </div>
  <script>
    document.getElementById('next').addEventListener('click', function () {
      var m = document.getElementById('meter');
      if (!m.value) { document.getElementById('err').style.display = 'block'; return; } // REFUSE
      document.getElementById('page1').style.display = 'none';
      document.getElementById('page2').style.display = 'block';
      document.getElementById('heading').textContent = 'Step 2: System';
    });
  </script>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const mkRecipe = (steps: RecipeStep[]) => ({
  id: "ag1", scopeType: "utility", profileKey: "or||pacific power", state: "OR", ahj: "", utility: "Pacific Power",
  portalPlatform: "powerclerk", portalUrl: url, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

const advance: RecipeStep = { action: "click", phase: "fill", selector: { css: "#next" }, note: "advance: Next" };
const nextPageStep: RecipeStep = { action: "select", phase: "fill", selector: { css: "#src" }, value: "Solar PV", note: "Energy Source" };

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

// CASE 1 — the meter number is never filled, so the portal refuses the advance.
const blocked = await context.newPage();
await blocked.goto(url);
const a1 = new RecipeAdapter(mkRecipe([advance, nextPageStep]), {}, {}, { autoSubmit: false });
(a1 as unknown as { page: unknown }).page = blocked;
const r1 = await a1.fillApplication({} as never);
const onPage2 = await blocked.locator("#page2").isVisible();
const srcValue = await blocked.locator("#src").inputValue().catch(() => "");

check("a refused advance STOPS the replay", () => {
  assert.equal(r1.ok, false, "the replay reported success while the portal had refused to move");
});
check("the step for the NEXT page never runs against the page we are still on", () => {
  assert.equal(onPage2, false, "the portal never advanced");
  assert.equal(srcValue, "", "a later page's step was executed while stuck — this is the desync that filled 40 wrong controls live");
});
check("the failure quotes the PORTAL'S OWN words, not a drift percentage", () => {
  const m = String(r1.message ?? "");
  assert.match(m, /did not advance/i, `message: ${m.slice(0, 200)}`);
  assert.match(m, /Meter Number: This field is required/i, `the portal's inline validation should be quoted; got: ${m.slice(0, 300)}`);
});
check("the message keeps the prefix that triggers a re-learn", () => {
  // repository.ts matches /recipe step failed/i to flag the recipe and queue a fresh learn.
  assert.match(String(r1.message ?? ""), /recipe step failed/i);
});

// CASE 2 — OVER-FIRING GUARD. Fill the required field first; the advance now works and the
// guard must be invisible. A check that stops good replays is worse than no check.
const okPage = await context.newPage();
await okPage.goto(url);
const a2 = new RecipeAdapter(mkRecipe([
  { action: "fill", phase: "fill", selector: { css: "#meter" }, value: "TEST-123", note: "Meter Number" },
  advance,
  nextPageStep,
]), {}, {}, { autoSubmit: false });
(a2 as unknown as { page: unknown }).page = okPage;
const r2 = await a2.fillApplication({} as never);

check("a page that DOES advance is unaffected", () => {
  assert.equal(r2.ok, true, `a working advance was blocked: ${String(r2.message ?? "").slice(0, 200)}`);
});
// Read the page state OUTSIDE the sync check callbacks — an await inside one is a syntax
// error, and awaiting there would also escape the try/catch that reports the failure.
const reachedPage2 = await okPage.locator("#page2").isVisible();
const v2 = await okPage.locator("#src").inputValue().catch(() => "");

check("and its later steps still run", () => {
  // Proven on the page itself, not just by the return value.
  assert.equal(reachedPage2, true);
});
check("the next page's step filled normally", () => {
  assert.equal(v2, "Solar PV", `got ${JSON.stringify(v2)}`);
});

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} advance-guard smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll advance-guard smoke tests passed (real Chromium).");
process.exit(0);
