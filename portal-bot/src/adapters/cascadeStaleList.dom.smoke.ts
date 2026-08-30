// A POPULATED OPTION LIST IS NOT A READY ONE.
//
// PowerClerk repopulates the Model list by an XHR fired when the Manufacturer above it
// changes. Between the change and the response landing, the control still holds the
// PREVIOUS manufacturer's models — a long, perfectly populated list containing none of
// the ones we want.
//
// The old gate waited only while the list was EMPTY ("optionsLookUnloaded"), so it broke
// out the instant the list was non-empty and matched against the stale one. Photographed
// on a live PGE run: the Model popup listing SF160-24-M155, SF160-24-M160, SF160-24-M165
// while the manufacturer beside it read "Hanwha Q CELLS (Qidong)" and the value we needed
// was "Q.TRON BLK M-G2.C1+/AC 430". The step reported a silent SKIP, and the application
// went to review with no module model on it. The same shape skipped PacifiCorp's INVERTER
// model on a separate live run.
//
// Both control flavours are covered, because PowerClerk uses both: a native <select> on
// one page and a Vue combobox (options in a detached popup) on the spec pages. The
// combobox had NO cascade window at all.
//
// The fixture's stale list is deliberately LONGER than the fresh one, so any "wait until
// it looks full" heuristic passes it. Only "wait while it is still CHANGING" works.
//
// Run: npx tsx portal-bot/src/adapters/cascadeStaleList.dom.smoke.ts
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

const CASCADE_MS = 1200; // longer than one settle tick, so a single blind sleep cannot pass

const PAGE = `<!doctype html><html><body>
  <h2 id="heading">System Information</h2>

  <label for="mfr">Manufacturer</label>
  <select id="mfr">
    <option value="">Please select...</option>
    <option>Other Maker</option>
    <option>Hanwha Q CELLS (Qidong)</option>
  </select>

  <label for="model">Model</label>
  <select id="model">
    <option value="">Please select...</option>
    <option>SF160-24-M155</option><option>SF160-24-M160</option><option>SF160-24-M165</option>
    <option>SF160-24-M170</option><option>SF160-24-M175</option><option>SF160-24-M180</option>
  </select>

  <label for="cmodel">Combo Model</label>
  <input id="cmodel" role="combobox" readonly value="">
  <div id="popup" style="display:none">
    <!-- PowerClerk's popper renders a bare filter input above the rows. It is the filter
         that makes a stale list fatal: the wanted value matches NOTHING, so every matcher
         downstream stares at an empty list rather than a wrong one. -->
    <input id="popupsearch">
    <ul id="popuplist">
      <li role="option">SF160-24-M155</li><li role="option">SF160-24-M160</li>
      <li role="option">SF160-24-M165</li><li role="option">SF160-24-M170</li>
      <li role="option">SF160-24-M175</li><li role="option">SF160-24-M180</li>
    </ul>
  </div>

  <script>
    var FRESH = ['Q.TRON BLK M-G2.C1+/AC 430', 'Q.TRON BLK M-G2.H+ 405'];
    function repopulate() {
      // NATIVE select: replace the option list, exactly as the XHR does.
      var m = document.getElementById('model');
      m.innerHTML = '<option value="">Please select...</option>';
      FRESH.forEach(function (t) { var o = document.createElement('option'); o.textContent = t; m.appendChild(o); });
      // COMBOBOX popup: same replacement, different DOM shape.
      var p = document.getElementById('popuplist');
      p.innerHTML = '';
      FRESH.forEach(function (t) {
        var li = document.createElement('li'); li.setAttribute('role', 'option'); li.textContent = t; p.appendChild(li);
      });
      applyFilter();
    }
    document.getElementById('mfr').addEventListener('change', function () {
      window.__cascadePending = true;
      setTimeout(function () { repopulate(); window.__cascadePending = false; }, ${CASCADE_MS});
    });
    // Combobox: click opens the popup; clicking a row commits it.
    document.getElementById('cmodel').addEventListener('click', function () {
      document.getElementById('popup').style.display = 'block';
    });
    function applyFilter() {
      var q = (document.getElementById('popupsearch').value || '').trim().toLowerCase();
      Array.prototype.forEach.call(document.querySelectorAll('#popuplist li'), function (li) {
        li.style.display = (!q || (li.textContent || '').toLowerCase().indexOf(q) >= 0) ? '' : 'none';
      });
    }
    document.getElementById('popupsearch').addEventListener('input', applyFilter);
    document.getElementById('popup').addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.getAttribute && t.getAttribute('role') === 'option') {
        document.getElementById('cmodel').value = t.textContent;
        document.getElementById('popup').style.display = 'none';
      }
    });
  </script>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const mkRecipe = (steps: RecipeStep[]) => ({
  id: "cs1", scopeType: "utility", profileKey: "or||pge", state: "OR", ahj: "", utility: "PGE",
  portalPlatform: "powerclerk", portalUrl: url, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

const WANT = "Q.TRON BLK M-G2.C1+/AC 430";
// Replay resolves a step's value from fieldValues (preferring <field>Certified for a
// /model$/ field), not from step.value — an empty map means the step has nothing to fill.
const FIELDS = { moduleMake: "Hanwha Q CELLS (Qidong)", moduleModel: WANT, moduleModelCertified: WANT };
const mfrStep: RecipeStep = {
  action: "select", phase: "fill", selector: { css: "#mfr" },
  value: "Hanwha Q CELLS (Qidong)", field: "moduleMake", note: "Manufacturer",
} as RecipeStep;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

// CASE 1 — NATIVE <select>.
const p1 = await context.newPage();
await p1.goto(url);
const a1 = new RecipeAdapter(mkRecipe([
  mfrStep,
  { action: "select", phase: "fill", selector: { css: "#model" }, value: WANT, field: "moduleModel", note: "Model" } as RecipeStep,
]), FIELDS, {}, { autoSubmit: false });
(a1 as unknown as { page: unknown }).page = p1;
const r1 = await a1.fillApplication({} as never);
const nativeValue = await p1.locator("#model").inputValue().catch(() => "");

check("native select waits out the cascade and picks the fresh model", () => {
  assert.equal(nativeValue, WANT,
    `matched against the STALE list — got ${JSON.stringify(nativeValue)}; run ok=${r1.ok}`);
});

// CASE 2 — COMBOBOX whose options live in a detached popup.
const p2 = await context.newPage();
await p2.goto(url);
const a2 = new RecipeAdapter(mkRecipe([
  mfrStep,
  { action: "select", phase: "fill", selector: { css: "#cmodel" }, value: WANT, field: "moduleModel", note: "Model" } as RecipeStep,
]), FIELDS, {}, { autoSubmit: false });
(a2 as unknown as { page: unknown }).page = p2;
const r2 = await a2.fillApplication({} as never);
const comboValue = await p2.locator("#cmodel").inputValue().catch(() => "");

check("combobox gets a cascade window too", () => {
  assert.equal(comboValue, WANT,
    `the combobox matched the stale popup — got ${JSON.stringify(comboValue)}; run ok=${r2.ok}`);
});

// CASE 3 — OVER-FIRING GUARD. A value that is genuinely not in the list must still fail
// FAST once the list has settled, or every legitimate miss pays the cascade budget.
const p3 = await context.newPage();
await p3.goto(url);
const t0 = Date.now();
const a3 = new RecipeAdapter(mkRecipe([
  mfrStep,
  { action: "select", phase: "fill", selector: { css: "#model" }, value: "NOT-A-REAL-MODEL-999", field: "absentModel", note: "Model" } as RecipeStep,
]), { ...FIELDS, absentModel: "NOT-A-REAL-MODEL-999" }, {}, { autoSubmit: false });
(a3 as unknown as { page: unknown }).page = p3;
await a3.fillApplication({} as never);
const missMs = Date.now() - t0;

check("a genuine miss still settles quickly", () => {
  // Generous ceiling: the point is that it does not sit through every retry budget.
  assert.ok(missMs < 30000, `a value that is simply absent took ${missMs}ms`);
});
console.log(`       (absent-value path took ${missMs}ms)`);

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} cascade smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll cascade stale-list smoke tests passed (real Chromium).");
process.exit(0);
