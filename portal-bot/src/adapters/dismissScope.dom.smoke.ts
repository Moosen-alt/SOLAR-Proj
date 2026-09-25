// THE MODAL DISMISSER CLICKED A PERMIT TYPE.
//
// permiteyes.us learned a nine-fill application and could not replay it: the run landed on a
// permit-type menu and the recipe had no step for choosing a type. The type was never chosen
// BY A STEP -- it was chosen by the modal dismisser, which is not a recording pass.
//
// `:has-text("OK")` matches any clickable whose text CONTAINS "ok", case-insensitively:
//
//     "Smoke Detector Permit"   sm-OK-e
//     "Look Up Record"          LO-OK
//
// So the dismisser clicked a permit type, the learn filled whatever form that opened, and
// the recipe recorded the fills with no way back to them.
//
// The list is exact-match now. A dismissal button's whole label is "OK" or "Close"; it never
// says "Smoke Detector Permit". Both directions are asserted -- a dismisser that stops
// dismissing is the other way to break this.
//   npx tsx portal-bot/src/adapters/dismissScope.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import { dismissPageModals } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// permiteyes' menu, plus a real popover the dismisser SHOULD clear.
const PAGE = `<!doctype html><html><head><style>body{font:14px sans-serif;padding:16px}
  .popover{position:fixed;top:8px;left:8px;background:#fff;border:1px solid #999;padding:10px;z-index:99}
</style></head><body>
  <div class="popover"><strong>What&rsquo;s new?</strong><button id="gotit">Got it</button></div>
  <h3>NEW APPLICATION</h3>
  <div id="menu">
    <a href="#" id="t1">Abandoned / Foreclosed Property</a><br/>
    <a href="#" id="t2">Smoke Detector Permit</a><br/>
    <a href="#" id="t3">Look Up Record</a><br/>
    <a href="#" id="t4">Solar Permit</a>
  </div>
  <div id="clicked"></div>
  <script>
    for (const id of ["t1","t2","t3","t4"]) {
      document.getElementById(id).addEventListener("click", function (e) {
        e.preventDefault();
        document.getElementById("clicked").textContent = this.textContent;
      });
    }
    document.getElementById("gotit").addEventListener("click", function () {
      document.querySelector(".popover").remove();
    });
  </script>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/`);

await dismissPageModals(page);

const clicked = ((await page.locator("#clicked").innerText().catch(() => "")) || "").trim();
const popoverGone = (await page.locator(".popover").count().catch(() => 1)) === 0;
console.log(`   dismisser clicked a menu entry: ${JSON.stringify(clicked)}`);
console.log(`   popover dismissed: ${String(popoverGone)}`);

check("THE LIVE BUG: no permit type is clicked by the modal dismisser",
  clicked === "",
  `it clicked ${JSON.stringify(clicked)} — the learn then fills that form and records no step for it`);

check("...and the REAL popover is still dismissed — the fix must not stop it dismissing",
  popoverGone, "the dismisser stopped working; a filter that rejects everything is not a fix");

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} dismiss-scope check(s) FAILED.`); process.exit(1); }
console.log("\nAll dismiss-scope checks passed (real Chromium).");
process.exit(0);
