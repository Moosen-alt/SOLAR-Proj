// REAL-BROWSER smoke for the PowerClerk "PV System Specification" page shape that
// kept stalling live runs: BARE labels ("Manufacturer", "Model", "Quantity") whose
// side lives only in the SECTION header, model <select>s whose options AJAX-load
// ~600ms AFTER the manufacturer changes, and certified option names that differ
// from the plan set's ("AP Systems" is listed as "Altenergy Power System…").
// Proves: section-context matching → alias resolution → cascade wait → fill, and
// that the EV-charger trap section is never touched.
// Run: npx tsx portal-bot/src/adapters/powerClerkSpecs.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";
import type { ProjectRecord } from "../../../shared/src/types";

process.env.AUTOLEARN_RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pwc-specs-smoke-"));

const HTML = `<!doctype html><html><body>
<h1>PV System Specification</h1>
<section class="panel"><h3>PV Module Information</h3>
  <label for="modMfr">Manufacturer</label>
  <select id="modMfr"><option value="">Please select...</option>
    <option value="zn">Znshine PV-Tech (ZNSHINE SOLAR)</option>
    <option value="qc">Hanwha Q CELLS</option></select>
  <label for="modModel">Model</label>
  <select id="modModel" disabled><option value="">Please select...</option></select>
  <label for="modQty">Quantity</label><input id="modQty">
  <label for="tilt">Tilt</label><input id="tilt">
  <label for="azimuth">Azimuth</label><input id="azimuth">
  <label for="tracking">Tracking</label>
  <select id="tracking"><option value="">Please select...</option><option>Fixed</option><option>Single-Axis</option></select>
</section>
<section class="panel"><h3>Inverter Information</h3>
  <label for="invMfr">Manufacturer</label>
  <select id="invMfr"><option value="">Please select...</option>
    <option value="ap">Altenergy Power System Inc. (APsystems)</option>
    <option value="en">Enphase Energy Inc.</option></select>
  <label for="invModel">Model</label>
  <select id="invModel" disabled><option value="">Please select...</option></select>
  <label for="invQty">Quantity</label><input id="invQty">
</section>
<section class="panel"><h3>EV Charger Information</h3>
  <label for="evModel">Model</label>
  <select id="evModel"><option value="">Please select...</option><option>Wallbox Pulsar</option></select>
</section>
<script>
  // PowerClerk-style cascade: choosing a manufacturer clears + disables the model
  // select, then repopulates it ~600ms later (simulated AJAX postback).
  function cascade(mfrId, modelId, options) {
    document.getElementById(mfrId).addEventListener('change', () => {
      const m = document.getElementById(modelId);
      m.innerHTML = '<option value="">Please select...</option>';
      m.disabled = true;
      setTimeout(() => {
        for (const o of options) { const el = document.createElement('option'); el.textContent = o; el.value = o; m.appendChild(el); }
        m.disabled = false;
      }, 600);
    });
  }
  cascade('modMfr', 'modModel', ['440W (Model ZXM7-UHLDD108-440/N)', '425W (Model ZXM7-UHLDD108-425/N)']);
  cascade('invMfr', 'invModel', ['0.8 kW (Model DS3-L {240V} [SI1])', '0.96 kW (Model QT2 {240V})']);
</script>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript({ content: "globalThis.__name = globalThis.__name || function (fn) { return fn; };" });
// Serve over HTTP (not setContent): the learn loop navigates/records by URL.
const http = await import("node:http");
const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(HTML); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
await page.goto(`http://127.0.0.1:${port}/specs`);

// Planner thrash simulation: contributes NOTHING (exactly the live failure mode);
// second call reports review so the run completes.
let plannerCalls = 0;
const planner: LearnPlanner = async () => {
  plannerCalls++;
  return { fills: [], atReview: plannerCalls > 1 };
};

const adapter = new AutoLearnAdapter("PGE PowerClerk (specs smoke)", planner, {
  equipment: {
    inverterMake: "AP Systems",             // certified list says "Altenergy Power System Inc. (APsystems)"
    inverterModel: "DS3-L",                 // certified: "0.8 kW (Model DS3-L {240V} [SI1])"
    moduleMake: "Znshine",                  // certified: "Znshine PV-Tech (ZNSHINE SOLAR)"
    moduleModel: "ZXM7-UHLDD108-440/N",     // certified: "440W (Model ZXM7-UHLDD108-440/N)"
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
// check() AWAITS. It used to take a synchronous callback, and two checks here were empty async
// bodies that printed "ok" while the real assertions ran bare below them — an assertion that
// threw there crashed the smoke with no "FAIL -" line at all. Every assertion is now inside an
// awaited check, so a red is always a named red.
const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (err) { failures++; console.error(`  FAIL - ${name}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const val = (id: string) => page.$eval(`#${id}`, (e) => (e as HTMLInputElement | HTMLSelectElement).value);
const selText = (id: string) => page.$eval(`#${id}`, (e) => {
  const s = e as HTMLSelectElement;
  return s.selectedIndex >= 0 ? (s.options[s.selectedIndex]?.textContent || "") : "";
});

await check("learn run completed", () => assert.equal(result.ok, true, result.message || ""));
await check("module manufacturer selected (Znshine → certified name, via section + name containment)", async () =>
  assert.equal(await val("modMfr"), "zn", "module manufacturer selected"));
await check("module model selected AFTER cascade populated (waited out the AJAX)", async () => {
  const t = await selText("modModel");
  assert.ok(t.includes("ZXM7-UHLDD108-440/N"), `module model not selected (got "${t}")`);
});
await check("inverter manufacturer selected via ALIAS (AP Systems → Altenergy Power System)", async () =>
  assert.equal(await val("invMfr"), "ap", "inverter manufacturer not selected"));
await check("inverter model selected after cascade", async () => {
  const t = await selText("invModel");
  assert.ok(t.includes("DS3-L"), `inverter model not selected (got "${t}")`);
});
await check("quantities, tilt, azimuth filled", async () => {
  assert.equal(await val("modQty"), "23", "module quantity");
  assert.equal(await val("invQty"), "12", "inverter quantity");
  assert.equal(await val("tilt"), "22.5", "tilt");
  assert.equal(await val("azimuth"), "180", "azimuth");
});
await check("tracking set to Fixed", async () => assert.equal(await val("tracking"), "Fixed"));
await check("EV charger Model trap NEVER touched", async () => assert.equal(await val("evModel"), "", "EV charger model was filled"));

await browser.close();
server.close();
fs.rmSync(process.env.AUTOLEARN_RUN_DIR!, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} PowerClerk-specs smoke failure(s).`); process.exit(1); }
console.log("\nAll PowerClerk-specs DOM smoke checks passed.");
process.exit(0);
