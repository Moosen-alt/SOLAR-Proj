// A FILE HANDED TO THE BROWSER IS NOT A FILE THE PORTAL HAS TAKEN.
//
// setInputFiles returns the instant the input holds the file. What follows is the portal's
// own async upload -- and everything the recipe does next (the description, the type, the
// Save that commits it) happens while that transfer is still in flight.
//
// Live on Coos Bay, this cost four of six runs. Accela's review page showed a filing that was
// otherwise complete -- address, parcel, three licensed professionals, job value, category,
// description, applicant, site contact -- with the upload bar at 0%, Save greyed out, an
// empty attachment table, and the portal's own banner: "Your documents are not yet saved."
// Continue was refused after that, and the run reported "the portal did not advance", which
// is true and is a symptom eleven steps downstream of the cause.
//
// The learn side already waits ("ACA keeps the Save anchor inside a container it reveals with
// JS only once the uploads finish"). Replay replayed the clicks and waited for nothing.
//   npx tsx portal-bot/src/adapters/uploadAccepted.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// The ordinary shape: choosing a file starts a progress bar, and Save only works once it
// reaches 100%. Clicking Save early is refused exactly as Accela refuses it.
const PAGE = `<!doctype html><html><head><style>body{font:14px sans-serif;padding:16px}</style></head><body>
  <h3>Attachment</h3>
  <input id="file" type="file" />
  <div id="barSlot"></div>
  <label for="desc">Description</label><textarea id="desc"></textarea>
  <a id="save" href="javascript:void(0)">Save</a>
  <div id="banner"></div>
  <script>
    var done = false;
    document.getElementById("file").addEventListener("change", function () {
      // The uploader initialises before it draws anything — a few hundred ms in which the
      // page reports no progress at all. Asking once inside that window and concluding "this
      // portal has no indicator" is the race; without the appearance wait, Save fires here.
      setTimeout(startUpload, 600);
    });
    function startUpload() {
      var pct = 0;
      // THE BAR IS DRAWN AFTER THE CHANGE EVENT, which is how an uploader actually behaves —
      // and it is what the first version of the wait missed: it asked once, saw no indicator,
      // and returned before the portal had started. A fixture with the bar already in the
      // markup cannot catch that, so this one creates it late, on purpose.
      var bar = document.createElement("div");
      bar.id = "bar";
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-valuenow", "0");
      bar.style.cssText = "width:200px;height:14px;border:1px solid #999";
      bar.textContent = "0%";
      document.getElementById("barSlot").appendChild(bar);
      var t = setInterval(function () {
        pct += 20;
        bar.setAttribute("aria-valuenow", String(pct));
        bar.textContent = pct + "%";
        if (pct >= 100) { clearInterval(t); done = true; }
        // 7.5s in total, deliberately longer than every incidental wait the adapter already
        // performs (autosave settle, networkidle, the 3s persist window). A fixture whose
        // upload finishes inside those waits passes with the fix REMOVED, which is a fixture
        // that tests nothing — this one was that, first time round.
      }, 1500);
    }
    document.getElementById("save").addEventListener("click", function () {
      document.getElementById("banner").textContent = done
        ? "Attachment saved."
        : "An error has occurred. Your documents are not yet saved.";
    });
  </script>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zz-upload-smoke-"));
const file = path.join(dir, "ZZTEST-PLACEHOLDER-plan-set.pdf");
fs.writeFileSync(file, "%PDF-1.4\n% placeholder\n");

const recipe = {
  id: "ua1", scopeType: "ahj", profileKey: "or|city of coos bay|pacific power", state: "OR",
  ahj: "City of Coos Bay", utility: "Pacific Power", portalPlatform: "accela", portalUrl: url,
  status: "complete", version: 1,
  steps: [
    { action: "upload", phase: "upload", field: "", note: "upload plan_set: Add", docType: "plan_set", selector: { css: "#file" } },
    { action: "fill", phase: "upload", field: "", note: "attachment: description", value: "Solar PV plan set", selector: { css: "#desc" } },
    { action: "click", phase: "upload", field: "", note: "attachment: Save", selector: { css: "#save" } },
  ] as unknown as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(url);
const adapter = new RecipeAdapter(recipe, {}, { plan_set: file }, { autoSubmit: false });
(adapter as unknown as { page: unknown }).page = page;
await adapter.fillApplication({} as never);
const banner = ((await page.locator("#banner").innerText().catch(() => "")) || "").trim();
const pct = await page.locator("#bar").getAttribute("aria-valuenow").catch(() => "?");
console.log(`   progress at Save = ${String(pct)}%; banner = ${JSON.stringify(banner)}`);

check("THE LIVE STOP: Save waits until the portal has actually taken the file",
  /saved/i.test(banner) && !/not yet saved/i.test(banner),
  `the portal refused the commit: ${JSON.stringify(banner)} — replay clicked Save mid-upload`);

check("...and the upload had reached 100% before the commit",
  String(pct) === "100", `progress was ${String(pct)}% when Save was clicked`);

await browser.close();
server.close();
fs.rmSync(dir, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} upload-accepted check(s) FAILED.`); process.exit(1); }
console.log("\nAll upload-accepted checks passed (real Chromium).");
process.exit(0);
