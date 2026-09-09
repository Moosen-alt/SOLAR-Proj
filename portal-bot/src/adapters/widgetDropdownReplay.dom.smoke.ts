// REPLAY HAS TO FILL THE WIDGET TOO.
//
// The learn side was taught that a dropdown widget's backing input is MEANT to be invisible
// — Miami's Job Category is <input id="JobCategoryID" style="display:none"> behind a Telerik
// face, and applyFill refused it three runs running with "hidden_field_skipped". That fix
// landed in autoLearnAdapter only.
//
// Replay resolves selectors through its own machinery, and that machinery prefers VISIBLE
// controls for a reason it paid for: PowerClerk's inverter "Model" step matched an invisible
// twin whose option list was the ENERGY SOURCE values, filled it, and took the manufacturer
// back down with it. So "invisible" must keep meaning "look harder" — while a widget's
// backing input, which no portal will ever make visible, still has to be fillable.
//
// This drives a real RecipeAdapter against Miami's shape. If replay cannot fill it, a
// recipe that learned the portal perfectly still files a blank required field.
//
//   npx tsx portal-bot/src/adapters/widgetDropdownReplay.dom.smoke.ts
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

const PAGE = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
  <div id="dvjcCategoryleft">
    <div id="dvtitleleft">*Job Category</div>
    <div class="t-widget t-dropdown t-header" tabindex="0">
      <div class="t-dropdown-wrap"><span class="t-input">Please select a Job Category...</span></div>
      <input id="JobCategoryID" name="JobCategoryID" style="display: none;" type="text">
    </div>
  </div>

  <!-- The reason replay prefers visible controls: an invisible TWIN carrying the same name,
       whose option list is a different question entirely. It must still lose. -->
  <input id="JobCategoryTwin" name="JobCategoryID" style="display:none" type="text">

  <div id="done"></div>
  <script>
    var CATS = [["1","ADDITION AND REMODELING"],["5","STAND-ALONE"],["6","TREE PERMIT"]];
    document.querySelector("#dvjcCategoryleft .t-dropdown-wrap").addEventListener("click", function () {
      var open = document.querySelector(".t-animation-container");
      if (open) { open.remove(); return; }
      var box = document.createElement("div");
      box.className = "t-animation-container";
      box.style.cssText = "position:absolute;top:100px;left:8px;background:#fff;border:1px solid #ccc;z-index:99";
      var ul = document.createElement("ul");
      ul.className = "t-list t-reset";
      CATS.forEach(function (c) {
        var li = document.createElement("li");
        li.className = "t-item";
        li.textContent = c[1];
        li.addEventListener("click", function () {
          document.getElementById("JobCategoryID").value = c[0];
          document.querySelector("#dvjcCategoryleft .t-input").textContent = c[1];
          document.getElementById("done").textContent = "PICKED " + c[1];
          box.remove();
        });
        ul.appendChild(li);
      });
      box.appendChild(ul);
      document.body.appendChild(box);
    });
  </script>
</body></html>`;

const server = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const steps: RecipeStep[] = [
  { action: "goto", phase: "open", value: url, note: "entry url" },
  {
    action: "select", phase: "fill",
    selector: { css: "#JobCategoryID", fallbacks: [{ label: "Job Category" }] },
    field: "jobCategory", value: "STAND-ALONE", note: "Job Category",
  },
];

const recipe = {
  id: "r1", scopeType: "ahj", profileKey: "fl|miami|x", state: "FL", ahj: "Miami", utility: "",
  portalPlatform: "ibuild", portalUrl: url, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "structural",
} as unknown as PortalRecipe;

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await ctx.newPage();

// No `jobCategory` key: the planner invented it, so the recorded answer is what replays.
const adapter = new RecipeAdapter(recipe, { street: "3500 Pan American Dr" }, {}, { autoSubmit: false });
(adapter as unknown as { page: unknown }).page = page;
const result = await adapter.fillApplication({} as never);

const landed = await page.locator("#JobCategoryID").inputValue().catch(() => "");
const face = (await page.locator("#dvjcCategoryleft .t-input").textContent().catch(() => "")) ?? "";
const twin = await page.locator("#JobCategoryTwin").inputValue().catch(() => "");
const done = (await page.locator("#done").textContent().catch(() => "")) ?? "";
const data = (result.data ?? {}) as { skipped?: string[]; driftWarnings?: string[] };
console.log(`   value=${JSON.stringify(landed)} face=${JSON.stringify(face)} done=${JSON.stringify(done)}`);
console.log(`   skipped=${JSON.stringify(data.skipped ?? [])}`);

check("replay fills a dropdown whose backing input is display:none", () => {
  assert.equal(landed, "5", `got ${JSON.stringify(landed)} — replay skipped the control the learn had to be taught to see`);
});
check("...by clicking the widget, the way a person does", () => {
  assert.match(done, /PICKED STAND-ALONE/, `the option was never clicked (done=${JSON.stringify(done)})`);
});
check("...and the widget shows the answer", () => {
  assert.match(face, /STAND-ALONE/, `face reads ${JSON.stringify(face)}`);
});
check("...and the step is not reported as skipped", () => {
  assert.equal((data.skipped ?? []).length, 0, `skipped: ${JSON.stringify(data.skipped)}`);
});
check("MUST EXCLUDE: the invisible twin is not the control that got filled", () => {
  assert.equal(twin, "", `the twin holds ${JSON.stringify(twin)} — this is the PowerClerk regression the visible-preference exists to stop`);
});

await browser.close();
server.close();
if (failures > 0) { console.error(`\nwidgetDropdownReplay.dom.smoke: ${failures} FAILURE(S)`); process.exit(1); }
console.log("\nwidgetDropdownReplay.dom.smoke: PASS");
process.exit(0);
