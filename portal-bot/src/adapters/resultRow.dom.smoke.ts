// A SEARCH THAT RETURNS RESULTS IS ANSWERED BY CLICKING A RESULT.
//
// Miami's iBuild Property Search finds the parcel and renders one row whose only clickable
// thing is a <td> the portal underlined and coloured blue:
//
//   <td style="text-decoration: underline; color:darkblue;">3500 PAN AMERICAN DR</td>
//
// No <a>, no <button>, no onclick attribute — a Telerik grid handler bound in script. The
// field extractor cannot see it, the planner is never offered it, and the only submit-shaped
// things on the page are two <input type=submit id="btnSubmit"> that are display:none. The
// walk clicked one of those four times and stopped.
//
// The replay-side matcher that already existed required `tr.querySelector("a")` — Accela's
// shape, where every row carries a "Select" link. That rule found nothing on every grid that
// is not Accela.
//
// Both directions matter here. Clicking the wrong row files against the wrong parcel, which
// is worse than not filing at all, so:
//   MUST PASS    — the row for this project's address is found and the clickable cell marked.
//   MUST EXCLUDE — header rows (whose sort links are the ONLY <a>s in Miami's grid), rows
//                  for a different property, and an ambiguous result set with no tiebreak.
//
//   npx tsx portal-bot/src/adapters/resultRow.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import { markAddressRow, type AddressRowPick } from "./rowChooser";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// Miami's grid, reproduced: sort links in the header, a linkless body row, and the two
// hidden submits the planner kept choosing instead.
const MIAMI = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
  <h2>Property Search Results</h2>
  <input type="submit" name="btnSearch" id="btnSearch" style="display:none" value="">
  <table id="grid"><thead class="t-grid-header"><tr>
      <th><a class="t-link" href="?Grid-orderBy=Address-asc">Address</a></th>
      <th><a class="t-link" href="?Grid-orderBy=Folio-asc">Folio</a></th>
      <th><a class="t-link" href="?Grid-orderBy=owner-asc">Owner</a></th>
    </tr></thead>
    <tbody>
      <tr id="hit"><td style="text-decoration: underline; color:darkblue;">3500 PAN AMERICAN DR</td><td>0141220020010</td><td>CITY OF MIAMI</td></tr>
      <tr id="other"><td style="text-decoration: underline; color:darkblue;">412 MAIN ST</td><td>0141370380020</td><td>SOMEBODY ELSE</td></tr>
    </tbody></table>
  <input type="submit" name="btnSubmit" id="btnSubmit" style="display:none" value="">
</body></html>`;

// Accela's shape, for the other half of the discipline: the same address in two
// jurisdictions, each row carrying an identical "Select" link.
const ACCELA = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
  <table><thead><tr><th>Action</th><th>Address</th></tr></thead>
    <tbody>
      <tr><td><a href="#pick-city">Select</a></td><td>925 N GRANT ST — CITY APPLICATIONS</td></tr>
      <tr><td><a href="#pick-county">Select</a></td><td>925 N GRANT ST — COUNTY APPLICATIONS</td></tr>
    </tbody></table>
</body></html>`;

const pages: Record<string, string> = { "/miami": MIAMI, "/accela": ACCELA };
const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(pages[q.url ?? "/miami"] ?? MIAMI);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await ctx.newPage();
const mark = async (want: string, prefer?: "city" | "county"): Promise<AddressRowPick | null> =>
  (await page.evaluate(markAddressRow, { want, prefer }).catch(() => null)) as AddressRowPick | null;

// ---------------------------------------------------------------------------
// MUST PASS — the linkless row is found, and the marker lands on the cell.
// ---------------------------------------------------------------------------
await page.goto(`http://127.0.0.1:${port}/miami`);
const hit = await mark("3500 Pan American Dr");
console.log(`   miami pick: ${JSON.stringify(hit)}`);
check("a results row with no link and no button is still found",
  !!hit && /3500 PAN AMERICAN DR/i.test(hit.text),
  `got ${JSON.stringify(hit)} — requiring an <a> in the row is Accela's shape, not every portal's`);
check("...and the marker lands on the cell the portal styled as clickable",
  hit?.via === "cell",
  `via=${hit?.via}`);
const markedIn = await page.locator('[data-al-rowpick="1"]').evaluate((el) => (el.closest("tr") as HTMLElement)?.id ?? "").catch(() => "?");
check("...inside the RIGHT row",
  markedIn === "hit",
  `the marker landed in row "${markedIn}"`);

// "DR" against "Drive" — a portal writes one, a plan set the other.
check("street types are matched normalised (DR ~ Drive)",
  !!(await mark("3500 Pan American Drive")),
  "the suffix expansion did not match");

// ---------------------------------------------------------------------------
// MUST EXCLUDE — the ways this could file against the wrong parcel.
// ---------------------------------------------------------------------------
await page.goto(`http://127.0.0.1:${port}/miami`);
const wrong = await mark("77 Nowhere Blvd");
check("an address that is not in the results is NOT matched to some other row",
  wrong === null,
  `got ${JSON.stringify(wrong)}`);

// The header's sort links are the only <a>s on this page. Marking one would click
// "sort by Address" and read as a successful advance.
const headerLink = await page.locator('thead [data-al-rowpick="1"]').count();
check("the header row and its sort links are never the pick",
  headerLink === 0,
  `${headerLink} marker(s) landed in <thead>`);

await page.goto(`http://127.0.0.1:${port}/accela`);
const ambiguous = await mark("925 N Grant St");
check("two jurisdictions for one address, with no tiebreak, is a REFUSAL not a guess",
  ambiguous === null,
  `got ${JSON.stringify(ambiguous)} — picking one files with the wrong authority`);

const city = await mark("925 N Grant St", "city");
console.log(`   accela city pick: ${JSON.stringify(city)}`);
check("...and with the tiebreak it picks the city row, via its Select link",
  !!city && /CITY APPLICATIONS/i.test(city.text) && city.via === "link",
  `got ${JSON.stringify(city)}`);
const county = await mark("925 N Grant St", "county");
check("...and the county row when the discipline says county",
  !!county && /COUNTY APPLICATIONS/i.test(county.text),
  `got ${JSON.stringify(county)}`);

await browser.close();
server.close();
console.log(failures === 0 ? "resultRow.dom.smoke: PASS" : `resultRow.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
