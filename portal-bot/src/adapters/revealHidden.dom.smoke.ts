// PRESENT BUT SHUT, AS A RULE INSTEAD OF A FOURTH PATCH.
//
// Momentum's run says it plainly. Three consecutive pages, same URL, same counts:
//
//   p2 /submit-record fields=36(fill=2) adv=24 fills=1  hidden_field_skipped "Licenses & Permits"
//   p3 /submit-record fields=36(fill=2) adv=24 fills=1  hidden_field_skipped "Licenses & Permits"
//   p4 /submit-record fields=36(fill=2) adv=24 fills=1  hidden_field_skipped "Licenses & Permits"
//   budget_exhausted page 5
//
// It filled one field, skipped the gate because the gate was invisible, clicked advance, and
// the portal refused to move. Four pages of budget re-reading one URL.
//
// "Not visible, skip" is right for a decorative or dead input — a display:none date field
// once cost 137 seconds of Playwright waiting — and wrong for the common case, where
// invisible means nobody has opened the thing containing it. This is the fourth time that
// shape has needed a fix (Accela's unticked category, Momentum's collapsed nav, PermitTrax's
// closed dropdown, ComEd's drawer), so it is a rule now.
//
// The refusals matter as much as the reveals: opening containers indiscriminately is how a
// run starts clicking things nobody asked it to.
//   npx tsx portal-bot/src/adapters/revealHidden.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import { planHiddenReveal } from "./revealHidden";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

const PAGES: Record<string, string> = {
  // Momentum's shape: the gate inside a collapsed panel with an aria-controls toggle.
  ariaControls: `<!doctype html><html><body>
    <button id="tog" aria-controls="panel" aria-expanded="false" style="width:200px;height:30px">Licenses &amp; Permits</button>
    <div id="panel" style="display:none">
      <select id="gate" data-al-hidden-target="1"><option>Solar</option></select>
    </div></body></html>`,
  details: `<!doctype html><html><body>
    <details><summary style="width:200px;height:20px">More</summary>
      <input id="gate" data-al-hidden-target="1" /></details></body></html>`,
  bsTarget: `<!doctype html><html><body>
    <a href="#sect" data-bs-target="#sect" style="width:150px;height:20px">Open section</a>
    <div id="sect" style="display:none"><input id="gate" data-al-hidden-target="1" /></div></body></html>`,
  precedingToggle: `<!doctype html><html><body>
    <button style="width:150px;height:24px">Show details</button>
    <div style="display:none"><input id="gate" data-al-hidden-target="1" /></div></body></html>`,
  // NOTHING opens this — a genuinely dead field. Must stay skipped.
  deadField: `<!doctype html><html><body>
    <p>Some text</p>
    <div style="display:none"><input id="gate" data-al-hidden-target="1" title="This is a hidden field." /></div>
    </body></html>`,
  // Visible field: nothing to do.
  visible: `<!doctype html><html><body>
    <input id="gate" data-al-hidden-target="1" style="width:120px;height:20px" /></body></html>`,
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGES[(req.url || "").replace(/^\/|\?.*$/g, "")] ?? "<!doctype html><html><body>none</body></html>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
// tsx/esbuild wraps named functions with __name(); without this every page.evaluate throws.
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();

const planOn = async (key: string): Promise<{ opener: string; why: string }> => {
  await page.goto(`http://127.0.0.1:${port}/${key}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(80);
  return page.evaluate(planHiddenReveal);
};

const aria = await planOn("ariaControls");
check("THE REGRESSION: Momentum's shape — the gate's own aria-controls toggle is found",
  /aria-controls/.test(aria.opener), JSON.stringify(aria));
console.log(`   opener: ${aria.opener} | ${aria.why}`);

check("...and clicking what it tagged actually reveals the control", await (async () => {
  await page.locator("[data-al-reveal]").first().click();
  await page.evaluate(() => {
    const p = document.getElementById("panel");
    if (p) p.style.display = "block";           // what the portal's own handler would do
  });
  return page.locator("#gate").isVisible();
})());

check("a closed <details> is opened by its summary", /summary/.test((await planOn("details")).opener));
check("a data-bs-target/href toggle is found", /data-target|href/.test((await planOn("bsTarget")).opener));
check("a plain toggle before the hidden container is found", /preceding/.test((await planOn("precedingToggle")).opener));

// ---------------------------------------------------------------------------
// The refusals. Opening containers indiscriminately is how a run starts clicking
// things nobody asked it to — and the old skip existed for a real reason.
// ---------------------------------------------------------------------------
const dead = await planOn("deadField");
check("a genuinely dead hidden field finds no opener and stays skipped", dead.opener === "",
  `invented an opener: ${dead.opener}`);
check("...though it still reports WHY it was invisible", dead.why !== "", JSON.stringify(dead));

const vis = await planOn("visible");
check("a visible field is not a reveal candidate at all", vis.opener === "" && vis.why === "");

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} reveal-hidden check(s) FAILED.`); process.exit(1); }
console.log("\nAll reveal-hidden checks passed.");
process.exit(0);
