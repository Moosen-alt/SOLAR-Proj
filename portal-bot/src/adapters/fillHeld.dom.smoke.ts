// TYPING IS NOT SAVING, AND REPLAY COULD NOT TELL THE DIFFERENCE.
//
// The fill path returned `true` the moment .fill() resolved. Success meant "we typed",
// never "it stuck" — and it walked away from the autosave its own blur had just started,
// while the SELECT path two lines below waits for that same autosave and returns its
// honest result, with a comment explaining that skipping the wait lets a server re-render
// restore the old value.
//
// A live PacifiCorp replay reported success on "Total System Export (kW)"; the screenshot
// it saved shows the box empty with a required error beneath it. On that evidence a fill's
// return value was worth nothing.
//
// The readback has to be LENIENT, and that is what most of this file is about. Portals
// rewrite what you type: a phone becomes "(503) 555-0142", a decimal field turns 7.2 into
// 7.20, a date input reorders 2026-10-01 into 10/01/2026. Reporting any of those as a lost
// value would demote correct filings and teach the operator to ignore the warning — the
// same false-alarm trap the required sweep had to avoid.
//
// Run: npx tsx portal-bot/src/adapters/fillHeld.dom.smoke.ts
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

// One box that keeps its value, one a re-render takes back, and three that reformat.
const PAGE = `<!doctype html><html><body>
  <h2 id="heading">Interconnection</h2>
  <div id="page1">
    <label for="holds">Designer Contact Name</label><input id="holds">
    <label for="wiped">Total System Export (kW)</label><input id="wiped">
    <label for="phone">Designer Direct Contact Phone Number</label><input id="phone">
    <label for="decimal">Inverter Rating</label><input id="decimal">
    <label for="planned">Planned date of operation</label><input id="planned">
    <button id="next" type="button">Next</button>
  </div>
  <div id="page2" style="display:none"><h3>Review</h3></div>
  <script>
    // THE FAILURE THIS EXISTS TO CATCH. PowerClerk's autosave round-trips the field and the
    // server's answer wins; when the value never reached the model, what comes back is the
    // old one — empty. Indistinguishable, from the typing side, from a value that saved.
    document.getElementById('wiped').addEventListener('blur', function (e) { e.target.value = ''; });

    // ...and the three benign rewrites, which must NOT read as losses.
    document.getElementById('phone').addEventListener('blur', function (e) {
      var d = (e.target.value || '').replace(/[^0-9]/g, '');
      if (d.length === 10) e.target.value = '(' + d.slice(0,3) + ') ' + d.slice(3,6) + '-' + d.slice(6);
    });
    document.getElementById('decimal').addEventListener('blur', function (e) {
      var n = Number(e.target.value); if (!isNaN(n) && e.target.value !== '') e.target.value = n.toFixed(2);
    });
    document.getElementById('planned').addEventListener('blur', function (e) {
      var m = (e.target.value || '').match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);
      if (m) e.target.value = m[2] + '/' + m[3] + '/' + m[1];
    });

    document.getElementById('next').addEventListener('click', function () {
      document.getElementById('page1').style.display = 'none';
      document.getElementById('page2').style.display = 'block';
      document.getElementById('heading').textContent = 'Review';
    });
  </script>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const recipe = {
  id: "fh1", scopeType: "utility", profileKey: "or||pacific power", state: "OR", ahj: "", utility: "Pacific Power",
  portalPlatform: "powerclerk", portalUrl: url, status: "complete", version: 1,
  steps: [
    { action: "fill", phase: "fill", selector: { css: "#holds" }, field: "designerName", note: "Designer Contact Name" },
    { action: "fill", phase: "fill", selector: { css: "#wiped" }, field: "systemExport", note: "Total System Export (kW)" },
    { action: "fill", phase: "fill", selector: { css: "#phone" }, field: "designerPhone", note: "Designer Direct Contact Phone Number" },
    { action: "fill", phase: "fill", selector: { css: "#decimal" }, field: "inverterRating", note: "Inverter Rating" },
    { action: "fill", phase: "fill", selector: { css: "#planned" }, field: "plannedDate", note: "Planned date of operation" },
    { action: "click", phase: "fill", selector: { css: "#next" }, note: "advance: Next" },
  ] as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(url);

const adapter = new RecipeAdapter(recipe, {
  designerName: "Charles Bitton",
  systemExport: "6.4",
  designerPhone: "5035550142",
  inverterRating: "7.2",
  plannedDate: "2026-10-01",
}, {}, { autoSubmit: false });
(adapter as unknown as { page: unknown }).page = page;

const res = await adapter.fillApplication({} as never);
const data = (res as unknown as { data?: { skipped?: string[]; driftWarnings?: string[] } }).data ?? {};
const skipped = data.skipped ?? [];
const drift = data.driftWarnings ?? [];
console.log(`   skipped: ${JSON.stringify(skipped)}`);
console.log(`   drift:   ${JSON.stringify(drift.slice(0, 3))}`);

// ---------------------------------------------------------------------------
// The miss.
// ---------------------------------------------------------------------------
check("THE REGRESSION: a value the portal takes back is reported, not counted as filled", () => {
  assert.ok(
    skipped.some((s) => /total system export/i.test(s)),
    `the box was empty after the fill and the step still reported success; skipped=${JSON.stringify(skipped)}`,
  );
});

check("...and it says so in words an operator can act on", () => {
  assert.ok(drift.some((w) => /did not hold the value/i.test(w)), JSON.stringify(drift));
});

// ---------------------------------------------------------------------------
// The false alarms, which are the expensive direction.
// ---------------------------------------------------------------------------
check("a value that simply holds is not reported", () => {
  assert.ok(!skipped.some((s) => /designer contact name/i.test(s)), JSON.stringify(skipped));
});

check("a REFORMATTED PHONE is not a lost value", () => {
  assert.ok(!skipped.some((s) => /phone/i.test(s)), `"(503) 555-0142" read as a miss; ${JSON.stringify(skipped)}`);
});

check("a decimal the portal pads (7.2 -> 7.20) is not a lost value", () => {
  assert.ok(!skipped.some((s) => /inverter rating/i.test(s)), JSON.stringify(skipped));
});

check("a date the portal reorders (2026-10-01 -> 10/01/2026) is not a lost value", () => {
  assert.ok(!skipped.some((s) => /planned date/i.test(s)), JSON.stringify(skipped));
});

check("exactly ONE step is reported — the run is not drowned in false misses", () => {
  assert.equal(skipped.length, 1, JSON.stringify(skipped));
});

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} fill-held smoke test(s) FAILED.`); process.exit(1); }
console.log("\nAll fill-held smoke tests passed (real Chromium).");
process.exit(0);
