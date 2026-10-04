// PICK THE SEARCH-RESULT ROW THAT IS THIS PROJECT'S ADDRESS.
//
// Oregon ePermitting is ONE statewide Accela portal serving ~100 jurisdictions, and the
// jurisdiction is decided by the ADDRESS SEARCH inside the Apply wizard. So one recipe can
// serve every participating city — except the recorded row selector does not generalise:
//
//     tr:has-text("CITY APPLICATIONS") a:has-text("Select")
//
// "CITY APPLICATIONS" is how COOS BAY labels its row. Another city labels it its own way,
// the selector misses, and the recorded fallback is a bare "Select" link that takes whatever
// row comes first — the county's offering instead of the city's, or another parcel entirely.
//
// Matching the ADDRESS instead has to survive the way portals and plan sets disagree: a
// portal writes "SE" where a plan set writes "Southeast", "St" for "Street". That exact
// mismatch already showed up in the accuracy harness ("50030 SE Testing Way" vs the CRM's
// "15622 Southeast Vivian Way").
//
// Run: npx tsx portal-bot/src/adapters/addressRow.dom.smoke.ts
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

// A results table shaped like ACA's: several jurisdictions and several parcels, with the
// portal's own abbreviations. The recorded "CITY APPLICATIONS" label is deliberately absent,
// exactly as it would be in a city other than the one the recipe was learned on.
const PAGE = `<!doctype html><html><body>
  <h2>Address Search Results</h2>
  <table>
    <tr><td>1002 SE 25TH ST, HOOD RIVER OR 97031</td><td>HOOD RIVER COUNTY</td><td><a href="#" onclick="pick('county');return false;">Select</a></td></tr>
    <tr><td>1002 SE 25TH ST, HOOD RIVER OR 97031</td><td>CITY OF HOOD RIVER</td><td><a href="#" onclick="pick('city');return false;">Select</a></td></tr>
    <tr><td>1010 SE 25TH ST, HOOD RIVER OR 97031</td><td>CITY OF HOOD RIVER</td><td><a href="#" onclick="pick('neighbour');return false;">Select</a></td></tr>
  </table>
  <div id="picked"></div>
  <script>function pick(w){document.getElementById('picked').textContent=w;}</script>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

const pickWith = async (streetNumber: string, street: string): Promise<{ picked: string; returned: string }> => {
  const page = await context.newPage();
  await page.goto(url);
  const recipe = { id: "ar", scopeType: "ahj", profileKey: "or|x|y", state: "OR", ahj: "X", utility: "",
    portalPlatform: "accela", portalUrl: url, status: "complete", version: 1, steps: [] as RecipeStep[],
    createdBy: "t", createdAt: "", updatedAt: "", notes: "", discipline: "structural" } as unknown as PortalRecipe;
  const a = new RecipeAdapter(recipe, { streetNumber, street }, {}, { autoSubmit: false });
  (a as unknown as { page: unknown }).page = page;
  const returned = await (a as unknown as { pickAddressRow(n: string, s: string, p?: string): Promise<string> })
    .pickAddressRow(streetNumber, street, "city");
  const picked = (await page.locator("#picked").textContent().catch(() => "")) ?? "";
  await page.close();
  return { picked, returned };
};

// The plan set writes "Southeast" and "Street"; the portal writes "SE" and "ST".
const spelled = await pickWith("1002", "1002 Southeast 25th Street");
check("a spelled-out directional matches the portal's abbreviation (Southeast -> SE)", () => {
  assert.notEqual(spelled.returned, "", "no row matched — the whole point is surviving this difference");
});
check("...and it is NOT the neighbouring parcel on the same street", () => {
  assert.notEqual(spelled.picked, "neighbour", "1002 must never select 1010 — the street number has to match too");
});

// The abbreviated form the plan set usually carries.
const abbrev = await pickWith("1002", "1002 SE 25th St");
check("the abbreviated form matches too", () => {
  assert.notEqual(abbrev.returned, "", `expected a match; got ${JSON.stringify(abbrev.returned)}`);
});

// AMBIGUITY MUST NOT BE GUESSED. Two rows carry this address (county and city), so without
// something to separate them the right answer is to decline and let the human choose rather
// than file against the wrong jurisdiction.
// ACA lists the SAME address once per jurisdiction. A structural permit files with the
// CITY and an electrical one with the COUNTY, which is the tiebreak the recorded note
// carries ("select city/structural address row"). Requiring a globally unique row would
// refuse on essentially every real search.
check("city vs county is resolved by the permit discipline, not guessed", () => {
  assert.equal(spelled.picked, "city", `structural must take the CITY row; got ${JSON.stringify(spelled.picked)}`);
  assert.notEqual(spelled.picked, "county");
});

// A street that is not in the results at all.
const missing = await pickWith("4242", "4242 Nowhere Ave");
check("an address that is not in the results matches nothing", () => {
  assert.equal(missing.returned, "", `got ${JSON.stringify(missing.returned)}`);
  assert.equal(missing.picked, "", "nothing should have been clicked");
});

await browser.close();
server.close();
if (failures > 0) { console.error(`\n${failures} address-row smoke test(s) FAILED.`); process.exit(1); }
console.log("\nAll address-row smoke tests passed (real Chromium).");
process.exit(0);
