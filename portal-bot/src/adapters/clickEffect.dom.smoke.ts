// "IN-PAGE ACTION, OR AN ADVANCE THAT SILENTLY DID NOTHING" -- A DIAGNOSTIC THAT SAID SO.
//
// That sentence fired on four of five portals in the stored sweep and was the single biggest
// reason otherwise-correct filings could not score clean. Its own text admits the problem:
// it names two opposite outcomes and declines to choose, so a "Calculate" that computed a
// total scored the same as an advance the portal had silently swallowed.
//
// The page identity check could not tell them apart BY DESIGN -- it fingerprints headings
// and control ids and deliberately ignores values, which is right for "are we still on the
// same page" and useless for "did anything happen". The second look is values, option
// counts and row counts.
//
// Both shapes below are ordinary. A totals button that writes into a read-only field is the
// common form of every equipment page; a button wired to nothing is what a swallowed click
// looks like from the outside. Neither is portal-specific.
//   npx tsx portal-bot/src/adapters/clickEffect.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const PAGE = `<!doctype html><html><head><style>body{font:14px sans-serif;padding:16px}</style></head><body>
  <h2>System Details</h2>
  <label for="qty">Modules</label><input id="qty" value="18" />
  <label for="total">Total kW DC</label><input id="total" value="" readonly />
  <button id="calc" type="button">Calculate</button>
  <button id="dead" type="button">Continue</button>
  <script>
    document.getElementById("calc").addEventListener("click", function () {
      // The ordinary shape: writes a value, does not navigate, leaves the heading alone.
      document.getElementById("total").value = "7.20";
    });
    // #dead is wired to nothing at all -- a click the portal swallows.
  </script>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const recipeFor = (sel: string, note: string): PortalRecipe => ({
  id: "ce1", scopeType: "utility", profileKey: "or|unknown|pacific power", state: "OR",
  ahj: "", utility: "Pacific Power", portalPlatform: "powerclerk", portalUrl: url,
  status: "complete", version: 1,
  steps: [{ action: "click", phase: "fill", field: "", note, selector: { css: sel } }] as unknown as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

const runOne = async (sel: string, note: string): Promise<{ drift: string[]; aging: string[] }> => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await context.newPage();
  await page.goto(url);
  const adapter = new RecipeAdapter(recipeFor(sel, note), {}, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = page;
  const res = await adapter.fillApplication({} as never);
  const data = (res as unknown as { data?: { driftWarnings?: string[]; agingNotes?: string[] } }).data ?? {};
  await browser.close();
  return { drift: data.driftWarnings ?? [], aging: data.agingNotes ?? [] };
};

// ---------------------------------------------------------------------------
const calc = await runOne("#calc", "compute totals: Calculate");
console.log(`   Calculate -> drift ${JSON.stringify(calc.drift.slice(0, 2))}`);
console.log(`             -> aging ${JSON.stringify(calc.aging.slice(0, 2))}`);

check("THE FIX: a click that FILLED A VALUE is recognised as the in-page action it is",
  calc.aging.some((w) => /acted on the page without advancing/i.test(w)),
  `no aging note; drift=${JSON.stringify(calc.drift)}`);

check("...and it does NOT block a clean score",
  !calc.drift.some((w) => /left the page unchanged|changed nothing on the page/i.test(w)),
  JSON.stringify(calc.drift));

const dead = await runOne("#dead", "contacts: Continue");
console.log(`   dead button -> drift ${JSON.stringify(dead.drift.slice(0, 2))}`);

check("A CLICK THAT DID NOTHING AT ALL still blocks — the fix must not wave everything through",
  dead.drift.some((w) => /changed nothing on the page/i.test(w)),
  `a swallowed click was declassified: drift=${JSON.stringify(dead.drift)} aging=${JSON.stringify(dead.aging)}`);

check("...and the message names what was checked, not two possibilities",
  dead.drift.some((w) => /no value, row or option moved/i.test(w)),
  JSON.stringify(dead.drift));

server.close();
if (failures) { console.error(`\n${failures} click-effect check(s) FAILED.`); process.exit(1); }
console.log("\nAll click-effect checks passed (real Chromium).");
process.exit(0);
