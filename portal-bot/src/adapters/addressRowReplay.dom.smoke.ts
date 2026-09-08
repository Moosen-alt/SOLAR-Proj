// REPLAY MUST PICK THIS PROJECT'S ROW, NOT THE ONE THE RECIPE WAS LEARNED ON.
//
// A recipe is shared across every project under the profile, so the one thing a recorded
// address-row click must never do is replay the learn project's parcel. The row carries no
// stable selector — Miami's grid binds its handler in script, so there is nothing to record
// but the row's text, and the row's text is the learn project's address.
//
// So the step records a marker selector that CANNOT resolve at replay, on purpose, and the
// matcher re-derives the row from the replay project's own address. Two things had to be
// true for that to work, and neither was:
//
//   - the fallback was keyed on !succeeded, which is only false after an exhausted timeout.
//     A selector that resolves to NOTHING returns false, is logged SKIPPED, and sets
//     succeeded=true — so the marker selector, which is designed to resolve to nothing,
//     would have skipped the step silently and never run the matcher at all;
//   - the matcher required a link in the row, and read the row with tr.textContent, which
//     fuses adjacent cells ("3500 PAN AMERICAN DRCITY OF MIAMI").
//
//   npx tsx portal-bot/src/adapters/addressRowReplay.dom.smoke.ts
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

// Miami's shape: sort links in the header, body rows with no link and no onclick attribute,
// and a delegated handler — the thing a recorded selector cannot capture.
const PAGE = `<!doctype html><html><body style="font:14px sans-serif">
  <h2>Property Search Results</h2>
  <table id="grid">
    <thead><tr><th><a href="?sort=addr">Address</a></th><th><a href="?sort=folio">Folio</a></th><th><a href="?sort=owner">Owner</a></th></tr></thead>
    <tbody>
      <tr id="r-learn"><td style="text-decoration:underline">925 N GRANT ST</td><td>0001</td><td>SOMEONE ELSE</td></tr>
      <tr id="r-this"><td style="text-decoration:underline">3500 PAN AMERICAN DR</td><td>0141220020010</td><td>CITY OF MIAMI</td></tr>
      <tr id="r-decoy"><td style="text-decoration:underline">3500 PAN AMERICAN BLVD</td><td>0002</td><td>NOT THE SAME STREET</td></tr>
    </tbody>
  </table>
  <div id="picked"></div>
  <script>
    document.getElementById("grid").addEventListener("click", function (e) {
      var tr = e.target.closest("tr");
      if (!tr || tr.closest("thead")) return;
      document.getElementById("picked").textContent = tr.id;
      document.querySelector("h2").textContent = "Application Details";
    });
  </script>
</body></html>`;

const server = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const steps: RecipeStep[] = [
  { action: "goto", phase: "open", value: url, note: "entry url" },
  {
    action: "click", phase: "fill",
    // Exists only during the learn click. Resolving to nothing at replay is the design.
    selector: { css: '[data-al-resultrow="1"]' },
    note: 'address row: pick the search result matching this project\'s address (learned on "925 N GRANT ST")',
  },
];

const makeRecipe = (): PortalRecipe => ({
  id: "r1", scopeType: "ahj", profileKey: "fl|miami|x", state: "FL", ahj: "Miami", utility: "",
  portalPlatform: "ibuild", portalUrl: url, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "structural",
} as unknown as PortalRecipe);

const browser = await chromium.launch();
// Production pages get this from openPortal (browser.ts NAME_SHIM); esbuild's keepNames
// wraps nameable functions as __name(fn) and a raw page has no such global.
const ctx = await browser.newContext();
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

// ---------------------------------------------------------------------------
// MUST PASS — the replay project's row, chosen by its own address.
// ---------------------------------------------------------------------------
{
  const page = await ctx.newPage();
  const adapter = new RecipeAdapter(makeRecipe(), { streetNumber: "3500", street: "3500 Pan American Dr" }, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = page;
  const result = await adapter.fillApplication({} as never);
  const picked = (await page.locator("#picked").textContent().catch(() => "")) ?? "";
  console.log(`   picked: ${JSON.stringify(picked)}  ok=${result.ok}`);
  console.log(`   result: ${JSON.stringify(result).slice(0, 900)}`);

  check("replay clicks the row for THIS project, not the one the recipe was learned on", () => {
    assert.equal(picked, "r-this", `clicked ${JSON.stringify(picked)} — "r-learn" means the recipe froze the learn project's parcel`);
  });
  check("...and does not settle for a same-numbered street with the wrong type (DR vs BLVD)", () => {
    assert.notEqual(picked, "r-decoy", "the street type has to count, or the wrong parcel gets filed");
  });
  check("...and the run reports success rather than a silent skip", () => {
    assert.equal(result.ok, true, `replay failed: ${result.message ?? ""}`);
  });
  await page.close();
}

// ---------------------------------------------------------------------------
// MUST EXCLUDE — an address the search did not return is not matched to some other row.
// ---------------------------------------------------------------------------
{
  const page = await ctx.newPage();
  const adapter = new RecipeAdapter(makeRecipe(), { streetNumber: "77", street: "77 Nowhere Way" }, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = page;
  await adapter.fillApplication({} as never);
  const picked = (await page.locator("#picked").textContent().catch(() => "")) ?? "";
  console.log(`   picked for an absent address: ${JSON.stringify(picked)}`);
  check("an address that is not in the results clicks NO row", () => {
    assert.equal(picked, "", `clicked ${JSON.stringify(picked)} — filing against whatever row came first is worse than not filing`);
  });
  await page.close();
}

await browser.close();
server.close();
if (failures > 0) { console.error(`\naddressRowReplay.dom.smoke: ${failures} FAILURE(S)`); process.exit(1); }
console.log("\naddressRowReplay.dom.smoke: PASS");
process.exit(0);
