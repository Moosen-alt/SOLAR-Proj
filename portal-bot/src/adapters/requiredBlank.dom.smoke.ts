// A REQUIRED BOX THE RECIPE CANNOT FILL MUST BE NAMED, NOT LEFT SILENT.
//
// PacifiCorp's interconnection application asks you to "Upload a photo of meter where
// system will be interconnected". A meter photo is taken at the house — it is never in a
// plan set — so:
//   - no recipe step exists for it (the learn saw the control empty and moved on),
//   - no QC rule looks for it (QC checks FIELDS, never documents),
//   - and replay reported nothing.
// The application reached the human reviewer with a required upload blank and no mention
// of it anywhere in the run output. The operator spotted it on the live portal, which is
// precisely the check the software was supposed to be doing.
//
// The learner has always reported requiredFieldMisses/missingRequiredDocs. Replay had no
// equivalent — the same "the learner is smarter than the replayer" gap that produced the
// modal, fingerprint and validation-scrape bugs before it. This is the general net: sweep
// before each ADVANCING click and name every visible required control still empty.
//
// Run: npx tsx portal-bot/src/adapters/requiredBlank.dom.smoke.ts
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

// One page the recipe CAN fill, one required upload it cannot, one optional box it also
// cannot (which must NOT be reported — a warning list that cries wolf gets ignored).
const PAGE = `<!doctype html><html><body>
  <h2 id="heading">Interconnection</h2>
  <div id="page1">
    <label for="acct">Account Number *</label><input id="acct" required>
    <label for="meter">Upload a photo of meter where system will be interconnected *</label>
    <input id="meter" type="file" required>
    <label for="notes">Additional notes</label><input id="notes">
    <!-- PacifiCorp's shape: no required attribute, no asterisk — just a red complaint
         rendered beside the control. A blank REQUIRED inverter manufacturer marked this
         way went unreported on a run that ended ok:true. -->
    <div class="form-group">
      <label for="mfr">Inverter Manufacturer</label>
      <select id="mfr"><option value="">Please select...</option><option>Altenergy Power System</option></select>
      <span class="err">This field is required.</span>
    </div>
    <button id="next" type="button">Next</button>
  </div>
  <div id="page2" style="display:none"><h3>Review</h3></div>
  <script>
    document.getElementById('next').addEventListener('click', function () {
      // This portal ALLOWS the advance — the point is that we notice the blank ourselves,
      // not that the portal stops us. Plenty of portals accept an incomplete page and
      // reject the application days later.
      document.getElementById('page1').style.display = 'none';
      document.getElementById('page2').style.display = 'block';
      document.getElementById('heading').textContent = 'Review';
    });
  </script>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const recipe = {
  id: "rb1", scopeType: "utility", profileKey: "or||pacific power", state: "OR", ahj: "", utility: "Pacific Power",
  portalPlatform: "powerclerk", portalUrl: url, status: "complete", version: 1,
  steps: [
    { action: "fill", phase: "fill", selector: { css: "#acct" }, field: "accountNumber", note: "Account Number" },
    { action: "click", phase: "fill", selector: { css: "#next" }, note: "advance: Next" },
  ] as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

const p1 = await context.newPage();
await p1.goto(url);
const a1 = new RecipeAdapter(recipe, { accountNumber: "TEST-12345678" }, {}, { autoSubmit: false });
(a1 as unknown as { page: unknown }).page = p1;
const r1 = await a1.fillApplication({} as never);
const blanks = ((r1 as unknown as { data?: { requiredStillEmpty?: string[] } }).data?.requiredStillEmpty ?? []);

check("the run still completes", () => {
  assert.equal(r1.ok, true, `${String(r1.message ?? "").slice(0, 200)}`);
});
check("the unfillable REQUIRED upload is named", () => {
  assert.ok(
    blanks.some((b) => /photo of meter/i.test(b)),
    `the meter photo was left blank and never reported; got ${JSON.stringify(blanks)}`,
  );
});
check("a field the recipe DID fill is not reported", () => {
  assert.ok(!blanks.some((b) => /account number/i.test(b)), `false alarm on a filled field: ${JSON.stringify(blanks)}`);
});
check("a control marked required by a VALIDATION MESSAGE is reported", () => {
  assert.ok(
    blanks.some((b) => /inverter manufacturer/i.test(b)),
    `a blank required dropdown marked only by "This field is required." was missed; got ${JSON.stringify(blanks)}`,
  );
});
check("an OPTIONAL empty box is not reported", () => {
  // A list that includes everything empty is a list nobody reads.
  assert.ok(!blanks.some((b) => /additional notes/i.test(b)), `optional field reported: ${JSON.stringify(blanks)}`);
});

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} required-blank smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll required-blank smoke tests passed (real Chromium).");
process.exit(0);
