// THE DISAMBIGUATOR WAS IN THE RECIPE ALL ALONG.
//
// PGE and PacifiCorp both fail their inverter "Model" step, and the reason looked for most of
// a day like missing information: PowerClerk's spec block renders the inverter's
// Manufacturer/Model and the PV array's with identical bare labels, so a label selector
// cannot tell them apart, and the recorded primary is a per-render id that goes stale.
//
// It was not missing. The learner records it on every such step:
//
//   inverterModel  fingerprint: { ariaLabel: "Model", section: "Inverter Clone System" }
//   moduleModel    fingerprint: { ariaLabel: "Model", section: "PV ArrayDelete Array" }
//
// Written every time and read never — the selector rebuild for duplicate labels constructs a
// fresh object around the element id and drops the section, so resolution had been choosing
// between identical labels on position and visibility alone. Four fixes went into that choice
// before anyone looked at what the recipe already carried.
//
// The page below is that shape: two "Model" selects in differently-titled panels, with the
// inverter's recorded id now pointing at a CONCEALED input (opacity:0, which is how a portal
// hides a native control behind a styled widget — and which Playwright calls visible).
//   npx tsx portal-bot/src/adapters/sectionDisambiguation.dom.smoke.ts
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

const PAGE = `<!doctype html><html><head><style>
  body { font: 14px sans-serif; padding: 16px; }
  .panel { border: 1px solid #bbb; padding: 12px; margin: 12px 0; }
  .concealed { opacity: 0; position: absolute; }
</style></head><body>
  <div class="panel">
    <h3 class="panel-title">Inverter Clone System</h3>
    <label for="inv-make">Manufacturer</label>
    <select id="inv-make"><option>Enphase Energy, Inc.</option></select>
    <!-- The recorded id, now a concealed shadow of the real control. Playwright calls this
         VISIBLE, which is exactly why the acceptance gate kept taking it. -->
    <label for="pcInputBase34">Model</label>
    <select id="pcInputBase34" class="concealed"><option>Select...</option></select>
    <label for="inv-model-real">Model</label>
    <select id="inv-model-real">
      <option>Select...</option><option>IQ8PLUS-72-2-US {240V}</option>
    </select>
  </div>
  <div class="panel">
    <h3 class="panel-title">PV ArrayDelete Array</h3>
    <label for="mod-model">Model</label>
    <select id="mod-model">
      <option>Select...</option><option>Q.PEAK DUO BLK ML-G10 400</option>
    </select>
  </div>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const recipe = {
  id: "sd1", scopeType: "utility", profileKey: "or|unknown|portland general electric", state: "OR",
  ahj: "", utility: "Portland General Electric", portalPlatform: "powerclerk", portalUrl: url,
  status: "complete", version: 1,
  steps: [
    // Exactly as recorded live, fingerprint and all.
    {
      action: "select", phase: "fill", field: "inverterModel", note: "Model",
      selector: { css: "#pcInputBase34", fallbacks: [{ label: "Model", nth: 0 }] },
      fingerprint: { id: "pcInputBase34", ariaLabel: "Model", section: "Inverter Clone System" },
    },
  ] as unknown as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(url);

const adapter = new RecipeAdapter(recipe, { inverterModel: "IQ8PLUS-72-2-US {240V}" }, {}, { autoSubmit: false });
(adapter as unknown as { page: unknown }).page = page;

const res = await adapter.fillApplication({} as never);
const data = (res as unknown as { data?: { driftWarnings?: string[]; skipped?: string[] } }).data ?? {};
const realValue = await page.locator("#inv-model-real").inputValue().catch(() => "");
const moduleValue = await page.locator("#mod-model").inputValue().catch(() => "");
console.log(`   inverter Model = ${JSON.stringify(realValue)}; PV array Model = ${JSON.stringify(moduleValue)}`);
console.log(`   drift: ${JSON.stringify((data.driftWarnings ?? []).slice(0, 2))}`);

check("THE REGRESSION: the inverter Model lands, not the concealed namesake", () => {
  assert.match(realValue, /IQ8PLUS/,
    `the visible inverter Model is still empty — resolution took the concealed control again`);
});

check("...and the PV ARRAY's Model is untouched, which is the whole point of the section", () => {
  assert.equal(moduleValue, "Select...",
    `the array's Model was written with the inverter's value (${JSON.stringify(moduleValue)}) — the two sections were conflated`);
});

check("...and it says it resolved by section, so the stale recipe can be re-recorded", () => {
  assert.ok((data.driftWarnings ?? []).some((w) => /by SECTION/i.test(w)), JSON.stringify(data.driftWarnings));
});

check("the step is not reported as a miss", () => {
  assert.ok(!(data.skipped ?? []).some((s) => /^Model$/i.test(s)), JSON.stringify(data.skipped));
});

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} section-disambiguation check(s) FAILED.`); process.exit(1); }
console.log("\nAll section-disambiguation checks passed (real Chromium).");
process.exit(0);
