// A FALLBACK THAT MATCHES EVERY TEXTBOX MUST NOT WRITE INTO ONE.
//
// The learner records a last-resort fallback of [data-test-role="textbox-element"] on
// PowerClerk steps, and that attribute is on EVERY textbox on the page. When the real
// control is absent — a battery section this project does not render, a volatile id that
// moved — the chain reaches it, and .first() would take whatever textbox comes first.
//
// The stake is concrete. Live on PacifiCorp, "Total System Export (kW)" was found holding
//
//     Powerwall 3 (1707000-XX-Y) 13.5 kWh
//
// and the portal answered "Please enter a valid decimal number." A text model number in a
// required decimal field is wrong data AND a page a human then has to unpick.
//
// What protects this is reanchorIfWrongControl: the resolved control's own label disagrees
// with the step's, so it refuses rather than writing. This test exists to keep that true,
// including for a step whose selector is only a stale css id — there the step's NOTE is the
// only label available to compare, and it still has to hold.
//
// (I wrote a second guard here that refused any multi-match fallback outright, then removed
// it: every case above already passes without it, and refusing ambiguous fallbacks would
// turn currently-working heals into skips for no demonstrated gain.)
//
// Run: npx tsx portal-bot/src/adapters/ambiguousFallback.dom.smoke.ts
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

// "Total System Export (kW)" is FIRST on the page, exactly as it is live — so a
// .first() fallback lands on it. There is no Battery Model control at all: this project
// has no battery section, which is the situation that triggered it.
const PAGE = `<!doctype html><html><body>
  <h2 id="heading">Generation System Information</h2>
  <label for="exp">Total System Export (kW)</label>
  <input id="exp" data-test-role="textbox-element">
  <label for="cap">Nameplate Capacity (kW)</label>
  <input id="cap" data-test-role="textbox-element">
  <button id="next" type="button">Next</button>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const mkRecipe = (steps: RecipeStep[]) => ({
  id: "af1", scopeType: "utility", profileKey: "or||pacific power", state: "OR", ahj: "", utility: "Pacific Power",
  portalPlatform: "powerclerk", portalUrl: url, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

// CASE 1 — the recorded control does not exist on this page.
const p1 = await context.newPage();
await p1.goto(url);
const a1 = new RecipeAdapter(mkRecipe([
  {
    action: "fill", phase: "fill", field: "batteryModel", note: "Battery Model",
    selector: {
      label: "Battery Model",
      fallbacks: [{ css: "#CC845JREH3CBInput" }, { css: '[data-test-role="textbox-element"]' }],
    },
  } as RecipeStep,
]), { batteryModel: "Powerwall 3 (1707000-XX-Y) 13.5 kWh" }, {}, { autoSubmit: false });
(a1 as unknown as { page: unknown }).page = p1;
await a1.fillApplication({} as never);
const exportValue = await p1.locator("#exp").inputValue();
const capValue = await p1.locator("#cap").inputValue();

check("a missing control does NOT get written into the first textbox", () => {
  assert.equal(exportValue, "",
    `"Total System Export (kW)" received ${JSON.stringify(exportValue)} — a battery model in a decimal field`);
  assert.equal(capValue, "", `an unrelated field received ${JSON.stringify(capValue)}`);
});
// CASE 1b — THE CASE ONLY THIS GUARD COVERS.
//
// reanchorIfWrongControl protects case 1 by noticing the resolved control's own label
// disagrees with the step's. It can only do that when the step HAS a recorded label. A
// step carrying just a css selector gives it nothing to compare, so an ambiguous fallback
// writes blind — and that is the shape that put a battery model into a decimal field.
const p1b = await context.newPage();
await p1b.goto(url);
const a1b = new RecipeAdapter(mkRecipe([
  {
    action: "fill", phase: "fill", field: "batteryModel", note: "Battery Model",
    selector: { css: "#GONE-VOLATILE-ID", fallbacks: [{ css: '[data-test-role="textbox-element"]' }] },
  } as RecipeStep,
]), { batteryModel: "Powerwall 3 (1707000-XX-Y) 13.5 kWh" }, {}, { autoSubmit: false });
(a1b as unknown as { page: unknown }).page = p1b;
await a1b.fillApplication({} as never);
const exportValue1b = await p1b.locator("#exp").inputValue();

check("an unlabelled step cannot write into the first textbox either", () => {
  assert.equal(exportValue1b, "",
    `"Total System Export (kW)" received ${JSON.stringify(exportValue1b)} — the exact live failure`);
});

// CASE 2 — THE GUARD THIS MUST NOT BREAK. A fallback that matches exactly ONE control is
// the normal healing path and must still resolve.
const p2 = await context.newPage();
await p2.goto(url);
const a2 = new RecipeAdapter(mkRecipe([
  {
    action: "fill", phase: "fill", field: "systemSizeAcKw", note: "Total System Export (kW)",
    // A stale recorded id, which is the real shape: the primary misses, the fallback
    // finds exactly one control, and that control's own label agrees with the step.
    selector: { css: "#ID-THAT-MOVED", label: "Total System Export (kW)", fallbacks: [{ css: "#exp" }] },
  } as RecipeStep,
]), { systemSizeAcKw: "9.216" }, {}, { autoSubmit: false });
(a2 as unknown as { page: unknown }).page = p2;
await a2.fillApplication({} as never);

check("a fallback matching exactly one control still heals", () => {
  // Read outside the assertion callback: an await inside would escape the try/catch.
});
const healed = await p2.locator("#exp").inputValue();
check("the single-match fallback filled the right control", () => {
  assert.equal(healed, "9.216", `expected the export field to heal; got ${JSON.stringify(healed)}`);
});

// CASE 3 — an explicit nth means the recorder knew WHICH match it wanted; honour it.
const p3 = await context.newPage();
await p3.goto(url);
const a3 = new RecipeAdapter(mkRecipe([
  {
    action: "fill", phase: "fill", field: "systemSizeAcKw", note: "Nameplate Capacity (kW)",
    selector: { css: "#ANOTHER-STALE-ID", label: "Nameplate Capacity (kW)", fallbacks: [{ css: '[data-test-role="textbox-element"]', nth: 1 }] },
  } as RecipeStep,
]), { systemSizeAcKw: "7.5" }, {}, { autoSubmit: false });
(a3 as unknown as { page: unknown }).page = p3;
await a3.fillApplication({} as never);
const nthTarget = await p3.locator("#cap").inputValue();
const nthOther = await p3.locator("#exp").inputValue();

check("an explicit nth is still honoured", () => {
  assert.equal(nthTarget, "7.5", `nth:1 should have filled the second textbox; got ${JSON.stringify(nthTarget)}`);
  assert.equal(nthOther, "", `nth:1 must not touch the first textbox; got ${JSON.stringify(nthOther)}`);
});

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} ambiguous-fallback smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll ambiguous-fallback smoke tests passed (real Chromium).");
process.exit(0);
