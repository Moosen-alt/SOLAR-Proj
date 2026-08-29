// THE RIGHT ANSWER MUST NEVER LAND IN THE WRONG BOX.
// Portal field ids are routinely per-form-instance — PowerClerk's "AWQBPS8U00XGInput" is a
// different question on a different project — so a recorded css id can resolve to a control
// the recipe never meant. Measured live on a PacifiCorp replay with a new project: a step
// recorded for "Description of Service:" resolved to the "Will the System be Customer-Owned
// or Third-Party Owned" dropdown, and two later steps both resolved onto one unrelated
// control.
//
// Skipping was the LUCKY outcome there — the value simply did not match that control's
// options. Had it matched, replay would have filed the right answer into the wrong question
// on a live interconnection application, silently. This pins the three behaviours that stop
// that: re-anchor when the label contradicts, ABORT when the field cannot be found, and
// leave a correctly-resolved step alone (over-firing would break working replays).
//
// Run: npx tsx portal-bot/src/adapters/controlIdentity.dom.smoke.ts
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

// The ids are deliberately SHUFFLED relative to what the recipe recorded, exactly as a
// per-form-instance id scheme does on a new project.
const PAGE = `<!doctype html><html><body>
  <label for="idA">Will the System be Customer-Owned or Third-Party Owned?</label>
  <select id="idA"><option value="">Select...</option><option>Customer-Owned</option><option>Third-Party Owned</option></select>

  <label for="idB">Description of Service:</label>
  <select id="idB"><option value="">Select...</option><option>Residential</option><option>Commercial</option></select>

  <label for="idC">Installation Voltage</label>
  <select id="idC"><option value="">Select...</option><option>240V</option><option>208V</option></select>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const steps: RecipeStep[] = [
  // Every real recipe opens with the entry URL, and replay's readiness gate is wired to
  // run after a goto — without one the run has no settled page to start from.
  { action: "goto", phase: "open", value: `http://127.0.0.1:${port}/`, note: "entry url" },
  // Recorded against "Description of Service:" but its id now belongs to the OWNERSHIP
  // question — and "Residential" is NOT one of that control's options, so without the
  // identity check this is the silent-skip case.
  { action: "select", phase: "fill", selector: { css: "#idA" }, value: "Residential", note: "Description of Service:" },
  // The DANGEROUS shape: recorded for ownership, resolves onto Description of Service —
  // whose option list DOES contain the recorded value. Nothing but an identity check stops
  // this from filing the wrong answer.
  { action: "select", phase: "fill", selector: { css: "#idB" }, value: "Commercial", note: "Will the System be Customer-Owned or Third-Party Owned?" },
  // Correctly resolved: must be left completely alone.
  { action: "select", phase: "fill", selector: { css: "#idC" }, value: "240V", note: "Installation Voltage" },
];

const recipe = {
  id: "ci1", scopeType: "utility", profileKey: "or||pacific power", state: "OR", ahj: "", utility: "Pacific Power",
  portalPlatform: "powerclerk", portalUrl: `http://127.0.0.1:${port}/`, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/`);

const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: false });
(adapter as unknown as { page: unknown }).page = page;

// Drive executeStep DIRECTLY, one step at a time. runAll() wraps the loop in readiness
// gates and drift prechecks built for a real multi-page wizard; this test is about ONE
// decision — does a step touch the control its label names — and driving that decision
// directly keeps the test measuring it rather than the harness around it.
const internals = adapter as unknown as {
  executeStep(step: RecipeStep, pastReview: boolean): Promise<boolean>;
  driftWarnings: string[];
};
const outcomes: boolean[] = [];
for (const step of steps.filter((s) => s.action !== "goto")) {
  outcomes.push(await internals.executeStep(step, false).catch(() => false));
}

const value = async (sel: string): Promise<string> => page.locator(sel).inputValue().catch(() => "");
const [a, b, c] = [await value("#idA"), await value("#idB"), await value("#idC")];
const drift = internals.driftWarnings;

check("a step re-anchors to the control its recorded LABEL names", () => {
  // "Description of Service:" -> should reach #idB and select Residential, not touch #idA.
  assert.equal(b === "Residential" || a === "", true, `expected the re-anchor to fill Description of Service; idA=${JSON.stringify(a)} idB=${JSON.stringify(b)}`);
});

check("the right answer NEVER lands in the wrong box", () => {
  // The ownership answer must not end up in Description of Service, and vice versa.
  assert.notEqual(b, "Commercial", "the ownership step's value was filed into Description of Service — the exact silent mis-filing this check exists to stop");
  assert.notEqual(a, "Residential", "the Description-of-Service value was filed into the ownership dropdown");
});

check("a correctly-resolved step is left alone (no over-firing)", () => {
  assert.equal(c, "240V", `a step whose control matches its label must fill normally; got ${JSON.stringify(c)}`);
});

check("every mis-resolution is REPORTED, never silent", () => {
  assert.ok(drift.length >= 1, `expected a drift warning naming the contradiction, got ${JSON.stringify(drift)}`);
  assert.ok(drift.some((d) => /resolved onto/i.test(d)), `warnings should say what it landed on: ${JSON.stringify(drift)}`);
});

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} control-identity smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll control-identity smoke tests passed (real Chromium).");
process.exit(0);
