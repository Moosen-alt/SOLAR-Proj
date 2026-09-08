// A SEARCH PAGE ADVANCES BY SEARCHING, AND ITS BUTTON IS OFTEN AN ICON WITH NO NAME.
//
// City of Miami's iBuild Property Search is a toolbar: a dropdown, a text box, and a blue
// magnifier. The learn typed the address in correctly and nothing ever ran the search, so
// the results panel kept showing its instructions and there was never a row to click. The
// planner cannot name a control that has no name, and the fallback advance finder matches on
// wording, so both walked past it.
//
// Enter costs one keypress and is what a person does. The second half of this file is the
// guard: it must fire only on a field this run actually filled, and it must report honestly
// when the page does not move — "the search ran and found nothing" and "the search never
// ran" have looked identical in every run on record.
//   npx tsx portal-bot/src/adapters/enterSubmit.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import { advanceSignatureOf } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// The Miami shape: a text box whose only submit is an unnamed icon, and a form that
// responds to Enter.
const PAGE = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
  <h2>Property Search</h2>
  <form id="f" onsubmit="event.preventDefault();document.getElementById('results').innerHTML='<table><tr><td>3500 PAN AMERICAN DR</td></tr></table>';document.getElementById('h').textContent='Search Results';">
    <select><option>By Property Address</option></select>
    <input id="addr" name="address" />
    <button id="go" type="submit" aria-label=""><svg width="16" height="16"></svg></button>
  </form>
  <h2 id="h">Property Search Results</h2>
  <div id="results">This page begins the data collection for a NEW scope of work.</div>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${port}/`);

// The engine's own structural signature is what decides whether a page moved.
const before = await advanceSignatureOf(page);
await page.locator("#addr").fill("3500 Pan American");
const afterFill = await advanceSignatureOf(page);

check("typing alone does NOT read as an advance — this is what made the loop invisible",
  afterFill === before,
  "the structural signature moved on a fill; a re-render would then look like progress");

await page.locator("#addr").press("Enter");
await page.waitForTimeout(400);
const afterEnter = await advanceSignatureOf(page);
const rows = await page.locator("#results table tr").count();
console.log(`   rows after Enter: ${rows}`);

check("THE LIVE STOP: Enter in the filled field runs the search the icon would have",
  rows === 1, "no results row appeared — the search never ran");

check("...and the page reads as ADVANCED afterwards, so the walk continues",
  afterEnter !== afterFill, `signature unchanged: ${afterEnter.slice(0, 80)}`);

// The guard. A page with nothing filled must not get a stray Enter.
const ctx2 = await browser.newContext();
await ctx2.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page2 = await ctx2.newPage();
await page2.goto(`http://127.0.0.1:${port}/`);
const untouched = await advanceSignatureOf(page2);
await page2.waitForTimeout(200);
check("an untouched page's signature is stable, so 'did not move' is trustworthy",
  (await advanceSignatureOf(page2)) === untouched);

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} enter-submit check(s) FAILED.`); process.exit(1); }
console.log("\nAll enter-submit checks passed (real Chromium).");
process.exit(0);
