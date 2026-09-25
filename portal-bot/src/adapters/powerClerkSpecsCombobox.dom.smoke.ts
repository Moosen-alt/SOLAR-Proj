// REAL-BROWSER smoke for the ACTUAL live PowerClerk "System Information" widget shape
// (captured 2026-08 from pgenm.powerclerk.com, project PGENM-43830). Unlike the sibling
// powerClerkSpecs.dom.smoke.ts — which modelled make/model as native <select> — the live
// portal renders each Manufacturer/Model as a Vue "filtered select": a READONLY
// <input role="combobox" aria-haspopup="listbox" aria-label="Manufacturer" class="visually-hidden">
// whose options live in a separate aria-controls listbox that opens on click and AJAX-loads
// the dependent model list ~600ms after the manufacturer changes. Classified as a text field
// it gets loc.fill()'d — which THROWS on the readonly input and drops the value silently (the
// live specs-page stall). This proves the extraction routes a role=combobox control through the
// select/combobox fill path (click -> open -> pick), across bare repeated labels in <fieldset>
// groups, and never touches the EV-charger trap.
// Run: npx tsx portal-bot/src/adapters/powerClerkSpecsCombobox.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";
import type { ProjectRecord } from "../../../shared/src/types";

process.env.AUTOLEARN_RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pwc-combo-smoke-"));

// A faithful Vue-filtered-select: readonly input[role=combobox] + aria-hidden display + a
// separate aria-controls listbox that renders its options on OPEN (readonly => no typing),
// with the model list gated on the manufacturer cascade (~600ms), like the live portal.
const combo = (id: string, label: string, dataRole: string) => `
  <div data-test-role="${dataRole}">
    <div class="position-relative wrapper">
      <input id="${id}" role="combobox" aria-haspopup="listbox" aria-expanded="false"
             aria-controls="${id}-list" aria-label="${label}" readonly tabindex="0"
             class="visually-hidden" value="">
      <div aria-hidden="true"><div class="form-select" id="${id}-box" data-test-role="filteredSelectField">
        <div class="selected-display" id="${id}-disp" data-test-role="selected-item-text">Please select...</div>
      </div></div>
    </div>
    <ul id="${id}-list" role="listbox" hidden></ul>
  </div>`;

const HTML = `<!doctype html><html><body>
<h1>System Information</h1>
<fieldset><legend>Inverter <button type="button">Clone System</button></legend>
  <div class="input-group"><span class="input-group-text">Qty</span>
    <input id="invQty" type="text" placeholder="Qty" aria-label="Qty" data-test-role="inverter-quantity"></div>
  <span class="lbl">Manufacturer</span>${combo("invMfr", "Manufacturer", "inverter-manufacturer-select")}
  <span class="lbl">Model</span>${combo("invModel", "Model", "inverter-model-select")}
</fieldset>
<fieldset><legend>PV Array <button type="button">Delete Array</button></legend>
  <div class="input-group"><span class="input-group-text">Qty</span>
    <input id="modQty" type="text" placeholder="Qty" aria-label="Qty" data-test-role="pv-array-quantity"></div>
  <span class="lbl">Manufacturer</span>${combo("modMfr", "Manufacturer", "pv-array-manufacturer-select")}
  <span class="lbl">Model</span>${combo("modModel", "Model", "pv-array-model-select")}
  <span class="lbl">Tilt</span><input id="tilt" type="text" aria-label="Tilt">
  <span class="lbl">Azimuth</span><input id="azimuth" type="text" aria-label="Azimuth">
  <span class="lbl">Tracking</span>
  <select id="tracking" aria-label="Tracking"><option value="">Please select...</option><option>Fixed</option><option>Single-Axis</option></select>
</fieldset>
<fieldset><legend>EV Charger</legend>
  <span class="lbl">Model</span>${combo("evModel", "Model", "ev-charger-model-select")}
</fieldset>
<script>
  // Certified option lists — model lists gate on the manufacturer cascade.
  const OPTS = {
    invMfr: ['Altenergy Power System', 'Enphase Energy Inc.'],
    invModel: ['0.8 kW (Model DS3-L {240V} [SI1])', '0.96 kW (Model QT2 {240V})'],
    modMfr: ['Znshine PV-Tech (ZNSHINE SOLAR)', 'Hanwha Q CELLS'],
    modModel: ['440W (Model ZXM7-UHLDD108-440/N)', '425W (Model ZXM7-UHLDD108-425/N)'],
    evModel: ['Wallbox Pulsar'],
  };
  const CASCADE = { invMfr: 'invModel', modMfr: 'modModel' };  // manufacturer -> dependent model
  const loaded = { invMfr: true, modMfr: true, evModel: true, invModel: false, modModel: false };

  window.__log = [];
  const T0 = performance.now();
  const mark = (m) => window.__log.push(Math.round(performance.now() - T0) + 'ms ' + m);
  function render(id) {
    const ul = document.getElementById(id + '-list');
    ul.innerHTML = '';
    mark('render ' + id + ' loaded=' + loaded[id] + ' n=' + ((OPTS[id] || []).length));
    if (!loaded[id]) return; // dependent model not populated yet (AJAX pending)
    for (const text of (OPTS[id] || [])) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.textContent = text;
      // mousedown fires before the input's blur so the pick isn't lost to a focus change.
      li.addEventListener('mousedown', (e) => { e.preventDefault(); commit(id, text); });
      ul.appendChild(li);
    }
  }
  function open(id) {
    const inp = document.getElementById(id);
    const ul = document.getElementById(id + '-list');
    inp.setAttribute('aria-expanded', 'true');
    ul.hidden = false;
    mark('open ' + id);
    render(id);
  }
  function close(id) {
    const inp = document.getElementById(id);
    inp.setAttribute('aria-expanded', 'false');
    document.getElementById(id + '-list').hidden = true;
  }
  function commit(id, text) {
    const inp = document.getElementById(id);
    inp.value = text;
    document.getElementById(id + '-disp').textContent = text;
    mark('commit ' + id + '="' + text + '"');
    close(id);
    const dep = CASCADE[id];
    if (dep) {
      // Manufacturer changed: clear + disable the dependent model, then AJAX-load ~600ms later.
      loaded[dep] = false;
      const depInp = document.getElementById(dep);
      depInp.value = '';
      document.getElementById(dep + '-disp').textContent = 'Please select...';
      setTimeout(() => {
        loaded[dep] = true;
        mark('cascade-ready ' + dep + ' expanded=' + document.getElementById(dep).getAttribute('aria-expanded'));
        if (document.getElementById(dep).getAttribute('aria-expanded') === 'true') render(dep); // re-render if already open
      }, 600);
    }
  }
  // Open on interacting with the readonly input OR its visible display box (the routes the
  // click/fill helpers take: Playwright click when visible, in-page click on the visible
  // .form-select opener when the input is visually-hidden, or focus for keyboard a11y).
  for (const id of Object.keys(loaded)) {
    const inp = document.getElementById(id);
    inp.addEventListener('click', () => open(id));
    inp.addEventListener('focus', () => open(id));
    document.getElementById(id + '-box').addEventListener('click', () => open(id));
    document.getElementById(id + '-disp').addEventListener('click', () => open(id));
  }
</script>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript({ content: "globalThis.__name = globalThis.__name || function (fn) { return fn; };" });
const http = await import("node:http");
const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(HTML); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
await page.goto(`http://127.0.0.1:${port}/specs`);

let plannerCalls = 0;
const planner: LearnPlanner = async () => {
  plannerCalls++;
  return { fills: [], atReview: plannerCalls > 1 };
};

const adapter = new AutoLearnAdapter("PGE PowerClerk (combobox specs smoke)", planner, {
  equipment: {
    inverterMake: "AP Systems",             // alias -> "Altenergy Power System"
    inverterModel: "DS3-L",                 // -> "0.8 kW (Model DS3-L {240V} [SI1])"
    moduleMake: "Znshine",                  // -> "Znshine PV-Tech (ZNSHINE SOLAR)"
    moduleModel: "ZXM7-UHLDD108-440/N",     // -> "440W (Model ZXM7-UHLDD108-440/N)"
    inverterQty: "12",
    moduleQty: "23",
    tilt: "22.5",
    azimuth: "180",
    tracking: "Fixed",
  },
});
(adapter as unknown as { page: unknown }).page = page;
const result = await adapter.learn({} as never, {} as ProjectRecord);

let failures = 0;
const val = (id: string) => page.$eval(`#${id}`, (e) => (e as HTMLInputElement).value);
const ok = (name: string) => console.log(`  ok   - ${name}`);
const bad = (name: string, got: string) => { failures++; console.error(`  FAIL - ${name} (got "${got}")`); };
const expectIncludes = async (id: string, needle: string, name: string) => {
  const got = await val(id);
  if (got.includes(needle)) ok(name); else bad(name, got);
};

if (result.ok) ok("learn run completed"); else { failures++; console.error(`  FAIL - learn run: ${result.message || ""}`); }
await expectIncludes("invMfr", "Altenergy Power System", "inverter manufacturer picked via ALIAS on a readonly combobox");
await expectIncludes("invModel", "DS3-L", "inverter model picked AFTER the ~600ms cascade");
await expectIncludes("modMfr", "Znshine", "module manufacturer picked (bare label, PV Array group)");
await expectIncludes("modModel", "ZXM7-UHLDD108-440/N", "module model picked after cascade");
assert.equal(await val("invQty"), "12"); assert.equal(await val("modQty"), "23"); ok("quantities filled");
assert.equal(await val("tilt"), "22.5"); assert.equal(await val("azimuth"), "180"); ok("tilt + azimuth filled");
const tracking = await val("tracking"); if (tracking === "Fixed") ok("tracking (native select) set"); else bad("tracking set", tracking);
const ev = await val("evModel"); if (ev === "") ok("EV charger Model trap NEVER touched"); else bad("EV trap untouched", ev);

if (failures) {
  const logLines = await page.evaluate(() => ((window as unknown as { __log?: string[] }).__log || []).join("\n")).catch(() => "");
  console.error("\n--- widget event log ---\n" + logLines);
}

await browser.close();
server.close();
fs.rmSync(process.env.AUTOLEARN_RUN_DIR!, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} PowerClerk combobox-specs smoke failure(s).`); process.exit(1); }
console.log("\nAll PowerClerk combobox-specs DOM smoke checks passed.");
process.exit(0);
