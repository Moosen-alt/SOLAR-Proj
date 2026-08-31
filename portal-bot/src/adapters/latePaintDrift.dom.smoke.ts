// AN UNPAINTED PAGE IS NOT PAGE DRIFT.
//
// The drift precheck protects against a real hazard: when a replay desyncs from the wizard,
// every later step resolves onto whatever control happens to sit at the recorded id, and
// that is how a desync becomes WRONG DATA on a live application. So it stops the run.
//
// But it read the DOM exactly once, which made "the form has not rendered yet" look
// identical to "we are on the wrong page". Measured live on Ameren Illinois (PowerClerk):
// clicking into the application navigates to the form URL and the page reports ZERO visible
// inputs for several seconds afterwards. The replay declared drift at "0 of 17 recorded
// fields" and failed the whole run while the page it wanted was still on its way.
//
// This pins both halves: a late-painting page must be waited for, and a genuinely wrong
// page must still stop the run.
//   npx tsx portal-bot/src/adapters/latePaintDrift.dom.smoke.ts
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

// The form the recipe was recorded against — painted 3s AFTER the page loads, exactly like
// PowerClerk's application form.
const LATE_FORM = `<!doctype html><html><body>
  <h1>Interconnection Application</h1><div id="slot"></div>
  <script>
    setTimeout(function () {
      document.getElementById('slot').innerHTML =
        '<label for="lvl">Application Level</label><select id="lvl"><option value="">Select…</option><option>Level 1</option></select>' +
        '<label for="typ">Application Type</label><select id="typ"><option value="">Select…</option><option>New</option></select>' +
        '<label for="cust">Customer Type</label><select id="cust"><option value="">Select…</option><option>Residential</option></select>' +
        '<label for="acct">Account Number from Bill</label><input id="acct">';
    }, 3000);
  </script>
</body></html>`;

// A genuinely different page: it paints immediately and holds none of the recorded fields.
const WRONG_PAGE = `<!doctype html><html><body>
  <h1>Your Projects</h1>
  <label for="q">Search All Columns</label><input id="q">
  <a href="/x">Export to CSV</a>
</body></html>`;

const routes: Record<string, string> = { "/late": LATE_FORM, "/wrong": WRONG_PAGE };
const server = http.createServer((q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(routes[q.url || ""] ?? "<body>?</body>"); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const steps = (entry: string): RecipeStep[] => ([
  { action: "goto", phase: "open", value: `http://127.0.0.1:${port}${entry}`, note: "entry url" },
  { action: "select", phase: "fill", selector: { label: "Application Level" }, value: "Level 1", note: "Application Level" },
  { action: "select", phase: "fill", selector: { label: "Application Type" }, value: "New", note: "Application Type" },
  { action: "select", phase: "fill", selector: { label: "Customer Type" }, value: "Residential", note: "Customer Type" },
  { action: "fill", phase: "fill", selector: { label: "Account Number from Bill" }, value: "1234567890", note: "Account Number from Bill" },
  { action: "stopForReview", selector: {} },
]);

const mkRecipe = (entry: string): PortalRecipe => ({
  id: "late1", scopeType: "utility", profileKey: "il||ameren illinois", state: "IL", ahj: "", utility: "Ameren Illinois",
  portalPlatform: "powerclerk", portalUrl: `http://127.0.0.1:${port}${entry}`, status: "complete", version: 1,
  steps: steps(entry), createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

// 1) LATE PAINT: the fields arrive 3s late; the replay must wait rather than call it drift.
{
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/late`);
  const adapter = new RecipeAdapter(mkRecipe("/late"), {}, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = page;
  const drift = await (adapter as unknown as { precheckPageDrift: (i: number) => Promise<string | null> }).precheckPageDrift(1);
  check("a form that paints 3s late is NOT reported as drift", drift === null, `got: ${String(drift).slice(0, 120)}`);
  await page.close();
}

// 2) GENUINELY WRONG PAGE: none of the recorded fields will ever appear — must still stop.
{
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/wrong`);
  const adapter = new RecipeAdapter(mkRecipe("/wrong"), {}, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = page;
  const started = Date.now();
  const drift = await (adapter as unknown as { precheckPageDrift: (i: number) => Promise<string | null> }).precheckPageDrift(1);
  check("a genuinely wrong page still stops the run", typeof drift === "string" && /page drift/i.test(drift), `got: ${String(drift).slice(0, 120)}`);
  check("the wording staleness detection matches is preserved", typeof drift === "string" && /recipe step failed/i.test(drift), String(drift).slice(0, 80));
  console.log(`         (drift confirmed after ${((Date.now() - started) / 1000).toFixed(1)}s of waiting for the page to appear)`);
  await page.close();
}

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} late-paint-drift check(s) FAILED.`); process.exit(1); }
console.log("\nAll late-paint-drift checks passed (real Chromium).");
process.exit(0);
