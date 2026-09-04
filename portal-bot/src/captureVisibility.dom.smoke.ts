// A CAPTURE THAT DOES NOT RECORD VISIBILITY CANNOT ANSWER WHY A FIELD WAS SKIPPED.
//
// Which is the question a capture is usually opened to answer. Twice on 2026-09-04 a
// captured page showed a control sitting in ordinary markup and reading it as "visible,
// therefore reachable" was wrong:
//
//   Momentum    a record-type radio in a plain <fieldset> with a <label> — and the div
//               around it hidden by CSS the capture did not carry. I wrote a commit
//               asserting the gate was "not a closed container at all". It was.
//   Wilsonville a login link, present and findable, under a modal backdrop.
//
// Each cost a live run to establish what the capture had been standing next to all along.
// Structure is cheap to record and useless alone; computed visibility can only be taken
// while the page is live, so it is taken there now.
//
// Also checked here: the capture must not leave a trace on the page the learner is still
// working on, and must not start recording the operator's data.
//   npx tsx portal-bot/src/captureVisibility.dom.smoke.ts
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

// Momentum's exact shape: an ordinary fieldset whose CONTAINER is hidden.
const PAGE = `<!doctype html><html><body>
  <div class="step1 step-div" style="display:none">
    <fieldset class="record-select-radio">
      <legend>Pick a record type.</legend>
      <input id="radio-license" type="radio" name="radio-options" />
      <label for="radio-license">Licenses &amp; Permits</label>
    </fieldset>
  </div>
  <div id="shown">
    <input id="visible-input" style="width:120px;height:20px" value="OPERATOR SECRET" />
    <label for="visible-input">Homeowner name</label>
  </div></body></html>`;

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-vis-"));
process.env.AUTOLEARN_RUN_DIR = runDir;
const { LearnRunDebug } = await import("./learnDebug");

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGE);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(120);

const dbg = LearnRunDebug.start("capture-visibility-smoke", {});
check("the debug recorder started", !!dbg);
await dbg!.capturePageHtml(page, "p001");

const file = fs.readdirSync(dbg!.dir).find((n) => n.startsWith("page-p001"));
check("a capture file was written", !!file, fs.readdirSync(dbg!.dir).join(", "));
const captured = JSON.parse(fs.readFileSync(path.join(dbg!.dir, file!), "utf8")) as { html: string };
const html = captured.html;

// ---------------------------------------------------------------------------
check("THE REGRESSION: the hidden container is marked invisible in the capture",
  /class="step1 step-div"[^>]*data-al-invisible|data-al-invisible[^>]*class="step1 step-div"/.test(html),
  "the capture cannot say the gate was concealed");

check("...and so is the control inside it, so a reader need not infer",
  /id="radio-license"[^>]*data-al-invisible|data-al-invisible[^>]*id="radio-license"/.test(html));

check("...and its label, which is what a label-proxy fix would have reached for",
  /for="radio-license"[^>]*data-al-invisible|data-al-invisible[^>]*for="radio-license"/.test(html));

check("a genuinely VISIBLE control carries no such mark",
  /id="visible-input"/.test(html) && !/id="visible-input"[^>]*data-al-invisible/.test(html));

// ---------------------------------------------------------------------------
// The properties that matter more than the feature.
// ---------------------------------------------------------------------------
check("PRIVACY: the operator's typed value is still stripped",
  !/OPERATOR SECRET/.test(html), "a capture must never carry what was typed into the form");

check("THE LIVE PAGE IS LEFT CLEAN — the learner is still working on it",
  (await page.locator("[data-al-invisible]").count()) === 0,
  "the marks were not removed after cloning");

check("...and the page still works afterwards", await page.locator("#visible-input").isVisible());

await browser.close();
server.close();
fs.rmSync(runDir, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} capture-visibility check(s) FAILED.`); process.exit(1); }
console.log("\nAll capture-visibility checks passed.");
process.exit(0);
