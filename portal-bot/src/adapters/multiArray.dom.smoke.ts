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

// CASE 3 FIXTURE — PowerClerk's actual shape, which the plain fixture above does not
// model and which is exactly where a live Rowland replay corrupted its own arrays:
//   - values COMMIT on blur (per-field autosave); "Add Array" posts and RE-RENDERS the
//     whole section from server state with fresh ids, so an uncommitted value is gone;
//   - each array row carries its own Manufacturer/Model CASCADE (model list loads after
//     the manufacturer changes), and an inverter Manufacturer/Model pair sits above with
//     byte-identical labels;
//   - the recorded steps interleave a battery fill and a duplicate inverter pair BETWEEN
//     the array fields, so the block-bounds sweep them in.
const pclerkPage = (): string => `<!doctype html><html><body>
  <h2>Generation System Information</h2>
  <div id="section"></div>
  <script>
    var MODELS = {
      "Altenergy Power System": ["0.8 kW (Model DS3-L {240V} [SI1])", "0.8 kW (Model DS3-LV {120V} [SI1])"],
      "Znshine PV-Tech": ["440W (Model ZXM7-UHLDD108-440/N)", "430W (Model ZXM7-UHLDD108-430/N)"]
    };
    var MAKES = ["Altenergy Power System", "Znshine PV-Tech", "Tesla"];
    var server = { rows: [{}] }; // committed state; one array row on a fresh application
    var render = 0;
    function selectHtml(id, options, current) {
      var h = '<select id="' + id + '"><option>Please select...</option>';
      for (var i = 0; i < options.length; i++) {
        h += '<option' + (options[i] === current ? ' selected' : '') + '>' + options[i] + '</option>';
      }
      return h + '</select>';
    }
    function renderSection() {
      render++;
      var h = '<div><label for="invMfr' + render + '">Manufacturer</label>'
        + selectHtml('invMfr' + render, MAKES, server.invMfr)
        + '<label for="invModel' + render + '">Model</label>'
        + selectHtml('invModel' + render, server.invMfr ? MODELS[server.invMfr] || [] : [], server.invModel)
        + '</div>';
      for (var i = 0; i < server.rows.length; i++) {
        var row = server.rows[i];
        var rid = render + '_' + i;
        h += '<div class="arrayrow"><a class="del">Delete Array</a>'
          + '<label for="qty' + rid + '">Qty</label><input class="qty" id="qty' + rid + '" value="' + (row.qty || '') + '">'
          + '<label for="mfr' + rid + '">Manufacturer</label>' + selectHtml('mfr' + rid, MAKES, row.mfr)
          + '<label for="model' + rid + '">Model</label>' + selectHtml('model' + rid, row.mfr ? MODELS[row.mfr] || [] : [], row.model)
          + '<label for="tilt' + rid + '">Tilt</label><input class="tilt" id="tilt' + rid + '" value="' + (row.tilt || '') + '">'
          + '<label for="azi' + rid + '">Azimuth</label><input class="azi" id="azi' + rid + '" value="' + (row.azi || '') + '">'
          + '</div>';
      }
      // Section-level controls render INSIDE the section, below the rows — as PacifiCorp
      // lays them out. Their placement matters twice: the battery label CONTAINS
      // "Manufacturer" so its position decides what a bare {label:"Manufacturer", nth:N}
      // ranks against, and "Add Array" is what bounds the held-check's row-container
      // climb on a single-row page.
      h += '<button id="addarray" type="button">Add Array</button>'
        + '<button id="clonesys" type="button">Clone System</button>'
        + '<button id="calc" type="button">Calculate</button>'
        + '<div><label for="batt' + render + '">Battery Manufacturer</label><input id="batt' + render + '" value="' + (server.batt || '') + '"></div>';
      document.getElementById('section').innerHTML = h;
      document.getElementById('addarray').addEventListener('click', function () {
        // The live behavior that broke replay: the ADD posts, the server gains an empty
        // row, and the whole section re-renders from COMMITTED state with fresh ids.
        server.rows.push({});
        renderSection();
      });
      document.getElementById('calc').addEventListener('click', function () { renderSection(); });
      document.getElementById('clonesys').addEventListener('click', function () {
        window.__clonedSystem = (window.__clonedSystem || 0) + 1;
      });
      wire();
    }
    function commit(el) {
      var id = el.id || '';
      var val = el.tagName === 'SELECT'
        ? (el.selectedIndex > 0 ? el.options[el.selectedIndex].textContent : '')
        : el.value;
      var m = /^(qty|mfr|model|tilt|azi)\\d+_(\\d+)$/.exec(id);
      if (m) {
        var key = { qty: 'qty', mfr: 'mfr', model: 'model', tilt: 'tilt', azi: 'azi' }[m[1]];
        server.rows[Number(m[2])][key] = val;
        return;
      }
      if (/^invMfr/.test(id)) server.invMfr = val;
      else if (/^invModel/.test(id)) server.invModel = val;
      else if (/^batt/.test(id)) server.batt = val;
    }
    function wire() {
      var els = document.getElementById('section').querySelectorAll('input, select');
      for (var i = 0; i < els.length; i++) {
        (function (el) {
          // Commit on BLUR only — PowerClerk's per-field autosave. A change that never
          // blurs is visible in the DOM and absent from the server.
          el.addEventListener('blur', function () { commit(el); });
          if (el.tagName === 'SELECT') {
            el.addEventListener('change', function () {
              // The manufacturer cascade: repopulate the sibling model list ~250ms later.
              var mm = /^mfr(\\d+_\\d+)$/.exec(el.id) || /^invMfr(\\d+)$/.exec(el.id);
              if (!mm) return;
              var make = el.selectedIndex > 0 ? el.options[el.selectedIndex].textContent : '';
              var target = document.getElementById(el.id.replace(/^mfr/, 'model').replace(/^invMfr/, 'invModel'));
              if (!target) return;
              setTimeout(function () {
                var opts = MODELS[make] || [];
                var h = '<option>Please select...</option>';
                for (var k = 0; k < opts.length; k++) h += '<option>' + opts[k] + '</option>';
                target.innerHTML = h;
              }, 250);
            });
          }
        })(els[i]);
      }
    }
    window.__server = server;
    renderSection();
  </script>
</body></html>`;

const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  const url = String(q.url ?? "");
  r.end(url.startsWith("/pclerk") ? pclerkPage() : page(!url.startsWith("/norow")));
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

// CASE 3 — POWERCLERK'S SHAPE. Everything below was measured failing on a live Rowland
// replay (2026-08-30): the recorded block carries battery + duplicate inverter steps
// between the array fields; every label is a bare "Manufacturer"/"Model"; selects commit
// on blur only; and Add Array re-renders the section from server state. Mutation notes:
//   - without the foreign-step skip, pass 2's inverter steps land on array 1's controls
//     (identical labels — no re-anchor guard can see it) → the array-values asserts fail;
//   - without the fallback-nth shift, pass 2 refills array 1 with array 2's numbers and
//     array 2 stays empty (the live run filed qty 5 / tilt 3 into row 1) → same asserts;
//   - without the select blur-commit, the row-add re-render reverts every select to its
//     placeholder server-side → the committed-state asserts fail.
const mkPclerkRecipe = (url: string) => ({
  id: "ma3", scopeType: "utility", profileKey: "or||pacific-power", state: "OR", ahj: "", utility: "Pacific Power",
  portalPlatform: "powerclerk", portalUrl: url, status: "complete", version: 1,
  steps: [
    // Learn-time volatile ids never resolve at replay — the label fallbacks (with the
    // rank each control held on the ONE-ROW learn page) are what actually fires.
    { action: "fill", phase: "fill", selector: { css: "#learnQty", fallbacks: [{ label: "Qty", nth: 0 }] }, field: "array1ModuleQuantity", note: "pv array quantity" },
    { action: "fill", phase: "fill", selector: { css: "#learnBatt", fallbacks: [{ label: "Battery Manufacturer" }] }, field: "batteryManufacturer", note: "Battery Manufacturer" },
    { action: "select", phase: "fill", selector: { css: "#learnInvMfr", fallbacks: [{ label: "Manufacturer", nth: 0 }] }, field: "inverterMake", note: "Manufacturer" },
    { action: "select", phase: "fill", selector: { css: "#learnInvModel", fallbacks: [{ label: "Model", nth: 0 }] }, field: "inverterModel", note: "Model" },
    { action: "select", phase: "fill", selector: { css: "#learnMfr", fallbacks: [{ label: "Manufacturer", nth: 1 }] }, field: "moduleMake", note: "Manufacturer" },
    { action: "select", phase: "fill", selector: { css: "#learnModel", fallbacks: [{ label: "Model", nth: 1 }] }, field: "moduleModel", note: "Model" },
    { action: "fill", phase: "fill", selector: { css: "#learnTilt", fallbacks: [{ label: "Tilt", nth: 0 }] }, field: "array1Tilt", note: "Tilt" },
    { action: "fill", phase: "fill", selector: { css: "#learnAzi", fallbacks: [{ label: "Azimuth", nth: 0 }] }, field: "array1Azimuth", note: "Azimuth" },
  ] as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

// Randal Rowland, as the live data resolves: two roof planes, 18 + 5 modules.
const PCLERK_FIELDS: Record<string, string> = {
  array1ModuleQuantity: "18", array1Tilt: "22", array1Azimuth: "270",
  array2ModuleQuantity: "5", array2Tilt: "3", array2Azimuth: "180",
  totalModuleQuantity: "23",
  inverterMake: "Altenergy Power System", inverterModel: "0.8 kW (Model DS3-L {240V} [SI1])",
  moduleMake: "Znshine PV-Tech", moduleModel: "440W (Model ZXM7-UHLDD108-440/N)",
  batteryManufacturer: "Tesla",
};

const p3 = await context.newPage();
await p3.goto(`${base}/pclerk`);
const a3 = new RecipeAdapter(mkPclerkRecipe(`${base}/pclerk`), PCLERK_FIELDS, {}, { autoSubmit: false });
(a3 as unknown as { page: unknown }).page = p3;
const r3 = await a3.fillApplication({} as never);
// Read the COMMITTED (server) state, not the DOM: a value the portal never autosaved is a
// value the application does not have, however filled the page looks.
const committed = await p3.evaluate(() => (window as unknown as { __server: { rows: Array<Record<string, string>>; invMfr?: string; invModel?: string; batt?: string } }).__server);

check("powerclerk: the run completes", () => {
  assert.equal(r3.ok, true, String(r3.message ?? "").slice(0, 300));
});
check("powerclerk: two rows, each with its OWN committed numbers", () => {
  assert.equal(committed.rows.length, 2, `expected 2 rows, got ${JSON.stringify(committed.rows)}`);
  assert.equal(committed.rows[0].qty, "18", `array 1 qty overwritten: ${JSON.stringify(committed.rows[0])}`);
  assert.equal(committed.rows[0].tilt, "22", `array 1 tilt overwritten: ${JSON.stringify(committed.rows[0])}`);
  assert.equal(committed.rows[1].qty, "5", `array 2 qty missing: ${JSON.stringify(committed.rows[1])}`);
  assert.equal(committed.rows[1].azi, "180", `array 2 azimuth missing: ${JSON.stringify(committed.rows[1])}`);
});
check("powerclerk: both module selects committed and SURVIVED the row-add re-render", () => {
  assert.equal(committed.rows[0].mfr, "Znshine PV-Tech", `array 1 manufacturer not committed: ${JSON.stringify(committed.rows[0])}`);
  assert.match(String(committed.rows[0].model ?? ""), /ZXM7-UHLDD108-440\/N/, `array 1 model not committed: ${JSON.stringify(committed.rows[0])}`);
  assert.equal(committed.rows[1].mfr, "Znshine PV-Tech", `array 2 manufacturer not committed: ${JSON.stringify(committed.rows[1])}`);
  assert.match(String(committed.rows[1].model ?? ""), /ZXM7-UHLDD108-440\/N/, `array 2 model not committed: ${JSON.stringify(committed.rows[1])}`);
});
check("powerclerk: the inverter kept ITS make — no array pass wrote into it", () => {
  assert.equal(committed.invMfr, "Altenergy Power System", `inverter manufacturer: ${committed.invMfr}`);
  assert.match(String(committed.invModel ?? ""), /DS3-L \{240V\}/, `inverter model: ${committed.invModel}`);
});
check("powerclerk: no array row was given the INVERTER's make", () => {
  for (const row of committed.rows) {
    assert.notEqual(row.mfr, "Altenergy Power System", `an inverter make landed in an array row: ${JSON.stringify(committed.rows)}`);
  }
});
check("powerclerk: the battery fill committed once and stayed", () => {
  assert.equal(committed.batt, "Tesla", `battery manufacturer: ${committed.batt}`);
});

// CASE 4 — ONE ROOF PLANE on the same PowerClerk shape: the COMMON project. With a single
// "Delete Array" marker, "the largest ancestor containing exactly one marker" is true all
// the way up the page — the held-check's row container ballooned to the whole section and
// read the INVERTER's Manufacturer for the module step (a filled inverter then blessed a
// reverted module select, and a deliberately-blank inverter model false-alarmed a repair).
// The climb now stops at the section-level controls; this case pins that on 1 marker.
const SINGLE_FIELDS: Record<string, string> = {
  array1ModuleQuantity: "18", array1Tilt: "22", array1Azimuth: "270",
  totalModuleQuantity: "18",
  // The inverter MODEL is deliberately one the portal does not list: the ambiguity guard
  // leaves it blank for the human ("left blank for review"). A ballooned row container
  // reads THAT blank inverter select for the module-model step — the label is the same
  // bare "Model" — and false-alarms "did not hold" on a correctly filled array row.
  inverterMake: "Altenergy Power System", inverterModel: "9.9 kW (Model NOPE-1)",
  moduleMake: "Znshine PV-Tech", moduleModel: "440W (Model ZXM7-UHLDD108-440/N)",
  batteryManufacturer: "Tesla",
};
const p4 = await context.newPage();
await p4.goto(`${base}/pclerk`);
const a4 = new RecipeAdapter(mkPclerkRecipe(`${base}/pclerk`), SINGLE_FIELDS, {}, { autoSubmit: false });
(a4 as unknown as { page: unknown }).page = p4;
const r4 = await a4.fillApplication({} as never);
const committed4 = await p4.evaluate(() => (window as unknown as { __server: { rows: Array<Record<string, string>>; invMfr?: string } }).__server);
const r4blanks = ((r4 as unknown as { data?: { requiredStillEmpty?: string[] } }).data?.requiredStillEmpty ?? []).join(" | ");

check("powerclerk single-array: the run completes with the row committed", () => {
  assert.equal(r4.ok, true, String(r4.message ?? "").slice(0, 300));
  assert.equal(committed4.rows.length, 1, `expected 1 row: ${JSON.stringify(committed4.rows)}`);
  assert.equal(committed4.rows[0].mfr, "Znshine PV-Tech", `module manufacturer not committed: ${JSON.stringify(committed4.rows[0])}`);
  assert.equal(committed4.rows[0].qty, "18", `qty not committed: ${JSON.stringify(committed4.rows[0])}`);
});
check("powerclerk single-array: no false 'did not hold' alarm from reading the wrong section", () => {
  assert.doesNotMatch(r4blanks, /did not hold/i, `false held-check alarm on a correctly filled page: ${r4blanks.slice(0, 200)}`);
});

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} multi-array smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll multi-array smoke tests passed (real Chromium).");
process.exit(0);
