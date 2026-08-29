// REPLAY VERIFICATION for the POWERCLERK (utility NEM) shape, in real Chromium.
// The Accela replay smoke covers an ASP.NET postback form; PowerClerk is a different
// animal and the live PGE recipe (60 steps) is built almost entirely from selector kinds
// the Accela fixture never exercises: 30 label lookups, 12 placeholders, 12 role+name
// clicks, 10 selects, 4 uploads — and NOT ONE recorded nth. Its quirks are documented in
// CLAUDE.md and each has bitten before:
//   - per-field AUTOSAVE commits on blur, so a fill that never blurs is silently lost;
//   - model selects CASCADE-LOAD ~600ms after the manufacturer changes, so selecting
//     immediately finds an empty option list;
//   - equipment "Model" labels are BARE and repeat per section.
// Run: npx tsx portal-bot/src/adapters/powerClerkReplay.dom.smoke.ts
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

// A PowerClerk-shaped page: labelled inputs, a placeholder-only input, a cascading
// manufacturer -> model pair, an autosave indicator that only updates on BLUR, and a
// hidden twin of the account field (the shape that broke Accela replay).
const PAGE = `<!doctype html><html><body>
  <h2>Interconnection Application</h2>
  <input type="hidden" id="hdnAccountNumber" value="stale">
  <label for="acct">Utility Account Number</label><input id="acct" type="text">
  <input id="phone" type="text" placeholder="(###) ###-####">
  <label for="mfr">Manufacturer</label>
  <select id="mfr"><option value="">Please select...</option><option value="Enphase">Enphase</option></select>
  <label for="model">Model</label>
  <select id="model"><option value="">Please select...</option></select>
  <label for="commdate">Estimated Commissioning Date</label><input id="commdate" type="text">
  <div id="saved">unsaved</div>
  <a id="next" href="#" onclick="document.getElementById('done').textContent='ADVANCED';return false;"><span>Next</span></a>
  <div id="done"></div>
  <script>
    // Autosave commits on BLUR only — a fill that never blurs is lost.
    for (const id of ['acct','phone']) {
      document.getElementById(id).addEventListener('blur', function () {
        document.getElementById('saved').textContent = 'saved:' + this.value;
      });
    }
    // Model options cascade-load ~600ms after the manufacturer changes.
    document.getElementById('mfr').addEventListener('change', function () {
      setTimeout(function () {
        var m = document.getElementById('model');
        m.innerHTML = '<option value="">Please select...</option><option value="IQ8PLUS-72-2-US">IQ8PLUS-72-2-US</option>';
      }, 600);
    });
  </script>
</body></html>`;

const server = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const steps: RecipeStep[] = [
  { action: "goto", phase: "open", value: url, note: "entry url" },
  // Label lookup — the dominant selector kind in the live PGE recipe (30 of 60 steps).
  // `accountNumber` is SENSITIVE: recorded with no literal, resolved from the store.
  { action: "fill", phase: "fill", selector: { label: "Utility Account Number" }, field: "accountNumber", sensitive: true, note: "utility account number" },
  // Placeholder lookup (12 of 60).
  { action: "fill", phase: "fill", selector: { placeholder: "(###) ###-####" }, field: "homeownerPhone", value: "000-000-0000", note: "homeowner phone" },
  // Cascade: the model list does not exist until the manufacturer change settles.
  { action: "select", phase: "fill", selector: { label: "Manufacturer" }, field: "inverterMake", value: "Enphase", note: "inverter manufacturer" },
  { action: "select", phase: "fill", selector: { label: "Model" }, field: "inverterModel", value: "IQ8PLUS-72-2-US", note: "inverter model" },
  // A DATE the portal requires but the project does not carry. The learn-time planner
  // computes one; frozen as a literal it ages into a PAST date and gets filed (or
  // rejected) on every later replay. It must arrive as a binding, recomputed here and now.
  { action: "fill", phase: "fill", selector: { label: "Estimated Commissioning Date" }, field: "estimatedCommissioningDate", note: "Estimated Commissioning Date" },
  { action: "click", phase: "fill", selector: { role: "link", name: "Next", exact: true, fallbacks: [{ css: "#next" }] }, note: "advance" },
];

const recipe = {
  id: "u1", scopeType: "utility", profileKey: "or||pge", state: "OR", ahj: "", utility: "PGE",
  portalPlatform: "powerclerk", portalUrl: url, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe;

// THIS project's values — every recorded literal is deliberately different.
// The date is resolved fresh at replay (portalRecipes.dateFields()), exactly as the real
// staging path supplies it — six weeks out, so it is always future-dated.
const commissioningDate = (() => {
  const d = new Date(Date.now() + 42 * 86400000);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
})();

const fieldValues = {
  estimatedCommissioningDate: commissioningDate,
  accountNumber: "8000123456",
  homeownerPhone: "541-808-5853",
  inverterMake: "Enphase",
  inverterModel: "IQ8PLUS-72-2-US",
};

const browser = await chromium.launch();
const page = await browser.newPage();
const adapter = new RecipeAdapter(recipe, fieldValues, {}, { autoSubmit: false });
(adapter as unknown as { page: unknown }).page = page;

const t0 = Date.now();
const result = await adapter.fillApplication({} as never);
const elapsedMs = Date.now() - t0;

const value = async (sel: string): Promise<string> => page.locator(sel).inputValue().catch(() => "");
const acct = await value("#acct");
const phone = await value("#phone");
const model = await value("#model");
const commdate = await value("#commdate");
const saved = (await page.locator("#saved").textContent().catch(() => "")) ?? "";
const done = (await page.locator("#done").textContent().catch(() => "")) ?? "";

check("replay completes against a PowerClerk-shaped page", () => {
  assert.equal(result.ok, true, `replay failed: ${result.message ?? ""}`);
});
check("label selector fills the VISIBLE control, not the hidden twin", () => {
  assert.equal(acct, "8000123456", `account: got ${JSON.stringify(acct)}`);
});
check("a sensitive field resolves from the store (never a recorded literal)", () => {
  const acctStep = steps.find((s) => s.field === "accountNumber");
  assert.equal(acctStep?.value, undefined, "an account number must never be frozen into a recipe");
  assert.equal(acct, fieldValues.accountNumber, "and must still arrive on the page at replay");
});
check("placeholder selector replays THIS project's phone", () => {
  assert.equal(phone, "541-808-5853", `phone: got ${JSON.stringify(phone)}`);
});
check("per-field autosave was committed by a blur after the fill", () => {
  assert.ok(saved.startsWith("saved:"), `autosave never fired — the value would be lost: ${JSON.stringify(saved)}`);
});
check("a cascading model select waits for its options to load", () => {
  assert.equal(model, "IQ8PLUS-72-2-US", `model: got ${JSON.stringify(model)} (options load ~600ms after the make changes)`);
});
check("a required date replays as a FUTURE date, never the learn-time literal", () => {
  assert.equal(commdate, commissioningDate, `commissioning date: got ${JSON.stringify(commdate)}`);
  const [mm, dd, yyyy] = commdate.split("/").map(Number);
  assert.ok(new Date(yyyy, mm - 1, dd).getTime() > Date.now(), `${commdate} is not in the future — a portal that validates this rejects the application`);
});
check("the recorded advance ran", () => {
  assert.equal(done, "ADVANCED", `expected the advance to fire, got ${JSON.stringify(done)}`);
});
check(`replay is not paying a dead readiness budget (took ${(elapsedMs / 1000).toFixed(1)}s)`, () => {
  assert.ok(elapsedMs < 20000, `replay took ${elapsedMs}ms — a wait is timing out`);
});

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} PowerClerk replay smoke test(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll PowerClerk replay smoke tests passed (real Chromium, ${(elapsedMs / 1000).toFixed(1)}s replay).`);
process.exit(0);
