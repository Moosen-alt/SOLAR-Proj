// AN ADVANCE OFF A PAGE YOU JUST FILLED IS NEVER "AN EXTRA ADVANCE".
//
// PowerClerk's wizard reuses ONE contact block across consecutive pages: "Preparer
// Information" and "Customer Information" carry byte-identical labels — Name, Last,
// Address, City, State, Zip, Email, Phone — at the same URL, with the same control ids.
//
// The guard that skips an advance a jurisdiction does not need decides by LABEL OVERLAP:
// "the next section's fields are already on this page, so this Next is redundant." On a
// portal with identical contact blocks that is always true, so it skipped the real advance
// from Preparer to Customer and the homeowner steps wrote over the installer's.
//
// Measured on a live PacifiCorp interconnection application: Charles Bitton of TML
// INTERNATIONAL LLC, 808 SE Chkalov Dr, Vancouver WA — replaced in the PREPARER block by
// the homeowner Randal Rowland at his own site address. Both the recipe bindings
// (installerFirstName vs homeownerFirstName) and the backend resolution were CORRECT. Only
// replay's page tracking was wrong, which is why nothing upstream could catch it. Recorded
// steps carry section:"" so there is no heading to disambiguate with — but "we just wrote
// to this page" is decisive on its own and needs nothing recorded.
//
// Case 2 is the guard this must not break: a genuinely duplicate advance, with no fills
// between, still has to be skipped (the Oregon ePermitting page-count case).
//
// Run: npx tsx portal-bot/src/adapters/identicalSections.dom.smoke.ts
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

// One set of controls, reused by every section — the PowerClerk shape. Next banks the
// current values under the section name and clears the inputs for the next section, so
// whatever each section ENDED UP WITH is inspectable afterwards.
const PAGE = `<!doctype html><html><body>
  <h2 id="heading">Preparer Information</h2>
  <form id="f">
    <label for="f_name">Name</label><input id="f_name">
    <label for="f_last">Last</label><input id="f_last">
    <label for="f_addr">Address</label><input id="f_addr">
  </form>
  <button id="next" type="button">Next</button>
  <script>
    window.__sections = ['Preparer Information', 'Customer Information', 'System'];
    window.__at = 0;
    window.__saved = {};
    document.getElementById('next').addEventListener('click', function () {
      var name = document.getElementById('f_name');
      var last = document.getElementById('f_last');
      var addr = document.getElementById('f_addr');
      window.__saved[window.__sections[window.__at]] = {
        name: name.value, last: last.value, addr: addr.value,
      };
      if (window.__at < window.__sections.length - 1) window.__at++;
      name.value = ''; last.value = ''; addr.value = '';
      document.getElementById('heading').textContent = window.__sections[window.__at];
    });
  </script>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const mkRecipe = (steps: RecipeStep[]) => ({
  id: "is1", scopeType: "utility", profileKey: "or||pacific power", state: "OR", ahj: "", utility: "Pacific Power",
  portalPlatform: "powerclerk", portalUrl: url, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

// BOTH CONTACT BLOCKS ARE BOUND, AND TO DIFFERENT KEYS — WHICH IS THE POINT OF THE SMOKE.
//
// These steps used to freeze the literals with no `field`, and since 3e42fec the
// cross-project guard refuses an unbound literal that looks like project data:
// looksLikeProjectData("Address", "808 SE Chkalov Dr") is true, and with the bare-"Name"
// widening so is looksLikeProjectData("Name", "Charles"). Both addresses and both names came
// back BLANK, so the two sections were indistinguishable by being equally empty and the
// subject of this test — that the installer's details stay in the preparer block and the
// homeowner's land in the customer block — was no longer being measured at all.
//
// A real recorded step carries the binding, and the live PacifiCorp recipe this file was
// written from carries exactly these: installerFirstName/installerLastName/installerStreet in
// the preparer block, homeownerFirstName/homeownerLastName/street in the customer block. Two
// DISTINCT key sets resolving two DISTINCT values, so a section that gets the wrong one still
// fails the way the unbound version used to — binding both blocks to one key would make this
// smoke pass while testing nothing.
//
// installerFirstName/installerLastName are absent from RECIPE_FIELD_DESCRIPTIONS but are NOT
// unanswerable: resolveRecipeFieldValues derives them by splitting the client overlay's
// installerContactName (the `installerSplit` block), and autoLearn's bindableFields is the
// UNION of that resolved map with the descriptions dictionary. A key the resolver cannot
// answer would turn each literal into a permanent blank, which is worse than the red here.
const FIELD_VALUES: Record<string, string> = {
  installerFirstName: "Charles", installerLastName: "Bitton", installerStreet: "808 SE Chkalov Dr",
  homeownerFirstName: "Randal", homeownerLastName: "Rowland", street: "7625 NW Logan Rd",
};

const f = (css: string, field: string, note: string): RecipeStep =>
  ({ action: "fill", phase: "fill", selector: { css }, field, value: FIELD_VALUES[field], note } as RecipeStep);
const advance: RecipeStep = { action: "click", phase: "fill", selector: { css: "#next" }, note: "advance: Next" } as RecipeStep;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

// CASE 1 — installer section, advance, homeowner section. The two sections are
// indistinguishable by label, which is exactly the live shape.
const p1 = await context.newPage();
await p1.goto(url);
const a1 = new RecipeAdapter(mkRecipe([
  f("#f_name", "installerFirstName", "Name"), f("#f_last", "installerLastName", "Last"), f("#f_addr", "installerStreet", "Address"),
  advance,
  f("#f_name", "homeownerFirstName", "Name"), f("#f_last", "homeownerLastName", "Last"), f("#f_addr", "street", "Address"),
  advance,
]), FIELD_VALUES, {}, { autoSubmit: false });
(a1 as unknown as { page: unknown }).page = p1;
const r1 = await a1.fillApplication({} as never);
const saved = await p1.evaluate(() => (window as unknown as { __saved: Record<string, { name: string; last: string; addr: string }> }).__saved);

check("the replay completes", () => {
  assert.equal(r1.ok, true, `run failed: ${String(r1.message ?? "").slice(0, 200)}`);
});
check("the INSTALLER's details survive in the preparer section", () => {
  assert.deepEqual(saved["Preparer Information"], { name: "Charles", last: "Bitton", addr: "808 SE Chkalov Dr" },
    `the homeowner overwrote the installer — got ${JSON.stringify(saved["Preparer Information"])}`);
});
check("the HOMEOWNER's details land in the customer section", () => {
  assert.deepEqual(saved["Customer Information"], { name: "Randal", last: "Rowland", addr: "7625 NW Logan Rd" },
    `got ${JSON.stringify(saved["Customer Information"])}`);
});

// CASE 2 — THE GUARD THIS MUST NOT BREAK. Two advances in a row with NO fills between:
// the recipe carries one more advance than this portal needs, and skipping it is correct.
// Reaching "System" would mean we sailed past the customer page.
const p2 = await context.newPage();
await p2.goto(url);
const a2 = new RecipeAdapter(mkRecipe([
  advance,
  advance,
  f("#f_name", "homeownerFirstName", "Name"), f("#f_last", "homeownerLastName", "Last"), f("#f_addr", "street", "Address"),
]), FIELD_VALUES, {}, { autoSubmit: false });
(a2 as unknown as { page: unknown }).page = p2;
const r2 = await a2.fillApplication({} as never);
const heading = await p2.locator("#heading").innerText();

check("a genuinely duplicate advance is still skipped", () => {
  assert.equal(r2.ok, true, `run failed: ${String(r2.message ?? "").slice(0, 200)}`);
  assert.equal(heading, "Customer Information",
    `the redundant advance was taken and the run overshot to ${JSON.stringify(heading)}`);
});

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} identical-section smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll identical-section smoke tests passed (real Chromium).");
process.exit(0);
