// THE POLICY-DEFAULT ROUND TRIP, IN REAL CHROMIUM.
// applyPolicyDefaults answers the fixed Yes/No questions a standard residential NEM
// application always answers the same way, then verifyFillsLanded reads every fill back to
// confirm it stuck. Between them sat a semantic mismatch that no fake page could reveal:
// the policy pass targets the ONE radio input whose label equals the answer, but recorded
// the ANSWER as its expected value -- and fieldHoldsValue reads expected as a boolean
// checked-state. So "No" parsed as false, meaning "this control should be UNCHECKED", and
// a correctly-answered question reported itself as a required-field miss the instant it
// succeeded. requiredFieldMisses is a hard blocker in the trust gate, so the live PGE
// recipe could not be promoted through twelve learn runs. Only the "No" answers tripped
// it; the "Yes" ones passed, which is why it read as one stubborn question rather than a
// systematic fault.
//
// Run: npx tsx portal-bot/src/adapters/policyDefaults.dom.smoke.ts
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Two PowerClerk-shaped Yes/No policy groups: one whose policy answer is No, one Yes.
// Both must behave identically once answered -- that symmetry is the whole point.
const PAGE = `<!doctype html><html><body>
  <div class="form-group">
    <label>Do you propose to limit the export capacity?</label>
    <input type="radio" id="expYes" name="exp"><label for="expYes">Yes</label>
    <input type="radio" id="expNo" name="exp"><label for="expNo">No</label>
  </div>
  <div class="form-group">
    <label>Is your disconnect within 10 feet of the PGE utility meter?</label>
    <input type="radio" id="discYes" name="disc"><label for="discYes">Yes</label>
    <input type="radio" id="discNo" name="disc"><label for="discNo">No</label>
  </div>
</body></html>`;

const server = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const planner: LearnPlanner = (async () => ({ fills: [], atReview: false })) as unknown as LearnPlanner;
const adapter = new AutoLearnAdapter("PGE PowerClerk", planner, { policyProfile: "residential_nem" });

const browser = await chromium.launch();
const context = await browser.newContext();
// The SAME shim openPortal installs (browser.ts). applyPolicyDefaults walks the DOM inside
// page.evaluate, and esbuild's keepNames wraps the nested helpers as __name(fn, "..."),
// which does not exist in the page. Without the shim the evaluate throws, the pass's own
// catch swallows it, and it reports "no policy groups found" — a raw chromium.launch()
// would make this test pass or fail for a reason that has nothing to do with the product.
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/`);
(adapter as unknown as { page: unknown }).page = page;

type Applied = { label: string; expected: string; fieldType: string; required: boolean; selector: unknown };
const internals = adapter as unknown as {
  applyPolicyDefaults(labels: string[]): Promise<Array<{ step: { note?: string }; applied: Applied }>>;
  verifyFillsLanded(applied: Applied[]): Promise<string[]>;
};

const policySteps = await internals.applyPolicyDefaults([]);
const applied = policySteps.map((p) => p.applied);
const misses = await internals.verifyFillsLanded(applied);

const expChecked = await page.locator("#expNo").isChecked();
const discChecked = await page.locator("#discYes").isChecked();

check("the policy pass answers both questions on the live page", () => {
  assert.equal(policySteps.length, 2, `expected both policy groups answered, got ${policySteps.length}`);
  assert.equal(expChecked, true, "export-capacity answered No");
  assert.equal(discChecked, true, "disconnect answered Yes");
});

check("a correctly-answered 'No' question is NOT reported as a required-field miss", () => {
  assert.deepEqual(misses, [], `verifyFillsLanded reported ${JSON.stringify(misses)} for questions that ARE answered — this is a hard blocker in the trust gate, so the recipe can never be promoted`);
});

check("'No' and 'Yes' policy answers verify identically", () => {
  // The asymmetry is what disguised the bug as one stubborn question.
  const byAnswer = (want: string) => applied.find((a) => (policySteps.find((p) => p.applied === a)?.step.note ?? "").endsWith(want));
  const no = byAnswer("No");
  const yes = byAnswer("Yes");
  assert.ok(no && yes, "expected one policy step per answer");
  assert.equal(no!.expected, yes!.expected, `a 'No' answer records expected=${JSON.stringify(no!.expected)} but a 'Yes' answer records ${JSON.stringify(yes!.expected)} — the readback treats expected as a boolean, so these must not diverge`);
});

check("the recorded step still says which answer it gave", () => {
  const notes = policySteps.map((p) => String(p.step.note ?? ""));
  assert.ok(notes.some((n) => /limit the export capacity.*No$/i.test(n)), `lost the human-readable answer: ${JSON.stringify(notes)}`);
});

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} policy-default smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll policy-default smoke tests passed (real Chromium).");
process.exit(0);
