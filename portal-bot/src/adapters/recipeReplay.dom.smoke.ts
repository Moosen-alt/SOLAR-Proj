// REPLAY VERIFICATION in a REAL browser. Every existing recipeAdapter test drives a
// hand-written fake page, so replay had never once been exercised against real Chromium —
// and replay is the path that runs for EVERY project after a portal is learned, so its
// correctness and its cost matter more than the learner's.
//
// Three things this pins that fakes structurally cannot:
//   1. SPEED. RecipeAdapter calls waitForInteractiveControls after every goto and every
//      advancing click. That helper threw "ReferenceError: __name is not defined" on each
//      poll (esbuild's keepNames wraps any nameable function, and __name does not exist in
//      the browser), so it could never return true and burned its full 12s budget every
//      time — dead time replay was never credited with. A fake page has no such helper and
//      would never reveal it.
//   2. BINDINGS. A recorded step must fill THIS project's data, not the values frozen at
//      learn time — the whole point of a shared recipe.
//   3. SAFETY. A step flagged isFinalSubmit must NOT be clicked without autoSubmit.
//
// Run: npx tsx portal-bot/src/adapters/recipeReplay.dom.smoke.ts
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

// A deliberately ACA-shaped page: a visible form plus a HIDDEN input whose id carries the
// same token as a real control (the shape that cost 30s per fill live).
const PAGE = `<!doctype html><html><body>
  <h1>Step 1: General Info</h1>
  <input type="hidden" id="hfIsForNewContactAddress" value="x">
  <label>First:</label><input type="text" id="txtFirstName">
  <label>Address:</label><input type="text" id="txtAppStreetAdd1">
  <label>Zip:</label><input type="text" id="txtZip">
  <select id="ddlState"><option value="">--Select--</option><option value="OR">OR</option><option value="WA">WA</option></select>
  <a id="btnContinue" href="#" onclick="document.getElementById('done').textContent='ADVANCED';return false;"><span>Continue Application &raquo;</span></a>
  <a id="btnSubmit" href="#" onclick="document.getElementById('done').textContent='SUBMITTED';return false;"><span>Submit</span></a>
  <div id="done"></div>
</body></html>`;

const server = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const steps: RecipeStep[] = [
  { action: "goto", phase: "open", value: url, note: "entry url" },
  // BOUND, not frozen: replay must substitute this project's values.
  { action: "fill", phase: "fill", selector: { css: "#txtFirstName" }, field: "homeownerFirstName", value: "LEARN-TIME-NAME", note: "contact: first name" },
  { action: "fill", phase: "fill", selector: { css: "input[id*='StreetAdd' i], input[id*='Address' i]" }, field: "street", value: "LEARN-TIME-STREET", note: "contact: address" },
  { action: "fill", phase: "fill", selector: { css: "#txtZip" }, field: "zip", value: "00000", note: "contact: zip" },
  { action: "select", phase: "fill", selector: { css: "#ddlState" }, field: "state", value: "WA", note: "contact: state" },
  { action: "click", phase: "fill", selector: { role: "link", name: "Continue Application »", exact: true, fallbacks: [{ css: "#btnContinue" }] }, note: "contacts: continue" },
  // MUST NOT be clicked: automation never files the application.
  { action: "click", phase: "review", selector: { css: "#btnSubmit" }, isFinalSubmit: true, note: "final submit: Submit (recorded, NOT clicked)" },
];

const recipe = {
  id: "r1", scopeType: "ahj", profileKey: "or|test|x", state: "OR", ahj: "Test AHJ", utility: "",
  portalPlatform: "accela", portalUrl: url, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "structural",
} as unknown as PortalRecipe;

// THIS project's values — deliberately different from every recorded literal.
const fieldValues = { homeownerFirstName: "Wynema", street: "1075 Flanagan Ave", zip: "97420", state: "OR" };

const browser = await chromium.launch();
const page = await browser.newPage();

const adapter = new RecipeAdapter(recipe, fieldValues, {}, { autoSubmit: false });
(adapter as unknown as { page: unknown }).page = page;

const t0 = Date.now();
const result = await adapter.fillApplication({} as never);
const elapsedMs = Date.now() - t0;

const read = async (sel: string): Promise<string> => page.locator(sel).inputValue().catch(() => "");
const firstName = await read("#txtFirstName");
const street = await read("#txtAppStreetAdd1");
const zip = await read("#txtZip");
const state = await read("#ddlState");
const done = await page.locator("#done").textContent().catch(() => "");

check("replay completes against a real page", () => {
  assert.equal(result.ok, true, `replay failed: ${result.message ?? ""}`);
});
check("bound fields replay THIS project's data, never the learn-time literal", () => {
  assert.equal(firstName, "Wynema", `first name: got ${JSON.stringify(firstName)}`);
  assert.equal(street, "1075 Flanagan Ave", `street: got ${JSON.stringify(street)}`);
  assert.equal(zip, "97420", `zip: got ${JSON.stringify(zip)}`);
  assert.equal(state, "OR", `state select: got ${JSON.stringify(state)}`);
});
check("the recorded advance ran (link with a nested <span>, as ACA renders it)", () => {
  assert.equal(done, "ADVANCED", `expected the Continue link to fire, got ${JSON.stringify(done)}`);
});
check("a step flagged isFinalSubmit is NEVER clicked without autoSubmit", () => {
  assert.notEqual(done, "SUBMITTED", "automation must not file the application");
});
// The readiness gate runs after the goto and after the advancing click. Broken it burned
// 12s EACH; working, this whole replay is a couple of seconds. Generous bound so the test
// reports a real regression rather than machine noise.
check(`replay is not paying the dead readiness budget (took ${(elapsedMs / 1000).toFixed(1)}s)`, () => {
  assert.ok(elapsedMs < 15000, `replay took ${elapsedMs}ms — the readiness gate is timing out again (12s per goto/click)`);
});

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} replay smoke test(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll replay smoke tests passed (real Chromium, ${(elapsedMs / 1000).toFixed(1)}s replay).`);
process.exit(0);
