// A POPUP LEFT OPEN BY ONE STEP MUST NOT SHADOW THE NEXT.
//
// Replay contained no Escape at all. The learner contains nine — the same "the learner is
// smarter than the replayer" asymmetry that produced the modal, validation-scrape and
// review-screen bugs before it, and this time it cost a live PacifiCorp filing its inverter
// model. The run reported:
//
//   select "Model" landed nothing though 49 option(s) were showing
//     resolved <input id="pcInputBase55" label="Model" visible=false>
//     list offers "Select...", "Solar PV", "Solar PV and Battery", "Wind", "Hydro"
//
// Those are Energy Source options. An earlier widget's list was still open and covering the
// Model control: resolution found nothing visible and fell through to a hidden node, and the
// option scan read a list belonging to another field entirely. Every symptom pointed at the
// Model step; nothing was wrong with it.
//
// CLAUDE.md records the same hazard for date inputs — they "pop a picker that must be
// Escape-dismissed" — and replay dismissed those either, so a replayed date left an overlay
// sitting on whatever came next.
//
// The pages below are those two shapes, reduced, and neither uses a portal-specific class:
// the guard has to work on the portal nobody has opened yet.
//   npx tsx portal-bot/src/adapters/staleOverlay.dom.smoke.ts
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

// A listbox that opens on the FIRST field and covers the second, exactly as a combobox left
// open by a previous step does. Escape closes it — nothing else does.
const PAGE = `<!doctype html><html><head><style>
  body { font: 14px sans-serif; padding: 20px; }
  .field { margin: 14px 0; position: relative; }
  #list { position: absolute; top: 28px; left: 0; width: 320px; height: 180px;
          background: #fff; border: 1px solid #888; z-index: 99; display: none; }
  #list.open { display: block; }
  #picker { position: absolute; top: 28px; left: 0; width: 300px; height: 160px;
            background: #eef; border: 1px solid #66a; z-index: 99; display: none; }
  #picker.open { display: block; }
</style></head><body>
  <h2 id="heading">Generation System</h2>
  <div id="page1">
    <div class="field">
      <label for="source">Energy Source</label>
      <input id="source" role="combobox" aria-expanded="false" />
      <div id="list" role="listbox">
        <div>Select...</div><div>Solar PV</div><div>Solar PV and Battery</div>
        <div>Wind</div><div>Hydro</div><div>Battery Only</div>
      </div>
    </div>
    <div class="field">
      <label for="commission">Planned date of operation</label>
      <input id="commission" />
      <div id="picker" class="datepicker"></div>
    </div>
    <div class="field">
      <label for="model">Model</label>
      <input id="model" />
    </div>
    <button id="next" type="button">Next</button>
  </div>
  <div id="page2" style="display:none"><h3>Review</h3></div>
  <script>
    var list = document.getElementById('list');
    var picker = document.getElementById('picker');
    var source = document.getElementById('source');

    // The widget opens on focus and STAYS open — the state a previous step leaves behind.
    source.addEventListener('focus', function () {
      list.classList.add('open'); source.setAttribute('aria-expanded', 'true');
    });
    // A date input pops its picker on focus, over whatever follows it.
    document.getElementById('commission').addEventListener('focus', function () {
      picker.classList.add('open');
    });
    // Only Escape puts them away, which is the whole point.
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      list.classList.remove('open'); source.setAttribute('aria-expanded', 'false');
      picker.classList.remove('open');
    });

    // THE SHADOWING ITSELF: while a popup is open, anything underneath refuses input, the
    // way a real control covered by an overlay does.
    document.getElementById('model').addEventListener('beforeinput', function (e) {
      if (list.classList.contains('open') || picker.classList.contains('open')) e.preventDefault();
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
  id: "so1", scopeType: "utility", profileKey: "or||pacific power", state: "OR", ahj: "", utility: "Pacific Power",
  portalPlatform: "powerclerk", portalUrl: url, status: "complete", version: 1,
  steps: [
    { action: "fill", phase: "fill", selector: { css: "#source" }, field: "energySource", note: "Energy Source" },
    { action: "fill", phase: "fill", selector: { css: "#commission" }, field: "plannedDate", note: "Planned date of operation" },
    { action: "fill", phase: "fill", selector: { css: "#model" }, field: "inverterModel", note: "Model" },
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
  energySource: "Solar PV",
  plannedDate: "2026-10-01",
  inverterModel: "IQ8PLUS-72-2-US",
}, {}, { autoSubmit: false });
(adapter as unknown as { page: unknown }).page = page;

const res = await adapter.fillApplication({} as never);
const data = (res as unknown as { data?: { skipped?: string[]; driftWarnings?: string[] } }).data ?? {};
const skipped = data.skipped ?? [];
const modelValue = await page.inputValue("#model").catch(() => "");
const listStillOpen = await page.locator("#list.open").count().catch(() => 0);
const pickerStillOpen = await page.locator("#picker.open").count().catch(() => 0);
console.log(`   #model = ${JSON.stringify(modelValue)}; skipped ${JSON.stringify(skipped)}`);

// ---------------------------------------------------------------------------
// The live failure.
// ---------------------------------------------------------------------------
check("THE REGRESSION: a control shadowed by a left-open dropdown is still filled", () => {
  assert.match(modelValue, /IQ8PLUS/,
    `the Model box was covered by the Energy Source list and never received its value (got ${JSON.stringify(modelValue)})`);
});

check("...and the step is not reported as a miss, because it was not one", () => {
  assert.ok(!skipped.some((s) => /model/i.test(s)), JSON.stringify(skipped));
});

check("a date picker popped by a replayed date fill is dismissed too", () => {
  assert.equal(pickerStillOpen, 0, "the picker was left sitting over the rest of the form");
});

check("no popup is left open when the run ends", () => {
  assert.equal(listStillOpen, 0, "a list left open would shadow whatever a human does next");
});

check("the run still completes", () => {
  assert.equal(res.ok, true, String(res.message ?? "").slice(0, 200));
});

// ---------------------------------------------------------------------------
// THE OPPOSITE CASE, and the reason this guard tests containment rather than visibility.
//
// A recipe is free to record "open the dropdown" and "choose the option" as two steps, and
// the option lives INSIDE the open list. A blanket Escape before each step would close the
// list underneath the very interaction being replayed — turning a fix for one failure into a
// new one. The target being contained by the open popup is what tells the two apart.
// ---------------------------------------------------------------------------
{
  const page2 = await context.newPage();
  await page2.goto(url);
  const openThenPick = {
    ...recipe,
    id: "so2",
    steps: [
      { action: "click", phase: "fill", selector: { css: "#source" }, note: "open Energy Source" },
      { action: "click", phase: "fill", selector: { css: "#list div:nth-child(2)" }, note: "choose Solar PV" },
    ] as RecipeStep[],
  } as unknown as PortalRecipe;
  const a2 = new RecipeAdapter(openThenPick, {}, {}, { autoSubmit: false });
  (a2 as unknown as { page: unknown }).page = page2;
  const r2 = await a2.fillApplication({} as never);
  const d2 = (r2 as unknown as { data?: { skipped?: string[] } }).data ?? {};
  const picked = (d2.skipped ?? []).some((s) => /choose Solar PV/i.test(s));

  check("a step whose target is INSIDE the open list does not get the list closed under it", () => {
    assert.ok(!picked, `the option step was skipped — the list was dismissed before it could be clicked: ${JSON.stringify(d2.skipped)}`);
  });
  await page2.close();
}

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} stale-overlay check(s) FAILED.`); process.exit(1); }
console.log("\nAll stale-overlay checks passed (real Chromium).");
process.exit(0);
