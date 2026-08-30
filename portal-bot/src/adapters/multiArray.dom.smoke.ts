// A SYSTEM WITH FOUR ROOF PLANES MUST NOT BE FILED AS ONE.
//
// A learn records ONE array's worth of steps, because one PV Array row is what the portal
// renders on a fresh application. Real projects routinely have several. Measured on live
// data: Bren Trask has FOUR arrays (10 + 3 + 5 + 6 = 24 modules) and the PGE recipe LEARNED
// ON HIM types "10"; Randal Rowland has two (18 + 5 = 23) and gets 18. A 10.32 kW system
// was going to the utility as roughly 4.4 kW.
//
// Replay now repeats the recorded array block once per roof plane. Two things make that
// safe rather than a new way to corrupt data:
//
//   1. It only proceeds when the page CONFIRMS a row was added (each PV Array carries its
//      own "Delete Array", so the rows are countable). A silently-failed add would put
//      array 2's numbers into array 1's controls — the identical invisible overwrite as
//      the Preparer/Customer bug.
//   2. Repeat passes target the Nth copy of each control, not the recorded first one.
//
// The fixture includes a "Clone System" decoy beside the array-level "Clone", because
// PowerClerk shows both and cloning the SYSTEM on a live application is a real hazard.
//
// Run: npx tsx portal-bot/src/adapters/multiArray.dom.smoke.ts
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

// `clonable` off = the portal offers no way to add a row (the must-not-overwrite case).
const page = (clonable: boolean): string => `<!doctype html><html><body>
  <h2 id="heading">System Information</h2>
  <div id="arrays"></div>
  ${clonable ? '<button id="clone" type="button">Clone</button>' : ""}
  <button id="clonesys" type="button">Clone System</button>
  <script>
    var n = 0;
    function addRow() {
      n++;
      var d = document.createElement('div');
      d.className = 'arrayrow';
      // Labels must be ASSOCIATED with their inputs (for/id): the extractor reads labels
      // that way, and the drift guard compares them against the recipe's.
      d.innerHTML =
        '<a class="del">Delete Array</a>' +
        '<label for="qty' + n + '">Qty</label><input class="qty" id="qty' + n + '">' +
        '<label for="tilt' + n + '">Tilt</label><input class="tilt" id="tilt' + n + '">' +
        '<label for="azi' + n + '">Azimuth</label><input class="azi" id="azi' + n + '">';
      document.getElementById('arrays').appendChild(d);
    }
    addRow(); // a fresh application renders exactly one
    var c = document.getElementById('clone');
    if (c) c.addEventListener('click', addRow);
    // The decoy must be harmless if mis-clicked, and must NOT add an array row.
    document.getElementById('clonesys').addEventListener('click', function () {
      window.__clonedSystem = (window.__clonedSystem || 0) + 1;
    });
  </script>
</body></html>`;

const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(page(!String(q.url ?? "").startsWith("/norow")));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const mkRecipe = (url: string) => ({
  id: "ma1", scopeType: "utility", profileKey: "or||pge", state: "OR", ahj: "", utility: "PGE",
  portalPlatform: "powerclerk", portalUrl: url, status: "complete", version: 1,
  steps: [
    { action: "fill", phase: "fill", selector: { css: ".qty" }, field: "array1ModuleQuantity", note: "Qty" },
    { action: "fill", phase: "fill", selector: { css: ".tilt" }, field: "array1Tilt", note: "Tilt" },
    { action: "fill", phase: "fill", selector: { css: ".azi" }, field: "array1Azimuth", note: "Azimuth" },
  ] as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

// Bren Trask, exactly as the live data resolves.
const FIELDS: Record<string, string> = {
  array1ModuleQuantity: "10", array1Tilt: "22", array1Azimuth: "270",
  array2ModuleQuantity: "3", array2Tilt: "17", array2Azimuth: "180",
  array3ModuleQuantity: "5", array3Tilt: "17", array3Azimuth: "90",
  array4ModuleQuantity: "6", array4Tilt: "22", array4Azimuth: "270",
  totalModuleQuantity: "24",
};

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

// CASE 1 — four roof planes, and the portal can add rows.
const p1 = await context.newPage();
await p1.goto(`${base}/`);
const a1 = new RecipeAdapter(mkRecipe(`${base}/`), FIELDS, {}, { autoSubmit: false });
(a1 as unknown as { page: unknown }).page = p1;
const r1 = await a1.fillApplication({} as never);
const rows = await p1.evaluate(() => Array.from(document.querySelectorAll(".arrayrow")).map((d) => ({
  qty: (d.querySelector(".qty") as HTMLInputElement).value,
  tilt: (d.querySelector(".tilt") as HTMLInputElement).value,
  azi: (d.querySelector(".azi") as HTMLInputElement).value,
})));
const clonedSystem = await p1.evaluate(() => (window as unknown as { __clonedSystem?: number }).__clonedSystem ?? 0);

check("one row per roof plane", () => {
  assert.equal(rows.length, 4, `expected 4 array rows, got ${rows.length}: ${JSON.stringify(rows)}`);
});
check("every array carries its OWN numbers", () => {
  assert.deepEqual(rows, [
    { qty: "10", tilt: "22", azi: "270" },
    { qty: "3", tilt: "17", azi: "180" },
    { qty: "5", tilt: "17", azi: "90" },
    { qty: "6", tilt: "22", azi: "270" },
  ], `got ${JSON.stringify(rows)}`);
});
check("the whole system was never cloned", () => {
  assert.equal(clonedSystem, 0, '"Clone System" was clicked — that duplicates the entire generating system');
});
check("the run still completes", () => {
  assert.equal(r1.ok, true, `${String(r1.message ?? "").slice(0, 200)}`);
});

// CASE 2 — THE SAFETY CASE. No way to add a row: array 1 must keep ITS OWN numbers and the
// run must say so, rather than quietly overwriting them with array 2's.
const p2 = await context.newPage();
await p2.goto(`${base}/norow`);
const a2 = new RecipeAdapter(mkRecipe(`${base}/norow`), FIELDS, {}, { autoSubmit: false });
(a2 as unknown as { page: unknown }).page = p2;
const r2 = await a2.fillApplication({} as never);
const only = await p2.evaluate(() => Array.from(document.querySelectorAll(".arrayrow")).map((d) => ({
  qty: (d.querySelector(".qty") as HTMLInputElement).value,
  tilt: (d.querySelector(".tilt") as HTMLInputElement).value,
})));
const warnings = ((r2 as unknown as { data?: { driftWarnings?: string[] } }).data?.driftWarnings ?? []).join(" | ");

check("array 1 keeps its own numbers when no row can be added", () => {
  assert.equal(only.length, 1, `got ${only.length} rows`);
  assert.deepEqual(only[0], { qty: "10", tilt: "22" },
    `array 1 was overwritten by a later array — ${JSON.stringify(only[0])}`);
});
check("and the shortfall is reported, not swallowed", () => {
  assert.match(warnings, /filed array 1 only/i, `warnings were: ${warnings.slice(0, 300)}`);
  assert.match(warnings, /10 of 24 modules/i, `the warning should name the shortfall; got: ${warnings.slice(0, 300)}`);
});

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} multi-array smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll multi-array smoke tests passed (real Chromium).");
process.exit(0);
