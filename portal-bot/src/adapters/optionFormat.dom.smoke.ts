// THE PORTAL SPELLS THE MODEL DIFFERENTLY FROM THE CERTIFIED LIST.
//
// PGE lists module options as "430W (Model Q.TRON BLK M-G2.C1+/AC)" — wattage first, model
// in parentheses. The CEC-certified name we resolve is "Q.TRON BLK M-G2.C1+/AC 430" —
// model first, wattage appended. NEITHER string contains the other, so an exact match and
// both contains-directions all miss.
//
// This test exists to find out whether that shape is ALREADY handled before writing a fix
// for it. bestOptionMatch has a digit-signature fallback (added for plan-set "ZXM7-UHLD108"
// vs certified "ZXM7-UHLDD108") that requires the leading alpha token plus every digit
// group — which this shape may well satisfy. Writing a second matcher for a case the first
// one already covers is how dead code gets added; the combobox cascade loop deleted earlier
// in this session was exactly that mistake.
//
// The decoys matter: a 405W sibling and a 430W model from a DIFFERENT series must not win.
//
// Run: npx tsx portal-bot/src/adapters/optionFormat.dom.smoke.ts
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

const WANT = "Q.TRON BLK M-G2.C1+/AC 430";          // what the CEC list gives us
const RIGHT = "430W (Model Q.TRON BLK M-G2.C1+/AC)"; // how PGE writes the same product

const PAGE = `<!doctype html><html><body>
  <h2 id="heading">System Information</h2>
  <label for="model">Model</label>
  <input id="model" role="combobox" readonly value="">
  <div id="popup" style="display:none">
    <ul id="popuplist">
      <li role="option">405W (Model Q.TRON BLK M-G2.C1+/AC)</li>
      <li role="option">430W (Model Q.TRON BLK M-G2.H+)</li>
      <li role="option">${RIGHT}</li>
      <li role="option">435W (Model Q.TRON BLK M-G2.C1+/AC)</li>
    </ul>
  </div>
  <script>
    document.getElementById('model').addEventListener('click', function () {
      document.getElementById('popup').style.display = 'block';
    });
    document.getElementById('popup').addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.getAttribute && t.getAttribute('role') === 'option') {
        document.getElementById('model').value = t.textContent;
        document.getElementById('popup').style.display = 'none';
      }
    });
  </script>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const recipe = {
  id: "of1", scopeType: "utility", profileKey: "or||pge", state: "OR", ahj: "", utility: "PGE",
  portalPlatform: "powerclerk", portalUrl: url, status: "complete", version: 1,
  steps: [{ action: "select", phase: "fill", selector: { css: "#model" }, field: "moduleModel", note: "Model" }] as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

const p1 = await context.newPage();
await p1.goto(url);
const a1 = new RecipeAdapter(recipe, { moduleModel: WANT, moduleModelCertified: WANT }, {}, { autoSubmit: false });
(a1 as unknown as { page: unknown }).page = p1;
const r1 = await a1.fillApplication({} as never);
const picked = await p1.locator("#model").inputValue().catch(() => "");

check("the wattage-first option format is matched", () => {
  assert.equal(picked, RIGHT,
    `picked ${JSON.stringify(picked)} for ${JSON.stringify(WANT)} (run ok=${r1.ok})`);
});
check("a same-series option at the WRONG wattage is not chosen", () => {
  assert.ok(!/^(405|435)W/.test(picked), `took a neighbouring wattage: ${JSON.stringify(picked)}`);
});
check("a same-wattage option from a DIFFERENT series is not chosen", () => {
  assert.ok(!/M-G2\.H\+/.test(picked), `took the wrong series: ${JSON.stringify(picked)}`);
});

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} option-format smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll option-format smoke tests passed (real Chromium).");
process.exit(0);
