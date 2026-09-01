// READING A DISAMBIGUATION GRID WITHOUT SWALLOWING THE WHOLE TABLE.
//
// The rows are the choice of whose property we file on. Two ways this misreads:
// the <tr> that wraps the entire grid has innerText covering every row (that is how a capture
// once returned another job's permit number), and "Select" appears in plenty of controls that
// are not a row action. Both are pinned here; the ranking itself is unit-tested separately in
// addressVersion.test.ts.
//   npx tsx portal-bot/src/adapters/addressGrid.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import { rankAddressVersions } from "../addressVersion";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

// The page-side scrape, mirroring chooseProjectAddressRow.
const scrapeRows = (): Array<{ key: string; text: string }> => {
  const vis = (e: Element) => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const out: Array<{ key: string; text: string }> = [];
  let n = 0;
  for (const tr of Array.from(document.querySelectorAll("tr"))) {
    if (!vis(tr)) continue;
    const action = Array.from(tr.querySelectorAll("a, button, [role='button']"))
      .find((a) => /^\s*select\s*$/i.test((a as HTMLElement).innerText || ""));
    if (!action) continue;
    const text = ((tr as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 400) continue;
    const key = `ar${n++}`;
    (action as HTMLElement).setAttribute("data-al-row", key);
    out.push({ key, text });
  }
  return out;
};

// The real Coos Bay grid, plus loose matches from other towns and a decoy control.
const PAGE = `<!doctype html><html><body>
  <button>Select a report</button>
  <table>
    <tr><th>Action</th><th>Address</th><th>Description</th><th>City</th><th>Zip</th><th>Parcel</th><th>Owner</th></tr>
    <tr><td><a href="#">Select</a></td><td>773 KENTUCKY AV, DEQ Applications, COOS BAY Coos OR 97420</td><td>DEQ Applications</td><td>COOS BAY</td><td>97420</td><td>25S13W20CC2503</td><td>GILPIN, BILLY, JR.</td></tr>
    <tr><td><a href="#">Select</a></td><td>773 KENTUCKY AVE, City Applications, EMPIRE, COOS BAY COOS OR 97420</td><td>City Applications</td><td>COOS BAY</td><td>97420</td><td>25S13W20CCTL0250300</td><td>SAKSCHEWSKI, GERHARD</td></tr>
    <tr><td><a href="#">Select</a></td><td>773 KENTUCKY AVE, COUNTY APPLICATIONS, COOS BAY COOS OR 97420</td><td>COUNTY APPLICATIONS</td><td>COOS BAY</td><td>97420</td><td>25S1320CC02503</td><td>HUISMAN, VINCENT</td></tr>
    <tr><td><a href="#">Select</a></td><td>773 KENTUCKY ST, PORTLAND OR 97213</td><td>City Applications</td><td>PORTLAND</td><td>97213</td><td>1N2E32DA10900</td><td>SOMEONE ELSE</td></tr>
  </table>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/`);

const rows = await page.evaluate(scrapeRows);
console.log(`  scraped ${rows.length} row(s)`);

check("only rows with a Select ACTION are rows — the header and a stray 'Select a report' are not",
  rows.length === 4, `got ${rows.length}`);

check("each row carries only its OWN text, not the whole table",
  rows.every((r) => (r.text.match(/KENTUCKY/g) || []).length === 1),
  JSON.stringify(rows.map((r) => r.text.slice(0, 40))));

const IVY = { city: "Coos Bay", zip: "97420", homeownerName: "Christopher Ivy" };
const pick = (isElectrical: boolean) => {
  const { ranked, rejected } = rankAddressVersions(rows.map((r) => r.text), { ...IVY, isElectrical });
  return { top: ranked[0]?.text ?? "", count: ranked.length, rejected: rejected.length };
};

const structural = pick(false);
check("structural picks the CITY version", /City Applications/.test(structural.top), structural.top.slice(0, 60));

const electrical = pick(true);
check("electrical picks the COUNTY version", /COUNTY APPLICATIONS/.test(electrical.top), electrical.top.slice(0, 60));

check("the Portland row is REJECTED, not merely ranked low",
  structural.count === 3 && structural.rejected === 1, JSON.stringify(structural));

check("DEQ is never the pick for either discipline",
  !/DEQ/.test(structural.top) && !/DEQ/.test(electrical.top));

// The tagged action is clickable and is the one we ranked.
const { ranked } = rankAddressVersions(rows.map((r) => r.text), { ...IVY, isElectrical: true });
const best = rows[ranked[0].index];
const tagged = await page.locator(`[data-al-row="${best.key}"]`).count();
check("the ranked row's Select control is tagged and reachable", tagged === 1, `found ${tagged}`);

// A grid with nothing belonging to this project must yield no candidate at all.
const elsewhere = rankAddressVersions(
  ["Select 12 MAIN ST, City Applications, BEND OR 97701 BEND OR 97701 OWNER X"],
  { ...IVY, isElectrical: false },
);
check("a grid holding only other properties yields no candidate — the caller refuses to file",
  elsewhere.ranked.length === 0 && elsewhere.rejected.length === 1);

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} address-grid check(s) FAILED.`); process.exit(1); }
console.log("\nAll address-grid checks passed (real Chromium).");
process.exit(0);
