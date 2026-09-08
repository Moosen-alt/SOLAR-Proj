// A STYLED CHECKBOX IS DRIVEN BY ITS LABEL, NOT BY THE INPUT UNDERNEATH IT.
//
// Ameren Illinois lost a whole run to this on step 2 of 75 -- the Terms and Conditions box on
// the first page of the form. The failure text is the diagnosis, in full:
//
//   locator.check: Clicking the checkbox did not change its state
//     - forcing action / performing click action / click action done
//
// The click was delivered. The box did not move. That is a portal drawing its own checkbox:
// the real <input> is kept for submission and concealed, and the handler is on the LABEL, so
// a click delivered to the input reaches something nothing listens to.
//
// The page also carries the first-visit announcement modal that was the first suspect here --
// kept deliberately, because it was NOT the cause and a fixture that quietly drops the
// red herring is a fixture that stops testing the harder case.
//   npx tsx portal-bot/src/adapters/modalOverCheckbox.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// The shape, reduced: a scrim over the whole page and a popover with a dismissal, exactly
// as PowerClerk announces a homepage change.
const PAGE = `<!doctype html><html><head><style>
  body { font: 14px sans-serif; padding: 16px; }
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 900; }
  .new-feature-popper { position: fixed; top: 40px; left: 40px; width: 280px; padding: 16px;
                        background: #fff; border: 1px solid #ccc; z-index: 901; }
  .concealed { opacity: 0; position: absolute; width: 1px; height: 1px; }
  #termsLabel { display: inline-block; margin-top: 24px; cursor: pointer; }
  .box { display: inline-block; width: 16px; height: 16px; border: 1px solid #555; margin-right: 6px; vertical-align: -3px; }
</style></head><body>
  <h3>Interconnection Application</h3>
  <!-- THE STYLED CHECKBOX, as PowerClerk renders it: the real input is kept for submission
       and concealed under a drawn box, and the page's handler is bound to the LABEL. A click
       delivered to the input itself reaches something nothing listens to, which is exactly
       what "Clicking the checkbox did not change its state" reports. -->
  <label for="terms" id="termsLabel"><span class="box"></span>By clicking here, you indicate that you have read and agree to the Terms and Conditions *</label>
  <input id="terms" type="checkbox" class="concealed" />
  <div class="modal-backdrop"></div>
  <div class="new-feature-popper">
    <strong>What&rsquo;s new?</strong>
    <p>Your new homepage now shows recent projects, statuses and release notes in one place.</p>
    <button type="button" id="gotit">Got it</button>
  </div>
  <script>
    // The input refuses to toggle from a direct click; only the label drives it.
    document.getElementById("terms").addEventListener("click", function (e) { e.preventDefault(); });
    document.getElementById("termsLabel").addEventListener("click", function () {
      var box = document.getElementById("terms");
      box.checked = !box.checked;
      document.querySelector(".box").style.background = box.checked ? "#333" : "";
    });
    document.getElementById("gotit").addEventListener("click", function () {
      document.querySelector(".modal-backdrop").remove();
      document.querySelector(".new-feature-popper").remove();
    });
  </script>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const recipe = {
  id: "mc1", scopeType: "utility", profileKey: "il|unknown|ameren illinois", state: "IL",
  ahj: "", utility: "Ameren Illinois", portalPlatform: "powerclerk", portalUrl: url,
  status: "complete", version: 1,
  steps: [
    { action: "check", phase: "fill", field: "", note: "By clicking here, you indicate that you have read and agree to the Terms and Conditions",
      selector: { css: "#terms" } },
  ] as unknown as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(url);
const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: false });
(adapter as unknown as { page: unknown }).page = page;
const res = await adapter.fillApplication({} as never);
const data = (res as unknown as { data?: { skipped?: string[]; executed?: number } }).data ?? {};
const ticked = await page.locator("#terms").isChecked().catch(() => false);
console.log(`   terms checked = ${String(ticked)}; executed = ${String(data.executed)}`);

check("THE LIVE STOP: a checkbox the input will not toggle is ticked by its label",
  ticked === true,
  "the run stopped where Ameren did: forced click delivered, state unchanged, no label route tried");

check("...and the step is not reported as a miss",
  !(data.skipped ?? []).some((sName) => /terms/i.test(sName)), JSON.stringify(data.skipped));

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} modal-over-checkbox check(s) FAILED.`); process.exit(1); }
console.log("\nAll modal-over-checkbox checks passed (real Chromium).");
process.exit(0);
