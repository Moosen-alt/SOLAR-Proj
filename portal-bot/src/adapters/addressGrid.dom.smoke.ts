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
    const actions = Array.from(tr.querySelectorAll("a, button, [role='button']"))
      .filter((a) => /^\s*select\s*$/i.test((a as HTMLElement).innerText || ""));
    if (actions.length !== 1) continue;
    const action = actions[0];
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

// THE WRAPPER ROW IS NOT AN ADDRESS VERSION.
//
// ACA nests the results grid inside an outer layout table, so a text match on a row matches
// the city's row AND the wrapper <tr> holding the whole grid — and the wrapper comes FIRST in
// document order. Live on Marineau's structural filing at 1780 Ocean Blvd: the pass aimed at
// the city row with tr:has-text("CITY APPLICATIONS") a:has-text("Select") and .first() handed
// it the wrapper, whose first Select link belongs to the COUNTY row. The page then offered
// only Coos County's services (Commercial - Electrical, Residential - Electrical), the city's
// structural type was never on the page, and the run spent twelve pages being refused.
await page.setContent(`<!doctype html><html><body>
  <table><tr><td>
    <table>
      <tr><td><a href="#" id="county">Select</a></td><td>1780 OCEAN BLVD SE, COUNTY APPLICATIONS, COOS BAY COOS OR 97420</td><td>COUNTY APPLICATIONS</td><td>COOS BAY</td></tr>
      <tr><td><a href="#" id="city">Select</a></td><td>1780 OCEAN BLVD, City Applications, COOS BAY, COOS BAY COOS OR 97420</td><td>City Applications</td><td>COOS BAY</td></tr>
      <tr><td><a href="#" id="deq">Select</a></td><td>1780 SE OCEAN BV, DEQ Applications, COOS BAY Coos OR 97420</td><td>DEQ Applications</td><td>COOS BAY</td></tr>
    </table>
  </td></tr></table>
</body></html>`);

const matching = page.locator("tr", { hasText: /CITY APPLICATIONS/i }).filter({ hasText: "COOS BAY" });
const matchCount = await matching.count();
check("a text match on the city row also matches the wrapper holding every row",
  matchCount > 1, `only ${matchCount} matched — the nesting this pins is gone`);

// THE REGRESSION, stated as the DOM sees it.
const naive = await matching.getByRole("link", { name: /^Select$/i }).first().getAttribute("id");
check("THE BUG: .first() over those matches reaches the COUNTY row's Select",
  naive === "county", `resolved to #${naive}`);

// The rule leafRowSelectLink applies: a leaf row offers exactly ONE Select, a wrapper offers
// one per address. Counting them is exact — the text-length cap this replaced only guessed,
// and a three-row grid sits comfortably under it.
let leafId: string | null = null;
for (let i = 0; i < matchCount; i++) {
  const links = matching.nth(i).getByRole("link", { name: /^Select$/i });
  if (await links.count() === 1) { leafId = await links.first().getAttribute("id"); break; }
}
check("the leaf row's Select is the CITY's — the version this filing needs", leafId === "city", `resolved to #${leafId}`);

// And the scrape the ranked chooser uses never sees the wrapper at all.
const nestedRows = await page.evaluate(scrapeRows);
check("the ranked chooser scrapes 3 versions, not 4", nestedRows.length === 3, `got ${nestedRows.length}`);
const nestedPick = rankAddressVersions(nestedRows.map((r) => r.text), {
  city: "Coos Bay", zip: "97420", homeownerName: "Ann Marineau", isElectrical: false,
});
check("and ranks the CITY version first for a structural filing",
  /City Applications/.test(nestedPick.ranked[0]?.text ?? ""), (nestedPick.ranked[0]?.text ?? "").slice(0, 60));

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} address-grid check(s) FAILED.`); process.exit(1); }
console.log("\nAll address-grid checks passed (real Chromium).");
process.exit(0);
