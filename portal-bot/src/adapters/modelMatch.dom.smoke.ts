// A PLAN SET'S MODEL IS A PREFIX OF THE PORTAL'S LISTING.
// Utility portals load their equipment dropdowns from the CEC list, whose model strings
// carry suffixes a plan set does not. Taken verbatim from the synced CEC data (24,498 rows)
// against the four makes these projects actually use:
//
//   plan set "Q.MI.349B-G1"           CEC "Q.MI.349B-G1 {240V}"
//   plan set "ZXM7-SH108-410M"        CEC "ZXM7-SH108-410/M"
//   plan set "DS3-L"                  CEC "DS3-L {240V}"  AND  "DS3-LV {120V}"
//   plan set "Q.TRON BLK M-G2.C1+/AC" CEC ...415 / 420 / 425 / 430 / 435 / 440
//
// So exact matching misses, a naive contains-match picks DS3-LV as readily as DS3-L, and
// the six QCELLS wattages can only be told apart by the project's own module wattage.
// Measured live: two Model selects were skipped while holding perfectly good values, on a
// replay that otherwise completed.
//
// Run: npx tsx portal-bot/src/adapters/modelMatch.dom.smoke.ts
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

const PAGE = `<!doctype html><html><body>
  <h2>Equipment</h2>
  <label for="invModel">Model</label>
  <select id="invModel">
    <option value="">Please select...</option>
    <option>DS3-LV {120V}</option>
    <option>DS3-L {240V}</option>
  </select>
  <label for="modModel">Model</label>
  <select id="modModel">
    <option value="">Please select...</option>
    <option>Q.TRON BLK M-G2.C1+/AC 415</option>
    <option>Q.TRON BLK M-G2.C1+/AC 425</option>
    <option>Q.TRON BLK M-G2.C1+/AC 440</option>
  </select>
  <label for="znModel">Model</label>
  <select id="znModel">
    <option value="">Please select...</option>
    <option>ZXM7-SH108-410/M</option>
  </select>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const steps: RecipeStep[] = [
  { action: "goto", phase: "open", value: url, note: "entry url" },
  { action: "select", phase: "fill", selector: { css: "#invModel" }, field: "inverterModel", note: "Model" },
  { action: "select", phase: "fill", selector: { css: "#modModel" }, field: "moduleModel", note: "Model" },
  { action: "select", phase: "fill", selector: { css: "#znModel" }, field: "moduleModel2", note: "Model" },
];
const recipe = {
  id: "mm1", scopeType: "utility", profileKey: "or||pacific power", state: "OR", ahj: "", utility: "Pacific Power",
  portalPlatform: "powerclerk", portalUrl: url, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe;

// Exactly what a plan set yields — no CEC suffixes anywhere.
const fieldValues = {
  inverterModel: "DS3-L",
  moduleModel: "Q.TRON BLK M-G2.C1+/AC",
  moduleModel2: "ZXM7-SH108-410M",
  moduleWattage: "425",
  // No "*Certified" keys here ON PURPOSE. The backend normally resolves those from the CEC
  // list, and replay prefers them; omitting them keeps this test exercising the PAGE-SIDE
  // rules, which are what remain when the CEC table is unsynced (it holds zero rows until
  // the server has run once) or when the choice was ambiguous server-side.
};

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
const adapter = new RecipeAdapter(recipe, fieldValues, {}, { autoSubmit: false });
(adapter as unknown as { page: unknown }).page = page;
await adapter.fillApplication({} as never);

const val = async (sel: string): Promise<string> => page.locator(sel).inputValue().catch(() => "");
const inv = await val("#invModel");
const mod = await val("#modModel");
const zn = await val("#znModel");

check("a suffixed listing is matched from the plan set's prefix", () => {
  assert.equal(inv, "DS3-L {240V}", `inverter model: got ${JSON.stringify(inv)}`);
});
check("and NEVER the longer lookalike — DS3-L must not select DS3-LV", () => {
  assert.notEqual(inv, "DS3-LV {120V}", "a contains-match would take the 120V unit and file the wrong inverter");
});
check("the project's WATTAGE picks between otherwise identical options", () => {
  assert.equal(mod, "Q.TRON BLK M-G2.C1+/AC 425", `six options differ only by wattage; got ${JSON.stringify(mod)}`);
});
check("a punctuation-only difference still matches", () => {
  // "ZXM7-SH108-410M" vs the CEC's "ZXM7-SH108-410/M".
  assert.equal(zn, "ZXM7-SH108-410/M", `got ${JSON.stringify(zn)}`);
});

await browser.close();
server.close();
if (failures > 0) { console.error(`\n${failures} model-match smoke test(s) FAILED.`); process.exit(1); }
console.log("\nAll model-match smoke tests passed (real Chromium).");
process.exit(0);
